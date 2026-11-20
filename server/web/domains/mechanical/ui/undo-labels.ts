// undo-labels.ts — what a step of the undo history did, in a few words ("Add Extrude 1", "Edit Sketch 2", "Delete
// Fillet 1").  A step is the item changes it made and the ones that take it back (shared/itemdoc/sync.ts
// UndoEntry); the words are worked out from those alone, with the document as it is now for the names of things
// that are still there.  Pure.
import type { Item, ItemChange, ItemDoc } from "../../../shared/itemdoc/itemdoc";

export interface StepLike { undo: readonly ItemChange[]; redo: readonly ItemChange[]; at?: number }

const KINDS: { [type: string]: string } = { variable: "variable", folder: "folder", "named-view": "view", "selection-set": "selection set", "section-view": "section view", "board-link": "board link" };
const nameOf = (item: Item | undefined): string => (item && typeof item.name === "string" && item.name ? item.name : "");
const thing = (item: Item | undefined, fallback: string): string => {
  if (!item) return fallback;
  const n = nameOf(item);
  if (item.type === "feature") return n || "a feature";
  const kind = KINDS[item.type] || item.type;
  return n ? `${kind} ${n}` : `a ${kind}`;
};

/** What one change did.  `before` is the item as it was when a change removed it (from the step's undo). */
function describeChange(c: ItemChange, doc: ItemDoc | null, before: Item | undefined): string {
  const now = doc?.items.get(c.id);
  if (c.kind === "ADDED") return c.item.type === "folder" ? `New ${thing(c.item, "folder")}` : `Add ${thing(c.item, "an item")}`;
  if (c.kind === "REMOVED") return `Delete ${thing(before, thing(now, "an item"))}`;
  const paths = c.props.map((p) => p.path), has = (...start: string[]) => paths.some((p) => start.every((k, i) => p[i] === k));
  const set = (key: string) => c.props.find((p) => p.path.length === 1 && p.path[0] === key);
  const type = c.typeName || now?.type || "";
  if (c.id === "studio" || type === "studio") {
    if (has("rollback")) return "Move the rollback bar";
    if (has("units") || has("angleUnits") || has("precision")) return "Change the units";
    if (has("planeSizes")) return "Resize a plane";
    return "Change the part studio";
  }
  if (type === "feature" || (now && now.type === "feature")) {
    const n = nameOf(now) || "a feature";
    const renamed = set("name");
    if (renamed && paths.length === 1) return `Rename to ${String(renamed.value)}`;
    const sup = set("suppressed");
    if (sup && paths.length === 1) return sup.del || !sup.value ? `Unsuppress ${n}` : `Suppress ${n}`;
    if (has("suppressIf") && paths.length === 1) return `Change when ${n} is suppressed`;
    if (paths.every((p) => p[0] === "order" || p[0] === "folder")) return `Move ${n}`;
    if (has("params", "sketch")) return `Edit ${n}`;
    if (has("params")) return `Edit ${n}`;
    return `Change ${n}`;
  }
  if (type === "parts" || c.id === "parts") return has("names") ? "Rename a part" : "Change a part's properties";
  if (type === "appearance" || c.id === "appearance") return "Change an appearance";
  if (type === "variable") { const r = set("name"); return r ? `Rename a variable to ${String(r.value)}` : `Change ${thing(now, "a variable")}`; }
  if (type === "folder") { const r = set("name"); return r ? `Rename a folder to ${String(r.value)}` : has("suppressed") ? `Suppress ${thing(now, "a folder")}` : `Change ${thing(now, "a folder")}`; }
  return `Change ${thing(now, type ? `a ${KINDS[type] || type}` : "an item")}`;
}

/** A step in a few words.  The first change that says most leads; the rest are counted. */
export function describeStep(step: StepLike, doc: ItemDoc | null = null): string {
  const changes = step.redo;
  if (!changes.length) return "Nothing";
  const removed = new Map<string, Item>();
  for (const u of step.undo) if (u.kind === "ADDED") removed.set(u.id, u.item);
  // an added or removed feature says what the step was for; the changes that came with it (a rollback bar
  // moved along, an order key, a stored number that follows a variable) do not
  const rank = (c: ItemChange): number => (c.kind !== "MODIFIED" ? (((c.kind === "ADDED" ? c.item.type : removed.get(c.id)?.type) === "feature") ? 0 : 1) : c.typeName === "variable" || c.typeName === "folder" ? 2 : c.id === "studio" ? 4 : 3);
  const sorted = changes.slice().sort((a, b) => rank(a) - rank(b));
  const lead = sorted[0];
  const text = describeChange(lead, doc, removed.get(lead.id));
  const same = sorted.filter((c) => c.kind === lead.kind && rank(c) === rank(lead));
  if (same.length > 1 && lead.kind !== "MODIFIED") return `${lead.kind === "ADDED" ? "Add" : "Delete"} ${same.length} ${lead.kind === "ADDED" && lead.item.type !== "feature" ? "items" : (lead.kind === "REMOVED" && removed.get(lead.id)?.type !== "feature") ? "items" : "features"}`;
  if (same.length > 1 && lead.kind === "MODIFIED" && /^(Move|Suppress|Unsuppress) /.test(text)) return `${text.split(" ")[0]} ${same.length} features`;
  return text;
}

/** "2 min ago", "just now": when a step was made. */
export function ago(at: number | undefined, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}

/** How many undos (positive) or redos (negative) bring the document to just after step `index` of `done.length + undone.length`. */
export function stepsTo(done: number, index: number): number { return done - 1 - index; }
