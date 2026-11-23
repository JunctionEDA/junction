// pcb-tools/planegcs.ts — the part of planegcs (FreeCAD's 2D geometric constraint solver, LGPL-2.1-or-later, vendored
// by KiCad as thirdparty/planegcs) that pcbnew's constraint adapter uses, ported to TypeScript.  The structure follows
// the C++ one to one: Geo (DeriVector2, Point, Line, Circle, Arc, Ellipse, ArcOfEllipse), Constraints (the classes the
// adapter's addConstraint* calls create), SubSystem, System (initSolution, solve: DogLeg and the two-subsystem SQP,
// applySolution, diagnose with the dense full-pivoting QR, the conflicting / redundant identification) and qp_eq.
// The Eigen decompositions used (FullPivLU, FullPivHouseholderQR, ColPivHouseholderQR) are ported from Eigen 3.4 with
// their pivot order and thresholds.  KiCad's four patches (README.kicad.md) are carried: unknowns in declared order,
// the BFGS matrix seeded with the soft subsystem's Gauss-Newton curvature, the solve stopped on a non-finite
// derivative, and mu left unchanged on a feasible iterate.
//
// A C++ `double*` parameter is a Param here: a boxed value with a creation serial standing in for its address where the
// C++ orders by address (std::set<double*>, std::map<Constraint*, …>).

let paramSerial = 0;
/** One solver unknown or constant (planegcs's double*). */
export class Param { v: number; readonly id: number; constructor(v = 0) { this.v = v; this.id = ++paramSerial; } }
const byId = (a: { id: number }, b: { id: number }): number => a.id - b.id;

// ---------------------------------------------------------------- dense matrices (column-major, like Eigen)

/** A dense rows x cols matrix stored column-major. */
export class Mat {
  r: number; c: number; d: Float64Array;
  constructor(r: number, c: number, d?: Float64Array) { this.r = r; this.c = c; this.d = d || new Float64Array(r * c); }
  get(i: number, j: number): number { return this.d[i + j * this.r]; }
  set(i: number, j: number, v: number): void { this.d[i + j * this.r] = v; }
  add(i: number, j: number, v: number): void { this.d[i + j * this.r] += v; }
  clone(): Mat { return new Mat(this.r, this.c, new Float64Array(this.d)); }
  static identity(n: number): Mat { const m = new Mat(n, n); for (let i = 0; i < n; i++) m.set(i, i, 1); return m; }
  transpose(): Mat { const t = new Mat(this.c, this.r); for (let j = 0; j < this.c; j++) for (let i = 0; i < this.r; i++) t.set(j, i, this.get(i, j)); return t; }
  mul(b: Mat): Mat {
    const o = new Mat(this.r, b.c);
    for (let j = 0; j < b.c; j++) for (let k = 0; k < this.c; k++) { const bk = b.get(k, j); for (let i = 0; i < this.r; i++) o.d[i + j * o.r] += this.d[i + k * this.r] * bk; }
    return o;
  }
  mulv(v: Float64Array): Float64Array { const o = new Float64Array(this.r); for (let k = 0; k < this.c; k++) { const vk = v[k]; for (let i = 0; i < this.r; i++) o[i] += this.d[i + k * this.r] * vk; } return o; }
  /** this^T * v */
  tmulv(v: Float64Array): Float64Array { const o = new Float64Array(this.c); for (let j = 0; j < this.c; j++) { let s = 0; for (let i = 0; i < this.r; i++) s += this.d[i + j * this.r] * v[i]; o[j] = s; } return o; }
  allFinite(): boolean { for (let i = 0; i < this.d.length; i++) if (!Number.isFinite(this.d[i])) return false; return true; }
}
type Vec = Float64Array;
const vnorm = (v: Vec): number => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s); };
const vsq = (v: Vec): number => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return s; };
const vdot = (a: Vec, b: Vec): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const vinf = (v: Vec): number => { let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i])); return m; };
const vl1 = (v: Vec): number => { let m = 0; for (let i = 0; i < v.length; i++) m += Math.abs(v[i]); return m; };
const vfinite = (v: Vec): boolean => { for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false; return true; };
const EPS = 2.220446049250313e-16;
const DBL_MIN = 2.2250738585072014e-308;

/** Eigen makeHouseholder on m(k.., col) in place: returns [tau, beta], the essential part left below the head. */
function makeHouseholderInPlace(m: Mat, k: number, col: number): [number, number] {
  const rows = m.r, base = col * rows;
  let tailSqNorm = 0;
  for (let i = k + 1; i < rows; i++) tailSqNorm += m.d[base + i] * m.d[base + i];
  const c0 = m.d[base + k];
  if (tailSqNorm <= DBL_MIN) { for (let i = k + 1; i < rows; i++) m.d[base + i] = 0; return [0, c0]; }
  let beta = Math.sqrt(c0 * c0 + tailSqNorm);
  if (c0 >= 0) beta = -beta;
  const div = c0 - beta;
  for (let i = k + 1; i < rows; i++) m.d[base + i] /= div;
  return [(beta - c0) / beta, beta];
}
/** Eigen applyHouseholderOnTheLeft: block rows [r0, r1) x cols [c0, c1) of `t` by the reflector whose essential part is
 * ess(e0.., ecol) (length r1 - r0 - 1). */
function applyHouseholderLeft(t: Mat, r0: number, r1: number, c0: number, c1: number, ess: Mat, e0: number, ecol: number, tau: number): void {
  const nrows = r1 - r0;
  if (nrows === 1) { const f = 1 - tau; for (let j = c0; j < c1; j++) t.d[r0 + j * t.r] *= f; return; }
  if (tau === 0) return;
  for (let j = c0; j < c1; j++) {
    const cb = j * t.r;
    let tmp = 0;
    for (let i = 1; i < nrows; i++) tmp += ess.d[e0 + i - 1 + ecol * ess.r] * t.d[cb + r0 + i];
    tmp += t.d[cb + r0];
    t.d[cb + r0] -= tau * tmp;
    for (let i = 1; i < nrows; i++) t.d[cb + r0 + i] -= tau * ess.d[e0 + i - 1 + ecol * ess.r] * tmp;
  }
}
/** The first maximum of |m(i,j)| over rows >= k, cols >= k, scanned column-major (Eigen's maxCoeff visitor). */
function maxAbsCorner(m: Mat, k: number): [number, number, number] {
  let best = -1, bi = k, bj = k;
  for (let j = k; j < m.c; j++) for (let i = k; i < m.r; i++) { const v = Math.abs(m.d[i + j * m.r]); if (best < 0 ? true : v > best) { best = v; bi = i; bj = j; } }
  return [best < 0 ? 0 : best, bi, bj];
}
function swapRows(m: Mat, a: number, b: number, fromCol = 0): void { for (let j = fromCol; j < m.c; j++) { const t = m.d[a + j * m.r]; m.d[a + j * m.r] = m.d[b + j * m.r]; m.d[b + j * m.r] = t; } }
function swapCols(m: Mat, a: number, b: number): void { for (let i = 0; i < m.r; i++) { const t = m.d[i + a * m.r]; m.d[i + a * m.r] = m.d[i + b * m.r]; m.d[i + b * m.r] = t; } }
function permIndices(n: number, transpositions: Int32Array, size: number): Int32Array {
  const idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
  for (let k = 0; k < size; k++) { const o = transpositions[k]; const t = idx[k]; idx[k] = idx[o]; idx[o] = t; }
  return idx;
}

/** Eigen::FullPivLU (3.4): compute and solve. */
export function fullPivLuSolve(a: Mat, rhs: Vec): Vec {
  const lu = a.clone(), rows = lu.r, cols = lu.c, size = Math.min(rows, cols);
  const rowT = new Int32Array(size), colT = new Int32Array(size);
  let nonzero = size, maxpivot = 0;
  for (let k = 0; k < size; k++) {
    const [big, ri, ci] = maxAbsCorner(lu, k);
    if (big === 0) { nonzero = k; for (let i = k; i < size; i++) { rowT[i] = i; colT[i] = i; } break; }
    if (big > maxpivot) maxpivot = big;
    rowT[k] = ri; colT[k] = ci;
    if (k !== ri) swapRows(lu, k, ri);
    if (k !== ci) swapCols(lu, k, ci);
    const piv = lu.get(k, k);
    if (k < rows - 1) for (let i = k + 1; i < rows; i++) lu.d[i + k * rows] /= piv;
    if (k < size - 1) for (let j = k + 1; j < cols; j++) { const rkj = lu.d[k + j * rows]; for (let i = k + 1; i < rows; i++) lu.d[i + j * rows] -= lu.d[i + k * rows] * rkj; }
  }
  // rank(): pivots above maxpivot * epsilon * diagonalSize
  const thr = Math.abs(maxpivot) * EPS * size;
  let rank = 0; for (let i = 0; i < nonzero; i++) if (Math.abs(lu.get(i, i)) > thr) rank++;
  const dst = new Float64Array(cols);
  if (rank === 0) return dst;
  const c = new Float64Array(rhs);
  for (let k = 0; k < size; k++) { const o = rowT[k]; if (o !== k) { const t = c[k]; c[k] = c[o]; c[o] = t; } }
  // unit lower solve on the top smalldim rows
  for (let i = 0; i < size; i++) for (let k = 0; k < i; k++) c[i] -= lu.get(i, k) * c[k];
  if (rows > cols) for (let i = cols; i < rows; i++) { let s = 0; for (let k = 0; k < cols; k++) s += lu.get(i, k) * c[k]; c[i] -= s; }
  for (let i = rank - 1; i >= 0; i--) { let s = c[i]; for (let k = i + 1; k < rank; k++) s -= lu.get(i, k) * c[k]; c[i] = s / lu.get(i, i); }
  const q = permIndices(cols, colT, size);
  for (let i = 0; i < rank; i++) dst[q[i]] = c[i];
  for (let i = rank; i < cols; i++) dst[q[i]] = 0;
  return dst;
}

/** Eigen::FullPivHouseholderQR (3.4). */
export class FullPivHouseholderQR {
  qr: Mat; hCoeffs: Float64Array; rowsT: Int32Array; colsT: Int32Array; nonzero: number; maxpivot = 0; colsPerm: Int32Array;
  threshold: number | null = null;
  constructor(a: Mat) {
    const qr = this.qr = a.clone(), rows = qr.r, cols = qr.c, size = Math.min(rows, cols);
    this.hCoeffs = new Float64Array(size); this.rowsT = new Int32Array(size); this.colsT = new Int32Array(size);
    const precision = EPS * size;
    let biggest = 0; this.nonzero = size;
    for (let k = 0; k < size; k++) {
      const [big, ri, ci] = maxAbsCorner(qr, k);
      if (k === 0) biggest = big;
      if (Math.abs(big) <= Math.abs(biggest) * precision) {
        this.nonzero = k;
        for (let i = k; i < size; i++) { this.rowsT[i] = i; this.colsT[i] = i; this.hCoeffs[i] = 0; }
        break;
      }
      this.rowsT[k] = ri; this.colsT[k] = ci;
      if (k !== ri) swapRows(qr, k, ri, k);
      if (k !== ci) swapCols(qr, k, ci);
      const [tau, beta] = makeHouseholderInPlace(qr, k, k);
      this.hCoeffs[k] = tau; qr.set(k, k, beta);
      if (Math.abs(beta) > this.maxpivot) this.maxpivot = Math.abs(beta);
      applyHouseholderLeft(qr, k, rows, k + 1, cols, qr, k + 1, k, tau);
    }
    this.colsPerm = permIndices(cols, this.colsT, size);
  }
  rows(): number { return this.qr.r; }
  cols(): number { return this.qr.c; }
  rank(): number {
    const thr = Math.abs(this.maxpivot) * (this.threshold !== null ? this.threshold : EPS * Math.min(this.qr.r, this.qr.c));
    let r = 0; for (let i = 0; i < this.nonzero; i++) if (Math.abs(this.qr.get(i, i)) > thr) r++;
    return r;
  }
  matrixQ(): Mat {
    const rows = this.qr.r, size = Math.min(rows, this.qr.c), res = Mat.identity(rows);
    for (let k = size - 1; k >= 0; k--) {
      applyHouseholderLeft(res, k, rows, k, rows, this.qr, k + 1, k, this.hCoeffs[k]);
      if (this.rowsT[k] !== k) swapRows(res, k, this.rowsT[k]);
    }
    return res;
  }
}

/** Eigen::ColPivHouseholderQR(a).solve(b) (3.4). */
export function colPivHouseholderQrSolve(a: Mat, b: Vec): Vec {
  const qr = a.clone(), rows = qr.r, cols = qr.c, size = Math.min(rows, cols);
  const h = new Float64Array(size), colT = new Int32Array(cols);
  const normsU = new Float64Array(cols), normsD = new Float64Array(cols);
  for (let k = 0; k < cols; k++) { let s = 0; for (let i = 0; i < rows; i++) s += qr.get(i, k) ** 2; normsD[k] = Math.sqrt(s); normsU[k] = normsD[k]; }
  let maxNorm = 0; for (let k = 0; k < cols; k++) maxNorm = Math.max(maxNorm, normsU[k]);
  const thresholdHelper = (maxNorm * EPS) ** 2 / rows;
  const downdate = Math.sqrt(EPS);
  let nonzero = size;
  for (let k = 0; k < size; k++) {
    let bi = k, bv = normsU[k]; for (let j = k + 1; j < cols; j++) if (normsU[j] > bv) { bv = normsU[j]; bi = j; }
    if (nonzero === size && bv * bv < thresholdHelper * (rows - k)) nonzero = k;
    colT[k] = bi;
    if (k !== bi) { swapCols(qr, k, bi); let t = normsU[k]; normsU[k] = normsU[bi]; normsU[bi] = t; t = normsD[k]; normsD[k] = normsD[bi]; normsD[bi] = t; }
    const [tau, beta] = makeHouseholderInPlace(qr, k, k);
    h[k] = tau; qr.set(k, k, beta);
    applyHouseholderLeft(qr, k, rows, k + 1, cols, qr, k + 1, k, tau);
    for (let j = k + 1; j < cols; j++) {
      if (normsU[j] !== 0) {
        let temp = Math.abs(qr.get(k, j)) / normsU[j];
        temp = (1 + temp) * (1 - temp); if (temp < 0) temp = 0;
        const temp2 = temp * (normsU[j] / normsD[j]) ** 2;
        if (temp2 <= downdate) { let s = 0; for (let i = k + 1; i < rows; i++) s += qr.get(i, j) ** 2; normsD[j] = Math.sqrt(s); normsU[j] = normsD[j]; }
        else normsU[j] *= Math.sqrt(temp);
      }
    }
  }
  const dst = new Float64Array(cols);
  if (nonzero === 0) return dst;
  const c = new Mat(rows, 1, new Float64Array(b));
  for (let k = 0; k < nonzero; k++) applyHouseholderLeft(c, k, rows, 0, 1, qr, k + 1, k, h[k]);
  for (let i = nonzero - 1; i >= 0; i--) { let s = c.d[i]; for (let k = i + 1; k < nonzero; k++) s -= qr.get(i, k) * c.d[k]; c.d[i] = s / qr.get(i, i); }
  const p = permIndices(cols, colT, size);
  for (let i = 0; i < nonzero; i++) dst[p[i]] = c.d[i];
  for (let i = nonzero; i < cols; i++) dst[p[i]] = 0;
  return dst;
}

/** qp_eq.cpp: minimizes 0.5 x^T H x + g^T x under A x + c = 0; the row space of A in Y, its null space in Z. */
export function qpEq(H: Mat, g: Vec, A: Mat, c: Vec): { status: number; x: Vec; Y: Mat; Z: Mat | null } {
  const qrAT = new FullPivHouseholderQR(A.transpose());
  const Q = qrAT.matrixQ();
  const paramsNum = qrAT.rows(), constrNum = qrAT.cols(), rank = qrAT.rank();
  const empty = { status: -1, x: new Float64Array(paramsNum), Y: new Mat(0, 0), Z: null };
  if (rank !== constrNum || constrNum > paramsNum) return empty;
  // X * R1^T = Q1  (R1 upper: R1^T lower), then Y = X * P^T
  const X = new Mat(paramsNum, constrNum);
  for (let row = 0; row < paramsNum; row++) {
    // solve x * L = q (L = R1^T lower triangular): back to front over columns
    for (let j = constrNum - 1; j >= 0; j--) {
      let s = Q.get(row, j);
      for (let k = j + 1; k < constrNum; k++) s -= X.get(row, k) * qrAT.qr.get(j, k);   // L(k, j) = R1(j, k)
      X.set(row, j, s / qrAT.qr.get(j, j));
    }
  }
  const Y = new Mat(paramsNum, constrNum);
  for (let i = 0; i < constrNum; i++) { const to = qrAT.colsPerm[i]; for (let r = 0; r < paramsNum; r++) Y.set(r, to, X.get(r, i)); }
  let x: Vec;
  let Z: Mat | null = null;
  const Yc = Y.mulv(c);
  if (paramsNum === rank) { x = new Float64Array(paramsNum); for (let i = 0; i < paramsNum; i++) x[i] = -Yc[i]; }
  else {
    Z = new Mat(paramsNum, paramsNum - rank);
    for (let j = 0; j < paramsNum - rank; j++) for (let i = 0; i < paramsNum; i++) Z.set(i, j, Q.get(i, rank + j));
    const ZTHZ = Z.transpose().mul(H).mul(Z);
    const HYc = H.mulv(Yc); const t = new Float64Array(paramsNum); for (let i = 0; i < paramsNum; i++) t[i] = HYc[i] - g[i];
    const rhs = Z.tmulv(t);
    const y = colPivHouseholderQrSolve(ZTHZ, rhs);
    const Zy = Z.mulv(y);
    x = new Float64Array(paramsNum); for (let i = 0; i < paramsNum; i++) x[i] = -Yc[i] + Zy[i];
  }
  return { status: 0, x, Y, Z };
}

// ---------------------------------------------------------------- Geo

/** A vector with its derivative along one parameter (Geo.h DeriVector2). */
export class DV {
  constructor(public x = 0, public y = 0, public dx = 0, public dy = 0) {}
  static of(p: Point, dp: Param | null): DV { return new DV(p.x.v, p.y.v, dp === p.x ? 1 : 0, dp === p.y ? 1 : 0); }
  length(): number { return Math.sqrt(this.x * this.x + this.y * this.y); }
  lengthD(): [number, number] { const l = this.length(); if (l === 0) return [l, 1]; return [l, (this.x * this.dx + this.y * this.dy) / l]; }
  getNormalized(): DV {
    const l = this.length(); if (l === 0) return new DV(0, 0, this.dx, this.dy);
    const r = new DV(this.x / l, this.y / l, this.dx / l, this.dy / l);
    const dsc = r.dx * r.x + r.dy * r.y; r.dx -= dsc * r.x; r.dy -= dsc * r.y; return r;
  }
  scalarProd(v: DV): [number, number] { return [this.x * v.x + this.y * v.y, this.dx * v.x + this.x * v.dx + this.dy * v.y + this.y * v.dy]; }
  sum(v: DV): DV { return new DV(this.x + v.x, this.y + v.y, this.dx + v.dx, this.dy + v.dy); }
  subtr(v: DV): DV { return new DV(this.x - v.x, this.y - v.y, this.dx - v.dx, this.dy - v.dy); }
  multD(val: number, dval: number): DV { return new DV(this.x * val, this.y * val, this.dx * val + this.x * dval, this.dy * val + this.y * dval); }
  rotate90ccw(): DV { return new DV(-this.y, this.x, -this.dy, this.dx); }
  linCombi(m1: number, v: DV, m2: number): DV { return new DV(this.x * m1 + v.x * m2, this.y * m1 + v.y * m2, this.dx * m1 + v.dx * m2, this.dy * m1 + v.dy * m2); }
}
export class Point { constructor(public x: Param, public y: Param) {} }
export interface Curve { push(pv: Param[]): void; reconstruct(pv: Param[], cnt: { i: number }): void; value(u: number, du: number, dp: Param | null): DV; copy(): Curve }
const recPoint = (pv: Param[], c: { i: number }): Point => new Point(pv[c.i++], pv[c.i++]);
export class Line implements Curve {
  constructor(public p1: Point, public p2: Point) {}
  push(pv: Param[]): void { pv.push(this.p1.x, this.p1.y, this.p2.x, this.p2.y); }
  reconstruct(pv: Param[], c: { i: number }): void { this.p1 = recPoint(pv, c); this.p2 = recPoint(pv, c); }
  calculateNormal(dp: Param | null): DV { return DV.of(this.p2, dp).subtr(DV.of(this.p1, dp)).rotate90ccw(); }
  value(u: number, du: number, dp: Param | null): DV { const p1 = DV.of(this.p1, dp); return p1.sum(DV.of(this.p2, dp).subtr(p1).multD(u, du)); }
  copy(): Line { return new Line(this.p1, this.p2); }
}
export class Circle implements Curve {
  constructor(public center: Point, public rad: Param) {}
  push(pv: Param[]): void { pv.push(this.center.x, this.center.y, this.rad); }
  reconstruct(pv: Param[], c: { i: number }): void { this.center = recPoint(pv, c); this.rad = pv[c.i++]; }
  value(u: number, du: number, dp: Param | null): DV {
    const cv = DV.of(this.center, dp), r = this.rad.v, dr = dp === this.rad ? 1 : 0;
    const ex = new DV(r, 0, dr, 0), ey = ex.rotate90ccw();
    const si = Math.sin(u), dsi = du * Math.cos(u), co = Math.cos(u), dco = du * -Math.sin(u);
    return cv.sum(ex.multD(co, dco).sum(ey.multD(si, dsi)));
  }
  copy(): Circle { return new Circle(this.center, this.rad); }
}
export class Arc extends Circle {
  constructor(center: Point, rad: Param, public start: Point, public end: Point, public startAngle: Param, public endAngle: Param) { super(center, rad); }
  override push(pv: Param[]): void { super.push(pv); pv.push(this.start.x, this.start.y, this.end.x, this.end.y, this.startAngle, this.endAngle); }
  override reconstruct(pv: Param[], c: { i: number }): void { super.reconstruct(pv, c); this.start = recPoint(pv, c); this.end = recPoint(pv, c); this.startAngle = pv[c.i++]; this.endAngle = pv[c.i++]; }
  override copy(): Arc { return new Arc(this.center, this.rad, this.start, this.end, this.startAngle, this.endAngle); }
}
export class Ellipse implements Curve {
  constructor(public center: Point, public focus1: Point, public radmin: Param) {}
  push(pv: Param[]): void { pv.push(this.center.x, this.center.y, this.focus1.x, this.focus1.y, this.radmin); }
  reconstruct(pv: Param[], c: { i: number }): void { this.center = recPoint(pv, c); this.focus1 = recPoint(pv, c); this.radmin = pv[c.i++]; }
  static radMaj(center: DV, f1: DV, b: number, db: number): [number, number] { const [cf, dcf] = f1.subtr(center).lengthD(); return new DV(b, cf, db, dcf).lengthD(); }
  value(u: number, du: number, dp: Param | null): DV {
    const c = DV.of(this.center, dp), f1 = DV.of(this.focus1, dp);
    const emaj = f1.subtr(c).getNormalized(), emin = emaj.rotate90ccw();
    const b = this.radmin.v, db = this.radmin === dp ? 1 : 0;
    const [a, da] = Ellipse.radMaj(c, f1, b, db);
    const av = emaj.multD(a, da), bv = emin.multD(b, db);
    const co = Math.cos(u), dco = -Math.sin(u) * du, si = Math.sin(u), dsi = Math.cos(u) * du;
    return av.multD(co, dco).sum(bv.multD(si, dsi)).sum(c);
  }
  copy(): Ellipse { return new Ellipse(this.center, this.focus1, this.radmin); }
}
export class ArcOfEllipse extends Ellipse {
  constructor(center: Point, focus1: Point, radmin: Param, public start: Point, public end: Point, public startAngle: Param, public endAngle: Param) { super(center, focus1, radmin); }
  override push(pv: Param[]): void { super.push(pv); pv.push(this.start.x, this.start.y, this.end.x, this.end.y, this.startAngle, this.endAngle); }
  override reconstruct(pv: Param[], c: { i: number }): void { super.reconstruct(pv, c); this.start = recPoint(pv, c); this.end = recPoint(pv, c); this.startAngle = pv[c.i++]; this.endAngle = pv[c.i++]; }
  override copy(): ArcOfEllipse { return new ArcOfEllipse(this.center, this.focus1, this.radmin, this.start, this.end, this.startAngle, this.endAngle); }
}

// ---------------------------------------------------------------- Constraints

let constraintSerial = 0;
export const enum CType { None = 0, Equal = 1, Other = 99 }
/** Constraints.h Constraint. */
export class Constraint {
  origpvec: Param[] = []; pvec: Param[] = []; scale = 1; tag = 0; driving = true; internalAlignment = false;
  readonly seq = ++constraintSerial;
  typeId(): CType { return CType.Other; }
  params(): Param[] { return this.pvec; }
  init(): void { this.origpvec = this.pvec.slice(); this.reconstructGeomPointers(); this.rescale(); }
  redirectParams(map: Map<Param, Param>): void { for (let i = 0; i < this.origpvec.length; i++) { const t = map.get(this.origpvec[i]); if (t) this.pvec[i] = t; } this.reconstructGeomPointers(); }
  revertParams(): void { this.pvec = this.origpvec.slice(); this.reconstructGeomPointers(); }
  rescale(coef = 1): void { this.scale = coef * 1.0; }
  reconstructGeomPointers(): void {}
  errorgrad(_dp: Param | null): [number, number] { return [0, 0]; }
  error(): number { return this.scale * this.errorgrad(null)[0]; }
  grad(p: Param): number { if (this.pvec.indexOf(p) < 0) return 0; return this.errorgrad(p)[1] * this.scale; }
  maxStep(_dir: Map<Param, number>, lim: number): number { return lim; }
  evaluate(): void {}
  protected q(i: number): number { return this.pvec[i].v; }
}
class CEqual extends Constraint {
  constructor(p1: Param, p2: Param, public ratio = 1) { super(); this.pvec.push(p1, p2); this.init(); }
  override typeId(): CType { return CType.Equal; }
  override error(): number { return this.scale * (this.q(0) - this.ratio * this.q(1)); }
  override grad(p: Param): number { let d = 0; if (p === this.pvec[0]) d += 1; if (p === this.pvec[1]) d += -1; return this.scale * d; }
  override evaluate(): void { this.pvec[1].v = this.q(0) / this.ratio; }
}
class CDifference extends Constraint {
  constructor(p1: Param, p2: Param, d: Param) { super(); this.pvec.push(p1, p2, d); this.init(); }
  value(): number { return this.q(1) - this.q(0); }
  override error(): number { return this.scale * (this.value() - this.q(2)); }
  override grad(p: Param): number { let d = 0; if (p === this.pvec[0]) d += -1; if (p === this.pvec[1]) d += 1; if (p === this.pvec[2]) d += -1; return this.scale * d; }
  override evaluate(): void { this.pvec[2].v = this.scale * this.value(); }
}
class CP2PDistance extends Constraint {
  constructor(p1: Point, p2: Point, d: Param) { super(); this.pvec.push(p1.x, p1.y, p2.x, p2.y, d); this.init(); }
  value(): number { const dx = this.q(0) - this.q(2), dy = this.q(1) - this.q(3); return Math.sqrt(dx * dx + dy * dy); }
  override error(): number { return this.scale * (this.value() - this.q(4)); }
  override grad(p: Param): number {
    const v = this.pvec; let deriv = 0;
    if (p === v[0] || p === v[1] || p === v[2] || p === v[3]) {
      const dx = this.q(0) - this.q(2), dy = this.q(1) - this.q(3), d = Math.sqrt(dx * dx + dy * dy);
      if (p === v[0]) deriv += dx / d; if (p === v[1]) deriv += dy / d; if (p === v[2]) deriv += -dx / d; if (p === v[3]) deriv += -dy / d;
    }
    if (p === v[4]) deriv += -1;
    return this.scale * deriv;
  }
  override maxStep(dir: Map<Param, number>, lim: number): number {
    const v = this.pvec; let it = dir.get(v[4]);
    if (it !== undefined && it < 0) lim = Math.min(lim, -this.q(4) / it);
    let ddx = 0, ddy = 0;
    it = dir.get(v[0]); if (it !== undefined) ddx += it; it = dir.get(v[1]); if (it !== undefined) ddy += it;
    it = dir.get(v[2]); if (it !== undefined) ddx -= it; it = dir.get(v[3]); if (it !== undefined) ddy -= it;
    const dd = Math.sqrt(ddx * ddx + ddy * ddy), dist = this.q(4);
    if (dd > dist) { const dx = this.q(0) - this.q(2), dy = this.q(1) - this.q(3), d = Math.sqrt(dx * dx + dy * dy); if (dd > d) lim = Math.min(lim, Math.max(d, dist) / dd); }
    return lim;
  }
  override evaluate(): void { this.pvec[4].v = this.value(); }
}
/** Shared by P2LDistance and PointOnLine: the signed distance of p0 from the line p1-p2 and its derivative. */
function lineDistGrad(v: Param[], q: (i: number) => number, p: Param): number {
  let deriv = 0;
  if (p === v[0] || p === v[1] || p === v[2] || p === v[3] || p === v[4] || p === v[5]) {
    const x0 = q(0), y0 = q(1), x1 = q(2), y1 = q(3), x2 = q(4), y2 = q(5);
    const dx = x2 - x1, dy = y2 - y1, d2 = dx * dx + dy * dy, d = Math.sqrt(d2), area = -x0 * dy + y0 * dx + x1 * y2 - x2 * y1;
    if (p === v[0]) deriv += (y1 - y2) / d;
    if (p === v[1]) deriv += (x2 - x1) / d;
    if (p === v[2]) deriv += ((y2 - y0) * d + (dx / d) * area) / d2;
    if (p === v[3]) deriv += ((x0 - x2) * d + (dy / d) * area) / d2;
    if (p === v[4]) deriv += ((y0 - y1) * d - (dx / d) * area) / d2;
    if (p === v[5]) deriv += ((x1 - x0) * d - (dy / d) * area) / d2;
  }
  return deriv;
}
class CP2LDistance extends Constraint {
  constructor(p: Point, l: Line, d: Param, public ccw: boolean) { super(); this.pvec.push(p.x, p.y, l.p1.x, l.p1.y, l.p2.x, l.p2.y, d); this.init(); }
  signedValue(): number { const x0 = this.q(0), y0 = this.q(1), x1 = this.q(2), y1 = this.q(3), x2 = this.q(4), y2 = this.q(5); const dx = x2 - x1, dy = y2 - y1; return (-x0 * dy + y0 * dx + x1 * y2 - x2 * y1) / Math.sqrt(dx * dx + dy * dy); }
  override error(): number { const dist = this.ccw ? Math.abs(this.q(6)) : -Math.abs(this.q(6)); return this.scale * (this.signedValue() - dist); }
  override grad(p: Param): number { let d = lineDistGrad(this.pvec, (i) => this.q(i), p); if (p === this.pvec[6]) d += this.ccw ? -1 : 1; return this.scale * d; }
  override maxStep(dir: Map<Param, number>, lim: number): number {
    const v = this.pvec; let it = dir.get(v[6]);
    if (it !== undefined && it < 0) lim = Math.min(lim, -this.q(6) / it);
    let darea = 0; const x0 = this.q(0), y0 = this.q(1), x1 = this.q(2), y1 = this.q(3), x2 = this.q(4), y2 = this.q(5);
    const f: [number, number][] = [[0, y1 - y2], [1, x2 - x1], [2, y2 - y0], [3, x0 - x2], [4, y0 - y1], [5, x1 - x0]];
    for (const [i, k] of f) { it = dir.get(v[i]); if (it !== undefined) darea += k * it; }
    darea = Math.abs(darea);
    if (darea > 0) {
      const dx = x2 - x1, dy = y2 - y1; let area = 0.3 * this.q(6) * Math.sqrt(dx * dx + dy * dy);
      if (darea > area) { area = Math.max(area, 0.3 * Math.abs(-x0 * dy + y0 * dx + x1 * y2 - x2 * y1)); if (darea > area) lim = Math.min(lim, area / darea); }
    }
    return lim;
  }
  override evaluate(): void { this.pvec[6].v = Math.abs(this.signedValue()); }
}
class CPointOnLine extends Constraint {
  constructor(p: Point, lp1: Point, lp2: Point) { super(); this.pvec.push(p.x, p.y, lp1.x, lp1.y, lp2.x, lp2.y); this.init(); }
  override error(): number { const x0 = this.q(0), y0 = this.q(1), x1 = this.q(2), y1 = this.q(3), x2 = this.q(4), y2 = this.q(5); const dx = x2 - x1, dy = y2 - y1; return this.scale * (-x0 * dy + y0 * dx + x1 * y2 - x2 * y1) / Math.sqrt(dx * dx + dy * dy); }
  override grad(p: Param): number { return this.scale * lineDistGrad(this.pvec, (i) => this.q(i), p); }
}
class CPointOnPerpBisector extends Constraint {
  constructor(p: Point, lp1: Point, lp2: Point) { super(); this.pvec.push(p.x, p.y, lp1.x, lp1.y, lp2.x, lp2.y); this.init(); }
  override errorgrad(dp: Param | null): [number, number] {
    const v = this.pvec;
    const p0 = DV.of(new Point(v[0], v[1]), dp), p1 = DV.of(new Point(v[2], v[3]), dp), p2 = DV.of(new Point(v[4], v[5]), dp);
    const d1 = p0.subtr(p1), d2 = p0.subtr(p2), D = p2.subtr(p1).getNormalized();
    const [a, da] = d1.scalarProd(D), [b, db] = d2.scalarProd(D);
    return [a + b, da + db];
  }
}
/** Parallel / Perpendicular: the cross or dot product of the two directions, scaled by the lengths at creation. */
class CTwoLines extends Constraint {
  constructor(public perp: boolean, a: Point, b: Point, c: Point, d: Point) { super(); this.pvec.push(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y); this.init(); }
  override rescale(coef = 1): void { const dx1 = this.q(0) - this.q(2), dy1 = this.q(1) - this.q(3), dx2 = this.q(4) - this.q(6), dy2 = this.q(5) - this.q(7); this.scale = coef / Math.sqrt((dx1 * dx1 + dy1 * dy1) * (dx2 * dx2 + dy2 * dy2)); }
  override error(): number { const dx1 = this.q(0) - this.q(2), dy1 = this.q(1) - this.q(3), dx2 = this.q(4) - this.q(6), dy2 = this.q(5) - this.q(7); return this.scale * (this.perp ? dx1 * dx2 + dy1 * dy2 : dx1 * dy2 - dy1 * dx2); }
  override grad(p: Param): number {
    const v = this.pvec, dx1 = this.q(0) - this.q(2), dy1 = this.q(1) - this.q(3), dx2 = this.q(4) - this.q(6), dy2 = this.q(5) - this.q(7);
    let d = 0;
    if (this.perp) {
      if (p === v[0]) d += dx2; if (p === v[2]) d += -dx2; if (p === v[1]) d += dy2; if (p === v[3]) d += -dy2;
      if (p === v[4]) d += dx1; if (p === v[6]) d += -dx1; if (p === v[5]) d += dy1; if (p === v[7]) d += -dy1;
    } else {
      if (p === v[0]) d += dy2; if (p === v[2]) d += -dy2; if (p === v[1]) d += -dx2; if (p === v[3]) d += dx2;
      if (p === v[4]) d += -dy1; if (p === v[6]) d += dy1; if (p === v[5]) d += dx1; if (p === v[7]) d += -dx1;
    }
    return this.scale * d;
  }
}
class CL2LAngle extends Constraint {
  constructor(l1: Line, l2: Line, a: Param) { super(); this.pvec.push(l1.p1.x, l1.p1.y, l1.p2.x, l1.p2.y, l2.p1.x, l2.p1.y, l2.p2.x, l2.p2.y, a); this.init(); }
  override error(): number {
    const dx1 = this.q(2) - this.q(0), dy1 = this.q(3) - this.q(1), dx2 = this.q(6) - this.q(4), dy2 = this.q(7) - this.q(5);
    const a = Math.atan2(dy1, dx1) + this.q(8), ca = Math.cos(a), sa = Math.sin(a);
    return this.scale * Math.atan2(-dx2 * sa + dy2 * ca, dx2 * ca + dy2 * sa);
  }
  override grad(p: Param): number {
    const v = this.pvec; let deriv = 0;
    if (p === v[0] || p === v[1] || p === v[2] || p === v[3]) {
      const dx1 = this.q(2) - this.q(0), dy1 = this.q(3) - this.q(1), r2 = dx1 * dx1 + dy1 * dy1;
      if (p === v[0]) deriv += -dy1 / r2; if (p === v[1]) deriv += dx1 / r2; if (p === v[2]) deriv += dy1 / r2; if (p === v[3]) deriv += -dx1 / r2;
    }
    if (p === v[4] || p === v[5] || p === v[6] || p === v[7]) {
      const dx1 = this.q(2) - this.q(0), dy1 = this.q(3) - this.q(1); let dx2 = this.q(6) - this.q(4), dy2 = this.q(7) - this.q(5);
      const a = Math.atan2(dy1, dx1) + this.q(8), ca = Math.cos(a), sa = Math.sin(a);
      const x2 = dx2 * ca + dy2 * sa, y2 = -dx2 * sa + dy2 * ca, r2 = dx2 * dx2 + dy2 * dy2;
      dx2 = -y2 / r2; dy2 = x2 / r2;
      if (p === v[4]) deriv += -ca * dx2 + sa * dy2; if (p === v[5]) deriv += -sa * dx2 - ca * dy2;
      if (p === v[6]) deriv += ca * dx2 - sa * dy2; if (p === v[7]) deriv += sa * dx2 + ca * dy2;
    }
    if (p === v[8]) deriv += -1;
    return this.scale * deriv;
  }
  override maxStep(dir: Map<Param, number>, lim: number): number { const it = dir.get(this.pvec[8]); if (it !== undefined) { const step = Math.abs(it); if (step > Math.PI / 18) lim = Math.min(lim, (Math.PI / 18) / step); } return lim; }
  override evaluate(): void {
    const dx1 = this.q(2) - this.q(0), dy1 = this.q(3) - this.q(1), dx2 = this.q(6) - this.q(4), dy2 = this.q(7) - this.q(5);
    const a = Math.atan2(dy1, dx1), ca = Math.cos(a), sa = Math.sin(a);
    this.pvec[8].v = Math.atan2(-dx2 * sa + dy2 * ca, dx2 * ca + dy2 * sa);
  }
}
class CMidpointOnLine extends Constraint {
  constructor(a: Point, b: Point, c: Point, d: Point) { super(); this.pvec.push(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y); this.init(); }
  override error(): number {
    const x0 = (this.q(0) + this.q(2)) / 2, y0 = (this.q(1) + this.q(3)) / 2, x1 = this.q(4), x2 = this.q(6), y1 = this.q(5), y2 = this.q(7);
    const dx = x2 - x1, dy = y2 - y1; return this.scale * (-x0 * dy + y0 * dx + x1 * y2 - x2 * y1) / Math.sqrt(dx * dx + dy * dy);
  }
  override grad(p: Param): number {
    const v = this.pvec; let deriv = 0;
    if (v.indexOf(p) >= 0) {
      const x0 = (this.q(0) + this.q(2)) / 2, y0 = (this.q(1) + this.q(3)) / 2, x1 = this.q(4), x2 = this.q(6), y1 = this.q(5), y2 = this.q(7);
      const dx = x2 - x1, dy = y2 - y1, d2 = dx * dx + dy * dy, d = Math.sqrt(d2), area = -x0 * dy + y0 * dx + x1 * y2 - x2 * y1;
      if (p === v[0]) deriv += (y1 - y2) / (2 * d); if (p === v[1]) deriv += (x2 - x1) / (2 * d);
      if (p === v[2]) deriv += (y1 - y2) / (2 * d); if (p === v[3]) deriv += (x2 - x1) / (2 * d);
      if (p === v[4]) deriv += ((y2 - y0) * d + (dx / d) * area) / d2; if (p === v[5]) deriv += ((x0 - x2) * d + (dy / d) * area) / d2;
      if (p === v[6]) deriv += ((y0 - y1) * d - (dx / d) * area) / d2; if (p === v[7]) deriv += ((x1 - x0) * d - (dy / d) * area) / d2;
    }
    return this.scale * deriv;
  }
}
class CTangentCircumf extends Constraint {
  constructor(p1: Point, p2: Point, r1: Param, r2: Param, public internal: boolean) { super(); this.pvec.push(p1.x, p1.y, p2.x, p2.y, r1, r2); this.init(); }
  override error(): number {
    const dx = this.q(0) - this.q(2), dy = this.q(1) - this.q(3), dsq = dx * dx + dy * dy, r1 = this.q(4), r2 = this.q(5);
    if (dsq < 1e-14) return this.scale * (r1 - r2);
    return this.internal ? this.scale * (dsq - (r1 - r2) * (r1 - r2)) : this.scale * (dsq - (r1 + r2) * (r1 + r2));
  }
  override grad(p: Param): number {
    const v = this.pvec; let deriv = 0;
    if (v.indexOf(p) >= 0) {
      const dx = this.q(0) - this.q(2), dy = this.q(1) - this.q(3), dsq = dx * dx + dy * dy, r1 = this.q(4), r2 = this.q(5);
      if (dsq < 1e-14) { if (p === v[4]) deriv = 1; else if (p === v[5]) deriv = -1; return this.scale * deriv; }
      if (p === v[0]) deriv += 2 * dx; if (p === v[1]) deriv += 2 * dy; if (p === v[2]) deriv += 2 * -dx; if (p === v[3]) deriv += 2 * -dy;
      if (this.internal) { if (p === v[4]) deriv += 2 * (r2 - r1); if (p === v[5]) deriv += 2 * (r1 - r2); }
      else { if (p === v[4]) deriv += -2 * (r1 + r2); if (p === v[5]) deriv += -2 * (r1 + r2); }
    }
    return this.scale * deriv;
  }
}
class CPointOnEllipse extends Constraint {
  constructor(p: Point, e: Ellipse) { super(); this.pvec.push(p.x, p.y, e.center.x, e.center.y, e.focus1.x, e.focus1.y, e.radmin); this.init(); }
  override error(): number {
    const X0 = this.q(0), Y0 = this.q(1), Xc = this.q(2), Yc = this.q(3), XF = this.q(4), YF = this.q(5), b = this.q(6);
    return this.scale * (Math.sqrt((X0 - XF) ** 2 + (Y0 - YF) ** 2) + Math.sqrt((X0 + XF - 2 * Xc) ** 2 + (Y0 + YF - 2 * Yc) ** 2) - 2 * Math.sqrt(b ** 2 + (XF - Xc) ** 2 + (YF - Yc) ** 2));
  }
  override grad(p: Param): number {
    const v = this.pvec; let d = 0;
    if (v.indexOf(p) >= 0) {
      const X0 = this.q(0), Y0 = this.q(1), Xc = this.q(2), Yc = this.q(3), XF = this.q(4), YF = this.q(5), b = this.q(6);
      const s1 = Math.sqrt((X0 - XF) ** 2 + (Y0 - YF) ** 2), s2 = Math.sqrt((X0 + XF - 2 * Xc) ** 2 + (Y0 + YF - 2 * Yc) ** 2), s3 = Math.sqrt(b ** 2 + (XF - Xc) ** 2 + (YF - Yc) ** 2);
      if (p === v[0]) d += (X0 - XF) / s1 + (X0 + XF - 2 * Xc) / s2;
      if (p === v[1]) d += (Y0 - YF) / s1 + (Y0 + YF - 2 * Yc) / s2;
      if (p === v[4]) d += -(X0 - XF) / s1 - 2 * (XF - Xc) / s3 + (X0 + XF - 2 * Xc) / s2;
      if (p === v[5]) d += -(Y0 - YF) / s1 - 2 * (YF - Yc) / s3 + (Y0 + YF - 2 * Yc) / s2;
      if (p === v[2]) d += 2 * (XF - Xc) / s3 - 2 * (X0 + XF - 2 * Xc) / s2;
      if (p === v[3]) d += 2 * (YF - Yc) / s3 - 2 * (Y0 + YF - 2 * Yc) / s2;
      if (p === v[6]) d += -2 * b / s3;
    }
    return this.scale * d;
  }
}
class CEllipseTangentLine extends Constraint {
  l: Line; e: Ellipse;
  constructor(l: Line, e: Ellipse) { super(); this.l = l.copy(); this.e = e.copy(); this.l.push(this.pvec); this.e.push(this.pvec); this.init(); }
  override reconstructGeomPointers(): void { if (!this.l) return; const c = { i: 0 }; this.l.reconstruct(this.pvec, c); this.e.reconstruct(this.pvec, c); }
  override errorgrad(dp: Param | null): [number, number] {
    const p1 = DV.of(this.l.p1, dp), f1 = DV.of(this.e.focus1, dp), c = DV.of(this.e.center, dp);
    const f2 = c.linCombi(2, f1, -1);
    const nl = this.l.calculateNormal(dp).getNormalized();
    const [distF1L, ddistF1L] = f1.subtr(p1).scalarProd(nl);
    const f1m = f1.sum(nl.multD(-2 * distF1L, -2 * ddistF1L));
    const [distF1mF2, ddistF1mF2] = f2.subtr(f1m).lengthD();
    const [radmaj, dradmaj] = Ellipse.radMaj(c, f1, this.e.radmin.v, dp === this.e.radmin ? 1 : 0);
    return [distF1mF2 - 2 * radmaj, ddistF1mF2 - 2 * dradmaj];
  }
}
class CCurveValue extends Constraint {
  crv: Curve; p!: Point;
  constructor(p: Point, pcoord: Param, crv: Curve, u: Param) { super(); this.crv = crv.copy(); this.pvec.push(p.x, p.y, pcoord, u); this.crv.push(this.pvec); this.init(); }
  override reconstructGeomPointers(): void { if (!this.crv) return; this.p = new Point(this.pvec[0], this.pvec[1]); const c = { i: 4 }; this.crv.reconstruct(this.pvec, c); }
  override errorgrad(dp: Param | null): [number, number] {
    const u = this.pvec[3].v, du = dp === this.pvec[3] ? 1 : 0;
    const to = this.crv.value(u, du, dp), from = DV.of(this.p, dp), e = from.subtr(to);
    return this.pvec[2] === this.p.x ? [e.x, e.dx] : [e.y, e.dy];
  }
}
class CEqualLineLength extends Constraint {
  l1: Line; l2: Line;
  constructor(l1: Line, l2: Line) { super(); this.l1 = l1.copy(); this.l2 = l2.copy(); this.l1.push(this.pvec); this.l2.push(this.pvec); this.init(); }
  override reconstructGeomPointers(): void { if (!this.l1) return; const c = { i: 0 }; this.l1.reconstruct(this.pvec, c); this.l2.reconstruct(this.pvec, c); }
  override errorgrad(dp: Param | null): [number, number] {
    const v1 = DV.of(this.l1.p1, dp).subtr(DV.of(this.l1.p2, dp)), v2 = DV.of(this.l2.p1, dp).subtr(DV.of(this.l2.p2, dp));
    const [len1, dl1] = v1.lengthD(), [len2, dl2] = v2.lengthD();
    let g = dl2 - dl1;
    if (dp && Math.abs(g) < 1e-10) {
      const s = 1e-10;
      if (dp === this.l1.p1.x) g = v1.x > 0 ? s : -s; if (dp === this.l1.p1.y) g = v1.y > 0 ? s : -s;
      if (dp === this.l1.p2.x) g = v1.x > 0 ? -s : s; if (dp === this.l1.p2.y) g = v1.y > 0 ? -s : s;
      if (dp === this.l2.p1.x) g = v2.x > 0 ? s : -s; if (dp === this.l2.p1.y) g = v2.y > 0 ? s : -s;
      if (dp === this.l2.p2.x) g = v2.x > 0 ? -s : s; if (dp === this.l2.p2.y) g = v2.y > 0 ? -s : s;
    }
    return [len2 - len1, g];
  }
}

// ---------------------------------------------------------------- SubSystem

export class SubSystem {
  clist: Constraint[]; plist: Param[] = []; pvals: Param[] = []; pmap = new Map<Param, Param>(); p2c = new Map<Param, Constraint[]>();
  /** pmap's keys in address order (C++ std::map iteration): the last of several reduced keys writes the shared slot. */
  private keys: Param[] = [];
  constructor(clist: Constraint[], params: Param[], reductionmap?: Map<Param, Param>) {
    this.clist = clist.slice();
    const s2 = new Set<Param>();
    for (const c of this.clist) { c.revertParams(); for (const p of c.params()) s2.add(p); }
    const tmp: Param[] = []; for (const p of params) if (s2.delete(p)) tmp.push(p);
    const rindex = new Map<Param, number>();
    if (reductionmap && reductionmap.size) {
      const pindex = new Map<Param, number>(); let i = 0;
      for (const p of tmp) {
        const r = reductionmap.get(p);
        if (r) { const ip = pindex.get(r); if (ip === undefined) { this.plist.push(r); rindex.set(p, i); pindex.set(r, i); i++; } else rindex.set(p, ip); }
        else if (!pindex.has(p)) { this.plist.push(p); pindex.set(p, i); i++; }
      }
    } else this.plist = tmp;
    for (const p of this.plist) { const pv = new Param(p.v); this.pvals.push(pv); this.pmap.set(p, pv); }
    for (const [k, i] of rindex) this.pmap.set(k, this.pvals[i]);
    this.keys = Array.from(this.pmap.keys()).sort(byId);
    for (const c of this.clist) {
      c.revertParams();
      const set = new Set<Param>(); for (const p of c.params()) { const t = this.pmap.get(p); if (t) set.add(t); }
      for (const p of Array.from(set).sort(byId)) { let l = this.p2c.get(p); if (!l) this.p2c.set(p, l = []); l.push(c); }
    }
  }
  pSize(): number { return this.plist.length; }
  cSize(): number { return this.clist.length; }
  redirectParams(): void { for (const k of this.keys) this.pmap.get(k)!.v = k.v; for (const c of this.clist) { c.revertParams(); c.redirectParams(this.pmap); } }
  revertParams(): void { for (const c of this.clist) c.revertParams(); }
  getParamsList(params: Param[]): Vec { const x = new Float64Array(params.length); for (let j = 0; j < params.length; j++) { const t = this.pmap.get(params[j]); if (t) x[j] = t.v; } return x; }
  getParams(): Vec { return Float64Array.from(this.pvals, (p) => p.v); }
  setParamsList(params: Param[], x: Vec): void { for (let j = 0; j < params.length; j++) { const t = this.pmap.get(params[j]); if (t) t.v = x[j]; } }
  setParams(x: Vec): void { for (let i = 0; i < this.pvals.length; i++) this.pvals[i].v = x[i]; }
  error(): number { let e = 0; for (const c of this.clist) { const t = c.error(); e += t * t; } return e * 0.5; }
  calcResidual(): { r: Vec; err: number } { const r = new Float64Array(this.clist.length); let err = 0; for (let i = 0; i < r.length; i++) { r[i] = this.clist[i].error(); err += r[i] * r[i]; } return { r, err: err * 0.5 }; }
  calcJacobi(params: Param[] = this.plist): Mat {
    const J = new Mat(this.clist.length, params.length);
    for (let j = 0; j < params.length; j++) { const t = this.pmap.get(params[j]); if (t) for (let i = 0; i < this.clist.length; i++) J.set(i, j, this.clist[i].grad(t)); }
    return J;
  }
  calcGrad(params: Param[]): Vec {
    const g = new Float64Array(params.length);
    for (let j = 0; j < params.length; j++) { const t = this.pmap.get(params[j]); if (t) for (const c of this.p2c.get(t) || []) g[j] += c.error() * c.grad(t); }
    return g;
  }
  maxStep(params: Param[], xdir: Vec): number {
    const dir = new Map<Param, number>(); for (let j = 0; j < params.length; j++) { const t = this.pmap.get(params[j]); if (t) dir.set(t, xdir[j]); }
    let a = 1e10; for (const c of this.clist) a = c.maxStep(dir, a); return a;
  }
  applySolution(): void { for (const k of this.keys) k.v = this.pmap.get(k)!.v; }
}

// ---------------------------------------------------------------- System

export const SolveStatus = { Success: 0, Converged: 1, Failed: 2, SuccessfulSolutionInvalid: 3 } as const;
export const DefaultTemporaryConstraint = -1;
const smallF = 1e-20;

/** GCS::System, the subset pcbnew uses (DogLeg, dense QR diagnosis). */
export class System {
  plist: Param[] = []; pdrivenlist: Param[] = []; pIndex = new Map<Param, number>();
  clist: Constraint[] = []; drivenConstraints: Constraint[] = [];
  c2p = new Map<Constraint, Param[]>(); p2c = new Map<Param, Constraint[]>();
  subSystems: (SubSystem | null)[] = []; subSystemsAux: (SubSystem | null)[] = [];
  reference: number[] = []; reductionmaps: Map<Param, Param>[] = [];
  dofs = 0; redundant = new Set<Constraint>(); conflictingTags: number[] = []; redundantTags: number[] = []; partiallyRedundantTags: number[] = [];
  hasUnknowns = false; hasDiagnosis = false; isInit = false; emptyDiagnoseMatrix = true;
  maxIter = 100; maxIterRedundant = 100; convergence = 1e-10; convergenceRedundant = 1e-10; qrpivotThreshold = 1e-13;
  DL_tolg = 1e-80; DL_tolx = 1e-80; DL_tolf = 1e-10; DL_tolgRedundant = 1e-80; DL_tolxRedundant = 1e-80; DL_tolfRedundant = 1e-10;

  clear(): void {
    this.plist = []; this.pdrivenlist = []; this.pIndex.clear(); this.hasUnknowns = false; this.hasDiagnosis = false; this.emptyDiagnoseMatrix = true;
    this.redundant.clear(); this.conflictingTags = []; this.redundantTags = []; this.partiallyRedundantTags = [];
    this.reference = []; this.clearSubSystems(); this.clist = []; this.drivenConstraints = []; this.c2p.clear(); this.p2c.clear();
  }
  clearByTag(tag: number): void { for (const c of this.clist.filter((c) => c.tag === tag)) this.removeConstraint(c); }
  private addConstraint(c: Constraint, tag: number, driving: boolean): number {
    c.tag = tag; c.driving = driving;
    this.isInit = false;
    if (c.tag >= 0) this.hasDiagnosis = false;
    if (!c.driving) this.drivenConstraints.push(c);
    this.clist.push(c);
    for (const p of c.params()) { let l = this.c2p.get(c); if (!l) this.c2p.set(c, l = []); l.push(p); let m = this.p2c.get(p); if (!m) this.p2c.set(p, m = []); m.push(c); }
    return this.clist.length - 1;
  }
  removeConstraint(c: Constraint): void {
    const i = this.clist.indexOf(c); if (i < 0) return;
    this.clist.splice(i, 1);
    const d = this.drivenConstraints.indexOf(c); if (d >= 0) this.drivenConstraints.splice(d, 1);
    if (c.tag >= 0) this.hasDiagnosis = false;
    this.clearSubSystems();
    for (const p of this.c2p.get(c) || []) { const l = this.p2c.get(p); if (l) { const k = l.indexOf(c); if (k >= 0) l.splice(k, 1); } }
    this.c2p.delete(c);
  }
  // basic and derived constraints (GCS.cpp)
  addConstraintEqual(p1: Param, p2: Param, tag = 0, driving = true): number { return this.addConstraint(new CEqual(p1, p2), tag, driving); }
  addConstraintDifference(p1: Param, p2: Param, d: Param, tag = 0, driving = true): number { return this.addConstraint(new CDifference(p1, p2, d), tag, driving); }
  addConstraintP2PDistance(p1: Point, p2: Point, d: Param, tag = 0, driving = true): number { return this.addConstraint(new CP2PDistance(p1, p2, d), tag, driving); }
  addConstraintP2LDistance(p: Point, l: Line, d: Param, ccw: boolean, tag = 0, driving = true): number { return this.addConstraint(new CP2LDistance(p, l, d, ccw), tag, driving); }
  addConstraintPointOnLine(p: Point, l: Line, tag = 0, driving = true): number { return this.addConstraint(new CPointOnLine(p, l.p1, l.p2), tag, driving); }
  addConstraintPointOnLinePts(p: Point, lp1: Point, lp2: Point, tag = 0, driving = true): number { return this.addConstraint(new CPointOnLine(p, lp1, lp2), tag, driving); }
  addConstraintPointOnPerpBisector(p: Point, lp1: Point, lp2: Point, tag = 0, driving = true): number { return this.addConstraint(new CPointOnPerpBisector(p, lp1, lp2), tag, driving); }
  addConstraintParallel(l1: Line, l2: Line, tag = 0, driving = true): number { return this.addConstraint(new CTwoLines(false, l1.p1, l1.p2, l2.p1, l2.p2), tag, driving); }
  addConstraintPerpendicular(l1: Line, l2: Line, tag = 0, driving = true): number { return this.addConstraint(new CTwoLines(true, l1.p1, l1.p2, l2.p1, l2.p2), tag, driving); }
  addConstraintPerpendicularPts(a: Point, b: Point, c: Point, d: Point, tag = 0, driving = true): number { return this.addConstraint(new CTwoLines(true, a, b, c, d), tag, driving); }
  addConstraintL2LAngle(l1: Line, l2: Line, a: Param, tag = 0, driving = true): number { return this.addConstraint(new CL2LAngle(l1, l2, a), tag, driving); }
  addConstraintMidpointOnLinePts(a: Point, b: Point, c: Point, d: Point, tag = 0, driving = true): number { return this.addConstraint(new CMidpointOnLine(a, b, c, d), tag, driving); }
  addConstraintTangentCircumf(p1: Point, p2: Point, r1: Param, r2: Param, internal: boolean, tag = 0, driving = true): number { return this.addConstraint(new CTangentCircumf(p1, p2, r1, r2, internal), tag, driving); }
  addConstraintP2PCoincident(p1: Point, p2: Point, tag = 0, driving = true): number { this.addConstraintEqual(p1.x, p2.x, tag, driving); return this.addConstraintEqual(p1.y, p2.y, tag, driving); }
  addConstraintHorizontal(l: Line, tag = 0, driving = true): number { return this.addConstraintEqual(l.p1.y, l.p2.y, tag, driving); }
  addConstraintHorizontalPts(p1: Point, p2: Point, tag = 0, driving = true): number { return this.addConstraintEqual(p1.y, p2.y, tag, driving); }
  addConstraintVertical(l: Line, tag = 0, driving = true): number { return this.addConstraintEqual(l.p1.x, l.p2.x, tag, driving); }
  addConstraintVerticalPts(p1: Point, p2: Point, tag = 0, driving = true): number { return this.addConstraintEqual(p1.x, p2.x, tag, driving); }
  addConstraintCoordinateX(p: Point, x: Param, tag = 0, driving = true): number { return this.addConstraintEqual(p.x, x, tag, driving); }
  addConstraintCoordinateY(p: Point, y: Param, tag = 0, driving = true): number { return this.addConstraintEqual(p.y, y, tag, driving); }
  addConstraintCurveValue(p: Point, crv: Curve, u: Param, tag = 0, driving = true): number { this.addConstraint(new CCurveValue(p, p.x, crv, u), tag, driving); return this.addConstraint(new CCurveValue(p, p.y, crv, u), tag, driving); }
  addConstraintArcRules(a: Arc, tag = 0, driving = true): number { this.addConstraintCurveValue(a.start, a, a.startAngle, tag, driving); return this.addConstraintCurveValue(a.end, a, a.endAngle, tag, driving); }
  addConstraintArcOfEllipseRules(a: ArcOfEllipse, tag = 0, driving = true): number { this.addConstraintCurveValue(a.start, a, a.startAngle, tag, driving); return this.addConstraintCurveValue(a.end, a, a.endAngle, tag, driving); }
  addConstraintPointOnCircle(p: Point, c: Circle, tag = 0, driving = true): number { return this.addConstraintP2PDistance(p, c.center, c.rad, tag, driving); }
  addConstraintPointOnEllipse(p: Point, e: Ellipse, tag = 0, driving = true): number { return this.addConstraint(new CPointOnEllipse(p, e), tag, driving); }
  addConstraintTangentLineCircle(l: Line, c: Circle, ccw: boolean, tag = 0, driving = true): number { return this.addConstraintP2LDistance(c.center, l, c.rad, ccw, tag, driving); }
  addConstraintTangentLineEllipse(l: Line, e: Ellipse, tag = 0, driving = true): number { return this.addConstraint(new CEllipseTangentLine(l, e), tag, driving); }
  addConstraintTangentCircles(c1: Circle, c2: Circle, tag = 0, driving = true): number {
    const dx = c2.center.x.v - c1.center.x.v, dy = c2.center.y.v - c1.center.y.v, d = Math.sqrt(dx * dx + dy * dy);
    return this.addConstraintTangentCircumf(c1.center, c2.center, c1.rad, c2.rad, d < c1.rad.v || d < c2.rad.v, tag, driving);
  }
  addConstraintCircleRadius(c: Circle, r: Param, tag = 0, driving = true): number { return this.addConstraintEqual(c.rad, r, tag, driving); }
  addConstraintEqualLength(l1: Line, l2: Line, tag = 0, driving = true): number { return this.addConstraint(new CEqualLineLength(l1, l2), tag, driving); }
  addConstraintEqualRadius(c1: Circle, c2: Circle, tag = 0, driving = true): number { return this.addConstraintEqual(c1.rad, c2.rad, tag, driving); }
  addConstraintP2PSymmetricLine(p1: Point, p2: Point, l: Line, tag = 0, driving = true): number { this.addConstraintPerpendicularPts(p1, p2, l.p1, l.p2, tag, driving); return this.addConstraintMidpointOnLinePts(p1, p2, l.p1, l.p2, tag, driving); }
  addConstraintP2PSymmetricPoint(p1: Point, p2: Point, p: Point, tag = 0, driving = true): number { this.addConstraintPointOnPerpBisector(p, p1, p2, tag, driving); return this.addConstraintPointOnLinePts(p, p1, p2, tag, driving); }

  calculateConstraintErrorByTag(tag: number): number {
    let cnt = 0, sq = 0, err = 0;
    for (const c of this.clist) if (c.tag === tag) { err = c.error(); sq += err * err; cnt++; }
    return cnt === 0 ? NaN : cnt === 1 ? err : Math.sqrt(sq / cnt);
  }
  rescaleConstraint(id: number, coeff: number): void { if (id >= this.clist.length || id < 0) return; this.clist[id]?.rescale(coeff); }
  declareUnknowns(params: Param[]): void { this.plist = params.slice(); this.pIndex.clear(); this.plist.forEach((p, i) => this.pIndex.set(p, i)); this.hasUnknowns = true; }
  dofsNumber(): number { return this.hasDiagnosis ? this.dofs : -1; }
  getConflicting(): number[] { return this.conflictingTags.slice(); }
  getRedundant(): number[] { return this.redundantTags.slice(); }

  initSolution(): void {
    this.isInit = false;
    if (!this.hasUnknowns) return;
    this.setReference();
    if (!this.hasDiagnosis) this.diagnose();
    if (!this.hasDiagnosis) return;
    const clistR = this.clist.filter((c) => (this.redundant.size ? !this.redundant.has(c) : true) && c.driving);
    // connected components over parameters then constraints (boost::connected_components numbering)
    const n = this.plist.length + clistR.length, adj: number[][] = Array.from({ length: n }, () => []);
    clistR.forEach((c, k) => { const cv = this.plist.length + k; for (const p of this.c2p.get(c) || []) { const i = this.pIndex.get(p); if (i !== undefined) { adj[cv].push(i); adj[i].push(cv); } } });
    const comp = new Int32Array(n).fill(-1); let ncomp = 0;
    for (let s = 0; s < n; s++) { if (comp[s] >= 0) continue; const st = [s]; comp[s] = ncomp; while (st.length) { const u = st.pop()!; for (const w of adj[u]) if (comp[w] < 0) { comp[w] = ncomp; st.push(w); } } ncomp++; }
    const reduced = new Set<Constraint>();
    this.reductionmaps = Array.from({ length: ncomp }, () => new Map<Param, Param>());
    const reducedParams = this.plist.slice();
    for (const c of clistR) {
      if (!(c.tag >= 0 && c.typeId() === CType.Equal)) continue;
      const i1 = this.pIndex.get(c.params()[0]), i2 = this.pIndex.get(c.params()[1]);
      if (i1 === undefined || i2 === undefined) continue;
      reduced.add(c);
      const kept = reducedParams[i1], replaced = reducedParams[i2];
      for (let k = 0; k < reducedParams.length; k++) if (reducedParams[k] === replaced) reducedParams[k] = kept;
    }
    for (let i = 0; i < this.plist.length; i++) if (this.plist[i] !== reducedParams[i]) this.reductionmaps[comp[i]].set(this.plist[i], reducedParams[i]);
    const clists: Constraint[][] = Array.from({ length: ncomp }, () => []);
    clistR.forEach((c, k) => { if (!reduced.has(c)) clists[comp[this.plist.length + k]].push(c); });
    const plists: Param[][] = Array.from({ length: ncomp }, () => []);
    this.plist.forEach((p, i) => plists[comp[i]].push(p));
    this.clearSubSystems();
    this.subSystems = new Array(ncomp).fill(null); this.subSystemsAux = new Array(ncomp).fill(null);
    for (let cid = 0; cid < ncomp; cid++) {
      const c0 = clists[cid].filter((c) => c.tag >= 0), c1 = clists[cid].filter((c) => c.tag < 0);
      if (c0.length) this.subSystems[cid] = new SubSystem(c0, plists[cid], this.reductionmaps[cid]);
      if (c1.length) this.subSystemsAux[cid] = new SubSystem(c1, plists[cid], this.reductionmaps[cid]);
    }
    this.isInit = true;
  }
  private setReference(): void { this.reference = this.plist.map((p) => p.v); }
  private resetToReference(): void { if (this.reference.length === this.plist.length) this.plist.forEach((p, i) => { p.v = this.reference[i]; }); }
  clearSubSystems(): void { this.isInit = false; this.subSystems = []; this.subSystemsAux = []; }

  solve(isRedundantsolving = false): number {
    if (!this.isInit) return SolveStatus.Failed;
    let isReset = false, res: number = SolveStatus.Success;
    for (let cid = 0; cid < this.subSystems.length; cid++) {
      const a = this.subSystems[cid], b = this.subSystemsAux[cid];
      if ((a || b) && !isReset) { this.resetToReference(); isReset = true; }
      if (a && b) res = Math.max(res, this.solveSQP(a, b, isRedundantsolving));
      else if (a) res = Math.max(res, this.solveDL(a, isRedundantsolving));
      else if (b) res = Math.max(res, this.solveDL(b, isRedundantsolving));
    }
    if (res === SolveStatus.Success) {
      for (const c of this.redundant) { const err = c.error(); if (err * err > (isRedundantsolving ? this.convergenceRedundant : this.convergence)) return SolveStatus.Converged; }
    }
    return res;
  }

  solveDL(subsys: SubSystem, isRedundantsolving = false): number {
    const xsize = subsys.pSize();
    if (xsize === 0) return SolveStatus.Success;
    let tolg = this.DL_tolg, tolx = this.DL_tolx, tolf = this.DL_tolf, maxIterNumber = this.maxIter;
    if (isRedundantsolving) { tolg = this.DL_tolgRedundant; tolx = this.DL_tolxRedundant; tolf = this.DL_tolfRedundant; maxIterNumber = this.maxIterRedundant; }
    subsys.redirectParams();
    let x = subsys.getParams();
    let { r: fx, err } = subsys.calcResidual();
    let Jx = subsys.calcJacobi();
    const negfx = (f: Vec): Vec => Float64Array.from(f, (v) => -v);
    let g = Jx.tmulv(negfx(fx));
    let gInf = vinf(g), fxInf = vinf(fx);
    const divergingLim = 1e6 * err + 1e12;
    let delta = 0.1, alpha = 0, nu = 2, iter = 0, stop = 0, reduce = 0;
    for (;;) {
      if (fxInf <= tolf) { stop = 1; break; }
      else if (gInf <= tolg) { stop = 2; break; }
      else if (delta <= tolx * (tolx + vnorm(x))) { stop = 2; break; }
      else if (iter >= maxIterNumber) { stop = 4; break; }
      else if (err > divergingLim || err !== err) { stop = 6; break; }
      alpha = vsq(g) / vsq(Jx.mulv(g));
      const hsd = Float64Array.from(g, (v) => alpha * v);
      const hgn = fullPivLuSolve(Jx, negfx(fx));
      const Jh = Jx.mulv(hgn); for (let i = 0; i < Jh.length; i++) Jh[i] += fx[i];
      const relError = vnorm(Jh) / vnorm(fx);
      if (relError > 1e15) break;
      let hdl: Vec;
      if (vnorm(hgn) < delta) { hdl = hgn; if (vnorm(hdl) <= tolx * (tolx + vnorm(x))) { stop = 5; break; } }
      else if (alpha * vnorm(g) >= delta) { const f = delta / (alpha * vnorm(g)); hdl = Float64Array.from(hsd, (v) => f * v); }
      else {
        let beta = 0; const b = Float64Array.from(hgn, (v, i) => v - hsd[i]);
        const bb = Math.abs(vdot(b, b)), gb = Math.abs(vdot(hsd, b)), hn = vnorm(hsd), c = (delta + hn) * (delta - hn);
        if (gb > 0) beta = c / (gb + Math.sqrt(gb * gb + c * bb)); else beta = (Math.sqrt(gb * gb + c * bb) - gb) / bb;
        hdl = Float64Array.from(hsd, (v, i) => v + beta * b[i]);
      }
      const xnew = Float64Array.from(x, (v, i) => v + hdl[i]);
      subsys.setParams(xnew);
      const rn = subsys.calcResidual(), fxnew = rn.r, errnew = rn.err;
      const Jnew = subsys.calcJacobi();
      const lin = Jx.mulv(hdl); for (let i = 0; i < lin.length; i++) lin[i] += fx[i];
      const dL = err - 0.5 * vsq(lin), dF = err - errnew;
      let rho = dL / dF;
      if (dF > 0 && dL > 0) { x = xnew; Jx = Jnew; fx = fxnew; err = errnew; g = Jx.tmulv(negfx(fx)); gInf = vinf(g); fxInf = vinf(fx); }
      else rho = -1;
      if (Math.abs(rho - 1) < 0.2 && vnorm(hdl) > delta / 3 && reduce <= 0) { delta = 3 * delta; nu = 2; reduce = 0; }
      else if (rho < 0.25) { delta = delta / nu; nu = 2 * nu; reduce = 2; }
      else reduce--;
      iter++;
    }
    subsys.revertParams();
    return stop === 1 ? SolveStatus.Success : SolveStatus.Failed;
  }

  /** System::solve(subsysA, subsysB): the hard constraints in A, the soft ones in B (SQP with BFGS). */
  solveSQP(A: SubSystem, B: SubSystem, isRedundantsolving = false): number {
    const csizeA = A.cSize();
    const set = new Set<Param>([...A.plist, ...B.plist]);
    const plistAB = Array.from(set).sort((a, b) => this.pIndex.get(a)! - this.pIndex.get(b)!);
    const xsize = plistAB.length;
    let Bm = Mat.identity(xsize);
    A.redirectParams(); B.redirectParams();
    const xb = B.getParamsList(plistAB), xa = A.getParamsList(plistAB);
    // getParams(plistAB, x) writes only the entries the subsystem owns, A after B
    const x = new Float64Array(xsize);
    for (let j = 0; j < xsize; j++) { x[j] = B.pmap.has(plistAB[j]) ? xb[j] : 0; if (A.pmap.has(plistAB[j])) x[j] = xa[j]; }
    B.setParamsList(plistAB, x);
    const xStart = new Float64Array(x);
    let grad = B.calcGrad(plistAB), JA = A.calcJacobi(plistAB), resA = A.calcResidual().r;
    {
      const JB = B.calcJacobi(plistAB), gn = JB.transpose().mul(JB);
      let scale = 0; if (xsize > 0) { scale = -Infinity; for (let i = 0; i < xsize; i++) scale = Math.max(scale, gn.get(i, i)); }
      if (scale > 0) { for (let i = 0; i < xsize; i++) gn.add(i, i, 1e-10 * scale); Bm = gn; }
    }
    const maxIterNumber = isRedundantsolving ? this.maxIterRedundant : this.maxIter;
    const divergingLim = 1e6 * A.error() + 1e12;
    let mu = 0;
    const finite = (): boolean => vfinite(grad) && JA.allFinite();
    let lambda: Vec = new Float64Array(csizeA), h: Vec = new Float64Array(xsize);
    const setX = (v: Vec): void => { A.setParamsList(plistAB, v); B.setParamsList(plistAB, v); resA = A.calcResidual().r; };
    let xcur = x;
    for (let iter = 1; iter < maxIterNumber; iter++) {
      if (!finite()) break;
      const qp = qpEq(Bm, grad, JA, resA);
      if (qp.status) break;
      const xdir = qp.x, Y = qp.Y;
      const x0 = xcur, lambda0 = lambda;
      const BxPg = Bm.mulv(xdir); for (let i = 0; i < xsize; i++) BxPg[i] += grad[i];
      lambda = Y.tmulv(BxPg);
      const lambdadir = Float64Array.from(lambda, (v, i) => v - lambda0[i]);
      {
        const eta = 0.25, tau = 0.5, rho = 0.5;
        let alpha = Math.min(1, A.maxStep(plistAB, xdir));
        const l1 = vl1(resA);
        if (l1 > 0) mu = Math.max(mu, (vdot(grad, xdir) + Math.max(0, 0.5 * vdot(xdir, Bm.mulv(xdir)))) / ((1 - rho) * l1));
        const f0 = B.error() + mu * vl1(resA);
        const deriv = vdot(grad, xdir) - mu * vl1(resA);
        xcur = Float64Array.from(x0, (v, i) => v + alpha * xdir[i]);
        setX(xcur);
        let f = B.error() + mu * vl1(resA);
        const first = true;   // never cleared, as upstream: every backtrack tries the second-order correction first
        while (f > f0 + eta * alpha * deriv) {
          if (first) {
            const xdir1 = Y.mulv(resA);
            for (let i = 0; i < xsize; i++) xcur[i] -= xdir1[i];
            setX(xcur);
            f = B.error() + mu * vl1(resA);
            if (f < f0 + eta * alpha * deriv) break;
          }
          alpha = tau * alpha;
          if (alpha < 1e-8) alpha = 0;
          xcur = Float64Array.from(x0, (v, i) => v + alpha * xdir[i]);
          setX(xcur);
          f = B.error() + mu * vl1(resA);
          if (alpha < 1e-8) break;
        }
        lambda = Float64Array.from(lambda0, (v, i) => v + alpha * lambdadir[i]);
      }
      h = Float64Array.from(xcur, (v, i) => v - x0[i]);
      const JTl0 = JA.tmulv(lambda);
      const y = Float64Array.from(grad, (v, i) => v - JTl0[i]);
      grad = B.calcGrad(plistAB); JA = A.calcJacobi(plistAB); resA = A.calcResidual().r;
      const JTl = JA.tmulv(lambda);
      for (let i = 0; i < xsize; i++) y[i] = grad[i] - JTl[i] - y[i];
      if (iter > 1) {
        const yTh = vdot(y, h);
        if (yTh !== 0) {
          const Bh = Bm.mulv(h), hBh = vdot(h, Bh);
          for (let j = 0; j < xsize; j++) for (let i = 0; i < xsize; i++) Bm.add(i, j, y[i] * y[j] / yTh - Bh[i] * Bh[j] / hBh);
        }
      }
      const err = A.error();
      if (vnorm(h) <= (isRedundantsolving ? this.convergenceRedundant : this.convergence) && err <= smallF) break;
      if (err > divergingLim || err !== err) break;
    }
    let ret: number;
    if (!finite()) { A.setParamsList(plistAB, xStart); B.setParamsList(plistAB, xStart); ret = SolveStatus.Failed; }
    else if (A.error() <= smallF) ret = SolveStatus.Success;
    else if (vnorm(h) <= (isRedundantsolving ? this.convergenceRedundant : this.convergence)) ret = SolveStatus.Converged;
    else ret = SolveStatus.Failed;
    A.revertParams(); B.revertParams();
    return ret;
  }

  applySolution(): void {
    for (let cid = 0; cid < this.subSystems.length; cid++) {
      this.subSystemsAux[cid]?.applySolution();
      this.subSystems[cid]?.applySolution();
      for (const k of Array.from(this.reductionmaps[cid].keys()).sort(byId)) k.v = this.reductionmaps[cid].get(k)!.v;
    }
    for (const d of this.drivenConstraints) d.evaluate();
  }
  undoSolution(): void { this.resetToReference(); }

  diagnose(): number {
    this.hasDiagnosis = false;
    if (!this.hasUnknowns) { this.dofs = -1; return this.dofs; }
    if (!this.plist.length || this.plist.length - this.pdrivenlist.length === 0) { this.hasDiagnosis = true; this.emptyDiagnoseMatrix = true; this.dofs = 0; return 0; }
    this.redundant.clear(); this.conflictingTags = []; this.redundantTags = []; this.partiallyRedundantTags = [];
    // makeReducedJacobian
    const pdiag = this.plist.filter((p) => this.pdrivenlist.indexOf(p) < 0);
    const rowsOf: Constraint[] = [], jmap = new Map<number, number>(), tagmult = new Map<number, number>();
    this.clist.forEach((c, all) => {
      c.revertParams();
      if (c.tag >= 0 && c.driving) {
        rowsOf.push(c); jmap.set(rowsOf.length - 1, all);
        tagmult.set(c.tag, tagmult.has(c.tag) ? tagmult.get(c.tag)! + 1 : 0);
      }
    });
    this.hasDiagnosis = true;
    this.dofs = pdiag.length;
    if (!rowsOf.length) return this.dofs;
    this.emptyDiagnoseMatrix = false;
    // makeDenseQRDecomposition on J^T (params x constraints)
    const JT = new Mat(pdiag.length, rowsOf.length);
    rowsOf.forEach((c, i) => pdiag.forEach((p, j) => JT.set(j, i, c.grad(p))));
    const qr = new FullPivHouseholderQR(JT);
    qr.threshold = this.qrpivotThreshold;
    const rank = qr.rank(), paramsNum = qr.rows(), constrNum = qr.cols();
    const R = new Mat(Math.min(paramsNum, constrNum), constrNum);
    for (let j = 0; j < constrNum; j++) for (let i = 0; i < R.r; i++) if (i <= j) R.set(i, j, qr.qr.get(i, j));
    this.dofs = paramsNum - rank;
    if (constrNum > rank) {
      const nonred = this.identifyConflictingRedundant(qr, jmap, tagmult, pdiag, R, constrNum, rank);
      if (paramsNum === rank && nonred > rank) this.dofs = paramsNum - nonred;
    }
    return this.dofs;
  }

  private identifyConflictingRedundant(qr: FullPivHouseholderQR, jmap: Map<number, number>, tagmult: Map<number, number>, pdiag: Param[], R: Mat, constrNum: number, rank: number): number {
    // eliminateNonZerosOverPivotInUpperTriangularMatrix
    for (let i = 1; i < rank; i++) {
      for (let row = 0; row < i; row++) {
        if (Math.abs(R.get(row, i)) > 1e-10) { const coef = R.get(row, i) / R.get(i, i); for (let c = i + 1; c < R.c; c++) R.add(row, c, -coef * R.get(i, c)); }
        R.set(row, i, 0);
      }
    }
    let groups: Constraint[][] = [];
    for (let j = rank; j < constrNum; j++) {
      const g: Constraint[] = [];
      for (let row = 0; row < rank; row++) if (Math.abs(R.get(row, j)) > 1e-10) g.push(this.clist[jmap.get(qr.colsPerm[row])!]);
      g.push(this.clist[jmap.get(qr.colsPerm[j])!]);
      groups.push(g);
    }
    const skipped = new Set<Constraint>(), satisfied = new Set<number>();
    for (;;) {
      const conflicting = new Map<Constraint, Set<number>>();
      groups.forEach((g, i) => { if (satisfied.has(i)) return; for (const c of g) if (c.tag !== 0 && !c.internalAlignment) { let s = conflicting.get(c); if (!s) conflicting.set(c, s = new Set()); s.add(i); } });
      if (!conflicting.size) break;
      // std::map<Constraint*> iterates in address order: creation order here
      const entries = Array.from(conflicting).sort((a, b) => a[0].seq - b[0].seq);
      let best = entries[0];
      for (const e of entries.slice(1)) {
        const s1 = best[1].size, s2 = e[1].size, t1 = best[0].tag, t2 = e[0].tag;
        if (s2 > s1 || (s2 === s1 && tagmult.get(t2)! < tagmult.get(t1)!) || (s2 === s1 && tagmult.get(t2) === tagmult.get(t1) && t2 > t1)) best = e;
      }
      if (!(best[1].size > 0)) continue;
      const tag = best[0].tag;
      for (const [c, s] of entries) { if (c.tag !== tag) continue; skipped.add(c); for (const i of s) satisfied.add(i); }
    }
    const tmp = this.clist.filter((c) => c.driving && !skipped.has(c));
    const sub = new SubSystem(tmp, pdiag);
    const res = this.solveDL(sub, true);
    if (res === SolveStatus.Success) {
      sub.applySolution();
      for (const c of Array.from(skipped).sort((a, b) => a.seq - b.seq)) { const err = c.error(); if (err * err < this.convergenceRedundant) this.redundant.add(c); }
      this.resetToReference();
      const orig = groups; groups = [];
      for (let i = orig.length - 1; i >= 0; i--) { if (!orig[i].some((c) => this.redundant.has(c))) { groups.push(orig[i]); continue; } constrNum--; }
    }
    const conflictingTags = new Set<number>();
    for (const g of groups) for (const c of g) conflictingTags.add(c.internalAlignment ? 0 : c.tag);
    conflictingTags.delete(0);
    this.conflictingTags = Array.from(conflictingTags).sort((a, b) => a - b);
    const red = new Set<number>(), partial = new Set<number>();
    for (const c of this.redundant) { red.add(c.tag); partial.add(c.tag); }
    for (const c of this.clist) if (!this.redundant.has(c)) red.delete(c.tag);
    this.redundantTags = Array.from(red).sort((a, b) => a - b);
    for (const r of red) partial.delete(r);
    this.partiallyRedundantTags = Array.from(partial).sort((a, b) => a - b);
    return constrNum;
  }
}
