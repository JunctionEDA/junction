// _sm.ts — what the sheet metal features (sm-*.ts) share: turning what was picked in the model into walls,
// edges and bends of a sheet metal model (kernel/ops/sheetmetal.ts), and the dialog fields they have in common.
import type { ParamField } from "../core/feature";
import type { GeomRef, Vec2, Vec3 } from "../core/geometry";
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
