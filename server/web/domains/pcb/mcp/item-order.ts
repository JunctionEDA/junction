// mcp/item-order — the order KiCad's writers put a file's items in, for the fold (compact.ts) to put a new item where
// KiCad's next save would put it instead of after the last item:
//   schematic  SCH_IO_KICAD_SEXPR::Format: one multiset ordered by Type() (include/core/typeinfo.h's KICAD_T order),
//              then m_Uuid
//   board      PCB_IO_KICAD_SEXPR::format( BOARD* ): footprints (BOARD_ITEM::ptr_cmp), drawings (BOARD::cmp_drawings),
//              points (PCB_POINT::cmp_points), tracks and vias (PCB_TRACK::cmp_tracks), zones, groups, generators
//              (ptr_cmp), each set in that sequence
// Nodes are the parsed s-expressions (millimetres); positions compare in internal units (nm) as KiCad's do.

type Node = unknown[];
const isList = Array.isArray;
const kid = (n: Node, k: string): Node | null => { for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === k) return c as Node; } return null; };
const kids = (n: Node, k: string): Node[] => n.filter((c, j) => j > 0 && isList(c) && c[0] === k) as Node[];
const s = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown): number => { const x = typeof v === "number" ? v : parseFloat(s(v)); return isFinite(x) ? x : 0; };
/** KiROUND: half away from zero */
const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
const iu = (mm: unknown): number => kiRound(num(mm) * 1e6);
const uuidOf = (n: Node): string => { const u = kid(n, "uuid") || kid(n, "tstamp"); return s(u ? u[1] : "").toLowerCase(); };
/** KIID::operator<: the 16 bytes compared in order, which is the hex text compared without the dashes */
export const cmpUuid = (a: string, b: string): number => { const x = a.replace(/-/g, ""), y = b.replace(/-/g, ""); return x < y ? -1 : x > y ? 1 : 0; };
const sign = (d: number): number => (d < 0 ? -1 : d > 0 ? 1 : 0);

// ---------------------------------------------------------------- schematic
/** KICAD_T order of the schematic's top-level items (SCH_SHAPE_T .. SCH_TEXTBOX_T sit before SCH_MARKER_T) */
const SCH_RANK: Record<string, number> = {
  rectangle: 0, circle: 0, arc: 0, bezier: 0, ellipse: 0, ellipse_arc: 0,            // SCH_SHAPE_T
  text: 2, text_box: 3,                                                                // SCH_TEXT_T, SCH_TEXTBOX_T
  junction: 11, no_connect: 12, bus_entry: 13, wire: 15, bus: 15,                     // SCH_JUNCTION_T .. SCH_LINE_T
  image: 16, table: 17, label: 19, global_label: 20, hierarchical_label: 21, rule_area: 22,
  directive_label: 23, netclass_flag: 23, symbol: 24, group: 25, sheet: 27,
};
/** The KICAD_T rank of a schematic item; a (polyline …) of two points is an SCH_LINE (a graphic line), else an SCH_SHAPE. */
export function schRank(n: Node): number | null {
  const h = s(n[0]);
  if (h === "polyline") { const pts = kid(n, "pts"); return pts && kids(pts, "xy").length === 2 ? SCH_RANK.wire : SCH_RANK.rectangle; }
  return h in SCH_RANK ? SCH_RANK[h] : null;
}
/** SCH_IO_KICAD_SEXPR::Format's cmp: Type(), then m_Uuid.  Null when either is not an item the multiset holds. */
export function schCompare(a: Node, b: Node): number | null {
  const ra = schRank(a), rb = schRank(b); if (ra === null || rb === null) return null;
  return ra !== rb ? sign(ra - rb) : cmpUuid(uuidOf(a), uuidOf(b));
}

// ---------------------------------------------------------------- board
/** Which of PCB_IO_KICAD_SEXPR::format's sets an item is in, in the order they are written. */
export function pcbBlock(n: Node): number | null {
  switch (s(n[0])) {
    case "footprint": return 0;
    case "gr_line": case "gr_rect": case "gr_circle": case "gr_arc": case "gr_poly": case "gr_curve": case "gr_ellipse": case "gr_ellipse_arc": case "gr_bbox":
    case "image": case "gr_text": case "gr_text_box": case "table": case "barcode": case "dimension": case "target": case "grid_item": return 1;
    case "point": return 2;
    case "segment": case "arc": case "via": return 3;
    case "zone": return 4;
    case "group": return 5;
    case "generated": return 6;
    default: return null;
  }
}
/** The board's layer ids by name (its (layers …) table) and its net codes by name, for the comparators. */
export interface BoardOrderCtx {
  layerId(name: string): number; netCode(n: Node): number;
  /** a (layers …) entry as ids: "*.Cu", "F&B.Cu" name several */ layerIds?(name: string): number[];
  /** a board item by uuid (a group's or generator's members) */ nodeById?(id: string): Node | null;
  /** the board's copper layer ids from the top of the stack down (F.Cu, In1.Cu … B.Cu) */ copperStack?: number[];
  /** BOARD_DESIGN_SETTINGS m_TentViasFront / m_TentViasBack */ tentVias?: [boolean, boolean];
  /** the file version the stored items were read at (EDA_TEXT::MigrateLegacyBoldStrokeWidth before 20260826) */ version?: number;
}
/** PCB_LAYER_ID of a canonical layer name (include/layer_ids.h), whatever numbering the file's (layers …) table uses. */
export function canonicalLayerId(name: string): number | null {
  const F: Record<string, number> = { "F.Cu": 0, "B.Cu": 2, "F.Mask": 1, "B.Mask": 3, "F.SilkS": 5, "B.SilkS": 7, "F.Adhes": 9, "B.Adhes": 11, "F.Paste": 13, "B.Paste": 15,
    "Dwgs.User": 17, "Cmts.User": 19, "Eco1.User": 21, "Eco2.User": 23, "Edge.Cuts": 25, "Margin": 27, "B.CrtYd": 29, "F.CrtYd": 31, "B.Fab": 33, "F.Fab": 35, "Rescue": 37 };
  if (name in F) return F[name];
  let m = /^In(\d+)\.Cu$/.exec(name); if (m && +m[1] >= 1 && +m[1] <= 30) return 2 + 2 * +m[1];
  m = /^User\.(\d+)$/.exec(name); if (m && +m[1] >= 1 && +m[1] <= 45) return 37 + 2 * +m[1];
  return null;
}
const DIM_TYPE: Record<string, number> = { aligned: 0, leader: 1, center: 2, radial: 3, orthogonal: 4 };
/** KICAD_T order of the drawings: PCB_SHAPE_T, PCB_REFERENCE_IMAGE_T, PCB_TEXT_T, PCB_TEXTBOX_T, PCB_TABLE_T, PCB_BARCODE_T, the dimensions, PCB_TARGET_T, PCB_GRID_ITEM_T */
function drawingType(n: Node): number {
  const h = s(n[0]);
  if (/^gr_(line|rect|circle|arc|poly|curve|ellipse|ellipse_arc|bbox)$/.test(h)) return 0;
  if (h === "image") return 1; if (h === "gr_text") return 2; if (h === "gr_text_box") return 3; if (h === "table") return 4; if (h === "barcode") return 5;
  if (h === "dimension") { const t = kid(n, "type"); return 6 + (DIM_TYPE[s(t ? t[1] : "aligned")] ?? 0); }
  if (h === "target") return 11;
  return 12;   // grid_item
}
const layerOf = (n: Node): string => { const l = kid(n, "layer"); return s(l ? l[1] : ""); };
/** LSET::Seq(): the item's layers as ids, ascending ((layers …) with "*.Cu"-style wildcards taken as the board's matching layers) */
function layerSeq(n: Node, ctx: BoardOrderCtx): number[] {
  const ls = kid(n, "layers"), names = ls ? ls.slice(1).map(s) : [layerOf(n)];
  const ids = names.flatMap((x) => (ctx.layerIds ? ctx.layerIds(x) : [ctx.layerId(x)])).filter((x) => x >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}
const cmpSeq = (a: number[], b: number[]): number => { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return sign(a[i] - b[i]); return sign(a.length - b.length); };
/** BOARD_ITEM::ptr_cmp within one set (the same Type()): GetLayerSet().Seq(), then m_Uuid */
function ptrCmp(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const seq = (n: Node): number[] => { const h = s(n[0]); return h === "group" || h === "generated" ? Array.from(itemLayerSet(n, ctx, new Set())).sort((x, y) => x - y) : layerSeq(n, ctx); };
  return cmpSeq(seq(a), seq(b)) || cmpUuid(uuidOf(a), uuidOf(b));
}
const pt = (n: Node | null): [number, number] => (n ? [iu(n[1]), iu(n[2])] : [0, 0]);
const STROKE: Record<string, number> = { default: -1, solid: 0, dash: 1, dot: 2, dash_dot: 3, dash_dot_dot: 4 };
const FILL: Record<string, number> = { no: 1, none: 1, yes: 2, solid: 2, hatch: 5, reverse_hatch: 6, cross_hatch: 7 };
/** The EDA_SHAPE members Compare reads, from a board shape node. */
function shapeOf(n: Node): { shape: number; start: [number, number]; end: [number, number]; radius: number; mid: [number, number]; c1: [number, number]; c2: [number, number]; poly: [number, number][]; width: number; style: number; fill: number; ell: { c: [number, number]; a: number; b: number; rot: number; sa: number; ea: number } } {
  const h = s(n[0]);
  const box = h === "gr_text_box" || h === "table_cell";   // PCB_TEXTBOX: a RECTANGLE, or a POLY when it has (pts …)
  const shape = box ? (kid(n, "pts") ? 4 : 1) : h === "gr_line" ? 0 : h === "gr_rect" ? 1 : h === "gr_arc" ? 2 : h === "gr_circle" ? 3 : h === "gr_poly" ? 4 : h === "gr_curve" ? 5 : h === "gr_ellipse" ? 6 : h === "gr_ellipse_arc" ? 7 : -1;
  const ptsN = kid(n, "pts"), xy = ptsN ? kids(ptsN, "xy").map((p) => pt(p)) : [];
  let start = pt(kid(n, "start")), end = pt(kid(n, "end"));
  // EDA_SHAPE::recalcEllipseArcEndpoints: an ellipse starts at its centre and ends at the major axis' end; an
  // elliptical arc runs between its start and end angles
  const ell = { c: pt(kid(n, "center")), a: iu((kid(n, "major_radius") || [])[1]), b: iu((kid(n, "minor_radius") || [])[1]), rot: num((kid(n, "rotation_angle") || [])[1]),
    sa: num((kid(n, "start_angle") || [])[1]), ea: num((kid(n, "end_angle") || [])[1]) };
  if (shape === 6 || shape === 7) {
    const phi = ell.rot * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    if (shape === 6) { start = ell.c; end = [ell.c[0] + kiRound(ell.a * cp), ell.c[1] + kiRound(ell.a * sp)]; }
    else {
      const ev = (deg: number): [number, number] => { const t = deg * Math.PI / 180, lx = ell.a * Math.cos(t), ly = ell.b * Math.sin(t); return [ell.c[0] + kiRound(lx * cp - ly * sp), ell.c[1] + kiRound(lx * sp + ly * cp)]; };
      start = ev(ell.sa); end = ev(ell.ea);
    }
  }
  if (h === "gr_circle") start = pt(kid(n, "center"));
  if (h === "gr_curve") { start = xy[0] || [0, 0]; end = xy[3] || [0, 0]; }
  const st = kid(n, "stroke"), w = st ? kid(st, "width") : kid(n, "width"), ty = st ? kid(st, "type") : null;
  const f = kid(n, "fill"), fv = f ? (isList(f[1]) ? s((kid(f, "type") || [])[1]) : s(f[1])) : "no";
  const r = kid(n, "radius");
  return { shape, start, end, radius: r ? iu(r[1]) : 0, mid: pt(kid(n, "mid")), c1: h === "gr_curve" ? xy[1] || [0, 0] : [0, 0], c2: h === "gr_curve" ? xy[2] || [0, 0] : [0, 0],
    poly: h === "gr_poly" || (box && shape === 4) ? xy : [], width: w ? iu(w[1]) : 0, style: STROKE[s(ty ? ty[1] : "default")] ?? -1, fill: box ? 1 : FILL[fv] ?? 1, ell };
}
/** EDA_SHAPE::Compare (common/eda_shape.cpp): positions within EPSILON (2 nm) are equal. */
export function shapeCompare(a: Node, b: Node): number {
  const A = shapeOf(a), B = shapeOf(b), E = 2;
  const te = (x: number, y: number): number => (Math.abs(x - y) > E ? sign(x - y) : 0);
  const tp = (p: [number, number], q: [number, number]): number => te(p[0], q[0]) || te(p[1], q[1]);
  let d = tp(A.start, B.start) || tp(A.end, B.end) || sign(A.shape - B.shape); if (d) return d;
  if (A.shape === 1) d = sign(A.radius - B.radius);
  else if (A.shape === 2) d = tp(A.mid, B.mid);
  else if (A.shape === 5) d = tp(A.c1, B.c1) || tp(A.c2, B.c2);
  else if (A.shape === 6 || A.shape === 7) {
    const tenths = (deg: number): number => kiRound(deg * 10);
    d = tp(A.ell.c, B.ell.c) || te(A.ell.a, B.ell.a) || te(A.ell.b, B.ell.b) || te(tenths(A.ell.rot), tenths(B.ell.rot));
    if (!d && A.shape === 7) d = te(tenths(A.ell.sa), tenths(B.ell.sa)) || te(tenths(A.ell.ea), tenths(B.ell.ea));
  }
  else if (A.shape === 4) d = sign(A.poly.length - B.poly.length);
  if (d) return d;
  for (let i = 0; i < A.poly.length; i++) { d = tp(A.poly[i], B.poly[i]); if (d) return d; }
  return te(A.width, B.width) || sign(A.style - B.style) || sign(A.fill - B.fill);
}
/** BOARD::cmp_drawings: Type(), the layer, the shape's Compare (shapes), then m_Uuid. */
function drawingCompare(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const ta = drawingType(a), tb = drawingType(b); if (ta !== tb) return sign(ta - tb);
  if (ta !== 12) { const la = ctx.layerId(layerOf(a)), lb = ctx.layerId(layerOf(b)); if (la !== lb) return sign(la - lb); }
  let d = 0;
  if (ta === 0) d = shapeCompare(a, b);
  else if (ta === 2) d = textCompare(a, b, ctx);
  else if (ta === 3) d = shapeCompare(a, b) || textCompare(a, b, ctx);
  else if (ta === 4) d = tableCompare(a, b, ctx);
  else if (ta === 5) d = barcodeCompare(a, b);
  if (d) return d;
  return cmpUuid(uuidOf(a), uuidOf(b));
}

// ---------------------------------------------------------------- texts, tables, barcodes
/** wxString::Cmp: code point order */
function cmpStr(a: string, b: string): number {
  const x = Array.from(a), y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const p = x[i].codePointAt(0)!, q = y[i].codePointAt(0)!; if (p !== q) return sign(p - q); }
  return sign(x.length - y.length);
}
/** parseMaybeAbsentBool( true ): a bare token, or (key yes) */
const flag = (n: Node | null, key: string): boolean => { if (!n) return false; const k = kid(n, key); if (k) return k.length < 2 || s(k[1]) === "yes"; return n.some((c, j) => j > 0 && c === key); };
/** What EDA_TEXT::Compare reads of a board text (PCB_IO_KICAD_SEXPR_PARSER::parseEDA_TEXT), from its node. */
function edaText(n: Node, ctx: BoardOrderCtx): { face: string; sx: number; sy: number; stroke: number; angle: number; spacing: number; h: number; v: number; italic: number; bold: number; mirror: number; x: number; y: number; href: string; text: string } {
  const h = s(n[0]), box = h === "gr_text_box" || h === "table_cell";
  const ef = kid(n, "effects"), font = ef ? kid(ef, "font") : null, just = ef ? kid(ef, "justify") : null;
  const face = font && kid(font, "face") ? s(kid(font, "face")![1]) : "";
  const size = font ? kid(font, "size") : null;
  // no (effects): the EDA_TEXT default (DEFAULT_SIZE_TEXT, 50 mils); (effects) without a size: 60 mils (1.524 mm)
  const sy = size ? iu(size[1]) : ef ? 1524000 : 1270000, sx = size ? iu(size.length > 2 ? size[2] : size[1]) : sy;
  const bold = flag(font, "bold") ? 1 : 0;
  let stroke = font && kid(font, "thickness") ? iu(kid(font, "thickness")![1]) : 0;
  // EDA_TEXT::MigrateLegacyBoldStrokeWidth, in a board read before 20260826
  if (ctx.version && ctx.version > 0 && ctx.version < 20260826 && bold && stroke > 1 && (!face || face === "KiCad Font" || face === "Default Font")) stroke = Math.max(2, kiRound(stroke / 1.6));
  const ls = font ? kid(font, "line_spacing") : null;
  const js = just ? just.slice(1).map(s) : [];
  // parseEDA_TEXT starts every text at centre / centre; a text box with no (effects) keeps its own left / centre
  const H = js.includes("left") ? -1 : js.includes("right") ? 1 : box && !ef ? -1 : 0, V = js.includes("top") ? -1 : js.includes("bottom") ? 1 : 0;
  const at = kid(n, "at"), ang = box ? kid(n, "angle") : null;
  const href = ef && kid(ef, "href") ? s(kid(ef, "href")![1]) : "";
  return { face, sx, sy, stroke, angle: box ? num(ang ? ang[1] : 0) : num(at ? at[3] : 0), spacing: ls ? num(ls[1]) : 1, h: H, v: V, italic: flag(font, "italic") ? 1 : 0, bold,
    mirror: js.includes("mirror") ? 1 : 0,
    // a text box's EDA_TEXT position is never set by the parser (PCB_TEXTBOX draws from its box)
    x: box || !at ? 0 : iu(at[1]), y: box || !at ? 0 : iu(at[2]), href, text: s(h === "table_cell" || h === "gr_text_box" || h === "gr_text" ? n[1] : "") };
}
/** EDA_TEXT::Compare: TEXT_ATTRIBUTES::Compare (font, size, width, angle, line spacing, alignment, italic, bold,
 *  underline, colour, mirror, multiline, keep upright: the last four are the same for every board text of a type),
 *  then the position, the font name, the hyperlink and the text. */
export function textCompare(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const A = edaText(a, ctx), B = edaText(b, ctx);
  return cmpStr(A.face, B.face) || sign(A.sx - B.sx) || sign(A.sy - B.sy) || sign(A.stroke - B.stroke) || sign(A.angle - B.angle) || sign(A.spacing - B.spacing)
    || sign(A.h - B.h) || sign(A.v - B.v) || sign(A.italic - B.italic) || sign(A.bold - B.bold) || sign(A.mirror - B.mirror)
    || sign(A.x - B.x) || sign(A.y - B.y) || cmpStr(A.face, B.face) || cmpStr(A.href, B.href) || cmpStr(A.text, B.text);
}
/** PCB_TABLE::Compare: cell count, columns and their widths, rows and their heights, then each cell's shape and text. */
export function tableCompare(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const T = (n: Node) => {
    const cellsN = kid(n, "cells"), cells = cellsN ? kids(cellsN, "table_cell") : [];
    const cols = Math.max(0, Math.trunc(num((kid(n, "column_count") || [])[1])));
    const cw = kid(n, "column_widths"), rh = kid(n, "row_heights");
    const rows = cols ? Math.trunc(cells.length / cols) : 0;
    return { cells, cols, rows, cw: (j: number) => (cw && j + 1 < cw.length ? iu(cw[j + 1]) : 0), rh: (j: number) => (rh && j + 1 < rh.length ? iu(rh[j + 1]) : 0) };
  };
  const A = T(a), B = T(b);
  let d = sign(A.cells.length - B.cells.length) || sign(A.cols - B.cols); if (d) return d;
  for (let c = 0; c < A.cols; c++) { d = sign(A.cw(c) - B.cw(c)); if (d) return d; }
  d = sign(A.rows - B.rows); if (d) return d;
  for (let r = 0; r < A.rows; r++) { d = sign(A.rh(r) - B.rh(r)); if (d) return d; }
  for (let r = 0; r < A.rows; r++) for (let c = 0; c < A.cols; c++) {
    const x = A.cells[r * A.cols + c], y = B.cells[r * B.cols + c]; if (!x || !y) continue;
    d = shapeCompare(x, y) || textCompare(x, y, ctx); if (d) return d;
  }
  return 0;
}
const BARCODE_KIND: Record<string, number> = { code39: 0, code128: 1, datamatrix: 2, qr: 3, microqr: 4 };
const BARCODE_ECC: Record<string, number> = { L: 1, M: 2, Q: 3, H: 4 };
/** PCB_BARCODE::Compare: position, text, width, height, text height, kind, angle (tenths), error correction. */
export function barcodeCompare(a: Node, b: Node): number {
  const B = (n: Node) => {
    const at = kid(n, "at"), sz = kid(n, "size"), ty = kid(n, "type"), ecc = kid(n, "ecc_level"), tx = kid(n, "text"), th = kid(n, "text_height");
    return { x: at ? iu(at[1]) : 0, y: at ? iu(at[2]) : 0, text: s(tx ? tx[1] : ""), w: sz ? iu(sz[1]) : 0, h: sz ? iu(sz[2]) : 0, th: th ? iu(th[1]) : 0,
      kind: BARCODE_KIND[s(ty ? ty[1] : "qr")] ?? 3, angle: kiRound(num(at ? at[3] : 0) * 10), ecc: BARCODE_ECC[s(ecc ? ecc[1] : "L")] ?? 1 };
  };
  const A = B(a), C = B(b);
  return sign(A.x - C.x) || sign(A.y - C.y) || cmpStr(A.text, C.text) || sign(A.w - C.w) || sign(A.h - C.h) || sign(A.th - C.th) || sign(A.kind - C.kind) || sign(A.angle - C.angle) || sign(A.ecc - C.ecc);
}

// ---------------------------------------------------------------- layer sets of groups and generators
/** BOARD_ITEM::GetLayerSet of a board item (its overrides: PCB_VIA, PCB_GROUP, PCB_GENERATOR, PCB_GRID_ITEM, ZONE …). */
function itemLayerSet(n: Node, ctx: BoardOrderCtx, seen: Set<Node>): Set<number> {
  const h = s(n[0]); const out = new Set<number>();
  const ids = (name: string): number[] => (ctx.layerIds ? ctx.layerIds(name) : [ctx.layerId(name)]).filter((x) => x >= 0);
  if (h === "group" || h === "generated") {
    if (seen.has(n)) return out; seen.add(n);
    const m = kid(n, "members");
    if (m && ctx.nodeById) for (const id of m.slice(1)) { const it = ctx.nodeById(s(id)); if (it) for (const l of itemLayerSet(it, ctx, seen)) out.add(l); }
    if (h === "generated") for (const l of ids(layerOf(n))) out.add(l);   // PCB_GENERATOR: | LSET( { GetLayer() } )
    return out;
  }
  if (h === "grid_item") { for (let l = 0; l < 128; l++) out.add(l); return out; }   // LSET::AllLayersMask()
  if (h === "via") return viaLayerSet(n, ctx);
  if (h === "footprint") { for (const l of ids(layerOf(n))) out.add(l); return out; }
  const ls = kid(n, "layers"), names = ls ? ls.slice(1).map(s) : layerOf(n) ? [layerOf(n)] : [];
  for (const nm of names) for (const l of ids(nm)) out.add(l);
  return out;
}
/** PCB_VIA::GetLayerSet: the copper layers it spans (all of them for a through via), and the mask of an outer side it
 *  is not tented on. */
function viaLayerSet(n: Node, ctx: BoardOrderCtx): Set<number> {
  const out = new Set<number>(), stack = ctx.copperStack || [0, 2];
  const ls = kid(n, "layers"), names = ls ? ls.slice(1).map(s) : [];
  const through = !n.some((c, j) => j > 0 && (c === "blind" || c === "buried" || c === "micro"));
  if (through) for (const l of stack) out.add(l);
  else {
    const at = names.map((nm) => stack.indexOf(ctx.layerId(nm))).filter((x) => x >= 0);
    if (at.length) { const lo = Math.min(...at), hi = Math.max(...at); for (let i = lo; i <= hi; i++) out.add(stack[i]); }
  }
  // PCB_VIA::IsTented: the via's own (tenting …) side, else the board's
  const t = kid(n, "tenting"); let front: boolean | null = null, back: boolean | null = null;
  if (t) {
    if (t.slice(1).every((c) => !isList(c))) { for (const c of t.slice(1)) { if (c === "front") front = true; else if (c === "back") back = true; else if (c === "none") { front = null; back = null; } } }
    else for (const key of ["front", "back"]) { const v = kid(t, key); const x = v ? s(v[1]) : "none"; const b = x === "yes" ? true : x === "no" ? false : null; if (key === "front") front = b; else back = b; }
  }
  const tent = ctx.tentVias || [true, true];
  if (!(front ?? tent[0]) && out.has(0)) out.add(1);
  if (!(back ?? tent[1]) && out.has(2)) out.add(3);
  return out;
}
/** PCB_TRACK::cmp_tracks: net code, layer, Type() (PCB_TRACE_T, PCB_VIA_T, PCB_ARC_T), m_Uuid */
function trackCompare(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const T: Record<string, number> = { segment: 0, via: 1, arc: 2 };
  const la = (n: Node): number => (s(n[0]) === "via" ? ctx.layerId(s((kid(n, "layers") || [])[1])) : ctx.layerId(layerOf(n)));
  return sign(ctx.netCode(a) - ctx.netCode(b)) || sign(la(a) - la(b)) || sign((T[s(a[0])] ?? 0) - (T[s(b[0])] ?? 0)) || cmpUuid(uuidOf(a), uuidOf(b));
}
/** PCB_POINT::cmp_points: layer, x, y, size, m_Uuid */
function pointCompare(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const pa = pt(kid(a, "at")), pb = pt(kid(b, "at")), sz = (n: Node): number => { const z = kid(n, "size"); return z ? iu(z[1]) : 0; };
  return sign(ctx.layerId(layerOf(a)) - ctx.layerId(layerOf(b))) || sign(pa[0] - pb[0]) || sign(pa[1] - pb[1]) || sign(sz(a) - sz(b)) || cmpUuid(uuidOf(a), uuidOf(b));
}
/** The order of two items of the same set (pcbBlock): the set's comparator. */
export function pcbCompare(a: Node, b: Node, ctx: BoardOrderCtx): number {
  const blk = pcbBlock(a);
  if (blk === 1) return drawingCompare(a, b, ctx);
  if (blk === 2) return pointCompare(a, b, ctx);
  if (blk === 3) return trackCompare(a, b, ctx);
  return ptrCmp(a, b, ctx);
}

/**
 * Where each new item goes among the stored ones: before the first stored item of its set that the comparator puts
 * after it, else after the last stored item of its set, else after the last item of the sets before it, else before
 * the first item of the sets after it (`stored` are the stored items in file order: their index in the file and node).
 * Returns, per new item, the file index to insert before, or -1 for "after the last stored item"; the caller orders
 * new items that share a place by the same comparator.
 */
export function placeFresh(stored: { at: number; node: () => Node | null }[], fresh: Node[], block: (n: Node) => number | null, cmp: (a: Node, b: Node) => number): { before: number; node: Node }[] {
  const blocks = stored.map((x) => { const n = x.node(); return n ? block(n) : null; });
  const out: { before: number; node: Node }[] = [];
  for (const f of fresh) {
    const fb = block(f); if (fb === null) { out.push({ before: -1, node: f }); continue; }
    let before = -1, lastSame = -1, lastBelow = -1, firstAbove = -1;
    for (let i = 0; i < stored.length; i++) {
      const b = blocks[i]; if (b === null) continue;
      if (b === fb) { const n = stored[i].node(); if (n && cmp(f, n) < 0) { before = stored[i].at; break; } lastSame = i; }
      else if (b < fb) lastBelow = i;
      else if (firstAbove < 0) firstAbove = i;
    }
    if (before < 0) {
      const after = lastSame >= 0 ? lastSame : lastBelow;
      // just after `after`: before the next stored item, if there is one
      if (after >= 0) before = after + 1 < stored.length ? stored[after + 1].at : -1;
      else if (firstAbove >= 0) before = stored[firstAbove].at;
    }
    out.push({ before, node: f });
  }
  return out;
}
