// dialogs/erc-report.ts — ERC_REPORT::GetTextReport and WriteJsonReport (eeschema/erc/erc_report.cpp), what the ERC
// dialog's "Save..." writes, and the severity filter the dialog's list and the reports share.
import { messageText } from "../../../shared/units";
import type { Units } from "../../../shared/store";

/** An item line of ShowReport: the item's own position and description ("%L" is a length, `len` mm, in the report units). */
export interface ReportItem { x: number; y: number; desc: string; len?: number; id?: string; uuid?: string }
export interface ReportMarker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; base?: string; comment?: string; items?: ReportItem[] }
/** The rule's own severity of a marker (an exclusion keeps it as base). */
export const sevOf = (m: ReportMarker): string => (m.severity === "exclusion" ? m.base || "warning" : m.severity);
/** RC_TREE_MODEL's filter: an exclusion shows only under Exclusions, the others by their severity. */
export function shownBy(m: ReportMarker, f: { errors: boolean; warnings: boolean; exclusions: boolean }): boolean {
  return m.severity === "exclusion" ? f.exclusions : m.severity === "error" ? f.errors : f.warnings;
}
/**
 * ERC_REPORT::GetTextReport for the markers the dialog shows (its provider's severities): the header, a
 * "***** Sheet <path>" block for every sheet in page order (`sheets`) holding the markers of its main item
 * (`sheetOf`, else the first sheet), each as RC_ITEM::ShowReport ("[key]: message\n    ; severity\n" then
 * "    @(x, y): description" for the main and the aux item, and an exclusion's comment), the counts and the ignored checks.
 */
export function ercTextReport(list: ReportMarker[], o: { errors: boolean; warnings: boolean; exclusions: boolean; units: Units; date: string; ignored: string[]; sheet?: string; sheets?: string[]; sheetOf?(m: ReportMarker): string | null; title(m: ReportMarker): string; text?(s: string): string }): string {
  const inc = [o.errors && "Errors", o.warnings && "Warnings", o.exclusions && "Exclusions"].filter(Boolean).join(", ") || "None";
  let msg = `ERC report (${o.date}, Encoding UTF8)\nReport includes: ${inc}\n`;
  let err = 0, warn = 0, total = 0;
  const coord = (v: number): string => messageText(v, o.units, "sch");
  const sheets = o.sheets && o.sheets.length ? o.sheets : [o.sheet || "/"];
  const bySheet = new Map<string, ReportMarker[]>(sheets.map((p) => [p, []]));
  for (const m of list.filter((x) => shownBy(x, o))) {
    const p = o.sheetOf ? o.sheetOf(m) : null;
    bySheet.get(p && bySheet.has(p) ? p : sheets[0])!.push(m);
  }
  for (const path of sheets) {
    msg += `\n***** Sheet ${path}\n`;
    for (const m of bySheet.get(path)!) {
      const sev = sevOf(m), excluded = m.severity === "exclusion"; total++; if (sev === "error") err++; else if (sev === "warning") warn++;
      msg += `[${m.code}]: ${o.title(m)}\n    ; ${sev}${excluded ? " (excluded)" : ""}\n`;
      const items: ReportItem[] = m.items && m.items.length ? m.items.slice(0, 2) : m.ids.length ? [{ x: m.x, y: m.y, desc: m.text }] : [];
      for (const it of items) {
        const desc = it.len !== undefined ? it.desc.replace("%L", messageText(it.len, o.units, "sch")) : it.desc;
        msg += `    @(${coord(it.x)}, ${coord(it.y)}): ${o.text ? o.text(desc) : desc}\n`;
      }
      if (excluded && m.comment) msg += `    ${m.comment}\n`;
    }
  }
  msg += `\n ** ERC messages: ${total}  Errors ${err}  Warnings ${warn}\n\n ** Ignored checks:\n`;
  msg += o.ignored.length ? o.ignored.map((t) => `    - ${t}\n`).join("") : "    - None\n";
  return msg;
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
/**
 * ERC_REPORT::WriteJsonReport for the markers the dialog shows: the erc.v1 schema's head, every sheet of the hierarchy
 * (`sheets`, each with its human path and KIID path) holding the violations of its main item's sheet (`sheetOf`, an
 * index into `sheets`, else the first), each as RC_ITEM::GetJsonViolation (the rule's own severity, the message, the
 * main and aux item with their uuid and position in the report units), and the ignored checks.
 */
export function ercJsonReport(list: ReportMarker[], o: { errors: boolean; warnings: boolean; exclusions: boolean; units: Units; date: string; source: string; kicadVersion: string;
  ignored: [string, string][]; sheets: { path: string; uuidPath: string }[]; sheetOf?(m: ReportMarker): number; title(m: ReportMarker): string; text?(s: string): string }): string {
  // EDA_UNIT_UTILS::UI::ToUserUnit( schIUScale, units, iu ): the position in IU (100 nm) over IU_PER_MM / IU_PER_MILS / IU_PER_INCH
  const IU_PER_MM = 1e4, IU_PER_MILS = IU_PER_MM * 0.0254, IU_PER_INCH = IU_PER_MILS * 1000;
  const user = (mm: number): number => { const iu = Math.round(mm * IU_PER_MM); return o.units === "in" ? iu / IU_PER_INCH : o.units === "mil" ? iu / IU_PER_MILS : iu / IU_PER_MM; };
  const sheets = (o.sheets.length ? o.sheets : [{ path: "/", uuidPath: "" }]).map((sh) => ({ path: sh.path, uuid_path: sh.uuidPath, violations: [] as unknown[] }));
  for (const m of list.filter((x) => shownBy(x, o))) {
    const k = o.sheetOf ? o.sheetOf(m) : 0, excluded = m.severity === "exclusion";
    const items = (m.items || []).slice(0, 2).map((it) => {
      const desc = it.len !== undefined ? it.desc.replace("%L", messageText(it.len, o.units, "sch")) : it.desc;
      return { description: o.text ? o.text(desc) : desc, pos: { x: user(it.x), y: user(it.y) }, uuid: it.uuid || it.id || "" };
    });
    sheets[k >= 0 && k < sheets.length ? k : 0].violations.push({ description: o.title(m), items, severity: sevOf(m), type: m.code, ...(excluded ? { excluded: true, comment: m.comment || "" } : {}) });
  }
  const included = [o.errors && "error", o.warnings && "warning", o.exclusions && "exclusion"].filter(Boolean);
  return dumpJson({ $schema: "https://schemas.kicad.org/erc.v1.json", source: o.source, date: o.date, kicad_version: o.kicadVersion, sheets,
    coordinate_units: o.units === "in" ? "in" : o.units === "mil" ? "mils" : "mm", included_severities: included, ignored_checks: o.ignored.map(([description, key]) => ({ key, description })) }) + "\n";
}

/**
 * The lines ERC_TESTER::RunTests reports through the dialog (PROGRESS_REPORTER::AdvancePhase), in order; a phase
 * guarded by its tests is left out when none of them is enabled.
 */
export function ercPhaseMessages(enabled: (code: string) => boolean): string[] {
  const any = (...codes: string[]): boolean => codes.some(enabled), out: string[] = [];
  if (any("duplicate_sheet_names")) out.push("Checking sheet names...");
  if (any("pin_map_stale_pin", "pin_map_duplicate_pad", "pin_map_bad_pad", "pin_map_unmapped_pin")) out.push("Checking pin maps...");
  out.push("Checking conflicts...", "Checking units...");
  if (any("different_unit_footprint")) out.push("Checking footprints...");
  out.push("Checking pins...");
  if (any("similar_labels", "similar_power", "similar_label_and_power")) out.push("Checking similar labels...");
  if (any("same_local_global_label", "same_local_global_power")) out.push("Checking local and global labels...");
  if (any("unresolved_variable")) out.push("Checking for unresolved variables...");
  if (any("field_name_whitespace")) out.push("Checking field names...");
  if (any("empty_power_value")) out.push("Checking for empty power symbol values...");
  if (any("empty_label_name")) out.push("Checking for empty label names...");
  if (any("simulation_model_issue")) out.push("Checking SPICE models...");
  if (any("no_connect_connected")) out.push("Checking no connect pins for connections...");
  if (any("lib_symbol_issues", "lib_symbol_mismatch")) out.push("Checking for library symbol issues...");
  if (any("footprint_link_issues")) out.push("Checking for footprint link issues...");
  if (any("footprint_filter")) out.push("Checking footprint assignments against footprint filters...");
  if (any("endpoint_off_grid")) out.push("Checking for off grid pins and wires...");
  if (any("four_way_junction")) out.push("Checking for four way junctions...");
  if (any("label_multiple_wires")) out.push("Checking for labels on more than one wire...");
  if (any("undefined_netclass")) out.push("Checking for undefined netclasses...");
  if (any("variant_symbol_invalid", "variant_symbol_incompatible")) out.push("Checking variant symbols...");
  return out;
}
