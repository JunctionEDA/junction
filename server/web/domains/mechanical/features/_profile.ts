// _profile.ts — what a `profile` field stores, and what it means when it holds faces.  Pure: the page fills it
// (ui/fields.ts), the worker turns it into kernel faces (kernel/ops/profile.ts), the MCP model checks it.
//
// Stored shape (JSON, in a feature's params):
//   { sketch: <sketch feature id> | null, regions: null | string[], faces?: GeomRef[] }
//
// `sketch` with `regions` is a sketch and which of its closed regions (null: all of them).  `faces` are flat
// faces of bodies made earlier, kept as GeomRefs like any other face pick, for a field that says `faces: true`
// (Extrude, Revolve, Sweep): each face is a region of its own, with its holes.  One value may hold both.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import { isGeomRef, type GeomRef } from "../core/geometry";

export interface ProfileValue { sketch?: string | null; regions?: string[] | null; faces?: GeomRef[] | null }

/** The faces a profile value holds (none for a sketch alone, or a value that is not a profile). */
export function profileFaces(value: unknown): GeomRef[] {
  const v = value as ProfileValue | null | undefined;
  return v && typeof v === "object" && Array.isArray(v.faces) ? v.faces.filter((f): f is GeomRef => isGeomRef(f) && f.kind === "face") : [];
}
/** The sketch a profile value names, or null. */
export function profileSketch(value: unknown): string | null {
  const v = value as ProfileValue | null | undefined;
  return v && typeof v === "object" && typeof v.sketch === "string" && v.sketch ? v.sketch : null;
}
/** True when the value names neither a sketch nor a face. */
export const profileEmpty = (value: unknown): boolean => !profileSketch(value) && !profileFaces(value).length;

/** A profile value from its parts, or null when it would hold nothing.  `faces` is left out when there are none. */
export function makeProfile(sketch: string | null, regions: string[] | null, faces: readonly GeomRef[]): JsonObject | null {
  if (!sketch && !faces.length) return null;
  const out: JsonObject = { sketch: sketch || null, regions: sketch && regions && regions.length ? regions : null };
  if (faces.length) out.faces = faces.map((f) => ({ kind: "face", body: f.body, name: f.name }));
  return out;
}

/** A short stable word for a string (FNV-1a, base 36): what keeps the names made from a face's name short. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * The region id of a face used as a profile: what stands where a sketch region's id does in the names a
 * feature makes (`<feature>:end:<this>`), and in the id of a body it makes among several.  It follows from the
 * stored reference alone, so it is the same on every rebuild for as long as the reference is.
 */
export const faceRegionId = (ref: { body: string; name: string }): string => `face.${shortHash(`${ref.body}\u0000${ref.name}`)}`;
/** What stands for a sketch entity in `<feature>:side:<entity>` for an edge of a face used as a profile. */
export const faceEdgeId = (edgeName: string): string => `edge.${shortHash(edgeName)}`;
