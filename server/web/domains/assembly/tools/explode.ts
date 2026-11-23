// Exploded views: pull the instances apart to see how the assembly goes together.  A view can be kept under a
// name (the document stores how far each instance is pulled); the assembly itself does not move.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "explode", title: "Exploded view", hint: "Pull the parts apart to see how they go together; keep the view under a name.", section: "view", order: 10, keep: 56, key: "e",
  keywords: "explode pull apart blow up disassemble steps",
  icon: '<rect class="f" x="9" y="9" width="6" height="6"/><rect x="9" y="9" width="6" height="6"/><path d="M7 7L3.5 3.5M3.5 6.5v-3h3M17 7l3.5-3.5M17.5 3.5h3v3M7 17l-3.5 3.5M3.5 17.5v3h3M17 17l3.5 3.5M20.5 17.5v3h-3"/>',
  disabled: (a) => (a.getState().instances.length > 1 ? null : "Place two instances first"),
  active: (a) => a.getState().exploding,
  run: (a) => a.setExploding(!a.getState().exploding),
});
