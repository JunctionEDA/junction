// Records the footage of the README video (render.mjs) from the real application, after build-pico.mjs and
// prepare.mjs.  One window is filmed, Ada's; everyone else works in their own browser and shows in hers as a
// cursor with a name tag, the way a collaborator does.
//
//   schematic  Ada starts the Pico schematic alone; Ben joins, then Chloé, then Dev, each taking a part of it.
//              Every item goes in through that person's own editor, with their mouse on it.
//   ai         Ada asks her AI app for the crystal circuit: it points at the gap (highlight) and proposes the
//              circuit (apply_changes with propose), which Ada accepts.
//   route      All four route the board, a corner each; then the planes are filled.
//   history, parts, plugins, fab, viewer3d   short looks at the rest of the product.
//   simulate   the AI's simulate tool on the reset circuit (the plot it returns).
//
//   node record-junction.mjs [scene ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, mcp, share, record, sleep, POINTER } from './lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const STATE = path.join(OUT, 'state.json');
const all = ['schematic', 'ai', 'place', 'route', 'history', 'parts', 'plugins', 'websim', 'fab', 'viewer3d'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : all;
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const I = JSON.parse(fs.readFileSync(path.join(OUT, 'pico-items.json'), 'utf8'));
const project = I.project;

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const people = {};
for (const [g, login, name] of [[-7701, 'ada', 'Ada'], [-7702, 'ben', 'Ben'], [-7703, 'chloe', 'Chloé'], [-7704, 'dev', 'Dev']]) {
  const id = await mkUser(g, login, name); people[login] = { id, name, jwt: mintJwt(id, login) };
}
const ada = people.ada.jwt;
const docs = (await (await fetch(`${BASE}/api/projects/${project}`, { headers: { Authorization: `Bearer ${ada}` } })).json()).docs;
const docOf = (type) => docs.find((d) => d.docType === type).docId;
for (const p of ['ben', 'chloe', 'dev']) await share(ada, project, people[p].jwt);

// One browser for each person, as on separate computers.  WebGL by software (for the 3D viewer), but not
// --ignore-gpu-blocklist: with it the 2D canvases are composited through the software GPU too, and a page
// taking a stream of remote edits then stops painting for many seconds.
const launch = () => chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const browsers = {};
const MAIN = { width: 1600, height: 900 }, SIDE = { width: 1200, height: 800 };
async function open(login, docId, viewport = SIDE, proj = project) {
  browsers[login] = browsers[login] || await launch();
  const ctx = await browsers[login].newContext({ viewport, deviceScaleFactor: 1, colorScheme: 'dark' });
  await ctx.addInitScript(POINTER);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 200)));
  await page.goto(`${BASE}/auth/dev?jwt=${people[login].jwt}&next=${encodeURIComponent(`/p/${proj}/edit?doc=${docId}`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 90000 });
  // No project-card thumbnails from these windows: encoding one takes a software-rendered headless page many
  // seconds, during which it paints nothing (a normal browser does it in a moment).
  await page.evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); });
  await sleep(1000);
  return page;
}
async function clearPanels(page) { for (let i = 0; i < 8; i++) { const x = page.locator('button.kx:visible').first(); if (!(await x.count())) break; await x.click(); await sleep(150); } }
async function home(page) { await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height / 2); await page.keyboard.press('Home'); await sleep(700); }
async function mapOf(page) {
  const [m0, m1] = await page.evaluate(() => { const E = window.CollabEditor; return [E.api.worldMm({ clientX: 0, clientY: 0 }), E.api.worldMm({ clientX: 1000, clientY: 1000 })]; });
  const sx = 1000 / (m1[0] - m0[0]), sy = 1000 / (m1[1] - m0[1]);
  return { to: (p) => [(p[0] - m0[0]) * sx, (p[1] - m0[1]) * sy] };
}
// zoom so that the world box [x0, y0, x1, y1] fills the view: Home, then wheel notches at its centre while it fits
async function frame(page, box) {
  await home(page);
  const vp = page.viewportSize();
  for (let i = 0; i < 10; i++) {
    const m = await mapOf(page); const a = m.to([box[0], box[1]]), b = m.to([box[2], box[3]]);
    if ((b[0] - a[0]) * 1.3 > vp.width || (b[1] - a[1]) * 1.3 > vp.height - 120) break;
    await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); await page.mouse.wheel(0, -120); await sleep(300);
  }
  await sleep(400);
}
// show exactly the world box [x0, y0, x1, y1]: zoom out until it fits, in while it still fits, then drag the view (middle button) to centre it
async function fitTo(page, box, rec) {
  // with rec, every notch and stroke is photographed: a person zooming out, not a cut
  const pause = async (ms) => { if (rec) { await sleep(ms / 2); await rec.tick(); await rec.tick(); } else await sleep(ms); };
  const vp = page.viewportSize(), H = vp.height - 140;
  const span = async () => { const m = await mapOf(page); const a = m.to([box[0], box[1]]), b = m.to([box[2], box[3]]); return { a, b, w: b[0] - a[0], h: b[1] - a[1] }; };
  for (let i = 0; i < 30; i++) { const s = await span(); if (s.w <= vp.width * 0.98 && s.h <= H) break; await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, 120); await pause(250); }
  for (let i = 0; i < 30; i++) { const s = await span(); if (s.w * 1.25 > vp.width * 0.98 || s.h * 1.25 > H) break; await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, -120); await pause(250); }
  for (let i = 0; i < 8; i++) {
    const s = await span(); const cx = (s.a[0] + s.b[0]) / 2, cy = (s.a[1] + s.b[1]) / 2, tx = vp.width / 2, ty = 70 + H / 2;
    if (process.env.FIT_LOG) console.log('  fit', i, Math.round(cx), Math.round(cy), '->', tx, ty, Math.round(s.w), Math.round(s.h));
    if (Math.abs(cx - tx) < 4 && Math.abs(cy - ty) < 4) break;
    // drag from the middle of the canvas (never from a toolbar), at most 350 px a stroke
    const dx = Math.max(-350, Math.min(350, tx - cx)), dy = Math.max(-300, Math.min(300, ty - cy)), sx0 = vp.width / 2, sy0 = 70 + H / 2;
    await page.mouse.move(sx0, sy0); await page.mouse.down({ button: 'middle' }); await page.mouse.move(sx0 + dx / 2, sy0 + dy / 2, { steps: 4 }); await page.mouse.move(sx0 + dx, sy0 + dy, { steps: 4 }); await page.mouse.up({ button: 'middle' }); await pause(300);
  }
  await sleep(300);
}
const commit = (page, changes, label) => page.evaluate(([c, l]) => window.CollabEditor.api.commitChanges(c, l), [changes, label]);
const settled = (page) => page.waitForFunction(() => window.CollabEditor.pendingOps.size === 0, null, { timeout: 60000 });
async function reset(page, kind, filter = () => true) {
  const ids = (kind === 'sch' ? I.schematic : I.board).filter(filter).map((i) => i.id);
  const n = await page.evaluate(([ids, kind]) => {
    const E = window.CollabEditor, d = E.kdoc, out = [], set = new Set(ids);
    for (const it of d.items.values()) if (set.has(it.id)) out.push(kind === 'sch' ? { id: it.id, kind: 'REMOVED', typeName: window.CollabTools.sch._.typeNameFor(it), properties: [] } : window.PcbTools.removedChange(it));
    if (out.length) E.api.commitChanges(out, 'reset');
    return out.length;
  }, [ids, kind]);
  await settled(page); if (n) console.log('  reset: took out', n);
}
async function menu(rec, page, from, name, entry, sub) {
  const btn = page.locator(`#kmenus [data-menu="${name}"] > button`); const bb = await btn.boundingBox(); let at = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  await rec.glide(page, from, at, 450); await btn.click(); await rec.hold(350);
  for (const [text, last] of [[sub, false], [entry, true]]) {
    if (!text) continue;
    const it = page.locator(`#kmenus [data-menu="${name}"] .dd`).locator(`text=${text}`).first(); await it.waitFor({ timeout: 10000 }); const ib = await it.boundingBox(); const to = [ib.x + 40, ib.y + ib.height / 2];
    await rec.glide(page, at, to, 350); at = to; await rec.hold(200);
    if (last) await it.click(); else await it.hover();
  }
  return at;
}
async function clickOn(rec, page, from, locator, ms = 450) { const bb = await locator.boundingBox(); const to = [bb.x + bb.width / 2, bb.y + bb.height / 2]; await rec.glide(page, from, to, ms); await locator.click(); return to; }

function actor(page, steps, start) {
  return { page, steps: steps.slice(), cur: null, pos: start, done: 0 };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
async function advance(A) {
  if (!A.cur) {
    const s = A.steps.shift(); if (!s) return false;
    const pts = [A.pos, ...s.path]; const legs = []; let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = dist(pts[i - 1], pts[i]); legs.push(l); total += l; }
    const approach = legs[0], along = total - approach;
    const frames = Math.max(3, Math.min(s.max || 14, Math.round(approach / (s.speed || 45)))) + (along > 1 ? Math.max(2, Math.min(s.alongMax || 12, Math.round(along / (s.alongPx || 30)))) : 0);
    A.cur = { s, pts, legs, total, frames, f: 0 };
  }
  const c = A.cur; c.f++;
  const k = c.f / c.frames, e = k * k * (3 - 2 * k); let d = e * c.total, i = 0;
  while (i < c.legs.length - 1 && d > c.legs[i]) { d -= c.legs[i]; i++; }
  const p0 = c.pts[i], p1 = c.pts[i + 1], t = c.legs[i] ? Math.min(1, d / c.legs[i]) : 1;
  const at = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  await A.page.mouse.move(at[0], at[1]); A.pos = at;
  if (c.f >= c.frames) { if (c.s.commit) await commit(A.page, c.s.commit, c.s.label || 'add'); A.cur = null; A.done++; }
  return true;
}
// Everybody works until all are done; the recorder photographs every frame.
async function together(rec, actors, onFrame) { for (;;) { let any = false; for (const A of actors) if (await advance(A)) any = true; await rec.tick(); if (onFrame) await onFrame(); if (!any) break; } }

// ---- turning the exported items into a person's steps
const ORDER = { rectangle: 0, text: 1, symbol: 2, wire: 3, label: 4, global_label: 4, hierarchical_label: 4, junction: 5, no_connect: 6 };
function schSteps(map, blockNames) {
  const steps = [];
  for (const name of blockNames) {
    const its = I.schematic.filter((i) => i.blockName === name);
    const parts = its.filter((i) => i.kind === 'symbol' && !/^power:/.test(i.lib || '')).sort((a, b) => a.pts[0][0] - b.pts[0][0] || a.pts[0][1] - b.pts[0][1]);
    const box = its.filter((i) => i.kind === 'rectangle' || i.kind === 'text');
    let rest = its.filter((i) => !parts.includes(i) && !box.includes(i));
    const ordered = [...box.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]), ...parts];
    // the rest nearest-first from where the hand is, the way a person works round a part
    let at = parts.length ? parts[parts.length - 1].pts[0] : (box[0] ? box[0].pts[0] : [0, 0]);
    while (rest.length) {
      rest.sort((a, b) => dist(at, a.pts[0]) - dist(at, b.pts[0]));
      const n = rest.shift(); ordered.push(n); at = n.pts[n.pts.length - 1];
    }
    for (const i of ordered) steps.push({ path: i.pts.map(map.to), commit: [i.add], label: 'add', max: i.kind === 'symbol' ? 16 : 12 });
  }
  return steps;
}


const scene = async (name, fn) => { if (!want.includes(name)) return; console.log(`== ${name}`); const info = await fn(path.join(OUT, name)); state[name] = info; save(); console.log(JSON.stringify(info).slice(0, 900)); for (const b of Object.values(browsers)) await b.close(); for (const k of Object.keys(browsers)) delete browsers[k]; };
const AI_BLOCK = '12 MHz crystal';
const blockNamed = (re) => Object.values(I.blocks).find((b) => re.test(b.name)).name;
const content = (() => { const b = Object.values(I.blocks).map((x) => x.box); return [Math.min(...b.map((x) => x[0])) - 4, Math.min(...b.map((x) => x[1])) - 8, Math.max(...b.map((x) => x[2])) + 4, Math.max(...b.map((x) => x[3])) + 4]; })();

// ---------------------------------------------------------------- the schematic, one person and then four
await scene('schematic', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await reset(a, 'sch'); await clearPanels(a); await frame(a, content);
  const ma = await mapOf(a);
  const RP = blockNamed(/RP2040/), rpSteps = (map) => schSteps(map, [RP]);
  const third = (steps, k) => { const n = Math.ceil(steps.length / 3); return steps.slice(k * n, (k + 1) * n); };
  // who does what, and when they come in (after Ada has put in so many items)
  const plan = [
    { who: 'ada', at: 0, steps: (m) => [...schSteps(m, [blockNamed(/USB/), blockNamed(/buck/)]), ...third(rpSteps(m), 1)] },
    { who: 'ben', at: 22, steps: (m) => [...schSteps(m, [blockNamed(/QSPI/), blockNamed(/Reset/)]), ...third(rpSteps(m), 2)] },
    { who: 'chloe', at: 52, steps: (m) => third(rpSteps(m), 0) },
    { who: 'dev', at: 70, steps: (m) => schSteps(m, [blockNamed(/GPIO/)]) },
  ];
  const A = actor(a, plan[0].steps(ma), [800, 450]);
  const actors = [A]; const pending = []; const joins = {};
  const rec = await record(a, dir);
  await rec.hold(700);
  for (;;) {
    for (const p of plan.slice(1)) if (!p.started && A.done >= p.at) {
      p.started = true;
      pending.push((async () => { const pg = await open(p.who, docOf('kicad_sch'), p.who === 'ben' ? MAIN : SIDE); await clearPanels(pg); if (p.who === 'ben') await frame(pg, content); else await home(pg); const m = await mapOf(pg); return { p, pg, m }; })());
    }
    // a person who has finished opening joins: their window is ready, their cursor comes in from the side
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = await Promise.race([pending[i], sleep(0).then(() => null)]);
      if (r) { pending.splice(i, 1); rec.mark(`join-${r.p.who}`); if (r.p.who === 'ben') rec.add(r.pg, path.join(dir, 'ben')); joins[r.p.who] = A.done; const Z = actor(r.pg, r.p.steps(r.m), [1150, 100]); Z.who = r.p.who; actors.push(Z); }
    }
    let any = false; for (const X of actors) if (await advance(X)) any = true;
    await rec.tick();
    if (!any && !pending.length && plan.every((p) => p.started || p.at === 0)) break;
  }
  for (const X of actors) await settled(X.page);
  await rec.hold(900);
  const r = await rec.stop();
  return { ...r, items: Object.fromEntries(actors.map((X) => [X.who || 'ada', X.done])), joins };
});

// ---------------------------------------------------------------- Ada's AI: points at the gap, proposes the crystal, she accepts
await scene('ai', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await reset(a, 'sch', (i) => i.blockName === AI_BLOCK);
  await clearPanels(a); await frame(a, content);
  // the AI app's access key (Connect an AI assistant), warmed up in a scratch project so that it is not in this
  // document before Ada asks (the server starts its worker on the first call)
  await db.query(`UPDATE mcp_tokens SET expires_at = now() WHERE grant_id IN (SELECT id FROM mcp_grants WHERE user_id = $1 AND client_id LIKE 'kcm\\_key\\_%')`, [people.ada.id]);
  const k = await (await fetch(`${BASE}/api/mcp/keys`, { method: 'POST', headers: { Authorization: `Bearer ${ada}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Claude', write: true }) })).json();
  let scratch = (await db.query(`SELECT id FROM projects WHERE owner_id = $1 AND name = 'scratch' AND deleted_at IS NULL`, [people.ada.id])).rows[0];
  scratch = scratch ? scratch.id : (await mcp(k.key, 'create_project', { name: 'scratch' })).data.project_id;
  console.log('  warm-up:', (await mcp(k.key, 'run_python', { project: scratch, code: 'print(1)', timeout_s: 120 })).text.slice(0, 80));
  const box = I.blocks[Object.keys(I.blocks).find((kk) => I.blocks[kk].name === AI_BLOCK)].box;
  const ma = await mapOf(a); const gap = ma.to([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  const rec = await record(a, dir);
  await rec.glide(a, [800, 450], gap, 700); await rec.hold(400);
  await rec.glide(a, gap, [gap[0] + 40, gap[1] - 25], 400); await rec.hold(300);
  rec.mark('ask'); await rec.glide(a, [gap[0] + 40, gap[1] - 25], [1560, 860], 600);
  await rec.hold(2200);
  const sch = docs.find((d) => d.docType === 'kicad_sch').path || 'rp2040-pico.kicad_sch';
  rec.mark('highlight');
  const h = await rec.until(mcp(k.key, 'highlight', { project, document: sch, area: box, note: 'XIN and XOUT need the 12 MHz crystal: 1 kΩ drive resistor, two 15 pF loads', seconds: 60 }));
  await rec.wait(2600);
  const items = I.schematic.filter((i) => i.blockName === AI_BLOCK);
  rec.mark('propose');
  const p = await rec.until(mcp(k.key, 'apply_changes', { project, document: sch, title: 'Add the 12 MHz crystal circuit', rationale: 'The RP2040 hardware design guide\'s crystal: ABM8-272-T3 at 12 MHz, a 1 kΩ series resistor on XOUT and 15 pF to ground on each side.', edits: items.map((i) => ({ op: 'add_item', sexpr: i.plain })), propose: true }));
  await rec.wait(2500);
  // Ada looks at it and accepts
  const accept = a.locator('button[data-act="accept"]').first();
  await accept.waitFor({ timeout: 20000 });
  rec.mark('card');
  await rec.hold(900);
  const at = await clickOn(rec, a, [1560, 860], accept, 700); rec.mark('accept');
  await rec.wait(2500); await settled(a);
  await rec.glide(a, at, [gap[0] + 80, gap[1] + 60], 600); await rec.hold(1200);
  const r = await rec.stop();
  return { ...r, highlight: h.text.slice(0, 200), proposal: p.text.slice(0, 300), items: items.length };
});

// ---------------------------------------------------------------- the board takes shape: outline, Update PCB from Schematic, blocks
// Ada draws the Edge.Cuts outline and brings the footprints in with Update PCB from Schematic (they land in a row
// under the board).  Selecting a block's symbols in her schematic window selects its footprints on the board
// (cross-probing).  Each person then gathers their blocks beside the board, arranged as the layout has them,
// and moves each block onto the board.
const PEOPLE_BLOCKS = { ada: [/^USB/, /buck/], ben: [/QSPI/, /crystal/], chloe: [/RP2040/], dev: [/Reset/, /GPIO/] };
const DEMO = () => {
  const E = window.CollabEditor, P = window.PcbTools, K = window.KiCadCanvas;
  const fp = (ref) => { for (const it of E.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === ref) return it; return null; };
  window.__demo = {
    at: (refs) => { const p = refs.map(fp).filter(Boolean).map((it) => K.atOf(it.node)); return p.length ? [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length] : null; },
    move: (refs, dx, dy) => { const ids = refs.map(fp).filter(Boolean).map((it) => it.id); const c = P.moveChanges(E.kdoc, ids, dx, dy); if (c.length) E.api.commitChanges(c, 'move'); },
    snap: (ref, node, dx, dy) => {
      const it = fp(ref); if (!it) return false;
      const n = JSON.parse(JSON.stringify(node)); const u = n.find((c) => Array.isArray(c) && c[0] === 'uuid'); if (u) u[1] = it.id;
      P.translateNode(n, dx, dy); E.api.commitChanges([P.replacedChange(it, n)], 'place'); return true;
    },
    count: () => { let n = 0; for (const it of E.kdoc.items.values()) if (it.kind === 'footprint') n++; return n; },
  };
};
await scene('place', async (dir) => {
  const FP = I.footprints, OUTL = I.outline[0];
  const blockNames = Object.values(I.blocks).map((b) => b.name);
  const mine = Object.fromEntries(Object.entries(PEOPLE_BLOCKS).map(([w, res]) => [w, blockNames.filter((n) => res.some((r) => r.test(n)))]));
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  // start from an empty board: no footprints, no outline, no copper
  await a.evaluate(() => { const E = window.CollabEditor, P = window.PcbTools; const out = []; for (const it of E.kdoc.items.values()) if (['footprint', 'segment', 'arc', 'via', 'zone'].includes(it.kind) || (it.kind === 'gr_rect')) out.push(P.removedChange(it)); if (out.length) E.api.commitChanges(out, 'reset'); });
  await settled(a); await clearPanels(a);
  // cross-probing as KiCad ships it: select, centre and zoom to the probed footprints (Preferences > PCB Editor > Display Options)
  await a.evaluate(() => { const k = 'kui.prefs'; let p = {}; try { p = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { p = {}; }
    p.pcbDisplay = { ...(p.pcbDisplay || {}), crossProbing: { onSelection: true, centerOnItems: true, zoomToFit: true, autoHighlight: true, flashSelection: false } }; localStorage.setItem(k, JSON.stringify(p)); });
  await a.reload(); await a.waitForFunction(() => window.CollabEditor && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 90000 });
  await a.evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); }); await sleep(1200); await clearPanels(a);
  const ob = OUTL.bbox, VIEW = [ob[0] - 52, ob[1] - 8, ob[2] + 92, ob[3] + 42];
  await fitTo(a, VIEW);
  await a.evaluate(DEMO);
  // Ada's schematic, in a second window of her browser: the cross-probe partner
  const sctx = a.context(); const sp = await sctx.newPage(); await sp.setViewportSize(MAIN);
  await sp.goto(a.url().replace(/doc=[^&]+/, `doc=${docOf('kicad_sch')}`));
  await sp.waitForFunction(() => window.CollabEditor && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 90000 });
  await sp.evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); }); await sleep(800); await clearPanels(sp); await home(sp);
  // everyone else: a board window and, beside it in the same browser, their schematic (the cross-probe partner);
  // their board keeps its view when a probe comes in (Preferences > Display Options: select only)
  const others = {}, osch = {};
  for (const w of ['ben', 'chloe', 'dev']) {
    others[w] = await open(w, docOf('kicad_pcb'));
    await others[w].evaluate(() => { const k = 'kui.prefs'; let p = {}; try { p = JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { p = {}; }
      p.pcbDisplay = { ...(p.pcbDisplay || {}), crossProbing: { onSelection: true, centerOnItems: false, zoomToFit: false, autoHighlight: true, flashSelection: false } }; localStorage.setItem(k, JSON.stringify(p)); });
    await others[w].reload(); await others[w].waitForFunction(() => window.CollabEditor && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 90000 });
    await others[w].evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); }); await sleep(600);
    await clearPanels(others[w]); await fitTo(others[w], VIEW); await others[w].evaluate(DEMO);
    const q = await others[w].context().newPage(); await q.setViewportSize(MAIN);
    await q.goto(others[w].url().replace(/doc=[^&]+/, `doc=${docOf('kicad_sch')}`));
    await q.waitForFunction(() => window.CollabEditor && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 90000 });
    await q.evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); }); await sleep(500); await clearPanels(q); await home(q);
    osch[w] = q; await others[w].bringToFront();
  }
  const rec = await record([a, sp], [dir, path.join(dir, 'sch')]);
  const m = await mapOf(a);
  await rec.hold(500);
  // 1. the outline: Edge.Cuts, corner to corner
  let at = [800, 450];
  const c0 = m.to([ob[0], ob[1]]), c1 = m.to([ob[2], ob[3]]);
  await rec.glide(a, at, c0, 500); await rec.hold(250); await rec.glide(a, c0, c1, 900); at = c1;
  await commit(a, [OUTL.add], 'outline'); await rec.hold(500); rec.mark('outline');
  // 2. Update PCB from Schematic
  at = await menu(rec, a, at, 'tools', '/Update PCB from Schematic/');
  const upd = a.locator('button', { hasText: /^Update PCB$/ }).first();
  await rec.until(upd.waitFor({ timeout: 60000 })); await rec.hold(900); rec.mark('dialog');
  at = await clickOn(rec, a, at, upd, 450);
  await rec.until(a.waitForFunction((n) => window.__demo.count() >= n, FP.length, { timeout: 60000 }));
  await rec.hold(700);
  const close = a.locator('button', { hasText: /^Close$/ }).first(); if (await close.count()) { at = await clickOn(rec, a, at, close, 350); }
  await a.keyboard.press('Escape'); await rec.hold(300); await a.keyboard.press('Escape');
  await settled(a); await rec.hold(600); rec.mark('updated');
  await fitTo(a, VIEW);

  // 3. each person takes their blocks: a box round them in the schematic selects their footprints on the board
  //    (cross-probing), Pack and Move (P) gathers them under the cursor, a click puts the group down beside the board
  const bx = (ob[0] + ob[2]) / 2, by = (ob[1] + ob[3]) / 2;
  const blockOf = (name) => Object.values(I.blocks).find((b) => b.name === name);
  const pages = { ada: a, ...others }, schs = { ada: sp, ...osch };
  const pos = { ada: at, ben: [1300, 200], chloe: [300, 700], dev: [1300, 750] }, spos = { ada: [800, 450], ben: [800, 450], chloe: [800, 450], dev: [800, 450] };
  const smaps = {}; for (const w of Object.keys(schs)) smaps[w] = await mapOf(schs[w]);
  const ease = (k) => k * k * (3 - 2 * k);
  const centroid = (refs) => { const f = FP.filter((x) => refs.includes(x.ref)); return [f.reduce((s, x) => s + x.at[0], 0) / f.length, f.reduce((s, x) => s + x.at[1], 0) / f.length]; };
  // where a person's pack goes: beside the board on the side its parts end up, at their height
  const parking = (refs) => { const c = centroid(refs); const side = c[0] < bx ? -1 : 1; return [side < 0 ? ob[0] - 16 : ob[2] + 16 + (c[0] > bx + 6 ? 18 : 0), Math.max(ob[1] + 6, Math.min(ob[3] - 6, by + (c[1] - by) * 1.05))]; };
  // a person's selection on the board (ids), read from their page
  const selected = (page) => page.evaluate(() => { const E = window.CollabEditor; const out = []; for (const id of E.selection || []) { const it = E.kdoc.items.get(id); if (it && it.kind === 'footprint') out.push(it.ref); } return out; });
  const PARK = { ada: [[ob[0] - 48, ob[1] - 4]], ben: [[ob[0] - 48, ob[1] + 22], [ob[0] - 48, ob[1] + 36]], chloe: [[ob[2] + 8, ob[1] - 4]], dev: [[ob[2] + 8, ob[1] + 14], [ob[2] + 40, ob[1] + 14]] };
  async function* glideOn(page, w, to, frames, posOf = pos) { const from = posOf[w]; for (let f = 1; f <= frames; f++) { const k = ease(f / frames); const p = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]; await page.mouse.move(p[0], p[1]); posOf[w] = p; yield; } }
  async function* takeBlocks(w, groups, wait) {
    for (let i = 0; i < wait; i++) yield;
    const pg = pages[w], sch = schs[w], sm = smaps[w];
    for (const [gi, names] of groups.entries()) {
      const boxes = names.map(blockOf).filter(Boolean).map((b) => b.box); if (!boxes.length) continue;
      const box = [Math.min(...boxes.map((b) => b[0])) - 2, Math.min(...boxes.map((b) => b[1])) - 2, Math.max(...boxes.map((b) => b[2])) + 2, Math.max(...boxes.map((b) => b[3])) + 2];
      const refs = FP.filter((x) => names.includes(x.block)).map((x) => x.ref); if (!refs.length) continue;
      // the schematic: a box round the blocks
      const s0 = sm.to([box[0], box[1]]), s1 = sm.to([box[2], box[3]]);
      yield* glideOn(sch, w, s0, w === 'ada' ? 12 : 8, spos);
      await sch.mouse.down(); yield;
      yield* glideOn(sch, w, s1, w === 'ada' ? 20 : 12, spos);
      await sch.mouse.up(); if (w === 'ada') rec.mark('probe');
      // the board takes the probe
      for (let i = 0; i < 60; i++) { const got = await selected(pg); if (refs.every((r) => got.includes(r))) break; yield; }
      if (w === 'ada') {
        for (let i = 0; i < 45; i++) yield;          // the board has zoomed to them: let it be seen
        rec.mark('probed');
        await fitTo(pg, VIEW, rec);                    // and back out, by the wheel
      }
      await pg.bringToFront();
      // Pack and Move: the parts gather under the cursor and follow it until the click
      const mp = await mapOf(pg); const live = await pg.evaluate((r) => window.__demo.at(r), refs);
      yield* glideOn(pg, w, mp.to(live), 10);
      await pg.keyboard.press('p'); yield; yield;
      // the carry puts the pack's first part where the click is: each person has their own spot beside the board
      const park = PARK[w][Math.min(gi, PARK[w].length - 1)];
      yield* glideOn(pg, w, mp.to(park), 22);
      await pg.mouse.down(); await pg.mouse.up(); yield;
      await pg.keyboard.press('Escape'); yield;
    }
  }
  const jobs = [
    takeBlocks('ada', [mine.ada], 0),
    takeBlocks('ben', mine.ben.map((n) => [n]), 30),
    takeBlocks('chloe', [mine.chloe], 55),
    takeBlocks('dev', mine.dev.map((n) => [n]), 75),
  ];
  const runAll = async (list) => { const live = list.slice(); while (live.length) { for (let i = live.length - 1; i >= 0; i--) { const r = await live[i].next(); if (r.done) live.splice(i, 1); } await rec.tick(); } };
  rec.mark('gather'); await runAll(jobs);
  for (const w of Object.keys(pages)) await settled(pages[w]);
  await rec.hold(700); rec.mark('grouped');

  // 4. each person puts their parts on the board, one by one: picked up, carried, turned and dropped where it goes
  const maps = {}; for (const w of Object.keys(pages)) maps[w] = await mapOf(pages[w]);
  async function* placeParts(w, wait) {
    for (let i = 0; i < wait; i++) yield;
    const pg = pages[w], mp = maps[w];
    const refs = FP.filter((x) => mine[w].includes(x.block)).sort((p, q) => (q.node && /Connector|RP2040|QFN/.test(JSON.stringify(q.node[1])) ? 1 : 0) - (p.node && /Connector|RP2040|QFN/.test(JSON.stringify(p.node[1])) ? 1 : 0));
    for (const part of refs) {
      const from = await pg.evaluate((r) => window.__demo.at([r]), part.ref); if (!from) continue;
      yield* glideOn(pg, w, mp.to(from), 8);
      const frames = 12; let last = from;
      for (let f = 1; f <= frames; f++) {
        const k = ease(f / frames); const now = [from[0] + (part.at[0] - from[0]) * k, from[1] + (part.at[1] - from[1]) * k];
        const sc = mp.to(now); await pg.mouse.move(sc[0], sc[1]); pos[w] = sc;
        await pg.evaluate(([r, dx, dy]) => window.__demo.move([r], dx, dy), [part.ref, now[0] - last[0], now[1] - last[1]]); last = now; yield;
      }
      await pg.evaluate(([ref, node]) => window.__demo.snap(ref, node, 0, 0), [part.ref, part.node]); yield;
    }
  }
  rec.mark('place');
  await runAll([placeParts('ada', 0), placeParts('ben', 6), placeParts('chloe', 3), placeParts('dev', 9)]);
  for (const w of Object.keys(pages)) await settled(pages[w]);
  await rec.hold(900); rec.mark('placed');

  // 5. the other way: Ada clicks the USB-C connector on the board and her schematic shows it
  const j1 = FP.find((x) => x.ref === 'J1'); const j1at = (await mapOf(a)).to(j1.at);
  await rec.glide(a, pos.ada, j1at, 600); await a.mouse.click(j1at[0], j1at[1]); rec.mark('j1');
  await rec.wait(900); await rec.hold(2200); rec.mark('j1-shown');
  return await rec.stop();
});

// ---------------------------------------------------------------- four people route the board
await scene('route', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await reset(a, 'pcb'); await clearPanels(a);
  const outline = await a.evaluate(() => { for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'gr_rect') return it.bbox; return null; });
  await frame(a, [outline[0] - 2, outline[1] - 2, outline[2] + 2, outline[3] + 2]);
  const others = {};
  for (const w of ['ben', 'chloe', 'dev']) { others[w] = await open(w, docOf('kicad_pcb')); await clearPanels(others[w]); await home(others[w]); }
  const tracks = I.board.filter((i) => i.kind !== 'zone');
  const nets = [...new Set(tracks.map((t) => t.net))];
  const cOf = (n) => { const t = tracks.filter((x) => x.net === n); return [t.reduce((s, x) => s + x.pts[0][0], 0) / t.length, t.reduce((s, x) => s + x.pts[0][1], 0) / t.length]; };
  const mx = (outline[0] + outline[2]) / 2, my = (outline[1] + outline[3]) / 2;
  const quad = { ada: [], ben: [], chloe: [], dev: [] };
  for (const n of nets) { const c = cOf(n); quad[c[1] < my ? (c[0] < mx ? 'ada' : 'ben') : (c[0] < mx ? 'chloe' : 'dev')].push(n); }
  const plan = (map, list) => {
    const steps = [];
    for (const n of list) {
      let rest = tracks.filter((t) => t.net === n); let at = rest.reduce((m, t) => (t.pts[0][1] < m[1] ? t.pts[0] : m), rest[0].pts[0]);
      let chain = []; let chainEnd = null;
      const flush = () => { if (chain.length) { const pts = [chain[0].pts[0], ...chain.flatMap((c) => c.pts.slice(1))]; steps.push({ path: pts.map(map.to), commit: chain.map((c) => c.add), label: 'route', max: 6, speed: 80, alongMax: 8, alongPx: 40 }); chain = []; } };
      while (rest.length) {
        rest.sort((p, q) => Math.min(...p.pts.map((x) => dist(x, at))) - Math.min(...q.pts.map((x) => dist(x, at))));
        let t = rest.shift();
        if (t.kind !== 'via' && dist(t.pts[t.pts.length - 1], at) < dist(t.pts[0], at)) t = { ...t, pts: t.pts.slice().reverse() };
        const joins = chainEnd && dist(t.pts[0], chainEnd) < 0.01 && t.kind !== 'via' && chain.length < 12;
        if (!joins) flush();
        if (t.kind === 'via') { steps.push({ path: [map.to(t.pts[0])], commit: [t.add], label: 'via', max: 5, speed: 80 }); at = t.pts[0]; chainEnd = null; continue; }
        chain.push(t); chainEnd = t.pts[t.pts.length - 1]; at = chainEnd;
      }
      flush();
    }
    return steps;
  };
  const actors = [actor(a, plan(await mapOf(a), quad.ada), [800, 450])];
  for (const w of ['ben', 'chloe', 'dev']) actors.push(actor(others[w], plan(await mapOf(others[w]), quad[w]), [600, 400]));
  const rec = await record(a, dir);
  await rec.hold(600);
  await together(rec, actors);
  for (const X of actors) await settled(X.page);
  rec.mark('routed'); await rec.hold(500);
  // the planes go back in; the server's fill comes with them
  await commit(a, I.board.filter((i) => i.kind === 'zone').map((z) => z.add), 'zones');
  await a.mouse.move(800, 450); await a.keyboard.press('b');
  await rec.wait(3500); rec.mark('filled'); await rec.hold(800);
  const r = await rec.stop();
  const left = await a.evaluate(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length);
  return { ...r, nets: nets.length, tracks: tracks.filter((t) => t.kind !== 'via').length, vias: tracks.filter((t) => t.kind === 'via').length, unrouted: left, byPerson: Object.fromEntries(Object.entries(quad).map(([k, v]) => [k, v.length])) };
});

// ---------------------------------------------------------------- History: everyone's edits, scrubbable
await scene('history', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  const at = await menu(rec, a, [800, 450], 'file', '/^History/');
  await rec.hold(1200);
  const rows = a.locator('text=/edits? ·|edits -|edit -/');
  let p = at; const n = Math.min(4, await rows.count());
  for (let i = 0; i < n; i++) { const bb = await rows.nth(i).boundingBox(); if (!bb) continue; const to = [bb.x + 60, bb.y + bb.height / 2]; await rec.glide(a, p, to, 350); p = to; await rows.nth(i).click().catch(() => {}); await rec.hold(700); }
  await rec.hold(600);
  return await rec.stop();
});

// ---------------------------------------------------------------- Parts from vendors
await scene('parts', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  const at = await menu(rec, a, [800, 450], 'tools', '/Add Part from Vendor/');
  await rec.hold(600);
  for (const ch of 'TLV62569') { await a.keyboard.type(ch); await rec.hold(90); }
  await a.keyboard.press('Enter'); rec.mark('search');
  await rec.wait(6000);
  const row = a.locator('text=/^TLV62569DBVR$/').first();
  if (await row.count()) { const bb = await row.boundingBox(); await rec.glide(a, at, [bb.x + 40, bb.y + bb.height / 2], 500); await row.click(); await rec.wait(3000); }
  await rec.hold(800);
  return await rec.stop();
});

// ---------------------------------------------------------------- Plugins: one catalog
await scene('plugins', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await home(a);
  // the recording machine has no route to KiCad's plugin repository, so its "could not be read" note is the rig's, not the product's
  await a.addStyleTag({ content: '#pluginKicadErr { display: none !important; }' });
  const rec = await record(a, dir);
  await rec.hold(300);
  let at = await clickOn(rec, a, [800, 450], a.locator('button').filter({ hasText: /^Junction/ }).first(), 500);
  await rec.hold(400);
  at = await clickOn(rec, a, at, a.locator('text=Plugin and Content Manager').first(), 400);
  await rec.wait(1500);
  at = await clickOn(rec, a, at, a.locator('text=/^Catalog$/').first(), 450);
  await rec.wait(3500);
  await rec.glide(a, at, [at[0] + 200, at[1] + 220], 900); await rec.hold(900);
  return await rec.stop();
});

// ---------------------------------------------------------------- the web simulator, on the RUN pin's power-on sheet (sim/build.mjs)
await scene('websim', async (dir) => {
  const simProject = JSON.parse(fs.readFileSync(path.join(OUT, 'sim.json'), 'utf8')).project;
  const simDocs = (await (await fetch(`${BASE}/api/projects/${simProject}`, { headers: { Authorization: `Bearer ${ada}` } })).json()).docs;
  const a = await open('ada', simDocs.find((d) => d.docType === 'kicad_sch').docId, MAIN, simProject);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(500);
  let at = await menu(rec, a, [800, 450], 'inspect', '/Simulator/');
  await rec.wait(2500);
  const run = a.locator('#simframe button[title^="Run Simulation"]').first();
  at = await clickOn(rec, a, at, (await run.count()) ? run : a.locator('#simframe button').nth(4), 500);
  await rec.until(a.waitForFunction(() => /Data Rows/.test(document.querySelector('#sim-console')?.value || ''), null, { timeout: 120000 }));
  await rec.hold(300); rec.mark('ran');
  for (const sig of ['V(3V3)', 'V(/RUN)']) {
    const box = a.locator('#simframe tr', { hasText: sig }).first().locator('input[type=checkbox]').first();
    at = await clickOn(rec, a, at, box, 450); await rec.wait(900);
  }
  rec.mark('plotted');
  await rec.glide(a, at, [700, 420], 900); await rec.hold(1500);
  return await rec.stop();
});

// ---------------------------------------------------------------- the AI simulates (the tool's own plot)
await scene('simulate', async (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const k = await (await fetch(`${BASE}/api/mcp/keys`, { method: 'POST', headers: { Authorization: `Bearer ${ada}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Claude', write: true }) })).json();
  // the RUN pin at power-up: 10 kΩ to 3V3, 100 nF to ground (the reset block), 3V3 rising in 1 ms
  const netlist = `* RUN pin power-on
V1 3V3 0 PWL(0 0 1m 3.3)
R10 3V3 RUN 10k
C20 RUN 0 100n
.end`;
  const r = await mcp(k.key, 'simulate', { project, netlist, command: '.tran 10u 6m', probes: ['V(3V3)', 'V(RUN)'], width_px: 1500 });
  // the plot comes back as an image part of the tool result
  const raw = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${k.key}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'simulate', arguments: { project, netlist, command: '.tran 10u 6m', probes: ['V(3V3)', 'V(RUN)'], width_px: 1500 } } }) }).then((x) => x.text());
  const j = raw.trimStart().startsWith('{') ? JSON.parse(raw) : JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join(''));
  const img = (j.result.content || []).find((c) => c.type === 'image');
  if (img) fs.writeFileSync(path.join(dir, 'plot.png'), Buffer.from(img.data, 'base64'));
  return { text: r.text.slice(0, 600), plot: !!img, netlist };
});

// ---------------------------------------------------------------- Fabrication outputs
await scene('fab', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  await menu(rec, a, [800, 450], 'file', '/^Fabrication Package/', 'Fabrication Outputs');
  await rec.wait(3500); await rec.hold(600);
  return await rec.stop();
});

// ---------------------------------------------------------------- 3D
await scene('viewer3d', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  const ib = await menu(rec, a, [800, 450], 'view', '3D Viewer'); rec.mark('open3d');
  await rec.wait(14000); rec.mark('loaded');
  const box = await a.evaluate(() => { const cs = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 200); const c = cs[cs.length - 1].getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; });
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  await rec.glide(a, ib, [cx - 160, cy], 400); await a.mouse.down();
  await rec.glide(a, [cx - 160, cy], [cx + 170, cy + 70], 2400); await a.mouse.up(); await rec.hold(300);
  await a.mouse.down(); await rec.glide(a, [cx + 170, cy + 70], [cx - 50, cy - 80], 2400); await a.mouse.up(); await rec.hold(900);
  return await rec.stop();
});

await db.end();
