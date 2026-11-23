// model.ts — an assembly as an AI assistant reads and edits it: the instances and mates as JSON, a list of edits
// turned into item changes (document/edits.ts) with the mates solved after each step, and what the solver then
// says (freedoms left, mates that conflict).
//
// Pure: no kernel, no network.  The geometry of the instances is asked for through `AssemblyGeometry`, which
// mcp/host.ts answers from the part studios it has built and the node tests answer from meshes of their own.
// The solving is the editor's own: model/problem.ts builds the solver's input from the document and the
// connector frames (connectors/infer.ts), solver/solver.ts solves, and the placements written back are the
// solved ones, as the format requires (document/format.ts).
import { applyChanges, invertChange, newId, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { BodyMesh, GeomRef, ParamField, Vec3 } from "../../mechanical/api";
import { PickError, pickGeometry, type GeoKind } from "../../mechanical/mcp/select";
import { connectorOf, describeConnector } from "../connectors/infer";
import type { MateDefinition } from "../core/mate";
import { multiply } from "../core/transform";
import * as edits from "../document/edits";
import { connectorsOf, numberedName } from "../document/edits";
import { IDENTITY, instancesOf, isInstance, isMate, matesOf, transformOf as storedTransform, type InstanceItem, type InstanceSource, type MateConnector, type MateItem, type Transform } from "../document/format";
import { buildProblem, measureMates, reachOf, solveProblem, type Geometry, type MateInfo } from "../model/problem";
import { frameInWorld } from "../solver/frames";
import { applyPose, poseOf, transformOf, type Pose } from "../solver/math";

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const vec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(num);
const r3 = (v: number): number => { const x = Math.round(v * 1e3) / 1e3; return Object.is(x, -0) ? 0 : x; };

/** One rigid piece of an instance's source: a body of a part studio, a part inside a sub-assembly. */
export interface Piece { id: string; name: string; mesh: BodyMesh; /** where it sits in the source's own space; null: as the mesh is */ local: Transform | null }
export interface SourcePieces { status: "ready" | "error"; message?: string; pieces: Piece[] }
export interface AssemblyGeometry {
  /** the pieces an instance with this source shows */
  pieces(source: InstanceSource): SourcePieces;
}

/** A mesh carried by a placement, for picking where the instance stands.  The host caches it; tests need not. */
export type Standing = (mesh: BodyMesh, t: Transform) => BodyMesh;

function solverGeometry(geo: AssemblyGeometry): Geometry {
  const centres = new Map<string, Vec3 | null>();
  return {
    frame: (instance, ref) => {
      const src = geo.pieces(instance.source);
      if (src.status !== "ready") return null;
      let piece = src.pieces.find((p) => p.id === ref.body);
      let f = piece ? connectorOf(piece.mesh, ref) : null;
      if (!f) for (const p of src.pieces) { f = connectorOf(p.mesh, ref); if (f) { piece = p; break; } }
      if (!f || !piece) return null;
      return piece.local ? frameInWorld(poseOf(piece.local), f) : f;
    },
    centre: (instance) => {
      const key = JSON.stringify(instance.source);
      if (centres.has(key)) return centres.get(key)!;
      const { pieces } = geo.pieces(instance.source);
      let c: Vec3 | null = null;
      if (pieces.length) {
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const p of pieces) for (let k = 0; k < 8; k++) {
          let v: Vec3 = [k & 1 ? p.mesh.bbox[3] : p.mesh.bbox[0], k & 2 ? p.mesh.bbox[4] : p.mesh.bbox[1], k & 4 ? p.mesh.bbox[5] : p.mesh.bbox[2]];
          if (p.local) v = applyPose(poseOf(p.local), v);
          for (let i = 0; i < 3; i++) { if (v[i] < lo[i]) lo[i] = v[i]; if (v[i] > hi[i]) hi[i] = v[i]; }
        }
        c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      }
      centres.set(key, c);
      return c;
    },
  };
}

// ---------------------------------------------------------------- solving

export interface Solved {
  /** every unsuppressed instance's placement as solved */
  transforms: Map<string, Transform>;
  mates: Map<string, MateInfo>;
  /** freedoms each instance is left (null when not analysed), and whether it cannot move at all */
  instances: Map<string, { dof: number | null; grounded: boolean }>;
  dof: number | null;
  ok: boolean;
  /** the values each active mate has in these placements */
  values: Map<string, { [key: string]: number }>;
}

export interface SolveOptions {
  /** a mate just made or changed: its second instance is first put where that one mate wants it */
  seed?: string;
  /** hold these mate values (degrees, millimetres) during the solve */
  drives?: { mate: string; key: string; value: number }[];
  /** do not hold the stored values of the other mates (a move that is meant to change them) */
  free?: boolean;
  analyze?: boolean;
}

/** Solve the document's mates from its stored placements.  The other mates keep their stored values when they can. */
export function solveAssembly(doc: ItemDoc, defs: readonly MateDefinition[], geo: AssemblyGeometry, o: SolveOptions = {}): Solved {
  const instances = instancesOf(doc), mates = matesOf(doc);
  const connectors = new Map(connectorsOf(doc).map((c) => [c.id, c]));
  const problem = buildProblem(instances, mates, connectors, defs, solverGeometry(geo));
  const reach = reachOf(problem.mates);
  const rad = (mate: string, key: string, value: number): { mate: string; key: string; value: number } => {
    const m = mates.find((x) => x.id === mate), v = m && defs.find((d) => d.type === m.mateType)?.solve?.values?.find((x) => x.key === key);
    return { mate, key, value: v && v.unit === "deg" ? (value * Math.PI) / 180 : value };
  };
  const asked = (o.drives || []).map((d) => rad(d.mate, d.key, d.value));
  let solved = solveProblem(problem, { analyze: o.analyze !== false, reach, seed: o.seed, drives: asked.length ? asked : undefined });
  if (!o.free && solved.result.iterations > 0) {
    // of the placements that satisfy the mates, the one that keeps every other mate's value (a lid left open stays open)
    const kept = asked.slice();
    for (const m of problem.mates) {
      if (m.id === o.seed) continue;
      const item = doc.items.get(m.id);
      const was = isMate(item) && item.values && typeof item.values === "object" ? item.values : null;
      if (!was) continue;
      for (const v of m.solve.values || []) { const x = was[v.key]; if (typeof x === "number" && !asked.some((d) => d.mate === m.id && d.key === v.key)) kept.push({ mate: m.id, key: v.key, value: v.unit === "deg" ? (x * Math.PI) / 180 : x }); }
    }
    if (kept.length > asked.length) { const held = solveProblem(problem, { analyze: o.analyze !== false, reach, seed: o.seed, drives: kept }); if (held.result.ok) solved = held; }
  }
  const transforms = new Map<string, Transform>();
  for (const [id, pose] of solved.result.poses) transforms.set(id, transformOf(pose as Pose));
  const info = new Map<string, { dof: number | null; grounded: boolean }>();
  for (const i of instances) { const b = solved.result.bodies.get(i.id); info.set(i.id, { dof: b ? b.dof : null, grounded: b ? b.grounded : !!i.fixed }); }
  return { transforms, mates: solved.mates, instances: info, dof: solved.result.dof, ok: solved.result.ok, values: measureMates(problem, solved.result.poses) };
}

// ---------------------------------------------------------------- reading

/** A placement as an assistant reads it: where the instance's origin is, and how it is turned when it is. */
export function placementJson(t: readonly number[]): JsonObject {
  const out: JsonObject = { position: [r3(t[3]), r3(t[7]), r3(t[11])] };
  const turned = Math.abs(t[0] - 1) > 1e-9 || Math.abs(t[5] - 1) > 1e-9 || Math.abs(t[10] - 1) > 1e-9;
  if (turned) {
    // axis and angle of the rotation
    const tr = t[0] + t[5] + t[10], angle = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
    let axis: number[] = [t[9] - t[6], t[2] - t[8], t[4] - t[1]];
    const l = Math.hypot(axis[0], axis[1], axis[2]);
    if (l > 1e-9) axis = axis.map((v) => v / l);
    else axis = [Math.sqrt(Math.max(0, (t[0] + 1) / 2)), Math.sqrt(Math.max(0, (t[5] + 1) / 2)), Math.sqrt(Math.max(0, (t[10] + 1) / 2))];
    out.rotation = { axis: axis.map(r3), angle: r3((angle * 180) / Math.PI) };
  }
  return out;
}

/** One end of a mate; `compact` leaves the geometry's (long) name out. */
const endJson = (doc: ItemDoc, end: MateConnector, compact?: boolean): JsonObject => {
  const i = doc.items.get(end?.instance);
  return { instance: isInstance(i) ? i.name : String(end?.instance), kind: end?.ref?.kind, ...(compact ? {} : { name: end?.ref?.name }), ...(end?.flip ? { flip: true } : {}) };
};

export interface ReadOptions { compact?: boolean; docName?(docId: string): string }

/** The assembly as an assistant reads it, with what the solver says. */
export function assemblyJson(doc: ItemDoc, defs: readonly MateDefinition[], geo: AssemblyGeometry, o: ReadOptions = {}): JsonObject {
  const instances = instancesOf(doc), mates = matesOf(doc);
  const solved = solveAssembly(doc, defs, geo);
  const hints: string[] = [];
  const rows = instances.map((i) => {
    const info = solved.instances.get(i.id), src = geo.pieces(i.source);
    const row: JsonObject = { id: i.id, name: i.name };
    const s = i.source;
    row.source = (o.docName ? o.docName(s.docId) : s.docId) + (s.kind === "part" ? "" : ` (${s.kind})`);
    if (s.kind === "part" && !o.compact) row.body = src.pieces.find((p) => p.id === s.body)?.name || s.body;
    Object.assign(row, placementJson(solved.transforms.get(i.id) || storedTransform(i)));
    if (i.fixed) row.fixed = true;
    if (i.suppressed) row.suppressed = true;
    if (i.hidden) row.hidden = true;
    if (!i.suppressed) { if (info && info.dof !== null) row.freedoms = info.dof; if (src.status !== "ready") row.problem = src.message || "Its source could not be built."; }
    const supplier = (i as JsonObject).supplier;
    if (isObject(supplier) && typeof supplier.title === "string" && !o.compact) row.supplier = supplier.title;
    return row;
  });
  const mateRows = mates.map((m) => {
    const info = solved.mates.get(m.id);
    const row: JsonObject = { id: m.id, name: m.name, type: m.mateType, a: endJson(doc, m.a, o.compact), b: endJson(doc, m.b, o.compact) };
    if (!o.compact) { const p: JsonObject = {}; const base = defs.find((d) => d.type === m.mateType)?.defaults() || {}; for (const [k, v] of Object.entries(m.params || {})) if (base[k] !== v) p[k] = v; if (Object.keys(p).length) row.params = p; }
    if (m.suppressed) row.suppressed = true;
    row.state = info ? info.state : "ok";
    if (info && info.message) row.message = info.message;
    const values = solved.values.get(m.id) || (info ? info.values : {});
    if (values && Object.keys(values).length) row.values = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, r3(v)]));
    return row;
  });
  const active = instances.filter((i) => !i.suppressed);
  if (active.length && !active.some((i) => i.fixed)) hints.push("No instance is fixed, so the whole assembly can float: fix the base part with { op: \"fix\", instance }.");
  for (const m of mateRows) if (m.state !== "ok" && m.state !== "suppressed") hints.push(`Mate "${m.name}" is ${m.state}${m.message ? ": " + m.message : ""}`);
  const free = rows.filter((r) => typeof r.freedoms === "number" && (r.freedoms as number) > 0);
  if (free.length && active.some((i) => i.fixed)) hints.push(`${free.map((r) => `${r.name} (${r.freedoms})`).join(", ")} can still move: that is right for a moving part (a hinge leaves 1), otherwise add a mate.`);
  return {
    units: "mm, degrees",
    instances: rows, mates: mateRows,
    solve: { ok: solved.ok && !mateRows.some((m) => m.state === "conflict" || m.state === "error"), freedoms: solved.dof, ...(hints.length ? { hints } : {}) },
  };
}

/** The mate types with their parameters, for the "mates" page of cad_reference. */
export function mateTypesText(defs: readonly MateDefinition[], fieldDoc: (f: ParamField) => JsonObject): string {
  const sorted = defs.slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6));
  let text = "";
  for (const d of sorted) {
    const free = d.freedom.translation + d.freedom.rotation;
    const values = (d.solve?.values || []).map((v) => `${v.key} (${v.unit})`).join(", ");
    text += `- ${d.type}: ${d.title}. Leaves ${free === 0 ? "no freedom" : `${d.freedom.translation} translation${d.freedom.translation === 1 ? "" : "s"} and ${d.freedom.rotation} rotation${d.freedom.rotation === 1 ? "" : "s"}`}.`;
    if (values) text += ` Values that can be driven and limited: ${values}.`;
    const fields = d.schema.map((f) => { const doc = fieldDoc(f); return `${f.key} (${f.kind === "number" ? (f.unit === "deg" ? "deg" : "mm") : f.kind}${doc.hint ? ": " + doc.hint : ""})`; });
    if (fields.length) text += ` params: ${fields.join("; ")}.`;
    text += "\n";
  }
  return text;
}

// ---------------------------------------------------------------- planning edits

export interface AssemblyPlan {
  changes: ItemChange[]; inverse: ItemChange[]; done: string[]; problems: string[]; after: ItemDoc;
  notes: string[];
}

/** What an insert places, worked out before planning (the host builds the source and asks the suppliers). */
export interface ResolvedInsert { offers: { source: InstanceSource; name: string }[]; supplier?: JsonObject; problem?: string }

export interface PlanContext {
  defs: readonly MateDefinition[];
  geo: AssemblyGeometry;
  /** what each insert edit places, by its index in the list */
  inserts: ReadonlyMap<number, ResolvedInsert>;
  standing?: Standing;
}

const copyDoc = (doc: ItemDoc): ItemDoc => ({ ...doc, head: { ...doc.head }, items: new Map(doc.items) });

export const ASSEMBLY_OPS = ["insert", "move", "fix", "rename", "suppress", "hide", "delete", "copy", "mate", "set_mate", "drive"];

function move(mesh: BodyMesh, t: Transform): BodyMesh {
  const go = (src: Float32Array, w: number): Float32Array => {
    const out = new Float32Array(src.length);
    for (let i = 0; i + 2 < src.length; i += 3) { const x = src[i], y = src[i + 1], z = src[i + 2]; out[i] = t[0] * x + t[1] * y + t[2] * z + w * t[3]; out[i + 1] = t[4] * x + t[5] * y + t[6] * z + w * t[7]; out[i + 2] = t[8] * x + t[9] * y + t[10] * z + w * t[11]; }
    return out;
  };
  return { ...mesh, positions: go(mesh.positions, 1), normals: go(mesh.normals, 0), edges: { ...mesh.edges, positions: go(mesh.edges.positions, 1) }, vertices: { ...mesh.vertices, positions: go(mesh.vertices.positions, 1) } };
}

/** A rotation about an axis through a point, as a placement to multiply in front of another. */
export function rotation(axis: Vec3, degrees: number, about: Vec3): Transform {
  const l = Math.hypot(axis[0], axis[1], axis[2]) || 1, [x, y, z] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), k = 1 - c;
  const R = [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
  const t = [0, 1, 2].map((r) => about[r] - (R[r * 3] * about[0] + R[r * 3 + 1] * about[1] + R[r * 3 + 2] * about[2]));
  return [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2]];
}
const AXES: { [k: string]: Vec3 } = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * Turn a list of edits into item changes.  Each edit sees the assembly as the ones before it left it, with the
 * mates solved; if any is wrong nothing is planned and every problem is listed.  The edits:
 *   { op: "insert", part | assembly | standard | model, body?, name?, at?, rotate?, fixed?, ref? }
 *   { op: "move", instance, to? | by?, rotate?: { axis, angle, about? } }
 *   { op: "fix", instance, fixed? } · { op: "rename", instance | mate, name } · { op: "suppress", instance | mate, suppressed? }
 *   { op: "hide", instance, hidden? } · { op: "delete", instance | mate } · { op: "copy", instance, count?, step }
 *   { op: "mate", type, a, b, name?, params?, ref? } · { op: "set_mate", mate, a?, b?, params?, type?, name? }
 *   { op: "drive", mate, value, key? }
 * An instance or a mate is named by its id, its exact name, or "$ref" of an insert or mate earlier in the list.
 * A connector (a, b) is { instance, face | edge | vertex: <name or pick>, flip? } or { instance, kind, name | pick }.
 */
export function planAssemblyEdits(doc: ItemDoc, list: unknown, ctx: PlanContext): AssemblyPlan {
  const work = copyDoc(doc);
  const changes: ItemChange[] = [], inverse: ItemChange[] = [], done: string[] = [], problems: string[] = [], notes: string[] = [];
  const refs = new Map<string, string>();
  const empty = (): AssemblyPlan => ({ changes: [], inverse: [], done: [], problems, after: doc, notes: [] });
  if (!Array.isArray(list) || !list.length) { problems.push("edits must be a list with at least one edit"); return empty(); }
  const take = (cs: ItemChange[]): void => { for (const c of cs) { const inv = invertChange(work, c); if (applyChanges(work, [c]).size) { changes.push(c); if (inv) inverse.unshift(inv); } } };
  /** solve, and write the placements and mate values the solver found into the working document */
  const settle = (o: SolveOptions = {}): Solved => {
    const s = solveAssembly(work, ctx.defs, ctx.geo, { ...o, analyze: false });
    take([...edits.setTransforms(work, s.transforms), ...edits.setMateValues(work, s.values)]);
    return s;
  };
  const standing = ctx.standing || move;

  list.forEach((raw, n) => {
    const e = raw as JsonObject;
    const where = `edit ${n + 1}` + (isObject(e) && typeof e.op === "string" ? ` (${e.op})` : "");
    const bad = (m: string): void => { problems.push(`${where}: ${m}`); };
    if (!isObject(e) || typeof e.op !== "string") { bad(`needs an op (${ASSEMBLY_OPS.join(", ")})`); return; }
    const instances = instancesOf(work), mates = matesOf(work);
    const key = (v: unknown): string => (typeof v === "string" && v.startsWith("$") && refs.has(v.slice(1)) ? refs.get(v.slice(1))! : String(v));
    const instance = (v: unknown, what = "instance"): InstanceItem | null => {
      if (typeof v !== "string" || !v) { bad(`${what} is required: an instance's name or id`); return null; }
      const k = key(v), low = k.toLowerCase();
      const hit = instances.find((i) => i.id === k) || instances.find((i) => i.name === k) || instances.find((i) => i.name.toLowerCase() === low);
      if (!hit) bad(`there is no instance "${v}". The instances are: ${instances.map((i) => i.name).join(", ") || "(none; insert one first)"}`);
      return hit || null;
    };
    const mate = (v: unknown): MateItem | null => {
      if (typeof v !== "string" || !v) { bad("mate is required: a mate's name or id"); return null; }
      const k = key(v), low = k.toLowerCase();
      const hit = mates.find((m) => m.id === k) || mates.find((m) => m.name === k) || mates.find((m) => m.name.toLowerCase() === low);
      if (!hit) bad(`there is no mate "${v}". The mates are: ${mates.map((m) => m.name).join(", ") || "(none)"}`);
      return hit || null;
    };
    /** one end of a mate from what the edit says: the geometry is picked on the instance where it stands */
    const connector = (v: unknown, side: string): { end: MateConnector; surface: string; explicit: boolean } | null => {
      if (!isObject(v)) { bad(`${side} is a connector: { instance, face | edge | vertex: <name or pick>, flip? }`); return null; }
      const inst = instance(v.instance, `${side}.instance`); if (!inst) return null;
      let kind: GeoKind | null = null, what: unknown;
      for (const k of ["face", "edge", "vertex"] as GeoKind[]) if (v[k] !== undefined) { kind = k; what = v[k]; }
      if (!kind && isObject(v.ref)) { kind = v.ref.kind as GeoKind; what = v.ref.name; }
      if (!kind && typeof v.kind === "string") { kind = v.kind as GeoKind; what = v.pick !== undefined ? v.pick : v.name; }
      if (!kind || !["face", "edge", "vertex"].includes(kind) || what === undefined) { bad(`${side} needs face, edge or vertex: a name from cad_find_geometry, or a pick ("top", { hole: true, diameter: 5 }, …)`); return null; }
      const src = ctx.geo.pieces(inst.source);
      if (src.status !== "ready" || !src.pieces.length) { bad(`${side}: ${inst.name} has no geometry (${src.message || "its source could not be built"})`); return null; }
      const placed = storedTransform(inst);
      let last = "";
      // a name is looked for on every piece; a pick takes the best of the first piece that has a match
      for (const p of src.pieces) {
        const t = p.local ? multiply(placed, p.local) : placed;
        try {
          const g = pickGeometry(standing(p.mesh, t), kind, what)[0];
          const f = connectorOf(p.mesh, { kind, name: g.name });
          const end: MateConnector = { instance: inst.id, ref: { kind, body: p.id, name: g.name } as GeomRef };
          if (v.flip === true) end.flip = true;
          return { end, surface: f ? describeConnector(f, kind) : kind, explicit: typeof v.flip === "boolean" };
        } catch (err) { if (!(err instanceof PickError)) throw err; last = err.message; }
      }
      bad(`${side} on ${inst.name}: ${last}`);
      return null;
    };
    const checkParams = (def: MateDefinition, params: JsonObject): boolean => {
      const known = new Set([...def.schema.map((f) => f.key), "offsetX", "offsetY", "offsetZ", "offset", "rotation", "reorient", ...Object.keys(def.defaults())]);
      const odd = Object.keys(params).filter((k) => !known.has(k));
      if (odd.length) { bad(`a ${def.type} mate has no parameter ${odd.map((k) => `"${k}"`).join(", ")}. Its parameters are: ${Array.from(known).join(", ")}`); return false; }
      for (const f of def.schema) { const v = params[f.key]; if (v === undefined) continue; if (f.kind === "number" && !num(v)) { bad(`${f.key} must be a number`); return false; } if (f.kind === "boolean" && typeof v !== "boolean") { bad(`${f.key} must be true or false`); return false; } }
      return true;
    };
    const told = (s: Solved, id: string, name: string): void => {
      const info = s.mates.get(id);
      if (info && info.state !== "ok") notes.push(`Mate "${name}" is ${info.state}${info.message ? ": " + info.message : ""}`);
    };

    switch (e.op) {
      case "insert": {
        const got = ctx.inserts.get(n);
        if (!got || got.problem || !got.offers.length) { bad(got && got.problem ? got.problem : "say what to insert: part (a part studio's path), assembly (an assembly's path), standard (\"M5x20 socket head\") or model ({ provider, id } from cad_search_models)"); return; }
        if (e.at !== undefined && !vec(e.at)) { bad("at is where the instance's origin goes: [x, y, z] in millimetres"); return; }
        let turn: Transform | null = null;
        if (e.rotate !== undefined) {
          const r = e.rotate as JsonObject;
          const axis = isObject(r) ? (typeof r.axis === "string" ? AXES[r.axis.toLowerCase()] : vec(r.axis) ? r.axis : null) : null;
          if (!axis || !num((r as JsonObject).angle)) { bad("rotate is { axis: \"x\" | \"y\" | \"z\" | [x, y, z], angle: degrees }"); return; }
          turn = rotation(axis, (r as JsonObject).angle as number, [0, 0, 0]);
        }
        const same = (a: InstanceSource, b: InstanceSource) => a.kind === b.kind && a.docId === b.docId && (a.kind !== "part" || (b.kind === "part" && a.body === b.body));
        const list2 = got.offers.map((o, k) => {
          let t: Transform = turn ? (turn.slice() as Transform) : (IDENTITY.slice() as Transform);
          if (vec(e.at)) { t[3] = e.at[0]; t[7] = e.at[1]; t[11] = e.at[2]; }
          else {
            // a part keeps the place its studio gave it; one that is already there is set beside its like
            const before = instances.filter((i) => same(i.source, o.source)).length + got.offers.slice(0, k).filter((x) => same(x.source, o.source)).length;
            if (before) { let width = 0; for (const p of ctx.geo.pieces(o.source).pieces) if (o.source.kind !== "part" || p.id === (o.source as { body: string }).body) width = Math.max(width, p.mesh.bbox[3] - p.mesh.bbox[0]); t = t.slice() as Transform; t[3] += before * (width * 1.15 + 5); }
          }
          const name = typeof e.name === "string" && e.name.trim() ? (got.offers.length > 1 ? `${e.name.trim()} ${o.name}` : e.name.trim()) : o.name;
          return { source: o.source, name, transform: t, fixed: e.fixed === true };
        });
        const made = edits.insertInstances(work, list2);
        const withSupplier = got.supplier ? made.changes.map((c) => (c.kind === "ADDED" ? { ...c, item: { ...c.item, supplier: got.supplier } } : c)) : made.changes;
        take(withSupplier as ItemChange[]);
        if (typeof e.ref === "string" && e.ref) refs.set(e.ref.replace(/^\$/, ""), made.items[0].id);
        done.push(`inserted ${made.items.map((i) => `"${i.name}"`).join(", ")}` + (e.fixed === true ? " (fixed)" : ""));
        return;
      }
      case "move": {
        const i = instance(e.instance); if (!i) return;
        let t = storedTransform(i);
        if (e.to !== undefined) { if (!vec(e.to)) { bad("to is where the instance's origin goes: [x, y, z] in millimetres"); return; } t[3] = e.to[0]; t[7] = e.to[1]; t[11] = e.to[2]; }
        if (e.by !== undefined) { if (!vec(e.by)) { bad("by is a displacement: [dx, dy, dz] in millimetres"); return; } t[3] += e.by[0]; t[7] += e.by[1]; t[11] += e.by[2]; }
        if (e.rotate !== undefined) {
          const r = e.rotate as JsonObject;
          const axis = isObject(r) ? (typeof r.axis === "string" ? AXES[r.axis.toLowerCase()] : vec(r.axis) ? r.axis : null) : null;
          if (!axis || !num(r.angle)) { bad("rotate is { axis: \"x\" | \"y\" | \"z\" | [x, y, z], angle: degrees, about?: [x, y, z] } (about: a point of the axis, in assembly space; the instance's own origin when omitted)"); return; }
          const about: Vec3 = vec(r.about) ? r.about : [t[3], t[7], t[11]];
          t = multiply(rotation(axis, r.angle, about), t);
        }
        if (e.to === undefined && e.by === undefined && e.rotate === undefined) { bad("give to, by or rotate"); return; }
        take(edits.setTransforms(work, new Map([[i.id, t]])));
        const s = settle({ free: true });
        const now = s.transforms.get(i.id) || t;
        const held = Math.hypot(now[3] - t[3], now[7] - t[7], now[11] - t[11]) > 1e-4;
        done.push(`moved "${i.name}" to [${[now[3], now[7], now[11]].map(r3).join(", ")}]` + (held ? " (its mates hold it: it went as far as they allow)" : ""));
        return;
      }
      case "fix": {
        const i = instance(e.instance); if (!i) return;
        const on = e.fixed !== false;
        take(edits.setFixed(work, [i.id], on)); done.push(`${on ? "fixed" : "freed"} "${i.name}"`);
        return;
      }
      case "rename": {
        const it = e.mate !== undefined ? mate(e.mate) : instance(e.instance); if (!it) return;
        if (typeof e.name !== "string" || !e.name.trim()) { bad("name is required"); return; }
        take(edits.renameItem(work, it.id, e.name)); done.push(`renamed "${it.name}" to "${e.name.trim()}"`);
        return;
      }
      case "suppress": {
        const it = e.mate !== undefined ? mate(e.mate) : instance(e.instance); if (!it) return;
        const on = e.suppressed !== false;
        take(edits.setSuppressed(work, [it.id], on)); settle();
        done.push(`${on ? "suppressed" : "unsuppressed"} "${it.name}"`);
        return;
      }
      case "hide": {
        const i = instance(e.instance); if (!i) return;
        const on = e.hidden !== false;
        take(edits.setHidden(work, [i.id], on)); done.push(`${on ? "hid" : "showed"} "${i.name}"`);
        return;
      }
      case "delete": {
        const it = e.mate !== undefined ? mate(e.mate) : instance(e.instance); if (!it) return;
        const lost = isInstance(it) ? mates.filter((m) => m.a.instance === it.id || m.b.instance === it.id).map((m) => m.name) : [];
        take(edits.deleteItems(work, [it.id])); settle();
        done.push(`deleted "${it.name}"` + (lost.length ? ` and its mates (${lost.join(", ")})` : ""));
        return;
      }
      case "copy": {
        const i = instance(e.instance); if (!i) return;
        if (!vec(e.step)) { bad("step is the displacement from one copy to the next: [dx, dy, dz] in millimetres"); return; }
        const count = e.count === undefined ? 1 : Math.round(Number(e.count));
        if (!(count >= 1 && count <= 200)) { bad("count is the number of copies, 1 to 200"); return; }
        const made = edits.copyInstances(work, [i.id], count, e.step);
        take(made.changes);
        if (typeof e.ref === "string" && e.ref) refs.set(e.ref.replace(/^\$/, ""), made.items[0].id);
        done.push(`copied "${i.name}" ${count} time${count === 1 ? "" : "s"}: ${made.items.map((x) => `"${x.name}"`).join(", ")}`);
        return;
      }
      case "mate": {
        const def = ctx.defs.find((d) => d.type === String(e.type || "").toLowerCase());
        if (!def) { bad(`unknown mate type "${String(e.type)}". The types are: ${ctx.defs.map((d) => d.type).join(", ")} (cad_reference topic "mates")`); return; }
        const a = connector(e.a, "a"), b = connector(e.b, "b"); if (!a || !b) return;
        if (a.end.instance === b.end.instance) { bad("a and b must be on two different instances"); return; }
        const given = isObject(e.params) ? e.params : {};
        if (!checkParams(def, given)) return;
        const params: JsonObject = { ...def.defaults(), ...given };
        // two flat faces are mated facing each other unless the edit says how
        if (a.surface === "Flat face" && b.surface === "Flat face" && !a.explicit && !b.explicit) { b.end.flip = true; }
        const name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : numberedName(mates.map((m) => m.name), def.title);
        const made = edits.addMate(work, { mateType: def.type, name, a: a.end, b: b.end, params }, newId());
        take(made.changes);
        if (typeof e.ref === "string" && e.ref) refs.set(e.ref.replace(/^\$/, ""), made.item.id);
        const s = settle({ seed: made.item.id });
        told(s, made.item.id, name);
        const ia = work.items.get(a.end.instance) as InstanceItem, ib = work.items.get(b.end.instance) as InstanceItem;
        done.push(`added ${def.title.toLowerCase()} mate "${name}": ${ia.name} (${a.surface.toLowerCase()}) to ${ib.name} (${b.surface.toLowerCase()}${b.end.flip ? ", flipped" : ""})`);
        return;
      }
      case "set_mate": {
        const m = mate(e.mate); if (!m) return;
        const def = ctx.defs.find((d) => d.type === (typeof e.type === "string" ? e.type.toLowerCase() : m.mateType));
        if (!def) { bad(`unknown mate type "${String(e.type)}". The types are: ${ctx.defs.map((d) => d.type).join(", ")}`); return; }
        const patch: Partial<Pick<MateItem, "name" | "a" | "b" | "params" | "mateType">> = {};
        if (e.a !== undefined) { const a = connector(e.a, "a"); if (!a) return; patch.a = a.end; }
        if (e.b !== undefined) { const b = connector(e.b, "b"); if (!b) return; patch.b = b.end; }
        if ((patch.a || m.a).instance === (patch.b || m.b).instance) { bad("a and b must be on two different instances"); return; }
        if (isObject(e.params)) { if (!checkParams(def, e.params)) return; patch.params = { ...(def.type === m.mateType ? m.params : def.defaults()), ...e.params }; }
        else if (def.type !== m.mateType) patch.params = def.defaults();
        if (def.type !== m.mateType) patch.mateType = def.type;
        if (typeof e.name === "string" && e.name.trim()) patch.name = e.name.trim();
        if (!Object.keys(patch).length) { bad("give a, b, params, type or name"); return; }
        take(edits.updateMate(work, m.id, patch));
        const s = settle({ seed: m.id });
        told(s, m.id, patch.name || m.name);
        done.push(`changed mate "${m.name}"${patch.name ? ` (now "${patch.name}")` : ""}`);
        return;
      }
      case "drive": {
        const m = mate(e.mate); if (!m) return;
        const def = ctx.defs.find((d) => d.type === m.mateType), values = def?.solve?.values || [];
        if (!values.length) { bad(`a ${m.mateType} mate has no value to drive. Mates with one: ${ctx.defs.filter((d) => d.solve?.values?.length).map((d) => `${d.type} (${d.solve!.values!.map((v) => v.key).join(", ")})`).join(", ")}`); return; }
        const v = typeof e.key === "string" ? values.find((x) => x.key === e.key) : values[0];
        if (!v) { bad(`key is one of ${values.map((x) => x.key).join(", ")}`); return; }
        if (!num(e.value)) { bad(`value is a number (${v.unit === "deg" ? "degrees" : "millimetres"})`); return; }
        const s = solveAssembly(work, ctx.defs, ctx.geo, { drives: [{ mate: m.id, key: v.key, value: e.value }], analyze: false });
        const info = s.mates.get(m.id), got = s.values.get(m.id)?.[v.key];
        const off = (x: number, y: number): number => (v.unit === "deg" ? Math.abs(((x - y + 540) % 360) - 180) : Math.abs(x - y));
        if (!info || info.state !== "ok" || got === undefined || off(got, e.value) > 1e-3) { bad(`"${m.name}" cannot be at ${v.key} ${e.value}${v.unit === "deg" ? "°" : " mm"}: ${info && info.message ? info.message : `the mates (or this mate's limits) stop it at ${got === undefined ? "its present value" : r3(got)}`}`); return; }
        take([...edits.setTransforms(work, s.transforms), ...edits.setMateValues(work, s.values)]);
        done.push(`moved "${m.name}" to ${v.key} ${e.value}${v.unit === "deg" ? "°" : " mm"}`);
        return;
      }
      default: bad(`unknown op "${e.op}" (${ASSEMBLY_OPS.join(", ")})`);
    }
  });
  if (problems.length) return empty();
  return { changes, inverse, done, problems, after: work, notes };
}
