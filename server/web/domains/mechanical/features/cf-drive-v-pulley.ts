// cf-drive-v-pulley.ts — V-belt pulley (sheave): one or more grooves for a classical (Z, A, B, C) or narrow
// (SPZ, SPA, SPB, SPC) V-belt, sized by ISO 4183: the groove's width at the pitch line, its depth above and
// below it, the spacing of the grooves and the edge distance come from the section; the groove angle is 34° up
// to the section's small-pulley limit and 38° above it.  The outside diameter is the pitch diameter plus twice
// the depth above the pitch line.
//
// Names: `<id>:g<n>:a` / `:b` / `:floor` (groove n), `:rim<n>` (the rim before it; `:rim<count + 1>` the last),
// `<id>:bottom`, `<id>:top`, `<id>:bore`, `<id>:hub`, `<id>:hub:end`, `<id>:key:…`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { bool, polyLoop, prismOf, revolveOf, type P2 } from "../kernel/ops/cf-drive";
import { boreDefaults, boreFields, DRIVES, finish, makeField, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, whole, type Bore, type Placed } from "./_cf-drive";
import { keyFor, VBELTS } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface VPulleyParams extends Bore, Placed { [key: string]: any; section: string; pitchDiameter: number; grooves: number; operation: string }

export default defineFeature<VPulleyParams>({
  type: "cf-v-pulley",
  title: "V-belt pulley",
  icon: '<path class="f" d="M4 3h16v4l-3 5 3 5v4H4v-4l3-5-3-5z"/><path d="M4 3h16v4l-3 5 3 5v4H4v-4l3-5-3-5z"/><path class="d" d="M12 1.5v21"/>',
  hint: "A V-belt sheave: Z, A, B, C or SPZ to SPC grooves by ISO 4183, one or several",
  keywords: "v-belt pulley sheave vee belt groove SPZ SPA SPB SPC A B C Z section wedge belt",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 12, toolbarKeep: 0,
  defaults: () => ({ section: "A", pitchDiameter: 100, grooves: 1, ...boreDefaults(19), ...placedDefaults(), operation: "new" }),
  schema: [
    { key: "section", label: "Belt section", kind: "enum", options: Object.entries(VBELTS).map(([value, b]) => ({ value, label: b.label })) },
    { key: "pitchDiameter", label: "Pitch diameter", kind: "number", unit: "mm", min: 10, step: 5 },
    { key: "grooves", label: "Grooves", kind: "number", unit: "none", min: 1, max: 12, step: 1 },
    ...boreFields, ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: VPulleyParams) {
    const id = ctx.feature.id;
    const v = VBELTS[p.section];
    if (!v) throw ctx.fail("Pick a belt section.");
    const dp = positive(ctx, p.pitchDiameter, "The pitch diameter"), n = whole(ctx, p.grooves, "The number of grooves", 1, 12);
    const half = rad(dp <= v.small ? 34 : 38) / 2, tan = Math.tan(half);
    const ro = dp / 2 + v.b, depth = v.b + v.h, top = v.wd / 2 + v.b * tan, floor = top - depth * tan;
    if (!(floor > 0.2)) throw ctx.fail("The groove closes before its depth. Pick another section.");
    const rb = Math.max(0, num(p.bore)) / 2, hubD = num(p.hubDiameter), hubL = hubD > 0 ? num(p.hubLength) : 0, rh = hubL > 0 ? hubD / 2 : 0;
    const rg = ro - depth;
    if (!(rg > rb + 2)) throw ctx.fail(`The pitch diameter is too small for this section and bore: the grooves reach ${(2 * rg).toFixed(1)} mm.`);
    if (rh && !(rh > rb && rh <= ro)) throw ctx.fail("The hub must be wider than the bore and no wider than the pulley.");
    const width = (n - 1) * v.e + 2 * v.f;
    const pts: P2[] = [[rb, 0], [ro, 0]], labels: string[] = ["bottom"];
    for (let i = 0; i < n; i++) {
      const zc = v.f + i * v.e, g = `g${i + 1}`;
      pts.push([ro, zc - top], [rg, zc - floor], [rg, zc + floor], [ro, zc + top]);
      labels.push(`rim${i + 1}`, `${g}:a`, `${g}:floor`, `${g}:b`);
    }
    pts.push([ro, width]); labels.push(`rim${n + 1}`);
    if (rh) { pts.push([rh, width], [rh, width + hubL]); labels.push("top", "hub", "hub:end"); } else labels.push("top");
    pts.push([rb, width + (rh ? hubL : 0)]); labels.push("bore");
    const sp = spaceOf(ctx, p);
    let body = revolveOf(ctx, sp, pts, labels, id);
    if (p.keyway && rb > 0) {
      const key = keyFor(2 * rb);
      if (!key) throw ctx.fail("DIN 6885 has keys for bores over 6 mm up to 150 mm. Turn the keyway off, or change the bore.");
      if (rb + key.t2 >= (rh ? Math.min(rh, rg) : rg)) throw ctx.fail("The keyway would cut through the pulley. Use a smaller bore, or no keyway.");
      const slot = polyLoop([[-key.b / 2, 0], [key.b / 2, 0], [key.b / 2, rb + key.t2], [-key.b / 2, rb + key.t2]], (i) => ["in", "b", "floor", "a"][i]);
      body = bool(ctx, "cut", body, prismOf(ctx, sp, slot, [], -1, width + hubL + 2, `${id}:key`));
    }
    finish(ctx, [body], p.operation);
  },
});
