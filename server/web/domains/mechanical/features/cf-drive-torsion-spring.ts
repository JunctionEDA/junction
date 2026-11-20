// cf-drive-torsion-spring.ts — Torsion spring: a helical spring that works by twisting, with a straight leg at
// each end leaving the coil along its tangent.  The body is wound with a small gap between coils (they close up
// as the spring is wound tighter).  The fraction of a coil sets the angle between the legs: 5 coils puts them
// parallel, pointing opposite ways; 5.25 at 90°; 5.5 side by side.
//
// Names: `<id>:wire` (the coil and both legs), `<id>:start`, `<id>:end` (the cut ends of the legs).
import { defineFeature } from "../core/feature";
import type { Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { barAlong } from "../kernel/ops/cf-drive";
import { DRIVES, num, placedDefaults, placedFields, SECTION, spaceOf, type Placed } from "./_cf-drive";
import { coilDefaults, coilFields, coilOf, coilPoints, handField, type Coil } from "./_cf-drive-spring";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TorsionSpringParams extends Coil, Placed { [key: string]: any; coils: number; gap: number; leg1: number; leg2: number }

export default defineFeature<TorsionSpringParams>({
  type: "cf-torsion-spring",
  title: "Torsion spring",
  icon: '<path d="M2 20l7-5.5M9 14.5a5.5 5.5 0 1 1 6 0M12 4.5a5.5 5.5 0 0 1 3 10M15 14.5l7 5.5"/><circle class="t" cx="12" cy="10" r="2"/>',
  hint: "A helical torsion spring with a straight tangent leg at each end",
  keywords: "torsion spring leg spring clothespin spring mousetrap spring helical torsion",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 52, toolbarKeep: 0,
  defaults: () => ({ ...coilDefaults(1.2, 12), coils: 5.25, gap: 0.2, leg1: 20, leg2: 20, ...placedDefaults() }),
  schema: [
    ...coilFields,
    { key: "coils", label: "Coils", kind: "number", unit: "none", min: 1, max: 100, step: 0.25, hint: "The fraction sets the angle between the legs: .25 is 90°, .5 is 180°." },
    { key: "gap", label: "Gap between coils", kind: "number", unit: "mm", min: 0.01, step: 0.1 },
    { key: "leg1", label: "First leg", kind: "number", unit: "mm", min: 0, step: 1, hint: "From the coil's tangent point to the leg's end." },
    { key: "leg2", label: "Second leg", kind: "number", unit: "mm", min: 0, step: 1 },
    handField, ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: TorsionSpringParams) {
    const id = ctx.feature.id;
    const { d, R } = coilOf(ctx, p);
    const n = Number(p.coils);
    if (!(n >= 1 && n <= 100)) throw ctx.fail("The number of coils must be from 1 to 100.");
    const gap = Math.max(0.01, num(p.gap, 0.2)), hand = p.left ? -1 : 1, pitch = d + gap;
    const l1 = Math.max(0, num(p.leg1)), l2 = Math.max(0, num(p.leg2));
    const coil = coilPoints(R, d / 2, [{ turns: n, pitch }], hand).pts;
    // a leg leaves along the helix's own direction at its end: round the axis, and climbing with the pitch
    const slope = pitch / (2 * Math.PI * R), len = Math.hypot(1, slope);
    const tangent = (a: number): Vec3 => [(-Math.sin(a) * hand) / len, (Math.cos(a) * hand) / len, slope / len];
    const pieces: Vec3[][] = [];
    const s = coil[0], e = coil[coil.length - 1], t0 = tangent(0), t1 = tangent(hand * 2 * Math.PI * n);
    if (l1 > 1e-6) pieces.push([[s[0] - t0[0] * l1, s[1] - t0[1] * l1, s[2] - t0[2] * l1], s]);
    pieces.push(coil);
    if (l2 > 1e-6) pieces.push([e, [e[0] + t1[0] * l2, e[1] + t1[1] * l2, e[2] + t1[2] * l2]]);
    const body = barAlong(ctx, spaceOf(ctx, p), pieces, d / 2, id);
    ctx.addBody(body.shape, body.names);
  },
});
