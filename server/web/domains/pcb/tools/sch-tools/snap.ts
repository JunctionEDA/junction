import type { Mods, SchCtx, Pt } from "./types";
import { pinsAt } from "./connect";
import { S, atOf, kid, kids, num, ptsOf } from "./state";
import { r4 } from "./util";

// ---------------------------------------------------------------- cursor snapping
export function mmPerPx(ctx: SchCtx) {
  if (ctx.worldMm && ctx.stage) { try { const a = ctx.worldMm({ clientX: 0, clientY: 0 }), b = ctx.worldMm({ clientX: 100, clientY: 0 }); const v = (b[0] - a[0]) / 100; if (v > 0 && isFinite(v)) return v; } catch (e) { /* no layout yet */ } }
  return ctx.pxPerMm ? 1 / ctx.pxPerMm : 0.25;
}
// Grid snap, but a pin or line end within reach wins (KiCad's connection snapping).  As in every SCH tool loop,
// Shift turns the magnetic snap to anchors off (grid.SetSnap( !MD_SHIFT )) and Ctrl the grid (DisableGridSnapping).
/** The modifier keys of the event behind a click or a move. */
export function snapConn(ctx: SchCtx, mm: Pt, kind: string, ev?: Mods | null): Pt {
  const noGrid = !!(ev && (ev.ctrlKey || ev.metaKey)), noAnchors = !!(ev && ev.shiftKey);
  const g = noGrid ? [mm[0], mm[1]] : ctx.snap([mm[0], mm[1]]);
  if (noAnchors) return [r4(g[0]), r4(g[1])];
  const a = snapAnchor(ctx, mm, kind);
  return a || [r4(g[0]), r4(g[1])];
}
const SNAP_CONNECTABLE = new Set(["junction", "no_connect", "wire", "bus", "bus_entry", "label", "global_label", "hierarchical_label", "netclass_flag", "directive_label"]);
/**
 * GRID_HELPER::computeSnapRanges( true ): the snap range is 25 px clamped to the visible grid; an anchor is snapped
 * to within range - 5 px (m_SnapHysteresis) and held until range + 5 px.
 */
export function snapRanges(ctx: SchCtx): { range: number; in: number; out: number } {
  const px = mmPerPx(ctx), range = Math.min(25 * px, ctx.gridPitch || 1.27), h = 5 * px;
  return { range, in: Math.max(0, range - h), out: range + h };
}
/**
 * EE_GRID_HELPER::computeAnchors within reach of the cursor: every connection point of junctions, no-connects,
 * labels, bus entries, sheet pins and wire / bus ends, the pin positions, and for a horizontal or vertical line the
 * grid-aligned point on it.  The graphic-line tool (GRID_GRAPHICS) takes the non-connectable items instead: graphic
 * line ends (and their on-line point) and text box / table corners.
 */
export function snapAnchors(ctx: SchCtx, mm: Pt, kind: string, reach: number): Pt[] {
  const doc = ctx.doc, out: Pt[] = [], graphics = kind === "polyline";
  const near = (p: Pt) => Math.abs(p[0] - mm[0]) <= reach && Math.abs(p[1] - mm[1]) <= reach;
  const add = (p: Pt) => { if (near(p)) out.push([p[0], p[1]]); };
  const al = ctx.snap([mm[0], mm[1]]);
  const onLine = (a: Pt, b: Pt) => {   // the aligned point on a vertical / horizontal SCH_LINE
    if (Math.abs(a[0] - b[0]) <= 1e-6) { const y = al[1]; if (y >= Math.min(a[1], b[1]) - 1e-6 && y <= Math.max(a[1], b[1]) + 1e-6) add([a[0], y]); }
    else if (Math.abs(a[1] - b[1]) <= 1e-6) { const x = al[0]; if (x >= Math.min(a[0], b[0]) - 1e-6 && x <= Math.max(a[0], b[0]) + 1e-6) add([x, a[1]]); }
  };
  if (!graphics) for (const p of pinsAt(doc, mm[0], mm[1], reach)) out.push([p.x, p.y]);
  for (const it of doc.items.values()) {
    const b = it.bbox; if (b && (mm[0] < b[0] - reach || mm[0] > b[2] + reach || mm[1] < b[1] - reach || mm[1] > b[3] + reach)) continue;
    if (graphics) {
      if (it.kind === "polyline") { const p = ptsOf(it.node); if (p.length === 2) { add(p[0]); add(p[1]); onLine(p[0], p[1]); } }
      else if ((it.kind === "text_box" || it.kind === "table") && b) { add([b[0], b[1]]); add([b[2], b[3]]); }
      continue;
    }
    if (it.kind === "sheet") { for (const pin of kids(it.node, "pin")) add(atOf(pin)); continue; }
    if (!SNAP_CONNECTABLE.has(it.kind)) continue;
    if (it.kind === "wire" || it.kind === "bus") { const p = ptsOf(it.node); if (p.length < 2) continue; add(p[0]); add(p[p.length - 1]); if (p.length === 2) onLine(p[0], p[1]); }
    else if (it.kind === "bus_entry") { const [x, y] = atOf(it.node), sz = kid(it.node, "size"); add([x, y]); add([x + (sz ? num(sz[1]) : 2.54), y + (sz ? num(sz[2]) : 2.54)]); }
    else add(atOf(it.node));
  }
  return out;
}
/**
 * The object anchor snapConn lands on for this cursor, or null when it falls back to the grid (EE_GRID_HELPER::
 * BestSnapAnchor): the nearest anchor within the snap-in range, and the anchor snapped to last (S.snapItem) for as
 * long as the cursor stays within the snap-out range of it and no other anchor has come closer.
 */
export function snapAnchor(ctx: SchCtx, mm: Pt, kind: string): Pt | null {
  const r = snapRanges(ctx), anchors = snapAnchors(ctx, mm, kind, r.out);
  let best: Pt | null = null, bd = Infinity;
  for (const a of anchors) { const d = Math.hypot(a[0] - mm[0], a[1] - mm[1]); if (d < bd) { bd = d; best = a; } }
  const held = S.snapItem as Pt | null | undefined;
  let pick: Pt | null = best && bd <= r.in ? best : null;
  if (held) {
    const still = anchors.find((a) => Math.abs(a[0] - held[0]) <= 1e-6 && Math.abs(a[1] - held[1]) <= 1e-6), hd = still ? Math.hypot(still[0] - mm[0], still[1] - mm[1]) : Infinity;
    if (still && hd <= r.out && (!pick || hd <= bd)) pick = still;
  }
  S.snapItem = pick ? [r4(pick[0]), r4(pick[1])] : null;
  return pick ? [r4(pick[0]), r4(pick[1])] : null;
}
