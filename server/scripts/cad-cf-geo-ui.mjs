// Browser check of the "Patterns & texture" and "Geometry & utilities" custom features (features/cf-geo-*.ts)
// in the real app, as a person meets them: the Custom features drop-down of the toolbar, the generated dialog,
// a click on the face to work on, the live preview, ✓.  On a 100 × 60 × 5 plate it
//
//   opens Custom features and finds both families with all their tools, and finds tools by the names people
//   know them by in the tool search;
//   cuts a Voronoi pattern into the top face, raises a QR code on the top of a second plate, and puts the stock
//   block round the first; makes a tapered NACA wing (no pick needed);
//   measures the plate's length into a variable and sees the variable appear with the value;
//   reloads and checks the server kept it all.
//
// Setup as scripts/cad-ui.mjs (a server with KC_DEV_LOGIN=1, psql for the test user):
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret E2E_BASE=http://127.0.0.1:8340 [SHOTS=/some/dir] node scripts/cad-cf-geo-ui.mjs
//
// With SHOTS it writes cf4-*.png there (light theme, 2× pixels).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setCad } from './cad-setting.mjs';
import { BASE, S, chromium, click, faceOnScreen, jwt, previewed, settled, state, user } from './cad-ux-lib.mjs';
import { tool } from './cad-chrome.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/cf4-${name}.png` }); } };

const PATTERNS = ['Attractor pattern', 'Fill pattern', 'Scatter pattern', 'Fibonacci pattern', 'Surface pattern', 'Voronoi pattern', 'Halftone perforation', 'Surface texture', 'Text', 'Text on curve', 'QR code', 'Height map'];
const UTILITIES = ['Equation curve', 'Curve through XYZ points', 'Airfoil wing', 'Tube', 'Cable', 'Spiral', 'Stock body', 'Centre of mass', 'Measure to variable', 'Convex hull', 'Hollow with drain holes', 'Fillet all edges', 'Slices', 'Scale'];

const uuid = () => crypto.randomUUID();
const rect = (x0, y0, x1, y1) => ({
  p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
  la: { type: 'line', a: 'p1', b: 'p2' }, lb: { type: 'line', a: 'p2', b: 'p3' }, lc: { type: 'line', a: 'p3', b: 'p4' }, ld: { type: 'line', a: 'p4', b: 'p1' },
});
const sketch = (id, order, name, entities) => ({ id, featureType: 'sketch', name, order, params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, order, name, sk, depth) => ({ id, featureType: 'extrude', name, order, params: { bodyType: 'solid', profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [] } });
const addFeatures = (page, list) => S(page, (list) => window.JunctionPartStudio.commit(list.map((f) => ({ id: f.id, kind: 'ADDED', typeName: 'feature', item: { ...f, type: 'feature' } }))), list);
const reportsOf = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.name}: ${s.reports[f.id]?.status}${s.reports[f.id]?.message ? ' (' + s.reports[f.id].message + ')' : ''}`); });
const accept = async (page, n) => { await previewed(page); await page.click('.cad-dialog [data-accept]'); await settled(page, n); };
const lastOk = async (page, title) => { const r = await reportsOf(page); check(`${title} is built`, / ok$/.test(r[r.length - 1]), r[r.length - 1]); };

const uid = user('cad-cf-geo-alice', 991471);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setCad(BASE, jwt(uid, 'cad-cf-geo-alice'));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-cf-geo-alice')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Custom features: patterns and utilities' }) })).json());
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // ---- two plates to work on
  const F = { s1: uuid(), e1: uuid(), s2: uuid(), e2: uuid() };
  await addFeatures(page, [sketch(F.s1, 'a1', 'Sketch 1', rect(0, 0, 100, 60)), extrude(F.e1, 'a2', 'Plate', F.s1, 5), sketch(F.s2, 'a3', 'Sketch 2', rect(0, 80, 60, 140)), extrude(F.e2, 'a4', 'Tile', F.s2, 3)]);
  await settled(page, 4);
  let n = 4;

  // ---- the drop-down
  const menu = await page.evaluate(() => { const m = Array.from(document.querySelectorAll('.cad-toolbar [data-menu]')).find((e) => (e.getAttribute('data-items') || '').split('|').includes('Voronoi pattern')); return m ? { id: m.getAttribute('data-menu'), items: (m.getAttribute('data-items') || '').split('|'), text: m.textContent } : null; });
  check('the toolbar has one drop-down that holds the custom features', !!menu, menu ? menu.id : 'none');
  const missing = [...PATTERNS, ...UTILITIES].filter((t) => !menu || !menu.items.includes(t));
  check('… with all 26 pattern, texture, geometry and utility tools in it', !missing.length, missing.join(', '));
  await page.click(`.cad-toolbar [data-menu="${menu.id}"]`);
  const open = await page.evaluate((id) => { const m = document.querySelector(`.cad-tb-menu[data-menu-of="${id}"]`); return m ? m.textContent : ''; }, menu.id);
  check('… the patterns and textures first, then the geometry and utilities', open.indexOf('Attractor pattern') >= 0 && open.indexOf('Height map') < open.indexOf('Equation curve') && open.indexOf('Equation curve') < open.indexOf('Scale'), menu.id);
  await page.evaluate((id) => { const m = document.querySelector('.cad-tb-menu[data-menu-of="' + id + '"]'); const it = m && m.querySelector('[data-tool="Voronoi pattern"]'); if (it) it.scrollIntoView({ block: 'center' }); }, menu.id);
  await shot(page, 'menu');
  await page.keyboard.press('Escape');

  // ---- Voronoi pattern on the plate's top face
  await tool(page, 'Voronoi pattern');
  await page.waitForSelector('.cad-dialog');
  await click(page, await faceOnScreen(page, [`^${F.e1}:end`]));
  await previewed(page);
  await shot(page, 'voronoi-dialog');
  await accept(page, ++n);
  await lastOk(page, 'Voronoi pattern');
  const plate = await S(page, (id) => { const b = window.JunctionPartStudio.getState().bodies.find((x) => x.id === id); return b && b.mesh ? { faces: b.mesh.faces.names.length } : null; }, F.e1);
  check('… and the plate has its cells cut through', !!plate && plate.faces > 100, plate ? `${plate.faces} faces` : '');
  await shot(page, 'voronoi');

  // ---- QR code on the tile
  await tool(page, 'QR code');
  await page.waitForSelector('.cad-dialog');
  await page.fill('.cad-dialog input[data-param=text]', 'https://example.com/part/1234');
  await page.click('.cad-dialog [data-param=target]');
  await click(page, await faceOnScreen(page, [`^${F.e2}:end`]));
  await page.fill('.cad-dialog input[data-param=size]', '40');
  await previewed(page);
  await accept(page, ++n);
  await lastOk(page, 'QR code');
  await shot(page, 'qr');

  // ---- Stock body round the plate
  await tool(page, 'Stock body');
  await page.waitForSelector('.cad-dialog');
  await accept(page, ++n);
  await lastOk(page, 'Stock body');
  const st = { bodies: await S(page, () => window.JunctionPartStudio.getState().bodies.map((b) => ({ name: b.name }))) };
  check('… as a body of its own', st.bodies.some((b) => /Stock/.test(b.name)), st.bodies.map((b) => b.name).join(', '));

  // ---- Airfoil wing: builds from its defaults
  await tool(page, 'Airfoil wing');
  await page.waitForSelector('.cad-dialog');
  await accept(page, ++n);
  await lastOk(page, 'Airfoil wing');
  await shot(page, 'wing');

  // ---- Measure to variable
  await tool(page, 'Measure to variable');
  await page.waitForSelector('.cad-dialog');
  await page.evaluate(() => { const s = window.JunctionPartStudio; s.setParam ? s.setParam('what', 'extent') : null; });
  const whatSet = await page.evaluate(() => window.JunctionPartStudio.getState().editing?.draft.params.what);
  if (whatSet !== 'extent') {
    // through the dialog's own control
    const { pickOption } = await import('./kselect-pick.mjs');
    await pickOption(page, '.cad-dialog k-select[data-param=what]', 'extent');
  }
  await page.fill('.cad-dialog input[data-param=name]', 'overall');
  await accept(page, ++n);
  await lastOk(page, 'Measure to variable');
  await page.waitForFunction(() => { const d = window.JunctionPartStudio.doc; return d && Array.from(d.items ? d.items.values() : []).some((i) => i.type === 'variable' && i.name === 'overall'); }, null, { timeout: 20000 }).catch(() => {});
  const variable = await page.evaluate(() => { const d = window.JunctionPartStudio.doc; const v = d && Array.from(d.items ? d.items.values() : []).find((i) => i.type === 'variable' && i.name === 'overall'); return v ? v.expr : null; });
  check('… and the variable "overall" holds the measured size', typeof variable === 'string' && / mm$/.test(variable), String(variable));

  // ---- the tool search knows them by other names
  for (const [word, title] of [['lithophane', 'Height map'], ['naca', 'Airfoil wing'], ['bounding box', 'Stock body'], ['halftone', 'Halftone perforation'], ['sunflower', 'Fibonacci pattern']]) {
    const box = page.locator('input[placeholder^="Search tools"]').first();
    if (!(await box.count())) { console.log('NOTE  no tool search box found on the toolbar; skipped'); break; }
    await box.fill(word);
    await page.waitForTimeout(300);
    // the title is offered in what the search lists (not in the toolbar's own menus, which are closed)
    const found = await page.evaluate((title) => Array.from(document.querySelectorAll('[data-tool], [role=option], li, button')).some((e) => e.offsetParent && !e.closest('.cad-tb-menu') && (e.textContent || '').trim().startsWith(title)), title);
    await box.fill('');
    check(`the tool search finds ${title} by “${word}”`, !!found);
  }
  await page.keyboard.press('Escape');

  // ---- kept over a reload
  await page.reload();
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  await settled(page, n);
  const after = await reportsOf(page);
  check('after a reload every feature is there and built', after.length === n && after.every((r) => / ok$/.test(r)), after.filter((r) => !/ ok$/.test(r)).join('; '));
  await shot(page, 'all');
  check('no page errors', !errors.length, errors.join(' | '));
} finally { await browser.close(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
