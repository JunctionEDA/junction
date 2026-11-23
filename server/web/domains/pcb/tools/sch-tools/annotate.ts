import type { SAtom, SchCtx } from "./types";
import * as VM from "../../canvas/variant-model";
import { root } from "../root";
import { symbolLibId } from "./autoplace";
import { refField, setReference, unannotated } from "./clipboard";
import { carried, editable, selectedItems } from "./commands";
import { promptImpl } from "./dom";
import { switchTool } from "./junction";
import { fontNode } from "./nodes";
import { anchorOf, cloneNode } from "./orient";
import { K, S, atOf, kid, kids, num, str, uuidOf } from "./state";
import { deep, ghost, modChange, replaceKid, itemSexpr, typeNameFor } from "./util";

// ---------------------------------------------------------------- annotation (annotate.cpp, sch_reference_list.cpp)
/** StrNumCmp( a, b, aCaseSensitivity ): runs of digits compare by value. */
export function strNumCmp(a: string, b: string, ignoreCase: boolean): number {
  let i = 0, j = 0; const dig = (c: string): boolean => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1 = a[i], c2 = b[j];
    if (dig(c1) && dig(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && dig(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && dig(b[j]));
      if (n1 < n2) return -1; if (n1 > n2) return 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (ignoreCase) { if (c1 !== c2) { const u1 = c1.toUpperCase(), u2 = c2.toUpperCase(); if (u1 !== u2) return u1 < u2 ? -1 : 1; } }
    else { if (c1 < c2) return -1; if (c1 > c2) return 1; }
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  if (i >= a.length && j < b.length) return -1;
  if (i < a.length && j >= b.length) return 1;
  return 0;
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** SCH_REFERENCE::CompareRef: the natural order ignoring case, then the plain one. */
export const compareRef = (a: string, b: string): number => strNumCmp(a, b, true) || cmp(a, b);
/** SCH_REFERENCE::CompareValue: the natural order with case, then the plain one. */
const compareValue = (a: string, b: string): number => strNumCmp(a, b, false) || cmp(a, b);
/** UTIL::GetRefDesPrefix / GetRefDesUnannotated: the reference without its trailing digits and question marks. */
export const refDesPrefix = (ref: string): string => str(ref).replace(/[0-9?]+$/, "");
export const refDesUnannotated = (ref: string): string => refDesPrefix(ref) + "?";

/** SCH_REFERENCE::Split: "R12" is R and 12, "R?" and "XYZ" are new; the number keeps its text ("R01" stays "01"). */
export function splitRef(ref: SAtom) {
  const r = { ref: str(ref), numRef: -1, numRefStr: "", isNew: false }; splitInto(r);
  return { prefix: r.ref, num: r.numRef, numStr: r.numRefStr, isNew: r.isNew };
}
function splitInto(r: { ref: string; numRef: number; numRefStr: string; isNew: boolean }): void {
  let text = r.ref; r.numRef = -1; r.numRefStr = "";
  let ll = text.length - 1;
  const digit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  if (ll < 0) { r.isNew = true; return; }
  if (text[ll] === "?") { r.isNew = true; r.ref = text.slice(0, ll); return; }
  if (!digit(text[ll])) { r.isNew = true; return; }
  while (ll >= 0) {
    if (text[ll] <= " " || digit(text[ll])) { ll--; continue; }
    if (digit(text[ll + 1])) r.numRef = atoi(text.slice(ll + 1));
    r.numRefStr = text.slice(ll + 1); text = text.slice(0, ll + 1);
    break;
  }
  r.ref = text;
}

/** One sheet instance of the hierarchy (a SCH_SHEET_PATH): the file's document, the instance path its symbols record and its page. */
export interface AnnSheet {
  doc: KDoc;
  /** "/<root uuid>/<sheet uuid>…"; null when the hierarchy is not known (every instance entry is then the sheet's) */
  path: string | null;
  /** SCH_SHEET_PATH::GetPageNumberAsInt: the page number, else the virtual one */
  page: number;
  /** the instance the document shows (its references go to the Reference field too: UpdateAllScreenReferences) */
  shown?: boolean;
  /** the project the instance entries are written under */
  project?: string | null;
  file?: string; human?: string;
}
/** REFDES_TRACKER: the designators ever handed out, and whether one that is no longer in use may be given again. */
export interface RefTracker { reuse: boolean; used: Set<string> }
/** A SCH_REFERENCE: one symbol on one sheet instance. */
export interface SchRef {
  sheet: AnnSheet | null; item: KItem | null;
  /** the whole reference until split, then its prefix */
  ref: string; numRef: number; numRefStr: string; isNew: boolean; flag: number;
  unit: number; value: string; lib: string | null; sheetNum: number; x: number; y: number; uuid: string;
  /** LIB_SYMBOL::GetUnitCount (0: no library symbol) and IsPower */
  units: number; power: boolean; libNode: SNode | null;
  /** SCH_REFERENCE::m_refSuffix (SCHEMATIC::GetPackageRefSuffix): the sheet suffix the board reference composes with, when the project numbers reused sheets with suffixes */
  suffix?: string;
}
const valueField = (node: SNode): string => { const p = kids(node, "property").find((q) => str(q[1]) === "Value"); return p ? str(p[2]) : ""; };
const instPaths = (node: SNode): SNode[] => { const out: SNode[] = []; for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) out.push(...kids(pr, "path")); return out; };
/** The symbol's instance entry on a sheet path (m_instancePathIndex.find). */
export function instanceOn(node: SNode, path: string | null): SNode | null {
  if (!path) return null;
  return instPaths(node).find((e) => str(e[1]) === path) || null;
}
/** SCH_SYMBOL::GetRef( sheet ): the instance's reference, else the Reference field, else the unannotated prefix. */
export function refOn(node: SNode, path: string | null): string {
  const e = instanceOn(node, path), r = e ? kid(e, "reference") : null;
  let ref = r ? str(r[1]) : "";
  if (!ref) { const p = refField(node); ref = p ? str(p[2]) : ""; }
  return ref || "U?";
}
/** SCH_SYMBOL::GetUnitSelection( sheet ): the instance's unit, else the symbol's own. */
export function unitOn(node: SNode, path: string | null): number {
  const e = instanceOn(node, path), u = e ? kid(e, "unit") : null, own = kid(node, "unit");
  return u ? num(u[1], 1) : own ? num(own[1], 1) : 1;
}
/** SCH_SYMBOL::IsAnnotated( sheet ): the path has an instance whose reference does not end in '?'. */
function annotatedOn(node: SNode, path: string | null): boolean {
  if (!path) { const p = refField(node), r = p ? str(p[2]) : ""; return !!r && !r.endsWith("?"); }
  const e = instanceOn(node, path), r = e && kid(e, "reference") ? str(kid(e, "reference")![1]) : "";
  return !!r && !r.endsWith("?");
}
/**
 * SCH_SYMBOL::SetRef( sheet, ref ) and SetUnitSelection( sheet, unit ) on a copy being edited: the path's instance
 * entry (added when the symbol has none), and for the instance on screen the Reference field and (unit) as well.
 * Without a known path every entry and the field take the reference, as a file with one sheet path has it.
 */
export function setInstanceOn(node: SNode, sheet: Pick<AnnSheet, "path" | "shown" | "project">, ref: string | null, unit?: number | null): void {
  if (!sheet.path) {
    if (ref !== null) setReference(node, ref);
    if (unit !== null && unit !== undefined) { replaceKid(node, ["unit", unit]); for (const e of instPaths(node)) { const u = kid(e, "unit"); if (u) u[1] = unit; } }
    return;
  }
  let e = instanceOn(node, sheet.path);
  if (!e) {
    let inst = kid(node, "instances"); if (!inst) { inst = ["instances"]; node.push(inst); }
    const name = sheet.project || (kids(inst, "project")[0] ? str(kids(inst, "project")[0][1]) : "");
    let pr = kids(inst, "project").find((x) => str(x[1]) === name);
    if (!pr) { pr = K.parse(`(project ${JSON.stringify(name)})`) as SNode; inst.push(pr); }
    e = K.parse(`(path ${JSON.stringify(sheet.path)} (reference ${JSON.stringify(ref !== null ? ref : refOn(node, null))}) (unit ${unit !== null && unit !== undefined ? unit : unitOn(node, null)}))`) as SNode;
    pr.push(e);
  } else {
    if (ref !== null) { const r = kid(e, "reference"); if (r) r[1] = ref; else e.splice(2, 0, K.parse(`(reference ${JSON.stringify(ref)})`) as SNode); }
    if (unit !== null && unit !== undefined) { const u = kid(e, "unit"); if (u) u[1] = unit; else e.push(["unit", unit]); }
  }
  if (sheet.shown) {
    if (ref !== null) { const p = refField(node); if (p) p[2] = ref; }
    if (unit !== null && unit !== undefined) replaceKid(node, ["unit", unit]);
  }
}
/** The sheet a document's own commands work on: the instance on screen (KDoc.instancePath) when the editor knows it. */
export function sheetOf(doc: KDoc, page?: number): AnnSheet {
  const pg = parseInt(String((doc as KDoc & { pageNumber?: string }).pageNumber || ""), 10);
  return { doc, path: doc.instancePath || null, page: page || (pg > 0 ? pg : 1), shown: true };
}
/** matchesSymbolFilter's pseudo symbol: a power symbol, or (legacy libraries) a reference starting with '#'. */
function isPseudo(lib: SNode | null, ref: string): boolean { return (!!lib && !!kid(lib, "power")) || ref[0] === "#"; }
/** SCH_REFERENCE( symbol, sheetPath ). */
export function schReference(sheet: AnnSheet, item: KItem): SchRef {
  const n = item.node, lib = (K.resolveLib(sheet.doc, symbolLibId(n)) as SNode | null) || null, [x, y] = atOf(n);
  return { sheet, item, ref: refOn(n, sheet.path), numRef: -1, numRefStr: "", isNew: false, flag: 0, unit: unitOn(n, sheet.path), value: valueField(n) || "~",
    lib: symbolLibId(n), sheetNum: sheet.page, x: Math.round(x * 1e4), y: Math.round(y * 1e4), uuid: item.id, units: lib ? libUnits(sheet.doc, n).units : 0, power: !!lib && !!kid(lib, "power"), libNode: lib };
}
/**
 * SCH_SHEET_PATH::GetSymbols( refs, SYMBOL_FILTER_NON_POWER, aForceIncludeOrphanSymbols ): the sheet's symbols that
 * are not power or '#' symbols, the ones without a library symbol only when asked for.
 */
export function sheetReferences(sheet: AnnSheet, only?: Set<string> | null, orphans = false): SchRef[] {
  const out: SchRef[] = [];
  for (const it of sheet.doc.items.values()) {
    if (it.kind !== "symbol" || (only && !only.has(it.id))) continue;
    const r = schReference(sheet, it);
    if (isPseudo(r.libNode, r.ref)) continue;
    if (!r.libNode && !orphans) continue;
    out.push(r);
  }
  return out;
}
const sameInstance = (a: SchRef, b: SchRef): boolean => a.uuid === b.uuid && a.sheet === b.sheet && !!a.item;
/** SCH_REFERENCE::formatRefStr: a power symbol's number is written 0nnn. */
const formatRefStr = (r: SchRef, n: number): string => (r.power ? "0" + n : String(n));
const refNumber = (r: SchRef): string => (r.numRef < 0 ? "?" : r.numRefStr);
/** buildFullReference: "U1..2". */
const fullReference = (r: SchRef, unit = -1): string => r.ref + refNumber(r) + ".." + (unit < 0 ? r.unit : unit);
const sortX = (a: SchRef, b: SchRef): number => compareRef(a.ref, b.ref) || a.sheetNum - b.sheetNum || a.x - b.x || a.y - b.y || cmp(a.uuid, b.uuid);
const sortY = (a: SchRef, b: SchRef): number => compareRef(a.ref, b.ref) || a.sheetNum - b.sheetNum || a.y - b.y || a.x - b.x || cmp(a.uuid, b.uuid);

/** REFDES_TRACKER::areUnitsAvailable. */
function unitsAvailable(ref: SchRef, holders: SchRef[], units: number[]): boolean {
  for (const unit of units) for (const h of holders) if (h.lib === null || h.lib !== ref.lib || compareValue(h.value, ref.value) !== 0 || h.unit === unit) return false;
  return true;
}
/**
 * SCH_REFERENCE_LIST::FindFirstUnusedReference with REFDES_TRACKER::GetNextRefDesForUnits: the first number from
 * `min` that no annotated reference of the prefix holds (and, unless designators are reused, that was never handed
 * out), or one whose holders are the same library symbol and value and leave every unit of `units` free.
 */
export function firstUnusedReference(list: SchRef[], ref: SchRef, min: number, units: number[], tracker?: RefTracker | null): number {
  const map = new Map<number, SchRef[]>();
  const needUnits = units.some((u) => u >= 0);
  for (const r of list) {
    if (compareRef(r.ref, ref.ref) !== 0 || r.isNew) continue;
    let l = map.get(r.numRef); if (!l) { l = []; map.set(r.numRef, l); }
    if (needUnits) l.push(r);
  }
  const valid = units.filter((u) => u >= 0);
  for (let candidate = min; ; candidate++) {
    const holders = map.get(candidate);
    if (!holders) {
      const des = ref.ref + String(candidate);
      if (!tracker || tracker.reuse || !tracker.used.has(des)) { if (tracker) tracker.used.add(des); return candidate; }
      continue;
    }
    if (!valid.length) continue;
    if (unitsAvailable(ref, holders, valid)) return candidate;
  }
}
/** REFDES_TRACKER::parseRefDes: the prefix and the trailing number (0 for a prefix on its own). */
function parseRefDes(des: string): [string, number] {
  let pos = des.length; while (pos > 0 && des[pos - 1] >= "0" && des[pos - 1] <= "9") pos--;
  if (pos === 0 || pos === des.length) return [des, 0];
  const n = Number(des.slice(pos)); if (!Number.isSafeInteger(n) || n > 0x7FFFFFFF) return [des, 0];
  return [des.slice(0, pos), n];
}
/** REFDES_TRACKER::Serialize: "C1-3,R1,R5-6,U" — each prefix's numbers as ranges, '\\', ',' and '-' of a prefix escaped. */
export function serializeTracker(used: Iterable<string>): string {
  const byPrefix = new Map<string, Set<number>>();
  for (const d of used) { if (!d) continue; const [p, n] = parseRefDes(d); let l = byPrefix.get(p); if (!l) { l = new Set(); byPrefix.set(p, l); } l.add(n); }
  const esc = (t: string): string => t.replace(/[\\,-]/g, (c) => "\\" + c);
  const out: string[] = [];
  for (const prefix of [...byPrefix.keys()].sort()) {
    const all = byPrefix.get(prefix)!, nums = [...all].filter((n) => n > 0).sort((a, b) => a - b), e = esc(prefix);
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(i === j ? e + nums[i] : e + nums[i] + "-" + nums[j]);
      i = j + 1;
    }
    if (all.has(0)) out.push(e);
  }
  return out.join(",");
}
/** REFDES_TRACKER::Deserialize: the designators of a "used_designators" string; a malformed one gives none. */
export function deserializeTracker(data: string): Set<string> {
  const used = new Set<string>(); if (!data) return used;
  const parts: string[] = []; let cur = "", escaped = false;
  for (const c of data) {
    if (escaped) { cur += c; escaped = false; }
    else if (c === "\\") { escaped = true; cur += c; }
    else if (c === ",") { parts.push(cur); cur = ""; }
    else cur += c;
  }
  if (cur) parts.push(cur);
  const unesc = (t: string): string => { let r = "", e = false; for (const c of t) { if (e) { r += c; e = false; } else if (c === "\\") e = true; else r += c; } return r; };
  const positive = (t: string): number => { const n = Number(t); return Number.isSafeInteger(n) && n > 0 && n <= 0x7FFFFFFF ? n : 0; };
  for (const part of parts) {
    const u = unesc(part); let m: RegExpExecArray | null;
    if ((m = /^([\s\S]*\D)(\d+)-(\d+)$/.exec(u))) {
      const a = positive(m[2]), b = positive(m[3]); if (!a || !b) return new Set();
      for (let i = a; i <= b; i++) used.add(m[1] + i);
    } else if ((m = /^([\s\S]*\D)(\d+)$/.exec(u))) {
      const a = positive(m[2]); if (!a) return new Set();
      used.add(m[1] + a);
    } else if (u.length) used.add(u);
    else return new Set();
  }
  return used;
}
/**
 * The first number a new symbol's reference may take (SCH_REFERENCE_LIST::Annotate's minRefId from the project's
 * annotation settings): annotate_start_num + 1, or with "sheet number X 100 / 1000" the sheet's page times that, + 1.
 */
export function newSymbolMinRef(page: number): number {
  const a = S.annotation; if (!a) return 1;
  return a.method === 1 ? page * 100 + 1 : a.method === 2 ? page * 1000 + 1 : (a.startNum | 0) + 1;
}
/** SCH_REFERENCE_LIST::GetPackageUnits. */
function packageUnits(locked: SchRef[], ref: SchRef): number[] {
  const units = new Set<number>([ref.unit]);
  for (const r of locked) if (compareValue(r.value, ref.value) === 0 && r.lib === ref.lib) units.add(r.unit);
  return [...units].sort((a, b) => a - b);
}
export interface AnnotateListOpts { order?: string; sheetInterval?: number; start?: number; startAtCurrent?: boolean; tracker?: RefTracker | null }
/**
 * SCH_REFERENCE_LIST::AnnotateByOptions / Annotate over split references: `list` is sorted (prefix, sheet number,
 * position) and every new reference numbered; `locked` holds the multi-unit packages that stay together (whole
 * reference -> its units) and `additional` the references outside the list that must not be duplicated.
 */
export function annotateList(list: SchRef[], locked: Map<string, SchRef[]>, additional: SchRef[], o: AnnotateListOpts): void {
  if (o.order === "y") list.sort(sortY); else if (o.order !== "unsorted") list.sort(sortX);
  const interval = o.sheetInterval! | 0, useSheetNum = interval > 0, start = o.start! | 0;
  const startAtCurrent = !!o.startAtCurrent && !useSheetNum;   // "Not implemented for sheet # * 100"
  if (!list.length) return;
  const originalSize = list.length, inUse = new Set<string>();
  for (const a of additional) {
    const c: SchRef = Object.assign({}, a); splitInto(c);
    if (!c.isNew) inUse.add(fullReference(c));
    c.isNew = false; list.push(c);
  }
  // which locked package each instance belongs to (the first one in the map's order)
  const lockedOf = new Map<string, SchRef[]>(), ikey = (r: SchRef) => r.uuid + "\0" + (r.sheet ? r.sheet.path || "" : "");
  for (const key of [...locked.keys()].sort()) for (const r of locked.get(key)!) if (!lockedOf.has(ikey(r))) lockedOf.set(ikey(r), locked.get(key)!);
  let first = 0, minRefId = useSheetNum ? list[first].sheetNum * interval + 1 : start + 1, last = 0;
  for (let ii = 0; ii < list.length; ii++) {
    const ru = list[ii];
    if (ru.flag) continue;
    const lockedList = ru.item ? lockedOf.get(ikey(ru)) || null : null;
    if (compareRef(list[first].ref, ru.ref) !== 0 || (useSheetNum && list[first].sheetNum !== ru.sheetNum)) {
      first = ii;
      minRefId = useSheetNum ? ru.sheetNum * interval + 1 : start + 1;
    }
    if (startAtCurrent && ru.numRef > 0) minRefId = ru.numRef;
    if (ru.units <= 1) {   // one part per package (trivial case)
      if (ru.isNew) { last = firstUnusedReference(list, ru, minRefId, [], o.tracker); ru.numRef = last; ru.numRefStr = formatRefStr(ru, last); }
      ru.flag = 1; ru.isNew = false;
      continue;
    }
    if (lockedList) {
      const units = packageUnits(lockedList, ru);
      if (ru.isNew) { last = firstUnusedReference(list, ru, minRefId, units, o.tracker); ru.numRef = last; ru.numRefStr = formatRefStr(ru, last); ru.isNew = false; ru.flag = 1; }
      for (const lr of lockedList) {
        if (sameInstance(lr, ru)) { ru.unit = lr.unit; inUse.add(fullReference(ru)); }
        if (compareValue(lr.value, ru.value) !== 0) continue;
        if (lr.lib !== ru.lib) continue;
        for (let jj = ii + 1; jj < list.length; jj++) {
          if (!sameInstance(lr, list[jj])) continue;
          if (compareRef(list[jj].ref, ru.ref) !== 0) continue;
          const candidate = fullReference(ru, lr.unit);
          // not allocated twice: the previous annotation may hold duplicates
          if (!inUse.has(candidate)) { list[jj].numRef = ru.numRef; list[jj].numRefStr = ru.numRefStr; list[jj].isNew = false; list[jj].flag = 1; inUse.add(candidate); break; }
        }
      }
    } else if (ru.isNew) {
      // a unit not annotated yet: the first number that leaves this unit free; its package forms in the later passes
      last = firstUnusedReference(list, ru, minRefId, [ru.unit], o.tracker);
      ru.numRef = last; ru.numRefStr = formatRefStr(ru, last); ru.isNew = false; ru.flag = 1;
    }
  }
  list.length = originalSize;
}
/** SCH_SHEET_PATH::AppendMultiUnitSymbol over references: the annotated units of multi-unit symbols by whole reference. */
export function multiUnitMap(refs: SchRef[]): Map<string, SchRef[]> {
  const m = new Map<string, SchRef[]>();
  for (const r of refs) {
    if (r.units <= 1 || r.ref.endsWith("?")) continue;
    let l = m.get(r.ref); if (!l) { l = []; m.set(r.ref, l); }
    l.push(Object.assign({}, r));
  }
  return m;
}
/** The reference a SCH_REFERENCE writes (SCH_REFERENCE::Annotate). */
const annotatedRef = (r: SchRef): string => (r.numRef < 0 ? r.ref + "?" : r.ref + refNumber(r));
/** SCH_SYMBOL::SubReference( unit, addSeparator ) of a placed symbol. */
export function subReference(doc: KDoc, node: SNode, unit: number, addSeparator = true): string {
  return K.subReference(K.resolveLib(doc, symbolLibId(node)), unit, addSeparator);
}
/** GetValue( sheet, FOR_GUI ): the Value with the symbol's own ${FIELD} references resolved. */
function shownValue(node: SNode, ref: string): string {
  const v = valueField(node); if (v.indexOf("${") < 0) return v;
  return v.replace(/\$\{([^{}]+)\}/g, (m, tok: string) => {
    const up = tok.toUpperCase(); if (up === "REFERENCE") return ref; if (up === "VALUE") return m;
    const f = kids(node, "property").find((q) => str(q[1]).toUpperCase() === up); return f ? str(f[2]) : m;
  });
}

export type AnnotationErrorCode = "unannotated" | "extra_units" | "duplicate_reference" | "different_unit_value";
/**
 * SCH_REFERENCE_LIST::CheckAnnotation: the references sorted by reference and value, then "Item not annotated",
 * "Error: symbol … exceeds units defined", "Duplicate items", "Differing unit counts" and "Different values".
 * Returns the number of errors; `handler` gets each message with the one or two references involved.
 */
export function checkAnnotation(list: SchRef[], handler: (code: AnnotationErrorCode, msg: string, a: SchRef, b: SchRef | null) => void): number {
  let error = 0;
  list.sort((a, b) => compareRef(a.ref, b.ref) || compareValue(a.value, b.value) || a.unit - b.unit || a.sheetNum - b.sheetNum || a.x - b.x || a.y - b.y || cmp(a.uuid, b.uuid));
  for (const r of list) splitInto(r);
  const sub = (r: SchRef, unit: number): string => (r.item && r.sheet ? subReference(r.sheet.doc, r.item.node, unit) : K.subReference(null, unit));
  const numText = (r: SchRef): string => (r.numRef >= 0 ? r.numRefStr : "?");
  for (const r of list) {
    if (r.isNew) {   // not yet annotated
      const tmp = numText(r);
      const msg = r.unit > 0 && r.unit < 0x7FFFFFFF && r.libNode && r.units > 1 ? `Item not annotated: ${r.ref}${tmp} (unit ${r.unit})` : `Item not annotated: ${r.ref}${tmp}`;
      handler("unannotated", msg, r, null); error++;
      break;
    }
    // the unit selected does not exist: the library symbol changed after a previous annotation
    if (r.libNode && Math.max(r.units, 1) < r.unit) {
      handler("extra_units", `Error: symbol ${r.ref}${numText(r)}${sub(r, r.unit)} (unit ${r.unit}) exceeds units defined (${r.units})`, r, null); error++;
      break;
    }
  }
  // GetRefSuffix: empty unless hasRef() (split: not new and numbered)
  const sfx = (r: SchRef): string => (r.isNew || r.numRef < 0 ? "" : r.suffix || "");
  const sameBase = (a: SchRef, b: SchRef): boolean => compareRef(a.ref, b.ref) === 0 && a.numRef === b.numRef && sfx(a) === sfx(b);
  const checkPackage = (first: SchRef, second: SchRef): void => {
    if (first.unit === second.unit) {   // same reference, same unit
      handler("duplicate_reference", `Duplicate items ${first.ref}${numText(first)}${first.libNode && first.units > 1 ? sub(first, first.unit) : ""}${sfx(first)}\n`, first, second); error++;
      return;
    }
    // units differ but the parts per package do not agree (U3 with one part and a U3B)
    if (first.libNode && second.libNode && first.units !== second.units) {
      handler("duplicate_reference", `Differing unit counts for item ${first.ref}${numText(first)}${sub(first, first.unit)}${sfx(first)} and ${second.ref}${numText(second)}${sub(first, second.unit)}${sfx(second)}\n`, first, second); error++;
      return;
    }
    if (compareValue(first.value, second.value) !== 0) {
      handler("different_unit_value", `Different values for ${first.ref}${first.numRef}${sub(first, first.unit)}${sfx(first)} (${first.value}) and ${second.ref}${second.numRef}${sub(first, second.unit)}${sfx(second)} (${second.value})`, first, second); error++;
    }
  };
  for (let ii = 1; ii < list.length; ii++) if (sameBase(list[ii - 1], list[ii])) checkPackage(list[ii - 1], list[ii]);
  // different base and number splits can identify the same complete package reference
  const composed = new Map<string, Map<number, SchRef>>();
  for (const r of list) {
    if (r.isNew) continue;
    const key = r.ref + r.numRefStr + sfx(r); let units = composed.get(key); if (!units) { units = new Map(); composed.set(key, units); }
    let first = units.get(r.unit);
    if (!first && units.size) first = units.get(Math.min(...units.keys()));
    if (first && !sameBase(first, r)) checkPackage(first, r);
    if (!units.has(r.unit)) units.set(r.unit, r);
  }
  return error;
}

/** ANNOTATE_SCOPE_T with the sheets it takes in: every sheet, or some (the current one, the ones below it, selected ones). */
export interface AnnotateScope { all: boolean; sheets: { sheet: AnnSheet; only?: Set<string> | null }[] }
// opts: { order: "x" | "y", keep: true (incremental) | false (renumber everything), start: 0, sheetInterval: 0 | 100 | 1000, sheetNumber: 1, only: Set of ids,
//         reserved: references in use on sheets the caller could not hand over as documents }
/** Annotation options (see annotateChanges). */
export interface AnnotateOpts { order?: string; keep?: boolean; /** reset only: multi-unit symbols are not kept in their old packages */ regroup?: boolean; start?: number; sheetInterval?: number; sheetNumber?: number; only?: Set<string> | null; reserved?: Iterable<string>; tracker?: RefTracker | null }
export interface AnnotateResult {
  /** the changes of each document, in the order its symbols were annotated */
  changes: Map<KDoc, KChange[]>;
  /** AnnotateSymbols' report: "Annotated %s as %s." / "Updated %s from %s to %s." */
  messages: string[];
  /** CheckAnnotate's errors over the scope after the annotation */
  errors: string[];
}
/** A reference held somewhere the caller has no document for: it blocks its number outright. */
function foreignRef(ref: string): SchRef {
  return { sheet: null, item: null, ref, numRef: -1, numRefStr: "", isNew: false, flag: 0, unit: -1, value: "", lib: null, sheetNum: 0, x: 0, y: 0, uuid: "", units: 1, power: false, libNode: null };
}
/**
 * SCH_EDIT_FRAME::AnnotateSymbols over the hierarchy `sheets` (every sheet instance, in page order): the references
 * in `scope` are numbered — each (symbol, sheet path) pair on its own, so a file used twice gets two sets — against
 * the rest of the hierarchy, the result written to the path's instance entry.  Power and '#' symbols are left alone
 * (SYMBOL_FILTER_NON_POWER).  The documents are not touched: the changes come back per document, with the report.
 */
export function annotateHierarchy(sheets: AnnSheet[], scope: AnnotateScope, opts?: AnnotateOpts | null): AnnotateResult {
  const o = opts || {}, reset = o.keep === false, regroup = reset && !!o.regroup;
  const refs: SchRef[] = []; for (const s of scope.sheets) refs.push(...sheetReferences(s.sheet, s.only));
  // the units that are annotated together; a regroup lets them group afresh by placement
  let locked = regroup ? new Map<string, SchRef[]>() : multiUnitMap(refs);
  // mapExistingAnnotation: what every symbol of the hierarchy was called
  const prevOf = new Map<SchRef["item"], Map<AnnSheet, string>>();
  const allRefs: SchRef[] = []; for (const s of sheets) allRefs.push(...sheetReferences(s));
  for (const r of allRefs) {
    if (!annotatedOn(r.item!.node, r.sheet!.path)) continue;
    let m = prevOf.get(r.item); if (!m) { m = new Map(); prevOf.set(r.item, m); }
    m.set(r.sheet!, r.units > 1 ? r.ref + subReference(r.sheet!.doc, r.item!.node, r.unit) : r.ref);
  }
  // AnnotateReferences: a group holding one unit twice gets fresh assignments when resetting
  if (reset) for (const [k, l] of [...locked]) { const seen = new Set<number>(); if (l.some((r) => seen.has(r.unit) || (seen.add(r.unit), false))) locked.delete(k); }
  if (reset) for (const r of refs) r.isNew = true;
  // the references of the rest of the hierarchy must not be duplicated (none when the whole schematic is annotated)
  const additional: SchRef[] = [];
  if (!scope.all) for (const r of allRefs) if (!refs.some((x) => sameInstance(x, r))) additional.push(r);
  for (const ref of o.reserved || []) additional.push(foreignRef(str(ref)));
  for (const r of refs) splitInto(r);
  annotateList(refs, locked, additional, { order: o.order === "y" ? "y" : "x", sheetInterval: o.sheetInterval, start: o.start, tracker: o.tracker });
  // SCH_REFERENCE::Annotate on copies of the nodes; a symbol of a shared sheet takes one entry per path
  const nodes = new Map<KItem, SNode>(), order: KItem[] = [], messages: string[] = [];
  for (const r of refs) {
    const it = r.item!, sh = r.sheet!;
    let node = nodes.get(it); if (!node) { node = deep(it.node); nodes.set(it, node); order.push(it); }
    const ref = annotatedRef(r);
    setInstanceOn(node, sh, ref, r.unit);
    const multi = r.units > 1, sub = multi ? subReference(sh.doc, it.node, r.unit, false) : "";
    const newRef = multi ? ref + subReference(sh.doc, it.node, r.unit) : ref, prev = (prevOf.get(it) || new Map<AnnSheet, string>()).get(sh) || "";
    const val = shownValue(it.node, ref);
    if (prev) {
      if (newRef === prev) continue;
      messages.push(multi ? `Updated ${val} (unit ${sub}) from ${prev} to ${newRef}.` : `Updated ${val} from ${prev} to ${newRef}.`);
    } else messages.push(multi ? `Annotated ${val} (unit ${sub}) as ${newRef}.` : `Annotated ${val} as ${newRef}.`);
  }
  const changes = new Map<KDoc, KChange[]>(), docOf = new Map<KItem, KDoc>();
  for (const r of refs) docOf.set(r.item!, r.sheet!.doc);
  for (const it of order) {
    const node = nodes.get(it)!; if (K.serialize(node) === K.serialize(it.node)) continue;
    const doc = docOf.get(it)!; let l = changes.get(doc); if (!l) { l = []; changes.set(doc, l); }
    l.push(modChange(doc, it, node));
  }
  // CheckAnnotate over the same scope, on what the symbols are called now (symbols without a library symbol too)
  const check: SchRef[] = refs.map((r) => Object.assign({}, r, { ref: annotatedRef(r), isNew: false, flag: 0, numRef: -1, numRefStr: "" }));
  for (const s of scope.sheets) for (const r of sheetReferences(s.sheet, s.only, true)) if (!r.libNode) check.push(r);
  const errors: string[] = [];
  if (check.length) checkAnnotation(check, (_c, msg) => { errors.push(msg); });
  return { changes, messages, errors };
}
/** One sheet annotated on its own (the tool action, a test): annotateHierarchy over the document's sheet instance. */
export function annotateChanges(doc: KDoc, opts?: AnnotateOpts | null) {
  const o = opts || {}, sheet = sheetOf(doc, o.sheetNumber);
  const r = annotateHierarchy([sheet], { all: false, sheets: [{ sheet, only: o.only || null }] }, o);
  return r.changes.get(doc) || [];
}
/**
 * SCH_EDITOR_CONTROL::IncrementAnnotations on one sheet: every symbol (power symbols too, SYMBOL_FILTER_ALL) whose
 * reference has the start reference's prefix and a number at least the start's moves up by `by`.  A start reference
 * without a number (SCH_REFERENCE::IsSplitNeeded false) changes nothing.
 */
/** SCH_REFERENCE::Split: the prefix and the number text ("R?" and "R" are "R" and ""; "U 12" is "U" and " 12"). */
export function splitReference(ref: string): { prefix: string; num: string } {
  if (!ref) return { prefix: ref, num: "" };
  const last = ref[ref.length - 1];
  if (last === "?") return { prefix: ref.slice(0, -1), num: "" };
  if (!/[0-9]/.test(last)) return { prefix: ref, num: "" };
  for (let ll = ref.length - 1; ll >= 0; ll--) {
    const c = ref[ll];
    if (c <= " " || /[0-9]/.test(c)) continue;
    return { prefix: ref.slice(0, ll + 1), num: ref.slice(ll + 1) };
  }
  return { prefix: ref, num: "" };
}
/** atoi: leading blanks, a sign and digits; anything else is 0. */
function atoi(t: string): number { const n = parseInt(t, 10); return isFinite(n) ? n : 0; }
/**
 * SCH_EDITOR_CONTROL::IncrementAnnotations: a start reference that IsSplitNeeded (ends in a digit or "?") gives the
 * prefix and the first number (atoi, so "R?" starts at 0 and takes the unannotated ones too); every symbol whose
 * split reference has that prefix and a number at or above it moves up by `by`.
 */
export function incrementAnnotationChanges(doc: KDoc, start: string, by: number): KChange[] {
  const st = str(start); if (!st || !/[?0-9]$/.test(st)) return [];
  const s0 = splitReference(st), prefix = s0.prefix, from = atoi(s0.num), changes: KChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const rf = refField(it.node); if (!rf) continue;
    const r = splitReference(str(rf[2])); if (r.prefix !== prefix) continue;
    const num = atoi(r.num); if (num < from) continue;
    const node = deep(it.node); setReference(node, prefix + String(num + by)); changes.push(modChange(doc, it, node));
  }
  return changes;
}
/**
 * SCH_EDIT_FRAME::AnnotateSymbols' and DeleteAnnotation's report lines for the changes of one sheet (read before they
 * are applied): "Annotated %s as %s." / "Updated %s from %s to %s." (with " (unit %s)" for a multi-unit symbol) and
 * "Cleared annotation for %s." — the symbol named by its shown value, the unit by SubReference( unit, false ).
 */
export function annotateMessages(doc: KDoc, changes: KChange[], clear = false, sheet: AnnSheet = sheetOf(doc)): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const it = doc.items.get(c.id as string); if (!it || it.kind !== "symbol") continue;
    const prev = refOn(it.node, sheet.path), annotated = annotatedOn(it.node, sheet.path);
    const multi = libUnits(doc, it.node).units > 1, u = unitOn(it.node, sheet.path);
    if (clear) { const val = shownValue(it.node, prev); out.push(multi ? `Cleared annotation for ${val} (unit ${subReference(doc, it.node, u, false)}).` : `Cleared annotation for ${val}.`); continue; }
    const n = typeof c.sexpr === "string" ? K.parseAll(c.sexpr).find((t) => Array.isArray(t) && t[0] !== "lib_symbols") as SNode | undefined : undefined;
    if (!n) continue;
    // GetRef( sheet, true ): a multi-unit symbol's reference carries its unit (mapExistingAnnotation stores it the same way)
    const u1 = unitOn(n, sheet.path), base = refOn(n, sheet.path), val = shownValue(n, base);
    const ref = multi ? base + subReference(doc, it.node, u1) : base, prevRef = multi ? prev + subReference(doc, it.node, u) : prev;
    if (annotated && ref === prevRef) continue;
    const sub1 = multi ? subReference(doc, it.node, u1, false) : "";
    if (annotated) out.push(multi ? `Updated ${val} (unit ${sub1}) from ${prevRef} to ${ref}.` : `Updated ${val} from ${prevRef} to ${ref}.`);
    else out.push(multi ? `Annotated ${val} (unit ${sub1}) as ${ref}.` : `Annotated ${val} as ${ref}.`);
  }
  return out;
}
/**
 * SCH_EDIT_FRAME::DeleteAnnotation on one sheet instance: every symbol annotated on that path (power symbols too)
 * goes back to its prefix and '?' — SCH_SYMBOL::ClearAnnotation( sheet ), the other sheet paths' references stay.
 */
export function clearAnnotationChanges(doc: KDoc, only?: Set<string> | null, sheet: AnnSheet = sheetOf(doc)) {
  const changes: KChange[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol" || (only && !only.has(it.id))) continue;
    if (!annotatedOn(it.node, sheet.path)) continue;
    const node = deep(it.node); setInstanceOn(node, sheet, refDesUnannotated(refOn(it.node, sheet.path))); changes.push(modChange(doc, it, node));
  }
  return changes;
}
/**
 * SCH_EDIT_FRAME::DeleteAnnotation over sheet instances: each (symbol, sheet path) annotated there is cleared and
 * reported; a symbol of a file used by several of the instances takes every clearing in one change.
 */
export function clearAnnotationHierarchy(scope: { sheet: AnnSheet; only?: Set<string> | null }[]): { changes: Map<KDoc, KChange[]>; messages: string[] } {
  const nodes = new Map<KItem, SNode>(), docOf = new Map<KItem, KDoc>(), order: KItem[] = [], messages: string[] = [];
  for (const { sheet, only } of scope) {
    for (const it of sheet.doc.items.values()) {
      if (it.kind !== "symbol" || (only && !only.has(it.id))) continue;
      if (!annotatedOn(it.node, sheet.path)) continue;
      const prev = refOn(it.node, sheet.path), val = shownValue(it.node, prev);
      messages.push(libUnits(sheet.doc, it.node).units > 1 ? `Cleared annotation for ${val} (unit ${subReference(sheet.doc, it.node, unitOn(it.node, sheet.path), false)}).` : `Cleared annotation for ${val}.`);
      let node = nodes.get(it); if (!node) { node = deep(it.node); nodes.set(it, node); docOf.set(it, sheet.doc); order.push(it); }
      setInstanceOn(node, sheet, refDesUnannotated(prev));
    }
  }
  const changes = new Map<KDoc, KChange[]>();
  for (const it of order) { const doc = docOf.get(it)!; let l = changes.get(doc); if (!l) { l = []; changes.set(doc, l); } l.push(modChange(doc, it, nodes.get(it)!)); }
  return { changes, messages };
}
/**
 * SCH_SCREENS::ReplaceDuplicateTimeStamps over the screens `docs` (each file once, in hierarchy order): an item whose
 * uuid an earlier item already has gets a fresh one (removed and added again under it).  Returns the changes per
 * document and how many were replaced ("%d duplicate time stamps were found and replaced.").
 */
export function replaceDuplicateIds(docs: KDoc[]): { changes: Map<KDoc, KChange[]>; count: number } {
  const seen = new Set<string>(), changes = new Map<KDoc, KChange[]>(); let count = 0;
  for (const doc of docs) {
    for (const it of [...doc.items.values()]) {
      if (!seen.has(it.id)) { seen.add(it.id); continue; }
      const node = deep(it.node), u = kid(node, "uuid"); if (!u) continue;   // an item without a uuid of its own (a rule area's sits in its outline)
      const id = K.newUuid(); u[1] = id; seen.add(id); count++;
      let l = changes.get(doc); if (!l) { l = []; changes.set(doc, l); }
      l.push({ id: it.id, kind: "REMOVED", typeName: typeNameFor(it), properties: [] }, { id, kind: "ADDED", typeName: typeNameFor(it), sexpr: itemSexpr(doc, it.kind, node) });
    }
  }
  return { changes, count };
}
/**
 * getInferredSymbols and AnnotateSymbols' addSelectedSheet over a selection: the selected symbols, the symbols inside
 * selected groups (at any depth), and the selected sheets with those inside groups.  A selected Reference field is its
 * symbol (the editor's selection holds the symbol's id for it).
 */
export function inferredSelection(doc: KDoc, ids: Iterable<string>): { symbols: Set<string>; sheets: Set<string> } {
  const symbols = new Set<string>(), sheets = new Set<string>(), seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return; seen.add(id);
    const it = doc.items.get(id); if (!it) return;
    if (it.kind === "symbol") symbols.add(id);
    else if (it.kind === "sheet") sheets.add(id);
    else if (it.kind === "group") { const m = kid(it.node, "members"); if (m) for (const c of m.slice(1)) walk(str(c)); }
  };
  for (const id of ids) walk(id);
  return { symbols, sheets };
}
/** Tools > Annotate on the open sheet (the dialog annotates the hierarchy): one "Annotate" commit, nothing said. */
export function annotate(ctx: SchCtx, opts?: AnnotateOpts | null) {
  if (!editable(ctx)) return false;
  const changes = annotateChanges(ctx.doc, Object.assign({ sheetNumber: ctx.pageNumber, tracker: S.refTracker || null }, opts || {}));
  if (changes.length) ctx.commit(changes, "Annotate");
  return true;
}
export function clearAnnotation(ctx: SchCtx, opts?: { only?: Set<string> | null } | null) {
  if (!editable(ctx)) return false;
  const changes = clearAnnotationChanges(ctx.doc, opts && opts.only);
  if (!changes.length) return true;
  ctx.commit(changes, "Delete Annotation"); return true;
}
export function editFieldPrompt(ctx: SchCtx, name: string, title: string, quiet: boolean) {
  if (!editable(ctx)) return false;
  // PlaceSymbol passes editReference / editValue / editFootprint on to SCH_EDIT_TOOL for the symbol on the cursor
  // (evt->SetPassEvent): the field dialog edits it in place (GetEditFlags() != 0: nothing is staged or committed)
  const cr = carried(ctx);
  if (cr && cr.item.kind !== "symbol") return false;
  const it = cr ? cr.item : selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const p = kids(it.node, "property").find((q) => str(q[1]) === name); const cur = p ? str(p[2]) : "";
  // SCH_EDIT_TOOL::editFieldText: DIALOG_FIELD_PROPERTIES ("Edit Reference Designator Field", …)
  if (p && root.KDialogs && root.KDialogs.schFieldDialog && root.KDialogs.schFieldDialog(ctx, it, name, cr ? { carried: (n: SNode) => cr.write(n) } : undefined)) return true;
  promptImpl(title, cur, S.cursorClient, (text) => {
    if (text === null || text === undefined || text === cur) return;
    const node = deep(it.node);
    if (name === "Reference") setReference(node, text);
    else { let q = kids(node, "property").find((z) => str(z[1]) === name); if (!q) { q = ["property" as SAtom, name, "", ["at", ...atOf(node).slice(0, 2), 0], ["hide", "yes"], ["effects", fontNode(1.27)]]; insertField(node, q); } q[2] = text; }
    if (cr) { if (S.carry && uuidOf(S.carry.node) === it.id) cr.write(node); return; }
    ctx.commit([modChange(ctx.doc, it, node)], name.toLowerCase());
  });
  return true;
}
/**
 * SCH_EDIT_TOOL::Properties on the item being placed: PlaceSymbol passes SCH_ACTIONS::properties on for the symbol on
 * the cursor and TwoClickPlace for the label or text (evt->SetPassEvent, then ACTIONS::refreshPreview).  The item's
 * dialog edits the carried copy (its edit flags are set, so DIALOG_SYMBOL_PROPERTIES / DIALOG_LABEL_PROPERTIES stage
 * nothing) and the placement goes on with what it wrote.  True when the carry took the request.
 */
export const CARRIED_PROPERTY_KINDS = new Set(["symbol", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "text"]);
export function carriedProperties(ctx: SchCtx): boolean {
  const cr = carried(ctx); if (!cr) return false;
  if (!CARRIED_PROPERTY_KINDS.has(cr.item.kind)) return false;
  const dlg = root.KDialogs && root.KDialogs.schItemDialog;
  const id = cr.item.id;
  if (dlg) dlg(ctx, cr.item, { carried: (n: SNode) => { if (S.carry && uuidOf(S.carry.node) === id) { if (!uuidOf(n)) n.push(["uuid", id]); cr.write(n); } } });
  return true;
}
/** LIB_SYMBOL::HasDeMorganBodyStyles / GetBodyStyleCount / GetBodyStyleNames of a library symbol. */
export function libBodyStyles(lib: SNode | null): { demorgan: boolean; count: number; names: string[] } {
  if (!lib) return { demorgan: false, count: 1, names: [] };
  const bs = kid(lib, "body_styles");
  if (bs) {
    const words = bs.slice(1).filter((v) => !Array.isArray(v)).map((v) => str(v as SAtom));
    if (words.includes("demorgan")) return { demorgan: true, count: 2, names: [] };
    return { demorgan: false, count: Math.max(1, words.length), names: words };
  }
  // a library without (body_styles): its "Name_U_2" sub-symbols are De Morgan's alternate (m_demorgan)
  let n = 1; for (const s of kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); if (m) n = Math.max(n, +m[2]); }
  return n > 1 ? { demorgan: true, count: 2, names: [] } : { demorgan: false, count: 1, names: [] };
}
/** SCH_SYMBOL::GetBodyStyleDescription( style, true ). */
export function bodyStyleLabel(lib: SNode | null, style: number): string {
  const b = libBodyStyles(lib);
  if (b.demorgan) return style === 2 ? "Alternate" : style === 1 ? "Standard" : "?";
  return b.count > 1 && style >= 1 && style <= b.names.length ? b.names[style - 1] : "?";
}
/** LIB_SYMBOL::GetUnitDisplayName( unit, false ): the (unit_name …) of the unit, else its letter. */
export function unitLabel(lib: SNode | null, unit: number): string {
  const name = K.unitDisplayNames(lib).get(unit);
  return name !== undefined ? name : K.letterSubReference(unit, 65);
}
/** The one symbol SYMBOL_UNIT_MENU and BODY_STYLE_MENU act on (selection.Front()): the symbol on the cursor, which is the selection while it is placed, else the one selected symbol. */
function menuSymbol(ctx: SchCtx): { item: KItem; write: ((n: SNode) => void) | null } | null {
  const cr = carried(ctx);
  if (cr) return cr.item.kind === "symbol" ? { item: cr.item, write: (n: SNode) => cr.write(n) } : null;
  const sel = selectedItems(ctx); return sel.length === 1 && sel[0].kind === "symbol" ? { item: sel[0], write: null } : null;
}
const libOfSymbol = (doc: KDoc, node: SNode): SNode | null => (K.resolveLib(doc, symbolLibId(node)) as SNode | null) || null;
/** SCH_CONDITIONS::SingleMultiUnitSymbol / SingleMultiBodyStyleSymbol for the menu's symbol (the caller checks the selection holds it alone). */
export function symbolMenuConditions(ctx: SchCtx): { multiUnit: boolean; multiBodyStyle: boolean } {
  const s = menuSymbol(ctx); if (!s) return { multiUnit: false, multiBodyStyle: false };
  const lib = libOfSymbol(ctx.doc, s.item.node); if (!lib) return { multiUnit: false, multiBodyStyle: false };
  return { multiUnit: libUnits(ctx.doc, s.item.node).units >= 2, multiBodyStyle: libBodyStyles(lib).count > 1 };
}
/** One row of SYMBOL_UNIT_MENU / BODY_STYLE_MENU: a unit or body style check item, a separator, or a Place unit entry. */
export interface SymbolMenuRow { sep?: boolean; label?: string; checked?: boolean; unit?: number; place?: number; bodyStyle?: number }
/**
 * SYMBOL_UNIT_MENU::update: every unit of the package as a check item (the symbol's unit ticked), " (already placed)"
 * after the units some symbol of the reference holds (GetUnplacedUnitsForSymbol), then "Place unit %s" for each unit
 * nobody holds.
 */
export function symbolUnitMenu(ctx: SchCtx): SymbolMenuRow[] {
  const s = menuSymbol(ctx); if (!s) return [];
  const lib = libOfSymbol(ctx.doc, s.item.node), n = libUnits(ctx.doc, s.item.node).units;
  const unit = unitOn(s.item.node, sheetOf(ctx.doc).path), missing = new Set(unplacedUnits(ctx.doc, s.item));
  const out: SymbolMenuRow[] = [];
  for (let ii = 0; ii < n && ii <= 676; ii++) out.push({ label: unitLabel(lib, ii + 1) + (missing.has(ii + 1) ? "" : " (already placed)"), checked: unit === ii + 1, unit: ii + 1 });
  if (missing.size) { out.push({ sep: true }); for (const u of [...missing].sort((a, b) => a - b)) out.push({ label: `Place unit ${unitLabel(lib, u)}`, place: u }); }
  return out;
}
/** BODY_STYLE_MENU::update: Standard / Alternate for De Morgan body styles, else the library's names, the symbol's ticked. */
export function bodyStyleMenu(ctx: SchCtx): SymbolMenuRow[] {
  const s = menuSymbol(ctx); if (!s) return [];
  const lib = libOfSymbol(ctx.doc, s.item.node), b = libBodyStyles(lib), bsN = kid(s.item.node, "body_style") || kid(s.item.node, "convert"), cur = bsN ? num(bsN[1], 1) : 1;
  if (b.demorgan) return [{ label: "Standard", checked: cur === 1, bodyStyle: 1 }, { label: "Alternate", checked: cur !== 1, bodyStyle: 2 }];
  if (b.count > 1) { const out: SymbolMenuRow[] = []; for (let i = 0; i < b.count; i++) out.push({ label: bodyStyleLabel(lib, i + 1), checked: cur === i + 1, bodyStyle: i + 1 }); return out; }
  return [];
}
/**
 * A choice from SYMBOL_UNIT_MENU (TA_CHOICE_MENU_CHOICE, ID_POPUP_SCH_SELECT_UNIT…): SCH_EDIT_FRAME::SelectUnit on the
 * selected symbol, or (PlaceSymbol's loop) on the symbol being placed, then refreshPreview.  The carried symbol is not
 * staged (it has edit flags): only a swapped holder is committed, and its fields are autoplaced only then.
 */
export function chooseSymbolUnit(ctx: SchCtx, unit: number): boolean {
  if (!editable(ctx)) return false;
  const s = menuSymbol(ctx); if (!s) return false;
  const count = libUnits(ctx.doc, s.item.node).units, sheet = sheetOf(ctx.doc), cur = unitOn(s.item.node, sheet.path);
  if (count <= 1 || cur === unit) return true;
  const hook = root.CollabEditor && root.CollabEditor.selectUnit;
  if (hook) return hook(ctx, s.item, unit, s.write || undefined);
  const node = deep(s.item.node); setInstanceOn(node, sheet, null, Math.min(unit, count));
  if (s.write) { s.write(node); return true; }
  ctx.commit([modChange(ctx.doc, s.item, node)], "Change Unit"); return true;
}
/** ID_POPUP_SCH_PLACE_UNIT…: SCH_SELECTION_TOOL runs placeNextSymbolUnit for that unit; PlaceSymbol's loop ignores it. */
export function placeSymbolUnit(ctx: SchCtx, unit: number): boolean {
  if (carried(ctx)) return true;
  return placeNextUnit(ctx, { unit });
}
/** A choice from BODY_STYLE_MENU: SCH_EDIT_FRAME::SelectBodyStyle (no change for the style it has, "Change Body Style"; the symbol being placed is edited in place). */
export function chooseBodyStyle(ctx: SchCtx, style: number): boolean {
  if (!editable(ctx)) return false;
  const s = menuSymbol(ctx); if (!s) return false;
  const lib = libOfSymbol(ctx.doc, s.item.node); if (!lib) return false;
  const count = libBodyStyles(lib).count, bsN = kid(s.item.node, "body_style") || kid(s.item.node, "convert"), cur = bsN ? num(bsN[1], 1) : 1;
  if (count <= 1 || cur === style) return true;
  const node = deep(s.item.node), k = kid(node, "body_style") ? "body_style" : kid(node, "convert") ? "convert" : "body_style";
  replaceKid(node, [k, Math.min(style, count)]);
  if (s.write) { s.write(node); return true; }
  ctx.commit([modChange(ctx.doc, s.item, node)], "Change Body Style"); return true;
}
export function insertField(node: SNode, p: SNode) { const at = node.findIndex((c) => Array.isArray(c) && (c[0] === "pin" || c[0] === "instances")); if (at >= 0) node.splice(at, 0, p); else node.push(p); }
/** The variant flag (SCH_SYMBOL_VARIANT) each attribute token sets. */
const VARIANT_FLAG: Record<string, keyof VM.SymFlags> = { dnp: "dnp", in_bom: "excludedFromBOM", exclude_from_sim: "excludedFromSim", on_board: "excludedFromBoard", in_pos_files: "excludedFromPosFiles" };
export const FLAG_KEYS: Record<string, string[]> = { setDNP: ["dnp", "yes", "no"], setExcludeFromBOM: ["in_bom", "no", "yes"], setExcludeFromSim: ["exclude_from_sim", "yes", "no"], setExcludeFromBoard: ["on_board", "no", "yes"], setExcludeFromPosFiles: ["in_pos_files", "no", "yes"] };
/** The token the s-expression writer puts each attribute flag after, for a node that does not have it yet. */
const FLAG_AFTER: Record<string, string[]> = { exclude_from_sim: ["body_style", "convert", "unit", "mirror", "at", "lib_id"], in_bom: ["exclude_from_sim"], on_board: ["in_bom"], in_pos_files: ["on_board"], dnp: ["in_pos_files", "on_board"] };
/** A copy of `node` with the flag `key` set to `val`, added where the writer puts it when the node lacks it. */
export function withFlag(node: SNode, key: string, val: string): SNode {
  const n = deep(node), k = kid(n, key);
  if (k) { k[1] = val; return n; }
  let at = -1;
  for (const a of FLAG_AFTER[key] || []) { at = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === a); if (at > 0) break; }
  n.splice(at > 0 ? at + 1 : n.length, 0, [key, val]);
  return n;
}
/**
 * SCH_EDIT_TOOL::SetAttribute: the Attributes toggles on the selected symbols, sheets and rule areas (Exclude from
 * Position Files: symbols only).  Every annotated multi-unit symbol takes its other units on every sheet along ("The
 * attributes should be kept in sync in multi-unit parts"); the flag goes on when any of them has it off.  One
 * "Toggle Attribute" commit.
 */
export function toggleSymbolFlag(ctx: SchCtx, which: string) {
  if (!editable(ctx)) return false;
  const [key, onVal, offVal] = FLAG_KEYS[which];
  const kinds = which === "setExcludeFromPosFiles" ? ["symbol"] : ["symbol", "sheet", "rule_area"];
  // the symbol on the cursor takes the flag itself
  const cr = carried(ctx);
  if (cr) { if (cr.item.kind !== "symbol") return false; const k = kid(cr.item.node, key); cr.write(withFlag(cr.item.node, key, k && str(k[1]) === onVal ? offVal : onVal)); return true; }
  const items = selectedItems(ctx).filter((it) => kinds.includes(it.kind)); if (!items.length) return false;
  // KiCad's defaults when the token is missing: in the BOM, on the board and in the position files; not DNP or excluded from simulation
  // with a current variant (the toolbar's) the symbol's instance variant takes the flag (SCH_EDIT_TOOL::SetAttribute
  // per variant); the variant is created from the symbol's own flags and dropped once it differs in nothing
  const variant = String((root.CollabEditor && (root.CollabEditor as { currentVariant?: string }).currentVariant) || "");
  // the instance on screen (GetCurrentSheet()); a rule area keeps its own flags whatever the variant
  // (SCH_RULE_AREA::SetDNP … ignore the instance and the variant), and so does a sheet's Exclude from Board
  // (SCH_SHEET::SetExcludedFromBoard; a sheet variant has no board flag)
  const ed = root.CollabEditor as { currentSheetPathOf?: () => string | null } | undefined;
  const path = variant && ed && ed.currentSheetPathOf ? ed.currentSheetPathOf() : null, ver = ctx.doc.version;
  const vf = VARIANT_FLAG[key];
  const viaVariant = (n: SNode): boolean => !!variant && !!vf && (n[0] === "symbol" || (n[0] === "sheet" && key !== "on_board"));
  const isOn = (n: SNode): boolean => { if (viaVariant(n)) return VM.symbolFlagsForVariant(n, variant, path, ver)[vf]; const k = kid(n, key); return !!k && str(k[1]) === onVal; };
  const set = (n: SNode, on: boolean): SNode => (viaVariant(n) ? VM.setSymbolVariant(n, variant, { flags: { [vf]: on } }, path, ver) : withFlag(n, key, on ? onVal : offVal));
  const hook = root.CollabEditor && root.CollabEditor.toggleAttribute;
  if (hook) return hook(ctx, items, isOn, set);
  let on = false; for (const it of items) if (!isOn(it.node)) { on = true; break; }
  const changes: KChange[] = [];
  for (const it of items) { const node = set(it.node, on); if (JSON.stringify(node) !== JSON.stringify(it.node)) changes.push(modChange(ctx.doc, it, node)); }
  if (changes.length) ctx.commit(changes, "Toggle Attribute");
  return true;
}
export function libUnits(doc: KDoc, node: SNode) {
  const lib = K.resolveLib(doc, symbolLibId(node)); const units = new Set<number>(), styles = new Set<number>();
  if (lib) for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (m) { if (+m[1] > 0) units.add(+m[1]); styles.add(+m[2]); } }
  return { units: Math.max(1, ...units), styles: Math.max(1, ...styles) };
}
export function stepUnit(ctx: SchCtx, dir: number) {
  if (!editable(ctx)) return false;
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { units } = libUnits(ctx.doc, it.node); if (units < 2) { ctx.toast("Symbol has a single unit"); return false; }
  // SetUnitSelection( &sheet, unit ): the unit of the sheet instance on screen; the other sheet paths keep theirs
  const sheet = sheetOf(ctx.doc), cur = unitOn(it.node, sheet.path), next = ((cur - 1 + dir + units) % units) + 1;
  // SCH_EDIT_FRAME::SelectUnit: the editor asks about a unit already placed elsewhere in the hierarchy
  const hook = root.CollabEditor && root.CollabEditor.selectUnit;
  if (hook) return hook(ctx, it, next);
  const node = deep(it.node); setInstanceOn(node, sheet, null, next);
  ctx.commit([modChange(ctx.doc, it, node)], "Change Unit"); return true;
}
export function cycleBodyStyle(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const cr = carried(ctx);
  const it = cr ? (cr.item.kind === "symbol" ? cr.item : undefined) : selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const { styles } = libUnits(ctx.doc, it.node); if (styles < 2) { ctx.toast("Symbol has no alternate body style"); return false; }
  const cur = kid(it.node, "body_style") ? num(kid(it.node, "body_style")![1], 1) : 1;
  const node = deep(it.node); replaceKid(node, ["body_style", (cur % styles) + 1]);
  if (cr) { cr.write(node); return true; }   // the symbol being placed: no commit, it is not in the document yet
  ctx.commit([modChange(ctx.doc, it, node)], "Change Body Style"); return true;
}
/**
 * GetUnplacedUnitsForSymbol: the units of the symbol's package no symbol holds, over the whole hierarchy (this sheet's
 * symbols and the other sheets' units the editor publishes).  An unannotated reference ("U?") only counts the units
 * of the same library symbol.
 */
export function unplacedUnits(doc: KDoc, it: KItem): number[] {
  const { units } = libUnits(doc, it.node), ref = it.ref || "", unannotated = ref.endsWith("?"), lib = symbolLibId(it.node);
  const missing = new Set<number>(); for (let u = 1; u <= units; u++) missing.add(u);
  for (const o of doc.items.values()) {
    if (o.kind !== "symbol" || o.ref !== ref) continue;
    if (unannotated && symbolLibId(o.node) !== lib) continue;
    missing.delete(kid(o.node, "unit") ? num(kid(o.node, "unit")![1], 1) : 1);
  }
  for (const h of S.otherUnits || []) { if (h.ref !== ref || (unannotated && h.lib !== lib)) continue; missing.delete(h.unit); }
  return [...missing].sort((a, b) => a - b);
}
/** SCH_DRAWING_TOOLS::PlaceNextSymbolUnit: the lowest missing unit (or the requested one) of the one selected symbol rides on the cursor; the tool ends with its placement. */
export function placeNextUnit(ctx: SchCtx, opts?: { unit?: number } | null) {
  if (!editable(ctx)) return false;
  const syms = selectedItems(ctx).filter((x) => x.kind === "symbol");
  if (syms.length !== 1) { ctx.toast("Select a single symbol to place the next unit."); return false; }
  const it = syms[0];
  const { units } = libUnits(ctx.doc, it.node); if (units < 2) { ctx.toast("This symbol has only one unit."); return false; }
  const missing = unplacedUnits(ctx.doc, it);
  if (!missing.length) { ctx.toast("All units of this symbol are already placed."); return false; }
  const want = opts && opts.unit && opts.unit > 0 ? opts.unit : 0;
  if (want && !missing.includes(want)) { ctx.toast("Requested unit already placed."); return false; }
  const next = want || missing[0];
  // a copy of the symbol (SCH_SYMBOL( *symbol )): it keeps the reference and the instance data, the unit set on every instance
  const node = deep(it.node); replaceKid(node, ["uuid", K.newUuid()]);
  for (const pin of kids(node, "pin")) replaceKid(pin, ["uuid", K.newUuid()]);
  replaceKid(node, ["unit", next]);
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const u = kid(pa, "unit"); if (u) u[1] = next; }
  S.carry = { kind: "symbol", node, item: ghost(ctx.doc, node), pos: anchorOf("symbol", node) };
  S.placeOne = uuidOf(node);                       // placeOneOnly: the drop returns to the selection tool
  S.sel = null; ctx.setSelected(null); switchTool(ctx, "place"); ctx.requestRender(); return true;
}
/**
 * SCH_SYMBOL::ResolveTextVar for a field's shown text: ${REFERENCE}, ${VALUE}, ${FOOTPRINT}, ${DATASHEET},
 * ${DESCRIPTION} and ${<field name>} (as written or in capitals) are the symbol's own fields; anything else is left
 * for the project (EDA_TEXT::GetShownText expands again while something changes).
 */
export function symbolShownText(node: SNode, raw: string): string {
  const fields = kids(node, "property");
  let out = raw;
  for (let depth = 0; depth < 10 && out.includes("${"); depth++) {
    const next = out.replace(/\$\{([^{}]+)\}/g, (all, token: string) => {
      const f = fields.find((p) => str(p[1]) === token || str(p[1]).toUpperCase() === token);
      return f ? str(f[2]) : all;
    });
    if (next === out) break; out = next;
  }
  return out;
}
/** SCH_INSPECTION_TOOL::ShowDatasheet: the shown text of the selected symbol's Datasheet field, opened as an associated document. */
export function showDatasheet(ctx: SchCtx) {
  const it = selectedItems(ctx).find((x) => x.kind === "symbol"); if (!it) return false;
  const p = kids(it.node, "property").find((q) => str(q[1]) === "Datasheet");
  const url = p ? symbolShownText(it.node, str(p[2])).trim() : "";
  if (!url || url === "~") { ctx.toast("No datasheet defined."); return false; }
  // the editor's GetAssociatedDocument: project text variables, a web link in a new tab, a kicad-embed:// file of
  // the schematic's, the library symbol's or the symbol's embedded files
  if (ctx.openDatasheet) { ctx.openDatasheet(url, it); return true; }
  if (typeof window !== "undefined" && window.open && /^https?:/i.test(url)) window.open(url, "_blank"); else ctx.toast("Datasheet: " + url);
  return true;
}
