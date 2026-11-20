// sheetmetal.ts — the sheet metal model: what a sheet metal part is, how its solid is built from that, and how
// it is laid flat.
//
// A sheet metal part is not kept as a solid.  It is a definition: flat WALLS (each a planar face in its own
// plane coordinates, z = 0, the material from z = 0 to z = thickness) joined by BENDS (a straight line on each
// of the two walls it joins, an angle, an inside radius, a K-factor).  One wall of every connected piece has a
// place in the model (a root); every other wall's place follows through the bends.  From that one definition
// come both
//   • the 3D part: every wall extruded by the thickness and moved to its place, every bend a rectangle turned
//     about the bend's axis, all fused into one body; and
//   • the flat pattern: the same walls with every bend replaced by its allowance, (radius + K·thickness)·angle.
// The sheet metal features (features/sm-*.ts) each change the definition (kernel/ops/sheetmetal-ops.ts) and
// build the body again, so the part and its flat pattern cannot disagree.
//
// What other features do to the body afterwards (a hole, a cut) is read back into the walls the next time the
// definition is used (`absorb`): the material removed is cut out of the walls it passes through.  Material
// added by other features, and cuts across a bend, are not carried into the definition.
//
// Names: a wall's faces are `<model>:<wall>:bottom` (z = 0), `:top`, and `:side@<direction>:<offset>` (a flat
// edge face, by the line it lies on in the wall's plane) or `:side@c<x>,<y>` (a curved one, by its centre); a
// bend's are `<model>:<bend>:in`, `:out`, `:end` and, for a bend with nothing after it, `:tip`.
import type { Vec2, Vec3 } from "../../core/geometry";
import type { Kernel, Keep, NamedResult } from "../occ";
import { ShapeIndex } from "../occ";
import { FeatureError, type EvalContext, type NamedShape, type Shape } from "../types";
import { distance } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

// ------------------------------------------------------------------ rigid motions, as 3×4 row-major matrices
export type Mat = number[];
export const IDENT: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function mmul(a: Mat, b: Mat): Mat {
  const o = new Array<number>(12);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
  return o;
}
export function minv(a: Mat): Mat {
  const t = [a[3], a[7], a[11]];
  const o = [a[0], a[4], a[8], 0, a[1], a[5], a[9], 0, a[2], a[6], a[10], 0];
  for (let r = 0; r < 3; r++) o[r * 4 + 3] = -(o[r * 4] * t[0] + o[r * 4 + 1] * t[1] + o[r * 4 + 2] * t[2]);
  return o;
}
export const mpt = (m: Mat, p: Vec3): Vec3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
export const mvec = (m: Mat, p: Vec3): Vec3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[4] * p[0] + m[5] * p[1] + m[6] * p[2], m[8] * p[0] + m[9] * p[1] + m[10] * p[2]];
export const mframe = (o: Vec3, x: Vec3, y: Vec3, z: Vec3): Mat => [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]];
export const mtrans = (x: number, y: number, z: number): Mat => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const mrotx = (a: number): Mat => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
export const rad = (deg: number): number => (deg * Math.PI) / 180;

// ------------------------------------------------------------------ the definition
/** A straight line on a wall, from p0 to p1 in the wall's plane, with the wall's material on its left. */
export interface Side { wall: string; p0: Vec2; p1: Vec2 }
export interface SMWall { id: string; /** a planar face in the wall's own plane (z = 0) */ face: Shape }
export interface SMBend {
  id: string; a: Side;
  /** the wall bent up from `a`; null for a bend with nothing after it (a rolled hem) */
  b: Side | null;
  /** degrees; positive bends towards wall a's +z (its top), negative towards its bottom */
  angle: number;
  /** inside radius */
  radius: number;
  k: number;
}
export interface SMForm { id: string; wall: string; at: Vec2; /** degrees, in the wall's plane */ turn: number; up: boolean; type: "dimple" | "louver"; size: number; width: number; height: number }
export interface SMModel {
  id: string; name: string;
  thickness: number; radius: number; k: number; gap: number;
  relief: { type: "rectangle" | "obround" | "tear"; width: number; depth: number };
  walls: SMWall[]; bends: SMBend[]; forms: SMForm[];
  /** the place of one wall of each connected piece: wall id → its plane in the model */
  roots: { [wall: string]: Mat };
  /** root wall → the body built from that piece, and the shape that was built (to see what others did to it since) */
  bodies: { [wall: string]: string };
  built: { [body: string]: Shape };
  finished: boolean;
  /** counts the walls, bends and forms made, for their ids */
  seq: number;
}
export const EXTRA = "sheetmetal";
export type SMStore = { [model: string]: SMModel };

export const wallOf = (m: SMModel, id: string): SMWall => { const w = m.walls.find((x) => x.id === id); if (!w) throw new FeatureError("A wall of the sheet metal model is missing."); return w; };
export const withWall = (m: SMModel, w: SMWall): SMModel => ({ ...m, walls: m.walls.map((x) => (x.id === w.id ? w : x)) });
/** The length of a bend's developed arc: what it measures in the flat pattern. */
export const allowance = (m: SMModel, b: SMBend): number => Math.abs(rad(b.angle)) * (b.radius + b.k * m.thickness);
/** How far the outside faces of two walls joined at `angle` reach past where the bend starts (the outside setback). */
export function setback(angle: number, radius: number, thickness: number, outside = true): number {
  const a = Math.min(Math.abs(angle), 90);
  return (radius + (outside ? thickness : 0)) * Math.tan(rad(a) / 2);
}

/** The frame of a side: origin at p1, x back along the line, y out of the wall, z up; and the line's length. */
export function sideFrame(s: Side): { m: Mat; L: number } {
  const L = Math.hypot(s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]) || 1e-9;
  const dx = (s.p1[0] - s.p0[0]) / L, dy = (s.p1[1] - s.p0[1]) / L;
  return { m: mframe([s.p1[0], s.p1[1], 0], [-dx, -dy, 0], [dy, -dx, 0], [0, 0, 1]), L };
}
/** The height of a bend's axis in its side frame. */
const axisZ = (m: SMModel, b: SMBend): number => m.thickness / 2 + Math.sign(b.angle || 1) * (b.radius + m.thickness / 2);
/** The frame at the far end of a bend, in wall a's coordinates: the next wall starts there and runs along +y. */
export function bendEnd(m: SMModel, b: SMBend, flat: boolean): Mat {
  const A = sideFrame(b.a), zc = axisZ(m, b);
  const mid = flat ? mtrans(0, allowance(m, b), 0) : mmul(mmul(mtrans(0, 0, zc), mrotx(rad(b.angle))), mtrans(0, 0, -zc));
  return mmul(A.m, mid);
}
/** Wall b's coordinates in wall a's, through the bend (as built, or laid flat). */
export function link(m: SMModel, b: SMBend, flat: boolean): Mat {
  const A = sideFrame(b.a), B = sideFrame(b.b!);
  return mmul(mmul(bendEnd(m, b, flat), [-1, 0, 0, A.L, 0, -1, 0, 0, 0, 0, 1, 0]), minv(B.m));
}

/** Where every wall is (in the model, or in its piece's flat pattern), and which piece (root) it belongs to. */
export function placements(m: SMModel, flat = false): { mat: Map<string, Mat>; root: Map<string, string> } {
  const mat = new Map<string, Mat>(), root = new Map<string, string>();
  for (const r of Object.keys(m.roots)) {
    mat.set(r, flat ? IDENT : m.roots[r]); root.set(r, r);
    const todo = [r];
    while (todo.length) {
      const at = todo.pop()!;
      for (const b of m.bends) {
        if (!b.b) continue;
        const next = b.a.wall === at ? b.b.wall : b.b.wall === at ? b.a.wall : null;
        if (!next || mat.has(next)) continue;
        const l = link(m, b, flat);
        mat.set(next, mmul(mat.get(at)!, b.a.wall === at ? l : minv(l))); root.set(next, r);
        todo.push(next);
      }
    }
  }
  return { mat, root };
}

// ------------------------------------------------------------------ kernel helpers
export function xform(k: Kernel, shape: Shape, m: Mat, keep: Keep): Shape {
  const oc = k.oc as Any;
  const t = new oc.gp_Trsf();
  t.SetValues(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11]);
  const mk = new oc.BRepBuilderAPI_Transform(shape, t, true, false);
  const out = keep(mk.Shape());
  mk.delete(); t.delete();
  return out;
}
/** A flat face through 3D points. */
export function polyFace(k: Kernel, pts: readonly Vec3[], keep: Keep): Shape {
  const oc = k.oc as Any;
  const mw = new oc.BRepBuilderAPI_MakeWire();
  const P = pts.map((p) => k.pnt(p));
  for (let i = 0; i < pts.length; i++) { const me = new oc.BRepBuilderAPI_MakeEdge(P[i], P[(i + 1) % pts.length]); const e = me.Edge(); mw.Add(e); e.delete(); me.delete(); }
  const w = mw.Wire(), mf = new oc.BRepBuilderAPI_MakeFace(w, true);
  if (!mf.IsDone()) { mf.delete(); w.delete(); mw.delete(); throw new FeatureError("A flat outline could not be made into a face."); }
  const f = keep(mf.Face());
  mf.delete(); w.delete(); mw.delete(); P.forEach((p) => p.delete());
  return f;
}
export const poly2 = (k: Kernel, pts: readonly Vec2[], keep: Keep): Shape => polyFace(k, pts.map((p): Vec3 => [p[0], p[1], 0]), keep);
export function circleFace(k: Kernel, c: Vec3, normal: Vec3, r: number, keep: Keep): Shape {
  const oc = k.oc as Any;
  const p = k.pnt(c), d = k.dir(normal), ax = new oc.gp_Ax2(p, d), circ = new oc.gp_Circ(ax, r);
  const me = new oc.BRepBuilderAPI_MakeEdge(circ), e = me.Edge(), mw = new oc.BRepBuilderAPI_MakeWire(e), w = mw.Wire(), mf = new oc.BRepBuilderAPI_MakeFace(w, true);
  const f = keep(mf.Face());
  for (const o of [mf, w, mw, e, me, circ, ax, d, p]) o.delete();
  return f;
}
/** A boolean without names (walls in their planes, tools). */
export function bool(k: Kernel, op: "fuse" | "cut" | "common", a: Shape, b: Shape, keep: Keep): Shape {
  const oc = k.oc as Any;
  const range = new oc.Message_ProgressRange();
  const Algo = op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const algo = new Algo(a, b, range);
  range.delete();
  try {
    algo.Build();
    if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError("The sheet metal outline could not be worked out.");
    algo.SimplifyResult(true, true, 1e-4);
    return keep(algo.Shape());
  } finally { algo.delete(); }
}
export function area(k: Kernel, face: Shape): number {
  const oc = k.oc as Any, g = new oc.GProp_GProps();
  oc.BRepGProp.SurfaceProperties(face, g, false, false);
  const v = g.Mass(); g.delete();
  return v;
}
/** Is a point of a wall's plane on its face (edges count)? */
export function inside(k: Kernel, face: Shape, p: Vec2): boolean {
  const oc = k.oc as Any;
  const pt = k.pnt([p[0], p[1], 0]), mv = new oc.BRepBuilderAPI_MakeVertex(pt), v = mv.Vertex();
  try { return distance(k, v, face) < 1e-6; } finally { v.delete(); mv.delete(); pt.delete(); }
}
/** The straight edges of a wall's face, as point pairs. */
export function straightEdges(k: Kernel, face: Shape): [Vec2, Vec2][] {
  const oc = k.oc as Any, out: [Vec2, Vec2][] = [];
  for (const e of k.sub(face, "edge")) {
    const ad = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e));
    try {
      if (ad.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) continue;
      const a = ad.Value(ad.FirstParameter()), b = ad.Value(ad.LastParameter());
      out.push([[a.X(), a.Y()], [b.X(), b.Y()]]);
      a.delete(); b.delete();
    } finally { ad.delete(); }
  }
  return out;
}
const TOL = 1e-4;
const distToSeg = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1e-18;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
};
/** The straight edge of a wall that a point lies on, as a side (the wall on its left), or null. */
export function sideAt(k: Kernel, w: SMWall, p: Vec2, along?: Vec2): Side | null {
  for (const [a, b] of straightEdges(k, w.face)) {
    if (distToSeg(p, a, b) > TOL) continue;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < TOL) continue;
    const d: Vec2 = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    if (along && Math.abs(along[0] * d[1] - along[1] * d[0]) > 1e-3) continue;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], e = Math.min(0.01, L / 10);
    return inside(k, w.face, [mid[0] - d[1] * e, mid[1] + d[0] * e]) ? { wall: w.id, p0: a, p1: b } : { wall: w.id, p0: b, p1: a };
  }
  return null;
}
/** One face out of a boolean's result: the largest (a cut that leaves crumbs keeps the wall). */
export function oneFace(k: Kernel, shape: Shape, what = "A wall of the sheet metal part would be cut away."): Shape {
  const faces = k.sub(shape, "face");
  if (!faces.length) throw new FeatureError(what);
  let best = faces[0], most = -1;
  if (faces.length > 1) for (const f of faces) { const a = area(k, f); if (a > most) { most = a; best = f; } }
  return best;
}

// ------------------------------------------------------------------ building the 3D part
const r2 = (v: number): number => { const x = Math.round(v * 100) / 100; return Object.is(x, -0) ? 0 : x; };

function wallSolid(k: Kernel, m: SMModel, w: SMWall, W: Mat, keep: Keep): NamedShape[] & { shape?: Shape } {
  const oc = k.oc as Any, t = m.thickness;
  const placed = xform(k, w.face, W, keep);
  const v = k.vec(mvec(W, [0, 0, t]));
  const prism = keep(new oc.BRepPrimAPI_MakePrism(placed, v, false, true));
  v.delete();
  prism.Build();
  if (!prism.IsDone()) throw new FeatureError("A wall of the sheet metal part could not be thickened.");
  const shape: Shape = keep(prism.Shape()), bottom = keep(prism.FirstShape()), top = keep(prism.LastShape());
  const inv = minv(W), pre = `${m.id}:${w.id}`;
  const faces = k.sub(shape, "face"), names: (string | null)[] = faces.map((f) => {
    if (f.IsSame(bottom)) return `${pre}:bottom`;
    if (f.IsSame(top)) return `${pre}:top`;
    const c = mpt(inv, k.centre(f, "face")), fr = k.faceFrame(f as Any);
    if (!fr) return `${pre}:side@c${r2(c[0])},${r2(c[1])}`;
    const n = mvec(inv, fr.normal);
    return `${pre}:side@${r2((Math.atan2(n[1], n[0]) * 180) / Math.PI)}:${r2(c[0] * n[0] + c[1] * n[1])}`;
  });
  k.settleNames(faces, names, `${pre}:side`, "face");
  const out: NamedShape[] & { shape?: Shape } = faces.map((f, i) => ({ name: names[i]!, shape: f }));
  out.shape = shape;
  return out;
}

function bendSolid(k: Kernel, m: SMModel, b: SMBend, WA: Mat, keep: Keep): NamedShape[] & { shape?: Shape } {
  const oc = k.oc as Any, t = m.thickness;
  const A = sideFrame(b.a), W = mmul(WA, A.m), zc = axisZ(m, b);
  const profile = polyFace(k, [[0, 0, 0], [A.L, 0, 0], [A.L, 0, t], [0, 0, t]].map((p) => mpt(W, p as Vec3)), keep);
  const up = b.angle >= 0;
  const o = k.pnt(mpt(W, [0, 0, zc])), d = k.dir(mvec(W, [up ? 1 : -1, 0, 0])), ax = new oc.gp_Ax1(o, d);
  const rev = keep(new oc.BRepPrimAPI_MakeRevol(profile, ax, Math.abs(rad(b.angle)), true));
  ax.delete(); d.delete(); o.delete();
  rev.Build();
  if (!rev.IsDone()) throw new FeatureError("A bend could not be built. Try a larger bend radius.");
  const shape: Shape = keep(rev.Shape()), first = keep(rev.FirstShape()), last = keep(rev.LastShape());
  const pre = `${m.id}:${b.id}`;
  const faces = k.sub(shape, "face"), names: (string | null)[] = faces.map((f) => {
    if (f.IsSame(first)) return `${pre}:start`;
    if (f.IsSame(last)) return `${pre}:tip`;
    const ad = new oc.BRepAdaptor_Surface(f, true);
    try {
      if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) return `${pre}:end`;
      const cyl = ad.Cylinder(), r = cyl.Radius(); cyl.delete();
      return Math.abs(r - b.radius) < Math.abs(r - b.radius - t) ? `${pre}:in` : `${pre}:out`;
    } finally { ad.delete(); }
  });
  k.settleNames(faces, names, `${pre}:end`, "face");
  const out: NamedShape[] & { shape?: Shape } = faces.map((f, i) => ({ name: names[i]!, shape: f }));
  out.shape = shape;
  return out;
}

/** The solids a form adds to and removes from its wall, in the wall's coordinates turned to the model by W. */
function formTools(k: Kernel, m: SMModel, f: SMForm, W: Mat, keep: Keep): { add: Shape; cut: Shape } {
  const oc = k.oc as Any, t = m.thickness;
  // the form's own frame: x along it, z the way it stands out; a form on the bottom is the same thing turned over
  const c = Math.cos(rad(f.turn)), s = Math.sin(rad(f.turn));
  const F = mmul(W, f.up ? mframe([f.at[0], f.at[1], t], [c, s, 0], [-s, c, 0], [0, 0, 1]) : mframe([f.at[0], f.at[1], 0], [c, s, 0], [s, -c, 0], [0, 0, -1]));
  const h = f.height;
  if (f.type === "dimple") {
    const R = f.size / 2, top = Math.max(R * 0.2, R - h * Math.tan(rad(30)));
    const cone = (z0: number): Shape => {
      const prof = polyFace(k, [[0, 0, z0], [R, 0, z0], [top, 0, z0 + h], [0, 0, z0 + h]].map((p) => mpt(F, p as Vec3)), keep);
      const o = k.pnt(mpt(F, [0, 0, 0])), d = k.dir(mvec(F, [0, 0, 1])), ax = new oc.gp_Ax1(o, d);
      const rev = new oc.BRepPrimAPI_MakeRevol(prof, ax, true);
      const out = keep(rev.Shape());
      rev.delete(); ax.delete(); d.delete(); o.delete();
      return out;
    };
    return { add: cone(0), cut: cone(-t) };
  }
  // a louver: a ramp `width` long that rises to `height` and is open at its high end, `size` wide
  const L = f.size / 2, w = f.width;
  const wedge = (z0: number): Shape => {
    const prof = polyFace(k, [[-L, 0, z0], [-L, w, z0], [-L, w, z0 + h]].map((p) => mpt(F, p as Vec3)), keep);
    const v = k.vec(mvec(F, [f.size, 0, 0]));
    const pr = new oc.BRepPrimAPI_MakePrism(prof, v, false, true);
    const out = keep(pr.Shape());
    pr.delete(); v.delete();
    return out;
  };
  return { add: wedge(0), cut: wedge(-t) };
}

/** The solid of every connected piece of a model, by its root wall. */
export function buildPieces(k: Kernel, m: SMModel, keep: Keep): Map<string, NamedResult> {
  const { mat, root } = placements(m);
  const out = new Map<string, NamedResult>();
  for (const r of Object.keys(m.roots)) {
    const parts: (NamedShape[] & { shape?: Shape })[] = [];
    for (const w of m.walls) if (root.get(w.id) === r) parts.push(wallSolid(k, m, w, mat.get(w.id)!, keep));
    for (const b of m.bends) if (root.get(b.a.wall) === r) parts.push(bendSolid(k, m, b, mat.get(b.a.wall)!, keep));
    if (!parts.length) continue;
    let acc: { shape: Shape; faces: NamedShape[] } = { shape: parts[0].shape!, faces: parts[0] };
    for (let i = 1; i < parts.length; i++) {
      const res = k.boolean("fuse", acc, { shape: parts[i].shape!, faces: parts[i] }, m.id, keep);
      acc = { shape: res.shape, faces: k.namedFaces(res.shape, res.names, m.id) };
    }
    for (const f of m.forms) {
      if (root.get(f.wall) !== r) continue;
      const tools = formTools(k, m, f, mat.get(f.wall)!, keep);
      const tag = (s: Shape, what: string): { shape: Shape; faces: NamedShape[] } => ({ shape: s, faces: k.namedFaces(s, () => `${m.id}:${f.id}:${what}`, m.id) });
      let res = k.boolean("fuse", acc, tag(tools.add, "out"), m.id, keep);
      acc = { shape: res.shape, faces: k.namedFaces(res.shape, res.names, m.id) };
      res = k.boolean("cut", acc, tag(tools.cut, "in"), m.id, keep);
      acc = { shape: res.shape, faces: k.namedFaces(res.shape, res.names, m.id) };
    }
    const solids = k.solids(acc.shape);
    const index = new ShapeIndex<string>(k);
    for (const f of acc.faces) index.add(f.shape, f.name);
    out.set(r, { shape: solids.length === 1 ? solids[0] : acc.shape, names: (f) => index.get(f) ?? null });
  }
  return out;
}

// ------------------------------------------------------------------ the store, and a feature's way in and out
export const storeOf = (ctx: EvalContext): SMStore => ctx.extra<SMStore>(EXTRA) || {};

/** Build a model's bodies again and keep the model: what every sheet metal feature ends with. */
export function commit(ctx: EvalContext, model: SMModel): SMModel {
  const pieces = buildPieces(ctx.k, model, ctx.own);
  const bodies: SMModel["bodies"] = {}, built: SMModel["built"] = {};
  const roots = Object.keys(model.roots);
  for (const [wall, id] of Object.entries(model.bodies)) if (!pieces.has(wall)) { const gone = ctx.body(id); if (gone) ctx.removeBody(gone); }
  roots.forEach((r, i) => {
    const piece = pieces.get(r);
    if (!piece) return;
    const old = model.bodies[r] ? ctx.body(model.bodies[r]) : undefined;
    const body = old ? ctx.replaceBody(old, piece.shape, piece.names) : ctx.addBody(piece.shape, piece.names, { suffix: i || ctx.feature.id !== model.id ? r.replace(/[^\w.-]/g, "_") : undefined, });
    bodies[r] = body.id; built[body.id] = body.shape;
  });
  const next = { ...model, bodies, built };
  ctx.setExtra(EXTRA, { ...storeOf(ctx), [model.id]: next });
  return next;
}

/** The model a body belongs to, with whatever other features did to the body since read into its walls. */
export function modelOfBody(ctx: EvalContext, bodyId: string, forEdit = true): SMModel {
  const m = Object.values(storeOf(ctx)).find((x) => Object.values(x.bodies).includes(bodyId));
  if (!m) throw ctx.fail("That part is not sheet metal. Start with Sheet metal model.");
  if (forEdit && m.finished) throw ctx.fail(`${m.name} is finished (Finish sheet metal model). Move this feature above the finish, or delete the finish.`);
  return absorb(ctx.k, m, (id) => ctx.body(id)?.shape, ctx.own);
}
export function modelById(ctx: EvalContext, id: string): SMModel {
  const m = storeOf(ctx)[id];
  if (!m) throw ctx.fail("The sheet metal model this feature belongs to is missing, suppressed or failed.");
  if (m.finished) throw ctx.fail(`${m.name} is finished (Finish sheet metal model). Move this feature above the finish, or delete the finish.`);
  return absorb(ctx.k, m, (b) => ctx.body(b)?.shape, ctx.own);
}

/**
 * Read what other features removed from a model's bodies back into its walls: the material missing from a body
 * since the model last built it is cut out of every wall it passes through.
 */
export function absorb(k: Kernel, m: SMModel, shapeOf: (body: string) => Shape | undefined, keep: Keep): SMModel {
  let out = m;
  const { mat, root } = placements(m);
  for (const [rootWall, bodyId] of Object.entries(m.bodies)) {
    const now = shapeOf(bodyId), was = m.built[bodyId];
    if (!now || !was || now === was || now.IsSame(was)) continue;
    const removed = bool(k, "cut", was, now, keep);
    if (!k.solids(removed).length || k.volume(removed) < 1e-6) continue;
    for (const w of m.walls) {
      if (root.get(w.id) !== rootWall) continue;
      const local = xform(k, removed, minv(mat.get(w.id)!), keep);
      const mid = xform(k, w.face, mtrans(0, 0, m.thickness / 2), keep);
      const hit = bool(k, "common", mid, local, keep);
      if (!k.sub(hit, "face").length) continue;
      const tool = xform(k, hit, mtrans(0, 0, -m.thickness / 2), keep);
      out = withWall(out, { id: w.id, face: oneFace(k, bool(k, "cut", w.face, tool, keep)) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ what a pick in the model means
export interface WallHit { wall: SMWall; /** the pick is on the top face (z = thickness), not the bottom */ top: boolean; side?: Side; at: Vec2 }

const zOf = (m: SMModel, z: number): boolean | null => (Math.abs(z) < TOL ? false : Math.abs(z - m.thickness) < TOL ? true : null);

/** The wall edge a picked edge of the body lies on. */
export function locateEdge(k: Kernel, m: SMModel, edge: Shape): WallHit | null {
  const vs = k.sub(edge, "vertex");
  if (vs.length !== 2) return null;
  const P = vs.map((v) => k.vertexPoint(v));
  const { mat } = placements(m);
  for (const w of m.walls) {
    const inv = minv(mat.get(w.id)!), a = mpt(inv, P[0]), b = mpt(inv, P[1]);
    const top = zOf(m, a[2]);
    if (top === null || Math.abs(a[2] - b[2]) > TOL) continue;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const side = sideAt(k, w, mid, [(b[0] - a[0]) / L, (b[1] - a[1]) / L]);
    if (side) return { wall: w, top, side, at: mid };
  }
  return null;
}
/** The wall a picked face of the body is a top, a bottom or an edge face of. */
export function locateFace(k: Kernel, m: SMModel, face: Shape): WallHit | null {
  const fr = k.faceFrame(face as Any);
  if (!fr) return null;
  const c = k.centre(face, "face"), { mat } = placements(m);
  for (const w of m.walls) {
    const inv = minv(mat.get(w.id)!), p = mpt(inv, c), n = mvec(inv, fr.normal);
    if (Math.abs(Math.abs(n[2]) - 1) < 1e-6) {
      const top = zOf(m, p[2]);
      if (top !== null && inside(k, w.face, [p[0], p[1]])) return { wall: w, top, at: [p[0], p[1]] };
    } else if (Math.abs(n[2]) < 1e-6 && p[2] > -TOL && p[2] < m.thickness + TOL) {
      const side = sideAt(k, w, [p[0], p[1]], [-n[1], n[0]]);
      if (side) return { wall: w, top: true, side, at: [p[0], p[1]] };
    }
  }
  return null;
}
/** The wall a point of the model is on the boundary of, top or bottom. */
export function locatePoint(k: Kernel, m: SMModel, p: Vec3): WallHit | null {
  const { mat } = placements(m);
  for (const w of m.walls) {
    const q = mpt(minv(mat.get(w.id)!), p), top = zOf(m, q[2]);
    if (top !== null && inside(k, w.face, [q[0], q[1]])) return { wall: w, top, at: [q[0], q[1]] };
  }
  return null;
}
/** The bend a face of the body belongs to, by its name. */
export const bendOfFace = (m: SMModel, name: string): SMBend | undefined => m.bends.find((b) => name.startsWith(`${m.id}:${b.id}:`));
