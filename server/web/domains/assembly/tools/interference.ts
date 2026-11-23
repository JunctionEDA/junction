// Interference: which parts of the assembly overlap and by how much (exact, in the modelling worker), and the
// clearance between two of them.
import { defineAssemblyTool } from "../core/tool";
import { openInterference } from "../services/interference-view";

export default defineAssemblyTool({
  id: "interference", title: "Interference", hint: "Find the parts that overlap, and measure the clearance between two.", section: "inspect", order: 20, keep: 55,
  keywords: "clash collision overlap detect check clearance gap",
  icon: '<rect x="3" y="8" width="11" height="11" rx="1"/><rect x="10" y="4" width="11" height="11" rx="1"/><path class="f" d="M10 8h4v7h-4z"/><path d="M10 8h4v7h-4z"/>',
  disabled: (assembly) => (assembly.getState().instances.filter((i) => !i.suppressed && (i.source.kind === "part" || i.source.kind === "board")).length < 2 ? "Place two or more parts first" : null),
  active: (a) => a.getState().panels.some((p) => p.id === "interference"),
  run: (assembly) => openInterference(assembly),
});
