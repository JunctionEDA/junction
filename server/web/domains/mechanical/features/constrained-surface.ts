// constrained-surface.ts — the Constrained surface feature: one smooth surface through a selection of points,
// within a tolerance.  The points are vertices, reference points, sketch points and the ends of sketch curves,
// and every point of the sketches named.
//
// How: the points' best-fitting plane is found; over it the surface is the smoothest height field that passes
// through every point (a thin-plate spline), sampled on a grid across the points' extent and handed to the
// kernel as one B-spline face.  The grid is refined until the face lies within the tolerance of every point; a
// surface that cannot get there says how far off it is.  Three points give a plane.
//
// Face: `<id>:surface`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { pointOf } from "../kernel/ops/ref-geom";
import { distanceTo, sketchEntityPoints } from "../kernel/ops/surface";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ConstrainedSurfaceParams { [key: string]: any; points: RefTarget[]; sketches: string[]; tolerance: number; margin: number }

/** The eigenvector of a symmetric 3 × 3 matrix with the smallest eigenvalue (Jacobi rotations). */
function smallestAxis(m: number[][]): Vec3 {
  const a = m.map((r) => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let i = 0; i < 3; i++) { const x = a[i][p], y = a[i][q]; a[i][p] = c * x - s * y; a[i][q] = s * x + c * y; }
      for (let i = 0; i < 3; i++) { const x = a[p][i], y = a[q][i]; a[p][i] = c * x - s * y; a[q][i] = s * x + c * y; }
      for (let i = 0; i < 3; i++) { const x = v[i][p], y = v[i][q]; v[i][p] = c * x - s * y; v[i][q] = s * x + c * y; }
    }
  }
  let k = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] < a[k][k]) k = i;
  return normalize([v[0][k], v[1][k], v[2][k]]);
}

/** Solve a dense linear system in place (partial pivoting); null when it is singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]]; [b[c], b[piv]] = [b[piv], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let j = c; j < n; j++) A[r][j] -= f * A[c][j];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j]; x[r] = s / A[r][r]; }
  return x;
}

const phi = (r: number) => (r > 1e-12 ? r * r * Math.log(r) : 0);

/** The smoothest height over a plane through points (u, v, h): a thin-plate spline; null when two points lie above each other. */
export function thinPlate(pts: readonly [number, number, number][]): ((u: number, v: number) => number) | null {
  const n = pts.length, size = n + 3;
  const A = Array.from({ length: size }, () => new Array<number>(size).fill(0)), b = new Array<number>(size).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = phi(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]));
    A[i][n] = 1; A[i][n + 1] = pts[i][0]; A[i][n + 2] = pts[i][1];
    A[n][i] = 1; A[n + 1][i] = pts[i][0]; A[n + 2][i] = pts[i][1];
    b[i] = pts[i][2];
  }
  const w = solve(A, b);
  if (!w) return null;
  return (u, v) => { let h = w[n] + w[n + 1] * u + w[n + 2] * v; for (let i = 0; i < n; i++) h += w[i] * phi(Math.hypot(u - pts[i][0], v - pts[i][1])); return h; };
}

export default defineFeature<ConstrainedSurfaceParams>({
  type: "constrained-surface",
  title: "Constrained surface",
  icon: '<path class="f" d="M2.500 12c3-6 6.500-7 9.500-4s6 1 9.500-3.500v8c-3.500 4.500-6.500 6.500-9.500 3.500s-6.500-2-9.500 4z"/><path d="M2.500 12c3-6 6.500-7 9.500-4s6 1 9.500-3.500v8c-3.500 4.500-6.500 6.500-9.500 3.500s-6.500-2-9.500 4z"/><circle class="s" cx="6.500" cy="11.500" r="1.500"/><circle class="s" cx="12" cy="12" r="1.500"/><circle class="s" cx="17.500" cy="9.500" r="1.500"/>',
  toolbarOrder: 70, toolbarSection: "surface", toolbarKeep: 32,
  hint: "One smooth surface through a selection of points, within a tolerance.",
  keywords: "surface points fit cloud scan through freeform",
  defaults: () => ({ points: [], sketches: [], tolerance: 0.01, margin: 0 }),
  schema: [
    { key: "points", label: "Points", kind: "refs", of: ["vertex"], datums: ["point"], sketch: true, hint: "Vertices, reference points, sketch points; a sketch curve gives its ends." },
    { key: "sketches", label: "Sketches of points", kind: "features", types: ["sketch"], hint: "Optional: every point of these sketches." },
    { key: "tolerance", label: "Tolerance", kind: "number", unit: "mm", min: 0.0001, step: 0.01, hint: "How close the surface must pass to every point." },
    { key: "margin", label: "Margin", kind: "number", unit: "mm", min: 0, step: 1, hint: "How far the surface reaches past the outermost points." },
  ],

  evaluate(ctx: EvalContext, p: ConstrainedSurfaceParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    const raw: Vec3[] = [];
    for (const t of Array.isArray(p.points) ? p.points : []) {
      if (t && t.kind === "sketch") raw.push(...sketchEntityPoints(ctx, t.feature, t.entity));
      else raw.push(pointOf(ctx, t, "point"));
    }
    for (const sid of Array.isArray(p.sketches) ? p.sketches : []) {
      const s = ctx.sketch(sid);
      for (const eid of Object.keys(s.data.entities).sort()) if ((s.data.entities[eid] as any).type === "point") raw.push(...sketchEntityPoints(ctx, sid, eid));
    }
    const pts: Vec3[] = [];
    for (const q of raw) if (!pts.some((x) => length(sub(x, q)) < 1e-7)) pts.push(q);
    if (pts.length < 3) throw ctx.fail("Pick three or more points for the surface to pass through.");
    const tol = Number(p.tolerance) > 0 ? Number(p.tolerance) : 0.01;
    const margin = Math.max(0, Number(p.margin) || 0);

    // the best-fitting plane
    const c = scale(pts.reduce((s, q) => add(s, q), [0, 0, 0] as Vec3), 1 / pts.length);
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const q of pts) { const d = sub(q, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j]; }
    let n = smallestAxis(cov);
    // face the way most of the axes do, so the surface does not turn over when a point moves
    if (n[2] < -1e-9 || (Math.abs(n[2]) <= 1e-9 && (n[1] < -1e-9 || (Math.abs(n[1]) <= 1e-9 && n[0] < 0)))) n = scale(n, -1);
    const seed: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x = normalize(sub(seed, scale(n, dot(seed, n)))), y = cross(n, x);
    const local = pts.map((q): [number, number, number] => { const d = sub(q, c); return [dot(d, x), dot(d, y), dot(d, n)]; });
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of local) { u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); }
    u0 -= margin; u1 += margin; v0 -= margin; v1 += margin;
    if (!(u1 - u0 > 1e-6) || !(v1 - v0 > 1e-6)) throw ctx.fail("The points lie on one line. Add a point off the line.");
    const height = thinPlate(local);
    if (!height) throw ctx.fail("The points lie on one line, or two of them lie straight above each other as the surface faces. Add a point off the line; a surface through points cannot fold over.");

    let face: any = null, worst = Infinity;
    for (const grid of [16, 28, 44]) {
      const arr = ctx.tmp(new oc.NCollection_Array2_gp_Pnt(1, grid, 1, grid));
      for (let i = 0; i < grid; i++) for (let j = 0; j < grid; j++) {
        const u = u0 + ((u1 - u0) * i) / (grid - 1), v = v0 + ((v1 - v0) * j) / (grid - 1);
        arr.SetValue(i + 1, j + 1, ctx.tmp(k.pnt(add(c, add(scale(x, u), add(scale(y, v), scale(n, height(u, v))))))));
      }
      const fit = ctx.tmp(new oc.GeomAPI_PointsToBSplineSurface(arr, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, Math.min(tol / 10, 1e-3)));
      if (!fit.IsDone()) continue;
      const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(ctx.tmp(fit.Surface()), 1e-6));
      if (!mk.IsDone()) continue;
      const made = ctx.own(mk.Face());
      const dev = pts.reduce((m, q) => Math.max(m, distanceTo(ctx, q, made)), 0);
      if (dev < worst) { worst = dev; face = made; }
      if (dev <= tol) break;
    }
    if (!face) throw ctx.fail("A surface could not be put through the points.");
    if (worst > tol) ctx.warn(`The surface passes within ${worst.toPrecision(2)} mm of the points, not the ${tol} mm asked for.`);
    ctx.addBody(face, () => `${id}:surface`);
  },
});
