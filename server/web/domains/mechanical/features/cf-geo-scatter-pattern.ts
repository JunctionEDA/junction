// cf-geo-scatter-pattern.ts — the Scatter pattern: copies of features or bodies thrown at random over a flat
// face, no two closer than a spacing, each optionally turned and sized at random.  The same seed number gives
// the same scatter on every rebuild and every machine.  Copies are named by their order: `<id>:r<n>:<seed face
// name>`.
import { defineFeature } from "../core/feature";
import { add, sub, toPlane, toWorld, type GeomRef } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { copySites, flatFace, seedCentre, type Site } from "../kernel/ops/cf-geo";
import { copyDefaults, copyFields, countOf, type CopyParams } from "./_pattern";
import { rng, scatter } from "./_cf-geo";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ScatterParams extends CopyParams { [key: string]: any; face: GeomRef | null; count: number; spacing: number; margin: number; seed: number; turn: number; sizeMin: number; sizeMax: number }

export default defineFeature<ScatterParams>({
  type: "cf-geo-scatter-pattern",
  title: "Scatter pattern",
  hint: "Copies at random places on a flat face, kept apart; the same seed gives the same scatter.",
  keywords: "random scatter pattern seed noise organic irregular poisson sprinkle",
  icon: '<rect class="f" x="3" y="3" width="18" height="18" rx="2"/><rect x="3" y="3" width="18" height="18" rx="2"/><circle class="s" cx="7" cy="8" r="1.2"/><circle class="s" cx="13.5" cy="6.5" r="1.2"/><circle class="s" cx="17.5" cy="11" r="1.2"/><circle class="s" cx="10" cy="12.5" r="1.2"/><circle class="s" cx="6.5" cy="16.5" r="1.2"/><circle class="s" cx="14" cy="17" r="1.2"/>',
  toolbarOrder: 303, toolbarSection: "library", toolbarMenu: "Patterns & texture", toolbarKeep: 0,
  defaults: () => ({ ...copyDefaults(), face: null, count: 20, spacing: 6, margin: 4, seed: 1, turn: 0, sizeMin: 1, sizeMax: 1 }),
  schema: [
    ...copyFields("Copy"),
    { key: "face", label: "Face", kind: "refs", of: ["face"], single: true, hint: "A flat face to scatter the copies over." },
    { key: "count", label: "Count", kind: "number", unit: "none", min: 1, step: 1, hint: "How many copies to place. Fewer are made when they do not fit." },
    { key: "spacing", label: "Least spacing", kind: "number", unit: "mm", min: 0, step: 1, hint: "No two copies, nor a copy and the original, are closer than this, centre to centre." },
    { key: "margin", label: "Margin", kind: "number", unit: "mm", min: 0, step: 1 },
    { key: "seed", label: "Seed", kind: "number", unit: "none", step: 1, hint: "Another whole number gives another scatter." },
    { key: "turn", label: "Random turn up to", kind: "number", unit: "deg", min: 0, max: 360, step: 15 },
    { key: "sizeMin", label: "Smallest size", kind: "number", unit: "none", min: 0.01, step: 0.1 },
    { key: "sizeMax", label: "Largest size", kind: "number", unit: "none", min: 0.01, step: 0.1 },
  ],

  evaluate(ctx: EvalContext, p: ScatterParams) {
    const n = countOf(ctx, p.count, "count");
    if (!(p.spacing >= 0) || !(p.margin >= 0)) throw ctx.fail("The spacing and the margin cannot be less than zero.");
    if (!(p.sizeMin > 0) || !(p.sizeMax >= p.sizeMin) || p.sizeMax > 100) throw ctx.fail("The sizes are factors: the smallest more than zero, the largest no smaller than it.");
    const f = flatFace(ctx, p.face);
    const centre = seedCentre(ctx, p), anchor = toPlane(f.frame, centre), from = toWorld(f.frame, anchor);
    const random = rng(p.seed);
    const sites = scatter(f.region, n, p.spacing, p.margin, random, [anchor]);
    // sizes and turns come from a second stream, so changing the count does not reshuffle the ones before
    const style = rng((Math.round(Number(p.seed) || 0) + 7919) | 0);
    const turn = ((Number(p.turn) || 0) * Math.PI) / 180;
    const placed: Site[] = sites.map((s, i) => {
      const angle = (style() * 2 - 1) * turn, size = p.sizeMin + style() * (p.sizeMax - p.sizeMin);
      return { key: `r${i + 1}`, to: add(centre, sub(toWorld(f.frame, s), from)), angle, size };
    });
    if (sites.length < n) ctx.warn(`Only ${sites.length} of ${n} copies fit with this spacing and margin.`);
    copySites(ctx, p, placed, centre, f.frame.normal);
  },
});
