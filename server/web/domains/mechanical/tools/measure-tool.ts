// Measure: while on, what is selected is drawn on the model as dimension lines (the readout in the corner shows
// the selection's measurements whether it is on or not).  Pin keeps a measurement on the model.
import { defineTool } from "../core/tool";
import { measureOf } from "../inspect/measure-session";

export default defineTool({
  id: "measure", title: "Measure", hint: "Pick faces, edges, vertices or planes: distances, angles, lengths, radii and areas (M)", group: "inspect", order: 10, keep: 80, key: "m",
  icon: '<rect class="f" x="2" y="7.5" width="20" height="9" rx="1.2"/><rect x="2" y="7.5" width="20" height="9" rx="1.2"/><path d="M6 7.5v3.5M10 7.5v5M14 7.5v3.5M18 7.5v5"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => measureOf(studio).getState().active,
  run: (studio) => { const m = measureOf(studio); m.setActive(!m.getState().active); },
});
