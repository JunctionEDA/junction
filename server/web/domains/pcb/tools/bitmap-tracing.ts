// tools/bitmap-tracing.ts — common/bitmap_tracing.cpp: an image turned black and white at a threshold
// (ConvertImageToBilevel) and its black regions traced with potrace into filled outlines, holes cut in and joined to
// their outline (TraceBilevelImage).  Both editors' Convert to Outlines command runs it on a reference image.
import { ClipType, FillRule, PolyTree64, booleanOpWithPolyTree, union, type Path64, type Paths64, type PolyPath64 } from "clipper2-ts";
import { fracture } from "../fab/poly";
import type { Pt } from "../fab/prims";
import { CORNER, CURVETO, bmNew, bmPut, potraceParamDefault, potraceTrace, STATUS_OK, type DPoint } from "./potrace";

/** RGBA pixels, as a canvas hands them out. */
export interface RgbaImage { w: number; h: number; data: ArrayLike<number> }

/** wxImage::ConvertToGreyscale with its default weights (wxColour::MakeGrey rounds). */
function grey(r: number, g: number, b: number): number { return Math.floor(r * 0.299 + g * 0.587 + b * 0.114 + 0.5) & 0xff; }

/**
 * ConvertImageToBilevel: each pixel 0 (black) when its grey level, inverted on request, is under the threshold and it
 * is opaque enough (alpha over 0.7 of the threshold), else 255.  `threshold` is 0 .. 1.
 */
export function convertImageToBilevel(img: RgbaImage, threshold: number, invert: boolean): Uint8Array {
  const n = img.w * img.h, out = new Uint8Array(n), d = img.data;
  const thr = Math.trunc(threshold * 255) & 0xff;   // const unsigned char threshold = aThreshold * 255
  const alphaThr = Math.trunc(0.7 * thr) & 0xff;
  for (let i = 0; i < n; i++) {
    let level = grey(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    if (invert) level = ~level & 0xff;
    out[i] = level < thr && d[i * 4 + 3] > alphaThr ? 0 : 255;
  }
  return out;
}

/** The bilevel levels as RGBA (for the preview drawn in place of the image). */
export function bilevelRgba(levels: Uint8Array, alpha?: ArrayLike<number>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(levels.length * 4);
  for (let i = 0; i < levels.length; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = levels[i];
    out[i * 4 + 3] = alpha ? alpha[i * 4 + 3] : 255;   // ConvertToGreyscale keeps the alpha channel
  }
  return out;
}

/** BezierToPolyline: the curve p1 .. p4 as segments no further than a quarter pixel from it (p1 not included). */
function bezierToPolyline(buf: DPoint[], p1: DPoint, p2: DPoint, p3: DPoint, p4: DPoint): void {
  const square = (x: number): number => x * x, cube = (x: number): number => x * x * x;
  const delta = 0.25;   // the desired accuracy, in pixels
  const dd0 = square(p1.x - 2 * p2.x + p3.x) + square(p1.y - 2 * p2.y + p3.y);
  const dd1 = square(p2.x - 2 * p3.x + p4.x) + square(p2.y - 2 * p3.y + p4.y);
  const dd = 6 * Math.sqrt(Math.max(dd0, dd1));
  const e2 = 8 * delta <= dd ? 8 * delta / dd : 1;
  const epsilon = Math.sqrt(e2);   // the necessary interval size
  for (let t = epsilon; t < 1; t += epsilon) {
    buf.push({
      x: p1.x * cube(1 - t) + 3 * p2.x * square(1 - t) * t + 3 * p3.x * (1 - t) * square(t) + p4.x * cube(t),
      y: p1.y * cube(1 - t) + 3 * p2.y * square(1 - t) * t + 3 * p3.y * (1 - t) * square(t) + p4.y * cube(t),
    });
  }
  buf.push(p4);
}

/** KiROUND. */
const kiRound = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));

/** SHAPE_POLY_SET::Simplify of single outlines: their union, holes the other way round. */
function simplify(paths: Paths64): Paths64 { return paths.length ? union(paths.filter((p) => p.length >= 3), FillRule.NonZero) : []; }

/** a − b as polygons (an outline and the holes it owns), from Clipper's tree. */
function subtractPolygons(a: Paths64, b: Paths64): Path64[][] {
  const tree = new PolyTree64();
  booleanOpWithPolyTree(ClipType.Difference, a, b, tree, FillRule.NonZero);
  const out: Path64[][] = [];
  const walk = (node: PolyPath64): void => {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i);
      const pg: Path64[] = [outer.poly || []];
      for (let j = 0; j < outer.count; j++) {
        const hole = outer.child(j);
        pg.push(hole.poly || []);
        walk(hole);   // islands inside a hole are polygons of their own
      }
      out.push(pg);
    }
  };
  walk(tree);
  return out.filter((pg) => pg[0].length >= 3);
}

export interface TraceResult { outlines: Pt[][]; warnings: string[]; errors: string[] }

/**
 * TraceBilevelImage: the black pixels of a bilevel image (0 black) traced into outlines in internal units, a pixel
 * being scaleX by scaleY units.  Each positive path is filled less its negative children, and the polygons with holes
 * are fractured into simple outlines.
 */
export function traceBilevelImage(levels: Uint8Array, w: number, h: number, scaleX: number, scaleY: number): TraceResult {
  const res: TraceResult = { outlines: [], warnings: [], errors: [] };
  const bm = bmNew(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bmPut(bm, x, y, levels[y * w + x] ? 0 : 1);
  const param = potraceParamDefault();
  param.turdsize = 0;   // the area (in pixels) of the largest path to be ignored; potrace's default is 2
  param.opttolerance = 0.2;   // the curve optimization tolerance; potrace's default
  const st = potraceTrace(param, bm);
  if (st.status !== STATUS_OK) { res.errors.push("Error tracing bitmap: "); return res; }
  let buf: DPoint[] = [];
  let areas: Paths64 = [], holes: Paths64 = [];
  let mainOutline = true, droppedGroups = 0;
  for (let path = st.plist; path; path = path.next) {
    const cnt = path.curve.n, tag = path.curve.tag, c = path.curve.c;
    let startpoint = c[cnt - 1][2];
    for (let ii = 0; ii < cnt; ii++) {
      if (tag[ii] === CORNER) { buf.push(c[ii][1], c[ii][2]); startpoint = c[ii][2]; }
      else if (tag[ii] === CURVETO) { bezierToPolyline(buf, startpoint, c[ii][0], c[ii][1], c[ii][2]); startpoint = c[ii][2]; }
    }
    const target = mainOutline ? areas : holes;
    mainOutline = false;
    target.push(buf.map((pt) => ({ x: kiRound(pt.x * scaleX), y: kiRound(pt.y * scaleY) })));
    buf = [];
    // at the end of a group of a positive path and its negative children, fill
    if (path.next === null || path.next.sign === "+") {
      areas = simplify(areas);
      holes = simplify(holes);
      // BooleanSubtract then NormalizeAreaOutlines: the outline less its holes, as simple polygons
      const polys = areas.length ? subtractPolygons(areas, holes) : [];
      if (polys.length) {
        for (const pg of polys) {   // Fracture: the holes joined to their outline by cuts
          const pts = pg.map((p) => p.map((q) => [q.x, q.y] as Pt));
          for (const f of pts.length > 1 ? fracture(pts) : pts) res.outlines.push(f);
        }
      } else droppedGroups++;
      // start the next group even after a failure, so one bad group loses only itself
      areas = []; holes = [];
      mainOutline = true;
    }
  }
  if (droppedGroups > 0) res.warnings.push(droppedGroups === 1 ? `${droppedGroups} region of the image could not be traced.` : `${droppedGroups} regions of the image could not be traced.`);
  return res;
}

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
/** RotatePoint( int*, int*, EDA_ANGLE ) about the origin: the right angles exact, the others rounded (KiROUND). */
export function rotatePointIU(x: number, y: number, deg: number): [number, number] {
  const a = normalizeDeg(deg);
  if (a === 0) return [x, y];
  if (a === 90) return [y, -x];
  if (a === 180) return [-x, -y];
  if (a === 270) return [-y, x];
  const s = angleSin(a), c = angleCos(a);
  return [kiRound(y * s + x * c), kiRound(y * c - x * s)];
}

/** A reference image as the tracer sees it, in internal units: REFERENCE_IMAGE's position, GetSize and orientation. */
export interface TracedImagePlace { posX: number; posY: number; sizeX: number; sizeY: number; rotation: number }

/**
 * The traced outlines placed where the image is drawn (DRAWING_TOOL / SCH_EDIT_TOOL::ConvertImageToOutlines): moved by
 * the image's top-left corner (position - size / 2) and turned by its orientation about its position.
 */
export function placeTracedOutlines(outlines: Pt[][], place: TracedImagePlace): Pt[][] {
  const ox = place.posX - Math.trunc(place.sizeX / 2), oy = place.posY - Math.trunc(place.sizeY / 2);
  return outlines.map((o) => o.map(([x, y]) => {
    const [rx, ry] = rotatePointIU(x + ox - place.posX, y + oy - place.posY, place.rotation);
    return [rx + place.posX, ry + place.posY] as Pt;
  }));
}

/**
 * The whole conversion after the dialog: the image made bilevel at the threshold, traced at size / pixels units per
 * pixel and placed over the image.  An empty result carries the message KiCad shows instead.
 */
export function imageToOutlines(img: RgbaImage, threshold: number, invert: boolean, place: TracedImagePlace): TraceResult {
  const bilevel = convertImageToBilevel(img, threshold, invert);
  const res = traceBilevelImage(bilevel, img.w, img.h, place.sizeX / img.w, place.sizeY / img.h);
  res.outlines = placeTracedOutlines(res.outlines, place);
  return res;
}
