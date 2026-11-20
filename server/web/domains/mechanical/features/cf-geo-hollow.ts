// cf-geo-hollow.ts — Hollow with drain holes: make a solid part a closed shell of one wall thickness (to print
// it in resin or cast it with less material), drill drain holes through the wall on its low side so that resin
// or powder can run out, and optionally split the shell in two along a plane so that the inside can be reached.
// The outside is not changed.
//
// The holes go in along "down" (−Z unless a direction is picked) from below the part to the level of its middle,
// so each goes through the wall under it and stops inside the hollow: one in the middle, or several on a circle.
//
// Names: the inner wall is `<id>:from(<the face it is offset from>)` (as Shell names it), a drain hole's wall
// `<id>:d<n>:<k>`, the two faces a split leaves `<id>:cut`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import { applyTools, cylinderOf, tagged, tightBox } from "../kernel/ops/cf-geo";
import { axisOf, frameFromNormal, planeOf } from "../kernel/ops/ref-geom";
import { planeFace, reachPast, solidCentre } from "../kernel/ops/shapes";
import { thickWall } from "../kernel/ops/thick";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HollowParams { [key: string]: any; bodies: string[]; thickness: number; holes: number; diameter: number; spread: number; down: RefTarget | null; flip: boolean; split: RefTarget | null }

export default defineFeature<HollowParams>({
  type: "cf-geo-hollow",
  title: "Hollow with drain holes",
  hint: "Hollow a solid to a wall thickness, drill drain holes in its low side, and optionally split it in two.",
  keywords: "hollow shell drain holes resin print sla vent offset shell split casting lightweight escape holes",
  icon: '<path class="f" d="M4 5.500h16v13h-5.500v-2H18v-9H6v9h3.500v2H4z"/><path d="M4 5.500h16v13h-5.500v-2H18v-9H6v9h3.500v2H4z"/><path class="t" d="M12 15v6.500M10.300 19.800L12 21.500l1.700-1.700"/>',
  toolbarOrder: 334, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], thickness: 2, holes: 2, diameter: 3, spread: 10, down: null, flip: false, split: null }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "The solid parts to hollow. Leave empty for every body." },
    { key: "thickness", label: "Wall", kind: "number", unit: "mm", min: 0.01, step: 0.5 },
    { key: "holes", label: "Drain holes", kind: "number", unit: "none", min: 0, max: 24, step: 1, hint: "0 leaves the hollow closed." },
    { key: "diameter", label: "Hole diameter", kind: "number", unit: "mm", min: 0.01, step: 0.5, visible: (p) => Number(p.holes) > 0 },
    { key: "spread", label: "Hole circle", kind: "number", unit: "mm", min: 0, step: 1, hint: "The diameter of the circle several holes are spaced on, about the part's middle.", visible: (p) => Number(p.holes) > 1 },
    { key: "down", label: "Down", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "The side the holes go in from: an edge, an axis, or a plane's normal. Empty: from below (−Z).", visible: (p) => Number(p.holes) > 0 },
    { key: "flip", label: "Flip down", kind: "boolean", visible: (p) => Number(p.holes) > 0 && !!p.down },
    { key: "split", label: "Split along", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "Optional: a plane to cut the hollow part in two along." },
  ],

  evaluate(ctx: EvalContext, p: HollowParams) {
    const k = ctx.k, oc = ctx.oc as any, id = ctx.feature.id;
    if (!(p.thickness > 0)) throw ctx.fail("The wall must be thicker than zero.");
    const n = Math.round(Number(p.holes) || 0);
    if (n < 0 || n > 24) throw ctx.fail("The number of drain holes is between 0 and 24.");
    if (n && !(p.diameter > 0)) throw ctx.fail("The hole diameter must be more than zero.");
    if (n > 1 && !(p.spread > p.diameter)) throw ctx.fail("The hole circle must be wider than a hole, or the holes run into each other.");
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies: Body[] = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies to hollow no longer exist. Pick them again." : "There is no body to hollow.");
    let down: Vec3 = [0, 0, -1];
    if (p.down) { down = normalize(axisOf(ctx, p.down, "down direction").dir); if (!p.flip) down = scale(down, -1); }
    const cutFrame = p.split ? planeOf(ctx, p.split, "plane to split along") : null;
    for (const start of bodies) {
      const centre = solidCentre(k, start.shape), box = tightBox(ctx, [start.shape])!;
      let wall;
      try { wall = thickWall(k, start.shape, start.topo.faces, [], -p.thickness, id, ctx.own); }
      catch (e) { throw ctx.fail(`${start.name} could not be hollowed to this wall${e instanceof Error ? ` (${e.message})` : ""}. Try a thinner wall.`); }
      let body = ctx.replaceBody(start, wall.shape, wall.names);
      if (n) {
        // how far below the middle the part reaches along "down"
        let low = 0;
        for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) low = Math.max(low, dot(sub([x, y, z], centre), down));
        const f = frameFromNormal(centre, down), u = f.x, v = cross(down, u);
        const tools = Array.from({ length: n }, (_x, i) => {
          const a = (2 * Math.PI * i) / n, r = n > 1 ? p.spread / 2 : 0;
          const at = add(add(add(centre, scale(u, r * Math.cos(a))), scale(v, r * Math.sin(a))), scale(down, low + 1));
          return tagged(ctx, cylinderOf(ctx, at, scale(down, -1), p.diameter / 2, low + 1), `d${i + 1}`);
        });
        const before = k.volume(body.shape);
        applyTools(ctx, tools, "remove", [body]);
        body = ctx.body(body.id) || body;
        if (Math.abs(k.volume(body.shape) - before) < 1e-9) ctx.warn(`The drain holes miss ${body.name}: move the hole circle in.`);
      }
      if (cutFrame) {
        const tool: Shape = planeFace(k, cutFrame.origin, cutFrame.normal, reachPast(k, [body.shape], cutFrame.origin), ctx.own);
        const mk = ctx.own(new oc.BRepAlgoAPI_Splitter());
        const args = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); args.Append(body.shape);
        const list = ctx.tmp(new oc.NCollection_List_TopoDS_Shape()); list.Append(tool);
        mk.SetArguments(args); mk.SetTools(list);
        mk.Build(ctx.tmp(new oc.Message_ProgressRange()));
        if (!mk.IsDone() || mk.HasErrors()) throw ctx.fail(`${body.name} could not be split.`);
        const shape: Shape = ctx.own(mk.Shape()), pieces = k.solids(shape);
        if (pieces.length < 2) { ctx.warn(`The split plane misses ${body.name}.`); continue; }
        const cut = `${id}:cut`;
        const carried = k.carryNames(shape, mk, [...body.topo.faces, { name: cut, shape: tool }], id);
        const names = (face: any, i: number) => { const nm = carried(face, i); return nm && nm.startsWith(cut) ? cut : nm; };
        const whole: Body = body;
        ctx.replaceBody(body, pieces[0], names);
        pieces.slice(1).forEach((s, i) => ctx.addBody(s, names, { suffix: `${whole.id}.half${i + 2}`, name: `${whole.name} (${i + 2})` }));
      }
    }
  },
});
