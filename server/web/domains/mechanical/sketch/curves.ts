// curves.ts — the sketch's free-form curves as geometry: ellipses and partial ellipses, splines through points,
// control-point splines and Bézier curves, conics, and text.  Pure: the same answer in the page (drawing,
// picking, regions) and in the geometry worker (the kernel edges extrude and revolve use).
//
// Every one of them is, here, a list of NURBS pieces in the sketch plane (text has one piece per stroke of a
// glyph's outline, the others one piece).  A piece's parameter is its knot parameter: a loop edge that is only
// part of a curve (sketch/planar.ts `span`) is that stretch of the piece in this parameter, and the kernel
// builds the same NURBS (features/sketch.ts), so both read a parameter the same way.
//
//   ellipse        { center, major, minor }                 `major`: a point at the end of the major semi-axis;
//                                                           `minor`: the other semi-axis, mm
//   ellipticalArc  { center, major, minor, start, end }     counter-clockwise from start to end
//   spline         { points: [...], closed?, startHandle?, endHandle? }
//                  a C² cubic through the points (chord-length parameter); a handle is the first (or last)
//                  control point of the end span, so it sets the direction and the speed the curve leaves with
//   bspline        { poles: [...], degree, weights? }       a clamped uniform B-spline on its control points;
//                                                           degree = poles − 1 is a Bézier curve
//   conic          { start, apex, end, rho }               the rational quadratic in the triangle start-apex-end;
//                                                           rho 0.5 is a parabola, less an ellipse, more a hyperbola
//   text           { a, b, text, font?, bold?, italic? }   set from a (baseline start) upward to b: |b − a| is
//                                                           the height of a capital letter
//   image          { a, b, src }                            a picture between corners a and b (no geometry)
import type { Vec2 } from "../core/geometry";
import { SKETCH_FONTS } from "../generated/sketch-font";
import type { SketchData, SketchEntity } from "./format";
import { pointAt, pointsOf } from "./refs";

const TAU = Math.PI * 2;

/** A NURBS curve in the plane: `knots` is the full knot vector (poles + degree + 1 values). */
export interface Nurbs { degree: number; poles: Vec2[]; weights: number[] | null; knots: number[] }
/** One piece of a free-form curve and the stretch of its parameter it covers. */
export interface Piece { nurbs: Nurbs; t0: number; t1: number; closed: boolean }

export const FREEFORM_TYPES = new Set(["ellipse", "ellipticalArc", "spline", "bspline", "conic", "text"]);
/** True for the entity types this file turns into geometry. */
export const isFreeform = (e: SketchEntity | undefined): boolean => !!e && FREEFORM_TYPES.has(e.type);

// ---------------------------------------------------------------- NURBS evaluation

/** The knot span index of `t` (de Boor). */
function span(n: Nurbs, t: number): number {
  const p = n.degree, k = n.knots, m = n.poles.length - 1;
  if (t >= k[m + 1]) return m;
  if (t <= k[p]) return p;
  let lo = p, hi = m + 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < k[mid]) hi = mid; else lo = mid; }
  return lo;
}

/** The point at parameter t. */
export function nurbsAt(n: Nurbs, t: number): Vec2 {
  const p = n.degree, k = n.knots, s = span(n, t);
  const d: [number, number, number][] = [];
  for (let j = 0; j <= p; j++) {
    const i = s - p + j, w = n.weights ? n.weights[i] : 1, q = n.poles[i];
    d.push([q[0] * w, q[1] * w, w]);
  }
  for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
    const i = s - p + j, den = k[i + p - r + 1] - k[i];
    const a = den > 0 ? (t - k[i]) / den : 0;
    d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
  }
  const h = d[p];
  return [h[0] / h[2], h[1] / h[2]];
}

/** The first derivative at t (central differences; second-order one-sided ones at the ends). */
export function nurbsTangent(n: Nurbs, t: number): Vec2 {
  const lo = n.knots[n.degree], hi = n.knots[n.poles.length], h = (hi - lo) * 1e-5 || 1e-9;
  if (t - h < lo || t + h > hi) {
    const s = t - h < lo ? 1 : -1, t0 = s > 0 ? Math.max(lo, t) : Math.min(hi, t);
    const p = nurbsAt(n, t0), q = nurbsAt(n, t0 + s * h), r = nurbsAt(n, t0 + 2 * s * h);
    return [(s * (-3 * p[0] + 4 * q[0] - r[0])) / (2 * h), (s * (-3 * p[1] + 4 * q[1] - r[1])) / (2 * h)];
  }
  const p = nurbsAt(n, t - h), q = nurbsAt(n, t + h);
  return [(q[0] - p[0]) / (2 * h), (q[1] - p[1]) / (2 * h)];
}

/** The signed curvature at t (positive when the curve turns counter-clockwise). */
export function nurbsCurvature(n: Nurbs, t: number): number {
  const lo = n.knots[n.degree], hi = n.knots[n.poles.length], h = (hi - lo) * 1e-4 || 1e-6;
  const a = Math.max(lo, t - h), b = Math.min(hi, t + h), m = (a + b) / 2;
  const p = nurbsAt(n, a), q = nurbsAt(n, m), r = nurbsAt(n, b), dt = (b - a) / 2;
  const d1: Vec2 = [(r[0] - p[0]) / (2 * dt), (r[1] - p[1]) / (2 * dt)], d2: Vec2 = [(r[0] - 2 * q[0] + p[0]) / (dt * dt), (r[1] - 2 * q[1] + p[1]) / (dt * dt)];
  const l = Math.hypot(d1[0], d1[1]);
  return l > 1e-12 ? (d1[0] * d2[1] - d1[1] * d2[0]) / (l * l * l) : 0;
}

/** Points along a piece from t0 to t1, both ends included. */
export function samplePiece(pc: Piece, t0 = pc.t0, t1 = pc.t1, perSpan = 12): Vec2[] {
  const n = pc.nurbs, spans = Math.max(1, new Set(n.knots).size - 1);
  const whole = pc.t1 - pc.t0 || 1;
  const count = Math.max(2, Math.ceil((spans * (n.degree === 1 ? 1 : perSpan) * Math.abs(t1 - t0)) / whole));
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i++) out.push(pieceAt(pc, t0 + ((t1 - t0) * i) / count));
  return out;
}

/** The point at t; a closed piece takes t round its period. */
export function pieceAt(pc: Piece, t: number): Vec2 { return nurbsAt(pc.nurbs, wrap(pc, t)); }
export function pieceTangent(pc: Piece, t: number): Vec2 { return nurbsTangent(pc.nurbs, wrap(pc, t)); }
export function pieceCurvature(pc: Piece, t: number): number { return nurbsCurvature(pc.nurbs, wrap(pc, t)); }
function wrap(pc: Piece, t: number): number {
  if (!pc.closed) return Math.min(pc.t1, Math.max(pc.t0, t));
  const p = pc.t1 - pc.t0;
  let u = pc.t0 + ((((t - pc.t0) % p) + p) % p);
  if (u > pc.t1) u = pc.t1;
  return u;
}

/** The parameter on a piece nearest to `p` (a coarse search and a few Newton steps) and how far away it is. */
export function nearestOnPiece(pc: Piece, p: Vec2): { t: number; q: Vec2; d: number } {
  const pts = samplePiece(pc, pc.t0, pc.t1, 24), n = pts.length - 1;
  let best = 0, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const s = l2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * s - p[0], a[1] + dy * s - p[1]);
    if (d < bd) { bd = d; best = (i + s) / n; }
  }
  let t = pc.t0 + (pc.t1 - pc.t0) * best;
  for (let it = 0; it < 8; it++) {
    const q = pieceAt(pc, t), d1 = pieceTangent(pc, t), l2 = d1[0] * d1[0] + d1[1] * d1[1];
    if (l2 < 1e-18) break;
    const step = ((p[0] - q[0]) * d1[0] + (p[1] - q[1]) * d1[1]) / l2;
    let nt = t + step;
    if (!pc.closed) nt = Math.min(pc.t1, Math.max(pc.t0, nt));
    if (Math.abs(nt - t) < 1e-14 * (Math.abs(pc.t1 - pc.t0) + 1)) { t = nt; break; }
    t = nt;
  }
  if (pc.closed) t = wrap(pc, t);
  const q = pieceAt(pc, t);
  return { t, q, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

// ---------------------------------------------------------------- building NURBS

const clampedKnots = (count: number, degree: number): number[] => {
  const k: number[] = [], inner = count - degree - 1;
  for (let i = 0; i <= degree; i++) k.push(0);
  for (let i = 1; i <= inner; i++) k.push(i);
  for (let i = 0; i <= degree; i++) k.push(inner + 1);
  return k;
};

/** A chain of Bézier segments (each degree+1 poles, sharing ends) as one NURBS with breaks at `params`. */
function bezierChain(segments: Vec2[][], weights: number[][] | null, params: number[], degree: number): Nurbs {
  const poles: Vec2[] = [], w: number[] = [], knots: number[] = [];
  segments.forEach((seg, i) => {
    seg.forEach((p, j) => { if (i && !j) return; poles.push(p); w.push(weights ? weights[i][j] : 1); });
  });
  for (let j = 0; j <= degree; j++) knots.push(params[0]);
  for (let i = 1; i < params.length - 1; i++) for (let j = 0; j < degree; j++) knots.push(params[i]);
  for (let j = 0; j <= degree; j++) knots.push(params[params.length - 1]);
  return { degree, poles, weights: weights ? w : null, knots };
}

/** An elliptical arc from eccentric angle e0 to e1 (counter-clockwise), exactly, as rational quadratic spans. */
export function ellipseNurbs(c: Vec2, u: Vec2, a: number, b: number, e0: number, e1: number): Nurbs {
  const v: Vec2 = [-u[1], u[0]];
  const at = (t: number, r = 1): Vec2 => [c[0] + r * (a * Math.cos(t) * u[0] + b * Math.sin(t) * v[0]), c[1] + r * (a * Math.cos(t) * u[1] + b * Math.sin(t) * v[1])];
  const sweep = e1 - e0, n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9)), d = sweep / n;
  const segs: Vec2[][] = [], ws: number[][] = [], params: number[] = [0];
  for (let i = 0; i < n; i++) {
    const t0 = e0 + i * d, t1 = t0 + d, w = Math.cos(d / 2);
    segs.push([at(t0), at((t0 + t1) / 2, 1 / w), at(t1)]); ws.push([1, w, 1]); params.push(i + 1);
  }
  return bezierChain(segs, ws, params, 2);
}

/** Solve a small dense linear system (Gaussian elimination with pivoting); null when singular. */
function solveDense(A: number[][], B: number[][]): number[][] | null {
  const n = A.length, a = A.map((r) => r.slice()), b = B.map((r) => r.slice());
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(a[r][i]) > Math.abs(a[p][i])) p = r;
    if (Math.abs(a[p][i]) < 1e-14) return null;
    [a[i], a[p]] = [a[p], a[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = a[r][i] / a[i][i]; if (!f) continue;
      for (let k = i; k < n; k++) a[r][k] -= f * a[i][k];
      for (let k = 0; k < b[r].length; k++) b[r][k] -= f * b[i][k];
    }
  }
  return b.map((row, i) => row.map((v) => v / a[i][i]));
}

/**
 * The C² cubic through `pts` (chord-length parameter), as Bézier spans.  `d0`/`d1` set the end derivatives
 * (null: natural ends).  `closed` makes it periodic through the first point again.
 */
export function interpolate(pts: Vec2[], closed: boolean, d0: Vec2 | null, d1: Vec2 | null): Nurbs | null {
  const P = closed ? [...pts, pts[0]] : pts.slice();
  const n = P.length - 1;
  if (n < 1) return null;
  const u: number[] = [0];
  for (let i = 1; i <= n; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); if (l < 1e-12) return null; u.push(u[i - 1] + l); }
  const h = (i: number) => u[i + 1] - u[i];
  const N = closed ? n : n + 1;   // unknown derivatives (closed: D_n = D_0)
  const A = Array.from({ length: N }, () => new Array<number>(N).fill(0)), B = Array.from({ length: N }, () => [0, 0]);
  const row = (i: number, prev: number, next: number, hp: number, hn: number, Pp: Vec2, Pi: Vec2, Pn: Vec2) => {
    A[i][prev] += hn; A[i][i] += 2 * (hp + hn); A[i][next] += hp;
    for (let k = 0; k < 2; k++) B[i][k] = 3 * ((hn * (Pi[k] - Pp[k])) / hp + (hp * (Pn[k] - Pi[k])) / hn);
  };
  if (closed) {
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n, next = (i + 1) % n, hp = h(prev), hn = h(i);
      row(i, prev, next, hp, hn, P[prev], P[i], P[i + 1]);
    }
    if (n < 3) return null;
  } else {
    for (let i = 1; i < n; i++) row(i, i - 1, i + 1, h(i - 1), h(i), P[i - 1], P[i], P[i + 1]);
    if (d0) { A[0][0] = 1; B[0] = [d0[0], d0[1]]; } else { A[0][0] = 2; A[0][1] = 1; B[0] = [3 * (P[1][0] - P[0][0]) / h(0), 3 * (P[1][1] - P[0][1]) / h(0)]; }
    if (d1) { A[n][n] = 1; B[n] = [d1[0], d1[1]]; } else { A[n][n - 1] = 1; A[n][n] = 2; B[n] = [3 * (P[n][0] - P[n - 1][0]) / h(n - 1), 3 * (P[n][1] - P[n - 1][1]) / h(n - 1)]; }
  }
  const D = solveDense(A, B); if (!D) return null;
  const Dv = (i: number): Vec2 => { const r = D[closed ? i % n : i]; return [r[0], r[1]]; };
  const segs: Vec2[][] = [];
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[i + 1], da = Dv(i), db = Dv(i + 1), hh = h(i) / 3;
    segs.push([a, [a[0] + da[0] * hh, a[1] + da[1] * hh], [b[0] - db[0] * hh, b[1] - db[1] * hh], b]);
  }
  return bezierChain(segs, null, u, 3);
}

// ---------------------------------------------------------------- text

const SLANT = Math.tan((12 * Math.PI) / 180);

/** The outlines of a text, in its own frame (x along the baseline, y up; 1 is the height of a capital). */
function textOutlines(text: string, font: string | undefined, bold: boolean, italic: boolean): { segs: Vec2[][]; width: number } {
  const face = SKETCH_FONTS[bold ? "Source Sans Bold" : "Source Sans"] || SKETCH_FONTS[Object.keys(SKETCH_FONTS)[0]];
  void font;
  const segs: Vec2[][] = [];
  if (!face) return { segs, width: 0 };
  const s = 1 / face.capHeight;
  let width = 0;
  text.split("\n").forEach((line, row) => {
    let x = 0;
    const y0 = -row * 1.6;
    for (const ch of line) {
      const g = face.glyphs[ch] || face.glyphs["?"]; if (!g) continue;
      const tokens = g[1].match(/[MLQCZ]|-?\d+(?:\.\d+)?/g) || [];
      let i = 0, start: Vec2 | null = null, cur: Vec2 | null = null;
      const num = () => Number(tokens[i++]);
      const P = (gx: number, gy: number): Vec2 => { const yy = gy * s; return [x + gx * s + (italic ? yy * SLANT : 0), y0 + yy]; };
      const push = (seg: Vec2[]) => { const a = seg[0], b = seg[seg.length - 1]; if (seg.length > 2 || Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) segs.push(seg); };
      while (i < tokens.length) {
        const c = tokens[i++];
        if (c === "M") { cur = start = P(num(), num()); }
        else if (c === "L" && cur) { const p = P(num(), num()); push([cur, p]); cur = p; }
        else if (c === "Q" && cur) { const a = P(num(), num()), p = P(num(), num()); push([cur, a, p]); cur = p; }
        else if (c === "C" && cur) { const a = P(num(), num()), b = P(num(), num()), p = P(num(), num()); push([cur, a, b, p]); cur = p; }
        else if (c === "Z" && cur && start) { push([cur, start]); cur = start; }
      }
      x += g[0] * s;
    }
    width = Math.max(width, x);
  });
  return { segs, width };
}

/** Where a text's frame sits: its origin `a`, the direction of its baseline and up, and its height. */
export function textFrame(data: SketchData, e: { a: string; b: string }): { o: Vec2; x: Vec2; y: Vec2; h: number } | null {
  const a = pointAt(data, e.a), b = pointAt(data, e.b); if (!a || !b) return null;
  const h = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!(h > 1e-9)) return null;
  const y: Vec2 = [(b[0] - a[0]) / h, (b[1] - a[1]) / h];
  return { o: a, x: [y[1], -y[0]], y, h };
}

/** The width of a text in mm, for its box. */
export function textWidth(data: SketchData, e: SketchEntity): number {
  if (e.type !== "text") return 0;
  const f = textFrame(data, e as never); if (!f) return 0;
  return textOutlines(String(e.text || ""), e.font as string | undefined, !!e.bold, !!e.italic).width * f.h;
}

// ---------------------------------------------------------------- an entity's pieces

const cache = new WeakMap<object, { key: string; pieces: Piece[] | null }>();

/** The pieces of a free-form entity of a sketch, or null when it cannot be built (a point is missing, …). */
export function freeformPieces(data: SketchData, id: string): Piece[] | null { return piecesOf(data, data.entities[id]); }
/** `freeformPieces` for an entity in hand. */
export function piecesOf(data: SketchData, e: SketchEntity | undefined): Piece[] | null {
  if (!e || !isFreeform(e)) return null;
  const pts = pointsOf(e).map((p) => pointAt(data, p));
  const key = JSON.stringify([e, pts]);
  const hit = cache.get(e);
  if (hit && hit.key === key) return hit.pieces;
  let pieces: Piece[] | null = null;
  try { pieces = build(data, e); } catch (err) { pieces = null; }
  cache.set(e, { key, pieces });
  return pieces;
}

const whole = (n: Nurbs, closed: boolean): Piece => ({ nurbs: n, t0: n.knots[n.degree], t1: n.knots[n.poles.length], closed });

function build(data: SketchData, e: SketchEntity): Piece[] | null {
  const P = (id: unknown): Vec2 | null => (typeof id === "string" ? pointAt(data, id) : null);
  switch (e.type) {
    case "ellipse": case "ellipticalArc": {
      const c = P(e.center), m = P(e.major), b = Number(e.minor);
      if (!c || !m || !(b > 0)) return null;
      const a = Math.hypot(m[0] - c[0], m[1] - c[1]); if (!(a > 0)) return null;
      const u: Vec2 = [(m[0] - c[0]) / a, (m[1] - c[1]) / a];
      if (e.type === "ellipse") return [whole(ellipseNurbs(c, u, a, b, 0, TAU), true)];
      const s = P(e.start), en = P(e.end); if (!s || !en) return null;
      const e0 = eccentric(c, u, a, b, s); let e1 = eccentric(c, u, a, b, en);
      if (e1 <= e0 + 1e-12) e1 += TAU;
      return [whole(ellipseNurbs(c, u, a, b, e0, e1), false)];
    }
    case "spline": {
      const ids = (Array.isArray(e.points) ? e.points : []) as string[];
      const pts = ids.map(P); if (pts.length < 2 || pts.some((p) => !p)) return null;
      const closed = !!e.closed && pts.length >= 3;
      const q = pts as Vec2[];
      const h0 = P(e.startHandle), h1 = P(e.endHandle);
      // a handle is the first control point of its end span: the derivative there is 3 (handle − end) / span
      const l0 = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), n = q.length - 1, l1 = Math.hypot(q[n][0] - q[n - 1][0], q[n][1] - q[n - 1][1]);
      const d0: Vec2 | null = !closed && h0 ? [(3 * (h0[0] - q[0][0])) / l0, (3 * (h0[1] - q[0][1])) / l0] : null;
      const d1: Vec2 | null = !closed && h1 ? [(3 * (q[n][0] - h1[0])) / l1, (3 * (q[n][1] - h1[1])) / l1] : null;
      const nurbs = interpolate(q, closed, d0, d1);
      return nurbs ? [whole(nurbs, closed)] : null;
    }
    case "bspline": {
      const ids = (Array.isArray(e.poles) ? e.poles : []) as string[];
      const pts = ids.map(P); if (pts.length < 2 || pts.some((p) => !p)) return null;
      const degree = Math.max(1, Math.min(pts.length - 1, Math.round(Number(e.degree) || 3)));
      const w = Array.isArray(e.weights) && e.weights.length === pts.length && (e.weights as number[]).every((x) => x > 0) ? (e.weights as number[]) : null;
      return [whole({ degree, poles: pts as Vec2[], weights: w, knots: clampedKnots(pts.length, degree) }, false)];
    }
    case "conic": {
      const s = P(e.start), a = P(e.apex), en = P(e.end), rho = Number(e.rho);
      if (!s || !a || !en || !(rho > 0 && rho < 1)) return null;
      return [whole({ degree: 2, poles: [s, a, en], weights: [1, rho / (1 - rho), 1], knots: [0, 0, 0, 1, 1, 1] }, false)];
    }
    case "text": {
      const f = textFrame(data, e as never); if (!f) return null;
      const { segs } = textOutlines(String(e.text || ""), e.font as string | undefined, !!e.bold, !!e.italic);
      const W = (p: Vec2): Vec2 => [f.o[0] + (p[0] * f.x[0] + p[1] * f.y[0]) * f.h, f.o[1] + (p[0] * f.x[1] + p[1] * f.y[1]) * f.h];
      return segs.map((seg) => whole({ degree: seg.length - 1, poles: seg.map(W), weights: null, knots: clampedKnots(seg.length, seg.length - 1) }, false));
    }
  }
  return null;
}

/** The eccentric angle of a point of an ellipse (c, major direction u, semi-axes a and b). */
export function eccentric(c: Vec2, u: Vec2, a: number, b: number, p: Vec2): number {
  const dx = p[0] - c[0], dy = p[1] - c[1];
  return Math.atan2((-u[1] * dx + u[0] * dy) / b, (u[0] * dx + u[1] * dy) / a);
}

/** The end points of an open free-form curve (what it joins other curves by), or null. */
export function endsOf(e: SketchEntity): [string, string] | null {
  switch (e.type) {
    case "ellipticalArc": return [e.start as string, e.end as string];
    case "spline": { const p = (e.points || []) as string[]; return !e.closed && p.length >= 2 ? [p[0], p[p.length - 1]] : null; }
    case "bspline": { const p = (e.poles || []) as string[]; return p.length >= 2 ? [p[0], p[p.length - 1]] : null; }
    case "conic": return [e.start as string, e.end as string];
  }
  return null;
}

/**
 * The point that sets a curve's direction where it leaves `end` (the second control point), or null when the
 * direction is not held by a point (a spline through points without a handle there).
 */
export function directionPoint(e: SketchEntity, end: string): string | null {
  if (e.type === "bspline") { const p = (e.poles || []) as string[]; if (p.length < 2) return null; return p[0] === end ? p[1] : p[p.length - 1] === end ? p[p.length - 2] : null; }
  if (e.type === "conic") return e.start === end || e.end === end ? (e.apex as string) : null;
  if (e.type === "spline") { const p = (e.points || []) as string[]; if (e.closed) return null; return p[0] === end ? ((e.startHandle as string) || null) : p[p.length - 1] === end ? ((e.endHandle as string) || null) : null; }
  return null;
}
/** The third control point from `end` (what sets the curvature there, with the second), or null. */
export function curvaturePoint(e: SketchEntity, end: string): string | null {
  if (e.type !== "bspline") return null;
  const p = (e.poles || []) as string[]; if (p.length < 3) return null;
  return p[0] === end ? p[2] : p[p.length - 1] === end ? p[p.length - 3] : null;
}

/** Polylines along a free-form entity, for drawing. */
export function freeformPolylines(data: SketchData, e: SketchEntity | undefined): Vec2[][] {
  const pieces = piecesOf(data, e);
  return pieces ? pieces.map((pc) => samplePiece(pc)) : [];
}

/** The NURBS of a piece as OpenCascade wants it: distinct knots and their multiplicities. */
export function knotsAndMults(n: Nurbs): { knots: number[]; mults: number[] } {
  const knots: number[] = [], mults: number[] = [];
  for (const k of n.knots) { if (knots.length && Math.abs(k - knots[knots.length - 1]) < 1e-12) mults[mults.length - 1]++; else { knots.push(k); mults.push(1); } }
  return { knots, mults };
}
