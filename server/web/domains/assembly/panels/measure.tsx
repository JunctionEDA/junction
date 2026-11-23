// measure.tsx — the Measure panel: click one thing in the model for what it is (a hole's diameter, where a point
// is), a second for the distance and the angle between the two.  The two may be on any two instances, as they
// stand.  It measures between the connectors the mates would use (connectors/infer.ts): a face's centre, a hole's
// axis, an edge's middle, a corner.
import { useEffect, useRef, useState } from "react";
import { describeConnector } from "../connectors/infer";
import { measureFrames } from "../services/mass";
import type { MateFrame } from "../solver/types";
import type { AssemblyEditor } from "../ui/assembly";
import { useAssembly } from "../ui/parts";
import type { AssemblyPick } from "../viewport/scene";

const fmt = (v: number, places = 3): string => { const s = v.toFixed(places); return s.includes(".") ? s.replace(/\.?0+$/, "") : s; };
interface Picked { pick: AssemblyPick; frame: MateFrame; what: string; of: string }
const PROMPT = "Measure: click a face, an edge or a point. Esc to stop.";

function Measure({ a }: { a: AssemblyEditor }) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const list = useRef<Picked[]>([]);
  const picking = useAssembly(a, (s) => !!s.picking);
  const arm = () => a.pick(PROMPT, (pick, frame) => {
    const of = a.getState().instances.find((i) => i.id === pick.instance)?.name || "";
    const next = { pick, frame, what: describeConnector(frame, pick.kind), of };
    list.current = list.current.length >= 2 ? [next] : [...list.current, next];
    setPicked(list.current);
    a.setToolMarks(list.current.map((p) => p.frame));
    return true;
  });
  useEffect(() => { arm(); return () => { a.setToolMarks([]); if (a.getState().picking?.prompt === PROMPT) a.pick(null); }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const [p, q] = picked;
  const m = p && q ? measureFrames(p.frame, q.frame) : null;
  const row = (label: string, value: string, name: string) => <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-2 min-h-6 items-center"><span className="text-ink-2">{label}</span><span className="mono" data-measure={name}>{value}</span></div>;
  const one = (x: Picked, n: number) => (
    <div className="flex flex-col" data-measured={n}>
      <div className="text-ink truncate"><span className="text-ink-3 mono mr-1.5">{n}</span>{x.what}<span className="text-ink-3"> · {x.of}</span></div>
      {!m ? <>{x.frame.radius ? row("Diameter", `${fmt(2 * x.frame.radius)} mm`, "diameter") : null}{row("At", x.frame.o.map((v) => fmt(v, 2)).join(", ") + " mm", "at")}</> : null}
    </div>
  );
  return (
    <div className="flex flex-col gap-1.5 p-2 text-sm" data-measure-panel data-picking={picking || undefined}>
      {!p ? <p className="note m-0 text-xs">Click a face, an edge or a point in the model; then a second one for the distance and the angle between them.</p> : null}
      {p ? one(p, 1) : null}
      {q ? one(q, 2) : null}
      {m ? (
        <div className="flex flex-col pt-1.5 border-t border-line">
          {row("Distance", `${fmt(m.distance)} mm`, "distance")}
          {row("ΔX, ΔY, ΔZ", m.delta.map((v) => fmt(v, 3)).join(", "), "delta")}
          {m.angle !== null ? row("Angle", `${fmt(m.angle, 2)}°`, "angle") : null}
          {m.apart !== null ? row(p.frame.surface === "plane" ? "Between planes" : "Between axes", `${fmt(m.apart)} mm`, "apart") : null}
        </div>
      ) : null}
      <div className="flex gap-1.5 pt-1">
        {!picking ? <button type="button" className="btn sm" data-measure-again onClick={arm}>Measure again</button> : null}
        {p ? <button type="button" className="btn sm ghost" onClick={() => { list.current = []; setPicked([]); a.setToolMarks([]); }}>Clear</button> : null}
      </div>
    </div>
  );
}

export function openMeasure(a: AssemblyEditor): void { a.showPanel({ id: "measure", title: "Measure", side: "right", render: (x) => <Measure a={x} /> }); }
