// cf-geo-attractor-pattern.ts — the Attractor pattern: a grid of copies whose size and turn depend on how far
// each is from an attractor (a point, or a curve).  At the attractor a copy has the "near" size and angle, at
// the reach and beyond the "far" ones, and in between a blend.  The original stays as it is and is the grid's
// first place.  A hole, pocket or boss that is a straight extrusion square to the grid is sized across it only
// and keeps its depth (kernel/ops/cf-geo.ts copySites); anything else is sized evenly.  Faces are
// `<id>:i<n>.<m>:<seed face name>`.
import { defineFeature } from "../core/feature";
import { add, cross, length, normalize, scale, sub, type Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { axisOf, curveOf, pointOf } from "../kernel/ops/ref-geom";
import { samplePoints } from "../kernel/ops/curves";
import { copySites, seedCentre, type Site } from "../kernel/ops/cf-geo";
import { copyDefaults, copyFields, countOf, type CopyParams } from "./_pattern";
import { falloff } from "./_cf-geo";
import type { RefTarget } from "./_refs";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AttractorPatternParams extends CopyParams {
  [key: string]: any;
  direction: RefTarget | null; spacing: number; count: number; direction2: RefTarget | null; spacing2: number; count2: number;
  attractor: RefTarget | null; reach: number; sizeNear: number; sizeFar: number; angleNear: number; angleFar: number; ease: "linear" | "smooth"; cull: number;
}

const DIRECTION = { kind: "refs" as const, of: ["edge" as const, "face" as const], single: true, planes: true, datums: ["axis" as const, "plane" as const], sketch: true, hint: "A straight edge, a flat face or plane (its normal), or an axis." };

/** How far a point is from an attractor: a point, or the nearest place on a curve. */
export function attractorDistance(ctx: EvalContext, t: RefTarget | null): (p: Vec3) => number {
  if (!t) throw ctx.fail("Pick the attractor: a point, a vertex, or a curve.");
  const isCurve = t.kind === "edge" || (t.kind === "datum" && ctx.datum(t.feature).kind === "curve") || (t.kind === "sketch" && (ctx.sketch(t.feature).data.entities[t.entity] as any)?.type !== "point");
  if (!isCurve) { const at = pointOf(ctx, t, "attractor"); return (p) => length(sub(p, at)); }
  const pts = samplePoints(ctx, curveOf(ctx, t, "attractor"), 200);
  return (p) => {
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], ab = sub(pts[i], a), l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
      const ap = sub(p, a), f = l2 > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / l2)) : 0;
      best = Math.min(best, length(sub(ap, scale(ab, f))));
    }
    return best;
  };
}

export default defineFeature<AttractorPatternParams>({
  type: "cf-geo-attractor-pattern",
  title: "Attractor pattern",
  hint: "A grid of copies that grow, shrink or turn with their distance from a point or curve.",
  keywords: "attractor pattern gradient scale by distance variable pattern parametric array size falloff",
  icon: '<circle class="s" cx="4.5" cy="4.5" r="1"/><circle class="s" cx="11" cy="4.5" r="1.4"/><circle class="f" cx="18.5" cy="4.5" r="2"/><circle cx="18.5" cy="4.5" r="2"/><circle class="s" cx="4.5" cy="11.5" r="1.4"/><circle class="f" cx="11" cy="11.5" r="2"/><circle cx="11" cy="11.5" r="2"/><circle class="f" cx="18.5" cy="11.5" r="2.6"/><circle cx="18.5" cy="11.5" r="2.6"/><circle class="f" cx="4.5" cy="19" r="2"/><circle cx="4.5" cy="19" r="2"/><circle class="f" cx="11" cy="19" r="2.6"/><circle cx="11" cy="19" r="2.6"/><path class="t" d="M17 17.5l3 3M20 17.5l-3 3"/>',
  toolbarOrder: 301, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ ...copyDefaults(), direction: null, spacing: 10, count: 6, direction2: null, spacing2: 10, count2: 4, attractor: null, reach: 50, sizeNear: 0.4, sizeFar: 1, angleNear: 0, angleFar: 0, ease: "linear", cull: 0.05 }),
  schema: [
    ...copyFields("Copy"),
    { key: "direction", label: "Direction", ...DIRECTION },
    { key: "spacing", label: "Spacing", kind: "number", unit: "mm", step: 1 },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "direction2", label: "Direction 2", ...DIRECTION },
    { key: "spacing2", label: "Spacing 2", kind: "number", unit: "mm", step: 1 },
    { key: "count2", label: "Count 2", kind: "number", unit: "none", min: 1, step: 1 },
    { key: "attractor", label: "Attractor", kind: "refs", of: ["vertex", "edge"], single: true, datums: ["point", "curve"], sketch: true, hint: "A point or vertex, or a curve: copies change with their distance from it." },
    { key: "reach", label: "Reach", kind: "number", unit: "mm", min: 0.001, step: 5, hint: "The distance at which a copy has its far size and angle." },
    { key: "sizeNear", label: "Size at the attractor", kind: "number", unit: "none", min: 0, step: 0.1, hint: "1 is the original's size." },
    { key: "sizeFar", label: "Size at the reach", kind: "number", unit: "none", min: 0, step: 0.1 },
    { key: "angleNear", label: "Turn at the attractor", kind: "number", unit: "deg", step: 15 },
    { key: "angleFar", label: "Turn at the reach", kind: "number", unit: "deg", step: 15 },
    { key: "ease", label: "Blend", kind: "enum", options: [{ value: "linear", label: "Linear" }, { value: "smooth", label: "Smooth" }] },
    { key: "cull", label: "Leave out below size", kind: "number", unit: "none", min: 0, step: 0.05, hint: "Copies smaller than this are not made." },
  ],

  evaluate(ctx: EvalContext, p: AttractorPatternParams) {
    const n1 = countOf(ctx, p.count, "count"), n2 = countOf(ctx, p.count2, "second count");
    if (n1 * n2 > 2500) throw ctx.fail("That is too many copies (at most 2500).");
    if (!Number.isFinite(p.spacing) || !Number.isFinite(p.spacing2)) throw ctx.fail("The spacings must be numbers.");
    if (!(p.reach > 0)) throw ctx.fail("The reach must be more than zero.");
    for (const key of ["sizeNear", "sizeFar"]) if (!(p[key] >= 0) || p[key] > 100) throw ctx.fail("A size is a factor between 0 and 100 (1 is the original's size).");
    const u1 = axisOf(ctx, p.direction, "direction").dir, u2 = axisOf(ctx, p.direction2, "second direction").dir;
    const normal = cross(u1, u2);
    if (length(normal) < 1e-6) throw ctx.fail("The two directions are parallel. Pick directions that span a plane.");
    const distance = attractorDistance(ctx, p.attractor);
    const centre = seedCentre(ctx, p);
    const sites: Site[] = [];
    for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) {
      if (!i && !j) continue;
      const to = add(centre, add(scale(u1, i * p.spacing), scale(u2, j * p.spacing2)));
      const f = falloff(distance(to), p.reach, p.ease);
      const size = p.sizeNear + (p.sizeFar - p.sizeNear) * f, angle = ((p.angleNear + (p.angleFar - p.angleNear) * f) * Math.PI) / 180;
      if (size < Math.max(Number(p.cull) || 0, 1e-4)) continue;
      sites.push({ key: `i${i + 1}.${j + 1}`, to, angle, size });
    }
    if (!sites.length) ctx.warn("No copy was made: every one is smaller than the size to leave out.");
    copySites(ctx, p, sites, centre, normalize(normal));
  },
});
