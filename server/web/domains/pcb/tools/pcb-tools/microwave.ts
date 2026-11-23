// pcb-tools/microwave.ts — MICROWAVE_TOOL (pcbnew/microwave): Place > Draw Microwave Shapes.
//   Gap / Stub / Arc Stub / Polygonal Shape (addMicrowaveFootprint): doInteractiveItemPlacement with IPO_REPEAT |
//     IPO_ROTATE | IPO_FLIP — a click asks for the sizes (createFootprint's WX_TEXT_ENTRY_DIALOGs, createPolygonShape's
//     MWAVE_POLYGONAL_SHAPE_DLG) and puts the new footprint on the cursor, the next click places it ("Place microwave
//     feature"), and the tool stays for another; R / F / E rotate, flip and edit the carried footprint, Escape drops it
//     (with nothing carried it leaves the tool).
//   Line (drawMicrowaveInductor): two points with the CENTRELINE_RECT_ITEM preview between them, then
//     createInductorBetween: the track length and the value, BuildCornersList_S_Shape's coil as a footprint
//     ("Add Microwave Inductor"), selected.
// The geometry is computed in internal units (nm) with KiCad's integer arithmetic and written in mm.
import type { PcbCtx, Pt } from "./types";
import { sizesOf } from "./app-state";
import { addedChange } from "./changes";
import { openForm } from "./dialogs";
import { sizeUnits } from "./edit-commands";
import { flipFootprintNode, rotateFootprintNode, setFootprintAt } from "./footprint";
import { applySelection } from "./groups";
import { vectorSnapped } from "./dom";
import { angleSnapMode } from "./draw-modes";
import { newItemDialogs } from "./assistants";
import { BOARD_VERSION, K, S } from "./state";
import { r6, textStyle } from "./util";
import { errorMessage } from "./via-stack";
import { stringFromValue } from "../../../../shared/units";

// ---------------------------------------------------------------- units (EDA_UNIT_UTILS::UI)
const IU_PER_MM = 1e6;
/** KiROUND. */
export const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
const mm = (iu: number): number => r6(iu / IU_PER_MM);
type UserUnits = "mm" | "mil" | "in";
const userUnits = (): UserUnits => { const u = sizeUnits(); return u === "mil" || u === "in" ? u : "mm"; };
/** EDA_BASE_FRAME::StringFromValue( IU ) without the units label. */
export function stringFromIU(iu: number, units: UserUnits = userUnits()): string { return stringFromValue(iu / IU_PER_MM, units, "pcb", false); }
/**
 * DoubleValueFromString then KiROUND (ValueFromString): the numeric start of the text in the user units, or in the
 * units its suffix names (um, mm, cm, mil / thou, in / ", oz as 1.37 mils), to internal units.
 */
export function valueFromString(text: string, units: UserUnits = userUnits()): number {
  const buf = String(text).trim().replace(/,/g, ".");
  let brk = 0;
  while (brk < buf.length && /[0-9.+\-eE]/.test(buf[brk])) brk++;
  let v = parseFloat(buf.slice(0, brk)); if (!isFinite(v)) v = 0;
  const unit = buf.slice(brk).trimStart().slice(0, 2).toLowerCase();
  let u: string = units;
  if (unit === "um" || unit === "\u00b5m" || unit === "\u03bcm" || unit === "мк") u = "um";
  else if (unit === "mm") u = "mm";
  else if (unit === "cm") u = "cm";
  else if (unit === "mi" || unit === "th") u = "mil";
  else if (unit === "in" || unit === "\"") u = "in";
  else if (unit === "oz") { u = "mil"; v *= 1.37; }
  const per = u === "um" ? 1e3 : u === "cm" ? 1e7 : u === "mil" ? 25400 : u === "in" ? 25.4e6 : 1e6;
  return kiRound(v * per);
}
/** wxString::ToDouble: the whole text must be a number. */
function toDouble(s: string): number | null { return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? parseFloat(s) : null; }

/** EDA_ANGLE::Normalize. */
function normalizeDeg(a: number): number {
  if (!isFinite(a)) a = 0; else if (Math.abs(a) >= 720) a = (a % 360) + (a < 0 ? -360 : 360);   // foldToTwoPeriods
  while (a < -0.0) a += 360;
  while (a >= 360) a -= 360;
  return a;
}
/** EDA_ANGLE::Sin / Cos of a normalized angle: the axes and the diagonals exact. */
function angleSin(a: number): number { return a === 0 || a === 180 ? 0 : a === 45 || a === 135 ? Math.SQRT1_2 : a === 225 || a === 315 ? -Math.SQRT1_2 : a === 90 ? 1 : a === 270 ? -1 : Math.sin(a * (Math.PI / 180)); }
function angleCos(a: number): number { return a === 0 ? 1 : a === 180 ? -1 : a === 90 || a === 270 ? 0 : a === 45 || a === 315 ? Math.SQRT1_2 : a === 135 || a === 225 ? -Math.SQRT1_2 : Math.cos(a * (Math.PI / 180)); }
/** RotatePoint( int*, int*, EDA_ANGLE ): the right angles exact, the others rounded. */
export function rotatePoint(x: number, y: number, deg: number): [number, number] {
  const a = normalizeDeg(deg);
  if (a === 0) return [x, y];
  if (a === 90) return [y, -x];
  if (a === 180) return [-x, -y];
  if (a === 270) return [-y, x];
  const s = angleSin(a), c = angleCos(a);
  return [kiRound(y * s + x * c), kiRound(y * c - x * s)];
}

// ---------------------------------------------------------------- footprints (CreateNewFootprint, createBaseFootprint)
type IPt = [number, number];
interface MwPad { number: string; x: number; y: number; w: number; h: number; shape: "rect" | "circle" | "custom"; prim?: IPt[] }
interface MwFootprint { fpid: string; value: string; textSize: number; pads: MwPad[]; polys: IPt[][]; lines: { a: IPt; b: IPt; w: number }[]; refPos?: IPt; valPos?: IPt; pos: IPt }

const uuid = (): string => K.newUuid();
const effects = (size: number, thick: number): SNode => ["effects", ["font", ["size", r6(size), r6(size)], ["thickness", r6(thick)]]];
/** SHAPE_LINE_CHAIN::Append without duplication: a point equal to the one before is left out. */
function appendPts(pts: IPt[]): IPt[] { const out: IPt[] = []; for (const p of pts) { const q = out[out.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p); } return out; }

/**
 * The footprint as PCB_IO_KICAD_SEXPR writes it: CreateNewFootprint's REF** (F.SilkS), the value (F.Fab) and the
 * ${REFERENCE} text with the board's text defaults (createBaseFootprint's text size, thickness size / 5, when given),
 * the attributes exclude_from_pos_files / exclude_from_bom, the drawings and the pads in footprint coordinates.
 */
export function footprintNode(f: MwFootprint, style: (layer: string) => { size: number; thick: number } = textStyle): SNode {
  const silk = style("F.SilkS"), fab = style("F.Fab");
  // CreateNewFootprint: the reference half a silk text height above the anchor, the value and the user text below
  let y = 0; y -= silk.size / 2; const refY = y; y += silk.size; y += fab.size / 2; const valY = y; y += fab.size; y += fab.size / 2; const userY = y;
  let refSize = silk.size, refThick = silk.thick, valSize = fab.size, valThick = fab.thick;
  if (f.textSize > 0) { refSize = valSize = f.textSize / IU_PER_MM; refThick = valThick = Math.trunc(f.textSize / 5) / IU_PER_MM; }
  const [px, py] = f.pos;
  const ref = f.refPos ? [mm(f.refPos[0] - px), mm(f.refPos[1] - py)] : [0, r6(refY)];
  const val = f.valPos ? [mm(f.valPos[0] - px), mm(f.valPos[1] - py)] : [0, r6(valY)];
  const node: SNode = ["footprint", f.fpid, ["layer", "F.Cu"], ["uuid", uuid()], ["at", mm(px), mm(py)],
    ["property", "Reference", "REF**", ["at", ref[0], ref[1], 0], ["layer", "F.SilkS"], ["uuid", uuid()], effects(refSize, refThick)],
    ["property", "Value", f.value, ["at", val[0], val[1], 0], ["layer", "F.Fab"], ["uuid", uuid()], effects(valSize, valThick)],
    ["property", "Datasheet", "", ["at", 0, 0, 0], ["layer", "F.Fab"], ["hide", "yes"], ["uuid", uuid()], effects(fab.size, fab.thick)],
    ["property", "Description", "", ["at", 0, 0, 0], ["layer", "F.Fab"], ["hide", "yes"], ["uuid", uuid()], effects(fab.size, fab.thick)],
    ["attr", "exclude_from_pos_files", "exclude_from_bom"],
    ["fp_text", "user", "${REFERENCE}", ["at", 0, r6(userY), 0], ["layer", "F.Fab"], ["uuid", uuid()], effects(fab.size, fab.thick)]];
  const loc = (p: IPt): [number, number] => [mm(p[0] - px), mm(p[1] - py)];
  for (const l of f.lines) node.push(["fp_line", ["start", ...loc(l.a)], ["end", ...loc(l.b)], ["stroke", ["width", mm(l.w)], ["type", "solid"]], ["layer", "F.Cu"], ["uuid", uuid()]]);
  for (const p of f.polys) node.push(["fp_poly", ["pts", ...appendPts(p).map((q) => ["xy", ...loc(q)] as SNode)], ["stroke", ["width", 0], ["type", "solid"]], ["fill", "yes"], ["layer", "F.Cu"], ["uuid", uuid()]]);
  for (const p of f.pads) {
    const pad: SNode = ["pad", p.number, "smd", p.shape, ["at", ...loc([p.x, p.y])], ["size", mm(p.w), mm(p.h)], ["layers", "F.Cu"]];
    if (p.shape === "custom") {
      pad.push(["options", ["clearance", "outline"], ["anchor", "rect"]]);
      pad.push(["primitives", ["gr_poly", ["pts", ...appendPts(p.prim || []).map((q) => ["xy", mm(q[0]), mm(q[1])] as SNode)], ["width", 0], ["fill", "yes"]]]);
    }
    pad.push(["uuid", uuid()]);
    node.push(pad);
  }
  node.push(["embedded_fonts", "no"]);
  return node;
}

export type MwShape = "gap" | "stub" | "stubarc";
/**
 * MICROWAVE_TOOL::createFootprint after its dialogs: `gap` the entered size (IU), `angle` the arc stub's (degrees,
 * already made positive and capped at 180), `trackWidth` GetCurrentTrackWidth (the pads' size and, for a gap or a
 * stub, the texts' size).  The pads are in the order FOOTPRINT::Add( ADD_MODE::INSERT ) leaves them (the last
 * created first), as the code addresses them.
 */
export function microwaveFootprint(shape: MwShape, gap: number, angle: number, trackWidth: number): MwFootprint {
  const name = shape === "gap" ? "muwave_gap" : shape === "stub" ? "muwave_stub" : "muwave_arcstub";
  const textSize = shape === "stubarc" ? 0 : trackWidth;
  const padCount = shape === "stubarc" ? 1 : 2;
  const pads: MwPad[] = [];
  for (let n = 1; n <= padCount; n++) pads.unshift({ number: String(n), x: 0, y: 0, w: trackWidth, h: trackWidth, shape: "rect" });
  if (shape === "gap") {
    const offsetX = Math.trunc(-(gap + pads[0].w) / 2);
    pads[0].x += offsetX;
    pads[1].x += offsetX + gap + pads[1].w;
  } else if (shape === "stub") {
    pads[0].number = "1";
    const offsetY = Math.trunc(-(gap + pads[0].h) / 2);
    pads[1].h = gap;
    pads[1].y += offsetY;
  } else {
    // an arc stub, made as a polygon: the custom pad's primitive, anchored on a rectangle
    const pad = pads[0]; pad.shape = "custom";
    const numPoints = Math.trunc(angle / 5.0) + 3;
    const poly: IPt[] = [[0, 0]];
    let theta = -angle / 2;
    for (let ii = 1; ii < numPoints - 1; ii++) {
      poly.push(rotatePoint(0, -gap, theta));
      theta += 5.0;
      if (theta > angle / 2) theta = angle / 2;
    }
    poly.push(poly[0]);   // close the polygon
    pad.prim = poly;
  }
  return { fpid: name, value: name, textSize, pads, polys: [], lines: [], pos: [0, 0] };
}

// ---------------------------------------------------------------- the polygonal shape (microwave_polygon.cpp)
/** g_PolyEdges, g_ShapeScaleX / Y and g_PolyShapeType: they outlive a dialog, as KiCad's statics do. */
export const MW_SHAPE = { edges: [] as [number, number][], scaleX: 0, scaleY: 0, type: 0 };
/**
 * MWAVE_POLYGONAL_SHAPE_DLG::ReadDataShapeDescr's reader: "Unit=inch|mm", "XScale=", "YScale=" and the X Y pairs
 * between $COORD and $ENDCOORD (FILTER_READER drops the lines that start with '#' or are empty); the scales come
 * out in internal units.
 */
export function parseShapeDescription(text: string): { edges: [number, number][]; scaleX: number; scaleY: number } {
  const lines = text.split("\n").map((l) => l + "\n").filter((l) => !"#\n\r".includes(l[0]));
  const tok = (s: string, delims: string): string[] => { const out: string[] = []; let cur = ""; for (const ch of s) { if (delims.includes(ch)) { if (cur) out.push(cur); cur = ""; } else cur += ch; } if (cur) out.push(cur); return out; };
  const ncase = (a: string | undefined, b: string, n: number): boolean => (a || "").slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase() && (a || "").length >= Math.min(n, b.length);
  const atof = (s: string | undefined): number => { const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s || ""); return m ? parseFloat(m[0]) : 0; };
  let unitconv = IU_PER_MM, sx = 1.0, sy = 1.0;
  const edges: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    // strtok( Line, " =\n\r" ) then strtok( nullptr, " \t\n\r" ): the first token ends at a space or '='
    const first = tok(lines[i], " =\n\r"), p1 = first[0];
    const rest = p1 === undefined ? "" : lines[i].slice(lines[i].indexOf(p1) + p1.length + 1);
    const p2 = tok(rest, " \t\n\r")[0];
    if (ncase(p1, "Unit", 4)) {
      if (ncase(p2, "inch", 4)) unitconv = 25.4e6;   // pcbIUScale.IU_PER_MILS * 1000
      if (ncase(p2, "mm", 2)) unitconv = IU_PER_MM;
    }
    if (ncase(p1, "$ENDCOORD", 8)) break;
    let line = p1;
    if (ncase(p1, "$COORD", 6)) {
      while (++i < lines.length) {
        const t = tok(lines[i], " \t\n\r"); line = t[0];
        if (ncase(t[0], "$ENDCOORD", 8)) break;
        edges.push([atof(t[0]), atof(t[1])]);
      }
    }
    if (ncase(line, "XScale", 6)) sx = atof(p2);
    if (ncase(line, "YScale", 6)) sy = atof(p2);
  }
  return { edges, scaleX: sx * unitconv, scaleY: sy * unitconv };
}
/**
 * MICROWAVE_TOOL::createPolygonShape after the dialog: the shape from the edges and the scales (a mirrored shape has
 * its Y scale negated), or the info bar's error.  The anchor sits mid-length; pad 1 and pad 2 at the ends.
 */
export function polygonFootprint(edges: [number, number][], scaleX: number, scaleY: number, type: number, trackWidth: number): MwFootprint | { error: string } {
  const sizeX = kiRound(scaleX), sizeY = kiRound(scaleY);
  if (sizeX === 0 || sizeY === 0) return { error: "Shape has a null size." };
  if (!edges.length) return { error: "Shape has no points." };
  const pads: MwPad[] = [];
  for (let n = 1; n <= 2; n++) pads.unshift({ number: String(n), x: 0, y: 0, w: trackWidth, h: trackWidth, shape: "rect" });
  const offX = Math.trunc(-sizeX / 2);
  pads[0].x = offX;
  pads[1].x = offX + sizeX;
  const poly: IPt[] = [[offX, 0]];
  let last: IPt = [0, 0];
  for (const [x, y] of edges) { last = [kiRound(x * scaleX) + offX, -kiRound(y * scaleY)]; poly.push(last); }
  if (last[1] !== 0) poly.push([last[0], 0]);   // finish the polygonal shape
  const pts = appendPts(poly);
  if (type === 1) for (let i = pts.length - 1; i >= 0; i--) pts.push([pts[i][0], -pts[i][1]]);   // symmetrical: the shape mirrored about X added
  return { fpid: "muwave_polygon", value: "muwave_polygon", textSize: 0, pads, polys: [pts], lines: [], pos: [0, 0] };
}

// ---------------------------------------------------------------- the inductor (microwave_inductor.cpp)
/** GetArcToSegmentCount( radius, ARC_HIGH_DEF, angle ). */
function arcToSegmentCount(radius: number, errorMax: number, deg: number): number {
  const MIN_SEGCOUNT_FOR_CIRCLE = 8;
  const r = Math.max(1, Math.trunc(radius)), e = Math.max(1, errorMax);   // int parameters; no divide by zero
  const relError = e / r;
  let arcIncrement = 180 / Math.PI * Math.acos(1.0 - relError) * 2;
  arcIncrement = 360.0 / MIN_SEGCOUNT_FOR_CIRCLE < arcIncrement || isNaN(arcIncrement) ? 360.0 / MIN_SEGCOUNT_FOR_CIRCLE : arcIncrement;   // std::min( 45, inc )
  const segCount = kiRound(Math.abs(deg) / arcIncrement);
  return Math.max(segCount, 2);   // at least two segments, for algorithmic safety
}
/** gen_arc: the points of an arc from aStartPoint about aCenter (the start itself excluded). */
function genArc(buf: IPt[], start: IPt, center: IPt, deg: number): void {
  const fx = start[0] - center[0], fy = start[1] - center[1];
  const radius = Math.hypot(fx, fy);
  const segCount = arcToSegmentCount(radius, 5000 /* ARC_HIGH_DEF: 0.005 mm */, deg);
  const inc = deg * (Math.PI / 180) / segCount;   // AsRadians() / seg_count
  for (let ii = 1; ii <= segCount; ii++) {
    const rot = inc * ii, c = Math.cos(rot), s = Math.sin(rot);
    buf.push([center[0] + kiRound(fx * c + fy * s), center[1] + kiRound(fy * c - fx * s)]);
  }
}
/** EDA_ANGLE( VECTOR2D ): the axes and the diagonals exact, atan2 otherwise (degrees). */
function edaAngleOf(x: number, y: number): number {
  if (x === 0 && y === 0) return 0;
  if (y === 0) return x >= 0 ? 0 : -180;
  if (x === 0) return y >= 0 ? 90 : -90;
  if (x === y) return x >= 0 ? 45 : -180 + 45;
  if (x === -y) return x >= 0 ? -45 : 180 - 45;
  return Math.atan2(y, x) / (Math.PI / 180);
}
export type SShapeResult = "OK" | "TOO_LONG" | "TOO_SHORT" | "NO_REPR";
/** BuildCornersList_S_Shape: the coil's corner list from start to end with the requested length (all IU). */
export function buildCornersListSShape(buf: IPt[], start: IPt, end: IPt, length: number, width: number): SShapeResult {
  const ADJUST_SIZE = 0.988;
  const ptx = end[0] - start[0], pty = end[1] - start[1];
  let angle = edaAngleOf(ptx, pty);
  const minLen = Math.trunc(Math.hypot(ptx, pty));   // int min_len = pt.EuclideanNorm()
  let segmLen = 0, fullLen = 0;
  angle = -angle;
  const sizeX = Math.trunc(minLen / 2), sizeY = minLen;
  let radius = Math.min(width * 5, Math.trunc(sizeX / 4));
  let segmCount: number, stubsLen = 0, prevLen = -1;
  for (segmCount = 0; ; segmCount++) {
    stubsLen = Math.trunc((sizeY - radius * 2 * (segmCount + 2)) / 2);
    if (stubsLen < Math.trunc(sizeY / 10)) {   // reduce the radius
      stubsLen = Math.trunc(sizeY / 10);
      radius = Math.trunc((sizeY - 2 * stubsLen) / (2 * (segmCount + 2)));
      if (radius < width) return "TOO_LONG";   // the radius is too small
    }
    segmLen = sizeX - radius * 2;
    fullLen = 2 * stubsLen;
    fullLen += segmLen * segmCount;
    fullLen += kiRound((segmCount + 2) * Math.PI * ADJUST_SIZE * radius);
    fullLen += segmLen - 2 * radius;
    if (fullLen >= length) break;
    // a line with no room (start on end): nothing grows, and the C loop would never end
    if (fullLen <= prevLen) return "TOO_LONG";
    prevLen = fullLen;
  }
  const deltaSize = fullLen - length;
  segmLen -= Math.trunc(deltaSize / (segmCount + 1));
  const minTotal = Math.trunc(2 * stubsLen + 2 * Math.PI * ADJUST_SIZE * radius);
  if (minTotal > length) return "TOO_SHORT";
  if (segmLen - 2 * radius < 0) return "NO_REPR";
  // the first stub and the first (90 degree) arc
  let pt: IPt = [start[0], start[1]];
  buf.push(pt);
  pt = [pt[0], pt[1] + stubsLen];
  buf.push(pt);
  let centre: IPt = [pt[0] - radius, pt[1]];
  genArc(buf, pt, centre, -90);
  pt = [buf[buf.length - 1][0], buf[buf.length - 1][1]];
  const halfSizeSegLen = Math.trunc(segmLen / 2) - radius;
  if (halfSizeSegLen) { pt = [pt[0] - halfSizeSegLen, pt[1]]; buf.push(pt); }
  let sign = 1;
  segmCount += 1;   // the last half size segment
  for (let ii = 0; ii < segmCount; ii++) {
    sign = ii & 1 ? -1 : 1;   // odd order arcs are greater than 0
    centre = [pt[0], pt[1] + radius];
    genArc(buf, pt, centre, 180 * sign);
    pt = [buf[buf.length - 1][0] + segmLen * sign, buf[buf.length - 1][1]];
    buf.push(pt);
  }
  // the last point is the end of a full size segment: it must be the end of the second half size one
  sign *= -1;
  buf[buf.length - 1] = [start[0] + radius * sign, buf[buf.length - 1][1]];
  pt = buf[buf.length - 1];
  centre = [pt[0], pt[1] + radius];
  genArc(buf, pt, centre, 90 * sign);
  angle += 90;
  for (let jj = 0; jj < buf.length; jj++) { const r = rotatePoint(buf[jj][0] - start[0], buf[jj][1] - start[1], angle); buf[jj] = [r[0] + start[0], r[1] + start[1]]; }
  buf.push([end[0], end[1]]);
  return "OK";
}
export const S_SHAPE_ERRORS: Record<string, string> = { TOO_LONG: "Requested length too large", TOO_SHORT: "Requested length too small", NO_REPR: "Requested length can't be represented" };
/** createMicrowaveInductor's footprint: "mw_inductor" at the end point, its segments, pad 1 at the end, pad 2 at the start. */
export function inductorFootprint(corners: IPt[], start: IPt, end: IPt, width: number, value: string, style: (layer: string) => { size: number; thick: number } = textStyle): MwFootprint {
  const lines: MwFootprint["lines"] = [];
  for (let jj = 1; jj < corners.length; jj++) lines.push({ a: corners[jj - 1], b: corners[jj], w: width });
  const mid: IPt = [Math.trunc((start[0] + end[0]) / 2), Math.trunc((start[1] + end[1]) / 2)];
  const refH = kiRound(style("F.SilkS").size * IU_PER_MM), valH = kiRound(style("F.Fab").size * IU_PER_MM);
  return { fpid: "mw_inductor", value, textSize: 0, lines, polys: [], pos: end,
    pads: [{ number: "1", x: end[0], y: end[1], w: width, h: width, shape: "circle" }, { number: "2", x: start[0], y: start[1], w: width, h: width, shape: "circle" }],
    refPos: [mid[0], mid[1] - refH], valPos: [mid[0], mid[1] + valH] };
}
/** FOOTPRINT_NAME_VALIDATOR: GetLibFilenameForbiddenChars. */
export const FOOTPRINT_NAME_FORBIDDEN = "<>\"\\:\t\n\r%$/";
const stripForbidden = (s: string): string => Array.from(s).filter((c) => !FOOTPRINT_NAME_FORBIDDEN.includes(c)).join("");

// ---------------------------------------------------------------- the tools
/** Tool id -> MICROWAVE_FOOTPRINT_SHAPE (the line tool, mwline, draws an inductor). */
export const MW_TOOLS: Record<string, MwShape | "shape"> = { mwgap: "gap", mwstub: "stub", mwstubarc: "stubarc", mwshape: "shape" };
export const isMwTool = (t: string | null | undefined): boolean => !!t && (t in MW_TOOLS || t === "mwline");
interface MwLine { origin: Pt; end: Pt; shown: boolean; down: Pt | null }
/** The footprint riding the cursor (doInteractiveItemPlacement's newItem), the line tool's two points, and a counter
 *  that retires the dialogs of an earlier activation. */
export const MW = { carry: null as SNode | null, ghost: null as KDoc | null, ghostKey: "", line: null as MwLine | null, busy: false, gen: 0 };
const trackWidthIU = (ctx: PcbCtx): number => kiRound(sizesOf(ctx).currentTrackWidth() * IU_PER_MM);
const createTitle = "Create Microwave Footprint";

/** WX_TEXT_ENTRY_DIALOG: one text control under its caption; done(text) on OK. */
function textEntry(caption: string, value: string, done: (text: string) => void, filter?: (s: string) => string): boolean {
  return openForm<{ value: string }>({ title: createTitle, width: 360, fields: [{ k: "value", label: caption, type: "text", value }],
    change: filter ? (k, v, set) => { const f = filter(String(v)); if (f !== v) set(k, f); } : undefined,
    apply(v) { done(filter ? filter(String(v.value)) : String(v.value)); } });
}
/** The shape description file dialog (wxFileSelector): done(text) or done(null).  Swappable (pcb.setShapeFilePicker). */
export let shapeFilePicker = function (done: (text: string | null) => void): void {
  if (typeof document === "undefined") { done(null); return; }
  const inp = document.createElement("input"); inp.type = "file"; inp.style.display = "none";
  inp.addEventListener("change", () => { const f = inp.files && inp.files[0]; inp.remove(); if (!f) { done(null); return; } f.text().then((t) => done(t), () => done(null)); });
  document.body.appendChild(inp); inp.click();
};
export function setShapeFilePickerImpl(fn: typeof shapeFilePicker): void { shapeFilePicker = fn; }

/** MWAVE_POLYGONAL_SHAPE_DLG "Complex Shape": Shape (Normal / Symmetrical / Mirrored), Size X / Y, Read Shape Description File... */
function polygonDialog(done: () => void, fail: () => void): boolean {
  MW_SHAPE.edges = [];   // the constructor clears g_PolyEdges
  const units = userUnits(), unitLabel = units === "mil" ? "mils" : units;
  return openForm<{ shape: string; sx: string; sy: string }>({ title: "Complex Shape", width: 440,
    fields: [
      { k: "shape", label: "Shape", type: "radio", value: "0", options: [["0", "Normal"], ["1", "Symmetrical"], ["2", "Mirrored"]] },
      { type: "note", value: "Size" },
      { k: "sx", label: "X:", type: "text", value: "", unit: unitLabel }, { k: "sy", label: "Y:", type: "text", value: "", unit: unitLabel },
      { k: "read", label: "Read Shape Description File...", type: "button" },
    ],
    change(k, _v, set) {
      if (k !== "read") return;
      shapeFilePicker((text) => {
        if (text === null) return;
        const r = parseShapeDescription(text);
        MW_SHAPE.edges = r.edges; MW_SHAPE.scaleX = r.scaleX; MW_SHAPE.scaleY = r.scaleY;
        set("sx", stringFromIU(Math.trunc(r.scaleX), units)); set("sy", stringFromIU(Math.trunc(r.scaleY), units));   // m_sizeX->SetValue( (int) g_ShapeScaleX )
      });
    },
    apply(v) { MW_SHAPE.type = Number(v.shape) || 0; done(); } }) || (fail(), false);
}

/** MICROWAVE_PLACER::CreateItem: the dialogs, then done(footprint node at the origin) — or nothing on cancel / error. */
export function createMicrowaveItem(ctx: PcbCtx, kind: MwShape | "shape", done: (node: SNode) => void): void {
  const tw = trackWidthIU(ctx);
  if (kind === "shape") {
    polygonDialog(() => {
      if (MW_SHAPE.type === 2) MW_SHAPE.scaleY = -MW_SHAPE.scaleY;   // mirrored
      const f = polygonFootprint(MW_SHAPE.edges, MW_SHAPE.scaleX, MW_SHAPE.scaleY, MW_SHAPE.type, tw);
      MW_SHAPE.edges = [];
      if ("error" in f) { ctx.toast(f.error); return; }   // ShowInfoBarError
      done(footprintNode(f));
    }, () => { MW_SHAPE.edges = []; });
    return;
  }
  const caption = kind === "gap" ? "Gap Size:" : kind === "stub" ? "Stub Size:" : "Arc Stub Radius Value:";
  textEntry(caption, stringFromIU(tw), (text) => {
    const gap = valueFromString(text);
    if (kind !== "stubarc") { done(footprintNode(microwaveFootprint(kind, gap, 0, tw))); return; }
    textEntry("Angle in degrees:", "0.0", (a) => {
      const fval = toDouble(a);
      if (fval === null) { errorMessage(ctx, "Incorrect number, abort"); return; }
      let angle = fval; if (angle < 0) angle = -angle; if (angle > 180) angle = 180;
      done(footprintNode(microwaveFootprint(kind, gap, angle, tw)));
    });
  });
}

/** MICROWAVE_TOOL::createInductorBetween: the dialogs, then the footprint committed and selected (or the info bar's error). */
export function createInductorBetween(ctx: PcbCtx, a: Pt, b: Pt, after?: () => void): void {
  const start: IPt = [kiRound(a[0] * IU_PER_MM), kiRound(a[1] * IU_PER_MM)], end: IPt = [kiRound(b[0] * IU_PER_MM), kiRound(b[1] * IU_PER_MM)];
  const width = trackWidthIU(ctx);
  const minLen = Math.trunc(Math.hypot(end[0] - start[0], end[1] - start[1]));
  textEntry("Length of track:", stringFromIU(minLen), (text) => {
    const length = valueFromString(text);
    if (length < minLen) { ctx.toast("Requested length < minimum length"); return; }
    const buf: IPt[] = [];
    const res = buildCornersListSShape(buf, start, end, length, width);
    if (res !== "OK") { ctx.toast(S_SHAPE_ERRORS[res]); return; }
    textEntry("Component value:", "L", (value) => {
      if (!value) return;   // aborted
      if (ctx.viewOnly || !ctx.doc) return;
      const node = footprintNode(inductorFootprint(buf, start, end, width, value));
      const c = addedChange(ctx.doc, node);
      ctx.commit([c], "Add Microwave Inductor");
      applySelection(ctx, [c.id]);   // ACTIONS::selectItem
      if (after) after();
      ctx.requestRender();
    }, stripForbidden);
  });
}

/** The tool starts or ends: whatever was carried or half-drawn goes, and dialogs still open are retired. */
export function mwActivate(t: string): void {
  MW.gen++; MW.carry = null; MW.ghost = null; MW.ghostKey = ""; MW.line = null; MW.busy = false;
  (S as unknown as { kicursor?: string | null }).kicursor = null;
  if (t === "mwline") MW.line = null;
}
export const mwCarrying = (): boolean => !!MW.carry;
function setCarry(node: SNode | null): void { MW.carry = node; MW.ghost = null; MW.ghostKey = ""; (S as unknown as { kicursor?: string | null }).kicursor = node ? "PLACE" : null; }   // KICURSOR::PLACE while an item rides the cursor
/** A click of a microwave tool. */
export function mwClick(ctx: PcbCtx, t: string, at: Pt): void {
  if (t === "mwline") { lineClick(ctx, at); return; }
  const kind = MW_TOOLS[t]; if (!kind || MW.busy) return;
  if (!MW.carry) {
    if (ctx.viewOnly) return;
    MW.busy = true; const gen = MW.gen;
    createMicrowaveItem(ctx, kind, (node) => {
      if (gen !== MW.gen) return;
      const at2 = S.hover ? [S.hover.x, S.hover.y] : at;
      setFootprintAt(node, r6(at2[0]), r6(at2[1]), 0);   // newItem->SetPosition( cursorPos )
      setCarry(node); ctx.requestRender();
    });
    MW.busy = false;   // the dialogs are modal: a click under them never reaches the board
    return;
  }
  // the second click places it ("Place microwave feature"); IPO_REPEAT: the tool stays for another
  const node = MW.carry; const [, , rot] = K.atOf(node);
  setFootprintAt(node, r6(at[0]), r6(at[1]), rot);
  setCarry(null);
  if (!ctx.viewOnly && ctx.doc) ctx.commit([addedChange(ctx.doc, node)], "Place microwave feature");
  ctx.requestRender();
}
/** Motion: the carried footprint follows the cursor; the line's end follows once its origin is set. */
export function mwMove(ctx: PcbCtx, t: string, at: Pt): void {
  if (MW.carry) { const [, , rot] = K.atOf(MW.carry); setFootprintAt(MW.carry, r6(at[0]), r6(at[1]), rot); }
  if (t === "mwline" && MW.line) {
    const L = MW.line; L.end = vectorSnapped(angleSnapMode(), L.origin, at); L.shown = true;   // TWO_POINT_GEOMETRY_MANAGER::SetAngleSnap
  }
}
function lineClick(ctx: PcbCtx, at: Pt): void {
  if (MW.busy) return;
  if (!MW.line) { MW.line = { origin: [at[0], at[1]], end: [at[0], at[1]], shown: false, down: [at[0], at[1]] }; return; }   // a click or a drag starts
  MW.line.end = vectorSnapped(angleSnapMode(), MW.line.origin, at);   // the click sets the end (SetEnd( cursorPos ))
  finishLine(ctx);
}
/** The release of a press-drag is the end point. */
export function mwUp(ctx: PcbCtx, at: Pt, pxPerMm: number): boolean {
  const L = MW.line; if (!L || !L.down) return false;
  const moved = Math.hypot(at[0] - L.down[0], at[1] - L.down[1]) * Math.max(pxPerMm, 1e-6) > 3;
  L.down = null;
  if (!moved) return false;
  L.end = vectorSnapped(angleSnapMode(), L.origin, at);
  finishLine(ctx); return true;
}
function finishLine(ctx: PcbCtx): void {
  const L = MW.line; if (!L) return;
  MW.line = null;   // start again if needed
  if (ctx.viewOnly) { ctx.requestRender(); return; }
  createInductorBetween(ctx, L.origin, L.end);
  ctx.requestRender();
}
/** IsCancelInteractive: the carried item (or the line's origin) goes; false when there was nothing (the tool ends). */
export function mwCancel(): boolean {
  if (MW.carry) { setCarry(null); return true; }
  if (MW.line) { MW.line = null; return true; }
  return false;
}
/** IPO_ROTATE: newItem->Rotate( its position, the rotation angle ). */
export function mwRotate(ctx: PcbCtx, deg: number): boolean {
  if (!MW.carry) return false;
  rotateFootprintNode(MW.carry, deg); MW.ghost = null; MW.ghostKey = ""; ctx.requestRender(); return true;
}
/** IPO_FLIP: newItem->Flip( its position, m_FlipDirection ) — top / bottom is the left / right flip turned by 180. */
export function mwFlip(ctx: PcbCtx, dir: "lr" | "tb"): boolean {
  if (!MW.carry) return false;
  flipFootprintNode(MW.carry); if (dir !== "lr") rotateFootprintNode(MW.carry, 180);
  MW.ghost = null; MW.ghostKey = ""; ctx.requestRender(); return true;
}
/** PCB_ACTIONS::properties on the carried item (OnEditItemRequest): the footprint dialog edits it in place. */
export function mwProperties(ctx: PcbCtx): boolean {
  if (!MW.carry) return false;
  const dlg = newItemDialogs.footprint; if (!dlg) return true;
  const c = MW.carry, gen = MW.gen;
  dlg(ctx, K.cloneNode(c), (n: SNode | null) => { if (!n || MW.carry !== c || gen !== MW.gen) return; setCarry(n); ctx.requestRender(); });
  return true;
}

// ---------------------------------------------------------------- the previews
const INDUCTOR_FILL = "rgba(77, 77, 128, 0.3)", INDUCTOR_STROKE = "rgb(102, 255, 255)";
/** CENTRELINE_RECT_ITEM (aspect 0.5) along the line being drawn, and the carried footprint as it will be placed. */
export function drawMicrowavePreview(c: CanvasRenderingContext2D, view: KView, ctx: PcbCtx, px: number): void {
  const L = MW.line;
  if (L && L.shown) {
    const clx = L.end[0] - L.origin[0], cly = L.end[1] - L.origin[1];
    const sx = -cly * 0.5, sy = clx * 0.5;   // GetRotated( cl, ANGLE_90 ) * aspect (Y down)
    let x = L.origin[0] + sx / 2, y = L.origin[1] + sy / 2;
    c.save(); c.beginPath(); c.moveTo(x, y); x += clx; y += cly; c.lineTo(x, y); x -= sx; y -= sy; c.lineTo(x, y); x -= clx; y -= cly; c.lineTo(x, y); c.closePath();
    c.fillStyle = INDUCTOR_FILL; c.fill(); c.strokeStyle = INDUCTOR_STROKE; c.lineWidth = px; c.stroke(); c.restore();
  }
  if (MW.carry && ctx.doc) {
    const key = K.serialize(MW.carry);
    if (!MW.ghost || MW.ghostKey !== key) {
      const ver = (ctx.doc as { version?: number }).version || BOARD_VERSION;
      MW.ghost = K.parseDoc(`(kicad_pcb (version ${ver}) (generator "pcbnew") ${key})`); MW.ghostKey = key;
    }
    c.save();
    (K.render as unknown as (d: KDoc, g: CanvasRenderingContext2D, v: KView, o: Record<string, unknown>) => void)(MW.ghost, c, view, { background: false, overlay: true, frame: false, grid: 0 });
    c.restore();
  }
}
