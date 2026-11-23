// dialogs/sym-props-logic.ts — the pure s-expression logic behind DIALOG_SYMBOL_PROPERTIES that is not shared with
// the other item dialogs: the passthrough mode, local power (LIB_SYMBOL::SetLocalPowerProp), body style names,
// the composed reference suffix, SCH_SYMBOL::SyncOtherUnits / CollectOtherUnits and the pin-to-pad maps
// (PANEL_SYMBOL_PIN_MAP, file version 20260629).
import * as VM from "../canvas/variant-model";
import { clone, drop, fieldName, fieldValue, instanceEntry, kid, kids, num, put, qnode, str } from "./sch-items-logic";

const isList = Array.isArray;
const parse = (s: string): SNode => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas.parse(s) as SNode;
const q = (s: string): string => JSON.stringify(s);

// ---------------------------------------------------------------- passthrough (sch_io_kicad_sexpr.cpp:1117-1125)
export type Passthrough = "default" | "block" | "force";
export const PASSTHROUGH_CHOICES: [Passthrough, string][] = [["default", "Default"], ["block", "Block"], ["force", "Force"]];
export function passthroughOf(n: SNode): Passthrough { const c = kid(n, "passthrough"); const v = c ? str(c[1]) : ""; return v === "block" || v === "force" ? v : "default"; }
/** Written after (dnp …) and (pin_map_override …); omitted for Default. */
export function setPassthrough(n: SNode, mode: Passthrough): void {
  if (mode === "default") { drop(n, "passthrough"); return; }
  if (kid(n, "passthrough")) { put(n, "passthrough", [mode]); return; }
  let at = -1; for (const k of ["pin_map_override", "dnp", "in_pos_files", "on_board", "in_bom", "exclude_from_sim"]) { at = n.findIndex((c, j) => j > 0 && isList(c) && c[0] === k); if (at > 0) break; }
  const node = ["passthrough", mode] as unknown as SNode;
  if (at > 0) n.splice(at + 1, 0, node); else put(n, "passthrough", [mode], ["locked", "fields_autoplaced", "uuid", "property"]);
}

// ---------------------------------------------------------------- power symbols (sch_io_kicad_sexpr_lib_cache.cpp:390-394)
export const isPowerLib = (lib: SNode | null): boolean => !!lib && !!kid(lib, "power");
export const isLocalPower = (lib: SNode | null): boolean => { const p = lib && kid(lib, "power"); return !!p && str(p[1]) === "local"; };
/** SetLocalPowerProp: (power local) vs (power global); a symbol that is not a power symbol is left alone. */
export function setLocalPower(lib: SNode, local: boolean): boolean {
  const i = lib.findIndex((c, j) => j > 0 && isList(c) && c[0] === "power"); if (i < 0) return false;
  if (isLocalPower(lib) === local) return false;
  lib[i] = ["power", local ? "local" : "global"] as unknown as SNode; return true;
}
/** The file version that introduced (power local). */
export const LOCAL_POWER_VERSION = 20250227;

// ---------------------------------------------------------------- body styles
/** The number of body styles of a library symbol: the (body_styles …) names, De Morgan, or the highest _u_b unit. */
export function bodyStyleCount(lib: SNode | null): number {
  if (!lib) return 1;
  const bs = kid(lib, "body_styles"); if (bs) { const names = bs.slice(1).filter((v) => !isList(v)); return names.length === 1 && names[0] === "demorgan" ? 2 : Math.max(1, names.length); }
  let n = 1; for (const s of kids(lib, "symbol")) { const m = /_(\d+)_(\d+)$/.exec(str(s[1])); if (m) n = Math.max(n, +m[2]); }
  return n;
}
/** The Body style: choice (TransferDataToWindow): Standard / Alternate for De Morgan, else the lib's custom names. */
export function bodyStyleNames(lib: SNode | null): string[] {
  const n = bodyStyleCount(lib); if (n < 2) return ["Standard"];
  const bs = lib && kid(lib, "body_styles"); const names = bs ? bs.slice(1).filter((v) => !isList(v)).map(str) : [];
  if (!bs || (names.length === 1 && names[0] === "demorgan")) return ["Standard", "Alternate"];
  const out: string[] = []; for (let i = 0; i < n; i++) out.push(names[i] !== undefined ? names[i] : "???");
  return out;
}
export const NO_PIN_FUNCTIONS_WITH_MULTIPLE_BODY_STYLES = "Alternate pin functions are not available on symbols with multiple body styles.";

// ---------------------------------------------------------------- reference suffixes (SCH_SHEET_PATH::ComposeRefSuffix)
export const REF_SUFFIX_FIELD = "Reference Suffix";
/** The suffix each sheet on the path contributes, root first: the sheets' "Reference Suffix" fields joined. */
export function composeRefSuffix(sheetNodes: (SNode | null)[]): string {
  let s = ""; for (const n of sheetNodes) { if (!n) continue; const p = kids(n, "property").find((q) => fieldName(q) === REF_SUFFIX_FIELD); if (p) s += fieldValue(p); }
  return s;
}
/** The Composed reference: label: the reference (unannotated ones are never suffixed) plus the path's suffix. */
export function composedReference(ref: string, suffix: string): string { return ref.endsWith("?") ? ref : ref + suffix; }

// ---------------------------------------------------------------- SyncOtherUnits (sch_symbol.cpp:2643)
const MANDATORY = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
export interface SyncWhat { field?: string; value: boolean; otherFields: boolean; exclBOM: boolean; exclBoard: boolean; exclPos: boolean; dnp: boolean; pins: boolean; pinMap: boolean }
export const SYNC_ALL: SyncWhat = { value: true, otherFields: true, exclBOM: true, exclBoard: true, exclPos: true, dnp: true, pins: true, pinMap: true };
/** SyncOtherUnits' aProperty filter: a single property edit only syncs that property. */
export function syncFor(property: string | null): SyncWhat {
  if (!property) return SYNC_ALL;
  // DIALOG_FIELD_PROPERTIES: the Value, Footprint or Datasheet text alone
  const f = /^field:(.+)$/.exec(property); if (f) return { field: f[1], value: false, otherFields: false, exclBOM: false, exclBoard: false, exclPos: false, dnp: false, pins: false, pinMap: false };
  return { value: property === "Value", otherFields: false, pins: false, exclBoard: property === "Exclude From Board", exclBOM: property === "Exclude From Bill of Materials",
    exclPos: property === "Exclude From Position Files", dnp: property === "Do not Populate", pinMap: property === "Pin Map Mode" || property === "Pin Map Name" };
}
const atXY = (n: SNode): [number, number] => { const a = kid(n, "at"); return a ? [num(a[1]), num(a[2])] : [0, 0]; };
const flagOf = (n: SNode, k: string, dflt: boolean): boolean => { const c = kid(n, k); return c ? str(c[1]) !== "no" : dflt; };
function setFlagTo(n: SNode, k: string, on: boolean): void { const c = kid(n, k); if (c) c[1] = (on ? "yes" : "no") as unknown as SNode; else put(n, k, [on ? "yes" : "no"], ["passthrough", "locked", "fields_autoplaced", "uuid", "property"]); }
function setPropValue(p: SNode, v: string): void { if (str(p[1]) === "private" && p.length > 3 && !isList(p[2])) p[3] = v as unknown as SNode; else p[2] = v as unknown as SNode; }
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;
/**
 * One other unit brought in line with `src` (a clone of `dst` is returned; null when nothing changed): Value, the
 * other non-reference fields (added at the same offset from the symbol, extra non-mandatory ones removed), the
 * exclude / DNP flags, the pin map override and the alternate pin assignments.
 */
export function syncUnit(src: SNode, dst: SNode, what: SyncWhat = SYNC_ALL, inst?: SyncInstance | null): SNode | null {
  if (inst && !VM.isDefaultVariant(inst.variant)) return syncUnitVariant(src, dst, what, inst);
  const out = clone(dst);
  const props = (n: SNode) => kids(n, "property");
  const find = (n: SNode, name: string) => props(n).find((p) => fieldName(p) === name) || null;
  if (what.value) { const s = find(src, "Value"), d = find(out, "Value"); if (s && d) setPropValue(d, fieldValue(s)); }
  if (what.field) { const s = find(src, what.field), d = find(out, what.field); if (s && d) setPropValue(d, fieldValue(s)); }
  if (what.otherFields) {
    const [sx, sy] = atXY(src), [dx, dy] = atXY(out);
    for (const f of props(src)) {
      const name = fieldName(f); if (name === "Reference" || name === "Value") continue;
      const o = find(out, name);
      if (o) setPropValue(o, fieldValue(f));
      else {
        const nf = clone(f); const a = kid(nf, "at"); if (a) { a[1] = r4(num(a[1]) - sx + dx) as unknown as SNode; a[2] = r4(num(a[2]) - sy + dy) as unknown as SNode; }
        const last = out.reduce((acc: number, c, j) => (j > 0 && isList(c) && c[0] === "property" ? j : acc), -1);
        out.splice(last > 0 ? last + 1 : out.length, 0, nf);
      }
    }
    for (let j = out.length - 1; j > 0; j--) { const c = out[j]; if (isList(c) && c[0] === "property") { const name = fieldName(c as SNode); if (!MANDATORY.includes(name) && !find(src, name)) out.splice(j, 1); } }
  }
  if (what.exclBOM) setFlagTo(out, "in_bom", flagOf(src, "in_bom", true));
  if (what.exclBoard) setFlagTo(out, "on_board", flagOf(src, "on_board", true));
  if (what.exclPos && (kid(src, "in_pos_files") || kid(out, "in_pos_files"))) setFlagTo(out, "in_pos_files", flagOf(src, "in_pos_files", true));
  if (what.dnp) setFlagTo(out, "dnp", flagOf(src, "dnp", false));
  // SetPinMapOverride( GetPinMapOverride( &aSourceSheet ), &sheet ): the source's override with its delegation resolved
  if (what.pinMap) VM.writeSymbolPinMapOverride(out, inst && inst.srcPinMap ? inst.srcPinMap : VM.symbolPinMapOverride(src));
  if (what.pins) {
    const altOf = new Map<string, string>(); for (const p of kids(src, "pin")) { const a = kid(p, "alternate"); altOf.set(str(p[1]), a ? str(a[1]) : ""); }
    for (const p of kids(out, "pin")) {
      if (!altOf.has(str(p[1]))) continue;
      const want = altOf.get(str(p[1])) || ""; drop(p, "alternate");
      if (want) { const u = p.findIndex((c, j) => j > 0 && isList(c) && c[0] === "uuid"); p.splice(u > 0 ? u + 1 : p.length, 0, qnode("alternate", want)); }
    }
  }
  return JSON.stringify(out) === JSON.stringify(dst) ? null : out;
}
/** The sheet paths a variant-aware sync reads from (`srcPath`) and writes to (`dstPaths`), and the variant. */
export interface SyncInstance { variant: string; srcPath: string | null; dstPaths: (string | null)[]; ver?: number | null;
  /** the source's GetPinMapOverride( &aSourceSheet, aVariantName ), a delegation to unit 1 already resolved */
  srcPinMap?: VM.PinMapOverrideState }
/**
 * SyncOtherUnits with a variant name: every copy goes through the variant setters for the other unit's sheet path
 * (SetFieldText / SetText / SetExcludedFromBOM / SetExcludedFromBoard / SetExcludedFromPosFiles / SetDNP with
 * &sheet, aVariantName), reading the source through the variant on its own path; the base fields and flags of the
 * other unit stay as they are.  A field the other unit lacks is added as a copy of the source's (base text) first.
 */
function syncUnitVariant(src: SNode, dst: SNode, what: SyncWhat, inst: SyncInstance): SNode | null {
  let out = clone(dst);
  const props = (n: SNode) => kids(n, "property");
  const find = (n: SNode, name: string) => props(n).find((p) => fieldName(p) === name) || null;
  const view = VM.symbolViewForVariant(src, inst.variant, inst.srcPath, inst.ver), flags = VM.symbolFlagsForVariant(src, inst.variant, inst.srcPath, inst.ver);
  const fields: Record<string, string> = {};
  const take = (name: string) => { const s = find(view, name); if (s && find(out, name)) fields[name] = fieldValue(s); };
  if (what.value) take("Value");
  if (what.field) take(what.field);
  if (what.otherFields) {
    const [sx, sy] = atXY(src), [dx, dy] = atXY(out);
    for (const f of props(src)) {
      const name = fieldName(f); if (name === "Reference" || name === "Value") continue;
      if (!find(out, name)) {
        const nf = clone(f); const a = kid(nf, "at"); if (a) { a[1] = r4(num(a[1]) - sx + dx) as unknown as SNode; a[2] = r4(num(a[2]) - sy + dy) as unknown as SNode; }
        const last = out.reduce((acc: number, c, j) => (j > 0 && isList(c) && c[0] === "property" ? j : acc), -1);
        out.splice(last > 0 ? last + 1 : out.length, 0, nf);
      }
      take(name);
    }
    for (let j = out.length - 1; j > 0; j--) { const c = out[j]; if (isList(c) && c[0] === "property") { const name = fieldName(c as SNode); if (!MANDATORY.includes(name) && !find(src, name)) out.splice(j, 1); } }
  }
  const fl: Partial<VM.SymFlags> = {};
  if (what.exclBOM) fl.excludedFromBOM = flags.excludedFromBOM;
  if (what.exclBoard) fl.excludedFromBoard = flags.excludedFromBoard;
  if (what.exclPos) fl.excludedFromPosFiles = flags.excludedFromPosFiles;
  if (what.dnp) fl.dnp = flags.dnp;
  for (const p of inst.dstPaths) out = VM.setSymbolVariant(out, inst.variant, { flags: fl, fields }, p, inst.ver);
  if (what.pinMap) {
    const o = inst.srcPinMap || VM.symbolPinMapOverride(src, inst.variant, inst.srcPath);
    for (const p of inst.dstPaths) out = VM.setSymbolPinMapOverride(out, o, inst.variant, p, inst.ver);
  }
  if (what.pins) {
    const altOf = new Map<string, string>(); for (const p of kids(src, "pin")) { const a = kid(p, "alternate"); altOf.set(str(p[1]), a ? str(a[1]) : ""); }
    for (const p of kids(out, "pin")) {
      if (!altOf.has(str(p[1]))) continue;
      const want = altOf.get(str(p[1])) || ""; drop(p, "alternate");
      if (want) { const u = p.findIndex((c, j) => j > 0 && isList(c) && c[0] === "uuid"); p.splice(u > 0 ? u + 1 : p.length, 0, qnode("alternate", want)); }
    }
  }
  return JSON.stringify(out) === JSON.stringify(dst) ? null : out;
}
export interface UnitInstance { path: string; project: string | null }
export interface OtherUnitHit<T> { sheet: T; item: KItem }
/**
 * CollectOtherUnits over the hierarchy: on each sheet instance, the (non-power) symbols whose reference on that
 * path is `ref`, with the same lib_id and a different unit.
 */
export function collectOtherUnits<T extends { path: string; doc: KDoc }>(sheets: T[], self: KItem, ref: string, unit: number, libId: string, project: string | null, isPower: (doc: KDoc, it: KItem) => boolean): OtherUnitHit<T>[] {
  const out: OtherUnitHit<T>[] = [];
  for (const sh of sheets) for (const it of sh.doc.items.values()) {
    if (it.kind !== "symbol" || it.id === self.id) continue;
    const li = kid(it.node, "lib_id"); if (!li || str(li[1]) !== libId || isPower(sh.doc, it)) continue;
    const e = instanceEntry(it.node, sh.path, project);
    const r = e && kid(e, "reference") ? str((kid(e, "reference") as SNode)[1]) : (() => { const p = kids(it.node, "property").find((q) => fieldName(q) === "Reference"); return p ? fieldValue(p) : ""; })();
    const u = e && kid(e, "unit") ? num((kid(e, "unit") as SNode)[1], 1) : num((kid(it.node, "unit") || [0, 1])[1], 1);
    if (r === ref && u !== unit) out.push({ sheet: sh, item: it });
  }
  return out;
}
export const isAnnotated = (ref: string): boolean => !!ref && !ref.endsWith("?");

// ---------------------------------------------------------------- pin-to-pad maps (PANEL_SYMBOL_PIN_MAP, 20260629)
export const PIN_MAP_VERSION = 20260629;
export interface PinMap { name: string; entries: Map<string, string> }
export interface PinMapState { maps: PinMap[]; footprints: Map<string, string> /* map name -> footprint */; unmapped: string[] }
/** (pin_maps (pin_map "NAME" (entry "pin" "pad")…)…) and (associated_footprints (footprint "lib:fp" (map "NAME"))…). */
export function readPinMaps(lib: SNode | null): PinMapState {
  const st: PinMapState = { maps: [], footprints: new Map(), unmapped: [] }; if (!lib) return st;
  const pm = kid(lib, "pin_maps");
  if (pm) for (const m of kids(pm, "pin_map")) { const e = new Map<string, string>(); for (const en of kids(m, "entry")) e.set(str(en[1]), str(en[2])); st.maps.push({ name: str(m[1]), entries: e }); }
  const af = kid(lib, "associated_footprints");
  if (af) for (const f of kids(af, "footprint")) { const m = kid(f, "map"); if (m) st.footprints.set(str(m[1]), str(f[1])); else st.unmapped.push(str(f[1])); }
  return st;
}
/** Writes the maps back onto a copy of the library symbol, placed before the first unit (symbol "…_u_b"). */
export function writePinMaps(lib: SNode, st: PinMapState): void {
  const first = lib.findIndex((c, j) => j > 1 && isList(c) && (c[0] === "associated_footprints" || c[0] === "pin_maps"));
  drop(lib, "pin_maps"); drop(lib, "associated_footprints");
  const nodes: SNode[] = [];
  // savePinMapData: (associated_footprints …) first, then (pin_maps …)
  const fps = st.maps.filter((m) => st.footprints.get(m.name));
  if (fps.length || st.unmapped.length) nodes.push(parse("(associated_footprints " + fps.map((m) => "(footprint " + q(st.footprints.get(m.name) as string) + " (map " + q(m.name) + "))").concat(st.unmapped.map((f) => "(footprint " + q(f) + ")")).join(" ") + ")"));
  if (st.maps.length) nodes.push(parse("(pin_maps " + st.maps.map((m) => "(pin_map " + q(m.name) + Array.from(m.entries).filter(([pin, pad]) => pad !== "" && pad !== pin).map(([pin, pad]) => " (entry " + q(pin) + " " + q(pad) + ")").join("") + ")").join(" ") + ")"));
  if (!nodes.length) return;
  let at = first > 0 && first <= lib.length ? first : -1;
  if (at < 0) at = lib.findIndex((c, j) => j > 1 && isList(c) && c[0] === "symbol"); if (at < 0) at = lib.findIndex((c, j) => j > 1 && isList(c) && c[0] === "embedded_fonts"); if (at < 0) at = lib.length;
  lib.splice(at, 0, ...nodes);
}
export const pinMapCell = (m: PinMap, pin: string): string => m.entries.get(pin) || pin;
/** A cell equal to the pin number is the identity mapping and is not stored. */
export function setPinMapCell(m: PinMap, pin: string, pad: string): void { pad = pad.trim(); if (!pad || pad === pin) m.entries.delete(pin); else m.entries.set(pin, pad); }
export function newMapName(maps: PinMap[]): string { let n = 1; const s = new Set(maps.map((m) => m.name)); while (s.has("map" + n)) n++; return "map" + n; }
export const PIN_MAP_MSG = {
  pickColumn: "Click a pin map column to choose which map to remove.",
  removeAsk: (name: string): string => `Remove pin map '${name}' and its footprint association?`,
  exists: (name: string): string => `A pin map named '${name}' already exists.`,
  badFootprint: "Invalid footprint identifier.",
  fpTaken: "That footprint is already assigned to another pin map.",
  reset: (name: string): string => `Reset '${name}' to 1:1`,
};
/** LIB_ID::Parse as the footprint cell's validator: "lib:item", neither part empty, no illegal characters. */
export function validFootprintId(s: string): boolean { const m = /^([^:]+):(.+)$/.exec(s.trim()); return !!m && !/[\s"]/.test(m[1]) && !/["]/.test(m[2]); }
/** (pin_map_override (mode library_default|named_map|identity|delegate) (map "NAME") (edit "pin" "pad")…) */
export type PinMapMode = "library_default" | "named_map" | "identity" | "delegate";
export function readOverride(n: SNode): { mode: PinMapMode; map: string; edits: Map<string, string> } | null {
  const o = kid(n, "pin_map_override"); if (!o) return null;
  const m = kid(o, "mode"), mp = kid(o, "map"); const edits = new Map<string, string>(); for (const e of kids(o, "edit")) edits.set(str(e[1]), str(e[2]));
  return { mode: (m ? str(m[1]) : "library_default") as PinMapMode, map: mp ? str(mp[1]) : "", edits };
}
export type PinMapOverride = NonNullable<ReturnType<typeof readOverride>>;
export const defaultOverride = (): PinMapOverride => ({ mode: "library_default", map: "", edits: new Map() });
/** formatPinMapOverride: omitted when IsDefault (library default, no edits); the map name only in named-map mode;
 *  written after (dnp …). */
export function writeOverride(n: SNode, o: PinMapOverride): void {
  drop(n, "pin_map_override");
  if (o.mode === "library_default" && !o.edits.size) return;
  const node = parse("(pin_map_override (mode " + o.mode + ")" + (o.mode === "named_map" && o.map ? " (map " + q(o.map) + ")" : "")
    + Array.from(o.edits).map(([pin, pad]) => " (edit " + q(pin) + " " + q(pad) + ")").join("") + ")");
  const at = n.findIndex((c, j) => j > 0 && isList(c) && c[0] === "dnp");
  if (at > 0) n.splice(at + 1, 0, node); else put(n, "pin_map_override", node.slice(1), ["passthrough", "locked", "fields_autoplaced", "uuid", "property"]);
}
/** LIB_SYMBOL::GetEffectiveAssociatedFootprints, in file order. */
export function associatedFootprints(lib: SNode | null): { footprint: string; map: string }[] {
  const af = lib && kid(lib, "associated_footprints"); if (!af) return [];
  return kids(af, "footprint").map((f) => { const m = kid(f, "map"); return { footprint: str(f[1]), map: m ? str(m[1]) : "" }; });
}
/** activeAssociatedFootprint (sch_symbol.cpp): the one whose footprint is the symbol's Footprint field, else the first. */
export function activeAssociatedFootprint(lib: SNode | null, footprintField: string): { footprint: string; map: string } | null {
  const af = associatedFootprints(lib); return af.find((a) => a.footprint === footprintField) || af[0] || null;
}
/** SCH_PIN::GetEffectivePadNumber with no footprint pads (the painter / Properties path): a named map, else the map
 *  associated with the symbol's footprint, patched by the instance's edits unless identity is forced. */
export function effectivePadNumber(lib: SNode | null, o: PinMapOverride, footprintField: string, pinNumber: string): string {
  const st = readPinMaps(lib); let map: PinMap | undefined;
  if (o.mode === "named_map") map = st.maps.find((m) => m.name === o.map);
  if (!map && o.mode !== "identity") { const a = associatedFootprints(lib).find((x) => x.footprint === footprintField); if (a) map = st.maps.find((m) => m.name === a.map); }
  if (o.mode !== "identity" && o.edits.has(pinNumber)) return o.edits.get(pinNumber) as string;
  return map && map.entries.has(pinNumber) ? map.entries.get(pinNumber) as string : pinNumber;
}

// ---------------------------------------------------------------- PANEL_EMBEDDED_FILES on a symbol's library copy
/** The names of the library symbol's (embedded_files (file (name …) …)). */
export function embeddedFileNames(lib: SNode | null): string[] {
  const ef = lib && kid(lib, "embedded_files"); return ef ? kids(ef, "file").map((f) => str((kid(f, "name") || [])[1])) : [];
}
/**
 * PANEL_EMBEDDED_FILES::TransferDataFromWindow on the library copy: the files not in `keep` go, each added (file …)
 * form replaces the file of its name or joins the list, and (embedded_fonts yes|no) follows the box ((embedded_fonts)
 * comes before (embedded_files), both after the units).  True when the node changed.
 */
export function applyEmbeddedFiles(lib: SNode, keep: string[], added: string[], embedFonts: boolean): boolean {
  const before = JSON.stringify(lib);
  let ef = kid(lib, "embedded_files");
  if (ef) { const names = new Set(keep); for (let j = ef.length - 1; j >= 1; j--) { const c = ef[j]; if (isList(c) && c[0] === "file" && !names.has(str((kid(c as SNode, "name") || [])[1]))) ef.splice(j, 1); } }
  for (const text of added) {
    const node = parse(text), name = str((kid(node, "name") || [])[1]);
    if (!ef) { ef = ["embedded_files"] as unknown as SNode; lib.push(ef); }
    const i = ef.findIndex((c, j) => j > 0 && isList(c) && c[0] === "file" && str((kid(c as SNode, "name") || [])[1]) === name);
    if (i > 0) ef[i] = node; else ef.push(node);
  }
  if (ef && !kids(ef, "file").length) lib.splice(lib.indexOf(ef), 1);
  const fonts = kid(lib, "embedded_fonts");
  if (fonts) { if (yesOf(fonts) !== embedFonts) fonts[1] = (embedFonts ? "yes" : "no") as unknown as SNode; }
  else if (embedFonts) { const at = lib.findIndex((c, j) => j > 1 && isList(c) && c[0] === "embedded_files"); lib.splice(at > 0 ? at : lib.length, 0, parse("(embedded_fonts yes)")); }
  return JSON.stringify(lib) !== before;
}
const yesOf = (n: SNode): boolean => str(n[1]) !== "no";

// ---------------------------------------------------------------- the Pin Functions table's order
/**
 * PIN_NUMBERS::Compare (common/pin_numbers.cpp): the strings split into numbers (digits with an optional sign and
 * '.', 'v' or 'V' as the decimal point) and the text between them; numbers compare by value, a number sorts before
 * text, text compares as text.  Negative, zero or positive.
 */
export function pinNumbersCompare(lhs: string, rhs: string): number {
  const digit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  const next = (s: string, at: { i: number }): string => {
    if (at.i >= s.length) return "";
    const begin = at.i; let c = s[at.i];
    if (digit(c) || ((c === "+" || c === "-") && at.i < s.length - 1 && digit(s[at.i + 1]))) {
      while (++at.i < s.length) { c = s[at.i]; if (digit(c) || c === "v" || c === "V" || c === ".") continue; break; }
    } else {
      while (++at.i < s.length) { if (digit(s[at.i])) break; }
    }
    return s.slice(begin, at.i);
  };
  const a = { i: 0 }, b = { i: 0 };
  for (;;) {
    const x = next(lhs, a), y = next(rhs, b);
    if (!x && !y) return 0;
    if (!x) return -2;
    if (!y) return 2;
    const nx = /[0-9]/.test(x), ny = /[0-9]/.test(y);
    if (nx) {
      if (!ny) return -2;
      const v1 = parseFloat(x.replace(/[vV]/, ".")) || 0, v2 = parseFloat(y.replace(/[vV]/, ".")) || 0;
      if (v1 < v2) return v1 === v2 - 1 ? -1 : -2;
      if (v1 > v2) return v1 === v2 + 1 ? 1 : 2;
    } else {
      if (ny) return 2;
      if (x !== y) return x < y ? -1 : 1;
    }
  }
}
/** SCH_PIN_TABLE_DATA_MODEL::compare: Number / Base Name / Alternate with PIN_NUMBERS::Compare, type and style without
 *  case; rows that tie fall back to the pin number. */
export function pinRowCompare(a: { number: string; name: string; alt: string; type: string; style: string }, b: { number: string; name: string; alt: string; type: string; style: string }, key: string, asc: boolean): number {
  const val = (r: typeof a, k: string): string => (k === "alt" ? r.alt || r.name : k === "name" ? r.name : k === "type" ? r.type : k === "style" ? r.style : r.number);
  let k = key, x = val(a, k), y = val(b, k);
  if (x === y) { k = "number"; x = val(a, k); y = val(b, k); }
  const c = k === "type" || k === "style" ? (x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0) : pinNumbersCompare(x, y);
  return asc ? c : -c;
}
