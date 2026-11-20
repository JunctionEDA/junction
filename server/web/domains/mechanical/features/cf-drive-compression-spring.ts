// cf-drive-compression-spring.ts — Compression spring: a helical spring of round wire, by wire diameter, coil
// diameter, free length and the number of active coils.  Ends: open (the pitch runs to the ends), closed (one
// coil at each end wound down flat against the next: "squared"), or closed and ground (those end coils ground
// flat, so the spring stands square).  The free length is measured over the ends as made.
//
// The pitch of the active coils follows from the free length; the feature refuses a spring whose coils would
// touch at its free length and says what its solid length is.
//
// Names: `<id>:wire`, `<id>:start`, `<id>:end` (the cut ends of the wire), `<id>:ground:start`, `<id>:ground:end`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { barAlong, bool, circleLoop, oneSolid, prismOf } from "../kernel/ops/cf-drive";
import { DRIVES, placedDefaults, placedFields, positive, SECTION, spaceOf, type Placed } from "./_cf-drive";
import { coilDefaults, coilFields, coilOf, coilPoints, handField, type Coil } from "./_cf-drive-spring";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CompressionSpringParams extends Coil, Placed { [key: string]: any; length: number; coils: number; ends: "open" | "closed" | "ground" }

export default defineFeature<CompressionSpringParams>({
  type: "cf-compression-spring",
  title: "Compression spring",
  icon: '<path d="M5 3h14M5 21h14M19 3L5 7.5l14 4.5-14 4.5L19 21"/>',
  hint: "A helical compression spring: wire, coil diameter, free length, active coils, open or closed ends",
  keywords: "compression spring coil spring helical spring wire spring closed ground ends pitch free length",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 50, toolbarKeep: 0,
  defaults: () => ({ ...coilDefaults(1.6, 16), length: 40, coils: 6, ends: "closed", ...placedDefaults() }),
  schema: [
    ...coilFields,
    { key: "length", label: "Free length", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "coils", label: "Active coils", kind: "number", unit: "none", min: 1, max: 200, step: 0.5 },
    { key: "ends", label: "Ends", kind: "enum", options: [{ value: "closed", label: "Closed" }, { value: "ground", label: "Closed and ground" }, { value: "open", label: "Open" }] },
    handField, ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: CompressionSpringParams) {
    const id = ctx.feature.id;
    const { d, R } = coilOf(ctx, p);
    const L = positive(ctx, p.length, "The free length"), n = Number(p.coils);
    if (!(n >= 1 && n <= 200)) throw ctx.fail("The number of active coils must be from 1 to 200.");
    const hand = p.left ? -1 : 1, ends = p.ends === "open" || p.ends === "ground" ? p.ends : "closed";
    // the wire's centre line climbs from half a wire above the bottom to half a wire below the top; ground ends are wound a full wire longer and ground back
    const rise = ends === "ground" ? L : L - d, z0 = ends === "ground" ? 0 : d / 2;
    const dead = d * 1.02;   // an end coil lies against the next, a hair apart so the surfaces do not merge
    const parts = (pitch: number) => (ends === "open" ? [{ turns: n, pitch }] : [{ turns: 1, pitch: dead }, { turns: n, pitch }, { turns: 1, pitch: dead }]);
    // the height is linear in the active pitch: two trials give the pitch for the free length
    const h0 = coilPoints(R, z0, parts(0), hand).height, h1 = coilPoints(R, z0, parts(1), hand).height;
    const pitch = (rise - h0) / (h1 - h0);
    const solid = (n + (ends === "open" ? 1 : ends === "ground" ? 2 : 3)) * d;
    if (!(pitch > d * 1.05)) throw ctx.fail(`The coils would touch: with ${n} active coils of ${d} mm wire the spring is ${solid.toFixed(1)} mm long when solid. Use a longer free length, fewer coils or thinner wire.`);
    if (pitch > 2 * R) ctx.warn("The pitch is more than the coil's diameter: a spring this open buckles.");
    const sp = spaceOf(ctx, p);
    let body = barAlong(ctx, sp, [coilPoints(R, z0, parts(pitch), hand).pts], d / 2, id);
    if (ends === "ground") {
      const slab = prismOf(ctx, sp, circleLoop(R + d, "slab"), [], 0, L, `${id}:ground`);
      const names = slab.names;
      slab.names = (f, i) => { const s = names(f, i); return s === `${id}:ground:bottom` ? `${id}:ground:start` : s === `${id}:ground:top` ? `${id}:ground:end` : s; };
      body = oneSolid(ctx, bool(ctx, "common", body, slab), "spring");
    }
    ctx.addBody(body.shape, body.names);
  },
});
