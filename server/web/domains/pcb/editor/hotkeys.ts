// hotkeys.ts — KiCad's default hotkeys for the web editor.
//
// The key handling used to be a list of fixed keys in index.ts (F fit, S select, H pan, C comment, G grid,
// N snap, +/- zoom) in front of whatever the tool modules bound themselves, which shadowed KiCad's own
// meanings (F = Edit Footprint / Flip, H = hierarchical label, C = unfold bus, G = drag, N = next grid,
// S = add sheet, +/- = next / previous layer on a board).  Here the table is KiCad's: every TOOL_ACTION's
// default hotkey (web/domains/pcb/menuspec.ts, generated from the action tables) resolves to whatever implements that
// action in the web — a chrome handler (editor/actions.ts HANDLERS), a tool-module action
// (CollabTools.<sch|pcb>.actions, by KiCad's id or its alias in tables.ts) or a tool (TOOL_MAP).
//
// Two entry points:
//   preemptKey(ev)     window capture phase, before the modules' own capture handlers: only the combinations
//                      where a module binds a key KiCad uses for something else (tables.ts KICAD_KEY_WINS);
//   runSpecHotkey(ev)  from index.ts's keydown handler after the module had its turn: the generic table.
// Nothing fires while the user types in a field, a dialog or an open menu (typingTarget).
import { hotkeyKey, numpadKey, shiftedPunctCombo } from "../../../shared/keys";
import { hotkeyOwners, userTouchedKey, type EditorKind } from "../menuspec";
import { EDITOR_ONLY, FPEDIT_BLOCKED, FPEDIT_ONLY, KICAD_KEY_WINS, MODULE_ALIAS, toolFor } from "../tables";
import { HANDLERS } from "./actions";
import { state, store } from "./appstore";
import { E } from "./state";
import { activeModule, moduleTool, runModuleAction, setTool, toolCtx } from "./tools";
import { cursorClick } from "./crosshair";
import { isSch } from "./view";

type Handler = import("./types").ActionHandler;
interface ToolModule { actions?: Record<string, unknown>; onKey?: (key: string, ev: unknown, ctx: unknown) => unknown; hotkeyTool?: (id: string, ctx: unknown) => unknown }

const NAMED: Record<string, string> = { Delete: "Del", Escape: "Esc", " ": "Space", Insert: "Ins", PageUp: "PgUp", PageDown: "PgDn", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

/**
 * The event as a hotkey in the spec's notation: "Ctrl+Shift+Z", "F1", "Shift+Space", "'" (Cmd counts as Ctrl).  A
 * number pad key is the character it types, or with `numpad` its own key ("Num Pad 5", WXK_NUMPAD5): the hotkey
 * table looks that up first, and wx's wxEVT_CHAR brings the character when no hotkey takes it (runSpecHotkey).
 */
export function comboOf(ev: KeyboardEvent, numpad = false): string {
  // Alt composes other characters on some layouts (Alt+3 → "#" / "£", Option+/ → "÷", Option+` a dead key):
  // the physical key (keys.ts hotkeyKey)
  const pad = numpad ? numpadKey(ev) : null;
  if (pad) { const mods: string[] = []; if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl"); if (ev.shiftKey) mods.push("Shift"); if (ev.altKey) mods.push("Alt"); return [...mods, pad].join("+"); }
  let k = hotkeyKey(ev);
  if (!k || k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return "";
  k = NAMED[k] || k;
  const letter = k.length === 1 && /[a-z]/i.test(k);
  if (letter) k = k.toUpperCase();
  const printable = k.length === 1 && !letter && !/[0-9]/.test(k);   // "+", "~", "{": Shift is part of typing the character
  const mods: string[] = [];
  if (ev.ctrlKey || ev.metaKey) mods.push("Ctrl");
  if (ev.shiftKey && !printable) mods.push("Shift");
  if (ev.altKey) mods.push("Alt");
  return [...mods, k].join("+");
}

const NON_TEXT_INPUT = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color"]);

/** True while keys belong to something else: a text field, a KiCad dialog, an open menu or a modal. */
export function typingTarget(ev: KeyboardEvent): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.symedit === "open") return true;   // the Symbol Editor frame owns the keyboard
  const t = ev.target as HTMLElement | null;
  if (t && t.tagName) {
    // a ticked checkbox / radio / button (Selection Filter, panel toggles) keeps only Space and Enter for itself
    if (t.tagName === "INPUT" && NON_TEXT_INPUT.has((t as HTMLInputElement).type)) { if (ev.key === " " || ev.key === "Enter") return true; }
    else if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT" || t.isContentEditable) return true;
    if (typeof t.closest === "function" && t.closest(".kd-overlay, [role='dialog'], [role='menu'], #popover")) return true;
    // a selected row of the Properties grid keeps Ctrl+C (copy its value) and F2 (rename) for itself
    if (typeof t.closest === "function" && t.closest("[data-prop-label]") && (ev.key === "F2" || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c"))) return true;
  }
  const w = window as unknown as { KDialogs?: { isOpen?: () => boolean } };
  if (w.KDialogs && w.KDialogs.isOpen && w.KDialogs.isOpen()) return true;
  return document.body.dataset.menuOpen === "1";
}

const editorKind = (): EditorKind => (isSch() ? "sch" : "pcb");
/** The Footprint Editor runs on the board editor's tables: its own actions only there, the board's routing and zones never. */
const fpEditAllows = (id: string): boolean => (E.DOC_TYPE === "footprint" ? !FPEDIT_BLOCKED.has(id) : !FPEDIT_ONLY.has(id));

/**
 * The actions whose hotkey condition is the frames' hasElements / HasItems (sch_edit_frame.cpp 963-986,
 * pcb_edit_frame.cpp 1261-1289): the key does nothing on an empty document unless a tool is mid-edit.
 */
const HOTKEY_HAS_ELEMENTS = new Set(["cut", "copy", "copyAsText", "doDelete", "duplicate", "selectAll", "unselectAll", "rotateCW", "rotateCCW", "rotateCw", "rotateCcw", "mirrorH", "mirrorV", "mirrorInteractive"]);
/**
 * ACTION_MANAGER::RunHotKey: `runAction = aCond->GetHotkeyCondition()( sel )`; a hotkey whose action is disabled runs
 * nothing and says nothing.
 */
export function hotkeyConditionHolds(id: string, hasElements: boolean): boolean {
  return !HOTKEY_HAS_ELEMENTS.has(id) || hasElements;
}
function docHasElements(): boolean {
  const d = E.kdoc as { items?: Map<string, unknown> } | null;
  return !!(d && d.items && d.items.size > 0) || !!(E.hooks && E.hooks.busy && E.hooks.busy());
}

/** Run the web's implementation of one KiCad action; false when there is none (or the module declined it). */
export function runKicadAction(id: string, viaHotkey = false): boolean {
  if (!fpEditAllows(id)) return false;
  if (viaHotkey && !hotkeyConditionHolds(id, docHasElements())) return false;
  const ed = editorKind(); const mod = activeModule() as ToolModule | null;
  const alias = MODULE_ALIAS[ed][id];
  if (alias && mod && mod.actions && mod.actions[alias]) return runModuleAction(alias) !== false;
  const h = (HANDLERS as Record<string, Handler>)[id];
  if (h && (!EDITOR_ONLY[id] || EDITOR_ONLY[id] === ed)) { h(null); return true; }
  if (mod && mod.actions && mod.actions[id]) return runModuleAction(id) !== false;
  const tid = toolFor(ed, id);
  if (tid && ((store.get().tool.appTools as string[]).includes(tid) || moduleTool(tid))) {
    if (E.viewOnly && moduleTool(tid) && tid !== "highlight") return false;
    // a hotkey event carries the cursor position: the module starts the tool primed there (TOOL_MANAGER::PrimeTool)
    if (viaHotkey && mod && mod.hotkeyTool && moduleTool(tid)) { try { mod.hotkeyTool(tid, toolCtx()); } catch (e) { console.warn(e); } return true; }
    const wasCurrent = E.tool === tid;
    setTool(tid);
    if (viaHotkey && E.tool === tid && primesOnHotkey(ed, tid, E.immediateActions !== false, wasCurrent)) cursorClick(1);
    return true;
  }
  return false;
}

/**
 * The board tools whose entry point primes the tool from the hotkey's position (`if( aEvent.HasPosition() )
 * m_toolMgr->PrimeTool( aEvent.Position() )`): DRAWING_TOOL's DrawLine, DrawRectangle (and text boxes), DrawCircle,
 * DrawArc, DrawBezier, PlaceText, DrawTable, DrawBarcode, PlaceReferenceImage, DrawDimension, DrawZone (zones,
 * polygons, rule areas) and ROUTER_TOOL::MainLoop.
 */
const BOARD_PRIMED = new Set(["route", "routediff", "gline", "grect", "gcircle", "garc", "gcurve", "gtext", "gtextbox", "table", "barcode", "image",
  "dimaligned", "dimortho", "dimcenter", "dimradial", "leader", "zone", "thievingzone", "gpoly", "rulearea"]);
/**
 * TOOL_MANAGER::processEvent (tool_manager.cpp 1243-1250): with input.immediate_actions off ("First hotkey selects
 * tool") a hotkey that activates another tool loses its position, so the tool only arms; a tool that is already
 * current keeps it.  True when the board tool `tid` takes a click at the cursor now.
 */
export function primesOnHotkey(ed: EditorKind, tid: string, immediate: boolean, wasCurrent: boolean): boolean {
  return ed === "pcb" && BOARD_PRIMED.has(tid) && (immediate || wasCurrent);
}

/** Whether a KiCad action has an implementation here (the hotkey list marks the rest as desktop-only). */
export function kicadActionAvailable(id: string): boolean {
  if (!fpEditAllows(id)) return false;
  const ed = editorKind(); const mod = activeModule() as ToolModule | null;
  const alias = MODULE_ALIAS[ed][id];
  if ((HANDLERS as Record<string, Handler>)[id] && (!EDITOR_ONLY[id] || EDITOR_ONLY[id] === ed)) return true;
  if (mod && mod.actions && (mod.actions[id] || (alias && mod.actions[alias]))) return true;
  const tid = toolFor(ed, id);
  return !!tid && ((store.get().tool.appTools as string[]).includes(tid) || !!moduleTool(tid));
}

/**
 * The actions bound to a key in the order RunHotKey tries them: End is both ACTIONS::finishInteractive and
 * ACTIONS::cursorDblClick (actions.cpp 262-270, 963-972), both AS_GLOBAL; the tool that is drawing takes End itself
 * (the modules' onKey, before this table), and otherwise COMMON_TOOLS::CursorControl answers with a double click at
 * the cursor.
 */
export function orderedOwners(owners: string[]): string[] {
  const i = owners.indexOf("finishInteractive"), j = owners.indexOf("cursorDblClick");
  if (i < 0 || j < 0 || j < i) return owners;
  const out = owners.slice(); out.splice(j, 1); out.splice(i, 0, "cursorDblClick"); return out;
}
/**
 * ACTION_MANAGER::RunHotKey's fallback (action_manager.cpp 155-157): a key with Shift that no action binds is tried
 * again without Shift, unless the key is a letter (Shift+Enter is a click with Shift, Shift+Del a delete).  The combo
 * to try next, or null.
 */
export function unshiftedCombo(combo: string, bound: (c: string) => boolean): string | null {
  if (!combo.includes("Shift+") || bound(combo)) return null;
  const parts = combo.split("+"); const key = parts[parts.length - 1] === "" ? "+" : parts[parts.length - 1];
  if (/^[A-Z]$/i.test(key)) return null;
  return combo.replace("Shift+", "");
}
/** Whether the table binds this key with its Shift (the module hotkeys' unshifted fallback asks first). */
export function shiftComboBound(ev: KeyboardEvent): boolean {
  const combo = comboOf(ev); if (!combo) return false;
  const alt = shiftedPunctCombo(ev);
  return hotkeyOwners(editorKind(), combo).length > 0 || (!!alt && hotkeyOwners(editorKind(), alt).length > 0);
}
/** The generic table: the first action KiCad binds to this key that the web implements. */
export function runSpecHotkey(ev: KeyboardEvent): boolean {
  if (!E.kdoc) return false;
  // a number pad key: its own name first; when no action takes it wxEVT_CHAR_HOOK is skipped and wxEVT_CHAR
  // brings the character it types
  const pad = numpadKey(ev) ? comboOf(ev, true) : "";
  if (pad) for (const id of hotkeyOwners(editorKind(), pad)) if (runKicadAction(id, true)) return true;
  const combo = comboOf(ev); if (!combo) return false;
  const ed = editorKind();
  for (const id of orderedOwners(hotkeyOwners(ed, combo))) if (runKicadAction(id, true)) return true;
  const alt = shiftedPunctCombo(ev);
  if (alt) for (const id of orderedOwners(hotkeyOwners(ed, alt))) if (runKicadAction(id, true)) return true;
  const plain = unshiftedCombo(combo, (c) => hotkeyOwners(ed, c).length > 0 || (!!alt && hotkeyOwners(ed, alt).length > 0));
  if (plain) for (const id of orderedOwners(hotkeyOwners(ed, plain))) if (runKicadAction(id, true)) return true;
  return false;
}

/** Capture-phase hook: KiCad's meaning for the keys the modules would otherwise take (tables.ts KICAD_KEY_WINS). */
/** Capture hooks ahead of the table below (the table cell selection, editor/tablecells.ts): true takes the key. */
export const keyHooks: ((ev: KeyboardEvent) => boolean)[] = [];
export function preemptKey(ev: KeyboardEvent): void {
  if ((state as { view?: string }).view !== "editor" || !E.kdoc || typingTarget(ev)) return;
  for (const hook of keyHooks) { let took = false; try { took = hook(ev); } catch (e) { console.warn(e); } if (took) { ev.stopImmediatePropagation(); return; } }
  // a number pad key that a hotkey names goes to the table (runSpecHotkey); otherwise it is the character it types
  const pad = numpadKey(ev) ? comboOf(ev, true) : "";
  if (pad && (userTouchedKey(pad) || hotkeyOwners(editorKind(), pad).length)) { runSpecHotkey(ev); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
  const combo = comboOf(ev); if (!combo) return;
  if (E.tool === "measure" && combo === "Ctrl+C") return;   // the measure tool takes ACTIONS::copy itself (index.ts)
  // a key the user moved in Preferences > Hotkeys: the table decides it before any tool's own binding and before
  // KICAD_KEY_WINS (whose entries are the default keys), and a key taken off its action does nothing
  if (userTouchedKey(combo)) { runSpecHotkey(ev); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
  const what = KICAD_KEY_WINS[editorKind()][combo];
  if (!what) return;
  if (what === "spec") runSpecHotkey(ev);
  else if (what.startsWith("key:")) {
    const mod = activeModule() as ToolModule | null; const k = what.slice(4), shift = k.startsWith("Shift+");
    if (mod && mod.onKey) { try { mod.onKey(shift ? k.slice(6) : k, { shiftKey: shift, preventDefault() {} }, toolCtx(undefined)); } catch (e) { console.warn(e); } }
  }
  ev.preventDefault(); ev.stopImmediatePropagation();
}

if (typeof window !== "undefined") window.addEventListener("keydown", preemptKey, true);
