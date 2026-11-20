// isocline.ts — the Isocline feature: the curves on faces where the surface is at a given angle to a
// direction — at 0° the silhouette seen along it, where a moulded part's parting line goes; at a draft angle
// the line beyond which a face lacks draft.  Each face is sampled on a grid of its (u, v) parameters, the
// level curve dot(normal, direction) = sin(angle) is traced through it (marching squares, refined on each grid
// edge), the parts off a trimmed face are dropped, and each run of points becomes a spline.
import { defineFeature } from "../core/feature";
import { cross, dot, length, normalize, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { axisOf } from "../kernel/ops/ref-geom";
import { distance } from "../kernel/ops/shapes";
import { setCurve, splineThrough } from "../kernel/ops/curves";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IsoclineParams { [key: string]: any; faces: RefTarget[]; direction: RefTarget | null; angle: number }

const N = 48;

/** The level curves of one face, as runs of 3D points. */
function traceFace(ctx: EvalContext, face: Shape, dir: Vec3, level: number): { pts: Vec3[]; closed: boolean }[] {
  const oc = ctx.oc as any, k = ctx.k;
  const f = oc.TopoDS.Face(face);
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(f, true));
  const reversed = f.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  const u0 = ad.FirstUParameter(), u1 = ad.LastUParameter(), v0 = ad.FirstVParameter(), v1 = ad.LastVParameter();
  const P = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), DU = ctx.tmp(new oc.gp_Vec(0, 0, 0)), DV = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  const evalAt = (u: number, v: number): { at: Vec3; g: number } => {
    ad.D1(u, v, P, DU, DV);
    let n = cross(k.xyz(DU), k.xyz(DV));
    const s = length(n);
    if (s < 1e-12) return { at: k.xyz(P), g: NaN };
    n = normalize(n); if (reversed) n = [-n[0], -n[1], -n[2]];
    return { at: k.xyz(P), g: dot(n, dir) - level };
  };
  const U = (i: number) => u0 + ((u1 - u0) * i) / N, V = (j: number) => v0 + ((v1 - v0) * j) / N;
  const g: number[][] = [];
  for (let i = 0; i <= N; i++) { g.push([]); for (let j = 0; j <= N; j++) g[i].push(evalAt(U(i), V(j)).g); }
  // the crossing on a grid edge between (i, j) and (i2, j2), refined by bisection; keyed so neighbours share it
  const cache = new Map<string, Vec3>();
  const cross0 = (i: number, j: number, i2: number, j2: number): string => {
    const key = i2 > i || j2 > j ? `${i},${j},${i2},${j2}` : `${i2},${j2},${i},${j}`;
    if (!cache.has(key)) {
      let a = 0, b = 1;
      const ga = g[i][j];
      for (let it = 0; it < 30; it++) {
        const m = (a + b) / 2, gm = evalAt(U(i + (i2 - i) * m), V(j + (j2 - j) * m)).g;
        if (Math.sign(gm) === Math.sign(ga)) a = m; else b = m;
      }
      const m = (a + b) / 2;
      cache.set(key, evalAt(U(i + (i2 - i) * m), V(j + (j2 - j) * m)).at);
    }
    return key;
  };
  // marching squares: each cell gives up to two segments joining crossings on its sides
  const segs: [string, string][] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const c = [g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]];
    if (c.some((x) => !Number.isFinite(x))) continue;
    const corner = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    const sides: string[] = [];
    for (let s = 0; s < 4; s++) {
      const a = c[s], b = c[(s + 1) % 4];
      if ((a < 0) !== (b < 0)) sides.push(cross0(corner[s][0], corner[s][1], corner[(s + 1) % 4][0], corner[(s + 1) % 4][1]));
    }
    if (sides.length === 2) segs.push([sides[0], sides[1]]);
    else if (sides.length === 4) { segs.push([sides[0], sides[1]]); segs.push([sides[2], sides[3]]); }
  }
  // join the segments into runs
  const at = new Map<string, number[]>();
  segs.forEach((s, n) => { for (const p of s) at.set(p, [...(at.get(p) || []), n]); });
  const used = new Set<number>(), runs: { pts: Vec3[]; closed: boolean }[] = [];
  for (let n = 0; n < segs.length; n++) {
    if (used.has(n)) continue;
    used.add(n);
    const keys = [segs[n][0], segs[n][1]];
    const grow = (front: boolean) => {
      for (;;) {
        const tip = front ? keys[0] : keys[keys.length - 1];
        const next = (at.get(tip) || []).find((m) => !used.has(m));
        if (next === undefined) return;
        used.add(next);
        const other = segs[next][0] === tip ? segs[next][1] : segs[next][0];
        if (front) keys.unshift(other); else keys.push(other);
      }
    };
    grow(false); grow(true);
    const closed = keys.length > 3 && keys[0] === keys[keys.length - 1];
    runs.push({ pts: keys.map((x) => cache.get(x)!), closed });
  }
  // (runs cut by a periodic face's seam are joined again end to end by setCurve)
  return runs;
}

export default defineFeature<IsoclineParams>({
  type: "isocline",
  title: "Isocline",
  hint: "Curves on faces where the surface is at an angle to a direction: silhouettes, parting lines, draft checks.",
  keywords: "parting line silhouette draft angle curve on face direction",
  icon: '<path class="f" d="M5 6c0-2 14-2 14 0v12c0 2-14 2-14 0z"/><path class="t" d="M5 6c0 2 14 2 14 0M5 6v12c0 2 14 2 14 0V6"/><path d="M12 8v12"/><path class="d t" d="M2 13h4M18 13h4"/>',
  toolbarOrder: 64.7, toolbarSection: "reference", toolbarMenu: "Curve", toolbarKeep: 31,
  defaults: () => ({ faces: [], direction: null, angle: 0 }),
  schema: [
    { key: "faces", label: "Faces", kind: "refs", of: ["face"] },
    { key: "direction", label: "Direction", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "An axis, a straight edge, or a plane (its normal): the pull direction." },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: -89, max: 89, step: 1, hint: "The surface's angle to the direction: 0 is where it runs parallel to it." },
  ],

  evaluate(ctx: EvalContext, p: IsoclineParams) {
    const picks = (Array.isArray(p.faces) ? p.faces : []).filter((t) => t.kind === "face");
    if (!picks.length) throw ctx.fail("Pick the faces to find the isocline on.");
    if (!p.direction) throw ctx.fail("Pick the direction: an axis, an edge or a plane.");
    const angle = Number(p.angle) || 0;
    if (Math.abs(angle) >= 90) throw ctx.fail("The angle must be between -90° and 90°.");
    const dir = normalize(axisOf(ctx, p.direction, "direction").dir);
    const level = Math.sin((angle * Math.PI) / 180);
    const edges: Shape[] = [];
    for (const t of picks) {
      const face = ctx.resolve(t as any).shape;
      for (const run of traceFace(ctx, face, dir, level)) {
        // a trimmed face: keep the stretches whose points are on the face itself
        const stretches: Vec3[][] = [[]];
        for (const q of run.pts) {
          const v = ctx.tmp(new (ctx.oc as any).BRepBuilderAPI_MakeVertex(ctx.tmp(ctx.k.pnt(q)))).Vertex();
          if (distance(ctx.k, face, v) < 1e-5) stretches[stretches.length - 1].push(q);
          else if (stretches[stretches.length - 1].length) stretches.push([]);
        }
        const whole = stretches.length === 1 && stretches[0].length === run.pts.length;
        for (const s of stretches) {
          const pts = s.filter((q, i) => i === 0 || length(sub(q, s[i - 1])) > 1e-4);
          if (pts.length < 2) continue;
          edges.push(splineThrough(ctx, pts, { closed: whole && run.closed }));
        }
      }
    }
    if (!edges.length) throw ctx.fail("The faces are nowhere at that angle to the direction.");
    setCurve(ctx, edges);
  },
});
