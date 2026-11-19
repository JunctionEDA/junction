// Construction: turn the selected curves into construction geometry (dashed, no profile) and back; with nothing
// selected, switch whether what is drawn next is construction geometry.
import { defineTool } from "../core/tool";
import { sketchEditor } from "../sketch/editor";

export default defineTool({
  id: "sketch-construction", title: "Construction", hint: "Make the selected curves construction geometry, or draw the next ones as such.", group: "sketch", order: 60, keep: 90, key: "q",
  icon: '<path class="d" d="M4.5 19.5L19.5 4.5"/><circle cx="4.5" cy="19.5" r="2"/><circle cx="19.5" cy="4.5" r="2"/>',
  active: (studio) => sketchEditor(studio).getState().construction,
  run: (studio) => sketchEditor(studio).toggleConstruction(),
});
