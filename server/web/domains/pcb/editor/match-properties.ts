// editor/match-properties.ts — Edit > Match Properties (PCB_ACTIONS::matchProperties) and its settings
// (PCB_ACTIONS::matchPropertiesSettings, Ctrl+,): MATCH_PROPERTIES_TOOL (pcbnew/tools/match_properties_tool.cpp) over
// MATCH_PROPERTIES_CATALOG (pcbnew/tools/match_properties.cpp).
//
// One selected item is the source.  The tool clears the selection and waits: the item under the pointer that has
// something in common with the source is lit beside it, a click copies the enabled properties onto it, a drag box
// copies them onto every compatible item it catches (lit as the box grows).  Each copy is one "Match Properties"
// commit; nothing to change says so in the infobar.  Ctrl+, inside the tool opens "Match Properties Settings" with
// the properties the source's kind offers.  Escape (or a right click) ends the tool and selects the source again.
//
// The values are read and written through the Properties panel's own rows (panels/propgrid.ts copyItemProps), so a
// property the catalog names is offered only where that grid edits it.
import { E } from "./state";
import { copyItemProps, itemPropNames, selectedItems } from "./panels/propgrid";
import { loadJson, saveJson } from "./panels/core";
import { candidatesAt } from "./contextmenu";
import { openPopupMenu } from "./contextmenu";
import { boxedBoardItems, clearSelection, drawSelection, renderProps } from "./selection";
import { selectItemId } from "./gestures";
import { isSch, pxPerMm, requestRender, stage, worldMm } from "./view";
import { toolCtx } from "./tools";
import { toast } from "./util";
import { kicursorCss } from "./cursors";
import { h, openDialog } from "./pcbdialogs/ui";
import { keyHooks } from "./hotkeys";

type Family = "route" | "via" | "pad" | "shape" | "text" | "textbox" | "dimension" | "zone" | "rule_area" | "footprint" | "table" | "generated_table" | "table_cell" | "target" | "reference_image" | "barcode";

const FAMILY_LABEL: Record<Family | "common", string> = {
  route: "Tracks and Arcs", via: "Vias", pad: "Pads", shape: "Graphics", text: "Text", textbox: "Text Boxes", dimension: "Dimensions", zone: "Zones",
  rule_area: "Rule Areas", footprint: "Footprints", table: "Tables", generated_table: "Generated Tables", table_cell: "Table Cells", target: "Targets",
  reference_image: "Reference Images", barcode: "Barcodes", common: "Common to Several Kinds",
};

// PROPERTY_BASE::IsCopyable(): the properties each family registers (or inherits) with SetIsCopyable()
const TEXT_PROPS = ["Font", "Thickness", "Italic", "Bold", "Width", "Height", "Horizontal Justification", "Vertical Justification"];
const COPYABLE: Record<Family, string[]> = {
  route: ["Layer", "Width", "Soldermask", "Soldermask Margin Override"],
  via: ["Diameter", "Hole", "Front Tenting", "Back Tenting", "Front Covering", "Back Covering", "Front Plugging", "Back Plugging", "Capping", "Filling"],
  pad: ["Clearance Override", "Soldermask Margin Override", "Solderpaste Margin Override", "Solderpaste Margin Ratio Override", "Zone Connection Style", "Thermal Relief Spoke Width", "Thermal Relief Spoke Angle", "Thermal Relief Gap"],
  shape: ["Layer", "Line Width", "Line Style", "Fill", "Soldermask", "Soldermask Margin Override"],
  text: ["Layer", "Knockout", "Keep Upright", "Visible", ...TEXT_PROPS],
  textbox: ["Layer", "Knockout", "Border", "Border Style", "Border Width", "Margin Left", "Margin Top", "Margin Right", "Margin Bottom", ...TEXT_PROPS],
  dimension: ["Layer", "Units", "Units Format", "Precision", "Suppress Trailing Zeroes", "Arrow Direction", "Line Thickness", "Arrow Length", "Extension Line Offset", "Text Position", "Knockout", ...TEXT_PROPS],
  zone: ["Fill Mode", "Hatch Orientation", "Hatch Width", "Hatch Gap", "Hatch Minimum Hole Ratio", "Smoothing Effort", "Smoothing Amount", "Thieving Pattern", "Thieving Element Size", "Thieving Gap", "Thieving Line Width", "Thieving Stagger", "Thieving Orientation", "Remove Islands", "Minimum Island Area"],
  rule_area: ["Keep Out Tracks", "Keep Out Vias", "Keep Out Pads", "Keep Out Zone Fills", "Keep Out Footprints"],
  footprint: ["Clearance Override", "Solderpaste Margin Override", "Solderpaste Margin Ratio Override", "Zone Connection Style"],
  table: ["Layer", "External Border", "Header Border", "Border Width", "Border Style", "Border Color", "Row Separators", "Cell Separators", "Separators Width", "Separators Style", "Separators Color"],
  generated_table: ["Layer", "Border Width", "Row Separators", "Column Separators", "Row Height", "Font Name", "Font Size"],
  table_cell: ["Font Name", "Font Size", "Knockout", ...TEXT_PROPS],
  target: ["Layer", "Size", "Width", "Shape"],
  reference_image: ["Associated Layer"],
  barcode: ["Layer", "Show Text", "Width", "Height", "Knockout"],
};

/** commonProperties(): one idea under each family's own name ("Width" is a stroke on a track, a glyph on a text). */
const COMMON: Record<string, Partial<Record<Family, string>>> = {
  "Layer": { barcode: "Layer", dimension: "Layer", shape: "Layer", table: "Layer", generated_table: "Layer", target: "Layer", text: "Layer", textbox: "Layer", reference_image: "Associated Layer" },
  "Line Width": { route: "Width", shape: "Line Width", table: "Border Width", generated_table: "Border Width", target: "Width" },
  "Soldermask": { route: "Soldermask", shape: "Soldermask" },
  "Soldermask Margin Override": { pad: "Soldermask Margin Override", route: "Soldermask Margin Override", shape: "Soldermask Margin Override" },
  "Font": { dimension: "Font", table_cell: "Font", text: "Font", textbox: "Font" },
  "Text Width": { dimension: "Width", table_cell: "Width", text: "Width", textbox: "Width" },
  "Text Height": { dimension: "Height", table_cell: "Height", text: "Height", textbox: "Height" },
  "Text Thickness": { dimension: "Thickness", table_cell: "Thickness", text: "Thickness", textbox: "Thickness" },
  "Bold": { dimension: "Bold", table_cell: "Bold", text: "Bold", textbox: "Bold" },
  "Italic": { dimension: "Italic", table_cell: "Italic", text: "Italic", textbox: "Italic" },
  "Horizontal Justification": { dimension: "Horizontal Justification", table_cell: "Horizontal Justification", text: "Horizontal Justification", textbox: "Horizontal Justification" },
  "Vertical Justification": { dimension: "Vertical Justification", table_cell: "Vertical Justification", text: "Vertical Justification", textbox: "Vertical Justification" },
  "Knockout": { barcode: "Knockout", dimension: "Knockout", table_cell: "Knockout", text: "Knockout", textbox: "Knockout" },
};

/** The Properties panel's names where they differ from the C++ registration (a graphic's Fill is its "Filled" box). */
const GRID_NAME: Record<string, string> = { "shape/Fill": "Filled" };
const gridName = (family: string, name: string): string => GRID_NAME[family + "/" + name] || name;

/** AllSafeKeys() and commonReach(): a common key stands in for the family keys it covers (when two or more do). */
const CATALOG = (() => {
  const keys = new Set<string>(); const reach = new Map<string, Partial<Record<Family, string>>>();
  for (const [f, names] of Object.entries(COPYABLE)) for (const n of names) keys.add(f + "/" + n);
  for (const [key, names] of Object.entries(COMMON)) {
    const covered = Object.entries(names).filter(([f, n]) => keys.has(f + "/" + n));
    if (covered.length < 2) continue;
    for (const [f, n] of covered) keys.delete(f + "/" + n);
    keys.add("common/" + key); reach.set(key, Object.fromEntries(covered));
  }
  return { keys, reach };
})();

export const DEFAULT_KEYS = ["common/Layer", "common/Line Width", "shape/Fill", "common/Soldermask", "common/Soldermask Margin Override", "common/Font", "common/Text Width",
  "common/Text Height", "common/Text Thickness", "common/Bold", "common/Italic", "shape/Line Style", "via/Diameter", "via/Hole", "zone/Fill Mode", "table/Border Style"];

/** MATCH_PROPERTIES_CATALOG::Family. */
export function familyOf(it: KItem | null | undefined): Family | "" {
  if (!it) return "";
  switch (it.kind) {
  case "segment": case "arc": return "route";
  case "via": return "via";
  case "pad": return "pad";
  case "gr_line": case "gr_rect": case "gr_circle": case "gr_arc": case "gr_poly": case "gr_curve": return "shape";
  case "gr_text": return "text";
  case "gr_text_box": return it.node.some((c) => Array.isArray(c) && c[0] === "start") ? "textbox" : "text";
  case "dimension": return "dimension";
  case "footprint": return "footprint";
  case "table": return "table";
  case "target": return "target";
  case "image": return "reference_image";
  case "barcode": return "barcode";
  case "zone": return it.node.some((c) => Array.isArray(c) && c[0] === "keepout") ? "rule_area" : "zone";
  default: return "";
  }
}

/** FamiliesFor( key ). */
function familiesFor(key: string): string[] {
  const [fam, name] = [key.slice(0, key.indexOf("/")), key.slice(key.indexOf("/") + 1)];
  if (fam !== "common") return [fam];
  return Object.keys(CATALOG.reach.get(name) || {});
}

/** MATCH_PROPERTIES_CATALOG::Compatible: the same kind, or two kinds that share a common property. */
export function compatible(source: KItem, target: KItem): boolean {
  const s = familyOf(source), t = familyOf(target); if (!s || !t) return false;
  if (s === t) return true;
  for (const names of CATALOG.reach.values()) if (s in names && t in names) return true;
  return false;
}

// PCB_VIEWERS_SETTINGS_BASE::m_MatchProperties (the user's pcbnew settings: this browser's)
const STORE_KEY = "kc.pcbnew.matchProperties";
export function enabledKeys(): Set<string> { const v = loadJson<{ keys?: string[] }>(STORE_KEY, { keys: DEFAULT_KEYS }); return new Set(Array.isArray(v.keys) ? v.keys : DEFAULT_KEYS); }
function saveEnabled(keys: Set<string>): void { saveJson(STORE_KEY, { keys: [...keys].sort() }); }

/** plan(): [source name, target name, optional] for the keys enabled. */
export function planPairs(source: KItem, target: KItem, enabled: Set<string>): [string, string, boolean][] {
  const sf = familyOf(source), tf = familyOf(target), across = sf !== tf, out: [string, string, boolean][] = [];
  if (!sf || !tf) return out;
  if (!across) for (const key of enabled) if (key.startsWith(sf + "/") && CATALOG.keys.has(key)) { const n = gridName(sf, key.slice(sf.length + 1)); out.push([n, n, false]); }
  for (const [key, names] of CATALOG.reach) {
    const sn = names[sf as Family], tn = names[tf as Family]; if (!sn || !tn || !enabled.has("common/" + key)) continue;
    out.push([gridName(sf, sn), gridName(tf, tn), across]);
  }
  return out;
}

/** The catalog's rows for a source: the keys of its family the Properties panel edits on it, sorted by label. */
function rowsFor(source: KItem): { key: string; label: string }[] {
  const f = familyOf(source); if (!f) return [];
  const names = itemPropNames(source), out: { key: string; label: string }[] = [];
  for (const key of CATALOG.keys) {
    if (!familiesFor(key).includes(f)) continue;
    const prop = key.slice(key.indexOf("/") + 1), common = key.startsWith("common/");
    const name = common ? (CATALOG.reach.get(prop) || {})[f] : prop; if (!name || !names.has(gridName(f, name))) continue;
    out.push({ key, label: prop });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}
/** How many of the enabled keys this kind of source can offer (the prompt's count). */
function enabledCount(source: KItem): number { const on = enabledKeys(); return rowsFor(source).filter((r) => on.has(r.key)).length; }

/** MATCH_PROPERTIES_DIALOG: one check list of the source family's properties; right click checks or unchecks them all. */
export function openMatchSettings(source: KItem, done?: () => void): void {
  const f = familyOf(source); if (!f) return;
  const enabled = enabledKeys(), rows = rowsFor(source);
  const boxes: { key: string; cb: HTMLInputElement }[] = [];
  openDialog({ title: "Match Properties Settings", width: 420,
    build(body) {
      const list = h("div", { class: "mp-list", style: "height:320px;overflow:auto;border:1px solid var(--line);padding:2px 4px", "data-k": "properties" });
      for (const r of rows) {
        const cb = h("input", { type: "checkbox" }) as HTMLInputElement; cb.checked = enabled.has(r.key); boxes.push({ key: r.key, cb });
        list.append(h("label", { style: "display:flex;gap:6px;align-items:center;padding:1px 0" }, cb, r.label));
      }
      list.addEventListener("contextmenu", (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        openPopupMenu(ev.clientX, ev.clientY, [{ label: "Check All", run: () => boxes.forEach((b) => { b.cb.checked = true; }) }, { label: "Uncheck All", run: () => boxes.forEach((b) => { b.cb.checked = false; }) }]);
      });
      body.append(h("div", { class: "pd-lbl", style: "margin-bottom:6px" }, `Properties copied from ${FAMILY_LABEL[f]}:`), list);
    },
    ok() {
      // only the rows on screen are answered for: another kind's properties were never shown
      for (const b of boxes) { if (b.cb.checked) enabled.add(b.key); else enabled.delete(b.key); }
      saveEnabled(enabled); if (done) done();
    },
    cancel() { if (done) done(); return true; },
  });
}

// ---------------------------------------------------------------- the interactive tool
/**
 * The tool's keys, ahead of the board's hotkeys: Escape ends it, Ctrl+, (PCB_ACTIONS::matchPropertiesSettings, AS_CONTEXT:
 * it shadows Preferences only while the tool runs) opens the settings.
 */
let hooked = false;
const hookKeys = (): void => { if (hooked) return; hooked = true; keyHooks.push((ev: KeyboardEvent): boolean => {
  if (!run || document.querySelector(".kd-overlay")) return false;
  if (ev.key === "Escape") { ev.preventDefault(); finish(); return true; }
  if (ev.key === "," && (ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey) {
    ev.preventDefault();
    const s = source(); if (s) openMatchSettings(s, () => { const at = E.lastCursorMm as number[] | undefined; if (at) updateHover(at); });
    return true;
  }
  return false;
}); };
interface Run { sourceId: string; hover: string | null; box: { start: number[]; cur: number[]; client: number[] } | null; down: number[] | null; listeners: [EventTarget, string, EventListener][] }
let run: Run | null = null;

export const matchRunning = (): boolean => !!run;
const doc = (): KDoc | null => (E.kdoc && !isSch() ? E.kdoc as KDoc : null);
const source = (): KItem | null => { const d = doc(); return run && d ? d.items.get(run.sourceId) || null : null; };
interface PcbState { popup?: { text: string; at: number[]; until: number } | null }
const pcbState = (): PcbState | null => (CollabTools.pcb && CollabTools.pcb.state as unknown as PcbState) || null;

function brighten(ids: string[]): void { (E as { dialogBrightened?: Set<string> | null }).dialogBrightened = ids.length ? new Set(ids) : null; requestRender(); }
function promptText(): string { const s = source(); return `Click or drag over the items to copy to.\n${s ? enabledCount(s) : 0} properties enabled; Ctrl+, for settings.`; }
function popupAt(mm: number[]): void { const st = pcbState(); if (st) st.popup = { text: promptText(), at: mm.slice(), until: Number.MAX_SAFE_INTEGER }; }

/** HOVER_PICKER::Pick: the best candidate under the pointer that the source accepts. */
function pick(mm: number[]): KItem | null {
  const d = doc(), s = source(); if (!d || !s) return null;
  const ids = candidatesAt(mm as [number, number]).filter((id) => !id.includes("#") && !id.includes("@field:"));
  const ok = ids.map((id) => d.items.get(id)).filter((it): it is KItem => !!it && it.id !== s.id && compatible(s, it));
  if (ok.length < 2) return ok[0] || null;
  const P = (window as unknown as { PcbTools?: { guessCandidates?(d: KDoc, ids: string[], at: number[], o: { px: number; hidden: Set<string> }): string[] } }).PcbTools;
  if (P && P.guessCandidates) { try { const g = P.guessCandidates(d, ok.map((it) => it.id), mm, { px: 1 / Math.max(1e-6, pxPerMm()), hidden: E.hiddenLayers as Set<string> }); const it = g.length && d.items.get(g[0]); if (it) return it; } catch (e) { console.warn(e); } }
  return ok[0];
}

function updateHover(mm: number[]): void {
  const s = source(); popupAt(mm);
  if (!s) { brighten([]); return; }   // an undo took the source away: nothing is a target
  const t = pick(mm); run!.hover = t ? t.id : null;
  brighten(t ? [s.id, t.id] : [s.id]);
}

/** applyToTargets: one commit for every target, or the infobar's reason nothing changed. */
export function applyToTargets(src: KItem, targets: KItem[]): boolean {
  const d = doc(); if (!d || !targets.length) return false;
  if (E.viewOnly) { toast("View-only access"); return false; }
  const enabled = enabledKeys(), changes: KChange[] = []; let changed = 0;
  for (const t of targets) {
    if (!compatible(src, t)) { toast("The source and target have no properties in common."); return false; }
    const r = copyItemProps(src, t, planPairs(src, t, enabled));
    if (r.error) { toast(r.error, 4000); return false; }
    changed += r.changed; if (r.change) changes.push(r.change);
  }
  if (!changed || !changes.length) { toast("Nothing to copy.  The target already matches the source."); return false; }
  toolCtx().commit(changes, "Match Properties");
  return true;
}

function finish(): void {
  const r = run; if (!r) return; run = null;
  for (const [t, type, fn] of r.listeners) t.removeEventListener(type, fn, true);
  brighten([]); E.boxSel = null; const st = pcbState(); if (st) st.popup = null;
  stage.style.cursor = "";
  clearSelection();
  const d = doc(); if (d && d.items.has(r.sourceId)) selectItemId(r.sourceId);
  drawSelection(); renderProps(); requestRender();
}

/** MATCH_PROPERTIES_TOOL::Match. */
export function matchProperties(): boolean {
  const d = doc(); if (!d) return false;
  if (run) return true;
  const sel = selectedItems();
  if (sel.length !== 1) { toast("Select one item to copy properties from.", 8000, undefined, "error"); return true; }
  const src = sel[0];
  if (!familyOf(src)) { toast("The selected source item has no properties to match.", 8000, undefined, "error"); return true; }
  if (!enabledCount(src)) toast("No properties are enabled for this kind of item.  Press Ctrl+, to choose some.", 4000);
  hookKeys();
  const r: Run = { sourceId: src.id, hover: null, box: null, down: null, listeners: [] }; run = r;
  const on = (t: EventTarget, type: string, fn: (ev: Event) => void) => { t.addEventListener(type, fn as EventListener, true); r.listeners.push([t, type, fn as EventListener]); };
  const cursor = kicursorCss("BULLSEYE");
  clearSelection(); drawSelection(); renderProps();
  on(stage, "pointerdown", (e) => {
    const ev = e as PointerEvent; ev.stopImmediatePropagation(); ev.preventDefault();
    if (ev.button === 2) { finish(); return; }
    if (ev.button !== 0) return;
    try { stage.setPointerCapture(ev.pointerId); } catch (x) { /* synthetic */ }
    const mm = worldMm(ev); r.down = [ev.clientX, ev.clientY]; r.box = { start: mm.slice(), cur: mm.slice(), client: [ev.clientX, ev.clientY] };
  });
  on(stage, "pointermove", (e) => {
    const ev = e as PointerEvent; const mm = worldMm(ev); stage.style.cursor = cursor;
    if (r.box && (ev.buttons & 1)) {
      ev.stopImmediatePropagation();
      r.box.cur = mm.slice();
      if (Math.hypot(ev.clientX - r.box.client[0], ev.clientY - r.box.client[1]) >= 4) {
        E.boxSel = { start: r.box.start as [number, number], cur: mm as [number, number], pts: [], lasso: false, add: false, startClient: r.box.client as [number, number] };
        const s = source(); popupAt(mm);
        if (s) brighten([s.id, ...boxedBoardItems(r.box.start, mm).filter((it) => it.id !== s.id && compatible(s, it)).map((it) => it.id)]);   // the area preview
        return;
      }
    }
    updateHover(mm);
  });
  on(stage, "pointerup", (e) => {
    const ev = e as PointerEvent; if (ev.button !== 0 || !r.box) return; ev.stopImmediatePropagation();
    const b = r.box; r.box = null; const wasBox = !!E.boxSel; E.boxSel = null;
    const s = source(); const mm = worldMm(ev);
    if (!s) { toast("The Match Properties source no longer exists.", 8000, undefined, "error"); requestRender(); return; }
    if (wasBox) { const targets = boxedBoardItems(b.start, mm).filter((it) => it.id !== s.id && compatible(s, it)); brighten([]); applyToTargets(s, targets); }
    else { const t = pick(mm); if (t) { brighten([]); applyToTargets(s, [t]); } }
    updateHover(mm);
  });
  on(stage, "click", (e) => { e.stopImmediatePropagation(); });
  on(stage, "dblclick", (e) => { e.stopImmediatePropagation(); });
  on(stage, "contextmenu", (e) => { e.stopImmediatePropagation(); e.preventDefault(); });
  const at = (E.lastCursorMm as number[] | undefined) || null; if (at) updateHover(at); else brighten([src.id]);
  stage.style.cursor = cursor;
  return true;
}

/** matchPropertiesSettings outside the tool: the settings only open from inside it (nothing happens). */
export function matchPropertiesSettings(): boolean {
  if (!run) return false;
  const s = source(); if (s) openMatchSettings(s);
  return true;
}

/** Leave the tool (another tool was picked, the document changed). */
export function cancelMatchProperties(): void { finish(); }

// for the browser tests: the catalog as the tool reads it
(globalThis as unknown as { KiCadMatchProperties?: unknown }).KiCadMatchProperties = { familyOf, compatible, planPairs, enabledKeys, rowsFor, boxedBoardItems, copyItemProps };
