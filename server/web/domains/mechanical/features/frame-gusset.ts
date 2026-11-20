// frame-gusset.ts — Gusset: a triangular plate in the corner where two straight frame members meet, lying in
// the plane of their axes against their inside faces, with its inner corner chamfered.
import { defineFeature } from "../core/feature";
import type { Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { extentAlong, frameStore, setItems } from "../kernel/ops/frame";
import { FRAME_SECTION } from "./_frame";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GussetParams { [key: string]: any; members: string[]; length: number; thickness: number; chamfer: number; offset: number }

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export default defineFeature<GussetParams>({
  type: "frame-gusset",
  title: "Gusset",
  icon: '<path class="f" d="M7 17V8l9 9z"/><path d="M4 20V4h3v13h13v3zM7 8l9 9"/>',
  hint: "Add a triangular plate where two frame members meet",
  keywords: "gusset plate corner brace frame weldment",
  toolbarSection: FRAME_SECTION, toolbarOrder: 30, toolbarKeep: 44,
  defaults: () => ({ members: [], length: 40, thickness: 5, chamfer: 5, offset: 0 }),
  schema: [
    { key: "members", label: "Members", kind: "bodies", hint: "Two straight members that meet at a corner." },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.1, step: 5, hint: "Along each member, from the inside corner." },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "chamfer", label: "Corner chamfer", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "offset", label: "Offset", kind: "number", unit: "mm", step: 1, hint: "Move the plate off the members' centre plane." },
  ],

  evaluate(ctx: EvalContext, p: GussetParams) {
    const k = ctx.k, oc = ctx.oc as any, store = frameStore(ctx);
    if (!p.members || p.members.length !== 2) throw ctx.fail("Pick the two frame members the gusset joins.");
    const [A, B] = p.members.map((id) => { const it = store[id], b = ctx.body(id); if (!it || !it.axis || !b) throw ctx.fail("Pick straight members made by Frame."); return { it, b }; });
    const a0 = A.it.axis![0], a1 = A.it.axis![1], b0 = B.it.axis![0], b1 = B.it.axis![1];
    const da = unit(sub(a1, a0)), db = unit(sub(b1, b0));
    const n = cross(da, db);
    if (Math.hypot(...n) < 1e-6) throw ctx.fail("The members are parallel: there is no corner for a gusset.");
    // the corner: where the axes meet (the closest points of the two lines)
    const w = sub(a0, b0), aa = 1, bb = dot(da, db), cc = 1, dd = dot(da, w), ee = dot(db, w), den = aa * cc - bb * bb;
    const s = (bb * ee - cc * dd) / den, tt = (aa * ee - bb * dd) / den;
    const C = add(a0, da, s), CB = add(b0, db, tt);
    if (Math.hypot(...sub(C, CB)) > 1e-3) throw ctx.fail("The members' axes do not meet: pick two members that share a corner.");
    // each member runs away from the corner towards its far end
    const ua = Math.hypot(...sub(a0, C)) > Math.hypot(...sub(a1, C)) ? unit(sub(a0, C)) : unit(sub(a1, C));
    const ub = Math.hypot(...sub(b0, C)) > Math.hypot(...sub(b1, C)) ? unit(sub(b0, C)) : unit(sub(b1, C));
    // the inside faces: how far each member reaches towards the other
    const ha = extentAlong(k, A.b.shape, C, ub)[1], hb = extentAlong(k, B.b.shape, C, ua)[1];
    const sin = Math.hypot(...cross(ua, ub));
    const P0 = add(add(C, ub, ha / sin), ua, hb / sin), L = p.length, c = Math.max(0, Math.min(p.chamfer || 0, L * 0.9));
    if (!(L > 0) || !(p.thickness > 0)) throw ctx.fail("The gusset's length and thickness must be more than zero.");
    const N = unit(cross(ua, ub)), base = N, off = (p.offset || 0) - p.thickness / 2;
    const pts: Vec3[] = (c > 0 ? [add(P0, ua, c), add(P0, ua, L), add(P0, ub, L), add(P0, ub, c)] : [P0, add(P0, ua, L), add(P0, ub, L)]).map((q) => add(q, base, off));
    const mw = ctx.tmp(new oc.BRepBuilderAPI_MakeWire());
    for (let i = 0; i < pts.length; i++) mw.Add(ctx.tmp(new oc.BRepBuilderAPI_MakeEdge(ctx.tmp(k.pnt(pts[i])), ctx.tmp(k.pnt(pts[(i + 1) % pts.length])))).Edge());
    const face = ctx.tmp(new oc.BRepBuilderAPI_MakeFace(mw.Wire(), true)).Face();
    const pr = ctx.tmp(new oc.BRepPrimAPI_MakePrism(face, ctx.tmp(k.vec([N[0] * p.thickness, N[1] * p.thickness, N[2] * p.thickness])), false, true));
    const shape = ctx.own(pr.Shape());
    const id = ctx.feature.id;
    const body = ctx.addBody(shape, (f) => { const fr = k.faceFrame(f as any); if (fr && Math.abs(dot(fr.normal, N)) > 0.99) return `${id}:${dot(fr.normal, N) > 0 ? "front" : "back"}`; return null; }, { name: `Gusset (${ctx.feature.name})` });
    setItems(ctx, [{ body: body.id, feature: id, kind: "gusset", label: `Gusset ${L}×${L}×${p.thickness}`, length: L, angles: [45, 45] }]);
  },
});
