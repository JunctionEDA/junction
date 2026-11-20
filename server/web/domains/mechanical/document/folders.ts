// folders.ts — folders of the feature list, moving several features at once, and when a feature is suppressed.
//
// A folder is an item of the `.jpart` (CONTRACT.md "Unknown items": an older reader keeps it):
//
//   { id, type: "folder", name: "Mounting holes", parent?: <folder id>, suppressed?: true, suppressIf?: "<condition>" }
//
// and a feature says which folder it is in with `folder: <folder id>` (its innermost one; a folder's `parent`
// nests it).  A folder has no place of its own in the list: it is drawn where its features are.  THE BUILD
// ORDER IS ALWAYS THE FEATURES' `order`, folders or not, so every reader that ignores folders builds the same
// model.  The edits here keep a folder's features next to each other.  When they are not (two people moved
// things at once, a tool that knows no folders moved one), `featureTree` shows the first run of them as the
// folder and the stragglers outside it, where they are built; nothing is lost and nothing is reordered.
//
// Suppression.  A feature is not built when it is suppressed itself (`suppressed`), when its condition holds
// (`suppressIf`, dynamic suppression: document/conditions.ts, evaluated with the document's variables), or when
// a folder around it is suppressed either way.  A folder is suppressed as one thing: its features keep their
// own `suppressed`, so unsuppressing the folder leaves the ones that were suppressed singly as they were.
// `suppressionOf` is the one place that is worked out; document/inputs.ts applies it for every builder.
//
// Every function returns item changes and applies nothing (commit them with `studio.commit`).
import { addedChange, newId, orderBetween, removedChange, type Item, type ItemChange, type ItemDoc, type PropChange } from "../../../shared/itemdoc/itemdoc";
import { evaluateCondition } from "./conditions";
import { STUDIO_ITEM_ID, featuresOf, isFeature, studioOf, type FeatureItem, type StudioItem } from "./format";
import type { Lookup } from "./variables";

export const FOLDER_TYPE = "folder";
export interface FolderItem extends Item { type: "folder"; name: string; parent?: string; suppressed?: boolean; suppressIf?: string }

export const isFolder = (i: Item | undefined): i is FolderItem => !!i && i.type === FOLDER_TYPE && typeof i.name === "string";

export function foldersOf(doc: ItemDoc): Map<string, FolderItem> {
  const out = new Map<string, FolderItem>();
  for (const i of doc.items.values()) if (isFolder(i)) out.set(i.id, i);
  return out;
}

// ---------------------------------------------------------------- the tree

export interface FolderNode { kind: "folder"; folder: FolderItem; depth: number; parent: string | null; children: TreeNode[]; /** its features are features[first .. last] */ first: number; last: number }
export interface FeatureNode { kind: "feature"; feature: FeatureItem; index: number; depth: number; parent: string | null }
export type TreeNode = FolderNode | FeatureNode;
export interface FeatureTree {
  roots: TreeNode[];
  /** folder id → its node (a folder with no feature in it has none) */
  nodes: Map<string, FolderNode>;
  /** feature id → the folders it is shown in, outermost first */
  paths: Map<string, string[]>;
}

/** The folders an item says it is in, outermost first; a folder that is gone, or a ring of parents, ends the chain. */
function chain(start: unknown, folders: ReadonlyMap<string, FolderItem>): string[] {
  const out: string[] = [], seen = new Set<string>();
  let id = start;
  while (typeof id === "string" && folders.has(id) && !seen.has(id)) { seen.add(id); out.unshift(id); id = folders.get(id)!.parent; }
  return out;
}

/** The feature list as it is drawn: features in build order, the runs that share a folder gathered under it. */
export function featureTree(features: readonly FeatureItem[], folders: ReadonlyMap<string, FolderItem>): FeatureTree {
  const roots: TreeNode[] = [], nodes = new Map<string, FolderNode>(), paths = new Map<string, string[]>();
  const stack: FolderNode[] = [], closed = new Set<string>();
  features.forEach((f, index) => {
    let path = folders.size ? chain(f.folder, folders) : [];
    // a folder is one run of features: what claims it further down is shown where it is built, outside it
    const cut = path.findIndex((id) => closed.has(id));
    if (cut >= 0) path = path.slice(0, cut);
    let common = 0;
    while (common < stack.length && common < path.length && stack[common].folder.id === path[common]) common++;
    while (stack.length > common) closed.add(stack.pop()!.folder.id);
    for (let d = common; d < path.length; d++) {
      const node: FolderNode = { kind: "folder", folder: folders.get(path[d])!, depth: d, parent: d ? path[d - 1] : null, children: [], first: index, last: index };
      (d ? stack[d - 1].children : roots).push(node);
      stack.push(node); nodes.set(path[d], node);
    }
    for (const n of stack) n.last = index;
    (stack.length ? stack[stack.length - 1].children : roots).push({ kind: "feature", feature: f, index, depth: stack.length, parent: path.length ? path[path.length - 1] : null });
    paths.set(f.id, path);
  });
  return { roots, nodes, paths };
}

export const treeOf = (doc: ItemDoc): FeatureTree => featureTree(featuresOf(doc), foldersOf(doc));

/** The folder a feature put at `index` of the list (before features[index]) falls in: the one both its neighbours share. */
export function folderAt(doc: ItemDoc, index: number, features: FeatureItem[] = featuresOf(doc), moving: ReadonlySet<string> = new Set()): string | null {
  const folders = foldersOf(doc);
  if (!folders.size) return null;
  const tree = featureTree(features.filter((f) => !moving.has(f.id)), folders);
  let before: FeatureItem | undefined, after: FeatureItem | undefined;
  for (let i = index - 1; i >= 0 && !before; i--) if (!moving.has(features[i].id)) before = features[i];
  for (let i = index; i < features.length && !after; i++) if (!moving.has(features[i].id)) after = features[i];
  if (!before || !after) return null;
  const a = tree.paths.get(before.id) || [], b = tree.paths.get(after.id) || [];
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n ? a[n - 1] : null;
}

/** `folder` as the key of a new feature item: nothing when it is in no folder. */
export const folderKey = (folder: string | null): { folder?: string } => (folder ? { folder } : {});

// ---------------------------------------------------------------- suppression

export interface Suppression {
  /** not built */
  suppressed: boolean;
  /** by its own `suppressed` */
  own: boolean;
  /** by its own condition, which holds */
  byCondition: boolean;
  /** by a folder around it (the outermost one that is suppressed) */
  byFolder: string | null;
  /** the item's condition cannot be read: it suppresses nothing, and the list says why */
  conditionError?: string;
}

function own(item: { suppressed?: unknown; suppressIf?: unknown }, lookup: Lookup): Pick<Suppression, "own" | "byCondition" | "conditionError"> {
  const out: Pick<Suppression, "own" | "byCondition" | "conditionError"> = { own: item.suppressed === true, byCondition: false };
  if (typeof item.suppressIf === "string" && item.suppressIf.trim()) {
    try { out.byCondition = evaluateCondition(item.suppressIf, lookup); } catch (e) { out.conditionError = e instanceof Error ? e.message : String(e); }
  }
  return out;
}

/**
 * Whether each feature and each folder of the list is built, and why not.  `lookup` gives the variables their
 * values (document/variables.ts lookupOf); without it a condition that names a variable cannot be read.
 */
export function suppressionOf(doc: ItemDoc, features: readonly FeatureItem[] = featuresOf(doc), lookup: Lookup = () => undefined): Map<string, Suppression> {
  const folders = foldersOf(doc), out = new Map<string, Suppression>();
  const tree = featureTree(features, folders);
  const folderState = (id: string): Suppression => {
    const have = out.get(id);
    if (have) return have;
    const f = folders.get(id)!, node = tree.nodes.get(id), mine = own(f, lookup);
    const above = node && node.parent ? folderState(node.parent) : null;
    const byFolder = above && above.suppressed ? above.byFolder || node!.parent : null;
    const s: Suppression = { ...mine, byFolder, suppressed: mine.own || mine.byCondition || !!byFolder };
    out.set(id, s);
    return s;
  };
  for (const f of features) {
    const path = tree.paths.get(f.id) || [], mine = own(f, lookup);
    const around = path.length ? folderState(path[path.length - 1]) : null;
    const byFolder = around && around.suppressed ? around.byFolder || path[path.length - 1] : null;
    out.set(f.id, { ...mine, byFolder, suppressed: mine.own || mine.byCondition || !!byFolder });
  }
  return out;
}

/** True when nothing in the document can suppress a feature but its own `suppressed`: the common case, answered fast. */
export function plainSuppression(doc: ItemDoc, features: readonly FeatureItem[]): boolean {
  for (const f of features) if (f.suppressIf !== undefined || f.folder !== undefined) return false;
  return true;
}

// ---------------------------------------------------------------- edits

type Membership = { features: Map<string, string | null>; parents: Map<string, string | null> };

/** Changes that remove the folders nothing is in any more, given who is in what after an edit. */
function prune(folders: ReadonlyMap<string, FolderItem>, after: Membership, added: ReadonlySet<string> = new Set()): ItemChange[] {
  const alive = new Set<string>();
  for (const start of after.features.values()) {
    const seen = new Set<string>();
    let id: string | null | undefined = start;
    while (id && !seen.has(id) && (folders.has(id) || added.has(id))) { seen.add(id); alive.add(id); id = after.parents.get(id); }
  }
  const out: ItemChange[] = [];
  for (const f of folders.values()) if (!alive.has(f.id)) out.push(removedChange(f));
  return out;
}

function membership(features: readonly FeatureItem[], folders: ReadonlyMap<string, FolderItem>): Membership {
  return {
    features: new Map(features.map((f) => [f.id, typeof f.folder === "string" ? f.folder : null])),
    parents: new Map(Array.from(folders.values()).map((f) => [f.id, typeof f.parent === "string" ? f.parent : null])),
  };
}

const setKey = (key: string, value: string | null): PropChange => (value ? { path: [key], value } : { path: [key], del: true });

/** What `ids` (features and folders) stand for: the folders among them that no other of them holds, and every feature moved. */
function resolve(ids: readonly string[], features: readonly FeatureItem[], tree: FeatureTree): { folders: string[]; direct: Set<string>; moving: FeatureItem[] } {
  const want = new Set(ids);
  const top = ids.filter((id) => { const n = tree.nodes.get(id); if (!n) return false; for (let p = n.parent; p; p = tree.nodes.get(p)?.parent || null) if (want.has(p)) return false; return true; });
  const inFolder = (i: number) => top.some((id) => { const n = tree.nodes.get(id)!; return i >= n.first && i <= n.last; });
  const direct = new Set<string>(), moving: FeatureItem[] = [];
  features.forEach((f, i) => {
    const held = inFolder(i);
    if (!held && want.has(f.id)) direct.add(f.id);
    if (held || want.has(f.id)) moving.push(f);
  });
  return { folders: top, direct, moving };
}

function relocate(doc: ItemDoc, ids: readonly string[], index: number, into: string | null, extra: readonly FolderItem[] = []): ItemChange[] {
  const features = featuresOf(doc), folders = foldersOf(doc), tree = featureTree(features, folders);
  const sel = resolve(ids, features, tree);
  if (!sel.moving.length) return [];
  const all = new Map(folders);
  for (const f of extra) all.set(f.id, f);
  if (into !== null && !all.has(into)) return [];
  // a folder cannot go into itself or into what it holds
  if (into !== null && chain(into, all).some((id) => sel.folders.includes(id))) return [];
  const movingIds = new Set(sel.moving.map((f) => f.id));
  const rest = features.filter((f) => !movingIds.has(f.id));
  const at = features.slice(0, Math.max(0, Math.min(index, features.length))).filter((f) => !movingIds.has(f.id)).length;
  const props = new Map<string, PropChange[]>();
  const add = (id: string, p: PropChange) => { const l = props.get(id); if (l) l.push(p); else props.set(id, [p]); };
  const order = [...rest.slice(0, at), ...sel.moving, ...rest.slice(at)];
  if (order.some((f, i) => f.id !== features[i].id)) {
    let a = at ? rest[at - 1].order : null;
    const b = at < rest.length ? rest[at].order : null;
    for (const f of sel.moving) { a = orderBetween(a, b); add(f.id, { path: ["order"], value: a }); }
  }
  const after = membership(features, all);
  for (const id of sel.direct) { if (after.features.get(id) !== into) { add(id, setKey("folder", into)); after.features.set(id, into); } }
  for (const id of sel.folders) { if (after.parents.get(id) !== into) { add(id, setKey("parent", into)); after.parents.set(id, into); } }
  const out: ItemChange[] = [];
  for (const [id, list] of props) out.push({ id, kind: "MODIFIED", typeName: folders.has(id) ? FOLDER_TYPE : "feature", props: list });
  out.push(...prune(folders, after, new Set(extra.map((f) => f.id))));
  return out;
}

/**
 * Move features and folders (a folder takes what it holds) so that they sit together, in the order they have
 * now, before `features[index]` (features.length: the end), in the folder `into` (null: in none).  One step.
 */
export function moveItems(doc: ItemDoc, ids: readonly string[], index: number, into: string | null): ItemChange[] { return relocate(doc, ids, index, into); }

/** Move features and folders into a folder, at its end (null: out of every folder, to just below the outermost one they were in). */
export function moveToFolder(doc: ItemDoc, ids: readonly string[], into: string | null): ItemChange[] {
  const features = featuresOf(doc), tree = featureTree(features, foldersOf(doc));
  if (into !== null) { const n = tree.nodes.get(into); return n ? relocate(doc, ids, n.last + 1, into) : []; }
  const sel = resolve(ids, features, tree);
  if (!sel.moving.length) return [];
  const path = tree.paths.get(sel.moving[sel.moving.length - 1].id) || [];
  const outer = path.length ? tree.nodes.get(path[0]) : undefined;
  return relocate(doc, ids, outer ? outer.last + 1 : features.findIndex((f) => f.id === sel.moving[0].id), null);
}

/**
 * A new folder holding these features and folders.  They are gathered where the first of them is, inside the
 * folder they all share (so a folder made of things in a folder is nested in it).
 */
export function addToFolder(doc: ItemDoc, ids: readonly string[], name: string): { changes: ItemChange[]; folder: FolderItem | null } {
  const features = featuresOf(doc), folders = foldersOf(doc), tree = featureTree(features, folders);
  const sel = resolve(ids, features, tree);
  if (!sel.moving.length) return { changes: [], folder: null };
  // where each chosen thing is: a feature's folders, a folder's own parents
  const places = [...Array.from(sel.direct, (id) => tree.paths.get(id) || []), ...sel.folders.map((id) => chain(tree.nodes.get(id)!.parent, folders))];
  let common = places[0].slice();
  for (const p of places) { let n = 0; while (n < common.length && n < p.length && common[n] === p[n]) n++; common = common.slice(0, n); }
  const parent = common.length ? common[common.length - 1] : null;
  // the first chosen feature may be deeper than that: the new folder goes before the folder that holds it there
  const first = sel.moving[0], firstPath = tree.paths.get(first.id) || [];
  const firstIsFolder = sel.folders.find((id) => firstPath.includes(id));
  const holder = firstPath[common.length] && firstPath[common.length] !== firstIsFolder ? tree.nodes.get(firstPath[common.length]) : undefined;
  const index = holder ? holder.first : features.findIndex((f) => f.id === first.id);
  const folder: FolderItem = { id: newId(), type: FOLDER_TYPE, name: name.trim() || nextFolderName(doc), ...(parent ? { parent } : {}) };
  return { changes: [addedChange(folder), ...relocate(doc, ids, index, folder.id, [folder])], folder };
}

/** "Folder 2": the first free name. */
export function nextFolderName(doc: ItemDoc): string {
  const taken = new Set(Array.from(foldersOf(doc).values(), (f) => f.name));
  for (let n = 1; ; n++) if (!taken.has(`Folder ${n}`)) return `Folder ${n}`;
}

/** Take a folder away and leave what it held where it is, in the folder around it. */
export function unpackFolder(doc: ItemDoc, folderId: string): ItemChange[] {
  const folder = doc.items.get(folderId);
  if (!isFolder(folder)) return [];
  const up = typeof folder.parent === "string" && isFolder(doc.items.get(folder.parent)) ? folder.parent : null;
  const out: ItemChange[] = [];
  for (const i of doc.items.values()) {
    if (isFeature(i) && i.folder === folderId) out.push({ id: i.id, kind: "MODIFIED", typeName: "feature", props: [setKey("folder", up)] });
    else if (isFolder(i) && i.parent === folderId) out.push({ id: i.id, kind: "MODIFIED", typeName: FOLDER_TYPE, props: [setKey("parent", up)] });
  }
  out.push(removedChange(folder));
  return out;
}

/** Rename a feature or a folder. */
export function renameItem(doc: ItemDoc, id: string, name: string): ItemChange[] {
  const i = doc.items.get(id), n = name.trim();
  if (!(isFeature(i) || isFolder(i)) || !n || n === i.name) return [];
  return [{ id, kind: "MODIFIED", typeName: i.type, props: [{ path: ["name"], value: n }] }];
}

/** Suppress or unsuppress features and folders.  A folder is suppressed as one thing: what it holds is not touched. */
export function suppressItems(doc: ItemDoc, ids: readonly string[], suppressed: boolean): ItemChange[] {
  const out: ItemChange[] = [];
  for (const id of ids) {
    const i = doc.items.get(id);
    if (!(isFeature(i) || isFolder(i)) || (i.suppressed === true) === suppressed) continue;
    out.push({ id, kind: "MODIFIED", typeName: i.type, props: [suppressed ? { path: ["suppressed"], value: true } : { path: ["suppressed"], del: true }] });
  }
  return out;
}

/** Set the condition under which a feature or a folder is suppressed (dynamic suppression); null or "" removes it. */
export function setSuppressIf(doc: ItemDoc, id: string, condition: string | null): ItemChange[] {
  const i = doc.items.get(id), text = (condition || "").trim();
  if (!(isFeature(i) || isFolder(i)) || (typeof i.suppressIf === "string" ? i.suppressIf : "") === text) return [];
  return [{ id, kind: "MODIFIED", typeName: i.type, props: [text ? { path: ["suppressIf"], value: text } : { path: ["suppressIf"], del: true }] }];
}

/**
 * Delete features and folders; a folder goes with everything in it.  A rollback bar that sat on one of them
 * moves to the next feature that stays.
 */
export function deleteItems(doc: ItemDoc, ids: readonly string[]): ItemChange[] {
  const features = featuresOf(doc), folders = foldersOf(doc), tree = featureTree(features, folders);
  const sel = resolve(ids, features, tree);
  const gone = new Set(sel.moving.map((f) => f.id));
  const out: ItemChange[] = [];
  const bar = studioOf(doc).rollback;
  if (bar && gone.has(bar)) {
    const from = features.findIndex((f) => f.id === bar);
    const next = features.slice(from).find((f) => !gone.has(f.id));
    const now = doc.items.get(STUDIO_ITEM_ID) as StudioItem | undefined;
    if (now) out.push({ id: STUDIO_ITEM_ID, kind: "MODIFIED", typeName: "studio", props: [{ path: ["rollback"], value: next ? next.id : null }] });
  }
  for (const f of sel.moving) out.push(removedChange(f));
  const after = membership(features.filter((f) => !gone.has(f.id)), folders);
  out.push(...prune(folders, after));
  return out;
}

/** Every feature a folder holds (in the folders inside it too), in list order. */
export function featuresIn(tree: FeatureTree, features: readonly FeatureItem[], folderId: string): FeatureItem[] {
  const n = tree.nodes.get(folderId);
  return n ? features.slice(n.first, n.last + 1) : [];
}
