// kicad-canvas / net-chains — net chains: nets joined through two-pin "passthrough" parts (series resistors,
// ferrites, AC-coupling capacitors) treated as one signal.  The schematic half is
// eeschema/connectivity/conn_netchain_manager.cpp (NETCHAIN_MANAGER): the bridge graph, the potential chains, their
// default names and terminal pins, and the committed chains restored from the first top-level sheet's
// (net_chain "name" (from "ref" "pin") (to "ref" "pin") (net_class "x") (color r g b a) (nets …)) entries.  The
// board half is the (net_chains (net_chain (name "x") (members (net "n") …) (terminal_pad "uuid") …)) section of a
// .kicad_pcb (pcb_io_kicad_sexpr.cpp / pcb_io_kicad_sexpr_parser.cpp parseNET_CHAINS_SECTION).
//
// The browser keeps no manager between edits: the committed chains are restored from the file every time, which is
// what eeschema's NETCHAIN_MANAGER::rebuild does on load (terminal references first, then the saved member nets).
// Pure functions over parsed documents, exposed as KiCadCanvas.netChains for the node tests.
import { kid, kids, num, parse, ptsOf, str } from "./sexpr";
import { resolveLib } from "./geom-sch";
import { instanceRef, type NetEntry, type SheetInstance, type SymPin } from "./pcb-netlist";

// ---------------------------------------------------------------- names
/** SCH_NETCHAIN::IsValidName: not empty, and none of  " ' ( )  or a space. */
export function isValidName(name: string): boolean { return !!name && !/["'() ]/.test(name); }
/** SCH_NETCHAIN::SYNTHETIC_NET_PREFIX / IsPersistableNet. */
export const SYNTHETIC_NET_PREFIX = "__SG_";
export function isPersistableNet(net: string): boolean { return !!net && !net.startsWith(SYNTHETIC_NET_PREFIX); }
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** wxString::CmpNoCase. */
const cmpNoCase = (a: string, b: string): number => cmp(a.toLowerCase(), b.toLowerCase());

// ---------------------------------------------------------------- ValueStringCompare (common/string_utils.cpp)
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const OLD_SCHOOL: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, L: 1e-3, R: 1, F: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };
/** ApplyModifier: scales `v` by a leading SI letter; false when the text is not a multiplier with a known unit. */
function applyModifier(v: { n: number }, s: string): boolean {
  if (!s.length) return false;
  const st = s.replace(/[ \t]+$/, "").replace(/^[ \t]+/, "");
  if (st === "m") return true;
  if (st === "mils") { v.n *= 0.0000254; return true; }
  if (st === "in") { v.n *= 0.0254; return true; }
  let modifier = " ", units: string;
  if ("afpnuµμmLRFkKMGTPE".includes(s[0])) { modifier = s[0]; units = s.slice(1).replace(/[ \t]+$/, ""); }
  else units = s.replace(/[ \t]+$/, "");
  if (units.length && !["f", "hz", "ω", "w", "v", "a", "h", "s", "m"].includes(units.toLowerCase())) return false;
  if (modifier === "a") v.n *= 1e-18; else if (modifier === "f") v.n *= 1e-15;
  if (modifier === "p") v.n *= 1e-12;
  if (modifier === "n") v.n *= 1e-9;
  else if (modifier === "u" || modifier === "µ" || modifier === "μ") v.n *= 1e-6;
  else if (modifier === "m" || modifier === "L") v.n *= 1e-3;
  else if (modifier === "k" || modifier === "K") v.n *= 1e3;
  else if (modifier === "M") v.n *= 1e6;
  else if (modifier === "G") v.n *= 1e9;
  else if (modifier === "T") v.n *= 1e12;
  else if (modifier === "P") v.n *= 1e15;
  else if (modifier === "E") v.n *= 1e18;
  return true;
}
/** SplitString: the text before the number, the number (an SI infix read as the point) and what follows. */
function splitString(s: string): [string, string, string] {
  if (!s.length) return ["", "", ""];
  let ii = s.length - 1;
  for (; ii >= 0; ii--) if (isDigit(s[ii])) break;
  if (ii < 0) return [s, "", ""];
  let end = s.slice(ii + 1), infix = "";
  const position = ii + 1;
  for (; ii >= 0; ii--) {
    const c = s[ii];
    if (isDigit(c)) continue;
    if (!infix && (ii > 0 || !end) && c in OLD_SCHOOL && applyModifier({ n: OLD_SCHOOL[c] }, c + end)) { infix = c; continue; }
    if (c === "." || c === ",") continue;
    break;
  }
  let beg = "", digits: string;
  if (ii < 0) digits = s.slice(0, position);
  else { digits = s.slice(ii + 1, position); beg = s.slice(0, ii + 1); }
  if (infix) { digits = digits.split(infix).join("."); end = infix + end; }
  return [beg, digits, end];
}
/** convertSeparators: thousands separators dropped, the decimal one made a point (a "." when nothing tells). */
function convertSeparators(v: string): string {
  v = v.replace(/ /g, "");
  let amb = "?", thou = "?", thouFound = false, dec = "?", decFound = false, digits = 0;
  for (let ii = v.length - 1; ii >= 0; --ii) {
    const c = v[ii];
    if (c >= "0" && c <= "9") digits += 1;
    else if (c === "." || c === ",") {
      if (dec !== "?" || thou !== "?") {
        if (c === dec) { if (thouFound || decFound) return v; decFound = true; }
        else if (c === thou) { if (digits !== 3) return v; thouFound = true; }
      } else if (amb !== "?") {
        if (c === amb) { thou = amb; thouFound = true; dec = c === "." ? "," : "."; }
        else { dec = amb; decFound = true; thou = c; thouFound = true; }
      } else if ((ii === 1 && v[0] === "0") || digits !== 3) { dec = c; decFound = true; thou = c === "." ? "," : "."; }
      else amb = c;
      digits = 0;
    } else digits = 0;
  }
  if (dec === "?" && thou === "?") { dec = "."; thou = ","; }
  return v.split(thou).join("").split(dec).join(".");
}
/** wxString::ToCDouble: the whole text a C-locale number, else 0. */
const toCDouble = (s: string): number => (/^[ \t]*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? parseFloat(s) : 0);
/** ValueStringCompare: the prefixes without case, then the values (4K7 > 470), then the suffixes. */
export function valueStringCompare(a: string, b: string): number {
  const [fb, fm, fe] = splitString(a), [sb, sm, se] = splitString(b);
  const e = cmpNoCase(fb, sb);
  if (e > 0) return 1; if (e < 0) return -1;
  const x = { n: toCDouble(convertSeparators(fm)) }, y = { n: toCDouble(convertSeparators(sm)) };
  let mod = false;
  mod = applyModifier(x, fe) || mod; mod = applyModifier(y, se) || mod;
  if (x.n > y.n) return 1; if (x.n < y.n) return -1;
  if (!mod) return Math.sign(cmpNoCase(fe, se));
  return 0;
}

// ---------------------------------------------------------------- the schematic file
export interface ChainTerminalRef { ref: string; pin: string }
/** One (net_chain …) entry of the first top-level sheet (SCH_IO_KICAD_SEXPR_PARSER::parseSchNetChain). */
export interface SavedChain {
  /** the item id (net_chain:<name>) */
  id: string; name: string;
  /** both set when the entry has both (from …) and (to …) with a reference */
  from: ChainTerminalRef | null; to: ChainTerminalRef | null;
  netClass: string;
  /** (color R G B A): 0-255 channels and the alpha */
  color: [number, number, number, number] | null;
  nets: string[];
}
/** The (net_chain …) entries of a sheet, in file order (a name given twice: the later one's values). */
export function savedChains(doc: KDoc | null | undefined): SavedChain[] {
  const out = new Map<string, SavedChain>();
  if (!doc) return [];
  for (const it of doc.items.values()) {
    if (it.kind !== "net_chain") continue;
    const s = parseChainNode(it.node); out.delete(s.name); out.set(s.name, { ...s, id: it.id });
  }
  return Array.from(out.values());
}
export function parseChainNode(n: SNode): SavedChain {
  const name = str(n[1]);
  const f = kid(n, "from"), t = kid(n, "to"), nc = kid(n, "net_class"), c = kid(n, "color"), ns = kid(n, "nets");
  const from = f ? { ref: str(f[1]), pin: str(f[2]) } : null, to = t ? { ref: str(t[1]), pin: str(t[2]) } : null;
  const both = !!from && !!to && !!from.ref && !!to.ref;
  return {
    id: "net_chain:" + name, name, from: both ? from : null, to: both ? to : null, netClass: nc ? str(nc[1]) : "",
    color: c ? [num(c[1]), num(c[2]), num(c[3]), num(c[4], 1)] : null,
    nets: ns ? Array.from(new Set(ns.slice(1).map((x) => str(x)))).sort(cmp) : [],
  };
}
/** FormatDouble2Str: the shortest text that reads back as the value. */
const fmtDouble = (v: number): string => { const s = String(+v.toFixed(10)); return s.includes("e") ? v.toFixed(10).replace(/\.?0+$/, "") : s; };
const quote = (s: string): string => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
/** The (net_chain …) text SCH_IO_KICAD_SEXPR::Format writes for a chain with both terminal references. */
export function chainNodeText(c: { name: string; from: ChainTerminalRef; to: ChainTerminalRef; netClass?: string; color?: [number, number, number, number] | null; nets?: Iterable<string> }): string {
  let s = `(net_chain ${quote(c.name)} (from ${quote(c.from.ref)} ${quote(c.from.pin)}) (to ${quote(c.to.ref)} ${quote(c.to.pin)})`;
  if (c.netClass) s += ` (net_class ${quote(c.netClass)})`;
  if (c.color) s += ` (color ${Math.round(c.color[0])} ${Math.round(c.color[1])} ${Math.round(c.color[2])} ${fmtDouble(c.color[3])})`;
  const nets = Array.from(new Set(Array.from(c.nets || []).filter(isPersistableNet))).sort(cmp);
  if (nets.length) s += " (nets" + nets.map((n) => " " + quote(n)).join("") + ")";
  return s + ")";
}
export function chainNode(c: Parameters<typeof chainNodeText>[0]): SNode { return parse(chainNodeText(c)) as SNode; }
/** A saved entry written back with some values changed (the panel's edits). */
export function savedNodeText(s: SavedChain, change: Partial<Pick<SavedChain, "name" | "netClass" | "color" | "from" | "to" | "nets">> = {}): string | null {
  const v = { ...s, ...change };
  if (!v.from || !v.to) return null;
  return chainNodeText({ name: v.name, from: v.from, to: v.to, netClass: v.netClass, color: v.color, nets: v.nets });
}

// ---------------------------------------------------------------- the chains
export interface ChainPin { inst: number; file: string; id: string; pin: string; ref: string; x: number; y: number }
export interface ChainSymbol { inst: number; file: string; id: string }
export interface NetChain {
  name: string;
  /** the member nets, sorted (std::set) */
  nets: string[];
  /** the bridge symbols (a potential's) or the symbols with a pin on a member net (a manual chain's) */
  symbols: ChainSymbol[];
  termA: ChainPin | null; termB: ChainPin | null;
  netClass: string; color: [number, number, number, number] | null;
  /** restored from the saved member nets, not from a potential chain */
  manual?: boolean;
}
export interface BridgeEdge { a: string; b: string; inst: number; file: string; id: string }
export interface ChainModel {
  potentials: NetChain[];
  committed: NetChain[];
  edges: BridgeEdge[];
  /** the saved entries the model was restored from */
  saved: SavedChain[];
  /** a pin's net: "<inst>|<symbol id>#pin:<number>" -> net name */
  pinNet: Map<string, string>;
  /** every symbol of every sheet instance with its pins, in sheet / item / pin order */
  sheets: { inst: SheetInstance; doc: KDoc; symbols: { item: KItem; ref: string; pins: SymPin[] }[] }[];
}
export interface ChainInput {
  map: Map<string, NetEntry>; instances: SheetInstance[]; docs: Map<string, KDoc>;
  symbolPins(doc: KDoc, item: KItem): SymPin[];
  project?: string;
  /** the (net_chain …) entries of the first top-level sheet */
  saved: SavedChain[];
}
const IU = (v: number): number => Math.round(v * 10000);
function libPower(doc: KDoc, node: SNode): "global" | "local" | null {
  const lib = resolveLib(doc, str((kid(node, "lib_name") || kid(node, "lib_id") || [])[1])) || resolveLib(doc, str((kid(node, "lib_id") || [])[1]));
  const p = lib && kid(lib, "power"); return p ? (str(p[1]) === "local" ? "local" : "global") : null;
}
/** SCH_PIN::IsPower: a power input of a power symbol, or a hidden one of an ordinary symbol (legacy global power). */
const pinIsPower = (p: SymPin, power: "global" | "local" | null): boolean => p.type === "power_in" && (!!power || p.hidden);
/** SCH_SYMBOL::GetPassthroughMode. */
export function passthroughMode(node: SNode): "default" | "block" | "force" { const c = kid(node, "passthrough"); const v = c ? str(c[1]) : ""; return v === "block" || v === "force" ? v : "default"; }

/** NETCHAIN_MANAGER::rebuild, as on load: the potential chains, then the committed ones restored from the saved entries. */
export function buildChains(input: ChainInput): ChainModel {
  const pinNet = new Map<string, string>();
  for (const [name, e] of input.map) { if (e.bus) continue; for (const m of e.members) if (m.kind === "pin" && m.pin !== undefined) pinNet.set(m.inst + "|" + m.id + "#pin:" + m.pin, name); }
  const keyOf = (inst: number, id: string, pin: string): string => pinNet.get(inst + "|" + id + "#pin:" + pin) || "";
  const sheets: ChainModel["sheets"] = [];
  for (const inst of input.instances) {
    const doc = input.docs.get(inst.file); if (!doc) continue;
    const path = "/" + inst.uuidPath.join("/");
    const symbols: ChainModel["sheets"][number]["symbols"] = [];
    for (const it of doc.items.values()) if (it.kind === "symbol") symbols.push({ item: it, ref: instanceRef(it.node, path, input.project).ref, pins: input.symbolPins(doc, it) });
    sheets.push({ inst, doc, symbols });
  }
  // ---- buildBridgeAdjacency
  const edges: BridgeEdge[] = [];
  for (const sh of sheets) {
    const wires = Array.from(sh.doc.items.values()).filter((it) => it.kind === "wire").map((it) => ptsOf(it.node).map((p) => [IU(p[0]), IU(p[1])]));
    const wireAt = (p: SymPin): number[][] | null => {
      const x = IU(p.x), y = IU(p.y);
      for (const w of wires) {
        if (w.length < 2) continue;
        const [s, e] = w;
        if (s[1] === e[1] && y === s[1]) { if (x >= Math.min(s[0], e[0]) && x <= Math.max(s[0], e[0])) return w; }
        else if (s[0] === e[0] && x === s[0]) { if (y >= Math.min(s[1], e[1]) && y <= Math.max(s[1], e[1])) return w; }
      }
      return null;
    };
    for (const s of sh.symbols) {
      if (s.pins.length !== 2) continue;
      const mode = passthroughMode(s.item.node);
      if (mode === "block") continue;
      const wa = wireAt(s.pins[0]), wb = wireAt(s.pins[1]);
      if (!wa || !wb) continue;
      let allow = false;
      if (mode === "force") allow = true;
      else {
        const power = libPower(sh.doc, s.item.node);
        if (pinIsPower(s.pins[0], power) || pinIsPower(s.pins[1], power)) continue;
        const [aS, aE] = wa, [bS, bE] = wb;
        if (aS[0] === aE[0] && bS[0] === bE[0] && aS[0] === bS[0]) allow = true;
        else if (aS[1] === aE[1] && bS[1] === bE[1] && aS[1] === bS[1]) allow = true;
      }
      if (!allow) continue;
      const a = keyOf(sh.inst.index, s.item.id, s.pins[0].number), b = keyOf(sh.inst.index, s.item.id, s.pins[1].number);
      if (!a || !b || a === b) continue;
      edges.push({ a, b, inst: sh.inst.index, file: sh.inst.file, id: s.item.id });
    }
  }
  const powerNets = new Set<string>();
  for (const sh of sheets) for (const s of sh.symbols) {
    const power = libPower(sh.doc, s.item.node);
    for (const p of s.pins) if (pinIsPower(p, power) || power) { const k = keyOf(sh.inst.index, s.item.id, p.number); if (k) powerNets.add(k); }
  }
  let adjacency = new Map<string, { other: string; edge: BridgeEdge }[]>();
  const powerAdjacent = new Set<string>();
  const push = (m: Map<string, { other: string; edge: BridgeEdge }[]>, k: string, v: { other: string; edge: BridgeEdge }): void => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const be of edges) {
    if (powerNets.has(be.a) || powerNets.has(be.b)) {
      if (!powerNets.has(be.a)) powerAdjacent.add(be.a);
      if (!powerNets.has(be.b)) powerAdjacent.add(be.b);
      continue;
    }
    push(adjacency, be.a, { other: be.b, edge: be }); push(adjacency, be.b, { other: be.a, edge: be });
  }
  const sortedKeys = (m: Map<string, unknown>): string[] => Array.from(m.keys()).sort(cmp);
  {
    const degree = new Map<string, number>(); for (const k of sortedKeys(adjacency)) degree.set(k, adjacency.get(k)!.length);
    if (adjacency.size <= 2) powerAdjacent.clear();
    if (powerAdjacent.size <= 2) powerAdjacent.clear();
    const q: string[] = [], removed = new Set<string>();
    for (const [k, d] of degree) if (d <= 1 && powerAdjacent.has(k)) q.push(k);
    while (q.length) {
      const n = q.shift()!;
      if (removed.has(n)) continue;
      removed.add(n);
      for (const e of adjacency.get(n) || []) {
        if (removed.has(e.other)) continue;
        if (degree.has(e.other)) { const d = degree.get(e.other)! - 1; degree.set(e.other, d); if (d <= 1 && powerAdjacent.has(e.other)) q.push(e.other); }
      }
    }
    if (removed.size) adjacency = prune(adjacency, removed);
  }
  // ---- targeted stub pruning: a component of more than four nets loses its stubs (leaves on a branching net)
  {
    const seen = new Set<string>(), globalPrune = new Set<string>();
    for (const start of sortedKeys(adjacency)) {
      if (seen.has(start)) continue;
      const comp: string[] = [], q = [start]; seen.add(start);
      while (q.length) { const cur = q.shift()!; comp.push(cur); for (const e of adjacency.get(cur)!) if (!seen.has(e.other)) { seen.add(e.other); q.push(e.other); } }
      if (comp.length <= 4) continue;
      const candidates: string[] = [];
      for (const n of comp) { const nb = adjacency.get(n)!; if (nb.length === 1) { const d = adjacency.get(nb[0].other); if (d && d.length > 2) candidates.push(n); } }
      if (!candidates.length) continue;
      candidates.sort(cmpNoCase);
      const need = Math.min(comp.length - 4, candidates.length);
      for (let i = 0; i < need; i++) globalPrune.add(candidates[i]);
    }
    if (globalPrune.size) adjacency = prune(adjacency, globalPrune);
  }
  // ---- the potential chains: connected components of two nets or more
  const potentials: NetChain[] = [];
  const visited = new Set<string>();
  for (const start of sortedKeys(adjacency)) {
    if (visited.has(start)) continue;
    const q = [start], comp = new Set<string>([start]); visited.add(start);
    while (q.length) { const cur = q.shift()!; for (const e of adjacency.get(cur) || []) { if (visited.has(e.other)) continue; visited.add(e.other); comp.add(e.other); q.push(e.other); } }
    if (comp.size >= 2) potentials.push({ name: "", nets: Array.from(comp).sort(cmp), symbols: [], termA: null, termB: null, netClass: "", color: null });
  }
  const netToChain = new Map<string, NetChain>();
  for (const p of potentials) for (const n of p.nets) netToChain.set(n, p);
  for (const e of edges) {
    const f = netToChain.get(e.a), s = netToChain.get(e.b);
    if (f && s && f === s && !f.symbols.some((x) => x.file === e.file && x.id === e.id)) f.symbols.push({ inst: e.inst, file: e.file, id: e.id });
  }
  // ---- terminal pins: the farthest pair of pins on the chain's nets (sheet / item / pin order breaks ties)
  const chainPins = new Map<NetChain, ChainPin[]>();
  if (potentials.length) for (const sh of sheets) for (const s of sh.symbols) for (const p of s.pins) {
    const c = netToChain.get(keyOf(sh.inst.index, s.item.id, p.number));
    if (c) { const l = chainPins.get(c) || []; l.push({ inst: sh.inst.index, file: sh.inst.file, id: s.item.id, pin: p.number, ref: s.ref, x: p.x, y: p.y }); chainPins.set(c, l); }
  }
  for (const c of potentials) {
    const pins = chainPins.get(c) || [];
    let best = -1, bi = 0, bj = 0;
    for (let i = 0; i < pins.length; i++) for (let j = i + 1; j < pins.length; j++) {
      const dx = IU(pins[i].x) - IU(pins[j].x), dy = IU(pins[i].y) - IU(pins[j].y), d = dx * dx + dy * dy;
      if (d > best) { best = d; bi = i; bj = j; }
    }
    if (best >= 0) { c.termA = pins[bi]; c.termB = pins[bj]; }
  }
  // ---- restore the committed chains (pass 1: by terminal references; pass 2: manual chains by their member nets)
  const terminalRefs = new Map<string, [ChainTerminalRef, ChainTerminalRef]>(), memberNets = new Map<string, Set<string>>(), netClassOf = new Map<string, string>(), colorOf = new Map<string, [number, number, number, number]>();
  for (const s of input.saved) {
    if (s.from && s.to) terminalRefs.set(s.name, [s.from, s.to]);
    if (s.netClass) netClassOf.set(s.name, s.netClass);
    if (s.color) colorOf.set(s.name, s.color);
    if (s.nets.length) memberNets.set(s.name, new Set(s.nets));
  }
  const committed: NetChain[] = [];
  /** resolveTerminals( chain, savedRefs ): each reference + pin names exactly one pin of the hierarchy */
  const resolveTerminals = (refs: [ChainTerminalRef, ChainTerminalRef]): [ChainPin, ChainPin] | null => {
    const out: ChainPin[] = [];
    for (const r of refs) {
      let hit: ChainPin | null = null;
      for (const sh of sheets) for (const s of sh.symbols) {
        if (s.ref !== r.ref) continue;
        for (const p of s.pins) {
          if (p.number !== r.pin) continue;
          if (hit) return null;
          hit = { inst: sh.inst.index, file: sh.inst.file, id: s.item.id, pin: p.number, ref: s.ref, x: p.x, y: p.y };
        }
      }
      if (!hit) return null;
      out.push(hit);
    }
    return [out[0], out[1]];
  };
  const refPinToNet = new Map<string, string>();
  if (terminalRefs.size) for (const sh of sheets) for (const s of sh.symbols) for (const p of s.pins) { const k = keyOf(sh.inst.index, s.item.id, p.number); if (k) refPinToNet.set(s.ref + "\u0000" + p.number, k); }
  const findPotential = (a: string, b: string): NetChain | null => potentials.find((p) => p.nets.includes(a) && p.nets.includes(b)) || null;
  const already = new Set<string>();
  for (const name of Array.from(terminalRefs.keys()).sort(cmp)) {
    const refs = terminalRefs.get(name)!;
    const from = refPinToNet.get(refs[0].ref + "\u0000" + refs[0].pin), to = refPinToNet.get(refs[1].ref + "\u0000" + refs[1].pin);
    if (from === undefined || to === undefined) continue;
    const match = findPotential(from, to); if (!match) continue;
    if (already.has(name)) continue;
    // CreateNetChainFromPotential
    const t = resolveTerminals(refs); if (!t) continue;
    committed.push({ name, nets: match.nets.slice(), symbols: match.symbols.slice(), termA: t[0], termB: t[1], netClass: netClassOf.get(name) || "", color: colorOf.get(name) || null });
    already.add(name);
  }
  for (const name of Array.from(memberNets.keys()).sort(cmp)) {
    const nets = memberNets.get(name)!;
    if (!nets.size || already.has(name)) continue;
    const refs = terminalRefs.get(name); if (!refs) continue;
    let ta = false, tb = false; const symbols: ChainSymbol[] = [];
    for (const sh of sheets) for (const s of sh.symbols) {
      let contributes = false;
      for (const p of s.pins) {
        const k = keyOf(sh.inst.index, s.item.id, p.number); if (!k) continue;
        if (nets.has(k)) contributes = true;
        if (s.ref === refs[0].ref && p.number === refs[0].pin) ta = true;
        if (s.ref === refs[1].ref && p.number === refs[1].pin) tb = true;
      }
      if (contributes) symbols.push({ inst: sh.inst.index, file: sh.inst.file, id: s.item.id });
    }
    if (!ta || !tb || !symbols.length) continue;
    // CreateManualNetChain
    if (!isValidName(name) || committed.some((c) => c.name === name)) continue;
    const list = Array.from(nets).filter((n) => !!n).sort(cmp);
    if (list.some((n) => committed.some((c) => c.nets.includes(n)))) continue;
    const t = resolveTerminals(refs); if (!t) continue;
    const uniq: ChainSymbol[] = []; for (const s of symbols) if (!uniq.some((u) => u.file === s.file && u.id === s.id)) uniq.push(s);
    committed.push({ name, nets: list, symbols: uniq, termA: t[0], termB: t[1], netClass: netClassOf.get(name) || "", color: colorOf.get(name) || null, manual: true });
    already.add(name);
  }
  // ---- the potential chains' default names: the smallest local label on them that no committed chain owns, else NetChain<n>
  const committedNames = new Set(committed.map((c) => c.name));
  const itemNet = new Map<string, string>();
  for (const [name, e] of input.map) { if (e.bus) continue; for (const m of e.members) if (m.kind === "label") itemNet.set(m.inst + "|" + m.id, name); }
  for (const sh of sheets) for (const it of sh.doc.items.values()) {
    if (it.kind !== "label") continue;
    const net = itemNet.get(sh.inst.index + "|" + it.id) || "";
    if (!net || net.length >= 2048) continue;
    const c = netToChain.get(net); if (!c) continue;
    let name = str(it.node[1]); if (name.length > 512) name = name.slice(0, 512);
    if (name.startsWith("/")) name = name.slice(1);
    if (!committedNames.has(name) && (!c.name || name < c.name)) c.name = name;
  }
  let idx = 1;
  for (const p of potentials) if (!p.name) p.name = "NetChain" + idx++;
  return { potentials, committed, edges, saved: input.saved, pinNet, sheets };
}
function prune<V extends { other: string }>(adj: Map<string, V[]>, gone: Set<string>): Map<string, V[]> {
  const out = new Map<string, V[]>();
  for (const k of Array.from(adj.keys()).sort(cmp)) {
    if (gone.has(k)) continue;
    for (const e of adj.get(k)!) { if (gone.has(e.other)) continue; const l = out.get(k); if (l) l.push(e); else out.set(k, [e]); }
  }
  return out;
}

// ---------------------------------------------------------------- queries
/** NETCHAIN_MANAGER::GetNetChainForNet: the first committed chain holding the net. */
export function chainForNet(m: ChainModel, net: string): NetChain | null { if (!net) return null; return m.committed.find((c) => c.nets.includes(net)) || null; }
export function chainByName(m: ChainModel, name: string): NetChain | null { return m.committed.find((c) => c.name === name) || null; }
/** The net of a symbol pin on a sheet instance. */
export function pinNetOf(m: ChainModel, inst: number, id: string, pin: string): string { return m.pinNet.get(inst + "|" + id + "#pin:" + pin) || ""; }
/** NETCHAIN_MANAGER::FindPotentialNetChainBetweenPins. */
export function potentialBetween(m: ChainModel, netA: string, netB: string): NetChain | null {
  if (!netA || !netB) return null;
  return m.potentials.find((p) => p.nets.includes(netA) && p.nets.includes(netB)) || null;
}
/** NETCHAIN_MANAGER::GetBridgeSymbols: the bridges joining the net to another net of the chain. */
export function bridgeSymbols(m: ChainModel, chain: NetChain, net: string): ChainSymbol[] {
  const out: ChainSymbol[] = [];
  if (!chain.nets.includes(net)) return out;
  for (const e of m.edges) {
    if (e.a !== net && e.b !== net) continue;
    const other = e.a === net ? e.b : e.a;
    if (chain.nets.includes(other) && !out.some((s) => s.file === e.file && s.id === e.id)) out.push({ inst: e.inst, file: e.file, id: e.id });
  }
  return out;
}
/** The pin of a symbol on a sheet instance as a terminal. */
export function chainPinOf(m: ChainModel, inst: number, id: string, pin: string): ChainPin | null {
  for (const sh of m.sheets) {
    if (sh.inst.index !== inst) continue;
    for (const s of sh.symbols) { if (s.item.id !== id) continue; const p = s.pins.find((x) => x.number === pin); if (p) return { inst, file: sh.inst.file, id, pin, ref: s.ref, x: p.x, y: p.y }; }
  }
  return null;
}
const samePin = (a: ChainPin | null, b: ChainPin | null): boolean => !!a && !!b && a.inst === b.inst && a.id === b.id && a.pin === b.pin;
/** Which terminal (0 / 1) of the chain the pin is, or -1. */
export function terminalIndex(c: NetChain, p: ChainPin | null): number { return samePin(c.termA, p) ? 0 : samePin(c.termB, p) ? 1 : -1; }
/** The saved entry a committed chain came from. */
export function savedOf(m: ChainModel, name: string): SavedChain | null { return m.saved.find((s) => s.name === name) || null; }
/**
 * NETCHAIN_MANAGER::ReplaceNetChainTerminalPin: the chain with one terminal moved to another pin on one of its nets.
 * null when the pin is on no member net, would make both terminals one pin, or does not resolve to a single pin.
 */
export function replaceTerminal(m: ChainModel, c: NetChain, endpoint: number, pin: ChainPin): [ChainTerminalRef, ChainTerminalRef] | null {
  if (endpoint < 0 || endpoint > 1) return null;
  if (!c.nets.includes(pinNetOf(m, pin.inst, pin.id, pin.pin))) return null;
  const a = endpoint === 0 ? pin : c.termA, b = endpoint === 1 ? pin : c.termB;
  if (!a || !b || samePin(a, b)) return null;
  return [{ ref: a.ref, pin: a.pin }, { ref: b.ref, pin: b.pin }];
}
/** The (net_chain …) a committed chain is written as (with its terminal references refreshed). */
export function committedNodeText(c: NetChain, change: { name?: string; termA?: ChainTerminalRef; termB?: ChainTerminalRef; netClass?: string; color?: [number, number, number, number] | null } = {}): string | null {
  const a = change.termA || (c.termA && { ref: c.termA.ref, pin: c.termA.pin }), b = change.termB || (c.termB && { ref: c.termB.ref, pin: c.termB.pin });
  if (!a || !b || !a.ref || !b.ref) return null;
  return chainNodeText({ name: change.name ?? c.name, from: a, to: b, netClass: change.netClass ?? c.netClass, color: change.color !== undefined ? change.color : c.color, nets: c.nets });
}
/** CreateNetChainFromPotential: the entry a new chain from a potential one is saved as. */
export function potentialNodeText(p: NetChain, name: string): string | null {
  if (!p.termA || !p.termB) return null;
  return chainNodeText({ name, from: { ref: p.termA.ref, pin: p.termA.pin }, to: { ref: p.termB.ref, pin: p.termB.pin }, nets: p.nets });
}
/** "#RRGGBBAA" (COLOR4D::ToHexString), the netlist's chain colour. */
export function colorHex(c: [number, number, number, number]): string {
  const h = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).toUpperCase().padStart(2, "0");
  return "#" + h(c[0]) + h(c[1]) + h(c[2]) + h(c[3] * 255);
}
export function colorCss(c: [number, number, number, number] | null): string | null { return c ? `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${c[3]})` : null; }

// ---------------------------------------------------------------- the netlist (NETLIST_EXPORTER_XML::makeNetChains)
export interface NetlistChain { name: string; netClass: string; chainClass: string; color: string; members: string[]; terminals: ChainTerminalRef[] }
/** The committed chains as the KiCad-internal netlist carries them to the board. */
export function netlistChains(m: ChainModel, chainClassOf: (name: string) => string): NetlistChain[] {
  return m.committed.map((c) => ({
    name: c.name, netClass: c.netClass, chainClass: chainClassOf(c.name) || "", color: c.color ? colorHex(c.color) : "",
    members: c.nets.filter(isPersistableNet),
    terminals: [c.termA, c.termB].filter((t): t is ChainPin => !!t && !!t.ref).map((t) => ({ ref: t.ref, pin: t.pin })),
  }));
}

// ---------------------------------------------------------------- the board's (net_chains …)
/** A board net's chain and terminal pads (NETINFO_ITEM::GetNetChain / GetTerminalPad). */
export interface BoardNetChain { chain: string; pads: [string | null, string | null] }
/** PCB_IO_KICAD_SEXPR_PARSER::parseNET_CHAINS_SECTION: net name -> its chain and terminal pad uuids. */
export function parseBoardChains(node: SNode | null | undefined, nets: Map<number, string>): Map<string, BoardNetChain> {
  const out = new Map<string, BoardNetChain>();
  if (!node) return out;
  const names = new Set(nets.values());
  for (const ch of kids(node, "net_chain")) {
    const nm = kid(ch, "name"), name = nm ? str(nm[1]) : "";
    const resolved: string[] = [];
    const codes: number[] = [], byName: string[] = [];
    const mem = kid(ch, "members");
    if (mem) for (const c of mem.slice(1)) {
      if (!Array.isArray(c)) continue;
      const take = (n: SNode): void => { const v = n[1]; if (typeof v === "number") codes.push(v); else byName.push(str(v)); };
      if (c[0] === "net") take(c as SNode);
      else if (c[0] === "member") { const n = kid(c as SNode, "net"); if (n) take(n); }
    }
    for (const code of codes) { const n = nets.get(code); if (n !== undefined) resolved.push(n); }
    for (const n of byName) if (names.has(n)) resolved.push(n);
    const pads = kids(ch, "terminal_pad").slice(0, 2).map((p) => str(p[1]));
    for (const n of resolved) {
      const cur = out.get(n) || { chain: "", pads: [null, null] as [string | null, string | null] };
      cur.chain = name;
      for (let i = 0; i < pads.length; i++) cur.pads[i] = pads[i];
      out.set(n, cur);
    }
  }
  return out;
}
/**
 * PCB_IO_KICAD_SEXPR::format's (net_chains …): the nets (in net-code order) grouped by chain, the groups sorted by
 * ValueStringCompare, each with its first terminal pad of either end; "" when there is nothing to write.  `padExists`
 * keeps only pads still on the board (NETINFO_ITEM::GetTerminalPad).
 */
export function boardChainsText(chains: Map<string, BoardNetChain>, netOrder: string[], padExists: (uuid: string) => boolean): string {
  const groups = new Map<string, { nets: string[]; pads: [string | null, string | null] }>();
  for (const net of netOrder) {
    const c = chains.get(net); if (!c) continue;
    const pads = c.pads.map((p) => (p && padExists(p) ? p : null));
    if (!c.chain && !pads[0] && !pads[1]) continue;
    const name = c.chain || net;
    let g = groups.get(name); if (!g) { g = { nets: [], pads: [null, null] }; groups.set(name, g); }
    g.nets.push(net);
    for (let i = 0; i < 2; i++) if (pads[i] && !g.pads[i]) g.pads[i] = pads[i];
  }
  const names = Array.from(groups.keys()).sort(valueStringCompare);
  const parts: string[] = [];
  for (const name of names) {
    const g = groups.get(name)!;
    if (g.nets.length === 1 && !g.pads[0] && !g.pads[1] && !name) continue;
    let s = `(net_chain (name ${quote(name)}) (members` + g.nets.map((n) => ` (net ${quote(n)})`).join("") + ")";
    for (const p of g.pads) if (p) s += ` (terminal_pad ${quote(p)})`;
    parts.push(s + ")");
  }
  return parts.length ? "(net_chains " + parts.join(" ") + ")" : "";
}
/** The nets of a board chain, in net-code order. */
export function boardChainNets(chains: Map<string, BoardNetChain>, name: string, netOrder: string[]): string[] {
  if (!name) return [];
  return netOrder.filter((n) => { const c = chains.get(n); return !!c && c.chain === name; });
}

export const netChains = {
  isValidName, isPersistableNet, valueStringCompare, savedChains, parseChainNode, chainNodeText, chainNode, savedNodeText, buildChains, chainForNet, chainByName,
  pinNetOf, potentialBetween, bridgeSymbols, chainPinOf, terminalIndex, savedOf, replaceTerminal, committedNodeText, potentialNodeText, colorHex, colorCss,
  netlistChains, parseBoardChains, boardChainsText, boardChainNets, passthroughMode, SYNTHETIC_NET_PREFIX,
};
