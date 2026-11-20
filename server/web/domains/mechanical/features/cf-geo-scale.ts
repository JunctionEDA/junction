// cf-geo-scale.ts — Scale: make bodies larger or smaller, evenly, or by a different factor along each of X, Y
// and Z (a shrink allowance that differs with the print direction, a part stretched to a new length).
//
// Even scaling is exact for any body.  Uneven scaling rebuilds the body face by face (kernel/ops/
// cf-geo-scale.ts): flat faces and straight edges are exact, round faces become smooth free-form faces within
// about a millionth of their radius of the true stretched shape (a round hole becomes an ellipse to that
// accuracy).  NOT DONE: a part with a face that goes all the way round (a plain drilled hole, a turned shaft)
// is refused with a message when scaled unevenly: such a face does not come back as a sound face.  Parts of flat
// faces, fillets, free-form faces and round faces of less than a turn (a slot's ends, a wing) are stretched.
// The scaling is about the origin, the bodies' middle, or a picked point.
//
// Names: every face keeps its name; a copy is a body of its own, `<id>:<body id>`.
import { defineFeature } from "../core/feature";
import type { Vec3 } from "../core/geometry";
import { ShapeIndex } from "../kernel/occ";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { tightBox } from "../kernel/ops/cf-geo";
import { stretchSolid } from "../kernel/ops/cf-geo-scale";
import { pointOf } from "../kernel/ops/ref-geom";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ScaleParams { [key: string]: any; bodies: string[]; even: boolean; factor: number; x: number; y: number; z: number; about: "origin" | "centre" | "point"; point: RefTarget | null; copy: boolean }

export default defineFeature<ScaleParams>({
  type: "cf-geo-scale",
  title: "Scale",
  hint: "Scale bodies evenly, or by different factors along X, Y and Z (uneven: parts without faces that go all the way round).",
  keywords: "scale non-uniform nonuniform stretch resize shrink compensation shrinkage enlarge factor anisotropic",
  icon: '<rect class="f" x="3.500" y="12" width="8.500" height="8.500" rx="1"/><rect x="3.500" y="12" width="8.500" height="8.500" rx="1"/><rect class="d" x="3.500" y="3.500" width="17" height="17" rx="1.500"/><path d="M14 10l5.500-5.500M15.500 4.500h4v4"/>',
  toolbarOrder: 337, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], even: false, factor: 1.5, x: 1, y: 1, z: 1.5, about: "centre", point: null, copy: false }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Click the bodies to scale." },
    { key: "even", label: "Evenly", kind: "boolean", hint: "One factor in every direction." },
    { key: "factor", label: "Factor", kind: "number", unit: "none", min: 0.001, step: 0.1, visible: (p) => !!p.even },
    { key: "x", label: "Factor X", kind: "number", unit: "none", min: 0.001, step: 0.1, visible: (p) => !p.even },
    { key: "y", label: "Factor Y", kind: "number", unit: "none", min: 0.001, step: 0.1, visible: (p) => !p.even },
    { key: "z", label: "Factor Z", kind: "number", unit: "none", min: 0.001, step: 0.1, visible: (p) => !p.even },
    { key: "about", label: "About", kind: "enum", options: [{ value: "centre", label: "Middle" }, { value: "origin", label: "Origin" }, { value: "point", label: "Point" }], hint: "The place that stays where it is." },
    { key: "point", label: "Point", kind: "refs", of: ["vertex", "edge", "face"], single: true, datums: ["point"], sketch: true, visible: (p) => p.about === "point" },
    { key: "copy", label: "Copy", kind: "boolean", hint: "Keep the bodies as they are and scale copies." },
  ],

  evaluate(ctx: EvalContext, p: ScaleParams) {
    const oc = ctx.oc as any, k = ctx.k;
    const f: Vec3 = p.even ? [p.factor, p.factor, p.factor] : [p.x, p.y, p.z];
    if (!f.every((v) => v > 0 && v <= 1000)) throw ctx.fail("A factor must be more than zero (and at most 1000). 1 leaves that direction as it is.");
    if (f.every((v) => Math.abs(v - 1) < 1e-12)) throw ctx.fail("Every factor is 1: nothing would change. Enter a factor.");
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    if (!ids.length) throw ctx.fail("Pick the bodies to scale.");
    const bodies = ids.map((b) => ctx.body(b));
    if (bodies.some((b) => !b)) throw ctx.fail("A body to scale is gone. Edit the feature and pick it again.");
    let origin: Vec3 = [0, 0, 0];
    if (p.about === "point") origin = pointOf(ctx, p.point, "point to scale about");
    else if (p.about !== "origin") { const b = tightBox(ctx, (bodies as Body[]).map((x) => x.shape)); if (b) origin = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]; }
    const even = Math.abs(f[0] - f[1]) < 1e-12 && Math.abs(f[1] - f[2]) < 1e-12;
    for (const body of bodies as Body[]) {
      const index = new ShapeIndex<string>(k);
      let shape: Shape;
      if (even) {
        const t = ctx.tmp(new oc.gp_Trsf());
        t.SetScale(ctx.tmp(k.pnt(origin)), f[0]);
        const mk = ctx.tmp(new oc.BRepBuilderAPI_Transform(body.shape, t, true, false));
        shape = ctx.own(mk.Shape());
        for (const face of body.topo.faces) index.add(ctx.own(mk.ModifiedShape(face.shape)), face.name);
      } else {
        if (body.sheet) throw ctx.fail(`${body.name} is a surface. Uneven scaling works on solid parts; scale it evenly instead.`);
        const solids = k.solids(body.shape);
        if (solids.length !== 1) throw ctx.fail(`${body.name} is not one solid. Uneven scaling works on single solid parts.`);
        const old = k.sub(solids[0], "face"), names = new ShapeIndex<string>(k);
        for (const face of body.topo.faces) names.add(face.shape, face.name);
        const r = stretchSolid(ctx, solids[0], origin, f);
        shape = r.shape;
        r.faces.forEach((nf, i) => { const name = names.get(old[i]); if (nf && name && !index.has(nf)) index.add(nf, name); });
      }
      const namer = (face: any) => index.get(face) ?? null;
      if (p.copy) ctx.addBody(shape, namer, { suffix: body.id, name: `${body.name} scaled` });
      else ctx.replaceBody(body, shape, namer);
    }
  },
});
