// The Parallel constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-parallel", title: "Parallel", hint: "Two lines parallel.", group: "sketch", order: 230, keep: 64, key: "b",
  icon: '<path d="M3.5 19L13 4M11 20L20.5 5" stroke-width="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-parallel",
  run: (studio) => runConstraintTool(studio, "parallel", "sketch-parallel"),
});
