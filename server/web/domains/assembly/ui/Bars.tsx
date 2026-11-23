// Bars.tsx — the strips that lie over the top of the viewport while a way of looking is on: the exploded view
// (how far apart, keep it under a name), the section (which axis, where, which side), and the narrow rail of
// panel buttons down the right edge of the window.
import { cx } from "../../../shared/util";
import { Glyph, hideTip, tipHandlers } from "../../mechanical/api-ui";
import type { AssemblyEditor } from "./assembly";
import { allCommands } from "./commands";
import { useAssembly } from "./parts";

const BAR = "absolute left-1/2 -translate-x-1/2 z-[3] flex items-center gap-2 h-9 px-2 rounded-md border border-line bg-bench shadow-panel text-sm whitespace-nowrap";

export function ExplodeBar({ assembly }: { assembly: AssemblyEditor }) {
  const on = useAssembly(assembly, (s) => s.exploding), k = useAssembly(assembly, (s) => s.explode), view = useAssembly(assembly, (s) => s.explodeView);
  const dirty = useAssembly(assembly, (s) => s.explodeDirty), canEdit = useAssembly(assembly, (s) => s.canEdit);
  const name = useAssembly(assembly, (s) => s.explodes.find((e) => e.id === s.explodeView)?.name || "");
  const count = useAssembly(assembly, (s) => s.explodes.length);
  const one = useAssembly(assembly, (s) => (s.selection.length === 1 && s.instances.some((i) => i.id === s.selection[0]) ? s.selection[0] : null));
  if (!on) return null;
  const saveAs = () => assembly.ask({ title: "Save exploded view", acceptLabel: "Save", fields: [{ key: "name", label: "Name", kind: "text", value: `Exploded view ${count + 1}` }], accept: (v) => assembly.saveExplode(String(v.name).trim() || `Exploded view ${count + 1}`) });
  return (
    <div className={cx(BAR, "top-2")} data-explode data-view={name || undefined} data-dirty={dirty || undefined}>
      <span className="font-medium">{name || "Exploded view"}</span>
      <label className="flex items-center gap-1.5 text-ink-2" title="Spread every part evenly from the middle. To pull one part further, select it and drag an arrow.">Spread<input type="range" min={0} max={2} step={0.02} value={k} aria-label="How far apart" onChange={(ev) => assembly.setExplode(Number(ev.target.value))} /></label>
      {one ? <button type="button" className="btn sm ghost" data-explode-reset title="Put the selected part back in its place" onClick={() => assembly.unpull(one)}>Put back</button> : null}
      {view ? <button type="button" className="btn sm" data-explode-save disabled={!canEdit || !dirty} title="Keep the view as it is now" onClick={() => assembly.saveExplode()}>Save</button> : null}
      <button type="button" className="btn sm" data-explode-save-as disabled={!canEdit} title="Keep this view under a name, to come back to" onClick={saveAs}>{view ? "Save as…" : "Save…"}</button>
      <button type="button" className="btn sm primary" onClick={() => assembly.setExploding(false)}>Done</button>
    </div>
  );
}

export function SectionBar({ assembly }: { assembly: AssemblyEditor }) {
  const cut = useAssembly(assembly, (s) => s.section), exploding = useAssembly(assembly, (s) => s.exploding);
  if (!cut) return null;
  const [lo, hi] = assembly.extent(cut.axis), pad = Math.max(1, (hi - lo) * 0.02);
  return (
    <div className={cx(BAR, exploding ? "top-[52px]" : "top-2")} data-section-bar data-axis={cut.axis}>
      <span className="font-medium">Section</span>
      <span className="seg" role="group" aria-label="Across">
        {(["x", "y", "z"] as const).map((ax) => <button key={ax} type="button" className={cx(cut.axis === ax && "on")} data-section-axis={ax} aria-pressed={cut.axis === ax} onClick={() => { const [a, b] = assembly.extent(ax); assembly.setSection({ axis: ax, offset: (a + b) / 2, flip: cut.flip }); }}>{ax.toUpperCase()}</button>)}
      </span>
      <input type="range" min={lo - pad} max={hi + pad} step={(hi - lo + 2 * pad) / 400} value={cut.offset} aria-label="Where the cut is" data-section-offset onChange={(ev) => assembly.setSection({ ...cut, offset: Number(ev.target.value) })} />
      <span className="mono text-xs text-ink-2 w-16 text-right">{Math.round(cut.offset * 10) / 10} mm</span>
      <button type="button" className={cx("btn sm", cut.flip && "on")} data-section-flip aria-pressed={cut.flip} title="Show the other side" onClick={() => assembly.setSection({ ...cut, flip: !cut.flip })}>Flip</button>
      <button type="button" className="btn sm primary" onClick={() => assembly.setSection(null)}>Done</button>
    </div>
  );
}

/** What the rail holds, top to bottom: the panels and the ways of looking a person opens and shuts while working. */
const RAIL = ["bom", "interference", "mass", "measure", "section", "animate", "explode", "history"];

export function Rail({ assembly }: { assembly: AssemblyEditor }) {
  useAssembly(assembly, (s) => s);
  const all = allCommands(assembly);
  return (
    <nav className="cad-rail flex flex-col flex-none items-center gap-0.5 w-9 py-1 bg-bench border-l border-line" aria-label="Panels" data-rail>
      {RAIL.map((id) => all.find((e) => e.id === id)).map((e) => e ? (
        <button key={e.id} type="button" className={cx("btn sm ghost cad-tb flex flex-none items-center justify-center p-0 w-7.5 h-7.5 min-h-0 text-ink", e.on && "on", e.why && "opacity-40")} aria-label={e.title} aria-pressed={e.on || undefined} aria-disabled={e.why ? true : undefined} data-rail-tool={e.id}
          {...tipHandlers(e)} onClick={() => { hideTip(); if (!e.why) e.run(); }}><Glyph svg={e.icon} size={20} /></button>
      ) : null)}
    </nav>
  );
}
