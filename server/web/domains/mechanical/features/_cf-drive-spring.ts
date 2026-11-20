// _cf-drive-spring.ts — what the spring features (cf-drive-*-spring.ts) share: how a coil's diameter is given,
// and points along a coil whose pitch may change on the way.  Pure: no kernel.
import type { ParamField } from "../core/feature";
import type { Vec3 } from "../core/geometry";
import type { EvalContext } from "../kernel/types";
import { positive } from "./_cf-drive";

export interface Coil { wire: number; diameter: number; diameterIs: "outer" | "mean" | "inner"; left: boolean }
export const coilDefaults = (wire = 1.6, diameter = 16): Coil => ({ wire, diameter, diameterIs: "outer", left: false });
export const coilFields: ParamField[] = [
  { key: "wire", label: "Wire diameter", kind: "number", unit: "mm", min: 0.05, step: 0.1 },
  { key: "diameter", label: "Coil diameter", kind: "number", unit: "mm", min: 0.1, step: 1 },
  { key: "diameterIs", label: "Measured", kind: "enum", options: [{ value: "outer", label: "Outside" }, { value: "mean", label: "Mean" }, { value: "inner", label: "Inside" }] },
];
export const handField: ParamField = { key: "left", label: "Left-handed", kind: "boolean" };

/** The wire's diameter and the coil's mean radius, checked: a spring is wound on an index (mean diameter over wire) of at least 3. */
export function coilOf(ctx: EvalContext, p: Partial<Coil>): { d: number; R: number } {
  const d = positive(ctx, p.wire, "The wire diameter"), given = positive(ctx, p.diameter, "The coil diameter");
  const mean = p.diameterIs === "mean" ? given : p.diameterIs === "inner" ? given + d : given - d;
  if (!(mean >= 3 * d - 1e-9)) throw ctx.fail(`The coil is too tight for this wire: its mean diameter (${mean.toFixed(2)} mm) must be at least three times the wire's (${(3 * d).toFixed(2)} mm).`);
  return { d, R: mean / 2 };
}

/**
 * Points along a coil about z of radius `R`, from angle 0 at height `z0`: `parts` are stretches of so many
 * turns each climbing so much per turn, one after another.  `per` points to a turn.  The pitch changes over a
 * short stretch rather than at a point, so the curve through the points has no kink.
 */
export function coilPoints(R: number, z0: number, parts: readonly { turns: number; pitch: number }[], hand: number, per = 12): { pts: Vec3[]; turns: number; height: number } {
  const total = parts.reduce((s, x) => s + x.turns, 0), n = Math.max(2, Math.round(total * per));
  // the pitch at a number of turns from the start, blended over a quarter turn each side of a change
  const pitchAt = (t: number) => {
    let acc = 0, blend = 0.25;
    for (let i = 0; i < parts.length; i++) {
      const end = acc + parts[i].turns, next = parts[i + 1];
      if (t <= end - blend || !next) return parts[i].pitch;
      if (t < end + blend) { const s = (t - (end - blend)) / (2 * blend), w = s * s * (3 - 2 * s); return parts[i].pitch * (1 - w) + next.pitch * w; }
      acc = end;
    }
    return parts[parts.length - 1].pitch;
  };
  const pts: Vec3[] = [];
  let z = z0;
  for (let i = 0; i <= n; i++) {
    const t = (total * i) / n, a = hand * 2 * Math.PI * t;
    pts.push([R * Math.cos(a), R * Math.sin(a), z]);
    // the height climbs by the pitch at the middle of the step
    z += (pitchAt(t + total / n / 2) * total) / n;
  }
  return { pts, turns: total, height: pts[pts.length - 1][2] - z0 };
}
