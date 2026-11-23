// Mass properties of the assembly: its parts' volumes and masses added up where they stand, and the centre of mass.
import { defineAssemblyTool } from "../core/tool";
import { openMass } from "../panels/mass";

export default defineAssemblyTool({
  id: "mass", title: "Mass properties", hint: "The mass, the volume and the centre of mass of the assembly, or of what is selected.", section: "inspect", order: 50, keep: 48,
  keywords: "weight mass volume density centre center gravity cog material",
  icon: '<path class="f" d="M6 9h12l2.5 11.5h-17z"/><path d="M6 9h12l2.5 11.5h-17z"/><circle cx="12" cy="5.5" r="2.5"/>',
  disabled: (a) => (a.getState().instances.some((i) => !i.suppressed && i.source.kind === "part") ? null : "Place a part first"),
  active: (a) => a.getState().panels.some((p) => p.id === "mass"),
  run: (a) => { if (a.getState().panels.some((p) => p.id === "mass")) a.closePanel("mass"); else openMass(a); },
});
