// cf-drive-ring-groove.ts — Retaining ring groove: the groove a circlip snaps into, on a shaft (DIN 471) or in a
// bore (DIN 472), sized from the diameter of the cylindrical face picked: the groove's diameter d2 and width m
// are the standard's for that nominal diameter.  The groove is placed by the distance from the end of the face
// to its near edge, which should be at least three times the groove's depth for the shoulder to hold.
//
// Names: `<id>:floor` (the groove's bottom), `<id>:a` (the wall nearer the end), `<id>:b`.
import { defineFeature } from "../core/feature";
import type { GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { revolveOf } from "../kernel/ops/cf-drive";
import { cutFrom, DRIVES, num, positive, roundField, roundOf, SECTION } from "./_cf-drive";
import { RINGS_BORE, RINGS_SHAFT } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RingGrooveParams { [key: string]: any; face: GeomRef | null; size: "din" | "custom"; grooveDiameter: number; width: number; offset: number; flip: boolean }

export default defineFeature<RingGrooveParams>({
  type: "cf-ring-groove",
  title: "Retaining ring groove",
  icon: '<path class="f" d="M3 7h11v1.5h2V7h5v10h-5v-1.5h-2V17H3z"/><path d="M3 7h11v1.5h2V7h5v10h-5v-1.5h-2V17H3z"/><path class="d" d="M1.5 12h21"/>',
  hint: "A circlip groove on a shaft (DIN 471) or in a bore (DIN 472), sized from the diameter",
  keywords: "retaining ring groove circlip snap ring seeger DIN 471 DIN 472 e-clip groove",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 43, toolbarKeep: 0,
  defaults: () => ({ face: null, size: "din", grooveDiameter: 19, width: 1.3, offset: 2, flip: false }),
  schema: [
    roundField,
    { key: "size", label: "Size", kind: "enum", options: [{ value: "din", label: "DIN 471 / 472" }, { value: "custom", label: "Custom" }] },
    { key: "grooveDiameter", label: "Groove diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.size === "custom" },
    { key: "width", label: "Groove width", kind: "number", unit: "mm", min: 0.05, step: 0.1, visible: (p) => p.size === "custom" },
    { key: "offset", label: "From the end", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "To the groove's near edge: at least three times its depth." },
    { key: "flip", label: "From the other end", kind: "boolean" },
  ],
  evaluate(ctx: EvalContext, p: RingGrooveParams) {
    const id = ctx.feature.id;
    const on = roundOf(ctx, p.face, p.flip, 0), d = 2 * on.radius;
    let d2: number, m: number;
    if (p.size === "custom") { d2 = positive(ctx, p.grooveDiameter, "The groove diameter"); m = positive(ctx, p.width, "The groove width"); }
    else {
      const table = on.bore ? RINGS_BORE : RINGS_SHAFT, row = table.find((r) => Math.abs(r[0] - d) < 0.02);
      if (!row) {
        const near = table.reduce((a, b) => (Math.abs(b[0] - d) < Math.abs(a[0] - d) ? b : a));
        throw ctx.fail(`${on.bore ? "DIN 472" : "DIN 471"} has no ring for a ${on.bore ? "bore" : "shaft"} of ${d.toFixed(2)} mm (the nearest is ${near[0]} mm). Use Custom, or change the diameter.`);
      }
      d2 = row[1]; m = row[2];
    }
    if (on.bore ? !(d2 > d) : !(d2 < d && d2 > 0)) throw ctx.fail(on.bore ? "In a bore the groove's diameter must be more than the bore's." : "On a shaft the groove's diameter must be less than the shaft's.");
    const z0 = Math.max(0, num(p.offset)), depth = Math.abs(d - d2) / 2;
    if (z0 + m > on.length + 1e-6) throw ctx.fail(`The groove would lie past the end of the face, which is ${on.length.toFixed(2)} mm long.`);
    if (z0 < 3 * depth - 1e-6) ctx.warn(`The shoulder beside the groove is ${z0} mm; it should be at least ${(3 * depth).toFixed(2)} mm (three times the groove's depth) to hold the ring.`);
    const tool = on.bore
      ? revolveOf(ctx, on.space, [[on.radius * 0.5, z0], [d2 / 2, z0], [d2 / 2, z0 + m], [on.radius * 0.5, z0 + m]], ["a", "floor", "b", "in"], id)
      : revolveOf(ctx, on.space, [[d2 / 2, z0], [on.radius * 1.5 + 1, z0], [on.radius * 1.5 + 1, z0 + m], [d2 / 2, z0 + m]], ["a", "out", "b", "floor"], id);
    cutFrom(ctx, on.body, tool);
  },
});
