// dialogs/color-themes.ts — Preferences > Schematic Editor > Colors (PANEL_EESCHEMA_COLOR_SETTINGS over
// PANEL_COLOR_SETTINGS): the items a theme colours, by KiCad's layer names in the panel's order, the user's own themes (KiCad's
// colors/*.json, kept with the preferences here) and the checks the panel makes.  No editor imports.

/** A theme the user made with New Theme...: its name, and every palette key's colour (web/domains/pcb/canvas/colors.ts SCH_DEFAULT). */
export interface UserSchTheme { id: string; name: string; colors: Record<string, string>; /** "Override individual item colors" (schematic.override_item_colors) */ overrideItemColors?: boolean;
  /** the theme's "board" namespace (layer names and GAL keys of web/domains/pcb/canvas/colors.ts): KiCad Default's for a key it leaves out */
  board?: Record<string, string> }

/**
 * The swatches of PANEL_EESCHEMA_COLOR_SETTINGS::createSwatches (eeschema/dialogs/panel_eeschema_color_settings.cpp):
 * every SCH layer from SCH_LAYER_ID_START to SCH_LAYER_ID_END but g_excludedLayers (LAYER_NOTES_BACKGROUND,
 * LAYER_DANGLING, LAYER_NET_COLOR_HIGHLIGHT, LAYER_GROUP), named by LayerName() (common/layer_id.cpp) and sorted by
 * that name, with Axes labelled "(symbol editor only)".  [palette key, label, LAYER_*]; the keys are those of
 * web/domains/pcb/canvas/colors.ts SCH_DEFAULT, plus SCH_EXTRA_DEFAULTS' for the layers the canvas palette does not carry.
 */
const SCH_LAYER_ITEMS: [string, string, string][] = [
  ["wire", "Wires", "LAYER_WIRE"], ["bus", "Buses", "LAYER_BUS"], ["junction", "Junctions", "LAYER_JUNCTION"], ["label", "Labels", "LAYER_LOCLABEL"],
  ["glabel", "Global labels", "LAYER_GLOBLABEL"], ["hlabel", "Hierarchical labels", "LAYER_HIERLABEL"], ["pinNum", "Pin numbers", "LAYER_PINNUM"],
  ["pinName", "Pin names", "LAYER_PINNAM"], ["ref", "Symbol references", "LAYER_REFERENCEPART"], ["value", "Symbol values", "LAYER_VALUEPART"],
  ["field", "Symbol fields", "LAYER_FIELDS"], ["sheetRefs", "Sheet references", "LAYER_INTERSHEET_REFS"], ["netclass", "Net class references", "LAYER_NETCLASS_REFS"],
  ["ruleArea", "Rule areas", "LAYER_RULE_AREAS"], ["outline", "Symbol body outlines", "LAYER_DEVICE"], ["notes", "Schematic text && graphics", "LAYER_NOTES"],
  ["privateNotes", "Symbol private text && graphics", "LAYER_PRIVATE_NOTES"], ["pin", "Pins", "LAYER_PIN"], ["sheet", "Sheet borders", "LAYER_SHEET"],
  ["sheetName", "Sheet names", "LAYER_SHEETNAME"], ["sheetFile", "Sheet file names", "LAYER_SHEETFILENAME"], ["sheetFields", "Sheet fields", "LAYER_SHEETFIELDS"],
  ["sheetLabel", "Sheet pins", "LAYER_SHEETLABEL"], ["noconnect", "No-connect symbols", "LAYER_NOCONNECT"], ["dnp", "DNP markers", "LAYER_DNP_MARKER"],
  ["ercWarn", "ERC warnings", "LAYER_ERC_WARN"], ["ercErr", "ERC errors", "LAYER_ERC_ERR"], ["ercExcl", "ERC exclusions", "LAYER_ERC_EXCLUSION"],
  ["excluded", "Excluded-from-simulation markers", "LAYER_EXCLUDED_FROM_SIM"], ["shapeFill", "Shape fills", "LAYER_SHAPES_BACKGROUND"],
  ["body", "Symbol body fills", "LAYER_DEVICE_BACKGROUND"], ["sheetBg", "Sheet backgrounds", "LAYER_SHEET_BACKGROUND"], ["grid", "Grid", "LAYER_SCHEMATIC_GRID"],
  ["gridAxes", "Axes", "LAYER_SCHEMATIC_GRID_AXES"], ["bg", "Background", "LAYER_SCHEMATIC_BACKGROUND"], ["cursor", "Cursor", "LAYER_SCHEMATIC_CURSOR"],
  ["hovered", "Hovered items", "LAYER_HOVERED"], ["brightened", "Highlighted items", "LAYER_BRIGHTENED"], ["hidden", "Hidden items", "LAYER_HIDDEN"],
  ["dragCollision", "Drag net collisions", "LAYER_DRAG_NET_COLLISION"], ["selection", "Selection highlight", "LAYER_SELECTION_SHADOWS"],
  ["frame", "Drawing sheet", "LAYER_SCHEMATIC_DRAWINGSHEET"], ["pageLimits", "Page limits", "LAYER_SCHEMATIC_PAGE_LIMITS"],
  ["busJunction", "Bus junctions", "LAYER_BUS_JUNCTION"], ["aux", "Helper items", "LAYER_SCHEMATIC_AUX_ITEMS"], ["anchor", "Anchors", "LAYER_SCHEMATIC_ANCHOR"],
  ["opVoltage", "Operating point voltages", "LAYER_OP_VOLTAGES"], ["opCurrent", "Operating point currents", "LAYER_OP_CURRENTS"],
];
/** wxString's operator<: code unit order (what std::sort compares LayerName()s with). */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** [palette key, swatch label], in the panel's order.  The bus entry ink follows Wires. */
export const SCH_COLOR_ITEMS: [string, string][] = SCH_LAYER_ITEMS.slice().sort((a, b) => byName(a[1], b[1]))
  .map(([k, name, layer]) => [k, layer === "LAYER_SCHEMATIC_GRID_AXES" ? `${name} (symbol editor only)` : name]);

/**
 * The theme colours of the layers web/domains/pcb/canvas/colors.ts' palette does not carry, per built-in theme
 * (common/settings/builtin_color_themes.h s_defaultTheme / s_classicTheme; COLOR4D names through color4d.cpp's B, G, R
 * table).  Sheet references and Shape fills have no theme entry in KiCad (COLOR_SETTINGS registers no parameter for
 * them), so the panel shows GetDefaultColor's s_userColors[ layer % 4 ] for both: (180, 219, 210).
 */
const EXTRA_DEFAULT: Record<string, string> = {
  sheetRefs: "#B4DBD2", shapeFill: "#B4DBD2", sheetBg: "rgba(255,255,255,0)", ercWarn: "rgba(209,146,0,0.8)", ercErr: "rgba(230,9,13,0.8)",
  ercExcl: "rgba(194,194,194,0.8)", cursor: "#0F0F0F", dragCollision: "rgba(230,9,13,0.8)", busJunction: "#000084", aux: "#000000", anchor: "#0000FF",
  opVoltage: "#840032", opCurrent: "#E0000C",
};
const EXTRA_CLASSIC: Record<string, string> = {
  ...EXTRA_DEFAULT, sheetBg: "rgba(255,255,255,0)", ercWarn: "rgba(0,255,0,0.8)", ercErr: "rgba(255,0,0,0.8)", ercExcl: "#C2C2C2", cursor: "#000000",
  dragCollision: "rgba(255,0,0,0.8)", busJunction: "#000084", aux: "#000000", anchor: "#0000FF", opVoltage: "#480048", opCurrent: "#840000",
};
/** The extra layers' colours of a built-in theme (KiCad Default's for a theme KiCad does not have). */
export function schExtraColors(themeId: string): Record<string, string> { return { ...(themeId === "classic" ? EXTRA_CLASSIC : EXTRA_DEFAULT) }; }
/** Items whose colour may equal the background (validateSave skips LAYER_SCHEMATIC_BACKGROUND and LAYER_SHEET_BACKGROUND). */
const BG_EXEMPT = new Set(["bg", "sheetBg"]);

const rgbOf = (c: string): [number, number, number, number] | null => {
  const t = (c || "").trim();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(t);
  if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) / 255 : 1]; }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(t);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
};
/** COLOR4D equality of two CSS colours (channels to the byte, alpha to 1/255). */
export function sameColor(a: string, b: string): boolean {
  const x = rgbOf(a), y = rgbOf(b); if (!x || !y) return a === b;
  return x.slice(0, 3).every((v, i) => Math.round(v) === Math.round(y[i])) && Math.abs(x[3] - y[3]) < 1 / 255;
}
/** PANEL_EESCHEMA_COLOR_SETTINGS::validateSave: an item drawn in the background colour cannot be seen. */
export function hiddenByBackground(colors: Record<string, string>): string[] {
  const bg = colors.bg; if (!bg) return [];
  return SCH_COLOR_ITEMS.filter(([k]) => !BG_EXEMPT.has(k) && colors[k] && sameColor(colors[k], bg)).map(([k]) => k);
}
/** Whether a sheet of this background is dark (the sheet's dark flag: the painters' selection and dimming read it). */
export function isDarkBackground(bg: string): boolean { const c = rgbOf(bg); return !!c && (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 < 0.5; }

/**
 * FOOTPRINT_NAME_VALIDATOR on New Theme...'s name (it becomes the theme's file name) and "Theme already exists!":
 * null when the name is good.
 */
export function themeNameError(name: string, taken: string[]): string | null {
  const n = name.trim();
  if (!n) return "A theme name is required.";
  const bad = n.match(/[\\/:*?"<>|\t\n\r]/);
  if (bad) return `The theme name contains the illegal character '${bad[0] === "\t" ? "\\t" : bad[0]}'.`;
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) return "Theme already exists!";
  return null;
}
/** The id a new user theme is registered under in the canvas' theme table. */
export function userThemeId(name: string, taken: string[]): string {
  const base = "user:" + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "user:theme";
  let id = base, i = 2; while (taken.includes(id)) id = `${base}-${i++}`;
  return id;
}
/** A new theme copied from the palette on show (PANEL_COLOR_SETTINGS::OnThemeChanged's New Theme...). */
export function newUserTheme(name: string, from: Record<string, string>, takenIds: string[]): UserSchTheme {
  return { id: userThemeId(name, takenIds), name: name.trim(), colors: { ...from } };
}

// ---------------------------------------------------------------- the board namespace (PANEL_PCBNEW_COLOR_SETTINGS, PANEL_FP_EDITOR_COLOR_SETTINGS)
/**
 * The GAL layers PANEL_PCBNEW_COLOR_SETTINGS lists: GAL_LAYER_ID_START .. GAL_LAYER_ID_BITMASK_END less g_excludedLayers,
 * then the layers outside that range it adds by hand.  [key, LayerName(), GAL id offset from GAL_LAYER_ID_START (the
 * order createSwatches sorts ties in is the id's)].
 */
const BOARD_GAL_ITEMS: [string, string][] = [
  ["plated_hole", "Non-plated holes"], ["anchor", "Anchors"], ["ratsnest", "Ratsnest"], ["grid", "Grid"], ["grid_axes", "Grid axes"], ["via_hole", "Via holes"],
  ["drc_error", "DRC errors"], ["worksheet", "Drawing sheet"], ["select_overlay", "Selection highlight"], ["background", "Background"], ["cursor", "Cursor"],
  ["aux_items", "Helper items"],
  ["locked_shadow", "Locked item shadow"], ["conflicts_shadow", "Courtyard collision shadow"], ["constraint_shadow", "Constrained item shadow"],
  ["constraint_under", "Under-constrained tint"], ["constraint_well", "Fully constrained tint"], ["constraint_over", "Over-constrained tint"],
  ["outline_area", "Board outline area"], ["page_limits", "Page limits"], ["drc_warning", "DRC warnings"], ["drc_exclusion", "DRC exclusions"],
  ["drc_highlighted", "DRC highlighted"], ["track_net_names", "Track net names"], ["pad_net_names", "Pad net names"], ["subgrids", "Grids"],
];
/** LayerName() of the board layers (common/layer_id.cpp), by the canvas' layer names. */
const BOARD_LAYER_NAMES: Record<string, string> = {
  "B.Adhes": "B.Adhesive", "F.Adhes": "F.Adhesive", "B.SilkS": "B.Silkscreen", "F.SilkS": "F.Silkscreen", "Dwgs.User": "User.Drawings", "Cmts.User": "User.Comments",
  "Eco1.User": "User.Eco1", "Eco2.User": "User.Eco2", "F.CrtYd": "F.Courtyard", "B.CrtYd": "B.Courtyard",
};
/** LayerName() of a board layer. */
export function boardLayerName(layer: string): string { return BOARD_LAYER_NAMES[layer] || layer; }
/** LSET::TechAndUserUIOrder: the technical layers in the UI's order, then User.1 .. User.45. */
const TECH_UI_ORDER = ["F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask", "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User",
  "Edge.Cuts", "Margin", "F.CrtYd", "B.CrtYd", "F.Fab", "B.Fab", ...Array.from({ length: 45 }, (_, i) => `User.${i + 1}`)];
/**
 * PANEL_PCBNEW_COLOR_SETTINGS::createSwatches: the copper layers F.Cu, In1.Cu .. In30.Cu, B.Cu (LAYER_RANGE, not sorted),
 * the technical and user layers in TechAndUserUIOrder, then the GAL layers sorted by LayerName().  A board layer is named
 * by the board (BOARD::GetLayerName) when there is one.  [key, label].
 */
export function pcbColorItems(boardName?: ((layer: string) => string | null | undefined) | null): [string, string][] {
  const gal = BOARD_GAL_ITEMS.map((x, i) => [x, i] as [[string, string], number]).sort((a, b) => byName(a[0][1], b[0][1]) || a[1] - b[1]).map(([x]) => x);
  const layers = ["F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu", ...TECH_UI_ORDER];
  return [...layers.map((l) => [l, (boardName && boardName(l)) || boardLayerName(l)] as [string, string]), ...gal];
}
/**
 * The GAL layers of PANEL_FP_EDITOR_COLOR_SETTINGS (GAL_LAYER_ID_START .. GAL_LAYER_ID_END but the via and pad hole
 * layers) that COLOR_SETTINGS can hold, in id order: the swatches are those the theme gives a colour (not UNSPECIFIED).
 */
const FP_GAL_ITEMS: [string, string][] = [
  ["plated_hole", "Non-plated holes"], ["anchor", "Anchors"], ["ratsnest", "Ratsnest"], ["grid", "Grid"], ["grid_axes", "Grid axes"], ["drc_error", "DRC errors"],
  ["worksheet", "Drawing sheet"], ["select_overlay", "Selection highlight"], ["background", "Background"], ["cursor", "Cursor"], ["aux_items", "Helper items"],
  ["drc_warning", "DRC warnings"], ["drc_exclusion", "DRC exclusions"], ["locked_shadow", "Locked item shadow"], ["conflicts_shadow", "Courtyard collision shadow"],
  ["outline_area", "Board outline area"], ["points", "Points"], ["constraint_shadow", "Constrained item shadow"], ["subgrids", "Grids"], ["via_stitching", "Via stitching"],
  ["page_limits", "Page limits"], ["drc_highlighted", "DRC highlighted"], ["constraint_under", "Under-constrained tint"], ["constraint_well", "Fully constrained tint"],
  ["constraint_over", "Over-constrained tint"],
];
/** COLOR4D::UNSPECIFIED: transparent black, what GetColor answers for a layer the theme has no colour for. */
export function isUnspecified(c: string | undefined): boolean { const v = c ? rgbOf(c) : null; return !v || (v[0] === 0 && v[1] === 0 && v[2] === 0 && v[3] === 0); }
/**
 * PANEL_FP_EDITOR_COLOR_SETTINGS::createSwatches: F.Cu, "Internal Layers" (In1.Cu), B.Cu, then the GAL layers the theme on
 * show when the page is made gives a colour, sorted by LayerName().  [key, label].
 */
export function fpColorItems(colors: Record<string, string>): [string, string][] {
  const gal = FP_GAL_ITEMS.map((x, i) => [x, i] as [[string, string], number]).filter(([x]) => !isUnspecified(colors[x[0]]))
    .sort((a, b) => byName(a[0][1], b[0][1]) || a[1] - b[1]).map(([x]) => x);
  return [["F.Cu", "F.Cu"], ["In1.Cu", "Internal Layers"], ["B.Cu", "B.Cu"], ...gal];
}
/** COLOR_SETTINGS stores no "board.select_overlay": a user theme never keeps one (it reads back UNSPECIFIED). */
export function storableBoardColors(colors: Record<string, string>): Record<string, string> { const out = { ...colors }; delete out.select_overlay; return out; }
/**
 * PANEL_COLOR_SETTINGS::OnThemeChanged's New Theme... from a board page: a theme with KiCad Default's schematic colours
 * and the board colours of the page's swatches copied from the theme on show (the rest KiCad Default's).
 */
export function newUserBoardTheme(name: string, keys: string[], from: Record<string, string>, takenIds: string[]): UserSchTheme {
  const board: Record<string, string> = {}; for (const k of keys) if (from[k] !== undefined) board[k] = from[k];
  return { id: userThemeId(name, takenIds), name: name.trim(), colors: {}, board: storableBoardColors(board) };
}
