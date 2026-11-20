// cf-drive-cycloidal.ts — Cycloidal disc: the lobed disc of a cycloidal speed reducer.  A ring of pins (their
// number, the radius of the circle they stand on, their diameter) and an eccentricity fix the disc: it has one
// lobe fewer than there are pins, and the reduction is lobes : 1.
//
// The outline is the curve that stays in touch with every pin while the disc's centre runs round the
// eccentricity: an epitrochoid moved in by the pin's radius.  With N pins on radius R, pin radius r and
// eccentricity e, at parameter t:
//     ψ = atan2(sin((1 − N)t), R / (eN) − cos((1 − N)t))
//     x = R cos t − r cos(t + ψ) − e cos(Nt),   y = −R sin t + r sin(t + ψ) + e sin(Nt)
// The eccentricity must be under R / N or the lobes cusp.
//
// The disc is drawn where it runs: its centre the eccentricity along the plane's x from the pin ring's centre
// (the plane's origin), with a bore for the eccentric bearing and a circle of holes for the output pins (a hole
// is the output pin's diameter plus twice the eccentricity).  "With the pins" adds the ring's pins as a body.
//
// Names: `<id>:profile`, `<id>:bore`, `<id>:out<n>`, `<id>:bottom`, `<id>:top`; the pins `<id>:pins:p<n>:…`.
import { defineFeature } from "../core/feature";
import type { NamedResult } from "../kernel/occ";
import type { EvalContext } from "../kernel/types";
import { circleLoop, polar, prismOf, together, type Loop, type P2 } from "../kernel/ops/cf-drive";
import { GEARS, num, placedDefaults, placedFields, positive, SECTION, spaceOf, whole, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CycloidalParams extends Placed { [key: string]: any; pins: number; pinCircle: number; pinDiameter: number; eccentricity: number; thickness: number; bore: number; outputs: number; outputCircle: number; outputPin: number; withPins: boolean }

/** The disc's outline about its own centre. */
export function cycloidPoints(N: number, R: number, r: number, e: number, perLobe = 24): P2[] {
  const n = (N - 1) * perLobe, out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const psi = Math.atan2(Math.sin((1 - N) * t), R / (e * N) - Math.cos((1 - N) * t));
    out.push([R * Math.cos(t) - r * Math.cos(t + psi) - e * Math.cos(N * t), -R * Math.sin(t) + r * Math.sin(t + psi) + e * Math.sin(N * t)]);
  }
  return out;
}

export default defineFeature<CycloidalParams>({
  type: "cf-cycloidal",
  title: "Cycloidal disc",
  icon: '<path class="f" d="M12 3c1.5 0 1.8 1.5 3.2 2s2.8-.3 3.8.8.2 2.5.9 3.8 2.1 1.7 2.1 3.1-1.4 1.8-2.1 3.1-.1 2.8-.9 3.8-2.4.3-3.8.8S13.5 22 12 22s-1.8-1.5-3.2-2-2.8.3-3.8-.8-.2-2.5-.9-3.8S2 13.7 2 12.3s1.4-1.8 2.1-3.1.1-2.8.9-3.8 2.4-.3 3.8-.8S10.5 3 12 3z"/>',
  hint: "The lobed disc of a cycloidal reducer, from its ring of pins and eccentricity",
  keywords: "cycloidal disc cycloidal drive cycloid reducer epitrochoid gearbox lobes pins eccentric",
  toolbarSection: SECTION, toolbarMenu: GEARS, toolbarOrder: 21, toolbarKeep: 0,
  defaults: () => ({ pins: 11, pinCircle: 30, pinDiameter: 5, eccentricity: 1.5, thickness: 6, bore: 16, outputs: 5, outputCircle: 17, outputPin: 4, withPins: false, ...placedDefaults() }),
  schema: [
    { key: "pins", label: "Ring pins", kind: "number", unit: "none", min: 4, max: 80, step: 1, hint: "The disc has one lobe fewer; the reduction is lobes : 1." },
    { key: "pinCircle", label: "Pin circle radius", kind: "number", unit: "mm", min: 1, step: 1 },
    { key: "pinDiameter", label: "Pin diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5 },
    { key: "eccentricity", label: "Eccentricity", kind: "number", unit: "mm", min: 0.01, step: 0.25 },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 1 },
    { key: "bore", label: "Centre bore", kind: "number", unit: "mm", min: 0, step: 1, hint: "For the eccentric's bearing." },
    { key: "outputs", label: "Output holes", kind: "number", unit: "none", min: 0, max: 24, step: 1 },
    { key: "outputCircle", label: "Output circle radius", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => Number(p.outputs) > 0 },
    { key: "outputPin", label: "Output pin diameter", kind: "number", unit: "mm", min: 0.1, step: 0.5, hint: "Each hole is this plus twice the eccentricity.", visible: (p) => Number(p.outputs) > 0 },
    { key: "withPins", label: "With the pins", kind: "boolean", hint: "Also make the ring's pins, as one body." },
    ...placedFields,
  ],
  evaluate(ctx: EvalContext, p: CycloidalParams) {
    const id = ctx.feature.id;
    const N = whole(ctx, p.pins, "The number of pins", 4, 80);
    const R = positive(ctx, p.pinCircle, "The pin circle's radius"), r = positive(ctx, p.pinDiameter, "The pin diameter") / 2, e = positive(ctx, p.eccentricity, "The eccentricity");
    const thickness = positive(ctx, p.thickness, "The thickness");
    if (!(e * N < 0.98 * R)) throw ctx.fail(`The eccentricity must be under ${(R / N).toFixed(2)} mm (the pin circle's radius over the number of pins), or the lobes come to cusps.`);
    if (!(2 * r < (2 * Math.PI * R) / N)) throw ctx.fail("The pins overlap each other. Use fewer or thinner pins, or a larger circle.");
    const pts = cycloidPoints(N, R, r, e);
    // a pin too thick for the lobes makes the outline cross itself: the curve then runs backwards somewhere
    let least = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[0] * b[1] - a[1] * b[0] >= 0) throw ctx.fail("The pins are too thick for these lobes: the outline crosses itself. Use thinner pins or less eccentricity.");
      least = Math.min(least, Math.hypot(a[0], a[1]));
    }
    const holes: Loop[] = [];
    const bore = Math.max(0, num(p.bore)) / 2, k = Math.round(Math.max(0, num(p.outputs)));
    if (bore > 0) holes.push(circleLoop(bore, "bore"));
    if (k > 0) {
      const ro = positive(ctx, p.outputCircle, "The output circle's radius"), rh = positive(ctx, p.outputPin, "The output pin diameter") / 2 + e;
      if (!(ro - rh > bore + 0.3)) throw ctx.fail("The output holes run into the centre bore. Use a larger output circle or a smaller bore.");
      if (!(ro + rh < least - 0.3)) throw ctx.fail(`The output holes run into the lobes: the output circle's radius plus a hole's must stay under ${least.toFixed(2)} mm.`);
      if (!(2 * rh < 2 * ro * Math.sin(Math.PI / k) - 0.3) && k > 1) throw ctx.fail("The output holes overlap each other. Use fewer or smaller ones.");
      for (let i = 0; i < k; i++) holes.push(circleLoop(rh, `out${i + 1}`, polar(ro, (2 * Math.PI * i) / k)));
    } else if (!(bore < least - 0.3)) throw ctx.fail("The centre bore does not fit inside the lobes.");
    const sp = spaceOf(ctx, p);
    const disc = prismOf(ctx, sp.at([e, 0, 0]), { closed: { pts, label: "profile" } }, holes, 0, thickness, id);
    ctx.addBody(disc.shape, disc.names);
    if (p.withPins) {
      const pins: NamedResult[] = [];
      for (let i = 0; i < N; i++) pins.push(prismOf(ctx, sp, circleLoop(r, "side", polar(R, (2 * Math.PI * i) / N)), [], 0, thickness, `${id}:pins:p${i + 1}`));
      const all = together(ctx, pins);
      ctx.addBody(all.shape, all.names, { suffix: "pins", name: `Ring pins (${ctx.feature.name})` });
    }
  },
});
