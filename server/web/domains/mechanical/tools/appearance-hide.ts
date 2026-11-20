// Hide the parts the selection is on (H); with nothing selected, show every part again.
import { defineTool } from "../core/tool";
import { displayOf, selectedBodies } from "../inspect/appearance-display";

export default defineTool({
  id: "appearance-hide", title: "Hide", group: "view", order: 40, key: "h", button: false,
  icon: '<path d="M4 4l16 16"/><path d="M10 5.7a9 9 0 0 1 2-.2c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.4 7.5A16.6 16.6 0 0 0 2.5 12s3.5 6.5 9.5 6.5c1.2 0 2.3-.25 3.3-.65"/>',
  hint: "Hide the selected parts; with nothing selected, show all (H)",
  disabled: (studio) => (studio.getState().sketch ? "Finish the sketch first" : null),
  run: (studio) => {
    const d = displayOf(studio), ids = selectedBodies(studio);
    if (ids.length) { d.hide(ids); studio.select([]); } else d.showAll();
  },
});
