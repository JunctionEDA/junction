// cf-geo-halftone.ts — the Halftone perforation: round holes on a grid or hex lattice over a flat face, each
// hole's diameter set by a gradient or by a picture, so that from a distance the holes read as the picture (a
// speaker grille that fades out, a logo in a vent).  Dark makes large holes, light small ones (or the other way
// round).  A picture is one a sketch holds (the sketcher's Image tool) and is read where the sketch shows it,
// looking square at the face; outside the picture there are no holes.
//
// Names: a hole's faces are `<id>:g<i>.<j>:<k>`, i and j its place in the lattice counted from the face's middle.
import { defineFeature } from "../core/feature";
import { add, scale, toPlane, toWorld, type GeomRef, type Vec2 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { OVERLAP, applyTools, cylinderOf, depthBehind, flatFace, tagged } from "../kernel/ops/cf-geo";
import { inRegion, lattice } from "./_cf-geo";
import { brightness, decodePicture, pictureIn } from "./_cf-geo-image";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HalftoneParams {
  [key: string]: any;
  face: GeomRef | null; source: "linear" | "radial" | "picture"; picture: string[]; angle: number; invert: boolean;
  layout: "grid" | "hex"; pitch: number; min: number; max: number; margin: number; through: boolean; depth: number;
}

export default defineFeature<HalftoneParams>({
  type: "cf-geo-halftone",
  title: "Halftone perforation",
  hint: "Holes over a flat face whose sizes follow a gradient or a picture.",
  keywords: "halftone perforation image picture gradient holes dots grille vent speaker logo photo variable hole size",
  icon: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle class="s" cx="6.500" cy="6.500" r=".6"/><circle class="s" cx="6.500" cy="12" r=".6"/><circle class="s" cx="6.500" cy="17.500" r=".6"/><circle class="s" cx="12" cy="6.500" r="1.300"/><circle class="s" cx="12" cy="12" r="1.300"/><circle class="s" cx="12" cy="17.500" r="1.300"/><circle class="s" cx="17.500" cy="6.500" r="2.100"/><circle class="s" cx="17.500" cy="12" r="2.100"/><circle class="s" cx="17.500" cy="17.500" r="2.100"/>',
  toolbarOrder: 307, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ face: null, source: "linear", picture: [], angle: 0, invert: false, layout: "hex", pitch: 6, min: 1, max: 5, margin: 4, through: true, depth: 1 }),
  schema: [
    { key: "face", label: "Face", kind: "refs", of: ["face"], single: true, hint: "A flat face to perforate." },
    { key: "source", label: "Sizes from", kind: "enum", options: [{ value: "linear", label: "Gradient" }, { value: "radial", label: "Radial" }, { value: "picture", label: "Picture" }] },
    { key: "picture", label: "Picture", kind: "features", types: ["sketch"], hint: "A sketch with a picture in it (the sketch's Image tool), lying over the face.", visible: (p) => p.source === "picture" },
    { key: "angle", label: "Gradient angle", kind: "number", unit: "deg", step: 15, hint: "The direction the holes grow in, in the face's plane.", visible: (p) => p.source === "linear" },
    { key: "invert", label: "Invert", kind: "boolean", hint: "Swap large and small: for a picture, light makes the large holes." },
    { key: "layout", label: "Layout", kind: "enum", options: [{ value: "hex", label: "Hex" }, { value: "grid", label: "Grid" }] },
    { key: "pitch", label: "Pitch", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "Centre to centre." },
    { key: "min", label: "Smallest hole", kind: "number", unit: "mm", min: 0, step: 0.25, hint: "Diameter. 0 leaves the lightest places solid." },
    { key: "max", label: "Largest hole", kind: "number", unit: "mm", min: 0.01, step: 0.25 },
    { key: "margin", label: "Margin", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "From a hole's rim to the face's edges." },
    { key: "through", label: "Through", kind: "boolean" },
    { key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.001, step: 0.5, visible: (p) => !p.through },
  ],

  async evaluate(ctx: EvalContext, p: HalftoneParams) {
    if (!(p.pitch > 0)) throw ctx.fail("The pitch must be more than zero.");
    if (!(p.min >= 0) || !(p.max > 0) || p.max < p.min) throw ctx.fail("The hole sizes: the smallest zero or more, the largest no smaller than it.");
    if (p.max >= p.pitch) throw ctx.fail("The largest hole must be smaller than the pitch, or the holes run into each other.");
    if (!(p.margin >= 0)) throw ctx.fail("The margin cannot be less than zero.");
    if (!p.through && !(p.depth > 0)) throw ctx.fail("The depth must be more than zero.");
    const f = flatFace(ctx, p.face);
    const [x0, y0, x1, y1] = f.box, mid: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2];
    // how dark each place is, 0 … 1
    let dark: (at: Vec2) => number | null;
    if (p.source === "picture") {
      const id = Array.isArray(p.picture) ? p.picture[0] : null;
      if (!id) throw ctx.fail("Pick the sketch that holds the picture.");
      const sk = ctx.sketch(id), found = pictureIn(sk.data);
      if (!found) throw ctx.fail("That sketch has no picture in it. Put one there with the sketch's Image tool.");
      let pic;
      try { pic = await decodePicture(found.src); } catch (e) { throw ctx.fail(e instanceof Error ? e.message : String(e)); }
      const ax = Math.min(found.a[0], found.b[0]), bx = Math.max(found.a[0], found.b[0]), ay = Math.min(found.a[1], found.b[1]), by = Math.max(found.a[1], found.b[1]);
      const du = p.pitch / (bx - ax), dv = p.pitch / (by - ay);
      dark = (at) => {
        const q = toPlane(sk.frame, toWorld(f.frame, at)), u = (q[0] - ax) / (bx - ax), v = (by - q[1]) / (by - ay);
        return u < 0 || u > 1 || v < 0 || v > 1 ? null : 1 - brightness(pic, u, v, du, dv);
      };
    } else if (p.source === "radial") {
      const reach = Math.hypot(x1 - x0, y1 - y0) / 2;
      dark = (at) => 1 - Math.min(1, Math.hypot(at[0] - mid[0], at[1] - mid[1]) / reach);
    } else {
      const a = ((Number(p.angle) || 0) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const span = Math.abs((x1 - x0) * c) + Math.abs((y1 - y0) * s) || 1;
      dark = (at) => Math.max(0, Math.min(1, 0.5 + ((at[0] - mid[0]) * c + (at[1] - mid[1]) * s) / span));
    }
    const sites = lattice(p.layout === "grid" ? "grid" : "hex", p.pitch, p.pitch, 0, mid, f.box, 60000);
    if (sites.some((s) => s.key === "too-many")) throw ctx.fail("The pitch is too small for this face: that is too many holes.");
    const depth = p.through ? depthBehind(ctx, f.body, f.frame.origin, f.frame.normal) : p.depth;
    const holes: { key: string; at: Vec2; d: number }[] = [];
    for (const s of sites) {
      const t = dark(s.at);
      if (t === null) continue;
      const d = p.min + (p.max - p.min) * (p.invert ? 1 - t : t);
      if (d < 0.05 || !inRegion(f.region, s.at, p.margin + d / 2)) continue;
      holes.push({ key: s.key, at: s.at, d });
    }
    if (!holes.length) throw ctx.fail(p.source === "picture" ? "No hole lands on the face: the picture does not lie over it, or is white there." : "No hole fits on the face with this pitch and margin.");
    if (holes.length > 3000) throw ctx.fail(`That is too many holes (${holes.length}; at most 3000). Use a larger pitch.`);
    const down = scale(f.frame.normal, -1);
    // one cylinder per size (to a hundredth of a millimetre) would share geometry, but every hole is its own tool
    // so that it has its own names; the cut is one boolean with all of them
    const tools = holes.map((h) => tagged(ctx, cylinderOf(ctx, add(toWorld(f.frame, h.at), scale(f.frame.normal, OVERLAP)), down, h.d / 2, depth + OVERLAP), h.key));
    applyTools(ctx, tools, "remove", [f.body]);
  },
});
