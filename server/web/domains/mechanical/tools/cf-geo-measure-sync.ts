// cf-geo-measure-sync.ts — the page's half of Measure to variable (features/cf-geo-measure.ts): after each
// regeneration, what the document's Measure features measured is written into the variables they name, and the
// features that use those variables are rebuilt with the new values.  It runs for whoever may edit the
// document, on the document's own features only (never on a dialog's draft, an open sketch or an earlier
// version), and changes nothing when the values are already there, so the page settles after one more round.
// A measurement that depends on its own variable would never settle: it is stopped after a few rounds.
//
// The tool has no button; it is in the tool search as "Update measured variables" and does the same on demand.
import { defineTool } from "../core/tool";
import type { RegenResult } from "../kernel/protocol";
import { measuredChanges, type MeasuredValue } from "../features/_cf-geo-measured";
import { studioExtensions, type PartStudio } from "../ui/studio";

const ROUNDS = 6, WINDOW_MS = 4000;

function measuredIn(studio: PartStudio, result: { datums?: RegenResult["datums"] }): MeasuredValue[] {
  const mine = new Set(studio.getState().features.filter((f) => f.featureType === "cf-geo-measure").map((f) => f.id));
  const out: MeasuredValue[] = [];
  for (const d of result.datums || []) {
    const m = (d as unknown as { measure?: MeasuredValue }).measure;
    if (m && mine.has(d.featureId)) out.push(m);
  }
  return out;
}

/** Write the measured values into their variables; returns how many variables were changed. */
export function syncMeasured(studio: PartStudio, result: { datums?: RegenResult["datums"] }, recent: number[] = []): number {
  const s = studio.getState(), doc = studio.doc;
  if (!doc || !s.canEdit || s.editing || s.sketch || s.past) return 0;
  const changes = measuredChanges(doc, measuredIn(studio, result));
  if (!changes.length) return 0;
  const now = Date.now();
  while (recent.length && now - recent[0] > WINDOW_MS) recent.shift();
  if (recent.length >= ROUNDS) {
    if (recent.length === ROUNDS) { recent.push(now); studio.host.toast("A measured variable keeps changing its own measurement. Move the features that use it below the Measure feature.", 6000); }
    return 0;
  }
  recent.push(now);
  return studio.commit(changes, { undoable: false }) ? changes.length : 0;
}

studioExtensions.push((studio) => {
  const recent: number[] = [];
  const fn = (result: RegenResult) => { syncMeasured(studio, result, recent); };
  studio.onRegen.push(fn);
  return () => { const i = studio.onRegen.indexOf(fn); if (i >= 0) studio.onRegen.splice(i, 1); };
});

export default defineTool({
  id: "cf-geo-measure-sync", title: "Update measured variables", group: "inspect", button: false,
  hint: "Write what the Measure to variable features measure into their variables now.",
  run: (studio) => { const n = syncMeasured(studio, { datums: studio.getState().datums }); studio.host.toast(n ? "Measured variables updated" : "Measured variables are up to date", 1800); },
});
