// cf-fab-pip-hinge.ts — Print-in-place hinge: two leaves and their knuckles printed flat in one go, already
// assembled, with no pin to fit.
//
// The hinge lies on the plane with its axis along the plane's x, the leaves flat on the bed either side.  The
// knuckles alternate between the leaves (an odd number: the first leaf has both end knuckles).  Each knuckle of
// the first leaf carries a cone on the faces it turns against, and the second leaf's knuckles have the conical
// sockets for them: 45° cones print without support, and the gap between cone and socket is the clearance
// measured square to the surfaces.  Between neighbouring knuckles there is the axial gap, and the same gap
// between a knuckle and the other leaf.
// Bodies: `<id>:a` and `<id>:b`.  Faces: `<id>:a:leaf:…`, `<id>:a:k<n>:barrel`, `:cone-l`, `:cone-r`, `:end-l`,
// `:end-r`; `<id>:b:k<n>:socket-l`, `:socket-r`, ….
import { defineFeature } from "../core/feature";
import type { PlaneRef } from "../core/geometry";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { at, frameAt, polyPrism, positive, revolve, shape, whole, type P2 } from "../kernel/ops/cf-fab";
import { PRINT } from "./_cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PipHingeParams { [key: string]: any; plane: PlaneRef; length: number; leaf: number; thickness: number; barrel: number; knuckles: number; gap: number; clearance: number }

export default defineFeature<PipHingeParams>({
  type: "cf-fab-pip-hinge",
  title: "Print-in-place hinge",
  icon: '<path class="f" d="M2 6h7.5v12H2zM14.5 6H22v12h-7.5z"/><path d="M2 6h7.5v12H2zM14.5 6H22v12h-7.5z"/><rect class="s" x="10" y="5" width="4" height="3.8" rx="0.8"/><rect x="10" y="10.1" width="4" height="3.8" rx="0.8"/><rect class="s" x="10" y="15.2" width="4" height="3.8" rx="0.8"/>',
  hint: "A hinge printed flat and already assembled: interleaved knuckles on support-free cone pivots",
  keywords: "print in place hinge pip hinge 3d print knuckle pin cone pivot articulated no assembly",
  ...PRINT, toolbarOrder: 30,
  defaults: () => ({ plane: { kind: "plane", plane: "top" }, length: 40, leaf: 20, thickness: 3, barrel: 8, knuckles: 5, gap: 0.4, clearance: 0.3 }),
  schema: [
    { key: "plane", label: "Print bed", kind: "plane", hint: "The hinge lies flat on this plane, its axis along the plane's x." },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 1, step: 5, hint: "Along the axis." },
    { key: "leaf", label: "Leaf width", kind: "number", unit: "mm", min: 0.5, step: 1 },
    { key: "thickness", label: "Leaf thickness", kind: "number", unit: "mm", min: 0.2, step: 0.5 },
    { key: "barrel", label: "Barrel diameter", kind: "number", unit: "mm", min: 2, step: 0.5 },
    { key: "knuckles", label: "Knuckles", kind: "number", unit: "none", min: 3, step: 2, hint: "An odd number." },
    { key: "gap", label: "Gap", kind: "number", unit: "mm", min: 0.05, step: 0.05, hint: "Between neighbouring knuckles, and between a knuckle and the other leaf." },
    { key: "clearance", label: "Pivot clearance", kind: "number", unit: "mm", min: 0.05, step: 0.05, hint: "Between a cone and its socket, square to the surfaces." },
  ],

  evaluate(ctx: EvalContext, p: PipHingeParams) {
    const L = positive(ctx, p.length, "length"), leaf = positive(ctx, p.leaf, "leaf width"), tl = positive(ctx, p.thickness, "leaf thickness");
    const R = positive(ctx, p.barrel, "barrel diameter") / 2, g = positive(ctx, p.gap, "gap"), c = positive(ctx, p.clearance, "pivot clearance");
    const n = whole(ctx, p.knuckles, "number of knuckles", 3, 99);
    if (n % 2 === 0) throw ctx.fail("The number of knuckles must be odd, so one leaf holds both ends.");
    if (tl > 2 * R) throw ctx.fail("The leaves are thicker than the barrel.");
    const w = (L - (n - 1) * g) / n;   // one knuckle
    // the cone: 45°, from 0.6 of the barrel's radius down to a blunt tip
    const rp = 0.6 * R, rt = 0.25 * rp, hc = rp - rt;
    // the socket follows the cone a clearance away (measured square to the 45° surface), and is a clearance deeper
    const rs = rp - g + c * Math.SQRT2, zs = hc - g + c, rst = rs - zs;
    if (!(rs < R - 0.6)) throw ctx.fail("The clearance leaves no wall round the pivot. Use a larger barrel or less clearance.");
    if (!(hc > g + 0.3)) throw ctx.fail("The gap is so wide that the cones do not reach their sockets. Use a larger barrel or a smaller gap.");
    if (!(w > 2 * zs + 1) || !(w > 1.5)) throw ctx.fail(`${n} knuckles of ${Math.round(w * 100) / 100} mm are too short for their pivots. Use fewer knuckles or a longer hinge.`);
    // a tongue of the leaf runs in under its knuckle as far as the pivot's socket allows, and must reach the barrel
    const yt = rs + 0.3;
    if (!(tl > R - Math.sqrt(R * R - yt * yt) + 0.3)) throw ctx.fail("The leaves are too thin to reach the barrel. Make them thicker or the barrel smaller.");
    const base = ctx.frameOf(p.plane), id = ctx.feature.id;
    const x0 = -L / 2, xi = (i: number) => x0 + i * (w + g);
    // round the axis: the frame's normal is the axis, its origin on it at the hinge's start
    const axis = frameAt(at(base, x0, 0, R), base.y, base.x);
    const leafOf = (side: 1 | -1, mine: (i: number) => boolean, key: string): NamedResult => {
      // a comb in the bed's plane: the leaf, with a tongue under each of its knuckles that stops short of the pivot
      const y0 = side * (R + g), y1 = side * (R + g + leaf);
      const pts: P2[] = [[x0, y1], [x0, y0]];
      for (let i = 0; i < n; i++) if (mine(i)) pts.push([xi(i), y0], [xi(i), side * yt], [xi(i) + w, side * yt], [xi(i) + w, y0]);
      pts.push([x0 + L, y0], [x0 + L, y1]);
      // drop the doubled corners where a tongue starts at the leaf's end
      const clean = pts.filter((q, i) => { const l = pts[(i + pts.length - 1) % pts.length]; return Math.abs(q[0] - l[0]) > 1e-9 || Math.abs(q[1] - l[1]) > 1e-9; });
      return polyPrism(ctx, base, side > 0 ? clean.slice().reverse() : clean, 0, tl, `${key}:leaf`);
    };
    const knuckle = (i: number, key: string): NamedResult => {
      const a = xi(i) - x0, b = a + w, first = i === 0, last = i === n - 1;
      if (i % 2 === 0) {
        const pts: P2[] = [], roles: (string | null)[] = [];
        if (first) { pts.push([0, a], [R, a]); roles.push("end-l", "barrel"); } else { pts.push([0, a - hc], [rt, a - hc], [rp, a], [R, a]); roles.push("tip-l", "cone-l", "end-l", "barrel"); }
        if (last) { pts.push([R, b], [0, b]); roles.push("end-r", null); } else { pts.push([R, b], [rp, b], [rt, b + hc], [0, b + hc]); roles.push("end-r", "cone-r", "tip-r", null); }
        return revolve(ctx, axis, pts, roles, key);
      }
      return revolve(ctx, axis, [[0, a + zs], [rst, a + zs], [rs, a], [R, a], [R, b], [rs, b], [rst, b - zs], [0, b - zs]], ["floor-l", "socket-l", "end-l", "barrel", "end-r", "socket-r", "floor-r", null], key);
    };
    const idx = Array.from({ length: n }, (_, i) => i);
    const a = shape(ctx, "fuse", leafOf(1, (i) => i % 2 === 0, `${id}:a`), idx.filter((i) => i % 2 === 0).map((i) => knuckle(i, `${id}:a:k${i / 2 + 1}`)));
    const b = shape(ctx, "fuse", leafOf(-1, (i) => i % 2 === 1, `${id}:b`), idx.filter((i) => i % 2 === 1).map((i) => knuckle(i, `${id}:b:k${(i + 1) / 2}`)));
    for (const [r, suffix, name] of [[a, "a", "Leaf A"], [b, "b", "Leaf B"]] as const) {
      const solids = ctx.k.solids(r.shape);
      if (solids.length !== 1) throw ctx.fail("A leaf of the hinge did not come out as one piece. Use a thicker leaf or a larger barrel.");
      ctx.addBody(solids[0], r.names, { suffix, name });
    }
  },
});
