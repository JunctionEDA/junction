// pcb-tools/via-stitch.ts — PCB_VIA_STITCH (pcbnew/generators/pcb_via_stitch.cpp): a polygon that fills itself with
// free vias of one net where that net's zones overlap on at least two of the via's layers (Stitch: a plain or
// staggered grid, or a baked toroidal Poisson-disk tile shifted by the seed), or rings a guarded net's tracks with
// them (Guard: the clearance envelope walked at the pitch).  Update keeps the vias already on a wanted cell, moves the
// ones whose cell moved, removes the rest and adds the missing; excluded cells (deleted vias) stay empty.  Also the
// DRC provider via_stitch_overlap (drc_test_provider_via_stitch.cpp).
import type { BoardDoc, DesignSettings, DrcMarker, PcbChange } from "./types";
import { removedChange, upsertChange } from "./changes";
import { designSettings, marker } from "./drc";
import { viaLayers } from "./distances";
import { netOf, netStyle } from "./nets";
import { padShapePolygon } from "./pad-outline";
import { padsOf } from "./route-geom";
import { rulePairClearance } from "./rule-resolver";
import { K } from "./state";
import { rotator } from "./util";
import { stadiumOutside } from "../../fab/poly";
import { contains as polyContains, inflate, intersect, subtract, union } from "../../fab/zonefill";

type V = [number, number];
type Path = { x: number; y: number }[];
type Poly = Path[];
const IU = 1e6;
const iu = (mm: number): number => Math.round(mm * IU);
const mm = (v: number): number => { const x = +(v / IU).toFixed(6); return x === 0 ? 0 : x; };
const KR = (v: number): number => (v < 0 ? -Math.round(-v) : Math.round(v));
const g10 = (v: number): string => String(+v.toPrecision(10));   // "%.10g"
export const VIA_STITCH_TYPE = "via_stitch";
export const POISSON_TILE_PITCHES = 8;
const POISSON_TILE_SEED = 0x542c21fc;
const POLY_ERR = 0.005;   // polyApproxError, mm

// ---------------------------------------------------------------- boost::random
/** boost::random::mt19937. */
export class MT19937 {
  private mt = new Uint32Array(624); private i = 625;
  constructor(seed: number) { this.mt[0] = seed >>> 0; for (let i = 1; i < 624; i++) { const p = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30); this.mt[i] = (Math.imul(1812433253, p) + i) >>> 0; } this.i = 624; }
  next(): number {
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (this.mt[k] & 0x80000000) | (this.mt[(k + 1) % 624] & 0x7fffffff);
        this.mt[k] = (this.mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.i = 0;
    }
    let y = this.mt[this.i++];
    y ^= y >>> 11; y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0; y = (y ^ ((y << 15) & 0xefc60000)) >>> 0; y ^= y >>> 18;
    return y >>> 0;
  }
  /** uniform_real_distribution<double>( 0, 1 ): one draw over 2^32, again when it lands on 1. */
  uniform(): number { for (;;) { const r = this.next() / 4294967296; if (r < 1) return r; } }
  /** uniform_int_distribution( 0, range ). */
  uniformInt(range: number): number {
    if (range === 0) return 0;
    const brange = 0xffffffff; let bucket = Math.floor(brange / (range + 1)); if (brange % (range + 1) === range) bucket++;
    for (;;) { const r = Math.floor(this.next() / bucket); if (r <= range) return r; }
  }
}
/** POISSON_DISK::ToroidalUnitTile: Bridson's sampling on the unit torus. */
export function toroidalUnitTile(minDist: number, seed: number): [number, number][] {
  const samples: [number, number][] = []; if (minDist <= 0 || minDist > 0.5) return samples;
  const gridN = Math.max(3, Math.ceil(Math.SQRT2 / minDist)), cell = 1 / gridN; const grid = new Int32Array(gridN * gridN).fill(-1); const active: number[] = [];
  const cellOf = (p: [number, number]): [number, number] => { let gx = Math.floor(p[0] / cell), gy = Math.floor(p[1] / cell); gx = ((gx % gridN) + gridN) % gridN; gy = ((gy % gridN) + gridN) % gridN; return [gx, gy]; };
  const tor = (dx: number, dy: number): number => { if (dx > 0.5) dx -= 1; if (dx < -0.5) dx += 1; if (dy > 0.5) dy -= 1; if (dy < -0.5) dy += 1; return dx * dx + dy * dy; };
  const rng = new MT19937(seed);
  const p0: [number, number] = [rng.uniform(), 0]; p0[1] = rng.uniform();
  const [gx, gy] = cellOf(p0); samples.push(p0); grid[gy * gridN + gx] = 0; active.push(0);
  while (active.length) {
    const idx = rng.uniformInt(active.length - 1); const base = samples[active[idx]]; let accepted = false;
    for (let k = 0; k < 30; k++) {
      const theta = rng.uniform() * 2 * Math.PI; const rho = minDist + rng.uniform() * minDist;
      const c: [number, number] = [base[0] + rho * Math.cos(theta), base[1] + rho * Math.sin(theta)];
      c[0] -= Math.floor(c[0]); c[1] -= Math.floor(c[1]);
      const [cx, cy] = cellOf(c); let close = false;
      for (let dy = -2; dy <= 2 && !close; dy++) {
        const ny = ((cy + dy) % gridN + gridN) % gridN;
        for (let dx = -2; dx <= 2 && !close; dx++) { const nx = ((cx + dx) % gridN + gridN) % gridN; const n = grid[ny * gridN + nx]; if (n >= 0 && tor(samples[n][0] - c[0], samples[n][1] - c[1]) < minDist * minDist) close = true; }
      }
      if (close) continue;
      samples.push(c); grid[cy * gridN + cx] = samples.length - 1; active.push(samples.length - 1); accepted = true; break;
    }
    if (!accepted) { active[idx] = active[active.length - 1]; active.pop(); }
  }
  return samples;
}
let bakedTile: [number, number][] | null = null;
export const poissonTile = (): [number, number][] => bakedTile || (bakedTile = toroidalUnitTile(1 / POISSON_TILE_PITCHES, POISSON_TILE_SEED));

// ---------------------------------------------------------------- the generator node
export interface Stitch {
  uuid: string; locked: boolean; origin: V; outline: V[]; pitch: number; layout: number; mode: number; seed: number; offset: V;
  netName: string; guardedNetName: string; exCells: V[]; exPos: V[]; via: SNode; members: string[]; extra: SNode[];
}
const kidNum = (n: SNode, k: string, d: number): number => { const c = K.kid(n, k); return c ? K.num(c[1], d) : d; };
const ptsOf = (n: SNode | null): V[] => (n ? (K.ptsOf(n) as [number, number][]).map((p) => [iu(p[0]), iu(p[1])] as V) : []);
export const isViaStitch = (it: KItem | undefined | null): it is KItem => !!it && it.kind === "generated" && K.str((K.kid(it.node, "type") || [])[1]) === VIA_STITCH_TYPE;
/** PCB_VIA_STITCH::SetProperties and its template via. */
export function readStitch(node: SNode): Stitch {
  const o = K.kid(node, "origin"), oxy = o && K.kid(o, "xy"); const ec = K.kid(node, "excluded_grid_cells"), cells = ec && K.kid(ec, "cells");
  const tpl = K.kid(node, "templates"); let via: SNode | null = null;
  for (const t of tpl ? K.kids(tpl, "template") : []) if (K.str((K.kid(t, "name") || [])[1]) === "via") via = K.kid(t, "via");
  const lk = K.kid(node, "locked"); const u = K.kid(node, "uuid");
  return {
    uuid: u ? K.str(u[1]) : "", locked: !!lk && K.str(lk[1]) !== "no", origin: oxy ? [iu(K.num(oxy[1])), iu(K.num(oxy[2]))] : [0, 0], outline: ptsOf(K.kid(node, "outline")),
    pitch: iu(kidNum(node, "pitch", 0)), layout: kidNum(node, "layout", 0), mode: kidNum(node, "mode", 0), seed: kidNum(node, "seed", 0) >>> 0,
    offset: [iu(kidNum(node, "origin_offset_x", 0)), iu(kidNum(node, "origin_offset_y", 0))],
    netName: K.str((K.kid(node, "net_name") || [])[1] || ""), guardedNetName: K.str((K.kid(node, "guarded_net_name") || [])[1] || ""),
    exCells: cells ? K.kids(cells, "ij").map((c) => [K.num(c[1]), K.num(c[2])] as V) : [], exPos: ptsOf(K.kid(node, "excluded_positions")),
    via: via ? K.cloneNode(via) : K.parse(`(via (at 0 0) (size 0) (drill 0) (layers "F.Cu" "B.Cu") (free yes))`) as SNode,
    members: K.groupMemberIds(node), extra: [],
  };
}
const cmpV = (a: V, b: V): number => (a[0] - b[0]) || (a[1] - b[1]);
const xyText = (p: V): string => `(xy ${mm(p[0])} ${mm(p[1])})`;
/** PCB_IO_KICAD_SEXPR::format( PCB_GENERATOR ): the properties in key order, the template, the sorted members. */
export function writeStitch(st: Stitch): SNode {
  const p: string[] = [];
  if (st.exCells.length) p.push(`(excluded_grid_cells (cells ${st.exCells.slice().sort(cmpV).map((c) => `(ij ${c[0]} ${c[1]})`).join(" ")}))`);
  if (st.exPos.length) p.push(`(excluded_positions (pts ${st.exPos.slice().sort(cmpV).map(xyText).join(" ")}))`);
  if (st.guardedNetName) p.push(`(guarded_net_name ${JSON.stringify(st.guardedNetName)})`);
  p.push(`(layout ${st.layout})`, `(mode ${st.mode})`);
  if (st.netName) p.push(`(net_name ${JSON.stringify(st.netName)})`);
  p.push(`(origin ${xyText(st.origin)})`, `(origin_offset_x ${g10(st.offset[0] / IU)})`, `(origin_offset_y ${g10(st.offset[1] / IU)})`);
  if (st.outline.length) p.push(`(outline (pts ${st.outline.map(xyText).join(" ")}))`);
  p.push(`(pitch ${g10(st.pitch / IU)})`, `(seed ${st.seed | 0})`);
  const members = st.members.slice().sort();
  const text = `(generated (uuid ${JSON.stringify(st.uuid)}) (type via_stitch) (name "Via Stitching") (layer "F.Cu")${st.locked ? " (locked yes)" : ""} ${p.join(" ")} (templates (template (name "via") ${K.serialize(st.via)})) (members${members.map((m) => " " + JSON.stringify(m)).join("")}))`;
  return K.parse(text) as SNode;
}
const viaSizeOf = (v: SNode): number => { const s = K.kid(v, "size"); return s ? iu(K.num(s[1])) : 0; };
const viaDrillOf = (v: SNode): number => { const s = K.kid(v, "drill"); return s ? iu(K.num(s[1])) : 0; };
function setKid(n: SNode, key: string, val: SNode): void { const i = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === key); if (i > 0) n[i] = val; else n.push(val); }
/** InitializeDefaults: the board's current via size and drill (else 0.6 / 0.3 mm), a pitch of 2 mm or two via sizes. */
export function initializeDefaults(st: Stitch, cur: { viaSize?: number; viaDrill?: number }): void {
  if (viaSizeOf(st.via) <= 0) setKid(st.via, "size", ["size", cur.viaSize && cur.viaSize > 0 ? cur.viaSize : 0.6]);
  if (viaDrillOf(st.via) <= 0) setKid(st.via, "drill", ["drill", cur.viaDrill && cur.viaDrill > 0 ? cur.viaDrill : 0.3]);
  if (st.pitch <= 0) st.pitch = Math.max(iu(2), viaSizeOf(st.via) * 2);
}
/** A new stitch on an outline (ZONE_CREATE_HELPER, ZONE_MODE::STITCH). */
export function newStitch(outline: [number, number][], netName: string, cur: { viaSize?: number; viaDrill?: number }): Stitch {
  const st: Stitch = { uuid: K.newUuid(), locked: false, origin: [0, 0], outline: outline.map((p) => [iu(p[0]), iu(p[1])] as V), pitch: 0, layout: 0, mode: 0, seed: 0, offset: [0, 0],
    netName, guardedNetName: "", exCells: [], exPos: [], via: K.parse(`(via (at 0 0) (size 0) (drill 0) (layers "F.Cu" "B.Cu") (free yes))`) as SNode, members: [], extra: [] };
  initializeDefaults(st, cur); return st;
}
const usesGridCells = (st: Stitch): boolean => st.layout !== 2 && st.mode !== 1;
const roundDiv = (a: number, b: number): number => (a >= 0 ? Math.trunc((a + Math.trunc(b / 2)) / b) : -Math.trunc((-a + Math.trunc(b / 2)) / b));
const odd = (r: number): boolean => ((r % 2) + 2) % 2 !== 0;
/** PCB_VIA_STITCH::cellForPosition. */
export function cellForPosition(st: Stitch, p: V): V {
  const pitch = st.pitch > 0 ? st.pitch : 1; if (!usesGridCells(st)) return p;
  const row = roundDiv(p[1] - st.offset[1], pitch); const xs = st.layout === 1 && odd(row) ? Math.trunc(pitch / 2) : 0;
  return [roundDiv(p[0] - st.offset[0] - xs, pitch), row];
}
/** PCB_VIA_STITCH::positionForCell. */
export function positionForCell(st: Stitch, c: V, pitch: number): V {
  if (!usesGridCells(st)) return c;
  const xs = st.layout === 1 && odd(c[1]) ? Math.trunc(pitch / 2) : 0; return [c[0] * pitch + st.offset[0] + xs, c[1] * pitch + st.offset[1]];
}
/** ExcludePosition / ClearExclusion / ClearAllExclusions. */
export function excludePosition(st: Stitch, p: V): void { if (usesGridCells(st)) { const c = cellForPosition(st, p); if (!st.exCells.some((x) => x[0] === c[0] && x[1] === c[1])) st.exCells.push(c); } else if (!st.exPos.some((x) => x[0] === p[0] && x[1] === p[1])) st.exPos.push(p); }
export function clearAllExclusions(st: Stitch): void { st.exCells = []; st.exPos = []; }
export const hasExclusions = (st: Stitch): boolean => st.exCells.length > 0 || st.exPos.length > 0;

// ---------------------------------------------------------------- buildPlacementCells
export interface StitchOpts { project?: unknown; settings?: DesignSettings | null; curViaSize?: number; curViaDrill?: number }
const toPath = (pts: V[]): Path => pts.map((p) => ({ x: mm(p[0]), y: mm(p[1]) }));
const fromMm = (pts: [number, number][]): Path => pts.map((p) => ({ x: p[0], y: p[1] }));
const rect = (b: number[]): Poly => [[{ x: mm(b[0]), y: mm(b[1]) }, { x: mm(b[2]), y: mm(b[1]) }, { x: mm(b[2]), y: mm(b[3]) }, { x: mm(b[0]), y: mm(b[3]) }]];
const bboxIU = (pts: V[]): number[] => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); } return b; };
const polyBox = (a: Poly): number[] => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of a) for (const q of p) { const x = iu(q.x), y = iu(q.y); b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); } return b; };
const boxesHit = (a: number[], b: number[]): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const itemBoxIU = (it: KItem): number[] | null => (it.bbox ? [iu(it.bbox[0]), iu(it.bbox[1]), iu(it.bbox[2]), iu(it.bbox[3])] : null);
const areaOf = (p: Path): number => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y; return a / 2; };
function zoneLayers(n: SNode, copper: string[]): string[] {
  const ls = K.kid(n, "layers"), l = K.kid(n, "layer"); const names = ls ? ls.slice(1).map((x) => K.str(x)) : l ? [K.str(l[1])] : [];
  const out: string[] = []; for (const x of names) { if (x === "*.Cu" || x === "F&B.Cu") out.push(...(x === "*.Cu" ? copper : ["F.Cu", "B.Cu"])); else out.push(x); } return out;
}
const zoneFill = (n: SNode, layer: string): Poly => K.kids(n, "filled_polygon").filter((f) => { const l = K.kid(f, "layer"); return !l || K.str(l[1]) === layer; }).map((f) => toPath(ptsOf(f)));
const zoneOutline = (n: SNode): Poly => K.kids(n, "polygon").map((p) => toPath(ptsOf(p)));
const isRuleArea = (n: SNode): boolean => !!K.kid(n, "keepout");
const noVias = (n: SNode): boolean => { const k = K.kid(n, "keepout"); const v = k && K.kid(k, "vias"); return !!v && K.str(v[1]) === "not_allowed"; };
const circleOut = (c: [number, number], r: number): Path => { if (!(r > 0)) return []; return fromMm(stadiumOutside(c[0], c[1], c[0], c[1], 2 * r, POLY_ERR)); };

/** PCB_VIA_STITCH::buildPlacementCells: grid cells (or absolute positions) where a via fits. */
export function buildPlacementCells(doc: BoardDoc, st: Stitch, o: StitchOpts = {}, skip?: Set<string>): V[] {
  const cells: V[] = []; if (!st.outline.length) return cells;
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const s = o.settings || designSettings((o.project || null) as Parameters<typeof designSettings>[0]);
  const viaSize = viaSizeOf(st.via) > 0 ? viaSizeOf(st.via) : iu(o.curViaSize || 0.6), pitch = st.pitch > 0 ? st.pitch : Math.max(iu(2), viaSize * 2);
  const viaDrill = viaDrillOf(st.via) > 0 ? viaDrillOf(st.via) : iu(o.curViaDrill || 0.3);
  if (!st.netName) return cells;
  const sb = bboxIU(st.outline); const stitchClip = rect(sb);
  const zones = [...doc.items.values()].filter((it) => it.kind === "zone");
  for (const fp of doc.items.values()) if (fp.kind === "footprint") for (const z of K.kids(fp.node, "zone")) zones.push({ id: fp.id + ":zone", kind: "zone", node: z, bbox: null } as unknown as KItem);
  const perLayer = new Map<string, Poly>();
  for (const z of zones) {
    const n = z.node; if (isRuleArea(n)) continue;
    if (zoneNet(n) !== st.netName) continue;
    const zb = itemBoxIU(z) || polyBox(zoneOutline(n)); if (!boxesHit(zb, sb)) continue;
    for (const layer of zoneLayers(n, copper)) {
      let clipped: Poly = st.mode === 1 ? zoneOutline(n) : zoneFill(n, layer);
      if (!clipped.length) continue;
      clipped = intersect(clipped, stitchClip); if (!clipped.length) continue;
      perLayer.set(layer, union(perLayer.get(layer) || [], clipped));
    }
  }
  const viaCu = [...viaLayers(st.via, copper)].filter((l) => copper.includes(l));
  const layerOrder = (l: string): number => (l === "F.Cu" ? 0 : l === "B.Cu" ? 2 : 2 + 2 * copper.indexOf(l));
  viaCu.sort((a, b) => layerOrder(a) - layerOrder(b));
  const fills = viaCu.map((l) => perLayer.get(l)).filter((f): f is Poly => !!f && f.length > 0);
  if (fills.length < 2) return cells;
  let allowed: Poly = []; let covered = fills[0];
  for (let i = 1; i < fills.length; i++) { const ov = intersect(fills[i], covered); if (ov.length) allowed = union(allowed, ov); if (i + 1 < fills.length) covered = union(covered, fills[i]); }
  if (!allowed.length) return cells;
  allowed = intersect(allowed, [toPath(st.outline)]); if (!allowed.length) return cells;
  allowed = inflate(allowed, -mm(viaSize) / 2, true, POLY_ERR); if (!allowed.length) return cells;
  // obstacles
  const nm = (n: SNode): string => netOf(n).name || zoneNet(n);
  const clearance = (other: string, layer: string | null, kind?: string): number => iu(rulePairClearance(doc, s, st.netName, other, layer, kind));
  const holeClear = iu(s.holeClearance || 0), holeToHole = iu(s.minHoleToHole || 0);
  let worst = Math.max(s.clearance || 0, s.minClearance || 0); for (const nc of Object.values(s.netclasses || {})) worst = Math.max(worst, nc && typeof nc.clearance === "number" ? nc.clearance : 0);
  const qb = [sb[0] - iu(worst) - viaSize, sb[1] - iu(worst) - viaSize, sb[2] + iu(worst) + viaSize, sb[3] + iu(worst) + viaSize]; const queryClip = rect(qb);
  const obstacles: Path[] = []; const own = new Set([...st.members, ...(skip || [])]);
  const holeSeen = new Set<string>();
  const addHole = (key: string, net: string, a: [number, number], b: [number, number], w: number): void => {
    if (!(w > 0) || holeSeen.has(key)) return; holeSeen.add(key);
    let margin = viaDrill / 2 + holeToHole; if (net !== st.netName) margin = Math.max(margin, viaSize / 2 + holeClear);
    obstacles.push(fromMm(stadiumOutside(a[0], a[1], b[0], b[1], w + 2 * mm(margin), POLY_ERR)));
  };
  const inQuery = (b: number[] | null): boolean => !!b && boxesHit(b, qb);
  for (const it of doc.items.values()) {
    if (own.has(it.id)) continue;
    const n = it.node;
    if (it.kind === "segment" || it.kind === "arc") {
      const layer = K.str((K.kid(n, "layer") || [])[1]); if (!viaCu.includes(layer) || !inQuery(itemBoxIU(it))) continue;
      const net = nm(n); if (net === st.netName) continue;
      const w = K.num((K.kid(n, "width") || [])[1]); const margin = Math.max(viaSize / 2 + clearance(net, layer), viaDrill / 2 + holeClear);
      const pts = it.kind === "arc" ? arcPts(n) : [pt(n, "start"), pt(n, "end")];
      for (let i = 0; i + 1 < pts.length; i++) obstacles.push(fromMm(stadiumOutside(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w + 2 * mm(margin), POLY_ERR)));
    } else if (it.kind === "via") {
      if (!inQuery(itemBoxIU(it))) continue;
      const net = nm(n), at = pt(n, "at"), size = K.num((K.kid(n, "size") || [])[1]), drill = K.num((K.kid(n, "drill") || [])[1]);
      const ls = viaLayers(n, copper); if (!viaCu.some((l) => ls.has(l))) continue;
      addHole(it.id, net, at, at, drill);
      let margin = viaSize / 2 + clearance(net, viaCu.find((l) => ls.has(l)) || null, "via"); if (net !== st.netName) margin = Math.max(margin, viaDrill / 2 + holeClear);
      obstacles.push(circleOut(at, size / 2 + mm(margin)));
    } else if (it.kind === "footprint") {
      if (!inQuery(itemBoxIU(it))) continue;
      for (const p of padsOf(it)) {
        const dr = K.kid(p.node, "drill"); const net = p.net.name;
        if (dr && p.type !== "smd") { const d1 = K.num(dr[1]), oval = K.str(dr[1]) === "oval"; const dx = oval ? K.num(dr[2]) : d1, dy = oval ? K.num(dr[3], dx) : d1; const R = rotator(p.rot); const ext = Math.max(dx, dy) / 2 - Math.min(dx, dy) / 2; const v = dx > dy ? R(ext, 0) : R(0, ext); addHole(it.id + "#" + p.index, net, [p.x - v[0], p.y - v[1]], [p.x + v[0], p.y + v[1]], Math.min(dx, dy)); }
        if (p.type === "np_thru_hole") continue;
        const layers = new Set<string>(); for (const l of p.layers) { if (l === "*.Cu") copper.forEach((c) => layers.add(c)); else if (l === "F&B.Cu") { layers.add("F.Cu"); layers.add("B.Cu"); } else layers.add(l); }
        for (const layer of viaCu) {
          if (!layers.has(layer)) continue;
          let margin = viaSize / 2 + clearance(net, layer); if (net !== st.netName) margin = Math.max(margin, viaDrill / 2 + holeClear);
          const [ox, oy] = rotator(p.rot)(p.off[0], p.off[1]);
          const shape: Path = fromMm(padShapePolygon(p.node, [p.x + ox, p.y + oy]) as [number, number][]);
          obstacles.push(...inflate([shape], mm(margin), true, POLY_ERR));
        }
      }
    } else if (/^gr_(line|rect|poly|circle|arc)$/.test(it.kind)) {
      const layer = K.str((K.kid(n, "layer") || [])[1]); if (!viaCu.includes(layer) || !inQuery(itemBoxIU(it))) continue;
      const net = nm(n); if (net === st.netName) continue;
      const stv = K.kid(n, "stroke"), wn = (stv && K.kid(stv, "width")) || K.kid(n, "width"); const w = wn ? K.num(wn[1]) : 0;
      const margin = Math.max(viaSize / 2 + clearance(net, layer), viaDrill / 2 + holeClear);
      const pts = it.kind === "gr_line" ? [pt(n, "start"), pt(n, "end")] : it.kind === "gr_arc" ? arcPts(n) : it.kind === "gr_poly" ? (K.ptsOf(n) as [number, number][]) : it.kind === "gr_rect" ? rectPts(n) : circlePts(n);
      const closed = it.kind !== "gr_line" && it.kind !== "gr_arc";
      for (let i = 0; i + 1 < pts.length + (closed ? 1 : 0); i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; obstacles.push(fromMm(stadiumOutside(a[0], a[1], b[0], b[1], w + 2 * mm(margin), POLY_ERR))); }
      const f = K.kid(n, "fill"); if (closed && f && /^(yes|solid)$/.test(K.str(f[1]))) obstacles.push(...inflate([fromMm(pts)], mm(margin), true, POLY_ERR));
    }
  }
  let obs: Poly = union(obstacles.filter((p) => p.length >= 3));
  for (const z of zones) {
    const n = z.node; const zb = itemBoxIU(z) || polyBox(zoneOutline(n)); if (!boxesHit(zb, qb)) continue;
    if (isRuleArea(n)) {
      if (!noVias(n) || !zoneLayers(n, copper).some((l) => viaCu.includes(l))) continue;
      const area = intersect(zoneOutline(n), queryClip); if (area.length) obs = union(obs, inflate(area, mm(viaSize) / 2, true, POLY_ERR));
      continue;
    }
    const net = zoneNet(n); if (net === st.netName) continue;
    for (const layer of zoneLayers(n, copper)) {
      if (!viaCu.includes(layer)) continue;
      let near = zoneFill(n, layer); if (!near.length) continue;
      near = intersect(near, queryClip); if (!near.length) continue;
      const zm = Math.max(viaSize / 2 + clearance(net, layer), viaDrill / 2 + holeClear);
      near = inflate(near, mm(zm), true, POLY_ERR);
      near = subtract(near, intersect(zoneOutline(n), queryClip));
      if (near.length) obs = union(obs, near);
    }
  }
  allowed = subtract(allowed, obs); if (!allowed.length) return cells;
  const bb = polyBox(allowed); const valid = (p: V): boolean => polyContains(allowed, mm(p[0]), mm(p[1]));
  if (st.mode === 1) {
    if (!st.guardedNetName) return cells;
    const env: Path[] = [], guarded: Path[] = []; const safety = iu(POLY_ERR) + iu(0.002);
    for (const it of doc.items.values()) {
      if (it.kind !== "segment" && it.kind !== "arc" && it.kind !== "via") continue;
      if (nm(it.node) !== st.guardedNetName || !boxesHit(itemBoxIU(it) || [0, 0, -1, -1], sb)) continue;
      const n = it.node; const layer = it.kind === "via" ? "F.Cu" : K.str((K.kid(n, "layer") || [])[1]);
      const margin = viaSize / 2 + clearance(st.guardedNetName, layer, it.kind === "via" ? "via" : undefined) + safety;
      if (it.kind === "via") { const at = pt(n, "at"), r = K.num((K.kid(n, "size") || [])[1]) / 2; env.push(circleOut(at, r + mm(margin))); guarded.push(circleOut(at, r)); continue; }
      const w = K.num((K.kid(n, "width") || [])[1]); const pts = it.kind === "arc" ? arcPts(n) : [pt(n, "start"), pt(n, "end")];
      for (let i = 0; i + 1 < pts.length; i++) { env.push(fromMm(stadiumOutside(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w + 2 * mm(margin), POLY_ERR))); guarded.push(fromMm(stadiumOutside(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], w, POLY_ERR))); }
    }
    return sampleGuardEnvelope(union(env.filter((p) => p.length >= 3)), union(guarded.filter((p) => p.length >= 3)), pitch, valid);
  }
  if (st.layout === 2) {
    const tile = poissonTile(); const tileSize = Math.max(1, pitch * POISSON_TILE_PITCHES);
    const rng = new MT19937(st.seed); const ox = rng.uniform() * tileSize, oy = rng.uniform() * tileSize;
    const fx = Math.floor((bb[0] - ox) / tileSize), fy = Math.floor((bb[1] - oy) / tileSize), lx = Math.floor((bb[2] - ox) / tileSize), ly = Math.floor((bb[3] - oy) / tileSize);
    const seen = new Set<string>();
    for (let ty = fy; ty <= ly; ty++) for (let tx = fx; tx <= lx; tx++) for (const sp of tile) {
      const p: V = [KR(ox + (tx + sp[0]) * tileSize), KR(oy + (ty + sp[1]) * tileSize)];
      if (p[0] < bb[0] || p[0] > bb[2] || p[1] < bb[1] || p[1] > bb[3]) continue;
      if (valid(p) && !seen.has(p.join())) { seen.add(p.join()); cells.push(p); }
    }
    return cells.sort(cmpV);
  }
  const startRow = Math.floor((bb[1] - st.offset[1]) / pitch), startCol = Math.floor((bb[0] - st.offset[0]) / pitch);
  const origin: V = [startCol * pitch + st.offset[0], startRow * pitch + st.offset[1]];
  for (let row = startRow, y = origin[1]; y <= bb[3]; y += pitch, row++) {
    const xo = st.layout === 1 && odd(row) ? Math.trunc(pitch / 2) : 0;
    for (let col = startCol, x = origin[0] + xo; x <= bb[2]; x += pitch, col++) if (valid([x, y])) cells.push([col, row]);
  }
  return cells.sort(cmpV);
}
function zoneNet(n: SNode): string { const nn = K.kid(n, "net_name"); if (nn) return K.str(nn[1]); return netOf(n).name; }
const pt = (n: SNode, k: string): [number, number] => { const c = K.kid(n, k); return c ? [K.num(c[1]), K.num(c[2])] : [0, 0]; };
function arcPts(n: SNode): [number, number][] {
  const s = pt(n, "start"), m = pt(n, "mid"), e = pt(n, "end"); const out: [number, number][] = [];
  const d = 2 * (s[0] * (m[1] - e[1]) + m[0] * (e[1] - s[1]) + e[0] * (s[1] - m[1])); if (!d) return [s, e];
  const cx = ((s[0] ** 2 + s[1] ** 2) * (m[1] - e[1]) + (m[0] ** 2 + m[1] ** 2) * (e[1] - s[1]) + (e[0] ** 2 + e[1] ** 2) * (s[1] - m[1])) / d;
  const cy = ((s[0] ** 2 + s[1] ** 2) * (e[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (s[0] - e[0]) + (e[0] ** 2 + e[1] ** 2) * (m[0] - s[0])) / d;
  const r = Math.hypot(s[0] - cx, s[1] - cy), a0 = Math.atan2(s[1] - cy, s[0] - cx), am = Math.atan2(m[1] - cy, m[0] - cx), a1 = Math.atan2(e[1] - cy, e[0] - cx);
  const n180 = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };
  const sweep = n180(am - a0) + n180(a1 - am); const k = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 16)));
  for (let i = 0; i <= k; i++) { const a = a0 + sweep * i / k; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return out;
}
const rectPts = (n: SNode): [number, number][] => { const s = pt(n, "start"), e = pt(n, "end"); return [s, [e[0], s[1]], e, [s[0], e[1]]]; };
const circlePts = (n: SNode): [number, number][] => { const c = pt(n, "center"), e = pt(n, "end"), r = Math.hypot(e[0] - c[0], e[1] - c[1]); const out: [number, number][] = []; for (let i = 0; i < 32; i++) out.push([c[0] + r * Math.cos(i * Math.PI / 16), c[1] + r * Math.sin(i * Math.PI / 16)]); return out; };
/** PCB_VIA_STITCH::SampleGuardEnvelope: points every pitch along each envelope outline, kept 0.7 pitch apart unless the guarded copper is between. */
export function sampleGuardEnvelope(env: Poly, guarded: Poly, pitchIU: number, valid: (p: V) => boolean): V[] {
  const acc: V[] = []; if (pitchIU <= 0) return acc;
  const minD = Math.trunc(pitchIU * 0.7); const minSq = minD * minD;
  const crossesGuarded = (a: V, b: V): boolean => {
    const A = { x: mm(a[0]), y: mm(a[1]) }, B = { x: mm(b[0]), y: mm(b[1]) };
    if (polyContains(guarded, A.x, A.y) || polyContains(guarded, B.x, B.y)) return true;
    for (const p of guarded) for (let i = 0; i < p.length; i++) { const c = p[i], d = p[(i + 1) % p.length]; if (segX(A, B, c, d)) return true; }
    return false;
  };
  const far = (p: V): boolean => { for (const q of acc) { const dx = q[0] - p[0], dy = q[1] - p[1]; if (dx * dx + dy * dy >= minSq) continue; if (crossesGuarded(p, q)) continue; return false; } return true; };
  for (const path of env) {
    if (areaOf(path) < 0) continue;   // an outline, not a hole
    const pts: V[] = path.map((q) => [iu(q.x), iu(q.y)] as V);
    let cursor = 0, next = pitchIU / 2;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) continue;
      while (next <= cursor + len) { const t = (next - cursor) / len; const p: V = [KR(a[0] + t * (b[0] - a[0])), KR(a[1] + t * (b[1] - a[1]))]; next += pitchIU; if (valid(p) && far(p)) acc.push(p); }
      cursor += len;
    }
  }
  return acc;
}
function segX(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }): boolean {
  const o = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(a, b, c), d2 = o(a, b, d), d3 = o(c, d, a), d4 = o(c, d, b);
  return ((d1 > 0) !== (d2 > 0) || d1 === 0 || d2 === 0) && ((d3 > 0) !== (d4 > 0) || d3 === 0 || d4 === 0) && Math.min(a.x, b.x) <= Math.max(c.x, d.x) + 1e-12 && Math.min(c.x, d.x) <= Math.max(a.x, b.x) + 1e-12 && Math.min(a.y, b.y) <= Math.max(c.y, d.y) + 1e-12 && Math.min(c.y, d.y) <= Math.max(a.y, b.y) + 1e-12;
}

// ---------------------------------------------------------------- Update
interface GridConfig { layout: number; mode: number; pitch: number }
/**
 * PCB_VIA_STITCH::Update for a stitch node (new or edited) against the board: the generator's change and its vias'
 * (kept, moved, removed, added).  `prev` is the grid the stitch's vias were made on (m_childGridConfig).
 */
export function viaStitchUpdate(doc: BoardDoc, st: Stitch, o: StitchOpts = {}, prev?: GridConfig | null, isNew = false): { changes: PcbChange[]; stitch: Stitch; changedVias: boolean } {
  const changes: PcbChange[] = []; initializeDefaults(st, { viaSize: o.curViaSize, viaDrill: o.curViaDrill });
  const pitch = st.pitch;
  const vias = st.members.map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && it.kind === "via");
  const viaPos = (it: KItem): V => { const a = K.kid(it.node, "at"); return a ? [iu(K.num(a[1])), iu(K.num(a[2]))] : [0, 0]; };
  const cur: GridConfig = { layout: st.layout, mode: st.mode, pitch };
  if (usesGridCells(st) && prev && prev.layout === cur.layout && prev.mode === cur.mode && prev.pitch === cur.pitch) {
    for (const v of vias) {
      const p = viaPos(v); const ex = positionForCell(st, cellForPosition(st, p), pitch);
      if (ex[0] !== p[0] || ex[1] !== p[1]) {
        const offY = ((p[1] % pitch) + pitch) % pitch; const row = (p[1] - offY) / pitch; const xs = st.layout === 1 && odd(row) ? Math.trunc(pitch / 2) : 0;
        st.offset = [(((p[0] - xs) % pitch) + pitch) % pitch, offY]; break;
      }
    }
  }
  let changed = false; const removed = new Set<string>();
  const removeVia = (it: KItem): void => { changes.push(removedChange(it)); removed.add(it.id); changed = true; };
  if (!st.outline.length) { for (const v of vias) removeVia(v); }
  else {
    const cells = buildPlacementCells(doc, st, o);
    const guardR = Math.trunc(pitch / 4); const guardSq = guardR * guardR;
    const excluded = (c: V): boolean => {
      if (st.mode === 1) return st.exPos.some((e) => (e[0] - c[0]) ** 2 + (e[1] - c[1]) ** 2 < guardSq);
      return usesGridCells(st) ? st.exCells.some((e) => e[0] === c[0] && e[1] === c[1]) : st.exPos.some((e) => e[0] === c[0] && e[1] === c[1]);
    };
    const desired = new Map<string, { cell: V; pos: V }>();
    for (const c of cells) if (!excluded(c)) desired.set(c.join(), { cell: c, pos: positionForCell(st, c, pitch) });
    const kept = new Map<string, KItem>();
    for (const v of vias) { const k = cellForPosition(st, viaPos(v)).join(); if (desired.has(k) && !kept.has(k)) { kept.set(k, v); continue; } removeVia(v); }
    const net = st.netName ? netRefOf(doc, st.netName) : null;
    const refNode = (pos: V): SNode => {
      const n = K.cloneNode(st.via); setKid(n, "at", ["at", mm(pos[0]), mm(pos[1])]);
      const ni = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "net"); if (ni > 0) n.splice(ni, 1);
      const ui = n.findIndex((c, j) => j > 0 && Array.isArray(c) && c[0] === "uuid"); if (ui > 0) n.splice(ui, 1);
      if (!K.kid(n, "free")) n.push(["free", "yes"]);
      if (net) n.push(K.parse(net) as SNode);
      return n;
    };
    const sig = (n: SNode, withPos: boolean): string => { const c = K.cloneNode(n); for (const k of withPos ? ["uuid", "tstamp"] : ["uuid", "tstamp", "at"]) { const i = c.findIndex((x, j) => j > 0 && Array.isArray(x) && x[0] === k); if (i > 0) c.splice(i, 1); } return K.serialize(c); };
    for (const { cell, pos } of [...desired.values()].sort((a, b) => cmpV(a.cell, b.cell))) {
      const v = kept.get(cell.join()); const ref = refNode(pos);
      if (v) {
        if (sig(v.node, true) === sig(ref, true)) continue;
        if (sig(v.node, false) === sig(ref, false)) {
          const n = K.cloneNode(v.node); setKid(n, "at", ["at", mm(pos[0]), mm(pos[1])]); changes.push(upsertChange({ id: v.id, kind: "via", node: n }, "MODIFIED")); changed = true; continue;
        }
        removeVia(v);
      }
      const nv = K.cloneNode(ref); const id = K.newUuid(); nv.push(["uuid", id]);
      changes.push(upsertChange({ id, kind: "via", node: nv }, "ADDED")); st.members.push(id); changed = true;
    }
  }
  st.members = st.members.filter((id) => !removed.has(id));
  const gen = writeStitch(st);
  changes.unshift(upsertChange({ id: st.uuid, kind: "generated", node: gen }, isNew ? "ADDED" : "MODIFIED"));
  return { changes, stitch: st, changedVias: changed };
}
function netRefOf(doc: BoardDoc, name: string): string {
  if (netStyle(doc) === "name") return `(net ${JSON.stringify(name)})`;
  for (const it of doc.items.values()) {
    const nodes = it.kind === "footprint" ? K.kids(it.node, "pad") : [it.node];
    for (const n of nodes) { const r = netOf(n); if (r.code > 0 && r.name === name) return `(net ${r.code})`; }
    if (it.kind === "zone") { const nn = K.kid(it.node, "net_name"), r = netOf(it.node); if (nn && K.str(nn[1]) === name && r.code > 0) return `(net ${r.code})`; }
  }
  return `(net 0)`;
}
/** The grid the stitch's vias stand on now (SetProperties' m_childGridConfig). */
export const gridConfigOf = (st: Stitch): GridConfig => ({ layout: st.layout, mode: st.mode, pitch: st.pitch });
/** PCB_VIA_STITCH::GetZonesNeedingRefillAfterUpdate: other nets' zones over the stitch, when its vias changed. */
export function zonesNeedingRefill(doc: BoardDoc, st: Stitch): string[] {
  const b = bboxIU(st.outline); const out: string[] = [];
  for (const it of doc.items.values()) { if (it.kind !== "zone" || isRuleArea(it.node) || zoneNet(it.node) === st.netName) continue; const zb = itemBoxIU(it); if (zb && boxesHit(zb, b)) out.push(it.id); }
  return out;
}
/** PCB_VIA_STITCH::OnZoneFillChanged: the stitches over a refilled zone of their net. */
export function stitchesDirtiedByFill(doc: BoardDoc, zoneIds: string[]): string[] {
  const zones = zoneIds.map((id) => doc.items.get(id)).filter((z): z is KItem => !!z && z.kind === "zone");
  const out: string[] = [];
  for (const it of doc.items.values()) {
    if (!isViaStitch(it)) continue; const st = readStitch(it.node); if (!st.netName) continue; const b = bboxIU(st.outline);
    if (zones.some((z) => zoneNet(z.node) === st.netName && !!itemBoxIU(z) && boxesHit(itemBoxIU(z)!, b))) out.push(it.id);
  }
  return out;
}
/** The stitch a via belongs to, if any. */
export function stitchOfVia(doc: BoardDoc, viaId: string): KItem | null {
  for (const it of doc.items.values()) if (isViaStitch(it) && K.groupMemberIds(it.node).includes(viaId)) return it;
  return null;
}
/** EDIT_TOOL::DeleteItems for a stitch's via (the stitch staying): ExcludePosition and the stitch modified. */
export function excludeViaChanges(doc: BoardDoc, viaIds: string[]): PcbChange[] {
  const byGen = new Map<string, { gen: KItem; st: Stitch }>();
  for (const id of viaIds) {
    const via = doc.items.get(id); const gen = via && stitchOfVia(doc, id); if (!via || !gen) continue;
    let e = byGen.get(gen.id); if (!e) byGen.set(gen.id, e = { gen, st: readStitch(gen.node) });
    const a = K.kid(via.node, "at"); excludePosition(e.st, [iu(K.num(a && a[1])), iu(K.num(a && a[2]))]);
    e.st.members = e.st.members.filter((m) => m !== id);
  }
  return [...byGen.values()].map((e) => upsertChange({ id: e.gen.id, kind: "generated", node: writeStitch(e.st) }, "MODIFIED"));
}

// ---------------------------------------------------------------- DRC_TEST_PROVIDER_VIA_STITCH
/** via_stitch_overlap: two stitches of one net whose outlines overlap. */
export function viaStitchOverlapMarkers(doc: BoardDoc, limit = Infinity): DrcMarker[] {
  const out: DrcMarker[] = []; const st = [...doc.items.values()].filter(isViaStitch).map((it) => ({ it, s: readStitch(it.node) })).filter((x) => x.s.outline.length >= 3);
  for (let i = 0; i < st.length; i++) for (let j = i + 1; j < st.length; j++) {
    if (out.length >= limit) return out;
    const a = st[i], b = st[j]; if (!a.s.netName || a.s.netName !== b.s.netName) continue;
    const ov = intersect([toPath(a.s.outline)], [toPath(b.s.outline)]); if (!ov.length) continue;
    const bb = polyBox(ov);
    out.push(marker("via_stitch_overlap", "error", mm((bb[0] + bb[2]) / 2), mm((bb[1] + bb[3]) / 2), "Via-stitching zones overlap for same net", [a.it.id, b.it.id]));
  }
  return out;
}
