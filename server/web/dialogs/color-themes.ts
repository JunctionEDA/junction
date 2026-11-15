// dialogs/color-themes.ts — Preferences > Schematic Editor > Colors (PANEL_EESCHEMA_COLOR_SETTINGS over
// PANEL_COLOR_SETTINGS): the items a theme colours, in KiCad's layer names and order, the user's own themes (KiCad's
// colors/*.json, kept with the preferences here) and the checks the panel makes.  No editor imports.

/** A theme the user made with New Theme...: its name, and every palette key's colour (web/canvas/colors.ts SCH_DEFAULT). */
export interface UserSchTheme { id: string; name: string; colors: Record<string, string> }

/**
 * The swatches of PANEL_EESCHEMA_COLOR_SETTINGS (SCH_LAYER_ID_START .. SCH_LAYER_ID_END that the theme stores), named by
 * LayerName() (common/layer_id.cpp), as the palette keys of web/canvas/colors.ts.  The bus entry ink follows Wires.
 */
export const SCH_COLOR_ITEMS: [string, string][] = [
  ["wire", "Wires"], ["bus", "Buses"], ["junction", "Junctions"], ["label", "Labels"], ["glabel", "Global labels"],
  ["hlabel", "Hierarchical labels"], ["pinNum", "Pin numbers"], ["pinName", "Pin names"], ["ref", "Symbol references"],
  ["value", "Symbol values"], ["field", "Symbol fields"], ["netclass", "Net class references"], ["ruleArea", "Rule areas"],
  ["outline", "Symbol body outlines"], ["body", "Symbol body fills"], ["notes", "Schematic text && graphics"],
  ["privateNotes", "Symbol private text && graphics"], ["pin", "Pins"], ["sheet", "Sheet borders"], ["sheetName", "Sheet names"],
  ["sheetFields", "Sheet fields"], ["sheetFile", "Sheet file names"], ["sheetLabel", "Sheet pins"], ["noconnect", "No-connect symbols"],
  ["dnp", "DNP markers"], ["excluded", "Excluded-from-simulation markers"], ["grid", "Grid"], ["gridAxes", "Axes"],
  ["bg", "Background"], ["hovered", "Hovered items"], ["brightened", "Highlighted items"], ["hidden", "Hidden items"],
  ["selection", "Selection highlight"], ["frame", "Drawing sheet"], ["pageLimits", "Page limits"],
];
/** Items whose colour may equal the background (validateSave skips LAYER_SCHEMATIC_BACKGROUND and LAYER_SHEET_BACKGROUND). */
const BG_EXEMPT = new Set(["bg", "body"]);

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
