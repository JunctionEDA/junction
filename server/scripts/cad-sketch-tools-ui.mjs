// Browser test of the sketch toolbar's newer tools in the real app: every drawing tool that was added (aligned
// rectangle, 3-point circle, inscribed and circumscribed polygon, ellipse, partial ellipse, conic, spline,
// control point spline, Bézier curve, text, image), the solid their regions extrude to, and on a second sketch
// Intersection, Pierce, linear and circular pattern, Transform, Split and the Normal and Curvature constraints;
// then undo, a reload, and a second person who sees the same sketch.  (scripts/cad-sketch-ui.mjs tests the
// sketcher itself and the tools it started with.)
//
// Setup as scripts/cad-ui.mjs: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   DATABASE_URL=postgres://… JWT_SECRET=dev PUBLIC_URL=http://127.0.0.1:8201 PORT=8201 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8201 [SHOTS=/some/dir] node scripts/cad-sketch-tools-ui.mjs
//
// E2E_STATIC=<dir>: serve mechanical.js, cad-worker.js and ui.css from <dir> (a static/dist you have just
// built) in place of the ones compiled into the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { tool as chromeTool, toolTitles } from './cad-chrome.mjs';
import { setCad } from './cad-setting.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8201').replace(/\/$/, '');
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
const user = (login, gh) => { sql(`INSERT INTO users (github_id, login, name) VALUES (${gh}, '${login}', '${login}') ON CONFLICT (github_id) DO NOTHING`); return Number(sql(`SELECT id FROM users WHERE github_id = ${gh}`)); };
const uid = user('sketch-tools-ui', 990201), uid2 = user('sketch-tools-ui-2', 990202);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(id, login) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  if (STATIC) {
    for (const f of ['mechanical.js', 'cad-worker.js', 'ui.css']) {
      await ctx.route(`**/static/dist/${f}*`, (route) => route.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', body: fs.readFileSync(path.join(STATIC, f)) }));
    }
  }
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${login} console: ${m.text()}`); });
  await setCad(BASE, jwt(id, login));   // Mechanical CAD is off for a new account
  await p.goto(`${BASE}/auth/dev?jwt=${jwt(id, login)}&next=/`);
  await p.waitForLoadState('networkidle');
  return p;
}
const page = await open(uid, 'sketch-tools-ui');
const shot = async (name, p = page) => { if (SHOTS) { await p.waitForTimeout(150); await p.screenshot({ path: `${SHOTS}/sketch-${name}.png` }); } };

// ---------------------------------------------------------------- helpers (as scripts/cad-sketch-ui.mjs)
const studio = (fn, arg) => page.evaluate(fn, arg);
const sk = () => page.evaluate(() => {
  const e = window.JunctionSketch; if (!e) return null;
  const s = e.getState();
  const kinds = {}; for (const x of Object.values(s.data.entities)) kinds[x.type + (x.construction ? '*' : '')] = (kinds[x.type + (x.construction ? '*' : '')] || 0) + 1;
  const cons = {}; for (const x of Object.values(s.data.constraints)) cons[x.type] = (cons[x.type] || 0) + 1;
  return { ready: s.ready, dof: s.dof, health: s.health, tool: s.tool, kinds, cons, selection: s.selection, entities: Object.keys(s.data.entities).length, hint: s.hint };
});
const data = () => page.evaluate(() => window.JunctionSketch.getState().data);
const at = (x, y) => page.evaluate(([x, y]) => {
  const st = window.JunctionPartStudio, f = window.JunctionSketch.frame;
  const w = st.viewport.target.clone().set(f.origin[0] + x * f.x[0] + y * f.y[0], f.origin[1] + x * f.x[1] + y * f.y[1], f.origin[2] + x * f.x[2] + y * f.y[2]);
  const p = st.viewport.project(w), r = st.viewport.canvas.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, [x, y]);
const atWorld = (x, y, z) => page.evaluate(([x, y, z]) => {
  const st = window.JunctionPartStudio, p = st.viewport.project(st.viewport.target.clone().set(x, y, z)), r = st.viewport.canvas.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, [x, y, z]);
const move = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y, { steps: 4 }); };
const clickXY = async (p, o = {}) => { await page.mouse.move(p.x, p.y, { steps: 3 }); if (o.shift) await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); if (o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(40); };
const click = async (x, y, o = {}) => clickXY(await at(x, y), o);
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(40); };
const type = async (text) => { await page.keyboard.type(text); await page.waitForTimeout(40); };
const tool = async (title) => { await chromeTool(page, title); await page.waitForTimeout(60); };
const settledSketch = () => page.waitForFunction(() => { const e = window.JunctionSketch; if (!e) return false; const s = e.getState(); return s.ready && (s.health !== 'ok' || s.dof === 0 || s.defined !== null); }, null, { timeout: 15000 });
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const featuresSettled = (n, p = page) => p.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]); }, n, { timeout: 90000 });
const sketchRegions = () => page.waitForFunction(() => { const st = window.JunctionPartStudio.getState(); return st.kernel.state === 'ready' && st.sketch && st.sketches.some((x) => x.featureId === st.sketch.featureId); }, null, { timeout: 30000 })
  .then(() => studio(() => { const st = window.JunctionPartStudio.getState(); const v = st.sketches.find((x) => x.featureId === st.sketch.featureId); return v.regions.length; }));
/** What the sketch gained since `before` (a list of entity ids), by type. */
const added = async (before) => { const d = await data(); const out = {}; for (const [id, e] of Object.entries(d.entities)) if (!before.includes(id)) (out[e.type] = out[e.type] || []).push(id); return out; };
const ids = async () => Object.keys((await data()).entities);
const newSketch = async (n, plane) => {
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-dialog[data-feature=sketch] [data-sketch-plane][data-armed]');
  await page.click(`.cad-features [data-default-geometry=${plane}]`);
  await page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === n && window.JunctionSketch && window.JunctionSketch.getState().ready && window.JunctionSketch.frame; }, n, { timeout: 90000 });
  await page.waitForTimeout(800);
};
/** Fit the sketch's own view to a box of sketch coordinates. */
const look = (x0, y0, x1, y1) => studio(([x0, y0, x1, y1]) => {
  const st = window.JunctionPartStudio, f = window.JunctionSketch.frame, V = st.viewport.target.constructor;
  const w = (x, y) => new V(f.origin[0] + x * f.x[0] + y * f.y[0], f.origin[1] + x * f.x[1] + y * f.y[1], f.origin[2] + x * f.x[2] + y * f.y[2]);
  // fit() wants a Box3; it asks it only whether it is empty and for its bounding sphere
  const lo = w(x0, y0), hi = w(x1, y1);
  st.viewport.fit({ isEmpty: () => false, getBoundingSphere: (sph) => { sph.center.copy(lo).add(hi).multiplyScalar(0.5); sph.radius = lo.distanceTo(hi) / 2; return sph; } });
}, [x0, y0, x1, y1]);

try {
  const project = await page.evaluate(async () => { const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sketch tools test', template: 'pcb' }) }); return r.json(); });
  await page.evaluate(async ({ pid }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'sketch-tools-ui-2', role: 'editor' }) })).status, { pid: project.projectId });
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // ================================================================ sketch 1: every new drawing tool
  await newSketch(1, 'top');
  await page.click('.cad-sketch-dialog [data-dialog-fold]');
  const titles = await toolTitles(page, 'sketch');
  const want = ['Aligned rectangle', '3-point circle', 'Inscribed polygon', 'Circumscribed polygon', 'Ellipse', 'Partial ellipse', 'Conic', 'Spline', 'Control point spline', 'Bézier curve', 'Text', 'Image', 'Intersection', 'Split', 'Sketch linear pattern', 'Sketch circular pattern', 'Sketch transform', 'Normal', 'Curvature', 'Pierce'];
  check('the sketch toolbar has every new tool', want.every((t) => titles.includes(t)), want.filter((t) => !titles.includes(t)).join(', '));
  // (what has no room in this window is under More, carets and all: ask the tools themselves)
  const menus = await studio(() => { const out = {}; for (const t of window.JunctionPartStudio.tools()) if (t.group === 'sketch' && t.menu) out[t.menu] = (out[t.menu] ? out[t.menu] + '|' : '') + t.title; return out; });
  check('they sit under carets as Onshape groups them', /Aligned rectangle/.test(menus.Rectangle || '') && /3-point circle/.test(menus.Circle || '') && /Circumscribed polygon/.test(menus.Polygon || '') && /Partial ellipse/.test(menus.Ellipse || '') && /Bézier curve/.test(menus.Spline || '') && /Intersection/.test(menus.Use || '') && /Sketch circular pattern/.test(menus.Pattern || ''), JSON.stringify(menus));
  await look(-10, -20, 140, 160);
  await page.waitForTimeout(300);

  // aligned rectangle: an edge at 30°, then the width
  let before = await ids();
  await tool('Aligned rectangle');
  await click(0, 0); await click(17.320508, 10); await click(-5, 8.660254);
  await settledSketch();
  let got = await added(before), s = await sk();
  check('Aligned rectangle: four lines, square corners, at the angle drawn', (got.line || []).length === 4 && s.cons.perpendicular === 1 && s.cons.parallel === 2 && s.health === 'ok', JSON.stringify(s.cons));
  await key('Escape');

  // 3-point circle
  before = await ids();
  await tool('3-point circle');
  await click(40, 0); await click(50, 0); await click(45, 5);
  await settledSketch();
  got = await added(before);
  let d = await data();
  // (the clicks land on the grid of this zoom: check that the circle runs through where they landed)
  const c3 = (got.circle || []).map((id) => d.entities[id])[0], c3c = c3 && d.entities[c3.center];
  const on3 = c3 ? (got.point || []).filter((id) => id !== c3.center).map((id) => Math.hypot(d.entities[id].x - c3c.x, d.entities[id].y - c3c.y) - c3.r) : [];
  check('3-point circle: a circle through the three clicks', (got.circle || []).length === 1 && on3.length === 3 && on3.every((x) => Math.abs(x) < 1e-6), JSON.stringify(on3));
  await key('Escape');

  // inscribed hexagon, then a circumscribed pentagon by typing its sides
  before = await ids();
  await tool('Inscribed polygon');
  await click(80, 0); await click(90, 0);
  await settledSketch();
  got = await added(before);
  check('Inscribed polygon: a regular hexagon on a construction circle', (got.line || []).length === 6 && (await sk()).health === 'ok');
  await key('Escape');
  before = await ids();
  await tool('Circumscribed polygon');
  await click(115, 0); await move(122, 0); await key('Tab'); await type('5'); await key('Tab'); await type('16'); await key('Enter');
  await settledSketch();
  got = await added(before);
  d = await data();
  const pentagon = (got.line || []).filter((id) => !d.entities[id].construction);
  check('Circumscribed polygon: five sides typed, around a Ø16 circle', pentagon.length === 5 && (got.circle || []).length === 2 && Object.values(d.constraints).some((c) => c.type === 'diameter' && c.value === 16), JSON.stringify(got));
  await key('Escape');

  // ellipse, partial ellipse closed by a line
  before = await ids();
  await tool('Ellipse');
  await click(0, 50); await click(20, 50); await click(0, 58);
  await settledSketch();
  got = await added(before);
  d = await data();
  check('Ellipse: centre, major axis, minor radius', (got.ellipse || []).length === 1 && near(d.entities[got.ellipse[0]].minor, 8, 1e-3) && (await sk()).health === 'ok', JSON.stringify(d.entities[(got.ellipse || [])[0]]));
  await key('Escape');
  before = await ids();
  await tool('Partial ellipse');
  await click(60, 50); await click(80, 50); await click(60, 58); await click(80, 50.2);
  for (const t of [0.4, 0.9, 1.5, 2.2, 2.8]) await move(60 + 20 * Math.cos(t), 50 + 8 * Math.sin(t));
  await click(40, 50.3);
  await settledSketch();
  got = await added(before);
  d = await data();
  const pe = (got.ellipticalArc || [])[0];
  check('Partial ellipse: an arc of an ellipse over the top', !!pe && d.entities[d.entities[pe].start].x > 70 && d.entities[d.entities[pe].end].x < 50, JSON.stringify(pe && d.entities[pe]));
  await key('Escape');
  if (pe) {
    const e = d.entities[pe], S = d.entities[e.start], E = d.entities[e.end];
    await key('l'); await click(S.x, S.y); await click(E.x, E.y); await key('Escape'); await key('Escape');
  }

  // conic over a line
  before = await ids();
  await tool('Conic');
  await click(100, 40); await click(130, 40); await click(115, 60);
  await settledSketch();
  got = await added(before);
  check('Conic: start, end, control point; its end tangents drawn as construction', (got.conic || []).length === 1 && (got.line || []).length === 2);
  await key('Escape');
  await key('l'); await click(130, 40); await click(100, 40); await key('Escape'); await key('Escape');

  // spline closed on its first point; Bézier closed by a line; an open control point spline
  before = await ids();
  await tool('Spline');
  await click(0, 100); await click(15, 90); await click(30, 100); await click(15, 115); await click(0, 100);
  await settledSketch();
  got = await added(before);
  d = await data();
  check('Spline: a click on its first point closes it', (got.spline || []).length === 1 && d.entities[got.spline[0]].closed === true && d.entities[got.spline[0]].points.length === 4, JSON.stringify(got));
  await key('Escape');
  before = await ids();
  await tool('Bézier curve');
  await click(50, 90); await click(60, 110); await click(70, 110); await click(80, 90); await key('Enter');
  await settledSketch();
  got = await added(before);
  d = await data();
  check('Bézier curve: degree 3 from four points, its control polygon as construction', (got.bspline || []).length === 1 && d.entities[got.bspline[0]].degree === 3 && (got.line || []).length === 3);
  await key('Escape');
  await key('l'); await click(80, 90); await click(50, 90); await key('Escape'); await key('Escape');
  before = await ids();
  await tool('Control point spline');
  await click(100, 90); await click(110, 105); await click(120, 95); await click(130, 110); await click(140, 95); await key('Enter');
  await settledSketch();
  got = await added(before);
  d = await data();
  check('Control point spline: a cubic B-spline on five control points', (got.bspline || []).length === 1 && d.entities[got.bspline[0]].degree === 3 && d.entities[got.bspline[0]].poles.length === 5);
  await key('Escape');

  // text, typed in its editor
  before = await ids();
  await tool('Text');
  await click(0, 140); await click(0, 152);
  await page.waitForSelector('.cad-text-editor input');
  await shot('text-editor');
  await page.fill('.cad-text-editor input', 'Hi');
  await page.click('.cad-text-editor [aria-label=Bold]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.cad-text-editor', { state: 'detached' });
  await settledSketch();
  got = await added(before);
  d = await data();
  const tx = (got.text || [])[0];
  check('Text: two clicks for its height, then typed, bold', !!tx && d.entities[tx].text === 'Hi' && d.entities[tx].bold === true && near(Math.abs(d.entities[d.entities[tx].b].y - d.entities[d.entities[tx].a].y), 12, 1e-6), JSON.stringify(tx && d.entities[tx]));
  await key('Escape');

  // image: a picture chosen, two corners
  const png = path.join(os.tmpdir(), `sketch-image-${process.pid}.png`);
  // a 40 × 20 picture, drawn by the browser
  const pngData = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 40; c.height = 20; const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 40, 20); g.fillStyle = '#36c'; g.fillRect(4, 4, 14, 12); return c.toDataURL('image/png').split(',')[1]; });
  fs.writeFileSync(png, Buffer.from(pngData, 'base64'));
  before = await ids();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), tool('Image')]);
  await chooser.setFiles(png);
  await page.waitForFunction(() => window.JunctionSketch.getState().tool === 'sketch-image', null, { timeout: 10000 });
  await click(60, 130); await click(100, 150);
  await settledSketch();
  got = await added(before);
  d = await data();
  const im = (got.image || [])[0];
  check('Image: a picture on the plane, keeping its proportions (2:1)', !!im && /^data:image\//.test(d.entities[im].src) && near(Math.abs(d.entities[d.entities[im].b].y - d.entities[d.entities[im].a].y), 20, 1e-6));
  fs.rmSync(png, { force: true });
  await key('Escape');
  await look(-10, -20, 140, 160);
  await shot('drawing-tools');

  s = await sk();
  check('the sketch is healthy with every new curve in it', s.health === 'ok', JSON.stringify(s));
  const nRegions = await sketchRegions();
  // rectangle, circle, hexagon, pentagon, ellipse, half ellipse, conic, spline, Bézier, H and the i's stem and dot
  check('their closed shapes are regions', nRegions === 12, String(nRegions));

  // ---- undo and redo of a tool
  const nEnt = (await sk()).entities;
  await page.keyboard.press('Control+z'); await settledSketch();
  const afterUndo = (await sk()).entities;
  await page.keyboard.press('Control+y'); await settledSketch();
  check('undo takes the last tool\'s work away, redo puts it back', afterUndo < nEnt && (await sk()).entities === nEnt, `${nEnt} → ${afterUndo} → ${(await sk()).entities}`);

  // ---- extrude every region
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill('.cad-dialog input[data-param=depth]', '6');
  await page.click('.cad-dialog [data-accept]');
  await featuresSettled(2);
  let rep = await studio(() => { const st = window.JunctionPartStudio.getState(); return { status: st.features.map((f) => st.reports[f.id].status).join(), bodies: st.bodies.length, message: st.features.map((f) => st.reports[f.id].message || '').join('') }; });
  check('every region extrudes', rep.status === 'ok,ok' && rep.bodies === nRegions, JSON.stringify(rep));
  const vols = await studio(async () => { const st = window.JunctionPartStudio; const out = {}; for (const b of st.getState().bodies) out[b.id] = (await st.kernel.call('mass-properties', { body: b.id })).volume; return out; });
  const ellipseVol = Object.values(vols).find((v) => near(v, Math.PI * 20 * 8 * 6, 1e-3));
  const conicVol = Object.values(vols).find((v) => near(v, (2 / 3) * 30 * 10 * 6, 1e-3));
  check('the ellipse and the conic are exact solids (π·20·8·6, ⅔·30·10·6)', !!ellipseVol && !!conicVol, JSON.stringify(Object.values(vols).map((v) => Math.round(v * 1000) / 1000)));
  await studio(() => { const vp = window.JunctionPartStudio.viewport; vp.setView('iso', false); vp.fit(); });
  await page.waitForTimeout(600);
  await shot('model');

  // ================================================================ sketch 2, on the front plane: references, patterns, transform, split, constraints
  await newSketch(3, 'front');
  await look(20, -30, 130, 40);
  await page.waitForTimeout(300);
  // Intersection: Shift and a click on the 3-point circle's cylinder takes the whole part; the plane y = 0 cuts it
  // in a rectangle (the circle's centre is at y = 1, its radius √26, so from x = 40 to 50)
  before = await ids();
  await tool('Intersection');
  const cyl = (await studio(() => { const d = window.JunctionPartStudio.getState().features[0].params.sketch; const c = Object.values(d.entities).find((e) => e.type === 'circle' && !e.construction); return { c: d.entities[c.center], r: c.r }; }));
  await clickXY(await atWorld(cyl.c.x, cyl.c.y - cyl.r * 0.98, 3), { shift: true });
  await page.waitForFunction((n) => Object.keys(window.JunctionSketch.getState().data.entities).length > n, before.length, { timeout: 15000 });
  await settledSketch();
  got = await added(before);
  d = await data();
  const xs = (got.point || []).map((id) => d.entities[id].x).sort((a, b) => a - b), zs = (got.point || []).map((id) => d.entities[id].y).sort((a, b) => a - b);
  const half = Math.sqrt(cyl.r * cyl.r - cyl.c.y * cyl.c.y);
  check('Intersection: the plane cuts the cylinder in a rectangle, pinned', (got.line || []).length === 4 && near(xs[0], cyl.c.x - half, 1e-6) && near(xs[xs.length - 1], cyl.c.x + half, 1e-6) && near(zs[0], 0, 1e-9) && near(zs[zs.length - 1], 6, 1e-9) && (await sk()).cons.fix >= 4, JSON.stringify([xs, zs]));
  await key('Escape');

  // Pierce: a point, then an edge of the model that passes through the plane (the cylinder's top rim)
  before = await ids();
  await key('Escape');
  await tool('Point');
  await click(cyl.c.x + half + 3, 9);
  await key('Escape');
  const pid = (await added(before)).point[0];
  await tool('Pierce');
  await click(cyl.c.x + half + 3, 9);
  await clickXY(await atWorld(cyl.c.x, cyl.c.y - cyl.r, 6));
  await page.waitForFunction((pid) => Object.values(window.JunctionSketch.getState().data.constraints).some((c) => c.type === 'pierce' && c.refs[0].entity === pid), pid, { timeout: 15000 }).catch(() => {});
  await settledSketch();
  d = await data();
  check('Pierce: the point goes where the rim passes through the plane', near(d.entities[pid].x, cyl.c.x + half, 1e-4) && near(d.entities[pid].y, 6, 1e-6) && (await sk()).cons.pierce === 1, JSON.stringify(d.entities[pid]));
  await key('Escape');

  // a circle, patterned in a row and round a centre, then copied by Transform
  before = await ids();
  await key('c'); await click(70, 10); await click(72, 10); await key('Escape');
  const circ = (await added(before)).circle[0];
  await click(72, 10);
  check('the circle is selected', (await sk()).selection.includes(circ));
  before = await ids();
  await tool('Sketch linear pattern');
  await click(70, 10); await click(76, 10);
  await settledSketch();
  got = await added(before);
  check('Linear pattern: three in a row, 6 apart', (got.circle || []).length === 2 && (await data()).entities[(await data()).entities[got.circle[1]].center].x > 70, JSON.stringify(got));
  await key('Escape'); await key('Escape');
  await click(72, 10);
  before = await ids();
  await tool('Sketch circular pattern');
  await click(70, 20); await key('Tab'); await type('360'); await key('Enter');
  await settledSketch();
  got = await added(before);
  check('Circular pattern: four round a centre, all the way round', (got.circle || []).length === 3, JSON.stringify(got));
  await key('Escape'); await key('Escape');
  await click(72, 10);
  before = await ids();
  await tool('Sketch transform');
  await key('c');
  await click(70, 10); await click(70, -10);
  await settledSketch();
  got = await added(before);
  d = await data();
  check('Transform with C copies the circle to where it is put', (got.circle || []).length === 1 && near(d.entities[d.entities[got.circle[0]].center].y, -10, 1e-6) && !!d.entities[circ]);
  await key('Escape'); await key('Escape');

  // Split a line; Normal between a line and a circle; Curvature between a Bézier curve and a line
  before = await ids();
  await key('l'); await click(90, 0); await click(120, 0); await key('Escape'); await key('Escape');
  const ln = (await added(before)).line[0];
  await tool('Split');
  await click(100, 0);
  await settledSketch();
  d = await data();
  check('Split cuts the line in two, in line', Object.values(d.entities).filter((e) => e.type === 'line' && !e.from && Math.abs(d.entities[e.a].y) < 1e-9 && Math.abs(d.entities[e.b].y) < 1e-9).length === 2 && (await sk()).cons.collinear >= 1);
  await key('Escape');
  before = await ids();
  await key('c'); await click(105, 20); await click(108, 20); await key('Escape');
  await key('l'); await click(95, 30); await click(100, 28); await key('Escape'); await key('Escape');
  got = await added(before);
  await tool('Normal');
  await click(97.5, 29); await click(108, 20);
  await settledSketch();
  d = await data();
  const nl = d.entities[got.line[0]], A = d.entities[nl.a], B = d.entities[nl.b], C = d.entities[d.entities[got.circle[0]].center];
  check('Normal: the line turns to run through the circle\'s centre', (await sk()).cons.normal === 1 && Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) < 1e-6);
  await key('Escape');
  before = await ids();
  await key('l'); await click(60, 30); await click(70, 30); await key('Escape'); await key('Escape');
  await tool('Bézier curve');
  await click(70, 30); await click(75, 40); await click(85, 40); await click(90, 30); await key('Enter');
  await settledSketch();
  await key('Escape');
  got = await added(before);
  d = await data();
  const base = got.line.find((id) => !d.entities[id].construction), bez = got.bspline[0];
  await tool('Curvature');
  await click(64, 30); await click(80, 37.5);   // the line, and the curve half way along
  await settledSketch();
  d = await data();
  const poles = d.entities[bez].poles.map((id) => d.entities[id]);
  const bl = d.entities[base], LA = d.entities[bl.a], LB = d.entities[bl.b], onLine = (p) => Math.abs((LB.x - LA.x) * (p.y - LA.y) - (LB.y - LA.y) * (p.x - LA.x)) / Math.hypot(LB.x - LA.x, LB.y - LA.y);
  check('Curvature: the Bézier curve leaves the line with matching curvature (its next two control points on the line)', (await sk()).cons.curvature === 1 && onLine(poles[1]) < 1e-6 && onLine(poles[2]) < 1e-6, JSON.stringify(poles.map((p) => [p.x, p.y])));
  await key('Escape');
  s = await sk();
  check('sketch 2 is healthy', s.health === 'ok', JSON.stringify(s));
  await shot('second-sketch');
  await page.click("[data-tool='Finish sketch']");
  await featuresSettled(3);
  const statuses = await studio(() => { const st = window.JunctionPartStudio.getState(); return st.features.map((f) => st.reports[f.id].status).join(); });
  check('everything builds', statuses === 'ok,ok,ok', statuses);

  // ================================================================ the server kept it; a second person sees it
  const snapshot = await studio(() => { const st = window.JunctionPartStudio.getState(); return { bodies: st.bodies.length, sketches: st.features.filter((f) => f.featureType === 'sketch').map((f) => Object.keys(f.params.sketch.entities).length) }; });
  await page.reload();
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  await featuresSettled(3);
  const reloaded = await studio(() => { const st = window.JunctionPartStudio.getState(); return { bodies: st.bodies.length, sketches: st.features.filter((f) => f.featureType === 'sketch').map((f) => Object.keys(f.params.sketch.entities).length) }; });
  check('after a reload the sketches and solids are the same', JSON.stringify(reloaded) === JSON.stringify(snapshot), JSON.stringify([snapshot, reloaded]));
  const url = page.url();
  const other = await open(uid2, 'sketch-tools-ui-2');
  await other.goto(url);
  await other.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  await featuresSettled(3, other);
  const seen = await other.evaluate(() => { const st = window.JunctionPartStudio.getState(); return { bodies: st.bodies.length, sketches: st.features.filter((f) => f.featureType === 'sketch').map((f) => Object.keys(f.params.sketch.entities).length) }; });
  check('a second person sees the same sketches and solids', JSON.stringify(seen) === JSON.stringify(snapshot), JSON.stringify(seen));

  // ---- the toolbar, for the record: a sketch open, the Spline caret open
  await page.dblclick('[data-feature-row][data-feature-type=sketch]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  if (SHOTS) {
    await page.click('.cad-toolbar [data-menu="Spline"]');
    await page.waitForTimeout(200);
    const tb = await page.locator('.cad-toolbar').boundingBox();
    await page.screenshot({ path: `${SHOTS}/sketch-toolbar.png`, clip: { x: 0, y: Math.max(0, tb.y - 2), width: 1500, height: tb.height + 230 } });
    await key('Escape');
  }
} catch (e) {
  check('the script ran to the end', false, e.stack || String(e));
  await shot('zz-failure');
}

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
