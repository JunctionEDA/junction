// AssemblyView.tsx — the assembly's frame: a toolbar drawn from tools/*.ts, the instance and mate lists, the
// viewport.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cx } from "../../../shared/util";
import type { AssemblyEditor, AssemblyState } from "./assembly";

function useAssembly<T>(a: AssemblyEditor, selector: (s: AssemblyState) => T): T { return useSyncExternalStore(a.subscribe, () => selector(a.getState())); }

function Glyph({ svg }: { svg?: string }) {
  return <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" className="flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]" strokeWidth={1.7} dangerouslySetInnerHTML={{ __html: svg || '<rect x="5" y="5" width="14" height="14" rx="2"/>' }} />;
}

export function AssemblyView({ assembly, canvasHost }: { assembly: AssemblyEditor; canvasHost: HTMLElement }) {
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => { stage.current?.prepend(canvasHost); return () => canvasHost.remove(); }, [canvasHost]);
  const s = useAssembly(assembly, (x) => x);
  const tools = assembly.tools().slice().sort((a, b) => (a.order ?? 1e6) - (b.order ?? 1e6) || a.title.localeCompare(b.title));
  const list = (title: string, id: string, rows: { id: string; name: string; note?: string }[], empty: string) => (
    <section className="flex flex-col min-h-0 flex-[1_1_0] border-b border-line last:border-b-0" data-panel={id}>
      <header className="flex flex-none items-center h-5.5 px-1.5 text-sm font-semibold text-ink bg-[linear-gradient(var(--color-paper),var(--color-bench))] border-b border-line select-none">{title}</header>
      <div className="flex-1 min-h-0 overflow-y-auto bg-paper py-1 text-sm" role="listbox" aria-label={title}>
        {rows.map((r) => (
          <div key={r.id} role="option" aria-selected={s.selected === r.id} className={cx("flex items-center gap-2 h-6.5 px-2 cursor-default", s.selected === r.id ? "bg-sel" : "hover:bg-sel-soft")} onClick={() => assembly.select(r.id)}>
            <span className="flex-1 truncate">{r.name}</span>{r.note ? <span className="text-ink-3 text-xs">{r.note}</span> : null}
          </div>
        ))}
        {s.loaded && !rows.length ? <p className="note px-2 m-0">{empty}</p> : null}
        {!s.loaded ? <p className="note px-2 m-0">Loading…</p> : null}
      </div>
    </section>
  );
  return (
    <div className="cad-root grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] text-ink" data-doc-kind="assembly">
      <div className="cad-toolbar flex items-center gap-0.5 h-9 px-1.5 bg-bench border-b border-line overflow-x-auto select-none" role="toolbar" aria-label="Assembly tools">
        {tools.map((t) => {
          const why = t.disabled ? t.disabled(assembly) : null;
          return <button key={t.id} type="button" className={cx("btn sm ghost flex items-center gap-1.5 px-1.5", t.active && t.active(assembly) && "on", why && "opacity-45")} title={why ? `${t.title}: ${why}` : t.hint ? `${t.title}\n${t.hint}` : t.title} onClick={() => { if (!why) t.run(assembly); }}><Glyph svg={t.icon} /><span>{t.title}</span></button>;
        })}
        {!tools.length ? <span className="px-1.5 text-ink-3 text-sm">Inserting parts and boards, and mating them, is not built yet.</span> : null}
      </div>
      <div className="flex min-h-0 min-w-0">
        <aside className="cad-dock flex flex-col min-h-0 w-60 bg-bench border-r border-line">
          {list("Instances", "instances", s.instances.map((i) => ({ id: i.id, name: i.name, note: i.fixed ? "fixed" : i.source.kind })), "Nothing is placed in this assembly yet.")}
          {list("Mates", "mates", s.mates.map((m) => ({ id: m.id, name: m.name, note: assembly.mateTypes().find((d) => d.type === m.mateType)?.title || m.mateType })), "No mates yet.")}
        </aside>
        <div ref={stage} className="cad-stage relative flex-1 min-w-0 min-h-0 overflow-hidden">
          {s.loaded && !s.instances.length ? <div className="cad-note absolute left-2 bottom-2 z-[2] px-2 py-0.5 rounded-sm border border-line bg-panel text-ink-2 text-xs pointer-events-none" role="status">An empty assembly. Right-drag turns the view, the wheel zooms.</div> : null}
          {!s.loaded ? <div className="cad-note absolute left-2 bottom-2 z-[2] px-2 py-0.5 rounded-sm border border-line bg-panel text-ink-2 text-xs pointer-events-none" role="status">{s.status.state === "error" ? s.status.text : "Opening the assembly…"}</div> : null}
        </div>
      </div>
    </div>
  );
}
