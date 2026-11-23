// select.ts — faces, edges and vertices as an AI assistant finds them: what each one is (a flat face with its
// normal, a hole with its diameter, a straight edge with its length), and picking by description ("the top face",
// "the edges of that face", "the hole nearest this point") instead of by an opaque name.
//
// A feature and a mate refer to geometry by stable name ({ kind, body, name }, CONTRACT.md "Geometry names").
// The names are not meant to be read, so the tools give every face and edge a few numbers beside its name
// (`summarise`) and accept a `pick` in place of a name wherever a reference goes (`pickGeometry`); the pick is
// resolved against the model as built and the NAME is what is stored, so the reference then survives rebuilds
// like one a person clicked.
//
// Pure: it reads the tessellation (a BodyMesh), so it works on a part studio's bodies and on the pieces of an
// assembly's instances alike, with no kernel.  Numbers are millimetres, in the body's own space.
import type { BodyMesh } from "../kernel/protocol";
import { cross, dot, length, normalize, scale, sub, type Vec3 } from "../core/geometry";

export type GeoKind = "face" | "edge" | "vertex";

/** One face, edge or vertex, as the tools describe it. */
export interface GeoInfo {
  kind: GeoKind;
  name: string;
  /** face: plane, cylinder or other; edge: line, circle (a whole circle), arc or other; vertex: point */
  type: "plane" | "cylinder" | "other" | "line" | "circle" | "arc" | "point";
  /** an edge with the same face on both sides (where a cylinder's wall closes on itself): not a corner of the part */
  seam?: boolean;
  /** the middle: a flat face's centre, a point on a cylinder's axis, a circle's centre, a straight edge's midpoint */
  at: Vec3;
  /** a flat face's outward normal */
  normal?: Vec3;
  /** a cylinder's or a circle's axis, a straight edge's direction (the sense means nothing) */
  axis?: Vec3;
  radius?: number;
  /** a cylindrical face that is the wall of a hole (its normals point at the axis) */
  hole?: boolean;
  area?: number;
  length?: number;
}

const r4 = (v: number): number => { const x = Math.round(v * 1e4) / 1e4; return Object.is(x, -0) ? 0 : x; };
const v3 = (v: Vec3): Vec3 => [r4(v[0]), r4(v[1]), r4(v[2])];
const unitTidy = (v: Vec3): Vec3 => { const n = normalize(v); return [r4(n[0]), r4(n[1]), r4(n[2])]; };

const cache = new WeakMap<BodyMesh, { face: GeoInfo[]; edge: GeoInfo[]; vertex: GeoInfo[] }>();

function faceInfo(m: BodyMesh, fi: number): GeoInfo {
  const name = m.faces.names[fi], start = m.faces.start[fi], count = m.faces.count[fi];
  const P = m.positions, N = m.normals, I = m.indices;
  const pt = (i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const nm = (i: number): Vec3 => normalize([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]);
  let area = 0; const c: Vec3 = [0, 0, 0];
  const seen = new Set<number>();
  for (let t = start; t + 2 < start + count; t += 3) {
    const a = pt(I[t]), b = pt(I[t + 1]), d = pt(I[t + 2]);
    const w = length(cross(sub(b, a), sub(d, a))) / 2;
    area += w;
    for (let k = 0; k < 3; k++) c[k] += (w * (a[k] + b[k] + d[k])) / 3;
    seen.add(I[t]); seen.add(I[t + 1]); seen.add(I[t + 2]);
  }
  const ids = Array.from(seen);
  const centroid: Vec3 = area > 0 ? [c[0] / area, c[1] / area, c[2] / area] : ids.length ? pt(ids[0]) : [0, 0, 0];
  const out: GeoInfo = { kind: "face", name, type: "other", at: v3(centroid), area: r4(area) };
  if (!ids.length) return out;
  const n0 = nm(ids[0]);
  if (ids.every((i) => dot(nm(i), n0) > 1 - 1e-6)) {
    // the middle of its extent in the plane, as the assembly's connector on it is (assembly/connectors/infer.ts)
    out.type = "plane"; out.normal = unitTidy(n0);
    return out;
  }
  // a cylinder: every normal is square to one direction, and each point is one radius from its line
  let axis: Vec3 | null = null;
  for (const i of ids) { const x = cross(n0, nm(i)); if (length(x) > 0.05) { axis = normalize(x); break; } }
  if (axis && ids.every((i) => Math.abs(dot(nm(i), axis as Vec3)) < 1e-4)) {
    const ax = axis;
    const flat = (v: Vec3): Vec3 => sub(v, scale(ax, dot(v, ax)));
    let far = ids[0], best = 0;
    for (const i of ids) { const d = length(sub(nm(i), n0)); if (d > best) { best = d; far = i; } }
    const dn = sub(n0, nm(far)), dp = flat(sub(pt(ids[0]), pt(far)));
    const r = dot(dp, dn) / (dot(dn, dn) || 1);
    const centre = flat(sub(pt(ids[0]), scale(n0, r)));
    let ok = Math.abs(r) > 1e-6, t0 = Infinity, t1 = -Infinity;
    for (const i of ids) {
      const p = pt(i);
      if (length(sub(flat(sub(p, scale(nm(i), r))), centre)) > 2e-3 * Math.max(1, Math.abs(r))) { ok = false; break; }
      const t = dot(p, ax); if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    if (ok) {
      const lead = Math.abs(ax[2]) >= Math.abs(ax[0]) - 1e-9 && Math.abs(ax[2]) >= Math.abs(ax[1]) - 1e-9 ? ax[2] : Math.abs(ax[1]) >= Math.abs(ax[0]) - 1e-9 ? ax[1] : ax[0];
      out.type = "cylinder"; out.axis = unitTidy(lead < 0 ? scale(ax, -1) : ax); out.radius = r4(Math.abs(r)); out.hole = r < 0;
      const mid = (t0 + t1) / 2;
      out.at = v3([centre[0] + ax[0] * mid, centre[1] + ax[1] * mid, centre[2] + ax[2] * mid]);
      out.length = r4(t1 - t0);
    }
  }
  return out;
}

function edgeInfo(m: BodyMesh, ei: number): GeoInfo {
  const name = m.edges.names[ei], E = m.edges.positions, start = m.edges.start[ei], count = m.edges.count[ei];
  const pts: Vec3[] = [];
  let len = 0;
  for (let i = start; i + 1 < start + count; i += 2) {
    const a: Vec3 = [E[i * 3], E[i * 3 + 1], E[i * 3 + 2]], b: Vec3 = [E[i * 3 + 3], E[i * 3 + 4], E[i * 3 + 5]];
    len += length(sub(b, a));
    if (!pts.length) pts.push(a);
    pts.push(b);
  }
  const out: GeoInfo = { kind: "edge", name, type: "other", at: [0, 0, 0], length: r4(len) };
  if (!pts.length) return out;
  const first = pts[0], last = pts[pts.length - 1];
  let far = pts[0], reach = 0;
  for (const p of pts) { const d = length(sub(p, first)); if (d > reach) { reach = d; far = p; } }
  out.at = v3(pts[Math.floor(pts.length / 2)]);
  if (reach < 1e-9) return out;
  const dir = normalize(sub(far, first));
  if (pts.every((p) => length(cross(sub(p, first), dir)) < 1e-5 * Math.max(1, reach))) {
    const lead = Math.abs(dir[2]) >= Math.abs(dir[0]) - 1e-9 && Math.abs(dir[2]) >= Math.abs(dir[1]) - 1e-9 ? dir[2] : Math.abs(dir[1]) >= Math.abs(dir[0]) - 1e-9 ? dir[1] : dir[0];
    out.type = "line"; out.axis = unitTidy(lead < 0 ? scale(dir, -1) : dir);
    out.at = v3([(first[0] + far[0]) / 2, (first[1] + far[1]) / 2, (first[2] + far[2]) / 2]);
    return out;
  }
  if (pts.length >= 3) {
    const a = pts[0], b = pts[Math.floor(pts.length / 3)], c = pts[Math.floor((2 * pts.length) / 3)];
    const ab = sub(b, a), ac = sub(c, a), n = cross(ab, ac), nn = dot(n, n);
    if (nn > 1e-12) {
      const k1 = cross(n, ab), k2 = cross(ac, n), q1 = dot(ac, ac), q2 = dot(ab, ab);
      const centre: Vec3 = [a[0] + (k1[0] * q1 + k2[0] * q2) / (2 * nn), a[1] + (k1[1] * q1 + k2[1] * q2) / (2 * nn), a[2] + (k1[2] * q1 + k2[2] * q2) / (2 * nn)];
      const r = length(sub(a, centre)), ax = normalize(n);
      if (pts.every((p) => Math.abs(length(sub(p, centre)) - r) < 1e-3 * Math.max(1, r) && Math.abs(dot(sub(p, centre), ax)) < 1e-3 * Math.max(1, r))) {
        const lead = Math.abs(ax[2]) >= Math.abs(ax[0]) - 1e-9 && Math.abs(ax[2]) >= Math.abs(ax[1]) - 1e-9 ? ax[2] : Math.abs(ax[1]) >= Math.abs(ax[0]) - 1e-9 ? ax[1] : ax[0];
        out.type = length(sub(first, last)) < 1e-5 * Math.max(1, r) ? "circle" : "arc";
        out.axis = unitTidy(lead < 0 ? scale(ax, -1) : ax); out.radius = r4(r); out.at = v3(centre);
      }
    }
  }
  return out;
}

const key = (x: number, y: number, z: number): string => `${Math.round(x * 2e3)},${Math.round(y * 2e3)},${Math.round(z * 2e3)}`;
const sides = new WeakMap<BodyMesh, number[][]>();

/** For every edge, the faces it lies on: the faces that have every one of its points. */
function facesOfEdges(mesh: BodyMesh): number[][] {
  let out = sides.get(mesh);
  if (out) return out;
  const at = new Map<string, number[]>();
  const P = mesh.positions, I = mesh.indices;
  mesh.faces.names.forEach((_n, fi) => {
    for (let t = mesh.faces.start[fi]; t < mesh.faces.start[fi] + mesh.faces.count[fi]; t++) {
      const k = key(P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]);
      const l = at.get(k);
      if (!l) at.set(k, [fi]); else if (l[l.length - 1] !== fi) l.push(fi);
    }
  });
  const E = mesh.edges.positions;
  out = mesh.edges.names.map((_n, ei) => {
    const start = mesh.edges.start[ei], count = mesh.edges.count[ei];
    let on: number[] | null = null;
    for (let i = start; i < start + count; i++) {
      const l = at.get(key(E[i * 3], E[i * 3 + 1], E[i * 3 + 2])) || [];
      on = on === null ? l.slice() : on.filter((f) => l.includes(f));
      if (!on.length) break;
    }
    return on || [];
  });
  sides.set(mesh, out);
  return out;
}

/** Every face, edge or vertex of a mesh with what it is.  Cached per mesh. */
export function summarise(mesh: BodyMesh, kind: GeoKind): GeoInfo[] {
  let c = cache.get(mesh);
  if (!c) {
    const V = mesh.vertices.positions;
    const of = facesOfEdges(mesh);
    c = {
      face: mesh.faces.names.map((_n, i) => faceInfo(mesh, i)),
      edge: mesh.edges.names.map((_n, i) => { const e = edgeInfo(mesh, i); if (of[i].length === 1) e.seam = true; return e; }),
      vertex: mesh.vertices.names.map((name, i) => ({ kind: "vertex" as const, name, type: "point" as const, at: v3([V[i * 3], V[i * 3 + 1], V[i * 3 + 2]]) })),
    };
    cache.set(mesh, c);
  }
  return c[kind];
}

/** The names of the edges round a face (the edges whose every point is a point of the face), its own seam left out. */
export function edgesOfFace(mesh: BodyMesh, face: string): string[] {
  const fi = mesh.faces.names.indexOf(face);
  if (fi < 0) return [];
  const of = facesOfEdges(mesh);
  return mesh.edges.names.filter((_n, ei) => of[ei].includes(fi) && of[ei].length > 1);
}

/** The vertices at the corners of a face. */
export function verticesOfFace(mesh: BodyMesh, face: string): string[] {
  const fi = mesh.faces.names.indexOf(face);
  if (fi < 0) return [];
  const P = mesh.positions, I = mesh.indices, on = new Set<string>();
  for (let t = mesh.faces.start[fi]; t < mesh.faces.start[fi] + mesh.faces.count[fi]; t++) on.add(key(P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2]));
  const V = mesh.vertices.positions;
  return mesh.vertices.names.filter((_n, i) => on.has(key(V[i * 3], V[i * 3 + 1], V[i * 3 + 2])));
}

// ---------------------------------------------------------------- picking

/** The six sides, by the names of the standard views: top is +Z, front is −Y (what the Front view shows), right is +X. */
export const SIDES: { [name: string]: Vec3 } = { top: [0, 0, 1], bottom: [0, 0, -1], front: [0, -1, 0], back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0] };
const AXES: { [name: string]: Vec3 } = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], "+x": [1, 0, 0], "+y": [0, 1, 0], "+z": [0, 0, 1], "-x": [-1, 0, 0], "-y": [0, -1, 0], "-z": [0, 0, -1] };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
function direction(v: unknown): Vec3 | null {
  if (typeof v === "string") { const k = v.trim().toLowerCase(); return SIDES[k] || AXES[k] || null; }
  return isVec(v) && length(v) > 1e-9 ? normalize(v) : null;
}

export const PICK_HELP = "pick is \"top\", \"bottom\", \"front\", \"back\", \"left\", \"right\" (the outermost flat face on that side: top is +Z, front is -Y, right is +X), \"largest\", or an object of conditions that must all hold: { side, normal: [x,y,z] or \"+z\", type: \"plane\" | \"cylinder\" | \"line\" | \"circle\" | \"arc\", hole: true | false, radius, diameter, length, min_area, parallel_to: \"x\" | \"y\" | \"z\" | [x,y,z], of_face: <a face name or a face pick> (edges and vertices: those round that face), nearest: [x,y,z], all: true (every match instead of the best one) }";

export class PickError extends Error {}

/**
 * The faces, edges or vertices of a mesh a pick describes, best first.  Without `all` in the pick the list has
 * one entry.  Throws a PickError that says what was wrong and what there is to pick from.
 */
export function pickGeometry(mesh: BodyMesh, kind: GeoKind, pick: unknown): GeoInfo[] {
  const list = summarise(mesh, kind);
  const what = kind === "face" ? "face" : kind === "edge" ? "edge" : "vertex";
  const have = (): string => {
    const n: { [t: string]: number } = {};
    for (const g of list) n[g.type + (g.hole ? " (hole)" : "")] = (n[g.type + (g.hole ? " (hole)" : "")] || 0) + 1;
    return Object.keys(n).map((t) => `${n[t]} ${t}`).join(", ") || "none";
  };
  let p: { [k: string]: unknown };
  if (typeof pick === "string") {
    const k = pick.trim().toLowerCase();
    if (k in SIDES) p = { side: k };
    else if (k === "largest" || k === "longest") p = {};
    else if (k === "all") p = { all: true };
    else {
      const named = list.find((g) => g.name === pick);
      if (named) return [named];
      throw new PickError(`"${pick}" is neither a pick nor the name of a ${what} of this body. ${PICK_HELP}.`);
    }
  } else if (pick && typeof pick === "object" && !Array.isArray(pick)) p = pick as { [k: string]: unknown };
  else throw new PickError(`A pick must be a word or an object. ${PICK_HELP}.`);

  const known = ["side", "normal", "type", "hole", "radius", "diameter", "length", "min_area", "parallel_to", "of_face", "nearest", "all"];
  const odd = Object.keys(p).filter((k) => !known.includes(k));
  if (odd.length) throw new PickError(`Unknown pick condition ${odd.map((k) => `"${k}"`).join(", ")}. ${PICK_HELP}.`);

  // a seam is not an edge of the part as a person means one: it is found only by its name
  let out = kind === "edge" ? list.filter((g) => !g.seam) : list.slice();
  let sideDir: Vec3 | null = null;
  if (p.side !== undefined) {
    sideDir = typeof p.side === "string" ? SIDES[p.side.trim().toLowerCase()] || null : null;
    if (!sideDir) throw new PickError(`side is one of ${Object.keys(SIDES).join(", ")}.`);
    if (kind === "face") out = out.filter((g) => g.type === "plane" && dot(g.normal as Vec3, sideDir as Vec3) > 0.9998);
  }
  if (p.normal !== undefined) {
    const d = direction(p.normal);
    if (!d) throw new PickError("normal is a direction: [x, y, z] or \"+z\", \"-x\", …");
    if (kind !== "face") throw new PickError("normal applies to faces. For an edge use parallel_to.");
    out = out.filter((g) => g.type === "plane" && dot(g.normal as Vec3, d) > 0.9998);
  }
  if (p.type !== undefined) {
    const t = String(p.type).toLowerCase();
    const ok = kind === "face" ? ["plane", "cylinder", "other"] : kind === "edge" ? ["line", "circle", "arc", "other"] : ["point"];
    if (!ok.includes(t)) throw new PickError(`${kind === "edge" ? "An" : "A"} ${what}'s type is one of ${ok.join(", ")}.`);
    out = out.filter((g) => g.type === t);
  }
  if (p.hole !== undefined) out = out.filter((g) => g.type === "cylinder" && !!g.hole === !!p.hole);
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-3, 1e-3 * Math.abs(b));
  if (p.radius !== undefined || p.diameter !== undefined) {
    const r = isNum(p.radius) ? p.radius : isNum(p.diameter) ? p.diameter / 2 : NaN;
    if (!(r > 0)) throw new PickError("radius and diameter are numbers above zero, in millimetres.");
    out = out.filter((g) => g.radius !== undefined && near(g.radius, r));
  }
  if (p.length !== undefined) { if (!isNum(p.length)) throw new PickError("length is a number, in millimetres."); out = out.filter((g) => g.length !== undefined && near(g.length, p.length as number)); }
  if (p.min_area !== undefined) { if (!isNum(p.min_area)) throw new PickError("min_area is a number, in mm2."); out = out.filter((g) => (g.area || 0) >= (p.min_area as number)); }
  if (p.parallel_to !== undefined) {
    const d = direction(p.parallel_to);
    if (!d) throw new PickError("parallel_to is a direction: \"x\", \"y\", \"z\" or [x, y, z].");
    // a straight edge along it, a cylinder whose axis is along it, a flat face that contains it
    out = out.filter((g) => (kind === "edge" ? g.type === "line" && Math.abs(dot(g.axis as Vec3, d)) > 0.9998 : g.axis ? Math.abs(dot(g.axis, d)) > 0.9998 : g.normal ? Math.abs(dot(g.normal, d)) < 0.02 : false));
  }
  if (p.of_face !== undefined) {
    if (kind === "face") throw new PickError("of_face applies to edges and vertices.");
    const faces = pickGeometry(mesh, "face", p.of_face);
    const names = new Set<string>();
    for (const f of faces) for (const n of kind === "edge" ? edgesOfFace(mesh, f.name) : verticesOfFace(mesh, f.name)) names.add(n);
    out = out.filter((g) => names.has(g.name));
  }
  const size = (g: GeoInfo): number => (kind === "face" ? g.area || 0 : g.length || 0);
  if (p.nearest !== undefined) {
    if (!isVec(p.nearest)) throw new PickError("nearest is a point: [x, y, z] in millimetres.");
    const q = p.nearest;
    const dist = (g: GeoInfo): number => {
      // from the point to the face's plane or the cylinder's axis when it has one, else to its middle
      if (g.type === "plane" && g.normal) { const off = Math.abs(dot(sub(q, g.at), g.normal)); return Math.hypot(off, Math.max(0, length(sub(q, g.at)) - Math.sqrt(g.area || 0))); }
      return length(sub(q, g.at));
    };
    out.sort((a, b) => dist(a) - dist(b) || size(b) - size(a));
  } else if (sideDir) {
    const d = sideDir;
    out.sort((a, b) => dot(b.at, d) - dot(a.at, d) || size(b) - size(a));
    // "the top face" is the outermost: with several at the same height, all of them only when asked
    if (kind !== "face" && out.length) { const top = dot(out[0].at, d); const lvl = out.filter((g) => Math.abs(dot(g.at, d) - top) < 1e-6); if (p.all && lvl.length) out = lvl; }
  } else out.sort((a, b) => size(b) - size(a));

  if (!out.length) throw new PickError(`No ${what} of this body matches ${JSON.stringify(pick)}. It has ${list.length} ${what}${list.length === 1 ? "" : kind === "vertex" ? "" : "s"}${kind === "vertex" ? (list.length === 1 ? "" : "es") : ""}: ${have()}. cad_find_geometry lists them with their positions.`);
  return p.all ? out : [out[0]];
}

/** A summary as the tools print it: only what is known, compact. */
export function infoJson(g: GeoInfo, body?: string): { [k: string]: unknown } {
  const o: { [k: string]: unknown } = { name: g.name, type: g.type + (g.hole ? " (hole)" : g.seam ? " (seam)" : "") };
  if (body !== undefined) o.body = body;
  o.at = g.at;
  if (g.normal) o.normal = g.normal;
  if (g.axis) o.axis = g.axis;
  if (g.radius !== undefined) o.radius = g.radius;
  if (g.area !== undefined) o.area = g.area;
  if (g.length !== undefined) o.length = g.length;
  return o;
}
