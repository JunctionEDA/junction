// hier-nav.ts — the Hierarchy navigator's tree as wxTreeCtrl handles it (eeschema/widgets/hierarchy_pane.cpp over
// wxGenericTreeCtrl): the rows in view, the keyboard moves (Up / Down select the previous / next row, which changes
// sheet as wxEVT_TREE_SEL_CHANGED does; Left folds or goes to the parent; Right unfolds or goes to the first child;
// Home / End; + - * fold and unfold), the row the current sheet needs unfolded (UpdateHierarchySelection: Expand the
// parent, EnsureVisible), the rows that are the same sheet symbol reached by another path (setIdenticalSheetsHighlighted)
// and the collapsed paths kept per project (PROJECT_LOCAL_SETTINGS::m_SchHierarchyCollapsed).  Plain functions, so the
// node tests can run them.

export interface TreeNode { path: string; children: TreeNode[]; current?: boolean; virtual?: boolean; sheetId?: string | null; parentDocId?: string | null }
export interface TreeRow<T extends TreeNode> { node: T; depth: number; parent: T | null }

/** The rows the tree shows, top to bottom: the hidden project root's children, each node's children while it is open. */
export function visibleRows<T extends TreeNode>(root: T | null, closed: ReadonlySet<string>): TreeRow<T>[] {
  const out: TreeRow<T>[] = [];
  const walk = (n: T, depth: number, parent: T | null): void => {
    out.push({ node: n, depth, parent });
    if (!closed.has(n.path)) for (const c of n.children as T[]) walk(c, depth + 1, n);
  };
  if (root) { if (root.virtual) for (const c of root.children as T[]) walk(c, 0, null); else walk(root, 0, null); }
  return out;
}

/** The paths of the nodes above `path` (the root's first), or null when the tree has no such node. */
export function ancestorPaths<T extends TreeNode>(root: T | null, path: string): string[] | null {
  const walk = (n: T, acc: string[]): string[] | null => {
    if (n.path === path) return acc;
    for (const c of n.children as T[]) { const r = walk(c, n.virtual ? acc : acc.concat(n.path)); if (r) return r; }
    return null;
  };
  return root ? walk(root, []) : null;
}

/** Every node with children (what Collapse All folds). */
export function parentPaths<T extends TreeNode>(n: T, out: string[] = []): string[] {
  if (n.children.length && !n.virtual) out.push(n.path);
  for (const c of n.children as T[]) parentPaths(c, out);
  return out;
}

/**
 * HIERARCHY_PANE::UpdateHierarchySelection: the row of the sheet on screen is made visible (its parents unfolded).
 * Returns the collapsed set without the ancestors of the first current node, or the same set when nothing changes
 * (no current node, a current row already in view, or nothing folded above it).
 */
export function revealCurrent<T extends TreeNode>(root: T | null, closed: ReadonlySet<string>): ReadonlySet<string> {
  if (!root || !closed.size) return closed;
  if (visibleRows(root, closed).some((r) => r.node.current)) return closed;
  let cur: T | null = null;
  const find = (n: T): void => { if (cur) return; if (n.current && !n.virtual) { cur = n; return; } for (const c of n.children as T[]) find(c); };
  find(root);
  const up = cur ? ancestorPaths(root, (cur as T).path) : null;
  if (!up || !up.some((p) => closed.has(p))) return closed;
  const next = new Set(closed); for (const p of up) next.delete(p);
  return next;
}

/** setIdenticalSheetsHighlighted: the other rows that are the same sheet symbol (the same SCH_SHEET) on another path. */
export function identicalPaths<T extends TreeNode>(root: T | null, path: string): string[] {
  const out: string[] = []; let me: T | null = null;
  const find = (n: T): void => { if (n.path === path) me = n; for (const c of n.children as T[]) find(c); };
  if (root) find(root);
  const m = me as T | null; if (!m || !m.sheetId) return out;
  const walk = (n: T): void => { if (n.path !== path && n.sheetId === m.sheetId && n.parentDocId === m.parentDocId) out.push(n.path); for (const c of n.children as T[]) walk(c); };
  if (root) walk(root);
  return out;
}

export interface TreeKeyResult { /** the row that becomes the selected one (it is opened: wxEVT_TREE_SEL_CHANGED) */ select?: string; /** the collapsed set after the key */ closed?: Set<string> }
/**
 * wxGenericTreeCtrl::OnChar on the row at `at`: null when the key is not the tree's.
 *   Up / Down: the previous / next row in view      Home / End: the first / last row in view
 *   Left: fold an open node with children, else go to its parent      Right: unfold a folded node, else its first child
 *   + unfold      - fold      * unfold the node and everything below it
 */
export function treeKey<T extends TreeNode>(root: T | null, closed: ReadonlySet<string>, at: string | null, key: string): TreeKeyResult | null {
  const rows = visibleRows(root, closed); if (!rows.length) return null;
  let i = at === null ? -1 : rows.findIndex((r) => r.node.path === at);
  const sel = (k: number): TreeKeyResult => (k === i ? {} : { select: rows[k].node.path });
  if (key === "Home") return sel(0);
  if (key === "End") return sel(rows.length - 1);
  if (key === "ArrowDown") return sel(Math.min(rows.length - 1, i + 1));
  if (key === "ArrowUp") return sel(Math.max(0, i < 0 ? 0 : i - 1));
  if (i < 0) i = 0;
  const row = rows[i], n = row.node, kids = n.children.length > 0, open = !closed.has(n.path);
  const fold = (): TreeKeyResult => { const c = new Set(closed); c.add(n.path); return { closed: c }; };
  const unfold = (): TreeKeyResult => { const c = new Set(closed); c.delete(n.path); return { closed: c }; };
  if (key === "ArrowLeft") return kids && open ? fold() : row.parent ? { select: row.parent.path } : {};
  if (key === "ArrowRight") return !kids ? {} : !open ? unfold() : { select: n.children[0].path };
  if (key === "+") return kids && !open ? unfold() : {};
  if (key === "-") return kids && open ? fold() : {};
  if (key === "*") { const c = new Set(closed); for (const p of parentPaths(n)) c.delete(p); return { closed: c }; }
  return null;
}

// ---------------------------------------------------------------- the collapsed paths, per project
export const collapsedKey = (projectId: string): string => "kui.hierCollapsed." + projectId;
interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }
export function loadCollapsed(store: Store | null | undefined, projectId: string): Set<string> {
  try { const v = store && projectId ? JSON.parse(store.getItem(collapsedKey(projectId)) || "[]") as unknown : []; return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); } catch (e) { return new Set(); }
}
export function saveCollapsed(store: Store | null | undefined, projectId: string, closed: ReadonlySet<string>): void {
  try { if (store && projectId) store.setItem(collapsedKey(projectId), JSON.stringify(Array.from(closed))); } catch (e) { /* no storage */ }
}
