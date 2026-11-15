// viewer3d/colors.ts — KiCad's default 3D viewer colours (3d-viewer/3d_canvas/board_adapter.cpp:212-225,
// the g_Default* COLOR4D values) and the placeholder colours of the component bodies.

/** r, g, b in 0..1 (sRGB, as KiCad's COLOR4D stores them) and alpha. */
export type RGBA = [number, number, number, number];

export const BACKGROUND_TOP: RGBA = [0.80, 0.80, 0.90, 1];      // g_DefaultBackgroundTop
export const BACKGROUND_BOTTOM: RGBA = [0.40, 0.40, 0.50, 1];   // g_DefaultBackgroundBot
export const SILKSCREEN: RGBA = [0.94, 0.94, 0.94, 1];          // g_DefaultSilkscreen
export const SOLDER_MASK: RGBA = [0.08, 0.20, 0.14, 0.83];      // g_DefaultSolderMask
export const SOLDER_PASTE: RGBA = [0.50, 0.50, 0.50, 1];        // g_DefaultSolderPaste
export const SURFACE_FINISH: RGBA = [0.75, 0.61, 0.23, 1];      // g_DefaultSurfaceFinish (copper)
export const BOARD_BODY: RGBA = [0.43, 0.45, 0.30, 0.90];       // g_DefaultBoardBody
/** The inside of a drilled hole seen from above where it could not be cut out of the board mesh. */
export const HOLE_SHADE: RGBA = [0.10, 0.09, 0.07, 1];

export function css(c: RGBA, alpha = c[3]): string {
  const v = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);
  return alpha >= 1 ? `rgb(${v(c[0])},${v(c[1])},${v(c[2])})` : `rgba(${v(c[0])},${v(c[1])},${v(c[2])},${+alpha.toFixed(3)})`;
}

export function hex(c: RGBA): string {
  const v = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, "0");
  return "#" + v(c[0]) + v(c[1]) + v(c[2]);
}

export function fromHex(h: string): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(h); if (!m) return [0, 0, 0, 1];
  const n = parseInt(m[1], 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

export const ADHESIVE: RGBA = [0.70, 0.11, 0.17, 1];            // g_DefaultAdhesive
export const COMMENTS: RGBA = [0.85, 0.85, 0.85, 1];            // g_DefaultComments
export const ECOS: RGBA = [0.70, 0.10, 0.10, 1];                // g_DefaultECOs
export const FAB: RGBA = [0.60, 0.60, 0.60, 1];                 // g_DefaultFabColor
export const COURTYARD: RGBA = [1.000, 0.149, 0.886, 1];        // g_DefaultCourtyardColor

/**
 * The extra board layers the 3D viewer can draw on a face (BOARD_ADAPTER::Is3dLayerEnabled): the Appearance key,
 * the board layers it covers, the face, the default colour (LAYER_PRESET_3D's colours) and whether it shows by default.
 * The user layers User.1 … User.45 follow, on the front face, in the comments colour.
 */
export interface ExtraLayer { key: string; label: string; layers: string[]; tip: string; color: RGBA; on: boolean }
export const EXTRA_LAYERS: ExtraLayer[] = [
  { key: "adhesive", label: "Adhesive", layers: ["F.Adhes", "B.Adhes"], tip: "Show adhesive", color: ADHESIVE, on: true },
  { key: "Dwgs.User", label: "User.Drawings", layers: ["Dwgs.User"], tip: "Show user drawings layer", color: COMMENTS, on: false },
  { key: "Cmts.User", label: "User.Comments", layers: ["Cmts.User"], tip: "Show user comments layer", color: COMMENTS, on: false },
  { key: "Eco1.User", label: "User.Eco1", layers: ["Eco1.User"], tip: "Show user ECO1 layer", color: ECOS, on: false },
  { key: "Eco2.User", label: "User.Eco2", layers: ["Eco2.User"], tip: "Show user ECO2 layer", color: ECOS, on: false },
  { key: "F.Fab", label: "F.Fab", layers: ["F.Fab"], tip: "Show front fabrication layer", color: FAB, on: false },
  { key: "B.Fab", label: "B.Fab", layers: ["B.Fab"], tip: "Show back fabrication layer", color: FAB, on: false },
  { key: "F.CrtYd", label: "F.Courtyard", layers: ["F.CrtYd"], tip: "Show front courtyard layer", color: COURTYARD, on: false },
  { key: "B.CrtYd", label: "B.Courtyard", layers: ["B.CrtYd"], tip: "Show back courtyard layer", color: COURTYARD, on: false },
  ...Array.from({ length: 45 }, (_, i): ExtraLayer => ({ key: `User.${i + 1}`, label: `User.${i + 1}`, layers: [`User.${i + 1}`], tip: `Show user defined layer ${i + 1}`, color: COMMENTS, on: false })),
];
/** The face an extra board layer is drawn on: the back for B.* layers, the front for everything else. */
export const extraSide = (layer: string): "F" | "B" => (layer.startsWith("B.") ? "B" : "F");

/**
 * The colours the board is drawn with: KiCad's 3D layer colours (EDA_3D_VIEWER_SETTINGS / the Appearance manager's
 * swatches, LAYER_3D_BOARD … LAYER_3D_SOLDERPASTE and the extra layers by key), changed by the Appearance panel.
 * Each face has its own silkscreen and mask colour.
 */
export type LayerColors = Record<string, RGBA>;
export const DEFAULT_LAYER_COLORS: LayerColors = { board: BOARD_BODY, copper: SURFACE_FINISH, paste: SOLDER_PASTE, silkTop: SILKSCREEN, silkBottom: SILKSCREEN, maskTop: SOLDER_MASK, maskBottom: SOLDER_MASK,
  ...Object.fromEntries(EXTRA_LAYERS.map((l) => [l.key, l.color])) };
export const LAYER_COLORS: LayerColors = cloneLayerColors(DEFAULT_LAYER_COLORS);
export function cloneLayerColors(c: LayerColors): LayerColors { const out: LayerColors = {}; for (const k of Object.keys(c)) out[k] = c[k].slice() as RGBA; return out; }
export function setLayerColors(c: Partial<LayerColors>): void { for (const k of Object.keys(c)) { const v = c[k]; if (v && v.length === 4 && k in DEFAULT_LAYER_COLORS) LAYER_COLORS[k] = v.slice() as RGBA; } }

/**
 * Colours that stand in for the user's while an Appearance option asks for them: "Use board stackup colors"
 * (BOARD_ADAPTER::InitSettings reads the stackup's silkscreen, mask and dielectric colours) and "Use PCB editor
 * copper colors" (copperTop / copperBottom from the board editor's F.Cu / B.Cu).
 */
let OVERRIDE: Partial<LayerColors> = {};
export function setColorOverride(c: Partial<LayerColors> | null): void { OVERRIDE = c ? { ...c } : {}; }
/** The colour a layer is drawn with now: an override, else the user's colour; copperTop / copperBottom fall back to copper. */
export function layerColor(key: string): RGBA {
  const o = OVERRIDE[key]; if (o) return o;
  if ((key === "copperTop" || key === "copperBottom")) return OVERRIDE.copper || LAYER_COLORS.copper;
  return LAYER_COLORS[key] || DEFAULT_LAYER_COLORS[key] || BOARD_BODY;
}
export function colorStamp(): string { return JSON.stringify(LAYER_COLORS) + JSON.stringify(OVERRIDE); }

/** GetStandardColors() of stackup_predefined_prms.cpp: the solder mask / silkscreen names and the dielectric materials. */
const STACKUP_COLORS: Record<string, [number, number, number, number]> = {
  Green: [60, 150, 80, 255], Red: [128, 0, 0, 255], Blue: [0, 0, 128, 255], Purple: [80, 0, 80, 255], Black: [20, 20, 20, 255], White: [200, 200, 200, 255], Yellow: [128, 128, 0, 255],
  "FR4 natural": [109, 116, 75, 212], "PTFE natural": [252, 252, 250, 230], Polyimide: [205, 130, 0, 170], "Phenolic natural": [92, 17, 6, 230], Aluminum: [213, 213, 213, 255],
};
/** A stackup colour ("Green", "#3C9650FF", "R60G150B80") as RGBA, or null. */
export function stackupColor(name: string | undefined, alpha?: number): RGBA | null {
  if (!name) return null;
  const std = STACKUP_COLORS[name];
  let c: number[] | null = std ? std : null;
  const hx = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(name);
  if (hx) { const n = parseInt(hx[1], 16); c = [n >> 16, (n >> 8) & 255, n & 255, hx[2] ? parseInt(hx[2], 16) : 255]; }
  const rgb = /^R(\d+)G(\d+)B(\d+)(?:A(\d+))?$/.exec(name);
  if (rgb) c = [+rgb[1], +rgb[2], +rgb[3], rgb[4] ? +rgb[4] : 255];
  if (!c) return null;
  return [c[0] / 255, c[1] / 255, c[2] / 255, alpha !== undefined ? alpha : c[3] / 255];
}
/** The stackup's colours as layer overrides: silkscreen, solder mask (KiCad's mask opacity kept) and the board body (the first dielectric). */
export function stackupOverride(layers: { name: string; type?: string; color?: string }[]): Partial<LayerColors> {
  const out: Partial<LayerColors> = {};
  for (const l of layers) {
    if (l.name === "F.SilkS") { const c = stackupColor(l.color); if (c) out.silkTop = c; }
    else if (l.name === "B.SilkS") { const c = stackupColor(l.color); if (c) out.silkBottom = c; }
    else if (l.name === "F.Mask") { const c = stackupColor(l.color, SOLDER_MASK[3]); if (c) out.maskTop = c; }
    else if (l.name === "B.Mask") { const c = stackupColor(l.color, SOLDER_MASK[3]); if (c) out.maskBottom = c; }
    else if (/^dielectric/.test(l.name) && !out.board) { const c = stackupColor(l.color); if (c) out.board = c; }
  }
  return out;
}
