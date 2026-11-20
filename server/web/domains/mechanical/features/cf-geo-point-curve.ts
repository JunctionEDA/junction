// cf-geo-point-curve.ts — the Curve through XYZ points: a 3D curve through coordinates pasted from a table (a
// spreadsheet's cells, a CSV file's text): one point a row, x y z, separated by commas, tabs, spaces or
// semicolons.  A title row is passed over; text pasted into the one-line field loses its line breaks and is
// then read three numbers at a time.  The curve is a smooth spline through the points, or straight between
// them.  It is reference geometry of kind "curve", for Sweep, Tube, the curve pattern and the curve features.
import { defineFeature } from "../core/feature";
import { add, length, scale, sub, type Frame, type Vec3 } from "../core/geometry";
import type { EvalContext, Shape } from "../kernel/types";
import { segment, setCurve, splineThrough } from "../kernel/ops/curves";
import { planeOf } from "../kernel/ops/ref-geom";
import { parsePoints } from "./_cf-geo";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PointCurveParams { [key: string]: any; points: string; unit: "mm" | "cm" | "m" | "in"; fit: "spline" | "polyline"; closed: boolean; plane: RefTarget | null }

const WORLD: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
const UNIT_MM: { [u: string]: number } = { mm: 1, cm: 10, m: 1000, in: 25.4 };

/** The points of a table as model points, in a frame. */
export function tablePoints(ctx: EvalContext, text: unknown, unit: string, plane: RefTarget | null, what = "curve"): Vec3[] {
  const k = UNIT_MM[unit] || 1, f = plane ? planeOf(ctx, plane, "frame") : WORLD;
  const rows = parsePoints(text, 3);
  if (rows.length < 2) throw ctx.fail(`Paste the ${what}'s points: two or more rows of x y z.`);
  if (rows.length > 5000) throw ctx.fail("That is too many points (at most 5000).");
  return rows.map((r) => add(add(add(f.origin, scale(f.x, r[0] * k)), scale(f.y, r[1] * k)), scale(f.normal, r[2] * k)));
}

export default defineFeature<PointCurveParams>({
  type: "cf-geo-point-curve",
  title: "Curve through XYZ points",
  hint: "A 3D curve through points pasted from a table or CSV: x y z a row.",
  keywords: "3d spline points table csv xyz coordinates import curve through points spreadsheet excel text file",
  icon: '<path d="M3 18c4-1 4-10 8-10s3 7 10-3"/><circle class="s" cx="3" cy="18" r="1.600"/><circle class="s" cx="11" cy="8" r="1.600"/><circle class="s" cx="21" cy="5" r="1.600"/><path class="t" d="M14 14.500h7M14 17.500h7M14 20.500h7M16.300 13v9M18.700 13v9"/>',
  toolbarOrder: 321, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ points: "0,0,0; 20,10,0; 40,0,15; 60,-10,30", unit: "mm", fit: "spline", closed: false, plane: null }),
  schema: [
    { key: "points", label: "Points", kind: "text", hint: "Paste rows of x y z (commas, tabs or spaces between numbers; a new line or ; between points)." },
    { key: "unit", label: "Table's unit", kind: "enum", options: [{ value: "mm", label: "mm" }, { value: "cm", label: "cm" }, { value: "m", label: "m" }, { value: "in", label: "in" }] },
    { key: "fit", label: "Between points", kind: "enum", options: [{ value: "spline", label: "Smooth" }, { value: "polyline", label: "Straight" }] },
    { key: "closed", label: "Closed", kind: "boolean", hint: "Join the last point back to the first." },
    { key: "plane", label: "Frame", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "Optional: x and y are measured in this plane from its origin, z along its normal." },
  ],

  evaluate(ctx: EvalContext, p: PointCurveParams) {
    let pts = tablePoints(ctx, p.points, p.unit, p.plane);
    pts = pts.filter((q, i) => i === 0 || length(sub(q, pts[i - 1])) > 1e-9);
    if (pts.length < (p.closed ? 3 : 2)) throw ctx.fail(p.closed ? "A closed curve needs three or more different points." : "The points are all in one place.");
    if (p.fit === "polyline") {
      const edges: Shape[] = [];
      for (let i = 1; i < pts.length; i++) edges.push(segment(ctx, pts[i - 1], pts[i]));
      if (p.closed && length(sub(pts[0], pts[pts.length - 1])) > 1e-9) edges.push(segment(ctx, pts[pts.length - 1], pts[0]));
      setCurve(ctx, edges);
      return;
    }
    setCurve(ctx, [splineThrough(ctx, pts, { closed: !!p.closed })]);
  },
});
