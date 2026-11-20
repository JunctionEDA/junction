// cf-hw-thread.ts — a modelled screw thread: the helical surface itself, and how it is put on a shaft or in a
// hole of a solid.
//
// The thread is not swept and not cut with booleans (a helicoid against a cylinder is the slowest thing the
// kernel does, seconds for a few turns).  Its surface is written down directly.  In an axial section the profile
// is a trapezoid: a flat at the root line, a straight flank, a flat at the crest line, a flank back.  Wound round
// the axis, each of those four pieces is a surface of its own, and a point of it is known in closed form from
// (the place across the piece, the height along the axis).  Each piece is sampled every 12° and a cubic surface
// is put through the samples (within a tenth of a micrometre of the true helicoid at M8), so the flanks are true
// helicoids with the pitch and flank angle of the thread form, not a stack of facets.
//
// Because the surface is a formula, the same code makes everything a thread needs:
//   taper      the root line's radius changes along the axis (pipe threads);
//   lead-in    the profile is cut off above a height that falls to nothing towards the tip (a chamfer);
//   run-out    the profile is cut off below a height that rises towards the shoulder, so the groove fades out;
//   vanishing  a tapered thread running out of the pipe it is cut in, crests cut off at the pipe's surface.
// `clip` says how much of the profile's height exists at each place along the axis.
//
// Putting it on a solid (threadInto): the stock the thread lies in is removed with a plain tube (an ordinary,
// fast cut), which leaves a round wall and a circle on each end face.  The wall is thrown away, each circle is
// replaced by the thread's own section, and the thread's surfaces are sewn in.  No boolean ever sees the thread.
//
// Faces: `<prefix>:crest`, `:root`, `:flank` (the side facing the start) and `:flank-back`.  A long thread is
// several faces along its length; they share a name and the engine numbers them.  Everything else on the solid
// keeps the name it had.
import { add, cross, dot, scale, sub, type Vec3 } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { EvalContext, NamedShape, Shape } from "../types";
import { chainEdges } from "./curves";
import { toolFaces } from "./combine";
import { inside, tube, type CylinderFace } from "./cf-hw";
import { edgeInfo } from "./ref-geom";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface ThreadShape {
  /** the axis: z = 0 at `origin`, growing along `dir`; `x` is square to it */
  origin: Vec3; dir: Vec3; x: Vec3;
  length: number;
  pitch: number;
  /** the number of threads side by side (the lead is `starts` × `pitch`) */
  starts: number;
  left: boolean;
  /** radius of the profile's lower line at z = 0, and how much it grows per unit of z */
  base: number; taper: number;
  /** radial height of the whole profile, and the axial widths of its flats at the lower and the upper line */
  depth: number; loFlat: number; hiFlat: number;
  /**
   * How much of the profile exists along the axis, straight between the rows.  `lo` and `hi`: the profile is cut
   * off below and above these heights (0 the lower line, 1 the upper).  `keep`: what is left is then squashed
   * towards the line named by `into` (1 leaves it alone, 0 leaves a plain circle, which is how a thread ends
   * flush in the surface it was cut in).
   */
  clip: ClipRow[];
  into: "hi" | "lo";
  prefix: string;
}

export interface ClipRow { z: number; lo: number; hi: number; keep: number }

/** The smallest part of the height a thread is left with where it is clipped away (a degenerate face is none). */
export const THREAD_MIN = 0.03;
const PER_TURN = 30, ZONE_TURNS = 12;

export interface ThreadSurface { faces: { face: Shape; role: string }[]; start: Shape; end: Shape }

/** The thread's surfaces, not yet joined to each other, and the closed curve they end in at z = 0 and z = length. */
export function threadSurface(ctx: EvalContext, t: ThreadShape): ThreadSurface {
  const oc = ctx.oc as Any, k = ctx.k;
  const n = Math.max(1, Math.round(t.starts)), lead = n * t.pitch, L = t.length;
  if (!(t.pitch > 0) || !(L > 0) || !(t.depth > 0)) throw ctx.fail("The thread's pitch, depth and length must be more than zero.");
  if (L / lead > 400) throw ctx.fail("That is more than 400 turns of thread. Use a coarser pitch or a shorter length.");
  const y = cross(t.dir, t.x), hand = t.left ? -1 : 1;
  // flats as parts of a pitch; neither may vanish (the surface would fold)
  const a = Math.max(0.01, t.loFlat / t.pitch), b = Math.max(0.01, t.hiFlat / t.pitch);
  const f = (1 - a - b) / 2;
  if (!(f > 0.01)) throw ctx.fail("The thread's flats are wider than its pitch.");
  const clip = [...t.clip].sort((p, q) => p.z - q.z);
  if (!clip.length) clip.push({ z: 0, lo: 0, hi: 1, keep: 1 });
  const clipAt = (z: number): [number, number, number] => {
    let lo: number, hi: number, keep: number;
    const last = clip[clip.length - 1];
    if (z <= clip[0].z) ({ lo, hi, keep } = clip[0]);
    else if (z >= last.z) ({ lo, hi, keep } = last);
    else {
      let i = 0; while (i + 2 < clip.length && z > clip[i + 1].z) i++;
      const p = clip[i], q = clip[i + 1], s = (z - p.z) / (q.z - p.z || 1);
      lo = p.lo + s * (q.lo - p.lo); hi = p.hi + s * (q.hi - p.hi); keep = p.keep + s * (q.keep - p.keep);
    }
    // a little below the lower line is allowed (a tapered thread's last half turn); the root flat must keep a width
    lo = Math.min(Math.max(lo, (-0.4 * a) / f), 1 - THREAD_MIN); hi = Math.max(Math.min(hi, 1), lo + THREAD_MIN);
    return [lo, hi, Math.min(1, Math.max(0, keep))];
  };
  const point = (u: number, h0: number, z: number, start: number): Vec3 => {
    const [lo, hi, keep] = clipAt(z);
    const to = t.into === "hi" ? hi : lo;
    const r = t.base + t.taper * z + t.depth * (to + (h0 - to) * keep);
    const th = (2 * Math.PI * (u + start)) / n + (hand * 2 * Math.PI * z) / lead;
    return add(add(add(t.origin, scale(t.x, r * Math.cos(th))), scale(y, r * Math.sin(th))), scale(t.dir, z));
  };
  // the four pieces of the profile: where each starts and ends across a pitch, and the heights there
  type Piece = { role: string; span(lo: number, hi: number): [number, number, number, number] };
  const pieces: Piece[] = [
    { role: "root", span: (lo) => [-a / 2 - f * lo, a / 2 + f * lo, lo, lo] },
    { role: hand > 0 ? "flank" : "flank-back", span: (lo, hi) => [a / 2 + f * lo, a / 2 + f * hi, lo, hi] },
    { role: "crest", span: (_lo, hi) => [a / 2 + f * hi, 1 - a / 2 - f * hi, hi, hi] },
    { role: hand > 0 ? "flank-back" : "flank", span: (lo, hi) => [1 - a / 2 - f * hi, 1 - a / 2 - f * lo, hi, lo] },
  ];
  // along the axis: a new face wherever the clipping changes its slope, and every twelve turns at most
  const cuts = new Set<number>([0, L]);
  for (const c of clip) if (c.z > 1e-9 && c.z < L - 1e-9) cuts.add(c.z);
  const stops = [...cuts].sort((p, q) => p - q);
  const zones: [number, number][] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const parts = Math.max(1, Math.ceil((stops[i + 1] - stops[i]) / (ZONE_TURNS * lead) - 1e-9));
    for (let j = 0; j < parts; j++) zones.push([stops[i] + ((stops[i + 1] - stops[i]) * j) / parts, stops[i] + ((stops[i + 1] - stops[i]) * (j + 1)) / parts]);
  }
  // samples across a piece: enough for the widest it gets anywhere, and the same in every zone, so that two zones
  // meet in one curve
  const colsOf = (piece: Piece): number => {
    let widest = 0;
    for (const z of [0, L, ...clip.map((c) => c.z)]) { const [lo, hi] = clipAt(z); const s = piece.span(lo, hi); widest = Math.max(widest, s[1] - s[0]); }
    return Math.max(4, Math.ceil((widest / n) * PER_TURN) + 1);
  };
  const faces: { face: Shape; role: string }[] = [];
  const startEdges: Shape[] = [], endEdges: Shape[] = [];
  const zOf = (e: Shape) => dot(sub(k.centre(e, "edge"), t.origin), t.dir);
  for (const [z0, z1] of zones) {
    const rows = Math.max(4, Math.ceil(((z1 - z0) / lead) * PER_TURN) + 1);
    for (let start = 0; start < n; start++) for (const piece of pieces) {
      const cols = colsOf(piece);
      const grid: Vec3[][] = [];
      for (let i = 0; i < cols; i++) grid.push(new Array<Vec3>(rows));
      for (let j = 0; j < rows; j++) {
        const z = z0 + ((z1 - z0) * j) / (rows - 1);
        const [lo, hi] = clipAt(z);
        const [u0, u1, h0, h1] = piece.span(lo, hi);
        for (let i = 0; i < cols; i++) {
          const v = i / (cols - 1);
          grid[i][j] = point(u0 + v * (u1 - u0), h0 + v * (h1 - h0), z, start);
        }
      }
      const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(surfaceThrough(ctx, grid), 1e-7));
      if (!mk.IsDone()) throw ctx.fail("The thread's surface could not be built.");
      const face = ctx.own(mk.Face());
      faces.push({ face, role: `${t.prefix}:${piece.role}` });
      if (z0 < 1e-9 || z1 > L - 1e-9) for (const e of k.sub(face, "edge")) {
        const z = zOf(e);
        if (z0 < 1e-9 && Math.abs(z) < 1e-6) startEdges.push(e);
        else if (z1 > L - 1e-9 && Math.abs(z - L) < 1e-6) endEdges.push(e);
      }
    }
  }
  const ring = (edges: Shape[]): Shape => {
    const wires = chainEdges(ctx, edges, 1e-5);
    if (wires.length !== 1) throw ctx.fail("The thread's end could not be closed.");
    return wires[0];
  };
  return { faces, start: ring(startEdges), end: ring(endEdges) };
}

// ---------------------------------------------------------------- a surface through a grid of points
//
// A cubic B-spline surface through every point of a grid, the points evenly spaced in the surface's parameters
// (Piegl & Tiller, The NURBS Book, algorithm A9.4: curves through the rows, then through their poles).  The
// kernel's own fit spaces the parameters by chord length averaged over the whole grid, so two patches that share
// an edge do not get the same curve along it; here the curve along an edge depends on that edge's points alone,
// and neighbouring patches meet exactly.

/**
 * The knots for `count` points at even parameters (degree 3), and a solver for the poles of the curve through
 * them.  The interpolation matrix has four entries a row beside its diagonal and is totally positive, so it is
 * factored in place without pivoting, in time proportional to `count`.
 */
function fitOf(count: number): { knots: number[]; solve(values: Float64Array, stride: number, offset: number): void } {
  const n = count - 1, p = 3, W = 3;
  const params = Array.from({ length: count }, (_, i) => i / n);
  const U: number[] = [0, 0, 0, 0];
  for (let j = 1; j <= n - p; j++) U.push((params[j] + params[j + 1] + params[j + 2]) / 3);
  U.push(1, 1, 1, 1);
  const basis = (i: number, u: number): number => {
    // Cox–de Boor, degree 3
    const N = [0, 0, 0, 0];
    for (let d = 0; d <= p; d++) N[d] = (u >= U[i + d] && u < U[i + d + 1]) || (u === 1 && U[i + d + 1] === 1 && U[i + d] < 1) ? 1 : 0;
    for (let q = 1; q <= p; q++) for (let d = 0; d <= p - q; d++) {
      const a = U[i + d + q] - U[i + d], b = U[i + d + q + 1] - U[i + d + 1];
      N[d] = (a > 0 ? ((u - U[i + d]) / a) * N[d] : 0) + (b > 0 ? ((U[i + d + q + 1] - u) / b) * N[d + 1] : 0);
    }
    return N[0];
  };
  // the band: A[r][c] for |r - c| <= W, row r at r * (2W + 1), column c at c - r + W
  const B = 2 * W + 1, A = new Float64Array(count * B);
  for (let r = 0; r < count; r++) for (let c = Math.max(0, r - W); c <= Math.min(n, r + W); c++) A[r * B + c - r + W] = basis(c, params[r]);
  for (let c = 0; c < count; c++) {
    const d = A[c * B + W];
    for (let r = c + 1; r <= Math.min(n, c + W); r++) {
      const m = A[r * B + c - r + W] / d;
      A[r * B + c - r + W] = m;
      if (m !== 0) for (let q = c + 1; q <= Math.min(n, c + W); q++) A[r * B + q - r + W] -= m * A[c * B + q - c + W];
    }
  }
  return {
    knots: U,
    solve(v, stride, offset) {
      for (let c = 0; c < count; c++) for (let r = c + 1; r <= Math.min(n, c + W); r++) v[offset + r * stride] -= A[r * B + c - r + W] * v[offset + c * stride];
      for (let r = n; r >= 0; r--) {
        let sum = v[offset + r * stride];
        for (let q = r + 1; q <= Math.min(n, r + W); q++) sum -= A[r * B + q - r + W] * v[offset + q * stride];
        v[offset + r * stride] = sum / A[r * B + W];
      }
    },
  };
}
const FITS = new Map<number, ReturnType<typeof fitOf>>();   // pure numbers by size: safe to keep
const fitFor = (count: number) => { let f = FITS.get(count); if (!f) { if (FITS.size > 64) FITS.clear(); f = fitOf(count); FITS.set(count, f); } return f; };

/** The surface through `grid[i][j]` (at least 4 by 4), `i` running across and `j` along. */
export function surfaceThrough(ctx: EvalContext, grid: readonly (readonly Vec3[])[]): Any {
  const oc = ctx.oc as Any;
  const nu = grid.length, nv = grid[0].length;
  const fu = fitFor(nu), fv = fitFor(nv);
  // poles: the curve through each row, then the curve through each column of those poles, a coordinate at a time
  const poles = new Float64Array(nu * nv * 3);
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const g = grid[i][j], o = (i * nv + j) * 3; poles[o] = g[0]; poles[o + 1] = g[1]; poles[o + 2] = g[2]; }
  for (let i = 0; i < nu; i++) for (let c = 0; c < 3; c++) fv.solve(poles, 3, i * nv * 3 + c);
  for (let j = 0; j < nv; j++) for (let c = 0; c < 3; c++) fu.solve(poles, nv * 3, j * 3 + c);
  const arr = ctx.tmp(new oc.NCollection_Array2_gp_Pnt(1, nu, 1, nv));
  const pnt = ctx.tmp(new oc.gp_Pnt(0, 0, 0));
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const o = (i * nv + j) * 3; pnt.SetCoord(poles[o], poles[o + 1], poles[o + 2]); arr.SetValue(i + 1, j + 1, pnt); }
  const knotsOf = (fit: { knots: number[] }, count: number) => {
    const distinct = [0, ...fit.knots.slice(4, count), 1];
    const ks = ctx.tmp(new oc.NCollection_Array1_double(1, distinct.length)), ms = ctx.tmp(new oc.NCollection_Array1_int(1, distinct.length));
    distinct.forEach((v, i) => { ks.SetValue(i + 1, v); ms.SetValue(i + 1, i === 0 || i === distinct.length - 1 ? 4 : 1); });
    return [ks, ms];
  };
  const [uk, um] = knotsOf(fu, nu), [vk, vm] = knotsOf(fv, nv);
  // geometry is reference-counted by the face that uses it: not deleted here
  return new oc.Geom_BSplineSurface(arr, uk, vk, um, vm, 3, 3, false, false);
}

// ---------------------------------------------------------------- closing and sewing

/** Whether a closed wire about the axis runs anticlockwise seen against `dir`. */
function runsAnticlockwise(ctx: EvalContext, wire: Shape, origin: Vec3, dir: Vec3, x: Vec3): boolean {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(wire), false));
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter(), y = cross(dir, x);
  let area = 0, prev: [number, number] | null = null, first: [number, number] | null = null;
  const N = 48;
  for (let i = 0; i < N; i++) {
    const p = ad.Value(u0 + ((u1 - u0) * i) / N); const d = sub(k.xyz(p), origin); p.delete();
    const cur: [number, number] = [dot(d, x), dot(d, y)];
    if (prev) area += prev[0] * cur[1] - cur[0] * prev[1]; else first = cur;
    prev = cur;
  }
  area += prev![0] * first![1] - first![0] * prev![1];
  return area > 0;
}

/** A flat face square to the axis at height `z`, inside `outer` and outside each of `holes` (closed wires). */
export function flatFace(ctx: EvalContext, origin: Vec3, dir: Vec3, x: Vec3, z: number, outer: Shape, holes: readonly Shape[]): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const at = add(origin, scale(dir, z));
  const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(at)), ctx.tmp(k.dir(dir)), ctx.tmp(k.dir(x))))));
  const turned = (w: Shape, anticlockwise: boolean) => oc.TopoDS.Wire(runsAnticlockwise(ctx, w, at, dir, x) === anticlockwise ? w : ctx.own(w.Reversed()));
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, turned(outer, true), true));
  for (const h of holes) mk.Add(turned(h, false));
  if (!mk.IsDone()) throw ctx.fail("The thread's end could not be closed.");
  return ctx.own(mk.Face());
}

/** Faces that close a volume, sewn into a solid; null when they leave a gap.  `named` gets each face's name. */
function sewnSolid(ctx: EvalContext, faces: readonly { face: Shape; role: string | null }[]): NamedResult | null {
  const oc = ctx.oc as Any, k = ctx.k;
  const sewing = ctx.tmp(new oc.BRepBuilderAPI_Sewing(1e-5, true, false, false, false));
  for (const s of faces) sewing.Add(s.face);
  sewing.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  const sewn = ctx.own(sewing.SewedShape());
  const shells = k.sub(sewn, "shell");
  if (shells.length !== 1 || !oc.BRep_Tool.IsClosed(shells[0])) return null;
  const ms = ctx.tmp(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shells[0])));
  if (!ms.IsDone()) return null;
  let solid: Shape = ctx.own(ms.Solid());
  oc.BRepLib.OrientClosedSolid(solid);
  if (k.volume(solid) < 0) solid = ctx.own(solid.Reversed());
  const named = new ShapeIndex<string>(k);
  for (const s of faces) if (s.role !== null) named.add(sewing.IsModified(s.face) ? ctx.own(sewing.Modified(s.face)) : s.face, s.role);
  return { shape: solid, names: (face) => named.get(face) ?? null };
}

function circleEdge(ctx: EvalContext, origin: Vec3, dir: Vec3, x: Vec3, z: number, radius: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(add(origin, scale(dir, z)))), ctx.tmp(k.dir(dir)), ctx.tmp(k.dir(x))));
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, radius)))).Edge());
}
const wireOf = (ctx: EvalContext, edge: Shape): Shape => ctx.own(ctx.tmp(new (ctx.oc as Any).BRepBuilderAPI_MakeWire((ctx.oc as Any).TopoDS.Edge(edge))).Wire());

/**
 * A thread as a solid of its own: a threaded rod (`wall` 0), a sleeve threaded outside (`wall` inside the
 * thread) or a sleeve threaded inside (`wall` outside it).  Also `<prefix>:start`, `:end`, `:wall`.
 */
export function threadSolid(ctx: EvalContext, t: ThreadShape & { wall: number }): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const s = threadSurface(ctx, t);
  const faces: { face: Shape; role: string | null }[] = [...s.faces];
  const outside = t.wall > t.base;
  const cap = (z: number, section: Shape, role: string): Shape | null => {
    const ring = t.wall > 1e-9 ? circleEdge(ctx, t.origin, t.dir, t.x, z, t.wall) : null;
    const rw = ring ? wireOf(ctx, ring) : null;
    faces.push({ face: !rw ? flatFace(ctx, t.origin, t.dir, t.x, z, section, []) : outside ? flatFace(ctx, t.origin, t.dir, t.x, z, rw, [section]) : flatFace(ctx, t.origin, t.dir, t.x, z, section, [rw]), role: `${t.prefix}:${role}` });
    return ring;
  };
  const ring0 = cap(0, s.start, "start");
  cap(t.length, s.end, "end");
  if (ring0) {
    const prism = ctx.tmp(new oc.BRepPrimAPI_MakePrism(ring0, ctx.tmp(k.vec(scale(t.dir, t.length))), false, true));
    prism.Build();
    for (const face of k.sub(ctx.own(prism.Shape()), "face")) faces.push({ face, role: `${t.prefix}:wall` });
  }
  const solid = sewnSolid(ctx, faces);
  if (!solid) throw ctx.fail("The thread could not be closed into a solid. Try a different length or pitch.");
  return solid;
}

// ---------------------------------------------------------------- replacing the surface of a cylinder
//
// How a thread (or a knurl) is put on a solid without a boolean ever seeing it.  The stock it lies in is removed
// with a plain tube, an ordinary fast cut, which leaves a round wall and a circle on each end face.  The wall is
// thrown away, each circle is replaced by the new surface's own end curve, and the new faces are sewn in.

interface StockEnd { z: number; face: Shape; wires: Shape[]; /** the radius of each wire that is a circle about the axis */ radii: (number | null)[]; hit: number; near: number | null }
export interface Bored {
  axis: { origin: Vec3; dir: Vec3; x: Vec3 };
  length: number; wall: number; outer: number; internal: boolean;
  /** the solid with the stock removed, and how its faces are named */
  piece: Shape; names: (face: Any, i: number) => string | null;
  /** its faces without the round wall */
  kept: { face: Shape; role: string | null }[];
  /**
   * The flat face at each end (z = 0, z = length) that has the wall's circle in it.  `near` is the radius of the
   * nearest other circle on that face on the new surface's side of the wall: an edge of the stock that the new
   * surface must stay clear of (the shaft's own surface carrying on, or a chamfer or fillet beginning).
   */
  ends: (StockEnd | null)[];
  /** the cut left what a tube should: the wall and a face at each end */
  clean: boolean;
}

/** Remove a tube of stock about an axis, from z = 0 to `length`: between `wall` and `outer`, or a rod of `wall` in a hole. */
export function boreStock(ctx: EvalContext, target: { shape: Shape; faces: readonly NamedShape[] }, axis: { origin: Vec3; dir: Vec3; x: Vec3 }, length: number, wall: number, outer: number, internal: boolean): Bored {
  const oc = ctx.oc as Any, k = ctx.k, id = ctx.feature.id;
  const { origin, dir } = axis;
  const stock = tube(ctx, origin, dir, axis.x, internal ? 0 : wall, outer, 0, length, `${id}:stock`);
  const cutR = k.boolean("cut", target, { shape: stock.shape, faces: toolFaces(ctx, stock) }, id, ctx.own);
  const pieces = k.solids(cutR.shape);
  if (pieces.length !== 1) throw ctx.fail("This would cut the body in two.");
  const wallName = `${id}:stock:${internal ? "outer" : "inner"}`;
  const circleOf = (wire: Shape, z: number): number | null => {
    let run = 0, radius = -1;
    for (const e of k.sub(wire, "edge")) {
      const info = edgeInfo(ctx, e);
      if (info.kind !== "circle" || (radius >= 0 && Math.abs(info.radius! - radius) > 1e-6)) return null;
      radius = info.radius!;
      const d = sub(info.centre!, add(origin, scale(dir, z)));
      if (Math.hypot(d[0], d[1], d[2]) > 1e-6) return null;
      const g = new oc.GProp_GProps(); oc.BRepGProp.LinearProperties(e, g, false, false); run += g.Mass(); g.delete();
    }
    return radius > 0 && Math.abs(run - 2 * Math.PI * radius) < 1e-5 ? radius : null;
  };
  const ends: (StockEnd | null)[] = [null, null];
  const kept: { face: Shape; role: string | null }[] = [];
  let wallFound = false;
  for (const face of k.sub(pieces[0], "face")) {
    const name = cutR.names(face as Any, 0);
    if (name !== null && (name === wallName || name.startsWith(`${wallName}~`))) { wallFound = true; continue; }
    kept.push({ face, role: name });
    if (!k.faceFrame(face as Any)) continue;
    const wires = k.sub(face, "wire");
    [0, length].forEach((z, e) => {
      if (ends[e]) return;
      const radii = wires.map((w) => circleOf(w, z));
      const hit = radii.findIndex((r) => r !== null && Math.abs(r - wall) < 1e-6);
      if (hit < 0) return;
      const beyond = radii.filter((r, i): r is number => i !== hit && r !== null && (internal ? r < wall : r > wall));
      ends[e] = { z, face, wires, radii, hit, near: beyond.length ? (internal ? Math.max(...beyond) : Math.min(...beyond)) : null };
    });
  }
  return { axis, length, wall, outer, internal, piece: pieces[0], names: cutR.names as Any, kept, ends, clean: wallFound && !!ends[0] && !!ends[1] };
}

/**
 * Sew a new surface in where the wall was: `faces` reach from the closed curve `start` (at z = 0) to `end` (at
 * z = length), both lying between the wall and the stock's surface.  `reach` is the largest radius of each of
 * those curves (for a hole: the smallest).  Null when the result does not close.
 */
export function graft(ctx: EvalContext, b: Bored, faces: readonly { face: Shape; role: string | null }[], start: Shape, end: Shape, reach: [number, number]): NamedResult | null {
  const oc = ctx.oc as Any, k = ctx.k;
  if (!b.clean) return null;
  const { origin, dir, x } = b.axis;
  const parts: { face: Shape; role: string | null }[] = [...faces];
  for (const f of b.kept) {
    const e = b.ends.findIndex((q) => q!.face === f.face);
    if (e < 0) { parts.push(f); continue; }
    const q = b.ends[e]!, section = e === 0 ? start : end;
    const outerWire = oc.BRepTools.OuterWire(oc.TopoDS.Face(f.face));
    const others = q.wires.filter((_, i) => i !== q.hit);
    // what bounds the face now: the old outline when the wall's circle was a hole in it; otherwise the new curve,
    // unless a circle of the stock lies outside the new curve (the step of a wider hole): then that circle
    let rim: Shape | null = q.wires[q.hit].IsSame(outerWire) ? null : others.find((w) => w.IsSame(outerWire))!;
    if (!rim) {
      const wider = q.radii.map((r, i) => ({ r, w: q.wires[i] })).filter((c, i) => i !== q.hit && c.r !== null && c.r > reach[e] + 1e-9).sort((c, d) => c.r! - d.r!);
      if (wider.length) rim = wider[0].w;
    }
    const face = rim ? flatFace(ctx, origin, dir, x, q.z, rim, [section, ...others.filter((w) => w !== rim)]) : flatFace(ctx, origin, dir, x, q.z, section, others);
    parts.push({ face, role: f.role });
  }
  const result = sewnSolid(ctx, parts);
  if (!result) return null;
  // it must have grown by less than the stock that was removed
  const was = k.volume(b.piece), now = k.volume(result.shape), room = Math.PI * Math.abs(b.outer * b.outer - (b.internal ? 0 : b.wall * b.wall)) * b.length;
  return now > was - 1e-6 && now < was + room ? result : null;
}

// ---------------------------------------------------------------- a thread on a shaft or in a hole of a solid

export interface ThreadJob {
  /** the cylinder the thread is cut on or in: its axis, radius and extent, and whether it is a hole */
  origin: Vec3; dir: Vec3; x: Vec3; radius: number; lo: number; hi: number; hole: boolean;
  pitch: number; starts: number; left: boolean;
  /** radial depth, and the flats at the major and the minor diameter */
  depth: number; majorFlat: number; minorFlat: number;
  /** radius of the major diameter where the thread starts, and its change per unit of length into the thread */
  major: number; taper: number;
  /** how far the thread runs from its start; cut short where the cylinder ends or the thread runs out of it */
  length: number;
  /** start at the `hi` end of the cylinder rather than the `lo` end */
  fromHi: boolean;
  /** axial length of the chamfer at the start, and of the fade at the far end; 0 for none */
  leadIn: number; runout: number;
  prefix: string;
}

/**
 * Model a thread on a shaft or in a hole of a solid.  The thread never adds stock: its crests stop at the shaft's
 * surface (the hole's, for an internal thread), which is how a tapered thread vanishes into its pipe.  Returns the
 * solid and the length that was threaded.
 */
export function threadInto(ctx: EvalContext, target: { shape: Shape; faces: readonly NamedShape[] }, job: ThreadJob): { result: NamedResult; length: number } {
  const oc = ctx.oc as Any, k = ctx.k, id = ctx.feature.id;
  const internal = job.hole, h = job.depth, R = job.radius;
  const span = job.hi - job.lo;
  const origin = add(job.origin, scale(job.dir, job.fromHi ? job.hi : job.lo)), dir = job.fromHi ? scale(job.dir, -1) : job.dir;
  let L = Math.min(job.length, span);
  if (!(L > 1e-6)) throw ctx.fail("The thread's length must be more than zero.");
  const base0 = job.major - h;   // the minor radius at the start
  const heightOf = (radius: number, z: number) => (radius - base0 - job.taper * z) / h;
  // the profile's height as straight pieces along the axis: the lowest of `hi`, the highest of `lo`
  type Line = [number, number];   // value = m z + c
  const hi: Line[] = [[0, 1]], lo: Line[] = [[0, 0]];
  // never outside the stock: no higher than the shaft's surface, no lower than the hole's
  (internal ? lo : hi).push([-job.taper / h, (R - base0) / h]);
  if (job.leadIn > 0) { if (internal) lo.push([-1 / job.leadIn, 1]); else hi.push([1 / job.leadIn, 0]); }
  const at = (z: number): [number, number] => [Math.max(...lo.map(([m, q]) => m * z + q)), Math.min(...hi.map(([m, q]) => m * z + q))];
  const open = (z: number) => { const [l, u] = at(z); return u - l; };
  const kinks = (upTo: number): number[] => {
    const stops = new Set<number>([0, upTo]);
    const all = [...hi, ...lo];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const dm = all[i][0] - all[j][0];
      if (Math.abs(dm) < 1e-12) continue;
      const z = (all[j][1] - all[i][1]) / dm;
      if (z > 1e-6 && z < upTo - 1e-6) stops.add(z);
    }
    return [...stops].sort((p, q) => p - q);
  };
  // where the thread runs out of the stock by itself (a tapered thread): it ends half a turn further
  let vanishes = -1;
  {
    const zs = kinks(L);
    for (let i = 1; i < zs.length && vanishes < 0; i++) {
      const a = open(zs[i - 1]), b = open(zs[i]);
      if (a >= THREAD_MIN && b < THREAD_MIN) vanishes = zs[i - 1] + ((zs[i] - zs[i - 1]) * (a - THREAD_MIN)) / (a - b);
    }
    if ((open(zs[0]) < THREAD_MIN && open(zs[1]) < THREAD_MIN) || !zs.some((z) => open(z) > 0.25)) {
      throw ctx.fail(internal
        ? "This thread does not fit the hole: the hole is as wide as the thread's major diameter, or wider. Pick a larger size or a smaller hole."
        : "This thread does not fit the cylinder: the cylinder is as thin as the thread's minor diameter, or thinner. Pick a smaller size or a thicker cylinder.");
    }
  }
  let fade = job.runout > 0 ? Math.min(job.runout, L / 2) : 0;
  if (vanishes >= 0) { fade = Math.min(job.pitch / 2, span - vanishes); L = vanishes + fade; }
  if (L < job.pitch * 0.5) throw ctx.fail("There is less than half a turn of thread here. Use a longer cylinder or a finer pitch.");

  // the wall the stock is removed to, clear of the thread; there must be stock at it
  const margin = Math.max(0.35 * h, 0.05);
  const lowest = Math.min(base0, base0 + job.taper * L), highest = Math.max(job.major, job.major + job.taper * L);
  const wall = internal ? Math.max(highest, R) + margin : Math.max(lowest * 0.5, lowest - margin);
  const probe = add(add(origin, scale(dir, L / 2)), scale(job.x, internal ? wall * 1.001 : wall * 0.999));
  const whole = k.solids(target.shape);
  if (whole.length !== 1 || !inside(ctx, whole[0], probe)) {
    throw ctx.fail(internal ? "The wall around the hole is too thin for this thread." : "The cylinder is hollow and its wall is too thin for this thread.");
  }
  const outer = internal ? wall : Math.max(R, highest) + Math.max(0.05, 0.02 * R);
  const bored = boreStock(ctx, target, { origin, dir, x: job.x }, L, wall, outer, internal);
  const ends = bored.ends;

  // stay a hair clear of those circles: a face between the thread's end and such a circle must have some width
  const hair = Math.max(0.02, 0.03 * h);
  let endHeight: number | null = null;
  ends.forEach((end, e) => {
    if (!end || end.near === null) return;
    // a circle beyond the far side of the whole thread is no neighbour of it (the step of a wider hole past a nut's thread)
    if (internal ? end.near >= base0 + job.taper * end.z + h : end.near <= base0 + job.taper * end.z) return;
    const [l, u] = at(end.z);
    const limit = heightOf(internal ? end.near + hair : end.near - hair, end.z);
    if (internal ? limit <= l : limit >= u) return;
    if (e === 1 && fade > 1e-9) { endHeight = limit; return; }
    // a chamfer of 45° from that height
    const line: Line = e === 0 ? [(internal ? -1 : 1) / h, limit] : [(internal ? 1 : -1) / h, limit + ((internal ? -1 : 1) * L) / h];
    (internal ? lo : hi).push(line);
  });
  const zs = [...new Set([...kinks(vanishes >= 0 ? vanishes : L).filter((z) => vanishes < 0 || z < vanishes - 1e-6), ...(vanishes >= 0 ? [vanishes] : []), ...(fade > 1e-9 ? [L - fade] : []), L])].sort((p, q) => p - q);
  const clip: ClipRow[] = zs.map((z) => {
    let [l, u] = at(z);
    if (z > L - 1e-9 && endHeight !== null) { if (internal) l = endHeight; else u = endHeight; }
    // past the vanishing point the profile keeps the least height it can have, against the stock's surface
    if (u - l < THREAD_MIN) { if (internal) u = l + THREAD_MIN; else l = u - THREAD_MIN; }
    return { z, lo: l, hi: u, keep: fade > 1e-9 ? Math.min(1, Math.max(0, (L - z) / fade)) : 1 };
  });
  const shape: ThreadShape = {
    origin, dir, x: job.x, length: L, pitch: job.pitch, starts: job.starts, left: job.left,
    base: base0, taper: job.taper, depth: h, loFlat: job.minorFlat, hiFlat: job.majorFlat, clip, into: internal ? "lo" : "hi", prefix: job.prefix,
  };

  // the fast way: put the thread's section in place of the wall's circle on each end face, and sew
  const surface = bored.clean ? threadSurface(ctx, shape) : null;
  const top = (z: number) => base0 + job.taper * z + h * (internal ? Math.max(0, Math.min(1, at(z)[0])) : Math.max(0, Math.min(1, at(z)[1])));
  let result = surface ? graft(ctx, bored, surface.faces, surface.start, surface.end, [top(0), top(L)]) : null;
  if (!result) {
    // the slow way, for a body whose end faces are not what a tube leaves: join a threaded sleeve with a boolean
    const sleeve = threadSolid(ctx, { ...shape, wall });
    result = k.boolean("fuse", { shape: bored.piece, faces: k.namedFaces(bored.piece, bored.names, id) }, { shape: sleeve.shape, faces: toolFaces(ctx, sleeve) }, id, ctx.own);
  }
  return { result, length: L };
}

/** threadInto for a picked cylindrical face: the body it is on gets the thread. */
export function threadOn(ctx: EvalContext, cyl: CylinderFace, job: Omit<ThreadJob, "origin" | "dir" | "x" | "radius" | "lo" | "hi" | "hole" | "prefix">): number {
  const k = ctx.k;
  const { result, length } = threadInto(ctx, { shape: cyl.body.shape, faces: cyl.body.topo.faces }, { ...job, origin: cyl.origin, dir: cyl.dir, x: cyl.x, radius: cyl.radius, lo: cyl.lo, hi: cyl.hi, hole: cyl.hole, prefix: ctx.feature.id });
  const solids = k.solids(result.shape).map((s) => ({ s, v: k.volume(s) })).sort((p, q) => q.v - p.v);
  if (!solids.length) throw ctx.fail("The thread left nothing of the body.");
  ctx.replaceBody(cyl.body, solids[0].s, result.names);
  return length;
}

/**
 * Which ends of a cylinder are closed.  A shaft's end is closed when there is wider stock beyond it (a shoulder);
 * a hole's when the hole stops there.
 */
export function closedEnds(ctx: EvalContext, c: CylinderFace): { lo: boolean; hi: boolean } {
  const eps = Math.max(0.02, c.radius * 0.02);
  const blocked = (end: "lo" | "hi"): boolean => {
    const z = end === "lo" ? c.lo - eps : c.hi + eps;
    const onAxis = add(c.origin, scale(c.dir, z));
    // a shaft: stock just outside its surface, past the end; a hole: stock on the axis, past the end
    return inside(ctx, c.body.shape, c.hole ? onAxis : add(onAxis, scale(c.x, c.radius + eps)));
  };
  return { lo: blocked("lo"), hi: blocked("hi") };
}

/** Where a thread on a cylinder starts and whether its far end needs a run-out, from what the dialog says. */
export function threadEnds(ctx: EvalContext, c: CylinderFace, flip: boolean, length: number): { fromHi: boolean; fades: boolean } {
  const closed = closedEnds(ctx, c);
  // the open end; with both ends alike, the far end of the axis (the top of a shaft that stands up)
  let fromHi = closed.lo === closed.hi ? true : closed.lo;
  if (flip) fromHi = !fromHi;
  const farClosed = fromHi ? closed.lo : closed.hi;
  return { fromHi, fades: farClosed || length < c.hi - c.lo - 1e-6 };
}

/** The area of an unclipped thread's section: the volume of one millimetre of threaded rod.  For checks and tests. */
export function threadSectionArea(t: Pick<ThreadShape, "base" | "depth" | "loFlat" | "hiFlat" | "pitch">): number {
  const a = t.loFlat / t.pitch, b = t.hiFlat / t.pitch, f = (1 - a - b) / 2, r0 = t.base, r1 = t.base + t.depth;
  return Math.PI * (a * r0 * r0 + b * r1 * r1 + 2 * f * ((r0 * r0 + r0 * r1 + r1 * r1) / 3));
}
