// The centre-point Arc sketch tool: the centre, where the arc starts, and round to where it ends.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { centerArc } from "../sketch/shapes";

export default defineTool({
  id: "sketch-arc-center", title: "Centre arc", hint: "Click the centre, the start, then move round and click the end.", group: "sketch", order: 42, keep: 97, menu: "Arc",
  icon: '<path d="M19 18.5A13.5 13.5 0 0 0 5.5 5"/><path class="d t" d="M5.5 5v13.5H19"/><circle class="s" cx="5.5" cy="18.5" r="2.3"/><circle class="s" cx="19" cy="18.5" r="2.1"/><circle class="s" cx="5.5" cy="5" r="2.1"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-arc-center",
  run: (studio) => startDrawTool(studio, centerArc()),
});
