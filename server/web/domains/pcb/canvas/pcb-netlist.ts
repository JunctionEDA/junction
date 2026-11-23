// kicad-canvas / pcb-netlist — "Update PCB from Schematic" without the desktop: the netlist of a schematic
// hierarchy (eeschema/connection_graph.cpp's naming rules) and the board changes that bring a board in line
// with it (pcbnew/netlist_reader/board_netlist_updater.cpp's rules and report wording).
//
// Pure functions over parsed documents; the dialog (web/domains/pcb/editor/pcbdialogs/update-pcb.ts) loads the sheets,
// shows the report and commits the staged nodes.  Exposed for the node tests as KiCadCanvas.pcbNetlist.
import { atOf, kid, kids, num, parse, ptsOf, str } from "./sexpr";
import { GENERATOR_VERSION } from "./format-version";
import { resolveLib, subReference, unitDisplayNames } from "./geom-sch";
import { expandStacked } from "./stacked-pins";
import { busConnection, isBusLabel, matchBusMember, type BusAliases, type BusConnection } from "./busname";
import { expandTextVars, hasTextVars } from "./sheet";
import { unescapeText } from "./text";
import { footprintVariant, footprintVariantNode, setFootprintVariant, symbolFlags, symbolFlagsForVariant, symbolInstance, symbolVariant, type FpFlags, strNumCmp } from "./variant-model";
import { boardItemBox } from "./kicad-bbox";
import { padPolygon } from "./geom-pcb";

type Pt = [number, number];

// ---------------------------------------------------------------- inputs
/** A pin of a placed symbol as sch-tools.js's symbolPins gives it. */
export interface SymPin { x: number; y: number; number: string; name: string; type: string; hidden: boolean }
export interface NetlistHelpers {
  /** the pins of a placed symbol (its unit and body style), in sheet coordinates */
  symbolPins(doc: KDoc, item: KItem): SymPin[];
  /** true for power symbols (#PWR, #FLG) */
  isPower(doc: KDoc, item: KItem): boolean;
  /** true for a (power local) symbol: its net is limited to the sheet, like a local label (KiCad 10) */
  isLocalPower?(doc: KDoc, item: KItem): boolean;
}
/** One schematic file: its parsed document, the file's own (uuid …) and its path in the project. */
export interface SheetFile { doc: KDoc; uuid: string; file: string }

// ---------------------------------------------------------------- outputs
export interface NetPin { net: string; name: string; type: string }
export interface NetComponent {
  ref: string; value: string; footprint: string; libId: string;
  /** every unit's symbol path ("/<sheet uuid>…/<symbol uuid>"), the first unit's first */
  paths: string[];
  /** every field of the symbol except Reference / Value / Footprint */
  fields: Record<string, string>;
  sheetName: string; sheetFile: string;
  dnp: boolean; excludeFromBom: boolean; excludeFromBoard: boolean;
  /** the netlist's exclude_from_sim / exclude_from_pos_files properties (the symbol's flags, the sheet path's for sim) */
  excludeFromSim?: boolean; excludeFromPosFiles?: boolean;
  /** the library symbol's "duplicate pin numbers are jumpers", jumper pin groups and footprint filters (ki_fp_filters) */
  dupPinsAreJumpers?: boolean; jumperPinGroups?: string[][]; fpFilters?: string;
  /** COMPONENT::GetUnitInfo: each unit's display name and pad numbers (LIB_SYMBOL::GetUnitPinInfo) */
  unitInfo?: { name: string; pins: string[] }[];
  /** pad number -> net / pin name / electrical type */
  pins: Map<string, NetPin>;
  /** COMPONENT::GetVariants: the symbol instance's design variants that differ from the symbol (as the KiCad
   *  netlist's (variants …) carries them), in the CASE_INSENSITIVE_MAP's order */
  variants?: NetVariant[];
  /** COMPONENT::GetGroup: the schematic group the symbol belongs to (its uuid and name) */
  group?: { uuid: string; name: string };
}
/** COMPONENT_VARIANT: a flag only when the variant changes it, the fields whose text the variant changes. */
export interface NetVariant { name: string; dnp?: boolean; excludedFromBOM?: boolean; excludedFromSim?: boolean; excludedFromPosFiles?: boolean; fields: Map<string, string> }
export interface Netlist {
  components: NetComponent[]; nets: Map<string, { ref: string; pin: string }[]>; warnings: string[];
  /** every named net (and bus) of the hierarchy with the items on it, sheet instance by sheet instance (CONNECTION_GRAPH's net map) */
  netMap?: Map<string, NetEntry>;
  /** the sheet instances the hierarchy walk found, root first ("/" then "/Sub/") */
  instances?: SheetInstance[];
  /** every placed symbol pin by "<symbol path>#<pin number>" (the symbol path as NetComponent.paths spells it): its
   *  net, the strongest item physically connected to it (BACK_ANNOTATE's addConnections + GetDriverPriority) and the
   *  winning driver of its whole net (the connectivity's resolved driver) */
  pinDrivers?: Map<string, PinDrivers>;
  /** NET_SETTINGS' netclass label assignments as CONNECTION_GRAPH rebuilds them: the "Netclass" fields of the labels
   *  and directive labels on each net and of the directive labels on the border of a rule area its items lie in;
   *  a bus hands its classes to its members */
  netclassLabels?: Map<string, Set<string>>;
}
/** An item that can drive a net, with its CONNECTION_SUBGRAPH::GetDriverPriority (NONE 0, PIN 1, SHEET_PIN 2,
 *  HIER_LABEL 3, LOCAL_LABEL 4, LOCAL_POWER_PIN 5, GLOBAL_POWER_PIN 6, GLOBAL 7). */
export interface DriverItem {
  kind: string; inst: number; id: string; prio: number; x: number; y: number;
  /** a symbol pin's number and SCH_PIN::IsPower; a sheet pin's name; a label's text */
  pin?: string; power?: boolean; sheetPin?: string; text?: string;
}
export interface PinDrivers { net: string; physical: DriverItem | null; resolved: DriverItem | null }
/** An item of a net on one sheet instance: a wire, label, junction, no-connect, bus entry, a symbol pin or a sheet pin. */
export interface NetMember {
  inst: number; id: string; kind: string;
  /** symbol pin number / sheet pin name (kind "pin" / "sheet_pin") */
  pin?: string; pinName?: string; ref?: string; power?: boolean; text?: string;
  /** a symbol pin's reference without the unit letter (SCH_SYMBOL::GetRef) */
  symRef?: string;
}
export interface NetEntry { name: string; bus: boolean; members: NetMember[]; busMembers: string[];
  /** a bus group's aliases with their members (CONNECTION_PRESENTATION's "Bus Alias … Members" rows) */
  aliases?: { name: string; members: string[] }[];
  /** a net's winning driver (its priority is CONNECTION_SUBGRAPH::GetDriverPriority's) */
  driver?: DriverItem }
/** What the project adds to the sheets: its bus aliases (schematic.bus_aliases) and text variables (text_variables). */
export interface NetlistOptions { busAliases?: BusAliases; textVars?: Record<string, string> | null }
export interface SheetInstance { index: number; human: string; file: string; uuidPath: string[]; sheetName: string }

// ---------------------------------------------------------------- small s-expression helpers
const isList = Array.isArray;
const r4 = (v: number): number => +(+v).toFixed(4);
const pkey = (p: Pt): string => r4(p[0]) + "," + r4(p[1]);
function idxOf(node: SNode, key: string): number { for (let j = 1; j < node.length; j++) { const c = node[j]; if (isList(c) && c[0] === key) return j; } return -1; }
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
/**
 * (key v…) as the file writer spells it: strings quoted, numbers bare.  Built through the reader so the
 * node carries its quoting marks — serialize() would otherwise write an identifier-shaped string bare, and
 * KiCad's parser wants a string where the format says string (a net called `front` is a keyword otherwise).
 */
export function qnode(key: string, values: (string | number)[]): SNode {
  return parse("(" + key + values.map((v) => " " + (typeof v === "number" ? String(v) : quote(v))).join("") + ")") as SNode;
}
/** Set (key …values), replacing an existing child or inserting before the first of `before`; `bare` keeps keywords unquoted. */
function setKid(node: SNode, key: string, values: (string | number)[], before: string[], bare = false): SNode {
  const c: SNode = bare ? [key, ...values] : qnode(key, values);
  const i = idxOf(node, key);
  if (i > 0) { node[i] = c; return c; }
  let at = node.length;
  for (const b of before) { const j = idxOf(node, b); if (j > 0) { at = j; break; } }
  node.splice(at, 0, c); return c;
}
function delKid(node: SNode, key: string): boolean { const i = idxOf(node, key); if (i > 0) { node.splice(i, 1); return true; } return false; }
const kidStr = (node: SNode, key: string): string => { const k = kid(node, key) as SNode | null; return k ? str(k[1]) : ""; };
const yes = (node: SNode, key: string, def: boolean): boolean => { const k = kid(node, key) as SNode | null; return k ? str(k[1]) !== "no" : def; };
function prop(node: SNode, name: string): SNode | null { for (const p of kids(node, "property") as SNode[]) if (str(p[1]) === name) return p; return null; }
const propVal = (node: SNode, name: string): string => { const p = prop(node, name); return p ? str(p[2]) : ""; };

/** EscapeString( …, CTX_NETNAME ): '/' is spelled {slash}, line breaks are dropped. */
export function escapeNetName(s: string): string { return s.replace(/\//g, "{slash}").replace(/[\r\n]/g, ""); }
/** UnescapeString for the report (the names a person reads). */
export function unescapeNetName(s: string): string { return unescapeText(s); }

/** Members of a bus vector label "D[0..7]" -> ["D0", … "D7"]; null when the text is no bus. */
export function busVector(text: string): string[] | null {
  // NET_SETTINGS::ParseBusVector: the members always count up from the lower number (D[7..0] is D0 … D7), and a
  // range of one ([3..3]) is no bus
  const c = busConnection(text);
  return c && c.type === "vector" ? c.members.map((m) => m.full) : null;
}

// ---------------------------------------------------------------- the schematic's nets
// CONNECTION_SUBGRAPH::PRIORITY
/** LIB_SYMBOL::IsLocalPower: the library copy the symbol draws from carries (power local). */
function libIsLocalPower(doc: KDoc, n: SNode): boolean { const l = resolveLib(doc, str((kid(n, "lib_name") || kid(n, "lib_id") || [])[1])); const p = l && kid(l, "power"); return !!p && str(p[1]) === "local"; }
const P_PIN = 1, P_SHEET_PIN = 2, P_HIER = 3, P_LOCAL = 4, P_LOCAL_POWER = 4.5, P_BUS_MEMBER = 5, P_POWER = 6, P_GLOBAL = 7;
/** CONNECTION_SUBGRAPH::PRIORITY as GetDriverPriority returns it */
const KP_NONE = 0, KP_PIN = 1, KP_SHEET_PIN = 2, KP_HIER = 3, KP_LOCAL = 4, KP_LOCAL_POWER = 5, KP_GLOBAL_POWER = 6, KP_GLOBAL = 7;
/** `shape`: a sheet pin's (compareDrivers rule 4); `path` / `id`: stableDriverIdentity of a weak driver (the sheet path, the sheet pin's uuid). */
interface Driver { prio: number; name: string; depth: number; shape?: string; path?: string; id?: string; src?: DriverItem }
/** `onBoard`: PRIORITY::PIN (false: PRIORITY::NONE, a symbol excluded from the board or a #-reference); `path`: its sheet path. */
interface PinRef { comp: string | null; ref: string; unitRef: string; pin: SymPin; pins: SymPin[]; uuid: string; power: boolean; inNetlist: boolean; onBoard: boolean; path: string; src?: DriverItem }
/** `netPrefix`: PathHumanReadable with the sheet names escaped (a "/" in a name is {slash}), the prefix of the sheet's local nets. */
interface Instance { sheet: SheetFile; uuidPath: string[]; human: string; depth: number; index: number; sheetUuids: string[]; name: string; netPrefix: string; parent: Instance | null; sheetNode: SNode | null }
/** getElectricalTypeLabel: ${CONNECTION_TYPE} of a global / hierarchical label or a sheet pin. */
const SHAPE_LABEL: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-State", passive: "Passive" };
/** IsAutoGeneratedNetName: a name the pins gave, not a label. */
const autoNetName = (n: string): boolean => n.startsWith("Net-(") || n.startsWith("unconnected-(");

class UnionFind {
  parent: number[] = [];
  add(): number { this.parent.push(this.parent.length); return this.parent.length - 1; }
  find(i: number): number { const p = this.parent; while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; }
  union(a: number, b: number): void { a = this.find(a); b = this.find(b); if (a !== b) this.parent[b] = a; }
}

function distSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** A symbol's reference and unit on one sheet instance: its (instances …) entry for that path, else the field. */
export function instanceRef(node: SNode, path: string, project: string | undefined, legacy?: Map<string, { reference: string; unit: number }>): { ref: string; unit: number } {
  const unitN = kid(node, "unit") as SNode | null;
  let ref = propVal(node, "Reference"), unit = unitN ? num(unitN[1], 1) : 1, found = false;
  // a file older than 20221002: the root's (symbol_instances …), by the path below the root
  const old = legacy && legacy.get("/" + [...path.split("/").filter(Boolean).slice(1), str((kid(node, "uuid") || [])[1])].join("/"));
  if (old) { if (old.reference) ref = old.reference; unit = old.unit; }
  const inst = kid(node, "instances") as SNode | null;
  if (inst) {
    const projects = kids(inst, "project") as SNode[];
    projects.sort((a, b) => Number(str(b[1]) === project) - Number(str(a[1]) === project));
    for (const pr of projects) {
      for (const p of kids(pr, "path") as SNode[]) {
        if (str(p[1]) !== path) continue;
        const r = kid(p, "reference") as SNode | null, u = kid(p, "unit") as SNode | null;
        if (r) ref = str(r[1]); if (u) unit = num(u[1], unit);
        found = true; break;
      }
      if (found) break;
    }
  }
  return { ref, unit };
}

/** How many units the library symbol of a placed symbol has. */
export function unitCount(doc: KDoc, node: SNode): number {
  const id = kidStr(node, "lib_name") || kidStr(node, "lib_id");
  const lib = doc.lib.get(id) || doc.lib.get(kidStr(node, "lib_id"));
  if (!lib) return 1;
  let n = 1;
  for (const sub of kids(lib, "symbol") as SNode[]) { const m = /_(\d+)_(\d+)$/.exec(str(sub[1])); if (m) n = Math.max(n, Number(m[1])); }
  return n;
}
/**
 * LIB_SYMBOL::GetUnitPinInfo: for each unit (at least one) its display name (the unit_name, else the letter) and the
 * numbers of its pins and the pins common to all units, of every body style, ordered by position (x, then y down),
 * stacked pins expanded, each number once.
 */
function libUnitPinInfo(lib: SNode, units: number): { name: string; pins: string[] }[] {
  const names = unitDisplayNames(lib), out: { name: string; pins: string[] }[] = [];
  const pins: { unit: number; x: number; y: number; number: string }[] = [];
  for (const sub of kids(lib, "symbol") as SNode[]) {
    const m = /_(\d+)_(\d+)$/.exec(str(sub[1])); const u = m ? Number(m[1]) : 0;
    for (const g of kids(sub, "pin") as SNode[]) { const a = atOf(g) as number[]; pins.push({ unit: u, x: a[0] || 0, y: -(a[1] || 0), number: kidStr(g, "number") }); }
  }
  for (let u = 1; u <= Math.max(units, 1); u++) {
    const list = pins.filter((p) => !p.unit || p.unit === u).sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
    const seen = new Set<string>(), nums: string[] = [];
    for (const p of list) {
      const st = expandStacked(p.number);
      if (st.valid && st.pins.length && p.number.startsWith("[")) { for (const n of st.pins) if (!seen.has(n)) { seen.add(n); nums.push(n); } continue; }
      if (p.number && !seen.has(p.number)) { seen.add(p.number); nums.push(p.number); }
    }
    out.push({ name: names.get(u) ?? unitLetter(u), pins: nums });
  }
  return out;
}
/** SCH_SYMBOL::SubReference: A, B, … Z, AA, … */
function unitLetter(unit: number): string { let s = "", u = unit; while (u > 0) { u--; s = String.fromCharCode(65 + (u % 26)) + s; u = Math.floor(u / 26); } return s; }

/** SCH_PIN::GetDefaultNetName. */
function defaultPinNet(p: PinRef, forceNoConnect: boolean): string {
  const nc = forceNoConnect || p.pin.type === "no_connect";
  let name = nc ? "unconnected-(" : "Net-(";
  const shownName = p.pin.name === "~" ? "" : p.pin.name, number = p.pin.number;
  const padNumber = number.startsWith("[") ? expandStacked(number).pins[0] : number;
  const multiple = p.pins.some((q) => (q.name === "~" ? "" : q.name) === shownName && q.number !== number && nc === (q.type === "no_connect"));
  if (p.ref.endsWith("?")) return name + p.uuid + "-Pad" + padNumber + ")";
  if (shownName && shownName !== number) {
    name += p.unitRef + "-" + escapeNetName(shownName);
    if (nc || multiple) name += "-Pad" + escapeNetName(padNumber);
    return name + ")";
  }
  return name + p.ref + "-Pad" + escapeNetName(padNumber) + ")";
}

/**
 * The netlist of a schematic hierarchy.  `loadSheet( file, parent )` resolves a sheet symbol's Sheetfile
 * (null when the project has no such document).
 */
const lowerCmp = (a: string, b: string): number => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
/** NETLIST_EXPORTER_KICAD's per-component (variants …) as KICAD_NETLIST_PARSER reads them back: for each variant
 *  of the symbol's instance, the flags whose value differs from the symbol's and the fields whose text differs. */
export function componentVariants(sym: SNode, path: string, ref: string, ver?: number | null): NetVariant[] {
  const inst = symbolInstance(sym, path); if (!inst || str(inst[1]) !== path) return [];
  const base = symbolFlags(sym), out: NetVariant[] = [];
  const fieldText = (k: string): string => { if (k === "Reference") return ref; const p = (kids(sym, "property") as SNode[]).find((q) => str(q[1]) === k); return p ? str(p[2]) : ""; };
  for (const v of kids(inst, "variant") as SNode[]) {
    const name = str(((kid(v, "name") as SNode | null) || [])[1]); if (!name || out.some((o) => o.name.toLowerCase() === name.toLowerCase())) continue;
    const eff = symbolFlagsForVariant(sym, name, path, ver), st = symbolVariant(sym, name, path, ver);
    const nv: NetVariant = { name, fields: new Map() };
    if (eff.dnp !== base.dnp) nv.dnp = eff.dnp;
    if (eff.excludedFromBOM !== base.excludedFromBOM) nv.excludedFromBOM = eff.excludedFromBOM;
    if (eff.excludedFromSim !== base.excludedFromSim) nv.excludedFromSim = eff.excludedFromSim;
    if (eff.excludedFromPosFiles !== base.excludedFromPosFiles) nv.excludedFromPosFiles = eff.excludedFromPosFiles;
    if (st) for (const [k, val] of st.fields) if (val !== fieldText(k)) nv.fields.set(k, val);
    if (nv.dnp !== undefined || nv.excludedFromBOM !== undefined || nv.excludedFromSim !== undefined || nv.excludedFromPosFiles !== undefined || nv.fields.size) out.push(nv);
  }
  return out.sort((a, b) => lowerCmp(a.name, b.name));
}

/** One top-level sheet for buildNetlist: its file, its name (TOP_LEVEL_SHEET_INFO::name) and the uuid the project file
 *  gives it ("" or absent: the file's own). */
export interface TopSheetFile { sheet: SheetFile; name: string; uuid?: string }
/**
 * `root` is the root sheet, or the schematic's top-level sheets in order (SCHEMATIC::GetTopLevelSheets).  With more
 * than one, every top-level sheet is an instance of its own whose path names it ("/<name>/"), so local labels of the
 * same text on two top-level sheets stay apart (SCH_SHEET_PATH::PathHumanReadable).
 */
export function buildNetlist(root: SheetFile | TopSheetFile[], loadSheet: (file: string, parent: SheetFile) => SheetFile | null, h: NetlistHelpers, project?: string, opts?: NetlistOptions): Netlist {
  const warnings: string[] = [];
  const textVars = (opts && opts.textVars) || null;
  const uf = new UnionFind();
  // the subgraphs (what touches on one sheet, before names join anything): a twin of `uf` that takes only the
  // physical joins (`link`)
  const sg = new UnionFind(), ufAdd = uf.add.bind(uf);
  uf.add = (): number => { sg.add(); return ufAdd(); };
  const link = (a: number, b: number): void => { uf.union(a, b); sg.union(a, b); };
  /** the items that can drive a net, by the node they sit on, in the order they were read */
  const sgItems = new Map<number, DriverItem[]>();
  const addSg = (n: number, d: DriverItem): void => { const l = sgItems.get(n); if (l) l.push(d); else sgItems.set(n, [d]); };
  /** every placed pin: its symbol path and number, its node and its own driver item */
  const pinOcc: { key: string; t: number; src: DriverItem }[] = [];
  /** the netclasses the items of a node give its net (Netclass fields, rule areas) */
  const classAt = new Map<number, Set<string>>();
  const addClass = (n: number, c: string): void => { if (!c) return; const l = classAt.get(n); if (l) l.add(c); else classAt.set(n, new Set([c])); };
  const keyNodes = new Map<string, number>();
  const keyNode = (k: string): number => { let n = keyNodes.get(k); if (n === undefined) { n = uf.add(); keyNodes.set(k, n); } return n; };
  const drivers = new Map<number, Driver[]>();          // node -> drivers attached to it
  const pinsAt = new Map<number, PinRef[]>();
  const sheetPinNodes = new Set<number>(), ncNodes = new Set<number>(), ncMarkerNodes = new Set<number>();
  interface BusLabel { text: string; prio: number; inst: Instance; conn: BusConnection | null; shape?: string }
  const busLabels = new Map<number, BusLabel[]>();
  const addDriver = (n: number, d: Driver): void => { const l = drivers.get(n); if (l) l.push(d); else drivers.set(n, [d]); };
  const components = new Map<string, NetComponent>();
  const compPins = new Map<string, PinRef[]>();

  // ---- the sheet instances, breadth first
  const tops: TopSheetFile[] = Array.isArray(root) ? root : [{ sheet: root, name: "" }];
  const multi = tops.length > 1, legacyRoot = tops.length ? tops[0].sheet.doc : null;
  const instances: Instance[] = tops.map((t, i) => ({ sheet: t.sheet, uuidPath: [t.uuid || t.sheet.uuid], human: multi ? "/" + t.name + "/" : "/", depth: 0, index: i, sheetUuids: [], name: multi ? t.name : "",
    netPrefix: multi ? "/" + escapeNetName(t.name) + "/" : "/", parent: null, sheetNode: null }));
  const mem = new Map<number, NetMember[]>();           // node -> the items attached to it (the net map's members)
  const addMem = (n: number, m: NetMember): void => { const l = mem.get(n); if (l) l.push(m); else mem.set(n, [m]); };
  const childOf = new Map<string, number>();            // "<instance index>|<sheet item id>" -> child instance index
  for (let q = 0; q < instances.length && instances.length < 2000; q++) {
    const inst = instances[q];
    for (const it of inst.sheet.doc.items.values()) {
      if (it.kind !== "sheet") continue;
      const file = propVal(it.node, "Sheetfile") || propVal(it.node, "Sheet file"), name = propVal(it.node, "Sheetname") || propVal(it.node, "Sheet name");
      if (inst.depth > 24) { warnings.push(`Sheet ${name} is nested too deeply.`); continue; }
      const sub = file ? loadSheet(file, inst.sheet) : null;
      if (!sub) { warnings.push(`Sheet file '${file}' of sheet '${name}' is not in the project.`); continue; }
      childOf.set(inst.index + "|" + it.id, instances.length);
      instances.push({ sheet: sub, uuidPath: [...inst.uuidPath, it.id], human: inst.human + name + "/", depth: inst.depth + 1, index: instances.length, sheetUuids: [...inst.sheetUuids, it.id], name,
        netPrefix: inst.netPrefix + escapeNetName(name) + "/", parent: inst, sheetNode: it.node });
    }
  }
  // ---- the bus aliases: the project's (schematic.bus_aliases) and those older sheets carry ((bus_alias "N" (members …)))
  const busAliases = new Map<string, string[]>();
  const givenAliases = opts && opts.busAliases;
  if (givenAliases) for (const [k, v] of givenAliases instanceof Map ? givenAliases : Object.entries(givenAliases)) if (k && Array.isArray(v)) busAliases.set(k, v.map(String));
  for (const inst of instances) { const own = inst.sheet.doc.busAliases; if (own) for (const name of Object.keys(own)) if (!busAliases.has(name)) busAliases.set(name, own[name]); }

  // ---- text variables in the texts that name nets (SCH_LABEL_BASE::GetShownText( path, FOR_NETNAME ), SCH_SYMBOL::GetValue)
  const pageOf = (inst: Instance): string => {
    if (!inst.parent || !inst.sheetNode) return str((inst.sheet.doc as KDoc & { pageNumber?: string }).pageNumber) || "1";
    const want = "/" + inst.parent.uuidPath.join("/"), ins = kid(inst.sheetNode, "instances") as SNode | null;
    if (ins) for (const pr of kids(ins, "project") as SNode[]) for (const p of kids(pr, "path") as SNode[]) if (str(p[1]) === want) { const pg = kid(p, "page") as SNode | null; if (pg) return str(pg[1]); }
    return "";
  };
  /** SCH_SHEET::ResolveTextVar, the sheet and then its ancestors: fields, title block, #, ##, SHEETPATH; the project last. */
  const sheetVar = (token: string, inst: Instance | null, again: (t: string) => string): string | null => {
    for (let s = inst; s; s = s.parent) {
      if (s.sheetNode) for (const p of kids(s.sheetNode, "property") as SNode[]) {
        const name = str(p[1]), fieldName = name === "Sheetname" || name === "Sheet name" ? "SHEETNAME" : name === "Sheetfile" || name === "Sheet file" ? "SHEETFILE" : name;
        if (token === fieldName) return again(str(p[2]));
      }
      else if (token === "SHEETNAME") return s.name;
      const tb = ((s.sheet.doc as KDoc & { titleBlock?: Record<string, string> }).titleBlock) || {};
      const tbKey = token === "TITLE" ? "title" : token === "ISSUE_DATE" ? "date" : token === "REVISION" ? "rev" : token === "COMPANY" ? "company" : /^COMMENT[1-9]$/.test(token) ? "comment" + token.slice(7) : "";
      if (tbKey) return again(str(tb[tbKey]));
      if (token === "#") return pageOf(s);
      if (token === "##") return String(instances.length);
      if (token === "SHEETPATH") return s.human;
    }
    if (textVars && Object.prototype.hasOwnProperty.call(textVars, token)) return again(String(textVars[token]));
    return null;
  };
  /**
   * The text a label, sheet pin or power symbol names its net with: ${…} resolved as SCH_LABEL_BASE::ResolveTextVar does
   * while the connectivity is built (the net's own name, class and operating point are empty there), then the item's
   * fields, the sheet's variables and the project's.  A token nothing resolves stays as written.
   */
  const netText = (text: string, node: SNode, kind: string, inst: Instance | null, shape?: string): string => {
    if (!hasTextVars(text)) return text;
    const expand = (t: string, depth: number): string => (depth > 10 ? t : expandTextVars(t, (token: string) => {
      if (kind !== "symbol") {
        if (/^OP(\.([0-9])?([a-zA-Z]*))?$/.test(token) || token === "NET_NAME" || token === "SHORT_NET_NAME" || token === "NET_CLASS") return "";
        if (token === "CONNECTION_TYPE" && (kind === "global_label" || kind === "hierarchical_label" || kind === "sheet_pin")) return SHAPE_LABEL[shape || ""] || "???";
      }
      if (kind !== "sheet_pin") for (const p of kids(node, "property") as SNode[]) if (str(p[1]) === token) return expand(str(p[2]), depth + 1);
      return sheetVar(token, inst, (t2) => expand(t2, depth + 1));
    }));
    return expand(text, 0);
  };
  /** SCH_SHEET_PATH::GetDNP / GetExcludedFromBOM / GetExcludedFromSim / GetExcludedFromBoard: any sheet of the path. */
  const pathFlags = (inst: Instance): { dnp: boolean; bom: boolean; sim: boolean; board: boolean } => {
    const out = { dnp: false, bom: false, sim: false, board: false };
    for (let s: Instance | null = inst; s; s = s.parent) if (s.sheetNode) { const f = symbolFlags(s.sheetNode); out.dnp ||= f.dnp; out.bom ||= f.excludedFromBOM; out.sim ||= f.excludedFromSim; out.board ||= f.excludedFromBoard; }
    return out;
  };
  /**
   * SCH_FIELD::GetShownText( path, resolveTextVars ) of a field of a placed symbol, as NETLIST_EXPORTER_XML::addSymbolFields
   * reads it: SCH_SYMBOL::ResolveTextVar (its fields, the footprint / symbol / flag tokens), then the sheet's and the
   * project's variables.  The operating point is "--" (no simulation results).  Pin functions (NET_NAME(…) and the
   * like) need the finished connectivity and are left as written.
   */
  const symText = (text: string, n: SNode, inst: Instance, s: { ref: string; unit: number; units: number; lib: SNode | null; power: boolean; localPower: boolean }): string => {
    if (text.indexOf("${") < 0) return text;
    const props = (kids(n, "property") as SNode[]).map((p) => (str(p[1]) === "private" && p.length > 3 && !isList(p[2]) && !isList(p[3]) ? [str(p[2]), str(p[3])] : [str(p[1]), str(p[2])]));
    const fpText = (): string => { const f = props.find((q) => q[0] === "Footprint"); return f ? f[1] : ""; };
    const libId = kidStr(n, "lib_id"), colon = libId.indexOf(":");
    const flags = symbolFlags(n), pf = pathFlags(inst);
    const resolve = (tok: string, depth: number): string | null => {
      if (/^OP(:[^.]*)?(.([0-9])?([a-zA-Z]*))?$/.test(tok)) return "--";
      for (const [name, value] of props) {
        // "If the field data is just a reference to the field, don't resolve"
        if (value.replace(/ /g, "").toLowerCase() === ("${" + name + "}").toLowerCase()) return tok;
        if (name.toLowerCase() !== tok.toLowerCase()) continue;
        if (name === "Reference") return s.units > 1 ? s.ref + subReference(s.lib, s.unit) : s.ref;
        return depth < 10 ? expandTextVars(value, (t: string) => resolve(t, depth + 1)) : value;
      }
      if (["SIM.DEVICE", "SIM.TYPE", "SIM.PINS", "SIM.PARAMS", "SIM.LIBRARY", "SIM.NAME"].includes(tok)) return "";
      for (const tn of (inst.sheet.doc as KDoc & { templateFieldNames?: string[] | null }).templateFieldNames || []) if (tok === tn || tok === tn.toUpperCase()) return "";
      switch (tok) {
        case "FOOTPRINT_LIBRARY": return fpText().split(":")[0];
        case "FOOTPRINT_NAME": { const parts = fpText().split(":"); return parts.length > 1 ? parts[1] : ""; }
        case "UNIT": return subReference(s.lib, s.unit);
        case "SHORT_REFERENCE": return s.ref;
        case "SYMBOL_LIBRARY": return colon >= 0 ? libId.slice(0, colon) : "";
        case "SYMBOL_NAME": return colon >= 0 ? libId.slice(colon + 1) : libId;
        case "SYMBOL_DESCRIPTION": { const d = props.find((q) => q[0] === "Description"); return d ? d[1] : ""; }
        case "SYMBOL_KEYWORDS": { const k = s.lib ? (kids(s.lib, "property") as SNode[]).find((q) => str(q[1]) === "ki_keywords") : null; return k ? str(k[2]) : ""; }
        case "SYMBOL_IS_POWER": return s.power ? "Power Symbol" : "";
        case "SYMBOL_IS_LOCAL_POWER": return s.localPower ? "Local Power Symbol" : "";
        case "EXCLUDE_FROM_BOM": return pf.bom || flags.excludedFromBOM ? "Excluded from BOM" : "";
        case "EXCLUDE_FROM_BOARD": return pf.board || flags.excludedFromBoard ? "Excluded from board" : "";
        case "EXCLUDE_FROM_SIM": return pf.sim || flags.excludedFromSim ? "Excluded from simulation" : "";
        case "DNP": return pf.dnp || flags.dnp ? "DNP" : "";
        default: break;
      }
      if (/^(SHORT_NET_NAME|NET_NAME|NET_CLASS|PIN_NAME|PIN_BASE_NAME|PIN_ALT_LIST|REFERENCE|SHORT_REFERENCE|UNIT)\(/.test(tok)) return null;
      return sheetVar(tok, inst, (t2) => expandTextVars(t2, (t3: string) => resolve(t3, depth + 1)));
    };
    return expandTextVars(text, (t: string) => resolve(t, 0));
  };
  /** What NETLIST_EXPORTER_XML::addSymbolFields scavenges from each unit of a multi-unit symbol (by reference). */
  interface UnitFields { unit: number; uuid: string; value: string; footprint: string; datasheet: string; description: string; fields: [string, string][] }
  const unitFields = new Map<string, UnitFields[]>();
  const compUnits = new Map<NetComponent, number>();

  // ---- connectivity of each instance
  for (const inst of instances) {
    const doc = inst.sheet.doc, I = inst.index;
    // the sheet's groups by member (SCH_ITEM::GetParentGroup)
    const symGroup = new Map<string, { uuid: string; name: string }>();
    for (const it of doc.items.values()) if (it.kind === "group") { const m = kid(it.node, "members") as SNode | null; const g = { uuid: kidStr(it.node, "uuid") || it.id, name: typeof it.node[1] === "string" ? str(it.node[1]) : "" }; if (m) for (const id of m.slice(1)) symGroup.set(str(id), g); }
    interface Line { a: Pt; b: Pt; node: number; bus: boolean }
    const lines: Line[] = [];
    /** what the rule areas of the sheet may contain: wires and buses, pins and labels by their node */
    const areaLines: { node: number; a: Pt; b: Pt }[] = [], areaPoints: { node: number; p: Pt }[] = [];
    const ends = new Map<string, number[]>();           // point -> line indices ending there
    for (const it of doc.items.values()) {
      if (it.kind !== "wire" && it.kind !== "bus") continue;
      const pts = ptsOf(it.node) as Pt[]; if (pts.length < 2) continue;
      const node = uf.add();
      addMem(node, { inst: I, id: it.id, kind: it.kind });
      for (let k = 1; k < pts.length; k++) {
        const li = lines.length; lines.push({ a: pts[k - 1], b: pts[k], node, bus: it.kind === "bus" });
        areaLines.push({ node, a: pts[k - 1], b: pts[k] });
        for (const p of [pts[k - 1], pts[k]]) { const key = pkey(p); const l = ends.get(key); if (l) l.push(li); else ends.set(key, [li]); }
      }
    }
    /** nodes of the lines of one kind that END at p (SCH_LINE::GetConnectionPoints: a line connects at its two ends) */
    const lineEndsAt = (p: Pt, bus: boolean): number[] => {
      const out: number[] = [];
      for (const li of ends.get(pkey(p)) || []) if (lines[li].bus === bus) out.push(lines[li].node);
      return out;
    };
    /** nodes of the lines of one kind that pass through p (ends and middles): what a junction and a label reach */
    const linesThrough = (p: Pt, bus: boolean): number[] => {
      const out = lineEndsAt(p, bus);
      for (const l of lines) if (l.bus === bus && distSeg(p, l.a, l.b) <= 1e-3) out.push(l.node);
      return out;
    };
    // line ends meet line ends; an end resting on the middle of another line joins it only through a junction
    for (const l of lines) for (const p of [l.a, l.b]) for (const n of lineEndsAt(p, l.bus)) link(l.node, n);
    const junctions: { id: string; p: Pt }[] = [], junctionAt = new Set<string>();
    for (const it of doc.items.values()) {
      if (it.kind !== "junction") continue;
      const p = (atOf(it.node) as number[]).slice(0, 2) as Pt;
      // CONNECTION_GRAPH::updateItemConnectivity: a junction connects the wires that pass through it as midpoints
      for (const bus of [false, true]) { const ns = linesThrough(p, bus); for (let k = 1; k < ns.length; k++) link(ns[0], ns[k]); }
      junctions.push({ id: it.id, p }); junctionAt.add(pkey(p));
    }
    /** the lines an item with a connection point at p meets: those ending there, and with a junction there those passing through */
    const linesAt = (p: Pt, bus: boolean): number[] => (junctionAt.has(pkey(p)) ? linesThrough(p, bus) : lineEndsAt(p, bus));
    // point terminals: a node each, joined to the line under them and to one another
    const points = new Map<string, number[]>();
    // KiCad merges same-named drivers on this sheet before connecting global drivers across sheets.
    const connectGlobal = (n: number, name: string, prio: number, src?: DriverItem): void => {
      uf.union(n, keyNode(`${I}|local:${name}`));
      uf.union(n, keyNode("global:" + name));
      addDriver(n, { prio, name: escapeNetName(name), depth: inst.depth, src });
    };
    /** CONNECTION_SUBGRAPH::GetNetclassesForDriver: an item's "Netclass" fields, their variables resolved */
    const fieldClasses = (n: number, node: SNode, k: string, shape?: string): void => {
      for (const p of kids(node, "property") as SNode[]) if (str(p[1]) === "Netclass") addClass(n, netText(str(p[2]), node, k, inst, shape));
    };

    /** `through`: a label, which also takes the line whose middle it sits on (SCH_LABEL_BASE::UpdateDanglingState) */
    const terminal = (p: Pt, bus: boolean, through = false): number => {
      const n = uf.add();
      for (const ln of through ? linesThrough(p, bus) : linesAt(p, bus)) link(n, ln);
      const key = (bus ? "b" : "w") + pkey(p); const l = points.get(key);
      if (l) { link(l[0], n); l.push(n); } else points.set(key, [n]);
      return n;
    };
    const path = "/" + inst.uuidPath.join("/");
    // legacy invisible power-input pins of ordinary symbols: tied to the global net of their name only when nothing is attached
    const hiddenPower: { t: number; name: string; p: Pt; src: DriverItem }[] = [];
    for (const it of doc.items.values()) {
      const n = it.node, k = it.kind;
      if (k === "label" || k === "global_label" || k === "hierarchical_label") {
        const shape = kidStr(n, "shape");
        const text = netText(str(n[1]), n, k, inst, shape), p = (atOf(n) as number[]).slice(0, 2) as Pt, bus = isBusLabel(text);
        const t = terminal(p, bus, true);
        addMem(t, { inst: I, id: it.id, kind: k, text });
        const src: DriverItem = { kind: k, inst: I, id: it.id, prio: k === "label" ? KP_LOCAL : k === "global_label" ? KP_GLOBAL : KP_HIER, x: p[0], y: p[1], text };
        addSg(t, src); fieldClasses(t, n, k, shape); areaPoints.push({ node: t, p });
        if (bus) {
          const l = busLabels.get(t) || []; busLabels.set(t, l);
          l.push({ text, prio: k === "label" ? P_LOCAL : k === "global_label" ? P_GLOBAL : P_HIER, inst, conn: busConnection(text, busAliases) });
          uf.union(t, keyNode(k === "global_label" ? "gbus:" + text : k === "label" ? `${I}|lbus:${text}` : `${I}|hbus:${text}`));
        } else if (k === "label") { uf.union(t, keyNode(`${I}|local:${text}`)); addDriver(t, { prio: P_LOCAL, name: inst.netPrefix + escapeNetName(text), depth: inst.depth, src }); }
        else if (k === "global_label") connectGlobal(t, text, P_GLOBAL, src);
        // a hierarchical label also names the net on its own sheet: it joins the local labels of that name
        else { uf.union(t, keyNode(`${I}|hier:${text}`)); uf.union(t, keyNode(`${I}|local:${text}`)); addDriver(t, { prio: P_HIER, name: inst.netPrefix + escapeNetName(text), depth: inst.depth, src }); }
      } else if (k === "netclass_flag" || k === "directive_label") {
        // a directive label sits on a net without naming it (on a bus when no wire passes there); its Netclass field
        // assigns the net's class
        const p = (atOf(n) as number[]).slice(0, 2) as Pt, onBus = !linesThrough(p, false).length && linesThrough(p, true).length > 0;
        const t = terminal(p, onBus, true);
        addMem(t, { inst: I, id: it.id, kind: k, text: str(n[1]) });
        fieldClasses(t, n, "directive_label");
      } else if (k === "sheet") {
        const child = childOf.get(I + "|" + it.id);
        const sheetName = propVal(n, "Sheetname") || propVal(n, "Sheet name");
        // a sheet pin resolves its variables through its own sheet symbol first (SCH_LABEL_BASE::ResolveTextVar)
        const owner: Instance = child !== undefined ? instances[child] : { sheet: inst.sheet, uuidPath: [...inst.uuidPath, it.id], human: inst.human + sheetName + "/", depth: inst.depth + 1, index: -1, sheetUuids: [], name: sheetName, netPrefix: "", parent: inst, sheetNode: n };
        for (const pin of kids(n, "pin") as SNode[]) {
          const shape = typeof pin[2] === "string" ? str(pin[2]) : "";
          const text = netText(str(pin[1]), pin, "sheet_pin", owner, shape), p = (atOf(pin) as number[]).slice(0, 2) as Pt, bus = isBusLabel(text);
          const t = terminal(p, bus);
          addMem(t, { inst: I, id: it.id, kind: "sheet_pin", pin: str(pin[1]), text: sheetName });
          const src: DriverItem = { kind: "sheet_pin", inst: I, id: it.id, prio: KP_SHEET_PIN, x: p[0], y: p[1], sheetPin: str(pin[1]), text };
          addSg(t, src);
          if (bus) {
            const l = busLabels.get(t) || []; busLabels.set(t, l); l.push({ text, prio: P_SHEET_PIN, inst, conn: busConnection(text, busAliases), shape });
            if (child !== undefined) uf.union(t, keyNode(`${child}|hbus:${text}`));
          } else {
            sheetPinNodes.add(t); addDriver(t, { prio: P_SHEET_PIN, name: inst.netPrefix + escapeNetName(text), depth: inst.depth, shape, path, id: kidStr(pin, "uuid") || it.id + "#" + text, src });
            if (child !== undefined) uf.union(t, keyNode(`${child}|hier:${text}`));
          }
        }
      } else if (k === "symbol") {
        const legacyValue = legacyRoot && legacyRoot.legacySymbolInstances && legacyRoot.legacySymbolInstances.get("/" + [...inst.uuidPath.slice(1), it.id].join("/"));
        const power = h.isPower(doc, it), rawValue = legacyValue && legacyValue.value ? legacyValue.value : propVal(n, "Value"), localPower = power && (h.isLocalPower ? h.isLocalPower(doc, it) : libIsLocalPower(doc, n));
        const value = power ? netText(rawValue, n, "symbol", inst) : rawValue;
        const { ref, unit } = instanceRef(n, path, project, legacyRoot ? legacyRoot.legacySymbolInstances : undefined);
        const inNetlist = !ref.startsWith("#") && !power, onBoard = yes(n, "on_board", true);
        const pins = h.symbolPins(doc, it);
        const units = unitCount(doc, n), unitRef = units > 1 ? ref + unitLetter(unit) : ref;
        let comp: NetComponent | undefined;
        if (inNetlist) {
          // addSymbolFields: every non-mandatory field that is not private, then Datasheet and Description, all with
          // their variables resolved; the netlist writes an empty value as "~"
          const symLib = resolveLib(doc, kidStr(n, "lib_name") || kidStr(n, "lib_id")) || resolveLib(doc, kidStr(n, "lib_id"));
          const sctx = { ref, unit, units, lib: symLib, power, localPower: !!localPower };
          const userFields: [string, string][] = [];
          let datasheet = "", description = "";
          for (const p of kids(n, "property") as SNode[]) {
            if (str(p[1]) === "private" && p.length > 3 && !isList(p[2]) && !isList(p[3])) continue;
            const name = str(p[1]);
            if (name === "Reference" || name === "Value" || name === "Footprint") continue;
            if (name === "Datasheet") { datasheet = symText(str(p[2]), n, inst, sctx); continue; }
            if (name === "Description") { description = symText(str(p[2]), n, inst, sctx); continue; }
            userFields.push([name, symText(str(p[2]), n, inst, sctx)]);
          }
          const rec: UnitFields = { unit, uuid: it.id, value: symText(rawValue, n, inst, sctx), footprint: symText(propVal(n, "Footprint"), n, inst, sctx), datasheet, description, fields: userFields };
          const lk = ref.toLowerCase(), recs = unitFields.get(lk); if (recs) recs.push(rec); else unitFields.set(lk, [rec]);
          const pf = pathFlags(inst);
          if (onBoard && !pf.board) {
            const path = "/" + [...inst.sheetUuids, it.id].join("/");
            comp = components.get(ref);
            if (!comp) {
              const fields: Record<string, string> = {};
              for (const [k, v] of userFields) fields[k] = v;
              fields.Datasheet = datasheet; fields.Description = description;
              const f = symbolFlags(n);
              comp = { ref, value: rec.value || "~", footprint: rec.footprint, libId: kidStr(n, "lib_id"), paths: [path], fields, sheetName: inst.human, sheetFile: inst.sheet.file.split("/").pop() || inst.sheet.file,
                dnp: f.dnp || pf.dnp, excludeFromBom: f.excludedFromBOM || pf.bom, excludeFromBoard: false, excludeFromSim: f.excludedFromSim || pf.sim, excludeFromPosFiles: f.excludedFromPosFiles, pins: new Map() };
              if (symLib) {
                // the library symbol's ki_fp_filters (joined by single spaces), jumper flag and jumper pin groups
                const fl = (kids(symLib, "property") as SNode[]).find((q) => str(q[1]) === "ki_fp_filters");
                const filters = fl ? str(fl[2]).split(/\s+/).filter(Boolean).join(" ") : "";
                if (filters) comp.fpFilters = filters;
                if (yes(symLib, "duplicate_pin_numbers_are_jumpers", false)) comp.dupPinsAreJumpers = true;
                const jg = kid(symLib, "jumper_pin_groups") as SNode | null;
                if (jg) { const groups = jg.slice(1).filter(isList).map((g) => (g as SNode).map(str)); if (groups.length) comp.jumperPinGroups = groups; }
              }
              const variants = componentVariants(n, "/" + inst.uuidPath.join("/"), ref, (doc as KDoc).version); if (variants.length) comp.variants = variants;
              const grp = symGroup.get(it.id); if (grp) comp.group = grp;
              components.set(ref, comp); compPins.set(ref, []); compUnits.set(comp, units);
              if (symLib) comp.unitInfo = libUnitPinInfo(symLib, units);
            } else { if (unit === 1) comp.paths.unshift(path); else comp.paths.push(path); }
            // a placed unit whose library copy differs (a unit-specific edit) gives that unit's slot from its own copy
            if (symLib && comp.unitInfo && unit >= 1 && unit <= comp.unitInfo.length) { const own = libUnitPinInfo(symLib, units); if (own[unit - 1]) comp.unitInfo[unit - 1] = own[unit - 1]; }
          }
        }
        const byNumber = new Map<string, number[]>(), pinTerms: { pin: SymPin; t: number }[] = [];
        for (const pin of pins) {
          const t = terminal([pin.x, pin.y], false);
          pinTerms.push({ pin, t }); const same = byNumber.get(pin.number); if (same) same.push(t); else byNumber.set(pin.number, [t]);
          addMem(t, { inst: I, id: it.id, kind: "pin", pin: pin.number, pinName: pin.name, ref: unitRef, symRef: ref, power });
          // GetDriverPriority: SCH_PIN::IsGlobalPower (a power symbol's power input, or the legacy invisible power input
          // of an ordinary symbol), IsLocalPower, then NONE for a symbol excluded from the board or a "#" reference
          const pinPrio = pin.type === "power_in" && localPower ? KP_LOCAL_POWER : pin.type === "power_in" && (power || pin.hidden) ? KP_GLOBAL_POWER
            : !onBoard || ref.startsWith("#") ? KP_NONE : KP_PIN;
          const src: DriverItem = { kind: "pin", inst: I, id: it.id, prio: pinPrio, x: pin.x, y: pin.y, pin: pin.number, power: pinPrio >= KP_LOCAL_POWER };
          addSg(t, src); areaPoints.push({ node: t, p: [pin.x, pin.y] });
          pinOcc.push({ key: "/" + [...inst.sheetUuids, it.id].join("/") + "#" + pin.number, t, src });
          // CONNECTION_GRAPH: a local power pin joins the sheet's local label cache (sheet, name), not the global one
          if (localPower && value && pin.type === "power_in") { uf.union(t, keyNode(`${I}|local:${value}`)); addDriver(t, { prio: P_LOCAL_POWER, name: inst.netPrefix + escapeNetName(value), depth: inst.depth, src }); continue; }
          if (power && value && pin.type === "power_in") { connectGlobal(t, value, P_POWER, src); continue; }
          // generateGlobalPowerPinSubGraphs: an invisible power-input pin of an ordinary symbol, decided once the sheet is read
          if (!power && pin.hidden && pin.type === "power_in") hiddenPower.push({ t, name: pin.name, p: [pin.x, pin.y], src });
          if (pin.type === "no_connect") ncNodes.add(t);
          // GetDriverPriority: PRIORITY::PIN for a symbol that reaches the board, PRIORITY::NONE for a #-reference
          // (a PWR_FLAG's pin) or a symbol excluded from the board: those name a net only when no other pin is on it
          const pr: PinRef = { comp: comp ? ref : null, ref, unitRef, pin, pins, uuid: it.id, power, inNetlist, onBoard: inNetlist && onBoard, path, src };
          const l = pinsAt.get(t); if (l) l.push(pr); else pinsAt.set(t, [pr]);
          if (comp) (compPins.get(ref) as PinRef[]).push(pr);
        }
        // updateSymbolConnectivity: "duplicate pin numbers are jumpers" links the pins of one number, each jumper pin
        // group its named pins (a member may name one contact of a stacked pin such as [A1,A12])
        const lib = resolveLib(doc, kidStr(n, "lib_name") || kidStr(n, "lib_id")) || resolveLib(doc, kidStr(n, "lib_id"));
        if (lib) {
          if (yes(lib, "duplicate_pin_numbers_are_jumpers", false)) for (const ts of byNumber.values()) for (let j = 1; j < ts.length; j++) link(ts[0], ts[j]);
          const jg = kid(lib, "jumper_pin_groups") as SNode | null;
          if (jg) for (const g of jg.slice(1)) {
            if (!isList(g)) continue;
            const found: number[] = [];
            for (const nm of g as SNode) {
              const number = str(nm);
              let hit = pinTerms.find((q) => q.pin.number === number);
              if (!hit) hit = pinTerms.find((q) => q.pin.number.startsWith("[") && expandStacked(q.pin.number).pins.includes(number));
              if (hit && !found.includes(hit.t)) found.push(hit.t);
            }
            for (let j = 1; j < found.length; j++) link(found[0], found[j]);
          }
        }
      }
    }
    const ncAt = new Set<string>();
    for (const it of doc.items.values()) {
      if (it.kind !== "no_connect") continue;
      const p = (atOf(it.node) as number[]).slice(0, 2) as Pt;
      ncAt.add(pkey(p));
      const l = points.get("w" + pkey(p)), under = l ? [l[0]] : linesAt(p, false);
      for (const on of under) { ncNodes.add(on); ncMarkerNodes.add(on); }
      addMem(under.length ? under[0] : terminal(p, false), { inst: I, id: it.id, kind: "no_connect" });
    }
    // a junction belongs to the net of the lines it joins (wires first)
    for (const j of junctions) { const w = linesThrough(j.p, false), b = linesThrough(j.p, true); addMem(w.length ? w[0] : b.length ? b[0] : terminal(j.p, false), { inst: I, id: j.id, kind: "junction" }); }
    // SCH_BUS_WIRE_ENTRY::GetConnectionPoints: both ends connect.  The end on a bus line meets bus items only; an end
    // away from a bus meets whatever has a connection point there, so an entry between two wires joins them.
    for (const it of doc.items.values()) {
      if (it.kind !== "bus_entry") continue;
      const [x, y] = atOf(it.node) as number[], sz = kid(it.node, "size") as SNode | null;
      const p1: Pt = [x, y], p2: Pt = [x + (sz ? num(sz[1]) : 0), y + (sz ? num(sz[2]) : 0)];
      const ts: number[] = [];
      for (const p of [p1, p2]) if (!linesThrough(p, true).length) ts.push(terminal(p, false));
      if (ts.length === 2) link(ts[0], ts[1]);
      addMem(ts.length ? ts[0] : uf.add(), { inst: I, id: it.id, kind: "bus_entry" });
    }
    // "ERC will warn about this: user has wired up an invisible pin": the implicit global net only for a pin nothing touches
    for (const hp of hiddenPower) {
      const key = pkey(hp.p), l = points.get("w" + key);
      const attached = (l && l.length > 1) || linesAt(hp.p, false).length > 0 || ncAt.has(key) || junctionAt.has(key);
      if (!attached && hp.name) connectGlobal(hp.t, hp.name, P_POWER, hp.src);
    }
    // SCH_RULE_AREA::RefreshContainedItemsAndDirectives: the directive labels whose connection point is on the area's
    // border give their Netclass fields to the wires and buses the area collides with and to the pins and labels
    // whose connection point lies in it (GetResolvedNetclasses)
    for (const it of doc.items.values()) {
      if (it.kind !== "rule_area") continue;
      const pl = kid(it.node, "polyline") as SNode | null, poly = (pl ? ptsOf(pl) : []) as Pt[];
      if (poly.length < 3) continue;
      const onEdge = (p: Pt): boolean => poly.some((v, i) => distSeg(p, v, poly[(i + 1) % poly.length]) <= 5e-4);
      const classes: string[] = [];
      for (const dl of doc.items.values()) {
        if (dl.kind !== "netclass_flag" && dl.kind !== "directive_label") continue;
        if (!onEdge((atOf(dl.node) as number[]).slice(0, 2) as Pt)) continue;
        for (const p of kids(dl.node, "property") as SNode[]) if (str(p[1]) === "Netclass") { const c = netText(str(p[2]), dl.node, "directive_label", inst); if (c) classes.push(c); }
      }
      if (!classes.length) continue;
      const inside = (p: Pt): boolean => { if (onEdge(p)) return true; let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
      const cross = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => { const o = (p: Pt, q: Pt, r: Pt): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b); };
      for (const ln of areaLines) if (inside(ln.a) || inside(ln.b) || poly.some((v, i) => cross(ln.a, ln.b, v, poly[(i + 1) % poly.length]))) for (const c of classes) addClass(ln.node, c);
      for (const ap of areaPoints) if (inside(ap.p)) for (const c of classes) addClass(ap.node, c);
    }
  }

  // ---- buses: each bus group names its members after its best label and hands the names to the member wires
  const busGroups = new Map<number, BusLabel[]>();
  for (const [n, l] of busLabels) { const r = uf.find(n); const g = busGroups.get(r); if (g) g.push(...l); else busGroups.set(r, l.slice()); }
  /** SCH_CONNECTION::IsSubsetOf for two buses: every member of a is a member of b (by FullLocalName). */
  const busSubset = (a: BusConnection, b: BusConnection): boolean => a.members.every((m) => b.members.some((o) => o.full === m.full));
  interface Ranked { prio: number; depth: number; name: string; shape?: string; bus?: BusConnection | null }
  // compareDrivers: priority; of two buses the superset; of two sheet pins the output; "-Pad" names last; then by name
  const better = (a: Ranked, b: Ranked): number => {
    const sa = a.prio >= P_HIER, sb = b.prio >= P_HIER;
    if (sa !== sb) return sa ? -1 : 1;
    if (a.prio !== b.prio) return b.prio - a.prio;
    if (sa && a.depth !== b.depth) return a.depth - b.depth;
    if (a.bus && b.bus) { const aInB = busSubset(a.bus, b.bus), bInA = busSubset(b.bus, a.bus); if (bInA && !aInB) return -1; if (aInB && !bInA) return 1; }
    if (a.prio === P_SHEET_PIN && b.prio === P_SHEET_PIN && (a.shape || "") !== (b.shape || "")) { if (a.shape === "output") return -1; if (b.shape === "output") return 1; }
    const la = a.name.includes("-Pad"), lb = b.name.includes("-Pad");
    if (la !== lb) return la ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };
  let groupN = 0;
  const busInfo: { rep: number; name: string; members: number[]; aliases: { name: string; members: string[] }[] }[] = [];
  for (const [rep, labels] of busGroups) {
    const best = labels.slice().sort((a, b) => better({ prio: a.prio, depth: a.inst.depth, name: a.text, shape: a.shape, bus: a.conn }, { prio: b.prio, depth: b.inst.depth, name: b.text, shape: b.shape, bus: b.conn }))[0];
    const busPrefix = best.prio === P_GLOBAL ? "" : best.inst.netPrefix;
    const info = { rep, name: busPrefix + escapeNetName(best.text), members: [] as number[], aliases: best.conn ? best.conn.aliases : [] }; busInfo.push(info);
    // SCH_CONNECTION::ConfigureFromLabel: a vector's members by index, a group's ("NAME{A B[0..3] ALIAS}") by name with
    // the group's prefix ("NAME.A"), an alias replaced by its own members
    const bc = best.conn; if (!bc || !bc.members.length) continue;
    const g = groupN++;
    for (let k = 0; k < bc.members.length; k++) info.members.push(keyNode(`busmember:${g}:${k}`));
    for (const l of labels) {
      const lc = l.conn; if (!lc) continue;
      for (let j = 0; j < lc.members.length; j++) {
        // matchBusMember: which member of the bus this label's member is
        const k = l === best ? j : matchBusMember(bc, lc.members[j]); if (k < 0) continue;
        const m = keyNode(`busmember:${g}:${k}`);
        if (!drivers.has(m)) addDriver(m, { prio: P_BUS_MEMBER, name: busPrefix + bc.members[k].full, depth: best.inst.depth });
        // generateBusAliasMembers: the member is a net of its full local name on the label's sheet
        uf.union(m, keyNode(`${l.inst.index}|local:${lc.members[j].full}`));
      }
    }
  }

  // ---- names
  interface Group { drivers: Driver[]; pins: PinRef[]; nc: boolean; ncMarker: boolean; sheetPin: boolean }
  const groups = new Map<number, Group>();
  const groupOf = (n: number): Group => { const r = uf.find(n); let g = groups.get(r); if (!g) { g = { drivers: [], pins: [], nc: false, ncMarker: false, sheetPin: false }; groups.set(r, g); } return g; };
  for (const [n, l] of drivers) groupOf(n).drivers.push(...l);
  for (const [n, l] of pinsAt) groupOf(n).pins.push(...l);
  for (const n of ncNodes) groupOf(n).nc = true;
  for (const n of ncMarkerNodes) groupOf(n).ncMarker = true;
  for (const n of sheetPinNodes) groupOf(n).sheetPin = true;
  const nets = new Map<string, { ref: string; pin: string }[]>();
  /** the group's name; `weak`: no label or power pin names it (m_strong_driver false); `ident`: stableDriverIdentity of its driver */
  interface Named { name: string; weak: boolean; ident: string; src?: DriverItem }
  const computeName = (g: Group): Named => {
    const strong = g.drivers.filter((d) => d.prio >= P_HIER);
    if (strong.length) { const d = strong.sort(better)[0]; return { name: d.name, weak: false, ident: "", src: d.src }; }
    if (g.drivers.length) { const d = g.drivers.sort(better)[0]; return { name: d.name, weak: d.prio === P_SHEET_PIN, ident: (d.path || "") + "|" + (d.id || ""), src: d.src }; }   // a sheet pin with nothing behind it
    // GetDriverPriority: the pins that reach the board (PRIORITY::PIN) first; a net of only #-references and symbols
    // excluded from the board is named by those (PRIORITY::NONE)
    const onBoard = g.pins.filter((p) => p.onBoard), cands = onBoard.length ? onBoard : g.pins;
    // "Make sure weakly-driven single-pin nets get the unconnected_ prefix": one pin in all, whatever its symbol
    const force = g.nc || g.pins.length === 1;
    const ranked = cands.map((p) => ({ p, name: defaultPinNet(p, force) })).sort((a, b) => better({ prio: P_PIN, depth: 0, name: a.name }, { prio: P_PIN, depth: 0, name: b.name })
      || (a.p.uuid < b.p.uuid ? -1 : a.p.uuid > b.p.uuid ? 1 : 0) || (a.p.pin.number < b.p.pin.number ? -1 : a.p.pin.number > b.p.pin.number ? 1 : 0));
    const top = ranked[0];
    return top ? { name: top.name, weak: true, ident: top.p.path + "|" + top.p.uuid + "|" + top.p.pin.number, src: top.p.src } : { name: "", weak: false, ident: "" };
  };
  const named = new Map<Group, Named>();
  for (const g of groups.values()) named.set(g, computeName(g));
  // processSubGraphs: a weakly driven net whose name another net already has is renamed NAME_1, NAME_2 … (the first
  // number no net uses); the weak nets of one name are taken in the order of their sheet path and driver, so the last
  // of them keeps the plain name when no label owns it
  {
    const count = new Map<string, number>(), weakBy = new Map<string, Named[]>();
    for (const nm of named.values()) { if (!nm.name) continue; count.set(nm.name, (count.get(nm.name) || 0) + 1); if (nm.weak) { const l = weakBy.get(nm.name); if (l) l.push(nm); else weakBy.set(nm.name, [nm]); } }
    for (const [base, list] of weakBy) {
      if ((count.get(base) || 0) < 2) continue;
      list.sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0));
      for (const nm of list) {
        if ((count.get(base) || 0) < 2) break;
        let suffix = 1, name = base + "_" + suffix++;
        while (count.has(name)) name = base + "_" + suffix++;
        count.set(base, (count.get(base) as number) - 1); count.set(name, 1); nm.name = name;
      }
    }
  }
  const nameOf = (g: Group): string => (named.get(g) as Named).name;
  for (const g of groups.values()) {
    const netPins = g.pins.filter((p) => p.comp);
    if (!netPins.length) continue;
    const name = nameOf(g);
    for (const p of netPins) {
      const comp = components.get(p.comp as string) as NetComponent;
      if (!p.pin.number) continue;
      // netlist_exporter_xml.cpp: pinfunction is "<name>_<number>", the type gains "+no_connect" on a lone pin that
      // carries a no-connect MARKER (hasNoConnect: a SCH_NO_CONNECT_T item, not the pin's electrical type)
      const shown = p.pin.name === "~" ? "" : p.pin.name;
      const type = p.pin.type + (g.ncMarker && netPins.length === 1 ? "+no_connect" : "");
      const pads = expandStacked(p.pin.number).pins;
      let members = nets.get(name);
      if (!members) { members = []; nets.set(name, members); }
      for (const pad of pads) {
        const pinFunction = shown ? shown + "_" + pad : pads.length > 1 ? pad : "";
        // eraseDuplicatePins: of two pins with one pad number (units sharing a pad) the one on a named net is kept
        const had = comp.pins.get(pad);
        if (!had || (autoNetName(had.net) && !autoNetName(name))) comp.pins.set(pad, { net: name, name: pinFunction, type });
        members.push({ ref: comp.ref, pin: pad });
      }
    }
  }
  // ---- the net map: every named net and bus with its items (a net with no name, a lone wire, is left out as KiCad does)
  const netMap = new Map<string, NetEntry>();
  const busRoots = new Map<number, { name: string; members: number[]; aliases: { name: string; members: string[] }[] }>();
  for (const b of busInfo) busRoots.set(uf.find(b.rep), b);
  const memberRoots = new Map<number, NetMember[]>();
  for (const [n, l] of mem) { const r = uf.find(n); const x = memberRoots.get(r); if (x) x.push(...l); else memberRoots.set(r, l.slice()); }
  const groupName = (r: number): string => { const g = groups.get(r); return g ? nameOf(g) : ""; };
  for (const [r, members] of memberRoots) {
    const bus = busRoots.get(r);
    const name = bus ? bus.name : groupName(r); if (!name) continue;
    let e = netMap.get(name);
    if (!e) { e = { name, bus: !!bus, members: [], busMembers: [] }; netMap.set(name, e); }
    if (!bus && !e.driver) { const g = groups.get(r), nm = g ? named.get(g) : undefined; if (nm && nm.src) e.driver = nm.src; }
    e.members.push(...members);
    if (bus && bus.aliases.length) e.aliases = bus.aliases;
    if (bus) for (const m of bus.members) { const mn = groupName(uf.find(m)); if (mn && !e.busMembers.includes(mn)) e.busMembers.push(mn); }
  }
  // addSymbolFields for a multi-unit symbol: value, footprint, datasheet and description from the lowest unit (then
  // uuid) with a non-blank text, each other field from the lowest unit holding a non-blank one (a blank one only when
  // no unit has text)
  for (const comp of components.values()) {
    if ((compUnits.get(comp) || 1) < 2) continue;
    const recs = unitFields.get(comp.ref.toLowerCase()); if (!recs || recs.length < 2) continue;
    const rank = (a: UnitFields, b: UnitFields): number => a.unit - b.unit || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0);
    const sorted = recs.slice().sort(rank);
    const first = (get: (r: UnitFields) => string): string => { for (const r of sorted) { const v = get(r); if (v) return v; } return ""; };
    const fields: Record<string, string> = {}, best = new Map<string, UnitFields>();
    for (const r of recs) for (const [k, v] of r.fields) {
      const had = best.get(k);
      const better = !had || (v === "" ? 1 : 0) - ((fields[k] === "") ? 1 : 0) < 0 || ((v === "") === (fields[k] === "") && rank(r, had) < 0);
      if (better) { fields[k] = v; best.set(k, r); }
    }
    fields.Datasheet = first((r) => r.datasheet); fields.Description = first((r) => r.description);
    comp.value = first((r) => r.value) || "~"; comp.footprint = first((r) => r.footprint); comp.fields = fields;
  }
  // ---- each pin's drivers (BACK_ANNOTATE::processNetNameChange): the items of its subgraph in the order they were
  // read, the pin itself first, and its net's winning driver
  const islandItems = new Map<number, DriverItem[]>();
  for (const [n, l] of sgItems) { const r = sg.find(n); const x = islandItems.get(r); if (x) x.push(...l); else islandItems.set(r, l.slice()); }
  const pinDrivers = new Map<string, PinDrivers>();
  for (const occ of pinOcc) {
    if (pinDrivers.has(occ.key)) continue;
    let physical: DriverItem | null = null, best = KP_NONE;
    for (const d of [occ.src, ...(islandItems.get(sg.find(occ.t)) || []).filter((x) => x !== occ.src)]) if (d.prio > best) { physical = d; best = d.prio; }
    const g = groups.get(uf.find(occ.t)), nm = g ? named.get(g) : undefined;
    pinDrivers.set(occ.key, { net: nm ? nm.name : "", physical, resolved: (nm && nm.src) || null });
  }
  // ---- CONNECTION_GRAPH's checkNetclassDrivers: the classes of every subgraph of a net go to its name, a bus's to its members too
  const netclassLabels = new Map<string, Set<string>>();
  const assign = (name: string, cs: Set<string>): void => { if (!name || !cs.size) return; const l = netclassLabels.get(name); if (l) for (const c of cs) l.add(c); else netclassLabels.set(name, new Set(cs)); };
  for (const [n, cs] of classAt) {
    const r = uf.find(n), bus = busRoots.get(r);
    if (!bus) { assign(groupName(r), cs); continue; }
    assign(bus.name, cs);
    for (const m of bus.members) assign(groupName(uf.find(m)), cs);
  }
  const instOut: SheetInstance[] = instances.map((i) => ({ index: i.index, human: i.human, file: i.sheet.file, uuidPath: i.uuidPath, sheetName: i.name }));
  return { components: Array.from(components.values()), nets, warnings, netMap, instances: instOut, pinDrivers, netclassLabels };
}

/** The project file's part of the netlist: schematic.bus_aliases and text_variables of a parsed .kicad_pro (or its text). */
export function netlistOptions(pro: unknown): NetlistOptions {
  let j: unknown = pro;
  if (typeof pro === "string") { try { j = pro ? JSON.parse(pro) : null; } catch (e) { j = null; } }
  const o = (j && typeof j === "object" ? j : {}) as { schematic?: { bus_aliases?: unknown }; text_variables?: unknown };
  const out: NetlistOptions = {};
  const ba = o.schematic && o.schematic.bus_aliases;
  if (ba && typeof ba === "object") { const m = new Map<string, string[]>(); for (const [k, v] of Object.entries(ba as Record<string, unknown>)) if (k && Array.isArray(v)) m.set(k, v.map(String)); out.busAliases = m; }
  if (o.text_variables && typeof o.text_variables === "object") out.textVars = o.text_variables as Record<string, string>;
  return out;
}

// ---------------------------------------------------------------- the board update
export interface UpdateOptions {
  /** "Re-link footprints to schematic symbols based on their reference designators" */
  relinkByRef?: boolean;
  /** "Replace footprints with those specified by symbols" */
  replaceFootprints?: boolean;
  /** "Delete footprints with no symbols" */
  deleteUnused?: boolean;
  /** "Override locks" */
  overrideLocks?: boolean;
  /** "Update footprint fields from symbols" */
  updateFields?: boolean;
  /** "Remove footprint fields not found in symbols" */
  removeExtraFields?: boolean;
  /** "Group footprints based on symbol group" (BOARD_NETLIST_UPDATER::SetTransferGroups) */
  transferGroups?: boolean;
  /** "Apply design block layouts to new groups": the board has no design block links here, so it changes nothing yet */
  applyDesignBlockLayouts?: boolean;
  /** the board footprint for a library id, or null when the library is not available (or has no such footprint) */
  footprintFor?(fpid: string): SNode | null | "missing";
  /** text size / thickness / italic / keep-upright of new fields (the board's Fab-layer defaults, StyleFromSettings) */
  fieldSize?: number; fieldSizeV?: number; fieldThickness?: number; fieldItalic?: boolean; fieldUpright?: boolean;
  /** the real run (dry run off): the past-tense wording and the lines only it prints */
  applied?: boolean;
  /** MessageTextFromValue for a length in mm (the zone position of "has no pads connected"); "%.4f mm" by default */
  formatLength?(mm: number): string;
  newUuid?(): string;
}
export type Severity = "action" | "warning" | "error" | "info";
export interface ReportLine { severity: Severity; text: string }
export interface UpdatePlan {
  report: ReportLine[];
  /** footprints, tracks, vias and zones to replace: item id -> new node */
  modified: Map<string, SNode>;
  removed: string[];
  /** new footprint nodes (at estimateFootprintInsertionPosition) and new groups */
  added: SNode[];
  /** the uuids of the footprints among `added` */
  addedIds: string[];
  warnings: number; errors: number;
}

const MANDATORY = new Set(["Reference", "Value", "Datasheet", "Description"]);
const PAD_AFTER_NET = ["pinfunction", "pintype", "die_length", "die_delay", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "thermal_bridge_width", "thermal_bridge_angle", "thermal_gap", "custom", "primitives", "tenting", "teardrops", "padstack", "uuid", "tstamp"];
const clone = (n: SNode): SNode => (typeof KiCadCanvas !== "undefined" && KiCadCanvas.cloneNode ? (KiCadCanvas.cloneNode as (x: SNode) => SNode)(n) : JSON.parse(JSON.stringify(n)) as SNode);

/** (net "name") or the legacy (net code "name") of a pad / track. */
function netNameOf(doc: KDoc, node: SNode): string {
  const n = kid(node, "net") as SNode | null; if (!n) return "";
  if (typeof n[1] === "number") return n.length > 2 ? str(n[2]) : (doc.nets.get(n[1]) || "");
  return str(n[1]);
}
function usesNetCodes(doc: KDoc): boolean {
  // formatNetRef: codes in a board kept at a version before 20251028, names from then on.  The items decide for a doc
  // without a version, and for an older one whose items are already written by name (as netStyle does).
  const v = Number((doc as KDoc & { version?: number }).version) || 0;
  if (v >= 20251028) return false;
  for (const it of doc.items.values()) {
    const probe = it.kind === "footprint" ? (kid(it.node, "pad") as SNode | null) : (it.kind === "segment" || it.kind === "via" || it.kind === "arc") ? it.node : null;
    const n = probe && (kid(probe, "net") as SNode | null); if (!n) continue;
    return typeof n[1] === "number";
  }
  return v > 0;
}
function fpRef(node: SNode): string {
  const p = prop(node, "Reference"); if (p) return str(p[2]);
  for (const t of kids(node, "fp_text") as SNode[]) if (str(t[1]) === "reference") return str(t[2]);
  return "";
}
function fpValue(node: SNode): string {
  const p = prop(node, "Value"); if (p) return str(p[2]);
  for (const t of kids(node, "fp_text") as SNode[]) if (str(t[1]) === "value") return str(t[2]);
  return "";
}
function setFpText(node: SNode, name: "Reference" | "Value", text: string): void {
  const p = prop(node, name); if (p) { p[2] = text; return; }
  for (const t of kids(node, "fp_text") as SNode[]) if (str(t[1]) === name.toLowerCase()) t[2] = text;
}
const codeCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** BOARD_NETLIST_UPDATER::fpidsEquivalent: a schematic id with no library nickname compares the item names. */
function fpidsEquivalent(board: string, sch: string): boolean {
  const i = sch.indexOf(":");
  if (i < 0 || i === 0) return board.slice(board.indexOf(":") + 1) === sch.slice(i + 1);
  return board === sch;
}
function attrFlags(node: SNode): Set<string> { const a = kid(node, "attr") as SNode | null; return new Set(a ? a.slice(1).map(str) : []); }
const ATTR_ORDER = ["smd", "through_hole", "board_only", "exclude_from_pos_files", "exclude_from_bom", "exclude_from_sim", "allow_missing_courtyard", "dnp", "allow_soldermask_bridges"];
function setAttrFlag(node: SNode, flag: string, on: boolean): void {
  const flags = attrFlags(node); if (on) flags.add(flag); else flags.delete(flag);
  const list = [...ATTR_ORDER.filter((f) => flags.has(f)), ...Array.from(flags).filter((f) => !ATTR_ORDER.includes(f))];
  if (!list.length) { delKid(node, "attr"); return; }
  setKid(node, "attr", list, ["duplicate_pad_numbers_are_jumpers", "net_tie_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text_box", "dimension", "pad", "zone", "group", "embedded_fonts", "model"], true);
}
const isLocked = (node: SNode): boolean => node.includes("locked") || yes(node, "locked", false);
const fpSide = (node: SNode): string => kidStr(node, "layer") || "F.Cu";
const fpRot = (node: SNode): number => { const a = atOf(node) as number[]; return a[2] || 0; };

/** A hidden field for a footprint, the way BOARD_NETLIST_UPDATER creates one (on the Fab layer, board text defaults). */
function newField(fp: SNode, name: string, value: string, o: UpdateOptions): SNode {
  const size = o.fieldSize || 1, sizeV = o.fieldSizeV || size, thick = o.fieldThickness || 0.15, rot = fpRot(fp), back = fpSide(fp) === "B.Cu";
  const uuid = o.newUuid ? o.newUuid() : "";
  return parse(`(property ${quote(name)} ${quote(value)} (at 0 0${rot ? " " + rot : ""})${o.fieldUpright ? "" : " (unlocked yes)"} (layer "${back ? "B.Fab" : "F.Fab"}") (hide yes)${uuid ? ` (uuid "${uuid}")` : ""} (effects (font (size ${sizeV} ${size}) (thickness ${thick})${o.fieldItalic ? " (italic yes)" : ""})${back ? " (justify mirror)" : ""}))`) as SNode;
}
function insertField(fp: SNode, field: SNode): void {
  let at = -1;
  for (let j = 1; j < fp.length; j++) { const c = fp[j]; if (isList(c) && c[0] === "property" && !str(c[1]).startsWith("ki_")) at = j; }
  if (at < 0) at = Math.max(idxOf(fp, "tags"), idxOf(fp, "descr"), idxOf(fp, "at"), 1);
  fp.splice(at + 1, 0, field);
}

/** LIB_ID::Parse( aId, true ): the nickname before the first ':' and the item name with the forbidden characters fixed. */
function parseFpid(s: string): string {
  const i = s.indexOf(":"), nick = i >= 0 ? s.slice(0, i) : "", item = (i >= 0 ? s.slice(i + 1) : s).replace(/[<>"\\:\t\n\r]/g, "_");
  return nick ? nick + ":" + item : item;
}
/** JUMPER_GROUP_SET as the board and the netlist compare it: each group's non-blank names as a sorted set, empty groups dropped. */
function jumperGroups(groups: string[][]): string[][] {
  const out: string[][] = [];
  for (const g of groups) { const names = Array.from(new Set(g.filter((n) => n !== ""))).sort(codeCmp); if (names.length) out.push(names); }
  return out;
}
function fpJumperGroups(fp: SNode): string[][] { const j = kid(fp, "jumper_pad_groups") as SNode | null; return j ? jumperGroups(j.slice(1).filter(isList).map((g) => (g as SNode).map(str))) : []; }
function fpUnits(fp: SNode): { name: string; pins: string[] }[] {
  const u = kid(fp, "units") as SNode | null; if (!u) return [];
  return (kids(u, "unit") as SNode[]).map((x) => ({ name: kidStr(x, "name"), pins: ((kid(x, "pins") as SNode | null) || ["pins"]).slice(1).map(str) }));
}
const FP_AFTER_PATH = ["sheetname", "sheetfile", "units", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "clearance", "zone_connect", "attr", "stackup", "private_layers", "net_tie_pad_groups", "duplicate_pad_numbers_are_jumpers", "jumper_pad_groups", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text_box", "pad", "zone", "group", "embedded_fonts", "model"];
const after = (key: string): string[] => FP_AFTER_PATH.slice(FP_AFTER_PATH.indexOf(key) + 1);

/**
 * What "Update PCB" would do to `doc` for `netlist`: the report (in the dry-run wording of the desktop's dialog, or with
 * `o.applied` the wording and the extra lines of the real run) and the staged nodes.  Nothing is modified; the caller
 * commits `modified` / `removed` / `added`.  BOARD_NETLIST_UPDATER::UpdateNetlist, step by step.
 */
export function planUpdate(doc: KDoc, netlist: Netlist, o: UpdateOptions = {}): UpdatePlan {
  const applied = !!o.applied, T = (dry: string, done: string): string => (applied ? done : dry);
  const report: ReportLine[] = [];
  let warnings = 0, errors = 0;
  const say = (severity: Severity, text: string): void => { report.push({ severity, text }); if (severity === "warning") warnings++; if (severity === "error") errors++; };
  const modified = new Map<string, SNode>(), removed: string[] = [], added: SNode[] = [];
  const byCode = usesNetCodes(doc);
  const codeOf = new Map<string, number>(); let maxCode = 0;
  for (const [code, name] of doc.nets) { codeOf.set(name, code); maxCode = Math.max(maxCode, code); }
  const boardNets = new Set<string>();
  const fps: KItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { fps.push(it); for (const p of kids(it.node, "pad") as SNode[]) { const n = netNameOf(doc, p); if (n) boardNets.add(n); } }
    else if (it.kind === "segment" || it.kind === "arc" || it.kind === "via" || it.kind === "zone") { const n = netNameOf(doc, it.node); if (n) boardNets.add(n); }
  }
  for (const name of doc.nets.values()) if (name) boardNets.add(name);
  const addedNets = new Set<string>();
  const oldToNew = new Map<string, string>();
  const netValues = (name: string): (string | number)[] => {
    if (!byCode) return [name];
    let code = codeOf.get(name); if (code === undefined) { code = ++maxCode; codeOf.set(name, code); }
    return [code, name];
  };
  // DIALOG_UPDATE_PCB: m_netlist->SortByReference() (StrNumCmp, ignoring case)
  const comps = netlist.components.slice().sort((a, b) => strNumCmp(a.ref.toUpperCase(), b.ref.toUpperCase()));
  // m_schematicNetNames: the no-connect pad names avoid them
  const schematicNetNames = new Set<string>(); for (const c of comps) for (const p of c.pins.values()) schematicNetNames.add(p.net);
  // cacheCopperZoneConnections: the pads each copper zone reaches before the update
  const zonePads = zoneConnectedPads(doc);
  /** the footprint node as this update has it so far (modified or the board's) */
  const current = (fp: KItem): SNode => modified.get(fp.id) || fp.node;

  const padsOf = (fp: SNode): SNode[] => kids(fp, "pad") as SNode[];
  /** updateComponentPadConnections; `shown` is the reference the footprint carries at this point of the run */
  const applyNets = (shown: string, fp: SNode, c: NetComponent, quiet: boolean): boolean => {
    const out = (sev: Severity, text: string): void => { if (!quiet) say(sev, text); };
    let changed = false;
    const padNetnames = new Set<string>();
    const pads = padsOf(fp).slice().sort((a, b) => codeCmp(kidStr(a, "uuid") || kidStr(a, "tstamp"), kidStr(b, "uuid") || kidStr(b, "tstamp")));
    for (const pad of pads) {
      const number = str(pad[1]), pin = number ? c.pins.get(number) : undefined, cur = netNameOf(doc, pad);
      const layers = kid(pad, "layers") as SNode | null, onCopper = !layers || layers.slice(1).some((l) => /\.Cu$/.test(str(l)));
      if (kidStr(pad, "pinfunction") !== (pin ? pin.name : "")) { if (pin && pin.name) setKid(pad, "pinfunction", [pin.name], PAD_AFTER_NET.slice(1)); else delKid(pad, "pinfunction"); changed = true; }
      if (kidStr(pad, "pintype") !== (pin ? pin.type : "")) { if (pin && pin.type) setKid(pad, "pintype", [pin.type], PAD_AFTER_NET.slice(2)); else delKid(pad, "pintype"); changed = true; }
      if (!pin || !onCopper) {
        if (cur) { out("action", T(`Disconnect ${shown} pin ${number}.`, `Disconnected ${shown} pin ${number}.`)); delKid(pad, "net"); changed = true; }
        else if (onCopper && number) out("warning", `No net found for component ${shown} pad ${number} (no pin ${number} in symbol).`);
        if (kidStr(pad, "pinfunction")) { delKid(pad, "pinfunction"); changed = true; }
        continue;
      }
      let netName = pin.net;
      // IsNoConnectPad: a pad whose pin type names no_connect gets a name of its own within the footprint
      if (pin.type.includes("no_connect")) {
        for (let jj = 1; padNetnames.has(netName) || (netName !== pin.net && schematicNetNames.has(netName)); jj++) netName = pin.net + "_" + jj;
        padNetnames.add(netName);
      }
      if (cur !== netName) {
        if (!boardNets.has(netName) && !addedNets.has(netName)) { addedNets.add(netName); out("action", `Add net ${unescapeNetName(netName)}.`); }
        if (cur) { oldToNew.set(cur, netName); out("action", T(`Reconnect ${shown} pin ${number} from ${unescapeNetName(cur)} to ${unescapeNetName(netName)}.`, `Reconnected ${shown} pin ${number} from ${unescapeNetName(cur)} to ${unescapeNetName(netName)}.`)); }
        else out("action", T(`Connect ${shown} pin ${number} to ${unescapeNetName(netName)}.`, `Connected ${shown} pin ${number} to ${unescapeNetName(netName)}.`));
        setKid(pad, "net", netValues(netName), PAD_AFTER_NET); changed = true;
      }
    }
    return changed;
  };
  // BOARD_NETLIST_UPDATER::applyComponentVariants for the component's footprints.  `origs` are the footprints as they
  // were before this update: their FOOTPRINT_VARIANTs hold their own flags.
  const applyVariants = (c: NetComponent, list: { node: SNode; orig: SNode; shown: string; forceBase?: boolean }[], baseFpid: string, quiet: boolean): boolean[] => {
    const res = list.map(() => false);
    if (!baseFpid) return res;
    const out = (text: string): void => { if (!quiet) say("action", text); };
    const multi = list.length > 1;
    const infos = (c.variants || []).map((v) => { const f = v.fields.get("Footprint"); return { v, fpid: f ? parseFpid(f) : baseFpid }; });
    list.forEach((entry, idx) => {
      const fp = entry.node, orig = entry.orig, ref = entry.shown, fpid = str(fp[1]);
      const tail = multi ? ` (footprint ${fpid})` : "";
      let changed = false;
      const isBase = !!entry.forceBase || fpidsEquivalent(fpid, baseFpid);
      const baseDnp = attrFlags(fp).has("dnp");
      let effDnp = baseDnp;
      if (!isBase && !effDnp) { out(T(`Add ${ref} 'Do not place' fabrication attribute.`, `Added ${ref} 'Do not place' fabrication attribute.`)); setAttrFlag(fp, "dnp", true); effDnp = true; changed = true; }
      const excess = new Map<string, string>();      // lower-case name -> the footprint's own spelling
      for (const v of kids(orig, "variant") as SNode[]) { const n = str(((kid(v, "name") as SNode | null) || [])[1]); if (n) excess.set(n.toLowerCase(), n); }
      const writes: { name: string; flags: FpFlags; fields: Map<string, string> }[] = [];
      for (const { v, fpid: vFpid } of infos) {
        const associated = fpidsEquivalent(fpid, vFpid);
        if (!associated && !multi) continue;
        excess.delete(v.name.toLowerCase());
        const cur = footprintVariant(orig, v.name), flagsNow = (): FpFlags => { const f = attrFlags(fp); return { dnp: f.has("dnp"), exclude_from_bom: f.has("exclude_from_bom"), exclude_from_sim: f.has("exclude_from_sim"), exclude_from_pos_files: f.has("exclude_from_pos_files") }; };
        let st: { name: string; flags: FpFlags; fields: Map<string, string> } | null = cur ? { name: cur.name, flags: { ...cur.flags }, fields: new Map(cur.fields) } : null;
        let touched = false;
        const add = (): { name: string; flags: FpFlags; fields: Map<string, string> } => { if (!st) st = { name: v.name, flags: flagsNow(), fields: new Map() }; touched = true; return st; };
        const attr = (key: keyof FpFlags, label: string, target: boolean, currentValue: boolean): void => {
          if (currentValue === target) return;
          out(target ? T(`Add ${ref} '${label}' attribute to variant ${v.name}${tail}.`, `Added ${ref} '${label}' attribute to variant ${v.name}${tail}.`) : T(`Remove ${ref} '${label}' attribute from variant ${v.name}${tail}.`, `Removed ${ref} '${label}' attribute from variant ${v.name}${tail}.`));
          add().flags[key] = target; changed = true;
        };
        const now = flagsNow();
        attr("dnp", "Do not place", associated ? (v.dnp ?? baseDnp) : true, cur ? cur.flags.dnp : effDnp);
        attr("exclude_from_bom", "exclude from BOM", v.excludedFromBOM ?? now.exclude_from_bom, cur ? cur.flags.exclude_from_bom : now.exclude_from_bom);
        attr("exclude_from_sim", "exclude from simulation", v.excludedFromSim ?? now.exclude_from_sim, cur ? cur.flags.exclude_from_sim : now.exclude_from_sim);
        attr("exclude_from_pos_files", "exclude from position files", v.excludedFromPosFiles ?? now.exclude_from_pos_files, cur ? cur.flags.exclude_from_pos_files : now.exclude_from_pos_files);
        if (o.updateFields !== false) {
          const fpFields = new Map<string, string>();
          for (const p of kids(fp, "property") as SNode[]) fpFields.set(str(p[1]), str(p[2]));
          for (const k of [...v.fields.keys()].sort(codeCmp)) {
            if (k.toLowerCase() === "footprint") continue;
            const val = v.fields.get(k) as string;
            const s2 = st as { fields: Map<string, string> } | null;
            const currentValue = s2 && s2.fields.has(k) ? s2.fields.get(k) as string : (fpFields.get(k) ?? "");
            fpFields.delete(k);
            if (currentValue !== val) { out(T(`Change ${ref} field '${k}' to '${val}' on variant ${v.name}${tail}.`, `Changed ${ref} field '${k}' to '${val}' on variant ${v.name}${tail}.`)); add().fields.set(k, val); changed = true; }
          }
          for (const k of [...fpFields.keys()].sort(codeCmp)) {
            if (k.toLowerCase() === "footprint") continue;
            const s2 = st as { fields: Map<string, string> } | null;
            if (cur && s2 && s2.fields.has(k)) { out(T(`Remove ${ref} field '${k}' override on variant ${v.name}${tail}.`, `Removed ${ref} field '${k}' override on variant ${v.name}${tail}.`)); s2.fields.delete(k); touched = true; changed = true; }
          }
        }
        if (touched && st) writes.push(st);
      }
      for (const w of writes) {
        const old = footprintVariantNode(fp, w.name); if (old) fp.splice(fp.indexOf(old), 1);
        const fields: Record<string, string> = {}; for (const [k, v] of w.fields) fields[k] = v;
        const outNode = setFootprintVariant(fp, w.name, { flags: w.flags, fields });
        fp.length = 0; fp.push(...outNode);
      }
      for (const lowerName of [...excess.keys()].sort((a, b) => codeCmp(excess.get(a) as string, excess.get(b) as string))) {
        const name = excess.get(lowerName) as string;
        out(T(`Remove variant ${ref}:${name} no longer associated with footprint ${fpid}.`, `Removed variant ${ref}:${name} no longer associated with footprint ${fpid}.`));
        const node = footprintVariantNode(fp, name); if (node) fp.splice(fp.indexOf(node), 1);
        changed = true;
      }
      res[idx] = changed;
    });
    return res;
  };
  /**
   * updateFootprintParameters.  `quiet`: a footprint the dry run adds (KiCad has no footprint to report on yet).
   * Returns the changed flag and the reference the footprint carries afterwards (the old one in the dry run).
   */
  const applyComponent = (fp: SNode, c: NetComponent, quiet: boolean): { changed: boolean; shown: string } => {
    const out = (text: string): void => { if (!quiet) say("action", text); };
    let changed = false;
    const fpid = str(fp[1]);
    // firstAssociatedVariant: a footprint that is not the base one takes the values of the first variant naming it
    let variant: NetVariant | null = null;
    if (!fpidsEquivalent(fpid, c.footprint)) for (const v of c.variants || []) if (v.fields.has("Footprint") && fpid === v.fields.get("Footprint")) { variant = v; break; }
    const oldRef = fpRef(fp);
    let shown = oldRef;
    if (oldRef !== c.ref) { out(T(`Change ${oldRef} reference designator to ${c.ref}.`, `Changed ${oldRef} reference designator to ${c.ref}.`)); setFpText(fp, "Reference", c.ref); changed = true; if (applied || quiet) shown = c.ref; }
    if (quiet) shown = c.ref;
    const value = variant && variant.fields.has("Value") ? variant.fields.get("Value") as string : c.value;
    const oldVal = fpValue(fp);
    if (oldVal !== value) { out(T(`Change ${shown} value from ${oldVal} to ${value}.`, `Changed ${shown} value from ${oldVal} to ${value}.`)); setFpText(fp, "Value", value); changed = true; }
    const path = kidStr(fp, "path"), newPath = c.paths[0] || "";
    if (path !== newPath) {
      out(T(`Update ${shown} symbol association from ${path} to ${newPath}.`, `Updated ${shown} symbol association from ${path} to ${newPath}.`));
      setKid(fp, "path", [newPath], FP_AFTER_PATH); changed = true;
    }
    // the fields: the footprint's (but Reference, Value and Component Class) against the symbol's (but Reference, Value,
    // Footprint and Component Class), the variant's overrides laid over them
    const fpFields = new Map<string, string>();
    for (const p of kids(fp, "property") as SNode[]) { const n = str(p[1]); if (n === "Reference" || n === "Value" || n === "Component Class" || n === "ki_fp_filters") continue; fpFields.set(n, str(p[2])); }
    const compFields = new Map<string, string>(Object.entries(c.fields));
    if (variant) for (const [k, v] of variant.fields) compFields.set(k, v);
    for (const k of ["Reference", "Value", "Footprint", "Component Class"]) compFields.delete(k);
    let same = true, removeOnly = true;
    for (const [name, v] of compFields) if (!fpFields.has(name) || fpFields.get(name) !== v) { same = false; removeOnly = false; break; }
    for (const name of fpFields.keys()) if (!compFields.has(name)) { same = false; break; }
    if (!same) {
      if (o.updateFields !== false && (!removeOnly || o.removeExtraFields)) {
        out(T(`Update ${shown} fields.`, `Updated ${shown} fields.`)); changed = true;
        for (const [name, v] of compFields) {
          const p = prop(fp, name);
          if (p) p[2] = v;
          else if (prop(fp, "Reference")) insertField(fp, newField(fp, name, v, o));   // legacy fp_text footprints carry no fields
        }
      }
      if (o.removeExtraFields) {
        let warned = false;
        for (let j = 1; j < fp.length; j++) {
          const p = fp[j]; if (!isList(p) || p[0] !== "property") continue;
          const name = str(p[1]); if (MANDATORY.has(name) || name === "ki_fp_filters" || compFields.has(name)) continue;
          if (!warned) { warned = true; out(T(`Remove ${shown} footprint fields not in symbol.`, `Removed ${shown} footprint fields not in symbol.`)); }
          fp.splice(j, 1); j--; changed = true;
        }
      }
    }
    if (kidStr(fp, "sheetname") !== c.sheetName) { out(T(`Update ${shown} sheetname to '${c.sheetName}'.`, `Updated ${shown} sheetname to '${c.sheetName}'.`)); if (c.sheetName) setKid(fp, "sheetname", [c.sheetName], after("sheetname")); else delKid(fp, "sheetname"); changed = true; }
    if (kidStr(fp, "sheetfile") !== c.sheetFile) { out(T(`Update ${shown} sheetfile to '${c.sheetFile}'.`, `Updated ${shown} sheetfile to '${c.sheetFile}'.`)); if (c.sheetFile) setKid(fp, "sheetfile", [c.sheetFile], after("sheetfile")); else delKid(fp, "sheetfile"); changed = true; }
    const filters = c.fpFilters || "", fl = prop(fp, "ki_fp_filters"), curFilters = fl ? str(fl[2]) : "";
    if (curFilters !== filters) {
      out(T(`Update ${shown} footprint filters to '${filters}'.`, `Updated ${shown} footprint filters to '${filters}'.`));
      if (fl) { if (filters) fl[2] = filters; else fp.splice(fp.indexOf(fl), 1); }
      else { const pi = idxOf(fp, "path"); fp.splice(pi > 0 ? pi : fp.length, 0, qnode("property", ["ki_fp_filters", filters])); }
      changed = true;
    }
    // the fabrication attributes, only with Update Fields (the variant's flag when it sets one)
    if (o.updateFields !== false) {
      const attrSync = (flag: string, want: boolean, label: string): void => {
        if (attrFlags(fp).has(flag) === want) return;
        out(want ? T(`Add ${shown} ${label}.`, `Added ${shown} ${label}.`) : T(`Remove ${shown} ${label}.`, `Removed ${shown} ${label}.`));
        setAttrFlag(fp, flag, want); changed = true;
      };
      attrSync("exclude_from_bom", variant && variant.excludedFromBOM !== undefined ? variant.excludedFromBOM : c.excludeFromBom, "'exclude from BOM' fabrication attribute");
      attrSync("exclude_from_sim", variant && variant.excludedFromSim !== undefined ? variant.excludedFromSim : !!c.excludeFromSim, "'exclude from simulation' attribute");
      attrSync("dnp", variant && variant.dnp !== undefined ? variant.dnp : c.dnp, "'Do not place' fabrication attribute");
      attrSync("exclude_from_pos_files", variant && variant.excludedFromPosFiles !== undefined ? variant.excludedFromPosFiles : !!c.excludeFromPosFiles, "'exclude from position files' fabrication attribute");
      const jumpers = !!c.dupPinsAreJumpers, curJ = yes(fp, "duplicate_pad_numbers_are_jumpers", false);
      if (jumpers !== curJ) {
        out(jumpers ? T(`Add ${shown} 'duplicate pad numbers are jumpers' attribute.`, `Added ${shown} 'duplicate pad numbers are jumpers' attribute.`) : T(`Remove ${shown} 'duplicate pad numbers are jumpers' attribute.`, `Removed ${shown} 'duplicate pad numbers are jumpers' attribute.`));
        setKid(fp, "duplicate_pad_numbers_are_jumpers", [jumpers ? "yes" : "no"], after("duplicate_pad_numbers_are_jumpers"), true); changed = true;
      }
      const want = jumperGroups(c.jumperPinGroups || []);
      if (JSON.stringify(want) !== JSON.stringify(fpJumperGroups(fp))) {
        out(T(`Update ${shown} jumper pad groups`, `Updated ${shown} jumper pad groups`));
        delKid(fp, "jumper_pad_groups");
        if (want.length) setKid(fp, "jumper_pad_groups", [], after("jumper_pad_groups"), true).push(...want.map((g) => g.map((n) => qnode("x", [n])[1]) as SNode));
        changed = true;
      }
    }
    return { changed, shown };
  };
  /** updateComponentUnits: the footprint's (units …) from the netlist's unit info. */
  const applyUnits = (fp: SNode, c: NetComponent, shown: string, quiet: boolean): boolean => {
    const want = c.unitInfo || [], cur = fpUnits(fp);
    if (JSON.stringify(want) === JSON.stringify(cur)) return false;
    if (!quiet) say("action", T(`Update ${shown} unit metadata.`, `Updated ${shown} unit metadata.`));
    delKid(fp, "units");
    if (want.length) setKid(fp, "units", [], after("units"), true).push(...want.map((u) => ["unit", qnode("name", [u.name]), qnode("pins", u.pins)] as SNode));
    return true;
  };

  // ---- BOARD_NETLIST_UPDATER::updateFootprintGroup: each footprint goes to the board group of its symbol's group
  interface BGroup { id: string | null; node: SNode; members: string[]; dirty: boolean }
  const groups = new Map<string, BGroup>();
  if (o.transferGroups) for (const it of doc.items.values()) if (it.kind === "group") { const node = clone(it.node), m = kid(node, "members") as SNode | null; groups.set(kidStr(node, "uuid") || it.id, { id: it.id, node, members: m ? m.slice(1).map(str) : [], dirty: false }); }
  const groupName = (g: BGroup): string => (typeof g.node[1] === "string" ? str(g.node[1]) : "");
  const applyGroup = (fpId: string, c: NetComponent, shown: string): void => {
    if (!o.transferGroups) return;
    const want = c.group ? c.group.uuid : "";
    const cur = Array.from(groups.entries()).find(([, g]) => g.members.includes(fpId));
    if ((cur ? cur[0] : "") === want) return;
    if (cur) { say("action", T(`Remove ${shown} from group '${groupName(cur[1])}'.`, `Removed ${shown} from group '${groupName(cur[1])}'.`)); cur[1].members = cur[1].members.filter((m) => m !== fpId); cur[1].dirty = true; }
    if (c.group) {
      say("action", T(`Add ${shown} to group '${c.group.name}'.`, `Added ${shown} to group '${c.group.name}'.`));
      let g = groups.get(want);
      if (!g) { g = { id: null, node: ["group", c.group.name, ["uuid", want], ["members"]], members: [], dirty: true }; groups.set(want, g); }
      g.members.push(fpId); g.dirty = true;
    }
  };

  // ---- estimateFootprintInsertionPosition: under the board edges (their centre, 10 mm below), the page's centre on an empty board
  const insertAt = ((): [number, number] => {
    if (!doc.items.size) { const pg = (doc as KDoc & { page?: number[] }).page || [297, 210]; return [r4(pg[0] / 2), r4(pg[1] / 2)]; }
    let bb: [number, number, number, number] | null = null;
    const merge = (b: [number, number, number, number] | null): void => { if (b) bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[0] + b[2]), Math.max(bb[3], b[1] + b[3])] : [b[0], b[1], b[0] + b[2], b[1] + b[3]]; };
    for (const it of doc.items.values()) {
      if (it.kind === "footprint") { const geom = (it.geom || []).filter((g) => (g as { layer?: string }).layer === "Edge.Cuts" && (g as { t?: string }).t !== "text"); if (geom.length) merge(boardItemBox({ ...it, geom } as KItem, 1e6)); }
      else if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(it.kind) && kidStr(it.node, "layer") === "Edge.Cuts") merge(boardItemBox(it, 1e6));
    }
    const b = bb as [number, number, number, number] | null;
    if (!b || (b[2] === b[0] && b[3] === b[1])) return [0, 0];
    return [r4(((b[0] + b[2]) / 2) / 1e6), r4((b[3] + 10e6) / 1e6)];
  })();
  /** addNewFootprint: the library footprint (pads on no net) at the insertion position; null after reporting why not */
  const addNew = (c: NetComponent, fpid: string): SNode | null => {
    if (!fpid) { say("error", `Cannot add ${c.ref} (no footprint assigned).`); return null; }
    const lib = o.footprintFor ? o.footprintFor(fpid) : null;
    if (lib === "missing") { say("error", `Cannot add ${c.ref} (footprint '${fpid}' not found).`); return null; }
    if (!lib) { say("error", `Cannot add ${c.ref} (footprint '${fpid}': library not available).`); return null; }
    const node = clone(lib);
    for (const pad of padsOf(node)) delKid(pad, "net");
    const a = atOf(node) as number[];
    setKid(node, "at", a[2] ? [insertAt[0], insertAt[1], a[2]] : [insertAt[0], insertAt[1]], ["descr", "tags", "property"], true);
    say("action", T(`Add ${c.ref} (footprint '${fpid}').`, `Added ${c.ref} (footprint '${fpid}').`));
    return node;
  };
  /** replaceFootprint: the library footprint exchanged in the old one's place (ExchangeFootprint keeps reference, value, fields and pad nets) */
  const replace = (fp: KItem, c: NetComponent): SNode | null => {
    const node = fp.node, curId = str(node[1]), ref = fpRef(node);
    if (!c.footprint) { say("error", `Cannot update ${c.ref} (no footprint assigned).`); return null; }
    const lib = o.footprintFor ? o.footprintFor(c.footprint) : null;
    if (!lib || lib === "missing") { say("error", `Cannot update ${c.ref} (footprint '${c.footprint}' ${lib === "missing" ? "not found" : "not available: no footprint library"}).`); return null; }
    if (isLocked(node) && !o.overrideLocks) { say("warning", T(`Cannot change ${ref} footprint from '${curId}' to '${c.footprint}' (footprint is locked).`, `Could not change ${ref} footprint from '${curId}' to '${c.footprint}' (footprint is locked).`)); return null; }
    say("action", T(`Change ${ref} footprint from '${curId}' to '${c.footprint}'.`, `Changed ${ref} footprint from '${curId}' to '${c.footprint}'.`));
    const fresh = clone(lib), a = atOf(node) as number[];
    const at: (string | number)[] = [a[0], a[1]]; if (a[2]) at.push(a[2]);
    setKid(fresh, "at", at, ["descr", "tags", "property"], true);
    setKid(fresh, "uuid", [fp.id], ["at"]);
    for (const name of ["Reference", "Value"]) { const from = prop(node, name), to = prop(fresh, name); if (from && to) { to.length = 0; to.push(...clone(from)); } }
    for (const k of ["path", "sheetname", "sheetfile"]) { const n = kid(node, k) as SNode | null; if (n) setKid(fresh, k, n.slice(1) as (string | number)[], after(k)); }
    for (const pad of padsOf(fresh)) { const old = padsOf(node).find((q) => str(q[1]) === str(pad[1])); const n = old && (kid(old, "net") as SNode | null); delKid(pad, "net"); if (n) setKid(pad, "net", n.slice(1) as (string | number)[], PAD_AFTER_NET); }
    return fresh;
  };

  // ---- the components
  const usedFootprints = new Set<string>();
  const baseOf = new Map<NetComponent, string>();          // component -> its base footprint's id (testConnectivity)
  const addedIds: string[] = [];
  const nodeOf = new Map<string, SNode>();                  // footprint id -> its working node (existing or added)
  for (const c of comps) {
    if (c.excludeFromBoard) continue;
    const baseFpid = c.footprint ? parseFpid(c.footprint) : "", hasBase = !!baseFpid;
    say("info", `Processing symbol '${c.ref}:${baseFpid}'.`);
    if (hasBase && baseFpid.indexOf(":") < 0) say("warning", `Warning: ${c.ref} footprint '${baseFpid}' is missing a library name. Use the full 'Library:Footprint' format to avoid repeated update notifications.`);
    const matching: KItem[] = [];
    for (const fp of fps) {
      const match = o.relinkByRef ? fpRef(fp.node).toLowerCase() === c.ref.toLowerCase() : c.paths.includes(kidStr(fp.node, "path"));
      if (!match) continue;
      if (attrFlags(fp.node).has("board_only")) say("warning", `Found a footprint matching ${c.ref}, but the footprint's 'Not in schematic' flag indicates there should be no matching symbol.`);
      else matching.push(fp);
    }
    // the footprints the component expects: its own and each variant's (one footprint each)
    const expected: string[] = [];
    const expect = (id: string): void => { if (id && !expected.includes(id)) expected.push(id); };
    expect(baseFpid);
    for (const v of c.variants || []) { const f = v.fields.get("Footprint"); if (f) expect(parseFpid(f)); }
    const isExpected = (id: string): boolean => !!id && (expected.includes(id) || expected.some((e) => fpidsEquivalent(id, e)));
    const take = (id: string): KItem | null => matching.find((fp) => !usedFootprints.has(fp.id) && fpidsEquivalent(str(fp.node[1]), id)) || null;
    /** `forceBase`: the footprint stands as the base one because the web had no library to replace it from */
    interface Slot { id: string; node: SNode; orig: SNode; fresh: boolean; quiet: boolean; item: KItem | null; forceBase?: boolean }
    const slots: Slot[] = [];
    let base: Slot | null = null;
    const slotOf = (fp: KItem, node?: SNode): Slot => ({ id: fp.id, node: node || clone(current(fp)), orig: clone(fp.node), fresh: false, quiet: false, item: fp });
    if (hasBase) { const t = take(baseFpid); if (t) base = slotOf(t); }
    else if (matching.length) base = slotOf(matching[0]);
    if (!base && o.replaceFootprints !== false && matching.length) {
      const cand = matching.find((fp) => !usedFootprints.has(fp.id) && !isExpected(str(fp.node[1])));
      if (cand) {
        // the dry run goes on with the footprint as it is, the real run with the exchanged one
        const r = replace(cand, c); base = slotOf(cand, applied && r ? r : undefined);
        if (!r && !(o.footprintFor && o.footprintFor(c.footprint))) base.forceBase = true;
      }
    }
    if (!base && o.replaceFootprints === false) {
      const cand = matching.find((fp) => !usedFootprints.has(fp.id) && !isExpected(str(fp.node[1])));
      if (cand) base = slotOf(cand);
    }
    const newSlot = (fpid: string): Slot | null => {
      const node = addNew(c, fpid); if (!node) return null;
      const id = kidStr(node, "uuid") || (o.newUuid ? o.newUuid() : "");
      // the dry run has no footprint to update: nothing more is reported for it
      return { id, node, orig: clone(node), fresh: true, quiet: !applied, item: null };
    };
    if (!base && (hasBase || !expected.length)) base = newSlot(baseFpid);
    if (base) { slots.push(base); usedFootprints.add(base.id); baseOf.set(c, base.id); }
    for (const id of expected) {
      if (fpidsEquivalent(id, baseFpid) || fpidsEquivalent(baseFpid, id)) continue;
      const t = take(id);
      const s = t ? slotOf(t) : newSlot(id);
      if (s) { slots.push(s); usedFootprints.add(s.id); }
    }
    const shownOf = new Map<Slot, string>();
    for (const s of slots) {
      const r = applyComponent(s.node, c, s.quiet);
      shownOf.set(s, r.shown);
      applyGroup(s.id, c, r.shown);
      applyNets(r.shown, s.node, c, s.quiet);
      applyUnits(s.node, c, r.shown, s.quiet);
    }
    // the dry run has no footprint yet for the ones it adds: applyComponentVariants sees the others only
    const loud = slots.filter((s) => !s.quiet), still = slots.filter((s) => s.quiet);
    const entry = (s: Slot): { node: SNode; orig: SNode; shown: string; forceBase?: boolean } => ({ node: s.node, orig: s.orig, shown: shownOf.get(s) as string, forceBase: s.forceBase });
    if (loud.length) applyVariants(c, loud.map(entry), baseFpid, false);
    if (still.length) applyVariants(c, still.map(entry), baseFpid, true);
    for (const s of slots) {
      nodeOf.set(s.id, s.node);
      if (s.fresh) { added.push(s.node); addedIds.push(s.id); }
      else if (s.item && JSON.stringify(s.node) !== JSON.stringify(s.item.node)) modified.set(s.id, s.node);
    }
  }

  // ---- updateCopperZoneNets: vias and copper zones on a net the schematic no longer has
  const netlistNames = schematicNetNames;
  const padNetNow = (pad: { fp: string; uuid: string; net: string }): string => {
    const node = nodeOf.get(pad.fp); if (!node) return pad.net;
    const p = padsOf(node).find((q) => (kidStr(q, "uuid") || kidStr(q, "tstamp")) === pad.uuid);
    return p ? netNameOf(doc, p) : pad.net;
  };
  const setItemNet = (it: KItem, to: string): SNode => {
    const node = clone(it.node);
    if (it.kind === "zone") {
      if (byCode) { const v = netValues(to); setKid(node, "net", [v[0]], ["net_name", "layer", "layers"]); setKid(node, "net_name", [to], ["layer", "layers"]); }
      else { setKid(node, "net", [to], ["net_name", "layer", "layers"]); if (kid(node, "net_name")) setKid(node, "net_name", [to], ["layer", "layers"]); }
    } else setKid(node, "net", byCode ? [netValues(to)[0]] : [to], ["uuid", "tstamp"]);
    return node;
  };
  for (const it of doc.items.values()) {
    if (it.kind !== "via") continue;
    const cur = netNameOf(doc, it.node); if (netlistNames.has(cur)) continue;
    const to = oldToNew.get(cur) || "";
    if (to) { say("action", T(`Reconnect via from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`, `Reconnected via from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`)); modified.set(it.id, setItemNet(it, to)); }
    else say("warning", `Via connected to unknown net (${unescapeNetName(cur)}).`);
  }
  const inNetlist = (n: string): boolean => { if (netlistNames.has(n)) return true; for (const x of netlistNames) if (n.startsWith(x)) return true; return false; };
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" || !zoneOnCopper(it.node) || kid(it.node, "keepout") || kid(it.node, "rule_area")) continue;
    const cur = netNameOf(doc, it.node); if (inNetlist(cur)) continue;
    let to = "";
    for (const pad of zonePads.get(it.id) || []) { const now = padNetNow(pad); if (now !== cur) { to = now; break; } }
    if (!to && oldToNew.has(cur)) to = oldToNew.get(cur) as string;
    const zn = kidStr(it.node, "name");
    if (to) {
      say("action", zn ? T(`Reconnect copper zone '${zn}' from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`, `Reconnected copper zone '${zn}' from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`)
        : T(`Reconnect copper zone from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`, `Reconnected copper zone from ${unescapeNetName(cur)} to ${unescapeNetName(to)}.`));
      modified.set(it.id, setItemNet(it, to));
    } else if (zn) say("warning", `Copper zone '${zn}' has no pads connected.`);
    else {
      const pts = ptsOf(kid(it.node, "polygon") as SNode || it.node) as Pt[], p0 = pts.length ? pts[0] : [0, 0];
      const fmt = o.formatLength || ((v: number) => v.toFixed(4) + " mm");
      say("warning", `Copper zone on ${zoneLayerDescription(doc, it.node)} at (${fmt(p0[0])}, ${fmt(p0[1])}) has no pads connected to net "${cur}".`);
    }
  }

  // ---- group nesting and the staged group nodes
  for (const g of groups.values()) {
    if (!g.dirty) continue;
    if (g.id && g.members.length < 2) { removed.push(g.id); continue; }   // a group of fewer than two items goes
    if (!g.members.length) continue;
    const i = g.node.findIndex((x, k) => k > 0 && Array.isArray(x) && x[0] === "members");
    const m: SNode = ["members", ...g.members]; if (i > 0) g.node[i] = m; else g.node.push(m);
    if (g.id) modified.set(g.id, g.node); else added.push(g.node);
  }

  // ---- footprints with no symbol
  const byRefComp = new Map<string, NetComponent>(); for (const c of netlist.components) if (!byRefComp.has(c.ref)) byRefComp.set(c.ref, c);
  for (const fp of fps) {
    let matched = false, doDelete = !!o.deleteUnused, stale = false;
    if (usedFootprints.has(fp.id)) matched = true;
    else {
      const path = kidStr(fp.node, "path");
      const c = o.relinkByRef ? byRefComp.get(fpRef(fp.node)) : (path ? netlist.components.find((x) => x.paths.includes(path)) : undefined);
      if (c && !c.excludeFromBoard) { if (o.replaceFootprints !== false && c.variants && c.variants.length) { matched = false; stale = true; } else matched = true; }
    }
    if (stale) doDelete = true;
    if (attrFlags(fp.node).has("board_only")) doDelete = false;
    const ref = fpRef(fp.node);
    if (doDelete && !matched && isLocked(fp.node) && !o.overrideLocks) { say("warning", T(`Cannot remove unused footprint ${ref} (footprint is locked).`, `Could not remove unused footprint ${ref} (footprint is locked).`)); doDelete = false; }
    if (doDelete && !matched) { say("action", T(`Remove unused footprint ${ref}.`, `Removed unused footprint ${ref}.`)); removed.push(fp.id); }
    else if (!matched && kidStr(fp.node, "path")) {
      // the footprint stays with its pads on their nets; only its link to a symbol goes
      const node = clone(current(fp)); delKid(node, "path"); modified.set(fp.id, node); nodeOf.set(fp.id, node);
    }
  }

  // BOARD_COMMIT::Push: the connectivity propagates the pads' nets along the copper that touches them.  Copper that
  // reaches no pad keeps its net, but a net no pad keeps any more goes with the update: such copper takes the net
  // the net was renamed to (where KiCad would leave it on a removed net)
  {
    const finalFps: SNode[] = [];
    for (const fp of fps) if (!removed.includes(fp.id)) finalFps.push(nodeOf.get(fp.id) || current(fp));
    finalFps.push(...added);
    const stillPadNets = new Set<string>();
    for (const node of finalFps) for (const p of padsOf(node)) { const n = netNameOf(doc, p); if (n) stillPadNets.add(n); }
    const prop = propagateNets(doc, finalFps, (it) => modified.get(it.id) || it.node);
    for (const it of doc.items.values()) {
      if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via" && !/^gr_(line|arc|circle|rect|poly)$/.test(it.kind)) continue;
      const base = modified.get(it.id) || it.node, cur = netNameOf(doc, base);
      let to = prop.nets.get(it.id) || "";
      if (!to && it.kind !== "via" && prop.padless.has(it.id) && cur && !stillPadNets.has(cur)) to = oldToNew.get(cur) || "";
      if (to && to !== cur) modified.set(it.id, setItemNet(Object.assign({}, it, { node: base }), to));
    }
  }

  if (applied) {
    // testConnectivity: every pin of a component has a pad of its number in its footprint
    for (const c of comps) {
      const id = baseOf.get(c); if (!id) continue;
      const node = nodeOf.get(id); if (!node) continue;
      const fpid = str(node[1]), numbers = new Set(padsOf(node).map((p) => str(p[1])));
      for (const number of c.pins.keys()) {
        if (!number) say("error", `Symbol ${c.ref} has pins with no number.  These pins can not be matched to pads in ${fpid}.`);
        else if (!numbers.has(number)) say("error", `${c.ref} pad ${number} not found in ${fpid}.`);
      }
    }
    // the nets no pad of a remaining footprint uses any more
    const current2 = new Set<string>();
    for (const fp of fps) { if (removed.includes(fp.id)) continue; const node = nodeOf.get(fp.id) || current(fp); for (const p of padsOf(node)) { const n = netNameOf(doc, p); if (n) current2.add(n); } }
    for (const node of added) for (const p of padsOf(node)) { const n = netNameOf(doc, p); if (n) current2.add(n); }
    for (const n of Array.from(boardNets).sort(codeCmp)) if (!current2.has(n)) say("action", `Removed unused net ${n}.`);
  }
  for (const w of netlist.warnings) say("warning", w);
  report.push({ severity: "action", text: "" }, { severity: "action", text: "" });
  say("info", `Total warnings: ${warnings}, errors: ${errors}.`);
  return { report, modified, removed, added, addedIds, warnings, errors };
}

// ---------------------------------------------------------------- BOARD_COMMIT's net propagation
/** A copper primitive on its layers: a capsule (a segment of radius r; a circle when a = b) or a polygon. */
type Prim = { a: Pt; b: Pt; r: number } | { pts: Pt[] };
interface CnItem { id: string; net: string; layers: Set<string>; prims: Prim[]; box: [number, number, number, number]; canChange: boolean; pad: boolean; free: boolean }
const segDistSeg = (a: Pt, b: Pt, c: Pt, d: Pt): number => {
  const o = (p: Pt, q: Pt, r: Pt): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(distSeg(a, c, d), distSeg(b, c, d), distSeg(c, a, b), distSeg(d, a, b));
};
const inPolygon = (p: Pt, poly: Pt[]): boolean => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const EPS = 1e-6;
function primsCollide(x: Prim, y: Prim): boolean {
  if ("r" in x && "r" in y) return segDistSeg(x.a, x.b, y.a, y.b) <= x.r + y.r + EPS;
  if ("r" in x || "r" in y) {
    const c = ("r" in x ? x : y) as { a: Pt; b: Pt; r: number }, poly = ("pts" in x ? x : y) as { pts: Pt[] };
    if (inPolygon(c.a, poly.pts) || inPolygon(c.b, poly.pts)) return true;
    return poly.pts.some((v, i) => segDistSeg(c.a, c.b, v, poly.pts[(i + 1) % poly.pts.length]) <= c.r + EPS);
  }
  const p = (x as { pts: Pt[] }).pts, q = (y as { pts: Pt[] }).pts;
  if (p.some((v) => inPolygon(v, q)) || q.some((v) => inPolygon(v, p))) return true;
  return p.some((v, i) => q.some((w, j) => segDistSeg(v, p[(i + 1) % p.length], w, q[(j + 1) % q.length]) <= EPS));
}
/** The points of an arc through start, mid and end (a straight run when they are in line). */
function arcPts(a: Pt, m: Pt, b: Pt): Pt[] {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  if (Math.abs(d) < 1e-12) return [a, b];
  const sq = (p: Pt): number => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const r = Math.hypot(a[0] - cx, a[1] - cy), T = 2 * Math.PI, norm = (t: number): number => ((t % T) + T) % T;
  const t0 = Math.atan2(a[1] - cy, a[0] - cx), tm = norm(Math.atan2(m[1] - cy, m[0] - cx) - t0), t1 = norm(Math.atan2(b[1] - cy, b[0] - cx) - t0);
  const sweep = tm <= t1 ? t1 : t1 - T, n = Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 32)));
  const out: Pt[] = []; for (let i = 0; i <= n; i++) { const t = t0 + (sweep * i) / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}
const chain = (pts: Pt[], r: number, closed: boolean): Prim[] => { const out: Prim[] = []; for (let i = 0; i + 1 < pts.length; i++) out.push({ a: pts[i], b: pts[i + 1], r }); if (closed && pts.length > 2) out.push({ a: pts[pts.length - 1], b: pts[0], r }); return out; };
/** A copper drawing (gr_* / a custom pad's primitive) as primitives, in its own coordinates. */
function shapePrims(n: SNode, map: (p: Pt) => Pt): Prim[] {
  const w = num(((kid(n, "width") || (kid(kid(n, "stroke") as SNode || [], "width"))) as SNode | null || [])[1], 0);
  const fl = kid(n, "fill") as SNode | null, filled = !!fl && (str(fl[1]) === "yes" || str(fl[1]) === "solid" || (isList(fl[1]) && str((fl[1] as SNode)[1]) === "solid"));
  const pt = (k: string): Pt | null => { const c = kid(n, k) as SNode | null; return c ? map([num(c[1]), num(c[2])]) : null; };
  const k = str(n[0]).replace(/^(gr|fp)_/, "");
  if (k === "line") { const a = pt("start"), b = pt("end"); return a && b ? [{ a, b, r: w / 2 }] : []; }
  if (k === "arc") { const a = pt("start"), m = pt("mid"), b = pt("end"); return a && m && b ? chain(arcPts(a, m, b), w / 2, false) : []; }
  if (k === "circle") { const c = pt("center"), e = pt("end"); if (!c || !e) return []; const R = Math.hypot(e[0] - c[0], e[1] - c[1]); if (filled) return [{ a: c, b: c, r: R + w / 2 }]; const ring: Pt[] = []; for (let i = 0; i < 64; i++) ring.push([c[0] + R * Math.cos((i / 64) * 2 * Math.PI), c[1] + R * Math.sin((i / 64) * 2 * Math.PI)]); return chain(ring, w / 2, true); }
  if (k === "rect") { const s0 = kid(n, "start") as SNode | null, e0 = kid(n, "end") as SNode | null; if (!s0 || !e0) return []; const x0 = num(s0[1]), y0 = num(s0[2]), x1 = num(e0[1]), y1 = num(e0[2]); const pts = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as Pt[]).map(map); return filled ? [{ pts }, ...chain(pts, w / 2, true)] : chain(pts, w / 2, true); }
  if (k === "poly") { const pts = (ptsOf(n) as Pt[]).map(map); if (pts.length < 2) return []; return filled && pts.length > 2 ? [{ pts }, ...(w > 0 ? chain(pts, w / 2, true) : [])] : chain(pts, w / 2, true); }
  return [];
}
/** PAD::GetEffectiveShape on a copper layer, in board coordinates. */
function padPrims(pad: SNode, fpAt: number[]): Prim[] {
  const fr = ((fpAt[2] || 0) * Math.PI) / 180, fc = Math.cos(fr), fs = Math.sin(fr);
  const pa = atOf(pad) as number[], px = pa[0] || 0, py = pa[1] || 0;
  const cx = (fpAt[0] || 0) + px * fc + py * fs, cy = (fpAt[1] || 0) - px * fs + py * fc;
  const pr = ((pa[2] || 0) * Math.PI) / 180, c = Math.cos(pr), s = Math.sin(pr);
  const map = (q: Pt): Pt => [cx + q[0] * c + q[1] * s, cy - q[0] * s + q[1] * c];
  const sz = kid(pad, "size") as SNode | null, w = sz ? num(sz[1]) : 0, h = sz ? num(sz[2], w) : w;
  const shapeOf = (sh: string): Prim[] => {
    if (sh === "circle") return [{ a: map([0, 0]), b: map([0, 0]), r: w / 2 }];
    if (sh === "oval") { const l = Math.abs(w - h) / 2; return [w >= h ? { a: map([-l, 0]), b: map([l, 0]), r: h / 2 } : { a: map([0, -l]), b: map([0, l]), r: w / 2 }]; }
    if (sh === "roundrect" && !kid(pad, "chamfer")) {
      const rr = kid(pad, "roundrect_rratio") as SNode | null, r = Math.min(Math.max(0, rr ? num(rr[1], 0.25) : 0.25), 0.5) * Math.min(w, h), hw = w / 2, hh = h / 2;
      const out: Prim[] = [{ pts: ([[-hw, -hh + r], [hw, -hh + r], [hw, hh - r], [-hw, hh - r]] as Pt[]).map(map) }, { pts: ([[-hw + r, -hh], [hw - r, -hh], [hw - r, hh], [-hw + r, hh]] as Pt[]).map(map) }];
      for (const q of [[-hw + r, -hh + r], [hw - r, -hh + r], [hw - r, hh - r], [-hw + r, hh - r]] as Pt[]) out.push({ a: map(q), b: map(q), r });
      return out;
    }
    return [{ pts: padPolygon(pad, sh === "chamfered_rect" || sh === "roundrect" ? "rect" : sh, w, h).map((q) => map([q[0], q[1]])) }];
  };
  const shape = str(pad[3]);
  if (shape !== "custom") return shapeOf(shape);
  // a custom pad: its anchor (options (anchor rect|circle)) and its primitives
  const opt = kid(pad, "options") as SNode | null, anchor = opt ? str(((kid(opt, "anchor") as SNode | null) || [])[1]) : "";
  const out = shapeOf(anchor === "circle" ? "circle" : "rect");
  const prims = kid(pad, "primitives") as SNode | null;
  if (prims) for (const g of prims.slice(1)) if (isList(g)) out.push(...shapePrims(g as SNode, map));
  return out;
}
/**
 * CN_CONNECTIVITY_ALGO::PropagateNets as BOARD_COMMIT::Push runs it: the tracks, arcs, vias, pads and copper drawings
 * (zones left out) joined where their copper touches on a common copper layer (two pads of different nets do not
 * join), each cluster taking the net of its pads (CN_CLUSTER::Add: the origin pad, a cluster whose pads disagree is
 * left alone) or, without pads, of its first item on a net; every track, arc, via (but a free one) and drawing of the
 * cluster on another net moves to it.  `footprints`: the footprint nodes as they will be.  Returns item id -> net
 * name, and the ids of the clusters' items that touch no pad.
 */
export function propagateNets(doc: KDoc, footprints: SNode[], nodeOf: (it: KItem) => SNode): { nets: Map<string, string>; padless: Set<string> } {
  const copper = doc.copper.slice().sort((a, b) => (a === "F.Cu" ? -1 : b === "F.Cu" ? 1 : a === "B.Cu" ? 1 : b === "B.Cu" ? -1 : strNumCmp(a, b)));
  if (!copper.length) copper.push("F.Cu", "B.Cu");
  const expand = (names: string[]): Set<string> => {
    const out = new Set<string>();
    for (const n of names) { if (n === "*.Cu") copper.forEach((c) => out.add(c)); else if (n === "F&B.Cu") { out.add("F.Cu"); out.add("B.Cu"); } else if (/\.Cu$/.test(n)) out.add(n); }
    return out;
  };
  const items: CnItem[] = [];
  const add = (id: string, net: string, layers: Set<string>, prims: Prim[], canChange: boolean, pad = false, free = false): void => {
    if (!layers.size || !prims.length) return;
    let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    const grow = (p: Pt, r: number): void => { box = [Math.min(box[0], p[0] - r), Math.min(box[1], p[1] - r), Math.max(box[2], p[0] + r), Math.max(box[3], p[1] + r)]; };
    for (const pr of prims) if ("r" in pr) { grow(pr.a, pr.r); grow(pr.b, pr.r); } else for (const p of pr.pts) grow(p, 0);
    items.push({ id, net, layers, prims, box, canChange, pad, free });
  };
  // BOARD::Tracks() in file order, then the pads of every footprint, then the copper drawings
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via") continue;
    const n = nodeOf(it), net = netNameOf(doc, n);
    if (it.kind === "via") {
      const at = atOf(n) as number[], sz = kid(n, "size") as SNode | null, ls = kid(n, "layers") as SNode | null;
      const pair = ls ? ls.slice(1).map(str) : ["F.Cu", "B.Cu"], i0 = copper.indexOf(pair[0]), i1 = copper.indexOf(pair[pair.length - 1]);
      const span = i0 >= 0 && i1 >= 0 ? new Set(copper.slice(Math.min(i0, i1), Math.max(i0, i1) + 1)) : expand(pair);
      const free = yes(n, "free", false);
      add(it.id, net, span, [{ a: [at[0] || 0, at[1] || 0], b: [at[0] || 0, at[1] || 0], r: (sz ? num(sz[1]) : 0) / 2 }], !free);
      continue;
    }
    const w = num(((kid(n, "width") as SNode | null) || [])[1], 0), a = kid(n, "start") as SNode | null, b = kid(n, "end") as SNode | null; if (!a || !b) continue;
    const pa: Pt = [num(a[1]), num(a[2])], pb: Pt = [num(b[1]), num(b[2])], m = kid(n, "mid") as SNode | null;
    add(it.id, net, expand([kidStr(n, "layer")]), it.kind === "arc" && m ? chain(arcPts(pa, [num(m[1]), num(m[2])], pb), w / 2, false) : [{ a: pa, b: pb, r: w / 2 }], true);
  }
  for (const fp of footprints) {
    const at = atOf(fp) as number[];
    for (const pad of kids(fp, "pad") as SNode[]) {
      const pl = kid(pad, "layers") as SNode | null, net = netNameOf(doc, pad);
      const free = net.startsWith("unconnected-(") && kidStr(pad, "pintype") === "free";
      add("pad:" + (kidStr(pad, "uuid") || kidStr(pad, "tstamp")), net, expand(pl ? pl.slice(1).map(str) : []), padPrims(pad, at), false, true, free);
    }
  }
  for (const it of doc.items.values()) {
    if (!/^gr_(line|arc|circle|rect|poly)$/.test(it.kind)) continue;
    const n = nodeOf(it); if (!kid(n, "net")) continue;
    add(it.id, netNameOf(doc, n), expand([kidStr(n, "layer")]), shapePrims(n, (p) => p), true);
  }
  // the touching pairs (a grid of cells for the candidates)
  const uf = new UnionFind(); for (let i = 0; i < items.length; i++) uf.add();
  const CELL = 2, cells = new Map<string, number[]>();
  items.forEach((it, i) => { for (let x = Math.floor(it.box[0] / CELL); x <= Math.floor(it.box[2] / CELL); x++) for (let y = Math.floor(it.box[1] / CELL); y <= Math.floor(it.box[3] / CELL); y++) { const k = x + "," + y; const l = cells.get(k); if (l) l.push(i); else cells.set(k, [i]); } });
  const tried = new Set<string>();
  for (const list of cells.values()) for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
    const i = list[p], j = list[q], A = items[i], B = items[j], key = i + "|" + j;
    if (tried.has(key)) continue; tried.add(key);
    if (A.box[0] > B.box[2] + EPS || B.box[0] > A.box[2] + EPS || A.box[1] > B.box[3] + EPS || B.box[1] > A.box[3] + EPS) continue;
    // CN_VISITOR: items of different nets that can neither change are never joined
    if (!A.canChange && !B.canChange && A.net !== B.net) continue;
    if (![...A.layers].some((l) => B.layers.has(l))) continue;
    if (A.prims.some((x) => B.prims.some((y) => primsCollide(x, y)))) uf.union(i, j);
  }
  const clusters = new Map<number, number[]>();
  items.forEach((_, i) => { const r = uf.find(i); const l = clusters.get(r); if (l) l.push(i); else clusters.set(r, [i]); });
  const nets = new Map<string, string>(), padless = new Set<string>();
  for (const members of clusters.values()) {
    members.sort((a, b) => a - b);
    let origin = "", originPad = false, conflicting = false;
    const ranks = new Map<string, number>();
    for (const i of members) {
      const it = items[i]; if (!it.net) continue;
      if (!origin) { origin = it.net; ranks.set(origin, 0); }
      if (it.pad && !it.free) {
        const rank = (ranks.get(it.net) || 0) + 1; ranks.set(it.net, rank);
        if (!originPad || rank > (ranks.get(origin) || 0)) { originPad = true; origin = it.net; }
        if (it.net !== origin) conflicting = true;
      }
    }
    if (!members.some((i) => items[i].pad)) for (const i of members) padless.add(items[i].id);
    if (conflicting || !origin) continue;
    for (const i of members) { const it = items[i]; if (it.canChange && it.net !== origin) nets.set(it.id, origin); }
  }
  return { nets, padless };
}

/** ZONE::IsOnCopperLayer. */
function zoneOnCopper(node: SNode): boolean {
  const l = kid(node, "layer") as SNode | null, ls = kid(node, "layers") as SNode | null;
  const names = [...(l ? [str(l[1])] : []), ...(ls ? ls.slice(1).map(str) : [])];
  return names.some((n) => /\.Cu$/.test(n) || n === "*.Cu" || n === "F&B.Cu");
}
/** BOARD_ITEM::LayerMaskDescribe for a zone: "all copper layers", the first layer (by layer id) "and others", or the one layer. */
function zoneLayerDescription(doc: KDoc, node: SNode): string {
  const l = kid(node, "layer") as SNode | null, ls = kid(node, "layers") as SNode | null;
  let names = [...(l ? [str(l[1])] : []), ...(ls ? ls.slice(1).map(str) : [])];
  const boardCopper = (doc.copper || []).slice();
  const shownName = (n: string): string => { const l = doc.layers && doc.layers.get(n); return l && l.userName ? l.userName : n; };
  if (names.includes("*.Cu")) names = boardCopper.length ? boardCopper : ["F.Cu", "B.Cu"];
  else if (names.includes("F&B.Cu")) names = names.filter((n) => n !== "F&B.Cu").concat(["F.Cu", "B.Cu"]);
  const copper = names.filter((n) => /\.Cu$/.test(n));
  if (boardCopper.length && copper.length === boardCopper.length) return "all copper layers";
  // PCB_LAYER_ID order: F.Cu, B.Cu, In1.Cu, In2.Cu …
  const cuRank = (n: string): number => (n === "F.Cu" ? 0 : n === "B.Cu" ? 1 : 1 + (Number((/^In(\d+)\.Cu$/.exec(n) || [])[1]) || 99));
  const first = (list: string[]): string => list.slice().sort((a, b) => cuRank(a) - cuRank(b))[0];
  for (const test of [copper, names]) if (test.length) return shownName(first(test)) + (test.length > 1 ? " and others" : "");
  return "no layers";
}
/**
 * CONNECTIVITY_DATA::GetConnectedPads( zone ) as cacheCopperZoneConnections takes it before the update: the pads of
 * the zone's net whose copper lies inside the zone's outline on one of its layers ({ footprint id, pad uuid, net }).
 */
function zoneConnectedPads(doc: KDoc): Map<string, { fp: string; uuid: string; net: string }[]> {
  const out = new Map<string, { fp: string; uuid: string; net: string }[]>();
  const zones = Array.from(doc.items.values()).filter((it) => it.kind === "zone" && zoneOnCopper(it.node) && !kid(it.node, "keepout") && !kid(it.node, "rule_area"));
  if (!zones.length) return out;
  const inside = (p: Pt, poly: Pt[]): boolean => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  for (const z of zones) {
    const net = netNameOf(doc, z.node); if (!net) continue;
    const polys = (kids(z.node, "filled_polygon") as SNode[]).map((fp) => ({ layer: kidStr(fp, "layer"), pts: ptsOf(fp) as Pt[] }));
    const zl = kid(z.node, "layer") as SNode | null, zls = kid(z.node, "layers") as SNode | null;
    const layers = [...(zl ? [str(zl[1])] : []), ...(zls ? zls.slice(1).map(str) : [])];
    const list: { fp: string; uuid: string; net: string }[] = [];
    for (const it of doc.items.values()) {
      if (it.kind !== "footprint") continue;
      const a = atOf(it.node) as number[], rot = ((a[2] || 0) * Math.PI) / 180, ca = Math.cos(rot), sa = Math.sin(rot);
      for (const pad of kids(it.node, "pad") as SNode[]) {
        if (netNameOf(doc, pad) !== net) continue;
        const pl = kid(pad, "layers") as SNode | null, padLayers = pl ? pl.slice(1).map(str) : [];
        const onLayer = (l: string): boolean => padLayers.includes(l) || padLayers.includes("*.Cu") || (padLayers.includes("F&B.Cu") && (l === "F.Cu" || l === "B.Cu"));
        const pa = atOf(pad) as number[], px = pa[0] || 0, py = pa[1] || 0;
        // footprint coordinates: rotated clockwise on screen (y down) by the footprint's angle
        const p: Pt = [a[0] + px * ca + py * sa, a[1] - px * sa + py * ca];
        const hit = polys.length ? polys.some((fp) => onLayer(fp.layer) && inside(p, fp.pts)) : layers.some(onLayer) && inside(p, ptsOf(kid(z.node, "polygon") as SNode || z.node) as Pt[]);
        if (hit) list.push({ fp: it.id, uuid: kidStr(pad, "uuid") || kidStr(pad, "tstamp"), net });
      }
    }
    out.set(z.id, list);
  }
  return out;
}

/**
 * A board footprint from library text (.kicad_mod): fresh uuids everywhere, the library id as the footprint
 * name, front side at the origin.  The updater then lays the component's fields and nets over it.
 */
export function footprintFromLibrary(mod: SNode, fpid: string, newUuid: () => string): SNode {
  const fp = clone(mod);
  fp[0] = "footprint"; fp[1] = fpid;
  for (const k of ["version", "generator", "generator_version", "tedit", "uuid", "at", "locked", "placed"]) while (delKid(fp, k)) { /* drop every copy */ }
  const stamp = (n: SNode): void => {
    for (let j = 1; j < n.length; j++) { const c = n[j]; if (!isList(c)) continue; if (c[0] === "uuid" || c[0] === "tstamp") { n[j] = qnode("uuid", [newUuid()]); continue; } stamp(c); }
    if (["property", "fp_text", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "fp_text_box", "pad", "zone", "dimension"].includes(str(n[0])) && idxOf(n, "uuid") < 0) {
      const e = idxOf(n, "effects"); n.splice(e > 0 ? e : n.length, 0, qnode("uuid", [newUuid()]));
    }
  };
  stamp(fp);
  const layer = idxOf(fp, "layer");
  fp.splice(layer > 0 ? layer + 1 : 2, 0, qnode("uuid", [newUuid()]), ["at", 0, 0]);
  return fp;
}

// ---------------------------------------------------------------- schematic parity (DRC_TEST_PROVIDER_SCHEMATIC_PARITY)
export interface ParityIssue { code: string; severity: "error" | "warning"; x: number; y: number; text: string; ids: string[] }
/** The board against the schematic's netlist: missing / extra / duplicate footprints, value and footprint mismatches, pad nets. */
export function schematicParity(doc: KDoc, netlist: Netlist): ParityIssue[] {
  const out: ParityIssue[] = [];
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint");
  const at = (fp: KItem): [number, number] => { const a = atOf(fp.node) as number[]; return [a[0] || 0, a[1] || 0]; };
  const say = (code: string, text: string, fp: KItem | null): void => { const p = fp ? at(fp) : [0, 0]; out.push({ code, severity: "warning", x: p[0], y: p[1], text, ids: fp ? [fp.id] : [] }); };
  const byPath = new Map<string, KItem>(), byRef = new Map<string, KItem[]>();
  for (const fp of fps) {
    const path = kidStr(fp.node, "path"); if (path && !byPath.has(path)) byPath.set(path, fp);
    const ref = fpRef(fp.node); const l = byRef.get(ref); if (l) l.push(fp); else byRef.set(ref, [fp]);
  }
  for (const [ref, list] of byRef) if (ref && list.length > 1) for (const fp of list.slice(1)) say("duplicate_footprints", `Duplicate footprints (${ref})`, fp);
  const pinNet = new Map<string, string>();
  for (const [name, pins] of netlist.nets) for (const p of pins) pinNet.set(p.ref + "|" + p.pin, name);
  const matched = new Set<string>();
  for (const c of netlist.components) {
    let fp: KItem | undefined;
    for (const p of c.paths) { fp = byPath.get(p); if (fp) break; }
    if (!fp) fp = (byRef.get(c.ref) || []).find((f) => !matched.has(f.id));
    if (!fp) { if (c.footprint) say("missing_footprint", `Missing footprint ${c.ref} (${c.value})`, null); continue; }
    matched.add(fp.id);
    const value = fpValue(fp.node);
    if (value !== c.value) say("footprint_symbol_mismatch", `Value (${value}) doesn't match symbol value (${c.value})`, fp);
    const fpid = str(fp.node[1]);
    if (c.footprint && fpid !== c.footprint) say("footprint_symbol_mismatch", `${fpid} doesn't match footprint given by symbol (${c.footprint})`, fp);
    const seen = new Set<string>();
    for (const pad of kids(fp.node, "pad") as SNode[]) {
      const number = str(pad[1]); if (!number) continue; seen.add(number);
      const want = pinNet.get(c.ref + "|" + number), n = kid(pad, "net") as SNode | null;
      const have = n ? (typeof n[1] === "number" ? (n.length > 2 ? str(n[2]) : str(doc.nets.get(n[1]) || "")) : str(n[1])) : "";
      if (want === undefined) { if (have && !/^unconnected-\(/.test(have)) say("net_conflict", `${c.ref} pad ${number}: No corresponding pin found in schematic`, fp); }
      else if (!have) say("net_conflict", `${c.ref} pad ${number}: Pad missing net given by schematic (${want})`, fp);
      else if (have !== want) say("net_conflict", `${c.ref} pad ${number}: Pad net (${have}) doesn't match net given by schematic (${want})`, fp);
    }
    for (const key of pinNet.keys()) if (key.startsWith(c.ref + "|") && !seen.has(key.slice(c.ref.length + 1))) say("net_conflict", `${c.ref}: No pad found for pin ${key.slice(c.ref.length + 1)} in schematic`, fp);
  }
  for (const fp of fps) {
    if (matched.has(fp.id)) continue;
    const attr = kid(fp.node, "attr") as SNode | null;
    if (attr && attr.includes("board_only")) continue;
    say("extra_footprint", `Extra footprint (${fpRef(fp.node) || str(fp.node[1])})`, fp);
  }
  return out;
}

/** A new, empty board as pcbnew creates it for a project that has none (two copper layers, the default layer set). */
const NEW_BOARD_LAYERS = '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (9 "F.Adhes" user "F.Adhesive") (11 "B.Adhes" user "B.Adhesive") (13 "F.Paste" user) (15 "B.Paste" user) (5 "F.SilkS" user "F.Silkscreen") (7 "B.SilkS" user "B.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user "User.Comments") (21 "Eco1.User" user "User.Eco1") (23 "Eco2.User" user "User.Eco2") (25 "Edge.Cuts" user) (27 "Margin" user) (31 "F.CrtYd" user "F.Courtyard") (29 "B.CrtYd" user "B.Courtyard") (35 "F.Fab" user) (33 "B.Fab" user))';
export function newBoardText(version: number): string {
  return `(kicad_pcb (version ${version}) (generator "pcbnew") (generator_version "${GENERATOR_VERSION}") (general (thickness 1.6) (legacy_teardrops no)) (paper "A4") ${NEW_BOARD_LAYERS} (setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no)) (net 0 ""))\n`;
}
/** The project's board: <project>.kicad_pcb next to the .kicad_pro (Prj().GetProjectFullName() with the board extension). */
export function projectBoardPath(docs: { docId: string; path: string; docType: string }[]): { path: string; doc: { docId: string; path: string; docType: string } | null } {
  const pro = docs.find((d) => d.docType === "kicad_pro");
  const path = pro ? pro.path.replace(/\.kicad_pro$/, ".kicad_pcb") : "";
  const doc = docs.find((d) => d.docType === "kicad_pcb" && d.path === path) || (pro ? null : docs.find((d) => d.docType === "kicad_pcb") || null);
  return { path: path || (doc ? doc.path : ""), doc };
}

export const pcbNetlist = { newBoardText, projectBoardPath, instanceRef, buildNetlist, planUpdate, componentVariants, schematicParity, footprintFromLibrary, escapeNetName, unescapeNetName, busVector, netlistOptions, unitCount };
