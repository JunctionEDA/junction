// pcb-tools/tuning-patterns.ts — tuning patterns on the board (PCB_TUNING_PATTERN as a PCB_GENERATOR) and the tuner's status.
import type { BoardDoc, BranchOp, NetRef, PcbChange, PcbCtx, Pt, SAtom, TrackLine } from "./types";
import type { Chain } from "./meander";
import type { TuneResult } from "./tuning-tool";
import { canEdit } from "./actions";
import { netNameOf } from "./app-state";
import { branchChanges, branchDoc } from "./branch";
import { connectedRun, ptKey } from "./connected";
import { settingsOf } from "./dialogs";
import { dpNetPair } from "./diffpair";
import { assembleLine, peq, trackEnds } from "./dragger";
import { IU_PER_PS, boardTrackLength, canCalculateLengthForDelay, ldContext, msgTime, netTuningProfileName } from "./length-delay";
import { boardChainBridging } from "./drc-chain";
import { designSettings, netClearance } from "./drc";
import { sizeUnits } from "./edit-commands";
import { distSeg } from "./hit";
import { TUNE_IU, TUNE_MSG_SELECT, chPoints, meanderDefaults, meanderMove, tuneCopy } from "./meander";
import { msgValue, unescapeName } from "./msgpanel";
import { netTable } from "./netlist";
import { evalRuleConstraint, parseDru } from "./dru";
import { ruleSizes } from "./rule-resolver";
import { matchDpSuffix } from "./diffpair";
import { chainNets, netChainOf, netOf } from "./nets";
import { segmentNode } from "./nodes";
import { line } from "./overlay";
import { arcTrackNode } from "./posture";
import { HL, K, S, saturated } from "./state";
import { applyRuleTarget, chainDelayIU, chainExtras, netRepTrack, placerPathDelay, chainMM, coupledPath, fmtG, inTuneOutline, lineChainIU, moveSettings, nearestOnChain, polyPtsText, tuneBegin, tuneDp, tuneFinish, tuneMode, tunePick, tunePieces, tuneTrackLine, tuneUpdate, tuningPathLength } from "./tuning-tool";
import { clone, color, pt, r6, widthOf } from "./util";
import { closestOnSeg } from "./point-editor";
import { pathHits, routeObstacles, simplifyPts } from "./walkaround";

// ---- tuning patterns on the board (PCB_TUNING_PATTERN as a PCB_GENERATOR: SetProperties, removeToBaseline, Update)
export const isTuningPattern = (it: KItem | undefined): it is KItem => !!it && it.kind === "generated" && K.str((K.kid(it.node, "type") || [])[1]) === "tuning_pattern";
/** PCB_TUNING_PATTERN::SetProperties: the stored settings, base line(s), layer, width and members. */
export function tuningPatternInfo(gen: Pick<KItem, "node">) {
  const n = gen.node;
  const kid = (k: string) => K.kid(n, k);
  const num = ((k: string, d: number | null) => { const c = kid(k); return c ? K.num(c[1]) : d; }) as { (k: string, d: number): number; (k: string, d: null): number | null };   // the default passes through
  const bool = (k: string, d: boolean) => { const c = kid(k); return c ? (c.length < 2 || K.str(c[1]) === "yes") : d; };
  const str = (k: string) => { const c = kid(k); return c ? K.str(c[1]) : ""; };
  // SHAPE_LINE_CHAIN as parsePolyPts reads it: (xy …) points and (arc (start) (mid) (end)) arcs
  const chOf = (k: string): Chain | null => {
    const c = kid(k); const p = c && K.kid(c, "pts"); if (!p) return null; const out: Chain = [];
    const xyOf2 = (n: SNode | null | undefined): Pt | null => (n ? [K.num(n[1]), K.num(n[2])] : null);
    for (const e of p.slice(1)) {
      if (!Array.isArray(e)) continue;
      if (e[0] === "xy") out.push({ p: [K.num(e[1]), K.num(e[2])] });
      else if (e[0] === "arc") {
        const a = xyOf2(K.kid(e as SNode, "start")), m = xyOf2(K.kid(e as SNode, "mid")), b = xyOf2(K.kid(e as SNode, "end")); if (!a || !m || !b) continue;
        const last = out[out.length - 1]; if (!last || !peq(last.p, a)) out.push({ p: a });
        out.push({ p: b, m });
      }
    }
    return out;
  };
  const ptsOf = (k: string): Pt[] | null => { const ch = chOf(k); return ch ? ch.map((n) => n.p) : null; };
  const st = meanderDefaults(); const I = (v: number) => Math.round(v * TUNE_IU);
  st.minAmp = I(num("min_amplitude", 0.2)); st.maxAmp = I(num("max_amplitude", 1)); st.spacing = I(num("min_spacing", 0.6));
  st.crPct = num("corner_radius_percent", 80); st.round = bool("rounded", true); st.singleSided = bool("single_sided", false);
  st.overrideCustomRules = bool("override_custom_rules", false);
  const side = str("initial_side"); st.initialSide = side === "left" ? -1 : side === "right" ? 1 : 0;
  const opt = num("target_length", null);
  if (opt != null) st.target = { min: I(num("target_length_min", opt - 0.1)), opt: I(opt), max: I(num("target_length_max", opt + 0.1)) };
  const so = num("target_skew", null); if (so != null) st.skew = { min: I(num("target_skew_min", so - 0.1)), opt: I(so), max: I(num("target_skew_max", so + 0.1)) };
  st.isTimeDomain = bool("is_time_domain", false);
  const D = (v: number) => Math.round(v * IU_PER_PS), dOpt = num("target_delay", null);   // set_iu: ps
  if (dOpt != null) st.targetDelay = { min: D(num("target_delay_min", dOpt)), opt: D(dOpt), max: D(num("target_delay_max", dOpt)) };
  const lay = kid("layer");
  const xyOf = (k: string): Pt | null => { const c = kid(k); const p = c && K.kid(c, "xy"); return p ? [K.num(p[1]), K.num(p[2])] : null; };
  return { st, layer: lay ? K.str(lay[1]) : "F.Cu", base: ptsOf("base_line"), coupled: ptsOf("base_line_coupled"), baseCh: chOf("base_line"), coupledCh: chOf("base_line_coupled"), mode: str("tuning_mode") || "single",
    origin: xyOf("origin"), end: xyOf("end"), status: str("last_status"), tuningLength: num("last_tuning_length", null), netName: str("last_netname"),
    width: num("last_track_width", 0.25), gap: num("last_diff_pair_gap", 0), members: K.groupMemberIds(n) };
}
/** removeToBaseline as branch edits: the members out, the base line(s) back as straight tracks of the members' net and width. */
export function baselineOps(doc: BoardDoc, gen: Pick<KItem, "node">) {
  const T = tuningPatternInfo(gen); const ops: BranchOp[] = []; const mem = T.members.map((id: string) => doc.items.get(id)).filter(Boolean) as KItem[];
  for (const it of mem) ops.push({ del: it!.id });
  const lines = [T.baseCh].concat(T.mode === "diff_pair" && T.coupledCh ? [T.coupledCh] : []);
  const added: { node: SNode; net: NetRef; width: number; coupled: boolean }[] = [];
  const tracks = mem.filter((it: KItem) => it.kind === "segment" || it.kind === "arc");
  // the base line is last_netname's (the members on it otherwise); the coupled one is its partner net's
  const NT = netTable(doc); const named = T.netName ? tracks.find((it) => netOf(it.node).name === T.netName) : null;
  let mainNet: NetRef | null = named ? netOf(named.node) : null;
  lines.forEach((baseCh, li) => {
    if (!baseCh || baseCh.length < 2) return; const base = baseCh.map((n) => n.p);
    const near = (it: KItem) => { const a = pt(it.node, "start"); return a && base.some((q, i) => i + 1 < base.length && distSeg(a[0], a[1], q[0], q[1], base[i + 1][0], base[i + 1][1]) < Math.max(T.width, 0.01) * 4 + 1.2); };
    let net: NetRef | null = null;
    if (li === 0) net = mainNet;
    else if (mainNet) { const pair = dpNetPair(doc, mainNet); if (pair) net = NT.key(pair.P) === NT.key(mainNet) ? pair.N : pair.P; }
    const tmpl = (net ? tracks.find((it) => NT.key(netOf(it.node)) === NT.key(net!)) : null) || tracks.find((it: KItem) => near(it)) || mem[0];
    if (!net) net = tmpl ? netOf(tmpl.node) : { code: 0, name: "" };
    if (li === 0) mainNet = net;
    const width = tmpl ? widthOf(tmpl.node, T.width) : T.width;
    for (let i = 0; i + 1 < base.length; i++) {
      if (peq(base[i], base[i + 1])) continue;
      const m = baseCh[i + 1].m;   // an arc of the base line comes back as an arc track
      const node = m ? arcTrackNode(doc, base[i], m, base[i + 1], width, T.layer, net) : segmentNode(doc, base[i], base[i + 1], width, T.layer, net); node.push(["uuid", K.newUuid()]); ops.push({ add: node }); added.push({ node, net: net!, width, coupled: li > 0 });
    }
  });
  return { ops, added, info: T };
}
/**
 * EDIT_TOOL delete with tuning patterns in it (PCB_TUNING_PATTERN::Remove → removeToBaseline): the deleted items and
 * the patterns' meanders go, each base line comes back, and the line it sits on is rebuilt simplified (the straight
 * chain pre + base line + post, collinear runs merged).  All the board changes of the delete.
 */
export function tuningRemoveChanges(doc: BoardDoc, gens: Iterable<KItem>, deleting: Set<string>) {
  const ops: BranchOp[] = [...deleting].map((id) => ({ del: id })); const seeds: string[] = [];
  for (const gen of gens) { const r = baselineOps(doc, gen); ops.push(...r.ops.filter((op) => !op.del || !deleting.has(op.del))); for (const a of r.added) seeds.push(K.str(K.kid(a.node, "uuid")![1])); }
  let b = branchDoc(doc, ops);
  for (const id of seeds) {
    const it = b.items.get(id); if (!it) continue;
    const line = assembleLine(b, it); if (!line) continue;
    const sp = simplifyPts(line.pts); if (sp.length >= line.pts.length) continue;
    const ops2: BranchOp[] = line.ids.map((x) => ({ del: x }));
    for (let i = 0; i + 1 < sp.length; i++) { const node = segmentNode(b, sp[i], sp[i + 1], line.width, line.layer, line.net); node.push(["uuid", K.newUuid()]); ops2.push({ add: node }); }
    b = branchDoc(b, ops2);
  }
  return branchChanges(doc, b);
}
/**
 * PCB_TUNING_PATTERN::EditStart / Update / EditFinish on a placed pattern: back to its base line, the line re-tuned
 * with the pattern's own settings (MEANDER_PLACER on the base line from origin to end), the new copper its members.
 * The generator node may carry edited settings, origin and end (the point editor, the properties, a move): as in
 * resetToBaseline the origin and end are pulled onto the straightened line (kept the base line's own ends when they
 * come closer than 0.1 mm), the base line becomes the stretch between them.  Returns the board as it would be after
 * the update (a branch of ctx.doc), or null when the base line cannot be found.
 */
export function regenerateTuningBranch(ctx: PcbCtx, gen: Pick<KItem, "id" | "kind" | "node">, doc0?: BoardDoc) {
  const doc = doc0 || ctx.doc; const { ops, added, info } = baselineOps(doc, gen);
  if (!added.length || (info.mode !== "single" && info.mode !== "diff_pair_skew" && info.mode !== "diff_pair")) return null;
  const dual = info.mode === "diff_pair";
  const scratch = branchDoc(doc, ops);
  const seedId = K.str(K.kid(added[0].node, "uuid")![1]); const seed = scratch.items.get(seedId); if (!seed) return null;
  const line = tuneTrackLine(scratch, seed); if (!line) return null;
  const ld = ldContext(scratch, settingsOf(ctx));
  const ist = tuneCopy(info.st); const ruled = applyRuleTarget(scratch, ist, info.mode, seed, null);   // Update: a custom rule's target unless overridden
  if (!ruled && !ist.overrideCustomRules && info.mode !== "diff_pair_skew") {   // EditStart: no rule, the netclass tuning profile's time domain flag
    const p = ld.profiles.get(netTuningProfileName(ld.s, line.netKey)); if (p) ist.isTimeDomain = p.enableTimeDomain;
  }
  // Update: a time domain pattern that is not new needs a delay model, else nothing changes
  if (ist.isTimeDomain && !canCalculateLengthForDelay(ld, { net: line.netKey, layer: line.layer })) return null;
  const nearOnLine = (p: Pt) => { const q = nearestOnChain(line.ch!, p).q; return [r6(q[0]), r6(q[1])]; };
  let origin = nearOnLine(info.origin || info.base![0]), end = nearOnLine(info.end || info.base![info.base!.length - 1]);
  if (Math.hypot(end[0] - origin[0], end[1] - origin[1]) < 0.1) { origin = info.base![0]; end = info.base![info.base!.length - 1]; }   // "Don't allow points too close"
  const mine = tuningPathLength(ld, seedId);
  const TP: Parameters<typeof moveSettings>[0] = { st: ist, coupled: null, ld, netKey: line.netKey, layer: line.layer, width: line.width, lineLength: mine.length, lineDelay: mine.delay, dp: null, dpGap: info.gap };
  if (info.mode === "diff_pair_skew") {
    const pair = dpNetPair(scratch, line.net); if (!pair) return null; const cp = coupledPath(scratch, pair, line.netKey, origin, ld);
    Object.assign(TP, { coupled: cp.length, coupledDelay: cp.delay, lastLength: mine.length, lastDelay: mine.delay });
    const NT = netTable(scratch), kP = NT.key(pair.P);
    TP.chainEx = chainExtras(ld, [line.netKey, kP === line.netKey ? NT.key(pair.N) : kP], mine.length * TUNE_IU);   // Start: initChainExtras
  } else if (!dual) TP.chainEx = chainExtras(ld, [line.netKey], mine.length * TUNE_IU);
  const I = (p: Pt) => [p[0] * TUNE_IU, p[1] * TUNE_IU];
  const r = line.width / 2, clearance = netClearance(settingsOf(ctx), line.netKey);
  const delayOf = ist.isTimeDomain ? chainDelayIU(ld, { net: line.netKey, layer: line.layer }) : null;
  let st = moveSettings(TP);
  let res: TuneResult, lineC: TrackLine | null = null;
  if (dual) {
    // DP_MEANDER_PLACER on both base lines: the coupled one is the partner net's line through its restored base line
    const cSeed = added.find((a) => a.coupled); const cIt = cSeed && scratch.items.get(K.str(K.kid(cSeed.node, "uuid")![1]));
    lineC = cIt ? tuneTrackLine(scratch, cIt) : null; if (!lineC || !cIt) return null;
    const NT = netTable(scratch), pair = dpNetPair(scratch, line.net); if (!pair) return null;
    const other = tuningPathLength(ld, cIt.id);
    const gap = info.gap > 0 ? info.gap : 0.1;
    const dp = { line: lineC, net: lineC.net, netKey: lineC.netKey, mineIsP: NT.key(pair.P) === line.netKey, gap, lenMine: mine.length, lenOther: other.length, delayMine: mine.delay, delayOther: other.delay };
    const ex = chainExtras(ld, dp.mineIsP ? [line.netKey, lineC.netKey] : [lineC.netKey, line.netKey], Math.max(mine.length, other.length) * TUNE_IU);   // P, N
    st = moveSettings(Object.assign({}, TP, { dp, lineLength: Math.max(mine.length, other.length), lineDelay: Math.max(mine.delay, other.delay), chainEx: ex }));
    const O = routeObstacles(scratch, settingsOf(ctx), line.netKey, line.layer, null, new Set(lineC.ids));
    const hits = (ch: Chain) => pathHits(O, chPoints(ch).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]), r).length > 0;
    res = tuneDp({ line, origin, end, cursor: end, width: line.width, clearance, dp }, st, I, hits, delayOf);
  } else {
    const O = routeObstacles(scratch, settingsOf(ctx), line.netKey, line.layer);
    const collides = (ch: Chain) => pathHits(O, chPoints(ch).map((p) => [p[0] / TUNE_IU, p[1] / TUNE_IU]), r).length > 0;
    const ch = lineChainIU(line);
    res = meanderMove({ pts: chPoints(ch), ch, origin: I(origin), end: I(end), cursor: I(end), st, width: Math.round(line.width * TUNE_IU),
      clearance: Math.round(clearance * TUNE_IU), lineLength: mine.length * TUNE_IU, lineDelay: TP.coupled == null ? placerPathDelay(TP) : mine.delay, delayOf, collides });
  }
  // the rebuilt line(s) onto the scratch board: kept segments stay, the rest of each line is replaced
  const ops2: BranchOp[] = [], members: string[] = [];
  const T = { width: line.width, layer: line.layer, net: line.net };
  const rebuild = (ln: TrackLine, fin: Chain) => {
    const oldKey = new Map<string, KItem>(); for (const id of ln.ids) { const it = scratch.items.get(id)!; const a = pt(it.node, "start")!, b = pt(it.node, "end")!; oldKey.set(ptKey(a) + "|" + ptKey(b), it); oldKey.set(ptKey(b) + "|" + ptKey(a), it); }
    const kept = new Set<string>();
    for (const pc of tunePieces(fin)) {
      const same = !pc.m && oldKey.get(ptKey(pc.a) + "|" + ptKey(pc.b));
      if (same && !kept.has(same.id)) { kept.add(same.id); if (inTuneOutline(T, res, pc.a) && inTuneOutline(T, res, pc.b)) members.push(same.id); continue; }
      const node = pc.m ? arcTrackNode(scratch, pc.a, pc.m, pc.b, ln.width, ln.layer, ln.net) : segmentNode(scratch, pc.a, pc.b, ln.width, ln.layer, ln.net);
      const u = K.newUuid(); node.push(["uuid", u]); ops2.push({ add: node });
      if (inTuneOutline(T, res, pc.a) && inTuneOutline(T, res, pc.b)) members.push(u);
    }
    for (const id of ln.ids) if (!kept.has(id)) ops2.unshift({ del: id });
  };
  rebuild(line, res.final);
  if (lineC && res.finalCoupled) rebuild(lineC, res.finalCoupled);
  const g = clone(gen.node);
  const setKid = (k: string, ...v: SAtom[]) => { const c = K.kid(g, k); if (c) c.splice(1, c.length - 1, ...v); };
  const xy = (p: Pt): SNode => ["xy", +fmtG(p[0]), +fmtG(p[1])];
  const baseCh = chainMM(res.baseline), base = baseCh.map((n) => n.p);
  const bl = K.kid(g, "base_line"); if (bl && base.length >= 2) bl.splice(1, bl.length - 1, K.parse(polyPtsText(baseCh)) as SNode);
  const cbaseCh = res.baselineCoupled ? chainMM(res.baselineCoupled) : null;
  const blc = K.kid(g, "base_line_coupled"); if (blc && cbaseCh && cbaseCh.length >= 2) blc.splice(1, blc.length - 1, K.parse(polyPtsText(cbaseCh)) as SNode);
  if (base.length >= 2) { const o = K.kid(g, "origin"); if (o) o.splice(1, o.length - 1, xy(base[0])); const e = K.kid(g, "end"); if (e) e.splice(1, e.length - 1, xy(base[base.length - 1])); }
  const side = res.settings.initialSide < 0 ? "left" : res.settings.initialSide > 0 ? "right" : "default"; setKid("initial_side", side);
  if (ruled) {
    const mm = (v: number) => +fmtG(v / TUNE_IU);
    const ps = (v: number) => +fmtG(v / IU_PER_PS);
    if (info.mode === "diff_pair_skew") { setKid("target_skew", mm(ist.skew.opt)); setKid("target_skew_min", mm(ist.skew.min)); setKid("target_skew_max", mm(ist.skew.max)); }
    else { setKid("target_length", mm(ist.target.opt)); setKid("target_length_min", mm(ist.target.min)); setKid("target_length_max", mm(ist.target.max)); }
    if (info.mode !== "diff_pair_skew") { setKid("target_delay", ps(ist.targetDelay.opt)); setKid("target_delay_min", ps(ist.targetDelay.min)); setKid("target_delay_max", ps(ist.targetDelay.max)); }
  }
  setKid("is_time_domain", ist.isTimeDomain ? "yes" : "no");
  setKid("last_status", res.status); setKid("last_tuning_length", +fmtG(res.length / TUNE_IU));
  const mk = K.kid(g, "members"); if (mk) mk.splice(1, mk.length - 1, ...members.slice().sort()); else g.push(["members", ...members.slice().sort()]);
  ops2.push({ set: gen.id, node: g });
  return branchDoc(scratch, ops2);
}
/** regenerateTuningBranch as board changes against ctx.doc ([] when the base line cannot be found). */
export function regenerateTuningChanges(ctx: PcbCtx, gen: Pick<KItem, "id" | "kind" | "node">) {
  const fin = regenerateTuningBranch(ctx, gen); return fin ? branchChanges(ctx.doc, fin) : [];
}
/** GENERATOR_TOOL::RegenerateAllOfType / RegenerateSelected: every pattern re-tuned in one commit. */
export function regenerateTuning(ctx: PcbCtx, gens: Iterable<KItem>, label: string) {
  if (!canEdit(ctx)) return true;
  let changes: PcbChange[] = [];
  for (const gen of gens) {
    const ch = regenerateTuningChanges(ctx, gen); if (!ch.length) continue;
    changes = changes.concat(ch);
  }
  if (changes.length) ctx.commit(changes, label);
  ctx.requestRender(); return true;
}
/** Escape / Undo / another tool with a pattern pending: EditCancel, the board untouched. */
export function tuneCancel(ctx: PcbCtx) { if (!S.tune.pattern) return false; S.tune.pattern = null; if (ctx) ctx.requestRender(); return true; }
/** Increase / Decrease Spacing (1 / 2), Increase / Decrease Amplitude (3 / 4): MEANDER_PLACER_BASE::SpacingStep / AmplitudeStep. */
export function tuneStep(ctx: PcbCtx, what: string, sign: number) {
  const T = S.tune.pattern; if (!T) { ctx.toast(TUNE_MSG_SELECT); return true; }
  const st = T.st, keep = S.tuneSettings[tuneMode()];
  if (what === "spacing") { st.spacing = Math.max(st.spacing + sign * st.step, Math.round(T.width * TUNE_IU) + Math.round(T.clearance * TUNE_IU)); keep.spacing = st.spacing; }
  else { st.maxAmp = Math.max(st.maxAmp + sign * st.step, st.minAmp); keep.maxAmp = st.maxAmp; }
  tuneUpdate(ctx); ctx.requestRender(); return true;
}
export function tuneMove(ctx: PcbCtx, mm: Pt) {
  const U = S.tune;
  if (!U.pattern) { const it = tunePick(ctx, mm); U.picker = it ? it.id : null; U.cursor = mm.slice(); return; }
  U.pattern.cursor = mm.slice(); U.cursor = mm.slice(); tuneUpdate(ctx);
}
export function tuneClick(ctx: PcbCtx, mm: Pt) {
  const U = S.tune; if (ctx.viewOnly) { ctx.toast("View-only access"); return; }
  if (!U.pattern) { const it = U.picker && ctx.doc.items.get(U.picker) || tunePick(ctx, mm); if (it) tuneBegin(ctx, it, mm); ctx.requestRender(); return; }
  U.pattern.cursor = mm.slice(); tuneFinish(ctx);
}
/** The tuner's status (TUNING_STATUS_VIEW_ITEM): the net, "current length  min  max", "Net: <length>  ---  ---". */
/** What the tuner's status box shows. */
export interface TuneStatus { scope: string; label: string; value: string; min: string; max: string; chain?: { value: string; min: string; max: string } | null }
export function tuneStatus(ctx: PcbCtx): TuneStatus | null {
  const U = S.tune; const doc = ctx.doc; const units = sizeUnits();
  let net = null, len = null, delay = 0; const skew = tuneMode() === "skew";
  const st = U.pattern ? U.pattern.st : S.tuneSettings[tuneMode()]; const td = !!st.isTimeDomain;
  if (U.pattern) {
    const T = U.pattern; net = T.net; len = T.res ? T.res.length / TUNE_IU : T.lineLength; if (T.coupled != null) len -= T.coupled;
    delay = T.res && td ? T.res.delay : T.lineDelay || 0; if (T.coupled != null) delay -= T.coupledDelay || 0;   // TuningDelayResult
  } else if (U.picker) {
    const it = doc.items.get(U.picker); if (!it) return null; net = netOf(it.node);
    const ld = ldContext(doc, settingsOf(ctx)); const mine = tuningPathLength(ld, it.id); len = mine.length; delay = mine.delay;
    if (skew) { const pair = dpNetPair(doc, net); const [a, b] = trackEnds(it); if (pair && a && b) { const cp = coupledPath(doc, pair, netTable(doc).key(net), [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ld); len -= cp.length; delay -= cp.delay; } }
  } else return null;
  const name = netNameOf(ctx, net);
  // the skew tuner shows the pattern's skew window; the length tuners the net's LENGTH_CONSTRAINT straight from the
  // rules (a track of the net stands for it), "---" without one or when the rule's severity is ignore
  const mm = (v: number) => msgValue(v / TUNE_IU, units).replace(/ (mm|mils|in)$/, "");
  const ps = (as: number) => (as / IU_PER_PS).toFixed(2);   // MessageTextFromValue( TIME ) without units
  let min = "---", max = "---";
  if (skew) { if (td) { min = ps(st.skewDelay.min); max = ps(st.skewDelay.max); } else { min = mm(st.skew.min); max = mm(st.skew.max); } }
  else if (S.ruleConstraint && net) {
    const NT = netTable(doc), k = NT.key(net); let rep: KItem | null = null;
    for (const it of doc.items.values()) if ((it.kind === "segment" || it.kind === "arc") && NT.key(netOf(it.node)) === k) { rep = it; break; }
    const c = rep ? S.ruleConstraint(doc, "length", rep, null) : null;
    if (c && c.severity !== "ignore") {
      if (c.timeDomain) { min = (c.min || 0).toFixed(2); max = c.max != null ? c.max.toFixed(2) : "---"; }
      else { min = mm((c.min || 0) * TUNE_IU); max = c.max != null ? mm(c.max * TUNE_IU) : "---"; }
    }
  }
  const value = td ? msgTime(delay) : msgValue(len, units);
  // the scope line "<net> | <chain>" and, for a net on a chain, the chain's total with the chain rule's min / max
  const NT = netTable(doc), chainName = net ? netChainOf(doc, NT.key(net)) : "";
  let chain: TuneStatus["chain"] = null;
  if (chainName) {
    const ld = ldContext(doc, settingsOf(ctx)); let cmin = "---", cmax = "---";
    const rep = [...doc.items.values()].find((it) => (it.kind === "segment" || it.kind === "arc" || it.kind === "via") && netChainOf(doc, NT.key(netOf(it.node))) === chainName);
    const cc = rep && S.ruleConstraint ? S.ruleConstraint(doc, "net_chain_length", rep, null) : null;
    if (cc && cc.severity !== "ignore") {
      if (cc.timeDomain) { cmin = (cc.min || 0).toFixed(2); cmax = cc.max != null ? cc.max.toFixed(2) : "---"; }
      else { cmin = mm((cc.min || 0) * TUNE_IU); cmax = cc.max != null ? mm(cc.max * TUNE_IU) : "---"; }
    }
    // the chain's routed total from the board (GetTrackLength of each net's first track), the meander's change, the bridging
    let total = 0;
    for (const cn of chainNets(doc, chainName)) {
      const r = netRepTrack(ld, cn); if (!r) continue;
      const b = boardTrackLength(ld, r.id); total += td ? b.delay + b.padToDieDelay : b.length + b.padToDie;
    }
    const T = U.pattern;
    if (T && T.res) total += td ? T.res.delay - placerPathDelay(T) : T.res.length / TUNE_IU - T.lineLength;   // TuningDelayDelta / TuningLengthDelta
    const [bl, bd] = boardChainBridging(doc, ld, chainName);
    if (Math.trunc(bl * TUNE_IU) > 0) total += td ? bd : Math.trunc(bl * TUNE_IU) / TUNE_IU;
    chain = { value: "Chain: " + (td ? msgTime(total) : msgValue(total, units)), min: cmin, max: cmax };
  }
  const scope = name ? unescapeName(name) + (chainName ? " | " + chainName : "") : "";
  return { scope, label: skew ? "current skew" : td ? "current delay" : "current length", value: (skew ? "Skew: " : "Net: ") + value, min, max, chain };
}
/**
 * TUNING_STATUS_VIEW_ITEM::ViewDraw in the stroke font with KiCad's preview metrics (GetConstantGlyphHeight: header
 * -2 = 10 px, values -1 = 12 px, pen 0.2 × height, line pitch 1.9 × height; glyph width 12 px, margin (5, 12) px,
 * 38 glyphs wide, min / max columns 18 and 7 glyphs + margin on), anchored above-right of the cursor.  The box takes
 * the theme's panel / ink colours (wxSYS_COLOUR_BTNFACE / BTNTEXT), the fill at 0.9 alpha, a 2 px border.
 */
export function drawTuneStatus(c: CanvasRenderingContext2D, at: Pt, px: number, info: TuneStatus) {
  const css = (name: string, dflt: string) => { try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || dflt; } catch (e) { return dflt; } };
  const head = 10 * px, txt = 12 * px, gw = 12 * px, mx = Math.round(12 * 0.4) * px, my = gw;
  const scope = info.scope ? 1 : 0, valueLines = info.chain ? 2 : 1, total = scope + 1 + valueLines;
  const w = gw * 38 + mx * 2, h = head * total + txt * valueLines;
  const ox = at[0] + mx * 2, oy = at[1] - (h + my * 2);
  const ink = css("--color-ink", "#e0e0e0");
  c.save(); c.globalAlpha = 0.9; c.fillStyle = css("--color-panel", "#2b2b2b"); c.fillRect(ox - mx, oy - my, w + 2 * mx, h + 2 * my);
  c.globalAlpha = 1; c.strokeStyle = ink; c.lineWidth = 2 * px; c.strokeRect(ox - mx, oy - my, w + 2 * mx, h + 2 * my);
  const m = c.getTransform(), base = [m.a, m.b, m.c, m.d, m.e, m.f];
  const stroke = K.drawStrokeText as (ctx: CanvasRenderingContext2D, base: number[], t: Record<string, unknown>, color: string, minPen: number) => void;
  const text = (s: string, x: number, y: number, size: number) => { if (s) stroke(c, base, { x, y, text: s, size, rot: 0, mirror: false, h: "left", v: "center", pen: size * 0.2, italic: false, dy: 0 }, ink, px); };
  const pitch = head * 1.9; let y = oy;
  if (scope) { text(info.scope, ox, y, head); y += Math.round(pitch * 1.1 / px) * px; }
  const col1 = ox + gw * 18 + mx, col2 = col1 + gw * 7 + mx;
  text(info.label, ox, y, head); text("min", col1, y, head); text("max", col2, y, head);
  y = oy + (scope ? Math.round(pitch * 1.1 / px) * px : 0) + Math.round(pitch * 1.3 / px) * px;
  text(info.value, ox, y, txt); text(info.min, col1, y, txt); text(info.max, col2, y, txt);
  if (info.chain) {   // the chain's value line with its own min / max
    y = oy + (scope ? Math.round(pitch * 1.1 / px) * px : 0) + Math.round(pitch * 2.3 / px) * px;
    text(info.chain.value, ox, y, txt); text(info.chain.min, col1, y, txt); text(info.chain.max, col2, y, txt);
  }
  c.restore();
}
/** The tuner over the board: the picked track's run highlighted, or the pattern's line with its meanders, and the status. */
export function drawTune(c: CanvasRenderingContext2D, ctx: PcbCtx, px: number) {
  const U = S.tune; const doc = ctx.doc;
  if (U.pattern && U.pattern.res) {
    const T = U.pattern;
    c.globalAlpha = 0.8; c.strokeStyle = saturated(color(T.layer)); c.lineWidth = T.width;
    const res = T.res as TuneResult;
    for (const pc of tunePieces(res.final).concat(res.finalCoupled ? tunePieces(res.finalCoupled) : [])) {
      if (pc.m) { const a = K.arcFrom3(pc.a, pc.m, pc.b); if (a) { c.beginPath(); c.arc(a.x, a.y, a.r, a.a0, a.a1, !!a.anticlockwise); c.stroke(); continue; } }
      line(c, pc.a, pc.b);
    }
  } else if (!U.pattern && U.picker) {
    c.globalAlpha = 0.9; c.strokeStyle = HL;
    for (const id of connectedRun(doc, [U.picker])) {
      const it = doc.items.get(id); if (!it || (it.kind !== "segment" && it.kind !== "arc")) continue;
      const a = pt(it.node, "start"), b = pt(it.node, "end"); c.lineWidth = widthOf(it.node, 0.25);
      if (it.kind === "arc") { const m = pt(it.node, "mid"); const arc = m && K.arcFrom3(a!, m, b!); if (arc) { c.beginPath(); c.arc(arc.x, arc.y, arc.r, arc.a0, arc.a1, !!arc.anticlockwise); c.stroke(); continue; } }
      line(c, a!, b!);
    }
  }
  const info = tuneStatus(ctx); if (info && U.cursor) drawTuneStatus(c, U.cursor, px, info);
  c.globalAlpha = 1;
}
/** What the board render leaves out while the tuner shows the rebuilt line. */
export function tuneHiddenIds() { const T = S.tune && S.tune.pattern; return T && T.res ? new Set(T.line.ids.concat(T.dp ? T.dp.line.ids : [])) : null; }
/**
 * The project's custom rules (.kicad_dru text, or null): parsed once, and S.ruleConstraint resolves a constraint for
 * an item pair from them (DRC_ENGINE::EvalRules), its values in the user's units for the message panel.
 */
export function setCustomRules(text: string | null) {
  const d = text ? parseDru(text) : null; S.dru = d;
  S.ruleConstraint = d && d.rules.length ? (doc, what, a, b) => evalRuleConstraint(d.rules, what, doc, S.settingsCache || S.settings || designSettings(null), a, b, (v) => msgValue(v, sizeUnits())) : null;
  // the router's sizes follow the rules too while the toolbar uses the netclass values (ImportSizes)
  const st = K.pcbSizes && K.pcbSizes.state as { ruleSizes?: unknown } | undefined;
  if (st) st.ruleSizes = d && d.rules.some((r) => r.constraints.some((c) => c.type === "track_width" || c.type === "via_diameter" || c.type === "hole_size" || c.type === "diff_pair_gap"))
    ? (net: string) => { const m = matchDpSuffix(net); return ruleSizes(S.doc || null, S.settingsCache || S.settings || designSettings(null), net, (S.route && S.route.layer) || S.layer || "F.Cu", m.rv ? m.complement : null); } : null;
}
