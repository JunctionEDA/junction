// The Collinear constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-collinear", title: "Collinear", hint: "Two lines along the same line.", group: "sketch", order: 290, keep: 40,
  icon: '<path class="d t" d="M2 22L22 2"/><path d="M3.5 20.5l5-5M15.5 8.5l5-5" stroke-width="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-collinear",
  run: (studio) => runConstraintTool(studio, "collinear", "sketch-collinear"),
});
