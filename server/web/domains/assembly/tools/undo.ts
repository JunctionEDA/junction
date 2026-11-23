// Undo the last edit made here.  An undo is an ordinary edit, so everyone sees it.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "undo", title: "Undo", hint: "Take back the last change.", section: "edit", order: 1, keep: 100, keywords: "back revert",
  icon: '<path d="M8.5 13.5L4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  disabled: (a) => (a.getState().mating ? "Finish the mate first" : a.getState().canUndo ? null : "Nothing to undo"),
  run: (a) => a.undo(),
});
