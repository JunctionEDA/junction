// editor/library.ts — KiCad library access for the web editor, published as window.KiCadLibrary.
//
// The Choose Symbol / Choose Footprint dialogs, the library browsers and the placement of what
// they return are built on this API; other modules (vendor part import) use the same calls.
//
//   KiCadLibrary.placeSymbol({ libId: "Lib:Name", symbol: "(symbol \"Name\" …)", fields?, unit? }): Promise<void>
//       `symbol` is a KiCad library symbol s-expression with its parents flattened (no "extends").
//       It is embedded in the sheet's lib_symbols under `libId` as KiCad does when a symbol is first
//       used (a copy the sheet already holds wins), and a new instance — reference prefix + "?",
//       the library's fields with `fields` ({ Value, Footprint, Datasheet, …any other name })
//       laid over them, a uuid per pin, the sheet's (instances …) path — rides on the cursor with
//       the Place Symbols tool until a click drops it.  Options `keep` / `allUnits` behave like the
//       dialog's "Place repeated copies" / "Place all units".
//   KiCadLibrary.placeFootprint({ fpid: "Lib:Name", footprint: "(footprint \"Name\" …)", fields? }): Promise<void>
//       `footprint` is .kicad_mod text.  A board footprint with fresh uuids and reference "REF**", on the
//       front side at orientation 0, rides on the cursor with the Place Footprint tool (R rotates, F flips,
//       Esc or Undo drops it); a click places it and the tool stays on until Esc with nothing carried.
//   KiCadLibrary.registerSource({ id, label, kinds: ["symbol", "footprint"],
//                                 search(query, kind): Promise<Array<{ id, name, description?, keywords?, library? }>>,
//                                 fetch(item, kind): Promise<{ libId | fpid, symbol | footprint, fields? }> }): void
//       The source appears as one more top-level group of the chooser dialogs; search() runs on
//       every filter change (also with an empty query) next to the official libraries, and choosing
//       one of its items calls fetch() and then the placement above.  unregisterSource(id) removes it.
//   KiCadLibrary.openChooser(kind: "symbol" | "footprint", opts?: { power?, browser?, title?, filter? }): Promise<chosen | null>
//       The dialog alone: resolves with { kind, item, libId | fpid, symbol | footprint, fields?, unit,
//       keep, allUnits } or null on Cancel, placing nothing.
//   KiCadLibrary.chooseAndPlace(kind, opts?)   the dialog followed by the placement (what the tools call)
//   KiCadLibrary.libraries(kind) / .index(kind, lib) / .fetch(kind, "Lib:Name")
//       The official libraries (server routes /api/libs/*): names + descriptions, one library's rows,
//       one item's s-expression (symbols flattened).
//   KiCadLibrary.core   the pure helpers (flattenSymbol, embedSymbol, symbolInstance, footprintInstance, …)
//
// The schematic tool module calls toolChooser() where it used to open its own picker and
// afterPlace() once a carried symbol is dropped; the board has no place tool of its own, so the
// footprint carry lives here and placeFootprint / the two browsers are published as module actions.
import { openSymbolViewer } from "../symview/frame";
import { SEXPR_BOARD_FILE_VERSION } from "../canvas/format-version";
import { setCursorOverride } from "./cursors";
import { carriedFootprintDialog } from "./pcbdialogs/item-props";
import { state } from "./appstore";
import { snapMm } from "./doc";
import { clearSelection, drawSelection, renderProps } from "./selection";
import { E } from "./state";
import { setTool, toolCtx } from "./tools";
import { toast } from "./util";
import { defaultGrid, prefs } from "../dialogs/prefs";
import { isSch, mmW, mmX0, mmY0, stage, worldMm } from "./view";
import { chooserOpen, closeChooser, openChooser } from "../library/chooser";
import type { ChooserOptions, Chosen } from "../library/chooser";
import * as core from "../library/core";
import { fetchItem, officialIndex, officialLibraries, projectFootprintByLibId, projectLibraries, registerSource, rememberRecent, unregisterSource } from "../library/sources";
import type { FetchedItem, LibItem, LibKind, LibrarySource, SourceContext } from "../library/sources";

export interface PlaceSymbolRequest { libId: string; symbol: string; fields?: Record<string, string>; unit?: number; bodyStyle?: number; keep?: boolean; allUnits?: boolean }
export interface PlaceFootprintRequest { fpid: string; footprint: string; fields?: Record<string, string> }

type Pt = [number, number];
interface SchCarry { kind: string; node: SNode; item: KItem | null; pos: Pt | null }
interface SchHelpers {
  placeCarry(ctx: ToolCtx, mm: Pt): void;
  autoplaceNode(doc: KDoc, item: KItem, opts?: unknown): SNode | null;
  sheetPathHere(doc: KDoc): { path: string | null; project: string | null };
}
interface PcbHelpers {
  addedChange(doc: KDoc, node: SNode): KChange;
  flipFootprintNode(node: SNode): SNode;
  rotateFootprintNode(node: SNode, deg: number): SNode;
}
type RenderFn = (doc: KDoc, ctx: CanvasRenderingContext2D, view: KView, opts: Record<string, unknown>) => void;

const K = (): KiCadCanvasApi => window.KiCadCanvas;
const ctxNow = (): ToolCtx => (toolCtx as unknown as () => ToolCtx)();
interface AppStateLike { docs?: { docId: string; path: string; docType: string }[]; project?: { name?: string; docs?: { docId: string; path: string; docType: string }[] } | null }
const appState = (): AppStateLike => state as unknown as AppStateLike;
// every document of the project (its .kicad_sym / .pretty libraries and fp-lib-table among them): appState().docs keeps
// only the schematics and boards the editor opens (bootpick.ts editorDocs)
const docsNow = (): { docId: string; path: string; docType: string }[] => { const s = appState(); return (s.project && s.project.docs) || s.docs || []; };
// the other sheets' library symbols (dialogs/annotate.ts refreshOtherRefs) for "-- Already Placed --"
const sourceCtx = (): SourceContext => ({ docs: docsNow(), doc: (E.kdoc as KDoc | null) || null,
  otherLibs: isSch() && window.CollabTools && window.CollabTools.sch ? ((window.CollabTools.sch.state as { otherLibs?: Map<string, SNode> | null }).otherLibs || null) : null });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const cursorMm = (): Pt => { const c = (E.lastCursorMm as Pt) || [0, 0]; const s = snapMm([c[0], c[1]]) as Pt; return [s[0], s[1]]; };

// ---------------------------------------------------------------- schematic: a library symbol on the cursor

interface SymbolSession { libId: string; lib: SNode; libName?: string; fields?: Record<string, string>; unit: number; units: number; bodyStyle: number; keep: boolean; allUnits: boolean; reference: string; nodeId: string; doc: KDoc }
let session: SymbolSession | null = null;

function schReady(): { ctx: ToolCtx; doc: KDoc; sch: SchToolModule; h: SchHelpers } {
  const ctx = ctxNow(), sch = window.CollabTools.sch;
  if (!ctx.doc || !isSch() || !sch) throw new Error("Open a schematic sheet to place a symbol");
  if (ctx.viewOnly) throw new Error("This sheet is read-only");
  return { ctx, doc: ctx.doc, sch, h: sch._ as unknown as SchHelpers };
}

/** Project name and sheet path for a new symbol's (instances …): what the sheet's other items say, else the file's own. */
function instanceHome(doc: KDoc, h: SchHelpers): { project: string; path: string } {
  let found: { path: string | null; project: string | null } = { path: null, project: null };
  try { found = h.sheetPathHere(doc); } catch { /* module without the helper */ }
  const pro = docsNow().find((d) => d.docType === "kicad_pro");
  const project = found.project || (pro ? pro.path.split("/").pop()!.replace(/\.kicad_pro$/, "") : "") || String((appState().project || {}).name || "");
  const uuid = (doc as KDoc & { uuid?: string }).uuid;
  return { project, path: found.path || (uuid ? "/" + uuid : "") };
}

/** Every reference in use in the schematic (SCH_SHEET_LIST::GetSymbols): this sheet's symbols and what is known of the other sheets'. */
function usedReferences(doc: KDoc, sch: SchToolModule): (string | core.RefHolder)[] {
  // the other sheets' references are taken too: by their units when known, so a unit can join a package held there
  const other = sch.state as { otherRefs?: Set<string>; otherUnits?: core.RefHolder[] };
  const knownElsewhere = new Set((other.otherUnits || []).map((u) => u.ref));
  const used: (string | core.RefHolder)[] = [...(other.otherUnits || []), ...[...(other.otherRefs || [])].filter((r) => !knownElsewhere.has(r))];
  const valueOf = (node: SNode): string => { const p = (node as SNode[]).find((c) => Array.isArray(c) && c[0] === "property" && c[1] === "Value"); return p ? String(p[2]) : ""; };
  const kidAtom = (node: SNode, key: string): string => { const c = (node as SNode[]).find((x) => Array.isArray(x) && x[0] === key) as SNode[] | undefined; return c ? String(c[1]) : ""; };
  for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref) used.push({ ref: it.ref, lib: kidAtom(it.node, "lib_id"), value: valueOf(it.node), unit: Number(kidAtom(it.node, "unit")) || 1 });
  return used;
}
/** Put a symbol node on the cursor as the Place Symbol tool's carry. */
function rideCursor(s: SymbolSession, node: SNode): void {
  const { ctx, doc, sch, h } = schReady();
  const at = cursorMm();
  s.nodeId = K().uuidOf(node); s.doc = doc;
  const carry: SchCarry = { kind: "symbol", node, item: null, pos: null };
  (sch.state as Record<string, unknown>).carry = carry;                  // onActivate sees the carry and opens no chooser
  // the carry is set first so onActivate opens no chooser; the switch is ours, so the module's veto (a placement
  // in flight refuses another tool) does not apply to it
  if (E.tool !== "place" && E.tool !== "power") {
    const st = sch.state as Record<string, unknown>; const was = st.internalSwitch;
    st.internalSwitch = true;
    try { setTool("place"); } finally { st.internalSwitch = was; }
  }
  h.placeCarry(ctxNow(), at);
  ctx.requestRender();
}
/** The reference of the next package of this session's symbol (annotate()). */
function sessionReference(s: SymbolSession, doc: KDoc, sch: SchToolModule): string {
  const me = s.units > 1 ? { lib: s.libId, value: (s.fields && s.fields.Value !== undefined) ? s.fields.Value : (core.symbolInfo(s.lib).fields.find((f) => f.name === "Value") || { value: "" }).value, unit: s.unit } : null;
  // AnnotateNewSymbol: the project's start number / sheet-number method, the designator tracker, 0nnn for a power symbol
  const info = core.symbolInfo(s.lib), st = sch.state as { refTracker?: { reuse: boolean; used: Set<string> } | null };
  const page = parseInt(String((doc as KDoc & { pageNumber?: string }).pageNumber || ""), 10);
  const minRef = (sch._ as unknown as { newSymbolMinRef?(page: number): number }).newSymbolMinRef;
  return core.nextReference(info.reference, usedReferences(doc, sch), !!sch.state.annotateAuto, me, { min: minRef ? minRef(page > 0 ? page : 1) : 1, power: info.power, tracker: st.refTracker || null });
}

function carrySymbol(s: SymbolSession, sameReference: boolean): void {
  const { doc, sch, h } = schReady();
  const at = cursorMm();
  // a unit of a multi-unit symbol joins a package of the same symbol and value that leaves its unit free
  if (!sameReference) s.reference = sessionReference(s, doc, sch);
  const home = instanceHome(doc, h);
  let node = core.symbolInstance({ libId: s.libId, symbol: s.lib, at, unit: s.unit, bodyStyle: s.bodyStyle, fields: s.fields, reference: s.reference, project: home.project, path: home.path });
  // the sheet's library holds this symbol under another name (a power symbol converted by the preference beside the library's own copy)
  if (s.libName) (node as SNode[]).splice(1, 0, ["lib_name", s.libName] as SNode);
  // SCH_DRAWING_TOOLS::PlaceSymbol autoplaces the fields of a new symbol when m_AutoplaceFields.enable is on
  const ap = (sch.state as { autoplace?: { enable?: boolean } }).autoplace;
  if (!ap || ap.enable !== false) {
    try {
      const ghost = K().addItem(doc, node);
      if (ghost) { doc.items.delete(ghost.id); const placed = h.autoplaceNode(doc, ghost); if (placed) node = placed; }
    } catch (e) { console.warn("autoplace failed", e); }
  }
  rideCursor(s, node);
}

/** Embed the symbol in the sheet's library and carry a new instance of it on the cursor. */
export async function placeSymbol(req: PlaceSymbolRequest): Promise<void> {
  const { doc } = schReady();
  if (!req || typeof req.libId !== "string" || !req.libId.includes(":")) throw new Error('placeSymbol needs libId "Library:Name"');
  if (typeof req.symbol !== "string" || !req.symbol.trim()) throw new Error("placeSymbol needs the symbol's s-expression");
  let lib = doc.lib.has(req.libId) ? K().resolveLib(doc, req.libId) : null;      // the sheet's own copy wins, as on paste
  let libName = "";
  // m_Drawing.new_power_symbols: a power symbol is placed global or local as the preference says (never a non-power one)
  const powerPref = (window.CollabTools.sch!.state as { newPowerSymbols?: string }).newPowerSymbols;
  const converted = core.powerPreferenceSymbol(lib || core.embedSymbol(req.libId, core.flattenSymbol(core.symbolNodeOf(req.symbol, core.parseLibId(req.libId).name))), powerPref);
  if (converted && !lib) { lib = converted; doc.lib.set(req.libId, lib); }
  else if (converted) {
    // the sheet already holds the other kind under this name: the converted copy joins it as "<name>_<n>" (SCH_SCREEN::Append)
    const item = core.parseLibId(req.libId).name, body = (n: SNode): string => JSON.stringify((n as unknown[]).slice(2)), want = body(converted);
    for (const [name, l] of doc.lib) if (name.startsWith(item + "_") && /^\d+$/.test(name.slice(item.length + 1)) && body(l) === want) libName = name;
    if (!libName) { let k = 1; while (doc.lib.has(`${item}_${k}`)) k++; libName = `${item}_${k}`; (converted as unknown[])[1] = libName; doc.lib.set(libName, converted); }
    lib = doc.lib.get(libName)!;
  }
  if (!lib) { lib = core.embedSymbol(req.libId, core.flattenSymbol(core.symbolNodeOf(req.symbol, core.parseLibId(req.libId).name))); doc.lib.set(req.libId, lib); }
  const units = core.symbolInfo(lib).units;
  const unit = Math.min(units, Math.max(1, Math.round(req.unit || 1)));
  const bodyStyle = Math.min(Math.max(1, core.symbolInfo(lib).bodyStyles), Math.max(1, Math.round(req.bodyStyle || 1)));
  session = { libId: req.libId, lib, libName, fields: req.fields, unit, units, bodyStyle, keep: !!req.keep, allUnits: !!req.allUnits && units > 1, reference: "", nodeId: "", doc };
  carrySymbol(session, false);
}

/** sch-tools reports a dropped carry: the next unit, or the next copy, follows the cursor. */
function afterPlace(_ctx: ToolCtx, item: KItem | null): void {
  const s = session;
  if (!s || !item || item.id !== s.nodeId || E.kdoc !== s.doc) { session = null; return; }
  try {
    // PlaceSymbol after a placement: with "place all units" the next unit this reference does not hold yet (past the
    // last one: unit 1 of the next package); the next symbol is a duplicate of the one just placed, so it keeps the
    // orientation, the mirror and the edited fields, and only a unit 1 is annotated again
    const { doc, sch } = schReady();
    let unit = s.unit;
    if (s.allUnits) {
      const holders = usedReferences(doc, sch).filter((u): u is core.RefHolder => typeof u !== "string");
      unit = core.nextFreeUnit(unit, s.units, item.ref || s.reference, s.libId, holders);
    }
    if (s.keep || unit > 1) {
      s.unit = unit;
      if (unit === 1) s.reference = sessionReference(s, doc, sch);
      rideCursor(s, core.duplicatePlaced(item.node, unit, unit === 1 ? s.reference : null));
      return;
    }
  } catch (e) { toast(message(e), 3500); }
  session = null;
}

// ---------------------------------------------------------------- board: a library footprint on the cursor

interface FootprintCarry { node: SNode; ghost: KDoc; canvas: HTMLCanvasElement; raf: number; drawn: string; doc: KDoc; pos: Pt; resolve(): void }
let fpCarry: FootprintCarry | null = null;
/** BOARD_EDITOR_CONTROL::PlaceFootprint as a tool: it stays active after a placement (a click with no footprint on
 *  the cursor opens the chooser again) until Escape with nothing carried, another tool, or another document. */
interface FootprintTool { doc: KDoc; raf: number }
let fpTool: FootprintTool | null = null;
export const PLACE_FOOTPRINT_TOOL = "placeFootprint";

const pcbHelpers = (): PcbHelpers | null => (window as unknown as { PcbTools?: PcbHelpers }).PcbTools || null;
/** PCBNEW_SETTINGS m_RotationAngle (degrees) and m_FlipDirection, as the board tools keep them. */
const pcbPrefs = (): { rotationAngle?: number; flipDirection?: "tb" | "lr" } => ((window as unknown as { PcbTools?: { state?: { rotationAngle?: number; flipDirection?: "tb" | "lr" } } }).PcbTools || {}).state || {};
const rotationStep = (): number => { const a = pcbPrefs().rotationAngle; return typeof a === "number" && a > 0 ? a : 90; };
/** FOOTPRINT::Flip( aCentre, aFlipDirection ): left / right mirrors in X; top / bottom is that, turned by 180 degrees. */
function flipCarried(P: PcbHelpers, node: SNode): void {
  P.flipFootprintNode(node);
  if (pcbPrefs().flipDirection !== "lr") P.rotateFootprintNode(node, 180);
}

/** The carried footprint as its own little board about the origin: the view is shifted instead of the item. */
function ghostBoard(node: SNode, main: KDoc): KDoc {
  const copy = (K().cloneNode as (n: SNode) => SNode)(node);
  const [, , rot] = K().atOf(copy);
  K().setAt(copy, 0, 0, rot);
  const ver = (main as KDoc & { version?: number }).version || SEXPR_BOARD_FILE_VERSION;
  return K().parseDoc(`(kicad_pcb (version ${ver}) (generator "pcbnew") ${K().serialize(copy)})`);
}

function drawFootprintCarry(): void {
  const c = fpCarry; if (!c) return;
  if (E.kdoc !== c.doc || isSch()) { endFootprintCarry(); return; }
  c.raf = requestAnimationFrame(drawFootprintCarry);
  const dpr = window.devicePixelRatio || 1, w = stage.clientWidth, h = stage.clientHeight;
  const flip = !!(E.renderOpts && E.renderOpts.flip);
  const key = [w, h, dpr, E.zoom, E.panX, E.panY, mmX0(), mmY0(), mmW(), c.pos[0], c.pos[1], flip, K().serialize(K().kid(c.node, "at") || [])].join(",");
  if (key === c.drawn) return; c.drawn = key;
  if (c.canvas.width !== Math.round(w * dpr) || c.canvas.height !== Math.round(h * dpr)) { c.canvas.width = Math.round(w * dpr); c.canvas.height = Math.round(h * dpr); }
  const g = c.canvas.getContext("2d"); if (!g) return;
  const view: KView = { ppm: w / mmW(), zoom: E.zoom, panX: E.panX, panY: E.panY, x0: mmX0() - c.pos[0], y0: mmY0() - c.pos[1], dpr };
  if (flip && c.doc.bbox) { const cx = (c.doc.bbox[0] + c.doc.bbox[2]) / 2 - c.pos[0]; c.ghost.bbox = [cx, 0, cx, 0]; }   // mirror about the board's centre, not the ghost's
  g.save(); g.globalAlpha = 1;
  (K().render as unknown as RenderFn)(c.ghost, g, view, { background: false, frame: false, grid: 0, hidden: E.hiddenLayers, flip });
  g.restore();
}

/** The carry ends (placed, or dropped by Escape / Undo); the tool itself stays. */
function endFootprintCarry(): void {
  const c = fpCarry; if (!c) return; fpCarry = null;
  cancelAnimationFrame(c.raf); c.canvas.remove();
  c.resolve();
}
/** The tool watches for its end: another tool, a schematic, another board. */
function watchFootprintTool(): void {
  const t = fpTool; if (!t) return;
  if (E.tool !== PLACE_FOOTPRINT_TOOL || E.kdoc !== t.doc || isSch()) { endFootprintTool(false); return; }
  t.raf = requestAnimationFrame(watchFootprintTool);
}
function startFootprintTool(doc: KDoc): void {
  if (fpTool && fpTool.doc === doc && E.tool === PLACE_FOOTPRINT_TOOL) return;
  endFootprintTool(false);
  // the switch runs the editor's own tool change first (a drag put back, the selection cleared: ACTIONS::selectionClear)
  if (E.tool !== PLACE_FOOTPRINT_TOOL) setTool(PLACE_FOOTPRINT_TOOL);
  fpTool = { doc, raf: 0 };
  window.addEventListener("pointermove", onCarryMove, true); window.addEventListener("pointerdown", onCarryDown, true); window.addEventListener("keydown", onCarryKey, true);
  setCursorOverride("PENCIL");   // KICURSOR::PENCIL for the whole tool
  watchFootprintTool();
}
function endFootprintTool(toSelect: boolean): void {
  endFootprintCarry();
  const t = fpTool; if (!t) return; fpTool = null;
  cancelAnimationFrame(t.raf);
  window.removeEventListener("pointermove", onCarryMove, true); window.removeEventListener("pointerdown", onCarryDown, true); window.removeEventListener("keydown", onCarryKey, true);
  setCursorOverride(null);
  if (toSelect && E.tool === PLACE_FOOTPRINT_TOOL) setTool("select");
}
const onStage = (ev: Event): boolean => ev.target instanceof Node && stage.contains(ev.target) && !(ev.target instanceof Element && ev.target.closest("input, select, k-select, textarea, button, .kd-overlay"));
/** GetCursorPosition( !evt->DisableGridSnapping() ): Ctrl places off the grid. */
const toolPos = (ev: MouseEvent): Pt => { const w = worldMm(ev) as Pt; const p = ev.ctrlKey ? w : snapMm(w) as Pt; return [p[0], p[1]]; };
function onCarryMove(ev: PointerEvent): void {
  const c = fpCarry; if (!c || !onStage(ev)) return;
  c.pos = toolPos(ev);
}
function onCarryDown(ev: PointerEvent): void {
  if (!fpTool || ev.button !== 0 || !onStage(ev) || chooserOpen()) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  const c = fpCarry;
  if (!c) { void chooseAndPlace("footprint").catch((e) => toast(message(e), 4000)); return; }   // SelectFootprintFromLibrary
  c.pos = toolPos(ev);
  const ctx = ctxNow(), P = pcbHelpers();
  const [, , rot] = K().atOf(c.node);
  K().setAt(c.node, +c.pos[0].toFixed(6), +c.pos[1].toFixed(6), rot);
  const node = c.node; endFootprintCarry();
  if (!ctx.doc || !P || ctx.viewOnly) return;
  // ACTIONS::selectionClear, then commit.Push( _( "Place Footprint" ) ); fp = nullptr and the tool runs on
  clearSelection(); drawSelection(); renderProps();
  ctx.commit([P.addedChange(ctx.doc, node)], "Place Footprint");
  ctx.requestRender();
}
function onCarryKey(ev: KeyboardEvent): void {
  if (!fpTool || chooserOpen()) return;
  const t = ev.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.tagName === "K-SELECT")) return;
  if (t && t.closest && t.closest(".kd-overlay")) return;
  const c = fpCarry, P = pcbHelpers(); let took = true;
  const mod = ev.ctrlKey || ev.metaKey;
  // IsCancelInteractive() || ( fp && IsAction( &ACTIONS::undo ) ): the carry is dropped; with none, Escape leaves the tool
  if (ev.key === "Escape") { if (c) endFootprintCarry(); else endFootprintTool(true); }
  else if (c && mod && !ev.shiftKey && (ev.key === "z" || ev.key === "Z")) endFootprintCarry();
  else if (c && (ev.key === "r" || ev.key === "R") && !mod && P) { P.rotateFootprintNode(c.node, ev.shiftKey ? -rotationStep() : rotationStep()); c.ghost = ghostBoard(c.node, c.doc); c.drawn = ""; }
  else if (c && (ev.key === "f" || ev.key === "F") && !mod && P) { flipCarried(P, c.node); c.ghost = ghostBoard(c.node, c.doc); c.drawn = ""; }
  else if (c && (ev.key === "e" || ev.key === "E") && !mod && !ev.altKey) {
    // the event passes to the edit tools: EDIT_TOOL::Properties on the carried footprint (Footprint Properties); the
    // carry goes on with what the dialog wrote
    carriedFootprintDialog(ctxNow(), (K().cloneNode as (n: SNode) => SNode)(c.node), (n) => { if (!n || fpCarry !== c) return; c.node = n; c.ghost = ghostBoard(n, c.doc); c.drawn = ""; });
  }
  else took = false;
  if (took) { ev.stopImmediatePropagation(); ev.preventDefault(); }
}

/** Carry a library footprint on the cursor (the Place Footprint tool, which stays on after the click places it). */
export function placeFootprint(req: PlaceFootprintRequest): Promise<void> {
  const ctx = ctxNow(), P = pcbHelpers();
  if (!ctx.doc || isSch() || !P) return Promise.reject(new Error("Open a board to place a footprint"));
  if (ctx.viewOnly) return Promise.reject(new Error("This board is read-only"));
  if (!req || typeof req.fpid !== "string" || !req.fpid) return Promise.reject(new Error('placeFootprint needs fpid "Library:Name"'));
  if (typeof req.footprint !== "string" || !req.footprint.trim()) return Promise.reject(new Error("placeFootprint needs the footprint's .kicad_mod text"));
  endFootprintCarry();
  startFootprintTool(ctx.doc);
  const pos = cursorMm();
  const node = core.footprintInstance({ fpid: req.fpid, footprint: req.footprint, at: pos, fields: req.fields });
  // "Put it on FRONT layer" (a library built from a board may hold it flipped), then SetOrientation( ANGLE_0 )
  const layer = K().kid(node, "layer");
  if (layer && /^B\./.test(String(layer[1]))) flipCarried(P, node);
  const a0 = K().atOf(node)[2]; if (a0) P.rotateFootprintNode(node, -a0);
  const canvas = document.createElement("canvas");
  canvas.className = "klib-carry"; canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5";
  stage.appendChild(canvas);
  return new Promise<void>((resolve) => {
    fpCarry = { node, ghost: ghostBoard(node, ctx.doc!), canvas, raf: 0, drawn: "", doc: ctx.doc!, pos, resolve };
    drawFootprintCarry();
  });
}

// ---------------------------------------------------------------- the dialogs

/** The schematic module's preview settings: m_AutoplaceFields.enable (autoplace in SYMBOL_PREVIEW_WIDGET) and its helper. */
function schPreviewAutoplace(): ((doc: KDoc, item: KItem) => SNode | null) | null {
  const sch = window.CollabTools && window.CollabTools.sch; if (!sch) return null;
  const ap = (sch.state as { autoplace?: { enable?: boolean } }).autoplace;
  if (ap && ap.enable === false) return null;
  const h = sch._ as unknown as Partial<SchHelpers>;
  return h.autoplaceNode ? (doc, item) => h.autoplaceNode!(doc, item) : null;
}
/** The grid (mm) behind the footprint previews: FOOTPRINT_PREVIEW_PANEL takes the board editor's grid settings (shown
 *  when the grid is, at its current size); 0 for none. */
function previewGrid(): number { if (!E.gridOn) return 0; try { return defaultGrid("pcb"); } catch { return 0; } }
function chooser(kind: LibKind, opts?: ChooserOptions): Promise<Chosen | null> {
  // eeschema m_Appearance.footprint_preview: the symbol chooser's footprint panes come and go with it
  const showFootprints = prefs().schEditing.footprintPreview !== false;
  return openChooser(kind, sourceCtx(), Object.assign({ viewOnly: !!E.viewOnly, showFootprints, autoplace: schPreviewAutoplace(), grid: previewGrid() }, opts || {}));
}

/** The dialog, then the chosen item on the cursor. */
export async function chooseAndPlace(kind: LibKind, opts?: ChooserOptions): Promise<void> {
  if (chooserOpen()) return;
  if (!E.kdoc) { toast("Open a document first"); return; }
  if (E.viewOnly && !(opts && opts.browser)) { toast(kind === "symbol" ? "This sheet is read-only" : "This board is read-only"); return; }
  if ((kind === "symbol") !== isSch()) { toast(kind === "symbol" ? "Symbols are placed on a schematic sheet" : "Footprints are placed on a board"); return; }
  // PlaceFootprint is a tool: it is on while the chooser asks, and stays on when the chooser is cancelled
  if (kind === "footprint" && !(opts && opts.browser)) startFootprintTool(E.kdoc as KDoc);
  const chosen = await chooser(kind, opts);
  if (!chosen) return;
  try {
    // SCH_DRAWING_TOOLS::PlaceSymbol: the pick joins its own history (symbols or power symbols) with its unit and field edits;
    // the footprint chooser records its own picks (FOOTPRINT_CHOOSER_FRAME)
    if (kind === "symbol") rememberRecent(kind, chosen.item, { power: !!(opts && opts.power), unit: chosen.unit, fields: chosen.fieldEdits || null });
    if (kind === "symbol") await placeSymbol({ libId: chosen.libId || chosen.item.id, symbol: chosen.symbol || "", fields: chosen.fields, unit: chosen.unit, bodyStyle: chosen.bodyStyle, keep: chosen.keep, allUnits: chosen.allUnits });
    else void placeFootprint({ fpid: chosen.fpid || chosen.item.id, footprint: chosen.footprint || "", fields: chosen.fields }).catch((e) => toast(message(e), 3500));
  } catch (e) { toast(message(e), 4000); }
}

/** sch-tools' place / power tool asks for a symbol (activation, or a click with nothing on the cursor). */
function toolChooser(_ctx: ToolCtx, which: "place" | "power"): boolean {
  void chooseAndPlace("symbol", { power: which === "power" }).catch((e) => toast(message(e), 4000));
  return true;
}

function fetchOfficial(kind: LibKind, id: string): Promise<FetchedItem> {
  const { lib, name } = core.parseLibId(id);
  const item: LibItem = { id, name, library: lib, source: "official" };
  return fetchItem(kind, item, sourceCtx());
}

/**
 * PCB_BASE_FRAME::LoadFootprint( aFootprintId ): the .kicad_mod text of "Lib:Name" from the library table — a library
 * of the project (its own .pretty) before a global one of the same nickname; null when no library has it.
 */
export async function loadLibraryFootprint(fpid: string): Promise<string | null> {
  const { lib, name } = core.parseLibId(fpid.trim()); if (!lib || !name) return null;
  const ctx = sourceCtx();
  // the project's fp-lib-table nickname (or its .pretty folder) first, as FP_LIB_TABLE resolves it; then the official libraries
  try { const own = await projectFootprintByLibId(lib, name, ctx.docs); if (own) return own; } catch { /* fall through */ }
  if (projectLibraries("footprint", ctx.docs).some((l) => l.name === lib)) return null;
  try { const got = await fetchItem("footprint", { id: `${lib}:${name}`, name, library: lib, source: "official" }, ctx); return got.footprint || null; }
  catch { return null; }
}

export const KiCadLibrary = {
  placeSymbol, placeFootprint, openChooser: chooser, chooseAndPlace, closeChooser, loadFootprint: loadLibraryFootprint,
  registerSource: (source: LibrarySource) => registerSource(source), unregisterSource,
  libraries: (kind: LibKind) => officialLibraries(kind), index: (kind: LibKind, lib: string) => officialIndex(kind, lib), fetch: fetchOfficial,
  core,
  // the tool module's seam
  toolChooser, afterPlace,
};
export type KiCadLibraryApi = typeof KiCadLibrary;

declare global { interface Window { KiCadLibrary: KiCadLibraryApi } }

/** Publish the API and the actions the menus / toolbars look for (placeFootprint and the two library browsers). */
export function installLibrary(): void {
  window.KiCadLibrary = KiCadLibrary;
  const guard = (fn: () => Promise<void>) => (): boolean => { void fn().catch((e) => toast(message(e), 4000)); return true; };
  const act = (id: string, label: string, key: string, run: () => boolean) => ({ id, label, key, run });
  const sch = window.CollabTools && window.CollabTools.sch;   // the board's placeFootprint / showFootprintBrowser live in pcb-tools.js (its action table is frozen)
  if (sch && sch.actions) (sch.actions as Record<string, unknown>).showSymbolBrowser = act("showSymbolBrowser", "Symbol Library Browser", "", guard(() => openSymbolViewer()));
}
