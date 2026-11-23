// pcb-tools/route-geom.ts — routing geometry: the posture leg, pads, the snap target and the net under a point.
import type { BoardDoc, CopperShape, NetRef, PadInfo, PcbGeom, Pt, SnapHit } from "./types";
import { padCopperLayers, padShape, shapeGap, viaLayers } from "./distances";
import { rp } from "./dragger";
import { distSeg, geomDist, hitTestItem } from "./hit";
import { hasNet, netOf, sameNet } from "./nets";
import { HIT_MM, K } from "./state";
import { layerOf, pt, rotator, widthOf } from "./util";

// ---------------------------------------------------------------- routing geometry
/** One KiCad-style leg from a to b: a 45° diagonal plus an orthogonal run, in either order. */
export function routeLeg(a: Pt, b: Pt, diagFirst: boolean) {
  const dx = b[0] - a[0], dy = b[1] - a[1]; const d = Math.min(Math.abs(dx), Math.abs(dy));
  const diag = [Math.sign(dx) * d, Math.sign(dy) * d], orth = [dx - diag[0], dy - diag[1]];
  const first = diagFirst ? diag : orth, second = diagFirst ? orth : diag;
  const c = [a[0] + first[0], a[1] + first[1]]; const out: Pt[][] = [];
  if (Math.hypot(first[0], first[1]) > 1e-6) out.push([a.slice(), c]);
  if (Math.hypot(second[0], second[1]) > 1e-6) out.push([c.slice(), b.slice()]);
  return out;
}

/** Absolute pad centres of a footprint item, with nets and copper layers. */
export function padsOf(fp: Pick<KItem, "node">) {
  const n = fp.node; const [fx, fy, frot] = K.atOf(n); const R = rotator(frot); const out: PadInfo[] = [];
  K.kids(n, "pad").forEach((pad, index) => {
    const [px, py, prot] = K.atOf(pad); const [rx, ry] = R(px, py); const sz = K.kid(pad, "size"); const ls = K.kid(pad, "layers");
    // the shape's offset from the anchor ((drill … (offset x y)), PAD::GetOffset), in the pad's own frame
    const dr = K.kid(pad, "drill"), of = dr && K.kid(dr, "offset"); const off = of ? [K.num(of[1], 0), K.num(of[2], 0)] : [0, 0];
    out.push({ x: fx + rx, y: fy + ry, rot: prot, w: sz ? K.num(sz[1]) : 1, h: sz ? K.num(sz[2], K.num(sz[1])) : 1, off,
      net: netOf(pad), layers: ls ? ls.slice(1).map(K.str) : [], number: K.str(pad[1]), type: K.str(pad[2]), shape: K.str(pad[3]), node: pad, index });
  });
  return out;
}
export const padOnLayer = (p: PadInfo, layer: string) => p.layers.some((l) => l === layer || l === "*.Cu" || l === "F&B.Cu");
export function padCovers(p: PadInfo, x: number, y: number) { const [lx, ly] = rotator(-p.rot)(x - p.x, y - p.y); return Math.abs(lx) <= p.w / 2 && Math.abs(ly) <= p.h / 2; }

/** Magnetic target near (x, y): a pad (centre within tol, or the cursor over it), via or track end on the layer (strict: of `net` only). */
export function snapTarget(doc: BoardDoc, x: number, y: number, tol: number, layer: string, net: NetRef | null, strict?: boolean) {
  let best: SnapHit | null = null, bd = Infinity;
  const take = (px: number, py: number, n: NetRef, kind: string, inside: boolean, extra: { fp?: string; padIndex?: number; id?: string }) => {
    const d = Math.hypot(px - x, py - y); if (!inside && d > tol) return;
    if (hasNet(net) && hasNet(n) && !sameNet(n, net)) return;   // never pull a routed net onto another net
    if (strict && !sameNet(n, net) && !(kind === "pad" && inside)) return;   // pickSingleItem: the routed net only; a free pad when the cursor is inside it
    if (d < bd) { bd = d; best = Object.assign({ x: px, y: py, net: n, kind, onLayer: layer }, extra); }
  };
  const mids: { it: KItem; a: Pt; b: Pt }[] = [];
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol)) continue;
    if (it.kind === "footprint") { padsOf(it).forEach((p, i) => { if (padOnLayer(p, layer)) take(p.x, p.y, p.net, "pad", padCovers(p, x, y), { fp: it.id, padIndex: p.index !== undefined ? p.index : i }); }); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) take(a[0], a[1], netOf(it.node), "via", false, { id: it.id }); }
    else if ((it.kind === "segment" || it.kind === "arc") && layerOf(it.node) === layer) {
      const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue;
      take(a[0], a[1], netOf(it.node), "track", false, { id: it.id }); take(b[0], b[1], netOf(it.node), "track", false, { id: it.id });
      if (strict && it.kind === "segment" && Math.hypot(a[0] - x, a[1] - y) > tol && Math.hypot(b[0] - x, b[1] - y) > tol) mids.push({ it, a, b });
    }
  }
  // while routing, the body of a routed-net track under the cursor is an end too (TOOL_BASE::snapToItem: the nearest
  // point on it); the route ends there and the track is split (LINE_PLACER::splitAdjacentSegments)
  if (!best) for (const { it, a, b } of mids) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (!(l2 > 0)) continue;
    const k = ((x - a[0]) * dx + (y - a[1]) * dy) / l2; if (k <= 0 || k >= 1) continue;
    const q = rp([a[0] + k * dx, a[1] + k * dy]); const inside = Math.hypot(q[0] - x, q[1] - y) <= widthOf(it.node, 0.25) / 2;
    take(q[0], q[1], netOf(it.node), "trackMid", inside, { id: it.id });
  }
  return best;
}
/** Net of whatever copper sits under (x, y): a pad, or a track/via on the layer. */
export function netUnder(doc: BoardDoc, x: number, y: number, layer?: string | null): NetRef {
  for (const it of doc.items.values()) if (it.kind === "footprint" && it.bbox && x >= it.bbox[0] && x <= it.bbox[2] && y >= it.bbox[1] && y <= it.bbox[3]) {
    for (const p of padsOf(it)) if ((!layer || padOnLayer(p, layer)) && padCovers(p, x, y)) return p.net;
  }
  const it = hitTestItem(doc, x, y, HIT_MM);
  if (it && (it.kind === "via" || ((it.kind === "segment" || it.kind === "arc") && (!layer || layerOf(it.node) === layer)))) return netOf(it.node);
  return { code: 0, name: "" };
}

// ---------------------------------------------------------------- TOOL_BASE::pickSingleItem / snapToItem (pns_tool_base.cpp)
/** A routable item the router's start / end pick found: a pad (SOLID), a via, or a track (SEGMENT / ARC). */
export interface PickedItem { kind: "pad" | "via" | "track"; net: NetRef; layers: string[]; id: string; fp?: string; padIndex?: number; at?: Pt; a?: Pt; b?: Pt; width?: number; arc?: boolean }
/** What the pick needs of the view: the top (active) layer, the copper stack, the layers that are shown, and whether net-less items count (Highlight collisions). */
export interface PickOpts { top: string; copper: string[]; shown?: ((layer: string) => boolean) | null; allowNetless?: boolean }
/**
 * TOOL_BASE::pickSingleItem: the routable items under the point (ROUTER::QueryHoverItems), and only when there are
 * none those within `slop` (the grid size).  Of the routed net (any net when `net` is none) the nearest via / pad on
 * the top layer wins, then the nearest track on the top layer, then a via / pad on any layer, then a track on any
 * layer; a pad of no net counts only with the cursor inside it; a net-less item on the top layer is the last resort
 * in Highlight collisions.  The winner must have copper on `layer` (null: any layer, a via is being placed).
 */
export function pickSingleItem(doc: BoardDoc, x: number, y: number, slop: number, layer: string | null, net: NetRef | null, o: PickOpts): PickedItem | null {
  const tl = layer || o.top; const want = hasNet(net); const shown = (ls: string[]) => !o.shown || ls.some((l) => o.shown!(l));
  const probe: CopperShape = { t: "circle", x, y, r: 0 };
  for (const radius of [0, slop]) {
    const pri: (PickedItem | null)[] = [null, null, null, null, null]; const dist = [Infinity, Infinity, Infinity, Infinity, Infinity];
    const consider = (c: PickedItem, inside: boolean) => {
      if (!shown(c.layers)) return;
      const onTop = c.layers.includes(tl);
      if (!want || sameNet(c.net, net)) {
        if (c.kind !== "track") { const d = Math.hypot(c.at![0] - x, c.at![1] - y); if (d < dist[2]) { pri[2] = c; dist[2] = d; } if (onTop && d < dist[0]) { pri[0] = c; dist[0] = d; } }
        else { const d = Math.min(Math.hypot(c.a![0] - x, c.a![1] - y), Math.hypot(c.b![0] - x, c.b![1] - y)); if (d < dist[3]) { pri[3] = c; dist[3] = d; } if (onTop && d < dist[1]) { pri[1] = c; dist[1] = d; } }
      } else if (c.kind === "pad" && !hasNet(c.net)) { if (inside) { pri[0] = c; dist[0] = 0; } }   // a free pad: only with the cursor inside it
      else if (!hasNet(c.net) && o.allowNetless) { if (onTop) pri[4] = c; }
    };
    for (const it of doc.items.values()) {
      const b = it.bbox; if (b && (x < b[0] - radius - 1e-6 || x > b[2] + radius + 1e-6 || y < b[1] - radius - 1e-6 || y > b[3] + radius + 1e-6)) continue;
      if (it.kind === "footprint") {
        padsOf(it).forEach((p, i) => {
          if (p.type === "np_thru_hole") return;   // not routable
          const ls = Array.from(padCopperLayers(p, o.copper)); if (!ls.length) return;
          const gap = shapeGap(padShape(p), probe); if (gap > radius + 1e-9) return;
          consider({ kind: "pad", net: p.net, layers: ls, id: it.id, fp: it.id, padIndex: p.index !== undefined ? p.index : i, at: [p.x, p.y] }, gap <= 1e-9);
        });
      } else if (it.kind === "via") {
        const a = pt(it.node, "at"); if (!a) continue; const sz = K.kid(it.node, "size"); const r = sz ? K.num(sz[1]) / 2 : 0.3;
        if (Math.hypot(a[0] - x, a[1] - y) - r > radius + 1e-9) continue;
        consider({ kind: "via", net: netOf(it.node), layers: Array.from(viaLayers(it.node, o.copper)), id: it.id, at: a }, false);
      } else if (it.kind === "segment" || it.kind === "arc") {
        const a = pt(it.node, "start"), e = pt(it.node, "end"); if (!a || !e) continue; const w = widthOf(it.node, 0.25);
        let d = Infinity;
        if (it.kind === "segment") d = distSeg(x, y, a[0], a[1], e[0], e[1]) - w / 2; else for (const g of it.geom as PcbGeom[]) d = Math.min(d, geomDist(g, x, y));
        if (d > radius + 1e-9) continue;
        consider({ kind: "track", net: netOf(it.node), layers: [layerOf(it.node)], id: it.id, a, b: e, width: w, arc: it.kind === "arc" }, false);
      }
    }
    if (pri.some((c) => c)) {
      for (const c of pri) if (c && (!layer || c.layers.includes(layer))) return c;
      return null;
    }
  }
  return null;
}
/**
 * TOOL_BASE::snapToItem: a pad's anchor, a via's position, a track's end when the point is within half its width of
 * it, otherwise PCB_GRID_HELPER::AlignToSegment — the track's ends by their distance to the cursor, and its crossings
 * with the horizontal, vertical and two diagonal lines through the grid-aligned point by their distance to that
 * point; the nearest wins.  `align` is the grid (the identity with Ctrl held).  The hit's
 * onLayer is ROUTER_TOOL::getStartLayer's: the top layer when the item has copper there, else its first layer.
 */
export function snapToItem(c: PickedItem, p: Pt, top: string, align: (q: Pt) => Pt): SnapHit {
  const onLayer = c.layers.includes(top) ? top : c.layers[0];
  if (c.kind === "pad") return { x: c.at![0], y: c.at![1], net: c.net, kind: "pad", fp: c.fp, padIndex: c.padIndex, layers: c.layers, onLayer };
  if (c.kind === "via") return { x: c.at![0], y: c.at![1], net: c.net, kind: "via", id: c.id, layers: c.layers, onLayer };
  const A = c.a!, B = c.b!, r = c.width! / 2; const dA = Math.hypot(p[0] - A[0], p[1] - A[1]), dB = Math.hypot(p[0] - B[0], p[1] - B[1]);
  if (dA < r || dB < r || c.arc) { const e = dA < dB ? A : B; return { x: e[0], y: e[1], net: c.net, kind: "track", id: c.id, onLayer }; }
  const n = align(p.slice()); const cands: Pt[] = [];
  const dx = B[0] - A[0], dy = B[1] - A[1];
  for (const [ux, uy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {   // aSeg.IntersectLines( testSegment ), kept when it lies on the track
    const den = dx * uy - dy * ux; if (Math.abs(den) < 1e-12) continue;
    const t = ((n[0] - A[0]) * uy - (n[1] - A[1]) * ux) / den; if (t < -1e-9 || t > 1 + 1e-9) continue;
    cands.push([A[0] + t * dx, A[1] + t * dy]);
  }
  let best: Pt = A, bd = dA, end = true; if (dB < bd) { best = B; bd = dB; }
  for (const q of cands) { const d = Math.hypot(q[0] - n[0], q[1] - n[1]); if (d < bd) { bd = d; best = q; end = false; } }
  const q = rp(best);
  return { x: q[0], y: q[1], net: c.net, kind: end || (Math.hypot(q[0] - A[0], q[1] - A[1]) < 1e-9 || Math.hypot(q[0] - B[0], q[1] - B[1]) < 1e-9) ? "track" : "trackMid", id: c.id, onLayer };
}
