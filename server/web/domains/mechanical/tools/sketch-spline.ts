// The Spline sketch tool: a smooth curve through points.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { spline } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-spline", title: "Spline", hint: "Click the points it passes through; Enter ends it, a click on the first point closes it. H adds end handles.", group: "sketch", order: 52, keep: 74, key: "s", menu: "Spline",
  icon: '<path d="M3 17c3-9 6-11 9-6s6 4 9-5"/><circle class="s" cx="3" cy="17" r="2"/><circle class="s" cx="12" cy="11" r="2"/><circle class="s" cx="21" cy="6" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-spline",
  run: (studio) => startDrawTool(studio, spline),
});
