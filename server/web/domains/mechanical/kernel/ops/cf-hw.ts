// cf-hw.ts — what the hardware custom features (features/cf-hw-*.ts: threads, fasteners, enclosures, pockets)
// build their solids with: closed outlines of lines and arcs in a plane, extruded or revolved with every face
// named after the piece of outline that swept it; booleans between such solids that keep the names; where a
// feature goes (sketch points, vertices, a plane); and facts about a cylindrical face.  Worker side.
//
// Names: a solid made here names its faces `<prefix>:<role>`: the role of the outline piece, `bottom` and `top`
// for the caps of an extrusion, `start` and `end` for the ends of a part turn.  Pieces with the same role share
// a name and the engine tells them apart (`~2`, `~3`, in geometric order), as it does for any split face.
import { add, cross, dot, normalize, scale, sub, toWorld, type Frame, type Vec3 } from "../../core/geometry";
import { isGeomRef } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { Body, EvalContext, NamedShape, Shape } from "../types";
import type { RefTarget } from "../../features/_refs";
import { combine, scoped, toolFaces, type Operation, type Tool } from "./combine";
import { holeTool, type HoleKind } from "./holes";
import { canonical, edgeInfo, faceInfo, frameFromNormal, onPlane, planeOf, pointOf } from "./ref-geom";
import { compound, moveNamed, reachPast, type Motion } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export type V2 = [number, number];
/** One piece of an outline: a line to `to`, or an arc to `to` through `via`. */
export interface Seg { to: V2; via?: V2; role?: string | null }
/** A closed outline in a plane: pieces from `start` back to `start`, or a whole circle. */
export interface Loop { start?: V2; segs?: Seg[]; circle?: { c: V2; r: number }; role?: string | null }

const EPS = 1e-9;
const same = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;

/** A polygon through points; `roles` names each side (the side from point i to the next), or all of them. */
export function poly(pts: readonly V2[], roles?: readonly (string | null)[] | string | null): Loop {
  const role = (i: number) => (Array.isArray(roles) ? roles[i] ?? null : (roles as string | null | undefined) ?? null);
  return { start: pts[0], segs: pts.map((_, i) => ({ to: pts[(i + 1) % pts.length], role: role(i) })) };
}
export const circle = (c: V2, r: number, role: string | null = "side"): Loop => ({ circle: { c, r }, role });

/** A regular polygon with `n` sides around `c`: `across` is the distance between opposite flats. */
export function ngon(c: V2, n: number, across: number, turn = 0, role = "flat"): Loop {
  const rc = across / 2 / Math.cos(Math.PI / n);
  return poly(Array.from({ length: n }, (_, i) => { const a = turn + (2 * Math.PI * (i + 0.5)) / n; return [c[0] + rc * Math.cos(a), c[1] + rc * Math.sin(a)] as V2; }), role);
}

/** A rectangle `w` by `h` about `c` with its corners rounded by `r` (0: sharp), turned by `turn` radians. */
export function roundRect(c: V2, w: number, h: number, r = 0, turn = 0, role = "side"): Loop {
  const hw = w / 2, hh = h / 2, rr = Math.max(0, Math.min(r, hw - 1e-6, hh - 1e-6));
  const cs = Math.cos(turn), sn = Math.sin(turn);
  const T = (x: number, y: number): V2 => [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs];
  if (rr < 1e-6) return poly([T(-hw, -hh), T(hw, -hh), T(hw, hh), T(-hw, hh)], [`${role}:front`, `${role}:right`, `${role}:back`, `${role}:left`]);
  const q = rr * (1 - Math.SQRT1_2);
  const segs: Seg[] = [
    { to: T(hw - rr, -hh), role: `${role}:front` }, { to: T(hw, -hh + rr), via: T(hw - q, -hh + q), role: `${role}:corner` },
    { to: T(hw, hh - rr), role: `${role}:right` }, { to: T(hw - rr, hh), via: T(hw - q, hh - q), role: `${role}:corner` },
    { to: T(-hw + rr, hh), role: `${role}:back` }, { to: T(-hw, hh - rr), via: T(-hw + q, hh - q), role: `${role}:corner` },
    { to: T(-hw, -hh + rr), role: `${role}:left` }, { to: T(-hw + rr, -hh), via: T(-hw + q, -hh + q), role: `${role}:corner` },
  ];
  return { start: T(-hw + rr, -hh), segs };
}

/** A slot (two half circles joined by lines) `len` between centres and `width` wide about `c`, turned by `turn`. */
export function slot(c: V2, len: number, width: number, turn = 0, role = "side"): Loop {
  if (len < 1e-6) return circle(c, width / 2, role);
  return roundRect(c, len + width, width, width / 2 - 1e-7, turn, role);
}

/** A point of a frame's plane lifted `z` along its normal. */
export const lift = (f: Frame, p: V2, z = 0): Vec3 => add(toWorld(f, p), scale(f.normal, z));
/** The frame moved to a point of its plane (and along its normal), and turned about the normal. */
export function frameAt(f: Frame, p: V2 = [0, 0], z = 0, turn = 0): Frame {
  const cs = Math.cos(turn), sn = Math.sin(turn);
  return { origin: lift(f, p, z), x: add(scale(f.x, cs), scale(f.y, sn)), y: add(scale(f.x, -sn), scale(f.y, cs)), normal: f.normal };
}
/** The frame seen from the other side: the normal turned over, x kept. */
export const flipped = (f: Frame): Frame => ({ origin: f.origin, x: f.x, y: scale(f.y, -1), normal: scale(f.normal, -1) });
/** A frame whose plane holds the axis: x is `across`, y runs along `along`.  For outlines drawn in a side view. */
export const sideFrame = (origin: Vec3, across: Vec3, along: Vec3): Frame => ({ origin, x: across, y: along, normal: cross(across, along) });

interface Wired { wire: Any; edges: { role: string | null; edge: Any }[] }

function wireOf(ctx: EvalContext, at: (p: V2) => Vec3, normal: Vec3, x: Vec3, loop: Loop): Wired {
  const oc = ctx.oc as Any, k = ctx.k;
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  const edges: Wired["edges"] = [];
  if (loop.circle) {
    if (!(loop.circle.r > EPS)) throw ctx.fail("A circle of the shape has no radius.");
    const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(at(loop.circle.c))), ctx.tmp(k.dir(normal)), ctx.tmp(k.dir(x))));
    const e = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, loop.circle.r)))).Edge());
    mw.Add(e);
    edges.push({ role: loop.role ?? null, edge: ctx.own(mw.Edge()) });
    return { wire: ctx.own(mw.Wire()), edges };
  }
  let from = loop.start!;
  for (const s of loop.segs || []) {
    if (same(from, s.to)) continue;
    let mk: Any;
    if (s.via) {
      const arc = ctx.tmp(new oc.GC_MakeArcOfCircle(ctx.tmp(k.pnt(at(from))), ctx.tmp(k.pnt(at(s.via))), ctx.tmp(k.pnt(at(s.to)))));
      if (!arc.IsDone()) throw ctx.fail("An arc of the shape could not be built.");
      mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(arc.Value()));
    } else mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(at(from))), ctx.tmp(k.pnt(at(s.to)))));
    if (!mk.IsDone()) throw ctx.fail("An edge of the shape could not be built.");
    const e = ctx.own(mk.Edge());
    mw.Add(e);
    if (!mw.IsDone()) throw ctx.fail("The outline of the shape does not close.");
    edges.push({ role: s.role ?? null, edge: ctx.own(mw.Edge()) });
    from = s.to;
  }
  if (!same(from, loop.start!)) throw ctx.fail("The outline of the shape does not close.");
  return { wire: ctx.own(mw.Wire()), edges };
}

/** Twice the signed area of an outline: positive when it runs anticlockwise. */
function turnOf(loop: Loop): number {
  if (loop.circle) return 1;
  const pts: V2[] = [loop.start!];
  for (const s of loop.segs || []) { if (s.via) pts.push(s.via); pts.push(s.to); }
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a;
}

function faceOf(ctx: EvalContext, f: Frame, z: number, outer: Loop, holes: readonly Loop[]): { face: Any; edges: Wired["edges"] } {
  const oc = ctx.oc as Any, k = ctx.k;
  const at = (p: V2) => lift(f, p, z);
  const hand = dot(cross(f.x, f.y), f.normal) < 0 ? -1 : 1;
  const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(at([0, 0]))), ctx.tmp(k.dir(f.normal)), ctx.tmp(k.dir(f.x))))));
  // the outer wire runs anticlockwise about the normal, a hole clockwise
  const run = (loop: Loop, anticlockwise: boolean): Wired => {
    const w = wireOf(ctx, at, f.normal, f.x, loop);
    const is = turnOf(loop) * (loop.circle ? 1 : hand) > 0;
    return is === anticlockwise ? w : { wire: ctx.own(w.wire.Reversed()), edges: w.edges };
  };
  const o = run(outer, true);
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, oc.TopoDS.Wire(o.wire), true));
  if (!mk.IsDone()) throw ctx.fail("A face of the shape could not be built.");
  const edges = [...o.edges];
  for (const h of holes) { const w = run(h, false); mk.Add(oc.TopoDS.Wire(w.wire)); edges.push(...w.edges); }
  return { face: ctx.own(mk.Face()), edges };
}

/** The area of a face as the kernel sees it (negative or huge when its wire runs the wrong way round). */
export function areaOf(ctx: EvalContext, face: Shape): number {
  const oc = ctx.oc as Any;
  const g = new oc.GProp_GProps();
  try { oc.BRepGProp.SurfaceProperties(face, g, false, false); return g.Mass(); } finally { g.delete(); }
}

/**
 * An outline in the plane of `f`, with holes, extruded from `z0` along the normal by `height`.  Faces:
 * `<prefix>:bottom`, `<prefix>:top` and `<prefix>:<role>` for what each piece of outline swept.
 */
export function extruded(ctx: EvalContext, f: Frame, outer: Loop, holes: readonly Loop[], z0: number, height: number, prefix: string, along?: Vec3): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  if (!(Math.abs(height) > EPS)) throw ctx.fail("A height of the shape is zero.");
  const { face, edges } = faceOf(ctx, f, z0, outer, holes);
  const prism = ctx.own(new oc.BRepPrimAPI_MakePrism(face, ctx.tmp(k.vec(along ? along : scale(f.normal, height))), false, true));
  prism.Build();
  if (!prism.IsDone()) throw ctx.fail("A shape could not be extruded.");
  let shape = ctx.own(prism.Shape());
  if (k.volume(shape) < 0) shape = ctx.own(shape.Reversed());
  const named = new ShapeIndex<string>(k);
  named.add(ctx.own(prism.FirstShape()), `${prefix}:bottom`);
  named.add(ctx.own(prism.LastShape()), `${prefix}:top`);
  for (const e of edges) for (const s of k.list(prism.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.role ?? "side"}`);
  return { shape, names: (face2) => named.get(face2) ?? null };
}

/**
 * An outline in (radius, height), turned about the axis through `f.origin` along `f.normal` (radius is measured
 * along `f.x`).  Pieces on the axis sweep nothing.  Faces: `<prefix>:<role>`; a part turn adds `:start`, `:end`.
 */
export function revolved(ctx: EvalContext, f: Frame, outline: Loop, prefix: string, degrees = 360): NamedResult {
  const oc = ctx.oc as Any, k = ctx.k;
  const side = sideFrame(f.origin, f.x, f.normal);
  const { face, edges } = faceOf(ctx, side, 0, outline, []);
  const ax = ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(f.origin)), ctx.tmp(k.dir(f.normal))));
  const full = Math.abs(degrees) >= 360 - 1e-9;
  const rev = ctx.own(full ? new oc.BRepPrimAPI_MakeRevol(face, ax, true) : new oc.BRepPrimAPI_MakeRevol(face, ax, (degrees * Math.PI) / 180, true));
  rev.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!rev.IsDone()) throw ctx.fail("A shape could not be turned about its axis.");
  let shape = ctx.own(rev.Shape());
  const named = new ShapeIndex<string>(k);
  if (!full) { named.add(ctx.own(rev.FirstShape()), `${prefix}:start`); named.add(ctx.own(rev.LastShape()), `${prefix}:end`); }
  for (const e of edges) if (e.role) for (const s of k.list(rev.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.role}`);
  if (k.volume(shape) < 0) shape = ctx.own(shape.Reversed());
  return { shape, names: (face2) => named.get(face2) ?? null };
}

/** An outline of straight pieces in (radius, height) for `revolved`: `pts` from the axis out and back. */
export const profile = (pts: readonly V2[], roles: readonly (string | null)[]): Loop => poly(pts, roles);

// ---------------------------------------------------------------- booleans that keep names

const input = (ctx: EvalContext, r: NamedResult) => ({ shape: r.shape, faces: toolFaces(ctx, r) });
export const fuse = (ctx: EvalContext, a: NamedResult, b: NamedResult): NamedResult => ctx.k.boolean("fuse", input(ctx, a), input(ctx, b), ctx.feature.id, ctx.own);
export const cut = (ctx: EvalContext, a: NamedResult, b: NamedResult): NamedResult => ctx.k.boolean("cut", input(ctx, a), input(ctx, b), ctx.feature.id, ctx.own);
export const common = (ctx: EvalContext, a: NamedResult, b: NamedResult): NamedResult => ctx.k.boolean("common", input(ctx, a), input(ctx, b), ctx.feature.id, ctx.own);

/** Several tools as one argument of a boolean.  They must not overlap each other. */
export function together(ctx: EvalContext, tools: readonly NamedResult[]): NamedResult {
  if (tools.length === 1) return tools[0];
  const faces: NamedShape[] = tools.flatMap((t) => toolFaces(ctx, t));
  const index = new ShapeIndex<string>(ctx.k);
  for (const f of faces) index.add(f.shape, f.name);
  return { shape: compound(ctx.k, tools.map((t) => t.shape), ctx.own), names: (f) => index.get(f) ?? null };
}
export const fuseAll = (ctx: EvalContext, parts: readonly NamedResult[]): NamedResult => parts.slice(1).reduce((acc, t) => fuse(ctx, acc, t), parts[0]);
export const moved = (ctx: EvalContext, r: NamedResult, m: Motion): NamedResult => moveNamed(ctx.k, r.shape, r.names, m, ctx.own);
/** Cut tools out of a body, or join them to it, in place.  Returns false when the body did not change. */
export function changeBody(ctx: EvalContext, body: Body, op: "cut" | "fuse", tool: NamedResult): boolean {
  const k = ctx.k;
  const r = k.boolean(op, { shape: body.shape, faces: body.topo.faces }, input(ctx, tool), ctx.feature.id, ctx.own);
  const was = k.volume(body.shape), now = k.volume(r.shape);
  if (Math.abs(was - now) <= 1e-9 * Math.max(1, was)) return false;
  const solids = k.solids(r.shape);
  if (!solids.length) { ctx.removeBody(body); return true; }
  // the largest piece keeps the body's id; a body cut in two leaves the others as bodies of their own
  const order = solids.map((s) => ({ s, v: k.volume(s) })).sort((a, b) => b.v - a.v);
  ctx.replaceBody(body, order[0].s, r.names);
  order.slice(1).forEach((o, n) => ctx.addBody(o.s, r.names, { suffix: `${body.id}.piece${n + 2}`, name: `${body.name} (${n + 2})` }));
  return true;
}

// ---------------------------------------------------------------- where a feature goes

export interface Spot { key: string; frame: Frame }
export interface Where { [key: string]: Any; at?: RefTarget[] | null; plane?: Any; flip?: boolean; angle?: number }

/**
 * The places a feature is built at, each a frame whose normal points out of the surface: one per picked sketch
 * point, vertex, round edge (its centre) or reference point, lying in the picked plane (a sketch point brings its
 * sketch's plane when no plane is picked); with nothing picked, the middle of the picked face or the plane's
 * origin.  `key` tells the places apart in names and survives the others being added or removed.
 */
export function spots(ctx: EvalContext, p: Where): Spot[] {
  const targets: RefTarget[] = Array.isArray(p.at) ? p.at : p.at ? [p.at as RefTarget] : [];
  const turn = ((Number(p.angle) || 0) * Math.PI) / 180;
  const picked = p.plane && (p.plane.kind !== "plane" || p.plane.plane !== "top");
  let base: Frame = ctx.frameOf(p.plane || { kind: "plane", plane: "top" });
  const firstSketch = targets.find((t) => t.kind === "sketch") as (RefTarget & { feature: string }) | undefined;
  if (firstSketch && !picked) base = ctx.sketch(firstSketch.feature).frame;
  const orient = (origin: Vec3): Frame => { const f = frameAt({ ...base, origin }, [0, 0], 0, turn); return p.flip ? flipped(f) : f; };
  if (!targets.length) {
    let origin = base.origin;
    if (p.plane && p.plane.kind === "face") origin = onPlane(base, ctx.k.centre(ctx.resolve(p.plane.ref).shape, "face"));
    return [{ key: "0", frame: orient(origin) }];
  }
  const out: Spot[] = [];
  const seen = new Set<string>();
  for (const t of targets) {
    let key: string, pts: Vec3[];
    if (t.kind === "sketch") {
      const s = ctx.sketch(t.feature), e = s.data.entities[t.entity] as Any;
      if (!e) throw ctx.fail("A sketch point this feature uses is gone. Pick it again.");
      const ids: string[] = e.type === "point" ? [t.entity] : e.type === "line" ? [e.a, e.b] : e.center ? [e.center] : [];
      for (const id of ids) {
        const q = s.data.entities[id] as Any;
        if (!q || q.type !== "point" || seen.has(`${t.feature}.${id}`)) continue;
        seen.add(`${t.feature}.${id}`);
        out.push({ key: id, frame: orient(onPlane(base, toWorld(s.frame, [q.x, q.y]))) });
      }
      continue;
    } else if (isGeomRef(t)) { key = t.name; pts = [pointOf(ctx, t, "place")]; }
    else if (t.kind === "datum") { key = t.feature; pts = [pointOf(ctx, t, "place")]; }
    else { key = t.plane; pts = [pointOf(ctx, t, "place")]; }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, frame: orient(onPlane(base, pts[0])) });
  }
  if (!out.length) throw ctx.fail("Pick sketch points, vertices or round edges to place this at.");
  return out;
}

/** Points of a rectangle `dx` by `dy` about the origin (one point when both are zero, two when one is). */
export function cornerPoints(dx: number, dy: number): V2[] {
  const xs = dx > EPS ? [-dx / 2, dx / 2] : [0], ys = dy > EPS ? [-dy / 2, dy / 2] : [0];
  return ys.flatMap((y) => xs.map((x) => [x, y] as V2));
}

// ---------------------------------------------------------------- cylinders

export interface CylinderFace {
  body: Body; name: string; face: Shape;
  /** the axis, from the end called `lo` to the one called `hi` */
  origin: Vec3; dir: Vec3; x: Vec3; radius: number;
  /** where the face starts and ends along the axis, from `origin` */
  lo: number; hi: number;
  /** a hole's wall (material outside it) rather than a shaft's */
  hole: boolean;
}

/** Whether a point is inside a solid (or on it). */
export function inside(ctx: EvalContext, solid: Shape, p: Vec3): boolean {
  const oc = ctx.oc as Any, k = ctx.k;
  const v = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(p)))).Vertex());
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(v); d.LoadS2(solid);
  d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  return d.IsDone() && (d.InnerSolution() || d.Value() < 1e-7);
}

/** A picked cylindrical face: its axis, radius, extent, and whether it is a hole or a shaft. */
export function cylinderOf(ctx: EvalContext, ref: RefTarget | null | undefined, what: string): CylinderFace {
  if (!ref || !isGeomRef(ref) || ref.kind !== "face") throw ctx.fail(`Pick ${what}.`);
  const r = ctx.resolve(ref);
  const info = faceInfo(ctx, r.shape);
  if (info.kind !== "cylinder" || !info.axis || !info.radius) throw ctx.fail(`Pick ${what}: that face is not cylindrical.`);
  // the axis runs towards +z (+y, +x) whichever way the surface was made, so `hi` is the top end on every rebuild
  const dir = canonical(normalize(info.axis.dir)), origin = info.axis.origin;
  let lo = Infinity, hi = -Infinity;
  for (const e of ctx.k.sub(r.shape, "edge")) {
    const ei = edgeInfo(ctx, e);
    for (const q of [ei.start, ei.end, ei.mid]) { const t = dot(sub(q, origin), dir); lo = Math.min(lo, t); hi = Math.max(hi, t); }
  }
  if (!(hi - lo > 1e-6)) throw ctx.fail(`Pick ${what}: that face has no length.`);
  const x = frameFromNormal(origin, dir).x;
  // a point just outside the wall, half way along: in the material for a hole, in the air for a shaft
  const mid = add(origin, scale(dir, (lo + hi) / 2));
  const c = ctx.k.centre(r.shape, "face");
  let out = sub(c, add(origin, scale(dir, dot(sub(c, origin), dir))));
  out = Math.hypot(out[0], out[1], out[2]) > 1e-6 ? normalize(out) : x;
  const eps = Math.max(1e-3, info.radius * 0.01);
  let hole = false;
  for (const turn of [0, 2.1, 4.2]) {
    const d = add(scale(out, Math.cos(turn)), scale(cross(dir, out), Math.sin(turn)));
    const q = add(mid, scale(d, info.radius));
    if (!onFace(ctx, r.shape, q)) continue;
    hole = inside(ctx, r.body.shape, add(mid, scale(d, info.radius + eps)));
    break;
  }
  return { body: r.body, name: r.name, face: r.shape, origin, dir, x, radius: info.radius, lo, hi, hole };
}

function onFace(ctx: EvalContext, face: Shape, p: Vec3): boolean {
  const oc = ctx.oc as Any, k = ctx.k;
  const v = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(p)))).Vertex());
  const d = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
  d.LoadS1(v); d.LoadS2(face);
  d.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  return d.IsDone() && d.Value() < 1e-5;
}

/** A tube (or a rod when `inner` is 0) about an axis, from `z0` to `z1` along it. */
export function tube(ctx: EvalContext, origin: Vec3, dir: Vec3, x: Vec3, inner: number, outer: number, z0: number, z1: number, prefix: string): NamedResult {
  const f: Frame = { origin, x, y: cross(dir, x), normal: dir };
  const pts: V2[] = [[inner, z0], [outer, z0], [outer, z1], [inner, z1]];
  return revolved(ctx, f, profile(pts, ["start", "outer", "end", inner > EPS ? "inner" : null]), prefix);
}

export { planeOf, pointOf };

// ---------------------------------------------------------------- putting tools into the model

/** The prefix of the names a feature gives what it builds at one place. */
export const prefixAt = (ctx: EvalContext, s: Spot): string => (s.key === "0" ? ctx.feature.id : `${ctx.feature.id}:${s.key}`);

/** New bodies, joined to the bodies they touch, or cut from them: what the Result field says. */
export function apply(ctx: EvalContext, tools: readonly Tool[], p: { operation?: string; targets?: string[] }, otherwise: Operation = "new"): void {
  combine(ctx, tools, (p.operation as Operation) || otherwise, p.targets);
}

export interface Drill { diameter: number; depth?: number; kind?: HoleKind; cboreDiameter?: number; cboreDepth?: number; csinkDiameter?: number; csinkAngle?: number; flat?: boolean; from?: number }

/**
 * The solid a hole removes, drilled at a place against its normal (into the surface).  Without a depth it goes
 * through everything in `through`.  Faces as the Hole feature names them: `<prefix>:wall`, `:floor`, `:cbore`, ….
 */
export function drill(ctx: EvalContext, f: Frame, d: Drill, prefix: string, through?: readonly Body[]): NamedResult {
  const at = add(f.origin, scale(f.normal, d.from || 0));
  const blind = !!d.depth && d.depth > 0;
  const depth = blind ? d.depth! : reachPast(ctx.k, (through || ctx.bodies()).map((b) => b.shape), at);
  return holeTool(ctx.k, {
    kind: d.kind || "simple", depth, through: !blind, tipAngle: d.flat === false ? 118 : 180,
    size: { diameter: d.diameter, cboreDiameter: d.cboreDiameter || 0, cboreDepth: d.cboreDepth || 0, csinkDiameter: d.csinkDiameter || 0, csinkAngle: d.csinkAngle || 90 },
  }, at, scale(f.normal, -1), f.x, prefix, ctx.own);
}
export { scoped };
export type { Tool };

/**
 * The same solid at every place: built once at the first (with the feature's id as its names' prefix) and moved
 * to the others, each copy's names carrying its place.
 */
export function copies(ctx: EvalContext, places: readonly Spot[], build: (f: Frame, prefix: string) => NamedResult): Tool[] {
  const id = ctx.feature.id;
  const first = build(places[0].frame, id);
  return places.map((s, i) => {
    const copy = i === 0 ? first : moved(ctx, first, { translate: sub(s.frame.origin, places[0].frame.origin) });
    const own = prefixAt(ctx, s);
    if (own === id) return { ...copy, suffix: s.key };
    return { shape: copy.shape, names: (face, n) => { const name = copy.names(face, n); return name === null ? null : name.startsWith(id) ? own + name.slice(id.length) : name; }, suffix: s.key };
  });
}
