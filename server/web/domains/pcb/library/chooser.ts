// library/chooser.ts — KiCad's "Choose Symbol" / "Choose Footprint" dialogs and the library
// browsers (eeschema/dialogs/dialog_symbol_chooser.cpp, panel_symbol_chooser.cpp,
// pcbnew/widgets/panel_footprint_chooser.cpp, common/widgets/lib_tree.cpp): the filter box over
// the library tree with its "-- Recently Used --" and "-- Already Placed --" groups and the
// Item / Description columns, the details pane under it, the preview on the right (symbol unit
// over its default footprint, or the footprint alone), "Place repeated copies" / "Place all
// units" and Cancel / OK.  A double click or Enter on an item accepts it.
import { bodyStyleNames, compileLibSearch, footprintDetailsHtml, footprintInfo, isPowerRow, libSearchTerms, parseLibId, pushRecentSearch, scoreItem, strNumCmpNoCase, symbolDetailsHtml, symbolInfo, symbolNodeOf, unitDisplayName } from "./core";
import type { SymbolInfo } from "./core";
import { clearPreview, freshView, renderChooserFootprint, renderChooserSymbol, type PaneFrame, type PaneView } from "./preview";
import { fetchItem, libraryIndex, officialLibraries, onSourcesChanged, placedItems, projectLibraries, recentItems, registeredSources, rememberRecent, symbolUnitNames } from "./sources";
import type { FetchedItem, LibItem, LibKind, LibraryEntry, LibrarySource, SourceContext } from "./sources";
import { chooserPins, filterLabels, footprintPasses, footprintSelectEntries, symbolFpFilters, type FpChooserFilters } from "./fpchoice";
import { previewBoardText } from "./model3d";
import "../../../shared/components/kselect";   // <k-select>, the themed drop-down these use in place of <select>
import { popupMenu, type PopItem } from "../dialogs/dom";
import { openDatasheet } from "../dialogs/browse-cells";
import { modelPreview, type PreviewApi } from "../editor/pcbdialogs/model3d";
import { close3DViewer, show3DViewerOn } from "../editor/viewer3d-loader";
import { bitmapButton, bitmapToggle, ensureIconCss, kicadIcon, CLOSE_MARK_SVG } from "../../../shared/components/kicon-dom";
import { loadPinnedLibs, savePinnedLibs } from "./pinned";

export interface ChooserOptions {
  /** The power tool's chooser: only power symbols. */
  power?: boolean;
  /** The library browser: the same tree, read as a browser ("Add … to …" instead of OK, no placement options). */
  browser?: boolean;
  /** SYMBOL_CHOOSER_FRAME: a dialog picks a lib id ("Symbol Chooser"): no placement options, no footprint panes, its
   *  own history; `preselect` is the id it starts on. */
  picker?: boolean;
  title?: string;
  /** Text the filter starts with. */
  filter?: string;
  /** The document cannot be edited: browsing only. */
  viewOnly?: boolean;
  /** FOOTPRINT_CHOOSER_FRAME's MAIL_SYMBOL_NETLIST: the symbol's pin count and footprint filters, offered as the
   *  "Filter by pin count (n)" / "Apply footprint filters (…)" check boxes under the filter box. */
  fpFilters?: FpChooserFilters | null;
  /** PANEL_FOOTPRINT_CHOOSER::SetPreselect: the item ("Lib:Name") selected and shown when the tree opens. */
  preselect?: string;
  /** Only the libraries (a field's value is picked: a vendor search result has no library id to write back). */
  noSources?: boolean;
  /** Kept for the callers that set it: every accepted footprint joins "-- Recently Used --" (AddFootprintToHistory). */
  history?: boolean;
  /** PANEL_SYMBOL_CHOOSER's aShowFootprints (eeschema m_Appearance.footprint_preview): the footprint selector and
   *  preview under the symbol (never in the power chooser or the picker). */
  showFootprints?: boolean;
  /** SYMBOL_PREVIEW_WIDGET autoplaces the previewed symbol's fields (m_AutoplaceFields.enable): the helper, or null. */
  autoplace?: ((doc: KDoc, item: KItem) => SNode | null) | null;
  /** The board editor's grid (mm) behind the footprint previews; 0 or unset for none. */
  grid?: number;
}

export interface Chosen {
  kind: LibKind;
  item: LibItem;
  /** PANEL_SYMBOL_CHOOSER's "Body style:" choice (1 when the symbol has one body style). */
  bodyStyle?: number;
  libId?: string;
  fpid?: string;
  symbol?: string;
  footprint?: string;
  /** The fields the placed item gets: the source's own values with the chooser's edits over them. */
  fields?: Record<string, string>;
  /** PANEL_SYMBOL_CHOOSER::GetFields: only the chooser's edits (the footprint picked in the footprint selector). */
  fieldEdits?: Record<string, string>;
  unit: number;
  /** "Place repeated copies" */
  keep: boolean;
  /** "Place all units" */
  allUnits: boolean;
}

interface Group {
  key: string;
  label: string;
  description: string;
  type: "recent" | "placed" | "lib" | "source";
  entry?: LibraryEntry;
  src?: LibrarySource;
  items: LibItem[] | null;
  loading: boolean;
  error: string;
}
interface Row { key: string; depth: 0 | 1 | 2; group: Group; item?: LibItem; unit?: number; label: string; description: string; expandable: boolean; expanded: boolean }

const ROW_H = 22;
const esc = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
.klib-dialog { width: min(1040px, 96vw); height: min(700px, 92vh); max-width: 98vw; max-height: 96vh; min-width: 640px; min-height: 420px; resize: both; overflow: hidden; }
.klib-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 10px 0; }
.klib-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(320px, 1.15fr) 5px minmax(240px, 1fr); }
.klib-left { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.klib-split { cursor: col-resize; }
.klib-hsplit { height: 5px; flex: none; cursor: row-resize; }
.klib-search { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; }
.klib-search .klib-filter { flex: 1; min-width: 0; margin-bottom: 0; }
.klib-search .klib-vsep { width: 1px; align-self: stretch; margin: 3px 0; background: var(--line); }
.klib-filter .klib-recent { cursor: pointer; }
.klib-bodysel { display: flex; align-items: center; gap: 6px; color: var(--ink-2); }
.klib-bodysel k-select { flex: 1; min-width: 0; }
.klib-filter { display: flex; align-items: center; gap: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-2); padding: 0 6px; margin-bottom: 6px; }
.klib-filter:focus-within { border-color: var(--blue); }
.klib-filter svg { flex: none; color: var(--ink-2); }
.klib-filter input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font: 12px var(--font); padding: 5px 0; }
.klib-filter .klib-clear { cursor: pointer; color: var(--ink-2); padding: 0 2px; visibility: hidden; }
.klib-filter.has-text .klib-clear { visibility: visible; }
.klib-head { display: grid; grid-template-columns: var(--klib-cols, var(--klib-col, 46%) 1fr); border: 1px solid var(--line); border-bottom: 0; background: var(--panel-2); font-weight: 600; color: var(--ink-2); }
.klib-head span { padding: 3px 8px; border-right: 1px solid var(--line); white-space: nowrap; overflow: hidden; }
.klib-head span:last-child { border-right: 0; }
.klib-head span:first-child { position: relative; overflow: visible; }
.klib-colgrip { position: absolute; top: 0; bottom: 0; right: -3px; width: 7px; cursor: col-resize; z-index: 1; }
.klib-tree { flex: 1; min-height: 80px; overflow: auto; border: 1px solid var(--line); background: var(--panel); outline: 0; position: relative; }
.klib-rows { position: relative; }
.klib-row { position: absolute; left: 0; right: 0; height: ${ROW_H}px; line-height: ${ROW_H}px; display: grid; grid-template-columns: var(--klib-cols, var(--klib-col, 46%) 1fr); cursor: default; white-space: nowrap; user-select: none; }
.klib-row:hover { background: color-mix(in srgb, var(--ink) 6%, transparent); }
.klib-row.sel { background: var(--accent); color: var(--on-accent); }
.klib-row.sel .klib-desc { color: var(--on-accent); }
.klib-row .klib-item { overflow: hidden; text-overflow: ellipsis; padding-right: 8px; }
.klib-row .klib-desc { overflow: hidden; text-overflow: ellipsis; color: var(--ink-2); padding: 0 8px; }
.klib-row.lib .klib-item { font-weight: 600; }
.klib-row.derived .klib-item { font-style: italic; }
.klib-row.note .klib-item { color: var(--ink-2); font-style: italic; font-weight: 400; }
.klib-row.sel.note .klib-item { color: var(--on-accent); }
.klib-spin { display: inline-block; width: 10px; height: 10px; margin: 0 6px 0 2px; border: 2px solid color-mix(in srgb, var(--ink) 25%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: klib-spin .7s linear infinite; vertical-align: -1px; }
.klib-row.sel .klib-spin { border-color: color-mix(in srgb, var(--on-accent) 35%, transparent); border-top-color: var(--on-accent); }
@keyframes klib-spin { to { transform: rotate(360deg); } }
.klib-tw { display: inline-block; width: 16px; text-align: center; color: var(--ink-2); font-size: 9px; }
.klib-row.sel .klib-tw { color: var(--on-accent); }
.klib-filters { display: flex; flex-direction: column; padding-left: 4px; }
.klib-filters label { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.klib-filters input[type=checkbox] { width: auto; margin: 0; flex: none; }
.klib-details { height: 132px; flex: none; overflow: auto; border: 1px solid var(--line); border-top: 0; background: var(--panel); padding: 6px 10px; line-height: 1.45; }
.klib-details.wide { border-top: 1px solid var(--line); }
.klib-details hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
.klib-details table { border-collapse: collapse; }
.klib-details td { vertical-align: top; padding: 0 10px 0 0; }
.klib-details a { color: var(--blue); cursor: pointer; }
.klib-right { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: 6px; }
.klib-pane { position: relative; flex: 1; min-height: 60px; border: 1px solid var(--line); overflow: hidden; }
.klib-pane canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.klib-pane canvas.klib-ruler { pointer-events: none; }
.klib-pane .klib-msg { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; color: var(--ink-3); font-size: 12px; pointer-events: none; }
.klib-pane-3d .pd-3dprev { position: absolute; inset: 0; }
.klib-fpsel { display: flex; align-items: center; gap: 6px; color: var(--ink-2); }
.klib-fpsel k-select { flex: 1; min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: var(--r-2); padding: 3px 6px; color: var(--ink); font: 12px var(--font); }
.klib-foot { align-items: center; }
.klib-foot label { display: flex; gap: 6px; align-items: center; margin-right: 14px; white-space: nowrap; }
.klib-foot input[type=checkbox] { width: auto; margin: 0; }
.klib-foot .klib-vsep { width: 1px; align-self: stretch; margin: 3px 4px; background: var(--line); }
.klib-status { color: var(--ink-2); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.klib-cols-dlg { width: 560px; }
.klib-cols-body { display: grid; grid-template-columns: 1fr auto 1fr auto; gap: 8px; padding: 10px 12px; align-items: center; }
.klib-cols-body .klib-colbox { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.klib-cols-body ul { list-style: none; margin: 0; padding: 0; height: 180px; overflow: auto; border: 1px solid var(--line); background: var(--panel); }
.klib-cols-body li { padding: 2px 8px; cursor: default; user-select: none; }
.klib-cols-body li.sel { background: var(--accent); color: var(--on-accent); }
.klib-cols-body .klib-colbtns { display: flex; flex-direction: column; gap: 6px; }
`;
function ensureCss(): void {
  const old = document.getElementById("klib-css");
  if (old && old.textContent === CSS) return;
  if (old) old.remove();
  const st = document.createElement("style"); st.id = "klib-css"; st.textContent = CSS; document.head.appendChild(st);
}

// ---- per-viewer tree settings: the sort mode (LIB_TREE_MODEL_ADAPTER::SetSortMode), the pinned libraries
// (PROJECT::PinLibrary keeps them in the common settings' session), the recent searches (g_recentSearches)
type SortMode = "best" | "alpha";
/** LIB_TREE_MODEL_ADAPTER::GetPinningSymbol */
export const PIN_MARK = "☆ ";
const recentByKind = new Map<string, string[]>();
function store(): Storage | null { try { return window.localStorage; } catch { return null; } }
function loadSort(kind: LibKind): SortMode { try { return store()?.getItem("kui.libtree.sort." + kind) === "alpha" ? "alpha" : "best"; } catch { return "best"; } }
function saveSort(kind: LibKind, m: SortMode): void { try { store()?.setItem("kui.libtree.sort." + kind, m); } catch { /* private window */ } }
function loadPinned(kind: LibKind): Set<string> { return loadPinnedLibs(kind === "footprint" ? "footprint" : "symbol"); }
function savePinned(kind: LibKind, s: Set<string>): void { savePinnedLibs(kind === "footprint" ? "footprint" : "symbol", s); }
function rememberSearch(kind: LibKind, q: string): void { recentByKind.set(kind, pushRecentSearch(recentByKind.get(kind) || [], q)); }
function recentSearches(kind: LibKind): string[] { return recentByKind.get(kind) || []; }
function loadJson<T>(key: string, def: T): T { try { const t = store()?.getItem(key); return t ? JSON.parse(t) as T : def; } catch { return def; } }
function saveJson(key: string, v: unknown): void { try { store()?.setItem(key, JSON.stringify(v)); } catch { /* private window */ } }

/** g_symbolSearchString / g_powerSearchString: the symbol and power choosers open on the last search (the footprint
 *  chooser starts empty). */
const lastSearch: { symbol: string; power: string } = { symbol: "", power: "" };
/** FOOTPRINT_CHOOSER_FRAME's static m_showDescription / m_show3DMode / m_showFpMode, and the own-window check box. */
const fpPanes = { description: true, view3d: false, fpView: true, own3d: false };

/** LIB_TREE_MODEL_ADAPTER::GetAvailableColumns: Item and Description, and for symbols the fields the tree can show. */
export function availableColumns(kind: LibKind): string[] { return kind === "symbol" ? ["Item", "Description", "Value", "Footprint", "Keywords", "Reference", "Datasheet"] : ["Item", "Description"]; }
/** The shown columns, Item always first (EDA_REORDERABLE_LIST_DIALOG keeps it); SYMBOL_TREE_MODEL_ADAPTER shows
 *  Item, Description and Value at first. */
export function shownColumns(kind: LibKind, saved?: unknown): string[] {
  const avail = availableColumns(kind), def = kind === "symbol" ? ["Item", "Description", "Value"] : ["Item", "Description"];
  const list = Array.isArray(saved) ? saved.filter((c): c is string => typeof c === "string" && avail.includes(c)) : def;
  const out = ["Item", ...list.filter((c, i) => c !== "Item" && list.indexOf(c) === i)];
  return out.length > 1 || Array.isArray(saved) ? out : def;
}
/** A row's text in a column (LIB_TREE_NODE m_Fields; a library symbol's Value is its name). */
export function columnText(it: LibItem | undefined, col: string, description: string): string {
  if (col === "Description") return description;
  if (!it) return "";
  if (col === "Value") return it.value || it.name;
  if (col === "Footprint") return it.footprint || "";
  if (col === "Keywords") return it.keywords || "";
  if (col === "Reference") return it.reference || "";
  if (col === "Datasheet") return it.datasheet || "";
  return "";
}

let openDialog: { close(): void } | null = null;
/** Whether a chooser is on screen. */
export function chooserOpen(): boolean { return !!openDialog; }
export function closeChooser(): void { if (openDialog) openDialog.close(); }

// DIALOG_SYMBOL_CHOOSER is built afresh for every placement: "Place repeated copies" starts off and
// "Place all units" starts on (m_useUnits->SetValue( true )); neither is remembered
const CHOOSER_DEFAULTS = { keep: false, allUnits: true } as const;

// PCBNEW_SETTINGS m_FootprintChooser.filter_on_pin_count / use_fp_filters (both off by default), kept between openings
const FP_FILTER_KEY = "klib.fpchooser.filters";
function loadFpFilterPrefs(): { pins: boolean; filters: boolean } {
  try { const j = JSON.parse(localStorage.getItem(FP_FILTER_KEY) || "{}") as { pins?: unknown; filters?: unknown }; return { pins: j.pins === true, filters: j.filters === true }; } catch { return { pins: false, filters: false }; }
}
function saveFpFilterPrefs(v: { pins: boolean; filters: boolean }): void { try { localStorage.setItem(FP_FILTER_KEY, JSON.stringify(v)); } catch { /* no storage */ } }

/** Every footprint of the library table, in table order (FOOTPRINT_LIBRARY_ADAPTER::GetFootprints over GetLibraryNames):
 *  what pcbnew's filterFootprints walks for the symbol chooser's footprint selector.  Loaded once a page. */
let allFootprintsP: Promise<LibItem[]> | null = null;
function allFootprints(ctx: SourceContext): Promise<LibItem[]> {
  if (allFootprintsP) return allFootprintsP;
  const own = projectLibraries("footprint", ctx.docs);
  allFootprintsP = officialLibraries("footprint").then(async (t) => {
    const taken = new Set(own.map((l) => l.name));
    const entries: LibraryEntry[] = own.map((l): LibraryEntry => ({ name: l.name, description: "Project library", source: "project" }))
      .concat(t.libraries.filter((l) => !taken.has(l.name)));
    const lists: LibItem[][] = new Array(entries.length);
    let next = 0;
    const worker = async (): Promise<void> => { for (;;) { const i = next++; if (i >= entries.length) return; try { lists[i] = await libraryIndex("footprint", entries[i], ctx); } catch { lists[i] = []; } } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    return ([] as LibItem[]).concat(...lists);
  });
  allFootprintsP.catch(() => { allFootprintsP = null; });
  return allFootprintsP;
}

/** The (associated_footprints …) of a library symbol (LIB_SYMBOL::GetEffectiveAssociatedFootprints). */
function associatedFootprints(sym: SNode): string[] {
  const out: string[] = [];
  const af = (sym as SNode[]).find((c) => Array.isArray(c) && c[0] === "associated_footprints") as SNode[] | undefined;
  if (af) for (const f of af) if (Array.isArray(f) && f[0] === "footprint") out.push(String(f[1] ?? ""));
  return out;
}

/** Open the chooser; resolves with the chosen item (its s-expression fetched) or null on Cancel. */
export function openChooser(kind: LibKind, ctx: SourceContext, opts: ChooserOptions = {}): Promise<Chosen | null> {
  if (openDialog) openDialog.close();
  ensureCss();
  const isSym = kind === "symbol", browser = !!opts.browser, power = isSym && !!opts.power, picker = isSym && !!opts.picker && !browser;
  // PANEL_SYMBOL_CHOOSER( …, aShowFootprints ): the power chooser and SYMBOL_CHOOSER_FRAME pass false
  const showFp = isSym && !power && !picker && opts.showFootprints !== false;
  // the details pane is a full-width bottom pane under tree and preview, except in the symbol chooser with footprints
  const wideDetails = !showFp;
  const baseTitle = opts.title || (browser ? (isSym ? "Symbol Library Browser" : "Footprint Library Browser") : power ? "Choose Power Symbol" : picker ? "Symbol Chooser" : isSym ? "Choose Symbol" : "Footprint Chooser");
  const okLabel = browser ? (isSym ? "Add Symbol to Schematic" : "Add Footprint to Board") : "OK";
  const fpf = !isSym ? opts.fpFilters || null : null, labels = filterLabels(fpf), fpOn = loadFpFilterPrefs();
  const searchKey: "symbol" | "power" = power ? "power" : "symbol";
  const mode = !isSym ? "footprint" : power ? "power" : picker ? "picker" : "symbol";
  const fpChooser = !isSym && !browser;
  const placeOptions = isSym && !browser && !picker;

  return new Promise<Chosen | null>((resolve) => {
    const ov = document.createElement("div"); ov.className = "kd-overlay klib-overlay";
    ensureIconCss(); const dlg = document.createElement("div"); dlg.className = "kd-dialog klib-dialog"; dlg.setAttribute("role", "dialog"); dlg.dataset.kind = kind;
    const detailsHtml = `<div class="klib-details${wideDetails ? " wide" : ""}"></div>`;
    dlg.innerHTML = `
      <div class="kd-title"><span class="klib-title"></span><span class="kd-x" title="Close (Esc)">${CLOSE_MARK_SVG}</span></div>
      <div class="klib-body"><div class="klib-main">
        <div class="klib-left">
          <div class="klib-search"><div class="klib-filter"><svg class="klib-recent" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><title>Recent searches</title><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>
            <input type="text" placeholder="Filter" spellcheck="false" autocomplete="off" aria-label="Filter"><span class="klib-clear" title="Clear filter">${CLOSE_MARK_SVG}</span></div><span class="klib-vsep"></span></div>
          ${labels.filters || labels.pins ? `<div class="klib-filters">${labels.filters ? `<label><input type="checkbox" class="klib-by-filters"${fpOn.filters ? " checked" : ""}> ${esc(labels.filters)}</label>` : ""}${labels.pins ? `<label><input type="checkbox" class="klib-by-pins"${fpOn.pins ? " checked" : ""}> ${esc(labels.pins)}</label>` : ""}</div>` : ""}
          <div class="klib-head"></div>
          <div class="klib-tree" tabindex="0"><div class="klib-rows"></div></div>
          ${wideDetails ? "" : detailsHtml}
        </div>
        <div class="klib-split"></div>
        <div class="klib-right">
          <div class="klib-pane klib-pane-main"><canvas></canvas><canvas class="klib-ruler"></canvas><div class="klib-msg"></div></div>
          ${fpChooser ? `<div class="klib-pane klib-pane-3d"></div>` : ""}
          ${isSym ? `<div class="klib-bodysel"><span>Body style:</span><k-select disabled aria-label="Body style"></k-select></div>` : ""}
          ${showFp ? `<div class="klib-fpsel"><span>Footprint:</span><k-select disabled aria-label="Footprint"><option value="">No default footprint</option></k-select></div>
          <div class="klib-pane klib-pane-fp"><canvas></canvas><canvas class="klib-ruler"></canvas><div class="klib-msg"></div></div>` : ""}
        </div>
      </div>${wideDetails ? `<div class="klib-hsplit"></div>${detailsHtml}` : ""}</div>
      <div class="kd-foot klib-foot">
        ${placeOptions ? `<label title="Keep the symbol selected for subsequent clicks."><input type="checkbox" class="klib-keep"> Place repeated copies</label><label title="Sequentially place all units of the symbol."><input type="checkbox" class="klib-units"> Place all units</label>` : ""}
        <span class="klib-status"></span><span class="spacer"></span><span class="klib-fptools"></span>
        <button class="btn klib-cancel">${browser ? "Close" : "Cancel"}</button><button class="btn primary klib-ok">${esc(okLabel)}</button>
      </div>`;
    ov.appendChild(dlg); document.body.appendChild(ov);
    const $ = <T extends Element>(sel: string) => dlg.querySelector(sel) as T;
    const titleEl = $<HTMLElement>(".klib-title"), input = $<HTMLInputElement>(".klib-filter input"), filterBox = $<HTMLElement>(".klib-filter");
    const tree = $<HTMLElement>(".klib-tree"), rowsEl = $<HTMLElement>(".klib-rows"), details = $<HTMLElement>(".klib-details"), status = $<HTMLElement>(".klib-status"), head = $<HTMLElement>(".klib-head");
    const mainPane = $<HTMLElement>(".klib-pane-main"), mainCanvas = $<HTMLCanvasElement>(".klib-pane-main canvas"), mainMsg = $<HTMLElement>(".klib-pane-main .klib-msg");
    const fpPane = showFp ? $<HTMLElement>(".klib-pane-fp") : null, fpCanvas = showFp ? $<HTMLCanvasElement>(".klib-pane-fp canvas") : null, fpMsg = showFp ? $<HTMLElement>(".klib-pane-fp .klib-msg") : null;
    const fpSelect = showFp ? $<HTMLSelectElement>(".klib-fpsel k-select") : null;
    const pane3d = fpChooser ? $<HTMLElement>(".klib-pane-3d") : null;
    const okBtn = $<HTMLButtonElement>(".klib-ok"), keepBox = dlg.querySelector<HTMLInputElement>(".klib-keep"), unitsBox = dlg.querySelector<HTMLInputElement>(".klib-units");
    if (keepBox) keepBox.checked = CHOOSER_DEFAULTS.keep;
    if (unitsBox) unitsBox.checked = CHOOSER_DEFAULTS.allUnits;
    if (opts.viewOnly) { okBtn.disabled = true; okBtn.title = "This document is read-only"; }
    // the symbol and power choosers (and the picker) reopen on the last search; a caller's filter text wins
    const startText = opts.filter !== undefined && opts.filter !== "" ? opts.filter : isSym && !browser ? lastSearch[searchKey] : "";
    if (startText) { input.value = startText; filterBox.classList.add("has-text"); }
    const bodySelect = isSym ? $<HTMLSelectElement>(".klib-bodysel k-select") : null;
    let selectedBodyStyle = 1;      // PANEL_SYMBOL_CHOOSER::m_selectedBodyStyle: kept across selections, clamped per symbol
    let sortMode: SortMode = loadSort(kind);
    const pinned = loadPinned(kind);
    // LIB_TREE's BITMAPS::config button: the sort mode and Expand All / Collapse All
    const configBtn = bitmapButton("config", "", (ev) => {
      const r = configBtn.getBoundingClientRect(); ev.stopPropagation();
      popupMenu(r.left, r.bottom, [
        { label: "Sort by Best Match", check: true, checked: sortMode === "best", run: () => { sortMode = "best"; saveSort(kind, sortMode); refresh(); } },
        { label: "Sort Alphabetically", check: true, checked: sortMode === "alpha", run: () => { sortMode = "alpha"; saveSort(kind, sortMode); refresh(); } },
        { sep: true },
        { label: "Expand All", run: () => expandAll(true) },
        { label: "Collapse All", run: () => expandAll(false) },
      ]);
    }, { flat: true, cls: "klib-config" });
    configBtn.removeAttribute("title"); configBtn.setAttribute("aria-label", "Tree options");
    $<HTMLElement>(".klib-search").append(configBtn);
    // wxSearchCtrl::SetMenu: the recent searches of this tree (LIB_TREE::updateRecentSearchMenu)
    $<HTMLElement>(".klib-recent").addEventListener("mousedown", (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      const r = (ev.currentTarget as Element).getBoundingClientRect(), list = recentSearches(kind);
      const items: PopItem[] = list.length ? list.map((q) => ({ label: q, run: () => { input.value = q; onInput(true); input.focus(); } })) : [{ label: "recent searches", disabled: true }];
      popupMenu(r.left, r.bottom + 4, items);
    });
    const noteSearch = () => { rememberSearch(kind, input.value); };

    // ---- columns (LIB_TREE_MODEL_ADAPTER m_shownColumns, kept per kind)
    const colsKey = "kui.libtree.cols." + kind;
    let columns = shownColumns(kind, loadJson<unknown>(colsKey, null));
    const leftEl = $<HTMLElement>(".klib-left");
    function layoutColumns(): void {
      leftEl.style.setProperty("--klib-cols", ["var(--klib-col, " + (columns.length > 2 ? "34%" : "46%") + ")"].concat(columns.slice(1).map(() => "minmax(60px, 1fr)")).join(" "));
      head.innerHTML = columns.map((c) => `<span>${esc(c)}</span>`).join("");
      const grip = document.createElement("i"); grip.className = "klib-colgrip"; grip.title = "Drag to resize the column; double-click to fit";
      (head.firstElementChild as HTMLElement).appendChild(grip);
      wireGrip(grip);
    }

    // ---- the model
    const groups: Group[] = [];
    const expanded = new Set<string>();           // group keys and item keys the user opened
    let rows: Row[] = [], selKey = "", query = input.value.trim(), closed = false, pending = 0, tableError = "";
    const recentGroup: Group = { key: "@recent", label: "-- Recently Used --", description: "", type: "recent", items: recentItems(kind, { power, picker }), loading: false, error: "" };
    // PANEL_FOOTPRINT_CHOOSER has no "-- Already Placed --"; SYMBOL_CHOOSER_FRAME's is empty
    const placedGroup: Group | null = isSym ? { key: "@placed", label: "-- Already Placed --", description: "", type: "placed", items: picker ? [] : placedItems(kind, ctx.doc, ctx.otherLibs), loading: false, error: "" } : null;
    const sourceGroups = new Map<string, Group>();
    const rebuildGroups = () => {
      const libs = groups.filter((g) => g.type === "lib");
      groups.length = 0;
      groups.push(recentGroup); if (placedGroup) groups.push(placedGroup);
      for (const src of opts.noSources ? [] : registeredSources(kind)) {
        let g = sourceGroups.get(src.id);
        if (!g) { g = { key: "@src:" + src.id, label: src.label, description: "", type: "source", src, items: [], loading: false, error: "" }; sourceGroups.set(src.id, g); }
        groups.push(g);
      }
      groups.push(...libs);
    };
    rebuildGroups();
    const offSources = onSourcesChanged(() => { rebuildGroups(); searchSources(); refresh(); });

    const byPinsBox = dlg.querySelector<HTMLInputElement>(".klib-by-pins"), byFiltersBox = dlg.querySelector<HTMLInputElement>(".klib-by-filters");
    const fpFiltering = (): { pins: boolean; filters: boolean } => ({ pins: !!(byPinsBox && byPinsBox.checked), filters: !!(byFiltersBox && byFiltersBox.checked) });
    /** filterFootprint is on: libraries without a passing footprint are left out */
    const filtering = (): boolean => { const on = fpFiltering(); return !!fpf && ((on.pins && fpf.pins > 0) || (on.filters && fpf.filters.length > 0)); };
    const visibleItems = (g: Group): LibItem[] => {
      let items = g.items || [];
      if (power) items = items.filter(isPowerRow);
      else if (g.type === "placed") items = items.filter((it) => !isPowerRow(it));   // PlaceSymbol leaves power symbols out of the symbol chooser's list
      if (fpf && g.type !== "source") { const on = fpFiltering(); items = items.filter((it) => footprintPasses(it, fpf, on)); }
      return items;
    };
    const itemKey = (g: Group, it: LibItem) => g.key + "/" + it.id;
    /** LIB_TREE_NODE_ITEM's search terms: the item's own, and the shown columns' field values */
    const fieldsOf = (it: LibItem): Record<string, string> => ({ Value: it.value || it.name, Footprint: it.footprint || "", Keywords: it.keywords || "", Reference: it.reference || "", Datasheet: it.datasheet || "" });
    let best: { key: string; score: number; exact: boolean } | null = null;

    function buildRows(): void {
      const out: Row[] = [];
      const matchers = compileLibSearch(query), searching = matchers.length > 0, byScore = searching && sortMode === "best";
      const ranked: { g: Group; items: { it: LibItem; score: number; exact: boolean }[]; best: number; exact: boolean }[] = [];
      for (const g of groups) {
        const all = visibleItems(g);
        // a registered source filters on its side: its results are taken as they come
        const scored = all.map((it) => {
          if (g.type === "source") return { it, score: 1, exact: false };
          const m = scoreItem(matchers, libSearchTerms({ name: it.name, description: it.description, keywords: it.keywords, library: it.library || parseLibId(it.id).lib, kind, units: it.units, footprint: it.footprint, fields: fieldsOf(it), columns }));
          return { it, score: m.score, exact: m.exact };
        }).filter((x) => x.score > 0);
        // LIB_TREE_NODE::Compare: with "Sort by Best Match" and a search, exact matches, then the score; then the intrinsic
        // rank: StrNumCmp of the names, the "-- " groups in the order they were handed over
        const intrinsic = g.type === "lib";
        scored.sort((a, b) => (byScore && a.exact !== b.exact ? (a.exact ? -1 : 1) : 0) || (byScore ? b.score - a.score : 0) || (intrinsic ? strNumCmpNoCase(a.it.name, b.it.name) : 0));
        let gBest = 0, gExact = false; for (const x of scored) { if (x.score > gBest) gBest = x.score; gExact = gExact || x.exact; }
        if (g.type === "lib") { if ((searching || power || filtering()) && !scored.length) continue; }
        else if (g.type === "source") { if (!scored.length && !g.loading && !g.error && !searching) continue; }
        else if (searching && !scored.length) continue;        // the "-- " groups stay in view, empty, without a search
        ranked.push({ g, items: scored, best: gBest, exact: gExact });
      }
      // "-- " groups first, then pinned libraries, then (best match with a search) exact, then score; then the names
      const tier = (g: Group) => (g.type === "recent" ? 4 : g.type === "placed" ? 3 : g.type === "source" ? 2 : pinned.has(g.label) ? 1 : 0);
      ranked.sort((a, b) => tier(b.g) - tier(a.g)
        || (byScore && a.exact !== b.exact ? (a.exact ? -1 : 1) : 0) || (byScore ? b.best - a.best : 0)
        || (a.g.type === "lib" && b.g.type === "lib" ? strNumCmpNoCase(a.g.label, b.g.label) : 0));
      best = null;
      for (const { g, items } of ranked) {
        const open = searching ? !expanded.has("-" + g.key) : expanded.has(g.key);
        out.push({ key: g.key, depth: 0, group: g, label: (g.type === "lib" && pinned.has(g.label) ? PIN_MARK : "") + g.label, description: g.description, expandable: (g.items ? items.length : -1) !== 0 || g.loading || !!g.error || !g.items, expanded: open });
        // showResults: the best item (score above 1; exact over score, the first of equals in display order)
        for (const x of items) if (x.score > 1 && (!best || (x.exact && !best.exact) || (x.exact === best.exact && x.score > best.score))) best = { key: itemKey(g, x.it), score: x.score, exact: x.exact };
        if (!open) continue;
        // a vendor search keeps its "Searching…" row above the previous results until the new ones arrive
        if (g.loading && (!items.length || g.type === "source")) out.push({ key: g.key + "/@loading", depth: 1, group: g, label: g.type === "source" ? `Searching ${g.label.replace(/\s*\(.*$/, "")}…` : "Loading…", description: g.type === "source" && query ? `for "${query}"` : "", expandable: false, expanded: false });
        if (g.error) out.push({ key: g.key + "/@error", depth: 1, group: g, label: g.error, description: "", expandable: false, expanded: false });
        for (const { it } of items) {
          const k = itemKey(g, it), units = isSym ? it.units || 1 : 1, itemOpen = units > 1 && expanded.has(k);
          out.push({ key: k, depth: 1, group: g, item: it, label: it.name, description: it.description || "", expandable: units > 1, expanded: itemOpen });
          if (itemOpen) for (let u = 1; u <= units; u++) out.push({ key: k + "#" + u, depth: 2, group: g, item: it, unit: u, label: unitDisplayName(u, it.unitNames), description: "", expandable: false, expanded: false });
        }
      }
      rows = out;
    }
    /** The scroll height follows the rows at once (drawRows sets it a frame later), so a scroll to the selection is
     *  not clamped to the old height. */
    const growRows = (): void => { rowsEl.style.height = rows.length * ROW_H + "px"; };

    // ---- rendering (a windowed list: a search can match thousands of rows)
    let drawQueued = false;
    function drawRows(): void {
      drawQueued = false; if (closed) return;
      rowsEl.style.height = rows.length * ROW_H + "px";
      const top = tree.scrollTop, h = tree.clientHeight || 300;
      const first = Math.max(0, Math.floor(top / ROW_H) - 6), last = Math.min(rows.length, Math.ceil((top + h) / ROW_H) + 6);
      let html = "";
      for (let i = first; i < last; i++) {
        const r = rows[i], note = !r.item && r.depth === 1;
        const tw = r.expandable ? `<span class="ktw${r.expanded ? "" : " shut"}" data-twist="" aria-hidden="true"></span>` : "";
        const derived = !!(r.item && r.depth === 1 && r.item.extends);
        html += `<div class="klib-row${r.depth === 0 ? " lib" : ""}${note ? " note" : ""}${derived ? " derived" : ""}${r.key === selKey ? " sel" : ""}" style="top:${i * ROW_H}px" data-i="${i}" title="${esc(r.item ? (r.item.library ? r.item.library + ":" : "") + r.item.name : r.label)}">`
          + `<span class="klib-item" style="padding-left:${4 + r.depth * 16}px"><span class="klib-tw">${tw}</span>${(r.depth === 0 || r.key.endsWith("/@loading")) && r.group.loading ? '<span class="klib-spin"></span>' : ""}${esc(r.label)}</span>`
          + columns.slice(1).map((c) => `<span class="klib-desc">${esc(columnText(r.depth === 2 ? undefined : r.item, c, r.description))}</span>`).join("") + `</div>`;
      }
      rowsEl.innerHTML = html;
    }
    const queueDraw = () => { if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawRows); } };
    /** GetItemCount: the items of every top-level node (the "-- " groups too) that pass the chooser's filter */
    function itemCount(): number { let n = 0; for (const g of groups) if (g.type !== "source" && g.items) n += visibleItems(g).length; return n; }
    function setTitle(): void {
      titleEl.textContent = baseTitle + ` (${itemCount()} items loaded)`;
      const searching = [...sourceGroups.values()].some((g) => g.loading && groups.includes(g));
      status.textContent = tableError ? tableError : pending > 0 ? `Loading libraries… ${pending} to go` : searching ? "Searching vendor catalogues…" : "";
    }
    let refreshTimer = 0, userPicked = false;
    // SetPreselectNode: the caller's item, else the first of the history (with its unit); shown whenever the search is empty
    const recent0 = recentGroup.items && recentGroup.items[0];
    const preselectId = opts.preselect && opts.preselect.includes(":") ? opts.preselect : recent0 ? recent0.id : "";
    const preselectUnit = !opts.preselect && recent0 && isSym ? recent0.unit || 0 : 0;
    let preselectPending = !!preselectId, tablesIn = false;
    /** showResults' preselect step: once the library holding the item is in, open it and select the item (or its unit);
     *  true when it took the selection. */
    function applyPreselect(): boolean {
      if (userPicked) preselectPending = false;   // the user's own pick stands
      if (!preselectPending || query) return false;
      const lib = preselectId.slice(0, preselectId.indexOf(":"));
      let g = groups.find((x) => x.type === "lib" && x.label === lib);
      if (!g) {
        // A footprint a vendor part brought (LCSC:<package>): its nickname is in no library table, but the server
        // resolves the id, so the tree gets that one library with the footprint in it and opens on it.
        if (!tablesIn) return false;
        if (isSym) { preselectPending = false; return false; }
        g = { key: "lib:" + lib, label: lib, description: "Footprints of vendor parts", type: "lib", items: [{ id: preselectId, name: preselectId.slice(lib.length + 1), library: lib, source: "official" }], loading: false, error: "" };
        groups.push(g);
      }
      if (!g.items) {
        // a library that failed to load is not asked for again here (loadGroup's own retries, when the server asked
        // for one, still run, and the item is selected if one of them brings the library in); once none is left the
        // preselection is dropped, as the tree has nothing to select
        if (g.error) { if (!g.loading && !retryWaiting.has(g.key)) preselectPending = false; return false; }
        void loadGroup(g); return false;
      }
      const it = visibleItems(g).find((x) => x.id === preselectId || (x.library || lib) + ":" + x.name === preselectId);
      preselectPending = false;
      if (!it) return false;
      expanded.add(g.key);
      const k = itemKey(g, it), units = it.units || 1;
      const unitKey = preselectUnit > 0 && preselectUnit <= units && units > 1 ? k + "#" + preselectUnit : "";
      if (unitKey) expanded.add(k);
      buildRows();
      const key = unitKey && rows.some((r) => r.key === unitKey) ? unitKey : k;
      if (!rows.some((r) => r.key === key)) return false;
      growRows(); selKey = ""; select(key, true); const i = rows.findIndex((r) => r.key === key); tree.scrollTop = Math.max(0, i * ROW_H - (tree.clientHeight || 300) / 2);
      return true;
    }
    /** showResults' last step: with no match and no preselection, a single library opens on its first item */
    function selectSingleLibrary(): boolean {
      const libs = rows.filter((r) => r.depth === 0 && (r.group.type === "lib" || r.group.type === "source"));
      if (libs.length !== 1 || preselectPending) return false;
      const g = libs[0].group; if (!g.items) { void loadGroup(g); return false; }
      if (!expanded.has(g.key)) { expanded.add(g.key); buildRows(); }
      const first = rows.find((r) => r.group === g && r.item); if (!first) return false;
      select(first.key, true); return true;
    }
    /** `search`: the search text changed (LIB_TREE::Regenerate( false )): the selection follows showResults. */
    function refresh(search = false): void {
      if (closed) return;
      // libraries that load (or open) above the selection push it down: the view follows it
      const before = selKey ? rows.findIndex((r) => r.key === selKey) : -1;
      buildRows();
      if (search) {
        userPicked = false;
        if (best && rows.some((r) => r.key === best!.key)) select(best.key, true);
        else {
          selKey = "";
          let took = false;
          if (!query && preselectId) { preselectPending = true; took = applyPreselect(); }
          if (!took && !preselectPending) took = selectSingleLibrary();
          if (!took) showSelection();
        }
      } else {
        if (applyPreselect()) { setTitle(); queueDraw(); return; }
        const after = before >= 0 ? rows.findIndex((r) => r.key === selKey) : -1;
        if (before >= 0 && after >= 0 && after !== before) { growRows(); tree.scrollTop += (after - before) * ROW_H; }
        if (!selKey && !query && !preselectPending) selectSingleLibrary();
        else if (selKey && !rows.some((r) => r.key === selKey)) { selKey = ""; showSelection(); }
        // the libraries still coming in: until the user picks a row, the selection follows the best match so far (KiCad
        // searches the whole loaded table at once)
        else if (query && best && !userPicked && selKey !== best.key && rows.some((r) => r.key === best!.key)) select(best.key, true);
      }
      setTitle(); queueDraw();
    }
    const queueRefresh = () => { if (!refreshTimer) refreshTimer = window.setTimeout(() => { refreshTimer = 0; refresh(); }, 80); };

    function scrollTo(key: string): void {
      const i = rows.findIndex((r) => r.key === key); if (i < 0) return;
      const y = i * ROW_H, h = tree.clientHeight || 300;
      if (y < tree.scrollTop) tree.scrollTop = y; else if (y + ROW_H > tree.scrollTop + h) tree.scrollTop = y + ROW_H - h;
    }
    function select(key: string, quiet?: boolean): void {
      if (key === selKey && !quiet) return;
      selKey = key; growRows(); scrollTo(key); showSelection(); queueDraw();
    }
    const selectedRow = (): Row | null => rows.find((r) => r.key === selKey) || null;

    // ---- the preview panes: the fitted view with the pane's own zoom and pan (wheel, middle / right drag), and on a
    // footprint the measure tool (left drag) that FOOTPRINT_CHOOSER_FRAME::onFpChanged starts after every selection
    interface Pane { el: HTMLElement; canvas: HTMLCanvasElement; ruler: HTMLCanvasElement; view: PaneView; frame: PaneFrame | null; draw: (() => PaneFrame | null) | null; measure: boolean; ruled: [number, number, number, number] | null; raf: number; redraw(): void }
    function makePane(el: HTMLElement, canvas: HTMLCanvasElement, measure: boolean): Pane {
      const p: Pane = { el, canvas, ruler: el.querySelector<HTMLCanvasElement>("canvas.klib-ruler")!, view: freshView(), frame: null, draw: null, measure, ruled: null, raf: 0, redraw: () => redraw() };
      const redraw = (): void => { if (p.raf) return; p.raf = requestAnimationFrame(() => { p.raf = 0; if (closed || !p.draw) return; try { p.frame = p.draw(); } catch { /* the next selection draws again */ } drawRuler(p); }); };
      const local = (ev: MouseEvent): [number, number] => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
      const world = (sx: number, sy: number): [number, number] | null => (p.frame ? [p.frame.x0 + sx / p.frame.ppm, p.frame.y0 + sy / p.frame.ppm] : null);
      el.addEventListener("wheel", (ev) => {
        if (!p.frame || !p.draw) return;
        ev.preventDefault();
        const f = Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)), [sx, sy] = local(ev);
        const w = canvas.clientWidth, h = canvas.clientHeight, fr = p.frame;
        const cx = fr.x0 + (w / 2 + p.view.panX) / fr.ppm, cy = fr.y0 + (h / 2 + p.view.panY) / fr.ppm;
        const wx = fr.x0 + sx / fr.ppm, wy = fr.y0 + sy / fr.ppm, ppm = fr.ppm * f;
        p.view.zoom *= f; p.view.panX = (cx - wx) * ppm + sx - w / 2; p.view.panY = (cy - wy) * ppm + sy - h / 2;
        p.frame = { ppm, x0: wx - sx / ppm, y0: wy - sy / ppm };
        redraw();
      }, { passive: false });
      let drag: { b: number; x: number; y: number; at: [number, number] | null } | null = null;
      el.addEventListener("pointerdown", (ev) => {
        if (!p.draw) return;
        const [sx, sy] = local(ev);
        if (ev.button === 1 || ev.button === 2) { drag = { b: ev.button, x: ev.clientX, y: ev.clientY, at: null }; el.setPointerCapture(ev.pointerId); ev.preventDefault(); }
        else if (ev.button === 0 && p.measure) { const at = world(sx, sy); if (at) { drag = { b: 0, x: ev.clientX, y: ev.clientY, at }; p.ruled = [at[0], at[1], at[0], at[1]]; drawRuler(p); el.setPointerCapture(ev.pointerId); } }
      });
      el.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        if (drag.b === 0) { const [sx, sy] = local(ev), at = world(sx, sy); if (at && p.ruled) { p.ruled[2] = at[0]; p.ruled[3] = at[1]; drawRuler(p); } return; }
        p.view.panX += ev.clientX - drag.x; p.view.panY += ev.clientY - drag.y; drag.x = ev.clientX; drag.y = ev.clientY; redraw();
      });
      el.addEventListener("pointerup", () => { drag = null; });
      el.addEventListener("contextmenu", (ev) => ev.preventDefault());
      return p;
    }
    /** MEASURE tool's ruler: the line, its length and angle (mm, degrees) */
    function drawRuler(p: Pane): void {
      const c = p.ruler, g = c.getContext("2d"); if (!g) return;
      const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const r = p.ruled, f = p.frame; if (!r || !f) return;
      const ax = (r[0] - f.x0) * f.ppm, ay = (r[1] - f.y0) * f.ppm, bx = (r[2] - f.x0) * f.ppm, by = (r[3] - f.y0) * f.ppm;
      const dx = r[2] - r[0], dy = r[3] - r[1], d = Math.hypot(dx, dy); if (d <= 0) return;
      const col = getComputedStyle(dlg).getPropertyValue("--ink") || "#ddd";
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      for (const [x, y] of [[ax, ay], [bx, by]]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.stroke(); }
      const ang = (Math.atan2(-dy, dx) * 180) / Math.PI;
      g.font = "11px var(--font, sans-serif)";
      g.fillText(`${d.toFixed(4)} mm`, bx + 8, by - 18); g.fillText(`${ang.toFixed(1)}°`, bx + 8, by - 5);
    }
    const resetPane = (p: Pane | null): void => { if (!p) return; p.view = freshView(); p.ruled = null; p.draw = null; p.frame = null; drawRuler(p); };
    const showOn = (p: Pane | null, draw: () => PaneFrame | null): void => { if (!p) return; p.draw = draw; p.frame = draw(); drawRuler(p); };
    const mainP = makePane(mainPane, mainCanvas, !isSym), fpP = fpPane && fpCanvas ? makePane(fpPane, fpCanvas, true) : null;

    // ---- details + preview of the selection
    let previewToken = 0, shown: { row: Row; got: FetchedItem } | null = null;
    /** PANEL_SYMBOL_CHOOSER::m_fp_override and m_field_edits: the footprint picked in the selector, for the symbol it was picked on */
    let fpOverride = "", fieldEdits: Record<string, string> = {}, overrideFor = "";
    function showSelection(): void {
      const row = selectedRow(); const token = ++previewToken; shown = null;
      okBtn.disabled = !!opts.viewOnly || !(row && row.item);
      resetPane(mainP);
      // the pane is empty for a library or a "-- " group (lib_tree.cpp onPreselect / GetSelectedLibId)
      if (!row || !row.item) { details.innerHTML = ""; overrideFor = ""; fpOverride = ""; fieldEdits = {}; blank(); return; }
      const it = row.item;
      // onSymbolSelected: another symbol drops the field edits, another unit of the same one keeps them; a history
      // entry brings the footprint it was placed with
      if (it.id !== overrideFor) {
        overrideFor = it.id; fpOverride = ""; fieldEdits = {};
        if (isSym && it.fields && it.fields.Footprint) { fpOverride = it.fields.Footprint; fieldEdits.Footprint = fpOverride; }
      }
      renderDetails(it, row.unit, null);
      clearPreview(mainCanvas, kind); blankFp(); mainMsg.textContent = "";
      mainMsg.innerHTML = `<span class="klib-spin"></span>${esc(it.source && it.source !== "official" && it.source !== "project" && it.source !== "placed" ? `Fetching ${it.name} from ${row.group.label.replace(/\s*\(.*$/, "")}…` : "Loading…")}`;
      fetchItem(kind, it, ctx).then((got) => {
        if (closed || token !== previewToken) return;
        shown = { row, got }; mainMsg.textContent = "";
        if (isSym) noteUnits(it, got);
        renderDetails(it, row.unit, got);
        try {
          if (isSym) { fillBodyStyles(got); drawSymbol(); showDefaultFootprint(got, token); }
          else { showOn(mainP, () => renderChooserFootprint(mainCanvas, got.fpid || it.id, got.footprint || "", { view: mainP.view, pinNames: fpf && fpf.pinNames, grid: opts.grid })); update3d(got); }
        } catch (e) { resetPane(mainP); clearPreview(mainCanvas, kind); mainMsg.textContent = "Cannot draw this " + kind + ": " + ((e as Error).message || e); }
      }, (e: Error) => { if (closed || token !== previewToken) return; clearPreview(mainCanvas, kind); mainMsg.textContent = e.message || String(e); });
    }
    function drawSymbol(): void {
      if (!shown || !isSym) return;
      const s = shown, unit = s.row.unit || 1, body = currentBodyStyle();
      showOn(mainP, () => renderChooserSymbol(mainCanvas, s.got.libId || s.row.item!.id, s.got.symbol || "", unit, body, { view: mainP.view, autoplace: opts.autoplace || null }));
    }
    /** A vendor (or other source) item tells its unit count only once its symbol is fetched: the item learns it, so
     *  the tree offers the units, as for a library symbol; the unit names come with it. */
    function noteUnits(it: LibItem, got: FetchedItem): number {
      let n = it.units || 1;
      try {
        if (got && got.symbol) {
          const node = symbolNodeOf(got.symbol);
          n = Math.max(n, symbolInfo(node).units || 1);
          const names = symbolUnitNames(node);
          if (names.some(Boolean) && JSON.stringify(names) !== JSON.stringify(it.unitNames || [])) { it.unitNames = names; queueRefresh(); }
        }
      } catch { /* keeps what the item said */ }
      if (n > (it.units || 1)) { it.units = n; queueRefresh(); }
      return n;
    }
    // PANEL_SYMBOL_CHOOSER::populateBodyStyleChoice
    function fillBodyStyles(got: FetchedItem | null): void {
      if (!bodySelect) return;
      let names: string[] = []; try { names = got && got.symbol ? bodyStyleNames(got.symbol) : []; } catch { names = []; }
      const n = Math.max(1, names.length);
      bodySelect.innerHTML = "";
      if (n > 1) {
        names.forEach((name, i) => { const o = document.createElement("option"); o.value = String(i + 1); o.textContent = name; bodySelect.append(o); });
        if (selectedBodyStyle > n) selectedBodyStyle = 1;
        bodySelect.value = String(selectedBodyStyle);
      } else selectedBodyStyle = 1;     // a symbol with one body style puts the choice back to the first
      bodySelect.disabled = n <= 1;
    }
    const currentBodyStyle = (): number => (bodySelect && !bodySelect.disabled ? Math.max(1, Number(bodySelect.value) || 1) : 1);
    if (bodySelect) bodySelect.addEventListener("change", () => { selectedBodyStyle = currentBodyStyle(); mainP.view = freshView(); drawSymbol(); });
    /** The default-footprint pane belongs to the symbol shown above it: it empties as soon as another row is picked,
     *  so a symbol that is still loading (or cannot be fetched) never sits over the previous symbol's footprint. */
    function blankFp(text = ""): void {
      if (fpCanvas && fpMsg && fpSelect) { resetPane(fpP); clearPreview(fpCanvas, "footprint"); fpMsg.textContent = text; fpSelect.innerHTML = '<option value="">No default footprint</option>'; fpSelect.disabled = true; }
    }
    function blank(): void {
      resetPane(mainP); clearPreview(mainCanvas, kind);
      // SYMBOL_PREVIEW_WIDGET / FOOTPRINT_PREVIEW_PANEL status texts
      mainMsg.textContent = isSym ? "No symbol selected" : "No footprint selected";
      fillBodyStyles(null); blankFp(""); update3d(null);
    }
    function renderDetails(it: LibItem, unit: number | undefined, got: FetchedItem | null): void {
      if (isSym) {
        let info: SymbolInfo | null = null, names = it.unitNames; try { if (got && got.symbol) { const node = symbolNodeOf(got.symbol); info = symbolInfo(node); names = symbolUnitNames(node); } } catch { info = null; }
        const over = (got && got.fields) || {};
        const fields = info ? info.fields.map((f) => ({ name: f.name, value: over[f.name] !== undefined ? over[f.name] : f.value })) : [{ name: "Reference", value: it.reference || "" }, { name: "Footprint", value: it.footprint || "" }];
        if (info) for (const [k, v] of Object.entries(over)) if (!fields.some((f) => f.name === k)) fields.push({ name: k, value: v });
        details.innerHTML = symbolDetailsHtml({ name: it.name, parent: got ? got.parent || null : null, description: (info && info.description) || it.description || "", keywords: (info && info.keywords) || it.keywords || "",
          fields, unit: unit || 1, units: (info && info.units) || it.units || 1, unitNames: names });
      } else {
        let info: { description: string; keywords: string; datasheet: string } | null = null; try { info = got && got.footprint ? footprintInfo(got.footprint) : null; } catch { info = null; }
        details.innerHTML = footprintDetailsHtml({ name: it.name, description: (info && info.description) || it.description || "", keywords: (info && info.keywords) || it.keywords || "", datasheet: info ? info.datasheet : "" });
      }
    }
    // HTML_WINDOW link clicks: GetAssociatedDocument (a web link opens; anything else is reported)
    details.addEventListener("click", (ev) => {
      const a = (ev.target as HTMLElement).closest("a"); if (!a) return;
      ev.preventDefault(); const href = a.getAttribute("href") || ""; if (href) openDatasheet(href, {});
    });
    /** populateFootprintSelector + the footprint preview under the symbol */
    function showDefaultFootprint(got: FetchedItem, token: number): void {
      if (!fpCanvas || !fpMsg || !fpSelect) return;
      let node: SNode | null = null; try { node = got.symbol ? symbolNodeOf(got.symbol) : null; } catch { node = null; }
      let def = (got.fields && got.fields.Footprint) || "";
      if (!def && node) { try { def = symbolInfo(node).footprint; } catch { def = ""; } }
      if (fpOverride) def = fpOverride;
      const pins = node ? chooserPins(node, false).length : 0, filters = node ? symbolFpFilters(node) : [], assocs = node ? associatedFootprints(node) : [];
      const fill = (all: LibItem[]): void => {
        const entries = footprintSelectEntries(def, assocs, pins, filters, all);
        fpSelect.innerHTML = entries.map((e) => `<option value="${esc(e.value)}">${esc(e.label)}</option>`).join("");
        fpSelect.value = def; fpSelect.disabled = false;
      };
      fill([]);
      if (filters.length || pins > 0) allFootprints(ctx).then((all) => { if (!closed && token === previewToken) { const keep = fpSelect.value; fill(all); fpSelect.value = keep; } }, () => { /* the default alone */ });
      drawFootprint(def, token);
    }
    /** FOOTPRINT_PREVIEW_PANEL::DisplayFootprint with its status texts */
    function drawFootprint(fp: string, token: number): void {
      if (!fpCanvas || !fpMsg) return;
      resetPane(fpP); clearPreview(fpCanvas, "footprint"); fpMsg.textContent = "";
      if (!fp) { fpMsg.textContent = "No footprint specified"; return; }
      const { lib, name } = parseLibId(fp);
      if (!fp.includes(":") || !lib || !name) { fpMsg.textContent = "Invalid footprint specified"; return; }
      const source = projectLibraries("footprint", ctx.docs).some((l) => l.name === lib) ? "project" : "official";
      fetchItem("footprint", { id: fp, name, library: lib, source }, ctx).then((f) => {
        if (closed || token !== previewToken) return;
        try { showOn(fpP, () => renderChooserFootprint(fpCanvas, fp, f.footprint || "", { view: fpP!.view, grid: opts.grid })); } catch { fpMsg.textContent = "Footprint not found."; }
      }, () => { if (!closed && token === previewToken) fpMsg.textContent = "Footprint not found."; });
    }
    // onFootprintSelected: the override is a Footprint field edit, and the preview shows it
    if (fpSelect) fpSelect.addEventListener("change", () => {
      fpOverride = fpSelect.value; fieldEdits.Footprint = fpOverride;
      drawFootprint(fpOverride, previewToken);
    });

    // ---- the footprint chooser's bottom tool row and its 3D pane
    let preview3d: PreviewApi | null = null, own3d = false, last3d = "";
    const board3d = (got: FetchedItem | null): string => {
      if (!got || !got.footprint) return previewBoardText(null, [], 1.6);
      // PANEL_PREVIEW_3D_MODEL's holder board with the footprint's own models
      let extra = "";
      try { const n = window.KiCadCanvas.parse(got.footprint) as SNode; extra = (n as SNode[]).filter((c) => Array.isArray(c) && c[0] === "model").map((c) => window.KiCadCanvas.serialize(c as SNode)).join(" "); } catch { extra = ""; }
      return previewBoardText(got.footprint, [], 1.6, undefined, extra);
    };
    function update3d(got: FetchedItem | null): void {
      if (!pane3d) return;
      last3d = board3d(got);
      if (preview3d && fpPanes.view3d && !fpPanes.own3d) preview3d.update(last3d);
      if (own3d) own3dChanged();
    }
    let own3dListeners: (() => void)[] = [];
    const own3dChanged = (): void => { for (const fn of own3dListeners.slice()) fn(); };
    function layoutFpPanes(): void {
      if (!pane3d) return;
      const inPane3d = fpPanes.view3d && !fpPanes.own3d;
      pane3d.style.display = inPane3d ? "" : "none";
      mainPane.style.display = fpPanes.fpView ? "" : "none";
      details.style.display = fpPanes.description ? "" : "none";
      const hs = dlg.querySelector<HTMLElement>(".klib-hsplit"); if (hs) hs.style.display = fpPanes.description ? "" : "none";
      if (inPane3d && !preview3d) { preview3d = modelPreview({ key: "klib-3d" }); pane3d.append(preview3d.el); }
      if (preview3d && inPane3d) preview3d.update(last3d || board3d(shown ? shown.got : null));
      // EDA_3D_VIEWER_FRAME of its own: the chooser's holder board
      const wantOwn = fpPanes.view3d && fpPanes.own3d;
      if (wantOwn && !own3d) {
        own3d = true;
        void show3DViewerOn({ getDoc: () => { try { return window.KiCadCanvas.parseDoc(last3d || board3d(shown ? shown.got : null)); } catch { return null; } },
          getName: () => "3D Viewer — " + (shown ? shown.got.fpid || shown.row.item!.id : ""),
          subscribe: (fn) => { own3dListeners.push(fn); return () => { own3dListeners = own3dListeners.filter((x) => x !== fn); }; } });
      } else if (!wantOwn && own3d) { own3d = false; close3DViewer(); }
      queueDraw();
    }
    if (fpChooser) {
      const tools = $<HTMLElement>(".klib-fptools"); tools.style.display = "flex"; tools.style.alignItems = "center"; tools.style.gap = "1px"; tools.style.marginRight = "10px";
      const desc = bitmapToggle(fpPanes.description ? "text_visibility_off" : "text_visibility", "Show/hide description panel", fpPanes.description, (on) => {
        fpPanes.description = on; desc.replaceChildren(kicadIcon(on ? "text_visibility_off" : "text_visibility", 16)); layoutFpPanes();
      }, { key: "klib-desc" });
      const sep = () => { const s = document.createElement("span"); s.className = "klib-vsep"; return s; };
      // on3DviewReq / onFpViewReq: one of the two views always stays on
      const v3 = bitmapToggle("shape_3d", "Show/hide 3D view panel", fpPanes.view3d, (on) => {
        if (!on && !fpPanes.fpView) { v3.setOn(true); return; }
        fpPanes.view3d = on; layoutFpPanes();
      }, { key: "klib-3dview" });
      const fv = bitmapToggle("module", "Show/hide footprint view panel", fpPanes.fpView, (on) => {
        if (!on && !fpPanes.view3d) { fv.setOn(true); return; }
        fpPanes.fpView = on; layoutFpPanes(); if (on) mainP.redraw();
      }, { key: "klib-fpview" });
      const ownLbl = document.createElement("label"); ownLbl.innerHTML = `<input type="checkbox" class="klib-own3d"${fpPanes.own3d ? " checked" : ""}> Show 3D viewer in own window`;
      ownLbl.querySelector("input")!.addEventListener("change", (ev) => { fpPanes.own3d = (ev.target as HTMLInputElement).checked; layoutFpPanes(); });
      tools.append(desc, sep(), v3, fv, sep(), ownLbl);
    }

    // ---- loading
    const retries = new Map<string, number>(), retryTimers: number[] = [], retryWaiting = new Set<string>();
    function loadGroup(g: Group): Promise<void> {
      if (g.items || g.loading || !g.entry) return Promise.resolve();
      g.loading = true; g.error = "";
      return libraryIndex(kind, g.entry, ctx).then((items) => { g.items = items; }, (e: Error & { retryAfter?: number }) => {
        g.error = "Could not load: " + (e.message || e);
        // the server asks to come back later (the upstream refused it): do, a few times
        const tries = retries.get(g.key) || 0;
        if (e.retryAfter && tries < 3 && !closed) { retries.set(g.key, tries + 1); retryWaiting.add(g.key); retryTimers.push(window.setTimeout(() => { retryWaiting.delete(g.key); if (!closed && !g.items) void loadGroup(g); }, Math.min(90, e.retryAfter) * 1000 + 500)); }
      }).then(() => { g.loading = false; if (!closed) queueRefresh(); });
    }
    function preload(list: Group[]): void {
      const queue = list.slice(); pending += queue.length; setTitle();
      const worker = async (): Promise<void> => {
        for (;;) { const g = queue.shift(); if (!g || closed) return; await loadGroup(g); pending--; }
      };
      const done = () => { if (!closed) { setTitle(); refresh(); } };
      void Promise.all([worker(), worker(), worker(), worker()]).then(done, done);
    }
    // LIB_TREE's m_lastOpened (the libraries open when the tree last closed) come back open
    const openKey = "kui.libtree.open." + kind;
    const reopen = new Set<string>(loadJson<string[]>(openKey, []).filter((x) => typeof x === "string"));
    const project = projectLibraries(kind, ctx.docs).map((l): Group => ({ key: "project:" + l.name, label: l.name, description: "Project library", type: "lib",
      entry: { name: l.name, description: "Project library", source: "project" }, items: null, loading: false, error: "" }));
    groups.push(...project);
    for (const g of project) if (reopen.has(g.label)) expanded.add(g.key);
    officialLibraries(kind).then((t) => {
      if (closed) return;
      const taken = new Set(project.map((g) => g.label));
      const official = t.libraries.filter((l) => !taken.has(l.name)).map((l): Group => ({ key: "lib:" + l.name, label: l.name, description: l.description, type: "lib", entry: l, items: null, loading: false, error: "" }));
      groups.push(...official); tablesIn = true;
      for (const g of official) if (reopen.has(g.label)) expanded.add(g.key);
      refresh(!userPicked);
      // the power tool wants its library first; everything else follows in table order
      const order = power ? official.filter((g) => g.label === "power").concat(official.filter((g) => g.label !== "power")) : official;
      preload(project.concat(order));
    }, (e: Error) => { if (closed) return; tableError = "KiCad libraries unavailable: " + (e.message || e); tablesIn = true; preload(project); refresh(!userPicked); });

    let sourceTimer = 0, sourceToken = 0;
    function searchSources(): void {
      const token = ++sourceToken;
      for (const g of sourceGroups.values()) {
        if (!g.src || !groups.includes(g)) continue;
        const src = g.src; g.loading = true; g.error = "";
        Promise.resolve().then(() => src.search(query, kind)).then((list) => {
          if (closed || token !== sourceToken) return;
          g.items = (Array.isArray(list) ? list : []).map((r): LibItem => ({ id: String(r.id), name: String(r.name), description: r.description, keywords: r.keywords, library: r.library || src.label, source: src.id }));
          g.loading = false; queueRefresh();
        }, (e: Error) => { if (closed || token !== sourceToken) return; g.items = []; g.loading = false; g.error = "Search failed: " + (e.message || e); queueRefresh(); });
      }
    }

    // ---- finishing
    const sizeKey = "kui.chooser.size." + mode;
    function close(result: Chosen | null): void {
      if (closed) return; closed = true;
      // the search text, the open libraries and the dialog's size and sashes are kept for the next opening
      if (isSym && !browser) lastSearch[searchKey] = input.value;
      saveJson(openKey, groups.filter((g) => g.type === "lib" && expanded.has(g.key)).map((g) => g.label));
      const r = dlg.getBoundingClientRect();
      saveJson(sizeKey, { w: Math.round(r.width), h: Math.round(r.height), split: splitPx, details: detailsPx });
      offSources(); window.removeEventListener("keydown", onKey, true); window.clearTimeout(refreshTimer); window.clearTimeout(sourceTimer); window.clearTimeout(inputTimer); for (const t of retryTimers) window.clearTimeout(t); ro.disconnect();
      if (preview3d) { preview3d.dispose(); preview3d = null; }
      if (own3d) { own3d = false; close3DViewer(); }
      ov.remove(); if (openDialog === handle) openDialog = null;
      resolve(result);
    }
    const handle = { close: () => close(null) };
    openDialog = handle;
    function accept(): void {
      const row = selectedRow(); if (!row || !row.item || opts.viewOnly) return;
      noteSearch();
      const it = row.item;
      // FOOTPRINT_CHOOSER_FRAME / SYMBOL_CHOOSER_FRAME: every accepted pick joins their history
      if (fpChooser) rememberRecent(kind, it);
      else if (picker) rememberRecent(kind, it, { picker: true });
      const edits = Object.assign({}, fieldEdits);
      const finish = (got: FetchedItem) => close({ kind, item: it, libId: got.libId || (isSym ? it.id : undefined), fpid: got.fpid || (isSym ? undefined : it.id), symbol: got.symbol, footprint: got.footprint,
        fields: Object.keys(edits).length ? Object.assign({}, got.fields || {}, edits) : got.fields, fieldEdits: edits, unit: row.unit || 1, bodyStyle: isSym ? currentBodyStyle() : undefined, keep: !!(keepBox && keepBox.checked),
        allUnits: !!(unitsBox && unitsBox.checked && isSym && noteUnits(it, got) > 1) });
      if (shown && shown.row.key === row.key) { finish(shown.got); return; }
      okBtn.disabled = true; status.textContent = "Loading " + it.name + "…";
      fetchItem(kind, it, ctx).then((got) => { if (!closed) finish(got); }, (e: Error) => { if (closed) return; okBtn.disabled = false; status.textContent = e.message || String(e); });
    }
    /** LIB_TREE::ExpandAll / CollapseAll: every library (a search keeps its "closed by hand" marks) */
    function expandAll(open: boolean): void {
      const searching = !!query;
      for (const g of groups) {
        if (searching) { if (open) expanded.delete("-" + g.key); else expanded.add("-" + g.key); }
        else if (open) { expanded.add(g.key); void loadGroup(g); } else expanded.delete(g.key);
      }
      if (!open) for (const k of Array.from(expanded)) if (k.includes("/")) expanded.delete(k);
      refresh();
    }
    function toggle(row: Row): void {
      if (!row.expandable) return;
      if (row.depth === 0 && query) { if (row.expanded) expanded.add("-" + row.key); else expanded.delete("-" + row.key); }
      else if (row.expanded) expanded.delete(row.key); else expanded.add(row.key);
      if (row.depth === 0 && !row.expanded) void loadGroup(row.group);
      refresh();
    }

    // ---- events
    rowsEl.addEventListener("mousedown", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>(".klib-row"); if (!el) return;
      const row = rows[+el.dataset.i!]; if (!row) return;
      noteSearch(); userPicked = true;
      if ((ev.target as HTMLElement).closest(".klib-tw")) { select(row.key); toggle(row); ev.preventDefault(); return; }
      select(row.key);
    });
    rowsEl.addEventListener("dblclick", (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>(".klib-row"); if (!el) return;
      const row = rows[+el.dataset.i!]; if (!row || (ev.target as HTMLElement).closest(".klib-tw")) return;
      if (row.item) accept(); else toggle(row);
    });
    // LIB_TREE::onItemContextMenu: Pin Library / Unpin Library on a library node
    rowsEl.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const el = (ev.target as HTMLElement).closest<HTMLElement>(".klib-row"); if (!el) return;
      const row = rows[+el.dataset.i!]; if (!row) return;
      userPicked = true; select(row.key);
      if (row.depth !== 0 || row.group.type !== "lib") return;
      const name = row.group.label, on = pinned.has(name);
      popupMenu(ev.clientX, ev.clientY, [{ label: on ? "Unpin Library" : "Pin Library", run: () => { if (on) pinned.delete(name); else pinned.add(name); savePinned(kind, pinned); refresh(); } }]);
    });
    // LIB_TREE::onHeaderContextMenu: "Select Columns..." (EDA_REORDERABLE_LIST_DIALOG "Select Columns")
    head.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      popupMenu(ev.clientX, ev.clientY, [{ label: "Select Columns...", run: () => selectColumns(availableColumns(kind), columns, (list) => { columns = list; saveJson(colsKey, columns); layoutColumns(); refresh(); }) }]);
    });
    tree.addEventListener("scroll", queueDraw);
    // the filter check boxes regenerate the tree with its state kept (Regenerate( true )): the selection stays
    const onFilterToggle = () => { saveFpFilterPrefs(fpFiltering()); refresh(); if (selKey) scrollTo(selKey); };
    if (byPinsBox) byPinsBox.addEventListener("change", onFilterToggle);
    if (byFiltersBox) byFiltersBox.addEventListener("change", onFilterToggle);
    // LIB_TREE::onQueryText restarts m_queryDebounce (200 ms); onQueryDebounce regenerates the tree
    let inputTimer = 0;
    function onInput(now = false): void {
      filterBox.classList.toggle("has-text", !!input.value);
      window.clearTimeout(inputTimer);
      const run = () => {
        inputTimer = 0; if (closed) return;
        const next = input.value.trim();
        // UpdateSearchString collapses every library before a search (the ones with matches open again); emptied, the
        // tree keeps the libraries that were open
        if (next) expanded.clear();
        else if (query) { const open = rows.filter((r) => r.depth === 0 && r.expanded).map((r) => r.key); for (const k of Array.from(expanded)) if (k.startsWith("-")) expanded.delete(k); for (const k of open) expanded.add(k); }
        query = next;
        tree.scrollTop = 0; refresh(true);
        // show the vendor search as busy from the first keystroke, not only once the debounce fires
        if (query) for (const g of sourceGroups.values()) if (g.src && groups.includes(g)) { g.loading = true; g.error = ""; }
        window.clearTimeout(sourceTimer); sourceTimer = window.setTimeout(searchSources, 250);
        if (query) queueRefresh();
      };
      if (now) run(); else inputTimer = window.setTimeout(run, 200);
    }
    input.addEventListener("input", () => onInput());
    $<HTMLElement>(".klib-clear").addEventListener("click", () => { input.value = ""; onInput(true); input.focus(); });
    $<HTMLElement>(".klib-cancel").addEventListener("click", () => close(null));
    $<HTMLElement>(".kd-x").addEventListener("click", () => close(null));
    okBtn.addEventListener("click", accept);
    // DIALOG_SHIM: a click on the frame behind a modal dialog does nothing (only OK / Cancel / Esc / the close box end it)
    function move(delta: number): void {
      if (!rows.length) return;
      let i = rows.findIndex((r) => r.key === selKey);
      i = i < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, i + delta));
      userPicked = true; select(rows[i].key);
    }
    // The dialog is modal: it sees every key first, so the editor's hotkeys stay asleep behind it.
    function onKey(ev: KeyboardEvent): void {
      if (closed) return;
      if (document.querySelector(".kd-pop")) return;     // a popup menu of the tree (config, recent searches, pin) has the keys
      const overlays = document.querySelectorAll(".kd-overlay"); if (overlays.length && overlays[overlays.length - 1] !== ov) return;   // a message box or the columns dialog over it
      const inDialog = dlg.contains(ev.target as Node), inText = ev.target === input;
      const page = Math.max(1, Math.floor((tree.clientHeight || 300) / ROW_H) - 1);
      const row = selectedRow();
      let handled = true;
      switch (ev.key) {
        // LIB_TREE: Esc in a filter holding text clears it (the footprint chooser's frame clears it from anywhere);
        // otherwise the dialog closes
        case "Escape": if (dlg.querySelector("[data-popup-open]")) { handled = false; break; }
          if ((inText || fpChooser) && input.value) { input.value = ""; onInput(true); input.focus(); } else close(null); break;
        case "Enter": if (ev.target instanceof HTMLButtonElement) { handled = false; break; } noteSearch(); if (row && row.item) accept(); else if (row) toggle(row); break;
        case "ArrowDown": noteSearch(); move(1); break;
        case "ArrowUp": noteSearch(); move(-1); break;
        case "PageDown": move(page); break;
        case "PageUp": move(-page); break;
        // wxDataViewCtrl: Right opens and Left closes the selected node, nothing more
        case "ArrowRight": if (inText) { handled = false; break; } if (row && row.expandable && !row.expanded) toggle(row); break;
        case "ArrowLeft": if (inText) { handled = false; break; } if (row && row.expandable && row.expanded) toggle(row); break;
        default:
          // the numeric keypad's + / - open and close a library
          if ((ev.code === "NumpadAdd" || ev.code === "NumpadSubtract") && !inText) { if (row && row.depth === 0 && row.expandable && row.expanded === (ev.code === "NumpadSubtract")) toggle(row); break; }
          handled = false;
      }
      if (handled) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      if (!inDialog) { if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) input.focus(); else if (ev.key !== "Tab") { ev.stopImmediatePropagation(); ev.preventDefault(); } return; }
      // typing anywhere in the dialog goes to the filter, as in KiCad's tree
      if (!inText && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !(ev.target instanceof HTMLInputElement) && !(ev.target instanceof HTMLButtonElement && ev.key === " ")) input.focus();
      ev.stopPropagation();
    }
    window.addEventListener("keydown", onKey, true);

    // the title bar drags the dialog, the sashes resize the panes, previews follow the box; size and sashes are kept
    const saved = loadJson<{ w?: number; h?: number; split?: number; details?: number }>(sizeKey, {});
    if (saved.w && saved.h) { dlg.style.width = Math.min(saved.w, window.innerWidth * 0.98) + "px"; dlg.style.height = Math.min(saved.h, window.innerHeight * 0.96) + "px"; }
    const titleBar = $<HTMLElement>(".kd-title"); let dragFrom: [number, number] | null = null;
    titleBar.addEventListener("pointerdown", (ev) => {
      if ((ev.target as HTMLElement).closest(".kd-x")) return;
      const r = dlg.getBoundingClientRect(); dragFrom = [ev.clientX - r.left, ev.clientY - r.top];
      dlg.style.position = "fixed"; dlg.style.margin = "0"; dlg.style.left = r.left + "px"; dlg.style.top = r.top + "px"; titleBar.setPointerCapture(ev.pointerId);
    });
    titleBar.addEventListener("pointermove", (ev) => { if (!dragFrom) return; dlg.style.left = Math.max(0, ev.clientX - dragFrom[0]) + "px"; dlg.style.top = Math.max(0, ev.clientY - dragFrom[1]) + "px"; });
    titleBar.addEventListener("pointerup", () => { dragFrom = null; });
    const split = $<HTMLElement>(".klib-split"), mainEl = $<HTMLElement>(".klib-main"); let splitting = false, splitPx = saved.split || 0, detailsPx = saved.details || 0;
    const setSplit = (px: number): void => { const r = mainEl.getBoundingClientRect(); splitPx = Math.max(320, Math.min((r.width || 1000) - 250, px)); mainEl.style.gridTemplateColumns = `${splitPx}px 5px minmax(240px, 1fr)`; };
    if (splitPx) setSplit(splitPx);
    split.addEventListener("pointerdown", (ev) => { splitting = true; split.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    split.addEventListener("pointermove", (ev) => { if (splitting) setSplit(ev.clientX - mainEl.getBoundingClientRect().left); });
    split.addEventListener("pointerup", () => { splitting = false; });
    // the bottom details pane's sash (wxSplitterWindow, vertical split): dragged up and down
    const hsplit = dlg.querySelector<HTMLElement>(".klib-hsplit"); let hsplitting = false;
    const setDetails = (px: number): void => { const body = $<HTMLElement>(".klib-body").getBoundingClientRect(); detailsPx = Math.max(60, Math.min((body.height || 600) - 200, px)); details.style.height = detailsPx + "px"; };
    if (hsplit) {
      if (detailsPx) setDetails(detailsPx);
      hsplit.addEventListener("pointerdown", (ev) => { hsplitting = true; hsplit.setPointerCapture(ev.pointerId); ev.preventDefault(); });
      hsplit.addEventListener("pointermove", (ev) => { if (hsplitting) setDetails(details.getBoundingClientRect().bottom - ev.clientY - 2); });
      hsplit.addEventListener("pointerup", () => { hsplitting = false; });
    }
    // The Item column (LIB_TREE's wxDataViewCtrl column): dragged at its right edge, double-clicked to fit the longest
    // name in view, and kept per kind (m_colWidths).  Footprint names are long, so their column starts wider.
    const colKey = "kui.chooser.col." + kind;
    const setCol = (px: number, keep = true): void => {
      const w = Math.round(Math.max(120, Math.min((leftEl.clientWidth || 600) - 80, px)));
      leftEl.style.setProperty("--klib-col", w + "px"); if (keep) { try { localStorage.setItem(colKey, String(w)); } catch { /* private mode */ } }
    };
    let savedCol = 0; try { savedCol = Number(localStorage.getItem(colKey)) || 0; } catch { savedCol = 0; }
    if (savedCol > 0) setCol(savedCol, false); else if (!isSym) leftEl.style.setProperty("--klib-col", "60%");
    function wireGrip(grip: HTMLElement): void {
      let colDrag = false;
      grip.addEventListener("pointerdown", (ev) => { colDrag = true; grip.setPointerCapture(ev.pointerId); ev.preventDefault(); ev.stopPropagation(); });
      grip.addEventListener("pointermove", (ev) => { if (colDrag) setCol(ev.clientX - leftEl.getBoundingClientRect().left); });
      grip.addEventListener("pointerup", () => { colDrag = false; });
      grip.addEventListener("dblclick", () => { let w = 0; for (const el of Array.from(rowsEl.querySelectorAll<HTMLElement>(".klib-item"))) w = Math.max(w, el.scrollWidth); if (w) setCol(w + 12); });
    }
    layoutColumns();
    const ro = new ResizeObserver(() => { queueDraw(); mainP.redraw(); if (fpP) fpP.redraw(); if (!mainP.draw) blankIfIdle(); });
    const blankIfIdle = (): void => { if (!selectedRow() || !selectedRow()!.item) { clearPreview(mainCanvas, kind); if (fpCanvas && !(fpP && fpP.draw)) clearPreview(fpCanvas, "footprint"); } };
    ro.observe(tree); ro.observe(mainCanvas); if (fpCanvas) ro.observe(fpCanvas);

    layoutFpPanes();
    refresh(true); if (!selKey) blank(); searchSources();
    input.focus(); input.select();
  });
}

/** EDA_REORDERABLE_LIST_DIALOG: the available columns on the left, the shown ones on the right (Item stays first and
 *  cannot be removed); ">" / "<" move the selected entry across, the arrows reorder the shown list. */
function selectColumns(all: string[], shown: string[], ok: (list: string[]) => void): void {
  let enabled = shown.slice(), avail = all.filter((c) => !enabled.includes(c)), selA = 0, selE = 0;
  const ov = document.createElement("div"); ov.className = "kd-overlay"; ov.style.zIndex = "10050";
  const dlg = document.createElement("div"); dlg.className = "kd-dialog klib-cols-dlg"; dlg.setAttribute("role", "dialog");
  dlg.innerHTML = `<div class="kd-title"><span>Select Columns</span></div>
    <div class="klib-cols-body"><div class="klib-colbox"><span>Available:</span><ul class="klib-avail"></ul></div>
      <div class="klib-colbtns"><button class="btn klib-add" type="button">&gt;</button><button class="btn klib-rem" type="button">&lt;</button></div>
      <div class="klib-colbox"><span>Enabled:</span><ul class="klib-enabled"></ul></div><div class="klib-colbtns klib-updown"></div></div>
    <div class="kd-foot"><span class="spacer"></span><button class="btn klib-ccancel" type="button">Cancel</button><button class="btn primary klib-cok" type="button">OK</button></div>`;
  ov.append(dlg); document.body.append(ov);
  const ulA = dlg.querySelector<HTMLElement>(".klib-avail")!, ulE = dlg.querySelector<HTMLElement>(".klib-enabled")!;
  const addBtn = dlg.querySelector<HTMLButtonElement>(".klib-add")!, remBtn = dlg.querySelector<HTMLButtonElement>(".klib-rem")!;
  const draw = (): void => {
    ulA.innerHTML = avail.map((c, i) => `<li data-i="${i}" class="${i === selA ? "sel" : ""}">${esc(c)}</li>`).join("");
    ulE.innerHTML = enabled.map((c, i) => `<li data-i="${i}" class="${i === selE ? "sel" : ""}">${esc(c)}</li>`).join("");
    addBtn.disabled = !avail.length; remBtn.disabled = !enabled.length;
  };
  ulA.addEventListener("mousedown", (ev) => { const li = (ev.target as HTMLElement).closest("li"); if (li) { selA = +li.dataset.i!; draw(); } });
  ulE.addEventListener("mousedown", (ev) => { const li = (ev.target as HTMLElement).closest("li"); if (li) { selE = +li.dataset.i!; draw(); } });
  addBtn.addEventListener("click", () => {
    if (!avail.length || selA < 0 || selA >= avail.length) return;
    const [c] = avail.splice(selA, 1); const pos = Math.min(selE + 1, enabled.length); enabled.splice(pos, 0, c);
    selE = pos; selA = Math.min(selA, avail.length - 1); draw();
  });
  remBtn.addEventListener("click", () => {
    if (selE <= 0 || selE >= enabled.length) return;              // the Item column stays
    const [c] = enabled.splice(selE, 1); selE = Math.min(selE, enabled.length - 1);
    const pos = Math.max(0, selA); avail.splice(pos, 0, c); draw();
  });
  const updown = dlg.querySelector<HTMLElement>(".klib-updown")!;
  const moveSel = (d: number): void => {
    const to = selE + d; if (selE <= 0 || to <= 0 || to >= enabled.length) return;   // nothing moves above Item
    const t = enabled[selE]; enabled[selE] = enabled[to]; enabled[to] = t; selE = to; draw();
  };
  updown.append(bitmapButton("small_up", "Move up", () => moveSel(-1)), bitmapButton("small_down", "Move down", () => moveSel(1)));
  const done = (accept: boolean): void => { ov.remove(); document.removeEventListener("keydown", key, true); if (accept) ok(enabled.slice()); };
  const key = (ev: KeyboardEvent): void => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopImmediatePropagation(); done(false); } else if (ev.key === "Enter") { ev.preventDefault(); ev.stopImmediatePropagation(); done(true); } };
  document.addEventListener("keydown", key, true);
  dlg.querySelector(".klib-ccancel")!.addEventListener("click", () => done(false));
  dlg.querySelector(".klib-cok")!.addEventListener("click", () => done(true));
  enabled = enabled.length ? enabled : ["Item"]; avail = all.filter((c) => !enabled.includes(c));
  draw();
}
