// FeatureList.tsx — the history tree: every feature in order, its state, and the rollback bar.
//
//   click selects · double-click edits · right-click: Edit, Rename, Suppress, Roll back to here, Delete
//   drag a row to reorder · drag the bar (or use the menu) to roll the model back
import { useEffect, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import * as edits from "../document/edits";
import type { FeatureItem } from "../document/format";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { featureDef, type PartStudio } from "./studio";

interface Menu { x: number; y: number; id: string }

export function FeatureList({ studio }: { studio: PartStudio }) {
  const features = useStudio(studio, (s) => s.features);
  const rollback = useStudio(studio, (s) => s.rollback);
  const reports = useStudio(studio, (s) => s.reports);
  const selected = useStudio(studio, (s) => s.selectedFeature);
  const sketch = useStudio(studio, (s) => s.sketch?.featureId);
  const editing = useStudio(studio, (s) => s.editing?.draft);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const loaded = useStudio(studio, (s) => s.loaded);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<number | null>(null);         // where a dragged row would land
  const [barAt, setBarAt] = useState<number | null>(null);       // where the dragged rollback bar is
  const list = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);

  const doc = () => studio.doc!;
  /** The gap (0 … n) nearest a pointer position: 0 is above the first row. */
  const gapAt = (clientY: number): number => {
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-feature-row]") || []);
    for (let i = 0; i < rows.length; i++) { const r = rows[i].getBoundingClientRect(); if (clientY < r.top + r.height / 2) return i; }
    return rows.length;
  };
  const setBar = (gap: number) => studio.commit(edits.setRollback(doc(), gap >= features.length ? null : features[gap].id));

  const dragBar = (ev: React.PointerEvent) => {
    if (!canEdit) return;
    ev.preventDefault();
    const move = (e: PointerEvent) => setBarAt(gapAt(e.clientY));
    const up = (e: PointerEvent) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setBarAt(null); setBar(gapAt(e.clientY)); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };

  const rowsOut: JSX.Element[] = [];
  const bar = (key: string, live: boolean) => (
    <div key={key} className={cx("cad-rollback h-[5px] mx-1 my-px rounded-full", live ? "bg-accent cursor-row-resize" : "bg-line-2")} data-rollback={live || undefined}
      title={live ? "Rollback bar: features below it are not built. Drag to move." : undefined} onPointerDown={live ? dragBar : undefined} />
  );
  const shownBar = barAt ?? rollback;
  const all: FeatureItem[] = editing && !features.some((f) => f.id === editing.id) ? [...features.slice(0, rollback), editing, ...features.slice(rollback)] : features;
  let gap = 0;
  for (const f of all) {
    const isDraft = !!editing && editing.id === f.id && !features.some((x) => x.id === f.id);
    if (!isDraft) { if (gap === shownBar && (gap < features.length || barAt !== null)) rowsOut.push(bar("bar", barAt === null)); if (drop === gap) rowsOut.push(<div key="drop" className="h-0.5 mx-1 bg-blue" />); }
    const def = featureDef(f.featureType);
    const rep = reports[f.id];
    const below = !isDraft && gap >= rollback;
    const state = f.suppressed ? "suppressed" : below ? "rolled-back" : rep ? rep.status : "ok";
    rowsOut.push(
      <div key={f.id} data-feature-row={isDraft ? undefined : f.id} data-feature-type={f.featureType} data-state={state} role="option" aria-selected={selected === f.id}
        draggable={canEdit && !isDraft && renaming !== f.id}
        className={cx("flex items-center gap-1.5 h-6.5 px-2 cursor-default select-none", selected === f.id || sketch === f.id || isDraft ? "bg-sel" : "hover:bg-sel-soft", (below || f.suppressed) && "text-ink-3", isDraft && "italic")}
        title={rep && rep.message ? rep.message : undefined}
        onClick={() => studio.selectFeature(f.id)}
        onDoubleClick={() => { if (!isDraft) studio.editFeature(f.id); }}
        onContextMenu={(ev) => { ev.preventDefault(); if (!isDraft) { studio.selectFeature(f.id); setMenu({ x: ev.clientX, y: ev.clientY, id: f.id }); } }}
        onDragStart={(ev) => { dragId.current = f.id; ev.dataTransfer.effectAllowed = "move"; ev.dataTransfer.setData("text/plain", f.id); }}
        onDragEnd={() => { dragId.current = null; setDrop(null); }}>
        <Glyph svg={def?.icon} size={16} />
        {renaming === f.id
          ? <input autoFocus className="input flex-1 min-w-0 h-5" defaultValue={f.name} aria-label="Feature name"
              onBlur={(ev) => { studio.commit(edits.renameFeature(doc(), f.id, ev.target.value)); setRenaming(null); }}
              onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRenaming(null); ev.stopPropagation(); }} />
          : <span className={cx("flex-1 truncate", f.suppressed && "line-through")}>{f.name}</span>}
        {state === "error" ? <span className="pill err" title={rep?.message}>error</span> : state === "warning" ? <span className="pill warn" title={rep?.message}>note</span> : state === "suppressed" ? <span className="text-xs">off</span> : null}
      </div>,
    );
    if (!isDraft) gap++;
  }
  if (shownBar >= features.length && barAt !== null) rowsOut.push(bar("bar", false));
  if (drop === features.length) rowsOut.push(<div key="drop" className="h-0.5 mx-1 bg-blue" />);

  const f = menu ? features.find((x) => x.id === menu.id) : undefined;
  const item = (label: string, run: () => void, danger?: boolean) => (
    <button type="button" key={label} className={cx("block w-full text-left px-3 h-7 hover:bg-sel-soft", danger && "text-err")} onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setMenu(null); run(); }}>{label}</button>
  );
  return (
    <div ref={list} className="cad-features flex flex-col py-1 text-sm min-h-full" role="listbox" aria-label="Features"
      onDragOver={(ev) => { if (dragId.current) { ev.preventDefault(); setDrop(gapAt(ev.clientY)); } }}
      onDrop={(ev) => {
        ev.preventDefault();
        const id = dragId.current, g = gapAt(ev.clientY); dragId.current = null; setDrop(null);
        if (!id) return;
        const from = features.findIndex((x) => x.id === id);
        studio.commit(edits.moveFeature(doc(), id, g > from ? g - 1 : g));
      }}>
      {rowsOut}
      {loaded && !all.length ? <p className="note px-2 m-0">No features yet. Start with a sketch.</p> : null}
      {!loaded ? <p className="note px-2 m-0">Loading…</p> : null}
      {menu && f ? (
        <div className="fixed z-[50] min-w-44 py-1 rounded-md border border-line bg-panel shadow-panel text-base" style={{ left: menu.x, top: menu.y }} role="menu">
          {item(f.featureType === "sketch" ? "Edit sketch" : "Edit…", () => studio.editFeature(f.id))}
          {canEdit ? item("Rename", () => setRenaming(f.id)) : null}
          {canEdit ? item(f.suppressed ? "Unsuppress" : "Suppress", () => studio.commit(edits.suppressFeature(doc(), f.id, !f.suppressed))) : null}
          {canEdit ? item("Roll back to here", () => { const i = features.findIndex((x) => x.id === f.id); setBar(i + 1); }) : null}
          {canEdit && rollback < features.length ? item("Roll to end", () => setBar(features.length)) : null}
          {canEdit ? item("Delete", () => studio.commit(edits.deleteFeature(doc(), f.id)), true) : null}
        </div>
      ) : null}
    </div>
  );
}
