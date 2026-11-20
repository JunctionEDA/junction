// The Bézier curve sketch tool: a Bézier curve.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { bezier } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-bezier", title: "Bézier curve", hint: "Click its points (three or more); Enter ends it. Its degree is one less than the number of points.", group: "sketch", order: 54, keep: 74, menu: "Spline",
  icon: '<path class="d t" d="M3 19L8 4l13 6"/><path d="M3 19Q8 4 21 10"/><circle class="s" cx="3" cy="19" r="2"/><circle class="s" cx="8" cy="4" r="2"/><circle class="s" cx="21" cy="10" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-bezier",
  run: (studio) => startDrawTool(studio, bezier),
});
