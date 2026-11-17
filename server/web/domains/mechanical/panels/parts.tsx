// The Parts panel: the bodies the features up to the rollback bar make.
import { definePanel } from "../core/tool";
import { useStudio } from "../ui/hooks";
import type { PartStudio } from "../ui/studio";

function Parts({ studio }: { studio: PartStudio }) {
  const bodies = useStudio(studio, (s) => s.bodies);
  if (!bodies.length) return <p className="note px-2 py-1 m-0">No parts yet.</p>;
  return (
    <div className="flex flex-col py-1 text-sm" role="list" aria-label="Parts">
      {bodies.map((b) => <div key={b.id} role="listitem" data-body={b.id} className={"flex items-center gap-1.5 h-6.5 px-2 truncate" + (b.reference ? " text-ink-2" : "")} title={b.reference ? `${b.name}: reference geometry (not a part of this studio)` : b.name}>{b.name}{b.reference ? <span className="text-xs text-ink-3">reference</span> : null}</div>)}
    </div>
  );
}

export default definePanel({ id: "parts", title: "Parts", side: "left", order: 20, render: (studio) => <Parts studio={studio} /> });
