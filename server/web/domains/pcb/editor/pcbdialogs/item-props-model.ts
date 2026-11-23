// pcbdialogs/item-props-model — the pure half of the board item dialogs in ./item-props: the rule area's placement
// source lists (DIALOG_RULE_AREA_PROPERTIES::TransferDataToWindow), UNIT_BINDER::Validate's range messages, the
// footprint dialog's field checks (DIALOG_FOOTPRINT_PROPERTIES::Validate) and the solder paste margin / ratio text
// (MARGIN_OFFSET_BINDER).  No DOM: the node tests load it directly.
type Node = unknown[];
const isList = Array.isArray;
const kid = (n: Node | null | undefined, key: string): Node | null => { if (!n) return null; for (let j = 1; j < n.length; j++) { const c = n[j]; if (isList(c) && c[0] === key) return c as Node; } return null; };
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
interface DocLike { items: Map<string, { id: string; kind: string; node: Node }> }

/** zones.h: ZONE_BORDER_HATCH_MINDIST_MM / ZONE_BORDER_HATCH_MAXDIST_MM. */
export const HATCH_PITCH_MIN = 0.1, HATCH_PITCH_MAX = 2.0;
/** EDA_TEXT: TEXT_MIN_SIZE_MM / TEXT_MAX_SIZE_MM. */
export const TEXT_MIN_SIZE = 0.001, TEXT_MAX_SIZE = 250;

/** UNIT_BINDER::Validate: "%s must be at least %s." / "%s must be less than %s." (the label without its colon). */
export function rangeError(label: string, v: number, min: number, max: number, fmt: (mm: number) => string): string | null {
  const what = label.replace(/:\s*$/, "");
  if (v < min - 1e-12) return `${what} must be at least ${fmt(min)}.`;
  if (v > max + 1e-12) return `${what} must be less than ${fmt(max)}.`;
  return null;
}

/**
 * The rule area's Placement page lists: sheet names of every footprint, the names of the named groups a footprint
 * sits in (its parent group and theirs), and the component classes the footprints carry; each sorted (std::set).
 */
export function placementSources(doc: DocLike, groupMembers: (n: Node) => string[]): { sheets: string[]; groups: string[]; classes: string[] } {
  const sheets = new Set<string>(), groups = new Set<string>(), classes = new Set<string>();
  const parentOf = new Map<string, { id: string; node: Node }>();
  for (const it of doc.items.values()) if (it.kind === "group") for (const m of groupMembers(it.node)) parentOf.set(m, it);
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    const sn = kid(it.node, "sheetname"); sheets.add(sn ? str(sn[1]) : "");
    const cc = kid(it.node, "component_classes"); if (cc) for (const c of cc.slice(1)) if (isList(c) && c[0] === "class") classes.add(str(c[1]));
    const seen = new Set<string>();
    for (let g = parentOf.get(it.id); g && !seen.has(g.id); g = parentOf.get(g.id)) { seen.add(g.id); const nm = typeof g.node[1] === "string" ? g.node[1] : ""; if (nm) groups.add(nm); }
  }
  const sorted = (s: Set<string>): string[] => Array.from(s).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { sheets: sorted(sheets), groups: sorted(groups), classes: sorted(classes) };
}
export const NOT_FOUND_PREFIX = "Not found on board: ";
/**
 * One placement combo: the names, the first selected; the zone's own source selected when it is this kind's, or
 * shown at index 0 as "Not found on board: <name>" when no footprint has it (setupCurrentSourceSelection).
 * `value(i)` is what TransferDataFromWindow stores for entry i.
 */
export function placementCombo(names: string[], cur: string, ownKind: boolean): { labels: string[]; selected: number; value(i: number): string } {
  const labels = names.slice(); let selected = labels.length ? 0 : -1, notFound = false;
  if (ownKind && cur) {
    const i = labels.indexOf(cur);
    if (i >= 0) selected = i; else { labels.unshift(NOT_FOUND_PREFIX + cur); selected = 0; notFound = true; }
  }
  return { labels, selected, value: (i) => (i < 0 ? "" : i === 0 && notFound ? cur : labels[i] ?? "") };
}
export type PlacementKind = "sheetname" | "component_class" | "group";
/** format( ZONE* )'s (placement (enabled yes|no) (<kind> "<source>")). */
export function placementText(enabled: boolean, kind: PlacementKind, source: string, quote: (s: string) => string): string {
  return `(placement (enabled ${enabled ? "yes" : "no"}) (${kind} ${quote(source)}))`;
}

/** EDA_TEXT::ValidateStrokeWidth / ClampTextPenSize (not strict): the largest pen a w × h text keeps, 25% of the smaller size. */
export const maxTextPen = (w: number, ht: number): number => +(Math.min(Math.abs(w), Math.abs(ht)) * 0.25).toFixed(6);
/**
 * DIALOG_FOOTPRINT_PROPERTIES::Validate on one field row (after its name): the bad column, the message and the value
 * the cell is set to (the limit, or the clamped thickness).
 */
export interface FieldRowCheck { col: "w" | "ht" | "th"; msg: string; reset: number }
export function footprintFieldRowError(w: number, ht: number, th: number, fmt: (mm: number) => string): FieldRowCheck | null {
  if (w < TEXT_MIN_SIZE) return { col: "w", msg: `Text width must be at least ${fmt(TEXT_MIN_SIZE)}.`, reset: TEXT_MIN_SIZE };
  if (w > TEXT_MAX_SIZE) return { col: "w", msg: `Text width must be at most ${fmt(TEXT_MAX_SIZE)}.`, reset: TEXT_MAX_SIZE };
  if (ht < TEXT_MIN_SIZE) return { col: "ht", msg: `Text height must be at least ${fmt(TEXT_MIN_SIZE)}.`, reset: TEXT_MIN_SIZE };
  if (ht > TEXT_MAX_SIZE) return { col: "ht", msg: `Text height must be at most ${fmt(TEXT_MAX_SIZE)}.`, reset: TEXT_MAX_SIZE };
  const pen = maxTextPen(w, ht);
  if (th > pen + 1e-9) return { col: "th", msg: `Text thickness is too large for the text size.\nIt will be clamped at ${fmt(pen)}.`, reset: pen };
  return null;
}

/** printf's %.4g (the ratio's percentage in MARGIN_OFFSET_BINDER::formatValue). */
export function fmt4g(v: number): string {
  if (v === 0) return "0";
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e < -4 || e >= 4) { const [m, x] = v.toExponential(3).split("e"); const mm = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m; const xe = Number(x); return `${mm}e${xe < 0 ? "-" : "+"}${String(Math.abs(xe)).padStart(2, "0")}`; }
  return String(+v.toPrecision(4));
}
/**
 * MARGIN_OFFSET_BINDER::formatValue: the offset in the user units (no unit text) and/or the ratio as "%.4g%%" joined by
 * " + " / " - "; a zero offset with no ratio is "0"; neither set is blank.  `fmtAbs` is StringFromValue.
 */
export function marginText(abs: number, ratio: number, fmtAbs: (mm: number) => string): string {
  let out = "";
  if (!isNaN(abs) && abs !== 0) out = fmtAbs(abs);
  if (!isNaN(ratio) && Math.abs(ratio) > 1e-9) {
    const pct = ratio * 100;
    out = out ? out + (pct >= 0 ? ` + ${fmt4g(pct)}%` : ` - ${fmt4g(-pct)}%`) : `${fmt4g(pct)}%`;
  } else if (!isNaN(abs) && abs === 0) out = "0";
  return out;
}
/**
 * MARGIN_OFFSET_BINDER::parseInput: terms split at the + / - between them, each a percentage ("5%") or a distance in
 * the user units; their sums.  { abs, ratio } with NaN for a part not given (blank: both NaN), null when a term can't
 * be read (Validate's "%s could not be parsed as a distance and/or percentage offset.").
 */
export function parseMarginText(text: string, parseLen: (t: string) => number): { abs: number; ratio: number } | null {
  const input = text.trim(); if (!input) return { abs: NaN, ratio: NaN };
  let norm = "", lastOp = true;
  for (const ch of input) {
    if ((ch === "+" || ch === "-") && !lastOp) { norm += " " + ch + " "; lastOp = true; }
    else { norm += ch; lastOp = ch === "+" || ch === "-"; }
  }
  const terms = norm.split(" ").map((t) => t.trim()).filter((t) => t);
  let abs = 0, ratio = 0, hasAbs = false, hasRatio = false, sign = 1;
  for (const term of terms) {
    if (term === "+") { sign = 1; continue; }
    if (term === "-") { sign = -1; continue; }
    if (term.endsWith("%")) {
      const v = Number(term.slice(0, -1).trim().replace(",", "."));
      if (term.slice(0, -1).trim() === "" || isNaN(v)) return null;
      ratio += sign * v / 100; hasRatio = true;
    } else {
      const v = parseLen(term); if (isNaN(v)) return null;
      abs += sign * v; hasAbs = true;
    }
    sign = 1;
  }
  if (!hasAbs && !hasRatio) return null;
  return { abs: hasAbs ? +abs.toFixed(6) : NaN, ratio: hasRatio ? ratio : NaN };
}

/** DIALOG_FOOTPRINT_PROPERTIES jumper groups: "all pads with duplicate numbers", "(1, 2); (3, 4)" or "none". */
export function jumperGroupsText(fp: Node): string {
  const dup = kid(fp, "duplicate_pad_numbers_are_jumpers");
  let out = dup && str(dup[1]) === "yes" ? "all pads with duplicate numbers" : "";
  const jg = kid(fp, "jumper_pad_groups");
  for (const g of jg ? jg.slice(1).filter(isList) : []) { if (out) out += ";  "; out += "(" + (g as Node).map(str).join(", ") + ")"; }
  return out || "none";
}

/** DIALOG_TARGET_PROPERTIES: m_Size.Validate( Mils2IU( 1 ), INT_MAX ). */
export const TARGET_MIN_SIZE = 0.0254;

/** LINE_ENDING_STYLE in the dialog's choice order (s_defaultChoiceOrder), with the file token. */
export const LINE_ENDING_CHOICES: [string, string][] = [["none", "None"], ["arrow", "Arrow"], ["arrow_open", "Open Arrow"], ["circle", "Circle"], ["square", "Square"]];
export interface EndingValues { style: string; length: number; width: number; thickness: number; strokeType: string }
/** A shape's (start_shape …) / (end_shape …), as the dialog loads it (no node: None, sizes 0). */
export function readEndingValues(n: Node, key: "start_shape" | "end_shape"): EndingValues {
  const e = kid(n, key); const num = (c: Node | null): number => (c && typeof c[1] === "number" ? c[1] : 0);
  if (!e) return { style: "none", length: 0, width: 0, thickness: 0, strokeType: "default" };
  const style = LINE_ENDING_CHOICES.some(([t]) => t === str(e[1])) ? str(e[1]) : "none";
  const s = kid(e, "stroke");
  return { style, length: num(kid(e, "length")), width: num(kid(e, "width")), thickness: num(kid(s, "width")), strokeType: str((kid(s, "type") || [])[1]) || "default" };
}
/** LINE_ENDING::Format after the dialog's std::max( 0, value ): nothing for None, the sizes only when positive. */
export function endingText(key: "start_shape" | "end_shape", v: EndingValues, f6: (x: number) => string): string | null {
  if (v.style === "none") return null;
  const L = Math.max(0, v.length), W = Math.max(0, v.width), T = Math.max(0, v.thickness);
  return `(${key} ${v.style}${L > 0 ? ` (length ${f6(L)})` : ""}${W > 0 ? ` (width ${f6(W)})` : ""}${T > 0 ? ` (stroke (width ${f6(T)}) (type ${v.strokeType || "default"}))` : ""})`;
}
