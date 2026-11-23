// report.ts — running a custom feature on a part studio and saying what came of it: the one report the editor's
// assistant, the cad_script_run tool of the MCP endpoint and the tests all read.
//
// The feature list (the studio's, with the script's feature laid in or appended) is built by a regeneration
// engine of its own, rolled back to just after that feature, so the caller's model is not disturbed.  The
// engine is the real one: the result is checked for soundness exactly as on the page (kernel/regen.ts).
import { VIEWS, encodePng, renderMeshes, type ViewName } from "../mcp/render";
import { bbox } from "../kernel/ops/shapes";
import type { Kernel } from "../kernel/occ";
import type { FeatureInput } from "../kernel/protocol";
import type { RegenEngine } from "../kernel/regen";
import type { Body, ModelState } from "../kernel/types";
import { measureEntity } from "../services/_measure-kernel";
import type { Vec3 } from "../core/geometry";
import { looksInward } from "./host";
import { lastRunOf } from "./run";

/* eslint-disable @typescript-eslint/no-explicit-any */
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export interface RunReport {
  status: "ok" | "warning" | "error";
  /** why it failed; `line` is in the script */
  error?: { message: string; line?: number; kind?: string };
  warnings: string[];
  /** what the script reported with ctx.report */
  reports: { label: string; value: string }[];
  console: string[];
  /** every new or changed body passed the kernel's check (closed, the right way out, no face crossing another) */
  sound: boolean;
  volume_before_mm3: number;
  volume_after_mm3: number;
  /** negative when material was removed */
  volume_change_percent: number | null;
  /** grams, when a density (g/cm³) was given */
  mass_before_g?: number; mass_after_g?: number;
  bodies: { id: string; name: string; volume_mm3: number; volume_before_mm3: number | null; faces: number; bbox_mm: number[] | null; changed: boolean }[];
  ms: number;
  /** how much of its allowance the script used */
  budget?: { ticks: number; calls: number };
  /** a picture of the result, PNG in base64 (when asked for) */
  png?: string;
  image_view?: string;
}

export interface RunOptions { image?: { view?: string; width?: number } | false; density?: number }

const volumeOf = (k: Kernel, state: ModelState): number => state.bodies.filter((b) => !b.reference && !b.sheet).reduce((n, b) => n + k.volume(b.shape), 0);

/**
 * Build `features[0 .. index of featureId]` and report on that feature.  `features` are worker inputs
 * (document/inputs.ts studioInputs), the script's feature among them.
 */
export async function runReport(k: Kernel, engine: RegenEngine, features: readonly FeatureInput[], featureId: string, o: RunOptions = {}): Promise<RunReport> {
  const index = features.findIndex((f) => f.id === featureId);
  if (index < 0) throw new Error("The feature to run is not in the list.");
  const t0 = Date.now();
  const result = await engine.regenerate(features, index + 1, []);
  const rep = result.features[index];
  const before = engine.before(featureId) || { bodies: [], sketches: {} }, after = engine.state;
  const run = lastRunOf(featureId);
  const vb = k.withScope(() => volumeOf(k, before)), va = k.withScope(() => volumeOf(k, after));
  const was = new Map<string, Body>(before.bodies.map((b) => [b.id, b]));
  const bodies = k.withScope(() => after.bodies.filter((b) => !b.reference).map((b) => {
    const old = was.get(b.id), bb = bbox(k, [b.shape]);
    return { id: b.id, name: b.name, volume_mm3: r3(k.volume(b.shape)), volume_before_mm3: old ? r3(k.volume(old.shape)) : null, faces: b.topo.faces.length, bbox_mm: bb ? bb.map(r3) : null, changed: !old || old.rev !== b.rev };
  }));
  const status = rep.status === "error" ? "error" : rep.status === "warning" ? "warning" : "ok";
  const sound = status !== "error" && k.withScope(() => after.bodies.every((b) => b.reference || was.get(b.id)?.rev === b.rev || k.sound(b.shape)));
  const out: RunReport = {
    status,
    warnings: run && run.ok ? run.warnings : status === "warning" && rep.message ? [rep.message] : [],
    reports: run && run.ok ? run.reports : [], console: run ? run.console : [],
    sound, volume_before_mm3: r3(vb), volume_after_mm3: r3(va), volume_change_percent: vb > 1e-9 ? Math.round(((va - vb) / vb) * 10000) / 100 : null,
    bodies, ms: Date.now() - t0,
  };
  if (status === "error") out.error = run && !run.ok && run.error ? { message: run.error.message, line: run.error.line, kind: run.error.kind } : { message: rep.message || "The feature failed.", kind: /sound part/.test(rep.message || "") ? "unsound" : undefined };
  if (run && run.ok) out.budget = { ticks: run.ticks, calls: run.calls };
  if (typeof o.density === "number" && o.density > 0) { out.mass_before_g = r3((vb * o.density) / 1000); out.mass_after_g = r3((va * o.density) / 1000); }
  if (o.image !== false && result.bodies.some((b) => b.mesh)) {
    const view = (o.image && o.image.view && o.image.view in VIEWS ? o.image.view : "iso") as ViewName;
    const width = Math.max(300, Math.min(1400, (o.image && o.image.width) || 800));
    const pic = renderMeshes(result.bodies.filter((b) => b.mesh).map((b) => b.mesh!), { width, height: Math.round(width * 0.75), view, edges: true });
    out.png = toBase64(encodePng(pic)); out.image_view = view;
  }
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  const g = globalThis as any;
  if (typeof g.Buffer !== "undefined") return g.Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return g.btoa(s);
}

/** A report as a few lines a model (or a person) reads at a glance. */
export function reportText(r: RunReport): string {
  const lines: string[] = [];
  if (r.status === "error") lines.push(`FAILED: ${r.error?.message || "the feature failed"}`);
  else lines.push(`${r.status === "warning" ? "Built with a note" : "Built"}: ${r.sound ? "the result is a sound solid" : "THE RESULT IS NOT A SOUND SOLID"}.`);
  for (const w of r.warnings) lines.push(`Note: ${w}`);
  if (r.status !== "error") {
    const pct = r.volume_change_percent;
    lines.push(`Volume ${r.volume_before_mm3} → ${r.volume_after_mm3} mm³${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct} %)`}; ${r.bodies.length} ${r.bodies.length === 1 ? "body" : "bodies"}, ${r.bodies.reduce((n, b) => n + b.faces, 0)} faces.`);
    if (r.mass_before_g !== undefined) lines.push(`Mass ${r.mass_before_g} → ${r.mass_after_g} g.`);
  }
  for (const x of r.reports) lines.push(`${x.label}: ${x.value}`);
  if (r.console.length) lines.push("Console:", ...r.console.slice(0, 40).map((c) => "  " + c));
  return lines.join("\n");
}

// ---------------------------------------------------------------- what a part looks like, for whoever writes a script

export interface PartSummary {
  units: "mm";
  bodies: {
    id: string; name: string; volume_mm3: number; bbox_mm: { min: number[]; max: number[]; size: number[] } | null;
    faces: { count: number; by_kind: { [kind: string]: number }; flat: { name: string; normal: number[]; area_mm2: number; openings: number }[] };
    holes: { diameter_mm: number; count: number }[];
    edges: number;
  }[];
}

/** The bodies of a model state as a script's author needs them: sizes, the flat faces by direction and size, the holes. */
export function partSummary(k: Kernel, state: ModelState): PartSummary {
  return k.withScope(() => ({
    units: "mm" as const,
    bodies: state.bodies.filter((b) => !b.reference && !b.sheet).map((b) => {
      const bb = bbox(k, [b.shape]);
      const byKind: { [kind: string]: number } = {}, flat: PartSummary["bodies"][number]["faces"]["flat"] = [];
      const holes = new Map<number, number>();
      for (const f of b.topo.faces) {
        const m = measureEntity(k, f.shape, "face");
        const kind = m.surface || "other";
        byKind[kind] = (byKind[kind] || 0) + 1;
        if (kind === "plane" && m.normal) flat.push({ name: f.name, normal: (m.normal as number[]).map((v) => Math.round(v * 1000) / 1000), area_mm2: r3(m.area || 0), openings: Math.max(0, k.sub(f.shape, "wire").length - 1) });
        if (kind === "cylinder" && m.radius !== undefined && m.center && m.axis && looksInward(k, f.shape, m.center as Vec3, m.axis as Vec3)) { const d = Math.round(m.radius * 2 * 1000) / 1000; holes.set(d, (holes.get(d) || 0) + 1); }
      }
      flat.sort((p, q) => q.area_mm2 - p.area_mm2);
      return {
        id: b.id, name: b.name, volume_mm3: r3(k.volume(b.shape)),
        bbox_mm: bb ? { min: bb.slice(0, 3).map(r3), max: bb.slice(3).map(r3), size: [0, 1, 2].map((i) => r3(bb[i + 3] - bb[i])) } : null,
        faces: { count: b.topo.faces.length, by_kind: byKind, flat: flat.slice(0, 12) },
        holes: Array.from(holes, ([diameter_mm, count]) => ({ diameter_mm, count })).sort((p, q) => p.diameter_mm - q.diameter_mm),
        edges: b.topo.edges.length,
      };
    }),
  }));
}
