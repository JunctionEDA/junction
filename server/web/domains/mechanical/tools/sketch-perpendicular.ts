// The Perpendicular constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-perpendicular", title: "Perpendicular", hint: "Two lines square to each other.", group: "sketch", order: 240, keep: 65,
  icon: '<path d="M12 3.5V19M3.5 19.5h17" stroke-width="2"/><path class="t" d="M12 15h4v4.5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-perpendicular",
  run: (studio) => runConstraintTool(studio, "perpendicular", "sketch-perpendicular"),
});
