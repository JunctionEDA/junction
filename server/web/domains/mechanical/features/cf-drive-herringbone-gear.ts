// cf-drive-herringbone-gear.ts — Herringbone gear: a double helical gear, its two halves of opposite hand
// meeting at the middle of the face, so the axial thrusts cancel.  Sizes as the helical gear's (normal module).
// Each half is a true involute helicoid; the teeth are swept in one pass, up one helix and on along the other.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { boreDefaults, boreFields, externalTeeth, finish, GEARS, gearFineFields, gearLoop, gearSizeDefaults, gearSizeFields, makeField, moduleOf, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, tipRadius, wheel, whole, type Bore, type GearSize, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface HerringboneGearParams extends GearSize, Bore, Placed { [key: string]: any; width: number; helix: number; left: boolean; operation: string }

export default defineFeature<HerringboneGearParams>({
  type: "cf-herringbone-gear",
  title: "Herringbone gear",
  icon: '<path class="f" d="M4 7.5l3-3h10l3 3v9l-3 3H7l-3-3z"/><path d="M4 7.5l3-3h10l3 3v9l-3 3H7l-3-3zM7 7.5l2.5 4.5-2.5 4.5M11 7.5l2.5 4.5-2.5 4.5M15 7.5l2.5 4.5-2.5 4.5"/>',
  hint: "A double helical (herringbone) involute gear: two halves of opposite hand",
  keywords: "herringbone gear double helical chevron gear involute",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 12, toolbarKeep: 0,
  defaults: () => ({ ...gearSizeDefaults(20), width: 16, helix: 25, left: false, ...boreDefaults(8), ...placedDefaults(), operation: "new" }),
  schema: [
    ...gearSizeFields,
    { key: "helix", label: "Helix angle", kind: "number", unit: "deg", min: 1, max: 50, step: 1 },
    { key: "left", label: "Opposite hand", kind: "boolean", hint: "Points the chevrons the other way; a mating pair has one of each." },
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "Both halves together." },
    ...boreFields, ...gearFineFields, ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: HerringboneGearParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p), z = whole(ctx, p.teeth, "The number of teeth", 4, 300);
    const width = positive(ctx, p.width, "The face width");
    const beta = rad(Number(p.helix) || 0);
    if (!(beta >= rad(1) && beta <= rad(50))) throw ctx.fail("The helix angle must be between 1° and 50°.");
    const t = externalTeeth(ctx, p, m, z, beta);
    if (tipRadius(t).pointed) ctx.warn("The teeth come to a point before the tip circle: they are shorter than standard.");
    const turn = (((width / 2) * Math.tan(beta)) / t.r) * (p.left ? -1 : 1);
    const body = wheel(ctx, spaceOf(ctx, p), gearLoop(t), { thickness: width, inside: t.r - t.hf, prefix: id, twist: { steps: [{ h: width / 2, turn }, { h: width / 2, turn: -turn }], guide: t.r } }, p);
    finish(ctx, [body], p.operation);
  },
});
