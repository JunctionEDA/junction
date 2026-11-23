// canvas/format-version.ts — the s-expression file format versions of this KiCad tree and the scan that tells which
// version a written body needs (common/io/kicad/kicad_io_utils.cpp: the token tables, MinimumFileFormatVersion,
// WritingOlderThan), so a writer that keeps a file at the version it was read at raises the stamp only when the body
// needs it, as SCH_IO_KICAD_SEXPR / PCB_IO_KICAD_SEXPR / SCH_IO_KICAD_SEXPR_LIB_CACHE do.
import { KICAD_BASE_VERSION } from "./version";

/** eeschema/sch_file_versions.h */
export const SEXPR_SCHEMATIC_FILE_VERSION = 20261106;
export const SEXPR_SYMBOL_LIB_FILE_VERSION = 20261106;
/** pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h */
export const SEXPR_BOARD_FILE_VERSION = 20261031;
export const SEXPR_FOOTPRINT_LIB_FILE_VERSION = 20261031;
/** The first version whose footprint files are written as (kicad_footprint_lib (version …) … (footprint …)). */
export const SEXPR_FOOTPRINT_LIB_HEADER_VERSION = 20261028;
/** GetMajorMinorVersion(): what every writer puts in (generator_version …). */
export const GENERATOR_VERSION = KICAD_BASE_VERSION.split(".").slice(0, 2).join(".");

export type FormatDomain = "sch" | "symlib" | "pcb";
/** The file version a new document of each kind is written at (preservableVersion() 0: the current one). */
export const CURRENT_VERSION: Record<FormatDomain, number> = { sch: SEXPR_SCHEMATIC_FILE_VERSION, symlib: SEXPR_SYMBOL_LIB_FILE_VERSION, pcb: SEXPR_BOARD_FILE_VERSION };
/** The (generator …) each writer puts in its header. */
export const GENERATOR: Record<FormatDomain | "fplib", string> = { sch: "eeschema", symlib: "kicad_symbol_editor", pcb: "pcbnew", fplib: "kicad_footprint_editor" };

// The tables of kicad_io_utils.cpp, entry for entry (makeTable keeps the first of a repeated token).
const SCHEMATIC_TOKEN_VERSIONS = new Map<string, number>([
  ["paper", 20200512], ["in_bom", 20200602], ["on_board", 20200608], ["diameter", 20200618], ["default", 20200828],
  ["footprint", 20200828], ["iref", 20200828], ["value", 20200828], ["free", 20201015], ["sheet_instances", 20201015],
  ["field", 20210126], ["fields_autoplaced", 20210126], ["diamond", 20220103], ["netclass_flag", 20220103],
  ["face", 20220104], ["line_spacing", 20220104], ["directive_label", 20220124], ["private", 20220126],
  ["text_box", 20220126], ["default_instance", 20220404], ["href", 20220822], ["show_name", 20220822],
  ["do_not_autoplace", 20220904], ["unit_name", 20220904], ["dnp", 20220914], ["project", 20220919],
  ["exclude_from_sim", 20230409], ["from", 20230409], ["border", 20240101], ["cells", 20240101], ["cols", 20240101],
  ["column_count", 20240101], ["column_widths", 20240101], ["external", 20240101], ["header", 20240101],
  ["margins", 20240101], ["row_heights", 20240101], ["rows", 20240101], ["separators", 20240101], ["span", 20240101],
  ["table", 20240101], ["table_cell", 20240101], ["rule_area", 20240417], ["checksum", 20240620],
  ["embedded_files", 20240620], ["embedded_fonts", 20240620], ["file", 20240620], ["cross_hatch", 20250222],
  ["hatch", 20250222], ["reverse_hatch", 20250222], ["local", 20250227],
  ["duplicate_pin_numbers_are_jumpers", 20250227], ["group", 20250318], ["jumper_pin_groups", 20250227],
  ["body_style", 20250827], ["body_styles", 20250827], ["demorgan", 20250827], ["variant", 20250922],
  ["in_pos_files", 20251028], ["locked", 20260326], ["ellipse", 20260508], ["ellipse_arc", 20260508],
  ["end_angle", 20260508], ["major_radius", 20260508], ["minor_radius", 20260508], ["rotation_angle", 20260508],
  ["start_angle", 20260508], ["net_chain", 20260512], ["net_class", 20260512], ["nets", 20260512],
  ["passthrough", 20260512], ["associated_footprints", 20260629], ["delegate", 20260629], ["edit", 20260629],
  ["identity", 20260629], ["library_default", 20260629], ["mode", 20260629], ["named_map", 20260629],
  ["pin_map", 20260629], ["pin_map_override", 20260629], ["pin_maps", 20260629], ["symbol_override", 20260722],
  ["arrow", 20260818], ["arrow_open", 20260818], ["end_shape", 20260818], ["square", 20260818],
  ["start_shape", 20260818], ["custom_property", 20261106], ["opacity", 20261025], ["rotate", 20261025],
]);
const SYMBOL_LIB_TOKEN_VERSIONS = new Map<string, number>([
  ["face", 20220102], ["line_spacing", 20220102], ["private", 20220126], ["text_box", 20220126],
  ["do_not_autoplace", 20220331], ["href", 20220331], ["show_name", 20220331], ["exclude_from_sim", 20220914],
  ["unit_name", 20220914], ["generator_version", 20231120], ["checksum", 20240529], ["embedded_files", 20240529],
  ["embedded_fonts", 20231120], ["file", 20240529], ["cross_hatch", 20241209], ["hatch", 20241209],
  ["reverse_hatch", 20241209], ["body_style", 20250324], ["body_styles", 20250324], ["demorgan", 20250324],
  ["duplicate_pin_numbers_are_jumpers", 20250324], ["group", 20250324], ["jumper_pin_groups", 20250324],
  ["in_pos_files", 20251024], ["locked", 20251024], ["ellipse", 20260508], ["ellipse_arc", 20260508],
  ["end_angle", 20260508], ["major_radius", 20260508], ["minor_radius", 20260508], ["rotation_angle", 20260508],
  ["start_angle", 20260508], ["associated_footprints", 20260629], ["delegate", 20260629], ["edit", 20260629],
  ["entry", 20260629], ["identity", 20260629], ["library_default", 20260629], ["map", 20260629], ["mode", 20260629],
  ["named_map", 20260629], ["pin_map", 20260629], ["pin_map_override", 20260629], ["pin_maps", 20260629],
  ["arrow", 20260710], ["arrow_open", 20260710], ["end_shape", 20260710], ["square", 20260710],
  ["start_shape", 20260710], ["custom_property", 20261106],
]);
const BOARD_TOKEN_VERSIONS = new Map<string, number>([
  ["cells", 20240202], ["cols", 20240202], ["column_count", 20240202], ["column_widths", 20240202],
  ["external", 20240202], ["header", 20240202], ["margins", 20240202], ["row_heights", 20240202], ["rows", 20240202],
  ["separators", 20240202], ["span", 20240202], ["table", 20240202], ["table_cell", 20240202], ["back", 20240609],
  ["front", 20240609], ["tenting", 20240609], ["embedded_files", 20240706], ["embedded_fonts", 20240706],
  ["placement", 20240706], ["component_class", 20240928], ["component_classes", 20240928],
  ["front_inner_back", 20240929], ["padstack", 20240929], ["shape", 20240929], ["creepage", 20241010],
  ["arrow_direction", 20241030], ["inward", 20241030], ["outward", 20241030], ["curved_edges", 20241228],
  ["cross_hatch", 20250222], ["reverse_hatch", 20250222], ["capping", 20250228], ["covering", 20250228],
  ["filling", 20250228], ["plugging", 20250228], ["hatch_position", 20241229], ["zone_defaults", 20250302],
  ["duplicate_pad_numbers_are_jumpers", 20250309], ["jumper_pad_groups", 20250309], ["num", 20250324],
  ["die_delay", 20250401], ["lib_id", 20250513], ["start_end_only", 20250801], ["pins", 20250909],
  ["barcode", 20250914], ["ecc_level", 20250914], ["text_height", 20250914], ["back_post_machining", 20251101],
  ["backdrill", 20251101], ["counterbore", 20251101], ["countersink", 20251101], ["depth", 20251101],
  ["front_post_machining", 20251101], ["post_machining", 20251101], ["tertiary_drill", 20251101],
  ["description", 20260101], ["field", 20260101], ["variant", 20260101], ["variants", 20260101],
  ["body_pcb_gap", 20260410], ["extruded", 20260410], ["overall_height", 20260410], ["end_angle", 20260508],
  ["fp_ellipse", 20260508], ["fp_ellipse_arc", 20260508], ["gr_ellipse", 20260508], ["gr_ellipse_arc", 20260508],
  ["major_radius", 20260508], ["minor_radius", 20260508], ["rotation_angle", 20260508], ["start_angle", 20260508],
  ["constant", 20260511], ["dielectric_model", 20260511], ["djordjevic_sarkar", 20260511],
  ["spec_frequency", 20260511], ["net_chain", 20260512], ["net_chains", 20260512], ["terminal_pad", 20260512],
  ["dots", 20260513], ["square", 20260513], ["squares", 20260513], ["stagger", 20260513], ["thieving", 20260513],
  ["sim_electrical_type", 20260521], ["transform", 20260616], ["translate", 20260616], ["driving", 20260624],
  ["affects", 20260728], ["cursor", 20260728], ["extent", 20260728], ["grid_item", 20260728], ["polar", 20260728],
  ["routing", 20260728], ["tick_interval", 20260728], ["ij", 20260816], ["template", 20260816],
  ["templates", 20260816], ["arrow_open", 20260818], ["background", 20260818], ["end_shape", 20260818],
  ["start_shape", 20260818], ["custom_property", 20260831], ["drill_chart", 20260901], ["drill_map", 20260901],
  ["drill_symbol_profile", 20260901], ["link", 20261018], ["stackup_table", 20261030],
]);
const BOARD_VALUE_ATOM_VERSIONS = new Map<string, number>([
  ["pad_prop_mechanical", 20240225], ["pad_prop_pressfit", 20250801], ["exclude_from_sim", 20260828],
  ["extruded", 20260930], ["non_component", 20261031],
]);
const SCHEMATIC_VALUE_ATOM_VERSIONS = new Map<string, number>([
  ["global", 20250227], ["local", 20250227],
]);
const SYMBOL_LIB_VALUE_ATOM_VERSIONS = new Map<string, number>([
  ["global", 20241209], ["local", 20241209], ["demorgan", 20250324],
]);
const SCHEMATIC_VERSION_FEATURES = new Map<number, string>([
  [20200512, "Add support for exclude from BOM."], [20200602, "Add support for exclude from board."],
  [20200608, "Add support for bus and junction properties."], [20200618, "Disallow duplicate field ids."],
  [20200828, "Add footprint to symbol_instances."], [20201015, "Add sheet instance properties."],
  [20210126, "Fix bug with writing pin uuids."], [20220103, "Label fields"], [20220104, "Fonts"],
  [20220124, "netclass_flag -> directive_label"], [20220126, "Text boxes"],
  [20220404, "Default schematic symbol instance data."], [20220822, "Hyperlinks in text objects"],
  [20220904, "Do not autoplace field option"], [20220914, "Add support for DNP"], [20220919, ""],
  [20230409, "Add exclude_from_sim markup"], [20240101, "Tables."], [20240417, "Rule areas"],
  [20240620, "Embedded Files"], [20250222, "Hatched fills for shapes"], [20250227, "Support for local power symbols"],
  [20250318, "~ no longer means empty text"], [20250827, "Custom body styles"], [20250922, "Schematic variants."],
  [20251028, "Updated properties formatting (do_not_autoplace, show_name)"], [20260101, "PCB variants"],
  [20260326, "Locking properties"], [20260508, "Native ellipse primitive"], [20260512, "Net chains"],
  [20260629, "Pin-to-pad maps (issue #2282)"], [20260722, "Dedicated variant symbol_override token"],
  [20260818, "Line ending shapes"], [20260830, "Custom user properties"],
  [20261015, "Custom user properties for shapes"], [20261025, "Reference image rotation and opacity"],
  [20261106, "Custom user properties for pins and sheet pins"],
]);
const SYMBOL_LIB_VERSION_FEATURES = new Map<number, string>([
  [20220102, "Fonts."], [20220126, "Text boxes."], [20220331, "Text colors."],
  [20220914, "Symbol unit display names."], [20231120, "generator_version; V8 cleanups"], [20240529, "Embedded Files"],
  [20241209, "Private flags for SCH_FIELDs"], [20250324, "Jumper pin groups"],
  [20251024, "Updated properties formatting (do_not_autoplace, show_name)"], [20260508, "Native ellipse primitive"],
  [20260622, "Escaped special chars in stacked pin notation"], [20260629, "Pin-to-pad maps (issue #2282)"],
  [20260710, "Line ending shapes"], [20260830, "Custom user properties"],
  [20261015, "Custom user properties for shapes"], [20261106, "Custom user properties for pins and sheet pins"],
]);
const BOARD_VERSION_FEATURES = new Map<number, string>([
  [20240202, "Tables"], [20240225, "Rationalization of solder_paste_margin"], [20240609, "Add 'tenting' keyword"],
  [20240706, "Embedded Files"], [20240928, "Component classes"], [20240929, "Complex padstacks"],
  [20241010, "Graphic shapes can have soldermask layer and margin"],
  [20241030, "Dimension arrow directions, suppress_zeroes normalization"],
  [20241228, "Convert teardrop curve points to bool"], [20241229, "Expand User layers to arbitrary count"],
  [20250222, "Hatching for PCB shapes"], [20250309, "Component class dynamic assignment rules"],
  [20250228, "ipc-4761 via protection features"], [20250302, "Zone Hatching Offsets"], [20250324, "Jumper pads"],
  [20250401, "Time domain length tuning"], [20250513, "Groups can have design block lib_id"],
  [20250801, "(island) -> (island yes/no)"], [20250909, "footprint unit metadata (units/pins)"],
  [20250914, "Add support for PCB_BARCODE objects"], [20251101, "Backdrill and tertiary drill support"],
  [20260101, "PCB variants with per-footprint overrides"], [20260410, "Extruded 3D body"],
  [20260508, "Native ellipse primitive"], [20260511, "Dielectric frequency-dependent models in board stackup"],
  [20260512, "Net chains"], [20260513, "Copper thieving zone fill mode"],
  [20260521, "Pad simulation electrical types"],
  [20260616, "Footprint affine transform: lib-frame storage and (transform) block"],
  [20260624, "Geometric constraints (#2329)"], [20260728, "Grid items"], [20260816, "Via stitching and guarding"],
  [20260818, "Line ending shapes"], [20260828, "Exclude-from-simulation footprint attribute"],
  [20260831, "Custom user properties"], [20260901, "Drill charts and maps"], [20260930, "UUID for extruded 3D body"],
  [20261017, "Footprint overall height"], [20261018, "Linked placement rule areas"],
  [20261025, "Reference image rotation and opacity"], [20261030, "Live stackup tables"],
  [20261031, "Non-component pads"],
]);

const TOKENS: Record<FormatDomain, Map<string, number>> = { sch: SCHEMATIC_TOKEN_VERSIONS, symlib: SYMBOL_LIB_TOKEN_VERSIONS, pcb: BOARD_TOKEN_VERSIONS };
const VALUES: Record<FormatDomain, Map<string, number>> = { sch: SCHEMATIC_VALUE_ATOM_VERSIONS, symlib: SYMBOL_LIB_VALUE_ATOM_VERSIONS, pcb: BOARD_VALUE_ATOM_VERSIONS };
const FEATURES: Record<FormatDomain, Map<number, string>> = { sch: SCHEMATIC_VERSION_FEATURES, symlib: SYMBOL_LIB_VERSION_FEATURES, pcb: BOARD_VERSION_FEATURES };

/** versionFeature: the format change that introduced a version, for the message to the user. */
export function versionFeature(domain: FormatDomain, version: number): string | null { const f = FEATURES[domain].get(version); return f === undefined ? null : f; }

export interface FormatRequirement { version: number; feature: string | null }
const isTokenStart = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95;
const isTokenChar = (c: number): boolean => isTokenStart(c) || (c >= 48 && c <= 57);
/**
 * KICAD_FORMAT::MinimumFileFormatVersion: the oldest file version that can hold `body`.  Quoted atoms are skipped; a
 * token right after "(" is looked up in the token table, any other bare word in the value-atom table.
 */
export function minimumFileFormatVersion(body: string, domain: FormatDomain): FormatRequirement {
  const tokens = TOKENS[domain], values = VALUES[domain];
  const req: FormatRequirement = { version: 0, feature: null };
  const require = (v: number): void => { if (v > req.version) { req.version = v; req.feature = versionFeature(domain, v); } };
  let i = 0; const n = body.length;
  while (i < n) {
    const ch = body.charCodeAt(i);
    if (ch === 34) { let j = i + 1; while (j < n && body.charCodeAt(j) !== 34) j += body.charCodeAt(j) === 92 ? 2 : 1; i = j < n ? j + 1 : n; continue; }
    if (ch === 40) {
      let j = i + 1;
      if (j < n && isTokenStart(body.charCodeAt(j))) { while (j < n && isTokenChar(body.charCodeAt(j))) j++; const v = tokens.get(body.slice(i + 1, j)); if (v !== undefined) require(v); }
      i = j; continue;
    }
    if (isTokenStart(ch)) { let j = i; while (j < n && isTokenChar(body.charCodeAt(j))) j++; const v = values.get(body.slice(i, j)); if (v !== undefined) require(v); i = j; continue; }
    i++;
  }
  return req;
}

/** KICAD_FORMAT::WritingOlderThan: a file kept at `fileVersion` (0: a new file, written current) is older than `version`. */
export function writingOlderThan(fileVersion: number, version: number): boolean { return fileVersion > 0 && fileVersion < version; }

/** KICAD_FORMAT::UsesEscapedStackedPinNotation: a bracketed stacked pin number with a backslash escape in it. */
export function usesEscapedStackedPinNotation(num: string): boolean {
  if (num.length < 3 || num[0] !== "[" || num[num.length - 1] !== "]") return false;
  return num.slice(1, -1).indexOf("\\") >= 0;
}

/** The message SCH_IO_KICAD_SEXPR / PCB_IO_KICAD_SEXPR report when a save had to raise the stamp. */
export function versionRaisedMessage(file: string, feature: string | null, from: number, to: number): string {
  return `'${file}' uses ${feature || "a newer file format feature"}, which file format version ${from} cannot store.  Saved using file format version ${to} instead; older versions of KiCad will not be able to open it.`;
}
