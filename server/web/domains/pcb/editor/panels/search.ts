// panels/search.ts — KiCad's Search pane (common/widgets/search_pane.cpp with the handlers in
// pcbnew/widgets/search_handlers.cpp and eeschema/widgets/search_handlers.cpp): one tab per handler with
// the handler's columns, a filter box matching any cell, and rows that select and zoom to their item.
// The schematic tabs cover every sheet of the project (the sheets that are not open come from the
// hierarchy's cache); a row on another sheet opens that sheet first.
import type { PanelAction, SearchOpts, SearchResult, SearchRow, SearchTab, SelectionZoom } from "../../panels-api";
import { openSelectionProperties } from "../pointer";
import { openBoardSetup } from "../pcbdialogs/board-setup";
import { centerOn } from "../comments";
import { openDoc } from "../doc";
import { E } from "../state";
import { fitBox } from "../view";
import { layerDisplayName, netClassOf, netCommand } from "./appearance";
import { KC, currentDocId, isSchDoc, kdoc, pcbTools, tctx } from "./core";
import { schDocs, sheetDoc, sheetInstances, pageOfDoc } from "./hierarchy";
import { applyHighlight, currentInstance, preferInstance } from "../schnets";
import { symbolFlagsForVariant } from "../../canvas/variant-model";
import { drillCells, drillLines, groupLeafIds, groupName, itemFields, libIsPower, permissiveMatcher, refMatchTexts, searchTexts, sortRows, symbolInstanceRef, unitSuffix, areaText, outlineArea, zoneLayersCell } from "./search-model";
import { unescapeString } from "../../dialogs/sch-items-logic";
import { layerUiRank } from "./appearance";

interface PropsHelpers { formatLength(mm: number, unit: string): string; netNameOf(doc: KDoc, n: SNode): string; yes(n: SNode, k: string, d: boolean): boolean; libUnitCount(doc: KDoc, n: SNode): number }
const H = (): PropsHelpers => (window.CollabTools.props as unknown as { helpers: PropsHelpers }).helpers;
const len = (v: number) => H().formatLength(v, String(E.units || "mm"));

type Col = [string, number, "left" | "center" | "right"];
const tab = (id: string, label: string, cols: Col[]): SearchTab => ({ id, label, columns: cols.map((c) => c[0]), props: cols.map((c) => c[1]), align: cols.map((c) => c[2]) });
const L = "left" as const, C = "center" as const, R = "right" as const;
// m_columns of each handler: name, proportion, wxLIST_FORMAT (pcbnew/widgets/search_handlers.cpp)
const PCB_TABS: SearchTab[] = [
  tab("footprints", "Footprints", [["Reference", 2, L], ["Value", 6, L], ["Layer", 2, C], ["X", 3, C], ["Y", 3, C], ["Library Link", 8, L], ["Library Description", 10, L]]),
  tab("zones", "Zones", [["Name", 6, L], ["Net", 6, L], ["Layer", 3, C], ["Priority", 2, C], ["X", 3, C], ["Y", 3, C], ["Area", 3, R]]),
  tab("nets", "Nets", [["Name", 6, L], ["Class", 6, L]]),
  tab("ratsnest", "Ratsnest", [["Name", 6, L], ["Class", 6, L]]),
  tab("text", "Text", [["Type", 2, L], ["Text", 12, L], ["Layer", 3, C], ["X", 3, C], ["Y", 3, C]]),
  tab("groups", "Groups", [["Type", 2, L], ["Name", 6, L], ["X", 3, C], ["Y", 3, C]]),
  tab("drills", "Drills", [["Count", 2, R], ["Shape", 3, L], ["X Size", 3, C], ["Y Size", 3, C], ["Plated", 2, C], ["Via/Pad", 2, C], ["Start Layer", 4, C], ["Stop Layer", 4, C]]),
];
// eeschema/widgets/search_handlers.cpp
const SCH_TABS: SearchTab[] = [
  tab("symbols", "Symbols", [["Reference", 2, L], ["Value", 6, L], ["Footprint", 10, L], ["Page", 1, C], ["X", 3, C], ["Y", 3, C], ["Excl. Sim", 2, C], ["Excl. BOM", 2, C], ["Excl. Board", 2, C],
    ["Excl. Pos Files", 2, C], ["DNP", 2, C], ["Library Link", 8, L], ["Library Description", 10, L]]),
  tab("power", "Power", [["Reference", 2, L], ["Value", 6, L], ["Page", 1, C], ["X", 3, C], ["Y", 3, C]]),
  tab("text", "Text", [["Type", 2, L], ["Text", 12, L], ["Page", 1, C], ["X", 3, C], ["Y", 3, C]]),
  tab("labels", "Labels", [["Type", 2, L], ["Name", 6, L], ["Page", 2, C], ["X", 3, C], ["Y", 3, C]]),
  tab("groups", "Groups", [["Name", 6, L], ["Page", 2, C], ["X", 3, C], ["Y", 3, C]]),
];
export function searchTabs(): SearchTab[] { return isSchDoc() ? SCH_TABS : PCB_TABS; }

/** EDA_SEARCH_MATCH_MODE::PERMISSIVE (search-model.ts permissiveMatcher): a regular expression, a wildcard pattern or a
 *  substring of the query, whichever finds it, case-insensitive. */
export function matcher(query: string): (cells: string[]) => boolean { return permissiveMatcher(query); }
const field = (n: SNode, name: string): string => { const K = KC(); const p = K.kids(n, "property").find((q) => K.str(q[1]) === name); return p ? K.str(p[2]) : ""; };
/** GetShownText( FOR_GUI ): the board's text variables resolved. */
function shownText(doc: KDoc, t: string): string {
  if (!t || t.indexOf("${") < 0) return t;
  const K = KC() as unknown as { expandTextVars(t: string, r: unknown): string; varResolver(v: unknown, o: unknown): unknown; sheetTextVars(d: unknown): unknown };
  try { return K.expandTextVars(t, K.varResolver(K.sheetTextVars(doc), { project: (doc as { projectVars?: unknown }).projectVars || null })); } catch (e) { return t; }
}

const DEFAULT_OPTS: SearchOpts = { hidden: false, metadata: false, sortCol: -1, ascending: true };
function pcbRows(tab: string, doc: KDoc, o: SearchOpts): SearchRow[] {
  const K = KC(), rows: SearchRow[] = [];
  if (tab === "footprints") {
    for (const it of doc.items.values()) { if (it.kind !== "footprint") continue; const [x, y] = K.atOf(it.node);
      const lib = K.str(it.node[1]), descr = K.str((K.kid(it.node, "descr") || [])[1]), tags = K.str((K.kid(it.node, "tags") || [])[1]);
      rows.push({ key: it.id, ids: [it.id], cells: [it.ref || field(it.node, "Reference"), it.value || field(it.node, "Value"), layerDisplayName(doc, it.layer || "F.Cu"), len(x), len(y), lib, descr],
        match: searchTexts(itemFields(it.node as unknown[]), [lib, descr, tags], o) }); }
  } else if (tab === "zones") {
    for (const it of doc.items.values()) { if (it.kind !== "zone") continue; const n = it.node;
      const poly = K.kid(n, "polygon"), pts = poly ? K.ptsOf(poly) : []; const s = K.kid(n, "layer"), m = K.kid(n, "layers");
      const copper = (doc as unknown as { copper?: string[] }).copper || [];
      const layers = zoneLayersCell(s ? [K.str(s[1])] : m ? m.slice(1).map((l) => K.str(l)) : [], copper, layerUiRank, (l) => layerDisplayName(doc, l));
      // GetIsRuleArea() ? GetOutlineArea() : GetFilledArea()
      const rule = !!K.kid(n, "keepout");
      const area = rule ? K.kids(n, "polygon").reduce((a, p) => a + outlineArea(K.ptsOf(p) as [number, number][]), 0)
        : K.kids(n, "filled_polygon").reduce((a, p) => a + outlineArea(K.ptsOf(p) as [number, number][]), 0);
      rows.push({ key: it.id, ids: [it.id], cells: [K.str((K.kid(n, "name") || [])[1]), unescapeString(H().netNameOf(doc, n)), layers, String(K.num((K.kid(n, "priority") || [])[1], 0)), pts[0] ? len(pts[0][0]) : "", pts[0] ? len(pts[0][1]) : "", areaText(area, String(E.units || "mm"))], match: [K.str((K.kid(n, "name") || [])[1])] }); }
  } else if (tab === "nets" || tab === "ratsnest") {
    const P = pcbTools(); if (!P) return rows;
    // board->GetNetInfo(): the netcode 0 entry ("No Net", no class) and every net; names through UnescapeString
    let names = P.boardNets(doc).filter((n) => n.code > 0 && n.name).map((n) => n.name);
    if (tab === "ratsnest") { const rat = (window.CollabTools.pcb as unknown as { ratsnest?(d: KDoc): { net: string }[] }).ratsnest; const open = new Set((rat ? rat(doc) : []).map((l) => l.net)); names = names.filter((n) => open.has(n)); }
    else rows.push({ key: "net:", ids: [], cells: ["No Net", ""] });
    for (const name of names) rows.push({ key: "net:" + name, ids: [], cells: [unescapeString(name), netClassOf(name)] });
  } else if (tab === "text") {
    for (const it of doc.items.values()) {
      if (it.kind !== "gr_text" && it.kind !== "gr_text_box" && it.kind !== "dimension") continue; const n = it.node;
      const t = it.kind === "dimension" ? K.kid(n, "gr_text") : n; const at = it.kind === "dimension" ? (t ? K.atOf(t) : [0, 0, 0]) : K.atOf(n);
      const b = it.bbox; const x = K.kid(it.kind === "dimension" && t ? t : n, "at") ? at[0] : b ? (b[0] + b[2]) / 2 : 0, y = K.kid(it.kind === "dimension" && t ? t : n, "at") ? at[1] : b ? (b[1] + b[3]) / 2 : 0;
      const lyr = K.str((K.kid(n, "layer") || [])[1]), raw = t ? K.str(t[1]) : "";
      rows.push({ key: it.id, ids: [it.id], cells: [it.kind === "gr_text" ? "Text" : it.kind === "gr_text_box" ? "Textbox" : "Dimension", unescapeString(shownText(doc, raw.replace(/\$\{LAYER\}/g, lyr))), layerDisplayName(doc, K.str((K.kid(n, "layer") || [])[1])), len(x), len(y)], match: [raw] });
    }
  } else if (tab === "groups") {
    // generators (tuning patterns) are internal, not user-facing grouping
    const groups = new Map<string, unknown[]>(); for (const it of doc.items.values()) if (it.kind === "group") groups.set(it.id, it.node as unknown[]);
    for (const it of doc.items.values()) {
      if (it.kind !== "group") continue; const b = KC().bboxOf(doc, groupLeafIds(it.node as unknown[], groups));
      rows.push({ key: it.id, ids: [it.id], cells: ["Group", groupName(it.node as unknown[]), b ? len((b[0] + b[2]) / 2) : "", b ? len((b[1] + b[3]) / 2) : ""], match: [groupName(it.node as unknown[])] });
    }
  } else if (tab === "drills") {
    const copper = (doc as unknown as { copper?: string[] }).copper || [];
    // DRILL_SEARCH_HANDLER::SelectItems: the row's pads ("footprintId#padIndex") and vias themselves
    for (const d of drillLines(doc.items.values() as Iterable<{ id: string; kind: string; node: unknown[] }>, copper))
      rows.push({ key: "drill:" + [d.xSize, d.ySize, d.slot, d.plated, d.pad, d.start, d.stop].join("|"), ids: d.pad ? (d.padKeys || d.ids) : d.ids, cells: drillCells(d, len, (l) => layerDisplayName(doc, l)) });
  }
  return rows;
}

// getResultCell: wxS( "X" ) or wxS( " " )
const yn = (b: boolean) => (b ? "X" : " ");
const LABEL_TYPES: Record<string, string> = { label: "Local", global_label: "Global", hierarchical_label: "Hierarchical", netclass_flag: "Directive", directive_label: "Directive" };
/** The symbol's library keywords (ki_keywords of its lib_symbols entry), for "Search Metadata". */
function symbolKeywords(doc: KDoc, lib: string): string {
  const K = KC(), def = doc.lib && doc.lib.get(lib); if (!def) return "";
  const kw = K.kids(def, "property").find((q) => K.str(q[1]) === "ki_keywords"); return kw ? K.str(kw[2]) : "";
}
interface VarApi { expandTextVars(text: string, resolve: (tok: string) => string | null): string; sheetTextVars(doc: unknown): Record<string, string>; varResolver(vars: Record<string, string>, opts?: { project?: unknown }): (tok: string) => string | null }
/** EDA_TEXT::GetShownText( FOR_GUI ) of a sheet's free text: the title-block, sheet and project variables resolved, the
 *  page number being the sheet instance's. */
function shownOnSheet(doc: KDoc, page: string, text: string, own?: (tok: string) => string | null): string {
  if (!text || text.indexOf("${") < 0) return text;
  try {
    const V = KC() as unknown as VarApi; const ctx = Object.assign({}, doc, { pageNumber: page || (doc as unknown as { pageNumber?: string }).pageNumber });
    const sheet = V.varResolver(V.sheetTextVars(ctx), { project: (doc as unknown as { projectVars?: unknown }).projectVars || null });
    return V.expandTextVars(text, (tok) => { const r = own ? own(tok) : null; return r !== null ? r : sheet(tok); });
  } catch (e) { return text; }
}
/**
 * SCH_SEARCH_HANDLER::FindAll: screens.BuildClientSheetPathList(), then one hit per ( item, SCH_SHEET_PATH ), so a
 * sheet file used three times lists each of its items three times, each with its instance's page and (a symbol) its
 * instance's reference; a schematic file outside the hierarchy is not searched.
 */
function schRows(tab: string, o: SearchOpts): SearchRow[] {
  const K = KC(), rows: SearchRow[] = [];
  const variant = String(E.currentVariant || "");
  for (const inst of sheetInstances()) {
    const nd = inst.node; if (!nd.docId) continue;
    const doc = sheetDoc(nd.docId); if (!doc) continue; const page = nd.page;
    let groups: Map<string, unknown[]> | null = null;
    for (const it of doc.items.values()) {
      const n = it.node, at = () => K.atOf(n); const row = (cells: string[], match: string[]) => rows.push({ key: nd.path + ":" + it.id, ids: [it.id], cells, docId: nd.docId || undefined, inst: inst.human, match });
      if (it.kind === "symbol") {
        if (tab !== "symbols" && tab !== "power") continue;
        const libId = K.str((K.kid(n, "lib_id") || [])[1]), libName = K.str((K.kid(n, "lib_name") || [])[1]);
        const def = K.resolveLib(doc, libName || libId) || (libName ? K.resolveLib(doc, libId) : null);
        // SYMBOL_SEARCH_HANDLER / POWER_SEARCH_HANDLER: !IsMissingLibSymbol() && IsPower()
        const power = libIsPower(def as unknown[] | null);
        if ((tab === "power") !== power) continue;
        // SCH_SYMBOL::GetRef( sheetPath, true ): the instance's reference, with the unit letter of a multi-unit symbol
        const ir = symbolInstanceRef(n as unknown[], inst.instPath), units = H().libUnitCount ? H().libUnitCount(doc, n) : 1;
        const ref = units > 1 ? ir.ref + unitSuffix(ir.unit) : ir.ref;
        // SCH_FIELD::GetShownText( sheetPath, FOR_GUI ): SCH_SYMBOL::ResolveTextVar's ${REFERENCE}, ${VALUE}, ${UNIT} and
        // the symbol's other fields by name, then the sheet's and the project's variables
        const own = (tok: string): string | null => {
          const up = tok.toUpperCase();
          if (up === "REFERENCE") return ref; if (up === "UNIT") return units > 1 ? unitSuffix(ir.unit) : "";
          for (const q of K.kids(n, "property")) if (K.str(q[1]).toUpperCase() === up) return K.str(q[2]);
          return null;
        };
        const shown = (name: string): string => shownOnSheet(doc, page, field(n, name), own);
        // SCH_FIELD::Matches: every field that is shown (all with Search Hidden Fields); the Reference field matches
        // the instance's reference (and that with its unit letter) and surfaces the metadata hits
        const fields = itemFields(n as unknown[]), refField = fields.find((f) => f.name === "Reference");
        const refSearched = !!refField && (o.hidden || !refField.hidden);
        const descr = def ? field(def, "Description") || field(n, "Description") : "";
        const match = searchTexts(fields.filter((f) => f.name !== "Reference"), refSearched ? [libId, descr, symbolKeywords(doc, libName || libId)] : [], o);
        if (refSearched) match.push(...refMatchTexts(ir.ref, ir.unit, units));
        if (tab === "symbols") {
          // ResolveExcludedFromSim( sheetPath, variant ) … ResolveDNP( sheetPath, variant )
          const f = symbolFlagsForVariant(n, variant, inst.instPath, doc.version);
          row([ref, shown("Value"), shown("Footprint"), page, len(at()[0]), len(at()[1]), yn(f.excludedFromSim), yn(f.excludedFromBOM), yn(f.excludedFromBoard), yn(f.excludedFromPosFiles), yn(f.dnp), libId, descr], match);
        } else row([ref, shown("Value"), page, len(at()[0]), len(at()[1])], match);
      } else if (tab === "text" && (it.kind === "text" || it.kind === "text_box")) row([it.kind === "text" ? "Text" : "Text Box", shownOnSheet(doc, page, K.str(n[1])), page, len(at()[0]), len(at()[1])], [K.str(n[1])]);   // item->Matches: the text alone
      else if (tab === "labels" && LABEL_TYPES[it.kind]) row([LABEL_TYPES[it.kind], shownOnSheet(doc, page, K.str(n[1])), page, len(at()[0]), len(at()[1])], [K.str(n[1])]);   // SCH_LABEL_BASE::Matches
      else if (tab === "groups" && it.kind === "group") {
        if (!groups) { groups = new Map<string, unknown[]>(); for (const g of doc.items.values()) if (g.kind === "group") groups.set(g.id, g.node as unknown[]); }
        const b = K.bboxOf(doc, groupLeafIds(n as unknown[], groups));
        row([groupName(n as unknown[]), page, b ? len((b[0] + b[2]) / 2) : "", b ? len((b[1] + b[3]) / 2) : ""], [groupName(n as unknown[])]);   // SCH_GROUP::Matches: the name
      }
    }
  }
  return rows;
}

/** SEARCH_PANE_TAB::Search: the handler's hits, every one of them (the list is virtual), then SEARCH_PANE_LISTVIEW::Sort,
 *  which with no sort column (m_sortCol -1) orders by the first column, ascending, with StrNumCmp. */
export function search(tab: string, query: string, opts?: SearchOpts): SearchResult {
  const doc = kdoc(); if (!doc) return { tab, rows: [], total: 0 };
  const o = opts || DEFAULT_OPTS;
  let rows: SearchRow[] = [];
  const sch = isSchDoc();
  try { rows = sch ? schRows(tab, o) : pcbRows(tab, doc, o); } catch (e) { console.warn(e); }
  const m = matcher(query); rows = rows.filter((r) => m(r.match || r.cells));
  // SEARCH_PANE_TAB::Search ends with SEARCH_PANE_LISTVIEW::Sort: PCB_ / SCH_SEARCH_HANDLER::Sort orders every result,
  // by the first column (std::max( 0, aCol )) when no column is chosen, ascending with StrNumCmp
  rows = sortRows(rows, o.sortCol, o.ascending);
  return { tab, rows, total: rows.length };
}

/**
 * SEARCH_HANDLER::SelectItems: select the rows' items, then (APP_SETTINGS_BASE::SEARCH_PANE::selection_zoom) zoom to
 * the selection (zoomFitSelection), centre it (centerSelection) or leave the view alone.
 */
function selectAndShow(ids: string[], zoom: SelectionZoom): void {
  const doc = kdoc(); if (!doc) return;
  type PadSel = { padSel?: string | null; padAlso?: { anchor: string; keys: string[] } | null };
  if (!ids.length) { const P0 = pcbTools(); if (P0) { P0.state.sel.clear(); (P0.state as unknown as PadSel).padSel = null; } (tctx() as unknown as { setSelection(ids: string[]): void }).setSelection([]); return; }
  const ctx = tctx() as unknown as { setSelection(ids: string[]): void };
  const P = pcbTools(); if (P) { P.state.sel.clear(); (P.state as unknown as PadSel).padSel = null; (P.state as unknown as PadSel).padAlso = null; }
  if (window.CollabTools.sch && isSchDoc()) window.CollabTools.sch.select(null);
  // pads picked on their own ("footprintId#padIndex", the pcb module's pad selection), the rest as items
  const pads = isSchDoc() ? [] : ids.filter((id) => id.includes("#")), items = ids.filter((id) => !pads.includes(id));
  ctx.setSelection(items);
  if (pads.length && P) { const st = P.state as unknown as PadSel; st.padSel = pads[0]; st.padAlso = pads.length > 1 ? { anchor: pads[0], keys: pads.slice(1) } : null; }
  const b = KC().bboxOf(doc, items.concat(pads.map((k) => k.slice(0, k.lastIndexOf("#"))))); if (!b) return;
  const w = Math.max(b[2] - b[0], 1), h = Math.max(b[3] - b[1], 1);
  E.viewTouched = true;
  if (zoom === "zoom") fitBox([b[0], b[1], w, h], isSchDoc() ? 0.25 : 0.35); else if (zoom === "pan") centerOn((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
}

export function searchDispatch(a: PanelAction): boolean {
  if (a.t !== "searchSelect" && a.t !== "searchActivate") return false;
  const rows = a.t === "searchSelect" ? a.rows : [a.row];
  const after = a.t === "searchActivate" ? () => { setTimeout(() => openSelectionProperties(), 0); } : () => {};
  if (rows.some((r) => r.key.startsWith("net:"))) {
    // NETS_SEARCH_HANDLER::SelectItems highlights every selected net; ActivateItem opens Board Setup at Net Classes
    if (a.t === "searchActivate") { void openBoardSetup(tctx() as never, "netclasses"); return true; }
    // the "No Net" row (netcode 0) lights nothing
    const names = rows.filter((r) => r.key.startsWith("net:")).map((r) => r.key.slice(4)).filter(Boolean);
    netCommand("highlight", names, names[0] || "");
    return true;
  }
  // SCH_SEARCH_HANDLER::SelectItems: the selection is cleared; the hits are selected only when they are all on one
  // sheet path, which is shown first (changeSheet) when it is not the current one
  const first = rows.find((r) => r.inst !== undefined);
  if (first) {
    if (rows.some((r) => r.inst !== first.inst || r.docId !== first.docId)) { selectAndShow([], a.zoom); return true; }
    const ids = Array.from(new Set(rows.flatMap((r) => r.ids)));
    let cur: { human?: string } | null = null; try { cur = currentInstance(); } catch (e) { cur = null; }
    if (first.docId && first.docId !== currentDocId()) {
      const d = schDocs().find((x) => x.docId === first.docId); if (!d) return true;
      preferInstance(first.inst as string);
      void (openDoc(d) as Promise<void>).then(() => { setTimeout(() => { selectAndShow(ids, a.zoom); after(); }, 50); });
      return true;
    }
    if (!cur || cur.human !== first.inst) { preferInstance(first.inst as string); applyHighlight(); }   // the same file as another instance
    selectAndShow(ids, a.zoom); after();
    return true;
  }
  selectAndShow(Array.from(new Set(rows.flatMap((r) => r.ids))), a.zoom); after();
  return true;
}
