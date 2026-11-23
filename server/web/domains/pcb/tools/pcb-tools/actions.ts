// pcb-tools/actions.ts — pcbnew's non-tool commands (pcb.actions): the action table, its dialogs and runAction.
import type { BoardDoc, FormField, PcbChange, PcbCtx, Pt, SelectMove } from "./types";
import type { RouterSettings } from "./router-settings";
import type { MeanderSettings } from "./meander";

/** One board command as menus, hotkeys and app.js run it (extra: menu, tip, check, toggle …). */
export interface PcbAction { id: string; label: string; key: string; run(ctx: PcbCtx): unknown; [extra: string]: unknown }
/** The tuner's settings in mm as Tuning Pattern Properties shows them. */
export type TuneView = ReturnType<typeof tuneSettingsView>;
/** The routing dialogs the editor bundle hands over (pcb.setRoutingDialogs). */
export interface RoutingDialogs {
  routerSettings?(ctx: PcbCtx): void; diffPair?(ctx: PcbCtx): void; customTrackVia?(ctx: PcbCtx): void; layerPair?(ctx: PcbCtx): void; sizes?(ctx: PcbCtx): void;
  tuning?(req: { mode: string; settings: TuneView }, done: (v: TuneView) => void): void;
  /** DIALOG_MOVE_EXACT: `single` picks the item-anchor rotation (EDIT_TOOL::MoveExact), `bbox` the selection's box for the bounds check */
  moveExact?(req: { single: boolean; bbox: number[] | null }, done: (v: MoveExactResult) => void): void;
  /** DIALOG_POSITION_RELATIVE: the selection's anchor; done() with the reference position and the offset */
  positionRelative?(req: { ctx: PcbCtx; selAnchor: Pt }, done: (anchor: Pt, dx: number, dy: number) => void): void;
  /** DIALOG_SWAP_LAYERS over the enabled copper layers */
  swapLayers?(req: { copper: string[] }, done: (map: Record<string, string>) => void): void;
  /** DIALOG_CLEANUP_TRACKS_AND_VIAS */
  cleanup?(req: CleanupRequest): void;
}
/** Move Exactly's answer: a translation, a rotation and what it turns about (an item's anchor, the selection's centre, a point). */
export interface MoveExactResult { dx: number; dy: number; rotation: number; about: "anchor" | "center" | Pt }
/** What the Cleanup Tracks and Vias dialog works with: the filter choices, a dry run, the cleanup itself and the focus on an item. */
export interface CleanupRequest {
  nets: string[]; netclasses: string[]; copper: string[]; activeLayer: string; highlightNet: string | null; currentNetclass: string;
  plan(o: CleanupDialogOpts): { text: string; ids: string[] }[];
  apply(o: CleanupDialogOpts): number;
  focus(ids: string[] | null): void;
}
export interface CleanupDialogOpts { shorts: boolean; vias: boolean; danglingVias: boolean; merge: boolean; dangling: boolean; inPads: boolean; refill: boolean;
  net: string | null; netclass: string | null; layer: string | null; selectedOnly: boolean }
/** RequestSelection's options: the client filter, the lock filter (default on), quiet, and the re-run after Clarify Selection. */
export interface RequestOpts { filter?(it: KItem): boolean; locks?: boolean; quiet?: boolean; rerun?(ctx: PcbCtx): unknown }
import { root } from "../root";
import { appGlobal, editorState, gfxLayers, sizesOf } from "./app-state";
import { ARC_MODE_ACTIONS, arcDrawMode, setArcDrawMode, switchArcMode, syncArcDraw } from "./arcs";
import { arrayChanges } from "./array";
import { addedChange, boardNets, deleteChanges, removedChange, replacedChange } from "./changes";
import { PASTE_LAYERS_MSG, clipGet, clipSet, clipboardText, cursorPoint, duplicateChanges, parseClipboard, pasteChanges, referencePoint, textOfItem } from "./clipboard";
import { connectedRun } from "./connected";
import { boardStatistics, convertChanges, footprintAttrChanges, justifyChanges, segmentToArcChanges, zonePriorityChanges } from "./convert";
import { copperOf, num0, openForm, settingsOf } from "./dialogs";
import { DIM_TYPE } from "./dimensions";
import { pickTwoPoints } from "./dom";
import { angleSnapMode, nextLineMode, setAngleSnap, stepDrawWidth } from "./draw-modes";
import { askText } from "./draw-tools";
import { drc, mm4, netclassName, netclassOf } from "./drc";
import { cycleVia, cycleWidth, sizeUnits, stepLayer } from "./edit-commands";
import { enterGroup, exitGroup, selectedTopGroup, withinEnteredGroup, enteredGroup } from "./group-edit";
import { applySelection, expandGroups, groupChanges, groupMembers, groupMembersChanges, groupOf, isLocked, lockChanges, selectedItems, selectionIds, topParentOf, ungroupChanges, groupNode, parentOf, setLocked } from "./groups";
import { itemAt } from "./guess";
import { hitTestItem } from "./hit";
import { LENGTH_UNCONSTRAINED, TUNE_IU, setTargetLength, setTargetSkew, tuneCopy } from "./meander";
import { idsOnLayer, inspectClearance } from "./msgpanel";
import { connectedCopperIds, netHighlightIds, netInspector, netItemIds, netTable, netlist, ratsnest, selectionNets } from "./netlist";
import { netOf } from "./nets";
import { zoneLayers } from "./nodes";
import { ARC_EDIT_ACTIONS, addCornerChanges, addCornerLabel, arcEditMode, canAddCorner, chamferCornerChanges, chamferCornerLabel, editHandleAt, handleTol, movePointChanges, movePointTitle, nextArcEditMode, peSingleId, removeCornerChanges, removeCornerLabel, setArcEditMode } from "./point-editor";
import { netUnder, padsOf } from "./route-geom";
import { attemptFinish, continueFromEnd, selectLayerAndPlaceVia, setLayer, startWithVia, toggleViaPlacement, undoRouteLeg, viaSpan } from "./route-tool";
import { CM_M45, CM_M90, CM_R45, CM_R90, RM_MARK, RM_SHOVE, RM_WALK, setRouterSettings } from "./router-settings";
import { beginCarryMove, moveTransform } from "./select-move";
import { connectedItemNets, expandConnection, footprintSheetPath, isExpandableGraphicShape, isPadKey, itemPassesFilter, nearestUnconnectedFootprints, netCopperIds, sheetItemIds, unconnectedFootprints, unrouteIds } from "./select-connected";
import { K, S, bind, lastCtx } from "./state";
import { breakTrackChanges, cleanupChanges, cleanupPlan, trackEditChanges, trackLayerChanges, type CleanupOpts } from "./track-edit";
import { ALIGN_COMMIT, mirrorAxisChanges, alignChanges, anchorOf, bboxUnion, distributeChanges, flipChanges, mirrorChanges, moveExactChanges, packNodes, positionRelativeChanges, rotateChanges, swapChanges, topLeftAnchor, transformChanges } from "./transforms";
import { isTuningPattern, regenerateTuning, tuneStep, tuningPatternInfo } from "./tuning-patterns";
import { editTuningPattern, selectedTuningPattern, tuningNodeWithSettings } from "./tuning-edit";
import { isTuneTool, tuneMode, tuneUpdate } from "./tuning-tool";
import { clone, fmt, layerOf, r6, widthOf, rotator } from "./util";
import { flipFieldChange, footprintFieldNode, requestField, rotateFieldChange, hideFieldChanges } from "./field-edit";
import { imageInfo } from "./images";
import { imageNode, textNode } from "./nodes";
import { padMemory, typeFromPad } from "./pad-tool";
import { diffPairMarkers, matchedLengthMarkers } from "./dru";
import { sourceZone, zoneDuplicateNode, zoneMergeChanges } from "./zone-modes";
import { zonePriorityAbility } from "./zone-priority";
import { newItemDialogs } from "./assistants";
import { routeSelected, unrouteSegment, cancelCurrentItem } from "./route-selected";
import { optimizeSelected } from "./optimize-selected";
import { cycleLayerPairPresets, setSnapMode } from "./snap-pairs";
import { copyWithReference, interactiveOffset, moveIndividually, moveWithReference, skipMoveItem } from "./ref-move";

// ---------------------------------------------------------------- actions: pcbnew's non-tool commands
export const VIA_SIZES = [[0.6, 0.3], [0.8, 0.4], [1.0, 0.5], [1.2, 0.6], [1.6, 0.8]];
export const ACTIONS: Record<string, PcbAction> = {};
export function act(id: string, label: string, key: string, run: (ctx: PcbCtx) => unknown, extra?: Record<string, unknown>) { ACTIONS[id] = Object.assign({ id, label, key, run }, extra || {}); return ACTIONS[id]; }
export const alias = (id: string, of: string, label?: string, key?: string) => { ACTIONS[id] = Object.assign({}, ACTIONS[of], { id, label: label || ACTIONS[of].label, key: key || ACTIONS[of].key }); };
export function runAction(id: string, ctx: PcbCtx) { const a = ACTIONS[id]; if (!a) return false; bind(ctx); try { return !!a.run(ctx); } catch (e) { if (typeof console !== "undefined") console.warn(e); ctx.toast(`${a.label} failed: ${(e as Error).message}`); return true; } }
export const canEdit = (ctx: PcbCtx) => { if (ctx.viewOnly) { ctx.toast("View-only access"); return false; } return true; };
export const needSel = (ctx: PcbCtx, what?: string) => { const ids = selectionIds(ctx); if (!ids.size) { ctx.toast(what || "Select something first"); return null; } return ids; };
export const commitSel = (ctx: PcbCtx, changes: KChange[], label: string, keep?: boolean) => { if (!changes.length) { ctx.toast(`${label}: nothing to change`); return true; } ctx.commit(changes, label); if (keep !== false) ctx.requestRender(); return true; };
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export function highlightIds(ctx: PcbCtx, ids: Set<string> | null, nets?: Iterable<string>) { if (ctx.setHighlight) ctx.setHighlight(ids && ids.size ? new Set(ids) : null, nets); }
// Line Modes (BOARD_EDITOR_CONTROL::ChangeLineMode) and lineModeNext (Shift+Space)
act("lineModeFree", "Line Modes", "", (ctx: PcbCtx) => { setAngleSnap(ctx, "free"); return true; });
act("lineMode90", "Line Modes", "", (ctx: PcbCtx) => { setAngleSnap(ctx, "90"); return true; });
act("lineMode45", "Line Modes", "", (ctx: PcbCtx) => { setAngleSnap(ctx, "45"); return true; });
act("lineModeNext", "Line Modes", "Shift+Space", (ctx: PcbCtx) => { setAngleSnap(ctx, nextLineMode(angleSnapMode())); return true; });
act("incWidth", "Increase Line Width", "Ctrl++", (ctx: PcbCtx) => stepDrawWidth(ctx, 1));
act("decWidth", "Decrease Line Width", "Ctrl+-", (ctx: PcbCtx) => stepDrawWidth(ctx, -1));
// clipboard
// EDIT_TOOL::copyToClipboard / cutToClipboard: the selection, or the item under the cursor (a hover selection);
// the reference point is the anchor nearest the cursor.  KiCad writes "Selection copied" to the status bar only.
/**
 * CLIPBOARD_IO::SaveSelection's conversions in the board editor: a footprint field is copied as a board text (its
 * position, layer, attributes and draw rotation; ${VALUE} / ${REFERENCE} replaced by the footprint's own), a pad
 * picked on its own is wrapped in a new footprint at the pad's position.  Returns the nodes (board coordinates),
 * their anchors and the field they came from, or null when the selection holds neither.
 */
export function copyExtras(ctx: PcbCtx, cursor: Pt | null): { nodes: SNode[]; pts: Pt[]; field: { id: string; name: string } | null } | null {
  const doc = ctx.doc; if (!doc || doc.fpEditor) return null;
  const nodes: SNode[] = [], pts: Pt[] = [];
  const keys = S.padSel ? [S.padSel].concat(S.padAlso && S.padAlso.anchor === S.padSel ? S.padAlso.keys.filter((k) => k !== S.padSel) : []) : [];
  for (const key of keys) {
    const i = key.lastIndexOf("#"), fp = doc.items.get(key.slice(0, i)); if (!fp || fp.kind !== "footprint") continue;
    const info = padsOf(fp)[+key.slice(i + 1)], src = K.kids(fp.node, "pad")[+key.slice(i + 1)]; if (!info || !src) continue;
    const pad = clone(src); const a = K.kid(pad, "at"); if (a) { a[1] = 0; a[2] = 0; }
    nodes.push(["footprint", "", ["layer", "F.Cu"], ["uuid", K.newUuid()], ["at", r6(info.x), r6(info.y)], pad]); pts.push([info.x, info.y]);
  }
  if (nodes.length) return { nodes, pts, field: null };
  const f = requestField(ctx, cursor); if (!f) return null;
  const fp = doc.items.get(f.id)!; const fn = footprintFieldNode(fp.node, f.name); const fa = fn && K.kid(fn, "at"); if (!fn || !fa) return null;
  const [fx, fy, frot] = K.atOf(fp.node); const [rx, ry] = rotator(frot || 0)(K.num(fa[1]), K.num(fa[2])); const x = r6(fx + rx), y = r6(fy + ry);
  let text = K.str(fn[2]);
  const own = (name: string) => { const n = footprintFieldNode(fp.node, name); return n ? K.str(n[2]) : ""; };
  if (text === "${VALUE}") text = own("Value"); else if (text === "${REFERENCE}") text = own("Reference");
  const node: SNode = ["gr_text", text, ["at", x, y, fa.length > 3 ? K.num(fa[3]) : 0]];
  const layer = K.kid(fn, "layer"); node.push(layer ? clone(layer) : ["layer", "F.SilkS"], ["uuid", K.newUuid()]);
  const eff = K.kid(fn, "effects"); if (eff) { const e = clone(eff); const h = e.indexOf("hide"); if (h > 0) e.splice(h, 1); const hk = K.kid(e, "hide"); if (hk) e.splice(e.indexOf(hk), 1); node.push(e); }
  return { nodes: [node], pts: [[x, y]], field: { id: f.id, name: f.name } };
}
/** BestDragOrigin over the copied items and the converted ones: the anchor nearest the cursor. */
function copyReference(doc: BoardDoc, ids: string[], pts: Pt[], cursor: Pt): Pt {
  let best: Pt | null = ids.length ? referencePoint(doc, ids, cursor) : null, bd = best ? Math.hypot(best[0] - cursor[0], best[1] - cursor[1]) : Infinity;
  for (const p of pts) { const d = Math.hypot(p[0] - cursor[0], p[1] - cursor[1]); if (d < bd) { bd = d; best = p; } }
  return best || cursor;
}
act("copy", "Copy", "Ctrl+C", (ctx: PcbCtx) => {
  const cur = cursorPoint(ctx); const extra = copyExtras(ctx, ctx.cursor ? ctx.cursor.slice() : cur);
  if (extra) { const ids = Array.from(selectionIds(ctx)); clipSet(ctx, clipboardText(ctx.doc, ids, copyReference(ctx.doc, ids, extra.pts, cur), extra.nodes)); return true; }
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("copy", c) }); if (!sel) return true;
  clipSet(ctx, clipboardText(ctx.doc, sel.ids, referencePoint(ctx.doc, sel.ids, cursorPoint(ctx)))); endHover(ctx, sel); return true;
});
act("cut", "Cut", "Ctrl+X", (ctx: PcbCtx) => {
  if (S.move) return true;   // doMoveSelection: ACTIONS::cut while moving is wxBell
  if (!canEdit(ctx)) return true;
  const cur = cursorPoint(ctx); const extra = copyExtras(ctx, ctx.cursor ? ctx.cursor.slice() : cur);
  if (extra) {   // a field is hidden, never removed (EDIT_TOOL::DeleteItems); a board's pad stays with its footprint
    const ids = Array.from(selectionIds(ctx)); clipSet(ctx, clipboardText(ctx.doc, ids, copyReference(ctx.doc, ids, extra.pts, cur), extra.nodes));
    const ch: PcbChange[] = ids.length ? deleteChanges(ctx.doc, ids) : [];
    if (extra.field) ch.push(...hideFieldChanges(ctx.doc, extra.field));
    if (ch.length) { ctx.commit(ch, "Cut"); applySelection(ctx, []); }
    return true;
  }
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("cut", c) }); if (!sel) return true;
  clipSet(ctx, clipboardText(ctx.doc, sel.ids, referencePoint(ctx.doc, sel.ids, cursorPoint(ctx))));
  ctx.commit(deleteChanges(ctx.doc, sel.ids), "Cut"); applySelection(ctx, []); return true;
});
/** ADVANCED_CFG::m_MaxPastedTextLength: longer clipboard text asks before it becomes a text item. */
export const MAX_PASTED_TEXT_LENGTH = 100;
/**
 * PCB_CONTROL::placeBoardItems for new items: with a group entered, each pasted groupable item that has no parent
 * group joins it (the group is modified in the same commit); the items PCB_CONTROL selects are selected and all of
 * them hang on the cursor by the reference point until a click places them.  A cancelled paste puts the group back.
 */
function placePasted(ctx: PcbCtx, changes: PcbChange[], ids: string[], select: string[], label: string, origin: Pt) {
  const doc = ctx.doc; const all = changes.slice(); let restore: { id: string; node: SNode }[] | undefined;
  const eg = enteredGroup(doc), g = eg ? doc.items.get(eg) : null;
  if (g && select.length) { restore = [{ id: g.id, node: clone(g.node) }]; all.push(...groupMembersChanges(doc, g, select, [])); }
  ctx.commit(all, label, { tentative: true }); applySelection(ctx, select); beginCarryMove(ctx, { placing: ids.slice(), restore, origin });
  // recordPastedItems: a pasted pad becomes the pad tool's master of its type once the paste is placed
  if (doc.fpEditor && S.move && S.move.placing) {
    const prev = S.move.after;
    S.move.after = (placed: boolean, committed: boolean) => {
      if (prev) prev(placed, committed);
      if (placed) for (const id of ids) { const it = ctx.doc.items.get(id); const t = it && it.kind === "pad" ? typeFromPad(it.node) : null; if (t) { padMemory.lastType = t; padMemory.lastByType[t] = id; } }
    };
  }
}
/** The clipboard held no board items: its text becomes a PCB_TEXT on the active layer, placed like a paste ("Paste Text"). */
function pasteTextItem(ctx: PcbCtx, text: string) {
  const go = () => {
    const at = cursorPoint(ctx); const c = addedChange(ctx.doc, textNode(text, at[0], at[1], ctx.activeLayer || S.layer));
    placePasted(ctx, [c], [c.id], [c.id], "Paste Text", at);
  };
  if (text.length > MAX_PASTED_TEXT_LENGTH) openForm({ title: "Confirmation", width: 420, fields: [{ type: "note", value: "Pasting a long text text string may be very slow.  Do you want to continue?" }], apply: () => { go(); } });
  else go();
}
/** No text on the clipboard: an image there becomes a PCB_REFERENCE_IMAGE on the active layer, placed the same way. */
function pasteImageItem(ctx: PcbCtx) {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (!nav || !nav.clipboard || typeof nav.clipboard.read !== "function") return;
  nav.clipboard.read().then(async (list) => {
    for (const item of list) {
      const type = item.types.find((t) => t === "image/png") || item.types.find((t) => t === "image/jpeg"); if (!type) continue;
      const bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer()); if (!bytes.length || !imageInfo(bytes)) continue;
      let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      bind(ctx); const at = cursorPoint(ctx); const c = addedChange(ctx.doc, imageNode(at[0], at[1], btoa(bin), ctx.activeLayer || S.layer));
      placePasted(ctx, [c], [c.id], [c.id], "Paste Text", at); return;
    }
  }, () => { /* the clipboard cannot be read: nothing to paste */ });
}
export function pasteAt(ctx: PcbCtx, opts: { annotations: string; clearNets?: boolean }) {
  clipGet(ctx, (text: string) => {
    if (!text) { pasteImageItem(ctx); return; }
    if (!parseClipboard(text)) { pasteTextItem(ctx, text); return; }
    const at = cursorPoint(ctx); const r: { changes: PcbChange[]; ids: string[]; select?: string[]; pruned?: boolean } = pasteChanges(ctx.doc, text, at, opts);
    if (r.pruned) ctx.toast(PASTE_LAYERS_MSG);
    if (!r.changes.length) return;
    // EDIT_TOOL::Paste: the pasted items hang on the cursor by their reference point until a click places them
    placePasted(ctx, r.changes, r.ids, r.select || r.ids, "Paste", at);
  });
  return true;
}
// PCB_CONTROL::Paste: a plain paste keeps the references (PASTE_MODE::KEEP_ANNOTATIONS); Paste Special asks
// (DIALOG_PASTE_SPECIAL: the three reference modes, KEEP preselected, and "Clear net assignments")
act("paste", "Paste", "Ctrl+V", (ctx: PcbCtx) => canEdit(ctx) && pasteAt(ctx, { annotations: "keep" }));
act("pasteSpecial", "Paste Special…", "Ctrl+Shift+V", (ctx: PcbCtx) => canEdit(ctx) && openForm({ title: "Paste Special", width: 460, fields: [
  { k: "annotations", label: "Reference Designators", type: "radio", value: "keep", options: [["unique", "Assign unique reference designators to pasted symbols", "Finds the next available reference designator for any designators that already exist in the design."], ["keep", "Keep existing reference designators, even if they are duplicated"], ["clear", "Clear reference designators on all pasted symbols", "Replaces reference designators with 'REF**'."]] },
  { k: "clearNets", label: "Clear net assignments", type: "check", value: false, tip: "Remove the net information from all connected items before pasting" }],
  apply: (v: { annotations: string; clearNets: boolean }) => { pasteAt(ctx, { annotations: v.annotations, clearNets: !!v.clearNets }); } }));
/** EDIT_TOOL::Duplicate's DisplayToolMsg: "Duplicated %d item(s)" in the status bar, counting the top-level copies. */
export function duplicatedMsg(ctx: PcbCtx, ids: string[]) {
  const n = ids.filter((id) => !topParentOf(ctx.doc, id) || !ids.includes(topParentOf(ctx.doc, id)!.id)).length;
  if (ctx.setStatus) ctx.setStatus(`Duplicated ${n} item(s)`);
}
act("duplicate", "Duplicate", "Ctrl+D", (ctx: PcbCtx) => {
  if (S.move) return true;   // doMoveSelection: ACTIONS::duplicate while moving is wxBell
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("duplicate", c) }); if (!sel) return true;
  // EDIT_TOOL::Duplicate: the copies follow the cursor from where the originals are; a click places them (one
  // "Duplicate" step), Escape drops them; a hover selection is not kept afterwards
  const r = duplicateChanges(ctx.doc, sel.ids); if (!r.changes.length) return true;
  ctx.commit(r.changes, "Duplicate", { tentative: true }); applySelection(ctx, r.ids); duplicatedMsg(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice(), restore: r.restore, hover: sel.hover }); return true;
});
act("duplicateIncrement", "Duplicate and Increment", "Ctrl+Shift+D", (ctx: PcbCtx) => {
  if (S.move) return true;
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("duplicateIncrement", c) }); if (!sel) return true;
  const r = duplicateChanges(ctx.doc, sel.ids, null, { increment: true }); if (!r.changes.length) return true;
  ctx.commit(r.changes, "Duplicate", { tentative: true }); applySelection(ctx, r.ids); duplicatedMsg(ctx, r.ids); beginCarryMove(ctx, { placing: r.ids.slice(), restore: r.restore, hover: sel.hover }); return true;
});
// EDIT_TOOL::copyToClipboardAsText: the selection or the item under the cursor (a hover selection is cleared), nothing
// filtered and nothing said; texts, fields, dimensions, text boxes and tables give their text, trimmed, one per line,
// and the clipboard is left alone when there is none
act("copyAsText", "Copy as Text", "Ctrl+Shift+C", (ctx: PcbCtx) => {
  const fr = requestField(ctx, ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx));
  if (fr) { const f = footprintFieldNode(ctx.doc.items.get(fr.id)!.node, fr.name); const t = f ? K.str(f[2]).trim() : ""; if (t) clipSet(ctx, t); return true; }
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("copyAsText", c) }); if (!sel) return true;
  const texts = sel.ids.map((id) => textOfItem(ctx.doc.items.get(id)!).trim()).filter(Boolean);
  endHover(ctx, sel); if (texts.length) clipSet(ctx, texts.join("\n")); return true;
}, { tip: "Copy selected item(s) to clipboard as text" });
// selection
/** The pads picked on their own ("footprintId#index"): PCB_PAD_T items of m_selection. */
const padSelKeys = (): string[] => (S.padSel ? [S.padSel, ...(S.padAlso && S.padAlso.anchor === S.padSel ? S.padAlso.keys.filter((k) => k !== S.padSel) : [])] : []);
/** itemPassesFilter( item, true ) under the Selection Filter pane, for the connection walks. */
const walkFilter = (ctx: PcbCtx) => (it: KItem, pad?: boolean) => itemPassesFilter(ctx.doc, ctx.selFilter, it, { pad, multi: true });
/** itemIsSelectableAsConnected: inside the entered group, or outside any group (a generator's members count). */
const walkScope = (ctx: PcbCtx) => (it: KItem) => { if (S.enteredGroup && ctx.doc.items.has(S.enteredGroup)) return withinEnteredGroup(ctx.doc, [it.id]).length > 0; const par = topParentOf(ctx.doc, it.id); return !par || par.kind === "generated"; };
/**
 * PCB_SELECTION_TOOL::selectCursor: with nothing selected (or aForceSelect) the item under the cursor becomes the
 * selection (selectPoint: Clarify Selection asks between several, and the action runs again on the pick).  Returns
 * the selection (pads on their own as "footprintId#index"), or null when there is none.  No message either way.
 */
function selectCursor(ctx: PcbCtx, rerun: (c: PcbCtx) => unknown, force?: boolean, client?: (ids: string[]) => string[]): string[] | null {
  let ids = Array.from(selectionIds(ctx)).concat(padSelKeys());
  if (ids.length && !force) return ids;
  if (force) { applySelection(ctx, []); S.padSel = null; S.padAlso = null; }
  const at = ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx);
  let cands = cursorCandidates(ctx, at); if (client) cands = client(cands);
  if (!cands.length) return null;
  if (cands.length > 1 && typeof ctx.clarify === "function") { ctx.clarify(cands, (fresh) => { rerun(fresh || ctx); }); return null; }
  ids = applySelection(ctx, [cands[0]]);
  return ids.length ? ids : null;
}
/** connectedItemFilter: one BOARD_CONNECTED_ITEM per net; everything else goes. */
const connectedItemFilter = (ctx: PcbCtx) => (ids: string[]) => {
  const nets = new Set<string>(), out: string[] = [];
  for (let i = ids.length - 1; i >= 0; i--) {
    const it = ctx.doc.items.get(ids[i]); if (!it || !(it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone" || (/^gr_/.test(it.kind) && K.kid(it.node, "net")))) continue;
    const n = netOf(it.node), key = n.name || String(n.code); if (nets.has(key)) continue; nets.add(key); out.unshift(ids[i]);
  }
  return out;
};
/** Hand back a selection that may hold pad keys: the items through applySelection, the pads stay as they were picked. */
function applyWalkSelection(ctx: PcbCtx, ids: Iterable<string>) { const pads = { sel: S.padSel, also: S.padAlso }; applySelection(ctx, Array.from(ids).filter((id) => !isPadKey(id))); S.padSel = pads.sel; S.padAlso = pads.also; }
// PCB_SELECTION_TOOL::selectNet / SelectAllItemsOnNet: the tracks, arcs, vias and copper shapes on the nets of the
// selected connected items (a footprint gives no net); with nothing selected, of the item under the cursor
function selectNetAction(ctx: PcbCtx, select: boolean) {
  const sel = selectCursor(ctx, (c) => runAction(select ? "selectNet" : "deselectNet", c)); if (!sel) return true;
  const nl = netlist(ctx.doc), out = new Set(sel), pass = walkFilter(ctx);
  for (const key of connectedItemNets(ctx.doc, sel, nl)) for (const id of netCopperIds(ctx.doc, key, nl, pass)) { if (select) out.add(id); else out.delete(id); }
  applyWalkSelection(ctx, out); return true;
}
act("selectNet", "Select Net", "", (ctx: PcbCtx) => selectNetAction(ctx, true));
act("deselectNet", "Deselect Net", "", (ctx: PcbCtx) => selectNetAction(ctx, false));
// PCB_SELECTION_TOOL::expandConnection: each press widens the selection by one stage (to the next junction, then to
// the pads, then the whole connection); nothing connected selected picks the connected item under the cursor first
act("selectConnection", "Select/Expand Connection", "U", (ctx: PcbCtx) => {
  let ids = Array.from(selectionIds(ctx)).concat(padSelKeys());
  const startish = (id: string) => { if (isPadKey(id)) return true; const it = ctx.doc.items.get(id); return !!it && (it.kind === "footprint" || it.kind === "generated" || it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone" || (/^gr_/.test(it.kind) && /\.Cu$/.test(layerOf(it.node, "")) && !!K.kid(it.node, "net"))); };
  if (!ids.some(startish) && !ids.some((id) => { const it = ctx.doc.items.get(id); return !!it && isExpandableGraphicShape(it); })) {
    const picked = selectCursor(ctx, (c) => runAction("selectConnection", c), true, connectedItemFilter(ctx)); if (!picked) return true;
    ids = picked;
  }
  const out = expandConnection(ctx.doc, ids, { passes: walkFilter(ctx), inScope: walkScope(ctx), accuracy: 5 / Math.max(1e-6, ctx.pxPerMm || 1) });
  applyWalkSelection(ctx, out); return true;
});
// PCB_SELECTION_TOOL::selectUnconnected: the footprints at the far end of the ratsnest lines of the selected
// footprints' (and pads') pads join the selection
act("selectUnconnected", "Select Unconnected Footprints", "O", (ctx: PcbCtx) => {
  const ids = Array.from(selectionIds(ctx)).concat(padSelKeys()); const nl = netlist(ctx.doc);
  const more = unconnectedFootprints(ctx.doc, ids, ratsnest(ctx.doc, nl)); if (!more.length) return true;
  applyWalkSelection(ctx, ids.concat(more)); return true;
});
// PCB_SELECTION_TOOL::grabUnconnected: per selected source the nearest unconnected footprint by ratsnest length
// replaces the selection, and Move Individually picks them up one after the other
act("grabUnconnected", "Grab Unconnected Footprints", "Shift+O", (ctx: PcbCtx) => {
  const ids = Array.from(selectionIds(ctx)).concat(padSelKeys()); const nl = netlist(ctx.doc);
  const near = nearestUnconnectedFootprints(ctx.doc, ids, nl, ratsnest(ctx.doc, nl)); if (!near.length) return true;
  S.padSel = null; S.padAlso = null; applySelection(ctx, Array.from(new Set(near)));
  return runAction("moveIndividually", ctx);
});
act("selectAllOnLayer", "Select All on Active Layer", "", (ctx: PcbCtx) => { const layer = ctx.activeLayer || S.layer; const ids = idsOnLayer(ctx.doc, layer); applySelection(ctx, ids); ctx.toast(`${plural(ids.size, "item")} on ${layer}`); return true; });
// PCB_SELECTION_TOOL::selectSameSheet: the first selected item, when it is a footprint with a sheet path, gives the
// sheet; its footprints and the copper that joins only them replace the selection (selectAllItemsOnSheet)
act("selectSameSheet", "Select Footprints on Same Sheet", "", (ctx: PcbCtx) => {
  const first = selectedItems(ctx)[0]; if (!first || first.kind !== "footprint") return true;
  const sheet = footprintSheetPath(first); if (sheet === null) return true;
  S.padSel = null; S.padAlso = null;
  applySelection(ctx, sheetItemIds(ctx.doc, sheet, netlist(ctx.doc), { passes: walkFilter(ctx), inScope: walkScope(ctx) })); return true;
});
act("unselectAll", "Unselect All", "", (ctx: PcbCtx) => { applySelection(ctx, []); return true; });
// placement
export const overrideLocks = () => !!appGlobal(() => editorState()!.overrideLocks, false);
export const LOCKED_WARNING = "Selection contains locked items. Enable 'Override locks' to operate on them.";
/**
 * Locked items sit out of every move, turn, flip, mirror and delete unless "Override locks" is ticked.  KiCad's
 * RequestSelection filters them (FilterCollectorForLockedItems: the item, or a group holding a locked member) and,
 * when anything was filtered, hands the action an empty selection: the whole action does nothing and
 * ReportFilteredLockedItems shows its infobar warning.  Returns the ids that may be edited: all of them, or none.
 */
export function unlockedIds(ctx: PcbCtx, ids: string[], quiet?: boolean) {
  if (overrideLocks()) return ids;
  const locked = ids.some((id: string) => { const it = ctx.doc.items.get(id); return it && isLocked(it.node); });
  if (!locked) return ids;
  if (!quiet) ctx.toast(LOCKED_WARNING, 3500);
  return [];
}
/**
 * The ids KiCad's hover selection would take at mm: the editor's Clarify Selection candidates (its hit test with
 * GuessSelectionCandidates applied) when the app supplies them, else the module's own pick.  A pad stands for its
 * footprint (FilterCollectorForFreePads), a group member for its group (FilterCollectorForHierarchy).
 */
export function cursorCandidates(ctx: PcbCtx, mm: Pt) {
  let ids: string[] | null = null;
  if (typeof ctx.candidatesAt === "function") { try { ids = ctx.candidatesAt(mm); } catch (e) { ids = null; } }
  if (!ids) { const it = itemAt(ctx, mm); ids = it ? [it.id] : []; }
  const out: string[] = [];
  for (let id of ids) {
    const h = typeof id === "string" ? id.indexOf("#") : -1; if (h > 0) id = id.slice(0, h);
    const top = topParentOf(ctx.doc, id); if (top) id = top.id;   // a group or generator member stands for its parent
    if (ctx.doc.items.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
/**
 * PCB_SELECTION_TOOL::RequestSelection for an EDIT_TOOL / BOARD_EDITOR_CONTROL action.  With items selected those
 * are the action's items; with nothing selected the item under the cursor is (KiCad's old-style hover selection,
 * selection.IsHover(): the action clears it again when it is done).  opts.filter(item) is the action's client filter
 * (markers, generated items, tracks for Swap …), opts.locks (default on) FilterCollectorForLockedItems.  When the
 * cursor is over several candidates the editor's Clarify Selection popup asks, and opts.rerun runs the action again
 * on the pick.  Returns { ids (groups expanded), items, hover } or null: nothing to act on, and nothing said.
 */
export function requestSelection(ctx: PcbCtx, opts?: RequestOpts) {
  opts = opts || {};
  // a generator (tuning pattern) passes the action's filter when one of its members does (it is a PCB_GROUP)
  const keep = (it: KItem): boolean => !!it && (!opts!.filter || (it.kind === "generated" ? groupMembers(it.node).some((id) => { const m = ctx.doc.items.get(id); return !!m && opts!.filter!(m); }) : opts!.filter(it)));
  let ids = Array.from(selectionIds(ctx)), hover = !!S.forceHover;
  if (!ids.length && S.padSel) { const i = S.padSel.lastIndexOf("#"), fp = S.padSel.slice(0, i); if (ctx.doc.items.has(fp)) ids = [fp]; }   // a selected pad stands for its footprint (FilterCollectorForFreePads)
  if (!ids.length) {
    hover = true;
    const at = ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx);
    const cands = cursorCandidates(ctx, at).filter((id) => keep(ctx.doc.items.get(id)!));
    if (!cands.length) return null;
    if (cands.length > 1 && opts.rerun && typeof ctx.clarify === "function") {
      // doSelectionMenu: the pick becomes the (hover) selection and the action runs on it
      ctx.clarify(cands, (fresh) => { S.forceHover = true; try { opts!.rerun!(fresh || ctx); } finally { S.forceHover = false; } });
      return null;
    }
    ids = [cands[0]];
  }
  ids = Array.from(expandGroups(ctx.doc, ids)).filter((id) => keep(ctx.doc.items.get(id)!) || ctx.doc.items.get(id)!.kind === "group");
  if (!ids.length) return null;
  if (opts.locks !== false && !unlockedIds(ctx, ids, opts.quiet).length) return null;
  return { ids, items: ids.map((id) => ctx.doc.items.get(id)).filter((it) => it && it.kind !== "group" && it.kind !== "generated") as KItem[], hover };
}
/** The end of an action on a hover selection: selection.IsHover() -> selectionClear. */
export function endHover(ctx: PcbCtx, sel: { hover: boolean } | null) { if (sel && sel.hover) applySelection(ctx, []); }
/**
 * EDIT_TOOL::updateModificationPoint: a lone item turns about its own position, several about the grid-snapped
 * centre of their bounding box.  Rotate takes the centre of a lone rectangle, polygon, text box or table instead.
 */
export function modificationPoint(ctx: PcbCtx, items: KItem[], forRotate: boolean): Pt {
  if (items.length === 1) {
    const it = items[0];
    if (forRotate && (it.kind === "gr_rect" || it.kind === "gr_poly" || it.kind === "gr_text_box" || it.kind === "table") && it.bbox) return [(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2];
    return anchorOf(it);
  }
  const b = bboxUnion(items); const c = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
  return ctx.snapOn && ctx.snap ? ctx.snap(c) : c;
}
export function editableOrToast(ctx: PcbCtx, what: string) { const ids = selectionOrToast(ctx, what); if (!ids) return null; const free = unlockedIds(ctx, ids); return free.length ? free : null; }
export function selectionOrToast(ctx: PcbCtx, what: string) { const ids = needSel(ctx, what); return ids && canEdit(ctx) ? Array.from(expandGroups(ctx.doc, ids)) : null; }
// EDIT_TOOL::Move: the selection, or the item under the cursor (hover: selected while it moves, cleared after)
act("move", "Move", "M", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("move", c) }); if (!sel) return true;
  if (sel.hover) applySelection(ctx, sel.ids);
  beginCarryMove(ctx, { ids: sel.ids, hover: sel.hover }); return true;
});
act("moveExactly", "Move Exactly…", "Shift+M", (ctx: PcbCtx) => {
  if (!canEdit(ctx) || S.route || S.move) return true;   // moveExact while moving: wxBell
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("moveExactly", c) }); if (!sel) return true; const ids = sel.ids;
  const run = (v: MoveExactResult): void => { commitSel(ctx, moveExactChanges(ctx.doc, ids, { dx: v.dx, dy: v.dy, rotation: v.rotation, about: v.about }), "Move Exactly"); if (sel.hover) applySelection(ctx, []); };
  if (routingDialogs.moveExact) { const items = ids.map((id) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]; routingDialogs.moveExact({ single: ids.length === 1, bbox: bboxUnion(items) }, run); return true; }
  return openForm({ title: "Move Item", fields: [{ k: "dx", label: "Move X:", type: "num", value: 0, unit: "mm" }, { k: "dy", label: "Move Y:", type: "num", value: 0, unit: "mm" }, { k: "rotation", label: "Rotate:", type: "num", value: 0, unit: "deg" },
    { k: "about", label: "", type: "select", value: ids.length > 1 ? "center" : "anchor", options: [[ids.length > 1 ? "center" : "anchor", ids.length > 1 ? "Rotate around selection center" : "Rotate around item anchor"]] }],
    apply: (v: { dx: number; dy: number; rotation: number; about: string }) => run({ dx: num0(v.dx, 0), dy: num0(v.dy, 0), rotation: num0(v.rotation, 0), about: v.about === "anchor" ? "anchor" : "center" }) });
});
alias("moveExact", "moveExactly");
// EDIT_TOOL's other moves (ref-move.ts): a picked reference point, one item at a time, an interactive offset
act("moveWithReference", "Move with Reference...", "", (ctx: PcbCtx) => {
  if (S.route || S.move || !canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("moveWithReference", c) }); if (!sel) return true;
  return moveWithReference(ctx, sel.ids, sel.hover);
}, { tip: "Moves the selected item(s) with a specified starting point" });
act("copyWithReference", "Copy with Reference...", "", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction("copyWithReference", c) }); if (!sel) return true;
  return copyWithReference(ctx, sel.ids, sel.hover);
}, { tip: "Copy selected item(s) to clipboard with a specified starting point" });
act("moveIndividually", "Move Individually", "Ctrl+M", (ctx: PcbCtx) => {
  if (S.route || S.move || !canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("moveIndividually", c) }); if (!sel) return true;
  // the selection's top-level items in order: a group is one item of the sequence (its members move with it)
  return moveIndividually(ctx, sel.ids.filter((id) => ctx.doc.items.has(id) && !topParentOf(ctx.doc, id)));
}, { tip: "Moves the selected items one-by-one" });
act("skip", "Skip", "Tab", (ctx: PcbCtx) => skipMoveItem(ctx), { menu: false, tip: "Skip to next item" });
act("interactiveOffsetTool", "Interactive Offset Tool", "", (ctx: PcbCtx) => {
  if (S.route || S.move || !canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("interactiveOffsetTool", c) }); if (!sel) return true;
  return interactiveOffset(ctx, sel.ids, sel.hover);
}, { tip: "Interactive tool for offsetting items by exact amounts" });
/** GetFootprintFromBoardByReference's list: "REF    ( VALUE )" per board footprint, sorted (wxArrayString::Sort). */
export function footprintRefChoices(doc: BoardDoc): string[] {
  const out: string[] = []; for (const it of doc.items.values()) if (it.kind === "footprint") out.push(`${it.ref || ""}    ( ${it.value || ""} )`);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
/** The footprint whose reference matches the entered text (trimmed, case-insensitive: CmpNoCase), or null. */
export function footprintByRef(doc: BoardDoc, text: string): KItem | null {
  const want = String(text || "").trim().toLowerCase(); if (!want) return null;
  for (const it of doc.items.values()) if (it.kind === "footprint" && (it.ref || "").toLowerCase() === want) return it;
  return null;
}
/**
 * EDIT_TOOL::GetAndPlace (T): DIALOG_GET_FOOTPRINT_BY_NAME asks for a reference (typed, or picked from the list of the
 * board's footprints); the footprint becomes the selection with its position as the reference point and Move runs on
 * it, so it comes to the cursor; a click drops it, Escape puts it back.
 */
act("getAndPlace", "Get and Move Footprint", "T", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;
  if (appGlobal(() => editorState()!.DOC_TYPE === "footprint", false) || !canEdit(ctx)) return true;   // makes sense only in the board editor
  const choices = footprintRefChoices(ctx.doc); const refOf = (c: string) => c.split(" ")[0];
  return openForm({ title: "Get and Move Footprint", width: 400, fields: [
    { k: "ref", label: "Reference designator:", type: "text", value: "" },
    { k: "list", label: "Available footprints:", type: "select", value: "", options: choices.map((c) => [refOf(c), c.replace(/ /g, "\u00a0")]) }],   // a wxChoice keeps the spaces an HTML option collapses
    change: (k: string, v: unknown, set: (k: string, v: unknown) => void) => {
      if (k === "list") set("ref", v);
      else if (k === "ref") { const e = String(v).trim().toLowerCase(); const hit = choices.find((c) => refOf(c).toLowerCase() === e); set("list", hit ? refOf(hit) : ""); }
    },
    apply: (v: { ref: string }) => { getAndPlaceRef(ctx, v.ref); } });
});
/** The second half of Get and Move Footprint: select the footprint and move it with its position as the reference point. */
export function getAndPlaceRef(ctx: PcbCtx, ref: string): boolean {
  const fp = footprintByRef(ctx.doc, ref); if (!fp) return false;
  applySelection(ctx, [fp.id]);
  return beginCarryMove(ctx, { ids: [fp.id], origin: [fp.x || 0, fp.y || 0] });
}
act("positionRelative", "Position Relative To…", "Shift+P", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;   // isRouterActive, and positionRelative while moving: wxBell
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("positionRelative", c) }); if (!sel) return true; const ids = sel.ids;
  const items = ids.map((id) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]; const a = topLeftAnchor(items);
  // POSITION_RELATIVE_TOOL::RelativeItemSelectionMove: the selection's anchor goes to the reference position plus the offset
  const run = (ref: Pt, dx: number, dy: number): void => { commitSel(ctx, positionRelativeChanges(ctx.doc, ids, ref, dx, dy), "Position Relative"); if (sel.hover) applySelection(ctx, []); };
  if (routingDialogs.positionRelative) { routingDialogs.positionRelative({ ctx, selAnchor: [a[0], a[1]] }, run); return true; }
  const fps = Array.from(ctx.doc.items.values()).filter((it) => it.kind === "footprint" && !ids.includes(it.id)).sort((p, q) => (p.ref || "").localeCompare(q.ref || "", undefined, { numeric: true }));
  return openForm({ title: "Position Relative To Reference Item", fields: [
    { k: "ref", label: "Reference", type: "select", value: "origin", options: [["origin", "Grid origin (0, 0)"], ["point", "Point below"]].concat(fps.map((f) => [f.id, `${f.ref || f.lib} (${fmt(f.x!)}, ${fmt(f.y!)})`])) },
    { k: "px", label: "Point X (mm)", type: "num", value: r6(a[0]) }, { k: "py", label: "Point Y (mm)", type: "num", value: r6(a[1]) },
    { k: "dx", label: "Offset X:", type: "num", value: 0, unit: "mm" }, { k: "dy", label: "Offset Y:", type: "num", value: 0, unit: "mm" }],
    apply: (v: { ref: string; px: number; py: number; dx: number; dy: number }) => { const ref = v.ref === "origin" ? [0, 0] : v.ref === "point" ? [num0(v.px, 0), num0(v.py, 0)] : anchorOf(ctx.doc.items.get(v.ref)!); run(ref as Pt, num0(v.dx, 0), num0(v.dy, 0)); } });
});
for (const [id, mode, label] of [["alignLeft", "left", "Align to Left"], ["alignRight", "right", "Align to Right"], ["alignTop", "top", "Align to Top"], ["alignBottom", "bottom", "Align to Bottom"], ["alignCenterX", "centerX", "Align to Horizontal Center"], ["alignCenterY", "centerY", "Align to Vertical Center"]])
  act(id, label, "", (ctx: PcbCtx) => {
    // ALIGN_DISTRIBUTE_TOOL::GetSelections: nothing is filtered for locks; the locked items are the alignment targets
    // and stay put, the rest move.  A selected pad stands for its footprint.  Nothing is said when nothing moves.
    if (!canEdit(ctx)) return true;
    const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction(id, c) }); if (!sel) return true;
    const locked = new Set(sel.ids.filter((x) => { const it = ctx.doc.items.get(x); if (!it) return false; if (isLocked(it.node)) return true; for (let g = groupOf(ctx.doc, x); g; g = groupOf(ctx.doc, g.id)) if (isLocked(g.node)) return true; return false; }));
    const ch = alignChanges(ctx.doc, sel.ids, mode, ctx.cursor ? ctx.cursor : cursorPoint(ctx), { locked, mirrored: !!appGlobal(() => (editorState() as unknown as { renderOpts?: { flip?: boolean } }).renderOpts!.flip, false) });
    if (ch.length) ctx.commit(ch, ALIGN_COMMIT[mode]);
    endHover(ctx, sel); ctx.requestRender(); return true;
  });
for (const [id, axis, centers, label] of [["distributeH", "x", false, "Distribute Horizontally with Even Gaps"], ["distributeV", "y", false, "Distribute Vertically with Even Gaps"], ["distributeHCenters", "x", true, "Distribute Horizontally by Centers"], ["distributeVCenters", "y", true, "Distribute Vertically by Centers"]] as [string, string, boolean, string][])
  act(id, label, "", (ctx: PcbCtx) => {
    // ALIGN_DISTRIBUTE_TOOL::DistributeItems: locked items refuse it (the infobar warning); fewer than three items,
    // or nothing to move, is silent; the commit carries the action's name
    if (!canEdit(ctx)) return true;
    const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction(id, c) }); if (!sel) return true;
    const ch = sel.items.length < 3 ? [] : distributeChanges(ctx.doc, sel.ids, axis, centers); if (ch.length) ctx.commit(ch, label);
    endHover(ctx, sel); ctx.requestRender(); return true;
  });
alias("distributeHorizontallyGaps", "distributeH"); alias("distributeVerticallyGaps", "distributeV"); alias("distributeHorizontallyCenters", "distributeHCenters"); alias("distributeVerticallyCenters", "distributeVCenters");
/**
 * A board footprint the app itself is dragging (its pointer drag) goes over to the module's move first, so a turn
 * in flight has a move session to act on (ctx.handoffDrag, from the editor).
 */
export const moveInFlight = (ctx: PcbCtx) => !!S.move || !!(ctx.handoffDrag && ctx.handoffDrag() && S.move);
/** EDIT_TOOL::Rotate: about the modification point; a hover selection is cleared afterwards; while moving, the move turns. */
export function rotateBy(ctx: PcbCtx, deg: number) {
  if (S.route) return true;   // isRouterActive: wxBell
  if (moveInFlight(ctx)) return moveTransform(ctx, "rotate", deg);
  if (!canEdit(ctx)) return true;
  // a footprint field (PCB_FIELD_T): PCB_TEXT::Rotate about its own position; a selected field stays selected
  const fr = requestField(ctx, ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx));
  if (fr) { const ch = rotateFieldChange(ctx.doc, fr, deg); if (ch) ctx.commit([ch], "Rotate"); ctx.requestRender(); return true; }
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => rotateBy(c, deg) }); if (!sel) return true;
  const c = modificationPoint(ctx, sel.items, true);
  const ch = rotateChanges(ctx.doc, sel.ids, c[0], c[1], deg); if (ch.length) ctx.commit(ch, "Rotate");
  endHover(ctx, sel); ctx.requestRender(); return true;
}
/**
 * EDIT_TOOL::Rotate: TOOL_EVT_UTILS::GetEventRotationAngle, the Editing Options' rotation step (90 by default): the
 * Footprint Editor's own (FOOTPRINT_EDITOR_SETTINGS m_RotationAngle) there, PCBNEW_SETTINGS' on a board.
 */
export const rotationStep = (ctx?: PcbCtx | null) => { const a = ctx && ctx.fpEditor ? S.fpRotationAngle : S.rotationAngle; return typeof a === "number" && a > 0 ? a : 90; };
act("rotateSelection", "Rotate Counterclockwise", "R", (ctx: PcbCtx) => rotateBy(ctx, rotationStep(ctx))); alias("rotateCcw", "rotateSelection");
act("rotateSelectionCw", "Rotate Clockwise", "", (ctx: PcbCtx) => rotateBy(ctx, -rotationStep(ctx))); alias("rotateCw", "rotateSelectionCw");
/**
 * EDIT_TOOL::Flip ("Change Side / Flip"): a lone item about its own position (a rectangle or table about its centre),
 * several about the middle of their box; nothing is said afterwards.
 */
/** PCBNEW_SETTINGS m_FlipDirection ("Flip board items": Left/right | Top/bottom; top / bottom unless the preference says otherwise). */
export const flipDirection = (): "lr" | "tb" => S.flipDirection === "lr" ? "lr" : "tb";
export function flipBy(ctx: PcbCtx) {
  if (S.route) { attemptFinish(ctx); return true; }   // F while routing is routerAttemptFinish
  if (moveInFlight(ctx)) return moveTransform(ctx, "flip");
  if (!canEdit(ctx)) return true;
  // a footprint field: PCB_TEXT::Flip about its own position ("Change Side / Flip")
  const fr = requestField(ctx, ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx));
  if (fr) { const ch = flipFieldChange(ctx.doc, fr, flipDirection()); if (ch) ctx.commit([ch], "Change Side / Flip"); ctx.requestRender(); return true; }
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => flipBy(c) }); if (!sel) return true;
  const items = sel.items, one = items.length === 1 && items[0]!.kind !== "gr_rect" && items[0]!.kind !== "table";
  const b = bboxUnion(items); const c: Pt = one ? anchorOf(items[0]!) : b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
  const ch = flipChanges(ctx.doc, sel.ids, c[0], c[1], flipDirection()); if (ch.length) ctx.commit(ch, "Change Side / Flip");
  endHover(ctx, sel); ctx.requestRender(); return true;
}
act("flipSelection", "Flip", "F", (ctx: PcbCtx) => flipBy(ctx));
alias("flip", "flipSelection");
export const MIRROR_FOOTPRINTS = "Footprints cannot be mirrored. Use Flip to move them to the other side of the board.";
export const MIRROR_GROUPS = "Groups containing footprints or other items that cannot be mirrored were skipped.";
/**
 * EDIT_TOOL::Mirror (mirrorH / mirrorV): graphics, text, tracks, zones … in place about the modification point (a lone
 * item's position, else the grid-snapped centre of the selection).  Footprints are skipped (MIRROR_SKIPS), and so is a
 * group holding one, with KiCad's infobar message.
 */
export function mirrorBy(ctx: PcbCtx, axis: string) {
  if (S.route) return true;
  if (moveInFlight(ctx)) return moveTransform(ctx, "mirror", axis);
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => mirrorBy(c, axis) }); if (!sel) return true;
  const doc = ctx.doc; let footprints = 0, groups = 0; const skip = new Set();
  for (const id of sel.ids) {
    const it = doc.items.get(id); if (!it || it.kind !== "group" || groupOf(doc, id)) continue;   // the top-level groups
    const inner = Array.from(expandGroups(doc, [id]));
    if (inner.some((x) => { const m = doc.items.get(x); return m && m.kind === "footprint"; })) { groups++; inner.forEach((x) => skip.add(x)); }
  }
  for (const it of sel.items) if (it!.kind === "footprint" && !skip.has(it!.id)) footprints++;
  const ids = sel.ids.filter((id) => !skip.has(id)); const items = ids.map((id) => doc.items.get(id)).filter((it) => it && it.kind !== "group") as KItem[];
  if (items.length) { const c = modificationPoint(ctx, items, false); const ch = mirrorChanges(doc, ids, c[0], c[1], axis); if (ch.length) ctx.commit(ch, "Mirror"); }
  if (footprints) ctx.toast(MIRROR_FOOTPRINTS, 3500); else if (groups) ctx.toast(MIRROR_GROUPS, 3500);
  endHover(ctx, sel); ctx.requestRender(); return true;
}
for (const [id, axis, label] of [["mirrorH", "h", "Mirror Horizontally"], ["mirrorV", "v", "Mirror Vertically"]]) act(id, label, "", (ctx: PcbCtx) => mirrorBy(ctx, axis));
export const MIRROR_ARBITRARY = "Items that cannot be mirrored about an arbitrary axis were skipped.";
/**
 * EDIT_TOOL::MirrorInteractive: the selection (or the item under the cursor, locks honoured), then two points picked
 * for the mirror axis - "Select the first point of the mirror axis...", "Select the second point of the mirror
 * axis..." - with the axis drawn between them (held to the angle snap mode, Ctrl: 45 degrees).  A zero-length axis is
 * refused ("The mirror axis must have a non-zero length."); otherwise every mirrorable item is reflected about it in
 * one "Mirror" step, with KiCad's infobar message for what was skipped.  A hover selection is cleared afterwards.
 */
act("mirrorInteractive", "Mirror Interactive", "", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;   // isRouterActive: wxBell
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { rerun: (c: PcbCtx) => runAction("mirrorInteractive", c) }); if (!sel) return true;
  if (sel.hover) applySelection(ctx, sel.ids);
  pickTwoPoints(ctx, "Select the first point of the mirror axis...", "Select the second point of the mirror axis...", "axis", (a, b) => {
    if (!a || !b) { endHover(ctx, sel); return; }
    const r = mirrorAxisChanges(ctx.doc, sel.ids.filter((id) => ctx.doc.items.has(id)), a, b, (id) => groupOf(ctx.doc, id) || null, (id) => Array.from(expandGroups(ctx.doc, [id])));
    if (r.changes.length) ctx.commit(r.changes, "Mirror");
    if (r.skips.footprints) ctx.toast(MIRROR_FOOTPRINTS, 3500); else if (r.skips.groups) ctx.toast(MIRROR_GROUPS, 3500); else if (r.skips.items) ctx.toast(MIRROR_ARBITRARY, 3500);
    endHover(ctx, sel); ctx.requestRender();
  });
  return true;
}, { tip: "Mirrors selected item(s) interactively" });
// EDIT_TOOL::Swap (no tracks: PCB_TRACE_T is filtered) and PackAndMoveFootprints (footprints only)
act("swap", "Swap", "Alt+S", (ctx: PcbCtx) => {
  if (S.route) return true;   // isRouterActive: wxBell
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { filter: (it: KItem) => it.kind !== "segment", rerun: (c: PcbCtx) => runAction("swap", c) }); if (!sel) return true;
  const ch = swapChanges(ctx.doc, sel.ids); if (ch.length) ctx.commit(ch, "Swap"); endHover(ctx, sel); ctx.requestRender(); return true;
});
act("pack", "Pack and Move Footprints", "P", (ctx: PcbCtx) => {
  if (S.route || S.move) return true;   // isRouterActive() || m_dragging: wxBell
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { filter: (it: KItem) => it.kind === "footprint", rerun: (c: PcbCtx) => runAction("pack", c) }); if (!sel) return true;
  const fps = sel.ids.filter((id) => ctx.doc.items.get(id)?.kind === "footprint"); if (!fps.length) return true;
  // EDIT_TOOL::PackAndMoveFootprints: SpreadFootprints packs them at their box's corner inside the move's own commit,
  // then doMoveSelection carries them under the cursor: a click pushes one "Pack Footprints" step holding the pack and
  // the move, Escape reverts both (commit.Revert()).  The pack is the move session's starting shape (m.orig), the
  // footprints as they were its restore point (m.base).
  const before = new Map(fps.map((id) => [id, clone(ctx.doc.items.get(id)!.node)] as [string, SNode]));
  const packed = packNodes(ctx.doc, fps);
  for (const [id, node] of packed) { const it = ctx.doc.items.get(id)!; it.node.length = 0; it.node.push(...clone(node)); K.replaceChange(ctx.doc, it); }
  applySelection(ctx, fps);
  if (!beginCarryMove(ctx, { ids: fps, hover: sel.hover }) || !S.move) {
    for (const [id, node] of before) { const it = ctx.doc.items.get(id)!; it.node.length = 0; it.node.push(...node); K.replaceChange(ctx.doc, it); }
    ctx.requestRender(); return true;
  }
  const m = S.move as SelectMove; m.base = before; m.xformed = packed.size > 0; m.label = "Pack Footprints";
  return true;
}, { tip: "Sorts selected footprints by reference, packs based on size and initiates movement" });
alias("packAndMoveFootprints", "pack");
act("createArray", "Create Array…", "Ctrl+T", (ctx: PcbCtx) => {   // DIALOG_CREATE_ARRAY lives in web/domains/pcb/editor/pcbdialogs/array.ts; this short form stands in without it
  const ids = selectionOrToast(ctx, "Select items to array"); if (!ids) return true;
  return openForm({ title: "Create Array", fields: [{ k: "nx", label: "Horizontal count", type: "num", value: 5, step: "1" }, { k: "ny", label: "Vertical count", type: "num", value: 5, step: "1" }, { k: "dx", label: "Horizontal spacing (mm)", type: "num", value: 2.54 }, { k: "dy", label: "Vertical spacing (mm)", type: "num", value: 2.54 }],
    apply: (v: { nx: number; ny: number; dx: number; dy: number }) => { const r = arrayChanges(ctx.doc, ids, { type: "grid", nx: num0(v.nx, 1), ny: num0(v.ny, 1), dx: num0(v.dx, 0), dy: num0(v.dy, 0), offX: 0, offY: 0, stagger: 1, staggerRows: true, centred: false, hThenV: true }); if (!r.changes.length) return; ctx.commit(r.changes, r.label); applySelection(ctx, r.ids); } });
});
act("swapLayers", "Swap Layers…", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc; const copper = copperOf(doc);
  const run = (map: Record<string, string>): void => { const ch = swapLayerChanges(doc, map); if (ch.length) ctx.commit(ch, "Swap Layers"); ctx.requestRender(); };
  if (routingDialogs.swapLayers) { routingDialogs.swapLayers({ copper }, run); return true; }
  return openForm({ title: "Swap Layers", width: 380, fields: copper.map((l) => ({ k: l, label: l, type: "select", value: l, options: copper })), apply: (v: Record<string, string>) => {
    const map: Record<string, string> = {}; for (const l of copper) if (v[l] && v[l] !== l) map[l] = v[l]; run(map);
  } });
});
/**
 * GLOBAL_EDIT_TOOL::SwapLayers: tracks, blind / buried / micro vias (their layer pair), zones and board drawings move
 * from each copper layer to the one the map gives; through vias, footprints and the tracks of a generator stay.
 */
export function swapLayerChanges(doc: BoardDoc, map: Record<string, string>): KChange[] {
  const m: Record<string, string> = {}; for (const [a, b] of Object.entries(map)) if (b && a !== b) m[a] = b;
  if (!Object.keys(m).length) return [];
  const inGenerator = new Set<string>();
  for (const it of doc.items.values()) if (it.kind === "generated") for (const id of K.groupMemberIds(it.node)) inGenerator.add(id);
  return transformChanges(doc, Array.from(doc.items.keys()), (n, it: KItem) => {
    if (it.kind === "footprint" || it.kind === "group") return false;
    if ((it.kind === "segment" || it.kind === "arc" || it.kind === "via") && inGenerator.has(it.id)) return false;
    if (it.kind === "via" && !n.includes("blind") && !n.includes("micro") && !n.includes("buried")) return false;   // VIATYPE::THROUGH
    let did = false;
    const l = K.kid(n, "layer"); if (l && m[K.str(l[1])]) { l[1] = m[K.str(l[1])]; did = true; }
    const ls = K.kid(n, "layers");
    if (ls) { const seen = new Set<string>(); const out: string[] = []; for (let i = 1; i < ls.length; i++) { const v = K.str(ls[i]), w = m[v] || v; if (w !== v) did = true; if (!seen.has(w)) { seen.add(w); out.push(w); } } if (did) ls.splice(1, ls.length - 1, ...out); }
    if (it.kind === "zone") for (const fp of K.kids(n, "filled_polygon")) { const fl = K.kid(fp, "layer"); if (fl && m[K.str(fl[1])]) { fl[1] = m[K.str(fl[1])]; did = true; } }
    if (it.kind === "dimension") { const gt = K.kid(n, "gr_text"); const gl = gt && K.kid(gt, "layer"); if (gl && m[K.str(gl[1])]) { gl[1] = m[K.str(gl[1])]; did = true; } }
    return did ? undefined : false;
  });
}
// tracks and vias
/**
 * EDIT_TOOL::ChangeTrackWidth: the selected tracks and vias (or the one under the cursor), locks honoured, take the
 * board's current sizes at once - GetCurrentTrackWidth for a track or arc, GetCurrentViaSize / GetCurrentViaDrill for
 * a via (a microvia its netclass's microvia size) - in one "Edit Track Width/Via Size" step; no dialog.
 */
export function currentSizeChanges(ctx: PcbCtx, ids: string[]): KChange[] {
  const R = sizesOf(ctx), w = R.currentTrackWidth(), via = R.currentVia(), s = settingsOf(ctx), NT = netTable(ctx.doc);
  return transformChanges(ctx.doc, ids, (n, it: KItem) => {
    if (it.kind === "segment" || it.kind === "arc") {
      if (!(w > 0) || widthOf(n, 0) === r6(w)) return false;
      const wn = K.kid(n, "width"); if (wn) wn[1] = r6(w); else n.splice(n.indexOf(K.kid(n, "layer")!), 0, ["width", r6(w)]); return undefined;
    }
    if (it.kind !== "via") return false;
    let size = via.diameter, drill = via.drill;
    if (n.includes("micro")) { const nc = netclassOf(s, NT.key(netOf(n))) as { microvia_diameter?: number; microvia_drill?: number }; if (!(nc.microvia_diameter! > 0) || !(nc.microvia_drill! > 0)) return false; size = nc.microvia_diameter!; drill = nc.microvia_drill!; }
    const sn = K.kid(n, "size"), dn = K.kid(n, "drill"); let did = false;
    if (sn && size > 0 && K.num(sn[1]) !== r6(size)) { sn[1] = r6(size); did = true; }
    if (dn && drill > 0 && K.num(dn[1]) !== r6(drill)) { dn[1] = r6(drill); did = true; }
    return did ? undefined : false;
  });
}
const isTrackKind = (it: KItem) => it.kind === "segment" || it.kind === "arc" || it.kind === "via";
act("changeTrackWidth", "Change Track Width", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { filter: isTrackKind, rerun: (c: PcbCtx) => runAction("changeTrackWidth", c) }); if (!sel) return true;
  const ch = currentSizeChanges(ctx, sel.ids); if (ch.length) ctx.commit(ch, "Edit Track Width/Via Size");
  endHover(ctx, sel); ctx.requestRender(); return true;
}, { tip: "Updates selected track & via sizes" });
act("setTrackWidthFromNetclass", "Set Track / Via Sizes from Netclass", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select tracks or vias first"); if (!ids) return true; return commitSel(ctx, trackEditChanges(ctx.doc, ids, { netclass: true }, settingsOf(ctx)), "netclass sizes"); });
act("trackWidthInc", "Increase Track Width", "W", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleWidth(ctx, 1); return true; });
act("trackWidthDec", "Decrease Track Width", "Shift+W", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleWidth(ctx, -1); return true; });
act("viaSizeInc", "Increase Via Size", "'", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleVia(ctx, 1); return true; }); act("viaSizeDec", "Decrease Via Size", "\\", (ctx: PcbCtx) => { if (canEdit(ctx)) cycleVia(ctx, -1); return true; });
act("autoTrackWidth", "Automatically select track width", "", (ctx: PcbCtx) => { sizesOf(ctx).toggleConnectedWidth(); return true; }, { toggle: () => !!K.pcbSizes.state.useConnectedWidth, menu: "-" });
// the active layer (PCB_CONTROL): PgUp / PgDn, + / -, and V with nothing being routed toggles within the routing pair
act("layerTop", "Switch to Component (F.Cu) layer", "PgUp", (ctx: PcbCtx) => { setLayer(ctx, viaSpan(ctx.doc)[0]); return true; }, { menu: "-" });
act("layerBottom", "Switch to Copper (B.Cu) Layer", "PgDn", (ctx: PcbCtx) => { setLayer(ctx, viaSpan(ctx.doc)[1]); return true; }, { menu: "-" });
act("layerNext", "Switch to Next Layer", "+", (ctx: PcbCtx) => stepLayer(ctx, true), { menu: "-" });
act("layerPrev", "Switch to Previous Layer", "-", (ctx: PcbCtx) => stepLayer(ctx, false), { menu: "-" });
act("layerToggle", "Toggle Layer", "", (ctx: PcbCtx) => { setLayer(ctx, sizesOf(ctx).pairedLayer(S.route ? S.route.layer : S.layer)); return true; }, { menu: "-" });
act("ratsnestLineMode", "Curved Ratsnest Lines", "", (ctx: PcbCtx) => { const R = sizesOf(ctx); R.setCurvedRatsnest(!R.curvedRatsnest); ctx.requestRender(); return true; }, { toggle: () => !!K.pcbSizes.state.curvedRatsnest, menu: "-" });
// the two routing dialogs are built by the editor bundle (web/domains/pcb/editor/pcbrouting.ts) and handed over through pcb.setRoutingDialogs
export let routingDialogs: RoutingDialogs = {};
// ROUTER_TOOL: the router's mode (PCB_ACTIONS::routerHighlightMode / routerShoveMode / routerWalkaroundMode, cycleRouterMode),
// its settings dialog, the corner modes and the via commands (ACT_* in router_tool.cpp; context hotkeys in onCaptureKey / onKey)
export const ROUTER_ACTION = { menu: false };
// ROUTER_TOOL::CustomTrackWidthDialog (ACT_CustomTrackWidth, Q while routing): DIALOG_TRACK_VIA_SIZE from the editor bundle
act("ACT_CustomTrackWidth", "Custom Track/Via Size...", "Q", (ctx: PcbCtx) => { if (routingDialogs.customTrackVia) routingDialogs.customTrackVia(ctx); else ctx.toast("Custom Track/Via Size: dialogs are unavailable here"); return true; }, Object.assign({ tip: "Shows a dialog for changing the track width and via size." }, ROUTER_ACTION));
act("routerHighlightMode", "Router Highlight Mode", "", () => { setRouterSettings({ mode: RM_MARK }); return true; }, Object.assign({ tip: "Switch router to highlight mode", check: () => S.rs.mode === RM_MARK }, ROUTER_ACTION));
act("routerShoveMode", "Router Shove Mode", "", () => { setRouterSettings({ mode: RM_SHOVE }); return true; }, Object.assign({ tip: "Switch router to shove mode", check: () => S.rs.mode === RM_SHOVE }, ROUTER_ACTION));
act("routerWalkaroundMode", "Router Walkaround Mode", "", () => { setRouterSettings({ mode: RM_WALK }); return true; }, Object.assign({ tip: "Switch router to walkaround mode", check: () => S.rs.mode === RM_WALK }, ROUTER_ACTION));
act("cycleRouterMode", "Cycle Router Mode", "", () => { setRouterSettings({ mode: S.rs.mode === RM_MARK ? RM_SHOVE : S.rs.mode === RM_SHOVE ? RM_WALK : RM_MARK }); return true; }, Object.assign({ tip: "Cycle router to the next mode" }, ROUTER_ACTION));
act("routerSettingsDialog", "Interactive Router Settings...", "", (ctx: PcbCtx) => { if (routingDialogs.routerSettings) routingDialogs.routerSettings(ctx); else ctx.toast("Interactive Router Settings: dialogs are unavailable here"); return true; }, { menu: "Route", tip: "Open Interactive Router settings" });
// the length tuner's settings and steps (PCB_ACTIONS::lengthTunerSettings, spacingIncrease / spacingDecrease, amplIncrease / amplDecrease)
/** The tuner's settings in mm as the Tuning Pattern Properties dialog shows them. */
export function tuneSettingsView(st: MeanderSettings, mode: string) {
  const tgt = mode === "skew" ? st.skew.opt / TUNE_IU : st.target.opt === LENGTH_UNCONSTRAINED ? null : st.target.opt / TUNE_IU;
  return { targetLength: tgt, minAmp: st.minAmp / TUNE_IU, maxAmp: st.maxAmp / TUNE_IU, spacing: st.spacing / TUNE_IU,
    round: st.round, crPct: st.crPct, singleSided: st.singleSided, overrideCustomRules: st.overrideCustomRules };
}
/** DIALOG_TUNING_PATTERN_PROPERTIES::TransferDataFromWindow onto MEANDER_SETTINGS. */
export function applyTuneSettings(st: MeanderSettings, v: TuneView, mode: string) {
  if (mode === "skew") setTargetSkew(st, v.targetLength == null ? 0 : Math.round(v.targetLength * TUNE_IU));
  else setTargetLength(st, v.targetLength == null ? LENGTH_UNCONSTRAINED : Math.round(v.targetLength * TUNE_IU));
  st.overrideCustomRules = !!v.overrideCustomRules;
  st.minAmp = Math.round(v.minAmp * TUNE_IU); st.maxAmp = Math.round(v.maxAmp * TUNE_IU); st.spacing = Math.round(v.spacing * TUNE_IU);
  st.round = !!v.round; st.crPct = Math.round(v.crPct); st.singleSided = !!v.singleSided;
}
export function openTuneSettings(ctx: PcbCtx) {
  const mode = tuneMode(); const T = S.tune.pattern; const cur = T ? T.st : S.tuneSettings[mode];
  if (!routingDialogs.tuning) { ctx.toast("Length Tuning Settings: dialogs are unavailable here"); return true; }
  routingDialogs.tuning({ mode: mode === "skew" ? "diff_pair_skew" : mode === "diffpair" ? "diff_pair" : "single", settings: tuneSettingsView(cur, mode) }, (v) => {
    applyTuneSettings(S.tuneSettings[mode], v, mode);   // StoreDefaults
    if (S.tune.pattern) { const side = S.tune.pattern.st.initialSide; S.tune.pattern.st = tuneCopy(S.tuneSettings[mode]); S.tune.pattern.st.initialSide = side; tuneUpdate(lastCtx || ctx); }   // ApplyToolSettings, updateTuningPattern
    (lastCtx || ctx).requestRender();
  });
  return true;
}
// handled only inside the tuner's event loop (PCB_TUNING_PATTERN's tool, pcb_tuning_pattern.cpp): elsewhere Ctrl+L does
// nothing (the key is still taken, so the browser does not move focus to its address bar)
act("lengthTunerSettings", "Length Tuning Settings...", "Ctrl+L", (ctx: PcbCtx) => (isTuneTool(S.modTool) ? openTuneSettings(ctx) : true), { menu: false, tip: "Displays tuning pattern properties dialog" });
/** The tuner's loop takes PCB_ACTIONS::properties like lengthTunerSettings: E opens Tuning Pattern Properties. */
export function tunerProperties(ctx: PcbCtx) {
  bind(ctx);
  if (S.route) return runAction("ACT_CustomTrackWidth", ctx);   // performRouting: PCB_ACTIONS::properties runs ACT_CustomTrackWidth
  if (isTuneTool(S.modTool)) return openTuneSettings(ctx);
  // EDIT_TOOL::Properties on a selected pattern: PCB_TUNING_PATTERN::ShowPropertiesDialog
  const gen = selectedTuningPattern(ctx); if (!gen) return false;
  return openPatternProperties(ctx, gen);
}
/**
 * PCB_TUNING_PATTERN::ShowPropertiesDialog: Tuning Pattern Properties prefilled from the pattern (a custom rule's
 * length / skew prefills the target unless the pattern overrides custom rules); OK re-tunes it in one commit,
 * "Edit Tuning Pattern".
 */
export function openPatternProperties(ctx: PcbCtx, gen: KItem) {
  if (!routingDialogs.tuning) { ctx.toast("Tuning Pattern Properties: dialogs are unavailable here"); return true; }
  const info = tuningPatternInfo(gen); const mode = info.mode === "diff_pair_skew" ? "skew" : "single"; const st = tuneCopy(info.st);
  if (!st.overrideCustomRules && S.ruleConstraint) {
    const mem = K.groupMemberIds(gen.node).map((id) => ctx.doc.items.get(id)).filter((it) => it && (it.kind === "segment" || it.kind === "arc")) as KItem[];
    const c = S.ruleConstraint(ctx.doc, mode === "skew" ? "skew" : "length", mem[0] || null, null);
    if (c && c.opt != null) { if (mode === "skew") setTargetSkew(st, Math.round(c.opt * TUNE_IU)); else setTargetLength(st, Math.round(c.opt * TUNE_IU)); if (mode !== "skew" && c.min != null && c.max != null) st.target = { min: Math.round(c.min * TUNE_IU), opt: Math.round(c.opt * TUNE_IU), max: Math.round(c.max * TUNE_IU) }; }
  }
  routingDialogs.tuning({ mode: info.mode === "diff_pair_skew" ? "diff_pair_skew" : info.mode === "diff_pair" ? "diff_pair" : "single", settings: tuneSettingsView(st, mode) }, (v) => {
    const c = lastCtx || ctx; const cur = c.doc.items.get(gen.id); if (!cur || !canEdit(c)) return;
    const next = tuneCopy(st); applyTuneSettings(next, v, mode); next.initialSide = st.initialSide;
    editTuningPattern(c, cur, tuningNodeWithSettings(cur.node, next, info.mode)); c.requestRender();
  });
  return true;
}
act("spacingIncrease", "Increase Spacing", "1", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "spacing", 1) : false, { menu: false, tip: "Increase tuning pattern spacing by one step." });
act("spacingDecrease", "Decrease Spacing", "2", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "spacing", -1) : false, { menu: false, tip: "Decrease tuning pattern spacing by one step." });
act("amplIncrease", "Increase Amplitude", "3", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "ampl", 1) : false, { menu: false, tip: "Increase tuning pattern amplitude by one step." });
act("amplDecrease", "Decrease Amplitude", "4", (ctx: PcbCtx) => isTuneTool(S.modTool) ? tuneStep(ctx, "ampl", -1) : false, { menu: false, tip: "Decrease tuning pattern amplitude by one step." });
// GENERATOR_TOOL: Edit > Update All Tuning Patterns (and Tools > Rebuild All / Selected Generators where shown)
act("regenerateAllTuning", "Update All Tuning Patterns", "", (ctx: PcbCtx) => regenerateTuning(ctx, [...ctx.doc.items.values()].filter(isTuningPattern), "Update Tuning Patterns"), { menu: false, tip: "Attempt to re-tune existing tuning patterns within their bounds" });
act("regenerateAll", "Rebuild All Generators", "", (ctx: PcbCtx) => regenerateTuning(ctx, [...ctx.doc.items.values()].filter(isTuningPattern), "Regenerate All"), { menu: false, tip: "Rebuilds geometry of all generators" });
act("regenerateSelected", "Rebuild Selected Generators", "", (ctx: PcbCtx) => { const sel = expandGroups(ctx.doc, selectionIds(ctx)); return regenerateTuning(ctx, [...sel].map((id) => ctx.doc.items.get(id)).filter(isTuningPattern), "Regenerate Selected"); }, { menu: false, tip: "Rebuilds geometry of selected generator(s)" });
// handlePnSCornerModeChange: Ctrl+/ steps MITERED_45 → ROUNDED_45 → MITERED_90 → ROUNDED_90
act("ACT_SwitchCornerModeToNext", "Track Corner Mode Switch", "", () => { setRouterSettings({ corner_mode: (S.rs.corner_mode + 1) % 4 }); return true; }, Object.assign({ tip: "Switches between sharp/rounded and 45°/90° corners when routing tracks." }, ROUTER_ACTION));
act("ACT_SwitchCornerMode45", "Track Corner Mode 45", "", () => { setRouterSettings({ corner_mode: CM_M45 }); return true; }, Object.assign({ tip: "Switch to 45° corner when routing tracks.", check: () => S.rs.corner_mode === CM_M45 }, ROUTER_ACTION));
act("ACT_SwitchCornerModeArc45", "Track Corner Mode Arc 45", "", () => { setRouterSettings({ corner_mode: CM_R45 }); return true; }, Object.assign({ tip: "Switch to arc 45° corner when routing tracks.", check: () => S.rs.corner_mode === CM_R45 }, ROUTER_ACTION));
act("ACT_SwitchCornerMode90", "Track Corner Mode 90", "", () => { setRouterSettings({ corner_mode: CM_M90 }); return true; }, Object.assign({ tip: "Switch to 90° corner when routing tracks.", check: () => S.rs.corner_mode === CM_M90 }, ROUTER_ACTION));
act("ACT_SwitchCornerModeArc90", "Track Corner Mode Arc 90", "", () => { setRouterSettings({ corner_mode: CM_R90 }); return true; }, Object.assign({ tip: "Switch to arc 90° corner when routing tracks.", check: () => S.rs.corner_mode === CM_R90 }, ROUTER_ACTION));
export const routingOnly = (ctx: PcbCtx, fn: () => void) => { if (!S.route) return false; if (!canEdit(ctx)) return true; fn(); return true; };
act("ACT_PlaceThroughVia", "Place Through Via", "", (ctx: PcbCtx) => {
  if (S.route) return routingOnly(ctx, () => toggleViaPlacement(ctx, "through"));
  if (S.modTool === "routediff") return true;   // the pair's vias come with a route (DIFF_PAIR_PLACER::ToggleVia)
  if (S.modTool !== "route") return false;
  startWithVia(ctx); return true;
}, Object.assign({ tip: "Adds a through-hole via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_PlaceBlindVia", "Place Blind/Buried Via", "", (ctx: PcbCtx) => routingOnly(ctx, () => toggleViaPlacement(ctx, "blind")), Object.assign({ tip: "Adds a blind or buried via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_PlaceMicroVia", "Place Microvia", "", (ctx: PcbCtx) => routingOnly(ctx, () => toggleViaPlacement(ctx, "micro")), Object.assign({ tip: "Adds a microvia at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_SelLayerAndPlaceThroughVia", "Select Layer and Place Through Via...", "", (ctx: PcbCtx) => routingOnly(ctx, () => selectLayerAndPlaceVia(ctx, "through")), Object.assign({ tip: "Select a layer, then add a through-hole via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_SelLayerAndPlaceBlindVia", "Select Layer and Place Blind/Buried Via...", "", (ctx: PcbCtx) => routingOnly(ctx, () => selectLayerAndPlaceVia(ctx, "blind")), Object.assign({ tip: "Select a layer, then add a blind or buried via at the end of currently routed track." }, ROUTER_ACTION));
act("ACT_SelLayerAndPlaceMicroVia", "Select Layer and Place Micro Via...", "", (ctx: PcbCtx) => routingOnly(ctx, () => selectLayerAndPlaceVia(ctx, "micro")), Object.assign({ tip: "Select a layer, then add a micro via at the end of currently routed track." }, ROUTER_ACTION));
act("routerDiffPairDialog", "Differential Pair Dimensions...", "", (ctx: PcbCtx) => { if (routingDialogs.diffPair) routingDialogs.diffPair(ctx); else ctx.toast("Differential Pair Dimensions: dialogs are unavailable here"); return true; }, Object.assign({ tip: "Open Differential Pair Dimension settings" }, ROUTER_ACTION));
act("routerAttemptFinish", "Attempt Finish", "F", (ctx: PcbCtx) => (S.route ? (attemptFinish(ctx), true) : false), Object.assign({ tip: "Attempts to complete current route to nearest ratsnest end." }, ROUTER_ACTION));
act("routerContinueFromEnd", "Route From Other End", "Ctrl+E", (ctx: PcbCtx) => (S.route ? (continueFromEnd(ctx), true) : false), Object.assign({ tip: "Commits current segments and starts next segment from nearest ratsnest end." }, ROUTER_ACTION));
act("routerRouteSelected", "Route Selected", "Shift+X", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; routeSelected(ctx, "manual"); return true; }, { menu: false, tip: "Sequentially route selected items from ratsnest anchor" });
act("routerRouteSelectedFromEnd", "Route Selected From Other End", "Shift+E", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; routeSelected(ctx, "otherEnd"); return true; }, { menu: false, tip: "Sequentially route selected items to ratsnest anchor" });
act("routerAutorouteSelected", "Attempt Finish Selected (Autoroute)", "Shift+F", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; routeSelected(ctx, "auto"); return true; }, { menu: false, tip: "Sequentially trigger routing and attempt to finish all selected items" });
act("routerOptimizeSelected", "Optimize Selected Track(s)", "Shift+T", (ctx: PcbCtx) => { if (S.route || S.draw || S.move || !canEdit(ctx)) return false; return optimizeSelected(ctx); }, { menu: false, tip: "Simplify selected routed track(s)." });
act("unrouteSegment", "Unroute Segment", "Backspace", (ctx: PcbCtx) => (S.route || S.draw || S.move || !canEdit(ctx) ? false : unrouteSegment(ctx)), { menu: false, tip: "Unroutes the selected track segment and selects the connected tracks" });
// PCB_CONTROL::CycleLayerPresets and SnapMode (global hotkeys, no menu entry in pcbnew)
act("layerPairPresetsCycle", "Cycle Layer Pair Presets", "Shift+V", (ctx: PcbCtx) => { cycleLayerPairPresets(ctx); return true; }, { menu: false, tip: "Cycle between preset layer pairs" });
act("magneticSnapToggle", "Toggle Snapping Between Active and All Layers", "Shift+S", (ctx: PcbCtx) => setSnapMode(ctx, "toggle"), { menu: false, tip: "Toggles between snapping on all visible layers and only the active area" });
act("magneticSnapActiveLayer", "Snap to Objects on the Active Layer Only", "", (ctx: PcbCtx) => setSnapMode(ctx, "active"), { menu: false, tip: "Enables snapping to objects on the active layer only" });
act("magneticSnapAllLayers", "Snap to Objects on All Layers", "", (ctx: PcbCtx) => setSnapMode(ctx, "all"), { menu: false, tip: "Enables snapping to objects on all visible layers" });
act("cancelCurrentItem", "Cancel Current Item", "", (ctx: PcbCtx) => cancelCurrentItem(ctx), { menu: false, tip: "Skip current item and route next selected item." });
act("routerUndoLastSegment", "Undo Last Segment", "", (ctx: PcbCtx) => routingOnly(ctx, () => undoRouteLeg(ctx)), Object.assign({ tip: "Walks the current track back one segment." }, ROUTER_ACTION));
act("selectLayerPair", "Set Layer Pair...", "", (ctx: PcbCtx) => { if (routingDialogs.layerPair) routingDialogs.layerPair(ctx); else ctx.toast("Set Layer Pair: dialogs are unavailable here"); return true; }, { menu: "-" });
act("editPredefinedSizes", "Edit Pre-defined Sizes...", "", (ctx: PcbCtx) => { if (routingDialogs.sizes) routingDialogs.sizes(ctx); else ctx.toast("Edit Pre-defined Sizes: dialogs are unavailable here"); return true; }, { menu: "-" });
// the grid origin and the drill / place file origin: picked with a one-shot tool, reset to the page origin
// COMMON_TOOLS::GridOrigin: WX_PT_ENTRY_DIALOG "Grid Origin" (X: / Y: in the user's units, Reset sets both to 0)
act("gridOrigin", "Grid Origin...", "", (ctx: PcbCtx) => { openGridOrigin(ctx); return true; }, { menu: false, tip: "Set the grid origin point" });
act("gridResetOrigin", "Reset Grid Origin", "", (ctx: PcbCtx) => { sizesOf(ctx).setGridOrigin([0, 0]); ctx.toast("Grid origin reset"); ctx.requestRender(); return true; }, { menu: "-" });
act("drillResetOrigin", "Reset Drill Origin", "", (ctx: PcbCtx) => { if (canEdit(ctx)) { sizesOf(ctx).setAuxOrigin([0, 0]); ctx.toast("Drill/place file origin reset"); ctx.requestRender(); } return true; }, { menu: "-" });
/**
 * EDIT_TOOL::ChangeTrackLayer (Ctrl++ / Ctrl+-): not while routing; the selected tracks (or the one under the cursor,
 * locks honoured) are taken first, then the active layer steps (layerNext / layerPrev) and, when it changed, every
 * selected track and arc goes onto the new active layer - "Edit Track Layer".  A hover selection is cleared.
 */
export function changeTrackLayer(ctx: PcbCtx, next: boolean, id: string) {
  if (S.route) return true;
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { filter: isTrackKind, rerun: (c: PcbCtx) => runAction(id, c) });
  const R = sizesOf(ctx), from = R.activeLayer || S.layer; stepLayer(ctx, next); const to = R.activeLayer || S.layer;
  if (!sel || !to || to === from) return true;
  const ch = trackLayerChanges(ctx.doc, sel.ids, 0, to); if (ch.length) ctx.commit(ch, "Edit Track Layer");
  endHover(ctx, sel); ctx.requestRender(); return true;
}
act("changeTrackLayerNext", "Switch Track to Next Layer", "Ctrl++", (ctx: PcbCtx) => changeTrackLayer(ctx, true, "changeTrackLayerNext"), { tip: "Switch track to next enabled copper layer" });
act("changeTrackLayerPrev", "Switch Track to Previous Layer", "Ctrl+-", (ctx: PcbCtx) => changeTrackLayer(ctx, false, "changeTrackLayerPrev"), { tip: "Switch track to previous enabled copper layer" });
act("cleanupTracks", "Cleanup Tracks & Vias…", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc;
  const settings = settingsOf(ctx), selNow = new Set(expandGroups(doc, Array.from(S.sel)));
  const netName = (it: KItem): string => netOf(it.node).name;
  const layerOf = (it: KItem): string => { const l = K.kid(it.node, "layer"); if (l) return K.str(l[1]); const ls = K.kid(it.node, "layers"); return ls ? K.str(ls[1]) : ""; };
  // DIALOG_CLEANUP_TRACKS_AND_VIAS::doCleanup's filter: true leaves the item alone
  const opts = (o: CleanupDialogOpts): CleanupOpts => ({ shorts: o.shorts, vias: o.vias, danglingVias: o.danglingVias, merge: o.merge, dangling: o.dangling, inPads: o.inPads,
    filter: (it: KItem) => (o.selectedOnly && !selNow.has(it.id)) || (o.net !== null && netName(it) !== o.net) || (o.netclass !== null && netclassName(settings, netName(it)) !== o.netclass) || (o.layer !== null && layerOf(it) !== o.layer) });
  const req: CleanupRequest = {
    nets: boardNets(doc).map((n) => n.name), netclasses: ["Default", ...Object.keys(settings.netclasses).filter((n) => n !== "Default")], copper: copperOf(doc),
    activeLayer: ctx.activeLayer || S.layer, highlightNet: typeof S.highlightNet === "string" ? S.highlightNet : null, currentNetclass: "Default",
    plan: (o) => cleanupPlan(doc, opts(o)).items.map((i) => ({ text: i.text, ids: i.ids })),
    apply: (o) => {
      applySelection(ctx, []); highlightIds(ctx, null);
      const plan = cleanupPlan(doc, opts(o)); const ch = cleanupChanges(doc, plan);
      if (ch.length) ctx.commit(ch, "Board Cleanup");
      if (o.refill) runAction("zoneFillAll", ctx);
      ctx.requestRender(); return plan.items.length;
    },
    focus: (ids) => highlightIds(ctx, ids ? new Set(ids) : null) };
  if (routingDialogs.cleanup) { routingDialogs.cleanup(req); return true; }
  const all: CleanupDialogOpts = { shorts: true, vias: true, danglingVias: true, merge: true, dangling: true, inPads: false, refill: false, net: null, netclass: null, layer: null, selectedOnly: false };
  const preview = req.plan(all);
  const labels: [keyof CleanupDialogOpts, string][] = [["shorts", "Delete tracks connecting different nets"], ["vias", "Delete redundant vias"], ["danglingVias", "Delete vias connected on only one layer"], ["merge", "Merge co-linear tracks"], ["dangling", "Delete tracks unconnected at one end"], ["inPads", "Delete tracks fully inside pads"]];
  return openForm({ title: "Cleanup Tracks and Vias", width: 480, fields: labels.map(([k, label]): FormField => ({ k, label, type: "check", value: all[k] as boolean })).concat([{ k: "list", type: "table", columns: [{ label: "Action", width: "1fr" }, { label: "Items", width: "60px" }], rows: preview.map((i) => [i.text, i.ids.length]), empty: "No changes.", onRow: (i: number) => req.focus(preview[i].ids) }]),
    apply: (v: Record<string, boolean>) => { req.apply(Object.assign({}, all, v)); } });
});
alias("cleanupTracksAndVias", "cleanupTracks");
act("breakTrack", "Break Track", "", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; const seg = selectedItems(ctx).find((it) => it.kind === "segment"); return commitSel(ctx, breakTrackChanges(ctx.doc, cursorPoint(ctx), seg && hitTestItem(ctx.doc, cursorPoint(ctx)[0], cursorPoint(ctx)[1], 0.3) === seg ? seg : null), "break track"); });
// PCB_SELECTION_TOOL::unrouteSelected: the tracks from the selection's pads and connected items up to the next pads
// go; the footprints and pads that were selected are selected again; one "Unroute Selected" step
act("unrouteSelected", "Unroute Selected", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const ids = Array.from(selectionIds(ctx)), pads = { sel: S.padSel, also: S.padAlso };
  const remove = unrouteIds(ctx.doc, ids.concat(padSelKeys()), ctx.selFilter);
  const keep = ids.filter((id) => { const it = ctx.doc.items.get(id); return !!it && it.kind === "footprint"; });
  if (remove.size) ctx.commit(deleteChanges(ctx.doc, Array.from(remove)), "Unroute Selected");
  applySelection(ctx, keep); S.padSel = pads.sel; S.padAlso = pads.also; ctx.requestRender(); return true;
});
act("deleteFull", "Delete Full Track", "Shift+Delete", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select a track first"); if (!ids) return true; const run = connectedRun(ctx.doc, ids); for (const id of ids) run.add(id); S.sel.clear(); return commitSel(ctx, deleteChanges(ctx.doc, Array.from(run)), "delete full track"); });
// inspection
act("runDRC", "Design Rules Checker…", "", (ctx: PcbCtx) => {
  bind(ctx); const s = settingsOf(ctx); S.markers = drc(ctx.doc, s, { rules: S.dru ? S.dru.rules : null }).concat(S.dru ? matchedLengthMarkers(ctx.doc, s, S.dru.rules).concat(diffPairMarkers(ctx.doc, s, S.dru.rules)) : []); ctx.requestRender();
  const errors = S.markers.filter((m) => m.severity === "error").length, warnings = S.markers.length - errors;
  openForm({ title: "DRC Control", width: 620, fields: [{ type: "note", value: `${plural(errors, "error")}, ${plural(warnings, "warning")} — click a row to highlight it.` }, { k: "list", type: "table", columns: [{ label: "Severity", width: "70px" }, { label: "Violation", width: "1fr" }], rows: S.markers.map((m) => [m.severity, m.text]), empty: "No violations found.", onRow: (i: number) => { highlightIds(ctx, new Set(S.markers[i].ids)); if (ctx.setSelection && S.markers[i].ids.length) applySelection(ctx, S.markers[i].ids); } }], apply: () => { highlightIds(ctx, null); } });
  return true;
});
act("clearMarkers", "Clear DRC Markers", "", (ctx: PcbCtx) => { S.markers = []; ctx.requestRender(); return true; });
act("netInspector", "Net Inspector…", "", (ctx: PcbCtx) => {
  const rows = netInspector(ctx.doc);
  return openForm({ title: "Net Inspector", width: 640, fields: [{ k: "list", type: "table", columns: [{ label: "Name", width: "2fr" }, { label: "Pads", width: "50px" }, { label: "Vias", width: "50px" }, { label: "Track length", width: "100px" }, { label: "Unconnected", width: "90px" }], rows: rows.map((r) => [r.name, r.padCount, r.viaCount, fmt(r.trackLength) + " mm", r.unconnected]), empty: "No nets on this board.", onRow: (i: number) => highlightIds(ctx, netHighlightIds(ctx.doc, rows[i].name)) }], apply: () => { highlightIds(ctx, null); } });
});
alias("showNetInspector", "netInspector");
act("boardStatistics", "Board Statistics…", "", (ctx: PcbCtx) => {
  const s = boardStatistics(ctx.doc);
  return openForm({ title: "Board Statistics", width: 440, fields: [{ k: "list", type: "table", columns: [{ label: "Item", width: "1fr" }, { label: "Count", width: "120px" }], rows: [["Footprints (front / back)", `${s.footprints.total} (${s.footprints.front} / ${s.footprints.back})`], ["Footprints SMD / THT / other", `${s.footprints.smd} / ${s.footprints.tht} / ${s.footprints.other}`], ["Pads SMD / THT / NPTH", `${s.pads.smd} / ${s.pads.tht} / ${s.pads.npth}`], ["Vias through / blind / micro", `${s.vias.through} / ${s.vias.blind} / ${s.vias.micro}`], ["Tracks (count, length)", `${s.tracks.count}, ${fmt(s.tracks.length)} mm`], ["Zones", s.zones], ["Drill holes", s.drills], ["Board size", `${fmt(s.width)} × ${fmt(s.height)} mm`], ["Board area", `${fmt(s.area)} mm²`]] }] });
});
act("inspectClearance", "Clearance Resolution…", "", (ctx: PcbCtx) => {
  const ids = Array.from(selectionIds(ctx)); if (ids.length !== 2) { ctx.toast("Select exactly two copper items"); return true; }
  const r = inspectClearance(ctx.doc, ids[0], ids[1], settingsOf(ctx)); if (!r) { ctx.toast("Both items need copper"); return true; }
  return openForm({ title: "Clearance Report", fields: [{ type: "note", value: r.sameNet ? `Both items are on net '${r.nets[0]}': no clearance applies.` : r.gap === null ? "The items share no copper layer." : `Clearance required ${mm4(r.required)}; actual ${mm4(r.gap)} — ${r.gap >= r.required ? "OK" : "VIOLATION"}` }] });
});
act("showRatsnest", "Show Ratsnest", "", (ctx: PcbCtx) => { S.showRatsnest = !S.showRatsnest; ctx.requestRender(); return true; }, { toggle: () => !!S.showRatsnest });
act("localRatsnestTool", "Local Ratsnest (selected footprints only)", "", (ctx: PcbCtx) => { S.localRatsnest = !S.localRatsnest; ctx.toast(S.localRatsnest ? "Ratsnest: selected footprints only" : "Ratsnest: whole board"); ctx.requestRender(); return true; }, { toggle: () => !!S.localRatsnest });
// BOARD_INSPECTION_TOOL::HideNetInRatsnest / ShowNetInRatsnest: the nets of the selected connected items; silent, and
// nothing selected on a net changes nothing.  The Appearance panel's net list follows (OnNetVisibilityChanged).
function setRatsnestNets(ctx: PcbCtx, visible: boolean) {
  const nl = netlist(ctx.doc); const keys = selectionNets(ctx, nl); if (!keys.size) return true;
  for (const k of keys) { if (visible) S.hiddenNets.delete(k); else S.hiddenNets.add(k); }
  if (ctx.setNetsVisible) ctx.setNetsVisible(Array.from(keys), visible);
  ctx.requestRender(); return true;
}
act("hideNetInRatsnest", "Hide Net in Ratsnest", "", (ctx: PcbCtx) => setRatsnestNets(ctx, false));
act("showNetInRatsnest", "Show Net in Ratsnest", "", (ctx: PcbCtx) => setRatsnestNets(ctx, true));
/**
 * BOARD_INSPECTION_TOOL::highlightNet( aPosition, aUseSelection ).  Plain Highlight Net (`, Ctrl+click) takes the
 * copper under the MOUSE (GetMousePosition: not the snapped cursor, which can sit on a neighbouring track), whatever
 * is selected.  Highlight Net of Selection takes the nets of the selected connected items (pads, tracks, arcs, vias,
 * zones, shapes): a footprint is no BOARD_CONNECTED_ITEM, so a selected footprint adds no nets and the mouse decides.
 */
export function highlightNetAt(ctx: PcbCtx, at?: Pt | null, useSelection = false) {
  bind(ctx);
  const nl = netlist(ctx.doc); let keys = new Set<string>();
  if (useSelection) for (const it of selectedItems(ctx)) { if (it.kind !== "footprint" && K.kid(it.node, "net")) { const k = nl.table.key(netOf(it.node)); if (k) keys.add(k); } }
  if (useSelection && S.padSel) { const i = S.padSel.lastIndexOf("#"), fp = ctx.doc.items.get(S.padSel.slice(0, i)), pad = fp && padsOf(fp)[+S.padSel.slice(i + 1)]; const k = pad && nl.table.key(pad.net); if (k) keys.add(k); }
  if (!keys.size) { const p = at || (ctx.cursor ? ctx.cursor.slice() as Pt : cursorPoint(ctx)); const k = nl.table.key(netUnder(ctx.doc, p[0], p[1], null)); if (k) keys = new Set([k]); }
  // m_lastHighlighted takes the nets that were showing whenever the highlight changes; m_currentlyHighlighted the new ones
  const shown = shownHighlight();
  if (!keys.size) { if (shown.length) S.hlLast = shown; S.hlCurrent = []; showHighlight(ctx, []); return true; }
  const key = keys.values().next().value; if (keys.size === 1 && S.highlightNet === key) { if (shown.length) S.hlLast = shown; S.hlCurrent = []; showHighlight(ctx, []); return true; }
  if (shown.length) S.hlLast = shown;
  S.hlCurrent = Array.from(keys); showHighlight(ctx, S.hlCurrent, nl); return true;   // no infobar: the net shows in the message panel
}
/** The nets the canvas highlights now (RENDER_SETTINGS::GetHighlightNetCodes: empty while the highlight is off). */
function shownHighlight(): string[] { return S.highlightNet ? (S.hlShown.length ? S.hlShown.slice() : [S.highlightNet]) : []; }
/** RENDER_SETTINGS::SetHighlight( nets, enabled ): these nets are highlighted, or with none the highlight is off. */
function showHighlight(ctx: PcbCtx, keys: string[], nl?: ReturnType<typeof netlist>) {
  S.hlShown = keys.slice(); S.highlightNet = keys.length ? keys[0] : null;
  if (!keys.length) { highlightIds(ctx, null); return; }
  const n = nl || netlist(ctx.doc); const ids = new Set<string>(); for (const k of keys) for (const id of netHighlightIds(ctx.doc, k, n)) ids.add(id);
  highlightIds(ctx, ids, keys);
}
act("highlightNet", "Highlight Net", "`", (ctx: PcbCtx) => highlightNetAt(ctx));
act("highlightNetSelection", "Highlight Net of Selection", "", (ctx: PcbCtx) => highlightNetAt(ctx, null, true));
act("clearHighlight", "Clear Net Highlighting", "~", (ctx: PcbCtx) => { S.hlCurrent = []; S.hlLast = []; showHighlight(ctx, []); return true; });
// BOARD_INSPECTION_TOOL::HighlightNet, toggleNetHighlight: the current highlight goes off, and comes back on the next press
act("toggleNetHighlight", "Toggle Net Highlight", "Alt+`", (ctx: PcbCtx) => { bind(ctx); const turnOn = !shownHighlight().length && S.hlCurrent.length > 0; showHighlight(ctx, turnOn ? S.hlCurrent : []); return true; });
// toggleLastNetHighlight: the nets highlighted before the current ones come back, and the two sets swap
act("toggleLastNetHighlight", "Toggle Last Net Highlight", "", (ctx: PcbCtx) => { bind(ctx); const temp = shownHighlight(); showHighlight(ctx, S.hlLast); S.hlCurrent = S.hlLast.slice(); S.hlLast = temp; return true; });
// groups and locks
export const GROUP_MSG_FOOTPRINT = "Footprint items cannot be grouped separately from their parent footprint.";
export const GROUP_MSG_TYPE = "Some selected items cannot be grouped.";
/**
 * The selection as KiCad holds it: a member of a group that is not entered stands for its outermost group (the web
 * selection lists the members beside it), each item once.
 */
export function selectionUnits(ctx: PcbCtx): KItem[] {
  const out = new Map<string, KItem>();
  for (const id of selectionIds(ctx)) { const it = topParentOf(ctx.doc, id) || ctx.doc.items.get(id); if (it) out.set(it.id, it); }
  return Array.from(out.values());
}
/**
 * What the context menus ask of the selection.  GROUP_CONTEXT_MENU::update: how many items, whether a group is among
 * them (and only one), whether anything else is, and whether an item has a parent group.  ZONE_PRIORITY_CONTEXT_MENU::
 * update: whether a zone overlapping the one selected zone has a higher / lower priority.
 */
export function menuState(ctx: PcbCtx) {
  const grouping = { count: 0, hasGroup: false, onlyOneGroup: false, hasNonGroup: false, hasMember: false };
  if (!ctx.doc) return { grouping, zoneCanRaise: false, zoneCanLower: false };
  const units = selectionUnits(ctx);
  for (const it of units) {
    grouping.count++;
    if (it.kind === "group") { if (grouping.hasGroup) grouping.onlyOneGroup = false; else { grouping.onlyOneGroup = true; grouping.hasGroup = true; } }
    else grouping.hasNonGroup = true;
    if (parentOf(ctx.doc, it.id)) grouping.hasMember = true;
  }
  if (!units.length && S.padSel) { grouping.count += 1 + (S.padAlso && S.padAlso.anchor === S.padSel ? S.padAlso.keys.filter((k) => k !== S.padSel).length : 0); grouping.hasNonGroup = true; }
  const a = zonePriorityAbility(ctx.doc, units.map((it) => it.id));
  return { grouping, zoneCanRaise: a.canRaise, zoneCanLower: a.canLower };
}
/** PCB_GROUP_TOOL::canGroupItem (BOARD_ITEM::IsGroupableType): the message when the item cannot be in a group, else "". */
function cannotGroup(it: KItem): string { return it.kind === "target" || it.kind === "marker" ? GROUP_MSG_TYPE : ""; }
/** A pad or field picked on its own in the board editor is a footprint child: it cannot be grouped apart from its footprint. */
const footprintChildPicked = (ctx: PcbCtx) => !ctx.doc.fpEditor && (!!S.padSel || !!(typeof ctx.selectedField === "function" && ctx.selectedField()));
/**
 * Membership edits as one set of changes: per group the ids joining and leaving.  A group left without members is
 * removed (and leaves its own parent group).
 */
function membershipChanges(doc: BoardDoc, edits: Map<string, { add: string[]; remove: string[] }>): PcbChange[] {
  const out: PcbChange[] = []; const todo = new Map(edits);
  for (let guard = 0; todo.size && guard < 64; guard++) {
    const [gid, e] = todo.entries().next().value as [string, { add: string[]; remove: string[] }]; todo.delete(gid);
    const g = doc.items.get(gid); if (!g) continue;
    const ch = groupMembersChanges(doc, g, e.add, e.remove); out.push(...ch);
    if (ch.length && ch[0].kind === "REMOVED") { const p = parentOf(doc, gid); if (p) { const pe = todo.get(p.id) || { add: [], remove: [] }; pe.remove.push(gid); todo.set(p.id, pe); } }
  }
  return out;
}
/** Select whole units (a group with its members, as a click on a member does). */
const selectUnits = (ctx: PcbCtx, ids: string[]) => applySelection(ctx, ids.length ? expandGroups(ctx.doc, ids) : []);
// PCB_GROUP_TOOL::Group: at least two groupable items; the new group is locked when a member is; a member leaves the
// group it was in (so groups nest); afterwards the new group is the selection.  Commit "Group Items".
act("group", "Group Items", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc;
  let errorMsg = footprintChildPicked(ctx) ? GROUP_MSG_FOOTPRINT : "";
  const units = selectionUnits(ctx).filter((it) => { const m = cannotGroup(it); if (m) errorMsg = m; return !m; });
  if (units.length < 2) { if (errorMsg) ctx.toast(errorMsg); return true; }
  const ids = units.map((it) => it.id); const node = groupNode("", ids); if (units.some((it) => isLocked(it.node))) setLocked(node, true);
  const edits = new Map<string, { add: string[]; remove: string[] }>();
  for (const id of ids) { const old = parentOf(doc, id); if (old) { const e = edits.get(old.id) || { add: [], remove: [] }; e.remove.push(id); edits.set(old.id, e); } }
  const added = addedChange(doc, node);
  // BOARD_COMMIT::Push: a new item with no parent group joins the entered group
  const eg = enteredGroup(doc); if (eg) { const e = edits.get(eg) || { add: [], remove: [] }; e.add.push(added.id); edits.set(eg, e); }
  ctx.commit([added as PcbChange].concat(membershipChanges(doc, edits)), "Group Items"); selectUnits(ctx, [added.id]);
  if (errorMsg) ctx.toast(errorMsg);
  return true;
});
// GROUP_TOOL::Ungroup: only the selected groups are dissolved; their former members end up selected.  "Ungroup Items".
act("ungroup", "Ungroup Items", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc;
  const groups = selectionUnits(ctx).filter((it) => it.kind === "group" || it.kind === "generated"); if (!groups.length) return true;
  const out: PcbChange[] = [], toSelect: string[] = [], edits = new Map<string, { add: string[]; remove: string[] }>();
  for (const g of groups) {
    out.push(removedChange(g)); toSelect.push(...groupMembers(g.node));
    const p = parentOf(doc, g.id); if (p) { const e = edits.get(p.id) || { add: [], remove: [] }; e.remove.push(g.id); edits.set(p.id, e); }
  }
  ctx.commit(out.concat(membershipChanges(doc, edits)), "Ungroup Items"); selectUnits(ctx, toSelect.filter((id) => doc.items.has(id))); return true;
});
// GROUP_TOOL::AddToGroup: exactly one selected group and at least one other groupable item; an item leaves the group it
// was in; afterwards the group is the selection.  "Add Items to Group".
act("addToGroup", "Add Items to Group", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc;
  let group: KItem | null = null, errorMsg = footprintChildPicked(ctx) ? GROUP_MSG_FOOTPRINT : ""; const toAdd: KItem[] = [];
  for (const it of selectionUnits(ctx)) {
    if (it.kind === "group") { if (group) return true; group = it; }   // only one group may be selected
    else { const m = cannotGroup(it); if (m) errorMsg = m; else toAdd.push(it); }
  }
  if (!group || !toAdd.length) { if (errorMsg) ctx.toast(errorMsg); return true; }
  const edits = new Map<string, { add: string[]; remove: string[] }>([[group.id, { add: [], remove: [] }]]);
  for (const it of toAdd) {
    const old = parentOf(doc, it.id); if (old && old.id === group.id) continue;
    if (old) { const e = edits.get(old.id) || { add: [], remove: [] }; e.remove.push(it.id); edits.set(old.id, e); }
    edits.get(group.id)!.add.push(it.id);
  }
  const ch = membershipChanges(doc, edits); if (ch.length) ctx.commit(ch, "Add Items to Group");
  selectUnits(ctx, [group.id]); if (errorMsg) ctx.toast(errorMsg);
  return true;
});
// GROUP_TOOL::RemoveFromGroup: each selected item leaves its parent group; a group left empty is removed; afterwards
// nothing is selected (the items are no longer members of the entered group).  "Remove Group Items".
act("removeFromGroup", "Remove Items from Group", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true; const doc = ctx.doc; const edits = new Map<string, { add: string[]; remove: string[] }>();
  for (const it of selectionUnits(ctx)) { const g = parentOf(doc, it.id); if (g) { const e = edits.get(g.id) || { add: [], remove: [] }; e.remove.push(it.id); edits.set(g.id, e); } }
  if (!edits.size) return true;
  ctx.commit(membershipChanges(doc, edits), "Remove Group Items"); applySelection(ctx, []); return true;
});
// PCB_SELECTION_TOOL::EnterGroup / ExitGroup
act("enterGroup", "Enter Group", "", (ctx: PcbCtx) => { const g = selectedTopGroup(ctx); if (!g) { ctx.toast("Select a group to enter"); return true; } enterGroup(ctx, g); return true; }, { tip: "Enter the group to edit items" });
act("leaveGroup", "Leave Group", "", (ctx: PcbCtx) => { if (!exitGroup(ctx, true)) ctx.toast("No group is entered"); return true; }, { tip: "Leave the current group" });
// BOARD_EDITOR_CONTROL::modifyLockSelected: the selection or the item under the cursor (a hover selection is cleared
// afterwards).  Toggle unlocks when anything in it is locked, else locks.  Commit "Lock" / "Unlock".
function modifyLock(ctx: PcbCtx, mode: "toggle" | "on" | "off", id: string) {
  if (!canEdit(ctx)) return true;
  const sel = requestSelection(ctx, { locks: false, rerun: (c: PcbCtx) => runAction(id, c) }); if (!sel) return true;
  const on = mode === "toggle" ? !sel.ids.some((i) => isLocked(ctx.doc.items.get(i)!.node)) : mode === "on";
  const ch = lockChanges(ctx.doc, sel.ids, on); if (ch.length) ctx.commit(ch, on ? "Lock" : "Unlock");
  endHover(ctx, sel); ctx.requestRender(); return true;
}
act("toggleLock", "Toggle Lock", "L", (ctx: PcbCtx) => modifyLock(ctx, "toggle", "toggleLock"));
act("lock", "Lock", "", (ctx: PcbCtx) => modifyLock(ctx, "on", "lock"));
act("unlock", "Unlock", "", (ctx: PcbCtx) => modifyLock(ctx, "off", "unlock"));
// footprint attributes, text, conversions, zones
act("toggleExcludeFromBOM", "Exclude from Bill of Materials", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_bom"), "Toggle Attribute"); });
act("toggleExcludeFromPosFiles", "Exclude from Position Files", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_pos_files"), "Toggle Attribute"); });
act("toggleExcludeFromSim", "Exclude from Simulation", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "exclude_from_sim"), "Toggle Attribute"); });
act("toggleDNP", "Do Not Populate", "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select footprints first"); if (!ids) return true; return commitSel(ctx, footprintAttrChanges(ctx.doc, ids, "dnp"), "Toggle Attribute"); });
for (const [id, how, label] of [["leftJustify", "left", "Left Justify"], ["centerJustify", "center", "Center Justify"], ["rightJustify", "right", "Right Justify"]])
  act(id, label, "", (ctx: PcbCtx) => { const ids = selectionOrToast(ctx, "Select text first"); if (!ids) return true; return commitSel(ctx, justifyChanges(ctx.doc, ids, how), label); });
for (const [id, to, label] of [["convertToPoly", "poly", "Create Polygon from Selection"], ["convertToLines", "lines", "Create Lines from Selection"], ["convertToTracks", "tracks", "Create Tracks from Selection"], ["convertToZone", "zone", "Create Zone from Selection"], ["convertToKeepout", "keepout", "Create Rule Area from Selection"]])
  act(id, label, "", (ctx: PcbCtx) => {
    const ids = selectionOrToast(ctx, "Select graphic shapes first"); if (!ids) return true;
    if (to === "zone") { const items = ids.map((i) => ctx.doc.items.get(i)); const layer = /\.Cu$/.test(layerOf(items[0]!.node, "")) ? layerOf(items[0]!.node) : S.layer; const nets = boardNets(ctx.doc);
      askText(ctx, "Zone net", "", (name: string | null) => { if (name === null) return; const net = name ? (nets.find((n) => n.name === name) || { code: -1, name }) : { code: 0, name: "" }; commitSel(ctx, convertChanges(ctx.doc, ids, "zone", { layer, net }), "zone from shapes"); }, nets.map((n) => n.name)); return true; }
    return commitSel(ctx, convertChanges(ctx.doc, ids, to), label.toLowerCase());
  });
// CONVERT_TOOL::SegmentToArc: the arc is added beside its source ("Create Arc"); nothing fitting selected does nothing
act("convertToArc", "Create Arc from Selection", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const changes = segmentToArcChanges(ctx.doc, Array.from(selectionIds(ctx))); if (!changes.length) return true;
  ctx.commit(changes, "Create Arc"); ctx.requestRender(); return true;
}, { tip: "Creates an arc from the selected line segment" });
// BOARD_EDITOR_CONTROL::ZonePriority*: exactly one selected zone (no rule area, no teardrop); only zones overlapping it
// matter, and nothing happens without one above / below.  Labels as PCB_ACTIONS names them, commits as the tool does.
for (const [id, how, label, commit] of [["zonePriorityMoveToTop", "top", "Move to Top", "Move Zone to Top Priority"], ["zonePriorityRaise", "raise", "Raise", "Raise Zone Priority"], ["zonePriorityLower", "lower", "Lower", "Lower Zone Priority"], ["zonePriorityMoveToBottom", "bottom", "Move to Bottom", "Move Zone to Bottom Priority"]])
  act(id, label, "", (ctx: PcbCtx) => {
    if (!canEdit(ctx)) return true;
    const ch = zonePriorityChanges(ctx.doc, selectionUnits(ctx).map((it) => it.id), how); if (ch.length) { ctx.commit(ch, commit); ctx.requestRender(); }
    return true;
  }, { enabled: (ctx: PcbCtx) => { const a = zonePriorityAbility(ctx.doc, selectionUnits(ctx).map((it) => it.id)); return how === "top" || how === "raise" ? a.canRaise : a.canLower; } });
// BOARD_EDITOR_CONTROL::ZoneMerge: the selection is cleared and the merged zone selected; "Merge Zones"
act("zoneMerge", "Merge Zones", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const units = selectionUnits(ctx); if (units.length < 2) return true;
  const r = zoneMergeChanges(ctx.doc, units.map((it) => it.id));
  applySelection(ctx, []);
  if (r.error) { ctx.toast(r.error); return true; }
  if (r.changes.length) { ctx.commit(r.changes, "Merge Zones"); if (r.merged) applySelection(ctx, [r.merged]); }
  return true;
});
/**
 * DRAWING_TOOL::DrawZone with ZONE_MODE::CUTOUT / SIMILAR: getSourceZoneForAction wants exactly one selected zone (with
 * nothing selected, the zone under the cursor); without one the action does nothing.  The zone tool then runs in
 * that mode (draw-tools.ts / zone-modes.ts).
 */
function zoneModeAction(mode: "cutout" | "similar") {
  return (ctx: PcbCtx) => {
    if (!canEdit(ctx) || S.route || S.move) return true;
    const sel = Array.from(selectionIds(ctx));
    const z = sourceZone(ctx, sel, sel.length ? [] : cursorCandidates(ctx, ctx.cursor ? ctx.cursor.slice() : cursorPoint(ctx)));
    if (!z) return true;
    if (!sel.length) applySelection(ctx, [z.id]);
    S.zoneModeNext = { mode, src: z.id }; ctx.setTool("zone"); return true;
  };
}
act("drawZoneCutout", "Add a Zone Cutout", "Shift+C", zoneModeAction("cutout"), { tip: "Add a cutout to an existing zone or rule area" });
act("drawSimilarZone", "Add a Similar Zone", "Ctrl+Shift+.", zoneModeAction("similar"), { tip: "Add a zone with the same settings as an existing zone" });
// BOARD_EDITOR_CONTROL::ZoneDuplicate: exactly one selected zone; the zone dialog of its kind (copper zone, rule area,
// non-copper zone) opens with its settings, and on OK the copy takes them ("Duplicate Zone")
act("zoneDuplicate", "Duplicate Zone onto Layer...", "", (ctx: PcbCtx) => {
  if (!canEdit(ctx)) return true;
  const units = selectionUnits(ctx); const zone = units.length === 1 && units[0].kind === "zone" ? units[0] : null; if (!zone) return true;
  const done = (edited: SNode | null) => { if (!edited) return; const node = zoneDuplicateNode(ctx.doc, zone, edited); ctx.commit([addedChange(ctx.doc, node, netOf(node))], "Duplicate Zone"); ctx.requestRender(); };
  if (newItemDialogs.zone) newItemDialogs.zone(ctx, clone(zone.node), done); else done(clone(zone.node));
  return true;
});
// PCB_POINT_EDITOR::addCorner / removeCorner on the single selected item, at the cursor
act("pointEditorAddCorner", "Create Corner", "Ins", (ctx: PcbCtx) => {
  const id = peSingleId(ctx); if (!id || !canAddCorner(ctx.doc.items.get(id)!)) return false;
  if (!canEdit(ctx)) return true; const ch = addCornerChanges(ctx.doc, id, cursorPoint(ctx)); if (ch.length) ctx.commit(ch, addCornerLabel(ctx.doc.items.get(id))); return true;
});
act("pointEditorRemoveCorner", "Remove Corner", "", (ctx: PcbCtx) => {
  const id = peSingleId(ctx); if (!id) return false;
  if (!canEdit(ctx)) return true; const ch = removeCornerChanges(ctx.doc, id, ctx.cursor || cursorPoint(ctx), handleTol()); if (ch.length) ctx.commit(ch, removeCornerLabel(ctx.doc.items.get(id))); return true;
});
// PCB_POINT_EDITOR::chamferCorner: the corner of the selected zone or polygon nearest the cursor is broken in two
act("pointEditorChamferCorner", "Chamfer Corner", "", (ctx: PcbCtx) => {
  const id = peSingleId(ctx), it = id ? ctx.doc.items.get(id) : null; if (!it || (it.kind !== "zone" && it.kind !== "gr_poly")) return false;
  if (!canEdit(ctx)) return true; const ch = chamferCornerChanges(ctx.doc, it.id, ctx.cursor || cursorPoint(ctx)); if (ch.length) ctx.commit(ch, chamferCornerLabel(it)); return true;
}, { tip: "Chamfer corner" });
// PCB_POINT_EDITOR::movePoint: WX_PT_ENTRY_DIALOG ("X:", "Y:") on the handle under the cursor; OK moves it there
function movePointAction(midpoint: boolean) {
  return (ctx: PcbCtx) => {
    const at = ctx.cursor || cursorPoint(ctx), hit = ctx.doc ? editHandleAt(ctx.doc, at[0], at[1], handleTol()) : null;
    if (!hit || /^[em]\d/.test(hit.h.key) !== midpoint) return false;
    if (!canEdit(ctx)) return true;
    const t = movePointTitle(hit.h.key), id = hit.it.id, key = hit.h.key;
    openForm({ title: t.title, fields: [{ k: "x", label: "X:", type: "num", value: r6(hit.h.p[0]), unit: "mm" }, { k: "y", label: "Y:", type: "num", value: r6(hit.h.p[1]), unit: "mm" }],
      apply: (v: { x: number; y: number }) => { if (!isFinite(v.x) || !isFinite(v.y)) return false; const ch = movePointChanges(ctx.doc, id, key, [v.x, v.y]); if (ch.length) ctx.commit(ch, t.label); return true; } });
    return true;
  };
}
act("pointEditorMoveCorner", "Move Corner To...", "", movePointAction(false), { tip: "Move the active corner to an exact location" });
act("pointEditorMoveMidpoint", "Move Midpoint To...", "", movePointAction(true), { tip: "Move the active midpoint to an exact location" });
// PCB_POINT_EDITOR::changeArcEditMode: the three arc editing modes (check items of the Arc toolbar group's menu) and
// Cycle Arc Editing Mode (Ctrl+Space, also in the selection menu for one selected arc)
ARC_EDIT_ACTIONS.forEach((id, m) => {
  act(id, ["Keep Arc Center, Adjust Radius", "Keep Arc Endpoints or Direction of Starting Point", "Keep Arc Radius and Center, adjust angle"][m], "", () => { setArcEditMode(m); return true; },
    { tip: ["Switch arc editing mode to keep center, adjust radius and endpoints", "Switch arc editing mode to keep endpoints, or to keep direction of the other point", "Switch arc editing mode to maintaining radius when endpoint are moved"][m], check: () => arcEditMode() === m });
});
act("cycleArcEditMode", "Cycle Arc Editing Mode", "Ctrl+Space", () => { setArcEditMode(nextArcEditMode(arcEditMode())); return true; }, { tip: "Switch to a different method of editing arcs" });
// DRAWING_TOOL::DrawArc's modes (PCB_ACTIONS::drawArcCenter …): each starts Draw Arcs in its mode, or switches the arc
// being drawn to it (ARC_MODE_SESSION::HandleModeEvent); Switch Arc Posture and Cycle Arc Drawing Mode act on the arc in progress.
ARC_MODE_ACTIONS.forEach((id, m) => {
  const label = ["Draw Arc: Center, Start, End", "Draw Arc: Start, End, Midpoint", "Draw Arc: Start, End, Center", "Draw Arc: Tangent", "Draw Arc: Start, Direction, End"][m];
  act(id, label, "", (ctx: PcbCtx) => { if (S.modTool === "garc") switchArcMode(ctx, m); else { setArcDrawMode(m); ctx.setTool("garc"); } return true; },
    { check: () => arcDrawMode() === m });
});
act("arcPosture", "Switch Arc Posture", "/", (ctx: PcbCtx) => {
  const d = S.draw; if (S.modTool !== "garc") return false;
  if (d && d.shape === "garc") { d.arc!.toggleClockwise(); syncArcDraw(d); ctx.requestRender(); }
  return true;
}, { tip: "Switch arc posture between clockwise and counter-clockwise" });
act("cycleArcDrawMode", "Cycle Arc Drawing Mode", "Alt+/", (ctx: PcbCtx) => { if (S.modTool !== "garc") return false; switchArcMode(ctx, (arcDrawMode() + 1) % 5); return true; },
  { tip: "Switch to the next method of drawing arcs" });
// DRAWING_TOOL::DrawDimension's changeDimensionArrows (the drawing tool's menu while a dimension is drawn): inward <-> outward
// on an aligned or orthogonal dimension; the others have no arrows to swap (wxBell).
act("changeDimensionArrows", "Switch Dimension Arrows", "", (ctx: PcbCtx) => {
  const d = S.draw; if (!d || !DIM_TYPE[d.shape]) return false;
  const type = DIM_TYPE[d.shape]; if (type === "aligned" || type === "orthogonal" || type === "radial") { d.arrowInward = !d.arrowInward; ctx.requestRender(); }
  return true;
}, { tip: "Switch between inward and outward dimension arrows" });
// ZONE_FILLER_TOOL::ZoneFillAll / ZoneFill: the browser's ZONE_FILLER (web/domains/pcb/fab/zonefill.ts, run by
// web/domains/pcb/editor/pcbdialogs/zonefill.ts with KiCad's progress reporter); the editor installs the same actions over these.
export const zoneFiller = () => root.PcbZoneFill || null;
act("zoneFillAll", "Fill All Zones", "B", (ctx: PcbCtx) => { const z = zoneFiller(); if (!z) { ctx.toast("The zone filler is not loaded"); return true; } return z.fillAll(ctx); });
act("zoneFill", "Draft Fill Selected Zone(s)", "", (ctx: PcbCtx) => { const z = zoneFiller(); if (!z) { ctx.toast("The zone filler is not loaded"); return true; } return z.fillSelected(ctx); });
// ZONE::UnFill (ZONE_FILLER_TOOL::ZoneUnfill / ZoneUnfillAll): the filled areas go and the zone is no longer marked
// filled — exactly what pcbnew writes after an unfill, so the browser can do it itself.
export function unfillChanges(doc: BoardDoc, zones: (KItem | undefined)[]) {
  const out: PcbChange[] = [];
  for (const z of zones) {
    if (!z || z.kind !== "zone") continue;
    const node = clone(z.node); let changed = false;
    for (let i = node.length - 1; i > 0; i--) if (Array.isArray(node[i]) && (node[i] as SNode)[0] === "filled_polygon") { node.splice(i, 1); changed = true; }
    const fill = K.kid(node, "fill"); if (fill && fill[1] === "yes") { fill.splice(1, 1); changed = true; }
    if (changed) out.push(replacedChange(z, node));
  }
  return out;
}
// ZONE_FILLER_TOOL::ZoneUnfill: no zone in the selection is a wxBell, no message
act("zoneUnfill", "Unfill Selected Zone(s)", "", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; const ids = Array.from(expandGroups(ctx.doc, selectionIds(ctx))).filter((id) => { const it = ctx.doc.items.get(id); return !!it && it.kind === "zone"; }); if (!ids.length) return true; return commitSel(ctx, unfillChanges(ctx.doc, ids.map((id) => ctx.doc.items.get(id))), "Unfill Zone"); });
act("zoneUnfillAll", "Unfill All Zones", "Ctrl+B", (ctx: PcbCtx) => { if (!canEdit(ctx)) return true; return commitSel(ctx, unfillChanges(ctx.doc, Array.from(ctx.doc.items.values())), "Unfill All Zones"); });
// The autorouter is its own bundle (web/domains/pcb/router → dist/autoroute.js); this is its entry in the Route menu.
act("autoroute", "Autoroute…", "", (ctx: PcbCtx) => { const r = root.PcbAutoRouter; if (!r || !r.open) { ctx.toast("The autorouter is not loaded"); return true; } return r.open(ctx); }, { menu: "Route" });
act("autoplace", "Auto Place Footprints…", "", (ctx: PcbCtx) => { const r = root.PcbAutoRouter; if (!r || !r.openPlace) { ctx.toast("The placer is not loaded"); return true; } return r.openPlace(ctx); }, { menu: "Tools" });
// library access (web/domains/pcb/editor/library.ts, window.KiCadLibrary): KiCad's footprint chooser and the footprint library browser
export const libraryAction = (opts?: Record<string, unknown>) => (ctx: PcbCtx) => { const L = root.KiCadLibrary; if (!L || !L.chooseAndPlace) { ctx.toast("The library module is not loaded"); return true; } L.chooseAndPlace("footprint", opts); return true; };
act("placeFootprint", "Place Footprints", "A", libraryAction());
act("showFootprintBrowser", "Footprint Library Browser", "", libraryAction({ browser: true }));
// EDIT_TOOL::Drag: the module's D / G handling (index.ts dragKey), so the menu bar and the hotkey list reach it too
let dragImpl: ((ctx: PcbCtx, free: boolean) => boolean) | null = null;
export function setDragImpl(f: (ctx: PcbCtx, free: boolean) => boolean) { dragImpl = f; }
act("drag45Degree", "Drag 45 Degree Mode", "D", (ctx: PcbCtx) => !!dragImpl && dragImpl(ctx, false), { tip: "Drags a track segment, or a mixed selection as one block, keeping connected tracks at 45 degrees." });
act("dragFreeAngle", "Drag Free Angle", "G", (ctx: PcbCtx) => !!dragImpl && dragImpl(ctx, true), { tip: "Drags the nearest joint in the track without restricting the track angle." });
Object.freeze(ACTIONS);
/** pcb.setRoutingDialogs: the routing dialogs the editor bundle hands over. */
export function setRoutingDialogsImpl(d: RoutingDialogs) { routingDialogs = d; }

/** The Grid Origin dialog; exported for the tests (the units come from the toolbar's size units). */
export function openGridOrigin(ctx: PcbCtx) {
  const R = sizesOf(ctx), u = sizeUnits(), per = u === "mil" ? 0.0254 : u === "in" ? 25.4 : 1, dp = u === "mil" ? 2 : u === "in" ? 5 : 4;
  const show = (mm: number) => +(mm / per).toFixed(dp), back = (v: number) => Math.round(v * per * 1e6) / 1e6;
  const [gx, gy] = R.gridOrigin;
  return openForm<{ x: number; y: number }>({ title: "Grid Origin", width: 300, fields: [
    { k: "x", label: "X:", type: "num", value: show(gx), unit: u === "mil" ? "mils" : u },
    { k: "y", label: "Y:", type: "num", value: show(gy), unit: u === "mil" ? "mils" : u },
    { k: "reset", label: "Reset", type: "button" }],
    change: (k, _v, set) => { if (k === "reset") { set("x", 0); set("y", 0); } },
    apply: (v) => {
      const x = isNaN(v.x) ? gx : back(v.x), y = isNaN(v.y) ? gy : back(v.y);
      R.setGridOrigin([x, y]); ctx.requestRender();
    } });
}
