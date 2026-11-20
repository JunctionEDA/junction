// wrap.ts — a flat sketch region laid round a cylinder, as a face of the cylinder.
//
// The sketch plane must be parallel to the cylinder's axis.  Lengths along the axis stay as they are; lengths
// across it become arc lengths round the cylinder, measured from the line of the plane nearest the axis (where
// a tangent plane touches).  In the cylinder's own (angle, height) coordinates that is a plain stretch of the
// sketch, so a straight line stays a straight line there (a helix on the cylinder) and is built exactly; any
// other curve is followed through points along it.
import { cross, dot, length, normalize, scale, sub, type Vec3 } from "../../core/geometry";
import type { EvalContext, Shape, SketchGeometry, SketchRegion } from "../types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface Cylinder { origin: Vec3; dir: Vec3; radius: number }

export function wrapRegion(ctx: EvalContext, sketch: SketchGeometry, region: SketchRegion, cyl: Cylinder, radius = cyl.radius): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  const A = normalize(cyl.dir), n = sketch.frame.normal;
  if (Math.abs(dot(A, n)) > 1e-6) throw ctx.fail("The sketch plane must be parallel to the cylinder's axis to wrap round it.");
  // the direction from the axis to the sketch plane (or along the normal when the axis lies in the plane)
  const off = dot(sub(sketch.frame.origin, cyl.origin), n);
  const X: Vec3 = scale(n, off < -1e-9 ? -1 : 1);
  const Y = cross(A, X);
  // u = 0 is on the far side from where the sketch touches, so a wrap of up to a full turn never crosses the seam
  const ax3 = ctx.tmp(new oc.gp_Ax3(ctx.tmp(k.pnt(cyl.origin)), ctx.tmp(k.dir(A)), ctx.tmp(k.dir(scale(X, -1)))));
  const surface = new oc.Geom_CylindricalSurface(ax3, radius);   // kept alive by the edges and the face on it
  const uv = (p: Vec3): [number, number] => { const r = sub(p, cyl.origin); return [Math.PI + dot(r, Y) / cyl.radius, dot(r, A)]; };

  const wires: Shape[] = [];
  const turn = { min: Infinity, max: -Infinity };
  const face = oc.TopoDS.Face(region.face);
  const outer = oc.BRepTools.OuterWire(face);
  const all = k.sub(face, "wire");
  const ordered = [...all.filter((w) => w.IsSame(outer)), ...all.filter((w) => !w.IsSame(outer))];
  outer.delete();
  for (const w of ordered) {
    const list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
    for (const e of k.sub(w, "edge")) {
      const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
      const u0 = ad.FirstParameter(), u1 = ad.LastParameter();
      const at = (u: number): [number, number] => { const q = ad.Value(u); const out = uv(k.xyz(q)); q.delete(); return out; };
      let edge: Any;
      if (ad.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
        const a = at(u0), b = at(u1), len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-12) continue;
        const line = new oc.Geom2d_Line(ctx.tmp(new oc.gp_Pnt2d(a[0], a[1])), ctx.tmp(new oc.gp_Dir2d(b[0] - a[0], b[1] - a[1])));
        edge = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, len));
        for (const q of [a, b]) { turn.min = Math.min(turn.min, q[0]); turn.max = Math.max(turn.max, q[0]); }
      } else {
        const N = 48, pts = ctx.tmp(new oc.NCollection_Array1_gp_Pnt2d(1, N + 1));
        for (let i = 0; i <= N; i++) { const q = at(u0 + ((u1 - u0) * i) / N); pts.SetValue(i + 1, ctx.tmp(new oc.gp_Pnt2d(q[0], q[1]))); turn.min = Math.min(turn.min, q[0]); turn.max = Math.max(turn.max, q[0]); }
        const fit = ctx.tmp(new oc.Geom2dAPI_PointsToBSpline(pts, 3, 8, oc.GeomAbs_Shape.GeomAbs_C2, 1e-7));
        if (!fit.IsDone()) throw ctx.fail("A curve of the sketch could not be wrapped.");
        edge = ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(fit.Curve(), surface));
      }
      if (!edge.IsDone()) throw ctx.fail("A curve of the sketch could not be wrapped.");
      const made = ctx.own(edge.Edge());
      oc.BRepLib.BuildCurves3d(made);
      list.Append(made);
    }
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    mw.Add(list);
    if (!mw.IsDone()) throw ctx.fail("The wrapped outline does not close.");
    wires.push(ctx.own(mw.Wire()));
  }
  if (turn.max - turn.min > 2 * Math.PI - 1e-6) throw ctx.fail("The sketch is wider than the cylinder is round: it would wrap over itself.");
  if (turn.min < 1e-9 || turn.max > 2 * Math.PI - 1e-9) throw ctx.fail("The sketch reaches round to the back of the cylinder. Move it nearer the line where its plane meets the cylinder.");
  if (!wires.length) throw ctx.fail("The sketch region has no outline to wrap.");
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(surface, oc.TopoDS.Wire(wires[0]), true));
  for (const h of wires.slice(1)) mk.Add(oc.TopoDS.Wire(h));
  if (!mk.IsDone()) throw ctx.fail("The wrapped face could not be made.");
  // put the outline and the holes the right way round, whichever way they came
  const fix = ctx.tmp(new oc.ShapeFix_Face(mk.Face()));
  fix.Perform();
  const out = ctx.own(fix.Face());
  if (!(length(k.centre(out, "face")) >= 0)) throw ctx.fail("The wrapped face could not be made.");
  return out;
}
