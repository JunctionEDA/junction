// panels/appearance.ts — the board editor's Appearance panel model (pcbnew/widgets/appearance_controls.cpp):
// layers (KiCad's names, order and tooltips; visibility, colour and the active layer), the Objects rows
// (visibility + opacity), nets and net classes (colour + ratsnest visibility), the layer / net display
// options, layer presets and viewports.  Everything is per user and lives in localStorage — KiCad keeps the
// colours (with their opacity) in the user's colour theme and the rest in the project's local settings
// (.kicad_prl) — and reaches the canvas through E.renderOpts (web/domains/pcb/canvas/render.ts) and the pcb tool module's
// ratsnest state.  Nothing here is written into the board file.
import type { AppearanceState, InactiveMode, LayerInfo, LayerMenuCmd, NetClassRow, NetCmd, NetColorMode, NetRow, ObjectRow, PanelAction, RatsnestMode } from "../../panels-api";
import { parseColor, rgba } from "../../canvas/colors";
import { confirmBox } from "../../dialogs/dom";
import { setToggles, store } from "../appstore";
import { hotkeyCyclePopup } from "../hotkey-popup";
import { setActiveLayer } from "../doc";
import { E } from "../state";
import { toast } from "../util";
import { fitBox, requestRender, visibleRectNm } from "../view";
import { showPane } from "../panes";
import { openBoardSetup } from "../pcbdialogs/board-setup";
import { KC, isSchDoc, kdoc, listPick, loadJson, panelStore, pcbTools, projectId, saveJson, textEntry, tctx } from "./core";
import { activeAfterHide, appearanceNets, objectVisibilityChange, presetActiveLayer, ratsnestCycle, ratsnestFromRadio, ratsnestRadio, showNetclassNets, sortNetClasses } from "./appearance-model";
import { editProject, type Plain, type ProjectEdit } from "../../canvas/project-file";
import { adoptProjectFile, canWriteProject, saveProjectFile } from "../projectfile";
import { messageBox } from "../../dialogs/cvpcb/widgets";
import { activeBoardColors, boardThemeId, isReadOnlyTheme, migrateBoardColors, prefs, saveUserBoardColors, setSessionBoardColor } from "../../dialogs/prefs";

// ---------------------------------------------------------------- layers
// APPEARANCE_CONTROLS::rebuildLayers: copper front → back, then this technical / user sequence.
const NON_CU: [string, string, string][] = [
  ["F.Adhes", "F.Adhesive", "Adhesive on board's front"], ["B.Adhes", "B.Adhesive", "Adhesive on board's back"],
  ["F.Paste", "F.Paste", "Solder paste on board's front"], ["B.Paste", "B.Paste", "Solder paste on board's back"],
  ["F.SilkS", "F.Silkscreen", "Silkscreen on board's front"], ["B.SilkS", "B.Silkscreen", "Silkscreen on board's back"],
  ["F.Mask", "F.Mask", "Solder mask on board's front"], ["B.Mask", "B.Mask", "Solder mask on board's back"],
  ["Dwgs.User", "User.Drawings", "Explanatory drawings"], ["Cmts.User", "User.Comments", "Explanatory comments"],
  ["Eco1.User", "User.Eco1", "User defined meaning"], ["Eco2.User", "User.Eco2", "User defined meaning"],
  ["Edge.Cuts", "Edge.Cuts", "Board's perimeter definition"], ["Margin", "Margin", "Board's edge setback outline"],
  ["F.CrtYd", "F.Courtyard", "Footprint courtyards on board's front"], ["B.CrtYd", "B.Courtyard", "Footprint courtyards on board's back"],
  ["F.Fab", "F.Fab", "Footprint assembly on board's front"], ["B.Fab", "B.Fab", "Footprint assembly on board's back"],
];
const NON_CU_RANK = new Map(NON_CU.map((l, i) => [l[0], i]));
const isCu = (l: string) => /\.Cu$/.test(l);
function layerRank(l: string): number {
  if (l === "F.Cu") return 0; if (l === "B.Cu") return 99;
  const inner = /^In(\d+)\.Cu$/.exec(l); if (inner) return +inner[1];
  const r = NON_CU_RANK.get(l); if (r !== undefined) return 100 + r;
  const u = /^User\.(\d+)$/.exec(l); if (u) return 200 + +u[1];
  return 400;
}
/** LSET::UIOrder rank of a layer (copper front → back, then the technical and user layers). */
export const layerUiRank = layerRank;
/** BOARD::GetLayerName: the user's name when the board gives one, else LayerName() (common/layer_id.cpp). */
export function layerDisplayName(doc: KDoc | null, key: string): string {
  const row = doc ? doc.layers.get(key) : undefined;
  if (row && row.userName && row.userName !== key) return row.userName;
  const std = NON_CU.find((l) => l[0] === key);
  return std ? std[1] : key;
}
function layerTip(key: string): string {
  if (key === "F.Cu") return "Front copper layer"; if (key === "B.Cu") return "Back copper layer"; if (isCu(key)) return "Inner copper layer";
  const std = NON_CU.find((l) => l[0] === key); if (std) return std[2];
  const u = /^User\.(\d+)$/.exec(key); return u ? `User defined layer ${u[1]}` : key;
}
function boardLayerKeys(doc: KDoc): string[] {
  const names = new Set<string>();
  for (const [k, row] of doc.layers) if (typeof k === "string" && (k.includes(".") || k === "Margin") && row) names.add(k);
  // rebuildLayers lists board->GetEnabledLayers(): the board's (layers) table; items' layers only for a file without one
  if (!names.size) for (const it of doc.items.values()) for (const g of it.geom) if (g.layer && g.layer !== "holes" && (g.layer.includes(".") || g.layer === "Margin")) names.add(g.layer);
  if (!names.size) for (const l of ["F.Cu", "B.Cu"]) names.add(l);
  return Array.from(names).sort((a, b) => layerRank(a) - layerRank(b) || a.localeCompare(b));
}

// ---------------------------------------------------------------- objects (s_objectSettings)
interface ObjectDef { id: string; label: string; tip: string; opacity?: boolean; canHide?: boolean; spacer?: boolean; defaultHidden?: boolean; defaultOpacity?: number }
const OBJECTS: ObjectDef[] = [
  { id: "tracks", label: "Tracks", tip: "Show tracks", opacity: true },
  { id: "vias", label: "Vias", tip: "Show all vias", opacity: true },
  { id: "pads", label: "Pads", tip: "Show all pads", opacity: true },
  { id: "zones", label: "Zones", tip: "Show copper zones", opacity: true, defaultOpacity: 0.6 },   // "board.opacity.zones" 0.6
  { id: "filledShapes", label: "Filled Shapes", tip: "Opacity of filled shapes", opacity: true, canHide: false },
  { id: "images", label: "Images", tip: "Show user images", opacity: true, defaultOpacity: 0.6 },   // "board.opacity.images" 0.6
  { id: "outsideGroup", label: "Outside Group", tip: "Opacity of items outside the entered group", opacity: true, canHide: false, defaultOpacity: 1 },   // "board.opacity.outside_group": PROJECT_LOCAL_SETTINGS default 1.0 (no fading until the person lowers it)
  { id: "sp1", label: "", tip: "", spacer: true },
  { id: "fpFront", label: "Footprints Front", tip: "Show footprints that are on board's front" },
  { id: "fpBack", label: "Footprints Back", tip: "Show footprints that are on board's back" },
  { id: "values", label: "Values", tip: "Show footprint values" },
  { id: "references", label: "References", tip: "Show footprint references" },
  { id: "fpText", label: "Footprint Text", tip: "Show all footprint text" },
  { id: "sp2", label: "", tip: "", spacer: true },
  { id: "sp3", label: "", tip: "", spacer: true },
  { id: "ratsnest", label: "Ratsnest", tip: "Show unconnected nets as a ratsnest" },
  { id: "drcWarnings", label: "DRC Warnings", tip: "DRC violations with a Warning severity" },
  { id: "drcErrors", label: "DRC Errors", tip: "DRC violations with an Error severity" },
  { id: "drcExclusions", label: "DRC Exclusions", tip: "DRC violations which have been individually excluded", defaultHidden: true },
  { id: "anchors", label: "Anchors", tip: "Show footprint and text origins as a cross" },
  { id: "points", label: "Points", tip: "Show explicit snap points as crosses" },
  { id: "subgrids", label: "Grids", tip: "Show custom routing/placement grids" },
  { id: "viaStitching", label: "Via Stitching", tip: "Show via stitching generator outlines" },
  { id: "lockedShadow", label: "Locked Item Shadow", tip: "Show a shadow on locked items" },
  { id: "conflicts", label: "Colliding Courtyards", tip: "Show colliding footprint courtyards" },
  { id: "constraintShadow", label: "Constrained Item Shadow", tip: "Show a shadow on constrained items" },
  { id: "boardArea", label: "Board Area Shadow", tip: "Show board area shadow", defaultHidden: true },   // LAYER_BOARD_OUTLINE_AREA: hidden by default (lset.cpp)
  { id: "drawingSheet", label: "Drawing Sheet", tip: "Show drawing sheet borders and title block" },
  { id: "grid", label: "Grid", tip: "Show the (x,y) grid dots" },
];
/** s_allowedInFpEditor: the only Objects rows the Footprint Editor lists (spacers are not in the set either). */
export const FP_EDITOR_OBJECTS = ["tracks", "vias", "pads", "zones", "filledShapes", "values", "references", "fpText", "images", "outsideGroup", "grid", "points", "viaStitching"];
/**
 * The colour of an Objects row in the user's colour theme (theme->GetColor( layer ), builtin_color_themes.h "KiCad
 * Default"): rows whose layer has one get a COLOR_SWATCH; the others (Tracks, Vias, Pads, Zones ...) a spacer.
 */
export const OBJECT_COLORS: Record<string, string> = {
  ratsnest: "rgba(0,248,255,0.35)", drcWarnings: "rgba(255,208,66,0.8)", drcErrors: "rgba(215,91,107,0.8)", drcExclusions: "rgba(255,255,255,0.8)",
  anchors: "#ff26e2", points: "#ff26e2", subgrids: "#c2c200", viaStitching: "#4dccb2", lockedShadow: "rgba(255,38,226,0.5)",
  conflicts: "rgba(255,0,5,0.5)", constraintShadow: "rgba(80,160,240,0.5)", boardArea: "rgba(100,100,100,0.35)", drawingSheet: "#c872ab", grid: "#848484",
};
/** The colour theme key ("board.<key>") of each Objects row with a swatch. */
export const OBJECT_THEME_KEYS: Record<string, string> = {
  ratsnest: "ratsnest", drcWarnings: "drc_warning", drcErrors: "drc_error", drcExclusions: "drc_exclusion", anchors: "anchor", points: "points", subgrids: "subgrids",
  viaStitching: "via_stitching", lockedShadow: "locked_shadow", conflicts: "conflicts_shadow", constraintShadow: "constraint_shadow", boardArea: "outline_area",
  drawingSheet: "worksheet", grid: "grid",
};
/** theme->GetColor( layer ) of the frame's colour theme (EDA_DRAW_FRAME::GetColorSettings): a board layer or an Objects row's GAL layer. */
function themeColor(key: string): string | undefined { const c = activeBoardColors(); return c[key]; }
/** The colour of an Objects row in the frame's colour theme. */
export function objectColor(id: string): string | undefined { return (OBJECT_THEME_KEYS[id] && themeColor(OBJECT_THEME_KEYS[id])) || OBJECT_COLORS[id]; }
/** The frame's colour theme is a built-in one (COLOR_SETTINGS::IsReadOnly): its swatches are read-only. */
function themeReadOnly(): boolean { const p = prefs(); return isReadOnlyTheme(p, boardThemeId(p, fpEditor())); }
/**
 * APPEARANCE_CONTROLS::onReadOnlySwatch: a click on a swatch of a read-only theme says so in the infobar, with a link to
 * the Preferences (ShowPreferences( wxEmptyString, wxEmptyString )).
 */
export function readOnlySwatchNotice(): void {
  toast("The current color theme is read-only.  Create a new theme in Preferences to enable color editing.", 10000,
    { text: "Open Preferences", run: () => { void import("../../dialogs/preferences").then((m) => m.openPreferences()); } });
}
/**
 * APPEARANCE_CONTROLS::OnColorSwatchChanged: cs->SetColor( layer, color ) and SaveColorSettings( cs, "board" ): the frame's
 * user theme takes the colour at once; a read-only theme cannot (its swatches only show onReadOnlySwatch).
 */
function setThemeColor(key: string, color: string): void {
  const p = prefs(), id = boardThemeId(p, fpEditor());
  if (isReadOnlyTheme(p, id)) { readOnlySwatchNotice(); return; }
  saveUserBoardColors(id, { [key]: color });
}
/**
 * SETTINGS_MANAGER::GetMigratedColorSettings: colours this panel kept per user before the board had colour themes move
 * into the "User" theme once (layer colours by name, the Objects rows' by their theme key).
 */
function migrateLegacyColors(): void {
  const keys = Object.keys(user.colors); if (!keys.length) return;
  const board: Record<string, string> = {};
  for (const k of keys) { const c = user.colors[k]; if (!c) continue; if (k.startsWith("obj:")) { const g = OBJECT_THEME_KEYS[k.slice(4)]; if (g) board[g] = c; } else board[k] = c; }
  user.colors = {}; saveUser();
  if (Object.keys(board).length) migrateBoardColors(board);
}
/** An Objects row's opacity: the user's, else KiCad's default (PROJECT_LOCAL_SETTINGS: zones and images 0.6, the rest 1). */
function objOpacity(o: ObjectDef): number { const v = user.objOpacity[o.id]; return typeof v === "number" && v >= 0 && v <= 1 ? v : o.defaultOpacity === undefined ? 1 : o.defaultOpacity; }
const SEVERITY: Record<string, string> = { drcWarnings: "warning", drcErrors: "error", drcExclusions: "exclusion" };

// ---------------------------------------------------------------- presets (LAYER_PRESET)
// hiddenObjects: the preset's hidden Objects rows (LAYER_PRESET::renderLayers); `objAll` marks a list that holds every
// hidden row (older saved presets left out the rows hidden by default).  Built-in presets carry none: they take the
// objects of the last built-in preset (m_lastBuiltinPreset).  seqFirst: a built-in preset's first layer of its whole
// LSET, layers this board lacks included (doApplyLayerPreset).
interface Preset { name: string; layers: string[]; hiddenObjects?: string[]; objAll?: boolean; flip: boolean; active?: string; seqFirst?: string | null }
const FRONT_TECH = ["F.SilkS", "F.Mask", "F.Adhes", "F.Paste", "F.CrtYd", "F.Fab"], BACK_TECH = FRONT_TECH.map((l) => "B" + l.slice(1));
/** The built-in presets that cannot be deleted, evaluated against the board's layers. */
function builtinPresets(all: string[]): Preset[] {
  const cu = all.filter(isCu), has = (ls: string[]) => all.filter((l) => ls.includes(l));
  const edge = (ls: string[]) => Array.from(new Set(ls.concat(all.includes("Edge.Cuts") ? ["Edge.Cuts"] : [])));
  const out: Preset[] = [
    { name: "All Layers", layers: all.slice(), flip: false, seqFirst: "F.Cu" },
    { name: "No Layers", layers: [], flip: false, seqFirst: null },
    { name: "All Copper Layers", layers: edge(cu), flip: false, seqFirst: "F.Cu" },
    { name: "Inner Copper Layers", layers: edge(cu.filter((l) => l !== "F.Cu" && l !== "B.Cu")), flip: false, seqFirst: "In1.Cu" },
    { name: "Front Layers", layers: edge(has(["F.Cu", ...FRONT_TECH])), flip: false, seqFirst: "F.Cu" },
    { name: "Front Assembly View", layers: edge(has(["F.SilkS", "F.Mask", "F.Fab", "F.CrtYd"])), flip: false, active: "F.SilkS", seqFirst: "F.Mask" },
    { name: "Back Layers", layers: edge(has(["B.Cu", ...BACK_TECH])), flip: true, seqFirst: "B.Cu" },
    { name: "Back Assembly View", layers: edge(has(["B.SilkS", "B.Mask", "B.Fab", "B.CrtYd"])), flip: true, active: "B.SilkS", seqFirst: "B.Mask" },
  ];
  return out;
}

// ---------------------------------------------------------------- persisted state
interface UserPrefs { colors: Record<string, string>; objHidden: string[]; objOpacity: Record<string, number>; netColorMode: NetColorMode; ratsnestMode: RatsnestMode; opacityAbs?: boolean; rowsV2?: boolean }
interface Viewport { name: string; rect: [number, number, number, number] }
// netColors / classColors: only colours this session could not write into the project file ("" = cleared); colorsV2
// marks prefs from after the colours moved into the project (older ones kept them here only and are dropped)
interface ProjectPrefs { hidden: string[] | null; netColors: Record<string, string>; classColors: Record<string, string>; hiddenNets: string[]; hiddenClasses: string[]; presets: Preset[]; viewports: Viewport[]; viewport: string | null; contrastMode?: InactiveMode; colorsV2?: boolean }

const USER_KEY = "kui.appearance";
// the Footprint Editor keeps its own (FOOTPRINT_EDITOR_SETTINGS beside PCBNEW_SETTINGS)
const fpEditor = (): boolean => !!(kdoc() as { fpEditor?: boolean } | null)?.fpEditor;
const projKey = () => "kui.appearance." + (fpEditor() ? "fp." : "") + (projectId() || "x");
let user: UserPrefs = Object.assign({ colors: {}, objHidden: OBJECTS.filter((o) => o.defaultHidden).map((o) => o.id), objOpacity: {}, netColorMode: "ratsnest" as NetColorMode, ratsnestMode: "all" as RatsnestMode },
  loadJson<Partial<UserPrefs>>(USER_KEY, {}));
// rows added after a user's prefs were saved start as KiCad has them (Board Area Shadow hidden)
if (!user.rowsV2) { if (!user.objHidden.includes("boardArea")) user.objHidden.push("boardArea"); user.rowsV2 = true; }
// the Zones slider used to scale the fixed 0.6 zone opacity; it is the opacity itself now (as KiCad's): keep the look
// the Ratsnest radio's None is the global ratsnest switch, not a mode (UpdateDisplayOptions / onRatsnestMode)
if (user.ratsnestMode === "none") { user.ratsnestMode = "all"; if (!user.objHidden.includes("ratsnest")) user.objHidden.push("ratsnest"); }
if (!user.opacityAbs) { if (typeof user.objOpacity.zones === "number") user.objOpacity.zones = Math.round(user.objOpacity.zones * 60) / 100; user.opacityAbs = true; }
let proj: ProjectPrefs = emptyProj(); let projFor = "";
function emptyProj(): ProjectPrefs { return { hidden: null, netColors: {}, classColors: {}, hiddenNets: [], hiddenClasses: [], presets: [], viewports: [], viewport: null, colorsV2: true }; }
/** m_lastBuiltinPreset.renderLayers: the hidden Objects rows the built-in presets apply (null: GAL_SET::DefaultVisible). */
let lastBuiltinHidden: string[] | null = null;
function loadProj(): void {
  const k = projKey(); if (k === projFor) return; projFor = k; proj = Object.assign(emptyProj(), loadJson<Partial<ProjectPrefs>>(k, {}));
  if (!proj.colorsV2) { proj.netColors = {}; proj.classColors = {}; proj.colorsV2 = true; }
  // APPEARANCE_CONTROLS::SetUserViewports: the viewport choice starts at "---" each time the board is loaded
  proj.viewport = null;
  lastBuiltinHidden = null;
}
const saveUser = () => saveJson(USER_KEY, user);
const saveProj = () => saveJson(projKey(), proj);

// ---------------------------------------------------------------- nets and net classes
interface NetInfo { name: string; code: number; netclass: string }
let netCache: { doc: KDoc | null; version: number; pro: unknown; nets: NetInfo[]; classes: string[] } = { doc: null, version: -1, pro: null, nets: [], classes: [] };

interface ProNetSettings { classes?: { name?: string; pcb_color?: string }[]; net_colors?: Record<string, string> | null; netclass_assignments?: Record<string, string | string[]> | null; netclass_patterns?: { netclass?: string; pattern?: string }[] }
function netSettings(): ProNetSettings {
  try { const j = E.proSettings ? JSON.parse(E.proSettings as string) : null; return (j && j.net_settings) || {}; } catch (e) { return {}; }
}
function wildcard(p: string): RegExp { return new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); }
function nets(): { nets: NetInfo[]; classes: string[] } {
  const doc = kdoc(), P = pcbTools(), version = store.get().document.version;
  if (!doc || !P || isSchDoc()) return { nets: [], classes: [] };
  if (netCache.doc === doc && netCache.version === version && netCache.pro === E.proSettings) return netCache;
  const ns = netSettings(); let classes = ["Default"];
  for (const c of ns.classes || []) if (c && c.name && !classes.includes(c.name)) classes.push(c.name);
  classes = sortNetClasses(classes);   // rebuildNets: Default, then std::sort( names )
  const pats = (ns.netclass_patterns || []).filter((p) => p && p.pattern && p.netclass).map((p) => ({ re: wildcard(String(p.pattern)), cls: String(p.netclass) }));
  const assigned = ns.netclass_assignments || {};
  const classOf = (name: string): string => {
    const a = assigned[name]; const direct = Array.isArray(a) ? a[0] : a;
    const cls = direct || (pats.find((p) => p.re.test(name)) || { cls: "" }).cls;
    return cls && classes.includes(cls) ? cls : "Default";
  };
  let list: { name: string; code: number }[] = [];
  try { list = P.boardNets(doc); } catch (e) { list = []; }
  netCache = { doc, version, pro: E.proSettings, nets: list.map((n) => ({ name: n.name, code: n.code > 0 ? n.code : 0, netclass: classOf(n.name) })), classes };
  return netCache;
}

/** NETCLASS::GetSchematicColor: the class's "schematic_color" in the project, null when unspecified (transparent). */
export function classSchematicColor(name: string): string | null {
  const c = (netSettings().classes || []).find((x) => x && x.name === name) as { schematic_color?: string } | undefined;
  const v = c && typeof c.schematic_color === "string" ? c.schematic_color.replace(/\s+/g, "") : "";
  if (!v) return null;
  const [r, g, b, a] = parseColor(v);
  return a <= 0 ? null : rgba(r, g, b, a);
}

/** A colour as COLOR4D's JSON (ToCSSString): "rgb(r, g, b)" when opaque, else "rgba(r, g, b, a)" with three decimals. */
function cssColor(c: string): string {
  const [r, g, b, a] = parseColor(c), al = Math.round(Math.max(0, Math.min(1, a)) * 255);
  return al === 255 ? `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})` : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${(al / 255).toFixed(3)})`;
}
/** A project colour, null when it is unspecified (COLOR4D::UNSPECIFIED is transparent black). */
function projColor(v: unknown): string | null {
  const t = typeof v === "string" ? v.replace(/\s+/g, "") : "";
  if (!t) return null;
  const [r, g, b, a] = parseColor(t);
  return a <= 0 ? null : rgba(r, g, b, a);
}
/** NETCLASS::GetPcbColor (rebuildNets): the class's "pcb_color" in the project; this session's when the project file could not be written. */
function classPcbColor(name: string): string | null {
  if (Object.prototype.hasOwnProperty.call(proj.classColors, name)) return proj.classColors[name] || null;
  const c = (netSettings().classes || []).find((x) => x && x.name === name);
  return c ? projColor(c.pcb_color) : null;
}
/** NET_SETTINGS::m_netColorAssignments ("net_colors" in the project): the net's colour; this session's when the file could not be written. */
function netPcbColor(name: string): string | null {
  if (Object.prototype.hasOwnProperty.call(proj.netColors, name)) return proj.netColors[name] || null;
  const m = netSettings().net_colors;
  return m && typeof m === "object" ? projColor(m[name]) : null;
}
/** Write project-file edits and make the editor use the new file; false when it could not be saved. */
async function saveProjectEdits(edits: ProjectEdit[]): Promise<boolean> {
  const text = (E.proSettings as string | null) || null; if (!text || !canWriteProject()) return false;
  let res: { text: string; changed: ProjectEdit[] };
  try { res = editProject(text, edits); } catch (e) { return false; }
  if (!res.changed.length) return true;
  adoptProjectFile(res.text);
  return saveProjectFile(res.text, res.changed);
}
/** onNetclassColorChanged / ID_CLEAR_NET_COLOR: NETCLASS::SetPcbColor, kept in the project's net settings. */
function setClassColor(name: string, color: string | null): void {
  const ns = netSettings(); const classes = Array.isArray(ns.classes) ? ns.classes.map((c) => Object.assign({}, c)) : [];
  const i = classes.findIndex((c) => c && c.name === name);
  if (i < 0) { proj.classColors[name] = color || ""; saveProj(); return; }
  classes[i].pcb_color = color ? cssColor(color) : "rgba(0, 0, 0, 0.000)";
  proj.classColors[name] = color || ""; saveProj();   // shown at once; dropped when the file takes it
  void saveProjectEdits([{ path: ["net_settings", "classes"], value: classes as unknown as Plain }]).then((ok) => {
    if (ok) { delete proj.classColors[name]; saveProj(); applyAppearance(); publishAppearance(); }
  });
}
/** NET_GRID_TABLE::SetValueAsCustom( COL_COLOR ): the net's colour, saved with the project's net settings ("net_colors"). */
function setNetColor(name: string, color: string | null): void {
  const ns = netSettings(); const map: Record<string, string> = Object.assign({}, ns.net_colors && typeof ns.net_colors === "object" ? ns.net_colors : {});
  if (color) map[name] = cssColor(color); else delete map[name];
  proj.netColors[name] = color || ""; saveProj();
  void saveProjectEdits([{ path: ["net_settings", "net_colors"], value: map as unknown as Plain }]).then((ok) => {
    if (ok) { delete proj.netColors[name]; saveProj(); applyAppearance(); publishAppearance(); }
  });
}

/** The net class a net belongs to (project net settings: assignments, then patterns, else Default). */
export function netClassOf(name: string): string { const n = nets().nets.find((x) => x.name === name); return n ? n.netclass : "Default"; }
// ${NET_CLASS(pad)} in a board text (FOOTPRINT::ResolveTextVar: the pad's effective net class)
if (typeof KiCadCanvas !== "undefined" && KiCadCanvas.pcbVars) KiCadCanvas.pcbVars.netClass = netClassOf;

// ---------------------------------------------------------------- reading the editor's own toggles
const pcbState = () => { const P = pcbTools(); return P ? P.state : null; };
function inactiveMode(): InactiveMode { return !E.renderOpts.highContrast ? "normal" : E.renderOpts.inactiveHide ? "hide" : "dim"; }
function objectVisible(id: string): boolean {
  if (id === "grid") return !!E.gridOn;
  if (id === "ratsnest") { const s = pcbState(); return s ? !!s.showRatsnest : !user.objHidden.includes(id); }
  return !user.objHidden.includes(id);
}

function layerRows(doc: KDoc): LayerInfo[] {
  const K = KC() as unknown as { boardDefaultColor?(k: string): string; defaultPcbColor?(l: string): string; pcbColor(l: string): string };
  const hidden = E.hiddenLayers as Set<string>, theme = activeBoardColors();
  return boardLayerKeys(doc).map((key) => {
    // the swatch's default (COLOR_SETTINGS::GetDefaultColor) is KiCad Default's; its colour the frame theme's
    const def = K.boardDefaultColor ? K.boardDefaultColor(key) : K.defaultPcbColor ? K.defaultPcbColor(key) : K.pcbColor(key);
    // APPEARANCE_CONTROLS::rebuildLayers: the Footprint Editor names layers from its own settings' user layer names,
    // else GetStandardLayerName — never the holder board's names
    return { key, name: fpEditor() ? layerDisplayName(null, key) : layerDisplayName(doc, key), color: theme[key] || def, defaultColor: def, visible: !hidden.has(key), copper: isCu(key), tip: layerTip(key) };
  });
}
/** std::map order (m_layerPresets, m_viewports): wxString's ordinal comparison. */
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** APPEARANCE_CONTROLS::m_layerPresets: built-in and user presets in one alphabetical map. */
function allPresets(layers: string[]): Preset[] { return builtinPresets(layers).concat(proj.presets.filter((p) => !BUILTIN_NAMES.includes(p.name))).sort(byName); }
const BUILTIN_NAMES = ["All Layers", "No Layers", "All Copper Layers", "Inner Copper Layers", "Front Layers", "Front Assembly View", "Back Layers", "Back Assembly View"];

// ---------------------------------------------------------------- MRUs (EDA_VIEW_SWITCHER, Ctrl+Tab / Shift+Tab)
// m_presetMRU / m_viewportMRU: alphabetical when the presets are (re)loaded, then each preset or viewport applied,
// saved or overwritten moves to the front (Insert( name, 0 )); a deleted one leaves.
let presetMRU: string[] = [], viewportMRU: string[] = [], mruFor = "";
function syncMRU(mru: string[], names: string[], reset: boolean): string[] {
  if (reset) return names.slice();
  const have = new Set(names); const kept = mru.filter((n) => have.has(n));
  const fresh = names.filter((n) => !kept.includes(n));
  return fresh.concat(kept);
}
const toFront = (mru: string[], name: string): string[] => [name, ...mru.filter((n) => n !== name)];
/** The layer presets in most-recently-used order (APPEARANCE_CONTROLS::GetLayerPresetsMRU). */
export function layerPresetsMRU(): string[] { publishAppearance(); return presetMRU.slice(); }
/** The viewports in most-recently-used order (GetViewportsMRU). */
export function viewportsMRU(): string[] { publishAppearance(); return viewportMRU.slice(); }
/** APPEARANCE_CONTROLS::ApplyLayerPreset( name ): apply it and move it to the front of the MRU. */
export function applyLayerPresetByName(name: string): void {
  const p = allPresets(layerKeys()).find((x) => x.name === name); if (!p) return;
  // onLayerPresetChanged: leaving a built-in preset (or none) keeps the objects shown for the next built-in one
  const doc = kdoc(), cur = doc ? currentPreset(layerRows(doc)) : null;
  if (!cur || BUILTIN_NAMES.includes(cur)) lastBuiltinHidden = hiddenObjectsNow();
  applyPreset(p, presetHidden(p)); presetMRU = toFront(presetMRU, name); publishAppearance();
}
/** APPEARANCE_CONTROLS::ApplyViewport( name ). */
export function applyViewportByName(name: string): void {
  const v = proj.viewports.find((x) => x.name === name); if (!v) return;
  E.viewTouched = true; fitBox(v.rect, 1); proj.viewport = v.name; saveProj(); viewportMRU = toFront(viewportMRU, name); publishAppearance();
}
function sameSet(a: string[], b: string[]): boolean { if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }
/** getVisibleObjects, as the hidden Objects rows. */
function hiddenObjectsNow(): string[] { return OBJECTS.filter((o) => !o.spacer && o.canHide !== false && !objectVisible(o.id)).map((o) => o.id); }
const DEFAULT_HIDDEN = (): string[] => OBJECTS.filter((o) => o.defaultHidden).map((o) => o.id);
/** The hidden Objects rows a preset applies: a built-in one those of the last built-in preset (onLayerPresetChanged). */
function presetHidden(p: Preset): string[] {
  if (BUILTIN_NAMES.includes(p.name) || !p.hiddenObjects) return lastBuiltinHidden || DEFAULT_HIDDEN();
  return p.objAll ? p.hiddenObjects : Array.from(new Set(DEFAULT_HIDDEN().concat(p.hiddenObjects)));
}
/** syncLayerPresetSelection: the preset whose layers, objects and flip match what is shown. */
function currentPreset(layers: LayerInfo[]): string | null {
  const vis = layers.filter((l) => l.visible).map((l) => l.key), flip = !!E.renderOpts.flip;
  const hiddenObjs = hiddenObjectsNow();
  for (const p of allPresets(layers.map((l) => l.key))) {
    if (!sameSet(p.layers, vis) || p.flip !== flip) continue;
    if (!sameSet(presetHidden(p), hiddenObjs)) continue;
    return p.name;
  }
  return null;
}

/** Recompute the published Appearance state from the document, the editor's toggles and the saved prefs. */
export function publishAppearance(): void {
  const doc = kdoc();
  if (!doc || isSchDoc()) { panelStore.set({ appearance: Object.assign({}, panelStore.get().appearance, { layers: [], nets: [], netClasses: [], objects: [] }) }); return; }
  loadProj();
  const layers = layerRows(doc);
  const fp = fpEditor();
  const objects: ObjectRow[] = OBJECTS.filter((o) => !fp || FP_EDITOR_OBJECTS.includes(o.id)).map((o) => o.spacer ? { id: o.id, label: "", tip: "", spacer: true }
    : { id: o.id, label: o.label, tip: o.tip, canHide: o.canHide !== false, visible: o.canHide === false ? undefined : objectVisible(o.id), opacity: o.opacity ? objOpacity(o) : undefined,
      color: OBJECT_COLORS[o.id] ? objectColor(o.id) : undefined, defaultColor: OBJECT_COLORS[o.id] });
  const readOnly = themeReadOnly();
  const n = nets(); const s = pcbState();
  const hiddenNets = s ? s.hiddenNets : new Set(proj.hiddenNets);
  // NET_GRID_TABLE::Rebuild: nets with a code above 0, no "unconnected-(" nets, sorted by name
  const netRows: NetRow[] = appearanceNets(n.nets).map((x) => ({ name: x.name, code: x.code, color: netPcbColor(x.name), visible: !hiddenNets.has(x.name), netclass: x.netclass }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const classRows: NetClassRow[] = n.classes.map((name) => ({ name, color: name === "Default" ? null : classPcbColor(name), visible: !proj.hiddenClasses.includes(name), schColor: classSchematicColor(name) }));
  const names = layers.map((l) => l.key);
  const reset = mruFor !== projFor; mruFor = projFor;
  presetMRU = syncMRU(presetMRU, allPresets(names).map((p) => p.name), reset);
  const vps = proj.viewports.slice().sort(byName);
  viewportMRU = syncMRU(viewportMRU, vps.map((v) => v.name), reset);
  const ap: AppearanceState = {
    fpEditor: fp, layers, active: E.activeLayer || "", objects, nets: netRows, netClasses: classRows,
    inactive: inactiveMode(), flip: !!E.renderOpts.flip, netColorMode: user.netColorMode, ratsnestMode: ratsnestRadio(objectVisible("ratsnest"), user.ratsnestMode),
    presets: allPresets(names).map((p) => p.name), builtinPresets: builtinPresets(names).sort(byName).map((p) => p.name), preset: currentPreset(layers),
    viewports: vps.map((v) => v.name), viewport: proj.viewport, readOnlyColors: readOnly,
  };
  panelStore.set({ appearance: ap });
}

/** Push the saved prefs into the renderer options and the pcb module's ratsnest state, then repaint. */
export function applyAppearance(): void {
  const doc = kdoc(); if (!doc || isSchDoc()) return;
  loadProj();
  const ro = E.renderOpts as Record<string, unknown>;
  // the layer and object colours are the frame's colour theme, which the canvas paints itself (KiCadCanvas.setBoardColors)
  migrateLegacyColors();
  ro.layerColors = undefined;
  const hide = new Set(user.objHidden.filter((id) => !["grid", "ratsnest", "anchors", "lockedShadow", "drawingSheet", "drcWarnings", "drcErrors", "drcExclusions", "conflicts", "boardArea", "subgrids", "viaStitching", "constraintShadow"].includes(id)));
  const show = new Set<string>(); for (const id of ["anchors", "lockedShadow", "boardArea", "viaStitching"]) if (!user.objHidden.includes(id)) show.add(id);
  // every opacity row goes to the renderer: zones and images default to 0.6, which is not the renderer's own default
  const opacity: Record<string, number> = {}; for (const o of OBJECTS) if (o.opacity) opacity[o.id] = objOpacity(o);
  ro.objects = { hide, show, opacity };
  const P = pcbTools();
  if (show.has("lockedShadow") && P) { const ids = new Set<string>(); for (const it of doc.items.values()) { try { if (P.isLocked(it.node)) ids.add(it.id); } catch (e) { /* not lockable */ } } ro.lockedIds = ids; }
  else ro.lockedIds = undefined;
  // the Objects swatches the user changed (the user's colour theme): the renderer's object layers and the grid
  ro.objectColors = undefined;
  ro.frame = user.objHidden.includes("drawingSheet") ? false : undefined;
  ro.subgrids = user.objHidden.includes("subgrids") ? false : undefined;   // LAYER_SUBGRIDS: the board's grid items
  // LAYER_BOARD_OUTLINE_AREA: the board outline filled under everything (PCB_PAINTER::draw( PCB_BOARD_OUTLINE ))
  if (show.has("boardArea") && P && (P as unknown as { boardOutline?: (d: KDoc) => { outline: number[][] | null } }).boardOutline) {
    try { const o = (P as unknown as { boardOutline: (d: KDoc) => { outline: number[][] | null } }).boardOutline(doc).outline; ro.boardArea = o && o.length > 2 ? [o] : undefined; } catch (e) { ro.boardArea = undefined; }
  } else ro.boardArea = undefined;
  // net colours: a net's own colour wins over its class colour (NET_GRID_TABLE / netclass colours)
  const n = nets(); const byName = new Map<string, string>(), byCode = new Map<number, string>();
  for (const x of n.nets) { const c = netPcbColor(x.name) || (x.netclass === "Default" ? null : classPcbColor(x.netclass)); if (c) { byName.set(x.name, c); if (x.code > 0) byCode.set(x.code, c); } }
  ro.netColors = user.netColorMode === "all" && byCode.size ? byCode : undefined;
  // boards that name nets inline carry no net codes: colour by item (pads by their index in the footprint)
  let itemColors: Map<string, string | (string | undefined)[]> | undefined;
  if (user.netColorMode === "all" && byName.size) {
    const h = (window.CollabTools.props as unknown as { helpers: { netNameOf(doc: KDoc, n: SNode): string } }).helpers, K = KC();
    itemColors = new Map();
    for (const it of doc.items.values()) {
      if (it.kind === "footprint") { let any = false; const arr = K.kids(it.node, "pad").map((p) => { const c = byName.get(h.netNameOf(doc, p)); if (c) any = true; return c; }); if (any) itemColors.set(it.id, arr); }
      else if (K.kid(it.node, "net")) { const c = byName.get(h.netNameOf(doc, it.node)); if (c) itemColors.set(it.id, c); }
    }
  }
  ro.itemColors = itemColors && itemColors.size ? itemColors : undefined;
  const s = pcbState();
  if (s) {
    // the ratsnest hides nets one by one (hideNetInRatsnest); a class eye only writes its nets into that set (showNetclass)
    s.hiddenNets = new Set(proj.hiddenNets);
    (s as { ratsnestMode?: string }).ratsnestMode = user.ratsnestMode === "visible" ? "visible" : "all";   // RATSNEST_MODE
    s.ratsnestColors = user.netColorMode !== "off" && byName.size ? byName : null;
    s.ratsnestBase = null;   // LAYER_RATSNEST of the live theme (pcb-tools ratsnestColor)
    s.netColorMode = user.netColorMode;
    s.showCourtyardConflicts = !user.objHidden.includes("conflicts");   // LAYER_CONFLICTS_SHADOW   // the router preview takes net colours only in the "all" mode (ROUTER_PREVIEW_ITEM::getLayerColor)
    const sev = new Set<string>(); for (const [id, name] of Object.entries(SEVERITY)) if (user.objHidden.includes(id)) sev.add(name);
    s.hiddenSeverities = sev.size ? sev : null;
  }
  const markers = (E.markers as { severity?: string }[]) || [];
  const shown = markers.filter((m) => !(m.severity === "warning" && user.objHidden.includes("drcWarnings")) && !(m.severity === "error" && user.objHidden.includes("drcErrors")) && !(m.severity === "exclusion" && user.objHidden.includes("drcExclusions")));
  ro.markers = shown.length ? shown : undefined;
  store.slice("viewport", { renderOpts: Object.assign({}, E.renderOpts) });
  requestRender();
}

// ---------------------------------------------------------------- layer visibility
function setHidden(hidden: Set<string>): void {
  E.hiddenLayers = hidden; proj.hidden = Array.from(hidden); saveProj();
  store.slice("document", { hiddenLayers: Array.from(hidden) });
  requestRender();
}
function layerKeys(): string[] { const doc = kdoc(); return doc ? boardLayerKeys(doc) : []; }
function setVisibleLayers(visible: string[]): void { const v = new Set(visible); setHidden(new Set(layerKeys().filter((l) => !v.has(l)))); }

function setFlip(on: boolean): void { E.renderOpts.flip = !!on; setToggles({ flipBoard: !!on }); }
function setInactive(mode: InactiveMode, save = true): void {
  E.renderOpts.highContrast = mode !== "normal"; E.renderOpts.inactiveHide = mode === "hide";
  setToggles({ highContrastMode: mode !== "normal" });
  // PCB_DISPLAY_OPTIONS::m_ContrastModeDisplay is the project's local setting ("board.high_contrast_mode" in the
  // .kicad_prl, PROJECT_LOCAL_SETTINGS), kept with the other .kicad_prl items of this project, not in the board file
  if (save && (proj.contrastMode || "normal") !== mode) { if (mode === "normal") delete proj.contrastMode; else proj.contrastMode = mode; saveProj(); }
}
/** The board's inactive layer display mode (Preferences ▸ PCB Editor ▸ Display Options reads and sets it too). */
export function getInactiveMode(): InactiveMode { return inactiveMode(); }
export function setInactiveMode(mode: InactiveMode): void { if (isSchDoc() || !kdoc()) return; setInactive(mode); applyAppearance(); publishAppearance(); }
/** PCB_CONTROL::NetColorModeCycle ("Net Color Mode (3-state)"): all -> ratsnest -> off -> all. */
export function cycleNetColorMode(): void {
  if (isSchDoc() || !kdoc()) return;
  appearanceDispatch({ t: "netColorMode", mode: user.netColorMode === "all" ? "ratsnest" : user.netColorMode === "ratsnest" ? "off" : "all" });
}
/** PCB_CONTROL::RatsnestModeCycle ("Ratsnest Mode (3-state)"): hidden -> all layers -> visible layers -> hidden. */
export function cycleRatsnestMode(): void {
  if (isSchDoc() || !kdoc()) return;
  const r = ratsnestCycle(objectVisible("ratsnest"), user.ratsnestMode);
  appearanceDispatch({ t: "ratsnestMode", mode: r.show ? r.mode : "none" });
}
const CONTRAST_LABELS: [InactiveMode, string][] = [["normal", "Normal"], ["dim", "Dimmed"], ["hide", "Hidden"]];
/** View ▸ Inactive Layer View Mode (ACTIONS::highContrastMode, PCB_CONTROL::HighContrastMode): normal ⇄ dimmed. */
export function toggleInactiveMode(): void {
  if (isSchDoc()) return;
  setInactive(inactiveMode() === "normal" ? "dim" : "normal"); applyAppearance(); publishAppearance();
}
/**
 * H — Inactive Layer View Mode (3-state) (ACTIONS::highContrastModeCycle, PCB_CONTROL::HighContrastModeCycle):
 * normal → dimmed → hidden → normal, with the HOTKEY_CYCLE_POPUP feedback of ContrastModeFeedback.
 */
export function cycleInactiveMode(): void {
  if (isSchDoc()) return;
  const cur = inactiveMode(), next: InactiveMode = cur === "normal" ? "dim" : cur === "dim" ? "hide" : "normal";
  setInactive(next); applyAppearance(); publishAppearance();
  hotkeyCyclePopup("Inactive Layer Display", CONTRAST_LABELS.map((l) => l[1]), CONTRAST_LABELS.findIndex((l) => l[0] === next));
}
// PCB_CONTROL::LayerAlphaInc / LayerAlphaDec: the active layer's colour alpha in steps of 0.05, kept within 0.2 .. 1
const ALPHA_MIN = 0.2, ALPHA_MAX = 1, ALPHA_STEP = 0.05;
/**
 * { and } — Decrease / Increase Layer Opacity: COLOR_SETTINGS::SetColor on the frame's theme in memory (a built-in theme
 * too), which lasts the session; the canvas repaints with it.
 */
export function layerAlphaStep(dir: 1 | -1): boolean {
  const doc = kdoc(), key = E.activeLayer as string; if (!doc || isSchDoc() || !key) return false;
  const K = KC(), cur = themeColor(key) || K.pcbColor(key), [r, g, b, a] = parseColor(cur);
  const want = Math.round((a + dir * ALPHA_STEP) * 100) / 100;
  if (dir > 0 ? a > ALPHA_MAX - ALPHA_STEP + 1e-6 : a < ALPHA_MIN + ALPHA_STEP - 1e-6) return false;   // KiCad rings the bell
  // from below the floor (the picker's Opacity slider goes to 0) } steps up from there, as KiCad does; the
  // renderer draws anything under 0.2 at 0.2 (PCB_RENDER_SETTINGS::LoadColors)
  const c = rgba(r, g, b, Math.max(0, Math.min(ALPHA_MAX, want)));
  const p = prefs(); setSessionBoardColor(boardThemeId(p, fpEditor()), key, c);
  applyAppearance(); publishAppearance();
  return true;
}
/**
 * APPEARANCE_CONTROLS::doApplyLayerPreset: the layers, the objects (`hidden`; null keeps them), the active layer (the
 * preset's, else the first of its layers when the current one is not among them) and the flip (null keeps it).
 */
function applyPreset(p: Preset, hidden: string[] | null, flip: boolean | null = p.flip): void {
  setVisibleLayers(p.layers);
  if (hidden) { const keep = user.objHidden.filter((id) => !OBJECTS.some((o) => o.id === id && !o.spacer && o.canHide !== false)); user.objHidden = keep.concat(hidden); saveUser(); setGridAndRatsnest(); }
  const all = layerKeys(), a = presetActiveLayer(p, String(E.activeLayer || ""), all);
  if (a) setActiveLayer(a);
  if (flip !== null) setFlip(flip);
}
function setGridAndRatsnest(): void {
  const wantGrid = !user.objHidden.includes("grid");
  if (!!E.gridOn !== wantGrid) { E.gridOn = wantGrid; setToggles({ toggleGrid: wantGrid }); store.slice("viewport", { gridOn: wantGrid }); }
  const s = pcbState(); if (s) s.showRatsnest = !user.objHidden.includes("ratsnest");
}

function layerMenu(cmd: LayerMenuCmd): void {
  const all = layerKeys(), hidden = new Set(E.hiddenLayers as Set<string>);
  const cu = all.filter(isCu), nonCu = all.filter((l) => !isCu(l));
  // OnLayerContextMenu: an unnamed preset with the current objects and flip, only its layers from the built-in one
  const preset = (name: string) => { const p = builtinPresets(all).find((x) => x.name === name); if (p) applyPreset({ name: "", layers: p.layers, flip: p.flip, seqFirst: p.seqFirst }, null, null); };
  const afterHide = () => { const a = activeAfterHide(all.filter((l) => !hidden.has(l)), String(E.activeLayer || "")); if (a) setActiveLayer(a); setHidden(hidden); };
  switch (cmd) {
    case "showAllCu": for (const l of cu) hidden.delete(l); setHidden(hidden); break;
    case "hideAllCu": for (const l of cu) hidden.add(l); afterHide(); break;
    case "hideAllButActive": applyPreset({ name: "", layers: all.filter((l) => l === E.activeLayer), flip: false }, null, null); break;
    case "showAllNonCu": for (const l of nonCu) hidden.delete(l); setHidden(hidden); break;
    case "hideAllNonCu": for (const l of nonCu) hidden.add(l); afterHide(); break;
    case "showAll": preset("All Layers"); break;
    case "hideAll": preset("No Layers"); break;
    case "frontAssembly": preset("Front Assembly View"); break;
    case "front": preset("Front Layers"); break;
    case "inner": preset("Inner Copper Layers"); break;
    case "back": preset("Back Layers"); break;
    case "backAssembly": preset("Back Assembly View"); break;
  }
}

// ---------------------------------------------------------------- nets
/** APPEARANCE_CONTROLS::showNetclass: show or hide the ratsnest of every net of the class; the class eye is remembered (m_HiddenNetclasses). */
function showNetclass(name: string, show: boolean): void {
  const classNets = nets().nets.filter((n) => n.netclass === name).map((n) => n.name);
  proj.hiddenNets = showNetclassNets(proj.hiddenNets, classNets, show);
  const hc = new Set(proj.hiddenClasses); if (show) hc.delete(name); else hc.add(name); proj.hiddenClasses = Array.from(hc);
  saveProj();
}
export function netIds(names: string[], kinds?: string[]): Set<string> {
  const doc = kdoc(), P = pcbTools(), out = new Set<string>(); if (!doc || !P) return out;
  for (const name of names) for (const id of P.netItemIds(doc, name)) { const it = doc.items.get(id); if (it && (!kinds || kinds.includes(it.kind))) out.add(id); }
  return out;
}
export function netCommand(cmd: NetCmd, names: string[], label: string): void {
  const ctx = tctx();
  if (cmd === "highlight") {
    const doc = kdoc(), P = pcbTools(), ids = new Set<string>();
    if (doc && P && names.length) {
      const list = P.netlist(doc);
      for (const name of names) for (const id of P.netHighlightIds(doc, name, list)) ids.add(id);
    }
    ctx.setHighlight(ids.size ? ids : null, names);
    const s = pcbState(); if (s) s.highlightNet = names[0] || null;
    if (!ids.size && names.length) toast(`Nothing on ${label}`);
    return;
  }
  if (cmd === "select" || cmd === "unselect") {
    const ids = netIds(names, ["segment", "arc", "via"]);
    const cur = new Set<string>(E.selection as Set<string>); const s = pcbState(); if (s) for (const id of s.sel) cur.add(id);
    if (cmd === "select") for (const id of ids) cur.add(id); else for (const id of ids) cur.delete(id);
    if (s) s.sel.clear();
    (ctx as unknown as { setSelection(ids: string[]): void }).setSelection(Array.from(cur));
    return;
  }
}

async function savePreset(): Promise<void> {
  const st = panelStore.get().appearance; const builtin = st.builtinPresets;
  const name = await textEntry("Save Layer Preset", "Layer preset name:", st.preset && !builtin.includes(st.preset) ? st.preset : "");
  if (name === null) return; const nm = name.trim(); if (!nm) return;
  if (builtin.includes(nm)) { await messageBox("Error", "Default presets cannot be modified.\nPlease use a different name."); return; }
  // LAYER_PRESET( name, getVisibleLayers(), getVisibleObjects(), UNSELECTED_LAYER, flip ): no active layer of its own
  const p: Preset = { name: nm, layers: st.layers.filter((l) => l.visible).map((l) => l.key), hiddenObjects: hiddenObjectsNow(), objAll: true, flip: st.flip };
  const i = proj.presets.findIndex((x) => x.name === nm);
  if (i >= 0) { if (!await confirmBox("Save Layer Preset", "Overwrite existing preset?", "Overwrite")) return; proj.presets[i] = p; } else proj.presets.push(p);
  saveProj(); publishAppearance(); presetMRU = toFront(presetMRU, nm); publishAppearance();
}
async function deletePreset(): Promise<void> {
  const name = await listPick("Delete Preset", "Select preset:", "Presets", proj.presets.map((p) => p.name));
  if (!name) return;
  proj.presets = proj.presets.filter((p) => p.name !== name); saveProj(); publishAppearance();
}
async function saveViewport(): Promise<void> {
  const name = await textEntry("Save Viewport", "Viewport name:", ""); if (name === null) return; const nm = name.trim(); if (!nm) return;
  const r = visibleRectNm() as number[] | null; if (!r) return;
  const rect = r.map((v) => v / (E.IU as number)) as [number, number, number, number];
  const i = proj.viewports.findIndex((v) => v.name === nm);
  if (i >= 0) proj.viewports[i] = { name: nm, rect }; else proj.viewports.push({ name: nm, rect });
  proj.viewport = nm; saveProj(); publishAppearance(); viewportMRU = toFront(viewportMRU, nm); publishAppearance();
}
async function deleteViewport(): Promise<void> {
  const name = await listPick("Delete Viewport", "Select viewport:", "Viewports", proj.viewports.map((v) => v.name));
  if (!name) return;
  proj.viewports = proj.viewports.filter((v) => v.name !== name); if (proj.viewport === name) proj.viewport = null; saveProj(); publishAppearance();
}

/** The Appearance pane's intents; returns false for an action that is not ours. */
export function appearanceDispatch(a: PanelAction): boolean {
  loadProj();
  switch (a.t) {
    case "layerVisible": { const h = new Set(E.hiddenLayers as Set<string>); if (a.on) h.delete(a.key); else h.add(a.key); setHidden(h); break; }
    case "layerActive": setActiveLayer(a.key); break;
    // APPEARANCE_CONTROLS::OnColorSwatchChanged; "Reset to Default" in the picker gives COLOR_SETTINGS::GetDefaultColor
    case "layerColor": { const K = KC() as unknown as { boardDefaultColor?(k: string): string; pcbColor(l: string): string }; setThemeColor(a.key, a.color || (K.boardDefaultColor ? K.boardDefaultColor(a.key) : K.pcbColor(a.key))); break; }
    case "readOnlySwatch": readOnlySwatchNotice(); return true;
    case "layerMenu": layerMenu(a.cmd); break;
    case "objVisible": {
      user.objHidden = objectVisibilityChange(user.objHidden, a.id, a.on); saveUser();   // onObjectVisibilityChanged
      if (a.id === "grid") setGridAndRatsnest();
      if (a.id === "ratsnest") { const s = pcbState(); if (s) s.showRatsnest = a.on; }
      break;
    }
    case "objOpacity": user.objOpacity[a.id] = Math.max(0, Math.min(1, a.value)); saveUser(); break;
    // APPEARANCE_CONTROLS::OnColorSwatchChanged: the object layer's colour in the user's colour theme
    case "objColor": { const k = OBJECT_THEME_KEYS[a.id]; if (k) setThemeColor(k, a.color || OBJECT_COLORS[a.id]); break; }
    // m_btnNetInspector: PCB_ACTIONS::showNetInspector; m_btnConfigureNetClasses: ShowBoardSetupDialog( _( "Net Classes" ) )
    case "showNetInspector": showPane("netinsp", true); return true;
    case "boardSetup": void openBoardSetup(tctx() as never, a.page); return true;
    case "inactive": setInactive(a.mode); break;
    case "flip": setFlip(a.on); break;
    case "netVisible": { const s = new Set(proj.hiddenNets); if (a.on) s.delete(a.name); else s.add(a.name); proj.hiddenNets = Array.from(s); saveProj(); break; }
    case "netColor": setNetColor(a.name, a.color); break;
    case "netCmd":
      if (a.cmd === "showAll") { proj.hiddenNets = []; saveProj(); }
      // NET_GRID_TABLE::HideOtherNets: every listed net but this one
      else if (a.cmd === "hideOthers") { const listed = appearanceNets(nets().nets).map((n) => n.name); proj.hiddenNets = Array.from(new Set(proj.hiddenNets.filter((n) => !listed.includes(n)).concat(listed.filter((n) => n !== a.name)))); saveProj(); }
      else netCommand(a.cmd, [a.name], a.name);
      break;
    case "classVisible": showNetclass(a.name, a.on); break;
    case "classColor": setClassColor(a.name, a.color); break;
    case "classCmd":
      if (a.cmd === "showAll") { for (const c of nets().classes) showNetclass(c, true); }
      else if (a.cmd === "hideOthers") { for (const c of nets().classes) showNetclass(c, c === a.name); }
      else netCommand(a.cmd, nets().nets.filter((n) => n.netclass === a.name).map((n) => n.name), a.name);
      break;
    case "netColorMode": user.netColorMode = a.mode; saveUser(); break;
    // onRatsnestMode: All / Visible set the mode and show the ratsnest, None only hides it
    case "ratsnestMode": { const r = ratsnestFromRadio(a.mode, user.ratsnestMode); user.ratsnestMode = r.mode; user.objHidden = user.objHidden.filter((o) => o !== "ratsnest").concat(r.show ? [] : ["ratsnest"]); saveUser(); const s = pcbState(); if (s) s.showRatsnest = r.show; break; }
    case "preset": applyLayerPresetByName(a.name); break;
    case "presetSave": void savePreset(); return true;
    case "presetDelete": void deletePreset(); return true;
    case "viewport": applyViewportByName(a.name); break;
    case "viewportSave": void saveViewport(); return true;
    case "viewportDelete": void deleteViewport(); return true;
    default: return false;
  }
  applyAppearance(); publishAppearance();
  return true;
}

/** A board was opened: bring back this project's layer visibility, then apply and publish everything. */
export function appearanceDocOpened(): void {
  if (isSchDoc() || !kdoc()) { publishAppearance(); return; }
  loadProj();
  // the Footprint Editor starts with every layer shown (makeFpHolderBoard: SetVisibleAlls), never a saved set
  if (proj.hidden && !fpEditor()) { const keys = new Set(layerKeys()); E.hiddenLayers = new Set(proj.hidden.filter((l) => keys.has(l))); store.slice("document", { hiddenLayers: Array.from(E.hiddenLayers as Set<string>) }); }
  if (user.objHidden.includes("grid") && E.gridOn) setGridAndRatsnest();
  const m = proj.contrastMode, mode: InactiveMode = m === "dim" || m === "hide" ? m : "normal";
  if (mode !== inactiveMode()) setInactive(mode, false);
  applyAppearance(); publishAppearance();
}

/** The object class a board item is drawn under (Appearance ▸ Objects), for hit-test gating: a hidden class is not pickable. */
export function itemObjectHidden(it: KItem): boolean {
  if (isSchDoc()) return false;
  const h = user.objHidden;
  if (!h.length) return false;
  switch (it.kind) {
    case "segment": case "arc": return h.includes("tracks");
    case "via": return h.includes("vias");
    case "zone": return h.includes("zones");
    case "image": return h.includes("images");
    case "footprint": return h.includes(it.layer && /^B\./.test(it.layer) ? "fpBack" : "fpFront");
    default: return false;
  }
}
