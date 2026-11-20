// Browser check of the hardware custom features (features/cf-hw-*.ts) in the real app: the Custom features
// drop-down lists every one of them under its family; then a person makes three from it, each in a part studio
// of its own, through the ordinary dialog with its live preview: an Enclosure with its defaults, a Bolt whose
// thread is switched to Modelled in the dialog, and a Hinge opened to 120°.  Then a Thread on a cylinder picked
// by its face.  Each is screenshotted.
//
// Setup as scripts/cad-ui.mjs: a server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=… E2E_BASE=http://127.0.0.1:8330 [SHOTS=dir] [SHOT_PREFIX=cf3-] node scripts/cad-cf-hw-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, viewFrom } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8330').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', PREFIX = process.env.SHOT_PREFIX || 'cf-hw-';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(700); await page.screenshot({ path: `${SHOTS}/${PREFIX}${name}.png` }); } };

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
}, n, { timeout: 120000 });
const previewed = (page) => page.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id];
}, null, { timeout: 120000 });
const state = (page) => S(page, () => {
  const s = window.JunctionPartStudio.getState();
  return { features: s.features.map((f) => ({ type: f.featureType, name: f.name, status: s.reports[f.id]?.status, message: s.reports[f.id]?.message || '' })), bodies: s.bodies.map((b) => ({ id: b.id, name: b.name, faces: b.mesh ? b.mesh.faces.names.length : 0 })) };
});
const setParams = (page, params) => S(page, (params) => { const s = window.JunctionPartStudio; s.setDraft({ params: { ...s.getState().editing.draft.params, ...params } }); }, params);
const draftStatus = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); const r = s.reports[s.editing.draft.id]; return `${r.status}${r.message ? ' (' + r.message + ')' : ''}`; });
const accept = async (page, n) => { await previewed(page); await page.click('.cad-dialog [data-accept]'); await settled(page, n); };
async function newStudio(page) {
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().features.length === 0, null, { timeout: 30000 });
  await page.waitForFunction(() => window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 120000 });
}

const THREADS = ['Thread', 'Internal thread', 'Pipe thread', 'Cosmetic thread', 'Bolt', 'Nut', 'Washer', 'Standoff', 'Fastener holes', 'Nut pocket', 'Knurl'];
const HARDWARE = ['Enclosure', 'Lip and groove', 'PCB mounts', 'O-ring groove', 'O-ring', 'Gasket', 'Bearing pocket', 'Magnet pocket', 'Mount pattern', 'Vents', 'Cable gland hole', 'Feet', 'DIN rail clip', 'Hinge', 'Knob'];

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const uid = user('cad-cf-hw', 990931);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await setCad(BASE, jwt(uid, 'cad-cf-hw'));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-cf-hw')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Threads, fasteners and enclosures', template: 'pcb' }) });
    return r.json();
  });
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await newStudio(page);

  // ---------------------------------------------------------------- the drop-down
  const titles = await toolTitles(page);
  check('the toolbar offers every thread and fastener feature', THREADS.every((t) => titles.includes(t)), THREADS.filter((t) => !titles.includes(t)).join(', '));
  check('the toolbar offers every enclosure and hardware feature', HARDWARE.every((t) => titles.includes(t)), HARDWARE.filter((t) => !titles.includes(t)).join(', '));
  const menu = await S(page, () => {
    const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes('Enclosure'));
    return m ? m.getAttribute('data-menu') : null;
  });
  // one Custom features drop-down; in a window too narrow for it, a Custom features part of More
  check('they are in the Custom features drop-down (or under More)', menu === 'Custom features' || menu === 'More', String(menu));
  await page.click(`.cad-toolbar [data-menu="${menu}"]`);
  await page.waitForSelector(`.cad-tb-menu[data-menu-of="${menu}"]`);
  const groups = await S(page, (menu) => Array.from(document.querySelectorAll(`.cad-tb-menu[data-menu-of="${menu}"] [role=group]`)).map((g) => Array.from(g.querySelectorAll('[data-tool]')).map((b) => b.getAttribute('data-tool'))), menu);
  check('each family is a group of the drop-down, in order', groups.some((g) => THREADS.every((t, i) => g[i] === t) || THREADS.every((t) => g.includes(t))) && groups.some((g) => HARDWARE.every((t) => g.includes(t))), JSON.stringify(groups).slice(0, 400));
  await S(page, (menu) => { const e = document.querySelector(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="Knurl"]`); if (e) e.scrollIntoView({ block: 'center' }); }, menu);
  await shot(page, 'menu');
  await page.keyboard.press('Escape');

  // the tool search finds them by the words people use
  const found = await S(page, () => {
    const s = window.JunctionPartStudio;
    return typeof s.searchTools === 'function' ? ['captive nut', 'npt', 'project box', 'nema17'].map((q) => (s.searchTools(q)[0] || {}).title || '') : null;
  });
  if (found) check('the tool search finds them by other names', found[0] === 'Nut pocket' && found[1] === 'Pipe thread' && found[2] === 'Enclosure' && found[3] === 'Mount pattern', found.join(', '));

  // ---------------------------------------------------------------- 1. an enclosure, as it comes
  await tool(page, 'Enclosure');
  await previewed(page);
  check('the Enclosure dialog previews a base and a lid', (await draftStatus(page)) === 'ok' && (await state(page)).bodies.length === 2, await draftStatus(page));
  await shot(page, 'enclosure-dialog');
  await accept(page, 1);
  let st = await state(page);
  check('Enclosure makes two bodies, Base and Lid', st.features[0].status === 'ok' && st.bodies.map((b) => b.name).join(',') === 'Base,Lid', JSON.stringify(st));
  await viewFrom(page, 'iso');
  await shot(page, 'enclosure');

  // ---------------------------------------------------------------- 2. a bolt, its thread modelled in the dialog
  await newStudio(page);
  await tool(page, 'Bolt');
  await previewed(page);
  const plainFaces = (await state(page)).bodies[0].faces;
  await setParams(page, { head: 'hex', size: 'M8', length: 30, thread: 'modelled', threaded: 18 });
  await page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies[0] && s.bodies[0].mesh && s.bodies[0].mesh.faces.names.length > n + 8; }, plainFaces, { timeout: 120000 });
  check('changing Thread to Modelled in the dialog rebuilds the preview with a helical thread', (await draftStatus(page)) === 'ok', await draftStatus(page));
  await shot(page, 'bolt-dialog');
  await accept(page, 1);
  st = await state(page);
  const boltFaces = await S(page, () => window.JunctionPartStudio.getState().bodies[0].mesh.faces.names);
  check('the bolt has a hexagon head and named thread faces', st.features[0].status === 'ok' && boltFaces.filter((n) => n.includes(':head:flat')).length === 6 && boltFaces.some((n) => n.includes(':thread:crest')) && boltFaces.some((n) => n.includes(':thread:flank')), boltFaces.slice(0, 8).join(' '));
  await viewFrom(page, 'iso');
  await shot(page, 'bolt');

  // ---------------------------------------------------------------- 3. a hinge, part open
  await newStudio(page);
  await tool(page, 'Hinge');
  await previewed(page);
  await setParams(page, { open: 120 });
  await page.waitForTimeout(300);
  await accept(page, 1);
  st = await state(page);
  check('Hinge makes two leaves and a pin', st.features[0].status === 'ok' && st.bodies.map((b) => b.name).join(',') === 'Leaf A,Leaf B,Pin', JSON.stringify(st.bodies));
  await viewFrom(page, 'iso');
  await shot(page, 'hinge');

  // ---------------------------------------------------------------- 4. a thread on a picked cylinder
  await newStudio(page);
  await tool(page, 'Standoff');
  await previewed(page);
  await setParams(page, { body: 'round', size: 'M8', length: 6, across: 16, ends: 'mf', stud: 16 });
  await page.waitForTimeout(300);
  await accept(page, 1);
  const stud = await S(page, () => { const b = window.JunctionPartStudio.getState().bodies[0]; return { body: b.id, name: b.mesh.faces.names.find((n) => n.endsWith(':stud')) }; });
  check('the standoff has a stud to thread', !!stud.name, JSON.stringify(stud));
  await tool(page, 'Thread');
  await S(page, (stud) => window.JunctionPartStudio.fillField('face', { kind: 'face', body: stud.body, name: stud.name }), stud);
  await previewed(page);
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.reports[s.editing.draft.id] && s.reports[s.editing.draft.id].status === 'ok' && s.bodies[0].mesh && s.bodies[0].mesh.faces.names.some((n) => n.includes(':crest')); }, null, { timeout: 120000 });
  check('Thread fits M8 to the picked Ø8 stud and previews it', (await draftStatus(page)) === 'ok', await draftStatus(page));
  await shot(page, 'thread-dialog');
  await accept(page, 2);
  st = await state(page);
  check('the thread is cut on the stud', st.features.every((f) => f.status === 'ok') && st.bodies.length === 1, JSON.stringify(st.features));
  await viewFrom(page, 'iso');
  await shot(page, 'thread');

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  console.error(e);
  fail++;
} finally {
  await browser.close();
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
