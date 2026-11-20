// Browser test of surfaces in the real app, done as a person does it: toolbar buttons (the surface tools are under
// one Surface ▾ button), the generated dialogs, and clicks on faces and edges found on screen.  It builds
//
//   an open box                a rectangle on Top, Extrude with Creates: Surface: four walls, no lid, no floor
//   Fill                       the four top edges picked: a flat lid
//   Offset surface             the front wall picked, 5 mm out
//   Move boundary              the front wall's bottom edge, extended 5 mm down
//   Ruled surface              the back wall's top edge, a 6 mm strip square to the wall
//   Boundary surface           the two side walls' bottom edges as U profiles: a floor
//   a crossing sheet           a line on Front, Extrude Surface both ways
//   Mutual trim                the box and the crossing sheet, cut along each other
//   Constrained surface        through the points of the first sketch
//
// and checks the Parts panel lists surfaces, undo and redo, a reload, and a second user seeing the model.  Setup as
// scripts/cad-ui.mjs:
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8203 PORT=8203 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret E2E_BASE=http://127.0.0.1:8203 [SHOTS=/some/dir] node scripts/cad-surfacing-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, openPanel } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8203').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
function user(login, githubId) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${login}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

const S = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return { features: s.features.map((f) => ({ id: f.id, type: f.featureType, name: f.name })), bodies: s.bodies.map((b) => ({ id: b.id, name: b.name, sheet: !!b.sheet, createdBy: b.createdBy, faces: b.mesh ? b.mesh.faces.names : [], bbox: b.mesh ? b.mesh.bbox : null })) }; });
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 240000, polling: 250 });
const previewed = (page) => page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.editing && s.reports[s.editing.draft.id]; }, null, { timeout: 240000, polling: 250 });
const click = async (page, at) => { await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(60); };
const arm = async (page, key) => { if (!(await page.$(`.cad-dialog [data-param=${key}][data-armed]`))) await page.click(`.cad-dialog [data-param=${key}]`); };
const statusOf = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.name}:${s.reports[f.id]?.status}${s.reports[f.id]?.message ? ' (' + s.reports[f.id].message + ')' : ''}`); });
const reportOf = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); const r = s.editing && s.reports[s.editing.draft.id]; return r ? `${r.status}${r.message ? ': ' + r.message : ''}` : 'none'; });
const screen = (page, p) => S(page, (p) => {
  const st = window.JunctionPartStudio, cam = st.viewport.camera;
  cam.updateMatrixWorld();
  const v = cam.position.clone().set(p[0], p[1], p[2]).project(cam);
  const r = st.viewport.canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}, p);

/**
 * A point on screen where the viewport's own picking finds a face or an edge: every vertex of the face (or every
 * point of the edge) satisfies `at` ([[axis, value], …]); `body` limits it to one body, `skip` leaves names out.
 */
const findOnScreen = (page, want) => S(page, (want) => {
  const st = window.JunctionPartStudio, s = st.getState(), cam = st.viewport.camera, r = st.viewport.canvas.getBoundingClientRect();
  cam.updateMatrixWorld();
  const toScreen = (x, y, z) => { const v = cam.position.clone().set(x, y, z).project(cam); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; };
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const fits = (p) => want.at.every(([a, v]) => near(p[a], v));
  const skip = want.skip || [];
  const tryAt = (pts, accept) => { for (const p of pts) { const sp = toScreen(...p); if (document.elementFromPoint(sp.x, sp.y) !== st.viewport.canvas) continue; const hit = st.view.pick({ clientX: sp.x, clientY: sp.y }); if (hit && accept(hit)) return { x: sp.x, y: sp.y, hit }; } return null; };
  for (const b of s.bodies) {
    if (want.body && b.id !== want.body) continue;
    const m = b.mesh, names = want.kind === 'face' ? m.faces.names : m.edges.names;
    for (let i = 0; i < names.length; i++) {
      if (skip.includes(names[i])) continue;
      const pts = [];
      let all = true;
      if (want.kind === 'face') {
        for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
          const v = [0, 1, 2].map((j) => { const vi = m.indices[t + j]; const p = [m.positions[vi * 3], m.positions[vi * 3 + 1], m.positions[vi * 3 + 2]]; if (!fits(p)) all = false; return p; });
          for (const [a, c] of [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2], [0.45, 0.45]]) pts.push([0, 1, 2].map((k) => v[0][k] * (1 - a - c) + v[1][k] * a + v[2][k] * c));
        }
      } else {
        const out = [];
        for (let q = m.edges.start[i]; q < m.edges.start[i] + m.edges.count[i]; q++) { const p = [m.edges.positions[q * 3], m.edges.positions[q * 3 + 1], m.edges.positions[q * 3 + 2]]; if (!fits(p)) all = false; out.push(p); }
        if (out.length < 2) all = false;
        else for (let k = 1; k < 10; k++) { const f = k / 10, a = out[0], c = out[out.length - 1]; pts.push([a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f, a[2] + (c[2] - a[2]) * f]); }
      }
      if (!all) continue;
      const got = tryAt(pts, (h) => h.kind === want.kind && h.name === names[i] && h.body === b.id);
      if (got) return got;
    }
  }
  return null;
}, want);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [], missing = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${new URL(r.url()).pathname}`); });
};
try {
  const uid = user('cad-surfacing-ui', 990801), uid2 = user('cad-surfacing-ui-2', 990802);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  watch(page);
  await setCad(BASE, jwt(uid, 'cad-surfacing-ui'));
  await setCad(BASE, jwt(uid2, 'cad-surfacing-ui-2'));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-surfacing-ui')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Surfacing UI test', template: 'pcb' }) })).json()));
  await page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cad-surfacing-ui-2', role: 'editor' }) })).status, project.projectId);
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  check('a part studio opens', true);

  // ---------------------------------------------------------------- the toolbar
  const titles = await toolTitles(page, 'feature');
  const surfaceTools = ['Offset surface', 'Boundary surface', 'Fill', 'Move boundary', 'Ruled surface', 'Mutual trim', 'Constrained surface'];
  check('the toolbar offers every surface tool', surfaceTools.every((t) => titles.includes(t)), titles.join(', '));
  const menu = await page.evaluate(() => document.querySelector('.cad-toolbar [data-menu=Surface]')?.getAttribute('data-items') || '');
  check('they share one Surface ▾ button, in Onshape\'s order', menu === surfaceTools.join('|'), menu);
  await page.click('.cad-toolbar [data-menu=Surface]');
  await page.waitForSelector('.cad-tb-menu[data-menu-of=Surface]');
  await shot(page, 'surfacing-toolbar');
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 450);
  // the tool search finds them
  await page.keyboard.press('Control+k');
  await page.keyboard.type('ruled');
  await page.waitForTimeout(300);
  const found = await page.evaluate(() => document.body.innerText.includes('Ruled surface'));
  check('the tool search finds Ruled surface', found);
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- sketches
  const finishSketch = async () => { await page.click("[data-tool='Finish sketch']"); };
  const openNewSketch = async (plane) => {
    await tool(page, 'Sketch');
    await page.waitForSelector('.cad-sketch-dialog');
    if (await page.locator('.cad-sketch-dialog[data-sketch-waiting]').count()) await page.click(`.cad-features [data-default-geometry=${plane}]`);
    await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.kernel.state === 'ready'; }, null, { timeout: 60000 });
    await page.waitForTimeout(700);
  };
  const entityCount = (type) => S(page, (type) => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).filter((e) => e.type === type).length; }, type);
  const accept = async (n, what) => {
    await previewed(page);
    // a new dialog reports what it waits for until its fields are filled: give the preview time to catch up
    await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const r = s.editing && s.reports[s.editing.draft.id]; return s.kernel.state === 'ready' && r && r.status === 'ok'; }, null, { timeout: 30000, polling: 250 }).catch(() => {});
    const r = await reportOf(page);
    await page.click('.cad-dialog [data-accept]');
    await settled(page, n);
    check(`${what} builds`, r === 'ok', r);
  };
  const iso = () => S(page, () => { const vp = window.JunctionPartStudio.viewport; vp.setView('iso', false); vp.fit(); });

  await openNewSketch('top');
  await page.click('[data-tool=Rectangle]');
  await click(page, await screen(page, [-20, -10, 0]));
  await page.mouse.move((await screen(page, [20, 10, 0])).x, (await screen(page, [20, 10, 0])).y, { steps: 4 });
  await click(page, await screen(page, [20, 10, 0]));
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).filter((e) => e.type === 'line').length === 4; }, null, { timeout: 10000 });
  await finishSketch();
  await settled(page, 1);
  const sketch1 = (await state(page)).features[0].id;

  // ---------------------------------------------------------------- Extrude, Creates: Surface
  await tool(page, 'Extrude');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.click('.cad-dialog [data-param=bodyType] >> text=Surface');
  await page.fill('.cad-dialog input[data-param=depth]', '10');
  await accept(2, 'Extrude as a surface');
  let st = await state(page);
  const box = st.bodies[0];
  check('an open box: one surface of four walls, 10 high', st.bodies.length === 1 && box.sheet && box.faces.length === 4 && Math.abs(box.bbox[5] - 10) < 1e-6 && Math.abs(box.bbox[2]) < 1e-6, JSON.stringify(box));
  await openPanel(page, 'parts');
  check('the Parts panel lists it under Surfaces', await page.locator('[data-group=surfaces]').count() === 1 && await page.locator(`[data-body="${box.id}"][data-kind=surface]`).count() === 1, await page.textContent('[data-panel=parts]'));
  check('as Surface 1', box.name === 'Surface 1', box.name);
  const vol = await S(page, async (id) => { const m = await window.JunctionPartStudio.massProperties?.([id]); return m ? m.volume : null; }, box.id).catch(() => null);
  if (vol !== null) check('its volume is zero', Math.abs(vol) < 1e-9, String(vol));
  await iso();
  await page.waitForTimeout(300);

  // ---------------------------------------------------------------- Fill: the four top edges
  await tool(page, 'Fill');
  await page.waitForSelector('.cad-dialog[data-feature=fill]');
  await arm(page, 'edges');
  const picked = [];
  for (let i = 0; i < 4; i++) {
    const at = await findOnScreen(page, { kind: 'edge', at: [[2, 10]], body: box.id, skip: picked });
    if (!at) break;
    picked.push(at.hit.name);
    await click(page, at);
  }
  check('the four top edges are picked', picked.length === 4 && await page.getAttribute('.cad-dialog [data-param=edges]', 'data-count') === '4', picked.join(' '));
  await accept(3, 'Fill');
  st = await state(page);
  const fillId = st.features[2].id;
  const lid = st.bodies.find((b) => b.createdBy === fillId);
  check('Fill makes a flat lid on the box', lid && lid.sheet && lid.faces.length === 1 && Math.abs(lid.bbox[2] - 10) < 1e-6 && Math.abs(lid.bbox[5] - 10) < 1e-6, JSON.stringify(lid));

  // ---------------------------------------------------------------- Offset surface: the front wall, 5 out
  await tool(page, 'Offset surface');
  await page.waitForSelector('.cad-dialog[data-feature=offset-surface]');
  await arm(page, 'faces');
  const front = await findOnScreen(page, { kind: 'face', at: [[1, -10]], body: box.id });
  check('the front wall is found on screen', !!front);
  await click(page, front);
  await page.fill('.cad-dialog input[data-param=distance]', '5');
  await accept(4, 'Offset surface');
  st = await state(page);
  const offset = st.bodies.find((b) => b.createdBy === st.features[3].id);
  check('Offset surface makes a wall 5 from the front one', offset && offset.sheet && offset.faces.length === 1 && Math.abs(Math.abs(offset.bbox[1] + 10) - 5) < 1e-3 && Math.abs(offset.bbox[1] - offset.bbox[4]) < 1e-3, JSON.stringify(offset?.bbox));

  // ---------------------------------------------------------------- Move boundary: the front wall's bottom edge down 5
  await tool(page, 'Move boundary');
  await page.waitForSelector('.cad-dialog[data-feature=move-boundary]');
  await arm(page, 'edges');
  const bottom = await findOnScreen(page, { kind: 'edge', at: [[1, -10], [2, 0]], body: box.id });
  check('the front wall\'s bottom edge is found on screen', !!bottom);
  await click(page, bottom);
  await page.fill('.cad-dialog input[data-param=distance]', '5');
  await accept(5, 'Move boundary');
  st = await state(page);
  const moved = st.bodies.find((b) => b.id === box.id);
  check('Move boundary extends the front wall 5 down', moved && Math.abs(moved.bbox[2] + 5) < 1e-3 && moved.faces.length === 4, JSON.stringify(moved?.bbox));

  // ---------------------------------------------------------------- Ruled surface: the back wall's top edge
  await tool(page, 'Ruled surface');
  await page.waitForSelector('.cad-dialog[data-feature=ruled-surface]');
  await arm(page, 'edges');
  const backTop = await findOnScreen(page, { kind: 'edge', at: [[1, 10], [2, 10]], body: box.id }) || await findOnScreen(page, { kind: 'edge', at: [[1, 10], [2, 10]] });
  check('the back wall\'s top edge is found on screen', !!backTop);
  await click(page, backTop);
  await page.fill('.cad-dialog input[data-param=distance]', '6');
  await accept(6, 'Ruled surface');
  st = await state(page);
  const ruled = st.bodies.find((b) => b.createdBy === st.features[5].id);
  check('Ruled surface makes a 6 mm strip along the edge', ruled && ruled.sheet && Math.abs(ruled.bbox[3] - ruled.bbox[0] - 40) < 1e-3 && Math.max(ruled.bbox[4] - ruled.bbox[1], ruled.bbox[5] - ruled.bbox[2]) > 5.9, JSON.stringify(ruled?.bbox));

  // ---------------------------------------------------------------- Boundary surface: the side walls' bottom edges
  await tool(page, 'Boundary surface');
  await page.waitForSelector('.cad-dialog[data-feature=boundary-surface]');
  await arm(page, 'u');
  let u1 = await findOnScreen(page, { kind: 'edge', at: [[0, 20], [2, 0]], body: box.id });
  let u2 = await findOnScreen(page, { kind: 'edge', at: [[0, -20], [2, 0]], body: box.id });
  let floorZ = 0;
  if (!u1 || !u2) { u1 = await findOnScreen(page, { kind: 'edge', at: [[0, 20], [2, 10]] }); u2 = await findOnScreen(page, { kind: 'edge', at: [[0, -20], [2, 10]] }); floorZ = 10; }
  check('two side edges are found on screen', !!u1 && !!u2);
  await click(page, u1);
  await click(page, u2);
  await accept(7, 'Boundary surface');
  st = await state(page);
  const floor = st.bodies.find((b) => b.createdBy === st.features[6].id);
  check('Boundary surface spans the box between them', floor && floor.sheet && Math.abs(floor.bbox[3] - floor.bbox[0] - 40) < 1e-3 && Math.abs(floor.bbox[2] - floorZ) < 1e-3, JSON.stringify(floor?.bbox));

  // ---------------------------------------------------------------- a sheet across the box, then Mutual trim
  await openNewSketch('front');
  await page.click('[data-tool=Line]');
  await click(page, await screen(page, [-30, 0, 5]));
  await click(page, await screen(page, [30, 0, 5]));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).some((e) => e.type === 'line'); }, null, { timeout: 10000 });
  check('a line on Front', (await entityCount('line')) === 1);
  await finishSketch();
  await settled(page, 8);
  await tool(page, 'Extrude');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.click('.cad-dialog [data-param=bodyType] >> text=Surface');
  await page.fill('.cad-dialog input[data-param=depth]', '30');
  await page.check('.cad-dialog input[data-param=second]');
  await page.fill('.cad-dialog input[data-param=secondDepth]', '30');
  await accept(9, 'Extrude of an open line as a surface');
  st = await state(page);
  const cross = st.bodies.find((b) => b.createdBy === st.features[8].id);
  check('a flat sheet through the box', cross && cross.sheet && Math.abs(cross.bbox[2] - cross.bbox[5]) < 1e-3 && cross.bbox[4] - cross.bbox[1] > 59, JSON.stringify(cross?.bbox));
  const bodiesBefore = st.bodies.length;

  await tool(page, 'Mutual trim');
  await page.waitForSelector('.cad-dialog[data-feature=mutual-trim]');
  await arm(page, 'surfaces');
  const wall = await findOnScreen(page, { kind: 'face', at: [[0, 20]], body: box.id });
  const sheetAt = await findOnScreen(page, { kind: 'face', at: [[2, cross.bbox[2]]], body: cross.id });
  check('the box and the sheet are found on screen', !!wall && !!sheetAt);
  await click(page, wall);
  await click(page, sheetAt);
  check('two surfaces are picked', await page.getAttribute('.cad-dialog [data-param=surfaces]', 'data-count') === '2');
  await accept(10, 'Mutual trim');
  st = await state(page);
  const trimmed = st.bodies.find((b) => b.createdBy === box.createdBy || b.id === box.id);
  check('Mutual trim cuts them along each other into one surface', st.bodies.length === bodiesBefore - 1 && trimmed && trimmed.sheet && trimmed.faces.length === 5, `${st.bodies.length} bodies; ${JSON.stringify(trimmed?.bbox)}`);

  // ---------------------------------------------------------------- Constrained surface: the first sketch's points
  await tool(page, 'Constrained surface');
  await page.waitForSelector('.cad-dialog[data-feature=constrained-surface]');
  await page.click(`.cad-dialog [data-param=sketches] [data-feature-option="${sketch1}"]`);
  await accept(11, 'Constrained surface');
  st = await state(page);
  const fit = st.bodies.find((b) => b.createdBy === st.features[10].id);
  check('Constrained surface fits a sheet through the four corners', fit && fit.sheet && Math.abs(fit.bbox[2]) < 0.05 && Math.abs(fit.bbox[5]) < 0.05 && fit.bbox[3] - fit.bbox[0] > 39, JSON.stringify(fit?.bbox));

  const statuses = await statusOf(page);
  check('every feature built', statuses.every((s) => s.endsWith(':ok')), statuses.join(', '));
  const surfaces = st.bodies.filter((b) => b.sheet).length;
  check('the Parts panel counts every surface', (await page.textContent('[data-group=surfaces]')).includes(`(${surfaces})`), await page.textContent('[data-group=surfaces]'));
  await iso();
  await shot(page, 'surfacing-model');

  // ---------------------------------------------------------------- undo, redo
  const before = await state(page);
  const bodiesAre = (n) => page.waitForFunction((n) => window.JunctionPartStudio.getState().bodies.length === n, n, { timeout: 60000 }).then(() => true, () => false);
  await S(page, () => window.JunctionPartStudio.viewport.canvas.focus());
  await page.keyboard.press('Control+z');
  await settled(page, 10);
  check('undo takes the constrained surface away', await bodiesAre(before.bodies.length - 1));
  await S(page, () => window.JunctionPartStudio.viewport.canvas.focus());
  await page.keyboard.press('Control+y');
  await settled(page, 11);
  check('redo brings it back', await bodiesAre(before.bodies.length));

  // ---------------------------------------------------------------- reload, and a second user
  const sig = (s) => JSON.stringify(s.bodies.map((b) => [b.sheet, b.faces.length, b.bbox.map((x) => Math.round(x * 100))]).sort());
  await page.reload();
  await settled(page, 11);
  const after = await state(page);
  check('after a reload the model is rebuilt the same', sig(after) === sig(before), `${sig(after)} vs ${sig(before)}`);
  const page2 = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  watch(page2);
  await page2.goto(`${BASE}/auth/dev?jwt=${jwt(uid2, 'cad-surfacing-ui-2')}&next=${encodeURIComponent(new URL(page.url()).pathname + new URL(page.url()).search)}`);
  await page2.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  await settled(page2, 11);
  check('a second user sees the same surfaces', sig(await state(page2)) === sig(before));
  check('no page errors', !errors.length, errors.slice(0, 5).join(' | '));
  if (missing.length) console.log('requests that failed:', Array.from(new Set(missing)).join(', '));
} catch (e) {
  check('the script ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : String(e));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
