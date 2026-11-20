// thicken.ts — a sheet (one face, or faces joined along edges) given thickness: the sheet offset to each side,
// and walls between the two offsets along the sheet's free edges, sewn into a solid.  Used by Thicken and Wrap.
// Also sewing faces into a closed solid.
//
// A flat face is simply extruded.  Anything else is offset face by face (the kernel's "simple" offset, which
// keeps one face per face and one edge per edge, so the walls can be ruled between an edge and its offset).
import { scale, type Vec3 } from "../../core/geometry";
import { ShapeIndex } from "../occ";
import type { EvalContext, Shape } from "../types";
import { normalAt, pointOn } from "./cells";
import { distance } from "./shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** Sew faces along their shared edges.  Returns the sewn shape (a shell, or a compound of shells and faces). */
export function sew(ctx: EvalContext, faces: readonly Shape[], tol = 1e-4): Shape {
  const oc = ctx.oc as Any;
  const s = ctx.tmp(new oc.BRepBuilderAPI_Sewing(tol, true, true, true, false));
  for (const f of faces) s.Add(f);
  s.Perform(ctx.tmp(new oc.Message_ProgressRange()));
  return ctx.own(s.SewedShape());
}

/** A solid from faces that close a volume, or null when they leave a gap. */
export function solidFromFaces(ctx: EvalContext, faces: readonly Shape[], tol = 1e-4): Shape | null {
  const oc = ctx.oc as Any, k = ctx.k;
  const sewn = sew(ctx, faces, tol);
  const shells = k.sub(sewn, "shell");
  if (shells.length !== 1) return null;
  if (!oc.BRep_Tool.IsClosed(shells[0])) return null;
  const mk = ctx.tmp(new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shells[0])));
  if (!mk.IsDone()) return null;
  const solid = ctx.own(mk.Solid());
  oc.BRepLib.OrientClosedSolid(solid);
  return k.volume(solid) > 1e-12 ? solid : null;
}

/** The edges of a sheet that only one of its faces uses. */
export function freeEdges(ctx: EvalContext, sheet: Shape): Shape[] {
  const k = ctx.k, oc = ctx.oc as Any;
  const count = new ShapeIndex<{ edge: Shape; n: number }>(k);
  const all: { edge: Shape; n: number }[] = [];
  for (const f of k.sub(sheet, "face")) for (const e of k.sub(f, "edge")) {
    if (oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(e))) continue;
    const have = count.get(e);
    if (have) have.n++; else { const rec = { edge: e, n: 1 }; count.add(e, rec); all.push(rec); }
  }
  // a seam (one edge used twice by one face, as on a whole cylinder) is not free
  return all.filter((r) => r.n === 1 && !k.sub(sheet, "face").some((f) => oc.BRep_Tool.IsClosed(oc.TopoDS.Edge(r.edge), oc.TopoDS.Face(f)))).map((r) => r.edge);
}

function wire(ctx: EvalContext, edge: Shape): Shape {
  const oc = ctx.oc as Any;
  return ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeWire(oc.TopoDS.Edge(edge))).Wire());
}

/** The ruled faces between an edge and another with the same run (an edge and its offset). */
function ruled(ctx: EvalContext, a: Shape, b: Shape): Shape[] {
  const oc = ctx.oc as Any, k = ctx.k;
  const mk = ctx.own(new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6));
  mk.AddWire(oc.TopoDS.Wire(wire(ctx, a))); mk.AddWire(oc.TopoDS.Wire(wire(ctx, b)));
  mk.CheckCompatibility(false);
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("A side wall could not be built.");
  return k.sub(ctx.own(mk.Shape()), "face");
}

/**
 * Give a sheet thickness: `front` along the faces' normals and `back` against them (either may be zero).
 * `faces` must be one connected sheet.  Returns a solid.
 */
export function thickenSheet(ctx: EvalContext, faces: readonly Shape[], front: number, back: number): Shape {
  const oc = ctx.oc as Any, k = ctx.k;
  if (!(front >= 0) || !(back >= 0) || !(front + back > 1e-7)) throw ctx.fail("The thickness must be more than zero.");
  if (!faces.length) throw ctx.fail("Pick the faces to thicken.");
  if (faces.length === 1) {
    const frame = k.faceFrame(oc.TopoDS.Face(faces[0]));
    if (frame) {
      // flat: move the face back, then extrude it through both thicknesses
      let start = faces[0];
      if (back > 0) {
        const t = ctx.tmp(new oc.gp_Trsf()); t.SetTranslation(ctx.tmp(k.vec(scale(frame.normal, -back))));
        start = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_Transform(faces[0], t, true, false)).Shape());
      }
      const mk = ctx.own(new oc.BRepPrimAPI_MakePrism(start, ctx.tmp(k.vec(scale(frame.normal, front + back))), false, true));
      mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
      if (!mk.IsDone()) throw ctx.fail("The face could not be thickened.");
      return ctx.own(mk.Shape());
    }
  }
  const sheet = faces.length === 1 ? faces[0] : sew(ctx, faces);
  if (faces.length > 1 && k.sub(sheet, "shell").length !== 1) throw ctx.fail("The faces to thicken must join along their edges into one sheet. Thicken separate faces with separate features.");
  const probe = k.sub(sheet, "face")[0];
  const at = pointOn(ctx, probe), n = normalAt(ctx, probe);
  const side = (d: number): { shape: Shape; image: (e: Shape) => Shape | null } => {
    if (!(Math.abs(d) > 1e-9)) return { shape: sheet, image: (e) => e };
    const many = k.sub(sheet, "face").length > 1;
    const build = (v: number) => {
      const mk = ctx.own(new oc.BRepOffsetAPI_MakeOffsetShape());
      try {
        // several faces must be carried on to meet again at the edges between them; one face has nothing to meet
        if (many) mk.PerformByJoin(sheet, v, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Intersection, false, ctx.tmp(new oc.Message_ProgressRange()));
        else mk.PerformBySimple(sheet, v);
      } catch (e) { throw ctx.fail(`The faces could not be offset (${k.describe(e)}). Try a smaller thickness.`); }
      if (!mk.IsDone()) throw ctx.fail("The faces could not be offset. Try a smaller thickness.");
      return mk;
    };
    let mk = build(d), shape: Shape = ctx.own(mk.Shape());
    // the offset must lie on the side asked for, whichever way the kernel reads the faces
    const want: Vec3 = [at[0] + n[0] * d, at[1] + n[1] * d, at[2] + n[2] * d];
    const vertex = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(want)))).Vertex());
    if (distance(k, vertex, shape) > Math.abs(d) * 0.5) { mk = build(-d); shape = ctx.own(mk.Shape()); }
    // the offset of an edge: the free edge of the offset sheet that runs |d| from it
    const mine = freeEdges(ctx, shape);
    const midOf = (e: Shape): Shape => {
      const ad = ctx.tmp(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(e)));
      const q = ad.Value(ad.FirstParameter() + (ad.LastParameter() - ad.FirstParameter()) * 0.37);
      const v = ctx.own(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(q)).Vertex()); q.delete();
      return v;
    };
    return {
      shape,
      image: (e) => {
        const m = midOf(e);
        let best: Shape | null = null, err = Math.abs(d) * 0.25 + 1e-6;
        for (const c of mine) { const x = Math.abs(distance(k, m, c) - Math.abs(d)); if (x < err) { err = x; best = c; } }
        return best;
      },
    };
  };
  const a = side(front), b = side(-back);
  const all: Shape[] = [...k.sub(a.shape, "face"), ...k.sub(b.shape, "face")];
  for (const e of freeEdges(ctx, sheet)) {
    const ea = a.image(e), eb = b.image(e);
    if (!ea || !eb) throw ctx.fail("The faces could not be thickened: an edge has no offset.");
    all.push(...ruled(ctx, ea, eb));
  }
  const solid = solidFromFaces(ctx, all, 1e-3);
  if (!solid) throw ctx.fail("The faces could not be thickened into a closed solid. Try a smaller thickness.");
  return solid;
}
