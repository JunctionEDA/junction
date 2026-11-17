// PartStudioView.tsx — the part studio's frame: the generated toolbar, the docked panels (panels/*.tsx), the
// viewport with the feature dialog over it, and what the worker is doing.
import { useEffect, useRef } from "react";
import { PANELS } from "../generated/page";
import { FeatureDialog } from "./FeatureDialog";
import { useStudio } from "./hooks";
import type { PartStudio } from "./studio";
import { Toolbar } from "./Toolbar";

function KernelNote({ studio }: { studio: PartStudio }) {
  const kernel = useStudio(studio, (s) => s.kernel);
  const loaded = useStudio(studio, (s) => s.loaded);
  const status = useStudio(studio, (s) => s.status);
  const empty = useStudio(studio, (s) => s.loaded && !s.features.length && !s.editing);
  const sketch = useStudio(studio, (s) => s.sketch);
  let text = "";
  if (!loaded) text = status.state === "error" ? status.text : "Opening the part studio…";
  else if (kernel.state === "loading") text = "Starting the modelling kernel…";
  else if (kernel.state === "failed") text = kernel.message || "The modelling kernel stopped.";
  else if (kernel.state === "working") text = "Rebuilding…";
  else if (sketch) text = "Sketching. Right-drag turns the view, the wheel zooms.";
  else if (empty) text = "Choose Sketch to start a part.";
  if (!text) return null;
  return <div className="cad-note absolute left-2 bottom-2 z-[2] px-2 py-0.5 rounded-sm border border-line bg-panel text-ink-2 text-xs pointer-events-none" role="status" data-kernel={kernel.state}>{text}</div>;
}

export function PartStudioView({ studio, canvasHost }: { studio: PartStudio; canvasHost: HTMLElement }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => { stage.current?.prepend(canvasHost); return () => canvasHost.remove(); }, [canvasHost]);
  const side = (where: "left" | "right") => PANELS.filter((p) => p.side === where).slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6));
  const dock = (where: "left" | "right") => {
    const panels = side(where);
    if (!panels.length) return null;
    return (
      <aside className={"cad-dock flex flex-col min-h-0 w-60 bg-bench " + (where === "left" ? "border-r border-line" : "border-l border-line")} data-side={where}>
        {panels.map((p, i) => (
          <section key={p.id} className={"flex flex-col min-h-0 " + (i === 0 ? "flex-[2_1_0]" : "flex-[1_1_0] border-t border-line")} data-panel={p.id}>
            <header className="flex flex-none items-center h-5.5 px-1.5 text-sm font-semibold text-ink bg-[linear-gradient(var(--color-paper),var(--color-bench))] border-b border-line select-none">{p.title}</header>
            <div className="flex-1 min-h-0 overflow-y-auto bg-paper">{p.render(studio)}</div>
          </section>
        ))}
      </aside>
    );
  };
  return (
    <div className="cad-root grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] text-ink" data-doc-kind="part-studio">
      <Toolbar studio={studio} />
      <div className="flex min-h-0 min-w-0">
        {dock("left")}
        <div ref={stage} className="cad-stage relative flex-1 min-w-0 min-h-0 overflow-hidden">
          <FeatureDialog studio={studio} />
          <KernelNote studio={studio} />
        </div>
        {dock("right")}
      </div>
    </div>
  );
}
