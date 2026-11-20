// sheetmetal-ops.ts — what the sheet metal features do to a sheet metal model (kernel/ops/sheetmetal.ts): add a
// wall, cut or grow one, hang a flange on an edge, join two walls with a bend, bend a wall along a line, relieve
// a corner or a bend's end, break a corner, turn a bend into a rip; and lay the model flat.  Every function
// takes a model and returns a new one; none touches the bodies (sheetmetal.ts `commit` builds them).
import type { Vec2, Vec3 } from "../../core/geometry";
import type { Kernel, Keep } from "../occ";
import { FeatureError, type Shape } from "../types";
import { drawingBounds, faceOutline, type Curve2D } from "./exchange-2d";
import {
  allowance, area, bool, circleFace, inside, link, minv, mmul, mpt, mtrans, mvec, oneFace, placements, poly2, polyFace, rad, setback, sideFrame, straightEdges, wallOf, withWall, xform,
  type Mat, type SMBend, type SMModel, type SMWall, type Side,
} from "./sheetmetal";

const BIG = 1e4, EPS = 1e-3;
const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add2 = (a: Vec2, b: Vec2, s = 1): Vec2 => [a[0] + b[0] * s, a[1] + b[1] * s];
const len2 = (a: Vec2): number => Math.hypot(a[0], a[1]);
const unit2 = (a: Vec2): Vec2 => { const l = len2(a) || 1; return [a[0] / l, a[1] / l]; };
const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dirOf = (s: Side): Vec2 => unit2(sub2(s.p1, s.p0));
/** into the wall: the left of the side's direction */
const inOf = (s: Side): Vec2 => { const d = dirOf(s); return [-d[1], d[0]]; };
const lenOf = (s: Side): number => len2(sub2(s.p1, s.p0));

export function newModel(id: string, name: string, o: { thickness: number; radius: number; k: number; gap: number; relief: SMModel["relief"]; corner: SMModel["corner"] }): SMModel {
  return { id, name, ...o, walls: [], bends: [], forms: [], roots: {}, bodies: {}, built: {}, finished: false, seq: 0 };
}
/** A new wall, on its own (a root at `place`) unless `place` is null (a bend will place it). */
export function addWall(k: Kernel, m: SMModel, face0: Shape, featureId: string, place: Mat | null, keep: Keep): { model: SMModel; wall: SMWall } {
  // every wall's face looks up (+z), so faces of different walls fuse into one in the flat pattern
  const fr = k.faceFrame(face0 as never);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const face: Shape = fr && fr.normal[2] < 0 ? keep((k.oc as any).TopoDS.Face(keep(face0.Reversed()))) : face0;
  const wall = { id: `${featureId}.w${m.seq + 1}`, face };
  return { model: { ...m, seq: m.seq + 1, walls: [...m.walls, wall], roots: place ? { ...m.roots, [wall.id]: place } : m.roots }, wall };
}

function depths(m: SMModel): Map<string, number> {
  const d = new Map<string, number>();
  const todo = Object.keys(m.roots);
  for (const r of todo) d.set(r, 0);
  while (todo.length) {
    const at = todo.shift()!;
    for (const b of m.bends) {
      if (!b.b) continue;
      const next = b.a.wall === at ? b.b.wall : b.b.wall === at ? b.a.wall : null;
      if (next && !d.has(next)) { d.set(next, d.get(at)! + 1); todo.push(next); }
    }
  }
  return d;
}

/** The stretch of a segment inside a convex polygon (its edge counts), as parameters along it; null: none. */
function clipSeg(p0: Vec2, p1: Vec2, poly: readonly Vec2[]): [number, number] | null {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  const pts = a < 0 ? poly.slice().reverse() : poly;
  let t0 = 0, t1 = 1;
  const d = sub2(p1, p0);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length], e = unit2(sub2(q, p)), n: Vec2 = [-e[1], e[0]];   // n points inside
    const at = (p0[0] - p[0]) * n[0] + (p0[1] - p[1]) * n[1] + 1e-7, slope = d[0] * n[0] + d[1] * n[1];
    if (Math.abs(slope) < 1e-12) { if (at < 0) return null; continue; }
    const t = -at / slope;
    if (slope > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
  }
  return t1 - t0 > 1e-7 ? [t0, t1] : null;
}

/**
 * Cut a tool out of a wall.  A bend of the wall that loses the material beside part of its line is shortened
 * to what is left, and the wall hanging from it (further from the root) loses what stood on the lost part.
 * `poly` is the tool's outline (convex, or a box around it): what bends are tested against.
 */
export function cutWall(k: Kernel, m: SMModel, wallId: string, tool: Shape, poly: readonly Vec2[] | null, keep: Keep, skip?: string): SMModel {
  const w = wallOf(m, wallId);
  const face = oneFace(k, bool(k, "cut", w.face, tool, keep));
  let out = withWall(m, { id: wallId, face });
  if (!poly) return out;
  const depth = depths(m);
  for (const b0 of m.bends) {
    if (b0.id === skip) continue;
    for (const which of ["a", "b"] as const) {
      const b = out.bends.find((x) => x.id === b0.id);
      const s = b && b[which];
      if (!b || !s || s.wall !== wallId) continue;
      const iv = clipSeg(s.p0, s.p1, poly);
      if (!iv) continue;
      const mid = lerp2(s.p0, s.p1, (iv[0] + iv[1]) / 2);
      if (inside(k, face, add2(mid, inOf(s), EPS))) continue;   // the wall is still there beside it
      const lo = iv[0] >= 1 - iv[1];
      const u0 = lo ? 0 : iv[1], u1 = lo ? iv[0] : 1;
      if (u1 - u0 < 1e-6) throw new FeatureError("That would cut a bend away. Make the cut smaller, or turn the bend into a rip first (Modify joint).");
      const mine: Side = { wall: s.wall, p0: lerp2(s.p0, s.p1, u0), p1: lerp2(s.p0, s.p1, u1) };
      const o = which === "a" ? b.b : b.a;
      const other: Side | null = o ? { wall: o.wall, p0: lerp2(o.p0, o.p1, 1 - u1), p1: lerp2(o.p0, o.p1, 1 - u0) } : null;
      const next: SMBend = which === "a" ? { ...b, a: mine, b: other } : { ...b, a: other!, b: mine };
      out = { ...out, bends: out.bends.map((x) => (x.id === b.id ? next : x)) };
      // the wall on the far side of the bend loses the column that stood on the lost stretch
      if (o && other && (depth.get(o.wall) ?? 0) > (depth.get(wallId) ?? 0)) {
        const n = inOf(o);
        const from = lo ? o.p0 : other.p1, to = lo ? other.p0 : o.p1;
        if (len2(sub2(to, from)) > 1e-6) {
          const box: Vec2[] = [add2(from, n, -EPS), add2(to, n, -EPS), add2(to, n, BIG), add2(from, n, BIG)];
          out = cutWall(k, out, o.wall, poly2(k, box, keep), box, keep, b.id);
        }
      }
    }
  }
  return out;
}
/** Add material to a wall, in its plane. */
export function growWall(k: Kernel, m: SMModel, wallId: string, more: Shape, keep: Keep, what = "The added material must touch the wall."): SMModel {
  const w = wallOf(m, wallId);
  const fused = bool(k, "fuse", w.face, more, keep);
  if (k.sub(fused, "face").length !== 1) throw new FeatureError(what);
  return withWall(m, { id: wallId, face: oneFace(k, fused) });
}

const boxAlong = (s: Side, from: number, to: number, depth: number, out = 0): Vec2[] => {
  const d = dirOf(s), n = inOf(s), a = add2(s.p0, d, from), b = add2(s.p0, d, to);
  return [add2(a, n, -out), add2(b, n, -out), add2(b, n, depth), add2(a, n, depth)];
};

/** A relief beside one end of a bend's line on wall a: a pocket `width` wide reaching `depth` past the line. */
export function reliefCut(k: Kernel, m: SMModel, bend: SMBend, end: 0 | 1, type: "rectangle" | "obround" | "tear", width: number, depth: number, keep: Keep): SMModel {
  if (type === "tear" || !(width > 0)) return m;
  const s = bend.a, L = lenOf(s), reach = 2 * (bend.radius + m.thickness) + 1;
  const from = end ? L : -width, to = end ? L + width : 0;
  const round = type === "obround" && depth > width / 2;
  const box = boxAlong(s, from, to, round ? depth - width / 2 : depth, reach);
  let out = cutWall(k, m, s.wall, poly2(k, box, keep), box, keep, bend.id);
  if (round) {
    const c = add2(add2(s.p0, dirOf(s), (from + to) / 2), inOf(s), depth - width / 2), r = width / 2;
    out = cutWall(k, out, s.wall, circleFace(k, [c[0], c[1], 0], [0, 0, 1], r, keep), [[c[0] - r, c[1] - r], [c[0] + r, c[1] - r], [c[0] + r, c[1] + r], [c[0] - r, c[1] + r]], keep, bend.id);
  }
  return out;
}

export interface FlangeOptions {
  /** degrees, signed: positive towards the wall's top */
  angle: number; radius: number; k: number;
  alignment: "outer" | "inner" | "middle" | "none";
  /** from the outside corner (where the outer faces would meet) to the flange's end; `flat` gives the wall's own length instead */
  length: number; flat?: boolean;
  /** kept back from each end of the edge */
  start: number; end: number;
  /** no wall after the bend (a rolled hem) */
  bendOnly?: boolean;
}
/** Hang a bend and a new wall on a wall's edge. */
export function flange(k: Kernel, m0: SMModel, side: Side, o: FlangeOptions, featureId: string, keep: Keep): SMModel {
  const t = m0.thickness, L = lenOf(side), abs = Math.abs(o.angle);
  const sd = dirOf(side);
  if (m0.bends.some((b) => [b.a, b.b].some((s) => { if (!s || s.wall !== side.wall) return false; const e = dirOf(s); return Math.abs(e[0] * sd[1] - e[1] * sd[0]) < 1e-6 && !!clipSeg(s.p0, s.p1, boxAlong(side, o.start, L - o.end, 1e-3, 1e-3)); })))
    throw new FeatureError("That edge already has a bend.");
  if (!(abs > 0.5) || abs > 270) throw new FeatureError("The bend angle must be between 0.5° and 270°.");
  if (!(o.radius >= 0.01)) throw new FeatureError("The bend radius must be at least 0.01 mm.");
  if (o.start < 0 || o.end < 0 || L - o.start - o.end < 0.05) throw new FeatureError("The offsets leave no edge to flange.");
  const outer = abs > 90 ? o.radius + t : setback(abs, o.radius, t), inner = abs > 90 ? o.radius : setback(abs, o.radius, t, false);
  const back = o.alignment === "none" ? 0 : o.alignment === "outer" ? outer : o.alignment === "inner" ? inner : (outer + inner) / 2;
  const d = dirOf(side), n = inOf(side);
  let m = m0;
  const box = boxAlong(side, o.start, L - o.end, back);
  if (back > 1e-9) m = cutWall(k, m, side.wall, poly2(k, box, keep), box, keep);
  const a: Side = { wall: side.wall, p0: add2(add2(side.p0, d, o.start), n, back), p1: add2(add2(side.p1, d, -o.end), n, back) };
  const Lb = lenOf(a);
  const bend: SMBend = { id: `${featureId}.b${m.seq + 1}`, a, b: null, angle: o.angle, radius: o.radius, k: o.k };
  m = { ...m, seq: m.seq + 1 };
  if (!o.bendOnly) {
    const flat = o.flat ? o.length : o.length - outer;
    if (!(flat > 0.01)) throw new FeatureError(`The flange is too short for its bend: make it longer than ${(outer + 0.01).toFixed(2)} mm.`);
    const made = addWall(k, m, poly2(k, [[0, 0], [Lb, 0], [Lb, flat], [0, flat]], keep), featureId, null, keep);
    m = made.model;
    bend.b = { wall: made.wall.id, p0: [0, 0], p1: [Lb, 0] };
  }
  m = { ...m, bends: [...m.bends, bend] };
  // an edge flanged for part of its length is relieved beside the bend, so the sheet can turn there
  if (o.start > 1e-6) m = reliefCut(k, m, bend, 0, m.relief.type, Math.min(m.relief.width, o.start), m.relief.depth, keep);
  if (o.end > 1e-6) m = reliefCut(k, m, m.bends.find((x) => x.id === bend.id)!, 1, m.relief.type, Math.min(m.relief.width, o.end), m.relief.depth, keep);
  return m;
}

/** How two walls' edges meet in the model: the stretch they share, as a side of each, and the angle between the walls. */
function meet(k: Kernel, m: SMModel, sa: Side, sb: Side): { a: Side; b: Side; angle: number; up: boolean; WA: Mat; WB: Mat } {
  const { mat } = placements(m);
  const WA = mat.get(sa.wall)!, WB = mat.get(sb.wall)!;
  const w = (W: Mat, p: Vec2): Vec3 => mpt(W, [p[0], p[1], 0]);
  const A0 = w(WA, sa.p0), A1 = w(WA, sa.p1), B0 = w(WB, sb.p0), B1 = w(WB, sb.p1);
  const dA: Vec3 = [A1[0] - A0[0], A1[1] - A0[1], A1[2] - A0[2]], L = Math.hypot(...dA) || 1;
  const along = (p: Vec3): number => ((p[0] - A0[0]) * dA[0] + (p[1] - A0[1]) * dA[1] + (p[2] - A0[2]) * dA[2]) / (L * L);
  const off = (p: Vec3): number => { const t = along(p); return Math.hypot(p[0] - A0[0] - dA[0] * t, p[1] - A0[1] - dA[1] * t, p[2] - A0[2] - dA[2] * t); };
  if (off(B0) > 1e-3 || off(B1) > 1e-3) throw new FeatureError("The two edges must lie on one line: pick edges of two walls that meet.");
  if (along(B0) < along(B1)) throw new FeatureError("The two walls lie on the same side of that edge.");
  const t0 = Math.max(0, along(B1)), t1 = Math.min(1, along(B0));
  if ((t1 - t0) * L < 0.05) throw new FeatureError("The two edges do not run beside each other.");
  const at = (t: number): Vec3 => [A0[0] + dA[0] * t, A0[1] + dA[1] * t, A0[2] + dA[2] * t];
  const loc = (W: Mat, p: Vec3): Vec2 => { const q = mpt(minv(W), p); return [q[0], q[1]]; };
  const a: Side = { wall: sa.wall, p0: loc(WA, at(t0)), p1: loc(WA, at(t1)) }, b: Side = { wall: sb.wall, p0: loc(WB, at(t1)), p1: loc(WB, at(t0)) };
  const out = (W: Mat, s: Side): Vec3 => { const n = inOf(s); return mvec(W, [-n[0], -n[1], 0]); };
  const oA = out(WA, a), oB = out(WB, b), zA = mvec(WA, [0, 0, 1]);
  const cos = Math.max(-1, Math.min(1, -(oA[0] * oB[0] + oA[1] * oB[1] + oA[2] * oB[2])));
  const angle = (Math.acos(cos) * 180) / Math.PI;
  const up = -(oB[0] * zA[0] + oB[1] * zA[1] + oB[2] * zA[2]) > 0;
  return { a, b, angle, up, WA, WB };
}
/** Do two edges of two walls run beside each other in the model, the walls on different sides? */
export function touching(k: Kernel, m: SMModel, sa: Side, sb: Side): boolean {
  try { meet(k, m, sa, sb); return true; } catch (e) { if (e instanceof FeatureError) return false; throw e; }
}
const shifted = (s: Side, by: number): Side => { const n = inOf(s); return { wall: s.wall, p0: add2(s.p0, n, by), p1: add2(s.p1, n, by) }; };
const rootOf = (m: SMModel, wall: string): string | undefined => placements(m).root.get(wall);

/** Join two walls that meet along an edge with a bend: both are cut back to where the bend starts. */
export function joinBend(k: Kernel, m0: SMModel, sa: Side, sb: Side, radius: number, kf: number, featureId: string, keep: Keep): SMModel {
  const ra = rootOf(m0, sa.wall), rb = rootOf(m0, sb.wall);
  if (ra === rb) throw new FeatureError("Those walls are already joined through other bends; a second bend would close a loop that cannot be laid flat.");
  const j = meet(k, m0, sa, sb);
  if (j.angle < 0.5) throw new FeatureError("The two walls are flat to each other: there is nothing to bend.");
  if (j.angle > 179) throw new FeatureError("The two walls are folded onto each other.");
  const s = setback(j.angle, radius, m0.thickness, j.up) * (j.angle > 90 ? Math.tan(rad(j.angle) / 2) / Math.tan(rad(90) / 2) : 1);
  let m = m0;
  const cut = (side: Side) => { const box = boxAlong(side, 0, lenOf(side), s); m = cutWall(k, m, side.wall, poly2(k, box, keep), box, keep); };
  if (s > 1e-9) { cut(j.a); cut(j.b); }
  const bend: SMBend = { id: `${featureId}.b${m.seq + 1}`, a: shifted(j.a, s), b: shifted(j.b, s), angle: j.up ? j.angle : -j.angle, radius, k: kf };
  // the bend must put wall b where it already is
  const want = mmul(j.WA, link(m, bend, false));
  for (const p of [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]] as Vec3[]) {
    const x = mpt(want, p), y = mpt(j.WB, p);
    if (Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) > 1e-3) throw new FeatureError("Those walls cannot be joined by a bend as they stand: their outside faces must meet along the edge, with the thickness on the same side.");
  }
  const roots = { ...m.roots };
  if (rb) delete roots[rb];
  // the piece that was rooted at rb now hangs from wall b: nothing else moves, because the bend reproduces its place
  return { ...m, seq: m.seq + 1, bends: [...m.bends, bend], roots };
}
/** Two walls that meet along an edge without a bend: each is cut back so they do not run into each other. */
export function ripTrim(k: Kernel, m0: SMModel, sa: Side, sb: Side, gap: number, keep: Keep): SMModel {
  const j = meet(k, m0, sa, sb);
  const s = (j.up ? m0.thickness * Math.tan(rad(Math.min(j.angle, 90)) / 2) : 0) + gap / 2;
  let m = m0;
  for (const side of [j.a, j.b]) { if (s > 1e-9) { const box = boxAlong(side, 0, lenOf(side), s); m = cutWall(k, m, side.wall, poly2(k, box, keep), box, keep); } }
  return m;
}

/** Bend a wall along a line that crosses it: the wall becomes two, joined by a bend centred on the line. */
export function bendAlong(k: Kernel, m: SMModel, wallId: string, u: Vec2, v: Vec2, angle: number, radius: number, kf: number, keepLeft: boolean | null, featureId: string, keep: Keep, rip?: number): SMModel {
  const w = wallOf(m, wallId), d = unit2(sub2(v, u)), n: Vec2 = [-d[1], d[0]];
  if (rip === undefined && (!(Math.abs(angle) > 0.5) || Math.abs(angle) > 270)) throw new FeatureError("The bend angle must be between 0.5° and 270°.");
  const half = rip !== undefined ? rip / 2 : (Math.abs(rad(angle)) * (radius + kf * m.thickness)) / 2;
  const sideOf = (sign: 1 | -1): { face: Shape; lo: Vec2; hi: Vec2 } => {
    // keep what lies on the `sign` side of the line moved `half` that way
    const o = add2(u, n, sign * half), a = add2(o, d, -BIG), b = add2(o, d, BIG);
    const cutAway = bool(k, "cut", w.face, poly2(k, [a, b, add2(b, n, -sign * BIG), add2(a, n, -sign * BIG)], keep), keep);
    const faces = k.sub(cutAway, "face");
    if (faces.length !== 1) throw new FeatureError(faces.length ? "The bend line must cross the wall once, from edge to edge." : "The bend line does not cross the wall.");
    let lo = Infinity, hi = -Infinity;
    for (const [p, q] of straightEdges(k, faces[0])) {
      if (Math.abs((p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1]) > 1e-4 || Math.abs((q[0] - o[0]) * n[0] + (q[1] - o[1]) * n[1]) > 1e-4) continue;
      for (const x of [p, q]) { const t = (x[0] - o[0]) * d[0] + (x[1] - o[1]) * d[1]; lo = Math.min(lo, t); hi = Math.max(hi, t); }
    }
    if (!(hi - lo > 0.05)) throw new FeatureError("The bend line does not cross the wall.");
    return { face: faces[0], lo: add2(o, d, lo), hi: add2(o, d, hi) };
  };
  const left = sideOf(1), right = sideOf(-1);
  const along = (p: Vec2): number => p[0] * d[0] + p[1] * d[1];
  const lo = Math.max(along(left.lo), along(right.lo)), hi = Math.min(along(left.hi), along(right.hi));
  if (!(hi - lo > 0.05)) throw new FeatureError("The bend line does not cross the wall.");
  const on = (base: Vec2, t: number): Vec2 => add2(base, d, t - along(base));
  const leftSide = (id: string): Side => ({ wall: id, p0: on(left.lo, lo), p1: on(left.lo, hi) });     // material on its left: runs with d
  const rightSide = (id: string): Side => ({ wall: id, p0: on(right.lo, hi), p1: on(right.lo, lo) });
  const fixedLeft = keepLeft ?? area(k, left.face) >= area(k, right.face);
  const movedId = `${featureId}.w${m.seq + 1}`;
  const fixed = fixedLeft ? left : right, moved = fixedLeft ? right : left;
  const a = fixedLeft ? leftSide(wallId) : rightSide(wallId), b = fixedLeft ? rightSide(movedId) : leftSide(movedId);
  const onMoved = (p: Vec2): boolean => ((p[0] - u[0]) * n[0] + (p[1] - u[1]) * n[1] > 0) !== fixedLeft;
  const mid = (s: Side): Vec2 => add2(lerp2(s.p0, s.p1, 0.5), inOf(s), EPS);
  const move = (s: Side | null): Side | null => (s && s.wall === wallId && onMoved(mid(s)) ? { ...s, wall: movedId } : s);
  const bend: SMBend = { id: `${featureId}.b${m.seq + 2}`, a, b, angle, radius, k: kf };
  const out: SMModel = {
    ...m, seq: m.seq + 2,
    walls: [...m.walls.map((x) => (x.id === wallId ? { id: wallId, face: fixed.face } : x)), { id: movedId, face: moved.face }],
    bends: [...m.bends.map((x) => ({ ...x, a: move(x.a)!, b: move(x.b) })), ...(rip === undefined ? [bend] : [])],
    forms: m.forms.map((f) => (f.wall === wallId && onMoved(f.at) ? { ...f, wall: movedId } : f)),
  };
  if (rip === undefined) return out;
  // a rip: both halves stay where the wall was; whichever no longer hangs from a root stands on its own
  const was = placements(m).mat.get(wallId)!, reach = placements(out).root, roots = { ...out.roots };
  for (const id of [wallId, movedId]) if (!reach.has(id)) roots[id] = was;
  return { ...out, roots };
}
/** Cut a wall in two along a line that crosses it, leaving `gap` between the halves. */
export function ripAlong(k: Kernel, m: SMModel, wallId: string, u: Vec2, v: Vec2, gap: number, featureId: string, keep: Keep): SMModel {
  return bendAlong(k, m, wallId, u, v, 0, 0, 0, null, featureId, keep, Math.max(gap, 0.01));
}

/** The bends of a wall that end near a point of it, each with which of its ends that is. */
function bendsNear(m: SMModel, wallId: string, at: Vec2): { bend: SMBend; which: "a" | "b"; end: 0 | 1; gap: number }[] {
  const out: { bend: SMBend; which: "a" | "b"; end: 0 | 1; gap: number }[] = [];
  for (const b of m.bends) for (const which of ["a", "b"] as const) {
    const s = b[which];
    if (!s || s.wall !== wallId) continue;
    const reach = 3 * (b.radius + m.thickness) + 0.01;
    const g0 = len2(sub2(s.p0, at)), g1 = len2(sub2(s.p1, at));
    if (Math.min(g0, g1) < reach) out.push({ bend: b, which, end: g0 <= g1 ? 0 : 1, gap: Math.min(g0, g1) });
  }
  return out.sort((x, y) => x.gap - y.gap);
}

/** Relieve the corner of a wall where two bends end: a square or a round hole there, or the flanges closed up. */
export function corner(k: Kernel, m0: SMModel, wallId: string, at: Vec2, type: "rectangle" | "round" | "closed", size: number, keep: Keep): SMModel {
  const near = bendsNear(m0, wallId, at).slice(0, 2);
  if (!near.length) throw new FeatureError("No bend ends at that corner. Pick the corner of a wall where its flanges meet.");
  let c = at;
  const ln = (x: (typeof near)[0]): { p: Vec2; d: Vec2 } => { const s = x.bend[x.which]!; return { p: s.p0, d: dirOf(s) }; };
  if (near.length === 2) {
    const A = ln(near[0]), B = ln(near[1]), det = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (Math.abs(det) > 1e-6) { const t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / det; c = add2(A.p, A.d, t); }
  }
  if (type !== "closed") {
    if (!(size > 0)) throw new FeatureError("The relief's size must be more than zero.");
    const h = size / 2, box: Vec2[] = [[c[0] - h, c[1] - h], [c[0] + h, c[1] - h], [c[0] + h, c[1] + h], [c[0] - h, c[1] + h]];
    return cutWall(k, m0, wallId, type === "round" ? circleFace(k, [c[0], c[1], 0], [0, 0, 1], h, keep) : poly2(k, box, keep), box, keep);
  }
  if (near.length !== 2 || near.some((x) => x.which !== "a" || !x.bend.b || Math.abs(Math.abs(x.bend.angle) - 90) > 0.5) || Math.sign(near[0].bend.angle) !== Math.sign(near[1].bend.angle))
    throw new FeatureError("A closed corner needs two 90° flanges of this wall that meet at the corner.");
  let m = m0;
  near.forEach((x, i) => {
    const other = near[1 - i].bend, s = x.bend.a, b = x.bend.b!;
    const g = len2(sub2(x.end ? s.p1 : s.p0, c));
    // the first flange runs out to the other's outside face; the second stops at the first's inside face, less the gap
    const reach = i === 0 ? g + other.radius + m.thickness : g + other.radius - m.gap;
    if (!(reach > 1e-6)) return;
    // the end of b's line that lies over this end of a's
    const E = x.end ? b.p0 : b.p1, e = x.end ? unit2(sub2(b.p0, b.p1)) : dirOf(b), n = inOf(b);
    let H = 0;
    for (const [p, q] of straightEdges(k, wallOf(m, b.wall).face)) for (const y of [p, q]) H = Math.max(H, (y[0] - E[0]) * n[0] + (y[1] - E[1]) * n[1]);
    if (!(H > 1e-6)) return;
    m = growWall(k, m, b.wall, poly2(k, [E, add2(E, e, reach), add2(add2(E, e, reach), n, H), add2(E, n, H)], keep), keep);
  });
  return m;
}

/** Break a corner of a wall's outline: round it or bevel it. */
export function cornerBreak(k: Kernel, m: SMModel, wallId: string, at: Vec2, type: "fillet" | "chamfer", size: number, keep: Keep): SMModel {
  if (!(size > 0)) throw new FeatureError("The size must be more than zero.");
  const w = wallOf(m, wallId), arms: { u: Vec2; l: number }[] = [];
  let c: Vec2 | null = null;
  for (const [p, q] of straightEdges(k, w.face)) for (const [x, y] of [[p, q], [q, p]] as [Vec2, Vec2][]) {
    if (len2(sub2(x, at)) > 1e-3) continue;
    c = x; arms.push({ u: unit2(sub2(y, x)), l: len2(sub2(y, x)) });
  }
  if (!c || arms.length !== 2) throw new FeatureError("Pick a corner where two straight edges of a wall meet.");
  const [a, b] = arms, cos = Math.max(-1, Math.min(1, a.u[0] * b.u[0] + a.u[1] * b.u[1])), phi = Math.acos(cos);
  if (phi < 0.02 || phi > Math.PI - 0.02) throw new FeatureError("The two edges are in line: there is no corner to break.");
  const dd = type === "chamfer" ? size : size / Math.tan(phi / 2);
  if (dd > Math.min(a.l, b.l) - 1e-6) throw new FeatureError("The corner break is larger than an edge it runs along. Make it smaller.");
  const bis = unit2([a.u[0] + b.u[0], a.u[1] + b.u[1]]);
  const tri: Vec2[] = [c, add2(c, a.u, dd), add2(c, b.u, dd)];
  let tool = poly2(k, tri, keep);
  if (type === "fillet") { const o = add2(c, bis, size / Math.sin(phi / 2)); tool = bool(k, "cut", tool, circleFace(k, [o[0], o[1], 0], [0, 0, 1], size, keep), keep); }
  return inside(k, w.face, add2(c, bis, EPS)) ? cutWall(k, m, wallId, tool, tri, keep) : growWall(k, m, wallId, tool, keep);
}

/** Change a bend's radius or K-factor (the walls keep their outside corner), or take the bend out and leave a rip. */
export function modifyJoint(k: Kernel, m0: SMModel, bendId: string, o: { type: "bend" | "rip"; radius?: number; k?: number; close?: boolean }, keep: Keep): SMModel {
  const b = m0.bends.find((x) => x.id === bendId);
  if (!b) throw new FeatureError("That bend is gone. Pick it again.");
  const t = m0.thickness, up = b.angle >= 0, abs = Math.abs(b.angle);
  const sb = (r: number): number => (abs > 90 ? r + (up ? t : 0) : setback(abs, r, t, up));
  let m = m0;
  const shift = (s: Side, by: number): Side => {
    if (Math.abs(by) < 1e-9) return s;
    if (by > 0) { const box = boxAlong(s, 0, lenOf(s), by); m = cutWall(k, m, s.wall, poly2(k, box, keep), box, keep, bendId); }
    else m = growWall(k, m, s.wall, poly2(k, boxAlong(s, 0, lenOf(s), 1e-4, -by), keep), keep);
    return shifted(s, by);
  };
  if (o.type === "bend") {
    const radius = o.radius ?? b.radius;
    if (!(radius >= 0.01)) throw new FeatureError("The bend radius must be at least 0.01 mm.");
    const by = sb(radius) - sb(b.radius);
    const a = shift(b.a, by), bb = b.b ? shift(b.b, by) : null;
    return { ...m, bends: m.bends.map((x) => (x.id === bendId ? { ...x, a, b: bb, radius, k: o.k ?? x.k } : x)) };
  }
  if (!b.b) return { ...m, bends: m.bends.filter((x) => x.id !== bendId) };
  // a rip: the bend goes, and whichever side no longer reaches a root stands on its own where it is
  const { mat } = placements(m0);
  if (o.close && abs <= 90.5) {
    const by = sb(b.radius) - (up ? t * Math.tan(rad(abs) / 2) : 0) - m0.gap / 2;
    if (by > 1e-6) { shift(b.a, -by); shift(b.b, -by); }
  }
  m = { ...m, bends: m.bends.filter((x) => x.id !== bendId) };
  const reach = placements(m).root;
  const roots = { ...m.roots };
  for (const wall of [b.a.wall, b.b.wall]) if (!reach.has(wall)) roots[wall] = mat.get(wall)!;
  return { ...m, roots };
}

// ------------------------------------------------------------------ the flat pattern
export interface FlatBend { id: string; a: Vec2; b: Vec2; angle: number; up: boolean; radius: number; k: number; allowance: number; length: number }
export interface FlatPiece {
  root: string; body: string;
  /** the outline and the holes */
  curves: Curve2D[];
  bends: FlatBend[];
  forms: { at: Vec2; type: string; size: number }[];
  /** [xmin, ymin, xmax, ymax] */
  bbox: [number, number, number, number];
  area: number;
}
const XY = { origin: [0, 0, 0] as Vec3, x: [1, 0, 0] as Vec3, y: [0, 1, 0] as Vec3, normal: [0, 0, 1] as Vec3 };

/** Every connected piece of a model laid flat: each bend becomes a strip as long as its allowance. */
export function flatPattern(k: Kernel, m: SMModel, keep: Keep): FlatPiece[] {
  const { mat, root } = placements(m, true);
  const out: FlatPiece[] = [];
  for (const r of Object.keys(m.roots)) {
    const parts: Shape[] = [];
    const add = (s: Shape) => { parts.push(s); };
    const bends: FlatBend[] = [];
    for (const w of m.walls) if (root.get(w.id) === r) add(xform(k, w.face, mat.get(w.id)!, keep));
    for (const b of m.bends) {
      if (root.get(b.a.wall) !== r) continue;
      const F = mmul(mat.get(b.a.wall)!, sideFrame(b.a).m), L = lenOf(b.a), ba = allowance(m, b);
      const P = (x: number, y: number): Vec3 => mpt(F, [x, y, 0]);
      add(polyFace(k, [P(0, 0), P(L, 0), P(L, ba), P(0, ba)], keep));
      const p = P(0, ba / 2), q = P(L, ba / 2);
      bends.push({ id: b.id, a: [p[0], p[1]], b: [q[0], q[1]], angle: Math.abs(b.angle), up: b.angle >= 0, radius: b.radius, k: b.k, allowance: ba, length: L });
    }
    if (!parts.length) continue;
    const acc = parts.reduce((a, s) => bool(k, "fuse", a, s, keep));
    const curves: Curve2D[] = [];
    let total = 0;
    for (const f of k.sub(acc, "face")) { curves.push(...faceOutline(k, f, XY).curves); total += area(k, f); }
    const forms = m.forms.filter((f) => root.get(f.wall) === r).map((f) => { const p = mpt(mat.get(f.wall)!, [f.at[0], f.at[1], 0]); return { at: [p[0], p[1]] as Vec2, type: f.type, size: f.size }; });
    out.push({ root: r, body: m.bodies[r] || "", curves, bends, forms, bbox: drawingBounds({ curves }), area: total });
  }
  return out;
}

/** A flat pattern as DXF (R12): the outline on layer CUT, bend lines on BEND_UP and BEND_DOWN, form centres on FORM. */
export function flatDxf(piece: FlatPiece, title: string, scale = 1, insunits = 4): string {
  const out: string[] = [];
  const f = (x: number): string => { const v = Math.round(x * 1e6) / 1e6; return Object.is(v, -0) ? "0" : String(v); };
  const g = (code: number, value: string | number) => { out.push(String(code), typeof value === "number" ? f(value) : value); };
  const TAU = Math.PI * 2, deg = (a: number) => ((((a % TAU) + TAU) % TAU) * 180) / Math.PI;
  g(999, `Junction flat pattern: ${title.replace(/[\r\n]/g, " ")}`);
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(9, "$INSUNITS"); g(70, insunits);
  g(9, "$EXTMIN"); g(10, piece.bbox[0] * scale); g(20, piece.bbox[1] * scale); g(30, 0);
  g(9, "$EXTMAX"); g(10, piece.bbox[2] * scale); g(20, piece.bbox[3] * scale); g(30, 0);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES"); g(0, "TABLE"); g(2, "LAYER"); g(70, 4);
  for (const [name, colour] of [["CUT", 7], ["BEND_UP", 5], ["BEND_DOWN", 1], ["FORM", 3]] as [string, number][]) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, colour); g(6, "CONTINUOUS"); }
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  const line = (layer: string, a: Vec2, b: Vec2) => { g(0, "LINE"); g(8, layer); g(10, a[0] * scale); g(20, a[1] * scale); g(30, 0); g(11, b[0] * scale); g(21, b[1] * scale); g(31, 0); };
  for (const c of piece.curves) {
    if (c.kind === "line") line("CUT", c.a, c.b);
    else if (c.kind === "circle") { g(0, "CIRCLE"); g(8, "CUT"); g(10, c.c[0] * scale); g(20, c.c[1] * scale); g(30, 0); g(40, c.r * scale); }
    else if (c.kind === "arc") { g(0, "ARC"); g(8, "CUT"); g(10, c.c[0] * scale); g(20, c.c[1] * scale); g(30, 0); g(40, c.r * scale); g(50, deg(c.start)); g(51, deg(c.end)); }
    else for (let i = 1; i < c.points.length; i++) line("CUT", c.points[i - 1], c.points[i]);
  }
  for (const b of piece.bends) line(b.up ? "BEND_UP" : "BEND_DOWN", b.a, b.b);
  for (const x of piece.forms) { g(0, "POINT"); g(8, "FORM"); g(10, x.at[0] * scale); g(20, x.at[1] * scale); g(30, 0); }
  g(0, "ENDSEC"); g(0, "EOF");
  return out.join("\n") + "\n";
}
