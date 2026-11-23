// Render: the assembly as a photograph.  The viewport shows it path traced under studio lights, each part in the
// look its part studio gives it; the panel has the lights, the ground, the camera, and saving a still, a
// turntable film, or a film of the assembly coming apart or moving.
import { defineAssemblyTool } from "../core/tool";
import { toggleRender } from "../panels/render";

export default defineAssemblyTool({
  id: "render", title: "Render", hint: "A photograph of the assembly: ray traced under studio lights, with a still or a 360° turntable film to save.", section: "view", order: 40, keep: 38,
  keywords: "raytrace ray tracing raytraced photo photoreal photorealistic picture image turntable video film 360 studio lighting visualize",
  icon: '<circle cx="12" cy="11" r="7"/><path d="M8.300 8.800a4.600 4.600 0 0 1 2.900-2.300"/><path class="t" d="M4.500 20.500h15"/>',
  disabled: (a) => (a.getState().mating ? "Finish the mate first" : a.getState().instances.some((i) => !i.suppressed && !i.hidden) ? null : "Place an instance first"),
  active: (a) => a.getState().panels.some((p) => p.id === "render"),
  run: (a) => toggleRender(a),
});
