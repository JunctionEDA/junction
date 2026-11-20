// mate-connector.ts — the Mate connector feature: a coordinate system kept on the part, where something will
// later be mated or measured from.  It sits on a vertex, an edge (its middle, or a round edge's centre) or a face
// (its centre; a cylinder's axis), or half-way between two such places.  Its z axis is the face's normal, the
// edge's direction or the round edge's axis; it can be flipped, turned about z, and moved in its own axes.
//
// It is reference geometry of kind "plane" (its xy plane), so a sketch can be put on it and every field that
// takes a plane or an axis takes it; the viewport draws its three axes (`DatumView.mate`).
import { defineFeature } from "../core/feature";
import { add, cross, isGeomRef, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { edgeInfo, faceInfo, frameFromNormal, pointOf } from "../kernel/ops/ref-geom";
import { rotateAbout } from "../kernel/ops/ref-datum";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MateConnectorParams { [key: string]: any; origin: RefTarget | null; between: RefTarget | null; flip: boolean; turn: number; x: number; y: number; z: number }

const PLACE = { kind: "refs" as const, of: ["vertex" as const, "edge" as const, "face" as const], single: true, datums: ["point" as const, "axis" as const, "plane" as const], sketch: true };

/** The z axis a place gives a connector: a face's normal or axis, an edge's direction or axis; else straight up. */
function axisAt(ctx: EvalContext, t: RefTarget): Vec3 {
  if (t.kind === "datum") { const d = ctx.datum(t.feature); return d.kind === "plane" && d.frame ? d.frame.normal : d.kind === "axis" && d.dir ? d.dir : [0, 0, 1]; }
  if (!isGeomRef(t)) return [0, 0, 1];
  const r = ctx.resolve(t);
  if (r.kind === "face") { const f = faceInfo(ctx, r.shape); return f.frame ? f.frame.normal : f.axis ? f.axis.dir : [0, 0, 1]; }
  if (r.kind === "edge") { const e = edgeInfo(ctx, r.shape); return e.kind === "line" ? e.dir! : e.kind === "circle" ? e.axis! : [0, 0, 1]; }
  return [0, 0, 1];
}

export default defineFeature<MateConnectorParams>({
  type: "mate-connector",
  title: "Mate connector",
  hint: "A coordinate system on the part: where it will be mated, or a plane and axis to build from.",
  keywords: "coordinate system frame csys origin mate connection point datum",
  icon: '<circle class="f" cx="9" cy="15" r="3.5"/><circle cx="9" cy="15" r="3.5"/><path d="M9 15V3.5M7 5.5l2-2 2 2M9 15h11.5M18.5 13l2 2-2 2"/><path class="t" d="M9 15l-5.5 5"/>',
  toolbarOrder: 66, toolbarSection: "reference", toolbarKeep: 32,
  defaults: () => ({ origin: null, between: null, flip: false, turn: 0, x: 0, y: 0, z: 0 }),
  schema: [
    { key: "origin", label: "Origin", ...PLACE, hint: "A vertex, an edge (its middle, or a circle's centre) or a face (its centre)." },
    { key: "between", label: "Half-way to", ...PLACE, hint: "Optional: the connector is put half-way between the origin and this." },
    { key: "flip", label: "Flip the main axis", kind: "boolean" },
    { key: "turn", label: "Turn about the main axis", kind: "number", unit: "deg", step: 90 },
    { key: "x", label: "Move X", kind: "number", unit: "mm", hint: "Along the connector's own axes." },
    { key: "y", label: "Move Y", kind: "number", unit: "mm" },
    { key: "z", label: "Move Z", kind: "number", unit: "mm" },
  ],

  evaluate(ctx: EvalContext, p: MateConnectorParams) {
    if (!p.origin) throw ctx.fail("Pick where the mate connector sits: a vertex, an edge or a face.");
    let at = pointOf(ctx, p.origin, "origin");
    if (p.between) at = scale(add(at, pointOf(ctx, p.between, "second place")), 0.5);
    let zAxis = axisAt(ctx, p.origin);
    if (p.flip) zAxis = scale(zAxis, -1);
    const f = frameFromNormal(at, zAxis);
    const a = ((Number(p.turn) || 0) * Math.PI) / 180;
    const x = a ? rotateAbout(f.x, f.normal, a) : f.x, y = cross(f.normal, x);
    const origin = add(at, add(add(scale(x, Number(p.x) || 0), scale(y, Number(p.y) || 0)), scale(f.normal, Number(p.z) || 0)));
    void sub;
    ctx.setDatum({ featureId: ctx.feature.id, kind: "plane", frame: { origin, x, y, normal: f.normal }, centre: origin, size: 10, mate: true });
  },
});
