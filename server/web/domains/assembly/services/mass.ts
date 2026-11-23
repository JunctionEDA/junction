// mass.ts — the mass properties of an assembly: its parts' volumes and masses, each where its instance stands,
// added up.  Pure: the panel (panels/mass.tsx) reads each part studio's bodies from its modelling worker
// ("mass-properties", exact from the B-rep) and hands them here with the instances' placements.
import type { Vec3 } from "../../mechanical/api";
import { apply } from "../core/transform";
import type { Transform } from "../document/format";

/** One body as its part studio measures it: in the body's own space. */
export interface BodyMass { volume: number; /** kg, or null when the body has no material */ mass: number | null; centre: Vec3 }
export interface MassRow { instance: string; name: string; volume: number; mass: number | null; /** in assembly space */ centre: Vec3 }
export interface MassTotal {
  count: number;
  /** mm³ */
  volume: number;
  /** kg: of the parts that have a material */
  mass: number;
  /** how many parts have no material, so no mass */
  unweighed: number;
  /** by mass when every part has one, else by volume; null when there is nothing */
  centre: Vec3 | null;
  centreBy: "mass" | "volume";
}

/** A body's row for one instance of it: the same numbers, the centre carried to where the instance stands. */
export function placeMass(instance: string, name: string, body: BodyMass, transform: Transform): MassRow {
  return { instance, name, volume: body.volume, mass: body.mass, centre: apply(transform, body.centre) };
}

export function totalMass(rows: readonly MassRow[]): MassTotal {
  let volume = 0, mass = 0, unweighed = 0;
  for (const r of rows) { volume += r.volume; if (r.mass === null) unweighed++; else mass += r.mass; }
  const byMass = rows.length > 0 && unweighed === 0 && mass > 0;
  const sum: Vec3 = [0, 0, 0]; let w = 0;
  for (const r of rows) { const k = byMass ? (r.mass as number) : r.volume; sum[0] += r.centre[0] * k; sum[1] += r.centre[1] * k; sum[2] += r.centre[2] * k; w += k; }
  return { count: rows.length, volume, mass, unweighed, centre: w > 0 ? [sum[0] / w, sum[1] / w, sum[2] / w] : null, centreBy: byMass ? "mass" : "volume" };
}

/** A measurement between two connector frames in assembly space: what Measure shows. */
export interface Measured { distance: number; delta: Vec3; /** degrees between the two axes, 0 to 90 for lines and planes */ angle: number | null; /** the distance between the two axes or planes when they are parallel */ apart: number | null }
export function measureFrames(a: { o: Vec3; z: Vec3; surface?: string }, b: { o: Vec3; z: Vec3; surface?: string }): Measured {
  const d: Vec3 = [b.o[0] - a.o[0], b.o[1] - a.o[1], b.o[2] - a.o[2]];
  const distance = Math.hypot(d[0], d[1], d[2]);
  const directed = (s?: string) => s !== undefined && s !== "point" && s !== "other";
  let angle: number | null = null, apart: number | null = null;
  if (directed(a.surface) && directed(b.surface)) {
    const c = Math.min(1, Math.abs(a.z[0] * b.z[0] + a.z[1] * b.z[1] + a.z[2] * b.z[2]));
    // a plane's direction is its normal, a line's or an axis's is along it: a line lying in a plane is at 0° to it
    const planes = (a.surface === "plane" ? 1 : 0) + (b.surface === "plane" ? 1 : 0);
    const raw = (Math.acos(c) * 180) / Math.PI;
    angle = planes === 1 ? 90 - raw : raw;
    if (raw < 1e-4 && planes !== 1) {
      const along = d[0] * a.z[0] + d[1] * a.z[1] + d[2] * a.z[2];
      apart = planes === 2 ? Math.abs(along) : Math.sqrt(Math.max(0, distance * distance - along * along));
    }
  }
  return { distance, delta: d, angle, apart };
}
