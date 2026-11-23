// pcb-tools/drc-chain.ts — the routed topology of a net chain, as the matched-length DRC provider reads it:
//
//   pcbnew/net_chain_bridging.cpp   FootprintChainBridgingLength, BoardChainBridgingLength, ChainBridgingDelayPerMm,
//                                   BoardChainBridging, EnumerateChainBridges, PartitionNetChainAroundNet
//   pcbnew/drc/drc_chain_topology.cpp  CHAIN_TOPOLOGY: a graph of (x, y, layer) nodes — tracks and arcs one edge each,
//                                   vias one edge per adjacent copper layer pair, series passives one bridge edge
//                                   per cross-net pad pair — with mid-segment T-junctions split, then a spanning
//                                   tree from terminal pad A: the trunk to terminal pad B and the stubs off it.
//
// Lengths are in mm and delays in attoseconds (LENGTH_DELAY_CALCULATION's delay IU).
import type { BoardDoc, Conductor, Pt } from "./types";
import { calculateLengthDetails, lengthItemOf, netTuningProfileName, stackupHeight } from "./length-delay";
import type { LDContext } from "./length-delay";
import { copperStack } from "./net-lengths";
import { boardChains } from "./nets";
import { K } from "./state";
import { layerOf, pt } from "./util";

type PadCond = Extract<Conductor, { kind: "pad" }>;
/** NETINFO_ITEM::GetNetChain of a conductor's net. */
const chainOf = (doc: BoardDoc, c: Conductor) => { const b = boardChains(doc).get(c.net); return b ? b.chain : ""; };
const center = (p: PadCond): Pt => [p.pad.x, p.pad.y];   // PAD::GetCenter is the pad's position
const padUuid = (p: PadCond) => K.uuidOf(p.pad.node) || "";
/** LSET::CuStack: the copper layers of a set in stack order (F.Cu, In1.Cu … B.Cu). */
export const cuStack = (ctx: LDContext, layers: Iterable<string>) => { const set = new Set(layers); return copperStack(ctx.copper).filter((l) => set.has(l)); };

// ---------------------------------------------------------------- net_chain_bridging.cpp
/** The footprints' pads in board order, grouped by footprint. */
function footprintPads(conds: Conductor[]): PadCond[][] {
  const by = new Map<string, PadCond[]>();
  for (const c of conds) if (c.kind === "pad") { let l = by.get(c.id); if (!l) by.set(c.id, (l = [])); l.push(c); }
  for (const l of by.values()) l.sort((a, b) => a.index - b.index);
  return [...by.values()];
}
const netCodeOf = (c: Conductor) => c.netObj && c.netObj.code > 0 ? c.netObj.code : c.net ? c.net : 0;
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * FootprintChainBridgingLength: the longest distance between two of a footprint's pads on the chain that sit on
 * different nets (0 with fewer than two chain pads, or all on one net).
 */
export function footprintChainBridgingLength(doc: BoardDoc, pads: PadCond[], chain: string): number {
  if (!chain) return 0;
  const cp = pads.filter((p) => chainOf(doc, p) === chain);
  if (cp.length < 2) return 0;
  const first = netCodeOf(cp[0]);
  if (!cp.slice(1).some((p) => netCodeOf(p) !== first)) return 0;
  let max = 0;
  for (let i = 0; i < cp.length; i++) for (let j = i + 1; j < cp.length; j++) {
    if (netCodeOf(cp[i]) === netCodeOf(cp[j])) continue;
    max = Math.max(max, dist(center(cp[i]), center(cp[j])));
  }
  return max;
}
/** BoardChainBridgingLength: the bridging of every footprint on the board. */
export function boardChainBridgingLength(doc: BoardDoc, conds: Conductor[], chain: string): number {
  if (!chain) return 0;
  let total = 0; for (const pads of footprintPads(conds)) total += footprintChainBridgingLength(doc, pads, chain);
  return total;
}
/**
 * ChainBridgingDelayPerMm: the net chain bridge propagation delay of the tuning profile of the first chain track whose
 * netclass names one (as per mm), else the default.
 */
export function chainBridgingDelayPerMm(doc: BoardDoc, ctx: LDContext, chain: string, defaultDelay = 0): number {
  if (!chain) return defaultDelay;
  for (const c of ctx.conds) {
    if ((c.kind !== "segment" && c.kind !== "arc" && c.kind !== "via") || chainOf(doc, c) !== chain) continue;   // BOARD::Tracks
    const name = netTuningProfileName(ctx.s, c.net); if (!name) continue;
    const p = ctx.profiles.get(name);
    return p ? p.bridgeDelay : 0;   // TUNING_PROFILES::GetTuningProfile: an unknown name is a default profile
  }
  return defaultDelay;
}
/** BoardChainBridging: the chain's bridging length (mm) and delay (as). */
export function boardChainBridging(doc: BoardDoc, ctx: LDContext, chain: string, defaultDelay = 0): [number, number] {
  if (!chain) return [0, 0];
  const len = boardChainBridgingLength(doc, ctx.conds, chain); if (len <= 0) return [0, 0];
  return [len, chainBridgingDelayPerMm(doc, ctx, chain, defaultDelay) * len];
}
/** SubtractBridgingClamped: max( 0, value - delta ). */
export const subtractBridgingClamped = (value: number, delta: number) => Math.max(0, value - delta);
/** CHAIN_BRIDGE: one cross-net pad pair of a series part. */
export interface ChainBridge { padA: PadCond; padB: PadCond; length: number; delay: number }
/** EnumerateChainBridges: every cross-net pad pair of every footprint with two or more chain pads. */
export function enumerateChainBridges(doc: BoardDoc, ctx: LDContext, chain: string, defaultDelay = 0): ChainBridge[] {
  const out: ChainBridge[] = []; if (!chain) return out;
  const perMm = chainBridgingDelayPerMm(doc, ctx, chain, defaultDelay);
  for (const pads of footprintPads(ctx.conds)) {
    const cp = pads.filter((p) => chainOf(doc, p) === chain); if (cp.length < 2) continue;
    for (let i = 0; i < cp.length; i++) for (let j = i + 1; j < cp.length; j++) {
      if (netCodeOf(cp[i]) === netCodeOf(cp[j])) continue;
      const length = dist(center(cp[i]), center(cp[j]));
      out.push({ padA: cp[i], padB: cp[j], length, delay: perMm * length });
    }
  }
  return out;
}
export type PartitionStatus = "OK" | "INVALID_INPUT" | "QUERY_NET_NOT_IN_CHAIN" | "START_PAD_NOT_ON_QUERY" | "END_PAD_NOT_ON_QUERY" | "NO_CHAIN_BRIDGES" | "AMBIGUOUS_OVERLAP";
/**
 * PartitionNetChainAroundNet: the chain's nets before the start pad and after the end pad, the chain cut at the
 * query net (the bridge graph without it, filled from the bridges each pad sits on).
 */
export function partitionNetChainAroundNet(doc: BoardDoc, ctx: LDContext, queryNet: string, startPad: PadCond | null, endPad: PadCond | null): { status: PartitionStatus; beforeStart: Set<string>; afterEnd: Set<string> } {
  const res = { status: "INVALID_INPUT" as PartitionStatus, beforeStart: new Set<string>(), afterEnd: new Set<string>() };
  if (!startPad || !endPad || startPad === endPad) return res;
  const chain = boardChains(doc).get(queryNet); if (!chain || !chain.chain) { res.status = "QUERY_NET_NOT_IN_CHAIN"; return res; }
  if (startPad.net !== queryNet) { res.status = "START_PAD_NOT_ON_QUERY"; return res; }
  if (endPad.net !== queryNet) { res.status = "END_PAD_NOT_ON_QUERY"; return res; }
  const adj = new Map<string, Set<string>>(), startSeeds = new Set<string>(), endSeeds = new Set<string>(); let has = false;
  const seed = (bp: PadCond, nbr: string, q: PadCond, seeds: Set<string>) => { if (bp === q && nbr !== queryNet) seeds.add(nbr); };
  for (const br of enumerateChainBridges(doc, ctx, chain.chain)) {
    const a = br.padA.net, b = br.padB.net;
    if (a === queryNet || b === queryNet) {
      has = true; seed(br.padA, b, startPad, startSeeds); seed(br.padB, a, startPad, startSeeds); seed(br.padA, b, endPad, endSeeds); seed(br.padB, a, endPad, endSeeds);
      continue;
    }
    if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b); adj.get(b)!.add(a);
  }
  if (!has) { res.status = "NO_CHAIN_BRIDGES"; return res; }
  const fill = (seeds: Set<string>, out: Set<string>) => {
    const q: string[] = []; for (const s of seeds) if (!out.has(s)) { out.add(s); q.push(s); }
    while (q.length) { const cur = q.shift()!; for (const n of adj.get(cur) || []) if (!out.has(n)) { out.add(n); q.push(n); } }
  };
  fill(startSeeds, res.beforeStart); fill(endSeeds, res.afterEnd);
  for (const n of res.beforeStart) if (res.afterEnd.has(n)) { res.status = "AMBIGUOUS_OVERLAP"; return res; }
  res.status = "OK"; return res;
}

// ---------------------------------------------------------------- drc_chain_topology.cpp
export type TopologyStatus = "OK" | "NO_ITEMS" | "NO_TERMINAL_PADS" | "DISCONNECTED" | "CYCLE_DETECTED";
/** CHAIN_TOPOLOGY::STUB */
export interface ChainStub { branchPoint: Pt; branchLayer: string; items: Conductor[]; length: number; delay: number }
export interface ChainTopology { name: string; status: TopologyStatus; trunkLength: number; trunkDelay: number; stubs: ChainStub[] }
interface Edge { a: number; b: number; length: number; delay: number; src: Conductor | null; layer: string }

/** CHAIN_TOPOLOGY( board, chain, items, defaultUnitDelay ). */
export function chainTopology(doc: BoardDoc, ctx: LDContext, chain: string, items: Conductor[], defaultUnitDelay = 0): ChainTopology {
  const topo: ChainTopology = { name: chain, status: "NO_ITEMS", trunkLength: 0, trunkDelay: 0, stubs: [] };
  if (!chain || !items.length) return topo;
  // the two terminal pads, from the first member net that has them (every member net carries the same pair)
  const chains = boardChains(doc), padByUuid = new Map<string, PadCond>();
  for (const c of ctx.conds) if (c.kind === "pad") { const u = padUuid(c); if (u && !padByUuid.has(u)) padByUuid.set(u, c); }
  let termA: PadCond | null = null, termB: PadCond | null = null;
  for (const it of items) {
    const b = chains.get(it.net); if (!b) continue;
    const p0 = b.pads[0] ? padByUuid.get(b.pads[0]) : undefined, p1 = b.pads[1] ? padByUuid.get(b.pads[1]) : undefined;
    if (p0) termA = p0; if (p1) termB = p1;
    if (termA && termB) break;
  }
  if (!termA || !termB) { topo.status = "NO_TERMINAL_PADS"; return topo; }

  const pos: Pt[] = [], nodeLayer: string[] = [], edges: Edge[] = [], adj: number[][] = [], index = new Map<string, number>();
  const padNodes = new Map<PadCond, number[]>();
  const addNode = (p: Pt, layer: string) => {
    const key = Math.trunc(Math.round(p[0] * 1e6)) + "," + Math.trunc(Math.round(p[1] * 1e6)) + "," + layer;   // NODE_COALESCE_EPSILON: 1 IU
    const was = index.get(key); if (was !== undefined) return was;
    const i = pos.length; pos.push([p[0], p[1]]); nodeLayer.push(layer); adj.push([]); index.set(key, i); return i;
  };
  const addEdge = (a: number, b: number, length: number, delay: number, src: Conductor | null, layer: string) => {
    if (a === b) return -1;
    const i = edges.length; edges.push({ a, b, length, delay, src, layer }); adj[a].push(i); adj[b].push(i); return i;
  };
  const seenPads = new Set<PadCond>();
  const registerPad = (pad: PadCond) => {
    if (seenPads.has(pad)) return; seenPads.add(pad);
    const list: number[] = []; for (const l of cuStack(ctx, pad.layers)) list.push(addNode(center(pad), l));
    padNodes.set(pad, list);
  };
  registerPad(termA); registerPad(termB);
  const single = (c: Conductor) => calculateLengthDetails(ctx, [lengthItemOf(ctx, c)], {}, null, null, false, true);
  for (const it of items) {
    if (it.kind === "segment" || it.kind === "arc") {
      const a = pt(it.item.node, "start") as Pt, b = pt(it.item.node, "end") as Pt, layer = layerOf(it.item.node); if (!a || !b) continue;
      const nA = addNode(a, layer), nB = addNode(b, layer), len = it.length;
      // trackDelay: the item's own delay through the length calculation (a track is never an unknown item, so the
      // chain's bridge delay per mm fallback does not arise)
      const dly = len > 0 ? single(it).trackDelay : 0;
      addEdge(nA, nB, len, dly, it, layer);
    } else if (it.kind === "via") {
      const stack = cuStack(ctx, it.layers); if (stack.length < 2) continue;
      const st = single(it); const totalDelay = st.viaDelay; let totalLength = st.viaLength;
      const heights: number[] = []; let hsum = 0;
      for (let i = 0; i + 1 < stack.length; i++) { const h = stackupHeight(ctx, stack[i], stack[i + 1]); heights.push(h); hsum += h; }
      if (totalLength <= 0) totalLength = hsum;
      const at = pt(it.item.node, "at") as Pt;
      for (let i = 0; i + 1 < stack.length; i++) {
        const nA = addNode(at, stack[i]), nB = addNode(at, stack[i + 1]);
        const segLen = heights[i]; let segDelay = 0;
        if (totalLength > 0) segDelay = totalDelay * (segLen / totalLength); else if (heights.length) segDelay = totalDelay / heights.length;
        addEdge(nA, nB, segLen, segDelay, it, stack[i]);
      }
    } else if (it.kind === "pad") registerPad(it);
  }
  // bridge edges through the series passives, on the footprint's side (the topmost shared copper layer otherwise)
  for (const br of enumerateChainBridges(doc, ctx, chain, defaultUnitDelay)) {
    registerPad(br.padA); registerPad(br.padB);
    let anchor = layerOf(br.padA.item.node, "F.Cu");
    const common = cuStack(ctx, [...br.padA.layers].filter((l) => br.padB.layers.has(l)));
    if (!common.includes(anchor)) { if (common.length) anchor = common[0]; else continue; }
    addEdge(addNode(center(br.padA), anchor), addNode(center(br.padB), anchor), br.length, br.delay, null, anchor);
  }
  splitTrackTJunctions(pos, nodeLayer, edges, adj, addNode, addEdge);
  const rootA = (padNodes.get(termA) || [])[0], rootB = (padNodes.get(termB) || [])[0];
  if (rootA === undefined || rootB === undefined) { topo.status = "NO_TERMINAL_PADS"; return topo; }
  // a pad on several layers is one node: zero-length edges between its layer anchors
  for (const nodes of padNodes.values()) for (let i = 1; i < nodes.length; i++) addEdge(nodes[0], nodes[i], 0, 0, null, nodeLayer[nodes[i]]);
  // dfsSpanningTree from terminal A
  const n = pos.length, parentNode = new Array<number>(n).fill(-1), parentEdge = new Array<number>(n).fill(-1), visited = new Array<boolean>(n).fill(false);
  let cycle = false; const stack: [number, number][] = [[rootA, -1]];
  while (stack.length) {
    const [node, from] = stack.pop()!;
    if (visited[node]) continue;
    visited[node] = true; parentEdge[node] = from;
    if (from >= 0) { const e = edges[from]; parentNode[node] = e.a === node ? e.b : e.a; }
    for (const ei of adj[node]) {
      if (ei === from) continue;
      const e = edges[ei], next = e.a === node ? e.b : e.a;
      if (visited[next]) { cycle = true; continue; }
      stack.push([next, ei]);
    }
  }
  if (cycle) { topo.status = "CYCLE_DETECTED"; return topo; }
  if (!visited[rootB]) { topo.status = "DISCONNECTED"; return topo; }
  const trunkEdges: number[] = [], trunkNodes: number[] = [];
  let cur = rootB;
  while (cur !== rootA && cur >= 0) { trunkNodes.push(cur); const e = parentEdge[cur]; if (e < 0) break; trunkEdges.push(e); cur = parentNode[cur]; }
  if (cur !== rootA) { topo.status = "DISCONNECTED"; return topo; }
  trunkNodes.push(rootA);
  for (const ei of trunkEdges) { topo.trunkLength += edges[ei].length; topo.trunkDelay += edges[ei].delay; }
  // the stubs: each component of non-trunk edges and the one trunk node it touches
  const trunkNodeSet = new Set(trunkNodes), trunkEdgeSet = new Set(trunkEdges), inStub = new Array<boolean>(n).fill(false);
  for (let start = 0; start < n; start++) {
    if (!visited[start] || trunkNodeSet.has(start) || inStub[start]) continue;
    const compNodes = new Set<number>([start]), compEdges = new Set<number>(), touches = new Set<number>(), its: Conductor[] = [];
    let length = 0, delay = 0, anyLayer: string | null = null; const q = [start];
    while (q.length) {
      const nd = q.shift()!;
      for (const ei of adj[nd]) {
        const e = edges[ei], other = e.a === nd ? e.b : e.a;
        if (trunkEdgeSet.has(ei)) { if (trunkNodeSet.has(other)) touches.add(other); continue; }
        if (!compEdges.has(ei)) { compEdges.add(ei); length += e.length; delay += e.delay; if (e.src) its.push(e.src); if (anyLayer === null) anyLayer = e.layer; }
        if (trunkNodeSet.has(other)) { touches.add(other); continue; }
        if (!compNodes.has(other)) { compNodes.add(other); q.push(other); }
      }
    }
    for (const c of compNodes) inStub[c] = true;
    if (!touches.size) continue;   // floating copper: unconnected_items reports it
    if (touches.size >= 2) { topo.status = "CYCLE_DETECTED"; topo.stubs = []; return topo; }
    const branch = touches.values().next().value as number;
    topo.stubs.push({ branchPoint: pos[branch], branchLayer: anyLayer !== null ? anyLayer : nodeLayer[branch], items: its, length, delay });
  }
  topo.status = "OK";
  return topo;
}

/**
 * splitTrackTJunctions: a straight track's end on the interior of another straight track on its layer (touching its
 * copper, or within 1 IU of its centre line) splits that track there, both halves keeping their share of its length
 * and delay.
 */
function splitTrackTJunctions(pos: Pt[], nodeLayer: string[], edges: Edge[], adj: number[][], addNode: (p: Pt, l: string) => number, addEdge: (a: number, b: number, l: number, d: number, s: Conductor | null, layer: string) => number) {
  const isTrace = (e: Edge) => !!e.src && e.src.kind === "segment";
  const trackEdges: number[] = []; edges.forEach((e, i) => { if (isTrace(e)) trackEdges.push(i); });
  const EPS = 1e-6;   // NODE_COALESCE_EPSILON in mm
  for (const ee of trackEdges) {
    for (let sel = 0; sel < 2; sel++) {
      const src = edges[ee], en = sel === 0 ? src.a : src.b, ep = pos[en], el = nodeLayer[en];
      for (let oi = 0; oi < edges.length; oi++) {
        if (oi === ee) continue;
        const o = edges[oi]; if (!isTrace(o) || o.layer !== el) continue;
        const A = pos[o.a], B = pos[o.b], ab = [B[0] - A[0], B[1] - A[1]], len2 = ab[0] * ab[0] + ab[1] * ab[1];
        if (len2 <= 0) continue;
        const t = ((ep[0] - A[0]) * ab[0] + (ep[1] - A[1]) * ab[1]) / len2;
        if (!(t > 1e-4 && t < 1 - 1e-4)) continue;   // isInteriorParametric
        const proj: Pt = [Math.round((A[0] + ab[0] * t) * 1e6) / 1e6, Math.round((A[1] + ab[1] * t) * 1e6) / 1e6];
        // GetEffectiveShape( layer )->Collide( endpoint, 0 ): within the track's half width of its centre line
        const s = o.src!, sa = pt(s.item.node, "start") as Pt, sb = pt(s.item.node, "end") as Pt, hw = (s.kind === "segment" ? s.width : 0) / 2;
        const segDist = (() => { const d = [sb[0] - sa[0], sb[1] - sa[1]], l2 = d[0] * d[0] + d[1] * d[1]; let u = l2 ? ((ep[0] - sa[0]) * d[0] + (ep[1] - sa[1]) * d[1]) / l2 : 0; u = Math.max(0, Math.min(1, u)); return Math.hypot(ep[0] - sa[0] - u * d[0], ep[1] - sa[1] - u * d[1]); })();
        if (!(segDist <= hw + EPS / 2) && Math.hypot(proj[0] - ep[0], proj[1] - ep[1]) > EPS) continue;
        const full = o.length, fullD = o.delay, oldA = o.a, oldB = o.b, oldSrc = o.src, oldLayer = o.layer;
        const j = addNode(proj, el); if (j === oldA || j === oldB) continue;
        const rm = (node: number, idx: number) => { adj[node] = adj[node].filter((x) => x !== idx); };
        rm(oldA, oi); rm(oldB, oi);
        edges[oi].a = oldA; edges[oi].b = j; edges[oi].length = full * t; edges[oi].delay = fullD * t;
        adj[oldA].push(oi); adj[j].push(oi);
        addEdge(j, oldB, full * (1 - t), fullD * (1 - t), oldSrc, oldLayer);
        if (en !== j) addEdge(en, j, 0, 0, null, el);
      }
    }
  }
}
