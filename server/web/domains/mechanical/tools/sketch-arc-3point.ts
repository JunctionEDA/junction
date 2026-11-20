// The three-point Arc sketch tool: start, end, then a point the arc passes through.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { arc3 } from "../sketch/shapes";

export default defineTool({
  id: "sketch-arc-3point", title: "Arc", hint: "Click the start, the end, then a point on the arc.", group: "sketch", order: 40, keep: 97, key: "a", menu: "Arc",
  icon: '<path d="M5 18.5a8 8 0 1 1 14 0"/><circle class="s" cx="5" cy="18.5" r="2.3"/><circle class="s" cx="19" cy="18.5" r="2.3"/><circle class="s" cx="12" cy="6.6" r="2.3"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-arc-3point",
  run: (studio) => startDrawTool(studio, arc3),
});
