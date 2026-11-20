// Undo the last edit made here.  An undo is an ordinary edit, so everyone sees it.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "undo", title: "Undo", hint: "Ctrl+Z", group: "edit", order: 10, keep: 100,
  icon: '<path d="M8.5 13.5L4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  disabled: (studio) => (studio.getState().canUndo ? null : "Nothing to undo"),
  run: (studio) => studio.undo(),
});
