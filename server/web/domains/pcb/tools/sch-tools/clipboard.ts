import type { SchCtx, Pt } from "./types";
import { GENERATOR_VERSION, SEXPR_SCHEMATIC_FILE_VERSION } from "../../canvas/format-version";
import { root } from "../root";
import { newSymbolMinRef } from "./annotate";
import { PASTE_KINDS, clipRead, clipWrite, cursorOf, editable, selectedItems, setSelectionIds, snapCursor } from "./commands";
import { breakLinesAt, junctionAt, needsJunction } from "./connect";
import { LABEL_KINDS, beginDrag, connPoints, isNetLine } from "./drag";
import { strNumCmp } from "./erc";
import { IMAGE_PPI, bytesToBase64, imageNode, imageSize, junctionNode } from "./nodes";
import { cloneNode, shiftNode } from "./orient";
import { deleteChanges } from "./selection-edits";
import { baseName, currentDoc, dirName, ensureSheetDoc, joinPath, normSheetFile, sheetInstance, sheetPathHere } from "./sheets";
import { K, S, TEXT_KINDS, kid, kids, num, ptsOf, str, uuidOf } from "./state";
import { startCarry } from "./carry";
import { switchTool } from "./junction";
import { isLockedItem } from "./lock";
import { itemPosition } from "./transforms";
import { symbolIsPower } from "./autoplace";
import { addNode, deep, dropKid, ghost, r4, ruleAreaId } from "./util";

// ---------------------------------------------------------------- copy / cut / paste / duplicate
// What the desktop puts on the clipboard (SCH_IO_KICAD_SEXPR::Format for a selection): the library
// symbols used, then the items — no (kicad_sch …) wrapper, which its copyable-only parser rejects.
// opts.wrap gives the document form for anything that wants a whole sheet.
/** Paste options: the reference rule, the undo label, where the items land, and whether junctions are added. */
export interface PasteOpts { pasteMode?: string; keepAnnotations?: boolean; noJunctions?: boolean; label?: string; at?: Pt;
  /** Import Sheet's "Place as group": the new items go into one new group of this name (made unique on the sheet) */
  group?: string;
  /** Paste Special chose "Clear reference designators" although it is not the default (forceRemoveAnnotations) */
  explicit?: boolean;
  /** Duplicate: the reference point is the candidate nearest this point (the cursor when Ctrl+D was pressed) */
  refNear?: Pt;
  /** Duplicate of a hover selection: the placed copy is not left selected (m_duplicateIsHoverSelection) */
  hover?: boolean;
  /** the schematic's annotation settings (Schematic Setup > Annotation) and the open sheet's page number */
  annotate?: AnnotateCfg;
  /** the editor context: pasted sheets take their page number, instance and recursion check from it */
  ctx?: SchCtx | null }
/** m_AnnotateMethod (0 incremental, 1 sheet number x 100, 2 x 1000), m_AnnotateSortOrder (Y first), m_AnnotateStartNum. */
export interface AnnotateCfg { method: number; sortY: boolean; startNum: number; sheetNumber: number }
/** The project's annotation settings as Schematic Setup stores them in the .kicad_pro (schematic.annotation.*). */
export function annotationSettings(ctx: SchCtx | null | undefined, doc?: KDoc): AnnotateCfg {
  let pro: unknown = ctx ? (ctx as unknown as { designSettings?: unknown }).designSettings : null;
  if (typeof pro === "string") { try { pro = JSON.parse(pro); } catch (e) { pro = null; } }
  const sch = ((pro && typeof pro === "object" ? (pro as { schematic?: unknown }).schematic : null) || {}) as { annotation?: { method?: unknown; sort_order?: unknown }; annotate_start_num?: unknown };
  const a = sch.annotation || {}, d = doc || (ctx ? ctx.doc : null);
  const page = (ctx && ctx.pageNumber) || parseInt(str(d && (d as KDoc & { pageNumber?: string }).pageNumber), 10) || 1;
  return { method: typeof a.method === "number" ? a.method : 0, sortY: a.sort_order === 1, startNum: typeof sch.annotate_start_num === "number" ? sch.annotate_start_num : 0, sheetNumber: page };
}
/** A group's member ids. */
export function groupMembers(node: SNode): string[] { const m = kid(node, "members"); return m ? m.slice(1).map((x) => str(x)) : []; }
const libNameOf = (node: SNode): string => str((kid(node, "lib_name") || kid(node, "lib_id") || [])[1]);
/** UniqueGroupName: the base name, else the base name with the first free number appended. */
export function uniqueGroupName(doc: KDoc, base: string) {
  const taken = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "group") taken.add(str(it.node[1]));
  if (!taken.has(base)) return base;
  for (let n = 1; ; n++) if (!taken.has(base + n)) return base + n;
}
/** Clipboard content: the items and the library symbols they draw from. */
export interface Clip { nodes: SNode[]; libs: SNode[] }
export function clipboardText(doc: KDoc, items: KItem[], opts?: { wrap?: boolean }) {
  // doCopy: a selected group brings all its members along (RunOnChildren, RECURSE)
  const all: KItem[] = [], seen = new Set<string>();
  const take = (it: KItem) => { if (seen.has(it.id)) return; seen.add(it.id); all.push(it); if (it.kind === "group") for (const id of groupMembers(it.node)) { const m = doc.items.get(id); if (m) take(m); } };
  for (const it of items) take(it);
  // the library copy each symbol draws from: its (lib_name …) when it has one, else its lib_id (GetSchSymbolLibraryName)
  const libs = new Map<string, SNode>();
  for (const it of all) if (it.kind === "symbol") { const name = libNameOf(it.node); const lib = doc.lib.get(name); if (lib && !libs.has(name)) libs.set(name, lib); }
  const parts: string[] = [];
  if (libs.size) parts.push("(lib_symbols " + Array.from(libs.values()).map((l) => K.serialize(l)).join(" ") + ")");
  // saveSymbol( aForClipboard ): the instance paths are written relative to the sheet copied from, so its own is "/"
  const here = opts && opts.wrap ? null : sheetPathHere(doc).path;
  for (const it of all) {
    let node = it.node;
    if (it.kind === "rule_area" && kid(node, "uuid")) { node = deep(node); dropKid(node, "uuid"); }
    if (it.kind === "symbol" && here && kid(node, "instances")) {
      node = deep(node);
      for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const q = str(pa[1]); if (q === here) pa[1] = "/"; else if (q.startsWith(here + "/")) pa[1] = q.slice(here.length); }
    }
    let s = K.serialize(node); if (it.kind === "sheet") s = s.replace(/\(page (\d+)\)/g, '(page "$1")');
    parts.push(s);
  }
  const body = parts.join("\n");
  return opts && opts.wrap ? `(kicad_sch (version ${SEXPR_SCHEMATIC_FILE_VERSION}) (generator "eeschema") (generator_version "${GENERATOR_VERSION}")\n${body}\n)` : body;
}
// Both clipboard forms: a bare item sequence (the desktop's) or a (kicad_sch …) document.
export function parseClipboard(text: string): Clip | null {
  let trees: SNode[]; try { trees = K.parseAll(str(text)); } catch (e) { return null; }
  const nodes: SNode[] = [], libs: SNode[] = [];
  const takeLibs = (ls: SNode) => { for (const s of kids(ls, "symbol")) libs.push(s); };
  for (const t of trees || []) {
    if (!Array.isArray(t)) continue;
    if (t[0] === "kicad_sch") { const ls = kid(t, "lib_symbols"); if (ls) takeLibs(ls); for (const c of t.slice(1)) if (Array.isArray(c) && PASTE_KINDS.has(c[0] as string)) nodes.push(c); }
    else if (t[0] === "lib_symbols") takeLibs(t);
    else if (PASTE_KINDS.has(t[0] as string)) nodes.push(t);
  }
  return nodes.length ? { nodes, libs } : null;
}
export const refPrefix = (ref: string) => str(ref).replace(/\?$/, "").replace(/\d+$/, "");
export const unannotated = (ref: string) => refPrefix(ref) + "?";
export const refNumber = (ref: string) => { const m = str(ref).match(/(\d+)$/); return m ? +m[1] : -1; };
// The references in use: this sheet's, plus the ones the project's other sheets hold (S.otherRefs, kept by the editor)
export function usedReferences(doc: KDoc, skip?: Set<string>) { const used = new Set(S.otherRefs || []); for (const it of doc.items.values()) if (it.kind === "symbol" && it.ref && !(skip && skip.has(it.id))) used.add(it.ref); return used; }
export function refField(node: SNode) { return kids(node, "property").find((p) => str(p[1]) === "Reference") || null; }
// Set a symbol node's reference designator, keeping its instance data in step.
export function setReference(node: SNode, ref: string) {
  const p = refField(node); if (p) p[2] = ref;
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const r = kid(pa, "reference"); if (r) r[1] = ref; }
}
// Pasted / repeated symbols keep a reference that is still free on the sheet; anything else becomes "R?"
// (or, with automatic annotation on, the next free number for its prefix).  References are compared by prefix and
// number, as SCH_REFERENCE_LIST does: "#PWR1" is taken when "#PWR01" is on the sheet.
export function assignPastedRef(doc: KDoc, node: SNode, used: Set<string>) {
  const p = refField(node); if (!p) return;
  const ref = str(p[2]), taken = refNumbers(used);
  const free = (r: string): boolean => { const n = refNumber(r); return n < 0 ? !used.has(r) : !(taken.get(refPrefix(r)) || new Set()).has(n); };
  if (!/\?$/.test(ref) && free(ref)) { takeRef(used, ref); return; }
  let next = unannotated(ref);
  if (S.annotateAuto) {
    // AnnotateNewSymbol: ReannotateByOptions with the project's start number / sheet-number method, the designators
    // the tracker bars from reuse skipped, and a power symbol's number written 0nnn (SCH_REFERENCE::formatRefStr)
    const prefix = refPrefix(ref), tracker = S.refTracker, power = isPowerLib(doc, node);
    let n = newSymbolMinRef(pageOf(doc));
    while (!free(prefix + n) || (tracker && !tracker.reuse && tracker.used.has(prefix + n))) n++;
    if (tracker) tracker.used.add(prefix + n);
    next = prefix + (power ? "0" + n : n); takeRef(used, next);
  }
  setReference(node, next);
}
/** LIB_SYMBOL::IsPower of a placed symbol's library symbol. */
function isPowerLib(doc: KDoc, node: SNode): boolean { const lib = doc ? K.resolveLib(doc, str((kid(node, "lib_id") || [])[1])) : null; return !!lib && !!kid(lib, "power"); }
/** SCH_SHEET_PATH::GetPageNumberAsInt of the sheet on screen. */
function pageOf(doc: KDoc): number { const n = parseInt(String((doc && (doc as KDoc & { pageNumber?: string }).pageNumber) || ""), 10); return n > 0 ? n : 1; }
// prefix -> the numbers in use, kept beside each reference set so that repeated checks stay cheap
const numbersOf = new WeakMap<Set<string>, Map<string, Set<number>>>();
function refNumbers(used: Set<string>): Map<string, Set<number>> {
  let m = numbersOf.get(used);
  if (!m) { m = new Map(); for (const r of used) addNumber(m, r); numbersOf.set(used, m); }
  return m;
}
function addNumber(m: Map<string, Set<number>>, r: string): void {
  const n = refNumber(r); if (n < 0 || /\?$/.test(r)) return;
  const k = refPrefix(r); let s = m.get(k); if (!s) { s = new Set(); m.set(k, s); } s.add(n);
}
function takeRef(used: Set<string>, r: string): void { used.add(r); addNumber(refNumbers(used), r); }
/**
 * SCH_EDIT_FRAME::ImportSheet without Keep annotations: AnnotateSymbols( ANNOTATE_SELECTION, sort by X position,
 * aResetAnnotation = true ).  The new symbols lose their references and take the first free numbers in order of
 * position (prefix, then x, then y); the units of one old multi-unit package stay together.
 */
function resetAnnotation(nodes: SNode[], used: Set<string>): void {
  const syms = nodes.filter((n) => n[0] === "symbol" && refField(n)).map((n) => {
    const at = kid(n, "at"), u = kid(n, "unit"), ref = str(refField(n)![2]);
    return { n, ref, prefix: refPrefix(ref), x: at ? +at[1] : 0, y: at ? +at[2] : 0, unit: u ? +u[1] : 1, lib: str((kid(n, "lib_id") || [])[1]) };
  });
  syms.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0) || a.x - b.x || a.y - b.y);
  const taken = refNumbers(used), pkg = new Map<string, { n: number; units: Set<number> }>();
  for (const s of syms) {
    let set = taken.get(s.prefix); if (!set) { set = new Set(); taken.set(s.prefix, set); }
    const key = /\?$/.test(s.ref) || refNumber(s.ref) < 0 ? null : s.prefix + "\u0000" + s.ref + "\u0000" + s.lib;
    const held = key ? pkg.get(key) : undefined;
    let n: number;
    if (held && !held.units.has(s.unit)) { n = held.n; held.units.add(s.unit); }
    else { n = 1; while (set.has(n)) n++; if (key) pkg.set(key, { n, units: new Set([s.unit]) }); }
    set.add(n); used.add(s.prefix + n);
    setReference(s.n, s.prefix + n);
  }
}
/** How many units the sheet's library symbol for a placed symbol has. */
function unitCountOf(doc: KDoc, node: SNode): number {
  const lib = K.resolveLib(doc, str((kid(node, "lib_id") || [])[1])); let n = 1;
  if (lib) for (const sub of kids(lib, "symbol")) { const m = str(sub[1]).match(/_(\d+)_(\d+)$/); if (m) n = Math.max(n, +m[1]); }
  return n;
}
const valueOf = (node: SNode): string => { const p = kids(node, "property").find((q) => str(q[1]) === "Value"); return p ? str(p[2]) : ""; };
const unitOf = (node: SNode): number => { const u = kid(node, "unit"); return u ? +u[1] || 1 : 1; };
/**
 * SCH_EDITOR_CONTROL::Paste in UNIQUE_ANNOTATIONS mode: SCH_REFERENCE_LIST::ReannotateDuplicates over the pasted
 * symbols against the references already in the schematic.  Every annotated pasted symbol is reannotated starting
 * at its own number (aStartAtCurrent), with the pasted units of one reference locked together:
 *  - a one-unit symbol keeps its number when nothing holds it, else takes the next number that is free;
 *  - a multi-unit package keeps its number when the symbols holding that number are the same library symbol with
 *    the same value and none of them is one of the pasted units (REFDES_TRACKER::areUnitsAvailable), so a cut and
 *    pasted U1B is U1B again, while a copy of it (U1B still there) becomes the next free package, U2B;
 *  - an unannotated "U?" unit joins the first package that leaves its unit free, else a new number.
 * The project's other sheets count with their units (S.otherUnits); a reference known only by name is held outright.
 *
 * `cfg.reannotate` is ReannotateByOptions( annotateOrder, annotateAlgo, annotateStartNum, existingRefs, false ) instead,
 * what Paste runs on the symbols that are always annotated (power symbols, "#" references) outside the unique mode:
 * every one takes the first free number from the start number, in the project's sort order.
 * The list is sorted as AnnotateByOptions does (SortByXCoordinate: prefix, sheet, X, Y, uuid; SortByYCoordinate for the
 * Y order), and with the "sheet number x 100 / x 1000" methods the numbers start at sheet x step + 1 whatever the
 * symbol's own number (aStartAtCurrent is switched off).
 */
export function annotatePastedUnique(doc: KDoc, nodes: SNode[], cfg?: Partial<AnnotateCfg> & { reannotate?: boolean }): void {
  interface Holder { lib: string; value: string; unit: number }
  // prefix and number -> who holds it: "#PWR01" and "#PWR1" are one reference (SCH_REFERENCE::Split's m_numRef)
  const held = new Map<string, Holder[]>();
  const keyOf = (ref: string): string => { const n = refNumber(ref); return n < 0 ? ref : refPrefix(ref) + "\u0000" + n; };
  const hold = (ref: string, h: Holder) => { const k = keyOf(ref), l = held.get(k); if (l) l.push(h); else held.set(k, [h]); };
  // the other sheets: their units when known (a package may span sheets), else the bare reference, held outright
  const known = new Set<string>();
  for (const u of S.otherUnits || []) { known.add(u.ref); hold(u.ref, { lib: u.lib, value: u.value, unit: u.unit }); }
  for (const r of S.otherRefs || []) if (!known.has(r)) hold(r, { lib: "", value: "", unit: -1 });
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const p = refField(it.node); const ref = p ? str(p[2]) : ""; if (!ref || /\?$/.test(ref)) continue;
    hold(ref, { lib: str((kid(it.node, "lib_id") || [])[1]), value: valueOf(it.node), unit: unitOf(it.node) });
  }
  // AnnotateByOptions' sort, then the pasted units of one reference annotated as one locked package
  // without explicit settings: the project's, as the editor keeps them in S.annotation
  const c: Partial<AnnotateCfg> & { reannotate?: boolean } = cfg || (S.annotation ? { method: S.annotation.method, sortY: S.annotation.sortY, startNum: S.annotation.startNum, sheetNumber: pageOf(doc) } : {}), step = c.method === 1 ? 100 : c.method === 2 ? 1000 : 0, startAtCurrent = !c.reannotate && !step;
  const base = step ? (c.sheetNumber || 1) * step + 1 : (c.reannotate ? c.startNum || 0 : 0) + 1;
  const syms = nodes.filter((n) => n[0] === "symbol" && refField(n)).map((n) => { const at = kid(n, "at"); return { n, ref: str(refField(n)![2]), prefix: refPrefix(str(refField(n)![2])), x: at ? num(at[1]) : 0, y: at ? num(at[2]) : 0, uuid: uuidOf(n) || "", lib: str((kid(n, "lib_id") || [])[1]), value: valueOf(n), unit: unitOf(n), multi: unitCountOf(doc, n) > 1 }; });
  syms.sort((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0) || (c.sortY ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y) || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  const done = new Set<typeof syms[number]>();
  let group: string | null = null, minRef = base;
  // REFDES_TRACKER (reuse_designators / used_designators)
  const tracker = S.refTracker;
  for (const s of syms) {
    // minRefId: reset for each new prefix, moved to the symbol's own number when starting at the current one
    if (s.prefix !== group) { group = s.prefix; minRef = base; }
    const prefix = s.prefix, current = /\?$/.test(s.ref) ? -1 : refNumber(s.ref);
    if (startAtCurrent && current > 0) minRef = current;
    if (done.has(s)) continue;
    // the locked package: the pasted units that carry this same reference, library symbol and value
    const pkg = current >= 0 && s.multi ? syms.filter((o) => !done.has(o) && o.ref === s.ref && o.lib === s.lib && o.value === s.value) : [s];
    const units = new Set(pkg.map((o) => o.unit));
    const fits = (n: number): boolean => {
      const hs = held.get(prefix + "\u0000" + n);
      // REFDES_TRACKER::GetNextRefDesForUnits: a number nothing holds is taken unless it was used before and designators are not reused
      if (!hs || !hs.length) return !tracker || tracker.reuse || !tracker.used.has(prefix + n);
      return s.multi && hs.every((h) => h.unit >= 0 && h.lib === s.lib && h.value === s.value && !units.has(h.unit));
    };
    let n = Math.max(1, minRef);
    while (!fits(n)) n++;
    if (tracker && !held.has(prefix + "\u0000" + n)) tracker.used.add(prefix + n);
    const text = prefix + (isPowerLib(doc, s.n) ? "0" + n : n);
    for (const o of pkg) { done.add(o); setReference(o.n, text); hold(text, { lib: o.lib, value: o.value, unit: o.unit }); }
  }
}
// Junctions the new items need: every connection point of every new item (items must be in the doc).
export function junctionsForNew(doc: KDoc, items: KItem[]) {
  const out: KChange[] = [], seen = new Set<string>();
  for (const it of items) {
    const line = isNetLine(it.kind);
    for (const p of line ? ptsOf(it.node) : connPoints(doc, it)) {
      const key = r4(p[0]) + "," + r4(p[1]); if (seen.has(key)) continue; seen.add(key);
      if (junctionAt(doc, p[0], p[1])) continue;
      const need = line ? needsJunction(doc, p[0], p[1], it.kind) : needsJunction(doc, p[0], p[1], "wire") || needsJunction(doc, p[0], p[1], "bus");
      if (need) {   // AddJunction's BreakSegments: a line running through the point splits there
        if (line) out.push(...breakLinesAt(doc, p, it.kind).filter((c) => !items.some((n) => n.id === c.id)));
        else for (const kd of ["wire", "bus"]) out.push(...breakLinesAt(doc, p, kd).filter((c) => !items.some((n) => n.id === c.id)));
        out.push(addNode(doc, junctionNode(p)).change);
      }
    }
  }
  return out;
}
const CONNECTABLE = new Set(["symbol", "wire", "bus", "junction", "no_connect", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label", "sheet"]);
const sheetField = (node: SNode, which: "name" | "file"): SNode | null => kids(node, "property").find((q) => (which === "name" ? /^Sheet ?name$/i : /^Sheet ?file$/i).test(str(q[1]))) || null;
/** The sheet hierarchy the editor knows (ctx.sheetHierarchy): the sheet paths as file names from the root down, and the sheets read so far. */
interface SheetHierarchy { paths: string[][]; docs: Map<string, KDoc> }
function hierarchyOf(ctx: SchCtx | null | undefined): SheetHierarchy | null {
  const f = ctx && (ctx as unknown as { sheetHierarchy?: () => SheetHierarchy | null }).sheetHierarchy;
  try { return typeof f === "function" ? f() : null; } catch (e) { return null; }
}
/** A sheet's file as a project path, from the file of the sheet it sits on. */
function sheetFilePath(ctx: SchCtx, file: string, from?: string): string {
  const cur = currentDoc(ctx), dir = from !== undefined ? dirName(from) : cur ? dirName(cur.path) : "";
  return joinPath(dir, normSheetFile(file));
}
/**
 * SCH_SHEET_LIST::TestForRecursion for a pasted sheet: its file, or a file of one of its sub-sheets, is the sheet
 * pasted into or one of that sheet's parents somewhere in the hierarchy.
 */
export function pastedSheetRecursion(ctx: SchCtx, file: string, destFile?: string): boolean {
  const cur = currentDoc(ctx); if (destFile === undefined && (!cur || !cur.path)) return false;
  // SCH_MOVE_TOOL::dropWouldRecurse names the drop target's own file (destScreen->GetFileName()) as the destination
  const dest = destFile !== undefined ? sheetFilePath(ctx, destFile) : cur!.path, h = hierarchyOf(ctx);
  if (!dest) return false;
  const src: string[] = [], seen = new Set<string>(), todo = [sheetFilePath(ctx, file)];
  const docOf = (f: string): KDoc | null => {
    const d = h ? h.docs.get(f) : null; if (d) return d;
    const sd = ctx.sheetDocs, v = sd ? (sd instanceof Map ? sd.get(f) || sd.get(baseName(f)) : sd[f] || sd[baseName(f)]) : null;
    return v && typeof v !== "string" ? v : null;
  };
  while (todo.length && src.length < 500) {
    const f = todo.shift()!; if (seen.has(f)) continue; seen.add(f); src.push(f);
    const d = docOf(f); if (!d) continue;
    for (const it of d.items.values()) { if (it.kind !== "sheet") continue; const p = sheetField(it.node, "file"); if (p) todo.push(sheetFilePath(ctx, str(p[2]), f)); }
  }
  for (const f of src) {
    if (f === dest) return true;                             // the source and destination files cannot be the same
    for (const p of h ? h.paths : []) { let i = p.indexOf(dest); while (i > 0) { i--; if (p[i] === f) return true; } }
  }
  return false;
}
/** The page numbers in use in the hierarchy (SCH_SHEET_LIST::PageNumberExists), as far as the editor has read it. */
function usedPages(ctx: SchCtx | null | undefined, doc: KDoc): Set<string> {
  const used = new Set<string>(), h = hierarchyOf(ctx), docs = new Set<KDoc>([doc]);
  if (h) for (const d of h.docs.values()) docs.add(d);
  for (const d of docs) {
    const own = str((d as KDoc & { pageNumber?: string }).pageNumber); if (own) used.add(own);
    for (const it of d.items.values()) if (it.kind === "sheet") for (const inst of kids(it.node, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) { const pg = kid(pa, "page"); if (pg) used.add(str(pg[1])); }
  }
  if (!used.size) used.add("1");
  return used;
}
/** The points Duplicate may take as its reference point when nothing in the copy is connectable. */
function graphicPoints(kind: string, node: SNode): Pt[] {
  const at = (k: string): Pt | null => { const c = kid(node, k); return c ? [num(c[1]), num(c[2])] : null; };
  if (kind === "group") return [];
  if (kind === "polyline") return ptsOf(node);                                     // a line's two ends, a polygon's vertices
  if (kind === "rectangle") { const a = at("start"), b = at("end"); return a && b ? [a, [b[0], a[1]], b, [a[0], b[1]]] : []; }
  if (kind === "circle") { const c = at("center"); return c ? [c] : []; }
  if (kind === "arc") return [at("start"), at("end")].filter(Boolean) as Pt[];
  if (kind === "bezier") { const q = ptsOf(node); return q.length ? [q[0], q[q.length - 1]] : []; }
  return [itemPosition(kind, node)];
}
/**
 * SCH_EDITOR_CONTROL::Paste on parsed clipboard content: fresh copies of the items, added to the document and landed
 * so that the paste's reference point is at `at` (mm).  The reference point is the position of SCH_SELECTION::
 * GetTopLeftItem (the leftmost, then topmost, connectable item, else item; a group's first non-group member), or for
 * Duplicate (opts.refNear) the connection point, pin or symbol origin nearest the cursor.  Along the way, as there:
 * pasted items are unlocked; the clipboard's library symbol wins over the sheet's same-named copy (a differing one is
 * kept under "<name>_<n>" with the symbol's lib_name pointing at it, SCH_SCREEN::Append); groups keep their members
 * and get a unique name; sheets are taken in name order, dropped when they would recurse, renamed to a free name and
 * given the next free page; references follow the paste mode.  Returns { changes, ids, libs, dropped }.
 */
export function pasteChanges(doc: KDoc, parsed: Clip, at: Pt, opts?: PasteOpts | null) {
  const o = opts || {}, ctx = o.ctx || null, libs: string[] = [], dropped: string[] = [];
  const clipLibs = new Map<string, SNode>(); for (const lib of parsed.libs) if (!clipLibs.has(str(lib[1]))) clipLibs.set(str(lib[1]), lib);
  for (const [name, lib] of clipLibs) if (!doc.lib.has(name)) { doc.lib.set(name, lib); libs.push(name); }
  // loadedItems: everything but the sheets in clipboard order, then the sheets by name (StrNumCmp); a sheet that would
  // make the hierarchy recursive is dropped
  const nameOf = (n: SNode) => { const f = sheetField(n, "name"); return f ? str(f[2]) : ""; };
  const src = parsed.nodes.filter((n) => n[0] !== "sheet").concat(parsed.nodes.filter((n) => n[0] === "sheet").sort((a, b) => strNumCmp(nameOf(a), nameOf(b))).filter((n) => {
    const f = sheetField(n, "file"), file = f ? str(f[2]) : "";
    if (ctx && file && pastedSheetRecursion(ctx, file)) { dropped.push(file); return false; }
    return true;
  }));
  // PASTE_MODE: "keep", "remove" (the default with automatic annotation off), "unique" (the default with it on);
  // "reset" is Import Sheet's own re-annotation
  const mode = (o.pasteMode || (o.keepAnnotations ? "keep" : null)) || (S.annotateAuto ? "unique" : "remove");
  const existing = usedReferences(doc), cfg = o.annotate || annotationSettings(ctx, doc);
  let forceKeep = mode !== "remove";
  const here = sheetPathHere(doc), project = ctx ? (sheetInstance(ctx, doc, 1) || [])[1] as SNode | undefined : undefined, projectName = here.project || (project ? str(project[1]) : "");
  const sheetNames = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "sheet") sheetNames.add(nameOf(it.node));
  const pages = usedPages(ctx, doc), groupNames = new Set<string>(); for (const it of doc.items.values()) if (it.kind === "group") groupNames.add(str(it.node[1]));
  const idMap = new Map<string, string>(), fresh: SNode[] = [], candidates: SNode[] = [];
  for (const n of src) {
    const kind = n[0] as string;
    if (kind === "group") { const g = deep(n), id = K.newUuid(); idMap.set(uuidOf(n) || "", id); const u = kid(g, "uuid"); if (u) u[1] = id; else g.push(["uuid", id]); fresh.push(g); continue; }
    const oldId = kind === "rule_area" ? ruleAreaId(n) : uuidOf(n);
    const f = cloneNode({ kind, node: deep(n) });
    for (let i = f.length - 1; i > 0; i--) { const c = f[i]; if (Array.isArray(c) && c[0] === "locked") f.splice(i, 1); }   // SetLocked( false )
    if (kind === "symbol") {
      // ChoosePasteLibSymbol + SCH_SCREEN::Append: the clipboard's library symbol is the pasted instance's pair
      const libId = str((kid(f, "lib_id") || [])[1]), name = libNameOf(f), clip = clipLibs.get(name), own = doc.lib.get(name);
      if (clip && own && own !== clip && JSON.stringify(own) !== JSON.stringify(clip)) {
        const item = libId.split(":").pop() || libId, body = (l: SNode) => JSON.stringify(l.slice(2)), want = body(clip);
        let to = Array.from(doc.lib.keys()).find((k) => (k === libId || (k.startsWith(item + "_") && /^\d+$/.test(k.slice(item.length + 1)))) && body(doc.lib.get(k)!) === want) || "";
        if (!to) { let cnt = 1; while (doc.lib.has(`${item}_${cnt}`)) cnt++; to = `${item}_${cnt}`; const copy = deep(clip); copy[1] = to; doc.lib.set(to, copy); libs.push(to); }
        dropKid(f, "lib_name");
        if (to !== libId) { const i = f.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "lib_id"); f.splice(i > 0 ? i : 1, 0, K.parse(`(lib_name ${JSON.stringify(to)})`) as SNode); }
      }
      // updatePastedSymbol: the clipboard instance of the sheet copied from ("/") becomes this sheet's instance, with
      // its unit and variant data; every other instance goes (prunePastedSymbolInstances)
      let inst: SNode | null = null;
      for (const ins of kids(n, "instances")) for (const pr of kids(ins, "project")) for (const pa of kids(pr, "path")) if (!inst && (str(pa[1]) === "/" || str(pa[1]) === "")) inst = pa;
      if (inst && here.path && projectName) { const pa = deep(inst); pa[1] = here.path; f.push(["instances", ["project", projectName, pa]]); }
      const rf = refField(f), ref = rf ? str(rf[2]) : "";
      if (mode !== "reset" && rf) {
        // a symbol whose reference is not in the schematic yet keeps it, and so does every symbol after it, unless
        // Clear was chosen in Paste Special
        if (!existing.has(ref)) forceKeep = !o.explicit;
        if (!forceKeep) setReference(f, unannotated(ref));
        // "if we don't already have a copy of the symbol, we just keep the existing KIID data as it is likely the
        // same symbol being moved around the schematic"
        const newKiid = mode === "unique" || existing.has(ref);
        if (!newKiid && oldId && !doc.items.has(oldId) && !fresh.some((x) => uuidOf(x) === oldId)) {
          const u = kid(f, "uuid"); if (u) u[1] = oldId;
          const pinsN = kids(n, "pin"), pinsF = kids(f, "pin"); pinsF.forEach((pf, i) => { const a = pinsN[i] && kid(pinsN[i], "uuid"), b = kid(pf, "uuid"); if (a && b) b[1] = a[1]; });
        }
        if (newKiid && K.resolveLib(doc, libNameOf(f))) candidates.push(f);
      }
    } else if (kind === "sheet") {
      // a unique name on the destination screen: the trailing digits step until the name is free
      const nf = sheetField(f, "name");
      if (nf) {
        let baseN = str(nf[2]), number = ""; while (baseN && /\d$/.test(baseN)) { number = baseN[baseN.length - 1] + number; baseN = baseN.slice(0, -1); }
        let candidate = str(nf[2]), uniq = Math.max(0, parseInt(number, 10) || 0) + 1;
        while (sheetNames.has(candidate)) candidate = baseN + uniq++;
        nf[2] = candidate; sheetNames.add(candidate);
      }
      // the next free page number, and a sheet instance for this project
      let page = 1; while (pages.has(String(page))) page++;
      const si = ctx ? sheetInstance(ctx, doc, page) : null; if (si) { f.push(si); pages.add(String(page)); }
    }
    idMap.set(oldId || "", (kind === "rule_area" ? ruleAreaId(f) : uuidOf(f)) || "");
    fresh.push(f);
  }
  if (mode === "reset") resetAnnotation(fresh, existing);
  else {
    // the symbols that are annotated again: all that got a new identity in the unique mode (ReannotateDuplicates), else
    // only the always-annotated ones among them, power symbols and "#" references (ReannotateByOptions)
    const always = (f: SNode) => symbolIsPower(doc, { node: f }) || str(refField(f)![2]).startsWith("#");
    if (mode === "unique") annotatePastedUnique(doc, candidates, cfg);
    else { const list = candidates.filter(always); if (list.length) annotatePastedUnique(doc, list, Object.assign({}, cfg, { reannotate: true })); }
  }
  // groups: the members that came along, under their new ids; a named group gets a unique name (UniqueGroupName)
  const grouped = new Set<string>();
  for (let i = fresh.length - 1; i >= 0; i--) {
    const g = fresh[i]; if (g[0] !== "group") continue;
    const members = groupMembers(g).map((id) => idMap.get(id) || "").filter(Boolean);
    if (!members.length) { fresh.splice(i, 1); continue; }
    const mi = g.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "members"); const mn: SNode = ["members", ...members]; if (mi > 0) g[mi] = mn; else g.push(mn);
    for (const m of members) grouped.add(m);
  }
  for (const g of fresh) if (g[0] === "group" && str(g[1])) { let name = str(g[1]); if (groupNames.has(name)) { let k = 1; while (groupNames.has(name + k)) k++; name = name + k; } g[1] = name; groupNames.add(name); }
  if (!fresh.length) return { changes: [] as KChange[], ids: [] as string[], libs, dropped };
  // the reference point
  const idOf = (n: SNode) => (n[0] === "rule_area" ? ruleAreaId(n) : uuidOf(n)) || "", byId = new Map<string, SNode>(); for (const n of fresh) byId.set(idOf(n), n);
  const firstChild = (g: SNode): SNode | null => { for (const id of groupMembers(g)) { const m = byId.get(id); if (!m) continue; if (m[0] !== "group") return m; const c = firstChild(m); if (c) return c; } return null; };
  const flat = fresh.filter((n) => n[0] !== "group");
  const posOf = (n: SNode): Pt => {
    if (n[0] !== "group") return itemPosition(n[0] as string, n);
    let b: number[] | null = null;                                       // a group's position is its bounding box centre
    const walk = (g: SNode) => { for (const id of groupMembers(g)) { const m = byId.get(id); if (!m) continue; if (m[0] === "group") { walk(m); continue; } const it = ghost(doc, deep(m)), r = it && it.bbox; if (r) b = b ? [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])] : r.slice(); } };
    walk(n); const bb = b as number[] | null;
    return bb ? [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] : [0, 0];
  };
  let ref: Pt | null = null;
  if (o.refNear) {
    let best = Infinity; const near = o.refNear, take = (p: Pt) => { const d = Math.hypot(near[0] - p[0], near[1] - p[1]); if (d < best) { best = d; ref = [p[0], p[1]]; } };
    // connection points first (they stay on the grid), and a symbol's own position
    for (const n of flat) { const k = n[0] as string; if (CONNECTABLE.has(k)) for (const p of connPoints(doc, { kind: k, node: n })) take(p); if (k === "symbol") take(itemPosition(k, n)); }
    if (best === Infinity) for (const n of flat) for (const p of graphicPoints(n[0] as string, n)) take(p);
  }
  if (!ref) {
    // GetTopLeftItem over the items the paste selects: the groups and whatever is not in one
    const units = fresh.filter((n) => !grouped.has(idOf(n)));
    let lead: SNode | null = null, lp: Pt = [0, 0], conn: SNode | null = null, cp: Pt = [0, 0];
    for (const n of units) {
      const p = posOf(n);
      if (CONNECTABLE.has(n[0] as string) && (!conn || p[0] < cp[0] || (p[0] === cp[0] && p[1] < cp[1]))) { conn = n; cp = p; }
      if (!lead || p[0] < lp[0] || (p[0] === lp[0] && p[1] < lp[1])) { lead = n; lp = p; }
    }
    const top = conn || lead!, child = top[0] === "group" ? firstChild(top) : null;
    ref = child ? itemPosition(child[0] as string, child) : conn ? cp : lp;
  }
  const dx = r4(at[0] - ref[0]), dy = r4(at[1] - ref[1]);
  for (const n of flat) shiftNode(n[0] as string, n, dx, dy);
  const changes: KChange[] = [], items: KItem[] = [];
  for (const n of fresh) { const { item, change } = addNode(doc, n); changes.push(change); items.push(item); }
  if (!o.noJunctions) changes.push(...junctionsForNew(doc, items));
  const ids = items.map((it) => it.id);
  if (o.group !== undefined && items.length) {
    const members = fresh.filter((n) => !grouped.has(idOf(n))).map(idOf).filter(Boolean);
    const { item, change } = addNode(doc, ["group", uniqueGroupName(doc, o.group), ["uuid", K.newUuid()], ["members", ...members]]);
    changes.push(change); ids.push(item.id);
  }
  return { changes, ids, libs, dropped };
}
export function copySelection(ctx: SchCtx) {
  const items = selectedItems(ctx); if (!items.length) return false;
  clipWrite(ctx, clipboardText(ctx.doc, items), items.map((it) => it.id)); return true;
}
export function cutSelection(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  clipWrite(ctx, clipboardText(ctx.doc, items), items.map((it) => it.id));
  // SCH_EDITOR_CONTROL::Cut is doCopy() then ACTIONS::doDelete, whose FilterSelectionForLockedItems leaves the locked
  // items on the sheet (they are copied all the same); the undo step is the delete's
  const free = items.filter((it) => !isLockedItem(ctx.doc, it));
  if (!free.length) return true;
  const changes = deleteChanges(ctx.doc, free);
  setSelectionIds(ctx, []); ctx.commit(changes, "Delete"); ctx.requestRender();
  return true;
}
/** ADVANCED_CFG::m_MaxPastedTextLength: longer plain text asks before it is pasted as a text item. */
export const MAX_PASTED_TEXT = 100;
export const LONG_PASTE_MSG = "Pasting a long text text string may be very slow.  Do you want to continue?";
type KDlg = { confirm?: (title: string, message: string, okLabel?: string) => Promise<boolean>; messageBox?: (message: string, title?: string) => Promise<void> };
const kdlg = (): KDlg | null => (typeof root.KDialogs !== "undefined" && root.KDialogs ? root.KDialogs as unknown as KDlg : null);
export function pasteText(ctx: SchCtx, text: string, opts?: PasteOpts | null) {
  const parsed = parseClipboard(text);
  if (parsed) return pasteParsed(ctx, parsed, opts);
  // not schematic content: it is pasted as a text item (SCH_TEXT at the origin, centred as EDA_TEXT starts out)
  const content = str(text); if (!content) return false;
  const go = () => pasteParsed(ctx, { nodes: [["text", content, ["exclude_from_sim", "no"], ["at", 0, 0, 0], ["effects", ["font", ["size", 1.27, 1.27]]]]], libs: [] }, opts);
  if (content.length > MAX_PASTED_TEXT) {
    const kd = kdlg();
    if (kd && kd.confirm) { kd.confirm("Confirmation", LONG_PASTE_MSG, "Yes").then((ok) => { if (ok) go(); }, () => {}); return true; }
  }
  return go();
}
function pasteParsed(ctx: SchCtx, parsed: Clip, opts?: PasteOpts | null) {
  const label = (opts && opts.label) || "Paste", live = canFollow(ctx);
  const { changes, ids, libs, dropped } = pasteChanges(ctx.doc, parsed, (opts && opts.at) || snapCursor(ctx), Object.assign({ ctx }, opts, { noJunctions: live }));
  for (const file of dropped) {
    const msg = `The pasted sheet '${file}'\nwas dropped because the destination already has the sheet or one of its subsheets as a parent.`, kd = kdlg();
    if (kd && kd.messageBox) void kd.messageBox(msg); else ctx.toast(msg, 6000);
  }
  if (!changes.length) return false;
  // a pasted sheet whose file the project does not have yet gets an empty one (SCH_EDIT_FRAME::InitSheet)
  if (typeof ctx.api === "function" && ctx.project && ctx.project.projectId) for (const id of ids) {
    const it = ctx.doc.items.get(id); if (!it || it.kind !== "sheet") continue;
    const f = kids(it.node, "property").find((q) => /^Sheet ?file$/i.test(str(q[1]))); if (f && str(f[2])) ensureSheetDoc(ctx, str(f[2])).catch(() => {});
  }
  if (live && followPaste(ctx, ids, libs, (opts && opts.at) || cursorOf(ctx), label, !!(opts && opts.hover))) return true;
  if (live) changes.push(...junctionsForNew(ctx.doc, ids.map((id) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]));
  ctx.commit(changes, label);
  setSelectionIds(ctx, opts && opts.hover ? [] : ids);
  return true;
}
// Whether a paste / break can ride the cursor (a live stage with a pointer; tests switch it on with _.setFollow).
export function canFollow(ctx: SchCtx) { return S.forceFollow || (typeof document !== "undefined" && !!S.dom && !!ctx.stage); }
// KiCad's Paste / Duplicate (SCH_EDITOR_CONTROL::Paste -> SCH_MOVE_TOOL): the new items are IS_NEW, only on this
// client, and ride the cursor; the click commits them where they land, with the junctions they need there, as one
// undo step.  Esc, Ctrl+Z or Delete discards them without leaving anything behind (localCommit.Revert()).
export function followPaste(ctx: SchCtx, ids: string[], libs: string[], at: Pt, label: string, hover?: boolean) {
  const items = ids.map((id: string) => ctx.doc.items.get(id)).filter(Boolean) as KItem[]; if (!items.length) return false;
  const mode = S.dragMode; S.dragMode = "move";
  const d = beginDrag(ctx, items, at, false, { plain: true });
  if (!d) { S.dragMode = mode; return false; }
  d.pasted = true; d.local = new Set(ids); d.libs = libs || []; d.label = label; d.restoreMode = mode; d.moved = true; d.hover = !!hover;
  setSelectionIds(ctx, ids);
  return true;
}
/**
 * The clipboard has no text: an image on it is placed with the Place Image tool (SCH_ACTIONS::placeImage with the
 * bitmap), so it rides the cursor until the click.  Resolves to whether there was one.
 */
export function pasteClipboardImage(ctx: SchCtx): Promise<boolean> {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (!nav || !nav.clipboard || typeof nav.clipboard.read !== "function") return Promise.resolve(false);
  return nav.clipboard.read().then(async (list) => {
    for (const item of list) {
      const type = item.types.find((t) => t === "image/png") || item.types.find((t) => t === "image/jpeg"); if (!type) continue;
      const bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer()); if (!bytes.length) continue;
      return placeImageBytes(ctx, bytes);
    }
    return false;
  }, () => false);
}
/** SCH_DRAWING_TOOLS::PlaceImage with an image in hand: the bitmap follows the cursor, drawn at 300 PPI. */
export function placeImageBytes(ctx: SchCtx, bytes: Uint8Array): boolean {
  const base64 = bytesToBase64(bytes); if (!base64 || !editable(ctx)) return false;
  if (S.tool !== "image") { S.imageWait = true; try { switchTool(ctx, "image"); } finally { S.imageWait = false; } }   // the tool, without its file picker
  const px = imageSize(bytes), at = cursorOf(ctx);
  startCarry(ctx, "image", imageNode(at, base64), at);
  if (S.carry) S.carry.size = px ? [px[0] * 25.4 / IMAGE_PPI, px[1] * 25.4 / IMAGE_PPI] : [20, 20];
  return true;
}
/** Paste what the clipboard holds: schematic items, else its text as a text item, else an image. */
function pasteClip(ctx: SchCtx, text: string, opts?: PasteOpts | null) { if (str(text)) return pasteText(ctx, text, opts); void pasteClipboardImage(ctx); return false; }
export function pasteSelection(ctx: SchCtx, opts?: PasteOpts | null) {
  if (!editable(ctx)) return false;
  const v = clipRead(ctx);
  if (v && typeof (v as Promise<string>).then === "function") { (v as Promise<string>).then((t) => pasteClip(ctx, t, opts)); return true; }
  return pasteClip(ctx, v as string, opts);
}
// DIALOG_PASTE_SPECIAL: Reference Designators — assign unique (the default with automatic annotation on), keep
// (even if duplicated), or clear (the default with it off); OK pastes, Cancel does nothing.  As in SCH_EDITOR_CONTROL::
// Paste the clipboard is read first: with nothing on it there is no dialog.
export function pasteSpecial(ctx: SchCtx, opts?: PasteOpts | null) {
  if (!editable(ctx)) return false;
  const KD = typeof root.KDialogs !== "undefined" ? root.KDialogs : null;
  if (opts && (opts.pasteMode || opts.keepAnnotations !== undefined) || !KD || !KD.open) return pasteSelection(ctx, Object.assign({ keepAnnotations: true }, opts || {}));
  const at = snapCursor(ctx), def = S.annotateAuto ? "unique" : "remove";
  const ask = (text: string) => {
    if (!str(text)) { void pasteClipboardImage(ctx); return false; }
    let mode = def;
    const choices = [["unique", "Assign unique reference designators to pasted symbols", "Finds the next available reference designator for any designators that already exist in the design."],
      ["keep", "Keep existing reference designators, even if they are duplicated", ""], ["remove", "Clear reference designators on all pasted symbols", "Replaces reference designators with '?'."]];
    KD.open({ title: "Paste Special", width: 460,
      build(body: HTMLElement) {
        body.innerHTML = `<div class="kd-note" style="margin-bottom:6px">Reference Designators</div>` + choices.map(([v, l, tip]) => `<label class="kd-chk" style="display:flex;gap:6px;align-items:center;margin:3px 0"${tip ? ` title="${tip}"` : ""}><input type="radio" name="kd-paste-mode" value="${v}" id="kd-paste-${v}"${v === mode ? " checked" : ""}>${l}</label>`).join("")
          // the dialog's "Clear net assignments" box: only the board editor hides it; the schematic paste does not read it
          + `<label class="kd-chk" style="display:flex;gap:6px;align-items:center;margin:8px 0 3px" title="Remove the net information from all connected items before pasting"><input type="checkbox" id="kd-paste-clearnets">Clear net assignments</label>`;
        const radios = Array.from(body.querySelectorAll<HTMLInputElement>("input[name=kd-paste-mode]"));
        // focus starts on the radio box and moves to OK once a radio is chosen (onRadioBoxEvent)
        for (const r of radios) r.addEventListener("change", () => { if (!r.checked) return; mode = r.value; const dlg = body.closest(".kd-dialog"), ok = dlg && dlg.querySelector<HTMLElement>(".kd-foot .btn.primary"); if (ok) ok.focus(); });
        setTimeout(() => { const r = radios.find((x) => x.checked) || radios[0]; if (r) r.focus(); }, 0);
      },
      ok() { setTimeout(() => pasteText(ctx, text, Object.assign({}, opts || {}, { pasteMode: mode, explicit: mode === "remove" && mode !== def, at })), 0); } });
    return true;
  };
  const v = clipRead(ctx);
  if (v && typeof (v as Promise<string>).then === "function") { (v as Promise<string>).then(ask); return true; }
  return ask(v as string);
}
export function duplicateSelection(ctx: SchCtx, opts?: { hover?: boolean } | null) {
  if (!editable(ctx)) return false;
  const items = selectedItems(ctx); if (!items.length) return false;
  // Duplicate goes through Paste like the desktop's (same reference rules, the undo step is "Paste"): the copy follows
  // the cursor by the connection point nearest to where the cursor was when Ctrl+D was pressed
  const st = S as unknown as { dupHover?: boolean }, hover = !!(opts && opts.hover) || !!st.dupHover; st.dupHover = false;
  return pasteText(ctx, clipboardText(ctx.doc, items), { label: "Paste", refNear: cursorOf(ctx), hover });
}
/** GetSchItemAsText: the shown text of a text, label, text box or table (cells by TAB, rows by newline); nothing else. */
export function schItemAsText(doc: KDoc, it: KItem): string {
  const shown = (t: unknown): string => {
    const src = str(t); if (src.indexOf("${") < 0) return src;
    const X = K as unknown as { expandTextVars(t: string, r: unknown): string; varResolver(v: unknown, o: unknown): unknown; sheetTextVars(d: KDoc): unknown };
    try { return X.expandTextVars(src, X.varResolver(X.sheetTextVars(doc), { project: (doc as KDoc & { projectVars?: Record<string, unknown> | null }).projectVars || null })); } catch (e) { return src; }
  };
  if (TEXT_KINDS.has(it.kind) || LABEL_KINDS.has(it.kind) || it.kind === "text_box") return shown(it.node[1]);
  if (it.kind === "table") {
    const cols = Math.max(1, Math.round(num((kid(it.node, "column_count") || [])[1], 1)) || 1), cells = kid(it.node, "cells"), n = cells ? kids(cells, "table_cell").length : 0;
    const rows: string[] = [];
    for (let r = 0; r * cols < n; r++) { const row: string[] = []; for (let c = 0; c < cols && r * cols + c < n; c++) row.push(K.tableCellShownText(doc, it.node, r * cols + c)); rows.push(row.join("\t")); }
    return rows.join("\n");
  }
  return "";
}
export function copyAsText(ctx: SchCtx) {
  const items = selectedItems(ctx); if (!items.length) return false;
  // GetSelectedItemsAsText: each item's text trimmed, the empty ones left out, one per line
  const lines = items.map((it) => schItemAsText(ctx.doc, it).trim()).filter(Boolean);
  clipWrite(ctx, lines.join("\n")); return true;
}
/**
 * EE_GRAPHIC_TOOL::ImportGraphics once the dialog closed: the imported shapes (and the group holding them) are
 * committed where they are, or, with interactive placement, ride the cursor by the file's origin until a click
 * places them as one "Import Graphic" step (Esc drops them).
 */
export function placeImported(ctx: SchCtx, nodes: SNode[], opts: { interactive: boolean; group: boolean; label?: string }) {
  if (!editable(ctx) || !nodes.length) return false;
  const label = opts.label || "Import Graphic";
  for (const n of nodes) if (!kid(n, "uuid")) n.push(["uuid", K.newUuid()]);
  const live = opts.interactive && canFollow(ctx), at = live ? snapCursor(ctx) : null;
  if (at) for (const n of nodes) shiftNode(n[0] as string, n, at[0], at[1]);
  const all = nodes.slice();
  if (opts.group && nodes.length >= 2) all.push(["group", "", ["uuid", K.newUuid()], ["members", ...nodes.map((n) => str((kid(n, "uuid") || [])[1]))]]);
  const changes: KChange[] = [], ids: string[] = [];
  for (const n of all) { const { item, change } = addNode(ctx.doc, n); changes.push(change); ids.push(item.id); }
  const sel = opts.group && nodes.length >= 2 ? [ids[ids.length - 1]] : ids.slice();
  if (live && at && followPaste(ctx, ids, [], at, label)) { setSelectionIds(ctx, sel); return true; }
  ctx.commit(changes, label); setSelectionIds(ctx, sel); ctx.requestRender();
  return true;
}
