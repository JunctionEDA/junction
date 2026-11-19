// The centre Rectangle sketch tool: the centre, then a corner; the centre stays the middle of a diagonal.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { centerRectangle } from "../sketch/shapes";

export default defineTool({
  id: "sketch-center-rectangle", title: "Centre rectangle", hint: "Click the centre, then a corner.", group: "sketch", order: 22, keep: 99, menu: "Rectangle",
  icon: '<rect class="f" x="4" y="6" width="16" height="12"/><rect x="4" y="6" width="16" height="12"/><path class="t" d="M12 12l8-6"/><circle class="s" cx="12" cy="12" r="2.4"/><circle class="s" cx="20" cy="6" r="2.4"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-center-rectangle",
  run: (studio) => startDrawTool(studio, centerRectangle),
});
