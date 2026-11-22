import type { Anchor, BreakCut, BreakJob, SchCtx, SchDrag, Pt, Box } from "./types";
import { root } from "../root";
import { apPrefs, autoplaceAlgo, autoplaceNode, symbolLibId } from "./autoplace";
import { canFollow } from "./clipboard";
import { cursorOf, editable, selectedItems, setSelectionIds, snapCursor } from "./commands";
import { junctionAt, needsJunction } from "./connect";
import { DRAG_KINDS, LABEL_KINDS, announceModes, applyDrag, breakInto, cleanupAt, connPoints, endDrag, foldChanges, isNetLine, makeAnchor, restoreNode, noConnectsAt } from "./drag";
import { editTxn } from "./junction";
import { hitNonSymbol, rectOf } from "./hit";
import { PIN_SIDE, corners, flagFieldAt, fontNode, imageData, imageNode, junctionNode, lineNode } from "./nodes";
import { SCREEN_OP, anchorOf, mirrorNode, mirrorTextSpin, orientSymbol, rotateText90, setTextRot, shiftAt, shiftNode, symOrient } from "./orient";
import { mmPerPx } from "./snap";
import { K, LINE_KINDS, POINT_KINDS, S, TEXT_KINDS, atOf, kid, kids, num, ptsOf, setAt, setPts, str } from "./state";
import { selEndOf } from "./line-ends";
import { addNode, deep, dropKid, modChange, r4, removeChange, replaceKid, same, segDist } from "./util";
import { isLockedNode, unlockedSelection } from "./lock";
import "../../../../shared/components/kselect";   // <k-select>, the themed drop-down these use in place of <select>

// ---------------------------------------------------------------- group transforms: rotate / mirror about the selection centre, swap, align, move exactly
export const HALF_GRID = 0.635;
export const halfGrid = (v: number) => r4(Math.round(v / HALF_GRID) * HALF_GRID);
export function itemsBox(items: KItem[]) { let b: Box | null = null; for (const it of items) { const r = it.bbox || rectOf(it); if (!r) continue; b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r.slice(); } return b; }
/**
 * GetNearestHalfGridPosition( SELECTION::GetCenter() ): a selection of texts and labels only turns about the mean of
 * their positions ("otherwise rotating the selection will also translate it"); anything else about the centre of the
 * boxes of its items that are not texts or labels.
 */
export function selectionCentre(items: KItem[]): Pt {
  const isText = (k: string) => k === "text" || LABEL_KINDS.has(k);
  if (items.length && items.every((it) => isText(it.kind))) {
    let x = 0, y = 0; for (const it of items) { const a = anchorOf(it.kind, it.node); x += a[0]; y += a[1]; }
    return [halfGrid(x / items.length), halfGrid(y / items.length)];
  }
  const b = itemsBox(items.filter((it) => !isText(it.kind)));
  return b ? [halfGrid((b[0] + b[2]) / 2), halfGrid((b[1] + b[3]) / 2)] : [0, 0];
}
// SCH_EDIT_TOOL::Rotate's pivot: a lone connectable item turns about its position, anything else about its
// half-grid box centre; a multi-selection about the selection centre.
export function rotationCentre(items: KItem[], op?: string) {
  if (items.length !== 1) return selectionCentre(items);
  if (items[0].kind === "table") return tableCentre(items[0].node);
  // a lone sheet turns about GetNearestHalfGridPosition( SCH_SHEET::GetRotationCenter() ), the centre of its body
  // (position and size) without its fields and pin texts; a mirror uses the whole bounding box's centre
  if (items[0].kind === "sheet" && op !== "x" && op !== "y") { const [x, y] = atOf(items[0].node), s = kid(items[0].node, "size"); if (s) return [halfGrid(x + num(s[1]) / 2), halfGrid(y + num(s[2]) / 2)]; }
  const it = items[0], own = it.kind === "symbol" || LABEL_KINDS.has(it.kind) || POINT_KINDS.has(it.kind) || TEXT_KINDS.has(it.kind);
  return own ? anchorOf(it.kind, it.node) : selectionCentre(items);
}
/**
 * The pivot of a lone SCH_LINE (two points): SCH_EDIT_TOOL::Rotate turns it about its end point when STARTPOINT is
 * set (a whole line has both flags) and about its start when only ENDPOINT is; SCH_EDIT_TOOL::Mirror's single-item
 * default mirrors about GetPosition(), the start.  null for anything else.
 */
export function loneLinePivot(it: KItem, op: string): Pt | null {
  if (!LINE_KINDS.has(it.kind)) return null;
  const p = ptsOf(it.node); if (p.length !== 2) return null;
  if (op === "x" || op === "y") return [p[0][0], p[0][1]];
  return selEndOf(it.id) === 1 ? [p[0][0], p[0][1]] : [p[1][0], p[1][1]];
}
/** SCH_TABLE::GetCenter: the centre of the box of its cells' starts and ends. */
export function tableRawCentre(node: SNode): Pt {
  const M = K.tableModel; let b: Box | null = null;
  for (const c of M.tableInfo(node).cells) { const { s, e } = M.cellStartEnd(c, false); for (const p of [s, e]) b = b ? [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])] : [p[0], p[1], p[0], p[1]]; }
  return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
/** A lone table turns about GetNearestHalfGridPosition( SCH_TABLE::GetCenter() ). */
export function tableCentre(node: SNode): Pt { const c = tableRawCentre(node); return [halfGrid(c[0]), halfGrid(c[1])]; }
// op: "ccw" | "cw" | "x" (KiCad's Mirror Vertically: y flips) | "y" (Mirror Horizontally: x flips)
export function mapPoint(op: string, C: Pt, p: Pt): Pt { const [dx, dy] = SCREEN_OP[op](p[0] - C[0], p[1] - C[1]); return [r4(C[0] + dx), r4(C[1] + dy)]; }
export function setFlagRot(node: SNode, rot: number) {
  rot = ((rot % 360) + 360) % 360; const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = rot; else a.push(rot);
  const p = [num(a[1]), num(a[2])]; for (const pr of kids(node, "property")) replaceKid(pr, flagFieldAt(p, rot));
}
export function sideOfEdge(p: Pt, box: Box) { const d: [string, number][] = [["left", Math.abs(p[0] - box[0])], ["right", Math.abs(p[0] - box[2])], ["top", Math.abs(p[1] - box[1])], ["bottom", Math.abs(p[1] - box[3])]]; d.sort((a, b) => a[1] - b[1]); return d[0][0]; }
/**
 * Rotate / mirror one item about C.  `lone`: the item is the selection's only principal item (SCH_EDIT_TOOL::Rotate's
 * principalItemCount == 1), which a table turns about its own centre instead of C.
 */
export function transformNode(kind: string, node: SNode, op: string, C: Pt, lone = false, end: 0 | 1 | null = null) {
  const rot = op === "ccw" || op === "cw";
  const mapAt = (n: SNode) => { const a = kid(n, "at"); if (!a) return; const q = mapPoint(op, C, [num(a[1]), num(a[2])]); a[1] = q[0]; a[2] = q[1]; };
  const mapPts = (n: SNode) => setPts(n, ptsOf(n).map((p) => mapPoint(op, C, p)));
  const moveTo = (p0: Pt) => { const p1 = mapPoint(op, C, p0); shiftNode(kind, node, r4(p1[0] - p0[0]), r4(p1[1] - p0[1])); };
  switch (kind) {
  case "symbol": { const p0 = anchorOf(kind, node); orientSymbol(node, op); moveTo(p0); return true; }
  case "text": {
    // SCH_TEXT::Rotate -> Rotate90( !aRotateCCW ); MirrorHorizontally / MirrorVertically flip the justification
    const p0 = anchorOf(kind, node);
    if (rot) rotateText90(node, op === "cw"); else mirrorTextSpin(node, op === "y");
    moveTo(p0); return true;
  }
  case "label": case "global_label": case "hierarchical_label": {
    const p0 = anchorOf(kind, node);
    if (rot) setTextRot(kind, node, atOf(node)[2] + (op === "cw" ? 270 : 90)); else mirrorNode(kind, node, op);
    moveTo(p0); return true;
  }
  case "netclass_flag": case "directive_label": {
    const p0 = anchorOf(kind, node), r0 = atOf(node)[2] || 0;
    if (rot) setFlagRot(node, r0 + (op === "cw" ? 270 : 90)); else { const flip: Record<number, number> = op === "y" ? { 0: 180, 180: 0 } : { 90: 270, 270: 90 }; if (flip[r0] !== undefined) setFlagRot(node, flip[r0]); }
    moveTo(p0); return true;
  }
  case "junction": case "no_connect": mapAt(node); return true;
  case "image": {
    // SCH_BITMAP::Rotate -> REFERENCE_IMAGE::Rotate: the centre turns about C and the orientation gains the angle
    // (ANGLE_90 counter-clockwise on screen); a mirror moves the centre here and transformSelected flips the raster (BITMAP_BASE::Mirror)
    mapAt(node);
    if (rot) {
      const r = kid(node, "rotate"), a = ((((r ? num(r[1], 0) : 0) + (op === "ccw" ? 90 : 270)) % 360) + 360) % 360, v = r4(a);
      if (!v) { if (r) node.splice(node.indexOf(r), 1); }
      else if (r) r[1] = v;
      else { const at = kid(node, "at"); node.splice(at ? node.indexOf(at) + 1 : 1, 0, ["rotate", v]); }
    }
    return true;
  }
  case "bus_entry": { mapAt(node); const s = kid(node, "size"); if (s) { const [dx, dy] = SCREEN_OP[op](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); } return true; }
  case "wire": case "bus": case "polyline": case "bezier": {
    // SCH_LINE::Rotate / MirrorHorizontally / MirrorVertically move only the flagged end of a line selected by one end
    const pts = ptsOf(node);
    if (end !== null && kind !== "bezier" && pts.length === 2) { const q = mapPoint(op, C, pts[end]); pts[end] = [q[0], q[1]]; setPts(node, pts); return true; }
    mapPts(node); return true;
  }
  case "rule_area": for (const pl of kids(node, "polyline")) mapPts(pl); return true;
  case "rectangle": { const a = kid(node, "start")!, b = kid(node, "end")!; const [x0, y0, x1, y1] = corners(mapPoint(op, C, [num(a[1]), num(a[2])]), mapPoint(op, C, [num(b[1]), num(b[2])])); a[1] = x0; a[2] = y0; b[1] = x1; b[2] = y1; return true; }
  case "circle": { const c = kid(node, "center")!; const p = mapPoint(op, C, [num(c[1]), num(c[2])]); c[1] = p[0]; c[2] = p[1]; return true; }
  case "ellipse": case "ellipse_arc": {
    // EDA_SHAPE::rotate: the centre turns and Rotation -= angle (a quarter turn on screen); ELLIPSE::Mirror: the centre
    // mirrors, Rotation = -Rotation, and the arc's parametric angles go to [pi - e, pi - s] (left-right) or [-e, -s]
    const c = kid(node, "center")!; const p = mapPoint(op, C, [num(c[1]), num(c[2])]); c[1] = p[0]; c[2] = p[1];
    const ra = kid(node, "rotation_angle"), phi = ra ? num(ra[1]) : 0;
    const set = (key: string, v: number) => { const k = kid(node, key); v = r4(v); if (k) k[1] = v; else node.push([key, v]); };
    if (rot) set("rotation_angle", phi + (op === "ccw" ? -90 : 90));
    else {
      set("rotation_angle", -phi);
      if (kind === "ellipse_arc") { const s = num((kid(node, "start_angle") || [])[1], 0), e = num((kid(node, "end_angle") || [])[1], 0); if (op === "y") { set("start_angle", 180 - e); set("end_angle", 180 - s); } else { set("start_angle", -e); set("end_angle", -s); } }
    }
    return true;
  }
  case "arc": { for (const key of ["start", "mid", "end"]) { const k = kid(node, key); if (k) { const p = mapPoint(op, C, [num(k[1]), num(k[2])]); k[1] = p[0]; k[2] = p[1]; } } return true; }
  case "text_box": {
    const [x, y, a] = atOf(node), s = kid(node, "size"); if (!s) return false;
    const [x0, y0, x1, y1] = corners(mapPoint(op, C, [x, y]), mapPoint(op, C, [x + num(s[1]), y + num(s[2])]));
    const vertical = a === 90 || a === 270;
    setAt(node, x0, y0, rot ? (vertical ? 0 : 90) : a); s[1] = r4(x1 - x0); s[2] = r4(y1 - y0);
    if (!rot && ((op === "y" && !vertical) || (op === "x" && vertical))) { const ef = kid(node, "effects"), j = ef && kid(ef, "justify"); if (j) { const i = j.indexOf("left") > 0 ? j.indexOf("left") : j.indexOf("right"); if (i > 0) j[i] = j[i] === "left" ? "right" : "left"; } }
    return true;
  }
  case "table": {
    // SCH_TABLE::Rotate: every cell (an SCH_TEXTBOX) turns its start and end about the pivot and swaps its text angle
    // between horizontal and vertical, then Normalize lays the cells out again from cell 0.  SCH_EDIT_TOOL::Rotate
    // then moves the table back: a lone table about rotPoint = GetNearestHalfGridPosition( GetCenter() ) by
    // rotPoint - GetNearestHalfGridPosition( GetCenter() ), one of several so its old centre lands where the
    // rotation takes it.  SCH_TABLE's MirrorHorizontally / MirrorVertically do nothing ("doesn't seem useful"), so a
    // mirror leaves the table alone.
    const cells = kid(node, "cells"); if (!cells || !rot) return false;
    if (lone) C = tableCentre(node);
    const before = tableRawCentre(node);
    for (const c of kids(cells, "table_cell")) {
      const a = kid(c, "at"), sz = kid(c, "size"); if (!a || !sz) continue;
      const p0: Pt = [num(a[1]), num(a[2])], p1: Pt = [p0[0] + num(sz[1]), p0[1] + num(sz[2])];
      const q0 = mapPoint(op, C, p0), q1 = mapPoint(op, C, p1), na = num(a[3]) === 90 ? 0 : 90;
      a[1] = q0[0]; a[2] = q0[1]; if (a.length >= 4) a[3] = na; else a.push(na);
      sz[1] = r4(q1[0] - q0[0]); sz[2] = r4(q1[1] - q0[1]);
    }
    K.tableModel.normalizeTable(node, false);
    const now = tableRawCentre(node);
    const to: Pt = lone ? C : mapPoint(op, C, before), from: Pt = lone ? [halfGrid(now[0]), halfGrid(now[1])] : now;
    const dx = r4(to[0] - from[0]), dy = r4(to[1] - from[1]);
    if (dx || dy) K.shiftTable(node, dx, dy);   // SCH_TABLE::Move
    return true;
  }
  case "sheet": {
    const [x, y] = atOf(node), s = kid(node, "size"); if (!s) return false;
    const [x0, y0, x1, y1] = corners(mapPoint(op, C, [x, y]), mapPoint(op, C, [x + num(s[1]), y + num(s[2])]));
    setAt(node, x0, y0); s[1] = r4(x1 - x0); s[2] = r4(y1 - y0);
    for (const pin of kids(node, "pin")) {
      const pp = mapPoint(op, C, atOf(pin).slice(0, 2)), [prot, just] = PIN_SIDE[sideOfEdge(pp, [x0, y0, x1, y1])];
      setAt(pin, pp[0], pp[1], prot); let ef = kid(pin, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; pin.push(ef); } replaceKid(ef, ["justify", just]);
    }
    // SCH_SHEET::Rotate: AutoplaceFields when the fields are autoplaced, else they move with the sheet's corner;
    // MirrorHorizontally / MirrorVertically only move them (SCH_EDIT_TOOL::Mirror then drops the autoplaced flag)
    const auto = kid(node, "fields_autoplaced") && str(kid(node, "fields_autoplaced")![1]) !== "no";
    if (rot && auto) sheetAutoplaceFields(node);
    else for (const pr of kids(node, "property")) shiftAt(pr, r4(x0 - x), r4(y0 - y));
    return true;
  }
  default: return false;
  }
}
/** SCH_SHEET::IsVerticalOrientation: pins on the top / bottom edges only. */
export function sheetIsVertical(node: SNode): boolean {
  let leftRight = 0, topBottom = 0;
  for (const pin of kids(node, "pin")) { const a = ((atOf(pin)[2] || 0) % 360 + 360) % 360; if (a === 90 || a === 270) topBottom++; else leftRight++; }
  return topBottom > 0 && leftRight === 0;
}
/**
 * SCH_SHEET::AutoplaceFields: the name above and the file name below a horizontal sheet; beside a vertical one (pins
 * on top / bottom only), reading upwards: the name left of the left edge, the file name right of the right edge, both
 * from the bottom.  margin = KiROUND( pen / 2 ) + 4 IU + KiROUND( text size x 0.5 ) (0.4 for the file name).
 */
export function sheetAutoplaceFields(node: SNode) {
  const IU = 1e4, kiround = (v: number) => (v < 0 ? -Math.round(-v) : Math.round(v));
  const [x, y] = atOf(node), s = kid(node, "size"); if (!s) return;
  const w = num(s[1]), h = num(s[2]), st = kid(node, "stroke"), sw = st ? num((kid(st, "width") || [])[1], 0) : 0;
  const border = kiround((sw > 0 ? sw : 0.1524) * IU / 2) + 4, vertical = sheetIsVertical(node);
  const size = (pr: SNode) => { const ef = kid(pr, "effects"), f = ef && kid(ef, "font"), z = f && kid(f, "size"); return z ? Math.max(num(z[1], 1.27), num(z[2], 1.27)) : 1.27; };
  const put = (pr: SNode, p: Pt, just: string) => {
    replaceKid(pr, ["at", r4(p[0]), r4(p[1]), vertical ? 90 : 0]);
    let ef = kid(pr, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; pr.push(ef); } replaceKid(ef, ["justify", "left", just]);
  };
  for (const pr of kids(node, "property")) {
    const name = str(pr[1]);
    if (name === "Sheetname") { const m = (border + kiround(size(pr) * IU * 0.5)) / IU; put(pr, vertical ? [x - m, y + h] : [x, y - m], "bottom"); }
    else if (name === "Sheetfile") { const m = (border + kiround(size(pr) * IU * 0.4)) / IU; put(pr, vertical ? [x + w + m, y + h] : [x, y + h + m], "top"); }
  }
}
/**
 * What SCH_EDIT_TOOL::Rotate / Mirror do to an item once it has turned: a mirror drops the autoplaced flag
 * (SetFieldsAutoplaced( AUTOPLACE_NONE ): a symbol or sheet always, any item of a multi-selection), a rotation
 * re-runs AutoplaceFields on a symbol with the symbol's own algorithm when the preference is on.  `n` is edited in place.
 */
export function afterOrient(doc: KDoc, item: Pick<KItem, "kind" | "id">, n: SNode, op: string, multi: boolean) {
  if (op === "x" || op === "y") { if (multi || item.kind === "symbol" || item.kind === "sheet") dropKid(n, "fields_autoplaced"); return; }
  if (item.kind !== "symbol" || !apPrefs().enable || !autoplaceAlgo({ node: n })) return;
  try { const a = autoplaceNode(doc, Object.assign({}, item, { node: n }) as KItem, autoplaceAlgo({ node: n, id: item.id })); if (a) { n.length = 0; n.push(...a); } } catch (e) { console.warn(e); }
}
/** SCH_SHEET::GetNoConnects: the no-connect flags sitting on a sheet's pins, by pin index. */
function sheetNoConnects(doc: KDoc, sheet: KItem): { pin: number; nc: KItem }[] {
  const out: { pin: number; nc: KItem }[] = [];
  kids(sheet.node, "pin").forEach((pin, i) => { for (const nc of noConnectsAt(doc, atOf(pin).slice(0, 2))) out.push({ pin: i, nc }); });
  return out;
}
/** The no-connects found on a sheet's pins before it was transformed follow their pins (unless they turned too). */
function noConnectChanges(doc: KDoc, held: { pin: number; nc: KItem }[], sheetNode: SNode, moved: Set<string>): KChange[] {
  const out: KChange[] = [], pins = kids(sheetNode, "pin");
  for (const { pin, nc } of held) {
    const p = pins[pin] && atOf(pins[pin]); if (!p || moved.has(nc.id) || same(atOf(nc.node), p)) continue;
    const n = deep(nc.node); setAt(n, r4(p[0]), r4(p[1])); out.push(modChange(doc, nc, n)); moved.add(nc.id);
  }
  return out;
}
// MODIFIED changes for the items transformed about C, plus the junction / merge cleanup around every connection point.
export function transformChanges(ctx: SchCtx, items: KItem[], op: string, C: Pt, times?: number) {
  const doc = ctx.doc, out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>(), all = new Set(items.map((it) => it.id));
  const ncs: { held: { pin: number; nc: KItem }[]; node: SNode }[] = [];
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node); let ok = true;
    const end = selEndOf(it.id);
    for (let k = 0; k < (times || 1) && ok; k++) ok = transformNode(it.kind, n, op, C, items.length === 1, end) !== false;
    if (!ok) continue;
    afterOrient(doc, it, n, op, items.length > 1);
    if (it.kind === "sheet") ncs.push({ held: sheetNoConnects(doc, it), node: n });
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  // the no-connects on a turned sheet's pins go to where the pins are now (SCH_SHEET::GetNoConnects)
  for (const s of ncs) for (const c of noConnectChanges(doc, s.held, s.node, all)) { out.push(c); keep.add(c.id); }
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  return foldChanges(out, extra);
}
/**
 * R / Shift+R / X / Y during a Move or Drag (SCH_MOVE_TOOL::handleMoveToolActions): the items in flight turn or mirror
 * inside the move's own commit about the move's reference point and the move goes on; Esc puts everything back and one
 * undo takes the whole move.  The turn is kept in the pre-drag frame (about the reference point before the offset), so
 * the moved items, their riders and the connection points the stretched wires follow all map the same way.
 */
export function orientDrag(ctx: SchCtx, op: string) {
  const d = S.drag; if (!d) return false;
  if (d.brk || (d.ends && d.ends.length)) return true;              // a break or a line end in flight has nothing to turn
  const [dx, dy] = d.last, doc = ctx.doc, C: Pt = [d.anchor0[0], d.anchor0[1]], lone = d.items.length === 1;
  applyDrag(doc, d, 0, 0);
  if (!d.touched0) { d.touched0 = []; for (const e of d.items) d.touched0.push(...connPoints(doc, e.item)); }
  for (const e of d.items) {
    const n = deep(e.base || e.orig);
    // a lone reference image turns the other way (SCH_EDIT_TOOL::Rotate's SCH_BITMAP_T case)
    const lop = lone && e.kind === "image" && (op === "ccw" || op === "cw") ? (op === "ccw" ? "cw" : "ccw") : op;
    if (transformNode(e.kind, n, lop, C, lone) === false) continue;
    // the autoplace sees the symbol where the move has it now, then goes back to the pre-drag frame
    if (dx || dy) shiftNode(e.kind, n, dx, dy);
    afterOrient(doc, e.item, n, op, !lone);
    if (dx || dy) shiftNode(e.kind, n, -dx, -dy);
    e.base = n;
  }
  for (const r of d.riders) {
    if (!r.node0) r.node0 = deep(r.item.node);
    const n = deep(r.base || r.node0); transformNode(r.item.kind, n, op, C);
    r.base = n; const a = atOf(n); r.orig = [a[0], a[1]];
  }
  const prev = d.mapPt; d.mapPt = (p: Pt) => mapPoint(op, C, prev ? prev(p) : p);
  applyDrag(doc, d, dx, dy);
  ctx.requestRender();
  return true;
}
/**
 * SCH_BITMAP::MirrorHorizontally / MirrorVertically -> BITMAP_BASE::Mirror: the picture itself is flipped.  The
 * raster is decoded and re-encoded (PNG) by the browser, which only answers later, so a mirror with an image in it
 * commits once the flipped data is in.  `leftRight` is in the stored picture's own frame.
 */
export type ImageFlipFn = (base64: string, leftRight: boolean) => Promise<string | null>;
function browserImageFlip(base64: string, leftRight: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const g = cv.getContext("2d"); if (!g || !cv.width || !cv.height) { resolve(null); return; }
        g.translate(leftRight ? cv.width : 0, leftRight ? 0 : cv.height); g.scale(leftRight ? -1 : 1, leftRight ? 1 : -1); g.drawImage(img, 0, 0);
        resolve(cv.toDataURL("image/png").split(",")[1] || null);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = "data:" + (base64.startsWith("/9j/") ? "image/jpeg" : "image/png") + ";base64," + base64;
  });
}
let imageFlipImpl: ImageFlipFn | null = typeof document !== "undefined" && typeof Image !== "undefined" ? browserImageFlip : null;
export function setImageFlipImpl(fn: ImageFlipFn | null) { imageFlipImpl = fn; }
/** The image items of a mirror with their rasters flipped (the others as they are); null when a picture cannot be read. */
async function mirroredImages(items: KItem[], op: string): Promise<KItem[] | null> {
  const out: KItem[] = [];
  for (const it of items) {
    if (it.kind !== "image") { out.push(it); continue; }
    const r = kid(it.node, "rotate"), quarter = Math.round((r ? num(r[1], 0) : 0) / 90) % 2 !== 0;
    // "y" mirrors left-right on the sheet; a picture stored a quarter turn away flips along its other axis
    const flipped = await imageFlipImpl!(imageData(it.node), (op === "y") !== quarter); if (!flipped) return null;
    const n = deep(it.node), d = kid(n, "data"), nd = kid(imageNode([0, 0], flipped), "data")!;
    if (d) n[n.indexOf(d)] = nd; else n.push(nd);
    out.push(Object.assign({}, it, { node: n }));
  }
  return out;
}
export function transformSelected(ctx: SchCtx, op: string, items: KItem[], centre?: Pt) {
  if (!editable(ctx)) return false;
  items = items || selectedItems(ctx); if (!items.length) return false;
  const C = centre || selectionCentre(items);
  if ((op === "x" || op === "y") && imageFlipImpl && items.some((it) => it.kind === "image")) {
    const doc = ctx.doc;
    void mirroredImages(items, op).then((flipped) => {
      if (ctx.doc !== doc || items.some((it) => doc.items.get(it.id) !== it)) return;      // the sheet moved on meanwhile
      const changes = transformChanges(ctx, flipped || items, op, C);
      if (changes.length) ctx.commit(changes, "Mirror");
    }, () => {});
    return true;
  }
  const changes = transformChanges(ctx, items, op, C);
  if (!changes.length) return false;
  ctx.commit(changes, op === "x" || op === "y" ? "Mirror" : "Rotate");
  return true;
}
export function moveExactChanges(ctx: SchCtx, items: KItem[], dx: number, dy: number, rot: number) {
  const doc = ctx.doc, turns = ((Math.round((rot || 0) / 90) % 4) + 4) % 4, C = rotationCentre(items);
  const out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>();
  for (const it of items) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    const n = deep(it.node); let ok = true;
    for (let k = 0; k < turns && ok; k++) ok = transformNode(it.kind, n, "ccw", C, items.length === 1) !== false;
    if (!ok) continue;
    shiftNode(it.kind, n, r4(dx || 0), r4(dy || 0));
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  return foldChanges(out, extra);
}
export function moveExactly(ctx: SchCtx, opts?: { dx?: number; dy?: number; rot?: number } | null) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  const apply = (dx: number, dy: number, rot: number) => { const changes = moveExactChanges(ctx, items, dx, dy, rot); if (changes.length) ctx.commit(changes, "move exactly"); return changes.length > 0; };
  if (opts && (opts.dx !== undefined || opts.dy !== undefined || opts.rot !== undefined)) return apply(num(opts.dx), num(opts.dy), num(opts.rot));
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null; if (!KD) return false;
  KD.open({ title: "Move Exactly", width: 360,
    build(body) { body.innerHTML = '<div class="kv"><label>Move X (mm)</label><input id="kd-mx" type="number" step="0.01" value="0"><label>Move Y (mm)</label><input id="kd-my" type="number" step="0.01" value="0"><label>Rotate (°)</label><k-select id="kd-mr"><option value="0">0</option><option value="90">90</option><option value="180">180</option><option value="270">270</option></k-select></div><p class="kd-note">Rotation is about the centre of the selection, counterclockwise.</p>'; },
    ok() { const g = (id: string) => document.getElementById(id) as HTMLInputElement; apply(num(g("kd-mx").value), num(g("kd-my").value), num(g("kd-mr").value)); } });
  return true;
}
// Swap the positions of the selected items pairwise in selection order (SCH_EDIT_TOOL::Swap).
/** SCH_ITEM::GetPosition(): an arc's is its centre (EDA_SHAPE::getPosition), anything else its anchor. */
export function itemPosition(kind: string, node: SNode): Pt {
  if (kind === "arc") {
    const g = (k: string) => { const c = kid(node, k); return c ? [num(c[1]), num(c[2])] : null; }, s = g("start"), m = g("mid"), e = g("end");
    const a = s && m && e ? K.arcFrom3(s, m, e) : null; if (a) return [a.x, a.y];
  }
  return anchorOf(kind, node);
}
const justifyOf = (n: SNode): SNode | null => { const ef = kid(n, "effects"); return (ef && kid(ef, "justify")) || null; };
/** Give a node (an item or a field) this (justify ...), or none (centred both ways). */
function setJustify(n: SNode, j: SNode | null) {
  let ef = kid(n, "effects"); if (!ef) { if (!j) return; ef = ["effects", fontNode(1.27)]; n.push(ef); }
  if (j) replaceKid(ef, deep(j)); else dropKid(ef, "justify");
}
/** SCH_FIELD::Rotate about its parent's position: the position turns, the angle toggles and the justification follows. */
function rotateField(pr: SNode, C: Pt, ccw: boolean) {
  const a = kid(pr, "at"); if (!a) return;
  const vertical = num(a[3], 0) === 90 || num(a[3], 0) === 270, ef = kid(pr, "effects"), j = ef && kid(ef, "justify");
  const i = j ? j.findIndex((t, k) => k > 0 && (t === "left" || t === "right")) : -1;
  if (j && i > 0 && (vertical ? ccw : !ccw)) j[i] = j[i] === "left" ? "right" : "left";
  const q = mapPoint(ccw ? "ccw" : "cw", C, [num(a[1]), num(a[2])]);
  a[1] = q[0]; a[2] = q[1]; if (a.length >= 4) a[3] = vertical ? 0 : 90; else a.push(vertical ? 0 : 90);
}
/**
 * swapFieldPositionsWithMatching: fields of the same name exchange their position relative to the label, their
 * justification and their angle; a field only one label has is turned by the spin difference instead (counter-clockwise
 * on A, clockwise on B).
 */
function swapLabelFields(A: SNode, B: SNode, rotations: number) {
  const pa = atOf(A), pb = atOf(B), fa = kids(A, "property"), fb = kids(B, "property"), handled = new Set<string>();
  for (const f of fa) {
    const name = str(f[1]), g = fb.find((q) => str(q[1]) === name);
    if (g) {
      const af = kid(f, "at"), ag = kid(g, "at");
      if (af && ag) {
        const ra = [num(af[1]) - pa[0], num(af[2]) - pa[1], num(af[3], 0)], rb = [num(ag[1]) - pb[0], num(ag[2]) - pb[1], num(ag[3], 0)];
        replaceKid(f, ["at", r4(pa[0] + rb[0]), r4(pa[1] + rb[1]), rb[2]]); replaceKid(g, ["at", r4(pb[0] + ra[0]), r4(pb[1] + ra[1]), ra[2]]);
      }
      const ja = justifyOf(f), jb = justifyOf(g); setJustify(f, jb); setJustify(g, ja);
    } else for (let k = 0; k < rotations; k++) rotateField(f, [pa[0], pa[1]], true);
    handled.add(name);
  }
  for (const g of fb) if (!handled.has(str(g[1]))) for (let k = 0; k < rotations; k++) rotateField(g, [pb[0], pb[1]], false);
}
export function swapNodes(items: KItem[]) {
  const nodes = items.map((it: KItem) => deep(it.node));
  if (items.length < 2) return nodes;
  for (let i = 0; i < items.length - 1; i++) {
    const A = nodes[i], B = nodes[i + 1], ka = items[i].kind, kb = items[i + 1].kind;
    const pa = itemPosition(ka, A), pb = itemPosition(kb, B);
    shiftNode(ka, A, r4(pb[0] - pa[0]), r4(pb[1] - pa[1])); shiftNode(kb, B, r4(pa[0] - pb[0]), r4(pa[1] - pb[1]));
    if (ka !== kb && !(FLAG_KINDS.has(ka) && FLAG_KINDS.has(kb))) continue;
    if (LABEL_KINDS.has(ka)) {
      // labels exchange their spin style and vertical justification, then their fields as best they can
      const ra = atOf(A)[2] || 0, rb = atOf(B)[2] || 0, va = vJustify(A), vb = vJustify(B);
      for (const [k, n, r, v] of [[ka, A, rb, vb], [kb, B, ra, va]] as [string, SNode, number, string][]) {
        if (FLAG_KINDS.has(k)) { const a = kid(n, "at"); if (a) { if (a.length >= 4) a[3] = r; else a.push(r); } }
        else setTextRot(k, n, r);
        const j = justifyOf(n); if (j) { const t = j.filter((x, q) => q === 0 || (x !== "top" && x !== "bottom")); if (v) t.push(v); j.length = 0; j.push(...t); }
      }
      swapLabelFields(A, B, ((Math.round((rb - ra) / 90) % 4) + 4) % 4);
    }
    else if (ka === "text" || ka === "text_box") { const ja = justifyOf(A), jb = justifyOf(B); setJustify(A, jb); setJustify(B, ja); }   // only the two justifications, not the angle
    else if (ka === "symbol" && symbolLibId(A) === symbolLibId(B)) {
      const oa = symOrient(A), ob = symOrient(B);
      for (const [n, o] of [[A, ob], [B, oa]] as [SNode, { rot: number; mirror: string }][]) { setAt(n, undefined, undefined, o.rot); dropKid(n, "mirror"); if (o.mirror) { const ai = n.findIndex((c) => Array.isArray(c) && c[0] === "at"); n.splice(ai + 1, 0, ["mirror", o.mirror]); } }
    }
  }
  return nodes;
}
const FLAG_KINDS = new Set(["netclass_flag", "directive_label"]);
const vJustify = (n: SNode): string => { const j = justifyOf(n); return j ? (j.includes("top") ? "top" : j.includes("bottom") ? "bottom" : "") : ""; };
export function swapChanges(doc: KDoc, items: KItem[]) { if (items.length < 2) return []; const nodes = swapNodes(items); return items.map((it: KItem, i: number) => modChange(doc, it, nodes[i])); }
export function swapSelection(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = unlockedSelection(ctx).filter((it) => DRAG_KINDS.has(it.kind));   // FilterSelectionForLockedItems
  if (items.length < 2) return false;                                              // SCH_EDIT_TOOL::Swap returns silently
  const doc = ctx.doc, held = items.map((it) => (it.kind === "sheet" ? sheetNoConnects(doc, it) : []));
  const nodes = swapNodes(items), changes = items.map((it, i) => modChange(doc, it, nodes[i])), moved = new Set(items.map((it) => it.id));
  // the no-connects on a swapped sheet's pins follow them; then only TestDanglingEnds: no junctions added, no wires merged
  items.forEach((it, i) => { if (held[i].length) changes.push(...noConnectChanges(doc, held[i], nodes[i], moved)); });
  ctx.commit(changes, "Swap"); return true;
}
/**
 * Align Items to Grid (SCH_MOVE_TOOL::AlignToGrid + AlignSchematicItemsToGrid, sch_item_alignment.cpp).  Every item
 * first collects what getConnectedDragItems would attach to it (the wire ends on its connection points, the labels
 * on those wires, no-connects, the stub wire to a fixed pin or junction) and those move by the same delta, as in a
 * drag with the line mode free.  A line aligns each end on its own; a text by its position; a sheet by its two
 * corners, its pins after it; anything else by the most common grid delta of its connection points, so an item with
 * no connection point (a rectangle, circle, arc, bezier, polyline, image, text box) does not move.  Then
 * TrimOverLappingWires, AddJunctionsIfNeeded and CleanUp.
 */
export function alignToGridChanges(ctx: SchCtx, items: KItem[]) {
  const doc = ctx.doc, t = editTxn(doc, ctx.IU || 1e4), touched: Pt[] = [], keep = new Set<string>();
  const snap = (p: Pt) => ctx.snap([p[0], p[1]]).map(r4), sel = new Set(items.map((it) => it.id));
  const cur = (it: KItem) => doc.items.get(it.id)!, off = (p: Pt, q: Pt): Pt => [r4(q[0] - p[0]), r4(q[1] - p[1])], nz = (d: Pt) => !!(d[0] || d[1]);
  // SELECTED_BY_DRAG: a line or label one item took along is not handed to a later one
  const flagged = new Set<string>();
  type Grab = { ends: Map<string, { item: KItem; idx: Set<number> }>; riders: Map<string, KItem>; stubs: Anchor[] };
  const collect = (it: KItem, pts: Pt[]): Grab => {
    const g: Grab = { ends: new Map(), riders: new Map(), stubs: [] };
    for (const p of pts) {
      const a = makeAnchor(doc, it, p, sel);
      for (const e of a.ends) {
        if (e.orig.length !== 2) continue;
        const have = g.ends.get(e.item.id);
        if (have) { have.idx.add(e.index); continue; }
        if (flagged.has(e.item.id)) continue;
        flagged.add(e.item.id); g.ends.set(e.item.id, { item: e.item, idx: new Set([e.index]) });
        // the labels on a wire that follows go with it (outside the move tool there is no pass that keeps them on the line)
        for (const l of doc.items.values()) if (LABEL_KINDS.has(l.kind) && !sel.has(l.id) && !flagged.has(l.id) && segDist(atOf(l.node), e.orig[0], e.orig[1]) <= 1e-3) { flagged.add(l.id); g.riders.set(l.id, l); }
      }
      for (const f of a.followers) if (!flagged.has(f.item.id)) { flagged.add(f.item.id); g.riders.set(f.item.id, f.item); }
      if (a.stub) g.stubs.push(a);
    }
    return g;
  };
  const any = (g: Grab) => g.ends.size > 0 || g.riders.size > 0 || g.stubs.length > 0;
  const apply = (g: Grab, d: Pt) => {
    for (const { item, idx } of g.ends.values()) {
      const c = cur(item), n = deep(c.node), q = ptsOf(n).map((v) => v.slice());
      for (const i of idx) q[i] = [r4(q[i][0] + d[0]), r4(q[i][1] + d[1])];
      touched.push(...ptsOf(c.node), ...q); setPts(n, q); t.modify(c, n);
    }
    for (const it of g.riders.values()) { const c = cur(it), n = deep(c.node), a = atOf(n); shiftNode(c.kind, n, d[0], d[1]); touched.push([a[0], a[1]], [r4(a[0] + d[0]), r4(a[1] + d[1])]); t.modify(c, n); }
    for (const a of g.stubs) {
      const to: Pt = [r4(a.p[0] + d[0]), r4(a.p[1] + d[1])];
      if (a.stub!.split) { const m = cur(a.stub!.split), mp = ptsOf(m.node); if (mp.length === 2 && !same(mp[0], a.p) && !same(mp[1], a.p)) { const n = deep(m.node); setPts(n, [mp[0], a.p]); t.modify(m, n); const tail = lineNode(m.kind, a.p, mp[1]), st = kid(m.node, "stroke"); if (st) replaceKid(tail, deep(st)); t.add(tail); } }
      t.add(lineNode(a.stub!.kind, a.p, to)); touched.push(a.p, to);
    }
  };
  // the selected sheets' pin positions and the selected lines ending on them, before anything moves
  const sheetPinPos = new Set<string>(), key = (p: Pt) => r4(p[0]) + "," + r4(p[1]), pinWires = new Map<string, { item: KItem; index: number }>(), lineEnds0 = new Map<string, Pt[]>();
  for (const it of doc.items.values()) if (LINE_KINDS.has(it.kind) && ptsOf(it.node).length === 2) lineEnds0.set(it.id, ptsOf(it.node).map((v) => v.slice()));
  for (const it of items) if (it.kind === "sheet") for (const pin of kids(it.node, "pin")) sheetPinPos.add(key(atOf(pin)));
  for (const it of items) if (LINE_KINDS.has(it.kind) && ptsOf(it.node).length === 2) ptsOf(it.node).forEach((p, i) => { if (sheetPinPos.has(key(p)) && !pinWires.has(key(p))) pinWires.set(key(p), { item: it, index: i }); });
  try {
    for (const it0 of items) {
      if (!DRAG_KINDS.has(it0.kind) || !doc.items.get(it0.id)) continue;
      keep.add(it0.id);
      if (LINE_KINDS.has(it0.kind) && ptsOf(it0.node).length === 2) {
        for (let ii = 0; ii < 2; ii++) {
          const c = cur(it0), p = ptsOf(c.node)[ii].slice(), g = isNetLine(c.kind) ? collect(c, [p]) : null, q = snap(p), d = off(p, q);
          if (!nz(d)) continue;
          if (g) apply(g, d);
          const c2 = cur(it0), n = deep(c2.node), pp = ptsOf(n).map((v) => v.slice()); pp[ii] = q; setPts(n, pp); t.modify(c2, n); touched.push(p, q);
        }
      } else if (it0.kind === "text") {
        const c = cur(it0), a = atOf(c.node), d = off([a[0], a[1]], snap([a[0], a[1]]));
        if (nz(d)) { const n = deep(c.node); shiftNode(c.kind, n, d[0], d[1]); t.modify(c, n); }
      } else if (it0.kind === "sheet") {
        const c = cur(it0), n = deep(c.node), [x, y] = atOf(n), s = kid(n, "size")!, tl = snap([x, y]), br = snap([x + num(s[1]), y + num(s[2])]);
        const pins0 = kids(c.node, "pin").map((pin) => atOf(pin).slice(0, 2)), grabs = pins0.map((p) => collect(c, [p]));
        const tlD = off([x, y], tl);
        if (nz(tlD) || nz(off([x + num(s[1]), y + num(s[2])], br))) {
          setAt(n, tl[0], tl[1]); s[1] = r4(br[0] - tl[0]); s[2] = r4(br[1] - tl[1]);
          for (const pr of kids(n, "property")) shiftAt(pr, tlD[0], tlD[1]);
          for (const pin of kids(n, "pin")) shiftAt(pin, tlD[0], tlD[1]);
        }
        const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
        kids(n, "pin").forEach((pin, i) => {
          const orig = pins0[i], [px, py] = atOf(pin), g = grabs[i]; let target: Pt;
          const pw = pinWires.get(key(orig));
          if (pw) target = ptsOf(cur(pw.item).node)[pw.index].slice();   // a selected wire on the pin: the pin follows its aligned end
          else {
            // a wire whose other end is not on a selected sheet's pin keeps the pin at its Y: the wire stretches without skewing
            let canDrag = true;
            for (const { item, idx } of g.ends.values()) { const o = lineEnds0.get(item.id); if (!o) continue; const other = idx.has(0) ? o[1] : o[0]; if (!sheetPinPos.has(key(other))) { canDrag = false; break; } }
            target = !canDrag && any(g) ? [px, orig[1]] : snap([px, py]);
          }
          // SCH_SHEET_PIN::ConstrainOnEdge( pos, true ): the nearest side, clamped to it
          const sides: [string, number, Pt][] = [["left", Math.abs(target[0] - tl[0]), [tl[0], clamp(target[1], tl[1], br[1])]], ["right", Math.abs(target[0] - br[0]), [br[0], clamp(target[1], tl[1], br[1])]],
            ["top", Math.abs(target[1] - tl[1]), [clamp(target[0], tl[0], br[0]), tl[1]]], ["bottom", Math.abs(target[1] - br[1]), [clamp(target[0], tl[0], br[0]), br[1]]]];
          const rot0 = atOf(pin)[2] || 0, mine = rot0 === 180 ? "left" : rot0 === 0 ? "right" : rot0 === 90 ? "top" : "bottom";
          let best = sides.find((sd) => sd[0] === mine)!; for (const sd of sides) if (sd[1] < best[1] - 1e-6) best = sd;
          setAt(pin, r4(best[2][0]), r4(best[2][1]), best[0] === "left" ? 180 : best[0] === "right" ? 0 : best[0] === "top" ? 90 : 270);
          const total = off(orig, target);
          touched.push(orig, [r4(best[2][0]), r4(best[2][1])]);
          if (nz(total)) apply(g, total);
        });
        if (JSON.stringify(n) !== JSON.stringify(c.node)) t.modify(cur(it0), n);
      } else {
        const c = cur(it0), conns = connPoints(doc, c); if (!conns.length) continue;
        const g = collect(c, conns), shifts = new Map<string, number>(); let most: Pt = [0, 0], max = 0;
        for (const p of conns) { const d = off(p, snap(p)), k = key(d), cnt = (shifts.get(k) || 0) + 1; shifts.set(k, cnt); if (cnt > max) { most = d; max = cnt; } }
        if (!nz(most)) continue;
        const n = deep(c.node); shiftNode(c.kind, n, most[0], most[1]); t.modify(c, n);
        for (const p of conns) touched.push(p, [r4(p[0] + most[0]), r4(p[1] + most[1])]);
        apply(g, most);
      }
    }
  } finally { t.restore(); }
  const out = t.changes(); if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  return foldChanges(out, extra);
}
export function alignToGrid(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = unlockedSelection(ctx); if (!items.length) return false;   // FilterSelectionForLockedItems
  const changes = alignToGridChanges(ctx, items); if (!changes.length) return true;
  ctx.commit(changes, "Align Items to Grid"); return true;
}
/** SCH_ALIGN_TOOL's commit names. */
export const ALIGN_LABEL: Record<string, string> = { top: "Align to Top", bottom: "Align to Bottom", left: "Align to Left", right: "Align to Right", centerX: "Align to Middle", centerY: "Align to Center" };
/** EE_GRID_HELPER::GetItemGrid is GRID_CONNECTABLE for these: SCH_ALIGN_TOOL::adjustDeltaForGrid snaps only their position. */
const GRID_CONNECTABLE = new Set(["symbol", "sheet", "no_connect", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "rule_area"]);
// Edge alignment (sch_align_tool.cpp).  GetSelections sorts the items by the command's own order (top ascending,
// bottom descending, left ascending, right descending, centres ascending) and keeps the locked ones apart as anchors;
// selectTarget takes the edge of the item whose box holds the cursor, else of the first in that order (of the locked
// ones when there are any).  moveItem then moves each item by the difference, adjustDeltaForGrid snapping the
// resulting position of the connectable ones only.
export function alignEdgeChanges(ctx: SchCtx, items: KItem[], which: string) {
  const doc = ctx.doc, boxed = items.map((it) => ({ it, b: (it.bbox || rectOf(it)) as Box | null })).filter((x) => x.b) as { it: KItem; b: Box }[]; if (boxed.length < 2) return [];
  const edge = (b: Box) => which === "top" ? b[1] : which === "bottom" ? b[3] : which === "left" ? b[0] : which === "right" ? b[2] : which === "centerX" ? (b[0] + b[2]) / 2 : (b[1] + b[3]) / 2;
  const desc = which === "bottom" || which === "right", order = (x: { b: Box }, y: { b: Box }) => (desc ? edge(y.b) - edge(x.b) : edge(x.b) - edge(y.b));
  const locked = boxed.filter((x) => isLockedNode(x.it.node)).sort(order), free = boxed.filter((x) => !isLockedNode(x.it.node)).sort(order);
  if (!free.length) return [];
  const c = cursorOf(ctx), pool = locked.length ? locked : free, hit = c && pool.find((x) => c[0] >= x.b[0] && c[0] <= x.b[2] && c[1] >= x.b[1] && c[1] <= x.b[3]);
  const target = edge((hit || pool[0]).b), horiz = which === "left" || which === "right" || which === "centerX";
  const out: KChange[] = [], touched: Pt[] = [], keep = new Set<string>();
  for (const { it, b } of free) {
    if (!DRAG_KINDS.has(it.kind)) continue;
    let d = r4(target - edge(b)); if (!d) continue;
    if (GRID_CONNECTABLE.has(it.kind)) {
      const a = anchorOf(it.kind, it.node), want: Pt = [a[0] + (horiz ? d : 0), a[1] + (horiz ? 0 : d)], q = ctx.snap(want);
      d = r4(horiz ? q[0] - a[0] : q[1] - a[1]);
      const dOther = r4(horiz ? q[1] - a[1] : q[0] - a[0]);
      if (!d && !dOther) continue;
      const n = deep(it.node); shiftNode(it.kind, n, horiz ? d : dOther, horiz ? dOther : d);
      for (const p of connPoints(doc, it)) touched.push(p);
      for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
      out.push(modChange(doc, it, n)); keep.add(it.id);
      continue;
    }
    const n = deep(it.node); shiftNode(it.kind, n, horiz ? d : 0, horiz ? 0 : d);
    for (const p of connPoints(doc, it)) touched.push(p);
    for (const p of connPoints(doc, { kind: it.kind, node: n, id: it.id })) touched.push(p);
    out.push(modChange(doc, it, n)); keep.add(it.id);
  }
  if (!out.length) return out;
  const extra = cleanupAt(doc, out, touched, keep, ctx.IU || 1e4);
  return foldChanges(out, extra);
}
export function alignEdges(ctx: SchCtx, which: string) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (items.length < 2) return false;   // the align commands do nothing for fewer than two items
  const changes = alignEdgeChanges(ctx, items, which); if (!changes.length) return true;
  ctx.commit(changes, ALIGN_LABEL[which] || "Align"); return true;
}
// Break the wire under the cursor (or the selected one) into two at the grid point.
export function breakWireChanges(doc: KDoc, item: KItem, p: Pt) {
  if (!isNetLine(item.kind)) return [];
  const pts = ptsOf(item.node); if (pts.length !== 2) return [];
  const q = closestOnSeg(p, pts[0], pts[1]); if (same(q, pts[0]) || same(q, pts[1])) return [];
  const a = deep(item.node); setPts(a, [pts[0], q]);
  const b = addNode(doc, lineNode(item.kind, q, pts[1])); doc.items.delete(b.item.id);
  return [modChange(doc, item, a), b.change];
}
export function closestOnSeg(p: Pt, a: Pt, b: Pt): Pt { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t)); return [r4(a[0] + t * dx), r4(a[1] + t * dy)]; }
/**
 * SCH_MOVE_TOOL in BREAK / SLICE mode (KiCad 10).  preprocessBreakOrSliceSelection breaks the selected line at
 * the cursor (several selected lines each at their midpoint) inside the move's local commit, and the move loop
 * carries the cut: for BREAK the new corner (both halves' shared end) follows the cursor, for SLICE the first
 * half's end alone, opening the gap.  Nothing reaches the document (or a peer) until the operation ends.
 * SLICE: a click finishes.  BREAK: each click breaks the dragged tail again at the corner and keeps going; a
 * double click finishes, and so does Esc once at least one click has broken (the corner in flight stays where the
 * cursor left it).  Esc before that, Ctrl+Z or a peer's edit of the sheet put everything back, with no redo entry
 * (localCommit.Revert()).  The commit is one "Break Wire" / "Slice Wire" step with the junctions the new corners
 * need.  Outside a session with a pointer (tests, headless) the break is committed where it was made.
 */
export function breakWire(ctx: SchCtx, mode: string) {
  if (!editable(ctx)) return false;
  mode = mode === "slice" ? "slice" : "break";
  const c = cursorOf(ctx); let lines = selectedItems(ctx).filter((x) => isNetLine(x.kind) && ptsOf(x.node).length === 2);
  if (!lines.length) { const hit = hitNonSymbol(ctx.doc, c[0], c[1], Math.max(0.3, 5 * mmPerPx(ctx))); if (hit && isNetLine(hit.kind)) lines = [hit]; }
  if (!lines.length) return false;
  const doc = ctx.doc, label = mode === "slice" ? "Slice Wire" : "Break Wire";
  const atFor = (it: KItem) => { const q = ptsOf(it.node); return lines.length === 1 ? snapCursor(ctx) : [r4((q[0][0] + q[1][0]) / 2), r4((q[0][1] + q[1][1]) / 2)]; };
  if (!canFollow(ctx)) {
    const changes: KChange[] = [], cuts: { head: string; tail: string }[] = [];
    for (const it of lines) { const ch = breakWireChanges(doc, it, atFor(it)); if (!ch.length) continue; changes.push(...ch); cuts.push({ head: it.id, tail: ch[1].id }); }
    if (!changes.length) return false;
    ctx.commit(changes, label);
    setSelectionIds(ctx, mode === "break" ? cuts.flatMap((x) => [x.head, x.tail]) : cuts.map((x) => x.head));
    return true;
  }
  if (S.drag) endDrag(ctx, false);
  const brk: BreakJob = { mode, label, orig: new Map(), local: new Set(), clicks: 0 }, cuts: BreakCut[] = [];
  for (const it of lines) { const cut = splitLocal(doc, brk, it, atFor(it)); if (cut) cuts.push(cut); }
  if (!cuts.length) return false;
  const p0 = cuts[0].p;
  S.drag = { items: [], item: cuts[0].head, kind: "wire", orig: null, anchor0: p0, grab: [0, 0], last: [0, 0], applied: [0, 0], moved: true, byPointer: false,
    riders: [], anchors: breakAnchors(cuts, mode), preview: [], mode, brk, restoreMode: S.dragMode };
  S.dragMode = "drag"; announceModes(ctx);
  setSelectionIds(ctx, mode === "break" ? cuts.flatMap((x) => [x.head.id, x.tail.id]) : cuts.map((x) => x.head.id));
  return true;
}
// SCH_LINE::BreakAt on this client only: the line keeps its start and ends at q, a copy (same stroke) runs on from q.
export function splitLocal(doc: KDoc, brk: BreakJob, item: KItem, at: Pt, force?: boolean): BreakCut | null {
  const pts = ptsOf(item.node); if (pts.length !== 2) return null;
  const q = force ? [r4(at[0]), r4(at[1])] : closestOnSeg(at, pts[0], pts[1]);
  if (!force && (same(q, pts[0]) || same(q, pts[1]))) return null;
  if (!brk.orig.has(item.id) && !brk.local.has(item.id)) brk.orig.set(item.id, deep(item.node));
  const tailNode = deep(item.node); dropKid(tailNode, "uuid"); setPts(tailNode, [q, pts[1]]);
  setPts(item.node, [pts[0], q]); K.replaceChange(doc, item);
  const tail = addNode(doc, tailNode).item; brk.local.add(tail.id);
  return { head: item, tail, p: q };
}
export function breakAnchors(cuts: BreakCut[], mode: string): Anchor[] {
  return cuts.map((cut) => {
    const ends = [{ item: cut.head, index: 1, orig: ptsOf(cut.head.node).map((v) => v.slice()) }];
    if (mode === "break") ends.push({ item: cut.tail, index: 0, orig: ptsOf(cut.tail.node).map((v) => v.slice()) });
    return { p: cut.p, ends, stub: null, followers: [] };
  });
}
// A click in BREAK mode: the corner stays where it is and the dragged tail breaks again there, so the next
// corner follows the cursor (preprocessBreakOrSliceSelection on the IS_NEW tail only).
export function breakAgain(ctx: SchCtx) {
  const d = S.drag; if (!d || !d.brk || d.brk.mode !== "break") return false;
  const doc = ctx.doc, cuts: BreakCut[] = [];
  for (const a of d.anchors) {
    const tailEnd = a.ends.find((e) => e.index === 0); if (!tailEnd) continue;
    const tail = tailEnd.item, pts = ptsOf(tail.node);
    const cut = splitLocal(doc, d.brk, tail, pts[0], true); if (cut) cuts.push(cut);
  }
  if (!cuts.length) return false;
  d.brk.clicks++;
  d.anchors = breakAnchors(cuts, "break"); d.anchor0 = cuts[0].p; d.last = [0, 0]; d.applied = [0, 0];
  setSelectionIds(ctx, cuts.flatMap((x) => [x.head.id, x.tail.id]));
  ctx.requestRender();
  return true;
}
// Lines broken locally go back to what they were, the local pieces go.
export function restoreBreak(doc: KDoc, brk: BreakJob) {
  for (const id of brk.local) doc.items.delete(id);
  for (const [id, orig] of brk.orig) { const it = doc.items.get(id); if (it) { restoreNode(it.node, orig!); K.replaceChange(doc, it); } }
}
export function endBreak(ctx: SchCtx, d: SchDrag, commit: boolean) {
  const doc = ctx.doc, brk = d.brk!;
  if (!commit && d.cancel !== "undo" && brk.mode === "break" && brk.clicks > 0) commit = true;   // Esc after a break keeps the breaks
  if (commit) applyDrag(doc, d, d.last[0], d.last[1]);
  const finals = new Map<string, { kind: string; node: SNode }>();
  for (const id of [...brk.orig.keys(), ...brk.local]) { const it = doc.items.get(id); if (it) finals.set(id, { kind: it.kind, node: deep(it.node) }); }
  restoreBreak(doc, brk);
  if (!commit) { setSelectionIds(ctx, []); return; }
  const zero = (n: SNode) => { const q = ptsOf(n); return q.length === 2 && same(q[0], q[1]); };
  const changes: KChange[] = [], added: string[] = [], touched: Pt[] = [];
  for (const [id] of brk.orig) {
    const it = doc.items.get(id), f = finals.get(id); if (!it || !f) continue;
    if (zero(f.node)) { changes.push(removeChange(it)); continue; }
    changes.push(modChange(doc, it, f.node)); touched.push(...ptsOf(f.node));
  }
  for (const id of brk.local) {
    const f = finals.get(id); if (!f || zero(f.node)) continue;
    const r = addNode(doc, f.node); changes.push(r.change); added.push(r.item.id); touched.push(...ptsOf(f.node));
  }
  // the junctions the moved corners need (finalizeMoveOperation's AddJunctionsIfNeeded), on a dry run
  const saved = new Map<string, KItem | null>(); for (const c of changes) if (!saved.has(c.id)) saved.set(c.id, doc.items.get(c.id) || null);
  const extra: KChange[] = [];
  try {
    for (const c of changes) K.applyChange(doc, c, ctx.IU || 1e4);
    const seen = new Set<string>();
    for (const p of touched) {
      const k = r4(p[0]) + "," + r4(p[1]); if (seen.has(k)) continue; seen.add(k);
      if (!junctionAt(doc, p[0], p[1]) && (needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus"))) {
        breakInto(doc, p, saved, new Set(changes.map((c) => c.id)), extra, ctx.IU || 1e4);   // AddJunction's BreakSegments
        extra.push(addNode(doc, junctionNode(p)).change);
      }
    }
  } finally { for (const [id, obj] of saved) { if (obj) doc.items.set(id, obj); else doc.items.delete(id); } for (const c of extra) if (c.kind === "ADDED") doc.items.delete(c.id); }
  for (const id of added) doc.items.delete(id);
  const keepSel = d.anchors.flatMap((a) => a.ends.map((e) => e.item.id));
  ctx.commit(changes.concat(extra), brk.label);
  setSelectionIds(ctx, keepSel.filter((id: string) => doc.items.has(id)));
}
export const fragOf = (change: KChange) => { const t = K.parseAll(change.sexpr!); return t.find((n) => Array.isArray(n) && n[0] !== "lib_symbols") || t[0]; };
