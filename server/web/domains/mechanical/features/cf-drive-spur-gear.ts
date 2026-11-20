// cf-drive-spur-gear.ts — Spur gear: an external involute gear with straight teeth, sized by module or
// diametral pitch, with a bore, a DIN 6885 keyway and a hub.  The geometry is in _cf-drive.ts.
//
// Names: `<id>:t<n>:a` / `:b` (flanks), `:tip`, `:root`, `:fa` / `:fb` (root fillets), `<id>:bottom`, `<id>:top`,
// `<id>:bore`, `<id>:key:…`, `<id>:hub:…`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { boreDefaults, boreFields, externalTeeth, finish, GEARS, gearFineFields, gearLoop, gearSizeDefaults, gearSizeFields, makeField, moduleOf, placedDefaults, placedFields, positive, SECTION, spaceOf, tipRadius, wheel, whole, type Bore, type GearSize, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SpurGearParams extends GearSize, Bore, Placed { [key: string]: any; width: number; operation: string }

export default defineFeature<SpurGearParams>({
  type: "cf-spur-gear",
  title: "Spur gear",
  icon: '<path class="f" d="M10.6 2.5h2.8l.5 2.6 1.9.8 2.2-1.5 2 2-1.5 2.2.8 1.9 2.6.5v2.8l-2.6.5-.8 1.9 1.5 2.2-2 2-2.2-1.5-1.9.8-.5 2.6h-2.8l-.5-2.6-1.9-.8-2.2 1.5-2-2 1.5-2.2-.8-1.9-2.6-.5v-2.8l2.6-.5.8-1.9-1.5-2.2 2-2 2.2 1.5 1.9-.8z"/><path d="M10.6 2.5h2.8l.5 2.6 1.9.8 2.2-1.5 2 2-1.5 2.2.8 1.9 2.6.5v2.8l-2.6.5-.8 1.9 1.5 2.2-2 2-2.2-1.5-1.9.8-.5 2.6h-2.8l-.5-2.6-1.9-.8-2.2 1.5-2-2 1.5-2.2-.8-1.9-2.6-.5v-2.8l2.6-.5.8-1.9-1.5-2.2 2-2 2.2 1.5 1.9-.8z"/><circle cx="12" cy="12" r="3"/>',
  hint: "An involute spur gear by module or diametral pitch, with bore, keyway and hub",
  keywords: "spur gear involute cog tooth teeth module diametral pitch DP pinion gearwheel",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 10, toolbarKeep: 0,
  defaults: () => ({ ...gearSizeDefaults(20), width: 10, ...boreDefaults(8), ...placedDefaults(), operation: "new" }),
  schema: [
    ...gearSizeFields,
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    ...boreFields, ...gearFineFields, ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: SpurGearParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p), z = whole(ctx, p.teeth, "The number of teeth", 4, 400);
    const width = positive(ctx, p.width, "The face width");
    const t = externalTeeth(ctx, p, m, z);
    if (tipRadius(t).pointed) ctx.warn("The teeth come to a point before the tip circle: they are shorter than standard. Use less profile shift.");
    const body = wheel(ctx, spaceOf(ctx, p), gearLoop(t), { thickness: width, inside: t.r - t.hf, prefix: id }, p);
    finish(ctx, [body], p.operation);
  },
});
