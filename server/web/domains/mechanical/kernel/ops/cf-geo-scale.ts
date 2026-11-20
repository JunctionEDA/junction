// cf-geo-scale.ts — a solid stretched by different factors along x, y and z (features/cf-geo-scale.ts).
//
// The kernel build has no general affine transform of a shape (only moves, turns and even scaling), so the body
// is rebuilt face by face:
//
//   a flat face     stays a plane.  Its straight edges are drawn between the stretched corners; its curved edges
//                   become cubic curves through the stretched curve (below).
//   any other face  gets a new surface with the SAME parameters as the old one: S'(u, v) = stretch(S(u, v)).
//                   The edges of a face are stored as curves in its surface's (u, v), so on a surface with the
//                   same parameters they are right as they are, and are carried over untouched.
//
// S' is a cubic spline surface through the stretched surface's points, first derivatives and twist on a grid of
// (u, v) (a Hermite spline: continuous in direction, exact at the grid).  With 48 spans to a turn it is within
// about a millionth of the radius of the true stretched cylinder, cone, sphere or torus: a round hole becomes
// an ellipse to that accuracy, not an exact one.  Flat faces and straight edges are exact.
// The faces are then sewn back into a solid; each keeps the place, and so the name, of the face it came from.
//
// NOT DONE: a face that closes on itself (a whole cylinder with its seam) does not come back as a sound face, so
// a solid that has one is refused: the result is checked (the kernel's own validity check, and the volume against
// the old one times the three factors) and nothing unsound is handed on.
import { cross, length, normalize, sub, type Vec3 } from "../../core/geometry";
import type { EvalContext, Shape } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Knots and multiplicities of a cubic Hermite spline on `n` equal spans of [a, b]. */
function hermiteKnots(ctx: EvalContext, a: number, b: number, n: number): { knots: Any; mults: Any } {
  const oc = ctx.oc as Any;
  const knots = ctx.tmp(new oc.NCollection_Array1_double(1, n + 1)), mults = ctx.tmp(new oc.NCollection_Array1_int(1, n + 1));
  for (let i = 0; i <= n; i++) { knots.SetValue(i + 1, a + ((b - a) * i) / n); mults.SetValue(i + 1, i === 0 || i === n ? 4 : 2); }
  return { knots, mults };
}
/** The control points along one direction: per grid place, which node it belongs to and which side of it (−1, 0, +1). */
const slots = (n: number): [number, number][] => { const out: [number, number][] = [[0, 0]]; for (let i = 0; i <= n; i++) { if (i > 0) out.push([i, -1]); if (i < n) out.push([i, 1]); } out.push([n, 0]); return out; };

const TURN = 2 * Math.PI / 48;
/** How many spans of a stretched surface one edge may run across. */
const PER_FLAT = 12;
const PER_EDGE = 12;

export interface Stretch { at: (p: Vec3) => Vec3; dir: (v: Vec3) => Vec3 }

/** An edge's curve stretched, as a new edge. */
function stretchedEdge(ctx: EvalContext, edge: Shape, s: Stretch): Shape[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge)));
  const a = ad.FirstParameter(), b = ad.LastParameter(), type = ad.GetType(), T = oc.GeomAbs_CurveType;
  const P = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), D = ctx.tmp(new oc.gp_Vec(0, 0, 0));
  const at = (t: number): { p: Vec3; d: Vec3 } => { ad.D1(t, P, D); return { p: s.at(k.xyz(P)), d: s.dir(k.xyz(D)) }; };
  if (type === T.GeomAbs_Line) return [ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(at(a).p)), ctx.tmp(k.pnt(at(b).p)))).Edge())];
  const n = type === T.GeomAbs_Circle || type === T.GeomAbs_Ellipse ? Math.max(2, Math.ceil((b - a) / TURN)) : type === T.GeomAbs_BSplineCurve ? Math.min(128, Math.max(8, 2 * (ad.NbKnots() - 1))) : 24;
  const h = (b - a) / n, sl = slots(n);
  const poles = ctx.tmp(new oc.NCollection_Array1_gp_Pnt(1, sl.length));
  sl.forEach(([i, side], j) => { const q = at(a + i * h); poles.SetValue(j + 1, ctx.tmp(k.pnt([q.p[0] + (side * h * q.d[0]) / 3, q.p[1] + (side * h * q.d[1]) / 3, q.p[2] + (side * h * q.d[2]) / 3]))); });
  const { knots, mults } = hermiteKnots(ctx, a, b, n);
  // cut into edges of a few spans each (the kernel measures poorly along an edge with many knots in it)
  const curve = new oc.Geom_BSplineCurve(poles, knots, mults, 3, false), out: Shape[] = [];
  for (let i = 0; i < n; i += PER_FLAT) {
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(curve, a + i * h, a + Math.min(n, i + PER_FLAT) * h));
    if (!mk.IsDone()) throw ctx.fail("An edge could not be stretched.");
    out.push(ctx.own(mk.Edge()));
  }
  const reversed = edge.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  return reversed ? out.reverse() : out;
}

/** A face's surface stretched, with the same parameters, over the face's own extent. */
function stretchedSurface(ctx: EvalContext, face: Shape, ad: Any, s: Stretch): { s: Any; hu: number; hv: number } {
  const oc = ctx.oc as Any, k = ctx.k, T = oc.GeomAbs_SurfaceType, type = ad.GetType();
  const b = oc.BRepTools.UVBounds(oc.TopoDS.Face(face), 0, 0, 0, 0);
  const turn = (range: number) => Math.max(2, Math.ceil(range / TURN));
  const knotty = (count: number) => Math.min(96, Math.max(8, 2 * (count - 1)));
  let nu = 24, nv = 24;
  if (type === T.GeomAbs_Cylinder || type === T.GeomAbs_Cone) { nu = turn(b.UMax - b.UMin); nv = 1; }
  else if (type === T.GeomAbs_Sphere || type === T.GeomAbs_Torus) { nu = turn(b.UMax - b.UMin); nv = turn(b.VMax - b.VMin); }
  else if (type === T.GeomAbs_SurfaceOfExtrusion) nv = 1;
  else if (type === T.GeomAbs_SurfaceOfRevolution) nu = turn(b.UMax - b.UMin);
  else if (type === T.GeomAbs_BSplineSurface || type === T.GeomAbs_BezierSurface) { nu = knotty(ad.NbUKnots()); nv = knotty(ad.NbVKnots()); }
  const hu = (b.UMax - b.UMin) / nu, hv = (b.VMax - b.VMin) / nv, su = slots(nu), sv = slots(nv);
  const P = ctx.tmp(new oc.gp_Pnt(0, 0, 0)), V = [0, 1, 2, 3, 4].map(() => ctx.tmp(new oc.gp_Vec(0, 0, 0)));
  // the stretched point, both derivatives and the twist at every node of the grid
  const node: { p: Vec3; du: Vec3; dv: Vec3; duv: Vec3 }[][] = [];
  for (let i = 0; i <= nu; i++) {
    node.push([]);
    for (let j = 0; j <= nv; j++) {
      ad.D2(b.UMin + i * hu, b.VMin + j * hv, P, V[0], V[1], V[2], V[3], V[4]);
      node[i].push({ p: s.at(k.xyz(P)), du: s.dir(k.xyz(V[0])), dv: s.dir(k.xyz(V[1])), duv: s.dir(k.xyz(V[4])) });
    }
  }
  const build = (us: [number, number][], periodic: boolean): Any => {
    const poles = ctx.tmp(new oc.NCollection_Array2_gp_Pnt(1, us.length, 1, sv.length));
    us.forEach(([i, a], I) => sv.forEach(([j, c], J) => {
      const q = node[i][j], x = (a * hu) / 3, y = (c * hv) / 3;
      poles.SetValue(I + 1, J + 1, ctx.tmp(k.pnt([0, 1, 2].map((d) => q.p[d] + x * q.du[d] + y * q.dv[d] + x * y * q.duv[d]) as Vec3)));
    }));
    const ku = hermiteKnots(ctx, b.UMin, b.UMax, nu), kv = hermiteKnots(ctx, b.VMin, b.VMax, nv);
    if (periodic) for (const i of [1, nu + 1]) ku.mults.SetValue(i, 2);
    return new oc.Geom_BSplineSurface(poles, ku.knots, kv.knots, ku.mults, kv.mults, 3, 3, periodic, false);   // kept alive by the face on it
  };
  // a face that goes all the way round (a hole, a shaft) needs a surface that closes on itself the same way,
  // so that its seam stays a seam: the same spline with its ends joined.  The control points of such a spline
  // are the ones either side of each node, starting after the first node or before it; which, is tried.
  if (ad.IsUPeriodic() && b.UMax - b.UMin > ad.UPeriod() - 1e-9) {
    const ring: [number, number][] = [];
    for (let i = 0; i < nu; i++) ring.push([i, 1], [i + 1, -1]);
    const size = Math.max(1e-9, ...node.flat().map((q) => Math.hypot(q.p[0], q.p[1], q.p[2])));
    for (const us of [ring, [ring[ring.length - 1], ...ring.slice(0, -1)].map(([i, a], n): [number, number] => (n === 0 ? [0, -1] : [i, a]))]) {
      try {
        const surf = build(us, true), at = surf.Value(b.UMin + hu, b.VMin), want = node[1][0].p;
        const off = Math.hypot(at.X() - want[0], at.Y() - want[1], at.Z() - want[2]);
        at.delete();
        if (off < 1e-6 * size) return { s: surf, hu, hv };
      } catch (e) { /* the other order, or the open surface below */ }
    }
  }
  return { s: build(su, false), hu, hv };
}

/** The edges of a wire as the wire lists them: one that is in it twice (a seam) comes twice, once each way. */
function wireEdges(ctx: EvalContext, wire: Shape): Shape[] {
  const oc = ctx.oc as Any, E = oc.TopAbs_ShapeEnum, out: Shape[] = [];
  const ex = ctx.tmp(new oc.TopExp_Explorer(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE));
  for (; ex.More(); ex.Next()) out.push(ctx.tmp(oc.TopoDS.Edge(ctx.tmp(ex.Current()))));
  return out;
}

/** One face rebuilt stretched; null when it has no outline. */
function stretchedFace(ctx: EvalContext, face: Shape, s: Stretch): Shape {
  const oc = ctx.oc as Any, k = ctx.k, F = oc.TopoDS.Face(face);
  const ad = ctx.tmp(new oc.BRepAdaptor_Surface(F, true));
  const flat = ad.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane;
  const outer = ctx.tmp(oc.BRepTools.OuterWire(F));
  const wires = k.sub(face, "wire"), ordered = [...wires.filter((w) => w.IsSame(outer)), ...wires.filter((w) => !w.IsSame(outer))];
  let surface: { s: Any; hu: number; hv: number } = { s: null, hu: 1, hv: 1 }, plane: Any = null;
  if (flat) {
    const pln = ad.Plane(), pos = pln.Position();
    const o = s.at(k.xyz(pos.Location())), x = s.dir(k.xyz(pos.XDirection())), y = s.dir(k.xyz(pos.YDirection()));
    pln.delete(); pos.delete();
    plane = ctx.tmp(new oc.gp_Pln(ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(o)), ctx.tmp(k.dir(normalize(cross(x, y)))), ctx.tmp(k.dir(normalize(x)))))));
  } else surface = stretchedSurface(ctx, face, ad, s);
  const built = ordered.map((w) => {
    const edges: Shape[] = [];
    for (const e of wireEdges(ctx, w)) {
      if (oc.BRep_Tool.Degenerated(e)) continue;   // a surface's pole: the healing below puts it back
      if (flat) { edges.push(...stretchedEdge(ctx, e, s)); continue; }
      const c = ctx.tmp(new oc.BRepAdaptor_Curve2d(e, F));
      const t0 = c.FirstParameter(), t1 = c.LastParameter();
      // an edge that runs across many spans of the new surface is cut into pieces of a few spans each: the kernel
      // measures areas and volumes poorly along an edge that crosses many of a surface's knots
      const q0 = c.Value(t0), q1 = c.Value(t1), qm = c.Value((t0 + t1) / 2);
      const crossed = Math.max(Math.abs(q1.X() - q0.X()), 2 * Math.abs(qm.X() - q0.X())) / surface.hu + Math.max(Math.abs(q1.Y() - q0.Y()), 2 * Math.abs(qm.Y() - q0.Y())) / surface.hv;
      q0.delete(); q1.delete(); qm.delete();
      const pieces = Math.max(1, Math.ceil(crossed / PER_EDGE - 1e-9));
      const reversed = e.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED, run: Shape[] = [];
      for (let i = 0; i < pieces; i++) {
        const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(c.Curve(), surface.s, t0 + ((t1 - t0) * i) / pieces, t0 + ((t1 - t0) * (i + 1)) / pieces));
        if (!mk.IsDone()) throw ctx.fail("An edge of a curved face could not be carried over.");
        const edge = ctx.own(mk.Edge());
        oc.BRepLib.BuildCurves3d(edge);
        run.push(edge);
      }
      edges.push(...(reversed ? run.reverse() : run));
    }
    // in the order the outline runs: a face that closes on itself has two edges in one place (its seam), and
    // only their order says which side of the face each is on
    let mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    for (const e of edges) { mw.Add(oc.TopoDS.Edge(e)); if (!mw.IsDone()) break; }
    if (!mw.IsDone()) {
      const list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
      for (const e of edges) list.Append(e);
      mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
      mw.Add(list);
    }
    if (!mw.IsDone()) throw ctx.fail("A face's outline did not close after stretching.");
    return ctx.own(mw.Wire());
  });
  if (!built.length) throw ctx.fail("A face has no outline to stretch.");
  const mf = ctx.tmp(flat ? new oc.BRepBuilderAPI_MakeFace(plane, oc.TopoDS.Wire(built[0]), true) : new oc.BRepBuilderAPI_MakeFace(surface.s, oc.TopoDS.Wire(built[0]), true));
  for (const h of built.slice(1)) mf.Add(oc.TopoDS.Wire(h));
  if (!mf.IsDone()) throw ctx.fail("A face could not be rebuilt after stretching.");
  const fix = ctx.tmp(new oc.ShapeFix_Face(mf.Face()));
  fix.Perform();
  // the new surface faces the way the old one did, so the face is turned the way the old face was
  const made = ctx.own(fix.Face());
  return F.Orientation() === oc.TopAbs_Orientation.TopAbs_REVERSED ? ctx.own(made.Reversed()) : made;
}

/**
 * A solid stretched by `factors` about `origin`.  Returns the new solid and, for each face of the old one in
 * the kernel's order, the face of the new one that came from it (null when it could not be told).
 */
export function stretchSolid(ctx: EvalContext, solid: Shape, origin: Vec3, factors: Vec3): { shape: Shape; faces: (Shape | null)[] } {
  const oc = ctx.oc as Any, k = ctx.k;
  const s: Stretch = {
    at: (p) => [origin[0] + (p[0] - origin[0]) * factors[0], origin[1] + (p[1] - origin[1]) * factors[1], origin[2] + (p[2] - origin[2]) * factors[2]],
    dir: (v) => [v[0] * factors[0], v[1] * factors[1], v[2] * factors[2]],
  };
  const old = k.sub(solid, "face"), fresh = old.map((f) => stretchedFace(ctx, f, s));
  const sewing = ctx.tmp(new oc.BRepBuilderAPI_Sewing(1e-4 * Math.max(1, ...factors), true, true, true, false));
  for (const f of fresh) sewing.Add(f);
  sewing.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  const parts: Shape[] = [];
  for (const shell of k.sub(ctx.own(sewing.SewedShape()), "shell")) {
    if (!oc.BRep_Tool.IsClosed(shell)) throw ctx.fail("The stretched faces did not close into a solid. Parts with faces that end in a point (a full sphere, a cone's tip) may not stretch unevenly.");
    const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shell)));
    // the faces are turned to agree with one another and to face out of the solid
    const fixer = ctx.tmp(new oc.ShapeFix_Solid());
    const part = ctx.own(fixer.SolidFromShell(oc.TopoDS.Shell(shell)));
    oc.BRepLib.OrientClosedSolid(part);
    parts.push(part);
  }
  if (!parts.length) throw ctx.fail("The stretched faces did not close into a solid.");
  // the largest piece is the outside; the others are the hollows in it
  parts.sort((a, b) => Math.abs(k.volume(b)) - Math.abs(k.volume(a)));
  let shape = parts[0];
  for (const hollow of parts.slice(1)) {
    const cut = ctx.tmp(new oc.BRepAlgoAPI_Cut(shape, hollow, ctx.tmp(new oc.Message_ProgressRange())));
    cut.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!cut.IsDone()) throw ctx.fail("A hollow of the part could not be put back after stretching.");
    const out = k.solids(ctx.own(cut.Shape()));
    if (out.length !== 1) throw ctx.fail("A hollow of the part could not be put back after stretching.");
    shape = out[0];
  }
  const want = k.volume(solid) * factors[0] * factors[1] * factors[2], got = k.volume(shape);
  const sound = ctx.tmp(new oc.BRepCheck_Analyzer(shape, true, false, false)).IsValid();
  if (!sound || !(Math.abs(got - want) <= 2e-3 * Math.abs(want))) throw ctx.fail("This part cannot be stretched unevenly yet: a face of it that goes all the way round (a plain hole, a shaft) does not come back sound. Scale it evenly, or stretch it before such faces are made.");
  // which new face came from which old one: the nearest by its middle, among faces of about its area
  const result = k.sub(shape, "face"), mids = result.map((f) => k.centre(f, "face"));
  const faces = fresh.map((f) => {
    const c = k.centre(f, "face");
    let best = -1, d = Infinity;
    mids.forEach((m, i) => { const x = length(sub(m, c)); if (x < d) { d = x; best = i; } });
    return best >= 0 && d < 1e-3 * Math.max(1, length(c)) ? result[best] : null;
  });
  return { shape, faces };
}
