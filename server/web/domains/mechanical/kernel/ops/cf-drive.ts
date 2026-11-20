// cf-drive.ts — what the power transmission features (features/cf-drive-*.ts: gears, pulleys, sprockets, cams,
// shafts, springs) share on the kernel side: a place to build in, outlines drawn from lines, arcs and splines,
// and the few solids they are made of (an extruded outline, an outline twisted along its axis, a revolved
// section, a loft between two outlines, a wire swept into a round bar), each with its faces named.
//
// Everything is drawn in the feature's own coordinates (x, y in its plane, z along the normal) and put into
// the model through a `Space`, so no shape is moved after it is made.
//
// Names: `<prefix>:bottom`, `<prefix>:top`, and `<prefix>:<label>` for the face each labelled curve of an
// outline sweeps.  The labels come from the feature (`t3:tip`, `bore`), so a face keeps its name while the
// tooth count stands.
import { add, cross, normalize, scale, type Frame, type Vec3 } from "../../core/geometry";
import { ShapeIndex, type NamedResult } from "../occ";
import type { EvalContext, Shape } from "../types";
import { arcThrough, segment, splineThrough } from "./curves";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type P2 = [number, number];

/** A right-handed place to build in: local (x, y, z) to the model's coordinates. */
export class Space {
  constructor(readonly o: Vec3, readonly x: Vec3, readonly y: Vec3, readonly z: Vec3) {}
  static of(f: Frame): Space { return new Space(f.origin, f.x, f.y, f.normal); }
  /** an axis and something to start the angle from: z along `dir` */
  static about(origin: Vec3, dir: Vec3, xHint?: Vec3): Space {
    const z = normalize(dir);
    let h: Vec3 = xHint && Math.hypot(...cross(z, xHint)) > 1e-6 ? xHint : Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const y = normalize(cross(z, h)); h = cross(y, z);
    return new Space(origin, h, y, z);
  }
  p(q: Vec3 | P2, z = 0): Vec3 {
    const w = q.length === 3 ? (q as Vec3)[2] : z;
    return [0, 1, 2].map((i) => this.o[i] + this.x[i] * q[0] + this.y[i] * q[1] + this.z[i] * w) as Vec3;
  }
  v(q: Vec3): Vec3 { return [0, 1, 2].map((i) => this.x[i] * q[0] + this.y[i] * q[1] + this.z[i] * q[2]) as Vec3; }
  /** the same directions, moved */
  at(q: Vec3): Space { return new Space(this.p(q), this.x, this.y, this.z); }
  /** turned about its own z (radians) */
  rotZ(a: number): Space {
    const c = Math.cos(a), s = Math.sin(a);
    return new Space(this.o, add(scale(this.x, c), scale(this.y, s)), add(scale(this.x, -s), scale(this.y, c)), this.z);
  }
  /** turned about its own y (radians): z leans towards x */
  rotY(a: number): Space {
    const c = Math.cos(a), s = Math.sin(a);
    return new Space(this.o, add(scale(this.x, c), scale(this.z, -s)), this.y, add(scale(this.x, s), scale(this.z, c)));
  }
  /** turned about its own x (radians): y leans towards z */
  rotX(a: number): Space {
    const c = Math.cos(a), s = Math.sin(a);
    return new Space(this.o, this.x, add(scale(this.y, c), scale(this.z, s)), add(scale(this.y, -s), scale(this.z, c)));
  }
}

/** One curve of an outline, from where the last ended: a line to `to`, an arc through `via`, or a spline through `pts` then `to`. */
export interface Seg { label: string; to: P2; via?: P2; pts?: P2[] }
/** A closed outline in the plane: curves end to end (the last ends on `start`), or one whole circle. */
export type Loop = { start: P2; segs: Seg[] } | { circle: { c: P2; r: number; label: string } } | { closed: { pts: P2[]; label: string } };

export const polar = (r: number, a: number): P2 => [r * Math.cos(a), r * Math.sin(a)];
export const rot2 = (p: P2, a: number): P2 => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
export const circleLoop = (r: number, label: string, c: P2 = [0, 0]): Loop => ({ circle: { c, r, label } });
/** A closed outline of straight lines through the points. */
export function polyLoop(pts: readonly P2[], label: string | ((i: number) => string)): Loop {
  const name = (i: number) => (typeof label === "string" ? `${label}${i + 1}` : label(i));
  return { start: pts[0], segs: pts.map((_, i) => ({ label: name(i), to: pts[(i + 1) % pts.length] })) };
}

/** Draws an outline curve by curve. */
export class Pen {
  readonly segs: Seg[] = [];
  private at: P2;
  constructor(readonly start: P2) { this.at = start; }
  get here(): P2 { return this.at; }
  private far(to: P2) { return Math.hypot(to[0] - this.at[0], to[1] - this.at[1]) > 1e-7; }
  line(to: P2, label: string): this { if (this.far(to)) { this.segs.push({ label, to }); this.at = to; } return this; }
  arc(via: P2, to: P2, label: string): this { if (this.far(to)) { this.segs.push({ label, to, via }); this.at = to; } return this; }
  /** an arc about `c` from here to `to`, the short way unless `ccw` says which */
  arcAbout(c: P2, to: P2, label: string, ccw?: boolean): this {
    if (!this.far(to)) return this;
    const a0 = Math.atan2(this.at[1] - c[1], this.at[0] - c[0]); let a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
    const r = Math.hypot(this.at[0] - c[0], this.at[1] - c[1]);
    if (ccw === undefined) { while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI; while (a1 - a0 < -Math.PI) a1 += 2 * Math.PI; }
    else if (ccw) { while (a1 <= a0) a1 += 2 * Math.PI; } else { while (a1 >= a0) a1 -= 2 * Math.PI; }
    if (Math.abs(a1 - a0) * r < 1e-6) return this.line(to, label);
    const am = (a0 + a1) / 2;
    return this.arc([c[0] + r * Math.cos(am), c[1] + r * Math.sin(am)], to, label);
  }
  spline(pts: readonly P2[], label: string): this {
    const all = pts.filter((p, i) => i === 0 ? this.far(p) : Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) > 1e-7);
    if (!all.length) return this;
    const to = all[all.length - 1];
    if (all.length === 1) return this.line(to, label);
    this.segs.push({ label, to, pts: all.slice(0, -1) }); this.at = to;
    return this;
  }
  /** curves drawn elsewhere, put here through `f` (a line joins them on when they start somewhere else) */
  append(start: P2, segs: readonly Seg[], f: (p: P2) => P2, label: (l: string) => string): this {
    this.line(f(start), label("join"));
    for (const s of segs) {
      const to = f(s.to);
      if (!this.far(to)) continue;
      this.segs.push({ label: label(s.label), to, ...(s.via ? { via: f(s.via) } : {}), ...(s.pts ? { pts: s.pts.map(f) } : {}) });
      this.at = to;
    }
    return this;
  }
  close(label: string): Loop {
    if (this.far(this.start)) this.line(this.start, label);
    else if (this.segs.length) this.segs[this.segs.length - 1].to = this.start;
    return { start: this.start, segs: this.segs };
  }
}

/** Are three points on one line (an arc through them would have no centre)? */
const straight = (a: P2, m: P2, b: P2) => Math.abs((m[0] - a[0]) * (b[1] - a[1]) - (m[1] - a[1]) * (b[0] - a[0])) < 1e-7 * Math.max(1e-6, (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);

export interface Labelled { label: string; edge: Shape }
export interface DrawnWire { wire: any; edges: Labelled[] }

/** An outline as a kernel wire at height `z` of a space. */
export function wireOf(ctx: EvalContext, sp: Space, loop: Loop, z = 0): DrawnWire {
  const oc = ctx.oc as any, k = ctx.k;
  const edges: Labelled[] = [];
  if ("circle" in loop) {
    const c = loop.circle;
    if (!(c.r > 0)) throw ctx.fail("A circle of the outline has no radius.");
    const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(sp.p(c.c, z))), ctx.tmp(k.dir(sp.z)), ctx.tmp(k.dir(sp.x))));
    const edge = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, c.r)))).Edge());
    edges.push({ label: c.label, edge });
  } else if ("closed" in loop) {
    edges.push({ label: loop.closed.label, edge: splineThrough(ctx, loop.closed.pts.map((q) => sp.p(q, z)), { closed: true }) });
  } else {
    let at = loop.start;
    for (const s of loop.segs) {
      const a = sp.p(at, z), b = sp.p(s.to, z);
      let edge: Shape;
      if (s.pts && s.pts.length) edge = splineThrough(ctx, [a, ...s.pts.map((q) => sp.p(q, z)), b]);
      else if (s.via && !straight(at, s.via, s.to)) edge = arcThrough(ctx, a, sp.p(s.via, z), b);
      else edge = segment(ctx, a, b);
      edges.push({ label: s.label, edge });
      at = s.to;
    }
  }
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  // the wire shares vertices between its edges, so it holds copies: the copy is the edge later history speaks of
  for (const e of edges) {
    mw.Add(oc.TopoDS.Edge(e.edge));
    if (!mw.IsDone()) throw ctx.fail("The outline could not be closed. Try other sizes.");
    e.edge = ctx.own(mw.Edge());
  }
  return { wire: ctx.own(mw.Wire()), edges };
}

/** A flat face from an outline and the holes in it. */
export function faceOf(ctx: EvalContext, sp: Space, outer: Loop, holes: readonly Loop[] = [], z = 0): { face: any; edges: Labelled[] } {
  const oc = ctx.oc as any;
  const o = wireOf(ctx, sp, outer, z);
  const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(o.wire, true));
  if (!mf.IsDone()) throw ctx.fail("The outline does not close into a face. Try other sizes.");
  const edges = [...o.edges];
  let face = ctx.own(mf.Face());
  // the outline may have been drawn clockwise: the face must look along +z
  const fr = ctx.k.faceFrame(face);
  const up = fr ? fr.normal[0] * sp.z[0] + fr.normal[1] * sp.z[1] + fr.normal[2] * sp.z[2] : 1;
  if (up < 0) face = ctx.own(oc.TopoDS.Face(face.Reversed()));
  if (holes.length) {
    const mh = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(face));
    for (const h of holes) {
      const w = wireOf(ctx, sp, h, z);
      // a hole runs the other way round its face than the outline
      const probe = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(w.wire, true));
      const pf = probe.IsDone() ? ctx.k.faceFrame(ctx.tmp(probe.Face())) : null;
      const same = pf ? pf.normal[0] * sp.z[0] + pf.normal[1] * sp.z[1] + pf.normal[2] * sp.z[2] > 0 : true;
      mh.Add(same ? oc.TopoDS.Wire(w.wire.Reversed()) : w.wire);
      edges.push(...w.edges);
    }
    if (!mh.IsDone()) throw ctx.fail("A hole could not be cut in the outline.");
    face = ctx.own(mh.Face());
  }
  return { face, edges };
}

/** An outline (with holes) extruded from height `z0` by `h` along z. */
export function prismOf(ctx: EvalContext, sp: Space, outer: Loop, holes: readonly Loop[], z0: number, h: number, prefix: string): NamedResult {
  const oc = ctx.oc as any, k = ctx.k;
  if (!(Math.abs(h) > 1e-9)) throw ctx.fail("The thickness must be more than zero.");
  const lo = h > 0 ? z0 : z0 + h, f = faceOf(ctx, sp, outer, holes, lo);
  const v = ctx.tmp(k.vec(scale(sp.z, Math.abs(h))));
  const mk = ctx.tmp(new oc.BRepPrimAPI_MakePrism(f.face, v, false, true));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("The outline could not be extruded.");
  const shape = ctx.own(mk.Shape());
  const named = new ShapeIndex<string>(k);
  named.add(ctx.own(mk.FirstShape()), `${prefix}:bottom`);
  named.add(ctx.own(mk.LastShape()), `${prefix}:top`);
  for (const e of f.edges) for (const s of k.list(mk.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.label}`);
  return { shape, names: (face) => named.get(face) ?? null };
}

/** A helix about a space's z: from angle `a0` at height `z0`, climbing `h` while turning by `turn` (radians, signed). */
export function helixWire(ctx: EvalContext, sp: Space, radius: number, z0: number, h: number, a0: number, turn: number): any {
  const oc = ctx.oc as any, k = ctx.k;
  const s = sp.rotZ(a0);
  const ax3 = ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(s.p([0, 0, z0]))), ctx.tmp(k.dir(s.z)), ctx.tmp(k.dir(s.x))));
  const surface = new oc.Geom_CylindricalSurface(ax3, radius);
  const line = new oc.Geom2d_Line(ctx.tmp(new oc.gp_Pnt2d(0, 0)), ctx.tmp(new oc.gp_Dir2d(turn, h)));
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, Math.hypot(turn, h)));
  if (!mk.IsDone()) throw ctx.fail("The helix could not be built.");
  const edge = ctx.own(mk.Edge());
  oc.BRepLib.BuildCurves3d(edge);
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
}

/** An outline turned about the origin (radians). */
export function turnLoop(loop: Loop, a: number): Loop {
  if (!a) return loop;
  if ("circle" in loop) return { circle: { ...loop.circle, c: rot2(loop.circle.c, a) } };
  if ("closed" in loop) return { closed: { ...loop.closed, pts: loop.closed.pts.map((q) => rot2(q, a)) } };
  return { start: rot2(loop.start, a), segs: loop.segs.map((s) => ({ label: s.label, to: rot2(s.to, a), ...(s.via ? { via: rot2(s.via, a) } : {}), ...(s.pts ? { pts: s.pts.map((q) => rot2(q, a)) } : {}) })) };
}

/**
 * An outline extruded along z while it turns about z: `steps` are (height, turn) pairs, one after another (two
 * of opposite turn make a herringbone).  The flanks are true helicoids: the outline is swept along the axis
 * with a helix beside it to say how far it has turned.  `holes` go straight through (a bore, a keyway).  The
 * solid is sewn from the swept sides, the holes' walls and the two flat ends, so no boolean is needed.
 */
export function twistOf(ctx: EvalContext, sp: Space, outer: Loop, holes: readonly Loop[], z0: number, steps: readonly { h: number; turn: number }[], guideRadius: number, prefix: string): NamedResult {
  const oc = ctx.oc as any, k = ctx.k;
  const total = steps.reduce((s, x) => s + x.h, 0);
  const faces: NamedFace[] = [];
  let z = z0, a = 0;
  steps.forEach((s, n) => {
    const spine = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(segment(ctx, sp.p([0, 0, z]), sp.p([0, 0, z + s.h]))))).Wire());
    const w = wireOf(ctx, sp, turnLoop(outer, a), z);
    const ps = ctx.tmp(new oc.BRepOffsetAPI_MakePipeShell(spine));
    ps.SetMode(helixWire(ctx, sp, guideRadius, z, s.h, a, s.turn), false, oc.BRepFill_TypeOfContact.BRepFill_NoContact);
    ps.Add(w.wire, false, false);
    try { ps.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The teeth could not be twisted (${k.describe(x)}). Try a smaller helix angle.`); }
    if (!ps.IsDone()) throw ctx.fail("The teeth could not be twisted. Try a smaller helix angle.");
    for (const e of w.edges) for (const f of k.list(ps.Generated(e.edge))) faces.push({ face: f, name: `${prefix}:${e.label}${n ? `:${n + 1}` : ""}` });
    z += s.h; a += s.turn;
  });
  for (const h of holes) faces.push(...wallOf(ctx, sp, h, z0, total, (l) => `${prefix}:${l}`));
  faces.push({ face: faceOf(ctx, sp, outer, holes, z0).face, name: `${prefix}:bottom` });
  faces.push({ face: faceOf(ctx, sp, turnLoop(outer, a), holes, z0 + total).face, name: `${prefix}:top` });
  return sewSolid(ctx, faces, "twisted teeth");
}

export interface NamedFace { face: Shape; name: string }

/** The walls an outline sweeps going up by `h` from height `z0` (no ends): a bore's wall, a hub's side. */
export function wallOf(ctx: EvalContext, sp: Space, loop: Loop, z0: number, h: number, name: (label: string) => string): NamedFace[] {
  const oc = ctx.oc as any, k = ctx.k;
  const w = wireOf(ctx, sp, loop, z0);
  const mk = ctx.tmp(new oc.BRepPrimAPI_MakePrism(w.wire, ctx.tmp(k.vec(scale(sp.z, h))), false, true));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("A wall could not be extruded.");
  const out: NamedFace[] = [];
  for (const e of w.edges) for (const f of k.list(mk.Generated(e.edge))) out.push({ face: f, name: name(e.label) });
  return out;
}

/** One layer of a stack: an outline extruded by `h`.  `size` says which of two neighbours is the wider (its outline holds the other's). */
export interface Layer { loop: Loop; h: number; size: number; name?: string }

/**
 * Layers stacked along z from `z0`, each an outline extruded by its height, with `holes` straight through all
 * of them (a bore with its keyway): a gear and its hub, a pulley between its flanges.  Sewn from its faces, so
 * no boolean is needed.  A layer's outline must lie wholly inside or wholly outside its neighbours'.
 * Names: `<prefix>:<layer>:<label>` for the walls, `:<layer>:bottom` / `:top` for the flat faces (no `<layer>:`
 * for a layer without a name), `<prefix>:<label>` for the holes' walls.
 */
export function stackOf(ctx: EvalContext, sp: Space, layers: readonly Layer[], holes: readonly Loop[], z0: number, prefix: string): NamedResult {
  const nm = (l: Layer, label: string) => (l.name ? `${prefix}:${l.name}:${label}` : `${prefix}:${label}`);
  const faces: NamedFace[] = [];
  let z = z0;
  layers.forEach((l, i) => {
    if (!(l.h > 1e-9)) throw ctx.fail("A thickness must be more than zero.");
    faces.push(...wallOf(ctx, sp, l.loop, z, l.h, (label) => nm(l, label)));
    if (i === 0) faces.push({ face: faceOf(ctx, sp, l.loop, holes, z).face, name: nm(l, "bottom") });
    z += l.h;
    const up = layers[i + 1];
    if (!up) faces.push({ face: faceOf(ctx, sp, l.loop, holes, z).face, name: nm(l, "top") });
    else if (up.size < l.size) faces.push({ face: faceOf(ctx, sp, l.loop, [up.loop], z).face, name: nm(l, "top") });
    else faces.push({ face: faceOf(ctx, sp, up.loop, [l.loop], z).face, name: nm(up, "bottom") });
  });
  for (const h of holes) faces.push(...wallOf(ctx, sp, h, z0, z - z0, (label) => `${prefix}:${label}`));
  return sewSolid(ctx, faces, "part");
}

/** A wire through points in space: each edge an arc through three points, or a smooth curve through more. */
export function wire3(ctx: EvalContext, sp: Space, edges: readonly { label: string; pts: readonly Vec3[]; arc?: boolean }[]): DrawnWire {
  const oc = ctx.oc as any;
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  const out: Labelled[] = [];
  for (const e of edges) {
    const w = e.pts.map((q) => sp.p(q));
    const edge = e.arc ? arcThrough(ctx, w[0], w[1], w[2]) : w.length === 2 ? segment(ctx, w[0], w[1]) : splineThrough(ctx, w);
    mw.Add(oc.TopoDS.Edge(edge));
    if (!mw.IsDone()) throw ctx.fail("An outline could not be closed. Try other sizes.");
    out.push({ label: e.label, edge: ctx.own(mw.Edge()) });
  }
  return { wire: ctx.own(mw.Wire()), edges: out };
}

/** The ruled faces between two wires drawn alike (the same curves in the same order), named after the first's curves. */
export function ruledBetween(ctx: EvalContext, a: DrawnWire, b: DrawnWire, name: (label: string) => string): NamedFace[] {
  const oc = ctx.oc as any, k = ctx.k;
  const ts = ctx.tmp(new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6));
  ts.CheckCompatibility(false);
  ts.AddWire(a.wire); ts.AddWire(b.wire);
  try { ts.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`A surface could not be laid between two outlines (${k.describe(x)}).`); }
  if (!ts.IsDone()) throw ctx.fail("A surface could not be laid between two outlines.");
  const out: NamedFace[] = [];
  for (const e of a.edges) for (const f of k.list(ts.Generated(e.edge))) out.push({ face: f, name: name(e.label) });
  return out;
}

/** One solid from faces that close a volume, each keeping its name. */
export function sewSolid(ctx: EvalContext, faces: readonly NamedFace[], what: string): NamedResult {
  const oc = ctx.oc as any, k = ctx.k;
  const sewing = ctx.tmp(new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false));
  for (const f of faces) sewing.Add(f.face);
  sewing.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  const shells = k.sub(ctx.own(sewing.SewedShape()), "shell");
  if (shells.length !== 1 || !oc.BRep_Tool.IsClosed(shells[0])) throw ctx.fail(`The ${what} did not close into a solid. Try other sizes.`);
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shells[0])));
  if (!mk.IsDone()) throw ctx.fail(`The ${what} did not close into a solid. Try other sizes.`);
  const shape = ctx.own(mk.Solid());
  oc.BRepLib.OrientClosedSolid(shape);
  const named = new ShapeIndex<string>(k);
  for (const f of faces) { named.add(f.face, f.name); if (sewing.IsModified(f.face)) named.add(ctx.own(sewing.Modified(f.face)), f.name); }
  return { shape, names: (f) => named.get(f) ?? null };
}

/**
 * A section in the half plane (radius, height) turned about z.  `pts` go round the section; `labels[i]` names
 * the face the edge from point i to point i + 1 sweeps.  `angle` (radians) for less than a whole turn.
 */
export function revolveOf(ctx: EvalContext, sp: Space, pts: readonly P2[], labels: readonly string[], prefix: string, angle?: number): NamedResult {
  const loop: Loop = { start: pts[0], segs: pts.map((_, i) => ({ label: labels[i] ?? `s${i + 1}`, to: pts[(i + 1) % pts.length] })).filter((s, i) => Math.hypot(s.to[0] - pts[i][0], s.to[1] - pts[i][1]) > 1e-7) };
  return revolveLoop(ctx, sp, loop, prefix, angle);
}

/** The same for a section drawn as an outline (it may have arcs): x is the radius, y the height. */
export function revolveLoop(ctx: EvalContext, sp: Space, loop: Loop, prefix: string, angle?: number): NamedResult {
  const oc = ctx.oc as any, k = ctx.k;
  // the section is drawn in the space's x–z plane
  const flat = new Space(sp.o, sp.x, sp.z, scale(sp.y, -1));
  const f = faceOf(ctx, flat, loop);
  const ax = ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(sp.o)), ctx.tmp(k.dir(sp.z))));
  const mk = ctx.tmp(angle === undefined ? new oc.BRepPrimAPI_MakeRevol(f.face, ax, true) : new oc.BRepPrimAPI_MakeRevol(f.face, ax, angle, true));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("The section could not be turned into a solid.");
  let shape = ctx.own(mk.Shape());
  if (k.volume(shape) < 0) shape = ctx.own(shape.Reversed());
  const named = new ShapeIndex<string>(k);
  if (angle !== undefined) { named.add(ctx.own(mk.FirstShape()), `${prefix}:start`); named.add(ctx.own(mk.LastShape()), `${prefix}:end`); }
  for (const e of f.edges) for (const s of k.list(mk.Generated(e.edge))) if (!named.has(s)) named.add(s, `${prefix}:${e.label}`);
  return { shape, names: (face) => named.get(face) ?? null };
}

/**
 * One smooth curve through many points, as several edges end to end (the sweep that follows it works edge by
 * edge, and gives up on a single edge that goes round too many times).  The edges are pieces of one curve, so
 * they join without a kink.
 */
function longSpline(ctx: EvalContext, pts: readonly Vec3[], per = 40): Shape[] {
  const oc = ctx.oc as any, k = ctx.k;
  const arr = ctx.tmp(new oc.NCollection_Array1_gp_Pnt(1, pts.length));
  pts.forEach((q, i) => arr.SetValue(i + 1, ctx.tmp(k.pnt(q))));
  const ip = ctx.tmp(new oc.GeomAPI_Interpolate(ctx.tmp(new oc.NCollection_HArray1_gp_Pnt(arr)), false, 1e-6));
  try { ip.Perform(); } catch (x) { throw ctx.fail(`The wire's path could not be drawn (${k.describe(x)}).`); }
  if (!ip.IsDone()) throw ctx.fail("The wire's path could not be drawn.");
  const curve = ip.Curve(), u0 = curve.FirstParameter(), u1 = curve.LastParameter();
  const n = Math.max(1, Math.ceil((pts.length - 1) / per)), out: Shape[] = [];
  for (let i = 0; i < n; i++) {
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(curve, u0 + ((u1 - u0) * i) / n, u0 + ((u1 - u0) * (i + 1)) / n));
    if (!mk.IsDone()) throw ctx.fail("The wire's path could not be drawn.");
    out.push(ctx.own(mk.Edge()));
  }
  return out;
}

/**
 * A round bar along a path (local coordinates): a spring's wire.  The path is one or more pieces end to end,
 * each a list of points: two make a straight piece, more a smooth curve through them, which leaves and arrives
 * along its straight neighbours.
 */
export function barAlong(ctx: EvalContext, sp: Space, pieces: readonly (readonly Vec3[])[], radius: number, prefix: string): NamedResult {
  const oc = ctx.oc as any, k = ctx.k;
  const world = pieces.map((pc) => pc.map((q) => sp.p(q)));
  const dirOf = (pc: Vec3[], atEnd: boolean): Vec3 => { const a = atEnd ? pc[pc.length - 2] : pc[0], b = atEnd ? pc[pc.length - 1] : pc[1]; return normalize([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); };
  const gap = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
  let first: Shape | null = null;
  world.forEach((pc, i) => {
    let edges: Shape[];
    if (pc.length === 2) edges = [segment(ctx, pc[0], pc[1])];
    else {
      // beside a straight piece the curve gets a point just inside its end, on the straight piece's line, so it leaves along that line
      const pts = pc.slice();
      if (i < world.length - 1 && world[i + 1].length === 2) { const t = dirOf(world[i + 1], false), e = pts[pts.length - 1], h = gap(pts[pts.length - 2], e) * 0.2; pts.splice(pts.length - 1, 0, [e[0] - t[0] * h, e[1] - t[1] * h, e[2] - t[2] * h]); }
      if (i > 0 && world[i - 1].length === 2) { const t = dirOf(world[i - 1], true), b = pts[0], h = gap(b, pts[1]) * 0.2; pts.splice(1, 0, [b[0] + t[0] * h, b[1] + t[1] * h, b[2] + t[2] * h]); }
      edges = longSpline(ctx, pts);
    }
    if (!first) first = edges[0];
    for (const e of edges) { mw.Add(oc.TopoDS.Edge(e)); if (!mw.IsDone()) throw ctx.fail("The wire's path could not be joined up."); }
  });
  const spine = ctx.own(mw.Wire());
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(first!)));
  const p0 = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), d1 = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  ad.D1(ad.FirstParameter(), p0, d1);
  const tan = Math.hypot(d1.X(), d1.Y(), d1.Z()) > 1e-9 ? normalize(k.xyz(d1)) : dirOf(world[0], false);
  const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(world[0][0])), ctx.tmp(k.dir(tan))));
  const ce = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(new oc.gp_Circ(ax, radius)))).Edge());
  const cw = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(ce)).Wire());
  const cf = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeFace(cw, true)).Face());
  let mk: any;
  try { mk = ctx.tmp(new oc.BRepOffsetAPI_MakePipe(spine, cf)); mk.Build(ctx.tmp(new oc.Message_ProgressRange())); } catch (x) { throw ctx.fail(`The wire could not be swept (${k.describe(x)}). Try a thinner wire or a larger coil.`); }
  if (!mk.IsDone()) throw ctx.fail("The wire could not be swept. Try a thinner wire or a larger coil.");
  let shape = ctx.own(mk.Shape());
  if (k.volume(shape) < 0) shape = ctx.own(shape.Reversed());
  const named = new ShapeIndex<string>(k);
  named.add(ctx.own(mk.FirstShape()), `${prefix}:start`); named.add(ctx.own(mk.LastShape()), `${prefix}:end`);
  return { shape, names: (f) => named.get(f) ?? `${prefix}:wire` };
}

/** A boolean of two named results. */
export function bool(ctx: EvalContext, op: "fuse" | "cut" | "common", a: NamedResult, b: NamedResult): NamedResult {
  const k = ctx.k, id = ctx.feature.id;
  const r = k.boolean(op, { shape: a.shape, faces: k.namedFaces(a.shape, a.names, id) }, { shape: b.shape, faces: k.namedFaces(b.shape, b.names, id) }, id, ctx.own);
  return r;
}

/** Several named results as one tool (a compound: they must not overlap), for one cut instead of many. */
export function together(ctx: EvalContext, parts: readonly NamedResult[]): NamedResult {
  if (parts.length === 1) return parts[0];
  const oc = ctx.oc as any;
  const c = ctx.own(new oc.TopoDS_Compound()), b = ctx.tmp(new oc.TopoDS_Builder());
  b.MakeCompound(c);
  for (const p of parts) b.Add(c, p.shape);
  return { shape: c, names: (f, i) => { for (const p of parts) { const n = p.names(f, i); if (n !== null) return n; } return null; } };
}

/** The one solid of a result, or a failure a person can read. */
export function oneSolid(ctx: EvalContext, r: NamedResult, what: string): NamedResult {
  const s = ctx.k.solids(r.shape);
  if (!s.length || !(ctx.k.volume(r.shape) > 1e-9)) throw ctx.fail(`The ${what} came out empty. Try other sizes.`);
  return s.length === 1 ? { shape: s[0], names: r.names } : r;
}

/** Is this cylindrical face the wall of a hole (material outside it) rather than of a shaft?  `axis` is a point on its axis. */
export function isBore(ctx: EvalContext, face: Shape, axis: Vec3): boolean {
  const oc = ctx.oc as any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true));
  const u = (ad.FirstUParameter() + ad.LastUParameter()) / 2, v = (ad.FirstVParameter() + ad.LastVParameter()) / 2;
  const p = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), du = ctx.tmp(new oc.gp_Vec(0, 0, 0)), dv = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  ad.D1(u, v, p, du, dv);
  // the surface's normal, turned to point out of the material
  let n = cross(k.xyz(du), k.xyz(dv));
  if (face.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = scale(n, -1);
  const at = k.xyz(p), out: Vec3 = [at[0] - axis[0], at[1] - axis[1], at[2] - axis[2]];
  return n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0;
}
