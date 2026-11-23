// pcbdialogs/inspect — the Inspect menu's dialogs in KiCad's layout: Design Rules Checker (DIALOG_DRC),
// Board Statistics (DIALOG_BOARD_STATISTICS), Net Inspector and Clearance Resolution.  The checks themselves
// are pcb-tools.js' (drc, netlist, boardStatistics, inspectClearance); this module lays their results out.
import { E } from "../state";
import { DRC_ITEMS, DRC_ITEMS_WITH_SEVERITIES, drcItemTitle } from "../../canvas/drc-items";
import { focusOnLocation } from "./find";
import { appearanceDispatch } from "../panels/appearance";
import { KICAD_BASE_VERSION } from "../../canvas/version";
import { badgeText, drcJsonReport, drcTextReport, elapsedTick, isoNow, listOrder, overflowedTabs, principalLayer, rowText, tabTitles, type DrcReportItem } from "./drc-report";
import { NL } from "./canvas";
import { projectNetlist } from "./update-pcb";
import { runZoneFill } from "./zonefill";
import { fabContext, loadFab } from "../fab-outputs";
import { bitmapButton, box, checkField, currentUnits, download, fmtLenU, grid, h, messageBox, notebook, openDialog, textEntryBox, textField, type CellValue } from "./ui";
import { inspectionPickAt, openPopupMenu, type PopupEntry } from "../contextmenu";
import { adoptProjectFile, canWriteProject, saveProjectFile } from "../projectfile";
import { editProject, type Plain, type ProjectEdit } from "../../canvas/project-file";
import { loadBoardHeader, openBoardSetup } from "./board-setup";
import { loadLibraryFootprint } from "../library";
import { kicadActionAvailable, runKicadAction } from "../hotkeys";
import { state as appStore } from "../appstore";
import { lastFallback, serverDrc, toMarker, uuidIndex, reportScale } from "../kicad-check";
import { toast } from "../util";
import { libraryParityMarkers } from "./drc-library";
import { projectDocs } from "../projectfile";

export interface Marker { code: string; severity: string; x: number; y: number; text: string; ids: string[]; kiids?: string[]; descs?: string[]; layer?: string; excluded?: boolean; comment?: string; selected?: boolean; ruleSeverity?: boolean; items?: { x: number; y: number; desc: string; id?: string; uuid?: string }[] }
interface Settings { severities: Record<string, string>; netclasses: Record<string, { clearance?: number }>; clearance: number; edgeClearance: number; minTrackWidth: number; minThroughDrill: number; boardSetup?: unknown }
interface NetRow { name: string; code: number; padCount: number; viaCount: number; trackLength: number; zoneCount: number; unconnected: number }
interface Stats { footprints: { total: number; front: number; back: number; smd: number; tht: number; other: number }; pads: { total: number; smd: number; tht: number; npth: number; connect: number };
  vias: { total: number; through: number; blind: number; micro: number }; tracks: { count: number; length: number }; zones: number; drills: number; width: number; height: number; area: number }
interface PcbToolsApi {
  state: { markers: Marker[] };
  drc(doc: KDoc, settings: unknown, opts?: { unconnected?: boolean; outline?: boolean; rules?: string | null; footprintOwn?: boolean; allTrackErrors?: boolean; units?: string }): Marker[];
  /** the custom rules' (.kicad_dru) matched-length checks */
  customRuleMarkers?(doc: KDoc, settings: unknown, rules: string | null, units?: string): Marker[];
  parseDru?(text: string): { errors: string[]; messages: { fatal?: boolean }[] };
  markerPath?(doc: KDoc, m: { code: string; x: number; y: number; layer?: string; kiids?: string[] }): [number, number][] | null;
  drcErrorLimit?(code: string): number;
  itemPosition?(doc: KDoc, id: string): [number, number];
  itemDescription?(doc: KDoc, id: string, units: string): string;
  viaLayers?(node: SNode, copper: string[]): Set<string>;
  designSettings(src: unknown): Settings;
  netInspector(doc: KDoc): NetRow[];
  netItemIds(doc: KDoc, key: string): Set<string>;
  boardStatistics(doc: KDoc): Stats;
  boardLayerName(doc: KDoc, layer: string): string;
  inspectClearance(doc: KDoc, a: string, b: string, settings: unknown): { gap: number | null; required: number; sameNet: boolean; nets: string[] } | null;
  netclassOf(s: Settings, net: string): { clearance?: number };
  footprintDiffLines(boardFp: SNode, libFp: SNode): string[];
  selectionIds(ctx: ToolCtx): Set<string>;
}
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const settings = (): Settings => PT().designSettings(E.proSettings || null);
const board = (): KDoc | null => (E.kdoc && E.kdoc.type === "pcb" ? (E.kdoc as KDoc) : null);

/** A short description of a board item for the lists (what KiCad's GetItemDescription gives). */
export function describeItem(doc: KDoc, id: string): string {
  const it = doc.items.get(id); if (!it) return "";
  const net = KiCadCanvas.netNameOf ? String((KiCadCanvas.netNameOf as (d: KDoc, n: SNode) => string)(doc, it.node) || "") : "";
  const layer = it.layer || String(((KiCadCanvas.kid(it.node, "layer") as SNode | null) || [])[1] || "");
  const on = (what: string): string => `${what}${net ? ` [${net}]` : ""}${layer ? ` on ${layer}` : ""}`;
  switch (it.kind) {
    case "footprint": return `Footprint ${it.ref || it.lib || ""}`;
    case "segment": return on("Track");
    case "arc": return on("Track (arc)");
    case "via": return `Via${net ? ` [${net}]` : ""}`;
    case "zone": return on("Zone");
    default: return on(it.kind.replace(/^gr_/, "Graphic ").replace(/_/g, " "));
  }
}

const UNCONNECTED = new Set(["unconnected_items"]);
const PARITY = new Set(DRC_ITEMS.slice(DRC_ITEMS.findIndex((i) => i[0] === "Schematic Parity") + 1, DRC_ITEMS.findIndex((i) => i[0] === "Signal Integrity")).map((i) => i[1]).filter((c) => c !== "unconnected_items"));

// what the last run found, kept while the board stays open so the dialog reopens on it (KiCad keeps its markers too)
// (g_lastIgnored: the Ignored Tests list as the last run built it, kept across dialog instances)
const last: { doc: KDoc | null; markers: Marker[]; ran: boolean; parityRan: boolean; elapsed: number; selected: Marker | null; ignored: string[] } = { doc: null, markers: [], ran: false, parityRan: false, elapsed: 0, selected: null, ignored: [] };
// dialog_drc_base.cpp: only "Refill all zones" is ticked to begin with
const prefs = { refill: true, parity: false, errors: true, warnings: true, exclusions: false };

/** One DRC run as DIALOG_DRC lists it: the board checks, then schematic parity when asked and the schematic can be read. */
/** Why the last browser DRC made no library parity tests ("" when it made them). */
let libraryParitySkipped = "";
async function collectMarkers(doc: KDoc, parity: boolean, allTrackErrors = false, units = "mm"): Promise<{ markers: Marker[]; parityError: string }> {
  const s = settings();
  // the board's (setup …) decides the solder mask expansion, minimum web width and via tenting the mask checks use
  if (!s.boardSetup) { try { const h = await loadBoardHeader(); if (h && h.setup) s.boardSetup = h.setup; } catch (e) { /* the cached copy, if any */ } }
  let markers = PT().drc(doc, s, { rules: E.druText, footprintOwn: true, allTrackErrors, units }); const pt = PT(); if (pt.customRuleMarkers && E.druText) markers = markers.concat(pt.customRuleMarkers(doc, s, E.druText, units)); let parityError = parity ? "" : "not requested";
  if (parity) {
    const res = await projectNetlist();
    if ("error" in res) parityError = res.error;
    else {
      for (const p of NL().schematicParity(doc, res.netlist)) {
        const sev = s.severities[p.code] || (DRC_ITEMS.find((i) => i[1] === p.code) || ["", "", "warning"])[2];
        if (sev !== "ignore") markers.push({ ...p, severity: sev });
      }
    }
  }
  // DRC_TEST_PROVIDER_LIBRARY_PARITY: the footprints against their libraries
  const sevOf = (code: string): string => s.severities[code] || (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "warning"])[2];
  const lp = await libraryParityMarkers(doc, projectDocs() as unknown as { docId: string; path: string }[], sevOf, (a, b, drc) => (PT().footprintDiffLines as (x: SNode, y: SNode, d?: boolean) => string[])(a, b, drc));
  markers = markers.concat(lp.markers as Marker[]);
  if (lp.skipped) libraryParitySkipped = lp.skipped;
  markers = markers.map((m) => (m.text.startsWith(drcItemTitle(m.code)) || (m as Marker & { message?: boolean }).message || !DRC_ITEMS.some((i) => i[1] === m.code) ? m : { ...m, text: `${drcItemTitle(m.code)}: ${m.text}` }));
  return { markers, parityError };
}

/**
 * The Design Rules Checker's result as data, for callers that have no dialog (a plugin running `kicad-cli pcb drc`):
 * each marker with the tab it belongs to and a description of every item it names.
 */
export async function drcReport(o: { parity?: boolean; text?: string } = {}): Promise<{ markers: (Omit<Marker, "items"> & { group: "violation" | "unconnected" | "parity"; items: { id: string; description: string }[] })[]; parityError: string } | null> {
  // `text` is another board file's contents (a copy or a candidate a plugin wrote): it is checked instead of the open board, under the open project's rules.
  const doc = typeof o.text === "string" && o.text ? (KiCadCanvas.parseDoc as (t: string, k: string) => KDoc)(o.text, "kicad_pcb") : board(); if (!doc) return null;
  const r = await collectMarkers(doc, o.parity !== false);
  return { parityError: r.parityError, markers: r.markers.map((m) => ({ ...m, group: UNCONNECTED.has(m.code) ? "unconnected" as const : PARITY.has(m.code) ? "parity" as const : "violation" as const,
    items: m.ids.map((id) => ({ id, description: describeItem(doc, id) })) })) };
}

// ---------------------------------------------------------------- exclusions and severities (.kicad_pro)
interface ExclusionApi {
  exclusionOf(doc: KDoc, m: Marker, comment?: string): unknown; exclusionKey(ex: unknown): string; readExclusion(e: unknown): unknown;
  projectExclusions(text: string | null): unknown[]; applyExclusions(doc: KDoc, markers: Marker[], entries: unknown[]): Marker[];
  withExclusion(entries: unknown[], ex: unknown): unknown[]; withoutExclusions(entries: unknown[], keys: Set<string>): unknown[];
  resolveStaleExclusions(doc: KDoc, markers: Marker[], entries: unknown[], resolve: (kiid: string) => string | null): { added: (Omit<Marker, "severity" | "text">)[]; entries: unknown[]; changed: boolean };
  violatingRuleName(m: Marker): string | null; inspectDrcAction(code: string): string | null; fixDrcEntry(code: string, mainKind?: string | null): { label: string; action: string } | null; DRC_RUN_TEXT: Record<string, string>;
}
const XA = (): ExclusionApi => (window as unknown as { PcbTools: ExclusionApi }).PcbTools;
/** The exclusions in force: the project's, or this session's when the project file cannot be written. */
let sessionExclusions: unknown[] | null = null;
const exclusions = (): unknown[] => sessionExclusions || XA().projectExclusions(E.proSettings || null);
/** Write project-file edits (board.design_settings …) and make the editor use the new file; false when it could not be saved. */
async function saveProjectEdits(edits: ProjectEdit[]): Promise<boolean> {
  const text = E.proSettings || null; if (!text || !canWriteProject()) return false;
  let res: { text: string; changed: ProjectEdit[] };
  try { res = editProject(text, edits); } catch (e) { return false; }
  if (!res.changed.length) return true;
  adoptProjectFile(res.text);                      // the dialog sees the change at once; the upload follows
  return saveProjectFile(res.text, res.changed);
}
const DS = ["board", "design_settings"];
function storeExclusions(ctx: ToolCtx, entries: unknown[]): void {
  sessionExclusions = entries;
  void saveProjectEdits([{ path: [...DS, "drc_exclusions"], value: entries as Plain }]).then((ok) => { if (ok) sessionExclusions = null; else if (!ctx.viewOnly) ctx.toast("The exclusion is kept for this session: the project file could not be written", 4000); });
}
function storeSeverity(ctx: ToolCtx, code: string, sev: string): void {
  sevOverride[code] = sev;
  void saveProjectEdits([{ path: [...DS, "rule_severities", code], value: sev }]).then((ok) => { if (ok) delete sevOverride[code]; else if (!ctx.viewOnly) ctx.toast("The severity is kept for this session: the project file could not be written", 4000); });
}
const sevOverride: Record<string, string> = {};
const severityOf = (code: string): string => sevOverride[code] || settings().severities[code] || (DRC_ITEMS.find((i) => i[1] === code) || ["", "", "error"])[2];
const errorText = (code: string): string => drcItemTitle(code);

// DIALOG_DRC's gear menu options (persisted like the dialog's settings)
const OPT_KEY = "kc.drc.options";
const opts = ((): { reportAllTrackErrors: boolean; crossprobe: boolean; scrollOnCrossprobe: boolean } => {
  const d = { reportAllTrackErrors: false, crossprobe: true, scrollOnCrossprobe: true };
  try { const j = JSON.parse(localStorage.getItem(OPT_KEY) || "null"); if (j && typeof j === "object") Object.assign(d, j); } catch (e) { /* defaults */ }
  return d;
})();
const saveOpts = (): void => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) { /* not kept */ } };
/** DIALOG_DRC's formatElapsed: "%.2f s", or "%d min %d s" from a minute on. */
export function formatElapsed(ms: number): string { const t = Math.round(ms / 1000); return t >= 60 ? `${Math.floor(t / 60)} min ${t % 60} s` : `${(ms / 1000).toFixed(2)} s`; }

/** The open DRC dialog's handles for Inspect > Previous / Next Marker and Exclude Marker (DRC_TOOL). */
let live: { step(dir: 1 | -1): void; exclude(): void; unhide(): void; selectMarker(m: Marker): void } | null = null;
export function prevMarker(ctx: ToolCtx): void { if (live) live.step(-1); else openDrc(ctx); }
export function nextMarker(ctx: ToolCtx): void { if (live) live.step(1); else openDrc(ctx); }
export function excludeMarker(): void { if (live) live.exclude(); }

export function openDrc(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("The Design Rules Checker needs a board"); return; }
  // a modeless dialog hidden by a double click (OnDRCItemDClick) comes back as it was
  if (live) { live.unhide(); return; }
  if (last.doc !== doc) { last.doc = doc; last.markers = []; last.ran = false; last.parityRan = false; last.selected = null; last.ignored = []; }
  let selected: Marker | null = last.selected && last.markers.includes(last.selected) ? last.selected : null, book: ReturnType<typeof notebook> | null = null;
  let dlg: ReturnType<typeof openDialog> = null, running = false, cancelled = false, abort: AbortController | null = null;
  let saveBtn: HTMLButtonElement | null = null, resultsEl: HTMLElement | null = null, runningEl: HTMLElement | null = null;
  const messages = h("div", { class: "pd-list", "data-k": "drc-messages", style: "min-height:240px;padding:6px;white-space:pre-wrap" });
  const lists: HTMLElement[] = [h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" }), h("div", { class: "pd-list pd-drclist" })];
  const status = h("span", { class: "pd-status", "data-k": "drc-status" });
  const gauge = h("progress", { class: "pd-gauge", max: "100", value: "0", style: "display:none;width:160px" }) as HTMLProgressElement;
  const badge = { errors: h("span", { class: "pd-badge", "data-k": "count-errors" }, ""), warnings: h("span", { class: "pd-badge", "data-k": "count-warnings" }, ""), exclusions: h("span", { class: "pd-badge", "data-k": "count-exclusions" }, "") };
  const tabOf = (m: Marker): number => (UNCONNECTED.has(m.code) ? 1 : PARITY.has(m.code) ? 2 : 0);
  const shown = (m: Marker): boolean => (m.excluded ? prefs.exclusions : m.severity === "error" ? prefs.errors : prefs.warnings);
  // the canvas: excluded markers in LAYER_DRC_EXCLUSION's colour
  const show = (): void => { PT().state.markers = last.markers.filter(shown).map((m) => (m.excluded ? { ...m, severity: "exclusion", src: m } : m)); ctx.requestRender(); };
  showMarkers = show;
  // PrevMarker / NextMarker walk the current page's model only (nothing on the Ignored Tests page)
  const rowsOf = (): { m: Marker; row: HTMLElement }[] => { const out: { m: Marker; row: HTMLElement }[] = []; const t = book ? book.current() : 0; if (t > 2) return out; for (const r of Array.from(lists[t].querySelectorAll<HTMLElement>(".it[data-i]"))) out.push({ m: last.markers[Number(r.dataset.i)], row: r }); return out; };
  const clearSelection = (): void => {
    selected = null; last.selected = null;
    for (const l of lists) for (const r of Array.from(l.querySelectorAll(".sel"))) r.classList.remove("sel");
    let any = false; for (const x of last.markers) if (x.selected) { delete x.selected; any = true; }
    ctx.setHighlight(null); if (any) show(); ctx.requestRender();
  };
  /** An item a marker names: the board item id, its position (GetPosition) and description, for the report and the cross-probe. */
  const itemsOf = (m: Marker): (DrcReportItem & { id?: string })[] => {
    if (m.items && m.items.length) return m.items.map((i) => ({ x: i.x, y: i.y, desc: i.desc, uuid: i.uuid, id: i.id }));
    const P = PT(), u = currentUnits();
    return m.ids.map((id, k) => { const p = P.itemPosition ? P.itemPosition(doc, id) : [m.x, m.y]; return { x: p[0], y: p[1], id, uuid: (m.kiids || [])[k], desc: (m.descs || [])[k] || (P.itemDescription ? P.itemDescription(doc, id, u) : describeItem(doc, id)) }; });
  };
  /** BOARD_ITEM::GetLayerSet of an item a marker names, in board order. */
  const layersOfItem = (id: string): string[] => {
    const it = doc.items.get(id); if (!it) return [];
    const copper = ((doc as KDoc & { copper?: string[] }).copper || ["F.Cu", "B.Cu"]);
    if (it.kind === "via" && PT().viaLayers) return copper.filter((l) => PT().viaLayers!(it.node, copper).has(l));
    const l = it.layer || String(((KiCadCanvas.kid(it.node, "layer") as SNode | null) || [])[1] || ""); return l ? [l] : [];
  };
  // DIALOG_DRC::OnDRCItemSelected: the violation's layers shown and made active, the ratsnest turned on for a missing
  // connection, the item brightened and FocusOnItems: the view pans only when the point is out of sight; the zoom is kept
  const select = (m: Marker, row: HTMLElement, item?: number): void => {
    selected = m; last.selected = m;
    // the marker is drawn in LAYER_DRC_HIGHLIGHTED
    for (const x of last.markers) if (x.selected) delete x.selected;
    m.selected = true; show();
    for (const l of lists) for (const r of Array.from(l.querySelectorAll(".sel"))) r.classList.remove("sel");
    row.classList.add("sel"); row.scrollIntoView({ block: "nearest" });
    if (item !== undefined) { const sub = row.querySelectorAll<HTMLElement>(".sub[data-item]")[item]; if (sub) sub.classList.add("sel"); }
    if (!opts.crossprobe) { ctx.requestRender(); return; }
    const items = itemsOf(m);
    const layer = principalLayer(m, m.ids.map(layersOfItem));
    if (layer) {
      const hidden = (E.hiddenLayers || new Set()) as Set<string>;
      const viol = layer && m.ids.length && !m.layer ? m.ids.map(layersOfItem).reduce((a, b) => a.filter((x) => b.includes(x))) : [layer];
      if (!(viol.length ? viol : [layer]).some((l) => !hidden.has(l))) appearanceDispatch({ t: "layerVisible", key: layer, on: true } as never);
      if (!((E.hiddenLayers || new Set()) as Set<string>).has(layer)) appearanceDispatch({ t: "layerActive", key: layer } as never);
    }
    if (m.code === "unconnected_items") { const st = (PT().state as unknown as { showRatsnest?: boolean }); if (!st.showRatsnest) appearanceDispatch({ t: "objVisible", id: "ratsnest", on: true } as never); }
    const one = item !== undefined ? items[item] : null;
    ctx.setHighlight(one && one.id ? new Set([one.id]) : m.ids.length ? new Set(m.ids) : null);
    const at = one ? [one.x, one.y] : [m.x, m.y];
    if (opts.scrollOnCrossprobe) focusOnLocation(at[0], at[1]);   // "Center on Cross-probe"
    ctx.requestRender();
  };
  const reExclude = (): void => { XA().applyExclusions(doc, last.markers, exclusions()); };
  const limitOf = (code: string): number => (PT().drcErrorLimit ? PT().drcErrorLimit!(code) : (code === "clearance" || code === "unconnected_items" ? 499 : 199));
  const fill = (): void => {
    const counts: [number, number, number] = [0, 0, 0];
    const keep = selected;
    for (const l of lists) l.replaceChildren();
    // DRC_ITEMS_PROVIDER::SetSeverities: errors, then warnings, then exclusions (stable); RC_TREE_MODEL's "Error: " … prefix
    for (const i of listOrder(last.markers)) {
      const m = last.markers[i];
      const t = tabOf(m); if (!shown(m)) continue; counts[t]++;
      const items = itemsOf(m);
      const subs = items.map((it, k) => { const el = h("div", { class: "sub", "data-item": String(k) }, it.desc); el.addEventListener("click", (ev) => { ev.stopPropagation(); select(m, row, k); }); el.addEventListener("dblclick", (ev) => { ev.stopPropagation(); select(m, row, k); hide(); }); return el; });
      const row: HTMLElement = h("div", { class: "it" + (m === keep ? " sel" : ""), "data-code": m.code, "data-i": String(i) }, h("span", { class: "pd-sev " + (m.excluded ? "exclusion" : m.severity) }), h("div", null, h("div", null, rowText(m, severityOf(m.code))),
        ...subs, m.excluded && m.comment ? h("div", { class: "sub", "data-k": "comment" }, m.comment) : null));
      row.addEventListener("click", () => select(m, row));
      // OnDRCItemDClick: the modeless dialog is hidden (Show( false )), the selection kept for the next open
      row.addEventListener("dblclick", () => { select(m, row); hide(); });
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); select(m, row); rowMenu(m, ev.clientX, ev.clientY); });
      lists[t].append(row);
    }
    if (!last.ran) for (const l of lists.slice(0, 3)) l.append(h("div", { class: "pd-empty" }, "DRC has not been run."));
    // ignored tests: m_ignoredList as OnRunDRCClick built it (g_lastIgnored; empty before a run), plus the codes set
    // to Ignore from a violation's menu since (ID_SET_SEVERITY_TO_IGNORE)
    const ignored = last.ignored;
    for (const code of ignored) {
      const row = h("div", { class: "it", "data-code": code }, h("span", { class: "pd-sev ignore" }), h("div", null, " • " + drcItemTitle(code)));
      row.addEventListener("contextmenu", (ev) => { ev.preventDefault(); ignoredMenu(code, ev.clientX, ev.clientY); });
      lists[3].append(row);
    }
    // updateDisplayedCounts: tab titles and the badges, "+" where a code reached its error limit
    const ov = overflowedTabs(last.markers, (code) => (UNCONNECTED.has(code) ? 1 : PARITY.has(code) ? 2 : 0), limitOf, severityOf, prefs);
    if (book) tabTitles({ ran: last.ran, parityRan: last.parityRan, counts, overflow: ov.tabs, ignored: ignored.length }).forEach((t, i) => book!.setLabel(i, t));
    const inBadges = (m: Marker): boolean => last.parityRan || !PARITY.has(m.code);
    const nErr = last.markers.filter((m) => inBadges(m) && !m.excluded && m.severity === "error").length, nWarn = last.markers.filter((m) => inBadges(m) && !m.excluded && m.severity === "warning").length;
    badge.errors.textContent = badgeText("error", nErr, last.ran, ov.errors);
    badge.warnings.textContent = badgeText("warning", nWarn, last.ran, ov.warnings);
    badge.exclusions.textContent = badgeText("exclusion", last.markers.filter((m) => inBadges(m) && m.excluded).length, last.ran);
  };
  const refresh = (): void => { fill(); show(); };

  // ---- the violation's right-click menu (DIALOG_DRC::OnDRCItemRClick)
  const listName = (code: string): string => { const s = severityOf(code); return s === "error" ? "errors" : s === "warning" ? "warnings" : "appropriate"; };
  const exclude = (m: Marker, comment: string): void => {
    m.excluded = true; m.comment = comment;
    storeExclusions(ctx, XA().withExclusion(exclusions(), XA().exclusionOf(doc, m, comment)));
    refresh();
  };
  const unexclude = (m: Marker): void => {
    m.excluded = false; m.comment = "";
    storeExclusions(ctx, XA().withoutExclusions(exclusions(), new Set([XA().exclusionKey(XA().exclusionOf(doc, m))])));
    refresh();
  };
  const setSeverity = (code: string, sev: string): void => {
    storeSeverity(ctx, code, sev);
    if (sev === "ignore") { if (!last.ignored.includes(code)) last.ignored.push(code); last.markers = last.markers.filter((m) => m.code !== code); if (selected && selected.code === code) { selected = null; ctx.setHighlight(null); } }
    else for (const m of last.markers) if (m.code === code) m.severity = sev;
    refresh();
  };
  // DIALOG_DRC::OnDRCItemRClick: ID_ADD_EXCLUSION_ALL / ID_REMOVE_EXCLUSION_ALL for a custom rule's markers
  const excludeAll = (rule: string, on: boolean): void => {
    let list = exclusions(); const drop = new Set<string>();
    for (const o of last.markers) {
      if (XA().violatingRuleName(o) !== rule) continue;
      if (on) { if (!o.excluded) { o.excluded = true; o.comment = ""; list = XA().withExclusion(list, XA().exclusionOf(doc, o, "")); } }
      else if (o.excluded) { o.excluded = false; o.comment = ""; drop.add(XA().exclusionKey(XA().exclusionOf(doc, o))); }
    }
    if (!on) list = XA().withoutExclusions(list, drop);
    storeExclusions(ctx, list); refresh();
  };
  const pcbAction = (id: string): ((c: ToolCtx) => unknown) | null => { const a = ((CollabTools.pcb as ToolModule | undefined)?.actions || {})[id] as { run?: (c: ToolCtx) => unknown } | undefined; return a && a.run ? a.run : null; };
  const selectIds = (ids: string[]): void => { const P = PT() as unknown as { applySelection?(c: ToolCtx, ids: string[]): void }; if (P.applySelection) P.applySelection(ctx, ids.filter((id) => doc.items.has(id))); };
  const rowMenu = (m: Marker, x: number, y: number): void => {
    const ln = listName(m.code), et = errorText(m.code), sev = severityOf(m.code), rule = XA().violatingRuleName(m);
    const entries: PopupEntry[] = m.excluded
      ? [{ label: "Remove exclusion for this violation", tip: `It will be placed back in the ${ln} list`, run: () => unexclude(m) },
         { label: "Edit exclusion comment...", run: () => textEntryBox("Exclusion Comment", "", m.comment || "", true, (t) => exclude(m, t)) }]
      : [{ label: "Exclude this violation", tip: `It will be excluded from the ${ln} list`, run: () => exclude(m, "") },
         { label: "Exclude with comment...", tip: `It will be excluded from the ${ln} list`, run: () => textEntryBox("Exclusion Comment", "", "", true, (t) => exclude(m, t)) }];
    if (rule !== null) entries.push(m.excluded
      ? { label: `Remove all exclusions for violations of rule '${rule}'`, tip: `They will be placed back in the ${ln} list`, run: () => excludeAll(rule, false) }
      : { label: `Exclude all violations of rule '${rule}'...`, tip: `They will be excluded from the ${ln} list`, run: () => excludeAll(rule, true) });
    entries.push({ sep: true });
    // BOARD_INSPECTION_TOOL::InspectDRCErrorMenuText / DRC_TOOL::FixDRCErrorMenuText (offered where the board editor has the command)
    const main = doc.items.get(m.ids[0] || "");
    const insp = XA().inspectDrcAction(m.code), inspRun = insp ? pcbAction(insp) : null;
    const fix = XA().fixDrcEntry(m.code, main ? main.kind : null);
    const fixRun = !fix ? null : fix.action === "edit" ? (main && typeof KDialogs !== "undefined" && KDialogs ? () => KDialogs!.openItem(ctx, main) : null) : pcbAction(fix.action);
    if (insp && inspRun) entries.push({ label: XA().DRC_RUN_TEXT[insp], run: () => { selectIds(m.ids); inspRun(ctx); } });
    if (fix && fixRun) entries.push({ label: fix.label, run: () => { if (fix.action !== "edit") selectIds(m.ids.slice(0, 1)); fixRun(ctx); } });
    if ((insp && inspRun) || (fix && fixRun)) entries.push({ sep: true });
    if (sev === "warning") entries.push({ label: `Change severity to Error for all '${et}' violations`, tip: "Violation severities can also be edited in Board Setup", run: () => setSeverity(m.code, "error") });
    else entries.push({ label: `Change severity to Warning for all '${et}' violations`, tip: "Violation severities can also be edited in Board Setup", run: () => setSeverity(m.code, "warning") });
    entries.push({ label: `Ignore all '${et}' violations`, tip: "Violations will not be checked or reported", run: () => setSeverity(m.code, "ignore") },
      { sep: true }, { label: "Edit violation severities...", tip: "Open the Board Setup dialog", run: () => { void openBoardSetup(ctx, "Violation Severity"); } });
    openPopupMenu(x, y, entries);
  };
  // DIALOG_DRC::OnIgnoredItemRClick: Error / Warning / Ignore radio items
  const ignoredMenu = (code: string, x: number, y: number): void => {
    const cur = severityOf(code);
    openPopupMenu(x, y, ([["error", "Error"], ["warning", "Warning"], ["ignore", "Ignore"]] as [string, string][]).map(([v, label]) => ({ label, check: true, checked: cur === v, run: () => { if (cur !== v) { storeSeverity(ctx, code, v); last.ignored = last.ignored.filter((c) => c !== code); refresh(); } } })));   // m_ignoredList->DeleteItem
  };

  // ---- the run (DIALOG_DRC::OnRunDRCClick): the "Tests Running..." page with the phase messages, Close relabelled
  // Cancel and the other buttons disabled while it runs
  const report = (text: string, link?: { text: string; run(): void }): void => {
    const line = h("div", { style: "margin-bottom:8px" }, text);
    if (link) { const a = h("a", { href: "#", "data-k": "drc-link" }, link.text); a.addEventListener("click", (ev) => { ev.preventDefault(); link.run(); }); line.append("\u00a0\u00a0", a); }
    messages.append(line); messages.scrollTop = messages.scrollHeight;
  };
  const showRunning = (on: boolean): void => { if (resultsEl) resultsEl.style.display = on ? "none" : ""; if (runningEl) runningEl.style.display = on ? "" : "none"; };
  const busyButtons = (): (HTMLButtonElement | null)[] => {
    const foot = dlg ? Array.from(dlg.dialog.querySelectorAll<HTMLButtonElement>("button")) : [];
    return [dlg ? dlg.okButton : null, foot.find((x) => x.textContent === "Delete Marker") || null, foot.find((x) => x.textContent === "Delete All Markers") || null, saveBtn];
  };
  const run = async (): Promise<void> => {
    if (running) return;
    // InitEngine: custom rules that do not compile stop the run before anything is cleared from the list
    const P = PT();
    const compiled = E.druText && P.parseDru ? P.parseDru(E.druText) : null;
    // (a condition that does not compile: compileRules' "Parse error"; a lexer PARSE_ERROR out of Parse)
    if (compiled && (compiled.errors.length || compiled.messages.some((x) => x.fatal))) {
      showRunning(true); messages.replaceChildren();
      for (const b of busyButtons().slice(1)) if (b) b.disabled = true;
      report("DRC incomplete: could not compile custom design rules.", { text: "Show design rules.", run: () => { void openBoardSetup(ctx, "Custom Rules"); } });
      return;
    }
    const t0 = Date.now();
    // RecordDRCExclusions, deleteAllMarkers( true ): the last run's markers go before the tests start
    last.markers = []; show();
    // the Ignored Tests list, rebuilt from the severities (GetItemsWithSeverities: not the internal ones)
    last.ignored = DRC_ITEMS_WITH_SEVERITIES.filter((i) => i[1] && severityOf(i[1]) === "ignore").map((i) => i[1]);
    cancelled = false; running = true; abort = typeof AbortController !== "undefined" ? new AbortController() : null;
    clearSelection();
    showRunning(true); messages.replaceChildren();
    const close = dlg ? dlg.cancelButton : null; if (close) close.textContent = "Cancel";
    for (const b of busyButtons()) if (b) b.disabled = true;
    status.textContent = elapsedTick(0);
    const tick = setInterval(() => { status.textContent = elapsedTick(Date.now() - t0); }, 250);
    gauge.style.display = ""; gauge.value = 5;
    let markers: Marker[] | null = null, how = "";
    try {
      // DRC_TOOL::RunTests: "Refilling all zones..." and ZONE_FILLER_TOOL::FillAllZones into the dialog's reporter
      if (prefs.refill && !ctx.viewOnly && [...doc.items.values()].some((it) => it.kind === "zone")) {
        report("Refilling all zones...");
        await runZoneFill(ctx, { ids: [...doc.items.values()].filter((it) => it.kind === "zone").map((it) => it.id), status: h("span"), label: "Fill Zone(s)", all: true });
      }
      if (!cancelled) {
        gauge.value = 40; report("Running KiCad's design rules checker...");
        await new Promise((r) => setTimeout(r, 0));
        // KiCad's own DRC on the server (kicad-check.ts); the browser's checks when it cannot run
        const docId = appStore.docId as string | null;
        if (docId) {
          // kicad-cli reports in the frame's units (DRC_REPORT's m_reportUnits), its positions taken back to mm
          const rep = await serverDrc(docId, { parity: prefs.parity, refill: prefs.refill, allTrackErrors: opts.reportAllTrackErrors, units: currentUnits(), signal: abort ? abort.signal : undefined });
          if (rep && !cancelled) { const ix = uuidIndex(doc), k = reportScale(rep); markers = [...(rep.violations || []), ...(rep.unconnected_items || []), ...(rep.schematic_parity || [])].map((v) => toMarker(v, ix, k));
            // the error legend: the report carries positions only, so the path comes from the items' copper here
            if (P.markerPath && markers) for (const m of markers) { if ((m as { path?: unknown }).path) continue; const pth = P.markerPath(doc, m); if (pth) (m as { path?: unknown }).path = pth; } }
        }
        if (!markers && !cancelled) { markers = (await collectMarkers(doc, prefs.parity, opts.reportAllTrackErrors, currentUnits())).markers; how = ` (checked in the browser: ${lastFallback || "no saved document"})`; if (how) report(`Checked in the browser: ${lastFallback || "no saved document"}`); if (libraryParitySkipped) { report(`Skipping library parity tests: ${libraryParitySkipped}.`); libraryParitySkipped = ""; } }
      }
    } catch (e) { report(`DRC failed: ${(e as Error).message || e}`); }
    clearInterval(tick); setTimeout(() => { gauge.style.display = "none"; }, 300);
    if (cancelled) {
      report("-------- DRC canceled by user.");
      status.textContent = `Canceled after ${formatElapsed(Date.now() - t0)}`;
    } else {
      if (markers) {
        // a rule's own severity stands (PCB_MARKER::GetSeverity); the session's severity changes apply to the rest
        for (const m of markers) { const sv = sevOverride[m.code]; if (!m.ruleSeverity && (sv === "error" || sv === "warning")) m.severity = sv; }
        markers = markers.filter((m) => sevOverride[m.code] !== "ignore");
        const applied = XA().applyExclusions(doc, markers, exclusions());
        // BOARD::ResolveDRCExclusions( true ): exclusions no violation matched come back as excluded markers while their
        // items exist; the others leave the project
        const ix = uuidIndex(doc), st = XA().resolveStaleExclusions(doc, applied, exclusions(), (u) => ix.get(u) || null);
        for (const m of st.added) applied.push({ ...m, severity: severityOf(m.code), text: drcItemTitle(m.code) });
        if (st.changed) storeExclusions(ctx, st.entries);
        last.markers = applied; last.ran = true; last.parityRan = prefs.parity; last.elapsed = (Date.now() - t0) / 1000;
      }
      report("Done.");
      status.textContent = `Completed in ${formatElapsed(Date.now() - t0)}${how}`;
    }
    gauge.value = 100;
    running = false; abort = null;
    if (close) close.textContent = "Close";
    for (const b of busyButtons()) if (b) b.disabled = false;
    if (!cancelled) { await new Promise((r) => setTimeout(r, 500)); showRunning(false); }
    ctx.setHighlight(null); refresh();
  };
  // ---- Save... (OnSaveReport): DRC.rpt or DRC.json with the shown severities, in the user's units
  const save = (json: boolean): void => {
    const u = currentUnits(), list = (tab: number) => listOrder(last.markers).map((i) => last.markers[i]).filter((m) => tabOf(m) === tab && shown(m));
    const rule = (m: Marker): string => {
      const r = XA().violatingRuleName(m); if (r !== null) return `Rule: ${r}`;
      const imp = /\((netclass '(?:[^'\\]|\\.)*'|board setup constraints)\s/.exec(m.text); return imp ? `Rule: ${imp[1]}` : "Local override";
    };
    const input = { violations: list(0), unconnected: list(1), parity: last.parityRan ? list(2) : [], show: prefs, units: u, date: isoNow(),
      file: String((E.kdoc as KDoc & { fileName?: string }).fileName || "board.kicad_pcb").split("/").pop() || "", kicadVersion: KICAD_BASE_VERSION,
      severityOf, items: (m: Marker) => itemsOf(m), ruleDesc: rule, layerName: (l: string) => PT().boardLayerName(doc, l), ignored: DRC_ITEMS_WITH_SEVERITIES.filter((i) => i[1] && severityOf(i[1]) === "ignore").map((i) => [i[0], i[1]] as [string, string]) };
    const name = json ? "DRC.json" : "DRC.rpt";
    if (json) download(name, drcJsonReport(input), "application/json;charset=utf-8"); else download(name, drcTextReport(input), "text/plain;charset=utf-8");
    report(`Report file '${name}' created`);
  };
  // OnDeleteOneClick: the current item of the current page (nothing on Ignored Tests)
  const delMarker = (): void => {
    if (!selected || !book || book.current() === 3 || tabOf(selected) !== book.current()) return;
    if (selected.excluded) storeExclusions(ctx, XA().withoutExclusions(exclusions(), new Set([XA().exclusionKey(XA().exclusionOf(doc, selected))])));   // RecordDRCExclusions drops it
    last.markers = last.markers.filter((m) => m !== selected); selected = null; ctx.setHighlight(null); refresh();
  };
  // DIALOG_DRC::OnDeleteAllClick: with exclusions on the board, "Delete exclusions too?"
  const deleteAll = (withExclusions: boolean): void => {
    const gone = last.markers.filter((m) => withExclusions || !m.excluded);
    if (withExclusions) { const keys = new Set(gone.filter((m) => m.excluded).map((m) => XA().exclusionKey(XA().exclusionOf(doc, m)))); if (keys.size) storeExclusions(ctx, XA().withoutExclusions(exclusions(), keys)); }
    last.markers = last.markers.filter((m) => !gone.includes(m)); last.ran = false; selected = null; ctx.setHighlight(null); refresh();
  };
  const delAll = (): void => {
    if (!last.markers.some((m) => m.excluded)) { deleteAll(false); return; }
    messageBox("Delete All Markers", "Delete exclusions too?", [{ label: "Cancel" }, { label: "Errors, Warnings and Exclusions", fn: () => deleteAll(true) }, { label: "Errors and Warnings Only", fn: () => deleteAll(false) }], 0);
  };
  // PrevMarker / NextMarker: within the current page (nothing on Ignored Tests)
  const step = (dir: 1 | -1): void => {
    const rows = rowsOf(); if (!rows.length) return;
    let i = rows.findIndex((r) => r.m === selected); i = i < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, i + dir));
    const r = rows[i]; select(r.m, r.row);
  };
  // OnDRCItemDClick / Show( false ): the overlay is hidden, nothing destroyed
  const overlay = (): HTMLElement | null => (dlg ? dlg.dialog.parentElement : null);
  const hide = (): void => { const ov = overlay(); if (ov) ov.style.display = "none"; };
  const unhide = (): void => { const ov = overlay(); if (ov && ov.style.display === "none") ov.style.display = ""; };

  reExclude();
  dlg = openDialog({ title: "Design Rules Checker", width: 760, okLabel: "Run DRC", cancelLabel: "Close", noEnter: true, modeless: true,
    extra: [{ label: "Delete Marker", fn: () => { if (!running) delMarker(); } }, { label: "Delete All Markers", fn: () => { if (!running) delAll(); } }],
    build(body) {
      const refill = checkField(prefs.refill, "Refill all zones before performing DRC", { key: "refill", ro: ctx.viewOnly, onChange: (v) => { prefs.refill = v; } });
      const parity = checkField(prefs.parity, "Test for parity between PCB and schematic", { key: "parity", onChange: (v) => { prefs.parity = v; } });
      // m_dataViewEdit "Edit ignored tests" (OnEditViolationSeverities): Board Setup > Violation Severity
      const editIgnored = h("a", { href: "#", "data-k": "edit-ignored", style: "display:inline-block;margin-top:6px" }, "Edit ignored tests");
      editIgnored.addEventListener("click", (ev) => { ev.preventDefault(); void openBoardSetup(ctx, "Violation Severity"); });
      // OnChangingNotebookPage: every list's selection is cleared
      let built = false;
      book = notebook([{ label: "Violations ", build: (el) => el.append(lists[0]) }, { label: "Unconnected Items ", build: (el) => el.append(lists[1]) }, { label: "Schematic Parity ", build: (el) => el.append(lists[2]) }, { label: "Ignored Tests ", build: (el) => el.append(lists[3], editIgnored) }],
        { onShow: () => { if (built && selected) clearSelection(); } });
      built = true;
      // m_runningResultsBook: the "Tests Running..." page with the messages, or the results
      runningEl = h("div", { "data-k": "drc-running", style: "display:none" }, h("div", { class: "pd-tabs" }, h("button", { class: "pd-tab on", type: "button" }, "Tests Running...")), messages);
      resultsEl = h("div", null, book.el);
      // OnSeverity: "All" ticks Errors and sets Warnings and Exclusions to itself
      const all = checkField(prefs.errors && prefs.warnings && prefs.exclusions, "All", { key: "showAll", onChange: (v) => { prefs.errors = true; prefs.warnings = prefs.exclusions = v; errors.set(true); warnings.set(v); excl.set(v); refresh(); } });
      const sync = (): void => { all.set(prefs.errors && prefs.warnings && prefs.exclusions); refresh(); };
      const errors = checkField(prefs.errors, "Errors", { key: "showErrors", onChange: (v) => { prefs.errors = v; sync(); } });
      const warnings = checkField(prefs.warnings, "Warnings", { key: "showWarnings", onChange: (v) => { prefs.warnings = v; sync(); } });
      const excl = checkField(prefs.exclusions, "Exclusions", { key: "showExclusions", onChange: (v) => { prefs.exclusions = v; sync(); } });
      // OnSaveReport's two wildcards
      const saveB = h("button", { type: "button", "data-k": "drc-save" }, "Save...") as HTMLButtonElement; saveBtn = saveB;
      saveB.addEventListener("click", () => { if (running) return; const r = saveB.getBoundingClientRect(); openPopupMenu(r.left, r.bottom, [
        { label: "Report files (*.rpt)", run: () => save(false) }, { label: "Json files (*.json)", run: () => save(true) }]); });
      // the gear button (m_bMenu): the three persisted options
      const gear = bitmapButton("config", "Options", null, { key: "drc-options" });
      gear.addEventListener("click", () => { const r = gear.getBoundingClientRect(); openPopupMenu(r.left, r.bottom, [
        { label: "Report All Errors for Each Track", tip: "If unchecked, only the first error will be reported for each track", check: true, checked: opts.reportAllTrackErrors, run: () => { opts.reportAllTrackErrors = !opts.reportAllTrackErrors; saveOpts(); } },
        { sep: true },
        { label: "Cross-probe Selected Items", tip: "Highlight corresponding items on canvas when selected in the DRC list", check: true, checked: opts.crossprobe, run: () => { opts.crossprobe = !opts.crossprobe; saveOpts(); } },
        { label: "Center on Cross-probe", tip: "When cross-probing, scroll the canvas so that the item is visible", check: true, checked: opts.scrollOnCrossprobe, run: () => { opts.scrollOnCrossprobe = !opts.scrollOnCrossprobe; saveOpts(); } }]); });
      body.append(h("div", { class: "pd-row" }, refill.el, parity.el, h("span", { style: "flex:1" }), gauge, status, gear), runningEl, resultsEl,
        h("div", { class: "pd-row pd-showrow" }, h("label", null, "Show:"), all.el, errors.el, badge.errors, warnings.el, badge.warnings, excl.el, badge.exclusions, h("span", { style: "flex:1" }), saveB));
      live = {
        step: (dir) => { unhide(); step(dir); },
        // ExcludeMarker: only from the Violations page
        exclude: () => { if (book && book.current() !== 0) return; if (selected && !selected.excluded) exclude(selected, ""); },
        unhide,
        // SelectMarker: a DRC marker shows the Violations page, a parity marker the Schematic Parity page
        selectMarker: (m) => {
          unhide(); const t = tabOf(m); if (book && t !== 1) book.show(t);
          const row = lists[t].querySelector<HTMLElement>(`.it[data-i="${last.markers.indexOf(m)}"]`); if (row) { select(m, row); row.scrollIntoView({ block: "center" }); }
        },
      };
      refresh();
    },
    ok() { if (!running) void run(); return false; },
    // OnCancelClick: during a run only m_cancelled is set (and the server request aborted)
    cancel() {
      if (running) { cancelled = true; if (abort) abort.abort(); return false; }
      live = null; showMarkers = null; ctx.setHighlight(null); let any = false; for (const x of last.markers) if (x.selected) { delete x.selected; any = true; } if (any) show();
      return undefined;
    } });
}

/** The open dialog's canvas refresh (its severity filter), or null. */
let showMarkers: (() => void) | null = null;
/**
 * A board marker picked on the canvas (PCB_SELECTION_TOOL selects the PCB_MARKER): it alone is drawn in
 * LAYER_DRC_HIGHLIGHTED, the message panel shows it and the open dialog selects its row; null deselects.
 */
export function pickBoardMarker(drawn: Marker | null): void {
  const src = drawn ? ((drawn as Marker & { src?: Marker }).src || drawn) : null;
  for (const x of last.markers) if (x.selected) delete x.selected;
  for (const x of PT().state.markers) if (x && x.selected) delete x.selected;
  if (src) { src.selected = true; last.selected = src; if (drawn) drawn.selected = true; }
  if (src && live) live.selectMarker(src); else if (showMarkers && live) showMarkers();
}
(E.hooks as Record<string, unknown>).drcSelectMarker = pickBoardMarker;

/** Inspect > Clear DRC Markers. */
export function clearDrcMarkers(ctx: ToolCtx): void { last.markers = []; last.ran = false; PT().state.markers = []; ctx.requestRender(); }

// ---------------------------------------------------------------- Board Statistics
interface DrillLine { count: number; shape: "Round" | "Slot"; x: number; y: number; plated: boolean; pad: boolean; start: string; stop: string }
interface StatsData {
  footprints: { title: string; front: number; back: number }[]; pads: { title: string; count: number }[]; padTotal: number; padProps: { title: string; count: number }[];
  vias: { title: string; count: number }[]; viaTotal: number; minTrackWidth: number | null; minClearance: number | null; minDrill: number | null;
  drills: DrillLine[]; hasOutline: boolean; width: number; height: number;
}
interface StatAreas { hasOutline: boolean; boardArea: number; frontCopper: number; backCopper: number; frontCourtyard: number; backCourtyard: number }
/** DIALOG_BOARD_STATISTICS' s_savedDialogState */
const statsState = { excludeNoPins: false, subtractHoles: false, subtractHolesFromCopper: false };
/** MessageTextFromValue( …, EDA_DATA_TYPE::AREA ) */
function areaText(mm2: number): string {
  const u = currentUnits();
  if (u === "in") return `${(mm2 / 645.16).toFixed(4)} in²`;
  if (u === "mil") return `${(mm2 / 0.00064516).toFixed(0)} mils²`;
  return `${mm2.toFixed(4)} mm²`;
}

/** DIALOG_BOARD_STATISTICS: the report's default name, the board file's name with "_report" and the extension txt. */
export function statsReportName(doc: KDoc): string {
  const file = String((doc as KDoc & { fileName?: string }).fileName || "").split("/").pop() || "";
  const dot = file.lastIndexOf("."), stem = dot > 0 ? file.slice(0, dot) : file;
  return `${stem}_report.txt`;
}
/** Inspect > Board Statistics (DIALOG_BOARD_STATISTICS over board_statistics_report.cpp). */
export function openBoardStatistics(ctx: ToolCtx): void {
  const doc = board(); if (!doc) { ctx.toast("Board Statistics needs a board"); return; }
  const P = window as unknown as { PcbTools: { boardStats: { boardStatsData(d: KDoc, o: { excludeNoPads: boolean }): StatsData }; courtyards(fp: KItem): Record<string, [number, number][][]> } };
  const excl = checkField(statsState.excludeNoPins, "Exclude footprints with no pads", { key: "excludeNoPads", onChange: () => refresh() });
  const subHoles = checkField(statsState.subtractHoles, "Subtract holes from board area", { key: "subtractHoles", onChange: () => refresh() });
  const subCopper = checkField(statsState.subtractHolesFromCopper, "Subtract holes from copper areas", { key: "subtractHolesFromCopper", onChange: () => refresh() });
  const comp = h("table", { class: "pd-stat", "data-k": "components" }), pads = h("table", { class: "pd-stat", "data-k": "pads" });
  const boardT = h("table", { class: "pd-stat", "data-k": "board" }), viasT = h("table", { class: "pd-stat", "data-k": "vias" });
  const drillHost = h("div");
  let data: StatsData = P.PcbTools.boardStats.boardStatsData(doc, { excludeNoPads: statsState.excludeNoPins });
  let areas: StatAreas | null = null, areaSeq = 0, projectName = "";
  const row = (t: HTMLElement, cells: (string | number)[], cls?: string): void => { t.append(h("tr", cls ? { class: cls } : null, ...cells.map((c, i) => h("td", i ? { class: "n" } : null, String(c))))); };
  const unknownOr = (v: number | null): string => (v === null ? "unknown" : fmtLenU(v));
  const pct = (v: number): string => `${v.toFixed(2)} %`;
  // GetStackupOrDefault().BuildBoardThicknessFromStackup(): the stackup's layers (read with the areas), else the
  // default stackup, whose total is the board's thickness
  const stackupT = (): number => { const a = areas as (StatAreas & { stackupThickness?: number | null }) | null; return a && typeof a.stackupThickness === "number" ? a.stackupThickness : Number(doc.thickness) || 1.6; };
  const boardRows = (): [string, string][] => {
    const A = areas, pending = "…";
    return [
      ["Dimensions:", data.hasOutline ? `${fmtLenU(data.width)} x ${fmtLenU(data.height)}` : "unknown"],
      ["Area:", !data.hasOutline ? "unknown" : A ? areaText(A.boardArea) : pending],
      ["Front copper area:", A ? areaText(A.frontCopper) : pending], ["Back copper area:", A ? areaText(A.backCopper) : pending],
      ["Min track clearance:", unknownOr(data.minClearance)], ["Min track width:", unknownOr(data.minTrackWidth)], ["Min drill diameter:", unknownOr(data.minDrill)],
      ["Board stackup thickness:", fmtLenU(stackupT())],
      ["Front footprint area:", A ? areaText(A.frontCourtyard) : pending], ["Front footprint density:", !data.hasOutline ? "unknown" : A && A.boardArea > 0 ? pct(A.frontCourtyard * 100 / A.boardArea) : pending],
      ["Back footprint area:", A ? areaText(A.backCourtyard) : pending], ["Back footprint density:", !data.hasOutline ? "unknown" : A && A.boardArea > 0 ? pct(A.backCourtyard * 100 / A.boardArea) : pending],
    ];
  };
  const draw = (): void => {
    comp.replaceChildren(h("tr", null, h("th", null, "Components"), h("th", null, "Front Side"), h("th", null, "Back Side"), h("th", null, "Total")));
    let f = 0, b = 0;
    for (const e of data.footprints) { row(comp, [e.title, e.front, e.back, e.front + e.back]); f += e.front; b += e.back; }
    row(comp, ["Total:", f, b, f + b], "total");
    pads.replaceChildren(h("tr", null, h("th", { colspan: "2" }, "Pads")));
    for (const e of data.pads) row(pads, [e.title, e.count]);
    row(pads, ["Total:", data.padTotal], "total");
    for (const e of data.padProps) row(pads, [e.title, e.count]);
    boardT.replaceChildren(h("tr", null, h("th", { colspan: "2" }, "Board")));
    for (const [k, v] of boardRows()) row(boardT, [k, v]);
    viasT.replaceChildren(h("tr", null, h("th", { colspan: "2" }, "Vias")));
    for (const e of data.vias) row(viasT, [e.title, e.count]);
    row(viasT, ["Total:", data.viaTotal], "total");
    const rows: Record<string, CellValue>[] = data.drills.map((d) => ({ count: d.count, shape: d.shape, x: d.x, y: d.y, plated: d.plated ? "PTH" : "NPTH", kind: d.pad ? "Pad" : "Via",
      start: d.start ? PT().boardLayerName(doc, d.start) : "", stop: d.stop ? PT().boardLayerName(doc, d.stop) : "" }));
    drillHost.replaceChildren(grid([{ label: "Count", key: "count" }, { label: "Shape", key: "shape" }, { label: "X Size", key: "x", type: "len" }, { label: "Y Size", key: "y", type: "len" }, { label: "Plated", key: "plated" },
      { label: "Via/Pad", key: "kind" }, { label: "Start Layer", key: "start" }, { label: "Stop Layer", key: "stop" }], rows, { ro: true, height: "320px" }).el);
  };
  /** the Default net class's clearance (m_NetSettings->GetDefaultNetclass()->GetClearance()) */
  const defaultClearance = (): number => { const c = ((E.proSettings || {}) as { net_settings?: { classes?: { name: string; clearance?: number }[] } }).net_settings?.classes?.find((x) => x.name === "Default"); return c && typeof c.clearance === "number" ? c.clearance : 0.2; };
  // the areas come from the plotters' geometry (web/domains/pcb/fab), fetched with the fab bundle
  const loadAreas = async (): Promise<void> => {
    const seq = ++areaSeq; areas = null; draw();
    try {
      const F = await loadFab(); const fctx = await fabContext(); if (!fctx || seq !== areaSeq) return;
      projectName = fctx.projectName || "";
      const a = F.statAreas(fctx, { subtractHolesFromBoard: statsState.subtractHoles, subtractHolesFromCopper: statsState.subtractHolesFromCopper, courtyards: (fp: KItem) => P.PcbTools.courtyards(fp), defaultClearance: defaultClearance() });
      if (seq === areaSeq) { areas = a; draw(); }
    } catch (e) { console.warn("board statistics: areas", e); }
  };
  function refresh(): void {
    Object.assign(statsState, { excludeNoPins: excl.get(), subtractHoles: subHoles.get(), subtractHolesFromCopper: subCopper.get() });
    data = P.PcbTools.boardStats.boardStatsData(doc!, { excludeNoPads: statsState.excludeNoPins });
    void loadAreas();
  }
  /** FormatBoardStatisticsReport */
  const reportText = (): string => {
    const L: string[] = ["PCB statistics report\n=====================", `- Date: ${new Date().toLocaleString()}`, `- Project: ${projectName}`, `- Board name: ${projectName ? projectName + ".kicad_pcb" : ""}`, "", "Board\n-----"];
    const A = areas;
    if (data.hasOutline) L.push(`- Width: ${fmtLenU(data.width)}`, `- Height: ${fmtLenU(data.height)}`, `- Area: ${A ? areaText(A.boardArea) : "unknown"}`);
    else L.push("- Dimensions: unknown", "- Area: unknown");
    L.push(`- Front copper area: ${A ? areaText(A.frontCopper) : "unknown"}`, `- Back copper area: ${A ? areaText(A.backCopper) : "unknown"}`, `- Min track clearance: ${unknownOr(data.minClearance)}`,
      `- Min track width: ${unknownOr(data.minTrackWidth)}`, `- Min drill diameter: ${unknownOr(data.minDrill)}`, `- Board stackup thickness: ${fmtLenU(stackupT())}`, "",
      `- Front footprint area: ${A ? areaText(A.frontCourtyard) : "unknown"}`, `- Back footprint area: ${A ? areaText(A.backCourtyard) : "unknown"}`,
      `- Front component density: ${data.hasOutline && A && A.boardArea > 0 ? pct(A.frontCourtyard * 100 / A.boardArea) : "unknown"}`,
      `- Back component density: ${data.hasOutline && A && A.boardArea > 0 ? pct(A.backCourtyard * 100 / A.boardArea) : "unknown"}`, "Pads\n----");
    for (const e of [...data.pads, ...data.padProps]) L.push(`- ${e.title} ${e.count}`);
    L.push("", "Vias\n----"); for (const e of data.vias) L.push(`- ${e.title} ${e.count}`);
    const table = (rows: string[][]): string[] => {
      const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
      const line = (r: string[]): string => "|" + r.map((v, c) => " " + v.padEnd(w[c]) + " |").join("");
      return [line(rows[0]), "|" + w.map((n) => "-".repeat(n + 2) + "|").join(""), ...rows.slice(1).map(line)];
    };
    let f = 0, b = 0; const cr = [["", "Front Side", "Back Side", "Total"]];
    for (const e of data.footprints) { cr.push([e.title, String(e.front), String(e.back), String(e.front + e.back)]); f += e.front; b += e.back; }
    cr.push(["Total:", String(f), String(b), String(f + b)]);
    L.push("", "Components\n----------\n", ...table(cr), "", "Drill holes\n-----------\n",
      ...table([["Count", "Shape", "X Size", "Y Size", "Plated", "Via/Pad", "Start Layer", "Stop Layer"], ...data.drills.map((d) => [String(d.count), d.shape, fmtLenU(d.x), fmtLenU(d.y), d.plated ? "PTH" : "NPTH", d.pad ? "Pad" : "Via", d.start ? PT().boardLayerName(doc, d.start) : "", d.stop ? PT().boardLayerName(doc, d.stop) : ""])]));
    return L.join("\n") + "\n";
  };
  openDialog({ title: "Board Statistics", width: 760, noOk: true, extra: [{ label: "Generate Report File...", fn: () => download(statsReportName(doc), reportText()) }],
    build(body) {
      const general = h("div", null,
        h("div", { class: "pd-cols2" }, h("div", null, comp, pads), h("div", null, boardT, viasT)),
        h("div", { style: "display:flex;flex-direction:column;gap:4px;margin-top:8px" }, subHoles.el, subCopper.el, excl.el));
      body.append(notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Drill Holes", build: (el) => el.append(drillHost) }]).el);
      void loadAreas();
    } });
}

// ---------------------------------------------------------------- Clearance Resolution / Constraints Resolution
type ReportPage = { title: string; lines: string[]; layers?: { name: string; lines: string[] }[] };
interface InspectTools {
  inspectClearanceReport(doc: KDoc, a: string, b: string, s: Settings, active: string, fmt: (mm: number) => string, units: string): { pages: ReportPage[] } | { error: string } | null;
  inspectConstraints(doc: KDoc, id: string, s: Settings, fmt: (mm: number) => string, units: string): ReportPage[] | null;
  pickInteractively?(ctx: ToolCtx, mode: string, prompt: string, done: (res: unknown, at?: [number, number]) => void): void;
  setCustomRules?(text: string | null): void;
}
const IT = (): InspectTools => PT() as unknown as InspectTools;
/** WX_HTML_REPORT_BOX: one line of the report's HTML (written by inspect-resolve.ts, every item text escaped there). */
function reportLine(ctx: ToolCtx, html: string): HTMLElement {
  if (html.startsWith("<h7>")) { const el = h("div", { class: "ln hd" }); el.innerHTML = html.replace(/^<h7>|<\/h7>$/g, ""); return el; }
  if (html.startsWith("<ul>")) {
    const el = h("div", { class: "ln" });
    for (const li of html.replace(/^<ul>|<\/ul>$/g, "").split("</li>").filter(Boolean)) { const row = h("div", { class: "ln li" }); row.innerHTML = "\u2022 " + li.replace(/^<li>/, ""); el.append(row); }
    return el;
  }
  const el = h("div", { class: "ln" }); if (!html) { el.textContent = "\u00a0"; return el; }
  el.innerHTML = html;
  // the report's links: $CUSTOM_RULES (Board Setup > Custom Rules) and $DRC (the DRC dialog)
  for (const a of Array.from(el.querySelectorAll("a"))) a.addEventListener("click", (ev) => { ev.preventDefault(); const href = a.getAttribute("href"); if (href === "$CUSTOM_RULES") void openBoardSetup(ctx, "Custom Rules"); else if (href === "$DRC") openDrc(ctx); });
  return el;
}
/** DIALOG_BOOK_REPORTER: a notebook of HTML report pages; a page with layers has the "Layer:" choice above its report. */
const reporters: Record<string, { close(): void } | null> = {};
function bookReporter(ctx: ToolCtx, title: string, pages: ReportPage[], key: string): void {
  const old = reporters[title]; if (old) { reporters[title] = null; old.close(); }   // DeleteAllPages: one dialog per frame, refilled
  const fill = (rep: HTMLElement, lines: string[]): void => { rep.replaceChildren(); for (const l of lines) rep.append(reportLine(ctx, l)); };
  reporters[title] = openDialog({ title, width: 640, noOk: true, modeless: true,
    build(body) {
      body.append(notebook(pages.map((pg) => ({ label: pg.title, build: (el: HTMLElement) => {
        const rep = h("div", { class: "pd-report", style: "min-height:260px", "data-k": key });
        if (pg.layers) {
          const choice = h("k-select", { "data-k": "clearanceLayer" }) as HTMLElement & { value: string };
          for (const [i, l] of pg.layers.entries()) choice.append(h("option", { value: String(i) }, l.name));
          choice.value = "0"; choice.addEventListener("change", () => fill(rep, pg.layers![+choice.value || 0].lines));
          el.append(h("div", null, "Layer:"), choice); fill(rep, pg.layers[0].lines);
        } else fill(rep, pg.lines);
        el.append(rep);
      } }))).el);
    } }) as unknown as { close(): void };
}
const inspectFmt = (): ((mm: number) => string) => fmtLenU;
const errorBar = (msg: string): void => toast(msg, 4000, undefined, "error");
/** PCB_ACTIONS::inspectClearance's pick and inspectConstraints' types (BOARD_INSPECTION_TOOL clearanceTypes / constraintTypes). */
const CLEARANCE_KINDS = new Set(["pad", "via", "segment", "arc", "zone", "shape", "footprint", "group"]);
const CONSTRAINT_KINDS = new Set(["pad", "via", "segment", "arc", "zone", "shape", "footprint", "field", "text", "group"]);
/** pickItemForInspection: the picker tool with the prompt beside the cursor; the item the click resolves to, or null on Escape. */
function pickForInspection(ctx: ToolCtx, prompt: string, kinds: Set<string>, done: (id: string) => void): void {
  const T = IT(); if (!T.pickInteractively) return;
  T.pickInteractively(ctx, "item", prompt, (res, at) => {
    if (!res) return;   // cancelled
    const id = at ? inspectionPickAt(at, kinds) : null;
    const it = res as KItem; const pick = id || (it && it.id) || null;
    if (pick) done(pick);
  });
}
/** BOARD_INSPECTION_TOOL::InspectClearance: two selected items, else the picker for the first (the one selected item stands for it) and the second. */
export function openClearance(ctx: ToolCtx): void {
  const doc = board(); if (!doc) return;
  if (IT().setCustomRules) IT().setCustomRules!(E.druText || null);
  const ids = Array.from(PT().selectionIds(ctx));
  const report = (a: string, b: string): void => {
    const r = IT().inspectClearanceReport(doc, a, b, settings(), (E.activeLayer as string) || "F.Cu", inspectFmt(), currentUnits());
    if (!r) return;
    if ("error" in r) { errorBar(r.error); return; }
    bookReporter(ctx, "Clearance Report", r.pages, "clearanceReport");
  };
  if (ids.length === 2) { report(ids[0], ids[1]); return; }
  const second = (first: string): void => {
    // the first item stays brightened while the second is picked
    ctx.setHighlight(new Set([first.split("#")[0]]));
    pickForInspection(ctx, "Select second item for clearance resolution...", CLEARANCE_KINDS, (b) => {
      ctx.setHighlight(null);
      if (b === first) { errorBar("Select two different items for clearance resolution."); return; }
      report(first, b);
    });
  };
  if (ids.length === 1) second(ids[0]);
  else pickForInspection(ctx, "Select first item for clearance resolution...", CLEARANCE_KINDS, second);
}

/** BOARD_INSPECTION_TOOL::InspectConstraints: the one selected item, the picker when nothing is selected. */
export function openConstraints(ctx: ToolCtx): void {
  const doc = board(); if (!doc) return;
  if (IT().setCustomRules) IT().setCustomRules!(E.druText || null);
  const ids = Array.from(PT().selectionIds(ctx));
  const report = (id: string): void => {
    const pages = IT().inspectConstraints(doc, id, settings(), inspectFmt(), currentUnits()); if (!pages) return;
    bookReporter(ctx, "Constraints Report", pages, "constraintsReport");
  };
  if (ids.length === 1) report(ids[0]);
  else if (!ids.length) pickForInspection(ctx, "Select item for constraints resolution...", CONSTRAINT_KINDS, report);
  else errorBar("Select a single item for a constraints resolution report.");
}

// ---------------------------------------------------------------- Footprint Associations / Compare Footprint with Library
/** The one selected footprint, or null after the info-bar error KiCad shows. */
function selectedFootprint(ctx: ToolCtx, error: string): KItem | null {
  const doc = board(); if (!doc) return null;
  const ids = Array.from(PT().selectionIds(ctx)), it = ids.length === 1 ? doc.items.get(ids[0]) : null;
  if (!it || it.kind !== "footprint") { ctx.toast(error); return null; }
  return it;
}
/** The wxGrids here have no column labels (SetColLabelSize( 0 )). */
const hideHead = (g: { el: HTMLElement }): void => { const head = g.el.querySelector("thead"); if (head) (head as HTMLElement).style.display = "none"; };
const splitFpid = (it: KItem): { lib: string; name: string } => { const id = String(it.node[1] ?? ""), c = id.indexOf(":"); return c > 0 ? { lib: id.slice(0, c), name: id.slice(c + 1) } : { lib: "", name: id }; };

/**
 * BOARD_INSPECTION_TOOL::ShowFootprintLinks: DIALOG_FOOTPRINT_ASSOCIATIONS — Library Association (Library: / Footprint:
 * with the library's and the footprint's descriptions) and Schematic Association (the footprint's sheet path, one
 * "Sheet:" row per sheet and "Symbol:" last, with what the schematic names it).
 */
export function openFootprintAssociations(ctx: ToolCtx): void {
  const it = selectedFootprint(ctx, "Select a footprint for a footprint associations report."); if (!it) return;
  const { lib, name } = splitFpid(it);
  const libRows: Record<string, CellValue>[] = [{ k: "Library: ", v: lib, d: "" }, { k: "Footprint: ", v: name, d: "" }];
  const path = String((KiCadCanvas.kid(it.node, "path") as SNode | null || [])[1] ?? "").split("/").filter(Boolean);
  const symRows: Record<string, CellValue>[] = path.map((u, i) => ({ k: i === path.length - 1 ? "Symbol:" : "Sheet: ", v: u, d: "" }));
  const cols = [{ label: "", key: "k", width: "90px" }, { label: "", key: "v" }, { label: "", key: "d" }];
  const holder: { g: ReturnType<typeof grid> | null } = { g: null };
  openDialog({ title: "Footprint Associations", width: 640, noOk: true,
    build(body) {
      const libGrid = holder.g = grid(cols, libRows, { ro: true, height: "auto", key: "libraryAssociation" });
      const symGrid = grid(cols, symRows, { ro: true, height: "auto", key: "schematicAssociation" });
      for (const g of [libGrid, symGrid]) hideHead(g);
      body.append(box("Library Association", libGrid.el), box("Schematic Association", symGrid.el));
    } });
  // the library row's description (the library table) and the library footprint's (descr …)
  void (async () => {
    try { const L = (window as unknown as { KiCadLibrary?: { libraries(k: string): Promise<{ libraries: { name: string; description: string }[] }> } }).KiCadLibrary; if (L) { const t = await L.libraries("footprint"); const row = t.libraries.find((l) => l.name === lib); if (row) libRows[0].d = row.description; } } catch { /* none */ }
    try { const t = await loadLibraryFootprint(String(it.node[1] ?? "")); const n = t ? KiCadCanvas.parse(t) as SNode : null; const d = n ? KiCadCanvas.kid(n, "descr") as SNode | null : null; if (d) libRows[1].d = String(d[1] ?? ""); } catch { /* none */ }
    if (holder.g && holder.g.el.isConnected) { holder.g.refresh(); hideHead(holder.g); }
  })();
}

/**
 * BOARD_INSPECTION_TOOL::DiffFootprint in DIALOG_BOOK_REPORTER "Compare Footprint with Library": the Summary page
 * (the footprint, Library:, Library item:, then FootprintNeedsUpdate's report or "No relevant differences detected.")
 * and the Apply button relabelled Update Footprint from Library....
 */
export function openDiffFootprint(ctx: ToolCtx): void {
  const it = selectedFootprint(ctx, "Select a footprint to diff with its library equivalent."); if (!it) return;
  const { lib, name } = splitFpid(it);
  const rep = h("div", { class: "pd-report", style: "min-height:260px", "data-k": "footprintDiff" });
  const ln = (t: string, cls = "ln"): void => { rep.append(h("div", { class: cls }, t || "\u00a0")); };
  ln("Board vs library diff for:", "ln hd");
  ln("\u2022 " + (it.ref ? `Footprint ${it.ref}` : describeItem(board() as KDoc, it.id)), "ln li"); ln("\u2022 Library: " + lib, "ln li"); ln("\u2022 Library item: " + name, "ln li"); ln("");
  const waiting = h("div", { class: "ln" }, "Loading the library footprint...");
  rep.append(waiting);
  const canUpdate = !ctx.viewOnly && kicadActionAvailable("updateFootprint");
  openDialog({ title: "Compare Footprint with Library", width: 640, noOk: true,
    extra: canUpdate ? [{ label: "Update Footprint from Library...", fn: () => { const P = PT() as unknown as { applySelection?(c: ToolCtx, ids: string[]): void }; if (P.applySelection) P.applySelection(ctx, [it.id]); runKicadAction("updateFootprint"); } }] : undefined,
    build(body) { body.append(notebook([{ label: "Summary", build: (el) => el.append(rep) }]).el); } });
  void loadLibraryFootprint(String(it.node[1] ?? "")).then((t) => {
    waiting.remove();
    const n = t ? KiCadCanvas.parse(t) as SNode : null;
    if (!n) { ln(`The library no longer contains the item ${name}.`); return; }
    const lines = PT().footprintDiffLines(it.node, n);
    if (!lines.length) ln("No relevant differences detected.");
    for (const l of lines) ln(l);
  }).catch(() => { waiting.remove(); ln("The library is not included in the current configuration."); });
}
