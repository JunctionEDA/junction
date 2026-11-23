// pcb-tools/drc-length.ts — DRC_TEST_PROVIDER_MATCHED_LENGTH (drc_test_provider_matched_length.cpp) for the custom rules:
//
//  - every track, arc, via and pad takes, for each of length, net_chain_length, stub_length, return_path, skew and
//    via_count, the rule EvalRules gives it; each rule's items are grouped by net, and each net is one connection
//    measured by LENGTH_DELAY_CALCULATION::CalculateLengthDetails (OptimiseVias, MergeTracks, OptimiseTracesInPads:
//    track, via height and pad-to-die lengths and delays);
//  - per rule, sorted by net name: net_chain_length on the chain's trunk between its terminal pads (CHAIN_TOPOLOGY,
//    drc-chain.ts) or, where the chain is no simple path, the members' sum plus the series parts' bridging;
//    length, skew (within_diff_pairs: each coupled pair), via_count; return_path (the chain's tracks not covered by
//    copper zones on the reference layer, grouped where the uncovered copper touches); stub_length (the topology's
//    stubs, or for an invalid topology each member net not carrying a terminal pad).
import type { BoardDoc, Conductor, DesignSettings, DrcMarker, Pt } from "./types";
import { EndType, FillRule, JoinType, differenceD, inflatePathsD, intersectD, unionD, type PathsD } from "clipper2-ts";
import { arcPoints } from "./distances";
import { matchDpSuffix } from "./diffpair";
import { marker, mm4, mmPair, ruled, withKiids } from "./drc";
import { boardChainBridging, chainTopology } from "./drc-chain";
import type { ChainTopology } from "./drc-chain";
import { ruleLabel, ruleMatches, setRuleConstraint, wildMatch } from "./dru";
import type { DruConstraint, DruRule } from "./dru";
import type { RuleItem } from "./dru-eval";
import { IU_PER_PS, calculateLengthDetails, ldContext, lengthItemOf } from "./length-delay";
import { boardChains } from "./nets";
import { zoneLayers } from "./nodes";
import { K } from "./state";
import { layerOf, pt } from "./util";

const TYPES = ["length", "net_chain_length", "stub_length", "return_path", "skew", "via_count"];
/** DRC_LENGTH_REPORT::ENTRY */
interface Conn { net: string; code: number; items: Conductor[]; viaCount: number; total: number; totalDelay: number; totalRoute: number; totalRouteDelay: number; totalVia: number; totalViaDelay: number; totalPadToDie: number; totalPadToDieDelay: number }

const ps = (as: number) => (as / IU_PER_PS).toFixed(2) + " ps";
const uidOf = (c: Conductor) => (c.kind === "pad" ? K.uuidOf(c.pad.node) : K.uuidOf(c.item.node)) || c.id;
/** BOARD_ITEM::GetPosition / GetLayer of a connection's item. */
function posOf(c: Conductor): Pt { if (c.kind === "pad") return [c.pad.x, c.pad.y]; const p = pt(c.item.node, c.kind === "via" ? "at" : "start"); return (p || [0, 0]) as Pt; }
function itemLayer(c: Conductor): string {
  if (c.kind === "segment" || c.kind === "arc") return layerOf(c.item.node);
  if (c.kind === "via") return "F.Cu";
  const ls = (c as Extract<Conductor, { kind: "pad" }>).pad.layers; const own = ls.find((l) => /\.Cu$/.test(l) && !l.startsWith("*")); return own || (ls.some((l) => l === "*.Cu" || l === "F&B.Cu") ? "F.Cu" : ls[0] || "F.Cu");
}
const ruleItem = (c: Conductor): RuleItem => (c.kind === "pad" ? { kind: "pad", node: c.pad.node, parent: c.item, layer: itemLayer(c), shape: c.shape } : { kind: c.kind, node: c.item.node, item: c.item, layer: itemLayer(c), shape: c.shape });
const report = (code: string, at: Pt, layer: string, text: string, items: Conductor[], rule: DruRule): DrcMarker => {
  const m = withKiids(marker(code, "error", at[0], at[1], text, Array.from(new Set(items.map((c) => c.id)))), items.map(uidOf)); m.layer = layer; m.rule = rule.name;
  return ruled(m, rule.severity);
};
/** Integer IU comparison of a measured value against a constraint bound (nm, or as for time). */
const iu = (v: number, time: boolean) => (time ? v : v * 1e6);
const bound = (v: number, time: boolean) => Math.round(time ? v * IU_PER_PS : v * 1e6);

export function matchedLengthProviderMarkers(doc: BoardDoc, s: DesignSettings, rules: DruRule[]): DrcMarker[] {
  const out: DrcMarker[] = [];
  if (!rules.some((r) => r.constraints.some((c) => TYPES.includes(c.type)))) return out;
  const ctx = ldContext(doc, s);
  const conds = ctx.conds.filter((c) => c.kind !== "zone");
  const codeOf = new Map<string, number>(); if (doc.nets) for (const [code, name] of doc.nets as Map<number, string>) codeOf.set(String(name), code);
  // gather: the rule EvalRules gives each item for each constraint type
  const itemSets = new Map<DruRule, Set<Conductor>>();
  for (const c of conds) {
    const A = ruleItem(c);
    for (const type of TYPES) {
      setRuleConstraint(type);
      for (let i = rules.length - 1; i >= 0; i--) {
        const r = rules[i]; if (!r.constraints.some((k) => k.type === type) || !ruleMatches(r, doc, s, A, null)) continue;
        let set = itemSets.get(r); if (!set) itemSets.set(r, (set = new Set())); set.add(c); break;
      }
    }
  }
  setRuleConstraint(null);
  const opts = { optimiseVias: true, mergeTracks: true, optimiseTracesInPads: true, inferViaInPad: false };
  const chainOf = (net: string) => { const b = boardChains(doc).get(net); return b ? b.chain : ""; };
  const topoCache = new Map<string, ChainTopology>();
  const topologyFor = (chain: string) => {
    let t = topoCache.get(chain); if (t) return t;
    // BOARD::Tracks (tracks, arcs and vias) and every footprint's pads on the chain
    const items = ctx.conds.filter((c) => c.kind !== "zone" && chainOf(c.net) === chain);
    t = chainTopology(doc, ctx, chain, items); topoCache.set(chain, t); return t;
  };
  const ordered = rules.filter((r) => itemSets.has(r));
  for (const rule of ordered) {
    const byNet = new Map<string, Conductor[]>();
    for (const c of itemSets.get(rule)!) { const k = c.net || ""; let l = byNet.get(k); if (!l) byNet.set(k, (l = [])); l.push(c); }
    const conns: Conn[] = [];
    for (const [net, items] of [...byNet].sort((a, b) => (codeOf.get(a[0]) ?? 0) - (codeOf.get(b[0]) ?? 0))) {
      const d = calculateLengthDetails(ctx, items.map((c) => lengthItemOf(ctx, c)).filter((it) => it.type !== "unknown"), opts, null, null, false, true);
      conns.push({ net, code: codeOf.get(net) ?? 0, items, viaCount: d.numVias, totalVia: d.viaLength, totalViaDelay: d.viaDelay, totalRoute: d.trackLength, totalRouteDelay: d.trackDelay,
        totalPadToDie: d.padToDieLength, totalPadToDieDelay: d.padToDieDelay, total: d.trackLength + d.viaLength + d.padToDieLength, totalDelay: d.trackDelay + d.viaDelay + d.padToDieDelay });
    }
    conns.sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));
    const find = (type: string) => rule.constraints.find((k) => k.type === type) || null;
    const live = (c: DruConstraint | null) => !!c && rule.severity !== "ignore";
    const lengthC = find("length"), chainC = find("net_chain_length"), stubC = find("stub_length"), retC = find("return_path");
    // the per-chain aggregates
    const chainAgg = new Map<string, Conn>();
    if (live(chainC) || live(stubC) || live(retC)) {
      for (const conn of conns) {
        const chain = chainOf(conn.net); if (!chain) continue;
        const agg = chainAgg.get(chain);
        if (!agg) chainAgg.set(chain, Object.assign({}, conn, { net: chain, items: conn.items.slice() }));
        else {
          agg.total += conn.total; agg.totalDelay += conn.totalDelay; agg.totalRoute += conn.totalRoute; agg.totalRouteDelay += conn.totalRouteDelay;
          agg.totalVia += conn.totalVia; agg.totalViaDelay += conn.totalViaDelay; agg.totalPadToDie += conn.totalPadToDie; agg.totalPadToDieDelay += conn.totalPadToDieDelay;
          agg.viaCount += conn.viaCount; for (const it of conn.items) if (!agg.items.includes(it)) agg.items.push(it);
        }
      }
    }
    const aggSorted = [...chainAgg.values()].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0));
    if (live(chainC)) {
      const chainConns: Conn[] = [];
      for (const agg of aggSorted) {
        const input = Object.assign({}, agg);
        const topo = topologyFor(agg.net);
        if (topo.status === "OK") { input.total = topo.trunkLength; input.totalDelay = topo.trunkDelay; input.totalRoute = topo.trunkLength; input.totalRouteDelay = topo.trunkDelay; }
        else { const [bl, bd] = boardChainBridging(doc, ctx, agg.net); input.total += bl; input.totalRoute += bl; input.totalDelay += bd; input.totalRouteDelay += bd; }
        chainConns.push(input);
      }
      checkLengths(out, rule, chainC!, chainConns);
    }
    if (live(lengthC)) checkLengths(out, rule, lengthC!, conns);
    const skewC = find("skew"); if (live(skewC)) checkSkews(out, rule, skewC!, conns);
    const viaC = find("via_count"); if (live(viaC)) checkViaCounts(out, rule, viaC!, conns);
    if (live(retC) && retC!.refLayer) checkReturnPath(out, doc, rule, retC!, aggSorted);
    if (live(stubC)) checkStubLengths(out, doc, rule, stubC!, conns, topologyFor, ctx.conds);
  }
  return out;
}
function checkLengths(out: DrcMarker[], rule: DruRule, c: DruConstraint, conns: Conn[]) {
  const time = !!c.timeDomain, name = ruleLabel(rule);
  for (const e of conns) {
    const v = time ? e.totalDelay : e.total; let kind = "", lim = 0;
    if (c.min != null && iu(v, time) < bound(c.min, time)) { kind = "min"; lim = c.min; }
    else if (c.max != null && iu(v, time) > bound(c.max, time)) { kind = "max"; lim = c.max; }
    if (!kind || !e.items.length) continue;
    const [a, b] = time ? [ps(lim * IU_PER_PS), ps(v)] : mmPair(lim, v);
    out.push(report("length_out_of_range", posOf(e.items[0]), itemLayer(e.items[0]), `Track length out of range (${name} ${kind} length ${a}; actual ${b})`, e.items, rule));
  }
}
function checkSkews(out: DrcMarker[], rule: DruRule, c: DruConstraint, conns: Conn[]) {
  const time = !!c.timeDomain, name = ruleLabel(rule), fmt = (v: number) => (time ? ps(v) : mm4(v / 1e6));
  const impl = (set: Conn[]) => {
    let max = 0, maxName = "", ref: Conn | null = null;
    for (const e of set) { const v = iu(time ? e.totalDelay : e.total, time); if (!ref || v > max) { max = v; maxName = e.net; ref = e; } }
    for (const e of set) {
      const total = iu(time ? e.totalDelay : e.total, time), skew = Math.round(total - max);
      let kind = "";
      if (c.max != null && Math.abs(skew) > bound(c.max, time)) kind = "max";
      else if (c.min != null && e !== ref && Math.abs(skew) < bound(c.min, time)) kind = "min";
      if (!kind || !e.items.length) continue;
      const lim = bound(kind === "max" ? c.max! : c.min!, time), last = e.items[e.items.length - 1];   // SetItems in a loop keeps the last item
      out.push(report("skew_out_of_range", posOf(e.items[0]), itemLayer(e.items[0]), `Skew between tracks out of range (${name} ${kind} skew ${fmt(lim)}; actual ${fmt(skew)}; target net length ${fmt(max)} (from ${maxName}); actual ${fmt(total)})`, [last], rule));
    }
  };
  if (c.options && c.options.includes("within_diff_pairs")) {
    const byCode = new Map<string, Conn>(); for (const e of [...conns].sort((a, b) => a.code - b.code)) byCode.set(e.net, e);
    const pairs: Conn[][] = [];
    for (const [net, e] of [...byCode]) {
      if (!byCode.has(net)) continue;
      const m = matchDpSuffix(net); const o = m.rv ? byCode.get(m.complement) : undefined;   // BOARD::DpCoupledNet
      if (o) { pairs.push([e, o]); byCode.delete(m.complement); }
    }
    for (const p of pairs) impl(p);
  } else impl(conns);
}
function checkViaCounts(out: DrcMarker[], rule: DruRule, c: DruConstraint, conns: Conn[]) {
  const name = ruleLabel(rule);
  for (const e of conns) {
    let text = "";
    if (c.max != null && e.viaCount > c.max) text = `Too many vias on a connection (${name} max count ${Math.trunc(c.max)}; actual ${e.viaCount})`;
    else if (c.min != null && e.viaCount < c.min) text = `Too few vias on a connection (${name} min count ${Math.trunc(c.min)}; actual ${e.viaCount})`;
    if (text && e.items.length) out.push(report("too_many_vias", posOf(e.items[0]), itemLayer(e.items[0]), text, [e.items[e.items.length - 1]], rule));
  }
}
function checkStubLengths(out: DrcMarker[], doc: BoardDoc, rule: DruRule, c: DruConstraint, conns: Conn[], topologyFor: (chain: string) => ChainTopology, all: Conductor[]) {
  const time = !!c.timeDomain; if (c.max == null && c.min == null) return;
  const fmt = (v: number) => (time ? ps(v) : mm4(v));
  const outOfRange = (v: number) => (c.max != null && iu(v, time) > bound(c.max, time)) || (c.min != null && iu(v, time) < bound(c.min, time));
  const chainOf = (net: string) => { const b = boardChains(doc).get(net); return b ? b.chain : ""; };
  const names = new Set<string>(); for (const e of conns) { const ch = chainOf(e.net); if (ch) names.add(ch); }
  const handled = new Set<string>();
  for (const chain of [...names].sort()) {
    const topo = topologyFor(chain); if (topo.status !== "OK") continue;
    handled.add(chain);
    for (const st of topo.stubs) {
      const v = time ? st.delay : st.length; if (!outOfRange(v)) continue;
      out.push(report("net_chain_stub_length", st.branchPoint, st.branchLayer, `Stub length (${fmt(v)}) out of range for net chain '${chain}'.`, st.items, rule));
    }
  }
  // the legacy proxy for chains whose topology is not a tree between the terminal pads: a member net that carries no
  // terminal pad is a stub as a whole
  // NETINFO_ITEM::GetTerminalPad( 0 / 1 )->GetNetCode()
  const padNet = new Map<string, string>(); for (const it of all) if (it.kind === "pad") { const u = K.uuidOf(it.pad.node); if (u && !padNet.has(u)) padNet.set(u, it.net); }
  const termNet = (u: string | null) => (u && padNet.has(u) ? padNet.get(u)! : null);
  for (const e of conns) {
    const b = boardChains(doc).get(e.net); if (!b || !b.chain || handled.has(b.chain)) continue;
    if (termNet(b.pads[0]) === e.net || termNet(b.pads[1]) === e.net) continue;
    const v = time ? e.totalDelay : e.total; if (!outOfRange(v)) continue;
    const at = e.items.length ? posOf(e.items[0]) : [0, 0] as Pt, layer = e.items.length ? itemLayer(e.items[0]) : "";
    out.push(report("net_chain_stub_length", at, layer, `Stub length (${fmt(v)}) out of range for net chain '${b.chain}' on net '${e.net}'.`, e.items, rule));
  }
}
// ---------------------------------------------------------------- return_path
type Poly = Pt[];
const P6 = 6;
const toD = (ps: Poly[]): PathsD => ps.map((p) => p.map((q) => ({ x: q[0], y: q[1] })));
const fromD = (ps: PathsD): Poly[] => ps.map((p) => p.map((q) => [q.x, q.y] as Pt)).filter((p) => p.length >= 3);
const unionPolys = (a: Poly[]): Poly[] => (a.length ? fromD(unionD(toD(a), [], FillRule.NonZero, P6)) : []);
const subtractPolys = (a: Poly[], b: Poly[]): Poly[] => (a.length && b.length ? fromD(differenceD(toD(a), toD(b), FillRule.NonZero, P6)) : a);
const area = (p: Poly) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]); return a / 2; };
/** PCB_TRACK::TransformShapeToPolygon (ERROR_INSIDE): the track's centre line grown by half its width, round ends. */
function trackPoly(c: Conductor): Poly[] {
  const n = c.item.node, a = pt(n, "start") as Pt, b = pt(n, "end") as Pt, w = c.kind === "segment" || c.kind === "arc" ? c.width : 0;
  let line: Pt[] = [a, b];
  if (c.kind === "arc") { const m = pt(n, "mid") as Pt; const arc = m && K.arcFrom3(a, m, b); if (arc) line = arcPoints(arc, a, b) as Pt[]; }
  return fromD(inflatePathsD([line.map((q) => ({ x: q[0], y: q[1] }))], w / 2, JoinType.Round, EndType.Round, 2, P6, 0.005));
}
const bboxOf = (ps: Poly[]) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of ps) for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
const boxHit = (a: number[], b: number[]) => !(b[0] > a[2] || b[2] < a[0] || b[1] > a[3] || b[3] < a[1]);
/** The outer contours of a flat polygon set (and each one's holes). */
function outlines(ps: Poly[]): Poly[][] {
  if (!ps.length) return [];
  let big = 0, sign = 1; for (const p of ps) { const a = area(p); if (Math.abs(a) > big) { big = Math.abs(a); sign = Math.sign(a) || 1; } }
  const outs = ps.filter((p) => Math.sign(area(p)) === sign), holes = ps.filter((p) => Math.sign(area(p)) !== sign);
  return outs.map((o) => [o, ...holes.filter((h) => inside(h[0], o))]);
}
function inside(p: Pt, poly: Poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
/** zoneUnionFor: the copper zones on the reference layer (whose net matches the pattern): their fill, else their outline. */
function zoneUnion(doc: BoardDoc, layer: string, netPat: string): Poly[] {
  const all: Poly[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "zone" || K.kid(it.node, "keepout")) continue;
    const zl = zoneLayers(it.node); if (!zl.some((l) => l === layer || (l === "*.Cu" && /\.Cu$/.test(layer)) || (l === "F&B.Cu" && (layer === "F.Cu" || layer === "B.Cu")))) continue;
    if (netPat) { const nn = K.kid(it.node, "net_name"); const name = nn ? K.str(nn[1]) : ""; if (!wildMatch(netPat, name)) continue; }
    const fills = K.kids(it.node, "filled_polygon").filter((f) => layerOf(f, zl[0] || "F.Cu") === layer).map((f) => K.ptsOf(f) as Pt[]).filter((p) => p.length >= 3);
    if (fills.length) all.push(...fills);
    else { const pg = K.kid(it.node, "polygon"); const pts = pg ? K.ptsOf(pg) as Pt[] : []; if (pts.length >= 3) all.push(pts); }
  }
  return all.length ? unionPolys(all) : [];
}
function checkReturnPath(out: DrcMarker[], doc: BoardDoc, rule: DruRule, c: DruConstraint, aggs: Conn[]) {
  const refLayer = c.refLayer!, refNet = c.refNet || "";
  if (!/^(F|B)\.Cu$|^In\d+\.Cu$/.test(refLayer) && !(doc.copper || []).includes(refLayer)) return;   // BOARD::GetLayerID
  const ref = zoneUnion(doc, refLayer, refNet), refBox = ref.length ? bboxOf(ref) : null;
  for (const agg of aggs) {
    const flagged: { poly: Poly[]; items: Conductor[]; layer: string; box: number[] }[] = [];
    const flag = (it: Conductor, region: Poly[]) => { for (const o of outlines(region)) flagged.push({ poly: o, items: [it], layer: layerOf(it.item.node), box: bboxOf([o[0]]) }); };
    for (const it of agg.items) {
      if (it.kind !== "segment" && it.kind !== "arc") continue;
      const poly = trackPoly(it);
      if (!ref.length || !refBox || !boxHit(bboxOf(poly), refBox)) { flag(it, poly); continue; }
      const diff = subtractPolys(poly, ref); if (!diff.length) continue;
      flag(it, diff);
    }
    if (!flagged.length) continue;
    const parent = flagged.map((_, i) => i);
    const root = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let i = 0; i < flagged.length; i++) {
      const bi = flagged[i].box.slice(); bi[0] -= 1e-6; bi[1] -= 1e-6; bi[2] += 1e-6; bi[3] += 1e-6;
      for (let j = i + 1; j < flagged.length; j++) {
        if (!boxHit(bi, flagged[j].box)) continue;
        const probe = inflatePathsD(toD(flagged[i].poly), 1e-6, JoinType.Round, EndType.Polygon, 2, P6, 0.005);
        if (!intersectD(probe, toD(flagged[j].poly), FillRule.NonZero, P6).filter((p) => p.length >= 3).length) continue;
        const ri = root(i), rj = root(j); if (ri !== rj) parent[ri] = rj;
      }
    }
    const groups = new Map<number, number[]>(); flagged.forEach((_, i) => { const r = root(i); const g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]); });
    for (const r of [...groups.keys()].sort((a, b) => a - b)) {
      const members = groups.get(r)!; const items: Conductor[] = []; let layer = "";
      const u = unionPolys(members.flatMap((i) => flagged[i].poly));
      for (const i of members) { for (const it of flagged[i].items) if (!items.includes(it)) items.push(it); if (!layer) layer = flagged[i].layer; }
      let at: Pt; if (u.length) { const b = bboxOf(u); at = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; } else at = items.length ? posOf(items[0]) : [0, 0];
      let text = `Net chain '${agg.net}' has no copper return path on reference layer '${refLayer}'.`;
      if (refNet) text += ` (net '${refNet}')`;
      out.push(report("net_chain_return_path", at, layer, text, items, rule));
    }
  }
}
