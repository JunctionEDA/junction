// cf-hw-bearing-pocket.ts — Bearing pocket: the seat for a ball bearing, by its designation (608, 6204, MR105 …;
// ISO 15 boundary dimensions) or by its dimensions.  At each picked point: a bore of the bearing's outside
// diameter plus a fit allowance, as deep as the bearing is wide, with a chamfered mouth; and behind it a narrower
// hole that leaves a shoulder for the outer ring to sit on and clears the inner ring and the shaft.
//
// Names: `<id>:<point>:wall`, `:seat` (the shoulder), `:chamfer`, `:through` (or `:relief` when blind), `:floor`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { reachPast } from "../kernel/ops/shapes";
import { apply, flipped, poly, prefixAt, revolved, scoped, spots, type Tool, type V2 } from "../kernel/ops/cf-hw";
import { bearingOptions, BEARINGS, cutFields, HW_SECTION, MENU_ENCLOSURES, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface BearingPocketParams {
  [key: string]: any;
  bearing: string; outer: number; inner: number; width: number;
  fit: number; extra: number; shoulder: number; behind: "through" | "relief" | "none"; chamfer: number; targets: string[];
}
const custom = (p: any) => p.bearing === "custom";

export default defineFeature<BearingPocketParams>({
  type: "cf-hw-bearing-pocket",
  title: "Bearing pocket",
  icon: '<path class="f" d="M3 4h18v16H3z"/><path d="M3 4h18v16H3z"/><path d="M6 4v9h3v7M18 4v9h-3v7"/><circle cx="7.5" cy="8.5" r="1.3"/><circle cx="16.5" cy="8.5" r="1.3"/>',
  hint: "Cut the seat for a ball bearing by its designation (608, 6204 …), with a shoulder for the outer ring",
  keywords: "bearing pocket seat bore housing 608 625 6000 6200 shoulder press fit ball bearing skate",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_ENCLOSURES, toolbarOrder: 50, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), bearing: "608", outer: 22, inner: 8, width: 7, fit: 0.05, extra: 0, shoulder: 0, behind: "through", chamfer: 0.4, targets: [] }),
  schema: [
    ...whereFields({ flip: "Opposite direction", noun: "pocket" }),
    { key: "bearing", label: "Bearing", kind: "enum", options: bearingOptions() },
    { key: "outer", label: "Outside Ø", kind: "number", unit: "mm", min: 1, step: 1, visible: custom },
    { key: "inner", label: "Bore Ø", kind: "number", unit: "mm", min: 0.5, step: 1, visible: custom },
    { key: "width", label: "Width", kind: "number", unit: "mm", min: 0.5, step: 1, visible: custom },
    { key: "fit", label: "Fit allowance", kind: "number", unit: "mm", step: 0.01, hint: "Added to the bore's diameter: about −0.02 for a press fit in metal, 0.05 for a slip fit, 0.15 for a printed part." },
    { key: "extra", label: "Extra depth", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "How far the bearing sits below the surface." },
    { key: "shoulder", label: "Shoulder", kind: "number", unit: "mm", min: 0, step: 0.5, hint: "How far the shoulder reaches in from the bore; 0 for a quarter of the bearing's ring." },
    { key: "behind", label: "Behind it", kind: "enum", options: [{ value: "through", label: "Through hole" }, { value: "relief", label: "Relief" }, { value: "none", label: "Nothing" }], hint: "Through: a hole right through the part. Relief: a shallow recess that clears the inner ring." },
    { key: "chamfer", label: "Chamfer", kind: "number", unit: "mm", min: 0, step: 0.1 },
    ...cutFields,
  ],

  evaluate(ctx: EvalContext, p: BearingPocketParams) {
    const dims = custom(p) ? [Number(p.inner), Number(p.outer), Number(p.width)] : BEARINGS[p.bearing];
    if (!dims) throw ctx.fail(`The bearing table has no ${p.bearing}.`);
    const [d, D, B] = dims;
    if (!(D > d) || !(d > 0) || !(B > 0)) throw ctx.fail("The bearing's outside must be wider than its bore, and its width more than zero.");
    const R = (D + (Number(p.fit) || 0)) / 2, depth = B + Math.max(0, Number(p.extra) || 0);
    const shoulder = p.shoulder > 0 ? Number(p.shoulder) : Math.max(0.6, (D - d) / 8);
    const Rs = R - shoulder;
    if (!(Rs > d / 2)) throw ctx.fail(`The shoulder would cover the inner ring: make it less than ${Math.round((R - d / 2) * 100) / 100} mm.`);
    const ch = Math.max(0, Math.min(Number(p.chamfer) || 0, depth / 3));
    const bodies = scoped(ctx, p.targets);
    const tools: Tool[] = spots(ctx, p).map((s) => {
      // drawn looking into the surface: height runs against the normal
      const f = flipped(s.frame);
      const behind = p.behind === "through" ? reachPast(ctx.k, bodies.map((b) => b.shape), f.origin) : p.behind === "relief" ? depth + Math.max(0.5, B * 0.1) : depth;
      const pts: V2[] = [[0, -0.01], [R + ch, -0.01], [R + ch, 0], [R, ch], [R, depth]];
      const roles: (string | null)[] = [null, null, "chamfer", "wall", "seat"];
      if (behind > depth) { pts.push([Rs, depth], [Rs, behind], [0, behind]); roles.push(p.behind === "through" ? "through" : "relief", "floor", null); }
      else { pts.push([0, depth]); roles[4] = "floor"; roles.push(null); }
      return { ...revolved(ctx, f, poly(ch > 0 ? pts : pts.filter((_, i) => i !== 2), ch > 0 ? roles : roles.filter((_, i) => i !== 2)), prefixAt(ctx, s)), suffix: s.key };
    });
    apply(ctx, tools, { operation: "remove", targets: p.targets });
  },
});
