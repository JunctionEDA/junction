// dialogs/erc-rules.ts — ERC_ITEM::allItemTypes (eeschema/erc/erc_item.cpp): the rule titles in dialog order with their
// .kicad_pro keys (erc.rule_severities), headings as one-element rows, and ERC_SETTINGS' default severities.
export type Severity = "error" | "warning" | "ignore";
export const ERC_RULES: ([string] | [string, string])[] = [["Connections"], ["Pin not connected", "pin_not_connected"], ["Input pin not driven by any Output pins", "pin_not_driven"], ["Input Power pin not driven by any Output Power pins", "power_pin_not_driven"],
  ["A pin with a \"no connection\" flag is connected", "no_connect_connected"], ["Unconnected \"no connection\" flag", "no_connect_dangling"], ["Label not connected", "label_dangling"], ["Label connected to only one pin", "isolated_pin_label"],
  ["Global label only appears once in the schematic", "single_global_label"], ["Local and global labels have same name", "same_local_global_label"], ["Local and global power symbols have same name", "same_local_global_power"],
  ["Wires not connected to anything", "wire_dangling"], ["Bus Entry needed", "bus_entry_needed"], ["Symbol pin or wire end off connection grid", "endpoint_off_grid"], ["Four connection points are joined together", "four_way_junction"],
  ["Label connects more than one wire", "label_multiple_wires"], ["Unconnected wire endpoint", "unconnected_wire_endpoint"], ["Label has an empty name", "empty_label_name"], ["Power symbol has an empty value", "empty_power_value"],
  ["Wired hidden power input pin also connects globally by name", "wired_implicit_power"],
  ["Conflicts"], ["Duplicate reference designators", "duplicate_reference"], ["Conflict problem between pins", "pin_to_pin"], ["Units of same symbol have different values", "unit_value_mismatch"],
  ["Different footprint assigned in another unit of the symbol", "different_unit_footprint"], ["Different net assigned to a shared pin in another unit of the symbol", "different_unit_net"], ["Duplicate sheet names within a given sheet", "duplicate_sheet_names"], ["Reused sheets have the same reference suffix", "duplicate_sheet_suffix"],
  ["Mismatch between hierarchical labels and sheet pins", "hier_label_mismatch"], ["More than one name given to this bus or net", "multiple_net_names"], ["Conflict between bus alias definitions across schematic sheets", "bus_definition_conflict"],
  ["Buses are graphically connected but share no bus members", "bus_to_bus_conflict"], ["Invalid connection between bus and net items", "bus_to_net_conflict"], ["Net is graphically connected to a bus but not a bus member", "net_not_bus_member"],
  ["Ground pin not connected to ground net", "ground_pin_not_ground"],
  ["Miscellaneous"], ["Pin name resembles stacked pin", "stacked_pin_name"], ["Field name has leading or trailing whitespace", "field_name_whitespace"], ["Pin map references a pad that does not exist on the footprint", "pin_map_bad_pad"],
  ["Connected pin is not mapped to any footprint pad", "pin_map_unmapped_pin"], ["Two symbol pins are mapped to the same footprint pad", "pin_map_duplicate_pad"], ["Pin map references a pin number that no longer exists on the symbol", "pin_map_stale_pin"],
  ["Symbol is not annotated", "unannotated"], ["Reference does not match its reused sheet", "ref_suffix_mismatch"], ["Unresolved text variable", "unresolved_variable"], ["Undefined netclass", "undefined_netclass"], ["SPICE model issue", "simulation_model_issue"], ["Labels are similar", "similar_labels"],
  ["Power pins are similar", "similar_power"], ["Power pin and label are similar", "similar_label_and_power"], ["Library symbol issue", "lib_symbol_issues"], ["Symbol doesn't match copy in library", "lib_symbol_mismatch"],
  ["Footprint link issue", "footprint_link_issues"], ["Assigned footprint doesn't match footprint filters", "footprint_filter"], ["Symbol has more units than are defined", "extra_units"], ["Symbol has units that are not placed", "missing_unit"],
  ["Symbol has input pins that are not placed", "missing_input_pin"], ["Symbol has bidirectional pins that are not placed", "missing_bidi_pin"], ["Symbol has power input pins that are not placed", "missing_power_pin"],
  ["Variant symbol not found in libraries", "variant_symbol_invalid"], ["Variant symbol is not pin-compatible", "variant_symbol_incompatible"]];
const WARN = ["endpoint_off_grid", "similar_labels", "similar_power", "similar_label_and_power", "same_local_global_label", "same_local_global_power", "ground_pin_not_ground", "isolated_pin_label", "multiple_net_names", "net_not_bus_member",
  "lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues", "no_connect_connected", "no_connect_dangling", "missing_unit", "missing_input_pin", "missing_bidi_pin", "label_multiple_wires", "unconnected_wire_endpoint",
  "stacked_pin_name", "field_name_whitespace", "pin_map_unmapped_pin", "pin_map_stale_pin", "variant_symbol_incompatible", "wired_implicit_power", "ref_suffix_mismatch"];
const IGNORE = ["single_global_label", "footprint_filter", "simulation_model_issue", "four_way_junction"];
export function defaultSeverity(code: string): Severity { return IGNORE.includes(code) ? "ignore" : WARN.includes(code) ? "warning" : "error"; }
/** ERC_ITEM's titles of the codes with no row of their own (ERC_ITEM::duplicatePins, genericWarning, genericError): no
 *  user-editable severity (ERC_SETTINGS::GetSeverity: duplicate pins are always an error). */
export const ERC_INTERNAL_TITLES: Record<string, string> = { duplicate_pins: "Duplicate pins with different nets", "generic-warning": "Warning", "generic-error": "Error" };
/** ERC_ITEM::GetErrorText of a code: its row's title, an internal one, or "" when the code is unknown. */
export function ercRuleTitle(code: string): string {
  for (const r of ERC_RULES) if (r.length === 2 && r[1] === code) return r[0];
  return ERC_INTERNAL_TITLES[code] || "";
}
/** The rules a severity map sets to Ignore, in dialog order, as [title, key] (DIALOG_ERC's m_ignoredList at Run ERC). */
export function ignoredRules(severities: Record<string, unknown> | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const r of ERC_RULES) if (r.length === 2) { const s = severities && typeof severities[r[1]] === "string" ? String(severities[r[1]]) : defaultSeverity(r[1]); if (s === "ignore") out.push([r[0], r[1]]); }
  return out;
}
/** RC_TREE_MODEL's marker row prefix (ERC_TREE_MODEL::GetValue): the rule's severity, "Excluded …" for an exclusion. */
export function markerPrefix(m: { severity: string; base?: string }): string {
  if (m.severity === "exclusion") return (m.base || "warning") === "warning" ? "Excluded warning: " : "Excluded error: ";
  return m.severity === "warning" ? "Warning: " : "Error: ";
}
/** SHEETLIST_ERC_ITEMS_PROVIDER::SetSeverities' std::stable_sort: errors, then warnings, then exclusions over the whole list. */
export function sortBySeverity<T extends { severity: string }>(list: T[]): T[] {
  const rank = (m: T): number => (m.severity === "error" ? 0 : m.severity === "warning" ? 1 : 2);
  return list.map((m, i) => [m, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([m]) => m);
}
/** visitMarkers' order within one sheet: by x, then y, then the message. */
export function sheetOrder<T extends { x: number; y: number; text?: string }>(list: T[]): T[] {
  return list.map((m, i) => [m, i] as const).sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y || (String(a[0].text || "") < String(b[0].text || "") ? -1 : String(a[0].text || "") > String(b[0].text || "") ? 1 : 0) || a[1] - b[1]).map(([m]) => m);
}
/** A screen rectangle in pixels. */
export interface ScreenRect { x: number; y: number; w: number; h: number }
/**
 * EDA_DRAW_FRAME::FocusOnLocation's decision and VIEW::SetCenter( centre, obscuringScreenRects ): the view moves only
 * when the point (canvas pixels) is outside the viewport shrunk by a tenth of its width, or under a dialog grown by a
 * tenth of its width.  It then goes to the centre of the largest area the dialogs leave free: the screen less the
 * dialogs, deflated step by step (a tenth of its smaller side, 20 px at least) until nothing is left; the last
 * bounding box's centre.  Returns that screen point, or null when the view stays.
 */
export function focusScreenPoint(pt: [number, number], screen: { w: number; h: number }, dialogs: ScreenRect[]): [number, number] | null {
  const inside = (r: ScreenRect, d: number): boolean => pt[0] >= r.x - d && pt[0] <= r.x + r.w + d && pt[1] >= r.y - d && pt[1] <= r.y + r.h + d;
  let centre = !inside({ x: 0, y: 0, w: screen.w, h: screen.h }, -screen.w / 10);
  for (const r of dialogs) if (inside(r, r.w / 10)) centre = true;
  if (!centre) return null;
  if (!dialogs.length) return [screen.w / 2, screen.h / 2];
  // the bounding box of the screen deflated by d less the dialogs inflated by d (a mitred offset of the difference)
  const bbox = (d: number): [number, number, number, number] | null => {
    const x0 = d, y0 = d, x1 = screen.w - d, y1 = screen.h - d; if (x1 <= x0 || y1 <= y0) return null;
    const cut = dialogs.map((r) => [Math.max(x0, r.x - d), Math.max(y0, r.y - d), Math.min(x1, r.x + r.w + d), Math.min(y1, r.y + r.h + d)]).filter((r) => r[2] > r[0] && r[3] > r[1]);
    const xs = Array.from(new Set([x0, x1, ...cut.flatMap((r) => [r[0], r[2]])])).sort((a, b) => a - b), ys = Array.from(new Set([y0, y1, ...cut.flatMap((r) => [r[1], r[3]])])).sort((a, b) => a - b);
    let out: [number, number, number, number] | null = null;
    for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
      if (cut.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3])) continue;
      out = out ? [Math.min(out[0], xs[i]), Math.min(out[1], ys[j]), Math.max(out[2], xs[i + 1]), Math.max(out[3], ys[j + 1])] : [xs[i], ys[j], xs[i + 1], ys[j + 1]];
    }
    return out;
  };
  const first = bbox(0); let at: [number, number] = [screen.w / 2, screen.h / 2];
  if (!first) return at;
  const step = Math.max(20, Math.floor(Math.min(first[2] - first[0], first[3] - first[1]) / 10));
  for (let d = 0, b: [number, number, number, number] | null = first; b; d += step, b = bbox(d)) at = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  return at;
}
/** NUMBER_BADGE::UpdateNumber: nothing below zero (not run and no markers), "999+" style cap at the badge's maximum. */
export function badgeText(count: number, ercRun: boolean, max = 999): string { return count === 0 && !ercRun ? "" : count > max ? `${max}+` : String(count); }
/** ERC_SETTINGS::m_defaultPinMap: 0 ok, 1 warning, 2 error (rows / columns in PIN_TYPE_NAMES order). */
export const DEFAULT_PIN_MAP: number[][] = [
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2], [0, 1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2], [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2],
  [0, 2, 1, 2, 0, 0, 1, 0, 2, 2, 2, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 0, 0, 2], [0, 2, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2], [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]];
export const PIN_TYPE_NAMES = ["Input Pin", "Output Pin", "Bidirectional Pin", "Tri-State Pin", "Passive Pin", "Free Pin", "Unspecified Pin", "Power Input Pin", "Power Output Pin", "Open Collector", "Open Emitter", "No Connection"];
export interface ErcMarker { code: string; severity: string }
/** Apply the project's rule severities to a marker list: ignored rules drop out, the rest take the configured level. pin_to_pin keeps
 *  the level the conflicts map gave it; the project's "pin_to_pin" key is ERCE_PIN_TO_PIN_WARNING's (ERC_SETTINGS loads
 *  GetItemsWithSeverities, which holds pinTableWarning), so "ignore" drops the warnings only. */
export function applySeverities<T extends ErcMarker>(markers: T[], severities: Record<string, unknown> | null | undefined): T[] {
  const out: T[] = [];
  for (const m of markers) {
    const s = severities && typeof severities[m.code] === "string" ? String(severities[m.code]) : defaultSeverity(m.code);
    if (s === "ignore" && (m.code !== "pin_to_pin" || m.severity === "warning")) continue;
    out.push(m.code === "pin_to_pin" || (s !== "error" && s !== "warning") ? m : Object.assign({}, m, { severity: s }));
  }
  return out;
}

/**
 * RC_TREE_MODEL::PrevMarker / NextMarker over the listed rows: Next with nothing picked takes the first, Prev the last;
 * at either end nothing changes.  Returns the row to pick, or null.
 */
export function stepMarker(shown: number[], current: number, dir: 1 | -1): number | null {
  const pos = shown.indexOf(current);
  if (dir > 0) { const n = pos < 0 ? shown[0] : shown[pos + 1]; return n === undefined ? null : n; }
  const p = pos < 0 ? shown[shown.length - 1] : shown[pos - 1]; return p === undefined ? null : p;
}
