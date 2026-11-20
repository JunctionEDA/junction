// History: open the version history beside the viewport (history/index.tsx): kept versions, the runs of edits
// between them, branches and merging.
import { defineTool } from "../core/tool";
import { historyUi, toggleHistory } from "../history/index";

export default defineTool({
  id: "history", title: "History", hint: "Versions, earlier states and branches", group: "file", order: 10, keep: 77,
  icon: '<path d="M3.5 12a8.5 8.5 0 1 0 2.8-6.3"/><path d="M3.5 3.5V8h4.5"/><path d="M12 7.5V12l3.2 2"/>',
  active: (studio) => historyUi(studio.getState()).open,
  run: (studio) => toggleHistory(studio),
});
