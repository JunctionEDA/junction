// dialogs/update-from-pcb-logic.ts — BACK_ANNOTATE (eeschema/tools/backannotate.cpp) on plain data: the board's
// footprints matched to the schematic's symbols by their path (or, re-linking, by reference designator), and the
// changes Tools > Update Schematic from PCB... lists and applies: references, footprint assignments, values, the
// attribute flags, the other fields, and the net labels whose net was renamed on the board.

export interface BaOptions {
  relink: boolean; references: boolean; footprints: boolean; values: boolean; netNames: boolean; attributes: boolean; otherFields: boolean;
  /** m_preferUnitSwaps / m_preferPinSwaps: gate and pin swaps on the board become symbol unit / pin swaps, not label changes */
  unitSwaps?: boolean; pinSwaps?: boolean;
  /** EESCHEMA_SETTINGS input.allow_unconstrained_pin_swaps (a pin swap is only reported without it) */
  allowPinSwaps?: boolean;
}
/** One placed unit of a symbol: its path, the unit it shows, and per unit number the library's pins (GetUnitPinInfo:
 *  the unit's pins with the common ones, ordered by position) with their electrical types. */
export interface SymUnit { key: string; unit: number; unitPins: Map<number, string[]>; pinTypes: Map<string, string>; shared?: boolean;
  /** hidden pins (a hidden power_in pin is a power pin: SCH_PIN::IsPower) */
  hiddenPins?: Set<string>;
  /** SymbolHasSheetInstances: the friendly names of the sheets the symbol item is placed on (when more than one) and
   *  the other projects whose instances it carries */
  sharedSheets?: string[]; sharedProjects?: string[] }
/** A footprint as PCB_EDIT_FRAME's back-annotation netlist describes it. */
export interface FpData {
  ref: string; path: string; fpid: string; value: string;
  dnp: boolean; excludeFromBom: boolean; excludeFromSim: boolean; excludeFromPos: boolean;
  /** every field except Reference and Value */
  fields: Map<string, string>;
  /** pad number -> board net name */
  pads: Map<string, string>;
}
/** One placed unit of a schematic symbol on one sheet instance (an SCH_REFERENCE of SYMBOL_FILTER_NON_POWER). */
export interface SymRef {
  /** this unit's full path ("/<sheet uuid>…/<symbol uuid>"), what a footprint's (path) names; `keys` every unit's of
   *  a multi-unit symbol (GetMultiUnitSymbols, in sheet order), else this one */
  key: string; keys: string[]; ref: string; power: boolean;
  /** a symbol whose library has more than one unit (m_multiUnitsRefs) */
  multi?: boolean;
  /** the sheet path (root first) and symbol uuid SCH_REFERENCE_LIST::sortByTimeStamp orders by */
  sheetPath?: string[]; uuid?: string;
  value: string; footprint: string; dnp: boolean; inBom: boolean; inPos: boolean; onBoard: boolean; exSim?: boolean;
  /** non-mandatory fields */
  fields: Map<string, string>;
  /** pin number -> schematic net name */
  pins: Map<string, string>;
  /** the placed units of the symbol, for unit swaps; `self` this one's (pin swaps, its pins) */
  units?: SymUnit[]; self?: SymUnit;
  /** the numbers of every pin of the library symbol (SCH_SYMBOL::GetPin finds a pin of any unit by its number) */
  pinNumbers?: Set<string>;
  /** this placed unit's pins on its sheet instance by number: the pin's net (SCH_PIN::GetConnectionName), the strongest
   *  item physically connected to it and its net's resolved driver (pcb-netlist.ts PinDrivers) */
  pinDrivers?: Map<string, PinConn>;
}
/** An item that can drive a net (pcb-netlist.ts DriverItem): its kind, sheet instance, item id and driver priority
 *  (CONNECTION_SUBGRAPH::PRIORITY: NONE 0, PIN 1, SHEET_PIN 2, HIER_LABEL 3, LOCAL_LABEL 4, LOCAL_POWER_PIN 5,
 *  GLOBAL_POWER_PIN 6, GLOBAL 7). */
export interface DriverRef { kind: string; inst: number; id: string; prio: number; x: number; y: number; pin?: string; power?: boolean; sheetPin?: string }
export interface PinConn { net: string; physical: DriverRef | null; resolved: DriverRef | null }
export interface BaLine { severity: "error" | "warning" | "action" | "info"; text: string }
export interface SymEdit {
  key: string; ref?: string; footprint?: string; value?: string; dnp?: boolean; inBom?: boolean; inPos?: boolean; exSim?: boolean;
  setFields: Map<string, string>; addFields: Map<string, string>; deleteFields: string[];
}
/**
 * processNetNameChange's edits: a label's or sheet pin's new text ("text"), a power symbol's new value ("value"), or a
 * new local label at a pin ("add", `spin` the SPIN_STYLE orientLabel gives: 0 left, 1 up, 2 right, 3 bottom).
 */
export type LabelEdit =
  | { op: "text"; inst: number; id: string; kind: string; sheetPin?: string; text: string; ref: string; pin: string }
  | { op: "value"; inst: number; id: string; text: string; ref: string; pin: string }
  | { op: "add"; inst: number; x: number; y: number; text: string; spin: number; ref: string; pin: string };
/** a unit swap: the placed unit `key` shows unit `unit` from now on */
export interface UnitEdit { key: string; unit: number }
/** a pin swap: pins `a` and `b` of the placed unit `key` trade their positions (SwapPinGeometry) */
export interface PinSwap { key: string; a: string; b: string }

const MANDATORY = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);
const hasVars = (s: string): boolean => /\$\{[^}]*\}/.test(s);
const tf = (b: boolean): string => (b ? "true" : "false");
/** DescribeRef: "R1", or "<no reference designator>" */
export const describeRef = (r: string): string => (r ? r : "<no reference designator>");
/** NETINFO_ITEM::GetShortNetname / SCH_CONNECTION::Name( aIgnoreSheet ): the name without its sheet path. */
const shortName = (n: string): string => n.slice(n.lastIndexOf("/") + 1);
const LP_LOCAL_LABEL = 4;

/** BackAnnotateSymbols: the report and the edits, for the dry run and the update alike.  The lines are ReportHead's
 *  (every change, "has no assigned symbol", "linked to same symbol") followed by ReportTail's ("Cannot find symbol",
 *  the unused-symbol warnings, "Footprint re-linking canceled by user."). */
export interface BaResult { lines: BaLine[]; edits: SymEdit[]; labels: LabelEdit[]; relinks: { fpRef: string; path: string }[]; changes: number; unitEdits: UnitEdit[]; pinSwaps: PinSwap[] }
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** SCH_REFERENCE_LIST::sortByTimeStamp: by sheet path (shorter first, then uuid by uuid), then by symbol uuid. */
function byTimeStamp(a: SymRef, b: SymRef): number {
  const pa = a.sheetPath || [], pb = b.sheetPath || [];
  if (pa.length !== pb.length) return pa.length - pb.length;
  for (let i = 0; i < pa.length; i++) { const c = cmpStr(pa[i], pb[i]); if (c) return c; }
  return cmpStr(a.uuid || "", b.uuid || "");
}
/** `spinOf`: orientLabel for a symbol pin driver (the SPIN_STYLE a label added at that pin takes). */
export function backAnnotate(syms: SymRef[], fps: FpData[], o: BaOptions & { annotated?: boolean; spinOf?: (d: DriverRef) => number }): BaResult {
  const head: BaLine[] = [], tail: BaLine[] = [], edits: SymEdit[] = [], labels: LabelEdit[] = [], relinks: { fpRef: string; path: string }[] = [], unitEdits: UnitEdit[] = [], pinSwaps: PinSwap[] = [];
  const out = (): BaResult => ({ lines: [...head, ...tail], edits, labels, relinks, changes, unitEdits, pinSwaps });
  let changes = 0;
  if (!o.relink && !o.values && !o.footprints && !o.references && !o.netNames && !o.attributes && !o.otherFields) {
    tail.push({ severity: "error", text: "Select at least one property to back annotate." });
    return out();
  }
  const refs = syms.filter((s) => !s.power);
  // getPcbModulesFromString: the footprints by path (by reference when re-linking), in the map's order
  const pcb = new Map<string, FpData>();
  for (const fp of fps) {
    const path = o.relink ? fp.ref : fp.path;
    if (!path) { head.push({ severity: "warning", text: `Footprint '${describeRef(fp.ref)}' has no assigned symbol.` }); continue; }
    const other = pcb.get(path);
    if (other) { head.push({ severity: "error", text: `Footprints '${describeRef(other.ref)}' and '${describeRef(fp.ref)}' linked to same symbol.` }); continue; }
    pcb.set(path, fp);
  }
  // getChangeList: a footprint of a multi-unit symbol brings every unit of it
  const multi = new Map<string, SymRef[]>();
  for (const s of refs) if (s.multi) { const k = s.keys.join("\n"); if (!multi.has(k)) multi.set(k, []); multi.get(k)!.push(s); }
  const multiLists = [...multi.values()].sort((a, b) => cmpStr(a[0].ref, b[0].ref));
  let list: { s: SymRef; fp: FpData }[] = [];
  for (const [path, fp] of [...pcb].sort((a, b) => cmpStr(a[0], b[0]))) {
    const find = (l: SymRef[]): SymRef | undefined => (o.relink ? l.find((s) => s.ref === path) : l.find((s) => s.key === path));
    const ml = multiLists.find((l) => !!find(l));
    if (ml) { for (const s of ml) list.push({ s, fp }); continue; }
    const s = find(refs);
    if (s) list.push({ s, fp });
    else tail.push({ severity: "error", text: `Cannot find symbol for footprint '${describeRef(fp.ref)}'.` });
  }
  // checkForUnusedSymbols: both lists by path; the symbols passed over before each linked one, excluded from the board
  const sorted = refs.slice().sort(byTimeStamp);
  list = list.map((x, i) => ({ x, i })).sort((a, b) => byTimeStamp(a.x.s, b.x.s) || a.i - b.i).map((e) => e.x);
  let i = 0;
  for (const item of list) {
    while (i < sorted.length && sorted[i].key !== item.s.key) {
      if (!sorted[i].onBoard) tail.push({ severity: "warning", text: `Footprint '${describeRef(sorted[i].ref)}' is not present on PCB. Corresponding symbols in schematic must be manually deleted (if desired).` });
      ++i;
    }
    ++i;
  }
  if (o.relink && o.annotated === false) tail.push({ severity: "error", text: "Footprint re-linking canceled by user." });
  for (const { s, fp } of list) if (o.relink && fp.path !== s.key && !relinks.some((r) => r.fpRef === fp.ref)) relinks.push({ fpRef: fp.ref, path: s.key });
  // applyChangelist: unit swaps first (per footprint, over the units linked to it); swapped units are SKIP_STRUCT
  const skipUnits = new Set<string>();
  if (o.netNames && o.unitSwaps) {
    const perFp = new Map<FpData, SymRef[]>(); for (const { s, fp } of list) { if (!perFp.has(fp)) perFp.set(fp, []); perFp.get(fp)!.push(s); }
    for (const [fp, items] of perFp) {
      const s = items[0], plan = unitSwapPlan({ ...s, units: items.map((x) => x.self).filter((u): u is SymUnit => !!u) }, fp); if (!plan) continue;
      for (const st of plan) {
        head.push({ severity: "action", text: `Swap ${describeRef(s.ref)} unit ${unitLetter(st.aUnit)} with unit ${unitLetter(st.bUnit)}.` }); changes++;
        unitEdits.push({ key: st.a.key, unit: st.bUnit }, { key: st.b.key, unit: st.aUnit });
        skipUnits.add(st.a.key); skipUnits.add(st.b.key);
      }
    }
  }
  for (const { s, fp } of list) {
    const e: SymEdit = { key: s.key, setFields: new Map(), addFields: new Map(), deleteFields: [] };
    let any = false;
    const skip = skipUnits.has(s.key), R = s.ref;
    if (o.references && s.ref !== fp.ref && !skip && !hasVars(s.ref)) {
      // ResolveBackannotatedRefs without reused-sheet suffixes: only an empty board reference lacks the suffix ''
      if (!fp.ref) head.push({ severity: "error", text: `Cannot change ${describeRef(s.ref)} to '${fp.ref}', which lacks the sheet suffix ''.` });
      else { changes++; any = true; e.ref = fp.ref; head.push({ severity: "action", text: `Change ${describeRef(s.ref)} reference designator to '${fp.ref}'.` }); }
    }
    if (o.footprints && s.footprint !== fp.fpid && !skip && !hasVars(s.footprint)) { changes++; any = true; e.footprint = fp.fpid; head.push({ severity: "action", text: `Change ${describeRef(R)} footprint assignment from '${s.footprint}' to '${fp.fpid}'.` }); }
    if (o.values && s.value !== fp.value && !skip && !hasVars(s.value)) { changes++; any = true; e.value = fp.value; head.push({ severity: "action", text: `Change ${describeRef(R)} value from '${s.value}' to '${fp.value}'.` }); }
    if (o.attributes && s.dnp !== fp.dnp && !skip) { changes++; any = true; e.dnp = fp.dnp; head.push({ severity: "action", text: `Change ${describeRef(R)} 'Do not populate' from '${tf(s.dnp)}' to '${tf(fp.dnp)}'.` }); }
    if (o.attributes && !s.inBom !== fp.excludeFromBom && !skip) { changes++; any = true; e.inBom = !fp.excludeFromBom; head.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from bill of materials' from '${tf(!s.inBom)}' to '${tf(fp.excludeFromBom)}'.` }); }
    if (o.attributes && !!s.exSim !== fp.excludeFromSim && !skip) { changes++; any = true; e.exSim = fp.excludeFromSim; head.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from simulation' from '${tf(!!s.exSim)}' to '${tf(fp.excludeFromSim)}'.` }); }
    if (o.attributes && !s.inPos !== fp.excludeFromPos && !skip) { changes++; any = true; e.inPos = !fp.excludeFromPos; head.push({ severity: "action", text: `Change ${describeRef(R)} 'Exclude from position files' from '${tf(!s.inPos)}' to '${tf(fp.excludeFromPos)}'.` }); }
    // applyPinSwaps: reciprocal pad net swaps become pin swaps before the labels are looked at
    const swapped = o.pinSwaps && o.netNames && !skip ? pinSwapsFor(s, fp, !!o.allowPinSwaps, head, pinSwaps) : new Set<string>();
    changes += swapped.size / 2;
    if (o.netNames && !skip) {
      // the pad map's pins in order, each pin whose net (its short name) differs from the pad's
      for (const pad of [...fp.pads.keys()].sort(cmpStr)) {
        const boardNet = shortName(fp.pads.get(pad)!);
        if (swapped.has(pad)) continue;
        if (s.pinNumbers && !s.pinNumbers.has(pad)) { head.push({ severity: "error", text: `Cannot find ${describeRef(R)} pin '${pad}'.` }); continue; }
        // a pin of another unit has no connection on this unit's sheet
        const pc = s.pinDrivers ? s.pinDrivers.get(pad) : undefined; if (!pc) continue;
        const schNet = shortName(pc.net);
        if (schNet !== boardNet) changes += netNameChange(R, pad, pc, schNet, boardNet, head, labels, o.spinOf);
      }
    }
    if (o.otherFields) {
      for (const [name, val] of fp.fields) {
        if (name === "Reference" || name === "Value" || name === "Footprint") continue;
        const cur = s.fields.get(name);
        if (cur !== undefined && !hasVars(cur) && cur !== val) { changes++; any = true; e.setFields.set(name, val); head.push({ severity: "action", text: `Change ${describeRef(R)} field '${name}' value to '${val}'.` }); }
        if (cur === undefined && !MANDATORY.has(name)) { changes++; any = true; e.addFields.set(name, val); head.push({ severity: "action", text: `Add ${describeRef(R)} field '${name}' with value '${val}'.` }); }
      }
      for (const name of s.fields.keys()) if (!MANDATORY.has(name) && !fp.fields.has(name)) { changes++; any = true; e.deleteFields.push(name); head.push({ severity: "action", text: `Delete ${describeRef(R)} field '${name}.'` }); }
    }
    if (any) edits.push(e);
  }
  return out();
}

/**
 * BACK_ANNOTATE::processNetNameChange for one pin: the highest-priority item physically connected to the pin decides.
 * A label, global label, hierarchical label or sheet pin is retexted; a power pin cannot be renamed; an ordinary pin
 * takes its net's resolved driver when that is at least a local label (a power symbol's value then changes), else a
 * new label is added at the pin.  Returns the number of changes.
 */
function netNameChange(ref: string, pin: string, pc: PinConn, oldName: string, newName: string, lines: BaLine[], out: LabelEdit[], spinOf?: (d: DriverRef) => number): number {
  const d = pc.physical; if (!d) return 0;
  const change = `Change ${describeRef(ref)} pin ${pin} net label from '${oldName}' to '${newName}'.`;
  if (d.kind === "label" || d.kind === "global_label" || d.kind === "hierarchical_label" || d.kind === "sheet_pin") {
    out.push({ op: "text", inst: d.inst, id: d.id, kind: d.kind, sheetPin: d.sheetPin, text: newName, ref, pin });
    lines.push({ severity: "action", text: change });
    return 1;
  }
  if (d.kind !== "pin") return 0;
  if (d.power) { lines.push({ severity: "error", text: `Net ${oldName} cannot be changed to ${newName} because it is driven by a power pin.` }); return 0; }
  // the physical walk found no label: the connectivity's resolved driver of the net
  const r = pc.resolved;
  if (r && r.prio >= LP_LOCAL_LABEL) {
    if (r.kind === "pin") out.push({ op: "value", inst: r.inst, id: r.id, text: newName, ref, pin });
    else out.push({ op: "text", inst: r.inst, id: r.id, kind: r.kind, sheetPin: r.sheetPin, text: newName, ref, pin });
    lines.push({ severity: "action", text: change });
    return 1;
  }
  out.push({ op: "add", inst: d.inst, x: d.x, y: d.y, text: newName, spin: spinOf ? spinOf(d) : 0, ref, pin });
  lines.push({ severity: "action", text: `Add label '${newName}' to ${describeRef(ref)} pin ${pin} net.` });
  return 1;
}

/**
 * orientLabel: the SPIN_STYLE of a label added at a pin (0 left, 1 up, 2 right, 3 bottom): opposite the library pin's
 * orientation (`pinAngle`: 0 right, 90 up, 180 left, 270 down), turned counter-clockwise once per 90 degrees of the
 * symbol and then mirrored as the symbol is (SCH_SYMBOL::GetOrientation's canonical form: mirror x at 180 is mirror y).
 */
export function orientLabel(pinAngle: number, symAngle: number, mirror: string): number {
  const LEFT = 0, UP = 1, RIGHT = 2, BOTTOM = 3;
  const pa = ((Math.round(pinAngle / 90) % 4) + 4) % 4;
  let spin = pa === 1 ? BOTTOM : pa === 2 ? RIGHT : pa === 3 ? UP : LEFT;
  let rots = ((Math.round(symAngle / 90) % 4) + 4) % 4, mx = mirror === "x", my = mirror === "y";
  if (mx && rots === 2) { mx = false; my = true; rots = 0; }
  const ccw = [BOTTOM, LEFT, UP, RIGHT];   // RotateCCW: LEFT->BOTTOM, UP->LEFT, RIGHT->UP, BOTTOM->RIGHT
  for (let i = 0; i < rots; i++) spin = ccw[spin];
  if (mx) spin = spin === UP ? BOTTOM : spin === BOTTOM ? UP : spin;
  if (my) spin = spin === LEFT ? RIGHT : spin === RIGHT ? LEFT : spin;
  return spin;
}

/** LIB_SYMBOL::LetterSubReference / SubReference( unit, false ): A … Z, AA … */
function unitLetter(unit: number): string { let n = unit, out = ""; while (n > 0) { n--; out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26); } return out || String(unit); }
const netsInUnitOrder = (pins: string[], net: (p: string) => string): string[] => pins.map(net);
const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * PlanBackannotateUnitSwaps over the placed units of one footprint: each unit's board nets (in its unit's pin order)
 * must match some unit's schematic nets; the mapping's cycles become pairwise swaps.  Null: nothing to do.
 */
export function unitSwapPlan(s: SymRef, fp: FpData): { a: SymUnit; b: SymUnit; aUnit: number; bUnit: number }[] | null {
  const units = (s.units || []).slice().sort((x, y) => x.unit - y.unit);
  if (units.length < 2) return null;
  const pinsOf = (u: SymUnit, unit: number): string[] => u.unitPins.get(unit) || [];
  const target = new Map<number, number>(), used = new Set<number>();
  for (let i = 0; i < units.length; i++) {
    const pcb = netsInUnitOrder(pinsOf(units[i], units[i].unit), (p) => fp.pads.get(p) || "");
    let hit = -1;
    for (let j = 0; j < units.length; j++) {
      if (used.has(j)) continue;
      const sch = netsInUnitOrder(pinsOf(units[j], units[j].unit), (p) => s.pins.get(p) || "");
      if (sameList(pcb, sch)) { hit = j; break; }
    }
    if (hit < 0) return null;   // !m_mappingOk
    target.set(i, hit); used.add(hit);
  }
  if ([...target].every(([i, j]) => i === j)) return null;   // m_identity
  const steps: { a: SymUnit; b: SymUnit; aUnit: number; bUnit: number }[] = [], visited = new Set<number>();
  const cur = units.map((u) => u.unit);
  for (let start = 0; start < units.length; start++) {
    if (visited.has(start)) continue;
    const cycle: number[] = []; let i = start;
    while (!visited.has(i)) { visited.add(i); cycle.push(i); const n = target.get(i); if (n === undefined || n === i) break; i = n; }
    if (cycle.length < 2) continue;
    for (let k = cycle.length - 1; k > 0; k--) {
      const a = cycle[k - 1], b = cycle[k], aUnit = cur[a], bUnit = cur[b];
      steps.push({ a: units[a], b: units[b], aUnit, bUnit });
      cur[a] = bUnit; cur[b] = aUnit;
    }
  }
  return steps.length ? steps : null;
}

/**
 * BACK_ANNOTATE::applyPinSwaps for one placed unit: two pins whose board nets are each other's schematic nets swap
 * places (power pins left out: a power_in pin that is hidden).  Without "Allow unconstrained pin swaps", or on a
 * symbol shared by several sheet instances or projects, the swap is only reported and the labels are changed as
 * usual.  Returns the pins swapped.
 */
function pinSwapsFor(s: SymRef, fp: FpData, allow: boolean, lines: BaLine[], out: PinSwap[]): Set<string> {
  const swapped = new Set<string>(), u = s.self; if (!u) return swapped;
  const pins = u.unitPins.get(u.unit) || [];
  const mism: { pin: string; cur: string; want: string }[] = [];
  for (const pin of [...fp.pads.keys()].sort(cmpStr)) {
    const want = fp.pads.get(pin)!;
    if (!pins.includes(pin)) continue;
    if (u.pinTypes.get(pin) === "power_in" && u.hiddenPins && u.hiddenPins.has(pin)) continue;   // SCH_PIN::IsPower
    const cur = s.pins.get(pin) || "";
    if (!want || !cur || want === cur) continue;
    mism.push({ pin, cur, want });
  }
  if (mism.length < 2) return swapped;
  const projects = u.sharedProjects || [], sheets = u.sharedSheets || [], shared = !!u.shared || projects.length > 0;
  const done = new Array(mism.length).fill(false);
  for (let i = 0; i < mism.length; i++) {
    if (done[i]) continue;
    const j = mism.findIndex((m, k) => k !== i && !done[k] && m.cur === mism[i].want && m.want === mism[i].cur);
    if (j < 0) continue;
    const a = mism[i].pin, b = mism[j].pin;
    if (!allow || shared) {
      const text = projects.length ? `Would swap ${s.ref} pins ${a} and ${b} to match PCB, but the symbol is shared across other projects (${projects.join(", ")}).`
        : sheets.length ? `Would swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB, but the symbol is used by multiple sheet instances (${sheets.join(", ")}).`
        : shared ? `Would swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB, but the symbol is shared.`
        : `Would swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB, but unconstrained pin swaps are disabled in the schematic preferences.`;
      lines.push({ severity: "info", text });
      done[i] = done[j] = true;
      continue;
    }
    done[i] = done[j] = true;
    swapped.add(a); swapped.add(b); out.push({ key: u.key, a, b });
    lines.push({ severity: "action", text: `Swap ${describeRef(s.ref)} pins ${a} and ${b} to match PCB.` });
  }
  return swapped;
}

/** LIB_SYMBOL::GetUnitPinInfo on a (flattened) library symbol: per unit, its pins and the common ones (any body style)
 *  ordered by position (x, then y downwards), each number once; with every pin's electrical type. */
export function libUnitPins(lib: N): { unitPins: Map<number, string[]>; pinTypes: Map<string, string>; hiddenPins: Set<string> } {
  const subs = kids(lib, "symbol").map((sub) => { const m = /_(\d+)_(\d+)$/.exec(sv(sub[1])); return { unit: m ? +m[1] : 0, pins: kids(sub, "pin") }; });
  let count = 1; for (const sb of subs) count = Math.max(count, sb.unit);
  const unitPins = new Map<number, string[]>(), pinTypes = new Map<string, string>(), hiddenPins = new Set<string>();
  for (let u = 1; u <= count; u++) {
    const list: { n: string; x: number; y: number }[] = [];
    for (const sb of subs) if (sb.unit === 0 || sb.unit === u) for (const p of sb.pins) {
      const num = kid(p, "number"), at = kid(p, "at"); if (!num) continue;
      const n = sv(num[1]); pinTypes.set(n, sv(p[1]));
      const hd = kid(p, "hide"); if (p.some((c) => c === "hide") || (hd && sv(hd[1]) !== "no")) hiddenPins.add(n);
      list.push({ n, x: at ? Number(at[1]) || 0 : 0, y: at ? -(Number(at[2]) || 0) : 0 });
    }
    list.sort((a, b) => a.x - b.x || a.y - b.y);
    const seen = new Set<string>(), nums: string[] = [];
    for (const p of list) if (!seen.has(p.n)) { seen.add(p.n); nums.push(p.n); }
    unitPins.set(u, nums);
  }
  return { unitPins, pinTypes, hiddenPins };
}

/** SwapPinGeometry on the library copy: the two pins (in every body style of the unit's sub-symbols) trade position,
 *  orientation and length. */
export function swapLibPins(lib: N, unit: number, a: string, b: string): boolean {
  let any = false;
  for (const sub of kids(lib, "symbol")) {
    const m = /_(\d+)_(\d+)$/.exec(sv(sub[1])); const u = m ? +m[1] : 0; if (u !== 0 && u !== unit) continue;
    const pins = kids(sub, "pin"), pa = pins.find((p) => sv((kid(p, "number") || [])[1]) === a), pb = pins.find((p) => sv((kid(p, "number") || [])[1]) === b);
    if (!pa || !pb) continue;
    for (const key of ["at", "length"]) {
      const ia = pa.findIndex((c) => isList(c) && c[0] === key), ib = pb.findIndex((c) => isList(c) && c[0] === key);
      if (ia < 0 || ib < 0) continue;
      const t = pa[ia]; pa[ia] = pb[ib]; pb[ib] = t;
    }
    any = true;
  }
  return any;
}

// ---------------------------------------------------------------- reading the board
type N = SNode;
const isList = Array.isArray;
const sv = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const kid = (n: N, k: string): N | null => { for (let i = 1; i < n.length; i++) { const c = n[i]; if (isList(c) && c[0] === k) return c as N; } return null; };
const kids = (n: N, k: string): N[] => n.filter((c) => isList(c) && c[0] === k) as N[];
/** The footprint's data the back-annotation reads (its (path), fpid, fields, attributes and pad nets). */
export function fpData(fp: N): FpData {
  const fields = new Map<string, string>();
  let ref = "", value = "";
  for (const p of kids(fp, "property")) { const name = sv(p[1]), val = sv(p[2]); if (name === "Reference") ref = val; else if (name === "Value") value = val; else if (!/^ki_/.test(name) && !/^Sheet ?(file|name)$/i.test(name)) fields.set(name, val); }
  for (const t of kids(fp, "fp_text")) { if (sv(t[1]) === "reference" && !ref) ref = sv(t[2]); if (sv(t[1]) === "value" && !value) value = sv(t[2]); }
  const attr = kid(fp, "attr"), flags = attr ? attr.slice(1).map(sv) : [];
  const pads = new Map<string, string>();
  for (const pad of kids(fp, "pad")) { const num = sv(pad[1]), net = kid(pad, "net"); if (!net) continue; const name = sv(net.length > 2 ? net[2] : net[1]); if (name) pads.set(num, name); }
  const path = kid(fp, "path");
  return { ref, path: path ? sv(path[1]) : "", fpid: sv(fp[1]), value, dnp: flags.includes("dnp"), excludeFromBom: flags.includes("exclude_from_bom"), excludeFromSim: flags.includes("exclude_from_sim"), excludeFromPos: flags.includes("exclude_from_pos_files"), fields, pads };
}
