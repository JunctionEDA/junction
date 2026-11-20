// selection-sets.ts — a selection kept by name, to have again later: the faces to shell, the edges of a seal, the
// holes of one pattern.  A set is an item of the document, so it is shared, stored and undone like any edit:
//
//   { id, type: "selection-set", name: "Seal edges", order,
//     picks: [["e", <body id>, <edge name>], ["f", <body id>, <face name>], ["v", …], ["p", "top"], ["d", <feature id>, "axis"]] }
//
// Geometry is kept by name (see "Geometry names" in CONTRACT.md), so a set follows the model through rebuilds;
// what no longer exists is left out when the set is selected, and counted.  `picks` is one value: a set is
// replaced whole, not merged.  Pure.
import { byOrder, newId, orderBetween, type Item, type ItemChange, type ItemDoc, type Json } from "../../../shared/itemdoc/itemdoc";

export const SELECTION_SET_TYPE = "selection-set";
export type StoredPick = ["f" | "e" | "v", string, string] | ["p", string] | ["d", string, string];
export interface SelectionSetItem extends Item { type: "selection-set"; name: string; order: string; picks: StoredPick[] }

/** The little of a viewport pick this needs (viewport/modelview.ts Pick). */
export interface PickLike { kind: string; body?: string; name?: string; plane?: string; featureId?: string; datum?: string }
const KIND: { [k: string]: "f" | "e" | "v" } = { face: "f", edge: "e", vertex: "v" };
const NAME: { [k: string]: "face" | "edge" | "vertex" } = { f: "face", e: "edge", v: "vertex" };

const isStored = (p: unknown): p is StoredPick => Array.isArray(p) && p.every((x) => typeof x === "string") && ((p.length === 3 && (p[0] === "f" || p[0] === "e" || p[0] === "v" || p[0] === "d")) || (p.length === 2 && p[0] === "p"));
export const isSelectionSet = (i: Item | undefined): i is SelectionSetItem => !!i && i.type === SELECTION_SET_TYPE && typeof i.name === "string" && Array.isArray(i.picks);

/** What of a selection a set can keep: geometry of parts, the default planes, reference geometry.  (A sketch's regions are not kept: their ids change when the sketch is redrawn.) */
export function packPicks(picks: readonly PickLike[]): StoredPick[] {
  const out: StoredPick[] = [], seen = new Set<string>();
  for (const p of picks) {
    const s: StoredPick | null = KIND[p.kind] && p.body && p.name ? [KIND[p.kind], p.body, p.name] : p.kind === "plane" && p.plane ? ["p", p.plane] : p.kind === "datum" && p.featureId && p.datum ? ["d", p.featureId, p.datum] : null;
    if (!s || seen.has(s.join("\u0000"))) continue;
    seen.add(s.join("\u0000")); out.push(s);
  }
  return out;
}

/** What the model has now, for a set to be checked against. */
export interface ModelNames { has(kind: "face" | "edge" | "vertex", body: string, name: string): boolean; hasPlane(plane: string): boolean; hasDatum(featureId: string, datum: string): boolean }

/** A set's picks that still exist, as selections, and how many are gone. */
export function unpackPicks(stored: readonly StoredPick[], model: ModelNames): { picks: PickLike[]; missing: number } {
  const picks: PickLike[] = []; let missing = 0;
  for (const s of stored) {
    if (!isStored(s)) { missing++; continue; }
    if (s[0] === "p") { if (model.hasPlane(s[1])) picks.push({ kind: "plane", plane: s[1] }); else missing++; continue; }
    if (s[0] === "d") { if (model.hasDatum(s[1], s[2])) picks.push({ kind: "datum", featureId: s[1], datum: s[2] }); else missing++; continue; }
    const kind = NAME[s[0]];
    if (model.has(kind, s[1], s[2])) picks.push({ kind, body: s[1], name: s[2] }); else missing++;
  }
  return { picks, missing };
}

export function selectionSets(doc: ItemDoc | null): SelectionSetItem[] {
  if (!doc) return [];
  const out: SelectionSetItem[] = [];
  for (const i of doc.items.values()) if (isSelectionSet(i)) out.push({ ...i, picks: i.picks.filter(isStored) });
  return byOrder(out);
}

/** A name nothing has yet: "Selection 1", "Selection 2", … */
export function nextSetName(doc: ItemDoc): string {
  const names = new Set(selectionSets(doc).map((s) => s.name.toLowerCase()));
  for (let n = 1; ; n++) if (!names.has(`selection ${n}`)) return `Selection ${n}`;
}

/** Keep a selection under a name.  A set with that name is replaced (its place in the list kept). */
export function saveSelectionSet(doc: ItemDoc, name: string, picks: readonly PickLike[]): { changes: ItemChange[]; kept: number; left: number } {
  const stored = packPicks(picks), clean = name.trim().slice(0, 80) || nextSetName(doc);
  if (!stored.length) return { changes: [], kept: 0, left: picks.length };
  const sets = selectionSets(doc), old = sets.find((s) => s.name.toLowerCase() === clean.toLowerCase());
  const left = picks.length - stored.length;
  if (old) return { changes: [{ id: old.id, kind: "MODIFIED", typeName: SELECTION_SET_TYPE, props: [{ path: ["picks"], value: stored as unknown as Json }, ...(old.name !== clean ? [{ path: ["name"], value: clean }] : [])] }], kept: stored.length, left };
  const item: SelectionSetItem = { id: newId(), type: SELECTION_SET_TYPE, name: clean, order: orderBetween(sets.length ? sets[sets.length - 1].order : null, null), picks: stored };
  return { changes: [{ id: item.id, kind: "ADDED", typeName: SELECTION_SET_TYPE, item }], kept: stored.length, left };
}

export function removeSelectionSet(doc: ItemDoc, id: string): ItemChange[] {
  const s = doc.items.get(id);
  return isSelectionSet(s) ? [{ id, kind: "REMOVED", typeName: SELECTION_SET_TYPE }] : [];
}

export function renameSelectionSet(doc: ItemDoc, id: string, name: string): ItemChange[] {
  const s = doc.items.get(id), clean = name.trim().slice(0, 80);
  return isSelectionSet(s) && clean && clean !== s.name ? [{ id, kind: "MODIFIED", typeName: SELECTION_SET_TYPE, props: [{ path: ["name"], value: clean }] }] : [];
}

// ---------------------------------------------------------------- the selection filter
/** The kinds of thing a click may select, in the order the filter lists them. */
export const SELECT_KINDS: readonly { id: string; title: string }[] = [
  { id: "face", title: "Faces" }, { id: "edge", title: "Edges" }, { id: "vertex", title: "Vertices" },
  { id: "sketch", title: "Sketches" }, { id: "plane", title: "Planes" }, { id: "datum", title: "Reference geometry" },
];
/** A filter as stored in the interface state: null (everything) or the kinds allowed; nonsense reads as everything. */
export function cleanFilter(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const kinds = SELECT_KINDS.map((k) => k.id).filter((k) => v.includes(k));
  return kinds.length && kinds.length < SELECT_KINDS.length ? kinds : null;
}
/** Turn one kind on or off.  Taking the last one away gives everything back: a filter that selects nothing is a trap. */
export function toggleKind(filter: readonly string[] | null, kind: string): string[] | null {
  const all = SELECT_KINDS.map((k) => k.id), now = filter ? filter.slice() : all;
  return cleanFilter(now.includes(kind) ? now.filter((k) => k !== kind) : [...now, kind]);
}
/** "All", "Faces", "Faces, Edges", "4 kinds". */
export function filterLabel(filter: readonly string[] | null): string {
  if (!filter) return "All";
  const titles = SELECT_KINDS.filter((k) => filter.includes(k.id)).map((k) => k.title);
  return titles.length <= 2 ? titles.join(", ") : `${titles.length} kinds`;
}
