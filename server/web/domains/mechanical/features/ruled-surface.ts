// ruled-surface.ts — the Ruled surface feature: a strip of straight lines that starts on edges, sketch curves or
// curves and runs a distance from them.
//
//   Normal               the lines stand square to the surface the edge is on
//   Tangent              the lines leave in the surface's own direction, square to the edge: the surface carried on
//   Aligned with vector  the lines all run along one direction (an edge, an axis, the normal of a plane or face)
//   Angle from vector    as aligned, turned about the edge by an angle
//
// The surface an edge is on is the reference face when it holds the edge, or else the first face beside it; a
// sketch curve has its sketch plane.  The strips of edges that meet are sewn into one surface.
//
// Faces: `<id>:ruled:<the edge's name>`.
import { defineFeature } from "../core/feature";
import { cross, dot, isGeomRef, length, normalize, scale, sub, type GeomRef, type Vec3 } from "../core/geometry";
import type { EvalContext, NamedShape } from "../kernel/types";
import { axisOf, planeOf } from "../kernel/ops/ref-geom";
import { addSheets, outward, pickedEdges, ribbon, sampleEdge, samplesFor, sewNamed } from "../kernel/ops/surface";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type RuledType = "normal" | "tangent" | "vector" | "angle";

export interface RuledSurfaceParams {
  [key: string]: any;
  edges: RefTarget[];
  ruledType: RuledType;
  distance: number;
  /** the direction for "vector" and "angle": an edge, an axis, a plane or a flat face (its normal) */
  direction: RefTarget | null;
  angle: number;
  /** the face whose normal or tangent an edge uses, when the edge lies on two */
  face: GeomRef | null;
  flip: boolean;
}

/** A direction from what was picked: along an edge or an axis, or square to a plane or a flat face. */
function directionOf(ctx: EvalContext, t: RefTarget | null): Vec3 {
  if (!t) throw ctx.fail("Pick the direction: an edge, an axis, a plane or a flat face.");
  if (t.kind === "plane" || (t.kind === "datum" && ctx.datum(t.feature).kind === "plane") || (isGeomRef(t) && t.kind === "face")) return planeOf(ctx, t, "direction").normal;
  return axisOf(ctx, t, "direction").dir;
}

export default defineFeature<RuledSurfaceParams>({
  type: "ruled-surface",
  title: "Ruled surface",
  icon: '<path class="f" d="M3.500 17.500c4-4 8.500-4 13-1.500l4-10.500c-3-1.500-6-1.500-9 .5z"/><path d="M3.500 17.500c4-4 8.500-4 13-1.500"/><path class="t" d="M11.500 6c3-2 6-2 9-.5M3.500 17.500l8-11.500M7 15l6.500-10M10.500 14.500l5.300-9.700M13.700 14.900l4.500-9.800M16.500 16l4-10.500"/>',
  toolbarOrder: 50, toolbarSection: "surface", toolbarKeep: 34,
  hint: "A strip of straight lines from edges or curves: square to the surface, along it, or along a direction.",
  keywords: "surface flange strip parting normal tangent rule extend edge",
  defaults: () => ({ edges: [], ruledType: "normal", distance: 10, direction: null, angle: 30, face: null, flip: false }),
  schema: [
    { key: "edges", label: "Edges", kind: "refs", of: ["edge"], sketch: true, datums: ["curve"] },
    { key: "ruledType", label: "Ruled surface type", kind: "enum", options: [{ value: "normal", label: "Normal" }, { value: "tangent", label: "Tangent" }, { value: "vector", label: "Aligned with vector" }, { value: "angle", label: "Angle from vector" }] },
    { key: "distance", label: "Distance", kind: "number", unit: "mm", min: 0.001, step: 1 },
    { key: "direction", label: "Direction", kind: "refs", of: ["edge", "face"], single: true, datums: ["axis", "plane"], planes: true, sketch: true, hint: "An edge or an axis (along it), or a plane or flat face (square to it).", visible: (p) => p.ruledType === "vector" || p.ruledType === "angle" },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: -89, max: 89, step: 5, visible: (p) => p.ruledType === "angle" },
    { key: "face", label: "Reference face", kind: "refs", of: ["face"], single: true, hint: "Optional: which of an edge's two faces gives the normal or tangent.", visible: (p) => p.ruledType === "normal" || p.ruledType === "tangent" },
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: RuledSurfaceParams) {
    const k = ctx.k, id = ctx.feature.id;
    const picked = pickedEdges(ctx, Array.isArray(p.edges) ? p.edges : []);
    if (!picked.length) throw ctx.fail("Pick the edges or curves the surface starts from.");
    const dist = Number(p.distance);
    if (!(dist > 0)) throw ctx.fail("The distance must be more than zero.");
    const type: RuledType = p.ruledType || "normal";
    const sign = p.flip ? -1 : 1;
    const vector = type === "vector" || type === "angle" ? normalize(directionOf(ctx, p.direction)) : null;
    const refFace = p.face && p.face.name ? ctx.resolve(p.face) : null;

    const strips: NamedShape[] = [];
    for (const e of picked) {
      const face = (refFace && e.faces.find((f) => f.shape.IsSame(refFace.shape))) || e.faces[0] || null;
      let shape;
      if (type === "vector") shape = ribbon(ctx, e.edge, [], [scale(vector!, sign)], dist);
      else if (type === "angle") {
        // the vector, turned about the edge: square to the edge first, so the angle is the one seen along it
        const samples = sampleEdge(ctx, e.edge, null, vector!, samplesFor(ctx, e.edge, true));
        const a = (Number(p.angle) * Math.PI) / 180;
        const dirs = samples.map((s) => {
          const across = sub(vector!, scale(s.tangent, dot(vector!, s.tangent)));
          if (length(across) < 1e-9) throw ctx.fail("The direction runs along an edge. Pick a direction that leaves it.");
          const v = normalize(across), w = cross(s.tangent, v);
          return scale(normalize([v[0] * Math.cos(a) + w[0] * Math.sin(a), v[1] * Math.cos(a) + w[1] * Math.sin(a), v[2] * Math.cos(a) + w[2] * Math.sin(a)]), sign);
        });
        shape = ribbon(ctx, e.edge, samples, dirs, dist);
      } else {
        if (!face && !e.normal) throw ctx.fail("A curve that is on no surface has no normal or tangent. Use “Aligned with vector”.");
        const flat = !face || !!k.faceFrame(face.shape as any);
        const samples = sampleEdge(ctx, e.edge, face ? face.shape : null, e.normal, samplesFor(ctx, e.edge, flat));
        const dirs = type === "normal" ? samples.map((s) => scale(s.normal, sign))
          : (face ? outward(ctx, face.shape, samples) : samples.map((s) => normalize(cross(s.tangent, s.normal)))).map((d) => scale(d, sign));
        shape = ribbon(ctx, e.edge, samples, dirs, dist);
      }
      for (const f of k.sub(shape, "face")) strips.push({ name: `${id}:ruled:${e.name}`, shape: f });
    }
    addSheets(ctx, sewNamed(ctx, strips));
  },
});
