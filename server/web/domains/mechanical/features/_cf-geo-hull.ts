// _cf-geo-hull.ts — the convex hull of points in space, for the Convex hull feature.  Pure.
//
// An incremental hull: start from a tetrahedron of four far-apart points, then add the point furthest outside
// each face in turn, replacing the faces it sees by a fan to their horizon.  The result is the hull's facets as
// flat polygons: triangles that lie in one plane are joined, so a box's hull has six faces, not twelve.
import type { Vec3 } from "../core/geometry";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

interface Tri { v: [number, number, number]; n: Vec3; d: number; out: number[]; dead: boolean }

/** Points closer together than `tol` taken as one (the first of them is kept). */
export function distinct(points: readonly Vec3[], tol: number): Vec3[] {
  const seen = new Map<string, Vec3[]>(), out: Vec3[] = [];
  const cell = (p: Vec3) => [Math.floor(p[0] / tol), Math.floor(p[1] / tol), Math.floor(p[2] / tol)];
  for (const p of points) {
    const [cx, cy, cz] = cell(p);
    let dup = false;
    for (let i = -1; i <= 1 && !dup; i++) for (let j = -1; j <= 1 && !dup; j++) for (let k = -1; k <= 1 && !dup; k++) {
      for (const q of seen.get(`${cx + i},${cy + j},${cz + k}`) || []) if (len(sub(p, q)) < tol) { dup = true; break; }
    }
    if (dup) continue;
    const key = `${cx},${cy},${cz}`, g = seen.get(key);
    if (g) g.push(p); else seen.set(key, [p]);
    out.push(p);
  }
  return out;
}

/**
 * The convex hull of points: its facets as polygons of indices into `points`, each counter-clockwise seen from
 * outside.  `eps` is how far a point must be outside a face to count (and how flat "in one plane" is).  Returns
 * null when the points are all in one plane (there is no solid hull).
 */
export function convexHull(points: readonly Vec3[], eps: number): number[][] | null {
  const n = points.length;
  if (n < 4) return null;
  // a first tetrahedron: the two points furthest apart along x, the one furthest from their line, the one
  // furthest from that triangle's plane
  let a = 0, b = 0;
  for (let i = 1; i < n; i++) { if (points[i][0] < points[a][0]) a = i; if (points[i][0] > points[b][0]) b = i; }
  if (a === b) { for (let i = 1; i < n; i++) if (len(sub(points[i], points[a])) > len(sub(points[b], points[a]))) b = i; }
  if (len(sub(points[b], points[a])) < eps) return null;
  const ab = sub(points[b], points[a]);
  let c = -1, best = eps;
  for (let i = 0; i < n; i++) { const d = len(cross(ab, sub(points[i], points[a]))) / len(ab); if (d > best) { best = d; c = i; } }
  if (c < 0) return null;
  const nABC = cross(ab, sub(points[c], points[a])), lABC = len(nABC);
  let d4 = -1; best = eps;
  for (let i = 0; i < n; i++) { const h = Math.abs(dot(nABC, sub(points[i], points[a]))) / lABC; if (h > best) { best = h; d4 = i; } }
  if (d4 < 0) return null;

  const tris: Tri[] = [];
  const make = (i: number, j: number, k: number): Tri => {
    const nn = cross(sub(points[j], points[i]), sub(points[k], points[i])), l = len(nn) || 1, nu: Vec3 = [nn[0] / l, nn[1] / l, nn[2] / l];
    const t: Tri = { v: [i, j, k], n: nu, d: dot(nu, points[i]), out: [], dead: false };
    tris.push(t);
    return t;
  };
  const above = (t: Tri, p: Vec3) => dot(t.n, p) - t.d;
  // orient the tetrahedron outwards
  if (dot(nABC, sub(points[d4], points[a])) > 0) [b, c] = [c, b];
  const first = [make(a, b, c), make(a, d4, b), make(b, d4, c), make(c, d4, a)];
  for (let i = 0; i < n; i++) {
    if (i === a || i === b || i === c || i === d4) continue;
    for (const t of first) if (above(t, points[i]) > eps) { t.out.push(i); break; }
  }
  // each live face's edges, to find neighbours across the horizon
  const edgeKey = (i: number, j: number) => i * n + j;
  const owner = new Map<number, Tri>();
  const link = (t: Tri) => { for (let e = 0; e < 3; e++) owner.set(edgeKey(t.v[e], t.v[(e + 1) % 3]), t); };
  first.forEach(link);
  const stack = first.slice();
  let guard = 0;
  while (stack.length) {
    const t = stack.pop() as Tri;
    if (t.dead || !t.out.length) continue;
    if (++guard > 200000) break;
    // the furthest point outside this face
    let far = t.out[0], fd = -Infinity;
    for (const i of t.out) { const h = above(t, points[i]); if (h > fd) { fd = h; far = i; } }
    const p = points[far];
    // every face that sees it, found by walking from this one
    const seen: Tri[] = [], todo = [t];
    t.dead = true;
    while (todo.length) {
      const x = todo.pop() as Tri;
      seen.push(x);
      for (let e = 0; e < 3; e++) {
        const nb = owner.get(edgeKey(x.v[(e + 1) % 3], x.v[e]));
        if (nb && !nb.dead && above(nb, p) > eps) { nb.dead = true; todo.push(nb); }
      }
    }
    // the horizon: edges of seen faces whose neighbour is not seen
    const orphans: number[] = [];
    for (const x of seen) for (const i of x.out) if (i !== far) orphans.push(i);
    const fresh: Tri[] = [];
    for (const x of seen) for (let e = 0; e < 3; e++) {
      const i = x.v[e], j = x.v[(e + 1) % 3], nb = owner.get(edgeKey(j, i));
      if (nb && !nb.dead) fresh.push(make(i, j, far));
    }
    for (const x of seen) for (let e = 0; e < 3; e++) { const key = edgeKey(x.v[e], x.v[(e + 1) % 3]); if (owner.get(key) === x) owner.delete(key); }
    fresh.forEach(link);
    for (const i of orphans) for (const f of fresh) if (above(f, points[i]) > eps) { f.out.push(i); break; }
    for (const f of fresh) if (f.out.length) stack.push(f);
  }
  const live = tris.filter((t) => !t.dead);
  if (live.length < 4) return null;

  // join the triangles of one plane into a polygon: walk the edges that only one of them has
  const groups: Tri[][] = [];
  const done = new Set<Tri>();
  const tol = Math.max(eps * 4, 1e-9);
  for (const t of live) {
    if (done.has(t)) continue;
    const g: Tri[] = [], todo = [t];
    done.add(t);
    while (todo.length) {
      const x = todo.pop() as Tri;
      g.push(x);
      for (let e = 0; e < 3; e++) {
        const nb = owner.get(edgeKey(x.v[(e + 1) % 3], x.v[e]));
        if (!nb || nb.dead || done.has(nb)) continue;
        // the same plane as the group's first face: all three of its corners lie on it
        if (dot(nb.n, t.n) > 0.999999 && nb.v.every((i) => Math.abs(above(t, points[i])) < tol)) { done.add(nb); todo.push(nb); }
      }
    }
    groups.push(g);
  }
  const out: number[][] = [];
  for (const g of groups) {
    const next = new Map<number, number>(), inner = new Set<number>();
    for (const x of g) for (let e = 0; e < 3; e++) inner.add(edgeKey(x.v[e], x.v[(e + 1) % 3]));
    for (const x of g) for (let e = 0; e < 3; e++) { const i = x.v[e], j = x.v[(e + 1) % 3]; if (!inner.has(edgeKey(j, i))) next.set(i, j); }
    const start = next.keys().next().value as number, loop: number[] = [];
    for (let i = start, k = 0; k <= next.size; k++) { loop.push(i); i = next.get(i) as number; if (i === start || i === undefined) break; }
    if (loop.length !== next.size || loop.length < 3) { for (const x of g) out.push(x.v.slice()); continue; }   // not a simple outline: keep the triangles
    // corners in the middle of a straight side are not corners
    const tidy = loop.filter((i, k) => {
      const p = points[loop[(k + loop.length - 1) % loop.length]], q = points[i], r = points[loop[(k + 1) % loop.length]];
      return len(cross(sub(q, p), sub(r, q))) > 1e-9 * Math.max(1, len(sub(q, p)) * len(sub(r, q)));
    });
    out.push(tidy.length >= 3 ? tidy : loop);
  }
  return out;
}
