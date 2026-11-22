// pcb-tools/box-select.ts — PCB_SELECTION_TOOL::CollectMultiple (pcbnew/tools/pcb_selection_tool.cpp): what a
// selection rectangle or lasso takes.  Each item answers with its own HitTest( box | polygon, contained ) — a track by
// its end points or centre line (PCB_TRACK), an arc by the box of its three points (PCB_ARC), a via by its pad, a
// footprint by its pads and drawings without its texts (FOOTPRINT::HitTest) — then the Selection Filter, the group
// rules and the footprint-children rule (FilterCollectorForHierarchy) apply, pads are kept only when nothing else was
// taken, and the result is sorted by position (rows, then columns).
import type { BoardDoc, Box, GeomPrim, Pt } from "./types";
import { groupBox, withinEnteredGroup } from "./group-edit";
import { expandGroups, groupMembers, topParentOf } from "./groups";
import { K, S } from "./state";
import { itemPassesFilter, padKey, type SelFilter } from "./select-connected";
import { fieldCandidateId } from "./guess";
import { pt } from "./util";

/** The selection area: a rectangle [x0, y0, x1, y1] or a closed polygon, taking what it contains or what it touches. */
export interface SelArea { box?: Box; poly?: Pt[]; contained: boolean }
export interface CollectOpts {
  /** Hidden layer keys (the Appearance panel). */
  hidden?: Set<string> | null;
  /** The Selection Filter pane. */
  filter?: SelFilter | null;
  /** PCB_SELECTION_TOOL::Selectable beyond layer visibility (a hidden object class). */
  selectable?: (it: KItem) => boolean;
}
/** SELECTION_AREA's auto mode for a lasso: a clockwise polygon (as seen on screen) takes what it contains. */
export function lassoContains(poly: Pt[], mirrored?: boolean): boolean {
  let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  const area = -a * 0.5; let cw = area > 0;
  if (mirrored && area !== 0) cw = !cw;
  return cw;
}
/** DragSelectionArea's direction rule: left to right takes what the box encloses; a mirrored view turns it round. */
export function boxContains(startX: number, endX: number, mirrored?: boolean): boolean {
  let greedy = endX < startX; if (mirrored) greedy = !greedy; return !greedy;
}

const inBox = (b: Box, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
const boxInBox = (outer: Box, b: Box) => b[0] >= outer[0] && b[2] <= outer[2] && b[1] >= outer[1] && b[3] <= outer[3];
const boxMeets = (a: Box, b: Box) => a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];
/** BOX2I::Intersects( start, end ): does the segment pass through (or lie inside) the rectangle?  Liang-Barsky. */
function segTouchesRect(a: Pt, b: Pt, r: Box): boolean {
  let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - r[0]], [dx, r[2] - a[0]], [-dy, a[1] - r[1]], [dy, r[3] - a[1]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
function pointInPoly(poly: Pt[], x: number, y: number) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; }
function segsCross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const on = (p: Pt, q: Pt, r: Pt) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, b, c)) || (o2 === 0 && on(a, b, d)) || (o3 === 0 && on(c, d, a)) || (o4 === 0 && on(c, d, b));
}
/** The outline of a geometry record as a polyline (its centre line; curves sampled), closed when it is a closed figure. */
function geomPath(g: GeomPrim): { pts: Pt[]; closed: boolean } | null {
  switch (g.t) {
  case "line": return { pts: [[g.x1, g.y1], [g.x2, g.y2]], closed: false };
  case "poly": return g.pts && g.pts.length ? { pts: g.pts, closed: !!(g.close || g.fill) } : null;
  case "circle": { const n = 32, pts: Pt[] = []; for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pts.push([g.x + g.r * Math.cos(a), g.y + g.r * Math.sin(a)]); } return { pts, closed: true }; }
  case "arc": {
    if (g.a0 === undefined || g.a1 === undefined) return null;
    const TWO = Math.PI * 2, nrm = (v: number) => ((v % TWO) + TWO) % TWO;
    const from = g.anticlockwise ? g.a1 : g.a0, sweep = nrm((g.anticlockwise ? g.a0 : g.a1) - from) || TWO, n = Math.max(4, Math.ceil(sweep / (Math.PI / 16)));
    const pts: Pt[] = []; for (let i = 0; i <= n; i++) { const a = from + (sweep * i) / n; pts.push([g.x + g.r * Math.cos(a), g.y + g.r * Math.sin(a)]); }
    return { pts, closed: false };
  }
  default: { const b = K.geomBox(g); return b ? { pts: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], closed: true } : null; }
  }
}
/** KIGEOM::ShapeHitTest of a lasso against one outline: wholly inside (contained) or touching. */
function pathHit(poly: Pt[], path: { pts: Pt[]; closed: boolean }, contained: boolean, filled?: (x: number, y: number) => boolean): boolean {
  const P = path.pts, n = P.length; if (!n) return false;
  let crosses = false;
  outer: for (let i = 0; i < (path.closed ? n : n - 1); i++) { const a = P[i], b = P[(i + 1) % n]; for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) if (segsCross(a, b, poly[j], poly[k])) { crosses = true; break outer; } }
  if (contained) return !crosses && pointInPoly(poly, P[0][0], P[0][1]);
  if (crosses || pointInPoly(poly, P[0][0], P[0][1])) return true;
  return !!filled && poly.length > 0 && filled(poly[0][0], poly[0][1]);   // the lasso sits wholly inside a filled figure
}
const drawn = (g: GeomPrim) => !g.padText && !g.padNum && !g.noBox && !g.zoneFill;
/** One geometry record against the area. */
function geomInArea(g: GeomPrim, area: SelArea): boolean {
  if (area.box) {
    const b = K.geomBox(g); if (!b) return false; const r = area.box;
    return area.contained ? boxInBox(r, b) : (K.geomTouchesRect as (g: GeomPrim, x0: number, y0: number, x1: number, y1: number) => boolean)(g, r[0], r[1], r[2], r[3]);
  }
  const path = geomPath(g); if (!path) return false;
  return pathHit(area.poly!, path, area.contained, (x, y) => { try { return K.geomHit(g, x, y, 0); } catch (e) { return false; } });
}
function quadInArea(q: Pt[], area: SelArea): boolean {
  if (area.box) { const r = area.box; if (area.contained) return q.every((p) => inBox(r, p[0], p[1])); const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); if (!boxMeets(r, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)])) return false; return q.some((p) => inBox(r, p[0], p[1])) || pathHit([[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], { pts: q, closed: true }, false, (x, y) => pointInPoly(q, x, y)); }
  return pathHit(area.poly!, { pts: q, closed: true }, area.contained, (x, y) => pointInPoly(q, x, y));
}
function boxInArea(b: Box, area: SelArea): boolean { return quadInArea([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], area); }
const unionBox = (a: Box | null, b: Box | null): Box | null => (!b ? a : !a ? b.slice() as Box : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);

/** EDA_ITEM::HitTest( box | polygon, contained ) for a board item (not a footprint's pad or text: those have their own). */
export function itemInArea(it: KItem, area: SelArea, hidden?: Set<string> | null): boolean {
  const n = it.node, k = it.kind;
  if (k === "segment") {   // PCB_TRACK::HitTest: both ends inside, or the centre line crossing
    const a = pt(n, "start"), b = pt(n, "end"); if (!a || !b) return false;
    if (area.box) { const r = area.box; return area.contained ? inBox(r, a[0], a[1]) && inBox(r, b[0], b[1]) : segTouchesRect(a, b, r); }
  }
  if (k === "arc" && area.box) {   // PCB_ARC::HitTest: the box of start, mid and end, grown by half the width
    const a = pt(n, "start"), m = pt(n, "mid"), b = pt(n, "end"); if (!a || !m || !b) return false;
    const wn = K.kid(n, "width"), w = (wn ? K.num(wn[1], 0) : 0) / 2;
    const box: Box = [Math.min(a[0], m[0], b[0]) - w, Math.min(a[1], m[1], b[1]) - w, Math.max(a[0], m[0], b[0]) + w, Math.max(a[1], m[1], b[1]) + w];
    return area.contained ? boxInBox(area.box, box) : boxMeets(area.box, box);
  }
  if (k === "via" && area.box) {   // PCB_VIA::HitTest: the pad's box inside, or the pad's circle meeting the box
    const at = pt(n, "at"); if (!at) return false; const sz = K.kid(n, "size"), r = (sz ? K.num(sz[1], 0.8) : 0.8) / 2, bx = area.box;
    if (area.contained) return boxInBox(bx, [at[0] - r, at[1] - r, at[0] + r, at[1] + r]);
    const cx = Math.max(bx[0], Math.min(at[0], bx[2])), cy = Math.max(bx[1], Math.min(at[1], bx[3])); return Math.hypot(cx - at[0], cy - at[1]) <= r;
  }
  if (k === "footprint") return footprintInArea(it, area);
  const geoms = ((it.geom || []) as GeomPrim[]).filter((g) => drawn(g) && !(hidden && g.layer && hidden.has(g.layer)));
  if (!geoms.length) return false;
  if (area.box && area.contained) return !!it.bbox && boxInBox(area.box, it.bbox as Box);
  return area.contained ? geoms.every((g) => geomInArea(g, area)) : geoms.some((g) => geomInArea(g, area));
}
/** FOOTPRINT::HitTest( box | polygon, contained ): its pads, zones and drawings; never its texts (they select on their own). */
export function footprintInArea(it: KItem, area: SelArea): boolean {
  const all = ((it.geom || []) as GeomPrim[]).filter(drawn);
  const body = all.filter((g) => g.t !== "text" && !g.hole);
  let bodyBox: Box | null = null; for (const g of body) bodyBox = unionBox(bodyBox, K.geomBox(g) as Box | null);
  if (!body.length) {   // no pads, zones or drawings: its texts answer
    let tb: Box | null = null; for (const g of all) tb = unionBox(tb, K.geomBox(g) as Box | null);
    return !!tb && (area.box ? (area.contained ? boxInBox(area.box, tb) : boxMeets(area.box, tb)) : boxInArea(tb, area));
  }
  if (area.box) {
    if (area.contained) return !!bodyBox && boxInBox(area.box, bodyBox);   // GetBoundingBox( false )
    if (!bodyBox || !boxMeets(area.box, bodyBox)) return false;
    return body.some((g) => geomInArea(g, area));
  }
  return area.contained ? body.every((g) => geomInArea(g, area)) : body.some((g) => geomInArea(g, area));
}
/** PAD::HitTest( box | polygon, contained ) for the pad `index` of a footprint. */
export function padInArea(fp: KItem, index: number, area: SelArea, hidden?: Set<string> | null): boolean {
  const geoms = ((fp.geom || []) as GeomPrim[]).filter((g) => g.padIndex === index && drawn(g) && !g.hole && g.t !== "text" && !(hidden && g.layer && hidden.has(g.layer)));
  if (!geoms.length) return false;
  return area.contained ? geoms.every((g) => geomInArea(g, area)) : geoms.some((g) => geomInArea(g, area));
}
/** GetPosition() as CollectMultiple's sort reads it. */
function positionOf(doc: BoardDoc, id: string): Pt {
  const h = id.indexOf("#"), f = id.indexOf("@field:");
  const it = doc.items.get(h > 0 ? id.slice(0, h) : f > 0 ? id.slice(0, f) : id); if (!it) return [0, 0];
  if (f > 0) { const fb = (K.fieldBoxes(it, null) as unknown as { name: string; geom: GeomPrim }[]).find((q) => q.name === id.slice(f + 7)); if (fb) return [fb.geom.x, fb.geom.y]; }
  if (h > 0) { const g = ((it.geom || []) as GeomPrim[]).find((q) => q.padIndex === +id.slice(h + 1) && !q.hole && drawn(q)); if (g) { const b = K.geomBox(g); if (b) return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; } }
  const n = it.node;
  if (it.kind === "segment" || it.kind === "arc" || it.kind === "gr_line" || it.kind === "gr_arc" || it.kind === "gr_rect") { const a = pt(n, "start"); if (a) return a; }
  if (it.kind === "gr_circle") { const c = pt(n, "center"); if (c) return c; }
  if (K.kid(n, "at")) { const a = K.atOf(n); return [a[0], a[1]]; }
  const b = it.bbox; return b ? [b[0], b[1]] : [0, 0];
}
/**
 * PCB_SELECTION_TOOL::CollectMultiple.  Returns candidate ids in KiCad's order (by position: Y, then X): item ids, a
 * footprint's field or text on its own as "footprintId@field:Name", and — only when nothing else was taken — pads as
 * "footprintId#index".  A group counts as its id followed by all its members (this selection model's group).
 */
export function collectMultiple(doc: BoardDoc, area: SelArea, opts?: CollectOpts | null): string[] {
  opts = opts || {};
  const hidden = opts.hidden || null, f = opts.filter || null, contained = area.contained;
  const selectable = (it: KItem) => !!K.itemVisible(it, hidden) && (!opts!.selectable || opts!.selectable(it));
  const entered = S.enteredGroup && doc.items.has(S.enteredGroup) ? S.enteredGroup : null;
  const collector: string[] = [], pads: string[] = [], groupItems = new Set<string>();
  // the groups: contained mode takes a group only as a whole, by its bounding box
  for (const g of doc.items.values()) {
    if (g.kind !== "group" || g.id === entered) continue;
    const members = groupMembers(g.node).filter((id) => doc.items.has(id));
    if (contained && members.length) {
      const gb = groupBox(doc, g.id);
      if (gb && boxInArea(gb as Box, { box: area.box, poly: area.poly, contained: true }) && members.some((id) => selectable(doc.items.get(id)!))) collector.push(members[0]);
    }
    for (const id of members) groupItems.add(id);
  }
  for (const it of doc.items.values()) {
    if (it.kind === "group" || it.kind === "generated" || !it.bbox) continue;
    if (!selectable(it)) continue;
    if (it.kind === "footprint") {
      // its pads, fields and texts are view items of their own
      const seen = new Set<number>();
      for (const g of (it.geom || []) as GeomPrim[]) { const i = g.padIndex as number | null | undefined; if (i === undefined || i === null || seen.has(i)) continue; seen.add(i); if (padInArea(it, i, area, hidden)) pads.push(padKey(it.id, i)); }
      for (const fb of K.fieldBoxes(it, hidden) as unknown as { name: string; pts: Pt[] }[]) if (quadInArea(fb.pts, area)) collector.push(fieldCandidateId(it.id, fb.name));
    }
    if (itemInArea(it, area, hidden) && (!contained || !groupItems.has(it.id))) collector.push(it.id);
  }
  const passes = (id: string, multi: boolean): boolean => {
    const h = id.indexOf("#"), fi = id.indexOf("@field:");
    const it = doc.items.get(h > 0 ? id.slice(0, h) : fi > 0 ? id.slice(0, fi) : id); if (!it) return false;
    return itemPassesFilter(doc, f, it, { pad: h > 0, child: fi > 0, multi });
  };
  // FilterCollectedItems, then FilterCollectorForHierarchy( multiselect ): outside an entered group nothing; a group
  // member gives its top group; a footprint's child goes when its footprint is taken too
  const hierarchy = (list: string[]): string[] => {
    const taken = new Set(list), out: string[] = [], add = new Set<string>();
    for (const id of list) {
      const h = id.indexOf("#"), fi = id.indexOf("@field:"), base = h > 0 ? id.slice(0, h) : fi > 0 ? id.slice(0, fi) : id;
      if (entered && !withinEnteredGroup(doc, [base]).length) continue;
      const top = topParentOf(doc, base);
      if (top) { add.add(top.id); continue; }
      if (base !== id && taken.has(base)) continue;
      out.push(id);
    }
    for (const g of add) for (const id of expandGroups(doc, [g])) if (!out.includes(id)) out.push(id);
    return out;
  };
  let result = hierarchy(collector.filter((id) => passes(id, true)));
  if (!result.length) result = hierarchy(pads.filter((id) => passes(id, true)));   // nothing but pads: allow them
  const pos = new Map<string, Pt>(); for (const id of result) pos.set(id, positionOf(doc, id));
  const key = (v: number) => Math.round(v * 1e6);
  return result.map((id, i) => ({ id, i })).sort((a, b) => { const p = pos.get(a.id)!, q = pos.get(b.id)!; return key(p[1]) - key(q[1]) || key(p[0]) - key(q[0]) || a.i - b.i; }).map((e) => e.id);
}
