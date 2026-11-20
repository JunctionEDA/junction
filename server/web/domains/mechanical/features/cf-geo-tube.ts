// cf-geo-tube.ts — the Tube: a round tube or bar along a 3D path (sketch lines, edges, a curve feature, a
// curve through XYZ points).  A path of straight runs gets a round bend of one radius at every corner, as a
// tube bender makes; a path that is already curved is followed as it is.  With a wall thickness it is hollow.
//
// Names: `<id>:outer`, `<id>:inner` (the bore), `<id>:start`, `<id>:end` (`~2`, `~3`… where one surface is
// several faces, a straight run and a bend).
import { defineFeature } from "../core/feature";
import { length, sub, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { TOOL_OPS, applyTools, bentWire, edgePoints, pipeAlong, scopeOf, type ToolOp } from "../kernel/ops/cf-geo";
import { pathWire } from "../kernel/ops/sweep-path";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TubeParams { [key: string]: any; path: RefTarget[]; diameter: number; wall: number; bend: number; operation: ToolOp; bodies: string[] }

/** The corners of a wire made of straight edges only, in order; null when any edge is curved. */
export function straightRuns(ctx: EvalContext, wire: Shape): Vec3[] | null {
  const oc = ctx.oc as any;
  const runs: Vec3[][] = [];
  for (const e of ctx.k.sub(wire, "edge")) {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) return null;
    runs.push(edgePoints(ctx, e));
  }
  if (!runs.length) return null;
  const near = (a: Vec3, b: Vec3) => length(sub(a, b)) < 1e-6;
  // the edges of a path wire come in order, each either way round
  const pts: Vec3[] = [];
  runs.forEach((r, i) => {
    let [a, b] = [r[0], r[r.length - 1]];
    if (i === 0 && runs.length > 1) { const n = runs[1]; if (near(a, n[0]) || near(a, n[n.length - 1])) [a, b] = [b, a]; }
    else if (i > 0 && !near(a, pts[pts.length - 1])) [a, b] = [b, a];
    if (i === 0) pts.push(a);
    pts.push(b);
  });
  return pts;
}

export default defineFeature<TubeParams>({
  type: "cf-geo-tube",
  title: "Tube",
  hint: "A round tube or bar along a 3D path, with a bend radius at its corners.",
  keywords: "tube pipe piping bar rod wire handrail roll cage bend radius along path 3d route hose conduit",
  icon: '<path class="f" d="M3 6.500h9a5.500 5.500 0 0 1 5.500 5.500v9h-5v-9a.500.500 0 0 0-.500-.500H3z"/><path d="M3 6.500h9a5.500 5.500 0 0 1 5.500 5.500v9M3 11.500h9a.500.500 0 0 1 .500.500v9"/><ellipse cx="3" cy="9" rx="1" ry="2.500"/><ellipse cx="15" cy="21" rx="2.500" ry="1"/>',
  toolbarOrder: 323, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ path: [], diameter: 10, wall: 1, bend: 15, operation: "new", bodies: [] }),
  schema: [
    { key: "path", label: "Path", kind: "refs", of: ["edge"], datums: ["curve"], sketch: true, hint: "A sketch curve (the curves joined to it come too), edges, or a curve. The tube's centre line." },
    { key: "diameter", label: "Outer diameter", kind: "number", unit: "mm", min: 0.01, step: 1 },
    { key: "wall", label: "Wall", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "0 makes a solid bar." },
    { key: "bend", label: "Bend radius", kind: "number", unit: "mm", min: 0, step: 1, hint: "To the centre line, at every corner of a path of straight runs. 0 leaves the corners as they are." },
    { key: "operation", label: "Result", kind: "enum", options: TOOL_OPS },
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
  ],

  evaluate(ctx: EvalContext, p: TubeParams) {
    if (!(p.diameter > 0)) throw ctx.fail("The diameter must be more than zero.");
    if (!(p.wall >= 0) || p.wall * 2 >= p.diameter) throw ctx.fail("The wall must be less than half the diameter (0 for a solid bar).");
    if (!(p.bend >= 0)) throw ctx.fail("The bend radius cannot be less than zero.");
    let wire = pathWire(ctx, Array.isArray(p.path) ? p.path : []);
    const corners = straightRuns(ctx, wire);
    if (corners && corners.length > 2 && p.bend > 0) {
      if (p.bend < p.diameter / 2) throw ctx.fail("The bend radius must be at least half the tube's diameter, or the inside of the bend folds over.");
      wire = bentWire(ctx, corners, p.bend);
    }
    const tube = pipeAlong(ctx, wire, p.diameter / 2, p.wall > 0 ? p.diameter / 2 - p.wall : 0);
    const op: ToolOp = p.operation === "add" || p.operation === "remove" ? p.operation : "new";
    applyTools(ctx, [tube], op, op === "new" ? [] : scopeOf(ctx, p.bodies, null), "Tube");
  },
});
