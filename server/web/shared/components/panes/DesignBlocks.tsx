// DesignBlocks.tsx — the Design Blocks pane (DESIGN_BLOCK_PANE with PANEL_DESIGN_BLOCK_CHOOSER, common/widgets;
// SCH_DESIGN_BLOCK_PANE / PCB_DESIGN_BLOCK_PANE): the library tree's filter row, the tree with "-- Recently Used --"
// first, the selected block's details (DESIGN_BLOCK_TREE_MODEL_ADAPTER::GenerateInfo) over its preview, and the
// placement checkboxes ("Place repeated copies", "Place as group", "Place as sheet" on the schematic, "Keep
// annotations").  A double-click or Enter on a block places it (placeDesignBlock); the right-click menu is the
// pane's CONDITIONAL_MENU (library/design-blocks.ts designBlockTreeMenu).  The model is
// web/domains/pcb/editor/design-blocks.ts (window.KcDesignBlocks).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApp } from "../../store";
import { cx } from "../../util";
import { menuMeta } from "../../../domains/pcb/menuspec";
import { ContextMenu, Twist, type MenuAt, type MenuItem } from "./widgets";
import { libTreeFilter, loadSortMode, type LibTreeFilter } from "../libtree-filter";
import { filterItems, libraryScore, sortLibraries, type SortMode } from "../../../domains/pcb/library/libtree";
import { designBlockTreeMenu, parseDbLibId } from "../../../domains/pcb/library/design-blocks";
import { renderDesignBlockPreview } from "../../../domains/pcb/library/preview";
import type { DesignBlocksApi, DbPaneState } from "../../../domains/pcb/editor/design-blocks";

const RECENT = "-- Recently Used --";
const EMPTY: DbPaneState = { editor: "sch", libs: [], history: [], current: null, opts: { repeated: false, group: true, sheet: false, keep: false }, loading: false, info: "", version: 0 };
const api = (): DesignBlocksApi | null => (window as unknown as { KcDesignBlocks?: DesignBlocksApi }).KcDesignBlocks || null;
function subscribe(fn: () => void): () => void {
  const a = api(); if (a) return a.subscribe(fn);
  const ready = (): void => fn(); window.addEventListener("kc-designblocks-ready", ready);
  return () => window.removeEventListener("kc-designblocks-ready", ready);
}
const snapshot = (): DbPaneState => { const a = api(); return a ? a.get() : EMPTY; };

const TIPS = {
  repeated: "Place copies of the design block on subsequent clicks.",
  group: "Place the design block as a group.",
  sheet: "Place the design block as a new sheet.",
  keepSch: "Preserve reference designators in the source schematic. Otherwise, clear then reannotate according to settings.",
  keepPcb: "Preserve reference designators in the source layout. Otherwise, clear them.",
};

interface Row { lib: string; name?: string; id: string; desc: string; recent?: boolean }
export function DesignBlocksPane() {
  const m = useSyncExternalStore(subscribe, snapshot);
  const hasSelection = useApp((s) => s.selection.ids.length > 0);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>(() => loadSortMode("designblocks"));
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const [forced, setForced] = useState<boolean | null>(null);
  const q = filter.trim().toLowerCase();
  useEffect(() => { const a = api(); if (a) a.refresh(); }, []);
  // the history list first, then the libraries (pinned first, LIB_TREE_NODE::Compare), each filtered by the search
  const shown = useMemo(() => {
    const libs = m.libs.map((l) => ({ name: l.nick, descr: l.descr, pinned: l.pinned, items: l.blocks.map((b) => ({ name: b.name, desc: b.desc, keywords: b.keywords, lib: l.nick })) }));
    const rows = libs.map((l) => ({ ...l, items: filterItems(l.items, q, sort), ...libraryScore(l.items, q), rank: 0 })).filter((l) => !q || l.items.length || l.name.toLowerCase().includes(q));
    const sorted = sortLibraries(rows, q, sort);
    const all = new Map(m.libs.flatMap((l) => l.blocks.map((b) => [l.nick + ":" + b.name, b] as const)));
    const hist = m.history.map((id) => { const b = all.get(id); const p = parseDbLibId(id); return b ? { name: b.name, desc: b.desc, keywords: b.keywords, lib: p.lib } : null; }).filter(Boolean) as { name: string; desc: string; keywords: string; lib: string }[];
    const recent = q ? filterItems(hist, q, "best") : hist;
    return { recent, libs: sorted };
  }, [m.libs, m.history, q, sort]);
  const isOpen = (name: string, hasCurrent: boolean): boolean => { const base = forced !== null ? forced : (hasCurrent || !!q || name === RECENT); return base ? !flipped.has(name) : flipped.has(name); };
  const toggle = (name: string): void => { const n = new Set(flipped); if (n.has(name)) n.delete(name); else n.add(name); setFlipped(n); };
  const filterHost = useRef<HTMLDivElement | null>(null), filterApi = useRef<LibTreeFilter | null>(null), keyRef = useRef<(ev: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const host = filterHost.current; if (!host || filterApi.current) return;
    const f = libTreeFilter({ key: "designblocks", id: "dbFilter", onText: (t) => { setFilter(t); setFlipped(new Set()); setForced(null); }, onSort: (s) => setSort(s),
      expandAll: () => { setFlipped(new Set()); setForced(true); }, collapseAll: () => { setFlipped(new Set()); setForced(false); }, onKey: (ev) => keyRef.current(ev) });
    filterApi.current = f; host.replaceChildren(f.el);
  }, []);
  // the rows as the keyboard walks them
  const visible: Row[] = [];
  const curLib = m.current ? parseDbLibId(m.current).lib : "";
  if (shown.recent.length) { visible.push({ lib: RECENT, id: "", desc: "" }); if (isOpen(RECENT, false)) for (const b of shown.recent) visible.push({ lib: b.lib, name: b.name, id: b.lib + ":" + b.name, desc: b.desc, recent: true }); }
  for (const l of shown.libs) { visible.push({ lib: l.name, id: l.name + ":", desc: l.descr }); if (isOpen(l.name, curLib === l.name)) for (const b of l.items) visible.push({ lib: l.name, name: b.name, id: l.name + ":" + b.name, desc: b.desc || "" }); }
  const select = (id: string | null): void => { const a = api(); if (a) a.select(id); };
  const choose = (id: string): void => { const a = api(); if (a) a.choose(id); };
  const onKey = (ev: React.KeyboardEvent | KeyboardEvent, fromFilter = false): void => {
    if (!visible.length) return;
    const i = visible.findIndex((r) => r.id && r.id === m.current), row = i >= 0 ? visible[i] : null;
    const go = (j: number): void => { const r = visible[Math.max(0, Math.min(visible.length - 1, j))]; select(r.id || null); };
    if (ev.key === "ArrowDown") go(i + 1);
    else if (ev.key === "ArrowUp") go(i < 0 ? 0 : i - 1);
    else if ((ev.code === "NumpadAdd" || (!fromFilter && ev.key === "ArrowRight")) && row && !row.name) { if (!isOpen(row.lib, curLib === row.lib)) toggle(row.lib); }
    else if ((ev.code === "NumpadSubtract" || (!fromFilter && ev.key === "ArrowLeft")) && row && !row.name) { if (isOpen(row.lib, curLib === row.lib)) toggle(row.lib); }
    else if (ev.key === "Enter" && row) { if (row.name) choose(row.id); else toggle(row.lib); }
    else return;
    ev.preventDefault();
  };
  keyRef.current = (ev: KeyboardEvent) => onKey(ev, true);
  // the preview of the current block (PANEL_DESIGN_BLOCK_CHOOSER::displaySelectedDesignBlock)
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = canvas.current, a = api(); if (!c || !a) return;
    let live = true;
    const ctx = c.getContext("2d"); if (ctx) ctx.clearRect(0, 0, c.width, c.height);
    if (m.current && parseDbLibId(m.current).name) void a.text(m.current).then((t) => { if (live && t && canvas.current) renderDesignBlockPreview(canvas.current, t.kind, t.text); });
    return () => { live = false; };
  }, [m.current, m.version]);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const showMenu = (ev: React.MouseEvent, row: Row | null): void => {
    ev.preventDefault(); ev.stopPropagation();
    if (row && row.id) select(row.id);
    const isLib = !!row && !row.name && row.lib !== RECENT, isDb = !!row && !!row.name;
    const lib = isLib ? m.libs.find((l) => l.nick === row!.lib) : null;
    const ids = designBlockTreeMenu(m.editor, { isLibrary: isLib, isDesignBlock: isDb, pinned: !!(lib && lib.pinned), hasSelection });
    const a = api();
    const items: MenuItem[] = ids.map((id): MenuItem => (id === "-" ? "-" : { label: (menuMeta(m.editor, id) || { label: id }).label, icon: (menuMeta(m.editor, id) || { icon: undefined }).icon || undefined, run: () => { if (a) a.run(id); } }));
    setMenu({ x: ev.clientX, y: ev.clientY, items });
  };
  const opt = (k: "repeated" | "group" | "sheet" | "keep", label: string, tip: string) => (
    <label className="flex items-center gap-1.5 whitespace-nowrap" title={tip}>
      <input type="checkbox" data-k={"db-" + k} checked={m.opts[k]} onChange={(ev) => { const a = api(); if (a) a.setOpt(k, ev.target.checked); }} />{label}
    </label>
  );
  const nodeCls = "node flex items-center h-[20px] pr-1.5 cursor-default whitespace-nowrap hover:bg-panel cur:bg-sel";
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="designBlocksPane">
      <div className="flex-none" ref={filterHost} />
      <div className="ktree overflow-auto min-h-0 flex-auto py-1 outline-none" id="dbTree" tabIndex={0} onKeyDown={onKey} onContextMenu={(ev) => showMenu(ev, null)}>
        {visible.length ? null : <div className="px-2 py-1 text-ink-3">{m.loading ? "Loading…" : m.libs.length ? "No matches" : "No design block libraries. Preferences > Manage Design Block Libraries... adds one."}</div>}
        {visible.map((r) => {
          const lib = !r.name;
          return (
            <div key={(r.recent ? "r:" : "") + (r.id || r.lib)} className={cx(nodeCls, !!r.id && m.current === r.id && !(r.recent && lib) && "cur")} style={{ paddingLeft: lib ? 4 : 18 }}
              data-db={r.name ? r.id : undefined} data-dblib={lib ? r.lib : undefined} title={r.name ? r.id : r.desc || r.lib}
              onClick={() => (r.id ? select(r.id) : undefined)} onDoubleClick={() => (r.name ? choose(r.id) : toggle(r.lib))} onContextMenu={(ev) => showMenu(ev, r)}>
              {lib ? <Twist open={isOpen(r.lib, curLib === r.lib)} leaf={false} onToggle={() => toggle(r.lib)} /> : <Twist open={false} leaf onToggle={() => undefined} />}
              <span className="flex-none">{lib ? ((m.libs.find((l) => l.nick === r.lib)?.pinned ? "☆ " : "") + r.lib) : r.name}</span>
              {r.desc ? <span className="ml-2 min-w-0 overflow-hidden text-ellipsis text-ink-3">{r.desc}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="flex-none border-t border-line max-h-[120px] overflow-auto px-2 py-1 text-xs" id="dbDetails" dangerouslySetInnerHTML={{ __html: m.info }} />
      <div className="flex-none h-[160px] border-t border-line bg-paper"><canvas ref={canvas} id="dbPreview" className="block w-full h-full" /></div>
      <div className="flex-none flex flex-wrap gap-x-3 gap-y-1 px-2 py-1.5 border-t border-line" id="dbOptions">
        {opt("repeated", "Place repeated copies", TIPS.repeated)}
        {opt("group", "Place as group", TIPS.group)}
        {m.editor === "sch" ? opt("sheet", "Place as sheet", TIPS.sheet) : null}
        {opt("keep", "Keep annotations", m.editor === "sch" ? TIPS.keepSch : TIPS.keepPcb)}
      </div>
      <ContextMenu at={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
