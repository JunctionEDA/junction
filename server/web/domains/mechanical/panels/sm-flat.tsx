// The Flat pattern panel (Onshape's sheet metal table and flat view): every sheet metal model of the part
// studio laid flat, its bend table (angle, radius, K-factor, allowance, length, up or down) and a DXF of each
// piece to download.  The worker lays the definition flat (services/sm-flat-pattern.ts), so the drawing is
// the part as it stands, not a picture of its solid.
import { useEffect, useState } from "react";
import { definePanel } from "../core/tool";
import { mm, deg, num } from "../inspect/measure-format";
import { download } from "../tools/_dialog";
import { useStudio } from "../ui/hooks";
import { usePanelOpen } from "../ui/panels";
import type { PartStudio } from "../ui/studio";
import type { FlatPiece } from "../kernel/ops/sheetmetal-ops";

type Piece = FlatPiece & { name: string; dxf?: string };
interface Model { id: string; name: string; thickness: number; radius: number; k: number; finished: boolean; pieces: Piece[] }

export const hasSheetMetal = (studio: PartStudio): boolean => studio.getState().features.some((f) => f.featureType === "sm-model");

function FlatView({ piece }: { piece: Piece }) {
  const [x0, y0, x1, y1] = piece.bbox, w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1), pad = Math.max(w, h) * 0.04;
  const Y = (y: number) => y0 + y1 - y;   // the drawing's y up
  const sw = Math.max(w, h) / 300;
  const path = piece.curves.map((c, i) => {
    if (c.kind === "line") return <line key={i} x1={c.a[0]} y1={Y(c.a[1])} x2={c.b[0]} y2={Y(c.b[1])} />;
    if (c.kind === "circle") return <circle key={i} cx={c.c[0]} cy={Y(c.c[1])} r={c.r} />;
    if (c.kind === "arc") {
      const a = [c.c[0] + c.r * Math.cos(c.start), Y(c.c[1] + c.r * Math.sin(c.start))], b = [c.c[0] + c.r * Math.cos(c.end), Y(c.c[1] + c.r * Math.sin(c.end))];
      let sweep = c.end - c.start; while (sweep < 0) sweep += Math.PI * 2;
      return <path key={i} d={`M${a[0]} ${a[1]}A${c.r} ${c.r} 0 ${sweep > Math.PI ? 1 : 0} 0 ${b[0]} ${b[1]}`} />;
    }
    return <polyline key={i} points={c.points.map((p) => `${p[0]},${Y(p[1])}`).join(" ")} />;
  });
  return (
    <svg className="w-full bg-panel rounded-sm border border-line" style={{ maxHeight: 220 }} viewBox={`${x0 - pad} ${y0 - pad} ${w + 2 * pad} ${h + 2 * pad}`} data-flat-view={piece.root} role="img" aria-label="Flat pattern">
      <g fill="none" stroke="var(--color-ink, #222)" strokeWidth={sw} data-flat-outline>{path}</g>
      <g fill="none" strokeWidth={sw} strokeDasharray={`${sw * 6} ${sw * 4}`}>
        {piece.bends.map((b) => <line key={b.id} x1={b.a[0]} y1={Y(b.a[1])} x2={b.b[0]} y2={Y(b.b[1])} stroke={b.up ? "#2a7de1" : "#d9534f"} data-bend-line={b.up ? "up" : "down"} />)}
      </g>
      {piece.forms.map((f, i) => <circle key={i} cx={f.at[0]} cy={Y(f.at[1])} r={f.size / 2} fill="none" stroke="#3a9a5b" strokeWidth={sw} />)}
    </svg>
  );
}

function FlatPattern({ studio }: { studio: PartStudio }) {
  const bodies = useStudio(studio, (s) => s.bodies);
  const units = useStudio(studio, (s) => s.units);
  const open = usePanelOpen(studio, "sm-flat");
  const [models, setModels] = useState<Model[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    studio.kernel.call("sm-flat-pattern", { dxf: true }).then((r) => { if (live) { setModels((r as unknown as { models: Model[] }).models); setError(""); } })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [studio, bodies, open, units]);
  if (error) return <p className="note m-0 p-2 text-xs text-danger">{error}</p>;
  if (!models) return <p className="note m-0 p-2 text-xs">Laying flat…</p>;
  if (!models.length) return <p className="note m-0 p-2 text-xs">No sheet metal model yet. Start one with Sheet metal model.</p>;
  return (
    <div className="flex flex-col gap-3 p-2 text-sm" data-sm-flat={models.length}>
      {models.map((m) => m.pieces.map((p) => (
        <section key={m.id + p.root} className="flex flex-col gap-1" data-flat-piece={p.root}>
          <div className="flex items-center gap-1 text-xs">
            <span className="flex-1 font-semibold text-ink truncate">{p.name}{m.finished ? " (finished)" : ""}</span>
            <button type="button" className="btn sm h-6 px-2 text-xs" data-flat-dxf title="Download the flat pattern as DXF: outline on CUT, bend lines on BEND_UP and BEND_DOWN"
              onClick={() => p.dxf && download(p.dxf, `${p.name.replace(/[^\w.-]+/g, "_")}-flat.dxf`, "application/dxf")}>DXF</button>
          </div>
          <FlatView piece={p} />
          <p className="note m-0 text-xs text-ink-2" data-flat-size>{mm(p.bbox[2] - p.bbox[0])} × {mm(p.bbox[3] - p.bbox[1])} · thickness {mm(m.thickness)} · K {num(m.k, 3)}</p>
          {p.bends.length ? (
            <table className="w-full border-collapse text-xs whitespace-nowrap" aria-label="Bend table" data-bend-table>
              <thead><tr className="text-ink-2 text-left"><th>#</th><th>Dir</th><th className="text-right">Angle</th><th className="text-right">Radius</th><th className="text-right">K</th><th className="text-right">Allowance</th><th className="text-right">Length</th></tr></thead>
              <tbody>
                {p.bends.map((b, i) => (
                  <tr key={b.id} data-bend={b.id}><td>{i + 1}</td><td>{b.up ? "Up" : "Down"}</td><td className="text-right mono">{deg(b.angle)}</td><td className="text-right mono">{mm(b.radius)}</td>
                    <td className="text-right mono">{num(b.k, 3)}</td><td className="text-right mono">{mm(b.allowance)}</td><td className="text-right mono">{mm(b.length)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="note m-0 text-xs">No bends.</p>}
        </section>
      )))}
    </div>
  );
}

export default definePanel({
  id: "sm-flat", title: "Flat pattern", side: "right", order: 40,
  open: false,
  visible: hasSheetMetal,
  render: (studio) => <FlatPattern studio={studio} />,
});
