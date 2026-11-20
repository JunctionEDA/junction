// PartsList.tsx — the parts list: what the features up to the rollback bar make, under the feature list.
//
//   sections   Parts · Surfaces · Curves · Composite parts, each with its icon and count; a heading folds its
//              section, and its eye (on hover) hides or shows everything in it
//   a row      click selects the entry in the model (Ctrl adds, Shift takes the range) and the model's selection
//              marks the rows; the pointer over a row lights the entry up, and over the model marks its row; a
//              hidden entry shows its outline while the pointer is on its row; the eye hides and shows it
//   keys       F2 or a double click renames · Del deletes · ↑ ↓ move · Ctrl+A takes every row
//   right-click a row: the menu of ui/parts-model.ts partMenu, for every selected row at once
//   right-click a heading: hide or show the section, select it, show each entry's properties beside its name
//
// Names, properties, materials and colours are the document's (document/part-items.ts, mass-materials.ts,
// appearance-items.ts): undone like any edit and seen by everyone.  Hiding, isolating and looking through a part
// are this person's view; which sections are folded is kept in this browser.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cx } from "../../../shared/util";
import { materialsOf } from "../document/mass-materials";
import { partNamesOf, partPropsOf, MAX_PART_NAME } from "../document/part-items";
import { displayOf } from "../inspect/appearance-display";
import { massOf } from "../inspect/mass-session";
import { useStore } from "../inspect/store";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { anyHidden, entryOutline, entryPicks, entryVisible, menuContext, renameEntry, runPartCommand, selectEntries, setEntriesVisible, showAllEntries, type PartUi } from "./part-actions";
import { openPartAppearance, openPartMaterial, openPartProperties } from "./PartDialogs";
import { clickSelection, entriesOf, menuTargets, partMenu, sectionsOf, selectedEntryIds, type PartEntry, type PartKind, type PartSection } from "./parts-model";
import { featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";

const BARE = "appearance-none bg-transparent border-0 m-0 p-0 text-inherit [font-family:inherit] [font-size:inherit]";
const CHEVRON = '<path d="M9 6l6 6-6 6"/>';
const EYE = '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>';
const EYE_OFF = '<path d="M4 4l16 16"/><path d="M10 5.7a9 9 0 0 1 2-.2c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.4 7.5A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.2 0 2.3-.25 3.3-.65"/>';
/** the icon of each kind of entry: a solid, a sheet, a curve between two ends, shapes held together */
export const PART_ICONS: { readonly [K in PartKind]: string } = {
  part: '<path class="f" d="M12 3.5l7.5 4v9l-7.5 4-7.5-4v-9z"/><path d="M12 3.5l7.5 4v9l-7.5 4-7.5-4v-9zM4.5 7.5l7.5 4 7.5-4M12 11.5v9"/>',
  surface: '<path class="f" d="M3.5 8.5c4-3.5 9 3 17-1.5v9.5c-8 4.5-13-2-17 1.5z"/><path d="M3.5 8.5c4-3.5 9 3 17-1.5v9.5c-8 4.5-13-2-17 1.5z"/>',
  curve: '<path d="M4 17.5c2.5-11 6.5-10 8.5-4.5s5.5 3 7.5-6.5"/><circle class="s" cx="4" cy="17.5" r="1.7"/><circle class="s" cx="20" cy="6.5" r="1.7"/>',
  composite: '<rect class="f" x="4.5" y="10.5" width="7" height="7" rx="1"/><rect x="4.5" y="10.5" width="7" height="7" rx="1"/><circle class="f" cx="15.5" cy="9" r="3.5"/><circle cx="15.5" cy="9" r="3.5"/><rect class="d t" x="2" y="3.5" width="20" height="17" rx="2.5"/>',
};

// ---------------------------------------------------------------- how this person likes the list (this browser)
interface ListPrefs { folded: { [kind: string]: boolean }; props: boolean }
const KEY = "junction.cad.partslist";
function readPrefs(): ListPrefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "{}"); return { folded: v && typeof v.folded === "object" && v.folded ? v.folded : {}, props: !!(v && v.props) }; } catch { return { folded: {}, props: false }; }
}
let prefs = readPrefs();
const prefListeners = new Set<() => void>();
function setListPrefs(patch: Partial<ListPrefs>): void {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode: it lasts as long as the page */ }
  for (const fn of Array.from(prefListeners)) fn();
}
const useListPrefs = (): ListPrefs => useSyncExternalStore((fn) => { prefListeners.add(fn); return () => { prefListeners.delete(fn); }; }, () => prefs);

function Eye({ shown, label, hint, onToggle, always }: { shown: boolean; label: string; hint?: string; onToggle(): void; always?: boolean }) {
  return (
    <button type="button" className={cx("btn sm ghost flex-none p-0 w-6 h-6 min-h-0 justify-center", shown ? cx("text-ink-2", !always && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100") : "text-ink-3")} aria-pressed={shown} aria-label={`${shown ? "Hide" : "Show"} ${label}`} data-eye={shown ? "shown" : "hidden"}
      {...tipHandlers({ title: `${shown ? "Hide" : "Show"} ${label}`, hint: hint || "Only in your view: nobody else's changes." })} onClick={(ev) => { ev.stopPropagation(); onToggle(); }} onDoubleClick={(ev) => ev.stopPropagation()}>
      <Glyph svg={shown ? EYE : EYE_OFF} size={16} />
    </button>
  );
}

type MenuAt = { x: number; y: number } & ({ row: string } | { section: PartKind });

export function PartsList({ studio }: { studio: PartStudio }) {
  const bodies = useStudio(studio, (s) => s.bodies);
  const datums = useStudio(studio, (s) => s.datums);
  const features = useStudio(studio, (s) => s.features);
  const selection = useStudio(studio, (s) => s.selection);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const busy = useStudio(studio, (s) => !!s.editing || !!s.sketch);
  useStudio(studio, (s) => s.visibility);   // a curve hidden or shown
  useStudio(studio, (s) => s.status);
  const hoverKey = useStudio(studio, (s) => { const h = s.hover; return !h ? null : h.kind === "datum" ? `curve:${h.featureId}` : h.kind === "face" || h.kind === "edge" || h.kind === "vertex" ? h.body : null; });
  const display = displayOf(studio);
  const ds = useStore(display, (s) => s);
  const centre = useStore(massOf(studio), (s) => s.showCentre);
  const lp = useListPrefs();
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const outlined = useRef(false);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close); document.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); document.removeEventListener("keydown", key, true); };
  }, [menu]);
  // the outline of a hidden entry is this list's: it goes with the list, and when a dialog or a sketch takes the overlay
  const clearOutline = () => { if (outlined.current) { outlined.current = false; if (!studio.getState().sketch) studio.view.setOverlay(null); } };
  useEffect(() => clearOutline, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (busy) outlined.current = false; }, [busy]);

  const doc = studio.doc;
  const names = partNamesOf(doc);
  const sections = sectionsOf(bodies, datums, features, names);
  const all = entriesOf(sections);
  // only the rows that are on screen can be reached with Shift and the arrows
  const order = sections.filter((s) => !lp.folded[s.kind]).flatMap((s) => s.entries.map((e) => e.id));
  const selected = selectedEntryIds(all, selection);
  const byId = new Map(all.map((e) => [e.id, e]));
  const props = lp.props ? partPropsOf(doc) : {};
  const materials = lp.props ? materialsOf(doc) : null;
  const hidden = anyHidden(studio, all);
  void ds; void centre;

  if (!all.length) return <p className="note px-2 py-1 m-0" data-empty>No parts yet. A part appears when a feature makes a solid: extrude or revolve a sketch. Surfaces and curves are listed here too.</p>;

  const ui: PartUi = {
    rename: (id) => setRenaming(id),
    properties: (e) => openPartProperties(studio, e),
    material: (es) => openPartMaterial(studio, es),
    appearance: (es) => openPartAppearance(studio, es),
  };
  const isEntryPick = (p: (typeof selection)[number]) => (p.kind === "datum" ? byId.has(`curve:${p.featureId}`) : (p.kind === "face" || p.kind === "edge" || p.kind === "vertex") && byId.has(p.body));
  /** Make these rows the selection; `keep` leaves what else is selected in the model (a plane, a sketch) alone. */
  const selectRows = (ids: readonly string[], keep = false) => {
    studio.select([...(keep ? selection.filter((p) => !isEntryPick(p)) : []), ...ids.flatMap((id) => { const e = byId.get(id); return e ? entryPicks(studio, e) : []; })]);
  };
  const clickRow = (e: PartEntry, ev: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    // a dialog's field that is listening takes the part, as a click on it in the model would; a sketch takes nothing
    if (busy) {
      const p = entryPicks(studio, e)[0], editing = studio.getState().editing;
      if (!p || !editing) return;
      // no field listens: the first one that holds bodies does, as a click on the part in the model would make it
      if (!editing.field && e.body) { const key = featureDef(editing.draft.featureType)?.schema.find((f) => f.kind === "bodies" && (!f.visible || f.visible(editing.draft.params)))?.key; if (key) studio.setField(key); }
      studio.pickFromList(p, ev);
      return;
    }
    const toggle = ev.ctrlKey || ev.metaKey;
    const next = clickSelection(order, selected, anchor.current, e.id, { toggle, range: ev.shiftKey });
    anchor.current = next.anchor;
    selectRows(next.selected, toggle || ev.shiftKey);
  };
  const hoverRow = (e: PartEntry | null) => {
    clearOutline();
    if (!e) { studio.view.setFeatureHover(null); return; }
    if (entryVisible(studio, e)) { studio.view.setFeatureHover(entryPicks(studio, e)); return; }
    studio.view.setFeatureHover(null);
    // a hidden entry is not in the model to light up: its outline is drawn while the pointer is here
    if (busy) return;
    const segments = entryOutline(studio, e);
    if (segments.length >= 6) { studio.view.setOverlay(segments); outlined.current = true; }
  };
  const run = (cmd: Parameters<typeof runPartCommand>[1], targets: readonly PartEntry[]) => runPartCommand(studio, cmd, targets, all, ui);
  const focusRow = (id: string) => list.current?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`)?.focus();
  const keyRow = (e: PartEntry, ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest("input")) return;
    const used = () => { ev.preventDefault(); ev.stopPropagation(); };
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === "F2") { if (canEdit && !e.reference) setRenaming(e.id); used(); return; }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      const i = order.indexOf(e.id), to = order[i + (ev.key === "ArrowDown" ? 1 : -1)];
      if (to && !busy) { const next = clickSelection(order, selected, anchor.current, to, { range: ev.shiftKey }); if (!next.selected.length) next.selected = [to]; anchor.current = next.anchor; selectRows(next.selected); focusRow(to); }
      used(); return;
    }
    if (mod && ev.key.toLowerCase() === "a") { if (!busy) selectRows(order); used(); return; }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      const targets = menuTargets(selected, e.id).map((id) => byId.get(id)!).filter(Boolean);
      const item = partMenu(menuContext(studio, targets, all)).find((x) => x && x.id === "delete");
      if (item && !item.why) run("delete", targets);
      used(); return;
    }
  };

  const eyeOfSection = (s: PartSection) => {
    const shown = s.entries.some((e) => entryVisible(studio, e));
    return <Eye shown={shown} label={`all ${s.title.toLowerCase()}`} onToggle={() => setEntriesVisible(studio, s.entries, !shown)} />;
  };

  // ---------------------------------------------------------------- the menus
  let menuBody: JSX.Element | null = null;
  if (menu) {
    const item = (label: string, id: string, runIt: () => void, o: { why?: string | null; key?: string; danger?: boolean } = {}) => (
      <button type="button" key={id} role="menuitem" data-menu-item={label} data-command={id} aria-disabled={o.why ? true : undefined} title={o.why || undefined}
        className={cx(BARE, "flex w-full items-center px-3 h-7 text-left cursor-pointer hover:bg-sel-soft", o.danger && !o.why && "text-err", o.why && "opacity-45")}
        onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { if (o.why) return; setMenu(null); runIt(); }}>
        <span className="flex-1">{label}</span>{o.key ? <span className="mono text-xs text-ink-3 ml-4">{o.key}</span> : null}
      </button>
    );
    const rule = (i: number) => <div key={"rule" + i} className="my-1 border-t border-line" role="separator" />;
    let rows: JSX.Element[] = [], head: string | null = null;
    if ("row" in menu) {
      const targets = menuTargets(selected, menu.row).map((id) => byId.get(id)!).filter(Boolean);
      if (targets.length) {
        if (targets.length > 1) head = `${targets.length} selected`;
        rows = partMenu(menuContext(studio, targets, all)).map((x, i) => (x ? item(x.label, x.id, () => run(x.id, targets), x) : rule(i)));
      }
    } else {
      const s = sections.find((x) => x.kind === menu.section);
      if (s) {
        const shown = s.entries.filter((e) => entryVisible(studio, e)).length;
        head = `${s.title} (${s.count})`;
        if (shown) rows.push(item(`Hide all ${s.title.toLowerCase()}`, "section-hide", () => setEntriesVisible(studio, s.entries, false)));
        if (shown < s.entries.length) rows.push(item(`Show all ${s.title.toLowerCase()}`, "section-show", () => setEntriesVisible(studio, s.entries, true)));
        if (hidden) rows.push(item("Show everything", "show-all", () => showAllEntries(studio, all)));
        rows.push(item(`Select all ${s.title.toLowerCase()}`, "section-select", () => selectEntries(studio, s.entries), { why: busy ? "Finish the open dialog or sketch first" : null }));
        rows.push(rule(0));
        rows.push(item(lp.props ? "Hide parts list properties" : "Show parts list properties", "props", () => setListPrefs({ props: !lp.props })));
        rows.push(item(lp.folded[s.kind] ? `Unfold ${s.title.toLowerCase()}` : `Fold ${s.title.toLowerCase()}`, "fold", () => setListPrefs({ folded: { ...lp.folded, [s.kind]: !lp.folded[s.kind] } })));
      }
    }
    if (rows.length) menuBody = (
      <div className="cad-parts-menu fixed z-[55] min-w-56 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" data-menu-of={"row" in menu ? menu.row : menu.section}
        style={{ left: Math.max(4, Math.min(menu.x, window.innerWidth - 250)), top: Math.max(4, Math.min(menu.y, window.innerHeight - rows.length * 28 - (head ? 40 : 16))) }} onPointerDown={(ev) => ev.stopPropagation()} onContextMenu={(ev) => ev.preventDefault()}>
        {head ? <div className="px-3 h-6 text-xs text-ink-3 flex items-center" data-menu-head>{head}</div> : null}
        {rows}
      </div>
    );
  }

  return (
    <div ref={list} className="cad-parts flex flex-col pb-1 text-base" role="listbox" aria-label="Parts" aria-multiselectable="true" data-props={lp.props || undefined}>
      {sections.map((s) => {
        const folded = !!lp.folded[s.kind];
        return (
          <div key={s.kind} data-section={s.kind} data-folded={folded || undefined} role="group" aria-label={s.title}>
            <div className="group flex items-center h-7 pr-1.5 hover:bg-sel-soft select-none" onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, section: s.kind }); }}>
              <button type="button" className={cx(BARE, "flex flex-1 min-w-0 items-center gap-1.5 h-full pl-2 text-left text-ink font-medium cursor-pointer")} aria-expanded={!folded} data-section-toggle={s.kind}
                onClick={() => setListPrefs({ folded: { ...lp.folded, [s.kind]: !folded } })}>
                <span className={cx("flex-none text-ink-2 transition-transform", !folded && "rotate-90")}><Glyph svg={CHEVRON} size={14} /></span>
                <Glyph svg={PART_ICONS[s.kind]} size={18} />
                {/* `data-group` and the count in brackets are what scripts read */}
                <span className="truncate" data-group={s.title.toLowerCase().replace(/ /g, "-")} data-count={s.count}>{s.title} ({s.count})</span>
              </button>
              {eyeOfSection(s)}
            </div>
            {folded ? null : s.entries.map((e) => {
              const visible = entryVisible(studio, e), on = selected.includes(e.id);
              const through = !!e.body && display.isTransparent(e.body);
              const material = materials && e.body && materials.assign[e.body] ? materials.library[materials.assign[e.body]]?.name : "";
              const about = lp.props ? [material, props[e.id]?.description].filter(Boolean).join(" · ") : "";
              return (
                <div key={e.id} role="option" aria-selected={on} tabIndex={on || (!selected.length && e.id === order[0]) ? 0 : -1} data-entry={e.id} data-body={e.body || undefined}
                  data-kind={e.body && e.kind !== "composite" ? (e.kind === "surface" ? "surface" : e.reference ? "reference" : "part") : e.kind} data-visible={visible} data-hover={hoverKey === (e.body || e.id) || undefined} data-transparent={through || undefined}
                  className={cx("group flex items-center gap-1.5 h-7 pl-7 pr-1.5 cursor-default select-none outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-blue)]", on ? "bg-sel font-medium" : hoverKey === (e.body || e.id) ? "bg-sel-soft" : "hover:bg-sel-soft", (e.reference || !visible) && "text-ink-3")}
                  title={e.reference ? `${e.name}: reference geometry (not a part of this studio)` : undefined}
                  onClick={(ev) => clickRow(e, ev)}
                  onDoubleClick={() => { if (canEdit && !e.reference && !busy) setRenaming(e.id); }}
                  onKeyDown={(ev) => keyRow(e, ev)}
                  onPointerEnter={() => hoverRow(e)} onPointerLeave={() => hoverRow(null)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    if (!busy && !selected.includes(e.id)) { anchor.current = e.id; selectRows([e.id]); }
                    setMenu({ x: ev.clientX, y: ev.clientY, row: e.id });
                  }}>
                  <Glyph svg={PART_ICONS[e.kind]} size={18} />
                  {renaming === e.id
                    ? <input autoFocus className="input flex-1 min-w-0 h-5" defaultValue={e.name} maxLength={MAX_PART_NAME} aria-label="Name" data-rename onFocus={(ev) => ev.target.select()} onClick={(ev) => ev.stopPropagation()} onDoubleClick={(ev) => ev.stopPropagation()}
                        onBlur={(ev) => { if (ev.target.dataset.cancel !== "1") renameEntry(studio, e, ev.target.value); setRenaming(null); }}
                        onKeyDown={(ev) => { const t = ev.target as HTMLInputElement; if (ev.key === "Enter") t.blur(); if (ev.key === "Escape") { t.dataset.cancel = "1"; setRenaming(null); } ev.stopPropagation(); }} />
                    : <span className="flex-1 min-w-0 truncate" data-row-name>{e.name}{about ? <span className="ml-2 text-xs font-normal text-ink-3" data-row-props>{about}</span> : null}</span>}
                  {e.reference ? <span className="flex-none text-xs text-ink-3">reference</span> : null}
                  {through ? <span className="flex-none text-xs text-ink-3" data-through {...tipHandlers({ title: "Transparent in your view", hint: "Right-click and choose Make opaque to draw it solid again." })}>see-through</span> : null}
                  <Eye shown={visible} label={e.name} onToggle={() => setEntriesVisible(studio, [e], !visible)} />
                </div>
              );
            })}
          </div>
        );
      })}
      {hidden ? <button type="button" className="btn sm ghost self-start mx-1.5 mt-0.5 h-5 min-h-0 px-1 text-xs" data-show-all onClick={() => showAllEntries(studio, all)}>Show all parts</button> : null}
      {menuBody}
    </div>
  );
}
