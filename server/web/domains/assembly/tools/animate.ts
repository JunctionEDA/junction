// Animate: move one freedom of the assembly through its range (a mate's angle or distance), by a slider or by
// playing it.  Nothing is stored unless the slider is left somewhere else.
import { defineAssemblyTool } from "../core/tool";
import { openAnimate } from "../panels/animate";

export default defineAssemblyTool({
  id: "animate", title: "Animate", hint: "Move a mate through its range: drag the slider, or play it.", section: "view", order: 30, keep: 40,
  keywords: "motion play move simulate sweep range drive mechanism",
  icon: '<circle cx="12" cy="12" r="8.5"/><path class="f" d="M10 8.2l6 3.8-6 3.8z"/><path d="M10 8.2l6 3.8-6 3.8z"/>',
  disabled: (a) => (a.getState().mating ? "Finish the mate first" : a.drivable().length ? null : "No mate here leaves an angle or a distance free"),
  active: (a) => a.getState().panels.some((p) => p.id === "animate"),
  run: (a) => { if (a.getState().panels.some((p) => p.id === "animate")) a.closePanel("animate"); else openAnimate(a); },
});
