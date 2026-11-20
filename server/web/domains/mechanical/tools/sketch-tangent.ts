// The Tangent constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-tangent", title: "Tangent", hint: "A line and a circle or arc, or two circles or arcs, touching smoothly.", group: "sketch", order: 250, keep: 63,
  icon: '<circle class="f" cx="11" cy="15" r="6.5"/><circle cx="11" cy="15" r="6.5"/><path d="M2 8.5h20" stroke-width="1.6"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-tangent",
  run: (studio) => runConstraintTool(studio, "tangent", "sketch-tangent"),
});
