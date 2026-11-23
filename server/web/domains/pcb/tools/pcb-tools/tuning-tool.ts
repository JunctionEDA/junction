// pcb-tools/tuning-tool.ts — the length tuning tool (DRAWING_TOOL::PlaceTuningPattern).
import type { BoardDoc, Conductor, NetRef, PcbChange, PcbCtx, Pt, TrackLine } from "./types";
import type { Chain, MeanderSettings, MinOptMax, TuneRange } from "./meander";
import { netNameOf, sizesOf } from "./app-state";
import { removedChange, upsertChange } from "./changes";
import { ptKey } from "./connected";
import { settingsOf } from "./dialogs";
import { dpNetPair } from "./diffpair";
import { peq } from "./dragger";
import { netClearance } from "./drc";
import { distSeg } from "./hit";
import type { LDContext, TuneLine, TuningPath } from "./length-delay";
import { IU_PER_PS, assembleTuneLine, assembleTuningPath, boardTrackLength, delayForChain, ldContext, lengthForDelay, netTuningProfileName, origPathDelay, origPathLength } from "./length-delay";
import { DELAY_UNCONSTRAINED, LENGTH_UNCONSTRAINED, TUNE_IU, TUNE_MSG_INSIDE, TUNE_MSG_PICK, TUNE_STATUS_TEXT, chPoints, dpMeanderMove, meanderDefaults, meanderMove, segSide, setTargetLength, setTargetLengthDelay, setTargetSignalLength, setTargetSignalLengthDelay, setTargetSkew, setTargetSkewDelay, splitChain, tuneCopy, veq } from "./meander";
import { boardChainBridging, subtractBridgingClamped } from "./drc-chain";
import { netTable } from "./netlist";
import { chainNets, netChainOf, netOf } from "./nets";
import { segmentNode } from "./nodes";
import { arcTrackNode } from "./posture";
import { setLayer } from "./route-tool";
import { K, S } from "./state";
import { layerOf, pt, r6, widthOf } from "./util";
import { pathHits, routeObstacles } from "./walkaround";

// ---- the tool (DRAWING_TOOL::PlaceTuningPattern, PCB_TUNING_PATTERN::Update / EditFinish)
/** What meanderMove hands back for the pattern as it is; a pair's pattern adds the coupled line's rebuilt chain and base line. */
export type TuneResult = ReturnType<typeof meanderMove> & { finalCoupled?: Chain; baselineCoupled?: Chain };
/** A differential pair's pattern (Tune Length of a Differential Pair): the coupled line, whether the picked line is P, the pair's gap. */
export interface TuneDp { line: TrackLine; net: NetRef; netKey: string; mineIsP: boolean; gap: number; lenMine: number; lenOther: number; delayMine?: number; delayOther?: number }
/** The pattern being placed (S.tune.pattern): the line it tunes, its stretch in mm, its settings and the last result. */
export interface TunePattern {
  item: string; line: TrackLine; layer: string; net: NetRef; netName: string; netKey: string; width: number;
  origin: Pt; end: Pt; cursor: Pt; st: MeanderSettings; clearance: number; lineLength: number; res: TuneResult | null;
  mode: string; coupled: number | null; dpGap?: number; dp?: TuneDp | null;
  /** origPathDelay (attoseconds), the length calculator, the skew placer's m_lastLength / m_lastDelay (mm, as) and m_coupledDelay */
  lineDelay?: number; ld?: LDContext | null; lastLength?: number; lastDelay?: number; coupledDelay?: number | null;
  /** m_hasRuleTarget (a custom rule set the targets at CreateNew) and the placer's chain extras (initChainExtras at Start) */
  hasRuleTarget?: boolean; chainEx?: ChainExtras | null;
}
/** The track under the cursor before the first click (S.tune.picker): its id. */
export type TunePicker = string;
S.tuneSettings = { single: meanderDefaults(), diffpair: meanderDefaults(), skew: meanderDefaults() };   // BOARD_DESIGN_SETTINGS::m_SingleTrackMeanderSettings, m_DiffPairMeanderSettings, m_SkewMeanderSettings
export const TUNE_TOOLS = new Set(["tunesingle", "tunediff", "tuneskew"]);
export const isTuneTool = (t: string | null | undefined) => TUNE_TOOLS.has(t!);
export const tuneMode = (): "single" | "diffpair" | "skew" => S.modTool === "tuneskew" ? "skew" : S.modTool === "tunediff" ? "diffpair" : "single";
export const TUNE_MSG_DP_NETS = "Unable to find complementary differential pair net for length tuning. Make sure the names of the nets belonging to a differential pair end with either _N/_P or +/-.";
/** The generator's tuning_mode for a tuner mode. */
export const tuningModeName = (mode: string) => mode === "skew" ? "diff_pair_skew" : mode === "diffpair" ? "diff_pair" : "single";
/**
 * TOPOLOGY::AssembleDiffPair from a picked track: the coupled net's nearest track on the same layer (findNItem), its
 * line, and the pair's gap from the two parallel segments (|refDir × displacement| / |refDir| - width).  null when
 * the net has no partner or the partner has no track there.
 */
export function assembleDiffPair(doc: BoardDoc, item: KItem, line: TrackLine) {
  const pair = dpNetPair(doc, line.net); if (!pair) return null;
  const NT = netTable(doc); const kP = NT.key(pair.P), other = kP === line.netKey ? pair.N : pair.P, otherKey = NT.key(other);
  const a = pt(item.node, "start")!, b = pt(item.node, "end")!, mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" || layerOf(it.node) !== line.layer || NT.key(netOf(it.node)) !== otherKey) continue;
    const c = pt(it.node, "start"), d = pt(it.node, "end"); if (!c || !d) continue;
    const dd = distSeg(mid[0], mid[1], c[0], c[1], d[0], d[1]); if (dd < bd) { bd = dd; best = it; }
  }
  if (!best) return null;
  const ln = tuneTrackLine(doc, best); if (!ln) return null;
  const c = pt(best.node, "start")!, dir = [b[0] - a[0], b[1] - a[1]], n = Math.hypot(dir[0], dir[1]) || 1;
  const gap = Math.abs(dir[0] * (c[1] - a[1]) - dir[1] * (c[0] - a[0])) / n - line.width;
  return { line: ln, net: other, netKey: otherKey, mineIsP: kP === line.netKey, gap: r6(gap), item: best };
}
export const TUNE_MSG_SKEW_PICK = "Please select a differential pair track you want to tune.";
export const TUNE_MSG_SKEW_NETS = "Unable to find complementary differential pair net for skew tuning. Make sure the names of the nets belonging to a differential pair end with either _N/_P or +/-.";
/**
 * NODE::AssembleLine for the tuner (arcs kept, locked tracks end the line): a TrackLine whose pts are the chain's
 * nodes and whose ch is the chain itself.
 */
export function tuneTrackLine(doc: BoardDoc, item: KItem, followLocked = false): TrackLine | null {
  const l = assembleTuneLine(doc, item, followLocked); if (!l) return null;
  return { ids: l.ids, pts: l.ch.map((n) => n.p.slice()), ch: l.ch, index: l.ids.indexOf(item.id), width: l.width, layer: l.layer, net: netOf(item.node), netKey: l.net };
}
/** MEANDER_PLACER::origPathLength / origPathDelay of a track's tuning path (TOPOLOGY::AssembleTuningPath): mm and attoseconds. */
export function tuningPathLength(ld: LDContext, id: string): { length: number; delay: number; path: TuningPath } {
  const path = assembleTuningPath(ld, id); return { length: origPathLength(ld, path), delay: origPathDelay(ld, path), path };
}
/** MEANDER_SKEW_PLACER::Start: the routed length of the pair's other line (the tuning path through the nearest of its tracks). */
export function coupledLength(doc: BoardDoc, pair: { P: NetRef; N: NetRef }, mineKey: string, near: Pt, ld?: LDContext | null) { return coupledPath(doc, pair, mineKey, near, ld).length; }
export function coupledPath(doc: BoardDoc, pair: { P: NetRef; N: NetRef }, mineKey: string, near: Pt, ld?: LDContext | null) {
  const NT = netTable(doc); const kP = NT.key(pair.P), other = kP === mineKey ? NT.key(pair.N) : kP;
  let best: KItem | null = null, bd = Infinity;
  for (const it of doc.items.values()) {
    if ((it.kind !== "segment" && it.kind !== "arc") || NT.key(netOf(it.node)) !== other) continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
    const d = distSeg(near[0], near[1], a[0], a[1], b[0], b[1]); if (d < bd) { bd = d; best = it; }
  }
  if (!best) return { length: 0, delay: 0 };
  const r = tuningPathLength(ld || ldContext(doc, S.settingsCache || S.settings!), best.id); return { length: r.length, delay: r.delay };
}
/** The length target doMove works to: the pattern's own, or for skew the coupled length plus the skew (MEANDER_SKEW_PLACER::Move). */
/**
 * calculateTimeDomainTargets (MEANDER_PLACER / DP_MEANDER_PLACER): in the time domain the length target is the
 * current length moved by the track length the delay difference takes; MEANDER_SKEW_PLACER's calculateTargetSkew the
 * same for the skew.  Lengths in IU, delays in attoseconds; g is the TUNING_PROFILE_GEOMETRY_CONTEXT.
 */
export function timeDomainTargets(ld: LDContext, st: MeanderSettings, g: { net: string; layer: string; width: number; coupled: boolean; gap: number },
  cur: { length: number; delay: number }, skew?: { lastLength: number; lastDelay: number; coupledLength: number; coupledDelay: number } | null, extraDelay = 0) {
  if (!st.isTimeDomain) return;
  const L = (d: number) => Math.trunc(lengthForDelay(ld, d, g) * TUNE_IU);
  if (skew) {
    const target = (td: number) => { const diff = td - (skew.lastDelay - skew.coupledDelay); const len = L(Math.abs(diff)); return Math.trunc(skew.lastLength - skew.coupledLength + (diff > 0 ? len : -len)); };
    st.skew = { min: target(st.skewDelay.min), opt: target(st.skewDelay.opt), max: target(st.skewDelay.max) };
    return;
  }
  // cur.delay is origPathDelay (the chain's aggregate: it carries m_signalExtraDelay, the other nets of the chain, on a
  // single track); a chain-level target (m_targetSignalLengthDelay) is turned into this net's share and compared with
  // the net's own delay
  const sig = st.signalTargetDelay, useSignal = !!sig && sig.opt !== DELAY_UNCONSTRAINED;
  const d = useSignal ? { min: Math.max(0, sig!.min - extraDelay), opt: Math.max(0, sig!.opt - extraDelay), max: 0 } : st.targetDelay;
  if (useSignal) d.max = Math.max(d.opt, sig!.max - extraDelay);
  const curDelay = useSignal ? cur.delay - extraDelay : cur.delay;
  const diffOpt = d.opt - curDelay;
  const lMin = L(d.opt - d.min), lMax = L(d.max - d.opt); let lOpt = L(Math.abs(diffOpt)); lOpt = diffOpt > 0 ? lOpt : -lOpt;
  st.target = { min: cur.length + lOpt - lMin, opt: cur.length + lOpt, max: cur.length + lOpt + lMax };
}
export function tuneTarget(st: MeanderSettings, coupled: number | null | undefined, chainOffset = 0): TuneRange {
  if (coupled == null) return st.target;
  // MEANDER_SKEW_PLACER::Move: the chain extras and the active net's unmeasured stub are the chain's, not the meander's
  const c = coupled * TUNE_IU - chainOffset; return { min: c + st.skew.min, opt: c + st.skew.opt, max: c + st.skew.max };
}

// ---- the net chain target (PCB_TUNING_PATTERN::CreateNew's NET_CHAIN_LENGTH_CONSTRAINT, MEANDER_PLACER_BASE::initChainExtras /
// chainNarrowingOffset, MEANDER_PLACER::Move / DP_MEANDER_PLACER::Move's per-net budget)
const isBoardTrack = (c: Conductor) => c.kind === "segment" || c.kind === "arc" || c.kind === "via";
/** The net's first PCB_TRACK in BOARD::Tracks() order (a track, an arc or a via), or null. */
export const netRepTrack = (ld: LDContext, net: string) => ld.conds.find((c) => isBoardTrack(c) && c.net === net) || null;
/**
 * PNS_KICAD_IFACE_BASE::GetSignalAggregate: the routed length (IU) and delay (as) of every other net of the chain the
 * two nets share (BOARD::GetTrackLength of each net's first track, pad-to-die included).  valid is false when the
 * first net is on no chain or the second is on another.
 */
export function signalAggregate(ld: LDContext, netP: string, netN: string) {
  const doc = ld.doc; const sig = netChainOf(doc, netP);
  if (!sig || sig !== netChainOf(doc, netN)) return { valid: false, length: 0, delay: 0 };
  let length = 0, delay = 0;
  for (const net of chainNets(doc, sig)) {
    if (net === netP || net === netN) continue;
    const rep = netRepTrack(ld, net); if (!rep) continue;
    const r = boardTrackLength(ld, rep.id);
    length += Math.round((r.length + r.padToDie) * TUNE_IU);
    if (r.delay > 0 || r.padToDieDelay > 0) delay += Math.round(r.delay + r.padToDieDelay);
  }
  return { valid: true, length, delay };
}
/** PNS_KICAD_IFACE_BASE::GetNetBoardLength: the routed length (IU) of the net's first track, pad-to-die included. */
export function netBoardLength(ld: LDContext, net: string) {
  const rep = netRepTrack(ld, net); if (!rep) return 0;
  const r = boardTrackLength(ld, rep.id); return Math.round((r.length + r.padToDie) * TUNE_IU);
}
/** The placer's chain extras: m_chainExtrasLength (IU), m_chainExtrasDelay (as) and chainNarrowingOffset() (IU). */
export interface ChainExtras { length: number; delay: number; offset: number }
/**
 * MEANDER_PLACER_BASE::initChainExtras + chainNarrowingOffset for the placer's CurrentNets() (the tuned net first) and
 * its m_startPathLength (IU): the other nets of the chain, plus the tuned net's copper the tuning path does not measure.
 */
export function chainExtras(ld: LDContext, nets: string[], startPathLength: number): ChainExtras {
  if (!nets.length) return { length: 0, delay: 0, offset: 0 };
  const a = signalAggregate(ld, nets[0], nets.length >= 2 ? nets[1] : nets[0]);
  const unmeasured = Math.max(0, netBoardLength(ld, nets[0]) - startPathLength);
  return { length: a.length, delay: a.delay, offset: a.length + unmeasured };
}
/**
 * MEANDER_PLACER::Move / DP_MEANDER_PLACER::Move: with a chain target (m_targetSignalLength) the net's budget is the
 * chain's less the rest of the chain; it becomes the length target, or narrows the net's own (the tighter of both).
 */
export function chainBudget(st: MeanderSettings, otherLen: number) {
  const sig = st.signalTarget; if (!sig || sig.opt === LENGTH_UNCONSTRAINED) return;
  const bMin = Math.max(0, sig.min - otherLen), bOpt = Math.max(0, sig.opt - otherLen), bMax = Math.max(bOpt, sig.max - otherLen);
  if (st.target.opt === LENGTH_UNCONSTRAINED) st.target = { min: bMin, opt: bOpt, max: bMax };
  else st.target = { min: Math.max(st.target.min, bMin), opt: Math.min(st.target.opt, bOpt), max: Math.min(st.target.max, bMax) };
}
/** A rule's value as DRC_CONSTRAINT's MINOPTMAX<int> holds it: nm for a length, attoseconds for a delay (both 1e6 per mm / ps). */
export const ruleMinOptMax = (c: { min: number | null; opt: number | null; max: number | null }): MinOptMax => {
  const raw = (v: number | null) => (v == null ? null : Math.round(v * TUNE_IU)); return { min: raw(c.min), opt: raw(c.opt), max: raw(c.max) };
};
const moOpt = (c: MinOptMax) => (c.opt != null ? c.opt : c.min != null ? c.min : 0);
/** MEANDER_SETTINGS::SetTarget*( const MINOPTMAX<int>& ): the setter with Opt(), then the constraint's own min / max. */
export function setTargetMO(st: MeanderSettings, field: "target" | "targetDelay" | "skew" | "skewDelay", mo: MinOptMax) {
  const set = field === "target" ? setTargetLength : field === "targetDelay" ? setTargetLengthDelay : field === "skew" ? setTargetSkew : setTargetSkewDelay;
  set(st, moOpt(mo)); if (mo.min != null) st[field].min = mo.min; if (mo.max != null) st[field].max = mo.max;
}
/**
 * PCB_TUNING_PATTERN::ApplyToolSettings: the tool's settings onto a pattern, keeping its chain target unless the tool
 * overrides custom rules, its rule targets when a rule set them, and its time domain flag (the side stays the pattern's).
 */
export function applyToolSettings(T: Pick<TunePattern, "st" | "hasRuleTarget">, tool: MeanderSettings) {
  const o = T.st, st = tuneCopy(tool);
  if (!tool.overrideCustomRules) { st.signalTarget = Object.assign({}, o.signalTarget); st.signalTargetDelay = Object.assign({}, o.signalTargetDelay); }
  if (T.hasRuleTarget && !tool.overrideCustomRules) {
    st.target = Object.assign({}, o.target); st.targetDelay = Object.assign({}, o.targetDelay); st.skew = Object.assign({}, o.skew); st.skewDelay = Object.assign({}, o.skewDelay);
  }
  if (!tool.overrideCustomRules) st.isTimeDomain = o.isTimeDomain;
  st.initialSide = o.initialSide; T.st = st;
}
type RuleHit = NonNullable<ReturnType<NonNullable<typeof S.ruleConstraint>>>;
/** The track the tuner picks under the cursor: GENERAL_COLLECTOR on tracks and arcs, 5 px, the nearest centre wins. */
export function tunePick(ctx: PcbCtx, mm: Pt) {
  const doc = ctx.doc; const thr = 5 * (S.mmPerPx || 0.05); const active = S.layer; const hits: { it: KItem; d2: number; onActive: boolean }[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "segment" && it.kind !== "arc") continue;
    const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
    const w = widthOf(it.node, 0.25);
    let d: number, centre: Pt;
    if (it.kind === "arc") { const m = pt(it.node, "mid"); const c = m && K.arcFrom3(a, m, b); centre = m || a; d = c ? Math.abs(Math.hypot(mm[0] - c.x, mm[1] - c.y) - c.r) : distSeg(mm[0], mm[1], a[0], a[1], b[0], b[1]); }
    else { centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; d = distSeg(mm[0], mm[1], a[0], a[1], b[0], b[1]); }
    if (d > w / 2 + thr) continue;
    hits.push({ it, d2: (mm[0] - centre[0]) ** 2 + (mm[1] - centre[1]) ** 2, onActive: layerOf(it.node) === active });
  }
  if (!hits.length) return null;
  const pool = hits.some((h) => h.onActive) ? hits.filter((h) => h.onActive) : hits;   // GuessSelectionCandidates: the active layer first
  pool.sort((x, y) => x.d2 - y.d2); return pool[0].it;
}
/** The tuning pattern a track belongs to (its parent group is a PCB_TUNING_PATTERN), or null. */
export function tuningPatternOf(doc: BoardDoc, id: string) {
  for (const it of doc.items.values()) if (it.kind === "generated" && /^tuning_pattern$/.test(K.str((K.kid(it.node, "type") || [])[1])) && K.groupMemberIds(it.node).includes(id)) return it;
  return null;
}
/** PCB_TUNING_PATTERN::CreateNew + the first click: anchored on the track's nearest point. */
export function tuneBegin(ctx: PcbCtx, item: KItem, mm: Pt) {
  const doc = ctx.doc;
  const skew = tuneMode() === "skew", dual = tuneMode() === "diffpair";
  if (tuningPatternOf(doc, item.id)) { ctx.toast(TUNE_MSG_INSIDE); return; }
  if (item.kind !== "segment" && item.kind !== "arc") { ctx.toast(skew ? TUNE_MSG_SKEW_PICK : TUNE_MSG_PICK); return; }   // OfKind( SEGMENT_T | ARC_T )
  const line = tuneTrackLine(doc, item); if (!line) { ctx.toast(skew ? TUNE_MSG_SKEW_PICK : TUNE_MSG_PICK); return; }
  const pair = skew ? dpNetPair(doc, line.net) : null;
  if (skew && !pair) { ctx.toast(TUNE_MSG_SKEW_NETS); return; }
  const dpa = dual ? assembleDiffPair(doc, item, line) : null;
  if (dual && (!dpa || tuningPatternOf(doc, dpa.item.id))) { ctx.toast(dpa ? TUNE_MSG_INSIDE : TUNE_MSG_DP_NETS); return; }
  if (layerOf(item.node) !== S.layer) setLayer(ctx, layerOf(item.node));   // m_frame->SetActiveLayer( pickerItem layer )
  const at = nearestOnChain(line.ch!, mm).q;   // GetSnappedStartPoint
  const s = settingsOf(ctx); const ld = ldContext(doc, s);
  const st = tuneCopy(S.tuneSettings[tuneMode()]);
  const mine = tuningPathLength(ld, item.id);
  const cp = pair ? coupledPath(doc, pair, line.netKey, at, ld) : null;
  S.tune.pattern = { item: item.id, line, layer: line.layer, net: line.net, netName: netNameOf(ctx, line.net), netKey: line.netKey, width: line.width, origin: at, end: at, cursor: mm.slice(), st,
    clearance: netClearance(s, line.netKey), lineLength: mine.length, lineDelay: mine.delay, ld, res: null, mode: tuneMode(),
    coupled: cp ? cp.length : null, coupledDelay: cp ? cp.delay : null, lastLength: mine.length, lastDelay: mine.delay };
  S.tune.pattern.hasRuleTarget = patternTargets(ld, st, tuneMode(), item, dpa ? dpa.item : null);
  let nets = [line.netKey];   // the placer's CurrentNets()
  if (dpa) {
    const other = tuningPathLength(ld, dpa.item.id);
    S.tune.pattern.dp = { line: dpa.line, net: dpa.net, netKey: dpa.netKey, mineIsP: dpa.mineIsP, gap: dpa.gap, lenMine: mine.length, lenOther: other.length, delayMine: mine.delay, delayOther: other.delay };
    S.tune.pattern.lineLength = Math.max(mine.length, other.length);   // origPathLength
    S.tune.pattern.lineDelay = Math.max(mine.delay, other.delay);   // origPathDelay
    S.tune.pattern.dpGap = dpa.gap;
    nets = dpa.mineIsP ? [line.netKey, dpa.netKey] : [dpa.netKey, line.netKey];   // DP_MEANDER_PLACER: P, N
  } else if (pair) { const NT = netTable(doc), kP = NT.key(pair.P); nets = [line.netKey, kP === line.netKey ? NT.key(pair.N) : kP]; }   // MEANDER_SKEW_PLACER: active, coupled
  S.tune.pattern.chainEx = chainExtras(ld, nets, S.tune.pattern.lineLength * TUNE_IU);   // Start: initChainExtras, m_startPathLength
}
/** The nearest point of a chain (mm, arcs kept) to p and its piece. */
export function nearestOnChain(ch: Chain, p: Pt) {
  const I = (q: Pt) => [q[0] * TUNE_IU, q[1] * TUNE_IU], M = (q: Pt) => [q[0] / TUNE_IU, q[1] / TUNE_IU];
  const sp = splitChain(ch.map((n) => (n.m ? { p: I(n.p), m: I(n.m) } : { p: I(n.p) })), I(p), I(p));
  return { q: M(sp.start) };
}
/**
 * PCB_TUNING_PATTERN::CreateNew's targets: a custom rule's (applyRuleTarget, its time domain option choosing the
 * delay target), otherwise the tool's own; with no rule a netclass tuning profile with time domain tuning enabled
 * turns the pattern to the time domain.
 */
export function patternTargets(ld: LDContext, st: MeanderSettings, mode: string, a: KItem | null, b: KItem | null) {
  const skew = mode === "skew" || mode === "diff_pair_skew";
  if (!skew && a && !st.overrideCustomRules && S.ruleConstraint) return lengthRuleTargets(ld, st, mode, a, b);
  if (applyRuleTarget(ld.doc, st, mode, a, b)) return true;
  if (!skew && !st.overrideCustomRules && a) { const p = profileName(ld, a); if (p && p.enableTimeDomain) st.isTimeDomain = true; }
  return false;
}
/**
 * CreateNew for a single track or a pair (then ApplyToolSettings without Override Custom Rules): the net's length
 * rule is its target; a net chain length rule (net_chain_length) on the net's chain is the chain target
 * (SetTargetSignalLength, or SetTargetSignalLengthDelay in the time domain) less the chain's bridging through its
 * series parts, from which the placer derives the net's budget; the chain's time domain option wins.  A chain rule
 * alone leaves the net's targets unconstrained.  Rules with severity ignore do not count.  True when a rule applied
 * (m_hasRuleTarget).
 */
function lengthRuleTargets(ld: LDContext, st: MeanderSettings, mode: string, a: KItem, b: KItem | null) {
  const doc = ld.doc; const live = <C extends { severity?: string | null }>(c: C | null) => (c && c.severity !== "ignore" ? c : null);
  const netC = live(S.ruleConstraint!(doc, "length", a, b)), chainC = live(S.ruleConstraint!(doc, "net_chain_length", a, b));
  let td = netC ? !!netC.timeDomain : false, ruled = false;
  if (chainC) {
    const chain = netChainOf(doc, netTable(doc).key(netOf(a.node)));
    if (chain) {
      td = !!chainC.timeDomain;
      const mo = ruleMinOptMax(chainC);
      const [bl, bd] = boardChainBridging(doc, ld, chain);   // GetCachedBridgingLength: BoardChainBridging
      const bridging = Math.trunc(bl * TUNE_IU);
      if (bridging > 0) {   // so the copper-only budget agrees with the DRC check
        const d = td ? Math.trunc(bd) : bridging;
        if (mo.min != null) mo.min = subtractBridgingClamped(mo.min, d);
        if (mo.opt != null) mo.opt = subtractBridgingClamped(mo.opt, d);
        if (mo.max != null) mo.max = subtractBridgingClamped(mo.max, d);
      }
      ruled = true;
      if (td) setTargetSignalLengthDelay(st, mo); else setTargetSignalLength(st, mo);
    }
  }
  if (netC) { applyRuleTarget(doc, st, mode, a, b, td, netC); ruled = true; }
  else {
    if (ruled) { setTargetLength(st, LENGTH_UNCONSTRAINED); setTargetLengthDelay(st, DELAY_UNCONSTRAINED); }   // the pattern's own targets stay unconstrained
    if (td) st.isTimeDomain = true;   // chain only: the placer derives the targets
    else { const p = profileName(ld, a); if (p && p.enableTimeDomain) st.isTimeDomain = true; }
  }
  return ruled;
}
const profileName = (ld: LDContext, a: KItem) => { const nk = netTable(ld.doc).key(netOf(a.node)); return ld.profiles.get(netTuningProfileName(ld.s, nk)) || null; };
/**
 * PCB_TUNING_PATTERN::Update without Override Custom Rules: a matching custom rule's length (or, for skew, its skew)
 * constraint becomes the target (MEANDER_SETTINGS::SetTargetLength( MINOPTMAX ): opt, then its min / max when given;
 * a rule without opt has MINOPTMAX's Opt() = Min()).  True when a rule applied.
 */
export function applyRuleTarget(doc: BoardDoc, st: MeanderSettings, mode: string, a: KItem | null, b: KItem | null, timeDomain?: boolean, rule?: RuleHit | null) {
  if (st.overrideCustomRules || !S.ruleConstraint || !a) return false;
  const skew = mode === "skew" || mode === "diff_pair_skew";
  const c = rule || S.ruleConstraint(doc, skew ? "skew" : "length", a, b); if (!c) return false;
  const opt = c.opt != null ? c.opt : c.min != null ? c.min : 0;
  if (timeDomain ?? c.timeDomain) {   // DRC_CONSTRAINT::OPTIONS::TIME_DOMAIN: the values are delays (ps)
    const D = (v: number) => Math.round(v * IU_PER_PS);
    if (skew) { setTargetSkew(st, 0); setTargetSkewDelay(st, D(opt)); if (c.min != null) st.skewDelay.min = D(c.min); if (c.max != null) st.skewDelay.max = D(c.max); }
    else { setTargetLength(st, LENGTH_UNCONSTRAINED); setTargetLengthDelay(st, D(opt)); if (c.min != null) st.targetDelay.min = D(c.min); if (c.max != null) st.targetDelay.max = D(c.max); }
    st.isTimeDomain = true; return true;
  }
  const I = (v: number) => Math.round(v * TUNE_IU);
  if (skew) { setTargetSkew(st, I(opt)); if (c.min != null) st.skew.min = I(c.min); if (c.max != null) st.skew.max = I(c.max); setTargetSkewDelay(st, 0); }
  else { setTargetLength(st, I(opt)); if (c.min != null) st.target.min = I(c.min); if (c.max != null) st.target.max = I(c.max); setTargetLengthDelay(st, DELAY_UNCONSTRAINED); }
  st.isTimeDomain = false; return true;
}
/** PCB_TUNING_PATTERN::EditStart + Update for the pattern as it is: the side from the end, then MEANDER_PLACER::Move. */
/** A TrackLine's chain in IU (its arcs kept when it has them). */
export const lineChainIU = (ln: TrackLine): Chain => (ln.ch || ln.pts.map((p): Chain[number] => ({ p }))).map((n) => (n.m ? { p: [n.p[0] * TUNE_IU, n.p[1] * TUNE_IU], m: [n.m[0] * TUNE_IU, n.m[1] * TUNE_IU] } : { p: [n.p[0] * TUNE_IU, n.p[1] * TUNE_IU] }));
/** The pattern's targets for MEANDER_PLACER::Move: the skew window around the coupled length, or the time domain targets. */
export function moveSettings(T: Pick<TunePattern, "st" | "coupled" | "ld" | "netKey" | "layer" | "width" | "lineLength" | "lineDelay" | "dp" | "dpGap" | "lastLength" | "lastDelay" | "coupledDelay" | "chainEx">) {
  const st = tuneCopy(T.st); st.keepEndpoints = true;
  const ex = T.chainEx || null;
  if (T.coupled == null) chainBudget(st, ex ? ex.offset : 0);   // the net's share of a chain target
  if (st.isTimeDomain && T.ld) {
    const g = { net: T.netKey, layer: T.layer, width: T.width, coupled: T.coupled != null || !!T.dp, gap: T.dp ? T.dp.gap : T.dpGap || 0 };
    if (T.coupled != null) timeDomainTargets(T.ld, st, g, { length: 0, delay: 0 }, { lastLength: (T.lastLength ?? T.lineLength) * TUNE_IU, lastDelay: T.lastDelay ?? T.lineDelay ?? 0, coupledLength: T.coupled * TUNE_IU, coupledDelay: T.coupledDelay || 0 });
    else timeDomainTargets(T.ld, st, g, { length: Math.round(T.lineLength * TUNE_IU), delay: placerPathDelay(T) }, null, ex ? ex.delay : 0);
  }
  st.target = tuneTarget(st, T.coupled, ex ? ex.offset : 0); return st;
}
/**
 * The placer's origPathDelay: MEANDER_PLACER's carries m_signalExtraDelay (the chain's other nets, set by Move), a
 * pair's (DP_MEANDER_PLACER) and the skew placer's do not.
 */
export const placerPathDelay = (T: Pick<TunePattern, "lineDelay" | "dp" | "coupled" | "chainEx">) => (T.lineDelay || 0) + (!T.dp && T.coupled == null && T.chainEx ? T.chainEx.delay : 0);
/** CalculateDelayForShapeLineChain on an IU chain through the pattern's geometry context. */
export const chainDelayIU = (ld: LDContext, g: { net: string; layer: string }) => (ch: Chain) => delayForChain(ld, ch.map((n) => (n.m ? { p: [n.p[0] / TUNE_IU, n.p[1] / TUNE_IU], m: [n.m[0] / TUNE_IU, n.m[1] / TUNE_IU] } : { p: [n.p[0] / TUNE_IU, n.p[1] / TUNE_IU] })), g);
export function tuneUpdate(ctx: PcbCtx) {
  const T = S.tune.pattern; if (!T) return;
  const ln = T.line; const ch = lineChainIU(ln);
  const I = (p: Pt) => [p[0] * TUNE_IU, p[1] * TUNE_IU];
  // the end snaps onto the line (SnapToNearestTrack on the net); the side is the cursor's against the baseline's last leg
  T.end = nearestOnChain(ln.ch || ln.pts.map((p) => ({ p })), T.cursor).q;
  if (peq(T.end, T.origin)) { T.res = null; return; }
  const sp = splitChain(ch, I(T.origin), I(T.end));
  let last = sp.mid.length >= 2 ? { A: sp.mid[sp.mid.length - 2].p, B: sp.mid[sp.mid.length - 1].p } : null;
  if (last && T.dp) {   // the side against the pair's centre line: the base line's last leg moved halfway to the coupled one's end
    const spc = splitChain(lineChainIU(T.dp.line), I(T.origin), I(T.end)); const off = [(spc.end[0] - sp.end[0]) / 2, (spc.end[1] - sp.end[1]) / 2];
    last = { A: [last.A[0] + off[0], last.A[1] + off[1]], B: [last.B[0] + off[0], last.B[1] + off[1]] };
  }
  if (last && !veq(last.A, last.B)) T.st.initialSide = segSide(last, I(T.cursor)) < 0 ? -1 : 1;   // UpdateSideFromEnd
  const st = moveSettings(T);
  // m_settings = placer->MeanderSettings(): the net's budget derived from a chain target is the pattern's length target now
  if (T.coupled == null && !st.isTimeDomain && T.st.signalTarget && T.st.signalTarget.opt !== LENGTH_UNCONSTRAINED) T.st.target = Object.assign({}, st.target);
  const delayOf = st.isTimeDomain && T.ld ? chainDelayIU(T.ld, { net: T.netKey, layer: T.layer }) : null;
  const doc = ctx.doc; const O = routeObstacles(doc, settingsOf(ctx), T.netKey, T.layer);
  const r = T.width / 2;
  if (T.dp) {
    const dp = T.dp, skip = new Set(dp.line.ids);
    const Od = routeObstacles(doc, settingsOf(ctx), T.netKey, T.layer, null, skip);   // both lines are lifted out of the world
    const hits = (ch: Chain) => pathHits(Od, chPoints(ch).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]), r).length > 0;
    T.res = tuneDp(T, st, I, hits, delayOf);
    T.st.initialSide = st.initialSide; return;
  }
  const collides = (c: Chain) => pathHits(O, chPoints(c).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]), r).length > 0;
  T.res = meanderMove({ pts: chPoints(ch), ch, origin: I(T.origin), end: I(T.end), cursor: I(T.cursor), st, width: Math.round(T.width * TUNE_IU), clearance: Math.round(T.clearance * TUNE_IU), lineLength: T.lineLength * TUNE_IU,
    lineDelay: T.coupled == null ? placerPathDelay(T) : T.lineDelay || 0, delayOf, collides });
  if (T.coupled != null) { T.lastLength = T.res.length / TUNE_IU; T.lastDelay = T.res.delay; }   // the skew placer's m_lastLength / m_lastDelay
  T.st.initialSide = st.initialSide;   // flipInitialSide reaches the pattern's settings (m_settings = placer->MeanderSettings())
}
/** DP_MEANDER_PLACER::Move for a pair's pattern, its result in the picked line's terms (final / baseline its own, *Coupled the other's). */
export function tuneDp(T: Pick<TunePattern, "line" | "origin" | "end" | "cursor" | "width" | "clearance" | "dp">, st: MeanderSettings, I: (p: Pt) => Pt, collides: (ch: Chain) => boolean, delayOf?: ((ch: Chain) => number) | null): TuneResult {
  const dp = T.dp!; const chM = lineChainIU(T.line), chO = lineChainIU(dp.line); const mine = chPoints(chM), other = chPoints(chO);
  const lineDelay = Math.max(dp.delayMine || 0, dp.delayOther || 0);
  const r = dpMeanderMove({ ptsP: dp.mineIsP ? mine : other, ptsN: dp.mineIsP ? other : mine, chP: dp.mineIsP ? chM : chO, chN: dp.mineIsP ? chO : chM, origin: I(T.origin), end: I(T.end), cursor: I(T.cursor), st,
    width: Math.round(T.width * TUNE_IU), gap: Math.round(dp.gap * TUNE_IU), clearance: Math.round(T.clearance * TUNE_IU),
    lengthP: (dp.mineIsP ? dp.lenMine : dp.lenOther) * TUNE_IU, lengthN: (dp.mineIsP ? dp.lenOther : dp.lenMine) * TUNE_IU, lineDelay, delayOf, collides });
  const P = dp.mineIsP;
  return { final: P ? r.finalP : r.finalN, finalCoupled: P ? r.finalN : r.finalP, tuned: P ? r.tunedP : r.tunedN, status: r.status, length: r.length, delay: r.delay, hasMeanders: r.hasMeanders,
    settings: r.settings, start: r.start, end: r.end, baseline: P ? r.baselineP : r.baselineN, baselineCoupled: P ? r.baselineN : r.baselineP };
}
/** The rebuilt line's pieces in mm: [{ a, b }] and [{ a, m, b }] for arcs. */
export function tunePieces(ch: Chain) {
  const out: { a: Pt; m?: Pt; b: Pt }[] = []; const M = (p: Pt) => [r6(p[0] / TUNE_IU), r6(p[1] / TUNE_IU)];
  for (let i = 1; i < ch.length; i++) { const a = M(ch[i - 1].p), b = M(ch[i].p); if (peq(a, b)) continue; out.push(ch[i].m ? { a, m: M(ch[i].m!), b } : { a, b }); }
  return out;
}
export const sexprQ = (s: unknown) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
export const fmtG = (v: number | string) => { const x = +(+v).toPrecision(10); return String(x === 0 ? 0 : x); };
/**
 * PCB_IO_KICAD_SEXPR::formatPolyPts for a chain in mm: (xy …) for the points, one (arc (start) (mid) (end)) for each
 * arc (its start and end points are not written again).
 */
export function polyPtsText(ch: Chain) {
  const xy = (p: Pt) => `(xy ${fmtG(p[0])} ${fmtG(p[1])})`, P = (k: string, p: Pt) => `(${k} ${fmtG(p[0])} ${fmtG(p[1])})`;
  const out: string[] = [];
  for (let i = 0; i < ch.length; i++) {
    const nx = ch[i + 1];
    if (nx && nx.m) out.push(`(arc ${P("start", ch[i].p)} ${P("mid", nx.m)} ${P("end", nx.p)})`);
    else if (!ch[i].m) out.push(xy(ch[i].p));
  }
  return `(pts ${out.join(" ")})`;
}
/** An IU chain in mm, rounded as the file keeps it. */
export const chainMM = (ch: Chain): Chain => ch.map((n) => (n.m ? { p: [r6(n.p[0] / TUNE_IU), r6(n.p[1] / TUNE_IU)], m: [r6(n.m[0] / TUNE_IU), r6(n.m[1] / TUNE_IU)] } : { p: [r6(n.p[0] / TUNE_IU), r6(n.p[1] / TUNE_IU)] }));
/** PCB_TUNING_PATTERN's (generated …) node, its properties in STRING_ANY_MAP (alphabetical) order as PCB_IO_KICAD_SEXPR writes them. */
export function tuningPatternNode(T: Pick<TunePattern, "st" | "dpGap" | "netName" | "width" | "mode" | "layer"> & { st?: MeanderSettings | null }, res: TuneResult, members: string[]) {
  const coupled = res.baselineCoupled ? chainMM(res.baselineCoupled) : null;
  const st = T.st ? Object.assign({}, res.settings, { target: T.st.target, skew: T.st.skew, targetDelay: T.st.targetDelay, isTimeDomain: T.st.isTimeDomain }) : res.settings; const mm = (v: number) => fmtG(v / TUNE_IU); const xy = (p: Pt) => `(xy ${fmtG(p[0])} ${fmtG(p[1])})`;
  const baseCh = chainMM(res.baseline), base = baseCh.map((n) => n.p);
  const td = st.targetDelay || { min: 0, opt: DELAY_UNCONSTRAINED, max: DELAY_UNCONSTRAINED }, ps = (v: number) => fmtG(v / IU_PER_PS);
  const side = st.initialSide < 0 ? "left" : st.initialSide > 0 ? "right" : "default";
  const yn = (b: boolean) => b ? "yes" : "no";
  const props = [
    `(base_line ${polyPtsText(baseCh)})`, ...(coupled && coupled.length >= 2 ? [`(base_line_coupled ${polyPtsText(coupled)})`] : []), `(corner_radius_percent ${st.crPct})`, `(end ${xy(base[base.length - 1])})`,
    `(initial_side ${sexprQ(side)})`, `(is_time_domain ${yn(!!st.isTimeDomain)})`, `(last_diff_pair_gap ${fmtG(T.dpGap!)})`, `(last_netname ${sexprQ(T.netName || "")})`,
    `(last_status ${sexprQ(res.status)})`, `(last_track_width ${fmtG(T.width)})`, `(last_tuning_length ${mm(res.length)})`,
    `(max_amplitude ${mm(st.maxAmp)})`, `(min_amplitude ${mm(st.minAmp)})`, `(min_spacing ${mm(st.spacing)})`, `(origin ${xy(base[0])})`,
    `(override_custom_rules ${yn(st.overrideCustomRules)})`, `(rounded ${yn(st.round)})`, `(single_sided ${yn(st.singleSided)})`,
    `(target_delay ${ps(td.opt)})`, `(target_delay_max ${ps(td.max)})`, `(target_delay_min ${ps(td.min)})`,
    `(target_length ${mm(st.target.opt)})`, `(target_length_max ${mm(st.target.max)})`, `(target_length_min ${mm(st.target.min)})`,
    `(target_skew ${mm(st.skew.opt)})`, `(target_skew_max ${mm(st.skew.max)})`, `(target_skew_min ${mm(st.skew.min)})`,
    `(tuning_mode ${sexprQ(tuningModeName(T.mode))})`,
  ];
  const text = `(generated (uuid ${sexprQ(K.newUuid())}) (type tuning_pattern) (name "Tuning Pattern") (layer ${sexprQ(T.layer)}) ${props.join(" ")} (members ${members.slice().sort().map(sexprQ).join(" ")}))`;
  return K.parse(text);
}
/** Is a point inside the pattern's outline (getOutline: the baseline grown by the clamped max amplitude + half the width)? */
export function inTuneOutline(T: Pick<TunePattern, "width">, res: TuneResult, p: Pt) {
  const st = res.settings; const minA = st.round ? T.width : T.width * Math.tan(1 - Math.tan(Math.PI / 8));
  const amp = Math.max(st.maxAmp / TUNE_IU, minA) + T.width / 2 + 0.0005;   // + the DRC epsilon
  for (const bl of [res.baseline, res.baselineCoupled]) {
    if (!bl) continue; const base = chPoints(bl).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]);   // arcs as their polyline
    for (let i = 0; i + 1 < base.length; i++) if (distSeg(p[0], p[1], base[i][0], base[i][1], base[i + 1][0], base[i + 1][1]) <= amp) return true;
  }
  return false;
}
/** The second click: EditStart / Update / EditFinish in one commit ("Tune"), or KiCad's warning when nothing meanders. */
export function tuneFinish(ctx: PcbCtx) {
  const T = S.tune.pattern; if (!T) return; tuneUpdate(ctx); const res = T.res;
  if (!res) return;
  if (!res.hasMeanders) {
    S.tune.pattern = null; S.tune.picker = null;
    ctx.toast(`No tuning pattern added: no meanders were needed or would fit (${TUNE_STATUS_TEXT[res.status]}).`); ctx.requestRender(); return;
  }
  const doc = ctx.doc; const changes: PcbChange[] = [], members: string[] = [];
  const scratch = Object.assign({}, doc, { items: new Map(doc.items) });
  const rebuild = (ln: TrackLine, fin: Chain, net: NetRef) => {
    const old = ln.ids.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[];
    const oldKey = new Map<string, KItem>(); for (const it of old) { const a = pt(it.node, "start")!, b = pt(it.node, "end")!; oldKey.set(ptKey(a) + "|" + ptKey(b), it); oldKey.set(ptKey(b) + "|" + ptKey(a), it); }
    const kept = new Set<string>();
    for (const pc of tunePieces(fin)) {
      const same = !pc.m && oldKey.get(ptKey(pc.a) + "|" + ptKey(pc.b));
      if (same && !kept.has(same.id)) { kept.add(same.id); continue; }   // the line's own segments outside the meanders stay as they are
      const node = pc.m ? arcTrackNode(doc, pc.a, pc.m, pc.b, T.width, T.layer, net) : segmentNode(doc, pc.a, pc.b, T.width, T.layer, net);
      const it = K.createItem(scratch, node); changes.push(upsertChange(it!, "ADDED", net));
      if (inTuneOutline(T, res, pc.a) && inTuneOutline(T, res, pc.b)) members.push(it!.id);
    }
    for (const it of old) if (!kept.has(it.id)) changes.unshift(removedChange(it));
  };
  rebuild(T.line, res.final, T.net);
  if (T.dp && res.finalCoupled) rebuild(T.dp.line, res.finalCoupled, T.dp.net);
  if (!T.dp) T.dpGap = sizesOf(ctx).routeDiffPair ? sizesOf(ctx).routeDiffPair(T.netName).gap : 0.25;   // a pair's pattern keeps its own gap
  const gen = K.createItem(scratch, tuningPatternNode(T, res, members)!); changes.push(upsertChange(gen!, "ADDED"));
  S.tuneSettings[tuneMode()].initialSide = T.st.initialSide;
  S.tune.pattern = null; S.tune.picker = null;
  ctx.commit(changes, "Tune"); ctx.requestRender();
}
