// Hierarchy.tsx — the schematic Hierarchy navigator (eeschema/widgets/hierarchy_pane.cpp): the tree of
// sheets, each "name (page N)", the sheet on screen highlighted.  A click opens the sheet; the right-click
// menu is KiCad's: Edit Page Number, Rename, Delete Top-Level Sheet, New Top-Level Sheet, Expand All, Collapse All.
// The tree is wxTreeCtrl's (hier-nav.ts): the arrow keys move between sheets and fold the nodes, Rename (or F2) edits
// the row's label in place, the row of the sheet on screen is unfolded and scrolled into view, and the folded nodes
// are remembered per project.
import { useEffect, useRef, useState } from "react";
import type { HierNode } from "../../../domains/pcb/panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { KIcon } from "../Icon";
import { identicalPaths, loadCollapsed, parentPaths, revealCurrent, saveCollapsed, treeKey, visibleRows } from "./hier-nav";
import { ContextMenu, Twist, pdispatch, useContextMenu, usePanels, type MenuItem } from "./widgets";

// The pane body (the `.kbody` contract): scrolls, sheet-coloured, 12px type.
const BODY = "kbody ktree overflow-auto min-h-0 flex-auto py-1 bg-paper text-sm outline-none";
const NODE = "node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel cur:font-semibold";

// LAYER_BRIGHTENED of the default schematic theme (builtin_color_themes.h CSS_COLOR( 255, 0, 255, 1 )), until the
// editor publishes the current theme's
const BRIGHTENED = "#FF00FF";

const storage = (): Storage | null => { try { return window.localStorage; } catch (e) { return null; } };

export function HierarchyPane() {
  const root = usePanels((s) => s.hierarchy.root);
  const marked = usePanels((s) => s.hierarchy.marked);
  const markColor = usePanels((s) => s.hierarchy.markColor) || BRIGHTENED;
  const viewOnly = useApp((s) => s.viewOnly);
  const projectId = useApp((s) => (s.project ? s.project.projectId : ""));
  // m_SchHierarchyCollapsed: the folded nodes, kept with the project
  const [closed, setClosedState] = useState<ReadonlySet<string>>(() => loadCollapsed(storage(), projectId));
  const setClosed = (c: ReadonlySet<string>) => { setClosedState(c); saveCollapsed(storage(), projectId, c); };
  useEffect(() => { setClosedState(loadCollapsed(storage(), projectId)); }, [projectId]);
  // the row the keyboard is on (wxTreeCtrl's focused item): the sheet on screen until an arrow key moves it
  const [focus, setFocus] = useState<string | null>(null);
  // Rename: the row whose label is being edited in place (wxTreeCtrl::EditLabel) and the text in its editor
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const body = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const toggle = (p: string) => { const n = new Set(closed); if (n.has(p)) n.delete(p); else n.add(p); setClosed(n); };
  // UpdateHierarchySelection: the parents of the sheet on screen are unfolded and its row is scrolled into view
  const curPath = (() => { const r = visibleRows(root, new Set()).find((x) => x.node.current); return r ? r.node.path : null; })();
  useEffect(() => {
    const next = revealCurrent(root, closed); if (next !== closed) { setClosed(next); return; }
    setFocus(curPath);
    const el = body.current && curPath !== null ? body.current.querySelector<HTMLElement>(`[data-path="${CSS.escape(curPath)}"]`) : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!root, curPath]);
  const editRef = useRef<string | null>(null);
  const startRename = (n: HierNode) => { if (viewOnly) return; setDraft(n.name); editRef.current = n.path; setEditing(n.path); };
  // onTreeEditFinished: the label as typed; an empty or unchanged one leaves the sheet alone
  const endRename = (commit: boolean) => {
    const path = editRef.current; if (path === null) return;   // Enter then the blur it causes: one edit, one result
    editRef.current = null; setEditing(null);
    if (commit) pdispatch({ t: "hierRename", path, name: draft });
    if (body.current) body.current.focus();
  };
  const identical = editing !== null ? identicalPaths(root, editing) : [];
  // HIERARCHY_PANE::onContextMenu: a sheet's own entries (Delete Top-Level Sheet on a top-level one), then New
  // Top-Level Sheet, then Expand / Collapse All; a click beside the rows has only the last three.
  const common: MenuItem[] = [
    { label: "New Top-Level Sheet", run: () => pdispatch({ t: "hierNewTop" }), disabled: viewOnly, title: "Create a new top-level sheet" },
    "-",
    { label: "Expand All", run: () => setClosed(new Set()) },
    { label: "Collapse All", run: () => setClosed(new Set(root ? parentPaths(root) : [])) },
  ];
  const items = (n: HierNode): MenuItem[] => [
    { label: "Edit Page Number", run: () => pdispatch({ t: "hierPage", path: n.path }), disabled: viewOnly || !n.docId },
    // the project root is hidden (wxTR_HIDE_ROOT), so a top-level sheet is never isProjectRoot: Rename is offered
    { label: "Rename", run: () => startRename(n), disabled: viewOnly, title: "Change name of this sheet" },
    ...(n.parentDocId ? [] : [{ label: "Delete Top-Level Sheet", run: () => pdispatch({ t: "hierDeleteTop", path: n.path }), disabled: viewOnly, title: "Remove this top-level sheet from the project" } satisfies MenuItem]),
    "-",
    ...common,
  ];
  const onKey = (ev: React.KeyboardEvent) => {
    if (editing !== null || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const at = focus !== null ? focus : curPath;
    if (ev.key === "F2") {   // wxTR_EDIT_LABELS
      const r = visibleRows(root, closed).find((x) => x.node.path === at); if (!r) return;
      ev.preventDefault(); ev.stopPropagation(); startRename(r.node); return;
    }
    // wxEVT_TREE_ITEM_ACTIVATED (Enter) runs onSelectSheetPath too
    if (ev.key === "Enter" && at !== null) { ev.preventDefault(); ev.stopPropagation(); pdispatch({ t: "hierOpen", path: at }); return; }
    const res = treeKey(root, closed, at, ev.key); if (!res) return;
    ev.preventDefault(); ev.stopPropagation();
    if (res.closed) setClosed(res.closed);
    // wxEVT_TREE_SEL_CHANGED runs onSelectSheetPath: the row the selection moves to is the sheet shown
    if (res.select !== undefined) { setFocus(res.select); pdispatch({ t: "hierOpen", path: res.select });
      const el = body.current ? body.current.querySelector<HTMLElement>(`[data-path="${CSS.escape(res.select)}"]`) : null; if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" }); }
  };
  const row = (n: HierNode, depth: number): JSX.Element => {
    const open = !closed.has(n.path);
    return (
      <div key={n.path}>
        {/* a sheet holding the highlighted net: LAYER_BRIGHTENED text (the schematic theme's "brightened") */}
        <div className={cx(NODE, n.current && "cur", !n.docId && "text-ink-3", focus === n.path && "outline outline-1 -outline-offset-1 outline-blue/50")} style={{ paddingLeft: 4 + depth * 14, color: marked && marked.includes(n.path) ? markColor : undefined }}
          data-doc={n.docId || undefined} data-path={n.path} data-net-mark={marked && marked.includes(n.path) ? "" : undefined} title={n.file}
          onClick={() => { if (editing === n.path) return; setFocus(n.path); pdispatch({ t: "hierOpen", path: n.path }); }} onContextMenu={(ev) => { ev.stopPropagation(); menu.open(ev, items(n)); }}>
          <Twist open={open} leaf={!n.children.length} onToggle={() => toggle(n.path)} />
          {/* HIERARCHY_PANE's image list: tree_sel on the sheet being edited, tree_nosel on the others */}
          <span className="flex-none mr-1 inline-flex" data-icon={n.current ? "tree_sel" : "tree_nosel"}><KIcon name={n.current ? "tree_sel" : "tree_nosel"} size={16} /></span>
          {editing === n.path ? (
            // EditLabel: the editor holds the sheet name alone, without the "(page N)" suffix, all of it selected
            <input className="flex-auto min-w-[60px] h-[18px] px-1 py-0 bg-panel border border-blue rounded-xs text-ink text-sm font-normal" data-hier-edit={n.path} value={draft} spellCheck={false}
              autoFocus onFocus={(ev) => ev.currentTarget.select()} onChange={(ev) => setDraft(ev.target.value)} onClick={(ev) => ev.stopPropagation()} onBlur={() => endRename(true)}
              onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); endRename(true); } else if (ev.key === "Escape") { ev.preventDefault(); endRename(false); } }} />
          ) : (
            // setIdenticalSheetsHighlighted: the same sheet symbol on another path is underlined while one is renamed
            <span className={cx(identical.includes(n.path) && "underline")} data-identical={identical.includes(n.path) ? "" : undefined}>{n.name}{n.page ? ` (page ${n.page})` : ""}</span>
          )}
        </div>
        {open ? n.children.map((c) => row(c, depth + 1)) : null}
      </div>
    );
  };
  return (
    <div className={BODY} id="hier" ref={body} tabIndex={0} onKeyDown={onKey} onContextMenu={(ev) => menu.open(ev, common)}>
      {/* several top-level sheets hang under the hidden project root (wxTR_HIDE_ROOT), each a row of its own */}
      {root ? (root.virtual ? root.children.map((c) => row(c, 0)) : row(root, 0)) : <p className="note px-2">No schematic sheets in this project.</p>}
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}
