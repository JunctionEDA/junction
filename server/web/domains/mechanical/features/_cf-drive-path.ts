// _cf-drive-path.ts — the path a belt or chain takes round two wheels, and the shape of a timing belt's tooth.
// Pure geometry: no kernel.  Wheel 1 is at the origin, wheel 2 at (centres, 0); the path runs counter-clockwise:
// round wheel 1 from its upper tangent point to its lower, along the lower span, round wheel 2, back along the
// upper span.
import { Pen, type P2, type Seg } from "../kernel/ops/cf-drive";
import type { BeltTooth } from "./_cf-drive-data";

export interface LoopPath {
  r1: number; r2: number; centres: number;
  /** the angle the spans lean by (radians): asin((r2 − r1) / centres) */
  lean: number;
  length: number;
  /** the lengths of the four pieces: round wheel 1, lower span, round wheel 2, upper span */
  pieces: [number, number, number, number];
  /** the point at a distance along the path, its direction there, and the unit normal pointing out of the loop */
  at(s: number): { p: P2; t: P2; n: P2 };
  /** the distance along the path of the point of wheel 1 at this angle (it must be on the wrapped part) */
  onWheel1(angle: number): number;
}

export function loopPath(r1: number, r2: number, centres: number): LoopPath {
  const lean = Math.asin((r2 - r1) / centres), span = centres * Math.cos(lean);
  const top = Math.PI / 2 + lean, wrap1 = Math.PI - 2 * lean, wrap2 = Math.PI + 2 * lean;
  const pieces: [number, number, number, number] = [r1 * wrap1, span, r2 * wrap2, span];
  const length = pieces[0] + pieces[1] + pieces[2] + pieces[3];
  const dir = (a: number): P2 => [Math.cos(a), Math.sin(a)];
  const at = (s0: number) => {
    let s = ((s0 % length) + length) % length;
    if (s <= pieces[0]) { const a = top + s / r1, n = dir(a); return { p: [r1 * n[0], r1 * n[1]] as P2, t: [-n[1], n[0]] as P2, n }; }
    s -= pieces[0];
    const nb = dir(-Math.PI / 2 - lean), tb: P2 = [-nb[1], nb[0]];
    if (s <= pieces[1]) return { p: [r1 * nb[0] + tb[0] * s, r1 * nb[1] + tb[1] * s] as P2, t: tb, n: nb };
    s -= pieces[1];
    if (s <= pieces[2]) { const a = -Math.PI / 2 - lean + s / r2, n = dir(a); return { p: [centres + r2 * n[0], r2 * n[1]] as P2, t: [-n[1], n[0]] as P2, n }; }
    s -= pieces[2];
    const nt = dir(top), tt: P2 = [-nt[1], nt[0]];
    return { p: [centres + r2 * nt[0] + tt[0] * s, r2 * nt[1] + tt[1] * s] as P2, t: tt, n: nt };
  };
  return { r1, r2, centres, lean, length, pieces, at, onWheel1: (angle) => { let a = angle - top; while (a < 0) a += 2 * Math.PI; return a * r1; } };
}

/** The centre distance at which the path round two pitch circles has this length (bisection), or null when none has. */
export function centresFor(r1: number, r2: number, length: number): number | null {
  let lo = Math.abs(r2 - r1) + 1e-6, hi = length;
  if (loopPath(r1, r2, lo).length > length) return null;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (loopPath(r1, r2, m).length < length) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/**
 * A timing belt tooth, which is also the groove it sits in: drawn across the tooth (x) and into the pulley
 * (y, negative), from the land on one side (−w, 0) to the land on the other (w, 0).  `grow` widens and deepens
 * it (the clearance of a pulley's groove).  Labels: `a` and `b` the flanks, `floor`, `ra` / `rb` the corners.
 */
export function toothShape(t: BeltTooth, grow = 0): { start: P2; segs: Seg[]; w: number; h: number } {
  const h = t.h + grow;
  if (t.kind === "trapezoid") {
    const tan = Math.tan(((t.angle / 2) * Math.PI) / 180), half = t.root / 2 + grow, w = half + h * tan;
    const pen = new Pen([-w, 0]);
    pen.line([-half, -h], "a").line([half, -h], "floor").line([w, 0], "b");
    return { start: pen.start, segs: pen.segs, w, h };
  }
  if (t.kind === "htd") {
    const r = t.r + grow, r1 = t.r1, w = r + r1, yc = -(h - r);
    const pen = new Pen([-w, 0]);
    pen.arcAbout([-w, -r1], [-r, -r1], "ra");
    if (-r1 > yc + 1e-9) pen.line([-r, yc], "a");
    pen.arc([0, -h], [r, yc], "floor");
    if (-r1 > yc + 1e-9) pen.line([r, -r1], "b");
    pen.arcAbout([w, -r1], [w, 0], "rb");
    return { start: pen.start, segs: pen.segs, w, h };
  }
  // GT: bottom arc r3 on the centre line, flank arcs r2 centred b across the centre line, corner arcs r1
  const r3 = t.r3 + grow, r2 = t.r2 + grow, r1 = t.r1, b = t.b;
  const cy = -(h - r3), fy = cy + Math.sqrt(Math.max(0, (r2 - r3) ** 2 - b * b));   // the flank arcs' centres are at (∓b, fy)
  const fx = -b + Math.sqrt(Math.max(0, (r2 + r1) ** 2 - (fy + r1) ** 2));          // the right corner arc's centre is at (fx, −r1)
  const unit = (x: number, y: number): P2 => { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; };
  const dj = unit(fx + b, -r1 - fy), db = unit(b, cy - fy);
  const join: P2 = [-b + r2 * dj[0], fy + r2 * dj[1]], foot: P2 = [-b + r2 * db[0], fy + r2 * db[1]];
  const pen = new Pen([-fx, 0]);
  pen.arcAbout([-fx, -r1], [-join[0], join[1]], "ra").arcAbout([b, fy], [-foot[0], foot[1]], "a").arc([0, -h], foot, "floor").arcAbout([-b, fy], join, "b").arcAbout([fx, -r1], [fx, 0], "rb");
  return { start: pen.start, segs: pen.segs, w: fx, h };
}

/**
 * A tooth shape as the groove of a pulley of outside radius `R`: the shape stands square to the groove's centre
 * line with its land line touching the outside circle there, so the groove is exactly as deep as the tooth is
 * high; its two corners are cut back to where they cross the circle.  In the same coordinates as the shape.
 */
export function grooveOn(shape: { start: P2; segs: Seg[] }, R: number): { start: P2; segs: Seg[] } {
  const first = shape.segs[0], a = shape.start, b = first.to;
  let at: (t: number) => P2;
  if (first.via) {
    // the circle through the arc's three points, and the way round it from the start to the end
    const m = first.via, d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    const cx = ((a[0] ** 2 + a[1] ** 2) * (m[1] - b[1]) + (m[0] ** 2 + m[1] ** 2) * (b[1] - a[1]) + (b[0] ** 2 + b[1] ** 2) * (a[1] - m[1])) / d;
    const cy = ((a[0] ** 2 + a[1] ** 2) * (b[0] - m[0]) + (m[0] ** 2 + m[1] ** 2) * (a[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (m[0] - a[0])) / d;
    const r = Math.hypot(a[0] - cx, a[1] - cy), a0 = Math.atan2(a[1] - cy, a[0] - cx);
    let am = Math.atan2(m[1] - cy, m[0] - cx) - a0, a1 = Math.atan2(b[1] - cy, b[0] - cx) - a0;
    const turn = 2 * Math.PI;
    am = ((am % turn) + turn) % turn; a1 = ((a1 % turn) + turn) % turn;
    if (am > a1) a1 -= turn;   // the middle point is not on the way round counter-clockwise: go clockwise
    at = (t) => [cx + r * Math.cos(a0 + a1 * t), cy + r * Math.sin(a0 + a1 * t)];
  } else at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const outside = (q: P2) => Math.hypot(q[0], q[1] + R) > R;
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (outside(at(mid))) lo = mid; else hi = mid; }
  const start = at(hi), via = at((hi + 1) / 2), mirror = (q: P2): P2 => [-q[0], q[1]];
  const segs = shape.segs.map((x) => ({ ...x }));
  if (first.via) { segs[0].via = via; segs[segs.length - 1].via = mirror(via); }
  segs[segs.length - 1].to = mirror(start);
  return { start, segs };
}
