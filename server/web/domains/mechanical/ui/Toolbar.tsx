// Toolbar.tsx — the part studio's toolbar.  It shows the tools of the mode the studio is in and nothing else
// (ui/commands.ts builds the list from the registries; nothing is listed here by hand):
//
//   modelling   undo redo │ Sketch │ Extrude Revolve Sweep Loft … │ Fillet ▾ Chamfer Draft … Shell Hole │ Boolean Split
//               Transform ▾ … │ Direct edit ▾ │ Pattern ▾ Mirror │ Surface ▾ │ Plane ▾ Curve ▾ … │ Frames ▾ │ Sheet metal ▾ │
//               Board ▾ │ Measure Section │ History │ More ▾   Search tools… S
//   in a sketch undo redo │ draw │ modify │ constraints │ Dimension │ Extrude Revolve │ More ▾   Search tools… S  ✓  ✗
//   in a dialog what is being edited, what a click will pick │ More ▾                         Search tools… S  ✓  ✗
//
// One button is one tool, drawn as its icon.  A tool with variants is one button and a caret: the face runs the
// variant used last (remembered in this browser), the caret opens the list.  So is a specialist section (direct
// editing, surfacing, frames, sheet metal: commands.ts GROUPS), its families apart between rules in the list.  Every button has a tooltip with its
// name, its key and a line on what it does (Tip.tsx).
//
// The bar never scrolls and never crams.  When the window is too narrow for every button, the ones that keep
// their place least (a tool's `keep`, a feature's `toolbarKeep`) move under "More ▾" at the end of the tools,
// which also holds what is used less at any width (the view options, import and export, comments, delete).  Everything stays
// reachable, there and in the tool search, whose field is always at the right end of the bar.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { subscribeTools, toolsRevision } from "../core/tool";
import { cx } from "../../../shared/util";
import { lastUsed, modeOf, rememberUsed, toolbarSections, type Entry, type Section, type Slot } from "./commands";
import { describeKinds } from "./fields";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { usePref } from "./prefs";
import { awaitsPlane, featureDef, type PartStudio } from "./studio";
import { hideTip, tipHandlers, tipText } from "./Tip";

const CARET = '<path d="M7 10l5 5 5-5"/>';
export const CHECK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
export const CROSS = '<path d="M6 6l12 12M18 6L6 18"/>';
export const SEARCH = '<circle cx="10.5" cy="10.5" r="6"/><path d="M20 20l-5-5"/>';
const MORE = "More";
/** the icon of a button on the bar, in pixels */
const ICON = 24;
/** what a section costs besides its buttons (its padding and its rule), and the gap between two buttons */
const SECTION_PAD = 9, GAP = 2;

function Button({ e, label, variant }: { e: Entry; label: boolean; variant?: boolean }) {
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-1.5 h-8 min-h-0 text-ink", label ? "px-2 text-base font-medium" : "p-0 w-8 justify-center", e.on && "on", e.why && "opacity-40", variant && "rounded-r-none")} aria-pressed={e.on || undefined} aria-disabled={e.why ? true : undefined}
      aria-label={e.title} aria-description={tipText(e)} data-tool={e.title} data-tool-id={e.id} data-variant={variant || undefined} {...tipHandlers(e)} onClick={() => { hideTip(); if (!e.why) e.run(); }}>
      <Glyph svg={e.icon} size={ICON} />{label ? <span>{e.title}</span> : null}
    </button>
  );
}

/** The caret of a family: it opens the list of its variants. */
function Caret({ title, entries, open, toggle }: { title: string; entries: Entry[]; open: boolean; toggle(at: DOMRect | null): void }) {
  const why = entries.every((e) => e.why) ? entries[0].why : null;
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center justify-center p-0 w-3.5 h-8 min-h-0 rounded-l-none text-ink-2", open && "on", why && "opacity-40")} aria-haspopup="menu" aria-expanded={open}
      aria-label={`${title}: more`} data-menu={title} data-items={entries.map((e) => e.title).join("|")}
      {...tipHandlers({ title, hint: entries.map((e) => e.title).join(", "), why })}
      onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { hideTip(); toggle(open ? null : (ev.currentTarget.parentElement || ev.currentTarget).getBoundingClientRect()); }}>
      <Glyph svg={CARET} size={12} />
    </button>
  );
}

/** What the open dialog is waiting for, in the bar while a dialog has taken the tools' place. */
function DialogContext({ studio }: { studio: PartStudio }) {
  const editing = useStudio(studio, (s) => s.editing);
  if (!editing) return null;
  const def = featureDef(editing.draft.featureType);
  const field = def && editing.field ? def.schema.find((f) => f.key === editing.field) : undefined;
  const kinds = studio.pickFilter();
  return (
    <div className="flex flex-initial items-center gap-2 pl-3 pr-2 min-w-0 text-base" data-group="context">
      <span className="flex-none text-ink"><Glyph svg={def?.icon} size={ICON} /></span>
      <span className="font-semibold truncate">{editing.draft.name}</span>
      <span className="text-ink-2 truncate" data-context-hint>{field ? `${field.label}: click ${describeKinds(kinds)} in the model` : "Set the values, then accept"}</span>
    </div>
  );
}

interface OpenMenu { key: string; at: DOMRect }
interface MenuGroup { title: string | null; group: string; entries: Entry[] }

export function Toolbar({ studio }: { studio: PartStudio }) {
  // every slice a button's `disabled` / `active` may read: the toolbar redraws when one changes
  const sketch = useStudio(studio, (s) => !!s.sketch);
  const waiting = useStudio(studio, (s) => awaitsPlane(s));
  const editing = useStudio(studio, (s) => !!s.editing);
  useStudio(studio, (s) => s.canEdit); useStudio(studio, (s) => s.editing?.field); useStudio(studio, (s) => s.sketch?.tool);
  useStudio(studio, (s) => s.selection); useStudio(studio, (s) => s.selectedFeature);
  useStudio(studio, (s) => s.canUndo); useStudio(studio, (s) => s.canRedo); useStudio(studio, (s) => s.planesVisible);
  useSyncExternalStore(subscribeTools, toolsRevision);   // tools with state of their own (core/tool.ts toolsChanged)
  useStudio(studio, (s) => s.bodies);
  useStudio(studio, (s) => s.ui); useStudio(studio, (s) => s.past);
  usePref("toolVariant");

  const mode = modeOf(studio);
  const sections = toolbarSections(studio);

  // ---- how much room there is: the buttons that keep their place least go under More
  const bar = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const [moved, setMoved] = useState<{ sig: string; keys: ReadonlySet<string> }>({ sig: "", keys: new Set() });
  const [narrow, setNarrow] = useState(false);
  // the search field gives up some of its width before a tool gives up its button
  const [wide, setWide] = useState(true);
  const sig = mode + ":" + sections.map((s) => s.id + ":" + s.slots.map((x) => x.key).join(",")).join(";");
  const fitRef = useRef<() => void>(() => undefined);
  fitRef.current = () => {
    const el = bar.current; if (!el) return;
    for (const n of Array.from(el.querySelectorAll<HTMLElement>("[data-slot]"))) widths.current.set(n.dataset.slot!, n.offsetWidth);
    let fixed = 0;
    for (const n of Array.from(el.querySelectorAll<HTMLElement>("[data-fixed]"))) fixed += n.offsetWidth;
    const room = el.clientWidth - fixed - 8;
    const out = new Set<string>();
    const need = () => {
      let t = 0;
      for (const sec of sections) {
        const on = sec.slots.filter((s) => s.keep > 0 && !out.has(s.key));
        if (on.length) t += SECTION_PAD + on.reduce((n, s) => n + (widths.current.get(s.key) ?? 34), 0) + GAP * (on.length - 1);
      }
      return t;
    };
    // the first to go: the lowest `keep`, and of two alike the one further along the bar
    const order = sections.flatMap((sec) => sec.slots).map((s, i) => ({ s, i })).filter((x) => x.s.keep > 0 && x.s.keep < 100).sort((a, b) => a.s.keep - b.s.keep || b.i - a.i);
    for (const x of order) { if (need() <= room) break; out.add(x.s.key); }
    const keys = Array.from(out).sort().join("|");
    if (moved.sig !== sig || Array.from(moved.keys).sort().join("|") !== keys) setMoved({ sig, keys: out });
    const tight = el.clientWidth < 1240, roomy = el.clientWidth >= 1700;
    if (tight !== narrow) setNarrow(tight);
    if (roomy !== wide) setWide(roomy);
  };
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    fitRef.current();
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [sig]);
  useLayoutEffect(() => { fitRef.current(); });
  // the buttons moved for another mode's bar say nothing about this one: show them all, measure, then move
  const out = moved.sig === sig ? moved.keys : new Set<string>();

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
  useEffect(() => setMenu(null), [mode]);
  let shown: { key: string; title: string; groups: MenuGroup[]; remember: boolean } | null = null;

  const onBar = (s: Slot) => s.keep > 0 && !out.has(s.key);
  const slotView = (sec: Section, slot: Slot) => {
    if (slot.menu === null) return <span key={slot.key} className="flex flex-none" data-slot={slot.key}><Button e={slot.entries[0]} label={!!sec.labelled} /></span>;
    const open = !!menu && menu.key === slot.key;
    if (open) shown = { key: slot.key, title: slot.menu, groups: (slot.parts || [slot.entries]).map((entries, i) => ({ title: slot.partTitles?.[i] ?? null, group: sec.group, entries })), remember: true };
    const face = lastUsed(slot.key, slot.entries);
    return (
      <span key={slot.key} className="flex flex-none items-center rounded-sm hover:bg-paper" data-slot={slot.key} data-split>
        <Button e={face} label={!!sec.labelled} variant />
        <Caret title={slot.menu} entries={slot.entries} open={open} toggle={(at) => setMenu(at ? { key: slot.key, at } : null)} />
      </span>
    );
  };
  const groups = sections.filter((sec) => sec.slots.some(onBar)).map((sec) => (
    <div key={sec.id} className="flex flex-none items-center gap-0.5 px-1 border-r border-line h-6" data-group={sec.group} data-section={sec.id}>{sec.slots.filter(onBar).map((slot) => slotView(sec, slot))}</div>
  ));

  // ---- More: what is used less, and what the window has no room for
  const rest: MenuGroup[] = sections.map((sec) => ({ title: sec.title, group: sec.group, entries: sec.slots.filter((s) => !onBar(s)).flatMap((s) => s.entries) })).filter((g) => g.entries.length);
  const moreOpen = !!menu && menu.key === MORE;
  if (moreOpen) shown = { key: MORE, title: MORE, groups: rest, remember: false };
  const more = rest.length ? (
    <div className="flex flex-none items-center px-1.5" data-group="more" data-fixed>
      <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-0.5 h-8 min-h-0 pl-2 pr-1 text-base font-medium text-ink", moreOpen && "on")} aria-haspopup="menu" aria-expanded={moreOpen} aria-label="More tools"
        data-menu={MORE} data-items={rest.flatMap((g) => g.entries.map((e) => e.title)).join("|")} data-item-groups={rest.flatMap((g) => g.entries.map(() => g.group)).join("|")}
        {...tipHandlers({ title: "More tools", hint: rest.map((g) => g.title).join(", ") + "." })}
        onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => { hideTip(); setMenu(moreOpen ? null : { key: MORE, at: ev.currentTarget.getBoundingClientRect() }); }}>
        <span>More</span><Glyph svg={CARET} size={14} />
      </button>
    </div>
  ) : null;

  const list = shown as { key: string; title: string; groups: MenuGroup[]; remember: boolean } | null;
  // a long list (the library's families) is laid out in columns, as many as keep it on the page
  const rows = list ? list.groups.reduce((n, g) => n + g.entries.length + (g.title ? 1 : 0), 0) : 0;
  const cols = list && list.key !== MORE && rows > 24 ? Math.max(1, Math.min(Math.floor((window.innerWidth - 16) / 232), Math.ceil((rows * 32) / (window.innerHeight * 0.66)))) : 1;
  const confirm = (title: string, icon: string, primary: boolean, run: () => void, o: { shortcut?: string; hint?: string; label?: string; why?: string | null } = {}) => (
    <button type="button" className={cx("btn sm flex flex-none items-center gap-1 h-8 min-h-0", primary ? "primary px-2.5" : "ghost p-0 w-8 justify-center text-ink", o.label && "text-base font-medium", o.why && "opacity-40")} aria-label={title} aria-disabled={o.why ? true : undefined} data-tool={title} {...tipHandlers({ title, shortcut: o.shortcut, hint: o.hint, why: o.why })} onClick={() => { hideTip(); if (o.why) return; run(); studio.viewport.canvas.focus(); }}>
      <Glyph svg={icon} size={18} />{o.label ? <span>{o.label}</span> : null}
    </button>
  );
  const search = (
    <div className="flex flex-none items-center px-2" data-fixed>
      <button type="button" className={cx("cad-tool-search appearance-none m-0 [font-family:inherit] flex items-center gap-2 h-8 pl-2.5 pr-1.5 rounded-sm border border-line bg-panel text-base text-ink-2 cursor-text hover:border-line-2", narrow ? "w-40" : wide ? "w-52" : "w-44")} aria-label="Search tools" aria-haspopup="dialog" data-tool-search
        {...tipHandlers({ title: "Search tools", shortcut: "S", hint: "Find any tool or feature by its name, or by another word for it: cut, round, pocket. Also Ctrl+K." })}
        onClick={(ev) => { hideTip(); const r = ev.currentTarget.getBoundingClientRect(); studio.setUi({ palette: { x: null, y: null, under: { left: r.left, top: r.top, width: r.width, right: r.right } } }); }}>
        <Glyph svg={SEARCH} size={16} /><span className="flex-1 text-left truncate">Search tools…</span><span className="kbd">S</span>
      </button>
    </div>
  );
  return (
    <div ref={bar} className="cad-toolbar flex items-center h-11 bg-bench border-b border-line overflow-hidden select-none" role="toolbar" aria-label={mode === "sketch" ? "Sketch tools" : "Part studio tools"} data-mode={mode} data-waiting={waiting || undefined} data-moved={out.size}>
      {mode === "dialog" ? <DialogContext studio={studio} /> : null}
      {groups}
      {more}
      <div className="flex-1 min-w-0" data-spring="1" />
      {search}
      {sketch || waiting ? (
        <div className="flex flex-none items-center gap-1 pl-2 pr-2 border-l border-line h-6" data-group="confirm" data-fixed>
          {confirm("Finish sketch", CHECK, true, () => studio.finishSketch(), { hint: "Keep the sketch and go back to the part.", label: narrow ? undefined : "Finish sketch", why: waiting ? "Select the sketch plane first" : null })}
          {confirm("Cancel sketch", CROSS, false, () => (waiting ? studio.cancelFeature() : studio.cancelSketch()), { shortcut: waiting ? "Esc" : undefined, hint: waiting ? "Close and make no sketch." : "Leave the sketch as it was when you opened it. Undo brings the changes back." })}
        </div>
      ) : editing ? (
        <div className="flex flex-none items-center gap-1 pl-2 pr-2 border-l border-line h-6" data-group="confirm" data-fixed>
          {confirm("Accept", CHECK, true, () => studio.acceptFeature(), { shortcut: "Enter", hint: "Keep the feature." })}
          {confirm("Cancel", CROSS, false, () => studio.cancelFeature(), { shortcut: "Esc", hint: "Close the dialog and change nothing." })}
        </div>
      ) : null}
      {menu && list ? (
        <div className="cad-tb-menu fixed z-[50] min-w-56 max-h-[78vh] overflow-y-auto py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" aria-label={list.title} data-menu-of={list.title} data-columns={cols} onPointerDown={(ev) => ev.stopPropagation()}
          style={{ left: Math.max(4, Math.min(menu.at.left, window.innerWidth - (cols > 1 ? cols * 232 + 12 : 240))), top: menu.at.bottom + 4, ...(cols > 1 ? { columnCount: cols, columnGap: 0, width: cols * 232 } : null) }}>
          {list.groups.map((g, gi) => (
            <div key={g.title || gi} role="group" aria-label={g.title || undefined} className={cx(gi > 0 && cols === 1 && "mt-1 pt-1 border-t border-line", cols > 1 && "pb-2")}>
              {g.title ? <div className="px-3 pt-1 pb-0.5 text-2xs uppercase tracking-wider text-ink-3 mono">{g.title}</div> : null}
              {g.entries.map((e) => (
                <button key={e.id} type="button" role={e.on ? "menuitemcheckbox" : "menuitem"} aria-checked={e.on ? true : undefined} className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2.5 px-3 h-8 text-left cursor-pointer hover:bg-sel-soft", e.on && "font-semibold bg-sel-soft", e.why && "opacity-40")} aria-disabled={e.why ? true : undefined}
                  data-tool={e.title} {...tipHandlers(e)} onClick={() => { hideTip(); if (e.why) return; setMenu(null); if (list.remember) rememberUsed(list.key, e); e.run(); }}>
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
