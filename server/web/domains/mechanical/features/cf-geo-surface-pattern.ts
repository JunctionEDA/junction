// cf-geo-surface-pattern.ts — the Surface pattern: copies of features or bodies spread over a face in the
// face's own two directions (round and along a cylinder, across and along a curved panel), each copy standing
// on the surface as the original does: it is carried by the move that takes the surface's point, normal and
// first direction under the original to those under the copy.  Places that fall off the face (in a cut-out,
// past a trimmed edge) are left out.  Copies are named `<id>:u<i>.<j>:<seed face name>`.
import { defineFeature } from "../core/feature";
import { cross, dot, length, normalize, scale, sub, type GeomRef, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { frameToFrame, seedCentre } from "../kernel/ops/cf-geo";
import type { Instance } from "../kernel/ops/pattern-core";
import { copyDefaults, copyFields, copyInstances, countOf, type CopyParams } from "./_pattern";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SurfacePatternParams extends CopyParams { [key: string]: any; face: GeomRef | null; countU: number; countV: number; inset: number }

export default defineFeature<SurfacePatternParams>({
  type: "cf-geo-surface-pattern",
  title: "Surface pattern",
  hint: "Spread copies over a curved face in its own two directions, each standing on the surface.",
  keywords: "pattern on surface face uv curved cylinder wrap along surface normal follow grip dimples",
  icon: '<path class="f" d="M3 8c5-4 13-4 18 0v9c-5-4-13-4-18 0z"/><path d="M3 8c5-4 13-4 18 0v9c-5-4-13-4-18 0z"/><circle class="s" cx="7" cy="9.5" r="1.1"/><circle class="s" cx="12" cy="8.3" r="1.1"/><circle class="s" cx="17" cy="9.5" r="1.1"/><circle class="s" cx="7" cy="13.5" r="1.1"/><circle class="s" cx="12" cy="12.3" r="1.1"/><circle class="s" cx="17" cy="13.5" r="1.1"/>',
  toolbarOrder: 305, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ ...copyDefaults(), face: null, countU: 8, countV: 3, inset: 0 }),
  schema: [
    ...copyFields("Copy"),
    { key: "face", label: "Face", kind: "refs", of: ["face"], single: true, hint: "The face to spread the copies over; the original should sit on it." },
    { key: "countU", label: "Count, first direction", kind: "number", unit: "none", min: 1, step: 1, hint: "Round a cylinder or cone; across a flat or free-form face." },
    { key: "countV", label: "Count, second direction", kind: "number", unit: "none", min: 1, step: 1, hint: "Along a cylinder's axis." },
    { key: "inset", label: "Keep from the ends", kind: "number", unit: "none", min: 0, max: 0.45, step: 0.05, hint: "A share of the face's extent left clear at each end of a direction that does not close on itself." },
  ],

  evaluate(ctx: EvalContext, p: SurfacePatternParams) {
    const oc = ctx.oc as any, k = ctx.k;
    const nu = countOf(ctx, p.countU, "first count"), nv = countOf(ctx, p.countV, "second count");
    if (nu * nv > 2500) throw ctx.fail("That is too many copies (at most 2500).");
    if (!(p.inset >= 0) || p.inset > 0.45) throw ctx.fail("The share to keep from the ends is between 0 and 0.45.");
    if (!p.face) throw ctx.fail("Pick the face to spread the copies over.");
    const r = ctx.resolve(p.face);
    if (r.kind !== "face") throw ctx.fail("Pick a face to spread the copies over.");
    const face = oc.TopoDS.Face(r.shape);
    const ad = ctx.tmp(new oc.BRepAdaptor_Surface(face, true));
    const b = oc.BRepTools.UVBounds(face, 0, 0, 0, 0);
    const flip = face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
    const P = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), DU = ctx.tmp(new oc.gp_Vec(0, 0, 0)), DV = ctx.tmp(new oc.gp_Vec(0, 0, 0));
    const at = (u: number, v: number): { origin: Vec3; x: Vec3; normal: Vec3 } | null => {
      ad.D1(u, v, P, DU, DV);
      const du = k.xyz(DU), n = cross(du, k.xyz(DV));
      if (length(n) < 1e-10 || length(du) < 1e-10) return null;
      const normal = scale(normalize(n), flip), x = normalize(sub(du, scale(normal, dot(du, normal))));
      return { origin: k.xyz(P), x, normal };
    };
    // the surface's point under the original: the nearest of a net of points, then closed in on
    const centre = seedCentre(ctx, p);
    const d2 = (u: number, v: number) => { const q = ad.Value(u, v); const d = length(sub(k.xyz(q), centre)); q.delete(); return d; };
    let u0 = b.UMin, v0 = b.VMin, best = Infinity;
    const N = 32;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const u = b.UMin + ((b.UMax - b.UMin) * i) / N, v = b.VMin + ((b.VMax - b.VMin) * j) / N, d = d2(u, v);
      if (d < best) { best = d; u0 = u; v0 = v; }
    }
    let su = (b.UMax - b.UMin) / N, sv = (b.VMax - b.VMin) / N;
    for (let it = 0; it < 40; it++) {
      let moved = false;
      for (const [du, dv] of [[su, 0], [-su, 0], [0, sv], [0, -sv]]) {
        const u = Math.max(b.UMin, Math.min(b.UMax, u0 + du)), v = Math.max(b.VMin, Math.min(b.VMax, v0 + dv)), d = d2(u, v);
        if (d < best - 1e-12) { best = d; u0 = u; v0 = v; moved = true; }
      }
      if (!moved) { su /= 2; sv /= 2; }
    }
    const seed = at(u0, v0);
    if (!seed) throw ctx.fail("The surface has no direction under the original. Move the original off the face's pole or seam.");
    const closedU = ad.IsUClosed() && b.UMax - b.UMin > ad.LastUParameter() - ad.FirstUParameter() - 1e-9;
    const closedV = ad.IsVClosed() && b.VMax - b.VMin > ad.LastVParameter() - ad.FirstVParameter() - 1e-9;
    // the places along one direction: a whole number of steps from the original, inside the usable range
    const places = (lo: number, hi: number, x0: number, n: number, closed: boolean): { x: number; i: number }[] => {
      const a = closed ? lo : lo + (hi - lo) * p.inset, z = closed ? hi : hi - (hi - lo) * p.inset;
      const step = closed ? (hi - lo) / n : n > 1 ? (z - a) / (n - 1) : 0;
      if (n === 1 || step <= 0) return [{ x: x0, i: 0 }];
      const out: { x: number; i: number }[] = [];
      if (closed) { for (let i = 0; i < n; i++) { let x = x0 + i * step; if (x > hi) x -= hi - lo; out.push({ x, i }); } return out; }
      // the original is not moved: it takes the place of the evenly spread row it is nearest, and the row moves
      // with it (where the original is on the surface is found to about a ten-thousandth of the face's extent)
      const slack = (hi - lo) * 1e-4, mine = Math.max(0, Math.min(n - 1, Math.round((x0 - a) / step)));
      for (let i = 0; i < n; i++) { const x = x0 + (i - mine) * step; if (x >= lo - slack && x <= hi + slack) out.push({ x: Math.max(lo, Math.min(hi, x)), i: i - mine }); }
      return out;
    };
    const us = places(b.UMin, b.UMax, u0, nu, closedU), vs = places(b.VMin, b.VMax, v0, nv, closedV);
    const dist = ctx.tmp(new oc.BRepExtrema_DistShapeShape()), range = ctx.tmp(new oc.Message_ProgressRange());
    dist.LoadS2(face);
    const onFace = (q: Vec3): boolean => {
      const vx = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(q)))).Vertex());
      dist.LoadS1(vx); dist.Perform(range);
      return dist.IsDone() && dist.Value() < 1e-5;
    };
    const instances: Instance[] = [];
    let off = 0;
    for (const u of us) for (const v of vs) {
      if (u.i === 0 && v.i === 0) continue;
      const f = at(u.x, v.x);
      if (!f || !onFace(f.origin)) { off++; continue; }
      instances.push({ key: `u${u.i}.${v.i}`, trsf: frameToFrame(ctx, seed, f) });
    }
    if (off) ctx.warn(`${off} ${off === 1 ? "place is" : "places are"} off the face and ${off === 1 ? "was" : "were"} left out.`);
    if (!instances.length && !off) ctx.warn("Counts of one make no copies.");
    copyInstances(ctx, p, instances, "pattern");
  },
});
