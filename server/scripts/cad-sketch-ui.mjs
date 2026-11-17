// Browser test of the sketcher in the real app (web/domains/mechanical/sketch): a plate with holes drawn, fully
// constrained and dimensioned by clicking and typing as a person would; the extruded solid following a changed
// dimension; dragging under the solver; conflicts and reference dimensions; undo; every drawing and modifying
// tool; regions where curves cross; using an edge of the model in a sketch.
//
// Setup as scripts/cad-ui.mjs: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   DATABASE_URL=postgres://… JWT_SECRET=dev PUBLIC_URL=http://127.0.0.1:8101 PORT=8101 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8101 [SHOTS=/some/dir] node scripts/cad-sketch-ui.mjs
//
// E2E_STATIC=<dir>: serve mechanical.js, cad-worker.js and ui.css from <dir> (a static/dist you have just
// built) in place of the ones compiled into the server, to test a change without rebuilding the server.
//
// Positions are given in sketch millimetres and turned into screen positions through the editor itself
// (window.JunctionSketch), so the test does not depend on the window size or the zoom.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8101').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', STATIC = process.env.E2E_STATIC || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
sql(`INSERT INTO users (github_id, login, name) VALUES (990101, 'sketch-ui', 'sketch-ui') ON CONFLICT (github_id) DO NOTHING`);
const uid = Number(sql(`SELECT id FROM users WHERE github_id = 990101`));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
if (STATIC) {
  for (const f of ['mechanical.js', 'cad-worker.js', 'ui.css']) {
    await ctx.route(`**/static/dist/${f}*`, (route) => route.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', body: fs.readFileSync(path.join(STATIC, f)) }));
  }
}
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(120); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

// ---------------------------------------------------------------- helpers: the studio and the sketch editor
const studio = (fn, arg) => page.evaluate(fn, arg);
const sk = () => page.evaluate(() => {
  const e = window.JunctionSketch; if (!e) return null;
  const s = e.getState();
  const kinds = {}; for (const x of Object.values(s.data.entities)) kinds[x.type] = (kinds[x.type] || 0) + 1;
  const cons = {}; for (const x of Object.values(s.data.constraints)) cons[x.type] = (cons[x.type] || 0) + 1;
  return { ready: s.ready, dof: s.dof, health: s.health, tool: s.tool, kinds, cons, selection: s.selection, conflicting: s.conflicting, redundant: s.redundant, entities: Object.keys(s.data.entities).length, constraints: Object.keys(s.data.constraints).length, defined: s.defined ? s.defined.size : null, hint: s.hint };
});
const data = () => page.evaluate(() => window.JunctionSketch.getState().data);
/** A sketch position (mm) as a screen position. */
const at = (x, y) => page.evaluate(([x, y]) => {
  const st = window.JunctionPartStudio, f = window.JunctionSketch.frame;
  const w = st.viewport.target.clone().set(f.origin[0] + x * f.x[0] + y * f.y[0], f.origin[1] + x * f.x[1] + y * f.y[1], f.origin[2] + x * f.x[2] + y * f.y[2]);
  const p = st.viewport.project(w), r = st.viewport.canvas.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, [x, y]);
const move = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y, { steps: 4 }); };
const click = async (x, y, o = {}) => { const p = await at(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); if (o.shift) await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); if (o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(30); };
const drag = async (x0, y0, x1, y1) => { const a = await at(x0, y0), b = await at(x1, y1); await page.mouse.move(a.x, a.y, { steps: 2 }); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 }); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(60); };
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(30); };
const type = async (text) => { await page.keyboard.type(text); await page.waitForTimeout(30); };
const tool = async (title) => { await page.click(`.cad-sketch-palette [data-tool="${title}"]`); await page.waitForTimeout(40); };
/** Wait until the sketch has settled after an edit: solved, and the settled entities worked out. */
const settledSketch = () => page.waitForFunction(() => { const e = window.JunctionSketch; if (!e) return false; const s = e.getState(); return s.ready && (s.health !== 'ok' || s.dof === 0 || s.defined !== null); }, null, { timeout: 15000 });
/** The id of the one entity of a type that matches. */
const find = (type, test) => page.evaluate(([type, test]) => { const d = window.JunctionSketch.getState().data, f = new Function('e', 'd', 'return ' + test); return Object.keys(d.entities).filter((id) => d.entities[id].type === type && f(d.entities[id], d)); }, [type, test]);
const pt = async (id) => { const d = await data(); const e = d.entities[id]; return [e.x, e.y]; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
/** Type a value into the dimension input that is open, and wait for the edit to land. */
const enter = async (text) => { await page.waitForSelector('.cad-dim-input'); await page.fill('.cad-dim-input', text); await page.keyboard.press('Enter'); await page.waitForSelector('.cad-dim-input', { state: 'detached' }); await settledSketch(); };
/** Dimension: click the things to measure, click where the text goes, type the value. */
const dimension = async (picks, label, value) => { await key('d'); for (const p of picks) await click(p[0], p[1]); await click(label[0], label[1]); if (value !== null) await enter(String(value)); };
const featuresSettled = (n) => page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]); }, n, { timeout: 60000 });
const volume = () => studio(async () => { const st = window.JunctionPartStudio; const m = await st.kernel.call('mass-properties', { body: st.getState().bodies[0].id }); return m.volume; });
const newSketch = async (n) => {
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-dialog[data-feature=sketch]');
  await page.click('.cad-dialog [data-accept]');
  await page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === n && window.JunctionSketch && window.JunctionSketch.getState().ready && window.JunctionSketch.frame; }, n, { timeout: 90000 });
  await page.waitForTimeout(700);   // the camera turns to face the plane
};

try {
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'sketch-ui')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => { const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sketch UI test' }) }); return r.json(); });
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // ================================================================ a plate with two holes, fully constrained
  await newSketch(1);
  check('opening a sketch starts the solver and shows the sketch tools', (await sk()).ready && await page.isVisible('.cad-sketch-palette [data-tool=Line]') && await page.isVisible("[data-tool='Finish sketch']"));
  await shot('01-empty-sketch');

  await key('r');
  check('R takes the Rectangle tool', (await sk()).tool === 'sketch-rectangle');
  await click(0, 0);
  await move(52, 34);
  await shot('02-rectangle-rubber-band');
  await click(52, 34);
  await settledSketch();
  let s = await sk();
  check('a rectangle from the origin: four lines held horizontal and vertical, a corner on the origin', s.kinds.line === 4 && s.kinds.point === 4 && s.cons.horizontal === 2 && s.cons.vertical === 2 && s.cons.coincident === 1, JSON.stringify(s.cons));
  check('it has two degrees of freedom left: its width and its height', s.dof === 2 && s.health === 'ok', `dof ${s.dof}`);
  check('the status line says so', (await page.textContent('.cad-sketch-status')).includes('Under-constrained') && (await page.textContent('.cad-sketch-status')).includes('2 degrees of freedom'));
  await key('Escape');
  await shot('03-rectangle-under-constrained');

  // drag the free corner: the rectangle follows and stays a rectangle on the origin
  await drag(52, 34, 60, 40);
  await settledSketch();
  let d = await data();
  let corners = Object.values(d.entities).filter((e) => e.type === 'point').map((e) => [e.x, e.y]);
  const has = (x, y) => corners.some((c) => near(c[0], x, 0.6) && near(c[1], y, 0.6));
  check('dragging a corner resizes the rectangle under the solver', has(0, 0) && has(60, 40) && has(60, 0) && has(0, 40), JSON.stringify(corners));
  const far = corners.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
  const W0 = far[0], H0 = far[1];

  // dimensions: the width along the bottom, the height up the right side
  await dimension([[W0 / 2, 0]], [W0 / 2, -9], 80);
  s = await sk();
  check('a dimension is placed by clicking and its value typed', s.cons.distance === 1 && s.dof === 1, `dof ${s.dof}`);
  await dimension([[80, H0 / 2]], [92, H0 / 2], 50);
  s = await sk();
  check('with width and height the rectangle is fully constrained', s.dof === 0 && s.health === 'ok' && s.cons.distance === 2);
  check('the status line says fully constrained', (await page.textContent('.cad-sketch-status')).includes('Fully constrained'));
  d = await data();
  corners = Object.values(d.entities).filter((e) => e.type === 'point').map((e) => [e.x, e.y]);
  check('the geometry took the typed values: 80 × 50', corners.some((c) => near(c[0], 80) && near(c[1], 50)) && corners.some((c) => near(c[0], 0) && near(c[1], 0)), JSON.stringify(corners));
  await key('Escape');
  await shot('04-rectangle-fully-constrained');

  // a hole: a circle, its diameter, and its place from the left and bottom sides
  await key('c');
  await click(21, 26); await click(27, 26);
  await settledSketch();
  s = await sk();
  check('C draws a circle; the sketch is under-constrained again by three', s.kinds.circle === 1 && s.dof === 3, `dof ${s.dof}`);
  await dimension([[27, 26]], [34, 36], 10);
  await dimension([[21, 26], [0, 12]], [10, 31], 20);
  await dimension([[20, 26], [40, 0]], [14, 12], 25);
  s = await sk();
  check('diameter and two distances settle the hole', s.dof === 0 && s.cons.diameter === 1 && s.cons.distance === 4, `dof ${s.dof} ${JSON.stringify(s.cons)}`);
  let hole = (await find('circle', 'true'))[0];
  d = await data();
  check('the hole is Ø10 at (20, 25)', near(d.entities[hole].r, 5) && near(d.entities[d.entities[hole].center].x, 20) && near(d.entities[d.entities[hole].center].y, 25), JSON.stringify(d.entities[d.entities[hole].center]));

  // a second hole, tied to the first: equal, level with it, 40 apart
  await key('c');
  await click(57, 31); await click(61, 31);
  await key('Escape');
  await click(25, 25); await click(61, 31, { shift: true });   // the two circles, by their rims
  check('clicking with Shift selects both circles', (await sk()).selection.length === 2);
  await key('e');
  await settledSketch();
  d = await data();
  const circles = Object.values(d.entities).filter((e) => e.type === 'circle');
  check('E makes the selected circles equal', (await sk()).cons.equal === 1 && near(circles[0].r, 5) && near(circles[1].r, 5), circles.map((c) => c.r).join());
  // press the tool first, then click: horizontal between the two centres
  await key('h');
  check('H with nothing selected takes the Horizontal tool and waits', (await sk()).tool === 'sketch-horizontal');
  const c2 = Object.keys(d.entities).find((id) => d.entities[id].type === 'circle' && id !== hole);
  const c2c = d.entities[d.entities[c2].center];
  await click(20, 25); await click(c2c.x, c2c.y);
  await settledSketch();
  await key('Escape');
  d = await data();
  check('then two clicks put the centres level', (await sk()).cons.horizontal === 3 && near(d.entities[d.entities[c2].center].y, 25));
  await dimension([[20, 25], [d.entities[d.entities[c2].center].x, 25]], [40, 36], 40);
  await key('Escape');
  await settledSketch();
  s = await sk();
  check('the plate with two holes is fully constrained', s.dof === 0 && s.health === 'ok', `dof ${s.dof}`);
  await shot('05-plate-fully-constrained');

  // ================================================================ extrude, then change a dimension
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill('.cad-dialog input[data-param=depth]', '8');
  await page.click('.cad-dialog [data-accept]');
  await featuresSettled(2);
  let v = await volume();
  check('the plate extrudes: 80 × 50 × 8 less two Ø10 holes', near(v, (80 * 50 - 2 * Math.PI * 25) * 8, 0.5), `volume ${v.toFixed(1)}`);
  await page.waitForTimeout(500);
  await shot('06-plate-solid');

  await page.dblclick('[data-feature-row][data-feature-type=sketch]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready && Object.keys(window.JunctionSketch.getState().data.entities).length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  // double-click the width dimension's text and type a new value
  const labelOf = (value) => page.evaluate((value) => { const e = window.JunctionSketch, dd = e.getState().data; const id = Object.keys(dd.constraints).find((k) => dd.constraints[k].value === value); const c = dd.constraints[id]; return { id, x: c.label.x, y: c.label.y }; }, value);
  let lab = await labelOf(80);
  const lp = await at(lab.x, lab.y);
  await page.mouse.move(lp.x, lp.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up();
  await shot('07-dimension-being-edited');
  await enter('100');
  d = await data();
  check('double-clicking a dimension and typing 100 widens the plate', Object.values(d.entities).some((e) => e.type === 'point' && near(e.x, 100) && near(e.y, 50)) && (await sk()).dof === 0);
  await shot('08-plate-widened');
  await page.click("[data-tool='Finish sketch']");
  await featuresSettled(2);
  await page.waitForFunction(() => window.JunctionPartStudio.getState().bodies.length === 1 && window.JunctionPartStudio.getState().kernel.state === 'ready');
  v = await volume();
  check('the extruded solid follows: 100 × 50 × 8 less the holes', near(v, (100 * 50 - 2 * Math.PI * 25) * 8, 0.5), `volume ${v.toFixed(1)}`);
  await page.waitForTimeout(500);
  await shot('09-solid-follows');
} catch (e) {
  check('the script ran to the end', false, e.stack || String(e));
  await shot('zz-failure');
}

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
