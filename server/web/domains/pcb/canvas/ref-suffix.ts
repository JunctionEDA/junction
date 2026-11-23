// kicad-canvas / ref-suffix — the Reference Suffix of reused sheets (annotation.reused_sheet_suffixes):
// SCH_SHEET::GetRefSuffix / ResolveRefSuffix / NextRefSuffix, SCH_SHEET_PATH::ComposeRefSuffix,
// SCH_SHEET_LIST::StripRefSuffixes, SCHEMATIC::RefreshRefSuffixes / GetRefSuffix / GetPackageRefSuffix /
// GetUnitRefSuffix / RefSuffixCollisions / FormatRefSuffixes (MAIL_SCH_GET_REF_SUFFIXES).
//
// KiCad keeps a symbol's base reference in memory and composes the sheet path's suffix when it shows or saves it, so
// a file holds the composed reference ("R1_L").  The browser edits the file itself: every instance entry holds the
// composed reference, and the base is what StripRefSuffixes takes off at load.  Pure functions over parsed documents.
import { kid, kids, num, str } from "./sexpr";
import { alphabeticFromIndex, expandTextVars, finalizeTextVars, indexFromAlphabetic, RESOLVE_TEXT_RECURSION_DEPTH } from "./sheet";
import { unescapeText } from "./text";

/** SHEET_REF_SUFFIX_UNTRANSLATED: the sheet field whose text every symbol below the sheet composes with. */
export const REF_SUFFIX_FIELD = "Reference Suffix";
const MANDATORY = new Set(["Sheetname", "Sheetfile", "Sheet name", "Sheet file"]);
const field = (sheet: SNode | null, name: string): SNode | null => (sheet ? kids(sheet, "property").find((p) => str(p[1]) === name) || null : null);

/**
 * SCH_SHEET::ResolveRefSuffix( aText, aParentPath ): ${NAME} names a user field of this sheet, else of the sheets above it
 * (nearest first) — never the suffix field itself or a mandatory one — expanded to ADVANCED_CFG's recursion depth; the
 * rest stays as written (FOR_ERC_DRC, finalised as INTERNAL).  `parents` runs from the top sheet down to this one's parent.
 */
export function resolveRefSuffix(text: string, sheet: SNode | null, parents: (SNode | null)[]): string {
  if (!text) return "";
  let depth = 0;
  const resolver = (token: string): string | null => {
    let f = field(sheet, token);
    for (let ii = parents.length; !f && ii > 0; --ii) f = field(parents[ii - 1], token);
    if (!f || str(f[1]) === REF_SUFFIX_FIELD || MANDATORY.has(str(f[1]))) return null;
    let value = unescapeText(str(f[2]));
    if (value.includes("${") && depth < RESOLVE_TEXT_RECURSION_DEPTH) { ++depth; value = expandTextVars(value, resolver, depth, { erc: true }); --depth; }
    return value;
  };
  return finalizeTextVars(expandTextVars(unescapeText(text), resolver, undefined, { erc: true, finalize: false }), true);
}
/** SCH_SHEET::GetRefSuffix( aParentPath ): the sheet's own suffix, resolved; empty without the field. */
export function sheetRefSuffix(sheet: SNode | null, parents: (SNode | null)[]): string {
  const f = field(sheet, REF_SUFFIX_FIELD);
  return f ? resolveRefSuffix(str(f[2]), sheet, parents) : "";
}
/** The raw text of a sheet's Reference Suffix field (HasRefSuffixFields looks at it unresolved). */
export function refSuffixText(sheet: SNode | null): string { const f = field(sheet, REF_SUFFIX_FIELD); return f ? str(f[2]) : ""; }
/** SCH_SHEET_PATH::ComposeRefSuffix: the suffixes of the sheets on the path joined, the top sheet first (the root has no sheet symbol). */
export function composeRefSuffix(sheets: (SNode | null)[]): string {
  let s = "";
  sheets.forEach((sh, i) => { if (sh) s += sheetRefSuffix(sh, sheets.slice(0, i)); });
  return s;
}
/** stripRefSuffix: the reference without its suffix, or null when it does not end in it (or is unannotated). */
export function stripRefSuffix(ref: string, suffix: string): string | null {
  if (!suffix || ref.length <= suffix.length || !ref.endsWith(suffix) || ref.endsWith("?")) return null;
  return ref.slice(0, ref.length - suffix.length);
}

/**
 * SCH_SHEET::NextRefSuffix: the suffix a pasted copy of a sheet takes.  A suffix not in use is kept; otherwise a
 * trailing number, or a trailing run of up to two capitals or two small letters, continues past the highest of its
 * series (_M1 -> _M4 with _M3 in use, _M09 -> _M10, _Z -> _AA); any other suffix is kept verbatim.
 */
export function nextRefSuffix(suffix: string, inUse: Iterable<string>, isTaken?: ((s: string) => boolean) | null): string {
  const used = inUse instanceof Set ? inUse as Set<string> : new Set(inUse);
  const taken = (c: string): boolean => used.has(c) || (!!isTaken && isTaken(c));
  if (!suffix || !taken(suffix)) return suffix;
  const splitTail = (text: string, isTail: (c: string) => boolean): number => { let stem = text.length; while (stem > 0 && isTail(text[stem - 1])) --stem; return stem; };
  const isDigit = (c: string): boolean => c >= "0" && c <= "9", isUpper = (c: string): boolean => c >= "A" && c <= "Z", isLower = (c: string): boolean => c >= "a" && c <= "z";
  const digitStem = splitTail(suffix, isDigit);
  if (digitStem < suffix.length) {
    const stem = suffix.slice(0, digitStem), width = suffix.length - digitStem;
    let highest = 0n;
    for (const u of used) if (u.startsWith(stem) && u.length > stem.length && splitTail(u, isDigit) === stem.length) { const v = BigInt(u.slice(stem.length)); if (v > highest) highest = v; }
    // a wrapped counter restarts at zero, so it still needs the in-use check (unsigned long long)
    for (let next = highest + 1n; ; next = (next + 1n) & 0xFFFFFFFFFFFFFFFFn) { const c = stem + next.toString().padStart(width, "0"); if (!taken(c)) return c; }
  }
  // longer letter runs are words such as _LEFT, not a series
  const letterSeries = (isLetter: (c: string) => boolean, lower: boolean): string | null => {
    const stem = splitTail(suffix, isLetter), run = suffix.length - stem;
    if (run === 0 || run > 2) return null;
    const prefix = suffix.slice(0, stem); let highest = -1;
    for (const u of used) { const us = splitTail(u, isLetter); if (us === stem && u.length - us <= 2 && u.startsWith(prefix)) highest = Math.max(highest, indexFromAlphabetic(u.slice(stem).toUpperCase())); }
    // overflow such as _ZZ to _AAA leaves the series, so skip what it already holds
    for (let next = highest + 1; ; next++) { let letters = alphabeticFromIndex(next); if (lower) letters = letters.toLowerCase(); if (!taken(prefix + letters)) return prefix + letters; }
  };
  return letterSeries(isUpper, false) ?? letterSeries(isLower, true) ?? suffix;
}

// ---------------------------------------------------------------- the hierarchy's suffixes
/** One sheet path of the hierarchy (SCH_SHEET_PATH) in hierarchy order: its file, the instance path its symbols record and the sheet symbols from the top down. */
export interface SuffixPath { doc: KDoc; path: string; sheets: (SNode | null)[] }
/** A placed symbol's instance on a path: SCH_SYMBOL_INSTANCE's reference and unit (the field and the symbol's own unit without an entry). */
export function instanceOf(node: SNode, path: string): { ref: string; unit: number; entry: boolean } {
  for (const inst of kids(node, "instances")) for (const pr of kids(inst, "project")) for (const e of kids(pr, "path")) {
    if (str(e[1]) !== path) continue;
    const r = kid(e, "reference"), u = kid(e, "unit"), own = kid(node, "unit");
    return { ref: r ? str(r[1]) : "", unit: u ? num(u[1], 1) : own ? num(own[1], 1) : 1, entry: true };
  }
  const p = kids(node, "property").find((q) => str(q[1]) === "Reference"), own = kid(node, "unit");
  return { ref: p ? str(p[2]) : "", unit: own ? num(own[1], 1) : 1, entry: false };
}
const libIdOf = (node: SNode): string => str((kid(node, "lib_id") || [])[1]);
export const suffixKey = (uuid: string, path: string): string => uuid + "\0" + path;

/**
 * The hierarchy's suffix state: SCHEMATIC::RefreshRefSuffixes (each path's composed suffix), the bases
 * StripRefSuffixes takes the files' references to, and updatePackageSuffixes (the suffix each package spanning
 * suffixed sheets composes with: its units' lowest).  `mode` is SCHEMATIC_SETTINGS::m_AnnotateReusedSheetSuffixes;
 * `unitCount` gives LIB_SYMBOL::GetUnitCount of a placed symbol.
 */
export interface RefSuffixes {
  mode: boolean;
  /** HasRefSuffixes: suffix numbering is on and a path composes a suffix */
  has: boolean;
  /** HasRefSuffixFields: a sheet has suffix text, even text that resolves to nothing */
  hasFields: boolean;
  /** SCH_SHEET_PATH::ComposeRefSuffix of each path, whatever the mode */
  composed: Map<string, string>;
  /** SCHEMATIC::GetRefSuffix( path ): the composed suffix while suffixes are on, else empty */
  suffix(path: string): string;
  /** the in-memory base of a symbol on a path (SCH_SYMBOL_INSTANCE::m_Reference after StripRefSuffixes) */
  base(uuid: string, path: string): string | null;
  /** SCH_SYMBOL_INSTANCE::m_RefLacksSuffix: the saved reference lacked its path's suffix */
  lacks(uuid: string, path: string): boolean;
  /** SCHEMATIC::GetPackageRefSuffix */
  packageSuffix(uuid: string, path: string): string;
  /** SCHEMATIC::GetUnitRefSuffix */
  unitSuffix(uuid: string, path: string, unit: number): string;
  /** SCHEMATIC::PackageRefSuffixes: (uuid, path) -> package suffix where it is another sheet's */
  packages: Map<string, string>;
  /** SCHEMATIC::SplitUnitSymbols / CopiesSelectDifferentUnits: copies on a reused sheet selecting different units */
  split: Set<string>;
  paths: SuffixPath[];
}
export function refSuffixes(paths: SuffixPath[], mode: boolean, unitCount: (doc: KDoc, node: SNode) => number): RefSuffixes {
  const composed = new Map<string, string>(); let hasFields = false;
  for (const p of paths) { const last = p.sheets.length ? p.sheets[p.sheets.length - 1] : null; if (refSuffixText(last)) hasFields = true; composed.set(p.path, composeRefSuffix(p.sheets)); }
  const has = mode && [...composed.values()].some((s) => !!s);
  const suffix = (path: string): string => (has ? composed.get(path) || "" : "");
  // ---- StripRefSuffixes (sch_sheet_path.cpp)
  const base = new Map<string, string>(), lacks = new Set<string>();
  type Pkg = Map<string, Set<number>>;
  const packages: Pkg = new Map(), pk = (b: string, lib: string, s: string): string => b + "\0" + lib + "\0" + s;
  const suffixSet = new Set<string>();
  const multi: { key: string; stored: string; suffix: string; unit: number; lib: string; ownBase: string | null }[] = [];
  for (const p of paths) {
    const sfx = composed.get(p.path) || ""; suffixSet.add(sfx);
    for (const it of p.doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const inst = instanceOf(it.node, p.path); if (!inst.entry) continue;
      const key = suffixKey(it.id, p.path), ref = inst.ref;
      base.set(key, ref);
      if (unitCount(p.doc, it.node) > 1) {
        let own: string | null = null;
        if (!sfx) own = ref; else { const s = stripRefSuffix(ref, sfx); if (s !== null) own = s; }
        if (own !== null) { base.set(key, own); const k = pk(own, libIdOf(it.node), sfx); let u = packages.get(k); if (!u) { u = new Set(); packages.set(k, u); } u.add(inst.unit); }
        if (sfx) multi.push({ key, stored: ref, suffix: sfx, unit: inst.unit, lib: libIdOf(it.node), ownBase: own });
      } else {
        const s = stripRefSuffix(ref, sfx);
        if (s !== null) base.set(key, s);
        else if (sfx && !ref.endsWith("?")) lacks.add(key);
      }
    }
  }
  const sortedSuffixes = [...suffixSet].sort();
  // claimPackageUnit: older versions store a package's lowest suffix on every unit, so only a lower suffix can own it
  const claim = (stored: string, lib: string, unit: number, own: string): string | null => {
    for (const s of sortedSuffixes) {
      if (s >= own) break;
      let b: string | null = stored;
      if (s) b = stripRefSuffix(stored, s);
      if (b === null) continue;
      const u = packages.get(pk(b, lib, s));
      if (u && !u.has(unit)) { u.add(unit); return b; }
    }
    return null;
  };
  for (const m of multi) {
    const b = claim(m.stored, m.lib, m.unit, m.suffix);
    if (b !== null) base.set(m.key, b);
    else if (m.ownBase !== null) base.set(m.key, m.ownBase);
    else { base.set(m.key, m.stored); if (!m.stored.endsWith("?")) lacks.add(m.key); }
  }
  // ---- updatePackageSuffixes (schematic.cpp)
  const pkgs = new Map<string, string>(), unitSfx = new Map<string, Map<number, string>>(), split = new Set<string>();
  const groups = new Map<string, { key: string; unit: number; suffix: string }[]>(), units = new Map<string, Set<number>>(), repeated = new Set<string>(), firstUnit = new Map<string, number>();
  for (const p of paths) for (const it of p.doc.items.values()) {
    if (it.kind !== "symbol" || unitCount(p.doc, it.node) <= 1) continue;
    const inst = instanceOf(it.node, p.path); if (!inst.entry) continue;
    const f = firstUnit.get(it.id); if (f === undefined) firstUnit.set(it.id, inst.unit); else if (f !== inst.unit) split.add(it.id);
    const key = suffixKey(it.id, p.path), b = base.get(key) || "";
    if (!b || b.endsWith("?")) continue;
    const gk = b + "\0" + libIdOf(it.node);
    let us = units.get(gk); if (!us) { us = new Set(); units.set(gk, us); }
    if (us.has(inst.unit)) repeated.add(gk); else us.add(inst.unit);
    let g = groups.get(gk); if (!g) { g = []; groups.set(gk, g); }
    g.push({ key, unit: inst.unit, suffix: suffix(p.path) });
  }
  for (const [gk, members] of groups) {
    if (repeated.has(gk)) continue;
    let lowest = members[0].suffix; for (const m of members) if (m.suffix < lowest) lowest = m.suffix;
    for (const m of members) if (m.suffix !== lowest) pkgs.set(m.key, lowest);
    if (members.some((m) => m.suffix !== lowest)) { const um = new Map<number, string>(); for (const m of members) um.set(m.unit, m.suffix); unitSfx.set(gk, um); }
  }
  const keyOf = new Map<string, { gk: string; unit: number }>();
  for (const [gk, members] of groups) for (const m of members) keyOf.set(m.key, { gk, unit: m.unit });
  const packageSuffix = (uuid: string, path: string): string => { if (!has) return ""; const v = pkgs.get(suffixKey(uuid, path)); return v !== undefined ? v : suffix(path); };
  return {
    mode, has, hasFields, composed, suffix, paths, packages: has ? pkgs : new Map(), split,
    base: (uuid, path) => { const v = base.get(suffixKey(uuid, path)); return v === undefined ? null : v; },
    lacks: (uuid, path) => lacks.has(suffixKey(uuid, path)),
    packageSuffix,
    unitSuffix: (uuid, path, unit) => {
      if (!has) return "";
      const k = keyOf.get(suffixKey(uuid, path)), um = k ? unitSfx.get(k.gk) : undefined;
      if (um && um.has(unit)) return um.get(unit)!;
      return packageSuffix(uuid, path);
    },
  };
}
/** The file reference of a base on a path: the path's suffix composed in (the writer's GetRefSuffix( m_Path )), never on an unannotated one. */
export function storedRef(rs: RefSuffixes, base: string, path: string): string { return base.endsWith("?") ? base : base + rs.suffix(path); }
/**
 * SCH_SYMBOL::GetRef( sheet, aIncludeUnit ) as shown: the base, the unit when asked for (or `unit` given), then the
 * suffix — a unit its own sheet's (or, for another unit, GetUnitRefSuffix), a package's GetPackageRefSuffix.
 */
export function composedRef(rs: RefSuffixes, uuid: string, path: string, base: string, units: number, sub: string, opts?: { includeUnit?: boolean; unit?: number; ownUnit?: number }): string {
  if (base.endsWith("?") || !rs.has) return base + (opts && (opts.includeUnit || opts.unit) && units > 1 ? sub : "");
  const o = opts || {}, withUnit = !!o.unit || (!!o.includeUnit && units > 1);
  let ref = base + (withUnit ? sub : "");
  if (o.unit && o.ownUnit !== undefined && o.unit !== o.ownUnit) ref += rs.unitSuffix(uuid, path, o.unit);
  else if (withUnit || units < 2) ref += rs.suffix(path);
  else ref += rs.packageSuffix(uuid, path);
  return ref;
}
/**
 * SCHEMATIC::RefSuffixCollisions( aIncludeEmpty ): each later path of a file whose suffix an earlier path of the same
 * file already composed, with that first path.
 */
export function refSuffixCollisions(rs: RefSuffixes, includeEmpty: boolean): [SuffixPath, SuffixPath][] {
  const out: [SuffixPath, SuffixPath][] = [], first = new Map<KDoc, Map<string, SuffixPath>>();
  for (const p of rs.paths) {
    const s = rs.suffix(p.path); if (!s && !includeEmpty) continue;
    let m = first.get(p.doc); if (!m) { m = new Map(); first.set(p.doc, m); }
    const f = m.get(s); if (f) out.push([p, f]); else m.set(s, p);
  }
  return out;
}
/** SCH_SHEET_PATH::PathAsString of an instance path: "/" and each sheet's uuid below the root, each followed by "/". */
export function pathAsString(path: string): string { const segs = path.split("/").filter(Boolean).slice(1); return "/" + segs.map((s) => s + "/").join(""); }
export const MAIL_SCH_REF_SUFFIXES_TAG = "ref_suffixes";
/** SCHEMATIC::FormatRefSuffixes: the reply to MAIL_SCH_GET_REF_SUFFIXES — each path's suffix in page order, then the footprints of the path whose package takes another sheet's. */
export function formatRefSuffixes(rs: RefSuffixes): string {
  const on = new Map<string, [string, string][]>();
  for (const [key, s] of rs.packages) { const [uuid, path] = key.split("\0"); let l = on.get(path); if (!l) { l = []; on.set(path, l); } l.push([uuid, s]); }
  let reply = MAIL_SCH_REF_SUFFIXES_TAG + "\n";
  for (const p of rs.paths) {
    const sheet = pathAsString(p.path);
    reply += sheet + "\t" + rs.suffix(p.path) + "\n";
    for (const [uuid, s] of (on.get(p.path) || []).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) reply += sheet + uuid + "\t" + s + "\n";
  }
  return reply;
}
/**
 * The writes that bring the files in line with the suffixes now in force: every annotated instance takes its base
 * (as StripRefSuffixes read it under `before`) composed with the path's suffix under `after` — a sheet's suffix edited,
 * or suffix numbering turned on or off (KiCad recomposes every reference on its next save).  Returns the new reference of each (uuid,
 * path) whose stored reference changes.
 */
export function recomposedRefs(before: RefSuffixes, after: RefSuffixes): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of after.paths) for (const it of p.doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const inst = instanceOf(it.node, p.path); if (!inst.entry || !inst.ref || inst.ref.endsWith("?")) continue;
    const b = before.base(it.id, p.path); if (b === null) continue;
    // a reference saved without its suffix keeps its whole text as the base, which the save then composes
    const next = storedRef(after, b, p.path);
    if (next !== inst.ref) out.set(suffixKey(it.id, p.path), next);
  }
  return out;
}
