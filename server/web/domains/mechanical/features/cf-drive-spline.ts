// cf-drive-spline.ts — Spline: a splined shaft, or (with Remove) the splined bore of a hub.  Two kinds:
//
//   Involute — teeth with involute flanks at a 30° pressure angle (37.5° and 45° also) on a module and a tooth
//   count, with the flat-root proportions of DIN 5480 / ANSI B92.1: the teeth stand half a module above the
//   pitch circle and 0.6 of one below it, and are half the pitch thick at the pitch circle.
//
//   Straight-sided — parallel keys round a shaft, by ISO 14: the number of keys, the small and large diameters
//   and the key width come from the size ("6x23x26"), or are given.
//
// New and Add make the shaft; Remove cuts the same outline, grown by the fit clearance all round, out of the
// bodies it stands in, which makes the hub.  It stands on the plane, its axis along the normal.
//
// Names: involute `<id>:t<n>:a` / `:b` / `:tip` / `:root` / `:fa` / `:fb`; straight-sided `<id>:k<n>:a` / `:b` /
// `:top` and `:root` (the small diameter after key n); `<id>:bottom`, `<id>:top`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { Pen, prismOf, rot2, type Loop } from "../kernel/ops/cf-drive";
import { cutField, DRIVES, finish, gearLoop, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, tipRadius, whole, type Placed, type Teeth } from "./_cf-drive";
import { SPLINES } from "./_cf-drive-data";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SplineParams extends Placed {
  [key: string]: any;
  kind: "involute" | "straight"; module: number; teeth: number; pressureAngle: string;
  size: string; keys: number; minor: number; major: number; keyWidth: number;
  length: number; clearance: number; operation: string; flip: boolean;
}

/** The outline of a straight-sided spline: `n` keys of width `w` between the small radius and the large. */
function straightLoop(n: number, rMinor: number, rMajor: number, w: number): Loop {
  const x0 = Math.sqrt(rMinor * rMinor - (w * w) / 4), x1 = Math.sqrt(rMajor * rMajor - (w * w) / 4), step = (2 * Math.PI) / n;
  const pen = new Pen([x0, -w / 2]);
  for (let i = 0; i < n; i++) {
    const T = (x: number, y: number) => rot2([x, y], i * step), k = `k${i + 1}`;
    pen.line(T(x1, -w / 2), `${k}:a`).arcAbout([0, 0], T(x1, w / 2), `${k}:top`, true).line(T(x0, w / 2), `${k}:b`)
      .arcAbout([0, 0], i === n - 1 ? pen.start : rot2([x0, -w / 2], (i + 1) * step), `${k}:root`, true);
  }
  return pen.close("root");
}

export default defineFeature<SplineParams>({
  type: "cf-spline",
  title: "Spline",
  icon: '<path class="f" d="M10.5 3h3v2.3l2-1.2 1.5 2.6-2 1.2 2 1.1v3l-2 1.1 2 1.2-1.5 2.6-2-1.2V21h-3v-2.3l-2 1.2-1.5-2.6 2-1.2-2-1.1v-3l2-1.1-2-1.2 1.5-2.6 2 1.2z"/><path d="M10.5 3h3v2.3l2-1.2 1.5 2.6-2 1.2 2 1.1v3l-2 1.1 2 1.2-1.5 2.6-2-1.2V21h-3v-2.3l-2 1.2-1.5-2.6 2-1.2-2-1.1v-3l2-1.1-2-1.2 1.5-2.6 2 1.2z"/>',
  hint: "A splined shaft, or a hub's splined bore: involute (DIN 5480) or straight-sided (ISO 14)",
  keywords: "spline shaft splined hub involute spline straight sided spline serration DIN 5480 ISO 14 broach",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 45, toolbarKeep: 0,
  defaults: () => ({ kind: "involute", module: 1, teeth: 20, pressureAngle: "30", size: "6x23x26", keys: 6, minor: 23, major: 26, keyWidth: 6, length: 25, clearance: 0.05, ...placedDefaults(), operation: "new", flip: false }),
  schema: [
    { key: "kind", label: "Kind", kind: "enum", options: [{ value: "involute", label: "Involute" }, { value: "straight", label: "Straight-sided" }] },
    { key: "module", label: "Module", kind: "number", unit: "mm", min: 0.1, step: 0.25, visible: (p) => p.kind !== "straight" },
    { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 6, max: 200, step: 1, visible: (p) => p.kind !== "straight" },
    { key: "pressureAngle", label: "Pressure angle", kind: "enum", options: [{ value: "30", label: "30°" }, { value: "37.5", label: "37.5°" }, { value: "45", label: "45°" }], visible: (p) => p.kind !== "straight" },
    { key: "size", label: "Size", kind: "enum", options: [{ value: "custom", label: "Custom" }, ...Object.keys(SPLINES).map((s) => ({ value: s, label: `${s.replace(/x/g, " × ")}` }))], hint: "Keys × small diameter × large diameter (ISO 14).", visible: (p) => p.kind === "straight" },
    { key: "keys", label: "Keys", kind: "number", unit: "none", min: 2, max: 40, step: 1, visible: (p) => p.kind === "straight" && p.size === "custom" },
    { key: "minor", label: "Small diameter", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.kind === "straight" && p.size === "custom" },
    { key: "major", label: "Large diameter", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.kind === "straight" && p.size === "custom" },
    { key: "keyWidth", label: "Key width", kind: "number", unit: "mm", min: 0.1, step: 0.5, visible: (p) => p.kind === "straight" && p.size === "custom" },
    { key: "length", label: "Length", kind: "number", unit: "mm", min: 0.1, step: 1 },
    cutField,
    { key: "clearance", label: "Fit clearance", kind: "number", unit: "mm", min: 0, max: 1, step: 0.01, hint: "A hub's bore is this much larger than the shaft all round.", visible: (p) => p.operation === "remove" },
    ...placedFields,
    { key: "flip", label: "Opposite direction", kind: "boolean" },
  ],
  evaluate(ctx: EvalContext, p: SplineParams) {
    const id = ctx.feature.id;
    const length = positive(ctx, p.length, "The length");
    const grow = p.operation === "remove" ? Math.min(1, Math.max(0, num(p.clearance))) : 0;
    let loop: Loop;
    if (p.kind === "straight") {
      let n: number, d: number, D: number, w: number;
      if (p.size && p.size !== "custom") {
        const row = SPLINES[p.size];
        if (!row) throw ctx.fail("Pick a spline size, or Custom.");
        [n, d, D, w] = row;
      } else { n = whole(ctx, p.keys, "The number of keys", 2, 40); d = positive(ctx, p.minor, "The small diameter"); D = positive(ctx, p.major, "The large diameter"); w = positive(ctx, p.keyWidth, "The key width"); }
      if (!(D > d)) throw ctx.fail("The large diameter must be more than the small one.");
      w += 2 * grow;
      if (!(n * w < Math.PI * d * 0.95)) throw ctx.fail("The keys are wider than the gaps between them leave room for. Use fewer or narrower keys.");
      loop = straightLoop(n, d / 2 + grow, D / 2 + grow, w);
    } else {
      const m = positive(ctx, p.module, "The module"), z = whole(ctx, p.teeth, "The number of teeth", 6, 200);
      const alpha = rad(Number(p.pressureAngle) || 30);
      // the outline moved out by the clearance: thicker teeth, a higher tip, a shallower root
      const t: Teeth = { z, r: (m * z) / 2, alpha, ha: 0.5 * m + grow, hf: 0.6 * m - grow, s: (Math.PI * m) / 2 + (2 * grow) / Math.cos(alpha), fillet: 0.16 * m };
      if (!(t.r - t.hf > 0.5 * m)) throw ctx.fail("A spline needs more teeth.");
      if (tipRadius(t).pointed) ctx.warn("The teeth come to a point before the large diameter.");
      loop = gearLoop(t);
    }
    // a shaft stands on the plane; a hub's bore goes into what lies under it ("Opposite direction" turns either round)
    const down = (p.operation === "remove") !== !!p.flip;
    // a cutter starts a little outside the face it goes into, so its end is not flush with that face
    const over = p.operation === "remove" ? 1 : 0;
    finish(ctx, [prismOf(ctx, spaceOf(ctx, p), loop, [], down ? -length : -over, length + over, id)], p.operation);
  },
});
