// The Midpoint constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-midpoint", title: "Midpoint", hint: "A point onto the middle of a line.", group: "sketch", order: 270, keep: 48,
  icon: '<path d="M3 12h18M3 8v8M21 8v8"/><circle class="s" cx="12" cy="12" r="2.8"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-midpoint",
  run: (studio) => runConstraintTool(studio, "midpoint", "sketch-midpoint"),
});
