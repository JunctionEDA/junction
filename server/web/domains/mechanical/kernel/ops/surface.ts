// surface.ts — what the surface features share: sewing faces into sheets, picked curves as edges and wires, a
// surface's normal along one of its edges, a curve through points, and ruled faces between curves.  Worker side.
//
// A surface is a body with no solid in it (kernel/types.ts Body.sheet): one face, or a shell of faces sewn along
// their common edges.  Every helper that makes one returns a NamedResult, so the faces keep the names the
// feature gave them (CONTRACT.md, "Geometry names").
import { add, cross, isGeomRef, length, normalize, scale, sub, toWorld, type Vec3 } from "../../core/geometry";
import type { RefTarget } from "../../features/_refs";
import { pointOf as sketchPoint } from "../../sketch/format";
import { ShapeIndex, type NamedResult } from "../occ";
import type { Body, EvalContext, FaceNamer, NamedShape, Shape } from "../types";
import { chainOf, sketchEdge } from "./sweep-path";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** How close two faces' edges must lie to be sewn into one edge (mm). */
export const SEW_TOL = 1e-4;

export const surfaceArea = (ctx: EvalContext, shape: Shape): number => {
  const g = ctx.tmp(new (ctx.oc as Any).GProp_GProps());
  (ctx.oc as Any).BRepGProp.SurfaceProperties(shape, g, false, false);
  return g.Mass();
};

/** The faces of a shape that are in no shell, and its shells: the connected sheets it is made of. */
function sheetsOf(ctx: EvalContext, shape: Shape): Shape[] {
  const oc = ctx.oc as Any, k = ctx.k, E = oc.TopAbs_ShapeEnum;
  if (shape.ShapeType() === E.TopAbs_FACE || shape.ShapeType() === E.TopAbs_SHELL) return [shape];
  const out: Shape[] = [];
  for (const s of k.sub(shape, "shell")) out.push(k.sub(s, "face").length === 1 ? k.sub(s, "face")[0] : s);
  const ex = ctx.tmp(new oc.TopExp_Explorer(shape, E.TopAbs_FACE, E.TopAbs_SHELL));
  for (; ex.More(); ex.Next()) out.push(ctx.own(oc.TopoDS.Face(ctx.tmp(ex.Current()))));
  return out;
}

/**
 * Sew faces along the edges they share into sheets: one result per connected sheet (faces that touch nothing
 * stay faces of their own).  Each face of a result has the name its source face had.
 */
export function sewNamed(ctx: EvalContext, faces: readonly NamedShape[], tol = SEW_TOL): NamedResult[] {
  const oc = ctx.oc as Any, k = ctx.k;
  if (!faces.length) return [];
  if (faces.length === 1) { const only = faces[0]; return [{ shape: only.shape, names: () => only.name }]; }
  const sew = ctx.own(new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false));
  for (const f of faces) sew.Add(f.shape);
  sew.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  const sewn: Shape = ctx.own(sew.SewedShape());
  if (sewn.IsNull()) throw ctx.fail("The faces could not be joined into a surface.");
  const index = new ShapeIndex<string>(k);
  const centres: { name: string; at: Vec3 }[] = [];
  for (const f of faces) {
    const image: Shape = sew.IsModified(f.shape) ? ctx.own(sew.Modified(f.shape)) : f.shape;
    if (!index.has(image)) index.add(image, f.name);
    centres.push({ name: f.name, at: k.centre(f.shape, "face") });
  }
  // a face the sewing rebuilt without saying so is named after the source face it lies on
  const names: FaceNamer = (face) => {
    const hit = index.get(face);
    if (hit !== undefined) return hit;
    const c = k.centre(face, "face");
    let best: string | null = null, d = 1e-3;
    for (const s of centres) { const x = length(sub(s.at, c)); if (x < d) { d = x; best = s.name; } }
    return best;
  };
  return sheetsOf(ctx, sewn).map((shape) => ({ shape, names }));
}

/** Add the sheets a feature made as surface bodies: one body each, told apart by a number when there are several. */
export function addSheets(ctx: EvalContext, sheets: readonly NamedResult[], suffix?: string): Body[] {
  return sheets.map((s, i) => ctx.addBody(s.shape, s.names, { suffix: sheets.length > 1 ? `${suffix ? suffix + "." : ""}s${i + 1}` : suffix }));
}

/** The faces of a named result with their names settled. */
export const namedFacesOf = (ctx: EvalContext, r: NamedResult): NamedShape[] => ctx.k.namedFaces(r.shape, r.names, ctx.feature.id);

/** The surface bodies among the ids given (a FeatureError names what is wrong with the others). */
export function sheetBody(ctx: EvalContext, id: string, what = "surface"): Body {
  const b = ctx.body(id);
  if (!b) throw ctx.fail(`A ${what} this feature uses is gone. Edit the feature and pick it again.`);
  if (!b.sheet) throw ctx.fail(`“${b.name}” is a solid part. Pick a ${what}.`);
  return b;
}

// ------------------------------------------------------------------------------------------ curves

export interface PickedEdge {
  edge: Shape;
  /** a name that is stable across rebuilds: the edge's own, or `<sketch>.<entity>` */
  name: string;
  /** the body the edge is on, with the faces it lies on (none for a sketch curve or a reference curve) */
  body?: Body; faces: NamedShape[];
  /** a sketch curve's plane normal: what stands in for a surface normal */
  normal?: Vec3;
}

/**
 * The edges a `refs` field of edges, sketch curves and reference curves holds.  With `chain`, picking one curve
 * of a sketch picks the curves joined to it (as a Sweep path does).
 */
export function pickedEdges(ctx: EvalContext, targets: readonly RefTarget[], chain = false): PickedEdge[] {
  const k = ctx.k, oc = ctx.oc as Any;
  const out: PickedEdge[] = [], seen = new Set<string>();
  const push = (e: PickedEdge) => { if (!seen.has(e.name)) { seen.add(e.name); out.push(e); } };
  for (const t of targets || []) {
    if (!t || typeof t !== "object") continue;
    if (t.kind === "sketch") {
      const s = ctx.sketch(t.feature);
      for (const id of chain ? chainOf(s.data, [t.entity]) : [t.entity]) {
        const e = sketchEdge(ctx, t.feature, id);
        const parts = e.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE ? k.sub(e, "edge") : [e];
        parts.forEach((p, i) => push({ edge: p, name: `${t.feature}.${id}${parts.length > 1 ? "." + (i + 1) : ""}`, faces: [], normal: s.frame.normal }));
      }
    } else if (t.kind === "datum") {
      const d = ctx.datum(t.feature);
      if (d.kind !== "curve" || !d.shape) throw ctx.fail("Pick edges, sketch curves or curves.");
      k.sub(d.shape, "edge").forEach((p, i) => push({ edge: p, name: `${t.feature}.curve.${i + 1}`, faces: [] }));
    } else if (isGeomRef(t) && t.kind === "edge") {
      const r = ctx.resolve(t);
      push({ edge: r.shape, name: r.name, body: r.body, faces: r.body.topo.faces.filter((f) => k.sub(f.shape, "edge").some((e) => e.IsSame(r.shape))) });
    } else throw ctx.fail("Pick edges, sketch curves or curves.");
  }
  return out;
}

/** The two ends of an edge. */
export function edgeEnds(ctx: EvalContext, edge: Shape): [Vec3, Vec3] {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
  const out: [Vec3, Vec3] = [k.xyz(a), k.xyz(b)]; a.delete(); b.delete();
  return out;
}

const NEAR = 1e-4;
const near = (p: Vec3, q: Vec3) => length(sub(p, q)) < NEAR;

/**
 * Group edges into chains that run end to end, each in order.  `closed` says whether a chain comes back to its
 * start.  An edge that is closed by itself (a circle) is a chain of its own.
 */
export function chains(ctx: EvalContext, edges: readonly Shape[]): { edges: Shape[]; closed: boolean; start: Vec3; end: Vec3 }[] {
  const ends = edges.map((e) => edgeEnds(ctx, e));
  const used = new Set<number>();
  const ring = (i: number) => near(ends[i][0], ends[i][1]);
  const nextAt = (p: Vec3) => ends.findIndex((e, j) => !used.has(j) && !ring(j) && (near(e[0], p) || near(e[1], p)));
  const far = (j: number, p: Vec3) => (near(ends[j][0], p) ? ends[j][1] : ends[j][0]);
  const out: { edges: Shape[]; closed: boolean; start: Vec3; end: Vec3 }[] = [];
  for (let seed = 0; seed < edges.length; seed++) {
    if (used.has(seed)) continue;
    used.add(seed);
    if (ring(seed)) { out.push({ edges: [edges[seed]], closed: true, start: ends[seed][0], end: ends[seed][1] }); continue; }
    const order = [seed];
    let head = ends[seed][0], tail = ends[seed][1];
    for (let j = nextAt(tail); j >= 0; j = nextAt(tail)) { used.add(j); order.push(j); tail = far(j, tail); }
    if (!near(head, tail)) for (let j = nextAt(head); j >= 0; j = nextAt(head)) { used.add(j); order.unshift(j); head = far(j, head); }
    out.push({ edges: order.map((i) => edges[i]), closed: order.length > 1 && near(head, tail), start: head, end: tail });
  }
  return out;
}

/** Edges that run end to end, as one wire. */
export function wireOf(ctx: EvalContext, edges: readonly Shape[]): Shape {
  const oc = ctx.oc as Any;
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  for (const e of edges) {
    mw.Add(oc.TopoDS.Edge(e));
    if (!mw.IsDone()) throw ctx.fail("The curves do not join end to end.");
  }
  return ctx.own(mw.Wire());
}

/** A wire's two ends, the way the wire runs. */
export function wireEnds(ctx: EvalContext, wire: Shape): [Vec3, Vec3] {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_CompCurve(oc.TopoDS.Wire(wire), false));
  const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
  const out: [Vec3, Vec3] = [k.xyz(a), k.xyz(b)]; a.delete(); b.delete();
  return out;
}

/** A smooth curve through points, as an edge (a straight edge through two). */
export function curveThrough(ctx: EvalContext, pts: readonly Vec3[]): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  if (pts.length < 2) throw ctx.fail("A curve needs two points.");
  if (pts.length === 2) return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(pts[0])), ctx.tmp(k.pnt(pts[1])))).Edge());
  const arr = ctx.tmp(new oc.NCollection_Array1_gp_Pnt(1, pts.length));
  pts.forEach((p, i) => arr.SetValue(i + 1, ctx.tmp(k.pnt(p))));
  const fit = ctx.tmp(new oc.GeomAPI_PointsToBSpline(arr, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, 1e-6));
  if (!fit.IsDone()) throw ctx.fail("A curve could not be put through the points.");
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(fit.Curve())));
  if (!mk.IsDone()) throw ctx.fail("A curve could not be put through the points.");
  return ctx.own(mk.Edge());
}

/** The straight-ruled face (or faces) between two wires. */
export function ruledBetween(ctx: EvalContext, a: Shape, b: Shape): Shape {
  const oc = ctx.oc as Any;
  const asWire = (s: Shape) => (s.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_WIRE ? oc.TopoDS.Wire(s) : ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(s))).Wire()));
  const ts = ctx.tmp(new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6));
  ts.AddWire(asWire(a)); ts.AddWire(asWire(b));
  ts.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!ts.IsDone()) throw ctx.fail("The surface between the curves could not be built.");
  return ctx.own(ts.Shape());
}

// ------------------------------------------------------------------------------------------ along an edge

export interface EdgeSample { at: Vec3; tangent: Vec3; normal: Vec3 }

/** A face's normal (the way the face faces) at the point of it nearest `p`. */
export function normalNear(ctx: EvalContext, face: Shape, p: Vec3): Vec3 {
  const oc = ctx.oc as Any, k = ctx.k;
  const f = oc.TopoDS.Face(face);
  const surf = ctx.tmp(oc.BRep_Tool.Surface(f));
  const pr = ctx.tmp(new oc.GeomAPI_ProjectPointOnSurf(ctx.tmp(k.pnt(p)), surf, oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad));
  if (!pr.IsDone() || !pr.NbPoints()) throw ctx.fail("A surface's direction could not be found at an edge.");
  const uv = pr.LowerDistanceParameters(0, 0);
  const gf = ctx.tmp(new oc.BRepGProp_Face(f, false));
  const at = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), n = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  gf.Normal(uv.U, uv.V, at, n);
  const v = k.xyz(n);
  if (length(v) < 1e-12) throw ctx.fail("A surface has no direction at an edge (it comes to a point there).");
  return normalize(v);
}

/**
 * Points along an edge with the edge's direction and the normal of the surface it lies on.  `face` is that
 * surface; without one, `normal` is used everywhere (a sketch curve's plane).
 */
export function sampleEdge(ctx: EvalContext, edge: Shape, face: Shape | null, normal: Vec3 | undefined, n: number): EdgeSample[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
  const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), v = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  const out: EdgeSample[] = [];
  for (let i = 0; i <= n; i++) {
    ad.D1(u0 + ((u1 - u0) * i) / n, p, v);
    const at = k.xyz(p), tangent = normalize(k.xyz(v));
    const nn = face ? normalNear(ctx, face, at) : normal;
    if (!nn) throw ctx.fail("A curve that is on no surface needs a direction: use “Aligned with vector”.");
    out.push({ at, tangent, normal: nn });
  }
  return out;
}

/** Whether an edge is straight (two samples describe it) or curved. */
export function isStraight(ctx: EvalContext, edge: Shape): boolean {
  const oc = ctx.oc as Any;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  return ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line;
}

/** The shortest distance from a point to a shape. */
export function distanceTo(ctx: EvalContext, p: Vec3, shape: Shape): number {
  const oc = ctx.oc as Any, k = ctx.k;
  const v = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(p)))).Vertex());
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(v); d.LoadS2(shape);
  d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  return d.IsDone() ? d.Value() : Infinity;
}

/**
 * The direction that leaves a face across one of its boundary edges, at each sample: square to the edge, in the
 * surface's tangent plane, pointing away from the face.
 */
export function outward(ctx: EvalContext, face: Shape, samples: readonly EdgeSample[]): Vec3[] {
  const dirs = samples.map((s) => normalize(cross(s.tangent, s.normal)));
  // at the middle of the edge (between its two ends when they are all there is)
  const half = Math.floor(samples.length / 2), d = dirs[half];
  const mid = samples.length > 2 ? samples[half] : { ...samples[0], at: scale(add(samples[0].at, samples[samples.length - 1].at), 0.5) };
  // step a little way off the edge: the side that lands on the face is the inside
  const eps = Math.max(1e-3, Math.sqrt(surfaceArea(ctx, face)) * 1e-3);
  const out = distanceTo(ctx, add(mid.at, scale(d, eps)), face), back = distanceTo(ctx, add(mid.at, scale(d, -eps)), face);
  return out >= back ? dirs : dirs.map((x) => scale(x, -1));
}

/**
 * A ribbon that starts on an edge and runs `distance` along a direction given at each sample: a swept face when
 * the direction is the same all along, a ruled face to the curve through the far points otherwise.
 */
export function ribbon(ctx: EvalContext, edge: Shape, samples: readonly EdgeSample[], dirs: readonly Vec3[], distance: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const same = dirs.every((d) => length(sub(d, dirs[0])) < 1e-9);
  if (same) {
    const mk = ctx.tmp(new oc.BRepPrimAPI_MakePrism(edge, ctx.tmp(k.vec(scale(dirs[0], distance))), false, true));
    mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!mk.IsDone()) throw ctx.fail("The surface along the edge could not be built.");
    return ctx.own(mk.Shape());
  }
  const far = curveThrough(ctx, samples.map((s, i) => add(s.at, scale(dirs[i], distance))));
  return ruledBetween(ctx, edge, far);
}

/** How many samples an edge needs: its ends when it is straight and the surface flat beside it, more when curved. */
export const samplesFor = (ctx: EvalContext, edge: Shape, flat: boolean): number => (isStraight(ctx, edge) && flat ? 1 : 32);

/** A sketch point or the end of a sketch curve in model space (null when the entity is neither). */
export function sketchEntityPoints(ctx: EvalContext, sketchId: string, entity: string): Vec3[] {
  const s = ctx.sketch(sketchId), e = s.data.entities[entity] as Any;
  if (!e) return [];
  const P = (id: string): Vec3[] => { const p = sketchPoint(s.data, id); return p ? [toWorld(s.frame, p)] : []; };
  if (e.type === "point") return P(entity);
  if (e.type === "line") return [...P(e.a), ...P(e.b)];
  if (e.type === "arc") return [...P(e.start), ...P(e.end)];
  if (e.type === "circle") return P(e.center);
  return [];
}
