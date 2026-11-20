// The Curvature sketch tool: curvature continuity (G2) where a spline ends on another curve.
import { defineTool } from "../core/tool";
import { NEEDS, runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-curvature", title: "Curvature", hint: NEEDS.curvature, group: "sketch", order: 254, keep: 36,
  icon: '<path d="M2 18h9"/><path d="M11 18c4 0 8-4 10-12" stroke-width="1.6"/><circle class="s" cx="11" cy="18" r="2.2"/><path class="d t" d="M11 18c-3 0-5-1-7-3"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-curvature",
  run: (studio) => runConstraintTool(studio, "curvature", "sketch-curvature"),
});
