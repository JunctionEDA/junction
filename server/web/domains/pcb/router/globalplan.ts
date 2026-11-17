// Global routing before the detailed search: the board is cut into square tiles, every connection gets a coarse path
// over the tile graph with negotiated congestion, its layers are assigned along that path, and the detailed router is
// then steered by the result: the path's tiles and a ring round them are its corridor, and each tile has the layer the
// plan put it on.
//
// Ported from Copper's router v2 (src/copper_kicad/pcb/v2/globalroute.py and tiles.py; MIT licence,
// github.com/claynicholson/copper-kicad-mcp):
// - tile graph: a node is (layer, tile); neighbouring tiles of a layer share a border whose capacity is the number of
//   reference tracks (width + clearance) its free stretches carry, and a column's via capacity is how many vias fit in
//   the tile.  Copper measures the borders on exact geometry; here they are read off the detailed router's own
//   occupancy maps for the most common rule class, so the two see the same obstacles;
// - negotiated congestion (PathFinder): every connection is laid on the tile graph, then for a few rounds the ones on
//   an overflowing border, via column or forced crossing are laid again with a present-congestion factor that grows
//   1.5 times a round and a history cost that stays on what overflowed; the round with the least overflow is kept;
// - crossings: two paths of different nets that share a run of tiles on a layer must cross iff the second leaves the
//   first on its left at one end of the run and on its right at the other; a forced crossing counts as overflow and
//   puts history on the run.  Inside the search, a step pays for the traffic straight across it (the cheap price);
// - layer assignment: a Viterbi pass over each coarse path (state: layer and vias used so far) against the final
//   congestion picture, kept only when it adds no overflow and no crossing.
// The coarse search is plain Dijkstra (no A*: the owner's rule); the detailed router keeps its own line search.
// Not ported: waypoints, buses, tees onto another connection's path, regions and the calibration of capacities.
import { viaFits, type Grid, type Pt } from "./grid";

export interface PlanConn { id: number; net: string; a: { p: Pt; layers: number[] }; b: { p: Pt; layers: number[] }; demand: number }
export interface PlanInput {
  G: Grid; maps: Uint16Array[]; vmaps: Uint16Array[];   // the reference class's occupancy maps (what was on the board before the run)
  pitch: number; viaPitch: number;                      // reference track width + clearance; via diameter + clearance (mm)
  pref: number[];                                       // per layer: +1 runs horizontally, -1 vertically (route.ts)
  viaMm: number;                                        // what a via costs, in mm of track
  tile?: number; iters?: number; maxMs?: number;
}
/** A connection's corridor: per tile 1 when the detailed route may run there, and the layer the plan put it on (-1: any). */
export interface Corridor { tiles: Uint8Array; layer: Int8Array; vias: number; overflow: number; path: number[] }
export interface PlanResult {
  k: number; T: number; nx: number; ny: number; corridors: Map<number, Corridor>;
  iterations: number; overflowFirst: number; overflow: number; crossings: number; relayered: number; ms: number;
}

const WALL = 8, WALL_VIA = 2;      // extra cost factor of a border without capacity / a column without a via site (soft)
const DIR_BIAS = 0.3;              // a step against its layer's direction costs this much more (times |pref|)
const MAX_ITERS = 16, BOX_MARGIN = 8;
const MAX_DP_VIAS = 6, TURN_AT_TRAFFIC = 1;
const INF = Infinity;

export function plan(inp: PlanInput, conns: PlanConn[]): PlanResult {
  const t0 = Date.now(); const { G } = inp; const g = G.g;
  const k = Math.max(4, Math.round((inp.tile || 2.5) / g)), T = k * g;
  const nx = Math.max(1, Math.ceil(G.W / k)), ny = Math.max(1, Math.ceil(G.H / k)), GT = nx * ny, L = G.layers.length, N = GT * L;
  const p = inp.pitch, rt = G.routable;
  // ---- capacities (mm of reference pitch) from the free stretches of each border
  const capE = new Float64Array(N), capN = new Float64Array(N), capV = new Int32Array(GT);
  const tracks = (run: number) => run > 0 ? (Math.floor(((run - 1) * g) / p + 1e-9) + 1) * p : 0;
  for (let l = 0; l < L; l++) {
    if (!rt[l]) continue; const m = inp.maps[l];
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const s = l * GT + ty * nx + tx;
      if (tx + 1 < nx) { const ix = (tx + 1) * k; let cap = 0, run = 0; if (ix < G.W) for (let iy = ty * k; iy < Math.min(G.H, (ty + 1) * k); iy++) { if (!m[iy * G.W + ix]) run++; else { cap += tracks(run); run = 0; } } capE[s] = cap + tracks(run); }
      if (ty + 1 < ny) { const iy = (ty + 1) * k; let cap = 0, run = 0; if (iy < G.H) for (let ix = tx * k; ix < Math.min(G.W, (tx + 1) * k); ix++) { if (!m[iy * G.W + ix]) run++; else { cap += tracks(run); run = 0; } } capN[s] = cap + tracks(run); }
    }
  }
  const per = Math.max(1, (inp.viaPitch * inp.viaPitch) / (g * g));
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    let n = 0; for (let iy = ty * k; iy < Math.min(G.H, (ty + 1) * k); iy++) for (let ix = tx * k; ix < Math.min(G.W, (tx + 1) * k); ix++) { const gi = iy * G.W + ix; if (!(G.outside && G.outside[gi]) && viaFits(G, inp.vmaps, gi)) n++; }
    capV[ty * nx + tx] = Math.floor(n / per);
  }
  // ---- negotiation state
  const useE = new Float64Array(N), useN = new Float64Array(N), useV = new Int32Array(GT);
  const histE = new Float64Array(N), histN = new Float64Array(N), histV = new Float64Array(GT), histX = new Float64Array(N);
  const hT = new Float64Array(N), vT = new Float64Array(N);   // straight-through traffic per node, east-west / north-south (mm)
  const shared = new Map<number, Map<string, { n: number; d: number }>>();   // border -> net -> how many of its paths cross it (a net pays once)
  const paths = new Map<number, number[]>(); const byId = new Map(conns.map((c) => [c.id, c]));
  let anyX = false, pres = 0, margin = BOX_MARGIN;
  const tileOf = (q: Pt): number => { const tx = Math.min(nx - 1, Math.max(0, Math.floor((q[0] - G.ox) / g / k))), ty = Math.min(ny - 1, Math.max(0, Math.floor((q[1] - G.oy) / g / k))); return ty * nx + tx; };
  const layersOf = (ls: number[]) => { const out = ls.filter((l) => l >= 0 && l < L && rt[l]); return out.length ? out : rt.map((r, l) => r ? l : -1).filter((l) => l >= 0); };
  const netOn = (code: number, net: string) => { const m = shared.get(code); return !!m && (m.get(net)?.n || 0) > 0; };
  const apply = (c: PlanConn, path: number[], sign: number) => {
    let pd = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1]; let st = b - a; const lo = Math.min(a, b), df = Math.abs(st);
      if (df >= GT) { useV[lo % GT] += sign; st = 0; }
      else {
        const vert = df === nx && ((a % GT) % nx) === ((b % GT) % nx); const code = lo * 2 + (vert ? 1 : 0);
        let m = shared.get(code); if (!m) shared.set(code, m = new Map()); const e = m.get(c.net) || { n: 0, d: c.demand };
        if (sign > 0) { if (!e.n) { e.d = c.demand; (vert ? useN : useE)[lo] += e.d; } e.n++; m.set(c.net, e); }
        else { e.n--; if (!e.n) { (vert ? useN : useE)[lo] -= e.d; m.delete(c.net); } }
        if (st === pd) (vert ? vT : hT)[a] += sign * c.demand;
      }
      pd = st;
    }
  };
  // ---- one step's price
  const ecost = (l: number, ra: number, rb: number, c: PlanConn, pr: number): number => {
    const lo = ra < rb ? ra : rb, vert = Math.abs(rb - ra) === nx && (ra % nx) === (rb % nx), s = l * GT + lo, code = s * 2 + (vert ? 1 : 0);
    const cap = vert ? capN[s] : capE[s], use = vert ? useN[s] : useE[s], hist = vert ? histN[s] : histE[s];
    const pf = inp.pref[l] || 0; const against = vert ? Math.max(0, pf) : Math.max(0, -pf);
    let cost = T * (1 + DIR_BIAS * against) * (1 + hist + (cap <= 0 ? WALL : 0));
    const o = netOn(code, c.net) ? use - cap : use + c.demand - cap;
    if (pr && o > 0) cost *= 1 + pr * o / p;
    const sa = l * GT + ra, sb = l * GT + rb;
    if (pr) { const other = vert ? hT : vT; const x = (other[sa] + other[sb]) / 2; if (x > 0) cost *= 1 + pr * Math.min(x, c.demand) / p; }
    if (anyX) cost *= 1 + histX[sa] + histX[sb];
    return cost;
  };
  const vcost = (r: number, pr: number): number => { let v = inp.viaMm * (1 + histV[r] + (capV[r] <= 0 ? WALL_VIA : 0)); const o = useV[r] + 1 - capV[r]; if (pr && o > 0) v *= 1 + pr * o; return v; };
  // ---- Dijkstra over the tile graph (inside a box round the terminals, the whole board when that finds nothing)
  const dist = new Float64Array(N), prev = new Int32Array(N), seen = new Int32Array(N); let gen = 0;
  const hk: number[] = [], hn: number[] = [];
  const push = (key: number, n: number) => { let i = hk.length; hk.push(key); hn.push(n); while (i > 0) { const j = (i - 1) >> 1; if (hk[j] <= key) break; hk[i] = hk[j]; hn[i] = hn[j]; i = j; } hk[i] = key; hn[i] = n; };
  const pop = (): number => { const top = hn[0]; const lk = hk.pop()!, ln = hn.pop()!; const n = hk.length; if (n) { let i = 0; for (;;) { let j = 2 * i + 1; if (j >= n) break; if (j + 1 < n && hk[j + 1] < hk[j]) j++; if (hk[j] >= lk) break; hk[i] = hk[j]; hn[i] = hn[j]; i = j; } hk[i] = lk; hn[i] = ln; } return top; };
  const search = (c: PlanConn, pr: number, box: number[] | null): number[] | null => {
    gen++; hk.length = 0; hn.length = 0;
    const ra = tileOf(c.a.p), rb = tileOf(c.b.p); const tgt = new Set(layersOf(c.b.layers).map((l) => l * GT + rb));
    for (const l of layersOf(c.a.layers)) { const n = l * GT + ra; seen[n] = gen; dist[n] = 0; prev[n] = -1; push(0, n); }
    const relax = (n: number, m: number, w: number) => { if (w === INF) return; const d = dist[n] + w; if (seen[m] !== gen || d < dist[m] - 1e-12) { seen[m] = gen; dist[m] = d; prev[m] = n; push(d, m); } };
    while (hk.length) {
      const key = hk[0], n = pop(); if (key > dist[n] + 1e-12) continue;
      if (tgt.has(n)) { const out: number[] = []; for (let x = n; x >= 0; x = prev[x]) out.push(x); return out.reverse(); }
      const l = (n / GT) | 0, r = n - l * GT, tx = r % nx, ty = (r / nx) | 0;
      const inBox = (x: number, y: number) => x >= 0 && y >= 0 && x < nx && y < ny && (!box || (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]));
      if (inBox(tx + 1, ty)) relax(n, n + 1, ecost(l, r, r + 1, c, pr));
      if (inBox(tx - 1, ty)) relax(n, n - 1, ecost(l, r, r - 1, c, pr));
      if (inBox(tx, ty + 1)) relax(n, n + nx, ecost(l, r, r + nx, c, pr));
      if (inBox(tx, ty - 1)) relax(n, n - nx, ecost(l, r, r - nx, c, pr));
      for (let l2 = 0; l2 < L; l2++) if (l2 !== l && rt[l2]) relax(n, l2 * GT + r, vcost(r, pr));
    }
    return null;
  };
  const route = (c: PlanConn, pr: number): boolean => {
    const ra = tileOf(c.a.p), rb = tileOf(c.b.p);
    const box = [Math.min(ra % nx, rb % nx) - margin, Math.min((ra / nx) | 0, (rb / nx) | 0) - margin, Math.max(ra % nx, rb % nx) + margin, Math.max((ra / nx) | 0, (rb / nx) | 0) + margin];
    const path = search(c, pr, box) || search(c, pr, null); if (!path) return false;
    paths.set(c.id, path); apply(c, path, 1); return true;
  };
  const rip = (c: PlanConn) => { const q = paths.get(c.id); if (q) { apply(c, q, -1); paths.delete(c.id); } };
  // ---- forced same-layer crossings: [(over mm, nodes of the shared run, id, id)]
  const crossings = (only?: number): [number, number[], number, number][] => {
    const occ = new Map<number, number[]>(); const mine = only !== undefined ? new Set(paths.get(only) || []) : null;
    for (const [id, q] of paths) for (const n of q) if (!mine || mine.has(n)) { let l = occ.get(n); if (!l) occ.set(n, l = []); if (l[l.length - 1] !== id) l.push(id); }
    const pairs = new Map<string, number[]>();
    for (const [n, ids] of occ) if (ids.length > 1) for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const x = Math.min(ids[i], ids[j]), y = Math.max(ids[i], ids[j]); if (byId.get(x)!.net === byId.get(y)!.net || (only !== undefined && x !== only && y !== only)) continue;
      const key = x + "," + y; let l = pairs.get(key); if (!l) pairs.set(key, l = []); l.push(n);
    }
    const out: [number, number[], number, number][] = []; const pos = new Map<number, Map<number, number>>();
    const posOf = (id: number) => { let m = pos.get(id); if (!m) { m = new Map(); paths.get(id)!.forEach((n, i) => m!.set(n, i)); pos.set(id, m); } return m; };
    const xy = (n: number) => { const r = n % GT; return [r % nx, (r / nx) | 0]; };
    for (const [key, nodes] of pairs) {
      const [ip, iq] = key.split(",").map(Number); const P = paths.get(ip)!, Q = paths.get(iq)!; const pp = posOf(ip), pq = posOf(iq);
      const common = nodes.map((n) => pp.get(n)!).sort((a, b) => a - b);
      for (let kk = 0; kk < common.length;) {
        const i = common[kk]; let j = i;
        while (kk + 1 < common.length && common[kk + 1] === j + 1 && Math.abs(P[j + 1] - P[j]) < GT && Math.abs(pq.get(P[j + 1])! - pq.get(P[j])!) === 1) { j++; kk++; }
        kk++;
        if (i === 0 || j === P.length - 1) continue;
        const a = P[i - 1], b = P[j + 1], t0 = P[i], tm = P[j]; if (Math.abs(t0 - a) >= GT || Math.abs(b - tm) >= GT) continue;
        const qi = pq.get(t0)!, qj = pq.get(tm)!; let ci: number, di: number;
        if (i === j) { ci = qi - 1; di = qi + 1; } else { const dq = qj > qi ? 1 : -1; ci = qi - dq; di = qj + dq; }
        if (ci < 0 || di < 0 || ci >= Q.length || di >= Q.length) continue;
        const cc = Q[ci], dd = Q[di]; if (Math.abs(cc - t0) >= GT || Math.abs(dd - tm) >= GT || cc === a || dd === b) continue;
        const [ax, ay] = xy(a), [bx, by] = xy(b), [x0, y0] = xy(t0), [xm, ym] = xy(tm), [x1, y1] = xy(P[i + 1]), [xl, yl] = xy(P[j - 1]), [cx, cy] = xy(cc), [dx, dy] = xy(dd);
        let ux = (x0 - ax) + (x1 - x0), uy = (y0 - ay) + (y1 - y0); const s0 = ux * (cy - y0) - uy * (cx - x0);
        ux = (xm - xl) + (bx - xm); uy = (ym - yl) + (by - ym); const sm = ux * (dy - ym) - uy * (dx - xm);
        if (s0 * sm < 0) out.push([Math.min(byId.get(ip)!.demand, byId.get(iq)!.demand), P.slice(i, j + 1), ip, iq]);
      }
    }
    return out;
  };
  const pv = inp.viaPitch;
  const overflow = () => {
    let tot = 0; const edges: [number, number][] = [], cols: [number, number][] = [];
    for (let s = 0; s < N; s++) {
      if (useE[s] > 1e-9) { const o = useE[s] - capE[s]; if (o > 1e-6) { tot += o; edges.push([o, s * 2]); } }
      if (useN[s] > 1e-9) { const o = useN[s] - capN[s]; if (o > 1e-6) { tot += o; edges.push([o, s * 2 + 1]); } }
    }
    for (let r = 0; r < GT; r++) if (useV[r] > 0) { const o = useV[r] - capV[r]; if (o > 0) { tot += o * pv; cols.push([o, r]); } }
    const xruns = crossings(); for (const x of xruns) tot += x[0];
    return { tot, edges, cols, xruns };
  };
  const wire = () => { let w = 0; for (const q of paths.values()) for (let i = 0; i + 1 < q.length; i++) w += Math.abs(q[i + 1] - q[i]) >= GT ? inp.viaMm : T; return w; };
  const codesOf = (q: number[]) => { const out: number[] = []; for (let i = 0; i + 1 < q.length; i++) { const a = q[i], b = q[i + 1], lo = Math.min(a, b), df = Math.abs(b - a); if (df >= GT) out.push(-1 - (lo % GT)); else out.push(lo * 2 + (df === nx && (a % nx) === (b % nx) ? 1 : 0)); } return out; };
  // ---- negotiation
  const maxIters = Math.max(1, inp.iters || MAX_ITERS), maxMs = inp.maxMs || 8000;
  for (const c of conns) route(c, 0);
  let ov = overflow(); const first = ov.tot;
  let best = { tot: ov.tot, wire: wire(), paths: new Map(paths) }; let its = 1;
  for (let it = 0; ov.tot > 1e-6 && its < maxIters && Date.now() - t0 < maxMs; it++) {
    pres = 0.5 * Math.pow(1.5, it); margin = BOX_MARGIN + 2 * (it + 1);
    const hot = new Set<number>();
    for (const [o, code] of ov.edges) { hot.add(code); const s = code >> 1; if (code & 1) histN[s] += o / p; else histE[s] += o / p; }
    for (const [o, r] of ov.cols) { histV[r] += o; hot.add(-1 - r); }
    const hotx = new Set<number>(); for (const [o, run, a, b] of ov.xruns) { for (const n of run) histX[n] += o / p; hotx.add(a); hotx.add(b); anyX = true; }
    const redo = conns.filter((c) => { const q = paths.get(c.id); if (!q) return true; return hotx.has(c.id) || codesOf(q).some((x) => hot.has(x)); });
    if (!redo.length) break;
    for (const c of redo) { const old = paths.get(c.id); rip(c); if (!route(c, pres) && old) { paths.set(c.id, old); apply(c, old, 1); } if (Date.now() - t0 > maxMs) break; }
    its++; ov = overflow(); const w = wire();
    if (ov.tot < best.tot - 1e-9 || (Math.abs(ov.tot - best.tot) <= 1e-9 && w < best.wire)) best = { tot: ov.tot, wire: w, paths: new Map(paths) };
  }
  if (best.paths !== paths) { for (const c of conns) rip(c); for (const [id, q] of best.paths) { paths.set(id, q); apply(byId.get(id)!, q, 1); } }
  // ---- layer assignment: Viterbi over each coarse path (state: layer, vias so far) against the final congestion
  const assign = (c: PlanConn, cols: number[], start: number[], end: number[]): number[] | null => {
    const n = cols.length, VM = MAX_DP_VIAS, S = L * (VM + 1); const lays = rt.map((r, l) => r ? l : -1).filter((l) => l >= 0);
    let cur = new Float64Array(S).fill(INF); for (const l of start) cur[l * (VM + 1)] = 0;
    const back: Int32Array[] = [];   // per position: the state it came from (-1: start), and whether a via was taken (encoded +S)
    for (let i = 0; i < n; i++) {
      const r = cols[i]; const here = new Float64Array(S).fill(INF), from = new Int32Array(S).fill(-1);
      const turn = i > 0 && i < n - 1 && (cols[i] - cols[i - 1]) !== (cols[i + 1] - cols[i]);
      for (let st = 0; st < S; st++) { if (cur[st] === INF) continue; const l = (st / (VM + 1)) | 0; let gc = cur[st]; if (turn && hT[l * GT + r] + vT[l * GT + r] > 1e-6) gc += inp.viaMm * TURN_AT_TRAFFIC; if (gc < here[st]) { here[st] = gc; from[st] = st; } }
      const vc = vcost(r, pres);
      for (let st = 0; st < S; st++) { if (cur[st] === INF) continue; const l = (st / (VM + 1)) | 0, v = st % (VM + 1); if (v >= VM) continue;
        for (const l2 of (i < n - 1 ? lays : end)) { if (l2 === l) continue; const s2 = l2 * (VM + 1) + v + 1, gc = cur[st] + vc; if (gc < here[s2] - 1e-12) { here[s2] = gc; from[s2] = st + S; } } }
      back.push(from);
      if (i === n - 1) { cur = here; break; }
      const nxt = new Float64Array(S).fill(INF); let any = false;
      for (let st = 0; st < S; st++) { if (here[st] === INF) continue; const l = (st / (VM + 1)) | 0; const e = ecost(l, r, cols[i + 1], c, pres); if (e === INF) continue; nxt[st] = here[st] + e; any = true; }
      if (!any) return null; cur = nxt;
    }
    let bs = -1; for (let st = 0; st < S; st++) if (cur[st] < INF && end.includes((st / (VM + 1)) | 0) && (bs < 0 || cur[st] < cur[bs])) bs = st;
    if (bs < 0) return null;
    const out: number[][] = []; let st = bs;
    for (let i = n - 1; i >= 0; i--) { const f = back[i][st]; const l = (st / (VM + 1)) | 0; if (f >= S) { const l0 = (((f - S) / (VM + 1)) | 0); out.push([l0 * GT + cols[i], l * GT + cols[i]]); st = f - S; } else { out.push([l * GT + cols[i]]); st = f < 0 ? st : f; } }
    return out.reverse().flat();
  };
  const overAt = (...qs: number[][]) => { let tot = 0; for (const code of new Set(qs.flatMap(codesOf))) { if (code < 0) { const r = -1 - code; const o = useV[r] - capV[r]; if (o > 0) tot += o * pv; } else { const s = code >> 1; const o = (code & 1 ? useN[s] - capN[s] : useE[s] - capE[s]); if (o > 1e-6) tot += o; } } return tot; };
  const crossOf = (id: number) => crossings(id).reduce((s, x) => s + x[0], 0);
  let relayered = 0;
  for (const c of conns) {
    const q = paths.get(c.id); if (!q || q.length < 2) continue;
    const cols: number[] = []; for (const n of q) { const r = n % GT; if (cols[cols.length - 1] !== r) cols.push(r); }
    const start = layersOf(c.a.layers), end = layersOf(c.b.layers);
    apply(c, q, -1); const nq = assign(c, cols, start, end); apply(c, q, 1);
    if (!nq || nq.join() === q.join()) continue;
    const before = overAt(q, nq) + crossOf(c.id);
    apply(c, q, -1); apply(c, nq, 1); paths.set(c.id, nq);
    if (overAt(q, nq) + crossOf(c.id) > before + 1e-9) { apply(c, nq, -1); apply(c, q, 1); paths.set(c.id, q); } else relayered++;
  }
  // ---- corridors: the path's tiles and a ring round them; the layer each tile is left on (any where it changes layer)
  ov = overflow(); const overOf = new Map<number, number>(); for (const [o, , a, b] of ov.xruns) { overOf.set(a, (overOf.get(a) || 0) + o); overOf.set(b, (overOf.get(b) || 0) + o); }
  const corridors = new Map<number, Corridor>();
  for (const c of conns) {
    const q = paths.get(c.id); if (!q) continue;
    const tiles = new Uint8Array(GT), layer = new Int8Array(GT).fill(-2); let vias = 0;
    for (let i = 0; i < q.length; i++) {
      const r = q[i] % GT, l = (q[i] / GT) | 0; const tx = r % nx, ty = (r / nx) | 0;
      for (let y = Math.max(0, ty - 1); y <= Math.min(ny - 1, ty + 1); y++) for (let x = Math.max(0, tx - 1); x <= Math.min(nx - 1, tx + 1); x++) tiles[y * nx + x] = 1;
      if (i > 0 && q[i - 1] % GT === r) vias++;
      layer[r] = layer[r] === -2 || layer[r] === l ? l : -1;
    }
    for (let r = 0; r < GT; r++) if (layer[r] === -2) layer[r] = -1;
    corridors.set(c.id, { tiles, layer, vias, overflow: (overOf.get(c.id) || 0) + overAt(q), path: q });
  }
  return { k, T, nx, ny, corridors, iterations: its, overflowFirst: first, overflow: ov.tot, crossings: ov.xruns.length, relayered, ms: Date.now() - t0 };
}
