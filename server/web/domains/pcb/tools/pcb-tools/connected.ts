// pcb-tools/connected.ts — connectivity: conductor ends, point keys and the connected run (U).
import type { BoardDoc, Pt } from "./types";
import { layerOf, pt, widthOf } from "./util";
import { nearestOnSeg, viaLayers } from "./distances";
import { netOf } from "./nets";
import { K } from "./state";

// ---------------------------------------------------------------- connectivity (U)
export function conductorEnds(it: KItem) {
  if (it.kind === "segment" || it.kind === "arc") return [pt(it.node, "start"), pt(it.node, "end")].filter(Boolean) as Pt[];
  if (it.kind === "via") { const a = pt(it.node, "at"); return a ? [a] : []; }
  return [];
}
export const ptKey = (p: Pt) => Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000);
/** The copper of a track, arc or via as connectivity hit-tests it: does `p` lie on it (within half its width / its pad)? */
function onCopper(it: KItem, p: Pt): boolean {
  const n = it.node;
  if (it.kind === "via") { const at = pt(n, "at"), sz = K.kid(n, "size"); return !!at && Math.hypot(p[0] - at[0], p[1] - at[1]) <= (sz ? K.num(sz[1], 0.8) : 0.8) / 2 + 1e-6; }
  const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) return false; const hw = widthOf(n, 0.25) / 2 + 1e-6;
  const m = it.kind === "arc" ? pt(n, "mid") : null;
  const arc = m ? K.arcFrom3(a, m, b) as { x: number; y: number; r: number; a0: number; a1: number; anticlockwise?: boolean } | null : null;
  if (arc) {
    const T = 2 * Math.PI, norm = (t: number) => ((t % T) + T) % T, t = Math.atan2(p[1] - arc.y, p[0] - arc.x);
    const inSweep = arc.anticlockwise ? norm(arc.a0 - t) <= norm(arc.a0 - arc.a1) : norm(t - arc.a0) <= norm(arc.a1 - arc.a0);
    if (inSweep) return Math.abs(Math.hypot(p[0] - arc.x, p[1] - arc.y) - arc.r) <= hw;
    return Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - b[0], p[1] - b[1])) <= hw;
  }
  const q = nearestOnSeg(p, a, b); return Math.hypot(p[0] - q[0], p[1] - q[1]) <= hw;
}
/**
 * Ids of every track / arc / via reachable from the seeds through the connectivity (CN_CONNECTIVITY_ALGO's
 * ItemsTouchOnLayer): two items join when an anchor of one (a track's ends, a via's centre) lies on the other's copper
 * on a layer both are on — a track ending on another's body (a T) or anywhere inside a via's pad is followed.  Vias
 * are on every copper layer they span; items on different nets are not joined.
 */
export function connectedRun(doc: BoardDoc, seedIds: Iterable<string>) {
  const copper = doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const items: { it: KItem; ends: Pt[]; layers: Set<string>; net: string; box: [number, number, number, number] }[] = [], byId = new Map<string, number>();
  for (const it of doc.items.values()) {
    const e = conductorEnds(it); if (!e.length) continue;
    const layers = it.kind === "via" ? viaLayers(it.node, copper) : new Set([layerOf(it.node)]);
    const sz = it.kind === "via" ? K.kid(it.node, "size") : null, r = it.kind === "via" ? (sz ? K.num(sz[1], 0.8) : 0.8) / 2 : widthOf(it.node, 0.25) / 2;
    const P = it.kind === "arc" && pt(it.node, "mid") ? e.concat([pt(it.node, "mid")!]) : e;
    const box: [number, number, number, number] = it.bbox && it.kind === "arc" ? [it.bbox[0] - r, it.bbox[1] - r, it.bbox[2] + r, it.bbox[3] + r]
      : [Math.min(...P.map((q) => q[0])) - r, Math.min(...P.map((q) => q[1])) - r, Math.max(...P.map((q) => q[0])) + r, Math.max(...P.map((q) => q[1])) + r];
    byId.set(it.id, items.length); items.push({ it, ends: e, layers, net: ((r) => r.name || String(r.code))(netOf(it.node)), box });
  }
  const touch = (A: typeof items[number], B: typeof items[number]) => {
    if (A.net !== B.net) return false;
    let shared = false; for (const l of A.layers) if (B.layers.has(l)) { shared = true; break; } if (!shared) return false;
    if (A.box[0] > B.box[2] + 1e-6 || B.box[0] > A.box[2] + 1e-6 || A.box[1] > B.box[3] + 1e-6 || B.box[1] > A.box[3] + 1e-6) return false;
    return A.ends.some((p) => onCopper(B.it, p)) || B.ends.some((p) => onCopper(A.it, p));
  };
  const out = new Set<string>(), q: number[] = [];
  for (const id of seedIds) { const i = byId.get(id); if (i !== undefined && !out.has(id)) { out.add(id); q.push(i); } }
  while (q.length) {
    const A = items[q.pop()!];
    for (let j = 0; j < items.length; j++) { const B = items[j]; if (out.has(B.it.id) || !touch(A, B)) continue; out.add(B.it.id); q.push(j); }
  }
  return out;
}
