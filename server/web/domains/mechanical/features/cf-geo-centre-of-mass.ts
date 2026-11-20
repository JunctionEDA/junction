// cf-geo-centre-of-mass.ts — the Centre of mass: a reference point where the picked bodies balance, that
// follows the part as it changes, or a mate connector there (a point with its three axes, lined up with the
// model's), to sketch on, to measure from, or to mate by.  Bodies count by their volume: the same material is
// assumed for all of them.
import { defineFeature } from "../core/feature";
import { add, scale, type Vec3 } from "../core/geometry";
import type { Body, EvalContext } from "../kernel/types";
import { solidCentre } from "../kernel/ops/shapes";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CentreOfMassParams { [key: string]: any; bodies: string[]; output: "point" | "connector" }

/** The centre of mass of bodies of one density, and their volume. */
export function centreOfMass(ctx: EvalContext, bodies: readonly Body[]): { at: Vec3; volume: number } {
  let at: Vec3 = [0, 0, 0], volume = 0;
  for (const b of bodies) { const v = ctx.k.volume(b.shape); if (!(v > 0)) continue; at = add(at, scale(solidCentre(ctx.k, b.shape), v)); volume += v; }
  if (!(volume > 0)) throw ctx.fail("The bodies have no volume, so no centre of mass.");
  return { at: scale(at, 1 / volume), volume };
}

export default defineFeature<CentreOfMassParams>({
  type: "cf-geo-centre-of-mass",
  title: "Centre of mass",
  hint: "A reference point (or mate connector) where the picked bodies balance.",
  keywords: "center of mass centre gravity cog com centroid balance point datum reference mate connector",
  icon: '<circle cx="12" cy="12" r="8.500"/><path class="s" d="M12 3.500a8.500 8.500 0 0 1 8.500 8.500H12zM12 20.500a8.500 8.500 0 0 1-8.500-8.500H12z"/><path class="t" d="M12 1.500v21M1.500 12h21"/>',
  toolbarOrder: 331, toolbarSection: "library", toolbarMenu: "Geometry & utilities", toolbarKeep: 0,
  defaults: () => ({ bodies: [], output: "point" }),
  schema: [
    { key: "bodies", label: "Bodies", kind: "bodies", hint: "Leave empty for every body." },
    { key: "output", label: "Make", kind: "enum", options: [{ value: "point", label: "Point" }, { value: "connector", label: "Mate connector" }] },
  ],

  evaluate(ctx: EvalContext, p: CentreOfMassParams) {
    const ids = Array.isArray(p.bodies) ? p.bodies : [];
    const bodies: Body[] = ids.length ? ids.map((b) => ctx.body(b)).filter((b): b is Body => !!b) : ctx.bodies().slice();
    if (!bodies.length) throw ctx.fail(ids.length ? "The bodies no longer exist. Pick them again." : "There is no body to find the centre of mass of.");
    const { at } = centreOfMass(ctx, bodies);
    if (p.output === "connector") ctx.setDatum({ featureId: ctx.feature.id, kind: "plane", frame: { origin: at, x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] }, centre: at, size: 10, mate: true });
    else ctx.setDatum({ featureId: ctx.feature.id, kind: "point", at });
  },
});
