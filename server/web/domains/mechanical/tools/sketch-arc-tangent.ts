// The Tangent arc sketch tool: leaves the end of a line or an arc smoothly and ends where clicked.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { arcTangent } from "../sketch/shapes";

export default defineTool({
  id: "sketch-arc-tangent", title: "Tangent arc", hint: "Click the end of a line or an arc, then where the arc ends.", group: "sketch", order: 44, keep: 97, menu: "Arc",
  icon: '<path d="M2.5 19h7.5a9.5 9.5 0 0 0 9.5-9.5V4"/><circle class="s" cx="10" cy="19" r="2.3"/><circle class="s" cx="19.5" cy="4.5" r="2.3"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-arc-tangent",
  run: (studio) => startDrawTool(studio, arcTangent),
});
