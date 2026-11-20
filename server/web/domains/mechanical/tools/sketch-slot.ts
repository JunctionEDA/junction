// The Slot sketch tool: the centres of the two ends, then the width; two lines and two arcs, tangent where they join.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { slot } from "../sketch/shapes";

export default defineTool({
  id: "sketch-slot", title: "Slot", hint: "Click the centre of each end, then set the width.", group: "sketch", order: 50, keep: 72,
  icon: '<rect class="f" x="2.5" y="7" width="19" height="10" rx="5"/><rect x="2.5" y="7" width="19" height="10" rx="5"/><circle class="s" cx="7.5" cy="12" r="1.7"/><circle class="s" cx="16.5" cy="12" r="1.7"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-slot",
  run: (studio) => startDrawTool(studio, slot),
});
