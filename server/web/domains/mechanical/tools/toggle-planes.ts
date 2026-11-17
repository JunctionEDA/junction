// Show or hide the default planes and the origin.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "toggle-planes", title: "Planes", hint: "Show or hide the default planes", group: "view", order: 10,
  icon: '<path d="M4 9l8-4 8 4-8 4z"/><path d="M4 15l8 4 8-4"/>',
  active: (studio) => studio.getState().planesVisible,
  run: (studio) => studio.setPlanesVisible(!studio.getState().planesVisible),
});
