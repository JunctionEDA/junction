// Flat pattern: show the sheet metal table and flat view (panels/sm-flat.tsx) in the right dock.
import { defineTool } from "../core/tool";
import { hasSheetMetal } from "../panels/sm-flat";
import { showPanel } from "../ui/panels";

export default defineTool({
  id: "sm-flat-view", title: "Flat pattern", hint: "Show the sheet metal flat pattern, its bend table and DXF", group: "feature", section: "sheetmetal", order: 95, keep: 36,
  icon: '<path d="M3 6h18v12H3z"/><path class="t" d="M9 6v12M15 6v12"/>',
  disabled: (studio) => (hasSheetMetal(studio) ? null : "Make a sheet metal model first"),
  run: () => showPanel("sm-flat"),
});
