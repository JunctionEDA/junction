// The Inscribed polygon sketch tool: a regular polygon with its corners on a circle.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { polygon } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-polygon", title: "Inscribed polygon", hint: "Click the centre, then a corner. Type N to set the number of sides (6). The corners lie on a construction circle.", group: "sketch", order: 46, keep: 70, menu: "Polygon",
  icon: '<circle class="d t" cx="12" cy="12" r="9"/><path class="f" d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><circle class="s" cx="12" cy="12" r="2"/><circle class="s" cx="19.8" cy="7.5" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-polygon",
  run: (studio) => startDrawTool(studio, polygon(false)),
});
