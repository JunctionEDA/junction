// msgpanel.ts — feeds KiCad's message panel (EDA_MSG_PANEL, the two-row strip above the status bar).
//
// pcbnew refreshes it on every selection change (PCB_BASE_FRAME::UpdateMsgPanel): the one selected item's
// GetMsgPanelInfo, the board summary (BOARD::GetMsgPanelInfo) otherwise, and the router's net / width /
// clearance while a track is being routed (ROUTER_TOOL::UpdateMessagePanel).  The columns are computed by the
// board module (pcb-tools.js msgPanelInfo); this file only decides when to ask again and publishes the result.
import { chainNameForNet } from "./netchains";
import { state, store } from "./appstore";
import { E } from "./state";
import { isSch } from "./view";
import { selectionIds } from "./gestures";
import { nameOfPick, netMap } from "./schnets";
import { variantView } from "./variant";
import { messageText } from "../../../shared/units";
import type { Units } from "../../../shared/store";
import { toDisplayAbsAxis } from "./userorigin";

export interface MsgItem { title: string; value: string }
type PcbApi = { msgPanelInfo?: (doc: KDoc, ids: string[], opts: Record<string, unknown>) => MsgItem[]; designSettings?: (src: unknown) => unknown };
type RouteState = { net?: { name?: string }; netKey?: string; width?: number; layer?: string; connected?: number | null } | null;

/**
 * Sub-item panels registered by other modules (tablecells.ts: a single selected table cell's
 * PCB_TABLECELL / SCH_TABLECELL::GetMsgPanelInfo, panels/constraints.ts: a badge-selected constraint).  The first hook
 * that answers wins; null passes.  The list has no initialiser: a module that registers as it loads may be reached
 * through an import cycle that runs it before this module's own body (panels/constraints.ts via tools.ts).
 */
let msgHookList: Array<(units: string) => MsgItem[] | null> | undefined;
export function addMsgHook(h: (units: string) => MsgItem[] | null): void { (msgHookList || (msgHookList = [])).push(h); }

let lastKey = "", settingsSrc: unknown = undefined, settings: unknown = null;

/** Recompute the panel when the document, the selection, the units or the route changed (called every frame: cheap). */
export function updateMsgPanel(): void {
  const doc = E.kdoc as KDoc | null;
  const P = (window as unknown as { PcbTools?: PcbApi }).PcbTools;
  if (doc) for (const h of msgHookList || []) {
    let hi: MsgItem[] | null = null; try { hi = h(E.units); } catch (e) { console.warn(e); }
    if (!hi) continue;
    const k = "hook§" + JSON.stringify(hi); if (k !== lastKey) { lastKey = k; store.set({ msgPanel: { items: hi } }); }
    return;
  }
  if (doc && isSch()) { updateSchMsgPanel(doc); return; }
  // a DRC marker picked on the board (PCB_MARKER is a selectable item): PCB_MARKER::GetMsgPanelInfo
  const bm = doc && P ? ((P as unknown as { state?: { markers?: BoardMarkerSel[] } }).state?.markers || []).find((m) => m && m.selected) : null;
  if (doc && bm) {
    const key = ["drcmarker", bm.code, bm.text, bm.severity, bm.comment || "", (bm.ids || []).join(","), E.units].join("§");
    if (key !== lastKey) { lastKey = key; store.set({ msgPanel: { items: boardMarkerMsgPanel(doc, bm) } }); }
    return;
  }
  if (!doc || !P || !P.msgPanelInfo) { if (lastKey) { lastKey = ""; store.set({ msgPanel: { items: [] } }); } return; }
  const pcb = CollabTools.pcb && (CollabTools.pcb.state as unknown as { route?: RouteState; sel?: Set<string>; padSel?: string | null; highlightNet?: string | null });
  const rt = pcb ? pcb.route || null : null;
  const pad = pcb && pcb.padSel ? pcb.padSel : null;
  const ids = pad ? [pad] : selectionIds();
  const ver = (store.get() as { document: { version: number } }).document.version;
  const key = [ver, E.currentVariant || "", E.units, ids.join(","), rt ? `${rt.netKey}|${rt.width}|${rt.layer}` : "", doc.items.size, pcb && pcb.highlightNet ? pcb.highlightNet : "", E.activeLayer || ""].join("§");
  if (key === lastKey) return; lastKey = key;
  const src = E.proSettings;
  if (src !== settingsSrc) { settingsSrc = src; settings = P.designSettings ? P.designSettings(src || null) : null; }
  let items: MsgItem[] = [];
  if (doc.fpEditor && !ids.length && !rt) { store.set({ msgPanel: { items: footprintMsgPanel(doc) } }); return; }
  try { items = P.msgPanelInfo(variantView(doc) as KDoc, ids, { settings, units: E.units, route: rt && rt.width ? rt : null, net: pcb && pcb.highlightNet && E.highlightIds ? pcb.highlightNet : null, ellipsize: ellipsizeEnd, toDisplay: (p: [number, number]) => [toDisplayAbsAxis(p[0], "x"), toDisplayAbsAxis(p[1], "y")], activeLayer: E.activeLayer || undefined }); } catch (e) { console.warn(e); }
  if (doc.fpEditor && !items.length) items = footprintMsgPanel(doc);
  store.set({ msgPanel: { items } });
}

interface BoardMarkerSel { code: string; severity: string; text: string; ids: string[]; excluded?: boolean; comment?: string; selected?: boolean; drawingSheet?: boolean; descs?: string[] }
/** PCB_MARKER::GetMsgPanelInfo: Type, Violation, Severity (none for an exclusion), the main | aux item descriptions and Excluded. */
export function boardMarkerMsgPanel(doc: KDoc, m: BoardMarkerSel): MsgItem[] {
  const D = (window as unknown as { PcbTools?: { itemDescription?: (d: KDoc, id: string, u: string) => string } }).PcbTools;
  const excluded = !!m.excluded || m.severity === "exclusion";
  const out: MsgItem[] = [{ title: "Type", value: "Marker" }, { title: "Violation", value: m.text }];
  if (!excluded) { if (m.severity === "ignore") out.push({ title: "Severity", value: "Ignore" }); else if (m.severity === "warning") out.push({ title: "Severity", value: "Warning" }); else if (m.severity === "error") out.push({ title: "Severity", value: "Error" }); }
  const desc = (i: number): string => { const id = (m.ids || [])[i]; if (m.descs && m.descs[i]) return m.descs[i]; return id && D && D.itemDescription && doc.items.has(id) ? D.itemDescription(doc, id, E.units) : ""; };
  out.push(m.drawingSheet ? { title: "Drawing Sheet", value: "" } : { title: desc(0), value: desc(1) });
  if (excluded) out.push({ title: "Excluded", value: m.comment || "" });
  return out;
}

type SchSel = { id: string; pin?: string; field?: string };
type SchMsgApi = { msgPanelInfo?: (doc: KDoc, sel: SchSel & { item?: KItem }, o: Record<string, unknown>) => MsgItem[]; msgPanelSubject?: () => { item: KItem; key: string } | null };

/** The one selected schematic item (a pin, a field or an item), or null when nothing or several are selected. */
function schSingleSelection(): SchSel | null {
  const pins = E.selPins as { id: string; number: string }[];
  if (pins.length) return pins.length === 1 ? { id: pins[0].id, pin: pins[0].number } : null;
  const f = E.selField as { id: string; name: string } | null;
  if (f) return { id: f.id, field: f.name };
  const ids = selectionIds();
  return ids.length === 1 ? { id: ids[0] } : null;
}

/** KIUI::EllipsizeStatusText: 30% of the first 800 px of the panel plus 60% of the rest, cut in the middle. */
let measureCtx: CanvasRenderingContext2D | null = null;
function ellipsize(s: string): string {
  const el = typeof document !== "undefined" ? document.getElementById("msgpanel") : null;
  const w = el ? el.clientWidth : (typeof window !== "undefined" ? window.innerWidth : 1200);
  const limit = Math.min(w, 800) * 0.3 + Math.max(w - 800, 0) * 0.6;
  if (!measureCtx && typeof document !== "undefined") { const c = document.createElement("canvas"); measureCtx = c.getContext("2d"); }
  if (!measureCtx) return s;
  measureCtx.font = el ? getComputedStyle(el).font : "12px sans-serif";
  if (measureCtx.measureText(s).width <= limit) return s;
  // wxControl::Ellipsize( wxELLIPSIZE_MIDDLE )
  let lo = 0, hi = s.length;
  while (lo < hi) { const k = Math.ceil((lo + hi) / 2), t = s.slice(0, Math.ceil(k / 2)) + "..." + s.slice(s.length - Math.floor(k / 2)); if (measureCtx.measureText(t).width <= limit) lo = k; else hi = k - 1; }
  return s.slice(0, Math.ceil(lo / 2)) + "..." + s.slice(s.length - Math.floor(lo / 2));
}

/** KIUI::EllipsizeStatusText as the board items call it: the same width, cut at the end (wxELLIPSIZE_END). */
function ellipsizeEnd(s: string): string {
  const el = typeof document !== "undefined" ? document.getElementById("msgpanel") : null;
  const w = el ? el.clientWidth : (typeof window !== "undefined" ? window.innerWidth : 1200);
  const limit = Math.min(w, 800) * 0.3 + Math.max(w - 800, 0) * 0.6;
  if (!measureCtx && typeof document !== "undefined") { const c = document.createElement("canvas"); measureCtx = c.getContext("2d"); }
  if (!measureCtx) return s;
  measureCtx.font = el ? getComputedStyle(el).font : "12px sans-serif";
  if (measureCtx.measureText(s).width <= limit) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const k = Math.ceil((lo + hi) / 2); if (measureCtx.measureText(s.slice(0, k) + "...").width <= limit) lo = k; else hi = k - 1; }
  return s.slice(0, lo) + "...";
}

/**
 * SCH_INSPECTION_TOOL::UpdateMessagePanel: on every selection change, the one selected item's GetMsgPanelInfo
 * (sch-tools msgpanel.ts), else ClearMsgPanel.  The connection rows come from the hierarchy's net map.
 */
function updateSchMsgPanel(doc: KDoc): void {
  const M = CollabTools.sch as unknown as SchMsgApi | undefined;
  const mk = selectedErcMarker();
  if (mk) {
    const key = ["marker", E.markers.indexOf(mk), mk.severity, mk.comment || "", E.units].join("§");
    if (key !== lastKey) { lastKey = key; store.set({ msgPanel: { items: markerMsgPanel(doc, mk) } }); }
    return;
  }
  // the item a tool holds (on the cursor, or being point-edited) is the subject while the tool runs
  let subj: { item: KItem; key: string } | null = null; try { subj = M && M.msgPanelSubject ? M.msgPanelSubject() : null; } catch (e) { subj = null; }
  const sel: (SchSel & { item?: KItem }) | null = subj ? { id: subj.item.id, item: subj.item } : schSingleSelection();
  const ver = (store.get() as { document: { version: number } }).document.version;
  const sheetPath = ((doc as KDoc & { sheetPath?: string }).sheetPath) || "/";
  const key = ["sch", ver, E.units, sel ? `${sel.id}|${sel.pin ?? ""}|${sel.field ?? ""}` : "", subj ? subj.key : "", sheetPath, E.proSettings ? E.proSettings.length : 0].join("§");
  if (key === lastKey) return; lastKey = key;
  let items: MsgItem[] = [];
  if (sel && M && M.msgPanelInfo) {
    try {
      items = M.msgPanelInfo(doc, sel, { units: E.units, sheetPath, rootName: rootFileName(), ellipsize, connection: (it: KItem, pin?: string) => connectionOf(it, pin) });
    } catch (e) { console.warn(e); }
  }
  store.set({ msgPanel: { items } });
}

interface ErcMarkerSel { code: string; severity: string; text: string; ids: string[]; base?: string; comment?: string; selected?: boolean; items?: { desc: string; len?: number }[] }
/** The ERC marker selected on the canvas (SCH_SELECTION_TOOL holds a SCH_MARKER_T), or null. */
function selectedErcMarker(): ErcMarkerSel | null { return ((E.markers || []) as ErcMarkerSel[]).find((m) => m && m.selected) || null; }
/** SCH_MARKER::GetMsgPanelInfo: Type / Violation / Severity, the main and aux items' descriptions, the exclusion comment. */
function markerMsgPanel(doc: KDoc, m: ErcMarkerSel): MsgItem[] {
  const D = CollabTools.sch as unknown as { itemDescription?: (d: KDoc, id: string, u: string) => string } | undefined;
  const desc = (id: string | undefined): string => (id && D && D.itemDescription && doc.items.has(id) ? D.itemDescription(doc, id, E.units) : "");
  const excluded = m.severity === "exclusion", sev = excluded ? m.base || "warning" : m.severity;
  const un = (KiCadCanvas as unknown as { unescapeText?: (s: string) => string }).unescapeText, text = un ? un(m.text) : m.text;
  const out: MsgItem[] = [{ title: "Type", value: "Marker" }, { title: "Violation", value: text }];
  if (sev === "warning") out.push({ title: "Severity", value: "Warning" }); else if (sev === "error") out.push({ title: "Severity", value: "Error" }); else if (sev === "ignore") out.push({ title: "Severity", value: "Ignore" });
  // the violation's own main and aux items (a pin violation names the pin, "Symbol U1 Pin 3 [IN+, Input, Line]"), on whichever sheet they are
  const own = (i: number): string | null => { const r = m.items && m.items[i]; return r ? (r.len !== undefined ? r.desc.replace("%L", messageText(r.len, (E.units === "in" || E.units === "mil" ? E.units : "mm") as Units, "sch")) : r.desc) : null; };
  const main = own(0), aux = own(1);
  out.push(m.items && m.items.length ? { title: main || "", value: aux || "" } : { title: desc(m.ids[0]), value: desc(m.ids[1]) });
  if (excluded) out.push({ title: "Excluded", value: m.comment || "" });
  return out;
}

/** The root sheet's file name without its extension (SCH_SHEET_PATH::PathHumanReadable( false ) starts with it). */
function rootFileName(): string { try { const c = netMap(); return c ? c.rootName : ""; } catch (e) { return ""; } }
/** SCH_CONNECTIVITY::AppendConnectionInfo's data: the connection's name, bus or net, and the net's resolved netclass. */
function connectionOf(it: KItem, pin?: string): { name: string; bus: boolean; netclass: string; wireWidth?: number; aliases?: { name: string; members: string[] }[]; netChain?: string } | null {
  const r = nameOfPick({ item: it, pin }); if (!r || !r.name) return null;
  const c = netMap(); const e = c ? c.map.get(r.name) : null;
  const bus = !!(e && e.bus);
  let netclass = "Default", wireWidth: number | undefined;
  if (!bus) {
    const PS = (KiCadCanvas as unknown as { pcbSizes?: { boardSizes(src: unknown): unknown; effectiveNetclass(s: unknown, net: string): { name?: string }; effectiveNetclassNames?(s: unknown, net: string): string[] } }).pcbSizes;
    if (PS) { try { if (sizesSrc !== E.proSettings) { sizesSrc = E.proSettings; sizes = PS.boardSizes(E.proSettings || null); } netclass = PS.effectiveNetclass(sizes, r.name).name || "Default";
      if (PS.effectiveNetclassNames) wireWidth = netclassWireWidth(PS.effectiveNetclassNames(sizes, r.name)); } catch (e2) { /* no project */ } }
  }
  let netChain = ""; try { netChain = chainNameForNet(r.name); } catch (e2) { /* no chains yet */ }
  return { name: r.name, bus, netclass, wireWidth, aliases: bus && e && e.aliases ? e.aliases : undefined, netChain };
}
let sizesSrc: unknown = undefined, sizes: unknown = null;
/**
 * The effective netclass's wire width in mm (NETCLASS::GetWireWidth of the merged class: the first of the net's
 * classes, by priority, that sets one, else the Default class's; net_settings.classes[].wire_width is in mils).
 */
function netclassWireWidth(names: string[]): number {
  let classes: { name?: string; wire_width?: number }[] = [];
  try { const pro = JSON.parse((E.proSettings as string | null) || "{}") as { net_settings?: { classes?: { name?: string; wire_width?: number }[] } }; classes = (pro.net_settings && pro.net_settings.classes) || []; } catch (e) { classes = []; }
  for (const n of [...names, "Default"]) { const c = classes.find((x) => x.name === n); if (c && typeof c.wire_width === "number") return c.wire_width * 0.0254; }
  return 6 * 0.0254;
}

/**
 * FOOTPRINT::GetMsgPanelInfo in the Footprint Editor (nothing selected: the frame shows the footprint): reference /
 * value, Library, Footprint Name, Pads (GetNumberedPadCount: distinct numbers of pads that can have one), Doc / Keywords.
 */
export function footprintMsgPanel(doc: KDoc): MsgItem[] {
  const FD = KiCadCanvas.footprintDoc as unknown as { footprintFields(d: KDoc): Record<string, string>; footprintHeaderSexpr(d: KDoc): string }; const f = FD.footprintFields(doc);
  const header = KiCadCanvas.parse(FD.footprintHeaderSexpr(doc)) || ["footprint", ""];
  const kidText = (k: string) => { const c = KiCadCanvas.kid(header, k); return c ? String(c[1] ?? "") : ""; };
  const path = state.doc && state.doc.docId && !state.doc.docId.startsWith("board:") ? state.doc.path : "";
  const lib = path ? (path.split("/").slice(-2, -1)[0] || "").replace(/\.pretty$/i, "") : "";
  const nums = new Set<string>();
  for (const it of doc.items.values()) if (it.kind === "pad") { const t = String(it.node[2]); const n = String(it.node[1] ?? ""); const ls = (KiCadCanvas.kid(it.node, "layers") || []).slice(1).map(String); const aperture = t === "smd" && !ls.some((l) => /\.Cu$/.test(l)); if (n && t !== "np_thru_hole" && !aperture) nums.add(n); }
  return [{ title: f.Reference || "", value: f.Value || "" }, { title: "Library", value: lib }, { title: "Footprint Name", value: String(header[1] ?? "") },
    { title: "Pads", value: String(nums.size) }, { title: `Doc: ${kidText("descr")}`, value: `Keywords: ${kidText("tags")}` }];
}
