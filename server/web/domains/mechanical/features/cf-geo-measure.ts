// cf-geo-measure.ts — Measure to variable: measure the model as it is at this place in the feature list (a
// distance, an angle, a length, an area, a volume, an extent) and keep the answer in a variable, so that
// features further down are driven by it: a lid as long as the box turned out, a hole at half a measured gap.
//
// The feature does the measuring, in the worker; it leaves a reference point where it measured, carrying the
// value (`measure: { name, value, unit }` on its datum).  The page writes that value into the variable of that
// name after each regeneration (tools/cf-geo-measure-sync.ts), as "12.5 mm", "30 deg" or a plain number for an
// area (mm²) or a volume (mm³), and the features that use the variable are then rebuilt with it.  The variable
// is an ordinary one: stored in the document, listed in Variables, read by everything that builds the part.
// A feature above this one that used the variable would chase its own tail; the page stops after a few rounds.
import { defineFeature } from "../core/feature";
import { add, dot, isGeomRef, scale, type GeomRef, type Vec3 } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { tightBox } from "../kernel/ops/cf-geo";
import { axisOf, pointOf, planeOf } from "../kernel/ops/ref-geom";
import { planeFace, solidCentre } from "../kernel/ops/shapes";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MeasureParams { [key: string]: any; what: "distance" | "angle" | "length" | "area" | "volume" | "extent"; a: RefTarget | null; b: RefTarget | null; items: GeomRef[]; bodies: string[]; axis: "x" | "y" | "z"; name: string }

export type MeasureUnit = "mm" | "deg" | "mm2" | "mm3";
export interface Measured { name: string; value: number; unit: MeasureUnit }

/** What a pick is to measure from: its shape, or a point or plane made into one. */
function shapeOf(ctx: EvalContext, t: RefTarget | null, what: string): Shape {
  const oc = ctx.oc as any, k = ctx.k;
  if (!t) throw ctx.fail(`Pick the ${what}.`);
  if (isGeomRef(t)) return ctx.resolve(t).shape;
  if (t.kind === "plane" || (t.kind === "datum" && ctx.datum(t.feature).kind === "plane")) { const f = planeOf(ctx, t, what); return planeFace(k, f.origin, f.normal, 1e5, ctx.own); }
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(pointOf(ctx, t, what))))).Vertex());
}

export default defineFeature<MeasureParams>({
  type: "cf-geo-measure",
  title: "Measure to variable",
  hint: "Measure a distance, angle, length, area, volume or extent and keep it in a variable for later features.",
  keywords: "measure value variable store measured distance angle volume area length driven dimension reference dimension evaluate",
  icon: '<path class="f" d="M3 14.500L14.500 3l6.500 6.500L9.500 21z"/><path d="M3 14.500L14.500 3l6.500 6.500L9.500 21z"/><path class="t" d="M6.500 11l2 2M9.300 8.200l3 3M12.100 5.400l2 2"/><path d="M14 18.500h7M17.500 15.500l3.500 3-3.500 3"/>',
  toolbarOrder: 332, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ what: "distance", a: null, b: null, items: [], bodies: [], axis: "x", name: "measured" }),
  schema: [
    { key: "what", label: "Measure", kind: "enum", options: [{ value: "distance", label: "Distance" }, { value: "angle", label: "Angle" }, { value: "length", label: "Length" }, { value: "area", label: "Area" }, { value: "volume", label: "Volume" }, { value: "extent", label: "Extent" }] },
    { key: "a", label: "From", kind: "refs", of: ["vertex", "edge", "face"], single: true, planes: true, datums: ["point", "axis", "plane"], sketch: true, hint: "Distance: the least distance between the two picks. Angle: between their directions (an edge's, a face's normal).", visible: (p) => p.what === "distance" || p.what === "angle" },
    { key: "b", label: "To", kind: "refs", of: ["vertex", "edge", "face"], single: true, planes: true, datums: ["point", "axis", "plane"], sketch: true, visible: (p) => p.what === "distance" || p.what === "angle" },
    { key: "items", label: "Edges or faces", kind: "refs", of: ["edge", "face"], hint: "Length: the edges' lengths added up. Area: the faces' areas added up.", visible: (p) => p.what === "length" || p.what === "area" },
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.what === "volume" || p.what === "extent" },
    { key: "axis", label: "Along", kind: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }], hint: "The bodies' size along this axis.", visible: (p) => p.what === "extent" },
    { key: "name", label: "Variable", kind: "text", hint: "The variable that gets the value. It is made if there is none of that name, and rewritten whenever the measurement changes." },
  ],

  evaluate(ctx: EvalContext, p: MeasureParams) {
    const oc = ctx.oc as any, k = ctx.k;
    const name = String(p.name ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw ctx.fail("Name the variable: letters, digits and _, not starting with a digit.");
    const bodiesOf = (): Body[] => {
      const ids = Array.isArray(p.bodies) ? p.bodies : [];
      const out = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
      if (!out.length) throw ctx.fail(ids.length ? "The bodies to measure no longer exist. Pick them again." : "There is no body to measure.");
      return out;
    };
    let value = 0, unit: MeasureUnit = "mm", at: Vec3 = [0, 0, 0];
    if (p.what === "distance") {
      const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
      d.LoadS1(shapeOf(ctx, p.a, "place to measure from")); d.LoadS2(shapeOf(ctx, p.b, "place to measure to"));
      d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
      if (!d.IsDone() || !d.NbSolution()) throw ctx.fail("The distance could not be measured between these.");
      value = d.Value();
      const q1 = d.PointOnShape1(1), q2 = d.PointOnShape2(1);
      at = scale(add(k.xyz(q1), k.xyz(q2)), 0.5); q1.delete(); q2.delete();
    } else if (p.what === "angle") {
      const u = axisOf(ctx, p.a, "first direction"), v = axisOf(ctx, p.b, "second direction");
      value = (Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(u.dir, v.dir))))) * 180) / Math.PI; unit = "deg";
      at = scale(add(u.origin, v.origin), 0.5);
    } else if (p.what === "length" || p.what === "area") {
      const want = p.what === "length" ? "edge" : "face";
      const picked = (Array.isArray(p.items) ? p.items : []).map((r) => ctx.resolve(r)).filter((r) => r.kind === want);
      if (!picked.length) throw ctx.fail(p.what === "length" ? "Pick the edges to measure the length of." : "Pick the faces to measure the area of.");
      for (const r of picked) {
        const g = ctx.tmp(new oc.GProp_GProps());
        if (want === "edge") oc.BRepGProp.LinearProperties(r.shape, g, false, false); else oc.BRepGProp.SurfaceProperties(r.shape, g, false, false);
        value += g.Mass();
        at = add(at, scale(k.centre(r.shape, want), 1 / picked.length));
      }
      if (p.what === "area") unit = "mm2";
    } else if (p.what === "volume") {
      const bodies = bodiesOf();
      for (const b of bodies) { const v = k.volume(b.shape); value += v; at = add(at, scale(solidCentre(k, b.shape), v)); }
      if (!(value > 0)) throw ctx.fail("The bodies have no volume.");
      at = scale(at, 1 / value); unit = "mm3";
    } else if (p.what === "extent") {
      const b = tightBox(ctx, bodiesOf().map((x) => x.shape));
      if (!b) throw ctx.fail("The bodies have no size.");
      const i = p.axis === "y" ? 1 : p.axis === "z" ? 2 : 0;
      value = b[i + 3] - b[i]; at = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    } else throw ctx.fail("Choose what to measure.");
    if (!Number.isFinite(value)) throw ctx.fail("The measurement has no value.");
    const measure: Measured = { name, value, unit };
    ctx.setDatum({ featureId: ctx.feature.id, kind: "point", at, measure } as any);
  },
});
