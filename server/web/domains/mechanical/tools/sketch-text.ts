// The Text sketch tool: text, as outlines in a font.
import { defineTool } from "../core/tool";
import { runText } from "../sketch/insert";

export default defineTool({
  id: "sketch-text", title: "Text", hint: "Click where the baseline starts, then the height of the capitals; then type the text. Closed letters are regions an extrude can use.", group: "sketch", order: 57, keep: 58,
  icon: '<path d="M5 6.5V4h14v2.5M12 4v16M9 20h6"/><path class="d t" d="M3 21.5h18"/>',
  active: (studio) => studio.getState().sketch?.tool === "sketch-text",
  run: (studio) => runText(studio, "sketch-text"),
});
