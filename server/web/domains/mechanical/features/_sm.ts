// _sm.ts — what the sheet metal features (sm-*.ts) share: turning what was picked in the model into walls,
// edges and bends of a sheet metal model (kernel/ops/sheetmetal.ts), and the dialog fields they have in common.
import type { ParamField } from "../core/feature";
import { toWorld, type GeomRef, type Vec2, type Vec3 } from "../core/geometry";
import { corner as cornerOp } from "../kernel/ops/sheetmetal-ops";
import type { EvalContext } from "../kernel/types";
import { bendOfFace, locateEdge, locateFace, locatePoint, minv, modelById, modelOfBody, mpt, placements, sideAt, storeOf, wallOf, type SMBend, type SMModel, type SMWall, type Side } from "../kernel/ops/sheetmetal";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const SM_SECTION = "sheetmetal" as const;

/** A pick on a wall, kept as a point so it can be found again after the wall has been cut. */
export interface WallPick { wall: string; top: boolean; at: Vec2; along?: Vec2; edge: boolean }

/** The model the picked geometry belongs to (one model for all of it), and each pick as a place on a wall. */
export function wallPicks(ctx: EvalContext, refs: readonly GeomRef[], what: string): { model: SMModel; picks: WallPick[] } {
  if (!refs || !refs.length) throw ctx.fail(what);
  let model: SMModel | null = null;
  const picks: WallPick[] = [];
  for (const ref of refs) {
    const r = ctx.resolve(ref);
    const m: SMModel = model || modelOfBody(ctx, r.body.id);
    if (!Object.values(m.bodies).includes(r.body.id)) throw ctx.fail("Pick geometry of one sheet metal part at a time.");
    model = m;
    const hit = r.kind === "edge" ? locateEdge(ctx.k, m, r.shape) || vertical(ctx, m, r.shape) : r.kind === "face" ? locateFace(ctx.k, m, r.shape) : locatePoint(ctx.k, m, ctx.k.vertexPoint(r.shape));
    if (!hit) throw ctx.fail(r.kind === "edge" ? "Pick a straight edge of a wall (not an edge of a bend)." : r.kind === "face" ? "Pick a flat face of a wall." : "Pick a corner of a wall.");
    const s = hit.side;
    picks.push({ wall: hit.wall.id, top: hit.top, at: hit.at, along: s ? unit(s) : undefined, edge: !!s });
  }
  return { model: model!, picks };
}
/** An edge through the thickness at a wall's corner counts as that corner. */
function vertical(ctx: EvalContext, m: SMModel, edge: any) {
  const vs = ctx.k.sub(edge, "vertex");
  return vs.length ? locatePoint(ctx.k, m, ctx.k.vertexPoint(vs[0])) : null;
}
const unit = (s: Side): Vec2 => { const l = Math.hypot(s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]) || 1; return [(s.p1[0] - s.p0[0]) / l, (s.p1[1] - s.p0[1]) / l]; };

/** The edge of a wall a pick was on, as the wall is now. */
export function sideOfPick(ctx: EvalContext, m: SMModel, p: WallPick): Side {
  const s = p.edge ? sideAt(ctx.k, wallOf(m, p.wall), p.at, p.along) : null;
  if (!s) throw ctx.fail("An edge that was picked is no longer an edge of its wall: an earlier pick of this feature cut it away.");
  return s;
}

/** The bends the picked faces belong to, and their model. */
export function bendPicks(ctx: EvalContext, refs: readonly GeomRef[]): { model: SMModel; bends: SMBend[] } {
  if (!refs || !refs.length) throw ctx.fail("Pick a face of a bend.");
  let model: SMModel | null = null;
  const bends: SMBend[] = [];
  for (const ref of refs) {
    const r = ctx.resolve(ref);
    const m: SMModel = model || modelOfBody(ctx, r.body.id);
    model = m;
    const b = bendOfFace(m, r.name);
    if (!b) throw ctx.fail("Pick the curved face of a bend.");
    if (!bends.includes(b)) bends.push(b);
  }
  return { model: model!, bends };
}

/** Every sheet metal model that can still be changed, with what other features did to its bodies read in. */
export function openModels(ctx: EvalContext): SMModel[] {
  return Object.values(storeOf(ctx)).filter((m) => !m.finished).map((m) => modelById(ctx, m.id));
}

/** A point of the model in a wall's own coordinates. */
export function inWall(m: SMModel, wall: SMWall, p: Vec3): Vec3 { return mpt(minv(placements(m).mat.get(wall.id)!), p); }

/** The radius and K-factor of a feature that may use the model's or its own. */
export const bendFields: ParamField[] = [
  { key: "useModelRadius", label: "Use model bend radius", kind: "boolean" },
  { key: "radius", label: "Bend radius", kind: "number", unit: "mm", min: 0.01, step: 0.5, visible: (p) => p.useModelRadius === false },
  { key: "useModelK", label: "Use model K-factor", kind: "boolean" },
  { key: "kFactor", label: "K-factor", kind: "number", unit: "none", min: 0, max: 1, step: 0.01, visible: (p) => p.useModelK === false },
];
export const radiusOf = (m: SMModel, p: { [k: string]: any }): number => (p.useModelRadius === false && p.radius > 0 ? p.radius : m.radius);
export const kOf = (m: SMModel, p: { [k: string]: any }): number => (p.useModelK === false && p.kFactor >= 0 ? Math.min(1, p.kFactor) : m.k);

/** The sketch points and model vertices a field picked, as points of the model. */
export function pickedPoints(ctx: EvalContext, targets: readonly any[]): Vec3[] {
  const out: Vec3[] = [];
  for (const t of targets || []) {
    if (t.kind === "sketch") {
      const s = ctx.sketch(t.feature), e = s.data.entities[t.entity] as any;
      if (!e) throw ctx.fail("A sketch point this feature uses is gone. Pick it again.");
      const ids = e.type === "point" ? [t.entity] : e.type === "line" ? [e.a, e.b] : e.center ? [e.center] : [];
      for (const id of ids) { const q = s.data.entities[id] as any; if (q && q.type === "point") out.push(toWorld(s.frame, [q.x, q.y])); }
    } else if (t.kind === "vertex") out.push(ctx.k.vertexPoint(ctx.resolve(t).shape));
    else throw ctx.fail("Pick sketch points or vertices.");
  }
  return out;
}

/** The sketch lines a field picked, each as its two end points in the model. */
export function pickedLines(ctx: EvalContext, targets: readonly any[]): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (const t of targets || []) {
    if (t.kind === "sketch") {
      const s = ctx.sketch(t.feature), e = s.data.entities[t.entity] as any;
      if (!e || e.type !== "line") throw ctx.fail("Pick straight sketch lines.");
      const a = s.data.entities[e.a] as any, b = s.data.entities[e.b] as any;
      out.push([toWorld(s.frame, [a.x, a.y]), toWorld(s.frame, [b.x, b.y])]);
    } else if (t.kind === "edge") {
      const vs = ctx.k.sub(ctx.resolve(t).shape, "vertex");
      if (vs.length !== 2) throw ctx.fail("Pick straight lines or edges.");
      out.push([ctx.k.vertexPoint(vs[0]), ctx.k.vertexPoint(vs[1])]);
    } else throw ctx.fail("Pick sketch lines.");
  }
  return out;
}

/** The open sheet metal model and wall a point of the model lies on (a top or bottom face). */
export function wallAtPoint(ctx: EvalContext, p: Vec3, models?: SMModel[]): { model: SMModel; wall: SMWall; top: boolean; at: Vec2 } {
  for (const m of models || openModels(ctx)) {
    const hit = locatePoint(ctx.k, m, p);
    if (hit) return { model: m, wall: hit.wall, top: hit.top, at: hit.at };
  }
  throw ctx.fail("That point is not on a flat face of a sheet metal wall.");
}

/**
 * Relieve the corners of a wall where two of its bends now end at one corner, in the model's default way: what
 * Flange and Hem do after adding bends, as Onshape treats corners where flanges meet.
 */
export function autoCorners(ctx: EvalContext, m0: SMModel, walls: readonly string[]): SMModel {
  let m = m0;
  const done = new Set(m.cornersDone || []);
  for (const wall of walls) {
    const mine = m.bends.filter((b) => b.a.wall === wall && b.b);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
      const A = mine[i].a, B = mine[j].a;
      const dA = unit(A), dB = unit(B), det = dA[0] * dB[1] - dA[1] * dB[0];
      if (Math.abs(det) < 1e-3) continue;
      const tt = ((B.p0[0] - A.p0[0]) * dB[1] - (B.p0[1] - A.p0[1]) * dB[0]) / det;
      const c: Vec2 = [A.p0[0] + dA[0] * tt, A.p0[1] + dA[1] * tt];
      const reach = 3 * (Math.max(mine[i].radius, mine[j].radius) + m.thickness);
      const endGap = (s: Side) => Math.min(Math.hypot(s.p0[0] - c[0], s.p0[1] - c[1]), Math.hypot(s.p1[0] - c[0], s.p1[1] - c[1]));
      if (endGap(A) > reach || endGap(B) > reach) continue;
      const key = `${wall}@${Math.round(c[0] * 100)},${Math.round(c[1] * 100)}`;
      if (done.has(key)) continue;
      try { m = cornerOp(ctx.k, m, wall, c, m.corner.type, m.corner.size, ctx.own); } catch (e) { if (!(e instanceof Error) || e.name !== "FeatureError") throw e; ctx.warn(`A corner was left as it is: ${e.message}`); }
      done.add(key);
    }
  }
  return { ...m, cornersDone: Array.from(done) };
}
