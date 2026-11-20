// Press/Pull (Q): one tool that does what the thing under it calls for.  With a face, an edge or a sketch region
// selected it starts the feature at once (a flat face or a region is extruded, a curved face is offset, an edge
// is rounded) with that pick in it and the distance ready to type.  With nothing selected it waits for the next
// click.  ui/press-pull.ts says what a pick means.
import { defineTool, toolsChanged } from "../core/tool";
import { PRESS_PULL_HINT, pullFor } from "../ui/press-pull";
import { featureDef, type PartStudio } from "../ui/studio";
import type { Pick } from "../viewport/modelview";

/** the studios that are waiting for a click, each with what ends the wait */
const armed = new WeakMap<PartStudio, () => void>();

/** Start the feature a pick calls for.  False (with a word to the person) when Press/Pull has nothing for it. */
export function pressPull(studio: PartStudio, pick: Pick, all: Pick[] = [pick]): boolean {
  const pull = pullFor(pick, !!studio.view.normalOf(pick), (t) => !!featureDef(t));
  if ("why" in pull) { studio.host.toast(pull.why, 3000); return false; }
  studio.select(all);
  studio.startFeature(pull.feature);
  const e = studio.getState().editing;
  if (!e || e.draft.featureType !== pull.feature) return false;
  if (pull.params) studio.setDraft({ params: pull.params as never });
  // the distance is what is typed next: its field has the keyboard, with what is in it selected
  let tries = 0;
  const focus = () => {
    const input = document.querySelector<HTMLInputElement>(`.cad-dialog[data-feature="${pull.feature}"] input[inputmode=decimal]`);
    if (input) { input.focus(); input.select(); } else if (++tries < 20) requestAnimationFrame(focus);
  };
  requestAnimationFrame(focus);
  return true;
}

function disarm(studio: PartStudio): void { const stop = armed.get(studio); if (stop) stop(); }
function arm(studio: PartStudio): void {
  const before = studio.getState().selection;
  const hadKeys = studio.keyHandler;
  const unsubscribe = studio.subscribe(() => {
    const s = studio.getState();
    if (s.editing || s.sketch || !s.canEdit) { stop(); return; }
    if (s.selection !== before && s.selection.length) { const p = s.selection[s.selection.length - 1]; stop(); pressPull(studio, p); }
  });
  const stop = () => {
    unsubscribe(); armed.delete(studio);
    if (studio.keyHandler === keys) studio.keyHandler = hadKeys;
    if (studio.getState().ui?.pressPull) studio.setUi({ pressPull: false });
    toolsChanged();
  };
  const keys = (ev: KeyboardEvent): boolean => { if (ev.key !== "Escape") return false; stop(); return true; };
  studio.keyHandler = keys;
  armed.set(studio, stop);
  studio.setUi({ pressPull: true });
  studio.host.toast(PRESS_PULL_HINT, 2500);
  toolsChanged();
}

export default defineTool({
  id: "press-pull", title: "Press/Pull", hint: "One tool for the commonest edits: extrude a face or a sketch region, offset a curved face, round an edge. Select first, or click after.",
  icon: '<path class="f" d="M4 14h16v6H4z"/><path d="M4 14h16v6H4z"/><path d="M12 12V3M8.5 6.5L12 3l3.5 3.5"/><path class="d" d="M4 14V9h16v5"/>',
  group: "feature", section: "modify", order: 5, keep: 76, key: "q",
  disabled: (studio) => { const s = studio.getState(); return !s.canEdit ? "View-only access" : s.sketch ? "Finish the sketch first" : null; },
  active: (studio) => armed.has(studio),
  run(studio) {
    if (armed.has(studio)) { disarm(studio); return; }
    const s = studio.getState();
    if (s.editing) studio.cancelFeature();
    const pick = s.selection[s.selection.length - 1];
    // several edges, or several faces, selected: all of them go into the one feature
    if (pick) { pressPull(studio, pick, s.selection.filter((p) => p.kind === pick.kind)); return; }
    arm(studio);
  },
});
