// pcb-tools/length-delay.ts — LENGTH_DELAY_CALCULATION (pcbnew/length_delay_calculation/*.cpp) and its user-defined
// tuning profile provider (TUNING_PROFILE_PARAMETERS_USER_DEFINED).
//
//  - Items (LENGTH_DELAY_CALCULATION_ITEM): a line (a chain of straight pieces and arcs, mm), a via with the signal
//    layers it spans, or a pad.  GetLengthCalculationItem builds one from a board conductor.
//  - CalculateLengthDetails: the optimisations (optimiseVias, mergeLines, OptimiseTraceInVia, optimiseTracesInPads),
//    the inferred via in a pad (InferViaInPad), then the space domain sums (track, via stackup height, pad-to-die) and,
//    when asked, the time domain ones from the net's tuning profile (track delay per layer, via delay or override,
//    the pads' (die_delay …)).
//  - Units: lengths in mm; delays in KiCad's internal time units (attoseconds, IU_PER_PS = 1e6); the profiles keep
//    their per-length delays in attoseconds per mm (IU_PER_PS_PER_MM) as the .kicad_pro stores them.
import type { BoardDoc, Conductor, DesignSettings, Pt } from "./types";
import type { Chain, ChNode } from "./meander";
import { chArc, chLength, chPieceAt, chReverse } from "./meander";
import type { DruRule } from "./dru";
import { shapeGap } from "./distances";
import { parseDru } from "./dru";
import { marker, netclassConstituents, netclassName } from "./drc";
import { copperStack, layerDistance, stackupItems } from "./net-lengths";
import { ptKey } from "./connected";
import { jointIndex } from "./dragger";
import { isLocked } from "./groups";
import { clusterRoots, conductors } from "./netlist";
import { netOf } from "./nets";
import { K } from "./state";
import { layerOf, pt, widthOf } from "./util";

export const IU_PER_PS = 1e6;
/** PATH_OPTIMISATIONS */
export interface PathOptimisations { optimiseVias?: boolean; mergeTracks?: boolean; optimiseTracesInPads?: boolean; inferViaInPad?: boolean }
export const MERGE_UNMERGED = 0, MERGE_IN_USE = 1, MERGE_RETIRED = 2;
type PadCond = Extract<Conductor, { kind: "pad" }>;
type ViaCond = Extract<Conductor, { kind: "via" }>;
/** LENGTH_DELAY_CALCULATION_ITEM */
export interface LDItem {
  type: "line" | "via" | "pad" | "unknown";
  line: Chain | null; start: string | null; end: string | null;
  pad?: PadCond | null; via?: ViaCond | null;
  /** the net whose effective netclass (and tuning profile) the item takes */
  net: string; merge: number; width?: number;
}
/** LENGTH_DELAY_STATS (lengths in mm, delays in attoseconds) */
export interface LDStats {
  numPads: number; numVias: number; viaLength: number; trackLength: number; padToDieLength: number; layerLengths: Map<string, number> | null;
  viaDelay: number; trackDelay: number; padToDieDelay: number; layerDelays: Map<string, number> | null;
}
export const totalLength = (d: LDStats) => d.viaLength + d.trackLength + d.padToDieLength;
export const totalDelay = (d: LDStats) => d.viaDelay + d.trackDelay + d.padToDieDelay;
/** LENGTH_DELAY_ITEM_DETAILS */
export interface LDItemDetails { lengthsAndDelays: [number, number][]; inferredStartViaLength: number; inferredEndViaLength: number; inferredStartViaDelay: number; inferredEndViaDelay: number }
/** DELAY_PROFILE_TRACK_PROPAGATION_ENTRY (widths and gaps in mm; delay in as/mm) */
export interface TrackEntry { signal: string; top: string; bottom: string; width: number; gap: number; delay: number }
/** TUNING_PROFILE as the .kicad_pro (tuning_profiles.tuning_profiles_impedance_geometric) stores it */
export interface TuningProfile {
  name: string; type: number; targetImpedance: number; frequency: number; enableTimeDomain: boolean; modelSolderMask: boolean;
  entries: TrackEntry[]; byLayer: Map<string, TrackEntry>; viaDelay: number; bridgeDelay: number;
  viaOverrides: { sf: string; st: string; vf: string; vt: string; delay: number }[];
}
/** TUNING_PROFILE_GEOMETRY_CONTEXT */
export interface GeometryCtx { net: string | null; layer?: string | null; width?: number; coupled?: boolean; gap?: number }

const num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === "string" ? v : "");
type Raw = Record<string, unknown>;
/** TUNING_PROFILES' reader (readUserDefinedProfileConfigurationLine): entries without a profile name are skipped. */
export function parseTuningProfiles(raw: unknown): TuningProfile[] {
  const out: TuningProfile[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== "object" || !("profile_name" in (e as Raw))) continue;
    const r = e as Raw, td = !!r.enable_time_domain_tuning;
    const entries: TrackEntry[] = [], byLayer = new Map<string, TrackEntry>();
    for (const l of Array.isArray(r.layer_entries) ? r.layer_entries : []) {
      if (!l || typeof l !== "object") continue; const x = l as Raw;
      const te = { signal: str(x.signal_layer), top: str(x.top_reference_layer), bottom: str(x.bottom_reference_layer), width: num(x.width, 0) / 1e6, gap: num(x.diff_pair_gap, 0) / 1e6, delay: num(x.delay, 0) };
      entries.push(te); byLayer.set(te.signal, te);
    }
    const viaOverrides = (Array.isArray(r.via_overrides) ? r.via_overrides : []).filter((v): v is Raw => !!v && typeof v === "object" && "signal_layer_from" in (v as Raw))
      .map((v) => ({ sf: str(v.signal_layer_from), st: str(v.signal_layer_to), vf: str(v.via_layer_from), vt: str(v.via_layer_to), delay: num(v.delay, 0) }));
    out.push({ name: str(r.profile_name), type: num(r.type, 0), targetImpedance: num(r.target_impedance, 0), frequency: num(r.frequency, 1e9), enableTimeDomain: td, modelSolderMask: !!r.model_solder_mask,
      entries, byLayer, viaDelay: num(r.via_prop_delay, 0), bridgeDelay: num(r.net_chain_bridge_prop_delay, 0), viaOverrides });
  }
  return out;
}
/** DELAY_PROFILE_TRACK_PROPAGATION_ENTRY::GetDelay: 0 unless the profile enables time domain tuning (or forced). */
export const entryDelay = (p: TuningProfile, e: TrackEntry, force = false) => (p.enableTimeDomain || force ? e.delay : 0);
/**
 * The effective netclass's tuning profile name for a net (NET_SETTINGS::makeEffectiveNetclass: the highest priority
 * constituent that has one, else the Default class's — addMissingDefaults).
 */
export function netTuningProfileName(s: DesignSettings, net: string | null | undefined): string {
  const raw = s.netclassRaw || {};
  for (const n of netclassConstituents(s, net)) { const r = raw[n]; const tp = r && typeof r.tuning_profile === "string" ? r.tuning_profile : ""; if (tp) return tp; }
  const d = raw.Default; return d && typeof d.tuning_profile === "string" ? d.tuning_profile : "";
}

/** What the calculation reads from the board: the stackup, the setting, the profiles and the net's conductors. */
export interface LDContext {
  doc: BoardDoc; s: DesignSettings; useHeight: boolean; copper: string[]; stack: string[];
  items: ReturnType<typeof stackupItems>; profiles: Map<string, TuningProfile>; conds: Conductor[];
}
/** The calculator for a board under the design settings (BOARD::GetLengthCalculation). */
export function ldContext(doc: BoardDoc, s: DesignSettings, conds?: Conductor[] | null): LDContext {
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const own = doc as unknown as { generalNode?: SNode | null; setupNode?: SNode | null };
  const profiles = new Map<string, TuningProfile>(); for (const p of parseTuningProfiles(s.tuningProfiles)) profiles.set(p.name, p);   // rebuildCaches
  return { doc, s, useHeight: s.useHeightForLengthCalcs !== false, copper, stack: copperStack(copper), items: stackupItems(own.generalNode ?? null, own.setupNode ?? null, copper), profiles, conds: conds || conductors(doc) };
}
/** KiCad's copper layer id (F_Cu 0, B_Cu 2, In1_Cu 4 …): the order LSET's copper iterator walks. */
const layerId = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 2 : 2 * (parseInt(l.slice(2), 10) + 1));
/** LENGTH_DELAY_CALCULATION::StackupHeight: 0 unless the board includes stackup height in lengths. */
export function stackupHeight(ctx: LDContext, a: string | null, b: string | null): number {
  if (!ctx.useHeight || !a || !b) return 0;
  return layerDistance(ctx.items, a, b);
}
const stackIndex = (ctx: LDContext, l: string) => { const i = ctx.stack.indexOf(l); return i < 0 ? ctx.stack.length : i; };
/** IsCopperLayerLowerThan: a sits below b in the stack. */
const lowerThan = (ctx: LDContext, a: string, b: string) => a !== b && (a === "B.Cu" || (b !== "B.Cu" && stackIndex(ctx, a) > stackIndex(ctx, b)));

// ---------------------------------------------------------------- chains with arcs
/** The node that ends the rest of piece i from t on (its arc through the middle of what is left). */
function pieceRest(ch: Chain, i: number, t: number): ChNode {
  const n = ch[i];
  return n.m ? { p: n.p.slice(), m: chPieceAt(ch, i, (t + 1) / 2) } : { p: n.p.slice() };
}
const samePt = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
/** SHAPE_LINE_CHAIN::Append( chain ): the shared joint once, arcs kept. */
function chJoin(a: Chain, b: Chain): Chain {
  const out = a.map((n) => (n.m ? { p: n.p.slice(), m: n.m.slice() } : { p: n.p.slice() }));
  b.forEach((n, i) => { if (!i && out.length && samePt(out[out.length - 1].p, n.p)) return; out.push(n.m && i ? { p: n.p.slice(), m: n.m.slice() } : { p: n.p.slice() }); });
  return out;
}
/** How many approximation steps a piece is walked in (SHAPE_ARC's polyline: one point per few degrees). */
const arcSteps = (ch: Chain, i: number) => { const n = ch[i]; if (!n.m) return 1; const g = chArc(ch[i - 1].p, n.m, n.p); return g ? Math.max(2, Math.ceil(g.sw / (Math.PI / 36))) : 1; };
/**
 * clipLineToPad / clipLineToVia going forward: the first chain point outside the shape, the crossing found on the
 * piece that leaves it (findArcPadIntersection along an arc, the segment's own crossing otherwise), and the line
 * rebuilt as centre → crossing → the rest.  The line must start inside.  Unchanged when every point is inside.
 */
function clipForward(ch: Chain, inside: (p: Pt) => boolean, centre: Pt): Chain {
  for (let i = 1; i < ch.length; i++) {
    const k = arcSteps(ch, i);
    for (let j = 1; j <= k; j++) {
      const t1 = j / k; if (inside(chPieceAt(ch, i, t1))) continue;
      let lo = (j - 1) / k, hi = t1;
      for (let it = 0; it < 48; it++) { const mid = (lo + hi) / 2; if (inside(chPieceAt(ch, i, mid))) lo = mid; else hi = mid; }
      const x = chPieceAt(ch, i, lo);
      const out: Chain = [{ p: centre.slice() }];
      if (!samePt(x, centre)) out.push({ p: x });
      out.push(pieceRest(ch, i, lo));
      for (let q = i + 1; q < ch.length; q++) out.push(ch[q].m ? { p: ch[q].p.slice(), m: ch[q].m!.slice() } : { p: ch[q].p.slice() });
      return out;
    }
  }
  return ch;
}
const insideShape = (c: Conductor) => (p: Pt) => shapeGap({ t: "circle", x: p[0], y: p[1], r: 0 }, c.shape) <= 1e-9;
const padPos = (c: PadCond): Pt => [c.pad.x, c.pad.y];
/** PAD::FlashLayer for the line's layer */
const padFlashes = (c: PadCond, layer: string | null) => !!layer && c.layers.has(layer);
/** LENGTH_DELAY_CALCULATION::OptimiseTraceInPad: a line ending on the pad's position is cut at the pad's edge and runs straight to it. */
export function optimiseTraceInPad(line: Chain, pad: PadCond, layer: string | null): Chain {
  if (line.length < 2) return line;
  const pos = padPos(pad);
  if (!samePt(line[0].p, pos) && !samePt(line[line.length - 1].p, pos)) return line;
  if (!padFlashes(pad, layer)) return line;
  const inside = insideShape(pad);
  if (inside(line[0].p)) return clipForward(line, inside, pos);
  if (inside(line[line.length - 1].p)) return chReverse(clipForward(chReverse(line), inside, pos));
  return line;
}
const viaPos = (v: ViaCond): Pt => v.anchors[0];
const viaInside = (v: ViaCond) => { const c = viaPos(v), r = v.size / 2; return (p: Pt) => Math.hypot(p[0] - c[0], p[1] - c[1]) <= r + 1e-9; };
/** LENGTH_DELAY_CALCULATION::IsPointInsideViaPad */
export const isPointInsideViaPad = (v: ViaCond, p: Pt, layer: string | null) => !!layer && v.layers.has(layer) && viaInside(v)(p);
/** LENGTH_DELAY_CALCULATION::OptimiseTraceInVia: the part of a line inside the via's pad replaced by a straight run to its centre. */
export function optimiseTraceInVia(line: Chain, via: ViaCond, layer: string | null): Chain {
  if (line.length < 2 || !layer || !via.layers.has(layer)) return line;
  const inside = viaInside(via), c = viaPos(via);
  if (inside(line[0].p)) return clipForward(line, inside, c);
  if (inside(line[line.length - 1].p)) return chReverse(clipForward(chReverse(line), inside, c));
  return line;
}

// ---------------------------------------------------------------- items
const trackLayer = (c: Conductor) => [...c.layers][0] || null;
/** A track or arc as a chain (SHAPE_LINE_CHAIN of the segment, or of the SHAPE_ARC). */
export function conductorChain(c: Conductor): Chain {
  if (c.kind === "arc") { const m = pt(c.item.node, "mid"); return m ? [{ p: c.anchors[0].slice() }, { p: c.anchors[1].slice(), m }] : [{ p: c.anchors[0].slice() }, { p: c.anchors[1].slice() }]; }
  return [{ p: c.anchors[0].slice() }, { p: c.anchors[1].slice() }];
}
/** The copper layers of a set in LSET order (F.Cu, B.Cu, In1.Cu …): what copper_layers_begin walks. */
const lsetOrder = (ls: Iterable<string>) => [...ls].filter((l) => /\.Cu$/.test(l)).sort((a, b) => layerId(a) - layerId(b));
/** LENGTH_DELAY_CALCULATION_ITEM::CalculateViaLayers: the first and last copper layers a track or arc meets the via on. */
function viaSignalLayers(ctx: LDContext, v: ViaCond): [string, string] {
  let top: string | null = null, bottom: string | null = null; const inside = viaInside(v);
  for (const l of lsetOrder(ctx.copper)) {
    if (!v.layers.has(l)) continue;
    const hit = ctx.conds.some((c) => (c.kind === "segment" || c.kind === "arc") && c.net === v.net && c.layers.has(l) && c.anchors.some(inside));
    if (hit) { if (top == null) top = l; else bottom = l; }
  }
  const vl = viaPadLayers(v);
  return [top ?? vl[0], bottom ?? vl[1]];
}
/** The via's padstack start and end layers (its (layers a b)). */
function viaPadLayers(v: ViaCond): [string, string] {
  const ls = K.kid(v.item.node, "layers"); const a = ls ? K.str(ls[1]) : "F.Cu", b = ls && ls.length > 2 ? K.str(ls[2]) : "B.Cu";
  return [a, b];
}
/** LENGTH_DELAY_CALCULATION::GetLengthCalculationItem */
export function lengthItemOf(ctx: LDContext, c: Conductor): LDItem {
  if (c.kind === "via") { const [a, b] = viaSignalLayers(ctx, c); return { type: "via", line: null, start: a, end: b, via: c, net: c.net, merge: MERGE_UNMERGED }; }
  if (c.kind === "segment" || c.kind === "arc") { const l = trackLayer(c); return { type: "line", line: conductorChain(c), start: l, end: l, net: c.net, merge: MERGE_UNMERGED, width: c.width }; }
  if (c.kind === "pad") {
    const cu = lsetOrder(c.layers); let first: string | null = null, second: string | null = null;
    for (const l of cu) { if (first == null) first = l; else second = l; }
    return { type: "pad", line: null, start: first, end: second, pad: c, net: c.net, merge: MERGE_UNMERGED };
  }
  return { type: "unknown", line: null, start: null, end: null, net: c.net, merge: MERGE_UNMERGED };
}
const posKey = (p: Pt) => `${Math.round(p[0] * 1e6)},${Math.round(p[1] * 1e6)}`;
/** optimiseVias: the layers the signal really uses at each via — tracks ending at or in it, and a coincident pad's side. */
function optimiseVias(ctx: LDContext, vias: LDItem[], linesAt: Map<string, Set<LDItem>>) {
  for (const it of vias) {
    const v = it.via!, pos = viaPos(v), connected = new Set<LDItem>();
    for (const l of linesAt.get(posKey(pos)) || []) connected.add(l);
    const r = v.size / 2;
    for (const [k, set] of linesAt) {
      if (k === posKey(pos)) continue;
      const [x, y] = k.split(",").map((n) => +n / 1e6);
      if ((x - pos[0]) ** 2 + (y - pos[1]) ** 2 > r * r + 1e-12) continue;
      for (const l of set) if (isPointInsideViaPad(v, [x, y], l.start)) connected.add(l);
    }
    const pad = ctx.conds.find((c): c is PadCond => c.kind === "pad" && c.net === v.net && [...c.layers].some((l) => v.layers.has(l)) && shapeGap(c.shape, v.shape) <= 1e-9) || null;
    const span = new Set<string>(); for (const l of connected) if (l.start) span.add(l.start);
    if (pad) {
      const t = pad.pad.type, smd = t === "smd" || t === "connect";
      span.add(smd ? (ctx.stack.find((l) => pad.layers.has(l)) || "F.Cu") : K.str((K.kid(pad.item.node, "layer") || [])[1]) || "F.Cu");
    }
    const cu = ctx.stack.filter((l) => span.has(l));
    if (!cu.length) { const l = viaPadLayers(v)[0]; it.start = l; it.end = l; }
    else { it.start = cu[0]; it.end = cu[cu.length - 1]; }
  }
}
/** mergeLines: lines that meet end to end on one layer with no third line there become one. */
function mergeLines(lines: LDItem[], linesAt: Map<string, Set<LDItem>>) {
  const tryMerge = (atStart: boolean, prim: LDItem): boolean => {
    const ln = prim.line!; const pos = atStart ? ln[0].p : ln[ln.length - 1].p; const set = linesAt.get(posKey(pos)); if (!set) return false;
    let other: LDItem | null = null, same = 0;
    for (const it of set) { if (it.start !== prim.start) continue; same++; if (it !== prim && it.merge === MERGE_UNMERGED) other = it; }
    if (same !== 2 || !other) return false;
    other.merge = MERGE_RETIRED;
    const sec = other.line!;
    if (atStart) { const m = samePt(sec[0].p, ln[0].p) ? chReverse(sec) : sec; prim.line = chJoin(m, ln); }
    else prim.line = samePt(sec[0].p, ln[ln.length - 1].p) ? chJoin(ln, sec) : chJoin(ln, chReverse(sec));
    return true;
  };
  for (const prim of lines) {
    if (prim.merge !== MERGE_UNMERGED) continue;
    prim.merge = MERGE_IN_USE;
    for (;;) { const s = tryMerge(true, prim), e = tryMerge(false, prim); if (!s && !e) break; }
  }
}

// ---------------------------------------------------------------- the user-defined tuning profile provider
/** The tuning profile of a net's effective netclass, or null (GetTuningProfile on the cache). */
export function profileOf(ctx: LDContext, net: string | null | undefined): TuningProfile | null {
  const name = netTuningProfileName(ctx.s, net || null); return (name && ctx.profiles.get(name)) || null;
}
/** getViaPropagationDelay: a layer-to-layer override, else the profile's via delay over the stackup height. */
function viaDelayOf(ctx: LDContext, p: TuningProfile, ss: string, se: string, vs: string, ve: string): number {
  if (lowerThan(ctx, ss, se)) [ss, se] = [se, ss];
  if (lowerThan(ctx, vs, ve)) [vs, ve] = [ve, vs];
  const o = p.viaOverrides.find((v) => v.sf === ss && v.st === se && v.vf === vs && v.vt === ve); if (o) return o.delay;
  return Math.trunc(p.viaDelay * stackupHeight(ctx, ss, se));
}
/** getPropagationDelay for one item */
function itemDelay(ctx: LDContext, it: LDItem, p: TuningProfile): number {
  if (it.merge === MERGE_RETIRED) return 0;
  if (it.type === "line") { const e = it.start ? p.byLayer.get(it.start) : null; const unit = e ? entryDelay(p, e) : 0; return Math.trunc(unit * chLength(it.line!)); }
  if (it.type === "via") { if (!p.enableTimeDomain) return 0; const [vs, ve] = viaPadLayers(it.via!); return viaDelayOf(ctx, p, it.start!, it.end!, vs, ve); }
  if (it.type === "pad") return padDieDelay(it.pad!);
  return 0;
}
/** PAD::GetPadToDieDelay in attoseconds: (die_delay …) is in ps. */
export const padDieDelay = (c: PadCond) => Math.round(K.num((K.kid(c.pad.node, "die_delay") || [])[1], 0) * IU_PER_PS);
/** PAD::GetPadToDieLength in mm */
export const padDieLength = (c: PadCond) => K.num((K.kid(c.pad.node, "die_length") || [])[1], 0);
/** GetPropagationDelays: every item through the first item's netclass profile; all 0 without one. */
export function propagationDelays(ctx: LDContext, items: LDItem[]): number[] {
  if (!items.length) return [];
  const p = profileOf(ctx, items[0].net); if (!p) return items.map(() => 0);
  return items.map((it) => itemDelay(ctx, it, p));
}
/** getTrackDelayPerMM: the profile's delay per mm on the context's layer (0 without a profile, an entry, or time domain). */
export function trackDelayPerMM(ctx: LDContext, g: GeometryCtx): number {
  const p = profileOf(ctx, g.net); if (!p || !g.layer) return 0;
  const e = p.byLayer.get(g.layer); return e ? entryDelay(p, e) : 0;
}
/** CanCalculateLengthForDelay */
export const canCalculateLengthForDelay = (ctx: LDContext, g: GeometryCtx) => trackDelayPerMM(ctx, g) > 0;
/** GetTrackLengthForPropagationDelay (CalculateLengthForDelay): mm of track for a delay in attoseconds. */
export function lengthForDelay(ctx: LDContext, delay: number, g: GeometryCtx): number {
  const u = trackDelayPerMM(ctx, g); if (u <= 0) return 0;
  return Math.trunc(delay / u * 1e6) / 1e6;
}
/** CalculatePropagationDelayForShapeLineChain */
export const delayForChain = (ctx: LDContext, ch: Chain, g: GeometryCtx) => Math.trunc(trackDelayPerMM(ctx, g) * chLength(ch));
/** GetViaPropagationDelay through the context's netclass */
export function viaPropagationDelay(ctx: LDContext, ss: string, se: string, vs: string, ve: string, g: GeometryCtx): number {
  const p = profileOf(ctx, g.net); return p ? viaDelayOf(ctx, p, ss, se, vs, ve) : 0;
}

// ---------------------------------------------------------------- CalculateLengthDetails
/** inferViaInPad: a line ending at a pad on a layer the pad is not on gets the via the router left out. */
function inferViaInPad(ctx: LDContext, pad: PadCond | null | undefined, it: LDItem | undefined, d: LDStats, withDelay: boolean): [number, number] {
  if (!pad || !it || it.type !== "line" || !it.start) return [0, 0];
  if (pad.layers.has(it.start)) return [0, 0];
  const padLayer = pad.layers.has("F.Cu") ? "F.Cu" : "B.Cu";
  d.numVias += 1; const h = stackupHeight(ctx, it.start, padLayer); d.viaLength += h;
  let delay = 0;
  if (withDelay) { delay = viaPropagationDelay(ctx, it.start, padLayer, "F.Cu", "B.Cu", { net: it.net }); d.viaDelay += delay; }
  return [h, delay];
}
/** LENGTH_DELAY_CALCULATION::CalculateLengthDetails */
export function calculateLengthDetails(ctx: LDContext, items: LDItem[], opts: PathOptimisations, startPad?: PadCond | null, endPad?: PadCond | null,
  layerDetail = false, withDelay = false, perItem?: LDItemDetails | null): LDStats {
  if (opts.optimiseVias || opts.mergeTracks) {   // the C++ tests MergeTracks twice: OptimiseTracesInPads alone does not start the pass
    const pads: LDItem[] = [], lines: LDItem[] = [], vias: LDItem[] = []; const linesAt = new Map<string, Set<LDItem>>();
    const at = (p: Pt, it: LDItem) => { const k = posKey(p); let s = linesAt.get(k); if (!s) linesAt.set(k, (s = new Set())); s.add(it); };
    for (const it of items) {
      if (it.type === "pad") pads.push(it);
      else if (it.type === "via") vias.push(it);
      else if (it.type === "line") { lines.push(it); at(it.line![0].p, it); at(it.line![it.line!.length - 1].p, it); }
    }
    if (opts.optimiseVias) optimiseVias(ctx, vias, linesAt);
    if (opts.mergeTracks) mergeLines(lines, linesAt);
    if (opts.optimiseVias) for (const v of vias) for (const l of lines) if (l.merge === MERGE_IN_USE) l.line = optimiseTraceInVia(l.line!, v.via!, l.start);
    if (opts.optimiseTracesInPads) for (const p of pads) for (const l of lines) if (l.merge === MERGE_IN_USE) l.line = optimiseTraceInPad(l.line!, p.pad!, l.start);
  }
  const d: LDStats = { numPads: 0, numVias: 0, viaLength: 0, trackLength: 0, padToDieLength: 0, layerLengths: layerDetail ? new Map() : null, viaDelay: 0, trackDelay: 0, padToDieDelay: 0, layerDelays: layerDetail && withDelay ? new Map() : null };
  const useHeight = ctx.useHeight;
  if (opts.inferViaInPad && useHeight) {
    const s = inferViaInPad(ctx, startPad, items[0], d, withDelay), e = inferViaInPad(ctx, endPad, items[items.length - 1], d, withDelay);
    if (perItem) { perItem.inferredStartViaLength = s[0]; perItem.inferredStartViaDelay = s[1]; perItem.inferredEndViaLength = e[0]; perItem.inferredEndViaDelay = e[1]; }
  }
  if (perItem) perItem.lengthsAndDelays = items.map((): [number, number] => [0, 0]);
  items.forEach((it, i) => {
    if (it.merge === MERGE_RETIRED || it.type === "unknown") return;
    if (it.type === "line") { const L = chLength(it.line!); if (perItem) perItem.lengthsAndDelays[i][0] = L; d.trackLength += L; if (d.layerLengths && it.start) d.layerLengths.set(it.start, (d.layerLengths.get(it.start) || 0) + L); }
    else if (it.type === "via" && useHeight) { const h = stackupHeight(ctx, it.start, it.end); if (perItem) perItem.lengthsAndDelays[i][0] = h; d.viaLength += h; d.numVias += 1; }
    else if (it.type === "pad") { const L = padDieLength(it.pad!); if (perItem) perItem.lengthsAndDelays[i][0] = L; d.padToDieLength += L; d.numPads += 1; }
  });
  if (withDelay && items.length) {
    const delays = propagationDelays(ctx, items);
    items.forEach((it, i) => {
      if (it.merge === MERGE_RETIRED || it.type === "unknown") return;
      if (perItem) perItem.lengthsAndDelays[i][1] = delays[i];
      if (it.type === "line") { d.trackDelay += delays[i]; if (d.layerDelays && it.start) d.layerDelays.set(it.start, (d.layerDelays.get(it.start) || 0) + delays[i]); }
      else if (it.type === "via" && useHeight) d.viaDelay += delays[i];
      else if (it.type === "pad") d.padToDieDelay += delays[i];
    });
  }
  return d;
}

// ---------------------------------------------------------------- the board's callers
const isTrack = (c: Conductor) => c.kind === "segment" || c.kind === "arc";
/**
 * BOARD::GetTrackLength: the copper connected to a track (CONNECTIVITY_DATA::GetConnectedItems, zones left out) as
 * length items, OptimiseVias + MergeTracks + OptimiseTracesInPads, with the delays.  Returns the item count, the
 * routed length (tracks + via heights), the pad-to-die length, the routed delay and the pad-to-die delay.
 */
export function boardTrackLength(ctx: LDContext, trackId: string) {
  const me = ctx.conds.find((c) => c.id === trackId && isTrack(c));
  if (!me) return { count: 0, length: 0, padToDie: 0, delay: 0, padToDieDelay: 0 };
  const netConds = ctx.conds.filter((c) => c.net === me.net && c.kind !== "zone");
  const roots = clusterRoots(netConds); const mine = roots[netConds.indexOf(me)];
  const items = netConds.filter((_, i) => roots[i] === mine).map((c) => lengthItemOf(ctx, c)).filter((it) => it.type !== "unknown");
  const d = calculateLengthDetails(ctx, items, { optimiseVias: true, mergeTracks: true, optimiseTracesInPads: true }, null, null, false, true);
  return { count: items.length, length: d.trackLength + d.viaLength, padToDie: d.padToDieLength, delay: d.trackDelay + d.viaDelay, padToDieDelay: d.padToDieDelay };
}
/** PCB_TRACK::GetDelay: the track alone, no optimisations. */
export function trackDelay(ctx: LDContext, trackId: string): number {
  const me = ctx.conds.find((c) => c.id === trackId && isTrack(c)); if (!me) return 0;
  return totalDelay(calculateLengthDetails(ctx, [lengthItemOf(ctx, me)], {}, null, null, false, true));
}
/** EDA_UNITS::PS through MessageTextFromValue( TIME ): "%.2f ps". */
export const msgTime = (as: number) => (as / IU_PER_PS).toFixed(2) + " ps";

// ---------------------------------------------------------------- TOPOLOGY::AssembleTuningPath
/** A PNS::LINE as the tuner sees it: its tracks, its chain (mm, arcs kept), layer, width and net key. */
export interface TuneLine { ids: string[]; ch: Chain; layer: string; width: number; net: string }
/** An entry of the tuning path (ITEM_SET): a line (its chain clipped in pads and vias) or a via. */
export type TunePathItem = { kind: "line"; ln: TuneLine; ch: Chain } | { kind: "via"; via: ViaCond };
export interface TuningPath { items: TunePathItem[]; startPad: PadCond | null; endPad: PadCond | null }
const chainOfTrack = (it: KItem): Chain => {
  const a = pt(it.node, "start")!, b = pt(it.node, "end")!, m = it.kind === "arc" ? pt(it.node, "mid") : null;
  return m ? [{ p: a.slice() }, { p: b.slice(), m }] : [{ p: a.slice() }, { p: b.slice() }];
};
/**
 * NODE::AssembleLine with arcs (followLine / JOINT::NextSegment): the track and every track reached through joints
 * with exactly one other same-net track and no via or pad; widths may differ (aAllowSegmentSizeMismatch, the default);
 * a locked track ends the line unless aFollowLockedSegments.
 */
export function assembleTuneLine(doc: BoardDoc, seg: KItem, followLocked = false): TuneLine | null {
  if (seg.kind !== "segment" && seg.kind !== "arc") return null;
  const J = jointIndex(doc); const L = layerOf(seg.node), w = widthOf(seg.node, 0.25), key = J.NT.key(netOf(seg.node));
  const A = pt(seg.node, "start"), B = pt(seg.node, "end"); if (!A || !B) return null;
  const ids = [seg.id]; let ch = chainOfTrack(seg);
  const walk = (p: Pt, atEnd: boolean) => {
    let cur = seg, q = p;
    for (let guard = 0; guard < 10000; guard++) {
      const k = ptKey(q);
      if ((J.vias.get(k) || []).some((v) => v.layers.has(L))) return;
      if ((J.pads.get(k) || []).some((x) => x.layers.has(L))) return;
      const links = (J.ends.get(L + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === key);
      if (links.length !== 2) return;
      const o = links[0] === cur ? links[1] : links[0];
      if (ids.includes(o.id)) return;
      if (!followLocked && isLocked(o.node)) return;
      let oc = chainOfTrack(o); if (!samePt(oc[0].p, q)) oc = chReverse(oc);   // oc now runs from q away
      if (atEnd) { ids.push(o.id); ch = chJoin(ch, oc); } else { ids.unshift(o.id); ch = chJoin(chReverse(oc), ch); }
      cur = o; q = oc[oc.length - 1].p;
    }
  };
  walk(B, true); walk(A, false);
  return { ids, ch, layer: L, width: w, net: key };
}
const netTracks = (ctx: LDContext, net: string) => ctx.conds.filter((c) => c.net === net && isTrack(c));
const padKey = (c: PadCond) => c.id + "#" + c.index;
/** TOPOLOGY::findLinesFromVia: the same-net lines with an end inside the via's pad on their layer, each assembled once. */
export function findLinesFromVia(ctx: LDContext, via: ViaCond, visited: Set<string>): TuneLine[] {
  const out: TuneLine[] = [], assembled = new Set<string>();
  for (const c of netTracks(ctx, via.net)) {
    if (visited.has(c.id) || assembled.has(c.id)) continue;
    if (shapeGap(c.shape, via.shape) > 1e-9) continue;   // QueryColliding with a zero clearance
    const L = trackLayer(c);
    if (!isPointInsideViaPad(via, c.anchors[0], L) && !isPointInsideViaPad(via, c.anchors[1], L)) continue;
    const l = assembleTuneLine(ctx.doc, c.item, true); if (!l) continue;
    l.ids.forEach((id) => assembled.add(id)); out.push(l);
  }
  return out;
}
/** NODE::HitTest( point ): the net's pads, vias and tracks whose copper holds the point. */
function hitTest(ctx: LDContext, net: string, p: Pt) {
  const pads: PadCond[] = [], vias: ViaCond[] = [], tracks: Conductor[] = [];
  for (const c of ctx.conds) {
    if (c.net !== net || c.kind === "zone" || !insideShape(c)(p)) continue;
    if (c.kind === "pad") pads.push(c); else if (c.kind === "via") vias.push(c); else tracks.push(c);
  }
  return { pads, vias, tracks };
}
const FOLLOW_BRANCH_TIMEOUT_MS = 500;   // ADVANCED_CFG::m_FollowBranchTimeout
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
/**
 * TOPOLOGY::walkTuningPath: depth first from one end of the line through in-line pads and vias; the longest walk
 * that ends on a pad (or, failing that, the longest at all) wins.  Returns its items in walk order and its end pad.
 */
export function walkTuningPath(ctx: LDContext, start: TuneLine, fromBack: boolean, visited0: Set<string>) {
  let best: { length: number; items: TunePathItem[]; endPad: PadCond | null } = { length: -1, items: [], endPad: null };
  const net = start.net, t0 = nowMs();
  const ends = (l: TuneLine): [Pt, Pt] => [l.ch[0].p, l.ch[l.ch.length - 1].p];
  const stack: { ep: Pt; items: TunePathItem[]; length: number; visited: Set<string> }[] = [{ ep: fromBack ? ends(start)[1] : ends(start)[0], items: [], length: 0, visited: new Set(visited0) }];
  const d2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  while (stack.length) {
    if (nowMs() - t0 > FOLLOW_BRANCH_TIMEOUT_MS) break;
    const cur = stack.pop()!;
    const hits = hitTest(ctx, net, cur.ep);
    const pad = hits.pads.find((p) => !cur.visited.has(padKey(p))) || null;
    if (pad) {
      if (cur.length > best.length) best = { length: cur.length, items: cur.items, endPad: pad };
      cur.visited.add(padKey(pad));   // continue through an in-line pad so tuning spans the whole net
      for (const t of hits.tracks) {
        if (cur.visited.has(t.id)) continue;
        const l = assembleTuneLine(ctx.doc, t.item, true); if (!l) continue;
        const [a, b] = ends(l); const startNear = d2(a, cur.ep) <= d2(b, cur.ep);
        const visited = new Set(cur.visited); l.ids.forEach((id) => visited.add(id));
        stack.push({ ep: startNear ? b : a, items: [...cur.items, { kind: "line", ln: l, ch: l.ch }], length: cur.length + chLength(l.ch), visited });
      }
      continue;
    }
    const via = hits.vias.find((v) => !cur.visited.has(v.id)) || null;
    if (via) {
      cur.visited.add(via.id);
      const conts = findLinesFromVia(ctx, via, cur.visited);
      for (const l of conts) {
        const [a, b] = ends(l); const startNear = d2(a, cur.ep) <= d2(b, cur.ep);
        const contLength = chLength(optimiseTraceInVia(l.ch, via, l.layer));
        const visited = new Set(cur.visited); l.ids.forEach((id) => visited.add(id));
        stack.push({ ep: startNear ? b : a, items: [...cur.items, { kind: "via", via }, { kind: "line", ln: l, ch: l.ch }], length: cur.length + contLength, visited });
      }
      if (!conts.length && cur.length > best.length) best = { length: cur.length, items: [...cur.items, { kind: "via", via }], endPad: null };
    } else if (cur.length > best.length) best = { length: cur.length, items: cur.items, endPad: null };
  }
  return best;
}
/**
 * TOPOLOGY::AssembleTuningPath: the picked track's line walked both ways, then every line clipped at the end pads, at
 * the pads it meets on the way (OptimiseTraceInPad) and at the vias beside it (OptimiseTraceInVia).
 */
export function assembleTuningPath(ctx: LDContext, startId: string): TuningPath {
  const empty: TuningPath = { items: [], startPad: null, endPad: null };
  const startC = ctx.conds.find((c) => c.id === startId && (isTrack(c) || c.kind === "via")); if (!startC) return empty;
  let segItem: KItem | null = null;
  if (startC.kind === "via") {
    const J = jointIndex(ctx.doc); const at = viaPos(startC);
    const links = ctx.conds.filter((c) => isTrack(c) && c.net === startC.net && c.anchors.some((a) => samePt(a, at)));
    const viaOnly = (J.vias.get(ptKey(at)) || []).length === 1 && !(J.pads.get(ptKey(at)) || []).length;
    if (viaOnly && links.length) segItem = links[0].item;   // IsNonFanoutVia: the via's own joint links a track
    if (!segItem) { const conts = findLinesFromVia(ctx, startC, new Set()); if (!conts.length) return empty; segItem = ctx.doc.items.get(conts[0].ids[0]) || null; }
  } else segItem = startC.item;
  if (!segItem) return empty;
  const l = assembleTuneLine(ctx.doc, segItem, true); if (!l) return empty;
  const visited = new Set(l.ids);
  const left = walkTuningPath(ctx, l, false, visited), right = walkTuningPath(ctx, l, true, visited);
  const items: TunePathItem[] = [...left.items.slice().reverse(), { kind: "line", ln: l, ch: l.ch }, ...right.items];
  const path: TuningPath = { items, startPad: left.endPad, endPad: right.endPad };
  if (!left.endPad && !right.endPad) return path;
  const processPad = (pad: PadCond) => { for (const it of items) if (it.kind === "line") it.ch = optimiseTraceInPad(it.ch, pad, it.ln.layer); };
  const processed = new Set<string>();
  for (const pad of [left.endPad, right.endPad]) if (pad) { processPad(pad); processed.add(padKey(pad)); }
  for (const it of items) {
    if (it.kind !== "line") continue;
    for (const q of [it.ch[0].p, it.ch[it.ch.length - 1].p]) {
      const pad = hitTest(ctx, it.ln.net, q).pads[0];
      if (pad && !processed.has(padKey(pad))) { processPad(pad); processed.add(padKey(pad)); }
    }
  }
  items.forEach((it, i) => {   // clip in-via portions and add the residual path to the via's centre
    if (it.kind !== "via") return;
    for (const j of [i - 1, i + 1]) { const o = items[j]; if (o && o.kind === "line") o.ch = optimiseTraceInVia(o.ch, it.via, o.ln.layer); }
  });
  return path;
}
/** PNS_KICAD_IFACE_BASE::GetLengthDelayCalculationItems: the lines, and the vias between lines on different layers. */
export function tuningPathItems(path: TuningPath): LDItem[] {
  const out: LDItem[] = [], its = path.items;
  its.forEach((it, i) => {
    if (it.kind === "line") out.push({ type: "line", line: it.ch, start: it.ln.layer, end: it.ln.layer, net: it.ln.net, merge: MERGE_UNMERGED, width: it.ln.width });
    else if (i > 0 && i < its.length - 1) {
      const a = its[i - 1], b = its[i + 1]; const la = a.kind === "line" ? a.ln.layer : null, lb = b.kind === "line" ? b.ln.layer : null;
      if (la !== lb) out.push({ type: "via", line: null, start: la, end: lb, via: it.via, net: it.via.net, merge: MERGE_UNMERGED });
    }
  });
  return out;
}
/** PNS_KICAD_IFACE_BASE::CalculateRoutedPathLength (mm): InferViaInPad only. */
export function routedPathLength(ctx: LDContext, path: TuningPath) {
  const items = tuningPathItems(path); if (!items.length) return 0;
  return totalLength(calculateLengthDetails(ctx, items, { inferViaInPad: true }, path.startPad, path.endPad));
}
/** PNS_KICAD_IFACE_BASE::CalculateRoutedPathDelay (attoseconds) */
export function routedPathDelay(ctx: LDContext, path: TuningPath) {
  const items = tuningPathItems(path); if (!items.length) return 0;
  return totalDelay(calculateLengthDetails(ctx, items, { inferViaInPad: true }, path.startPad, path.endPad, false, true));
}
/** MEANDER_PLACER::origPathLength / origPathDelay: the pads' pad-to-die plus the routed path. */
export function origPathLength(ctx: LDContext, path: TuningPath) {
  return (path.startPad ? padDieLength(path.startPad) : 0) + (path.endPad ? padDieLength(path.endPad) : 0) + routedPathLength(ctx, path);
}
export function origPathDelay(ctx: LDContext, path: TuningPath) {
  return (path.startPad ? padDieDelay(path.startPad) : 0) + (path.endPad ? padDieDelay(path.endPad) : 0) + routedPathDelay(ctx, path);
}

// ---------------------------------------------------------------- DRC_ENGINE::loadImplicitRules, 4) tuning profile rules
const druStr = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");   // LIBEVAL::EscapeStringLiteral
const druQ = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/**
 * The implicit rules of the netclasses' tuning profiles: for every track entry with a width, a track_width rule
 * (min = max( board minimum, width ), opt = max = width) on the entry's signal layer; a differential profile adds the
 * diff_pair_gap rule (min = max( board minimum clearance, gap ), opt = max = gap) for diff pair nets and, where the
 * gap is under the netclass clearance, a clearance rule (min = gap) between the coupled pair.  Each is named
 * "tuning profile '<name>'" and takes the tuning_profile_track_geometries severity.  They sit below the custom rules.
 */
export function tuningProfileRules(s: DesignSettings, doc?: BoardDoc | null): DruRule[] {
  const profiles = new Map<string, TuningProfile>(); for (const p of parseTuningProfiles(s.tuningProfiles)) profiles.set(p.name, p);
  if (!profiles.size) return [];
  const sev = s.severities.tuning_profile_track_geometries || "ignore";
  const raw = s.netclassRaw || {};
  // the Default class, the named ones and the composite ones the nets resolve to (with their first constituent's profile)
  const classes = new Map<string, string>();
  const rawProfile = (n: string) => { const r = raw[n]; return r && typeof r.tuning_profile === "string" ? r.tuning_profile : ""; };
  classes.set("Default", rawProfile("Default"));
  for (const n of Object.keys(raw)) if (n !== "Default") classes.set(n, rawProfile(n));
  if (doc) { const seen = new Set<string>(); for (const c of conductors(doc)) { if (!c.net || seen.has(c.net)) continue; seen.add(c.net); const n = netclassName(s, c.net); if (!classes.has(n)) classes.set(n, netTuningProfileName(s, c.net)); } }
  const lines: string[] = [];
  const mm = (v: number) => `${+v.toFixed(9)}mm`;
  const rule = (prof: string, cond: string, body: string) => lines.push(`(rule ${druQ(`tuning profile '${prof}'`)} (severity ${sev}) (condition ${druQ(cond)}) ${body})`);
  for (const [nc, pname] of classes) {
    if (!pname) continue; const p = profiles.get(pname); if (!p) continue;
    for (const e of p.entries) {
      if (!(e.width > 0) || !e.signal) continue;
      const base = `A.hasExactNetclass('${druStr(nc)}') && A.Layer == '${druStr(e.signal)}'`;
      const tw = `(constraint track_width (min ${mm(Math.max(s.minTrackWidth || 0, e.width))}) (opt ${mm(e.width)}) (max ${mm(e.width)}))`;
      if (p.type === 0) { rule(pname, base, tw); continue; }   // TUNING_PROFILE::PROFILE_TYPE::SINGLE
      if (!(e.gap > 0)) continue;
      rule(pname, base + " && A.inDiffPair('*')", tw);
      rule(pname, base + " && A.inDiffPair('*')", `(constraint diff_pair_gap (min ${mm(Math.max(s.minClearance || 0, e.gap))}) (opt ${mm(e.gap)}) (max ${mm(e.gap)}))`);
      const ncr = s.netclasses[nc]; const clr = ncr && typeof ncr.clearance === "number" ? ncr.clearance : null;
      if (clr != null && e.gap < clr) rule(pname, base + " && AB.isCoupledDiffPair()", `(constraint clearance (min ${mm(e.gap)}))`);
    }
  }
  if (!lines.length) return [];
  const rules = parseDru("(version 1)\n" + lines.join("\n")).rules;
  for (const r of rules) r.implicit = true;
  return rules;
}
/** DRC_TEST_PROVIDER_MISC: a netclass naming a tuning profile the project does not define. */
export function missingTuningProfileMarkers(s: DesignSettings) {
  const names = new Set(parseTuningProfiles(s.tuningProfiles).map((p) => p.name)); const out = [];
  for (const [name, r] of Object.entries(s.netclassRaw || {})) {
    if (name === "Default") continue;   // NET_SETTINGS::GetNetclasses: the named classes
    const tp = r && typeof r.tuning_profile === "string" ? r.tuning_profile : "";
    if (tp && !names.has(tp)) out.push(marker("missing_tuning_profile", "warning", 0, 0, `Missing tuning profile (Net Class: ${name}, Tuning Profile: ${tp})`, []));
  }
  return out;
}
