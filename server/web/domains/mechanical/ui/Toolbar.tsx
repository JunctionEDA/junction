// Toolbar.tsx — the part studio's toolbar, drawn from the registries: the feature types (features/*.ts) and the
// tools (tools/*.ts).  Nothing is listed here by hand; a feature says which section it belongs to and, when it
// is one of a family, which drop-down it shares (core/feature.ts toolbarSection / toolbarMenu), and a tool
// names its group (core/tool.ts).
//
//   undo redo delete │ Sketch │ Extrude Revolve Sweep▾ Fillet▾ Shell Hole Boolean▾ │ Pattern▾ │ Reference▾ │ Board▾ │ inspect │ view │ file
//
// The bar never scrolls sideways in a window of ordinary width: when the buttons do not fit, the tools lose
// their labels first (density 1), then the features (density 2); a tooltip names every button either way.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FEATURE_SECTIONS, type FeatureDefinition } from "../core/feature";
import { TOOL_GROUPS, subscribeTools, toolsRevision, type ToolDefinition } from "../core/tool";
import { cx } from "../../../shared/util";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import type { PartStudio } from "./studio";

interface Entry { id: string; title: string; hint?: string; icon?: string; shortcut?: string; on?: boolean; why?: string | null; run(): void }
type Slot = { menu: null; entry: Entry } | { menu: string; entries: Entry[] };
interface Section { id: string; group: string; slots: Slot[]; /** the density from which this section's buttons lose their labels */ bare: number }

const tip = (e: Entry): string => (e.why ? `${e.title}: ${e.why}` : `${e.title}${e.shortcut ? ` (${e.shortcut})` : ""}${e.hint ? `\n${e.hint}` : ""}`);
const CARET = '<path d="M8 10l4 4 4-4"/>';

function Button({ e, label }: { e: Entry; label: boolean }) {
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-1 px-1", e.on && "on", e.why && "opacity-45")} aria-pressed={e.on || undefined} aria-disabled={e.why ? true : undefined}
      aria-label={e.title} title={tip(e)} data-tool={e.title} onClick={() => { if (!e.why) e.run(); }}>
      <Glyph svg={e.icon} />{label ? <span>{e.title}</span> : null}
    </button>
  );
}

function MenuButton({ title, entries, label, open, toggle }: { title: string; entries: Entry[]; label: boolean; open: boolean; toggle(at: DOMRect | null): void }) {
  const why = entries.every((e) => e.why) ? entries[0].why : null;
  return (
    <button type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center gap-0.5 px-1", (open || entries.some((e) => e.on)) && "on", why && "opacity-45")} aria-haspopup="menu" aria-expanded={open}
      aria-label={title} title={why ? `${title}: ${why}` : `${title}: ${entries.map((e) => e.title).join(", ")}`} data-menu={title} data-items={entries.map((e) => e.title).join("|")}
      onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => toggle(open ? null : ev.currentTarget.getBoundingClientRect())}>
      <Glyph svg={entries[0].icon} />{label ? <span>{title}</span> : null}<Glyph svg={CARET} size={12} />
    </button>
  );
}

function sectionsOf(studio: PartStudio, sketch: boolean, canEdit: boolean, editing: boolean): Section[] {
  const out: Section[] = [];
  const toolEntry = (t: ToolDefinition): Entry => ({
    id: t.id, title: t.title, hint: t.hint, icon: t.icon, shortcut: t.key && t.key.length === 1 ? t.key.toUpperCase() : t.key === "Delete" ? "Del" : undefined,
    on: t.active ? t.active(studio) : false, why: t.disabled ? t.disabled(studio) : null, run: () => { t.run(studio); studio.viewport.canvas.focus(); },
  });
  const featureEntry = (f: FeatureDefinition): Entry => ({
    id: "f:" + f.type, title: f.title, icon: f.icon, why: canEdit ? (editing ? "Finish the open dialog first" : null) : "View-only access", run: () => studio.startFeature(f.type),
  });
  const slotsOf = <T,>(list: T[], menuOf: (x: T) => string | undefined, entry: (x: T) => Entry): Slot[] => {
    const slots: Slot[] = [];
    for (const x of list) {
      const menu = menuOf(x), e = entry(x);
      const have = menu ? slots.find((s) => s.menu === menu) : undefined;
      if (have && have.menu !== null) have.entries.push(e);
      else slots.push(menu ? { menu, entries: [e] } : { menu: null, entry: e });
    }
    // a family of one is a plain button
    return slots.map((s) => (s.menu !== null && s.entries.length === 1 ? { menu: null, entry: s.entries[0] } : s));
  };
  const features = studio.definitions().filter((f) => f.toolbar !== false).slice().sort((a, b) => (a.toolbarOrder ?? 1e6) - (b.toolbarOrder ?? 1e6) || a.title.localeCompare(b.title));
  const tools = (group: string): ToolDefinition[] => studio.tools().filter((t) => t.group === group && t.button !== false).slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title));
  for (const g of TOOL_GROUPS) {
    if (g === "sketch") { if (sketch) out.push({ id: g, group: g, slots: slotsOf(tools(g), (t) => t.menu, toolEntry), bare: 3 }); continue; }
    if (g === "feature") {
      if (sketch) continue;
      for (const sec of FEATURE_SECTIONS) {
        const slots = slotsOf(features.filter((f) => (f.toolbarSection || "solid") === sec), (f) => f.toolbarMenu, featureEntry);
        // tools that put themselves among the features follow the solids
        if (sec === "solid") slots.push(...slotsOf(tools(g), (t) => t.menu, toolEntry));
        out.push({ id: sec, group: g, slots, bare: 2 });
      }
      continue;
    }
    out.push({ id: g, group: g, slots: slotsOf(tools(g), (t) => t.menu, toolEntry), bare: g === "edit" ? 0 : 1 });
  }
  return out.filter((s) => s.slots.length);
}

export function Toolbar({ studio }: { studio: PartStudio }) {
  // every slice a button's `disabled` / `active` may read: the toolbar redraws when one changes
  const sketch = useStudio(studio, (s) => !!s.sketch);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const editing = useStudio(studio, (s) => !!s.editing);
  useStudio(studio, (s) => s.selection); useStudio(studio, (s) => s.selectedFeature);
  useStudio(studio, (s) => s.canUndo); useStudio(studio, (s) => s.canRedo); useStudio(studio, (s) => s.planesVisible);
  useSyncExternalStore(subscribeTools, toolsRevision);   // tools with state of their own (core/tool.ts toolsChanged)
  useStudio(studio, (s) => s.bodies);
  useStudio(studio, (s) => s.ui); useStudio(studio, (s) => s.past);

  const sections = sectionsOf(studio, sketch, canEdit, editing);

  // ---- how much room there is: labels go when the buttons do not fit
  const bar = useRef<HTMLDivElement>(null);
  const [density, setDensity] = useState(0);
  const needs = useRef<{ sig: string; at: (number | undefined)[] }>({ sig: "", at: [] });
  const sig = sections.map((s) => s.id + ":" + s.slots.length).join();
  useLayoutEffect(() => {
    const el = bar.current; if (!el) return;
    if (needs.current.sig !== sig) needs.current = { sig, at: [] };
    const fit = () => {
      let need = 0;
      for (const c of Array.from(el.children)) need += (c as HTMLElement).offsetWidth;
      const room = el.clientWidth, at = needs.current.at;
      at[density] = need;
      if (need > room && density < 2) setDensity(density + 1);
      else if (density > 0 && at[density - 1] !== undefined && at[density - 1]! <= room) setDensity(density - 1);
      else if (density > 0 && at[density - 1] === undefined && need <= room * 0.6) setDensity(density - 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [density, sig]);

  // ---- the open drop-down
  const [menu, setMenu] = useState<{ key: string; at: DOMRect } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(null);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setMenu(null); } };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", away); window.addEventListener("blur", away);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); window.removeEventListener("resize", away); window.removeEventListener("blur", away); };
  }, [menu]);
  let shown: Entry[] | null = null;

  const groups = sections.map((sec, i) => (
    <div key={sec.id} className={cx("flex flex-none items-center gap-px px-1", i < sections.length - 1 && "border-r border-line")} data-group={sec.group} data-section={sec.id}>
      {sec.slots.map((slot) => {
        const label = density < sec.bare;
        if (slot.menu === null) return <Button key={slot.entry.id} e={slot.entry} label={label} />;
        const key = sec.id + "/" + slot.menu, open = !!menu && menu.key === key;
        if (open) shown = slot.entries;
        return <MenuButton key={key} title={slot.menu} entries={slot.entries} label={label} open={open} toggle={(at) => setMenu(at ? { key, at } : null)} />;
      })}
    </div>
  ));
  const list = shown as Entry[] | null;
  return (
    <div ref={bar} className="cad-toolbar flex items-center h-9 bg-bench border-b border-line overflow-x-auto select-none" role="toolbar" aria-label="Part studio tools" data-density={density}>
      {groups}
      {menu && list ? (
        <div className="cad-tb-menu fixed z-[50] min-w-44 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" onPointerDown={(ev) => ev.stopPropagation()}
          style={{ left: Math.max(4, Math.min(menu.at.left, window.innerWidth - 200)), top: menu.at.bottom + 2 }}>
          {list.map((e) => (
            <button key={e.id} type="button" role="menuitem" className={cx("appearance-none bg-transparent border-0 m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2 px-2.5 h-7 text-left hover:bg-sel-soft", e.on && "font-semibold", e.why && "opacity-45")} aria-disabled={e.why ? true : undefined}
              title={tip(e)} data-tool={e.title} onClick={() => { if (e.why) return; setMenu(null); e.run(); }}>
              <Glyph svg={e.icon} size={16} /><span className="flex-1">{e.title}</span>{e.shortcut ? <span className="mono text-xs text-ink-3">{e.shortcut}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
