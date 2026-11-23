// EditorPanel.tsx — the custom feature editor: the script on the right of the stage, the part and the feature's
// generated dialog (the studio's own) beside it, problems and console output under the code, and the
// assistant's box.  State is ui/editor-state.ts; this file only draws it.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cx } from "../../../../shared/util";
import { Glyph } from "../../ui/Glyph";
import { useStudio } from "../../ui/hooks";
import type { PartStudio } from "../../ui/studio";
import { exportName } from "../library";
import { iconMarkup } from "../manifest";
import { RUN_LIMITS } from "../limits";
import { Assistant } from "./Assistant";
import { CodeEditor, type Marker } from "./CodeEditor";
import { diffLines, diffStat, hunks } from "./diff";
import { editorOf } from "./editor-state";

const X = '<path d="M6 6l12 12M18 6 6 18"/>';

function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stat = diffStat(lines), rows = hunks(lines);
  return (
    <div className="h-full min-h-0 overflow-auto mono text-xs leading-5" data-script-diff data-added={stat.added} data-removed={stat.removed}>
      <div className="sticky top-0 px-2 h-6 flex items-center gap-3 border-b border-line bg-panel text-ink-2 [font-family:inherit]">
        <span>The assistant's change</span><span className="text-ok">+{stat.added}</span><span className="text-err">−{stat.removed}</span>
      </div>
      {rows.map((l, i) => l.kind === "gap" ? <div key={i} className="px-2 text-ink-3 select-none">⋯ {l.count} unchanged {l.count === 1 ? "line" : "lines"}</div> : (
        <div key={i} data-diff={l.kind} className={cx("flex whitespace-pre", l.kind === "add" && "bg-[color-mix(in_srgb,var(--ok)_14%,transparent)]", l.kind === "del" && "bg-[color-mix(in_srgb,var(--err)_12%,transparent)]")}>
          <span className="flex-none w-9 pr-1 text-right text-ink-3 select-none">{l.kind === "add" ? "" : l.a}</span>
          <span className="flex-none w-9 pr-1 text-right text-ink-3 select-none">{l.kind === "del" ? "" : l.b}</span>
          <span className="flex-none w-4 text-center select-none">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
          <span className="pr-3">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

export function EditorPanel({ studio }: { studio: PartStudio }) {
  const editor = editorOf(studio);
  const s = useSyncExternalStore(editor.subscribe, editor.getState);
  const canEdit = useStudio(studio, (x) => x.canEdit);
  const previewOpen = useStudio(studio, (x) => !!x.editing && x.editing.draft.id === s.previewId);
  const previewNew = useStudio(studio, (x) => !!x.editing && x.editing.isNew && x.editing.draft.id === s.previewId);
  const report = useStudio(studio, (x) => (s.previewId ? x.reports[s.previewId] : undefined));
  const [tab, setTab] = useState<"output" | "assistant">("output");
  const [wide, setWide] = useState(false);
  const self = useRef<HTMLElement>(null);
  // the model keeps the part of the stage the editor leaves: the canvas is narrowed while the editor is open, so
  // the part is fitted and turned in what can be seen of it (the viewport follows its element's size)
  useEffect(() => {
    const el = self.current, stage = el && el.parentElement, canvas = stage && (stage.firstElementChild as HTMLElement | null);
    if (!el || !canvas || canvas === el) return;
    const fit = () => { canvas.style.right = `${el.offsetWidth}px`; };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(el);
    const t = window.setTimeout(() => studio.fit(), 250);
    return () => { ro.disconnect(); clearTimeout(t); canvas.style.right = "0"; };
  }, [s.open, wide, studio]);
  if (!s.open) return null;

  const markers: Marker[] = [];
  for (const p of s.problems) markers.push({ line: p.line, message: p.message });
  if (!s.problems.length && s.run && s.run.error && previewOpen) markers.push({ line: s.run.error.line, message: s.run.error.message });
  const dirty = s.source !== s.saved;
  const status = s.problems.length ? "Does not read" : s.saved === null ? "Not saved to the project" : dirty ? "Changed since it was saved" : "Saved";
  const save = () => { const why = editor.save(); studio.host.toast(why || `Saved “${editor.getState().name}” to this project's custom features.`, why ? 4000 : 2500); };
  const close = () => { if (dirty && !window.confirm("Close the editor? The script has changes that are not saved to the project.")) return; editor.close(); };
  const failed = report && report.status === "error";
  const used = s.run && s.run.ok ? Math.max(s.run.ticks / RUN_LIMITS.ticks, s.run.ms / RUN_LIMITS.ms) : 0;

  return (
    <section ref={self} className={cx("cf-editor absolute right-0 top-0 bottom-0 z-[5] flex flex-col border-l border-line bg-panel text-sm text-ink shadow-panel", wide ? "w-[min(70%,1100px)]" : "w-[min(50%,760px)]")} data-script-editor={s.id} data-script-status={status} aria-label="Custom feature editor"
      onKeyDown={(ev) => ev.stopPropagation()} onKeyUp={(ev) => ev.stopPropagation()} onPointerDown={(ev) => ev.stopPropagation()} onWheel={(ev) => ev.stopPropagation()}>
      <header className="flex items-center gap-1.5 h-9 px-2 border-b border-line flex-none">
        <Glyph svg={iconMarkup(s.manifest ? s.manifest.icon : null)} size={18} />
        <input className="input h-6 flex-1 min-w-0 font-medium" value={s.name} placeholder={s.manifest ? s.manifest.title : "Name"} aria-label="The feature's name in the project" data-script-name onChange={(ev) => editor.setName(ev.target.value)} />
        <span className={cx("flex-none text-xs", s.problems.length ? "text-err" : "text-ink-3")} data-script-saved={dirty ? "no" : "yes"}>{status}</span>
        <button type="button" className="btn sm primary flex-none" data-script-save disabled={!canEdit || !!s.proposal || (!dirty && s.saved !== null)} title="Save to this project's custom features (Ctrl+S)" onClick={save}>Save</button>
        <button type="button" className="btn sm flex-none" data-script-add disabled={!previewNew || !!failed || !!s.proposal} title={previewNew ? "Add the previewed feature to the part (the dialog's ✓)" : "Open the preview first"} onClick={() => studio.acceptFeature()}>Add to part</button>
        <button type="button" className="btn sm ghost flex-none px-1" title={wide ? "Narrower" : "Wider"} aria-label={wide ? "Make the editor narrower" : "Make the editor wider"} onClick={() => setWide(!wide)}><Glyph svg={wide ? '<path d="M9 6l6 6-6 6"/>' : '<path d="M15 6l-6 6 6 6"/>'} size={16} /></button>
        <button type="button" className="btn sm ghost flex-none px-1" data-script-close title="Close the editor" aria-label="Close the editor" onClick={close}><Glyph svg={X} size={16} /></button>
      </header>
      {s.theirs !== null ? (
        <div className="callout warn m-0 rounded-none flex items-center gap-2 flex-none" role="status" data-script-theirs>
          <span className="flex-1">Somebody saved another version of this script to the project while you were editing.</span>
          <button type="button" className="btn sm" onClick={() => editor.takeTheirs()}>Load theirs</button>
          <button type="button" className="btn sm" onClick={() => editor.keepMine()}>Keep mine</button>
        </div>
      ) : null}
      <div className="flex-1 min-h-0 border-b border-line">
        {s.proposal ? <DiffView before={s.source} after={s.proposal.source} /> : <CodeEditor value={s.source} onChange={(t) => editor.setSource(t)} markers={markers} readOnly={!canEdit} onSave={save} />}
      </div>
      <div className="flex-none h-[38%] min-h-[150px] flex flex-col">
        <div className="flex items-center gap-1 h-7 px-1.5 border-b border-line flex-none" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "output"} className={cx("btn sm ghost h-6", tab === "output" && "on")} data-script-tab="output" onClick={() => setTab("output")}>Output{markers.length ? ` (${markers.length})` : ""}</button>
          <button type="button" role="tab" aria-selected={tab === "assistant"} className={cx("btn sm ghost h-6", tab === "assistant" && "on")} data-script-tab="assistant" onClick={() => setTab("assistant")}>Assistant</button>
          <span className="flex-1" />
          {!previewOpen && !s.problems.length ? <button type="button" className="btn sm ghost h-6" data-script-preview onClick={() => editor.showPreview()}>Show preview</button> : null}
          <button type="button" className="btn sm ghost h-6" title="Save the script as a file" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([s.source], { type: "text/javascript" })); a.download = exportName(s.name || (s.manifest ? s.manifest.title : "custom feature")); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }}>Export</button>
        </div>
        <div className="flex-1 min-h-0">
          {tab === "assistant" ? <Assistant studio={studio} editor={editor} /> : (
            <div className="h-full overflow-y-auto px-2 py-1.5 flex flex-col gap-1.5" data-script-output>
              {s.problems.map((p, i) => <p key={i} className="callout err m-0" data-script-problem data-line={p.line}>{p.line ? <span className="mono text-xs mr-2">line {p.line}</span> : null}{p.message}</p>)}
              {!s.problems.length && !previewOpen ? <p className="note m-0">{s.previewId && !previewNew ? "The feature is in the part. Change the script to preview the new version on it." : "The preview is closed. Show preview runs the script on the part again."}</p> : null}
              {!s.problems.length && previewOpen && report ? (
                <p className={cx("callout m-0", failed ? "err" : report.status === "warning" ? "warn" : "")} data-script-result={report.status}>
                  {failed ? report.message : report.status === "warning" ? `Built, with a note: ${report.message}` : "Built: a sound solid."}
                  {!failed && report.info ? <span className="block text-ink-2">{report.info}</span> : null}
                </p>
              ) : null}
              {s.run && previewOpen ? <p className="note m-0 text-xs" data-script-budget>Ran in {s.run.ms} ms{s.run.ok ? `, ${Math.max(1, Math.round(used * 100))} % of the allowance, ${s.run.calls} API calls` : ""}.</p> : null}
              {s.run && s.run.console.length && previewOpen ? <pre className="mono text-xs m-0 whitespace-pre-wrap rounded-sm border border-line p-1.5 bg-bench" data-script-console>{s.run.console.join("\n")}</pre> : null}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
