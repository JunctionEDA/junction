// cutlist.ts — the cut list of frames: their members, gussets and end caps grouped by what they are, how long
// and how they are cut, with how many of each; and the same as CSV.
import type { FrameItem } from "./frame";

export interface CutRow { item: number; qty: number; description: string; kind: string; length: number; angle1: number; angle2: number; bodies: string[] }

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Group frame items into rows: one per profile, length (to 0.1 mm) and pair of end angles (to 0.1°). */
export function cutRows(items: readonly FrameItem[], nameOf: (body: string) => string): CutRow[] {
  const rows = new Map<string, CutRow>();
  for (const it of items) {
    const a = [r1(it.angles[0]), r1(it.angles[1])].sort((x, y) => x - y);
    const key = `${it.kind}|${it.label}|${r1(it.length)}|${a.join(",")}`;
    const row = rows.get(key);
    if (row) { row.qty++; row.bodies.push(nameOf(it.body)); continue; }
    rows.set(key, { item: 0, qty: 1, description: it.label, kind: it.kind, length: r1(it.length), angle1: a[0], angle2: a[1], bodies: [nameOf(it.body)] });
  }
  const order = { member: 0, gusset: 1, "end cap": 2 } as { [k: string]: number };
  return Array.from(rows.values()).sort((x, y) => (order[x.kind] ?? 9) - (order[y.kind] ?? 9) || x.description.localeCompare(y.description) || y.length - x.length).map((r, i) => ({ ...r, item: i + 1 }));
}

const csvCell = (v: string | number): string => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
/** The rows as CSV, lengths in `unit` (mm unless told). */
export function cutCsv(rows: readonly CutRow[], unit = "mm", perMm = 1): string {
  const head = ["Item", "Qty", "Description", "Type", `Length (${unit})`, "Angle 1 (deg)", "Angle 2 (deg)", "Parts"];
  const lines = [head, ...rows.map((r) => [r.item, r.qty, r.description, r.kind, Math.round((r.length / perMm) * 1e4) / 1e4, r.angle1, r.angle2, r.bodies.join("; ")])];
  return lines.map((l) => l.map(csvCell).join(",")).join("\n") + "\n";
}
