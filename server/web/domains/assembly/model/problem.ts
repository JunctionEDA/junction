// problem.ts — from the document to the solver and back: which instances are bodies, which mates are active,
// where each mate's connectors are on its parts, and what to tell a person about each mate afterwards.
//
// Pure: the geometry is asked for through an interface, so the node tests feed it meshes straight from the
// kernel and the editor feeds it what the source documents have loaded (sources/manager.ts).
import type { GeomRef } from "../../mechanical/api";
import type { MateDefinition } from "../core/mate";
import type { ConnectorItem } from "../document/edits";
import { memberOf, patternOffset, type PatternItem, type RelationItem, type RigidItem } from "../document/extras";
import { transformOf as storedTransform, type InstanceItem, type MateConnector, type MateItem } from "../document/format";
import { flipped, frameFromAxis, frameInWorld, frameOfPose, prepareA, prepareB, shifted, turned } from "../solver/frames";
import { compose, dot, inverse, poseOf, unit, type Pose } from "../solver/math";
import { solve } from "../solver/solver";
import type { MateFrame, MateSolve, SolveOptions, SolveResult, SolverBody, SolverMate, SolverRelation } from "../solver/types";
import { relationDef } from "./relations";

export interface Geometry {
  /**
   * The connector frame of named geometry of an instance, in the instance's own space.  null: the instance has
   * no geometry of that name (it was deleted or renamed upstream).  undefined: the instance's source is still
   * loading, so nothing can be said yet.
   */
  frame(instance: InstanceItem, ref: GeomRef): MateFrame | null | undefined;
  /** The middle of an instance's geometry in its own space, when known: the point the solver turns it about. */
  centre?(instance: InstanceItem): [number, number, number] | null;
}

export type MateState = "ok" | "conflict" | "error" | "suppressed" | "inactive" | "pending" | "unknown-type";
export interface MateInfo {
  state: MateState;
  /** why, in a sentence a person can act on */
  message?: string;
  /** the mate's values as solved (mm, degrees) */
  values: { [key: string]: number };
}

export interface Problem {
  bodies: SolverBody[];
  mates: SolverMate[];
  /** what is already known about the mates that are not handed to the solver */
  info: Map<string, MateInfo>;
  /** the relations between mate values that are applied, and what is known of the ones that are not */
  relations: SolverRelation[];
  relationInfo: Map<string, MateInfo>;
}

/** What else of the document the solver takes besides instances and mates (document/extras.ts). */
export interface ProblemExtras { relations?: readonly RelationItem[]; patterns?: readonly PatternItem[]; rigids?: readonly RigidItem[] }

/** The id of the weld that holds a pattern copy to its seed, or a rigid group together: in the solver's reports, never in the document. */
export const patternMateId = (instance: string): string => `pattern:${instance}`;
export const rigidMateId = (group: string, instance: string): string => `rigid:${group}:${instance}`;
export const isPatternMate = (id: string): boolean => id.startsWith("pattern:") || id.startsWith("rigid:");
const WELD: MateSolve = {
  rigid: true,
  residuals(a, b, _p, reach, out) { out.push(b.o[0] - a.o[0], b.o[1] - a.o[1], b.o[2] - a.o[2], reach * (b.z[0] - a.z[0]), reach * (b.z[1] - a.z[1]), reach * (b.z[2] - a.z[2]), reach * (b.x[0] - a.x[0]), reach * (b.x[1] - a.x[1]), reach * (b.x[2] - a.x[2])); },
};

/** The connector half-way between two flat faces of one part (Width): in their middle plane, at the middle of their two centres. */
export function middleFrame(f: MateFrame, g: MateFrame): MateFrame {
  const opposite = dot(f.z, g.z) < 0;
  const z = unit(opposite ? [f.z[0] - g.z[0], f.z[1] - g.z[1], f.z[2] - g.z[2]] : [f.z[0] + g.z[0], f.z[1] + g.z[1], f.z[2] + g.z[2]]);
  const out = frameFromAxis([(f.o[0] + g.o[0]) / 2, (f.o[1] + g.o[1]) / 2, (f.o[2] + g.o[2]) / 2], z, f.x);
  return { ...out, surface: f.surface === "plane" && g.surface === "plane" && Math.abs(dot(f.z, g.z)) > 0.999 ? "plane" : "other" };
}

/** One end of a mate as a frame in its instance's space: through an explicit connector when it names one. */
export function endFrame(end: MateConnector, instance: InstanceItem, connectors: ReadonlyMap<string, ConnectorItem>, geometry: Geometry): MateFrame | null | undefined {
  const explicit = typeof end.connector === "string" ? connectors.get(end.connector) : undefined;
  if (typeof end.connector === "string" && !explicit) return null;
  let f = geometry.frame(instance, explicit ? explicit.ref : end.ref);
  if (!f) return f;
  if (!explicit && end.ref2) { const g = geometry.frame(instance, end.ref2); if (!g) return g; f = middleFrame(f, g); }
  if (explicit) {
    if (explicit.flip) f = flipped(f);
    const o = explicit.offset;
    if (Array.isArray(o) && o.length === 3 && o.some((v) => v)) f = shifted(f, [o[0], o[1], o[2]]);
    if (explicit.rotation) f = turned(f, (explicit.rotation * Math.PI) / 180);
  }
  return f;
}

/**
 * The solver's input.  `poses` overrides stored placements (a drag in progress, a draft).  A suppressed
 * instance is not a body; its mates are inactive.  A mate whose geometry is gone is an error and is left out.
 */
export function buildProblem(
  instances: readonly InstanceItem[], mates: readonly MateItem[], connectors: ReadonlyMap<string, ConnectorItem>,
  defs: readonly MateDefinition[], geometry: Geometry, poses?: ReadonlyMap<string, Pose>, extras: ProblemExtras = {},
): Problem {
  const byId = new Map<string, InstanceItem>();
  const bodies: SolverBody[] = [];
  for (const i of instances) {
    byId.set(i.id, i);
    if (i.suppressed) continue;
    const centre = geometry.centre ? geometry.centre(i) : null;
    bodies.push({ id: i.id, pose: poses?.get(i.id) || poseOf(storedTransform(i)), fixed: !!i.fixed, ...(centre ? { centre } : {}) });
  }
  const out: SolverMate[] = [];
  const info = new Map<string, MateInfo>();
  const say = (m: MateItem, state: MateState, message?: string) => info.set(m.id, { state, message, values: {} });
  for (const m of mates) {
    if (m.suppressed) { say(m, "suppressed"); continue; }
    const def = defs.find((d) => d.type === m.mateType);
    if (!def || !def.solve) { say(m, "unknown-type", `This Junction does not know the mate type “${m.mateType}”. It is kept as it is and not enforced.`); continue; }
    const ia = byId.get(m.a?.instance), ib = byId.get(m.b?.instance);
    if (!ia || !ib) { say(m, "error", "One of the instances this mate joined has been deleted. Edit the mate and pick its connectors again, or delete it."); continue; }
    if (ia.suppressed || ib.suppressed) { say(m, "inactive", `${ia.suppressed ? ia.name : ib.name} is suppressed, so this mate is not applied.`); continue; }
    const fa = endFrame(m.a, ia, connectors, geometry), fb = endFrame(m.b, ib, connectors, geometry);
    if (fa === undefined || fb === undefined) { say(m, "pending", "Waiting for the part to load."); continue; }
    if (!fa || !fb) { const lost = !fa ? ia : ib; say(m, "error", `The face, edge or point this mate used on ${lost.name} no longer exists. Edit the mate and pick it again.`); continue; }
    const params = m.params || {};
    if (def.pairs && (!m.a.ref2 || !m.b.ref2)) { say(m, "error", `${def.title} needs two faces on each part. Edit the mate and pick them.`); continue; }
    out.push({ id: m.id, solve: def.solve, a: { body: ia.id, frame: prepareA(fa, !!m.a.flip, params) }, b: { body: ib.id, frame: prepareB(fb, !!m.b.flip, params) }, params });
  }
  // a pattern's copies are welded to their seeds, each at its place in the seed's own space
  const patterns = new Map((extras.patterns || []).filter((p) => !p.suppressed).map((p) => [p.id, p]));
  for (const i of instances) {
    const m = memberOf(i), p = m && patterns.get(m.pattern), seed = m && byId.get(m.seed);
    if (!m || !p || !seed || i.suppressed || seed.suppressed) continue;
    const at = patternOffset(p, m.seed, m.index);
    if (at) out.push({ id: patternMateId(i.id), solve: WELD, a: { body: seed.id, frame: frameOfPose(at) }, b: { body: i.id, frame: frameOfPose({ p: [0, 0, 0], q: [0, 0, 0, 1] }) }, params: {} });
  }
  // a rigid group's instances are welded to the first of them that is there, each at the place the group keeps
  for (const g of extras.rigids || []) {
    if (g.suppressed) continue;
    const members = g.instances.map((id) => byId.get(id)).filter((i): i is InstanceItem => !!i && !i.suppressed && Array.isArray(g.places[i.id]) && g.places[i.id].length === 12);
    if (members.length < 2) continue;
    const first = poseOf(g.places[members[0].id]), back = inverse(first);
    for (const i of members.slice(1)) out.push({ id: rigidMateId(g.id, i.id), solve: WELD, a: { body: members[0].id, frame: frameOfPose(compose(back, poseOf(g.places[i.id]))) }, b: { body: i.id, frame: frameOfPose({ p: [0, 0, 0], q: [0, 0, 0, 1] }) }, params: {} });
  }
  // relations between the values of mates that are applied
  const relations: SolverRelation[] = [], relationInfo = new Map<string, MateInfo>();
  const live = new Map(out.map((m) => [m.id, m]));
  for (const r of extras.relations || []) {
    const tell = (state: MateState, message?: string) => relationInfo.set(r.id, { state, message, values: {} });
    if (r.suppressed) { tell("suppressed"); continue; }
    const def = relationDef(r.relationType);
    if (!def) { tell("unknown-type", `This Junction does not know the relation “${r.relationType}”. It is kept as it is and not enforced.`); continue; }
    const ma = live.get(r.a.mate), mb = live.get(r.b.mate);
    if (!ma || !mb) {
      const gone = !mates.some((m) => m.id === r.a.mate) || !mates.some((m) => m.id === r.b.mate);
      tell(gone ? "error" : info.get(!ma ? r.a.mate : r.b.mate)?.state === "pending" ? "pending" : "inactive", gone ? "A mate this relation tied has been deleted. Edit the relation and choose its mates again, or delete it." : "One of its mates is not applied, so neither is this relation.");
      continue;
    }
    const va = ma.solve.values?.find((v) => v.key === r.a.key), vb = mb.solve.values?.find((v) => v.key === r.b.key);
    if (!va || !vb || va.unit !== def.a.unit || vb.unit !== def.b.unit) { tell("error", `${def.title} needs ${def.a.unit === "deg" ? "a mate that turns" : "a mate that slides"} and ${def.b.unit === "deg" ? "a mate that turns" : "a mate that slides"}. Edit the relation and choose its mates again.`); continue; }
    if (ma === mb && r.a.key === r.b.key) { tell("error", "A relation ties two different values. Choose another mate for one side."); continue; }
    relations.push({ id: r.id, a: { mate: r.a.mate, key: r.a.key }, b: { mate: r.b.mate, key: r.b.key }, ratio: def.ratio(r.params || {}) });
  }
  return { bodies, mates: out, info, relations, relationInfo };
}

export interface Solved { result: SolveResult; mates: Map<string, MateInfo>; relations: Map<string, MateInfo> }

/** how far a driven value may go in one solve while a relation follows it: a gear must not skip half a turn */
const DRIVE_STEP = { deg: Math.PI / 6, mm: 25 };

/** Solve a problem and merge what the solver says about each mate with what was known before it ran. */
export function solveProblem(p: Problem, opts: SolveOptions = {}): Solved {
  const withRelations: SolveOptions = p.relations.length ? { ...opts, relations: p.relations } : opts;
  let result: SolveResult | null = null;
  if (p.relations.length && opts.drives && opts.drives.length) {
    // A relation follows its mates from where they stand, so a value typed far from where it is (a quarter turn
    // of a 10 : 1 gear) is reached in steps, each small enough for the other side to follow.
    const now = measureMates(p, new Map(p.bodies.map((b) => [b.id, b.pose])));
    let steps = 1;
    const from = opts.drives.map((d) => {
      const m = p.mates.find((x) => x.id === d.mate), v = m?.solve.values?.find((x) => x.key === d.key), have = now.get(d.mate)?.[d.key];
      if (!v || have === undefined) return d.value;
      const start = v.unit === "deg" ? (have * Math.PI) / 180 : have;
      let delta = d.value - start;
      if (v.unit === "deg") delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      steps = Math.max(steps, Math.ceil(Math.abs(delta) / DRIVE_STEP[v.unit]));
      return d.value - delta;
    });
    steps = Math.min(steps, 48);
    if (steps > 1) {
      let bodies = p.bodies;
      for (let s = 1; s <= steps; s++) {
        const drives = opts.drives.map((d, i) => ({ ...d, value: from[i] + ((d.value - from[i]) * s) / steps }));
        result = solve(bodies, p.mates, { ...withRelations, drives, analyze: s === steps && opts.analyze, seed: s === 1 ? opts.seed : undefined });
        if (!result.ok) break;
        const poses = result.poses;
        bodies = bodies.map((b) => ({ ...b, pose: poses.get(b.id) || b.pose }));
      }
    }
  }
  if (!result) result = solve(p.bodies, p.mates, withRelations);
  const mates = new Map(p.info);
  for (const [id, r] of result.mates) if (!isPatternMate(id)) mates.set(id, { state: r.status, message: r.message, values: r.values });
  const relations = new Map(p.relationInfo);
  for (const [id, r] of result.relations) relations.set(id, { state: r.status, message: r.message, values: {} });
  return { result, mates, relations };
}

/** Every active mate's values (mm, degrees) as the bodies stand in `poses`: what is stored with the placements. */
export function measureMates(p: Problem, poses: ReadonlyMap<string, Pose>): Map<string, { [key: string]: number }> {
  const out = new Map<string, { [key: string]: number }>();
  for (const m of p.mates) {
    const pa = poses.get(m.a.body), pb = poses.get(m.b.body), values = m.solve.values;
    if (!pa || !pb || !values || !values.length) continue;
    const a = frameInWorld(pa, m.a.frame), b = frameInWorld(pb, m.b.frame);
    const v: { [key: string]: number } = {};
    for (const x of values) v[x.key] = x.unit === "deg" ? (x.measure(a, b) * 180) / Math.PI : x.measure(a, b);
    out.set(m.id, v);
  }
  return out;
}

/** A sensible `reach` for the solver: about the size of what is being assembled. */
export function reachOf(mates: readonly SolverMate[]): number {
  let top = 0;
  for (const m of mates) for (const e of [m.a, m.b]) top = Math.max(top, Math.abs(e.frame.o[0]), Math.abs(e.frame.o[1]), Math.abs(e.frame.o[2]));
  return Math.min(1000, Math.max(20, top));
}
