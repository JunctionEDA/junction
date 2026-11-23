// mass.tsx — the Mass properties panel: the mass, the volume and the centre of mass of the assembly, or of the
// instances that are selected.  Each part studio's bodies are measured by the worker that holds them (exact, from
// the B-rep, with the materials given there); services/mass.ts adds them up where the instances stand.
import { useEffect, useState } from "react";
import { densities, type Vec3 } from "../../mechanical/api";
import { placeMass, totalMass, type BodyMass, type MassRow, type MassTotal } from "../services/mass";
import type { AssemblyEditor } from "../ui/assembly";
import { useAssembly } from "../ui/parts";

const fmt = (v: number, places = 3): string => { const s = v.toFixed(places); return s.includes(".") ? s.replace(/\.?0+$/, "") : s; };
const mass = (kg: number): string => (kg >= 1 ? `${fmt(kg, 3)} kg` : `${fmt(kg * 1000, 2)} g`);
const volume = (mm3: number): string => (mm3 >= 1e6 ? `${fmt(mm3 / 1e6, 3)} dm³` : mm3 >= 1000 ? `${fmt(mm3 / 1000, 3)} cm³` : `${fmt(mm3, 2)} mm³`);

interface Result { rows: MassRow[]; total: MassTotal; skipped: number }
const measured = new WeakMap<AssemblyEditor, Map<string, { version: number; bodies: Map<string, BodyMass> }>>();

/** Every part instance's row (the selected ones only, when some are selected). */
export async function readMass(a: AssemblyEditor, only: ReadonlySet<string> | null): Promise<Result> {
  let cache = measured.get(a);
  if (!cache) { cache = new Map(); measured.set(a, cache); }
  const rows: MassRow[] = [];
  let skipped = 0;
  for (const p of a.placed()) {
    if (only && !only.has(p.item.id)) continue;
    const src = p.item.source;
    if (src.kind !== "part") { skipped++; continue; }
    const handle = a.sources.handle("part", src.docId);
    if (!handle) { skipped++; continue; }
    const snap = handle.snapshot();
    let read = cache.get(src.docId);
    if (!read || read.version !== snap.version) {
      const kernel = handle.ensureKernel ? await handle.ensureKernel() : null;
      if (!kernel) { skipped++; continue; }
      const doc = handle.doc ? handle.doc() : null;
      const r = await kernel.call("mass-properties", { bodies: null, density: densities(doc) } as never) as unknown as { parts: { id: string; volume: number; mass: number | null; centre: Vec3 }[] };
      read = { version: snap.version, bodies: new Map(r.parts.map((b) => [b.id, { volume: b.volume, mass: b.mass, centre: b.centre }])) };
      cache.set(src.docId, read);
    }
    let any = false;
    for (const piece of p.pieces) { const b = read.bodies.get(piece.id); if (b) { rows.push(placeMass(p.item.id, p.item.name, b, piece.transform)); any = true; } }
    if (!any) skipped++;
  }
  return { rows, total: totalMass(rows), skipped };
}

function Mass({ a }: { a: AssemblyEditor }) {
  const selection = useAssembly(a, (s) => s.selection), instances = useAssembly(a, (s) => s.instances), building = useAssembly(a, (s) => s.building);
  const [state, setState] = useState<{ result?: Result; error?: string; busy: boolean }>({ busy: true });
  const chosen = selection.filter((id) => instances.some((i) => i.id === id));
  const key = chosen.join(" ") + "|" + instances.map((i) => `${i.id}${i.suppressed ? "s" : ""}`).join(" ") + "|" + building;
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, busy: true }));
    readMass(a, chosen.length ? new Set(chosen) : null).then((result) => { if (live) setState({ result, busy: false }); }, (e) => { if (live) setState({ error: e instanceof Error ? e.message : String(e), busy: false }); });
    return () => { live = false; };
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const r = state.result, t = r?.total;
  const row = (label: string, value: string, name: string) => <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-x-2 min-h-6 items-center"><span className="text-ink-2">{label}</span><span className="mono" data-mass={name}>{value}</span></div>;
  return (
    <div className="flex flex-col gap-1 p-2 text-sm" data-mass-panel data-busy={state.busy || undefined}>
      <p className="note m-0 text-xs">{chosen.length ? `Of the ${chosen.length} selected instance${chosen.length === 1 ? "" : "s"}.` : "Of the whole assembly. Select instances to weigh only those."}</p>
      {state.error ? <p className="m-0 text-xs text-err">{state.error}</p> : null}
      {t ? <>
        {row("Parts", String(t.count), "count")}
        {row("Mass", t.count === t.unweighed ? "no material" : mass(t.mass) + (t.unweighed ? ` + ${t.unweighed} without material` : ""), "mass")}
        {row("Volume", volume(t.volume), "volume")}
        {row(t.centreBy === "mass" ? "Centre of mass" : "Centre of volume", t.centre ? t.centre.map((v) => fmt(v, 2)).join(", ") + " mm" : "", "centre")}
        {t.unweighed ? <p className="note m-0 text-xs">A part has a mass when it has a material: give it one in its part studio (Appearance and material).</p> : null}
        {r && r.skipped ? <p className="note m-0 text-xs" data-mass-skipped>{r.skipped} instance{r.skipped === 1 ? " is" : "s are"} not counted: boards and sub-assemblies are not weighed yet.</p> : null}
      </> : state.busy ? <p className="note m-0 text-xs">Measuring the parts…</p> : null}
      {r && r.rows.length > 1 ? (
        <table className="w-full border-collapse text-xs mt-1">
          <thead><tr className="text-left text-ink-2 border-b border-line"><th className="py-1 font-semibold">Instance</th><th className="py-1 font-semibold text-right">Mass</th><th className="py-1 font-semibold text-right">Volume</th></tr></thead>
          <tbody>{r.rows.map((x, i) => <tr key={x.instance + i} className="border-b border-line last:border-b-0"><td className="py-0.5 truncate max-w-0 w-full">{x.name}</td><td className="py-0.5 pl-2 text-right mono whitespace-nowrap">{x.mass === null ? "–" : mass(x.mass)}</td><td className="py-0.5 pl-2 text-right mono whitespace-nowrap">{volume(x.volume)}</td></tr>)}</tbody>
        </table>
      ) : null}
    </div>
  );
}

export function openMass(a: AssemblyEditor): void { a.showPanel({ id: "mass", title: "Mass properties", side: "right", render: (x) => <Mass a={x} /> }); }
