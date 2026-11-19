// The Concentric constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-concentric", title: "Concentric", hint: "Two circles or arcs about the same centre.", group: "sketch", order: 280, keep: 47,
  icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.8"/><circle class="s" cx="12" cy="12" r="1.5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-concentric",
  run: (studio) => runConstraintTool(studio, "concentric", "sketch-concentric"),
});
