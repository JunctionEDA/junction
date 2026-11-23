// pcb-tools/inspect-constraints.ts — BOARD_INSPECTION_TOOL::InspectConstraints and reportClearance
// (pcbnew/tools/board_inspection_tool.cpp) over DRC_ENGINE::EvalRules with a reporter (inspect-resolve.ts): the
// pages of the Constraints Report for any one item (Track Width, Via Diameter, Via Annular Width, Hole Size, Solder
// Mask, Solder Paste, Text Size, Keepouts, Assertions) and of the Clearance Report for two (Zone, the clearance per
// copper layer, Diff Pair, silkscreen, courtyard, Hole, Edge.Cuts / Margin Clearance, Physical Clearances).
import type { BoardDoc, DesignSettings } from "./types";
import { S } from "./state";
import { clearanceReport, constraintsReport, type ReportPage } from "./inspect-resolve";

type Fmt = (mm: number) => string;
const DEFAULT_FMT: Fmt = (v) => `${+v.toFixed(4)} mm`;
/** The custom rules as DRC_ENGINE compiled them, and whether they compiled (makeDRCEngine's aCompileError). */
const compiled = (): { rules: NonNullable<typeof S.dru>["rules"]; error: boolean } => {
  const d = S.dru as (typeof S.dru & { messages?: { fatal?: boolean }[] }) | null | undefined;
  return { rules: d ? d.rules : [], error: !!(d && (d.errors.length || (d.messages || []).some((m) => m.fatal))) };
};

/** The Constraints Report's pages for the item `id` (a pad as "fpId#index", a field as "fpId@field:Name"), or null. */
export function inspectConstraints(doc: BoardDoc, id: string, s: DesignSettings, fmt: Fmt = DEFAULT_FMT, units = "mm"): ReportPage[] | null {
  const c = compiled();
  return constraintsReport({ doc, s, rules: c.error ? [] : c.rules, fmt, units }, id, c.error);
}
/** The Clearance Report's pages for two items, or { error } (the infobar error), or null. */
export function inspectClearanceReport(doc: BoardDoc, a: string, b: string, s: DesignSettings, active: string, fmt: Fmt = DEFAULT_FMT, units = "mm") {
  const c = compiled();
  return clearanceReport({ doc, s, rules: c.error ? [] : c.rules, fmt, units }, a, b, active, c.error);
}
