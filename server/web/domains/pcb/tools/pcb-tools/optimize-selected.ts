// pcb-tools/optimize-selected.ts — Optimize Selected Tracks (Shift+T, ROUTER_TOOL::OptimizeSelected, router_tool.cpp
// 2360-2440) and the OPTIMIZER passes it runs over each selected track's line (pns_optimizer.cpp):
//   MERGE_SEGMENTS (mergeFull)  | MERGE_OBTUSE (mergeObtuse) | MERGE_COLINEAR | SMART_PADS | FANOUT_CLEANUP.
// A line whose result collides, or that comes out the same, is left alone; a differential pair member is skipped with
// KiCad's infobar message; each optimized line is its own step, appended to the first one (APPEND_UNDO).
import type { BoardDoc, ObstacleIndex, PcbChange, PcbCtx, Pt, TrackLine } from "./types";
import { dragChanges } from "./drag-optimize";
import { assembleLine, initialTrace, peq } from "./dragger";
import { settingsOf } from "./dialogs";
import { dpNetPair } from "./diffpair";
import { applySelection, selectionIds } from "./groups";
import { ANG_OBTUSE, angleType, cornerCost, padOrViaAt, runSmartPads } from "./smartpads";
import { dir8, pathClear, routeObstacles, simplifyPts } from "./walkaround";

/** OPTIMIZER::mergeFull: each run of segments replaced by the cheaper clear 45° bypass while the corner cost drops. */
export function mergeFull(O: ObstacleIndex, pts: Pt[], r: number): Pt[] {
  let path = simplifyPts(pts); let step = path.length - 2;
  for (let guard = 0; guard < 400; guard++) {
    const nSegs = path.length - 1; if (step > nSegs - 2) step = nSegs - 2; if (step < 1) break;
    const costOrig = cornerCost(path); let picked: Pt[] | null = null;
    for (let n = 0; n < nSegs - step && !picked; n++) {
      const a = path[n], b = path[n + step + 1]; const cands: (Pt[] | null)[] = [null, null], cost = [Infinity, Infinity];
      for (let i = 0; i < 2; i++) {
        const bypass = initialTrace(a, b, -1, i === 1); if (bypass.length < 2 || !pathClear(O, bypass, r)) continue;
        cands[i] = simplifyPts(path.slice(0, n).concat(bypass, path.slice(n + step + 2))); cost[i] = cornerCost(cands[i]!);
      }
      if (cost[0] < costOrig && cost[0] < cost[1]) picked = cands[0]; else if (cost[1] < costOrig) picked = cands[1];
    }
    if (picked) path = picked; else step--;
    if (!step) break;
  }
  return simplifyPts(path);
}

/** SEG::IntersectLines: where the lines through two segments cross (null when parallel). */
function intersectLines(a0: Pt, a1: Pt, b0: Pt, b1: Pt): Pt | null {
  const r = [a1[0] - a0[0], a1[1] - a0[1]], s = [b1[0] - b0[0], b1[1] - b0[1]], den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b0[0] - a0[0]) * s[1] - (b0[1] - a0[1]) * s[0]) / den;
  return [Math.round((a0[0] + t * r[0]) * 1e6) / 1e6, Math.round((a0[1] + t * r[1]) * 1e6) / 1e6];
}
const obtuse = (a0: Pt, a1: Pt, b0: Pt, b1: Pt) => { const d1 = dir8(a0, a1), d2 = dir8(b0, b1); return d1 >= 0 && d2 >= 0 && (angleType(d1, d2) & ANG_OBTUSE) !== 0; };

/** OPTIMIZER::mergeObtuse: two segments `step` apart that meet at an obtuse angle replace what lies between them. */
export function mergeObtuse(O: ObstacleIndex, pts: Pt[], r: number): Pt[] {
  let path = pts.map((p) => p.slice()); let step = path.length - 3; if (step < 0) return path;
  for (let guard = 0; guard < 400; guard++) {
    const nSegs = path.length - 1; if (step > nSegs - 2) step = nSegs - 2;
    if (step < 2) return path;
    let found = false;
    for (let n = 0; n < nSegs - step; n++) {
      const s1a = path[n], s1b = path[n + 1], s2a = path[n + step], s2b = path[n + step + 1];
      if (!obtuse(s1a, s1b, s2a, s2b)) continue;
      const ip = intersectLines(s1a, s1b, s2a, s2b); if (!ip) continue;
      if (!obtuse(s1a, ip, ip, s2b) || !pathClear(O, [s1a, ip, s2b], r)) continue;
      path = path.slice(0, n + 1).concat([ip], path.slice(n + step + 1)); found = true; break;
    }
    if (!found) { if (step <= 2) return path; step--; }
  }
  return path;
}

/** OPTIMIZER::fanoutCleanup: a short line (under ten widths) between two pads / vias becomes one clean 45° trace. */
export function fanoutCleanup(doc: BoardDoc, O: ObstacleIndex, l: TrackLine, pts: Pt[]): Pt[] | null {
  if (pts.length < 3) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const sp = padOrViaAt(doc, l.layer, l.netKey, a), ep = padOrViaAt(doc, l.layer, l.netKey, b);
  if (!sp || !ep) return null;
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (len >= l.width * 10) return null;
  for (let i = 0; i < 2; i++) { const t = initialTrace(a, b, -1, i === 1); if (t.length >= 2 && pathClear(O, t, l.width / 2)) return t; }
  return null;
}

/** OPTIMIZER::Optimize with OptimizeSelected's effort: the line's new points, or null when nothing changed. */
export function optimizeTrackLine(ctx: PcbCtx, l: TrackLine): Pt[] | null {
  const O = routeObstacles(ctx.doc, settingsOf(ctx), l.netKey, l.layer, l.netKey ? null : new Set(l.ids), null), r = l.width / 2;
  let pts = mergeFull(O, l.pts, r);
  pts = mergeObtuse(O, pts, r);
  pts = simplifyPts(pts);   // mergeColinear
  const sp = runSmartPads(ctx.doc, pts, l.width, l.layer, l.netKey, (q) => pathClear(O, q, r)); if (sp) pts = sp;
  const fo = fanoutCleanup(ctx.doc, O, l, pts); if (fo) pts = fo;
  if (pts.length === l.pts.length && pts.every((p, i) => peq(p, l.pts[i]))) return null;   // CompareGeometry
  if (!pathClear(O, pts, r)) return null;   // CheckColliding
  return pts;
}

export const DP_OPTIMIZE_MSG = "Differential pair members cannot be optimized.";

/** ROUTER_TOOL::OptimizeSelected. */
export function optimizeSelected(ctx: PcbCtx): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const ids = [...selectionIds(ctx)];
  let tracks = ids.map((id) => doc.items.get(id)).filter((it): it is KItem => !!it && (it.kind === "segment" || it.kind === "arc"));
  if (!tracks.length) return false;
  applySelection(ctx, []);
  const before = tracks.length;
  tracks = tracks.filter((t) => { const l = assembleLine(doc, t); return !(l && l.net && dpNetPair(doc, l.net)); });
  if (tracks.length < before) ctx.toast(DP_OPTIMIZE_MSG);
  const done = new Set<string>(); let first = true;
  for (const t of tracks) {
    if (done.has(t.id) || !doc.items.has(t.id)) continue;
    const l = assembleLine(doc, t); if (!l) continue;
    for (const id of l.ids) done.add(id);
    if (l.ids.some((id) => doc.items.get(id)?.kind === "arc")) continue;   // arcs: left as they are (no arc-aware optimizer)
    const pts = optimizeTrackLine(ctx, l); if (!pts) continue;
    const changes: PcbChange[] = dragChanges(ctx, { sol: { lines: [{ l, pts }] } });
    if (!changes.length) continue;
    ctx.commit(changes, "Optimize Selected", first ? undefined : { amend: true }); first = false;
  }
  ctx.requestRender();
  return true;
}
