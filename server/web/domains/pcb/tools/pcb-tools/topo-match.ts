// pcb-tools/topo-match.ts — TMATCH (pcbnew/connectivity/topo_match.cpp): the partial connection graph isomorphism the
// multi-channel tool pairs the footprints of two channels with.  A COMPONENT is a footprint with its pads (PIN) sorted
// by number; two pins of a channel are connected when they share a net that stays inside the channel.  The search
// (CONNECTION_GRAPH::FindIsomorphism) backtracks over the reference components, taking the one with the fewest
// candidates next (MRV), checks every candidate's nets against the pairs already locked, breaks ties by symbol path
// and then by value, and gives up after c_ITER_LIMIT iterations.  KiCad runs the per-component scans on its thread
// pool; here they run in turn, with the same results.  Nets are keyed by name ("" is no net, KiCad's netcode 0).

/** The footprint a component stands for: what the matcher reads of a FOOTPRINT. */
export interface TmFootprint {
  /** a key unique on the board (the footprint's uuid) */
  key: string;
  /** GetReferenceAsString */
  ref: string;
  /** GetFPIDAsString ("" without a library link) */
  fpid: string;
  /** GetValue */
  value: string;
  /** GetPath: the symbol instance path, root first */
  path: string[];
  /** the pads in file order: number and net key ("" for no net) */
  pads: { number: string; net: string }[];
  /** the net's name as shown (BOARD::FindNet( code )->GetNetname()); the key when absent */
  netName?(net: string): string;
}

export interface MismatchReason { reference: string; candidate: string; reason: string }
export type ComponentMatches = Map<TmFootprint, TmFootprint>;
export interface IsoParams { cancelled?: () => boolean; matched?: (n: number) => void; total?: (n: number) => void }

const NIL = "00000000-0000-0000-0000-000000000000";
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean => /\p{L}/u.test(c);
/** UTIL::GetRefDesPrefix: the reference up to its trailing digits and question marks. */
export function refDesPrefix(ref: string): string {
  let i = ref.length; while (i > 0 && (ref[i - 1] === "?" || isDigit(ref[i - 1]))) i--;
  return ref.slice(0, i);
}

export class Pin {
  ref = ""; net = ""; parent!: Component; conns: Pin[] = [];
  format(): string { return this.parent.reference + "-" + this.ref; }
  isTopologicallySimilar(b: Pin): boolean { return this.parent.isSameKind(b.parent) && this.ref === b.ref; }
  isIsomorphic(b: Pin, reason: MismatchReason): boolean {
    if (this.conns.length !== b.conns.length) {
      reason.reference = this.parent.fp.ref; reason.candidate = b.parent.fp.ref;
      reason.reason = `Pad ${this.ref} of ${reason.reference} connects to ${this.conns.length} pads, but candidate pad ${b.ref} of ${reason.candidate} connects to ${b.conns.length}.`;
      return false;
    }
    if (!this.conns.length) return true;
    const matches = this.conns.map(() => false);
    let nref = 0;
    for (const cref of this.conns) {
      for (let i = 0; i < this.conns.length; i++) if (b.conns[i].isTopologicallySimilar(cref)) { matches[nref] = true; break; }
      nref++;
    }
    for (let i = 0; i < this.conns.length; i++) {
      if (!matches[i]) {
        reason.reference = this.parent.fp.ref; reason.candidate = b.parent.fp.ref;
        reason.reason = `Pad ${this.ref} of ${reason.reference} cannot match candidate pad ${b.ref} of ${reason.candidate} due to differing connectivity.`;
        return false;
      }
    }
    return true;
  }
}

export class Component {
  reference: string; prefix: string; fp: TmFootprint; pins: Pin[] = [];
  constructor(ref: string, fp: TmFootprint) { this.reference = ref; this.fp = fp; this.prefix = refDesPrefix(ref); }
  get pinCount(): number { return this.pins.length; }
  addPin(p: Pin): void { this.pins.push(p); p.parent = this; }
  sortPinsByName(): void { this.pins.sort((a, b) => cmpStr(a.ref, b.ref)); }
  /** isChannelSuffix: no letters, only digits and separators. */
  static isChannelSuffix(s: string): boolean { for (const ch of s) if (isAlpha(ch)) return false; return true; }
  /** prefixesShareCommonBase: TRIM_1.1 and TRIM_2.1 share TRIM_ with channel suffixes. */
  static prefixesShareCommonBase(a: string, b: string): boolean {
    if (a === b) return true;
    let n = 0; const min = Math.min(a.length, b.length);
    while (n < min && a[n] === b[n]) n++;
    if (n === 0) return false;
    return Component.isChannelSuffix(a.slice(n)) && Component.isChannelSuffix(b.slice(n));
  }
  /** isUnannotatedRef: REF** / SW? placeholders match any counterpart on library link and topology alone. */
  static isUnannotatedRef(ref: string): boolean { const p = refDesPrefix(ref); return !!p && (p.endsWith("*") || p.endsWith("?")); }
  isSameKind(b: Component): boolean {
    if (!Component.isUnannotatedRef(this.reference) && !Component.isUnannotatedRef(b.reference) && !Component.prefixesShareCommonBase(this.prefix, b.prefix)) return false;
    return this.fp.fpid === b.fp.fpid;
  }
  matchesWith(b: Component, reason: MismatchReason): boolean {
    if (this.pinCount !== b.pinCount) {
      reason.reference = this.fp.ref; reason.candidate = b.fp.ref;
      reason.reason = `Component ${reason.reference} has ${this.pinCount} pads but candidate ${reason.candidate} has ${b.pinCount}.`;
      return false;
    }
    if (!this.isSameKind(b)) {
      reason.reference = this.fp.ref; reason.candidate = b.fp.ref;
      if (!Component.isUnannotatedRef(this.reference) && !Component.isUnannotatedRef(b.reference) && !Component.prefixesShareCommonBase(this.prefix, b.prefix))
        reason.reason = `Reference prefix mismatch: ${reason.reference} uses prefix '${this.prefix}' but candidate ${reason.candidate} uses '${b.prefix}'.`;
      else reason.reason = `Library link mismatch: ${reason.reference} expects '${this.fp.fpid || "(no library ID)"}' but candidate ${reason.candidate} is '${b.fp.fpid || "(no library ID)"}'.`;
      return false;
    }
    for (let pin = 0; pin < b.pinCount; pin++) {
      if (!this.pins[pin].isIsomorphic(b.pins[pin], reason)) {
        if (!reason.reason) { reason.reference = this.fp.ref; reason.candidate = b.fp.ref; reason.reason = `Component pads differ between ${reason.reference} and ${reason.candidate}.`; }
        return false;
      }
    }
    return true;
  }
}

interface Stage { ref: Component | null; currentMatch: number; matches: Component[]; locked: Map<Component, Component>; refIndex: number }
const stageCopy = (o: Stage): Stage => ({ ref: o.ref, currentMatch: o.currentMatch, matches: o.matches.slice(), locked: new Map(o.locked), refIndex: o.refIndex });
const emptyReason = (): MismatchReason => ({ reference: "", candidate: "", reason: "" });

/** buildBaseNetMapping: the reference nets the locked pairs already map, pin by pin. */
function baseNetMapping(locked: Map<Component, Component>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [tgt, ref] of locked) for (let i = 0; i < ref.pins.length && i < tgt.pins.length; i++) m.set(ref.pins[i].net, tgt.pins[i].net);
  return m;
}
const shownNet = (fp: TmFootprint, net: string): string => (fp.netName ? fp.netName(net) : net);
/** checkCandidateNetConsistency: two pins on one reference net map to one target net; rails are skipped. */
function netConsistent(base: Map<string, string>, ref: Component, tgt: Component, reason: MismatchReason, external: Set<string>): boolean {
  if (ref.pins.length !== tgt.pins.length) {
    reason.reference = ref.fp.ref; reason.candidate = tgt.fp.ref;
    reason.reason = `Component ${reason.reference} expects ${ref.pins.length} matching pads but candidate ${reason.candidate} provides ${tgt.pins.length}.`;
    return false;
  }
  const adds = new Map<string, string>();
  for (let i = 0; i < ref.pins.length; i++) {
    const rn = ref.pins[i].net, tn = tgt.pins[i].net;
    if (external.has(rn) || external.has(tn)) continue;
    if (base.has(rn)) {
      if (base.get(rn) !== tn) {
        reason.reference = ref.fp.ref; reason.candidate = tgt.fp.ref;
        const rName = shownNet(ref.fp, rn) || "net 0", tName = shownNet(tgt.fp, tn) || "net 0";
        reason.reason = `Pad ${ref.pins[i].ref} of ${reason.reference} is on net ${rName} but its match in candidate ${reason.candidate} is on net ${tName}.`;
        return false;
      }
      continue;
    }
    if (adds.has(rn)) {
      if (adds.get(rn) !== tn) {
        reason.reference = ref.fp.ref; reason.candidate = tgt.fp.ref;
        reason.reason = `Pad ${ref.pins[i].ref} of ${reason.reference} has inconsistent net mapping in candidate ${reason.candidate}.`;
        return false;
      }
      continue;
    }
    adds.set(rn, tn);
  }
  return true;
}

/** CommonPathTailLength: the trailing elements two symbol instance paths share; 0 for an empty or nil path. */
export function commonPathTailLength(a: string[], b: string[]): number {
  if (!a.length || !b.length || a[a.length - 1] === NIL || b[b.length - 1] === NIL) return 0;
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
/** std::rotate( begin, begin + i, begin + i + 1 ): the i-th element moves to the front. */
function toFront<T>(v: T[], i: number): void { const [x] = v.splice(i, 1); v.unshift(x); }

interface Inventory { counts: Map<string, number>; footprintOf: Map<string, string>; partsUsing: Map<string, string[]>; repeated: Set<string> }
function takeInventory(cs: Component[]): Inventory {
  const inv: Inventory = { counts: new Map(), footprintOf: new Map(), partsUsing: new Map(), repeated: new Set() };
  for (const c of cs) {
    const ref = c.fp.ref, fp = c.fp.fpid || "(no library ID)";
    inv.counts.set(fp, (inv.counts.get(fp) || 0) + 1);
    inv.partsUsing.set(fp, (inv.partsUsing.get(fp) || []).concat(ref));
    if (inv.footprintOf.has(ref)) inv.repeated.add(ref); else inv.footprintOf.set(ref, fp);
  }
  for (const parts of inv.partsUsing.values()) parts.sort(cmpStr);
  return inv;
}
const sortedKeys = <V>(m: Map<string, V>): string[] => [...m.keys()].sort(cmpStr);
/** sameFootprintInventory: both sides use the same footprints the same number of times, or the reasons why not. */
function sameFootprintInventory(refCs: Component[], tgtCs: Component[], out: MismatchReason[]): boolean {
  const ref = takeInventory(refCs), target = takeInventory(tgtCs);
  const rk = sortedKeys(ref.counts), tk = sortedKeys(target.counts);
  if (rk.length === tk.length && rk.every((k, i) => k === tk[i] && ref.counts.get(k) === target.counts.get(k))) return true;
  for (const reference of sortedKeys(ref.footprintOf)) {
    const footprint = ref.footprintOf.get(reference)!, other = target.footprintOf.get(reference);
    if (other === undefined || other === footprint || ref.repeated.has(reference) || target.repeated.has(reference)) continue;
    out.push({ reference, candidate: reference, reason: `${reference} uses footprint '${footprint}' in the reference area but '${other}' in the target area.` });
  }
  const named: MismatchReason[] = [], countsOnly: MismatchReason[] = [];
  const maxNamed = 12;
  const refOnly = rk.filter((k) => !target.counts.has(k)), targetOnly = tk.filter((k) => !ref.counts.has(k));
  const join = (p: string[]): string => p.join(", ");
  const pairedSwap = refOnly.length === 1 && targetOnly.length === 1 && ref.partsUsing.get(refOnly[0])!.length <= maxNamed && target.partsUsing.get(targetOnly[0])!.length <= maxNamed;
  if (pairedSwap) named.push({ reference: "", candidate: "", reason: `Footprint '${refOnly[0]}' in the reference area (${join(ref.partsUsing.get(refOnly[0])!)}) appears as '${targetOnly[0]}' in the target area (${join(target.partsUsing.get(targetOnly[0])!)}).` });
  const report = (fp: string, refUses: number, targetUses: number): void => {
    if (refUses === targetUses) return;
    if (pairedSwap && (fp === refOnly[0] || fp === targetOnly[0])) return;
    const parts = refUses === 0 ? target.partsUsing.get(fp)! : ref.partsUsing.get(fp)!;
    if ((refUses === 0 || targetUses === 0) && parts.length <= maxNamed) {
      named.push({ reference: "", candidate: "", reason: refUses === 0 ? `Footprint '${fp}' is used by ${join(parts)} in the target area but by nothing in the reference area.`
        : `Footprint '${fp}' is used by ${join(parts)} in the reference area but by nothing in the target area.` });
    } else countsOnly.push({ reference: "", candidate: "", reason: `Footprint '${fp}': ${refUses} in the reference area, ${targetUses} in the target area.` });
  };
  for (const fp of rk) report(fp, ref.counts.get(fp)!, target.counts.get(fp) || 0);
  for (const fp of tk) if (!ref.counts.has(fp)) report(fp, 0, target.counts.get(fp)!);
  out.push(...named, ...countsOnly);
  return false;
}

export class ConnectionGraph {
  static readonly ITER_LIMIT = 10000;
  components: Component[] = [];
  externalNets = new Set<string>();

  addFootprint(fp: TmFootprint): void {
    const c = new Component(fp.ref, fp);
    for (const pad of fp.pads) { const p = new Pin(); p.net = pad.net; p.ref = pad.number; c.addPin(p); }
    this.components.push(c);
  }
  private sortByPinCount(): void {
    this.components.sort((a, b) => (a.pinCount !== b.pinCount ? b.pinCount - a.pinCount : cmpStr(a.fp.ref, b.fp.ref)));
  }
  buildConnectivity(external: Set<string> = new Set()): void {
    this.externalNets = external;
    this.sortByPinCount();
    const nets = new Map<string, Pin[]>();
    for (const c of this.components) { c.sortPinsByName(); for (const p of c.pins) if (p.net) { const l = nets.get(p.net); if (l) l.push(p); else nets.set(p.net, [p]); } }
    for (const [net, pins] of nets) {
      if (external.has(net)) continue;
      for (const p of pins) for (const p2 of pins) if (p !== p2) p.conns.push(p2);
    }
  }
  /** BuildFromFootprintSet: a channel's graph; rails (caller's, and nets with 2+ pads in both channels) are left out. */
  static fromFootprints(fps: TmFootprint[], other: TmFootprint[] = [], globalNets: Set<string> = new Set()): ConnectionGraph {
    const g = new ConnectionGraph();
    for (const fp of fps) g.addFootprint(fp);
    const local = new Map<string, number>(), oth = new Map<string, number>();
    for (const fp of fps) for (const p of fp.pads) if (p.net) local.set(p.net, (local.get(p.net) || 0) + 1);
    for (const fp of other) for (const p of fp.pads) if (p.net) oth.set(p.net, (oth.get(p.net) || 0) + 1);
    const ext = new Set(globalNets);
    for (const [net, n] of local) if (n >= 2 && (oth.get(net) || 0) >= 2) ext.add(net);
    g.buildConnectivity(ext);
    return g;
  }

  private findMatchingComponents(ref: Component, structural: Component[], structuralReason: MismatchReason, partial: Stage, reasons: MismatchReason[], p: IsoParams): Component[] {
    if (p.cancelled && p.cancelled()) return [];
    reasons.length = 0;
    const matches: Component[] = [];
    const base = baseNetMapping(partial.locked);
    for (const t of structural) {
      if (partial.locked.has(t)) continue;
      const local: MismatchReason = { reference: ref.fp.ref, candidate: t.fp.ref, reason: "" };
      if (netConsistent(base, ref, t, local, this.externalNets)) matches.push(t); else reasons.push(local);
    }
    const sim = new Map<Component, number>();
    for (const m of matches) { let n = 0; for (let i = 0; i < ref.pins.length; i++) if (ref.pins[i].net === m.pins[i].net) n++; sim.set(m, n / ref.pins.length); }
    matches.sort((a, b) => { const sa = sim.get(a)!, sb = sim.get(b)!; if (sa !== sb) return sb - sa; return cmpStr(a.fp.ref, b.fp.ref); });
    if (!matches.length && !reasons.length) {
      if (structuralReason.reason) reasons.push(structuralReason);
      else reasons.push({ reference: ref.fp.ref, candidate: "", reason: "No compatible component found in the target area." });
    }
    return matches;
  }
  private breakTie(ref: Component, matches: Component[]): void {
    if (matches.length <= 1) return;
    if (this.breakTieBySymbolPath(ref, matches)) return;
    this.breakTieByValue(ref, matches);
  }
  private breakTieByValue(ref: Component, matches: Component[]): boolean {
    const v = ref.fp.value; if (!v) return false;
    let hits = 0, idx = -1;
    matches.forEach((m, i) => { if (m.fp.value === v) { if (idx < 0) idx = i; hits++; } });
    if (hits === 1) { toFront(matches, idx); return true; }
    return false;
  }
  private breakTieBySymbolPath(ref: Component, matches: Component[]): boolean {
    if (!ref.fp.path.length) return false;
    let best = 0, count = 0, idx = -1;
    matches.forEach((m, i) => {
      const len = commonPathTailLength(ref.fp.path, m.fp.path);
      if (len > best) { best = len; count = 1; idx = i; } else if (len === best && len > 0) count++;
    });
    if (best === 0 || count !== 1) return false;
    toFront(matches, idx); return true;
  }

  /** FindIsomorphism: the pairing of this (reference) graph's components with the target's, or false with the reasons. */
  findIsomorphism(target: ConnectionGraph, result: ComponentMatches, reasons: MismatchReason[], p: IsoParams = {}): boolean {
    reasons.length = 0;
    if (p.total) p.total(this.components.length);
    if (!this.components.length || !target.components.length) {
      reasons.push({ reference: "", candidate: "", reason: !this.components.length && !target.components.length ? "Neither area has any footprints to match."
        : !this.components.length ? "The reference area has no footprints to match." : "The target area has no footprints to match." });
      return false;
    }
    if (this.components.length !== target.components.length) {
      reasons.push({ reference: "", candidate: "", reason: `The reference area has ${this.components.length} components and the target area has ${target.components.length}.` });
      return false;
    }
    if (!sameFootprintInventory(this.components, target.components, reasons)) return false;
    const numRef = this.components.length;
    const structural: Component[][] = [], structuralReasons: MismatchReason[] = [];
    for (let i = 0; i < numRef; i++) {
      if (p.cancelled && p.cancelled()) return false;
      const ref = this.components[i]; const list: Component[] = []; let bestReason = emptyReason(), bestRank = -1;
      for (const tgt of target.components) {
        const reason = emptyReason();
        if (ref.matchesWith(tgt, reason)) { list.push(tgt); continue; }
        const rank = tgt.reference === ref.reference ? 3 : ref.isSameKind(tgt) ? 2 : Component.prefixesShareCommonBase(ref.prefix, tgt.prefix) ? 1 : 0;
        if (rank >= bestRank) { bestRank = rank; bestReason = reason; }
      }
      structural.push(list); structuralReasons.push(list.length ? emptyReason() : bestReason);
    }
    if (p.cancelled && p.cancelled()) return false;
    const stack: Stage[] = [{ ref: this.components[0], currentMatch: -1, matches: [], locked: new Map(), refIndex: 0 }];
    let nloops = 0;
    const local: MismatchReason[] = [];
    while (stack.length) {
      if (p.cancelled && p.cancelled()) return false;
      nloops++;
      const cur = stack[stack.length - 1];
      for (const [k, v] of cur.locked) if (v === cur.ref) { cur.locked.delete(k); break; }
      if (nloops >= ConnectionGraph.ITER_LIMIT) {
        const r = { reference: "", candidate: "", reason: `Gave up after ${ConnectionGraph.ITER_LIMIT} attempts to pair up the two areas. Either their connections differ, or too many components are interchangeable to tell apart.` };
        reasons.unshift(r);
        return false;
      }
      if (cur.currentMatch < 0) {
        local.length = 0;
        cur.matches = target.findMatchingComponents(cur.ref!, structural[cur.refIndex], structuralReasons[cur.refIndex], cur, local, p);
        if (!cur.matches.length && !reasons.length && local.length) reasons.push(...local);
        cur.currentMatch = 0;
      }
      if (cur.currentMatch === 0 && cur.matches.length > 1) this.breakTie(cur.ref!, cur.matches);
      if (!cur.matches.length) { stack.pop(); continue; }
      if (cur.currentMatch >= cur.matches.length) { stack.pop(); continue; }
      const match = cur.matches[cur.currentMatch];
      cur.currentMatch++;
      cur.locked.set(match, cur.ref!);
      if (p.matched) p.matched(cur.locked.size);
      if (cur.locked.size === this.components.length) {
        result.clear(); reasons.length = 0;
        for (const [tgt, ref] of cur.locked) result.set(ref.fp, tgt.fp);
        return true;
      }
      // MRV: the unlocked component with the fewest candidates goes next
      const lockedRefs = new Set(cur.locked.values());
      let minMatches = Infinity, best: Component | null = null, alt: Component | null = null, bestIdx = 0, altIdx = 0, bestMatches: Component[] = [];
      for (let i = 0; i < this.components.length; i++) {
        const cmp = this.components[i]; if (cmp === cur.ref || lockedRefs.has(cmp)) continue;
        const rs: MismatchReason[] = [];
        const ms = target.findMatchingComponents(cmp, structural[i], structuralReasons[i], cur, rs, p);
        if (ms.length === 1) { best = cmp; bestIdx = i; bestMatches = ms; break; }
        else if (ms.length === 0) { alt = cmp; altIdx = i; if (!reasons.length && rs.length) reasons.push(...rs); }
        else if (ms.length < minMatches) { minMatches = ms.length; best = cmp; bestIdx = i; bestMatches = ms; }
      }
      if (p.cancelled && p.cancelled()) return false;
      const next = stageCopy(cur);
      if (best) { next.ref = best; next.refIndex = bestIdx; next.matches = bestMatches; next.currentMatch = 0; }
      else { next.ref = alt; next.refIndex = altIdx; next.currentMatch = -1; }
      stack.push(next);
    }
    return false;
  }
}
