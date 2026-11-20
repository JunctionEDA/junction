// _cf-fab.ts — what the fabrication custom features (cf-fab-*.ts) share on the feature side: their two menus,
// the fit fields, picking two boards, and the finger joint both Laser joint and Box joint cut.
import type { ParamField } from "../core/feature";
import { cross, dot, length, type Frame, type GeomRef } from "../core/geometry";
import type { Body, EvalContext, Shape } from "../kernel/types";
import type { NamedResult } from "../kernel/occ";
import { combine, scoped, type Operation, type Tool } from "../kernel/ops/combine";
import { solidCentre } from "../kernel/ops/shapes";
import { bool, box, changeAll, extentIn, fingers, frameAt, fresh, plateOf, type Plate } from "../kernel/ops/cf-fab";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const LASER = { toolbarSection: "library" as const, toolbarMenu: "Laser & CNC", toolbarKeep: 0 };
export const PRINT = { toolbarSection: "library" as const, toolbarMenu: "3D printing", toolbarKeep: 0 };

/** Clearance and kerf: how much looser or tighter than the drawn size a joint is cut. */
export const fitFields = (clearanceHint = "Extra room in the joint, for glue or an easy fit."): ParamField[] => [
  { key: "clearance", label: "Clearance", kind: "number", unit: "mm", step: 0.05, hint: clearanceHint },
  { key: "kerf", label: "Kerf", kind: "number", unit: "mm", min: 0, step: 0.05, hint: "The width the laser or cutter removes. The joint is drawn tighter by this much, so it fits after cutting." },
];
/** What a joint's openings grow by on the whole (a negative number: they shrink). */
export function allowance(ctx: EvalContext, p: { clearance?: number; kerf?: number }): number {
  const c = Number(p.clearance) || 0, kerf = Number(p.kerf) || 0;
  if (kerf < 0) throw ctx.fail("The kerf cannot be less than zero.");
  if (Math.abs(c) > 5 || kerf > 5) throw ctx.fail("The clearance and the kerf must be small (at most 5 mm).");
  return c - kerf;
}

/** New or Add, and the bodies Add may join: the fields of a feature that makes material. */
export const resultFields: ParamField[] = [
  { key: "operation", label: "Result", kind: "enum", options: [{ value: "new", label: "New" }, { value: "add", label: "Add" }] },
  { key: "targets", label: "Bodies to join", kind: "bodies", hint: "Leave empty for every body it touches.", visible: (p) => p.operation === "add" },
];
/** Keep what a feature made as bodies, or join it to the bodies it touches. */
export function finish(ctx: EvalContext, tools: readonly Tool[], p: { operation?: string; targets?: string[] }): void {
  const op: Operation = p.operation === "add" ? "add" : "new";
  combine(ctx, tools, op, op === "add" ? p.targets || [] : []);
}

/** The two bodies a joint is between: the two picked, or the only two there are. */
export function twoBodies(ctx: EvalContext, ids: unknown, what: string): [Body, Body] {
  const list = Array.isArray(ids) ? (ids as string[]) : [];
  const all = ctx.bodies();
  const picked = list.length ? all.filter((b) => list.includes(b.id)).sort((a, b) => list.indexOf(a.id) - list.indexOf(b.id)) : all.slice();
  if (picked.length !== 2) throw ctx.fail(list.length ? `Pick exactly two ${what}.` : `Pick the two ${what} to join.`);
  return [picked[0], picked[1]];
}

/** The face a field holds and the body it is on. */
export function pickedFace(ctx: EvalContext, ref: GeomRef | GeomRef[] | null | undefined, what: string): { body: Body; shape: Shape; name: string } {
  const one = Array.isArray(ref) ? ref[0] : ref;
  if (!one) throw ctx.fail(`Pick ${what}.`);
  const r = ctx.resolve(one);
  if (r.kind !== "face") throw ctx.fail(`Pick ${what}.`);
  return { body: r.body, shape: r.shape, name: r.name };
}

/** The bodies a joint may cut into besides the one it starts from. */
export function others(ctx: EvalContext, owner: Body, targets: unknown): Body[] {
  const list = Array.isArray(targets) ? (targets as string[]) : [];
  return (list.length ? scoped(ctx, list) : ctx.bodies().slice()).filter((b) => b.id !== owner.id);
}

export interface Overlap {
  /** x along the joint, normal across the first plate, y across the second */
  frame: Frame;
  ext: [[number, number], [number, number], [number, number]];
  a: Plate; b: Plate;
  /** the overlap itself, when the plates do not meet square */
  common: NamedResult | null;
}

/** Where two plates run through each other: the bar a joint is cut in.  null when they do not overlap. */
export function overlapOf(ctx: EvalContext, a: Body, b: Body): Overlap | null {
  const k = ctx.k;
  const c = bool(ctx, "common", a, b);
  if (!(k.volume(c.shape) > 1e-7)) return null;
  const pa = plateOf(ctx, a), pb = plateOf(ctx, b);
  const axis = cross(pa.frame.normal, pb.frame.normal);
  if (length(axis) < 1e-3) throw ctx.fail(`${a.name} and ${b.name} lie flat on each other: a joint needs plates that meet at an angle.`);
  const frame = frameAt(solidCentre(k, c.shape), axis, pa.frame.normal);
  const ext = extentIn(ctx, c.shape, frame);
  const square = Math.abs(dot(pa.frame.normal, pb.frame.normal)) < 1e-6;
  return { frame, ext, a: pa, b: pb, common: square ? null : c };
}

/**
 * Cut interlocking fingers where two plates overlap: the overlap is divided along its length, and each plate
 * loses every other piece.  `allow` widens what is cut away (clearance less kerf).  False when the plates do
 * not overlap.  Faces: `<id>:j(<a>,<b>):<n>:<side>`.
 */
export function fingerJoint(ctx: EvalContext, a0: Body, b0: Body, o: { width: number; count?: number; allow: number; ends?: "a" | "b" | "auto" }): boolean {
  const a = fresh(ctx, a0), b = fresh(ctx, b0);
  const ov = overlapOf(ctx, a, b);
  if (!ov) return false;
  const { frame, ext } = ov;
  const len = ext[0][1] - ext[0][0];
  const cuts = fingers(len, o.width, o.count);
  const n = cuts.length - 1;
  if (len / n <= Math.abs(o.allow) + 1e-6 || len / n < 0.2) throw ctx.fail("The fingers are too narrow for this joint. Use fewer or wider fingers.");
  // the ends go to the plate that carries on past the joint (a slot must stay closed), else to the first
  let ends = o.ends || "auto";
  if (ends === "auto") {
    const past = (body: Body) => { const e = extentIn(ctx, body.shape, frame)[0]; return e[0] < ext[0][0] - 1e-6 || e[1] > ext[0][1] + 1e-6; };
    ends = past(b) && !past(a) ? "b" : "a";
  }
  const key = `${ctx.feature.id}:j(${a.id},${b.id})`;
  const slab = (i: number): NamedResult => {
    const s0 = i === 0 ? ext[0][0] - 1 : ext[0][0] + cuts[i] - o.allow / 2, s1 = i === n - 1 ? ext[0][1] + 1 : ext[0][0] + cuts[i + 1] + o.allow / 2;
    const bx = box(ctx, frame, [s0, ext[1][0], ext[2][0]], [s1, ext[1][1], ext[2][1]], `${key}:${i + 1}`);
    return ov.common ? bool(ctx, "common", bx, ov.common) : bx;
  };
  const fromA: NamedResult[] = [], fromB: NamedResult[] = [];
  for (let i = 0; i < n; i++) ((i % 2 === 0) === (ends === "a") ? fromB : fromA).push(slab(i));
  changeAll(ctx, a, "cut", fromA);
  changeAll(ctx, b, "cut", fromB);
  return true;
}
