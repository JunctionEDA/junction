// SCH_CONNECTION::IsBusLabel: is a label's (unescaped) text a bus name, a vector (PREFIX[n..m]) or a group
// (NAME{A B C})?  Ports of NET_SETTINGS::ParseBusVector / ParseBusGroup (common/project/net_settings.cpp), only the
// yes / no answer: the member lists are not built here.
import { unescapeText } from "./text";

const isSuperSubOverbar = (c: string): boolean => c === "_" || c === "^" || c === "~";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
/** An odd run of backslashes before aPos escapes the character there. */
function isEscaped(s: string, pos: number): boolean {
  let n = 0; while (pos > 0 && s[pos - 1] === "\\") { n++; pos--; }
  return n % 2 === 1;
}

/** NET_SETTINGS::ParseBusVector( aBus, nullptr, nullptr ). */
export function isBusVector(bus: string): boolean {
  const len = bus.length; let i = 0, nest = 0, inQuotes = false, prefix = "", tmp = "", begin = 0, end = 0, parsedEnd = false;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === '"' && !isEscaped(bus, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) prefix += bus[++i]; else prefix += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(bus[i - 1])) { nest++; prefix += "{"; continue; } return false; }
    if (c === "}") { nest--; prefix += "}"; continue; }
    if (c === "\\" && i + 1 < len && bus[i + 1] === " ") { prefix += bus[++i]; continue; }
    if (c === " " || c === "]") return false;
    if (c === "[") break;
    prefix += c;
  }
  i++;                                                    // '['
  if (i >= len) return false;
  for (; i < len; ++i) {
    if (bus[i] === "." && i + 1 < len && bus[i + 1] === ".") { if (!tmp) return false; begin = parseInt(tmp, 10); i += 2; break; }
    if (!isDigit(bus[i])) return false;
    tmp += bus[i];
  }
  tmp = "";
  if (i >= len) return false;
  for (; i < len; ++i) {
    if (bus[i] === "]") { if (!tmp) return false; end = parseInt(tmp, 10); parsedEnd = true; ++i; break; }
    if (!isDigit(bus[i])) return false;
    tmp += bus[i];
  }
  if (!parsedEnd) return false;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === "}") nest--;
    else if (c !== "+" && c !== "-" && c !== "P" && c !== "N") return false;
  }
  if (nest !== 0) return false;
  return begin !== end;
}

/** NET_SETTINGS::ParseBusGroup( aGroup, nullptr, nullptr ). */
export function isBusGroup(group: string): boolean {
  const len = group.length; let i = 0, nest = 0, inQuotes = false;
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) ++i; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; continue; } break; }
    if (c === "}") { nest--; continue; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { ++i; continue; }
    if (c === " " || c === "[" || c === "]") return false;
  }
  if (nest !== 0) return false;
  i++;                                                    // '{'
  if (i >= len) return false;
  inQuotes = false;
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) ++i; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; continue; } return false; }
    if (c === "}") { if (nest) { nest--; continue; } return true; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { ++i; continue; }
  }
  return false;
}

const CACHE = new Map<string, boolean>();
/** SCH_CONNECTION::IsBusLabel( text ): the text is unescaped ({slash} → / …) first. */
export function isBusLabel(text: string): boolean {
  let v = CACHE.get(text);
  if (v === undefined) {
    const u = unescapeText(text);
    v = isBusVector(u) || isBusGroup(u);
    if (CACHE.size > 4096) CACHE.clear();
    CACHE.set(text, v);
  }
  return v;
}

/** NET_SETTINGS::ParseBusVector( aBus, &name, &members ): the prefix and the members, lowest index first (a
 *  reversed range is swapped, zero padding is kept, a +-PN suffix rides along); null when the text is no vector. */
export function parseBusVector(bus: string): { prefix: string; members: string[] } | null {
  const len = bus.length; let i = 0, nest = 0, inQuotes = false, prefix = "", suffix = "", tmp = "", begin = 0, end = 0, parsedEnd = false, fmtWrapsName = false, padded = false, width = 0;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === '"' && !isEscaped(bus, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) prefix += bus[++i]; else prefix += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(bus[i - 1])) { nest++; prefix += "{"; continue; } return null; }
    if (c === "}") { nest--; prefix += "}"; continue; }
    if (c === "\\" && i + 1 < len && bus[i + 1] === " ") { prefix += bus[++i]; continue; }
    if (c === " " || c === "]") return null;
    if (c === "[") {
      if (nest > 0) {
        const fmtStart = prefix.lastIndexOf("{");
        if (fmtStart > 0 && isSuperSubOverbar(prefix[fmtStart - 1])) {
          if (fmtStart === prefix.length - 1) prefix = prefix.slice(0, fmtStart - 1);   // D_{[1..2]}: the formatting decorates the range
          else fmtWrapsName = true;                                                       // ~{BE[0..3]}: it wraps the name
        }
      }
      break;
    }
    prefix += c;
  }
  i++;                                                    // '['
  if (i >= len) return null;
  for (; i < len; ++i) {
    if (bus[i] === "." && i + 1 < len && bus[i + 1] === ".") { if (!tmp) return null; begin = parseInt(tmp, 10); width = tmp.length; padded = width > 1 && tmp[0] === "0"; i += 2; break; }
    if (!isDigit(bus[i])) return null;
    tmp += bus[i];
  }
  tmp = "";
  if (i >= len) return null;
  for (; i < len; ++i) {
    if (bus[i] === "]") { if (!tmp) return null; end = parseInt(tmp, 10); padded = padded || (tmp.length > 1 && tmp[0] === "0"); width = Math.max(width, tmp.length); parsedEnd = true; ++i; break; }
    if (!isDigit(bus[i])) return null;
    tmp += bus[i];
  }
  if (!parsedEnd) return null;
  for (; i < len; ++i) {
    const c = bus[i];
    if (c === "}") { nest--; if (fmtWrapsName) suffix += c; }
    else if (c === "+" || c === "-" || c === "P" || c === "N") suffix += c;
    else return null;
  }
  if (nest !== 0) return null;
  if (begin === end) return null;
  if (begin > end) { const t = begin; begin = end; end = t; }
  const members: string[] = [];
  for (let idx = begin; idx <= end && members.length <= 65536; ++idx) { const number = String(idx); members.push(prefix + (padded && number.length < width ? "0".repeat(width - number.length) : "") + number + suffix); }
  return { prefix, members };
}

/** EscapeString( …, CTX_NETNAME ) as far as bus members need it. */
const escNet = (s: string): string => s.replace(/\//g, "{slash}").replace(/[\r\n]/g, "");
/** NET_SETTINGS::ParseBusGroup( aGroup, &name, &members ): the group's name ("" for {A B}) and its member texts
 *  (spaces inside a member re-escaped, each escaped as a net name); null when the text is no group. */
export function parseBusGroup(group: string): { prefix: string; members: string[] } | null {
  const len = group.length; let i = 0, nest = 0, inQuotes = false, prefix = "", tmp = "";
  const push = (out: string[]): void => { if (tmp) out.push(escNet(tmp.replace(/ /g, "\\ "))); };
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) prefix += group[++i]; else prefix += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; prefix += "{"; continue; } break; }
    if (c === "}") { nest--; prefix += "}"; continue; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { prefix += group[++i]; continue; }
    if (c === " " || c === "[" || c === "]") return null;
    prefix += c;
  }
  if (nest !== 0) return null;
  i++;                                                    // '{'
  if (i >= len) return null;
  inQuotes = false;
  const members: string[] = [];
  for (; i < len; ++i) {
    const c = group[i];
    if (c === '"' && !isEscaped(group, i)) { inQuotes = !inQuotes; continue; }
    if (inQuotes) { if (c === "\\" && i + 1 < len) tmp += group[++i]; else tmp += c; continue; }
    if (c === "{") { if (i > 0 && isSuperSubOverbar(group[i - 1])) { nest++; tmp += "{"; continue; } return null; }
    if (c === "}") { if (nest) { nest--; tmp += "}"; continue; } push(members); return { prefix, members }; }
    if (c === "\\" && i + 1 < len && group[i + 1] === " ") { tmp += group[++i]; continue; }
    if (c === " " || c === ",") { push(members); tmp = ""; continue; }
    tmp += c;
  }
  return null;
}

/** The project's bus aliases by name (SCHEMATIC::GetBusAlias): each one's member texts. */
export type BusAliases = Map<string, string[]> | Record<string, string[]> | null | undefined;
function aliasOf(aliases: BusAliases, name: string): string[] | null {
  if (!aliases) return null;
  const m = aliases instanceof Map ? aliases.get(name) : Object.prototype.hasOwnProperty.call(aliases, name) ? (aliases as Record<string, string[]>)[name] : undefined;
  return Array.isArray(m) ? m : null;
}
/**
 * One net member of a bus connection (SCH_CONNECTION::ConfigureFromLabel, nested vectors flattened): its local name
 * (LocalName), its name with the group's prefix (FullLocalName, "NAME.A"), its index in its own vector (VectorIndex,
 * 0 outside one) and whether it came out of a vector nested in a group.
 */
export interface BusMember { local: string; full: string; vectorIndex: number; nested: boolean }
export interface BusConnection { type: "vector" | "group"; prefix: string; members: BusMember[]; /** the aliases the group names, with their members */ aliases: { name: string; members: string[] }[] }
/** SCH_CONNECTION::ConfigureFromLabel for a bus label: null when the (escaped) text is a plain net name. */
export function busConnection(label: string, aliases?: BusAliases, depth = 0): BusConnection | null {
  const u = unescapeText(label);
  const v = parseBusVector(u);
  if (v) return { type: "vector", prefix: v.prefix, aliases: [], members: v.members.map((m, k) => { const e = escNet(m); return { local: e, full: e, vectorIndex: k, nested: false }; }) };
  const g = parseBusGroup(u); if (!g) return null;
  const prefix = g.prefix ? g.prefix + "." : "", out: BusConnection = { type: "group", prefix: g.prefix, members: [], aliases: [] };
  const member = (text: string): void => {
    const sub = depth < 8 ? busConnection(text, aliases, depth + 1) : null;
    if (!sub) { out.members.push({ local: text, full: prefix + text, vectorIndex: 0, nested: false }); return; }
    for (const m of sub.members) out.members.push({ local: m.local, full: prefix + m.full, vectorIndex: m.vectorIndex, nested: true });
    out.aliases.push(...sub.aliases);
  };
  for (const gm of g.members) {
    const al = aliasOf(aliases, gm);
    if (al) { out.aliases.push({ name: gm, members: al.slice() }); for (const am of al) member(escNet(am)); }
    else member(gm);
  }
  return out;
}
/**
 * CONNECTION_GRAPH::matchBusMember: the index in `bus`'s members that `search` (a member of another label on the same
 * bus) stands for: a vector pairs by index (the names may differ), a group by local name and then by flattened index.
 */
export function matchBusMember(bus: BusConnection, search: BusMember): number {
  if (bus.type === "vector") return bus.members.findIndex((m) => m.vectorIndex === search.vectorIndex);
  const byName = bus.members.findIndex((m) => m.local === search.local);
  if (byName >= 0) return byName;
  return search.vectorIndex >= 0 && search.vectorIndex < bus.members.length ? search.vectorIndex : -1;
}
/** The net names a bus label stands for, in order ("NAME.A", "D0" …): [] when the text is no bus. */
export function busMemberNames(label: string, aliases?: BusAliases): string[] { const c = busConnection(label, aliases); return c ? c.members.map((m) => m.full) : []; }
