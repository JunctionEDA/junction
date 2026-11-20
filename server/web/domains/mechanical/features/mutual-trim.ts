// mutual-trim.ts — the Mutual trim feature: two surfaces that cross are each cut along the other, and one side
// of each is kept.
//
// Which side: each surface faces one way (its normal).  The part of the first surface on the side the second
// faces is kept, and the part of the second on the side the first faces; a tick box per surface keeps the other
// side instead.  Merge sews what is kept into one surface, which takes the first surface's place.
//
// Faces keep their names; a face cut in several kept pieces gets `~2`, … in a fixed order.
import { defineFeature } from "../core/feature";
import { dot, sub, type Vec3 } from "../core/geometry";
import type { Body, EvalContext, NamedShape } from "../kernel/types";
import { normalNear, sewNamed, sheetBody } from "../kernel/ops/surface";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MutualTrimParams { [key: string]: any; surfaces: string[]; flipFirst: boolean; flipSecond: boolean; merge: boolean }

/** The faces of `a` cut along `b`, with the names they had. */
function cutBy(ctx: EvalContext, a: Body, b: Body): { pieces: NamedShape[]; cut: boolean } {
  const oc = ctx.oc as any, k = ctx.k;
  const sp = ctx.own(new oc.BRepAlgoAPI_Splitter());
  const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()), tools = ctx.tmp(new oc.NCollection_List_TopoDS_Shape());
  args.Append(a.shape); tools.Append(b.shape);
  sp.SetArguments(args); sp.SetTools(tools);
  sp.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!sp.IsDone()) throw ctx.fail("The surfaces could not be trimmed against each other.");
  const pieces: NamedShape[] = [];
  let cut = false;
  for (const f of a.topo.faces) {
    const images = k.list(sp.Modified(f.shape));
    if (images.length > 1) cut = true;
    if (images.length) for (const im of images) pieces.push({ name: f.name, shape: im });
    else if (!sp.IsDeleted(f.shape)) pieces.push({ name: f.name, shape: f.shape });
  }
  return { pieces, cut };
}

/** Which side of a surface a point is on: positive the way the surface faces. */
function sideOf(ctx: EvalContext, surface: Body, p: Vec3): number {
  const oc = ctx.oc as any, k = ctx.k;
  // the face of the surface nearest the point, and where on it
  const v = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt(p)))).Vertex());
  let best: { d: number; face: NamedShape; at: Vec3 } | null = null;
  for (const f of surface.topo.faces) {
    const ex = ctx.tmp(new oc.BRepExtrema_DistShapeShape());
    ex.LoadS1(v); ex.LoadS2(f.shape);
    ex.Perform(ctx.tmp(new oc.Message_ProgressRange()));
    if (!ex.IsDone() || !ex.NbSolution()) continue;
    const q = ctx.tmp(ex.PointOnShape2(1));
    if (!best || ex.Value() < best.d) best = { d: ex.Value(), face: f, at: k.xyz(q) };
  }
  if (!best) return 0;
  return dot(sub(p, best.at), normalNear(ctx, best.face.shape, best.at));
}

export default defineFeature<MutualTrimParams>({
  type: "mutual-trim",
  title: "Mutual trim",
  icon: '<path class="f" d="M2.5 14l7-4h6l-7 4zM8.500 8l7-4v6l-7 4z"/><path d="M8.500 14h-6l7-4M8.500 14V8l7-4v6h-6M8.500 14l7-4"/><path class="d" d="M15.500 10h6l-7 4h-6M8.500 14v6l7-4v-6"/>',
  toolbarOrder: 60, toolbarSection: "surface", toolbarKeep: 33,
  hint: "Cut two crossing surfaces along each other and keep one side of each.",
  keywords: "surface trim intersect cut knit cross",
  defaults: () => ({ surfaces: [], flipFirst: false, flipSecond: false, merge: true }),
  schema: [
    { key: "surfaces", label: "Surfaces to trim", kind: "bodies", hint: "Two surfaces that cross." },
    { key: "flipFirst", label: "Keep the other side of the first", kind: "boolean" },
    { key: "flipSecond", label: "Keep the other side of the second", kind: "boolean" },
    { key: "merge", label: "Merge into one surface", kind: "boolean" },
  ],

  evaluate(ctx: EvalContext, p: MutualTrimParams) {
    const k = ctx.k;
    const ids = Array.isArray(p.surfaces) ? p.surfaces : [];
    if (ids.length !== 2) throw ctx.fail("Pick the two surfaces to trim against each other.");
    const a = sheetBody(ctx, ids[0]), b = sheetBody(ctx, ids[1]);
    if (a === b) throw ctx.fail("Pick two different surfaces.");
    const ca = cutBy(ctx, a, b), cb = cutBy(ctx, b, a);
    if (!ca.cut && !cb.cut) throw ctx.fail("The surfaces do not cross, so there is nothing to trim.");
    const keep = (pieces: NamedShape[], other: Body, flip: boolean) => pieces.filter((f) => { const s = sideOf(ctx, other, k.centre(f.shape, "face")); return flip ? s < 0 : s > 0; });
    const ka = keep(ca.pieces, b, !!p.flipFirst), kb = keep(cb.pieces, a, !!p.flipSecond);
    if (!ka.length || !kb.length) throw ctx.fail("Nothing of a surface is left on that side. Keep its other side.");
    if (p.merge) {
      const sheets = sewNamed(ctx, [...ka, ...kb]);
      ctx.replaceBody(a, sheets[0].shape, sheets[0].names);
      ctx.removeBody(b);
      sheets.slice(1).forEach((s, i) => ctx.addBody(s.shape, s.names, { suffix: `s${i + 2}` }));
      return;
    }
    for (const [body, kept] of [[a, ka], [b, kb]] as [Body, NamedShape[]][]) {
      const sheets = sewNamed(ctx, kept);
      ctx.replaceBody(body, sheets[0].shape, sheets[0].names);
      sheets.slice(1).forEach((s, i) => ctx.addBody(s.shape, s.names, { suffix: `${body.id}.piece${i + 2}`, name: `${body.name} (${i + 2})` }));
    }
  },
});
