// Isolate the parts the selection is on: every other part is hidden (I).  Again, or with nothing selected, ends it.
import { defineTool } from "../core/tool";
import { displayOf, selectedBodies } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-isolate", title: "Isolate", group: "view", order: 50, key: "i", button: false,
  icon: '<circle class="d t" cx="12" cy="12" r="9.5"/><path class="f" d="M12 6.5l5 2.8v5.4l-5 2.8-5-2.8V9.3z"/><path d="M12 6.5l5 2.8v5.4l-5 2.8-5-2.8V9.3zM7 9.3l5 2.7 5-2.7M12 12v5.5"/>',
  hint: "Show only the selected parts; again to show all (I)",
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  active: (studio) => !!displayOf(studio).getState().isolated,
  run: (studio) => {
    const d = displayOf(studio), ids = selectedBodies(studio);
    if (d.getState().isolated || !ids.length) d.isolate(null); else d.isolate(ids);
  },
});
