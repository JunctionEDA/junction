// cf-hw-washer.ts — Washer: a plain washer (ISO 7089), a large one (ISO 7093), a split spring washer (DIN 127, drawn
// flat with its slit) by screw size, or any ring by its three dimensions.  It lies on the picked plane.
//
// Names: `<id>:top`, `<id>:bottom`, `<id>:outer`, `<id>:inner`, and `<id>:slit` on a spring washer.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { apply, copies, cut, extruded, poly, revolved, spots, type V2 } from "../kernel/ops/cf-hw";
import { fastenerOf, HW_SECTION, MENU_THREADS, resultFields, sizeField, whereDefaults, whereFields } from "./_cf-hw";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface WasherParams { [key: string]: any; kind: "plain" | "large" | "spring" | "custom"; size: string; inner: number; outer: number; thickness: number; operation: "new" | "add"; targets: string[] }

export default defineFeature<WasherParams>({
  type: "cf-hw-washer",
  title: "Washer",
  icon: '<ellipse class="f" cx="12" cy="12" rx="9" ry="5.5"/><ellipse cx="12" cy="12" rx="9" ry="5.5"/><ellipse cx="12" cy="12" rx="3.6" ry="2.1"/><path d="M3 12v2.5c0 3 4 5.5 9 5.5s9-2.5 9-5.5V12"/>',
  hint: "Make a washer: plain, large or spring by screw size, or any ring",
  keywords: "washer generator plain flat fender large spring lock split shim spacer ring m3 m4 m5 m6 hardware",
  toolbarSection: HW_SECTION, toolbarMenu: MENU_THREADS, toolbarOrder: 22, toolbarKeep: 0,
  defaults: () => ({ ...whereDefaults(), kind: "plain", size: "M6", inner: 6.4, outer: 12, thickness: 1.6, operation: "new", targets: [] }),
  schema: [
    { key: "kind", label: "Kind", kind: "enum", options: [{ value: "plain", label: "Plain" }, { value: "large", label: "Large" }, { value: "spring", label: "Spring" }, { value: "custom", label: "Custom" }] },
    { ...sizeField(), visible: (p) => p.kind !== "custom" },
    { key: "inner", label: "Inside Ø", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.kind === "custom" },
    { key: "outer", label: "Outside Ø", kind: "number", unit: "mm", min: 0.2, step: 1, visible: (p) => p.kind === "custom" },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.01, step: 0.1, visible: (p) => p.kind === "custom" },
    ...whereFields({ noun: "washer" }),
    ...resultFields,
  ],

  evaluate(ctx: EvalContext, p: WasherParams) {
    let dims: [number, number, number];
    if (p.kind === "custom") dims = [Number(p.inner), Number(p.outer), Number(p.thickness)];
    else {
      const f = fastenerOf(p.size);
      if (!f) throw ctx.fail(`The size table has no ${p.size}.`);
      dims = p.kind === "large" ? f.washerLarge : p.kind === "spring" ? f.washerSpring : f.washer;
    }
    const [inner, outer, t] = dims;
    if (!(inner > 0) || !(t > 0)) throw ctx.fail("The washer's hole and thickness must be more than zero.");
    if (!(outer > inner)) throw ctx.fail("The washer's outside must be wider than its hole.");
    apply(ctx, copies(ctx, spots(ctx, p), (frame, prefix) => {
      const ring = revolved(ctx, frame, poly([[inner / 2, 0], [outer / 2, 0], [outer / 2, t], [inner / 2, t]] as V2[], ["bottom", "outer", "top", "inner"]), prefix);
      if (p.kind !== "spring") return ring;
      // the slit of a spring washer, cut on the slant
      const w = Math.max(0.3, 0.3 * t), r0 = inner / 2 - 0.5, r1 = outer / 2 + 0.5;
      const slit = extruded(ctx, frame, poly([[r0, -w / 2], [r1, -w / 2], [r1, w / 2], [r0, w / 2]] as V2[], "slit"), [], -t, 3 * t, prefix, [frame.normal[0] * 3 * t + frame.y[0] * t, frame.normal[1] * 3 * t + frame.y[1] * t, frame.normal[2] * 3 * t + frame.y[2] * t]);
      return cut(ctx, ring, slit);
    }), p);
  },
});
