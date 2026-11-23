// pcb-tools/reannotate.ts — Tools > Geographical Reannotate... (DIALOG_BOARD_REANNOTATE::ReannotateBoard): the
// footprints of each side sorted by their (grid-rounded) location in one of eight directions, then renumbered per
// reference prefix, with the change log and the problems the dialog's report shows.  Footprints of reused sheets keep
// their sheet's Reference Suffix after the new number, and the copies that share a base are renumbered together
// (ref_suffix_split.cpp, from the schematic's MAIL_SCH_GET_REF_SUFFIXES table).
import type { BoardDoc, PcbChange } from "./types";
import { replacedChange } from "./changes";
import { K } from "./state";
import { clone } from "./util";

export interface ReannotateOpts {
  /** 0..7: the direction radio buttons in the dialog's order (m_sortButtons) */
  sortCode: number;
  /** "Based on location of:" Footprint (true) or Reference */
  useFootprintLocation: boolean;
  /** "Round locations to:" grid, mm */
  grid: number;
  scope: "all" | "front" | "back" | "selection";
  selected?: Set<string> | null;
  excludeLocked: boolean;
  /** "Exclude references:" (R means R*; R* matches like wxString::Matches) */
  exclude: string;
  frontStart: string; backStart: string; frontPrefix: string; backPrefix: string; removeFrontPrefix: boolean; removeBackPrefix: boolean;
  /** MessageTextFromValue for the report's coordinates */
  fmt?(mm: number): string;
  /** the schematic's reply to MAIL_SCH_GET_REF_SUFFIXES (FormatRefSuffixes), or null without a schematic */
  suffixes?: string | null;
  /** schematic.annotation.reused_sheet_suffixes of the project */
  suffixMode?: boolean;
}
export type ReportSeverity = "info" | "action" | "warning" | "error";
export interface ReannotatePlan {
  ok: boolean;
  /** footprints with an empty or invalid reference (ReannotateBoard asks "Reannotate anyway?") */
  bad: { ref: string; fpid: string; x: number; y: number }[];
  report: { severity: ReportSeverity; text: string }[];
  changes: PcbChange[];
  /** old -> new for the footprints that change */
  renames: { id: string; from: string; to: string }[];
}

const SORTYFIRST = 0x100, DESCENDINGFIRST = 0x10, DESCENDINGSECOND = 0x1, SORTXFIRST = 0, ASCENDINGFIRST = 0, ASCENDINGSECOND = 0;
const FRONT_DIRS = [SORTYFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTYFIRST + ASCENDINGFIRST + DESCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + ASCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + DESCENDINGSECOND,
  SORTXFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + ASCENDINGFIRST + DESCENDINGSECOND, SORTXFIRST + DESCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + DESCENDINGFIRST + DESCENDINGSECOND];
const BACK_DIRS = [SORTYFIRST + ASCENDINGFIRST + DESCENDINGSECOND, SORTYFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + DESCENDINGSECOND, SORTYFIRST + DESCENDINGFIRST + ASCENDINGSECOND,
  SORTXFIRST + DESCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + DESCENDINGFIRST + DESCENDINGSECOND, SORTXFIRST + ASCENDINGFIRST + ASCENDINGSECOND, SORTXFIRST + ASCENDINGFIRST + DESCENDINGSECOND];
const MINGRID = 1000, MAXERROR = 10;
enum Action { UPDATE, EMPTY, INVALID, EXCLUDE, UNKNOWN_SUFFIX }
const ACTION_MESSAGE = ["", "(not updated)", "(unannotated; not updated)", "(excluded)", "(unknown suffix; not updated)"];

interface Info { id: string; ref: string; fpid: string; x: number; y: number; rx: number; ry: number; front: boolean; action: Action; prefix: string; suffix: string; representative: string; shared: boolean; held: boolean }

// ---------------------------------------------------------------- ref_suffix_split.cpp
/** SHEET_REF_SUFFIX: a sheet path's composed suffix and its rank in page order. */
export interface SheetRefSuffix { rank: number; suffix: string }
const MAIL_SCH_REF_SUFFIXES_TAG = "ref_suffixes";
/** ParseRefSuffixes: the MAIL_SCH_GET_REF_SUFFIXES reply by sheet path (or footprint path), or null when it is not one. */
export function parseRefSuffixes(payload: string): Map<string, SheetRefSuffix> | null {
  const lines = payload.split("\n");
  if (lines[0] !== MAIL_SCH_REF_SUFFIXES_TAG) return null;
  const out = new Map<string, SheetRefSuffix>(); let rank = 0;
  for (const line of lines.slice(1)) {
    const tab = line.indexOf("\t"); if (tab < 0) continue;
    out.set(line.slice(0, tab), { rank: rank++, suffix: line.slice(tab + 1) });
  }
  return out;
}
/** FOOTPRINT_REF_SPLIT. */
export interface RefSplit { base: string; suffix: string; representative: string; unknown: boolean; shared: boolean }
/**
 * SplitRefSuffixes: each footprint's reference split into the base and its sheet's suffix (a package spanning sheets
 * names its own), the copies of a reused sheet's symbol grouped under the copy of the earliest sheet when a suffix
 * tells them apart; a reference whose text after the number no known suffix accounts for is "unknown".
 */
export function splitRefSuffixes(fps: { id: string; ref: string; path: string }[], suffixes: Map<string, SheetRefSuffix> | null, suffixMode: boolean): Map<string, RefSplit> {
  const splits = new Map<string, RefSplit>(), groups = new Map<string, { rank: number; representative: string; suffixed: boolean }>(), grouped = new Set<string>();
  const segs = (p: string): string[] => p.split("/").filter(Boolean);
  const groupKey = (fp: { path: string }, sp: RefSplit): string => (segs(fp.path).pop() || "") + "\0" + sp.base;
  for (const fp of fps) {
    const sp: RefSplit = { base: fp.ref, suffix: "", representative: fp.id, unknown: false, shared: false }; splits.set(fp.id, sp);
    const sheet = segs(fp.path); let entry: SheetRefSuffix | undefined;
    if (suffixes && sheet.length) {
      // a package spanning sheets names its own suffix, which can differ from its sheet's
      entry = suffixes.get("/" + sheet.join("/"));
      if (!entry) { sheet.pop(); entry = suffixes.get(sheet.map((x) => "/" + x).join("") + "/"); }
    }
    // with no schematic to ask, a numeric suffix cannot be told from part of the number
    if (!suffixes && suffixMode && segs(fp.path).length > 1) { sp.unknown = true; continue; }
    const suffix = entry ? entry.suffix : "", ref = fp.ref;
    if (suffix && (ref.length <= suffix.length || !ref.endsWith(suffix))) { sp.unknown = true; continue; }
    const base = ref.slice(0, ref.length - suffix.length), firstDigit = base.search(/[0-9]/);
    // unannotated and empty references are not renumbered, so they need no split
    if (firstDigit < 0) continue;
    // text after the number that no suffix accounts for would be dropped by renumbering
    if (/[^0-9]/.test(base.slice(firstDigit))) { sp.unknown = true; continue; }
    if (!entry) continue;
    sp.base = base; sp.suffix = suffix; grouped.add(fp.id);
    const k = groupKey(fp, sp); let g = groups.get(k);
    if (!g) { g = { rank: entry.rank, representative: fp.id, suffixed: false }; groups.set(k, g); }
    else if (entry.rank < g.rank) { g.rank = entry.rank; g.representative = fp.id; }
    g.suffixed = g.suffixed || !!suffix;
  }
  // copies share a base only where a suffix tells them apart, since equal bare references are duplicates
  for (const fp of fps) {
    const sp = splits.get(fp.id)!; if (!grouped.has(fp.id)) continue;
    const g = groups.get(groupKey(fp, sp)); if (g && g.suffixed) { sp.representative = g.representative; sp.shared = true; }
  }
  return splits;
}
interface PrefixInfo { prefix: string; last: number; unavailable: Set<number> }

const nm = (mm: number): number => Math.round(mm * 1e6);
/** RoundToGrid, in nm like the board's internal units. */
function roundToGrid(c: number, grid: number): number {
  if (!grid) grid = MINGRID;
  const r = c % grid; c -= r;
  if (Math.abs(r) > grid / 2) c += c < 0 ? -grid : grid;
  return c;
}
/** StrNumCmp: digit runs compare as numbers; other characters one by one, upper-cased unless caseSensitive
 *  (CMP_T::CASE_SENSITIVE compares them as they are). */
export function strNumCmp(a: string, b: string, caseSensitive = false): number {
  let i = 0, j = 0; const dig = (c: string): boolean => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1 = a[i], c2 = b[j];
    if (dig(c1) && dig(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && dig(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && dig(b[j]));
      if (n1 !== n2) return n1 < n2 ? -1 : 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (!caseSensitive) { if (c1 !== c2) { const u1 = c1.toUpperCase(), u2 = c2.toUpperCase(); if (u1 !== u2) return u1 < u2 ? -1 : 1; } }
    else if (c1 !== c2) return c1 < c2 ? -1 : 1;
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  return i >= a.length && j < b.length ? -1 : i < a.length && j >= b.length ? 1 : 0;
}
/** wxString::Matches: * and ? wildcards over the whole string. */
const matches = (s: string, pat: string): boolean => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$").test(s);
const refDesNumber = (r: string): number => { const m = /\d+/.exec(r); return m ? Number(m[0]) : -1; };
function refField(n: SNode): SNode | null {
  for (const c of n) if (Array.isArray(c) && ((c[0] === "property" && K.str(c[1]) === "Reference") || (c[0] === "fp_text" && K.str(c[1]) === "reference"))) return c as SNode;
  return null;
}
function scaleOf(n: SNode): [number, number] { const t = K.kid(n, "transform"), sc = t && K.kid(t, "scale"); return sc ? [K.num(sc[1], 1) || 1, K.num(sc[2], 1) || 1] : [1, 1]; }
const isLocked = (n: SNode): boolean => n.includes("locked") || (() => { const l = K.kid(n, "locked"); return !!l && K.str(l[1]) !== "no"; })();

export function geographicalReannotate(doc: BoardDoc, o: ReannotateOpts): ReannotatePlan {
  const report: ReannotatePlan["report"] = [], show = (severity: ReportSeverity, text: string): void => { for (const t of text.split("\n")) report.push({ severity, text: t }); };
  const fmt = o.fmt || ((v: number) => v.toFixed(4) + " mm");
  const coord = (x: number, y: number): string => `${fmt(x / 1e6)}, ${fmt(y / 1e6)}`;
  const excludes = o.exclude.split(/[,\s]+/).filter(Boolean);
  const grid = nm(o.grid);
  const front: Info[] = [], back: Info[] = [];
  const fps = Array.from(doc.items.values()).filter((it) => it.kind === "footprint");
  const refOf = (n: SNode): string => { const rf = refField(n); return rf && !Array.isArray(rf[2]) ? K.str(rf[2]) : ""; };
  const pathOf = (n: SNode): string => { const p = K.kid(n, "path"); return p ? K.str(p[1]) : ""; };
  // a standalone board has no schematic to name the suffixes, so suffixed references stay as they are
  const splits = splitRefSuffixes(fps.map((fp) => ({ id: fp.id, ref: refOf(fp.node), path: pathOf(fp.node) })), o.suffixes ? parseRefSuffixes(o.suffixes) : null, !!o.suffixMode);
  // BuildFootprintList
  for (const fp of fps) {
    // GetPosition(): (at x y a), or the (transform (translate x y) (rotate a) (scale sx sy)) KiCad 10 writes
    const n = fp.node, [fx, fy, rot] = K.atOf(n), [sx, sy] = scaleOf(n);
    const rf = refField(n), ref = rf && !Array.isArray(rf[2]) ? K.str(rf[2]) : "";
    let x = fx, y = fy;
    if (!o.useFootprintLocation && rf) {
      // Reference().GetPosition(): the field's footprint-relative (at …) through the footprint's scale and rotation
      const ra = K.kid(rf, "at"); if (ra) { const r = rot * Math.PI / 180, lx = K.num(ra[1]) * sx, ly = K.num(ra[2]) * sy; x = fx + lx * Math.cos(r) + ly * Math.sin(r); y = fy - lx * Math.sin(r) + ly * Math.cos(r); }
    }
    const layer = K.kid(n, "layer"), isFront = !layer || K.str(layer[1]) === "F.Cu";
    const sp = splits.get(fp.id)!;
    const info: Info = { id: fp.id, ref, fpid: K.str(n[1]), x: nm(x), y: nm(y), rx: roundToGrid(nm(x), grid), ry: roundToGrid(nm(y), grid), front: isFront, action: Action.UPDATE, prefix: "",
      suffix: sp.suffix, representative: sp.representative, shared: sp.shared, held: isLocked(n) && o.excludeLocked };
    let firstnum = -1;
    if (!ref) info.action = Action.EMPTY;
    else { firstnum = ref.search(/\d/); if (firstnum < 0) info.action = Action.INVALID; }
    info.prefix = firstnum < 0 ? ref : ref.slice(0, firstnum);
    for (const ex of excludes) {
      if (ex.endsWith("*") ? matches(ref, ex) : ex === info.prefix) { info.action = Action.EXCLUDE; info.held = true; break; }
    }
    const outOfScope = (isLocked(n) && o.excludeLocked) || (o.scope === "selection" && !(o.selected && o.selected.has(fp.id))) || (o.scope === "front" && !isFront) || (o.scope === "back" && isFront);
    if (info.action === Action.UPDATE && outOfScope) info.action = Action.EXCLUDE;
    if (info.action === Action.UPDATE && sp.unknown) info.action = Action.UNKNOWN_SUFFIX;
    (isFront ? front : back).push(info);
  }
  // copies on reused sheets share one base, so any copy in scope renumbers all of them and a locked or explicitly
  // excluded copy holds the whole group
  const groupActions = new Map<string, Action>(), scopedGroups = new Set<string>(), heldGroups = new Set<string>(), groupSuffixes = new Map<string, string[]>();
  for (const side of [front, back]) for (const f of side) {
    if (!f.shared) continue;
    if (f.representative === f.id) groupActions.set(f.id, f.action);
    if (f.action === Action.UPDATE) scopedGroups.add(f.representative);
    if (f.held) heldGroups.add(f.representative);
  }
  for (const side of [front, back]) for (const f of side) {
    if (!f.shared) continue;
    if (heldGroups.has(f.representative)) f.action = Action.EXCLUDE;
    else if (scopedGroups.has(f.representative)) f.action = Action.UPDATE;
    else f.action = groupActions.get(f.representative)!;
    let l = groupSuffixes.get(f.representative); if (!l) { l = []; groupSuffixes.set(f.representative, l); } l.push(f.suffix);
  }
  const sorter = (dirs: number[]) => {
    const code = dirs[o.sortCode >= 0 && o.sortCode < 8 ? o.sortCode : 0];
    const yFirst = !!(code & SORTYFIRST), descFirst = !!(code & DESCENDINGFIRST), descSecond = !!(code & DESCENDINGSECOND);
    // FootprintCompare as a three-way comparison
    return (a: Info, b: Info): number => {
      let x0 = a.rx, x1 = b.rx, y0 = a.ry, y1 = b.ry;
      if (yFirst) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
      if (descFirst) [x0, x1] = [x1, x0];
      if (descSecond) [y0, y1] = [y1, y0];
      return x0 !== x1 ? (x0 < x1 ? -1 : 1) : y0 !== y1 ? (y0 < y1 ? -1 : 1) : 0;
    };
  };
  front.sort(sorter(FRONT_DIRS)); back.sort(sorter(BACK_DIRS));
  const prefixes: PrefixInfo[] = [];
  const prefixInfo = (p: string, start = 1): PrefixInfo => { let f = prefixes.find((x) => x.prefix === p); if (!f) { f = { prefix: p, last: Math.max(start - 1, 0), unavailable: new Set() }; prefixes.push(f); } return f; };
  // BuildUnavailableRefsList; a digit suffix makes R1 with suffix 2 read as R12, so suffixed and bare references are compared whole
  const takenRefs = new Set<string>(), suffixedRefs = new Set<string>(), newBases = new Map<string, string>();
  for (const side of [front, back]) for (const f of side) {
    if (f.action === Action.UPDATE) continue;
    takenRefs.add(f.ref);
    if (f.suffix || f.action === Action.UNKNOWN_SUFFIX) suffixedRefs.add(f.ref);
    if (f.action === Action.EXCLUDE || f.action === Action.UNKNOWN_SUFFIX) prefixInfo(f.prefix).unavailable.add(refDesNumber(f.ref));
  }
  type Change = { id: string; action: Action; from: string; to: string; suffix: string; representative: string };
  const changes: Change[] = [], bad: ReannotatePlan["bad"] = [];
  const build = (side: Info[], startText: string, prefix: string, remove: boolean): void => {
    const start = Math.max(0, parseInt(startText, 10) || 0);
    const have = prefix.length > 0, add = have && !remove; remove = remove && have;
    // LogFootprints
    let msg = (side[0].front ? "Front Footprints" : "Back Footprints") + " " + (o.useFootprintLocation ? "(sorted by footprint location)" : "(sorted by reference designator location)");
    msg += "\n-------------------------------------------------------------";
    side.forEach((f, i) => { msg += `\n${i + 1} ${f.ref || "unannotated footprint"} at ${coord(f.x, f.y)} (rounded to ${coord(f.rx, f.ry)})`; });
    show("info", msg);
    if (start !== 0) for (const p of prefixes) p.last = start - 1;
    for (const f of side) {
      const c: Change = { id: f.id, action: f.action, from: f.ref, to: f.ref, suffix: f.suffix, representative: f.representative };
      if (c.action === Action.EMPTY || c.action === Action.INVALID) { changes.push(c); bad.push({ ref: f.ref, fpid: f.fpid, x: f.x / 1e6, y: f.y / 1e6 }); continue; }
      // a copy on a reused sheet takes the base its representative is given
      if (c.action === Action.UPDATE && f.representative !== f.id) { changes.push(c); continue; }
      if (c.action === Action.UPDATE) {
        let p = f.prefix; const present = p.indexOf(prefix) === 0;
        if (add && !present) p = prefix + p;
        if (remove && present) p = p.slice(prefix.length);
        const info = prefixInfo(p, start);
        let num = info.last + 1;
        const suffixes = groupSuffixes.get(f.id) || [f.suffix];
        const clashes = (b: string): boolean => suffixes.some((sfx) => (sfx ? takenRefs : suffixedRefs).has(b + sfx));
        while (info.unavailable.has(num) || clashes(info.prefix + num)) num++;
        const base = info.prefix + num;
        for (const sfx of suffixes) { takenRefs.add(base + sfx); if (sfx) suffixedRefs.add(base + sfx); }
        newBases.set(f.id, base);
        c.to = base + f.suffix; info.last = num;
      }
      changes.push(c);
    }
  };
  if (front.length) build(front, o.frontStart, o.frontPrefix, o.removeFrontPrefix);
  if (back.length) build(back, o.backStart, o.backPrefix, o.removeBackPrefix);
  for (const c of changes) if (c.action === Action.UPDATE && c.representative !== c.id) c.to = (newBases.get(c.representative) || "") + c.suffix;
  changes.sort((a, b) => strNumCmp(a.from, b.from, true));   // StrNumCmp( a, b ): CMP_T::CASE_SENSITIVE
  // LogChangePlan
  let plan = "Reference Designator Prefixes in Use\n-------------------------------------------------------------\n";
  plan += prefixes.map((p, i) => p.prefix + ((i + 1) % 16 === 0 ? "\n" : " ")).join("");
  if (excludes.length) plan += `\n(Excluding ${excludes.join(" ")} from reannotation.)`;
  show("info", plan);
  let log = "Change Log\n-------------------------------------------------------------";
  for (const c of changes) log += c.action !== Action.UPDATE ? `\n${c.from || "unannotated footprint"}  ${ACTION_MESSAGE[c.action]}` : `\n${c.from || "unannotated footprint"} -> ${c.to || "unannotated footprint"}`;
  show("action", log);
  let errors = 0;
  for (let i = 0; i < changes.length && errors <= MAXERROR; i++) {
    if (changes[i].action === Action.EMPTY || changes[i].action === Action.INVALID) continue;
    for (let j = i + 1; j < changes.length; j++) {
      if (changes[i].to === changes[j].to) { show("error", `Duplicate instances of ${changes[j].to}`); if (errors++ > MAXERROR) { show("error", "Aborted: too many errors"); break; } }
    }
  }
  const ok = errors === 0;
  if (!ok) show("error", "Selected options resulted in errors! Change them and try again.");
  else if (bad.length) {
    let m = `PCB has ${bad.length} empty or invalid reference designations.\nYou may wish to run DRC with 'Test for parity between PCB and schematic' checked.`;
    for (const b of bad) m += `\n    RefDes: ${b.ref || "unannotated footprint"}; footprint: ${b.fpid || "unknown"} at ${coord(nm(b.x), nm(b.y))} on PCB.`;
    show("warning", m);
  }
  const unknownSuffixes = changes.filter((c) => c.action === Action.UNKNOWN_SUFFIX).length;
  if (ok && unknownSuffixes > 0) show("warning", `${unknownSuffixes} footprints keep their references because their sheet suffixes could not be determined. Open the schematic editor and update the PCB from it if needed before renumbering them.`);
  const out: PcbChange[] = [], renames: ReannotatePlan["renames"] = [];
  if (ok) for (const c of changes) {
    if (c.to === c.from) continue;
    const it = doc.items.get(c.id); if (!it) continue;
    const n = clone(it.node), rf = refField(n); if (!rf) continue;
    rf[2] = c.to; out.push(replacedChange(it, n)); renames.push({ id: c.id, from: c.from, to: c.to });
  }
  return { ok, bad, report, changes: out, renames };
}

/** The order the front side's sort visits points in, for the direction buttons' pictures (BITMAPS::reannotate_*). */
export function reannotateOrder(sortCode: number, pts: [number, number][]): number[] {
  const infos = pts.map((p, i) => ({ i, rx: p[0], ry: p[1] }));
  const code = FRONT_DIRS[sortCode] ?? FRONT_DIRS[0];
  const yFirst = !!(code & SORTYFIRST), descFirst = !!(code & DESCENDINGFIRST), descSecond = !!(code & DESCENDINGSECOND);
  infos.sort((a, b) => {
    let x0 = a.rx, x1 = b.rx, y0 = a.ry, y1 = b.ry;
    if (yFirst) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
    if (descFirst) [x0, x1] = [x1, x0];
    if (descSecond) [y0, y1] = [y1, y0];
    return x0 !== x1 ? (x0 < x1 ? -1 : 1) : y0 !== y1 ? (y0 < y1 ? -1 : 1) : 0;
  });
  return infos.map((x) => x.i);
}
