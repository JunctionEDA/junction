// Toolbar.tsx — the assembly's toolbar, drawn as the part studio's is (mechanical ui/Toolbar.tsx) from the same
// shapes (ui/commands.ts builds the sections from the registries; nothing is listed here by hand):
//
//   undo redo │ Insert │ the mates, one button each │ Mate connector Group Fix │ Relations ▾ │ Pattern ▾ │
//   Exploded view Named position Animate │ Bill of materials Interference Section view Measure Mass properties │
//   History │ More ▾                                                              Search tools… S   (✓ ✗ in a mate)
//
// One button is one tool, drawn as its icon, with a tooltip of its name, its key and a line on what it does.  A
// family is one button and a caret: the face runs the one used last, the caret lists them.  The bar never
// scrolls: in a window too narrow for every button, the ones that keep their place least go under "More ▾",
// which also holds what is used less at any width.  The tool search is always at the right end.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import { Glyph, hideTip, tipHandlers, tipText, type Entry, type Section, type Slot } from "../../mechanical/api-ui";
import type { AssemblyEditor } from "./assembly";
import { lastUsed, rememberUsed, toolbarSections } from "./commands";
import { usePref } from "./keys";
import { useAssembly } from "./parts";

const CARET = '<path d="M7 10l5 5 5-5"/>';
export const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
export const CROSS = '<path d="M6 6l12 12M18 6L6 18"/>';
export const SEARCH = '<circle cx="10.5" cy="10.5" r="6"/><path d="M20 20l-5-5"/>';
const MORE = "More";
const ICON = 24, SECTION_PAD = 9, GAP = 2;

function Button({ e, label, variant }: { e: Entry; label: boolean; variant?: boolean }) {
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-1.5 h-8 min-h-0 text-ink", label ? "px-2 text-base font-medium" : "p-0 w-8 justify-center", e.on && "on", e.why && "opacity-40", variant && "rounded-r-none")} aria-pressed={e.on || undefined} aria-disabled={e.why ? true : undefined}
      aria-label={e.title} aria-description={tipText(e)} data-tool={e.title} data-tool-id={e.id} data-mate-tool={e.id.startsWith("m:") ? e.id.slice(2) : undefined} data-variant={variant || undefined} {...tipHandlers(e)} onClick={() => { hideTip(); if (!e.why) e.run(); }}>
      <Glyph svg={e.icon} size={ICON} />{label ? <span>{e.title}</span> : null}
    </button>
  );
}

function Caret({ title, entries, open, toggle }: { title: string; entries: Entry[]; open: boolean; toggle(at: DOMRect | null): void }) {
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center justify-center p-0 w-3.5 h-8 min-h-0 rounded-l-none text-ink-2", open && "on")} aria-haspopup="menu" aria-expanded={open}
      aria-label={`${title}: more`} data-menu={title} data-items={entries.map((e) => e.title).join("|")} {...tipHandlers({ title, hint: entries.map((e) => e.title).join(", ") })}
      onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { hideTip(); toggle(open ? null : (ev.currentTarget.parentElement || ev.currentTarget).getBoundingClientRect()); }}>
      <Glyph svg={CARET} size={12} />
    </button>
  );
}

interface OpenMenu { key: string; at: DOMRect }
interface MenuGroup { title: string | null; entries: Entry[] }

export function Toolbar({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);   // a button's `disabled` and `active` may read any of it
  usePref("toolVariant");
  const sections = toolbarSections(assembly);

  // ---- how much room there is: the buttons that keep their place least go under More
  const bar = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const [narrow, setNarrow] = useState(false);
  const sig = sections.map((x) => x.id + ":" + x.slots.map((y) => y.key).join(",")).join(";");
  const fitRef = useRef<() => void>(() => undefined);
  fitRef.current = () => {
    const el = bar.current; if (!el) return;
    for (const n of Array.from(el.querySelectorAll<HTMLElement>("[data-slot]"))) widths.current.set(n.dataset.slot!, n.offsetWidth);
    let fixed = 0;
    for (const n of Array.from(el.querySelectorAll<HTMLElement>("[data-fixed]"))) fixed += n.offsetWidth;
    const room = el.clientWidth - fixed - 8, out = new Set<string>();
    const need = () => {
      let t = 0;
      for (const sec of sections) {
        const on = sec.slots.filter((x) => x.keep > 0 && !out.has(x.key));
        if (on.length) t += SECTION_PAD + on.reduce((n, x) => n + (widths.current.get(x.key) ?? 34), 0) + GAP * (on.length - 1);
      }
      return t;
    };
    const order = sections.flatMap((sec) => sec.slots).map((x, i) => ({ x, i })).filter((y) => y.x.keep > 0 && y.x.keep < 100).sort((p, q) => p.x.keep - q.x.keep || q.i - p.i);
    for (const y of order) { if (need() <= room) break; out.add(y.x.key); }
    if (Array.from(moved).sort().join("|") !== Array.from(out).sort().join("|")) setMoved(out);
    const tight = el.clientWidth < 1240;
    if (tight !== narrow) setNarrow(tight);
  };
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    fitRef.current();
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [sig]);
  useLayoutEffect(() => { fitRef.current(); });

  // ---- the open drop-down
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(null);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setMenu(null); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", away); window.addEventListener("blur", away);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", away); window.removeEventListener("blur", away); };
  }, [menu]);
  let shown: { key: string; title: string; groups: MenuGroup[]; remember: boolean } | null = null;

  const onBar = (x: Slot) => x.keep > 0 && !moved.has(x.key);
  const slotView = (sec: Section, slot: Slot) => {
    if (slot.menu === null) return <span key={slot.key} className="flex flex-none" data-slot={slot.key}><Button e={slot.entries[0]} label={!!sec.labelled} /></span>;
    const open = !!menu && menu.key === slot.key;
    if (open) shown = { key: slot.key, title: slot.menu, groups: [{ title: null, entries: slot.entries }], remember: true };
    return (
      <span key={slot.key} className="flex flex-none items-center rounded-sm hover:bg-paper" data-slot={slot.key} data-split>
        <Button e={lastUsed(slot.key, slot.entries)} label={false} variant />
        <Caret title={slot.menu} entries={slot.entries} open={open} toggle={(at) => setMenu(at ? { key: slot.key, at } : null)} />
      </span>
    );
  };
  const groups = sections.filter((sec) => sec.slots.some(onBar)).map((sec) => (
    <div key={sec.id} className="flex flex-none items-center gap-0.5 px-1 border-r border-line h-6" data-group={sec.group} data-section={sec.id}>{sec.slots.filter(onBar).map((slot) => slotView(sec, slot))}</div>
  ));

  // ---- More: what is used less, and what the window has no room for
  const rest: MenuGroup[] = sections.map((sec) => ({ title: sec.title, entries: sec.slots.filter((x) => !onBar(x)).flatMap((x) => x.entries) })).filter((g) => g.entries.length);
  const moreOpen = !!menu && menu.key === MORE;
  if (moreOpen) shown = { key: MORE, title: MORE, groups: rest, remember: false };
  const more = rest.length ? (
    <div className="flex flex-none items-center px-1.5" data-group="more" data-fixed>
      <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-0.5 h-8 min-h-0 pl-2 pr-1 text-base font-medium text-ink", moreOpen && "on")} aria-haspopup="menu" aria-expanded={moreOpen} aria-label="More tools"
        data-menu={MORE} data-items={rest.flatMap((g) => g.entries.map((e) => e.title)).join("|")} {...tipHandlers({ title: "More tools", hint: rest.map((g) => g.title).join(", ") + "." })}
        onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { hideTip(); setMenu(moreOpen ? null : { key: MORE, at: ev.currentTarget.getBoundingClientRect() }); }}>
        <span>More</span><Glyph svg={CARET} size={14} />
      </button>
    </div>
  ) : null;

  const list = shown as { key: string; title: string; groups: MenuGroup[]; remember: boolean } | null;
  const confirm = (title: string, icon: string, primary: boolean, run: () => void, o: { shortcut?: string; hint?: string; label?: string } = {}) => (
    <button type="button" className={cx("btn sm flex flex-none items-center gap-1 h-8 min-h-0", primary ? "primary px-2.5" : "ghost p-0 w-8 justify-center text-ink", o.label && "text-base font-medium")} aria-label={title} data-tool={title} {...tipHandlers({ title, shortcut: o.shortcut, hint: o.hint })} onClick={() => { hideTip(); run(); assembly.viewport.canvas.focus(); }}>
      <Glyph svg={icon} size={18} />{o.label ? <span>{o.label}</span> : null}
    </button>
  );
  return (
    <div ref={bar} className="cad-toolbar flex items-center h-11 bg-bench border-b border-line overflow-hidden select-none" role="toolbar" aria-label="Assembly tools" data-mode={s.mating ? "mate" : s.canEdit ? "model" : "view"} data-moved={moved.size}>
      {groups}
      {more}
      <div className="flex-1 min-w-0" data-spring="1" />
      <div className="flex flex-none items-center px-2" data-fixed>
        <button type="button" className={cx("cad-tool-search appearance-none m-0 [font-family:inherit] flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-sm border border-line bg-panel text-base text-ink-2 cursor-text hover:border-line-2", narrow ? "w-40" : "w-48")} aria-label="Search tools" aria-haspopup="dialog" data-tool-search
          {...tipHandlers({ title: "Search tools", shortcut: "S", hint: "Find any tool by its name, or by another word for it: joint, hinge, ground, BOM. Also Ctrl+K and Alt+C." })}
          onClick={(ev) => { hideTip(); const r = ev.currentTarget.getBoundingClientRect(); assembly.setUi({ palette: { x: null, y: null, under: { left: r.left, top: r.top, width: r.width, right: r.right } } }); }}>
          <Glyph svg={SEARCH} size={16} /><span className="flex-1 text-left truncate">Search tools…</span><span className="kbd">S</span>
        </button>
      </div>
      {s.mating ? (
        <div className="flex flex-none items-center gap-1 pl-2 pr-2 border-l border-line h-6" data-group="confirm" data-fixed>
          {confirm("Accept", CHECK, true, () => assembly.acceptMate(), { shortcut: "Enter", hint: "Keep the mate." })}
          {confirm("Cancel", CROSS, false, () => assembly.cancelMate(), { shortcut: "Esc", hint: "Close the dialog and change nothing." })}
        </div>
      ) : null}
      {menu && list ? (
        <div className="cad-tb-menu fixed z-[50] min-w-56 max-h-[78vh] overflow-y-auto py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" aria-label={list.title} data-menu-of={list.title} onPointerDown={(ev) => ev.stopPropagation()}
          style={{ left: Math.max(4, Math.min(menu.at.left, window.innerWidth - 260)), top: menu.at.bottom + 4 }}>
          {list.groups.map((g, gi) => (
            <div key={g.title || gi} role="group" aria-label={g.title || undefined} className={cx(gi > 0 && "mt-1 pt-1 border-t border-line")}>
              {g.title ? <div className="px-3 pt-1 pb-0.5 text-2xs uppercase tracking-wider text-ink-3 mono">{g.title}</div> : null}
              {g.entries.map((e) => (
                <button key={e.id} type="button" role={e.on ? "menuitemcheckbox" : "menuitem"} aria-checked={e.on ? true : undefined} className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2.5 px-3 h-8 text-left cursor-pointer hover:bg-sel-soft", e.on && "font-semibold bg-sel-soft", e.why && "opacity-40")} aria-disabled={e.why ? true : undefined}
                  data-tool={e.title} data-tool-id={e.id} {...tipHandlers(e)} onClick={() => { hideTip(); if (e.why) return; setMenu(null); if (list.remember) rememberUsed(list.key, e); e.run(); }}>
                  <Glyph svg={e.icon} size={20} /><span className="flex-1 whitespace-nowrap">{e.title}</span>{e.shortcut ? <span className="kbd ml-3">{e.shortcut}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
