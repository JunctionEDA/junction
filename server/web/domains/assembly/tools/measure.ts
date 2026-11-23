// Measure: the distance and the angle between two things clicked in the model (faces, edges, points of any
// two instances), and the size of one (a hole's diameter).
import { defineAssemblyTool } from "../core/tool";
import { openMeasure } from "../panels/measure";

export default defineAssemblyTool({
  id: "measure", title: "Measure", hint: "Click two faces, edges or points: the distance and the angle between them. One round edge: its diameter.", section: "inspect", order: 40, keep: 50, key: "m",
  keywords: "distance length angle radius diameter gap dimension",
  icon: '<rect class="f" x="2" y="7.5" width="20" height="9" rx="1.2"/><rect x="2" y="7.5" width="20" height="9" rx="1.2"/><path d="M6 7.5v3.5M10 7.5v5M14 7.5v3.5M18 7.5v5"/>',
  disabled: (a) => (a.getState().instances.length ? null : "Place an instance first"),
  active: (a) => a.getState().panels.some((p) => p.id === "measure"),
  run: (a) => { if (a.getState().panels.some((p) => p.id === "measure")) a.closePanel("measure"); else openMeasure(a); },
});
