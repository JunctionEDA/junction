// library/core.ts — the document side of library access, free of DOM and network so it runs
// under node (server/static/tests/library.test.js): flattening a derived library symbol the way
// LIB_SYMBOL::Flatten does, the copy a sheet keeps in (lib_symbols …), a new symbol instance
// as SCH_IO_KICAD_SEXPR::saveSymbol writes it, a library footprint turned into a board
// footprint as PCB_IO_KICAD_SEXPR::format(FOOTPRINT) writes it, and the chooser's search.
//
// Nodes are built from s-expression text through KiCadCanvas.parse rather than from bare
// arrays: the reader records which atoms were quoted, and KiCad's parsers want strings
// where the format says string.

import { bodyStyleNames as libBodyStyleNames } from "../dialogs/sym-props-logic";

const K = (): KiCadCanvasApi => (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;

const isList = (v: unknown): v is SNode => Array.isArray(v);
const head = (n: SNode): string => String(n[0]);
const text = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

/** A quoted s-expression string. */
export function q(s: unknown): string {
  return '"' + text(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}
/** A coordinate the way KiCad prints it: at most four decimals for the schematic, six for the board. */
const mm = (v: number, digits = 4): string => String(+(+v).toFixed(digits) || 0);

function parseOne(src: string): SNode {
  const n = K().parse(src);
  if (!n) throw new Error("not an s-expression");
  return n;
}
function clone(n: SNode): SNode { return (K().cloneNode as (n: SNode) => SNode)(n); }
function kid(n: SNode, key: string): SNode | null { return K().kid(n, key); }
function kids(n: SNode, key: string): SNode[] { return K().kids(n, key); }
function indexOfKid(n: SNode, key: string): number { for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === key) return i; } return -1; }
function dropKids(n: SNode, key: string): void { for (let i = n.length - 1; i >= 1; i--) { const c = n[i]; if (isList(c) && c[0] === key) n.splice(i, 1); } }
function yes(n: SNode | null, def: boolean): boolean { return n ? text(n[1]) !== "no" : def; }

export const MANDATORY_FIELDS = ["Reference", "Value", "Footprint", "Datasheet", "Description"];
const isMeta = (name: string) => name.startsWith("ki_");

/** "Lib:Name" → { lib, name }; a bare name has an empty library. */
export function parseLibId(id: string): { lib: string; name: string } {
  const i = id.indexOf(":");
  return i < 0 ? { lib: "", name: id } : { lib: id.slice(0, i), name: id.slice(i + 1) };
}

/** The library symbol out of whatever was handed over: its text, a node, or a whole (kicad_symbol_lib …). */
export function symbolNodeOf(src: string | SNode, name?: string): SNode {
  let n = typeof src === "string" ? parseOne(src) : src;
  if (head(n) === "kicad_symbol_lib") {
    const all = kids(n, "symbol");
    const want = name ? all.find((s) => text(s[1]) === name || parseLibId(text(s[1])).name === name) : all[0];
    if (!want) throw new Error("the library has no symbol " + (name || ""));
    // what the library parser changes while reading an older file (canvas/legacy.ts)
    const v = kid(n, "version"); if (v && K().migrateSchNode) K().migrateSchNode(want, Number(v[1]) || 0);
    n = want;
  }
  if (head(n) !== "symbol") throw new Error("not a library symbol");
  return n;
}

// ---------------------------------------------------------------- library symbols

function propertyNamed(sym: SNode, name: string): SNode | null {
  for (const p of kids(sym, "property")) if (text(p[1]) === name) return p;
  return null;
}
const propertyText = (sym: SNode, name: string): string => { const p = propertyNamed(sym, name); return p ? text(p[2]) : ""; };

/**
 * LIB_SYMBOL::Flatten: the root parent's drawing with the derived symbol's name and fields.
 * `parents` is the chain the symbol extends, nearest first.  A mandatory field of the child
 * replaces the parent's only when it has text; any other field replaces or joins; keywords and
 * footprint filters fall back to the parent's; the BOM / board / simulation flags are the child's.
 */
export function flattenSymbol(symbol: string | SNode, parents: (string | SNode)[] = []): SNode {
  const child = clone(symbolNodeOf(symbol));
  if (!kid(child, "extends")) return child;
  if (!parents.length) throw new Error(`${text(child[1])} extends ${text(kid(child, "extends")![1])}, which was not supplied`);
  const base = flattenSymbol(parents[0], parents.slice(1));
  const baseName = parseLibId(text(base[1])).name, name = text(child[1]), ownName = parseLibId(name).name;
  base[1] = name;
  for (const sub of kids(base, "symbol")) {
    const s = text(sub[1]);
    if (s.startsWith(baseName + "_")) sub[1] = ownName + s.slice(baseName.length);
  }
  for (const p of kids(child, "property")) {
    const pname = text(p[1]), mine = text(p[2]);
    const at = base.findIndex((c) => isList(c) && c[0] === "property" && text(c[1]) === pname);
    if (MANDATORY_FIELDS.includes(pname) || isMeta(pname)) {
      if (mine === "" && at >= 0) continue;
      if (at >= 0) base[at] = clone(p); else insertProperty(base, clone(p));
    } else if (at >= 0) base[at] = clone(p);
    else insertProperty(base, clone(p));
  }
  for (const flag of ["exclude_from_sim", "in_bom", "on_board", "in_pos_files"]) {
    const mine = kid(child, flag); if (!mine) continue;
    const at = indexOfKid(base, flag);
    if (at >= 0) base[at] = clone(mine); else base.splice(Math.max(2, firstIndex(base, ["property", "symbol"])), 0, clone(mine));
  }
  return base;
}
function firstIndex(n: SNode, keys: string[]): number {
  for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && keys.includes(head(c))) return i; }
  return n.length;
}
/** After the last property, where the writer puts the next field. */
function insertProperty(sym: SNode, prop: SNode): void {
  let at = -1;
  for (let i = 1; i < sym.length; i++) { const c = sym[i]; if (isList(c) && c[0] === "property") at = i; }
  if (at < 0) at = firstIndex(sym, ["symbol"]) - 1;
  sym.splice(at + 1, 0, prop);
}

/**
 * The copy of a library symbol a sheet keeps in (lib_symbols …): the same symbol named by its
 * full lib id, units keeping the bare item name ("Device:R" holds "R_0_1"), as the schematic
 * writer saves a symbol's flattened library part when it is first used.
 */
export function embedSymbol(libId: string, symbol: string | SNode): SNode {
  const src = symbolNodeOf(symbol);
  if (kid(src, "extends")) throw new Error("flatten a derived symbol before embedding it");
  const out = clone(src);
  const was = parseLibId(text(out[1])).name, name = parseLibId(libId).name;
  out[1] = libId;
  if (was !== name) for (const sub of kids(out, "symbol")) { const s = text(sub[1]); if (s.startsWith(was + "_")) sub[1] = name + s.slice(was.length); }
  return out;
}

export interface SymbolInfo {
  name: string; reference: string; value: string; footprint: string; datasheet: string; description: string; keywords: string;
  fpFilters: string; power: boolean; units: number; bodyStyles: number; extends: string; pins: number;
  fields: { name: string; value: string }[];
}

/** `Name_<unit>_<bodyStyle>` → [unit, bodyStyle]. */
export function unitOfSubSymbol(sub: string): [number, number] | null {
  const m = /_(\d+)_(\d+)$/.exec(sub);
  return m ? [+m[1], +m[2]] : null;
}

export function symbolInfo(symbol: string | SNode): SymbolInfo {
  const s = symbolNodeOf(symbol);
  let units = 1, bodyStyles = 1, pins = 0;
  for (const sub of kids(s, "symbol")) {
    const u = unitOfSubSymbol(text(sub[1])); if (u) { units = Math.max(units, u[0]); bodyStyles = Math.max(bodyStyles, u[1]); }
    pins += kids(sub, "pin").length;
  }
  const ext = kid(s, "extends");
  return {
    name: parseLibId(text(s[1])).name, reference: propertyText(s, "Reference"), value: propertyText(s, "Value"), footprint: propertyText(s, "Footprint"),
    datasheet: propertyText(s, "Datasheet"), description: propertyText(s, "Description") || propertyText(s, "ki_description"),
    keywords: propertyText(s, "ki_keywords"), fpFilters: propertyText(s, "ki_fp_filters"), power: !!kid(s, "power"),
    units, bodyStyles, extends: ext ? text(ext[1]) : "", pins,
    fields: kids(s, "property").filter((p) => !isMeta(text(p[1]))).map((p) => ({ name: text(p[1]), value: text(p[2]) })),
  };
}

/** LIB_SYMBOL::GetUnitDisplayName's default: "Unit A", "Unit B", … "Unit AA". */
export function unitName(unit: number): string {
  let n = unit, s = "";
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return "Unit " + s;
}

// ---------------------------------------------------------------- a new symbol instance

function fieldHidden(p: SNode): boolean {
  const h = kid(p, "hide"); if (h) return text(h[1]) !== "no";
  if (p.includes("hide")) return true;
  const e = kid(p, "effects"); if (!e) return false;
  const eh = kid(e, "hide"); return eh ? text(eh[1]) !== "no" : e.includes("hide");
}
/** (effects …) of a library field for the instance: the visibility lives on the field, not in the effects. */
function effectsText(p: SNode | null): string {
  const e = p && kid(p, "effects");
  if (!e) return "(effects (font (size 1.27 1.27)))";
  const c = clone(e); dropKids(c, "hide");
  for (let i = c.length - 1; i >= 1; i--) if (c[i] === "hide") c.splice(i, 1);
  return K().serialize(c);
}

export interface SymbolInstanceOpts {
  /** "Lib:Name" as it goes into (lib_id …). */
  libId: string;
  /** The flattened library symbol (embedded or library form). */
  symbol: SNode;
  at: [number, number];
  unit?: number;
  /** The body style (1 standard, 2 De Morgan alternate, …): the chooser's "Body style:" choice. */
  bodyStyle?: number;
  /** Field values over the library's; names the symbol does not have become new (hidden) fields. */
  fields?: Record<string, string>;
  /** The full designator ("R?", "U3"); the library prefix + "?" when absent. */
  reference?: string;
  /** Project name and sheet path ("/<root uuid>/<sheet uuid>…") for the (instances …) block. */
  project?: string;
  path?: string;
  uuid?: string;
}

/**
 * A new SCH_SYMBOL of a library symbol, unrotated at `at`: the header flags from the library
 * part, every field at its library position (library Y points up), a pin with a fresh uuid for
 * each pin of the first body style, and the instance of the sheet it lands on.
 */
export function symbolInstance(o: SymbolInstanceOpts): SNode {
  const lib = o.symbol, unit = o.unit && o.unit > 0 ? o.unit : 1, [x, y] = o.at;
  const flag = (key: string, def: boolean) => `(${key} ${yes(kid(lib, key), def) ? "yes" : "no"})`;
  const info = symbolInfo(lib);
  const prefix = info.reference || "U";
  const reference = o.reference || prefix + "?";
  const over = o.fields || {};
  const out: string[] = [`(symbol (lib_id ${q(o.libId)}) (at ${mm(x)} ${mm(y)} 0) (unit ${unit}) (body_style ${o.bodyStyle && o.bodyStyle > 1 ? Math.round(o.bodyStyle) : 1})`,
    flag("exclude_from_sim", false), flag("in_bom", true), flag("on_board", true), flag("in_pos_files", true), "(dnp no)", `(uuid ${q(o.uuid || K().newUuid())})`];
  const field = (name: string, value: string, lp: SNode | null, hiddenDefault: boolean) => {
    const a = lp ? kid(lp, "at") : null;
    const lx = a ? K().num(a[1]) : 0, ly = a ? K().num(a[2]) : 0, rot = a ? K().num(a[3]) : 0;
    const hidden = lp ? fieldHidden(lp) : hiddenDefault;
    return `(property ${q(name)} ${q(value)} (at ${mm(x + lx)} ${mm(y - ly)} ${mm(rot)})${hidden ? " (hide yes)" : ""} (show_name ${yes(lp && kid(lp, "show_name"), false) ? "yes" : "no"})`
      + ` (do_not_autoplace ${yes(lp && kid(lp, "do_not_autoplace"), false) ? "yes" : "no"}) ${effectsText(lp)})`;
  };
  // KiCad 10 library symbols carry private properties, (property private "Name" "Value" …): notes for the
  // library's own checks.  They stay in the library copy; read as a field named "private" they made a placed
  // symbol desktop KiCad refuses to load.
  const isPrivate = (p: SNode) => text(p[1]) === "private" && p.length > 3 && !isList(p[2]) && !isList(p[3]);
  const libProps = kids(lib, "property").filter((p) => !isMeta(text(p[1])) && !isPrivate(p));
  const seen = new Set<string>();
  for (const name of MANDATORY_FIELDS) {
    const lp = libProps.find((p) => text(p[1]) === name) || null;
    let value = name === "Reference" ? reference : over[name] !== undefined ? over[name] : lp ? text(lp[2]) : "";
    if (name === "Value" && value === "") value = info.name;
    out.push(field(name, value, lp, name !== "Reference" && name !== "Value")); seen.add(name);
  }
  for (const lp of libProps) {
    const name = text(lp[1]); if (seen.has(name)) continue; seen.add(name);
    out.push(field(name, over[name] !== undefined ? over[name] : text(lp[2]), lp, false));
  }
  for (const [name, value] of Object.entries(over)) {
    if (seen.has(name) || isMeta(name) || !name) continue; seen.add(name);
    out.push(field(name, text(value), null, true));
  }
  for (const sub of kids(lib, "symbol")) {
    const u = unitOfSubSymbol(text(sub[1]));
    if (u && u[1] > 1) continue;                                   // pins of the alternate body style belong to it alone
    for (const pin of kids(sub, "pin")) { const nn = kid(pin, "number"); out.push(`(pin ${q(nn ? nn[1] : "")} (uuid ${q(K().newUuid())}))`); }
  }
  if (o.project && o.path) out.push(`(instances (project ${q(o.project)} (path ${q(o.path)} (reference ${q(reference)}) (unit ${unit}))))`);
  return parseOne(out.join(" ") + ")");
}

/** A placed unit that holds a reference: its library symbol, value and unit (unit -1: held outright). */
export interface RefHolder { ref: string; lib: string; value: string; unit: number }
/**
 * The designator a new symbol gets: "R?" — or, with automatic annotation, the first free number.  `used` lists the
 * references in use; a holder entry ({ ref, lib, value, unit }) lets a unit of a multi-unit symbol (`me`) share a
 * number whose holders are all the same library symbol with the same value and leave its unit free
 * (REFDES_TRACKER::GetNextRefDesForUnits / areUnitsAvailable), so unit B placed after U1A becomes U1B.
 */
export function nextReference(prefix: string, used: Iterable<string | RefHolder>, auto: boolean, me?: { lib: string; value: string; unit: number } | null,
  opts?: { /** the first number to try (the project's annotate_start_num + 1, or the sheet's block) */ min?: number; /** a power symbol: its number is written 0nnn */ power?: boolean; /** REFDES_TRACKER */ tracker?: { reuse: boolean; used: Set<string> } | null } | null): string {
  prefix = prefix || "U";
  // SCH_REFERENCE::AlwaysAnnotate: power symbols and the other "#" references are numbered even with automatic annotation off
  if (!auto && !prefix.startsWith("#")) return prefix + "?";
  // prefix and number -> its holders (SCH_REFERENCE::Split): "#PWR01" holds number 1 of "#PWR"
  const holders = new Map<number, RefHolder[]>();
  for (const u of used) {
    const h: RefHolder = typeof u === "string" ? { ref: u, lib: "", value: "", unit: -1 } : u;
    const m = /^([\s\S]*?)(\d+)$/.exec(h.ref); if (!m || m[1] !== prefix) continue;
    const n = parseInt(m[2], 10), l = holders.get(n); if (l) l.push(h); else holders.set(n, [h]);
  }
  const tracker = opts && opts.tracker, text = (n: number): string => prefix + (opts && opts.power ? "0" + n : n);
  for (let n = Math.max(1, (opts && opts.min) || 1); ; n++) {
    const hs = holders.get(n);
    if (!hs || !hs.length) {
      // REFDES_TRACKER::GetNextRefDesForUnits: a designator used before is skipped unless designators are reused
      if (tracker && !tracker.reuse && tracker.used.has(prefix + n)) continue;
      if (tracker) tracker.used.add(prefix + n);
      return text(n);
    }
    if (me && hs.every((h) => h.unit >= 0 && h.unit !== me.unit && h.lib === me.lib && h.value === me.value)) return text(n);
  }
}

/**
 * SCH_DRAWING_TOOLS::PlaceSymbol's m_Drawing.new_power_symbols: a power symbol that is not local becomes local with
 * "Local" (its keywords and description say "local power" / "local label"), one that is not global becomes global with
 * "Global"; "Default" follows the library and a symbol that is not a power symbol is never touched.  The converted
 * copy, or null when the symbol stays as it is.
 */
export function powerPreferenceSymbol(lib: SNode, pref: string | null | undefined): SNode | null {
  const pw = kid(lib, "power"); if (!pw) return null;
  const local = text(pw[1]) === "local";
  if (pref === "local" && !local) {
    const out = JSON.parse(JSON.stringify(lib)) as SNode;
    (out as SNode[])[(out as SNode[]).findIndex((c) => isList(c) && c[0] === "power")] = ["power", "local"];
    for (const p of kids(out, "property")) {
      const name = text(p[1]);
      if (name === "ki_keywords" && text(p[2]).includes("global power")) p[2] = text(p[2]).replace("global power", "local power");
      if ((name === "Description" || name === "ki_description") && text(p[2]).includes("global label")) p[2] = text(p[2]).replace("global label", "local label");
    }
    return out;
  }
  if (pref === "global" && local) {
    const out = JSON.parse(JSON.stringify(lib)) as SNode;
    (out as SNode[])[(out as SNode[]).findIndex((c) => isList(c) && c[0] === "power")] = ["power", "global"];
    return out;
  }
  return null;
}

/**
 * PlaceSymbol's "place all units" step: from the unit just placed, the next unit no symbol holds — with an annotated
 * reference a unit of the same reference anywhere in the schematic, with an unannotated one ("U?") a unit of the same
 * reference and library symbol (IsUnannotatedUnitOccupied).  Past the last unit it wraps to 1 (the next package).
 */
export function nextFreeUnit(unit: number, units: number, reference: string, libId: string, holders: Iterable<RefHolder>): number {
  const unannotated = reference.endsWith("?"), list = [...holders];
  const occupied = (u: number) => list.some((h) => h.ref === reference && h.unit === u && (!unannotated || h.lib === libId));
  while (unit <= units && occupied(unit)) unit++;
  return unit > units ? 1 : unit;
}

/**
 * SCH_SYMBOL::Duplicate for the next symbol on the cursor (the next unit, or the next repeated copy): the placed symbol
 * as it is — orientation, mirror, field values and positions — with fresh uuids, the given unit in the symbol and in
 * every instance, and, when given, a new reference.
 */
export function duplicatePlaced(node: SNode, unit: number, reference?: string | null): SNode {
  const out = JSON.parse(JSON.stringify(node)) as SNode[];
  const set = (n: SNode[], key: string, v: unknown) => { const i = n.findIndex((c) => isList(c) && c[0] === key); if (i >= 0) n[i] = [key, v] as SNode; else n.push([key, v] as SNode); };
  set(out, "uuid", K().newUuid());
  for (const pin of kids(out, "pin")) set(pin as SNode[], "uuid", K().newUuid());
  set(out, "unit", unit);
  for (const inst of kids(out, "instances")) for (const pr of kids(inst, "project")) for (const pa of kids(pr, "path")) {
    const u = kid(pa, "unit"); if (u) u[1] = unit;
    const r = kid(pa, "reference"); if (r && reference) r[1] = reference;
  }
  if (reference) { const rp = kids(out, "property").find((p) => text(p[1]) === "Reference"); if (rp) rp[2] = reference; }
  return out;
}

// ---------------------------------------------------------------- a library footprint on the board

export interface FootprintInstanceOpts {
  /** "Lib:Name" as it goes into (footprint "…"). */
  fpid: string;
  /** The .kicad_mod text (or its parsed node). */
  footprint: string | SNode;
  at: [number, number];
  /** Field values over the library's (Reference stays "REF**" unless given). */
  fields?: Record<string, string>;
  uuid?: string;
}

const FP_UUID_BEFORE_EFFECTS = new Set(["property", "fp_text", "fp_text_box"]);
const FP_OWNED = new Set(["property", "fp_text", "fp_text_box", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "pad", "zone", "group", "dimension", "image", "table", "point", "barcode", "fp_ellipse", "fp_ellipse_arc"]);

/**
 * A library footprint as a board item: the library header (version, generator) goes, the name
 * becomes the full FPID, the footprint and each of its items get a uuid where the board writer
 * puts it, the Datasheet and Description fields every board footprint carries are added, pads
 * come without nets, and it sits unrotated on the front at `at`.
 */
export function footprintInstance(o: FootprintInstanceOpts): SNode {
  let src = typeof o.footprint === "string" ? parseOne(o.footprint) : clone(o.footprint);
  if (head(src) === "kicad_footprint_lib" && K().footprintDoc) src = K().footprintDoc.unwrapFootprintLib(src);   // a 10.99 footprint file: its (footprint …)
  if (head(src) !== "footprint" && head(src) !== "module") throw new Error("not a footprint");
  // what the footprint parser changes while reading an older file (canvas/legacy.ts); no (version …) reads as 20201115
  { const v = kid(src, "version"); if (K().migrateBoardNode) K().migrateBoardNode(src, v ? Number(v[1]) || 0 : 20201115); }
  const out = parseOne(`(footprint ${q(o.fpid)} (layer "F.Cu") (uuid ${q(o.uuid || K().newUuid())}) (at ${mm(o.at[0], 6)} ${mm(o.at[1], 6)}))`);
  const freshen = (n: SNode) => {
    for (let i = n.length - 1; i >= 1; i--) {
      const c = n[i]; if (!isList(c)) continue;
      if (c[0] === "uuid" || c[0] === "tstamp") n[i] = parseOne(`(uuid ${q(K().newUuid())})`);
      else freshen(c);
    }
  };
  const over = o.fields || {};
  const seen = new Set<string>();
  const body: SNode[] = [];
  for (let i = 2; i < src.length; i++) {
    const c = src[i]; if (!isList(c)) continue;                       // bare flags (locked, placed) do not travel
    const k = head(c);
    if (k === "version" || k === "generator" || k === "generator_version" || k === "tedit" || k === "layer" || k === "at" || k === "uuid" || k === "tstamp"
      || k === "path" || k === "sheetname" || k === "sheetfile" || k === "locked" || k === "placed") continue;
    if (k === "property") { const name = text(c[1]); seen.add(name); if (over[name] !== undefined) c[2] = text(over[name]); }
    if (k === "pad") dropKids(c, "net");
    if (FP_OWNED.has(k)) {
      freshen(c);
      if (!kid(c, "uuid")) {
        const u = parseOne(`(uuid ${q(K().newUuid())})`);
        const e = FP_UUID_BEFORE_EFFECTS.has(k) ? indexOfKid(c, "effects") : -1;
        if (e >= 0) c.splice(e, 0, u); else c.push(u);
      }
    }
    body.push(c);
  }
  // the fields a board footprint always has (FOOTPRINT's mandatory fields), after Value
  const extra: SNode[] = [];
  const mk = (name: string, value: string, hidden: boolean) => parseOne(`(property ${q(name)} ${q(value)} (at 0 0 0) (layer "F.Fab")${hidden ? " (hide yes)" : ""} (uuid ${q(K().newUuid())}) (effects (font (size 1.27 1.27))))`);
  for (const name of ["Datasheet", "Description"]) if (!seen.has(name)) { extra.push(mk(name, over[name] !== undefined ? text(over[name]) : "", true)); seen.add(name); }
  for (const [name, value] of Object.entries(over)) if (name && !seen.has(name)) { extra.push(mk(name, text(value), true)); seen.add(name); }
  let after = -1;
  body.forEach((c, i) => { if (head(c) === "property" && (text(c[1]) === "Value" || (after < 0 && text(c[1]) === "Reference"))) after = i; });
  if (after < 0) { body.forEach((c, i) => { if (head(c) === "descr" || head(c) === "tags") after = i; }); }
  body.splice(after + 1, 0, ...extra);
  for (const c of body) out.push(c);
  return out;
}

/** What a footprint's index row needs, from its text. */
export function footprintInfo(footprint: string | SNode): { name: string; description: string; keywords: string; pads: number; datasheet: string } {
  const n = typeof footprint === "string" ? parseOne(footprint) : footprint;
  const numbers = new Set(kids(n, "pad").map((p) => text(p[1])).filter((s) => s !== ""));
  const d = kid(n, "descr"), t = kid(n, "tags"), ds = kids(n, "property").find((p) => text(p[1]) === "Datasheet");
  return { name: parseLibId(text(n[1])).name, description: d ? text(d[1]) : "", keywords: t ? text(t[1]) : "", pads: numbers.size, datasheet: ds ? text(ds[2]) : "" };
}

// ---------------------------------------------------------------- the chooser's search

/**
 * A row of the library tree for the search.  `kind` "symbol" adds LIB_SYMBOL's own terms (the "units=N" relational
 * term and the default footprint); `fields` / `columns` are LIB_TREE_NODE::m_Fields and the shown columns, whose values
 * are searched too (RebuildSearchTerms).
 */
export interface SearchRow { name: string; description?: string; keywords?: string; library?: string; kind?: "symbol" | "footprint"; units?: number; footprint?: string; fields?: Record<string, string>; columns?: string[] }

/** SEARCH_TERM: a text of the item, its weight, and whether it is the item's name / LIB_ID (the exact-match tier). */
export interface SearchTerm { text: string; score: number; isName?: boolean }

/** EDA_PATTERN_MATCH_RELATIONAL::m_units */
const REL_UNITS: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, "": 1, k: 1e3, meg: 1e6, g: 1e9, t: 1e12, ki: 1024, mi: 1048576, gi: 1073741824, ti: 1099511627776 };
const hasUnit = (u: string): boolean => Object.prototype.hasOwnProperty.call(REL_UNITS, u);
/** wxString::ToCDouble over the whole text. */
const cDouble = (s: string): number | null => (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : null);
type Finder = (candidate: string) => number;   // the match position, -1 for none

/** EDA_PATTERN_MATCH_REGEX: only an explicit regular expression ("/…" or "^…$"); null when the pattern is not one. */
function regexFinder(p: string): Finder | null {
  let src: string;
  if (p.startsWith("^") && p.endsWith("$")) src = p;
  else if (p.startsWith("/")) { src = p.slice(1); if (src.endsWith("/")) src = src.slice(0, -1); }
  else return null;
  let re: RegExp; try { re = new RegExp(src); } catch { return null; }
  return (c) => { const m = re.exec(c); return m ? m.index : -1; };
}
/** EDA_PATTERN_MATCH_WILDCARD: '?' one character, '*' any run, the rest literal; unanchored. */
function wildcardFinder(p: string): Finder | null {
  let src = "";
  for (const c of p) src += c === "?" ? "." : c === "*" ? ".*" : ".*+?^${}()|[]/\\".includes(c) ? "\\" + c : c;
  let re: RegExp; try { re = new RegExp(src); } catch { return null; }
  return (c) => { const m = re.exec(c); return m ? m.index : -1; };
}
/** EDA_PATTERN_MATCH_RELATIONAL: "key<op>value[unit]" against "key=value[unit]" / "key:value[unit]" words of the text. */
function relationalFinder(p: string): Finder | null {
  const m = /^(\w+)(<|<=|=|>=|>)([-+]?[\d.]*)(\w*)$/.exec(p); if (!m) return null;
  const key = m[1].toLowerCase(), rel = m[2], val = m[3], unit = m[4].toLowerCase();
  let value = 0; const any = val === "";
  if (!any) { const v = cDouble(val); if (v === null) return null; value = v; }
  if (!hasUnit(unit)) return null;
  value *= REL_UNITS[unit];
  const findOne = (token: string): number => {
    const d = /(\w+)[=:]([-+]?[\d.]+)(\w*)/.exec(token); if (!d) return -1;
    if (d[1].toLowerCase() !== key) return -1;
    let v = cDouble(d[2]); if (v === null) return -1;
    const u = d[3].toLowerCase(); if (hasUnit(u)) v *= REL_UNITS[u];
    const hit = any || (rel === "<" ? v < value : rel === "<=" ? v <= value : rel === "=" ? v === value : rel === ">=" ? v >= value : v > value);
    return hit ? d.index : -1;
  };
  return (c) => {
    const re = /[^ \t\r\n]+/g; let t: RegExpExecArray | null;
    while ((t = re.exec(c))) { const at = findOne(t[0]); if (at >= 0) return t.index + at; }
    return -1;
  };
}

/** EDA_COMBINED_MATCHER( term, CTX_LIBITEM ): the regex, wildcard, relational and substring matchers the term makes. */
export interface CombinedMatcher { pattern: string; finders: Finder[] }
export function combinedMatcher(pattern: string): CombinedMatcher {
  const finders: Finder[] = [];
  for (const f of [regexFinder(pattern), wildcardFinder(pattern), relationalFinder(pattern)]) if (f) finders.push(f);
  finders.push((c) => c.indexOf(pattern));
  return { pattern, finders };
}
/** EDA_COMBINED_MATCHER::Find: the smallest position any matcher finds, -1 when none does. */
export function matcherFind(m: CombinedMatcher, candidate: string): number {
  let pos = -1;
  for (const f of m.finders) { const at = f(candidate); if (at >= 0 && (pos < 0 || at < pos)) pos = at; }
  return pos;
}
/** LIB_TREE_MODEL_ADAPTER::UpdateSearchString: a leading "::" dropped, the text split on blanks, lower-cased, at most 100 terms. */
export function compileLibSearch(query: string): CombinedMatcher[] {
  let s = query || ""; if (s.startsWith("::")) s = s.slice(2);
  const out: CombinedMatcher[] = [];
  for (const t of s.split(/[ \t\r\n]+/)) { if (!t) continue; if (out.length >= 100) break; out.push(combinedMatcher(t.toLowerCase())); }
  return out;
}
const normTerm = (t: string): string => { const s = String(t || "").toLowerCase().trim(); return s.length > 1000 ? s.slice(0, 1000) : s; };
/** EDA_COMBINED_MATCHER::ScoreTerms: 8x the weight for a term equal to the pattern (the exact tier when it is a name),
 *  2x when found at its start, 1x when found elsewhere. */
export function scoreTerms(m: CombinedMatcher, terms: SearchTerm[]): { score: number; exact: boolean } {
  let score = 0, exact = false;
  for (const term of terms) {
    const text = normTerm(term.text);
    if (m.pattern === text) { score += 8 * term.score; if (term.isName) exact = true; }
    else { const pos = matcherFind(m, text); if (pos === 0) score += 2 * term.score; else if (pos > 0) score += term.score; }
  }
  return { score, exact };
}
/** LIB_TREE_NODE_ITEM::UpdateScore: 1, plus every term's score; a term that scores nothing leaves the item out (0). */
export function scoreItem(matchers: CombinedMatcher[], terms: SearchTerm[]): { score: number; exact: boolean } {
  let score = 1, exact = false;
  for (const m of matchers) {
    const r = scoreTerms(m, terms);
    if (r.score === 0) return { score: 0, exact: false };
    score += r.score; exact = exact || r.exact;
  }
  return { score, exact };
}
/** LIB_SYMBOL::rebuildCaches / FOOTPRINT_INFO::cacheSearchTerms, plus the shown columns' field values (weight 4). */
export function libSearchTerms(row: SearchRow): SearchTerm[] {
  const lib = row.library || "", kw = row.keywords || "";
  const out: SearchTerm[] = [{ text: lib, score: 4 }, { text: row.name, score: 8, isName: true }, { text: lib + ":" + row.name, score: 16, isName: true }];
  for (const k of kw.split(/[ \t\r\n]+/)) if (k) out.push({ text: k, score: 4 });
  out.push({ text: kw, score: 1 }, { text: row.description || "", score: 1 });
  if (row.kind === "symbol") {
    out.push({ text: `units=${row.units || 1}`, score: 1 });
    if (row.footprint) out.push({ text: row.footprint, score: 1 });
  }
  if (row.fields && row.columns) for (const [name, value] of Object.entries(row.fields)) if (row.columns.includes(name)) out.push({ text: value, score: 4 });
  return out;
}
/** The item's score and exact-match flag for a filter text (or its compiled matchers); score 0 filters it out. */
export function searchMatch(row: SearchRow, query: string | CombinedMatcher[]): { score: number; exact: boolean } {
  return scoreItem(typeof query === "string" ? compileLibSearch(query) : query, libSearchTerms(row));
}
/** The score alone (1 for an empty filter, 0 filtered out). */
export function searchScore(row: SearchRow, query: string): number { return searchMatch(row, query).score; }

// ---------------------------------------------------------------- the chooser's details pane

const escHtml = (s: unknown): string => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeName = (s: string): string => { try { const u = (K() as unknown as { unescapeText?: (t: string) => string }).unescapeText; return u ? u(s) : s; } catch { return s; } };
/** LinkifyHTML */
export function linkifyHtml(s: string): string {
  return s.replace(/\b(https?|ftp|file):\/\/([-\w+&@#/%?=~|!:,.;]*[^.,:;<>()\s¶])/gi, (all) => `<a href="${all}">${all}</a>`);
}
/** IsURL (string_utils.cpp) */
const hasUrl = (s: string): boolean => /(https?|ftp|file):\/\/([-\w+&@#/%?=~|!:,.;]*[^.,:;<>\s¶])/i.test(s);
const linkCell = (text: string): string => `<a href="${escHtml(text)}">${escHtml(text.length > 75 ? text.slice(0, 72) + "..." : text)}</a>`;

/** LIB_SYMBOL::GetUnitDisplayName: the symbol's own (unit_name …) or "A" / "Unit A". */
export function unitDisplayName(unit: number, names?: (string | undefined)[] | null, label = true): string {
  const own = names && names[unit - 1];
  if (own) return own;
  const letters = unitName(unit).slice(5);
  return label ? "Unit " + letters : letters;
}

export interface SymbolDetails {
  name: string;
  /** the parent's name and description for a derived symbol (LIB_SYMBOL::IsRoot false) */
  parent?: { name: string; description: string } | null;
  description: string; keywords: string;
  /** the flattened symbol's fields in file order (ki_* metadata left out) */
  fields: { name: string; value: string }[];
  unit: number; units: number; unitNames?: (string | undefined)[] | null;
}
/** GenerateAliasInfo (eeschema/generate_alias_info.cpp): the HTML of the chooser's details pane for a symbol. */
export function symbolDetailsHtml(d: SymbolDetails): string {
  let html = `<b>${escHtml(unescapeName(d.name))}</b>`;
  if (d.parent) html += `<br><i>Derived from ${escHtml(unescapeName(d.parent.name || "Unknown"))} (${escHtml(d.parent.description || "")})</i>`;
  html += "<br>" + linkifyHtml(escHtml(unescapeName(d.description || "")).replace(/\n/g, "<br>"));
  if (d.keywords) html += "<br>Keywords: " + escHtml(d.keywords);
  // LIB_SYMBOL::GetFields: by ordinal, the mandatory fields (which every LIB_SYMBOL has) first
  const byName = new Map<string, string>(); const order: string[] = [];
  for (const f of d.fields) if (!byName.has(f.name)) { byName.set(f.name, f.value); order.push(f.name); }
  const names = MANDATORY_FIELDS.concat(order.filter((n) => !MANDATORY_FIELDS.includes(n)));
  let rows = "";
  for (const name of names) {
    const text = byName.get(name) || "";
    let cell: string;
    if (name === "Value") continue;                                  // it only repeats the name
    if (name === "Reference") cell = escHtml(text + "?" + (d.units > 1 ? unitDisplayName(d.unit > 0 ? d.unit : 1, d.unitNames, false) : ""));
    else if (name === "Datasheet") cell = !text || text === "~" ? escHtml(text) : linkCell(text);
    else cell = hasUrl(text) ? linkCell(text) : escHtml(text);
    rows += `<tr><td><b>${escHtml(name)}</b></td><td>${cell}</td></tr>`;
  }
  return html + `<hr><table border=0>${rows}</table>`;
}
/** GetFootprintDocumentationURL: the Datasheet field, else the first http(s) link of the description. */
export function footprintDocumentationUrl(datasheet: string, description: string): string | null {
  if (datasheet) return datasheet;
  let idx = description.indexOf("http:"); if (idx < 0) idx = description.indexOf("https:");
  if (idx < 0) return null;
  let url = "", nesting = 0;
  for (const ch of description.slice(idx)) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x20 || c >= 0x7f || ch === '"') break;
    if (ch === "(") nesting++;
    else if (ch === ")" && --nesting < 0) break;
    url += ch;
  }
  if (".,:;".includes(url.slice(-1)) && url) url = url.slice(0, -1);
  return url || null;
}
/** GenerateFootprintInfo (pcbnew/generate_footprint_info.cpp): the details pane for a footprint. */
export function footprintDetailsHtml(d: { name: string; description: string; keywords: string; datasheet?: string }): string {
  const doc = footprintDocumentationUrl(d.datasheet || "", d.description || "") || "";
  const desc = linkifyHtml(escHtml(unescapeName(d.description || "")).replace(/\n/g, "<br>"));
  return `<b>${escHtml(d.name)}</b><br>${desc}<hr><table border=0>`
    + `<tr><td><b>Keywords</b></td><td>${escHtml(d.keywords || "")}</td></tr>`
    + `<tr><td><b>Documentation</b></td><td><a href="${escHtml(doc)}">${escHtml(doc.length > 75 ? doc.slice(0, 72) + "..." : doc)}</a></td></tr></table>`;
}

/** StrNumCmp( a, b, IGNORE_CASE ): digit runs compare as numbers, other characters upper-cased (LIB_TREE_NODE::AssignIntrinsicRanks). */
export function strNumCmpNoCase(a: string, b: string): number {
  let i = 0, j = 0;
  const digit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1: string | undefined = a[i], c2: string | undefined = b[j];
    if (digit(c1) && digit(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && digit(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && digit(b[j]));
      if (n1 !== n2) return n1 < n2 ? -1 : 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (c1 !== c2) { const u1 = c1!.toUpperCase(), u2 = c2!.toUpperCase(); if (u1 !== u2) return u1 < u2 ? -1 : 1; }
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  if (i >= a.length && j < b.length) return -1;
  if (i < a.length && j >= b.length) return 1;
  return 0;
}

/** KiCad's test for a power symbol in the chooser's filter: the (power) flag or a #PWR / #FLG reference. */
export function isPowerRow(row: { power?: boolean; reference?: string }): boolean {
  return !!row.power || row.reference === "#PWR" || row.reference === "#FLG";
}

const RECENT_SEARCHES_MAX = 10;
/** LIB_TREE::updateRecentSearchMenu: a non-empty search moves to the front, at most RECENT_SEARCHES_MAX kept. */
export function pushRecentSearch(list: string[], entry: string): string[] {
  const e = entry.trim(); if (!e) return list;
  const out = list.filter((x) => x !== e); out.unshift(e);
  return out.slice(0, RECENT_SEARCHES_MAX);
}
/**
 * LIB_SYMBOL::GetBodyStyleDescription for each body style: Standard / Alternate for a De Morgan symbol, else the
 * symbol's own (body_styles …) names (dialogs/sym-props-logic.ts bodyStyleNames).  One entry: a single body style.
 */
export function bodyStyleNames(symbol: string | SNode): string[] { return libBodyStyleNames(symbolNodeOf(symbol)); }
