// Redo what was just undone.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "redo", title: "Redo", hint: "Do again what was taken back.", section: "edit", order: 2, keep: 100, keywords: "again forward",
  icon: '<path d="M15.5 13.5L20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  disabled: (a) => (a.getState().mating ? "Finish the mate first" : a.getState().canRedo ? null : "Nothing to redo"),
  run: (a) => a.redo(),
});
