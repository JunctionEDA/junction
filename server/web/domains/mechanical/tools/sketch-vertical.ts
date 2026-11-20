// The Vertical constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-vertical", title: "Vertical", hint: "A line, or two points, upright.", group: "sketch", order: 220, keep: 75, key: "v",
  icon: '<path d="M12 4v16"/><circle class="s" cx="12" cy="4" r="2.4"/><circle class="s" cx="12" cy="20" r="2.4"/><path class="t" d="M6 8v8M18 8v8"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-vertical",
  run: (studio) => runConstraintTool(studio, "vertical", "sketch-vertical"),
});
