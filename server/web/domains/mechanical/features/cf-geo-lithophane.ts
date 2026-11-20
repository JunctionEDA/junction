// cf-geo-lithophane.ts — the Height map: a plate whose thickness follows a picture (a lithophane: held to the
// light, the thick places are dark and the picture shows), or follows an equation z(x, y).  The relief is one
// smooth surface through a grid of heights, not a mesh of facets, so the part is a small B-rep that later
// features can cut and fillet.
//
// A picture is one a sketch holds (the sketcher's Image tool); the plate lies where the sketch shows the
// picture, its back on the sketch plane.  An equation's plate is centred on a plane's origin.
//
// Names: `<id>:relief` (the shaped face), `<id>:back`, and `<id>:side`, `:side~2`… for the four edges.
import { defineFeature } from "../core/feature";
import type { Frame } from "../core/geometry";
import type { EvalContext, NamedShape, Shape } from "../kernel/types";
import { applyTools, boxIn, frameToFrame, prismOf, scopeOf } from "../kernel/ops/cf-geo";
import { planeOf } from "../kernel/ops/ref-geom";
import { compileExpr, type Compiled } from "./_cf-geo";
import { brightness, decodePicture, pictureIn, type Picture } from "./_cf-geo-image";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LithophaneParams {
  [key: string]: any;
  source: "picture" | "equation"; picture: string[]; plane: RefTarget | null; equation: string; width: number; length: number;
  min: number; max: number; samples: number; invert: boolean; operation: "new" | "add"; bodies: string[];
}

const UNIT: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };

export default defineFeature<LithophaneParams>({
  type: "cf-geo-lithophane",
  title: "Height map",
  hint: "A plate whose thickness follows a picture (a lithophane) or an equation z(x, y).",
  keywords: "lithophane height map heightmap image picture photo relief displacement bump map terrain equation surface z(x,y) emboss image",
  icon: '<path class="f" d="M3 18.500l4-6 3.500 3 3.500-7 3 4.500 4-2.500v8z"/><path d="M3 18.500l4-6 3.500 3 3.500-7 3 4.500 4-2.500v8z"/><circle class="t" cx="7" cy="6.500" r="2"/>',
  toolbarOrder: 311, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ source: "picture", picture: [], plane: null, equation: "2 + 1.5*sin(x/6)*cos(y/6)", width: 60, length: 40, min: 0.8, max: 3, samples: 80, invert: false, operation: "new", bodies: [] }),
  schema: [
    { key: "source", label: "Heights from", kind: "enum", options: [{ value: "picture", label: "Picture" }, { value: "equation", label: "Equation" }] },
    { key: "picture", label: "Picture", kind: "features", types: ["sketch"], hint: "A sketch with a picture in it (the sketch's Image tool). The plate is as large as the picture is drawn.", visible: (p) => p.source !== "equation" },
    { key: "plane", label: "Plane", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "The plate's back lies on it, centred on its origin.", visible: (p) => p.source === "equation" },
    { key: "equation", label: "z(x, y) =", kind: "text", hint: "The thickness in mm at x, y (mm from the middle). Angles in radians: sin, cos, sqrt, abs, exp, pi…", visible: (p) => p.source === "equation" },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.1, step: 5, visible: (p) => p.source === "equation" },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.1, step: 5, visible: (p) => p.source === "equation" },
    { key: "min", label: "Thinnest", kind: "number", unit: "mm", min: 0.01, step: 0.1, hint: "Where the picture is white. An equation is not let below it." },
    { key: "max", label: "Thickest", kind: "number", unit: "mm", min: 0.02, step: 0.1, hint: "Where the picture is black.", visible: (p) => p.source !== "equation" },
    { key: "invert", label: "Invert", kind: "boolean", hint: "Thick where the picture is light.", visible: (p) => p.source !== "equation" },
    { key: "samples", label: "Detail", kind: "number", unit: "none", min: 4, max: 200, step: 10, hint: "Heights along the longer side. More shows finer detail and takes longer to build." },
    { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] },
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body.", visible: (p) => p.operation === "add" },
  ],

  async evaluate(ctx: EvalContext, p: LithophaneParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!(p.min > 0)) throw ctx.fail("The thinnest place must be thicker than zero.");
    const detail = Math.round(Number(p.samples));
    if (!(detail >= 4) || detail > 200) throw ctx.fail("The detail is between 4 and 200 heights along the longer side.");
    // the plate's rectangle in its frame (x0, y0 the lower left corner), and the height at each place
    let frame: Frame, x0: number, y0: number, w: number, l: number, heightAt: (u: number, v: number, du: number, dv: number) => number;
    if (p.source === "equation") {
      if (!(p.width > 0) || !(p.length > 0)) throw ctx.fail("The width and the length must be more than zero.");
      let z: Compiled;
      try { z = compileExpr(p.equation, ["x", "y"], "z(x, y)"); } catch (e) { throw ctx.fail((e as Error).message); }
      frame = p.plane ? planeOf(ctx, p.plane, "plane") : UNIT;
      w = p.width; l = p.length; x0 = -w / 2; y0 = -l / 2;
      heightAt = (u, v) => { const h = z({ x: x0 + u * w, y: y0 + v * l }); if (!Number.isFinite(h)) throw ctx.fail("The equation has no value somewhere on the plate (a division by zero, the root of a negative number)."); return Math.max(p.min, h); };
    } else {
      if (!(p.max > p.min)) throw ctx.fail("The thickest place must be thicker than the thinnest.");
      const sid = Array.isArray(p.picture) ? p.picture[0] : null;
      if (!sid) throw ctx.fail("Pick the sketch that holds the picture.");
      const sk = ctx.sketch(sid), found = pictureIn(sk.data);
      if (!found) throw ctx.fail("That sketch has no picture in it. Put one there with the sketch's Image tool.");
      let pic: Picture;
      try { pic = await decodePicture(found.src); } catch (e) { throw ctx.fail(e instanceof Error ? e.message : String(e)); }
      frame = sk.frame;
      x0 = Math.min(found.a[0], found.b[0]); y0 = Math.min(found.a[1], found.b[1]);
      w = Math.abs(found.b[0] - found.a[0]); l = Math.abs(found.b[1] - found.a[1]);
      if (!(w > 1e-6) || !(l > 1e-6)) throw ctx.fail("The picture has no size in its sketch.");
      heightAt = (u, v, du, dv) => { const dark = 1 - brightness(pic, u, 1 - v, du, dv); return p.min + (p.max - p.min) * (p.invert ? 1 - dark : dark); };
    }
    const nx = Math.max(4, Math.round(w >= l ? detail : (detail * w) / l)), ny = Math.max(4, Math.round(l > w ? detail : (detail * l) / w));
    // a smooth surface through the heights, built over the unit frame and then carried to the plate's
    // (the surface is carried one step past the plate on every side, repeating the edge's heights, so that the
    // plate's sides are cut by flat planes and not by the surface's own rim)
    const dx = w / (nx - 1), dy = l / (ny - 1), clamp = (v: number) => Math.max(0, Math.min(1, v));
    const zs = ctx.tmp(new oc.NCollection_Array2_double(1, nx + 2, 1, ny + 2));
    let top = 0;
    for (let i = -1; i <= nx; i++) for (let j = -1; j <= ny; j++) { const h = heightAt(clamp(i / (nx - 1)), clamp(j / (ny - 1)), 1 / (nx - 1), 1 / (ny - 1)); top = Math.max(top, h); zs.SetValue(i + 2, j + 2, h); }
    const fit = ctx.tmp(new oc.GeomAPI_PointsToBSplineSurface());
    try { fit.Interpolate(zs, x0 - dx, dx, y0 - dy, dy); } catch (e) { throw ctx.fail(`The relief could not be built (${k.describe(e)}).`); }
    if (!fit.IsDone()) throw ctx.fail("The relief could not be built from these heights.");
    const relief = ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeFace(fit.Surface(), 1e-6)).Face());
    // everything under the relief, down to the back: the relief pushed down past the back, and of that what lies
    // in the plate's own box (a smooth surface rises a little over its highest height between the heights)
    const reach = top * 1.5 + 1;
    const under = prismOf(ctx, relief, [0, 0, -(reach + 1)]);
    const slab = boxIn(ctx, UNIT, x0, y0, x0 + w, y0 + l, 0, reach + 1);
    const algo = ctx.tmp(new oc.BRepAlgoAPI_Common(under, slab, ctx.tmp(new oc.Message_ProgressRange())));
    algo.Build(ctx.tmp(new oc.Message_ProgressRange()));
    if (!algo.IsDone() || algo.HasErrors()) throw ctx.fail("The plate could not be built under the relief.");
    const solids = k.solids(ctx.own(algo.Shape()));
    if (solids.length !== 1) throw ctx.fail("The plate could not be built under the relief.");
    const placed = ctx.tmp(new oc.BRepBuilderAPI_Transform(solids[0], frameToFrame(ctx, UNIT, frame), true, false));
    const shape: Shape = ctx.own(placed.Shape());
    const faces = k.sub(shape, "face"), names = faces.map((f) => {
      const flat = k.faceFrame(oc.TopoDS.Face(f));
      if (!flat) return `${id}:relief`;
      const d = flat.normal[0] * frame.normal[0] + flat.normal[1] * frame.normal[1] + flat.normal[2] * frame.normal[2];
      return Math.abs(d) > 0.999 ? `${id}:back` : `${id}:side`;
    });
    k.settleNames(faces, names, `${id}:new`, "face");
    const named: NamedShape[] = faces.map((f, i) => ({ name: names[i]!, shape: f }));
    applyTools(ctx, [{ shape, faces: named }], p.operation === "add" ? "add" : "new", p.operation === "add" ? scopeOf(ctx, p.bodies, null) : [], "Height map");
  },
});
