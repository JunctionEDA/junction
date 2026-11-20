// Put the sketch tool down: clicks select curves, points, constraints and dimensions again; drags move geometry
// as far as its constraints allow (sketch/editor.ts).
import { defineTool } from "../core/tool";
import { sketchEditor } from "../sketch/editor";

export default defineTool({
  id: "sketch-select", title: "Select", hint: "Click to select, drag to move. Shift adds. Delete removes. Double-click a dimension to edit it.", group: "sketch", order: 0, button: false,
  icon: '<path class="f" d="M5 3l14.5 7-6.3 2.2L11 18.5z"/><path d="M5 3l14.5 7-6.3 2.2L11 18.5z"/>',
  active: (studio) => studio.getState().sketch?.tool === "select",
  run: (studio) => sketchEditor(studio).useSelect(),
});
