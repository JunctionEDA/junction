// revolve.ts — the Revolve feature: turn the closed regions of a sketch about an axis, all the way round, by
// an angle, or by an angle split evenly either side of the sketch; as new bodies, or added to, removed from or
// intersected with the bodies in scope.
//
// The profile may also be flat faces of the bodies already there (kernel/ops/profile.ts), alone or beside a
// sketch.  A face has no sketch line: its axis is picked (an edge of the face itself will do), or is the X or Y
// of the face's own plane.  By an angle, a face turns out of its solid for New and Add and into it for Remove
// and Intersect.
//
// The axis is a line of the sketch (a construction line, or a line that is not part of a closed outline), the
// sketch's own horizontal or vertical axis, or a straight edge of the model.
//
// Names (CONTRACT.md "Geometry names"), as Extrude's: the faces swept by sketch curves are
// `<id>:side:<entity>`, the caps of a partial revolve `<id>:start:<region>` and `<id>:end:<region>`.
import { defineFeature } from "../core/feature";
import { cross, dot, isGeomRef, scale, sub, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { ShapeIndex, type NamedResult } from "../kernel/occ";
import { edgeAxis, sketchLineAxis, type Axis } from "../kernel/ops/axis";
import { axisOf } from "../kernel/ops/ref-geom";
import type { RefTarget } from "./_refs";
import type { ProfileValue } from "./_profile";
import { resolveProfile } from "../kernel/ops/profile";
import { combine, OPERATION_OPTIONS, type Operation, type Tool } from "../kernel/ops/combine";
import { moveNamed } from "../kernel/ops/shapes";
import { isSurface, revolveSurface, withSurfaceType } from "../kernel/ops/surface-sweeps";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RevolveParams {
  [key: string]: any;
  /** "surface": a sheet from the sketch's curves instead of a solid from its regions (kernel/ops/surface-sweeps.ts) */
  bodyType?: "solid" | "surface";
  /** the sketch and its regions, and / or flat faces of bodies (features/_profile.ts) */
  profile: ProfileValue | null;
  operation: Operation;
  /** "line": a loose line of the sketch; "x" / "y": the sketch's own axes; "edge": what `axisEdge` names */
  axisType: "line" | "x" | "y" | "edge";
  /** a straight model edge, or (a RefTarget, features/_refs.ts) a line of any sketch or a reference axis */
  axisEdge?: GeomRef | RefTarget | null;
  endType: "full" | "angle" | "symmetric";
  angle: number;
  flip: boolean;
  targets: string[];
}

export default defineFeature<RevolveParams>({
  type: "revolve",
  title: "Revolve",
  icon: '<path class="f" d="M4 8.5c0-1.7 3.6-3 8-3s8 1.3 8 3v8c0 1.7-3.6 3-8 3s-8-1.3-8-3z"/><ellipse cx="12" cy="8.5" rx="8" ry="3"/><path d="M4 8.5v8c0 1.7 3.6 3 8 3s8-1.3 8-3v-8"/><path class="d" d="M12 1.5v21"/>',
  toolbarOrder: 22, toolbarSection: "solid", toolbarKeep: 95,
  defaults: () => ({ bodyType: "solid", profile: null, operation: "new", axisType: "line", axisEdge: null, endType: "full", angle: 180, flip: false, targets: [] }),
  schema: withSurfaceType([
    { key: "profile", label: "Sketch or faces", kind: "profile", faces: true, hint: "A sketch (then its regions), or flat faces of a part. For a face, pick the axis: an edge of the face will do." },
    { key: "operation", label: "Result", kind: "enum", options: OPERATION_OPTIONS },
    { key: "axisType", label: "Axis", kind: "enum", options: [{ value: "line", label: "Sketch line" }, { value: "x", label: "Sketch X" }, { value: "y", label: "Sketch Y" }, { value: "edge", label: "Picked" }], hint: "Sketch line: a line drawn in the sketch that is not part of the outline. Picked: an edge, a line of any sketch or a reference axis you click." },
    { key: "axisEdge", label: "Axis", kind: "refs", of: ["edge"], single: true, sketch: true, datums: ["axis"], hint: "A straight edge, a line of a sketch (one among several, a construction line too), or a reference axis.", visible: (p) => p.axisType === "edge" },
    { key: "endType", label: "End", kind: "enum", options: [{ value: "full", label: "Full" }, { value: "angle", label: "Angle" }, { value: "symmetric", label: "Symmetric" }] },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", min: 0.01, max: 360, step: 5, visible: (p) => p.endType !== "full" },
    { key: "flip", label: "Opposite direction", kind: "boolean", visible: (p) => p.endType === "angle" },
    { key: "targets", label: "Bodies to change", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation !== "new" },
  ], ["operation", "targets"]),

  evaluate(ctx: EvalContext, p: RevolveParams) {
    if (isSurface(p)) return revolveSurface(ctx, p);
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    const full = p.endType === "full" || Number(p.angle) >= 360;
    if (!full && !(Number(p.angle) > 0 && Number(p.angle) <= 360)) throw ctx.fail("The angle must be more than 0° and at most 360°.");
    const { regions, sketch } = resolveProfile(ctx, p.profile, "revolve");
    // the sketch's own axes, or those of the first face's plane when there is no sketch
    const frame = sketch ? sketch.frame : regions[0].frame;

    let axis: Axis;
    if (p.axisType === "edge") axis = !p.axisEdge || isGeomRef(p.axisEdge) ? edgeAxis(ctx, p.axisEdge as GeomRef | null) : axisOf(ctx, p.axisEdge, "axis");
    else if (p.axisType === "x") axis = { origin: frame.origin, dir: frame.x };
    else if (p.axisType === "y") axis = { origin: frame.origin, dir: frame.y };
    else if (!sketch) throw ctx.fail("A face has no sketch line to turn about. Choose Picked for the axis and click an edge, a sketch line or a reference axis.");
    else axis = sketchLineAxis(ctx, sketch).axis;
    if (p.flip && p.endType === "angle") axis = { origin: axis.origin, dir: scale(axis.dir, -1) };

    // the profile must lie on one side of the axis, or the solid would pass through itself
    for (const r of regions) {
      if (Math.abs(dot(axis.dir, r.frame.normal)) > 1 - 1e-9) throw ctx.fail(r.from ? "The axis is square to the face; pick an axis that lies in the face's plane." : "The axis is square to the sketch; pick an axis that lies in the sketch's plane.");
      const side = cross(axis.dir, r.frame.normal);
      let lo = 0, hi = 0;
      for (const q of r.outline) { const d = dot(sub(q, axis.origin), side); lo = Math.min(lo, d); hi = Math.max(hi, d); }
      if (lo < -1e-6 && hi > 1e-6) throw ctx.fail("The profile crosses the axis. Move the axis to the edge of the profile, or split the profile.");
    }

    const angle = full ? 360 : Number(p.angle);
    const op: Operation = p.operation || "new";
    const tools: Tool[] = [];
    for (const r of regions) {
      // An angle from a face starts the way an extrusion of it would: out of its solid to make material, into
      // it to take it away ("Opposite direction" turns it round, as it does for a sketch).
      let turn = axis;
      if (r.from && p.endType === "angle" && !full) {
        const leaves = cross(axis.dir, sub(k.centre(r.face, "face"), axis.origin));
        const want = scale(r.frame.normal, op === "remove" || op === "intersect" ? -1 : 1);
        if (dot(leaves, want) * (p.flip ? -1 : 1) < 0) turn = { origin: axis.origin, dir: scale(axis.dir, -1) };
      }
      const ax = ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(turn.origin)), ctx.tmp(k.dir(turn.dir))));
      const mk = ctx.own(full ? new oc.BRepPrimAPI_MakeRevol(r.face, ax, true) : new oc.BRepPrimAPI_MakeRevol(r.face, ax, (angle * Math.PI) / 180, true));
      mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!mk.IsDone()) throw ctx.fail("The profile could not be revolved.");
      const shape = ctx.own(mk.Shape());
      const named = new ShapeIndex<string>(k);
      if (!full) {
        named.add(ctx.own(mk.FirstShape()), `${id}:start:${r.id}`);
        named.add(ctx.own(mk.LastShape()), `${id}:end:${r.id}`);
      }
      for (const e of r.edges) for (const s of k.list(mk.Generated(e.edge))) if (!named.has(s)) named.add(s, `${id}:side:${e.entity}`);
      let t: NamedResult = { shape, names: (f) => named.get(f) ?? null };
      if (p.endType === "symmetric" && !full) t = moveNamed(k, t.shape, t.names, { axis, angle: -angle / 2 }, ctx.own);
      tools.push({ ...t, suffix: r.id });
    }
    combine(ctx, tools, op, p.targets);
  },
});
