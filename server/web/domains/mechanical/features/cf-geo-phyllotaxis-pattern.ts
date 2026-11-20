// cf-geo-phyllotaxis-pattern.ts — the Fibonacci (phyllotaxis) pattern: copies on the spiral a sunflower's seeds
// make.  Place n is at the golden angle (137.508°) times n round the axis and at spacing × √n from it, so the
// copies are evenly dense however many there are.  The original is a place of the spiral too: the one at its
// own distance from the axis (at the axis it is place 0, at one spacing from it place 1).  Copies are named
// `<id>:f<n>:<seed face name>`.
import { defineFeature } from "../core/feature";
import { add, cross, dot, length, normalize, scale, sub } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { axisOf, frameFromNormal } from "../kernel/ops/ref-geom";
import { copySites, seedCentre, type Site } from "../kernel/ops/cf-geo";
import { copyDefaults, copyFields, countOf, type CopyParams } from "./_pattern";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const GOLDEN_ANGLE = 180 * (3 - Math.sqrt(5));   // 137.5077…°

export interface PhyllotaxisParams extends CopyParams { [key: string]: any; axis: RefTarget | null; count: number; spacing: number; angle: number; keepOrientation: boolean; sizeEnd: number }

export default defineFeature<PhyllotaxisParams>({
  type: "cf-geo-phyllotaxis-pattern",
  title: "Fibonacci pattern",
  hint: "Copies on a sunflower spiral: the golden angle apart, evenly dense from the middle out.",
  keywords: "fibonacci phyllotaxis sunflower spiral golden angle vogel pattern shower head speaker holes",
  icon: '<circle class="s" cx="12" cy="12" r="1"/><circle class="s" cx="14.2" cy="10.4" r="1"/><circle class="s" cx="9.3" cy="10.2" r="1"/><circle class="s" cx="12.6" cy="15.3" r="1"/><circle class="s" cx="16.4" cy="14" r="1"/><circle class="s" cx="8" cy="14.6" r="1"/><circle class="s" cx="11.5" cy="6.8" r="1"/><circle class="s" cx="17.6" cy="8.7" r="1"/><circle class="s" cx="5.8" cy="9.8" r="1"/><circle class="s" cx="15.6" cy="18.4" r="1"/><circle class="s" cx="8.6" cy="18.6" r="1"/><circle class="s" cx="19.6" cy="13.2" r="1"/><circle class="s" cx="6.6" cy="5.6" r="1"/><circle class="s" cx="15.8" cy="4.4" r="1"/><circle class="t" cx="12" cy="12" r="9.5"/>',
  toolbarOrder: 304, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ ...copyDefaults(), axis: null, count: 60, spacing: 4, angle: GOLDEN_ANGLE, keepOrientation: true, sizeEnd: 1 }),
  schema: [
    ...copyFields("Copy"),
    { key: "axis", label: "Centre axis", kind: "refs", of: ["edge", "face"], single: true, planes: true, datums: ["axis", "plane"], sketch: true, hint: "The spiral's middle: an axis, a round edge or face, or a plane (its normal through its middle)." },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1, hint: "Places on the spiral, counted from the middle." },
    { key: "spacing", label: "Spacing", kind: "number", unit: "mm", min: 0.001, step: 0.5, hint: "Place n is this × √n from the axis: about the distance between neighbours." },
    { key: "angle", label: "Angle", kind: "number", unit: "deg", step: 0.1, hint: "Between one place and the next. The golden angle, 137.508°, packs evenly." },
    { key: "keepOrientation", label: "Keep orientation", kind: "boolean", hint: "Do not turn the copies with the spiral." },
    { key: "sizeEnd", label: "Size at the rim", kind: "number", unit: "none", min: 0.01, step: 0.1, hint: "Copies grow or shrink evenly from the original's size at the middle to this at the last place." },
  ],

  evaluate(ctx: EvalContext, p: PhyllotaxisParams) {
    const n = countOf(ctx, p.count, "count");
    if (!(p.spacing > 0)) throw ctx.fail("The spacing must be more than zero.");
    if (!Number.isFinite(p.angle)) throw ctx.fail("The angle must be a number.");
    if (!(p.sizeEnd > 0) || p.sizeEnd > 100) throw ctx.fail("The size at the rim is a factor more than zero (1 keeps the original's size).");
    const axis = axisOf(ctx, p.axis, "centre axis"), A = normalize(axis.dir);
    const centre = seedCentre(ctx, p);
    // the original's place: its distance from the axis, and the direction to it
    const rel = sub(centre, axis.origin), radial = sub(rel, scale(A, dot(rel, A))), r0 = length(radial);
    const foot = sub(centre, radial);
    const x = r0 > 1e-9 ? normalize(radial) : frameFromNormal(axis.origin, A).x, y = cross(A, x);
    const n0 = (r0 / p.spacing) ** 2, step = (p.angle * Math.PI) / 180;
    const rim = p.spacing * Math.sqrt(Math.max(1, n - 1));
    const sites: Site[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(i - n0) < 1e-6) continue;   // the original
      const r = p.spacing * Math.sqrt(i), a = (i - n0) * step;
      const to = add(foot, add(scale(x, r * Math.cos(a)), scale(y, r * Math.sin(a))));
      sites.push({ key: `f${i}`, to, angle: p.keepOrientation ? 0 : a, size: 1 + (p.sizeEnd - 1) * Math.min(1, r / rim) });
    }
    if (!sites.length) ctx.warn("A count of one makes no copies.");
    copySites(ctx, p, sites, centre, A);
  },
});
