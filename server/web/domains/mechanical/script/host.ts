// host.ts — the host side of the Feature API: the fixed table of operations a script can ask for through the
// sandbox's one door (script/sandbox.ts), carried out on the feature's EvalContext.
//
// A script never holds a kernel object.  It names a body by its id and a face or an edge by its body's id and
// its stable name; every operation here looks the name up in the model as it is now and fails with a sentence
// when it is gone.  After every change the body is put back through `ctx.replaceBody`, so names are carried
// exactly as they are for the built-in features, and what the script reads next is the engine's own model.
// Each operation is bounded (how many regions, points and bodies it may bring), since one kernel call cannot be
// interrupted.
import { DEFAULT_PLANES, cross, dot, normalize, scale as vscale, sub, add as vadd, toPlane, toWorld, type Frame, type Vec3 } from "../core/geometry";
import { SKETCH_FONTS } from "../generated/sketch-font";
import { ShapeIndex } from "../kernel/occ";
import { bbox, compound } from "../kernel/ops/shapes";
import { thickWall } from "../kernel/ops/thick";
import { FeatureError, type Body, type EvalContext, type FaceNamer, type NamedShape, type Shape } from "../kernel/types";
import { measureEntity } from "../services/_measure-kernel";
import * as G from "./geom2d";
import { HostFail, type HostCall } from "./sandbox";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface RunDiagnostics { console: string[]; reports: { label: string; value: string }[]; warnings: string[] }
export const emptyDiagnostics = (): RunDiagnostics => ({ console: [], reports: [], warnings: [] });

const MAX_REGIONS = 4000, MAX_POINTS = 120000, MAX_NEW_BODIES = 200, MAX_CONSOLE = 200;

/** A wrong use of the API: reported with the script's line. */
class ApiMisuse extends Error {}
const bad = (m: string) => new ApiMisuse(m);

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((x) => typeof x === "number" && Number.isFinite(x));
const isPt = (v: unknown): v is G.Pt => Array.isArray(v) && v.length >= 2 && typeof v[0] === "number" && typeof v[1] === "number" && Number.isFinite(v[0]) && Number.isFinite(v[1]);
const vec = (v: unknown, what: string): Vec3 => { if (!isVec3(v)) throw bad(`${what} must be [x, y, z].`); return [v[0], v[1], v[2]]; };
const unit = (v: unknown, what: string): Vec3 => { const a = vec(v, what); if (Math.hypot(a[0], a[1], a[2]) < 1e-12) throw bad(`${what} has no length.`); return normalize(a); };
const pt = (v: unknown, what: string): G.Pt => { if (!isPt(v)) throw bad(`${what} must be [x, y].`); return [v[0], v[1]]; };
const num = (v: unknown, what: string): number => { if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`${what} must be a number.`); return v; };
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const v6 = (v: Vec3): Vec3 => [r6(v[0]), r6(v[1]), r6(v[2])];

function frameOfPlane(p: Any, what: string): Frame {
  if (!p || typeof p !== "object") throw bad(`${what} must be a plane (ctx.plane("top"), face.plane) or a flat face.`);
  const normal = unit(p.normal, `${what}.normal`), origin = vec(p.origin, `${what}.origin`);
  let x = isVec3(p.x) ? vec(p.x, "x") : ([1, 0, 0] as Vec3);
  // x square to the normal, whatever was given
  x = sub(x, vscale(normal, dot(x, normal)));
  if (Math.hypot(x[0], x[1], x[2]) < 1e-9) { x = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; x = sub(x, vscale(normal, dot(x, normal))); }
  x = normalize(x);
  return { origin, x, y: cross(normal, x), normal };
}
const planeOfFrame = (f: Frame) => ({ origin: v6(f.origin), x: v6(f.x), y: v6(f.y), normal: v6(f.normal) });

/** A loop turned the other way round (bulges belong to the edge after their vertex, so they move and change sign). */
function reversed(loop: G.Loop): G.Loop {
  const n = loop.length, out: G.Loop = [];
  for (let i = 0; i < n; i++) { const v = loop[n - 1 - i], prev = loop[(2 * n - 2 - i) % n], b = prev[2] || 0; out.push(b ? [v[0], v[1], -b] : [v[0], v[1]]); }
  return out;
}
const loopArea = (l: G.Loop) => G.signedArea(G.flatten(l, 0.01));

/** The circle a loop is, when it is one (all arcs about one centre, all the way round). */
function circleOfLoop(loop: G.Loop): { centre: G.Pt; radius: number } | null {
  if (loop.length < 2) return null;
  let c: G.Pt | null = null, r = 0, sweep = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length], bulge = a[2] || 0;
    if (!bulge) return null;
    const arc = G.arcOf(a, b, bulge);
    if (c && (Math.hypot(arc.c[0] - c[0], arc.c[1] - c[1]) > 1e-4 * Math.max(1, r) || Math.abs(arc.r - r) > 1e-4 * Math.max(1, r))) return null;
    c = arc.c; r = arc.r; sweep += arc.sweep;
  }
  return c && Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-3 ? { centre: c, radius: r } : null;
}

/** Whether a cylindrical face's outward side is towards its own axis: the wall of a hole, not of a pin. */
export function looksInward(k: { oc: unknown; xyz(p: Any): Vec3 }, face: Shape, origin: Vec3, axis: Vec3): boolean {
  const oc = k.oc as Any;
  const ad = new oc.BRepAdaptor_Surface(face, true), p = new oc.gp_Pnt(), du = new oc.gp_Vec(), dv = new oc.gp_Vec();
  try {
    ad.D1((ad.FirstUParameter() + ad.LastUParameter()) / 2, (ad.FirstVParameter() + ad.LastVParameter()) / 2, p, du, dv);
    let n = cross([du.X(), du.Y(), du.Z()], [dv.X(), dv.Y(), dv.Z()]);
    if ((face as Any).Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED) n = vscale(n, -1);
    const at = k.xyz(p), toAxis = sub(vadd(origin, vscale(axis, dot(sub(at, origin), axis))), at);
    return dot(n, toAxis) > 0;
  } finally { ad.delete(); p.delete(); du.delete(); dv.delete(); }
}

export interface ScriptHost { call: HostCall; /** apply what waits until the script is done (face labels) */ finish(): void }

/** The operations of one evaluation.  `values` are the feature's parameter values (for drag handles). */
export function makeHost(ctx: EvalContext, values: { [key: string]: unknown }, diag: RunDiagnostics): ScriptHost {
  const k = ctx.k, oc = ctx.oc as Any, fid = ctx.feature.id;
  let made = 0;
  const labels = new Map<string, Map<string, string>>();

  // ---- finding what a script names
  const B = (b: Body) => ({ $b: b.id });
  const F = (b: Body, name: string) => ({ $f: [b.id, name] });
  const E = (b: Body, name: string) => ({ $e: [b.id, name] });
  const bodyOf = (x: Any, what = "The part"): Body => {
    if (!x || typeof x.$b !== "string") throw bad(`${what} must be a Body.`);
    const b = ctx.body(x.$b);
    if (!b) throw bad(`${what} is no longer in the model (it was used up by an operation, or removed).`);
    return b;
  };
  const faceOf = (x: Any, what = "The face"): { body: Body; face: NamedShape } => {
    if (!x || !Array.isArray(x.$f)) throw bad(`${what} must be a Face.`);
    const b = ctx.body(String(x.$f[0]));
    const face = b && b.topo.faces.find((f) => f.name === x.$f[1]);
    if (!b || !face) throw bad(`${what} no longer exists on the part: an operation since removed or replaced it. Ask the body for its faces again.`);
    return { body: b, face };
  };
  const edgeOf = (x: Any, what = "The edge"): { body: Body; edge: NamedShape } => {
    if (!x || !Array.isArray(x.$e)) throw bad(`${what} must be an Edge.`);
    const b = ctx.body(String(x.$e[0]));
    const edge = b && b.topo.edges.find((e) => e.name === x.$e[1]);
    if (!b || !edge) throw bad(`${what} no longer exists on the part: an operation since removed or replaced it. Ask the body for its edges again.`);
    return { body: b, edge };
  };
  const flatFrame = (f: { face: NamedShape }, what: string): Frame => {
    const frame = k.faceFrame(f.face.shape as Any);
    if (!frame) throw new HostFail(`${what} needs a flat face; this one is curved.`);
    return frame;
  };

  // ---- which edges lie on which faces, per state of a body
  const adjacency = new Map<number, { edgesOf: Map<string, string[]>; facesOf: Map<string, string[]> }>();
  const around = (b: Body) => {
    let a = adjacency.get(b.rev);
    if (a) return a;
    a = { edgesOf: new Map(), facesOf: new Map() };
    const index = new ShapeIndex<string>(k);
    for (const e of b.topo.edges) index.add(e.shape, e.name);
    for (const f of b.topo.faces) {
      const names: string[] = [];
      for (const s of k.sub(f.shape, "edge")) { const n = index.get(s); if (n === undefined) continue; names.push(n); a.facesOf.set(n, [...(a.facesOf.get(n) || []), f.name]); }
      a.edgesOf.set(f.name, names);
    }
    adjacency.set(b.rev, a);
    return a;
  };

  const faceInfo = (b: Body, f: NamedShape) => {
    const m = measureEntity(k, f.shape, "face");
    const frame = m.surface === "plane" ? k.faceFrame(f.shape as Any) : null;
    return {
      kind: m.surface === "plane" || m.surface === "cylinder" || m.surface === "cone" || m.surface === "sphere" || m.surface === "torus" ? m.surface : "other",
      area: r6(m.area || 0), centre: v6(m.centroid as Vec3), normal: frame ? v6(frame.normal) : null, plane: frame ? planeOfFrame(frame) : null,
      radius: m.radius !== undefined ? r6(m.radius) : null,
      axis: m.surface === "cylinder" && m.center && m.axis ? { origin: v6(m.center as Vec3), direction: v6(m.axis as Vec3) } : null,
    };
  };
  const edgeInfo = (e: NamedShape) => {
    const m = measureEntity(k, e.shape, "edge");
    const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e.shape)));
    const p = ctx.tmp(ad.Value((ad.FirstParameter() + ad.LastParameter()) / 2));
    const kind = m.curve === "line" || m.curve === "circle" || m.curve === "ellipse" ? m.curve : m.curve === "bspline" ? "spline" : "other";
    return {
      kind, length: r6(m.length || 0), mid: v6(k.xyz(p)), start: m.start ? v6(m.start as Vec3) : null, end: m.end ? v6(m.end as Vec3) : null,
      direction: m.direction ? v6(m.direction as Vec3) : null, centre: m.curve === "circle" && m.center ? v6(m.center as Vec3) : null, radius: m.curve === "circle" && m.radius !== undefined ? r6(m.radius) : null,
    };
  };
  const angleBetween = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))))) * 180) / Math.PI;

  // ---- the outline of a flat face in its own plane
  const outlineOf = (f: NamedShape, frame: Frame): G.Region => {
    interface Seg { a: G.Pt; b: G.Pt; verts: G.Loop }   // verts: the vertices from a up to (not including) b, a's carrying the bulge
    const segs: Seg[] = [], loops: G.Loop[] = [];
    for (const s of k.sub(f.shape, "edge")) {
      const edge = oc.TopoDS.Edge(s);
      const ad = ctx.tmp(new oc.BRepAdaptor_Curve(edge));
      const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
      const at = (u: number): G.Pt => { const p = ad.Value(u); const out = toPlane(frame, k.xyz(p)); p.delete(); return out; };
      const a = at(u0), b = at(u1), t = ad.GetType(), T = oc.GeomAbs_CurveType;
      const closed = Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7;
      if (t === T.GeomAbs_Line) { if (!closed) segs.push({ a, b, verts: [[a[0], a[1]]] }); continue; }
      if (t === T.GeomAbs_Circle) {
        const circ = ctx.tmp(ad.Circle()), c = toPlane(frame, k.xyz(ctx.tmp(circ.Location()))), r = circ.Radius();
        if (closed) { loops.push([[c[0] + r, c[1], 1], [c[0] - r, c[1], 1]]); continue; }
        const m = at((u0 + u1) / 2);
        const ccw = (b[0] - a[0]) * (m[1] - a[1]) - (b[1] - a[1]) * (m[0] - a[0]) < 0;
        const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
        let sweep = ccw ? a1 - a0 : a0 - a1;
        while (sweep <= 0) sweep += 2 * Math.PI;
        segs.push({ a, b, verts: [[a[0], a[1], (ccw ? 1 : -1) * Math.tan(sweep / 4)]] });
        continue;
      }
      // any other curve: points close enough to it; arcs in them are read back later if they are there
      const n = 48, verts: G.Loop = [];
      for (let i = 0; i < n; i++) verts.push(at(u0 + ((u1 - u0) * i) / n));
      if (closed) loops.push(verts); else segs.push({ a, b, verts });
    }
    // join the pieces end to end
    const left = segs.slice();
    const near = (p: G.Pt, q: G.Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-5;
    const flip = (s: Seg): Seg => {
      // the same piece walked from b to a
      const pts: G.Loop = [...s.verts, [s.b[0], s.b[1]]], out: G.Loop = [];
      for (let i = pts.length - 1; i > 0; i--) { const bulge = pts[i - 1][2] || 0; out.push(bulge ? [pts[i][0], pts[i][1], -bulge] : [pts[i][0], pts[i][1]]); }
      return { a: s.b, b: s.a, verts: out };
    };
    while (left.length) {
      const first = left.shift()!;
      const loop: G.Loop = [...first.verts];
      let end = first.b, guard = left.length + 1;
      while (!near(end, first.a) && guard-- > 0) {
        let i = left.findIndex((s) => near(s.a, end)), piece: Seg | null = null;
        if (i >= 0) piece = left[i]; else { i = left.findIndex((s) => near(s.b, end)); if (i >= 0) piece = flip(left[i]); }
        if (!piece) break;
        left.splice(i, 1);
        loop.push(...piece.verts); end = piece.b;
      }
      if (loop.length >= 2) loops.push(loop);
    }
    if (!loops.length) throw new HostFail("The face's outline could not be read.");
    const sized = loops.map((l) => ({ l, a: loopArea(l) })).sort((p, q) => Math.abs(q.a) - Math.abs(p.a));
    const round = (l: G.Loop): G.Loop => l.map((v) => (v[2] ? [r6(v[0]), r6(v[1]), r6(v[2])] : [r6(v[0]), r6(v[1])]));
    return { outer: round(sized[0].a < 0 ? reversed(sized[0].l) : sized[0].l), holes: sized.slice(1).map((s) => round(s.a > 0 ? reversed(s.l) : s.l)) };
  };

  // ---- solids from 2D shapes
  const count = (regions: G.Region[], what: string) => {
    if (!regions.length) throw new HostFail(`${what}: the shape is empty, so there is nothing to build. (An offset or a rounding larger than the shape leaves nothing.)`);
    if (regions.length > MAX_REGIONS) throw new HostFail(`${what}: ${regions.length} separate regions is more than one operation takes (${MAX_REGIONS}). Use a coarser pattern.`);
    let n = 0;
    for (const r of regions) { n += r.outer.length; for (const h of r.holes) n += h.length; }
    if (n > MAX_POINTS) throw new HostFail(`${what}: the shape has ${n} points, more than one operation takes (${MAX_POINTS}). Use a coarser pattern.`);
  };
  const P3 = (frame: Frame, p: readonly number[], lift: number) => ctx.tmp(k.pnt(vadd(toWorld(frame, [p[0], p[1]]), vscale(frame.normal, lift))));
  const wireOf = (frame: Frame, loop: G.Loop, lift: number): Any => {
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i], b = loop[(i + 1) % n], bulge = a[2] || 0;
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7) continue;
      if (Math.abs(bulge) > 1e-9) {
        const arc = ctx.tmp(new oc.GC_MakeArcOfCircle(P3(frame, a, lift), P3(frame, G.arcMid(a, b, bulge), lift), P3(frame, b, lift)));
        mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(arc.Value())).Edge()));
      } else mw.Add(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(P3(frame, a, lift), P3(frame, b, lift))).Edge()));
    }
    if (!mw.IsDone()) throw new HostFail("A loop of the shape could not be made into a closed outline. It may cross itself.");
    return ctx.tmp(mw.Wire());
  };
  /** One solid per region: the region at `lift` along the normal, pulled `height` further. */
  const prisms = (shape: unknown, frame: Frame, lift: number, height: number, what: string, capName: string, sideName: string, arcs = true): { shape: Shape; names: FaceNamer }[] => {
    let regions: G.Region[];
    try { regions = G.withArcs(shape, arcs); } catch (e) { throw e instanceof G.Geo2Error ? bad(`${what}: ${e.message}`) : e; }
    count(regions, what);
    if (!(Math.abs(height) > 1e-6)) throw new HostFail(`${what}: the height must not be zero.`);
    const pln = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(vadd(frame.origin, vscale(frame.normal, lift)))), ctx.tmp(k.dir(frame.normal)), ctx.tmp(k.dir(frame.x))))));
    const out: { shape: Shape; names: FaceNamer }[] = [];
    for (const r of regions) {
      const mf = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(pln, oc.TopoDS.Wire(wireOf(frame, r.outer, lift)), true));
      for (const h of r.holes) mf.Add(oc.TopoDS.Wire(wireOf(frame, h, lift)));
      if (!mf.IsDone()) throw new HostFail(`${what}: a region of the shape could not be made into a face. It may cross itself or be too thin.`);
      const face = ctx.tmp(mf.Face());
      const v = ctx.tmp(k.vec(vscale(frame.normal, height)));
      const mk = ctx.own(new oc.BRepPrimAPI_MakePrism(face, v, false, true));
      mk.Build();
      if (!mk.IsDone()) throw new HostFail(`${what}: a region of the shape could not be extruded.`);
      const solid: Shape = ctx.own(mk.Shape());
      const first = ctx.own(mk.FirstShape()), last = ctx.own(mk.LastShape());
      out.push({ shape: solid, names: (f) => (f.IsSame(last) ? `${fid}:${capName}` : f.IsSame(first) ? `${fid}:base` : `${fid}:${sideName}`) });
    }
    return out;
  };
  const named = (parts: { shape: Shape; names: FaceNamer }[]): { shape: Shape; faces: NamedShape[] } => {
    const faces: NamedShape[] = [];
    for (const p of parts) faces.push(...k.namedFaces(p.shape, p.names, fid));
    return { shape: parts.length === 1 ? parts[0].shape : compound(k, parts.map((p) => p.shape), ctx.own), faces };
  };
  const replace = (body: Body, r: { shape: Shape; names: FaceNamer }, what: string): Body => {
    if (r.shape.IsNull() || !k.solids(r.shape).length) throw new HostFail(`${what} would leave nothing of the part.`);
    return ctx.replaceBody(body, r.shape, r.names);
  };
  const addNew = (shape: Shape, names: FaceNamer): Body => {
    if (++made > MAX_NEW_BODIES) throw new HostFail(`A feature may make at most ${MAX_NEW_BODIES} parts.`);
    return ctx.addBody(shape, names, { suffix: `b${made}` });
  };
  const kernelTry = <T>(what: string, fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof HostFail || e instanceof ApiMisuse) throw e;
      if (e instanceof FeatureError) throw new HostFail(e.message);
      throw new HostFail(`${what} failed in the kernel: ${k.describe(e)}.`);
    }
  };
  /**
   * Build with the shape's arcs as arcs; if the kernel hands back something unsound (a near-flat arc can do
   * that), build again from plain polygons, which it always takes.
   */
  const arcsElsePolygons = <T extends { shape: Shape }>(build: (arcs: boolean) => T): T => {
    let first: T | null = null;
    try { first = build(true); if (!first.shape.IsNull() && k.sound(first.shape)) return first; } catch (e) { if (e instanceof ApiMisuse) throw e; }
    try { return build(false); } catch (e) { if (first) return first; throw e; }
  };
  const extentAlong = (shape: Shape, origin: Vec3, dir: Vec3): [number, number] => {
    const bb = bbox(k, [shape]);
    if (!bb) return [0, 0];
    let lo = Infinity, hi = -Infinity;
    for (const x of [bb[0], bb[3]]) for (const y of [bb[1], bb[4]]) for (const z of [bb[2], bb[5]]) { const d = dot(sub([x, y, z], origin), dir); lo = Math.min(lo, d); hi = Math.max(hi, d); }
    return [lo, hi];
  };

  const transformOf = (o: Any): Any => {
    const t = ctx.tmp(new oc.gp_Trsf());
    if (o && o.translate !== undefined) t.SetTranslation(ctx.tmp(k.vec(vec(o.translate, "The distance to move by"))));
    else if (o && o.mirror !== undefined) { const f = frameOfPlane(o.mirror, "The mirror plane"); t.SetMirror(ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt(f.origin)), ctx.tmp(k.dir(f.normal))))); }
    else if (o && o.axis !== undefined) t.SetRotation(ctx.tmp(new oc.gp_Ax1(ctx.tmp(k.pnt(vec(o.origin, "The axis origin"))), ctx.tmp(k.dir(unit(o.axis, "The axis direction"))))), (num(o.angle, "The angle") * Math.PI) / 180);
    else throw bad("A move needs a translation, a rotation or a mirror plane.");
    return t;
  };
  /** A body's shape under a transform, with every face keeping (or, for a copy, deriving) its name. */
  const transformed = (body: Body, trsf: Any, rename: (n: string) => string): { shape: Shape; names: FaceNamer } => {
    const mk = ctx.own(new oc.BRepBuilderAPI_Transform(body.shape, trsf, true, false));
    const shape: Shape = ctx.own(mk.Shape());
    const index = new ShapeIndex<string>(k);
    for (const f of body.topo.faces) index.add(ctx.own(mk.ModifiedShape(f.shape)), rename(f.name));
    return { shape, names: (f) => index.get(f) ?? null };
  };

  const geo = (name: string, a: Any[]): unknown => {
    switch (name) {
      case "ngon": return G.ngon(pt(a[0], "centre"), num(a[1], "radius"), num(a[2], "sides"), a[3] === undefined || a[3] === null ? 0 : num(a[3], "angle"));
      case "slot": return G.slot(pt(a[0], "a"), pt(a[1], "b"), num(a[2], "width"));
      case "thicken": {
        if (!Array.isArray(a[0])) throw bad("thicken takes a list of [a, b] segments.");
        if (a[0].length > 20000) throw bad("thicken takes at most 20 000 segments.");
        return G.thicken(a[0].map((s: Any) => { if (!Array.isArray(s)) throw bad("thicken takes a list of [a, b] segments."); return [pt(s[0], "A segment's start"), pt(s[1], "A segment's end")] as [G.Pt, G.Pt]; }), num(a[1], "width"));
      }
      case "text": {
        const face = (SKETCH_FONTS as Any)["Source Sans"] || (SKETCH_FONTS as Any)[Object.keys(SKETCH_FONTS)[0]];
        if (!face) throw new HostFail("No font is available for text.");
        return G.text(face, a[0], a[1] || {});
      }
      case "union": return G.union(a[0], a[1]);
      case "difference": return G.difference(a[0], a[1]);
      case "intersection": return G.intersection(a[0], a[1]);
      case "offset": return G.offset(a[0], num(a[1], "distance"), a[2] || "round");
      case "round": return G.round(a[0], num(a[1], "radius"), a[2] ? num(a[2], "reflex") : 0);
      case "translate": return G.translate(a[0], pt(a[1], "by"));
      case "rotate": return G.rotate(a[0], num(a[1], "angle"), a[2] ? pt(a[2], "about") : [0, 0]);
      case "scale": return G.scale(a[0], num(a[1], "factor"), a[2] ? pt(a[2], "about") : [0, 0]);
      case "mirror": return G.mirror(a[0], pt(a[1], "a"), pt(a[2], "b"));
      case "area": return G.area(a[0]);
      case "bounds": return G.bounds(a[0]);
      case "centroid": return G.centroid(a[0]);
      case "contains": return G.contains(a[0], pt(a[1], "p"));
      case "distance": return G.distance(a[0], pt(a[1], "p"));
      case "clearance": return G.clearance(a[0], a[1]);
      case "cells": return G.cells(String(a[0]), a[1], a[2] || {});
      case "grid": return G.grid(a[0], a[1] || {});
      case "outlinePoints": return G.outlinePoints(a[0], a[1] || {});
      case "delaunay": if (!Array.isArray(a[0])) throw bad("delaunay takes a list of [x, y] points."); return G.delaunay(a[0]);
      case "voronoi": if (!Array.isArray(a[0])) throw bad("voronoi takes a list of [x, y] points."); return G.voronoi(a[0].map((p: Any) => pt(p, "A point")), a[1]);
      case "triangulate": return G.triangulate(a[0]);
    }
    throw bad(`Geo2.${name} is not part of the Feature API.`);
  };

  const ops: { [op: string]: (a: Any[]) => { value: unknown; mutated?: boolean } } = {
    // ---- results
    log: (a) => { if (diag.console.length < MAX_CONSOLE) diag.console.push(String(a[0]).slice(0, 4000)); else if (diag.console.length === MAX_CONSOLE) diag.console.push("… (more output was dropped)"); return { value: null }; },
    warn: (a) => { const m = String(a[0]).slice(0, 400); if (diag.warnings.length < 20) { diag.warnings.push(m); ctx.warn(m); } return { value: null }; },
    report: (a) => { if (diag.reports.length < 40) diag.reports.push({ label: String(a[0]).slice(0, 60), value: String(a[1]).slice(0, 120) }); return { value: null }; },
    handle: (a) => {
      const v = values[String(a[0])];
      if (typeof v !== "number") throw bad(`handle: "${a[0]}" is not a number parameter of this feature.`);
      ctx.handle({ key: String(a[0]), value: v, origin: vec(a[1], "origin"), dir: unit(a[2], "direction"), scale: 1 });
      return { value: null };
    },

    // ---- query
    bodies: () => ({ value: ctx.bodies().map(B) }),
    plane: (a) => { const p = (DEFAULT_PLANES as Any)[String(a[0])]; if (!p) throw bad('ctx.plane takes "top", "front" or "right".'); return { value: planeOfFrame(p.frame) }; },
    planeAt: (a) => ({ value: planeOfFrame(frameOfPlane({ origin: a[0], normal: a[1], x: a[2] || undefined }, "The plane")) }),
    "body.info": (a) => {
      const b = bodyOf(a[0]);
      const g = ctx.tmp(new oc.GProp_GProps()); oc.BRepGProp.VolumeProperties(b.shape, g, true, false, false);
      const s = ctx.tmp(new oc.GProp_GProps()); oc.BRepGProp.SurfaceProperties(b.shape, s, false, false);
      const bb = bbox(k, [b.shape]) || [0, 0, 0, 0, 0, 0];
      const min: Vec3 = [bb[0], bb[1], bb[2]], max: Vec3 = [bb[3], bb[4], bb[5]];
      return { value: { name: b.name, volume: r6(g.Mass()), area: r6(s.Mass()), centre: v6(k.xyz(ctx.tmp(g.CentreOfMass()))), bounds: { min: v6(min), max: v6(max), size: v6(sub(max, min)), centre: v6(vscale(vadd(min, max), 0.5)) } } };
    },
    "body.mass": (a) => ({ value: r6((k.volume(bodyOf(a[0]).shape) * num(a[1], "The density (g/cm³)")) / 1000) }),
    "body.faces": (a) => {
      const b = bodyOf(a[0]), f = a[1] || {};
      const tol = typeof f.tolerance === "number" ? f.tolerance : 1;
      const want = f.normal ? unit(f.normal, "filter.normal") : null, par = f.parallelTo ? unit(f.parallelTo, "filter.parallelTo") : null;
      const rows = b.topo.faces.map((face) => ({ face, info: faceInfo(b, face) })).filter(({ info }) => {
        if (f.kind && info.kind !== f.kind) return false;
        if (want && (!info.normal || angleBetween(info.normal, want) > tol)) return false;
        if (par && (!info.normal || Math.min(angleBetween(info.normal, par), 180 - angleBetween(info.normal, par)) > tol)) return false;
        if (typeof f.minArea === "number" && info.area < f.minArea) return false;
        if (typeof f.maxArea === "number" && info.area > f.maxArea) return false;
        return true;
      });
      rows.sort((p, q) => q.info.area - p.info.area || (p.face.name < q.face.name ? -1 : 1));
      return { value: rows.map((r) => F(b, r.face.name)) };
    },
    "body.edges": (a) => {
      const b = bodyOf(a[0]), f = a[1] || {};
      const tol = typeof f.tolerance === "number" ? f.tolerance : 1, par = f.parallelTo ? unit(f.parallelTo, "filter.parallelTo") : null;
      const out = b.topo.edges.filter((e) => {
        if (!f.kind && !par && f.minLength === undefined && f.maxLength === undefined) return true;
        const info = edgeInfo(e);
        if (f.kind && info.kind !== f.kind) return false;
        if (par && (!info.direction || Math.min(angleBetween(info.direction, par), 180 - angleBetween(info.direction, par)) > tol)) return false;
        if (typeof f.minLength === "number" && info.length < f.minLength) return false;
        if (typeof f.maxLength === "number" && info.length > f.maxLength) return false;
        return true;
      });
      return { value: out.map((e) => E(b, e.name)) };
    },
    "body.holes": (a) => {
      const b = bodyOf(a[0]), f = a[1] || {};
      interface H { origin: Vec3; axis: Vec3; r: number; lo: number; hi: number; area: number; faces: string[] }
      const found: H[] = [];
      for (const face of b.topo.faces) {
        const ad = ctx.tmp(new oc.BRepAdaptor_Surface(face.shape, true));
        if (ad.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) continue;
        const cyl = ctx.tmp(ad.Cylinder()), ax = ctx.tmp(cyl.Axis());
        const origin = k.xyz(ctx.tmp(ax.Location())), axis = normalize(k.xyz(ctx.tmp(ax.Direction()))), r = cyl.Radius();
        // a hole's wall looks at its own axis
        if (!looksInward(k, face.shape, origin, axis)) continue;
        let lo = Infinity, hi = -Infinity;
        for (const v of k.sub(face.shape, "vertex")) { const d = dot(sub(k.vertexPoint(v), origin), axis); lo = Math.min(lo, d); hi = Math.max(hi, d); }
        const area = measureEntity(k, face.shape, "face").area || 0;
        const same = found.find((h) => Math.abs(h.r - r) < 1e-6 && Math.abs(Math.abs(dot(h.axis, axis)) - 1) < 1e-9 && Math.hypot(...cross(sub(origin, h.origin), h.axis)) < 1e-6 && lo <= h.hi + 1e-6 && hi >= h.lo - 1e-6);
        if (same) { same.area += area; same.faces.push(face.name); const sign = dot(same.axis, axis) < 0 ? -1 : 1, off = dot(sub(origin, same.origin), same.axis); same.lo = Math.min(same.lo, off + (sign > 0 ? lo : -hi)); same.hi = Math.max(same.hi, off + (sign > 0 ? hi : -lo)); }
        else found.push({ origin, axis, r, lo, hi, area, faces: [face.name] });
      }
      const holes = found.filter((h) => h.hi - h.lo > 1e-6 && h.area > 0.98 * 2 * Math.PI * h.r * (h.hi - h.lo))
        .filter((h) => (typeof f.minDiameter !== "number" || 2 * h.r >= f.minDiameter - 1e-9) && (typeof f.maxDiameter !== "number" || 2 * h.r <= f.maxDiameter + 1e-9))
        .map((h) => ({ centre: v6(vadd(h.origin, vscale(h.axis, (h.lo + h.hi) / 2))), axis: v6(h.axis), diameter: r6(2 * h.r), depth: r6(h.hi - h.lo), faces: h.faces.map((n) => F(b, n)) }));
      holes.sort((p, q) => p.centre[0] - q.centre[0] || p.centre[1] - q.centre[1] || p.centre[2] - q.centre[2]);
      return { value: holes };
    },
    "face.info": (a) => { const f = faceOf(a[0]); return { value: faceInfo(f.body, f.face) }; },
    "face.outline": (a) => { const f = faceOf(a[0]); return { value: outlineOf(f.face, flatFrame(f, "face.outline()")) }; },
    "face.holes": (a) => {
      const f = faceOf(a[0]), frame = flatFrame(f, "face.holes()");
      const out = outlineOf(f.face, frame).holes.map(circleOfLoop).filter((c): c is { centre: G.Pt; radius: number } => !!c)
        .map((c) => ({ centre: [r6(c.centre[0]), r6(c.centre[1])], diameter: r6(2 * c.radius), centre3: v6(toWorld(frame, c.centre)) }));
      out.sort((p, q) => p.centre[0] - q.centre[0] || p.centre[1] - q.centre[1]);
      return { value: out };
    },
    "face.edges": (a) => { const f = faceOf(a[0]); return { value: (around(f.body).edgesOf.get(f.face.name) || []).map((n) => E(f.body, n)) }; },
    "face.neighbours": (a) => {
      const f = faceOf(a[0]), adj = around(f.body), out = new Set<string>();
      for (const e of adj.edgesOf.get(f.face.name) || []) for (const n of adj.facesOf.get(e) || []) if (n !== f.face.name) out.add(n);
      return { value: Array.from(out).sort().map((n) => F(f.body, n)) };
    },
    "face.toWorld": (a) => { const f = faceOf(a[0]), frame = flatFrame(f, "face.toWorld()"); return { value: v6(vadd(toWorld(frame, pt(a[1], "p")), vscale(frame.normal, a[2] ? num(a[2], "height") : 0))) }; },
    "face.toLocal": (a) => { const f = faceOf(a[0]); const p = toPlane(flatFrame(f, "face.toLocal()"), vec(a[1], "p")); return { value: [r6(p[0]), r6(p[1])] }; },
    "edge.info": (a) => ({ value: edgeInfo(edgeOf(a[0]).edge) }),
    "edge.faces": (a) => { const e = edgeOf(a[0]); return { value: (around(e.body).facesOf.get(e.edge.name) || []).map((n) => F(e.body, n)) }; },

    // ---- build
    extrude: (a) => {
      const o = a[2] || {}, height = num(o.height, "extrude: height");
      const frame = a[1] && Array.isArray(a[1].$f) ? flatFrame(faceOf(a[1]), "extrude") : frameOfPlane(a[1], "extrude: the plane");
      const lift = (o.offset ? num(o.offset, "extrude: offset") : 0) - (o.both ? height : 0);
      return kernelTry("The extrusion", () => {
        const all = arcsElsePolygons((arcs) => named(prisms(a[0], frame, lift, o.both ? 2 * height : height, "extrude", "end", "side", arcs)));
        const index = new ShapeIndex<string>(k);
        for (const f of all.faces) index.add(f.shape, f.name);
        return { value: B(addNew(all.shape, (f) => index.get(f) ?? null)), mutated: true };
      });
    },
    "face.cut": (a) => {
      const f = faceOf(a[0]), frame = flatFrame(f, "face.cut()"), o = a[2] || {};
      let depth: number;
      if (o.through) depth = -extentAlong(f.body.shape, frame.origin, frame.normal)[0] + 1;
      else { depth = num(o.depth, "face.cut: depth"); if (!(depth > 0)) throw new HostFail("The depth of a cut must be more than zero."); }
      return kernelTry("The cut", () => {
        const before = k.volume(f.body.shape);
        const r = arcsElsePolygons((arcs) => k.boolean("cut", { shape: f.body.shape, faces: f.body.topo.faces }, named(prisms(a[1], frame, 0, -depth, "face.cut", "floor", "wall", arcs)), fid, ctx.own));
        const out = replace(f.body, r, "The cut");
        // a shape drawn in the wrong coordinates misses the part and says nothing: say it
        if (before - k.volume(out.shape) < 1e-6 && diag.warnings.length < 20) { const m = "A cut removed nothing: its shape lies outside the part (2D points are in the face's own plane; face.toLocal turns a model point into them)."; diag.warnings.push(m); ctx.warn(m); }
        return { value: B(out), mutated: true };
      });
    },
    "face.add": (a) => {
      const f = faceOf(a[0]), frame = flatFrame(f, "face.add()"), o = a[2] || {};
      const height = num(o.height, "face.add: height");
      if (!(height > 0)) throw new HostFail("The height to add must be more than zero.");
      return kernelTry("Adding to the face", () => {
        const r = arcsElsePolygons((arcs) => k.boolean("fuse", { shape: f.body.shape, faces: f.body.topo.faces }, named(prisms(a[1], frame, 0, height, "face.add", "top", "side", arcs)), fid, ctx.own));
        return { value: B(replace(f.body, r, "The addition")), mutated: true };
      });
    },
    boolean: (a) => {
      const op = a[0] as "fuse" | "cut" | "common";
      let target = bodyOf(a[1], "The target");
      const tools: Body[] = (Array.isArray(a[2]) ? a[2] : []).map((t: Any) => bodyOf(t, "A tool"));
      if (!tools.length) throw bad("A boolean needs at least one tool body.");
      if (tools.some((t) => t.id === target.id)) throw bad("A body cannot be combined with itself.");
      return kernelTry("Combining the parts", () => {
        for (const tool of tools) {
          const r = k.boolean(op, { shape: target.shape, faces: target.topo.faces }, { shape: tool.shape, faces: tool.topo.faces }, fid, ctx.own);
          target = replace(target, r, op === "cut" ? "The cut" : op === "fuse" ? "Joining" : "The intersection");
          ctx.removeBody(tool);
        }
        return { value: B(target), mutated: true };
      });
    },
    "body.fillet": (a) => {
      const b = bodyOf(a[0]), r = num(a[2], "fillet: radius");
      if (!(r > 0)) throw new HostFail("The fillet radius must be more than zero.");
      const edges = (Array.isArray(a[1]) ? a[1] : []).map((e: Any) => edgeOf(e));
      if (!edges.length) throw new HostFail("fillet: there are no edges to round.");
      if (edges.some((e: { body: Body }) => e.body.id !== b.id)) throw bad("fillet: every edge must belong to this body.");
      return kernelTry("The fillet", () => {
        const mk = ctx.own(new oc.BRepFilletAPI_MakeFillet(b.shape, oc.ChFi3d_FilletShape.ChFi3d_Rational));
        for (const e of edges) mk.Add(r, oc.TopoDS.Edge(e.edge.shape));
        const range = ctx.tmp(new oc.Message_ProgressRange());
        mk.Build(range);
        if (!mk.IsDone()) throw new HostFail("The edges could not be rounded with that radius. Try a smaller one.");
        const shape: Shape = ctx.own(mk.Shape());
        return { value: B(replace(b, { shape, names: k.carryNames(shape, mk, b.topo.faces, fid, b.topo.edges) }, "The fillet")), mutated: true };
      });
    },
    "body.chamfer": (a) => {
      const b = bodyOf(a[0]), d = num(a[2], "chamfer: distance");
      if (!(d > 0)) throw new HostFail("The chamfer distance must be more than zero.");
      const edges = (Array.isArray(a[1]) ? a[1] : []).map((e: Any) => edgeOf(e));
      if (!edges.length) throw new HostFail("chamfer: there are no edges to bevel.");
      if (edges.some((e: { body: Body }) => e.body.id !== b.id)) throw bad("chamfer: every edge must belong to this body.");
      return kernelTry("The chamfer", () => {
        const mk = ctx.own(new oc.BRepFilletAPI_MakeChamfer(b.shape));
        for (const e of edges) mk.Add(d, oc.TopoDS.Edge(e.edge.shape));
        const range = ctx.tmp(new oc.Message_ProgressRange());
        mk.Build(range);
        if (!mk.IsDone()) throw new HostFail("The edges could not be bevelled by that much. Try a smaller distance.");
        const shape: Shape = ctx.own(mk.Shape());
        return { value: B(replace(b, { shape, names: k.carryNames(shape, mk, b.topo.faces, fid, b.topo.edges) }, "The chamfer")), mutated: true };
      });
    },
    "body.shell": (a) => {
      const b = bodyOf(a[0]), t = num(a[1], "shell: thickness");
      if (!(t > 0)) throw new HostFail("The wall thickness must be more than zero.");
      const open = (Array.isArray(a[2]) ? a[2] : []).map((f: Any) => faceOf(f));
      if (open.some((f: { body: Body }) => f.body.id !== b.id)) throw bad("shell: every face to open must belong to this body.");
      return kernelTry("The shell", () => ({ value: B(replace(b, thickWall(k, b.shape, b.topo.faces, open.map((f: { face: NamedShape }) => f.face.shape), -t, fid, ctx.own), "The shell")), mutated: true }));
    },
    "body.copy": (a) => {
      const b = bodyOf(a[0]);
      return kernelTry("The copy", () => { const r = transformed(b, ctx.tmp(new oc.gp_Trsf()), (n) => `${fid}:copy(${n})`); return { value: B(addNew(r.shape, r.names)), mutated: true }; });
    },
    "body.move": (a) => {
      const b = bodyOf(a[0]);
      return kernelTry("Moving the part", () => ({ value: B(ctx.replaceBody(b, ...((r) => [r.shape, r.names] as [Shape, FaceNamer])(transformed(b, transformOf(a[1]), (n) => n)))), mutated: true }));
    },
    pattern: (a) => {
      const b = bodyOf(a[0]), o = a[1] || {}, n = Math.round(num(o.count, "pattern: count"));
      if (!(n >= 1 && n <= MAX_NEW_BODIES)) throw new HostFail(`A pattern takes a count from 1 to ${MAX_NEW_BODIES}.`);
      return kernelTry("The pattern", () => {
        const out: unknown[] = [];
        for (let i = 1; i < n; i++) {
          const t = o.axis !== undefined ? transformOf({ origin: o.origin, axis: o.axis, angle: (num(o.angle, "pattern: angle") * i) / (Math.abs(o.angle) >= 360 - 1e-9 ? n : Math.max(1, n - 1)) }) : transformOf({ translate: vscale(unit(o.direction, "pattern: direction"), num(o.spacing, "pattern: spacing") * i) });
          const r = transformed(b, t, (name) => `${fid}:copy${i}(${name})`);
          out.push(B(addNew(r.shape, r.names)));
        }
        return { value: out, mutated: true };
      });
    },
    "body.remove": (a) => { ctx.removeBody(bodyOf(a[0])); return { value: null, mutated: true }; },
    "face.label": (a) => {
      const f = faceOf(a[0]), label = String(a[1] ?? "");
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(label)) throw bad("A face label is 1 to 40 letters, digits, _ . or -.");
      if (!labels.has(f.body.id)) labels.set(f.body.id, new Map());
      labels.get(f.body.id)!.set(f.face.name, `${fid}:${label}`);
      return { value: null };
    },
  };

  const call: HostCall = (op, args) => {
    try {
      if (op.startsWith("g.")) return { value: geo(op.slice(2), args) };
      const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
      if (!fn) throw bad(`"${op}" is not part of the Feature API.`);
      return fn(args);
    } catch (e) {
      // only a failure the person can act on crosses as one; anything else is a misuse the script's author fixes
      if (e instanceof HostFail) throw e;
      if (e instanceof FeatureError) throw new HostFail(e.message);
      if (e instanceof ApiMisuse || e instanceof G.Geo2Error) throw new Error(e.message);
      throw new Error(`${op}: ${k.describe(e)}`);
    }
  };

  const finish = () => {
    for (const [bodyId, map] of labels) {
      const b = ctx.body(bodyId);
      if (!b) continue;
      const index = new ShapeIndex<string>(k);
      for (const f of b.topo.faces) index.add(f.shape, map.get(f.name) || f.name);
      ctx.replaceBody(b, b.shape, (f) => index.get(f) ?? null);
    }
  };
  return { call, finish };
}
