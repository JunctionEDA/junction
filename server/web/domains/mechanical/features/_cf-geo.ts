// _cf-geo.ts — the arithmetic the "Patterns & texture" and "Geometry & utilities" custom features share
// (features/cf-geo-*.ts).  Pure: no kernel, no DOM.  Seeded random numbers, a small expression reader for
// equation-driven curves, plane geometry (point in a region, lattices, Voronoi cells, the smallest circle round
// points), NACA four-digit sections, and the catenary a cable hangs in.
import type { Vec2, Vec3 } from "../core/geometry";

// ---------------------------------------------------------------- random numbers

/** Numbers in [0, 1) that are the same for the same seed on every machine (mulberry32). */
export function rng(seed: number): () => number {
  let a = (Math.round(Number(seed) || 0) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- text → numbers

/** Every number in a text, in order: "1, 2; 3\n4" → [1, 2, 3, 4].  Words (a CSV header) are passed over. */
export function parseNumbers(text: unknown): number[] {
  const out: number[] = [];
  for (const m of String(text ?? "").matchAll(/(?<![A-Za-z_])[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?(?![A-Za-z_])/g)) out.push(Number(m[0]));
  return out.filter((v) => Number.isFinite(v));
}

/** Points from a table of numbers: rows of `width` numbers (x y z, or x y), read across lines, commas, semicolons, tabs. */
export function parsePoints(text: unknown, width: 2 | 3): number[][] {
  const lines = String(text ?? "").split(/[\n\r;]+/).map((l) => parseNumbers(l)).filter((l) => l.length);
  // a real table: rows of at least `width` numbers (extra columns and a title line are passed over)
  const rows = lines.filter((l) => l.length >= width);
  if (lines.length > 1 && rows.length >= 2) return rows.map((l) => l.slice(0, width));
  const flat = lines.flat(), out: number[][] = [];
  for (let i = 0; i + width <= flat.length; i += width) out.push(flat.slice(i, i + width));
  return out;
}

// ---------------------------------------------------------------- expressions of t

const FN: { [name: string]: (...a: number[]) => number } = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log: Math.log10,
  min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  pow: Math.pow, mod: (a, b) => a - b * Math.floor(a / b),
};
const CONST: { [name: string]: number } = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

export type Compiled = (scope: { [name: string]: number }) => number;

/**
 * Read an expression such as "10*cos(2*pi*t) + t^2" once and return a function of its variables.  Angles are in
 * radians.  Throws an Error whose message says what is wrong ("x(t): unknown name “q”").
 */
export function compileExpr(text: unknown, variables: readonly string[], label = "expression"): Compiled {
  const src = String(text ?? "").trim();
  if (!src) throw new Error(`${label} is empty.`);
  const tok = src.match(/\s*(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\*\*|[-+*/^(),])/gy);
  if (!tok || tok.join("").length !== src.length) throw new Error(`${label}: “${src}” has a character that is not understood.`);
  const t = tok.map((s) => s.trim());
  let i = 0;
  const peek = () => t[i], next = () => t[i++];
  const expr = (): Compiled => {
    let l = term();
    for (;;) {
      const op = peek();
      if (op !== "+" && op !== "-") return l;
      next(); const a = l, b = term();
      l = op === "+" ? (s) => a(s) + b(s) : (s) => a(s) - b(s);
    }
  };
  const term = (): Compiled => {
    let l = unary();
    for (;;) {
      const op = peek();
      if (op !== "*" && op !== "/") return l;
      next(); const a = l, b = unary();
      l = op === "*" ? (s) => a(s) * b(s) : (s) => a(s) / b(s);
    }
  };
  const unary = (): Compiled => {
    if (peek() === "-") { next(); const a = unary(); return (s) => -a(s); }
    if (peek() === "+") { next(); return unary(); }
    const base = primary();
    if (peek() === "^" || peek() === "**") { next(); const p = unary(); return (s) => Math.pow(base(s), p(s)); }
    return base;
  };
  const primary = (): Compiled => {
    const x = next();
    if (x === undefined) throw new Error(`${label}: “${src}” ends too soon.`);
    if (x === "(") { const e = expr(); if (next() !== ")") throw new Error(`${label}: a “)” is missing.`); return e; }
    if (/^[\d.]/.test(x)) { const v = Number(x); return () => v; }
    if (/^[A-Za-z_]/.test(x)) {
      if (peek() === "(") {
        const f = FN[x.toLowerCase()];
        if (!f) throw new Error(`${label}: there is no function “${x}”.`);
        next();
        const args: Compiled[] = [];
        if (peek() !== ")") { args.push(expr()); while (peek() === ",") { next(); args.push(expr()); } }
        if (next() !== ")") throw new Error(`${label}: a “)” is missing.`);
        return (s) => f(...args.map((a) => a(s)));
      }
      if (variables.includes(x)) return (s) => s[x];
      const c = CONST[x.toLowerCase()];
      if (c !== undefined) return () => c;
      throw new Error(`${label}: unknown name “${x}”. Use ${variables.join(", ")}, pi, and functions such as sin, cos, sqrt.`);
    }
    throw new Error(`${label}: “${x}” is not expected there.`);
  };
  const out = expr();
  if (i < t.length) throw new Error(`${label}: “${t[i]}” is not expected there.`);
  return out;
}

// ---------------------------------------------------------------- plane geometry

export type Loop2 = Vec2[];
/** A region of a plane: its outer loop first, then its holes, each a closed polygon (the last point joins the first). */
export type Region2 = Loop2[];

export function loopArea(l: Loop2): number {
  let a = 0;
  for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}
export function inLoop(l: Loop2, p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
    const a = l[i], b = l[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
export function distToLoops(r: Region2, p: Vec2): number {
  let d = Infinity;
  for (const l of r) for (let i = 0; i < l.length; i++) d = Math.min(d, distToSegment(p, l[i], l[(i + 1) % l.length]));
  return d;
}
/** Inside the outer loop, outside every hole, and at least `margin` from all of them. */
export function inRegion(r: Region2, p: Vec2, margin = 0): boolean {
  if (!r.length || !inLoop(r[0], p)) return false;
  for (let i = 1; i < r.length; i++) if (inLoop(r[i], p)) return false;
  return margin <= 0 || distToLoops(r, p) >= margin - 1e-9;
}
export function boundsOf(pts: readonly Vec2[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  return [x0, y0, x1, y1];
}

export type Layout = "grid" | "hex" | "staggered";
export const LAYOUT_OPTIONS = [{ value: "grid", label: "Grid" }, { value: "hex", label: "Hex" }, { value: "staggered", label: "Staggered" }];

export interface LatticePoint { at: Vec2; i: number; j: number; key: string }

/**
 * The lattice points inside a box.  `anchor` is the point i = j = 0.  Grid: `a` along the first direction, `b`
 * along the second.  Hex: every other row moved half a pitch and the rows a·√3/2 apart (equal distance to all
 * six neighbours).  Staggered: every other row moved half a pitch, the rows `b` apart.  `angle` (radians) turns
 * the whole lattice about the anchor.  A point's key names its place ("g2.-1"), so it does not change when the
 * box does.
 */
export function lattice(layout: Layout, a: number, b: number, angle: number, anchor: Vec2, box: readonly [number, number, number, number], limit = 20000): LatticePoint[] {
  const row = layout === "hex" ? (a * Math.sqrt(3)) / 2 : b;
  const c = Math.cos(angle), s = Math.sin(angle);
  // the box's corners in lattice coordinates
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const x of [box[0], box[2]]) for (const y of [box[1], box[3]]) {
    const dx = x - anchor[0], dy = y - anchor[1], u = dx * c + dy * s, v = -dx * s + dy * c;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const out: LatticePoint[] = [];
  const j0 = Math.ceil(v0 / row - 1e-9), j1 = Math.floor(v1 / row + 1e-9);
  if ((j1 - j0 + 1) * ((u1 - u0) / a + 1) > limit) return out.concat([{ at: anchor, i: NaN, j: NaN, key: "too-many" }]);
  for (let j = j0; j <= j1; j++) {
    const shift = layout !== "grid" && (((j % 2) + 2) % 2) === 1 ? a / 2 : 0;
    const i0 = Math.ceil((u0 - shift) / a - 1e-9), i1 = Math.floor((u1 - shift) / a + 1e-9);
    for (let i = i0; i <= i1; i++) {
      const u = i * a + shift, v = j * row;
      const x = anchor[0] + u * c - v * s, y = anchor[1] + u * s + v * c;
      if (x < box[0] - 1e-9 || x > box[2] + 1e-9 || y < box[1] - 1e-9 || y > box[3] + 1e-9) continue;
      out.push({ at: [x, y], i, j, key: `g${i}.${j}` });
    }
  }
  return out;
}

/** Points at least `spacing` apart, thrown at random into a region (`tries` throws per point wanted). */
export function scatter(region: Region2, count: number, spacing: number, margin: number, random: () => number, keepOut: readonly Vec2[] = []): Vec2[] {
  const [x0, y0, x1, y1] = boundsOf(region[0]);
  const out: Vec2[] = [];
  const cell = Math.max(spacing, 1e-9), grid = new Map<string, Vec2[]>();
  const keyOf = (p: Vec2) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
  const put = (p: Vec2) => { const k = keyOf(p); const g = grid.get(k); if (g) g.push(p); else grid.set(k, [p]); };
  const free = (p: Vec2): boolean => {
    if (!(spacing > 0)) return true;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get(`${cx + i},${cy + j}`) || []) if (Math.hypot(q[0] - p[0], q[1] - p[1]) < spacing) return false;
    return true;
  };
  for (const p of keepOut) put(p);
  for (let tries = 0; out.length < count && tries < count * 60 + 200; tries++) {
    const p: Vec2 = [x0 + random() * (x1 - x0), y0 + random() * (y1 - y0)];
    if (!inRegion(region, p, margin) || !free(p)) continue;
    out.push(p); put(p);
  }
  return out;
}

/** A convex polygon cut by the half-plane { q : (q − at)·n ≤ 0 }. */
export function clipHalfPlane(poly: Loop2, at: Vec2, n: Vec2): Loop2 {
  const out: Loop2 = [];
  const side = (p: Vec2) => (p[0] - at[0]) * n[0] + (p[1] - at[1]) * n[1];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/**
 * The Voronoi cell of each site inside a box, each pulled in by `gap` / 2 from its neighbours (so the walls
 * between cells are `gap` wide) and by `gap` / 2 from the box.  A cell that vanishes is an empty polygon.
 */
export function voronoiCells(sites: readonly Vec2[], box: readonly [number, number, number, number], gap: number): Loop2[] {
  const h = gap / 2;
  return sites.map((s, i) => {
    let poly: Loop2 = [[box[0] + h, box[1] + h], [box[2] - h, box[1] + h], [box[2] - h, box[3] - h], [box[0] + h, box[3] - h]];
    const others = sites.map((o, j) => ({ j, d: Math.hypot(o[0] - s[0], o[1] - s[1]) })).filter((o) => o.j !== i && o.d > 1e-9).sort((a, b) => a.d - b.d);
    for (const { j, d } of others) {
      if (poly.length < 3) break;
      // a site further than twice the cell's reach cannot cut it
      let reach = 0; for (const p of poly) reach = Math.max(reach, Math.hypot(p[0] - s[0], p[1] - s[1]));
      if (d / 2 - h > reach) break;
      const o = sites[j], n: Vec2 = [(o[0] - s[0]) / d, (o[1] - s[1]) / d];
      poly = clipHalfPlane(poly, [s[0] + n[0] * (d / 2 - h), s[1] + n[1] * (d / 2 - h)], n);
    }
    return poly.length >= 3 && Math.abs(loopArea(poly)) > 1e-9 ? poly : [];
  });
}

export function centroid(l: Loop2): Vec2 {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < l.length; i++) { const p = l[i], q = l[(i + 1) % l.length], c = p[0] * q[1] - q[0] * p[1]; a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c; }
  return Math.abs(a) < 1e-12 ? l[0] : [x / (3 * a), y / (3 * a)];
}

/** Take out points closer than `tol` to the one before, and points on a straight run. */
export function tidyLoop(l: Loop2, tol = 1e-7): Loop2 {
  const a = l.filter((p, i) => { const q = l[(i + l.length - 1) % l.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > tol; });
  return a.filter((p, i) => {
    const q = a[(i + a.length - 1) % a.length], r = a[(i + 1) % a.length];
    return Math.abs((p[0] - q[0]) * (r[1] - p[1]) - (p[1] - q[1]) * (r[0] - p[0])) > tol * tol;
  });
}

/** The smallest circle round points (Welzl's algorithm, the order fixed so the answer is repeatable). */
export function smallestCircle(pts: readonly Vec2[]): { c: Vec2; r: number } {
  const p = pts.slice();
  const rand = rng(12345);
  for (let i = p.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const two = (a: Vec2, b: Vec2) => ({ c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2 });
  const three = (a: Vec2, b: Vec2, c: Vec2) => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-14) { const cs = [two(a, b), two(a, c), two(b, c)].sort((x, y) => y.r - x.r); return cs[0]; }
    const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
    const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
    return { c: [x, y] as Vec2, r: Math.hypot(a[0] - x, a[1] - y) };
  };
  const has = (k: { c: Vec2; r: number }, q: Vec2) => Math.hypot(q[0] - k.c[0], q[1] - k.c[1]) <= k.r * (1 + 1e-12) + 1e-12;
  let k = { c: (p[0] || [0, 0]) as Vec2, r: 0 };
  for (let i = 1; i < p.length; i++) {
    if (has(k, p[i])) continue;
    k = { c: p[i], r: 0 };
    for (let j = 0; j < i; j++) {
      if (has(k, p[j])) continue;
      k = two(p[i], p[j]);
      for (let m = 0; m < j; m++) if (!has(k, p[m])) k = three(p[i], p[j], p[m]);
    }
  }
  return k;
}

/** 0 at the attractor, 1 at `radius` and beyond; "smooth" eases in and out. */
export function falloff(distance: number, radius: number, kind: string): number {
  const t = radius > 0 ? Math.max(0, Math.min(1, distance / radius)) : 1;
  return kind === "smooth" ? t * t * (3 - 2 * t) : t;
}

// ---------------------------------------------------------------- airfoils

export interface Airfoil { upper: Vec2[]; lower: Vec2[] }

/**
 * A NACA four-digit section of chord 1: `upper` and `lower` run from the leading edge (0, 0) to the trailing
 * edge.  MPXX: camber M % at P tenths of the chord, thickness XX %.  The thickness is laid square to the camber
 * line, as the series is defined; points are bunched at both ends (cosine spacing).  `closed` uses the
 * coefficient that brings the trailing edge to a point (−0.1036) instead of the original blunt one (−0.1015).
 */
export function naca4(code: unknown, n = 40, closed = true): Airfoil {
  const digits = String(code ?? "").replace(/\D/g, "");
  if (digits.length !== 4) throw new Error("A NACA four-digit section is four digits, such as 2412 or 0012.");
  const m = Number(digits[0]) / 100, p = Number(digits[1]) / 10, t = Number(digits.slice(2)) / 100;
  if (!(t > 0)) throw new Error("The last two digits (the thickness) must be more than 00.");
  if (m > 0 && !(p > 0)) throw new Error("A cambered section needs the place of its camber: the second digit must not be 0.");
  const a4 = closed ? 0.1036 : 0.1015;
  const upper: Vec2[] = [], lower: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((Math.PI * i) / n)) / 2;
    const yt = 5 * t * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - a4 * x ** 4);
    let yc = 0, dy = 0;
    if (m > 0) {
      if (x < p) { yc = (m / (p * p)) * (2 * p * x - x * x); dy = ((2 * m) / (p * p)) * (p - x); }
      else { yc = (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x); dy = ((2 * m) / ((1 - p) * (1 - p))) * (p - x); }
    }
    const th = Math.atan(dy);
    upper.push([x - yt * Math.sin(th), yc + yt * Math.cos(th)]);
    lower.push([x + yt * Math.sin(th), yc - yt * Math.cos(th)]);
  }
  upper[0] = [0, 0]; lower[0] = [0, 0];
  if (closed) { const te: Vec2 = [1, (upper[n][1] + lower[n][1]) / 2]; upper[n] = te; lower[n] = te; }
  return { upper, lower };
}

/**
 * A section from a table of x y pairs.  Selig order (from the trailing edge over the top to the leading edge
 * and back underneath) or Lednicer order (the top from the leading edge, then the bottom from the leading
 * edge) are both read; the chord is scaled to 1 with the leading edge at the origin.
 */
export function airfoilFromTable(text: unknown): Airfoil {
  let pts = parsePoints(text, 2) as Vec2[];
  // a Lednicer file starts with the two point counts
  if (pts.length > 2 && pts[0][0] > 1.5 && pts[0][1] > 1.5) pts = pts.slice(1);
  if (pts.length < 6) throw new Error("The section needs six or more x y pairs.");
  const xs = pts.map((q) => q[0]), x0 = Math.min(...xs), x1 = Math.max(...xs), c = x1 - x0;
  if (!(c > 1e-9)) throw new Error("The section's points are all at one x.");
  const le = xs.indexOf(x0), y0 = pts[le][1];
  const norm = pts.map((q): Vec2 => [(q[0] - x0) / c, (q[1] - y0) / c]);
  let upper: Vec2[], lower: Vec2[];
  if (norm[0][0] > 0.5) { upper = norm.slice(0, le + 1).reverse(); lower = norm.slice(le); }   // Selig
  else {
    // Lednicer: x rises, drops back to the leading edge, rises again
    let brk = 1; while (brk < norm.length && norm[brk][0] >= norm[brk - 1][0]) brk++;
    if (brk >= norm.length - 1) throw new Error("The section must go round the outline: top and bottom.");
    upper = norm.slice(0, brk); lower = norm.slice(brk);
    if (lower[0][0] > 1e-6) lower.unshift([0, 0]);
  }
  const mean = (l: Vec2[]) => l.reduce((s, q) => s + q[1], 0) / l.length;
  if (mean(upper) < mean(lower)) [upper, lower] = [lower, upper];
  if (upper.length < 3 || lower.length < 3) throw new Error("The section must go round the outline: top and bottom.");
  upper[0] = [0, 0]; lower[0] = [0, 0];
  return { upper, lower };
}

/** The area inside a section of chord 1. */
export function airfoilArea(a: Airfoil): number { return Math.abs(loopArea([...a.upper, ...a.lower.slice().reverse()])); }

// ---------------------------------------------------------------- a hanging cable

/**
 * Points along a cable hung between a and b under gravity along `down` (a unit vector).  `length` is the
 * cable's own length; at or under the straight distance it is a straight line.  The curve is the catenary.
 */
export function catenary(a: Vec3, b: Vec3, down: Vec3, cableLength: number, n = 24): Vec3[] {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dv = -(d[0] * down[0] + d[1] * down[1] + d[2] * down[2]);              // how far b is above a
  const hvec: Vec3 = [d[0] + down[0] * dv, d[1] + down[1] * dv, d[2] + down[2] * dv];
  const L = Math.hypot(hvec[0], hvec[1], hvec[2]), chord = Math.hypot(d[0], d[1], d[2]);
  const straight = (): Vec3[] => Array.from({ length: n + 1 }, (_x, i) => [a[0] + (d[0] * i) / n, a[1] + (d[1] * i) / n, a[2] + (d[2] * i) / n] as Vec3);
  if (!(cableLength > chord * (1 + 1e-9)) || L < 1e-9) return straight();
  // 2·c·sinh(L / 2c) = √(S² − dv²): solve for the catenary's parameter c
  const want = Math.sqrt(cableLength * cableLength - dv * dv);
  let lo = L / 2 / 700, hi = L * 1e6;
  for (let i = 0; i < 200; i++) { const mid = Math.sqrt(lo * hi); if (2 * mid * Math.sinh(L / (2 * mid)) > want) lo = mid; else hi = mid; }
  const c = Math.sqrt(lo * hi);
  const x0 = L / 2 - c * Math.atanh(dv / cableLength), y0 = -c * Math.cosh(x0 / c);
  const hx: Vec3 = [hvec[0] / L, hvec[1] / L, hvec[2] / L];
  const out: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (L * i) / n, y = c * Math.cosh((x - x0) / c) + y0;
    out.push([a[0] + hx[0] * x - down[0] * y, a[1] + hx[1] * x - down[1] * y, a[2] + hx[2] * x - down[2] * y]);
  }
  out[n] = b;
  return out;
}

/** How far a cable of this length hangs below the straight line between its ends, at most. */
export function sagOf(a: Vec3, b: Vec3, down: Vec3, cableLength: number): number {
  const pts = catenary(a, b, down, cableLength, 48);
  let sag = 0;
  pts.forEach((p, i) => {
    const f = i / 48, q: Vec3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    sag = Math.max(sag, (p[0] - q[0]) * down[0] + (p[1] - q[1]) * down[1] + (p[2] - q[2]) * down[2]);
  });
  return sag;
}

/** The cable length that hangs `sag` below the straight line between its ends. */
export function lengthForSag(a: Vec3, b: Vec3, down: Vec3, sag: number): number {
  const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  if (!(sag > 0)) return chord;
  let lo = chord, hi = chord + 4 * sag + chord;
  while (sagOf(a, b, down, hi) < sag && hi < chord * 1e3 + 1e6) hi *= 2;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (sagOf(a, b, down, mid) < sag) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
