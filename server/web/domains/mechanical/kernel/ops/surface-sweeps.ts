// surface-sweeps.ts — the "Surface" result of Extrude, Revolve, Sweep and Loft: the curves of a sketch (open or
// closed, not only its closed regions) pulled, turned, carried or blended into a surface instead of a solid.
//
// Each of those features has a first field, Solid │ Surface (`bodyType`).  With Surface its evaluate hands over
// to one function here, so the solid code is untouched.  The faces are named as the solid's sides are:
// `<id>:side:<sketch entity>` for what each curve swept.  The result is always new surface bodies (one per
// connected sheet); the solid choices that make no sense for a sheet (Add, Remove, draft, thin wall, up to
// face) are hidden.
import type { ParamField } from "../../core/feature";
import { cross, dot, length, scale, sub, type GeomRef, type Vec3 } from "../../core/geometry";
import { isGeomRef } from "../../core/geometry";
import type { RefTarget } from "../../features/_refs";
import { ShapeIndex, type NamedResult } from "../occ";
import type { EvalContext, FaceNamer, NamedShape, Shape, SketchGeometry } from "../types";
import { edgeAxis, sketchLineAxis, type Axis } from "./axis";
import { axisOf } from "./ref-geom";
import { compound, moveNamed } from "./shapes";
import { addSheets, chains, sewNamed, wireEnds, wireOf } from "./surface";
import { pathWire, sketchEdge } from "./sweep-path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export type BodyType = "solid" | "surface";
export const isSurface = (p: { bodyType?: unknown }): boolean => p.bodyType === "surface";

/**
 * A feature's fields with Solid │ Surface put first.  `solidOnly` names the fields that mean nothing for a
 * surface: they are hidden while Surface is chosen.
 */
export function withSurfaceType(schema: ParamField[], solidOnly: readonly string[]): ParamField[] {
  const first: ParamField = { key: "bodyType", label: "Creates", kind: "enum", options: [{ value: "solid", label: "Solid" }, { value: "surface", label: "Surface" }], hint: "Surface: a sheet from the sketch's curves (they need not close) instead of a solid from its regions." };
  return [first, ...schema.map((f): ParamField => (solidOnly.includes(f.key) ? { ...f, visible: (p) => !isSurface(p) && (!f.visible || f.visible(p)) } : f))];
}

interface Curve { entity: string; edge: Shape }

/**
 * The curves of a sketch as edges: every curve that is not construction geometry, or only the outlines of the
 * regions named.  `skip` leaves curves out (the axis line of a revolve).
 */
export function sketchCurves(ctx: EvalContext, sketchId: string, regions: readonly string[] | null | undefined, skip: readonly string[] = []): Curve[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const s = ctx.sketch(sketchId);
  let ids: string[];
  if (regions && regions.length) {
    const set = new Set<string>();
    for (const r of s.regions) if (regions.includes(r.id)) for (const e of r.edges) set.add(e.entity);
    ids = Array.from(set).sort();
  } else ids = Object.keys(s.data.entities).sort().filter((id) => { const e = s.data.entities[id] as Any; return e.type !== "point" && !e.construction; });
  const out: Curve[] = [];
  for (const id of ids) {
    if (skip.includes(id)) continue;
    const e = sketchEdge(ctx, sketchId, id);
    for (const part of e.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE ? k.sub(e, "edge") : [e]) out.push({ entity: id, edge: part });
  }
  return out;
}

/** Name what each curve swept and add the result as surface bodies. */
function finish(ctx: EvalContext, shape: Shape, history: { Generated(s: Shape): Any }, curves: readonly Curve[], move?: (r: NamedResult) => NamedResult): void {
  const k = ctx.k, id = ctx.feature.id;
  const named = new ShapeIndex<string>(k);
  for (const c of curves) for (const f of k.list(history.Generated(c.edge))) if (!named.has(f)) named.add(f, `${id}:side:${c.entity}`);
  let r: NamedResult = { shape, names: (f) => named.get(f) ?? null };
  if (move) r = move(r);
  const faces: NamedShape[] = k.namedFaces(r.shape, r.names, id);
  if (!faces.length) throw ctx.fail("The curves made no surface.");
  addSheets(ctx, sewNamed(ctx, faces));
}

const profileOf = (ctx: EvalContext, p: Any, verb: string): { sketch: SketchGeometry; id: string } => {
  if (!p.profile || !p.profile.sketch) throw ctx.fail(`Pick a sketch to ${verb}.`);
  return { sketch: ctx.sketch(p.profile.sketch), id: p.profile.sketch };
};

/** Extrude: the sketch's curves pulled along its normal, by a depth, symmetric about the sketch, or two ways. */
export function extrudeSurface(ctx: EvalContext, p: Any): void {
  const oc = ctx.oc as Any, k = ctx.k;
  const { sketch, id: sid } = profileOf(ctx, p, "extrude");
  const end = p.endType || "blind";
  if (end !== "blind" && end !== "symmetric") throw ctx.fail("A surface is extruded by a depth. Choose Depth or Symmetric.");
  if (!(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
  const second = !!p.second && end !== "symmetric";
  if (second && !(Number(p.secondDepth) > 0)) throw ctx.fail("The second depth must be more than zero.");
  const curves = sketchCurves(ctx, sid, p.profile.regions);
  if (!curves.length) throw ctx.fail("The sketch has no curve to extrude.");
  const n: Vec3 = scale(sketch.frame.normal, p.flip && end !== "symmetric" ? -1 : 1);
  const fwd = end === "symmetric" ? p.depth / 2 : p.depth;
  const back = end === "symmetric" ? p.depth / 2 : second ? Number(p.secondDepth) : 0;
  const mk = ctx.own(new oc.BRepPrimAPI_MakePrism(compound(k, curves.map((c) => c.edge), ctx.own), ctx.tmp(k.vec(scale(n, fwd + back))), false, true));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("The curves could not be extruded.");
  finish(ctx, ctx.own(mk.Shape()), mk, curves, back ? (r) => moveNamed(k, r.shape, r.names, { translate: scale(n, -back) }, ctx.own) : undefined);
}

/** Revolve: the sketch's curves turned about the axis. */
export function revolveSurface(ctx: EvalContext, p: Any): void {
  const oc = ctx.oc as Any, k = ctx.k;
  const { sketch, id: sid } = profileOf(ctx, p, "revolve");
  const full = p.endType === "full" || Number(p.angle) >= 360;
  if (!full && !(Number(p.angle) > 0 && Number(p.angle) <= 360)) throw ctx.fail("The angle must be more than 0° and at most 360°.");
  let axis: Axis, skip: string[] = [];
  if (p.axisType === "edge") axis = !p.axisEdge || isGeomRef(p.axisEdge) ? edgeAxis(ctx, p.axisEdge as GeomRef | null) : axisOf(ctx, p.axisEdge as RefTarget, "axis");
  else if (p.axisType === "x") axis = { origin: sketch.frame.origin, dir: sketch.frame.x };
  else if (p.axisType === "y") axis = { origin: sketch.frame.origin, dir: sketch.frame.y };
  else { const a = sketchLineAxis(ctx, sketch); axis = a.axis; skip = [a.entity]; }
  // a line of this very sketch picked as the axis is not part of the profile either
  const picked = p.axisEdge as Any;
  if (p.axisType === "edge" && picked && picked.kind === "sketch" && picked.feature === sid) skip = [picked.entity];
  if (p.flip && p.endType === "angle") axis = { origin: axis.origin, dir: scale(axis.dir, -1) };
  if (Math.abs(dot(axis.dir, sketch.frame.normal)) > 1 - 1e-9) throw ctx.fail("The axis is square to the sketch; pick an axis that lies in the sketch's plane.");
  const curves = sketchCurves(ctx, sid, p.profile.regions, skip);
  if (!curves.length) throw ctx.fail("The sketch has no curve to revolve besides the axis.");
  // the curves must lie on one side of the axis, or the surface would pass through itself
  const side = cross(axis.dir, sketch.frame.normal);
  let lo = 0, hi = 0;
  for (const c of curves) for (const v of k.sub(c.edge, "vertex")) { const d = dot(sub(k.vertexPoint(v), axis.origin), side); lo = Math.min(lo, d); hi = Math.max(hi, d); }
  if (lo < -1e-6 && hi > 1e-6) throw ctx.fail("The curves cross the axis. Keep them on one side of it.");
  const ax = ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(axis.origin)), ctx.tmp(k.dir(axis.dir))));
  const angle = full ? 360 : Number(p.angle);
  const profile = compound(k, curves.map((c) => c.edge), ctx.own);
  const mk = ctx.own(full ? new oc.BRepPrimAPI_MakeRevol(profile, ax, true) : new oc.BRepPrimAPI_MakeRevol(profile, ax, (angle * Math.PI) / 180, true));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("The curves could not be revolved.");
  finish(ctx, ctx.own(mk.Shape()), mk, curves, p.endType === "symmetric" && !full ? (r) => moveNamed(k, r.shape, r.names, { axis, angle: -angle / 2 }, ctx.own) : undefined);
}

/** Sweep: the sketch's curves carried along the path. */
export function sweepSurface(ctx: EvalContext, p: Any): void {
  const oc = ctx.oc as Any, k = ctx.k;
  const { id: sid } = profileOf(ctx, p, "sweep");
  const path: RefTarget[] = Array.isArray(p.path) ? p.path : [];
  if (path.some((t) => t.kind === "sketch" && t.feature === sid)) throw ctx.fail("The path must be in a different sketch from the profile.");
  const curves = sketchCurves(ctx, sid, p.profile.regions);
  if (!curves.length) throw ctx.fail("The profile sketch has no curve to sweep.");
  const spine = pathWire(ctx, path);
  // a smooth path: each curve is carried along it on its own, so its faces are known by the curve
  const id = ctx.feature.id;
  const smooth: NamedShape[] = [];
  try {
    for (const c of curves) {
      const mk = ctx.own(new oc.BRepOffsetAPI_MakePipe(oc.TopoDS.Wire(spine), c.edge));
      mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!mk.IsDone()) { smooth.length = 0; break; }
      const made = k.sub(ctx.own(mk.Shape()), "face");
      if (!made.length) { smooth.length = 0; break; }
      for (const f of made) smooth.push({ name: `${id}:side:${c.entity}`, shape: f });
    }
  } catch (e) { smooth.length = 0; }
  if (smooth.length) { addSheets(ctx, sewNamed(ctx, smooth)); return; }
  // a path with sharp corners: each chain of the profile on its own, with a transition at the corners
  const mode = p.corners === "sharp" ? oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner : oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner;
  const faces: NamedShape[] = [];
  const entityOf = new ShapeIndex<string>(k);
  for (const c of curves) entityOf.add(c.edge, c.entity);
  for (const chain of chains(ctx, curves.map((c) => c.edge))) {
    const wire = wireOf(ctx, chain.edges);
    const ps = ctx.own(new oc.BRepOffsetAPI_MakePipeShell(oc.TopoDS.Wire(spine)));
    ps.SetMode(false);
    ps.SetTransitionMode(mode);
    ps.Add(wire, false, false);
    ps.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!ps.IsDone()) throw ctx.fail("The curves could not be swept along the path. Try a smoother path.");
    const named = new ShapeIndex<string>(k);
    for (const e of k.sub(wire, "edge")) for (const f of k.list(ps.Generated(e))) if (!named.has(f)) named.add(f, `${ctx.feature.id}:side:${entityOf.get(e) ?? "curve"}`);
    const names: FaceNamer = (f) => named.get(f) ?? null;
    faces.push(...k.namedFaces(ctx.own(ps.Shape()), names, ctx.feature.id));
  }
  if (!faces.length) throw ctx.fail("The curves made no surface.");
  addSheets(ctx, sewNamed(ctx, faces));
}

/** One wire through a sketch for a loft: its first region's outline, or else the chain of curves it holds. */
function loftWire(ctx: EvalContext, sketchId: string): Shape {
  const oc = ctx.oc as Any;
  const s = ctx.sketch(sketchId);
  if (s.regions.length) return oc.BRepTools.OuterWire(s.regions[0].face);
  const curves = sketchCurves(ctx, sketchId, null);
  if (!curves.length) throw ctx.fail("A sketch to loft through has no curve.");
  const all = chains(ctx, curves.map((c) => c.edge));
  if (all.length > 1) ctx.warn("A sketch has several separate curves: the loft uses the first chain.");
  return wireOf(ctx, all[0].edges);
}

/** Loft: one surface through the curves of two or more sketches (their outlines when they are closed). */
export function loftSurface(ctx: EvalContext, p: Any): void {
  const oc = ctx.oc as Any, k = ctx.k, id = ctx.feature.id;
  const ids: string[] = Array.isArray(p.profiles) ? p.profiles : [];
  if (ids.length < 2) throw ctx.fail("Pick two or more sketches to loft through.");
  const ts = ctx.own(new oc.BRepOffsetAPI_ThruSections(false, !!p.ruled, 1e-6));
  let before: [Vec3, Vec3] | null = null, first: Shape | null = null;
  for (const sid of ids) {
    let wire = loftWire(ctx, sid);
    let ends = wireEnds(ctx, wire);
    // open curves drawn in opposite directions would twist the surface: run each the way the one before it runs
    if (before && length(sub(ends[0], ends[1])) > 1e-6 && length(sub(ends[0], before[0])) + length(sub(ends[1], before[1])) > length(sub(ends[1], before[0])) + length(sub(ends[0], before[1])) + 1e-9) {
      wire = ctx.own(wire.Reversed()); ends = [ends[1], ends[0]];
    }
    before = ends;
    if (!first) first = wire;
    ts.AddWire(oc.TopoDS.Wire(wire));
  }
  try { ts.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (e) { throw ctx.fail("The loft could not be built. Curves with the same number of pieces loft best."); }
  if (!ts.IsDone()) throw ctx.fail("The loft could not be built. Curves with the same number of pieces loft best.");
  const shape: Shape = ctx.own(ts.Shape());
  const named = new ShapeIndex<string>(k);
  k.sub(first!, "edge").forEach((e, i) => { try { for (const f of k.list(ts.Generated(e))) if (!named.has(f)) named.add(f, `${id}:side:${i + 1}`); } catch (x) { /* the loft rebuilt the profile: fallback names */ } });
  const faces = k.namedFaces(shape, (f) => named.get(f) ?? null, id);
  if (!faces.length) throw ctx.fail("The loft made no surface. Put the curves on different planes.");
  addSheets(ctx, sewNamed(ctx, faces));
}
