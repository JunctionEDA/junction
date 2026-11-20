// The Normal sketch tool: a line square to a curve.
import { defineTool } from "../core/tool";
import { NEEDS, runConstraintTool } from "../sketch/constrain";

export default defineTool({
  id: "sketch-normal", title: "Normal", hint: NEEDS.normal, group: "sketch", order: 252, keep: 37,
  icon: '<path class="f" d="M3 19a12 12 0 0 1 18 0z"/><path d="M3 19a12 12 0 0 1 18 0"/><path d="M12 13V2" stroke-width="1.6"/><path class="t" d="M12 9.5h2.5V13"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-normal",
  run: (studio) => runConstraintTool(studio, "normal", "sketch-normal"),
});
