// cf-drive-internal-gear.ts — Internal (ring) gear: a ring with involute teeth on the inside, as a planetary
// set's annulus has.  A tooth space of the ring is the tooth of an external gear of the same size, so the
// flanks are the same involutes; the ring's teeth end no lower than the base circle, where the involute stops.
//
// Names: `<id>:t<n>:a` / `:b` (the flanks of space n), `:tip` (the bottom of the space, the ring's root),
// `:root` (the land between spaces, the ring's tooth tip), `<id>:rim`, `<id>:bottom`, `<id>:top`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import { circleLoop, prismOf } from "../kernel/ops/cf-drive";
import { finish, GEARS, gearLoop, gearSizeDefaults, gearSizeFields, makeField, moduleOf, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, whole, type GearSize, type Placed, type Teeth } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface InternalGearParams extends GearSize, Placed { [key: string]: any; width: number; rim: number; operation: string }

/** The tooth spaces of an internal gear of module `m`, as the teeth of the external gear that fills them. */
export function internalSpaces(ctx: EvalContext, p: Partial<GearSize>, m: number, z: number): Teeth {
  const alpha = rad(num(p.pressureAngle, 20));
  if (!(alpha >= rad(10) && alpha <= rad(35))) throw ctx.fail("The pressure angle must be between 10° and 35°.");
  const r = (m * z) / 2, rb = r * Math.cos(alpha), c = Math.max(0, num(p.clearance, 0.25));
  // the ring's teeth reach in to one module inside the pitch circle, but not below the base circle
  const hf = Math.min(m, r - rb - 0.02 * m);
  if (!(hf > 0.2 * m)) throw ctx.fail("An internal gear needs more teeth for this pressure angle.");
  return { z, r, alpha, ha: m * (1 + c), hf, s: (Math.PI * m) / 2 + Math.max(0, num(p.backlash)), fillet: 0 };
}

export default defineFeature<InternalGearParams>({
  type: "cf-internal-gear",
  title: "Internal gear",
  icon: '<circle class="f" cx="12" cy="12" r="9.5"/><circle cx="12" cy="12" r="9.5"/><path d="M18.5 12L15.9 14.25 15.25 17.63 12 16.5 8.75 17.63 8.1 14.25 5.5 12 8.1 9.75 8.75 6.37 12 7.5 15.25 6.37 15.9 9.75z"/>',
  hint: "A ring with involute teeth on the inside (an annulus)",
  keywords: "internal gear ring gear annulus annular involute inside teeth planetary ring",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 13, toolbarKeep: 0,
  defaults: () => ({ ...gearSizeDefaults(48), width: 10, rim: 6, ...placedDefaults(), operation: "new" }),
  schema: [
    ...gearSizeFields,
    { key: "width", label: "Face width", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "rim", label: "Rim", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "Material outside the roots of the teeth." },
    { key: "backlash", label: "Backlash", kind: "number", unit: "mm", min: 0, step: 0.02, hint: "Added to the width of each tooth space at the pitch circle." },
    { key: "clearance", label: "Root clearance", kind: "number", unit: "none", min: 0, max: 0.5, step: 0.05 },
    ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: InternalGearParams) {
    const id = ctx.feature.id;
    const m = moduleOf(ctx, p), z = whole(ctx, p.teeth, "The number of teeth", 12, 400);
    const width = positive(ctx, p.width, "The face width"), rim = positive(ctx, p.rim, "The rim");
    const t = internalSpaces(ctx, p, m, z);
    const body = prismOf(ctx, spaceOf(ctx, p), circleLoop(t.r + t.ha + rim, "rim"), [gearLoop(t)], 0, width, id);
    finish(ctx, [body], p.operation);
  },
});
