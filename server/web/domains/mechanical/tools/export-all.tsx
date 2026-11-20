// export-all.tsx — Export every part: each part of the part studio (or each selected one) written to a file of
// its own, STEP, STL or 3MF, named by a template, and handed over as one .zip or as separate downloads.  One
// part after another through the same worker services as Export (tools/_export.ts); the names and the .zip are
// tools/_batch.ts.
import { useEffect, useMemo, useState } from "react";
import { cx } from "../../../shared/util";
import { defineTool } from "../core/tool";
import { useStudio } from "../ui/hooks";
import { Sheet } from "../ui/Sheet";
import type { PartStudio } from "../ui/studio";
import { DEFAULT_TEMPLATE, batchNames, cleanName, unknownWords, zipStore, type ZipEntry } from "./_batch";
import { download, formatBytes } from "./_dialog";
import { DEFAULTS, formatOf, initialOptions, runExport, type ExportOptions, type FormatId, type Source } from "./_export";

const PREFS = "junction.cad.export-all";
const BATCH_FORMATS: FormatId[] = ["step", "stl", "3mf"];
interface Saved { format: FormatId; template: string; zip: boolean; resolution: ExportOptions["resolution"] }
function saved(): Saved {
  let v: Partial<Saved> = {};
  try { v = JSON.parse(localStorage.getItem(PREFS) || "{}") || {}; } catch { v = {}; }
  return { format: BATCH_FORMATS.includes(v.format as FormatId) ? (v.format as FormatId) : "step", template: typeof v.template === "string" && v.template.trim() ? v.template : DEFAULT_TEMPLATE, zip: v.zip !== false, resolution: v.resolution === "coarse" || v.resolution === "fine" ? v.resolution : "medium" };
}
const docName = (studio: PartStudio): string => (studio.host.doc.path.split("/").pop() || "part studio").replace(/\.[^.]+$/, "");

/** The parts a batch exports: the selected ones, or every part (not the reference bodies: a board is not a part to make). */
export function batchParts(studio: PartStudio): { id: string; name: string }[] {
  const s = studio.getState();
  const chosen = new Set(s.selection.flatMap((p) => ("body" in p ? [p.body] : [])));
  const parts = s.bodies.filter((b) => !b.reference);
  return (chosen.size ? parts.filter((b) => chosen.has(b.id)) : parts).map((b) => ({ id: b.id, name: b.name }));
}

/** Export a sketch or a flat face as a drawing at once, with the options Export used last (the right-click menus). */
export async function exportDrawing(studio: PartStudio, source: Source, format: "dxf" | "svg", name: string): Promise<void> {
  try {
    const r = await runExport(studio, { ...initialOptions(studio), format, source, bodies: [], name: cleanName(name) });
    download(r.data, r.name, r.mime);
    studio.host.toast(`Saved ${r.name}`, 2500);
  } catch (e) { studio.host.toast((e as Error).message || "That could not be exported.", 4000); }
}

export function ExportAll({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => !!s.ui?.exportAll);
  useStudio(studio, (s) => s.bodies);
  const [o, setO] = useState<Saved>(saved);
  const [run, setRun] = useState<{ done: number; total: number; error?: string; said?: string } | null>(null);
  const parts = useMemo(() => (open ? batchParts(studio) : []), [open, studio, studio.getState().bodies, studio.getState().selection]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setO(saved()); setRun(null); } }, [open]);
  if (!open) return null;
  const f = formatOf(o.format), names = batchNames(o.template, docName(studio), parts, f.ext), unknown = unknownWords(o.template);
  const set = (patch: Partial<Saved>) => { const next = { ...o, ...patch }; setO(next); try { localStorage.setItem(PREFS, JSON.stringify(next)); } catch { /* private window */ } };
  const busy = !!run && run.done < run.total && !run.error;
  const close = () => { if (busy) return; studio.setUi({ exportAll: false }); studio.viewport.canvas.focus(); };
  const start = async () => {
    const base = { ...initialOptions(studio), ...DEFAULTS, format: o.format, resolution: o.resolution, source: null };
    const files: ZipEntry[] = []; let bytes = 0;
    setRun({ done: 0, total: parts.length });
    try {
      for (let i = 0; i < parts.length; i++) {
        const r = await runExport(studio, { ...base, bodies: [parts[i].id], name: names[i].slice(0, -f.ext.length) });
        files.push({ name: names[i], data: r.data }); bytes += r.bytes;
        if (!o.zip) { download(r.data, names[i], r.mime); await new Promise((ok) => setTimeout(ok, 150)); }   // a browser drops downloads that come all at once
        setRun({ done: i + 1, total: parts.length });
      }
      const zipName = `${cleanName(docName(studio))} - ${parts.length} ${f.label} files.zip`;
      if (o.zip) download(zipStore(files), zipName, "application/zip");
      setRun({ done: parts.length, total: parts.length, said: o.zip ? `Saved ${zipName} (${formatBytes(bytes)})` : `Saved ${parts.length} files (${formatBytes(bytes)})` });
    } catch (e) { setRun((r) => ({ done: r?.done || 0, total: parts.length, error: (e as Error).message || "The export failed." })); }
  };
  const seg = (value: string, options: [string, string][], on: (v: string) => void, attr: string) => <span className="seg" data-batch={attr}>{options.map(([v, label]) => <button key={v} type="button" className={cx(value === v && "on")} disabled={busy} data-value={v} onClick={() => on(v)}>{label}</button>)}</span>;
  const rowc = "grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2 min-h-8";
  return (
    <Sheet title="Export every part" name="export-all" onClose={close} attrs={{ "data-parts": String(parts.length) }}
      actions={<button type="button" className="btn sm primary" disabled={busy || !parts.length} data-batch-run onClick={() => { void start(); }}>{busy ? `Exporting ${run!.done + 1} of ${run!.total}…` : `Export ${parts.length} file${parts.length === 1 ? "" : "s"}`}</button>}>
      <div className="flex flex-col gap-1 px-3 py-2 border-b border-line">
        <div className={rowc}><span className="text-ink-2">Format</span>{seg(o.format, BATCH_FORMATS.map((id) => [id, formatOf(id).label]), (v) => set({ format: v as FormatId }), "format")}</div>
        {f.kind === "mesh" ? <div className={rowc}><span className="text-ink-2">Resolution</span>{seg(o.resolution, [["coarse", "Coarse"], ["medium", "Medium"], ["fine", "Fine"]], (v) => set({ resolution: v as Saved["resolution"] }), "resolution")}</div> : null}
        <label className={rowc}><span className="text-ink-2">File names</span><input type="text" className="input mono w-full" value={o.template} disabled={busy} spellCheck={false} data-batch-template onChange={(ev) => set({ template: ev.target.value })} /></label>
        <p className="note m-0 pl-[118px] text-xs">{unknown.length ? <span className="text-err" data-batch-unknown>{unknown.join(", ")} is not a word this knows. </span> : null}Words: <span className="mono">{"{document} {part} {n} {count} {date}"}</span>. Names that would be the same are told apart with (2), (3).</p>
        <label className={rowc}><span className="text-ink-2">Hand over as</span><span className="flex items-center gap-1.5"><input type="checkbox" checked={o.zip} disabled={busy} data-batch-zip onChange={(ev) => set({ zip: ev.target.checked })} /><span>one .zip file</span></span></label>
      </div>
      <div className="overflow-y-auto min-h-24" data-batch-names>
        {parts.length ? parts.map((p, i) => (
          <div key={p.id} className="flex items-center gap-2 px-3 h-7 border-b border-line last:border-b-0" data-batch-file={names[i]}>
            <span className="w-40 truncate text-ink-2">{p.name}</span><span className="flex-1 truncate mono">{names[i]}</span>
            {run && i < run.done ? <span className="text-teal text-xs">written</span> : run && i === run.done && busy ? <span className="spinner" style={{ width: 10, height: 10 }} /> : null}
          </div>
        )) : <p className="note px-3 py-2 m-0">There are no parts to export yet.</p>}
      </div>
      <p className={cx("note flex-none m-0 px-3 py-1.5 border-t border-line text-xs", run?.error && "text-err")} role="status" data-batch-status={run?.error ? "error" : run?.said ? "done" : busy ? "running" : "idle"}>{run?.error || run?.said || (parts.length < studio.getState().bodies.filter((b) => !b.reference).length ? "Only the selected parts. Clear the selection to export every part." : "Every part gets a file of its own. Select parts first to export only those.")}</p>
    </Sheet>
  );
}

export default defineTool({
  id: "export-all", title: "Export every part", hint: "Each part to a file of its own (STEP, STL or 3MF), named by a template, as one .zip.", group: "file", order: 21,
  icon: '<path d="M4 5h7v6H4zM13 5h7v6h-7zM4 13h7v6H4z"/><path d="M16.5 13v6M13.8 16.5l2.7 2.7 2.7-2.7"/>',
  disabled: (studio) => (studio.getState().bodies.some((b) => !b.reference) ? null : "There are no parts to export yet"),
  run: (studio) => studio.setUi({ exportAll: true }),
});
