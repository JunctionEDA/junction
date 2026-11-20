// SelectionControl.tsx — what a click selects, and selections kept by name.
//
//   SelectionControl   the button in the status bar ("Select: All ▾").  Its window has the selection filter —
//                      which kinds of thing a click and a box take: faces, edges, vertices, sketches, planes,
//                      reference geometry — and the selection sets: keep what is selected under a name, click a
//                      set to select it again, add it to the selection with Ctrl (document/selection-sets.ts).
//   SelectOther        the list a right click's "Select other…" opens: everything under the pointer, front to
//                      back, so a face behind another can be had without turning the model.
//
// The filter is this person's and lasts as long as the tab; while a dialog's field listens, the field decides.
import { useEffect, useState } from "react";
import { cx } from "../../../shared/util";
import { SELECT_KINDS, cleanFilter, filterLabel, removeSelectionSet, saveSelectionSet, selectionSets, toggleKind, unpackPicks, nextSetName, type PickLike, type SelectionSetItem } from "../document/selection-sets";
import { pickKey, type Pick, type PickKind } from "../viewport/modelview";
import { useStudio } from "./hooks";
import { studioExtensions, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";

export const selectionFilter = (studio: PartStudio): string[] | null => cleanFilter(studio.getState().ui?.selectionFilter);

/** A stored set as picks of the model as it is now, and how many of its things are gone. */
export function picksOfSet(studio: PartStudio, set: SelectionSetItem): { picks: Pick[]; missing: number } {
  const s = studio.getState();
  const names = new Map(s.bodies.map((b) => [b.id, b.mesh ? { face: new Set(b.mesh.faces.names), edge: new Set(b.mesh.edges.names), vertex: new Set(b.mesh.vertices.names) } : null]));
  const r = unpackPicks(set.picks, {
    has: (kind, body, name) => !!names.get(body)?.[kind].has(name),
    hasPlane: (plane) => plane === "top" || plane === "front" || plane === "right",
    hasDatum: (featureId, datum) => s.datums.some((d) => d.featureId === featureId && d.kind === datum),
  });
  return { picks: r.picks.map((p) => ({ ...p, point: [0, 0, 0] }) as unknown as Pick), missing: r.missing };
}

export function selectSet(studio: PartStudio, set: SelectionSetItem, add = false): void {
  const { picks, missing } = picksOfSet(studio, set);
  const now = add ? studio.getState().selection : [], keys = new Set(now.map(pickKey));
  studio.select([...now, ...picks.filter((p) => !keys.has(pickKey(p)))]);
  if (missing) studio.host.toast(`${missing} thing${missing === 1 ? "" : "s"} of “${set.name}” no longer exist${missing === 1 ? "s" : ""}.`, 3500);
}

export function SelectionControl({ studio }: { studio: PartStudio }) {
  const filter = useStudio(studio, (s) => s.ui?.selectionFilter);
  const selection = useStudio(studio, (s) => s.selection);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const sketch = useStudio(studio, (s) => !!s.sketch);
  useStudio(studio, (s) => s.ui?.selectionTick);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    if (!open) return;
    const away = () => setOpen(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  if (sketch) return null;
  const kinds = cleanFilter(filter), doc = studio.doc, sets = selectionSets(doc);
  const tick = () => studio.setUi({ selectionTick: Date.now() });
  const save = () => {
    if (!doc) return;
    const r = saveSelectionSet(doc, name, selection as unknown as PickLike[]);
    if (!r.changes.length) { studio.host.toast("Select faces, edges, vertices, planes or reference geometry first.", 3000); return; }
    studio.commit(r.changes); setName(""); tick();
    if (r.left) studio.host.toast(`${r.left} of the selection could not be kept (sketch regions are not).`, 3500);
  };
  return (
    <div className="relative flex-none" onPointerDown={(ev) => ev.stopPropagation()}>
      <button type="button" className={cx("btn sm ghost h-6 min-h-0 px-1.5 gap-1 text-sm", (open || kinds) && "on")} aria-haspopup="dialog" aria-expanded={open} data-selection-control data-selection-filter={kinds ? kinds.join(" ") : "all"}
        {...tipHandlers({ title: "Selection", hint: "Which kinds of thing a click selects, and selections kept by name." })} onClick={() => setOpen(!open)}>
        <span className="text-ink-2">Select:</span><span className="text-ink">{filterLabel(kinds)}</span>
      </button>
      {open ? (
        <div className="cad-selection absolute right-0 bottom-full mb-1 z-[50] w-72 p-2.5 flex flex-col gap-2 rounded-md border border-line bg-panel shadow-panel text-sm text-ink" role="dialog" aria-label="Selection">
          <div className="flex items-center"><span className="flex-1 font-semibold">A click selects</span><button type="button" className="btn sm ghost" disabled={!kinds} data-filter-all onClick={() => studio.setUi({ selectionFilter: null })}>Everything</button></div>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
            {SELECT_KINDS.map((k) => <label key={k.id} className="flex items-center gap-1.5"><input type="checkbox" checked={!kinds || kinds.includes(k.id)} data-filter-kind={k.id} onChange={() => studio.setUi({ selectionFilter: toggleKind(kinds, k.id) })} /><span>{k.title}</span></label>)}
          </div>
          <div className="border-t border-line pt-2 font-semibold">Selection sets</div>
          {sets.length ? (
            <div className="flex flex-col max-h-40 overflow-y-auto" role="list">
              {sets.map((s) => (
                <div key={s.id} role="listitem" className="flex items-center gap-1 h-7" data-selection-set={s.name} data-set-count={s.picks.length}>
                  <button type="button" className="appearance-none border-0 bg-transparent m-0 p-0 px-1 flex-1 min-w-0 h-full text-left text-inherit [font-family:inherit] [font-size:inherit] cursor-pointer rounded-sm hover:bg-sel-soft truncate" title="Select these. Ctrl: add them to the selection." data-set-select onClick={(ev) => { selectSet(studio, s, ev.ctrlKey || ev.metaKey || ev.shiftKey); }}>{s.name}</button>
                  <span className="mono text-xs text-ink-3">{s.picks.length}</span>
                  <button type="button" className="btn sm ghost p-0 w-6 justify-center" aria-label={`Delete ${s.name}`} disabled={!canEdit} data-set-delete onClick={() => { if (doc) { studio.commit(removeSelectionSet(doc, s.id)); tick(); } }}>×</button>
                </div>
              ))}
            </div>
          ) : <p className="note m-0 text-xs">None yet. Select faces or edges you will want again, and keep them under a name.</p>}
          <form className="flex items-center gap-1" onSubmit={(ev) => { ev.preventDefault(); save(); }}>
            <input type="text" className="input h-6 text-sm flex-1 min-w-0" placeholder={doc ? nextSetName(doc) : "Name"} aria-label="Name of the selection set" value={name} disabled={!canEdit} data-set-name onChange={(ev) => setName(ev.target.value)} onKeyDown={(ev) => ev.stopPropagation()} />
            <button type="submit" className="btn sm" disabled={!canEdit || !selection.length} data-set-save title={selection.length ? "Keep what is selected under this name (a set with the name is replaced)" : "Nothing is selected"}>Keep {selection.length || ""} selected</button>
          </form>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- select other
interface OtherAt { x: number; y: number; picks: Pick[] }

/** Open the list of everything under a point of the viewport (false: there is only one thing there). */
export function openSelectOther(studio: PartStudio, at: { x: number; y: number }): boolean {
  const picks = studio.view.pickAll({ clientX: at.x, clientY: at.y });
  if (picks.length < 2) { studio.host.toast(picks.length ? "Nothing else is under the pointer." : "Nothing is under the pointer.", 2500); return false; }
  studio.setUi({ selectOther: { x: at.x, y: at.y, picks } });
  return true;
}

export function SelectOther({ studio }: { studio: PartStudio }) {
  const at = useStudio(studio, (s) => (s.ui?.selectOther as OtherAt | undefined) || null);
  const close = () => { studio.view.setFeatureHover(null); studio.setUi({ selectOther: null }); };
  useEffect(() => {
    if (!at) return;
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); close(); } };
    const away = () => close();
    document.addEventListener("keydown", key, true); document.addEventListener("pointerdown", away);
    return () => { document.removeEventListener("keydown", key, true); document.removeEventListener("pointerdown", away); };
  }, [at]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!at) return null;
  const s = studio.getState(), ids = s.features.map((f) => f.id);
  const label = (p: Pick): string => {
    if (p.kind === "plane") return `${p.plane[0].toUpperCase()}${p.plane.slice(1)} plane`;
    const owner = studio.view.featureOf(p, ids), made = owner ? s.features.find((f) => f.id === owner)?.name : "";
    if (p.kind === "sketch") return made || "Sketch";
    if (p.kind === "datum") return made || "Reference geometry";
    const part = s.bodies.find((b) => b.id === p.body)?.name || "a part";
    return `${p.kind[0].toUpperCase()}${p.kind.slice(1)} of ${part}${made ? ` · ${made}` : ""}`;
  };
  const h = at.picks.length * 28 + 34;
  return (
    <div className="cad-select-other fixed z-[57] min-w-56 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" aria-label="Select other" style={{ left: Math.min(at.x + 8, window.innerWidth - 250), top: Math.max(6, Math.min(at.y - 10, window.innerHeight - h - 6)) }} onPointerDown={(ev) => ev.stopPropagation()} onPointerLeave={() => studio.view.setFeatureHover(null)}>
      <div className="px-3 h-6 text-2xs uppercase tracking-wide text-ink-3 mono">Under the pointer, front to back</div>
      {at.picks.map((p, i) => (
        <button key={pickKey(p) + i} type="button" role="menuitem" className="appearance-none border-0 bg-transparent m-0 text-inherit [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2 px-3 h-7 text-left cursor-pointer hover:bg-sel-soft" data-other={i} data-other-kind={p.kind} data-other-label={label(p)}
          onPointerEnter={() => studio.view.setFeatureHover([p])}
          onClick={(ev) => { const many = ev.ctrlKey || ev.metaKey || ev.shiftKey, now = studio.getState().selection; close(); studio.select(many ? [...now.filter((x) => pickKey(x) !== pickKey(p)), p] : [p]); studio.viewport.canvas.focus(); }}>
          <span className="flex-none w-4 mono text-xs text-ink-3">{i + 1}</span><span className="flex-1 truncate">{label(p)}</span>
        </button>
      ))}
    </div>
  );
}

// the filter holds whenever no dialog's field, sketch or plane picker has the viewport to itself
studioExtensions.push((studio) => {
  let applied = "";
  return studio.subscribe(() => {
    const s = studio.getState();
    if (s.editing || s.sketch || s.ui?.pickingPlane) { applied = "busy"; return; }
    const kinds = cleanFilter(s.ui?.selectionFilter), sig = kinds ? kinds.join() : "all";
    if (sig === applied) return;
    applied = sig;
    studio.view.setFilter(kinds as PickKind[] | null);
    // what the filter no longer lets through is no longer selected
    if (kinds && s.selection.some((p) => !kinds.includes(p.kind))) studio.select(s.selection.filter((p) => kinds.includes(p.kind)));
  });
});
