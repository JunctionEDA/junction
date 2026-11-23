// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/domains/pcb/editor/index.ts — edit these modules, not the bundle).
import { hotkeyKey } from "../../../shared/keys";
import { setGroupCurrent, setStatusBar, state, store } from "./appstore";
import { refreshCrosshair } from "./crosshair";
import { refreshCursor } from "./cursors";
import { applyChanges, enterSheet, publishDocs, renderObjects, setLayerVisible, snapMm } from "./doc";
import { selectionIds, toolChanging } from "./gestures";
import { sendOp } from "./net";
import { cycleFollow, sendPresence } from "./peers";
import { applyBoardArea, boardAreaIds, clearSelection, drawSelection, filterAllows, groupExpand, renderProps, scopeToEnteredGroup, selFilter } from "./selection";
import { E } from "./state";
import { subSheetDocs } from "./subsheets";
import { api, toast } from "./util";
import { appearanceDispatch } from "./panels/appearance";
import { openDatasheet } from "../dialogs/browse-cells";
import { clonePrefs, savePrefs } from "../dialogs/prefs";
import type { CommitOpts, ItemSummary, UndoEntry } from "./types";
import { dragG, isSch, pxPerMm, requestRender, requestRepaint, stage, worldMm } from "./view";
   // ERC/DRC markers handed over by the tool modules; the project's .kicad_pro text (design rules)
// KiCad's clipboard is s-expression text: the modules write it here and to the system clipboard when allowed.
// read() takes whatever text the system clipboard holds (plain text is pasted as a text item); the buffer answers only when it is empty or denied ("" when it holds a picture and no text).
// The buffer is also kept in this browser's storage, so Copy in the schematic's tab can be pasted in the board's tab
// (and read by a plugin there) without the browser's clipboard permission.
const CLIP_KEY = "kui.clipboard";
const clipStored = () => { try { return localStorage.getItem(CLIP_KEY) || ""; } catch (e) { return ""; } };
/**
 * SCH_EDITOR_CONTROL::doCopy's other clipboard formats: a PNG of the selection (300 ppi, at most 4096 px, transparent,
 * the selection box inflated by 2 %), an HTML fragment embedding that PNG and the SVG, so a copy can be pasted into a
 * document or an image editor.  The text is already on the clipboard; this replaces it with the full set when the
 * browser lets a page write images (and leaves the text alone when it does not).
 */
async function writeRichClipboard(text: string, ids: string[]): Promise<void> {
  const doc = E.kdoc as KDoc | null, CI = (window as unknown as { ClipboardItem?: { new(items: Record<string, Blob>): ClipboardItem; supports?(type: string): boolean } }).ClipboardItem;
  if (!doc || !isSch() || !CI || !navigator.clipboard || !navigator.clipboard.write) return;
  let b: number[] | null = null;
  for (const id of ids) { const it = doc.items.get(id), r = it && it.bbox; if (r) b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : [r[0], r[1], r[2], r[3]]; }
  if (!b || !(b[2] > b[0]) || !(b[3] > b[1])) return;
  const ix = (b[2] - b[0]) * 0.02, iy = (b[3] - b[1]) * 0.02, box = [b[0] - ix, b[1] - iy, b[2] + ix, b[3] + iy];
  const opts = Object.assign({}, E.renderOpts, { ids: new Set(ids), bbox: box, margin: 0, background: false, frame: false, hidden: E.hiddenLayers });
  const dpi = Math.min(300, 4096 * 25.4 / Math.max(box[2] - box[0], box[3] - box[1]));
  const png = await KiCadCanvas.renderPng(doc, Object.assign({}, opts, { dpi }));
  const bytes = new Uint8Array(await png.arrayBuffer()); let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const types: Record<string, Blob> = { "text/plain": new Blob([text], { type: "text/plain" }), "image/png": png, "text/html": new Blob([`<img src="data:image/png;base64,${btoa(bin)}" />`], { type: "text/html" }) };
  if (CI.supports && CI.supports("image/svg+xml")) { try { types["image/svg+xml"] = new Blob([KiCadCanvas.renderSvg(doc, opts)], { type: "image/svg+xml" }); } catch (e) { /* the picture goes without its SVG */ } }
  if (appClipboard.text !== text) return;                                 // something else was copied meanwhile
  await navigator.clipboard.write([new CI(types)]);
}
/** No text on the system clipboard but a picture: Paste places it as an image (SCH_EDITOR_CONTROL::Paste, GetImageFromClipboard). */
async function clipboardHasImage(): Promise<boolean> {
  try { if (!navigator.clipboard.read) return false; const list = await navigator.clipboard.read(); return list.some((i) => i.types.some((t) => t === "image/png" || t === "image/jpeg")); } catch (e) { return false; }
}
export const appClipboard = { text: "", get() { return appClipboard.text || clipStored(); },
  set(t: unknown, ids?: string[]) { appClipboard.text = String(t || ""); try { if (appClipboard.text.length <= 2_000_000) localStorage.setItem(CLIP_KEY, appClipboard.text); else localStorage.removeItem(CLIP_KEY); } catch (e) { /* storage full or blocked: this tab still has it */ } if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(appClipboard.text).catch(() => {}); if (ids && ids.length) writeRichClipboard(appClipboard.text, ids).catch(() => {}); },
  async read() { try { if (navigator.clipboard && navigator.clipboard.readText) { const t = await navigator.clipboard.readText(); if (t) return t; if (await clipboardHasImage()) return ""; } } catch (e) { /* permission denied: use the buffer */ } return appClipboard.get(); } };
if (typeof window !== "undefined") window.addEventListener("storage", (ev) => { if (ev.key === CLIP_KEY) appClipboard.text = ev.newValue || ""; });

export const undoStack: UndoEntry[] = [], redoStack: UndoEntry[] = [];

export function activeModule(): SchToolModule | PcbToolModule | null | undefined { if (!E.kdoc) return null; return isSch() ? CollabTools.sch : CollabTools.pcb; }

export function toolCtx(extra?: Record<string, unknown>) {
  return Object.assign({
    K: KiCadCanvas, doc: E.kdoc, IU: E.IU, isSch: isSch(), fpEditor: !!(E.kdoc && E.kdoc.fpEditor), zoom: E.zoom, pxPerMm: pxPerMm(), gridPitch: E.gridPitch, snapOn: E.snapOn, snap: snapMm, tool: E.tool, selFilter: selFilter(), activeLayer: E.activeLayer,
    selected: E.selected, items: E.items, sheets: E.sheets, viewOnly: E.viewOnly, live: !!(E.ws && E.ws.readyState === 1), stage, worldMm, selection: E.selection, docs: state.docs!, project: state.project, api, docId: state.docId,
    setHighlight(ids: Set<string> | null, nets?: Iterable<string>) {
      E.highlightIds = ids?.size ? new Set(ids) : null;
      E.sharedNetHighlight = E.highlightIds && nets ? { ids: E.highlightIds, nets: [...nets] } : null;
      requestRender(); sendPresence(null);
    },
    cursor: E.lastCursorMm, clipboard: appClipboard, designSettings: E.proSettings, customRules: E.druText,
    // Hide / Show Net in Ratsnest: the Appearance panel's net list shows the same visibility (OnNetVisibilityChanged)
    setNetsVisible(names: string[], visible: boolean) { for (const name of names) appearanceDispatch({ t: "netVisible", name, on: visible }); },
    setSelection(ids: Iterable<string> | null) { E.selection = new Set([...(ids || [])].filter((id) => E.kdoc && E.kdoc.items.has(id))); E.selected = null; E.selField = null; E.selPins = []; for (const id of E.selection) { const f = E.items.find((x: ItemSummary) => x.id === id); if (f) { E.selected = f; break; } } store.slice("selection", { ids: [...E.selection], primary: E.selected ? E.selected.id : null, version: (state.selection ? state.selection.version || 0 : 0) + 1 }); drawSelection(); renderProps(); renderObjects(); requestRender(); },
    setMarkers(list: unknown) { E.markers = Array.isArray(list) ? list : []; E.renderOpts.markers = E.markers.length ? E.markers : undefined; store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender(); if (E.markers.length) toast(`${E.markers.length} marker${E.markers.length === 1 ? "" : "s"}`); },
    // one field of a symbol or sheet as the selection (Find selects the matching SCH_FIELD itself)
    selectField(id: string, name: string) { clearSelection(); E.selField = { id, name }; drawSelection(); renderProps(); renderObjects(); requestRender(); },
    setSelected(fp: { id: string } | null) { E.selected = fp ? (E.items.find((f: ItemSummary) => f.id === fp.id) || fp) : null; drawSelection(); renderProps(); renderObjects(); requestRender(); },
    // opts.amend folds the change into the previous undo step (a paste and the move that places it are one step)
    commit(changes: KChange[], label?: string, opts?: CommitOpts) { commitChanges(changes, label, opts); },
    undo() { undoLast(); },
    applyLocal(changes: KChange[]) { applyChanges(changes); },
    requestRender: requestRepaint, toast, enterSheet, setTool,
    // SCH_INSPECTION_TOOL::ShowDatasheet's filesStack: the schematic, the symbol's library copy, the symbol itself
    openDatasheet(value: string, item?: KItem) {
      const doc = E.kdoc as (KDoc & { embeddedFiles?: SNode | null }) | null, files: (SNode | null | undefined)[] = [doc ? doc.embeddedFiles : null];
      if (doc && item) { const ln = KiCadCanvas.kid(item.node, "lib_name") || KiCadCanvas.kid(item.node, "lib_id"); files.push(ln ? KiCadCanvas.resolveLib(doc, String(ln[1])) : null, item.node); }
      openDatasheet(value, { files });
    },
    setArcEditMode(mode: "center" | "endpoints" | "radius") { const p = clonePrefs(); p.schEditing.arcEditMode = mode; savePrefs(p); },
    // the sub-sheets the open page's sheet symbols name (Place Sheet Pins, the ERC's sheet pin checks)
    sheetDocs: subSheetDocs,
    // every sheet path as files from the root down and the sheets read so far (a pasted sheet's recursion test, its page number)
    sheetHierarchy(): { paths: string[][]; docs: Map<string, KDoc> } | null { const f = E.hooks && (E.hooks as { sheetHierarchy?: () => { paths: string[][]; docs: Map<string, KDoc> } | null }).sheetHierarchy; return f ? f() : null; },
    loadSheetDoc(sheet: KItem): Promise<KDoc | null> { const f = E.hooks && (E.hooks as { loadSheetDoc?: (s: KItem) => Promise<KDoc | null> }).loadSheetDoc; return f ? f(sheet) : Promise.resolve(null); },
    // SCH_MOVE_TOOL::moveSelectionToSheet: the items a move dropped on a sheet symbol are added to its sub-sheet
    dropIntoSheet(sheet: KItem, label: string, build: (sub: KDoc) => KChange[]) { const f = E.hooks && (E.hooks as { dropIntoSheet?: (s: KItem, l: string, b: (sub: KDoc) => KChange[]) => void }).dropIntoSheet; if (f) f(sheet, label, build); },
    // BASE_SCREEN::m_LocalOrigin as the drawing tools read and set it, and the Appearance panel's SetLayerVisible( layer, true )
    localOrigin(): number[] { return (E.localOrigin as number[]).slice(); },
    setLocalOrigin(p: number[]) { E.localOrigin = p.slice(); store.slice("viewport", { origin: E.localOrigin.slice() }); },
    showLayer(layer: string) { if (E.kdoc && E.hiddenLayers.has(layer)) setLayerVisible(layer, true); },
    // PCB_BASE_FRAME::SelectToolbarAction: a toolbar group shows the given action (the arc tool's drawing mode)
    setGroupCurrent(group: string, id: string) { if (store.get().groupCurrent[group] !== id) setGroupCurrent(group, id); },
    // PCB_SELECTION_TOOL's hover selection: the Clarify Selection candidates under a point, the popup that asks
    // between them (the pick is selected, then `then` runs with a fresh context), and the app's own footprint
    // drag handed to the module's move (a turn in flight)
    candidatesAt(mm: [number, number]) { return E.hooks && E.hooks.candidatesAt ? E.hooks.candidatesAt(mm) : null; },
    clarify(ids: string[], then: (ctx: ToolCtx) => void) { if (E.hooks && E.hooks.clarify) E.hooks.clarify(ids, () => then(toolCtx())); },
    // a footprint field: the selected one (E.selField), the one the hover selection takes at a point, and dropping it
    selectedField() { return !isSch() && E.selField ? { id: E.selField.id as string, name: E.selField.name as string } : null; },
    fieldAt(mm: [number, number]) { return E.hooks && E.hooks.fieldAt ? E.hooks.fieldAt(mm) : null; },
    clearField() { if (E.selField) { E.selField = null; drawSelection(); renderProps(); renderObjects(); requestRender(); } },
    handoffDrag() { return !!(E.hooks && E.hooks.handoffDrag && E.hooks.handoffDrag()); },
    // Ask a desktop editor in this document to do what the browser cannot (fill zones).
    requestDesktop(action: string) { if (!E.ws || E.ws.readyState !== 1 || !E.joinedDocId) return false; E.ws.send(JSON.stringify({ type: "request", docId: E.joinedDocId, action })); return true; },
    setStatus(text: string) { setStatusBar({ mode: text || "" }); },
    // WarpMouseCursor: the browser cannot move the pointer, so the crosshair and the cursor position go there
    warpCursor(mm: [number, number] | null) { if (!mm) return; E.lastCursorMm = [mm[0], mm[1]]; store.slice("viewport", { cursor: E.lastCursorMm }); refreshCrosshair(); requestRender(); },
  }, extra || {});
}

// Local apply + broadcast, with an inverse recorded for undo.
/**
 * opts.amend folds the changes into the last undo step (a paste and the move that places it are one step, as in
 * pcbnew's commit); with opts.discard as well the step is dropped (the paste was cancelled and the amend took it out).
 * opts.tentative marks a step whose items still follow the cursor: a discard brings the redo list back.
 */
/** Watchers of local edits (ZONE_FILLER_TOOL's dirty-zone refill): called before the edit applies and after. */
export const commitObservers: ((phase: "before" | "after", changes: unknown[], label: string | undefined, opts: unknown) => void)[] = [];
/** What an edit takes with it before it is applied (SCH_LABEL_BASE::SetLabelShape's twins): each returns the changes to commit. */
let commitRewriters: ((changes: KChange[]) => KChange[])[] | undefined;
/** Register a commit rewriter.  The list is made on first use: the modules that register at load import this one in a cycle. */
export function addCommitRewriter(fn: (changes: KChange[]) => KChange[]): void { (commitRewriters = commitRewriters || []).push(fn); }
export function commitChanges(changes: KChange[] | null | undefined, label?: string, opts?: CommitOpts) {
  // EDIT_TOOL::DeleteItems on fields only: "Hide Field(s)", or the info bar when nothing changes (pcb-tools deleteChanges)
  const tag = changes as (KChange[] & { hideLabel?: string; infoError?: string }) | null | undefined;
  if (tag && tag.infoError && !tag.length) { toast(tag.infoError, 4000); return; }
  if (tag && tag.hideLabel && (label === "delete" || label === "Delete")) label = tag.hideLabel;
  if (!changes || !changes.length) return;
  for (const f of commitRewriters || []) { try { changes = f(changes); } catch (e) { console.error(e); } }
  for (const f of commitObservers) { try { f("before", changes, label, opts); } catch (e) { console.error(e); } }
  const inverse: KChange[] = [];
  for (const c of changes) {
    const it = E.kdoc && E.kdoc.items.get(c.id);
    if (c.kind === "ADDED") inverse.push({ id: c.id, kind: "REMOVED", typeName: c.typeName, properties: [] });
    else if (c.kind === "REMOVED" && it) inverse.push({ id: c.id, kind: "ADDED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) });
    else if (c.kind === "MODIFIED" && c.id === "footprint" && E.kdoc && E.kdoc.fpEditor) inverse.push({ id: c.id, kind: "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.footprintDoc.footprintHeaderSexpr(E.kdoc) });   // the Footprint Editor's own footprint
    else if (c.kind === "MODIFIED" && it) inverse.push({ id: c.id, kind: "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) });
  }
  applyChanges(changes);
  sendOp(changes);   // journalled and replayed on reconnect even when the socket is down
  const top = opts && opts.amend ? undoStack[undoStack.length - 1] : null;
  const held = top && top.heldRedo ? top.heldRedo : null; if (top) delete top.heldRedo;
  for (const e of undoStack) delete e.heldRedo;   // any other edit settles a tentative step
  if (top && opts!.discard) { undoStack.pop(); if (held) { redoStack.length = 0; redoStack.push(...held); publishUndo(); return; } }   // a cancelled paste: BOARD_COMMIT::Revert leaves the redo list alone
  else if (top) { top.changes = top.changes.concat(changes); top.inverse = inverse.concat(top.inverse); }
  else {
    const entry: UndoEntry = { label: label || "edit", changes, inverse };
    // opts.tentative: items that still follow the cursor (a paste, a duplicate) — the redo list is kept aside until
    // the step is placed (amend) or cancelled (amend + discard), when it comes back
    if (opts && opts.tentative) entry.heldRedo = redoStack.slice();
    undoStack.push(entry);   // DEFAULT_MAX_UNDO_ITEMS 0: the undo list is not trimmed
  }
  redoStack.length = 0; publishUndo();
  if (isSch() && opts && opts.newSheet) publishDocs();   // a new sheet file joined the project
  for (const f of commitObservers) { try { f("after", changes, label, opts); } catch (e) { console.error(e); } }
}

// One undo list per document.  The stacks used to be global: Ctrl+Z after entering another sheet applied the
// previous sheet's inverse to the sheet now open (its items were written into the wrong file, for everyone).
// The exported arrays stay the same objects (other modules push onto them); their contents follow the open document.
const undoByDoc = new Map<string, { undo: UndoEntry[]; redo: UndoEntry[] }>(); let undoDocId: string | null = null;
export function bindUndoDoc(docId: string | null | undefined) {
  docId = docId || null; if (docId === undoDocId) return;
  if (undoDocId) undoByDoc.set(undoDocId, { undo: undoStack.slice(), redo: redoStack.slice() });
  const next = docId ? undoByDoc.get(docId) : null;
  undoStack.length = 0; redoStack.length = 0;
  if (next) { undoStack.push(...next.undo); redoStack.push(...next.redo); }
  undoDocId = docId; publishUndo();
}

/** Record an undo step for a document that is not the open one (an edit made there from here: Replace All, Sync Sheet Pins). */
export function pushUndoFor(docId: string | null | undefined, entry: UndoEntry) {
  if (!docId || docId === undoDocId) { undoStack.push(entry); redoStack.length = 0; publishUndo(); return; }
  const st = undoByDoc.get(docId) || { undo: [], redo: [] }; st.undo.push(entry); st.redo = []; undoByDoc.set(docId, st);
}

export function publishUndo() { store.set({ undo: { undo: undoStack.length, redo: redoStack.length } }); }

/**
 * Undo / Redo while a tool has an operation in flight (a route, a drag, a move, a shape being drawn) never reach the
 * board's undo list: pcbnew holds an UndoRedoBlock there and the tool takes ACTIONS::undo itself (the router's Undo
 * Last Segment, a move or a drawing cancelled).  The active module answers true when it took the action.
 */
function moduleTakesUndo(which: string) {
  const m = activeModule(); if (!m || typeof m.undoRedo !== "function") return false;
  try { return !!m.undoRedo(toolCtx(), which); } catch (e) { console.warn(e); return false; }
}

export function undoLast() {
  if (moduleTakesUndo("undo")) return;
  const e = undoStack.pop(); if (!e) return;   // ACTIONS::undo is disabled (undoCond): its hotkey runs nothing and says nothing
  const redo = e.changes.map((c): KChange => { const it = E.kdoc.items.get(c.id); return c.kind === "REMOVED" ? c : (it ? { id: c.id, kind: c.kind === "ADDED" ? "ADDED" : "MODIFIED", typeName: c.typeName, sexpr: KiCadCanvas.serializeItem(E.kdoc, it) } : c); });
  if (e.inverse.length) { applyChanges(e.inverse); sendOp(e.inverse); }   // a step held only by its hooks (a variant command) sends no empty op
  if (e.undoOthers) e.undoOthers();   // one commit over several sheets (Edit Text and Graphics) undoes them all
  redoStack.push({ label: e.label, changes: redo, inverse: e.inverse, undoOthers: e.undoOthers, redoOthers: e.redoOthers }); publishUndo();   // pcbnew / eeschema say nothing on an undo
}

export function redoLast() {
  if (moduleTakesUndo("redo")) return;
  const e = redoStack.pop(); if (!e) return;   // ACTIONS::redo is disabled (RedoAvailable): its hotkey runs nothing and says nothing
  if (e.changes.length) { applyChanges(e.changes); sendOp(e.changes); }
  if (e.redoOthers) e.redoOthers();
  undoStack.push(e); publishUndo();
}

/** The active module's tools and menu actions ({id: {label, key, run(ctx)}}), for the toolbar and the menus. */
export function renderModuleTools() {
  const m = activeModule();
  const tools = m && m.tools ? m.tools.map((t) => ({ id: t.id, label: t.label, key: t.key || "", icon: t.icon || "", cursor: t.cursor || "" })) : [];
  const actions = m && m.actions ? Object.entries(m.actions).map(([id, a]) => ({ id, label: (a && a.label) || id, key: (a && a.key) || null, menu: (a && a.menu) || null })) : [];
  store.slice("tool", { moduleTools: tools, moduleActions: actions });
}

/** Run a module action; false means the module declined it (its run() returned false), anything else counts as handled. */
export function runModuleAction(id: string) {
  const m = activeModule(); const a = m && m.actions && m.actions[id];
  if (!a || typeof a.run !== "function") return false;
  // Whoever watches what the person does (the guided first project) hears that the action ran.
  try { const ok = a.run(toolCtx()) !== false; window.dispatchEvent(new CustomEvent("kc:action", { detail: { id } })); return ok; } catch (e) { console.warn(e); toast("Action failed: " + (e as Error).message, 3000); return true; }
}

// Hotkeys in the spec's notation ("Ctrl+Shift+G", "Del", "Space"); Cmd counts as Ctrl on a Mac.
export const KEY_NAMES: Record<string, string> = { Del: "Delete", Esc: "Escape", Space: " ", Ins: "Insert", PgUp: "PageUp", PgDn: "PageDown", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight" };

export function hotkeyMatches(ev: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, key: string | null | undefined) {
  if (!key) return false;
  const parts = String(key).split("+"); const k = parts.pop()!;
  if (parts.includes("Ctrl") !== (ev.ctrlKey || ev.metaKey) || parts.includes("Shift") !== ev.shiftKey || parts.includes("Alt") !== ev.altKey) return false;
  const want = KEY_NAMES[k] || k;
  // Option (Alt) composes another character on a Mac (Option+S types "ß", Option+/ "÷", Option+` is a dead key):
  // the physical key (keys.ts hotkeyKey)
  const got = hotkeyKey(ev); if (!got) return false;
  return want.length === 1 ? got.toUpperCase() === want.toUpperCase() : got === want;
}

export function runModuleHotkey(ev: KeyboardEvent) {
  const m = activeModule(); if (!m || !m.actions) return false;
  const bound = Object.entries(m.actions).filter(([, a]) => a && a.key && hotkeyMatches(ev, a.key));
  for (const [id] of bound) if (runModuleAction(id)) return true;
  // ACTION_MANAGER::RunHotKey: a Shift combination nothing binds runs the unshifted key's action (not for letters)
  const key = hotkeyKey(ev);
  if (bound.length || !ev.shiftKey || !key || /^[a-z]$/i.test(key) || (E.hotkeys && E.hotkeys.shiftBound && E.hotkeys.shiftBound(ev))) return false;
  const plain = { key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, shiftKey: false, altKey: ev.altKey };
  for (const [id, a] of Object.entries(m.actions)) if (a && a.key && hotkeyMatches(plain, a.key)) { if (runModuleAction(id)) return true; }
  return false;
}

export function moduleTool(id: string) { const m = activeModule(); return m && m.tools ? m.tools.find((t) => t.id === id) : null; }


// ---- tools ----
export function setTool(t: string) {
  if (t === "follow") { cycleFollow(); return; }
  if (t === "measure" && isSch()) return;   // only PCB_VIEWER_TOOLS handles ACTIONS::measureTool
  // a viewer may highlight, measure and pan; a drawing or editing tool does not start (KiCad greys it, and so do our bars)
  if (E.viewOnly && moduleTool(t) && t !== "highlight") { toast("View-only access"); if (E.tool !== "select" && moduleTool(E.tool) && E.tool !== "highlight") setTool("select"); return; }
  // KiCad refuses to activate another tool while a wire, a placement or a move is in flight (the module says
  // "Press <ESC> to cancel …" in the infobar and keeps going)
  const vm = activeModule() as unknown as { vetoTool?: (id: string, c: unknown) => boolean } | null;
  if (vm && vm.vetoTool && t !== "pan" && t !== "zoomtool") { try { if (vm.vetoTool(t, toolCtx())) return; } catch (e) { console.warn(e); } }
  const prev = E.tool, before = t !== prev ? selectionIds() : [];
  if (t !== prev) toolChanging(t);   // a drag in flight is put back; a drawing tool starts with nothing selected
  E.tool = t;
  store.slice("tool", { current: t });
  const mt = moduleTool(t);
  stage.className = t === "pan" ? "pan" : t === "comment" ? "comment" : t === "zoomtool" ? "zoomtool" : t === "measure" ? "measure" : "";
  if (t !== "measure" && E.measure) { E.measure = null; requestRepaint(); }
  refreshCursor();   // the tool's KICURSOR
  if (t === "comment" && !E.canComment) { toast(state.me ? "You have view-only access: ask the owner to let you comment" : "Sign in to comment"); setTool("select"); return; }
  const m = activeModule(); if (m && m.onActivate && (mt || moduleTool(prev))) { try { m.onActivate(t, toolCtx(), before); } catch (e) { console.warn(e); } }
  requestRender();
}


export function rotateSelected(delta?: unknown) {
  const d = typeof delta === "number" ? delta : 90;
  const before = E.selected.rot || 0, after = (((before + d) % 360) + 360) % 360;
  sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Orientation", before: { type: "double", v: before }, after: { type: "double", v: after } }] }]);
  E.selected.rot = after;
  if (E.kdoc) applyChanges([{ id: E.selected.id, kind: "MODIFIED", properties: [{ name: "Orientation", after: { v: after } }] }]);
  drawSelection(); renderProps();
}

/** The ids an edit may touch: locked items sit out (a board's unless "Override locks" is on; FilterSelectionForLockedItems). */
export function unlockedForEdit(ids: string[], quiet = false) {
  if (isSch()) {
    const L = CollabTools.sch && (CollabTools.sch._ as unknown as { isLockedItem?: (d: KDoc, it: KItem) => boolean }).isLockedItem, d = E.kdoc as KDoc | null;
    return L && d ? ids.filter((id) => { const it = d.items.get(id); return !it || !L(d, it); }) : ids;
  }
  const m = CollabTools.pcb;
  if (!m || !m.unlockedIds || !E.kdoc) return ids;
  try { return m.unlockedIds(toolCtx(), ids, quiet); } catch (e) { console.warn(e); return ids; }
}

export function deleteSelected() {
  if (!E.selected) return;
  // through commitChanges, so the delete has an inverse: Undo brings the item back (it used to be gone for good)
  const doomed = E.kdoc && E.kdoc.items.get(E.selected.id);
  if (doomed) {
    if (!unlockedForEdit([doomed.id]).length) return;
    const m = activeModule(); let changes: KChange[] | null = null;
    if (m && m.deleteChanges) { try { changes = m.deleteChanges(E.kdoc, [doomed]); } catch (e) { console.warn(e); } }
    if (!changes) changes = [KiCadCanvas.removeChange(doomed)];
    clearSelection(); commitChanges(changes, isSch() ? "Delete" : "delete"); drawSelection(); renderProps(); renderObjects(); requestRender();   // EDIT_TOOL::Remove says nothing
    return;
  }
  sendOp([{ id: E.selected.id, typeName: E.ITEM_TYPE, kind: "REMOVED", properties: [] }]);
  if (E.kdoc) E.kdoc.items.delete(E.selected.id);
  E.items = E.items.filter((f: ItemSummary) => f.id !== E.selected.id);
  E.selected = null; drawSelection(); renderProps(); renderObjects(); requestRender();
}

export function moveOp(fp: { id: string; x: number; y: number }, nx: number, ny: number): KChange {
  return { id: fp.id, typeName: E.ITEM_TYPE, kind: "MODIFIED", properties: [
    { name: "Position X", before: { type: "int", v: fp.x }, after: { type: "int", v: nx } },
    { name: "Position Y", before: { type: "int", v: fp.y }, after: { type: "int", v: ny } }] };
}

export function schKey(k: string) { const m = CollabTools.sch; if (!m || !isSch()) return false; try { return !!m.onKey!(k, {}, toolCtx()); } catch (e) { console.warn(e); return false; } }

export function orientSelected(kind: "ccw" | "cw" | "mv" | "mh") {
  if (isSch()) { if (!schKey({ ccw: "r", cw: "R", mv: "y", mh: "x" }[kind])) toast("Select a symbol or item first"); return; }
  // board: EDIT_TOOL::Rotate / Mirror in the module (the selection or the item under the cursor; footprints are never
  // mirrored, KiCad's infobar says to use Flip)
  if (CollabTools.pcb) { runModuleAction({ ccw: "rotateSelection", cw: "rotateSelectionCw", mh: "mirrorH", mv: "mirrorV" }[kind]); return; }
  if (!E.selected) return;
  if (kind === "ccw") rotateSelected(-90); else if (kind === "cw") rotateSelected(90);
}

export function deleteAction() {
  if (schKey("Delete")) return;
  // board: EDIT_TOOL::Remove — the module's selection, or with nothing selected the item under the cursor (silent)
  const m = !isSch() && activeModule();
  if (m && m.onKey && !E.viewOnly) { try { if (m.onKey("Delete", { shiftKey: false, preventDefault() {} }, toolCtx())) return; } catch (e) { console.warn(e); } }
  if (E.selection.size > 1 && !E.viewOnly) { deleteSelection(); return; }
  if (E.selected && !E.viewOnly) deleteSelected();
}

export function selectAll() {
  if (!E.kdoc) return; E.selection.clear();
  // SCH_SELECTION_TOOL::SelectAll sets STARTPOINT | ENDPOINT on every line: no wire stays selected by one end
  const schSt = isSch() && CollabTools.sch ? (CollabTools.sch.state as unknown as { selEnds?: Map<string, number> | null }) : null;
  if (schSt) schSt.selEnds = null;
  // PCB_SELECTION_TOOL::SelectAll: every item that is Selectable (shown) and passes the Selection Filter, through
  // FilterCollectorForHierarchy; no message
  if (!isSch()) { applyBoardArea(boardAreaIds({ box: [-1e9, -1e9, 1e9, 1e9], contained: true }), { add: false }); return; }
  const all: KItem[] = []; for (const it of E.kdoc.items.values()) if (it.bbox && filterAllows(it.kind, it)) all.push(it);
  scopeToEnteredGroup(all); for (const it of all) E.selection.add(it.id);   // SelectAll runs FilterCollectorForHierarchy too
  E.selected = E.items.find((f: ItemSummary) => E.selection.has(f.id)) || null;
  drawSelection(); renderProps(); renderObjects(); setStatusBar({ message: `${E.selection.size} items selected` });
}

export function deleteSelection() {
  if (!E.kdoc || !E.selection.size) return;
  E.selection = groupExpand(E.selection);
  const its: KItem[] = unlockedForEdit([...E.selection]).map((id) => E.kdoc.items.get(id)).filter(Boolean);
  if (!its.length) return;
  const m = activeModule(); let changes: KChange[] | null = null;
  if (m && m.deleteChanges) { try { changes = m.deleteChanges(E.kdoc, its); } catch (e) { console.warn(e); } }
  if (!changes) changes = its.map((it) => KiCadCanvas.removeChange(it));
  clearSelection(); commitChanges(changes, isSch() ? "Delete" : "delete"); drawSelection(); renderProps(); renderObjects();
}
