// Redo what Undo took back.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "redo", title: "Redo", hint: "Ctrl+Y", group: "edit", order: 20, keep: 100,
  icon: '<path d="M15.5 13.5L20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  disabled: (studio) => (studio.getState().canRedo ? null : "Nothing to redo"),
  run: (studio) => studio.redo(),
});
