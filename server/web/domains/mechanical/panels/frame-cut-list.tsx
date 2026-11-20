// The Cut list panel: the frames' members, gussets and end caps grouped by profile, length and end angles,
// with how many of each (services/frame-cut-list.ts), and a CSV of each table to download.
import { useEffect, useState } from "react";
import { definePanel } from "../core/tool";
import { mm, deg } from "../inspect/measure-format";
import { download } from "../tools/_dialog";
import { useStudio } from "../ui/hooks";
import { usePanelOpen } from "../ui/panels";
import type { PartStudio } from "../ui/studio";
import type { CutRow } from "../kernel/ops/cutlist";

interface Table { feature: string; name: string; rows: CutRow[]; csv?: string }
const FRAME_TYPES = ["frame", "frame-gusset", "frame-end-cap", "frame-cut-list"];
export const hasFrames = (studio: PartStudio): boolean => studio.getState().features.some((f) => FRAME_TYPES.includes(f.featureType));

function CutList({ studio }: { studio: PartStudio }) {
  const bodies = useStudio(studio, (s) => s.bodies);
  const units = useStudio(studio, (s) => s.units);
  const open = usePanelOpen(studio, "frame-cut-list");
  const [tables, setTables] = useState<Table[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    studio.kernel.call("frame-cut-list", { csv: true }).then((r) => { if (live) { setTables((r as unknown as { tables: Table[] }).tables); setError(""); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [studio, bodies, open, units]);
  if (error) return <p className="note m-0 p-2 text-xs">{error}</p>;
  if (!tables) return <p className="note m-0 p-2 text-xs">Listing…</p>;
  if (!tables.length) return <p className="note m-0 p-2 text-xs">No frame members yet. Make one with Frame.</p>;
  return (
    <div className="flex flex-col gap-3 p-2 text-sm" data-cut-lists={tables.length}>
      {tables.map((t) => (
        <section key={t.feature || "all"} className="flex flex-col gap-1" data-cut-list={t.feature || "all"}>
          <div className="flex items-center gap-1 text-xs">
            <span className="flex-1 font-semibold text-ink truncate">{t.name}</span>
            <button type="button" className="btn sm h-6 px-2 text-xs" data-cut-csv title="Download the cut list as CSV (lengths in mm)"
              onClick={() => t.csv && download(t.csv, `${t.name.replace(/[^\w.-]+/g, "_")}.csv`, "text/csv")}>CSV</button>
          </div>
          <table className="w-full border-collapse text-xs" aria-label="Cut list" data-cut-table>
            <thead><tr className="text-ink-2 text-left"><th>#</th><th className="text-right">Qty</th><th>Description</th><th className="text-right">Length</th><th className="text-right">Angles</th></tr></thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.item} data-cut-row={r.item} title={r.bodies.join(", ")}>
                  <td>{r.item}</td><td className="text-right mono" data-qty>{r.qty}</td><td className="truncate max-w-[9rem]">{r.description}</td>
                  <td className="text-right mono" data-length>{mm(r.length)}</td><td className="text-right mono">{deg(r.angle1)} / {deg(r.angle2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

export default definePanel({
  id: "frame-cut-list", title: "Cut list", side: "right", order: 41,
  open: false,
  visible: hasFrames,
  render: (studio) => <CutList studio={studio} />,
});
