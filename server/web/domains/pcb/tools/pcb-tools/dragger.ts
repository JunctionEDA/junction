// pcb-tools/dragger.ts — PNS DRAGGER: the track drag (D, G, a left-drag on a selected track).
import type { BoardDoc, DragSolution, DragSub, Joints, LineArcs, Obstacle, PcbCtx, Pt, TrackElem, TrackLine } from "./types";
import { ptKey } from "./connected";
import { settingsOf } from "./dialogs";
import { padCopperLayers, viaLayers } from "./distances";
import { viaNow } from "./edit-commands";
import { isLocked } from "./groups";
import { netTable } from "./netlist";
import { netOf } from "./nets";
import { padsOf } from "./route-geom";
import { K, S } from "./state";
import { layerOf, pt, r6, samePt, widthOf } from "./util";
import { DIRS8, ST_DONE, WP_SHORTEST, dir8, dirAngle, fromNm, isDiagDir, pathClear, pathHits, ptsLength, routeObstacles, simplifyPts, toNm, walkaroundRoute } from "./walkaround";

// ---------------------------------------------------------------- PNS DRAGGER: track drag (D, G, a left-drag on a selected track)
// KiCad's interactive drag runs the router: the grabbed segment's whole LINE (the chain of same-net, same-width segments
// between two non-trivial joints - a pad, a via, a T, a width change) is rebuilt by LINE::dragSegment45 (the neighbours
// keep their direction, new 45° knees grow where needed, the ends never leave their pad or via) or LINE::dragCorner45
// (a vertex follows the cursor with straight + 45° legs).  Drag Free Angle (G) moves the nearer vertex at any angle.  A
// via takes the lines that end on it along (DM_VIA).  Every step is checked against other nets' copper at the design
// rules' clearance (walk around, KiCad's default mode); a step that cannot be made keeps the last valid one.
export const PEPS = 5e-7;   // half a nanometre: points this close are one (KiCad works in whole nm)
export const peq = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < PEPS && Math.abs(a[1] - b[1]) < PEPS;
export const rp = (p: Pt): Pt => [r6(p[0]) + 0, r6(p[1]) + 0];
export const d45Right = (d: number) => (d < 0 ? -1 : (d + 1) % 8), d45Left = (d: number) => (d < 0 ? -1 : (d + 7) % 8);
/** SEG::IntersectLines: where the infinite lines through a1-a2 and b1-b2 cross (null when parallel). */
export function lineX(a1: Pt, a2: Pt, b1: Pt, b2: Pt) {
  const ex = a2[0] - a1[0], ey = a2[1] - a1[1], fx = b2[0] - b1[0], fy = b2[1] - b1[1]; const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * fy - (b1[1] - a1[1]) * fx) / den; return rp([a1[0] + t * ex, a1[1] + t * ey]);
}
/** SEG::Intersect: the crossing of two segments, ends included; parallel (and zero-length) segments never cross. */
export function segX(a1: Pt, a2: Pt, b1: Pt, b2: Pt) {
  const ex = a2[0] - a1[0], ey = a2[1] - a1[1], fx = b2[0] - b1[0], fy = b2[1] - b1[1]; const den = ex * fy - ey * fx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1[0] - a1[0]) * fy - (b1[1] - a1[1]) * fx) / den, u = ((b1[0] - a1[0]) * ey - (b1[1] - a1[1]) * ex) / den;
  const e = 1e-9; if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return rp([a1[0] + t * ex, a1[1] + t * ey]);
}
/** SEG::LineDistance: distance from p to the infinite line through a-b. */
export function lineDist(a: Pt, b: Pt, p: Pt) { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy); return L < 1e-12 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L; }
export const chainAppend = (out: Pt[], pts: Pt[]) => { for (const p of pts) if (!out.length || !peq(out[out.length - 1], p)) out.push(p.slice()); return out; };   // SHAPE_LINE_CHAIN::Append
export const chainLen = (pts: Pt[]) => ptsLength(pts);
/** SHAPE_LINE_CHAIN::Simplify on nm-rounded points. */
export const chainSimplify = (pts: Pt[]) => simplifyPts(pts.map(rp));
/**
 * DIRECTION_45::BuildInitialTrace (mitred 45°): from p0 to p1, a straight run and a diagonal; it starts diagonal when
 * the direction `d` is diagonal (or, for an undefined direction, when startDiag says so).
 */
export function initialTrace(p0: Pt, p1: Pt, d: number, startDiag?: boolean) {
  const diag = d >= 0 ? isDiagDir(d) : !!startDiag;
  const w = Math.abs(p1[0] - p0[0]), h = Math.abs(p1[1] - p0[1]), sw = Math.sign(p1[0] - p0[0]), sh = Math.sign(p1[1] - p0[1]);
  if (w < PEPS || h < PEPS || Math.abs(w - h) < PEPS) return chainAppend([], [p0, p1]);
  let mp0, mp1;
  if (w > h) { mp0 = [(w - h) * sw, 0]; mp1 = [h * sw, h * sh]; } else { mp0 = [0, sh * (h - w)]; mp1 = [sw * w, sh * w]; }
  const m = diag ? mp1 : mp0; return chainAppend([], [p0, rp([p0[0] + m[0], p0[1] + m[1]]), p1]);
}
/** dragCornerInternal: rebuild the end of a chain towards p, keeping as much of it as can carry on at 45°. */
export function dragCornerInternal(origin: Pt[], p: Pt) {
  if (origin.length === 1) return initialTrace(origin[0], p, -1, false);
  if (origin.length === 2) return initialTrace(origin[0], p, -1, isDiagDir(dir8(origin[1], origin[0])));
  let picked: Pt[] | null = null, i: number;
  for (i = origin.length - 2; i >= 0; i--) {
    const dStart = dir8(origin[i], origin[i + 1]), pStart = origin[i], dPrev = i > 0 ? dir8(origin[i - 1], origin[i]) : -1;
    const path = initialTrace(pStart, p, dStart); if (path.length < 2) continue;
    const d0 = dir8(path[0], path[1]);
    if (d0 === dStart) { picked = path; break; }
    if (dPrev >= 0 && dirAngle(d0, dPrev) === 1) { picked = path; break; }
  }
  if (picked) return chainAppend(origin.slice(0, i + 1).map((q: Pt) => q.slice()), picked);
  return initialTrace(origin[0], p, -1, isDiagDir(dir8(origin[origin.length - 2], origin[origin.length - 1])));
}
/** LINE::snapDraggedCorner: a dragged corner within the threshold of where two obtuse neighbours would meet goes there. */
export function snapDraggedCorner(pts: Pt[], p: Pt, idx: number, thresh: number) {
  if (!(thresh > 0)) return p;
  const segs = pts.length - 1, s0 = Math.max(idx - 2, 0), s1 = Math.min(idx + 2, segs - 1); let best = p, bd = Infinity;
  for (let i = s0; i <= s1; i++) for (let j = s0; j < i; j++) {
    if (dirAngle(dir8(pts[i], pts[i + 1]), dir8(pts[j], pts[j + 1])) !== 1) continue;
    const ip = lineX(pts[i], pts[i + 1], pts[j], pts[j + 1]); if (!ip) continue;
    const d = Math.hypot(ip[0] - p[0], ip[1] - p[1]); if (d < thresh && d < bd) { bd = d; best = ip; }
  }
  return best;
}
/** LINE::dragCorner45: vertex idx follows p; both legs are rebuilt with 45° corners (only one at the line's ends). */
export function dragCorner45(pts: Pt[], idx: number, p: Pt, thresh: number) {
  const snapped = snapDraggedCorner(pts, p, idx, thresh); const segs = pts.length - 1; let path: Pt[];
  if (idx === 0) path = dragCornerInternal(pts.slice().reverse(), snapped).reverse();
  else if (idx === segs) path = dragCornerInternal(pts, snapped);
  else path = chainAppend(dragCornerInternal(pts.slice(0, idx + 1), snapped), dragCornerInternal(pts.slice(idx).reverse(), snapped).reverse());
  return chainSimplify(path);
}
/** LINE::dragCornerFree (Drag Free Angle): the vertex goes exactly to p. */
export function dragCornerFree(pts: Pt[], idx: number, p: Pt) { const out = pts.map((q: Pt) => q.slice()); out[idx] = p.slice(); return chainSimplify(out); }
/** LINE::snapToNeighbourSegments: a dragged segment near a parallel segment two away snaps onto its line. */
export function snapToNeighbourSegments(pts: Pt[], p: Pt, idx: number, thresh: number) {
  if (!(thresh > 0)) return p;
  const segs = pts.length - 1, dragDir = dir8(pts[idx], pts[idx + 1]); let best = p, bd = Infinity;
  for (const k of [idx - 2, idx + 2]) {
    if (k < 0 || k > segs - 1 || (k > idx && idx >= segs - 2)) continue;
    const a = pts[k], b = pts[k + 1]; if (dir8(a, b) !== dragDir) continue;
    const d = lineDist(a, b, p); if (d < bd && d <= thresh) { bd = d; best = a.slice(); }
  }
  return best;
}
/**
 * LINE::dragSegment45: segment idx is moved through p keeping its direction; the segments before and after keep theirs
 * (or turn 45° where they ran straight on), a pad or via end stays where it is and a new 45° segment grows from it.
 * Of the guide-line intersections the shortest chain wins.
 */
export function dragSegment45(line: Pt[], aIndex: number, aP: Pt, thresh: number) {
  const path = line.map((q: Pt) => q.slice()); let index = aIndex; const segs0 = line.length - 1;
  const target = snapToNeighbourSegments(path, aP, aIndex, thresh);
  if (index === 0) { path.splice(0, 0, path[0].slice()); index++; }
  if (index === path.length - 2) path.splice(path.length - 1, 0, path[path.length - 1].slice());
  const seg = (i: number) => [path[i], path[i + 1]];
  let dragged = seg(index); const dragDir = dir8(dragged[0], dragged[1]);
  let sPrev = seg(index - 1), sNext = seg(index + 1); let dirPrev = dir8(sPrev[0], sPrev[1]), dirNext = dir8(sNext[0], sNext[1]);
  if (dirPrev === dragDir) { dirPrev = d45Left(dirPrev); path.splice(index, 0, path[index].slice()); index++; }
  else if (dirPrev < 0) dirPrev = d45Left(dragDir);
  if (dirNext === dragDir) { dirNext = d45Right(dirNext); path.splice(index + 1, 0, path[index + 1].slice()); }
  else if (dirNext < 0) dirNext = d45Right(dragDir);
  sPrev = seg(index - 1); sNext = seg(index + 1); dragged = seg(index);
  const guide = (p: Pt, d: number) => [p, [p[0] + DIRS8[d][0], p[1] + DIRS8[d][1]]];
  const wide = (d: number) => { const a = dirAngle(d, dragDir); return a === 1 || a === 4; };   // ANG_OBTUSE | ANG_HALF_FULL
  let gA: Pt[][], gB: Pt[][];
  if (aIndex === 0) gA = [guide(dragged[0], d45Right(dragDir)), guide(dragged[0], d45Left(dragDir))];
  else if (wide(dirPrev)) gA = [guide(sPrev[0], d45Left(dragDir)), guide(sPrev[0], d45Right(dragDir))];
  else gA = [guide(dragged[0], dirPrev), guide(dragged[0], dirPrev)];
  if (aIndex === segs0 - 1) gB = [guide(dragged[1], d45Right(dragDir)), guide(dragged[1], d45Left(dragDir))];
  else if (wide(dirNext)) gB = [guide(sNext[1], d45Left(dragDir)), guide(sNext[1], d45Right(dragDir))];
  else gB = [guide(dragged[1], dirNext), guide(dragged[1], dirNext)];
  const cur = guide(target, dragDir);
  let best: Pt[] | null = null, bestLen = Infinity;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const ip1 = lineX(cur[0], cur[1], gA[i][0], gA[i][1]), ip2 = lineX(cur[0], cur[1], gB[j][0], gB[j][1]); if (!ip1 || !ip2) continue;
    const s1 = [sPrev[0], ip1], s3 = [ip2, sNext[1]]; let np: Pt[], ip: Pt | null;
    if ((ip = segX(s1[0], s1[1], sNext[0], sNext[1]))) np = [s1[0], ip, sNext[1]];
    else if ((ip = segX(s3[0], s3[1], sPrev[0], sPrev[1]))) np = [sPrev[0], ip, s3[1]];
    else if ((ip = segX(s1[0], s1[1], s3[0], s3[1]))) np = [sPrev[0], ip, sNext[1]];
    else np = [sPrev[0], ip1, ip2, sNext[1]];
    np = chainAppend([], np); const L = chainLen(np); if (L < bestLen) { bestLen = L; best = np; }
  }
  if (!best) return chainSimplify(line);
  let out: Pt[];
  if (segs0 === 1 || aIndex === 0) out = best.concat(line.slice(2));
  else if (aIndex === segs0 - 1) out = line.slice(0, line.length - 2).concat(best);
  else out = line.slice(0, aIndex).concat(best, line.slice(aIndex + 2));
  return chainSimplify(out);
}

/** Track endpoints by layer and point, vias and pad centres by point: what NODE::FindJoint looks up. */
export function jointIndex(doc: BoardDoc): Joints {
  if (doc.__bc && doc.__bc.joints) return doc.__bc.joints;
  if (!doc.__bc && S.joints && S.joints.doc === doc && S.joints.ver === S.docVer) return S.joints;
  const NT = netTable(doc); const ends: Joints["ends"] = new Map(), vias: Joints["vias"] = new Map(), pads: Joints["pads"] = new Map(); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const add = <V>(m: Map<string, V[]>, k: string, v: V) => { let l = m.get(k); if (!l) m.set(k, l = []); l.push(v); };
  for (const it of doc.items.values()) {
    if (it.kind === "segment" || it.kind === "arc") { const a = pt(it.node, "start"), b = pt(it.node, "end"); if (!a || !b) continue; const L = layerOf(it.node); add(ends, L + "|" + ptKey(a), it); add(ends, L + "|" + ptKey(b), it); }
    else if (it.kind === "via") { const a = pt(it.node, "at"); if (a) add(vias, ptKey(a), { item: it, layers: viaLayers(it.node, copper), net: NT.key(netOf(it.node)) }); }
    else if (it.kind === "footprint") for (const p of padsOf(it)) add(pads, ptKey([p.x, p.y]), { item: it, pad: p, layers: padCopperLayers(p, copper) });
  }
  const J: Joints = { doc, ver: S.docVer, ends, vias, pads, NT };
  if (doc.__bc) doc.__bc.joints = J; else S.joints = J;
  return J;
}
export const trackEnds = (it: KItem) => [pt(it.node, "start"), pt(it.node, "end")] as Pt[];   // a track always has both
/**
 * NODE::AssembleLine: the segment and every segment reached through trivial joints (exactly two same-net segments of
 * one width meeting, no via, no pad centre, no arc, and the next segment not locked).  { ids, pts, index (the seed's segment index), width, layer, net, netKey }.
 */
export function assembleLine(doc: BoardDoc, seg: KItem): TrackLine | null {
  const J = jointIndex(doc); const L = layerOf(seg.node), w = widthOf(seg.node, 0.25), net = netOf(seg.node), key = J.NT.key(net);
  const [A, B] = trackEnds(seg); if (!A || !B) return null;
  const ids = [seg.id], pts = [A.slice(), B.slice()];
  const walk = (from: KItem, p: Pt, atEnd: boolean) => {
    let cur = from, q = p;
    for (let guard = 0; guard < 10000; guard++) {
      const k = ptKey(q);
      if ((J.vias.get(k) || []).some((v) => v.layers.has(L))) return;
      if ((J.pads.get(k) || []).some((x) => x.layers.has(L) && samePt([x.pad.x, x.pad.y], q))) return;
      const links = (J.ends.get(L + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === key);
      if (links.length !== 2) return;
      const o = links[0] === cur ? links[1] : links[0];
      if (o.kind !== "segment" || ids.includes(o.id) || Math.abs(widthOf(o.node, 0.25) - w) > 1e-9) return;
      if (isLocked(o.node)) return;   // JOINT::NextSegment( aAllowLockedSegs = false ): a locked segment ends the line
      const [a, b] = trackEnds(o); const nq = samePt(a, q) ? b : a;
      if (atEnd) { ids.push(o.id); pts.push(nq.slice()); } else { ids.unshift(o.id); pts.unshift(nq.slice()); }
      cur = o; q = nq;
    }
  };
  walk(seg, B, true); walk(seg, A, false);
  return { ids, pts, index: ids.indexOf(seg.id), width: w, layer: L, net, netKey: key };
}
/** findViaFanoutByHandle: every same-net line ending on the via, on any of its layers. */
export function viaFanout(doc: BoardDoc, via: KItem) {
  const J = jointIndex(doc); const at = pt(via.node, "at"); if (!at) return [];
  const key = J.NT.key(netOf(via.node)); const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]; const layers = viaLayers(via.node, copper);
  const out: TrackLine[] = [], seen = new Set<string>();
  for (const L of layers) for (const o of J.ends.get(L + "|" + ptKey(at)) || []) {
    if ((o.kind !== "segment" && o.kind !== "arc") || seen.has(o.id) || J.NT.key(netOf(o.node)) !== key) continue;
    if (o.kind === "arc") { const ln = arcStubLine(o, at, L, key); seen.add(o.id); if (ln) out.push(ln); continue; }
    const ln = assembleLine(doc, o); if (!ln) continue; ln.ids.forEach((id) => seen.add(id));
    if (peq(ln.pts[ln.pts.length - 1], at) && !peq(ln.pts[0], at)) { ln.pts.reverse(); ln.ids.reverse(); }
    ln.vertex = 0; out.push(ln);
  }
  return out;
}
/**
 * An arc ending on a dragged via (an ARC_T link of the via's joint): the arc keeps its shape and a new line grows from its
 * end to where the via goes, leaving at 45° or straight as the arc's tangent there does (dragCornerInternal on a line
 * whose last piece is the arc).  ids is empty — the arc itself is never replaced.
 */
export function arcStubLine(arc: KItem, at: Pt, layer: string, netKey: string): TrackLine | null {
  const a = pt(arc.node, "start"), m = pt(arc.node, "mid"), b = pt(arc.node, "end"); if (!a || !m || !b) return null;
  const e = samePt(a, at) ? a : b; const c = K.arcFrom3(a, m, b); let diag = false;
  if (c) { let t = [-(e[1] - c.y), e[0] - c.x]; if ((m[0] - e[0]) * t[0] + (m[1] - e[1]) * t[1] > 0) t = [-t[0], -t[1]]; diag = isDiagDir(dir8(e, [e[0] + t[0], e[1] + t[1]])); }
  return { ids: [], pts: [at.slice(), at.slice()], index: 0, vertex: 0, width: widthOf(arc.node, 0.25), layer, net: netOf(arc.node), netKey, arc, arcDiag: diag, tmpl: arc };
}
/** TOOL_BASE::snapToItem: a grab within half the width of a track end takes the end, otherwise the nearest (grid) point on it. */
export function snapGrab(ctx: PcbCtx, it: KItem, mm: Pt) {
  if (it.kind === "via") return pt(it.node, "at")!.slice();
  if (it.kind === "arc") { const a = pt(it.node, "start"), m = pt(it.node, "mid"), b = pt(it.node, "end"); if (a && m && b) return alignToArc(ctx, mm, a, m, b); }   // GRID_HELPER::AlignToArc
  const [a, b] = trackEnds(it); const w2 = widthOf(it.node, 0.25) / 2;
  const da = Math.hypot(mm[0] - a[0], mm[1] - a[1]), db = Math.hypot(mm[0] - b[0], mm[1] - b[1]);
  if (da < w2 || db < w2) return (da < db ? a : b).slice();
  const g = ctx.snapOn ? ctx.snap(mm.slice()) : mm;   // GRID_HELPER::AlignToSegment: the grid point, put back on the segment
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const k = l2 > 0 ? Math.max(0, Math.min(1, ((g[0] - a[0]) * dx + (g[1] - a[1]) * dy) / l2)) : 0;
  return rp([a[0] + k * dx, a[1] + k * dy]);
}
/**
 * DRAGGER::Start: the drag of one item grabbed at mm.  A segment gives DM_SEGMENT, or DM_CORNER when grabbed within half
 * its width of an end (Free Angle: always DM_CORNER, at the nearer vertex); a via gives DM_VIA.  null when it cannot drag.
 */
export function dragStart(ctx: PcbCtx, it: KItem, mm: Pt, free: boolean) {
  const doc = ctx.doc; if (!it || (it.kind !== "segment" && it.kind !== "via" && it.kind !== "arc")) return null;
  const p = snapGrab(ctx, it, mm); const d = { id: it.id, free: !!free, start: p.slice(), cursor: p.slice(), forceMark: false, first: true, status: true, sol: null, last: null, lastValid: p.slice(), obs: new Map() } as DragSub;   // mode, lines, netKey and ids follow
  if (it.kind === "arc") {
    const ln = startDragArc(ctx, it); if (!ln) return null;
    d.mode = "arc"; d.lines = [ln]; d.netKey = ln.netKey;
  } else if (it.kind === "via") {
    d.mode = "via"; d.via = it; d.viaAt = pt(it.node, "at")!.slice(); d.lines = viaFanout(doc, it); d.netKey = netTable(doc).key(netOf(it.node));
  } else {
    const ln = assembleLine(doc, it); if (!ln) return null;
    const a = ln.pts[ln.index], b = ln.pts[ln.index + 1], w2 = ln.width / 2;
    const da = Math.hypot(p[0] - a[0], p[1] - a[1]), db = Math.hypot(p[0] - b[0], p[1] - b[1]);
    d.mode = "segment"; ln.vertex = ln.index;
    if (da < w2 || db < w2) { d.mode = "corner"; if (db <= da) ln.vertex++; }
    else if (d.free) { if (db < da && ln.index < ln.pts.length - 2) ln.vertex++; d.mode = "corner"; }
    d.lines = [ln]; d.netKey = ln.netKey;
  }
  d.ids = new Set(); for (const l of d.lines) for (const id of l.ids) d.ids.add(id); if (d.via) d.ids.add(d.via.id);
  d.sol = dragSolution(d, d.start);   // the item as it is: what an Escape or a refused step shows
  return d;
}
/** One drag step's geometry: each line rebuilt for cursor p (no collision handling). */
export function dragSolution(d: DragSub, p: Pt): DragSolution {
  const thresh = (l: TrackLine) => (d.free || !S.rs.smooth_dragged_segments ? 0 : l.width / 4);   // SmoothDraggedSegments() ? Width() / 4 : 0
  const viaLine = (l: TrackLine) => l.arc ? (d.free ? chainSimplify([p.slice(), l.pts[1].slice()]) : chainSimplify(initialTrace(l.pts[1], p, -1, l.arcDiag).reverse()))
    : d.free ? dragCornerFree(l.pts, l.vertex!, p) : dragCorner45(l.pts, l.vertex!, p, 0);
  if (d.mode === "via") return { lines: d.lines.map((l) => ({ l, pts: viaLine(l) })), viaAt: p.slice() };
  const l = d.lines[0];
  if (d.mode === "arc") { const r = dragArcLine(l.pts, l.arcs!, l.index, p, l.width); return { lines: [{ l, pts: r.pts, arcs: r.arcs }] }; }   // LINE::DragArc
  const pts = d.mode === "segment" ? dragSegment45(l.pts, l.index, p, thresh(l)) : d.free ? dragCornerFree(l.pts, l.vertex!, p) : dragCorner45(l.pts, l.vertex!, p, thresh(l));
  return { lines: [{ l, pts }] };
}
export function dragObstacles(ctx: PcbCtx, d: DragSub, layer: string) {
  let O = d.obs.get(layer); if (O) return O;
  O = routeObstacles(ctx.doc, settingsOf(ctx), d.netKey, layer, d.netKey ? null : d.ids, d.excl); d.obs.set(layer, O); return O;
}
/** NODE::CheckColliding for a drag solution: every obstacle a dragged line or the dragged via violates. */
export function solutionHits(ctx: PcbCtx, d: DragSub, sol: DragSolution) {
  const out: Obstacle[] = [];
  for (const { l, pts } of sol.lines) for (const ob of pathHits(dragObstacles(ctx, d, l.layer), pts, l.width / 2)) if (!out.includes(ob)) out.push(ob);
  if (sol.viaAt) { const copper = ctx.doc.copper.length ? ctx.doc.copper : ["F.Cu", "B.Cu"]; const r = viaNow(d.via!.node).size / 2; for (const L of viaLayers(d.via!.node, copper)) for (const ob of pathHits(dragObstacles(ctx, d, L), [sol.viaAt], r)) if (!out.includes(ob)) out.push(ob); }
  return out;
}
/**
 * DRAGGER::dragWalkaround / tryWalkaround: a dragged line that collides is walked round what it meets by WALKAROUND
 * with the WP_SHORTEST policy (both ways round each cluster, the shorter clear walk), its length limited to 30 times
 * the dragged line's; null when the walk does not complete.
 */
export function walkSolution(ctx: PcbCtx, d: DragSub, sol: DragSolution): DragSolution | null {
  const lines: DragSolution["lines"] = [];
  for (const ln of sol.lines) {
    const { l, pts } = ln; const O = dragObstacles(ctx, d, l.layer), r = l.width / 2; if (pathClear(O, pts, r)) { lines.push(ln); continue; }
    if (pts.length < 2) return null;
    const wr = walkaroundRoute(O, pts.map(toNm), r, { policies: [WP_SHORTEST], iterLimit: S.rs.walkaround_iteration_limit || 40, lengthLimit: true, lengthFactor: 30.0, cornerMode: S.rs.corner_mode });
    if (wr.status[WP_SHORTEST] !== ST_DONE) return null;
    const w = wr.lines[WP_SHORTEST].map(fromNm); if (w.length < 2) return null;
    lines.push(Object.assign({}, ln, { pts: w }, ln.arcs ? { arcs: restoreArcTags(w, pts, ln.arcs) } : {}));
  }
  return Object.assign({}, sol, { lines });
}

// ---------------------------------------------------------------- lines with arcs (SHAPE_LINE_CHAIN's arc shapes)
// A LINE that holds arcs keeps them as SHAPE_ARC shapes over the points of their polyline approximation.  Here a line's
// `pts` carry every arc as its ConvertToPolyline points and `arcs.seg[i]` names the arc segment pts[i]..pts[i + 1]
// belongs to (-1 for a straight segment).  Slicing, reversing and appending keep the tags; a walk or a drag that
// rebuilds part of the line leaves the untouched head and tail with their arcs (restoreUntouchedArcs).
/** ADVANCED_CFG::m_MaxTangentAngleDeviation (degrees) and m_MaxTrackLengthToKeep (mm). */
export const MAX_TANGENT_ANGLE_DEVIATION = 1.0, MAX_TRACK_LENGTH_TO_KEEP = 0.0005;
/** ARC_HIGH_DEF (SHAPE_ARC::DefaultAccuracyForPCB), mm. */
const ARC_ACCURACY = 0.005;
/** The circle of an arc and the way it turns: centre, radius, start angle and signed central angle (radians). */
export function arcGeom(a: Pt, m: Pt, b: Pt) {
  const c = K.arcFrom3(a, m, b) as { x: number; y: number; r: number } | null; if (!c) return null;
  const sa = Math.atan2(a[1] - c.y, a[0] - c.x), ma = Math.atan2(m[1] - c.y, m[0] - c.x), ea = Math.atan2(b[1] - c.y, b[0] - c.x);
  const norm = (x: number) => { while (x <= -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
  // the sweep that passes through the mid point
  let ca = norm(ea - sa); const toMid = norm(ma - sa);
  if (ca > 0 ? (toMid < 0 || toMid > ca) : (toMid > 0 || toMid < ca)) ca = ca > 0 ? ca - 2 * Math.PI : ca + 2 * Math.PI;
  return { c: [c.x, c.y] as Pt, r: c.r, sa, ca };
}
/** SHAPE_ARC::ConvertToPolyline( ARC_HIGH_DEF ): start and end exact, the inner points half the error outside the arc. */
export function arcPolyline(a: Pt, m: Pt, b: Pt, width: number): Pt[] {
  const g = arcGeom(a, m, b); if (!g) return [a.slice(), b.slice()];
  const halfErr = Math.max(1e-6, ARC_ACCURACY / 2), ext = g.r + width / 2; const caDeg = Math.abs(g.ca) * 180 / Math.PI;
  const chordMidDist = (() => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy; if (!L2) return Math.hypot(m[0] - a[0], m[1] - a[1]); const t = Math.max(0, Math.min(1, ((m[0] - a[0]) * dx + (m[1] - a[1]) * dy) / L2)); return Math.hypot(m[0] - a[0] - t * dx, m[1] - a[1] - t * dy); })();
  let n: number, effErr: number;
  if (ext < halfErr || !g.ca || chordMidDist < halfErr) { n = 0; effErr = ext; }
  else {
    // GetArcToSegmentCount and CircleToEndSegmentDeltaRadius, in nm as KiCad rounds them
    const R = Math.max(1, Math.round(ext * 1e6)), E = Math.max(1, Math.round(ARC_ACCURACY * 1e6));
    let inc = 180 / Math.PI * Math.acos(1 - E / R) * 2; inc = Math.min(360 / 8, inc);
    n = Math.max(Math.round(caDeg / inc), 2);
    let seg360 = Math.trunc(n * 360 / caDeg); if (seg360 <= 2) seg360 = 3;
    effErr = Math.round(Math.abs(R * (1 - 1 / Math.cos(Math.PI / seg360)))) / 1e6;
  }
  const rr = g.r + effErr / 2; n *= 2; const out: Pt[] = [a.slice()];
  for (let i = 1; i < n; i += 2) { const ang = g.sa + g.ca * i / n; out.push(rp([g.c[0] + rr * Math.cos(ang), g.c[1] + rr * Math.sin(ang)])); }
  out.push(b.slice()); return out;
}
/** CalcArcMid: the point halfway round the circle about c from p to q (the shorter way, or the other one). */
export function calcArcMid(p: Pt, q: Pt, c: Pt, minArc = true): Pt {
  const sa = Math.atan2(p[1] - c[1], p[0] - c[0]), ea = Math.atan2(q[1] - c[1], q[0] - c[0]);
  let rot = sa - ea; while (rot <= -Math.PI) rot += 2 * Math.PI; while (rot > Math.PI) rot -= 2 * Math.PI; rot /= 2;
  if (!minArc) rot += Math.PI;
  // RotatePoint turns clockwise on screen for a positive angle (y down): x' = x cos + y sin, y' = -x sin + y cos
  const dx = p[0] - c[0], dy = p[1] - c[1], co = Math.cos(rot), si = Math.sin(rot);
  return rp([c[0] + dx * co + dy * si, c[1] - dx * si + dy * co]);
}
/** A line's arcs as elements: runs of segments of one arc become that arc (or the part of it they span), the rest segments. */
export function lineElems(pts: Pt[], arcs?: LineArcs | null): TrackElem[] {
  const out: TrackElem[] = [];
  for (let i = 0; i + 1 < pts.length;) {
    const k = arcs ? arcs.seg[i] : -1;
    if (k == null || k < 0) { if (!peq(pts[i], pts[i + 1])) out.push({ t: "seg", a: pts[i].slice(), b: pts[i + 1].slice() }); i++; continue; }
    let j = i; while (j + 1 < pts.length && arcs!.seg[j] === k) j++;
    const A = arcs!.list[k]; const p = pts[i], q = pts[j];
    if (peq(p, A.a) && peq(q, A.b)) out.push({ t: "arc", a: A.a.slice(), m: A.m.slice(), b: A.b.slice() });
    else if (peq(p, A.b) && peq(q, A.a)) out.push({ t: "arc", a: A.b.slice(), m: A.m.slice(), b: A.a.slice() });
    else if (!peq(p, q)) {
      // a part of the arc (SHAPE_LINE_CHAIN::Slice inside an arc): the same circle and turn between p and q
      const g = arcGeom(A.a, A.m, A.b);
      if (g) { const pa = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]); let sw = Math.atan2(q[1] - g.c[1], q[0] - g.c[0]) - pa; if (g.ca > 0) { while (sw < 0) sw += 2 * Math.PI; } else { while (sw > 0) sw -= 2 * Math.PI; } const ma = pa + sw / 2; out.push({ t: "arc", a: p.slice(), m: rp([g.c[0] + g.r * Math.cos(ma), g.c[1] + g.r * Math.sin(ma)]), b: q.slice() }); }
      else out.push({ t: "seg", a: p.slice(), b: q.slice() });
    }
    i = j;
  }
  return out;
}
/** The points and arc tags of a list of elements (SHAPE_LINE_CHAIN::Append of segments and arcs). */
export function elemsLine(els: TrackElem[], width: number): { pts: Pt[]; arcs: LineArcs; starts: number[] } {
  const pts: Pt[] = [], arcs: LineArcs = { seg: [], list: [] }, starts: number[] = [];
  const add = (p: Pt, tag: number) => { if (pts.length && peq(pts[pts.length - 1], p)) return; if (pts.length) arcs.seg.push(tag); pts.push(p.slice()); };
  for (const e of els) {
    starts.push(pts.length && peq(pts[pts.length - 1], e.a) ? pts.length - 1 : pts.length);
    if (e.t === "arc") { const k = arcs.list.length; arcs.list.push({ a: e.a.slice(), m: e.m.slice(), b: e.b.slice() }); const poly = arcPolyline(e.a, e.m, e.b, width); add(poly[0], -1); for (let i = 1; i < poly.length; i++) add(poly[i], k); }
    else { add(e.a, -1); add(e.b, -1); }
  }
  return { pts, arcs, starts };
}
/** The arc tags of a line rebuilt from `orig`: its untouched head and tail keep theirs (LINE::restoreUntouchedArcs), the rest is straight. */
export function restoreArcTags(pts: Pt[], orig: Pt[], arcs: LineArcs): LineArcs {
  let head = 0; while (head < orig.length && head < pts.length && peq(orig[head], pts[head])) head++;
  let tail = 0; while (tail < orig.length - head && tail < pts.length - head && peq(orig[orig.length - 1 - tail], pts[pts.length - 1 - tail])) tail++;
  const seg: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    if (i + 1 < head) seg.push(arcs.seg[i]);
    else if (i >= pts.length - tail) seg.push(arcs.seg[orig.length - (pts.length - i)]);
    else seg.push(-1);
  }
  return { seg, list: arcs.list };
}
/** A line's points and tags reversed (SHAPE_LINE_CHAIN::Reverse). */
export const reverseArcs = (a: LineArcs): LineArcs => ({ seg: a.seg.slice().reverse(), list: a.list.map((x) => ({ ...x, a: x.b, b: x.a })) });
/**
 * NODE::AssembleLine for a line that may hold arcs: the track and every segment or arc reached through trivial
 * joints (two same-net tracks of one width, no via, no pad centre, the next one not locked).  The arcs are given as
 * their polylines (`arcs`); `index` is the point where the seed starts, `ids` run along the line.
 */
export function assembleArcLine(doc: BoardDoc, seed: KItem): TrackLine | null {
  const J = jointIndex(doc); const L = layerOf(seed.node), w = widthOf(seed.node, 0.25), net = netOf(seed.node), key = J.NT.key(net);
  const [A, B] = trackEnds(seed); if (!A || !B) return null;
  const items: { it: KItem; rev: boolean }[] = [{ it: seed, rev: false }];
  const walk = (from: KItem, p: Pt, atEnd: boolean) => {
    let cur = from, q = p;
    for (let guard = 0; guard < 10000; guard++) {
      const k = ptKey(q);
      if ((J.vias.get(k) || []).some((v) => v.layers.has(L))) return;
      if ((J.pads.get(k) || []).some((x) => x.layers.has(L) && samePt([x.pad.x, x.pad.y], q))) return;
      const links = (J.ends.get(L + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === key);
      if (links.length !== 2) return;
      const o = links[0] === cur ? links[1] : links[0];
      if ((o.kind !== "segment" && o.kind !== "arc") || items.some((x) => x.it === o) || Math.abs(widthOf(o.node, 0.25) - w) > 1e-9 || isLocked(o.node)) return;
      const [a, b] = trackEnds(o); const nq = samePt(a, q) ? b : a;
      if (atEnd) items.push({ it: o, rev: !samePt(a, q) }); else items.unshift({ it: o, rev: samePt(a, q) });
      cur = o; q = nq;
    }
  };
  walk(seed, B, true); walk(seed, A, false);
  const els: TrackElem[] = []; let seedEl = 0;
  items.forEach(({ it, rev }) => {
    if (it === seed) seedEl = els.length;
    const [a, b] = trackEnds(it); const m = it.kind === "arc" ? pt(it.node, "mid") : null;
    els.push(m ? (rev ? { t: "arc", a: b, m, b: a } : { t: "arc", a, m, b }) : (rev ? { t: "seg", a: b, b: a } : { t: "seg", a, b }));
  });
  const { pts, arcs, starts } = elemsLine(els, w); const index = starts[seedEl] || 0;
  arcs.list.forEach((x, k) => { const it = items.filter(({ it }) => it.kind === "arc")[k]; if (it) { x.id = it.it.id; x.item = it.it; } });
  return { ids: items.map(({ it }) => it.id), pts, index, width: w, layer: L, net, netKey: key, arcs };
}
/** Whether a point on the arc's circle lies within its sweep. */
function onArcSweep(g: NonNullable<ReturnType<typeof arcGeom>>, p: Pt) {
  let d = Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - g.sa;
  if (g.ca > 0) { while (d < -1e-12) d += 2 * Math.PI; return d <= g.ca + 1e-12; }
  while (d > 1e-12) d -= 2 * Math.PI; return d >= g.ca - 1e-12;
}
/** PCB_GRID_HELPER::AlignToArc: the arc's ends by their distance to the cursor, and its crossings with the grid point's horizontal, vertical and diagonal lines by their distance to the grid point. */
export function alignToArc(ctx: PcbCtx, mm: Pt, a: Pt, m: Pt, b: Pt): Pt {
  const aligned = ctx.snapOn ? ctx.snap(mm.slice()) : mm.slice(); if (!ctx.snapOn) return aligned;
  const g = arcGeom(a, m, b); const pts: Pt[] = [];
  if (g) for (const u of [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]]) {
    const fx = aligned[0] - g.c[0], fy = aligned[1] - g.c[1]; const B = fx * u[0] + fy * u[1], C = fx * fx + fy * fy - g.r * g.r; const disc = B * B - C;
    if (disc < 0) continue; for (const t of [-B - Math.sqrt(disc), -B + Math.sqrt(disc)]) { const p = rp([aligned[0] + u[0] * t, aligned[1] + u[1] * t]); if (onArcSweep(g, p)) pts.push(p); }
  }
  let nearest = aligned, md = Infinity;
  for (const p of [a, b]) { const d = (p[0] - mm[0]) ** 2 + (p[1] - mm[1]) ** 2; if (d < md) { md = d; nearest = p.slice(); } }
  for (const p of pts) { const d = (p[0] - aligned[0]) ** 2 + (p[1] - aligned[1]) ** 2; if (d < md) { md = d; nearest = p; } }
  return nearest;
}
/** A line with arcs as SHAPE_LINE_CHAIN operations: Slice( i, j ) (points i..j, their tags kept). */
const sliceArcLine = (pts: Pt[], arcs: LineArcs, i: number, j: number) => ({ pts: pts.slice(i, j + 1).map((p) => p.slice()), seg: arcs.seg.slice(i, j) });
/** SHAPE_LINE_CHAIN::Append: a chain that does not start where this one ends is joined by a straight segment. */
function appendArcLine(out: { pts: Pt[]; seg: number[] }, add: { pts: Pt[]; seg: number[] }) {
  if (!add.pts.length) return;
  let k = 0; if (out.pts.length && peq(out.pts[out.pts.length - 1], add.pts[0])) k = 1; else if (out.pts.length) out.seg.push(-1);
  for (let i = k; i < add.pts.length; i++) { out.pts.push(add.pts[i].slice()); if (i > 0) out.seg.push(add.seg[i - 1]); }
}
/** SEG::LineProject: p projected onto the line through a and b. */
function lineProject(a: Pt, b: Pt, p: Pt): Pt { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; if (!l2) return a.slice(); const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; return [a[0] + t * dx, a[1] + t * dy]; }
const sideOf = (a: Pt, b: Pt, p: Pt) => { const d = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); return Math.abs(d) < 1e-12 ? 0 : d < 0 ? -1 : 1; };
const nearestOnSeg2 = (a: Pt, b: Pt, p: Pt): Pt => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return [a[0] + t * dx, a[1] + t * dy]; };
/**
 * CIRCLE::ConstructFromTanTanPt for two lines that cross: of the circles tangent to both lines and passing through p,
 * the fillet (the one whose touching point nearest the crossing gives p, i.e. the larger).  { c, r }; r is 0 when no
 * circle exists (p at the crossing or outside the angle).
 */
export function tanTanPt(A: Pt[], B: Pt[], p: Pt): { c: Pt; r: number } {
  const I = lineX(A[0], A[1], B[0], B[1]); if (!I) return { c: p.slice(), r: 0 };
  if (peq(p, I)) return { c: p.slice(), r: 0 };
  const far = (s: Pt[]) => (Math.hypot(s[0][0] - I[0], s[0][1] - I[1]) > Math.hypot(s[1][0] - I[0], s[1][1] - I[1]) ? s[0] : s[1]);
  const fa = far(A), fb = far(B); const la = Math.hypot(fa[0] - I[0], fa[1] - I[1]), lb = Math.hypot(fb[0] - I[0], fb[1] - I[1]); if (!la || !lb) return { c: p.slice(), r: 0 };
  const ua = [(fa[0] - I[0]) / la, (fa[1] - I[1]) / la], ub = [(fb[0] - I[0]) / lb, (fb[1] - I[1]) / lb];
  let bx = ua[0] + ub[0], by = ua[1] + ub[1]; const bl = Math.hypot(bx, by); if (bl < 1e-15) return { c: p.slice(), r: 0 }; bx /= bl; by /= bl;   // the bisector (CalcArcMid of the far points, the minor angle)
  const sinH = Math.abs(ua[0] * by - ua[1] * bx), cos2 = 1 - sinH * sinH; const dx = p[0] - I[0], dy = p[1] - I[1];
  const bd = bx * dx + by * dy, d2 = dx * dx + dy * dy; let disc = bd * bd - cos2 * d2;
  if (disc < 0) { if (disc > -1e-9 * Math.max(1, d2)) disc = 0; else return { c: p.slice(), r: 0 }; }
  const t = (bd + Math.sqrt(disc)) / cos2; if (!(t > 0)) return { c: p.slice(), r: 0 };
  return { c: [I[0] + bx * t, I[1] + by * t], r: t * sinH };
}
/**
 * LINE::DragArc: the arc at point `index` of the line follows the cursor as a new arc tangent to the same two lines —
 * the segments it joins when they carry on its tangents (within m_MaxTangentAngleDeviation), else the tangents at its
 * own ends, a new tangent stub growing from the old end.  The cursor is kept inside the triangle of the largest such
 * arc and outside that arc's circle.  An arc that shrinks to (almost) nothing collapses: the line runs straight
 * through.  The line is returned unchanged when there is no tangent-circle solution.
 */
export function dragArcLine(pts: Pt[], arcs: LineArcs, index: number, aP: Pt, width: number): { pts: Pt[]; arcs: LineArcs } {
  const same = { pts: pts.map((p) => p.slice()), arcs: { seg: arcs.seg.slice(), list: arcs.list } };
  if (index < 0 || index >= pts.length) return same;
  const arcIdx = index < arcs.seg.length ? arcs.seg[index] : -1; if (arcIdx < 0) return same;
  let first = -1, last = -1; for (let i = 0; i < arcs.seg.length; i++) if (arcs.seg[i] === arcIdx) { if (first < 0) first = i; last = i + 1; }
  if (first < 0) return same;
  const A = arcs.list[arcIdx]; const g = arcGeom(A.a, A.m, A.b); if (!g) return same;
  const P0 = A.a, P1 = A.b;   // the arc's own ends (GetP0 / GetP1)
  const tangentAt = (e: Pt): Pt[] => { const rx = e[0] - g.c[0], ry = e[1] - g.c[1]; return [[e[0] + ry, e[1] - rx], [e[0] - ry, e[1] + rx]]; };
  const collinear = (s: Pt[], t: Pt[], maxDeg: number) => { const ax = s[1][0] - s[0][0], ay = s[1][1] - s[0][1], cx = t[1][0] - t[0][0], cy = t[1][1] - t[0][1]; const ma = Math.hypot(ax, ay), mc = Math.hypot(cx, cy); if (ma <= 0 || mc <= 0) return false; const sn = Math.abs(ax * cy - ay * cx) / (ma * mc); return Math.asin(Math.min(1, Math.max(0, sn))) * 180 / Math.PI <= maxDeg; };
  const tanS = tangentAt(P0), tanE = tangentAt(P1);
  const useStart = first > 0 && collinear([pts[first - 1], pts[first]], tanS, MAX_TANGENT_ANGLE_DEVIATION);
  const useEnd = last < pts.length - 1 && collinear([pts[last], pts[last + 1]], tanE, MAX_TANGENT_ANGLE_DEVIATION);
  const own = lineX(tanS[0], tanS[1], tanE[0], tanE[1]);
  let sS: Pt[], sE: Pt[];
  if (useStart) sS = [pts[first - 1], pts[first]]; else { if (!own) return same; sS = [own, P0]; }
  if (useEnd) sE = [pts[last], pts[last + 1]]; else { if (!own) return same; sE = [own, P1]; }
  const I = lineX(sS[0], sS[1], sE[0], sE[1]); if (!I) return same;
  const fromI0: Pt[] = [I, P0], fromI1: Pt[] = [I, P1];
  const far = (p: Pt, q: Pt) => (Math.hypot(p[0] - I[0], p[1] - I[1]) > Math.hypot(q[0] - I[0], q[1] - I[1]) ? p : q);
  const sFar = far(sS[0], sS[1]), eFar = far(sE[0], sE[1]); const temp = far(sFar, eFar) === eFar ? sFar : eFar;
  const maxC = tanTanPt(fromI0, fromI1, temp);
  const mS = lineProject(fromI0[0], fromI0[1], maxC.c), mE = lineProject(fromI1[0], fromI1[1], maxC.c);
  const cTS: Pt[] = [mS, I], cTE: Pt[] = [mE, I], cCh: Pt[] = [mS, mE];
  const oldMid = A.m; let cursor = aP.slice();
  if (sideOf(cTS[0], cTS[1], oldMid) !== sideOf(cTS[0], cTS[1], cursor) || sideOf(cTE[0], cTE[1], oldMid) !== sideOf(cTE[0], cTE[1], cursor) || sideOf(cCh[0], cCh[1], oldMid) !== sideOf(cCh[0], cCh[1], cursor)) {
    let best = nearestOnSeg2(cTS[0], cTS[1], cursor);
    for (const c of [nearestOnSeg2(cTE[0], cTE[1], cursor), nearestOnSeg2(cCh[0], cCh[1], cursor)]) if ((c[0] - cursor[0]) ** 2 + (c[1] - cursor[1]) ** 2 < (best[0] - cursor[0]) ** 2 + (best[1] - cursor[1]) ** 2) best = c;
    cursor = best;
  }
  const dC = Math.hypot(cursor[0] - maxC.c[0], cursor[1] - maxC.c[1]);
  if (dC < maxC.r) { const ux = dC ? (cursor[0] - maxC.c[0]) / dC : 1, uy = dC ? (cursor[1] - maxC.c[1]) / dC : 0; cursor = [maxC.c[0] + ux * maxC.r, maxC.c[1] + uy * maxC.r]; }
  const c = tanTanPt(sS, sE, cursor); if (c.r <= 0) return same;
  let nS = rp(lineProject(sS[0], sS[1], c.c)), nE = rp(lineProject(sE[0], sE[1], c.c)); const center = c.c;
  let pre = useStart ? first - 1 : first, suf = useEnd ? last + 1 : last;
  const build = (withArc: boolean) => {
    const out = { pts: [] as Pt[], seg: [] as number[] }; const list = arcs.list.slice();
    if (pre >= 0) appendArcLine(out, sliceArcLine(pts, arcs, 0, pre));
    if (withArc) { const m = calcArcMid(nS, nE, center); const k = list.length; list.push({ a: nS, m, b: nE }); const poly = arcPolyline(nS, m, nE, width); appendArcLine(out, { pts: poly, seg: poly.slice(1).map(() => k) }); }
    if (suf <= pts.length - 1) appendArcLine(out, sliceArcLine(pts, arcs, suf, pts.length - 1));
    return { pts: out.pts, arcs: { seg: out.seg, list } };
  };
  if (Math.hypot(nE[0] - nS[0], nE[1] - nS[1]) <= MAX_TRACK_LENGTH_TO_KEEP) return build(false);
  if (first > 0) { const anchor = useStart ? pts[first - 1] : pts[first]; if (Math.hypot(anchor[0] - nS[0], anchor[1] - nS[1]) <= MAX_TRACK_LENGTH_TO_KEEP) { nS = anchor.slice(); pre = useStart ? first - 2 : first - 1; } }
  if (last < pts.length - 1) { const anchor = useEnd ? pts[last + 1] : pts[last]; if (Math.hypot(anchor[0] - nE[0], anchor[1] - nE[1]) <= MAX_TRACK_LENGTH_TO_KEEP) { nE = anchor.slice(); suf = useEnd ? last + 2 : last + 1; } }
  return build(true);
}
/**
 * DRAGGER::startDragArc: an arc of 180° less the tangent deviation or more cannot be dragged (the failure reason goes
 * to the infobar).  An arc at an end of its line gets a tiny tangent stub there (half m_MaxTrackLengthToKeep) so the
 * drag has a line to slide along; the dragged line is the arc's line (NODE::AssembleLine) with the stubs.
 */
export function startDragArc(ctx: PcbCtx, arc: KItem): TrackLine | null {
  const a = pt(arc.node, "start"), m = pt(arc.node, "mid"), b = pt(arc.node, "end"); if (!a || !m || !b) return null;
  const g = arcGeom(a, m, b); const central = g ? Math.abs(g.ca) * 180 / Math.PI : 0;
  if (central + MAX_TANGENT_ANGLE_DEVIATION >= 180) { ctx.toast("Unable to drag arc tracks of " + (180 - MAX_TANGENT_ANGLE_DEVIATION).toFixed(1) + " degrees or greater."); return null; }
  const probe = assembleArcLine(ctx.doc, arc); if (!probe || !probe.arcs || !g) return null;
  let arcIdx = -1, first = -1, lastPt = -1;
  for (let i = 0; i < probe.pts.length; i++) {
    const k = i < probe.arcs.seg.length ? probe.arcs.seg[i] : (i > 0 ? probe.arcs.seg[i - 1] : -1); if (k < 0) continue;   // ArcIndex( i ): the arc point i belongs to
    if (arcIdx < 0) arcIdx = k;
    if (k === arcIdx) { if (first < 0) first = i; lastPt = i; }
  }
  const isoStart = first === 0, isoEnd = lastPt === probe.pts.length - 1;
  if (!isoStart && !isoEnd) return probe;
  const stubLen = Math.max(1e-6, Math.round(MAX_TRACK_LENGTH_TO_KEEP * 1e6) / 2 / 1e6);
  const outward = (e: Pt): Pt => { const rx = e[0] - g.c[0], ry = e[1] - g.c[1]; let px = -ry, py = rx; if (px * (m[0] - e[0]) + py * (m[1] - e[1]) > 0) { px = ry; py = -rx; } const mag = Math.hypot(px, py); return mag <= 0 ? [stubLen, 0] : [px / mag * stubLen, py / mag * stubLen]; };
  const pts = probe.pts.map((p) => p.slice()), seg = probe.arcs.seg.slice(); let index = probe.index;
  // the stubs join the line where the arc's own ends are (pts[0] / pts[last] are the arc's ends then)
  if (isoStart) { const p0 = pts[0], o = outward(p0); pts.unshift(rp([p0[0] + o[0], p0[1] + o[1]])); seg.unshift(-1); index++; }
  if (isoEnd) { const p1 = pts[pts.length - 1], o = outward(p1); pts.push(rp([p1[0] + o[0], p1[1] + o[1]])); seg.push(-1); }
  return Object.assign({}, probe, { pts, index, arcs: { seg, list: probe.arcs.list } });
}
