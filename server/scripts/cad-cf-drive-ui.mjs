// Browser check of the power transmission custom features (web/domains/mechanical/features/cf-drive-*.ts) in the
// real app, done as a person does it: the Custom features part of the toolbar's drop-down, the generated dialogs with
// their live preview, the tool search, and a click on a shaft's surface for a keyway.  It makes
//
//   a spur gear          from the drop-down; its teeth changed in the dialog while the preview follows
//   a planetary set      found through the tool search by "epicyclic"; five bodies
//   a compression spring from the drop-down, beside the others
//   a stepped shaft and a keyway on it, the shaft's surface picked in the viewport
//
// then reloads and checks the server kept it all.  Setup as scripts/cad-ui.mjs:
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8103 PORT=8103 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret E2E_BASE=http://127.0.0.1:8103 [SHOTS=/some/dir] [SHOT_PREFIX=cf-] node scripts/cad-cf-drive-ui.mjs
//
// With SHOTS it saves <prefix>*.png there (light theme, two device pixels per pixel).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, viewFrom } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8103').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', PREFIX = process.env.SHOT_PREFIX || 'cf-drive-';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/${PREFIX}${name}.png` }); } };

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
const state = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return { features: s.features.map((f) => ({ id: f.id, type: f.featureType, name: f.name, params: f.params })), reports: s.reports, bodies: s.bodies.map((b) => ({ id: b.id, name: b.name, faces: b.faces ? b.faces.length : 0 })) }; });
/** The kernel is idle with `n` features, no dialog open, and every built feature has reported. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 240000, polling: 250 });
/** The dialog's preview has been built with what the dialog shows now, and the kernel is idle. */
const previewed = (page) => page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.editing && s.reports[s.editing.draft.id]; }, null, { timeout: 240000, polling: 250 });
const draft = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.editing ? { type: s.editing.draft.featureType, params: s.editing.draft.params, report: s.reports[s.editing.draft.id] || null, bodies: s.bodies.length } : null; });
const fit = (page) => S(page, () => window.JunctionPartStudio.viewport.fit && window.JunctionPartStudio.viewport.fit());
/** Type a value into a number field of the open dialog and wait for the preview to follow. */
async function setField(page, key, value) {
  await page.fill(`.cad-dialog input[data-param=${key}]`, String(value));
  await page.keyboard.press('Tab');
  await page.waitForFunction(([key, value]) => { const s = window.JunctionPartStudio.getState(); return s.editing && Number(s.editing.draft.params[key]) === Number(value); }, [key, value], { timeout: 10000 });
  await page.waitForTimeout(350);
  await previewed(page);
}

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const uid = user('cad-cf-drive-ui', 990377);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await setCad(BASE, jwt(uid, 'cad-cf-drive-ui'));   // Mechanical CAD is off for a new account
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-cf-drive-ui')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Power transmission UI test', template: 'pcb' }) })).json()));
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  check('a part studio opens', true);

  // ---------------------------------------------------------------- the drop-down
  const titles = await toolTitles(page);
  const mine = ['Spur gear', 'Helical gear', 'Herringbone gear', 'Internal gear', 'Gear rack', 'Bevel gear', 'Worm and wheel', 'Planetary gear set', 'Cycloidal disc',
    'Timing pulley', 'Timing belt', 'V-belt pulley', 'Chain sprocket', 'Roller chain', 'Ratchet and pawl', 'Geneva wheel', 'Plate cam', 'Keyway', 'Stepped shaft', 'D-cut',
    'Retaining ring groove', 'Bearing seat', 'Spline', 'Compression spring', 'Extension spring', 'Torsion spring'];
  check('the toolbar offers all 26 power transmission features', mine.every((t) => titles.includes(t)), mine.filter((t) => !titles.includes(t)).join(', '));
  const menu = await S(page, () => { const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes('Spur gear')); return m ? m.getAttribute('data-menu') : null; });
  // library features never take room on the bar (toolbarKeep 0): they are under More, in its Custom features part
  await page.click(`.cad-toolbar [data-menu="${menu}"]`);
  await page.waitForSelector(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="Spur gear"]`);
  await page.locator(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="Torsion spring"]`).scrollIntoViewIfNeeded();
  const heads = await S(page, (menu) => document.querySelector(`.cad-tb-menu[data-menu-of="${menu}"]`).textContent, menu);
  check('they are under Custom features', (menu === 'Custom features' || menu === 'More') && /custom features/i.test(heads), String(menu));
  const icons = await S(page, (menu) => Array.from(document.querySelectorAll(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool]`)).filter((b) => b.querySelector('svg.cad-glyph')).length, menu);
  check('every item of the drop-down has its icon', icons >= mine.length, String(icons));
  await shot(page, 'menu');

  // ---------------------------------------------------------------- a spur gear, its teeth changed while the dialog is open
  await page.click(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="Spur gear"]`);
  await page.waitForSelector('.cad-dialog input[data-param=teeth]');
  await previewed(page);
  let d = await draft(page);
  check('the Spur gear dialog opens with a preview', d && d.type === 'cf-spur-gear' && d.report && d.report.status === 'ok' && d.bodies === 1, JSON.stringify(d && d.report));
  await setField(page, 'teeth', 32);
  await setField(page, 'width', 8);
  d = await draft(page);
  check('the preview follows the dialog', d.params.teeth === 32 && d.report.status === 'ok');
  await fit(page);
  await shot(page, 'spur-dialog');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 1);
  let s = await state(page);
  check('the gear is a feature and a body', s.features[0].type === 'cf-spur-gear' && s.reports[s.features[0].id].status === 'ok' && s.bodies.length === 1, JSON.stringify(s.reports));
  check('it is named after its kind', /^Spur gear 1$/.test(s.features[0].name), s.features[0].name);

  // ---------------------------------------------------------------- a planetary set, found by another word for it
  await page.click('[data-tool-search]');
  await page.keyboard.type('epicyclic');
  await page.waitForTimeout(250);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.cad-dialog input[data-param=sunTeeth]', { timeout: 10000 });
  await previewed(page);
  await setField(page, 'x', 110);
  d = await draft(page);
  check('the tool search finds the planetary set by "epicyclic"', d.type === 'cf-planetary' && d.report.status === 'ok', JSON.stringify(d.report));
  // five planets cannot be spaced evenly on these tooth counts: the dialog says why, and nothing is built
  await setField(page, 'planets', 5);
  d = await draft(page);
  check('an impossible set says why', d.report.status === 'error' && /cannot be spaced evenly/.test(d.report.message || ''), JSON.stringify(d.report));
  await setField(page, 'planets', 3);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  s = await state(page);
  check('the set is five bodies beside the gear', s.bodies.length === 6 && s.bodies.some((b) => /^Sun/.test(b.name)) && s.bodies.some((b) => /^Ring/.test(b.name)), s.bodies.map((b) => b.name).join(', '));

  // ---------------------------------------------------------------- a compression spring
  await tool(page, 'Compression spring');
  await page.waitForSelector('.cad-dialog input[data-param=wire]');
  await previewed(page);
  await setField(page, 'y', 90);
  await setField(page, 'length', 50);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 3);
  s = await state(page);
  check('the spring is built', s.reports[s.features[2].id].status === 'ok' && s.bodies.length === 7, JSON.stringify(s.reports[s.features[2].id]));

  // ---------------------------------------------------------------- a stepped shaft, and a keyway on its surface
  await tool(page, 'Stepped shaft');
  await page.waitForSelector('.cad-dialog input[data-param=steps]');
  await previewed(page);
  await page.fill('.cad-dialog input[data-param=steps]', '20 x 40, 30 x 12, 20 x 25');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await setField(page, 'x', 110);
  await setField(page, 'y', 110);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 4);
  s = await state(page);
  const shaftId = s.features[3].id;
  check('the shaft is built from its table', s.reports[shaftId].status === 'ok' && s.bodies.length === 8, JSON.stringify(s.reports[shaftId]));
  await viewFrom(page, 'iso');
  await fit(page);
  await page.waitForTimeout(500);
  await shot(page, 'parts');

  await tool(page, 'Keyway');
  await page.waitForSelector('.cad-dialog [data-param=face]');
  // a point on screen where the pointer picks the shaft's first step
  const at = await S(page, (shaftId) => {
    const st = window.JunctionPartStudio, cam = st.viewport.camera, r = st.viewport.canvas.getBoundingClientRect();
    cam.updateMatrixWorld();
    for (let a = 0; a < 360; a += 10) for (const z of [8, 14, 20, 26, 32]) {
      const p = [110 + 10 * Math.cos((a * Math.PI) / 180), 110 + 10 * Math.sin((a * Math.PI) / 180), z];
      const v = cam.position.clone().set(p[0], p[1], p[2]).project(cam), x = r.left + ((v.x + 1) / 2) * r.width, y = r.top + ((1 - v.y) / 2) * r.height;
      if (document.elementFromPoint(x, y) !== st.viewport.canvas) continue;
      const hit = st.view.pick({ clientX: x, clientY: y });
      if (hit && hit.kind === 'face' && hit.name === `${shaftId}:step1`) return { x, y };
    }
    return null;
  }, shaftId);
  check('the shaft\'s surface can be found on screen', !!at);
  if (at) {
    await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.editing && s.editing.draft.params.face; }, null, { timeout: 10000 });
    await previewed(page);
    d = await draft(page);
    check('a click on the shaft gives the keyway its face, and the preview cuts it', d.report && d.report.status === 'ok' && d.params.face && d.params.face.name === `${shaftId}:step1`, JSON.stringify(d.report));
    await shot(page, 'keyway-dialog');
    await page.click('.cad-dialog [data-accept]');
    await settled(page, 5);
    s = await state(page);
    check('the keyway is cut by DIN 6885', s.reports[s.features[4].id].status === 'ok' && s.bodies.length === 8, JSON.stringify(s.reports[s.features[4].id]));
  }
  await fit(page);
  await shot(page, 'done');

  // ---------------------------------------------------------------- the server kept it
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  await settled(page, at ? 5 : 4);
  s = await state(page);
  check('after a reload the features are there and built', s.features.map((f) => f.type).join(',') === ['cf-spur-gear', 'cf-planetary', 'cf-compression-spring', 'cf-stepped-shaft', ...(at ? ['cf-keyway'] : [])].join(',') && Object.values(s.reports).every((r) => r.status === 'ok'), JSON.stringify(s.features.map((f) => `${f.type}:${s.reports[f.id]?.status}`)));
  check('the gear kept its 32 teeth', s.features[0].params.teeth === 32);
  check('no errors in the page', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('the script ran to its end', false, String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e));
  if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
