// Bill of materials: the assembly's parts with their quantities, and the electronic parts of its boards.
import { defineAssemblyTool } from "../core/tool";
import { openBom } from "../panels/bom";

export default defineAssemblyTool({
  id: "bom", title: "Bill of materials", hint: "The parts and their quantities, with the boards' electronic parts; exports CSV.", section: "inspect", order: 10, keep: 56,
  keywords: "bom parts list quantities table csv export purchasing",
  icon: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path class="f" d="M3.5 5a1.5 1.5 0 0 1 1.5-1.5h14A1.5 1.5 0 0 1 20.5 5v3h-17z"/><path d="M3.5 8h17M3.5 12.2h17M3.5 16.4h17M9 8v12.5"/>',
  active: (a) => a.getState().panels.some((p) => p.id === "bom"),
  run: (a) => { if (a.getState().panels.some((p) => p.id === "bom")) a.closePanel("bom"); else openBom(a); },
});
