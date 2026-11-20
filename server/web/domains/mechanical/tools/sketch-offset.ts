// The Offset tool: a copy of curves a set distance to one side, kept parallel and driven by one dimension.
import { defineTool } from "../core/tool";
import { runOffset } from "../sketch/modify";

export default defineTool({
  id: "sketch-offset", title: "Offset", hint: "Select curves (or click one), then click the side. Type a distance to set it.", group: "sketch", order: 110, keep: 84, key: "o",
  icon: '<rect class="d t" x="2.5" y="2.5" width="19" height="19" rx="4"/><rect class="f" x="7.5" y="7.5" width="9" height="9" rx="1"/><rect x="7.5" y="7.5" width="9" height="9" rx="1"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-offset",
  run: (studio) => runOffset(studio, "sketch-offset"),
});
