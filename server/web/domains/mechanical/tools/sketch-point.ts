// The Point sketch tool: a point on its own, for dimensions and constraints to refer to.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { point } from "../sketch/shapes";

export default defineTool({
  id: "sketch-point", title: "Point", hint: "Click to place a point.", group: "sketch", order: 55, keep: 80,
  icon: '<circle class="s" cx="12" cy="12" r="3"/><path d="M12 3v4M12 17v4M3 12h4M17 12h4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-point",
  run: (studio) => startDrawTool(studio, point),
});
