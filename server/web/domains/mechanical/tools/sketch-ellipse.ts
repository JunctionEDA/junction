// The Ellipse sketch tool: an ellipse from its centre and its two radii.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { ellipse } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-ellipse", title: "Ellipse", hint: "Click the centre, the end of the major axis, then a point for the minor radius.", group: "sketch", order: 48, keep: 68, menu: "Ellipse",
  icon: '<ellipse class="f" cx="12" cy="12" rx="9.5" ry="6"/><ellipse cx="12" cy="12" rx="9.5" ry="6"/><path class="d t" d="M12 12h9.5"/><circle class="s" cx="12" cy="12" r="2"/><circle class="s" cx="21.5" cy="12" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-ellipse",
  run: (studio) => startDrawTool(studio, ellipse),
});
