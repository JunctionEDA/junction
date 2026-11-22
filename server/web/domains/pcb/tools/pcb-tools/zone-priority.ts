// pcb-tools/zone-priority.ts — AutoAssignZonePriorities (pcbnew/zone_utils.cpp), the Zone Manager's "Automatically
// assign zone priorities" button: every pair of copper zones that overlap on a shared copper layer with different
// nets gets an edge from the zone whose net has more pads and vias inside the overlap (the smaller zone when the
// counts are within 20 % or both zero); a topological order of those edges gives the priorities (the first highest),
// and zones of one net that overlap share their group's highest priority.  Zones are the board's own (rule areas
// and teardrop areas sit out).
import { FillRule, areaPathsD, intersectD, type PathsD } from "clipper2-ts";
import type { BoardDoc } from "./types";
import { K } from "./state";
import { conductors, netTable } from "./netlist";
import { netOf } from "./nets";
import { zoneLayers } from "./nodes";
import { chainPoints } from "./zone-modes";

interface Z { id: string; net: string; layers: Set<string>; outlines: [number, number][][]; bbox: [number, number, number, number]; area: number; prio: number }
interface Edge { higher: Z; lower: Z; diff: number; fromArea: boolean }

const inPoly = (p: number[], poly: number[][]): boolean => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const inZone = (p: number[], z: Z): boolean => z.outlines.some((o) => inPoly(p, o));
const toPaths = (z: Z): PathsD => z.outlines.map((o) => o.map(([x, y]) => ({ x, y })));
const polyArea = (o: number[][]): number => { let a = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += o[j][0] * o[i][1] - o[i][0] * o[j][1]; return Math.abs(a) / 2; };

/** The eligible zones: copper, no rule area, no teardrop. */
function eligible(doc: BoardDoc): Z[] {
  const NT = netTable(doc), out: Z[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "zone") continue;
    const n = it.node;
    if (K.kid(n, "keepout") || K.kid(n, "attr")) continue;
    const layers = new Set(zoneLayers(n).filter((l) => /\.Cu$/.test(l)));
    if (!layers.size) continue;
    const outlines = K.kids(n, "polygon").map((p) => chainPoints(K.kid(p, "pts")) as [number, number][]).filter((c) => c.length >= 3);
    if (!outlines.length) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of outlines) for (const [x, y] of o) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pr = K.kid(n, "priority");
    out.push({ id: it.id, net: NT.key(netOf(n)), layers, outlines, bbox: [x0, y0, x1, y1], area: outlines.reduce((s, o) => s + polyArea(o), 0), prio: pr ? K.num(pr[1]) : 0 });
  }
  return out;
}

/**
 * The priorities AutoAssignZonePriorities gives, by zone id, or null when it changes nothing (fewer than two zones,
 * no overlaps, or the same priorities).  `current` overrides the priorities the zones start from (the Zone
 * Manager's list order).
 */
export function autoZonePriorities(doc: BoardDoc, current?: Map<string, number>): Map<string, number> | null {
  const zones = eligible(doc);
  if (zones.length < 2) return null;
  if (current) for (const z of zones) if (current.has(z.id)) z.prio = current.get(z.id)!;
  const original = new Map(zones.map((z) => [z, z.prio]));
  // findOverlappingPairs
  const pairs: { a: Z; b: Z; shared: Set<string> }[] = [];
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    const a = zones[i], b = zones[j];
    const shared = new Set([...a.layers].filter((l) => b.layers.has(l)));
    if (!shared.size) continue;
    if (a.bbox[2] < b.bbox[0] || b.bbox[2] < a.bbox[0] || a.bbox[3] < b.bbox[1] || b.bbox[3] < a.bbox[1]) continue;
    const inter = intersectD(toPaths(a), toPaths(b), FillRule.EvenOdd, 6);
    if (areaPathsD(inter) !== 0 || inZone(b.outlines[0][0], a) || inZone(a.outlines[0][0], b)) pairs.push({ a, b, shared });
  }
  if (!pairs.length) return null;
  // zones of one net that overlap form a group
  const parent = new Map<Z, Z>(zones.map((z) => [z, z]));
  const find = (z: Z): Z => { let p = parent.get(z)!; if (p !== z) { p = find(p); parent.set(z, p); } return p; };
  for (const p of pairs) if (p.a.net === p.b.net) { const ra = find(p.a), rb = find(p.b); if (ra !== rb) parent.set(rb, ra); }
  // computeConstraint
  const conds = conductors(doc).filter((c) => c.kind === "pad" || c.kind === "via");
  const edges: Edge[] = [];
  for (const p of pairs) {
    if (p.a.net === p.b.net) continue;
    let ca = 0, cb = 0;
    for (const c of conds) {
      const layer = [...c.layers].find((l) => p.shared.has(l)); if (!layer) continue;
      const at = c.anchors[0]; if (!at || !inZone(at, p.a) || !inZone(at, p.b)) continue;
      if (c.net === p.a.net) ca++; else if (c.net === p.b.net) cb++;
    }
    const byArea = (diff: number): Edge | null => {
      if (p.a.area === p.b.area) return null;
      const higher = p.a.area < p.b.area ? p.a : p.b;
      return { higher, lower: higher === p.a ? p.b : p.a, diff, fromArea: true };
    };
    let e: Edge | null;
    if (ca === 0 && cb === 0) e = byArea(0);
    else {
      const diff = Math.abs(ca - cb);
      if (diff / Math.max(ca, cb) < 0.2) e = byArea(diff);
      else { const higher = ca > cb ? p.a : p.b; e = { higher, lower: higher === p.a ? p.b : p.a, diff, fromArea: false }; }
    }
    if (e) edges.push(e);
  }
  // assignPrioritiesFromGraph
  if (edges.length) {
    const sorted = edges.slice().sort((x, y) => (x.fromArea !== y.fromArea ? (x.fromArea ? -1 : 1) : x.diff - y.diff));
    const adj = new Map<Z, Z[]>(), indeg = new Map<Z, number>(zones.map((z) => [z, 0]));
    for (const e of sorted) { if (!adj.has(e.higher)) adj.set(e.higher, []); adj.get(e.higher)!.push(e.lower); indeg.set(e.lower, indeg.get(e.lower)! + 1); }
    const byPrio = (x: Z, y: Z) => x.prio - y.prio;
    let queue = zones.filter((z) => indeg.get(z) === 0).sort(byPrio);
    const order: Z[] = [];
    while (queue.length) {
      const cur = queue.shift()!; order.push(cur);
      for (const nb of (adj.get(cur) || []).slice().sort(byPrio)) { indeg.set(nb, indeg.get(nb)! - 1); if (indeg.get(nb) === 0) queue.push(nb); }
      queue = queue.sort(byPrio);
    }
    if (order.length < zones.length) order.push(...zones.filter((z) => !order.includes(z)).sort(byPrio));
    order.forEach((z, i) => { z.prio = order.length - 1 - i; });
  }
  const groupMax = new Map<Z, number>();
  for (const z of zones) { const r = find(z); groupMax.set(r, Math.max(groupMax.get(r) || 0, z.prio)); }
  for (const z of zones) z.prio = groupMax.get(find(z))!;
  if (!zones.some((z) => z.prio !== original.get(z))) return null;
  return new Map(zones.map((z) => [z.id, z.prio]));
}

// ---------------------------------------------------------------- BOARD_EDITOR_CONTROL::ZonePriority*
/** A zone the priority commands see: not a rule area, not a teardrop area (any layer). */
interface PZ { id: string; layers: Set<string>; outlines: [number, number][][]; bbox: [number, number, number, number]; prio: number }
function priorityZones(doc: BoardDoc): PZ[] {
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const out: PZ[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "zone") continue; const n = it.node;
    if (K.kid(n, "keepout") || K.kid(n, "attr")) continue;
    const layers = new Set(zoneLayers(n).flatMap((l) => (l === "*.Cu" ? copper : l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : [l])));
    const outlines = K.kids(n, "polygon").map((p) => chainPoints(K.kid(p, "pts")) as [number, number][]).filter((c) => c.length >= 3);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const o of outlines) for (const [x, y] of o) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pr = K.kid(n, "priority");
    out.push({ id: it.id, layers, outlines, bbox: [x0, y0, x1, y1], prio: pr ? K.num(pr[1]) : 0 });
  }
  return out;
}
const inPZ = (p: number[], z: PZ): boolean => z.outlines.some((o) => inPoly(p, o));
/** getOverlappingZones: the zones sharing a layer with `zone` whose outline collides with it or contains / is contained by it. */
function overlappingOf(zones: PZ[], zone: PZ): PZ[] {
  const out: PZ[] = [];
  for (const c of zones) {
    if (c === zone) continue;
    if (![...c.layers].some((l) => zone.layers.has(l))) continue;
    if (!c.outlines.length || !zone.outlines.length) continue;
    if (zone.bbox[2] < c.bbox[0] || c.bbox[2] < zone.bbox[0] || zone.bbox[3] < c.bbox[1] || c.bbox[3] < zone.bbox[1]) continue;
    const paths = (z: PZ): PathsD => z.outlines.map((o) => o.map(([x, y]) => ({ x, y })));
    const inter = intersectD(paths(zone), paths(c), FillRule.EvenOdd, 6);
    if (areaPathsD(inter) !== 0 || inPZ(c.outlines[0][0], zone) || inPZ(zone.outlines[0][0], c)) out.push(c);
  }
  return out;
}
/** findCascadeZones: the contiguous chain of zones from a priority that must shift to free it; viable when it ends at a gap. */
function cascadeZones(byPriority: Map<number, PZ[]>, from: number, up: boolean): { zones: PZ[]; viable: boolean } {
  const zones: PZ[] = []; let p = from;
  for (let list = byPriority.get(p); list; list = byPriority.get(p)) {
    zones.push(...list);
    if (up) { if (p >= 0xFFFFFFFF) return { zones, viable: false }; p++; }
    else { if (p === 0) return { zones, viable: false }; p--; }
  }
  return { zones, viable: true };
}
/** ZONE_PRIORITY_CONTEXT_MENU::update: whether an overlapping zone has a higher / a lower priority than the one selected zone. */
export function zonePriorityAbility(doc: BoardDoc, ids: Iterable<string>): { canRaise: boolean; canLower: boolean } {
  const sel = Array.from(ids); const zones = priorityZones(doc); const zone = sel.length === 1 ? zones.find((z) => z.id === sel[0]) : undefined;
  let canRaise = false, canLower = false;
  if (zone) for (const o of overlappingOf(zones, zone)) { if (o.prio > zone.prio) canRaise = true; if (o.prio < zone.prio) canLower = true; }
  return { canRaise, canLower };
}
/**
 * ZonePriorityRaise / Lower / MoveToTop / MoveToBottom on the one selected zone: the new priorities by zone id (the
 * zone and any zone displaced with it), or null when the command does nothing.
 *   raise: just above the overlapping zone with the lowest priority still above ours, nothing else changes
 *   lower: just below the overlapping zone with the highest priority still below ours (a swap when that is 0)
 *   top / bottom: the highest / lowest overlapping priority, the chain of zones there shifted by one; of the two
 *                 ways to do it the viable one displacing fewer zones
 */
export function zonePriorityPlan(doc: BoardDoc, ids: Iterable<string>, how: string): Map<string, number> | null {
  const sel = Array.from(ids); if (sel.length !== 1) return null;
  const zones = priorityZones(doc); const zone = zones.find((z) => z.id === sel[0]); if (!zone) return null;
  const overlapping = overlappingOf(zones, zone); const out = new Map<string, number>();
  if (how === "raise") {
    let target: PZ | null = null; for (const o of overlapping) if (o.prio > zone.prio && (!target || o.prio < target.prio)) target = o;
    if (!target) return null;
    if (target.prio < 0xFFFFFFFF) out.set(zone.id, target.prio + 1); else { out.set(zone.id, 0xFFFFFFFF); out.set(target.id, zone.prio); }
    return out;
  }
  if (how === "lower") {
    let target: PZ | null = null; for (const o of overlapping) if (o.prio < zone.prio && (!target || o.prio > target.prio)) target = o;
    if (!target) return null;
    if (target.prio > 0) out.set(zone.id, target.prio - 1); else { out.set(zone.id, 0); out.set(target.id, zone.prio); }
    return out;
  }
  const byPriority = new Map<number, PZ[]>(); for (const z of zones) if (z !== zone) { const l = byPriority.get(z.prio); if (l) l.push(z); else byPriority.set(z.prio, [z]); }
  if (how === "top") {
    let max = zone.prio; for (const o of overlapping) max = Math.max(max, o.prio);
    if (zone.prio >= max) return null;
    const down = cascadeZones(byPriority, max, false); const up = max < 0xFFFFFFFF ? cascadeZones(byPriority, max + 1, true) : { zones: [], viable: false };
    if (!down.viable && !up.viable) return null;
    if (down.viable && (!up.viable || down.zones.length <= up.zones.length)) { out.set(zone.id, max); for (const z of down.zones) out.set(z.id, z.prio - 1); }
    else { out.set(zone.id, max + 1); for (const z of up.zones) out.set(z.id, z.prio + 1); }
    return out;
  }
  if (how === "bottom") {
    let min = zone.prio; for (const o of overlapping) min = Math.min(min, o.prio);
    if (zone.prio <= min) return null;
    const up = cascadeZones(byPriority, min, true); const down = min > 0 ? cascadeZones(byPriority, min - 1, false) : { zones: [], viable: false };
    if (!up.viable && !down.viable) return null;
    if (up.viable && (!down.viable || up.zones.length <= down.zones.length)) { out.set(zone.id, min); for (const z of up.zones) out.set(z.id, z.prio + 1); }
    else { out.set(zone.id, min - 1); for (const z of down.zones) out.set(z.id, z.prio - 1); }
    return out;
  }
  return null;
}
