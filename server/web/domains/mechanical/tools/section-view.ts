// Section view: cut the model by a plane (a default plane, or the selected flat face) to see inside it.
import { defineTool } from "../core/tool";
import { toggleSection } from "../inspect/section-pick";
import { sectionOf } from "../inspect/section-view";

export default defineTool({
  id: "section-view", title: "Section", hint: "Cut the view by a plane: the selected flat face, or Front (X)", group: "inspect", order: 20, keep: 79, key: "x",
  icon: '<path class="f" d="M12 3.5a8.5 8.5 0 0 0 0 17z"/><path d="M12 3.5a8.5 8.5 0 0 0 0 17"/><path class="d t" d="M12 3.5a8.5 8.5 0 0 1 0 17"/><path d="M12 1.5v21"/>',
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : !studio.getState().bodies.length ? "Nothing to cut" : null),
  active: (studio) => sectionOf(studio).getState().on,
  run: (studio) => { void toggleSection(studio); },
});
