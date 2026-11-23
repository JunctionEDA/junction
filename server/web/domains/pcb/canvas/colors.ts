// kicad-canvas — GENERATED SOURCE MODULE (split from the former static/kicad-canvas.js; static/kicad-canvas.js is now the esbuild output of web/domains/pcb/canvas/index.ts — edit these modules, not the bundle).
import { classicLayerColor } from "./plot-params";
// ---------------------------------------------------------------- colours
export function rgba(r: number, g: number, b: number, a?: number): string { return a === undefined || a >= 1 ? "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("") : `rgba(${r},${g},${b},${+a.toFixed(3)})`; }

export function parseColor(c: string): [number, number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(c); if (m) { const v = parseInt(m[1], 16); return [v >> 16, (v >> 8) & 255, v & 255, 1]; }
  const n = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c); if (n) return [+n[1], +n[2], +n[3], n[4] === undefined ? 1 : +n[4]];
  return [0, 0, 0, 1];
}

/** KiCad's "dimmed" item colour: desaturate then mix 50/50 with the sheet background. */
export function dimColor(c: string, bg: string): string {
  const [r, g, b, a] = parseColor(c), [br, bgc, bb] = parseColor(bg);
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;   // HSL lightness = desaturated grey
  return rgba(Math.round((l + br) / 2), Math.round((l + bgc) / 2), Math.round((l + bb) / 2), a);
}

/** "KiCad Default" (builtin_color_themes.h s_defaultTheme): the schematic colours of a fresh KiCad, and of every export. */
/** The browser runs on macOS (KiCad's __WXMAC__ colour and pen choices). */
export const IS_MAC_PLATFORM = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
export const SCH_DEFAULT = Object.freeze({
  bg: "#F5F4EF", grid: "#B5B5B5", gridAxes: "#000084", wire: "#009600", bus: "#000084", junction: "#009600", outline: "#840000",
  body: "#FFFFC2", pin: "#840000", pinName: "#006464", pinNum: "#A90000", ref: "#006464", value: "#006464",
  field: "#840084", label: "#0F0F0F", glabel: "#840000", hlabel: "#725600", sheet: "#840000", sheetName: "#006464",
  sheetFile: "#725600", sheetFields: "#840084", sheetLabel: "#006464", noconnect: "#000084", notes: "#0000C2",
  busEntry: "#009600", dnp: "rgba(220,9,13,0.85)", netclass: "#484848", ruleArea: "#FF0000", excluded: "rgba(194,194,194,0.95)",
  hidden: "#C2C2C2", privateNotes: "#4848FF", frame: "#840000",
  // LAYER_SCHEMATIC_DRAWINGSHEET ("schematic.worksheet") is `frame`; the page outline is a separate,
  // lighter layer — DS_PAINTER::DrawBorder paints it in LAYER_SCHEMATIC_PAGE_LIMITS, not the sheet ink
  // (common/settings/builtin_color_themes.h:78-79, eeschema/sch_view.cpp:137-138).
  pageLimits: "#B5B5B5",
  brightened: "#FF00FF",   // LAYER_BRIGHTENED: net highlighting / selection disambiguation
  // LAYER_SELECTION_SHADOWS: KiCad Default is (.3, .7, 1.0, .6) on macOS, which "looks better with a lighter
  // shadow", (.4, .7, 1.0, .8) elsewhere (builtin_color_themes.h)
  selection: IS_MAC_PLATFORM ? "rgba(77,179,255,0.6)" : "rgba(102,179,255,0.8)",
  hovered: "#0000FF",      // LAYER_HOVERED: hypertext under the cursor (builtin_color_themes.h:33)
  // LAYER_BUS_JUNCTION, LAYER_SHEET_BACKGROUND (alpha 0: not drawn), LAYER_SCHEMATIC_ANCHOR, LAYER_ERC_ERR / WARN / EXCLUSION
  busJunction: "#000084", sheetBg: "rgba(255,255,255,0)", anchor: "#0000FF",
  ercErr: "rgba(230,9,13,0.8)", ercWarn: "rgba(209,146,0,0.8)", ercExcl: "rgba(194,194,194,0.8)",
});

// ---------------------------------------------------------------- schematic colour themes
// KiCad's two built-in themes (common/settings/builtin_color_themes.h; COLOR4D names resolved through
// common/gal/color4d.cpp, whose table is B, G, R) plus a dark sheet.  A key a theme leaves out keeps KiCad
// Default's colour, as COLOR_SETTINGS falls back to s_defaultTheme.
/** A schematic colour theme: its name, whether the sheet is dark, and the palette keys it overrides. */
export interface SchThemeDef { name: string; dark: boolean; colors: Partial<Record<keyof typeof SCH_DEFAULT, string>> }

export const SCH_THEMES: Record<string, SchThemeDef> & { default: SchThemeDef } = {
  default: { name: "KiCad Default", dark: false, colors: {} },
  classic: { name: "KiCad Classic", dark: false, colors: {
    bg: "#FFFFFF", grid: "#848484", wire: "#008400", bus: "#000084", junction: "#008400", outline: "#840000", body: "#FFFFC2", pin: "#840000",
    pinName: "#008484", pinNum: "#840000", ref: "#008484", value: "#008484", field: "#840084", label: "#000000", glabel: "#840000", hlabel: "#848400",
    sheet: "#840084", sheetName: "#008484", sheetFile: "#848400", sheetFields: "#840084", sheetLabel: "#008484", noconnect: "#000084", notes: "#0000C2",
    busEntry: "#008400", dnp: "rgba(255,0,0,0.85)", netclass: "#000000", ruleArea: "#840000", excluded: "rgba(194,194,194,0.95)", hidden: "#C2C2C2",
    privateNotes: "#0000C2", frame: "#840000", brightened: "#FF00FF",
    busJunction: "#000084", ercErr: "rgba(255,0,0,0.8)", ercWarn: "rgba(0,255,0,0.8)", ercExcl: "#C2C2C2",   // BLUE, PURERED / PUREGREEN @ 0.8, LIGHTGRAY
    selection: IS_MAC_PLATFORM ? "rgba(199,235,255,0.8)" : "rgba(102,179,255,0.8)",   // KiCad Classic's shadow
  } },
  // A dark sheet in the manner of the popular community dark themes: near-black paper, KiCad's hues lifted so
  // every layer keeps at least 4.5:1 against the background, the same layer-to-hue mapping as KiCad Default.
  dark: { name: "Dark", dark: true, colors: {
    bg: "#1C1D20", grid: "#4A4D53", gridAxes: "#6E8EFF", wire: "#4CC864", bus: "#6E8EFF", junction: "#4CC864", outline: "#E46F6F", body: "#2B2A22", pin: "#E46F6F",
    pinName: "#3CC6C6", pinNum: "#F09090", ref: "#3CC6C6", value: "#3CC6C6", field: "#D684D6", label: "#E8E8E8", glabel: "#F2885A", hlabel: "#DDBB4C",
    sheet: "#E46F6F", sheetName: "#3CC6C6", sheetFile: "#DDBB4C", sheetFields: "#D684D6", sheetLabel: "#3CC6C6", noconnect: "#7F9BFF", notes: "#86A6FF",
    busEntry: "#4CC864", dnp: "rgba(255,72,76,0.85)", netclass: "#B4B4B4", ruleArea: "#FF5C5C", excluded: "rgba(120,120,120,0.95)", hidden: "#6C6E73",
    privateNotes: "#A0A0FF", frame: "#C46A6A", pageLimits: "#55585E", brightened: "#FF4DFF",
  } },
};

/** The live palette every painter reads (geometry takes its colours from here when it is built). */
export const SCH: Record<keyof typeof SCH_DEFAULT, string> = Object.assign({}, SCH_DEFAULT);
let schThemeId = "default";

/** The schematic theme the palette holds now. */
export function schTheme(): string { return schThemeId; }

/** The palette of a theme (KiCad Default for an unknown id). */
export function schThemeColors(id: string): Record<keyof typeof SCH_DEFAULT, string> { const t = SCH_THEMES[id] || SCH_THEMES.default; return Object.assign({}, SCH_DEFAULT, t.colors); }

/**
 * Switch the live palette.  Geometry built under another theme is rebuilt lazily by the painters (geom.ts
 * ensureSchTheme), so a switch costs nothing until the next paint.  Returns whether anything changed.
 */
export function setSchTheme(id: string): boolean {
  if (!SCH_THEMES[id]) id = "default";
  if (id === schThemeId) return false;
  Object.assign(SCH, schThemeColors(id)); schThemeId = id;
  return true;
}

/** Run fn with the palette switched to theme `id` (an export in KiCad Default while the screen shows another). */
export function withSchTheme<T>(id: string, fn: () => T): T {
  const was = schThemeId; setSchTheme(id);
  try { return fn(); } finally { setSchTheme(was); }
}

// draw order (eeschema/sch_view.h SCH_LAYER_ORDER, bottom first; only the background layers are negative).  Label
// bodies are on LAYER_DEVICE (SCH_LABEL_BASE::ViewGetLayers), sheet pins on LAYER_HIERLABEL (SCH_SHEET::ViewGetLayers).
export const SCH_Z: Record<string, number> = { notesBg: -7, sheetBg: -6, deviceBg: -5, shapesBg: -4, bitmap: -3, sheet: 0, device: 1, pinName: 2, pinNum: 3, pin: 4,
  loclabel: 5, hierlabel: 5, bus: 6, wire: 7, privateNotes: 8, notes: 9, sheetFields: 10, sheetName: 11, sheetFile: 12, globlabel: 13, sheetPin: 14,
  noconnect: 15, junction: 16, busJunction: 17, ruleArea: 18, netclass: 19, intersheet: 20, fields: 21, value: 22, ref: 23, marker: 24 };

/** COLOR4D::Darkened(f): every channel c → c·(1−f), alpha kept */
export const DARK_CACHE = new Map<string, string>();
export function darkened(c: string, f: number): string {
  const key = f + c; let v = DARK_CACHE.get(key); if (v) return v;
  const [r, g, b, a] = parseColor(c); v = rgba(Math.round(r * (1 - f)), Math.round(g * (1 - f)), Math.round(b * (1 - f)), a);
  if (DARK_CACHE.size < 4096) DARK_CACHE.set(key, v); return v;
}

// [layer name, palette key]: the colour is read from the live palette, so it follows the theme
export const SCH_LAYERS: [string, keyof typeof SCH_DEFAULT][] = [
  ["Wires", "wire"], ["Buses", "bus"], ["Junctions", "junction"], ["Symbols", "outline"], ["Pins", "pin"],
  ["Pin names", "pinName"], ["Pin numbers", "pinNum"], ["Reference & value", "ref"], ["Fields", "field"],
  ["Labels", "label"], ["Sheets", "sheet"], ["Notes", "notes"], ["No-connects", "noconnect"], ["Rule areas", "ruleArea"],
  ["Images", "hidden"],
];

export const PCB_COLORS: Record<string, string> = {
  "F.Cu": "#C83434", "B.Cu": "#4D7FC4", "In1.Cu": "#7FC87F", "In2.Cu": "#CE7D2C", "In3.Cu": "#4FCBCB", "In4.Cu": "#DB628B",
  "In5.Cu": "#A7A5C6", "In6.Cu": "#28CCD9", "In7.Cu": "#E8B2A7", "In8.Cu": "#F2EDA1", "In9.Cu": "#8DCB81", "In10.Cu": "#ED7C33",
  "In11.Cu": "#5BC3EB", "In12.Cu": "#F76F8E", "In13.Cu": "#A7A5C6", "In14.Cu": "#28CCD9", "In15.Cu": "#E8B2A7", "In16.Cu": "#F2EDA1",
  "In17.Cu": "#ED7C33", "In18.Cu": "#5BC3EB", "In19.Cu": "#F76F8E", "In20.Cu": "#A7A5C6", "In21.Cu": "#28CCD9", "In22.Cu": "#E8B2A7",
  "In23.Cu": "#F2EDA1", "In24.Cu": "#ED7C33", "In25.Cu": "#5BC3EB", "In26.Cu": "#F76F8E", "In27.Cu": "#A7A5C6", "In28.Cu": "#28CCD9",
  "In29.Cu": "#E8B2A7", "In30.Cu": "#F2EDA1",
  "F.SilkS": "#F2EDA1", "B.SilkS": "#E8B2A7", "F.Mask": "rgba(216,100,255,0.4)", "B.Mask": "rgba(2,255,238,0.4)",
  "F.Paste": "rgba(180,160,154,0.9)", "B.Paste": "rgba(0,194,194,0.9)", "F.Adhes": "#840084", "B.Adhes": "#000084",
  "Edge.Cuts": "#D0D2CD", "Margin": "#FF26E2", "F.CrtYd": "#FF26E2", "B.CrtYd": "#26E9FF", "F.Fab": "#AFAFAF", "B.Fab": "#585D84",
  "Dwgs.User": "#C2C2C2", "Cmts.User": "#5994DC", "Eco1.User": "#B4DBD2", "Eco2.User": "#D8C852",
};

export const USER_COLORS = ["#C2C2C2", "#5994DC", "#B4DBD2", "#D8C852"];
   // User.1.. cycle (User.9 = B.SilkS colour in the theme)
export const PCB_BG = "#001023", PCB_GRID = "#848484", PCB_GRID_AXES = "#C2C2C2", VIA_HOLE = "#E3B72E", HOLE_WALL = "#ECECEC", NPTH = "#1AC4D2",
  // pad labels: PCB_RENDER_SETTINGS::LoadColors overwrites LAYER_PAD_NETNAMES with NETNAMES_LAYER_ID_START (white @ 0.7), inverted on bright copper
  PAD_TEXT = "rgba(255,255,255,0.7)", PAD_TEXT_DARK = "rgba(0,0,0,0.7)";

// The board's drawing sheet and page outline: LAYER_DRAWINGSHEET / LAYER_PAGE_LIMITS
// (builtin_color_themes.h:178-179).  pcbnew draws the same sheet as eeschema, in these colours.
export const PCB_SHEET = "#C872AB", PCB_PAGE_LIMITS = "#848484";
/** LAYER_CURSOR of the board theme (builtin_color_themes.h: COLOR4D( WHITE )): the crosshair of the footprint viewers. */
export const PCB_CURSOR = "#FFFFFF";

export const PCB_HIDDEN_DEFAULT = new Set(["F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.Adhes", "B.Adhes", "F.Fab", "B.Fab", "F.CrtYd", "B.CrtYd", "Margin", "Eco1.User", "Eco2.User"]);

export function pcbColor(layer: string): string {
  if (PCB_COLORS[layer]) return PCB_COLORS[layer];
  const u = /^User\.(\d+)$/.exec(layer); if (u) return +u[1] === 9 ? "#E8B2A7" : USER_COLORS[(+u[1] - 1) % 4];
  if (/\.Cu$/.test(layer)) return "#7FC87F"; return "#C2C2C2";
}

// ---------------------------------------------------------------- board colour themes
// The "board" namespace of a colour theme (common/settings/color_settings.cpp: "board.<key>" for the GAL layers, the
// board layers by name).  Geometry is always built in KiCad Default's colours (PCB_COLORS, PCB_BG, VIA_HOLE ...); the
// screen painter maps them to the live theme below (PCB_RENDER_SETTINGS::LoadColors), so a theme change costs no rebuild
// and the exports keep KiCad Default unless told otherwise.

/** s_defaultTheme's GAL board colours, keyed as COLOR_SETTINGS stores them ("board.<key>"); select_overlay has no parameter (UNSPECIFIED). */
export const BOARD_GAL_DEFAULT: Readonly<Record<string, string>> = Object.freeze({
  anchor: "#FF26E2", locked_shadow: "rgba(255,38,226,0.5)", conflicts_shadow: "rgba(255,0,5,0.5)", constraint_shadow: "rgba(80,160,240,0.5)",
  constraint_under: "rgba(204,107,5,0.9)", constraint_well: "rgba(46,184,77,0.9)", constraint_over: "rgba(235,46,46,0.9)", aux_items: "#FFFFFF",
  background: "#001023", cursor: "#FFFFFF", drc_error: "rgba(215,91,107,0.8)", drc_warning: "rgba(255,208,66,0.8)", drc_exclusion: "rgba(255,255,255,0.8)",
  drc_highlighted: "#FF00FF", grid: "#848484", grid_axes: "#C2C2C2", pad_plated_hole: "#C2C200", plated_hole: "#1AC4D2", ratsnest: "rgba(0,248,255,0.35)",
  select_overlay: "rgba(0,0,0,0)", via_hole: "#E3B72E", via_hole_walls: "#ECECEC", worksheet: "#C872AB", page_limits: "#848484",
  outline_area: "rgba(100,100,100,0.35)", track_net_names: "rgba(255,255,255,0.7)", pad_net_names: "rgba(255,255,255,0.9)", via_net_names: "rgba(50,50,50,0.9)",
  points: "#FF26E2", subgrids: "#C2C200", via_stitching: "#4DCCB2",
});
/** s_classicTheme's GAL board colours (COLOR4D names through color4d.cpp's B, G, R table). */
const BOARD_GAL_CLASSIC: Record<string, string> = {
  anchor: "#000084", locked_shadow: "rgba(0,0,132,0.6)", conflicts_shadow: "rgba(132,0,0,0.5)", constraint_shadow: "rgba(79,161,240,0.5)",
  constraint_under: "rgba(204,107,5,0.9)", constraint_well: "rgba(46,184,77,0.9)", constraint_over: "rgba(235,46,46,0.9)", aux_items: "#FFFFFF",
  background: "#000000", cursor: "#FFFFFF", drc_error: "rgba(255,0,0,0.8)", drc_warning: "rgba(0,255,0,0.8)", drc_exclusion: "#FFFFFF",
  drc_highlighted: "#FF00FF", grid: "#848484", grid_axes: "#000084", pad_plated_hole: "#C2C200", plated_hole: "#C2C200", ratsnest: "#FFFFFF",
  select_overlay: "#00FF00", via_hole: "rgba(128,102,0,0.8)", via_hole_walls: "#FFFFFF", worksheet: "#480000", page_limits: "#848484",
  outline_area: "rgba(100,100,100,0.35)", track_net_names: "rgba(255,255,255,0.7)", pad_net_names: "rgba(255,255,255,0.9)", via_net_names: "rgba(50,50,50,0.9)",
  points: "#000084", subgrids: "#C2C200", via_stitching: "#008484",
};
/** Every board layer a theme colours, in COLOR_SETTINGS' order: F.Cu, In1..In30, B.Cu, the technical layers, User.1..45. */
export const BOARD_THEME_LAYERS: readonly string[] = Object.freeze([
  "F.Cu", ...Array.from({ length: 30 }, (_, i) => `In${i + 1}.Cu`), "B.Cu", "B.Adhes", "F.Adhes", "B.Paste", "F.Paste", "B.SilkS", "F.SilkS", "B.Mask", "F.Mask",
  "Dwgs.User", "Cmts.User", "Eco1.User", "Eco2.User", "Edge.Cuts", "Margin", "B.CrtYd", "F.CrtYd", "B.Fab", "F.Fab", ...Array.from({ length: 45 }, (_, i) => `User.${i + 1}`),
]);
/**
 * COLOR_SETTINGS::GetDefaultColor: s_defaultTheme's colour of a key (a board layer name or a GAL key); a layer without a
 * parameter falls back to s_copperColors / s_userColors[ layer % size ] (LAYER_SELECT_OVERLAY: GAL_LAYER_ID_START + 26 = 287,
 * s_userColors[ 3 ] = (194, 194, 194)).
 */
export function boardDefaultColor(key: string): string {
  if (key === "select_overlay") return "#C2C2C2";
  if (Object.prototype.hasOwnProperty.call(BOARD_GAL_DEFAULT, key)) return BOARD_GAL_DEFAULT[key];
  return pcbColor(key);
}
/** A built-in board theme: its name and the colours it sets (the rest are KiCad Default's). */
export interface BoardThemeDef { name: string; colors: Record<string, string> }
let classicBoard: Record<string, string> | null = null;
/** s_classicTheme's board namespace, layers and GAL colours together (built on first use: plot-params holds the layer table). */
function classicBoardColors(): Record<string, string> {
  if (!classicBoard) {
    classicBoard = { ...BOARD_GAL_CLASSIC };
    for (const l of BOARD_THEME_LAYERS) { const c = classicLayerColor(l); if (c) classicBoard[l] = c; }
  }
  return classicBoard;
}
/** The board namespace of every theme of the theme table: KiCad's two built-ins; a theme without board colours (the Dark sheet theme) is KiCad Default's. */
export function boardThemeColors(id: string): Record<string, string> {
  const out: Record<string, string> = { ...BOARD_GAL_DEFAULT };
  for (const l of BOARD_THEME_LAYERS) out[l] = pcbColor(l);
  if (id === "classic") Object.assign(out, classicBoardColors());
  return out;
}

/** PCB_RENDER_SETTINGS::LoadColors: a board layer colour with an alpha under 0.2 is drawn at 0.2. */
function clampLayerAlpha(c: string): string { const [r, g, b, a] = parseColor(c); return a < 0.2 ? rgba(r, g, b, 0.2) : c; }

/** The live board palette: the GAL colours of the theme on show (PCB_RENDER_SETTINGS::m_layerColors of the GAL layers). */
export const BOARD: Record<string, string> = { ...BOARD_GAL_DEFAULT };
/** The live board-layer colours (alpha clamped as LoadColors does); every layer a theme colours has an entry. */
export const PCB_LIVE: Record<string, string> = {};
for (const l of BOARD_THEME_LAYERS) PCB_LIVE[l] = pcbColor(l);
let boardStamp = 0, boardKey = "", liveOverrides: Map<string, string> | null = null;
/** Bumped on every change of the live board palette (painter caches keyed on it). */
export function boardThemeStamp(): number { return boardStamp; }

/**
 * Load a theme's board namespace into the live palette (KiCad Default's colour for a key it leaves out); null puts KiCad
 * Default back.  Returns whether anything changed.
 */
export function setBoardColors(colors: Record<string, string> | null): boolean {
  const full = { ...boardThemeColors("default"), ...(colors || {}) };
  const key = JSON.stringify(full); if (key === boardKey) return false;
  boardKey = key; boardStamp++;
  for (const k of Object.keys(BOARD_GAL_DEFAULT)) BOARD[k] = full[k] || BOARD_GAL_DEFAULT[k];
  liveOverrides = null;
  for (const l of BOARD_THEME_LAYERS) {
    const c = clampLayerAlpha(full[l] || pcbColor(l)); PCB_LIVE[l] = c;
    if (c.toLowerCase() !== pcbColor(l).toLowerCase()) (liveOverrides || (liveOverrides = new Map())).set(l, c);
  }
  return true;
}
/** The live board palette as a theme map (what setBoardColors was given, defaults filled in). */
export function liveBoardColors(): Record<string, string> { return boardKey ? JSON.parse(boardKey) as Record<string, string> : boardThemeColors("default"); }
/** Run fn with the live board palette switched to `colors` (an export in KiCad Default while the screen shows another theme). */
export function withBoardColors<T>(colors: Record<string, string> | null, fn: () => T): T {
  const was = boardKey ? JSON.parse(boardKey) as Record<string, string> : null; setBoardColors(colors);
  try { return fn(); } finally { setBoardColors(was); }
}
/** The colour a board layer is drawn in under the live theme (PCB_RENDER_SETTINGS::GetColor's m_layerColors). */
export function livePcbColor(layer: string): string { return PCB_LIVE[layer] || clampLayerAlpha(pcbColor(layer)); }
/** The board layers whose live colour is not KiCad Default's (what the painter maps geometry colours through), or null. */
export function boardLayerOverrides(): Map<string, string> | null { return liveOverrides; }
/** A GAL colour of the live theme ("background", "via_hole", "grid" ...). */
export function boardColor(key: string): string { return BOARD[key] || BOARD_GAL_DEFAULT[key] || "#000000"; }
/** COLOR4D::Inverted: every channel c → 1 − c, alpha kept. */
export function invertedColor(c: string): string { const [r, g, b, a] = parseColor(c); return rgba(255 - r, 255 - g, 255 - b, a); }
/** COLOR4D::GetBrightness: r·0.299 + g·0.587 + b·0.114, on 0 .. 1 channels. */
export function colorBrightness(c: string): number { const [r, g, b] = parseColor(c); return (r * 0.299 + g * 0.587 + b * 0.114) / 255; }
/**
 * PCB_RENDER_SETTINGS::LoadColors' netname colours: NETNAMES_LAYER_ID_START ("board.track_net_names") on dark copper, inverted
 * on copper brighter than 0.5; a pad label of several layers takes it as it is (LAYER_PAD_NETNAMES is not themeable).
 */
export function liveNetnameColor(copper: string | null): string {
  const light = boardColor("track_net_names");
  return copper && colorBrightness(livePcbColor(copper)) > 0.5 ? invertedColor(light) : light;
}

// pcbnew GAL_LAYER_ORDER, bottom first; copper groups carry fill/track/pad/via sub-orders
export const PCB_ORDER = ["B.Fab", "B.CrtYd", "B.Adhes", "B.Paste", "B.SilkS", "B.Mask", "B.Cu"];

for (let i = 30; i >= 1; i--) PCB_ORDER.push("In" + i + ".Cu");

PCB_ORDER.push("F.Fab", "F.CrtYd", "F.Adhes", "F.Paste", "F.SilkS", "F.Mask", "F.Cu", "holes");

for (let i = 45; i >= 1; i--) PCB_ORDER.push("User." + i);

PCB_ORDER.push("Margin", "Edge.Cuts", "Eco2.User", "Eco1.User", "Cmts.User", "Dwgs.User");

export const PCB_ZMAP = new Map(PCB_ORDER.map((l, i) => [l, i * 10]));

export function pcbZ(layer: string): number { const z = PCB_ZMAP.get(layer); return z === undefined ? 5 : z; }

export const Z_PAD = 2, Z_VIA = 1, Z_TEXT = 4, Z_ZONE = -1, Z_BITMAP = -20;
   // BITMAP_LAYER_FOR(…) sits below every board layer
export function padLayers(doc: Pick<KDoc, "copper">, names: Iterable<string>): string[] {
  // expand *.Cu / F&B.Cu etc. against the board's copper layers (front→back order)
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const out: string[] = [];
  for (const n of names) {
    if (n === "*.Cu") out.push(...copper);
    else if (n === "F&B.Cu") out.push("F.Cu", "B.Cu");
    else if (n.startsWith("*.")) out.push("F" + n.slice(1), "B" + n.slice(1));
    else out.push(n);
  }
  return out.filter((l, i) => out.indexOf(l) === i);
}
