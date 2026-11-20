// Perspective or orthographic projection.  (P is the planes, as an Onshape user's hands expect.)
import { defineTool } from "../core/tool";
import { displayOf } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-projection", title: "Perspective", group: "view", order: 30,
  hint: "Switch between perspective and orthographic projection.",
  icon: '<rect x="3" y="3" width="18" height="18" rx="1"/><rect class="f" x="9" y="9" width="6" height="6"/><rect class="t" x="9" y="9" width="6" height="6"/><path class="t" d="M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => displayOf(studio).getState().perspective,
  run: (studio) => { const d = displayOf(studio); d.setPerspective(!d.getState().perspective); },
});
