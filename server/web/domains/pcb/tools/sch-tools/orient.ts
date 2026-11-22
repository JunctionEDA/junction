import type { Pt } from "./types";
import { fontNode, labelJustify } from "./nodes";
import { K, LINE_KINDS, SHAPE_KINDS, TEXT_KINDS, atOf, kid, kids, num, ptsOf, setAt, setPts, str } from "./state";
import { deep, dropKid, r4, replaceKid } from "./util";

// ---------------------------------------------------------------- orientation (KiCad's transform algebra)
// T = [x1, y1, x2, y2] maps library coords (Y up) to screen offsets; mirrors pre-multiply like the parser does.
/** A 2×2 transform [x1, y1, x2, y2]. */
export type Mat = number[];
export const ROT: Record<number, Mat> = { 0: [1, 0, 0, -1], 90: [0, -1, -1, 0], 180: [-1, 0, 0, 1], 270: [0, 1, 1, 0] };
export const MX = [1, 0, 0, -1], MY = [-1, 0, 0, 1], RCCW = [0, 1, -1, 0], RCW = [0, -1, 1, 0];
export const OP_M: Record<string, Mat> = { ccw: RCCW, cw: RCW, x: MX, y: MY };
export const SCREEN_OP: Record<string, (dx: number, dy: number) => Pt> = { ccw: (dx: number, dy: number) => [dy, -dx], cw: (dx: number, dy: number) => [-dy, dx], x: (dx: number, dy: number) => [dx, -dy], y: (dx: number, dy: number) => [-dx, dy] };
export function mul(A: Mat, B: Mat): Mat { return [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]].map((v) => v || 0); }   // no -0
export function tFrom(rot: number, mirror: string): Mat { let T = ROT[((Math.round(rot) % 360) + 360) % 360] || ROT[0]; if (mirror === "y") T = mul(MY, T); if (mirror === "x") T = mul(MX, T); return T; }
// KiCad's own search order when it writes a transform back out as (at … rot) + (mirror …)
export const ORIENTS: [number, string][] = [[0, ""], [90, ""], [180, ""], [270, ""], [0, "x"], [90, "x"], [270, "x"], [0, "y"], [90, "y"], [180, "y"], [270, "y"]];
export function orientOf(T: Mat) { for (const [rot, m] of ORIENTS) { const U = tFrom(rot, m); if (U[0] === T[0] && U[1] === T[1] && U[2] === T[2] && U[3] === T[3]) return { rot, mirror: m }; } return { rot: 0, mirror: "" }; }
export function symOrient(node: SNode) { const m = kid(node, "mirror"); return { rot: atOf(node)[2], mirror: m ? str(m[1]) : "" }; }
// Rotate / mirror a symbol node in place: compose the transform, rewrite (at … rot)/(mirror …)
// and carry the fields around the anchor with the same screen-space map.
export function orientSymbol(node: SNode, op: string) {
  const { rot, mirror } = symOrient(node); const o = orientOf(mul(OP_M[op], tFrom(rot, mirror)));
  const [ax, ay] = atOf(node); setAt(node, undefined, undefined, o.rot);
  dropKid(node, "mirror");
  if (o.mirror) { const ai = node.findIndex((c) => Array.isArray(c) && c[0] === "at"); node.splice(ai + 1, 0, ["mirror", o.mirror]); }
  const f = SCREEN_OP[op];
  for (const p of kids(node, "property")) { const a = kid(p, "at"); if (!a) continue; const [dx, dy] = f(num(a[1]) - ax, num(a[2]) - ay); a[1] = r4(ax + dx); a[2] = r4(ay + dy); }
  return o;
}
export function setTextRot(kind: string, node: SNode, rot: number) {
  rot = ((rot % 360) + 360) % 360;
  const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = rot; else a.push(rot);
  let ef = kid(node, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; node.push(ef); }
  replaceKid(ef, labelJustify(kind, rot));
}
/** EDA_TEXT::FlipHJustify on a node's (effects (justify …)): left <-> right; centred text stays centred. */
export function flipHJustify(node: SNode) {
  const ef = kid(node, "effects"), j = ef && kid(ef, "justify"); if (!j) return;
  const i = j.findIndex((t, k) => k > 0 && (t === "left" || t === "right")); if (i > 0) j[i] = j[i] === "left" ? "right" : "left";
}
const textVertical = (node: SNode) => { const r = atOf(node)[2] || 0; return r === 90 || r === 270; };
/**
 * SCH_TEXT::Rotate90 (free text, not a label): the angle only toggles between horizontal and vertical, and the
 * horizontal justification flips going horizontal -> vertical clockwise or vertical -> horizontal counter-clockwise.
 */
export function rotateText90(node: SNode, cw: boolean) {
  const v = textVertical(node); if ((!v && cw) || (v && !cw)) flipHJustify(node);
  const a = kid(node, "at"); if (!a) return; if (a.length >= 4) a[3] = v ? 0 : 90; else a.push(v ? 0 : 90);
}
/** SCH_TEXT::MirrorSpinStyle( aLeftRight ): the horizontal justification flips when the mirror runs along the text. */
export function mirrorTextSpin(node: SNode, leftRight: boolean) { const v = textVertical(node); if ((!v && leftRight) || (v && !leftRight)) flipHJustify(node); }
// ---------------------------------------------------------------- a label's fields follow it (SCH_LABEL_BASE)
/** A field's horizontal justification: "left", "right" or "center" (no left / right in its (justify …)). */
export function fieldHJustify(p: SNode): string { const ef = kid(p, "effects"), j = ef ? kid(ef, "justify") : null; return j && j.includes("left") ? "left" : j && j.includes("right") ? "right" : "center"; }
export function setFieldHJustify(p: SNode, h: string) {
  let ef = kid(p, "effects"); if (!ef) { ef = ["effects", fontNode(1.27)]; p.push(ef); }
  const j = kid(ef, "justify"), rest = j ? j.slice(1).filter((v) => v !== "left" && v !== "right") : [];
  const next = [...(h === "center" ? [] : [h]), ...rest];
  if (next.length) replaceKid(ef, ["justify", ...next]); else dropKid(ef, "justify");
}
const fieldVertical = (p: SNode): boolean => { const a = kid(p, "at"); return !!a && Math.abs(num(a[3]) % 180) === 90; };
const setFieldAngle = (p: SNode, deg: number) => { const a = kid(p, "at"); if (a) { if (a.length >= 4) a[3] = deg; else a.push(deg); } };
/** (fields_autoplaced yes): AUTOPLACE_AUTO — the fields are placed again when the label turns. */
export const fieldsAutoplaced = (node: SNode): boolean => { const fa = kid(node, "fields_autoplaced"); return !!fa && str(fa[1]) !== "no"; };
const INTERSHEET_FIELD = /^intersheet ?refs$/i;
/** EDA_TEXT::GetEffectiveTextPenWidth() of a label: its thickness, else size / 5 when bold and size / 8, at most a quarter of the size. */
function labelPen(node: SNode): number { const ef = K.effectsOf(node); return Math.min(ef.thick > 0.001 ? ef.thick : ef.bold ? ef.size / 5 : ef.size / 8, ef.size * 0.25); }
/** GetBodyBoundingBox().GetSizeMax() of a label: the larger side of the box of what it draws without its fields. */
function labelBodyLen(kind: string, node: SNode): number {
  const KC = K as unknown as { buildGeom(doc: unknown, item: unknown): void; geomBox(g: KGeom): number[] | null };
  const bare = deep(node).filter((c: unknown) => !(Array.isArray(c) && c[0] === "property")) as SNode;
  const item = { id: "label-len", kind, node: bare, geom: [] as KGeom[], bbox: null, movable: false, hiddenGeom: null, docType: "sch" };
  try { KC.buildGeom({ type: "sch", items: new Map(), lib: new Map() }, item); } catch (e) { return 0; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of item.geom) { const b = KC.geomBox(g); if (!b) continue; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  return x0 <= x1 ? Math.max(x1 - x0, y1 - y0) : 0;
}
/**
 * SCH_LABEL_BASE::AutoplaceFields: margin = 2 × the text offset; the Intersheetrefs field goes the body length + margin
 * out along the spin, every other field across it at half a text height (past the box of a global label) plus half
 * its own height.  A lone Intersheetrefs field stays on the label's position: it is placed when it is drawn
 * (SCHEMATIC::RecomputeIntersheetRefs), with the text the label has then.
 */
export function autoplaceLabelFields(kind: string, node: SNode) {
  const props = kids(node, "property"); if (!props.length) return;
  const [x, y, r0] = atOf(node), rot = ((Math.round(r0 || 0) % 360) + 360) % 360, size = K.effectsOf(node).size;
  const margin = 2 * K.schFormat.textOffsetRatio * size;
  let accumulated = size / 2, labelLen = -1;
  if (kind === "global_label") accumulated += margin + labelPen(node) + margin;
  for (const p of props) {
    const a = kid(p, "at"); if (!a) continue;
    const isr = INTERSHEET_FIELD.test(str(p[1])), h = K.effectsOf(p).size;
    if (isr && props.length === 1) { a[1] = r4(x); a[2] = r4(y); setFieldAngle(p, 0); setFieldHJustify(p, "left"); continue; }
    if (isr && labelLen < 0) labelLen = labelBodyLen(kind, node);
    let dx = 0, dy = 0;
    if (rot === 180) { setFieldAngle(p, 0); setFieldHJustify(p, "right"); if (isr) dx = -(labelLen + margin); else dy = accumulated + h / 2; }
    else if (rot === 90) { setFieldAngle(p, 90); setFieldHJustify(p, "left"); if (isr) dy = -(labelLen + margin); else dx = accumulated + h / 2; }
    else if (rot === 270) { setFieldAngle(p, 90); setFieldHJustify(p, "right"); if (isr) dy = labelLen + margin; else dx = accumulated + h / 2; }
    else { setFieldAngle(p, 0); setFieldHJustify(p, "left"); if (isr) dx = labelLen + margin; else dy = accumulated + h / 2; }
    a[1] = r4(x + dx); a[2] = r4(y + dy);
    if (isr) accumulated += h + margin;
  }
}
/**
 * SCH_FIELD::Rotate( centre, ccw ): a vertical field becomes horizontal (left and right swap when turning
 * counter-clockwise), a horizontal one vertical (they swap when turning clockwise), and its position turns about C.
 */
export function rotateField(p: SNode, C: Pt, ccw: boolean) {
  const hj = fieldHJustify(p);
  if (fieldVertical(p)) { if (ccw && hj !== "center") setFieldHJustify(p, hj === "left" ? "right" : "left"); setFieldAngle(p, 0); }
  else { if (!ccw && hj !== "center") setFieldHJustify(p, hj === "left" ? "right" : "left"); setFieldAngle(p, 90); }
  const a = kid(p, "at"); if (!a) return;
  const [dx, dy] = SCREEN_OP[ccw ? "ccw" : "cw"](num(a[1]) - C[0], num(a[2]) - C[1]); a[1] = r4(C[0] + dx); a[2] = r4(C[1] + dy);
}
/** SCH_LABEL_BASE::Rotate90 once the label itself has turned: autoplaced fields are placed again, the others turn about the label. */
export function rotateLabelFields(kind: string, node: SNode, cw: boolean, autoplace: (kind: string, node: SNode) => void = autoplaceLabelFields) {
  const props = kids(node, "property"); if (!props.length) return;
  if (fieldsAutoplaced(node)) { autoplace(kind, node); return; }
  const [x, y] = atOf(node);
  for (const p of props) rotateField(p, [x, y], !cw);
}
/**
 * The fields of a label mirrored with it.  `axis` "y" is Mirror Horizontally (left and right swap), "x" Mirror
 * Vertically.  Alone (SCH_LABEL_BASE / SCH_DIRECTIVE_LABEL::MirrorSpinStyle) a field whose angle lies along the mirror
 * direction becomes right-justified when it was left and left otherwise; in a group (MirrorHorizontally /
 * MirrorVertically) left and right swap — for a label's field when its angle lies along the direction, for a directive
 * label's field always across and never down.  Either way its position is mirrored about the label's.
 */
export function mirrorLabelFields(kind: string, node: SNode, axis: string, lone: boolean) {
  const [x, y] = atOf(node), leftRight = axis === "y", directive = kind === "netclass_flag" || kind === "directive_label";
  for (const p of kids(node, "property")) {
    const along = leftRight ? !fieldVertical(p) : fieldVertical(p), hj = fieldHJustify(p);
    if (lone) { if (along) setFieldHJustify(p, hj === "left" ? "right" : "left"); }
    else if ((directive ? leftRight : along) && hj !== "center") setFieldHJustify(p, hj === "left" ? "right" : "left");
    const a = kid(p, "at"); if (!a) continue;
    if (leftRight) a[1] = r4(x + (x - num(a[1]))); else a[2] = r4(y + (y - num(a[2])));
  }
}
export function rotateNode(kind: string, node: SNode, cw: boolean) {
  if (kind === "symbol") return orientSymbol(node, cw ? "cw" : "ccw");
  if (kind === "text") { rotateText90(node, cw); return true; }
  if (kind === "bus_entry") { const s = kid(node, "size"); if (!s) return; const [dx, dy] = SCREEN_OP[cw ? "cw" : "ccw"](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); return true; }
  if (TEXT_KINDS.has(kind)) { setTextRot(kind, node, atOf(node)[2] + (cw ? 270 : 90)); rotateLabelFields(kind, node, cw); return true; }
  return false;
}
export function mirrorNode(kind: string, node: SNode, axis: string, lone = true) {
  if (kind === "symbol") return orientSymbol(node, axis);
  if (kind === "text") { mirrorTextSpin(node, axis === "y"); return true; }
  if (kind === "bus_entry") { const s = kid(node, "size"); if (!s) return; const [dx, dy] = SCREEN_OP[axis](num(s[1]), num(s[2])); s[1] = r4(dx); s[2] = r4(dy); return true; }
  if (TEXT_KINDS.has(kind)) {   // labels flip their reading direction instead
    const rot = atOf(node)[2]; const flip: Record<number, number> = axis === "y" ? { 0: 180, 180: 0 } : { 90: 270, 270: 90 };
    // the fields are mirrored about the label whether or not the label's own direction changes
    const fields = kids(node, "property").length > 0; if (fields) mirrorLabelFields(kind, node, axis, lone);
    if (flip[rot] === undefined) return fields; setTextRot(kind, node, flip[rot]); return true;
  }
  return false;
}
export const SHAPE_POINTS: Record<string, string[]> = { rectangle: ["start", "end"], circle: ["center"], arc: ["start", "mid", "end"], ellipse: ["center"], ellipse_arc: ["center"] };
export function anchorOf(kind: string, node: SNode): Pt {
  if (LINE_KINDS.has(kind) || kind === "bezier") { const p = ptsOf(node); return p[0] || [0, 0]; }
  if (SHAPE_KINDS.has(kind)) { const k = kid(node, SHAPE_POINTS[kind][0]); return k ? [num(k[1]), num(k[2])] : [0, 0]; }
  if (kind === "rule_area") { const pl = kid(node, "polyline"); const p = pl ? ptsOf(pl) : []; return p[0] || [0, 0]; }
  if (kind === "table") { const cells = kid(node, "cells"); const c = cells && kid(cells, "table_cell"); if (c) { const [x, y] = atOf(c); return [x, y]; } return [0, 0]; }
  const [x, y] = atOf(node); return [x, y];
}
export function shiftAt(n: SNode, dx: number, dy: number) { const a = kid(n, "at"); if (a) { a[1] = r4(num(a[1]) + dx); a[2] = r4(num(a[2]) + dy); } }
export function shiftNode(kind: string, node: SNode, dx: number, dy: number) {
  if (!dx && !dy) return;
  if (LINE_KINDS.has(kind) || kind === "bezier") { setPts(node, ptsOf(node).map(([x, y]) => [x + dx, y + dy])); return; }
  if (SHAPE_KINDS.has(kind)) { for (const key of SHAPE_POINTS[kind]) { const k = kid(node, key); if (k) { k[1] = r4(num(k[1]) + dx); k[2] = r4(num(k[2]) + dy); } } return; }
  if (kind === "rule_area") { for (const pl of kids(node, "polyline")) setPts(pl, ptsOf(pl).map(([x, y]) => [x + dx, y + dy])); return; }
  if (kind === "table") { const cells = kid(node, "cells"); if (cells) for (const c of kids(cells, "table_cell")) shiftAt(c, dx, dy); return; }
  const [x, y] = atOf(node); setAt(node, r4(x + dx), r4(y + dy));
  for (const pr of kids(node, "property")) shiftAt(pr, dx, dy);
  if (kind === "sheet") for (const pin of kids(node, "pin")) shiftAt(pin, dx, dy);
}
// A copy with a fresh identity; the desktop re-annotates and rebuilds instance data.
export function cloneNode(item: Pick<KItem, "kind" | "node">) {
  const node = deep(item.node);
  if (item.kind === "rule_area") { dropKid(node, "uuid"); for (const pl of kids(node, "polyline")) replaceKid(pl, ["uuid", K.newUuid()]); return node; }
  replaceKid(node, ["uuid", K.newUuid()]);
  for (const pin of kids(node, "pin")) replaceKid(pin, ["uuid", K.newUuid()]);
  const cells = item.kind === "table" ? kid(node, "cells") : null; if (cells) for (const c of kids(cells, "table_cell")) replaceKid(c, ["uuid", K.newUuid()]);
  dropKid(node, "instances");
  return node;
}
