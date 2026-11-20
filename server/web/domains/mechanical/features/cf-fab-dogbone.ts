// cf-fab-dogbone.ts — Dogbone: relief for the inside corners a round cutter cannot reach.
//
// Pick the face the cutter comes down on (the top of the plate, or of a pocket's part).  Every inside corner of
// that body whose edge runs along the cutter gets a round relief of the cutter's diameter, so a square part
// still seats in the corner:
//   dogbone   the circle is on the corner's bisector and passes through the corner;
//   T-bone    the circle is pushed along one wall, so only the other wall is cut into (flip chooses which).
// Corners wider than the largest angle given (a shallow bend is not a corner) are left alone.
// Names: `<id>:<the corner's edge>:wall`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub, type GeomRef, type Vec3 } from "../core/geometry";
import type { Body, EvalContext } from "../kernel/types";
import { edgeInfo } from "../kernel/ops/ref-geom";
import { facesOfEdge } from "../kernel/ops/shapes";
import { changeAll, cylinder, frameAt, inside, positive } from "../kernel/ops/cf-fab";
import { LASER } from "./_cf-fab";
import type { NamedResult } from "../kernel/occ";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DogboneParams { [key: string]: any; faces: GeomRef[]; diameter: number; style: "dogbone" | "tbone"; flip: boolean; maxAngle: number }

export default defineFeature<DogboneParams>({
  type: "cf-fab-dogbone",
  title: "Dogbone",
  icon: '<path class="f" fill-rule="evenodd" d="M3 3h18v18H3zM9.5 8h5a1.6 1.6 0 1 1 1.5 1.5v5a1.6 1.6 0 1 1-1.5 1.5h-5a1.6 1.6 0 1 1-1.5-1.5v-5A1.6 1.6 0 1 1 9.5 8z"/><path d="M3 3h18v18H3zM9.5 8h5a1.6 1.6 0 1 1 1.5 1.5v5a1.6 1.6 0 1 1-1.5 1.5h-5a1.6 1.6 0 1 1-1.5-1.5v-5A1.6 1.6 0 1 1 9.5 8z"/>',
  hint: "Round relief in inside corners so square parts seat after CNC routing",
  keywords: "dogbone dog bone t-bone tbone corner relief overcut cnc router inside corner fillet",
  ...LASER, toolbarOrder: 20,
  defaults: () => ({ faces: [], diameter: 3.175, style: "dogbone", flip: false, maxAngle: 135 }),
  schema: [
    { key: "faces", label: "Top faces", kind: "refs", of: ["face"], hint: "The face the cutter comes down on, on each part to relieve." },
    { key: "diameter", label: "Cutter diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "style", label: "Style", kind: "enum", options: [{ value: "dogbone", label: "Dogbone" }, { value: "tbone", label: "T-bone" }] },
    { key: "flip", label: "Cut the other wall", kind: "boolean", visible: (p) => p.style === "tbone" },
    { key: "maxAngle", label: "Corners up to", kind: "number", unit: "deg", min: 10, max: 175, step: 5, hint: "Inside corners wider than this are left alone." },
  ],

  evaluate(ctx: EvalContext, p: DogboneParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const refs = Array.isArray(p.faces) ? p.faces : [];
    if (!refs.length) throw ctx.fail("Pick the face the cutter comes down on.");
    const r = positive(ctx, p.diameter, "cutter diameter") / 2;
    const maxAngle = Number(p.maxAngle) || 135;
    const jobs = new Map<string, { body: Body; normals: Vec3[] }>();
    for (const ref of refs) {
      const res = ctx.resolve(ref);
      const frame = res.kind === "face" ? k.faceFrame(oc.TopoDS.Face(res.shape)) : null;
      if (!frame) throw ctx.fail("Pick a flat face: the one the cutter comes down on.");
      const job = jobs.get(res.body.id) || { body: res.body, normals: [] };
      job.normals.push(frame.normal);
      jobs.set(res.body.id, job);
    }
    let total = 0;
    for (const { body, normals } of jobs.values()) {
      const tools: NamedResult[] = [];
      for (const e of body.topo.edges) {
        const info = edgeInfo(ctx, e.shape);
        if (info.kind !== "line" || !normals.some((n) => Math.abs(dot(info.dir!, n)) > 1 - 1e-6)) continue;
        const walls = facesOfEdge(k, body.topo.faces, e.shape).sort((a, b) => (a.name < b.name ? -1 : 1));
        if (walls.length !== 2) continue;
        const fa = k.faceFrame(oc.TopoDS.Face(walls[0].shape)), fb = k.faceFrame(oc.TopoDS.Face(walls[1].shape));
        if (!fa || !fb) continue;
        let n1 = fa.normal, n2 = fb.normal;
        const c = dot(n1, n2);
        if (Math.abs(c) > 0.9999) continue;
        // inside corner: just round the corner from one wall, behind the other, there is material
        const eps = Math.min(0.01, r / 10);
        if (!inside(ctx, body.shape, add(info.mid, scale(normalize(sub(n1, n2)), eps)), 1e-7) || !inside(ctx, body.shape, add(info.mid, scale(normalize(sub(n2, n1)), eps)), 1e-7)) continue;
        // the angle of the opening between the walls: 90° for a square pocket
        const opening = (Math.acos(Math.max(-1, Math.min(1, -c))) * 180) / Math.PI;
        if (opening > maxAngle + 1e-6) continue;
        if (p.flip) [n1, n2] = [n2, n1];
        const along = normalize(sub(n1, scale(n2, c)));   // in the second wall, away from the corner
        const offset = p.style === "tbone" ? scale(along, r) : scale(normalize(add(n1, n2)), r);
        const len = length(sub(info.end, info.start));
        const f = frameAt(add(info.start, offset), cross(info.dir!, Math.abs(info.dir![0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]), info.dir!);
        tools.push(cylinder(ctx, f, [0, 0], r, 0, len, `${id}:${e.name}`));
      }
      total += tools.length;
      if (tools.length > 400) throw ctx.fail("That is too many corners at once (more than 400).");
      changeAll(ctx, body, "cut", tools);
    }
    if (!total) throw ctx.fail("There is no inside corner along the cutter on that part. Pick the face the cutter comes down on.");
  },
});
