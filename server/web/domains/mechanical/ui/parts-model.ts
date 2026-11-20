// parts-model.ts — what the parts list (ui/PartsList.tsx) shows and offers, worked out apart from React so that it
// can be tested: the entries and their sections, which rows a click selects, which features made or changed a
// part, and the menu for a set of rows.  Pure: no document, no viewport.
//
//   sections     Parts · Surfaces · Curves · Composite parts, each with its count; an empty one is left out
//   an entry     a body (a part, a surface, a composite part) or a curve (reference geometry of kind "curve";
//                its id is `curve:<feature id>`, document/part-items.ts)
//
// Junction has no mesh bodies (an import is always read into exact solids), so there is no Meshes section.
import { curveEntryId } from "../document/part-items";

export type PartKind = "part" | "surface" | "curve" | "composite";

export interface PartEntry {
  /** a body's id, or `curve:<feature id>` */
  id: string;
  kind: PartKind;
  name: string;
  /** the body, for every kind but a curve */
  body: string | null;
  /** the feature that made it */
  featureId: string;
  /** a body that is there to be referred to (a board, an open composite): it has no material and is not deleted */
  reference: boolean;
}

export interface PartSection { kind: PartKind; title: string; /** one of them, for a menu or a tooltip */ one: string; entries: PartEntry[]; /** what the heading counts: a reference body is listed but is no part */ count: number }

export const SECTIONS: readonly { kind: PartKind; title: string; one: string }[] = [
  { kind: "part", title: "Parts", one: "part" },
  { kind: "surface", title: "Surfaces", one: "surface" },
  { kind: "curve", title: "Curves", one: "curve" },
  { kind: "composite", title: "Composite parts", one: "composite part" },
];

/** The feature type whose body is a composite part (features/composite-part.ts). */
export const COMPOSITE_FEATURE = "composite-part";

export interface BodyLike { id: string; name: string; createdBy: string; reference?: boolean; sheet?: boolean }
export interface DatumLike { featureId: string; kind: string }
export interface FeatureLike { id: string; name: string; featureType: string; params?: unknown }

/** The sections of the list, in order, from what the model holds.  `names`: the names people gave (by entry id). */
export function sectionsOf(bodies: readonly BodyLike[], datums: readonly DatumLike[], features: readonly FeatureLike[], names: { readonly [entryId: string]: string } = {}): PartSection[] {
  const byId = new Map(features.map((f) => [f.id, f]));
  const entries: PartEntry[] = [];
  for (const b of bodies) {
    const kind: PartKind = byId.get(b.createdBy)?.featureType === COMPOSITE_FEATURE ? "composite" : b.sheet ? "surface" : "part";
    entries.push({ id: b.id, kind, name: names[b.id] || b.name, body: b.id, featureId: b.createdBy, reference: !!b.reference });
  }
  // curves in the order of the features that made them
  const order = new Map(features.map((f, i) => [f.id, i]));
  for (const d of datums.filter((x) => x.kind === "curve").sort((a, b) => (order.get(a.featureId) ?? 1e9) - (order.get(b.featureId) ?? 1e9))) {
    const id = curveEntryId(d.featureId);
    entries.push({ id, kind: "curve", name: names[id] || byId.get(d.featureId)?.name || "Curve", body: null, featureId: d.featureId, reference: false });
  }
  const out: PartSection[] = [];
  for (const s of SECTIONS) {
    const mine = entries.filter((e) => e.kind === s.kind);
    if (mine.length) out.push({ ...s, entries: mine, count: mine.filter((e) => !e.reference).length || mine.length });
  }
  return out;
}

/** Every entry, in the order the list shows them. */
export const entriesOf = (sections: readonly PartSection[]): PartEntry[] => sections.flatMap((s) => s.entries);

// ---------------------------------------------------------------- selection
export interface PickLike { kind: string; body?: string; featureId?: string }

/** The entries a selection in the model is on: a body by any of its faces, edges or vertices, a curve by itself. */
export function selectedEntryIds(entries: readonly PartEntry[], selection: readonly PickLike[]): string[] {
  const bodies = new Set<string>(), curves = new Set<string>();
  for (const p of selection) {
    if ((p.kind === "face" || p.kind === "edge" || p.kind === "vertex") && p.body) bodies.add(p.body);
    else if (p.kind === "datum" && p.featureId) curves.add(p.featureId);
  }
  return entries.filter((e) => (e.body ? bodies.has(e.body) : curves.has(e.featureId))).map((e) => e.id);
}

/**
 * The rows selected after a click on row `id`.  A plain click selects that row alone (and takes the selection
 * away when it was the only one selected); `toggle` (Ctrl) adds or removes it; `range` (Shift) takes every row
 * from the anchor (the row clicked last without Shift) to this one, in the order shown.
 */
export function clickSelection(order: readonly string[], selected: readonly string[], anchor: string | null, id: string, mod: { toggle?: boolean; range?: boolean } = {}): { selected: string[]; anchor: string | null } {
  if (mod.range && anchor && order.includes(anchor) && order.includes(id)) {
    const a = order.indexOf(anchor), b = order.indexOf(id);
    const span = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    return { selected: mod.toggle ? Array.from(new Set([...selected, ...span])) : span, anchor };
  }
  if (mod.toggle) return { selected: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], anchor: id };
  if (selected.length === 1 && selected[0] === id) return { selected: [], anchor: id };
  return { selected: [id], anchor: id };
}

/** The rows a menu opened on row `id` acts on: every selected row when it is one of them, else that row alone. */
export const menuTargets = (selected: readonly string[], id: string): string[] => (selected.includes(id) && selected.length > 1 ? selected.slice() : [id]);

// ---------------------------------------------------------------- which features made a part
/**
 * The features that made or changed an entry, and the ones those take as input (the sketch an extrude used).
 * A body says who shaped it in the names of its faces (CONTRACT.md "Geometry names": a face carries the id of
 * every feature it came through), in its own id and in `createdBy`.
 */
export function featuresOfEntry(entry: PartEntry, faceNames: readonly string[], features: readonly FeatureLike[]): string[] {
  const direct = new Set<string>();
  for (const f of features) {
    if (f.id === entry.featureId || (entry.body && entry.body.includes(f.id))) { direct.add(f.id); continue; }
    if (entry.body && faceNames.some((n) => n.includes(f.id))) direct.add(f.id);
  }
  const out = new Set(direct);
  const texts = features.filter((f) => direct.has(f.id)).map((f) => JSON.stringify(f.params ?? null));
  for (const f of features) if (!out.has(f.id) && texts.some((t) => t.includes(f.id))) out.add(f.id);
  return features.filter((f) => out.has(f.id)).map((f) => f.id);
}

// ---------------------------------------------------------------- the menu
export type PartCommand =
  | "rename" | "properties" | "material" | "appearance" | "transform" | "export"
  | "hide" | "show" | "hide-others" | "hide-all" | "show-all" | "isolate" | "unisolate"
  | "transparent" | "opaque" | "centre-show" | "centre-hide" | "comment" | "zoom" | "delete";

export interface PartMenuItem { id: PartCommand; label: string; key?: string; danger?: boolean; /** why it cannot run now: the item is greyed and says so */ why?: string | null }

export interface PartMenuContext {
  targets: readonly PartEntry[];
  /** how many entries the list holds */
  total: number;
  canEdit: boolean;
  /** a dialog or a sketch is open: nothing that starts a feature can run */
  busy: boolean;
  /** why a comment cannot be started (signed out, view-only), or null */
  commentWhy: string | null;
  visible(id: string): boolean;
  /** something in the list is hidden, or parts are isolated */
  anyHidden: boolean;
  /** the bodies shown alone, or null */
  isolated: readonly string[] | null;
  transparent(id: string): boolean;
  hasMaterial(id: string): boolean;
  /** the centre of mass is marked in the model */
  centreShown: boolean;
}

/** The menu for these rows: what applies to them, in order; null is a rule between groups. */
export function partMenu(c: PartMenuContext): (PartMenuItem | null)[] {
  const t = c.targets, many = t.length > 1;
  if (!t.length) return [];
  const bodies = t.filter((e) => e.body), own = bodies.filter((e) => !e.reference);
  const solids = own.filter((e) => e.kind === "part" || e.kind === "composite");
  const what = many ? `${t.length} items` : SECTIONS.find((s) => s.kind === t[0].kind)!.one;
  const edit = !c.canEdit ? "You have view-only access" : null;
  const start = edit || (c.busy ? "Finish the open dialog or sketch first" : null);
  const out: (PartMenuItem | null)[] = [];
  const add = (item: PartMenuItem) => out.push(item);
  const rule = () => { if (out.length && out[out.length - 1]) out.push(null); };

  if (!many && !t[0].reference) add({ id: "rename", label: "Rename", key: "F2", why: edit });
  if (!many) add({ id: "properties", label: "Properties…" });
  if (solids.length && solids.length === t.length) add({ id: "material", label: "Assign material…", why: edit });
  if (bodies.length && bodies.length === t.length) add({ id: "appearance", label: "Edit appearance…", why: edit });
  rule();
  if (own.length && own.length === t.length) add({ id: "transform", label: "Move or copy…", why: start });
  if (bodies.length && bodies.length === t.length) add({ id: "export", label: "Export…", why: c.busy ? "Finish the open dialog or sketch first" : null });
  rule();
  const shown = t.filter((e) => c.visible(e.id)).length;
  if (shown) add({ id: "hide", label: "Hide", key: many ? undefined : "H" });
  if (shown < t.length) add({ id: "show", label: "Show" });
  if (c.total > t.length) add({ id: "hide-others", label: many ? "Hide others" : "Hide other items" });
  add({ id: "hide-all", label: "Hide all" });
  if (c.anyHidden) add({ id: "show-all", label: "Show all" });
  if (bodies.length && bodies.length === t.length) {
    const iso = c.isolated, same = !!iso && iso.length === bodies.length && bodies.every((e) => iso.includes(e.body!));
    add(same ? { id: "unisolate", label: "Exit isolate" } : { id: "isolate", label: "Isolate", key: many ? undefined : "I" });
    const through = bodies.every((e) => c.transparent(e.id));
    add(through ? { id: "opaque", label: "Make opaque" } : { id: "transparent", label: "Make transparent" });
  }
  if (solids.length && solids.length === t.length) {
    const without = solids.filter((e) => !c.hasMaterial(e.id)).length;
    add(c.centreShown ? { id: "centre-hide", label: "Hide centre of mass" } : { id: "centre-show", label: "Show centre of mass", why: without ? (many ? "Give every part a material first" : "Give the part a material first") : null });
  }
  rule();
  if (!many) add({ id: "comment", label: "Add comment…", why: c.commentWhy });
  add({ id: "zoom", label: "Zoom to selection", key: many ? undefined : "Z" });
  if (own.length && own.length === t.length) { rule(); add({ id: "delete", label: `Delete ${what}…`, key: "Del", danger: true, why: start }); }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}
