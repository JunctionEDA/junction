// Render mode's controls, over the top left of the viewport while it is on (shared/render/Panel.tsx).
import { useSyncExternalStore } from "react";
import { RenderPanel } from "../../../shared/render/Panel";
import { definePanel } from "../core/tool";
import { renderOf } from "../inspect/render-scene";
import type { PartStudio } from "../ui/studio";

function RenderControls({ studio }: { studio: PartStudio }) {
  const mode = renderOf(studio);
  const on = useSyncExternalStore(mode.subscribe, () => mode.getState().on);
  if (!on) return null;
  return (
    <div className="cad-render absolute left-2 top-2 z-[4] w-72 max-h-[calc(100%-1rem)] overflow-y-auto rounded-sm border border-line bg-panel shadow-panel" onPointerDown={(ev) => ev.stopPropagation()} onKeyDown={(ev) => ev.stopPropagation()}>
      <RenderPanel mode={mode} onClose={() => mode.exit()} />
    </div>
  );
}

export default definePanel({ id: "render", title: "Render", side: "overlay", order: 30, render: (studio) => <RenderControls studio={studio} /> });
