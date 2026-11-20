// cf-drive-helical-gear.ts — Helical gear: an involute gear whose teeth run along helices.  The module and the
// pressure angle are the normal ones (those of the cutter): the transverse module is module / cos β, so the
// pitch diameter is teeth × module / cos β.  A pair on parallel shafts has opposite hands.
//
// The flanks are true involute helicoids: the transverse outline is swept along the axis, turning by
// width × tan β / pitch radius (kernel/ops/cf-drive.ts twistOf).  Names as the spur gear's.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { boreDefaults, boreFields, externalTeeth, finish, GEARS, gearFineFields, gearLoop, gearSizeDefaults, gearSizeFields, makeField, moduleOf, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, tipRadius, wheel, whole, type Bore, type GearSize, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HelicalGearParams extends GearSize, Bore, Placed { [key: string]: any; width: number; helix: number; left: boolean; operation: string }

export default defineFeature<HelicalGearParams>({
  type: "cf-helical-gear",
  title: "Helical gear",
  icon: '<path class="f" d="M4 7.5l3-3h10l3 3v9l-3 3H7l-3-3z"/><path d="M4 7.5l3-3h10l3 3v9l-3 3H7l-3-3zM7 16.5l3-9M10.5 16.5l3-9M14 16.5l3-9"/>',
  hint: "An involute gear with helical teeth, by normal module and helix angle",
  keywords: "helical gear helix angle involute screw gear skew teeth",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 11, toolbarKeep: 0,
  defaults: () => ({ ...gearSizeDefaults(20), width: 12, helix: 20, left: false, ...boreDefaults(8), ...placedDefaults(), operation: "new" }),
  schema: [
    ...gearSizeFields,
    { key: "helix", label: "Helix angle", kind: "number", unit: "deg", min: 0, max: 50, step: 1 },
    { key: "left", label: "Left-handed", kind: "boolean" },
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    ...boreFields, ...gearFineFields, ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: HelicalGearParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p), z = whole(ctx, p.teeth, "The number of teeth", 4, 300);
    const width = positive(ctx, p.width, "The face width");
    const beta = rad(Number(p.helix) || 0);
    if (!(beta >= 0 && beta <= rad(50))) throw ctx.fail("The helix angle must be between 0° and 50°.");
    const t = externalTeeth(ctx, p, m, z, beta);
    if (tipRadius(t).pointed) ctx.warn("The teeth come to a point before the tip circle: they are shorter than standard.");
    // right-handed: the teeth climb like a right-handed screw's thread
    const turn = ((width * Math.tan(beta)) / t.r) * (p.left ? -1 : 1);
    const twist = Math.abs(turn) > 1e-9 ? { steps: [{ h: width, turn }], guide: t.r } : undefined;
    const body = wheel(ctx, spaceOf(ctx, p), gearLoop(t), { thickness: width, inside: t.r - t.hf, prefix: id, twist }, p);
    finish(ctx, [body], p.operation);
  },
});
