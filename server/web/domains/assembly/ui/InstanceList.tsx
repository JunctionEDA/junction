// InstanceList.tsx — the instance tree: "Instances (n)", a filter, the assembly itself, then every instance in
// its folders and patterns, a sub-assembly opening to show what is inside it.  Each row says what state the
// instance is in: fixed, held by its mates, how many freedoms they leave it, hidden, suppressed, and in red, with
// the reason, a source that failed or a mate on it that cannot hold.  A click selects (Shift: a range, Ctrl: one
// more); a right click offers everything that can be done to it; rows drag to another place or into a folder.
import { useState } from "react";
import { cx } from "../../../shared/util";
import { tipHandlers } from "../../mechanical/api-ui";
import { memberOf } from "../document/extras";
import type { InstanceItem } from "../document/format";
import type { AssemblyEditor, AssemblyState, InstanceInfo } from "./assembly";
import { askEditPattern, askPattern } from "./forms";
import { Caption, ContextMenu, Glyph, ICONS, useAssembly, type MenuItem, type MenuState } from "./parts";
import { SupplierMark, supplierMenu } from "./SupplierSearch";

interface Badge { text: string; title: string; tone?: "err" | "dim"; state: string }

/** The first mate on this instance that cannot hold, as "Hinge: why". */
function mateTrouble(s: AssemblyState, id: string): string | null {
  for (const m of s.mates) {
    if (m.a.instance !== id && m.b.instance !== id) continue;
    const info = s.mateInfo[m.id];
    if (info && (info.state === "conflict" || info.state === "error")) return `${m.name}: ${info.message || "it cannot hold"}`;
  }
  return null;
}

function badge(s: AssemblyState, i: InstanceItem, info: InstanceInfo | undefined): Badge | null {
  if (i.suppressed) return { text: "suppressed", title: "Suppressed: not shown, and its mates are not applied.", tone: "dim", state: "suppressed" };
  if (!info) return null;
  if (info.status === "error") return { text: "!", title: info.message || "This instance could not be loaded.", tone: "err", state: "error" };
  if (info.status === "loading") return { text: "…", title: info.message || "Loading", tone: "dim", state: "loading" };
  const trouble = mateTrouble(s, i.id);
  if (trouble) return { text: "!", title: trouble, tone: "err", state: "error" };
  if (i.fixed) return { text: "fixed", title: "Fixed: it stays where it is.", state: "fixed" };
  if (info.grounded) return { text: "held", title: "Fastened to a fixed instance: it cannot move.", state: "held" };
  if (info.dof === null) return null;
  if (info.dof === 0) return { text: "held", title: "Fully mated: its mates leave it no freedom.", state: "held" };
  return { text: info.dof === 6 ? "free" : `${info.dof} free`, title: info.dof === 6 ? "Nothing holds this instance: drag it anywhere, or mate it." : `Under-defined: its mates leave ${info.dof} of 6 freedoms. Drag it to see them.`, tone: "dim", state: "free" };
}

export function NameField({ name, done }: { name: string; done(name: string | null): void }) {
  const [text, setText] = useState(name);
  return <input autoFocus className="input flex-1 min-w-0 h-5.5" value={text} aria-label="Name" onChange={(ev) => setText(ev.target.value)} onFocus={(ev) => ev.target.select()}
    onBlur={() => done(text)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") done(text); else if (ev.key === "Escape") done(null); }} onClick={(ev) => ev.stopPropagation()} />;
}

type Row =
  | { kind: "group"; id: string; name: string; collapsed: boolean; members: string[] }
  | { kind: "pattern"; id: string; name: string; members: string[] }
  | { kind: "instance"; item: InstanceItem; depth: number }
  | { kind: "piece"; key: string; name: string; depth: number };

const stem = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");
const kindIcon = (i: InstanceItem): string => (i.source.kind === "assembly" ? ICONS.assembly : i.source.kind === "board" ? ICONS.board : ICONS.part);

export function InstanceList({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [closedPatterns, setClosedPatterns] = useState<ReadonlySet<string>>(new Set());
  const [drop, setDrop] = useState<string | null>(null);
  const selected = new Set(s.selection);
  const q = filter.trim().toLowerCase();
  const match = (i: InstanceItem) => !q || i.name.toLowerCase().includes(q);

  // the rows, top to bottom: a folder or a pattern at the place of its first member, with its members under it
  const groupIds = new Set(s.groups.map((g) => g.id)), patternIds = new Set(s.patterns.map((p) => p.id));
  const rows: Row[] = [], ordered: InstanceItem[] = [];
  const placed = new Set<string>();
  const pushInstance = (i: InstanceItem, depth: number) => {
    if (!match(i)) return;
    ordered.push(i); rows.push({ kind: "instance", item: i, depth });
    if (i.source.kind === "assembly" && open.has(i.id)) for (const p of assembly.sources.piecesOf(i).pieces) rows.push({ kind: "piece", key: `${i.id}/${p.id}`, name: p.name, depth: depth + 1 });
  };
  const containerOf = (i: InstanceItem): string | null => { const m = memberOf(i); return m && patternIds.has(m.pattern) ? m.pattern : typeof i.group === "string" && groupIds.has(i.group) ? i.group : null; };
  for (const i of s.instances) {
    const c = containerOf(i);
    if (!c) { pushInstance(i, 0); continue; }
    if (placed.has(c)) continue;
    placed.add(c);
    const members = s.instances.filter((m) => containerOf(m) === c);
    if (q && !members.some(match)) continue;
    const g = s.groups.find((x) => x.id === c), p = s.patterns.find((x) => x.id === c);
    if (g) { rows.push({ kind: "group", id: c, name: g.name, collapsed: !!g.collapsed && !q, members: members.map((m) => m.id) }); if (!g.collapsed || q) for (const m of members) pushInstance(m, 1); else ordered.push(...members); }
    else if (p) { rows.push({ kind: "pattern", id: c, name: p.name, members: members.map((m) => m.id) }); if (!closedPatterns.has(c) || q) for (const m of members) pushInstance(m, 1); }
  }
  if (!q) for (const g of s.groups) if (!placed.has(g.id)) rows.push({ kind: "group", id: g.id, name: g.name, collapsed: !!g.collapsed, members: [] });

  const click = (id: string, ev: React.MouseEvent) => {
    if (ev.shiftKey && anchor) {
      const ids = ordered.map((i) => i.id), a = ids.indexOf(anchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) { assembly.select(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); return; }
    }
    setAnchor(id);
    assembly.select(id, { toggle: ev.ctrlKey || ev.metaKey });
  };
  const openMenu = (id: string, ev: React.MouseEvent) => {
    ev.preventDefault();
    if (!selected.has(id)) assembly.select(id);
    const ids = selected.has(id) ? s.selection.filter((x) => s.instances.some((i) => i.id === x)) : [id];
    const items = s.instances.filter((i) => ids.includes(i.id));
    if (!items.length) return;
    const one = items.length === 1 ? items[0] : null, ro = !s.canEdit;
    const all = (f: (i: InstanceItem) => boolean) => items.every(f);
    const at = s.instances.findIndex((i) => i.id === items[0].id), end = s.instances.findIndex((i) => i.id === items[items.length - 1].id);
    const copy = items.some((i) => !!memberOf(i));
    const withSelection = (run: () => void) => () => { assembly.select(ids); run(); };
    const list: MenuItem[] = [
      { label: "Rename", run: () => assembly.startRename(one!.id), disabled: ro || !one },
      { label: all((i) => !!i.fixed) ? "Unfix" : "Fix", run: () => assembly.setFixed(ids, !all((i) => !!i.fixed)), disabled: ro },
      { label: all((i) => !!i.hidden) ? "Show" : "Hide", run: () => assembly.setHidden(ids, !all((i) => !!i.hidden)), disabled: ro },
      { label: all((i) => !!i.suppressed) ? "Unsuppress" : "Suppress", run: () => assembly.setSuppressed(ids, !all((i) => !!i.suppressed)), disabled: ro },
      { label: one && one.source.kind !== "part" ? "Open its source" : "Edit the part", run: () => assembly.openSource(one!.id), disabled: !one },
      { label: "Replace…", run: () => assembly.openInsert(one!.id), disabled: ro || !one || copy, rule: true },
      { label: "Group", run: () => assembly.groupRigid(ids), disabled: ro || ids.length < 2 },
      { label: "New folder", run: () => assembly.group(ids), disabled: ro || copy },
      ...s.groups.filter((g) => !items.every((i) => i.group === g.id)).map((g): MenuItem => ({ label: `Move to ${g.name}`, run: () => assembly.moveInstances(ids, null, g.id), disabled: ro || copy })),
      ...(items.some((i) => typeof i.group === "string") ? [{ label: "Move out of the folder", run: () => assembly.moveInstances(ids, null, null), disabled: ro } as MenuItem] : []),
      { label: "Move up", run: () => assembly.moveInstances(ids, s.instances[at - 1].id), disabled: ro || at <= 0 || copy },
      { label: "Move down", run: () => assembly.moveInstances(ids, end + 2 < s.instances.length ? s.instances[end + 2].id : null), disabled: ro || end >= s.instances.length - 1 || copy },
      { label: "Copy in a row…", rule: true, run: () => assembly.ask({ title: "Copy in a row", acceptLabel: "Copy", fields: [{ key: "count", label: "Copies", kind: "number", value: 2 }, { key: "x", label: "Step X", kind: "number", value: 50, unit: "mm" }, { key: "y", label: "Step Y", kind: "number", value: 0, unit: "mm" }, { key: "z", label: "Step Z", kind: "number", value: 0, unit: "mm" }], accept: (v) => assembly.copyInRow(ids, Number(v.count), [Number(v.x), Number(v.y), Number(v.z)]) }), disabled: ro },
      { label: "Linear pattern…", run: withSelection(() => askPattern(assembly, "linear")), disabled: ro || copy },
      { label: "Circular pattern…", run: withSelection(() => askPattern(assembly, "circular")), disabled: ro || copy },
      { label: "Replicate", run: () => { const n = assembly.replicate(one!.id); if (!n) assembly.host.toast("Nothing to replicate: the instance needs a mate on a round edge or a hole of a part that has more holes of that size.", 6000); }, disabled: ro || !one },
      ...supplierMenu(one),
      { label: "Delete", run: () => assembly.remove(ids), danger: true, disabled: ro, rule: true },
    ];
    setMenu({ x: ev.clientX, y: ev.clientY, items: list });
  };
  const groupMenu = (id: string, members: string[], ev: React.MouseEvent) => {
    ev.preventDefault();
    const ro = !s.canEdit;
    setMenu({ x: ev.clientX, y: ev.clientY, items: [
      { label: "Rename", run: () => assembly.startRename(id), disabled: ro },
      { label: "Select its instances", run: () => assembly.select(members) },
      { label: "Hide", run: () => assembly.setHidden(members, true), disabled: ro },
      { label: "Show", run: () => assembly.setHidden(members, false), disabled: ro },
      { label: "Ungroup", run: () => assembly.ungroup(id), disabled: ro },
    ] });
  };
  const patternMenu = (id: string, members: string[], ev: React.MouseEvent) => {
    ev.preventDefault();
    const p = s.patterns.find((x) => x.id === id), ro = !s.canEdit;
    if (!p) return;
    assembly.select(id);
    setMenu({ x: ev.clientX, y: ev.clientY, items: [
      { label: "Edit…", run: () => askEditPattern(assembly, p), disabled: ro },
      { label: "Rename", run: () => assembly.startRename(id), disabled: ro },
      { label: "Select its copies", run: () => assembly.select(members) },
      { label: "Dissolve", run: () => assembly.dissolvePattern(id), disabled: ro },
      { label: "Delete", run: () => assembly.remove([id]), danger: true, disabled: ro, rule: true },
    ] });
  };
  const flip = (set: ReadonlySet<string>, id: string): Set<string> => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };
  // dragging rows: onto an instance puts them before it (and in its folder); onto a folder, into it
  const dragStart = (id: string, ev: React.DragEvent) => {
    const ids = selected.has(id) ? s.instances.filter((i) => selected.has(i.id)).map((i) => i.id) : [id];
    ev.dataTransfer.setData("application/x-junction-instances", ids.join(" ")); ev.dataTransfer.effectAllowed = "move";
  };
  const over = (key: string, ev: React.DragEvent) => { if (!s.canEdit || !ev.dataTransfer.types.includes("application/x-junction-instances")) return; ev.preventDefault(); if (drop !== key) setDrop(key); };
  const dropped = (ev: React.DragEvent, before: string | null, group?: string | null) => {
    ev.preventDefault(); setDrop(null);
    const ids = ev.dataTransfer.getData("application/x-junction-instances").split(" ").filter((id) => id && id !== before);
    if (ids.length) assembly.moveInstances(ids, before, group);
  };

  const shown = s.instances.filter((i) => !i.suppressed).length;
  return (
    <section className="flex flex-col min-h-0 flex-[2_1_0] border-b border-line" data-panel="instances">
      <Caption right={<button type="button" className="btn sm ghost px-0.5 h-5" disabled={!s.canEdit} aria-label="New folder" data-new-folder {...tipHandlers({ title: "New folder", hint: "A folder in the list. Drag instances into it." })} onClick={() => assembly.newFolder()}><Glyph svg={ICONS.folderPlus} size={15} /></button>}>
        Instances <span className="font-normal text-ink-3" data-count>({s.instances.length})</span>
      </Caption>
      <div className="flex-none px-1.5 py-1 border-b border-line bg-paper">
        <input className="input w-full h-6" type="search" placeholder="Filter by name" aria-label="Filter instances by name" value={filter} data-tree-filter onChange={(ev) => setFilter(ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Escape") setFilter(""); }} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto bg-paper py-1 text-sm outline-none" role="tree" tabIndex={0} aria-label="Instances" aria-multiselectable="true" onClick={(ev) => { if (ev.target === ev.currentTarget) assembly.select(null); }}
        onDragOver={(ev) => over("end", ev)} onDrop={(ev) => dropped(ev, null, null)}>
        {s.loaded && !q ? (
          <div className="flex items-center gap-1.5 h-6.5 pl-2 pr-2 font-medium cursor-default" data-root title={s.dof === null ? undefined : s.dof === 0 ? "Fully held: nothing can move." : `${s.dof} freedom${s.dof === 1 ? "" : "s"} left in the whole assembly.`} onClick={() => assembly.select(null)}>
            <Glyph svg={ICONS.assembly} size={15} /><span className="flex-1 truncate">{stem(assembly.host.doc.path)}</span>
            <span className="flex-none text-xs font-normal text-ink-3">{shown < s.instances.length ? `${shown} of ${s.instances.length} in use` : ""}</span>
          </div>
        ) : null}
        {rows.map((r) => {
          if (r.kind === "piece") return <div key={r.key} className="flex items-center gap-1.5 h-6 pr-2 text-ink-3 cursor-default" style={{ paddingLeft: 8 + r.depth * 16 + 18 }} data-inner={r.name}><Glyph svg={ICONS.part} size={13} /><span className="flex-1 truncate">{r.name}</span></div>;
          if (r.kind === "group" || r.kind === "pattern") {
            const folded = r.kind === "group" ? r.collapsed : closedPatterns.has(r.id);
            const attrs = r.kind === "group" ? { "data-group": r.name } : { "data-pattern": r.name };
            return (
              <div key={r.id} role="treeitem" aria-expanded={!folded} aria-selected={selected.has(r.id)} {...attrs} className={cx("flex items-center gap-1 h-6.5 px-1 cursor-default", selected.has(r.id) ? "bg-sel" : "hover:bg-sel-soft", drop === r.id && "outline outline-1 outline-[var(--blue)] -outline-offset-1")}
                onClick={() => assembly.select(r.id)} onContextMenu={(ev) => (r.kind === "group" ? groupMenu(r.id, r.members, ev) : patternMenu(r.id, r.members, ev))} onDoubleClick={() => { if (s.canEdit) assembly.startRename(r.id); }}
                onDragOver={r.kind === "group" ? (ev) => { ev.stopPropagation(); over(r.id, ev); } : undefined} onDrop={r.kind === "group" ? (ev) => { ev.stopPropagation(); dropped(ev, null, r.id); } : undefined}>
                <button type="button" className={cx("btn sm ghost px-0.5 transition-transform", !folded && "rotate-90")} title={folded ? "Open" : "Close"} aria-label={folded ? `Open ${r.name}` : `Close ${r.name}`} onClick={(ev) => { ev.stopPropagation(); if (r.kind === "group") assembly.setCollapsed(r.id, !r.collapsed); else setClosedPatterns(flip(closedPatterns, r.id)); }}><Glyph svg={ICONS.chevron} size={14} /></button>
                <Glyph svg={r.kind === "group" ? ICONS.folder : ICONS.pattern} size={15} />
                {s.renaming === r.id ? <NameField name={r.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(r.id, n))} /> : <span className="flex-1 truncate font-medium">{r.name}</span>}
                <span className="flex-none text-xs text-ink-3 pr-1">{r.members.length || ""}</span>
              </div>
            );
          }
          const i = r.item, info = s.instanceInfo[i.id], b = badge(s, i, info), sub = i.source.kind === "assembly", copy = !!memberOf(i);
          return (
            <div key={i.id} role="treeitem" aria-selected={selected.has(i.id)} aria-expanded={sub ? open.has(i.id) : undefined} data-instance={i.name} data-status={info?.status} data-state={b?.state} title={b?.title} draggable={s.canEdit && !copy && s.renaming !== i.id}
              className={cx("group flex items-center gap-1.5 h-6.5 pr-2 cursor-default", selected.has(i.id) ? "bg-sel" : "hover:bg-sel-soft", (i.suppressed || i.hidden) && "text-ink-3", b?.tone === "err" && "text-err", drop === i.id && "shadow-[inset_0_1px_0_var(--blue)]")} style={{ paddingLeft: 8 + r.depth * 16 }}
              onClick={(ev) => click(i.id, ev)} onContextMenu={(ev) => openMenu(i.id, ev)} onDoubleClick={() => { if (s.canEdit) assembly.startRename(i.id); }}
              onDragStart={(ev) => dragStart(i.id, ev)} onDragOver={(ev) => { ev.stopPropagation(); if (!copy) over(i.id, ev); }} onDragLeave={() => { if (drop === i.id) setDrop(null); }} onDrop={(ev) => { ev.stopPropagation(); if (!copy) dropped(ev, i.id); }}>
              {sub ? <button type="button" className={cx("btn sm ghost px-0 -ml-1 transition-transform", open.has(i.id) && "rotate-90")} aria-label={open.has(i.id) ? `Close ${i.name}` : `Open ${i.name}`} data-expand onClick={(ev) => { ev.stopPropagation(); setOpen(flip(open, i.id)); }}><Glyph svg={ICONS.chevron} size={13} /></button> : null}
              <Glyph svg={kindIcon(i)} size={15} />
              {s.renaming === i.id ? <NameField name={i.name} done={(n) => (n === null ? assembly.startRename(null) : assembly.rename(i.id, n))} /> : <span className={cx("flex-1 truncate", i.suppressed && "line-through")}>{i.name}</span>}
              <SupplierMark instance={i} />
              {i.fixed && !i.suppressed ? <Glyph svg={ICONS.pin} size={13} /> : null}
              {b ? <span className={cx("flex-none text-xs", b.tone === "err" ? "text-err font-semibold" : b.tone === "dim" ? "text-ink-3" : "text-ink-2")} data-badge>{b.text}</span> : null}
              <button type="button" className={cx("btn sm ghost px-0.5", !i.hidden && "opacity-0 group-hover:opacity-100 focus:opacity-100")} disabled={!s.canEdit} title={i.hidden ? "Show" : "Hide"} aria-label={i.hidden ? `Show ${i.name}` : `Hide ${i.name}`} data-eye
                onClick={(ev) => { ev.stopPropagation(); assembly.setHidden([i.id], !i.hidden); }}><Glyph svg={i.hidden ? ICONS.eyeOff : ICONS.eye} size={14} /></button>
            </div>
          );
        })}
        {s.loaded && !s.instances.length ? <p className="note px-2 m-0">Nothing is placed in this assembly yet. Use Insert to add parts.</p> : null}
        {s.loaded && s.instances.length && q && !rows.length ? <p className="note px-2 m-0" data-no-match>No instance is called that.</p> : null}
        {!s.loaded ? <p className="note px-2 m-0">Loading…</p> : null}
      </div>
      <ContextMenu menu={menu} close={() => setMenu(null)} />
    </section>
  );
}
