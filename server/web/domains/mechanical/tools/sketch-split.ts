// The Split sketch tool: cut a curve in two at a point.
import { defineTool } from "../core/tool";
import { runSplit } from "../sketch/modify";

export default defineTool({
  id: "sketch-split", title: "Split", hint: "Click a line or an arc where it should be cut in two.", group: "sketch", order: 155, keep: 45,
  icon: '<path d="M3 18l7-7"/><path d="M14 10l7-7"/><circle class="s" cx="12" cy="12" r="2.3"/><path class="t" d="M9 6l6 12"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-split",
  run: (studio) => runSplit(studio, "sketch-split"),
});
