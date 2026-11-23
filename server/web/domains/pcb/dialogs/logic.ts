// dialogs/logic.ts — the DOM-free half of the schematic-editor dialogs: paper formats and the
// (paper …)/(title_block …) writers (common/page_info.cpp, common/title_block.cpp), KiCad's find /
// replace matching (EDA_ITEM::Matches / Replace, SCH_*::Matches), the Symbol Fields Table's data
// model and BOM export (common/dialogs/fields_table_data_model.cpp, common/settings/bom_settings.cpp),
// schematic groups (SCH_IO_KICAD_SEXPR::saveGroup) and the grid overrides (EE_GRID_HELPER).
import { messageText } from "../../../shared/units";
// Everything here runs under node too — server/static/tests/schdialogs.test.js bundles this file.

const isList = Array.isArray;
export const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, d = 0): number => { const x = typeof v === "number" ? v : Number(v); return v === undefined || v === null || v === "" || isNaN(x) ? d : x; };
export function kid(node: SNode, key: string): SNode | null { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return c; } return null; }
export function kids(node: SNode, key: string): SNode[] { const out: SNode[] = []; for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) out.push(c); } return out; }
/** OUTPUTFORMATTER::Quotew: always quoted, with \\, \" and control characters escaped. */
export function quote(s: string): string { return '"' + str(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") + '"'; }
/** FormatDouble2Str for sizes in mm: up to 6 decimals, no trailing zeros. */
export function fmtNum(v: number): string { const s = (+v).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""); return s === "-0" ? "0" : s; }

// ---------------------------------------------------------------- page settings
export interface PaperFormat { type: string; label: string; w: number; h: number }
const IN = 25.4;
/** PAGE_INFO::standardPageSizes in dialog order (landscape width × height, mm). */
export const PAPER_FORMATS: PaperFormat[] = [
  { type: "A5", label: "A5 148 x 210mm", w: 210, h: 148 }, { type: "A4", label: "A4 210 x 297mm", w: 297, h: 210 }, { type: "A3", label: "A3 297 x 420mm", w: 420, h: 297 },
  { type: "A2", label: "A2 420 x 594mm", w: 594, h: 420 }, { type: "A1", label: "A1 594 x 841mm", w: 841, h: 594 }, { type: "A0", label: "A0 841 x 1189mm", w: 1189, h: 841 },
  { type: "A", label: "A 8.5 x 11in", w: 11 * IN, h: 8.5 * IN }, { type: "B", label: "B 11 x 17in", w: 17 * IN, h: 11 * IN }, { type: "C", label: "C 17 x 22in", w: 22 * IN, h: 17 * IN },
  { type: "D", label: "D 22 x 34in", w: 34 * IN, h: 22 * IN }, { type: "E", label: "E 34 x 44in", w: 44 * IN, h: 34 * IN },
  { type: "User", label: "User (Custom)", w: 17 * IN, h: 11 * IN },
  { type: "USLetter", label: "US Letter 8.5 x 11in", w: 11 * IN, h: 8.5 * IN }, { type: "USLegal", label: "US Legal 8.5 x 14in", w: 14 * IN, h: 8.5 * IN }, { type: "USLedger", label: "US Ledger 11 x 17in", w: 17 * IN, h: 11 * IN },
];
export interface PageSettings { paper: string; portrait: boolean; width: number; height: number; title: string; date: string; rev: string; company: string; comments: string[] }
/** PAGE_INFO::Format: (paper "A4"), (paper "A4" portrait), (paper "User" 300 200). */
export function paperSexpr(p: Pick<PageSettings, "paper" | "portrait" | "width" | "height">): string {
  if (p.paper === "User") return `(paper "User" ${fmtNum(p.width)} ${fmtNum(p.height)})`;
  return `(paper ${quote(p.paper)}${p.portrait ? " portrait" : ""})`;
}
/** TITLE_BLOCK::Format: only the non-empty fields; nothing at all for an empty title block. */
export function titleBlockSexpr(p: Pick<PageSettings, "title" | "date" | "rev" | "company" | "comments">): string {
  const parts: string[] = [];
  if (p.title) parts.push(`(title ${quote(p.title)})`);
  if (p.date) parts.push(`(date ${quote(p.date)})`);
  if (p.rev) parts.push(`(rev ${quote(p.rev)})`);
  if (p.company) parts.push(`(company ${quote(p.company)})`);
  (p.comments || []).forEach((c, i) => { if (c && i < 9) parts.push(`(comment ${i + 1} ${quote(c)})`); });
  return parts.length ? `(title_block ${parts.join(" ")})` : "";
}
/** The settings a parsed document carries (kicad-canvas keeps paper / portrait / page / titleBlock on it). */
export function pageSettingsOf(doc: { paper?: string; portrait?: boolean; page: [number, number]; titleBlock?: Record<string, string> }): PageSettings {
  const tb = doc.titleBlock || {}; const comments: string[] = [];
  for (let i = 1; i <= 9; i++) comments.push(str(tb["comment" + i] ?? tb["COMMENT" + i] ?? ""));
  const known = PAPER_FORMATS.some((f) => f.type === doc.paper);
  return { paper: known ? str(doc.paper) : "User", portrait: !!doc.portrait && doc.paper !== "User", width: doc.page[0], height: doc.page[1],
    title: str(tb.title ?? tb.TITLE ?? ""), date: str(tb.date ?? tb.ISSUE_DATE ?? ""), rev: str(tb.rev ?? tb.REVISION ?? ""), company: str(tb.company ?? tb.COMPANY ?? ""), comments };
}
/** The id every document-level (page settings) change travels under; no item ever has it. */
export const DOC_PROPS_ID = "00000000-0000-0000-0000-0000000d0c00";
export interface DocPropsChange { id: string; kind: "MODIFIED"; typeName: "PAGE_SETTINGS"; docProps: { paper?: string; titleBlock?: string; pageNumber?: string } }
export function pageSettingsChange(p: PageSettings): DocPropsChange { return { id: DOC_PROPS_ID, kind: "MODIFIED", typeName: "PAGE_SETTINGS", docProps: { paper: paperSexpr(p), titleBlock: titleBlockSexpr(p) } }; }
/** The root sheet's own page number, (sheet_instances (path "/" (page …))) of the root file (SCH_EDIT_TOOL::EditPageNumber
 *  on the root sheet path); it travels as a document-settings change like the page settings. */
export function rootPageChange(page: string): DocPropsChange { return { id: DOC_PROPS_ID, kind: "MODIFIED", typeName: "PAGE_SETTINGS", docProps: { pageNumber: page } }; }
export function isDocPropsChange(c: unknown): c is DocPropsChange { const o = c as { id?: unknown; docProps?: unknown } | null; return !!o && o.id === DOC_PROPS_ID && typeof o.docProps === "object" && o.docProps !== null; }
/** KiCad's date format for the "<<<" button (DIALOG_PAGES_SETTINGS: FormatISODate). */
export function isoDate(d: Date): string { const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

// ---------------------------------------------------------------- find / replace
export interface FindOpts { query: string; matchCase?: boolean; wholeWord?: boolean; regex?: boolean; pins?: boolean; hiddenFields?: boolean; netNames?: boolean; selectionOnly?: boolean; replaceRefs?: boolean;
  /** EDA_SEARCH_DATA::searchAndReplace: the dialog is Find and Replace */
  searchAndReplace?: boolean;
  /** SCH_ITEM::MatchesNetName: the resolved net names of an item on the sheet searched (a symbol pin or sheet pin by its
   *  number / name); a bus answers its members' nets.  Without it "Search net names" finds nothing. */
  netNamesOf?: (it: KItem, pin?: string) => string[];
  /** SCH_SYMBOL::GetPins( sheet ): the pins of the symbol's unit and body style with their positions on the sheet */
  symbolPins?: (doc: FindDoc, it: KItem) => { number: string; name: string; x: number; y: number }[] }
export interface FindHit { id: string; kind: string; what: string; field?: string; text: string; replaceable: boolean; x: number; y: number;
  /** a sheet pin hit: its index among the sheet's pins */
  sub?: number;
  /** a symbol pin hit: the pin's number (the pin itself is the found item) */
  pin?: string;
  /** the other texts the same item matches by (SCH_PIN::Matches: name or number or net; a label: its text or net) */
  alt?: string[] }
/** wxString::Upper: each character upper-cased in place (a character whose upper case is longer is kept), so offsets hold. */
const upperChars = (s: string): string => Array.from(s).map((c) => { const u = c.toUpperCase(); return u.length === c.length ? u : c; }).join("");
/** EDA_ITEM::Matches / Replace's isWordChar: wxIsalnum( c ) || c == '_'. */
const isWordChar = (c: string): boolean => c === "_" || /^[\p{L}\p{N}]$/u.test(c);
/**
 * EDA_ITEM::Matches (common/eda_item.cpp:328-401): a regular expression; whole word = an occurrence of the search text
 * whose neighbours are not word characters ("VCC" finds "VCC rail" and "+VCC", not "VCC1"); else a plain substring
 * (`*` and `?` are literal: eeschema's Find has no wildcard mode).  Case folds by upper-casing both when not matching case.
 */
export function matcher(o: FindOpts): ((text: string) => boolean) | null {
  const q = str(o.query); if (!q) return null;
  if (o.regex) { try { const re = new RegExp(q, o.matchCase ? "" : "i"); return (t) => re.test(t); } catch (e) { return null; } }
  const needle = o.matchCase ? q : upperChars(q);
  if (o.wholeWord) {
    return (t0) => {
      const t = o.matchCase ? t0 : upperChars(t0);
      let ii = 0;
      while (ii < t.length) {
        const at = t.indexOf(needle, ii); if (at < 0) return false;
        const next = at + needle.length;
        if ((at === 0 || !isWordChar(t[at - 1])) && (next === t.length || !isWordChar(t[next]))) return true;
        ii = at + 1;
      }
      return false;
    };
  }
  return (t) => (o.matchCase ? t : upperChars(t)).includes(needle);
}
/**
 * EDA_ITEM::Replace (common/eda_item.cpp:406-490): every occurrence of the search text is replaced (in whole-word mode
 * only those whose neighbours are not word characters), comparing upper-cased copies when not matching case; a regular
 * expression replaces each of its matches.  null when nothing is replaced.
 */
export function replaceText(text: string, o: FindOpts, replacement: string): string | null {
  const m = matcher(o); if (!m || !m(text)) return null;
  const q = str(o.query);
  if (o.regex) { const out = text.replace(new RegExp(q, o.matchCase ? "g" : "gi"), replacement); return out === text ? null : out; }
  const t = o.matchCase ? text : upperChars(text), needle = o.matchCase ? q : upperChars(q);
  let result = "", replaced = false, ii = 0;
  while (ii < t.length) {
    const at = t.indexOf(needle, ii);
    if (at < 0) { result += text.slice(ii); break; }
    if (at > ii) result += text.slice(ii, at);
    ii = at;
    const next = at + needle.length;
    const ok = !o.wholeWord || ((ii === 0 || !isWordChar(t[ii - 1])) && (next === t.length || !isWordChar(t[next])));
    if (ok) { result += replacement; replaced = true; ii = next; }
    else { result += text[ii]; ii++; }
  }
  return replaced ? result : null;
}
function hidden(p: SNode): boolean {
  const h = kid(p, "hide"); if (h) return str(h[1]) !== "no";
  const e = kid(p, "effects"); if (!e) return false;
  if (e.includes("hide")) return true; const eh = kid(e, "hide"); return !!eh && str(eh[1]) !== "no";
}
function at(node: SNode): [number, number] { const a = kid(node, "at"); return a ? [num(a[1]), num(a[2])] : [0, 0]; }
/** Every (pin …) of a library symbol, across its units. */
export function libPins(lib: SNode | null): { name: string; number: string }[] {
  const out: { name: string; number: string }[] = []; if (!lib) return out;
  const walk = (n: SNode) => { for (const c of n) { if (!isList(c)) continue; if (c[0] === "pin") { const nm = kid(c, "name"), nb = kid(c, "number"); out.push({ name: nm ? str(nm[1]) : "", number: nb ? str(nb[1]) : "" }); } else if (c[0] === "symbol") walk(c); } };
  walk(lib); return out;
}
const LABEL_KINDS = new Set(["label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
type FindDoc = Pick<KDoc, "items" | "lib">;
type LibResolver = (doc: FindDoc, name: string) => SNode | null;
/** The texts of one item that KiCad's find looks at (SCH_SYMBOL / SCH_FIELD / SCH_LABEL / SCH_TEXT / SCH_SHEET ::Matches). */
export function searchableTexts(doc: FindDoc, it: KItem, o: FindOpts, resolveLib?: LibResolver): Omit<FindHit, "id" | "kind">[] {
  const out: Omit<FindHit, "id" | "kind">[] = [], n = it.node, [x, y] = at(n);
  const push = (what: string, text: string, replaceable: boolean, field?: string, px = x, py = y, sub?: number, alt?: string[]) => {
    const e: Omit<FindHit, "id" | "kind"> = sub === undefined ? { what, field, text, replaceable, x: px, y: py } : { what, field, text, replaceable, x: px, y: py, sub };
    if (alt && alt.length) e.alt = alt;
    out.push(e); return e;
  };
  const nets = (pin?: string): string[] => (o.netNames && o.netNamesOf ? o.netNamesOf(it, pin) : []);
  if (it.kind === "symbol" || it.kind === "sheet") {
    for (const p of kids(n, "property")) {
      const name = str(p[1]); if (name.startsWith("ki_")) continue;
      // SCH_FIELD::Matches: a hidden field needs "Include hidden fields"; in replace mode a reference designator is
      // only looked at with "Replace matches in reference designators"
      if (!o.hiddenFields && hidden(p)) continue;
      if (name === "Reference" && it.kind === "symbol" && o.searchAndReplace && !o.replaceRefs) continue;
      const [fx, fy] = at(p);
      push(name, str(p[2]), name === "Reference" ? !!o.replaceRefs : !(it.kind === "sheet" && name === "Sheetfile"), name, fx, fy);
    }
    // SCH_SHEET_PIN::IsReplaceable; a sheet pin is a SCH_LABEL_BASE, so it also matches by its net (SCH_LABEL_BASE::Matches)
    if (it.kind === "sheet") kids(n, "pin").forEach((p, i) => { const [px, py] = at(p); push("Sheet Pin", str(p[1]), true, undefined, px, py, i, nets(str(p[1]))); });
    // SCH_SYMBOL::GetPins( sheet ): each pin is an item of its own, at its own position, matched by its name or number
    // ("Search pin names and numbers") or by its net ("Search net names")
    if (it.kind === "symbol" && (o.pins || o.netNames)) {
      let pins = o.symbolPins ? o.symbolPins(doc, it) : null;
      if (!pins) { const lid = kid(n, "lib_name") || kid(n, "lib_id"); const lib = lid ? (resolveLib ? resolveLib(doc, str(lid[1])) : doc.lib.get(str(lid[1])) || null) : null; pins = libPins(lib).map((p) => ({ number: p.number, name: p.name, x, y })); }
      for (const pin of pins) {
        const texts: string[] = [];
        if (o.pins) texts.push(pin.name && pin.name !== "~" ? pin.name : "", pin.number);
        texts.push(...nets(pin.number));
        const list = texts.filter((t, i) => t !== "" || i === 0);
        if (!list.length) continue;
        const e = push("Pin", list[0], false, undefined, pin.x, pin.y, undefined, list.slice(1)); e.pin = pin.number;
      }
    }
  } else if (LABEL_KINDS.has(it.kind)) {
    // SCH_LABEL_BASE::Matches: its text, or (Search net names) its resolved net
    push("Label", str(n[1]), true, undefined, x, y, undefined, nets());
    // a label's fields (SCH_FIELD::Matches / IsReplaceable): hidden ones need the option, Intersheetrefs is never replaced
    for (const p of kids(n, "property")) { if (!o.hiddenFields && hidden(p)) continue; const [fx, fy] = at(p); push(str(p[1]), str(p[2]), str(p[1]) !== "Intersheetrefs", str(p[1]), fx, fy); }
  } else if (it.kind === "text" || it.kind === "text_box") push("Text", str(n[1]), true);
  return out;
}
/** SCH_FIND_REPLACE_TOOL::nextMatch's order: each searched item (a field, a sheet pin, the item) by its own x, then y, then uuid. */
export const hitOrder = (a: Pick<FindHit, "x" | "y" | "id">, b: Pick<FindHit, "x" | "y" | "id">): number => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** All hits on a sheet in KiCad's search order (left to right, then top to bottom). */
export function findHits(doc: FindDoc, o: FindOpts, selection?: Set<string> | null, resolveLib?: LibResolver): FindHit[] {
  const m = matcher(o); if (!m) return [];
  const hits: FindHit[] = [];
  for (const it of doc.items.values()) {
    if (o.selectionOnly && selection && !selection.has(it.id)) continue;
    for (const t of searchableTexts(doc, it, o, resolveLib)) if (m(t.text) || (t.alt && t.alt.some((a) => m(a)))) hits.push(Object.assign({ id: it.id, kind: it.kind }, t));
  }
  return hits.map((h, i) => ({ h, i })).sort((a, b) => hitOrder(a.h, b.h) || a.i - b.i).map((e) => e.h);
}
/** SCH_FIND_REPLACE_TOOL::UpdateFind: the items to brighten for a sheet's hits, each once, in search order. */
export function findHighlightIds(hits: Pick<FindHit, "id">[]): string[] { const out: string[] = []; for (const x of hits) if (!out.includes(x.id)) out.push(x.id); return out; }
/**
 * DIALOG_SCH_FIND::OnOptions: ticking "Regular Expression" clears "Whole words only" and "Match case"; ticking (or
 * clearing) either of those clears "Regular Expression".  The other options only take their value.
 */
export function findOptionChanged<T extends FindOpts>(o: T, key: keyof FindOpts | "currentSheetOnly", on: boolean): T {
  const out = Object.assign({}, o, { [key]: on }) as T;
  if (key === "regex") { out.wholeWord = false; out.matchCase = false; }
  else if (key === "matchCase" || key === "wholeWord") out.regex = false;
  return out;
}
/** Apply a replacement to a cloned node for one hit; false when the hit is not replaceable or nothing changed. */
export function replaceInNode(node: SNode, hit: Pick<FindHit, "what" | "field" | "replaceable" | "kind" | "sub">, o: FindOpts, replacement: string): boolean {
  if (!hit.replaceable) return false;
  if (hit.sub !== undefined) { const p = kids(node, "pin")[hit.sub]; if (!p) return false; const r = replaceText(str(p[1]), o, replacement); if (r === null) return false; p[1] = r; return true; }
  if (hit.field) { const p = kids(node, "property").find((q) => str(q[1]) === hit.field); if (!p) return false; const r = replaceText(str(p[2]), o, replacement); if (r === null) return false; p[2] = r; return true; }
  const r = replaceText(str(node[1]), o, replacement); if (r === null) return false; node[1] = r; return true;
}

// ---------------------------------------------------------------- symbol fields table / BOM
export interface BomField { name: string; label: string; show: boolean; group_by: boolean }
/** BOM_FILTER_SCOPE (bom_settings.h): the filter matches the Reference, the shown columns, or every column. */
export type BomFilterScope = "reference" | "visible" | "all";
export interface BomPreset { name: string; fields_ordered: BomField[]; sort_field: string; sort_asc: boolean; filter_string: string; filter_scope?: BomFilterScope; group_symbols: boolean; exclude_dnp: boolean; include_excluded_from_bom: boolean; readOnly?: boolean }
export interface BomFmt { name: string; field_delimiter: string; string_delimiter: string; ref_delimiter: string; ref_range_delimiter: string; keep_tabs: boolean; keep_line_breaks: boolean; include_bom?: boolean; readOnly?: boolean }
const F = (name: string, label: string, show: boolean, group_by: boolean): BomField => ({ name, label, show, group_by });
/** BOM_PRESET::BuiltInPresets (common/settings/bom_settings.cpp). */
export const BOM_PRESETS: BomPreset[] = [
  { name: "Default Editing", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: true,
    fields_ordered: [F("Reference", "Reference", true, false), F("${QUANTITY}", "Qty", true, false), F("Value", "Value", true, true), F("${DNP}", "DNP", true, true), F("${EXCLUDE_FROM_BOM}", "Exclude from BOM", true, true), F("${EXCLUDE_FROM_BOARD}", "Exclude from Board", true, true), F("Footprint", "Footprint", true, true), F("Datasheet", "Datasheet", true, false)] },
  { name: "Grouped By Value", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: false,
    fields_ordered: [F("Reference", "Reference", true, false), F("Value", "Value", true, true), F("Datasheet", "Datasheet", true, false), F("Footprint", "Footprint", true, false), F("${QUANTITY}", "Qty", true, false), F("${DNP}", "DNP", true, true)] },
  { name: "Grouped By Value and Footprint", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: false,
    fields_ordered: [F("Reference", "Reference", true, false), F("Value", "Value", true, true), F("Datasheet", "Datasheet", true, false), F("Footprint", "Footprint", true, true), F("${QUANTITY}", "Qty", true, false), F("${DNP}", "DNP", true, true)] },
  { name: "Attributes", readOnly: true, sort_field: "Reference", sort_asc: true, filter_string: "", group_symbols: true, exclude_dnp: false, include_excluded_from_bom: true,
    fields_ordered: [F("Reference", "Reference", true, false), F("Value", "Value", true, true), F("Datasheet", "Datasheet", false, false), F("Footprint", "Footprint", false, true), F("${DNP}", "Do Not Place", true, false), F("${EXCLUDE_FROM_BOM}", "Exclude from BOM", true, false), F("${EXCLUDE_FROM_BOARD}", "Exclude from Board", true, false), F("${EXCLUDE_FROM_SIM}", "Exclude from Simulation", true, false)] },
];
/** BOM_FMT_PRESET::BuiltInPresets. */
export const BOM_FMT_PRESETS: BomFmt[] = [
  { name: "CSV", readOnly: true, field_delimiter: ",", string_delimiter: '"', ref_delimiter: ",", ref_range_delimiter: "", keep_tabs: false, keep_line_breaks: false },
  { name: "TSV", readOnly: true, field_delimiter: "\t", string_delimiter: "", ref_delimiter: ",", ref_range_delimiter: "", keep_tabs: false, keep_line_breaks: false },
  { name: "Semicolons", readOnly: true, field_delimiter: ";", string_delimiter: "'", ref_delimiter: ",", ref_range_delimiter: "", keep_tabs: false, keep_line_breaks: false },
];
export const ATTR_FIELDS: Record<string, { flag: "dnp" | "excludeBom" | "excludeBoard" | "excludeSim" | "excludePos"; text: string }> = {
  "${DNP}": { flag: "dnp", text: "DNP" }, "${EXCLUDE_FROM_BOM}": { flag: "excludeBom", text: "Excluded from BOM" }, "${EXCLUDE_FROM_BOARD}": { flag: "excludeBoard", text: "Excluded from board" },
  "${EXCLUDE_FROM_SIM}": { flag: "excludeSim", text: "Excluded from simulation" }, "${EXCLUDE_FROM_POS_FILES}": { flag: "excludePos", text: "Excluded from position files" },
};
export const QTY = "${QUANTITY}", ITEM_NO = "${ITEM_NUMBER}";
export interface SymRow { id: string; ids: string[]; ref: string; values: Record<string, string>; dnp: boolean; excludeBom: boolean; excludeBoard: boolean; excludeSim: boolean; excludePos: boolean; sheet: string; editable: boolean;
  /** reused-sheet suffixes: the reference's base and SCH_REFERENCE::GetRefSuffix (the package's suffix; empty unannotated) */
  refBase?: string; refSuffix?: string }
const yes = (n: SNode, key: string, def: boolean) => { const k = kid(n, key); return k ? str(k[1]) === "yes" : def; };
/** One row per reference designator on a sheet (the units of a multi-unit symbol share a row); power symbols (#PWR…) are left out. */
export function symbolRows(doc: Pick<KDoc, "items">, sheet = "", editable = true, isPower?: (it: KItem) => boolean): SymRow[] {
  const byRef = new Map<string, SymRow>(), rows: SymRow[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const values: Record<string, string> = {};
    // private fields ((property private "Name" "Value" …)) stay out of the table (SCH_FIELD::IsPrivate)
    for (const p of kids(it.node, "property")) { if (p[1] === "private" && typeof p[2] === "string" && typeof p[3] === "string") continue; const nm = str(p[1]); if (!nm.startsWith("ki_")) values[nm] = str(p[2]); }
    // "Don't add power symbols": SCH_SYMBOL::IsPower of its library symbol when the caller can tell, else the "#" reference
    const ref = values.Reference || ""; if (isPower ? isPower(it) : ref.startsWith("#")) continue;
    const prev = ref && !/\?$/.test(ref) ? byRef.get(ref) : undefined;
    if (prev) { prev.ids.push(it.id); continue; }
    const row: SymRow = { id: it.id, ids: [it.id], ref, values, sheet, editable, dnp: yes(it.node, "dnp", false), excludeBom: !yes(it.node, "in_bom", true), excludeBoard: !yes(it.node, "on_board", true), excludeSim: yes(it.node, "exclude_from_sim", false), excludePos: !yes(it.node, "in_pos_files", true) };
    rows.push(row); if (ref) byRef.set(ref, row);
  }
  return rows;
}
/** Every field name the rows carry, the four mandatory ones first (the dialog's field list). */
export const MANDATORY_FIELD_NAMES = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
/** DIALOG_SYMBOL_FIELDS_TABLE::SetupAllColumnProperties: the mandatory fields, then the user fields as a std::set orders them. */
export function fieldNames(rows: SymRow[]): string[] {
  const user = new Set<string>(); for (const r of rows) for (const k of Object.keys(r.values)) if (!MANDATORY_FIELD_NAMES.includes(k)) user.add(k);
  return [...MANDATORY_FIELD_NAMES, ...[...user].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))];
}
/** The view controls' display name of a field: the generated columns by their names. */
export function fieldDisplayName(name: string): string { return name === QTY ? "Quantity" : name === ITEM_NO ? "Item Number" : name; }
const generatedField = (name: string): boolean => name === QTY || name === ITEM_NO || !!ATTR_FIELDS[name];
/**
 * DIALOG_FIELDS_TABLE::OnRemoveField's refusals: a mandatory field, or a column the table generates; null when the
 * field may be removed (after "Are you sure you want to remove the field '%s'?").
 */
export function removeFieldError(name: string): string | null {
  if (MANDATORY_FIELD_NAMES.includes(name)) return `The first ${MANDATORY_FIELD_NAMES.length} fields are mandatory.`;
  if (generatedField(name)) return `The '${fieldDisplayName(name)}' field cannot be removed.`;
  return null;
}
/** DIALOG_FIELDS_TABLE::OnRenameField before it asks for the name. */
export function renameFieldError(name: string): string | null {
  if (MANDATORY_FIELD_NAMES.includes(name)) return `The first ${MANDATORY_FIELD_NAMES.length} fields are mandatory and names cannot be changed.`;
  if (generatedField(name)) return `The '${fieldDisplayName(name)}' field cannot be renamed.`;
  return null;
}
/** OnRenameField once the name is entered: "" for the same name (nothing to do), a message to show, or null to rename. */
export function renameFieldCheck(existing: string[], oldName: string, newName: string): string | null {
  if (newName === oldName) return "";
  if (!newName) return "Field must have a name.";
  if (existing.includes(newName)) return `Field name ${newName} already exists.`;
  return null;
}
/** OnViewControlsCellChanged( GROUP_BY_COLUMN ): the generated count columns cannot be grouped by. */
export function groupByError(name: string): string | null {
  return name === QTY ? "The Quantity column cannot be grouped by." : name === ITEM_NO ? "The Item Number column cannot be grouped by." : null;
}
/** DIALOG_FIELDS_TABLE::OnColSort vetoes the Item Number column (the sort generates it). */
export const canSortBy = (name: string): boolean => name !== ITEM_NO;
/** A row's fields after a rename: the new name carries the value, the old one is gone. */
export function renameRowField(values: Record<string, string>, oldName: string, newName: string): boolean {
  if (values[oldName] === undefined) return false;
  values[newName] = values[oldName]; delete values[oldName]; return true;
}
export function splitRef(ref: string): [string, number] { const m = /^(.*?)(\d+)$/.exec(ref); return m ? [m[1], +m[2]] : [ref, -1]; }
export function refCmp(a: string, b: string): number { const [pa, na] = splitRef(a), [pb, nb] = splitRef(b); return pa < pb ? -1 : pa > pb ? 1 : na - nb || (a < b ? -1 : a > b ? 1 : 0); }
/**
 * UTIL::FormatRefDesRanges( aBasesAndSuffixes ): each suffix's references made adjacent (in the order the suffixes
 * first appear), then runs of consecutive numbers of one prefix and one suffix as ranges, every reference written
 * composed (base, then suffix): "R1_L-R3_L, R1_R".  A run of two is two references; without a range delimiter, none.
 */
export function formatRefDesRanges(pairs: [string, string][], delim: string, range: string): string {
  const order: string[] = []; for (const [, sfx] of pairs) if (!order.includes(sfx)) order.push(sfx);
  const sorted = pairs.map((p, i) => ({ p, i })).sort((a, b) => order.indexOf(a.p[1]) - order.indexOf(b.p[1]) || a.i - b.i).map((x) => x.p);
  const prefixOf = (r: string): string => r.replace(/[0-9?]+$/, ""), numOf = (r: string): number | null => { const t = r.slice(prefixOf(r).length); return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null; };
  const composed = (i: number): string => sorted[i][0] + sorted[i][1];
  let out = "", i = 0;
  while (i < sorted.length) {
    const [ref, sfx] = sorted[i], prefix = prefixOf(ref), n = numOf(ref); let run = 1;
    while (n !== null && i + run < sorted.length) {
      const [nx, ns] = sorted[i + run];
      if (prefixOf(nx) !== prefix || ns !== sfx || numOf(nx) !== n + run) break;
      run++;
      if (run === 2 && !range) break;
    }
    if (out) out += delim;
    if (run === 1) out += composed(i);
    else if (run === 2 || !range) out += composed(i) + delim + composed(i + 1);
    else out += composed(i) + range + composed(i + run - 1);
    i += run;
  }
  return out;
}
/**
 * The Reference cell of a group with reused-sheet suffixes: the items sorted by base (cmpRowItems: StrNumCmp, then the
 * suffix), the units of one package (same base and suffix: unitMatch) once, then formatted with their suffixes.
 */
export function refRangesWithSuffixes(rows: SymRow[], delim: string, range: string): string {
  const items = rows.map((r): [string, string] => [r.refBase !== undefined ? r.refBase : r.ref, r.refSuffix || ""]);
  items.sort((a, b) => refCmp(a[0], b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const uniq: [string, string][] = [];
  for (const it of items) { const l = uniq[uniq.length - 1]; if (l && !it[0].endsWith("?") && l[0] === it[0] && l[1] === it[1]) continue; uniq.push(it); }
  return formatRefDesRanges(uniq, delim, range);
}
/** SCH_REFERENCE_LIST::Shorthand: "R1, R2", runs of three or more as "R1-R3" unless the range delimiter is empty. */
export function refShorthand(refs: string[], delim: string, range: string): string {
  const s = [...new Set(refs)].sort(refCmp), out: string[] = [];
  for (let i = 0; i < s.length;) {
    const [p, n] = splitRef(s[i]); let j = i;
    while (n >= 0 && j + 1 < s.length) { const [p2, n2] = splitRef(s[j + 1]); if (p2 === p && n2 === n + (j + 1 - i)) j++; else break; }
    if (range && j - i >= 2) out.push(s[i] + range + s[j]); else for (let k = i; k <= j; k++) out.push(s[k]);
    i = j + 1;
  }
  return out.join(delim);
}
export interface BomRow { rows: SymRow[]; cells: Record<string, string> }
function cellOf(r: SymRow, name: string): string { const a = ATTR_FIELDS[name]; return a ? (r[a.flag] ? a.text : "") : str(r.values[name]); }
function natCmp(a: string, b: string): number { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }
/**
 * FIELDS_EDITOR_GRID_DATA_MODEL::RebuildRows: filter, group on the group-by columns, sort, then number.
 * `refDelim` / `refRange` are ", " and "-" on screen and the format preset's on export.
 */
/**
 * FIELDS_TABLE_DATA_MODEL_BASE::MoveColumn after a header drag (DIALOG_FIELDS_TABLE::OnColMove): the column leaves its
 * place and goes in at the other column's (std::rotate), in the preset's field order; false when nothing moved.
 */
export function moveColumn(fields: BomField[], from: string, to: string): boolean {
  const a = fields.findIndex((f) => f.name === from), b = fields.findIndex((f) => f.name === to);
  if (a < 0 || b < 0 || a === b) return false;
  const [f] = fields.splice(a, 1); fields.splice(b, 0, f);
  return true;
}
/**
 * DIALOG_SYMBOL_FIELDS_TABLE::TransferDataToWindow's GoToCell on the selected symbol's row: the Value column when it is
 * shown, else the Reference column, else the first other column shown (the keys of the shown columns, in order).
 */
export function cursorColumn(shown: string[]): string | null {
  if (shown.includes("Value")) return "Value";
  if (shown.includes("Reference")) return "Reference";
  return shown.length ? shown[0] : null;
}
export function bomRows(rows: SymRow[], preset: BomPreset, refDelim = ", ", refRange = "-"): BomRow[] {
  const flt = str(preset.filter_string).trim(); const fm = flt ? matcher({ query: /[*?]/.test(flt) ? (flt.startsWith("*") ? "" : "*") + flt + (flt.endsWith("*") ? "" : "*") : flt }) : null;
  // FIELDS_TABLE_DATA_MODEL::MatchesFilter: the Reference alone, or each (shown) column's text, attributes by their names
  const scope = preset.filter_scope || "reference";
  const cols = scope === "reference" ? [] : preset.fields_ordered.filter((f) => (scope === "all" || f.show) && f.name !== QTY && f.name !== ITEM_NO);
  const matches = (r: SymRow): boolean => (scope === "reference" ? fm!(r.ref) : cols.some((c) => fm!(c.name === "Reference" ? r.ref : cellOf(r, c.name))));
  const kept = rows.filter((r) => (!preset.exclude_dnp || !r.dnp) && (preset.include_excluded_from_bom || !r.excludeBom) && (!fm || matches(r)));
  const groupCols = preset.fields_ordered.filter((f) => f.group_by && f.name !== "Reference" && f.name !== QTY && f.name !== ITEM_NO);
  const groups: SymRow[][] = [];
  if (preset.group_symbols) {
    const map = new Map<string, SymRow[]>();
    for (const r of kept) { const key = JSON.stringify(groupCols.map((c) => cellOf(r, c.name)).concat(groupCols.length ? [] : [r.id])); const g = map.get(key); if (g) g.push(r); else { const ng = [r]; map.set(key, ng); groups.push(ng); } }
  } else for (const r of kept) groups.push([r]);
  const out: BomRow[] = groups.map((g) => {
    g.sort((a, b) => refCmp(a.ref, b.ref)); const cells: Record<string, string> = {};
    for (const f of preset.fields_ordered) {
      if (f.name === "Reference") cells[f.name] = g.some((r) => r.refSuffix) ? refRangesWithSuffixes(g, refDelim, refRange) : refShorthand(g.map((r) => r.ref), refDelim, refRange);
      else if (f.name === QTY) cells[f.name] = String(g.length);
      else if (f.name === ITEM_NO) cells[f.name] = "";
      else { const vals = [...new Set(g.map((r) => cellOf(r, f.name)))]; cells[f.name] = vals.length <= 1 ? vals[0] || "" : vals.filter((v) => v !== "").join(refDelim); }
    }
    return { rows: g, cells };
  });
  const sf = preset.sort_field || "Reference", dir = preset.sort_asc === false ? -1 : 1;
  out.sort((a, b) => dir * (sf === "Reference" ? refCmp(a.rows[0].ref, b.rows[0].ref) : sf === QTY ? a.rows.length - b.rows.length || refCmp(a.rows[0].ref, b.rows[0].ref) : natCmp(str(a.cells[sf]), str(b.cells[sf])) || refCmp(a.rows[0].ref, b.rows[0].ref)));
  out.forEach((r, i) => { if (ITEM_NO in r.cells) r.cells[ITEM_NO] = String(i + 1); });
  return out;
}
/** FIELDS_TABLE_DATA_MODEL_BASE::Export. */
export function bomExport(rows: SymRow[], preset: BomPreset, fmt: BomFmt): string {
  const cols = preset.fields_ordered.filter((f) => f.show); if (!cols.length) return "";
  const sd = fmt.string_delimiter || "";
  const field = (v: string, last: boolean) => {
    let s = str(v); if (!fmt.keep_line_breaks) s = s.replace(/[\r\n]/g, ""); if (!fmt.keep_tabs) s = s.replace(/\t/g, "");
    if (sd) s = s.split(sd).join(sd + sd);
    return sd + s + sd + (last ? "\n" : fmt.field_delimiter);
  };
  let out = fmt.include_bom ? "﻿" : "";
  cols.forEach((c, i) => { out += field(c.label, i === cols.length - 1); });
  for (const r of bomRows(rows, preset, fmt.ref_delimiter, fmt.ref_range_delimiter)) cols.forEach((c, i) => { out += field(r.cells[c.name], i === cols.length - 1); });
  return out;
}
/** A preset that shows every field the rows carry; the ones a stored preset lacks are appended hidden. */
export function withAllFields(preset: BomPreset, names: string[]): BomPreset {
  const fields = preset.fields_ordered.map((f) => Object.assign({}, f));
  for (const n of names) if (!fields.some((f) => f.name === n)) fields.push(F(n, n, false, false));
  for (const [n, label] of [[QTY, "Qty"], [ITEM_NO, "#"]] as const) if (!fields.some((f) => f.name === n)) fields.push(F(n, label, false, false));
  return Object.assign({}, preset, { fields_ordered: fields });
}

// ---------------------------------------------------------------- schematic groups
export function groupMembers(node: SNode): string[] { const m = kid(node, "members"); return m ? m.slice(1).map(str) : []; }
/** (group "name" (uuid …) (members …)) as SCH_IO_KICAD_SEXPR::saveGroup writes it: member ids sorted. */
export function groupSexpr(name: string, uuid: string, members: string[]): string { return `(group ${quote(name)} (uuid ${quote(uuid)}) (members ${[...new Set(members)].sort().map(quote).join(" ")}))`; }
export function groupOf(doc: Pick<KDoc, "items">, id: string): KItem | null { for (const it of doc.items.values()) if (it.kind === "group" && groupMembers(it.node).includes(id)) return it; return null; }
/** SCH_ITEM::IsGroupableType by change type name: never a sheet pin (it goes with its sheet) nor a marker. */
const GROUPABLE_TYPES = new Set(["SCH_SYMBOL", "SCH_PIN", "SCH_SHAPE", "SCH_BITMAP", "SCH_FIELD", "SCH_TEXT", "SCH_TEXTBOX", "SCH_TABLE", "SCH_GROUP", "SCH_LINE", "SCH_JUNCTION", "SCH_NO_CONNECT", "SCH_BUS_WIRE_ENTRY", "SCH_BUS_BUS_ENTRY", "SCH_LABEL", "SCH_GLOBALLABEL", "SCH_HIERLABEL", "SCH_RULE_AREA", "SCH_DIRECTIVE_LABEL", "SCH_SHEET"]);
/**
 * SCH_COMMIT::pushSchEdit CHT_ADD: with a group entered, every added groupable item that is not already in a group
 * joins it (`enteredGroup->AddItem`), so a pasted, repeated, duplicated or newly drawn item lands inside the
 * entered group.  Returns the changes with the entered group's MODIFIED change appended (or merged into one the
 * commit already carries); unchanged when nothing joins.
 */
export function enteredGroupChanges(doc: Pick<KDoc, "items">, changes: KChange[], entered: string | null | undefined): KChange[] {
  const g = entered ? doc.items.get(entered) : null; if (!g || g.kind !== "group") return changes;
  const ownIdx = changes.findIndex((c) => c.id === g.id);
  if (ownIdx >= 0 && changes[ownIdx].kind === "REMOVED") return changes;
  // members named by groups this commit adds or changes: those items already have a parent group
  const claimed = new Set<string>();
  for (const c of changes) { const gm = (c as KChange & { groupMembers?: string[] }).groupMembers; if (gm && c.id !== g.id) for (const m of gm) claimed.add(m); }
  const joins: string[] = [];
  for (const c of changes) {
    if (c.kind !== "ADDED" || c.id === g.id || !GROUPABLE_TYPES.has(String(c.typeName))) continue;
    if (claimed.has(c.id) || groupOf(doc, c.id)) continue;
    joins.push(c.id);
  }
  if (!joins.length) return changes;
  const own = ownIdx >= 0 ? (changes[ownIdx] as KChange & { groupMembers?: string[] }) : null;
  const before = own && own.groupMembers ? own.groupMembers : groupMembers(g.node);
  const name = str(g.node[1]);
  const members = [...new Set([...before, ...joins])];
  const ch = { id: g.id, kind: "MODIFIED", typeName: "SCH_GROUP", sexpr: groupSexpr(name, g.id, members), groupMembers: [...members].sort() } as unknown as KChange;
  const out = changes.slice(); if (ownIdx >= 0) out[ownIdx] = ch; else out.push(ch);
  return out;
}
/** The outermost group an item belongs to, stopping below the group the user has entered. */
export function topGroupOf(doc: Pick<KDoc, "items">, id: string, entered?: string | null): KItem | null {
  let g = groupOf(doc, id), top: KItem | null = null, guard = 0;
  while (g && g.id !== entered && guard++ < 32) { top = g; g = groupOf(doc, g.id); }
  return top;
}
/** ids plus, for every member of a group, the whole (outermost, not entered) group: its id and all its members, nested groups included. */
export function expandGroups(doc: Pick<KDoc, "items">, ids: Iterable<string>, entered?: string | null): Set<string> {
  const out = new Set<string>();
  const addGroup = (g: KItem) => { if (out.has(g.id)) return; out.add(g.id); for (const m of groupMembers(g.node)) { const it = doc.items.get(m); if (!it) continue; if (it.kind === "group") addGroup(it); else out.add(m); } };
  for (const id of ids) { const it = doc.items.get(id); if (!it) continue; const top = it.kind === "group" ? (topGroupOf(doc, id, entered) || it) : topGroupOf(doc, id, entered); if (top) addGroup(top); else out.add(id); }
  return out;
}

// ---------------------------------------------------------------- grids
export interface GridOverrides { enabled: boolean; connected: boolean; connectedMm: number; wires: boolean; wiresMm: number; text: boolean; textMm: number; graphics: boolean; graphicsMm: number; vias: boolean; viasMm: number;
  /** GRID::y of the grid each override names (the override_*_idx grid has its own X and Y); absent = square */
  connectedMmY?: number; wiresMmY?: number; textMmY?: number; graphicsMmY?: number; viasMmY?: number }
const MIL = 0.0254;
/** APP_SETTINGS_BASE's schematic defaults: connected items and wires on 50 mil, text on 10 mil, graphics (off) on 25 mil. */
export const SCH_GRID_OVERRIDES: GridOverrides = { enabled: true, connected: true, connectedMm: 50 * MIL, wires: true, wiresMm: 50 * MIL, text: true, textMm: 10 * MIL, graphics: false, graphicsMm: 25 * MIL, vias: false, viasMm: 100 * MIL,
  connectedMmY: 0, wiresMmY: 0, textMmY: 0, graphicsMmY: 0, viasMmY: 0 };
/** APP_SETTINGS_BASE::DefaultGridSizeList for pcbnew and the footprint editor, in its order (mm). */
export const PCB_DEFAULT_GRIDS: number[] = [1000, 500, 250, 200, 100, 50, 25, 20, 10, 5, 2, 1].map((mil) => +(mil * MIL).toFixed(6)).concat([5, 2.5, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.025, 0.01]);
/** grid.last_size / fast_grid_1's default index into it (0.5 mm). */
export const PCB_DEFAULT_GRID_IDX = 15;
/** The board's override defaults (all off): connected 16 (0.25 mm), text 18 (0.1 mm), wires 19 (0.05 mm), vias 18, graphics 15. */
export const PCB_GRID_OVERRIDES: GridOverrides = { enabled: true, connected: false, connectedMm: 0.25, wires: false, wiresMm: 0.05, text: false, textMm: 0.1, graphics: false, graphicsMm: 0.5, vias: false, viasMm: 0.1,
  connectedMmY: 0, wiresMmY: 0, textMmY: 0, graphicsMmY: 0, viasMmY: 0 };
export type GridClass = "connected" | "wires" | "text" | "graphics" | "vias" | null;
/** EE_GRID_HELPER::GetItemGrid by item kind. */
export function schGridClassOfKind(kind: string): GridClass {
  switch (kind) {
    case "symbol": case "sheet": case "no_connect": case "label": case "global_label": case "hierarchical_label": case "netclass_flag": case "directive_label": case "rule_area": return "connected";
    case "text": return "text";
    case "rectangle": case "circle": case "arc": case "bezier": case "polyline": case "text_box": case "image": case "ellipse": return "graphics";
    case "junction": case "wire": case "bus": case "bus_entry": return "wires";
    default: return null;
  }
}
const SCH_TOOL_KIND: Record<string, string> = { place: "symbol", power: "symbol", wire: "wire", bus: "bus", busentry: "bus_entry", noconnect: "no_connect", junction: "junction", label: "label", classlabel: "netclass_flag", glabel: "global_label", hlabel: "hierarchical_label",
  rulearea: "rule_area", sheet: "sheet", sheetpin: "sheet", text: "text", textbox: "text_box", rect: "rectangle", circle: "circle", arc: "arc", bezier: "bezier", polygon: "polyline", lines: "polyline", image: "image" };
export function schGridClassOfTool(tool: string): GridClass { const k = SCH_TOOL_KIND[tool]; return k ? schGridClassOfKind(k) : null; }
/** The pitch a grid class snaps to: its override when overrides are on and that one is ticked, else the current grid. */
/** gridPitchFor as (X, Y): EE_GRID_HELPER::GetGridSize returns grids[ override_*_idx ] with both of its sizes. */
export function gridPitchForXY(cls: GridClass, o: GridOverrides, current: [number, number]): [number, number] {
  if (!o.enabled || !cls) return current;
  const on = o[cls], mm = o[(cls + "Mm") as "connectedMm"], my = o[(cls + "MmY") as "connectedMmY"];
  return on && mm > 0 ? [mm, my && my > 0 ? my : mm] : current;
}
export function gridPitchFor(cls: GridClass, o: GridOverrides, current: number): number {
  if (!o.enabled || !cls) return current;
  const on = o[cls], mm = o[(cls + "Mm") as "connectedMm"];
  return on && mm > 0 ? mm : current;
}

/**
 * PARAM / PARAM_SCALED::Load with a range: a value outside [lo, hi] is replaced by the default, not clamped; a missing
 * or non-numeric one is the default too.  `int`: PARAM<int> reads the number as an integer (truncated).
 */
export function schParamInRange(v: unknown, dflt: number, lo: number, hi: number, int = false): number {
  if (typeof v !== "number" || !isFinite(v)) return dflt;
  const x = int ? Math.trunc(v) : v;
  return x > hi || x < lo ? dflt : x;
}

/** MIN_PAGE_SIZE_MM and MAX_PAGE_SIZE_EESCHEMA_MM / MAX_PAGE_SIZE_PCBNEW_MM (include/page_info.h). */
export const MIN_PAGE_MM = 25.4;
export const maxPageMm = (sch: boolean): number => (sch ? 120000 : 48000) * 0.0254;
/**
 * UNIT_BINDER::Validate( MIN_PAGE_SIZE_MILS, m_maxPageSizeMils ) for the custom size: the error text for a value
 * out of range ("Height must be at least 25.4 mm." / "Width must be less than 1219.2 mm."), or null.
 */
export function pageSizeError(label: string, mm: number, sch: boolean, units: "mm" | "mil" | "in"): string | null {
  // RANGE_BOUND::displayText is StringFromValue: the unit label, trailing zeros trimmed ("1219.2 mm")
  const fmt = (v: number): string => messageText(v, units, sch ? "sch" : "pcb").replace(/(\.\d*?)0+(\s)/, "$1$2").replace(/\.(\s)/, "$1");
  if (!(mm >= MIN_PAGE_MM - 1e-9)) return `${label} must be at least ${fmt(MIN_PAGE_MM)}.`;
  if (mm > maxPageMm(sch) + 1e-9) return `${label} must be less than ${fmt(maxPageMm(sch))}.`;
  return null;
}

/** DIALOG_SCH_FIND's search / replace history (m_findStringHistoryList): the newest string first, a repeated string
 *  moves to the top, empty strings are skipped and at most 10 are kept (MAX_FIND_HISTORY in common/frame). */
export const FIND_HISTORY_MAX = 10;
export function pushFindHistory(list: string[], s: string): string[] {
  if (!s) return list.slice(0, FIND_HISTORY_MAX);
  return [s, ...list.filter((x) => x !== s)].slice(0, FIND_HISTORY_MAX);
}

/** The project-relative path `path` as seen from the directory of `from` (what a sheet's Sheetfile holds). */
export function relativeSheetPath(from: string, path: string): string {
  const a = from.split("/").slice(0, -1), b = path.split("/");
  let i = 0; while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}
/** wxFileName::GetName: the file name without its directory and extension. */
export const sheetBaseName = (path: string): string => (path.split("/").pop() || path).replace(/\.kicad_sch$/i, "");
