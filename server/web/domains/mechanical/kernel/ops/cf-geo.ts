// cf-geo.ts — kernel helpers of the "Patterns & texture" and "Geometry & utilities" custom features
// (features/cf-geo-*.ts): a flat face as a plane region, where a pattern's seed is, copies placed with a turn and
// a size, flat shapes from polygons, text outlines as faces, pipes along a path, and putting many tools into a
// body with one boolean.
//
// Names.  A tool these features make is named by `tagged`: its faces are `<feature>:<tag>:<n>`, n counting the
// tool's own faces in the kernel's order, and `tag` naming the tool by its place (a lattice key, a letter's
// index), so a reference to "the third hole's wall" stays there when a count changes.
import { add, cross, dot, length, normalize, scale, sub, toPlane, toWorld, type Frame, type Vec2, type Vec3 } from "../../core/geometry";
import { knotsAndMults, piecesOf, samplePiece, textWidth, type Piece } from "../../sketch/curves";
import type { SketchData, SketchEntity } from "../../sketch/format";
import { isGeomRef, type GeomRef } from "../../core/geometry";
import type { RefTarget } from "../../features/_refs";
import { copyInstances, type CopyParams } from "../../features/_pattern";
import { boundsOf, inLoop, loopArea, type Loop2, type Region2 } from "../../features/_cf-geo";
import type { NamedResult } from "../occ";
import type { Body, EvalContext, NamedShape, Shape } from "../types";
import { curveEnd } from "./curves";
import { booleanMany, copyBody, namerOf, placeTool, seedEffects, type Instance, type Tool } from "./pattern-core";
import { frameFromNormal, planeOf } from "./ref-geom";
import { bbox, compound } from "./shapes";
import { nurbsCurve } from "./sketch-curves";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

// ---------------------------------------------------------------- a flat face as a region of its plane

export interface FlatFace { frame: Frame; region: Region2; box: [number, number, number, number]; body: Body; face: Shape; name: string }

/** The points of an edge in order, a straight one as its two ends. */
export function edgePoints(ctx: EvalContext, edge: Shape, n = 24): Vec3[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
  const steps = ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line ? 1 : n;
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) { const p = ad.Value(u0 + ((u1 - u0) * i) / steps); out.push(k.xyz(p)); p.delete(); }
  return out;
}

/** A wire as a closed polygon in a frame's plane: its edges joined end to end. */
export function wireLoop(ctx: EvalContext, wire: Shape, frame: Frame, perCurve = 24): Loop2 {
  const runs = ctx.k.sub(wire, "edge").filter((e) => !(ctx.oc as Any).BRep_Tool.Degenerated((ctx.oc as Any).TopoDS.Edge(e))).map((e) => edgePoints(ctx, e, perCurve));
  if (!runs.length) return [];
  const near = (a: Vec3, b: Vec3) => length(sub(a, b)) < 1e-6;
  const chain = runs.shift()!.slice();
  while (runs.length) {
    const tip = chain[chain.length - 1];
    let i = runs.findIndex((r) => near(r[0], tip)), rev = false;
    if (i < 0) { i = runs.findIndex((r) => near(r[r.length - 1], tip)); rev = true; }
    if (i < 0) break;
    const r = runs.splice(i, 1)[0];
    chain.push(...(rev ? r.slice().reverse() : r).slice(1));
  }
  if (chain.length > 1 && near(chain[0], chain[chain.length - 1])) chain.pop();
  return chain.map((p) => toPlane(frame, p));
}

/** A planar face as a region of its own plane (outer loop first, counter-clockwise; holes after). */
export function flatRegion(ctx: EvalContext, face: Shape, frame: Frame): Region2 {
  const oc = ctx.oc as Any, k = ctx.k;
  const outer = ctx.tmp(oc.BRepTools.OuterWire(oc.TopoDS.Face(face)));
  const loops: Region2 = [];
  for (const w of k.sub(face, "wire")) {
    const l = wireLoop(ctx, w, frame);
    if (l.length < 3) continue;
    if (w.IsSame(outer)) loops.unshift(loopArea(l) < 0 ? l.reverse() : l); else loops.push(l);
  }
  return loops;
}

/** The flat face a feature works on, or a sentence saying it needs one. */
export function flatFace(ctx: EvalContext, ref: GeomRef | null | undefined, what = "face"): FlatFace {
  if (!ref) throw ctx.fail(`Pick the ${what}: a flat face of a part.`);
  const r = ctx.resolve(ref);
  if (r.kind !== "face") throw ctx.fail(`The ${what} must be a face.`);
  const frame = ctx.k.faceFrame((ctx.oc as Any).TopoDS.Face(r.shape));
  if (!frame) throw ctx.fail(`The ${what} must be flat. Pick a planar face.`);
  const region = flatRegion(ctx, r.shape, frame);
  if (!region.length) throw ctx.fail(`The ${what} has no outline.`);
  return { frame, region, box: boundsOf(region[0]), body: r.body, face: r.shape, name: r.name };
}

// ---------------------------------------------------------------- where a pattern's seed is

/** The middle of what a pattern copies (the box round the material its features added or removed, or its bodies). */
export function seedCentre(ctx: EvalContext, p: CopyParams): Vec3 {
  const shapes: Shape[] = [];
  if (p.of === "bodies") {
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies = ids.length ? ids.map((id) => ctx.body(id)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies to copy no longer exist." : "There is no body to copy.");
    shapes.push(...bodies.map((b) => b.shape));
  } else {
    const { effects, created } = seedEffects(ctx, Array.isArray(p.features) ? p.features : [], "pattern");
    for (const e of effects) for (const t of [...e.remove, ...e.add]) shapes.push(t.shape);
    for (const b of created) shapes.push(b.shape);
    if (!shapes.length) throw ctx.fail("The features to pattern did not change the model.");
  }
  const b = bbox(ctx.k, shapes);
  if (!b) throw ctx.fail("There is nothing to copy.");
  return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
}

/**
 * A copy's placement: grown by `size` about `from`, turned `angle` radians about `axis` through `from`, then
 * moved so that `from` lands on `to`.
 */
export function placement(ctx: EvalContext, from: Vec3, to: Vec3, axis: Vec3, angle = 0, size = 1): Any {
  const oc = ctx.oc as Any, k = ctx.k;
  const t = ctx.own(new oc.gp_Trsf());
  if (Math.abs(size - 1) > 1e-12) t.SetScale(ctx.tmp(k.pnt(from)), size);
  if (Math.abs(angle) > 1e-12) {
    const r = ctx.tmp(new oc.gp_Trsf());
    r.SetRotation(ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(from)), ctx.tmp(k.dir(axis)))), angle);
    t.PreMultiply(r);
  }
  const d = sub(to, from);
  if (length(d) > 1e-12) { const m = ctx.tmp(new oc.gp_Trsf()); m.SetTranslation(ctx.tmp(k.vec(d))); t.PreMultiply(m); }
  return t;
}

/** The move that carries one frame (origin, x, normal) onto another. */
export function frameToFrame(ctx: EvalContext, from: { origin: Vec3; x: Vec3; normal: Vec3 }, to: { origin: Vec3; x: Vec3; normal: Vec3 }): Any {
  const oc = ctx.oc as Any, k = ctx.k;
  const ax = (f: { origin: Vec3; x: Vec3; normal: Vec3 }) => ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(f.origin)), ctx.tmp(k.dir(f.normal)), ctx.tmp(k.dir(f.x))));
  const t = ctx.own(new oc.gp_Trsf());
  t.SetDisplacement(ax(from), ax(to));
  return t;
}

/** One place of a pattern whose copies may be turned and sized: where the seed's middle goes. */
export interface Site { key: string; to: Vec3; angle?: number; size?: number }

/** A tool that is a straight extrusion along `normal`: its cross-section and where it starts and ends. */
interface Prismatic { section: Shape; z0: number; height: number; names: string[] }

/**
 * Whether a tool is its own cross-section pushed straight along `normal` (a hole, a pocket, a boss), and if so
 * that section at mid-height and the names of the faces a copy rebuilt from it gets, in the order the kernel
 * lists the rebuilt faces.
 */
function prismatic(ctx: EvalContext, tool: Tool, centre: Vec3, normal: Vec3): Prismatic | null {
  const oc = ctx.oc as Any, k = ctx.k;
  const hs = k.sub(tool.shape, "vertex").map((v) => dot(sub(k.vertexPoint(v), centre), normal));
  if (hs.length < 2) return null;
  const z0 = Math.min(...hs), height = Math.max(...hs) - z0, volume = k.volume(tool.shape);
  if (!(height > 1e-7) || !(volume > 1e-12)) return null;
  const mid = add(centre, scale(normal, z0 + height / 2));
  let section: Shape;
  try {
    const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(k.pnt(mid)), ctx.tmp(k.dir(normal))));
    const big = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, -1e5, 1e5, -1e5, 1e5)).Face());
    const algo = ctx.tmp(new oc.BRepAlgoAPI_Common(big, tool.shape, ctx.tmp(new oc.Message_ProgressRange())));
    algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!algo.IsDone()) return null;
    section = ctx.own(algo.Shape());
  } catch (e) { return null; }
  const faces = k.sub(section, "face");
  if (!faces.length) return null;
  const g = ctx.tmp(new oc.GProp_GProps());
  oc.BRepGProp.SurfaceProperties(section, g, false, false);
  if (Math.abs(g.Mass() * height - volume) > 1e-6 * volume) return null;
  // the names: rebuild the seed itself and give each face the name of the seed's face it lies on
  const rebuilt = prismOf(ctx, moved(ctx, section, scale(normal, -height / 2)), scale(normal, height));
  const names = k.sub(rebuilt, "face").map((f, i) => {
    const b = oc.BRepTools.UVBounds(oc.TopoDS.Face(f), 0, 0, 0, 0);
    const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(f), true));
    const q = ad.Value(b.UMin + (b.UMax - b.UMin) * 0.37, b.VMin + (b.VMax - b.VMin) * 0.41);
    const vx = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(q)).Vertex()); q.delete();
    let best = `prism#${i + 1}`, d = 1e-4;
    for (const sf of tool.faces) {
      const ex = ctx.tmp(new oc.BRepExtrema_DistShapeShape()), range = ctx.tmp(new oc.Message_ProgressRange());
      ex.LoadS1(vx); ex.LoadS2(sf.shape); ex.Perform(range);
      if (ex.IsDone() && ex.Value() < d) { d = ex.Value(); best = sf.name; }
    }
    return best;
  });
  return { section, z0, height, names };
}

function moved(ctx: EvalContext, shape: Shape, by: Vec3, trsf?: Any): Shape {
  const oc = ctx.oc as Any;
  const t = ctx.tmp(new oc.gp_Trsf());
  t.SetTranslation(ctx.tmp(ctx.k.vec(by)));
  if (trsf) t.Multiply(trsf);
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_Transform(shape, t, true, false)).Shape());
}

/**
 * Copies of features or bodies at sites, each turned about `normal` and sized about the seed's middle.  A size
 * other than 1 grows a copy across `normal` only when what is copied is a straight extrusion along it (a hole
 * through a plate stays through the plate, a pocket keeps its depth): the copy is the seed's cross-section,
 * sized, pushed through the same height.  Anything else (a countersink, a domed boss, a whole body) is sized
 * evenly in every direction.  Names are as the other patterns make them: `<id>:<key>:<seed face name>`.
 */
export function copySites(ctx: EvalContext, p: CopyParams, sites: readonly Site[], centre: Vec3, normal: Vec3): void {
  const k = ctx.k, id = ctx.feature.id, n = normalize(normal);
  const rigid = sites.every((s) => Math.abs((s.size ?? 1) - 1) < 1e-9);
  const whole = (s: Site): Instance => ({ key: s.key, trsf: placement(ctx, centre, s.to, n, s.angle || 0, s.size ?? 1) });
  if (rigid || p.of === "bodies") { copyInstances(ctx, p as CopyParams & { [key: string]: unknown }, sites.map(whole), "pattern"); return; }
  const { effects, created } = seedEffects(ctx, Array.isArray(p.features) ? p.features : [], "pattern");
  if (!effects.length && !created.length) throw ctx.fail("The features to pattern did not change the model.");
  if (!sites.length) { ctx.warn("Nothing was copied: every copy is left out."); return; }
  const sized = (tool: Tool, pr: Prismatic | null, s: Site): Tool => {
    if (!pr) return placeTool(ctx, tool, whole(s));
    // the section sized and turned in its own plane, then pushed through the seed's height
    const mid = scale(n, pr.z0 + pr.height / 2);
    const flat = moved(ctx, pr.section, scale(n, -pr.height / 2), placement(ctx, add(centre, mid), add(s.to, mid), n, s.angle || 0, s.size ?? 1));
    const shape = prismOf(ctx, flat, scale(n, pr.height));
    return { shape, faces: k.sub(shape, "face").map((f, i) => ({ name: `${id}:${s.key}:${pr.names[i] ?? `prism#${i + 1}`}`, shape: f })) };
  };
  for (const e of effects) {
    let body = ctx.body(e.bodyId);
    if (!body) continue;
    for (const [op, tools] of [["cut", e.remove], ["fuse", e.add]] as const) {
      if (!tools.length || !body) continue;
      const shapes = tools.map((t) => ({ t, pr: prismatic(ctx, t, centre, n) }));
      const r = booleanMany(ctx, op, { shape: body.shape, faces: body.topo.faces }, sites.flatMap((s) => shapes.map(({ t, pr }) => sized(t, pr, s))));
      const solids = k.solids(r.shape);
      if (!solids.length) { ctx.removeBody(body); body = undefined; break; }
      const host: Body = body;
      body = ctx.replaceBody(host, solids[0], r.names);
      solids.slice(1).forEach((s, i) => ctx.addBody(s, r.names, { suffix: `${host.id}.piece${i + 2}`, name: `${host.name} (${i + 2})` }));
    }
  }
  for (const b of created) copyBody(ctx, b, sites.map(whole));
}

// ---------------------------------------------------------------- flat shapes

/** A closed wire through points of a frame's plane, straight between them. */
export function polygonWire(ctx: EvalContext, frame: Frame, pts: readonly Vec2[]): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  const w = pts.map((p) => toWorld(frame, p));
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = w[(i + 1) % w.length];
    if (length(sub(a, b)) < 1e-9) continue;
    mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(a)), ctx.tmp(k.pnt(b)))).Edge()));
  }
  if (!mw.IsDone()) throw ctx.fail("An outline could not be closed.");
  return ctx.own(mw.Wire());
}

/**
 * A closed wire through the corners of a convex polygon, each corner rounded with `radius` (less where an edge
 * is too short for it).
 */
export function roundedWire(ctx: EvalContext, frame: Frame, pts: readonly Vec2[], radius: number): Shape {
  if (!(radius > 1e-6)) return polygonWire(ctx, frame, pts);
  const oc = ctx.oc as Any, k = ctx.k, n = pts.length;
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  const P = (p: Vec2) => ctx.tmp(k.pnt(toWorld(frame, p)));
  // per corner: where the arc starts and ends, and a point in its middle
  const corners = pts.map((p, i) => {
    const a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const ua: Vec2 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la], ub: Vec2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const half = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1]))) / 2;
    const t = Math.min(radius / Math.tan(half), la * 0.45, lb * 0.45), r = t * Math.tan(half);
    if (!(t > 1e-6) || !(half > 1e-3) || half > Math.PI / 2 - 1e-3) return { from: p, to: p, mid: null as Vec2 | null };
    const bis: Vec2 = [ua[0] + ub[0], ua[1] + ub[1]], bl = Math.hypot(bis[0], bis[1]), dist = r / Math.sin(half) - r;
    return { from: [p[0] + ua[0] * t, p[1] + ua[1] * t] as Vec2, to: [p[0] + ub[0] * t, p[1] + ub[1] * t] as Vec2, mid: [p[0] + (bis[0] / bl) * dist, p[1] + (bis[1] / bl) * dist] as Vec2 };
  });
  for (let i = 0; i < n; i++) {
    const c = corners[i], nx = corners[(i + 1) % n];
    if (c.mid) { const arc = ctx.tmp(new oc.GC_MakeArcOfCircle(P(c.from), P(c.mid), P(c.to))); mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(arc.Value())).Edge())); }
    if (Math.hypot(c.to[0] - nx.from[0], c.to[1] - nx.from[1]) > 1e-7) mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(P(c.to), P(nx.from))).Edge()));
  }
  if (!mw.IsDone()) throw ctx.fail("An outline could not be closed.");
  return ctx.own(mw.Wire());
}

/** A flat face inside a wire of a frame's plane (holes: more wires, each running the other way round). */
export function faceOfWires(ctx: EvalContext, frame: Frame, outer: Shape, holes: readonly Shape[] = []): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(frame.origin)), ctx.tmp(k.dir(frame.normal)), ctx.tmp(k.dir(frame.x))))));
  const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, oc.TopoDS.Wire(outer), true));
  for (const h of holes) mf.Add(oc.TopoDS.Wire(h));
  if (!mf.IsDone()) throw ctx.fail("An outline could not be made into a face.");
  return ctx.own(mf.Face());
}

/** A circle's wire in a frame's plane. */
export function circleWire(ctx: EvalContext, centre: Vec3, normal: Vec3, radius: number, x?: Vec3): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const ax = x ? new oc.gp_Ax2(ctx.tmp(k.pnt(centre)), ctx.tmp(k.dir(normal)), ctx.tmp(k.dir(x))) : new oc.gp_Ax2(ctx.tmp(k.pnt(centre)), ctx.tmp(k.dir(normal)));
  const circ = ctx.tmp(new oc.gp_Circ(ctx.tmp(ax), radius));
  const e = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(e)).Wire());
}

/** A shape pushed along a vector: a face becomes a solid, several faces a compound of solids. */
export function prismOf(ctx: EvalContext, shape: Shape, along: Vec3): Shape {
  const oc = ctx.oc as Any;
  const mk = ctx.tmp(new oc.BRepPrimAPI_MakePrism(shape, ctx.tmp(ctx.k.vec(along)), false, true));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("A shape could not be extruded.");
  return ctx.own(mk.Shape());
}

/** A cylinder from `at` along `dir`. */
export function cylinderOf(ctx: EvalContext, at: Vec3, dir: Vec3, radius: number, height: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const mk = ctx.tmp(new oc.BRepPrimAPI_MakeCylinder(ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(at)), ctx.tmp(k.dir(dir)))), radius, height));
  return ctx.own(mk.Shape());
}

/** A box between two corners given in a frame: x and y in its plane, z along its normal. */
export function boxIn(ctx: EvalContext, frame: Frame, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number): Shape {
  const wire = polygonWire(ctx, { ...frame, origin: add(frame.origin, scale(frame.normal, z0)) }, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
  return prismOf(ctx, faceOfWires(ctx, { ...frame, origin: add(frame.origin, scale(frame.normal, z0)) }, wire), scale(frame.normal, z1 - z0));
}

/** A face moved in from its edges by `margin` (holes grow by it); the face itself when the margin is zero. */
export function insetFace(ctx: EvalContext, face: Shape, margin: number): Shape {
  if (!(margin > 1e-9)) return face;
  const oc = ctx.oc as Any, k = ctx.k;
  try {
    const mk = ctx.tmp(new oc.BRepOffsetAPI_MakeOffset(oc.TopoDS.Face(face), oc.GeomAbs_JoinType.GeomAbs_Arc, false));
    mk.Perform(-margin, 0);
    if (mk.IsDone()) {
      const wires = k.sub(ctx.own(mk.Shape()), "wire");
      const frame = k.faceFrame(oc.TopoDS.Face(face));
      if (wires.length && frame) {
        const loops = wires.map((w) => ({ w, a: loopArea(wireLoop(ctx, w, frame)) })).sort((a, b) => Math.abs(b.a) - Math.abs(a.a));
        const orient = (l: { w: Shape; a: number }, ccw: boolean) => ((l.a > 0) === ccw ? l.w : ctx.own(l.w.Reversed()));
        return faceOfWires(ctx, frame, orient(loops[0], true), loops.slice(1).map((l) => orient(l, false)));
      }
    }
  } catch (e) { /* fall through */ }
  throw ctx.fail("The margin is too large for this face. Try a smaller one.");
}

/** Where a feature that lies on a flat face or on a plane goes: the frame's origin is the face's middle. */
export interface Placing { frame: Frame; flat: FlatFace | null; body: Body | null }

export function placeOn(ctx: EvalContext, target: RefTarget | null | undefined, what = "face or plane"): Placing {
  if (!target) throw ctx.fail(`Pick the ${what}.`);
  if (isGeomRef(target)) {
    const flat = flatFace(ctx, target, what);
    return { frame: { ...flat.frame, origin: ctx.k.centre(flat.face, "face") }, flat, body: flat.body };
  }
  return { frame: planeOf(ctx, target, what), flat: null, body: null };
}

/** The same frame moved in its plane and turned about its normal (degrees). */
export function shifted(frame: Frame, x: number, y: number, degrees: number): Frame {
  const a = ((Number(degrees) || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const fx = add(scale(frame.x, c), scale(frame.y, s)), fy = add(scale(frame.x, -s), scale(frame.y, c));
  return { origin: add(frame.origin, add(scale(frame.x, Number(x) || 0), scale(frame.y, Number(y) || 0))), x: fx, y: fy, normal: frame.normal };
}

/** How far a body reaches behind a point, against a direction: what "through" cuts by. */
export function depthBehind(ctx: EvalContext, body: Body, at: Vec3, normal: Vec3): number {
  const b = tightBox(ctx, [body.shape]);
  if (!b) return 1000;
  let far = 0;
  for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) far = Math.max(far, dot(sub(at, [x, y, z]), normal));
  return far + 1;
}

/** The part of tools that lies over a face moved in by `margin`, between two heights along its normal. */
export function clipToFace(ctx: EvalContext, tools: Shape, flat: FlatFace, margin: number, lo: number, hi: number): Shape {
  const oc = ctx.oc as Any;
  const column = prismOf(ctx, moved(ctx, insetFace(ctx, flat.face, margin), scale(flat.frame.normal, lo)), scale(flat.frame.normal, hi - lo));
  const algo = ctx.tmp(new oc.BRepAlgoAPI_Common(tools, column, ctx.tmp(new oc.Message_ProgressRange())));
  algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail("The pattern could not be trimmed to the face.");
  return ctx.own(algo.Shape());
}

/** Whether a region is exactly its own bounding rectangle (no holes, four square corners). */
export function isRectangle(flat: FlatFace): boolean {
  const [x0, y0, x1, y1] = flat.box;
  return flat.region.length === 1 && Math.abs(Math.abs(loopArea(flat.region[0])) - (x1 - x0) * (y1 - y0)) < 1e-7 * (x1 - x0) * (y1 - y0);
}

// ---------------------------------------------------------------- text

export interface TextStyle { height: number; bold?: boolean; italic?: boolean }

const textData = (text: string, s: TextStyle): { data: SketchData; e: SketchEntity } => {
  const e = { type: "text", a: "a", b: "b", text, bold: !!s.bold, italic: !!s.italic } as unknown as SketchEntity;
  const data = { version: 1, entities: { a: { type: "point", x: 0, y: 0 }, b: { type: "point", x: 0, y: s.height }, t: e }, constraints: {} } as unknown as SketchData;
  return { data, e };
};

/** How wide a text is set at this height. */
export function widthOfText(text: string, s: TextStyle): number { const { data, e } = textData(text, s); return textWidth(data, e); }

/**
 * A text as flat faces in `frame`: the baseline starts at the frame's origin and runs along its x, the letters
 * stand along its y.  One face per separate piece of a letter (the dot of an i is its own), with the letter's
 * counters as holes.  The outlines are the font's own curves, not polylines.
 */
export function textFaces(ctx: EvalContext, frame: Frame, text: string, s: TextStyle): Shape[] {
  const oc = ctx.oc as Any;
  return textShapes(ctx, text, s,
    (pc) => ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(nurbsCurve(ctx, frame, pc), pc.t0, pc.t1)).Edge(),
    (outer, holes) => faceOfWires(ctx, frame, outer, holes));
}

/**
 * The same text laid round a cylinder, as solids between the radii `from` and `to`.  `frame` is the text's frame
 * on the plane that touches the cylinder at `touch`: a length along the plane across the axis becomes the same
 * length round the cylinder's own radius, a length along the axis stays.  That is a plain stretch in the
 * cylinder's (angle, height) coordinates, so the font's curves are carried over exactly, as curves on the
 * surface.  A letter's walls run straight out from the axis, so a solid that starts inside the cylinder and
 * ends outside it crosses the surface cleanly: nothing of it lies exactly on the surface.
 */
export function textOnCylinder(ctx: EvalContext, cyl: { origin: Vec3; dir: Vec3; radius: number }, frame: Frame, touch: Vec3, text: string, s: TextStyle, from: number, to: number): Shape[] {
  const oc = ctx.oc as Any, k = ctx.k;
  if (!(from > 1e-6) || !(to > from + 1e-9)) throw ctx.fail("The letters are deeper than the cylinder's radius.");
  const A = normalize(cyl.dir), rel = sub(touch, cyl.origin), radial = normalize(sub(rel, scale(A, dot(rel, A))));
  const T = cross(A, radial);   // the way the angle grows at the touching line
  // the angle is π at the touching line, so text up to a whole turn wide never crosses the surface's seam
  const ax3 = ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(cyl.origin)), ctx.tmp(k.dir(A)), ctx.tmp(k.dir(scale(radial, -1)))));
  const uv = (q: Vec2): Vec2 => { const w = sub(toWorld(frame, q), touch); return [Math.PI + dot(w, T) / cyl.radius, dot(rel, A) + dot(w, A)]; };
  let lo = Infinity, hi = -Infinity;
  // the letters on a cylinder of one radius: their faces, and every stroke's edge in the order the strokes come
  const layer = (radius: number): { faces: Shape[]; edges: Shape[] } => {
    const surface = new oc.Geom_CylindricalSurface(ax3, radius);   // kept alive by the edges and faces on it
    const edges: Shape[] = [];
    const faces = textShapes(ctx, text, s,
      (pc) => {
        const n = pc.nurbs, { knots, mults } = knotsAndMults(n);
        const poles = ctx.tmp(new oc.NCollection_Array1_gp_Pnt2d(1, n.poles.length));
        n.poles.forEach((q, i) => { const m = uv(q); lo = Math.min(lo, m[0]); hi = Math.max(hi, m[0]); poles.SetValue(i + 1, ctx.tmp(new oc.gp_Pnt2d(m[0], m[1]))); });
        const kv = ctx.tmp(new oc.NCollection_Array1_double(1, knots.length)), mv = ctx.tmp(new oc.NCollection_Array1_int(1, mults.length));
        knots.forEach((x, i) => kv.SetValue(i + 1, x)); mults.forEach((x, i) => mv.SetValue(i + 1, x));
        const edge = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(new oc.Geom2d_BSplineCurve(poles, kv, mv, n.degree, false), surface, pc.t0, pc.t1)).Edge());
        oc.BRepLib.BuildCurves3d(edge);
        edges.push(edge);
        return edge;
      },
      (outer, holes) => {
        const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(surface, oc.TopoDS.Wire(outer), true));
        for (const h of holes) mk.Add(oc.TopoDS.Wire(h));
        if (!mk.IsDone()) throw ctx.fail("A letter could not be laid on the cylinder.");
        const fix = ctx.tmp(new oc.ShapeFix_Face(mk.Face()));
        fix.Perform();
        return ctx.own(fix.Face());
      },
      // on the cylinder a loop runs the other way round when the angle grows against the text
      dot(frame.x, T) * dot(frame.y, A) - dot(frame.x, A) * dot(frame.y, T) < 0, true);
    return { faces, edges };
  };
  const inner = layer(from), outer = layer(to);
  if (hi - lo > 2 * Math.PI - 1e-6) throw ctx.fail("The text is longer than the cylinder is round: it would wrap over itself. Make it smaller or shorter.");
  if (lo < 1e-6 || hi > 2 * Math.PI - 1e-6) throw ctx.fail("The text reaches round to the back of the cylinder, past its seam. Move it or make it smaller.");
  // the walls: straight out from the axis between each stroke at the two radii
  const walls: Shape[] = [];
  inner.edges.forEach((e, i) => {
    const mk = ctx.tmp(new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6));
    mk.AddWire(oc.TopoDS.Wire(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(e))).Wire())));
    mk.AddWire(oc.TopoDS.Wire(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(outer.edges[i]))).Wire())));
    mk.CheckCompatibility(false);
    mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!mk.IsDone()) throw ctx.fail("A letter's side could not be built.");
    walls.push(...k.sub(ctx.own(mk.Shape()), "face"));
  });
  const sewing = ctx.tmp(new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false));
  for (const f of [...inner.faces, ...outer.faces, ...walls]) sewing.Add(f);
  sewing.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  const solids: Shape[] = [];
  for (const shell of k.sub(ctx.own(sewing.SewedShape()), "shell")) {
    if (!oc.BRep_Tool.IsClosed(shell)) continue;
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shell)));
    if (!mk.IsDone()) continue;
    const solid = ctx.own(mk.Solid());
    oc.BRepLib.OrientClosedSolid(solid);
    if (k.volume(solid) > 1e-9) solids.push(solid);
  }
  if (solids.length < inner.faces.length) throw ctx.fail("Some letters could not be closed into solids on the cylinder. Try a larger text or less depth.");
  return solids;
}

function textShapes(ctx: EvalContext, text: string, s: TextStyle, edgeOf: (pc: Piece) => Any, faceOf: (outer: Shape, holes: Shape[]) => Shape, mirrored = false, kept = false): Shape[] {
  const oc = ctx.oc as Any;
  const { data, e } = textData(text, s);
  const pieces = piecesOf(data, e) || [];
  // strokes joined into closed contours: a stroke starts where the one before ended
  const contours: Piece[][] = [];
  let cur: Piece[] = [], start: Vec2 | null = null, tip: Vec2 | null = null;
  const ends = (pc: Piece): [Vec2, Vec2] => { const pl = pc.nurbs.poles; return [pl[0], pl[pl.length - 1]]; };
  const close = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;
  for (const pc of pieces) {
    const [a, b] = ends(pc);
    if (!cur.length || !tip || !close(a, tip)) { cur = []; start = a; }
    cur.push(pc); tip = b;
    if (start && close(b, start)) { contours.push(cur); cur = []; tip = null; }
  }
  const loops = contours.map((c) => {
    const poly: Loop2 = [];
    for (const pc of c) poly.push(...samplePiece(pc, pc.t0, pc.t1, 6).slice(0, -1));
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    for (const pc of c) { const edge = edgeOf(pc); mw.Add(kept ? edge : ctx.tmp(edge)); }
    return { poly, area: loopArea(poly) * (mirrored ? -1 : 1), wire: mw.IsDone() ? (ctx.own(mw.Wire()) as Shape) : null };
  }).filter((l) => l.wire && Math.abs(l.area) > 1e-9 && l.poly.length >= 3);
  // a contour inside an odd number of others is a hole of the smallest one round it
  const depth = loops.map((l, i) => loops.filter((o, j) => j !== i && inLoop(o.poly, l.poly[0])).length);
  const faces: Shape[] = [];
  loops.forEach((l, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && inLoop(l.poly, h.poly[0]));
    const way = (x: { wire: Shape | null; area: number }, ccw: boolean) => ((x.area > 0) === ccw ? x.wire! : ctx.own(x.wire!.Reversed()));
    faces.push(faceOf(way(l, true), holes.map((h) => way(h, false))));
  });
  return faces;
}

/** How far a tool reaches past the face it stands on or is cut from, so that it does not end exactly on it. */
export const OVERLAP = 0.01;

// ---------------------------------------------------------------- pipes

/** A round bar (or a tube, with `inner` > 0) along a wire.  Faces: `<id>:outer`, `:inner`, `:start`, `:end`. */
export function pipeAlong(ctx: EvalContext, spine: Shape, outer: number, inner = 0): { shape: Shape; faces: NamedShape[] } {
  const oc = ctx.oc as Any, k = ctx.k, id = ctx.feature.id;
  const s = curveEnd(ctx, spine, false), dir = scale(s.out, -1);
  // the path as smooth runs: a new run starts wherever two edges meet at a corner
  const runs: Shape[][] = [], joints: Vec3[] = [];
  const ends = (edge: Shape): { a: Vec3; b: Vec3; ta: Vec3; tb: Vec3 } => {
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
    const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), v = ctx.tmp(new oc.gp_Vec(0, 0, 0));
    ad.D1(ad.FirstParameter(), p, v); const a = k.xyz(p), ta = normalize(k.xyz(v));
    ad.D1(ad.LastParameter(), p, v); const b = k.xyz(p), tb = normalize(k.xyz(v));
    return { a, b, ta, tb };
  };
  let last: { at: Vec3; t: Vec3 } | null = null;   // where the path has got to, and the way it was going
  const all = k.sub(spine, "edge"), facts = all.map(ends);
  const close = (p: Vec3, q: Vec3) => length(sub(p, q)) < 1e-6;
  all.forEach((edge, i) => {
    const e = facts[i];
    // an edge may lie either way along the path: it starts at the end the path has reached
    let forward = true;
    if (last) forward = close(e.a, last.at) || !close(e.b, last.at);
    else if (all.length > 1) { const n = facts[1]; forward = close(e.b, n.a) || close(e.b, n.b); }
    const from = forward ? e.a : e.b, t0 = forward ? e.ta : scale(e.tb, -1), to = forward ? e.b : e.a, t1 = forward ? e.tb : scale(e.ta, -1);
    if (last && close(from, last.at) && dot(last.t, t0) > 0.99985) runs[runs.length - 1].push(edge);
    else { if (last && close(from, last.at)) joints.push(from); runs.push([edge]); }
    last = { at: to, t: t1 };
  });
  const sweep = (r: number): Shape => {
    const parts: Shape[] = [];
    for (const run of runs) {
      const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
      for (const e of run) mw.Add(oc.TopoDS.Edge(e));
      if (!mw.IsDone()) throw ctx.fail("The path's curves do not join end to end.");
      const wire = ctx.own(mw.Wire()), at = curveEnd(ctx, wire, false), n = scale(at.out, -1);
      let shape: Shape | null = null;
      try {
        const mk = ctx.tmp(new oc.BRepOffsetAPI_MakePipe(oc.TopoDS.Wire(wire), faceOfWires(ctx, frameFromNormal(at.at, n), circleWire(ctx, at.at, n, r))));
        mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
        if (mk.IsDone()) shape = ctx.own(mk.Shape());
      } catch (e) { shape = null; }
      if (!shape || k.solids(shape).length !== 1 || !(k.volume(shape) > 1e-9)) throw ctx.fail("The path could not be followed. Its bends may be tighter than the tube is thick: use a larger bend radius or a thinner tube.");
      parts.push(shape);
    }
    // a ball at every corner rounds it, as a bent wire's outside is
    for (const j of joints) parts.push(ctx.own(ctx.tmp(new oc.BRepPrimAPI_MakeSphere(ctx.tmp(k.pnt(j)), r)).Shape()));
    if (parts.length === 1) return parts[0];
    const algo = ctx.tmp(new oc.BRepAlgoAPI_Fuse());
    const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()), tools = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
    args.Append(parts[0]);
    for (const q of parts.slice(1)) tools.Append(q);
    algo.SetArguments(args); algo.SetTools(tools);
    algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail("The path's runs could not be joined at its corners.");
    algo.SimplifyResult(true, true, 1e-4);
    const out = ctx.own(algo.Shape());
    if (k.solids(out).length !== 1) throw ctx.fail("The path's runs do not join into one tube.");
    return out;
  };
  let shape = sweep(outer);
  if (inner > 1e-9) {
    const cut = ctx.tmp(new oc.BRepAlgoAPI_Cut(shape, sweep(inner), ctx.tmp(new oc.Message_ProgressRange())));
    cut.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!cut.IsDone()) throw ctx.fail("The tube's bore could not be cut.");
    shape = ctx.own(cut.Shape());
  }
  const e = curveEnd(ctx, spine, true);
  const closed = length(sub(s.at, e.at)) < 1e-6;
  const faces = k.sub(shape, "face").map((f): NamedShape => {
    const flat = k.faceFrame(oc.TopoDS.Face(f)), c = k.centre(f, "face");
    let name = `${id}:outer`;
    if (flat && !closed && length(sub(c, s.at)) < 1e-4 && Math.abs(dot(flat.normal, dir)) > 0.999) name = `${id}:start`;
    else if (flat && !closed && length(sub(c, e.at)) < 1e-4 && Math.abs(dot(flat.normal, e.out)) > 0.999) name = `${id}:end`;
    else if (inner > 1e-9 && nearSpine(ctx, f, spine) < (outer + inner) / 2) name = `${id}:inner`;
    return { name, shape: f };
  });
  const names = faces.map((f) => f.name);
  k.settleNames(faces.map((f) => f.shape), names, `${id}:new`, "face");
  return { shape, faces: faces.map((f, i) => ({ name: names[i]!, shape: f.shape })) };
}

function nearSpine(ctx: EvalContext, face: Shape, spine: Shape): number {
  const oc = ctx.oc as Any;
  // a point of the face, and how far it is from the path
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  const b = oc.BRepTools.UVBounds(oc.TopoDS.Face(face), 0, 0, 0, 0);
  const p = ad.Value((b.UMin + b.UMax) / 2, (b.VMin + b.VMax) / 2);
  const v = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(p)).Vertex()); p.delete();
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape()), range = ctx.tmp(new oc.Message_ProgressRange());
  d.LoadS1(v); d.LoadS2(spine); d.Perform(range);
  return d.IsDone() ? d.Value() : Infinity;
}

/** A wire through points with a round bend of `radius` at each corner (straight between the bends). */
export function bentWire(ctx: EvalContext, pts: readonly Vec3[], radius: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const P = (p: Vec3) => ctx.tmp(k.pnt(p));
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  const line = (a: Vec3, b: Vec3) => { if (length(sub(a, b)) > 1e-7) mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(P(a), P(b))).Edge())); };
  let from = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], ua = normalize(sub(pts[i - 1], p)), ub = normalize(sub(pts[i + 1], p));
    const half = Math.acos(Math.max(-1, Math.min(1, dot(ua, ub)))) / 2;
    if (!(radius > 1e-9) || half > Math.PI / 2 - 1e-4) { line(from, p); from = p; continue; }   // no bend, or no corner
    const t = radius / Math.tan(half);
    const room = Math.min(length(sub(pts[i - 1], p)) * (i === 1 ? 1 : 0.5), length(sub(pts[i + 1], p)) * (i === pts.length - 2 ? 1 : 0.5));
    if (t > room + 1e-9) throw ctx.fail(`The bend radius is too large for corner ${i}: the straight runs beside it are too short. Use a radius of ${(room * Math.tan(half)).toFixed(2)} or less.`);
    const a = add(p, scale(ua, t)), b = add(p, scale(ub, t)), bis = normalize(add(ua, ub));
    const mid = add(p, scale(bis, radius / Math.sin(half) - radius));
    line(from, a);
    mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.GC_MakeArcOfCircle(P(a), P(mid), P(b))).Value())).Edge()));
    from = b;
  }
  line(from, pts[pts.length - 1]);
  if (!mw.IsDone()) throw ctx.fail("The path could not be built from these points.");
  return ctx.own(mw.Wire());
}

// ---------------------------------------------------------------- tools into bodies

/** A shape as a tool whose faces are named `<feature>:<tag>:<n>`. */
export function tagged(ctx: EvalContext, shape: Shape, tag: string): Tool {
  return { shape, faces: ctx.k.sub(shape, "face").map((f, i) => ({ name: `${ctx.feature.id}:${tag}:${i + 1}`, shape: f })) };
}

/** Copies of one tool at each instance (sharing its geometry), their faces named `<feature>:<key>:<n>`. */
export function stamp(ctx: EvalContext, shape: Shape, instances: readonly Instance[]): Tool[] {
  const oc = ctx.oc as Any;
  const faces = ctx.k.sub(shape, "face");
  return instances.map((inst) => {
    const mk = ctx.tmp(new oc.BRepBuilderAPI_Transform(shape, inst.trsf, false, false));
    return { shape: ctx.own(mk.Shape()), faces: faces.map((f, i) => ({ name: `${ctx.feature.id}:${inst.key}:${i + 1}`, shape: ctx.own(mk.ModifiedShape(f)) })) };
  });
}

/**
 * `base` with every tool cut out of it or joined to it in one boolean, as pattern-core's booleanMany, but for
 * hundreds of small tools: the kernel is told to sort them by oriented boxes first.
 */
export function booleanTools(ctx: EvalContext, op: "cut" | "fuse", base: { shape: Shape; faces: readonly NamedShape[] }, tools: readonly Tool[]): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const algo = ctx.own(op === "cut" ? new oc.BRepAlgoAPI_Cut() : new oc.BRepAlgoAPI_Fuse());
  const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()), list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
  args.Append(base.shape);
  for (const t of tools) list.Append(t.shape);
  algo.SetArguments(args);
  algo.SetTools(list);
  algo.SetUseOBB(true);
  algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail(op === "cut" ? "The shapes could not be cut from the body." : "The shapes could not be joined to the body.");
  algo.SimplifyResult(true, true, 1e-4);
  const shape = ctx.own(algo.Shape());
  const inputs: NamedShape[] = [...base.faces];
  for (const t of tools) inputs.push(...t.faces);
  return { shape, names: k.carryNames(shape, algo, inputs, ctx.feature.id) };
}

export type ToolOp = "new" | "add" | "remove";
export const TOOL_OPS = [{ value: "new", label: "New" }, { value: "add", label: "Add" }, { value: "remove", label: "Remove" }];

/**
 * Put tools into the model.  "add" and "remove" change `bodies` (each with every tool, in one boolean); a body
 * that falls apart keeps its first piece and the rest become bodies.  "new" makes one body of all the tools.
 */
export function applyTools(ctx: EvalContext, tools: readonly Tool[], op: ToolOp, bodies: readonly Body[], name?: string): void {
  const k = ctx.k;
  if (!tools.length) throw ctx.fail("There is nothing to build: no shape fits with these settings.");
  if (op === "new") {
    const shape = tools.length === 1 ? tools[0].shape : compound(k, tools.map((t) => t.shape), ctx.own);
    ctx.addBody(shape, namerOf(ctx, tools.flatMap((t) => t.faces)), name ? { name } : undefined);
    return;
  }
  if (!bodies.length) throw ctx.fail(op === "add" ? "There is no body to add to. Choose New, or pick a face of a part." : "There is no body to remove material from.");
  let changed = false;
  for (const body of bodies) {
    const before = k.volume(body.shape);
    const r = booleanTools(ctx, op === "add" ? "fuse" : "cut", { shape: body.shape, faces: body.topo.faces }, tools);
    const solids = k.solids(r.shape);
    if (!solids.length) { ctx.removeBody(body); changed = true; continue; }
    if (Math.abs(k.volume(r.shape) - before) <= 1e-9 * Math.max(1, before)) continue;
    changed = true;
    if (op === "add") {
      // what does not touch the body is not part of it: keep the largest piece as the body, the rest as bodies
      solids.sort((a, b) => k.volume(b) - k.volume(a));
    }
    ctx.replaceBody(body, solids[0], r.names);
    solids.slice(1).forEach((s, n) => ctx.addBody(s, r.names, { suffix: `${body.id}.piece${n + 2}`, name: `${body.name} (${n + 2})` }));
  }
  if (!changed) ctx.warn(op === "add" ? "Nothing was added: the new shapes do not reach a body." : "Nothing was removed: the new shapes do not reach into a body.");
}

/** The bodies a feature that works on a face changes: the face's own, or the ones picked. */
export function scopeOf(ctx: EvalContext, ids: unknown, fallback: Body | null): Body[] {
  const list = Array.isArray(ids) ? ids as string[] : [];
  if (!list.length) return fallback ? [ctx.body(fallback.id) || fallback] : ctx.bodies().slice();
  const out = list.map((id) => ctx.body(id)).filter((b): b is Body => !!b);
  if (!out.length) throw ctx.fail("The bodies this feature should change are gone. Edit it and pick them again.");
  return out;
}

/**
 * Points that lie on a shape's faces: its own vertices exactly, and the points of a mesh of its curved faces
 * fine enough that no place of a face is further than `linear` from the points' hull.  What a hull, a stock
 * cylinder or any other "smallest thing round it" is found from.
 */
export function surfacePoints(ctx: EvalContext, shape: Shape, linear: number, angular = 0.2): Vec3[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const out: Vec3[] = k.sub(shape, "vertex").map((v) => k.vertexPoint(v));
  const curved = k.sub(shape, "face").some((f) => !k.faceFrame(oc.TopoDS.Face(f))) || k.sub(shape, "edge").some((e) => { const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e))); return ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line; });
  if (!curved) return out;
  const m = oc.ReplicadMeshExtractor.extract(shape, Math.max(1e-4, linear), angular, false);
  try {
    const pos = new Float32Array(oc.wasmMemory.buffer, m.getVerticesPtr(), m.getVerticesSize());
    for (let i = 0; i + 2 < pos.length; i += 3) out.push([pos[i], pos[i + 1], pos[i + 2]]);
  } finally { m.delete(); }
  return out;
}

/** The corners of the box round shapes, exactly (the kernel's tight box, not the loose one of its control points). */
export function tightBox(ctx: EvalContext, shapes: readonly Shape[]): [number, number, number, number, number, number] | null {
  const oc = ctx.oc as Any;
  const box = ctx.tmp(new oc.Bnd_Box());
  for (const s of shapes) oc.BRepBndLib.AddOptimal(s, box, false, false);
  if (box.IsVoid()) return null;
  return [box.GetXMin(), box.GetYMin(), box.GetZMin(), box.GetXMax(), box.GetYMax(), box.GetZMax()];
}

export { cross };
