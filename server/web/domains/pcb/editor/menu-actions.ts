// menu-actions.ts — the menu-bar commands that are trivial in a browser, registered into HANDLERS
// (editor/actions.ts) under KiCad's action ids so the menu entries, toolbar buttons and hotkeys light up:
//
//   File     Save a Copy / Save Current Sheet Copy As (download the document), Export > Netlist and
//            Drawing to Clipboard (File > Plot is pcbdialogs/plot.ts and dialogs/plot-schematic.ts)
//   Edit     Properties, Move / Drag (schematic)
//   View     Zoom to Selected Objects, zoom at cursor, centre on cursor, pan, grid next / previous,
//            units (remembered), reset local coordinates, Show Hidden Fields, sheet navigation
//   Route    layer switching (board)
//   Help     List Hotkeys, About (help-dialogs.ts)
import { matchProperties, matchPropertiesSettings } from "./match-properties";
import { leaveSheet } from "./schnets";
import type { ActionHandler } from "./types";
import { cursorClick, cursorStep, panStep } from "./crosshair";
import { gridIndex, gridList, navigateDocs, rootSchematic, setActiveLayer, setGridIndex } from "./doc";
import { HANDLERS, toggleRenderOpt } from "./actions";
import { setToggle, state, store } from "./appstore";
import { openAbout, openHotkeyList } from "./help-dialogs";
import { setCrosshair, setUnitsAction, toggleAlwaysShowCursor } from "./panes";
import { cycleInactiveMode, layerAlphaStep, toggleInactiveMode } from "./panels/appearance";
import { loadSheets, schDocs, sheetDoc, sheetInstances, stepSheetPage } from "./panels/hierarchy";
import { libIsPower, symbolInstanceRef } from "./panels/search-model";
import { askVisibility, cmpEdits, parseCmpFile, pickCmpFile, type CmpSymbolRef } from "../dialogs/import-fp-assignments";
import { submitDocOp } from "../dialogs/project";
import { toolCtx } from "./tools";
import { openSelectionProperties } from "./pointer";
import { E } from "./state";
import { KICAD_BASE_VERSION } from "../canvas/version";
import { PRODUCT_VERSION } from "../generated/product-version";
import { openExportNetlist } from "./export-netlist";
import { startMove } from "./gestures";
import { schKey } from "./tools";
import { esc, toast } from "./util";
import { applyView, fitBox, flipMmX, isSch, mmW, mmX0, mmY0, requestRender, stage, world, zoomBy, zoomStep } from "./view";
import { fitMargin } from "./zoomlist";
import { currentDoc, download, fileStem } from "./download";
import * as VM from "../canvas/variant-model";
import type { ActionState } from "../tables";

type Sx = (string | number | Sx)[];
interface DocEntry { docId: string; path: string; docType: string }
interface Item { id: string; kind: string; node: Sx; bbox: number[] | null; ref?: string }
interface Canvas {
  renderSvg(doc: unknown, opts: Record<string, unknown>): string;
  renderPng(doc: unknown, opts: Record<string, unknown>): Promise<Blob>;
  kid(n: Sx, k: string): Sx | null; kids(n: Sx, k: string): Sx[]; str(v: unknown): string;
}
interface Dialogs { open(spec: { title: string; width?: number; build(body: HTMLElement): void; okLabel?: string; ok?(): boolean | void }): void }
const W = window as unknown as { KiCadCanvas: Canvas; KDialogs?: Dialogs; CollabTools: Record<string, any> };   // eslint-disable-line @typescript-eslint/no-explicit-any
const st = state as unknown as { docs?: DocEntry[]; docId?: string | null; project?: { name?: string } | null };

// ---------------------------------------------------------------- files
/** File > Save a Copy... / Save Current Sheet Copy As...: the document as the server holds it, every edit applied. */
async function saveDocCopy(): Promise<void> {
  const d = currentDoc(); if (!d) { toast("No document open"); return; }
  try {
    const r = await fetch(`/api/docs/${d.docId}/content?v=${Date.now()}`);
    if (!r.ok) throw new Error(String(r.status));
    const { name } = fileStem();
    download(await r.text(), name); toast("Saved a copy as " + name);
  } catch (e) { toast("Save failed: " + (e as Error).message, 4000); }
}

/** File > Export > Drawing to Clipboard: the sheet as a PNG image on the system clipboard. */
async function drawingToClipboard(): Promise<void> {
  if (!E.kdoc) return;
  try {
    const blob = await W.KiCadCanvas.renderPng(E.kdoc, Object.assign({}, E.renderOpts, { dpi: 200, hidden: E.hiddenLayers }));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Drawing copied to the clipboard");
  } catch (e) { toast("Couldn't copy the drawing: " + (e as Error).message, 4000); }
}

interface LayerRow { key: string; name: string; color: string }
// ---------------------------------------------------------------- view
/** The cursor's position in stage pixels (zoom-at-cursor and centre-on-cursor work from it). */
function cursorPx(): [number, number] {
  const r = world.getBoundingClientRect(), s = stage.getBoundingClientRect(); const mm = E.lastCursorMm as number[];
  return [r.left - s.left + ((flipMmX(mm[0]) - mmX0()) / mmW()) * r.width, r.top - s.top + ((mm[1] - mmY0()) / mmW()) * r.width];
}
function zoomAtCursor(zoomIn: boolean): void { const [x, y] = cursorPx(); zoomStep(zoomIn, x, y); }   // doZoomInOut( dir, aCenterOnCursor ); the browser cannot warp the mouse, so the cursor point stays put
function centreOnCursor(): void { const [x, y] = cursorPx(); E.viewTouched = true; E.panX += stage.clientWidth / 2 - x; E.panY += stage.clientHeight / 2 - y; applyView(); }
/** Ids of everything selected: the app's selection, a selected field's owner and the tool module's own pick. */
export function selectedIds(): string[] {
  const ids = new Set<string>(E.selection as Set<string>);
  if (E.selected) ids.add(E.selected.id);
  if (E.selField) ids.add(E.selField.id);
  const mod = W.CollabTools && (isSch() ? W.CollabTools.sch : W.CollabTools.pcb), sel = mod && mod.state && mod.state.sel;
  if (typeof sel === "string") ids.add(sel); else if (sel && typeof sel.forEach === "function") sel.forEach((id: string) => ids.add(id));
  return [...ids];
}
function zoomFitSelection(): void {
  if (!E.kdoc) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of selectedIds()) { const b = (E.kdoc.items.get(id) as Item | undefined)?.bbox; if (b) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); } }
  if (x0 === Infinity) { toast("Nothing selected"); return; }
  E.viewTouched = true; fitBox([x0, y0, Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3)], fitMargin(stage.clientHeight, false));
}

/** COMMON_TOOLS::GridNext / GridPrev (N, Shift+N): the next or previous grid of the list, wrapping round. */
function stepGrid(dir: number): void {
  const n = gridList().length; if (!n) return;
  const i = gridIndex(); setGridIndex(i < 0 ? 0 : (i + dir + n) % n);
}

const UNIT_ACTION: Record<string, string> = { mm: "millimetersUnits", in: "inchesUnits", mil: "milsUnits" };
function setUnits(u: "mm" | "in" | "mil"): void { setUnitsAction(u, UNIT_ACTION[u]); }
/** Ctrl+U (ACTIONS::toggleUnits, COMMON_TOOLS::ToggleUnits): between millimetres and the imperial unit last used. */
function toggleUnits(): void { setUnits(E.units === "mm" ? (E.lastImperial || "mil") : "mm"); }

/** COMMON_TOOLS::ResetLocalCoords (Space): the local origin goes where the crosshair is (the forced or grid-snapped
 *  GetCursorPosition the status bar shows), so dx / dy / dist read 0 right after. */
function resetLocalCoords(): void {
  const c = store.get().viewport.cursor as number[] | undefined;
  E.localOrigin = (c && c.length === 2 ? c : (E.lastCursorMm as number[])).slice();
  store.slice("viewport", { origin: E.localOrigin.slice() });
}

/** SCH_NAVIGATE_TOOL::Previous / Next: by virtual page number over the hierarchy; no wrap at either end. */
function stepSheet(dir: number): void { stepSheetPage(dir); }

function stepLayer(dir: number): void {
  const cu = (store.get().document.copperLayers || []) as LayerRow[]; if (!cu.length) return;
  const i = Math.max(0, cu.findIndex((l) => l.name === E.activeLayer));
  setActiveLayer(cu[(i + dir + cu.length) % cu.length].name);
}
function copperLayer(name: string): void { const cu = (store.get().document.copperLayers || []) as LayerRow[]; if (cu.some((l) => l.name === name)) setActiveLayer(name); }


const DOCS = "https://go.kicad.org/docs/", PRODUCT_REPO = "https://github.com/JunctionEDA/junction";
/** GetMajorMinorVersion: "10.99" of the KiCad this editor is built on. */
const docsVersion = (): string => KICAD_BASE_VERSION.split(".").slice(0, 2).join(".");
/** GetVersionInfoData's first lines, as the bug report's body carries them. */
function versionInfo(): string {
  const nav = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return `Application: Junction ${isSch() ? "Schematic Editor" : "PCB Editor"} (web)\nVersion: ${PRODUCT_VERSION}, based on KiCad ${KICAD_BASE_VERSION}\nBrowser: ${nav}`;
}
function openUrl(url: string): void { window.open(url, "_blank", "noopener"); }

export const MENU_HANDLERS: Record<string, ActionHandler> = {
  saveCopy: () => saveDocCopy(), saveCurrSheetCopyAs: () => saveDocCopy(),
  exportNetlist: () => openExportNetlist(), drawSheetOnClipboard: () => drawingToClipboard(),
  properties: () => { openSelectionProperties(); },
  zoomFitSelection, zoomIn: () => zoomAtCursor(true), zoomOut: () => zoomAtCursor(false), zoomCenter: centreOnCursor,
  panUp: () => panStep(0, 1), panDown: () => panStep(0, -1), panLeft: () => panStep(1, 0), panRight: () => panStep(-1, 0),
  cursorUp: () => cursorStep(0, -1, 1), cursorDown: () => cursorStep(0, 1, 1), cursorLeft: () => cursorStep(-1, 0, 1), cursorRight: () => cursorStep(1, 0, 1),
  cursorUpFast: () => cursorStep(0, -1, 10), cursorDownFast: () => cursorStep(0, 1, 10), cursorLeftFast: () => cursorStep(-1, 0, 10), cursorRightFast: () => cursorStep(1, 0, 10),
  // Enter / the Double-click action: the mouse button at the cursor (COMMON_TOOLS::CursorControl).  End is
  // ACTIONS::finishInteractive first, which the tools take themselves (a wire, a shape, a route): when none is in
  // progress KiCad's tools ignore it, so the key does nothing here either.
  cursorClick: () => cursorClick(1), cursorDblClick: () => cursorClick(2), finishInteractive: () => {},
  // MATCH_PROPERTIES_TOOL (match-properties.ts): the source is the one selected item; Ctrl+, only inside the tool
  matchProperties: () => { matchProperties(); }, matchPropertiesSettings: () => { matchPropertiesSettings(); },
  // COMMON_CONTROL::ShowHelp / GetInvolved / ReportBug: the online manual of this editor (help_name), Getting Started,
  // the source repository and a new issue carrying the version, each in a new browser tab as wxLaunchDefaultBrowser
  help: () => openUrl(`${DOCS}${docsVersion()}/en/${isSch() ? "eeschema" : "pcbnew"}/`),
  gettingStarted: () => openUrl(`${DOCS}${docsVersion()}/en/getting_started_in_kicad/`),
  getInvolved: () => openUrl(PRODUCT_REPO),
  reportBug: () => openUrl(`${PRODUCT_REPO}/issues/new?body=${encodeURIComponent("```\n" + versionInfo() + "\n```")}`),
  gridNext: () => stepGrid(1), gridPrev: () => stepGrid(-1),
  millimetersUnits: () => setUnits("mm"), inchesUnits: () => setUnits("in"), milsUnits: () => setUnits("mil"), toggleUnits,
  resetLocalCoords,
  // the menu entry is a checkbox: a second click goes back to the small crosshairs
  toggleCursor: () => toggleAlwaysShowCursor(),
  cursorFullCrosshairs: () => (E.crosshairMode === "full" ? setCrosshair("small", "cursorSmallCrosshairs") : setCrosshair("full", "cursorFullCrosshairs")),
  // eeschema's Show Hidden Fields and pcbnew's Show Hidden Text are separate settings
  toggleHiddenFields: () => toggleRenderOpt("showHiddenFields", "toggleHiddenFields"),
  showHiddenText: () => toggleRenderOpt("showHiddenText", "showHiddenText"),
  // eeschema's View options (EESCHEMA_SETTINGS appearance), each a render option of the schematic painter
  toggleDirectiveLabels: () => schView("showDirectiveLabels", "toggleDirectiveLabels"),
  markSimExclusions: () => schView("markSimExclusions", "markSimExclusions"),
  toggleERCErrors: () => schView("showErcErrors", "toggleERCErrors"),
  toggleERCWarnings: () => schView("showErcWarnings", "toggleERCWarnings"),
  toggleERCExclusions: () => schView("showErcExclusions", "toggleERCExclusions", false),
  // the operating point of the last OP analysis (sim/op-overlay.ts) is drawn under these
  toggleOPVoltages: () => schView("showOpVoltages", "toggleOPVoltages"),
  toggleOPCurrents: () => schView("showOpCurrents", "toggleOPCurrents"),
  togglePinAltIcons: () => {
    const on = !(E.renderOpts.showPinAltIcons !== false); E.renderOpts.showPinAltIcons = on; setToggle("togglePinAltIcons", on);
    KiCadCanvas.setSchDisplay({ pinAltIcons: on }, E.kdoc && isSch() ? E.kdoc : null); E.renderFull = true; requestRender();
  },
  highContrastModeCycle: () => { if (isSch()) return; cycleInactiveMode(); },
  highContrastMode: () => { if (isSch()) toggleRenderOpt("highContrast", "highContrastMode"); else toggleInactiveMode(); },
  layerAlphaInc: () => { if (!isSch()) layerAlphaStep(1); }, layerAlphaDec: () => { if (!isSch()) layerAlphaStep(-1); },
  navigatePrevious: () => stepSheet(-1), navigateNext: () => stepSheet(1), leaveSheet,
  layerNext: () => stepLayer(1), layerPrev: () => stepLayer(-1), layerTop: () => copperLayer("F.Cu"), layerBottom: () => copperLayer("B.Cu"),
  listHotKeys: () => openHotkeyList(), about: () => openAbout(),
  importFPAssignments: () => { void importFPAssignments(); },
  languageEnglish: () => {},
};
Object.assign(HANDLERS, MENU_HANDLERS, {
  // schematic only (tables.ts EDITOR_ONLY): Move / Drag start the module's connected drag exactly as its M / G keys do
  move: () => { startMove("move"); },
  drag: () => { startMove("drag"); },
});
setToggle("languageEnglish", true);
/**
 * File > Import > Footprint Assignments... (SCH_EDITOR_CONTROL::ImportFPAssignments): the .cmp file, the visibility
 * choice, then processCmpToFootprintLinkFile over Hierarchy().GetSymbols( SYMBOL_FILTER_NON_POWER ): every symbol with
 * a library symbol, not power and not a '#' reference, on every sheet instance, matched by its composed reference there.
 */
async function importFPAssignments(): Promise<void> {
  if (!isSch() || !E.kdoc) return;
  if (E.viewOnly) { toast("View-only access"); return; }
  const file = await pickCmpFile(); if (!file) return;
  const vis = await askVisibility(); if (vis === null) return;
  try { await loadSheets(); } catch (e) { /* the sheets as last read */ }
  const fail = async (): Promise<void> => { const m = await import("../dialogs/sch-items"); await m.messageBox(`Failed to open symbol-footprint link file '${file.name}'.`); };
  const K = KiCadCanvas as unknown as { kid(n: SNode, k: string): SNode | null; str(v: unknown): string; resolveLib(doc: KDoc, name: string): SNode | null; replaceChange(doc: KDoc, it: KItem): KChange };
  if (file.text.includes("\u0000")) { await fail(); return; }
  const refs: CmpSymbolRef[] = [];
  for (const inst of sheetInstances()) {
    const docId = inst.node.docId; if (!docId) continue;
    const doc = sheetDoc(docId); if (!doc) continue;
    for (const it of doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const libId = K.str((K.kid(it.node, "lib_id") || [])[1]), libName = K.str((K.kid(it.node, "lib_name") || [])[1]);
      const def = K.resolveLib(doc, libName || libId) || (libName ? K.resolveLib(doc, libId) : null);
      if (!def) continue;   // GetLibSymbolRef(): orphans are left out
      const ref = symbolInstanceRef(it.node as unknown[], inst.instPath).ref;
      if (libIsPower(def as unknown[]) || ref.startsWith("#")) continue;
      refs.push({ docId, id: it.id, ref });
    }
  }
  const edits = cmpEdits(parseCmpFile(file.text), refs, (docId, id) => { const d = sheetDoc(docId), it = d ? d.items.get(id) : null; return it ? it.node : null; }, vis);
  const here = state.docId;
  try {
    for (const [docId, nodes] of edits) {
      const doc = sheetDoc(docId); if (!doc) continue;
      const changes: KChange[] = [];
      for (const [id, n] of nodes) { const it = doc.items.get(id); if (it && JSON.stringify(it.node) !== JSON.stringify(n)) changes.push(K.replaceChange(doc, Object.assign({}, it, { node: n, geom: [], bbox: null }))); }
      if (!changes.length) continue;
      if (docId === here) (toolCtx() as unknown as { commit(c: KChange[], label: string): void }).commit(changes, "Import Footprint Assignments");
      else await submitDocOp(docId, changes);
    }
  } catch (e) { await fail(); return; }
  requestRender();
}
/** A schematic View option held in the render options; `dflt` is KiCad's default (EESCHEMA_SETTINGS). */
function schView(key: string, id: string, dflt = true): void {
  const on = !(E.renderOpts[key] === undefined ? dflt : !!E.renderOpts[key]);
  E.renderOpts[key] = on; setToggle(id, on); store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender();
}
for (const id of ["toggleDirectiveLabels", "markSimExclusions", "toggleERCErrors", "toggleERCWarnings", "toggleOPVoltages", "toggleOPCurrents", "togglePinAltIcons"]) setToggle(id, true);
setToggle("toggleERCExclusions", false);

/** Exposed for the chrome (window.CollabApp.selectionCount) so menus can grey out what needs a selection. */
export function selectionCount(): number { return E.kdoc ? selectionKeys().length : 0; }
/**
 * What the actions' enable and check conditions read (tables.ts conditionWhy), as window.CollabApp.actionState():
 * the selection's size and kinds, how many items the sheet holds, whether a tool has an operation in flight, the undo
 * list, and the Edit > Attributes check marks (SCH_EDIT_TOOL::Init attribDNPCond …: the selected symbols, sheets and
 * rule areas all carry the attribute, read through the current variant on the sheet instance).
 */
export function actionState(): ActionState {
  const doc = E.kdoc as KDoc | null, keys = doc ? selectionKeys() : [];
  const items = doc ? selectedIds().map((id) => doc.items.get(id)).filter((it): it is KItem => !!it) : [];
  const sch = isSch(), mod = W.CollabTools && (W.CollabTools.sch as unknown as { _?: { busyMessage?: () => string | null | undefined } } | undefined);
  let busy = ""; try { busy = sch && mod && mod._ && mod._.busyMessage ? String(mod._.busyMessage() || "") : ""; } catch (e) { busy = ""; }
  const checks: Record<string, boolean> = {};
  if (sch && doc) {
    const variant = String(E.currentVariant || ""), ed = E as { currentSheetPathOf?: () => string | null };
    const path = variant && ed.currentSheetPathOf ? ed.currentSheetPathOf() : null, nodes = items.map((it) => it.node);
    const on = (f: keyof VM.SymFlags): boolean => VM.attributeChecked(nodes, f, variant, path, doc.version);
    checks.setDNP = on("dnp"); checks.setExcludeFromSim = on("excludedFromSim"); checks.setExcludeFromBOM = on("excludedFromBOM");
    checks.setExcludeFromBoard = on("excludedFromBoard"); checks.setExcludeFromPosFiles = on("excludedFromPosFiles");
  }
  // SCH_SCREENS::HasNoFullyDefinedLibIds over the sheets of the project
  let symbols = 0, named = 0;
  if (sch) for (const d of schDocs()) { const sd = sheetDoc(d.docId); if (sd) for (const it of sd.items.values()) if (it.kind === "symbol") { symbols++; if (String(it.lib || "").includes(":")) named++; } }
  const u = store.get().undo;
  return { selCount: keys.length, selKinds: Array.from(new Set(items.map((it) => it.kind))), itemCount: doc ? doc.items.size : 0, idle: !busy, drawingWire: busy === "Press <ESC> to cancel drawing.",
    undo: u.undo, redo: u.redo, legacyLibIds: symbols > 0 && named === 0, checks };
}
/** Everything selected, pads included: the item ids of selectedIds() plus the board's picked pads as
 *  "footprintId#padIndex" (PCB_PAD_T in KiCad's selection).  Also window.CollabEditor.hooks.selectionKeys(). */
export function selectionKeys(): string[] {
  const ids = selectedIds(); if (isSch()) return ids;
  const P = W.CollabTools && W.CollabTools.pcb; const pads: string[] = P && P.selectedPadKeys ? P.selectedPadKeys() : [];
  return [...ids, ...pads.filter((k) => !ids.includes(k))];
}
E.hooks.selectionKeys = selectionKeys;
