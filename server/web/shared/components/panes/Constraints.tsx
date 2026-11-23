// Constraints.tsx — the board's Geometric Constraints pane (pcbnew/widgets/panel_constraints.cpp): a data view with the
// Item 1 / Item 2 / Constraint / State columns over the Refresh and Delete buttons.  Selecting a row selects (and zooms
// to) its members, the one member alone when the click was on its item cell; activating a row (double click, Enter)
// edits the constraint (EditConstraintById); Delete removes it and selects the row that is now last.  The row follows
// the badge selected on the canvas (SelectConstraint).  The model is editor/panels/constraints.ts behind window.CollabPanels.
import { useEffect, useMemo, useState, type MouseEvent as RMouseEvent } from "react";
import type { ConstraintsCmd, ConstraintsModel } from "../../../domains/pcb/panels-api";
import { useApp } from "../../store";
import { cx } from "../../util";
import { panels, usePanels } from "./widgets";

const EMPTY: ConstraintsModel = { rows: [], selected: null };
const COLUMNS = ["Item 1", "Item 2", "Constraint", "State"];
const cmd = (c: ConstraintsCmd) => { const p = panels(); if (p) p.constraintsCmd(c); };

export function ConstraintsPane() {
  const docV = useApp((s) => s.document.version);
  const docId = useApp((s) => s.document.docId);
  const units = useApp((s) => s.viewport.units);
  const shown = useApp((s) => !!s.panes.constraints);
  const conV = usePanels((s) => s.conVersion || 0);
  const [refresh, setRefresh] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const model: ConstraintsModel = useMemo(() => { const p = panels(); return p && shown ? p.constraints() : EMPTY; },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docV, docId, units, shown, conV, refresh]);
  // SelectConstraint: the badge selected on the canvas selects its row; a row whose constraint went is dropped
  useEffect(() => { if (model.selected) setSel(model.selected); }, [model.selected]);
  useEffect(() => { if (sel && !model.rows.some((r) => r.id === sel)) setSel(null); }, [model.rows, sel]);
  const pick = (ev: RMouseEvent, id: string) => {
    const td = (ev.target as Element).closest("td"); const col = td ? +(td.getAttribute("data-col") || -1) : -1;
    setSel(id); cmd({ t: "select", id, col });
  };
  const remove = () => {
    if (!sel) return;
    const rows = model.rows.filter((r) => r.id !== sel);
    cmd({ t: "delete", id: sel });
    setSel(rows.length ? rows[rows.length - 1].id : null);   // OnDelete: the last row is selected
  };
  return (
    <div className="kbody flex flex-col min-h-0 flex-auto bg-paper text-sm" id="constraintsPanel">
      <div className="flex-auto min-h-0 overflow-auto" tabIndex={0}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" && sel) { ev.preventDefault(); ev.stopPropagation(); cmd({ t: "activate", id: sel }); }
          else if ((ev.key === "Delete" || ev.key === "Backspace") && sel) { ev.preventDefault(); ev.stopPropagation(); remove(); }
        }}>
        <table className="w-full border-collapse text-sm" data-constraints-table>
          <thead>
            <tr>{COLUMNS.map((c) => (
              <th key={c} className="sticky top-0 z-[1] px-2 py-0.5 font-semibold text-left whitespace-nowrap bg-bench border-b border-r border-line cursor-default select-none">{c}</th>))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((r) => (
              <tr key={r.id} data-constraint-row={r.id} className={cx("cursor-default hover:bg-panel cur:bg-sel", sel === r.id && "cur")}
                onClick={(ev) => pick(ev, r.id)} onDoubleClick={() => cmd({ t: "activate", id: r.id })}>
                {r.cells.map((v, i) => (
                  <td key={i} data-col={i} className="px-2 py-px whitespace-nowrap border-r border-line-soft overflow-hidden text-ellipsis text-left">{v}</td>))}
              </tr>
            ))}
            {!model.rows.length ? <tr><td colSpan={COLUMNS.length} className="px-2 py-1 text-ink-3">No geometric constraints.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="flex flex-none items-center justify-end gap-1.5 px-1.5 py-1 bg-bench border-t border-line">
        <button type="button" className="btn sm" onClick={() => setRefresh((n) => n + 1)}>Refresh</button>
        <button type="button" className="btn sm" disabled={!sel} onClick={remove}>Delete</button>
      </div>
    </div>
  );
}
