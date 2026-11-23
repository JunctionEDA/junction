// extras.ts — more of the assembly document, as item changes like document/edits.ts (nothing is applied here).
// Every item type and key below is optional and is ignored, and kept, by a reader that does not know it:
//
//   relation   a relation between two mate values (model/relations.ts: gear, rack, screw, linear)
//              { id, type: "relation", relationType, name, order, a: { mate, key }, b: { mate, key }, params, suppressed? }
//   pattern    a linear or circular instance pattern: copies that go where their seed goes
//              { id, type: "pattern", patternType: "linear" | "circular", name, order, seeds: [instance ids],
//                count, spacing? (mm), angle? (degrees between two copies),
//                frames: { <seed id>: { d: [x, y, z] } | { o: [x, y, z], z: [x, y, z] } }, suppressed? }
//              `frames` is the direction (linear) or the axis (circular) in EACH SEED'S OWN SPACE, so a copy is a
//              fixed placement relative to its seed: the pattern moves with the seed as one rigid thing.
//              A copy is an ordinary instance (so any reader shows it, where the solver last put it) that also
//              carries `pattern: <id>`, `seed: <instance id>`, `index: 1 … count − 1`.
//   explode    a saved exploded view: how far each instance is pulled from its place, in assembly space
//              { id, type: "explode", name, order, offsets: { <instance id>: [x, y, z] } }
//
// Also here: putting instances in another place of the list, and in or out of a folder (a `group` item).
import { addedChange, byOrder, modifiedChange, newId, orderBetween, removedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import { applyPose, compose, inverse, poseOf, qaxis, qconj, qrot, transformOf, unit, type Pose } from "../solver/math";
import type { Vec3 } from "../../mechanical/api";
import { deleteItems, freeName, groupsOf, isGroup, numberedName, type GroupItem } from "./edits";
import { instancesOf, isInstance, transformOf as storedTransform, type InstanceItem } from "./format";

const last = (items: { order?: string }[]): string | null => (items.length ? items[items.length - 1].order || null : null);
function ofType<T extends Item & { order?: string }>(doc: ItemDoc, test: (i: Item | undefined) => i is T): T[] { const out: T[] = []; for (const i of doc.items.values()) if (test(i)) out.push(i); return byOrder(out as (T & { id: string })[]); }
function modify<T extends Item>(doc: ItemDoc, id: string, patch: (item: T) => T): ItemChange[] {
  const before = doc.items.get(id) as T | undefined;
  if (!before) return [];
  const c = modifiedChange(before, patch({ ...before }));
  return c ? [c] : [];
}
const clean = (v: number): number => { const r = Math.round(v * 1e9) / 1e9; return Object.is(r, -0) ? 0 : r; };
const vec = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? [v[0] as number, v[1] as number, v[2] as number] : null);

// ---------------------------------------------------------------- relations
export interface RelationEnd extends JsonObject { mate: string; key: string }
export interface RelationItem extends Item { type: "relation"; relationType: string; name: string; order: string; a: RelationEnd; b: RelationEnd; params: JsonObject; suppressed?: boolean }
export const isRelation = (i: Item | undefined): i is RelationItem => !!i && i.type === "relation" && typeof i.relationType === "string" && !!i.a && !!i.b;
export const relationsOf = (doc: ItemDoc): RelationItem[] => ofType(doc, isRelation);

export function addRelation(doc: ItemDoc, r: { relationType: string; name?: string; title?: string; a: RelationEnd; b: RelationEnd; params: JsonObject }): { changes: ItemChange[]; item: RelationItem } {
  const all = relationsOf(doc);
  const item: RelationItem = { id: newId(), type: "relation", relationType: r.relationType, name: r.name || numberedName(all.map((x) => x.name), r.title || "Relation"), order: orderBetween(last(all), null), a: r.a, b: r.b, params: r.params };
  return { changes: [addedChange(item)], item };
}
export const updateRelation = (doc: ItemDoc, id: string, patch: Partial<Pick<RelationItem, "name" | "a" | "b" | "params">>): ItemChange[] => modify<RelationItem>(doc, id, (r) => ({ ...r, ...patch }));

// ---------------------------------------------------------------- rigid groups (the Group tool)
/**
 * Instances that keep their places relative to one another and move as one: { id, type: "rigid", name, order,
 * instances: [ids], places: { <id>: [12 numbers] } }, each place relative to the first instance of the list as
 * the group was made.  (A `group` item, document/edits.ts, is a folder of the list and holds nothing together.)
 */
export interface RigidItem extends Item { type: "rigid"; name: string; order: string; instances: string[]; places: { [instance: string]: number[] }; suppressed?: boolean }
export const isRigid = (i: Item | undefined): i is RigidItem => !!i && i.type === "rigid" && Array.isArray(i.instances) && !!i.places;
export const rigidsOf = (doc: ItemDoc): RigidItem[] => ofType(doc, isRigid);
export function addRigid(doc: ItemDoc, ids: readonly string[], poses?: ReadonlyMap<string, Pose>, name?: string): { changes: ItemChange[]; item: RigidItem } | null {
  const list = ids.map((id) => doc.items.get(id)).filter(isInstance);
  if (list.length < 2) return null;
  const at = (i: InstanceItem): Pose => poses?.get(i.id) || poseOf(storedTransform(i));
  const inv = inverse(at(list[0])), places: { [id: string]: number[] } = {};
  for (const i of list) places[i.id] = transformOf(compose(inv, at(i))).map(clean);
  const all = rigidsOf(doc);
  const item: RigidItem = { id: newId(), type: "rigid", name: name || numberedName(all.map((x) => x.name), "Group"), order: orderBetween(last(all), null), instances: list.map((i) => i.id), places };
  return { changes: [addedChange(item)], item };
}

// ---------------------------------------------------------------- instance patterns
export interface PatternFrame extends JsonObject { d?: number[]; o?: number[]; z?: number[] }
export interface PatternItem extends Item {
  type: "pattern"; patternType: "linear" | "circular"; name: string; order: string; seeds: string[]; count: number;
  spacing?: number; angle?: number; frames: { [seed: string]: PatternFrame }; suppressed?: boolean;
}
export const isPattern = (i: Item | undefined): i is PatternItem => !!i && i.type === "pattern" && Array.isArray(i.seeds) && !!i.frames && typeof i.count === "number";
export const patternsOf = (doc: ItemDoc): PatternItem[] => ofType(doc, isPattern);
export const MAX_PATTERN = 200;

/** What makes an instance a copy of a pattern, or null. */
export function memberOf(i: InstanceItem): { pattern: string; seed: string; index: number } | null {
  return typeof i.pattern === "string" && typeof i.seed === "string" && typeof i.index === "number" && i.index >= 1 ? { pattern: i.pattern, seed: i.seed, index: i.index } : null;
}

/** Where copy `k` of a seed stands, in the seed's own space: the seed's pose times this is the copy's. */
export function patternOffset(p: PatternItem, seed: string, k: number): Pose | null {
  const f = p.frames[seed];
  if (!f) return null;
  if (p.patternType === "linear") {
    const d = vec(f.d); if (!d) return null;
    const s = (typeof p.spacing === "number" ? p.spacing : 0) * k, u = unit(d);
    return { p: [u[0] * s, u[1] * s, u[2] * s], q: [0, 0, 0, 1] };
  }
  const o = vec(f.o), z = vec(f.z); if (!o || !z) return null;
  const q = qaxis(unit(z), ((typeof p.angle === "number" ? p.angle : 0) * k * Math.PI) / 180), ro = qrot(q, o);
  return { p: [o[0] - ro[0], o[1] - ro[1], o[2] - ro[2]], q };
}

/** A direction (linear) or an axis (circular) given in assembly space, as each seed sees it where it stands now. */
export function patternFrames(doc: ItemDoc, seeds: readonly string[], at: { direction: Vec3 } | { origin: Vec3; axis: Vec3 }, poses?: ReadonlyMap<string, Pose>): { [seed: string]: PatternFrame } {
  const out: { [seed: string]: PatternFrame } = {};
  for (const id of seeds) {
    const i = doc.items.get(id); if (!isInstance(i)) continue;
    const pose = poses?.get(id) || poseOf(storedTransform(i)), inv = inverse(pose);
    out[id] = "direction" in at ? { d: qrot(qconj(pose.q), unit(at.direction)).map(clean) } : { o: applyPose(inv, at.origin).map(clean), z: qrot(inv.q, unit(at.axis)).map(clean) };
  }
  return out;
}

/** The copies a pattern should have and does not, the ones it has and should not, and the ones to keep. */
function patternMembers(doc: ItemDoc, p: PatternItem): { changes: ItemChange[]; items: InstanceItem[] } {
  const changes: ItemChange[] = [], items: InstanceItem[] = [];
  const all = instancesOf(doc), names = all.map((i) => i.name);
  const count = Math.max(1, Math.min(MAX_PATTERN, Math.floor(p.count)));
  const have = new Map<string, InstanceItem>();
  for (const i of all) { const m = memberOf(i); if (m && m.pattern === p.id) have.set(`${m.seed}|${m.index}`, i); }
  let order = last(all);
  for (const seedId of p.seeds) {
    const seed = doc.items.get(seedId); if (!isInstance(seed)) continue;
    const sp = poseOf(storedTransform(seed));
    for (let k = 1; k < count; k++) {
      const off = patternOffset(p, seedId, k); if (!off) continue;
      const t = transformOf(compose(sp, off)).map(clean), was = have.get(`${seedId}|${k}`);
      have.delete(`${seedId}|${k}`);
      if (was) {
        if (was.transform.some((v, n) => Math.abs(v - t[n]) > 1e-9)) changes.push({ id: was.id, kind: "MODIFIED", typeName: "instance", props: [{ path: ["transform"], value: t }] });
        items.push(was);
        continue;
      }
      order = orderBetween(order, null);
      const name = freeName(names, seed.name.replace(/ \d+$/, "") || seed.name); names.push(name);
      const item: InstanceItem = { id: newId(), type: "instance", name, order, source: { ...seed.source }, transform: t, pattern: p.id, seed: seedId, index: k };
      if (seed.hidden) item.hidden = true;
      changes.push(addedChange(item)); items.push(item);
    }
  }
  // the copies that are one too many go, with the mates and connectors that hang on them
  if (have.size) changes.push(...deleteItems(doc, Array.from(have.values(), (i) => i.id)));
  return { changes, items };
}

export interface NewPattern { patternType: "linear" | "circular"; seeds: string[]; count: number; spacing?: number; angle?: number; frames: { [seed: string]: PatternFrame }; name?: string }
export function addPattern(doc: ItemDoc, n: NewPattern): { changes: ItemChange[]; item: PatternItem; members: InstanceItem[] } {
  const all = patternsOf(doc);
  const item: PatternItem = {
    id: newId(), type: "pattern", patternType: n.patternType, name: n.name || numberedName(all.map((x) => x.name), n.patternType === "linear" ? "Linear pattern" : "Circular pattern"),
    order: orderBetween(last(all), null), seeds: n.seeds.filter((id) => { const i = doc.items.get(id); return isInstance(i) && !memberOf(i); }), count: Math.max(2, Math.min(MAX_PATTERN, Math.floor(n.count))), frames: n.frames,
  };
  if (n.patternType === "linear") item.spacing = n.spacing ?? 0; else item.angle = n.angle ?? 0;
  const made = patternMembers(doc, item);
  return { changes: [addedChange(item), ...made.changes], item, members: made.items };
}
/** Change a pattern's numbers: copies are added, taken away and moved to match. */
export function updatePattern(doc: ItemDoc, id: string, patch: { count?: number; spacing?: number; angle?: number; name?: string }): ItemChange[] {
  const p = doc.items.get(id);
  if (!isPattern(p)) return [];
  const next: PatternItem = { ...p, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as PatternItem;
  next.count = Math.max(2, Math.min(MAX_PATTERN, Math.floor(next.count)));
  const c = modifiedChange(p, next);
  return [...(c ? [c] : []), ...patternMembers(doc, next).changes];
}
/** Take a pattern apart: its copies stay as plain instances where they are. */
export function dissolvePattern(doc: ItemDoc, id: string): ItemChange[] {
  const p = doc.items.get(id);
  if (!isPattern(p)) return [];
  const out: ItemChange[] = [];
  for (const i of instancesOf(doc)) if (i.pattern === id) out.push(...modify(doc, i.id, (x) => { const o = { ...x } as JsonObject; delete o.pattern; delete o.seed; delete o.index; return o as Item; }));
  out.push(removedChange(p));
  return out;
}

// ---------------------------------------------------------------- saved exploded views
export interface ExplodeItem extends Item { type: "explode"; name: string; order: string; offsets: { [instance: string]: number[] } }
export const isExplode = (i: Item | undefined): i is ExplodeItem => !!i && i.type === "explode" && !!i.offsets && typeof i.offsets === "object";
export const explodesOf = (doc: ItemDoc): ExplodeItem[] => ofType(doc, isExplode);
const offsetsJson = (offsets: ReadonlyMap<string, readonly number[]>): { [id: string]: number[] } => { const o: { [id: string]: number[] } = {}; for (const [id, v] of offsets) if (v.some((x) => Math.abs(x) > 1e-9)) o[id] = v.map((x) => Math.round(x * 1e6) / 1e6); return o; };
export function addExplode(doc: ItemDoc, offsets: ReadonlyMap<string, readonly number[]>, name?: string): { changes: ItemChange[]; item: ExplodeItem } {
  const all = explodesOf(doc);
  const item: ExplodeItem = { id: newId(), type: "explode", name: name || numberedName(all.map((x) => x.name), "Exploded view"), order: orderBetween(last(all), null), offsets: offsetsJson(offsets) };
  return { changes: [addedChange(item)], item };
}
export const updateExplode = (doc: ItemDoc, id: string, offsets: ReadonlyMap<string, readonly number[]>): ItemChange[] => modify<ExplodeItem>(doc, id, (e) => ({ ...e, offsets: offsetsJson(offsets) }));

// ---------------------------------------------------------------- the order of the list, and folders
/** An empty folder at the end of the list. */
export function addFolder(doc: ItemDoc, name?: string): { changes: ItemChange[]; group: GroupItem } {
  const groups = groupsOf(doc);
  const group: GroupItem = { id: newId(), type: "group", name: name || numberedName(groups.map((g) => g.name), "Folder"), order: orderBetween(last(instancesOf(doc)), null) };
  return { changes: [addedChange(group)], group };
}
/**
 * Put instances before another instance of the list (null: at the end), in the order given, and in `group`
 * (a folder's id; null: out of any folder; undefined: the folder of the instance they are put before).
 */
export function moveInstances(doc: ItemDoc, ids: readonly string[], before: string | null, group?: string | null): ItemChange[] {
  const moving = new Set(ids), rest = instancesOf(doc).filter((i) => !moving.has(i.id));
  const at = before ? rest.findIndex((i) => i.id === before) : -1;
  const next = at >= 0 ? rest[at] : null;
  let prev = at >= 0 ? (at > 0 ? rest[at - 1].order : null) : last(rest);
  const into = group !== undefined ? group : next && typeof next.group === "string" ? next.group : null;
  if (into && !isGroup(doc.items.get(into))) return [];
  const out: ItemChange[] = [];
  for (const id of ids) {
    const order: string = orderBetween(prev, next ? next.order : null);
    prev = order;
    out.push(...modify<InstanceItem>(doc, id, (i) => { const o = { ...i, order } as InstanceItem; if (into) o.group = into; else delete o.group; return o; }));
  }
  return out;
}
