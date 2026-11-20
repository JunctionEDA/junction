// cf-drive-rack.ts — Gear rack: the straight-sided basic rack an involute gear of the same module meshes with.
// The teeth run along the plane's x from the origin, the pitch line is the x axis (so a gear whose pitch circle
// touches the x axis meshes with it), and the rack is as wide as the face width along the normal.
//
// Names: `<id>:t<n>:a` / `:b` (flanks), `:tip`, `:root` (the root after tooth n), `<id>:root0`, `<id>:end:a` /
// `:end:b`, `<id>:back`, `<id>:bottom`, `<id>:top`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { Pen, prismOf } from "../kernel/ops/cf-drive";
import { finish, GEARS, makeField, moduleOf, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, whole, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RackParams extends Placed { [key: string]: any; system: "module" | "dp"; module: number; dp: number; teeth: number; pressureAngle: number; width: number; base: number; backlash: number; clearance: number; operation: string }

export default defineFeature<RackParams>({
  type: "cf-rack",
  title: "Gear rack",
  icon: '<path class="f" d="M2 19V11h1.5l1-3h2l1 3h2l1-3h2l1 3h2l1-3h2l1 3H22v8z"/><path d="M2 19V11h1.5l1-3h2l1 3h2l1-3h2l1 3h2l1-3h2l1 3H22v8z"/>',
  hint: "A straight rack for an involute gear of the same module",
  keywords: "rack gear rack and pinion linear gear straight teeth",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 14, toolbarKeep: 0,
  defaults: () => ({ system: "module", module: 2, dp: 12, teeth: 10, pressureAngle: 20, width: 10, base: 6, backlash: 0, clearance: 0.25, ...placedDefaults(), operation: "new" }),
  schema: [
    { key: "system", label: "Size by", kind: "enum", options: [{ value: "module", label: "Module" }, { value: "dp", label: "Diametral pitch" }] },
    { key: "module", label: "Module", kind: "number", unit: "mm", min: 0.05, step: 0.25, visible: (p) => p.system !== "dp" },
    { key: "dp", label: "Diametral pitch", kind: "number", unit: "none", min: 0.1, step: 1, visible: (p) => p.system === "dp" },
    { key: "teeth", label: "Teeth", kind: "number", unit: "none", min: 1, max: 500, step: 1 },
    { key: "pressureAngle", label: "Pressure angle", kind: "number", unit: "deg", min: 10, max: 35, step: 0.5 },
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "base", label: "Height under the teeth", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "backlash", label: "Backlash", kind: "number", unit: "mm", min: 0, step: 0.02 },
    { key: "clearance", label: "Root clearance", kind: "number", unit: "none", min: 0, max: 0.5, step: 0.05 },
    ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: RackParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p), n = whole(ctx, p.teeth, "The number of teeth", 1, 500);
    const width = positive(ctx, p.width, "The face width"), base = positive(ctx, p.base, "The height under the teeth");
    const a = rad(num(p.pressureAngle, 20));
    if (!(a >= rad(10) && a <= rad(35))) throw ctx.fail("The pressure angle must be between 10° and 35°.");
    const pitch = Math.PI * m, ha = m, hf = m * (1 + Math.max(0, num(p.clearance, 0.25)));
    const half = pitch / 4 - Math.max(0, num(p.backlash)) / 2, tan = Math.tan(a);
    if (!(half - ha * tan > 0)) throw ctx.fail("The teeth come to a point: use a smaller pressure angle.");
    if (!(pitch / 2 - (half + hf * tan) > -1e-9)) throw ctx.fail("The teeth run into each other at the root: use a smaller pressure angle or less clearance.");
    const pen = new Pen([0, -hf - base]);
    pen.line([n * pitch, -hf - base], "back").line([n * pitch, -hf], "end:b");
    for (let i = n - 1; i >= 0; i--) {
      const c = (i + 0.5) * pitch, t = `t${i + 1}`;
      pen.line([c + half + hf * tan, -hf], `${t}:root`);
      pen.line([c + half - ha * tan, ha], `${t}:b`).line([c - half + ha * tan, ha], `${t}:tip`).line([c - half - hf * tan, -hf], `${t}:a`);
    }
    pen.line([0, -hf], "root0");
    const body = prismOf(ctx, spaceOf(ctx, p), pen.close("end:a"), [], 0, width, id);
    finish(ctx, [body], p.operation);
  },
});
