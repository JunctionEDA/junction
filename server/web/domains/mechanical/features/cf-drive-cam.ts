// cf-drive-cam.ts — Plate cam: a disc cam whose outline lifts a follower by a given profile.  The profile is
// either rise – dwell – fall – dwell (the angles and the lift, with a motion law for the rise and the fall), or
// a table of angle: lift pairs joined by a smooth periodic curve.
//
// Motion laws (s from 0 to 1 over the segment):  harmonic ½(1 − cos πs);  cycloidal s − sin(2πs) / 2π;
// 3-4-5 polynomial 10s³ − 15s⁴ + 6s⁵;  uniform s (constant velocity: infinite acceleration at its ends, for
// slow cams only).
//
// Follower: a knife edge on the cam's axis follows the outline itself (base radius + lift).  A roller follower's
// centre does that, so the cam is smaller all round by the roller's radius, measured square to the curve; the
// feature fails where the roller could not follow (a hollow tighter than the roller).
//
// Names: `<id>:profile`, `<id>:bottom`, `<id>:top`, `<id>:bore`, `<id>:key:…`, `<id>:hub:…`.
import { defineFeature } from "../core/feature";
import type { EvalContext } from "../kernel/types";
import type { P2 } from "../kernel/ops/cf-drive";
import { boreDefaults, boreFields, DRIVES, finish, makeField, num, placedDefaults, placedFields, positive, rad, SECTION, spaceOf, wheel, type Bore, type Placed } from "./_cf-drive";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CamParams extends Bore, Placed {
  [key: string]: any;
  profile: "rdf" | "table"; baseRadius: number; lift: number; rise: number; dwell: number; fall: number; law: "harmonic" | "cycloidal" | "poly345" | "uniform";
  table: string; follower: "knife" | "roller"; roller: number; thickness: number; operation: string;
}

const LAWS: { [law: string]: (s: number) => number } = {
  harmonic: (s) => 0.5 * (1 - Math.cos(Math.PI * s)),
  cycloidal: (s) => s - Math.sin(2 * Math.PI * s) / (2 * Math.PI),
  poly345: (s) => 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5,
  uniform: (s) => s,
};

/** A table "0: 0, 90: 8, 180: 8, 270: 0" as (angle in degrees, lift) pairs in order of angle, or a message. */
export function parseLiftTable(text: string): { rows: [number, number][] } | { error: string } {
  const rows: [number, number][] = [];
  for (const part of String(text || "").split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^(-?\d+(?:\.\d+)?)\s*[:=\s]\s*(-?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) return { error: `"${part}" is not an angle and a lift. Write pairs like 0: 0, 90: 8, 180: 8.` };
    const a = Number(m[1]), l = Number(m[2]);
    if (a < 0 || a >= 360) return { error: `The angle ${a} must be from 0 up to (not including) 360.` };
    rows.push([a, l]);
  }
  rows.sort((p, q) => p[0] - q[0]);
  if (rows.length < 3) return { error: "The table needs three or more angle: lift pairs." };
  for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] < 1e-6) return { error: `The angle ${rows[i][0]} is in the table twice.` };
  return { rows };
}

/** A periodic cubic through the table's rows (Catmull-Rom on the circle): the lift at an angle in degrees. */
function tableLift(rows: [number, number][], angle: number): number {
  const n = rows.length;
  const X = (j: number) => rows[((j % n) + n) % n][0] + 360 * Math.floor(j / n), Y = (j: number) => rows[((j % n) + n) % n][1];
  let j = -1;   // the piece from X(j) to X(j + 1) that holds the angle
  while (X(j + 1) <= angle) j++;
  const x0 = X(j - 1), x1 = X(j), x2 = X(j + 1), x3 = X(j + 2), s = (angle - x1) / (x2 - x1);
  // tangents from the neighbours on each side, then a Hermite piece
  const m1 = ((Y(j + 1) - Y(j - 1)) / (x2 - x0)) * (x2 - x1), m2 = ((Y(j + 2) - Y(j)) / (x3 - x1)) * (x2 - x1);
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return h00 * Y(j) + h10 * m1 + h01 * Y(j + 1) + h11 * m2;
}

export default defineFeature<CamParams>({
  type: "cf-cam",
  title: "Plate cam",
  icon: '<path class="f" d="M12 4c4.5 0 8 3 8 7.5S16 20 11 20s-7-3.5-7-7 3-9 8-9z"/><path d="M12 4c4.5 0 8 3 8 7.5S16 20 11 20s-7-3.5-7-7 3-9 8-9z"/><circle cx="10.5" cy="13" r="2"/>',
  hint: "A disc cam from a lift profile: rise, dwell and fall by a motion law, or a table of lifts",
  keywords: "cam plate cam disc cam lift profile follower rise dwell fall cycloidal harmonic camshaft lobe",
  toolbarSection: SECTION, toolbarMenu: DRIVES, toolbarOrder: 32, toolbarKeep: 0,
  defaults: () => ({ profile: "rdf", baseRadius: 20, lift: 8, rise: 90, dwell: 60, fall: 90, law: "cycloidal", table: "0: 0, 90: 8, 180: 8, 270: 0", follower: "knife", roller: 5, thickness: 8, ...boreDefaults(8), ...placedDefaults(), operation: "new" }),
  schema: [
    { key: "profile", label: "Profile", kind: "enum", options: [{ value: "rdf", label: "Rise, dwell, fall" }, { value: "table", label: "Table" }] },
    { key: "baseRadius", label: "Base radius", kind: "number", unit: "mm", min: 0.1, step: 1, hint: "The follower's distance from the axis at no lift." },
    { key: "lift", label: "Lift", kind: "number", unit: "mm", min: 0.01, step: 1, visible: (p) => p.profile !== "table" },
    { key: "rise", label: "Rise over", kind: "number", unit: "deg", min: 1, max: 358, step: 5, visible: (p) => p.profile !== "table" },
    { key: "dwell", label: "Dwell at the top", kind: "number", unit: "deg", min: 0, max: 358, step: 5, visible: (p) => p.profile !== "table" },
    { key: "fall", label: "Fall over", kind: "number", unit: "deg", min: 1, max: 358, step: 5, visible: (p) => p.profile !== "table" },
    { key: "law", label: "Motion", kind: "enum", options: [{ value: "cycloidal", label: "Cycloidal" }, { value: "harmonic", label: "Harmonic" }, { value: "poly345", label: "3-4-5 polynomial" }, { value: "uniform", label: "Uniform" }], visible: (p) => p.profile !== "table" },
    { key: "table", label: "Angle: lift", kind: "text", hint: "Pairs of angle (degrees, 0 up to 360) and lift (mm), like 0: 0, 90: 8, 180: 8, 270: 0. A smooth curve joins them.", visible: (p) => p.profile === "table" },
    { key: "follower", label: "Follower", kind: "enum", options: [{ value: "knife", label: "Knife edge" }, { value: "roller", label: "Roller" }] },
    { key: "roller", label: "Roller diameter", kind: "number", unit: "mm", min: 0.1, step: 1, visible: (p) => p.follower === "roller" },
    { key: "thickness", label: "Thickness", kind: "number", unit: "mm", min: 0.1, step: 1 },
    ...boreFields, ...placedFields, makeField,
  ],
  evaluate(ctx: EvalContext, p: CamParams) {
    const id = ctx.feature.id;
    const base = positive(ctx, p.baseRadius, "The base radius"), thickness = positive(ctx, p.thickness, "The thickness");
    let lift: (deg: number) => number;
    if (p.profile === "table") {
      const t = parseLiftTable(p.table);
      if ("error" in t) throw ctx.fail(t.error);
      lift = (a) => tableLift(t.rows, a);
    } else {
      const h = positive(ctx, p.lift, "The lift"), rise = positive(ctx, p.rise, "The rise angle"), dwell = Math.max(0, num(p.dwell)), fall = positive(ctx, p.fall, "The fall angle");
      if (rise + dwell + fall > 360 + 1e-9) throw ctx.fail(`Rise, dwell and fall add up to ${rise + dwell + fall}°: they must fit in 360°.`);
      const law = LAWS[p.law] || LAWS.cycloidal;
      lift = (a) => (a < rise ? h * law(a / rise) : a < rise + dwell ? h : a < rise + dwell + fall ? h * (1 - law((a - rise - dwell) / fall)) : 0);
    }
    const rr = p.follower === "roller" ? positive(ctx, p.roller, "The roller diameter") / 2 : 0;
    // the pitch curve (where the follower's point or the roller's centre goes), every degree; then the cam's outline inside it
    const N = 360, pitch: P2[] = [];
    for (let i = 0; i < N; i++) { const r = base + lift(i); if (!(r > 0.05 * base)) throw ctx.fail(`At ${i}° the lift takes the follower to the axis. Use a larger base radius.`); pitch.push([r * Math.cos(rad(i)), r * Math.sin(rad(i))]); }
    let outline = pitch, least = base;
    if (rr > 0) {
      outline = pitch.map((q, i) => {
        const a = pitch[(i + N - 1) % N], b = pitch[(i + 1) % N], t: P2 = [b[0] - a[0], b[1] - a[1]], l = Math.hypot(t[0], t[1]) || 1;
        return [q[0] - (t[1] / l) * rr, q[1] + (t[0] / l) * rr] as P2;   // inwards: to the left of a counter-clockwise curve
      });
      least = Infinity;
      for (let i = 0; i < N; i++) {
        const q = outline[i], nx = outline[(i + 1) % N], t: P2 = [pitch[(i + 1) % N][0] - pitch[i][0], pitch[(i + 1) % N][1] - pitch[i][1]];
        if ((nx[0] - q[0]) * t[0] + (nx[1] - q[1]) * t[1] <= 0) throw ctx.fail(`Near ${i}° the roller cannot follow the profile: the curve there is tighter than the roller. Use a smaller roller, a larger base radius or a gentler profile.`);
        least = Math.min(least, Math.hypot(q[0], q[1]));
      }
    } else for (const q of pitch) least = Math.min(least, Math.hypot(q[0], q[1]));
    const body = wheel(ctx, spaceOf(ctx, p), { closed: { pts: outline.filter((_, i) => i % 2 === 0), label: "profile" } }, { thickness, inside: least, prefix: id }, p);
    finish(ctx, [body], p.operation);
  },
});
