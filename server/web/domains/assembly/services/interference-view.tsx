// interference-view.tsx — the Interference window of the assembly, over its viewport: runs the check
// (interference.ts, exact in the worker), lists the clashes with their volumes, draws each clash volume in the
// viewport in the error colour, and measures the clearance between two chosen instances.  Thin: the logic is in
// interference.ts and interference-sources.ts.
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as THREE from "three";
import { tokenColor } from "../../../shared/viewport3d/viewport3d";
import { cx } from "../../../shared/util";
import type { AssemblyEditor } from "../ui/assembly";
import { checkInterference, clashTitle, clearance, type Clash } from "./interference";
import { PartSources } from "./interference-sources";

const fmt = (v: number, places = 3) => { const s = v.toFixed(places); return s.includes(".") ? s.replace(/\.?0+$/, "") : s; };

interface Shared { sources: PartSources; users: number }
const shared = new WeakMap<AssemblyEditor, Shared>();
/** The part sources of an assembly, shared by its Interference and Bill of materials windows. */
export function partSourcesOf(a: AssemblyEditor): { sources: PartSources; release(): void } {
  let s = shared.get(a);
  if (!s) {
    s = { sources: new PartSources(a.host.signedIn), users: 0 };
    shared.set(a, s);
    // the workers stop with the assembly
    const close = a.close.bind(a), mine = s;
    a.close = () => { mine.sources.dispose(); shared.delete(a); close(); };
  }
  s.users++;
  const me = s;
  return { sources: s.sources, release: () => { if (--me.users <= 0) { me.sources.dispose(); shared.delete(a); } } };
}

/** A floating window in the assembly's viewport, mounted once per assembly and id. */
const mounted = new WeakMap<AssemblyEditor, Map<string, { el: HTMLElement; root: Root }>>();
export function mountFloating(a: AssemblyEditor, id: string, render: (close: () => void) => JSX.Element): void {
  let m = mounted.get(a); if (!m) { m = new Map(); mounted.set(a, m); }
  const old = m.get(id);
  if (old) { old.root.unmount(); old.el.remove(); m.delete(id); }
  const el = document.createElement("div");
  a.viewport.host.appendChild(el);
  const root = createRoot(el);
  const close = () => { root.unmount(); el.remove(); m!.delete(id); };
  m.set(id, { el, root });
  root.render(render(close));
}

class ClashDrawing {
  private readonly group = new THREE.Group();
  constructor(private readonly a: AssemblyEditor) { a.viewport.scene.add(this.group); }
  draw(clashes: Clash[], gap: { pa: number[]; pb: number[] } | null): void {
    this.clear();
    const err = tokenColor("--err");
    const box = new THREE.Box3();
    for (const c of clashes) {
      if (!c.mesh || !c.mesh.indices.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(c.mesh.positions, 3));
      g.setIndex(c.mesh.indices); g.computeVertexNormals(); g.computeBoundingBox();
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: err, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
      m.name = "clash"; m.userData.fit = true; m.renderOrder = 40;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color: err }));
      edges.renderOrder = 41;
      this.group.add(m, edges);
      box.union(g.boundingBox!);
    }
    if (gap) {
      const pts = [new THREE.Vector3(...gap.pa), new THREE.Vector3(...gap.pb)];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: tokenColor("--mark"), depthTest: false }));
      line.name = "clearance"; line.renderOrder = 42;
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(pts), new THREE.PointsMaterial({ color: tokenColor("--mark"), size: 8, sizeAttenuation: false, depthTest: false }));
      this.group.add(line, dots);
      for (const p of pts) box.expandByPoint(p);
    }
    if (!box.isEmpty()) this.a.viewport.fit(box.expandByScalar(5));
    this.a.viewport.invalidate();
  }
  clear(): void {
    for (const o of this.group.children.slice()) { this.group.remove(o); const m = o as THREE.Mesh; m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.a.viewport.invalidate();
  }
  dispose(): void { this.clear(); this.a.viewport.scene.remove(this.group); }
}

function Interference({ a, close }: { a: AssemblyEditor; close(): void }) {
  const [state, setState] = useState<"running" | "done" | "error">("running");
  const [error, setError] = useState("");
  const [clashes, setClashes] = useState<Clash[]>([]);
  const [info, setInfo] = useState({ parts: 0, candidates: 0, ms: 0, skipped: [] as { instance: string; why: string }[] });
  const [pair, setPair] = useState<[string, string]>(["", ""]);
  const [gap, setGap] = useState<{ distance: number; pa: number[]; pb: number[] } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [drawing] = useState(() => new ClashDrawing(a));
  const [src] = useState(() => partSourcesOf(a));
  const instances = a.getState().instances;
  const name = (id: string) => instances.find((i) => i.id === id)?.name || id;

  const run = async () => {
    setState("running"); setError(""); setGap(null);
    try {
      const { shapes, skipped } = await src.sources.shapes(a.getState().instances);
      const r = await checkInterference(shapes, src.sources.call, { mesh: true });
      setClashes(r.clashes); setInfo({ parts: shapes.length, candidates: r.candidates, ms: r.ms, skipped });
      drawing.draw(r.clashes, null);
      setState("done");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setState("error"); }
  };
  const measure = async () => {
    if (!pair[0] || !pair[1] || pair[0] === pair[1]) return;
    setMeasuring(true); setError("");
    try {
      const { shapes } = await src.sources.shapes(a.getState().instances.filter((i) => i.id === pair[0] || i.id === pair[1]));
      const sa = shapes.find((s) => s.instance === pair[0]), sb = shapes.find((s) => s.instance === pair[1]);
      if (!sa || !sb) throw new Error("Clearance is measured between part instances.");
      const g = await clearance(sa, sb, src.sources.call);
      setGap(g); drawing.draw(clashes, g);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setMeasuring(false);
  };
  useEffect(() => { void run(); return () => { drawing.dispose(); src.release(); }; }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const parts = instances.filter((i) => !i.suppressed && i.source.kind === "part");
  return (
    <div className="asm-interference absolute left-2 top-2 z-[3] w-72 max-h-[80%] flex flex-col rounded-sm border border-line bg-panel text-sm shadow-panel" data-state={state} role="dialog" aria-label="Interference">
      <header className="flex items-center gap-1 h-7 px-2 border-b border-line font-semibold text-ink">
        <span className="flex-1">Interference</span>
        <button type="button" className="btn sm ghost h-5 px-1" onClick={() => void run()} disabled={state === "running"}>Check again</button>
        <button type="button" className="btn sm ghost h-5 px-1" aria-label="Close" onClick={close}>×</button>
      </header>
      <div className="overflow-y-auto p-2 flex flex-col gap-1.5">
        {state === "running" ? <p className="note m-0 text-xs">Checking the parts against each other…</p> : null}
        {state === "error" || error ? <p className="m-0 text-xs text-err">{error}</p> : null}
        {state === "done" ? (
          <>
            <p className="m-0 text-xs text-ink-2">{info.parts} parts, {info.candidates} {info.candidates === 1 ? "pair" : "pairs"} close enough to check, {info.ms} ms.</p>
            {clashes.length ? (
              <ul className="m-0 p-0 list-none flex flex-col" aria-label="Clashes">
                {clashes.map((c) => (
                  <li key={`${c.a}|${c.b}`} data-clash={`${c.a}|${c.b}`} data-volume={c.volume ?? ""} className="flex items-center gap-2 h-6 text-xs">
                    <span className="w-2 h-2 rounded-full bg-err flex-none" aria-hidden="true" />
                    <span className="flex-1 truncate text-ink">{clashTitle(c, name)}</span>
                    <span className="mono text-ink-2">{c.volume === null ? c.error : `${fmt(c.volume)} mm³`}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="m-0 text-xs text-ink">No parts overlap.</p>}
            {info.skipped.length ? <p className="note m-0 text-xs">Not checked: {info.skipped.map((s) => `${name(s.instance)} (${s.why})`).join(", ")}</p> : null}
          </>
        ) : null}
        <div className="flex flex-col gap-1 border-t border-line pt-1.5">
          <div className="text-xs font-semibold text-ink">Clearance</div>
          {(["First instance", "Second instance"] as const).map((label, k) => (
            <select key={label} className="input h-6 text-xs" aria-label={label} value={pair[k]} onChange={(e) => { const p: [string, string] = [...pair]; p[k] = e.target.value; setPair(p); setGap(null); }}>
              <option value="">{label}</option>
              {parts.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          ))}
          <div className="flex items-center gap-2">
            <button type="button" className={cx("btn sm h-6")} disabled={measuring || !pair[0] || !pair[1] || pair[0] === pair[1]} onClick={() => void measure()}>Clearance</button>
            {gap ? <span className="mono text-xs text-ink" data-clearance={gap.distance}>{fmt(gap.distance)} mm</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function openInterference(a: AssemblyEditor): void { mountFloating(a, "interference", (close) => <Interference a={a} close={close} />); }
