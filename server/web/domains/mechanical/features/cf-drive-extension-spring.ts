// cf-drive-extension-spring.ts — Extension spring: a close-wound helical spring with a hook at each end.  The
// body's coils lie against each other (drawn a fiftieth of a wire apart, so the surface stays one clean tube).
// The hooks are machine hooks: the last half coil at each end bent up square to the body, so each hook is half
// a circle of the coil's own radius standing over the axis.  Without hooks it is the plain close-wound body.
//
// The spring stands on the plane with its lower hook's tip there; the length inside the hooks follows from the
// coils and is in the body's name.
//
// Names: `<id>:wire`, `<id>:start`, `<id>:end` (the cut ends of the wire).
import { defineFeature } from "../core/feature";
import type { Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { barAlong } from "../kernel/ops/cf-drive";
import { DRIVES, placedDefaults, placedFields, SECTION, spaceOf, type Placed } from "./_cf-drive";
import { coilDefaults, coilFields, coilOf, coilPoints, handField, type Coil } from "./_cf-drive-spring";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ExtensionSpringParams extends Coil, Placed { [key: string]: any; coils: number; hooks: boolean }

export default defineFeature<ExtensionSpringParams>({
  type: "cf-extension-spring",
  title: "Extension spring",
  icon: '<path d="M12 6.5a2.3 2.3 0 1 0-2.3-2.3M12 17.5a2.3 2.3 0 1 1 2.3 2.3M7 6.5h10M7 17.5h10M17 6.5L7 8.7l10 2.2-10 2.2 10 2.2-10 2.2"/>',
  hint: "A close-wound extension spring with a machine hook at each end",
  keywords: "extension spring tension spring hook spring close wound coil spring",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 51, toolbarKeep: 0,
  defaults: () => ({ ...coilDefaults(1.2, 10), coils: 10, hooks: true, ...placedDefaults() }),
  schema: [
    ...coilFields,
    { key: "coils", label: "Body coils", kind: "number", unit: "none", min: 2, max: 300, step: 1, hint: "A fraction of a coil turns the upper hook against the lower: 12.5 puts them at 180°." },
    { key: "hooks", label: "Hooks", kind: "boolean" },
    handField, ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: ExtensionSpringParams) {
    const id = ctx.feature.id;
    const { d, R } = coilOf(ctx, p);
    const n = Number(p.coils);
    if (!(n >= 2 && n <= 300)) throw ctx.fail("The number of body coils must be from 2 to 300.");
    const hand = p.left ? -1 : 1, pitch = d * 1.02, lift = 0.75 * d;
    // the body starts above the lower hook: the hook's half circle hangs from `lift` below the first coil
    const z0 = p.hooks ? R + lift + d / 2 : d / 2;
    const coil = coilPoints(R, z0, [{ turns: n, pitch }], hand), all = coil.pts;
    const pts: Vec3[] = [];
    if (p.hooks) {
      // leave out the coil's first and last 50°: the wire bends from the coil up into the hook over that stretch
      const skip = Math.ceil((50 / 360) * 12), N = 8, from = (35 * Math.PI) / 180;
      const zc0 = z0 - lift, zc1 = z0 + coil.height + lift, a1 = hand * 2 * Math.PI * n, ux = Math.cos(a1), uy = Math.sin(a1);
      for (let i = 0; i <= N; i++) { const f = Math.PI - ((Math.PI - from) * i) / N; pts.push([R * Math.cos(f), 0, zc0 - R * Math.sin(f)]); }
      pts.push(...all.slice(skip, all.length - skip));
      for (let i = 0; i <= N; i++) { const f = from + ((Math.PI - from) * i) / N; pts.push([R * Math.cos(f) * ux, R * Math.cos(f) * uy, zc1 + R * Math.sin(f)]); }
    } else pts.push(...all);
    const body = barAlong(ctx, spaceOf(ctx, p), [pts], d / 2, id);
    const inside = p.hooks ? coil.height + 2 * (R + lift) - d : coil.height + d;
    ctx.addBody(body.shape, body.names, { name: `Extension spring, ${inside.toFixed(1)} mm ${p.hooks ? "inside the hooks" : "long"} (${ctx.feature.name})` });
  },
});
