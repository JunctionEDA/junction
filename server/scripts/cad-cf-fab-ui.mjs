// Browser check of the fabrication custom features (web/domains/mechanical/features/cf-fab-*.ts) in the real
// app: the toolbar's list holds all 25 as its Custom features part (they are used less than the tools on the bar,
// so they are under More), a family after the other, and the tool search finds them by the names people know; then a person makes a finger-jointed box with a lid (Box generator), pockets
// its lid (Honeycomb pockets, on a face picked through its field), lays the panels out on a sheet (Auto layout)
// and adds a Print-in-place hinge, each from the drop-down through its dialog with the live preview.
//
// Setup as scripts/cad-ui.mjs: a server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=… E2E_BASE=http://127.0.0.1:8320 [SHOTS=dir] [SHOT_PREFIX=cf2-] node scripts/cad-cf-fab-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, viewFrom } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8320').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', PREFIX = process.env.SHOT_PREFIX || 'cf-fab-';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(600); await page.screenshot({ path: `${SHOTS}/${PREFIX}${name}.png` }); } };

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
/** Wait for the preview of the draft as it now stands to come out well (a change takes a moment to reach the kernel). */
const previewedOk = async (page) => {
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.editing && s.kernel.state === 'ready' && s.reports[s.editing.draft.id]?.status === 'ok'; }, null, { timeout: 60000 }).catch(() => {});
  return previewed(page);
};
const statuses = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.featureType}:${s.reports[f.id]?.status}${s.reports[f.id]?.message ? ` (${s.reports[f.id].message})` : ''}`).join(' '); });
const allOk = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.every((f) => s.reports[f.id]?.status === 'ok'); });
const bodies = (page) => S(page, () => window.JunctionPartStudio.getState().bodies.map((b) => ({ id: b.id, name: b.name, reference: !!b.reference, faces: b.mesh ? b.mesh.faces.names : [] })));
const draftReport = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.reports[s.editing.draft.id]; });
const fill = (page, key, pick) => S(page, ([key, pick]) => window.JunctionPartStudio.fillField(key, pick), [key, pick]);
const setParams = (page, params) => S(page, (params) => { const s = window.JunctionPartStudio; s.setDraft({ params: { ...s.getState().editing.draft.params, ...params } }); }, params);
const accept = async (page, n) => { await previewed(page); await page.click('.cad-dialog [data-accept]'); await settled(page, n); };

const LASER = ['Laser joint', 'Box joint', 'Tab and slot', 'T-slot joint', 'Dogbone', 'Kerf compensation', 'Living hinge', 'Auto layout', 'Box generator', 'Press-fit test comb', 'Puzzle joint', 'Mortise and tenon', 'Dovetail joint', 'Dowel / biscuit holes', 'Pocket hole'];
const PRINT = ['Snap-fit hook', 'Annular snap fit', 'Heat-set insert hole', 'Screw boss', 'Print-in-place hinge', 'Split with pins', 'Teardrop hole', 'Elephant-foot chamfer', 'Lattice infill', 'Honeycomb pockets'];

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const uid = user('cad-cf-fab', 990931);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await setCad(BASE, jwt(uid, 'cad-cf-fab'));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-cf-fab')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Fabrication features', template: 'pcb' }) });
    return r.json();
  });
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // ---------------------------------------------------------------- the drop-down and the search
  const titles = await toolTitles(page, 'feature');
  check('the toolbar offers every Laser & CNC feature', LASER.every((t) => titles.includes(t)), LASER.filter((t) => !titles.includes(t)).join(', '));
  check('the toolbar offers every 3D printing feature', PRINT.every((t) => titles.includes(t)), PRINT.filter((t) => !titles.includes(t)).join(', '));
  const menuOf = (title) => S(page, (title) => {
    const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes(title));
    return m ? m.getAttribute('data-menu') : null;
  }, title);
  const menu = await menuOf('Laser joint');
  check('they are in a drop-down of the toolbar', !!menu, String(menu));
  await page.click(`.cad-toolbar [data-menu="${menu}"]`);
  await page.waitForSelector(`.cad-tb-menu[data-menu-of="${menu}"]`);
  const listed = await S(page, (menu) => {
    const box = document.querySelector(`.cad-tb-menu[data-menu-of="${menu}"]`);
    return { text: box.textContent, tools: Array.from(box.querySelectorAll('[data-tool]')).map((b) => b.getAttribute('data-tool')), groups: Array.from(box.querySelectorAll('[role=group]')).map((g) => Array.from(g.querySelectorAll('[data-tool]')).map((b) => b.getAttribute('data-tool'))), icons: Array.from(box.querySelectorAll('[data-tool] svg')).length };
  }, menu);
  check('the drop-down lists all 25, each with its icon', [...LASER, ...PRINT].every((t) => listed.tools.includes(t)) && listed.icons >= 25, `${listed.tools.length} tools, ${listed.icons} icons`);
  // each family is a part of the list under its own heading, Laser & CNC before 3D printing
  const laserAt = listed.groups.findIndex((g) => g.includes('Laser joint')), printAt = listed.groups.findIndex((g) => g.includes('Snap-fit hook'));
  check('each family is a part of the list of its own, Laser & CNC before 3D printing', laserAt >= 0 && printAt > laserAt && LASER.every((t) => listed.groups[laserAt].includes(t)) && PRINT.every((t) => listed.groups[printAt].includes(t)), `${laserAt}, ${printAt}`);
  await S(page, (menu) => document.querySelector(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="Dogbone"]`).scrollIntoView({ block: 'start' }), menu);
  await shot(page, 'menu');
  await S(page, (menu) => document.querySelector(`.cad-tb-menu[data-menu-of="${menu}"] [data-tool="Honeycomb pockets"]`).scrollIntoView({ block: 'end' }), menu);
  await shot(page, 'menu-print');
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- Box generator: six panels, live preview
  await tool(page, 'Box generator');
  await page.waitForSelector('.cad-dialog[data-feature=cf-fab-box]');
  await previewed(page);
  check('Box generator previews as soon as its dialog opens', (await draftReport(page)).status === 'ok', JSON.stringify(await draftReport(page)));
  await setParams(page, { lid: 'jointed', height: 45 });
  await previewed(page);
  await page.waitForFunction(() => window.JunctionPartStudio.getState().bodies.length === 6, null, { timeout: 60000 });
  await viewFrom(page, 'iso');
  await shot(page, 'box-dialog');
  await accept(page, 1);
  let all = await bodies(page);
  check('Box generator makes six panels', (await allOk(page)) && all.length === 6 && ['Front', 'Back', 'Left', 'Right', 'Bottom', 'Lid'].every((n) => all.some((b) => b.name === n)), `${await statuses(page)}: ${all.map((b) => b.name).join(', ')}`);
  const boxId = await S(page, () => window.JunctionPartStudio.getState().features[0].id);

  // ---------------------------------------------------------------- Honeycomb pockets through the lid
  await tool(page, 'Honeycomb pockets');
  await page.waitForSelector('.cad-dialog[data-feature=cf-fab-honeycomb]');
  const lid = all.find((b) => b.name === 'Lid');
  const lidTop = lid.faces.find((n) => n === `${boxId}:lid:end`);
  await fill(page, 'face', { kind: 'face', body: lid.id, name: lidTop, point: [0, 0, 45] });
  await setParams(page, { through: true, size: 10, wall: 2, border: 8 });
  await previewedOk(page);
  check('Honeycomb pockets previews on the picked face', (await draftReport(page)).status === 'ok', JSON.stringify(await draftReport(page)));
  await shot(page, 'honeycomb-dialog');
  await accept(page, 2);
  check('Honeycomb pockets cuts the lid', (await allOk(page)) && (await bodies(page)).find((b) => b.name === 'Lid').faces.some((n) => /:c0\.0:s1/.test(n)), await statuses(page));

  // ---------------------------------------------------------------- Auto layout: the panels flat on a sheet
  await tool(page, 'Auto layout');
  await page.waitForSelector('.cad-dialog[data-feature=cf-fab-nest]');
  await setParams(page, { move: true, sheetLength: 300, sheetWidth: 200 });
  await previewedOk(page);
  check('Auto layout previews', (await draftReport(page)).status === 'ok', JSON.stringify(await draftReport(page)));
  await accept(page, 3);
  all = await bodies(page);
  check('Auto layout moves the six panels onto one sheet', (await allOk(page)) && all.filter((b) => !b.reference).length === 6 && all.filter((b) => b.reference).length === 1, `${await statuses(page)}: ${all.map((b) => b.name).join(', ')}`);
  await viewFrom(page, 'iso');
  await viewFrom(page, 'fit');
  await shot(page, 'layout');

  // ---------------------------------------------------------------- Print-in-place hinge, standing on the front plane
  await tool(page, 'Print-in-place hinge');
  await page.waitForSelector('.cad-dialog[data-feature=cf-fab-pip-hinge]');
  await setParams(page, { plane: { kind: 'plane', plane: 'front' } });
  await previewedOk(page);
  check('Print-in-place hinge previews', (await draftReport(page)).status === 'ok', JSON.stringify(await draftReport(page)));
  await shot(page, 'hinge-dialog');
  await accept(page, 4);
  all = await bodies(page);
  check('Print-in-place hinge makes two leaves', (await allOk(page)) && all.some((b) => b.name === 'Leaf A') && all.some((b) => b.name === 'Leaf B'), await statuses(page));
  await viewFrom(page, 'fit');
  await shot(page, 'all');

  // ---------------------------------------------------------------- found by the names people know
  const found = async (words) => {
    await page.click('.cad-toolbar [data-tool-search]');
    await page.waitForSelector('.cad-palette [data-palette-input]');
    await page.keyboard.type(words);
    await page.waitForTimeout(200);
    const hits = await page.$$eval('.cad-palette [data-command]', (els) => els.map((e) => e.getAttribute('data-command')));
    await page.keyboard.press('Escape');
    return hits;
  };
  for (const [words, title] of [['kerf', 'Kerf compensation'], ['captive', 'T-slot joint'], ['knurled', 'Heat-set insert hole'], ['nest', 'Auto layout'], ['finger', 'Laser joint'], ['overhang', 'Teardrop hole'], ['jigsaw', 'Puzzle joint'], ['kreg', 'Pocket hole']]) {
    const hits = await found(words);
    check(`the tool search finds ${title} by "${words}"`, hits.includes(title), hits.slice(0, 6).join(' | '));
  }
  check('no page error', !errors.length, errors.join(' | '));
} catch (e) {
  console.log(`FAIL  the script stopped: ${e.stack || e}`);
  fail++;
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
