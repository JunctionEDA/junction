// The Circumscribed polygon sketch tool: a regular polygon around a circle.
import { defineTool } from "../core/tool";
import { startDrawTool } from "../sketch/draw";
import { polygon } from "../sketch/curve-shapes";

export default defineTool({
  id: "sketch-polygon-circumscribed", title: "Circumscribed polygon", hint: "Click the centre, then the middle of a side. Type N to set the number of sides (6). Its sides touch a construction circle.", group: "sketch", order: 47, keep: 70, menu: "Polygon",
  icon: '<path class="f" d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/><path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z"/><circle class="d t" cx="12" cy="12" r="7.1"/><circle class="s" cx="12" cy="12" r="2"/><circle class="s" cx="18.15" cy="15.55" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-polygon-circumscribed",
  run: (studio) => startDrawTool(studio, polygon(true)),
});
