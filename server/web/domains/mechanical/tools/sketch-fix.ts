// The Fix constraint tool: select first and press it, or press it and click what to tie together.
import { defineTool } from "../core/tool";
import { runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-fix", title: "Fix", hint: "Pin a point or a curve where it is.", group: "sketch", order: 298, keep: 38,
  icon: '<circle class="s" cx="12" cy="6.5" r="3"/><path d="M12 9.5V16M5 16h14"/><path class="t" d="M7 16l-2.5 4.5M12 16l-2.5 4.5M17 16l-2.5 4.5"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-fix",
  run: (studio) => runConstraintTool(studio, "fix", "sketch-fix"),
});
