// pcbdialogs/drc-report.ts — the parts of DIALOG_DRC (pcbnew/dialogs/dialog_drc.cpp) that are plain data: the row text
// (RC_TREE_MODEL::GetValue), the list order (DRC_ITEMS_PROVIDER::SetSeverities), the tab titles and badges
// (updateDisplayedCounts), the elapsed-time tick, the violation's layer (DRC_ITEM::GetViolationLayers) and the saved
// report (DRC_REPORT::WriteTextReport / WriteJsonReport with RC_ITEM::ShowReport / GetJsonViolation).
import { messageText } from "../../../../shared/units";
import type { Units } from "../../../../shared/store";

export interface DrcRowMarker { code: string; severity: string; text: string; excluded?: boolean; comment?: string; layer?: string; x: number; y: number }
/** An item a marker names, as the report writes it: its own position (GetPosition) and description. */
export interface DrcReportItem { x: number; y: number; desc: string; uuid?: string }

/** RC_TREE_MODEL::GetValue for a marker row: "Error: ", "Warning: ", "Excluded error: " or "Excluded warning: " and the message. */
export function rowText(m: DrcRowMarker, base: string): string {
  const pre = m.excluded ? (base === "warning" ? "Excluded warning: " : "Excluded error: ") : m.severity === "warning" ? "Warning: " : "Error: ";
  return pre + m.text;
}
/** DRC_ITEMS_PROVIDER::SetSeverities: a stable sort on GetSeverity, highest first (errors, warnings, then exclusions). */
export function listOrder(list: DrcRowMarker[]): number[] {
  const rank = (m: DrcRowMarker) => (m.excluded ? 2 : m.severity === "error" ? 0 : m.severity === "warning" ? 1 : 2);
  return list.map((_, i) => i).sort((a, b) => rank(list[a]) - rank(list[b]) || a - b);
}

/**
 * updateDisplayedCounts' tab titles: the templates without "(%s)" before a run; after it the counts, "N+" when a code of
 * the tab hit its error limit among the shown severities; "Schematic Parity (not run)" when the parity tests did not run;
 * "Ignored Tests (N)" once DRC ran.
 */
export function tabTitles(o: { ran: boolean; parityRan: boolean; counts: [number, number, number]; overflow: [boolean, boolean, boolean]; ignored: number }): string[] {
  const n = (i: number) => `${o.counts[i]}${o.overflow[i] ? "+" : ""}`;
  return [
    o.ran ? `Violations (${n(0)})` : "Violations ",
    o.ran ? `Unconnected Items (${n(1)})` : "Unconnected Items ",
    o.parityRan ? `Schematic Parity (${n(2)})` : o.ran ? "Schematic Parity (not run)" : "Schematic Parity ",
    o.ran ? `Ignored Tests (${o.ignored})` : "Ignored Tests ",
  ];
}
/**
 * NUMBER_BADGE::UpdateNumber for the Errors / Warnings / Exclusions badges: hidden ("") for a negative number (not run
 * and none) and for zero exclusions, "N+" when the count overflowed its maximum.
 */
export function badgeText(kind: "error" | "warning" | "exclusion", count: number, ran: boolean, overflowed = false): string {
  if (!ran && count === 0 && kind !== "exclusion") return "";
  if (count === 0 && kind === "exclusion") return "";
  return overflowed ? `${count}+` : String(count);
}
/** Which tab's codes overflowed, from the per-code error limit and the shown severities (updateDisplayedCounts). */
export function overflowedTabs(markers: { code: string }[], tabOf: (code: string) => number, limit: (code: string) => number, severityOf: (code: string) => string, show: { errors: boolean; warnings: boolean }): { tabs: [boolean, boolean, boolean]; errors: boolean; warnings: boolean } {
  const per = new Map<string, number>(); for (const m of markers) per.set(m.code, (per.get(m.code) || 0) + 1);
  const tabs: [boolean, boolean, boolean] = [false, false, false]; let errors = false, warnings = false;
  for (const [code, n] of per) {
    if (n < limit(code)) continue;
    const sev = severityOf(code);
    if (sev === "error") errors = true; else if (sev === "warning") warnings = true;
    if ((show.warnings && sev === "warning") || (show.errors && sev === "error")) tabs[tabOf(code)] = true;
  }
  return { tabs, errors, warnings };
}
/** The status bar's tick: "Elapsed: N s", from a minute on "Elapsed: M min S s" (whole seconds). */
export function elapsedTick(ms: number): string { const t = Math.floor(ms / 1000); return `Elapsed: ${t >= 60 ? `${Math.floor(t / 60)} min ${t % 60} s` : `${t} s`}`; }

/**
 * DRC_ITEM::GetViolationLayers' principal layer: a malformed courtyard's courtyard side, Edge.Cuts for invalid_outline
 * and copper_edge_clearance, else the marker's layer, else the first layer shared by every item (`itemLayers`, each
 * item's layers in board order), else the first item layer found.
 */
export function principalLayer(m: { code: string; layer?: string }, itemLayers: string[][], backCourtyardOnly = false): string | null {
  if (m.code === "malformed_courtyard") return backCourtyardOnly ? "B.CrtYd" : "F.CrtYd";
  if (m.code === "invalid_outline" || m.code === "copper_edge_clearance") return "Edge.Cuts";
  if (m.layer) return m.layer;
  const lists = itemLayers.filter((l) => l.length);
  if (!lists.length) return null;
  const common = lists[0].filter((l) => lists.every((x) => x.includes(l)));
  return common.length ? common[0] : lists[0][0];
}

/** wxDateTime::Now().FormatISOCombined( 'T' ): local time, no zone. */
export function isoNow(d = new Date()): string { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
/** formatSeverities: "Errors, Warnings, Exclusions", or "None". */
export function formatSeverities(f: { errors: boolean; warnings: boolean; exclusions: boolean }): string {
  return [f.errors && "Errors", f.warnings && "Warnings", f.exclusions && "Exclusions"].filter(Boolean).join(", ") || "None";
}

export interface DrcReportInput<M extends DrcRowMarker> {
  /** the three tabs' markers as the dialog lists them (already filtered by the shown severities and sorted) */
  violations: M[]; unconnected: M[]; parity: M[];
  show: { errors: boolean; warnings: boolean; exclusions: boolean };
  units: Units; date: string; file: string; kicadVersion?: string;
  /** BOARD_DESIGN_SETTINGS::GetSeverity of a code (an exclusion reports the code's severity) */
  severityOf(code: string): string;
  /** the main and aux item (at most two) */
  items(m: M): DrcReportItem[];
  /** GetViolatingRuleDesc: "Rule: <name>" or "Local override" */
  ruleDesc(m: M): string;
  /** the ignored tests: [title, settings key] */
  ignored: [string, string][];
  /** BOARD::GetLayerName (the board's user name of a layer) */
  layerName?(layer: string): string;
}
/** The severity the report gives: a violation's marker severity (the board setting when excluded); an unconnected or
 * parity item always the board setting (bds.GetSeverity( code )). */
const sevOf = <M extends DrcRowMarker>(o: DrcReportInput<M>, m: M, marker = true) => (marker && !m.excluded ? m.severity : o.severityOf(m.code));
/** DRC_REPORT::WriteTextReport. */
export function drcTextReport<M extends DrcRowMarker>(o: DrcReportInput<M>): string {
  const coord = (v: number) => messageText(v, o.units, "pcb");
  const show = (m: M, marker = true): string => {
    const sev = sevOf(o, m, marker) + (m.excluded ? " (excluded)" : "");
    let msg = `[${m.code}]: ${m.text}\n    ${o.ruleDesc(m)}; ${sev}\n`;
    for (const it of o.items(m).slice(0, 2)) msg += `    @(${coord(it.x)}, ${coord(it.y)}): ${it.desc}\n`;
    if (m.excluded && m.comment) msg += `    ${m.comment}\n`;
    return msg;
  };
  let out = `** Drc report for ${o.file} **\n** Created on ${o.date} **\n** Report includes: ${formatSeverities(o.show)} **\n`;
  out += `\n** Found ${o.violations.length} DRC violations **\n` + o.violations.map((m) => show(m)).join("");
  out += `\n** Found ${o.unconnected.length} unconnected pads **\n` + o.unconnected.map((m) => show(m, false)).join("");
  out += `\n** Found ${o.parity.length} Footprint errors **\n` + o.parity.map((m) => show(m, false)).join("");
  out += "\n** Ignored checks **\n" + (o.ignored.length ? o.ignored.map(([t]) => `    - ${t}\n`).join("") : "    - None\n");
  return out + "\n** End of Report **\n";
}
/** nlohmann::json's dump( 4 ): object keys in order (std::map), four spaces, a double always with its decimal point. */
function dumpJson(v: unknown, pad = ""): string {
  if (typeof v === "number") { const t = String(v); return /[.eE]/.test(t) || !isFinite(v) ? t : t + ".0"; }
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  const inner = pad + "    ";
  if (Array.isArray(v)) return v.length ? "[\n" + v.map((x) => inner + dumpJson(x, inner)).join(",\n") + "\n" + pad + "]" : "[]";
  const keys = Object.keys(v as object).sort();
  return keys.length ? "{\n" + keys.map((k) => inner + JSON.stringify(k) + ": " + dumpJson((v as Record<string, unknown>)[k], inner)).join(",\n") + "\n" + pad + "}" : "{}";
}
/** DRC_REPORT::WriteJsonReport (the drc.v1 schema), each violation as GetJsonViolation plus the marker's layer / position. */
export function drcJsonReport<M extends DrcRowMarker>(o: DrcReportInput<M>): string {
  const user = (mm: number): number => { const v = Math.round(mm * 1e6) / 1e6; return o.units === "in" ? v / 25.4 : o.units === "mil" ? v / 0.0254 : v; };
  const viol = (m: M, marker = true) => {
    const v: Record<string, unknown> = { type: m.code, description: m.text, severity: sevOf(o, m, marker),
      items: o.items(m).slice(0, 2).map((it) => ({ uuid: it.uuid || "", description: it.desc, pos: { x: user(it.x), y: user(it.y) } })) };
    // setMarkerLocation: the layer when the marker has one, the position unless it is the origin without a layer
    if (m.layer) v.layer = o.layerName ? o.layerName(m.layer) : m.layer;
    if (m.layer || m.x || m.y) v.pos = { x: user(m.x), y: user(m.y) };
    if (m.excluded) { v.excluded = true; v.comment = m.comment || ""; }
    return v;
  };
  const included = [o.show.errors && "error", o.show.warnings && "warning", o.show.exclusions && "exclusion"].filter(Boolean);
  return dumpJson({ $schema: "https://schemas.kicad.org/drc.v1.json", source: o.file, date: o.date, kicad_version: o.kicadVersion || "",
    violations: o.violations.map((m) => viol(m)), unconnected_items: o.unconnected.map((m) => viol(m, false)), schematic_parity: o.parity.map((m) => viol(m, false)),
    coordinate_units: o.units === "in" ? "in" : o.units === "mil" ? "mils" : "mm", included_severities: included,
    ignored_checks: o.ignored.map(([description, key]) => ({ key, description })) }) + "\n";
}
