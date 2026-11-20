// part-items.ts — what a person says about the entries of the parts list (parts, surfaces, composite parts and
// curves): the name they gave one, and its properties.  Pure: reads the document and returns item changes, like
// edits.ts.
//
//   { id: "parts", type: "parts",
//     names: { "<entry id>": "Bracket", … },
//     props: { "<entry id>": { description: "Holds the motor", fields: { "Vendor": "Acme" } }, … } }
//
// An entry id is a body's id (kernel/types.ts Body.id: stable across rebuilds), or `curve:<feature id>` for a
// curve, which is no body.  A body with no name here keeps the one the kernel gave it ("Part 1", or its
// feature's); a curve's is its feature's.  Both maps are keyed by entry, and a property's fields by their label,
// so two people naming or describing different parts at once both win, and a rename is one path.  An entry that
// no longer exists keeps its lines: the part may come back (undo, the rollback bar), and they cost nothing.
import { addedChange, clone, modifiedChange, type Item, type ItemChange, type ItemDoc, type JsonObject } from "../../../shared/itemdoc/itemdoc";

export const PARTS_ITEM_ID = "parts";
/** the longest name and the longest text of a property that are kept */
export const MAX_PART_NAME = 120, MAX_PART_TEXT = 2000, MAX_PART_FIELDS = 24;

export interface PartProps extends JsonObject { description?: string; fields?: { [label: string]: string } }
export interface PartsItem extends Item { type: "parts"; names: { [entryId: string]: string }; props: { [entryId: string]: PartProps } }

/** The entry id of the curve a feature made. */
export const curveEntryId = (featureId: string): string => `curve:${featureId}`;

const cleanName = (name: unknown): string => (typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, MAX_PART_NAME) : "");

/** The names people gave, by entry id.  Nonsense in the file is not taken. */
export function partNamesOf(doc: ItemDoc | null): { [entryId: string]: string } {
  const it = doc?.items.get(PARTS_ITEM_ID) as PartsItem | undefined;
  const out: { [entryId: string]: string } = {};
  if (!it || it.type !== "parts" || !it.names || typeof it.names !== "object") return out;
  for (const [id, n] of Object.entries(it.names)) { const name = cleanName(n); if (name) out[id] = name; }
  return out;
}

function cleanProps(raw: unknown): PartProps {
  const out: PartProps = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as PartProps;
  if (typeof r.description === "string" && r.description.trim()) out.description = r.description.slice(0, MAX_PART_TEXT);
  if (r.fields && typeof r.fields === "object") {
    const fields: { [label: string]: string } = {};
    for (const [k, v] of Object.entries(r.fields).slice(0, MAX_PART_FIELDS)) { const label = cleanName(k); if (label && typeof v === "string") fields[label] = v.slice(0, MAX_PART_TEXT); }
    if (Object.keys(fields).length) out.fields = fields;
  }
  return out;
}

/** Every entry's properties as stored, cleaned. */
export function partPropsOf(doc: ItemDoc | null): { [entryId: string]: PartProps } {
  const it = doc?.items.get(PARTS_ITEM_ID) as PartsItem | undefined;
  const out: { [entryId: string]: PartProps } = {};
  if (!it || it.type !== "parts" || !it.props || typeof it.props !== "object") return out;
  for (const [id, raw] of Object.entries(it.props)) { const p = cleanProps(raw); if (Object.keys(p).length) out[id] = p; }
  return out;
}

function edit(doc: ItemDoc, fn: (item: PartsItem) => void): ItemChange[] {
  const now = doc.items.get(PARTS_ITEM_ID) as PartsItem | undefined;
  const next: PartsItem = now ? clone(now) : { id: PARTS_ITEM_ID, type: "parts", names: {}, props: {} };
  if (!next.names || typeof next.names !== "object") next.names = {};
  if (!next.props || typeof next.props !== "object") next.props = {};
  fn(next);
  if (!now) return Object.keys(next.names).length || Object.keys(next.props).length ? [addedChange(next)] : [];
  const c = modifiedChange(now, next);
  return c ? [c] : [];
}

export interface PartPatch {
  /** the new name; empty, or equal to `fallback` (what the entry is called without a name of its own), takes the person's name away */
  name?: string; fallback?: string;
  /** "" removes it */
  description?: string;
  /** label → text; null removes a field */
  fields?: { [label: string]: string | null };
}

/** Change an entry's name and properties in one step.  Keys left out are left alone. */
export function updatePart(doc: ItemDoc, entryId: string, patch: PartPatch): ItemChange[] {
  if (!entryId) return [];
  return edit(doc, (it) => {
    if (patch.name !== undefined) { const clean = cleanName(patch.name); if (!clean || clean === (patch.fallback || "")) delete it.names[entryId]; else it.names[entryId] = clean; }
    if (patch.description === undefined && !patch.fields) return;
    const p: PartProps = { ...(it.props[entryId] || {}) };
    if (patch.description !== undefined) { if (patch.description.trim()) p.description = patch.description.slice(0, MAX_PART_TEXT); else delete p.description; }
    if (patch.fields) {
      const fields = { ...(p.fields || {}) };
      for (const [k, v] of Object.entries(patch.fields)) { const label = cleanName(k); if (!label) continue; if (v === null) delete fields[label]; else if (Object.keys(fields).length < MAX_PART_FIELDS || label in fields) fields[label] = v.slice(0, MAX_PART_TEXT); }
      if (Object.keys(fields).length) p.fields = fields; else delete p.fields;
    }
    if (Object.keys(p).length) it.props[entryId] = p; else delete it.props[entryId];
  });
}

/** Name an entry (see PartPatch.name). */
export const renamePart = (doc: ItemDoc, entryId: string, name: string, fallback = ""): ItemChange[] => updatePart(doc, entryId, { name, fallback });

/** Set an entry's properties (see PartPatch). */
export const setPartProps = (doc: ItemDoc, entryId: string, patch: { description?: string; fields?: { [label: string]: string | null } }): ItemChange[] => updatePart(doc, entryId, patch);

/**
 * The bodies under the names people gave them.  Everything that shows a part studio's bodies by name (its own
 * page, an assembly, an export) passes the worker's result through this.  The same array comes back when no
 * body has a name of its own, and an unnamed body keeps its object.
 */
export function namedBodies<B extends { id: string; name: string }>(doc: ItemDoc | null, bodies: readonly B[]): B[] {
  const names = partNamesOf(doc);
  if (!bodies.some((b) => names[b.id] && names[b.id] !== b.name)) return bodies as B[];
  return bodies.map((b) => (names[b.id] && names[b.id] !== b.name ? { ...b, name: names[b.id] } : b));
}
