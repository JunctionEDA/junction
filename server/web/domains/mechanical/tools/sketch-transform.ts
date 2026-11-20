// The Transform sketch tool: move, turn or copy the selection.
import { defineTool } from "../core/tool";
import { runTransform } from "../sketch/arrange";

export default defineTool({
  id: "sketch-transform", title: "Transform", hint: "Select, take the tool, click a point, then where it goes; R turns it, C keeps the original (copy).", group: "sketch", order: 170, keep: 50,
  icon: '<rect class="d t" x="3" y="11" width="8" height="8"/><rect class="f" x="12" y="4" width="8" height="8" transform="rotate(15 16 8)"/><rect x="12" y="4" width="8" height="8" transform="rotate(15 16 8)"/><path d="M7 11V7.5a2 2 0 0 1 2-2h1.5M9 3.8l1.8 1.7L9 7.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-transform",
  run: (studio) => runTransform(studio, "sketch-transform"),
});
