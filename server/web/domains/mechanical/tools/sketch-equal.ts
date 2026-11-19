// The Equal constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-equal", title: "Equal", hint: "Two lines the same length, or two circles or arcs the same radius.", group: "sketch", order: 260, keep: 62, key: "e",
  icon: '<path d="M4.5 9h15M4.5 15h15" stroke-width="2.2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-equal",
  run: (studio) => runConstraintTool(studio, "equal", "sketch-equal"),
});
