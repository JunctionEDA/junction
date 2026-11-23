// tools/potrace.ts — Potrace 1.16 (thirdparty/potrace, Copyright (C) 2001-2017 Peter Selinger, GPL), ported from
// KiCad's copy line by line: the bitmap (bitmap.h), the path decomposition (decompose.cpp), the curve fitting
// (trace.cpp) and the library entry points (potracelib.cpp).  KiCad traces a reference image with it
// (common/bitmap_tracing.cpp TraceBilevelImage).  The progress callbacks are left out (KiCad passes none).
//
// The bitmap keeps one byte per pixel instead of potrace's packed words; its rows are padded to whole 64-bit words
// so that the word-wise operations (xor_to_ref, clear_bm_with_bbox, findnext's word scan) touch exactly the pixels
// the C code does.

/** POTRACE_TURNPOLICY_*. */
export const TURNPOLICY_BLACK = 0, TURNPOLICY_WHITE = 1, TURNPOLICY_LEFT = 2, TURNPOLICY_RIGHT = 3, TURNPOLICY_MINORITY = 4, TURNPOLICY_MAJORITY = 5, TURNPOLICY_RANDOM = 6;
/** POTRACE_CURVETO / POTRACE_CORNER. */
export const CURVETO = 1, CORNER = 2;
/** POTRACE_STATUS_OK / POTRACE_STATUS_INCOMPLETE. */
export const STATUS_OK = 0, STATUS_INCOMPLETE = 1;

/** potrace_param_t (the progress member is not ported). */
export interface PotraceParam { turdsize: number; turnpolicy: number; alphamax: number; opticurve: number; opttolerance: number }
export interface DPoint { x: number; y: number }
/** potrace_curve_t: n segments, tag[n], c[n][3]. */
export interface PotraceCurve { n: number; tag: number[]; c: DPoint[][] }
/** potrace_path_t with its private state. */
export interface PotracePath {
  area: number; sign: string; curve: PotraceCurve;
  next: PotracePath | null; childlist: PotracePath | null; sibling: PotracePath | null;
  priv: PrivPath;
}
export interface PotraceState { status: number; plist: PotracePath | null }

/** BM_WORDBITS of an unsigned long on the platforms KiCad ships for (LP64). */
const WORDBITS = 64;
/** potrace_bitmap_t: w x h pixels, rows of dy words. */
export interface PotraceBitmap { w: number; h: number; dy: number; stride: number; map: Uint8Array }

export function bmNew(w: number, h: number): PotraceBitmap {
  const dy = w === 0 ? 0 : Math.floor((w - 1) / WORDBITS) + 1;
  return { w, h, dy, stride: dy * WORDBITS, map: new Uint8Array(Math.max(1, dy * WORDBITS * h)) };
}
const bmSafe = (bm: PotraceBitmap, x: number, y: number): boolean => x >= 0 && x < bm.w && y >= 0 && y < bm.h;
/** BM_GET: 0 outside the bitmap. */
export function bmGet(bm: PotraceBitmap, x: number, y: number): number { return bmSafe(bm, x, y) ? bm.map[y * bm.stride + x] : 0; }
/** BM_PUT. */
export function bmPut(bm: PotraceBitmap, x: number, y: number, b: number | boolean): void { if (bmSafe(bm, x, y)) bm.map[y * bm.stride + x] = b ? 1 : 0; }
function bmDup(bm: PotraceBitmap): PotraceBitmap { const b = bmNew(bm.w, bm.h); b.map.set(bm.map.subarray(0, b.map.length)); return b; }
function bmClear(bm: PotraceBitmap, c: number): void { bm.map.fill(c ? 1 : 0); }

// ---------------------------------------------------------------- curve.h / curve.cpp
interface PrivCurve {
  n: number; tag: number[]; c: DPoint[][];
  alphacurve: number; vertex: DPoint[]; alpha: number[]; alpha0: number[]; beta: number[];
}
interface Sums { x: number; y: number; x2: number; xy: number; y2: number }
interface PrivPath {
  len: number; ptx: number[]; pty: number[];
  lon: number[]; x0: number; y0: number; sums: Sums[];
  m: number; po: number[];
  curve: PrivCurve; ocurve: PrivCurve; fcurve: PrivCurve | null;
}
const dp = (x: number, y: number): DPoint => ({ x, y });
function privcurveInit(n: number): PrivCurve {
  const c: DPoint[][] = []; const vertex: DPoint[] = [];
  for (let i = 0; i < n; i++) { c.push([dp(0, 0), dp(0, 0), dp(0, 0)]); vertex.push(dp(0, 0)); }
  return { n, tag: new Array(n).fill(0), c, alphacurve: 0, vertex, alpha: new Array(n).fill(0), alpha0: new Array(n).fill(0), beta: new Array(n).fill(0) };
}
const emptyCurve = (): PrivCurve => privcurveInit(0);
function pathNew(): PotracePath {
  return { area: 0, sign: "+", curve: { n: 0, tag: [], c: [] }, next: null, childlist: null, sibling: null,
    priv: { len: 0, ptx: [], pty: [], lon: [], x0: 0, y0: 0, sums: [], m: 0, po: [], curve: emptyCurve(), ocurve: emptyCurve(), fcurve: null } };
}

// ---------------------------------------------------------------- auxiliary.h
const mod = (a: number, n: number): number => (a >= n ? a % n : a >= 0 ? a : n - 1 - ((-1 - a) % n));
const floordiv = (a: number, n: number): number => (a >= 0 ? Math.trunc(a / n) : -1 - Math.trunc((-1 - a) / n));
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0);
const sq = (a: number): number => a * a;
const interval = (lambda: number, a: DPoint, b: DPoint): DPoint => dp(a.x + lambda * (b.x - a.x), a.y + lambda * (b.y - a.y));
/** C int arithmetic for xprod (the products of path coordinates stay well inside 32 bits). */
const toInt = (v: number): number => v | 0;

// ---------------------------------------------------------------- decompose.cpp
/** detrand's table: the constant term of the inverse in GF(8), mod x^8+x^4+x^3+x+1. */
const DETRAND_T = [
  0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0,
  0, 0, 0, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1,
  1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0,
  1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1,
  0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0,
  1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 0, 0,
  1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1,
  0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1,
  0, 1, 0, 1, 0, 1, 0,
];
/** detrand: hash (x, y) into a pseudo-random bit, in unsigned 32-bit arithmetic. */
function detrand(x: number, y: number): number {
  let z = (Math.imul(0x04b3e375, x) ^ y) >>> 0;
  z = Math.imul(z, 0x05a8ef93) >>> 0;
  const t = DETRAND_T;
  return t[z & 0xff] ^ t[(z >>> 8) & 0xff] ^ t[(z >>> 16) & 0xff] ^ t[(z >>> 24) & 0xff];
}
/** majority: the "majority" value of the bitmap at the intersection (x, y). */
function majority(bm: PotraceBitmap, x: number, y: number): number {
  for (let i = 2; i < 5; i++) {
    let ct = 0;
    for (let a = -i + 1; a <= i - 1; a++) {
      ct += bmGet(bm, x + a, y + i - 1) ? 1 : -1;
      ct += bmGet(bm, x + i - 1, y + a - 1) ? 1 : -1;
      ct += bmGet(bm, x + a - 1, y - i) ? 1 : -1;
      ct += bmGet(bm, x - i, y + a) ? 1 : -1;
    }
    if (ct > 0) return 1;
    else if (ct < 0) return 0;
  }
  return 0;
}
/** xor_to_ref: invert bits [x, infty) and [xa, infty) in line y (xa a multiple of the word size). */
function xorToRef(bm: PotraceBitmap, x: number, y: number, xa: number): void {
  const lo = Math.min(x, xa), hi = Math.max(x, xa), row = y * bm.stride, map = bm.map;
  for (let i = lo; i < hi; i++) map[row + i] ^= 1;
}
/** xor_path: xor the bitmap with the interior of the path. */
function xorPath(bm: PotraceBitmap, p: PotracePath): void {
  const pp = p.priv; if (pp.len <= 0) return;
  let y1 = pp.pty[pp.len - 1];
  const xa = pp.ptx[0] & -WORDBITS;
  for (let k = 0; k < pp.len; k++) {
    const x = pp.ptx[k], y = pp.pty[k];
    if (y !== y1) { xorToRef(bm, x, Math.min(y, y1), xa); y1 = y; }
  }
}
interface BBox { x0: number; x1: number; y0: number; y1: number }
/** setbbox_path. */
function setbboxPath(p: PotracePath): BBox {
  const b: BBox = { y0: 0x7fffffff, y1: 0, x0: 0x7fffffff, x1: 0 }, pp = p.priv;
  for (let k = 0; k < pp.len; k++) {
    const x = pp.ptx[k], y = pp.pty[k];
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  return b;
}
/** clear_bm_with_bbox: whole words from the box's first to its last column, rows y0 .. y1 - 1. */
function clearBmWithBbox(bm: PotraceBitmap, b: BBox): void {
  const imin = Math.floor(b.x0 / WORDBITS), imax = Math.floor((b.x1 + WORDBITS - 1) / WORDBITS);
  for (let y = b.y0; y < b.y1; y++) bm.map.fill(0, y * bm.stride + imin * WORDBITS, y * bm.stride + imax * WORDBITS);
}
/** findpath: the path from the upper left corner (x0, y0) separating black from white, with its area. */
function findpath(bm: PotraceBitmap, x0: number, y0: number, sgn: string, turnpolicy: number): PotracePath {
  let x = x0, y = y0, dirx = 0, diry = -1, area = 0;
  const ptx: number[] = [], pty: number[] = [];
  for (;;) {
    ptx.push(x); pty.push(y);
    x += dirx; y += diry;
    area += x * diry;   // uint64_t in the C code: a negative total wraps to a huge value (clamped to INT_MAX below)
    if (x === x0 && y === y0) break;
    const c = bmGet(bm, x + ((dirx + diry - 1) >> 1), y + ((diry - dirx - 1) >> 1));
    const d = bmGet(bm, x + ((dirx - diry - 1) >> 1), y + ((diry + dirx - 1) >> 1));
    let tmp: number;
    if (c && !d) {   // ambiguous turn
      if (turnpolicy === TURNPOLICY_RIGHT || (turnpolicy === TURNPOLICY_BLACK && sgn === "+") || (turnpolicy === TURNPOLICY_WHITE && sgn === "-")
        || (turnpolicy === TURNPOLICY_RANDOM && detrand(x, y)) || (turnpolicy === TURNPOLICY_MAJORITY && majority(bm, x, y))
        || (turnpolicy === TURNPOLICY_MINORITY && !majority(bm, x, y))) { tmp = dirx; dirx = diry; diry = -tmp; }   // right turn
      else { tmp = dirx; dirx = -diry; diry = tmp; }   // left turn
    } else if (c) { tmp = dirx; dirx = diry; diry = -tmp; }   // right turn
    else if (!d) { tmp = dirx; dirx = -diry; diry = tmp; }   // left turn
  }
  const p = pathNew();
  p.priv.ptx = ptx; p.priv.pty = pty; p.priv.len = ptx.length;
  p.area = area < 0 || area > 0x7fffffff ? 0x7fffffff : area;
  p.sign = sgn;
  return p;
}
/**
 * pathlist_to_tree: the tree of "insideness" (childlist / sibling), and the list relinked so that each positive path
 * is followed by its negative children.  `bm` is scratch space.
 */
function pathlistToTree(plist: PotracePath | null, bm: PotraceBitmap): PotracePath | null {
  bmClear(bm, 0);
  for (let p = plist; p; p = p.next) { p.sibling = p.next; p.childlist = null; }   // save the original "next" pointers
  let heap: PotracePath | null = plist;
  while (heap) {
    // unlink the first sublist
    let cur: PotracePath | null = heap; heap = heap.childlist; cur.childlist = null;
    // unlink the first path
    const head: PotracePath = cur; cur = cur.next; head.next = null;
    xorPath(bm, head);
    const bbox = setbboxPath(head);
    // append each element of cur to head.childlist when it is inside head, else to head.next
    let inTail: PotracePath | null = null, outTail: PotracePath | null = null;
    const appendIn = (p: PotracePath): void => { p.next = null; if (inTail) inTail.next = p; else head.childlist = p; inTail = p; };
    const appendOut = (p: PotracePath): void => { p.next = null; if (outTail) outTail.next = p; else head.next = p; outTail = p; };
    while (cur) {
      const p: PotracePath = cur; cur = cur.next; p.next = null;
      if (p.priv.pty[0] <= bbox.y0) {
        appendOut(p);
        p.next = cur;   // append the remainder of the list to hook_out
        break;
      }
      if (bmGet(bm, p.priv.ptx[0], p.priv.pty[0] - 1)) appendIn(p); else appendOut(p);
    }
    clearBmWithBbox(bm, bbox);
    // schedule head.childlist and head.next for further processing
    const outs = head.next as PotracePath | null, kids = head.childlist as PotracePath | null;   // filled by appendOut / appendIn above
    if (outs) { outs.childlist = heap; heap = outs; }
    if (kids) { kids.childlist = heap; heap = kids; }
  }
  // copy the sibling structure from "next" to "sibling"
  let p = plist;
  while (p) { const p1: PotracePath | null = p.sibling; p.sibling = p.next; p = p1; }
  // rebuild the "next" list from the tree
  heap = plist;
  if (heap) heap.next = null;   // heap is a linked list of childlists
  let out: PotracePath | null = null, tail: PotracePath | null = null;
  const push = (q: PotracePath): void => { q.next = null; if (tail) tail.next = q; else out = q; tail = q; };
  while (heap) {
    let heap1: PotracePath | null = heap.next;
    for (let q: PotracePath | null = heap; q; q = q.sibling) {
      push(q);   // a positive path
      for (let q1: PotracePath | null = q.childlist; q1; q1 = q1.sibling) {
        push(q1);
        if (q1.childlist) {   // list_append( path_t, heap1, p1->childlist )
          q1.childlist.next = null;
          if (!heap1) heap1 = q1.childlist;
          else { let e: PotracePath = heap1; while (e.next) e = e.next; e.next = q1.childlist; }
        }
      }
    }
    heap = heap1;
  }
  return out;
}
/** findnext: the next set pixel in a row <= y, rows top-down and pixels left to right, from x's word on. */
function findnext(bm: PotraceBitmap, pos: { x: number; y: number }): boolean {
  let x0 = pos.x & ~(WORDBITS - 1);
  for (let y = pos.y; y >= 0; y--) {
    const row = y * bm.stride;
    for (let x = x0; x < bm.w && x >= 0; x++) if (bm.map[row + x]) { pos.x = x; pos.y = y; return true; }
    x0 = 0;
  }
  return false;
}
/** bm_to_pathlist: the bitmap decomposed into paths (len, pt, area, sign), turds dropped, then given its tree. */
function bmToPathlist(bm: PotraceBitmap, param: PotraceParam): PotracePath | null {
  const bm1 = bmDup(bm);
  // bm_clearexcess: the padding is never set here
  let plist: PotracePath | null = null, tail: PotracePath | null = null;
  const pos = { x: 0, y: bm1.h - 1 };
  while (findnext(bm1, pos)) {
    const sgn = bmGet(bm, pos.x, pos.y) ? "+" : "-";   // the sign from the original
    const p = findpath(bm1, pos.x, pos.y + 1, sgn, param.turnpolicy);
    xorPath(bm1, p);
    if (p.area > param.turdsize) { if (tail) tail.next = p; else plist = p; tail = p; }   // else a turd: dropped
  }
  return pathlistToTree(plist, bm1);
}

// ---------------------------------------------------------------- trace.cpp
const INFTY = 10000000;
const COS179 = -0.999847695156;
/** dorth_infty: 90 degrees counterclockwise from p2 - p0, restricted to a major wind direction. */
function dorthInfty(p0: DPoint, p2: DPoint): DPoint { return dp(-sign(p2.y - p0.y), sign(p2.x - p0.x)); }
function dpara(p0: DPoint, p1: DPoint, p2: DPoint): number { const x1 = p1.x - p0.x, y1 = p1.y - p0.y, x2 = p2.x - p0.x, y2 = p2.y - p0.y; return x1 * y2 - x2 * y1; }
function ddenom(p0: DPoint, p2: DPoint): number { const r = dorthInfty(p0, p2); return r.y * (p2.x - p0.x) - r.x * (p2.y - p0.y); }
function cyclic(a: number, b: number, c: number): boolean { return a <= c ? a <= b && b < c : a <= b || b < c; }
/** pointslope: the centre and slope of the line i..j (i < j). */
function pointslope(pp: PrivPath, i: number, j: number, ctr: DPoint, dir: DPoint): void {
  const n = pp.len, sums = pp.sums;
  let r = 0;
  while (j >= n) { j -= n; r += 1; }
  while (i >= n) { i -= n; r -= 1; }
  while (j < 0) { j += n; r -= 1; }
  while (i < 0) { i += n; r += 1; }
  const x = sums[j + 1].x - sums[i].x + r * sums[n].x;
  const y = sums[j + 1].y - sums[i].y + r * sums[n].y;
  const x2 = sums[j + 1].x2 - sums[i].x2 + r * sums[n].x2;
  const xy = sums[j + 1].xy - sums[i].xy + r * sums[n].xy;
  const y2 = sums[j + 1].y2 - sums[i].y2 + r * sums[n].y2;
  const k = j + 1 - i + r * n;
  ctr.x = x / k; ctr.y = y / k;
  let a = (x2 - x * x / k) / k;
  const b = (xy - x * y / k) / k;
  let c = (y2 - y * y / k) / k;
  const lambda2 = (a + c + Math.sqrt((a - c) * (a - c) + 4 * b * b)) / 2;   // the larger eigenvalue
  a -= lambda2; c -= lambda2;
  let l: number;
  if (Math.abs(a) >= Math.abs(c)) { l = Math.sqrt(a * a + b * b); if (l !== 0) { dir.x = -b / l; dir.y = a / l; } }
  else { l = Math.sqrt(c * c + b * b); if (l !== 0) { dir.x = -c / l; dir.y = b / l; } }
  if (l === 0) dir.x = dir.y = 0;   // the two eigenvalues coincide
}
type Quadform = number[][];
function quadform(Q: Quadform, w: DPoint): number {
  const v = [w.x, w.y, 1]; let sum = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sum += v[i] * Q[i][j] * v[j];
  return sum;
}
const xprod = (p1x: number, p1y: number, p2x: number, p2y: number): number => toInt(p1x * p2y - p1y * p2x);
function cprod(p0: DPoint, p1: DPoint, p2: DPoint, p3: DPoint): number { const x1 = p1.x - p0.x, y1 = p1.y - p0.y, x2 = p3.x - p2.x, y2 = p3.y - p2.y; return x1 * y2 - x2 * y1; }
function iprod(p0: DPoint, p1: DPoint, p2: DPoint): number { const x1 = p1.x - p0.x, y1 = p1.y - p0.y, x2 = p2.x - p0.x, y2 = p2.y - p0.y; return x1 * x2 + y1 * y2; }
function iprod1(p0: DPoint, p1: DPoint, p2: DPoint, p3: DPoint): number { const x1 = p1.x - p0.x, y1 = p1.y - p0.y, x2 = p3.x - p2.x, y2 = p3.y - p2.y; return x1 * x2 + y1 * y2; }
const ddist = (p: DPoint, q: DPoint): number => Math.sqrt(sq(p.x - q.x) + sq(p.y - q.y));
function bezier(t: number, p0: DPoint, p1: DPoint, p2: DPoint, p3: DPoint): DPoint {
  const s = 1 - t;
  return dp(s * s * s * p0.x + 3 * (s * s * t) * p1.x + 3 * (t * t * s) * p2.x + t * t * t * p3.x,
    s * s * s * p0.y + 3 * (s * s * t) * p1.y + 3 * (t * t * s) * p2.y + t * t * t * p3.y);
}
/** tangent: the t in [0, 1] where the bezier is tangent to q1 - q0, or -1. */
function tangent(p0: DPoint, p1: DPoint, p2: DPoint, p3: DPoint, q0: DPoint, q1: DPoint): number {
  const A = cprod(p0, p1, q0, q1), B = cprod(p1, p2, q0, q1), C = cprod(p2, p3, q0, q1);
  const a = A - 2 * B + C, b = -2 * A + 2 * B, c = A;
  const d = b * b - 4 * a * c;
  if (a === 0 || d < 0) return -1.0;
  const s = Math.sqrt(d);
  const r1 = (-b + s) / (2 * a), r2 = (-b - s) / (2 * a);
  if (r1 >= 0 && r1 <= 1) return r1;
  else if (r2 >= 0 && r2 <= 1) return r2;
  return -1.0;
}
/** calc_sums. */
function calcSums(pp: PrivPath): void {
  const n = pp.len;
  pp.x0 = pp.ptx[0]; pp.y0 = pp.pty[0];
  const sums: Sums[] = [{ x: 0, y: 0, x2: 0, xy: 0, y2: 0 }];
  for (let i = 0; i < n; i++) {
    const x = pp.ptx[i] - pp.x0, y = pp.pty[i] - pp.y0, s = sums[i];
    sums.push({ x: s.x + x, y: s.y + y, x2: s.x2 + x * x, xy: s.xy + x * y, y2: s.y2 + y * y });
  }
  pp.sums = sums;
}
/** calc_lon: stage 1, the straight subpaths (Sec. 2.2.1). */
function calcLon(pp: PrivPath): void {
  const px = pp.ptx, py = pp.pty, n = pp.len;
  const pivk = new Array<number>(n).fill(0), nc = new Array<number>(n).fill(0);
  const ct = [0, 0, 0, 0];
  let k = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (px[i] !== px[k] && py[i] !== py[k]) k = i + 1;   // necessarily i < n - 1 in this case
    nc[i] = k;
  }
  pp.lon = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    ct[0] = ct[1] = ct[2] = ct[3] = 0;
    let dir = Math.trunc((3 + 3 * (px[mod(i + 1, n)] - px[i]) + (py[mod(i + 1, n)] - py[i])) / 2);
    ct[dir]++;
    let c0x = 0, c0y = 0, c1x = 0, c1y = 0;
    k = nc[i]; let k1 = i;
    let found = false;
    for (;;) {
      dir = Math.trunc((3 + 3 * sign(px[k] - px[k1]) + sign(py[k] - py[k1])) / 2);
      ct[dir]++;
      if (ct[0] && ct[1] && ct[2] && ct[3]) { pivk[i] = k1; found = true; break; }   // all four directions: cut
      const curx = px[k] - px[i], cury = py[k] - py[i];
      if (xprod(c0x, c0y, curx, cury) < 0 || xprod(c1x, c1y, curx, cury) > 0) break;   // constraint_viol
      if (Math.abs(curx) <= 1 && Math.abs(cury) <= 1) { /* no constraint */ }
      else {
        let offx = curx + ((cury >= 0 && (cury > 0 || curx < 0)) ? 1 : -1);
        let offy = cury + ((curx <= 0 && (curx < 0 || cury < 0)) ? 1 : -1);
        if (xprod(c0x, c0y, offx, offy) >= 0) { c0x = offx; c0y = offy; }
        offx = curx + ((cury <= 0 && (cury < 0 || curx < 0)) ? 1 : -1);
        offy = cury + ((curx >= 0 && (curx > 0 || cury < 0)) ? 1 : -1);
        if (xprod(c1x, c1y, offx, offy) <= 0) { c1x = offx; c1y = offy; }
      }
      k1 = k; k = nc[k1];
      if (!cyclic(k, i, k1)) break;
    }
    if (found) continue;
    // constraint_viol: k1 was the last corner satisfying the constraint, k the first violating it
    const dkx = sign(px[k] - px[k1]), dky = sign(py[k] - py[k1]);
    const curx = px[k1] - px[i], cury = py[k1] - py[i];
    const a = xprod(c0x, c0y, curx, cury), b = xprod(c0x, c0y, dkx, dky), c = xprod(c1x, c1y, curx, cury), d = xprod(c1x, c1y, dkx, dky);
    let j = INFTY;
    if (b < 0) j = floordiv(a, -b);
    if (d > 0) j = Math.min(j, floordiv(-c, d));
    pivk[i] = mod(k1 + j, n);
  }
  // lon[i]: the largest k such that for all i' with i <= i' < k, i' < k <= pivk[i']
  let j = pivk[n - 1];
  pp.lon[n - 1] = j;
  for (let i = n - 2; i >= 0; i--) { if (cyclic(i + 1, pivk[i], j)) j = pivk[i]; pp.lon[i] = j; }
  for (let i = n - 1; cyclic(mod(i + 1, n), j, pp.lon[i]); i--) pp.lon[i] = j;
}
/** penalty3: the penalty of an edge from i to j (0 <= i < j <= n). */
function penalty3(pp: PrivPath, i: number, j: number): number {
  const n = pp.len, px = pp.ptx, py = pp.pty, sums = pp.sums;
  let r = 0;
  if (j >= n) { j -= n; r = 1; }
  let x: number, y: number, x2: number, xy: number, y2: number, k: number;
  if (r === 0) {
    x = sums[j + 1].x - sums[i].x; y = sums[j + 1].y - sums[i].y;
    x2 = sums[j + 1].x2 - sums[i].x2; xy = sums[j + 1].xy - sums[i].xy; y2 = sums[j + 1].y2 - sums[i].y2;
    k = j + 1 - i;
  } else {
    x = sums[j + 1].x - sums[i].x + sums[n].x; y = sums[j + 1].y - sums[i].y + sums[n].y;
    x2 = sums[j + 1].x2 - sums[i].x2 + sums[n].x2; xy = sums[j + 1].xy - sums[i].xy + sums[n].xy; y2 = sums[j + 1].y2 - sums[i].y2 + sums[n].y2;
    k = j + 1 - i + n;
  }
  const ppx = (px[i] + px[j]) / 2.0 - px[0], ppy = (py[i] + py[j]) / 2.0 - py[0];
  const ey = px[j] - px[i], ex = -(py[j] - py[i]);
  const a = (x2 - 2 * x * ppx) / k + ppx * ppx;
  const b = (xy - x * ppy - y * ppx) / k + ppx * ppy;
  const c = (y2 - 2 * y * ppy) / k + ppy * ppy;
  const s = ex * ex * a + 2 * ex * ey * b + ey * ey * c;
  return Math.sqrt(s);
}
/** bestpolygon: stage 2, the optimal polygon (Sec. 2.2.2 - 2.2.4); fills m and po. */
function bestpolygon(pp: PrivPath): void {
  const n = pp.len;
  const pen = new Array<number>(n + 1).fill(0), prev = new Array<number>(n + 1).fill(0), clip0 = new Array<number>(n).fill(0), clip1 = new Array<number>(n + 1).fill(0);
  const seg0 = new Array<number>(n + 1).fill(0), seg1 = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) {   // clipped paths
    let c = mod(pp.lon[mod(i - 1, n)] - 1, n);
    if (c === i) c = mod(i + 1, n);
    clip0[i] = c < i ? n : c;
  }
  let j = 1;
  for (let i = 0; i < n; i++) while (j <= clip0[i]) { clip1[j] = i; j++; }
  let i = 0;
  for (j = 0; i < n; j++) { seg0[j] = i; i = clip0[i]; }
  seg0[j] = n;
  const m = j;
  i = n;
  for (j = m; j > 0; j--) { seg1[j] = i; i = clip1[i]; }
  seg1[0] = 0;
  pen[0] = 0;
  for (j = 1; j <= m; j++) {
    for (i = seg1[j]; i <= seg0[j]; i++) {
      let best = -1;
      for (let k = seg0[j - 1]; k >= clip1[i]; k--) {
        const thispen = penalty3(pp, k, i) + pen[k];
        if (best < 0 || thispen < best) { prev[i] = k; best = thispen; }
      }
      pen[i] = best;
    }
  }
  pp.m = m;
  pp.po = new Array<number>(m).fill(0);
  for (i = n, j = m - 1; i > 0; j--) { i = prev[i]; pp.po[j] = i; }
}
/** adjust_vertices: stage 3 (Sec. 2.3.1), each vertex at the best point of its unit square. */
function adjustVertices(pp: PrivPath): void {
  const m = pp.m, po = pp.po, n = pp.len, px = pp.ptx, py = pp.pty, x0 = pp.x0, y0 = pp.y0;
  const ctr: DPoint[] = [], dir: DPoint[] = [], q: Quadform[] = [];
  for (let i = 0; i < m; i++) { ctr.push(dp(0, 0)); dir.push(dp(0, 0)); q.push([[0, 0, 0], [0, 0, 0], [0, 0, 0]]); }
  pp.curve = privcurveInit(m);
  const v = [0, 0, 0];
  for (let i = 0; i < m; i++) {
    let j = po[mod(i + 1, m)];
    j = mod(j - po[i], n) + po[i];
    pointslope(pp, po[i], j, ctr[i], dir[i]);
  }
  for (let i = 0; i < m; i++) {
    const d = sq(dir[i].x) + sq(dir[i].y);
    if (d === 0.0) { for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) q[i][j][k] = 0; }
    else {
      v[0] = dir[i].y; v[1] = -dir[i].x; v[2] = -v[1] * ctr[i].y - v[0] * ctr[i].x;
      for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) q[i][l][k] = v[l] * v[k] / d;
    }
  }
  for (let i = 0; i < m; i++) {
    const Q: Quadform = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const w = dp(0, 0);
    const s = dp(px[po[i]] - x0, py[po[i]] - y0);   // the vertex, relative to x0 / y0
    const j = mod(i - 1, m);
    for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) Q[l][k] = q[j][l][k] + q[i][l][k];
    for (;;) {
      const det = Q[0][0] * Q[1][1] - Q[0][1] * Q[1][0];
      if (det !== 0.0) {
        w.x = (-Q[0][2] * Q[1][1] + Q[1][2] * Q[0][1]) / det;
        w.y = (Q[0][2] * Q[1][0] - Q[1][2] * Q[0][0]) / det;
        break;
      }
      // singular: the lines are parallel; add an orthogonal axis through the centre of the unit square
      if (Q[0][0] > Q[1][1]) { v[0] = -Q[0][1]; v[1] = Q[0][0]; }
      else if (Q[1][1]) { v[0] = -Q[1][1]; v[1] = Q[1][0]; }
      else { v[0] = 1; v[1] = 0; }
      const d = sq(v[0]) + sq(v[1]);
      v[2] = -v[1] * s.y - v[0] * s.x;
      for (let l = 0; l < 3; l++) for (let k = 0; k < 3; k++) Q[l][k] += v[l] * v[k] / d;
    }
    let dx = Math.abs(w.x - s.x), dy = Math.abs(w.y - s.y);
    if (dx <= 0.5 && dy <= 0.5) { pp.curve.vertex[i].x = w.x + x0; pp.curve.vertex[i].y = w.y + y0; continue; }
    // the minimum is not in the unit square: minimise on its boundary
    let min = quadform(Q, s), xmin = s.x, ymin = s.y;
    if (Q[0][0] !== 0.0) {
      for (let z = 0; z < 2; z++) {
        w.y = s.y - 0.5 + z;
        w.x = -(Q[0][1] * w.y + Q[0][2]) / Q[0][0];
        dx = Math.abs(w.x - s.x);
        const cand = quadform(Q, w);
        if (dx <= 0.5 && cand < min) { min = cand; xmin = w.x; ymin = w.y; }
      }
    }
    if (Q[1][1] !== 0.0) {   // fixx
      for (let z = 0; z < 2; z++) {
        w.x = s.x - 0.5 + z;
        w.y = -(Q[1][0] * w.x + Q[1][2]) / Q[1][1];
        dy = Math.abs(w.y - s.y);
        const cand = quadform(Q, w);
        if (dy <= 0.5 && cand < min) { min = cand; xmin = w.x; ymin = w.y; }
      }
    }
    for (let l = 0; l < 2; l++) for (let k = 0; k < 2; k++) {   // corners
      w.x = s.x - 0.5 + l; w.y = s.y - 0.5 + k;
      const cand = quadform(Q, w);
      if (cand < min) { min = cand; xmin = w.x; ymin = w.y; }
    }
    pp.curve.vertex[i].x = xmin + x0; pp.curve.vertex[i].y = ymin + y0;
  }
}
/** reverse: the orientation of a path reversed. */
function reverse(curve: PrivCurve): void {
  const m = curve.n;
  for (let i = 0, j = m - 1; i < j; i++, j--) { const tmp = curve.vertex[i]; curve.vertex[i] = curve.vertex[j]; curve.vertex[j] = tmp; }
}
/** smooth: stage 4 (Sec. 2.3.3), corners and curves. */
function smooth(curve: PrivCurve, alphamax: number): void {
  const m = curve.n;
  for (let i = 0; i < m; i++) {
    const j = mod(i + 1, m), k = mod(i + 2, m);
    const p4 = interval(1 / 2.0, curve.vertex[k], curve.vertex[j]);
    const denom = ddenom(curve.vertex[i], curve.vertex[k]);
    let alpha: number;
    if (denom !== 0.0) {
      let dd = dpara(curve.vertex[i], curve.vertex[j], curve.vertex[k]) / denom;
      dd = Math.abs(dd);
      alpha = dd > 1 ? (1 - 1.0 / dd) : 0;
      alpha = alpha / 0.75;
    } else alpha = 4 / 3.0;
    curve.alpha0[j] = alpha;   // the "original" value of alpha
    if (alpha >= alphamax) {   // pointed corner
      curve.tag[j] = CORNER;
      curve.c[j][1] = curve.vertex[j];
      curve.c[j][2] = p4;
    } else {
      if (alpha < 0.55) alpha = 0.55;
      else if (alpha > 1) alpha = 1;
      const p2 = interval(0.5 + 0.5 * alpha, curve.vertex[i], curve.vertex[j]);
      const p3 = interval(0.5 + 0.5 * alpha, curve.vertex[k], curve.vertex[j]);
      curve.tag[j] = CURVETO;
      curve.c[j][0] = p2; curve.c[j][1] = p3; curve.c[j][2] = p4;
    }
    curve.alpha[j] = alpha;   // the "cropped" value of alpha
    curve.beta[j] = 0.5;
  }
  curve.alphacurve = 1;
}
interface Opti { pen: number; c: [DPoint, DPoint]; t: number; s: number; alpha: number }
/** opti_penalty: the best fit from i + .5 to j + .5 (i < j cyclically); null when impossible. */
function optiPenalty(pp: PrivPath, i: number, j: number, opttolerance: number, convc: number[], areac: number[]): Opti | null {
  const m = pp.curve.n, cv = pp.curve.vertex, cc = pp.curve.c;
  if (i === j) return null;   // a full loop can never be an opticurve
  let k = i;
  const i1 = mod(i + 1, m);
  let k1 = mod(k + 1, m);
  const conv = convc[k1];
  if (conv === 0) return null;
  let d = ddist(cv[i], cv[i1]);
  for (k = k1; k !== j; k = k1) {
    k1 = mod(k + 1, m);
    const k2 = mod(k + 2, m);
    if (convc[k1] !== conv) return null;
    if (sign(cprod(cv[i], cv[i1], cv[k1], cv[k2])) !== conv) return null;
    if (iprod1(cv[i], cv[i1], cv[k1], cv[k2]) < d * ddist(cv[k1], cv[k2]) * COS179) return null;
  }
  // the curve we are working in
  const p0 = cc[mod(i, m)][2];
  let p1 = cv[mod(i + 1, m)];
  let p2 = cv[mod(j, m)];
  const p3 = cc[mod(j, m)][2];
  // its area
  let area = areac[j] - areac[i];
  area -= dpara(cv[0], cc[i][2], cc[j][2]) / 2;
  if (i >= j) area += areac[m];
  const A1 = dpara(p0, p1, p2), A2 = dpara(p0, p1, p3), A3 = dpara(p0, p2, p3);
  const A4 = A1 + A3 - A2;
  if (A2 === A1) return null;   // this should never happen
  let t = A3 / (A3 - A4);
  const s = A2 / (A2 - A1);
  const A = A2 * t / 2.0;
  if (A === 0.0) return null;   // this should never happen
  const R = area / A;   // relative area
  const alpha = 2 - Math.sqrt(4 - R / 0.3);   // overall alpha for the p0-o-p3 curve
  const res: Opti = { pen: 0, c: [interval(t * alpha, p0, p1), interval(s * alpha, p3, p2)], alpha, t, s };
  p1 = res.c[0]; p2 = res.c[1];   // the proposed curve is now (p0, p1, p2, p3)
  // tangency with the edges
  for (k = mod(i + 1, m); k !== j; k = k1) {
    k1 = mod(k + 1, m);
    t = tangent(p0, p1, p2, p3, cv[k], cv[k1]);
    if (t < -0.5) return null;
    const pt = bezier(t, p0, p1, p2, p3);
    d = ddist(cv[k], cv[k1]);
    if (d === 0.0) return null;   // this should never happen
    const d1 = dpara(cv[k], cv[k1], pt) / d;
    if (Math.abs(d1) > opttolerance) return null;
    if (iprod(cv[k], cv[k1], pt) < 0 || iprod(cv[k1], cv[k], pt) < 0) return null;
    res.pen += sq(d1);
  }
  // the corners
  for (k = i; k !== j; k = k1) {
    k1 = mod(k + 1, m);
    t = tangent(p0, p1, p2, p3, cc[k][2], cc[k1][2]);
    if (t < -0.5) return null;
    const pt = bezier(t, p0, p1, p2, p3);
    d = ddist(cc[k][2], cc[k1][2]);
    if (d === 0.0) return null;   // this should never happen
    let d1 = dpara(cc[k][2], cc[k1][2], pt) / d;
    let d2 = dpara(cc[k][2], cc[k1][2], cv[k1]) / d;
    d2 *= 0.75 * pp.curve.alpha[k1];
    if (d2 < 0) { d1 = -d1; d2 = -d2; }
    if (d1 < d2 - opttolerance) return null;
    if (d1 < d2) res.pen += sq(d1 - d2);
  }
  return res;
}
/** opticurve: stage 5 (Sec. 2.4), runs of Bezier segments replaced by one where possible. */
function opticurve(pp: PrivPath, opttolerance: number): void {
  const m = pp.curve.n, cur = pp.curve;
  const pt = new Array<number>(m + 1).fill(0), pen = new Array<number>(m + 1).fill(0), len = new Array<number>(m + 1).fill(0);
  const opt: (Opti | null)[] = new Array(m + 1).fill(null);
  const convc = new Array<number>(m).fill(0), areac = new Array<number>(m + 1).fill(0);
  for (let i = 0; i < m; i++) {   // convexity: +1 right turn, -1 left turn, 0 corner
    convc[i] = cur.tag[i] === CURVETO ? sign(dpara(cur.vertex[mod(i - 1, m)], cur.vertex[i], cur.vertex[mod(i + 1, m)])) : 0;
  }
  let area = 0.0;
  areac[0] = 0.0;
  const p0 = cur.vertex[0];
  for (let i = 0; i < m; i++) {
    const i1 = mod(i + 1, m);
    if (cur.tag[i1] === CURVETO) {
      const alpha = cur.alpha[i1];
      area += 0.3 * alpha * (4 - alpha) * dpara(cur.c[i][2], cur.vertex[i1], cur.c[i1][2]) / 2;
      area += dpara(p0, cur.c[i][2], cur.c[i1][2]) / 2;
    }
    areac[i + 1] = area;
  }
  pt[0] = -1; pen[0] = 0; len[0] = 0;
  for (let j = 1; j <= m; j++) {
    pt[j] = j - 1; pen[j] = pen[j - 1]; len[j] = len[j - 1] + 1;
    for (let i = j - 2; i >= 0; i--) {
      const o = optiPenalty(pp, i, mod(j, m), opttolerance, convc, areac);
      if (!o) break;
      if (len[j] > len[i] + 1 || (len[j] === len[i] + 1 && pen[j] > pen[i] + o.pen)) {
        pt[j] = i; pen[j] = pen[i] + o.pen; len[j] = len[i] + 1;
        opt[j] = { pen: o.pen, c: [o.c[0], o.c[1]], t: o.t, s: o.s, alpha: o.alpha };
      }
    }
  }
  const om = len[m];
  const oc = privcurveInit(om);
  const s = new Array<number>(om).fill(0), t = new Array<number>(om).fill(0);
  let j = m;
  for (let i = om - 1; i >= 0; i--) {
    if (pt[j] === j - 1) {
      const jm = mod(j, m);
      oc.tag[i] = cur.tag[jm];
      oc.c[i][0] = cur.c[jm][0]; oc.c[i][1] = cur.c[jm][1]; oc.c[i][2] = cur.c[jm][2];
      oc.vertex[i] = cur.vertex[jm];
      oc.alpha[i] = cur.alpha[jm]; oc.alpha0[i] = cur.alpha0[jm]; oc.beta[i] = cur.beta[jm];
      s[i] = t[i] = 1.0;
    } else {
      const jm = mod(j, m), o = opt[j]!;
      oc.tag[i] = CURVETO;
      oc.c[i][0] = o.c[0]; oc.c[i][1] = o.c[1]; oc.c[i][2] = cur.c[jm][2];
      oc.vertex[i] = interval(o.s, cur.c[jm][2], cur.vertex[jm]);
      oc.alpha[i] = o.alpha; oc.alpha0[i] = o.alpha;
      s[i] = o.s; t[i] = o.t;
    }
    j = pt[j];
  }
  for (let i = 0; i < om; i++) { const i1 = mod(i + 1, om); oc.beta[i] = s[i] / (s[i] + t[i1]); }
  oc.alphacurve = 1;
  pp.ocurve = oc;
}
/** process_path: every path through the stages, its final curve in path.curve. */
function processPath(plist: PotracePath | null, param: PotraceParam): void {
  for (let p = plist; p; p = p.next) {
    const pp = p.priv;
    calcSums(pp);
    calcLon(pp);
    bestpolygon(pp);
    adjustVertices(pp);
    if (p.sign === "-") reverse(pp.curve);   // reverse the orientation of negative paths
    smooth(pp.curve, param.alphamax);
    if (param.opticurve) { opticurve(pp, param.opttolerance); pp.fcurve = pp.ocurve; }
    else pp.fcurve = pp.curve;
    p.curve = { n: pp.fcurve.n, tag: pp.fcurve.tag, c: pp.fcurve.c };   // privcurve_to_curve
  }
}

// ---------------------------------------------------------------- potracelib.cpp
/** potrace_param_default. */
export function potraceParamDefault(): PotraceParam { return { turdsize: 2, turnpolicy: TURNPOLICY_MINORITY, alphamax: 1.0, opticurve: 1, opttolerance: 0.2 }; }
/** potrace_trace: the bitmap's paths with their curves. */
export function potraceTrace(param: PotraceParam, bm: PotraceBitmap): PotraceState {
  const plist = bmToPathlist(bm, param);
  processPath(plist, param);
  return { status: STATUS_OK, plist };
}
