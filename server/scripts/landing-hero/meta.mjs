// node server/scripts/landing-hero/meta.mjs
//
// Reads the hero's board (server/web/landing/hero/stm32.kicad_pcb, made by build.mjs) with the
// editor's own parser and writes what the hero needs to know to build it up in front of the
// visitor (hero/stm32.json): the parts with a place in the pile below the board, the copper as
// connections in an order they can be routed in (each a run of track on one layer, from a pad or
// from copper that is already there, with the via it ends in), the ground pours and the vias
// that only stitch them, and the silkscreen texts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, '..', '..', 'web', 'landing', 'hero');
const require = createRequire(import.meta.url);
require(path.join(here, '..', '..', 'static', 'kicad-canvas.js'));
const K = globalThis.KiCadCanvas;
const doc = K.parseDoc(fs.readFileSync(path.join(DIR, 'stm32.kicad_pcb'), 'utf8'));
const r3 = (v) => Math.round(v * 1000) / 1000, key = (x, y) => r3(x) + ',' + r3(y);
const netName = (n) => String(doc.nets.get(n) || '');

// ---- the outline
let board = null;
for (const it of doc.items.values()) if (it.kind === 'gr_rect' && it.bbox && /Edge\.Cuts/.test(K.serialize(it.node))) {
  const s = K.kid(it.node, 'start'), e = K.kid(it.node, 'end');
  board = { x: Math.min(+s[1], +e[1]), y: Math.min(+s[2], +e[2]), w: Math.abs(e[1] - s[1]), h: Math.abs(e[2] - s[2]), r: 0 };
}
if (!board) throw new Error('no rectangular outline');

// ---- pads, tracks, vias
const pads = [], segs = [], vias = [], parts = [], zones = [], texts = [];
for (const it of doc.items.values()) {
  if (it.kind === 'footprint') {
    const at = K.atOf(it.node), prop = (n) => { for (const p of K.kids(it.node, 'property')) if (p[1] === n) return String(p[2]); return ''; };
    const seen = new Map();
    let bb = null;
    for (const g of it.geom) {
      if (!g.pad || g.hole || g.padIndex === undefined || g.t === 'text' || !/\.Cu$/.test(g.layer)) continue;
      const turned = Math.round((g.rot || 0) / 90) % 2 !== 0, w = g.w || (g.r || 0) * 2, h = g.h || (g.r || 0) * 2;
      const hw = (turned ? h : w) / 2, hh = (turned ? w : h) / 2;
      bb = bb ? [Math.min(bb[0], g.x - hw), Math.min(bb[1], g.y - hh), Math.max(bb[2], g.x + hw), Math.max(bb[3], g.y + hh)] : [g.x - hw, g.y - hh, g.x + hw, g.y + hh];
      const had = seen.get(g.padIndex);
      if (had) { had.layers.push(g.layer); continue; }
      const p = { fp: it.id, net: g.net || 0, x: g.x, y: g.y, hw, hh, layers: [g.layer] };
      seen.set(g.padIndex, p); pads.push(p);
    }
    if (bb) bb = [bb[0] - 0.9, bb[1] - 0.9, bb[2] + 0.9, bb[3] + 0.9];      // room for the courtyard and the reference beside the pads
    parts.push({ ref: prop('Reference'), value: prop('Value'), id: it.id, x: r3(at[0]), y: r3(at[1]), rot: at[2] || 0, box: bb || it.bbox });
  } else if (it.kind === 'segment') { const g = it.geom[0]; segs.push({ id: it.id, net: g.net, layer: g.layer, a: [r3(g.x1), r3(g.y1)], b: [r3(g.x2), r3(g.y2)], w: g.w }); }
  else if (it.kind === 'via') { const g = it.geom[0]; vias.push({ id: it.id, net: g.net, at: [r3(g.x), r3(g.y)] }); }
  else if (it.kind === 'zone') zones.push(it.id);
  else if (it.kind === 'gr_text' && /"F\.SilkS"/.test(K.serialize(it.node))) texts.push({ id: it.id, text: String(it.node[1]) });
}
const padAt = (p, layer, net) => pads.find((q) => q.net === net && q.layers.includes(layer) && Math.abs(p[0] - q.x) <= q.hw + 0.02 && Math.abs(p[1] - q.y) <= q.hh + 0.02) || null;
const viaAt = (p, net) => vias.find((v) => v.net === net && Math.hypot(v.at[0] - p[0], v.at[1] - p[1]) < 0.02) || null;

// ---- runs: per net and layer, tracks joined end to end between pads, vias and branch points
const groups = new Map();
for (const s of segs) { const k = s.net + '|' + s.layer; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
const runs = [];
for (const list of groups.values()) {
  const at = new Map();
  for (const s of list) for (const p of [s.a, s.b]) { const k = key(p[0], p[1]); if (!at.has(k)) at.set(k, []); at.get(k).push(s); }
  const net = list[0].net, layer = list[0].layer;
  // a corner inside a pad is still the same run: only an end, a branch or a via ends one
  const stop = (p) => at.get(key(p[0], p[1])).length !== 2 || !!viaAt(p, net);
  const used = new Set();
  for (const s0 of list) for (const [from, to] of [[s0.a, s0.b], [s0.b, s0.a]]) {
    if (used.has(s0.id) || !stop(from)) continue;
    const ids = [s0.id], pts = [from, to]; used.add(s0.id);
    let p = to;
    while (!stop(p)) {
      const nx = at.get(key(p[0], p[1])).find((s) => !used.has(s.id)); if (!nx) break;
      used.add(nx.id); ids.push(nx.id); p = key(nx.a[0], nx.a[1]) === key(p[0], p[1]) ? nx.b : nx.a; pts.push(p);
    }
    runs.push({ net, layer, ids, pts, w: s0.w });
  }
  for (const s of list) if (!used.has(s.id)) throw new Error('a closed loop of track on ' + netName(net));
}

// ---- an order they can be laid in: every run starts on a pad or on copper laid before it
const onSeg = (e, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((e[0] - a[0]) * dx + (e[1] - a[1]) * dy) / l)) : 0; return Math.hypot(e[0] - a[0] - t * dx, e[1] - a[1] - t * dy) < 0.02; };
const FIRST = ['USB_D+', 'USB_D-', 'VBUS', '+3V3'], rank = (r) => { const n = netName(r.net), i = FIRST.indexOf(n); return n === 'GND' ? 99 : i < 0 ? 50 : i; };
const order = [], owner = new Map();
const touching = (p, r) => order.map((o, i) => (o.net === r.net && (o.layer === r.layer ? o.pts.some((q, k) => k > 0 && onSeg(p, o.pts[k - 1], q)) : false)) || (o.via && viaAt(p, r.net) && o.via === viaAt(p, r.net).id) ? i : -1).filter((i) => i >= 0);
const left = runs.slice().sort((a, b) => rank(a) - rank(b));
let loosely = false;                       // when nothing else can start: a run that only passes over a pad, or ends just beside one in the pour
while (left.length) {
  let done = false;
  for (let i = 0; i < left.length && !done; i++) {
    const r = left[i];
    for (const flip of [false, true]) {
      const pts = flip ? r.pts.slice().reverse() : r.pts, ids = flip ? r.ids.slice().reverse() : r.ids;
      const s = pts[0], e = pts[pts.length - 1];
      const sPad = padAt(s, r.layer, r.net), ePad = padAt(e, r.layer, r.net), eVia = viaAt(e, r.net), sVia = viaAt(s, r.net);
      const sNeeds = sPad ? [] : touching(s, r);
      if (!sPad && !sNeeds.length && !(loosely && pts.some((q) => padAt(q, r.layer, r.net)))) continue;
      if (sPad && sVia && !owner.has(sVia.id) && !flip && padAt(e, r.layer, r.net)) continue;   // better the other way round: it then ends in its via
      const out = { net: netName(r.net), layer: r.layer, ids, pts, w: r.w, via: null, needs: sNeeds };
      if (eVia && !owner.has(eVia.id)) { out.via = eVia.id; owner.set(eVia.id, order.length); }
      else if (!ePad) for (const k of touching(e, r)) if (!out.needs.includes(k)) out.needs.push(k);
      order.push(out); left.splice(i, 1); done = true; break;
    }
  }
  if (!done && !loosely) { loosely = true; continue; }
  loosely = false;
  if (!done) throw new Error('no way to start: ' + left.map((r) => netName(r.net) + ' ' + r.layer + ' ' + JSON.stringify(r.pts)).join(' / '));
}
const needed = new Set(order.flatMap((r) => r.needs));
order.forEach((r, i) => { r.loose = !r.needs.length && !needed.has(i); });
const stitch = vias.filter((v) => !owner.has(v.id)).map((v) => v.id);

// ---- the pile: rows under the board, tallest parts first
const GAP = 0.8, x0 = board.x + 0.5, x1 = board.x + board.w - 0.5;
let x = x0, y = board.y + board.h + 5.5, rowH = 0;
for (const p of parts.slice().sort((a, b) => (b.box[3] - b.box[1]) - (a.box[3] - a.box[1]) || (b.box[2] - b.box[0]) - (a.box[2] - a.box[0]))) {
  const w = p.box[2] - p.box[0], h = p.box[3] - p.box[1];
  if (x + w > x1 && x > x0) { x = x0; y += rowH + GAP; rowH = 0; }
  p.pile = [r3(p.x + (x - p.box[0])), r3(p.y + (y - p.box[1]))];
  x += w + GAP; rowH = Math.max(rowH, h);
}
const pileBottom = r3(y + rowH);
for (const p of parts) delete p.box;
parts.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));

const nets = new Set(pads.map((p) => p.net).filter(Boolean));
const meta = { board, pileBottom, parts, routes: order, zones, stitch, texts, ground: [...doc.nets.entries()].find(([, n]) => n === 'GND')[0], pads: pads.length, nets: nets.size };
fs.writeFileSync(path.join(DIR, 'stm32.json'), JSON.stringify(meta));
console.log({ board, parts: parts.length, routes: order.length, loose: order.filter((r) => r.loose).length, withVia: order.filter((r) => r.via).length, stitch: stitch.length, zones: zones.length, texts: texts.map((t) => t.text), pads: pads.length, nets: nets.size, pileBottom });
console.log(order.map((r, i) => `${i}:${r.net}/${r.layer[0]}${r.via ? 'v' : ''}${r.needs.length ? '<' + r.needs.join(',') : ''}`).join(' '));
