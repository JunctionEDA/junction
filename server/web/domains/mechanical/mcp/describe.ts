// describe.ts — what is there, in words: a few lines an AI assistant can read for the price of a sentence, where
// a picture costs a thousand tokens and a full read of the tree more.  A part: its size, where it stands, how
// many flat faces, the holes by diameter and direction, the round bosses.  A feature: its type and the numbers
// that differ from a new one's.  Also the thinnest wall of a part, found by sampling (check below).
//
// Pure: it reads tessellations (BodyMesh) and parameters.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition } from "../core/feature";
import { cross, dot, length, normalize, sub, type Vec3 } from "../core/geometry";
import type { BodyMesh } from "../kernel/protocol";
import { summarise } from "./select";

const r2 = (v: number): number => { const x = Math.round(v * 100) / 100; return Object.is(x, -0) ? 0 : x; };

/** The box of a mesh as it stands under a placement (the rows of a 3 x 4 matrix), or as it is. */
export function placedBox(mesh: BodyMesh, t?: readonly number[] | null): number[] {
  const b = mesh.bbox;
  if (!t || t.length !== 12) return b.slice();
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const p = [c & 1 ? b[3] : b[0], c & 2 ? b[4] : b[1], c & 4 ? b[5] : b[2]];
    for (let k = 0; k < 3; k++) { const v = t[k * 4] * p[0] + t[k * 4 + 1] * p[1] + t[k * 4 + 2] * p[2] + t[k * 4 + 3]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
  }
  return [...lo, ...hi];
}

const axisWord = (a: Vec3): string => (Math.abs(a[0]) > 0.999 ? "x" : Math.abs(a[1]) > 0.999 ? "y" : Math.abs(a[2]) > 0.999 ? "z" : `[${a.map(r2).join(", ")}]`);

/** One part in a sentence. */
export function describePart(name: string, mesh: BodyMesh, o: { transform?: readonly number[] | null; volume?: number; mass_g?: number | null; material?: string } = {}): string {
  const b = placedBox(mesh, o.transform);
  const faces = summarise(mesh, "face");
  const flat = faces.filter((f) => f.type === "plane").length, other = faces.filter((f) => f.type === "other").length;
  const group = (hole: boolean): string => {
    const by = new Map<string, number>();
    for (const f of faces) if (f.type === "cylinder" && !!f.hole === hole) { const k = `⌀${r2(2 * (f.radius || 0))} along ${axisWord(f.axis as Vec3)}`; by.set(k, (by.get(k) || 0) + 1); }
    return Array.from(by.entries()).map(([k, n]) => `${n} × ${k}`).join(", ");
  };
  const holes = group(true), bosses = group(false);
  let s = `${name}: ${r2(b[3] - b[0])} × ${r2(b[4] - b[1])} × ${r2(b[5] - b[2])} mm, from [${r2(b[0])}, ${r2(b[1])}, ${r2(b[2])}] to [${r2(b[3])}, ${r2(b[4])}, ${r2(b[5])}]`;
  if (o.volume !== undefined) s += `; volume ${r2(o.volume)} mm3`;
  if (o.mass_g !== undefined && o.mass_g !== null) s += `, ${r2(o.mass_g)} g${o.material ? ` of ${o.material}` : ""}`;
  s += `; ${faces.length} faces (${flat} flat${other ? `, ${other} curved` : ""})`;
  if (holes) s += `; hole walls: ${holes}`;
  if (bosses) s += `; round outer faces: ${bosses}`;
  return s + ".";
}

/** A feature in a few words: its type and the plain parameters that are not a new one's. */
export function describeFeature(def: FeatureDefinition | undefined, f: { name: string; featureType: string; params: JsonObject; suppressed?: boolean }, status?: string, message?: string): string {
  const base = def ? def.defaults() : {};
  const said: string[] = [];
  for (const [k, v] of Object.entries(f.params || {})) {
    if (k.startsWith("$") || k === "sketch") continue;
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") { if (base[k] !== v) said.push(v === true ? k : `${k} ${typeof v === "number" ? r2(v) : v}`); }
    else if (k === "plane" && v && typeof v === "object" && !Array.isArray(v)) said.push(`on ${(v as JsonObject).kind === "plane" ? String((v as JsonObject).plane) : (v as JsonObject).kind === "face" ? "a face" : "a plane feature"}`);
    else if (Array.isArray(v) && v.length) said.push(`${v.length} ${k}`);
  }
  if (f.featureType === "sketch") {
    const n: { [t: string]: number } = {};
    for (const e of Object.values(((f.params.sketch as JsonObject | undefined)?.entities as JsonObject) || {})) { const t = (e as JsonObject).type as string; if (t !== "point") n[t] = (n[t] || 0) + 1; }
    const drawn = Object.keys(n).map((t) => `${n[t]} ${t}${n[t] === 1 ? "" : "s"}`).join(", ");
    if (drawn) said.push(drawn);
  }
  const state = f.suppressed ? " [suppressed]" : status && status !== "ok" ? ` [${status}${message ? ": " + message : ""}]` : "";
  return `${f.name} (${f.featureType}${said.length ? ": " + said.slice(0, 8).join(", ") : ""})${state}`;
}

// ---------------------------------------------------------------- the thinnest wall

export interface Thickness { min: number; at: Vec3; face: string; samples: number }

/**
 * The thinnest wall of a solid, by sampling: from the middle of a triangle a ray goes into the material, and how
 * far it travels before it comes out is the wall there.  An estimate (it looks only where it samples, straight
 * across), good for "is anything thinner than a millimetre"; null for a mesh with nothing to sample.
 */
export function minThickness(mesh: BodyMesh, budget = 40e6): Thickness | null {
  const P = mesh.positions, I = mesh.indices, tris = I.length / 3;
  if (tris < 4) return null;
  const step = Math.max(1, Math.ceil(tris / Math.max(50, Math.min(2500, Math.floor(budget / tris)))));
  const pt = (i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  let best: Thickness | null = null, samples = 0;
  for (let t = 0; t < tris; t += step) {
    const a = pt(I[t * 3]), b = pt(I[t * 3 + 1]), c = pt(I[t * 3 + 2]);
    const nn = cross(sub(b, a), sub(c, a));
    if (length(nn) < 1e-9) continue;
    const n = normalize(nn), d: Vec3 = [-n[0], -n[1], -n[2]];
    const o: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    samples++;
    let near = Infinity;
    for (let u = 0; u < tris; u++) {
      if (u === t) continue;
      // Möller–Trumbore
      const p0 = pt(I[u * 3]), e1 = sub(pt(I[u * 3 + 1]), p0), e2 = sub(pt(I[u * 3 + 2]), p0);
      const h = cross(d, e2), det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s = sub(o, p0), uu = dot(s, h) / det;
      if (uu < -1e-9 || uu > 1 + 1e-9) continue;
      const q = cross(s, e1), vv = dot(d, q) / det;
      if (vv < -1e-9 || uu + vv > 1 + 1e-9) continue;
      const dist = dot(e2, q) / det;
      if (dist > 1e-6 && dist < near) near = dist;
    }
    if (Number.isFinite(near) && (!best || near < best.min)) {
      let face = "";
      for (let fi = 0; fi < mesh.faces.names.length; fi++) if (t * 3 >= mesh.faces.start[fi] && t * 3 < mesh.faces.start[fi] + mesh.faces.count[fi]) { face = mesh.faces.names[fi]; break; }
      best = { min: near, at: [r2(o[0]), r2(o[1]), r2(o[2])], face, samples: 0 };
    }
  }
  if (best) { best.min = Math.round(best.min * 1e4) / 1e4; best.samples = samples; }
  return best;
}
