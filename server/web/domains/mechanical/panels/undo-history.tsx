// The History of edits panel: every step this person made since the part studio was opened, in a few words
// each, oldest first, with the document's present state marked.  A click on a step goes back (or forward) to
// just after it: so many undos or redos in one go.  Steps after the present one are the ones undone, which a new
// edit throws away.  The words are ui/undo-labels.ts; the steps are the session's (shared/itemdoc/sync.ts).
import { definePanel } from "../core/tool";
import { cx } from "../../../shared/util";
import { useStudio } from "../ui/hooks";
import { usePanelOpen } from "../ui/panels";
import { useSessionTick } from "../ui/session-tick";
import type { PartStudio } from "../ui/studio";
import { ago, describeStep, stepsTo } from "../ui/undo-labels";

/** Go to just after step `index` (-1: before the first). */
export function goToStep(studio: PartStudio, index: number): void {
  const n = stepsTo(studio.session.history().done.length, index);
  for (let i = 0; i < Math.abs(n); i++) { if (n > 0) studio.undo(); else studio.redo(); }
}

function UndoHistory({ studio }: { studio: PartStudio }) {
  const open = usePanelOpen(studio, "undo-history");
  useSessionTick(studio);
  useStudio(studio, (s) => s.canUndo); useStudio(studio, (s) => s.canRedo); useStudio(studio, (s) => s.features);
  const past = useStudio(studio, (s) => !!s.past);
  if (!open) return null;
  const h = studio.session.history(), steps = [...h.done, ...h.undone.slice().reverse()], at = h.done.length - 1, now = Date.now();
  const row = "appearance-none border-0 m-0 [font-family:inherit] [font-size:inherit] flex w-full items-center gap-2 px-2.5 h-7 text-left";
  return (
    <div className="cad-undo-history flex flex-col py-1 text-sm" data-undo-steps={steps.length} data-undo-at={at}>
      {steps.length ? (
        <>
          <button type="button" className={cx(row, "text-ink-2 cursor-pointer hover:bg-sel-soft", at === -1 ? "bg-sel font-medium" : "bg-transparent")} disabled={past} data-undo-step="-1" onClick={() => goToStep(studio, -1)}><span className="flex-1 truncate italic">As opened</span></button>
          {steps.map((s, i) => (
            <button key={i} type="button" className={cx(row, "cursor-pointer hover:bg-sel-soft", i === at ? "bg-sel font-medium text-ink" : i > at ? "bg-transparent text-ink-3" : "bg-transparent text-ink")} disabled={past} aria-current={i === at ? "step" : undefined} data-undo-step={i} data-undone={i > at || undefined} title={i === at ? "The document is here" : i > at ? "Undone. Click to do it again, with everything before it." : "Click to go back to just after this step."} onClick={() => goToStep(studio, i)}>
              <span className="flex-none w-5 mono text-xs text-ink-3 text-right">{i + 1}</span>
              <span className={cx("flex-1 truncate", i > at && "line-through")} data-undo-label>{describeStep(s, studio.doc)}</span>
              <span className="flex-none text-xs text-ink-3">{ago(s.at, now)}</span>
            </button>
          ))}
        </>
      ) : <p className="note px-2.5 py-1 m-0">Nothing to undo yet. Every edit you make is listed here; click one to go back to it.</p>}
    </div>
  );
}

export default definePanel({
  id: "undo-history", title: "History of edits", side: "right", order: 85, open: false,
  count: (studio) => studio.session.history().done.length || null,
  render: (studio) => <UndoHistory studio={studio} />,
});
