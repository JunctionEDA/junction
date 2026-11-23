// replicate.ts — Replicate: a part mated in one hole is put in every hole like it.  Given the geometry a mate
// uses on the part it sits on (a circular edge, a cylindrical face, a flat face), find the other geometry of
// that part that is the same: the same kind of surface, the same radius, facing the same way and, for an edge
// or a flat face, lying in the same plane.  Pure, from the tessellation (connectors/infer.ts).
import type { BodyMesh, GeomRef } from "../../mechanical/api";
import { connectorOf } from "../connectors/infer";
import { cross, dot, len, sub } from "../solver/math";
import type { MateFrame } from "../solver/types";

const sameAxis = (a: MateFrame, b: MateFrame): boolean => len(cross(sub(b.o, a.o), a.z)) < 1e-4;

/** The other faces or edges of `mesh` that match `ref`: where Replicate puts its copies, the nearest first. */
export function matchingRefs(mesh: BodyMesh, ref: GeomRef): GeomRef[] {
  const f0 = connectorOf(mesh, ref);
  if (!f0 || ref.kind === "vertex" || !(f0.surface === "circle" || f0.surface === "cylinder")) return [];
  const names = ref.kind === "face" ? mesh.faces.names : mesh.edges.names;
  const found: { name: string; f: MateFrame }[] = [];
  for (const name of names) {
    if (name === ref.name) continue;
    const f = connectorOf(mesh, { kind: ref.kind, name });
    if (!f || f.surface !== f0.surface) continue;
    if (Math.abs((f.radius || 0) - (f0.radius || 0)) > 1e-4 * Math.max(1, f0.radius || 0)) continue;
    if (dot(f.z, f0.z) < 0.9999) continue;
    // an edge is a rim: the copies sit on rims in the same plane (the other end of a through hole is not one more hole)
    if (f0.surface === "circle" && Math.abs(dot(sub(f.o, f0.o), f0.z)) > 1e-4) continue;
    if (sameAxis(f0, f) || found.some((x) => sameAxis(x.f, f))) continue;
    found.push({ name, f });
  }
  found.sort((a, b) => len(sub(a.f.o, f0.o)) - len(sub(b.f.o, f0.o)) || a.name.localeCompare(b.name));
  return found.map((x) => ({ kind: ref.kind, body: ref.body, name: x.name }) as GeomRef);
}
