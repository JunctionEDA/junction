// The Control point spline sketch tool: a B-spline shaped by control points.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { controlPointSpline } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-control-spline", title: "Control point spline", hint: "Click its control points; Enter ends it. The control polygon is drawn as construction lines.", group: "sketch", order: 53, keep: 74, menu: "Spline",
  icon: '<path class="d t" d="M3 19L7 5l10 0 4 14"/><path d="M3 19C5.5 9 8 7 12 7s6.5 2 9 12"/><circle class="s" cx="7" cy="5" r="1.9"/><circle class="s" cx="17" cy="5" r="1.9"/><circle class="s" cx="3" cy="19" r="1.9"/><circle class="s" cx="21" cy="19" r="1.9"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-control-spline",
  run: (studio) => startDrawTool(studio, controlPointSpline),
});
