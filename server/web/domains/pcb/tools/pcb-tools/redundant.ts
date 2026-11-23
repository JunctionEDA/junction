// pcb-tools/redundant.ts — Remove redundant tracks: removeLoops and removeAntennas.
import type { Antenna, BoardDoc, BranchCache, BranchOp, Pt, Route, TrackElem } from "./types";
import { branchDoc, opOn } from "./branch";
import { ptKey } from "./connected";
import { jointIndex, trackEnds } from "./dragger";
import { isLocked } from "./groups";
import { distSeg } from "./hit";
import { netOf } from "./nets";
import { K, S } from "./state";
import { clone, layerOf, r6, samePt, widthOf } from "./util";
import { dir8 } from "./walkaround";

export const dirOfElem = (e: TrackElem) => (e.t === "seg" ? dir8(e.a, e.b) : -1);
// ---- "Remove redundant tracks" (ROUTING_SETTINGS::RemoveLoops): PLACEMENT_ALGO::removeLoops and LINE_PLACER::removeAntennas
/** The copper meeting at one point of one layer, on one net: the tracks ending there and whether a pad or via anchors it (a JOINT). */
export function jointAt(doc: BoardDoc, layer: string, p: Pt, netKey: string) {
  const J = jointIndex(doc); const k = ptKey(p);
  const links = (J.ends.get(layer + "|" + k) || []).filter((o) => J.NT.key(netOf(o.node)) === netKey);
  const solid = (J.vias.get(k) || []).some((v) => v.layers.has(layer) && v.net === netKey) ||
    (J.pads.get(k) || []).some((x) => x.layers.has(layer) && samePt([x.pad.x, x.pad.y], p) && J.NT.key(x.pad.net) === netKey);
  return { links, solid, count: links.length + (solid ? 1 : 0) };
}
/** NODE::AssembleLine with arcs: the track and those reached through line corners (two tracks of one width, no pad or via, unlocked). */
export function assembleLoopLine(doc: BoardDoc, it: KItem) {
  const L = layerOf(it.node), w = widthOf(it.node, 0.25), key = jointIndex(doc).NT.key(netOf(it.node));
  const [A, B] = trackEnds(it); if (!A || !B) return null;
  const ids = [it.id], pts = [A.slice(), B.slice()];
  const corner = (j: ReturnType<typeof jointAt>) => !j.solid && j.links.length === 2 && j.links.every((o) => !isLocked(o.node)) && Math.abs(widthOf(j.links[0].node, 0.25) - widthOf(j.links[1].node, 0.25)) < 1e-9;
  const walk = (q: Pt, atEnd: boolean) => {
    let cur = it;
    for (let guard = 0; guard < 10000; guard++) {
      const j = jointAt(doc, L, q, key); if (!corner(j)) return;
      const o = j.links[0] === cur ? j.links[1] : j.links[0]; if (ids.includes(o.id)) return;
      const [a, b] = trackEnds(o); const nq = samePt(a, q) ? b : a;
      if (atEnd) { ids.push(o.id); pts.push(nq.slice()); } else { ids.unshift(o.id); pts.unshift(nq.slice()); }
      cur = o; q = nq;
    }
  };
  if (!isLocked(it.node)) { walk(B, true); walk(A, false); }
  return { ids, pts, layer: L, netKey: key, width: w };
}
/**
 * PLACEMENT_ALGO::removeLoops over the routed board: for each new track, the line through it and its two end joints;
 * every other line leaving the first joint that passes the second (clipped to the stretch between them) is erased
 * unless one of its tracks is locked.  Returns the ids to delete.
 */
export function loopRemovals(base: BoardDoc, b: BoardDoc) {
  const fresh = [...b.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && !base.items.has(it.id));
  const erase = new Set<string>(), freshIds = new Set(fresh.map((f) => f.id));
  for (const seg of fresh) {
    const our = assembleLoopLine(b, seg); if (!our) continue;
    let a = our.pts[0], z = our.pts[our.pts.length - 1];
    if (samePt(a, z)) continue;
    const ja = jointAt(b, our.layer, a, our.netKey);
    for (const o of ja.links) {
      if (our.ids.includes(o.id)) continue;
      const line = assembleLoopLine(b, o); if (!line || line.ids.includes(seg.id)) continue;
      let i0 = line.pts.findIndex((p) => samePt(p, a)), i1 = line.pts.findIndex((p) => samePt(p, z));
      if (i0 < 0 || i1 < 0) continue;
      if (i1 < i0) [i0, i1] = [i1, i0];
      const links = line.ids.slice(i0, i1);   // ClipVertexRange: the tracks between the two joints
      if (!links.length || links.some((id) => freshIds.has(id) || isLocked(b.items.get(id)!.node))) continue;
      for (const id of links) erase.add(id);
    }
  }
  return erase;
}
/** LINE_PLACER::removeAntennas: the dangling half of a track the route split at its start or end, once the route is anchored. */
export function antennaRemovals(base: BoardDoc, b: BoardDoc, ant: Antenna, netKey: string) {
  const halves = ant.ids.map((id: string) => b.items.get(id)).filter(Boolean); if (!halves.length) return [];
  const J = jointAt(b, ant.layer, ant.p, netKey);
  const isNew = (o: KItem) => !base.items.has(o.id), isTarget = (o: KItem) => ant.ids.includes(o.id);
  const newLinks = J.links.filter(isNew); if (!newLinks.length) return [];
  const reachesAnchor = (start: Pt, includeNew: boolean, skipTarget: boolean) => {
    const pending = [start], seen = new Set<string>();
    while (pending.length) {
      const q = pending.pop()!; const k = ptKey(q); if (samePt(q, ant.p) || seen.has(k)) continue; seen.add(k);
      const j = jointAt(b, ant.layer, q, netKey); if (j.solid) return true;
      for (const o of j.links) {
        if ((!includeNew && isNew(o)) || (skipTarget && isTarget(o))) continue;
        for (const e of trackEnds(o)) if (!samePt(e, q)) pending.push(e);
      }
    }
    return false;
  };
  let anchored = false;
  for (const o of newLinks) for (const e of trackEnds(o)) if (!samePt(e, ant.p) && reachesAnchor(e, true, true)) anchored = true;
  if (!anchored) return [];
  const candidates: string[][] = []; let hasAnchoredSide = false, sides = 0;
  for (const h of J.links.filter(isTarget)) {
    sides++;
    const [a0, a1] = trackEnds(h); const far = samePt(a0, ant.p) ? a1 : a0;
    if (reachesAnchor(far, false, false)) { hasAnchoredSide = true; continue; }
    let link = h, from = ant.p; const branch: string[] = [], seen = new Set<string>();
    while (link && !isLocked(link.node) && !seen.has(link.id)) {
      seen.add(link.id);
      const [e0, e1] = trackEnds(link); if (!samePt(e0, from) && !samePt(e1, from)) break;
      branch.push(link.id); const fe = samePt(e0, from) ? e1 : e0;
      const j = jointAt(b, ant.layer, fe, netKey);
      if (j.count === 1) { candidates.push(branch); break; }
      if (j.count !== 2 || j.solid) break;
      link = j.links[0] === link ? j.links[1] : j.links[0]; from = fe;
    }
  }
  return (sides === 2 && hasAnchoredSide) || sides === 1 ? candidates.flat() : [];
}
/** The routed board with the redundant tracks taken out (Remove redundant tracks on). */
export function removeRedundant(base: BoardDoc, b: BoardDoc, rt: Route) {
  if (!S.rs.remove_loops) return b;
  const out = Object.assign({}, b, { items: new Map(b.items), __bc: {} as BranchCache });
  for (const id of loopRemovals(base, out)) out.items.delete(id);
  out.__bc = {};
  for (const st of rt.stages) for (const ant of st.antennas || []) {
    const key = st.netKey; for (const id of antennaRemovals(base, out, ant, key)) out.items.delete(id); out.__bc = {};
  }
  return out;
}
/**
 * PLACEMENT_ALGO::simplifyNewLine, run on the route's node after each fix.  First the colinear leftovers on joints
 * that are not line corners: of two same-width tracks meeting there, one that lies wholly inside the other and whose
 * far end dangles is removed.  Then the line through the latest track is assembled (through its line corners, onto
 * existing board tracks too) and its colinear neighbours are merged (OPTIMIZER::MERGE_COLINEAR, Simplify): two clicks
 * along one straight run, or carrying an existing track straight on, leave one segment.  `base` is the board, `b` the
 * route's branch with the fix on it; the branch edits that simplify it are returned (none when nothing merges).
 */
export function simplifyNewLine(base: BoardDoc, b: BoardDoc, latestId: string): BranchOp[] {
  const ops: BranchOp[] = []; const latest0 = b.items.get(latestId); if (!latest0 || (latest0.kind !== "segment" && latest0.kind !== "arc")) return ops;
  const onSeg = (a: Pt, e: Pt, p: Pt) => distSeg(p[0], p[1], a[0], a[1], e[0], e[1]) <= 1e-6;
  const delOp = (it: KItem, grp?: object): BranchOp => (base.items.has(it.id) ? opOn(it, { del: it.id }, grp) : (grp ? { del: it.id, grp } : { del: it.id }));
  // --- colinear segments on non-line-corner joints
  const cleanup = new Set<string>();
  const lineCorner = (j: ReturnType<typeof jointAt>) => !j.solid && j.links.length === 2 && j.links.every((o) => !isLocked(o.node)) && Math.abs(widthOf(j.links[0].node, 0.25) - widthOf(j.links[1].node, 0.25)) < 1e-9;
  for (const it of b.items.values()) {
    if (it.kind !== "segment" || base.items.has(it.id) || cleanup.has(it.id)) continue;   // GetUpdatedItems: the added segments
    const L = layerOf(it.node), key = jointIndex(b).NT.key(netOf(it.node)), w = widthOf(it.node, 0.25); const [A, B] = trackEnds(it); if (!A || !B) continue;
    const far = (o: KItem, p: Pt) => { const [a, e] = trackEnds(o); return samePt(a, p) ? e : a; };
    const processJoint = (p: Pt): boolean => {
      const j = jointAt(b, L, p, key); if (lineCorner(j)) return false;
      for (const nb of j.links) {
        if (nb === it || nb.id === it.id || cleanup.has(nb.id) || Math.abs(widthOf(nb.node, 0.25) - w) > 1e-9) continue;
        const [na, ne] = trackEnds(nb); if (!na || !ne) continue;
        if (nb.kind === "segment" && onSeg(A, B, na) && onSeg(A, B, ne)) { if (jointAt(b, L, far(nb, p), key).count === 1) cleanup.add(nb.id); }
        else if (nb.kind === "segment" && onSeg(na, ne, A) && onSeg(na, ne, B)) { if (jointAt(b, L, far(it, p), key).count === 1) { cleanup.add(it.id); return true; } }
      }
      return false;
    };
    if (!processJoint(A)) processJoint(B);
  }
  let doc = b;
  if (cleanup.size) { for (const id of cleanup) ops.push(delOp(b.items.get(id)!)); doc = branchDoc(b, ops.map((o) => ({ del: o.del }))); }
  // --- AssembleLine( aLatest ) and MERGE_COLINEAR
  const latest = doc.items.get(latestId); if (!latest) return ops;
  const line = assembleLoopLine(doc, latest); if (!line || line.ids.length < 2) return ops;
  const colinear = (i: number) => {   // tracks i and i + 1 of the line: both straight, on one line and going the same way
    const x = doc.items.get(line.ids[i])!, y = doc.items.get(line.ids[i + 1])!; if (x.kind !== "segment" || y.kind !== "segment") return false;
    const a = line.pts[i], m = line.pts[i + 1], e = line.pts[i + 2]; const ux = m[0] - a[0], uy = m[1] - a[1], vx = e[0] - m[0], vy = e[1] - m[1];
    return Math.abs(ux * vy - uy * vx) <= 1e-9 * Math.max(1, Math.hypot(ux, uy) * Math.hypot(vx, vy)) && ux * vx + uy * vy > 0;
  };
  for (let i = 0; i + 1 < line.ids.length;) {
    let j = i; while (j + 1 < line.ids.length && colinear(j)) j++;
    if (j === i) { i++; continue; }
    const first = doc.items.get(line.ids[i])!, from = line.pts[i], to = line.pts[j + 1]; const grp = {};
    const node = clone(first.node); const sk = K.kid(node, "start")!, ek = K.kid(node, "end")!;
    if (samePt([K.num(sk[1]), K.num(sk[2])], from)) ek.splice(1, 2, r6(to[0]), r6(to[1])); else sk.splice(1, 2, r6(to[0]), r6(to[1]));
    ops.push(base.items.has(first.id) ? opOn(first, { set: first.id, node }, grp) : { set: first.id, node, grp });
    for (let k = i + 1; k <= j; k++) ops.push(delOp(doc.items.get(line.ids[k])!, grp));
    i = j + 1;
  }
  return ops;
}
