// cf-fab.ts — what the fabrication custom features (features/cf-fab-*.ts: laser and CNC joints, 3D printing
// details) share: solids drawn from a 2D outline or a half profile in a frame, with every face named; finger
// spacing; facts about plates and their edge faces; one boolean for many tools.  Worker side.
//
// Names: a tool's faces are `<prefix>:<role>`; the features pass a prefix that starts with their feature id and
// says which tab, slot or hole it is, so a face keeps its name while the count before it does not change.
import { add, cross, dot, length, normalize, scale, sub, type Frame, type Vec3 } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { Body, EvalContext, FaceNamer, NamedShape, Shape } from "../types";
import { bbox } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export type P2 = [number, number];
/** One step of an outline: a straight line to `to`, or an arc to it through `via`.  `name` is the role of the face it sweeps. */
export interface Seg { to: P2; via?: P2; name?: string }

/** A point of a frame: origin + u·x + v·y + w·normal. */
export const at = (f: Frame, u: number, v: number, w = 0): Vec3 => [
  f.origin[0] + u * f.x[0] + v * f.y[0] + w * f.normal[0],
  f.origin[1] + u * f.x[1] + v * f.y[1] + w * f.normal[1],
  f.origin[2] + u * f.x[2] + v * f.y[2] + w * f.normal[2],
];
/** The coordinates of a world point in a frame. */
export const local = (f: Frame, p: Vec3): Vec3 => { const d = sub(p, f.origin); return [dot(d, f.x), dot(d, f.y), dot(d, f.normal)]; };
/** A frame at `origin` with the given x and normal (y follows). */
export const frameAt = (origin: Vec3, x: Vec3, normal: Vec3): Frame => { const n = normalize(normal); const xx = normalize(sub(x, scale(n, dot(x, n)))); return { origin, x: xx, y: cross(n, xx), normal: n }; };
/** The same frame moved in its own coordinates and turned about its normal (degrees). */
export function moved(f: Frame, u: number, v: number, w = 0, angle = 0): Frame {
  const a = (angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { origin: at(f, u, v, w), x: add(scale(f.x, c), scale(f.y, s)), y: add(scale(f.x, -s), scale(f.y, c)), normal: f.normal };
}

const SAME = 1e-7;
const same = (a: P2, b: P2) => Math.abs(a[0] - b[0]) < SAME && Math.abs(a[1] - b[1]) < SAME;

/** A closed outline as a flat face at height `w` of a frame, and the edge each step made. */
export function outlineFace(ctx: EvalContext, f: Frame, start: P2, segs: readonly Seg[], w = 0): { face: Shape; edges: { name: string; edge: Shape }[] } {
  const oc = ctx.oc as Any, k = ctx.k;
  const P = (p: P2) => ctx.tmp(k.pnt(at(f, p[0], p[1], w)));
  const mw = ctx.own(new oc.BRepBuilderAPI_MakeWire());
  const edges: { name: string; edge: Shape }[] = [];
  let from = start;
  const all = same(segs[segs.length - 1].to, start) ? segs : [...segs, { to: start, name: "close" }];
  all.forEach((s, i) => {
    if (same(from, s.to)) return;
    let mk: Any;
    if (s.via) {
      const arc = ctx.tmp(new oc.GC_MakeArcOfCircle(P(from), P(s.via), P(s.to)));
      if (!arc.IsDone()) throw ctx.fail("An arc of the outline could not be drawn.");
      mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(arc.Value()));
    } else mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(P(from), P(s.to)));
    mw.Add(mk.Edge());
    if (!mw.IsDone()) throw ctx.fail("The outline could not be drawn.");
    edges.push({ name: s.name || `side${i + 1}`, edge: ctx.own(mw.Edge()) });
    from = s.to;
  });
  const mf = ctx.own(new oc.BRepBuilderAPI_MakeFace(ctx.own(mw.Wire()), true));
  if (!mf.IsDone()) throw ctx.fail("The outline does not close into a face.");
  return { face: ctx.own(mf.Face()), edges };
}

/** A circle of a frame as a face. */
export function circleFace(ctx: EvalContext, f: Frame, c: P2, r: number, w = 0): { face: Shape; edges: { name: string; edge: Shape }[] } {
  const oc = ctx.oc as Any, k = ctx.k;
  const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(at(f, c[0], c[1], w))), ctx.tmp(k.dir(f.normal)), ctx.tmp(k.dir(f.x))));
  const mw = ctx.own(new oc.BRepBuilderAPI_MakeWire());
  mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, r)))).Edge()));
  const edge = ctx.own(mw.Edge());
  const mf = ctx.own(new oc.BRepBuilderAPI_MakeFace(ctx.own(mw.Wire()), true));
  return { face: ctx.own(mf.Face()), edges: [{ name: "wall", edge }] };
}

/** Sweep a face along the frame's normal by `h` (either sign); caps are `:start` and `:end`, sides the steps' names. */
export function sweepFace(ctx: EvalContext, f: Frame, made: { face: Shape; edges: { name: string; edge: Shape }[] }, h: number, prefix: string): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(made.face, ctx.tmp(k.vec(scale(f.normal, h))), false, true));
  prism.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!prism.IsDone()) throw ctx.fail("A solid of the feature could not be built.");
  const shape: Shape = ctx.own(prism.Shape());
  const named = new ShapeIndex<string>(k);
  named.add(ctx.own(prism.FirstShape()), `${prefix}:start`);
  named.add(ctx.own(prism.LastShape()), `${prefix}:end`);
  for (const e of made.edges) for (const s of k.list(prism.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.name}`);
  return { shape, names: (face) => named.get(face) ?? null };
}

/** An outline swept along the frame's normal from height `w0` by `h`. */
export function prism(ctx: EvalContext, f: Frame, start: P2, segs: readonly Seg[], w0: number, h: number, prefix: string): NamedResult {
  return sweepFace(ctx, f, outlineFace(ctx, f, start, segs, w0), h, prefix);
}

/** A polygon swept along the frame's normal; `names[i]` is the role of the side from point i to point i + 1. */
export function polyPrism(ctx: EvalContext, f: Frame, pts: readonly P2[], w0: number, h: number, prefix: string, names?: readonly string[]): NamedResult {
  return prism(ctx, f, pts[0], pts.slice(1).map((to, i) => ({ to, name: names ? names[i] : undefined })).concat([{ to: pts[0], name: names ? names[pts.length - 1] : `side${pts.length}` }]), w0, h, prefix);
}

/** A box between two corners given in a frame's coordinates.  Sides: `:u0`, `:u1`, `:v0`, `:v1`; caps `:start` (w0), `:end`. */
export function box(ctx: EvalContext, f: Frame, a: Vec3, b: Vec3, prefix: string): NamedResult {
  const u0 = Math.min(a[0], b[0]), u1 = Math.max(a[0], b[0]), v0 = Math.min(a[1], b[1]), v1 = Math.max(a[1], b[1]), w0 = Math.min(a[2], b[2]), w1 = Math.max(a[2], b[2]);
  if (!(u1 - u0 > 1e-9 && v1 - v0 > 1e-9 && w1 - w0 > 1e-9)) throw ctx.fail("A part of the feature has no size. Check the dimensions.");
  return polyPrism(ctx, f, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]], w0, w1 - w0, prefix, ["v0", "u1", "v1", "u0"]);
}

/** A cylinder along the frame's normal: centre (u, v), from height w0 by h. */
export function cylinder(ctx: EvalContext, f: Frame, c: P2, r: number, w0: number, h: number, prefix: string): NamedResult {
  if (!(r > 0) || !h) throw ctx.fail("A round part of the feature has no size. Check the dimensions.");
  return sweepFace(ctx, f, circleFace(ctx, f, c, r, w0), h, prefix);
}

/**
 * A solid of revolution about the frame's normal through its origin, from a half profile of (radius, height)
 * points that starts and ends on the axis (or is closed off it: a ring).  `roles[i]` names the face the step from
 * point i to point i + 1 sweeps; the last entry is the closing step.
 */
export function revolve(ctx: EvalContext, f: Frame, pts: readonly P2[], roles: readonly (string | null)[], prefix: string): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const mw = ctx.own(new oc.BRepBuilderAPI_MakeWire());
  const edges: { role: string; edge: Shape }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (same(a, b)) continue;
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(at(f, a[0], 0, a[1]))), ctx.tmp(k.pnt(at(f, b[0], 0, b[1])))));
    mw.Add(mk.Edge());
    if (!mw.IsDone()) throw ctx.fail("A profile of the feature could not be drawn.");
    const role = roles[i];
    if (role && !(Math.abs(a[0]) < SAME && Math.abs(b[0]) < SAME)) edges.push({ role, edge: ctx.own(mw.Edge()) });
  }
  const face = ctx.own(new oc.BRepBuilderAPI_MakeFace(ctx.own(mw.Wire()), true));
  if (!face.IsDone()) throw ctx.fail("A profile of the feature could not be drawn.");
  const ax = ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(f.origin)), ctx.tmp(k.dir(f.normal))));
  const rev = ctx.own(new oc.BRepPrimAPI_MakeRevol(face.Face(), ax, true));
  rev.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!rev.IsDone()) throw ctx.fail("A round part of the feature could not be built.");
  const shape: Shape = ctx.own(rev.Shape());
  const named = new ShapeIndex<string>(k);
  for (const e of edges) for (const s of k.list(rev.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.role}`);
  return { shape, names: (face2) => named.get(face2) ?? null };
}

/** Several solids that do not overlap as one tool, each face named as its own solid names it. */
export function together(ctx: EvalContext, tools: readonly NamedResult[]): NamedResult {
  if (tools.length === 1) return tools[0];
  const oc = ctx.oc as Any;
  const c = ctx.own(new oc.TopoDS_Compound());
  const b = ctx.tmp(new oc.TopoDS_Builder());
  b.MakeCompound(c);
  for (const t of tools) b.Add(c, t.shape);
  return { shape: c, names: (face, i) => { for (const t of tools) { const n = t.names(face, i); if (n !== null) return n; } return null; } };
}

/** The faces of a tool with their names: what a boolean takes. */
export const facesOf = (ctx: EvalContext, t: NamedResult): NamedShape[] => ctx.k.namedFaces(t.shape, t.names, ctx.feature.id);
/** A namer from named faces. */
export function namer(ctx: EvalContext, faces: readonly NamedShape[]): FaceNamer {
  const index = new ShapeIndex<string>(ctx.k);
  for (const f of faces) index.add(f.shape, f.name);
  return (face) => index.get(face) ?? null;
}

/** A boolean of two named things, names carried. */
export function bool(ctx: EvalContext, op: "fuse" | "cut" | "common", a: NamedResult | Body, b: NamedResult | Body): NamedResult {
  const side = (s: NamedResult | Body) => ("topo" in s ? { shape: s.shape, faces: s.topo.faces } : { shape: s.shape, faces: facesOf(ctx, s) });
  return ctx.k.boolean(op, side(a), side(b), ctx.feature.id, ctx.own);
}

/** Put a boolean's result in place of a body: the largest solid keeps the body, the others become bodies; false when nothing is left. */
export function settle(ctx: EvalContext, body: Body, r: NamedResult): Body | null {
  const k = ctx.k;
  const solids = k.solids(r.shape).map((s) => ({ s, v: k.volume(s) })).sort((a, b) => b.v - a.v);
  if (!solids.length) { ctx.removeBody(body); return null; }
  const next = ctx.replaceBody(body, solids[0].s, r.names);
  solids.slice(1).forEach((p, n) => ctx.addBody(p.s, r.names, { suffix: `${body.id}.piece${n + 2}`, name: `${body.name} (${n + 2})` }));
  return next;
}

/** Cut a tool from a body, or join it; returns the body as it is afterwards (itself when the tool misses it). */
export function change(ctx: EvalContext, body: Body, op: "cut" | "fuse", tool: NamedResult): Body {
  const r = bool(ctx, op, body, tool);
  const was = ctx.k.volume(body.shape), now = ctx.k.volume(r.shape);
  if (Math.abs(was - now) <= 1e-9 * Math.max(1, was)) return body;
  return settle(ctx, body, r) || body;
}

/** The current body with this id (a body is a new object after every change). */
export const fresh = (ctx: EvalContext, body: Body): Body => ctx.body(body.id) || body;

/** True when a point is in the material of a solid (or on its skin). */
export function inside(ctx: EvalContext, solid: Shape, p: Vec3, tol = 1e-6): boolean {
  const oc = ctx.oc as Any;
  const v = ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(ctx.k.pnt(p))));
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(v.Vertex()); d.LoadS2(solid);
  d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  return d.IsDone() && d.Value() <= tol;
}

/** The distance from a point to a shape. */
export function distanceTo(ctx: EvalContext, shape: Shape, p: Vec3): number {
  const oc = ctx.oc as Any;
  const v = ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(ctx.k.pnt(p))));
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(v.Vertex()); d.LoadS2(shape);
  d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  return d.IsDone() ? d.Value() : Infinity;
}

/** How far a shape reaches along each axis of a frame: [[u0, u1], [v0, v1], [w0, w1]] (from its vertices, so exact for flat-sided shapes). */
export function extentIn(ctx: EvalContext, shape: Shape, f: Frame): [[number, number], [number, number], [number, number]] {
  const k = ctx.k;
  const out: [[number, number], [number, number], [number, number]] = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  const take = (p: Vec3) => { const l = local(f, p); for (let i = 0; i < 3; i++) { if (l[i] < out[i][0]) out[i][0] = l[i]; if (l[i] > out[i][1]) out[i][1] = l[i]; } };
  const vs = k.sub(shape, "vertex");
  for (const v of vs) take(k.vertexPoint(v));
  // round edges reach past their ends: sample them
  const oc = ctx.oc as Any;
  for (const e of k.sub(shape, "edge")) {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) continue;
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    for (let i = 1; i < 16; i++) { const p = ad.Value(u0 + ((u1 - u0) * i) / 16); take(k.xyz(p)); p.delete(); }
  }
  if (!vs.length) { const b = bbox(k, [shape]); if (b) { take([b[0], b[1], b[2]]); take([b[3], b[4], b[5]]); } }
  return out;
}

/** The area of a face. */
export function area(ctx: EvalContext, face: Shape): number {
  const oc = ctx.oc as Any;
  const g = ctx.tmp(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(face, g, false, false);
  return g.Mass();
}

export interface Plate {
  /** x along the plate's longest straight edge, normal out of its larger flat side; origin at the middle of the plate */
  frame: Frame;
  thickness: number;
  /** the larger flat face and the one opposite */
  top: NamedShape; bottom: NamedShape | null;
  /** how far the plate reaches in its frame */
  size: [number, number];
}

/** A body as a flat plate: its two largest parallel flat faces and the distance between them.  `face` forces which face is the top. */
export function plateOf(ctx: EvalContext, body: Body, face?: Shape): Plate {
  const k = ctx.k, oc = ctx.oc as Any;
  const flat = body.topo.faces.map((f) => ({ f, frame: k.faceFrame(oc.TopoDS.Face(f.shape)) })).filter((x) => x.frame).map((x) => ({ ...x, area: area(ctx, x.f.shape) }));
  if (!flat.length) throw ctx.fail(`${body.name} has no flat face: this works on flat plates.`);
  const top = face ? flat.find((x) => x.f.shape.IsSame(face)) : flat.slice().sort((a, b) => b.area - a.area)[0];
  if (!top) throw ctx.fail("Pick a flat face of the plate.");
  const n = top.frame!.normal;
  const opposite = flat.filter((x) => x !== top && dot(x.frame!.normal, n) < -1 + 1e-6).sort((a, b) => b.area - a.area)[0];
  // x along the longest straight edge of the top face
  let x: Vec3 = top.frame!.x, best = 0;
  for (const e of k.sub(top.f.shape, "edge")) {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
    const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
    const d = sub(k.xyz(b), k.xyz(a)); a.delete(); b.delete();
    if (length(d) > best + 1e-9) { best = length(d); x = normalize(d); }
  }
  // the same direction whichever way the kernel runs the edge
  let lead = 0; for (let i = 1; i < 3; i++) if (Math.abs(x[i]) > Math.abs(x[lead]) + 1e-9) lead = i;
  if (x[lead] < 0) x = scale(x, -1);
  const f0 = frameAt(top.frame!.origin, x, n);
  const ext = extentIn(ctx, body.shape, f0);
  const frame = { ...f0, origin: at(f0, (ext[0][0] + ext[0][1]) / 2, (ext[1][0] + ext[1][1]) / 2, ext[2][1]) };
  return { frame, thickness: ext[2][1] - ext[2][0], top: top.f, bottom: opposite ? opposite.f : null, size: [ext[0][1] - ext[0][0], ext[1][1] - ext[1][0]] };
}

export interface EdgeFace {
  /** origin at the middle of the face, x along its long side, y across it, normal out of the body */
  frame: Frame;
  /** the face's size along x and y */
  long: number; short: number;
}

/** A flat face as the rectangle around it: the narrow end or edge face of a board, where a joint goes. */
export function edgeFace(ctx: EvalContext, face: Shape): EdgeFace {
  const k = ctx.k, oc = ctx.oc as Any;
  const ff = k.faceFrame(oc.TopoDS.Face(face));
  if (!ff) throw ctx.fail("Pick a flat face.");
  let x: Vec3 = ff.x, best = 0;
  for (const e of k.sub(face, "edge")) {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
    const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
    const d = sub(k.xyz(b), k.xyz(a)); a.delete(); b.delete();
    if (length(d) > best + 1e-9) { best = length(d); x = normalize(d); }
  }
  let lead = 0; for (let i = 1; i < 3; i++) if (Math.abs(x[i]) > Math.abs(x[lead]) + 1e-9) lead = i;
  if (x[lead] < 0) x = scale(x, -1);
  const f0 = frameAt(ff.origin, x, ff.normal);
  const ext = extentIn(ctx, face, f0);
  return { frame: { ...f0, origin: at(f0, (ext[0][0] + ext[0][1]) / 2, (ext[1][0] + ext[1][1]) / 2, ext[2][0]) }, long: ext[0][1] - ext[0][0], short: ext[1][1] - ext[1][0] };
}

/**
 * Where the fingers of a joint of this length change hands: n + 1 positions from 0 to `length` for an odd
 * number n of equal fingers, as near `width` wide as an odd count allows (or exactly `count` when given).
 */
export function fingers(len: number, width: number, count?: number): number[] {
  let n = count && count > 0 ? Math.round(count) : Math.max(3, Math.round(len / Math.max(width, 1e-6)));
  if (!(count && count > 0) && n % 2 === 0) n += len / n > width ? 1 : -1;
  if (n < 1) n = 1;
  return Array.from({ length: n + 1 }, (_, i) => (len * i) / n);
}

/** `count` positions spread evenly along a length centred on zero, `inset` from each end. */
export function spread(len: number, count: number, inset: number): number[] {
  if (count <= 1) return [0];
  const span = len - 2 * inset;
  return Array.from({ length: count }, (_, i) => -span / 2 + (span * i) / (count - 1));
}

/** A whole number from a parameter, with a sentence when it is not one. */
export function whole(ctx: EvalContext, v: unknown, what: string, min = 1, max = 500): number {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min) throw ctx.fail(`The ${what} must be a whole number, ${min} or more.`);
  if (n > max) throw ctx.fail(`The ${what} is too large (at most ${max}).`);
  return n;
}

/** A length that must be more than zero. */
export function positive(ctx: EvalContext, v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !(n > 0)) throw ctx.fail(`The ${what} must be more than zero.`);
  return n;
}

/** The loose points and circle centres of a sketch, as the Hole feature reads them: where a detail goes. */
export function sketchPoints(ctx: EvalContext, value: unknown, what: string): { frame: Frame; points: { id: string; at: P2 }[] } {
  const v = value as { sketch?: string } | null;
  if (!v || !v.sketch) throw ctx.fail(`Pick a sketch whose points place the ${what}.`);
  const sketch = ctx.sketch(v.sketch), data = sketch.data;
  const used = new Set<string>();
  for (const e of Object.values(data.entities) as Any[]) {
    if (e.type === "line") { used.add(e.a); used.add(e.b); } else if (e.type === "arc") { used.add(e.center); used.add(e.start); used.add(e.end); }
  }
  const points: { id: string; at: P2 }[] = [];
  for (const [id, e] of Object.entries(data.entities).sort(([a], [b]) => (a < b ? -1 : 1)) as [string, Any][]) {
    if (e.type !== "point" || used.has(id)) continue;
    if (Object.values(data.entities).some((c: Any) => c.type === "circle" && c.center === id && c.construction)) continue;
    points.push({ id, at: [e.x, e.y] });
  }
  if (!points.length) throw ctx.fail(`The sketch has no point to put a ${what.replace(/s$/, "")} at. Draw a point (or a circle) where each one goes.`);
  return { frame: sketch.frame, points };
}

/** Copy a shape to another place: the frame `from` lands on the frame `to`.  Faces keep their names. */
export function place(ctx: EvalContext, shape: Shape, names: FaceNamer, from: Frame, to: Frame): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const ax = (f: Frame) => ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(f.origin)), ctx.tmp(k.dir(f.normal)), ctx.tmp(k.dir(f.x))));
  const t = ctx.tmp(new oc.gp_Trsf());
  t.SetDisplacement(ax(from), ax(to));
  const mk = ctx.own(new oc.BRepBuilderAPI_Transform(shape, t, true, false));
  const out: Shape = ctx.own(mk.Shape());
  const index = new ShapeIndex<string>(k);
  k.sub(shape, "face").forEach((f, i) => { const n = names(f as Any, i); if (n !== null) index.add(ctx.own(mk.ModifiedShape(f)), n); });
  return { shape: out, names: (f) => index.get(f) ?? null };
}

/** Cut several tools (they may overlap one another) from a body in one boolean, or join them to it. */
export function changeAll(ctx: EvalContext, body: Body, op: "cut" | "fuse", tools: readonly NamedResult[]): Body {
  if (!tools.length) return body;
  const r = boolMany(ctx, op, { shape: body.shape, faces: body.topo.faces }, tools);
  const was = ctx.k.volume(body.shape), now = ctx.k.volume(r.shape);
  if (Math.abs(was - now) <= 1e-9 * Math.max(1, was)) return body;
  return settle(ctx, body, r) || body;
}

/** One tool with others joined to it or cut from it (they may overlap), names carried. */
export function shape(ctx: EvalContext, op: "cut" | "fuse", base: NamedResult, tools: readonly NamedResult[]): NamedResult {
  if (!tools.length) return base;
  return boolMany(ctx, op, { shape: base.shape, faces: facesOf(ctx, base) }, tools);
}

/** A slot with round ends (or a rectangle) around (cx, cy), `len` along u and `wid` across: the outline for `prism`. */
export function slotOutline(cx: number, cy: number, len: number, wid: number, round: boolean): { start: P2; segs: Seg[] } {
  const hl = len / 2, hw = wid / 2;
  if (!round || len <= wid + 1e-9) {
    return { start: [cx - hl, cy - hw], segs: [{ to: [cx + hl, cy - hw], name: "v0" }, { to: [cx + hl, cy + hw], name: "u1" }, { to: [cx - hl, cy + hw], name: "v1" }, { to: [cx - hl, cy - hw], name: "u0" }] };
  }
  const a = hl - hw;
  return { start: [cx - a, cy - hw], segs: [
    { to: [cx + a, cy - hw], name: "v0" }, { to: [cx + a, cy + hw], via: [cx + hl, cy], name: "u1" },
    { to: [cx - a, cy + hw], name: "v1" }, { to: [cx - a, cy - hw], via: [cx - hl, cy], name: "u0" },
  ] };
}

/** One boolean of a base with several tools that may overlap one another.  Names carried, the base first. */
export function boolMany(ctx: EvalContext, op: "cut" | "fuse", base: { shape: Shape; faces: readonly NamedShape[] }, tools: readonly NamedResult[]): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const algo = ctx.own(op === "cut" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse());
  const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()), list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
  args.Append(base.shape);
  const inputs: NamedShape[] = [...base.faces];
  for (const t of tools) { list.Append(t.shape); inputs.push(...facesOf(ctx, t)); }
  algo.SetArguments(args);
  algo.SetTools(list);
  algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail("The shapes of the feature could not be combined with the body.");
  algo.SimplifyResult(true, true, 1e-4);
  const out: Shape = ctx.own(algo.Shape());
  return { shape: out, names: k.carryNames(out, algo, inputs, ctx.feature.id) };
}

export interface OffsetLoop { isOuter: boolean; wire: Shape; face: Shape; from: Shape; history: Any }

/**
 * The outline of a flat face moved by `d`: positive grows the material (the outside moves out, holes shrink),
 * negative shrinks it.  Corners stay sharp.  Each loop comes back as a wire and the face inside it, the outside
 * first; `history.Generated(edge)` gives the edges an edge of `from` became.  `what` names the face in messages.
 */
export function offsetLoops(ctx: EvalContext, face: Shape, d: number, what: string): OffsetLoop[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const top = oc.TopoDS.Face(face);
  const faceOf = (w: Shape) => { const mf = ctx.own(new oc.BRepBuilderAPI_MakeFace(oc.TopoDS.Wire(w), true)); if (!mf.IsDone()) throw ctx.fail(`The outline of ${what} could not be offset.`); return ctx.own(mf.Face()); };
  const outer = ctx.own(oc.BRepTools.OuterWire(top));
  return k.sub(top, "wire").map((w0) => {
    const isOuter = w0.IsSame(outer), was = area(ctx, faceOf(w0));
    const lost = () => ctx.fail(isOuter ? `The outline of ${what} could not be offset by that much.` : `A hole of ${what} closes up at that offset.`);
    const offset = (v: number) => {
      const mk = ctx.own(new oc.BRepOffsetAPI_MakeOffset(oc.TopoDS.Wire(w0), oc.GeomAbs_JoinType.GeomAbs_Intersection, false));
      try { mk.Perform(v, 0); } catch (x) { throw lost(); }
      const ws = mk.IsDone() ? k.sub(ctx.own(mk.Shape()), "wire") : [];
      if (ws.length !== 1) throw lost();
      const f = faceOf(ws[0]);
      return { mk, w: ws[0], f, a: area(ctx, f) };
    };
    // which way is out depends on how the loop runs: try, and turn round when the area went the wrong way
    let made = offset(d);
    if ((made.a > was) !== (isOuter === d > 0)) made = offset(-d);
    if ((made.a > was) !== (isOuter === d > 0)) throw lost();
    return { isOuter, wire: made.w, face: made.f, from: w0, history: made.mk };
  }).sort((a, b) => Number(b.isOuter) - Number(a.isOuter));
}

/** The edges of a flat face as straight pieces in a frame's (u, v): lines as they are, curves in short chords. */
export function boundary2d(ctx: EvalContext, face: Shape, f: Frame, chords = 32): [P2, P2][] {
  const oc = ctx.oc as Any, k = ctx.k;
  const out: [P2, P2][] = [];
  for (const e of k.sub(face, "edge")) {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
    const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
    const n = ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : chords;
    let last: P2 | null = null;
    for (let i = 0; i <= n; i++) {
      const q = ad.Value(u0 + ((u1 - u0) * i) / n), l = local(f, k.xyz(q)); q.delete();
      const here: P2 = [l[0], l[1]];
      if (last) out.push([last, here]);
      last = here;
    }
  }
  return out;
}

/** True when a point is inside the outline the pieces make (holes count as outside). */
export function inside2d(segs: readonly [P2, P2][], q: P2): boolean {
  let n = 0;
  for (const [a, b] of segs) if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) n++;
  return n % 2 === 1;
}

/** The distance between two straight pieces. */
export function segDistance(a: P2, b: P2, c: P2, d: P2): number {
  const pt = (p: P2, s: P2, e: P2) => { const vx = e[0] - s[0], vy = e[1] - s[1], l = vx * vx + vy * vy; const t = l ? Math.max(0, Math.min(1, ((p[0] - s[0]) * vx + (p[1] - s[1]) * vy) / l)) : 0; return Math.hypot(p[0] - s[0] - t * vx, p[1] - s[1] - t * vy); };
  const o = (p: P2, q: P2, r: P2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(pt(a, c, d), pt(b, c, d), pt(c, a, b), pt(d, a, b));
}
