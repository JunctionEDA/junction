// geom2d.ts — the 2D geometry behind the Feature API's `Geo2` (script/assets/feature-api.d.ts): regions with
// holes, offsets and booleans (Clipper2), rounding of corners, arcs recovered from polylines, Delaunay and
// Voronoi, cell patterns, distances.  Pure: no kernel, no DOM; it runs on the host side of the script sandbox,
// so a script pays for one call, not for the arithmetic.
//
// A loop is a closed list of vertices `[x, y]` or `[x, y, bulge]`: the bulge is that of the edge from this
// vertex to the next (tan of a quarter of the arc's angle, positive for an arc that turns counter-clockwise, 0 or absent for a straight
// edge), as in DXF.  A region is an outer loop, counter-clockwise, and its holes, clockwise.  Everything is
// millimetres in the plane the caller works in.
import { ClipType, EndType, FillRule, JoinType, PolyTreeD, booleanOpDWithPolyTree, inflatePathsD, triangulateD, type PathD, type PathsD, type PolyPathD } from "clipper2-ts";

export type Pt = [number, number];
export type Vertex = [number, number] | [number, number, number];
export type Loop = Vertex[];
export interface Region { outer: Loop; holes: Loop[] }
export type Shape2 = Loop | Region | (Loop | Region)[];

/** decimal places Clipper keeps (0.1 µm) and how far a flattened arc may stray from its circle */
const PREC = 4;
export const ARC_TOL = 0.002;
/** how far a polyline's vertices may lie from a circle to be read as an arc of it */
export const FIT_TOL = 0.01;
const MAX_VERTICES = 400000;

export class Geo2Error extends Error { constructor(m: string) { super(m); this.name = "Geo2Error"; } }

// ---------------------------------------------------------------- basics

export const signedArea = (poly: readonly (readonly number[])[]): number => {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
};
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkLoop(l: unknown): Loop {
  if (!Array.isArray(l) || l.length < 2) throw new Geo2Error("A loop is a list of at least two [x, y] points.");
  for (const v of l) if (!Array.isArray(v) || !isNum(v[0]) || !isNum(v[1]) || (v.length > 2 && !isNum(v[2]))) throw new Geo2Error("A loop's points are [x, y] or [x, y, bulge] with finite numbers.");
  return l as Loop;
}
const isLoop = (x: unknown): boolean => Array.isArray(x) && x.length > 0 && Array.isArray(x[0]) && typeof x[0][0] === "number";
const isRegion = (x: unknown): x is Region => !!x && typeof x === "object" && !Array.isArray(x) && Array.isArray((x as Region).outer);

/** The centre, radius and swept angle (signed) of the arc from `a` to `b` with a bulge. */
export function arcOf(a: readonly number[], b: readonly number[], bulge: number): { c: Pt; r: number; sweep: number; a0: number } {
  const chord = dist(a, b), sweep = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(sweep) / 2));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const h = (chord / 2) * (1 - bulge * bulge) / (2 * bulge);   // signed distance from the chord's middle to the centre, to the left
  const ux = (b[0] - a[0]) / chord, uy = (b[1] - a[1]) / chord;
  const c: Pt = [mx - uy * h, my + ux * h];
  return { c, r, sweep, a0: Math.atan2(a[1] - c[1], a[0] - c[0]) };
}
/** The point half-way along the arc from `a` to `b`. */
export function arcMid(a: readonly number[], b: readonly number[], bulge: number): Pt {
  const chord = dist(a, b), ux = (b[0] - a[0]) / chord, uy = (b[1] - a[1]) / chord, s = (bulge * chord) / 2;
  return [(a[0] + b[0]) / 2 + uy * s, (a[1] + b[1]) / 2 - ux * s];
}

/** A loop as a plain polygon: arcs become chords no further than `tol` from them. */
export function flatten(loop: Loop, tol = ARC_TOL): Pt[] {
  const out: Pt[] = [];
  for (let i = 0, n = loop.length; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n], bulge = a[2] || 0;
    out.push([a[0], a[1]]);
    if (!bulge || dist(a, b) < 1e-9) continue;
    const { c, r, sweep, a0 } = arcOf(a, b, bulge);
    const step = 2 * Math.acos(Math.max(0, Math.min(1, 1 - tol / r)));
    const k = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 0.02)));
    for (let j = 1; j < k; j++) { const t = a0 + (sweep * j) / k; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  }
  return out;
}

const toPath = (poly: readonly (readonly number[])[]): PathD => poly.map((p) => ({ x: p[0], y: p[1] }));
const fromPath = (p: PathD): Pt[] => p.map((q) => [q.x, q.y]);

/** Whatever a script may hand over as "a shape", as Clipper paths: outers counter-clockwise, holes clockwise. */
function pathsOf(shape: unknown): PathsD {
  const out: PathsD = [];
  let count = 0;
  const add = (loop: Loop, hole: boolean) => {
    const poly = flatten(checkLoop(loop));
    if (poly.length < 3) return;
    count += poly.length;
    if (count > MAX_VERTICES) throw new Geo2Error("The shape has too many points (more than 400 000). Use a coarser pattern.");
    if ((signedArea(poly) < 0) !== hole) poly.reverse();
    out.push(toPath(poly));
  };
  const walk = (x: unknown) => {
    if (x == null) return;
    if (isRegion(x)) { add(x.outer, false); for (const h of x.holes || []) add(h, true); return; }
    if (isLoop(x)) { add(x as Loop, false); return; }
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    throw new Geo2Error("Expected a loop ([[x, y], …]), a region ({ outer, holes }) or a list of them.");
  };
  walk(shape);
  return out;
}

function regionsOfTree(tree: PolyTreeD): Region[] {
  const out: Region[] = [];
  const walk = (node: PolyPathD) => {
    for (let i = 0; i < node.count; i++) {
      const outer = node.child(i);
      const region: Region = { outer: fromPath(outer.poly || []), holes: [] };
      for (let j = 0; j < outer.count; j++) { const hole = outer.child(j); region.holes.push(fromPath(hole.poly || [])); walk(hole); }
      if (region.outer.length >= 3) out.push(region);
    }
  };
  walk(tree);
  return out;
}

function bool(type: ClipType, a: PathsD, b: PathsD | null): Region[] {
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(type, a, b, tree, FillRule.NonZero, PREC);
  return regionsOfTree(tree);
}
const pathsOfRegions = (rs: readonly Region[]): PathsD => { const out: PathsD = []; for (const r of rs) { out.push(toPath(r.outer)); for (const h of r.holes) out.push(toPath(h)); } return out; };

/** A shape as clean regions (overlaps merged, arcs flattened). */
export function regions(shape: unknown): Region[] { return bool(ClipType.Union, pathsOf(shape), null); }
export function union(a: unknown, b?: unknown): Region[] { return bool(ClipType.Union, [...pathsOf(a), ...pathsOf(b)], null); }
export function difference(a: unknown, b: unknown): Region[] { const pa = pathsOfRegions(regions(a)), pb = pathsOfRegions(regions(b)); return pb.length ? bool(ClipType.Difference, pa, pb) : regionsOfPaths(pa); }
export function intersection(a: unknown, b: unknown): Region[] { const pa = pathsOfRegions(regions(a)), pb = pathsOfRegions(regions(b)); return pa.length && pb.length ? bool(ClipType.Intersection, pa, pb) : []; }
export function xor(a: unknown, b: unknown): Region[] { return bool(ClipType.Xor, pathsOfRegions(regions(a)), pathsOfRegions(regions(b))); }
const regionsOfPaths = (p: PathsD): Region[] => bool(ClipType.Union, p, null);

/** Grow (d > 0) or shrink (d < 0) a shape.  `join` is how outside corners are made: round (default), miter or square. */
export function offset(shape: unknown, d: number, join: "round" | "miter" | "square" = "round"): Region[] {
  if (!isNum(d)) throw new Geo2Error("offset needs a distance in mm.");
  const paths = pathsOfRegions(regions(shape));
  if (!paths.length) return [];
  if (Math.abs(d) < 1e-9) return regionsOfPaths(paths);
  const jt = join === "miter" ? JoinType.Miter : join === "square" ? JoinType.Square : JoinType.Round;
  return regionsOfPaths(inflatePathsD(paths, d, jt, EndType.Polygon, 4, PREC, ARC_TOL));
}

/**
 * Round the corners of a shape with one radius: the corners that point outwards (what a cutter of that radius
 * leaves in a pocket), and with `reflex` also those that point inwards.  Parts narrower than twice the radius
 * are removed, as they could not be cut either.
 */
export function round(shape: unknown, radius: number, reflex = 0): Region[] {
  if (!(radius >= 0) || !(reflex >= 0)) throw new Geo2Error("round needs a radius of zero or more.");
  let out = regions(shape);
  if (radius > 1e-9) out = offset(offset(out, -radius, "miter"), radius, "round");
  // (grown with sharp corners and shrunk with round ones: the corners that point outwards come back exactly)
  if (reflex > 1e-9) out = offset(offset(out, reflex, "miter"), -reflex, "round");
  return out;
}

// ---------------------------------------------------------------- arcs back from polylines

function circle3(a: readonly number[], b: readonly number[], c: readonly number[]): { c: Pt; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [x, y], r: Math.hypot(a[0] - x, a[1] - y) };
}

/**
 * Read arcs out of a polygon: a run of at least three edges whose corners lie on one circle (within `tol`) and
 * that turn the same way becomes one arc.  What Clipper returns for a rounded corner or a circle comes back as
 * the arc it was, so the solid built from it has cylindrical faces, not facets.
 */
export function fitArcs(input: readonly (readonly number[])[], tol = FIT_TOL): Loop {
  const poly = input;
  const n = poly.length;
  if (n < 4) return poly.map((p) => [p[0], p[1]] as Vertex);
  const P = (i: number) => poly[((i % n) + n) % n];
  const maxSag = Math.max(0.05, tol * 4);
  /** the arc through corners i..j (j > i, indices not wrapped), or null */
  const arc = (i: number, j: number): { c: Pt; r: number; sweep: number } | null => {
    const fit = circle3(P(i), P((i + j) >> 1), P(j));
    if (!fit || fit.r > 2000 || fit.r < tol * 2) return null;
    let sweep = 0, sign = 0;
    for (let k = i; k < j; k++) {
      const a = P(k), b = P(k + 1);
      if (Math.abs(dist(b, fit.c) - fit.r) > tol || Math.abs(dist(a, fit.c) - fit.r) > tol) return null;
      const chord = dist(a, b);
      if (chord > 2 * fit.r) return null;
      if (fit.r - Math.sqrt(Math.max(0, fit.r * fit.r - (chord * chord) / 4)) > maxSag) return null;
      const cr = (a[0] - fit.c[0]) * (b[1] - fit.c[1]) - (a[1] - fit.c[1]) * (b[0] - fit.c[0]);
      const s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return null;
      sign = s;
      sweep += s * 2 * Math.asin(Math.min(1, chord / (2 * fit.r)));
    }
    if (Math.abs(sweep) > Math.PI * 1.95) return null;
    return { c: fit.c, r: fit.r, sweep };
  };
  // a whole circle
  if (n >= 8) {
    const fit = circle3(P(0), P(Math.floor(n / 3)), P(Math.floor((2 * n) / 3)));
    if (fit && fit.r < 5000) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const chord = dist(P(k), P(k + 1));
        if (Math.abs(dist(P(k), fit.c) - fit.r) > tol || fit.r - Math.sqrt(Math.max(0, fit.r * fit.r - (chord * chord) / 4)) > maxSag) ok = false;
      }
      if (ok) { const b = signedArea(poly) > 0 ? 1 : -1; return [[fit.c[0] + fit.r, fit.c[1], b], [fit.c[0] - fit.r, fit.c[1], b]]; }
    }
  }
  const walk = (start: number): { loop: Loop; firstBreak: number } => {
    const loop: Loop = [];
    let firstBreak = -1, i = start;
    const end = start + n;
    while (i < end) {
      let j = Math.min(i + 3, end), best: ReturnType<typeof arc> = null, bestJ = -1;
      if (j - i === 3) {
        let a = arc(i, j);
        while (a) { best = a; bestJ = j; if (j >= end) break; j++; a = arc(i, j); }
      }
      // a run that barely turns stays straight edges: an arc of a few degrees is all numerical trouble
      if (best && Math.abs(best.sweep) > 0.15) { loop.push([P(i)[0], P(i)[1], Math.tan(best.sweep / 4)]); i = bestJ; }
      else { loop.push([P(i)[0], P(i)[1]]); i++; }
      if (firstBreak < 0) firstBreak = i;
    }
    return { loop, firstBreak };
  };
  const first = walk(0);
  // the walk began at an arbitrary corner, perhaps in the middle of an arc: begin again where its first piece ended
  const loop = first.firstBreak > 0 && first.firstBreak < n ? walk(first.firstBreak).loop : first.loop;
  return straighten(loop, 0.02);
}

/** Drop the corners of the straight runs of a loop that lie within `eps` of the line between the ones kept: near-flat facets are the kernel's weak spot. */
function straighten(loop: Loop, eps: number): Loop {
  const n = loop.length;
  if (n < 5) return loop;
  // a corner may go only when the edge into it and the edge out of it are both straight
  const plain = (i: number) => !(loop[i][2]) && !(loop[(i + n - 1) % n][2]);
  const start = loop.findIndex((_, i) => !plain(i));
  if (start < 0) {
    const keep = mainCorners(loop, eps);
    return keep.length >= 3 ? keep.map((i) => loop[i]) : loop;
  }
  const out: Loop = [];
  let i = 0;
  while (i < n) {
    const at = (start + i) % n;
    out.push(loop[at]);
    // the run of removable corners after this fixed one, up to the next fixed one
    let j = i + 1;
    while (j < n && plain((start + j) % n)) j++;
    if (j - i > 2) {
      const run: Vertex[] = []; for (let q = i; q <= j; q++) run.push(loop[(start + q) % n]);
      const keep = new Set<number>([0, run.length - 1]);
      const split = (a: number, b: number) => {
        let worst = -1, w = -1;
        for (let q = a + 1; q < b; q++) { const d = segDist(run[q], run[a], run[b]); if (d > worst) { worst = d; w = q; } }
        if (worst > eps && w >= 0) { keep.add(w); split(a, w); split(w, b); }
      };
      split(0, run.length - 1);
      for (let q = 1; q < run.length - 1; q++) if (keep.has(q)) out.push(run[q]);
    } else for (let q = i + 1; q < j; q++) out.push(loop[(start + q) % n]);
    i = j;
  }
  return out.length >= 3 ? out : loop;
}

/** Regions with their arcs read back (see `fitArcs`); `arcs: false` leaves them as the polygons they are. */
export function withArcs(shape: unknown, arcs = true, tol = FIT_TOL): Region[] {
  const rs = regions(shape);
  return arcs ? rs.map((r) => ({ outer: fitArcs(r.outer, tol), holes: r.holes.map((h) => fitArcs(h, tol)) })) : rs;
}

// ---------------------------------------------------------------- measures

export function area(shape: unknown): number {
  let a = 0;
  for (const r of regions(shape)) { a += Math.abs(signedArea(r.outer)); for (const h of r.holes) a -= Math.abs(signedArea(h)); }
  return a;
}
export function bounds(shape: unknown): { min: Pt; max: Pt; size: Pt; centre: Pt } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pathsOf(shape)) for (const q of p) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  if (x0 > x1) return { min: [0, 0], max: [0, 0], size: [0, 0], centre: [0, 0] };
  return { min: [x0, y0], max: [x1, y1], size: [x1 - x0, y1 - y0], centre: [(x0 + x1) / 2, (y0 + y1) / 2] };
}
export function centroid(shape: unknown): Pt {
  let a = 0, cx = 0, cy = 0;
  const add = (poly: Pt[]) => {
    for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n], w = p[0] * q[1] - q[0] * p[1]; a += w; cx += (p[0] + q[0]) * w; cy += (p[1] + q[1]) * w; }
  };
  for (const r of regions(shape)) { add(r.outer as Pt[]); for (const h of r.holes) add(h as Pt[]); }
  return Math.abs(a) < 1e-12 ? bounds(shape).centre : [cx / (3 * a), cy / (3 * a)];
}
function inPoly(poly: readonly (readonly number[])[], p: readonly number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function contains1(rs: readonly Region[], p: readonly number[]): boolean {
  return rs.some((r) => inPoly(r.outer, p) && !r.holes.some((h) => inPoly(h, p)));
}
/** Whether a point is inside a shape (in its material, not in a hole of it). */
export function contains(shape: unknown, p: Pt): boolean { return contains1(regions(shape), p); }
const segDist = (p: readonly number[], a: readonly number[], b: readonly number[]): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};
const loopsOf = (rs: readonly Region[]): Loop[] => rs.flatMap((r) => [r.outer, ...r.holes]);
/** The distance from a point to the nearest edge of a shape. */
export function distance(shape: unknown, p: Pt): number {
  let best = Infinity;
  for (const l of loopsOf(regions(shape))) for (let i = 0; i < l.length; i++) best = Math.min(best, segDist(p, l[i], l[(i + 1) % l.length]));
  return best;
}
/** The smallest gap between two shapes; 0 when they touch or overlap. */
export function clearance(a: unknown, b: unknown): number {
  const ra = regions(a), rb = regions(b);
  if (!ra.length || !rb.length) return Infinity;
  if (intersection(ra, rb).length) return 0;
  let best = Infinity;
  const la = loopsOf(ra), lb = loopsOf(rb);
  for (const x of la) for (const p of x) for (const y of lb) for (let i = 0; i < y.length; i++) best = Math.min(best, segDist(p, y[i], y[(i + 1) % y.length]));
  for (const y of lb) for (const p of y) for (const x of la) for (let i = 0; i < x.length; i++) best = Math.min(best, segDist(p, x[i], x[(i + 1) % x.length]));
  return best;
}

// ---------------------------------------------------------------- shapes

export function rect(x: number, y: number, w: number, h: number): Loop { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
export function circle(c: Pt, r: number): Loop {
  if (!(r > 0)) throw new Geo2Error("A circle needs a radius above zero.");
  return [[c[0] + r, c[1], 1], [c[0] - r, c[1], 1]];
}
export function ngon(c: Pt, r: number, sides: number, angleDeg = 0): Loop {
  const n = Math.round(sides);
  if (!(n >= 3 && n <= 720) || !(r > 0)) throw new Geo2Error("A polygon needs 3 to 720 sides and a radius above zero.");
  const out: Loop = [];
  for (let i = 0; i < n; i++) { const t = (angleDeg * Math.PI) / 180 + (2 * Math.PI * i) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
}
/** A slot: the shape a cutter of `width` leaves going from `a` to `b` (round ends). */
export function slot(a: Pt, b: Pt, width: number): Loop {
  const l = dist(a, b), r = width / 2;
  if (!(r > 0)) throw new Geo2Error("A slot needs a width above zero.");
  if (l < 1e-9) return circle(a, r);
  const ux = (b[0] - a[0]) / l, uy = (b[1] - a[1]) / l, nx = -uy * r, ny = ux * r;
  return [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny, 1], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny, 1]];
}
/** Lines given a width: each segment `[a, b]` becomes a strip with round ends, all merged. */
export function thicken(segments: [Pt, Pt][], width: number): Region[] {
  if (!(width > 0)) throw new Geo2Error("thicken needs a width above zero.");
  return union(segments.map(([a, b]) => slot(a, b, width)));
}

export function translate(shape: unknown, d: Pt): Region[] { return mapShape(shape, (p) => [p[0] + d[0], p[1] + d[1]]); }
export function rotate(shape: unknown, deg: number, about: Pt = [0, 0]): Region[] {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  return mapShape(shape, (p) => [about[0] + (p[0] - about[0]) * c - (p[1] - about[1]) * s, about[1] + (p[0] - about[0]) * s + (p[1] - about[1]) * c]);
}
export function scale(shape: unknown, f: number, about: Pt = [0, 0]): Region[] {
  if (!isNum(f) || !f) throw new Geo2Error("scale needs a factor other than zero.");
  return mapShape(shape, (p) => [about[0] + (p[0] - about[0]) * f, about[1] + (p[1] - about[1]) * f]);
}
/** Mirror in the line through `a` and `b`. */
export function mirror(shape: unknown, a: Pt, b: Pt): Region[] {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (!l2) throw new Geo2Error("mirror needs two different points on the mirror line.");
  return mapShape(shape, (p) => { const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; return [2 * (a[0] + t * dx) - p[0], 2 * (a[1] + t * dy) - p[1]]; });
}
function mapShape(shape: unknown, f: (p: Pt) => Pt): Region[] {
  // a mirror turns every loop the other way round; non-zero filling reads both ways the same
  return regionsOfPaths(pathsOfRegions(regions(shape)).map((path) => path.map((q) => { const p = f([q.x, q.y]); return { x: p[0], y: p[1] }; })));
}

// ---------------------------------------------------------------- Delaunay, Voronoi, triangulation

/** The Delaunay triangulation of points (Bowyer–Watson): triangles as index triples, counter-clockwise, and the edges once each. */
export function delaunay(points: Pt[]): { triangles: [number, number, number][]; edges: [number, number][] } {
  const n = points.length;
  if (n > 4000) throw new Geo2Error("delaunay takes at most 4000 points.");
  for (const p of points) if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) throw new Geo2Error("delaunay takes a list of [x, y] points.");
  if (n < 2) return { triangles: [], edges: [] };
  if (n === 2) return { triangles: [], edges: [[0, 1]] };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const span = Math.max(x1 - x0, y1 - y0, 1) * 64, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const pts: Pt[] = [...points, [mx - span, my - span], [mx + span, my - span], [mx, my + span]];
  type Tri = { v: [number, number, number]; c: Pt; r2: number };
  const make = (a: number, b: number, c: number): Tri | null => {
    const f = circle3(pts[a], pts[b], pts[c]);
    if (!f) return null;
    const ccw = (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]) > 0;
    return { v: ccw ? [a, b, c] : [a, c, b], c: f.c, r2: f.r * f.r };
  };
  let tris: Tri[] = [make(n, n + 1, n + 2)!];
  // a fixed order that does not depend on how the caller listed coincident runs: by x, then y, then index
  const order = points.map((_, i) => i).sort((a, b) => points[a][0] - points[b][0] || points[a][1] - points[b][1] || a - b);
  const seen = new Set<string>();
  for (const i of order) {
    const key = `${Math.round(points[i][0] * 1e6)},${Math.round(points[i][1] * 1e6)}`;
    if (seen.has(key)) continue;   // a repeated point adds nothing
    seen.add(key);
    const p = pts[i], bad: Tri[] = [], keep: Tri[] = [];
    for (const t of tris) { const dx = p[0] - t.c[0], dy = p[1] - t.c[1]; (dx * dx + dy * dy < t.r2 * (1 + 1e-12) ? bad : keep).push(t); }
    const count = new Map<string, [number, number]>();
    for (const t of bad) for (let e = 0; e < 3; e++) {
      const a = t.v[e], b = t.v[(e + 1) % 3], k = a < b ? `${a},${b}` : `${b},${a}`;
      if (count.has(k)) count.delete(k); else count.set(k, [a, b]);
    }
    tris = keep;
    for (const [a, b] of count.values()) { const t = make(a, b, i); if (t) tris.push(t); }
  }
  const triangles = tris.filter((t) => t.v.every((v) => v < n)).map((t) => t.v);
  // points all on one line make no triangle: they are joined in order along it
  if (!triangles.length) {
    const distinct = order.filter((i, k) => k === 0 || dist(points[i], points[order[k - 1]]) > 1e-9);
    const chain: [number, number][] = [];
    for (let k = 1; k < distinct.length; k++) chain.push([Math.min(distinct[k - 1], distinct[k]), Math.max(distinct[k - 1], distinct[k])]);
    return { triangles: [], edges: chain.sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
  }
  triangles.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const es = new Map<string, [number, number]>();
  for (const t of triangles) for (let e = 0; e < 3; e++) { const a = Math.min(t[e], t[(e + 1) % 3]), b = Math.max(t[e], t[(e + 1) % 3]); es.set(`${a},${b}`, [a, b]); }
  const edges = Array.from(es.values()).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { triangles, edges };
}

/** Cut a convex polygon by the half-plane nearer to `a` than to `b`. */
function clipNearer(poly: Pt[], a: Pt, b: Pt): Pt[] {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, nx = b[0] - a[0], ny = b[1] - a[1];
  const side = (p: Pt) => (p[0] - mx) * nx + (p[1] - my) * ny;
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/** The Voronoi cell of each point, cut to a boundary shape: one list of regions per point (empty when its cell lies outside). */
export function voronoi(points: Pt[], within: unknown): Region[][] {
  if (points.length > 1500) throw new Geo2Error("voronoi takes at most 1500 points.");
  const b = bounds(within), pad = Math.max(b.size[0], b.size[1], 1);
  const box: Pt[] = [[b.min[0] - pad, b.min[1] - pad], [b.max[0] + pad, b.min[1] - pad], [b.max[0] + pad, b.max[1] + pad], [b.min[0] - pad, b.max[1] + pad]];
  const inside = regions(within);
  return points.map((p, i) => {
    let cell = box;
    for (let j = 0; j < points.length && cell.length >= 3; j++) if (j !== i && dist(p, points[j]) > 1e-9) cell = clipNearer(cell, p, points[j]);
    return cell.length >= 3 ? intersection(cell, inside) : [];
  });
}

/** A shape as triangles (each three points), for when a script needs to walk its area. */
export function triangulate(shape: unknown): Pt[][] {
  const paths = pathsOfRegions(regions(shape));
  if (!paths.length) return [];
  const r = triangulateD(paths, PREC, true);
  return r.solution.map(fromPath).filter((t) => t.length === 3);
}

// ---------------------------------------------------------------- patterns

export interface CellOptions { pitch: number; inset?: number; angle?: number; origin?: Pt }
/**
 * Cells of a regular pattern covering a boundary: "tri" (equilateral triangles of side `pitch`: an isogrid),
 * "hex" (hexagons `pitch` across flats), "square" and "diamond" (squares of side `pitch`).  `inset` shrinks
 * every cell by that much on each side, leaving walls of twice the inset between cells.  Cells that lie wholly
 * outside the boundary's box are left out; cut the rest to the boundary with `Geo2.intersection`.
 */
export function cells(kind: string, within: unknown, o: CellOptions): Loop[] {
  const pitch = o && o.pitch, inset = (o && o.inset) || 0, angle = (((o && o.angle) || 0) * Math.PI) / 180;
  if (!(pitch > 0)) throw new Geo2Error("cells needs a pitch above zero.");
  if (!(inset >= 0)) throw new Geo2Error("cells needs an inset of zero or more.");
  const b = bounds(within);
  const origin: Pt = (o && o.origin) || b.centre;
  const reach = Math.hypot(b.size[0], b.size[1]) / 2 + pitch * 2;
  const centreLocal: Pt = [b.centre[0] - origin[0], b.centre[1] - origin[1]];
  // the boundary's centre in the pattern's own (unrotated) frame
  const cl: Pt = [centreLocal[0] * Math.cos(-angle) - centreLocal[1] * Math.sin(-angle), centreLocal[0] * Math.sin(-angle) + centreLocal[1] * Math.cos(-angle)];
  const out: Loop[] = [];
  const place = (poly: Pt[]) => {
    const world = poly.map((p): Pt => [origin[0] + p[0] * Math.cos(angle) - p[1] * Math.sin(angle), origin[1] + p[0] * Math.sin(angle) + p[1] * Math.cos(angle)]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of world) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
    if (x1 < b.min[0] || x0 > b.max[0] || y1 < b.min[1] || y0 > b.max[1]) return;
    out.push(world);
    if (out.length > 20000) throw new Geo2Error("The pattern has more than 20 000 cells. Use a larger pitch.");
  };
  /** a regular polygon shrunk by `inset` on every side */
  const shrunk = (c: Pt, poly: Pt[], inradius: number): Pt[] | null => {
    if (inset >= inradius - 1e-6) return null;
    const f = (inradius - inset) / inradius;
    return poly.map((p) => [c[0] + (p[0] - c[0]) * f, c[1] + (p[1] - c[1]) * f]);
  };
  const k = kind === "isogrid" ? "tri" : kind;
  if (k === "tri") {
    const h = (pitch * Math.sqrt(3)) / 2, inr = h / 3;
    const i0 = Math.floor((cl[0] - reach) / pitch) - 1, i1 = Math.ceil((cl[0] + reach) / pitch) + 1;
    const j0 = Math.floor((cl[1] - reach) / h) - 1, j1 = Math.ceil((cl[1] + reach) / h) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = i * pitch + (j & 1 ? pitch / 2 : 0), y = j * h;
      const up: Pt[] = [[x, y], [x + pitch, y], [x + pitch / 2, y + h]];
      const down: Pt[] = [[x + pitch, y], [x + pitch * 1.5, y + h], [x + pitch / 2, y + h]];
      for (const t of [up, down]) { const c: Pt = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3]; const s = shrunk(c, t, inr); if (s) place(s); }
    }
  } else if (k === "hex") {
    const R = pitch / Math.sqrt(3), dx = pitch, dy = 1.5 * R;
    const i0 = Math.floor((cl[0] - reach) / dx) - 1, i1 = Math.ceil((cl[0] + reach) / dx) + 1;
    const j0 = Math.floor((cl[1] - reach) / dy) - 1, j1 = Math.ceil((cl[1] + reach) / dy) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c: Pt = [i * dx + (j & 1 ? dx / 2 : 0), j * dy];
      const hex: Pt[] = [];
      for (let q = 0; q < 6; q++) { const t = Math.PI / 6 + (q * Math.PI) / 3; hex.push([c[0] + R * Math.cos(t), c[1] + R * Math.sin(t)]); }
      const s = shrunk(c, hex, pitch / 2); if (s) place(s);
    }
  } else if (k === "square" || k === "diamond") {
    const turn = k === "diamond" ? Math.PI / 4 : 0;
    const i0 = Math.floor((cl[0] - reach) / pitch) - 1, i1 = Math.ceil((cl[0] + reach) / pitch) + 1;
    const j0 = Math.floor((cl[1] - reach) / pitch) - 1, j1 = Math.ceil((cl[1] + reach) / pitch) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c: Pt = [(i + 0.5) * pitch, (j + 0.5) * pitch], hw = pitch / 2 - inset;
      if (hw <= 1e-6) continue;
      const sq: Pt[] = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]].map((p): Pt => [c[0] + p[0], c[1] + p[1]]);
      // a diamond pattern is the square one turned 45° about the origin
      place(turn ? sq.map((p): Pt => [p[0] * Math.cos(turn) - p[1] * Math.sin(turn), p[0] * Math.sin(turn) + p[1] * Math.cos(turn)]) : sq);
    }
  } else throw new Geo2Error(`cells: the pattern is one of "tri", "hex", "square", "diamond" (not "${kind}").`);
  return out;
}

/** Points on a grid covering a boundary, those inside it only.  `stagger` shifts every other row by half a step. */
export function grid(within: unknown, o: { dx: number; dy?: number; stagger?: boolean; angle?: number; origin?: Pt; margin?: number }): Pt[] {
  const dx = o && o.dx, dy = (o && o.dy) || dx, angle = (((o && o.angle) || 0) * Math.PI) / 180, margin = (o && o.margin) || 0;
  if (!(dx > 0) || !(dy > 0)) throw new Geo2Error("grid needs dx (and dy) above zero.");
  const inside = margin > 0 ? offset(within, -margin) : regions(within);
  const b = bounds(within), origin: Pt = (o && o.origin) || b.centre;
  const reach = Math.hypot(b.size[0], b.size[1]) / 2 + Math.hypot(origin[0] - b.centre[0], origin[1] - b.centre[1]) + Math.max(dx, dy);
  const ni = Math.ceil(reach / dx), nj = Math.ceil(reach / dy);
  if ((2 * ni + 1) * (2 * nj + 1) > 400000) throw new Geo2Error("The grid has more than 400 000 points. Use a larger step.");
  const out: Pt[] = [];
  for (let j = -nj; j <= nj; j++) for (let i = -ni; i <= ni; i++) {
    const x = i * dx + (o.stagger && j & 1 ? dx / 2 : 0), y = j * dy;
    const p: Pt = [origin[0] + x * Math.cos(angle) - y * Math.sin(angle), origin[1] + x * Math.sin(angle) + y * Math.cos(angle)];
    if (contains1(inside, p)) out.push(p);
  }
  return out;
}

/** The corners that are left when a closed polygon is simplified to within `tol` (Douglas–Peucker), as indices in order. */
function mainCorners(l: readonly (readonly number[])[], tol: number): number[] {
  const n = l.length;
  if (n <= 3) return l.map((_, i) => i);
  let a = 0;
  for (let i = 1; i < n; i++) if (l[i][0] < l[a][0] || (l[i][0] === l[a][0] && l[i][1] < l[a][1])) a = i;
  let b = a, far = -1;
  for (let i = 0; i < n; i++) { const d = dist(l[i], l[a]); if (d > far) { far = d; b = i; } }
  const keep = new Set<number>([a, b]);
  const split = (i: number, j: number) => {   // the run i → j going forwards, indices unwrapped (j > i)
    let worst = -1, at = -1;
    for (let q = i + 1; q < j; q++) { const d = segDist(l[q % n], l[i % n], l[j % n]); if (d > worst) { worst = d; at = q; } }
    if (worst > tol && at >= 0) { keep.add(at % n); split(i, at); split(at, j); }
  };
  const lo = Math.min(a, b), hi = Math.max(a, b);
  split(lo, hi); split(hi, lo + n);
  return Array.from(keep).sort((p, q) => p - q);
}

/**
 * The significant corners of a shape's outer boundary: the boundary simplified to within `tolerance` (3 % of its
 * size when not given), so a rounded corner gives a point or two, not hundreds.  With `spacing`, points along
 * the runs between corners as well, that far apart.  In order round the boundary.
 */
export function outlinePoints(shape: unknown, o: { spacing?: number; tolerance?: number } = {}): Pt[] {
  const spacing = o.spacing || 0;
  const out: Pt[] = [];
  for (const r of regions(shape)) {
    const l = r.outer as Pt[], n = l.length;
    const b = bounds(l);
    const corners = mainCorners(l, o.tolerance && o.tolerance > 0 ? o.tolerance : 0.03 * Math.max(b.size[0], b.size[1]));
    for (let c = 0; c < corners.length; c++) {
      const from = corners[c], to = corners[(c + 1) % corners.length] + (c + 1 >= corners.length ? n : 0);
      out.push(l[from]);
      if (!(spacing > 0)) continue;
      // walk the run from this corner to the next and drop points at even steps along it
      let len = 0;
      for (let i = from; i < to; i++) len += dist(l[i % n], l[(i + 1) % n]);
      const pieces = Math.round(len / spacing);
      if (pieces < 2) continue;
      const step = len / pieces;
      let acc = 0, next = step;
      for (let i = from; i < to && next < len - 1e-9; i++) {
        const p = l[i % n], q = l[(i + 1) % n], d = dist(p, q);
        while (d > 0 && next <= acc + d + 1e-12 && next < len - 1e-9) { const t = (next - acc) / d; out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); next += step; }
        acc += d;
      }
    }
  }
  if (out.length > 20000) throw new Geo2Error("outlinePoints: more than 20 000 points. Use a larger spacing.");
  return out;
}

// ---------------------------------------------------------------- text

export interface FontFace { capHeight: number; glyphs: { [ch: string]: [number, string] } }
/** The outlines of a line of text as regions: `size` is the height of a capital, `at` the start of the baseline. */
export function text(face: FontFace, str: string, o: { size: number; at?: Pt; angle?: number; align?: "left" | "centre" | "center" | "right" }): Region[] {
  const size = o && o.size;
  if (!(size > 0)) throw new Geo2Error("text needs a size (the height of a capital, mm) above zero.");
  if (typeof str !== "string") throw new Geo2Error("text needs a string.");
  if (str.length > 400) throw new Geo2Error("text takes at most 400 characters.");
  const s = size / face.capHeight, loops: PathsD = [];
  let width = 0;
  const lines = str.split("\n");
  const rows = lines.map((line, row) => {
    let x = 0;
    const mine: Pt[][] = [];
    for (const ch of line) {
      const g = face.glyphs[ch] || face.glyphs["?"]; if (!g) continue;
      const tokens = g[1].match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || [];
      let i = 0, cur: Pt | null = null, poly: Pt[] = [];
      const num = () => Number(tokens[i++]);
      const P = (gx: number, gy: number): Pt => [x + gx * s, -row * 1.6 * size + gy * s];
      const close = () => { if (poly.length >= 3) mine.push(poly); poly = []; };
      while (i < tokens.length) {
        const c = tokens[i++];
        if (c === "M") { close(); cur = P(num(), num()); poly.push(cur); }
        else if (c === "L" && cur) { cur = P(num(), num()); poly.push(cur); }
        else if (c === "Q" && cur) { const a = P(num(), num()), p = P(num(), num()); for (let k = 1; k <= 6; k++) { const t = k / 6, u = 1 - t; poly.push([u * u * cur[0] + 2 * u * t * a[0] + t * t * p[0], u * u * cur[1] + 2 * u * t * a[1] + t * t * p[1]]); } cur = p; }
        else if (c === "C" && cur) { const a = P(num(), num()), b = P(num(), num()), p = P(num(), num()); for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; poly.push([u * u * u * cur[0] + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t * t * t * p[0], u * u * u * cur[1] + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t * t * t * p[1]]); } cur = p; }
        else if (c === "Z") close();
      }
      close();
      x += g[0] * s;
    }
    width = Math.max(width, x);
    return { polys: mine, width: x };
  });
  const at: Pt = (o && o.at) || [0, 0], angle = (((o && o.angle) || 0) * Math.PI) / 180;
  const align = o && o.align;
  for (const row of rows) {
    const shift = align === "right" ? -row.width : align === "centre" || align === "center" ? -row.width / 2 : 0;
    for (const poly of row.polys) loops.push(poly.map((p) => { const x = p[0] + shift, y = p[1]; return { x: at[0] + x * Math.cos(angle) - y * Math.sin(angle), y: at[1] + x * Math.sin(angle) + y * Math.cos(angle) }; }));
  }
  if (!loops.length) return [];
  // a glyph's counters wind the other way: even-odd makes holes of them
  const tree = new PolyTreeD();
  booleanOpDWithPolyTree(ClipType.Union, loops, null, tree, FillRule.EvenOdd, PREC);
  return regionsOfTree(tree);
}
