// pcb-tools/block-drag.ts — block anchor editing of PCB_POINT_EDITOR (pcbnew/tools/pcb_point_editor.cpp
// buildBlockHandles … BLOCK_DRAG_SESSION, pcbnew/tools/block_drag_{capability,dependents,displacement,pick,validation}.cpp
// and pcbnew/router/pns_block_dragger.cpp).  With Preferences > PCB Editor > Editing Options > "Show and edit anchor
// points on multi-selections" on (PCBNEW_SETTINGS m_AreaAnchorPointSelection, "editing.area_anchor_point_selection"),
// a multi-selection shows the edit points of every item that can be reshaped.  Points are picked by click (Shift
// toggles), by box or by lasso on empty canvas, and dragging a picked point (or D over one) moves every picked point as
// one block: the selected items without a picked point travel whole, unselected graphic ends joined to the moved ends
// follow (BlockDragFindDependents), the copper goes through the router's block dragger, and the release checks the
// zone and board outlines and the router's collisions before it commits ("Drag block", "Move Points", "Move Point").
import type { BoardDoc, Obstacle, PadInfo, PcbChange, PcbCtx, Pt, TrackElem, TrackLine } from "./types";
import { keysInText } from "../../../../shared/keys";
import { isPastDragThreshold } from "../drag-threshold";
import { EDIT_BORDER_PX, EDIT_HOVER_PX, EDIT_POINT_PX, editPointColors } from "../edit-point-style";
import { overrideLocks } from "./actions";
import { appGlobal, editorState, isBoardLikeDoc } from "./app-state";
import { auxItemsColor } from "./assistants";
import { replacedChange } from "./changes";
import { ptKey } from "./connected";
import { settingsOf } from "./dialogs";
import { shapeBBox, shapeGap, viaLayers } from "./distances";
import { dragChanges } from "./drag-optimize";
import { assembleArcLine, dragCorner45, dragSegment45, elemsLine, peq, restoreArcTags, rp, trackEnds } from "./dragger";
import { boardOutline, chainLoops, edgeShapes, netClearance, segCross } from "./drc";
import { LiveConstraintEdit, boardHasConstraints, memberForEditPoint } from "./constraint-tool";
import { BoardConstraintBlockSession, constraintCoMembers } from "./constraint-adapter";
import { itemAnchors, member as cMember } from "./pcb-constraint";
import type { CMember } from "./pcb-constraint";
import { viaNow } from "./edit-commands";
import { snapCursor } from "./grid-helper";
import { groupMembers, isLocked, selectionIds } from "./groups";
import { hitTestItem } from "./hit";
import { itemDescription } from "./msgpanel";
import { netTable } from "./netlist";
import { netOf } from "./nets";
import { line, polyline, drawShape } from "./overlay";
import { editHandleAt, editHandleMove, editPointNode, editPoints, findEditHandle, handleTol, peContours, peSingleId, startHandleEdit } from "./point-editor";
import type { EditPoint } from "./point-editor";
import { drawStatusNote, previewColor } from "./route-preview";
import { padCovers, padsOf } from "./route-geom";
import { RM_MARK } from "./router-settings";
import { HALO_COLOR, HALO_STROKE_ALPHA, K, S, lastCtx } from "./state";
import { translateNode } from "./transforms";
import { isTuningPattern } from "./tuning-patterns";
import { clone, layerOf, pt, r6, samePt, widthOf } from "./util";
import { isViaStack } from "./via-stack";
import { isViaStitch } from "./via-stitch";
import { ROUTE_EPS, isFreePad, obstaclesNear, pathHits, routeObstacles, routerWorld } from "./walkaround";

// ---------------------------------------------------------------- block_drag_capability.cpp
export type BlockCapability = "deformable" | "rigid" | "router" | "unsupported";
/** BlockDragAnchorEditingEnabled: PCBNEW_SETTINGS::m_AreaAnchorPointSelection (shared by the board and footprint editors). */
export const blockAnchorEditingEnabled = () => !!S.areaAnchorPointSelection;
const footprintHolder = (doc: BoardDoc | null | undefined) => !!(doc && (doc as { fpEditor?: boolean }).fpEditor);
const RIGID_KINDS = new Set(["gr_text", "fp_text", "property", "gr_text_box", "table", "image", "barcode", "dimension", "target", "point", "grid_item"]);
/** BlockDragCapability: how an item takes part in a block drag. */
export function blockDragCapability(it: KItem, fpHolder: boolean): BlockCapability {
  switch (it.kind) {
    case "segment": case "arc": case "via": case "footprint": return fpHolder ? "unsupported" : "router";
    case "pad": return fpHolder ? "rigid" : "router";
    case "zone": return "deformable";
    case "gr_line": case "gr_poly": case "gr_rect": case "gr_bbox": case "gr_ellipse": case "gr_ellipse_arc": return "deformable";   // SEGMENT, POLY, RECTANGLE, ELLIPSE, ELLIPSE_ARC
    case "gr_arc": case "gr_circle": case "gr_curve": return "rigid";                                                              // ARC, CIRCLE, BEZIER
    case "generated":   // safe to carry only when Move() takes every member along; a via stitch is an outline like a zone's
      if (isViaStitch(it)) return "deformable";
      return isTuningPattern(it) || isViaStack(it) ? "rigid" : "unsupported";
    default: return RIGID_KINDS.has(it.kind) ? "rigid" : "unsupported";
  }
}
/** BlockDragExpandSelection: groups give their members (a footprint's children are never items of their own here). */
export function blockDragExpandSelection(doc: BoardDoc, ids: Iterable<string>): KItem[] {
  const out: KItem[] = [], seen = new Set<string>();
  const add = (id: string) => {
    const it = doc.items.get(id); if (!it || seen.has(id)) return; seen.add(id);
    if (it.kind === "group") { for (const m of groupMembers(it.node)) add(m); return; }
    out.push(it);
  };
  for (const id of ids) add(id);
  return out;
}

// ---------------------------------------------------------------- block_drag_pick.cpp
const isEditLine = (key: string) => /^[em]\d+$/.test(key);
/** EDIT_POINT::DrivesWholeShape: a rectangle's centre and radius handles, an ellipse's centre. */
const drivesWholeShape = (kind: string, key: string) => ((kind === "gr_rect" || kind === "gr_bbox") && (key === "rc" || key === "rr")) || ((kind === "gr_ellipse" || kind === "gr_ellipse_arc") && key === "center");
/** BlockDragHandlePickable. */
export function blockDragHandlePickable(it: KItem, key: string, fpHolder: boolean): boolean {
  if (blockDragCapability(it, fpHolder) !== "deformable") return false;
  if (drivesWholeShape(it.kind, key)) return false;
  if (isEditLine(key)) return it.kind === "zone" || it.kind === "gr_poly" || isViaStitch(it);
  return true;
}
/** BlockDragApplyPick: a plain pick replaces the set, an accumulating one toggles the handle. */
export function blockDragApplyPick(picked: Set<string>, key: string, accumulate: boolean) {
  if (!accumulate) { picked.clear(); picked.add(key); return; }
  if (!picked.delete(key)) picked.add(key);
}
/** BlockDragPickRect: the closed rectangle a box pick covers. */
export const blockDragPickRect = (a: Pt, b: Pt): Pt[] => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
const onEdge = (P: Pt[], p: Pt) => P.some((a, i) => { const b = P[(i + 1) % P.length]; const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); if (L < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]) < 1e-9; const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L); return t >= -1e-9 && t <= 1 + 1e-9 && Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L < 1e-9; });
function pointInside(P: Pt[], p: Pt) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
/** BlockDragLassoPick: every pickable handle inside the lasso or on its edge joins the picks (a plain pick starts afresh). */
export function blockDragLassoPick(colls: BlockColl[], lasso: Pt[], accumulate: boolean, picked: Set<string>, fpHolder: boolean) {
  if (!accumulate) picked.clear();
  if (lasso.length < 3) return;
  for (const c of colls) for (const h of c.pts) {
    if (!pointInside(lasso, h.p) && !onEdge(lasso, h.p)) continue;
    if (!blockDragHandlePickable(c.it, h.key, fpHolder)) continue;
    picked.add(c.id + "|" + h.key);
  }
}

// ---------------------------------------------------------------- block_drag_dependents.cpp
export interface BlockEndpoint { id: string; isStart: boolean; pos: Pt; whole: boolean }
/**
 * BlockDragFindDependents: the unselected graphic ends that sit on a moved end and follow it.  A segment stretches, an
 * arc travels whole and hands its far end on; a joint whose ends do not all meet is ambiguous and left alone.  null
 * when a shape that has to follow is locked and Override Locks is off.
 */
export function blockDragFindDependents(candidates: KItem[], moved: BlockEndpoint[], overrideLocksOn: boolean, layerOfId: (id: string) => string): BlockEndpoint[] | null {
  const deps: BlockEndpoint[] = []; const baseTol = 0.001;
  const seeds = moved.slice(); const carried = new Set<string>();
  const isMoved = (id: string, isStart: boolean) => seeds.some((m) => m.id === id && m.isStart === isStart);
  const accepted = (id: string, isStart: boolean) => deps.some((d) => d.id === id && d.isStart === isStart);
  for (let si = 0; si < seeds.length; si++) {
    const m = seeds[si]; const layer = layerOfId(m.id);
    const tol = layer === "Edge.Cuts" ? Math.max(baseTol, 0.01) : baseTol;   // GetOutlinesChainingEpsilon (DEFAULT_CHAINING_EPSILON_MM)
    const within = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 <= tol * tol;
    const cluster: BlockEndpoint[] = [];
    for (const c of candidates) {
      const follow = c.kind === "gr_line" ? "stretch" : c.kind === "gr_arc" ? "whole" : null;
      if (!follow || carried.has(c.id) || layerOf(c.node) !== layer) continue;
      for (const isStart of [true, false]) {
        const p = pt(c.node, isStart ? "start" : "end"); if (!p || !within(p, m.pos)) continue;
        if (!isMoved(c.id, isStart)) cluster.push({ id: c.id, isStart, pos: p, whole: follow === "whole" });
      }
    }
    let ambiguous = false;
    for (let i = 0; i < cluster.length && !ambiguous; i++) for (let j = i + 1; j < cluster.length; j++) if (!within(cluster[i].pos, cluster[j].pos)) { ambiguous = true; break; }
    if (ambiguous) continue;
    for (const mem of cluster) {
      if (accepted(mem.id, mem.isStart)) continue;
      deps.push(mem);
      if (!mem.whole) continue;
      carried.add(mem.id);
      const c = candidates.find((x) => x.id === mem.id)!; const far = pt(c.node, mem.isStart ? "end" : "start");
      if (far) seeds.push({ id: mem.id, isStart: !mem.isStart, pos: far, whole: true });
    }
  }
  if (!overrideLocksOn) for (const d of deps) { const c = candidates.find((x) => x.id === d.id); if (c && isLocked(c.node)) return null; }
  return deps;
}

// ---------------------------------------------------------------- block_drag_validation.cpp
const segsOfLoop = (P: Pt[]) => P.map((a, i) => [a, P[(i + 1) % P.length]] as [Pt, Pt]);
/** SHAPE_POLY_SET::IsPolygonSelfIntersecting over an outline and its holes: two edges that are not neighbours cross. */
function loopsSelfIntersecting(loops: Pt[][]): boolean {
  const segs: { a: Pt; b: Pt; l: number; i: number; n: number }[] = [];
  loops.forEach((P, l) => segsOfLoop(P).forEach(([a, b], i) => segs.push({ a, b, l, i, n: P.length })));
  for (let x = 0; x < segs.length; x++) for (let y = x + 1; y < segs.length; y++) {
    const s = segs[x], t = segs[y];
    if (s.l === t.l && (Math.abs(s.i - t.i) === 1 || Math.abs(s.i - t.i) === s.n - 1)) continue;   // neighbours share a corner
    if (segCross(s.a, s.b, t.a, t.b)) return true;
  }
  return false;
}
/** zoneOutlineIsSound: an outline of three or more corners, holes inside it, no touching holes, no self-intersection. */
export function zoneOutlineIsSound(node: SNode): boolean {
  const loops = peContours(node).map((pn) => K.kids(pn, "xy").map((x) => [K.num(x[1]), K.num(x[2])] as Pt));
  if (!loops.length) return false;
  const [outline, ...holes] = loops;
  if (outline.length < 3) return false;
  for (const h of holes) if (h.length < 3 || !pointInside(outline, h[0])) return false;
  for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) if (holes[i].some((p) => holes[j].some((q) => samePt(p, q)))) return false;   // HasTouchingHoles
  return !loopsSelfIntersecting(loops);
}
/** BOARD::GetBoardPolygonOutlines' success: every Edge.Cuts chain closes and no outline crosses itself. */
export function boardOutlineIsValid(doc: BoardDoc): boolean {
  const ol = boardOutline(doc); if (!ol.hasEdges) return true;
  if (ol.dangling || !ol.outline) return false;
  const { loops } = chainLoops(edgeShapes(doc).chains);
  return !loops.some((l) => loopsSelfIntersecting([l]));
}
interface BlockValidation { zones: { id: string; sound: boolean }[]; outlineAffected: boolean; outlineWasValid: boolean }
function captureBaseline(doc: BoardDoc, ids: Iterable<string>): BlockValidation {
  const v: BlockValidation = { zones: [], outlineAffected: false, outlineWasValid: false };
  const outlineMatters = !footprintHolder(doc);   // the footprint editor's Edge.Cuts shapes are content to move
  for (const id of ids) {
    const it = doc.items.get(id); if (!it) continue;
    if (it.kind === "zone") v.zones.push({ id, sound: zoneOutlineIsSound(it.node) });
    if (outlineMatters && onLayer(it, "Edge.Cuts")) v.outlineAffected = true;
  }
  if (v.outlineAffected) v.outlineWasValid = boardOutlineIsValid(doc);
  return v;
}
const onLayer = (it: KItem, layer: string) => layerOf(it.node, "") === layer || (K.kids(it.node, "layers")[0] || []).slice(1).some((l) => K.str(l) === layer);
function validate(doc: BoardDoc, v: BlockValidation): "ok" | "zone" | "outline" {
  for (const z of v.zones) { const it = doc.items.get(z.id); if (z.sound && it && !zoneOutlineIsSound(it.node)) return "zone"; }
  if (v.outlineAffected && v.outlineWasValid && !boardOutlineIsValid(doc)) return "outline";
  return "ok";
}

// ---------------------------------------------------------------- the handle collections (buildBlockHandles / pickableCollections)
/** One EDIT_POINTS collection: an item's handles; `single` is the point editor's own (m_editPoints). */
export interface BlockColl { id: string; it: KItem; pts: EditPoint[]; single: boolean }
interface BlockArea { lasso: boolean; pts: Pt[]; start: Pt; end: Pt; accumulate: boolean; cur: Pt }
interface BlockPress { mm: Pt; client: Pt; pointerId: number; shift: boolean; keyHit: string | null; single: boolean; done?: boolean; release?: boolean }
const st = { sig: "", picked: new Set<string>(), press: null as BlockPress | null, consumed: null as number | null, area: null as BlockArea | null };
/** The picks belong to the selection they were made on: another selection starts with none (clearBlockHandles). */
function sync(ctx: PcbCtx) {
  const sig = Array.from(selectionIds(ctx)).sort().join(",");
  if (sig !== st.sig) { st.sig = sig; st.picked.clear(); if (S.blockDrag) abortBlockDrag(ctx); }
}
/** buildBlockHandles + pickableCollections: the deformable items' handles of a multi-selection (or of a group's
 * members), then the point editor's own collection of a lone item. */
export function blockCollections(ctx: PcbCtx): { colls: BlockColl[]; expanded: KItem[] } {
  if (!blockAnchorEditingEnabled() || !ctx || !ctx.doc) return { colls: [], expanded: [] };
  sync(ctx);
  const ids = selectionIds(ctx); if (!ids.size) return { colls: [], expanded: [] };
  const doc = ctx.doc, fpH = footprintHolder(doc), expanded = blockDragExpandSelection(doc, ids), colls: BlockColl[] = [];
  const front = doc.items.get(ids.values().next().value as string);
  if (ids.size === 1 && front && front.kind !== "group") {
    // a lone object shows its handles through the point editor: they are pickable unless it is the scaling box
    const id = peSingleId(ctx), it = id ? doc.items.get(id) : null;
    if (it && !isLocked(it.node)) colls.push({ id: it.id, it, pts: editPoints(it), single: true });
    return { colls, expanded };
  }
  for (const it of expanded) {
    if (blockDragCapability(it, fpH) !== "deformable") continue;
    const pts = editPoints(it); if (pts.length) colls.push({ id: it.id, it, pts, single: false });
  }
  return { colls, expanded };
}
const handleOf = (colls: BlockColl[], key: string) => { const i = key.lastIndexOf("|"); const c = colls.find((x) => x.id === key.slice(0, i)); const h = c && c.pts.find((x) => x.key === key.slice(i + 1)); return c && h ? { c, h } : null; };
/** applyPickedFlags: the picks whose handle has gone are dropped. */
function prunePicks(colls: BlockColl[]) { for (const k of Array.from(st.picked)) if (!handleOf(colls, k)) st.picked.delete(k); }
/** The pickable handle under mm: each collection's first point there, skipped when it cannot be picked (pickHandleAt). */
function pickableAt(colls: BlockColl[], mm: Pt, fpH: boolean) {
  const tol = handleTol();
  for (const c of colls) { const h = findEditHandle(c.pts, mm[0], mm[1], tol); if (!h || !blockDragHandlePickable(c.it, h.key, fpH)) continue; return { c, h, key: c.id + "|" + h.key }; }
  return null;
}
/** The keys picked on one item's handles (the point editor draws them selected). */
export function blockPickedKeys(id: string): Set<string> {
  const out = new Set<string>(); if (!blockAnchorEditingEnabled()) return out;
  for (const k of st.picked) { const i = k.lastIndexOf("|"); if (k.slice(0, i) === id) out.add(k.slice(i + 1)); }
  return out;
}
export const blockPickCount = () => st.picked.size;
/** PCB_POINT_EDITOR::pickHandleAt. */
export function pickHandleAt(ctx: PcbCtx, mm: Pt, accumulate: boolean): boolean {
  const { colls } = blockCollections(ctx); const hit = pickableAt(colls, mm, footprintHolder(ctx.doc)); if (!hit) return false;
  blockDragApplyPick(st.picked, hit.key, accumulate); prunePicks(colls); ctx.requestRender(); return true;
}
/** The selection tool's click as the point editor sees it first: a handle is picked, a plain click on nothing drops the
 * picks.  True when the click stops here. */
export function blockClick(ctx: PcbCtx, mm: Pt, shift: boolean): boolean {
  if (!blockAnchorEditingEnabled() || S.blockDrag) return false;
  let consumed = pickHandleAt(ctx, mm, shift);
  if (!consumed && !shift && st.picked.size) { st.picked.clear(); ctx.requestRender(); consumed = true; }
  return consumed;
}
/** BLOCK_DRAG_SESSION::AreaPickStarts: an unmodified (or Shift) drag on empty canvas, with no handle under its origin
 * and something pickable, picks handles by area. */
export function areaPickStarts(ctx: PcbCtx, mm: Pt, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean }): boolean {
  if (!blockAnchorEditingEnabled() || mods.ctrl || mods.alt) return false;
  const { colls } = blockCollections(ctx); const fpH = footprintHolder(ctx.doc), tol = handleTol(); let any = false;
  for (const c of colls) {
    if (findEditHandle(c.pts, mm[0], mm[1], tol)) return false;
    if (!any && c.pts.some((h) => blockDragHandlePickable(c.it, h.key, fpH))) any = true;
  }
  if (!any) return false;
  const sel = selectionIds(ctx);
  // only empty canvas starts it: SelectionContains, a selected item hit within its 20 px grip margin
  return !hitTestItem(ctx.doc, mm[0], mm[1], 20 * (S.mmPerPx || 0.05), (it) => sel.has(it.id));
}
/** Runs the lasso or the box (RunAreaPick), whichever the selection mode asks for. */
export function startAreaPick(ctx: PcbCtx, mm: Pt, cur: Pt, accumulate: boolean) {
  const lasso = appGlobal(() => (editorState() as unknown as { selMode?: string }).selMode === "lasso", false);
  st.area = { lasso, pts: [mm.slice() as Pt, cur.slice() as Pt], start: mm.slice() as Pt, end: cur.slice() as Pt, accumulate, cur: cur.slice() as Pt };
  ctx.requestRender();
}
function finishArea(ctx: PcbCtx, apply: boolean) {
  const a = st.area; st.area = null; if (!a) return;
  if (apply) { const { colls } = blockCollections(ctx); blockDragLassoPick(colls, a.lasso ? a.pts : blockDragPickRect(a.start, a.end), a.accumulate, st.picked, footprintHolder(ctx.doc)); prunePicks(colls); }
  ctx.requestRender();
}
/** The editor's drag on empty canvas, offered here first.  True when it became an area pick. */
export function blockAreaDrag(ctx: PcbCtx, mm: Pt, cur: Pt, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean }): boolean {
  if (S.blockDrag || st.area || !areaPickStarts(ctx, mm, mods)) return false;
  startAreaPick(ctx, mm, cur, !!mods.shift); return true;
}

// ---------------------------------------------------------------- the router's block dragger (PNS::BLOCK_DRAGGER)
interface BConn { l: TrackLine; at: Pt; body: boolean }
interface BRouter { rigidVias: Set<string>; rigidPads: Set<string>; bridges: Set<string>; conns: BConn[]; anchored: string[]; hits: Obstacle[] | null; status: boolean }
const padKey = (fpId: string, p: PadInfo) => fpId + "#" + p.index;
/** BLOCK_DRAGGER::Start over the selected copper: pads of carried footprints and selected vias are rigid, selected
 * tracks are bridges (both ends carried), fan-outs (one end carried) or anchored; the lines leaving the block are
 * rubber-banded from the joint where they meet it. */
export function blockDraggerStart(doc: BoardDoc, vias: KItem[], footprints: KItem[], links: KItem[]): BRouter {
  const NT = netTable(doc); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const netKey = (n: SNode) => NT.key(netOf(n)) || "";
  const R: BRouter = { rigidVias: new Set(vias.map((v) => v.id)), rigidPads: new Set(), bridges: new Set(), conns: [], anchored: [], hits: null, status: true };
  const selLinks = new Set(links.map((l) => l.id)); const seen = new Set<string>(); const carried = new Set<string>();
  const allPads: { fp: KItem; pad: PadInfo; layers: Set<string> }[] = [];
  const allVias: KItem[] = []; const ends = new Map<string, KItem[]>();
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") for (const p of padsOf(it)) { const ls = new Set<string>(); for (const l of p.layers) { if (l === "*.Cu" || l === "F&B.Cu") copper.forEach((c) => ls.add(c)); else if (/\.Cu$/.test(l)) ls.add(l); } allPads.push({ fp: it, pad: p, layers: ls }); }
    else if (it.kind === "via") allVias.push(it);
    else if (it.kind === "segment" || it.kind === "arc") for (const p of trackEnds(it)) { const k = layerOf(it.node) + "|" + ptKey(p); const l = ends.get(k); if (l) l.push(it); else ends.set(k, [it]); }
  }
  for (const fp of footprints) for (const p of padsOf(fp)) R.rigidPads.add(padKey(fp.id, p));
  const padNet = (x: { pad: PadInfo }) => NT.key(x.pad.net) || "";
  const jkey = (L: string, p: Pt, net: string) => L + "|" + ptKey(p) + "|" + net;
  const tracksAt = (L: string, p: Pt, net: string) => (ends.get(L + "|" + ptKey(p)) || []).filter((t) => netKey(t.node) === net);
  const viasAt = (L: string, p: Pt, net: string) => allVias.filter((v) => { const a = pt(v.node, "at"); return a && samePt(a, p) && viaLayers(v.node, copper).has(L) && netKey(v.node) === net; });
  const padsAt = (L: string, p: Pt, net: string) => allPads.filter((x) => samePt([x.pad.x, x.pad.y], p) && x.layers.has(L) && padNet(x) === net);
  const fixedByLock = (t: KItem) => isLocked(t.node) && !selLinks.has(t.id);
  const coveredBySolid = (L: string, p: Pt, net: string, selected: boolean) => {
    for (const v of allVias) { const a = pt(v.node, "at"); if (!a || R.rigidVias.has(v.id) !== selected || netKey(v.node) !== net || !viaLayers(v.node, copper).has(L)) continue; if (Math.hypot(a[0] - p[0], a[1] - p[1]) <= viaNow(v.node).size / 2) return true; }
    for (const x of allPads) { if (R.rigidPads.has(padKey(x.fp.id, x.pad)) !== selected || padNet(x) !== net || !x.layers.has(L)) continue; if (padCovers(x.pad, p[0], p[1])) return true; }
    return false;
  };
  const isPinned = (L: string, p: Pt, net: string, own: Set<string>) => {
    for (const t of tracksAt(L, p, net)) { if (own.has(t.id)) continue; if (fixedByLock(t)) return true; }
    if (viasAt(L, p, net).some((v) => !R.rigidVias.has(v.id))) return true;
    if (padsAt(L, p, net).some((x) => !R.rigidPads.has(padKey(x.fp.id, x.pad)))) return true;
    return coveredBySolid(L, p, net, false);
  };
  const isHeldByBlock = (L: string, p: Pt, net: string) => viasAt(L, p, net).some((v) => R.rigidVias.has(v.id)) || padsAt(L, p, net).some((x) => R.rigidPads.has(padKey(x.fp.id, x.pad))) || coveredBySolid(L, p, net, true);
  const isBoundary = (L: string, p: Pt, net: string) => carried.has(jkey(L, p, net)) || tracksAt(L, p, net).some((t) => selLinks.has(t.id)) || viasAt(L, p, net).some((v) => R.rigidVias.has(v.id)) || padsAt(L, p, net).some((x) => R.rigidPads.has(padKey(x.fp.id, x.pad)));
  const elOf = (it: KItem, from: Pt): TrackElem => { const [a, b] = trackEnds(it); const m = it.kind === "arc" ? pt(it.node, "mid") : null; const fwd = samePt(a, from); return m ? (fwd ? { t: "arc", a, m, b } : { t: "arc", a: b, m, b: a }) : (fwd ? { t: "seg", a, b } : { t: "seg", a: b, b: a }); };
  const lineOf = (items: KItem[], from: Pt, w: number, L: string, net: TrackLine["net"]): TrackLine => {
    const els: TrackElem[] = []; let q = from;
    for (const it of items) { const e = elOf(it, q); els.push(e); q = e.b; }
    const { pts, arcs } = elemsLine(els, w);
    return { ids: items.map((x) => x.id), pts, index: 0, width: w, layer: L, net, netKey: netKey(items[0].node), arcs: arcs.list.length ? arcs : undefined };
  };
  // classifySelectedLink
  const classifySelected = (link: KItem) => {
    if (seen.has(link.id)) return; seen.add(link.id);
    const L = layerOf(link.node), net = netKey(link.node), [a, b] = trackEnds(link), own = new Set([link.id]);
    const cA = !isPinned(L, a, net, own), cB = !isPinned(L, b, net, own);
    if (cA) carried.add(jkey(L, a, net)); if (cB) carried.add(jkey(L, b, net));
    const ln = lineOf([link], a, widthOf(link.node, 0.25), L, netOf(link.node));
    if (cA && cB) R.bridges.add(link.id);
    else if (cA || cB) R.conns.push({ l: ln, at: cA ? a : b, body: false });
    else if (link.kind === "arc") R.anchored.push(link.id);   // an arc has no body drag
    else R.conns.push({ l: ln, at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], body: true });
  };
  // classifyNeighbour: the neighbour's line from the joint up to the first joint of the block (clipToBlock)
  const classifyNeighbour = (L: string, p: Pt, net: string, link: KItem) => {
    if (seen.has(link.id) || fixedByLock(link)) return; seen.add(link.id);
    const al = assembleArcLine(doc, link); if (!al) return;
    const items = al.ids.map((id) => doc.items.get(id)!).filter(Boolean);
    // the chain's vertices: V[k] joins items[k - 1] and items[k]
    const V: Pt[] = []; { const f = trackEnds(items[0]); let q = items.length > 1 ? (trackEnds(items[1]).some((x) => samePt(x, f[0])) ? f[1] : f[0]) : f[0]; V.push(q); for (const it of items) { const [x, y] = trackEnds(it); q = samePt(x, q) ? y : x; V.push(q); } }
    const e = V.findIndex((v) => samePt(v, p)); if (e < 0) return;
    const li = items.findIndex((x) => x.id === link.id); const dir = li >= e ? 1 : -1;
    let k = e + dir; while (k > 0 && k < V.length - 1 && !isBoundary(L, V[k], net)) k += dir;
    const kept = dir > 0 ? items.slice(e, k) : items.slice(k, e).reverse();
    for (const x of kept) seen.add(x.id);
    const far = V[k]; const ln = lineOf(kept, p, al.width, L, al.net); const own = new Set(kept.map((x) => x.id));
    const farCarried = carried.has(jkey(L, far, net)) || (isHeldByBlock(L, far, net) && !isPinned(L, far, net, own));
    if (farCarried) for (const x of kept) R.bridges.add(x.id); else R.conns.push({ l: ln, at: p.slice() as Pt, body: false });
  };
  const scanJoint = (L: string, p: Pt, net: string) => { for (const t of tracksAt(L, p, net)) classifyNeighbour(L, p, net, t); };
  for (const l of links) classifySelected(l);
  for (const v of vias) { const a = pt(v.node, "at"); if (a) for (const L of viaLayers(v.node, copper)) scanJoint(L, a, netKey(v.node)); }
  for (const fp of footprints) for (const p of padsOf(fp)) {
    const x = allPads.find((q) => q.fp === fp && q.pad.index === p.index); if (!x || !padNet(x)) continue;   // SOLID::IsRoutable: a pad with a net
    const net = padNet(x);
    for (const L of x.layers) {
      scanJoint(L, [p.x, p.y], net);
      // QueryJoints over the pad's hull: a lone track end inside the pad's shape
      for (const [k, list] of ends) {
        if (!k.startsWith(L + "|") || list.length !== 1) continue; const t = list[0]; if (netKey(t.node) !== net) continue;
        for (const q of trackEnds(t)) if (L + "|" + ptKey(q) === k && padCovers(p, q[0], q[1])) classifyNeighbour(L, q, net, t);
      }
    }
  }
  for (const k of Array.from(carried)) { const [L, xy, net] = k.split("|"); const [x, y] = xy.split(",").map((n) => +n / 1000); for (const t of tracksAt(L, [x, y], net)) { const q = trackEnds(t).find((e) => ptKey(e) === xy); if (q) classifyNeighbour(L, q, net, t); } }
  return R;
}
/** BLOCK_DRAGGER::Drag's fan-out lines at an offset: DragCorner of the carried end, or DragSegment of a pinned one's body. */
export function blockConnLines(R: BRouter, dx: number, dy: number) {
  return R.conns.map((c) => {
    const at = rp([c.at[0] + dx, c.at[1] + dy]);
    const pts = c.body ? dragSegment45(c.l.pts, 0, at, 0) : dragCorner45(c.l.pts, Math.max(0, c.l.pts.findIndex((q) => peq(q, c.at))), at, 0);
    return c.l.arcs ? { l: c.l, pts, arcs: restoreArcTags(pts, c.l.pts, c.l.arcs) } : { l: c.l, pts };
  });
}
/** NODE::CheckColliding( m_draggedItems ) with the board at the block's offset: the new fan-out lines against the
 * board and each other, the moved pads against the board and the new lines (the moved vias and bridges are already
 * where they go, so the lines and pads meet them there). */
function blockDragHits(ctx: PcbCtx, R: BRouter, movedIds: Set<string>, dx: number, dy: number): Obstacle[] {
  const doc = ctx.doc, s = settingsOf(ctx); S.rworld = null; S.sworld = null;
  const lines = blockConnLines(R, dx, dy); const gone = new Set<string>(); for (const c of R.conns) for (const id of c.l.ids) gone.add(id);
  const hits = new Set<Obstacle>();
  const segsOf = (pts: Pt[]) => pts.slice(0, -1).map((a: Pt, i: number) => ({ t: "seg" as const, a, b: pts[i + 1] }));
  lines.forEach(({ l, pts }, i) => {
    if (pts.length < 2) return; const r = l.width / 2;
    for (const ob of pathHits(routeObstacles(doc, s, l.netKey, l.layer, l.netKey ? null : new Set(l.ids)), pts, r)) if (!gone.has(ob.id as string)) hits.add(ob);
    lines.forEach((o, j) => {
      if (j <= i || o.l.layer !== l.layer || o.pts.length < 2 || (l.netKey && o.l.netKey === l.netKey)) return;
      const clr = Math.max(netClearance(s, l.netKey), netClearance(s, o.l.netKey), s.minClearance || 0);
      for (const a of segsOf(pts)) for (const b of segsOf(o.pts)) if (shapeGap(Object.assign({ r }, a), Object.assign({ r: o.l.width / 2 }, b)) < clr - ROUTE_EPS) { const shape = Object.assign({ r: o.l.width / 2 }, b); hits.add({ id: o.l.ids[0], kind: "segment", net: o.l.netKey, shape, bbox: shapeBBox(shape), clr } as Obstacle); }
    });
  });
  for (const c of routerWorld(doc).conds) {
    if (!movedIds.has(c.id) || gone.has(c.id)) continue;
    if (c.kind === "pad" && isFreePad(c.pad)) continue;
    const box = c.bbox;
    for (const layer of c.layers) {
      const O = routeObstacles(doc, s, c.net, layer, null);
      obstaclesNear(O, box, 0, (ob) => { if (!movedIds.has(ob.id as string) && !gone.has(ob.id as string) && ob.kind !== "keepout" && shapeGap(c.shape, ob.shape) < ob.clr - ROUTE_EPS) hits.add(ob); return false; });
      for (const { l, pts } of lines) {
        if (l.layer !== layer || pts.length < 2 || (c.net ? c.net === l.netKey : !l.netKey)) continue;
        const clr = Math.max(netClearance(s, l.netKey), netClearance(s, c.net), s.minClearance || 0);
        for (const sg of segsOf(pts)) { const shape = Object.assign({ r: l.width / 2 }, sg); if (shapeGap(c.shape, shape) < clr - ROUTE_EPS) hits.add({ id: l.ids[0], kind: "segment", net: l.netKey, shape, bbox: shapeBBox(shape), clr } as Obstacle); }
      }
    }
  }
  S.rworld = null; S.sworld = null;
  return Array.from(hits);
}

// ---------------------------------------------------------------- BLOCK_DRAG_SESSION
export interface BlockDrag {
  keyboard: boolean;
  /** where each picked handle stood when the gesture began, by "id|key" */
  origins: Map<string, Pt>;
  /** the reshaped items and their picked handle keys */
  targets: Map<string, string[]>;
  rigid: string[]; deps: BlockEndpoint[];
  /** every node the gesture writes, as it was */
  base: Map<string, SNode>;
  moving: Set<string>;
  grab: Pt; applied: Pt; ctrl: boolean;
  router: BRouter | null;
  validation: BlockValidation;
  /** the constraint solve of the block (m_constraintAnchors, m_constraintTranslated, m_constraintSession), said once when it refuses a frame */
  constraints: { live: LiveConstraintEdit; anchors: [string, CMember][]; translated: Set<string> } | null; constraintWarned: boolean;
}
const units = () => String(appGlobal(() => editorState()!.units as string, "mm") || "mm");
const describe = (ctx: PcbCtx, id: string) => String(itemDescription(ctx.doc, id, units()) || (ctx.doc.items.get(id) || { kind: "Item" }).kind);
const drcRefusal = () => keysInText("The move violates DRC. (Ctrl+click to commit anyway.)");
const allowViolations = () => S.rs.mode === RM_MARK && !!S.rs.can_violate_drc;   // ROUTING_SETTINGS::AllowDRCViolations
/** Members a carried generator or via stitch takes along (Modify( rigidItem, RECURSE )). */
const genMembers = (doc: BoardDoc, it: KItem) => (it.kind === "generated" ? groupMembers(it.node).filter((id) => doc.items.has(id)) : []);
/**
 * BLOCK_DRAG_SESSION::Begin from the handle at `origin` (`pressInFlight`: a mouse press, else D from the keyboard).
 * "start" when the drag runs, "normal" when the handle keeps the point editor's own drag, "none" with no pickable
 * handle there, "refused" after saying why.
 */
export function beginBlockDrag(ctx: PcbCtx, origin: Pt, pressInFlight: boolean): "start" | "normal" | "none" | "refused" {
  if (!blockAnchorEditingEnabled() || S.blockDrag || !ctx.doc) return "none";
  const doc = ctx.doc, fpH = footprintHolder(doc); const { colls, expanded } = blockCollections(ctx);
  const grab = pickableAt(colls, origin, fpH); if (!grab) return "none";
  const prior = new Set(st.picked); const grabPicked = st.picked.has(grab.key);
  const refuse = (msg: string) => { ctx.toast(msg); st.picked = prior; ctx.requestRender(); return "refused" as const; };
  if (grab.c.single) { if (!grabPicked || st.picked.size < 2) return "normal"; }
  else if (!grabPicked) blockDragApplyPick(st.picked, grab.key, false);   // dragging a handle that is not picked picks just that one
  if (ctx.viewOnly) { st.picked = prior; return "none"; }
  const routerItems: KItem[] = [];
  for (const it of expanded) {
    const cap = blockDragCapability(it, fpH);
    if (cap === "unsupported") return refuse(`${describe(ctx, it.id)} cannot be dragged.`);
    if (cap === "router") routerItems.push(it);
  }
  // BlockDragMoveOrigins: a picked edge brings its two corners
  const origins = new Map<string, Pt>(), targets = new Map<string, string[]>();
  for (const k of st.picked) {
    const r = handleOf(colls, k); if (!r) { st.picked = prior; return "none"; }
    origins.set(k, r.h.p.slice() as Pt);
    const l = targets.get(r.c.id); if (l) l.push(r.h.key); else targets.set(r.c.id, [r.h.key]);
  }
  const ovr = overrideLocks();
  for (const id of targets.keys()) { const it = doc.items.get(id)!; if (isLocked(it.node) && !ovr) return refuse(`${describe(ctx, id)} is locked. Enable 'Override locks' to move it.`); }
  const participants = new Set(targets.keys()); const rigid: string[] = [];
  for (const it of expanded) {
    if (participants.has(it.id)) continue;
    if (isLocked(it.node) && !ovr) return refuse(`${describe(ctx, it.id)} is locked. Enable 'Override locks' to move it.`);
    participants.add(it.id);
    if (blockDragCapability(it, fpH) === "router") { if (it.kind === "footprint") rigid.push(it.id); continue; }
    rigid.push(it.id);
  }
  // the ends of everything the block moves seed the search for graphics that follow
  const moved: BlockEndpoint[] = [];
  for (const [id, keys] of targets) {
    const it = doc.items.get(id)!; if (it.kind !== "gr_line") continue;
    for (const key of keys) if (key === "start" || key === "end") moved.push({ id, isStart: key === "start", pos: origins.get(id + "|" + key)!, whole: false });
  }
  for (const id of rigid) {
    const it = doc.items.get(id)!; if (it.kind !== "gr_line" && it.kind !== "gr_arc") continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (a) moved.push({ id, isStart: true, pos: a, whole: true }); if (b) moved.push({ id, isStart: false, pos: b, whole: true });
  }
  let deps: BlockEndpoint[] = [];
  if (moved.length) {
    const candidates = Array.from(doc.items.values()).filter((it) => it.kind.startsWith("gr_") && !participants.has(it.id));
    const found = blockDragFindDependents(candidates, moved, ovr, (id) => layerOf(doc.items.get(id)!.node));
    if (!found) return refuse("A locked connected item prevents the drag. Enable 'Override locks' to move it.");
    deps = found;
  }
  // the router's session starts after every other refusal
  let router: BRouter | null = null;
  if (routerItems.length) {
    if (S.route || S.drag) return refuse("The router is busy.");
    const vias = routerItems.filter((it) => it.kind === "via"), fps = routerItems.filter((it) => it.kind === "footprint"), links = routerItems.filter((it) => it.kind === "segment" || it.kind === "arc");
    const hasCopper = vias.length || links.length || fps.some((fp) => padsOf(fp).length);
    if (hasCopper) {
      router = blockDraggerStart(doc, vias, fps, links);
      if (!router.rigidPads.size && !router.rigidVias.size && !router.bridges.size && !router.conns.length && !router.anchored.length) return refuse("The copper in the selection cannot be dragged.");
      if (router.anchored.length) ctx.toast(router.anchored.length === 1 ? "1 selected arc cannot move because both ends are fixed." : `${router.anchored.length} selected arcs cannot move because both ends are fixed.`);
    }
  }
  const base = new Map<string, SNode>(); const keep = (id: string) => { const it = doc.items.get(id); if (it && !base.has(id)) base.set(id, clone(it.node)); };
  for (const id of targets.keys()) keep(id);
  for (const id of rigid) { keep(id); for (const m of genMembers(doc, doc.items.get(id)!)) keep(m); }
  for (const d of deps) keep(d.id);
  if (router) { for (const id of router.rigidVias) keep(id); for (const id of router.bridges) keep(id); }
  const moving = new Set<string>(base.keys());
  // Everything the gesture writes is fixed for the solver: a picked handle ends where the user put it and a carried item
  // at its own offset, while the rest of their constraint clusters is free to move
  let constraints: BlockDrag["constraints"] = null; const validationScope = new Set(moving);
  if (boardHasConstraints(ctx)) {
    const live = new LiveConstraintEdit(ctx); const board = live.board; const seeds: string[] = []; const anchors: [string, CMember][] = []; const translated = new Set<string>();
    for (const [id, keys] of targets) {
      const sh = board.resolve(id); if (!sh || sh.cls !== "shape") continue;
      for (const key of keys) { const o = origins.get(id + "|" + key)!; const m = memberForEditPoint(sh, key, [Math.round(o[0] * 1e6), Math.round(o[1] * 1e6)]); if (m) anchors.push([id, m.member]); }
      seeds.push(id);
    }
    // a carried container moves its graphics with it, so their offset is pinned too
    const carryWhole = (id: string) => { for (const it of board.items().values()) if (it.top === id || it.id === id) { translated.add(it.id); seeds.push(it.id); } };
    for (const id of rigid) { carryWhole(id); for (const m of genMembers(doc, doc.items.get(id)!)) carryWhole(m); }
    for (const d of deps) {
      if (d.whole) { carryWhole(d.id); continue; }   // the gesture moves a whole arc by the block offset
      anchors.push([d.id, cMember(d.id, d.isStart ? "start" : "end")]); seeds.push(d.id);   // already placed: it pins its joint
    }
    const session = new BoardConstraintBlockSession();
    if (seeds.length && session.build(board, seeds)) { live.block = session; for (const [id, n] of base) live.own(id, n); constraints = { live, anchors, translated }; }
    for (const id of constraintCoMembers(board, moving)) validationScope.add(id);   // the solver can move them, so validation watches them
  }
  const validation = captureBaseline(doc, validationScope);
  S.blockDrag = { keyboard: !pressInFlight, origins, targets, rigid, deps, base, moving, grab: grab.h.p.slice() as Pt, applied: [0, 0], ctrl: false, router, validation, constraints, constraintWarned: false } as BlockDrag;
  ctx.requestRender();
  return "start";
}
/** applyFrame: the reshaped items (corners first, then the picked edges from their corners), the items carried
 * whole, the joined ends that follow and the router's copper, all from where they stood, so a long drag cannot drift. */
function applyFrame(ctx: PcbCtx, B: BlockDrag, dx: number, dy: number): "applied" | "lost" | "constrained" {
  const doc = ctx.doc; const out = new Map<string, SNode>();
  for (const id of B.base.keys()) if (!doc.items.has(id)) return "lost";   // a picked handle has gone (LOST_IDENTITY)
  for (const [id, keys] of B.targets) {
    const it = doc.items.get(id)!; let node = clone(B.base.get(id)!);
    const order = keys.filter((k) => !isEditLine(k)).concat(keys.filter(isEditLine));
    for (const key of order) { const o = B.origins.get(id + "|" + key)!; const p: Pt = [r6(o[0] + dx), r6(o[1] + dy)]; node = editPointNode(node, it.kind, key, p, p, null, { ctrl: B.ctrl }); }
    out.set(id, node);
  }
  const translate = (id: string) => { const n = clone(B.base.get(id)!); if (dx || dy) translateNode(n, dx, dy); out.set(id, n); };
  for (const id of B.rigid) { translate(id); for (const m of genMembers(doc, doc.items.get(id)!)) if (B.base.has(m)) translate(m); }
  for (const d of B.deps) {
    const n = out.get(d.id) || clone(B.base.get(d.id)!);
    if (d.whole) { const at = pt(n, d.isStart ? "start" : "end")!; translateNode(n, d.pos[0] + dx - at[0], d.pos[1] + dy - at[1]); }
    else { const k = K.kid(n, d.isStart ? "start" : "end"); if (k) { k[1] = r6(d.pos[0] + dx); k[2] = r6(d.pos[1] + dy); } }
    out.set(d.id, n);
  }
  if (B.router) for (const id of [...B.router.rigidVias, ...B.router.bridges]) if (!out.has(id)) translate(id);
  for (const [id, n] of out) { const it = doc.items.get(id)!; it.node.length = 0; it.node.push(...n); K.replaceChange(doc, it); }
  B.applied = [dx, dy];
  // the picked handles (at the positions the reshape actually used) and the carried offset are held; everything else in
  // their clusters moves as little as the relations allow.  Every frame solves from the starting geometry.
  if (B.constraints) {
    const { live, anchors, translated } = B.constraints; const board = live.begin(); const pins: [CMember, Pt][] = [];
    for (const [id, m] of anchors) { const a = itemAnchors(board.resolve(id)).find((x) => x.anchor === m.anchor && (x.anchor !== "vertex" || x.index === m.index)); if (a) pins.push([m, a.pos]); }
    const r = live.block!.solve(pins, translated, [Math.round(dx * 1e6), Math.round(dy * 1e6)]);
    if (r.result === "refused") { board.edits.clear(); board.invalidate(); return "constrained"; }
    live.flush();
  }
  if (B.router) {
    const moved = new Set<string>(B.rigid.filter((id) => doc.items.get(id)!.kind === "footprint")); for (const id of B.router.rigidVias) moved.add(id); for (const id of B.router.bridges) moved.add(id);
    const hits = blockDragHits(ctx, B.router, moved, dx, dy); B.router.hits = hits; B.router.status = !hits.length;
  }
  return "applied";
}
function restoreBase(ctx: PcbCtx, B: BlockDrag) {
  if (B.constraints) B.constraints.live.takeBack();   // the neighbours the solver moved go back too
  for (const [id, n] of B.base) { const it = ctx.doc.items.get(id); if (!it) continue; it.node.length = 0; it.node.push(...clone(n)); K.replaceChange(ctx.doc, it); }
}
/** releaseState + revert: the board back as it was, the gesture's state gone. */
function endBlockDrag(ctx: PcbCtx, keepPicks: boolean) {
  const B = S.blockDrag as BlockDrag | null; S.blockDrag = null; if (B) restoreBase(ctx, B);
  S.rworld = null; S.sworld = null;
  if (!keepPicks) st.picked.clear();
  ctx.requestRender();
}
/** BLOCK_DRAG_SESSION::Abort: a drag still running is undone (an exit that misses the release and cancel paths). */
export function abortBlockDrag(ctx: PcbCtx) { if (S.blockDrag) { const B = S.blockDrag as BlockDrag; S.blockDrag = null; restoreBase(ctx, B); st.picked.clear(); } }
/** BLOCK_DRAG_SESSION::ApplyCursor: the grabbed handle snaps (the moving items are no snap targets) and the block follows. */
export function blockDragMove(ctx: PcbCtx, mm: Pt, mods: { shiftKey?: boolean; ctrlKey?: boolean }) {
  const B = S.blockDrag as BlockDrag | null; if (!B) return;
  B.ctrl = !!mods.ctrlKey;   // Ctrl while moving: a picked polygon edge keeps its length (POLYGON_LINE_MODE::FIXED_LENGTH)
  const sn = snapCursor(ctx, [mm[0], mm[1]], B.moving, { shiftKey: !!mods.shiftKey, ctrlKey: !!mods.ctrlKey }, null);
  const dx = r6(sn.p[0] - B.grab[0]), dy = r6(sn.p[1] - B.grab[1]);
  const accepted = B.applied;
  let res = applyFrame(ctx, B, dx, dy);
  if (res === "constrained") {   // said once, not per frame: the block keeps resisting while the cursor has no solution
    if (!B.constraintWarned) { ctx.toast("The move would break a geometric constraint."); B.constraintWarned = true; }
    res = applyFrame(ctx, B, accepted[0], accepted[1]) === "lost" ? "lost" : "applied";
  }
  if (res === "lost") {   // LOST_IDENTITY: put the geometry back, the rest of this press is ignored
    const press = !B.keyboard; endBlockDrag(ctx, false); if (press) st.consumed = -1; return;
  }
  ctx.requestRender();
}
/** BLOCK_DRAG_SESSION::Release (Ctrl: the router's forced placement).  True when something was committed. */
export function blockDragRelease(ctx: PcbCtx, force: boolean): boolean {
  const B = S.blockDrag as BlockDrag | null; if (!B) return false;
  const [dx, dy] = B.applied;
  if (!dx && !dy) { endBlockDrag(ctx, true); return false; }   // a gesture that changed nothing leaves no undo entry
  if (applyFrame(ctx, B, dx, dy) === "lost") { endBlockDrag(ctx, false); return false; }
  const v = validate(ctx.doc, B.validation);
  const refuse = (msg: string) => { ctx.toast(msg); endBlockDrag(ctx, true); return false; };
  if (v !== "ok") return refuse(v === "zone" ? "The move would break a zone outline." : "The move would break the board outline.");
  if (B.router && !B.router.status && !allowViolations() && !force) return refuse(drcRefusal());
  const label = B.router || B.rigid.length || B.deps.length || B.targets.size > 1 ? "Drag block" : B.origins.size > 1 ? "Move Points" : "Move Point";
  const now = new Map<string, SNode>(); for (const id of B.base.keys()) now.set(id, clone(ctx.doc.items.get(id)!.node));
  if (B.constraints) for (const id of B.constraints.live.touched) if (!now.has(id) && ctx.doc.items.has(id)) now.set(id, clone(ctx.doc.items.get(id)!.node));   // the solver's neighbours, staged in m_commit
  const conn = B.router ? blockConnLines(B.router, dx, dy) : [];
  S.blockDrag = null; restoreBase(ctx, B);   // the originals back first, so the commit records a true inverse
  const changes: PcbChange[] = [];
  for (const [id, n] of now) { const it = ctx.doc.items.get(id)!; if (K.serialize(n) !== K.serialize(it.node)) changes.push(replacedChange(it, n)); }
  if (conn.length) changes.push(...dragChanges(ctx, { sol: { lines: conn } }));
  if (changes.length) ctx.commit(changes, label);
  S.rworld = null; S.sworld = null; ctx.requestRender();
  return changes.length > 0;
}
/** BLOCK_DRAG_SESSION::Cancel: Escape undoes the drag and keeps the picks; the other cancels drop them too. */
export function blockDragCancel(ctx: PcbCtx, escape: boolean) { const B = S.blockDrag as BlockDrag | null; if (!B) return; const press = !B.keyboard; endBlockDrag(ctx, escape); if (escape && press) st.consumed = -1; }
/** IsCancelInteractive in the point editor's loop: a running drag or area pick ends, else the picks go first. */
export function blockCancel(ctx: PcbCtx | null): boolean {
  if (!ctx) return false;
  if (S.blockDrag) { blockDragCancel(ctx, true); return true; }
  if (st.area) { finishArea(ctx, false); return true; }
  if (st.picked.size && blockAnchorEditingEnabled()) { st.picked.clear(); ctx.requestRender(); return true; }
  return false;
}
/** D / G over a picked handle starts the gesture from the keyboard; the cursor then moves it and a click places it.
 * True when the key stays here. */
export function blockDragKey(ctx: PcbCtx): boolean {
  if (!blockAnchorEditingEnabled()) return false;
  if (S.blockDrag || S.pedit) return true;   // an edit already running owns D
  const at = ctx.cursor ? ctx.cursor.slice() as Pt : null; if (!at) return false;
  const r = beginBlockDrag(ctx, at, false);
  return r === "start" || r === "refused";
}
/** Items the canvas leaves out while the router's fan-out lines are drawn where they go. */
export function blockHiddenIds(): Set<string> | null {
  const B = S.blockDrag as BlockDrag | null; if (!B || !B.router || !B.router.conns.length || (!B.applied[0] && !B.applied[1])) return null;
  const out = new Set<string>(); for (const c of B.router.conns) for (const id of c.l.ids) out.add(id); return out;
}

// ---------------------------------------------------------------- pointer and keys
/** A left press on a pickable handle (or anything while a keyboard drag runs) belongs to the gesture. */
export function onBlockPointerDown(ev: PointerEvent) {
  const ctx = lastCtx; if (!ctx || !ctx.doc || !isBoardLikeDoc() || ev.button !== 0 || !blockAnchorEditingEnabled()) return;
  const stage = ctx.stage; if (!stage || !(ev.target instanceof Element) || !stage.contains(ev.target) || ev.target.closest("#cmtPanel")) return;
  const mm = ctx.worldMm(ev) as Pt;
  const take = () => { ev.stopImmediatePropagation(); ev.preventDefault(); try { stage.setPointerCapture(ev.pointerId); } catch (e) { /* synthetic event */ } };
  if (S.blockDrag) { take(); if ((S.blockDrag as BlockDrag).keyboard) st.press = { mm, client: [ev.clientX, ev.clientY], pointerId: ev.pointerId, shift: ev.shiftKey, keyHit: null, single: false, release: true }; return; }
  if (st.area) {   // the lasso adds a corner on a click
    take(); if (st.area.lasso) { st.area.pts.push(mm); st.area.cur = mm; ctx.requestRender(); }
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey || (ctx as { tool?: string }).tool && (ctx as { tool?: string }).tool !== "select") return;
  if (S.route || S.draw || S.drag || S.move || S.pedit || S.modTool) return;
  const { colls } = blockCollections(ctx); if (!colls.length) return;
  const hit = pickableAt(colls, mm, footprintHolder(ctx.doc)); if (!hit) return;
  // a lone object's handle keeps the point editor's own drag unless it is one of two or more picks; with Shift the
  // press is still the point editor's (a click toggles the pick)
  if (hit.c.single && !ev.shiftKey && !(st.picked.has(hit.key) && st.picked.size >= 2)) return;
  take(); st.press = { mm, client: [ev.clientX, ev.clientY], pointerId: ev.pointerId, shift: ev.shiftKey, keyHit: hit.key, single: hit.c.single };
}
/** Pointer motion: the drag, the area pick or a pending press.  True when it was taken here. */
export function blockPointerMove(ctx: PcbCtx, ev: PointerEvent): boolean {
  const mm = ctx.worldMm(ev) as Pt;
  if (st.consumed !== null) return !!(ev.buttons & 1) || (st.consumed = null, false);   // the rest of a swallowed press
  if (st.area) {
    const a = st.area; a.cur = mm;
    if (a.lasso) { if (ev.buttons & 1) a.pts.push(mm); } else a.end = mm;
    ctx.requestRender(); return true;
  }
  const B = S.blockDrag as BlockDrag | null;
  if (B && (B.keyboard || (ev.buttons & 1))) { blockDragMove(ctx, mm, ev); return true; }
  const p = st.press; if (!p || p.done) return !!p;
  if (!isPastDragThreshold(ev.clientX - p.client[0], ev.clientY - p.client[1])) return true;
  p.done = true;
  const r = beginBlockDrag(ctx, p.mm, true);
  if (r === "start") { blockDragMove(ctx, mm, ev); return true; }
  if (r === "refused") { st.press = null; st.consumed = ev.pointerId; return true; }
  st.press = null;
  if (r === "normal") {   // a lone object's handle that is not one of several picks: the point editor's own drag (Shift: no snapping)
    const hit = editHandleAt(ctx.doc, p.mm[0], p.mm[1], handleTol());
    if (hit && !ctx.viewOnly) { startHandleEdit(ctx, ctx.doc, hit, p.mm); editHandleMove(ctx, mm, ev); }
    return true;
  }
  return false;
}
/** Pointer release: the drag is placed, a lasso keeps going, a box picks, a click on a handle picks it. */
export function blockPointerUp(ctx: PcbCtx, ev: PointerEvent | null): boolean {
  if (st.consumed !== null) { st.consumed = null; return true; }
  if (st.area) { if (!st.area.lasso) finishArea(ctx, !!ev && ev.type === "pointerup"); return true; }
  const B = S.blockDrag as BlockDrag | null, p = st.press; st.press = null;
  if (B) {
    if (B.keyboard && !(p && p.release)) return true;
    if (!ev || ev.type !== "pointerup") { blockDragCancel(ctx, false); return true; }
    blockDragRelease(ctx, !!(ev.ctrlKey || ev.metaKey)); return true;
  }
  if (!p) return false;
  if (!p.done && ev && ev.type === "pointerup") pickHandleAt(ctx, p.mm, p.shift);   // IsClick
  return true;
}
/** Keys while the lasso is open: Backspace / Delete / Ctrl+Z take the last corner back, End / Enter close it, Escape
 * cancels (runLasso). */
export function onBlockKeyDown(ev: KeyboardEvent) {
  const ctx = lastCtx; const a = st.area; if (!ctx || !a) return;
  const t = ev.target as HTMLElement | null; if (t && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
  const undo = (ev.ctrlKey || ev.metaKey) && !ev.shiftKey && ev.key.toLowerCase() === "z";
  if (a.lasso && (ev.key === "Backspace" || ev.key === "Delete" || undo)) { if (a.pts.length > 1) a.pts.pop(); }
  else if (a.lasso && (ev.key === "End" || ev.key === "Enter")) finishArea(ctx, true);
  else if (ev.key === "Escape") finishArea(ctx, false);
  else return;
  ev.stopImmediatePropagation(); ev.preventDefault(); ctx.requestRender();
}
/** A double click closes the lasso (cursorDblClick). */
export function onBlockDblClick(ev: MouseEvent) {
  const ctx = lastCtx; if (!ctx || !st.area || !st.area.lasso) return;
  ev.stopImmediatePropagation(); ev.preventDefault(); finishArea(ctx, true);
}

// ---------------------------------------------------------------- drawing (EDIT_POINTS::ViewDraw, HANDLE_PICK_AREA)
/** The block handles with their picked / hovered state, the joined ends that follow, the pick band and the router's
 * fan-out lines with what they collide with. */
export function drawBlock(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  if (!blockAnchorEditingEnabled() || S.route || S.draw || S.drag || S.move || S.modTool || !ctx.doc) return;
  const { colls } = blockCollections(ctx);
  const { fill, border, highlight } = editPointColors(auxItemsColor(), K.PCB_BG || "#001023");
  const size = EDIT_POINT_PX / 2 * px, fpH = footprintHolder(ctx.doc), B = S.blockDrag as BlockDrag | null;
  const cur = ctx.cursor || null; const hov = !B && !st.area && cur ? pickableAt(colls.filter((x) => !x.single), cur, fpH) : null;
  c.save(); c.globalAlpha = 1; c.setLineDash([]);
  const square = (p: Pt, circle: boolean) => { c.beginPath(); if (circle) c.arc(p[0], p[1], size, 0, Math.PI * 2); else c.rect(p[0] - size, p[1] - size, 2 * size, 2 * size); };
  if (B && B.router) {
    for (const ob of B.router.hits || []) { drawShape(c, ob.shape, ob.clr, HALO_COLOR, 0.7); drawShape(c, ob.shape, 0, "#00FF00", 1); }
    for (const { l, pts } of blockConnLines(B.router, B.applied[0], B.applied[1])) {
      if (pts.length < 2) continue;
      if (B.router.hits && B.router.hits.length) { c.globalAlpha = HALO_STROKE_ALPHA; c.strokeStyle = HALO_COLOR; c.lineWidth = l.width + 2 * Math.max(netClearance(settingsOf(ctx), l.netKey), settingsOf(ctx).minClearance || 0); polyline(c, pts, false); }
      c.globalAlpha = 0.8; c.strokeStyle = previewColor(l.layer, l.netKey); c.lineWidth = l.width; polyline(c, pts, false);
    }
    c.globalAlpha = 1;
  }
  for (const col of colls) {
    if (col.single) continue;   // the point editor draws its own
    for (const h of col.pts) if (h.lines) { c.lineWidth = EDIT_BORDER_PX / 4 * px; c.strokeStyle = border; for (const q of h.lines) line(c, h.p, q); }
    for (const h of col.pts) {
      const k = col.id + "|" + h.key, sel = st.picked.has(k), on = !!hov && hov.key === k;
      c.lineWidth = (sel || on ? EDIT_HOVER_PX : EDIT_BORDER_PX) * px; c.strokeStyle = sel || on ? highlight : border; c.fillStyle = sel ? highlight : fill;
      square(h.p, !!h.circle); c.fill(); c.stroke();
    }
  }
  if (B) for (const d of B.deps) {   // SetDependent: the highlight border, no fill
    c.lineWidth = EDIT_BORDER_PX * px; c.strokeStyle = highlight; square([d.pos[0] + B.applied[0], d.pos[1] + B.applied[1]], false); c.stroke();
  }
  if (st.area) {   // HANDLE_PICK_AREA in the handle colour: stroke at 0.9, fill at 0.15
    const a = st.area; const P = a.lasso ? a.pts.concat([a.cur]) : blockDragPickRect(a.start, a.end);
    if (P.length >= 2) {
      c.beginPath(); c.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) c.lineTo(P[i][0], P[i][1]); c.closePath();
      c.globalAlpha = 0.15; c.fillStyle = fill; c.fill(); c.globalAlpha = 0.9; c.strokeStyle = fill; c.lineWidth = px; c.stroke();
    }
  }
  if (B && B.router && !B.router.status && !allowViolations() && cur) { c.restore(); drawStatusNote(c, cur, px, "The move violates DRC.", keysInText("(Ctrl+click to commit anyway.)")); return; }
  c.restore();
}

/** The node test's handle on the block gesture (PcbTools.blockDrag). */
export const blockDragApi = {
  capability: blockDragCapability, expandSelection: blockDragExpandSelection, handlePickable: blockDragHandlePickable, applyPick: blockDragApplyPick,
  pickRect: blockDragPickRect, lassoPick: blockDragLassoPick, findDependents: blockDragFindDependents, zoneOutlineIsSound, boardOutlineIsValid,
  collections: blockCollections, pickHandleAt, click: blockClick, areaPickStarts, areaDrag: blockAreaDrag, begin: beginBlockDrag, move: blockDragMove,
  release: blockDragRelease, cancel: blockCancel, key: blockDragKey, pointerDown: onBlockPointerDown, pointerMove: blockPointerMove, pointerUp: blockPointerUp,
  draggerStart: blockDraggerStart, connLines: blockConnLines, hiddenIds: blockHiddenIds,
  picked: () => Array.from(st.picked).sort(), area: () => st.area,
};
