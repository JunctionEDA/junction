// report-text.ts — the shape of what running a custom feature reports (script/report.ts makes it, in the worker
// or the assistant's host) and its few lines of plain text.  Pure: the page and the assistant's loop read
// reports without carrying the kernel.

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

export interface PartSummary {
  units: "mm";
  bodies: {
    id: string; name: string; volume_mm3: number; bbox_mm: { min: number[]; max: number[]; size: number[] } | null;
    faces: { count: number; by_kind: { [kind: string]: number }; flat: { name: string; normal: number[]; area_mm2: number; openings: number }[] };
    holes: { diameter_mm: number; count: number }[];
    edges: number;
  }[];
}
