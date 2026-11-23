// SelectionFilter.tsx — panel_pcbnew_selection_filter_base / panel_sch_selection_filter_base: which item
// kinds the select tool picks.  The same two-column grid as KiCad, "All items" and "Locked items" on the
// first row (the wxGridBagSizer's fixed two columns: the pairs stay side by side whatever the dock's width); a
// right-click on a kind offers "Only <kind>".  The pane folds to its caption (Dock.tsx), which then says what it lets
// through.
import { FILTERS } from "../../../domains/pcb/tables";
import { dispatch, useApp } from "../../store";
import { ContextMenu, useContextMenu } from "./widgets";

// `kcb` / `kbody` / `kfilter` / `kfgrid` stay as plain hooks; the utilities carry the styling.
const CB = "kcb flex items-center gap-1.5 py-px whitespace-nowrap min-w-0 overflow-hidden text-ellipsis";
const CB_INPUT = "m-0 accent-blue";

export function SelectionFilterPane() {
  const editor = useApp((s) => s.document.editor);
  const filter = useApp((s) => s.filter);
  // PANEL_SELECTION_FILTER / PANEL_SCH_SELECTION_FILTER::flashCheckbox: the boxes that turned a click away fade from the
  // highlight colour back to the panel in ten 50 ms steps; the key restarts the animation on every rejected click
  const flash = useApp((s) => s.filterFlash);
  const fl = (k: string) => (flash && flash.keys.indexOf(k) >= 0 ? { key: k + ":" + flash.n, style: { animation: "kfilter-flash 500ms steps(10, end)" } } : { key: k });
  const menu = useContextMenu();
  const list = editor ? FILTERS[editor] : [];
  const all = list.every(([k]) => filter[k] !== false);
  return (
    <div className="kbody kfilter overflow-auto min-h-0 flex-auto bg-paper px-2 py-1.5 text-sm">
      <div className="kfgrid d-grid grid-cols-2 gap-x-2 gap-y-0.5">
        <label className={`${CB} all`} title="All items"><input type="checkbox" className={CB_INPUT} data-f="all" checked={all} onChange={(ev) => dispatch({ type: "setFilter", key: "all", on: ev.target.checked })} /> All items</label>
        <label className={`${CB} locked`} title="Allow selection of locked items" {...fl("lockedItems")}><input type="checkbox" className={CB_INPUT} data-f="lockedItems" checked={filter.lockedItems !== false} onChange={(ev) => dispatch({ type: "setFilter", key: "lockedItems", on: ev.target.checked })} /> Locked items</label>
        {list.map(([k, l]) => (
          <label className={CB} {...fl(k)} title={editor === "sch" && k === "graphics" ? "Graphical shapes" : undefined} onContextMenu={(ev) => menu.open(ev, [{ label: `Only ${l.toLowerCase()}`, run: () => dispatch({ type: "setFilter", key: "only:" + k, on: true }) }])}>
            <input type="checkbox" className={CB_INPUT} data-f={k} checked={filter[k] !== false} onChange={(ev) => dispatch({ type: "setFilter", key: k, on: ev.target.checked })} /> {l}
          </label>
        ))}
      </div>
      <style>{"@keyframes kfilter-flash { from { background-color: var(--blue, Highlight); } to { background-color: transparent; } }"}</style>
      <ContextMenu at={menu.at} onClose={menu.close} />
    </div>
  );
}

/** The folded Selection Filter's caption: "All items", "Nothing", or how many kinds it lets through. */
export function FilterSummary() {
  const editor = useApp((s) => s.document.editor);
  const filter = useApp((s) => s.filter);
  const list = editor ? FILTERS[editor] : [];
  const on = list.filter(([k]) => filter[k] !== false).length;
  const locked = filter.lockedItems === false ? ", not locked" : "";
  return <span data-filter-summary="">{on === list.length ? "All items" + locked : on === 0 ? "Nothing" : `${on} of ${list.length} kinds${locked}`}</span>;
}
