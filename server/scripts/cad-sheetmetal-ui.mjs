// Browser test of sheet metal and frames in the real app: the toolbar has every tool of both groups (in their
// sections, the joint and corner variants under a caret), then a person builds a small model with them from the
// toolbar and the viewport: a plate (Sheet metal model on a sketched rectangle), a flange and a hem on its edges
// picked in the viewport, a bend along a sketch line, a form, the Flat pattern panel with its bend table and DXF;
// a frame of square tube around a second rectangle, mitred, with a gusset, an end cap and a cut list whose table
// and CSV are checked.  Then undo and redo, a reload, and a second person who sees the same model.
//
// Setup as scripts/cad-ui.mjs: a server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=… E2E_BASE=http://127.0.0.1:8204 [CAD_DIST=dir] [SHOTS=dir] node scripts/cad-sheetmetal-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, openPanel, sketchOn } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8204').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', DIST = process.env.CAD_DIST || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

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
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 90000 });
const previewed = (page) => page.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id];
}, null, { timeout: 60000 });
const statuses = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.featureType}:${s.reports[f.id]?.status}${s.reports[f.id]?.message ? ` (${s.reports[f.id].message})` : ''}`).join(' '); });
const allOk = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.every((f) => s.reports[f.id]?.status === 'ok'); });
const click = async (page, p) => { await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.down(); await page.mouse.up(); };
const screenOf = (page, p) => S(page, (p) => {
  const st = window.JunctionPartStudio, c = st.viewport.canvas.getBoundingClientRect();
  const v = new (Object.getPrototypeOf(st.viewport.camera.position).constructor)(p[0], p[1], p[2]);
  const q = st.viewport.project(v);
  return { x: c.left + q.x, y: c.top + q.y };
}, p);
/** The middle of a mesh edge whose name has every one of `match`, in the world. */
const edgeMid = (page, match) => S(page, (match) => {
  const s = window.JunctionPartStudio.getState();
  for (const b of s.bodies) {
    const m = b.mesh; if (!m) continue;
    const i = m.edges.names.findIndex((n) => match.every((x) => n.includes(x)));
    if (i < 0) continue;
    const a = m.edges.start[i], n = m.edges.count[i], seg = Math.floor(n / 2) & ~1;
    const p = (j) => [m.edges.positions[(a + j) * 3], m.edges.positions[(a + j) * 3 + 1], m.edges.positions[(a + j) * 3 + 2]];
    const q0 = p(seg), q1 = p(seg + 1);
    return { name: m.edges.names[i], body: b.id, at: [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2] };
  }
  return null;
}, match);
/** The face names of every body (to find what a feature made). */
const faceNames = (page) => S(page, () => window.JunctionPartStudio.getState().bodies.flatMap((b) => (b.mesh ? b.mesh.faces.names.map((n) => ({ body: b.id, name: n })) : [])));
const draft = (page) => S(page, () => window.JunctionPartStudio.getState().editing?.draft.params);
const fill = (page, key, pick) => S(page, ([key, pick]) => window.JunctionPartStudio.fillField(key, pick), [key, pick]);
const setParams = (page, params) => S(page, (params) => { const s = window.JunctionPartStudio; s.setDraft({ params: { ...s.getState().editing.draft.params, ...params } }); }, params);
const accept = async (page, n) => { await previewed(page); await page.click('.cad-dialog [data-accept]'); await settled(page, n); };

/** Pick in the viewport as a person does: rest the pointer on it and click; true when the hover was what we wanted. */
async function pickAt(page, world, want) {
  const p = await screenOf(page, world);
  await page.mouse.move(p.x, p.y, { steps: 3 });
  await page.waitForTimeout(150);
  const h = await S(page, () => window.JunctionPartStudio.getState().hover);
  if (!h || !want(h)) return false;
  await click(page, p);
  return true;
}

/** Draw a rectangle in the open sketch by clicking two corners (sketch-plane points given in the world). */
async function rectangle(page, a, b) {
  await page.waitForTimeout(800);   // the view turns to face the sketch
  await page.click('[data-tool=Rectangle]');
  await click(page, await screenOf(page, a));
  await page.mouse.move(...Object.values(await screenOf(page, b)), { steps: 5 });
  await click(page, await screenOf(page, b));
  await page.keyboard.press('Escape');
}
const sketchEntities = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return f.params.sketch.entities; });

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', acceptDownloads: true });
  if (DIST) {
    for (const f of ['mechanical.js', 'cad-worker.js']) {
      const body = fs.readFileSync(path.join(DIST, f));
      await ctx.route(new RegExp(`/static/dist/${f.replace('.', '\\.')}(\\?.*)?$`), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
    }
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await setCad(BASE, jwt(uid, login));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

try {
  const aliceId = user('cad-sm-alice', 990801), bobId = user('cad-sm-bob', 990802);
  const page = await open(aliceId, 'cad-sm-alice');
  const project = await page.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sheet metal and frames', template: 'pcb' }) });
    return r.json();
  });
  const pid = project.projectId;
  await page.goto(`${BASE}/p/${pid}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // ---------------------------------------------------------------- the toolbar (wide enough for every button)
  await page.setViewportSize({ width: 3000, height: 900 });
  await page.waitForTimeout(300);
  const titles = await toolTitles(page, 'feature');
  const SM = ['Sheet metal model', 'Flange', 'Hem', 'Tab', 'Bend', 'Form', 'Make joint', 'Modify joint', 'Rip', 'Corner', 'Bend relief', 'Corner break', 'Finish sheet metal', 'Flat pattern'];
  const FR = ['Frame', 'Trim', 'Gusset', 'End cap', 'Cut list'];
  check('the toolbar has every sheet metal tool', SM.every((t) => titles.includes(t)), SM.filter((t) => !titles.includes(t)).join(', '));
  check('the toolbar has every frame tool', FR.every((t) => titles.includes(t)), FR.filter((t) => !titles.includes(t)).join(', '));
  const menus = await S(page, () => Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).map((m) => m.getAttribute('data-items')));
  // each section is one button and a caret, as Onshape groups them: the tools in Onshape's order, the joints and the corners together
  check('the sheet metal tools are one Sheet metal ▾ button, in order, the joints and the corners together', menus.some((m) => m === SM.join('|')), menus.join(' / '));
  check('the frame tools are one Frames ▾ button', menus.some((m) => m === FR.join('|')), menus.join(' / '));
  await page.click('.cad-toolbar [data-menu="Sheet metal"]');
  const parts = await S(page, () => Array.from(document.querySelectorAll('.cad-tb-menu[data-menu-of="Sheet metal"] [role=group]')).map((g) => Array.from(g.querySelectorAll('[data-tool]')).map((b) => b.getAttribute('data-tool')).join('|')));
  check('… its drop-down keeps each family apart, between rules', parts.includes('Make joint|Modify joint|Rip') && parts.includes('Corner|Bend relief|Corner break'), parts.join(' / '));
  await page.keyboard.press('Escape');
  // a tool in the drop-down has its tooltip as a button on the bar has
  await page.click('.cad-toolbar [data-menu="Sheet metal"]');
  await page.hover('.cad-tb-menu[data-menu-of="Sheet metal"] [data-tool=Flange]');
  await page.waitForTimeout(500);
  const tip = await S(page, () => document.querySelector('.cad-tip')?.textContent || null);
  await page.keyboard.press('Escape');
  check('a sheet metal tool has a tooltip', !!tip && /bend/i.test(tip), String(tip));
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.waitForTimeout(300);

  // ---------------------------------------------------------------- the plate: a 100 × 60 rectangle on Top
  await sketchOn(page, 'top');
  await rectangle(page, [-50, -30, 0], [50, 30, 0]);
  check('a rectangle is drawn', Object.values(await sketchEntities(page)).filter((e) => e.type === 'line').length === 4);
  await page.click("[data-tool='Finish sketch']");
  await settled(page, 1);

  await tool(page, 'Sheet metal model');
  await page.waitForSelector('.cad-dialog[data-feature=sm-model]');
  const sk1 = await S(page, () => window.JunctionPartStudio.getState().features[0].id);
  if (!(await pickAt(page, [0, 0, 0], (h) => h.kind === 'sketch'))) await fill(page, 'profile', { kind: 'sketch', featureId: sk1, entity: null, region: null, point: [0, 0, 0] });
  await page.fill('.cad-dialog input[data-param=thickness]', '1');
  await accept(page, 2);
  const flat0 = await S(page, () => window.JunctionPartStudio.kernel.call('sm-flat-pattern', {}));
  check('Sheet metal model makes the plate', (await allOk(page)) && flat0.models.length === 1 && flat0.models[0].pieces.length === 1, await statuses(page));
  const plateArea = flat0.models[0].pieces[0].area;

  // ---------------------------------------------------------------- a flange on the front edge, picked in the viewport
  await tool(page, 'Flange');
  await page.waitForSelector('.cad-dialog[data-feature=sm-flange]');
  let e = await edgeMid(page, ['side@-90', ':top']);
  let picked = e && (await pickAt(page, e.at, (h) => h.kind === 'edge' || h.kind === 'face'));
  if (!(await draft(page)).edges.length) { const f = (await faceNames(page)).find((x) => x.name.includes(':side@-90:')); await fill(page, 'edges', { kind: 'face', body: f.body, name: f.name, point: [0, -30, 0.5] }); picked = false; }
  await page.fill('.cad-dialog input[data-param=length]', '20');
  await accept(page, 3);
  check('Flange adds a wall on the picked edge', (await allOk(page)), `${await statuses(page)}${picked ? '' : ' (picked by its field)'}`);

  // ---------------------------------------------------------------- a hem on the back edge
  await tool(page, 'Hem');
  await page.waitForSelector('.cad-dialog[data-feature=sm-hem]');
  e = await edgeMid(page, ['side@90', ':top']);
  if (!(e && (await pickAt(page, e.at, (h) => h.kind === 'edge' || h.kind === 'face'))) || !(await draft(page)).edges.length) {
    const f = (await faceNames(page)).find((x) => /:sm[^:]*\.w1:side@90:/.test(x.name) || x.name.includes(':side@90:'));
    await fill(page, 'edges', { kind: 'face', body: f.body, name: f.name, point: [0, 30, 0.5] });
  }
  await accept(page, 4);
  check('Hem folds the back edge over', await allOk(page), await statuses(page));

  // ---------------------------------------------------------------- a form at a sketch point on the plate's top
  await sketchOn(page, 'top');
  await page.waitForTimeout(800);
  await page.click('[data-tool=Point]').catch(() => {});
  await click(page, await screenOf(page, [-25, 0, 0]));
  await page.keyboard.press('Escape');
  const pt = Object.entries(await sketchEntities(page)).find(([, x]) => x.type === 'point');
  await page.click("[data-tool='Finish sketch']");
  await settled(page, 5);
  const sk2 = await S(page, () => window.JunctionPartStudio.getState().features[4].id);
  await tool(page, 'Form');
  await page.waitForSelector('.cad-dialog[data-feature=sm-form]');
  // the point lies on the plate's bottom (the sketch is on Top, z = 0): the dimple goes up through the plate
  await fill(page, 'points', { kind: 'sketch', featureId: sk2, entity: pt ? pt[0] : null, region: null, point: [-25, 0, 0] });
  await accept(page, 6);
  check('Form presses a dimple at the sketch point', (await allOk(page)), await statuses(page));

  // ---------------------------------------------------------------- the flat pattern
  await tool(page, 'Flat pattern');
  await openPanel(page, 'sm-flat');
  await page.waitForSelector('[data-panel="sm-flat"] [data-bend-table]', { timeout: 30000 });
  const bendRows = await page.locator('[data-panel="sm-flat"] [data-bend]').count();
  check('the flat pattern panel shows the bends in its table', bendRows === 2, `${bendRows} bends`);
  check('the flat view draws bend lines', (await page.locator('[data-panel="sm-flat"] [data-bend-line]').count()) === 2);
  const [dxf] = await Promise.all([page.waitForEvent('download'), page.click('[data-panel="sm-flat"] [data-flat-dxf]')]);
  const dxfText = fs.readFileSync(await dxf.path(), 'utf8');
  check('the flat pattern downloads as DXF with cut and bend layers', /\nCUT\n/.test(dxfText) && /BEND_(UP|DOWN)/.test(dxfText) && /EOF\n$/.test(dxfText), dxf.suggestedFilename());
  const flat1 = await S(page, () => window.JunctionPartStudio.kernel.call('sm-flat-pattern', {}));
  check('the flat pattern grew by the flange and the hem', flat1.models[0].pieces[0].area > plateArea + 1000, `${plateArea} → ${flat1.models[0].pieces[0].area}`);
  await page.click('.v3-views [data-view=iso]').catch(() => {});
  await page.click('.v3-views [data-view=fit]').catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, 'sheetmetal-model');

  // ---------------------------------------------------------------- a frame of square tube along a U on Front, below the plate
  await sketchOn(page, 'front');
  await page.waitForTimeout(800);   // the view turns to face the sketch
  await page.click('[data-tool=Line]');
  for (const q of [[-40, 0, -15], [-40, 0, -55], [40, 0, -55], [40, 0, -15]]) {
    const at = await screenOf(page, q);
    await page.mouse.move(at.x, at.y, { steps: 6 });
    await page.waitForTimeout(120);
    await click(page, at);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).filter((e) => e.type === 'line').length >= 3; }, null, { timeout: 10000 }).catch(() => {});
  const lines = Object.entries(await sketchEntities(page)).filter(([, x]) => x.type === 'line').map(([id]) => id);
  check('a U of three lines is drawn', lines.length === 3, `${lines.length} lines`);
  await page.click("[data-tool='Finish sketch']");
  await settled(page, 7);
  const sk3 = await S(page, () => window.JunctionPartStudio.getState().features[6].id);
  await tool(page, 'Frame');
  await page.waitForSelector('.cad-dialog[data-feature=frame]');
  await page.selectOption('.cad-dialog select[data-param=family]', 'square-tube').catch(() => {});
  await page.selectOption('.cad-dialog select[data-param=size_square_tube]', '20x20x2').catch(() => {});
  await page.waitForTimeout(200);
  // one segment picks the path joined to it
  await fill(page, 'path', { kind: 'sketch', featureId: sk3, entity: lines[0], region: null, point: [-40, 0, -35] });
  await accept(page, 8);
  const members = await S(page, () => window.JunctionPartStudio.getState().bodies.filter((b) => /Square tube/.test(b.name)).map((b) => ({ id: b.id, bbox: b.mesh.bbox, faces: b.mesh.faces.names })));
  check('Frame makes three members, mitred where they meet', (await allOk(page)) && members.length === 3, `${members.length} members; ${await statuses(page)}`);

  // a gusset in one corner, and an end cap on an open end
  const vertical = members.filter((a) => a.bbox[5] - a.bbox[2] > a.bbox[3] - a.bbox[0]), horizontal = members.filter((a) => !vertical.includes(a));
  await tool(page, 'Gusset');
  await page.waitForSelector('.cad-dialog[data-feature=frame-gusset]');
  await setParams(page, { members: [vertical[0].id, horizontal[0].id], length: 30, thickness: 4 });
  await accept(page, 9);
  check('Gusset joins two members', await allOk(page), await statuses(page));

  await tool(page, 'End cap');
  await page.waitForSelector('.cad-dialog[data-feature=frame-end-cap]');
  // the open end at the top of a vertical member: its end face is the one at the top of its box
  const capEnd = vertical.map((v) => ({ v, name: v.faces.find((n) => /:(start|end)$/.test(n)) })).find((x) => x.name);
  await fill(page, 'faces', { kind: 'face', body: capEnd.v.id, name: capEnd.name, point: [capEnd.v.bbox[0] + 10, 0, capEnd.v.bbox[5]] });
  await accept(page, 10);
  check('End cap closes an open end', (await allOk(page)), await statuses(page));

  await tool(page, 'Cut list');
  await page.waitForSelector('.cad-dialog[data-feature=frame-cut-list]');
  await accept(page, 11);
  await openPanel(page, 'frame-cut-list');
  await page.waitForSelector('[data-panel="frame-cut-list"] [data-cut-table]', { timeout: 30000 });
  const rows = await S(page, () => Array.from(document.querySelectorAll('[data-panel="frame-cut-list"] [data-cut-row]')).map((r) => ({ qty: Number(r.querySelector('[data-qty]').textContent), text: r.textContent })));
  const qty = rows.reduce((n, r) => n + r.qty, 0);
  check('the cut list counts the members, the gusset and the cap', qty === 5 && rows.some((r) => r.qty === 2), rows.map((r) => r.text).join(' | '));
  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('[data-panel="frame-cut-list"] [data-cut-csv]')]);
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  check('the cut list downloads as CSV', /^Item,Qty,Description/.test(csvText) && csvText.trim().split('\n').length === rows.length + 1, csv.suggestedFilename());
  await page.click('.v3-views [data-view=fit]').catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, 'frames-model');

  // ---------------------------------------------------------------- undo, redo
  await page.focus('.cad-stage canvas').catch(() => {});
  await page.keyboard.press('Control+z');
  await settled(page, 10);
  await page.keyboard.press('Control+y');
  await settled(page, 11).catch(async () => { await page.keyboard.press('Control+Shift+z'); await settled(page, 11); });
  check('undo takes the cut list away and redo puts it back', (await S(page, () => window.JunctionPartStudio.getState().features.length)) === 11);

  // ---------------------------------------------------------------- reload, and a second person
  const url = page.url();
  const before = await statuses(page), bodiesBefore = await S(page, () => window.JunctionPartStudio.getState().bodies.length);
  await page.reload();
  await settled(page, 11);
  check('after a reload the model is the same', (await statuses(page)) === before && (await S(page, () => window.JunctionPartStudio.getState().bodies.length)) === bodiesBefore, await statuses(page));
  const invited = await page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cad-sm-bob', role: 'editor' }) })).status, pid);
  const bob = await open(bobId, 'cad-sm-bob');
  await bob.goto(url);
  await settled(bob, 11);
  check('a second person sees the same sheet metal and frames', invited === 200 && (await statuses(bob)) === before && (await S(bob, () => window.JunctionPartStudio.getState().bodies.length)) === bodiesBefore, await statuses(bob));
  const flatBob = await S(bob, () => window.JunctionPartStudio.kernel.call('sm-flat-pattern', {}));
  check('and the same flat pattern', Math.abs(flatBob.models[0].pieces[0].area - flat1.models[0].pieces[0].area) < 1e-6);

  // the toolbar, for the screenshot: the sheet metal and frame sections, the sheet metal drop-down open
  await page.setViewportSize({ width: 2600, height: 900 });
  await page.waitForTimeout(400);
  await page.click('.cad-toolbar [data-menu="Sheet metal"]').catch(() => {});
  await page.waitForTimeout(300);
  if (SHOTS) {
    // the frame and sheet metal sections, with the open drop-down under them
    const r = await S(page, () => {
      const rs = ['[data-section=frame]', '[data-section=sheetmetal]', '.cad-tb-menu'].map((q) => document.querySelector(q)?.getBoundingClientRect()).filter(Boolean);
      return { x: Math.min(...rs.map((b) => b.left)), r: Math.max(...rs.map((b) => b.right)), b: Math.max(...rs.map((b) => b.bottom)) };
    });
    await page.screenshot({ path: `${SHOTS}/sheetmetal-toolbar.png`, clip: { x: Math.max(0, r.x - 12), y: 0, width: Math.ceil(r.r - r.x + 24), height: Math.ceil(r.b + 12) } });
  }
  await page.keyboard.press('Escape');
} catch (err) {
  check('the run finished', false, String(err && err.stack || err));
} finally {
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
