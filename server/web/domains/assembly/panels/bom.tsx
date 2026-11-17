// bom.tsx — the assembly's Bill of materials window: the mechanical parts with their quantities and, under each
// board, its electronic parts, in one table (services/bom.ts), with a CSV export.
import { useEffect, useState } from "react";
import { cx } from "../../../shared/util";
import { bomCsv, type BomRow } from "../services/bom";
import { readBom } from "../services/bom-sources";
import { mountFloating, partSourcesOf } from "../services/interference-view";
import type { AssemblyEditor } from "../ui/assembly";

const stem = (p: string) => (p.split("/").pop() || p).replace(/\.[^.]+$/, "");

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Bom({ a, close }: { a: AssemblyEditor; close(): void }) {
  const [state, setState] = useState<"reading" | "done" | "error">("reading");
  const [rows, setRows] = useState<BomRow[]>([]);
  const [error, setError] = useState("");
  const [src] = useState(() => partSourcesOf(a));
  const read = async () => {
    setState("reading"); setError("");
    try { setRows(await readBom(a.getState().instances, a.host.docs, src.sources)); setState("done"); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setState("error"); }
  };
  useEffect(() => { void read(); return () => src.release(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const parts = rows.filter((r) => r.kind !== "component").reduce((n, r) => n + r.quantity, 0);
  const electronic = rows.filter((r) => r.kind === "component").reduce((n, r) => n + r.quantity, 0);
  return (
    <div className="asm-bom absolute left-2 right-2 top-2 z-[3] max-h-[85%] flex flex-col rounded-sm border border-line bg-panel text-sm shadow-panel" data-state={state} role="dialog" aria-label="Bill of materials">
      <header className="flex items-center gap-1 h-7 px-2 border-b border-line font-semibold text-ink">
        <span className="flex-1">Bill of materials</span>
        <span className="text-xs font-normal text-ink-2 mr-2">{state === "done" ? `${parts} parts${electronic ? `, ${electronic} electronic parts` : ""}` : ""}</span>
        <button type="button" className="btn sm h-5 px-1.5" disabled={state !== "done"} onClick={() => download(`${stem(a.host.doc.path)} BOM.csv`, bomCsv(rows))}>Export CSV</button>
        <button type="button" className="btn sm ghost h-5 px-1" onClick={() => void read()} disabled={state === "reading"}>Refresh</button>
        <button type="button" className="btn sm ghost h-5 px-1" aria-label="Close" onClick={close}>×</button>
      </header>
      <div className="overflow-auto">
        {state === "reading" ? <p className="note m-0 p-2 text-xs">Reading the parts and boards…</p> : null}
        {error ? <p className="m-0 p-2 text-xs text-err">{error}</p> : null}
        {state === "done" && !rows.length ? <p className="note m-0 p-2 text-xs">Nothing is placed in this assembly yet.</p> : null}
        {rows.length ? (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-left text-ink-2 border-b border-line">
                {["Item", "Name", "Description", "Qty", "References", "Footprint", "MPN", "Material"].map((h) => <th key={h} className={cx("px-2 py-1 font-semibold", h === "Qty" && "text-right")}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item} data-kind={r.kind} className={cx("border-b border-line last:border-b-0", r.kind === "component" ? "text-ink-2" : "text-ink")}>
                  <td className="px-2 py-0.5 mono">{r.item}</td>
                  <td className={cx("px-2 py-0.5", r.kind === "component" && "pl-5")}>{r.name}</td>
                  <td className="px-2 py-0.5">{r.description}{r.note ? <span className="text-ink-3"> — {r.note}</span> : null}</td>
                  <td className="px-2 py-0.5 text-right mono">{r.quantity}</td>
                  <td className="px-2 py-0.5 mono">{r.refs || ""}</td>
                  <td className="px-2 py-0.5 mono">{r.footprint ? r.footprint.split(":").pop() : ""}</td>
                  <td className="px-2 py-0.5 mono">{r.mpn || r.vendorPart || ""}</td>
                  <td className="px-2 py-0.5">{r.material || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </div>
  );
}

export function openBom(a: AssemblyEditor): void { mountFloating(a, "bom", (close) => <Bom a={a} close={close} />); }
