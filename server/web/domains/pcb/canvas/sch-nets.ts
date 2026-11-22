// kicad-canvas / sch-nets — the schematic's nets across the whole hierarchy, for the net highlight and the Net
// Navigator: eeschema keeps the highlighted connection as a NAME (SCH_EDIT_FRAME::SetHighlightedConnection) and
// collects the items of that net on whichever sheet is on screen (NAVIGATION_QUERY::CollectNetItems, called from
// SCH_EDITOR_CONTROL::UpdateNetHighlighting).  The net map itself comes from pcb-netlist.ts buildNetlist (the
// CONNECTION_GRAPH naming rules); this module turns it into highlight keys, looks a name up from a picked item,
// and words the navigator's items the way eeschema/net_navigator.cpp does.
//
// Pure functions over parsed documents, exposed as KiCadCanvas.schNets for the node tests.
import { unescapeNetName, type NetEntry, type NetMember, type SheetInstance } from "./pcb-netlist";
import { atOf, kid, num, ptsOf, str } from "./sexpr";
import { geomBox } from "./hit";
import type { Geom } from "./types";

export type NetMap = Map<string, NetEntry>;

/**
 * The highlight keys of one member: a pin is "symbolId#pin:<number>" (SCH_PAINTER brightens single pins), a
 * sheet pin "sheetId#pin:<name>", everything else its own id.  A power symbol on the net also brightens its
 * Reference and Value fields (UpdateNetHighlighting: powerHighlight; the renderer draws only visible fields).
 */
export function memberKeys(m: NetMember): string[] {
  if (m.kind === "pin") return m.power ? [m.id + "#pin:" + m.pin, m.id + "#field:Reference", m.id + "#field:Value"] : [m.id + "#pin:" + m.pin];
  if (m.kind === "sheet_pin") return [m.id + "#pin:" + m.pin];
  return [m.id];
}

/**
 * NAVIGATION_QUERY::CollectNetItems( name, sheet, …, highlightBusMembers ): the keys of the items of net `name` on
 * sheet instance `inst`.  With `busMembers` a bus brings the nets of its members along.
 */
export function collectKeys(map: NetMap, name: string | null, inst: number, busMembers = false): Set<string> {
  const out = new Set<string>(); if (!name) return out;
  const take = (e: NetEntry | undefined): void => { if (e) for (const m of e.members) if (m.inst === inst) for (const k of memberKeys(m)) out.add(k); };
  const e = map.get(name); take(e);
  if (e && e.bus && busMembers) for (const n of e.busMembers) take(map.get(n));
  return out;
}

/** "<inst>|<id>" and "<inst>|<id>#pin:<pin>" -> net name: what GetConnectionName answers for an item on a sheet. */
export function nameIndex(map: NetMap): Map<string, string> {
  const idx = new Map<string, string>();
  for (const e of map.values()) for (const m of e.members) {
    const key = m.inst + "|" + m.id + (m.kind === "pin" || m.kind === "sheet_pin" ? "#pin:" + m.pin : "");
    // a net wins over the bus a line also belongs to only when nothing named it yet
    if (!idx.has(key) || (idx.get(key) !== e.name && !e.bus)) idx.set(key, e.name);
  }
  return idx;
}

/** The sheet instance a document shows: the one at `human` when it holds `file`, else the first instance of `file`. */
export function instanceFor(instances: SheetInstance[], file: string, human?: string | null): SheetInstance | null {
  const mine = instances.filter((i) => i.file === file);
  return (human ? mine.find((i) => i.human === human) : undefined) || mine[0] || null;
}

/**
 * MakeNetNavigatorNode's sheet node text: the top-level sheet's name (the root file's name when it has none),
 * then "/" and each sub-sheet's name.
 */
export function sheetNodeText(inst: SheetInstance, rootName: string, instances?: SheetInstance[]): string {
  // with several top-level sheets each instance's path already starts at its top-level sheet (sheetPath.at( 0 )'s
  // Sheetname, the file's base name when that is empty); with one root the path starts below it
  const tops = instances ? instances.filter((i) => i.uuidPath.length === 1) : [];
  if (tops.length > 1) {
    const top = tops.find((t) => t.uuidPath[0] === inst.uuidPath[0]);
    if (top && top.sheetName) return inst.human.replace(/^\//, "").replace(/\/$/, "");
    const stem = top ? (top.file.split("/").pop() || top.file).replace(/\.kicad_sch$/, "") : rootName;
    return [stem, ...inst.human.split("/").filter(Boolean)].join("/");
  }
  const parts = inst.human.split("/").filter(Boolean);
  return [rootName, ...parts].join("/");
}
/** GetBoundingBox().Centre() of a set of drawn primitives; null when there are none. */
function centreOf(geoms: Geom[]): [number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of geoms) { const b = geomBox(g); if (!b) continue; if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3]; }
  return x0 <= x1 && y0 <= y1 ? [(x0 + x1) / 2, (y0 + y1) / 2] : null;
}

export interface NavItem { inst: number; id: string; kind: string; pin?: string; label: string; at: [number, number] | null }
export interface NavSheet { inst: number; label: string; items: NavItem[] }
export type Fmt = (v: number) => string;

const pt = (f: Fmt, p: number[] | undefined | null): string => `(${f(p ? p[0] : 0)}, ${f(p ? p[1] : 0)})`;
/** GetNetNavigatorItemText: KiCad's wording of a net item (positions in the user's units). */
export function describeMember(m: NetMember, doc: KDoc | null, f: Fmt): { label: string; at: [number, number] | null } {
  const it = doc ? doc.items.get(m.id) : null, n = it ? it.node : null;
  const at = n ? (atOf(n) as number[]).slice(0, 2) as [number, number] : null;
  // onNetNavigatorSelection: FocusOnLocation( item->GetBoundingBox().Centre() ) of the pin / sheet pin / label ITSELF
  const geoms = ((it as unknown as { geom?: Geom[] } | null) || {}).geom || [];
  const own = (): [number, number] | null => centreOf(geoms) || at;
  switch (m.kind) {
    case "pin": {
      const shown = m.pinName && m.pinName !== "~" ? unescapeNetName(m.pinName) : "";
      return { label: `Symbol '${m.ref || "?"}' pin '${unescapeNetName(m.pin || "")}'` + (shown ? ` (${shown})` : ""), at: centreOf(geoms.filter((g) => g.pinNo === m.pin)) || at };
    }
    case "sheet_pin": {
      const pin = n ? (n.filter((c) => Array.isArray(c) && c[0] === "pin" && str((c as SNode)[1]) === m.pin)[0] as SNode | undefined) : undefined;
      return { label: `Sheet '${m.text || ""}' pin '${unescapeNetName(m.pin || "")}'`, at: centreOf(geoms.filter((g) => g.pinNo === m.pin)) || (pin ? (atOf(pin) as number[]).slice(0, 2) as [number, number] : at) };
    }
    case "label": return { label: `Label '${unescapeNetName(m.text || "")}' at ${pt(f, at)}`, at: own() };
    case "global_label": return { label: `Global label '${unescapeNetName(m.text || "")}' at ${pt(f, at)}`, at: own() };
    case "hierarchical_label": return { label: `Hierarchical label '${unescapeNetName(m.text || "")}' at ${pt(f, at)}`, at: own() };
    case "netclass_flag": case "directive_label": return { label: `Netclass label '${unescapeNetName(m.text || (n ? str(n[1]) : ""))}' at ${pt(f, at)}`, at: own() };
    case "junction": return { label: `Junction at ${pt(f, at)}`, at };
    case "no_connect": return { label: `No-Connect at ${pt(f, at)}`, at };
    case "wire": case "bus": { const p = n ? ptsOf(n) as number[][] : []; return { label: `${m.kind === "wire" ? "Wire" : "Bus"} from ${pt(f, p[0])} to ${pt(f, p[p.length - 1])}`, at: p[0] ? [p[0][0], p[0][1]] : null }; }
    case "bus_entry": { const s = n ? kid(n, "size") as SNode | null : null; const e = at ? [at[0] + num(s ? s[1] : 0), at[1] + num(s ? s[2] : 0)] : null; return { label: `Bus to wire entry from ${pt(f, at)} to ${pt(f, e)}`, at }; }
    default: return { label: m.kind, at };
  }
}

/** Items MakeNetNavigatorNode leaves out of the tree: lines, junctions and bus entries. */
const NOT_LISTED = new Set(["wire", "bus", "junction", "bus_entry"]);
const byText = (a: { label: string }, b: { label: string }): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);   // wxTreeCtrl::SortChildren: plain string order

/** One net's navigator children: a node per sheet instance holding the net, each with its items, both sorted. */
export function navSheets(map: NetMap, name: string, instances: SheetInstance[], rootName: string, docOf: (inst: SheetInstance) => KDoc | null, f: Fmt): NavSheet[] {
  const e = map.get(name); if (!e) return [];
  const per = new Map<number, NavItem[]>();
  // NAVIGATION_QUERY::NetItems( name, aIncludeBusParents = true ): the items of the buses that carry the net as well
  // (their labels and sheet pins show under the net)
  const members = e.members.slice();
  if (!e.bus) for (const b of map.values()) if (b.bus && b.busMembers.includes(name)) members.push(...b.members);
  const seen = new Set<string>();
  for (const m of members) {
    const mk = m.inst + "|" + m.id + "|" + m.kind + "|" + (m.pin || "");
    if (seen.has(mk)) continue; seen.add(mk);
    if (!per.has(m.inst)) per.set(m.inst, []);
    if (NOT_LISTED.has(m.kind)) continue;
    const inst = instances[m.inst]; const d = describeMember(m, inst ? docOf(inst) : null, f);
    (per.get(m.inst) as NavItem[]).push({ inst: m.inst, id: m.id, kind: m.kind, pin: m.pin, label: d.label, at: d.at });
  }
  const out: NavSheet[] = [];
  for (const [i, items] of per) { const inst = instances[i]; if (!inst) continue; out.push({ inst: i, label: sheetNodeText(inst, rootName, instances), items: items.sort(byText) }); }
  return out.sort(byText);
}

/**
 * NAVIGATION_QUERY::NetNames: every non-empty key of the connection graph's net map, the buses among them (the "Nets"
 * root lists them), sorted by the name shown.  `buses` false leaves the buses out (the netclass assignment candidates).
 */
export function netNames(map: NetMap, buses = true): string[] {
  return Array.from(map.values()).filter((e) => buses || !e.bus).map((e) => e.name).sort((a, b) => { const x = unescapeNetName(a), y = unescapeNetName(b); return x < y ? -1 : x > y ? 1 : 0; });
}

/** WildCompareString( pattern, text, caseSensitive = false ): * matches any run, ? any one character. */
export function wildCompare(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase(), t = text.toLowerCase();
  let pi = 0, ti = 0, star = -1, mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) { pi++; ti++; }
    else if (pi < p.length && p[pi] === "*") { star = pi++; mark = ti; }
    else if (star >= 0) { pi = star + 1; ti = ++mark; }
    else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}
/**
 * The navigator's filter (RefreshNetNavigator): in wildcard mode a pattern without * or ? matches as a substring
 * ("*" + filter + "*"); in regex mode an invalid expression filters nothing.
 */
export function netFilter(filter: string, wildcard = true): (displayName: string) => boolean {
  if (!filter) return () => true;
  if (wildcard) { const glob = /[*?]/.test(filter) ? filter : "*" + filter + "*"; return (n) => wildCompare(glob, n); }
  let re: RegExp | null = null; try { re = new RegExp(filter, "i"); } /* std::regex_constants::icase | ECMAScript */ catch (e) { re = null; }
  return re ? (n) => (re as RegExp).test(n) : () => true;
}

/** UpdateNetHighlightStatus: "Highlighted net: <name>" (unescaped), empty when nothing is highlighted. */
export function highlightStatus(name: string | null): string { return name ? `Highlighted net: ${unescapeNetName(name)}` : ""; }

export const schNets = { memberKeys, collectKeys, nameIndex, instanceFor, sheetNodeText, describeMember, navSheets, netNames, wildCompare, netFilter, highlightStatus };
