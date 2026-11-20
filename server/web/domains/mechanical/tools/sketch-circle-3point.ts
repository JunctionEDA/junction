// The 3-point circle sketch tool: a circle through three points.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { circle3 } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-circle-3point", title: "3-point circle", hint: "Click three points the circle passes through.", group: "sketch", order: 32, keep: 98, menu: "Circle",
  icon: '<circle class="f" cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="8.5"/><circle class="s" cx="4.2" cy="15.3" r="2.2"/><circle class="s" cx="12" cy="3.5" r="2.2"/><circle class="s" cx="19.8" cy="15.3" r="2.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-circle-3point",
  run: (studio) => startDrawTool(studio, circle3),
});
