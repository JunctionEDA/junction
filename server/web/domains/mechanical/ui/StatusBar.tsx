// StatusBar.tsx — the strip under the viewport: what the part studio is doing, what a click will pick, how the
// open sketch stands, and — always in the same place, at the right — the units the document is worked in.
//
//   left    the modelling kernel (starting, rebuilding, failed), or the next step for an empty studio
//   middle  in a sketch: under-constrained (n freedoms), fully constrained, over-constrained; the tool's hint
//           otherwise: what is selected, and what a click picks while a dialog field listens
//   right   mm · deg · 0.001  — click to change the length unit, the angle unit and the decimal places for the
//           document; the ? opens the shortcut sheet
import { useEffect, useState, useSyncExternalStore } from "react";
import { cx } from "../../../shared/util";
import { ANGLE_UNITS, LENGTH_UNITS, MAX_PLACES } from "../document/units";
import { sketchEditor, type EditorState } from "../sketch/editor";
import { describeKinds } from "./fields";
import { useStudio } from "./hooks";
import { awaitsPlane, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";
import { setPrefs, usePref } from "./prefs";
import { setDualUnit } from "../document/dual-units";
import { setHistoryView } from "./Timeline";
import { SelectionControl } from "./SelectionControl";

/** How the sketch stands, in a few words, and the tone that says it. */
export function standing(s: EditorState): { text: string; detail: string; tone: "ok" | "free" | "bad" | "wait" } {
  if (!s.ready) return { text: "Starting the solver…", detail: "", tone: "wait" };
  if (s.health === "conflict") return { text: "Over-constrained", detail: `${s.conflicting.length} constraint${s.conflicting.length === 1 ? "" : "s"} in conflict, shown in red`, tone: "bad" };
  if (s.health === "unsolved") return { text: "Not solved", detail: "the constraints could not be met; undo the last change", tone: "bad" };
  if (!Object.keys(s.data.entities).length) return { text: "Empty sketch", detail: "", tone: "wait" };
  if (s.dof === 0) return { text: "Fully constrained", detail: s.redundant.length ? `${s.redundant.length} redundant` : "", tone: "ok" };
  return { text: "Under-constrained", detail: `${s.dof} degree${s.dof === 1 ? "" : "s"} of freedom`, tone: "free" };
}
export const TONE = { ok: "text-ink", free: "text-teal", bad: "text-err", wait: "text-ink-3" } as const;
const DOT = { ok: "bg-ink", free: "bg-teal", bad: "bg-err", wait: "bg-line-2" } as const;

function SketchStanding({ studio }: { studio: PartStudio }) {
  const ed = sketchEditor(studio);
  const s = useSyncExternalStore(ed.subscribe, ed.getState);
  if (!s.open) return null;
  const st = standing(s);
  return (
    <div className="cad-sketch-status flex items-center gap-2 min-w-0" role="status" data-standing={st.tone} data-dof={s.dof}
      {...tipHandlers({ title: "How the sketch stands", hint: "Teal: still free to move. Ink: settled by its dimensions and constraints. Red: constraints that cannot all hold." })}>
      <span className={cx("flex-none w-2 h-2 rounded-full", DOT[st.tone])} aria-hidden="true" />
      <span className={cx("font-semibold whitespace-nowrap", TONE[st.tone])}>{st.text}</span>
      {st.detail ? <span className="text-ink-2 whitespace-nowrap">{st.detail}</span> : null}
      {s.construction ? <span className="pill">construction</span> : null}
      {s.hint ? <span className="text-ink-3 truncate border-l border-line pl-2">{s.hint}</span> : null}
    </div>
  );
}

function UnitsControl({ studio }: { studio: PartStudio }) {
  const u = useStudio(studio, (s) => s.units);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const away = () => setOpen(false);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); };
  }, [open]);
  const example = (1).toFixed(u.places);
  const dual = usePref("dualUnit");
  return (
    <div className="relative flex-none" onPointerDown={(ev) => ev.stopPropagation()}>
      <button type="button" className={cx("btn sm ghost h-6 min-h-0 px-2 gap-1.5 mono text-sm", open && "on")} aria-haspopup="dialog" aria-expanded={open} aria-label={`Units: ${u.length}, ${u.angle}, ${u.places} decimal places. Change`} data-units={`${u.length} ${u.angle} ${u.places}`}
        {...tipHandlers({ title: "Units", hint: "The length unit, the angle unit and the decimal places this document is worked in. Any field also takes a unit typed with the number: 1 in, 25.4 mm." })} onClick={() => setOpen(!open)}>
        <span className="font-semibold text-ink" data-units-length>{u.length}</span><span className="text-ink-3">·</span><span className="text-ink" data-units-angle>{u.angle}</span><span className="text-ink-3">·</span><span className="text-ink" data-units-places>{example}</span>
      </button>
      {open ? (
        <div className="cad-units absolute right-0 bottom-full mb-1 z-[50] w-72 p-2.5 flex flex-col gap-2 rounded-md border border-line bg-panel shadow-panel text-sm text-ink" role="dialog" aria-label="Units of this document">
          <div className="font-semibold">Units of this document</div>
          <label className="flex items-center gap-2"><span className="w-16 text-ink-2">Length</span>
            <span className="seg">{LENGTH_UNITS.map((x) => <button key={x.id} type="button" className={cx(u.length === x.id && "on")} disabled={!canEdit} title={x.title} data-unit-length={x.id} onClick={() => studio.setUnits({ length: x.id })}>{x.id}</button>)}</span>
          </label>
          <label className="flex items-center gap-2"><span className="w-16 text-ink-2">Angle</span>
            <span className="seg">{ANGLE_UNITS.map((x) => <button key={x.id} type="button" className={cx(u.angle === x.id && "on")} disabled={!canEdit} title={x.title} data-unit-angle={x.id} onClick={() => studio.setUnits({ angle: x.id })}>{x.id}</button>)}</span>
          </label>
          <div className="flex items-center gap-2"><span className="w-16 text-ink-2">Decimals</span>
            <button type="button" className="btn sm w-6 p-0 justify-center" disabled={!canEdit || u.places <= 0} aria-label="Fewer decimal places" data-unit-places="less" onClick={() => studio.setUnits({ places: u.places - 1 })}>−</button>
            <span className="mono w-16 text-center" data-unit-places-shown={u.places}>{example}</span>
            <button type="button" className="btn sm w-6 p-0 justify-center" disabled={!canEdit || u.places >= MAX_PLACES} aria-label="More decimal places" data-unit-places="more" onClick={() => studio.setUnits({ places: u.places + 1 })}>+</button>
          </div>
          <div className="flex items-center gap-2 border-t border-line pt-2"><span className="w-16 text-ink-2" title="Only for you: a second unit in brackets after sketch dimensions and measurements">Also in</span>
            <span className="seg">{[{ id: "", title: "No second unit" }, ...LENGTH_UNITS.filter((x) => x.id !== u.length)].map((x) => <button key={x.id || "none"} type="button" className={cx(dual === x.id && "on")} title={x.title} data-unit-dual={x.id || "none"} onClick={() => { setPrefs({ dualUnit: x.id }); setDualUnit(x.id); studio.setUi({ dualUnit: x.id }); const s = studio.getState(); if (!s.sketch && !s.editing && s.selection.length) studio.select(s.selection.slice());   /* what is measured is written again */ }}>{x.id || "none"}</button>)}</span>
          </div>
          <p className="note m-0 text-xs">{canEdit ? "For everybody working on this document. Nothing in the model changes size: only how numbers are shown and what a bare number typed into a field means." : "You can look at this document but not change its units."}</p>
        </div>
      ) : null}
    </div>
  );
}

export function StatusBar({ studio }: { studio: PartStudio }) {
  const kernel = useStudio(studio, (s) => s.kernel);
  const loaded = useStudio(studio, (s) => s.loaded);
  const status = useStudio(studio, (s) => s.status);
  const empty = useStudio(studio, (s) => s.loaded && !s.features.length && !s.editing);
  const sketch = useStudio(studio, (s) => !!s.sketch);
  const field = useStudio(studio, (s) => s.editing?.field || null);
  const picking = useStudio(studio, (s) => !!s.ui?.pickingPlane);
  const selected = useStudio(studio, (s) => s.selection.length);
  const past = useStudio(studio, (s) => s.past?.label);
  const waiting = useStudio(studio, (s) => awaitsPlane(s));
  const progress = useSyncExternalStore(studio.regenProgress.subscribe, studio.regenProgress.getState);
  const features = useStudio(studio, (s) => s.features);
  const editingName = useStudio(studio, (s) => s.editing?.draft.name || null);
  const share = kernel.state === "working" && progress.total > 1 ? Math.min(1, (progress.index + 1) / progress.total) : null;
  const timeline = usePref("timeline");
  let text = "", busy = false;
  if (!loaded) { text = status.state === "error" ? status.text : "Opening the part studio…"; busy = status.state !== "error"; }
  else if (kernel.state === "loading") { text = "Starting the modelling kernel (once per visit). You can look around and read the feature list meanwhile."; busy = true; }
  else if (kernel.state === "failed") text = kernel.message || "The modelling kernel stopped.";
  else if (kernel.state === "working") {
    // which feature the rebuild is on, of how many: a long rebuild is not a spinner that says nothing
    const name = progress.featureId ? features.find((f) => f.id === progress.featureId)?.name || editingName : null;
    text = progress.total > 1 && name ? `Rebuilding ${Math.min(progress.index + 1, progress.total)} of ${progress.total}: ${name}` : "Rebuilding…"; busy = true;
  }
  else if (past !== undefined) text = "An earlier version: nothing can be edited.";
  else if (waiting) text = "Select a plane or a planar face for the new sketch.";
  else if (empty) text = "Choose Sketch to start a part.";
  const kinds = field ? studio.pickFilter() : picking ? ["plane", "face", "datum"] : null;
  return (
    <footer className="cad-status flex items-center gap-3 h-7 px-2.5 bg-bench border-t border-line text-sm text-ink-2 select-none min-w-0" aria-label="Part studio status">
      {text ? (
        <span className={cx("cad-note flex items-center gap-1.5 min-w-0", kernel.state === "failed" && "text-err")} role="status" data-kernel={kernel.state}>
          {busy ? <span className="spinner flex-none" style={{ width: 10, height: 10 }} aria-hidden="true" /> : null}<span className="truncate">{text}</span>
          {share !== null ? <span className="flex-none w-24 h-1.5 rounded-full bg-line overflow-hidden" role="progressbar" aria-label="Rebuild" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.index + 1} data-regen-progress={`${progress.index + 1}/${progress.total}`}><span className="block h-full bg-[var(--mark)]" style={{ width: `${Math.round(share * 100)}%` }} /></span> : null}
        </span>
      ) : <span className="cad-note hidden" role="status" data-kernel={kernel.state} />}
      {sketch ? <SketchStanding studio={studio} /> : null}
      {kinds ? <span className="flex items-center gap-1 whitespace-nowrap" data-pick-filter={kinds.join(" ")}><span className="pill info">picks</span>{describeKinds(kinds)}</span> : null}
      <span className="flex-1" />
      {!sketch && selected ? <span className="whitespace-nowrap mono" data-selected-count={selected}>{selected} selected</span> : null}
      <SelectionControl studio={studio} />
      <button type="button" className={cx("btn sm ghost h-6 min-h-0 px-1.5 text-sm flex-none", timeline && "on")} aria-pressed={timeline} aria-label="Timeline" data-timeline-toggle {...tipHandlers({ title: "Timeline", hint: "The features as a strip along the bottom, with a marker to drag for the rollback. It can stand beside the feature list or in its place." })} onClick={() => setHistoryView(studio, timeline ? "list" : "both")}>Timeline</button>
      <UnitsControl studio={studio} />
      <button type="button" className="btn sm ghost h-6 min-h-0 w-6 p-0 justify-center mono text-sm text-ink flex-none" aria-label="Keyboard shortcuts" data-shortcuts-open {...tipHandlers({ title: "Keyboard shortcuts", shortcut: "?" })} onClick={() => studio.setUi({ help: true })}>?</button>
    </footer>
  );
}
