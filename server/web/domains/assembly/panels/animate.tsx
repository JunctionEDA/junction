// animate.tsx — the Animate panel: one freedom of the assembly (a mate's angle or distance) moved through its
// range.  Drag the slider and the parts follow, every other mate and relation holding; Play sweeps it back and
// forth.  Where the slider is left is where the assembly stays (one undo step); a played sweep changes nothing.
import { useEffect, useState } from "react";
import { Select } from "../../../shared/components/Select";
import { cx } from "../../../shared/util";
import type { AssemblyEditor } from "../ui/assembly";
import { Glyph, ICONS, useAssembly } from "../ui/parts";

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

function Animate({ a, first }: { a: AssemblyEditor; first?: string }) {
  useAssembly(a, (s) => s.mates); useAssembly(a, (s) => s.mateInfo);
  const animating = useAssembly(a, (s) => s.animating);
  const list = a.drivable();
  const [chosen, setChosen] = useState<string>(() => { const x = list.find((d) => d.mate.id === first) || list[0]; return x ? `${x.mate.id}|${x.key}` : ""; });
  useEffect(() => () => a.stopAnimation(), [a]);
  const d = list.find((x) => `${x.mate.id}|${x.key}` === chosen) || list[0];
  if (!d) return <p className="note m-0 p-2 text-xs">No mate here leaves an angle or a distance free. Add a Revolute, a Slider or a Cylindrical mate.</p>;
  const id = `${d.mate.id}|${d.key}`, unit = d.unit === "deg" ? "°" : " mm";
  const on = !!animating && animating.mate === d.mate.id && animating.key === d.key;
  return (
    <div className="flex flex-col gap-2 p-2 text-sm" data-animate-panel data-mate={d.mate.name} data-value={round(d.value, 3)}>
      <Select className="input w-full" value={id} label="What to move" data={{ param: "drive" }} onChange={(v) => { a.stopAnimation(); setChosen(v); }} options={list.map((x) => ({ value: `${x.mate.id}|${x.key}`, label: x.label }))} />
      <div className="flex items-center gap-2">
        <button type="button" className={cx("btn sm flex items-center gap-1.5", on && "on")} data-play aria-pressed={on} onClick={() => a.animateMate(d.mate.id, d.key)}><Glyph svg={on ? ICONS.stop : ICONS.play} size={14} /><span>{on ? "Stop" : "Play"}</span></button>
        <span className="flex-1 text-right mono" data-now>{round(d.value)}{unit}</span>
      </div>
      <input type="range" className="w-full" min={d.min} max={d.max} step={d.unit === "deg" ? 1 : (d.max - d.min) / 200} value={Math.max(d.min, Math.min(d.max, d.value))} disabled={on} aria-label={`${d.label}: drag to move`} data-drive
        onChange={(ev) => a.driveMate(d.mate.id, d.key, Number(ev.target.value), { hold: true })} onPointerUp={() => a.settle()} onKeyUp={() => a.settle()} onBlur={() => a.settle()} />
      <div className="flex justify-between text-xs text-ink-3 mono"><span>{round(d.min)}{unit}</span><span>{d.limited ? "its limits" : d.unit === "deg" ? "a full turn" : "50 mm about where it is"}</span><span>{round(d.max)}{unit}</span></div>
    </div>
  );
}

export function openAnimate(a: AssemblyEditor, mate?: string): void { a.showPanel({ id: "animate", title: "Animate", side: "right", render: (x) => <Animate key={mate || "any"} a={x} first={mate} /> }); }
