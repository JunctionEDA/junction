// AssemblyView.tsx — the assembly's frame, laid out as the part studio's is: the toolbar across the top with the
// tool search at its right end (ui/Toolbar.tsx), the instance tree and the mate features down the left, the
// viewport with its dialogs and the view cube, whatever panels the tools open on the right, and at the right
// edge a narrow rail of buttons for those panels (ui/Bars.tsx).
import { useEffect, useRef, useState } from "react";
import { Select } from "../../../shared/components/Select";
import { cx } from "../../../shared/util";
import type { AssemblyEditor, FormDefinition, PanelDefinition } from "./assembly";
import { ExplodeBar, Rail, SectionBar } from "./Bars";
import { bindKeys } from "./commands";
import { InsertDialog } from "./InsertDialog";
import { InstanceList } from "./InstanceList";
import { MateDialog } from "./MateDialog";
import { MateList } from "./MateList";
import { CommandPalette, ContextMenu, Shortcuts } from "./Overlays";
import { Caption, useAssembly } from "./parts";
import { Toolbar } from "./Toolbar";
import { TipHost, ViewCubeControl } from "../../mechanical/api-ui";

function FormDialog({ assembly, form }: { assembly: AssemblyEditor; form: FormDefinition }) {
  const [values, setValues] = useState<{ [key: string]: string | boolean }>(() => Object.fromEntries(form.fields.map((f) => [f.key, f.kind === "boolean" ? !!f.value : String(f.value)])));
  const bad = form.fields.some((f) => f.kind === "number" && (String(values[f.key]).trim() === "" || !Number.isFinite(Number(values[f.key]))));
  const set = (key: string, v: string | boolean) => setValues({ ...values, [key]: v });
  return (
    <form className="cad-dialog absolute left-2 top-2 z-[5] w-[300px] flex flex-col rounded-md border border-line bg-bench shadow-panel text-sm" data-form={form.title}
      onSubmit={(ev) => { ev.preventDefault(); if (bad) return; assembly.ask(null); form.accept(Object.fromEntries(form.fields.map((f) => [f.key, f.kind === "number" ? Number(values[f.key]) : values[f.key]]))); }}
      onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); assembly.ask(null); } }}>
      <header className="flex items-center h-8 px-2 border-b border-line bg-paper rounded-t-md font-semibold text-base">{form.title}</header>
      <div className="flex flex-col gap-1.5 p-2">
        {form.fields.map((f, i) => (
          <label key={f.key} className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-x-2 min-h-7" title={f.hint}>
            <span className="text-ink-2 truncate">{f.label}</span>
            {f.kind === "choice" ? <Select className="input w-full" value={String(values[f.key])} label={f.label} data={{ param: f.key }} options={f.options || []} onChange={(v) => set(f.key, v)} />
              : f.kind === "boolean" ? <input type="checkbox" className="justify-self-start" checked={!!values[f.key]} data-param={f.key} aria-label={f.label} onChange={(ev) => set(f.key, ev.target.checked)} />
              : (
                <span className="flex items-center gap-1.5">
                  <input autoFocus={i === 0} className={cx("input w-full", f.kind === "number" && "mono")} inputMode={f.kind === "number" ? "decimal" : undefined} value={String(values[f.key])} data-param={f.key} aria-label={f.label} onChange={(ev) => set(f.key, ev.target.value)} />
                  {f.unit ? <span className="text-ink-3 font-mono text-xs w-5">{f.unit === "deg" ? "°" : f.unit}</span> : null}
                </span>
              )}
          </label>
        ))}
        {form.note ? <p className="note m-0 text-xs">{form.note}</p> : null}
      </div>
      <footer className="flex justify-end gap-1.5 p-2 border-t border-line">
        <button type="button" className="btn sm" onClick={() => assembly.ask(null)}>Cancel</button>
        <button type="submit" className="btn sm primary" data-accept disabled={bad}>{form.acceptLabel || "Done"}</button>
      </footer>
    </form>
  );
}

function Panel({ assembly, panel }: { assembly: AssemblyEditor; panel: PanelDefinition }) {
  return (
    <section className="flex flex-col min-h-0 flex-[1_1_0] border-b border-line last:border-b-0" data-panel={panel.id}>
      <Caption right={<button type="button" className="btn sm ghost px-1" title="Close" aria-label={`Close ${panel.title}`} onClick={() => assembly.closePanel(panel.id)}>×</button>}>{panel.title}</Caption>
      <div className="flex-1 min-h-0 overflow-auto bg-paper text-sm">{panel.render(assembly)}</div>
    </section>
  );
}

function StatusNote({ assembly }: { assembly: AssemblyEditor }) {
  const s = useAssembly(assembly, (x) => x);
  let text: string, tone = "";
  if (!s.loaded) text = s.status.state === "error" ? s.status.text : "Opening the assembly…";
  else if (s.kernelFailure) { text = s.kernelFailure; tone = "err"; }
  else if (s.readout) text = s.readout;
  else if (s.picking) text = s.picking.prompt;
  else if (s.connecting) text = "Click a face, an edge or a point to put a mate connector there. Esc to stop.";
  else if (s.building) text = s.building === 1 ? "Building a part…" : `Building ${s.building} parts…`;
  else if (!s.instances.length) text = "An empty assembly. Insert parts to begin; right-drag turns the view, the wheel zooms.";
  else if (s.exploding) text = "An exploded view: select a part and drag an arrow to pull it further. The assembly itself does not move.";
  else {
    const trouble = (i: { state: string } | undefined) => !!i && (i.state === "conflict" || i.state === "error");
    const bad = s.mates.filter((m) => trouble(s.mateInfo[m.id])).length + s.relations.filter((r) => trouble(s.relationInfo[r.id])).length;
    if (bad) { text = `${bad} mate feature${bad === 1 ? " has" : "s have"} a problem: see the list`; tone = "err"; }
    else if (s.dof === null) text = `${s.instances.length} instances`;
    else if (s.dof === 0) text = "Fully held: nothing can move";
    else text = `${s.dof} freedom${s.dof === 1 ? "" : "s"} left: drag a part to move it`;
  }
  return <div className={cx("cad-note absolute left-2 bottom-2 z-[2] px-2 py-0.5 rounded-sm border border-line bg-panel text-xs pointer-events-none", tone === "err" ? "text-err" : "text-ink-2")} role="status" data-status-note data-dof={s.dof ?? ""} data-building={s.building}>{text}</div>;
}

export function AssemblyView({ assembly, canvasHost }: { assembly: AssemblyEditor; canvasHost: HTMLElement }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => { stage.current?.prepend(canvasHost); return () => canvasHost.remove(); }, [canvasHost]);
  useEffect(() => { bindKeys(assembly); }, [assembly]);
  const panels = useAssembly(assembly, (s) => s.panels);
  const form = useAssembly(assembly, (s) => s.form);
  const left = panels.filter((p) => p.side === "left"), right = panels.filter((p) => p.side !== "left" && p.side !== "bottom"), bottom = panels.filter((p) => p.side === "bottom");
  return (
    <div className="cad-root grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] text-ink" data-doc-kind="assembly"
      onKeyDown={(ev) => { const t = ev.target as HTMLElement; if (t === assembly.viewport.canvas || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable) return; assembly.handleKey(ev.nativeEvent); }}>
      <Toolbar assembly={assembly} />
      <div className="flex min-h-0 min-w-0">
        <aside className="cad-dock flex flex-col min-h-0 w-64 flex-none bg-bench border-r border-line">
          <InstanceList assembly={assembly} />
          <MateList assembly={assembly} />
          {left.map((p) => <Panel key={p.id} assembly={assembly} panel={p} />)}
        </aside>
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <div ref={stage} className="cad-stage relative flex-1 min-w-0 min-h-0 overflow-hidden">
            <MateDialog assembly={assembly} />
            <InsertDialog assembly={assembly} />
            {form ? <FormDialog key={form.title} assembly={assembly} form={form} /> : null}
            <ExplodeBar assembly={assembly} />
            <SectionBar assembly={assembly} />
            <StatusNote assembly={assembly} />
            <ViewCubeControl viewport={assembly.viewport} fit={() => assembly.fit()} />
          </div>
          {bottom.length ? <aside className="cad-dock flex flex-col min-h-0 h-[38%] flex-none bg-bench border-t border-line" data-side="bottom">{bottom.map((p) => <Panel key={p.id} assembly={assembly} panel={p} />)}</aside> : null}
        </div>
        {right.length ? <aside className="cad-dock flex flex-col min-h-0 w-72 flex-none bg-bench border-l border-line" data-side="right">{right.map((p) => <Panel key={p.id} assembly={assembly} panel={p} />)}</aside> : null}
        <Rail assembly={assembly} />
      </div>
      <CommandPalette assembly={assembly} />
      <ContextMenu assembly={assembly} />
      <Shortcuts assembly={assembly} />
      <TipHost />
    </div>
  );
}
