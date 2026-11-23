// pcb-tools/transforms.ts — generic item transforms (move / rotate / flip / mirror), align and distribute.
import type { BoardDoc, Box, PcbChange, Pt } from "./types";

/** A point map (x, y) → [x, y]. */
export type PointFn = (x: number, y: number) => number[];
import { replacedChange } from "./changes";
import { flipEllipseNode, mirrorEllipseAxis, rotateEllipseNode } from "./ellipse";
import { flipFootprintNode, flipLayerKid, mirrorShapeX, rotateFootprintNode, toggleMirror } from "./footprint";
import { K, S } from "./state";
import { clone, corners, flipLayerName, isList, norm360, pt, r6, rotator, vadd, xy } from "./util";

// ================================================================ parity pass: the non-tool commands of pcbnew
// Everything below is DOM-free geometry and node editing (the dialogs at the end are swappable) so the node
// tests can drive it; app.js reaches it through pcb.actions and the exported query functions.
export const PCB_KINDS = new Set(["footprint", "segment", "arc", "via", "zone", "gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_text", "gr_text_box", "gr_curve", "gr_ellipse", "gr_ellipse_arc", "gr_bbox", "dimension", "target", "image", "group", "table", "generated", "drill_map", "drill_chart", "stackup_table", "constraint"]);
export const EPS = 1e-3;   // touching copper, in mm (KiCad's connectivity uses exact contact on integer nanometres)
export const DRC_EPS = 0.0005;   // ADVANCED_CFG::m_DRCEpsilon: half a micron short of a rule is not a violation
export const isFootprintNode = (n: SNode) => n[0] === "footprint";

// ---------------------------------------------------------------- generic item transforms (move / rotate / flip / mirror)
/**
 * Boards before FIRST_FP_AFFINE_TRANSFORM (20260616) keep a footprint's zone outlines and points in the board frame
 * (pcb_io_kicad_sexpr.cpp writes them through the footprint's transform only from that version on).  The footprint
 * operations below treat them as local, so for such a board they are taken into the footprint's frame first and
 * put back through its new placement afterwards.
 */
let fpFrameDepth = 0;
export function legacyFootprintFrame<T>(node: SNode, doc: { version?: number } | null | undefined, op: () => T): T {
  const v = Number(doc && doc.version) || 0;
  if (fpFrameDepth > 0 || node[0] !== "footprint" || !(v > 0 && v < 20260616)) return op();
  const each = (fn: PointFn) => {
    for (const z of K.kids(node, "zone")) for (const poly of [z, ...K.kids(z, "polygon"), ...K.kids(z, "filled_polygon")]) {
      const p = K.kid(poly, "pts"); if (p) for (const q of p.slice(1)) if (isList(q) && q[0] === "xy") { const [x, y] = fn(K.num(q[1]), K.num(q[2])); q[1] = r6(x); q[2] = r6(y); }
    }
    for (const pt of K.kids(node, "point")) { const a = K.kid(pt, "at"); if (a) { const [x, y] = fn(K.num(a[1]), K.num(a[2])); a[1] = r6(x); a[2] = r6(y); } }
  };
  const [x0, y0, a0] = K.atOf(node); const toLocal = rotator(-a0);
  each((x, y) => toLocal(x - x0, y - y0));
  fpFrameDepth++;
  try { return op(); }
  finally {
    fpFrameDepth--;
    const [x1, y1, a1] = K.atOf(node); const toBoard = rotator(a1);
    each((x, y) => { const [bx, by] = toBoard(x, y); return [x1 + bx, y1 + by]; });
  }
}
/** Every absolute (x, y) of a board-level item through fn; angles are untouched.  Footprints move as a whole. */
export function mapNodePoints(node: SNode, fn: PointFn) {
  const k = node[0];
  const mapKey = (n: SNode, key: string) => { const c = K.kid(n, key); if (!c || c.length < 3) return; const [x, y] = fn(K.num(c[1]), K.num(c[2])); c[1] = r6(x); c[2] = r6(y); };
  const mapPts = (n: SNode) => { const p = K.kid(n, "pts"); if (p) for (const xy of p.slice(1)) if (isList(xy) && xy[0] === "xy") { const [x, y] = fn(K.num(xy[1]), K.num(xy[2])); xy[1] = r6(x); xy[2] = r6(y); } };
  if (k === "footprint") return legacyFootprintFrame(node, S.doc, () => { const [x, y] = K.atOf(node); const [nx, ny] = fn(x, y); K.setAt(node, r6(nx), r6(ny)); return node; });
  if (k === "drill_map") { const o = K.kid(node, "offset"); if (o) { const [x, y] = fn(K.num(o[1]), K.num(o[2])); o[1] = r6(x); o[2] = r6(y); } return node; }   // PCB_DRILL_MAP::Move: its offset
  if (k === "table" || k === "drill_chart" || k === "stackup_table") {   // a table sits where its first cell does: every cell shifts with it
    const cells = K.kid(node, "cells"); const first = cells && K.kids(cells, "table_cell")[0]; const s = first && K.kid(first, "start"); if (!s) return node;
    const [ax, ay] = [K.num(s[1]), K.num(s[2])]; const [nx, ny] = fn(ax, ay); K.shiftTable(node, nx - ax, ny - ay); return node;
  }
  for (const key of ["start", "end", "mid", "center", "at"]) mapKey(node, key);
  mapPts(node);
  if (k === "zone") for (const poly of K.kids(node, "polygon").concat(K.kids(node, "filled_polygon"))) mapPts(poly);
  if (k === "generated") {   // PCB_GENERATOR::Move / Rotate: its stored points (origin, end, base lines) go with it
    for (const key of ["origin", "end"]) { const c = K.kid(node, key); const xy = c && K.kid(c, "xy"); if (xy) { const [x, y] = fn(K.num(xy[1]), K.num(xy[2])); xy[1] = r6(x); xy[2] = r6(y); } }
    for (const key of ["base_line", "base_line_coupled", "hops"]) { const c = K.kid(node, key); if (c) mapPts(c); }   // a microvia stack's hops too
    // PCB_GENERATOR_POLY (a via stitch): its outline goes with it
    const ol = K.kid(node, "outline"); if (ol) mapPts(ol);
  }
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) mapKey(gt, "at"); }
  return node;
}
export const translateNode = (node: SNode, dx: number, dy: number) => mapNodePoints(node, (x: number, y: number) => [x + dx, y + dy]);
export function angleKid(node: SNode) { const at = K.kid(node, "at"); return at ? K.num(at[3]) : 0; }
export function setAngleKid(node: SNode, a: number) { const at = K.kid(node, "at"); if (!at) return; a = r6(norm360(a)); if (at.length >= 4) at[3] = a; else if (a !== 0) at.push(a); }
/** Turn an item by deg (KiCad's positive = counter-clockwise on screen) about (cx, cy). */
export function rotateNode(node: SNode, cx: number, cy: number, deg: number) {
  const k = node[0]; const R = rotator(deg); const about = (x: number, y: number) => { const [dx, dy] = R(x - cx, y - cy); return [cx + dx, cy + dy]; };
  if (k === "footprint") return legacyFootprintFrame(node, S.doc, () => { rotateFootprintNode(node, deg); return mapNodePoints(node, about); });
  if (k === "gr_rect" && norm360(deg) % 90 !== 0) {   // PCB_SHAPE::Rotate: a rectangle off the axes becomes a polygon
    const a = pt(node, "start"), b = pt(node, "end"); const [x0, y0, x1, y1] = corners(a!, b!);
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => about(x, y));
    node[0] = "gr_poly"; for (const key of ["start", "end"]) { const i = node.indexOf(K.kid(node, key)!); if (i > 0) node.splice(i, 1); }
    node.splice(1, 0, ["pts", ...pts.map(xy)]); return node;
  }
  if (k === "gr_ellipse" || k === "gr_ellipse_arc" || k === "fp_ellipse" || k === "fp_ellipse_arc") return rotateEllipseNode(node, cx, cy, deg);   // EDA_SHAPE::rotate: Rotation -= angle
  if ((k === "gr_text_box" || k === "table_cell") && K.kid(node, "start") && K.kid(node, "end")) return rotateTextBoxNode(node, cx, cy, deg);
  if (k === "drill_map") return node;   // PCB_DRILL_MAP::Rotate: the marks sit at their holes, nothing turns
  if (k === "table" || k === "drill_chart" || k === "stackup_table") {   // PCB_TABLE::Rotate: every cell turns (PCB_TEXTBOX::Rotate), then Normalize lays them out about cell 0
    const cells = K.kid(node, "cells"); if (!cells) return node;
    for (const c of K.kids(cells, "table_cell")) if (K.kid(c, "start") && K.kid(c, "end")) rotateTextBoxNode(c, cx, cy, deg);
    (K as unknown as { tableModel: { normalizeTable(n: SNode, pcb: boolean): void } }).tableModel.normalizeTable(node, true);
    return node;
  }
  mapNodePoints(node, about);
  if (k === "gr_rect" || k === "gr_text_box") {   // corners stay a corner pair: re-normalise start / end
    const a = pt(node, "start"), b = pt(node, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); K.kid(node, "start")!.splice(1, 2, r6(x0), r6(y0)); K.kid(node, "end")!.splice(1, 2, r6(x1), r6(y1)); }
    if (k === "gr_text_box") setTextBoxAngle(node, textBoxAngle(node) + deg);
  }
  if (k === "gr_text" || k === "pad" || k === "property") setAngleKid(node, angleKid(node) + deg);   // PAD::Rotate, PCB_FIELD::Rotate (footprint editor)
  if (k === "image") {   // REFERENCE_IMAGE::Rotate: the centre turns about the point, the orientation is its own (rotate) after the layer
    const r = K.kid(node, "rotate"), a = norm360((r ? K.num(r[1]) : 0) + deg);
    if (r) { if (a) r[1] = r6(a); else node.splice(node.indexOf(r), 1); }
    else if (a) { const ly = K.kid(node, "layer"); node.splice(ly ? node.indexOf(ly) + 1 : 2, 0, ["rotate", r6(a)]); }
  }
  if (k === "dimension") {
    const gt = K.kid(node, "gr_text"); if (gt) setAngleKid(gt, angleKid(gt) + deg);
    const o = K.kid(node, "orientation"); if (o && norm360(deg) % 180 === 90) o[1] = K.num(o[1]) ? 0 : 1;
  }
  return node;
}
/** A text box's (angle), 0 when absent. */
export function textBoxAngle(node: SNode) { const an = K.kid(node, "angle"); return an ? K.num(an[1]) : 0; }
/** Write a text box's (angle) normalised to [0, 360): KiCad writes it before the layer, and drops it at 0. */
export function setTextBoxAngle(node: SNode, deg: number) {
  const an = K.kid(node, "angle"); const a1 = r6(norm360(deg)) % 360;
  if (an) { if (a1) an[1] = a1; else node.splice(node.indexOf(an), 1); return; }
  if (!a1) return;
  const ly = K.kid(node, "layer"); const i = ly ? node.indexOf(ly) : node.length; node.splice(i, 0, ["angle", a1]);
}
/**
 * PCB_TEXTBOX::Rotate: "Slide the axis-aligned box, rotation lives in the text angle."  The box's centre turns about
 * (cx, cy); start and end move by that delta rounded to the nanometre (KiROUND), keeping the width and height, and
 * the text angle becomes (angle + deg).Normalize().
 */
export function rotateTextBoxNode(node: SNode, cx: number, cy: number, deg: number) {
  const s = K.kid(node, "start"), e = K.kid(node, "end"); if (!s || !e) return node;
  const sx = K.num(s[1]), sy = K.num(s[2]), ex = K.num(e[1]), ey = K.num(e[2]);
  const ox = (sx + ex) / 2, oy = (sy + ey) / 2; const [rx, ry] = rotator(deg)(ox - cx, oy - cy);
  const dx = Math.round((cx + rx - ox) * 1e6) / 1e6, dy = Math.round((cy + ry - oy) * 1e6) / 1e6;
  s[1] = r6(sx + dx); s[2] = r6(sy + dy); e[1] = r6(ex + dx); e[2] = r6(ey + dy);
  setTextBoxAngle(node, textBoxAngle(node) + deg);
  return node;
}
/** PCB_TEXTBOX::SetTextAngle: a new angle turns the box by the difference about GetPosition() (its start). */
export function setTextBoxAngleSliding(node: SNode, deg: number) {
  const s = K.kid(node, "start"); const delta = norm360(deg) - norm360(textBoxAngle(node)); if (!delta) return node;
  if (!s || !K.kid(node, "end")) { setTextBoxAngle(node, deg); return node; }
  return rotateTextBoxNode(node, K.num(s[1]), K.num(s[2]), delta);
}
/** ZONE::Mirror: the hatch and thieving orientations reflect over the mirror axis (axis angle 0 for a top / bottom mirror, -90 for left / right), Normalized. */
export function reflectZoneOrientations(node: SNode, leftRight: boolean) {
  const f = K.kid(node, "fill"); if (!f) return;
  const axis = leftRight ? -90 : 0; const refl = (c: SNode | null | undefined) => { if (c && c.length > 1) c[1] = r6(norm360(2 * axis - K.num(c[1]))); };
  const h = K.kid(f, "hatch_orientation"); if (h) refl(h);
  const t = K.kid(f, "thieving"); if (t) refl(K.kid(t, "orientation"));
}
/**
 * KiCad's Flip about (cx, cy): other side, layers swapped, texts mirrored.  dir is FLIP_DIRECTION: "lr" (the default
 * here, what SetLayerAndFlip uses) mirrors about the vertical axis x = cx; "tb" (PCBNEW_SETTINGS m_FlipDirection's
 * default) about the horizontal axis y = cy.  FOOTPRINT::Flip flips top / bottom and turns half a turn for left /
 * right, so the two differ by exactly that half turn about the centre, for every item (a text: -angle against
 * 180 - angle).
 */
export function flipNode(node: SNode, cx: number, doc: BoardDoc, cy?: number, dir?: string): SNode {
  if (dir === "tb" && cy !== undefined) {
    if (node[0] === "zone") { mapNodePoints(node, (x: number, y: number) => [x, 2 * cy - y]); flipLayerKid(node); reflectZoneOrientations(node, false); return node; }
    if (/_ellipse(_arc)?$/.test(String(node[0]))) { flipEllipseNode(node, cx, cy, false); flipLayerKid(node); return node; }   // ELLIPSE::Mirror( TOP_BOTTOM )
    flipNode(node, cx, doc); return rotateNode(node, cx, cy, 180);
  }
  const k = node[0]; const mirror = (x: number, y: number) => [2 * cx - x, y];
  if (k === "drill_map") { flipLayerKid(node); return node; }   // PCB_DRILL_MAP::Flip: the side changes, the offset stays
  if (k === "drill_chart" || k === "stackup_table") return flipGeneratedTable(node, cx);
  if (k === "footprint") return legacyFootprintFrame(node, doc || S.doc, () => { flipFootprintNode(node); return mapNodePoints(node, mirror); });
  if (/_ellipse(_arc)?$/.test(String(k))) flipEllipseNode(node, cx, 0, true); else mapNodePoints(node, mirror);   // ELLIPSE::Mirror( LEFT_RIGHT )
  flipLayerKid(node);
  if (k === "zone") reflectZoneOrientations(node, true);
  if (k === "generated" && doc) {   // PCB_VIA_STACK::Flip: the span's layers flip (GetFlippedLayer: inner layers mirror within the copper count)
    const n = (doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]).filter((l) => /\.Cu$/.test(l)).length;
    const cu = (l: string) => { const m = /^In(\d+)\.Cu$/.exec(l); return m ? `In${n - 1 - parseInt(m[1], 10)}.Cu` : flipLayerName(l); };
    for (const key of ["start_layer", "end_layer"]) { const c = K.kid(node, key); if (c) c[1] = cu(K.str(c[1])); }
  }
  if (k === "via") { const ls = K.kid(node, "layers"); if (ls && doc) { const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const names = ls.slice(1).map(K.str).sort((a, b) => copper.indexOf(a) - copper.indexOf(b)); ls.splice(1, ls.length - 1, ...names); } }
  if (k === "gr_text" || k === "gr_text_box" || k === "property") { toggleMirror(node); setAngleKid(node, -angleKid(node)); }
  if (k === "pad") padMirrorX(node);   // PAD::Flip: offset, trapezoid delta and primitives mirror, the relative angle negates
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) { flipLayerKid(gt); toggleMirror(gt); setAngleKid(gt, -angleKid(gt)); } }
  if (k === "table") { const cells = K.kid(node, "cells"); if (cells) for (const c of K.kids(cells, "table_cell")) { flipLayerKid(c); toggleMirror(c); } }
  return node;
}
/**
 * PCB_GENERATED_TABLE::Flip (left / right about x = cx): PCB_TABLE::Flip turns the cells to the other side and mirrors
 * the grid's columns (cells and widths), keeping the box's top and its mirrored left edge; then the columns of the
 * header reverse and the trailer rows swap their texts end for end (flipGeneratedHeader).
 */
function flipGeneratedTable(node: SNode, cx: number): SNode {
  const D = (K as unknown as { drillModel: { flipGeneratedHeader(n: SNode): void } }).drillModel; const TM = (K as unknown as { tableModel: { normalizeTable(n: SNode, pcb: boolean): void; tableInfo(n: SNode): { cols: number; rows: number; cells: SNode[] } } }).tableModel;
  const box = (): number[] => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; const cells = K.kid(node, "cells"); for (const c of cells ? K.kids(cells, "table_cell") : []) for (const key of ["start", "end"]) { const p = pt(c, key); if (p) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } } return [x0, y0, x1, y1]; };
  const before = box(); const T = TM.tableInfo(node); const cn = K.kid(node, "cells");
  if (cn && T.cols > 0) {
    for (const c of T.cells) { flipLayerKid(c); toggleMirror(c); }
    const mirrored: SNode[] = []; for (let r = 0; r < T.rows; r++) for (let c = T.cols - 1; c >= 0; c--) mirrored.push(T.cells[r * T.cols + c]);
    cn.splice(1, T.cells.length, ...mirrored);
    const cw = K.kid(node, "column_widths"); if (cw) cw.splice(1, cw.length - 1, ...cw.slice(1).reverse());
    TM.normalizeTable(node, true);
  }
  flipLayerKid(node);
  if (isFinite(before[0])) { const after = box(); K.shiftTable(node, r6(2 * cx - before[2] - after[0]), r6(before[1] - after[1])); }
  D.flipGeneratedHeader(node);
  return node;
}
/** Mirror in place (no side change): "h" about the vertical axis through cx, "v" about the horizontal one through cy. */
export function mirrorNode(node: SNode, cx: number, cy: number, axis: string) {
  const k = node[0]; if (k === "footprint") return false;   // pcbnew refuses to mirror footprints outside the footprint editor
  if (/_ellipse(_arc)?$/.test(String(k))) return flipEllipseNode(node, cx, cy, axis !== "v");   // PCB_SHAPE::Mirror -> EDA_SHAPE::flip
  mapNodePoints(node, axis === "v" ? (x: number, y: number) => [x, 2 * cy - y] : (x: number, y: number) => [2 * cx - x, y]);
  const text = (n: SNode) => { toggleMirror(n); setAngleKid(n, axis === "v" ? 180 - angleKid(n) : -angleKid(n)); };
  if (k === "gr_text" || k === "gr_text_box" || k === "property") text(node);
  if (k === "pad") { if (axis === "v") { padMirrorY(node); } else padMirrorX(node); }   // EDIT_TOOL::mirrorPad (footprint editor)
  if (k === "zone") reflectZoneOrientations(node, axis !== "v");
  if (k === "dimension") { const gt = K.kid(node, "gr_text"); if (gt) text(gt); }
  if (k === "gr_rect" || k === "gr_text_box") { const a = pt(node, "start"), b = pt(node, "end"); if (a && b) { const [x0, y0, x1, y1] = corners(a, b); K.kid(node, "start")!.splice(1, 2, r6(x0), r6(y0)); K.kid(node, "end")!.splice(1, 2, r6(x1), r6(y1)); } }
  return node;
}
/** EDIT_TOOL::MirrorableItems as the kinds here: what Mirror( const SEG& ) exists for. */
const MIRRORABLE = new Set(["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_ellipse", "gr_ellipse_arc", "fp_ellipse", "fp_ellipse_arc", "gr_text", "gr_text_box", "property", "zone", "pad", "segment", "arc", "via", "group", "generated", "table", "image",
  "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text", "fp_text_box"]);
/**
 * BOARD_ITEM::Mirror( const SEG& aAxis ): the item reflected in place about the line through A and B (no side
 * change).  Points go through SEG::ReflectPoint; an angle a becomes EDA_ANGLE::Reflect( axisAngle ) = 2 * axisAngle - a
 * with axisAngle = -angle( B - A ).  PCB_TEXT keeps the text readable (an angle past 90 up to 270 turns back half a
 * turn and the horizontal justification swaps); a PCB_TEXTBOX slides by its centre's reflection; a rectangle about
 * an oblique axis becomes a polygon; a zone's hatch and thieving orientations reflect; a pad's own geometry mirrors
 * top / bottom in its frame.  Returns false for what has no arbitrary-axis mirror (the caller counts the skips).
 */
export function mirrorNodeAxis(node: SNode, A: Pt, B: Pt, flippedImage?: string | null): SNode | false {
  const k = String(node[0]).replace(/^fp_/, "gr_"); if (!MIRRORABLE.has(node[0] as string) || (k === "image" && !flippedImage)) return false;
  const dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy; if (!L2) return false;
  const aligned = A[0] === B[0] || A[1] === B[1];
  const refl = (x: number, y: number) => { const t = ((x - A[0]) * dx + (y - A[1]) * dy) / L2; return [2 * (A[0] + t * dx) - x, 2 * (A[1] + t * dy) - y]; };
  const axisAngle = -Math.atan2(dy, dx) * 180 / Math.PI, reflect = (a: number) => 2 * axisAngle - a;
  if (k === "image") {
    // REFERENCE_IMAGE::Mirror( aAxis ): the centre reflects, the picture flips top / bottom in its own frame
    // (BITMAP_BASE::Mirror( TOP_BOTTOM ), the caller's re-encoded data) and the orientation is
    // EDA_ORIENTATION::Reflect( axisAngle ), normalised
    mapNodePoints(node, refl);
    const r = K.kid(node, "rotate"), a = norm360(reflect(r ? K.num(r[1]) : 0));
    if (r) { if (a) r[1] = r6(a); else node.splice(node.indexOf(r), 1); }
    else if (a) { const ly = K.kid(node, "layer"); node.splice(ly ? node.indexOf(ly) + 1 : 2, 0, ["rotate", r6(a)]); }
    const data: SNode = ["data"]; for (let i = 0; i < flippedImage!.length; i += 76) data.push(flippedImage!.slice(i, i + 76));
    const d = K.kid(node, "data"); if (d) node[node.indexOf(d)] = data; else node.push(data);
    return node;
  }
  if (k === "table") { if (!aligned) return false; mirrorNode(node, A[0], A[1], A[0] === B[0] ? "h" : "v"); return node; }   // PCB_TABLE::Mirror( aAxis.A, flipDirection )
  if (k === "gr_ellipse" || k === "gr_ellipse_arc") return mirrorEllipseAxis(node, A, B);
  if (k === "gr_text" || k === "property") {
    mapNodePoints(node, refl); let a = norm360(reflect(angleKid(node)));
    if (a > 90 && a <= 270) {
      a -= 180;
      let eff = K.kid(node, "effects"); if (!eff) { eff = ["effects"]; node.push(eff); }
      let j = K.kid(eff, "justify"); if (!j) { j = ["justify"]; eff.push(j); }
      const li = j.indexOf("left"), ri = j.indexOf("right");
      if (li > 0) j[li] = "right"; else if (ri > 0) j[ri] = "left";   // a centred text stays centred
      if (j.length === 1) eff.splice(eff.indexOf(j), 1);
    }
    setAngleKid(node, a); return node;
  }
  if (k === "gr_text_box" && K.kid(node, "start") && K.kid(node, "end")) {
    const s = K.kid(node, "start")!, e = K.kid(node, "end")!; const cx = (K.num(s[1]) + K.num(e[1])) / 2, cy = (K.num(s[2]) + K.num(e[2])) / 2;
    const [rx, ry] = refl(cx, cy); const ddx = r6(rx - cx), ddy = r6(ry - cy);
    s[1] = r6(K.num(s[1]) + ddx); s[2] = r6(K.num(s[2]) + ddy); e[1] = r6(K.num(e[1]) + ddx); e[2] = r6(K.num(e[2]) + ddy);
    setTextBoxAngle(node, reflect(textBoxAngle(node))); return node;
  }
  if (k === "gr_rect" && !aligned) {   // "Convert non-cardinally-mirrored rect to a polygon."
    const a = pt(node, "start"), b = pt(node, "end"); if (!a || !b) return false; const [x0, y0, x1, y1] = corners(a, b);
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => refl(x, y));
    node[0] = node[0] === "fp_rect" ? "fp_poly" : "gr_poly"; for (const key of ["start", "end"]) { const i = node.indexOf(K.kid(node, key)!); if (i > 0) node.splice(i, 1); }
    node.splice(1, 0, ["pts", ...pts.map(xy)]); return node;
  }
  mapNodePoints(node, refl);
  if (k === "gr_text_box") setTextBoxAngle(node, reflect(textBoxAngle(node)));   // a polygon text box: its vertices and the text angle
  if (k === "zone") {
    const f = K.kid(node, "fill"); const set = (c: SNode | null | undefined) => { if (c && c.length > 1) c[1] = r6(norm360(reflect(K.num(c[1])))); };
    if (f) { set(K.kid(f, "hatch_orientation")); const t = K.kid(f, "thieving"); if (t) set(K.kid(t, "orientation")); }
  }
  if (k === "pad") {
    // PAD::Mirror: the orientation reflects and the pad's own geometry mirrors top / bottom in its frame - the same
    // copper as a left / right mirror of that geometry (padMirrorX) at the orientation less half a turn
    const o = angleKid(node); padMirrorX(node); setAngleKid(node, reflect(o) - 180);
    const ch = K.kid(node, "chamfer"); const lr: Record<string, string> = { top_left: "top_right", top_right: "top_left", bottom_left: "bottom_right", bottom_right: "bottom_left" };
    if (ch) for (let i = 1; i < ch.length; i++) { const v = K.str(ch[i]); if (lr[v]) ch[i] = lr[v]; }
  }
  return node;
}
/** MIRROR_SKIPS: what a mirror could not move. */
export interface MirrorSkips { footprints: number; groups: number; items: number }
/**
 * mirrorSelection( commit, selection, aAxis ) (edit_tool.cpp): every mirrorable item of the selection about the axis
 * A-B.  A footprint is skipped (counted); a top-level group holding a footprint - or, for an oblique axis, a table -
 * is skipped whole (counted); a table about an oblique axis is skipped (counted as an item).
 */
export function mirrorAxisChanges(doc: BoardDoc, ids: string[], A: Pt, B: Pt, groupOfId: (id: string) => KItem | null, members: (id: string) => string[], flippedImages?: Map<string, string>): { changes: PcbChange[]; skips: MirrorSkips } {
  const skips: MirrorSkips = { footprints: 0, groups: 0, items: 0 }, aligned = A[0] === B[0] || A[1] === B[1]; const skip = new Set<string>();
  for (const id of ids) {
    const it = doc.items.get(id); if (!it || it.kind !== "group" || groupOfId(id)) continue;   // the top-level groups
    const inner = members(id).map((x) => doc.items.get(x)).filter(Boolean) as KItem[];
    if (inner.some((m) => m.kind === "footprint" || (!aligned && m.kind === "table"))) { skips.groups++; skip.add(id); inner.forEach((m) => skip.add(m.id)); }
  }
  const changes = transformChanges(doc, ids.filter((id) => !skip.has(id)), (n, it) => {
    if (it.kind === "footprint") { skips.footprints++; return false; }
    if (it.kind === "table" && !aligned) { skips.items++; return false; }
    if (it.kind === "image") {   // PCB_REFERENCE_IMAGE::Mirror( aAxis ), with the picture's pixels flipped beforehand
      const f = flippedImages && flippedImages.get(it.id); if (!f) { skips.items++; return false; }
      return mirrorNodeAxis(n, A, B, f);
    }
    return mirrorNodeAxis(n, A, B);
  });
  return { changes, skips };
}
/**
 * BITMAP_BASE::Mirror( TOP_BOTTOM ) on a stored picture: the raster is decoded, flipped top / bottom and re-encoded
 * (PNG) by the browser, which only answers later.  Resolves to the new base64, or null when it cannot be read.
 */
export type PcbImageFlipFn = (base64: string) => Promise<string | null>;
function browserImageFlipTB(base64: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement("canvas"); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const g = cv.getContext("2d"); if (!g || !cv.width || !cv.height) { resolve(null); return; }
        g.translate(0, cv.height); g.scale(1, -1); g.drawImage(img, 0, 0);
        resolve(cv.toDataURL("image/png").split(",")[1] || null);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = "data:" + (base64.startsWith("/9j/") ? "image/jpeg" : "image/png") + ";base64," + base64;
  });
}
let pcbImageFlipImpl: PcbImageFlipFn | null = typeof document !== "undefined" && typeof Image !== "undefined" ? browserImageFlipTB : null;
export function setPcbImageFlipImpl(fn: PcbImageFlipFn | null): void { pcbImageFlipImpl = fn; }
/** The flipped pictures of the image items among ids (id -> base64); null when there is none to flip or no decoder. */
export async function flippedImagesOf(doc: BoardDoc, ids: Iterable<string>): Promise<Map<string, string> | null> {
  const imgs = Array.from(ids).map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && it.kind === "image");
  if (!imgs.length || !pcbImageFlipImpl) return null;
  const out = new Map<string, string>();
  for (const it of imgs) {
    const d = K.kid(it.node, "data"); const b64 = d ? d.slice(1).map((x) => String(x)).join("") : "";
    const f = b64 ? await pcbImageFlipImpl(b64) : null; if (f) out.set(it.id, f);
  }
  return out;
}
/** The centre of the circle through an arc's start, mid and end, or null when they are in line. */
export function arcCentre3(a: Pt, m: Pt, e: Pt): Pt | null {
  const d = 2 * (a[0] * (m[1] - e[1]) + m[0] * (e[1] - a[1]) + e[0] * (a[1] - m[1])); if (Math.abs(d) < 1e-12) return null;
  const A = a[0] * a[0] + a[1] * a[1], M = m[0] * m[0] + m[1] * m[1], E = e[0] * e[0] + e[1] * e[1];
  return [(A * (m[1] - e[1]) + M * (e[1] - a[1]) + E * (a[1] - m[1])) / d, (A * (e[0] - m[0]) + M * (a[0] - e[0]) + E * (m[0] - a[0])) / d];
}
/** The first vertex of a (pts ...) list: an (xy) or the start of an (arc). */
function firstVertex(pts: SNode | null | undefined): Pt | null {
  if (pts) for (const p of pts.slice(1)) { if (!isList(p)) continue; if (p[0] === "xy") return [K.num(p[1]), K.num(p[2])]; const s = pt(p, "start"); if (s) return s; }
  return null;
}
/**
 * BOARD_ITEM::GetPosition: a footprint's, via's, text's or image's (at); a track's start; EDA_SHAPE::getPosition for
 * graphics (an arc's centre, a polygon's first vertex, m_start for the rest: a line's start, a rectangle's start
 * corner, a circle's centre); a text box's start corner; a zone's first corner; a dimension's start; a table's first
 * cell's start.  The middle of the bounding box only when the node has none of these.
 */
export function anchorOf(item: KItem): Pt {
  const n = item.node, k = item.kind;
  if (k === "footprint" || k === "via" || k === "gr_text" || k === "image" || k === "target") { const [x, y] = K.atOf(n); return [x, y]; }
  if (k === "gr_arc") { const a = pt(n, "start"), m = pt(n, "mid"), e = pt(n, "end"); const c = a && m && e ? arcCentre3(a, m, e) : pt(n, "center"); if (c) return [r6(c[0]), r6(c[1])]; }
  if (k === "segment" || k === "arc" || k === "gr_line" || k === "gr_arc" || k === "gr_rect" || k === "gr_text_box") { const p = pt(n, "start"); if (p) return p; }
  if (k === "gr_circle" || k === "gr_ellipse" || k === "gr_ellipse_arc") { const p = pt(n, "center"); if (p) return p; }
  if (k === "gr_poly" || k === "gr_curve" || k === "dimension" || k === "gr_text_box") { const p = firstVertex(K.kid(n, "pts")); if (p) return p; }
  if (k === "zone") { const poly = K.kid(n, "polygon"); const p = poly && firstVertex(K.kid(poly, "pts")); if (p) return p; }
  if (k === "table") { const cells = K.kid(n, "cells"); const first = cells && K.kids(cells, "table_cell")[0]; const p = first && pt(first, "start"); if (p) return p; }
  if (k === "drill_map") { const o = K.kid(n, "offset"); if (o) return [K.num(o[1]), K.num(o[2])]; }   // PCB_DRILL_MAP::GetPosition: its offset
  if (k === "generated") { const c = K.kid(n, "origin"); const xy = c && K.kid(c, "xy"); if (xy) return [K.num(xy[1]), K.num(xy[2])]; }   // PCB_GENERATOR::GetPosition
  const b = item.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
export function bboxUnion(items: KItem[]) { let b: Box | null = null; for (const it of items) { if (!it.bbox) continue; b = b ? [Math.min(b[0], it.bbox[0]), Math.min(b[1], it.bbox[1]), Math.max(b[2], it.bbox[2]), Math.max(b[3], it.bbox[3])] : it.bbox.slice(); } return b; }
/** KiCad's modification point: a lone item turns about its own anchor, a group about the middle of its bounding box. */
export function selectionCenter(items: KItem[]) {
  if (items.length === 1) return anchorOf(items[0]);
  const b = bboxUnion(items); return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : [0, 0];
}
/** MODIFIED changes for the items whose clones fn edits (return false from fn to leave one alone). */
export function transformChanges(doc: BoardDoc, ids: Iterable<string>, fn: (node: SNode, it: KItem) => unknown) {
  const out: PcbChange[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it || it.kind === "group") continue;
    const node = clone(it.node); if (fn(node, it) === false) continue; out.push(replacedChange(it, node));
  }
  return out;
}
export const moveChanges = (doc: BoardDoc, ids: Iterable<string>, dx: number, dy: number) => (dx || dy) ? transformChanges(doc, ids, (n) => translateNode(n, dx, dy)) : [];
export const rotateChanges = (doc: BoardDoc, ids: Iterable<string>, cx: number, cy: number, deg: number) => transformChanges(doc, ids, (n) => rotateNode(n, cx, cy, deg));
export const flipChanges = (doc: BoardDoc, ids: Iterable<string>, cx: number, cy?: number, dir?: string) => transformChanges(doc, ids, (n) => flipNode(n, cx, doc, cy, dir));
export const mirrorChanges = (doc: BoardDoc, ids: Iterable<string>, cx: number, cy: number, axis: string) => transformChanges(doc, ids, (n) => mirrorNode(n, cx, cy, axis));
/** DIALOG_MOVE_EXACT: translate, then turn about the selection centre, each item's own anchor, or a point. */
export function moveExactChanges(doc: BoardDoc, ids: string[], opts: { dx?: number; dy?: number; rotation?: number; about?: string | Pt }) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; const dx = opts.dx || 0, dy = opts.dy || 0, rot = opts.rotation || 0;
  const b = bboxUnion(items);   // ROTATE_AROUND_SEL_CENTER is the bounding box's middle, a lone item included
  let c: Pt | null = opts.about === "anchor" ? null : isList(opts.about) ? opts.about as Pt : b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : selectionCenter(items);
  if (c) c = [c[0] + dx, c[1] + dy];
  return transformChanges(doc, ids, (n, it: KItem) => { translateNode(n, dx, dy); if (rot) { const p = c || vadd(anchorOf(it), [dx, dy]); rotateNode(n, p[0], p[1], rot); } });
}
/** PCB_SELECTION::GetTopLeftItem: the item whose anchor is leftmost, then topmost — the selection's own anchor. */
export function topLeftAnchor(items: KItem[]): Pt {
  // POSITION_RELATIVE_TOOL: "We prefer footprints, then pads, then anything else" (GetTopLeftItem( true ) first)
  const fps = items.filter((it) => it.kind === "footprint"); if (fps.length && fps.length < items.length) return topLeftAnchor(fps);
  const pads = items.filter((it) => it.kind === "pad"); if (pads.length && pads.length < items.length) return topLeftAnchor(pads);
  let best: Pt | null = null; for (const it of items) { const p = anchorOf(it); if (!best || p[0] < best[0] - 1e-9 || (Math.abs(p[0] - best[0]) <= 1e-9 && p[1] < best[1])) best = p; } return best || [0, 0];
}
/** POSITION_RELATIVE_TOOL: put the selection's anchor at the reference point plus the offset. */
export function positionRelativeChanges(doc: BoardDoc, ids: string[], ref: Pt, dx: number, dy: number) {
  const items = ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[]; if (!items.length) return [];
  const a = topLeftAnchor(items); return moveChanges(doc, ids, ref[0] + dx - a[0], ref[1] + dy - a[1]);
}
// ALIGN_DISTRIBUTE_TOOL: bounding boxes; the target is the item under the cursor, else the first after sorting.
export const ALIGN: Record<string, { sort(b: Box): number; target(b: Box): number; move(b: Box, t: number): number[] }> = {
  left: { sort: (b: Box) => b[0], target: (b: Box) => b[0], move: (b: Box, t: number) => [t - b[0], 0] },
  right: { sort: (b: Box) => -b[2], target: (b: Box) => b[2], move: (b: Box, t: number) => [t - b[2], 0] },
  top: { sort: (b: Box) => b[1], target: (b: Box) => b[1], move: (b: Box, t: number) => [0, t - b[1]] },
  bottom: { sort: (b: Box) => -b[3], target: (b: Box) => b[3], move: (b: Box, t: number) => [0, t - b[3]] },
  centerX: { sort: (b: Box) => (b[0] + b[2]) / 2, target: (b: Box) => (b[0] + b[2]) / 2, move: (b: Box, t: number) => [t - (b[0] + b[2]) / 2, 0] },
  centerY: { sort: (b: Box) => (b[1] + b[3]) / 2, target: (b: Box) => (b[1] + b[3]) / 2, move: (b: Box, t: number) => [0, t - (b[1] + b[3]) / 2] },
};
/**
 * align_distribute_tool.cpp getBoundingBox: a footprint by FOOTPRINT::GetBoundingBox( false ) — its pads and shapes
 * without the texts (and pads by their copper, not their mask / paste openings) — anything else by its own box.
 */
export function alignBox(it: KItem) {
  if (it.kind !== "footprint" || !K.boardItemBox || !it.geom) return it.bbox;
  const geom = it.geom.filter((g) => g.t !== "text" && !g.padNum && !g.padText && !(g.pad && /\.(Mask|Paste)$/.test(g.layer || "")));
  const r = K.boardItemBox(Object.assign({}, it, { geom }), 1e6); if (!r) return it.bbox;
  return [r[0] / 1e6, r[1] / 1e6, (r[0] + r[2]) / 1e6, (r[1] + r[3]) / 1e6];
}
export const alignItems = (doc: BoardDoc, ids: string[]) => (ids.map((id: string) => doc.items.get(id)).filter((it) => it && it.bbox && it.kind !== "group") as KItem[]).map((it: KItem) => ({ id: it.id, kind: it.kind, bbox: alignBox(it)! }));
/** An item as Align / Distribute see it. */
export type AlignItem = ReturnType<typeof alignItems>[number];
/** KiCad's commit names for the six alignments (ALIGN_DISTRIBUTE_TOOL: AlignCenterX pushes "Align to Middle", AlignCenterY "Align to Center"). */
export const ALIGN_COMMIT: Record<string, string> = { left: "Align to Left", right: "Align to Right", top: "Align to Top", bottom: "Align to Bottom", centerX: "Align to Middle", centerY: "Align to Center" };
/**
 * ALIGN_DISTRIBUTE_TOOL::Align*: GetSelections splits the locked items (opts.locked) from the ones to align, each
 * list sorted by the mode's edge; selectTarget prefers a locked item (the one under the cursor, else the first), then
 * an item to align under the cursor, then the first; only the unlocked items move.  AlignLeft / AlignRight change
 * places when the view is mirrored (opts.mirrored: IsMirroredX), because the boxes are not mirrored with it.
 */
export function alignChanges(doc: BoardDoc, ids: string[], mode: string, cursor: Pt | null | undefined, opts?: { locked?: Set<string>; mirrored?: boolean }) {
  if (opts && opts.mirrored && (mode === "left" || mode === "right")) mode = mode === "left" ? "right" : "left";
  const A = ALIGN[mode]; if (!A) return [];
  const all = alignItems(doc, ids); const isLocked = (id: string) => !!(opts && opts.locked && opts.locked.has(id));
  const items = all.filter((it) => !isLocked(it.id)), locked = all.filter((it) => isLocked(it.id)); if (!items.length) return [];
  const byEdge = (p: AlignItem, q: AlignItem) => A.sort(p.bbox) - A.sort(q.bbox); items.sort(byEdge); locked.sort(byEdge);
  const underOf = (list: AlignItem[]) => cursor ? list.find((it) => cursor[0] >= it.bbox[0] && cursor[0] <= it.bbox[2] && cursor[1] >= it.bbox[1] && cursor[1] <= it.bbox[3]) : undefined;
  const target = locked.length ? underOf(locked) || locked[0] : underOf(items) || items[0];
  const t = A.target(target.bbox); const out: PcbChange[] = [];
  for (const it of items) { const [dx, dy] = A.move(it.bbox, t); if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) out.push(...moveChanges(doc, [it.id], dx, dy)); }
  return out;
}
/** GetDeltasForDistributeByGaps / ByPoints (libs/kimath geometry/distribute.cpp), in mm. */
export function distributeDeltasGaps(extents: number[][]) {
  const d = extents.map(() => 0); if (extents.length < 3) return d;
  let gap = extents[extents.length - 1][0] - extents[0][1]; for (let i = 1; i < extents.length - 1; i++) gap -= extents[i][1] - extents[i][0];
  const per = gap / (extents.length - 1); let target = extents[0][1];
  for (let i = 1; i < extents.length - 1; i++) { d[i] = target - extents[i][0] + i * per; target += extents[i][1] - extents[i][0]; }
  return d;
}
export function distributeDeltasPoints(pos: number[]) {
  const d = pos.map(() => 0); if (pos.length < 3) return d; const gap = (pos[pos.length - 1] - pos[0]) / (pos.length - 1);
  for (let i = 1; i < pos.length - 1; i++) d[i] = pos[0] + i * gap - pos[i];
  return d;
}
export function distributeChanges(doc: BoardDoc, ids: string[], axis: string, byCenters: boolean) {
  const items = alignItems(doc, ids); if (items.length < 3) return [];
  const x = axis === "x"; const lo = (b: Box) => x ? b[0] : b[1], hi = (b: Box) => x ? b[2] : b[3], mid = (b: Box) => (lo(b) + hi(b)) / 2;
  items.sort((p, q) => (byCenters ? mid(p.bbox) - mid(q.bbox) : lo(p.bbox) - lo(q.bbox)));
  const d = byCenters ? distributeDeltasPoints(items.map((it) => mid(it.bbox))) : distributeDeltasGaps(items.map((it) => [lo(it.bbox), hi(it.bbox)]));
  const out: PcbChange[] = []; items.forEach((it, i: number) => { if (Math.abs(d[i]) > 1e-9) out.push(...moveChanges(doc, [it.id], x ? d[i] : 0, x ? 0 : d[i])); }); return out;
}
/** The kinds that share a KICAD_T (a == b in EDIT_TOOL::Swap's a->Type() == b->Type()). */
const swapType = (k: string) => /^gr_(line|rect|circle|arc|poly|curve)$/.test(k) ? "shape" : k;
/**
 * EDIT_TOOL::Swap: each item takes the place of the next (positions; footprints also trade orientation and side; two
 * other items of the same type, groups apart, trade layers as well).  KiCad swaps the pairs (i, i + 1) in turn, so
 * the layers travel the same way the positions do wherever neighbours share a type.
 */
export function swapChanges(doc: BoardDoc, ids: string[]) {
  const items = ids.map((id: string) => doc.items.get(id)).filter((it) => it && it.kind !== "group") as KItem[]; if (items.length < 2) return [];
  const slots = items.map((it: KItem) => ({ p: anchorOf(it), rot: it.kind === "footprint" ? it.rot : 0, layer: it.kind === "footprint" ? it.layer : null }));
  const out: PcbChange[] = [];
  // a->SetLayer( bLayer ), pair by pair: only single-layer items (a (layer) child) of one type, never footprints or groups
  const layerKid = (it: KItem) => it.kind === "footprint" || it.kind === "group" || it.kind === "generated" ? null : K.kid(it.node, "layer");
  const layers = items.map((it) => { const l = layerKid(it); return l ? K.str(l[1]) : null; });
  for (let i = 0; i + 1 < items.length; i++) if (swapType(items[i].kind) === swapType(items[i + 1].kind) && layers[i] !== null && layers[i + 1] !== null) { const t = layers[i]; layers[i] = layers[i + 1]; layers[i + 1] = t; }
  items.forEach((it: KItem, i: number) => {
    const to = slots[(i + 1) % items.length], from = slots[i]; const node = clone(it.node);
    const lk = K.kid(node, "layer"); if (layers[i] !== null && lk && it.kind !== "footprint" && K.str(lk[1]) !== layers[i]) lk[1] = layers[i]!;
    translateNode(node, to.p[0] - from.p[0], to.p[1] - from.p[1]);
    if (it.kind === "footprint") { if (to.layer !== from.layer) flipNode(node, to.p[0], doc); if (to.rot !== K.atOf(node)[2]) rotateFootprintNode(node, to.rot! - K.atOf(node)[2]); }
    out.push(replacedChange(it, node));
  });
  return out;
}
// ---------------------------------------------------------------- rectpack2D (thirdparty/rectpack2d), flipping disabled
interface PackRect { x: number; y: number; w: number; h: number }
/** rectpack2D::insert_and_split: the spaces left when an image takes the corner of an empty space, or null when it does not fit. */
function insertAndSplit(w: number, h: number, sp: PackRect): PackRect[] | null {
  const fw = sp.w - w, fh = sp.h - h;
  if (fw < 0 || fh < 0) return null;
  if (fw === 0 && fh === 0) return [];
  if (fw > 0 && fh === 0) return [{ x: sp.x + w, y: sp.y, w: sp.w - w, h: sp.h }];
  if (fw === 0 && fh > 0) return [{ x: sp.x, y: sp.y + h, w: sp.w, h: sp.h - h }];
  if (fw > fh) return [{ x: sp.x + w, y: sp.y, w: fw, h: sp.h }, { x: sp.x, y: sp.y + h, w, h: fh }];
  return [{ x: sp.x, y: sp.y + h, w: sp.w, h: fh }, { x: sp.x + w, y: sp.y, w: fw, h }];
}
/** rectpack2D::empty_spaces with default_empty_spaces: candidates are tried from the last space added back to the first. */
class EmptySpaces {
  spaces: PackRect[] = [];
  reset(w: number, h: number) { this.spaces = [{ x: 0, y: 0, w, h }]; }
  insert(w: number, h: number): PackRect | null {
    for (let i = this.spaces.length - 1; i >= 0; --i) {
      const sp = this.spaces[i], splits = insertAndSplit(w, h, sp); if (!splits) continue;
      this.spaces[i] = this.spaces[this.spaces.length - 1]; this.spaces.pop();
      for (const r of splits) this.spaces.push(r);
      return { x: sp.x, y: sp.y, w, h };
    }
    return null;
  }
}
/** best_packing_for_ordering_impl: the binary search on the bin size; a bin [w, h], or the area inserted when even the starting bin fails. */
function bestPackingImpl(root: EmptySpaces, order: PackRect[], start: [number, number], discardStep: number, dim: "both" | "w" | "h"): [number, number] | number {
  const bin: [number, number] = [start[0], start[1]]; let tries = 0;
  if (discardStep <= 0) { tries = -discardStep; discardStep = 1; }
  let step: number;
  if (dim === "both") { bin[0] = Math.trunc(bin[0] / 2); bin[1] = Math.trunc(bin[1] / 2); step = Math.trunc(bin[0] / 2); }
  else if (dim === "w") { bin[0] = Math.trunc(bin[0] / 2); step = Math.trunc(bin[0] / 2); }
  else { bin[1] = Math.trunc(bin[1] / 2); step = Math.trunc(bin[1] / 2); }
  for (;; step = Math.max(1, Math.trunc(step / 2))) {
    root.reset(bin[0], bin[1]);
    let inserted = 0, all = true;
    for (const r of order) { if (root.insert(r.w, r.h)) inserted += r.w * r.h; else { all = false; break; } }
    if (all) {
      if (step <= discardStep) { if (tries > 0) tries--; else return bin; }
      if (dim === "both") { bin[0] -= step; bin[1] -= step; } else if (dim === "w") bin[0] -= step; else bin[1] -= step;
    } else if (dim === "both") { bin[0] += step; bin[1] += step; if (bin[0] * bin[1] > start[0] * start[1]) return inserted; }
    else if (dim === "w") { bin[0] += step; if (bin[0] > start[0]) return inserted; }
    else { bin[1] += step; if (bin[1] > start[1]) return inserted; }
  }
}
/** best_packing_for_ordering: both sides together, then the width and the height on their own. */
function bestPackingForOrdering(root: EmptySpaces, order: PackRect[], start: [number, number], discardStep: number): [number, number] | number {
  const first = bestPackingImpl(root, order, start, discardStep, "both"); if (typeof first === "number") return first;
  let best = first;
  for (const dim of ["w", "h"] as const) { const t = bestPackingImpl(root, order, best, discardStep, dim); if (typeof t !== "number") best = t; }
  return best;
}
/**
 * rectpack2D::find_best_packing with its six stock orderings (area, perimeter, longer side, width, height,
 * pathological_mult, each descending), flipping disabled: the rectangles take their x / y in the best bin found.
 * Returns false when no ordering could be tried or a rectangle did not fit the best bin (the caller grows the bin).
 */
export function findBestPacking(rects: PackRect[], maxSide: number, discardStep: number): boolean {
  const live = rects.filter((r) => r.w * r.h > 0);
  const f32 = Math.fround, patho = (r: PackRect) => f32(f32(f32(Math.max(r.w, r.h)) / f32(Math.min(r.w, r.h))) * f32(r.w * r.h));
  const keys: ((r: PackRect) => number)[] = [(r) => r.w * r.h, (r) => 2 * r.w + 2 * r.h, (r) => Math.max(r.w, r.h), (r) => r.w, (r) => r.h, patho];
  const orders = keys.map((k) => live.slice().sort((a, b) => k(b) - k(a)));
  const root = new EmptySpaces(); let bestOrder: PackRect[] | null = null, bestInserted = -1, bestBin: [number, number] = [maxSide, maxSide];
  for (const order of orders) {
    const packing = bestPackingForOrdering(root, order, [maxSide, maxSide], discardStep);
    if (typeof packing === "number") { if (bestOrder === null && packing > bestInserted) { bestOrder = order; bestInserted = packing; } }
    else if (packing[0] * packing[1] <= bestBin[0] * bestBin[1]) { bestOrder = order; bestBin = packing; }
  }
  if (!bestOrder) return false;
  root.reset(bestBin[0], bestBin[1]);
  for (const r of bestOrder) { const got = root.insert(r.w, r.h); if (!got) return false; r.x = got.x; r.y = got.y; }   // report_unsuccessful: ABORT_PACKING
  return true;
}
const PACK_SCALE = 10000;   // spread_footprints.cpp `scale`: placement in 0.01 mm units
/** spreadRectangles: the bin starts at the larger area side and grows by a fifth until every rectangle fits. */
function spreadRectangles(rects: PackRect[], areaX: number, areaY: number) {
  let maxSide = Math.max(Math.trunc(areaX / PACK_SCALE), Math.trunc(areaY / PACK_SCALE));
  for (let i = 0; i < 2000; i++) { if (findBestPacking(rects, maxSide, 1)) break; maxSide = Math.trunc(maxSide * 1.2); }
}
/** UTIL::GetRefDesPrefix and GetTrailingInt, for compareFootprintsbyRef. */
const refDesPrefix = (ref: string) => ref.replace(/[0-9?]+$/, "");
const trailingInt = (ref: string) => { const m = /(\d+)$/.exec(ref); return m ? parseInt(m[1], 10) : 0; };
/**
 * SpreadFootprints( footprints, target, aGroupBySheet = false ) (pcbnew/autorouter/spread_footprints.cpp) as
 * EDIT_TOOL::PackAndMoveFootprints calls it, in nanometres: the footprints are grouped by the size of their
 * GetBoundingBox( false ) plus the 1 mm component gap; each size's footprints, sorted by reference, are laid out in
 * a block of rows or columns; the blocks are packed with rectpack2D in 0.01 mm units; and the whole lot goes to
 * `target` (the selection box's origin).  Returns each footprint's node at its packed place (only those that moved).
 * PCB_EDIT_FRAME::OnNetlistChanged calls it as SpreadFootprints( new footprints, { 0, 0 }, true ): `opts.target` (mm)
 * and `opts.groupBySheet`, which packs each sheet's footprints (their path without the symbol uuid) as a group first.
 */
export function packNodes(doc: BoardDoc, ids: string[], opts?: { target?: Pt; groupBySheet?: boolean }): Map<string, SNode> {
  const IU = 1e6, GAP = 1 * IU, GROUP_GAP = 1.5 * IU;
  interface Fp { it: KItem; x: number; y: number; w: number; h: number; dx: number; dy: number }
  const fps: Fp[] = [];
  for (const id of ids) {
    const it = doc.items.get(id); if (!it || it.kind !== "footprint") continue; const b = alignBox(it); if (!b) continue;
    fps.push({ it, x: Math.round(b[0] * IU), y: Math.round(b[1] * IU), w: Math.round(b[2] * IU) - Math.round(b[0] * IU), h: Math.round(b[3] * IU) - Math.round(b[1] * IU), dx: 0, dy: 0 });
  }
  const out = new Map<string, SNode>(); if (!fps.length) return out;
  type Box4 = [number, number, number, number] | null;   // x0, y0, x1, y1
  const merge = (b: Box4, x0: number, y0: number, x1: number, y1: number): Box4 => b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1];
  const moveFp = (f: Fp, dx: number, dy: number) => { f.x += dx; f.y += dy; f.dx += dx; f.dy += dy; };
  let target: Box4 = null; for (const f of fps) target = merge(target, f.x, f.y, f.x + f.w, f.y + f.h);   // footprintsBbox.Normalize().GetOrigin()
  const tx0 = opts && opts.target ? Math.round(opts.target[0] * IU) : target![0], ty0 = opts && opts.target ? Math.round(opts.target[1] * IU) : target![1];
  // sheetsMap: std::map keyed by the footprint's path without its last uuid (aGroupBySheet), else one group
  const bySheet = new Map<string, Fp[]>();
  for (const f of fps) { const p = opts && opts.groupBySheet ? (() => { const path = K.str((K.kid(f.it.node, "path") || [])[1]); const i = path.lastIndexOf("/"); return i >= 0 ? path.slice(0, i) : path; })() : ""; if (!bySheet.has(p)) bySheet.set(p, []); bySheet.get(p)!.push(f); }
  const sheets = Array.from(bySheet.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, list]) => ({ fps: list, box: null as Box4 }));
  for (const sh of sheets) {
    // sizeToFpMap: std::map<VECTOR2I, …> keyed by the size plus the gap, in x-then-y order
    const bySize = new Map<string, { sx: number; sy: number; fps: Fp[]; box: Box4 }>();
    for (const f of sh.fps) { const sx = f.w + GAP, sy = f.h + GAP, k = `${sx},${sy}`; if (!bySize.has(k)) bySize.set(k, { sx, sy, fps: [], box: null }); bySize.get(k)!.fps.push(f); }
    const blocks = Array.from(bySize.values()).sort((a, b) => a.sx - b.sx || a.sy - b.sy);
    for (const blk of blocks) {
      const n = blk.fps.length, { sx, sy } = blk;
      const initialSide = Math.sqrt(sx * sy * n), vertical = sx >= sy; let perLine = n;
      // "Wrap the line if the ratio is not satisfied" (singleLineRatio 5; integer division)
      if (vertical) { if (Math.trunc(sy * n / sx) > 5) perLine = Math.trunc(initialSide / sy); }
      else if (Math.trunc(sx * n / sy) > 5) perLine = Math.trunc(initialSide / sx);
      let optimal = perLine, rem = n % optimal;
      if (rem !== 0) for (let i = Math.max(2, perLine - 2); i <= Math.min(n - 2, perLine + 2); i++) { const r = n % i; if (r === 0 || r >= rem) { optimal = i; rem = r; } }
      blk.fps.sort((a, b) => {   // compareFootprintsbyRef
        const ra = a.it.ref || "", rb = b.it.ref || "", pa = refDesPrefix(ra), pb = refDesPrefix(rb);
        return pa !== pb ? (pa < pb ? -1 : 1) : trailingInt(ra) - trailingInt(rb);
      });
      blk.fps.forEach((f, i) => {
        let px = Math.trunc(sx / 2), py = Math.trunc(sy / 2);
        if (vertical) { px += sx * Math.trunc(i / optimal); py += sy * (i % optimal); } else { px += sx * (i % optimal); py += sy * Math.trunc(i / optimal); }
        moveFp(f, px - f.x, py - f.y);
        const g = Math.trunc(GAP / 2); blk.box = merge(blk.box, f.x - g, f.y - g, f.x + f.w + g, f.y + f.h + g);
      });
    }
    // pack the blocks
    const rects: PackRect[] = blocks.map((b) => ({ x: 0, y: 0, w: Math.trunc((b.box![2] - b.box![0]) / PACK_SCALE), h: Math.trunc((b.box![3] - b.box![1]) / PACK_SCALE) }));
    let blocksArea = 0; for (const b of blocks) blocksArea += (b.box![2] - b.box![0]) * (b.box![3] - b.box![1]);
    const side = Math.round(Math.sqrt(blocksArea)); spreadRectangles(rects, side, side);
    blocks.forEach((b, i) => { const tx = rects[i].x * PACK_SCALE, ty = rects[i].y * PACK_SCALE; for (const f of b.fps) { moveFp(f, tx - b.box![0], ty - b.box![1]); sh.box = merge(sh.box, f.x, f.y, f.x + f.w, f.y + f.h); } });
  }
  // the sheet groups: each box with the group gap is packed, then set down at the target
  const sr: PackRect[] = sheets.map((sh) => { const sb = sh.box!; return { x: 0, y: 0, w: Math.trunc((sb[2] - sb[0] + 2 * GROUP_GAP) / PACK_SCALE), h: Math.trunc((sb[3] - sb[1] + 2 * GROUP_GAP) / PACK_SCALE) }; });
  let sheetsArea = 0; for (const sh of sheets) sheetsArea += (sh.box![2] - sh.box![0]) * (sh.box![3] - sh.box![1]);
  const sside = Math.trunc(Math.sqrt(sheetsArea)); spreadRectangles(sr, sside, sside);
  sheets.forEach((sh, i) => {
    const sb = sh.box!, tx = sr[i].x * PACK_SCALE + tx0, ty = sr[i].y * PACK_SCALE + ty0;
    for (const f of sh.fps) moveFp(f, tx - sb[0], ty - sb[1]);
  });
  for (const f of fps) if (f.dx || f.dy) out.set(f.it.id, translateNode(clone(f.it.node), f.dx / IU, f.dy / IU));
  return out;
}
/** The MODIFIED changes of packNodes (Pack and Move Footprints without the move). */
export function packChanges(doc: BoardDoc, ids: string[]) {
  const out: PcbChange[] = []; for (const [id, node] of packNodes(doc, ids)) out.push(replacedChange(doc.items.get(id)!, node)); return out;
}

/** A pad's own geometry mirrored left / right: drill offset, trapezoid delta and custom primitives, the angle negated. */
export function padMirrorX(node: SNode) {
  const dr = K.kid(node, "drill"); const off = dr && K.kid(dr, "offset"); if (off) off[1] = r6(-K.num(off[1]));
  const rd = K.kid(node, "rect_delta"); if (rd) rd[2] = r6(-K.num(rd[2]));
  const prims = K.kid(node, "primitives"); if (prims) for (const p of prims.slice(1)) if (isList(p)) mirrorShapeX(p);
  setAngleKid(node, -angleKid(node));
}
/** The same, top / bottom: a left / right mirror turned half a turn. */
export function padMirrorY(node: SNode) {
  padMirrorX(node);   // its local geometry turns with it
  setAngleKid(node, angleKid(node) + 180);
}
