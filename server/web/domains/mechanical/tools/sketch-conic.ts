// The Conic sketch tool: a conic section (parabola, ellipse or hyperbola) between two points.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { conic } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-conic", title: "Conic", hint: "Click the start, the end, then the control point where its end tangents meet. Tab, then type rho (0.5 is a parabola).", group: "sketch", order: 51, keep: 60,
  icon: '<path class="d t" d="M3 20L12 4l9 16"/><path d="M3 20Q12 1 21 20"/><circle class="s" cx="3" cy="20" r="2"/><circle class="s" cx="21" cy="20" r="2"/><circle class="s" cx="12" cy="4" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-conic",
  run: (studio) => startDrawTool(studio, conic),
});
