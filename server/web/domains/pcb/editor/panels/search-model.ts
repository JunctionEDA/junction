// search-model.ts — the Search pane's Groups and Drills handlers as plain functions over the parsed s-expression
// nodes (no DOM, no globals), so the node tests can run them:
//
//   GROUP_SEARCH_HANDLER (pcbnew/widgets/search_handlers.cpp:387-450, eeschema/widgets/search_handlers.cpp:510-570):
//     every group (a board's generators are skipped), placed at its bounding box's centre (PCB_GROUP / SCH_GROUP
//     ::GetPosition).
//   DRILL_SEARCH_HANDLER (pcbnew/widgets/search_handlers.cpp:626-938): one row per distinct DRILL_LINE_ITEM (size,
//     shape, plated, pad or via, start and stop copper layer) with its count, most numerous first.
type N = unknown[];
const isList = (v: unknown): v is N => Array.isArray(v);
const head = (n: N) => String(n[0]);
const kid = (n: N, k: string): N | null => { for (const c of n) if (isList(c) && head(c) === k) return c; return null; };
const kids = (n: N, k: string): N[] => n.filter((c): c is N => isList(c) && head(c) === k);
const num = (v: unknown, d = 0): number => { const x = Number(v); return isFinite(x) ? x : d; };
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export interface DrillLine { xSize: number; ySize: number; slot: boolean; plated: boolean; pad: boolean; start: string | null; stop: string | null; qty: number; ids: string[];
  /** DRILL_SEARCH_HANDLER::SelectItems selects the pads and vias themselves: the pads as "footprintId#padIndex" */
  padKeys?: string[] }

/** PCB layer order for a copper stack: F.Cu, In1.Cu … InN.Cu, B.Cu. */
function cuRank(l: string): number { return l === "F.Cu" ? 0 : l === "B.Cu" ? 1e6 : num((/^In(\d+)\.Cu$/.exec(l) || [])[1], -1); }
/** LSET::CuStack().front() / back() of a pad's layer list ("*.Cu" and "F&B.Cu" span the board's copper). */
export function padCuSpan(layers: string[], boardCopper: string[]): [string, string] | null {
  const cu = boardCopper.length ? boardCopper : ["F.Cu", "B.Cu"];
  let on: string[];
  if (layers.includes("*.Cu") || layers.includes("F&B.Cu")) on = cu.slice();
  else on = layers.filter((l) => /\.Cu$/.test(l) && cuRank(l) >= 0);
  if (!on.length) return null;
  on.sort((a, b) => cuRank(a) - cuRank(b));
  return [on[0], on[on.length - 1]];
}

/** The board's drills grouped as KiCad's Drills tab lists them. `items` are the board's top-level items. */
export function drillLines(items: Iterable<{ id: string; kind: string; node: N }>, boardCopper: string[]): DrillLine[] {
  const out: DrillLine[] = [];
  const add = (d: Omit<DrillLine, "qty" | "ids">, id: string, padKey?: string) => {
    for (const g of out) if (g.xSize === d.xSize && g.ySize === d.ySize && g.slot === d.slot && g.plated === d.plated && g.pad === d.pad && g.start === d.start && g.stop === d.stop) { g.qty++; if (!g.ids.includes(id)) g.ids.push(id); if (padKey) (g.padKeys || (g.padKeys = [])).push(padKey); return; }
    out.push(Object.assign({ qty: 1, ids: [id] }, d, padKey ? { padKeys: [padKey] } : {}));
  };
  const list = Array.from(items);
  // pads first, then vias, as KiCad collects them
  for (const it of list) {
    if (it.kind !== "footprint") continue;
    kids(it.node, "pad").forEach((p, padIndex) => {
      const dr = kid(p, "drill"); if (!dr) return;
      const oval = dr[1] === "oval";
      const vals = dr.slice(oval ? 2 : 1).filter((v) => !isList(v)).map((v) => num(v, NaN)).filter((v) => isFinite(v));
      const xs = vals[0] || 0, ys = oval ? vals[1] || xs : xs;
      if (xs <= 0 || ys <= 0) return;
      const ls = kid(p, "layers"); const span = padCuSpan(ls ? ls.slice(1).map(str) : [], boardCopper);
      add({ xSize: xs, ySize: ys, slot: oval, plated: str(p[2]) !== "np_thru_hole", pad: true, start: span ? span[0] : null, stop: span ? span[1] : null }, it.id, it.id + "#" + padIndex);
    });
  }
  for (const it of list) {
    if (it.kind !== "via") continue;
    const d = num((kid(it.node, "drill") || [])[1], 0); if (d <= 0) continue;
    const ls = kid(it.node, "layers"); const l = ls ? ls.slice(1).map(str) : ["F.Cu", "B.Cu"];
    const sorted = l.filter((x) => cuRank(x) >= 0).sort((a, b) => cuRank(a) - cuRank(b));
    add({ xSize: d, ySize: d, slot: false, plated: true, pad: false, start: sorted[0] || "F.Cu", stop: sorted[sorted.length - 1] || "B.Cu" }, it.id);
  }
  // DRILL_LINE_ITEM::COMPARE( COL_COUNT, false ): the largest count first
  return out.sort((a, b) => b.qty - a.qty);
}

/** One Drills row's cells (DRILL_SEARCH_HANDLER::cellText): Count, Shape, X Size, Y Size, Plated, Via/Pad, Start / Stop Layer. */
export function drillCells(d: DrillLine, len: (mm: number) => string, layerName: (l: string) => string): string[] {
  return [String(d.qty), d.slot ? "Slot" : "Round", len(d.xSize), len(d.ySize), d.plated ? "PTH" : "NPTH", d.pad ? "Pad" : "Via",
    d.start === null ? "N/A" : layerName(d.start), d.stop === null ? "N/A" : layerName(d.stop)];
}

/** The ids a group holds, its nested groups' members included (for its bounding box). */
export function groupLeafIds(node: N, groupsById: Map<string, N>, seen = new Set<string>()): string[] {
  const m = kid(node, "members"); const out: string[] = [];
  for (const id of m ? m.slice(1).map(str) : []) {
    const g = groupsById.get(id);
    if (g) { if (!seen.has(id)) { seen.add(id); out.push(...groupLeafIds(g, groupsById, seen)); } } else out.push(id);
  }
  return [...new Set(out)];
}
/** A group's name ((group "name" …)). */
export const groupName = (node: N): string => str(node[1]);

// ---------------------------------------------------------------- EDA_SEARCH_DATA: hidden fields and metadata
/** `(hide yes)` / `(hide)` / a bare `hide` token, on the field itself or in its (effects …). */
function hiddenFlag(n: N): boolean {
  const h = kid(n, "hide"); if (h) return h.length < 2 || str(h[1]) !== "no";
  if (n.some((c) => c === "hide")) return true;
  const e = kid(n, "effects"); if (e) { const eh = kid(e, "hide"); if (eh) return eh.length < 2 || str(eh[1]) !== "no"; if (e.some((c) => c === "hide")) return true; }
  return false;
}
export interface FieldText { name: string; value: string; hidden: boolean }
/** A footprint's or symbol's fields: (property "Name" "Value" …), and a legacy footprint's (fp_text reference|value|user …). */
export function itemFields(node: N): FieldText[] {
  const out: FieldText[] = [];
  for (const p of kids(node, "property")) out.push({ name: str(p[1]), value: str(p[2]), hidden: hiddenFlag(p) });
  for (const t of kids(node, "fp_text")) {
    const kind = str(t[1]);
    if (kind === "reference" || kind === "value") { const nm = kind === "reference" ? "Reference" : "Value"; if (!out.some((f) => f.name === nm)) out.push({ name: nm, value: str(t[2]), hidden: hiddenFlag(t) }); }
  }
  return out;
}
/**
 * The texts an item's search matches (FOOTPRINT / SCH_SYMBOL ::Matches and their fields' Matches): the fields that
 * are shown, every field with "Search Hidden Fields", and the library link, description and keywords with "Search
 * Metadata" (searchMetadata).
 */
export function searchTexts(fields: FieldText[], meta: string[], opts: { hidden: boolean; metadata: boolean }): string[] {
  const out = fields.filter((f) => f.value && (opts.hidden || !f.hidden)).map((f) => f.value);
  if (opts.metadata) for (const m of meta) if (m) out.push(m);
  return out;
}
/** StrNumCmp( a, b, CMP_T::IGNORE_CASE ): runs of digits compare by value. */
export function strNumCmp(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g, ta = a.toLowerCase().match(re) || [], tb = b.toLowerCase().match(re) || [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i], y = tb[i];
    if (/^\d/.test(x) && /^\d/.test(y)) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; continue; }
    if (x !== y) return x < y ? -1 : 1;
  }
  return ta.length - tb.length;
}
/** SEARCH_HANDLER::Sort: by one column (the first when none), ascending or descending, stable. */
export function sortRows<R extends { cells: string[] }>(rows: R[], col: number, ascending: boolean): R[] {
  const c = Math.max(0, col);
  return rows.map((r, i) => [r, i] as const).sort((p, q) => { const d = ascending ? strNumCmp(p[0].cells[c] || "", q[0].cells[c] || "") : strNumCmp(q[0].cells[c] || "", p[0].cells[c] || ""); return d || p[1] - q[1]; }).map((p) => p[0]);
}
/** SEARCH_PANE_LISTVIEW::CopySelectionToClipboard: the selected rows, columns tab-separated, one line per row. */
export function rowsAsText(rows: { cells: string[] }[]): string { return rows.map((r) => r.cells.join("\t") + "\n").join(""); }

// ---------------------------------------------------------------- EDA_SEARCH_MATCH_MODE::PERMISSIVE
/**
 * EDA_ITEM::Matches in PERMISSIVE mode (common/eda_item.cpp:326-354): the text and the query are both upper-cased
 * (matchCase is off), then EDA_COMBINED_MATCHER( query, CTX_SEARCH ) (common/eda_pattern_match.cpp:420-424) tries a
 * regular expression, a wildcard pattern and a plain substring; any of them finding the query is a match.
 *   - EDA_PATTERN_MATCH_REGEX::SetPattern: explicit only, "^…$" as written or "/…/" (the closing slash optional);
 *     a pattern that does not compile is dropped
 *   - EDA_PATTERN_MATCH_WILDCARD::SetPattern: `?` any character, `*` any run, the rest literal; NOT anchored
 *   - EDA_PATTERN_MATCH_SUBSTR
 * An empty query matches everything (the handlers test findString.IsEmpty() first).
 */
export function permissiveMatcher(query: string): (texts: string[]) => boolean {
  if (!query) return () => true;
  const q = query.toUpperCase(), res: RegExp[] = [];
  let pat: string | null = null;
  if (q.startsWith("^") && q.endsWith("$")) pat = q;
  else if (q.startsWith("/")) { pat = q.slice(1); if (pat.endsWith("/")) pat = pat.slice(0, -1); }
  if (pat !== null) { try { res.push(new RegExp(pat)); } catch (e) { /* not a regular expression */ } }
  let wild = "";
  for (const c of q) wild += c === "?" ? "." : c === "*" ? ".*" : ".+^${}()|[]/\\".includes(c) ? "\\" + c : c;
  try { res.push(new RegExp(wild)); } catch (e) { /* cannot happen: every special character is escaped */ }
  return (texts) => texts.some((t) => { const u = t.toUpperCase(); return res.some((re) => re.test(u)) || u.includes(q); });
}

// ---------------------------------------------------------------- schematic symbols on a sheet instance
/** LIB_SYMBOL::IsPower of a resolved library symbol: its (power) flag; a missing library symbol is not power
 *  (SYMBOL_SEARCH_HANDLER / POWER_SEARCH_HANDLER: "IsPower depends on non-missing lib symbol association"). */
export function libIsPower(lib: N | null | undefined): boolean { return !!lib && !!kid(lib, "power"); }
/** SCH_SYMBOL::GetRef( sheet ) and GetUnitSelection( sheet ): the (instances (project (path "<instPath>" (reference …)
 *  (unit …)))) entry of the sheet instance, else the symbol's own Reference field and (unit …). */
export function symbolInstanceRef(sym: N, instPath: string): { ref: string; unit: number } {
  let hit: N | null = null;
  for (const proj of kids(kid(sym, "instances") || [], "project")) for (const p of kids(proj, "path")) if (!hit && str(p[1]) === instPath) hit = p;
  const own = kids(sym, "property").find((p) => str(p[1]) === "Reference");
  const r = hit ? kid(hit, "reference") : null, u = hit ? kid(hit, "unit") : null;
  return { ref: r ? str(r[1]) : own ? str(own[2]) : "", unit: num((u || kid(sym, "unit") || [])[1], 1) };
}
/** SCH_SYMBOL::SubReference (LIB_SYMBOL::LetterSubReference( unit, 'A' )): the unit's letter(s), A … Z then AA, AB … */
export function unitSuffix(unit: number): string {
  let u: number, suffix = "", n = Math.max(1, Math.floor(unit));
  do { u = (n - 1) % 26; suffix = String.fromCharCode(65 + u) + suffix; n = Math.floor((n - u) / 26); } while (n > 0);
  return suffix;
}
/** The texts a symbol hit matches through its Reference field (SCH_FIELD::Matches): the instance's reference, and
 *  with several units the reference with its unit letter. */
export function refMatchTexts(ref: string, unit: number, unitCount: number): string[] { return unitCount > 1 ? [ref, ref + unitSuffix(unit)] : [ref]; }

// ---------------------------------------------------------------- the virtual list (wxLC_VIRTUAL)
/** The rows of a fixed-height list a scrolled viewport shows: [start, end) with `overscan` rows either side, and the
 *  heights that stand for the rows before and after them. */
export function rowWindow(count: number, scrollTop: number, viewHeight: number, rowH: number, overscan: number): { start: number; end: number; before: number; after: number } {
  const start = Math.max(0, Math.min(count, Math.floor(Math.max(0, scrollTop) / rowH) - overscan));
  const end = Math.max(start, Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewHeight)) / rowH) + overscan));
  return { start, end, before: start * rowH, after: (count - end) * rowH };
}
/**
 * EDA_UNIT_UTILS::UI::MessageTextFromValue( value, true, EDA_DATA_TYPE::AREA ): an area in the user's units with the
 * short form's precision (mm² "%.3f" trimmed to 2½ digits, mils² "%.0f", in² "%.3f"), scientific when it would show
 * only zeros, then the unit label with "²".
 */
export function areaText(mm2: number, unit: string): string {
  const [k, fmt, label] = unit === "in" ? [25.4 * 25.4, 3, " in"] : unit === "mil" ? [0.0254 * 0.0254, 0, " mils"] : [1, 3, " mm"];
  const v = mm2 / (k as number);
  let t = v.toFixed(fmt as number);
  if (v !== 0 && !/[1-9]/.test(t)) { const e = v.toExponential(3).replace(/e([+-])(\d)$/, "e$10$2"); t = e; }
  else if (unit !== "in" && unit !== "mil" && t.length > 4 && t[t.length - 4] === "." && t[t.length - 1] === "0") t = t.slice(0, -1);
  return t + label + "\u00b2";
}
/** ZONE_SEARCH_HANDLER's Layer cell: the zone's layers on this board in LSET::UIOrder, joined by "," (wxJoin). */
export function zoneLayersCell(layers: string[], boardCopper: string[], uiRank: (l: string) => number, name: (l: string) => string): string {
  const out = new Set<string>();
  for (const l of layers) {
    if (l === "*.Cu" || l === "F&B.Cu") { for (const c of l === "*.Cu" ? boardCopper : ["F.Cu", "B.Cu"]) out.add(c); }
    else if (l.startsWith("*.")) { out.add("F." + l.slice(2)); out.add("B." + l.slice(2)); }
    else if (/\.Cu$/.test(l) && boardCopper.length && !boardCopper.includes(l)) continue;   // AllCuMask( GetCopperLayerCount() )
    else out.add(l);
  }
  return Array.from(out).sort((a, b) => uiRank(a) - uiRank(b)).map(name).join(",");
}
/** The area of a closed outline (shoelace), mm². */
export function outlineArea(pts: [number, number][]): number { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a) / 2; }
