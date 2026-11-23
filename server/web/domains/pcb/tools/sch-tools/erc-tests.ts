// tools/sch-tools/erc-tests.ts — the ERC_TESTER tests beyond connectivity (eeschema/erc/erc.cpp): duplicate sheet
// names, field name whitespace, empty power values, ground pins, stacked pin notation, off-grid endpoints, undefined
// netclasses (one sheet), and the tests that look across the whole hierarchy: multi-unit footprints / values / missing
// units, local vs global names, similar names, single global labels (crossSheet).
import type { Pt, ErcMarker } from "./types";
import { type AnnSheet, type SchRef, checkAnnotation, sheetReferences } from "./annotate";
import { type SymPin, globalPowerPin, symbolIsPower, symbolLibId, symbolPins } from "./autoplace";
import { terminalsOf } from "./highlight";
import { K, atOf, kid, kids, num, ptsOf, str } from "./state";
import { onSegMid, r4 } from "./util";
import { unescapeText } from "../../canvas/text";
import type { ErcItemRef, ErcNet, ErcTerm } from "./erc";

type Mark = (code: string, severity: string, p: Pt, text: string, ids: Iterable<string>, refs?: ErcItemRef[], extra?: Record<string, unknown>) => void;

const prop = (n: SNode, name: string): SNode | undefined => kids(n, "property").find((p) => str(p[1]) === name);
const propText = (n: SNode, name: string): string => { const p = prop(n, name); return p ? str(p[2]) : ""; };

/** ERC_TESTER::TestGroundPins' isGround. */
export function isGroundName(txt: string): boolean {
  const u = txt.toUpperCase();
  return u.includes("GND") || u === "EARTH" || u.startsWith("EARTH_") || u === "VSS" || u === "VSSA";
}

/** ExpandStackedPinNotation's validity (common/string_utils.cpp): brackets must wrap the whole number, and a range
 *  needs the same alphabetic prefix on both ends and a start no greater than its end. */
export function stackedPinNotationValid(n: string): boolean {
  const open = n.includes("["), close = n.includes("]");
  if (!open && !close) return true;
  if (!n.startsWith("[") || !n.endsWith("]")) return false;
  const inner = n.slice(1, -1), parts = inner.split(/(?<!\\),/).map((s) => s.trim()).filter((s) => s);
  if (!parts.length) return false;
  const parse = (t: string): [string, number] => { const m = t.match(/^(.*?)(\d+)$/); return m ? [m[1], parseInt(m[2], 10)] : [t, -1]; };
  for (const part of parts) {
    const dash = part.search(/(?<!\\)-/);
    if (dash < 0) continue;
    const [sp, sv] = parse(part.slice(0, dash).replace(/\\(.)/g, "$1").trim()), [ep, ev] = parse(part.slice(dash + 1).replace(/\\(.)/g, "$1").trim());
    if (sp !== ep || sv === -1 || ev === -1 || sv > ev) return false;
  }
  return true;
}

/** LIB_SYMBOL::LetterSubReference( aUnit, 'A' ). */
export function letterSubReference(unit: number): string {
  let s = "", u = unit;
  do { u -= 1; s = String.fromCharCode(65 + (u % 26)) + s; u = Math.floor(u / 26); } while (u > 0);
  return s;
}

const isDigit = (c: string): boolean => c >= "0" && c <= "9";
/** NUMERIC_EVALUATOR::IsOldSchoolDecimalSeparator: the SI letters that may stand for the decimal point (4K7). */
const OLD_SCHOOL = new Set(["p", "n", "\u00b5", "\u03bc", "u", "m", "L", "R", "F", "k", "K", "M", "G", "T"]);
/** ApplyModifier (string_utils.cpp), whether it takes the text: a multiplier letter, then nothing or a unit it knows. */
function applyModifierTakes(t: string): boolean {
  if (!t.length) return false;
  const st = t.replace(/\s+$/, "");
  if (st === "m" || st === "mils" || st === "in") return true;
  const units = ("afpnu\u00b5\u03bcmLRFkKMGTPE".includes(t[0]) ? t.slice(1) : t).replace(/\s+$/, "");
  return !units.length || ["f", "hz", "\u03c9", "w", "v", "a", "h", "s", "m"].includes(units.toLowerCase());
}
/**
 * SplitString (string_utils.cpp): the text before the number, the number and what follows.  One SI letter inside the
 * number (4K7, 1u5F) is its decimal point: the number gets a "." and the letter goes to the front of the suffix.
 */
export function splitString(s: string): [string, string, string] {
  if (!s.length) return ["", "", ""];
  let ii = s.length - 1;
  for (; ii >= 0; ii--) if (isDigit(s[ii])) break;
  if (ii < 0) return [s, "", ""];
  let end = s.slice(ii + 1), infix = "";
  const position = ii + 1;
  for (; ii >= 0; ii--) {
    const c = s[ii];
    if (isDigit(c)) continue;
    // one infix only (4K7, not 4KK7); not the first character unless nothing follows (K7, not K7X); a valid SI
    // separator (not 4X7) that makes sense with the suffix (not T9G)
    if (!infix && (ii > 0 || !end) && OLD_SCHOOL.has(c) && applyModifierTakes(c + end)) { infix = c; continue; }
    if (c === "." || c === ",") continue;
    break;
  }
  let beg = "", digits: string;
  if (ii < 0) digits = s.slice(0, position);
  else { digits = s.slice(ii + 1, position); beg = s.slice(0, ii + 1); }
  if (infix) { digits = digits.split(infix).join("."); end = infix + end; }
  return [beg, digits, end];
}
/** TestSimilarLabels' normalizeLabel: SplitString, a "+" prefix dropped, micro signs in the suffix read as 'u', case folded. */
export function normalizeSimilar(label: string): string {
  let [prefix, value, units] = splitString(label.trim());
  if (prefix === "+") prefix = "";
  units = units.replace(/[\u00b5\u03bc]/g, "u");
  return prefix.toLowerCase() + value.toLowerCase() + units.toLowerCase();
}

/** The name ERC compares for a net: its power symbol, else a global, hierarchical or local label (driver priority). */
export function ercNetName(net: ErcNet): string {
  const pick = (f: (t: ErcTerm) => boolean): ErcTerm | undefined => net.terms.find(f);
  const pw = pick((t) => !!t.key); if (pw) return pw.key!.replace(/^global:/, "");
  for (const k of ["global_label", "hierarchical_label", "label"]) { const l = pick((t) => t.item.kind === k); if (l) return str(l.item.node[1]); }
  return "";
}

export interface SheetTestOpts { connectionGrid?: number; netclasses?: Iterable<string> | null; defaultNetclass?: string }

/** The tests of one sheet; `nets` are ercNets(doc).nets. */
export function sheetTests(doc: KDoc, nets: ErcNet[], mark: Mark, itemRef: (doc: KDoc, it: KItem) => ErcItemRef, pinRef: (t: ErcTerm & { pin: SymPin }) => ErcItemRef, opts: SheetTestOpts): void {
  // TestDuplicateSheetNames: sheet names on one sheet, compared without case
  const sheetItems = Array.from(doc.items.values()).filter((it) => it.kind === "sheet");
  const sheetName = (it: KItem): string => propText(it.node, "Sheetname") || propText(it.node, "Sheet name");
  for (let i = 0; i < sheetItems.length; i++) for (let j = i + 1; j < sheetItems.length; j++)
    if (sheetName(sheetItems[i]).toLowerCase() === sheetName(sheetItems[j]).toLowerCase()) mark("duplicate_sheet_names", "error", atOf(sheetItems[i].node), "Duplicate sheet names within a given sheet", [sheetItems[i].id, sheetItems[j].id]);
  // TestFieldNameWhitespace: symbol and sheet fields
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" && it.kind !== "sheet") continue;
    for (const f of kids(it.node, "property")) {
      const name = str(f[1]); if (name === name.trim()) continue;
      const at = kid(f, "at"), p: Pt = at ? [num(at[1]), num(at[2])] : atOf(it.node);
      mark("field_name_whitespace", "warning", p, `Field name has leading or trailing whitespace: '${name}'`, [it.id], [itemRef(doc, it), { x: r4(p[0]), y: r4(p[1]), desc: `Field ${name}` }]);
    }
  }
  // the net each pin is on
  const netOf = new Map<ErcTerm, string>();
  for (const n of nets) { const name = ercNetName(n); for (const t of n.terms) netOf.set(t, name); }
  const termsBySym = new Map<KItem, (ErcTerm & { pin: SymPin })[]>();
  for (const n of nets) for (const t of n.terms) if (t.pin) { if (!termsBySym.has(t.item)) termsBySym.set(t.item, []); termsBySym.get(t.item)!.push(t as ErcTerm & { pin: SymPin }); }
  const grid = Math.round((opts.connectionGrid || 1.27) * 1e4), off = (p: Pt): boolean => Math.round(p[0] * 1e4) % grid !== 0 || Math.round(p[1] * 1e4) % grid !== 0;
  for (const it of doc.items.values()) {
    if (it.kind === "symbol") {
      const pins = termsBySym.get(it) || [];
      // TestEmptyPowerValues: the first power pin of a power symbol names its net from the value
      if (symbolIsPower(doc, it)) {
        const pp = pins.find((t) => t.pin.type === "power_in");
        if (pp && !propText(it.node, "Value").trim()) mark("empty_power_value", "error", pp.p, "Power symbol has an empty value", [it.id], [pinRef(pp)]);
      }
      // TestGroundPins: a ground-named power pin off ground while another power pin of the symbol is on one
      let hasGround = false; const bad: typeof pins = [];
      for (const t of pins) {
        if (t.pin.type !== "power_out" && t.pin.type !== "power_in") continue;
        const g = isGroundName(netOf.get(t) || ""); if (g) hasGround = true;
        if (isGroundName(t.pin.name) && !g) bad.push(t);
      }
      if (hasGround) for (const t of bad) mark("ground_pin_not_ground", "warning", t.p, `Pin ${t.pin.name} not connected to ground net`, [it.id], [pinRef(t)]);
      // TestStackedPinNotation
      for (const t of pins) if (!stackedPinNotationValid(t.pin.number)) mark("stacked_pin_name", "warning", t.p, "Pin name resembles stacked pin", [it.id], [pinRef(t)]);
      // TestOffGridEndpoints: the first off-grid pin that is not a no-connect pin
      const offPin = symbolPins(doc, it).find((p) => p.type !== "no_connect" && off([p.x, p.y]));
      if (offPin) mark("endpoint_off_grid", "warning", [offPin.x, offPin.y], "Symbol pin or wire end off connection grid", [it.id], [pinRef({ item: it, p: [offPin.x, offPin.y], net: "wire", pin: offPin })]);
    } else if ((it.kind === "wire" || it.kind === "bus") && kid(it.node, "pts")) {
      const pts = terminalsOf(doc, it).map((t) => t.p);
      if (pts.length >= 2) { const bp = off(pts[0]) ? pts[0] : off(pts[pts.length - 1]) ? pts[pts.length - 1] : null; if (bp) mark("endpoint_off_grid", "warning", bp, "Symbol pin or wire end off connection grid", [it.id]); }
    } else if (it.kind === "bus_entry") {
      for (const t of terminalsOf(doc, it)) if (off(t.p)) mark("endpoint_off_grid", "warning", t.p, "Symbol pin or wire end off connection grid", [it.id]);
    }
  }
  // TestMissingNetclasses: a Netclass field naming a class the project does not define
  if (opts.netclasses) {
    const known = new Set(opts.netclasses), def = opts.defaultNetclass || "Default";
    for (const it of doc.items.values()) for (const f of kids(it.node, "property")) {
      if (str(f[1]) !== "Netclass") continue;
      const nc = str(f[2]); if (!nc || nc === def || known.has(nc)) continue;
      mark("undefined_netclass", "error", atOf(it.node), `Netclass ${nc} is not defined`, [it.id]);
    }
  }
}

/** A sheet for CheckAnnotate: its document, the instance path its symbols record and its page, when the caller knows the hierarchy. */
export interface AnnotInstance { doc: KDoc; path?: string | null; page?: number; /** the sheet path's reference suffix (SCHEMATIC::GetRefSuffix) when the project numbers reused sheets with suffixes */ suffix?: string }
/**
 * SCH_SHEET_LIST::GetSymbols( refs, SYMBOL_FILTER_NON_POWER, true ) for ANNOTATE_ALL: the references of every sheet
 * instance.  Without known instance paths a file counts once, however many sheets use it.
 */
function annotationRefs(insts: AnnotInstance[]): { sheets: (AnnSheet | null)[]; refs: SchRef[] } {
  const seenDocs = new Set<KDoc>(), sheets: (AnnSheet | null)[] = insts.map((s, i) => {
    const path = s.path !== undefined ? s.path : s.doc.instancePath || null;
    if (!path) { if (seenDocs.has(s.doc)) return null; seenDocs.add(s.doc); }
    return { doc: s.doc, path, page: s.page || i + 1 };
  });
  const refs: SchRef[] = [];
  sheets.forEach((sh, i) => { if (!sh) return; const suffix = insts[i].suffix; for (const r of sheetReferences(sh, null, true)) { if (suffix) r.suffix = suffix; refs.push(r); } });
  return { sheets, refs };
}
/** SCH_EDIT_FRAME::CheckAnnotate( handler, ANNOTATE_ALL ): the number of annotation errors of the whole schematic. */
export function checkAnnotate(insts: (AnnotInstance | KDoc)[]): number {
  const { refs } = annotationRefs(insts.map((s) => ((s as KDoc).items instanceof Map ? { doc: s as KDoc } : s as AnnotInstance)));
  return refs.length ? checkAnnotation(refs, () => { /* counted only */ }) : 0;
}

/** A sheet instance for the hierarchy-wide tests; `key` names the sheet path its markers go to. */
export interface ErcInstance { doc: KDoc; key: string; nets: ErcNet[]; /** the instance path its symbols record ("/<root uuid>/<sheet uuid>…") and its page, when the caller knows the hierarchy */ path?: string | null; page?: number }
interface Named { inst: number; it: KItem; p: Pt; name: string; pin: boolean; global: boolean; hier: boolean; label: boolean; ref?: ErcItemRef }

/**
 * The tests over every sheet of the schematic at once (ERC_TESTER: TestMultiunitFootprints, TestMissingUnits,
 * CheckAnnotation, TestFootprintFilters, TestSameLocalGlobalLabel, TestSimilarLabels, ercCheckSingleGlobalLabel).
 * Returns the markers of each instance (by index).
 */
export function hierarchyTests(insts: ErcInstance[], itemRef: (doc: KDoc, it: KItem) => ErcItemRef, pinRef: (t: ErcTerm & { pin: SymPin }) => ErcItemRef): ErcMarker[][] {
  const out: ErcMarker[][] = insts.map(() => []);
  const mark = (i: number, code: string, severity: string, p: Pt, text: string, ids: string[], items: ErcItemRef[]): void => { out[i].push({ code, severity, x: r4(p[0]), y: r4(p[1]), text, ids: Array.from(new Set(ids)), items } as ErcMarker); };
  // ---- ERC_TESTER::TestAnnotation: SCH_REFERENCE_LIST::CheckAnnotation over every sheet instance (power and '#'
  // symbols left out); the marker carries the handler's message as it is and sits on the first item's symbol, on its sheet
  {
    const { sheets: annSheets, refs } = annotationRefs(insts);
    const CODES: Record<string, string> = { unannotated: "unannotated", extra_units: "extra_units", duplicate_reference: "duplicate_reference", different_unit_value: "unit_value_mismatch" };
    if (refs.length) checkAnnotation(refs, (code, msg, a, b) => {
      const i = annSheets.indexOf(a.sheet), ia = a.item!, ib = b && b.item;
      mark(Math.max(0, i), CODES[code], "error", atOf(ia.node), msg, ib ? [ia.id, ib.id] : [ia.id], ib && b!.sheet ? [itemRef(a.sheet!.doc, ia), itemRef(b!.sheet.doc, ib)] : [itemRef(a.sheet!.doc, ia)]);
    });
  }
  // ---- multi-unit symbols, grouped by reference
  interface Unit { inst: number; it: KItem; unit: number; fp: string; value: string; ref: string }
  const groups = new Map<string, Unit[]>();
  insts.forEach((s, i) => {
    for (const it of s.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const ref = it.ref || ""; if (!ref || ref.startsWith("#") || /\?$/.test(ref)) continue;
      const unit = kid(it.node, "unit") ? num(kid(it.node, "unit")![1], 1) : 1;
      if (!groups.has(ref)) groups.set(ref, []);
      groups.get(ref)!.push({ inst: i, it, unit, fp: propText(it.node, "Footprint"), value: propText(it.node, "Value"), ref });
    }
  });
  for (const [ref, units] of groups) {
    const doc0 = insts[units[0].inst].doc, lib = K.resolveLib(doc0, symbolLibId(units[0].it.node));
    const subs = lib ? kids(lib, "symbol") : [];
    let count = 1; for (const s of subs) { const m = str(s[1]).match(/_(\d+)_(\d+)$/); if (m) count = Math.max(count, +m[1]); }
    const unitName = (u: number): string => { for (const s of subs) { const m = str(s[1]).match(/_(\d+)_(\d+)$/); if (m && +m[1] === u) { const un = kid(s, "unit_name"); if (un) return str(un[1]); } } return letterSubReference(u); };
    const nameOf = (x: Unit): string => x.ref + (count > 1 ? letterSubReference(x.unit) : "");
    // GetMultiUnitSymbols: only symbols of more than one unit are compared
    if (count <= 1) continue;
    // TestMultiunitFootprints: the first unit with a footprint is the reference
    const base = units.find((x) => x.fp);
    if (base) for (const x of units) if (x.fp && x.fp !== base.fp)
      mark(x.inst, "different_unit_footprint", "error", atOf(x.it.node), `Different footprints assigned to ${nameOf(base)} and ${nameOf(x)}`, [base.it.id, x.it.id], [itemRef(insts[base.inst].doc, base.it), itemRef(insts[x.inst].doc, x.it)]);
    // TestMissingUnits
    if (count > 1 && subs.length) {
      const placed = new Set(units.map((x) => x.unit)), missing: number[] = [], power: number[] = [], input: number[] = [], bidi: number[] = [];
      for (let u = 1; u <= count; u++) {
        if (placed.has(u)) continue;
        missing.push(u);
        const types = new Set<string>();
        for (const s of subs) { const m = str(s[1]).match(/_(\d+)_(\d+)$/); if (!m || (+m[1] !== u && +m[1] !== 0)) continue; for (const g of kids(s, "pin")) types.add(str(g[1])); }
        if (types.has("power_in")) power.push(u); if (types.has("input")) input.push(u); if (types.has("bidirectional")) bidi.push(u);
      }
      const b0 = units[0], names = (l: number[]): string => "[ " + l.slice(0, 3).map(unitName).join(", ") + (l.length > 3 ? ", ..." : "") + " ]";
      const report = (l: number[], code: string, sev: string, fmt: (n: string) => string): void => { if (l.length) mark(b0.inst, code, sev, atOf(b0.it.node), fmt(names(l)), [b0.it.id], [itemRef(insts[b0.inst].doc, b0.it)]); };
      report(missing, "missing_unit", "warning", (n) => `Symbol ${ref} has unplaced units ${n}`);
      report(power, "missing_power_pin", "error", (n) => `Symbol ${ref} has input power pins in units ${n} that are not placed`);
      report(input, "missing_input_pin", "warning", (n) => `Symbol ${ref} has input pins in units ${n} that are not placed`);
      report(bidi, "missing_bidi_pin", "warning", (n) => `Symbol ${ref} has bidirectional pins in units ${n} that are not placed`);
    }
  }
  // ---- TestFootprintFilters: the assigned footprint against the library symbol's footprint filters
  const wild = (text: string, pattern: string): boolean => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(text);
  insts.forEach((s, i) => {
    for (const it of s.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const lib = K.resolveLib(s.doc, symbolLibId(it.node)); if (!lib) continue;
      const filters = propText(lib, "ki_fp_filters").split(/\s+/).filter((f) => f); if (!filters.length) continue;
      const fp = propText(it.node, "Footprint"), lowerId = fp.toLowerCase(), colon = fp.indexOf(":");
      // LIB_ID::Parse: an illegal character after the first one drops the footprint from the test
      const name = colon >= 0 ? fp.slice(colon + 1) : fp;
      if (name.search(/[<>"\\:\t\n\r]/) > 0) continue;
      const lowerName = name.toLowerCase();
      if (filters.some((f) => (f.includes(":") ? wild(lowerId, f.toLowerCase()) : wild(lowerName, f.toLowerCase())))) continue;
      mark(i, "footprint_filter", "warning", atOf(it.node), `Assigned footprint (${lowerName}) doesn't match footprint filters (${filters.join(" ")})`, [it.id], [itemRef(s.doc, it)]);
    }
  });
  // ---- named items: labels and power pins (collectNamedItems)
  const named = (similar: boolean): Named[] => {
    const l: Named[] = [];
    insts.forEach((s, i) => {
      for (const n of s.nets) for (const t of n.terms) {
        const k = t.item.kind;
        if (k === "label" || k === "global_label" || k === "hierarchical_label") l.push({ inst: i, it: t.item, p: atOf(t.item.node), name: str(t.item.node[1]), pin: false, global: k === "global_label", hier: k === "hierarchical_label", label: k === "label", ref: itemRef(s.doc, t.item) });
        else if (t.pin && t.pin.type === "power_in") {
          const powerSym = !!t.power, glob = globalPowerPin(s.doc, t.item, t.pin);
          if (!powerSym && !glob) continue;
          const name = !similar && glob && !powerSym ? t.pin.name : propText(t.item.node, "Value");
          l.push({ inst: i, it: t.item, p: t.p, name, pin: true, global: glob, hier: false, label: false, ref: pinRef(t as ErcTerm & { pin: SymPin }) });
        }
      }
    });
    return l;
  };
  // TestSameLocalGlobalLabel: the first item of each name, global against local
  const globals = new Map<string, Named>(), locals = new Map<string, Named>();
  for (const x of named(false)) { if (x.hier) continue; const m = x.global ? globals : locals; if (!m.has(x.name)) m.set(x.name, x); }
  for (const [name, g] of globals) {
    const l = locals.get(name); if (!l) continue;
    const code = g.pin && l.pin ? "same_local_global_power" : "same_local_global_label";
    mark(g.inst, code, "warning", g.p, code === "same_local_global_power" ? "Local and global power symbols have same name" : "Local and global labels have same name", [g.it.id, l.it.id], [g.ref!, l.ref!]);
  }
  // TestSimilarLabels: names equal once normalized but shown differently; local labels on different sheets are fine
  const general = new Map<string, Named[]>();
  for (const x of named(true)) { const k = normalizeSimilar(x.name); if (!general.has(k)) general.set(k, []); general.get(k)!.push(x); }
  for (const list of general.values()) {
    list.sort((a, b) => (a.inst !== b.inst ? a.inst - b.inst : a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : 0));
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.name === b.name) continue;
      if (a.label && b.label && a.inst !== b.inst) continue;
      const code = a.pin && b.pin ? "similar_power" : a.pin || b.pin ? "similar_label_and_power" : "similar_labels";
      const text = code === "similar_power" ? "Power pins are similar" : code === "similar_label_and_power" ? "Power pin and label are similar" : "Labels are similar";
      mark(a.inst, code, "warning", a.p, text, [a.it.id, b.it.id], [a.ref!, b.ref!]);
    }
  }
  // ercCheckSingleGlobalLabel
  const gl = new Map<string, { n: number; inst: number; it: KItem }>();
  insts.forEach((s, i) => { for (const it of s.doc.items.values()) if (it.kind === "global_label") { const t = str(it.node[1]), e = gl.get(t); if (e) e.n++; else gl.set(t, { n: 1, inst: i, it }); } });
  for (const e of gl.values()) if (e.n === 1) mark(e.inst, "single_global_label", "warning", atOf(e.it.node), "Global label only appears once in the schematic", [e.it.id], [itemRef(insts[e.inst].doc, e.it)]);
  return out;
}

// ---------------------------------------------------------------- the connectivity's island diagnostics
/** What busTests needs of the hierarchy's net map: the net an item of this sheet is on (its name, whether it is a bus,
 *  its winning driver's priority and a bus's member nets). */
export interface BusTestOpts {
  busAliases?: Map<string, string[]> | Record<string, string[]> | null;
  netOfItem?(id: string): { name: string; bus: boolean; prio: number; members: string[] } | undefined;
}
// SCH_CONNECTIVITY's contact kinds (conn_islands.cpp) and which of them propagate to which
const ANCHOR = 0, WIRE = 1, BUS = 2, ENTRY = 3, NC = 5, BUS_SIDE = 6;
const PROPAGATES = [
  [true, true, true, true, true, false, false], [true, true, false, true, false, false, false], [true, false, true, false, true, false, false],
  [true, true, false, false, false, false, false], [true, false, true, false, true, false, false], [false, false, false, false, false, false, false],
  [false, false, false, false, false, false, false]];
/**
 * The connectivity engine's island diagnostics of one sheet (ENGINE::BusNetConflicts, BusBusConflicts,
 * BusEntryConflicts and WiredImplicitPowerPins, reported by ERC_TESTER::TestConnectivity): the sheet's items joined
 * into islands where their connection points meet (BuildScreenIslands: a line's middle counts where another item has a
 * connection point; a bus entry's end on a bus touches nothing; wires and buses meet only through an anchor such as
 * a label or a junction), then
 * - bus_to_net_conflict: an island with both net and bus parts (wires and buses, net and bus labels);
 * - bus_to_bus_conflict: a vector and a group bus label on one island, or bus labels sharing no member;
 * - net_not_bus_member: a bus entry whose net is not one of the members of the bus it touches;
 * - wired_implicit_power: a hidden power input of an ordinary symbol on an island with a wire (once per symbol).
 */
export function busTests(doc: KDoc, mark: Mark, itemRef: (doc: KDoc, it: KItem) => ErcItemRef, pinRef: (t: ErcTerm & { pin: SymPin }) => ErcItemRef, opts: BusTestOpts): void {
  interface Vertex { items: string[]; it: KItem; kind: string; seg?: [Pt, Pt]; pos: Pt; label?: { text: string; conn: ReturnType<typeof K.busConnection> }; prio: number; pin?: SymPin; pins?: SymPin[]; power?: boolean; sheetPin?: string }
  const verts: Vertex[] = [];
  interface Port { v: number; kind: number; bit: number }
  const points = new Map<string, { p: Pt; ports: Port[] }>();
  const key = (p: Pt): string => r4(p[0]) + "," + r4(p[1]);
  const addPort = (v: number, p: Pt, kind: number, bit: number): void => { const k = key(p); let e = points.get(k); if (!e) points.set(k, e = { p, ports: [] }); e.ports.push({ v, kind, bit }); };
  const aliases = opts.busAliases || undefined;
  const LABEL_PRIO: Record<string, number> = { label: 4, global_label: 7, hierarchical_label: 3 };
  for (const it of doc.items.values()) {
    const n = it.node;
    if (it.kind === "wire" || it.kind === "bus") {
      const pts = ptsOf(n) as Pt[]; if (pts.length < 2) continue;
      const v = verts.length; verts.push({ items: [it.id], it, kind: it.kind, seg: [pts[0], pts[pts.length - 1]], pos: pts[0], prio: 0 });
      addPort(v, pts[0], it.kind === "bus" ? BUS : WIRE, 1); addPort(v, pts[pts.length - 1], it.kind === "bus" ? BUS : WIRE, 2);
    } else if (it.kind === "bus_entry") {
      const [x, y] = atOf(n), sz = kid(n, "size"), a: Pt = [x, y], b: Pt = [x + (sz ? num(sz[1]) : 0), y + (sz ? num(sz[2]) : 0)];
      const v = verts.length; verts.push({ items: [it.id], it, kind: it.kind, pos: a, prio: 0 });
      addPort(v, a, ENTRY, 1); addPort(v, b, ENTRY, 2);
    } else if (it.kind === "label" || it.kind === "global_label" || it.kind === "hierarchical_label") {
      const p = atOf(n).slice(0, 2) as Pt, text = str(n[1]);
      const v = verts.length; verts.push({ items: [it.id], it, kind: it.kind, pos: p, prio: text ? LABEL_PRIO[it.kind] : 0, label: { text, conn: K.busConnection(text, aliases) } });
      addPort(v, p, ANCHOR, 1);
    } else if (it.kind === "junction" || it.kind === "no_connect" || it.kind === "netclass_flag" || it.kind === "directive_label") {
      const v = verts.length; verts.push({ items: [it.id], it, kind: it.kind, pos: atOf(n).slice(0, 2) as Pt, prio: 0 });
      addPort(v, atOf(n).slice(0, 2) as Pt, ANCHOR, 1);
    } else if (it.kind === "sheet") {
      for (const pin of kids(n, "pin")) {
        const p = atOf(pin).slice(0, 2) as Pt, text = str(pin[1]), uu = kid(pin, "uuid");
        const v = verts.length; verts.push({ items: [uu ? str(uu[1]) : it.id + "#" + text], it, kind: "sheet_pin", pos: p, prio: 2, sheetPin: text, label: { text, conn: K.busConnection(text, aliases) } });
        addPort(v, p, ANCHOR, 1);
      }
    } else if (it.kind === "symbol") {
      const power = symbolIsPower(doc, it), ref = it.ref || propText(n, "Reference"), onBoard = !kid(n, "on_board") || str(kid(n, "on_board")![1]) !== "no";
      // one vertex per pin number and position (pins stacked there are one contact)
      const groups = new Map<string, number>();
      for (const pin of symbolPins(doc, it)) {
        const g = pin.number + "@" + key([pin.x, pin.y]);
        let v = pin.type === "no_connect" ? undefined : groups.get(g);
        const prio = pin.type === "power_in" && (power || pin.hidden) ? 6 : !onBoard || ref.startsWith("#") ? 0 : 1;
        if (v === undefined) { v = verts.length; if (pin.type !== "no_connect") groups.set(g, v); verts.push({ items: [it.id + "#" + pin.number], it, kind: "pin", pos: [pin.x, pin.y], prio, pin, pins: [pin], power }); addPort(v, [pin.x, pin.y], pin.type === "no_connect" ? NC : ANCHOR, 1); }
        else verts[v].pins!.push(pin);
      }
    }
  }
  const parent = verts.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const busLinks: [number, number][] = [];
  const segs = verts.map((v, i) => [v, i] as const).filter(([v]) => !!v.seg);
  for (const e of points.values()) {
    // a line whose middle is at a connection point has a port there
    for (const [v, i] of segs) { const [a, b] = v.seg!; if (key(a) !== key(e.p) && key(b) !== key(e.p) && onSegMid(e.p, a, b)) e.ports.push({ v: i, kind: v.kind === "bus" ? BUS : WIRE, bit: 0 }); }
    const hasBus = e.ports.some((q) => q.kind === BUS);
    for (const q of e.ports) { if (q.kind === ENTRY && hasBus) q.kind = BUS_SIDE; else if (verts[q.v].kind === "junction" && hasBus) q.kind = BUS; }
    for (let x = 0; x < e.ports.length; x++) for (let y = x + 1; y < e.ports.length; y++) {
      const a = e.ports[x], b = e.ports[y]; if (a.v === b.v) continue;
      if ((a.kind === ENTRY || a.kind === BUS_SIDE) && b.kind === BUS) busLinks.push([a.v, b.v]);
      if ((b.kind === ENTRY || b.kind === BUS_SIDE) && a.kind === BUS) busLinks.push([b.v, a.v]);
      if (a.kind === NC || b.kind === NC) continue;
      if (PROPAGATES[a.kind][b.kind]) { const ra = find(a.v), rb = find(b.v); if (ra !== rb) parent[rb] = ra; }
    }
  }
  const islands = new Map<number, number[]>();
  verts.forEach((_, i) => { const r = find(i); const l = islands.get(r); if (l) l.push(i); else islands.set(r, [i]); });
  const uuidOf = (v: Vertex): string => v.items[0];
  const refOf = (v: Vertex): ErcItemRef => {
    if (v.kind === "pin" && v.pin) return pinRef({ item: v.it, p: v.pos, net: "wire", pin: v.pin });
    if (v.kind === "sheet_pin") { const pin = kids(v.it.node, "pin").find((q) => str(q[1]) === v.sheetPin), uu = pin ? kid(pin, "uuid") : null; return { x: r4(v.pos[0]), y: r4(v.pos[1]), desc: `Hierarchical Sheet Pin '${v.sheetPin}'`, id: v.it.id, sheetPin: v.sheetPin, ...(uu ? { uuid: str(uu[1]) } : {}) }; }
    return itemRef(doc, v.it);
  };
  const isBusConn = (v: Vertex): boolean => !!(v.label && v.label.conn);
  // CLAIM_LESS: the island's driver first (priority, the bus that contains the other, "-Pad" names last, then by name)
  const subset = (a: { full: string }[], b: { full: string }[]): boolean => a.every((m) => b.some((o) => o.full === m.full));
  const claimCmp = (a: Vertex, b: Vertex): number => {
    if (a.prio !== b.prio) return b.prio - a.prio;
    const ca = a.label && a.label.conn, cb = b.label && b.label.conn;
    if (ca && cb) { const aInB = subset(ca.members, cb.members), bInA = subset(cb.members, ca.members); if (bInA && !aInB) return -1; if (aInB && !bInA) return 1; }
    const na = a.label ? a.label.text : "", nb = b.label ? b.label.text : "";
    return na < nb ? -1 : na > nb ? 1 : uuidOf(a) < uuidOf(b) ? -1 : uuidOf(a) > uuidOf(b) ? 1 : 0;
  };
  const LABELISH = new Set(["label", "global_label", "hierarchical_label", "sheet_pin"]);
  for (const members of islands.values()) {
    const vs = members.map((i) => verts[i]).sort((a, b) => (uuidOf(a) < uuidOf(b) ? -1 : uuidOf(a) > uuidOf(b) ? 1 : 0));
    const hasWire = vs.some((v) => v.kind === "wire"), hasBusLine = vs.some((v) => v.kind === "bus");
    const claims = vs.filter((v) => v.prio > 0).sort(claimCmp);
    const hasBusLabel = claims.some((v) => LABELISH.has(v.kind) && isBusConn(v)), hasSignalLabel = claims.some((v) => LABELISH.has(v.kind) && !isBusConn(v));
    const bundle = claims.length ? isBusConn(claims[0]) : hasBusLine;
    const kindConflict = (hasWire && (hasBusLine || bundle)) || (hasBusLine && !bundle) || ((hasWire || hasSignalLabel) && hasBusLabel) || (hasBusLine && hasSignalLabel);
    if (kindConflict) {
      let net: Vertex | null = null, bus: Vertex | null = null;
      for (const v of vs) {
        let isBus: boolean;
        if (v.kind === "wire" || v.kind === "bus") isBus = v.kind === "bus";
        else if (LABELISH.has(v.kind)) isBus = v.prio > 0 && isBusConn(v);
        else continue;
        if (isBus && !bus) bus = v; else if (!isBus && !net) net = v;
        if (net && bus) break;
      }
      if (net && bus) mark("bus_to_net_conflict", "error", net.pos, "Invalid connection between bus and net items", [net.it.id, bus.it.id], [refOf(net), refOf(bus)]);
    }
    const schemas = claims.filter((v) => isBusConn(v));
    const first = schemas[0], second = first ? schemas.find((v) => v.label!.conn!.type !== first.label!.conn!.type) : undefined;
    if (first && second) {
      mark("bus_to_bus_conflict", "error", first.pos, "Bus vector and bus group are graphically connected", [first.it.id, second.it.id], [refOf(first), refOf(second)]);
    } else if (bundle && claims.length >= 2) {
      let canonical: Vertex | null = null;
      for (const v of schemas) {
        if (!LABELISH.has(v.kind)) continue;
        if (!canonical) { canonical = v; continue; }
        const leaves = new Set(canonical.label!.conn!.members.map((m) => m.full));
        if (v.label!.conn!.members.some((m) => leaves.has(m.full))) continue;
        mark("bus_to_bus_conflict", "error", canonical.pos, "Buses are graphically connected but share no bus members", [canonical.it.id, v.it.id], [refOf(canonical), refOf(v)]);
        break;
      }
    }
  }
  // BusEntryConflicts: from the entry's side, one report per entry
  if (opts.netOfItem) {
    const seen = new Set<number>();
    for (const [e, b] of busLinks) {
      if (seen.has(e) || verts[b].kind !== "bus") continue;
      const signal = opts.netOfItem(verts[e].it.id), bundle = opts.netOfItem(verts[b].it.id);
      if (!signal || !bundle || signal.bus || !bundle.bus) continue;
      seen.add(e);
      if (signal.prio >= 6 || bundle.members.includes(signal.name)) continue;
      mark("net_not_bus_member", "warning", verts[e].pos, `Net ${unescapeText(signal.name)} is graphically connected to bus ${unescapeText(bundle.name)} but is not a member of that bus`, [verts[e].it.id, verts[b].it.id], [refOf(verts[e]), refOf(verts[b])]);
    }
  }
  // WiredImplicitPowerPins: per pin contact, the first hidden power input of an ordinary symbol on an island with a wire
  const wired = new Set<number>();
  for (const [r, members] of islands) if (members.some((i) => verts[i].kind === "wire")) wired.add(r);
  verts.forEach((v, i) => {
    if (v.kind !== "pin" || v.power || !wired.has(find(i))) return;
    const pin = v.pins!.find((q) => q.hidden && q.type === "power_in"); if (!pin) return;
    mark("wired_implicit_power", "warning", [pin.x, pin.y], "Wired hidden power input pin also connects globally by name", [v.it.id], [pinRef({ item: v.it, p: [pin.x, pin.y], net: "wire", pin })]);
  });
}
