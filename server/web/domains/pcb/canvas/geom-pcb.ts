// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/domains/pcb/canvas/index.ts — edit these modules, not the bundle).
import { HOLE_WALL as HOLE_WALL_COLOR, NPTH, PAD_TEXT, PAD_TEXT_DARK, PCB_BG, VIA_HOLE, Z_PAD, Z_TEXT, Z_VIA, Z_ZONE, padLayers, pcbColor, pcbZ } from "./colors";
import { G, bboxAdd, textLines } from "./geom";
import { expandDocVars, hatchGeom, roundRectPts } from "./geom-sch";
import { expandTextVars, hasTextVars } from "./sheet";
import { arcFrom3, atOf, bezierPts, dashOf, effectsOf, faceOf, ellipsePts, fillOf, has, isList, justOf, kid, kids, netOf, num, pointInPoly, polyPtsOf, rotPt, rotator, str, widthOf, yesNo } from "./sexpr";
import { buildImageGeom, buildTableGeom } from "./tables-images";
import { inflate, stadium, union } from "../fab/poly";
import { arcPoints, circlePoints } from "../fab/prims";
import { parseMarkup, textWidth, unescapeText } from "./text";
import { linebreakText } from "./stroke-font";
import { code128, code39 } from "./barcode";
import { barcode2D } from "./barcode2d";
import type { Doc, Geom, GeomSink, Item, Pt, PadGeom, PolyGeom, TextEffects, TextExtra, TextGeom, Tf } from "./types";

/** A (render_cache …) node with the text state trackedRenderCache noted on it (non-enumerable). */
type RenderCacheNode = SNode & { __state?: { sig: string; x: number; y: number } };
// ---- board ----
/**
 * Net code of a board item.  Files up to 2025 carry (net N) or (net N "name"); KiCad 10 names the net only —
 * (net "GND") — and has no net table, so those get a code from the document's own table, assigned on first
 * sight (doc.nets: code → name, doc.netCodes: name → code).  No net / the empty name is 0, a missing node -1.
 */
export function netCode(doc: Pick<Doc, "nets" | "netCodes" | "netSeq"> | null | undefined, node: SNode | null | undefined): number {
  const nn = node && kid(node, "net"); if (!nn) return -1;
  const v = nn[1];
  if (typeof v === "number") { if (nn.length > 2 && doc && doc.nets && !doc.nets.has(v)) doc.nets.set(v, str(nn[2])); return v; }
  const name = str(v); if (!name) return 0;
  if (!doc || !doc.nets) return -1;
  const codes = doc.netCodes || (doc.netCodes = new Map());
  let c = codes.get(name);
  if (c === undefined) {
    let next = doc.netSeq || 0; if (!next) for (const k of doc.nets.keys()) if (k > next) next = k;
    c = next + 1; doc.netSeq = c; codes.set(name, c); doc.nets.set(c, name);
  }
  return c;
}

const DISPLAY_NAMES = new Map<string, string>();
/** NETINFO_ITEM::GetDisplayNetname: the short net name (after the last sheet-path slash), unescaped ({slash} → /). */
export function displayNetName(name: string | null | undefined): string {
  if (!name) return "";
  let v = DISPLAY_NAMES.get(name);
  if (v === undefined) {
    const i = name.lastIndexOf("/");
    v = unescapeText(i >= 0 ? name.slice(i + 1) : name);
    if (DISPLAY_NAMES.size > 20000) DISPLAY_NAMES.clear();
    DISPLAY_NAMES.set(name, v);
  }
  return v;
}

/** PrintableCharCount: the characters of a marked-up string that take room (markup braces and tabs do not). */
export function printableCharCount(t: string): number { return parseMarkup(t.replace(/\t/g, "")).text.length; }

export function layerOf(node: SNode, def: string): string {
  const l = kid(node, "layer"); if (l) return str(l[1]);
  // a copper shape that also opens the solder mask is written (layers "F.Cu" "F.Mask"): its own layer comes first
  const ls = kid(node, "layers"); return ls && ls.length > 1 ? str(ls[1]) : def;
}

export function padCopperLayer(pad: SNode): string | null {
  const ls = kid(pad, "layers"); const names = ls ? ls.slice(1).map(str) : [];
  if (names.some((x) => x === "F.Cu" || x === "*.Cu" || x === "F&B.Cu")) return "F.Cu";
  if (names.some((x) => x === "B.Cu")) return "B.Cu";
  const inner = names.find((x) => /\.Cu$/.test(x)); return inner || null;
}

/**
 * Board text.  Hidden text (fp_text / property with hide yes) is not part of item.geom or the bbox: it is kept
 * in item.hiddenGeom tagged hiddenText, drawn only under the showHiddenText render option.  Knockout text
 * ((layer "F.Cu" knockout) or (knockout yes)) is tagged knockout: the painter fills the text box, inflated by
 * GetKnockoutTextMargin = max(pen/2, size/9), in the layer colour and cuts the glyphs out of it.
 */
/**
 * The outlines stored with a text, kept true to the text across edits made here.  They are in board coordinates
 * and only KiCad can redraw them, so the first build notes what the text looked like; a later build that finds
 * the text only moved (itself, or with its footprint) moves the outlines with it — EDA_TEXT::Offset — and one
 * that finds anything else changed drops them — EDA_TEXT::ClearRenderCache — so a stale shape is never plotted
 * or saved.  KiCad draws them again the next time it opens the board.
 */
function trackedRenderCache(n: SNode, x: number, y: number, sig: string): SNode | null {
  const rc = kid(n, "render_cache") as RenderCacheNode | null; if (!rc) return null;
  const st = rc.__state;
  if (!st) { Object.defineProperty(rc, "__state", { value: { sig, x, y }, enumerable: false }); return rc; }
  if (st.sig !== sig) { n.splice(n.indexOf(rc), 1); return null; }
  const dx = x - st.x, dy = y - st.y;
  if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
    for (const poly of rc) if (Array.isArray(poly) && poly[0] === "polygon") for (const pts of poly) if (Array.isArray(pts) && pts[0] === "pts")
      for (const q of pts) if (Array.isArray(q) && q[0] === "xy") { q[1] = Math.round((num(q[1]) + dx) * 1e6) / 1e6; q[2] = Math.round((num(q[2]) + dy) * 1e6) / 1e6; }
    st.x = x; st.y = y;
  }
  return rc;
}

export function pcbTextGeom(item: Item, n: SNode, x: number, y: number, text: string, rot: number, layer: string, extra?: TextExtra | null): TextGeom | null {
  const ef = effectsOf(n); if (!text) return null;
  const color = pcbColor(layer); const z = pcbZ(layer) + (/\.Cu$/.test(layer) ? 0 : Z_TEXT);   // GAL_LAYER_ORDER: a copper layer's text is on the layer itself, under its pads and vias
  // EDA_TEXT::GetEffectiveTextPenWidth.  A bold stroke text draws 1.6 × its stored width (BOLD_STROKE_MULTIPLIER);
  // files from before 20260826 stored the bold width itself, which the parser divides back on load.
  const boldStroke = ef.bold && !ef.face && ef.thick > 0;
  const attrW = boldStroke && boardVersion > 0 && boardVersion < 20260826 ? ef.thick / 1.6 : ef.thick;
  const thick = ef.thick > 0 ? (boldStroke ? attrW * 1.6 : ef.thick) : (ef.bold ? ef.sizeX / 5 : ef.sizeX / 8);
  const ln = kid(n, "layer"); const knockout = (ln && has(ln, "knockout")) || yesNo(n, "knockout");
  // a knockout text is laid out with the stored width and drawn with the effective one (PCB_TEXT::TransformTextToPolySet)
  const ex: TextExtra = Object.assign({ z, w: thick, mirror: ef.mirror, pcb: true, italic: ef.italic, ...faceOf(ef), sizeX: ef.sizeX, lineSpacing: ef.lineSpacing }, knockout ? { knockout: true, layoutW: attrW } : null, extra || {});
  // (render_cache "text" angle (polygon …) …): the outlines KiCad drew this text with in an outline font, in board
  // coordinates.  A plot uses them as pcbnew does (the font itself cannot be read here); the screen draws the face.
  // outlines belong to a text in an outline font: one put back in the KiCad font loses them (pcbnew writes none)
  if (!ef.face) { const stale = kid(n, "render_cache"); if (stale) n.splice(n.indexOf(stale), 1); }
  const rc = ef.face ? trackedRenderCache(n, x, y, JSON.stringify([text, rot || 0, ef.size, ef.sizeX, ef.just, ef.bold, ef.italic, ef.face, layer])) : null;
  if (ef.hide) {
    const shadow: GeomSink = { geom: [], bbox: null }; textLines(shadow, x, y, text, ef.size, color, rot, ef.just, layer, ex);
    for (const g of shadow.geom) g.hiddenText = true;
    if (shadow.geom.length) (item.hiddenGeom = item.hiddenGeom || []).push(...shadow.geom);
    return null;
  }
  if (rc) ex.outline = { node: rc, x, y, rot: rot || 0, shown: text, upright: !!ex.upright };
  if (ef.face) {
    ex.block = { x, y, rot: rot || 0, text, upright: !!ex.upright };
    // the node the text is written in (not enumerable: the record still copies to a worker), for serializeItem's outlines
    Object.defineProperty(ex.block, "node", { value: n, enumerable: false });
  }
  const first = textLines(item, x, y, text, ef.size, color, rot, ef.just, layer, ex);
  if (first && ef.face) first.outlineFirst = true;
  return first;
}

/** The file version of the board being built (0 when unknown): some rules changed with the format. */
let boardVersion = 0;

/**
 * A track or arc with (layers "F.Cu" "F.Mask"): PCB_TRACK::m_hasSolderMask on an outer layer opens the mask along it,
 * the width grown by GetSolderMaskExpansion (its own solder_mask_margin, else the board's, not below −width / 2) on
 * each side (PCB_PAINTER::draw( PCB_TRACK / PCB_ARC ) on the mask layer).
 */
function trackMaskGeom(item: Item, n: SNode, layer: string): void {
  const ls = kid(n, "layers"); if (!ls) return;
  const mask = layer === "F.Cu" ? "F.Mask" : layer === "B.Cu" ? "B.Mask" : null; if (!mask || !ls.slice(1).map(str).includes(mask)) return;
  const src = item.geom[item.geom.length - 1]; const w = src.w || 0;
  const mm = kid(n, "solder_mask_margin"); let m = mm ? num(mm[1]) : boardMaskSetup(curDoc).maskExp;
  if (m < 0) m = Math.max(m, -w / 2);
  G(item, Object.assign({}, src, { layer: mask, color: pcbColor(mask), z: pcbZ(mask), w: w + 2 * m, track: undefined, trackMask: true, maskCopy: true, net: undefined, _p: undefined, _bb: undefined }) as Geom);
}

export function buildPcbGeom(doc: Doc, item: Item): void {
  boardVersion = (doc && doc.version) || 0; curDoc = doc || null;
  const n = item.node, k = item.kind;
  if (k === "segment") {
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return; const layer = layerOf(n, "F.Cu"); const net = netCode(doc, n); item.net = net;
    G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net });
    trackMaskGeom(item, n, layer);
  } else if (k === "arc") {
    const s = kid(n, "start"), m = kid(n, "mid"), e = kid(n, "end"); if (!s || !m || !e) return; const layer = layerOf(n, "F.Cu"); const net = netCode(doc, n); item.net = net;
    const a = arcFrom3([num(s[1]), num(s[2])], [num(m[1]), num(m[2])], [num(e[1]), num(e[2])]);
    if (a) { G(item, Object.assign({ t: "arc" as const, w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net }, a)); trackMaskGeom(item, n, layer); }
    else G(item, { t: "line", x1: num(s[1]), y1: num(s[2]), x2: num(e[1]), y2: num(e[2]), w: widthOf(n, 0.25), color: pcbColor(layer), layer, z: pcbZ(layer), cap: "round", track: true, net });
  } else if (k === "via") {
    buildViaGeom(doc, item, n);
  } else if (k === "zone") {
    buildZoneGeom(doc, item, n);
  } else if (k === "gr_line" || k === "gr_rect" || k === "gr_circle" || k === "gr_arc" || k === "gr_poly" || k === "gr_curve" || k === "gr_ellipse" || k === "gr_ellipse_arc") {
    graphicGeom(item, n, k.replace("gr_", ""), (x: number, y: number) => [x, y], layerOf(n, "Dwgs.User"));
  } else if (k === "point") {
    pointGeom(item, n, (x: number, y: number) => [x, y]);
  } else if (k === "barcode") {
    barcodeGeom(item, n, (x: number, y: number) => [x, y], 0);
  } else if (k === "gr_text") {
    const [x, y, rot] = atOf(n); const tl = layerOf(n, "Dwgs.User"); pcbTextGeom(item, n, x, y, doc && doc.fpEditor ? fpEditorVars(doc, str(n[1]), tl) : expandDocVars(doc, str(n[1]).replace(/\$\{LAYER\}/g, tl)), rot, tl, { dxfText: { bold: !!effectsOf(n).bold } });
  } else if (k === "gr_text_box") {
    buildTextBoxGeom(item, n, (x: number, y: number) => [x, y], layerOf(n, "Dwgs.User"), 0);
  } else if (k === "dimension") {
    buildDimensionGeom(item, n);
  } else if (k === "target") {
    const [x, y] = atOf(n); const layer = layerOf(n, "Edge.Cuts"); const color = pcbColor(layer); const z = pcbZ(layer);
    const sizeN = kid(n, "size"); const size = sizeN ? num(sizeN[1]) : 5; const w = widthOf(n, 0.15);
    const xShape = has(n, "x"); const R = rotator(xShape ? 45 : 0);
    const arm = xShape ? 2 * size / 3 : size / 2, r = xShape ? size / 2 : size / 3;
    for (const [a, b] of [[[-arm, 0], [arm, 0]], [[0, -arm], [0, arm]]]) { const p = R(a[0], a[1]), q = R(b[0], b[1]); G(item, { t: "line", x1: x + p[0], y1: y + p[1], x2: x + q[0], y2: y + q[1], w, color, layer, z }); }
    G(item, { t: "circle", x, y, r, w, color, layer, z });
  } else if (k === "footprint") {
    buildFootprintGeom(doc, item);
  } else if (k === "pad" && doc && doc.fpEditor) {
    // the Footprint Editor: a pad is an item of its own, in the frame of the footprint at the origin
    const [x, y, rot] = atOf(n); item.x = x; item.y = y; item.rot = rot; item.layer = padCopperLayer(n) || "F.Cu";
    buildPadGeom(item, n, (px: number, py: number) => [px, py], "F.Cu", doc, 0);
  } else if (k === "property" && doc && doc.fpEditor) {
    buildFieldGeom(doc, item);
  } else if (k === "table") {
    buildTableGeom(doc, item, n);
  } else if (k === "image") {
    buildImageGeom(doc, item, n);
  }
  // groups, gr_bbox, generated items: nothing to draw
}

// m_HoleWallThickness (0.020 mm) × m_HoleWallPaintingMultiplier (1.5): how wide the plating is painted
export const HOLE_WALL = 0.020 * 1.5;

/** Pad label colour on a copper layer: the netname layer colour, inverted on bright copper (PCB_RENDER_SETTINGS::LoadColors). */
export function padNameColor(layer: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(pcbColor(layer)); if (!m) return PAD_TEXT;
  const v = parseInt(m[1], 16); const br = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
  return br > 0.5 ? PAD_TEXT_DARK : PAD_TEXT;
}

/** The board's (setup …) values the painter reads: solder mask expansion, paste margin and ratio, via tenting (BOARD_DESIGN_SETTINGS). */
export interface BoardMaskSetup { maskExp: number; pasteMargin: number; pasteRatio: number; tentFront: boolean; tentBack: boolean }
const NO_SETUP: BoardMaskSetup = { maskExp: 0, pasteMargin: 0, pasteRatio: 0, tentFront: true, tentBack: true };
const SETUP_CACHE = new WeakMap<object, BoardMaskSetup>();
export function boardMaskSetup(doc: Pick<Doc, "setupNode"> | null | undefined): BoardMaskSetup {
  const s = doc && doc.setupNode; if (!s) return NO_SETUP;
  let v = SETUP_CACHE.get(s); if (v) return v;
  const val = (k: string) => { const c = kid(s, k); return c ? num(c[1]) : 0; };
  // (tenting front back) / (tenting (front yes) (back no)): m_TentViasFront / Back are front / back .value_or( false ); no token keeps true
  const t = kid(s, "tenting"); const [tf, tb] = t ? frontBackOpt(s, "tenting") : [true, true];
  v = { maskExp: val("pad_to_mask_clearance"), pasteMargin: val("pad_to_paste_clearance"), pasteRatio: val("pad_to_paste_clearance_ratio"), tentFront: tf ?? false, tentBack: tb ?? false };
  SETUP_CACHE.set(s, v); return v;
}
/** PCB_IO_KICAD_SEXPR_PARSER::parseFrontBackOptBool: (key (front yes) (back no)), or the legacy (key front back) / (key none). */
export function frontBackOpt(node: SNode, key: string): [boolean | undefined, boolean | undefined] {
  const n = kid(node, key); if (!n) return [undefined, undefined];
  let front: boolean | undefined, back: boolean | undefined;
  for (let j = 1; j < n.length; j++) {
    const c = n[j];
    if (isList(c)) { const v = str(c[1]); const b = v === "yes" ? true : v === "no" ? false : undefined; if (c[0] === "front") front = b; else if (c[0] === "back") back = b; }
    else if (c === "front") front = true; else if (c === "back") back = true; else if (c === "none") { front = undefined; back = undefined; }
  }
  return [front, back];
}
/**
 * PADSTACK::UnconnectedLayerMode of a via or plated pad: KEEP_ALL, REMOVE_EXCEPT_START_AND_END (remove_unused_layers
 * with keep_end_layers), REMOVE_ALL (remove_unused_layers alone) or START_END_ONLY (vias: start_end_only).
 */
export function unusedLayerMode(n: SNode): "keep" | "exceptEnds" | "all" | "startEnd" {
  if (yesNo(n, "start_end_only")) return "startEnd";
  if (!yesNo(n, "remove_unused_layers")) return "keep";
  return yesNo(n, "keep_end_layers") ? "exceptEnds" : "all";
}
/** BOARD_STACKUP::GetLayerDistance between two copper layers (mm), from the board's stackup or BuildDefaultStackupList. */
export function stackupLayerDistance(doc: Doc, a: string, b: string): number {
  if (a === b) return 0;
  const items: { layer: string | null; th: number }[] = [];
  const st = doc.setupNode ? kid(doc.setupNode, "stackup") : null;
  if (st) for (const l of kids(st, "layer")) {
    const name = str(l[1]), diel = /^dielectric \d+$/.test(name); if (!diel && !/\.Cu$/.test(name)) continue;
    let th = 0; for (let j = 2; j < l.length; j++) { const c = l[j]; if (isList(c) && c[0] === "thickness") th += num(c[1], 0); }
    items.push({ layer: diel ? null : name, th });
  }
  if (!items.length) {
    const inner = (doc.copper || []).filter((l) => /^In\d+\.Cu$/.test(l)).sort((p, q) => parseInt(p.slice(2), 10) - parseInt(q.slice(2), 10));
    const stack = ["F.Cu", ...inner, "B.Cu"], nn = stack.length;
    const gn = doc.generalNode, thick = gn && kid(gn, "thickness") ? num(kid(gn, "thickness")![1], 1.6) : 1.6;
    const diel = (thick - 0.035 * nn - 0.01 * 2) / Math.max(1, nn - 1);
    stack.forEach((l, i) => { items.push({ layer: l, th: 0.035 }); if (i < nn - 1) items.push({ layer: null, th: diel }); });
  }
  const ia = items.findIndex((it) => it.layer === a), ib = items.findIndex((it) => it.layer === b); if (ia < 0 || ib < 0) return 0;
  const first = ia < ib ? a : b, second = ia < ib ? b : a, outer = (l: string) => l === "F.Cu" || l === "B.Cu";
  let total = 0, start = false;
  for (const it of items) {
    let half = false;
    if (!start && it.layer === first) { start = true; if (!outer(first)) half = true; } else if (!start) continue;
    if (it.layer === second && !outer(second)) half = true;
    total += half ? it.th / 2 : it.th;
    if (it.layer === second) break;
  }
  return total;
}
/** PADSTACK::PostMachiningKnockout on a copper layer: the counterbore / countersink diameter there, 0 below its depth. */
export function postMachiningKnockout(doc: Doc, n: SNode, layer: string): number {
  let best = 0;
  for (const [key, surface] of [["front_post_machining", "F.Cu"], ["back_post_machining", "B.Cu"]]) {
    const pm = kid(n, key); if (!pm) continue; const mode = str(pm[1]); if (mode !== "counterbore" && mode !== "countersink") continue;
    const size = num((kid(pm, "size") || [])[1], 0); if (!(size > 0)) continue;
    const angle = num((kid(pm, "angle") || [])[1], 0); const tapered = mode === "countersink" && angle > 0;
    const tanHalf = tapered ? Math.tan(angle * Math.PI / 360) : 0;
    let depth = num((kid(pm, "depth") || [])[1], 0);
    if (depth <= 0 && tapered) depth = (size / 2) / tanHalf;
    if (depth <= 0) continue;
    const dist = stackupLayerDistance(doc, surface, layer); if (dist >= depth) continue;
    best = Math.max(best, Math.max(0, size - 2 * dist * tanHalf));
  }
  return best;
}
/**
 * PCB_PAINTER::drawBackdrillIndicator / drawPostMachiningIndicator: a circle of 12 equal dashes and gaps, radius r − w / 2,
 * w = max( r / 16, 2 outline widths ) (the painter's hairline floor gives the 2 px); a backdrill draws every other dash
 * (the tertiary drill the other ones), a post-machining indicator all twelve.
 */
function dashedCircle(item: Item, x: number, y: number, diameter: number, color: string, layer: string, z: number, offset: number, step: number, extra: Partial<Geom>): void {
  const R = diameter / 2, w = R / 16, r = R - w / 2, da = Math.PI * 2 / 24;
  for (let i = offset; i < 12; i += step) G(item, Object.assign({ t: "arc" as const, x, y, r, a0: da * i * 2, a1: da * (i * 2 + 1), anticlockwise: false, w, color, layer, z, cap: "butt", indicator: true }, extra));
}
/** (backdrill (size s) (layers start end)) / (tertiary_drill …): the drill size and the layer it must cut. */
function extraDrill(n: SNode, key: string): { size: number; end: string } | null {
  const d = kid(n, key); if (!d) return null;
  const s = kid(d, "size"), ls = kid(d, "layers"); const size = s ? num(s[1], 0) : 0;
  return size > 0 && ls && ls.length > 2 ? { size, end: str(ls[2]) } : null;
}

export function buildViaGeom(doc: Doc, item: Item, n: SNode): void {
  const [x, y] = atOf(n); const sz = kid(n, "size"), dr = kid(n, "drill"); const size = sz ? num(sz[1]) : 0.8, drill = dr ? num(dr[1]) : 0.4;
  const vtype = has(n, "blind") ? "blind" : has(n, "buried") ? "buried" : has(n, "micro") ? "micro" : "through";
  const ls = kid(n, "layers"); const pair = ls ? [str(ls[1]), str(ls[2])] : ["F.Cu", "B.Cu"];
  const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  let layers = copper;
  if (vtype !== "through") { const i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[1]); if (i0 >= 0 && i1 >= 0) layers = copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1); else layers = pair; }
  const net = netCode(doc, n); item.net = net;
  // Padstack().Drill().start / end: the outer layers of the span
  const start = layers[0], end = layers[layers.length - 1];
  // PCB_VIA::FlashLayer: KEEP_ALL flashes every layer, START_END_ONLY the two ends, REMOVE_EXCEPT_START_AND_END the
  // ends and REMOVE_ALL none for sure; the others flash only where something connects (or zone_layer_connections forces it)
  const mode = unusedLayerMode(n); const zlc = kid(n, "zone_layer_connections"); const forced = new Set(zlc ? zlc.slice(1).map(str) : []);
  const unusedSet = new Set<string>();
  for (const layer of layers) {
    const isEnd = layer === start || layer === end;
    if (mode === "startEnd" && !isEnd) continue;
    const unused = (mode === "all" || (mode === "exceptEnds" && !isEnd)) && !forced.has(layer);
    if (unused) { item.unusedFlash = true; unusedSet.add(layer); }
    G(item, { t: "circle", x, y, r: size / 2, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_VIA, via: true, net, viaSize: size, viaType: vtype, viaLayers: pair, viaLabel: layer === layers[0] || undefined, unusedLayer: unused || undefined });
  }
  // PCB_VIA::IsOnLayer( F_Mask / B_Mask ): an outer via that is not tented opens the mask, a circle of its size grown by
  // the board's solder mask expansion (PCB_PAINTER::draw( PCB_VIA ), always filled)
  const bs = boardMaskSetup(doc); const [tf, tb] = frontBackOpt(n, "tenting");
  for (const [cu, mask, tented] of [["F.Cu", "F.Mask", tf ?? bs.tentFront], ["B.Cu", "B.Mask", tb ?? bs.tentBack]] as [string, string, boolean][]) {
    if ((cu === "F.Cu" ? start : end) !== cu || tented) continue;
    G(item, { t: "circle", x, y, r: size / 2 + bs.maskExp, w: 0, color: pcbColor(mask), fill: pcbColor(mask), layer: mask, z: pcbZ(mask) + 0.5, via: true, viaMask: true, net, viaSize: size });
  }
  const zh = pcbZ("holes");
  // LAYER_VIA_HOLEWALLS: the plating, a ring just outside the drill clamped to the via's copper.  It rides on
  // the hole geometry (wallR / wallColor) and is painted right under it, so a via stays rings + hole.
  const wallR = Math.min(drill / 2 + HOLE_WALL, size / 2); const wall = wallR > drill / 2 ? { wallR, wallColor: HOLE_WALL_COLOR } : null;
  // the via's span (and type) on its hole: ViewGetLOD hides a blind / buried / micro via's hole with every layer it crosses
  const span = { viaType: vtype, viaLayers: pair, viaSpan: layers };
  // viaHoleShowsLayerPair: blind and buried vias, and a micro via that is not F.Cu–B.Cu, show their layer pair in the hole
  if (!(vtype === "blind" || vtype === "buried" || (vtype === "micro" && (pair[0] !== "F.Cu" || pair[1] !== "B.Cu")))) G(item, Object.assign({ t: "circle" as const, x, y, r: drill / 2, w: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, via: true, hole: true, net }, wall, span));
  else {
    // top-colour upper half, bottom-colour lower half
    G(item, Object.assign({ t: "arc" as const, x, y, r: drill / 2, a0: Math.PI, a1: 2 * Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[0]), fill: pcbColor(pair[0]), layer: "holes", z: zh, pie: true, via: true, hole: true, net }, wall, span));
    G(item, Object.assign({ t: "arc" as const, x, y, r: drill / 2, a0: 0, a1: Math.PI, anticlockwise: false, w: 0, color: pcbColor(pair[1]), fill: pcbColor(pair[1]), layer: "holes", z: zh, pie: true, via: true, hole: true, net }, span));
  }
  // backdrill indicators with the hole wall (in the colour of the layer the drill must cut), post-machining ones on the
  // copper layers they reach, drawn with the via's ring there
  const back = [extraDrill(n, "backdrill"), extraDrill(n, "tertiary_drill")];
  back.forEach((b, i) => { if (b) dashedCircle(item, x, y, b.size, pcbColor(b.end), "holes", zh + 0.001, i, 2, { via: true, net, viaSpan: layers, viaType: vtype, viaLayers: pair }); });
  if (kid(n, "front_post_machining") || kid(n, "back_post_machining")) for (const layer of layers) {
    if (mode === "startEnd" && layer !== start && layer !== end) continue;
    const k = postMachiningKnockout(doc, n, layer); if (k > 0) dashedCircle(item, x, y, k, pcbColor(layer), layer, pcbZ(layer) + Z_VIA + 0.001, 0, 1, { via: true, net, unusedLayer: unusedSet.has(layer) || undefined });
  }
  item.viaType = vtype;
}

export function buildZoneGeom(doc: Doc, item: Item, n: SNode): void {
  const single = kid(n, "layer"); const multi = kid(n, "layers");
  let layersZ = single ? [str(single[1])] : multi ? multi.slice(1).map(str) : ["F.Cu"];
  layersZ = padLayers(doc, layersZ);
  const keepout = !!kid(n, "keepout");
  const hatchN = kid(n, "hatch"); const hatchStyle = hatchN ? str(hatchN[1]) : "edge"; const pitch = hatchN ? num(hatchN[2], 0.5) : 0.5;
  const net = netCode(doc, n); if (item.kind === "zone") item.net = net;
  // (connect_pads [yes|no|thru_hole_only] (clearance c)): the copper clearance the fill keeps from other nets (0.5 mm default)
  const cp = kid(n, "connect_pads"); const clN = cp && kid(cp, "clearance"); const clearance = clN ? num(clN[1], 0.5) : 0.5;
  const unfilled = !keepout && !kids(n, "filled_polygon").length;
  // (attr (teardrop (type padvia))): ZONE::IsTeardropArea — PCB_PAINTER draws it with the track opacity
  const attr = kid(n, "attr"), td = attr && kid(attr, "teardrop") ? { teardrop: true } : null;
  for (const poly of kids(n, "polygon")) {
    const p = polyPtsOf(poly); if (p.length < 2) continue;
    for (const layer of layersZ) {
      // a rule area's outline is on its layer itself (under a copper layer's pads and vias), a zone's on LAYER_ZONE_START
      const color = pcbColor(layer); const z = pcbZ(layer) + (keepout ? (/\.Cu$/.test(layer) ? 0 : Z_TEXT) : 0.5);
      G<PolyGeom>(item, keepout ? { t: "poly", pts: p, close: true, w: 0, color, layer, z, ruleArea: true } : { t: "poly", pts: p, close: true, w: 0, color, layer, z, zoneOutline: true, net, zoneClearance: clearance, zoneUnfilled: unfilled, ...td });
      if (hatchStyle !== "none" && pitch > 0) {
        // ZONE::HatchBorder: short diagonal ticks along the border (edge) or full diagonals (full); slope by layer parity
        const info = doc.layers.get(layer); const slope = info && (info.id & 1) ? 1 : -1;
        const segs = hatchLines(p, slope, hatchStyle === "full" ? pitch * 2 : pitch, hatchStyle === "full" ? -1 : pitch);
        for (const s of segs) G(item, { t: "line", x1: s[0], y1: s[1], x2: s[2], y2: s[3], w: 0, color, layer, z, zoneHatch: true, ruleArea: keepout || undefined });
      }
    }
  }
  if (keepout) return;   // rule areas have no fill
  for (const fp of kids(n, "filled_polygon")) {
    const layer = layerOf(fp, layersZ[0]); const p = polyPtsOf(fp); if (p.length < 3) continue;
    G(item, { t: "poly", pts: p, close: true, w: 0, color: pcbColor(layer), fill: pcbColor(layer), layer, z: pcbZ(layer) + Z_ZONE, noStroke: true, zoneFill: true, net, ...td });
  }
}

/** SHAPE_POLY_SET::GenerateHatchLines for one outline: lines y = slope·x + a every `spacing`, clipped to the polygon. */
export function hatchLines(pts: Pt[], slope: number, spacing: number, lineLen: number): number[][] {
  const out: number[][] = []; if (pts.length < 3) return out;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const maxA = slope > 0 ? maxY - slope * minX : maxY - slope * maxX, minA0 = slope > 0 ? minY - slope * maxX : minY - slope * minX;
  const minA = Math.floor(minA0 / spacing) * spacing;
  if ((maxA - minA) / spacing > 4000) return out;   // pathological: skip rather than stall
  const buf: Pt[] = [];
  for (let a = minA; a < maxA; a += spacing) {
    buf.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const x1 = pts[j][0], y1 = pts[j][1], x2 = pts[i][0], y2 = pts[i][1];
      // intersection of segment with the line y = slope·x + a
      const den = (y2 - y1) - slope * (x2 - x1); if (Math.abs(den) < 1e-12) continue;
      const t = (slope * x1 + a - y1) / den; if (t < 0 || t > 1) continue;
      const x = x1 + t * (x2 - x1), y = y1 + t * (y2 - y1);
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      buf.push([x, y]);
    }
    if (buf.length > 2) buf.sort((p, q) => q[0] - p[0]);
    for (let i = 0; i + 1 < buf.length; i++) {
      const p1 = buf[i], p2 = buf[i + 1]; if (Math.abs(p1[0] - p2[0]) < 1e-9 && Math.abs(p1[1] - p2[1]) < 1e-9) continue;
      if (!pointInPoly(pts, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)) continue;
      let dx = p2[0] - p1[0];
      if (lineLen === -1 || Math.abs(dx) < 2 * lineLen) out.push([p1[0], p1[1], p2[0], p2[1]]);
      else {
        const sl = (p2[1] - p1[1]) / dx; dx = dx > 0 ? lineLen : -lineLen;
        out.push([p1[0], p1[1], p1[0] + dx, p1[1] + dx * sl]); out.push([p2[0], p2[1], p2[0] - dx, p2[1] - dx * sl]);
      }
    }
  }
  return out;
}

/** PCB_PAINTER::draw(PCB_POINT): an X of the point's size in LAYER_POINTS and a ring of half that in the layer colour. */
export function pointGeom(item: Item, n: SNode, tf: Tf): void {
  const at = kid(n, "at"); if (!at) return; const [x, y] = tf(num(at[1]), num(at[2]));
  const sz = kid(n, "size"), size = (sz ? num(sz[1]) : 1) / 2, layer = layerOf(n, "F.SilkS"), z = pcbZ(layer) + 0.9, w = 0.01;
  for (const [dx, dy] of [[1, 1], [1, -1]]) G(item, { t: "line", x1: x - size * dx, y1: y - size * dy, x2: x + size * dx, y2: y + size * dy, w, color: POINT_COLOR, layer, z, cap: "butt", point: true });
  G(item, { t: "circle", x, y, r: size / 2, w, color: pcbColor(layer), layer, z, point: true });
}
export const POINT_COLOR = "#FF26E2";   // LAYER_POINTS (builtin_color_themes.h)

/**
 * PCB_BARCODE: the symbol scaled to (size w h) and centred on (at x y), its text under it (1 mm gap, text_height),
 * the knockout box inflated by its margins (at least 10 % of the smaller side), all turned by the angle about the
 * position.  Code 39 / Code 128 bars are encoded as Zint encodes them (barcode.ts), QR / Micro QR / Data Matrix
 * modules as barcode2d.ts encodes them.
 */
export function barcodeGeom(item: Item, n: SNode, tf: Tf, frot: number): void {
  const at = kid(n, "at"); if (!at) return;
  const [px, py] = tf(num(at[1]), num(at[2])); const rot = num(at[3]) + (frot || 0);
  const sz = kid(n, "size"), W = sz ? num(sz[1]) : 5, H = sz ? num(sz[2], W) : 5; if (!(W > 0) || !(H > 0)) return;
  const layer = layerOf(n, "F.SilkS"), color = pcbColor(layer), z = pcbZ(layer);
  const text = str((kid(n, "text") || [])[1] || ""), th = num((kid(n, "text_height") || [])[1], 1.5);
  const type = str((kid(n, "type") || [])[1] || "code39"), showText = !yesNo(n, "hide"), knockout = yesNo(n, "knockout");
  const back = /^B\./.test(layer), mx = back ? -1 : 1;   // side-specific: mirrored on the back
  const R = rotator(rot); const P = (x: number, y: number): Pt => { const [dx, dy] = R(mx * x, y); return [px + dx, py + dy]; };
  const rects: number[][] = [];   // symbol modules, in the barcode's frame (centred)
  if (type === "code39" || type === "code128") {
    const bc = type === "code39" ? code39(text) : code128(text);
    if (bc) for (const [a, b] of bc.bars) rects.push([-W / 2 + W * a / bc.modules, -H / 2, -W / 2 + W * b / bc.modules, H / 2]);
  } else {
    // QR / Micro QR / Data Matrix: the module matrix, each row's dark runs as one rectangle
    const ecc = Math.max(0, "LMQH".indexOf(str((kid(n, "ecc_level") || [])[1] || "L")));
    const m = barcode2D(type, text, ecc);
    if (m && m.rows) {
      const nr = m.rows.length, nc = m.rows[0].length;
      m.rows.forEach((row, y) => {
        for (let x = 0; x < nc;) {
          if (!row[x]) { x++; continue; }
          let e = x; while (e < nc && row[e]) e++;
          rects.push([-W / 2 + W * x / nc, -H / 2 + H * y / nr, -W / 2 + W * e / nc, -H / 2 + H * (y + 1) / nr]);
          x = e;
        }
      });
    }
  }
  let y1 = H / 2;
  const textY = H / 2 + 1;
  if (showText && text) y1 = textY + th;
  if (knockout) {
    const minSide = Math.min(W, H), m = Math.max(Math.ceil(minSide * 0.1 / 0.1 - 1e-9) * 0.1, 0);
    const mg = kid(n, "margins"), ml = Math.max(mg ? num(mg[1]) : 0, m), mt = Math.max(mg ? num(mg[2]) : 0, m);
    G(item, { t: "poly", pts: [P(-W / 2 - ml, -H / 2 - mt), P(W / 2 + ml, -H / 2 - mt), P(W / 2 + ml, y1 + mt), P(-W / 2 - ml, y1 + mt)], close: true, w: 0, color, fill: color, layer, z, noStroke: true });
  }
  const ink = knockout ? PCB_BG : color;
  for (const [x0, y0, x2, y2] of rects) G(item, { t: "poly", pts: [P(x0, y0), P(x2, y0), P(x2, y2), P(x0, y2)], close: true, w: 0, color: ink, fill: ink, layer, z: z + 0.01, noStroke: true });
  if (showText && text) {
    const [tx, ty] = P(0, textY);
    textLines(item, tx, ty, text, th, ink, rot, ["center", "top"], layer, { pcb: true, z: z + 0.01, w: th * 0.15, mirror: back || undefined });
  }
}

export function graphicGeom(item: Item, g: SNode, shape: string, tf: Tf, layer: string, z?: number): void {
  const first = item.geom ? item.geom.length : 0;
  graphicShapeGeom(item, g, shape, tf, layer, z);
  // (layers "F.Cu" "F.Mask") (solder_mask_margin m): the shape also opens the mask, grown by the margin (plotting)
  const ls = kid(g, "layers"); const mask = ls && ls.slice(1).map(str).find((l) => /\.Mask$/.test(l));
  if (!mask || !item.geom) return;
  const mm = kid(g, "solder_mask_margin");
  const last = item.geom.length;
  for (let i = first; i < last; i++) { item.geom[i].maskLayer = mask; if (mm) item.geom[i].maskMargin = num(mm[1]); }
  // PCB_SHAPE::ViewGetLayers: a shape with solder mask on an outer copper layer is drawn on that side's mask layer too,
  // its line GetSolderMaskExpansion × 2 wider, solid, a hatched fill filled solid (PCB_PAINTER::draw( PCB_SHAPE ))
  const maskL = layer === "F.Cu" ? "F.Mask" : layer === "B.Cu" ? "B.Mask" : null; if (!maskL) return;
  const w = widthOf(g, 0), solid = fillOf(g).type === "solid", hatched = !!hatchFillOf(g);
  let margin = mm ? num(mm[1]) : boardMaskSetup(curDoc).maskExp;
  if (margin < 0 && !solid) margin = Math.max(margin, -w / 2);
  const color = pcbColor(maskL), mz = pcbZ(maskL);
  for (let i = first; i < last; i++) {
    const s0 = item.geom[i]; if (s0.hatchLine) continue;
    const c: Geom = Object.assign({}, s0, { layer: maskL, color, z: mz, w: (s0.w || 0) + margin * 2, maskCopy: true, dash: undefined, dashType: undefined, maskLayer: undefined, maskMargin: undefined, netSeg: undefined, _p: undefined, _bb: undefined }) as Geom;
    if (s0.fill || ((solid || hatched) && (s0.t === "poly" || s0.t === "circle") && (s0.t !== "poly" || s0.close))) { c.fill = color; c.noStroke = c.w <= 0; }
    G(item, c);
  }
}
/** (fill hatch) / (fill reverse_hatch) / (fill cross_hatch): FILL_T::HATCH, REVERSE_HATCH, CROSS_HATCH. */
function hatchFillOf(g: SNode): string | null {
  const f = kid(g, "fill"); if (!f) return null;
  const t = kid(f, "type"); const v = t ? str(t[1]) : has(f, "hatch") ? "hatch" : has(f, "reverse_hatch") ? "reverse_hatch" : has(f, "cross_hatch") ? "cross_hatch" : "";
  return v === "hatch" || v === "reverse_hatch" || v === "cross_hatch" ? v : null;
}
/** The board a geometry is being built for (buildPcbGeom): board-level settings the shape builders read. */
let curDoc: Doc | null = null;
function graphicShapeGeom(item: Item, g: SNode, shape: string, tf: Tf, layer: string, z: number | undefined): void {
  const first = item.geom ? item.geom.length : 0;
  graphicShapeGeom0(item, g, shape, tf, layer, z);
  // the records of a PCB_SHAPE: the Objects opacity rules tell a shape from other filled geometry by this tag
  if (item.geom) for (let i = first; i < item.geom.length; i++) item.geom[i].gfxShape = true;
}
function graphicShapeGeom0(item: Item, g: SNode, shape: string, tf: Tf, layer: string, z: number | undefined): void {
  const w = widthOf(g, 0); const color = pcbColor(layer); z = z === undefined ? pcbZ(layer) : z;
  if (layer === "Edge.Cuts") item.edge = true;   // board outline: what "fit" and the board box mean
  const f = fillOf(g); const fillColor = f.type === "solid" ? color : null; const ds = dashOf(g);
  // EDA_SHAPE::UpdateHatching: (fill hatch | reverse_hatch | cross_hatch) on a rectangle, circle, closed polygon or full ellipse
  const hatched = !!hatchFillOf(g) && w > 0, hatch = (outline: Pt[]) => { if (hatched) hatchGeom(item, outline, hatchFillOf(g) as string, w, color, layer, z!, true); };
  // a copper segment with a net carries its net name like a track (PCB_PAINTER::draw( PCB_SHAPE ) netname layer)
  const netTag = shape === "line" && /\.Cu$/.test(layer) && kid(g, "net") && item.kind === g[0] ? (() => { const nc = netCode(curDoc, g); return nc > 0 ? { net: nc, netSeg: true } : null; })() : null;
  if (shape === "line") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return; const a = tf(num(s[1]), num(s[2])), b = tf(num(e[1]), num(e[2]));
    G(item, Object.assign({ t: "line" as const, x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, color, layer, z, cap: "round" }, ds, netTag));
  } else if (shape === "rect") {
    const s = kid(g, "start"), e = kid(g, "end"); if (!s || !e) return;
    const x0 = num(s[1]), y0 = num(s[2]), x1 = num(e[1]), y1 = num(e[2]);
    // (radius r): GetCornerRadius() > 0 makes a ROUNDRECT for painting, hatching and hit testing (eda_shape.cpp:816-819)
    const rad = num((kid(g, "radius") || [])[1], 0);
    const pts = rad > 0 ? roundRectPts(x0, y0, x1, y1, rad, 0.005).map(([x, y]) => tf(x, y)) : [tf(x0, y0), tf(x1, y0), tf(x1, y1), tf(x0, y1)];
    // dashed: the pattern restarts on each side and each corner arc (makeEffectiveShapes' SHAPE_SEGMENTs / SHAPE_ARCs)
    const dashBreaks = pts.length === 4 ? [0, 1, 2, 3] : [0, 1, 2, 3].flatMap((k) => [k * pts.length / 4, (k + 1) * pts.length / 4 - 1]);
    G(item, Object.assign({ t: "poly" as const, pts, close: true, w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0, dashBreaks }, ds));
    hatch(pts);
  } else if (shape === "circle") {
    const c = kid(g, "center"), e = kid(g, "end"); if (!c) return; const [cx, cy] = tf(num(c[1]), num(c[2]));
    const r = e ? Math.hypot(num(e[1]) - num(c[1]), num(e[2]) - num(c[2])) : num((kid(g, "radius") || [])[1], 1);
    G(item, Object.assign({ t: "circle" as const, x: cx, y: cy, r, w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 }, ds));
    if (hatched) hatch(circlePoints(cx, cy, r) as Pt[]);
  } else if (shape === "arc") {
    const s = kid(g, "start"), m = kid(g, "mid"), e = kid(g, "end"); if (!s || !m || !e) return;
    const a = arcFrom3(tf(num(s[1]), num(s[2])), tf(num(m[1]), num(m[2])), tf(num(e[1]), num(e[2])));
    if (a) G(item, Object.assign({ t: "arc" as const, w, color, layer, z, cap: "round" }, a, ds));
    else { const p0 = tf(num(s[1]), num(s[2])), p1 = tf(num(e[1]), num(e[2])); G(item, Object.assign({ t: "line" as const, x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1], w, color, layer, z, cap: "round" }, ds)); }
  } else if (shape === "ellipse" || shape === "ellipse_arc") {
    const e = ellipsePts(g, false); if (!e) return; const p = e.pts.map(([x, y]) => tf(x, y));
    G(item, Object.assign({ t: "poly" as const, pts: p, close: e.closed, w, color, fill: e.closed ? fillColor : null, layer, z, noStroke: !!fillColor && w <= 0 }, ds));
    if (e.closed && shape === "ellipse") hatch(p);
  } else if (shape === "poly" || shape === "curve") {
    let p = polyPtsOf(g).map(([x, y]) => tf(x, y)); if (p.length < 2) return;
    if (shape === "curve") p = bezierPts(p);
    // a polygon's edges are separate SHAPE_SEGMENTs (the dash restarts at each vertex); a curve is one line chain
    G(item, Object.assign({ t: "poly" as const, pts: p, close: shape === "poly", w, color, fill: fillColor, layer, z, noStroke: !!fillColor && w <= 0 }, shape === "poly" ? { dashBreaks: p.map((_, i) => i) } : {}, ds));
    if (shape === "poly") hatch(p);
  }
}

export function buildTextBoxGeom(item: Item, n: SNode, tf: Tf, layer: string, rotBase: number): void {
  const ef = effectsOf(n); if (ef.hide) return;
  // the file holds the library box and angle (a footprint's own rotation added on top): the angle is the text's
  const angN = kid(n, "angle"); const libAng = angN ? num(angN[1]) : 0; const ang = libAng + rotBase;
  let pts = polyPtsOf(n).map(([x, y]) => tf(x, y));
  if (pts.length < 4) {
    // PCB_TEXTBOX::GetCornersInSequence: the axis-aligned (left, top) (right, top) (right, bottom) (left, bottom),
    // turned about the box's centre by the text angle
    const s = kid(n, "start"), e = kid(n, "end"); if (!s || !e) return;
    const l = Math.min(num(s[1]), num(e[1])), r = Math.max(num(s[1]), num(e[1])), t = Math.min(num(s[2]), num(e[2])), b = Math.max(num(s[2]), num(e[2]));
    const cx = (l + r) / 2, cy = (t + b) / 2, R = rotator(((libAng % 360) + 360) % 360);
    pts = [[l, t], [r, t], [r, b], [l, b]].map(([x, y]) => { const [dx, dy] = R(x - cx, y - cy); return tf(cx + dx, cy + dy); });
  }
  const w = widthOf(n, 0); const color = pcbColor(layer); const z = pcbZ(layer);
  if (yesNo(n, "border") || w > 0) G(item, Object.assign({ t: "poly" as const, pts, close: true, w, color, layer, z }, dashOf(n)));
  const mg = kid(n, "margins"); const dm = w / 2 + ef.size * 0.75;
  const lm = mg ? num(mg[1]) : dm, tm = mg ? num(mg[2], lm) : dm, rm = mg ? num(mg[3], lm) : dm, bm = mg ? num(mg[4], tm) : dm;
  // PCB_TEXTBOX::GetDrawPos: the corner / edge mid-point matching the justification (file default centre / centre),
  // moved in by the margins along the box's own axes
  const j = justOf(ef.just); const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const anchor = j.v === "top" ? (j.h === "left" ? pts[0] : j.h === "right" ? pts[1] : mid(pts[0], pts[1]))
    : j.v === "bottom" ? (j.h === "left" ? pts[3] : j.h === "right" ? pts[2] : mid(pts[3], pts[2]))
    : (j.h === "left" ? mid(pts[0], pts[3]) : j.h === "right" ? mid(pts[1], pts[2]) : mid(pts[0], pts[2]));
  const ex = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], ey = [pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]];
  const el = Math.hypot(ex[0], ex[1]) || 1, yl = Math.hypot(ey[0], ey[1]) || 1;
  const ox = j.h === "left" ? lm : j.h === "right" ? -rm : 0, oy = j.v === "top" ? tm : j.v === "bottom" ? -bm : 0;
  // PCB_TEXTBOX::GetShownText: wrapped to the box's first edge less the side margins, with the effective pen
  const col = el - lm - rm;
  const pen = ef.thick > 0 ? ef.thick : (ef.bold ? ef.size / 5 : ef.size / 8);
  pcbTextGeom(item, n, anchor[0] + ex[0] / el * ox + ey[0] / yl * oy, anchor[1] + ex[1] / el * ox + ey[1] / yl * oy, linebreakText(unescapeText(str(n[1])), col, ef.sizeX, pen, ef.italic), ang, layer);
}

/** PCB_DIMENSION_BASE: its geometry, each record tagged as a dimension's (the sketch graphics mode reads it). */
export function buildDimensionGeom(item: Item, n: SNode): void {
  const from = item.geom.length; buildDimensionShapes(item, n);
  for (let i = from; i < item.geom.length; i++) item.geom[i].dim = true;
}
function buildDimensionShapes(item: Item, n: SNode): void {
  const typeN = kid(n, "type"); const type = typeN ? str(typeN[1]) : "aligned";
  const layer = layerOf(n, "Dwgs.User"); const color = pcbColor(layer); const z = pcbZ(layer);
  const pts = polyPtsOf(n); if (pts.length < 2) return;
  const style = kid(n, "style") || []; const thick = num((kid(style, "thickness") || [])[1], 0.15); const arrowLen = num((kid(style, "arrow_length") || [])[1], 1.27);
  const extH = num((kid(style, "extension_height") || [])[1], 0.58586), extOff = num((kid(style, "extension_offset") || [])[1], 0);
  const inward = str((kid(style, "arrow_direction") || [])[1]) === "inward";
  const gt = kid(n, "gr_text"); const ef: Pick<TextEffects, "size" | "thick" | "just"> = gt ? effectsOf(gt) : { size: 1, thick: 0.15, just: [] };
  const [tx, ty, tr] = gt ? atOf(gt) : [0, 0, 0]; const text = gt ? str(gt[1]) : "";
  const tw = textWidth(parseMarkup(text).text, ef.size, ef.thick), th = ef.size;
  const line = (a: Pt, b: Pt) => G(item, { t: "line", x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: thick, color, layer, z, cap: "round" });
  const arrow = (p: Pt, ang: number, tail: number) => {   // PCB_DIMENSION_BASE::drawAnArrow: two 27.5° barbs (and an optional tail)
    if (tail) { const [dx, dy] = rotPt(tail, 0, -ang); line(p, [p[0] + dx, p[1] + dy]); }
    for (const s of [27.5, -27.5]) { const [dx, dy] = rotPt(arrowLen, 0, -ang + s); line(p, [p[0] + dx, p[1] + dy]); }
  };
  // knock the text box (inflated by size/2 along, pen across) out of a segment
  const knock = (a: Pt, b: Pt, inflY: number) => {
    if (!text) { line(a, b); return; }
    const hw = tw / 2 + ef.size / 2, hh = th / 2 + inflY; const R = rotator(-tr);
    const la = R(a[0] - tx, a[1] - ty), lb = R(b[0] - tx, b[1] - ty);
    let t0 = 0, t1 = 1; const dx = lb[0] - la[0], dy = lb[1] - la[1];
    for (const [p, q] of [[-dx, la[0] + hw], [dx, hw - la[0]], [-dy, la[1] + hh], [dy, hh - la[1]]]) {
      if (Math.abs(p) < 1e-12) { if (q < 0) { line(a, b); return; } continue; }
      const t = q / p; if (p < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    }
    if (t0 >= t1) { line(a, b); return; }
    if (t0 > 0) line(a, [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0]);
    if (t1 < 1) line([a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], b);
  };
  const deg = (v: Pt) => Math.atan2(v[1], v[0]) * 180 / Math.PI;   // EDA_ANGLE( vector ): atan2( y, x ) in the file's frame, which drawAnArrow turns back by
  const [s, e] = pts;
  if (type === "aligned" || type === "orthogonal") {
    const height = num((kid(n, "height") || [])[1], 0); const orientN = kid(n, "orientation"); const ortho = type === "orthogonal";
    const horiz = ortho && num(orientN ? orientN[1] : 0) === 0;
    let ext: Pt; if (ortho) ext = horiz ? [0, 1] : [1, 0]; else { const d = [e[0] - s[0], e[1] - s[1]]; ext = [-d[1], d[0]]; }   // sgn below carries the height's sign (KiCad's Resize(negative))
    const el = Math.hypot(ext[0], ext[1]) || 1; const en = [ext[0] / el, ext[1] / el];
    const extLen = Math.abs(height) - extOff + extH;
    const sgn = height >= 0 ? 1 : -1;
    const cs = [s[0] + sgn * en[0] * Math.abs(height), s[1] + sgn * en[1] * Math.abs(height)];
    const ce = ortho ? (horiz ? [e[0], cs[1]] : [cs[0], e[1]]) : [e[0] + sgn * en[0] * Math.abs(height), e[1] + sgn * en[1] * Math.abs(height)];
    const xn = [sgn * en[0], sgn * en[1]];   // the extension lines run to the crossbar's side: a negative height turns them over
    line([s[0] + xn[0] * extOff, s[1] + xn[1] * extOff], [s[0] + xn[0] * (extOff + extLen), s[1] + xn[1] * (extOff + extLen)]);
    if (ortho) { const e2 = [e[0] - ce[0], e[1] - ce[1]]; const l2 = Math.hypot(e2[0], e2[1]) || 1; const n2 = [e2[0] / l2, e2[1] / l2]; const st = [ce[0] - n2[0] * extH, ce[1] - n2[1] * extH]; line(st, [st[0] + n2[0] * (l2 - extOff + extH), st[1] + n2[1] * (l2 - extOff + extH)]); }
    else line([e[0] + xn[0] * extOff, e[1] + xn[1] * extOff], [e[0] + xn[0] * (extOff + extLen), e[1] + xn[1] * (extOff + extLen)]);
    knock(cs, ce, ortho ? ef.thick : -ef.thick);
    const ang = deg([ce[0] - cs[0], ce[1] - cs[1]]);
    if (inward) { arrow(cs, ang + 180, arrowLen * 2); arrow(ce, ang, arrowLen * 2); } else { arrow(cs, ang, 0); arrow(ce, ang + 180, 0); }
  } else if (type === "leader") {
    const d = [e[0] - s[0], e[1] - s[1]]; const dl = Math.hypot(d[0], d[1]) || 1; const st = [s[0] + d[0] / dl * extOff, s[1] + d[1] / dl * extOff];
    knock(st, e, 2 * ef.thick); arrow(st, deg(d), 0);
    if (text) knock(e, [tx, ty], 2 * ef.thick);
    const frame = str((kid(style, "text_frame") || [])[1]);
    if (text && frame === "1") { const hw = tw / 2 + ef.size / 2, hh = th / 2 + 2 * ef.thick; const R = rotator(tr); const box = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => { const [rx, ry] = R(px, py); return [tx + rx, ty + ry]; }); G(item, { t: "poly", pts: box, close: true, w: thick, color, layer, z }); }
    else if (text && frame === "2") G(item, { t: "circle", x: tx, y: ty, r: tw / 2 + ef.size / 2 - ef.thick / 2, w: thick, color, layer, z });
  } else if (type === "radial") {
    line([s[0], s[1] - arrowLen], [s[0], s[1] + arrowLen]); line([s[0] - arrowLen, s[1]], [s[0] + arrowLen, s[1]]);
    const r = [e[0] - s[0], e[1] - s[1]]; const rl = Math.hypot(r[0], r[1]) || 1; const ll = num((kid(n, "leader_length") || [])[1], 2.54);
    const b = [e[0] + r[0] / rl * ll, e[1] + r[1] / rl * ll];
    knock(e, b, ef.thick); if (text) knock(b, [tx, ty], ef.thick); arrow(e, deg(r), 0);
  } else if (type === "center") {
    const a = [e[0] - s[0], e[1] - s[1]]; line([s[0] - a[0], s[1] - a[1]], [s[0] + a[0], s[1] + a[1]]);
    const [rx, ry] = rotPt(a[0], a[1], -90); line([s[0] - rx, s[1] - ry], [s[0] + rx, s[1] + ry]);
  }
  if (gt) pcbTextGeom(item, gt, tx, ty, text, tr, layer);
}

export function buildFootprintGeom(doc: Doc, item: Item): void {
  const n = item.node;
  const [fx, fy, frot] = atOf(n); const side = layerOf(n, "F.Cu"); const R = rotator(frot);
  const trN = kid(n, "transform"); const scN = trN && kid(trN, "scale"); const sx = scN ? num(scN[1], 1) || 1 : 1, sy = scN ? num(scN[2], 1) || 1 : 1;
  const tf = (lx: number, ly: number): Pt => { const [x, y] = R(lx * sx, ly * sy); return [fx + x, fy + y]; };   // TRANSFORM_TRS: scale, rotate, translate
  item.movable = true; item.x = fx; item.y = fy; item.rot = frot; item.layer = side; item.lib = str(n[1]);
  const props: Record<string, string> = {};
  for (const p of kids(n, "property")) { props[str(p[1])] = str(p[2]); }
  item.ref = props.Reference || ""; item.value = props.Value || "";
  // FOOTPRINT::GetPrivateLayers: on a board a child on one of them is not drawn (PCB_PAINTER::Draw)
  const privN = !(doc && doc.fpEditor) ? kid(n, "private_layers") : null; const priv = privN ? new Set(privN.slice(1).map(str)) : null;
  const expand = (t: string) => expandTextVars(t, (v: string) => (v === "REFERENCE" ? item.ref : v === "VALUE" ? item.value : v === "LAYER" ? side : v === "FOOTPRINT_NAME" ? item.lib : null) as string | null);   // all four set just above
  const textAt = (p: SNode, text: string) => {
    if (!isList(kid(p, "at"))) return;
    const at = kid(p, "at")!; const [px, py, pr] = atOf(p); const layer = layerOf(p, side === "B.Cu" ? "B.SilkS" : "F.SilkS"); const [x, y] = tf(px, py);
    if (priv && priv.has(layer)) return;
    const unlocked = has(at, "unlocked") || yesNo(p, "unlocked");
    const field = p[0] === "property" ? str(p[1]) : p[0] === "fp_text" ? (str(p[1]) === "reference" ? "Reference" : str(p[1]) === "value" ? "Value" : null) : null;
    const dxfText = { bold: !!effectsOf(p).bold };
    const before = item.geom.length;
    const first = pcbTextGeom(item, p, x, y, expand(text), pr, layer, field ? { upright: !unlocked, field, dxfText } : { upright: !unlocked, dxfText });
    if (first) first.textPos = [x, y];
    // PCB_TEXT::ViewGetLOD: a text that is just ${REFERENCE} / ${VALUE} follows the References / Values toggle
    const role = text === "${REFERENCE}" ? "Reference" : text === "${VALUE}" ? "Value" : null;
    if (role && !field) for (let i = before; i < item.geom.length; i++) item.geom[i].varRole = role;
  };
  for (const p of kids(n, "property")) textAt(p, str(p[2]));
  let padIndex = 0;   // index among the footprint's (pad …) children: padAt() reports it and pcb-tools can map it back
  for (let j = 2; j < n.length; j++) {
    const g = n[j]; if (!isList(g)) continue; const gk = g[0];
    if (gk === "fp_line" || gk === "fp_rect" || gk === "fp_circle" || gk === "fp_arc" || gk === "fp_poly" || gk === "fp_curve" || gk === "fp_ellipse" || gk === "fp_ellipse_arc") {
      if (priv && priv.has(layerOf(g, "F.SilkS"))) continue;
      graphicGeom(item, g, gk.replace("fp_", ""), tf, layerOf(g, "F.SilkS"));
    } else if (gk === "point") {
      // files before FIRST_FP_AFFINE_TRANSFORM (20260616) kept a footprint's points in the board frame
      pointGeom(item, g, doc && doc.version > 0 && doc.version < 20260616 ? (x: number, y: number) => [x, y] : tf);
    } else if (gk === "barcode") {
      barcodeGeom(item, g, tf, frot);
    } else if (gk === "fp_text") {
      textAt(g, str(g[2]));
    } else if (gk === "fp_text_box") {
      if (priv && priv.has(layerOf(g, "F.SilkS"))) continue;
      buildTextBoxGeom(item, g, tf, layerOf(g, "F.SilkS"), frot);
    } else if (gk === "pad") {
      buildPadGeom(item, g, tf, side, doc, padIndex++);
    } else if (gk === "dimension") {
      buildDimensionGeom(item, g);   // a footprint's dimension is stored in board coordinates, like its zones
    } else if (gk === "zone") {
      const before = item.geom.length; buildZoneGeom(doc, item, g);
      // ZONE::ViewGetLOD: a footprint's zone hides with LAYER_FOOTPRINTS_FR / _BK by its layers as a pad does
      let zf = false, zb = false; for (let i = before; i < item.geom.length; i++) { const l = item.geom[i].layer; if (/^F\./.test(l)) zf = true; else if (/^B\./.test(l)) zb = true; }
      for (let i = before; i < item.geom.length; i++) { item.geom[i].padFront = zf; item.geom[i].padBack = zb; }
      // files before FIRST_FP_AFFINE_TRANSFORM (20260616) kept a footprint's zone outlines in the board frame
      // (pcb_io_kicad_sexpr_parser.cpp: "Legacy footprint zone outlines were in board frame")
      if (doc && doc.version > 0 && doc.version < 20260616) continue;
      for (let i = before; i < item.geom.length; i++) { const z: Geom = item.geom[i]; if (z.pts) z.pts = z.pts.map(([x, y]) => tf(x, y)); else if (z.t === "line") { const a = tf(z.x1, z.y1), b = tf(z.x2, z.y2); z.x1 = a[0]; z.y1 = a[1]; z.x2 = b[0]; z.y2 = b[1]; } }
    }
  }
  if (!item.bbox) bboxAdd(item, fx, fy, 1);
}

/** The Footprint Editor's text variables: ${REFERENCE}, ${VALUE}, ${FOOTPRINT_NAME}, ${LAYER} as FOOTPRINT::ResolveTextVar answers them there. */
export function fpEditorVars(doc: Doc, text: string, layer: string): string {
  if (!hasTextVars(text)) return text;
  const fields: Record<string, string> = {};
  for (const it of doc.items.values()) if (it.kind === "property") fields[(it.node[0] === "fp_text" ? (it.node[1] === "reference" ? "Reference" : "Value") : str(it.node[1])).toUpperCase()] = str(it.node[2]);
  const name = doc.fpState ? str(doc.fpState.fp[1]) : "";
  return expandTextVars(text, (v: string) => v === "LAYER" ? layer : v === "FOOTPRINT_NAME" ? name : fields[v] !== undefined ? fields[v] : null);
}

/** A footprint field (PCB_FIELD) on its own: the Footprint Editor's Reference, Value and user fields. */
export function buildFieldGeom(doc: Doc, item: Item): void {
  const p = item.node; if (!isList(kid(p, "at"))) return;
  const at = kid(p, "at")!; const [px, py, pr] = atOf(p); const layer = layerOf(p, "F.SilkS");
  const unlocked = has(at, "unlocked") || yesNo(p, "unlocked");
  const field = p[0] === "property" ? str(p[1]) : str(p[1]) === "reference" ? "Reference" : "Value";
  item.x = px; item.y = py; item.rot = pr; item.layer = layer;
  pcbTextGeom(item, p, px, py, fpEditorVars(doc, str(p[2]), layer), pr, layer, { upright: !unlocked, field, dxfText: { bold: !!effectsOf(p).bold } });
}

/** Outline polygon (local, unrotated) for chamfered / trapezoid pads. */
export function padPolygon(pad: SNode, shape: string, w: number, h: number): Pt[] {
  const hw = w / 2, hh = h / 2;
  if (shape === "trapezoid") {
    const d = kid(pad, "rect_delta"); const dx = d ? num(d[1]) : 0, dy = d ? num(d[2]) : 0;
    // TransformTrapezoidToPolygon: delta.x skews the vertical sides, delta.y the horizontal ones
    return [[-hw + dy / 2, -hh - dx / 2], [hw - dy / 2, -hh + dx / 2], [hw + dy / 2, hh - dx / 2], [-hw - dy / 2, hh + dx / 2]];
  }
  // chamfered rect: TransformRoundChamferedRectToPolygon (round corners of the other corners are ignored)
  const ch = kid(pad, "chamfer"); const corners = ch ? ch.slice(1).map(str) : [];
  const ratioN = kid(pad, "chamfer_ratio"); const c = Math.max(0, (ratioN ? num(ratioN[1]) : 0.25) * Math.min(w, h));
  const has_ = (s: string) => corners.includes(s);
  const pts: Pt[] = [];
  if (has_("top_left") && c > 0) pts.push([-hw, -hh + c], [-hw + c, -hh]); else pts.push([-hw, -hh]);
  if (has_("top_right") && c > 0) pts.push([hw - c, -hh], [hw, -hh + c]); else pts.push([hw, -hh]);
  if (has_("bottom_right") && c > 0) pts.push([hw, hh - c], [hw - c, hh]); else pts.push([hw, hh]);
  if (has_("bottom_left") && c > 0) pts.push([-hw + c, hh], [-hw, hh - c]); else pts.push([-hw, hh]);
  return pts;
}

/** A convex outline moved inward by d along each edge (SHAPE_POLY_SET::Deflate of a convex pad polygon). */
function insetConvex(pts: Pt[], d: number): Pt[] {
  const n = pts.length; if (n < 3) return pts;
  let a2 = 0; for (let i = 0; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a2 += p[0] * q[1] - q[0] * p[1]; }
  const sgn = a2 > 0 ? 1 : -1;   // inward normal side
  const lines = pts.map((p, i) => { const q = pts[(i + 1) % n]; const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1; const nx = -dy / L * sgn, ny = dx / L * sgn; return [p[0] + nx * d, p[1] + ny * d, dx, dy]; });
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = lines[(i + n - 1) % n], b = lines[i]; const den = a[2] * b[3] - a[3] * b[2];
    if (Math.abs(den) < 1e-12) { out.push([b[0], b[1]]); continue; }
    const t = ((b[0] - a[0]) * b[3] - (b[1] - a[1]) * b[2]) / den; out.push([a[0] + a[2] * t, a[1] + a[3] * t]);
  }
  // a deflate that swallows the shape leaves nothing
  let a3 = 0; for (let i = 0; i < n; i++) { const p = out[i], q = out[(i + 1) % n]; a3 += p[0] * q[1] - q[0] * p[1]; }
  return a3 * a2 > 0 ? out : [];
}
/** One drawn primitive of a custom pad as polygons (its stroke included), for the union a negative margin deflates. */
function geomPolys(g: Geom): Pt[][] {
  const w = g.w || 0;
  const band = (pts: Pt[], closed: boolean): Pt[][] => { const out: Pt[][] = []; for (let i = 0; i + 1 < pts.length; i++) out.push(stadium(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w)); if (closed && pts.length > 2) out.push(stadium(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], w)); return out; };
  if (g.t === "line") return w > 0 ? [stadium(g.x1, g.y1, g.x2, g.y2, w)] : [];
  if (g.t === "arc") return w > 0 ? band(arcPoints(g.x, g.y, g.r, g.a0, g.a1, !!g.anticlockwise), false) : [];
  if (g.t === "circle") return g.fill ? [circlePoints(g.x, g.y, g.r + w / 2)] : w > 0 ? band(circlePoints(g.x, g.y, g.r), true) : [];
  if (g.t === "poly") { if (g.fill) return w > 0 ? inflate([g.pts as [number, number][]], w / 2) : [g.pts]; return w > 0 ? band(g.pts, !!g.close) : []; }
  if (g.t === "pad") {
    if (g.shape === "circle") return [circlePoints(g.x, g.y, Math.max(g.w, g.h) / 2)];
    const R = rotator(g.rot); return [[[-g.w / 2, -g.h / 2], [g.w / 2, -g.h / 2], [g.w / 2, g.h / 2], [-g.w / 2, g.h / 2]].map(([lx, ly]) => { const [dx, dy] = R(lx, ly); return [g.x + dx, g.y + dy] as Pt; })];
  }
  return [];
}

/** The text a pad label gets drawn with: both layouts are built, render picks the one that matches what is shown (padLabelShown). */
export function padLabelShown(g: Geom, padNumbers: boolean, padNetNames: boolean): boolean {
  // PCB_PAINTER::draw( PAD, netname layer ): the number with pad numbers on; the net name in net-name modes 1 and 3, but
  // the "x" / "*" of a no-connect / free pad whatever the mode; both shown: the two-line layout, else the one centred
  const numOn = padNumbers, netOn = !!g.padMark || padNetNames;
  if (g.padNum ? !numOn : !netOn) return false;
  const pair = !!g.padBoth && numOn && netOn;
  return !!g.padPair === pair;
}

export function buildPadGeom(item: Item, pad: SNode, tf: Tf, side: string, doc: Doc, padIndex: number): void {
  const number = str(pad[1]), type = str(pad[2]); let shape = str(pad[3]);
  const netN = kid(pad, "net"); const net = netCode(doc, pad);
  const netname = netN ? (typeof netN[1] === "number" ? (netN.length > 2 ? str(netN[2]) : str((doc && doc.nets && doc.nets.get(netN[1])) || "")) : str(netN[1])) : "";
  const [px, py, prot] = atOf(pad); const sz = kid(pad, "size"); const w = sz ? num(sz[1]) : 1, h = sz ? num(sz[2], num(sz[1])) : 1;
  const [cx, cy] = tf(px, py);
  const ls = kid(pad, "layers"); const layers = padLayers(doc || { copper: [] }, ls ? ls.slice(1).map(str) : [side]);
  const copper = padCopperLayer(pad);
  const rrN = kid(pad, "roundrect_rratio"); const rr = rrN ? num(rrN[1]) : (shape === "roundrect" ? 0.25 : 0);
  const dr = kid(pad, "drill");
  const oval = dr && str(dr[1]) === "oval"; const dw = dr ? (oval ? num(dr[2]) : num(dr[1])) : 0, dh = dr ? (oval ? num(dr[3], dw) : dw) : 0;
  // PAD::ShapePos: the copper / mask / paste shape sits at the position plus the drill offset turned by the pad's angle;
  // the hole stays at the position
  let sx = cx, sy = cy, hasOffset = false;
  if (dr) { const off = kid(dr, "offset"); if (off && (num(off[1]) || num(off[2]))) { const [ox, oy] = rotator(prot)(num(off[1]), num(off[2])); sx += ox; sy += oy; hasOffset = true; } }
  const npth = type === "np_thru_hole";
  // LAYER_FOOTPRINTS_FR / BK decide a pad by the sides of its whole layer set (PAD::ViewGetLOD)
  const sideTag = { padFront: layers.some((l) => /^F\./.test(l)) || undefined, padBack: layers.some((l) => /^B\./.test(l)) || undefined };
  // a footprint's private layers are not drawn on the board (PCB_PAINTER::Draw)
  const fpNode = item.kind === "footprint" ? item.node : doc && doc.fpEditor && doc.fpState ? doc.fpState.fp : null;
  const privN = fpNode && !(doc && doc.fpEditor) ? kid(fpNode, "private_layers") : null; const priv = privN ? new Set(privN.slice(1).map(str)) : null;
  // PAD::GetSolderMaskExpansion / GetSolderPasteMargin: the pad's value, else its footprint's, else the board's (none for a
  // pad without copper); a negative mask margin keeps half the copper size, a paste margin half the pad size
  const hasCu = layers.some((l) => /\.Cu$/.test(l));
  const bs = boardMaskSetup(doc);
  const own = (k: string): number | undefined => { const c = kid(pad, k) || (fpNode ? kid(fpNode, k) : null); return c ? num(c[1]) : undefined; };
  const ratioOf = (n: SNode | null) => n ? (kid(n, "solder_paste_margin_ratio") || kid(n, "solder_paste_ratio")) : null;
  let maskM = hasCu ? (own("solder_mask_margin") ?? bs.maskExp) : 0;
  if (maskM < 0) maskM = Math.max(maskM, -Math.min(w, h) / 2);
  const pm = hasCu ? (own("solder_paste_margin") ?? bs.pasteMargin) : 0;
  const prN = ratioOf(pad) || ratioOf(fpNode); const pr = hasCu ? (prN ? num(prN[1]) : bs.pasteRatio) : 0;
  let pasteX = pm + w * pr, pasteY = pm + h * pr;
  if (shape !== "custom") { pasteX = Math.max(pasteX, -w / 2); pasteY = Math.max(pasteY, -h / 2); }
  // PAD::FlashLayer for a plated pad's copper: KEEP_ALL everywhere; START_END_ONLY on F.Cu / B.Cu; REMOVE_EXCEPT_START_AND_END
  // on the outer layers for sure; the rest only where something connects (or zone_layer_connections forces it)
  const mode = type === "thru_hole" ? unusedLayerMode(pad) : "keep";
  const zlc = kid(pad, "zone_layer_connections"); const forced = new Set(zlc ? zlc.slice(1).map(str) : []);
  // one geometry per layer the pad is on (copper, mask, paste): whichever is drawn last wins, like KiCad
  const shapes: (PadGeom | PolyGeom)[] = [];
  const pushShape = (layer: string, z: number, color: string, fill: string, mx: number, my: number, extra: Partial<Geom> | null) => {
    const from = item.geom.length;
    pushPadShape(layer, z, color, fill, mx, my);
    for (let i = from; i < item.geom.length; i++) { const pg = item.geom[i]; pg.pad = true; pg.padIndex = padIndex; pg.padNumber = number; pg.padType = type; pg.net = net; pg.netName = netname; Object.assign(pg, sideTag, extra); }   // tagged for outlinePads / padAt / net colours
  };
  // the pad's shape grown (or shrunk) by a mask / paste margin, as PCB_PAINTER::draw( PAD ) builds it: a positive margin
  // rounds the corners by the margin, a negative one shrinks the shape; two different margins (a paste ratio on a
  // non-square pad) resize a copy of the pad and adjust a round rectangle's radius by the larger
  const pushPadShape = (layer: string, z: number, color: string, fill: string, mx: number, my: number) => {
    if (shape === "custom") {
      const prims = kid(pad, "primitives"); const anchor = str((kid(pad, "options") && kid(kid(pad, "options")!, "anchor") || [])[1]);
      const Rp = rotator(prot); const ptf = (lx: number, ly: number): Pt => { const [x, y] = Rp(lx, ly); return [sx + x, sy + y]; };
      const from = item.geom.length;
      if (prims) for (const pr of prims.slice(1)) if (isList(pr) && pr[0] !== "gr_bbox") { const before = item.geom.length; graphicGeom(item, pr, (pr[0] as string).replace("gr_", ""), ptf, layer, z); for (let i = before; i < item.geom.length; i++) { const gg = item.geom[i]; gg.color = color; if (gg.fill) gg.fill = fill; if (!gg.fill && gg.w <= 0) { gg.fill = fill; gg.noStroke = true; } } }
      const anchorG = G(item, { t: "pad", x: sx, y: sy, w, h, rot: prot, shape: anchor === "circle" ? "circle" : "rect", rr: 0, color, fill, layer, z });
      if (!mx) { shapes.push(anchorG); return; }
      // PAD::TransformShapeToPolygon( margin ): the primitives' union grown or shrunk with round corners.  Growing each
      // piece by the margin is the same as growing the union; shrinking needs the union first.
      const drawn = item.geom.slice(from);
      if (mx > 0) {
        for (const gg of drawn) {
          if (gg.t === "pad") { const g2 = gg as PadGeom; if (g2.shape === "circle") { g2.w += 2 * mx; g2.h += 2 * mx; } else { g2.w += 2 * mx; g2.h += 2 * mx; g2.shape = "rect"; g2.rr = mx; } }
          else { gg.w = (gg.w || 0) + 2 * mx; gg.noStroke = false; if (gg.t === "line" || gg.t === "arc" || gg.t === "poly") gg.cap = "round"; }
        }
        shapes.push(anchorG); return;
      }
      const polys: Pt[][] = []; for (const gg of drawn) polys.push(...geomPolys(gg));
      item.geom.length = from;
      for (const p of inflate(union(polys as [number, number][][]), mx)) shapes.push(G(item, { t: "poly", pts: p, close: true, w: 0, color, fill, layer, z, noStroke: true }));
      return;
    }
    const polyShape = shape === "trapezoid" || (shape === "rect" && kid(pad, "rect_delta")) || (kid(pad, "chamfer") && shape !== "circle" && shape !== "oval");
    const diff = mx !== my;
    const W = w + 2 * mx, H = h + 2 * my;
    if ((mx || my) && (W <= 0 || H <= 0)) return;
    if (polyShape) {
      const Rp = rotator(prot); const place = (p: Pt[]) => p.map(([lx, ly]) => { const [x, y] = Rp(lx, ly); return [sx + x, sy + y] as Pt; });
      const kind = shape === "trapezoid" || kid(pad, "rect_delta") ? "trapezoid" : "chamfer";
      if (diff) { shapes.push(G(item, { t: "poly", pts: place(padPolygon(pad, kind, W, H)), close: true, w: 0, color, fill, layer, z, noStroke: true })); return; }
      let local = padPolygon(pad, kind, w, h);
      if (mx < 0) { local = insetConvex(local, -mx); if (local.length < 3) return; }
      // a positive margin: the polygon plus segments 2 × margin wide along its edges (rounded corners)
      shapes.push(G(item, mx > 0 ? { t: "poly", pts: place(local), close: true, w: 2 * mx, color, fill, layer, z, cap: "round" } : { t: "poly", pts: place(local), close: true, w: 0, color, fill, layer, z, noStroke: true }));
      return;
    }
    const r0 = shape === "roundrect" ? rr * Math.min(w, h) : 0;
    if (shape === "circle") { const r = (diff ? W : w + 2 * mx) / 2; if (r <= 0) return; shapes.push(G(item, { t: "pad", x: sx, y: sy, w: 2 * r, h: 2 * r, rot: prot, shape: "circle", rr: 0, color, fill, layer, z })); return; }
    if (shape === "oval") { shapes.push(G(item, { t: "pad", x: sx, y: sy, w: W, h: H, rot: prot, shape: "oval", rr: 0, color, fill, layer, z })); return; }
    // rect / roundrect
    let rad = r0;
    if (shape === "roundrect" && (diff || mx < 0)) rad = Math.max(r0 + Math.max(mx, my), 0);
    else if (!diff && mx > 0) rad = r0 + mx;
    shapes.push(G(item, { t: "pad", x: sx, y: sy, w: W, h: H, rot: prot, shape: "rect", rr: rad, color, fill, layer, z }));
  };
  // the layers a label may show for (PAD::FlashLayer of the visible / high-contrast layers)
  const labelLayers: string[] = [];
  let labelShapes: (PadGeom | PolyGeom)[] | null = null;
  for (const layer of layers) {
    const isCu = /\.Cu$/.test(layer); const color = pcbColor(layer);
    if (priv && priv.has(layer)) continue;
    if (isCu && npth) {
      // PAD::FlashLayer: an NPTH pad whose round (oval) copper is no bigger than its round (oval) hole, unshifted, flashes none
      if (shape === "circle" && !oval && !hasOffset && dw >= w) continue;
      if (shape === "oval" && oval && !hasOffset && dw >= w && dh >= h) continue;
    }
    // layers_mech: mask, paste, adhesive, silkscreen, Dwgs.User, Eco1.User, Eco2.User
    if (!isCu && !/\.(Mask|Paste|Adhes|SilkS)$/.test(layer) && layer !== "Dwgs.User" && layer !== "Eco1.User" && layer !== "Eco2.User") continue;
    let unused = false;
    if (isCu && mode !== "keep") {
      const outer = layer === "F.Cu" || layer === "B.Cu";
      if (mode === "startEnd" && !outer) continue;
      unused = (mode === "all" || (mode === "exceptEnds" && !outer)) && !forced.has(layer);
      if (unused) item.unusedFlash = true;
    }
    const mx = /\.Mask$/.test(layer) ? maskM : /\.Paste$/.test(layer) ? pasteX : 0, my = /\.Mask$/.test(layer) ? maskM : /\.Paste$/.test(layer) ? pasteY : 0;
    const before = shapes.length;
    pushShape(layer, pcbZ(layer) + (isCu ? Z_PAD : 0.5), color, color, mx, my, unused ? { unusedLayer: true } : null);
    labelLayers.push(layer);
    if (isCu && !labelShapes && shapes.length > before) labelShapes = shapes.slice(before);
    // post-machining: a dashed circle on each copper layer the counterbore / countersink reaches, drawn with the pad there
    if (isCu && dr && dw > 0 && (kid(pad, "front_post_machining") || kid(pad, "back_post_machining"))) {
      const k = postMachiningKnockout(doc, pad, layer);
      if (k > 0) dashedCircle(item, cx, cy, k, color, layer, pcbZ(layer) + Z_PAD + 0.001, 0, 1, Object.assign({ pad: true, padIndex, net }, sideTag, unused ? { unusedLayer: true } : null));
    }
  }
  bboxAdd(item, sx, sy, Math.hypot(w, h) / 2);
  if (dr && dw > 0) {
    const zh = pcbZ("holes");
    bboxAdd(item, cx, cy, Math.max(dw, dh) / 2);
    if (npth) G(item, Object.assign({ t: "pad" as const, x: cx, y: cy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: NPTH, fill: NPTH, layer: "holes", z: zh, hole: true, npth: true, padIndex, net }, sideTag));
    else {
      // plated: hole in the background colour with a thin plating wall (LAYER_PAD_HOLEWALLS uses the via hole colour)
      G(item, Object.assign({ t: "pad" as const, x: cx, y: cy, w: dw + 2 * Math.min(HOLE_WALL, w / 2, h / 2), h: dh + 2 * Math.min(HOLE_WALL, w / 2, h / 2), rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: VIA_HOLE, fill: VIA_HOLE, layer: "holes", z: zh, hole: true, padIndex, net }, sideTag));
      G(item, Object.assign({ t: "pad" as const, x: cx, y: cy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, color: PCB_BG, fill: PCB_BG, layer: "holes", z: zh, hole: true, padIndex, net }, sideTag));
      // backdrill indicators with the hole wall, in the colour of the layer each drill must cut
      [extraDrill(pad, "backdrill"), extraDrill(pad, "tertiary_drill")].forEach((b, i) => { if (b) dashedCircle(item, cx, cy, b.size, pcbColor(b.end), "holes", zh + 0.001, i, 2, Object.assign({ pad: true, padIndex, net }, sideTag)); });
    }
  }
  // pad number + net name: PCB_PAINTER::draw( const PAD*, netname layer )
  const pinType = str((kid(pad, "pintype") || [])[1]);
  let shownNet = displayNetName(netname); let mark = false;
  if (pinType.indexOf("no_connect") >= 0) { shownNet = "x"; mark = true; }                                       // PAD::IsNoConnectPad
  else if (pinType === "free" && shownNet.indexOf("unconnected-(") === 0) { shownNet = "*"; mark = true; }      // PAD::IsFreePad
  if (number || shownNet) {
    // the pad's bounding box on the board (its copper and its hole) decides the room and the reading direction
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const grow = (x: number, y: number, r: number) => { if (x - r < bx0) bx0 = x - r; if (y - r < by0) by0 = y - r; if (x + r > bx1) bx1 = x + r; if (y + r > by1) by1 = y + r; };
    const growPad = (g: PadGeom) => {
      if (g.shape === "circle") { grow(g.x, g.y, Math.max(g.w, g.h) / 2); return; }
      const ca = Math.abs(Math.cos(g.rot * Math.PI / 180)), sa = Math.abs(Math.sin(g.rot * Math.PI / 180));
      if (g.shape === "oval") { const r = Math.min(g.w, g.h) / 2, hx = g.w > g.h ? (g.w - g.h) / 2 : 0, hy = g.h > g.w ? (g.h - g.w) / 2 : 0; const ex = hx * ca + hy * sa + r, ey = hx * sa + hy * ca + r; grow(g.x - ex, g.y - ey, 0); grow(g.x + ex, g.y + ey, 0); return; }
      const ex = (g.w * ca + g.h * sa) / 2, ey = (g.w * sa + g.h * ca) / 2; grow(g.x - ex, g.y - ey, 0); grow(g.x + ex, g.y + ey, 0);
    };
    let numberBox = false;
    if (shape === "custom") {
      // a custom pad's number box (a gr_bbox proxy primitive): its centre and size × 0.9
      const prims = kid(pad, "primitives"); const bb = prims ? (prims.slice(1).find((q) => isList(q) && q[0] === "gr_bbox") as SNode | undefined) : undefined;
      const s0 = bb && kid(bb, "start"), e0 = bb && kid(bb, "end");
      if (s0 && e0) {
        const lcx = (num(s0[1]) + num(e0[1])) / 2, lcy = (num(s0[2]) + num(e0[2])) / 2; const [ox, oy] = rotator(prot)(lcx, lcy);
        const hw = Math.abs(num(e0[1]) - num(s0[1])) * 0.9 / 2, hh = Math.abs(num(e0[2]) - num(s0[2])) * 0.9 / 2;
        bx0 = sx + ox - hw; bx1 = sx + ox + hw; by0 = sy + oy - hh; by1 = sy + oy + hh; numberBox = true;
      } else {
        const firstLayer = labelShapes && labelShapes.length ? labelShapes[0].layer : shapes.length ? shapes[0].layer : null;
        if (firstLayer) for (const sg of item.geom) {
          if (!sg.pad || sg.padIndex !== padIndex || sg.layer !== firstLayer || sg.hole || sg.indicator) continue;
          if (sg.t === "poly") for (const q of sg.pts) grow(q[0], q[1], (sg.w || 0) / 2);
          else if (sg.t === "circle" || sg.t === "arc") grow(sg.x, sg.y, sg.r + (sg.w || 0) / 2);
          else if (sg.t === "line") { grow(sg.x1, sg.y1, (sg.w || 0) / 2); grow(sg.x2, sg.y2, (sg.w || 0) / 2); }
          else if (sg.t === "pad") { const ca = Math.abs(Math.cos(sg.rot * Math.PI / 180)), sa = Math.abs(Math.sin(sg.rot * Math.PI / 180)); const ex = (sg.w * ca + sg.h * sa) / 2, ey = (sg.w * sa + sg.h * ca) / 2; grow(sg.x - ex, sg.y - ey, 0); grow(sg.x + ex, sg.y + ey, 0); }
        }
      }
    }
    if (!numberBox && !isFinite(bx0)) {
      if (shape === "circle") grow(sx, sy, w / 2);
      else growPad({ t: "pad", x: sx, y: sy, w, h, rot: prot, shape: shape === "oval" ? "oval" : "rect", rr: 0, layer: "" } as PadGeom);
    }
    // PAD::GetBoundingBox merges the hole
    if (!numberBox && dr && dw > 0) growPad({ t: "pad", x: cx, y: cy, w: dw, h: dh, rot: prot, shape: oval ? "oval" : "circle", rr: 0, layer: "" } as PadGeom);
    const tcx = (bx0 + bx1) / 2, tcy = (by0 + by1) / 2;
    let pw = bx1 - bx0, ph = by1 - by0; const padMin = Math.min(pw, ph);
    if (shape !== "custom") { const limit = Math.min(w, h) * 1.1; if (pw > limit && ph > limit) { pw = limit; ph = limit; } }   // a 45° rotation must not bloat the box
    let size0 = ph; let rot = 0;
    if (pw < ph * 0.95) { rot = 90; size0 = pw; const t = pw; pw = ph; ph = t; }
    if (size0 > 10) size0 = 10;   // PCB_RENDER_SETTINGS::MAX_FONT_SIZE
    // LAYER_PAD_NETNAMES (multi-layer or through-hole, above the holes) or the copper layer's own netname layer (single-layer SMD)
    const padCu = layers.filter((l) => /\.Cu$/.test(l));
    const pth = type === "thru_hole" || padCu.length > 1 || (copper !== "F.Cu" && copper !== "B.Cu");
    const textLayer = copper || layers[0] || side; const z = pth ? pcbZ("Dwgs.User") + 21 : pcbZ(textLayer) + 3.6;   // LAYER_PAD_NETNAMES: over every board layer
    const color = pth ? PAD_TEXT : padNameColor(textLayer);
    const both = !!number && !!shownNet;
    const label = (text: string, ts: number, dyLocal: number, tag: "padNet" | "padNum", pair: boolean) => {
      const [dx, dy] = rotPt(0, dyLocal, rot);
      const g: TextGeom = { t: "text", x: tcx + dx, y: tcy + dy, text, size: ts, sizeX: ts * 0.9, w: ts * 0.9 / 6, color, rot, h: "center", v: "middle", layer: textLayer, z, padText: true, padMin, padLayers: labelLayers.length ? labelLayers : [textLayer], noBox: true, minPx: 3.5, labelPad: padIndex };   // below 3.5 px the label is a smudge: skipped (KiCad would still paint it)
      g[tag] = true; if (pair) g.padPair = true; if (both) g.padBoth = true; if (mark) g.padMark = true; Object.assign(g, sideTag); G(item, g);
    };
    // the layout with both lines (size / 2.5, the name below, the number above) and each line alone, centred at full size
    const layouts = both ? [true, false] : [false];
    for (const pair of layouts) {
      const size = pair ? size0 / 2.5 : size0, yNet = pair ? size / 1.4 : 0, yNum = pair ? size / 1.7 : 0;
      if (shownNet) {
        let ts = Math.min(1.5 * pw / Math.max(printableCharCount(shownNet) + 1, 5), size) * 0.85;
        if (shape === "circle" || shape === "oval") ts *= 0.9;   // round pads have less room
        label(shownNet, ts, Math.min(ts * 1.4, yNet), "padNet", pair);
      }
      if (number) {
        const ts = Math.min(Math.min(1.5 * pw / Math.max(printableCharCount(number), 3), size) * 0.85, size);
        label(number, ts, -yNum, "padNum", pair);
      }
    }
  }
}
