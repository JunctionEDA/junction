// render.tsx — the Render panel: Render mode's controls (shared/render/Panel.tsx) in the assembly's dock.  The
// panel and the mode go together: opening it turns the mode on, and closing either ends both.
import { useEffect } from "react";
import { RenderPanel } from "../../../shared/render/Panel";
import type { AssemblyEditor } from "../ui/assembly";
import { renderOf } from "../viewport/render";

function Render({ a }: { a: AssemblyEditor }) {
  const mode = renderOf(a);
  // closed from its header (or the rail): the picture goes with it
  useEffect(() => () => mode.exit(), [mode]);
  return <RenderPanel mode={mode} onClose={() => a.closePanel("render")} />;
}

export function toggleRender(a: AssemblyEditor): void {
  const mode = renderOf(a);
  if (a.getState().panels.some((p) => p.id === "render")) { a.closePanel("render"); mode.exit(); return; }
  a.showPanel({ id: "render", title: "Render", side: "right", render: (x) => <Render a={x} /> });
  void mode.enter();
  // a render that stops by itself (it could not start, the graphics card gave up) takes its panel with it
  const off = mode.subscribe(() => { if (!mode.getState().on) { off(); a.closePanel("render"); } });
}
