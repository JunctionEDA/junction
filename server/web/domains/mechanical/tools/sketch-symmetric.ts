// The Symmetric constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-symmetric", title: "Symmetric", hint: "Two points mirrored about a line or a point.", group: "sketch", order: 295, keep: 39,
  icon: '<path class="d" d="M12 2.5v19"/><circle class="s" cx="4.5" cy="12" r="2.4"/><circle class="s" cx="19.5" cy="12" r="2.4"/><path class="t" d="M8 12h2M14 12h2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-symmetric",
  run: (studio) => runConstraintTool(studio, "symmetric", "sketch-symmetric"),
});
