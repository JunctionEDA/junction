// Show or hide the planes: the default three with the origin, and the reference planes (P).
import { defineTool } from "../core/tool";

export default defineTool({
  id: "toggle-planes", title: "Planes", hint: "Show or hide every plane at once. Each can be hidden on its own with the eye in the feature list.", group: "view", order: 10, key: "p",
  icon: '<path class="f" d="M2 15.5l4.5-6.5h15.5l-4.5 6.5z"/><path d="M2 15.5l4.5-6.5h15.5l-4.5 6.5z"/><path d="M8.5 9V3h7.5v6M16 15.5V21H8.5v-5.5"/>',
  active: (studio) => studio.getState().planesVisible,
  run: (studio) => studio.setPlanesVisible(!studio.getState().planesVisible),
});
