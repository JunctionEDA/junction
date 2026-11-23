// editor — GENERATED SOURCE MODULE (split from the former static/app.js; static/dist/editor.js is the esbuild output of web/domains/pcb/editor/index.ts — edit these modules, not the bundle).
import { installDialogs } from "../dialogs/index";
import { openImportGraphics } from "../importgfx/dialog";
import { registerBomView } from "../parts/bomview";
import { installSchNets } from "./schnets";
import "./dom";
import "./appstore";
import "./util";
import "./home";
import "./view";
import "./tools";
import "./selection";
import "./doc";
import "./peers";
import { installCrossProbe } from "./crossprobe";
import "./pointer";
import "./comments";
import "./history";
import "./net";
import "./actions";
import "./panes";
import { installSymbolEditor } from "../symedit";
import "./pcbdialogs";
import { preloadPcbToolsWhenIdle } from "./pcbtools-loader";
import { HANDLERS, dispatchAction } from "./actions";
import { state, store } from "./appstore";
import { closeThread, placeComment } from "./comments";
import { startCursorChat } from "./chat";
import { noteModifiers, refreshCursor } from "./cursors";
import { followHypertext } from "./hypertext-follow";
import { IS_WINDOWS, clickMode, dragKeeps, dragModifier, hasModifier, modifiersState, type ModKeys, type ModOpts } from "./selmodes";
import { renderObjects, snapMm, syncItemsFromDoc, updateGridStatus, applyChanges, enterSheet, openDoc } from "./doc";
import { $ } from "./dom";
import { IS_MAC } from "../../../shared/keys";
import { isPastDragThreshold } from "../tools/drag-threshold";
import { redoCombo } from "./kicad-input";
import { cancelLongPress, candidatesAt, moveLongPress, openClarifyMenu, openContextMenu, schClarifyClick, startLongPress, boardModifierPick, boardSelectPoint, boardSelectionContains, flashSelectionFilter } from "./contextmenu";
import { cancelInteraction, clearAllSelection, markerUnder, rotateFieldMove, startFieldMove, copperUnderBeatsFootprint, copperUnderBeatsPad, installGestures, interactionBusy, pinForClick, fieldForClick, schSelectionContains, registerPointerUp, selectionChanged, selectionHooks, selectionIds, startMove, applyPickMode, selectedAnywhere, mergeBoardSelection, splitBoardSelection } from "./gestures";
import { loadMe, navigate, route } from "./home";
import { sendOp } from "./net";
import { applyTheme, syncSchModes } from "./panes";
import { cursorClick, placeCrosshair, noteMotion } from "./crosshair";
import { installPcbRouting, pcbLayerKey } from "./pcbrouting";
import { installProjectWatch } from "./projectwatch";
import { breakFollow, sendPresence } from "./peers";
import { collapseSelectionTo, drawDrag, drawZoomRect, finishGroupDrag, finishZoomRect, measureCopy, measureDown, measureMove, measureUp, moveGroupDrag, openSelectionProperties, startGroupDrag } from "./pointer";
import { clearSelection, fieldDragMore, pickField, selectedFields, selectedSet, drawBoxSel, drawSelection, fieldLocalDelta, fieldOf, finishBoxSel, groupExpand, hitAny, nearestFootprint, schCands, renderProps, renderPropsInto, hitOpts, finishBoardLasso } from "./selection";
import { E } from "./state";
import "./panels/index";
import { activeModule, commitChanges, commitObservers, deleteSelected, deleteSelection, moduleTool, moveOp, publishUndo, redoLast, redoStack, rotateSelected, runModuleHotkey, selectAll, setTool, toolCtx, undoLast, undoStack, unlockedForEdit } from "./tools";
import { api, closePopover, toast } from "./util";
import { saveTextDocument } from "./projectfile";
import { applyView, cmtPanel, dragG, fitView, isSch, pxPerMm, requestRender, requestRepaint, stage, world, worldMm, zoomBy } from "./view";
import type { ItemSummary, SheetEntry } from "./types";
/** The schematic module's drag in flight (sch-tools S.drag), as far as the app reads it. */
type SchDrag = { moved?: boolean; last: number[]; kind?: string };
import { installLibrary } from "./library";
import { importFootprintFiles, installFpEditHandlers } from "./fpedit";
import { importSymbolLibraries } from "../symedit/dialogs";
import { comboOf, keyHooks, kicadActionAvailable, primesOnHotkey, runKicadAction, runSpecHotkey, shiftComboBound, typingTarget } from "./hotkeys";
import { deleteSelectedField } from "./fieldops";
import { actionState, selectionCount } from "./menu-actions";
import { installTableCells } from "./tablecells";   // last: its imports must not reorder the modules above
import { fontCommitObserver, initFonts } from "./fonts";
import { installViewSwitcher } from "./view-switcher";
import "../mech";   // the board link: outline, holes and keep-outs driven by a part studio (web/domains/pcb/mech)
import "./title";

registerBomView();   // a PCB's bill of materials as a view of its tab (the shell opens it like a document)
import "./cad-usage";   // on a board: the way to the part studios and assemblies that use it
window.CollabApp = { getState: store.get, subscribe: store.subscribe, dispatch: (a) => dispatchAction(a), renderProps: (el) => renderPropsInto(el), selectionCount, actionState };


// ---------- home navigation (the home view is still rendered here) ----------
document.addEventListener("click", (ev) => {
  const nav = (ev.target as Element).closest<HTMLElement>("#home [data-nav]");
  if (nav) { ev.preventDefault(); navigate(nav.dataset.nav === "explore" ? "/gallery" : "/"); }
});

window.addEventListener("popstate", route);

KiCadCanvas.onAssetLoaded = () => requestRender();
initFonts({ doc: () => E.kdoc, send: (changes) => sendOp(changes as never) });
commitObservers.push(fontCommitObserver);


// ---- editing tools (schematic / board modules register on window.CollabTools) ----
// A module: { id, tools: [{ id, label, key, icon (svg inner markup), cursor }],
//   onActivate(toolId, ctx), onPointerDown(ev, mm, ctx) -> handled?, onPointerMove(ev, mm, ctx),
//   onPointerUp(ev, mm, ctx), onKey(key, ev, ctx) -> handled?, drawOverlay(ctx2d, view, ctx),
//   onDocChanged(ctx) }.  Everything a module needs travels in ctx (see toolCtx()).
window.CollabTools = window.CollabTools || {};

/**
 * The active tool's in-flight geometry, in internal units, for the peer overlay: [x1, y1, x2, y2,
 * width] per segment.  The desktop ghosts its own in-flight wires and router legs to us; without
 * this the web direction showed peers a bare cursor until the item was committed.
 */
/** A tool module that streams its in-flight geometry (mm: x1, y1, x2, y2, width per segment). */
type GhostModule = ToolModule & { ghostSegs?: (ctx: ToolCtx) => number[][] | null };
function moduleGhost(mod: GhostModule | null | undefined) {
  if (!mod || typeof mod.ghostSegs !== "function") return null;
  let segs: number[][] = [];
  try { segs = mod.ghostSegs(toolCtx()) || []; } catch (e) { console.warn(e); return null; }
  return segs.map((g) => [Math.round(g[0] * E.IU), Math.round(g[1] * E.IU), Math.round(g[2] * E.IU), Math.round(g[3] * E.IU), Math.round((g[4] || 0.1) * E.IU)]);
}

/**
 * The ghost to attach to a presence message: the module's in-flight geometry while there is any, one empty
 * list when it ends (the "stopped" signal, which bypasses the rate limit) and nothing after that.
 */
let ghostLive = false;
function liveGhost(mod: GhostModule | null | undefined) {
  const g = moduleGhost(mod);
  if (g && g.length) { ghostLive = true; return g; }
  if (ghostLive) { ghostLive = false; return []; }
  return undefined;
}

// wheel, middle / right button, hover and lost-release recovery: KiCad's mouse model (gestures.ts).
// Installed before every other stage listener so it sees each event first.
installGestures(openContextMenu);
installCrossProbe();
selectionHooks.push(() => sendPresence(null));
installViewSwitcher();   // Ctrl+Tab / Shift+Tab: the board's Preset and Viewport switcher (editor/view-switcher.ts)
installTableCells();   // table cells as selectable items and the table edit tool (editor/tablecells.ts)

   // until the user pans/zooms, resizes just refit
new ResizeObserver(() => {
  if (state.view !== "editor") return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (sw && sh && E.lastStageW && (sw !== E.lastStageW || sh !== E.lastStageH)) {
    const w0 = E.lastStageW, h0 = E.lastStageH || sh; E.lastStageH = sh;
    if (!E.viewTouched && (E.kdoc || Object.keys(E.layers).length)) { fitView(); return; }
    // zoom 1 is "the sheet as wide as the stage": keep the scale on screen and the point at the centre where they were
    E.zoom *= w0 / sw; E.panX += (sw - w0) / 2; E.panY += (sh - h0) / 2; world.style.width = sw + "px";
  }
  if (sw) { E.lastStageW = sw; E.lastStageH = sh; }
  applyView();
}).observe(stage);


// ---- pointer interaction ----
stage.addEventListener("contextmenu", (ev) => ev.preventDefault());

// PCB_EDIT_FRAME's m_acceptedExts: a .dxf / .svg dropped on the board opens Import Graphics with that file
// (PCB_ACTIONS::ddImportGraphics).  .kicad_pcb (ddAppendBoard) and images (ddPlaceReferenceImage) have no web action.
const boardTakesFiles = (ev: DragEvent): boolean => !isSch() && !!E.kdoc && !(E.kdoc as KDoc).fpEditor && !E.viewOnly && !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes("Files");
stage.addEventListener("dragover", (ev) => {
  if (!boardTakesFiles(ev)) return;
  ev.preventDefault(); (ev.dataTransfer as DataTransfer).dropEffect = "copy";
});
stage.addEventListener("drop", (ev) => {
  if (!boardTakesFiles(ev)) return;
  ev.preventDefault();   // a file we do not take must not make the browser navigate to it
  const f = Array.from((ev.dataTransfer as DataTransfer).files || []).find((x) => /\.(dxf|svg)$/i.test(x.name)); if (!f) return;
  void f.text().then((text) => openImportGraphics("pcb", { name: f.name, text }));
});

stage.addEventListener("dblclick", (ev) => {
  if (E.boxSel && E.boxSel.open) { finishBoardLasso(); return; }   // SelectPolyArea: evt->IsDblClick( BUT_LEFT ) closes the polygon
  if (!E.kdoc || !window.KDialogs || (E.tool !== "select" && E.tool !== "highlight")) return;
  if ((ev.target as Element).closest("#cmtPanel") || (ev.target as Element).closest("[data-schtools]")) return;
  const [x, y] = worldMm(ev); const ctx = toolCtx();
  // SCH_EDIT_TOOL::Properties on a SCH_MARKER_T: SCH_INSPECTION_TOOL::CrossProbe brings the ERC dialog up on its row
  if (isSch()) { const mk = markerUnder([x, y]); const hk = E.hooks as { ercOpenMarker?: (m: unknown) => void }; if (mk && hk.ercOpenMarker) { hk.ercOpenMarker(mk); return; } }
  // PCB_SELECTION_TOOL: a double-click when the selection is a lone group enters it (and picks the item under the cursor)
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.enterGroupAt && CollabTools.pcb.selectedTopGroup) {
    try { const gid = CollabTools.pcb.selectedTopGroup(ctx); const h = gid ? hitAny([x, y]) : null; if (h && CollabTools.pcb.enterGroupAt(ctx, h.id)) { selectionChanged(); return; } } catch (e) { console.warn(e); }
  }
  if (!isSch() && CollabTools.pcb && CollabTools.pcb.padProperties) {       // a pad first: KiCad opens Pad Properties on a pad
    let pad: { item: KItem; index: number } | null = null;
    try { pad = KiCadCanvas.padAt ? KiCadCanvas.padAt(E.kdoc, x, y) : null; if (!pad && CollabTools.pcb.padAt) pad = CollabTools.pcb.padAt(E.kdoc, x, y); } catch (e) { pad = null; }
    if (pad && pad.item && pad.index !== undefined) { CollabTools.pcb.padProperties(ctx, pad.item, pad.index); return; }
    // the first click picked a track, via, graphic or zone (the board module's selection): its dialog, as pcbnew's double-click
    const ps = CollabTools.pcb.state && CollabTools.pcb.state.sel;
    if (ps && ps.size === 1 && !E.selected && openSelectionProperties()) return;
  }
  if (isSch() && CollabTools.sch && CollabTools.sch.enterGroupAt) {         // a double-click on a group enters it (KiCad), it does not open a dialog
    const g = hitAny([x, y]); try { if (g && CollabTools.sch.enterGroupAt(ctx, g.id)) return; } catch (e) { console.warn(e); }
  }
  // SCH_SELECTION_TOOL picks the SCH_SHEET_PIN_T under the cursor ahead of its sheet: its properties dialog (sch_edit_tool.cpp:3246)
  const spin = (KDialogs as unknown as { schSheetPinAt?: (c: ToolCtx, p: [number, number]) => boolean }).schSheetPinAt;
  if (isSch() && spin && spin(ctx, [x, y])) return;
  const f = KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers);
  if (f) { KDialogs!.openField(ctx, f.item, f.name); return; }
  const best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  if (best) { const it = E.kdoc.items.get(best.id); if (it && it.kind === "sheet" && it.file) { enterSheet(it.file); return; } if (it) KDialogs!.openItem(ctx, it); return; }   // nearestFootprint() picks sheets too
  // KiCad: a double-click on a hierarchical sheet enters it (E opens its properties)
  if (isSch()) { const sh = E.sheets.find((r: SheetEntry) => x >= r.x / E.IU && x <= (r.x + r.w) / E.IU && y >= r.y / E.IU && y <= (r.y + r.h) / E.IU); if (sh) { const it = E.kdoc.items.get(sh.id); if (it && it.file) { enterSheet(it.file); return; } if (it) { KDialogs!.openItem(ctx, it); return; } } }
  const other = hitAny([x, y]); const it = other && E.kdoc.items.get(other.id);
  if (it) { KDialogs!.openItem(ctx, it); return; }
  // SCH_SELECTION_TOOL: a double-click on nothing posts SCH_ACTIONS::properties: over the drawing sheet, Page Settings
  const sp = (KDialogs as unknown as { schProperties?: () => boolean }).schProperties;
  if (isSch() && sp && !E.selection.size && !E.selected) sp();
});

// a press held still over overlapping items opens Clarify Selection (m_disambiguateTimer)
window.addEventListener("pointerdown", (ev) => { if (ev.target instanceof Element && stage.contains(ev.target) && !ev.target.closest("#cmtPanel")) startLongPress(ev); else cancelLongPress(); }, true);
window.addEventListener("pointermove", (ev) => moveLongPress(ev), true);
window.addEventListener("pointerup", () => cancelLongPress(), true);
window.addEventListener("pointercancel", () => cancelLongPress(), true);

// PCB_SELECTION_TOOL::SelectPolyArea: while a board lasso is open, a click adds a corner (a drag adds points as it
// goes), Backspace / Delete take the last one back and a double-click closes the polygon (the dblclick handler above)
window.addEventListener("pointerdown", (ev) => {
  const b = E.boxSel; if (!b || !b.open || ev.button !== 0 || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  const mm = worldMm(ev); b.pts.push(mm); b.cur = mm; drawBoxSel();
  stage.setPointerCapture(ev.pointerId); ev.stopImmediatePropagation(); ev.preventDefault();
}, true);
window.addEventListener("keydown", (ev) => {
  const b = E.boxSel; if (!b || !b.lasso || isSch() || (ev.key !== "Backspace" && ev.key !== "Delete")) return;
  const t = ev.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  if (b.pts.length) b.pts.pop();
  drawBoxSel(); ev.stopImmediatePropagation(); ev.preventDefault();
}, true);

// Alt+click: KiCad's Clarify Selection popup when more than one item is under the cursor (window capture, ahead of the
// tool modules' own stage listeners).  SELECTION_TOOL::setModifiersState: m_skip_heuristics = Alt, never on MS Windows
// (Alt is the system menu's there); with Shift / Ctrl held too the pick is added / toggled / removed (m_additive ...)
window.addEventListener("pointerdown", (ev) => {
  if (ev.button !== 0 || !ev.altKey || IS_WINDOWS || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  // with Shift / Ctrl held too (hasModifier) the press only arms, as any modifier press does: m_skip_heuristics acts in
  // selectPoint on IsClick (the release, below), and a drag draws a box (selectMultiple)
  const ms = modifiersState(ev, modOpts()); if (ms.highlight || hasModifier(ms)) return;
  if (openClarifyMenu(ev, clickMode(ms))) { ev.stopImmediatePropagation(); ev.preventDefault(); }
}, true);

// SCH_SELECTION_TOOL: a click (IsClick: press and release without a drag) on hypertext under the cursor
// (HasHoveredHypertext) follows it and leaves the selection as it was (selCancelled); a drag that starts on it
// selects and moves the item like any other (IsDrag), so the press is not swallowed.
let hyperPress: { href: string; x: number; y: number; t: number; id: number; sel: Set<string>; selected: unknown; selField: unknown; selPins: unknown } | null = null;
window.addEventListener("pointerdown", (ev) => {
  hyperPress = null;
  const hh = E.hyperHover as { id: string; href: string } | null;
  if (!hh || ev.button !== 0 || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || E.tool !== "select" || !isSch() || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  const sch = CollabTools.sch; if (sch && (sch.state.drag || sch.state.carry || sch.state.wire)) return;
  hyperPress = { href: hh.href, x: ev.clientX, y: ev.clientY, t: ev.timeStamp, id: ev.pointerId, sel: new Set(E.selection), selected: E.selected, selField: E.selField, selPins: E.selPins };
}, true);
window.addEventListener("pointermove", (ev) => {
  if (hyperPress && ev.pointerId === hyperPress.id && isPastDragThreshold(ev.clientX - hyperPress.x, ev.clientY - hyperPress.y, ev.timeStamp - hyperPress.t)) hyperPress = null;   // IsDrag
}, true);
window.addEventListener("pointercancel", () => { hyperPress = null; }, true);
window.addEventListener("pointerup", (ev) => {
  const hp = hyperPress; hyperPress = null;
  if (!hp || ev.button !== 0 || ev.pointerId !== hp.id || isPastDragThreshold(ev.clientX - hp.x, ev.clientY - hp.y)) return;
  cancelLongPress();
  // after the stage's own release handling (a press that did not move drops its drag / box): put the selection back
  setTimeout(() => {
    E.boxSel = null; E.drag = null;
    clearSelection(); for (const id of hp.sel) E.selection.add(id);
    E.selected = hp.selected as typeof E.selected; E.selField = hp.selField as typeof E.selField; E.selPins = hp.selPins as typeof E.selPins;
    drawSelection(); renderProps(); renderObjects(); requestRender();
    followHypertext(hp.href, ev);
  }, 0);
}, true);

// SCH_SELECTION_TOOL on IsClick( BUT_LEFT ): CollectHits + narrowSelection.  More than one candidate left after the
// heuristics opens Clarify Selection (selectPoint -> ACTIONS::selectionMenu) and, closed without a pick, leaves the
// selection as it was; hits the Selection Filter rejected all of flash the boxes responsible (HighlightSelectionFilter).
let clarifyPress: { keys: string[]; all: string[]; rejected: string[]; x: number; y: number; t: number; id: number; sel: Set<string>; selected: unknown; selField: unknown; selFields: unknown; selPins: unknown; schSel: string | null; schEnds: Map<string, number> | null } | null = null;
window.addEventListener("pointerdown", (ev) => {
  clarifyPress = null;
  if (ev.button !== 0 || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey || E.tool !== "select" || !isSch() || !E.kdoc || state.view !== "editor" || E.hyperHover) return;
  if (!(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel") || ev.target.closest("[data-schtools]")) return;
  const sch = CollabTools.sch as unknown as { state: { drag?: unknown; carry?: unknown; wire?: unknown; pedit?: unknown; sel?: string | null; selEnds?: Map<string, number> | null } } | undefined;
  if (!sch || sch.state.drag || sch.state.carry || sch.state.wire || E.fdrag || E.boxSel) return;
  const r = schCands(worldMm(ev));
  const rejected = !r.cands.length && r.pre > 0 ? r.rejected : [];
  if (r.cands.length < 2 && !rejected.length) return;
  clarifyPress = { keys: r.cands.map((c) => c.key), all: r.cands.length > 1 ? schCands(worldMm(ev), { skip: true }).cands.map((c) => c.key) : [], rejected, x: ev.clientX, y: ev.clientY, t: ev.timeStamp, id: ev.pointerId,
    sel: new Set(E.selection), selected: E.selected, selField: E.selField, selFields: E.selFields, selPins: E.selPins, schSel: sch.state.sel || null, schEnds: sch.state.selEnds ? new Map(sch.state.selEnds) : null };
}, true);
window.addEventListener("pointermove", (ev) => {
  if (clarifyPress && ev.pointerId === clarifyPress.id && isPastDragThreshold(ev.clientX - clarifyPress.x, ev.clientY - clarifyPress.y, ev.timeStamp - clarifyPress.t)) clarifyPress = null;   // IsDrag
}, true);
window.addEventListener("pointercancel", () => { clarifyPress = null; }, true);
window.addEventListener("pointerup", (ev) => {
  const cp = clarifyPress; clarifyPress = null;
  if (!cp || ev.button !== 0 || ev.pointerId !== cp.id || isPastDragThreshold(ev.clientX - cp.x, ev.clientY - cp.y)) return;
  const sch = CollabTools.sch as unknown as { state: { drag?: unknown; carry?: unknown; wire?: unknown; pedit?: unknown; sel?: string | null; selEnds?: Map<string, number> | null }; select(id: string | null): void } | undefined;
  if (!sch || sch.state.pedit) return;   // the point editor took the press (HasPoint without a modifier)
  if (cp.rejected.length) { flashSelectionFilter(cp.rejected); return; }
  cancelLongPress();
  // after the release has run its course, and after a wire the click auto-started (which cancels the selection)
  setTimeout(() => setTimeout(() => {
    if (sch.state.wire || sch.state.drag || sch.state.carry || E.tool !== "select" || !E.kdoc) return;
    E.boxSel = null; E.drag = null;
    clearSelection(); for (const id of cp.sel) if (E.kdoc.items.has(id)) E.selection.add(id);
    E.selected = cp.selected as typeof E.selected; E.selField = cp.selField as typeof E.selField; E.selFields = cp.selFields as typeof E.selFields; E.selPins = cp.selPins as typeof E.selPins;
    if (cp.schSel && E.kdoc.items.has(cp.schSel)) { sch.select(cp.schSel); sch.state.selEnds = cp.schEnds; }
    drawSelection(); renderProps(); renderObjects(); requestRender();
    schClarifyClick({ clientX: cp.x, clientY: cp.y }, cp.keys, cp.all);
  }, 0), 0);
}, true);

// SCH_SELECTION_TOOL: BUT_AUX1 (the mouse's back button) runs navigateBack, BUT_AUX2 navigateForward
stage.addEventListener("pointerdown", (ev) => {
  if ((ev.button !== 3 && ev.button !== 4) || !isSch() || E.tool !== "select" || !E.kdoc || state.view !== "editor") return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  runKicadAction(ev.button === 3 ? "navigateBack" : "navigateForward");
}, true);
// the browser's own history must not move with them
for (const t of ["mouseup", "auxclick", "mousedown"] as const) stage.addEventListener(t, (ev) => { if ((ev.button === 3 || ev.button === 4) && isSch() && E.kdoc && state.view === "editor") ev.preventDefault(); }, true);
// a live lasso owns the pointer and the keys until it is finished or cancelled
stage.addEventListener("pointerdown", (ev) => {
  const b = E.boxSel as (BoxSelLive | null); if (!b || !b.live) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  if (ev.button === 0) { const mm = worldMm(ev); b.pts.push(mm); b.cur = mm; drawBoxSel(); }
}, true);
stage.addEventListener("dblclick", (ev) => {
  const b = E.boxSel as (BoxSelLive | null); if (!b || !b.live) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  finishBoxSel(ev); requestRender();
}, true);
window.addEventListener("keydown", (ev) => {
  const b = E.boxSel as (BoxSelLive | null); if (!b || !b.live) return;
  const t = ev.target as HTMLElement | null; if (t && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  const undo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === "z";
  if (ev.key === "Backspace" || ev.key === "Delete" || undo) { if (b.pts.length) b.pts.pop(); drawBoxSel(); }   // doDelete / undo: the last point goes
  else if (ev.key === "End" || ev.key === "Enter") { finishBoxSel({ clientX: 0, clientY: 0 }); requestRender(); }   // finishInteractive / cursorDblClick
  else if (ev.key === "Escape") { E.boxSel = null; requestRepaint(); }
  else return;
  ev.stopImmediatePropagation(); ev.preventDefault();
}, true);
type BoxSelLive = { live?: boolean; pts: number[][]; cur: number[] };

/** The schematic selection's grip press (selectionContains( DragOrigin ) without the pressed item being selected). */
function schGripPress(ev: PointerEvent, mm: [number, number]): boolean {
  if (!isSch() || (E.leftDrag || "dragSelected") !== "dragSelected" || !E.kdoc) return false;
  const ids = selectionIds(); if (!ids.length) return schSubGripPress(ev, mm);
  const w = schCands(mm).cands[0] || null;
  // the press's own pick is selected (or is a pin / field of a selected symbol): the ordinary press paths move it
  if (w && w.kind !== "field" && ids.includes(w.item.id)) return false;
  if (!schSelectionContains(mm)) return false;
  const sm = CollabTools.sch as unknown as { state: { sel?: string | null; drag?: unknown }; _?: { pointEditStart?: (c: unknown, mm: number[], ev: unknown) => boolean } } | undefined;
  if (!sm) return false;
  ev.stopImmediatePropagation(); ev.preventDefault();
  // SCH_POINT_EDITOR runs ahead of the selection tool: a press on an edit point of the selected item edits it
  try { if (sm._ && sm._.pointEditStart && sm._.pointEditStart(toolCtx(), mm, ev)) return true; } catch (e) { console.warn(e); }
  // one selection for the drag: the module's own pick and the primary symbol join the set
  if (sm.state.sel) { if (E.kdoc.items.has(sm.state.sel)) E.selection.add(sm.state.sel); sm.state.sel = null; }
  if (E.selected) E.selection.add(E.selected.id);
  E.selField = null; E.selFields = []; E.selPins = [];
  const id = ids[0], it = E.kdoc.items.get(id)!, fp = (E.items as ItemSummary[]).find((f) => f.id === id);
  startGroupDrag(fp ? { id, fp } : { id, item: it }, mm, ev);
  // IsClick instead of IsDrag: selectPoint at the press (or the wire the click auto-starts)
  if (E.drag) { E.drag.clickId = null; E.drag.clickAt = mm; }
  else { stage.setPointerCapture(ev.pointerId); }
  return true;
}

/**
 * selectionContains( DragOrigin ) for a selection of fields or pins alone: each one's HitTest( point, 20 px grip
 * margin ).  A press there (off the sub-item itself) drags it as a press on it would: a field moves, a sheet pin rides
 * its sheet's edge, symbol pins move their symbols (RequestSelection( MovableItems ) promotes them).
 */
function schSubGripPress(ev: PointerEvent, mm: [number, number]): boolean {
  const fields = selectedFields(), pins = E.selPins as { id: string; number: string }[];
  if (!fields.length && !pins.length) return false;
  const sm = CollabTools.sch as unknown as { _?: { candOfKey?: (d: KDoc, k: string) => unknown; candBox?: (d: KDoc, c: unknown) => number[]; beginSheetPinMove?: (c: unknown, id: string, name: string, mm: number[], byPointer: boolean, drag?: boolean) => boolean }; state: { mouseDragMode?: string } } | undefined;
  if (!sm || !sm._ || !sm._.candOfKey || !sm._.candBox) return false;
  const w = schCands(mm).cands[0] || null;
  const own = (k: string) => !!w && w.key === k;
  const m = 20 / Math.max(1e-9, pxPerMm()), within = (b: number[] | null | undefined) => !!b && mm[0] >= b[0] - m && mm[0] <= b[2] + m && mm[1] >= b[1] - m && mm[1] <= b[3] + m;
  const boxOf = (k: string) => { const c = sm._!.candOfKey!(E.kdoc, k); return c ? sm._!.candBox!(E.kdoc, c) : null; };
  // the press's own pick is one of them: the ordinary press paths take it
  if (fields.some((f) => own(f.id + "@field:" + f.name)) || pins.some((p) => own(p.id + "#pin:" + p.number))) return false;
  const f = fields.find((g) => within(boxOf(g.id + "@field:" + g.name)));
  const p = f ? undefined : pins.find((q) => within(boxOf(q.id + "#pin:" + q.number)));
  if (!f && !p) return false;
  ev.stopImmediatePropagation(); ev.preventDefault();
  if (f) {
    const it = E.kdoc.items.get(f.id), pn = it && fieldOf(it, f.name), at = pn && KiCadCanvas.kid(pn, "at"); if (!at || !E.ws || E.ws.readyState !== 1) return true;
    E.fdrag = { id: f.id, name: f.name, startMm: mm, orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], origAt: at.slice(), moved: false, more: fieldDragMore(f) };
    stage.setPointerCapture(ev.pointerId); return true;
  }
  const pin = p!;
  if (E.kdoc.items.get(pin.id)?.kind === "sheet") {
    if (sm._.beginSheetPinMove && sm._.beginSheetPinMove(toolCtx(), pin.id, pin.number, mm, true, sm.state.mouseDragMode !== "move")) stage.setPointerCapture(ev.pointerId);
    return true;
  }
  const parents = Array.from(new Set(pins.map((q) => q.id))).filter((id) => E.kdoc.items.has(id) && E.kdoc.items.get(id)!.kind === "symbol");
  const fp = (E.items as ItemSummary[]).find((x) => x.id === pin.id); if (!fp) return true;
  E.selPins = []; E.selField = null; E.selFields = []; E.selection = new Set(parents); E.selected = fp; drawSelection(); renderProps(); renderObjects();
  startGroupDrag({ id: pin.id, fp }, mm, ev);
  if (E.drag) { E.drag.clickId = null; E.drag.clickAt = mm; } else stage.setPointerCapture(ev.pointerId);
  return true;
}

stage.addEventListener("pointerdown", (ev) => {
  if (ev.button === 0 && E.tool === "select" && E.kdoc && !E.viewOnly && isSch() && !(ev.target as Element).closest("#cmtPanel") && !(ev.target as Element).closest("[data-schtools]") && !hasModifier(modifiersState(ev, modOpts()))
    && CollabTools.sch && !CollabTools.sch.state.drag && !CollabTools.sch.state.carry && !CollabTools.sch.state.wire && !(E.fdrag && E.fdrag.sticky) && E.ws && E.ws.readyState === 1) {
    if (schGripPress(ev, worldMm(ev))) return;
  }
  if (isSch() && E.leftDrag === "select") return;   // MOUSE_DRAG_ACTION::SELECT: a drag always draws a selection box
  if (ev.button !== 0 || E.tool !== "select" || !E.kdoc || E.selection.size < 2 || E.viewOnly) return;
  if (boardArms()) return;   // the board: every plain press arms first (PCB_SELECTION_TOOL::Main), below
  { const ms = modifiersState(ev, modOpts()); if (hasModifier(ms) || ms.highlight) return; }   // a modifier edits the selection (or highlights)
  if (isSch() && CollabTools.sch && CollabTools.sch.state.drag) return;   // a Move / paste is following the cursor: this click drops it (sch-tools)
  const mm = worldMm(ev); let hit = hitAny(mm);
  // PCB_SELECTION_TOOL: DRAG_SELECTED moves the selection when SelectionContains( DragOrigin ), any selected item under
  // the cursor (a selected track beneath a footprint's box or beneath an unselected item included)
  if (!isSch() && (!hit || !E.selection.has(hit.id))) {
    let id: string | undefined; try { id = candidatesAt(mm).find((c) => E.selection.has(c)); } catch (e) { id = undefined; }
    const it = id ? E.kdoc.items.get(id) : null; if (id && it) hit = { id, kind: it.kind, item: it };
  }
  if (!hit || !E.selection.has(hit.id)) return;
  ev.stopImmediatePropagation(); ev.preventDefault();
  // a selection of tracks (or one via) is dragged by the router (PCB_SELECTION_TOOL: routable -> drag45Degree), not moved
  const pm = CollabTools.pcb as unknown as { routableDown?: (e: PointerEvent, p: number[], c: unknown, ids: string[]) => boolean } | undefined;
  if (!isSch() && pm && pm.routableDown) { try { if (pm.routableDown(ev, mm, toolCtx(), [...E.selection])) { stage.setPointerCapture(ev.pointerId); return; } } catch (e) { console.warn(e); } }
  // the board with tracks, vias, graphics ... in the selection (footprints too, or not): the press only arms; a drag
  // moves the whole selection (the module's move), a click runs selectPoint, which replaces the selection
  if (!isSch() && [...E.selection].some((id) => { const it = E.kdoc.items.get(id); return !!it && it.kind !== "footprint"; })) {
    boardPress = { mm, client: [ev.clientX, ev.clientY], t: ev.timeStamp, pointerId: ev.pointerId, legacy: true };
    stage.setPointerCapture(ev.pointerId); return;
  }
  startGroupDrag(hit, mm, ev);
}, true);
/**
 * A plain left press on the board with the select tool (PCB_SELECTION_TOOL::Main): nothing is selected or moved by
 * the press itself.  IsClick (released within the drag threshold) runs selectPoint; IsDrag decides by the "left
 * button drag" preference and SelectionContains( DragOrigin ) between a selection area and a move.  `menu`: the drag
 * began on an ambiguous point with nothing selected — the release opens Clarify Selection.
 */
let boardPress: { mm: [number, number]; client: [number, number]; t?: number; pointerId: number; legacy?: boolean; menu?: boolean } | null = null;
/** The board editor's select tool takes its presses through boardPress (the Footprint Editor keeps its own picking). */
function boardArms(): boolean { return !isSch() && E.tool === "select" && !!E.kdoc && E.DOC_TYPE !== "footprint"; }
E.hooks.cancelPress = (): void => { boardPress = null; };
window.addEventListener("pointermove", (ev) => {
  const bp = boardPress; if (!bp || bp.menu || ev.pointerId !== bp.pointerId || !isPastDragThreshold(ev.clientX - bp.client[0], ev.clientY - bp.client[1], bp.t === undefined ? undefined : ev.timeStamp - bp.t)) return;
  boardPress = null;   // IsDrag
  if (bp.legacy) {   // the module moves everything selected from the press point; this move event reaches it next
    const pm = CollabTools.pcb as unknown as { beginMove?: (c: unknown, at: number[], sticky: boolean) => boolean } | undefined;
    if (pm && pm.beginMove) { try { pm.beginMove(toolCtx(), bp.mm, false); } catch (e) { console.warn(e); } }
    return;
  }
  boardDragStart(bp, ev);
}, true);
window.addEventListener("pointerup", (ev) => {
  const bp = boardPress; if (!bp || ev.pointerId !== bp.pointerId) return;
  boardPress = null;
  if (bp.legacy) { clickSelectAt(bp.mm); return; }   // IsClick: selectPoint( ..., false, false, false ) -> ClearSelection, then the pick
  cancelLongPress();
  boardSelectPoint(bp.mm, { clientX: ev.clientX, clientY: ev.clientY });   // IsClick, or the menu a drag from an ambiguous point waited for
}, true);
window.addEventListener("pointercancel", () => { boardPress = null; }, true);
/**
 * A drag of pads on their own (m_AllowFreePads): each pad's position inside its footprint follows the cursor by the
 * snapped delta; the release commits one change per footprint (padDragEnd), Escape puts them back.
 */
type PadDrag = { startMm: number[]; moved: boolean; pads: { id: string; index: number; orig: SNode }[]; /** a Move (M): follows the cursor with no button, the next click drops it */ sticky?: boolean };
function padNode(id: string, index: number): SNode | null {
  const it = E.kdoc && E.kdoc.items.get(id); const P = (window as unknown as { PcbTools?: { padsOf?: (it: KItem) => { node: SNode }[] } }).PcbTools;
  const p = it && P && P.padsOf ? P.padsOf(it)[index] : null; return p ? p.node : null;
}
function startPadDrag(keys: string[], mm: number[]): boolean {
  const pads: PadDrag["pads"] = [];
  for (const k of keys) {
    const h = k.lastIndexOf("#"), id = k.slice(0, h), index = +k.slice(h + 1), it = E.kdoc.items.get(id), n = padNode(id, index), at = n && KiCadCanvas.kid(n, "at");
    if (!it || !at || !unlockedForEdit([id], true).length) continue;
    pads.push({ id, index, orig: at.slice() as SNode });
  }
  if (!pads.length) return false;
  E.pdrag = { startMm: mm, moved: false, pads } as PadDrag; return true;
}
function padDragMove(mm: number[]): void {
  const pd = E.pdrag as PadDrag; if (!pd || !E.kdoc) return;
  pd.moved = true;
  const w = snapMm([mm[0] - pd.startMm[0], mm[1] - pd.startMm[1]]);
  for (const p of pd.pads) {
    const it = E.kdoc.items.get(p.id), n = padNode(p.id, p.index), at = n && KiCadCanvas.kid(n, "at"); if (!it || !at) continue;
    const [ldx, ldy] = fieldLocalDelta(it, w[0], w[1]);
    at[1] = +(KiCadCanvas.num(p.orig[1]) + ldx).toFixed(4); at[2] = +(KiCadCanvas.num(p.orig[2]) + ldy).toFixed(4);
    KiCadCanvas.replaceChange(E.kdoc, it);
  }
  requestRender();
}
function padDragEnd(commit: boolean): void {
  const pd = E.pdrag as PadDrag | null; E.pdrag = null; if (!pd || !E.kdoc || !pd.moved) return;
  const after = new Map<string, { index: number; now: SNode }[]>();
  for (const p of pd.pads) {   // the originals back, then one change per footprint with its pads where they ended up
    const it = E.kdoc.items.get(p.id), n = padNode(p.id, p.index), at = n && KiCadCanvas.kid(n, "at"); if (!it || !at) continue;
    const now = at.slice() as SNode; at.splice(0, at.length, ...p.orig); KiCadCanvas.replaceChange(E.kdoc, it);
    if (commit && JSON.stringify(now) !== JSON.stringify(p.orig)) { const l = after.get(p.id) || []; l.push({ index: p.index, now }); after.set(p.id, l); }
  }
  const changes = [];
  for (const [id, list] of after) {
    const it = E.kdoc.items.get(id); if (!it) continue;
    const node = JSON.parse(JSON.stringify(it.node)) as SNode; const P = (window as unknown as { PcbTools?: { padsOf?: (it: { node: SNode }) => { node: SNode }[] } }).PcbTools;
    const pads = P && P.padsOf ? P.padsOf({ node }) : [];
    for (const { index, now } of list) { const a2 = pads[index] && KiCadCanvas.kid(pads[index].node, "at"); if (a2) a2.splice(0, a2.length, ...now); }
    changes.push(KiCadCanvas.replaceChange(E.kdoc, Object.assign({}, it, { node, geom: [], bbox: null })));
  }
  if (changes.length) commitChanges(changes, pd.pads.length > 1 ? "move pads" : "move pad");
  requestRender();
}
E.hooks.cancelPadDrag = (): boolean => { if (!E.pdrag) return false; padDragEnd(false); return true; };
// EDIT_TOOL::Move (M) on pads picked on their own with "Allow free pads" on: the pads move inside their footprint,
// following the cursor until the next click (FilterCollectorForFreePads keeps the pads instead of their footprint)
E.hooks.startPadMove = (keys: string[], mm: number[]): boolean => { if (!startPadDrag(keys, mm)) return false; (E.pdrag as PadDrag).sticky = true; return true; };
/** MOUSE_DRAG_ACTION (Preferences > Mouse and Touchpad > Left button drag): SELECT, DRAG_SELECTED (the default) or DRAG_ANY. */
function boardDragStart(bp: { mm: [number, number]; client: [number, number]; pointerId: number }, ev: PointerEvent): void {
  const mm = bp.mm, action = (E.leftDrag as string) || "dragSelected";
  const area = (): void => {
    E.boxSel = { start: [mm[0], mm[1]], cur: worldMm(ev), pts: [[mm[0], mm[1]]], lasso: E.selMode === "lasso", add: false, startClient: [bp.client[0], bp.client[1]] };
    drawBoxSel();
  };
  const empty = !selectedAnywhere().size && !E.selField;
  // "if( hasModifier() || dragAction == SELECT || ( m_selection.Empty() && dragAction != DRAG_ANY ) )": a selection area
  if (action === "select" || (empty && action !== "dragAny")) { area(); return; }
  if (empty) {
    // DRAG_ANY with nothing selected: selectPoint( DragOrigin, zoneFilledAreaFilter ), then the move — or the area when nothing is there
    const r = boardSelectPoint(mm, { clientX: bp.client[0], clientY: bp.client[1] }, true);
    if (r === "menu") { boardPress = Object.assign({}, bp, { menu: true }); return; }
    if (!r) { area(); return; }
  } else if (!boardSelectionContains(mm)) { area(); return; }   // the drag does not start on the selection: a new area
  boardMoveSelection(mm, bp.client, ev);
}
/** The drag of the selection from `mm`: the router's drag for a routable selection, else the move (EDIT_TOOL::Move / Drag). */
function boardMoveSelection(mm: [number, number], client: [number, number], ev: PointerEvent): void {
  if (!E.kdoc || E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  const d = E.kdoc as KDoc;
  const ps = CollabTools.pcb && (CollabTools.pcb.state as unknown as { sel: Set<string>; padSel?: string | null; padAlso?: { anchor: string; keys: string[] } | null });
  // FilterCollectorForFreePads: a pad picked on its own moves its footprint, unless "Allow free pads" is on
  // (Preferences > PCB Editor > Editing Options): then the pads move with respect to the rest of their footprint
  if (ps && ps.padSel) {
    const keys = [ps.padSel, ...(ps.padAlso && ps.padAlso.anchor === ps.padSel ? ps.padAlso.keys : [])];
    if ((ps as { allowFreePads?: boolean }).allowFreePads && !selectionIds().length && startPadDrag(keys, mm)) return;
    ps.padSel = null; ps.padAlso = null;
    if (E.selected) E.selection.add(E.selected.id);
    for (const k of keys) { const id = k.slice(0, k.lastIndexOf("#")); if (d.items.has(id)) E.selection.add(id); }
    if (!E.selected || !E.selection.has(E.selected.id)) E.selected = (E.items as ItemSummary[]).find((f) => E.selection.has(f.id)) || null;
    mergeBoardSelection(); selectionChanged();
  }
  const ids = [...selectedAnywhere()].filter((id) => d.items.has(id));
  if (!ids.length) {
    // nothing but fields: they move by themselves
    const fs = selectedFields(), f = fs[0]; const it = f && d.items.get(f.id), pn = it && fieldOf(it, f.name), at = pn && KiCadCanvas.kid(pn, "at");
    if (f && at) E.fdrag = { id: f.id, name: f.name, startMm: mm, orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], origAt: at.slice(), moved: false, more: fieldDragMore({ id: f.id, name: f.name }) };
    return;
  }
  const its = ids.map((id) => d.items.get(id)!);
  if (its.every((it) => it.kind === "footprint")) {
    if (!unlockedForEdit(ids, true).length) return;   // locked footprints are selected but do not follow a drag
    const under = its.find((it) => it.bbox && mm[0] >= it.bbox[0] && mm[0] <= it.bbox[2] && mm[1] >= it.bbox[1] && mm[1] <= it.bbox[3]) || its[0];
    const fp = (E.items as ItemSummary[]).find((f) => f.id === under.id); if (!fp) return;
    if (ids.length === 1) {
      E.selected = fp;
      E.drag = { fp, startMm: mm, curMm: [fp.x / E.IU, fp.y / E.IU], moved: false, grabOff: [mm[0] - fp.x / E.IU, mm[1] - fp.y / E.IU], wires: [], engine: false, clickPin: null, clickPad: null, clickAt: null };
      return;
    }
    for (const id of ids) E.selection.add(id);
    startGroupDrag({ id: fp.id, fp }, mm, ev);
    if (E.drag) E.drag.clickId = null;
    return;
  }
  // tracks, vias, graphics, zones ... (with footprints or not): the board module's drag — the router's for a routable
  // selection ( segments / arcs and at most one via ), the move tool's otherwise
  const pm = CollabTools.pcb as unknown as { dragFrom?: (c: unknown, ids: string[], lead: string | null, mm: number[], client: number[], app: boolean) => boolean } | undefined;
  let lead: string | null = null; try { lead = candidatesAt(mm).find((c) => ids.includes(c)) || null; } catch (e) { lead = null; }
  const app = !ps || ids.some((id) => !ps.sel.has(id));
  if (app) mergeBoardSelection();
  if (pm && pm.dragFrom) { try { pm.dragFrom(toolCtx(), ids, lead, mm, client, app); } catch (e) { console.warn(e); } }
}

stage.addEventListener("pointerdown", (ev) => {
  if ((ev.target as Element).closest("#cmtPanel") || (ev.target as Element).closest("#signinOverlay")) return;
  if ((ev.button === 2 && E.rightDragPan !== false) || (ev.button === 1 && E.middleDragPan !== false) || (ev.button === 0 && E.tool === "pan")) {
    E.pan = { x: ev.clientX - E.panX, y: ev.clientY - E.panY };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (ev.button !== 0) return;
  if (E.fdrag && E.fdrag.sticky) { commitFieldDrag(); ev.preventDefault(); return; }   // the click that drops a field's Move
  if (E.pdrag && (E.pdrag as PadDrag).sticky) { padDragEnd(true); ev.preventDefault(); return; }   // the click that drops a pad Move
  if (E.tool === "zoomtool") { E.zoomRect = { start: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
  if (E.tool === "measure") { measureDown(measurePoint(worldMm(ev), ev), ev); return; }
  if (E.tool === "comment") { placeComment(ev); return; }
  const [x, y] = worldMm(ev);
  const mod = activeModule();
  if (mod && moduleTool(E.tool) && mod.onPointerDown) { if (E.viewOnly && E.tool !== "highlight") { toast("View-only access"); return; } try { if (mod.onPointerDown(ev, [x, y], toolCtx())) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; } } catch (e) { console.warn(e); } }
  // PCB_SELECTION_TOOL::Main: with "Ctrl+click highlights net" (m_CtrlClickHighlight, not in the Footprint Editor) a
  // Ctrl+click (no Shift) runs highlightNet at the click instead of toggling the selection.  Only the click does
  // (evt->IsClick( BUT_LEFT )): m_drag_additive stays Ctrl||Shift, so a Ctrl+drag still draws a box, one that adds
  // (SelectMultiple( area, m_subtractive, m_exclusive_or ) with m_exclusive_or false under this setting)
  if (E.tool === "select" && E.kdoc && modifiersState(ev, modOpts()).highlight) {
    const pm = CollabTools.pcb as unknown as { highlightNetAt?: (c: unknown, at: number[]) => unknown } | undefined;
    if (pm && pm.highlightNetAt) {
      const pst = CollabTools.pcb && (CollabTools.pcb.state as { downHandled?: unknown } | undefined); if (pst) pst.downHandled = ev;
      E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: dragKeeps(ev, modOpts()), mode: dragModifier(ev, false, modOpts()), startClient: [ev.clientX, ev.clientY], clickHighlight: true };
      stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
    }
  }
  // SELECTION_TOOL with a modifier (hasModifier): the press only arms.  A click (IsClick) runs selectPoint with the
  // modifiers on the release (modifierClick), whatever lies under it, and a drag (IsDrag) draws a selection box
  // even when it starts on an item, selected or not (SCH_SELECTION_TOOL / PCB_SELECTION_TOOL: hasModifier() ->
  // selectMultiple), with the drag's own modifiers (m_drag_additive, m_drag_subtractive)
  if (E.tool === "select" && E.kdoc && hasModifier(modifiersState(ev, modOpts()))) {
    const pst = !isSch() && CollabTools.pcb && (CollabTools.pcb.state as { downHandled?: unknown } | undefined); if (pst) pst.downHandled = ev;
    const ms = modifiersState(ev, modOpts());
    E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: dragKeeps(ev, modOpts()), mode: dragModifier(ev, isSch(), modOpts()), startClient: [ev.clientX, ev.clientY],
      modClick: { mode: clickMode(ms)!, ev: { shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, clientX: ev.clientX, clientY: ev.clientY, button: 0, pointerId: ev.pointerId, pointerType: ev.pointerType } } };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (boardArms()) {
    // PCB_SELECTION_TOOL::Main: the press arms; the release (IsClick) selects, a drag (IsDrag) moves the selection or
    // draws a selection area (boardDragStart) — nothing under the press is selected for the length of a drag
    const pst = CollabTools.pcb && (CollabTools.pcb.state as { downHandled?: unknown } | undefined); if (pst) pst.downHandled = ev;
    boardPress = { mm: [x, y], client: [ev.clientX, ev.clientY], t: ev.timeStamp, pointerId: ev.pointerId };
    stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return;
  }
  if (E.tool === "select" && E.kdoc && window.KDialogs) {   // KiCad: a click on a field selects (and drags) the field, not its symbol
    const f = isSch() ? fieldForClick([x, y]) : KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers);
    const won = f && !isSch() && E.hooks.fieldWins ? E.hooks.fieldWins([x, y], f.item.id, f.name, ev) : "field";
    if (won === "menu") { const pst = CollabTools.pcb && (CollabTools.pcb.state as { downHandled?: unknown } | undefined); if (pst) pst.downHandled = ev; ev.preventDefault(); return; }   // doSelectionMenu: the pick comes from the menu
    if (f && won === "field") {
      const wasFieldSel = selectedFields().some((g) => g.id === f.item.id && g.name === f.name);   // DRAG_SELECTED: only a selected field drags
      if (!wasFieldSel && isSch() && E.leftDrag === "dragAny") { clearSelection(); E.selField = { id: f.item.id, name: f.name }; }   // DRAG_ANY: the field under the cursor is picked and dragged
      const wasField = isSch() && E.leftDrag === "select" ? false : isSch() && E.leftDrag === "dragAny" ? true : wasFieldSel;
      if (!wasField && !wasFieldSel) { clearSelection(); E.selField = { id: f.item.id, name: f.name }; }   // a press on one of several selected fields drags them all
      const pst = !isSch() && CollabTools.pcb && (CollabTools.pcb.state as { downHandled?: unknown } | undefined); if (pst) pst.downHandled = ev;   // one item per click: the board module does not pick what lies under the field
      drawSelection(); renderProps(); renderObjects(); requestRender();
      const pn = fieldOf(f.item, f.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (!wasField) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); }
      else if (at && !E.viewOnly && E.ws && E.ws.readyState === 1) { E.fdrag = { id: f.item.id, name: f.name, startMm: [x, y], orig: [KiCadCanvas.num(at[1]), KiCadCanvas.num(at[2])], origAt: at.slice(), moved: false, more: fieldDragMore({ id: f.item.id, name: f.name }) }; stage.setPointerCapture(ev.pointerId); }
      ev.preventDefault(); return;
    }
  }
  let pinPromote: { id: string; number: string } | null = null, pinClick: { id: string; number: string } | null = null;
  if (E.tool === "select" && E.kdoc && isSch() && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    // SCH_SELECTION_TOOL: a pin under the cursor is selected on its own, ahead of its symbol's body
    const pin = pinForClick([x, y]);
    // a sheet pin (SCH_SHEET_PIN) is movable itself: a press on it when selected (or any press with DRAG_ANY) carries
    // it along its sheet's edge while the button is held; otherwise the press selects it
    if (pin && E.kdoc.items.get(pin.id)?.kind === "sheet" && !E.selection.has(pin.id) && !(E.selected && E.selected.id === pin.id)) {
      const was = (E.selPins as { id: string; number: string }[]).some((p) => p.id === pin.id && p.number === pin.number);
      if (!was) { clearSelection(); E.selPins = [pin]; drawSelection(); renderProps(); renderObjects(); requestRender(); }
      const mv = CollabTools.sch && (CollabTools.sch._ as { beginSheetPinMove?: (c: unknown, id: string, name: string, mm: number[], byPointer: boolean, drag?: boolean) => boolean }).beginSheetPinMove;
      if ((was || E.leftDrag === "dragAny") && E.leftDrag !== "select" && mv && !E.viewOnly && mv(toolCtx(), pin.id, pin.number, [x, y], true, (CollabTools.sch!.state as { mouseDragMode?: string }).mouseDragMode !== "move")) { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
      if (!was) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
    }
    if (pin && E.kdoc.items.get(pin.id)?.kind !== "sheet") {
      const was = (E.selPins as { id: string; number: string }[]).some((p) => p.id === pin.id && p.number === pin.number);
      // its symbol is already selected: a drag moves the selection (RequestSelection( MovableItems )), only a click
      // (released where it was pressed) selects the pin on its own
      const symSel = !was && (E.selection.has(pin.id) || (!!E.selected && E.selected.id === pin.id));
      if (symSel) { pinPromote = pin; pinClick = pin; }
      else if (!was && E.leftDrag === "dragAny" && (E.items as ItemSummary[]).some((f) => f.id === pin.id)) {
        // DRAG_ANY: RequestSelection finds no movable item under a pin, so the pin is promoted to its symbol and the drag
        // moves that; the click (no drag) still selects the pin
        clearSelection(); E.selected = (E.items as ItemSummary[]).find((f) => f.id === pin.id)!; pinPromote = pin; pinClick = pin;
      }
      else if (!was) {
        clearSelection(); E.selPins = [pin]; drawSelection(); renderProps(); renderObjects(); requestRender();
        E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId);
        ev.preventDefault(); return;
      }
      // a press on a selected pin moves its symbol: on a drag start SCH_SELECTION_TOOL unselects every selected pin and
      // selects its parent symbol instead (RequestSelection( { SCH_PIN_T } ) -> parents), then runs move; a click
      // without a drag still leaves this pin alone selected
      else {
        const parents = Array.from(new Set((E.selPins as { id: string }[]).map((p) => p.id))).filter((id) => E.kdoc.items.has(id));
        E.selPins = []; const fp = (E.items as ItemSummary[]).find((f) => f.id === pin.id);
        if (parents.length > 1 && fp && !E.viewOnly && E.ws && E.ws.readyState === 1) {
          E.selection = new Set(parents); E.selected = fp; drawSelection(); renderProps(); renderObjects();
          startGroupDrag({ id: pin.id, fp }, [x, y], ev);
          if (E.drag) { E.drag.clickId = null; E.drag.clickPin = pin; }
          ev.preventDefault(); return;
        }
        if (fp) E.selected = fp; pinPromote = pin; pinClick = pin;
      }
    }
  }
  let best = nearestFootprint(x, y, 5 / Math.max(1, E.zoom * 0.6));
  if (pinPromote) { const fp = (E.items as ItemSummary[]).find((f) => f.id === pinPromote!.id); if (fp) best = fp; }
  // DRAG_SELECTED on a board: PCB_SELECTION_TOOL::SelectionContains( DragOrigin ) comes before any new pick.  For a
  // footprint it is FOOTPRINT::HitTest( point, margin ): its bounding box grown by the 20 px grip margin, so a press up
  // to 20 px outside a selected footprint (even on another item) drags the selection
  let gripSelected = false;
  if (!isSch() && E.tool === "select" && E.kdoc && !(best && selectedSet()?.has(best.id))) {
    const sel = selectedSet(), m = 20 / Math.max(1e-9, pxPerMm());
    if (sel) for (const id of sel) {
      const it = E.kdoc.items.get(id); const b = it && it.kind === "footprint" ? it.bbox : null; if (!b) continue;
      if (x >= b[0] - m && x <= b[2] + m && y >= b[1] - m && y <= b[3] + m) { const fp = (E.items as ItemSummary[]).find((f) => f.id === id); if (fp) { best = fp; gripSelected = true; break; } }
    }
  }
  // Board: a click on a pad selects the pad, not its footprint (PCB_SELECTION_TOOL; the footprint is picked by its body)
  let padWasSelected = false;
  if (!isSch() && E.tool === "select" && CollabTools.pcb && CollabTools.pcb.leaveGroupOutside) { try { CollabTools.pcb.leaveGroupOutside([x, y], toolCtx()); } catch (e) { console.warn(e); } }
  // A press on a pad of a footprint that is already selected: SelectionContains( DragOrigin ) holds (the footprint's
  // HitTest takes its pads), so a drag moves the selection; only the click (released where it was pressed) picks the
  // pad, as selectPoint does on the button-up
  let padClick: string | null = null;
  if (!isSch() && E.tool === "select" && best && selectedSet()?.has(best.id)) {
    let pad: { item?: KItem; index?: number } | null = null;
    try { pad = KiCadCanvas.padAt ? KiCadCanvas.padAt(E.kdoc, x, y) : null; } catch (e) { pad = null; }
    const f = store.get().filter as Record<string, boolean>;
    if (pad && pad.item && pad.index !== undefined && f.pads !== false && selectedSet()!.has(pad.item.id)) padClick = `${pad.item.id}#${pad.index}`;
  }
  // a track or via much smaller than the pad under it is what the click is after (GuessSelectionCandidates' size rule)
  if (!isSch() && E.tool === "select" && mod && mod.selectPadAt && !padClick && !gripSelected && !copperUnderBeatsPad([x, y])) {
    const ps = CollabTools.pcb && CollabTools.pcb.state;
    let r: unknown = false;
    try { r = mod.selectPadAt(ev, [x, y], toolCtx()); } catch (e) { console.warn(e); }
    if (r === "box") { E.selection.clear(); E.selected = null; E.selField = null; E.selPins = []; drawSelection(); renderProps(); renderObjects(); requestRender(); startModuleBox(ev, x, y); return; }
    // a press on the selected pad: a move promotes it to its footprint (FilterCollectorForFreePads, allow free pads off)
    padWasSelected = r === true;
    if (ps) ps.padSel = null;
  }
  // Board: a track / via / graphic under the cursor beats a footprint whose only claim is its empty bounding box
  // (KiCad picks the item whose geometry is under the cursor; the footprint wins on its own pads and outline).
  // A press on a footprint that is already selected drags the selection, whatever is under it (DRAG_SELECTED:
  // PCB_SELECTION_TOOL's SelectionContains( DragOrigin ) check comes before any new pick)
  const pressOnSelected = !isSch() && !!best && !!selectedSet()?.has(best.id);
  if (!isSch() && best && !pressOnSelected && E.lastFpHit && (!E.lastFpHit.onGeom || copperUnderBeatsFootprint([x, y])) && mod && mod.onSelectDown && E.tool === "select") {
    try { const r = mod.onSelectDown(ev, [x, y], toolCtx()); if (r) { E.selection.clear(); E.selected = null; E.selField = null; E.selPins = []; drawSelection();   /* the footprint the box reached is dropped, the module's own pick stays (clearSelection would clear it too) */ renderProps(); renderObjects(); if (r === "box") startModuleBox(ev, x, y); else { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); } return; } } catch (e) { console.warn(e); }
  }
  if (!best && mod && mod.onSelectDown) { try { const r = mod.onSelectDown(ev, [x, y], toolCtx()); if (r) { if (r === "box") startModuleBox(ev, x, y); else { stage.setPointerCapture(ev.pointerId); ev.preventDefault(); } return; } } catch (e) { console.warn(e); } }
  if (!best) {
    clearSelection(); drawSelection(); renderProps(); renderObjects();
    if (E.tool === "select" && E.kdoc) { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: dragKeeps(ev, modOpts()), mode: dragModifier(ev, isSch(), modOpts()), startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); }
    return;
  }
  // KiCad's default left drag (MOUSE_DRAG_ACTION::DRAG_SELECTED): with nothing selected a drag draws a selection
  // box even when it starts on a part; only an existing selection moves.  The press still selects, as the click would.
  const hadSelection = !!selectedSet() || padWasSelected;
  // schematic (SCH_SELECTION_TOOL, IsDrag): DRAG_SELECTED moves only when the drag starts on the selection, so a press
  // on a symbol that is not selected draws a box whatever else is selected; SELECT always boxes; DRAG_ANY always drags
  const schBox = isSch() && (E.leftDrag === "select" || (E.leftDrag !== "dragAny" && !pinPromote && !selectedSet()?.has(best.id)));
  if (!E.selection.has(best.id)) E.selection.clear();
  E.selected = best;
  { const g = groupExpand([best.id]); if (g.size > 1) for (const id of g) E.selection.add(id); }   // a click on a group member selects its group (KiCad)
  drawSelection(); renderProps(); renderObjects();
  if ((isSch() ? schBox : !hadSelection) && E.tool === "select") { E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] }; stage.setPointerCapture(ev.pointerId); ev.preventDefault(); return; }
  if (E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  if (!isSch() && !unlockedForEdit([best.id], true).length) return;   // a locked footprint is selected by the click but does not follow a drag
  { const g = groupExpand([best.id]); if (g.size > 1) { E.selection = g; drawSelection(); renderObjects(); startGroupDrag({ id: best.id, fp: best }, [x, y], ev); return; } }   // a group member moves its group
  E.drag = { fp: best, startMm: [x, y], curMm: [best.x / E.IU, best.y / E.IU], moved: false, grabOff: [x - best.x / E.IU, y - best.y / E.IU], wires: [], engine: false, clickPin: pinClick, clickPad: padClick, clickAt: gripSelected ? [x, y] : null };
  // Schematic moves run through sch-tools' connected drag: attached wires stretch (with bends in
  // 90° mode), a pin or junction under a moved pin gets a new wire, no-connects follow — KiCad's drag.
  if (E.kdoc && isSch() && CollabTools.sch && CollabTools.sch.beginDrag) {
    const it = E.kdoc.items.get(best.id);
    try { if (it && CollabTools.sch.beginDrag(toolCtx(), it, [x, y], true)) E.drag.engine = true; } catch (e) { console.warn(e); }
  }
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
});

/** SelectPoint on a pin of the selected symbol: the click (no drag) leaves the pin alone selected. */
function selectPinOnly(pin: { id: string; number: string }): void {
  if (!E.kdoc || !E.kdoc.items.has(pin.id)) return;
  clearSelection(); E.selPins = [pin]; drawSelection(); renderProps(); renderObjects(); requestRender();
}

/**
 * A press the selection's grip margin took (SelectionContains( DragOrigin ): a drag would move the selection) that
 * ends as a click: IsClick runs selectPoint there, which picks what is really under the cursor (or nothing).
 */
function clickSelectAt(mm: [number, number]): void {
  clearAllSelection(false);
  modifierClick(mm, { mode: "add", ev: { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, clientX: 0, clientY: 0, button: 0, pointerId: 1, pointerType: "mouse" } });
  selectionChanged();
}

/** selectPoint on a pad of the selected footprint: the click (no drag) leaves that pad alone selected. */
function selectPadOnly(key: string): void {
  const ps = CollabTools.pcb && CollabTools.pcb.state; if (!E.kdoc || !ps || !E.kdoc.items.has(key.slice(0, key.lastIndexOf("#")))) return;
  clearSelection(); ps.padSel = key; drawSelection(); renderProps(); renderObjects(); requestRender();
}

/** setModifiersState's options here: ctrlClickHighlights() in the board editor (not the Footprint Editor). */
function modOpts(): ModOpts { return { ctrlHighlights: !isSch() && !!E.ctrlClickHighlight && E.DOC_TYPE !== "footprint" }; }

/**
 * SCH_SELECTION_TOOL / PCB_SELECTION_TOOL on IsClick( BUT_LEFT ) with a modifier held: selectPoint( where, m_additive,
 * m_subtractive, m_exclusive_or ) on what the plain click would pick there.  Shift adds, Ctrl (Cmd) toggles, Ctrl+Shift
 * removes; nothing under the cursor leaves the selection as it was.
 */
type ModClick = { mode: "add" | "toggle" | "remove"; ev: ModKeys & { clientX: number; clientY: number; button: number; pointerId: number; pointerType: string } };
function modifierClick(mm: [number, number], mc: ModClick): void {
  if (!E.kdoc) return;
  const [x, y] = mm, mode = mc.mode, ctx = toolCtx(), mod = activeModule();
  const fake = Object.assign({}, mc.ev, { preventDefault() { /* replayed */ }, stopPropagation() { /* replayed */ }, stopImmediatePropagation() { /* replayed */ } }) as unknown as PointerEvent;
  const slop = 5 / Math.max(1, E.zoom * 0.6);
  if (isSch()) {
    const sm = CollabTools.sch as unknown as { state?: { sel?: string | null }; _?: { pickNonSymbol?: (c: unknown, p: number[]) => KItem | null; lineEndAt?: (it: KItem, p: number[], t: number) => 0 | 1 | null; selectThreshold?: (c: unknown) => number } } | undefined;
    // pins: while the selection holds nothing but pins, a pin under the cursor (ahead of its symbol) is what changes
    if (!E.selection.size && !E.selected && !E.selField && !(sm && sm.state && sm.state.sel)) {
      const pin = pinForClick([x, y]);
      if (pin) {
        const pins = E.selPins as { id: string; number: string }[]; const i = pins.findIndex((p) => p.id === pin.id && p.number === pin.number);
        if (mode === "add") { if (i < 0) E.selPins = [...pins, pin]; }
        else if (mode === "remove") { if (i >= 0) E.selPins = pins.filter((_p, j) => j !== i); }
        else E.selPins = i >= 0 ? pins.filter((_p, j) => j !== i) : [...pins, pin];
        selectionChanged(); return;
      }
    }
    // a symbol's field with nothing but fields selected: the field itself joins / leaves the selection (a plain press picks
    // a field ahead of what lies under it, so the modifier click does too)
    if (!E.selection.size && !E.selected && !E.selPins.length && !(sm && sm.state && sm.state.sel)) {
      const f = fieldForClick([x, y]);
      if (f) { pickField({ id: f.item.id, name: f.name }, mode); selectionChanged(); return; }
    }
    // the module's items (wires, labels, junctions, text, graphics, sheets' pins ...) come first, as its own press does
    let hit: KItem | null = null; try { hit = sm && sm._ && sm._.pickNonSymbol ? sm._.pickNonSymbol(ctx, [x, y]) : null; } catch (e) { console.warn(e); }
    if (hit) {
      let end: 0 | 1 | null = null; try { if (sm && sm._ && sm._.lineEndAt && sm._.selectThreshold) end = sm._.lineEndAt(hit, [x, y], sm._.selectThreshold(ctx)); } catch (e) { end = null; }
      applyPickMode(hit.id, mode, end); return;
    }
    let best = nearestFootprint(x, y, slop) as ItemSummary | null;
    // a symbol's field: this selection model keeps fields out of a multi-selection, so its symbol stands in for it
    if (!best) { const f = KiCadCanvas.fieldAt(E.kdoc, x, y, E.hiddenLayers); if (f) best = (E.items as ItemSummary[]).find((q) => q.id === f.item.id) || null; }
    if (best) applyPickMode(best.id, mode);
    return;
  }
  // the board: PCB_SELECTION_TOOL::selectPoint with m_SelectedOnly = m_subtractive (Ctrl+Shift looks only at what is
  // selected under the cursor, so it can take out an item that lies beneath an unselected one)
  if (CollabTools.pcb && CollabTools.pcb.leaveGroupOutside) { try { CollabTools.pcb.leaveGroupOutside([x, y], ctx); } catch (e) { console.warn(e); } }
  if (mode === "remove") {
    const sel = selectedAnywhere(); let ids: string[] = [];
    try { ids = candidatesAt([x, y]).filter((id) => sel.has(id)); } catch (e) { console.warn(e); }
    const fp = nearestFootprint(x, y, slop) as ItemSummary | null; if (!ids.length && fp && sel.has(fp.id)) ids = [fp.id];
    const id = ids[0]; if (!id) return;
    const ps = CollabTools.pcb && (CollabTools.pcb.state as { padSel?: string | null } | undefined);
    if (id.includes("#")) { if (ps && ps.padSel === id) ps.padSel = null; selectionChanged(); return; }
    applyPickMode(id, "remove"); return;
  }
  if (boardArms() && boardModifierPick([x, y], mc.ev, mode)) return;   // collectAtPoint + GuessSelectionCandidates, as the plain click
  const best = nearestFootprint(x, y, slop) as ItemSummary | null;
  // Shift on a pad adds the pad to the pads (and items) already selected
  if (mode === "add" && mod && mod.selectPadAt) { let r: unknown = false; try { r = mod.selectPadAt(fake, [x, y], ctx); } catch (e) { console.warn(e); } if (r) { selectionChanged(); return; } }
  // a track / via / graphic under the cursor beats a footprint whose only claim is its bounding box
  if (mod && mod.onSelectDown && (!best || (E.lastFpHit && (!E.lastFpHit.onGeom || copperUnderBeatsFootprint([x, y]))))) {
    splitBoardSelection();   // the module toggles / adds its own kinds in its own set, then the two join again
    let r: unknown = false; try { r = mod.onSelectDown(fake, [x, y], ctx); } catch (e) { console.warn(e); }
    mergeBoardSelection();
    if (r) { selectionChanged(); return; }
  }
  if (best) applyPickMode(best.id, mode);
}
/** PCB_SELECTION_TOOL::selectMultiple re-reads the modifiers on every event: Shift / Ctrl pressed or let go mid-drag change the mode. */
function boxSelModifiers(ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): void {
  const b = E.boxSel as { add?: boolean; mode?: string | null } | null; if (!b) return;
  b.mode = dragModifier(ev, isSch()); b.add = dragKeeps(ev);
}
for (const t of ["keydown", "keyup"]) window.addEventListener(t, (ev) => { const k = (ev as KeyboardEvent).key; if (E.boxSel && (k === "Shift" || k === "Control" || k === "Meta" || k === "Alt")) { boxSelModifiers(ev as KeyboardEvent); drawBoxSel(); } });
/** DRAG_SELECTED on an item that was not selected: the press picked it (the board module's own pick), a drag draws a box. */
function startModuleBox(ev: PointerEvent, x: number, y: number): void {
  if (E.tool !== "select" || !E.kdoc) return;
  E.boxSel = { start: [x, y], cur: [x, y], pts: [[x, y]], lasso: E.selMode === "lasso", add: false, startClient: [ev.clientX, ev.clientY] };
  stage.setPointerCapture(ev.pointerId); ev.preventDefault();
}

/** Drop a field drag or Move: the original goes back first so the commit records the inverse (undo restores it exactly). */
function commitFieldDrag(): void {
  const fd = E.fdrag; E.fdrag = null; if (!fd || !E.kdoc) return;
  if (!fd.moved) return;
  // every carried field: put the original back, then one change per symbol with all of its fields where they ended up
  const entries = [{ id: fd.id, name: fd.name, orig: fd.orig, origAt: fd.origAt }, ...((fd.more || []) as { id: string; name: string; orig: number[]; origAt?: SNode }[])];
  const after = new Map<string, { name: string; now: SNode }[]>();
  for (const e of entries) {
    const it = E.kdoc.items.get(e.id), pn = it && fieldOf(it, e.name), at = pn && KiCadCanvas.kid(pn, "at"); if (!at) continue;
    const now = at.slice() as SNode, orig = e.origAt || [at[0], e.orig[0], e.orig[1], ...at.slice(3)];
    at.splice(0, at.length, ...orig); KiCadCanvas.replaceChange(E.kdoc, it);
    if (JSON.stringify(now) !== JSON.stringify(orig)) { const l = after.get(e.id) || []; l.push({ name: e.name, now }); after.set(e.id, l); }
  }
  const changes = [];
  for (const [id, list] of after) {
    const it = E.kdoc.items.get(id); if (!it) continue;
    const node = JSON.parse(JSON.stringify(it.node));
    for (const { name, now } of list) { const p2 = fieldOf({ node }, name), a2 = p2 && KiCadCanvas.kid(p2, "at"); if (a2) a2.splice(0, a2.length, ...now); }
    changes.push(KiCadCanvas.replaceChange(E.kdoc, Object.assign({}, it, { node, geom: [], bbox: null })));
  }
  if (changes.length) commitChanges(changes, entries.length > 1 ? "move fields" : "move " + fd.name.toLowerCase());
  requestRender();
}

/**
 * "Pan on mouse movement with key" (input.motion_pan_modifier, WX_VIEW_CONTROLS::onMotion 286-313): whenever the key
 * is held a motion pans the view by the pointer's travel, whatever buttons are down, and the motion still goes on to
 * the tools with the cursor at the pointer's new design position.
 */
function motionPan(ev: PointerEvent): void {
  if (E.motionPanMod && (E.motionPanMod === "alt" ? ev.altKey : E.motionPanMod === "ctrl" ? (IS_MAC ? ev.metaKey : ev.ctrlKey) : ev.shiftKey)) {
    if (E.metaPan) { const dx = ev.clientX - E.metaPan[0], dy = ev.clientY - E.metaPan[1]; if (dx || dy) { E.viewTouched = true; E.panX += dx; E.panY += dy; breakFollow(); applyView(); } }
    E.metaPan = [ev.clientX, ev.clientY];
  } else E.metaPan = null;
}
stage.addEventListener("pointermove", (ev) => {
  // TOOL_MANAGER::DispatchContextMenu: while a menu is open the cursor stays where it was opened (m_menuCursor)
  if (E.contextMenuOpen) return;
  motionPan(ev);
  const mm = worldMm(ev);
  noteMotion(ev);
  E.lastCursorMm = mm; E.lastClient = [ev.clientX, ev.clientY];
  try { stagePointerMove(ev, mm); } finally {
    // GetCursorPosition(): where the crosshair is — the position the active tool forced (ForceCursorPosition: the
    // magnetic snap to a pad, a pin or a wire end, an angle snap line, the moved reference), else the grid-snapped one
    const at = placeCrosshair(mm, forcedCursor()) || snapMm(mm);
    store.slice("viewport", { cursor: [at[0]!, at[1]!] });
  }
});
/**
 * MeasureTool's cursor: PCB_GRID_HELPER::ResolveSnap on the board (grid.SetSnap( !Shift ): Shift turns the object snap
 * off; grid.SetUseGrid( GetGridSnapping() && !DisableGridSnapping() ): Ctrl the grid), forced as the cursor position,
 * with the snap indicator on the anchor it took.  The schematic has no measure tool in KiCad: the grid only.
 */
function measurePoint(mm: number[], ev: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): number[] {
  const pm = !isSch() && E.kdoc ? (globalThis as unknown as { PcbTools?: { snapCursor?: (c: unknown, p: number[], skip: null, mods: object) => { p: number[]; anchor: (number[] & { t?: string }) | null } } }).PcbTools : undefined;
  let at: number[], snap: { p: number[]; t: string } | null = null;
  if (pm && pm.snapCursor) {
    try { const r = pm.snapCursor(toolCtx(), [mm[0]!, mm[1]!], null, { shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey }); at = r.p; if (r.anchor) snap = { p: r.p, t: r.anchor.t || "none" }; }
    catch (e) { console.warn(e); at = ev.ctrlKey || ev.metaKey ? mm.slice() : snapMm(mm); }
  } else at = ev.ctrlKey || ev.metaKey ? mm.slice() : snapMm(mm);
  E.measureCursor = at; E.measureSnap = snap; requestRepaint();
  return at;
}
/** The cursor a module tool holds (VIEW_CONTROLS::ForceCursorPosition), or null when it follows the grid. */
function forcedCursor(): number[] | null {
  if (E.tool === "measure" && E.measureCursor) return E.measureCursor as number[];
  const m = activeModule() as { cursorPos?: (ctx: unknown) => number[] | null } | null;
  if (!m || !m.cursorPos) return null;
  try { const p = m.cursorPos(toolCtx()); return p && isFinite(p[0]!) && isFinite(p[1]!) ? [p[0]!, p[1]!] : null; } catch (e) { console.warn(e); return null; }
}
function stagePointerMove(ev: PointerEvent, mm: [number, number]): void {
  if (E.zoomRect) { drawZoomRect(ev); return; }
  // a lasso appends a point on IsDrag and on a click; with the button up the cursor only stretches the closing edge
  // (the schematic's selectLasso once it is live, the board's SelectPolyArea always)
  if (E.boxSel) { E.boxSel.cur = mm; if (E.boxSel.lasso && (isSch() ? (!E.boxSel.live || !!(ev.buttons & 1)) : !!(ev.buttons & 1))) E.boxSel.pts.push(mm); boxSelModifiers(ev); drawBoxSel(); return; }
  if (E.tool === "measure") { const at = measurePoint(mm, ev); if (E.measure && E.measure.set) measureMove(at, ev.shiftKey); }
  if (E.pan && E.pan.zoom) {   // MOUSE_DRAG_ACTION::ZOOM: scale = exp( dy × zoom_speed × 0.001 ), up zooms in
    const z = E.pan.zoom, d = z.lastY - ev.clientY; z.lastY = ev.clientY;
    const speed = E.wheel && E.wheel.zoomSpeed ? E.wheel.zoomSpeed : 1;
    if (d) { zoomBy(Math.exp(d * speed * 0.001), z.cx, z.cy); breakFollow(); sendPresence(mm); }
    return;
  }
  // the view itself moved in gestures.ts (capture phase); an item being moved, dragged or routed goes on following
  // the cursor while the view slides under it, as in KiCad
  if (E.pan) { sendPresence(mm); if (!interactionBusy()) return; }
  const modM = activeModule();
  if (modM && moduleTool(E.tool) && modM.onPointerMove) { try { modM.onPointerMove(ev, mm, toolCtx()); } catch (e) { console.warn(e); } sendPresence(mm, liveGhost(modM)); return; }
  if (E.pdrag) { padDragMove(mm); sendPresence(mm); return; }
  if (E.fdrag) {
    if (!E.fdrag.moved && (E.fdrag.sticky || isPastDragThreshold((mm[0] - E.fdrag.startMm[0]) * pxPerMm(), (mm[1] - E.fdrag.startMm[1]) * pxPerMm()))) E.fdrag.moved = true;
    if (E.fdrag.moved) {
      const it = E.kdoc && E.kdoc.items.get(E.fdrag.id), pn = it && fieldOf(it, E.fdrag.name), at = pn && KiCadCanvas.kid(pn, "at");
      if (at) {
        // a Move (M) brings the text's own position to the snapped cursor; a held-button drag moves it by the snapped delta
        const sp = E.fdrag.sticky ? snapMm(mm) : null;
        const w = sp ? [sp[0] - E.fdrag.origin[0], sp[1] - E.fdrag.origin[1]] : snapMm([mm[0] - E.fdrag.startMm[0], mm[1] - E.fdrag.startMm[1]]); const [ldx, ldy] = fieldLocalDelta(it, w[0], w[1]);
        at[1] = +(E.fdrag.orig[0] + ldx).toFixed(4); at[2] = +(E.fdrag.orig[1] + ldy).toFixed(4);
        KiCadCanvas.replaceChange(E.kdoc, it);
        for (const m of (E.fdrag.more || []) as { id: string; name: string; orig: number[] }[]) {   // the other selected fields move by the same step
          const it2 = E.kdoc.items.get(m.id), p2 = it2 && fieldOf(it2, m.name), a2 = p2 && KiCadCanvas.kid(p2, "at"); if (!a2) continue;
          const [mx, my] = fieldLocalDelta(it2, w[0], w[1]); a2[1] = +(m.orig[0] + mx).toFixed(4); a2[2] = +(m.orig[1] + my).toFixed(4);
          KiCadCanvas.replaceChange(E.kdoc, it2);
        }
        requestRender();
      }
    }
    sendPresence(mm); return;
  }
  if (!E.drag) { sendPresence(mm, liveGhost(modM)); return; }   // a Move / Drag (M / G) or a paste following the cursor ghosts to peers too
  if (E.drag.group) { moveGroupDrag(mm); sendPresence(mm); return; }
  if (E.drag.engine) {
    const d = CollabTools.sch!.state.drag as SchDrag | null;
    if (!d) { E.drag = null; sendPresence(mm); return; }           // cancelled (Escape) or already dropped
    CollabTools.sch!.moveDrag(toolCtx(), mm);
    if (!d.moved) { sendPresence(mm, liveGhost(modM)); return; }
    E.drag.moved = true; E.drag.curMm = [E.drag.fp.x / E.IU + d.last[0], E.drag.fp.y / E.IU + d.last[1]];
    const nowE = Date.now();
    if (nowE - E.lastLiveMove > 150 && d.kind === "symbol") { E.lastLiveMove = nowE; sendOp([moveOp(E.drag.fp, Math.round(E.drag.curMm[0] * E.IU), Math.round(E.drag.curMm[1] * E.IU))], true); }
    sendPresence(mm, liveGhost(modM)); return;
  }
  if (!E.drag.moved && isPastDragThreshold((mm[0] - E.drag.startMm[0]) * pxPerMm(), (mm[1] - E.drag.startMm[1]) * pxPerMm())) E.drag.moved = true;
  if (!E.drag.moved) return;
  // Keep the grab offset, then snap the item's own anchor to the grid.
  const off = E.drag.grabOff || [0, 0];
  const target = snapMm([mm[0] - off[0], mm[1] - off[1]]);
  E.drag.curMm = target;
  drawDrag();
  if (E.kdoc) {
    KiCadCanvas.applyChange(E.kdoc, moveOp(E.drag.fp, Math.round(target[0] * E.IU), Math.round(target[1] * E.IU)), E.IU);
    for (const w of E.drag.wires) { const p = KiCadCanvas.ptsOf(w.item.node); p[w.index] = [target[0] + w.off[0], target[1] + w.off[1]]; KiCadCanvas.setPts(w.item.node, p); w.item.geom = []; w.item.bbox = null; }
    for (const w of E.drag.wires) KiCadCanvas.replaceChange(E.kdoc, w.item);
    requestRender();
  }
  const now = Date.now();
  if (now - E.lastLiveMove > 150) { E.lastLiveMove = now; sendOp([moveOp(E.drag.fp, Math.round(target[0] * E.IU), Math.round(target[1] * E.IU))], true); }
  // peers see the move itself: the live op above moves their copy, and the presence boxes (peers.ts) carry the
  // footprint's own outline at its position right now — in the units and box definition the desktop draws from
  sendPresence(mm);
}

const onPointerUp = (ev: PointerEvent) => {
  if (E.pan) { E.pan = null; return; }
  if (E.pdrag) { if (!(E.pdrag as PadDrag).sticky) padDragEnd(true); return; }
  if (E.fdrag) { if (!E.fdrag.sticky) commitFieldDrag(); return; }   // a Move (M) drops on the next click instead
  if (E.zoomRect) { finishZoomRect(ev); return; }
  if (E.boxSel && E.boxSel.open) return;   // SelectPolyArea: the polygon stays open until a double-click closes it
  if (E.boxSel && E.boxSel.modClick && !isPastDragThreshold(ev.clientX - E.boxSel.startClient[0], ev.clientY - E.boxSel.startClient[1])) {
    const b = E.boxSel; E.boxSel = null; requestRepaint(); const mc = b.modClick as ModClick;
    if (mc.ev.altKey && !IS_WINDOWS && openClarifyMenu(mc.ev, mc.mode)) return;   // Alt (m_skip_heuristics): every candidate in Clarify Selection
    modifierClick(b.start as [number, number], mc); return;   // IsClick: selectPoint with the modifiers
  }
  // SCH_SELECTION_TOOL::selectLasso: the lasso outlives the button: clicks add points, a double click (or End) selects,
  // Backspace / Delete take the last point back, Esc cancels
  if (E.boxSel && E.boxSel.lasso && isSch() && (E.boxSel.live || isPastDragThreshold(ev.clientX - E.boxSel.startClient[0], ev.clientY - E.boxSel.startClient[1]))) { E.boxSel.live = true; try { stage.releasePointerCapture(ev.pointerId); } catch (e) { /* not captured */ } drawBoxSel(); return; }
  if (E.boxSel) { finishBoxSel(ev); return; }
  if (E.tool === "measure" && ev.button === 0) { measureUp(ev); return; }
  const modU = activeModule();
  if (modU && moduleTool(E.tool) && modU.onPointerUp) { try { modU.onPointerUp(ev, worldMm(ev), toolCtx()); } catch (e) { console.warn(e); } sendPresence(worldMm(ev), liveGhost(modU)); return; }
  if (ev.button !== 0 || !E.drag) return;
  if (E.drag.group) { finishGroupDrag(); return; }
  if (E.drag.engine) {
    const fpE = E.drag.fp, cur = E.drag.curMm, clickId = E.drag.moved ? null : E.drag.clickId, clickPin = E.drag.moved ? null : E.drag.clickPin, clickAtE = E.drag.moved ? null : (E.drag.clickAt as [number, number] | null) || null; E.drag = null; dragG.replaceChildren();
    if (CollabTools.sch!.state.drag) { try { CollabTools.sch!.endDrag(toolCtx(), true); } catch (e) { console.warn(e); } }
    sendPresence(cur, []);
    if (clickId) { collapseSelectionTo(clickId); return; }
    if (clickPin) { selectPinOnly(clickPin); return; }
    if (clickAtE) {   // a grip press released where it was pressed: the click's own selectPoint, or the wire it auto-starts
      const as = CollabTools.sch!._ && (CollabTools.sch!._ as unknown as { autostartAt?: (c: unknown, mm: number[], ev: unknown) => boolean }).autostartAt;
      let started = false; try { started = !!as && as(toolCtx(), clickAtE, { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }); } catch (e) { started = false; }
      if (started) { clearAllSelection(false); selectionChanged(); } else clickSelectAt(clickAtE);
      return;
    }
    if (E.kdoc) syncItemsFromDoc(); E.selected = E.items.find((f: ItemSummary) => f.id === fpE.id) || E.selected; drawSelection(); renderProps(); requestRender();
    return;
  }
  const fp = E.drag.fp, wasMoved = E.drag.moved, wires = E.drag.wires || [], clickPin0 = E.drag.clickPin as { id: string; number: string } | null, clickPad0 = (E.drag.clickPad as string | null) || null, clickAt0 = (E.drag.clickAt as [number, number] | null) || null;
  const nx = Math.round(E.drag.curMm[0] * E.IU), ny = Math.round(E.drag.curMm[1] * E.IU);
  E.drag = null; dragG.replaceChildren();
  sendPresence([nx / E.IU, ny / E.IU], []);
  if (!wasMoved) { if (clickPin0) selectPinOnly(clickPin0); else if (clickPad0) selectPadOnly(clickPad0); else if (clickAt0) clickSelectAt(clickAt0); return; }
  const changes: KChange[] = [];
  if (nx !== fp.x || ny !== fp.y) changes.push(moveOp(fp, nx, ny));
  for (const w of wires) changes.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(E.kdoc, w.item) });
  if (changes.length) {
    // our copy must end where we say it ends: a peer's move of the same item that arrived while the button was
    // down (and the pointer still) would otherwise stay on screen here although the server has ours
    if (E.kdoc && (nx !== fp.x || ny !== fp.y)) KiCadCanvas.applyChange(E.kdoc, moveOp(fp, nx, ny), E.IU);
    sendOp(changes);
    // inverse: put the symbol and the wire ends back
    const inverse: KChange[] = [moveOp({ id: fp.id, x: nx, y: ny }, fp.x, fp.y)];
    for (const w of wires) {   // the undo step: the same wire with this end back where it was
      const node = KiCadCanvas.cloneNode(w.item.node); const p = KiCadCanvas.ptsOf(node).map((q) => q.slice()); p[w.index] = w.orig; KiCadCanvas.setPts(node, p);
      inverse.push({ id: w.item.id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: KiCadCanvas.serializeItem(E.kdoc, Object.assign({}, w.item, { node })) });
    }
    undoStack.push({ label: "move", changes, inverse }); redoStack.length = 0; publishUndo();
  }
  fp.x = nx; fp.y = ny; if (E.kdoc) syncItemsFromDoc(); drawSelection(); renderProps(); requestRender();
};
stage.addEventListener("pointerup", onPointerUp);
// the KICURSOR follows every press, move and release, after the handlers above changed what is going on (cursors.ts)
for (const t of ["pointerdown", "pointermove", "pointerup"] as const) stage.addEventListener(t, (ev) => { noteModifiers(ev); refreshCursor(); });
registerPointerUp(onPointerUp);

// The keyboard belongs to the canvas, as in KiCad: a click on it takes the focus from a panel's field, and when a
// dialog, prompt or popover closes with nothing focused, the focus goes back to it (not to the page).
stage.addEventListener("pointerdown", (ev) => {
  const t = ev.target as Element | null;
  if (t && t.closest && t.closest("input, textarea, select, k-select, button, a, [contenteditable], #cmtPanel")) return;
  if (document.activeElement !== stage) stage.focus({ preventScroll: true });
}, true);
const refocusCanvas = new MutationObserver((recs) => {
  if (state.view !== "editor" || !E.kdoc) return;
  const a = document.activeElement; if (a && a !== document.body && a.isConnected) return;
  if (recs.some((r) => r.removedNodes.length > 0)) stage.focus({ preventScroll: true });
});
refocusCanvas.observe(document.body, { childList: true });
const overlaysRoot = document.getElementById("ui-overlays"); if (overlaysRoot) refocusCanvas.observe(overlaysRoot, { childList: true, subtree: true });   // a click drops an item that follows the cursor after Move


// KiCad's edit actions run SCH_SELECTION_TOOL::RequestSelection: with nothing selected the item under the cursor
// becomes a hover selection for the one action, filtered by the types the action takes, and the action lets go
// of a hover selection when it is done.
const HOVER_KEYS = new Set(["E", "V", "U", "F", "M", "G", "R", "Shift+R", "X", "Y", "D", "Del", "Backspace", "Ctrl+D", "Ctrl+C", "Ctrl+X", "Ctrl+E", "Alt+3", "Ctrl+4"]);
// editValue / editReference / editFootprint: RequestSelection( { SCH_FIELD_T, SCH_SYMBOL_T, SCH_PIN_T } )
const HOVER_SYMBOL_ONLY = new Set(["V", "U", "F"]);
// rotate / mirror and Copy (sch_editor_control.cpp doCopy) clear a hover selection as they return
const HOVER_RELEASE = new Set(["R", "Shift+R", "X", "Y", "Ctrl+C"]);
// EditField and Properties (clearSelection = selection.IsHover() once the dialog closes), Move / Drag
// (finalizeMoveOperation with aUnselect = selection.IsHover()): released when the dialog or the move ends
const HOVER_HOLD = new Set(["E", "V", "U", "F", "M", "G"]);
type SchHoverState = { sel?: string | null; wire?: unknown; carry?: unknown; drag?: unknown; draw?: unknown; pedit?: unknown };
const schToolState = (): SchHoverState | null => CollabTools.sch ? (CollabTools.sch.state as unknown as SchHoverState) : null;
function hoverHeldOnly(id: string): boolean {
  const S = schToolState();
  if (E.selection.size > 1 || (E.selection.size === 1 && !E.selection.has(id))) return false;
  if (S && S.sel && S.sel !== id) return false;
  return E.selection.has(id) || !!(S && S.sel === id) || !!(E.selected && E.selected.id === id);
}
function releaseHover(id: string): void {
  if (!hoverHeldOnly(id)) return;
  clearAllSelection(); const S = schToolState(); if (S && S.sel === id && CollabTools.sch) CollabTools.sch.select(null);
  requestRender();
}
function hoverBusy(): boolean {
  const S = schToolState();
  return !!document.querySelector(".kd-overlay, .klib-overlay, [role='dialog']") || !!E.drag || !!(S && (S.drag || S.carry || S.pedit));
}
// Waits for the action's dialog or move to end; a dialog that is still loading gets a moment to show up.
function releaseHoverWhenDone(id: string, combo: string): void {
  const opened = Date.now(); let seenBusy = false;
  const tick = (): void => {
    if (!hoverHeldOnly(id) && !hoverBusy()) return;                   // something else took the selection
    if (hoverBusy()) { seenBusy = true; setTimeout(tick, 100); return; }
    if (!seenBusy && (combo === "E" || combo === "V" || combo === "U" || combo === "F") && Date.now() - opened < 1500) { setTimeout(tick, 100); return; }
    releaseHover(id);
  };
  setTimeout(tick, 0);
}
function hoverSelect(ev: KeyboardEvent): void {
  if (!isSch() || !E.kdoc || E.tool !== "select" || !E.lastCursorMm) return;
  const combo = comboOf(ev); if (!HOVER_KEYS.has(combo)) return;
  const S = schToolState();
  if (E.selected || E.selection.size || E.selField || E.selPins.length || (S && (S.sel || S.wire || S.carry || S.drag || S.draw))) return;
  const hit = hitAny(E.lastCursorMm, combo === "G" || combo === "M"); if (!hit) return;
  if (HOVER_SYMBOL_ONLY.has(combo) && hit.kind !== "symbol") return;
  if (hit.fp || !CollabTools.sch) toolCtx().setSelection([hit.id]);
  else { CollabTools.sch.select(hit.id); requestRender(); }                    // wires, labels and the rest live in the module's own selection
  // m_duplicateIsHoverSelection: the copy of a hover selection is not left selected once it is placed
  if (combo === "Ctrl+D" && S) { (S as unknown as { dupHover?: boolean }).dupHover = true; setTimeout(() => { (S as unknown as { dupHover?: boolean }).dupHover = false; }, 0); }
  if (HOVER_RELEASE.has(combo)) setTimeout(() => releaseHover(hit.id), 0);
  else if (HOVER_HOLD.has(combo)) releaseHoverWhenDone(hit.id, combo);
}

// A lone selected pin: Properties and Edit Main Fields act on its parent symbol (SCH_EDIT_TOOL::Properties, EditField),
// which stays the pin's afterwards; Move and Drag take the parent symbol as the selection (SCH_MOVE_TOOL).
const PIN_PROMOTE = new Set(["E", "U", "V", "F", "M", "G"]);
function promotePin(ev: KeyboardEvent): boolean | void {
  if (!isSch() || E.selPins.length !== 1 || !E.kdoc || E.tool !== "select") return;
  const combo = comboOf(ev); if (!PIN_PROMOTE.has(combo)) return;
  // a selected sheet pin is moved itself (SCH_MOVE_TOOL: Move / Drag), riding its sheet's edge
  const sp = E.selPins[0] as { id: string; number: string };
  if (E.kdoc.items.get(sp.id)?.kind === "sheet") {
    const mv = CollabTools.sch && (CollabTools.sch._ as { beginSheetPinMove?: (c: unknown, id: string, name: string, mm: number[], byPointer: boolean, drag?: boolean) => boolean }).beginSheetPinMove;
    if ((combo === "M" || combo === "G") && mv && mv(toolCtx(), sp.id, sp.number, (E.lastCursorMm || [0, 0]) as number[], false, combo === "G")) { ev.preventDefault(); return true; }
    return;
  }
  const pin = E.selPins[0] as { id: string; number: string }, fp = (E.items as ItemSummary[]).find((f) => f.id === pin.id); if (!fp) return;
  E.selPins = []; E.selected = fp;
  if (combo === "M" || combo === "G") { drawSelection(); renderProps(); return; }
  setTimeout(() => { if (E.selected && E.selected.id === pin.id && !E.selection.size && !E.selPins.length) { E.selected = null; E.selPins = [pin]; renderProps(); requestRender(); } }, 0);
}
// A footprint field following the cursor (Move): R / Shift+R turn it inside the move (one commit at the drop, as
// EDIT_TOOL::Rotate in the move loop); other edits wait for the drop so no half-moved state is ever committed.  Window
// capture, ahead of the board module's own key handlers; Esc goes on to cancelInteraction.
keyHooks.unshift((ev) => {   // capture phase (hotkeys.ts preemptKey), ahead of the board module's own key handlers
  if (!E.fdrag || isSch() || ev.key === "Escape") return false;   // Esc goes on to cancelInteraction
  const c = comboOf(ev);
  if (c === "R" || c === "Shift+R") { ev.preventDefault(); rotateFieldMove(c === "R"); requestRender(); return true; }
  if (/^(F[1-9]|F1[0-2]|Home|Shift|Control|Alt|Meta| )$/.test(ev.key)) return false;
  ev.preventDefault(); return true;
});
document.addEventListener("keydown", (ev) => {
  if (state.view !== "editor" || typingTarget(ev)) return;              // a field, a dialog or an open menu owns the keyboard
  // A dialog or menu of the project UI (Share…) is open over the editor: it owns the keyboard.
  if (document.querySelector(".hp-scrim, .hp-menu-scrim")) return;
  const k = ev.key;
  if (k === "Escape") { if (store.get().popover) { closePopover(); return; }
    // KiCad's order: Esc first cancels what is in flight (the item goes back, the selection stays),
    // then leaves the tool, and only then clears the selection.
    if (cancelInteraction()) return;
    if (cmtPanel.classList.contains("open")) { closeThread(); return; }
    if (E.tool !== "select") { setTool("select"); return; }
    // PCB_SELECTION_TOOL / SCH_SELECTION_TOOL::Main on Esc: a selection is cleared and nothing else; with none, an
    // entered group is left; only with neither is the net highlight cleared (m_ESCClearsNetHighlight on the board)
    const hadSel = !!selectionIds().length || !!E.selField || !!E.selPins.length
      || (!isSch() && !!(CollabTools.pcb && CollabTools.pcb.state && (CollabTools.pcb.state.padSel || (CollabTools.pcb.state as { escCleared?: unknown }).escCleared === ev)));
    // a schematic's net highlighting belongs to the module's Esc (SCH_SELECTION_TOOL: cleared only with nothing selected)
    const schNetHl = isSch() && !!(CollabTools.sch && (CollabTools.sch.state as { highlight?: unknown }).highlight);
    let leftGroup = false;
    if (!hadSel && isSch() && CollabTools.sch && CollabTools.sch.exitGroup) leftGroup = !!CollabTools.sch.exitGroup();
    if (!hadSel && !isSch() && CollabTools.pcb && CollabTools.pcb.exitGroup) leftGroup = !!CollabTools.pcb.exitGroup(toolCtx());
    clearAllSelection(false);
    if (!hadSel && !leftGroup && !schNetHl && E.highlightIds && (isSch() || E.escClearsHighlight)) { E.highlightIds = null; if (CollabTools.pcb && CollabTools.pcb.state) (CollabTools.pcb.state as { highlightNet?: unknown }).highlightNet = null; }
    dragG.replaceChildren(); selectionChanged(); return; }
  if (E.tool === "measure" && (comboOf(ev) === "Ctrl+C" || k === "Copy")) { ev.preventDefault(); measureCopy(); return; }   // MeasureTool takes ACTIONS::copy (the board module re-posts Ctrl+C as "Copy"): the readout of a live ruler
  // a schematic field selected on its own: Delete hides it, M / G carry it (SCH_EDIT_TOOL::DoDelete, SCH_MOVE_TOOL); a board
  // field goes on to the board module (Delete: "Hide Field") and the Move action (gestures.ts startFieldMove)
  if (isSch() && E.selField && !selectionIds().length && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    if ((k === "Delete" || k === "Backspace") && deleteSelectedField()) { ev.preventDefault(); return; }
    if ((k === "m" || k === "M" || k === "g" || k === "G") && !ev.shiftKey && !E.fdrag && startFieldMove((E.lastCursorMm || [0, 0]) as [number, number])) { ev.preventDefault(); return; }
  }
  if (promotePin(ev)) return;
  hoverSelect(ev);                                                      // SCH_SELECTION_TOOL::RequestSelection: nothing selected -> the item under the cursor
  if ((k === "Delete" || (k === "Backspace" && isSch())) && E.selection.size > 1 && !E.viewOnly) { ev.preventDefault(); deleteSelection(); return; }   // a board's Backspace is Unroute Segment first (the module)
  if ((ev.metaKey || ev.ctrlKey) && (k === "a" || k === "A")) { ev.preventDefault(); selectAll(); return; }
  if ((ev.metaKey || ev.ctrlKey) && (k === "g" || k === "G")) { ev.preventDefault(); HANDLERS.showSearch(); return; }   // ACTIONS::showSearch
  if (pcbLayerKey(ev)) { ev.preventDefault(); return; }               // the board editor's + / - step the active copper layer, as in pcbnew
  if (comboOf(ev) === "Alt+C") { ev.preventDefault(); setTool("comment"); return; }
  if (comboOf(ev) === "Alt+M") { if (startCursorChat()) { ev.preventDefault(); return; } }   // cursor chat (chat.ts): say something at the pointer   // the collab comment tool (C is KiCad's Unfold from Bus)
  // ACTIONS::redo (actions.cpp 294-301): Cmd+Shift+Z on a Mac, Ctrl+Y elsewhere and nothing else; the other
  // combination goes on to the table (a board's Add Filled Zone is Ctrl+Shift+Z off the Mac)
  const redoKey = redoCombo(IS_MAC, { ctrl: ev.metaKey || ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, key: k });
  if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey && (k === "z" || k === "Z")) { ev.preventDefault(); undoLast(); return; }
  if (redoKey) { ev.preventDefault(); redoLast(); return; }
  // The module's menu actions ({id: {label, key, run(ctx) -> handled}}) bind KiCad's default hotkeys after the
  // editor's own fixed keys (undo / redo, select all); an action that reports "not handled" lets the key fall through.
  // M on a board (PCB_ACTIONS::move): footprints alone go through the app's move (each step shows on peers), anything else through the module
  if (!isSch() && (k === "m" || k === "M") && !ev.shiftKey && !ev.metaKey && !ev.ctrlKey && !ev.altKey && E.tool === "select" && startMove("move")) { ev.preventDefault(); return; }
  if (runModuleHotkey(ev)) { ev.preventDefault(); return; }
  const modK = activeModule();
  if (modK && modK.onKey && !ev.metaKey && !ev.ctrlKey) {
    const before = E.tool;
    try {
      if (modK.onKey(k, ev, toolCtx())) {
        ev.preventDefault(); syncSchModes();
        // a board tool the module's own key started is primed at the cursor as runKicadAction primes it (PrimeTool)
        if (E.tool !== before && primesOnHotkey(isSch() ? "sch" : "pcb", E.tool, E.immediateActions !== false, false)) cursorClick(1);
        return;
      }
    } catch (e) { console.warn(e); }
  }
  if ((k === "e" || k === "E") && !ev.metaKey && !ev.ctrlKey && !ev.altKey) { if (openSelectionProperties()) { ev.preventDefault(); return; } }
  // KiCad's default hotkey table (hotkeys.ts): whichever handler, module action or tool implements the action bound to this key
  if (runSpecHotkey(ev)) { ev.preventDefault(); return; }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (!E.selected || E.viewOnly || !E.ws || E.ws.readyState !== 1) return;
  if ((k === "r" || k === "R") && !isSch()) rotateSelected();
  if (k === "Delete" || k === "Backspace") deleteSelected();
});

installSchNets();   // the net highlight kept by name across the hierarchy (editor/schnets.ts)
installSymbolEditor(HANDLERS as unknown as Record<string, (a?: unknown) => void>);   // the Symbol Editor (web/domains/pcb/symedit): showSymbolEditor, editWithLibEdit, editLibSymbolWithLibEdit
installDialogs(HANDLERS);   // Page Settings, Find and Replace, Symbol Fields Table / BOM, Assign Footprints, Schematic Setup, Preferences, groups
installFpEditHandlers(HANDLERS);   // the Footprint Editor's File / Edit / Place / Tools actions and Ctrl+E on the board (editor/fpedit.ts)
store.slice("tool", { handled: Object.keys(HANDLERS) });
installPcbRouting();
installProjectWatch();
installLibrary();   // window.KiCadLibrary + the placeFootprint / library browser actions (editor/library.ts)



// ---------- boot ----------
applyTheme();

(async () => { await loadMe(); route(); })();
// wherever the page started (the projects home included), the board tools are in before a board is likely to be opened
setTimeout(preloadPcbToolsWhenIdle, 2500);

// exposed for tests and tooling (window.CollabEditor.api)
E.hotkeys = { comboOf, runKicadAction, kicadActionAvailable, shiftBound: shiftComboBound };
/**
 * Library files made outside the editors (a plugin that imports vendor parts): symbol libraries and footprints become
 * documents of the project and rows of its library tables.  Paths are relative to the project folder.
 */
async function importLibraryFiles(files: { path: string; text: string }[]): Promise<{ added: string[]; updated: string[]; failed: string[] }> {
  const sym = await importSymbolLibraries(files.filter((f) => /\.kicad_sym$/i.test(f.path)));
  const fp = await importFootprintFiles(files.filter((f) => /\.kicad_mod$/i.test(f.path)));
  // 3D models the footprints name (${KIPRJMOD}/<library>.3dshapes/…): text files (STEP, VRML) kept as project documents
  const models = { added: [] as string[], updated: [] as string[], failed: [] as string[] };
  const project = state.project;
  for (const f of files.filter((x) => /\.(step|stp|wrl)$/i.test(x.path))) {
    if (!project || E.viewOnly) { models.failed.push(f.path); continue; }
    try {
      const have = project.docs.find((d) => d.path === f.path);
      if (have) {
        if (!(await saveTextDocument(have.docId, f.text, { id: "model", kind: "MODIFIED", typeName: "MODEL_FILE", properties: [] } as unknown as KChange))) throw new Error("not saved");
        models.updated.push(f.path);
      } else {
        const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path: f.path, docType: "model3d" }) }) as { docId?: string; path?: string };
        if (!res.docId) throw new Error("no document");
        const r = await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: f.text });
        if (!r.ok) throw new Error(String(r.status));
        if (!project.docs.some((d) => d.docId === res.docId)) project.docs.push({ docId: res.docId, path: res.path || f.path, docType: "model3d" });
        models.added.push(f.path);
      }
    } catch (e) { console.warn(e); models.failed.push(f.path); }
  }
  if (models.added.length && project) store.set({ project: Object.assign({}, project) });
  return { added: [...sym.added, ...fp.added, ...models.added], updated: [...sym.updated, ...fp.updated, ...models.updated], failed: [...sym.failed, ...fp.failed, ...models.failed] };
}
// A 3D model kept in the project, for the 3D viewer and the model report (viewer3d/models.ts): the project path a
// footprint names, without its extension, to where that document's text is read.
(globalThis as { KiCadProjectModel?: (stem: string) => string | null }).KiCadProjectModel = (stem) => {
  const docs = (state.project ? state.project.docs : []).filter((d) => d.docType === "model3d" && /\.(step|stp)$/i.test(d.path));
  const want = stem.toLowerCase();
  let hit = docs.find((d) => d.path.toLowerCase().replace(/\.(step|stp)$/, "") === want);
  if (!hit && (want.startsWith("/") || /^[a-z]:\//.test(want))) {
    // an absolute path from someone's machine: the project file whose own path (from its first real folder on) ends it,
    // at least a folder and a file name deep; the longest such match
    let best = 0;
    for (const d of docs) {
      const own = d.path.toLowerCase().replace(/\.(step|stp)$/, "").replace(/^(?:\.\.\/)+/, "");
      if (own.split("/").length >= 2 && want.endsWith("/" + own) && own.length > best) { best = own.length; hit = d; }
    }
  }
  return hit ? `/api/docs/${hit.docId}/content` : null;
};
/** The project's custom design rules (.kicad_dru) replaced by `text`: the existing rules document, or a new one beside the board. */
async function saveCustomRules(path: string, text: string): Promise<boolean> {
  const project = state.project;
  if (!project || E.viewOnly) return false;
  try {
    const have = project.docs.find((d) => d.docType === "design_rules");
    if (have) {
      if (!(await saveTextDocument(have.docId, text, { id: "rules", kind: "MODIFIED", typeName: "DESIGN_RULES_FILE", properties: [{ name: "text", after: { type: "string", v: text } }] } as unknown as KChange))) return false;
    } else {
      const res = await api(`/api/projects/${project.projectId}/docs`, { method: "POST", body: JSON.stringify({ path, docType: "design_rules" }) }) as { docId?: string; path?: string };
      if (!res.docId) return false;
      const r = await fetch(`/api/docs/${res.docId}/snapshots?seq=0`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: text });
      if (!r.ok) return false;
      if (!project.docs.some((d) => d.docId === res.docId)) project.docs.push({ docId: res.docId, path: res.path || path, docType: "design_rules" });
      store.set({ project: Object.assign({}, project) });
    }
    E.druText = text;        // DRC, the router and the length tuner read the rules from here
    requestRender();
    return true;
  } catch (e) { console.warn(e); return false; }
}

E.api = { importLibraryFiles, saveCustomRules, HANDLERS, applyChanges, applyView, clearSelection, commitChanges, dispatchAction, drawSelection, enterSheet, fitView, hitOpts, nearestFootprint, openDoc, redoLast, renderProps, requestRender, setTool, snapMm, startMove, state, store, toolCtx, undoLast, worldMm };
