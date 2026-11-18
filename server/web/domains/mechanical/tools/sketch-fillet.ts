// The sketch Fillet tool: round a corner where two lines meet with a tangent arc and a radius dimension.
import { defineTool } from "../core/tool";
import { runFillet } from "../sketch/modify";

export default defineTool({
  id: "sketch-fillet", title: "Sketch fillet", hint: "Click a corner to round it. Type a radius and press Enter to change it.", group: "sketch", order: 100, keep: 85, key: "f",
  icon: '<path d="M4 3v9a8 8 0 0 0 8 8h9"/><path class="d t" d="M4 12v8h8"/><circle class="s" cx="4" cy="12" r="2"/><circle class="s" cx="12" cy="20" r="2"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-fillet",
  run: (studio) => runFillet(studio, "sketch-fillet"),
});
