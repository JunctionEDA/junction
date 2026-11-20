// cf-geo-stock.ts — the Stock body: the block or the round bar a part is cut from: the box (or cylinder) round
// the picked bodies, with an allowance of material on every side, optionally rounded up to the sizes stock
// comes in.  The box is the bodies' true extent (measured on their surfaces, not on the control points of their
// curves); the cylinder is the smallest that holds them along the chosen axis.  It lines up with the model's
// axes, or with a plane's.  The stock is a new body; the parts stay as they are.
//
// Names: a box's faces are `<id>:x-`, `:x+`, `:y-`, `:y+`, `:z-`, `:z+`; a bar's `<id>:side`, `:start`, `:end`.
import { defineFeature } from "../core/feature";
import { add, dot, scale, sub, type Frame, type Vec2, type Vec3 } from "../core/geometry";
import type { Body, EvalContext, NamedShape } from "../kernel/types";
import { boxIn, cylinderOf, frameToFrame, surfacePoints, tightBox } from "../kernel/ops/cf-geo";
import { planeOf } from "../kernel/ops/ref-geom";
import { compound } from "../kernel/ops/shapes";
import { smallestCircle } from "./_cf-geo";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface StockParams { [key: string]: any; bodies: string[]; shape: "box" | "cylinder"; axis: "x" | "y" | "z"; allowance: number; step: number; plane: RefTarget | null }

const WORLD: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };

/** A size rounded up to a whole number of steps (unchanged when there is no step). */
export const roundUp = (v: number, step: number): number => (step > 0 ? Math.ceil(v / step - 1e-9) * step : v);

export default defineFeature<StockParams>({
  type: "cf-geo-stock",
  title: "Stock body",
  hint: "The block or round bar a part is cut from: its bounding box or cylinder plus an allowance.",
  keywords: "bounding box stock body blank billet raw material envelope allowance machining cam extents bar oversize",
  icon: '<path class="d" d="M3 7.500l9-4.500 9 4.500v9l-9 4.500-9-4.500z"/><path class="d t" d="M3 7.500l9 4.500 9-4.500M12 12v9"/><path class="f" d="M8.500 10.500l3.500-1.700 3.500 1.700v3.500L12 15.800 8.500 14z"/><path d="M8.500 10.500l3.500-1.700 3.500 1.700v3.500L12 15.800 8.500 14z"/>',
  toolbarOrder: 330, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], shape: "box", axis: "z", allowance: 2, step: 0, plane: null }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
    { key: "shape", label: "Stock", kind: "enum", options: [{ value: "box", label: "Block" }, { value: "cylinder", label: "Round bar" }] },
    { key: "axis", label: "Bar along", kind: "enum", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }, { value: "z", label: "Z" }], visible: (p) => p.shape === "cylinder" },
    { key: "allowance", label: "Allowance", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "Material left on every side (on a bar: on its radius and on each end)." },
    { key: "step", label: "Round up to", kind: "number", unit: "mm", min: 0, step: 1, hint: "Stock sizes: each size (a bar's diameter and length) is rounded up to a multiple of this. 0 leaves them as they come." },
    { key: "plane", label: "Lined up with", kind: "refs", of: ["face"], single: true, planes: true, datums: ["plane"], hint: "Optional: the stock's X and Y lie in this plane and its Z along the normal. Empty: the model's own axes." },
  ],

  evaluate(ctx: EvalContext, p: StockParams) {
    const oc = ctx.oc as any, k = ctx.k, id = ctx.feature.id;
    if (!(p.allowance >= 0) || !(p.step >= 0)) throw ctx.fail("The allowance and the rounding step cannot be less than zero.");
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies: Body[] = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies no longer exist. Pick them again." : "There is no body to put stock round.");
    const f = p.plane ? planeOf(ctx, p.plane, "plane") : WORLD;
    // the bodies seen in the stock's own frame
    let shapes = bodies.map((b) => b.shape);
    if (p.plane) {
      const all = shapes.length === 1 ? shapes[0] : compound(k, shapes, ctx.own);
      shapes = [ctx.own(ctx.tmp(new oc.BRepBuilderAPI_Transform(all, frameToFrame(ctx, f, WORLD), true, false)).Shape())];
    }
    const b = tightBox(ctx, shapes);
    if (!b) throw ctx.fail("The bodies have no size.");
    const local = (x: number, y: number, z: number): Vec3 => add(add(add(f.origin, scale(f.x, x)), scale(f.y, y)), scale(f.normal, z));
    if (p.shape !== "cylinder") {
      // each size grown by the allowance on both sides, rounded up, and centred on the part
      const dims = [0, 1, 2].map((i) => { const size = roundUp(b[i + 3] - b[i] + 2 * p.allowance, p.step), mid = (b[i] + b[i + 3]) / 2; return [mid - size / 2, mid + size / 2]; });
      if (dims.some((d) => !(d[1] - d[0] > 1e-9))) throw ctx.fail("The bodies are flat: add an allowance to give the stock a thickness.");
      const shape = boxIn(ctx, f, dims[0][0], dims[1][0], dims[0][1], dims[1][1], dims[2][0], dims[2][1]);
      const centre = local((dims[0][0] + dims[0][1]) / 2, (dims[1][0] + dims[1][1]) / 2, (dims[2][0] + dims[2][1]) / 2);
      const axes: [string, Vec3][] = [["x", f.x], ["y", f.y], ["z", f.normal]];
      const named: NamedShape[] = k.sub(shape, "face").map((face) => {
        const d = sub(k.centre(face, "face"), centre);
        let best = "", far = 0;
        for (const [n, a] of axes) { const v = dot(d, a); if (Math.abs(v) > Math.abs(far)) { far = v; best = `${id}:${n}${v > 0 ? "+" : "-"}`; } }
        return { name: best, shape: face };
      });
      ctx.addBody(shape, (face) => named.find((x) => x.shape.IsSame(face))?.name ?? null, { name: "Stock" });
      return;
    }
    // a bar: along one of the frame's axes, round the smallest circle that holds the bodies seen along it
    const ai = p.axis === "x" ? 0 : p.axis === "y" ? 1 : 2, ui = (ai + 1) % 3, vi = (ai + 2) % 3;
    const size = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    // (the points are on the surfaces, a hair inside where a face is round: the circle is grown by that hair)
    const pts = shapes.flatMap((s) => surfacePoints(ctx, s, Math.max(0.002, size / 4000), 0.02));
    const circle = smallestCircle(pts.map((q): Vec2 => [q[ui], q[vi]]));
    const radius = roundUp(2 * (circle.r * (1 + 6e-5) + p.allowance), p.step) / 2;
    const len = roundUp(b[ai + 3] - b[ai] + 2 * p.allowance, p.step), start = (b[ai] + b[ai + 3]) / 2 - len / 2;
    if (!(radius > 1e-9) || !(len > 1e-9)) throw ctx.fail("The bodies are flat: add an allowance to give the stock a size.");
    const at: Vec3 = [0, 0, 0]; at[ai] = start; at[ui] = circle.c[0]; at[vi] = circle.c[1];
    const dir = [f.x, f.y, f.normal][ai];
    const shape = cylinderOf(ctx, local(at[0], at[1], at[2]), dir, radius, len);
    const from = local(at[0], at[1], at[2]);
    ctx.addBody(shape, (face) => {
      if (!k.faceFrame(oc.TopoDS.Face(face))) return `${id}:side`;
      return dot(sub(k.centre(face, "face"), from), dir) < len / 2 ? `${id}:start` : `${id}:end`;
    }, { name: "Stock" });
  },
});
