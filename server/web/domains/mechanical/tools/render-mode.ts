// Render: the model as a photograph.  The viewport shows it path traced under studio lights, refining while
// nothing moves; a panel has the lights, the ground, the camera, and saving a still or a turntable film.
import { defineTool } from "../core/tool";
import { renderOf } from "../inspect/render-scene";

export default defineTool({
  id: "render-mode", title: "Render", group: "inspect", order: 90, keep: 30,
  hint: "A photograph of the model: ray traced under studio lights, with a still or a 360° turntable film to save",
  icon: '<circle cx="12" cy="11" r="7"/><path d="M8.300 8.800a4.600 4.600 0 0 1 2.900-2.300"/><path class="t" d="M4.500 20.500h15"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : !studio.getState().bodies.length ? "Nothing to render yet" : null),
  active: (studio) => renderOf(studio).getState().on,
  run: (studio) => renderOf(studio).toggle(),
});
