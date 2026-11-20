// cf-geo-airfoil.ts — the Airfoil wing: a body lofted between a root and a tip section.  A section is a NACA
// four-digit one worked out here (features/_cf-geo.ts naca4: the series' own thickness and camber formulas),
// or coordinates pasted from an airfoil table (Selig or Lednicer order: x y pairs round the outline).  The tip
// can be smaller (taper), set back (sweep), raised (dihedral) and turned (twist, about its quarter chord).
//
// The sections lie on a plane (x along the chord from the leading edge, y up), the root at its origin; the
// span is along the plane's normal.  Each outline is one smooth curve round the nose from the trailing edge and
// back, closed by a short flat when the trailing edge is blunt.
//
// Names: `<id>:skin:<n>` (the strip of the surface from the n-th span of the outline, counted from the trailing
// edge over the top), `<id>:te` (a blunt trailing edge), `<id>:root`, `<id>:tip`.
import { defineFeature } from "../core/feature";
import { add, scale, toWorld, type Frame, type Vec2, type Vec3 } from "../core/geometry";
import type { EvalContext, NamedShape, Shape } from "../kernel/types";
import { ShapeIndex } from "../kernel/occ";
import { applyTools, scopeOf } from "../kernel/ops/cf-geo";
import { segment } from "../kernel/ops/curves";
import { planeOf } from "../kernel/ops/ref-geom";
import { nurbsCurve } from "../kernel/ops/sketch-curves";
import { interpolate, type Piece } from "../sketch/curves";
import { airfoilFromTable, naca4, type Airfoil } from "./_cf-geo";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AirfoilParams {
  [key: string]: any;
  source: "naca" | "table"; naca: string; tipNaca: string; table: string; plane: RefTarget | null;
  chord: number; tipChord: number; span: number; sweep: number; dihedral: number; twist: number; sharp: boolean; operation: "new" | "add"; bodies: string[];
}

/** Points along each side of a NACA section: the skin is this many faces above and below. */
const SIDE = 20;

/**
 * A section's outline as a closed wire on `frame`'s plane; `at` says where a point of the unit section is on
 * it.  The outline is one smooth cubic curve from the trailing edge round the nose and back, cut into an edge
 * per span between its points (the kernel measures volumes poorly across a curve's inner knots).
 */
function sectionWire(ctx: EvalContext, a: Airfoil, frame: Frame, at: (q: Vec2) => Vec2): Shape {
  const oc = ctx.oc as any;
  const round: Vec2[] = [...a.upper.slice().reverse(), ...a.lower.slice(1)];
  const blunt = Math.hypot(round[0][0] - round[round.length - 1][0], round[0][1] - round[round.length - 1][1]) > 1e-9;
  if (!blunt) round[round.length - 1] = round[0];
  const unit = interpolate(round, false, null, null);
  if (!unit) throw ctx.fail("The section has two points in one place. Take the repeated point out of the table.");
  // a turn, a size and a move of the curve's control points are the same turn, size and move of the curve
  const nurbs = { ...unit, poles: unit.poles.map(at) };
  const curve = nurbsCurve(ctx, frame, { nurbs, t0: nurbs.knots[0], t1: nurbs.knots[nurbs.knots.length - 1], closed: false } as Piece);
  const knots = Array.from(new Set(nurbs.knots));
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  for (let i = 1; i < knots.length; i++) if (knots[i] - knots[i - 1] > 1e-12) mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(curve, knots[i - 1], knots[i])).Edge()));
  if (blunt) mw.Add(oc.TopoDS.Edge(segment(ctx, toWorld(frame, at(round[round.length - 1])), toWorld(frame, at(round[0])))));
  if (!mw.IsDone()) throw ctx.fail("A section's outline could not be closed.");
  return ctx.own(mw.Wire());
}

export default defineFeature<AirfoilParams>({
  type: "cf-geo-airfoil",
  title: "Airfoil wing",
  hint: "A wing, blade or fin lofted between airfoil sections: NACA four-digit, or coordinates from a table.",
  keywords: "airfoil aerofoil naca 4 digit wing blade fin propeller loft sections csv coordinates selig dat profile hydrofoil",
  icon: '<path class="f" d="M2.500 13c2-4.500 8-6 12-5 3 .700 5.500 2.500 7 5-6 1.500-13 1.800-19 0z"/><path d="M2.500 13c2-4.500 8-6 12-5 3 .700 5.500 2.500 7 5-6 1.500-13 1.800-19 0z"/><path class="d t" d="M2.500 13h19"/>',
  toolbarOrder: 322, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ source: "naca", naca: "2412", tipNaca: "", table: "", plane: { kind: "plane", plane: "front" }, chord: 100, tipChord: 60, span: 200, sweep: 20, dihedral: 0, twist: 0, sharp: true, operation: "new", bodies: [] }),
  schema: [
    { key: "source", label: "Section", kind: "enum", options: [{ value: "naca", label: "NACA 4-digit" }, { value: "table", label: "Table" }] },
    { key: "naca", label: "NACA", kind: "text", hint: "Four digits: camber %, its place in tenths of the chord, thickness %. 0012 is symmetric and 12 % thick.", visible: (p) => p.source !== "table" },
    { key: "tipNaca", label: "NACA at the tip", kind: "text", hint: "Leave empty for the same section at the tip.", visible: (p) => p.source !== "table" },
    { key: "table", label: "Coordinates", kind: "text", hint: "Paste x y pairs round the outline, as an airfoil .dat file lists them (chord from 0 to 1).", visible: (p) => p.source === "table" },
    { key: "plane", label: "Root plane", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "The root section lies on it, its leading edge at the plane's origin; the span is along its normal." },
    { key: "chord", label: "Root chord", kind: "number", unit: "mm", min: 0.01, step: 5 },
    { key: "tipChord", label: "Tip chord", kind: "number", unit: "mm", min: 0.01, step: 5 },
    { key: "span", label: "Span", kind: "number", unit: "mm", min: 0.01, step: 10, hint: "From root to tip, along the plane's normal." },
    { key: "sweep", label: "Sweep", kind: "number", unit: "mm", step: 5, hint: "How far back the tip's leading edge is from the root's." },
    { key: "dihedral", label: "Dihedral", kind: "number", unit: "deg", min: -80, max: 80, step: 1, hint: "The tip is raised by this angle seen from the front." },
    { key: "twist", label: "Twist", kind: "number", unit: "deg", min: -45, max: 45, step: 1, hint: "Turns the tip nose down (washout) about its quarter chord." },
    { key: "sharp", label: "Sharp trailing edge", kind: "boolean", hint: "Close the NACA section to a point instead of its small blunt end.", visible: (p) => p.source !== "table" },
    { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] },
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation === "add" },
  ],

  evaluate(ctx: EvalContext, p: AirfoilParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!(p.chord > 0) || !(p.tipChord > 0) || !(p.span > 0)) throw ctx.fail("The chords and the span must be more than zero.");
    if (Math.abs(p.dihedral) > 80 || Math.abs(p.twist) > 45) throw ctx.fail("The dihedral is within ±80° and the twist within ±45°.");
    let root: Airfoil, tip: Airfoil;
    try {
      if (p.source === "table") root = tip = airfoilFromTable(p.table);
      else { root = naca4(p.naca, SIDE, !!p.sharp); tip = String(p.tipNaca || "").trim() ? naca4(p.tipNaca, SIDE, !!p.sharp) : root; }
    } catch (e) { throw ctx.fail((e as Error).message); }
    const f: Frame = planeOf(ctx, p.plane, "root plane");
    const place = (chord: number, twist: number) => (q: Vec2): Vec2 => {
      // turned about the quarter chord, nose down for a positive twist
      const c = Math.cos(twist), s = Math.sin(twist), x = q[0] - 0.25, y = q[1];
      return [(0.25 + x * c + y * s) * chord, (-x * s + y * c) * chord];
    };
    const tipAt: Vec3 = add(add(add(f.origin, scale(f.normal, p.span)), scale(f.x, Number(p.sweep) || 0)), scale(f.y, p.span * Math.tan(((Number(p.dihedral) || 0) * Math.PI) / 180)));
    const w0 = sectionWire(ctx, root, f, place(p.chord, 0)), w1 = sectionWire(ctx, tip, { ...f, origin: tipAt }, place(p.tipChord, ((Number(p.twist) || 0) * Math.PI) / 180));
    const mk = ctx.tmp(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
    mk.AddWire(oc.TopoDS.Wire(w0)); mk.AddWire(oc.TopoDS.Wire(w1));
    mk.CheckCompatibility(false);
    try { mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (e) { throw ctx.fail(`The wing could not be lofted (${k.describe(e)}).`); }
    if (!mk.IsDone()) throw ctx.fail("The wing could not be lofted between these sections.");
    let shape: Shape = ctx.own(mk.Shape());
    if (k.volume(shape) < 0) shape = ctx.own(shape.Reversed());
    if (!(k.volume(shape) > 1e-9)) throw ctx.fail("The wing has no volume.");
    // a strip of the skin is named by the span of the root's outline it starts from, counted from the trailing
    // edge over the top and round the nose
    const spans = new ShapeIndex<number>(k);
    k.sub(w0, "edge").forEach((e, i) => spans.add(e, i + 1));
    const faces = k.sub(shape, "face"), names = faces.map((face) => {
      const flat = k.faceFrame(oc.TopoDS.Face(face));
      if (!flat) { const n = k.sub(face, "edge").map((e) => spans.get(e)).find((v) => v !== undefined); return n ? `${id}:skin:${n}` : `${id}:skin`; }
      const along = Math.abs(flat.normal[0] * f.normal[0] + flat.normal[1] * f.normal[1] + flat.normal[2] * f.normal[2]) > 0.999;
      if (!along) return `${id}:te`;
      const c = k.centre(face, "face"), d = (c[0] - f.origin[0]) * f.normal[0] + (c[1] - f.origin[1]) * f.normal[1] + (c[2] - f.origin[2]) * f.normal[2];
      return d < p.span / 2 ? `${id}:root` : `${id}:tip`;
    });
    k.settleNames(faces, names, `${id}:new`, "face");
    const named: NamedShape[] = faces.map((face, i) => ({ name: names[i]!, shape: face }));
    applyTools(ctx, [{ shape, faces: named }], p.operation === "add" ? "add" : "new", p.operation === "add" ? scopeOf(ctx, p.bodies, null) : [], "Wing");
  },
});
