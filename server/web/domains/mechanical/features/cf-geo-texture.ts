// cf-geo-texture.ts — the Surface texture: one small shape repeated over a face on a grid or hex lattice.
// Domes (spherical caps), dimples (the same, sunk), hex studs, pyramids (a knurl's points), and ribs (bars
// across the face).  It works on a flat face and on a cylinder (round a grip, a knob), where the lattice is
// laid round and along it and every shape stands square to the surface, sunk by the little the round surface
// falls away under its foot so that it joins all the way round.
//
// Names: a shape's faces are `<id>:g<i>.<j>:<k>` (its place in the lattice); ribs trimmed to the face are
// `<id>:ribs:<k>`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, normalize, scale, sub, toWorld, type Frame, type GeomRef, type Vec2, type Vec3 } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { surfaceOf } from "../kernel/ops/cells";
import { OVERLAP, applyTools, boxIn, clipToFace, faceOfWires, flatFace, frameToFrame, polygonWire, prismOf, stamp, tagged } from "../kernel/ops/cf-geo";
import type { Instance, Tool } from "../kernel/ops/pattern-core";
import { frameFromNormal } from "../kernel/ops/ref-geom";
import { compound } from "../kernel/ops/shapes";
import { inRegion, lattice } from "./_cf-geo";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TextureParams { [key: string]: any; face: GeomRef | null; kind: "dome" | "dimple" | "hex" | "pyramid" | "rib"; layout: "grid" | "hex"; pitch: number; size: number; height: number; margin: number; angle: number }

const UNIT: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };


/**
 * One texture shape in the unit frame: `size` across at z = `foot`, its top at z = `height`, and carried on
 * down to z = `foot` − OVERLAP so that it does not end exactly on the face it stands on.
 */
function shapeOf(ctx: EvalContext, kind: string, size: number, height: number, foot: number): Shape {
  const oc = ctx.oc as any, k = ctx.k, a = size / 2, base = foot - OVERLAP;
  if (kind === "dome" || kind === "dimple") {
    // the cap of a sphere: `rise` high over a foot `size` across, and the little of the sphere under the foot
    const rise = height - foot, R = (a * a + rise * rise) / (2 * rise), centre = height - R;
    const ax = ctx.tmp(new oc.gp_Ax2(ctx.tmp(k.pnt([0, 0, centre])), ctx.tmp(k.dir([0, 0, 1]))));
    const mk = ctx.tmp(new oc.BRepPrimAPI_MakeSphere(ax, R, Math.asin(Math.max(-1, Math.min(1, (base - centre) / R))), Math.PI / 2));
    return ctx.own(mk.Shape());
  }
  const under: Frame = { ...UNIT, origin: [0, 0, base] };
  if (kind === "hex") {
    // `size` is the distance across the flats
    const r = a / Math.cos(Math.PI / 6), pts: Vec2[] = Array.from({ length: 6 }, (_v, i) => [r * Math.cos((Math.PI / 3) * i + Math.PI / 6), r * Math.sin((Math.PI / 3) * i + Math.PI / 6)] as Vec2);
    return prismOf(ctx, faceOfWires(ctx, under, polygonWire(ctx, under, pts)), [0, 0, height - base]);
  }
  // a pyramid: a square up to a point, its sides carried on down past the foot
  const b = (a * (height - base)) / (height - foot);
  const mk = ctx.tmp(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
  mk.AddWire(oc.TopoDS.Wire(polygonWire(ctx, under, [[-b, -b], [b, -b], [b, b], [-b, b]])));
  mk.AddVertex(ctx.tmp(ctx.tmp(new oc.BRepBuilderAPI_MakeVertex(ctx.tmp(k.pnt([0, 0, height])))).Vertex()));
  mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
  if (!mk.IsDone()) throw ctx.fail("The pyramid could not be built.");
  return ctx.own(mk.Shape());
}

export default defineFeature<TextureParams>({
  type: "cf-geo-texture",
  title: "Surface texture",
  hint: "Cover a flat or cylindrical face with domes, dimples, hex studs, pyramids or ribs.",
  keywords: "texture bumps dimples knurl grip studs pyramids ribs hex pattern surface tread anti slip golf ball",
  icon: '<path d="M3 17h18"/><path class="f" d="M4 17a2.500 2.500 0 0 1 5 0zM9.500 17a2.500 2.500 0 0 1 5 0zM15 17a2.500 2.500 0 0 1 5 0z"/><path d="M4 17a2.500 2.500 0 0 1 5 0M9.500 17a2.500 2.500 0 0 1 5 0M15 17a2.500 2.500 0 0 1 5 0"/><path class="t" d="M6.500 10.500a2 2 0 0 1 4 0M13.500 10.500a2 2 0 0 1 4 0M9.800 6a1.600 1.600 0 0 1 3.200 0"/>',
  toolbarOrder: 308, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ face: null, kind: "dome", layout: "hex", pitch: 6, size: 4, height: 1, margin: 3, angle: 0 }),
  schema: [
    { key: "face", label: "Face", kind: "refs", of: ["face"], single: true, hint: "A flat face or a cylinder." },
    { key: "kind", label: "Shape", kind: "enum", options: [{ value: "dome", label: "Domes" }, { value: "dimple", label: "Dimples" }, { value: "hex", label: "Hex studs" }, { value: "pyramid", label: "Pyramids" }, { value: "rib", label: "Ribs" }] },
    { key: "layout", label: "Layout", kind: "enum", options: [{ value: "hex", label: "Hex" }, { value: "grid", label: "Grid" }], visible: (p) => p.kind !== "rib" },
    { key: "pitch", label: "Pitch", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "Centre to centre." },
    { key: "size", label: "Size", kind: "number", unit: "mm", min: 0.05, step: 0.5, hint: "A dome's or dimple's diameter, a stud's width across its flats, a pyramid's side, a rib's width." },
    { key: "height", label: "Height", kind: "number", unit: "mm", min: 0.01, step: 0.25, hint: "How far it stands out of the face (a dimple: how deep it is)." },
    { key: "margin", label: "Margin", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Left plain along the face's edges." },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 15, hint: "Turns the lattice (and the ribs) on a flat face." },
  ],

  evaluate(ctx: EvalContext, p: TextureParams) {
    if (!(p.pitch > 0) || !(p.size > 0) || !(p.height > 0)) throw ctx.fail("The pitch, the size and the height must be more than zero.");
    if (!(p.margin >= 0)) throw ctx.fail("The margin cannot be less than zero.");
    if ((p.kind === "dome" || p.kind === "dimple") && p.height > p.size / 2) throw ctx.fail("A dome or dimple can be at most half as high as it is wide (a half sphere).");
    if (!p.face) throw ctx.fail("Pick the face to texture: a flat face or a cylinder.");
    const r = ctx.resolve(p.face);
    if (r.kind !== "face") throw ctx.fail("Pick a face to texture.");
    const s = surfaceOf(ctx, r.shape), cut = p.kind === "dimple";
    const angle = ((Number(p.angle) || 0) * Math.PI) / 180;
    const body: Body = r.body;
    // a dimple is a dome turned over
    const reach = p.kind === "hex" ? p.size / 2 / Math.cos(Math.PI / 6) : p.kind === "pyramid" ? (p.size / 2) * Math.SQRT2 : p.size / 2;

    if (s.kind === "plane") {
      const f = flatFace(ctx, p.face);
      const [x0, y0, x1, y1] = f.box, mid: Vec2 = [(x0 + x1) / 2, (y0 + y1) / 2];
      if (p.kind === "rib") {
        if (p.size >= p.pitch) throw ctx.fail("A rib must be narrower than the pitch.");
        // bars across the whole face, trimmed to it
        const c = Math.cos(angle), sn = Math.sin(angle), half = Math.hypot(x1 - x0, y1 - y0) / 2 + 1;
        const turned: Frame = { origin: toWorld(f.frame, mid), x: add(scale(f.frame.x, c), scale(f.frame.y, sn)), y: add(scale(f.frame.x, -sn), scale(f.frame.y, c)), normal: f.frame.normal };
        const n = Math.floor(half / p.pitch), bars: Shape[] = [];
        if (2 * n + 1 > 1000) throw ctx.fail("The pitch is too small for this face: that is too many ribs.");
        for (let i = -n; i <= n; i++) bars.push(boxIn(ctx, turned, -half, i * p.pitch - p.size / 2, half, i * p.pitch + p.size / 2, -OVERLAP, p.height));
        const ribs = clipToFace(ctx, compound(ctx.k, bars, ctx.own), f, p.margin, -OVERLAP, p.height);
        if (!ctx.k.solids(ribs).length) throw ctx.fail("No rib fits on the face with this margin.");
        applyTools(ctx, [tagged(ctx, ribs, "ribs")], "add", [body]);
        return;
      }
      const sites = lattice(p.layout === "grid" ? "grid" : "hex", p.pitch, p.pitch, angle, mid, f.box, 60000);
      if (sites.some((x) => x.key === "too-many")) throw ctx.fail("The pitch is too small for this face: that is too many shapes.");
      const inside = sites.filter((x) => inRegion(f.region, x.at, p.margin + reach));
      if (!inside.length) throw ctx.fail("No shape fits on the face with this pitch and margin.");
      if (inside.length > 2500) throw ctx.fail(`That is too many shapes (${inside.length}; at most 2500). Use a larger pitch.`);
      const tool = shapeOf(ctx, p.kind, p.size, p.height, 0);
      const c = Math.cos(angle), sn = Math.sin(angle);
      const fx = add(scale(f.frame.x, c), scale(f.frame.y, sn));
      const instances: Instance[] = inside.map((x) => ({ key: x.key, trsf: frameToFrame(ctx, UNIT, { origin: toWorld(f.frame, x.at), x: fx, normal: cut ? scale(f.frame.normal, -1) : f.frame.normal }) }));
      applyTools(ctx, stamp(ctx, tool, instances), cut ? "remove" : "add", [body]);
      return;
    }
    if (s.kind !== "cylinder") throw ctx.fail("A texture goes on a flat face or a cylinder. Pick one of those.");
    if (p.kind === "rib") throw ctx.fail("Ribs go on a flat face. On a cylinder use another shape, or a pattern of a rib.");
    if (!s.outward && !cut) throw ctx.fail("Inside a bore only dimples can be made.");
    if (reach >= s.radius) throw ctx.fail("The shapes are too large for this cylinder.");
    // the face's extent round and along the cylinder, from its edges' points
    const A = normalize(s.dir), X = frameFromNormal(s.origin, A).x, Y = cross(A, X);
    const pts: Vec3[] = [];
    for (const e of ctx.k.sub(r.shape, "edge")) {
      const ad = ctx.tmp(new (ctx.oc as any).BRepAdaptor_Curve((ctx.oc as any).TopoDS.Edge(e)));
      for (let i = 0; i <= 16; i++) { const q = ad.Value(ad.FirstParameter() + ((ad.LastParameter() - ad.FirstParameter()) * i) / 16); pts.push(ctx.k.xyz(q)); q.delete(); }
    }
    const zs = pts.map((q) => dot(sub(q, s.origin), A)), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const b = (ctx.oc as any).BRepTools.UVBounds((ctx.oc as any).TopoDS.Face(r.shape), 0, 0, 0, 0);
    const whole = b.UMax - b.UMin > 2 * Math.PI - 1e-6;
    if (!whole) throw ctx.fail("The texture goes round a whole cylinder. This face is only part of one: use a Surface pattern of one shape instead.");
    // round: a whole number of pitches; along: rows from the middle
    const around = Math.max(3, Math.round((2 * Math.PI * s.radius) / p.pitch)), step = (2 * Math.PI) / around;
    const row = p.layout === "grid" ? p.pitch : (p.pitch * Math.sqrt(3)) / 2;
    const rows = Math.floor(((z1 - z0) / 2 - p.margin - reach) / row);
    if (rows < 0) throw ctx.fail("No shape fits along the cylinder with this margin.");
    if (around * (2 * rows + 1) > 2500) throw ctx.fail(`That is too many shapes (${around * (2 * rows + 1)}; at most 2500). Use a larger pitch.`);
    // sunk by what the round surface falls away under the shape's foot (a dimple starts on the tangent plane)
    const sag = s.outward ? s.radius - Math.sqrt(s.radius * s.radius - reach * reach) : 0;
    const tool = shapeOf(ctx, p.kind, p.size, p.height, cut ? 0 : -sag);
    const instances: Instance[] = [];
    for (let j = -rows; j <= rows; j++) for (let i = 0; i < around; i++) {
      const th = (i + (p.layout !== "grid" && ((j % 2) + 2) % 2 === 1 ? 0.5 : 0)) * step;
      const radial = add(scale(X, Math.cos(th)), scale(Y, Math.sin(th)));
      const origin = add(add(s.origin, scale(A, (z0 + z1) / 2 + j * row)), scale(radial, s.radius));
      // out of the material: away from the axis on a shaft, towards it in a bore
      const out = s.outward ? radial : scale(radial, -1);
      instances.push({ key: `g${i}.${j}`, trsf: frameToFrame(ctx, UNIT, { origin, x: A, normal: cut ? scale(out, -1) : out }) });
    }
    applyTools(ctx, stamp(ctx, tool, instances), cut ? "remove" : "add", [body]);
  },
});
