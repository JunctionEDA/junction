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
import { groupDesignBlockId } from "../library/design-blocks";
import { matchProperties, matchPropertiesSettings } from "./match-properties";
import { leaveSheet } from "./schnets";
import type { ActionHandler } from "./types";
import { cursorClick, cursorStep, panStep, refreshCrosshair, placeCrosshair } from "./crosshair";
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
import { exportForOlderVersion, exportGenCad, exportIdf, exportSpecctraDsn } from "./kicad-jobs";
import { exportSymbolsToLibrary } from "./export-symbols";
import { selectedAnywhere, startMove } from "./gestures";
import { openContextMenu } from "./contextmenu";
import { hotkeyCyclePopup } from "./hotkey-popup";
import { overlayHooks } from "./overlays";
import { messageText } from "../../../shared/units";
import type { Units } from "../../../shared/store";
import { schKey } from "./tools";
import { esc, toast } from "./util";
import type { PcbEnableFacts } from "../tables";
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
/** A design point's position in stage pixels. */
function mmPx(mm: number[]): [number, number] {
  const r = world.getBoundingClientRect(), s = stage.getBoundingClientRect();
  return [r.left - s.left + ((flipMmX(mm[0]) - mmX0()) / mmW()) * r.width, r.top - s.top + ((mm[1] - mmY0()) / mmW()) * r.width];
}
/**
 * Zoom In / Out at Cursor (F1 / F2): doZoomInOut( dir, aCenterOnCursor = true ) -> doZoomToPreset: SetScale( scale,
 * GetCursorPosition() ) — about the crosshair (the snapped or forced cursor), then with "Center and warp cursor on
 * zoom" CenterOnCursor.  The browser cannot warp the mouse: the crosshair is put at the centre instead, as the wheel
 * zoom does (gestures.ts zoomAtPointer).
 */
function zoomAtCursor(zoomIn: boolean): void {
  const at = cursorPosition(), [x, y] = mmPx(at); zoomStep(zoomIn, x, y);
  if (E.wheel && E.wheel.centerOnZoom) centerOnCursor(at);
}
/** VIEW_CONTROLS::GetCursorPosition: the crosshair's (snapped or forced) position. */
function cursorPosition(): number[] { const c = store.get().viewport.cursor as number[] | undefined; return c && c.length === 2 ? c.slice() : (E.lastCursorMm as number[]).slice(); }
/**
 * WX_VIEW_CONTROLS::CenterOnCursor (View > Center on Cursor, F4, and the zooms above): the view is centred on
 * GetCursorPosition() and the pointer warped to the centre, so the cursor stays on that design point.  The browser
 * cannot warp the mouse: the crosshair is put at the centre, and wheel notches with the pointer where it was zoom
 * about the centre (E.wheelWarp) until the pointer moves.
 */
function centerOnCursor(at: number[] = cursorPosition()): void {
  const sw = stage.clientWidth, sh = stage.clientHeight, [x, y] = mmPx(at);
  if (Math.abs(x - sw / 2) < 0.5 && Math.abs(y - sh / 2) < 0.5) return;   // GetMousePosition( false ) != screenCenter
  E.viewTouched = true; E.panX += sw / 2 - x; E.panY += sh / 2 - y; applyView();
  E.wheelWarp = E.lastClient ? [E.lastClient[0], E.lastClient[1]] : null;
  E.lastCursorMm = at.slice(); const p = placeCrosshair(at); if (p) store.slice("viewport", { cursor: [p[0]!, p[1]!] });
}
function centreOnCursor(): void { centerOnCursor(); }
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
  if (x0 === Infinity) return;   // COMMON_TOOLS::doZoomFit: an empty selection does nothing
  E.viewTouched = true; fitBox([x0, y0, Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3)], fitMargin(stage.clientHeight, false));
}

/**
 * COMMON_TOOLS::GridNext / GridPrev (N, Shift+N): the next or previous grid of the list, wrapping round.  Both end in
 * OnGridChanged( true ), which posts GridChangedByKeyEvent; eeschema's SCH_EDITOR_CONTROL::GridFeedback answers it
 * with the "Grid" HOTKEY_CYCLE_POPUP of every grid (GRID::UserUnitsMessageText), pcbnew with nothing.
 */
function stepGrid(dir: number): void {
  const list = gridList(), n = list.length; if (!n) return;
  const i = gridIndex(), next = i < 0 ? 0 : (i + dir + n) % n; setGridIndex(next);
  if (isSch()) { const u = (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units; hotkeyCyclePopup("Grid", list.map((g) => messageText(g.mm, u, "sch")), next); }
}

/**
 * ACTIONS::showContextMenu (COMMON_TOOLS::CursorControl with CURSOR_RIGHT_CLICK): a right click at the cursor, so the
 * active tool's menu opens there as it would for the mouse button.
 */
function showContextMenu(): void {
  if (!E.kdoc || !E.lastCursorMm) return;
  const [x, y] = mmPx(cursorPosition()), s = stage.getBoundingClientRect();
  openContextMenu({ clientX: s.left + x, clientY: s.top + y });
}

/**
 * COMMON_TOOLS::ToggleBoundingBoxes: RENDER_SETTINGS::SetDrawBoundingBoxes, a debugging aid.  SCH_PAINTER::
 * drawItemBoundingBox strokes each item's box (a symbol's body box) 3 mils wide, red when selected and dark grey
 * otherwise; PCB_PAINTER strokes each item's box 1 px wide, a footprint magenta with its bounding hull in cyan, anything
 * else grey (0.4), and every selected one red.
 */
function toggleBoundingBoxes(): void {
  const on = !E.renderOpts.drawBoundingBoxes; E.renderOpts.drawBoundingBoxes = on; setToggle("toggleBoundingBoxes", on);
  store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) }); requestRender();
}
overlayHooks.push((ctx) => {
  if (!E.kdoc || !E.renderOpts || !E.renderOpts.drawBoundingBoxes) return;
  const m = ctx.getTransform(), px = 1 / Math.max(1e-9, Math.hypot(m.a, m.b)), sch = isSch(), sel = selectedAnywhere();
  const sm = sch && W.CollabTools && W.CollabTools.sch && W.CollabTools.sch._ ? W.CollabTools.sch._ as { bodyBox?: (d: unknown, it: unknown) => number[] | null } : null;
  const geomBox = (KiCadCanvas as unknown as { geomBox?: (g: unknown) => number[] | null }).geomBox;
  ctx.save(); ctx.setLineDash([]);
  for (const it of (E.kdoc.items as Map<string, { id: string; kind: string; bbox: number[] | null; geom: { t?: string; padText?: boolean; padNum?: boolean; noBox?: boolean }[] }>).values()) {
    let b = it.bbox;
    if (sch && it.kind === "symbol" && sm && sm.bodyBox) { try { b = sm.bodyBox(E.kdoc, it) || b; } catch { /* keep the item box */ } }
    if (!b) continue;
    const on = sel.has(it.id), fp = !sch && it.kind === "footprint";
    ctx.strokeStyle = on ? "rgb(255,51,51)" : sch ? "rgb(51,51,51)" : fp ? "rgb(255,0,255)" : "rgb(102,102,102)";
    ctx.lineWidth = sch ? 3 * 0.0254 : px;
    ctx.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    if (fp && geomBox) {
      // FOOTPRINT::GetBoundingHull: the convex hull of what the footprint draws, texts aside
      const pts: number[][] = [];
      for (const g of it.geom) { if (g.padText || g.padNum || g.noBox || g.t === "text") continue; const q = geomBox(g); if (q) pts.push([q[0], q[1]], [q[2], q[1]], [q[2], q[3]], [q[0], q[3]]); }
      const hull = convexHull(pts); if (hull.length < 3) continue;
      ctx.strokeStyle = on ? "rgb(255,51,51)" : "rgb(0,255,255)";
      ctx.beginPath(); ctx.moveTo(hull[0][0], hull[0][1]); for (const p of hull.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.stroke();
    }
  }
  ctx.restore();
});
/** Andrew's monotone chain. */
function convexHull(pts: number[][]): number[][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [], hi: number[][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
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
  // run by the desktop's own exporters on the server (kicad-jobs.ts): ExportForOlderVersion in both editors, the board's
  // ExportSpecctraDSN, ExportGenCAD and ExportIDF
  exportForOlderVersion: () => { void exportForOlderVersion(); },
  exportSymbolsToLibrary: () => { void exportSymbolsToLibrary(); },
  exportSpecctraDSN: () => { void exportSpecctraDsn(); }, exportGenCAD: () => exportGenCad(), exportIDF: () => { void exportIdf(); },
  properties: () => { openSelectionProperties(); },
  zoomFitSelection, zoomIn: () => zoomAtCursor(true), zoomOut: () => zoomAtCursor(false), zoomCenter: centreOnCursor,
  panUp: () => panStep(0, 1), panDown: () => panStep(0, -1), panLeft: () => panStep(1, 0), panRight: () => panStep(-1, 0),
  cursorUp: () => cursorStep(0, -1, 1), cursorDown: () => cursorStep(0, 1, 1), cursorLeft: () => cursorStep(-1, 0, 1), cursorRight: () => cursorStep(1, 0, 1),
  cursorUpFast: () => cursorStep(0, -1, 10), cursorDownFast: () => cursorStep(0, 1, 10), cursorLeftFast: () => cursorStep(-1, 0, 10), cursorRightFast: () => cursorStep(1, 0, 10),
  // Enter / the Double-click action: the mouse button at the cursor (COMMON_TOOLS::CursorControl).  End is both
  // ACTIONS::finishInteractive, which a tool that is drawing takes itself (a wire, a shape, a route), and
  // ACTIONS::cursorDblClick, which hotkeys.ts orderedOwners tries first: a double click at the cursor
  cursorClick: () => cursorClick(1), cursorDblClick: () => cursorClick(2), finishInteractive: () => {},
  showContextMenu, toggleBoundingBoxes,
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
  toggleCursor: () => toggleAlwaysShowCursor(),
  // COMMON_TOOLS::CursorFullCrosshairs always sets FULLSCREEN_CROSS (Small and 45° are their own actions)
  cursorFullCrosshairs: () => setCrosshair("full", "cursorFullCrosshairs"),
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
  // PCB_CONTROL::LayerSwitch for PCB_ACTIONS::layerInner1..30: the inner layer when the board has it
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i): [string, ActionHandler] => ["layerInner" + (i + 1), () => copperLayer(`In${i + 1}.Cu`)])),
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
    undo: u.undo, redo: u.redo, legacyLibIds: symbols > 0 && named === 0, checks, pcb: sch ? null : pcbEnableFacts(),
    linkedGroup: items.length === 1 && items[0].kind === "group" && !!groupDesignBlockId(items[0].node) };
}
/** Everything selected, pads included: the item ids of selectedIds() plus the board's picked pads as
 *  "footprintId#padIndex" (PCB_PAD_T in KiCad's selection).  Also window.CollabEditor.hooks.selectionKeys(). */
export function selectionKeys(): string[] {
  const ids = selectedIds(); if (isSch()) return ids;
  const P = W.CollabTools && W.CollabTools.pcb; const pads: string[] = P && P.selectedPadKeys ? P.selectedPadKeys() : [];
  return [...ids, ...pads.filter((k) => !ids.includes(k))];
}
E.hooks.selectionKeys = selectionKeys;
/**
 * What PCB_EDIT_FRAME::setupUIConditions' enable conditions read (tables.ts pcbEnableWhy), carried in actionState().pcb;
 * null outside the board editor.
 */
export function pcbEnableFacts(): PcbEnableFacts | null {
  const doc = E.kdoc as KDoc | null; if (!doc || isSch() || (doc as { fpEditor?: boolean }).fpEditor) return null;
  const P = W.CollabTools && W.CollabTools.pcb; const S = P && P.state ? P.state as Record<string, unknown> : {};
  const keys = selectionKeys(); const kinds: string[] = []; let hasLocked = false, hasUnlocked = false, haveNet = false;
  const h = (W.CollabTools.props as { helpers?: { netNameOf?(d: KDoc, n: SNode): string } } | undefined)?.helpers;
  for (const k of keys) {
    if (k.includes("#")) { kinds.push("pad"); const fp = doc.items.get(k.slice(0, k.lastIndexOf("#"))); if (fp) { let lk = false; try { lk = !!(P && P.isLocked && P.isLocked(fp.node)); } catch (e) { lk = false; } if (lk) hasLocked = true; else hasUnlocked = true; } continue; }
    const it = doc.items.get(k); if (!it) continue;
    kinds.push(it.kind);
    let lk = false; try { lk = !!(P && P.isLocked && P.isLocked(it.node)); } catch (e) { lk = false; }
    if (lk) hasLocked = true; else hasUnlocked = true;
    if (!haveNet && it.kind !== "footprint" && h && h.netNameOf) { try { if (h.netNameOf(doc, it.node)) haveNet = true; } catch (e) { /* not connected */ } }
  }
  const ro = E.renderOpts as { objects?: { hide?: Set<string>; opacity?: Record<string, number> } };
  const zonesEnabled = !(ro.objects && ro.objects.hide && ro.objects.hide.has("zones")) && !(ro.objects && ro.objects.opacity && ro.objects.opacity.zones !== undefined && ro.objects.opacity.zones <= 0);
  const busy = !!(S.route || S.draw || S.drag || S.move || S.modTool || S.pedit);
  const hl = S.hlCurrent as string[] | undefined;
  return { kinds, hasLocked, hasUnlocked, haveNet, boardHasItems: doc.items.size > 0, idleNoTool: !busy && store.get().tool.current === "select",
    netHighlightSet: !!(hl && hl.length) || !!S.highlightNet, zonesEnabled, drawingOrRouting: !!(S.route || S.draw) };
}
