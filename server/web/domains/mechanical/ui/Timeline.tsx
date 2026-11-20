// Timeline.tsx — the features as a strip along the bottom of the part studio, read from left to right: an icon
// per feature in build order, a folder as a bracket over its features (click it to fold them into one cell), and
// a marker that is the rollback bar: drag it, or use the buttons at its left.  A click selects a feature, a
// double click edits it, the pointer over one lights up what it made.  It shows the same document state as the
// feature list and may stand in for it: the control at the left chooses List, Both or Timeline (a person's
// preference, ui/prefs.ts).  The layout is ui/timeline-model.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../../shared/util";
import { foldersOf, featureTree } from "../document/folders";
import { Glyph } from "./Glyph";
import { useStudio } from "./hooks";
import { getPrefs, setPrefs, usePref } from "./prefs";
import { featureDef, type PartStudio } from "./studio";
import { tipHandlers } from "./Tip";
import { cellBuilt, markerSlot, rollbackAt, slotAt, timelineOf } from "./timeline-model";

export type HistoryView = "list" | "both" | "timeline";
export const historyView = (): HistoryView => { const p = getPrefs(); return !p.timeline ? "list" : p.featureList ? "both" : "timeline"; };
/** Show the features as the list, the timeline, or both. */
export function setHistoryView(studio: PartStudio, view: HistoryView): void {
  setPrefs({ timeline: view !== "list", featureList: view !== "timeline" });
  studio.setUi({ historyView: view });   // the docks look again at which panels they hold
}

const CELL = 30;
const FOLDER = '<path class="f" d="M3 7.5h6l2 2h10v9.5H3z"/><path d="M3 7.5h6l2 2h10v9.5H3z"/>';
const TO_START = '<path d="M6 5v14M19 6l-9 6 9 6z"/>', TO_END = '<path d="M18 5v14M5 6l9 6-9 6z"/>', BACK = '<path d="M15 6l-7 6 7 6z"/>', FORWARD = '<path d="M9 6l7 6-7 6z"/>';

export function Timeline({ studio }: { studio: PartStudio }) {
  const on = usePref("timeline");
  const list = usePref("featureList");
  const features = useStudio(studio, (s) => s.features);
  const rollback = useStudio(studio, (s) => s.rollback);
  const reports = useStudio(studio, (s) => s.reports);
  const selected = useStudio(studio, (s) => s.selectedFeatures);
  const hover = useStudio(studio, (s) => s.hoverFeature);
  const editing = useStudio(studio, (s) => s.editing?.draft.id || s.sketch?.featureId || null);
  const canRoll = useStudio(studio, (s) => !s.editing && !s.sketch);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [drag, setDrag] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const doc = studio.doc;
  const layout = useMemo(() => timelineOf(featureTree(features, doc ? foldersOf(doc) : new Map()), folded), [features, folded, doc]);
  const { cells, spans } = layout;
  const at = markerSlot(cells, rollback);
  const slot = drag ?? at.slot;
  // the marker stays in sight when the bar is moved from elsewhere (the list, the keys)
  useEffect(() => { const el = strip.current; if (!el || drag !== null) return; const x = at.slot * CELL; if (x < el.scrollLeft + 8 || x > el.scrollLeft + el.clientWidth - 8) el.scrollLeft = Math.max(0, x - el.clientWidth / 2); }, [at.slot, on]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!on) return null;
  const rollToSlot = (s: number) => { const n = rollbackAt(cells, s, features.length); studio.rollTo(n >= features.length ? null : features[n].id); };
  const slotOf = (ev: { clientX: number }) => { const el = strip.current!; return slotAt(ev.clientX - el.getBoundingClientRect().left + el.scrollLeft, 0, CELL, cells.length); };
  const step = (title: string, icon: string, to: number, attr: string) => (
    <button type="button" className="btn sm ghost p-0 w-6 h-6 min-h-0 justify-center text-ink-2" aria-label={title} disabled={!canRoll || to === at.slot || to < 0 || to > cells.length} data-timeline-step={attr} {...tipHandlers({ title })} onClick={() => rollToSlot(to)}><Glyph svg={icon} size={14} /></button>
  );
  const view = list ? "both" : "timeline";
  const depth = spans.reduce((n, s) => Math.max(n, s.depth + 1), 0);
  return (
    <div className="cad-timeline flex flex-none items-center gap-2 h-12 px-2 bg-bench border-t border-line text-sm text-ink select-none min-w-0" role="region" aria-label="Timeline" data-timeline data-view={view} data-rollback={rollback} data-count={features.length}>
      <span className="seg flex-none" role="group" aria-label="Show the features as">
        {(["list", "both", "timeline"] as const).map((v) => <button key={v} type="button" className={cx(view === v && "on")} data-history-view={v} title={v === "list" ? "The feature list only" : v === "both" ? "The feature list and this timeline" : "This timeline only"} onClick={() => setHistoryView(studio, v)}>{v === "list" ? "List" : v === "both" ? "Both" : "Timeline"}</button>)}
      </span>
      <span className="flex flex-none items-center">
        {step("Roll back to the start", TO_START, 0, "start")}{step("One step back", BACK, at.slot - 1, "back")}{step("One step forward", FORWARD, at.inside ? at.slot + 1 : at.slot + 1, "forward")}{step("Roll to the end", TO_END, cells.length, "end")}
      </span>
      <div ref={strip} className="relative flex-1 min-w-0 h-full overflow-x-auto overflow-y-hidden" data-timeline-strip>
        <div className="relative h-full" style={{ width: cells.length * CELL + 16 }}>
          {/* open folders: a bracket over their cells; a click folds them into one cell */}
          {spans.map((s) => (
            <button key={s.id} type="button" className="appearance-none m-0 p-0 absolute h-1.5 rounded-sm border-0 bg-line-2 hover:bg-[var(--mark)] cursor-pointer" style={{ left: s.from * CELL + 3, width: (s.to - s.from + 1) * CELL - 6, top: 2 + (depth - 1 - s.depth) * 3 }} data-timeline-span={s.id} data-span-name={s.name} aria-label={`Folder ${s.name}: fold`} {...tipHandlers({ title: s.name, hint: `A folder of ${s.to - s.from + 1}. Click to fold it into one cell.` })} onClick={() => setFolded(new Set([...folded, s.id]))} />
          ))}
          {cells.map((c, i) => {
            const built = cellBuilt(c, rollback);
            if (c.kind === "folder") {
              return (
                <button key={c.id} type="button" className={cx("appearance-none m-0 p-0 absolute bottom-1 flex items-center justify-center w-7 h-7 rounded-sm border border-line bg-paper text-ink cursor-pointer hover:bg-sel-soft", built === "no" && "opacity-40")} style={{ left: i * CELL + 1 }} data-timeline-cell={c.id} data-cell-kind="folder" data-cell-count={c.count} data-built={built} aria-label={`Folder ${c.name}, ${c.count} features: unfold`} {...tipHandlers({ title: c.name, hint: `${c.count} feature${c.count === 1 ? "" : "s"}. Click to unfold.` })} onClick={() => { const n = new Set(folded); n.delete(c.id); setFolded(n); }}>
                  <Glyph svg={FOLDER} size={18} /><span className="absolute -right-0.5 -bottom-0.5 px-0.5 rounded-sm bg-bench mono text-2xs leading-none text-ink-2">{c.count}</span>
                </button>
              );
            }
            const f = features[c.index], def = featureDef(f.featureType), r = reports[f.id];
            const bad = r && r.status === "error", warn = r && r.status === "warning";
            return (
              <button key={c.id} type="button" className={cx("appearance-none m-0 p-0 absolute bottom-1 flex items-center justify-center w-7 h-7 rounded-sm border text-ink cursor-pointer", selected.includes(f.id) || editing === f.id ? "border-[var(--mark)] bg-sel" : hover === f.id ? "border-line-2 bg-sel-soft" : "border-transparent hover:bg-sel-soft", (built === "no" || f.suppressed) && "opacity-40")}
                style={{ left: i * CELL + 1 }} data-timeline-cell={f.id} data-cell-kind="feature" data-cell-name={f.name} data-built={built} data-status={r?.status} data-selected={selected.includes(f.id) || undefined} aria-label={f.name}
                {...tipHandlers({ title: f.name, hint: bad || warn ? r!.message : f.suppressed ? "Suppressed" : built === "no" ? "Not built: after the marker" : def?.title })}
                onPointerEnter={() => studio.setHoverFeature(f.id)} onPointerLeave={() => studio.setHoverFeature(null)}
                onClick={(ev) => studio.selectFeature(f.id, ev.ctrlKey || ev.metaKey || ev.shiftKey)} onDoubleClick={() => { if (studio.getState().canEdit && built !== "no") studio.editFeature(f.id); }}>
                <Glyph svg={def?.icon} size={18} />
                {bad || warn ? <span className={cx("absolute right-0 top-0 w-2 h-2 rounded-full", bad ? "bg-err" : "bg-[var(--warn,orange)]")} aria-hidden="true" /> : null}
                {f.suppressed ? <span className="absolute left-1 right-1 top-1/2 border-t border-ink" aria-hidden="true" /> : null}
              </button>
            );
          })}
          {/* the marker: the rollback bar, standing in the gap before the first feature that is not built */}
          <div className={cx("absolute top-0 bottom-0 w-3 -ml-1.5 flex justify-center touch-none", canRoll ? "cursor-ew-resize" : "opacity-40")} style={{ left: slot * CELL }} role="slider" tabIndex={0} aria-label="Rollback marker" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={cells.length} aria-valuenow={slot} data-timeline-marker data-slot={slot} data-inside={at.inside || undefined} data-dragging={drag !== null || undefined}
            {...tipHandlers({ title: "Rollback marker", hint: "Drag it: only the features to its left are built. ← → move it one step." })}
            onPointerDown={(ev) => { if (!canRoll || ev.button !== 0) return; ev.preventDefault(); (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId); setDrag(at.slot); }}
            onPointerMove={(ev) => { if (drag !== null) setDrag(slotOf(ev)); }}
            onPointerUp={(ev) => { if (drag === null) return; const s = slotOf(ev); setDrag(null); if (s !== at.slot || at.inside) rollToSlot(s); }}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={(ev) => { if (!canRoll) return; const to = ev.key === "ArrowLeft" ? at.slot - 1 : ev.key === "ArrowRight" ? at.slot + 1 : ev.key === "Home" ? 0 : ev.key === "End" ? cells.length : -1; if (to < 0 || to > cells.length) return; ev.preventDefault(); ev.stopPropagation(); rollToSlot(to); }}>
            <span className="w-0.5 h-full bg-[var(--mark)]" aria-hidden="true" /><span className="absolute top-0 w-3 h-2 rounded-b-sm bg-[var(--mark)]" aria-hidden="true" />
          </div>
        </div>
      </div>
      <span className="flex-none mono text-xs text-ink-2 whitespace-nowrap" data-timeline-built>{rollback} of {features.length}</span>
    </div>
  );
}
