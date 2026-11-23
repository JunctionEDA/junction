// Browser test of the assembly's chrome, driven as a person would drive it: the one-row toolbar and its tool
// search (S, Ctrl+K, Alt+C; "hinge", "joint", "ground", "bom"), tooltips, the instance tree (count, filter,
// states, folders, reordering, a right click), a mate picked from the bar, Replicate, a mate offset, a Gear
// relation driven from the Animate panel, a Width mate picked on four faces, Group, an instance pattern, a saved
// exploded view, the section, Measure, Mass properties, the bill of materials, the right-click menu with its
// marking ring, rebinding a key, and a double click that opens a part in its part studio.
//
// Setup as scripts/cad-assembly-ui.mjs (a server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql):
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-assembly-chrome-ui.mjs
//
// SHOTS: a folder for screenshots (light theme, two device pixels per pixel), named asm-*.png.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/asm-${name}.png` }); } };

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

// ---- part studios as files (the format of mechanical/CONTRACT.md): sketches on the Top plane, extruded
const poly = (pts) => { const e = {}; pts.forEach(([x, y], i) => { e['p' + i] = { type: 'point', x, y }; }); pts.forEach((_, i) => { e['l' + i] = { type: 'line', a: 'p' + i, b: 'p' + ((i + 1) % pts.length) }; }); return e; };
const circle = (id, x, y, r) => ({ [id + 'c']: { type: 'point', x, y }, [id]: { type: 'circle', center: id + 'c', r } });
const studioText = (features) => JSON.stringify({ junction: 'part-studio', version: 1, items: [{ id: 'studio', type: 'studio', units: 'mm', rollback: null }, ...features] });
const sketch = (id, order, entities) => ({ id, type: 'feature', featureType: 'sketch', name: 'Sketch', order, params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, order, sk, depth, name) => ({ id, type: 'feature', featureType: 'extrude', name, order, params: { profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [] } });
const HOLES = [[20, 20], [100, 20], [20, 60], [100, 60]];
// a 120 × 80 × 10 plate with four ⌀6 holes
const PLATE = studioText([sketch('ps', 'V', { ...poly([[0, 0], [120, 0], [120, 80], [0, 80]]), ...Object.assign({}, ...HOLES.map(([x, y], i) => circle('h' + i, x, y, 3))) }), extrude('plate', 'h', 'ps', 10, 'Plate')]);
// a ⌀6 × 15 pin, and a ⌀30 × 5 disc with a ⌀6 hole off its middle (so a turn can be seen), drawn beside the plate
const HARDWARE = studioText([sketch('s1', 'V', circle('pin', 150, 30, 3)), extrude('pin', 'h', 's1', 15, 'Pin'), sketch('s2', 'm', { ...circle('rim', 200, 30, 15), ...circle('eye', 208, 30, 3) }), extrude('disc', 'p', 's2', 5, 'Disc')]);
// a channel (a U, 40 wide inside, open towards +y) and a 20 wide tab
const SLOT = studioText([sketch('s1', 'V', poly([[0, 100], [60, 100], [60, 140], [50, 140], [50, 110], [10, 110], [10, 140], [0, 140]])), extrude('channel', 'h', 's1', 30, 'Channel'), sketch('s2', 'm', poly([[100, 100], [120, 100], [120, 120], [100, 120]])), extrude('tab', 'p', 's2', 30, 'Tab')]);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const asm = (page, fn, arg) => page.evaluate(fn, arg);
const at = (page, p) => page.evaluate((p) => { const v = window.JunctionAssembly.viewport, s = v.project(v.target.clone().set(p[0], p[1], p[2])), r = v.canvas.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }, p);
const settled = (page, n) => page.waitForFunction((n) => {
  const a = window.JunctionAssembly, s = a && a.getState();
  return !!s && s.loaded && !s.building && s.instances.length === n && s.instances.every((i) => i.suppressed || s.instanceInfo[i.id]?.status === 'ready') && (!s.canEdit || a.unsettled < 1e-6) && a.session.unsaved === 0;
}, n, { timeout: 90000 });
const inst = (page, name) => page.evaluate((name) => { const a = window.JunctionAssembly, i = a.getState().instances.find((x) => x.name === name); return i ? { id: i.id, t: a.transformOf(i.id), info: a.getState().instanceInfo[i.id], fixed: !!i.fixed, hidden: !!i.hidden } : null; }, name);
const mateOf = (page, name) => page.evaluate((name) => { const s = window.JunctionAssembly.getState(), m = s.mates.find((x) => x.name === name); return m ? { id: m.id, params: m.params, info: s.mateInfo[m.id], a: m.a, b: m.b } : null; }, name);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const click = async (page, p) => { await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); };
const menu = async (page, row, entry) => { await page.click(row, { button: 'right' }); await page.click(`[role=menu] >> text="${entry}"`); };
/** Look along a direction (z up), then fit. */
const look = (page, dir) => page.evaluate((d) => { const a = window.JunctionAssembly, v = a.viewport; v.lookAlong(v.target.clone().set(d[0], d[1], d[2]), v.target.clone().set(0, 0, 1), false); a.fit(); }, dir);
const canvas = (page) => page.evaluate(() => window.JunctionAssembly.viewport.canvas.focus());
/** Open the tool search with a key, type, and say what it found first (and by which word). */
async function search(page, key, text) {
  await canvas(page);
  await page.keyboard.press(key);
  await page.waitForSelector('[data-palette-input]');
  await page.fill('[data-palette-input]', text);
  const first = await page.$eval('#asm-palette-list [role=option]', (el) => ({ title: el.getAttribute('data-command'), by: el.querySelector('[data-command-by]')?.getAttribute('data-command-by') || null })).catch(() => null);
  return first;
}

try {
  const uid = user('asm-chrome', 990021);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await setCad(BASE, jwt(uid, 'asm-chrome'));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'asm-chrome')}&next=/`);
  await page.waitForLoadState('networkidle');

  const project = await page.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Gearbox', template: 'pcb' }) })).json()));
  const pid = project.projectId;
  const newDoc = (name, text) => page.evaluate(async ({ pid, name, text }) => {
    const made = await (await fetch(`/api/projects/${pid}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: name }) })).json();
    const r = await fetch(`/api/docs/${made.docId}/snapshots?seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text });
    return { docId: made.docId, status: r.status };
  }, { pid, name, text });
  await newDoc('Plate.jpart', PLATE); await newDoc('Hardware.jpart', HARDWARE); await newDoc('Slot.jpart', SLOT);
  await page.goto(`${BASE}/p/${pid}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New assembly');
  await page.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });

  // ---------------------------------------------------------------- the bar
  const bar = await page.$eval('.cad-toolbar', (el) => ({ h: el.offsetHeight, scroll: el.scrollWidth > el.clientWidth + 1, sections: Array.from(el.querySelectorAll('[data-section]')).map((s) => s.getAttribute('data-section')), mates: el.querySelectorAll('[data-mate-tool]').length, moved: el.getAttribute('data-moved') }));
  check('one row of tools in sections, a button for each of the ten mates, nothing scrolls', bar.h <= 46 && !bar.scroll && bar.mates === 10 && ['edit', 'insert', 'mate', 'connect', 'relation', 'pattern', 'view', 'inspect', 'file'].every((s) => bar.sections.includes(s)), JSON.stringify(bar));
  check('the tool search is at the right end of the bar, and the panel rail at the right edge', await page.isVisible('[data-tool-search]') && (await page.$$('[data-rail] [data-rail-tool]')).length >= 6);
  await page.hover('[data-tool=Insert]');
  await page.waitForSelector('.cad-tip');
  const tip = await page.textContent('.cad-tip');
  check('a tooltip names the tool, its key and what it does', /Insert/.test(tip) && /I/.test(tip) && /supplier/i.test(tip), tip);
  check('a mate says why it cannot start yet', /Place two instances first/.test(await page.getAttribute('[data-mate-tool=revolute]', 'aria-description')));
  await shot(page, '01-empty-bar');
  await page.mouse.move(700, 500);

  // ---------------------------------------------------------------- the tool search
  const found = {};
  for (const [key, word] of [['s', 'hinge'], ['Control+k', 'joint'], ['Alt+c', 'ground'], ['s', 'bom'], ['s', 'explode'], ['s', 'gear'], ['s', 'constrain'], ['s', 'weight'], ['s', 'clash'], ['s', 'array']]) {
    found[word] = await search(page, key, word);
    if (word === 'joint') await shot(page, '02-search-joint');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-palette-input]', { state: 'detached' });
  }
  check('S, Ctrl+K and Alt+C open the tool search; it finds tools by other words for them', found.hinge?.title === 'Revolute' && found.hinge.by === 'hinge' && found.joint?.title === 'Fastened' && found.ground?.title === 'Fix' && found.bom?.title === 'Bill of materials' && found.explode?.title === 'Exploded view' && found.gear?.title === 'Gear relation'
    && found.constrain?.title === 'Fastened' && found.weight?.title === 'Mass properties' && found.clash?.title === 'Interference' && found.array?.title === 'Linear pattern', JSON.stringify(found));
  const every = await (async () => { await canvas(page); await page.keyboard.press('s'); await page.waitForSelector('[data-palette-input]'); const n = await page.$$eval('#asm-palette-list [role=option]', (els) => els.map((e) => e.getAttribute('data-command'))); await page.keyboard.press('Escape'); return n; })();
  check('with nothing typed it lists every tool, mate and relation', ['Insert', 'Fastened', 'Width', 'Gear relation', 'Rack and pinion relation', 'Screw relation', 'Linear relation', 'Group', 'Replicate', 'Section view', 'Measure', 'Keyboard shortcuts'].every((t) => every.includes(t)), `${every.length} entries`);
  await page.click('[data-tool-search]');
  await page.waitForSelector('[data-palette-input]');
  await page.fill('[data-palette-input]', 'insert');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-insert-dialog]');
  check('the field in the bar opens the search in place, and Enter runs the first result', true);

  // ---------------------------------------------------------------- insert five parts of three part studios
  await page.waitForSelector('[data-insert-dialog] [data-source-doc]', { timeout: 90000 });
  for (const name of ['Plate', 'Hardware', 'Slot']) if (!(await page.$(`[data-source-doc=${name}][data-open]`))) await page.click(`[data-source-doc=${name}] >> text=${name}`);
  await page.waitForSelector('[data-source-doc=Plate] [data-offer]', { timeout: 120000 });
  await page.waitForSelector('[data-source-doc=Hardware] [data-all]', { timeout: 120000 });
  await page.waitForSelector('[data-source-doc=Slot] [data-all]', { timeout: 120000 });
  check('Insert keeps its tabs, Suppliers among them', (await page.$$eval('[data-insert-dialog] [data-insert-tab]', (els) => els.map((e) => e.getAttribute('data-insert-tab')))).includes('suppliers'));
  await page.click('[data-source-doc=Plate] [data-offer]');
  await page.click('[data-source-doc=Hardware] [data-all]');
  await page.click('[data-source-doc=Slot] [data-all]');
  await page.waitForFunction(() => window.JunctionAssembly.scene.ghostCount >= 5, null, { timeout: 30000 });
  await page.click('[data-insert-dialog] [data-accept]');
  await settled(page, 5);
  await asm(page, () => { const a = window.JunctionAssembly; a.getState().instances.forEach((i, n) => a.rename(i.id, ['Plate', 'Pin', 'Disc', 'Channel', 'Tab'][n])); });
  await page.waitForSelector('[data-instance=Tab]');
  await settled(page, 5);

  // ---------------------------------------------------------------- the tree
  check('the tree is headed "Instances (5)" and starts with the assembly itself', /Instances\s*\(5\)/.test(await page.textContent('[data-panel=instances] header')) && await page.isVisible('[data-panel=instances] [data-root]'));
  await page.fill('[data-tree-filter]', 'pi');
  check('the filter keeps the instances whose name has those letters', (await page.$$eval('[data-panel=instances] [data-instance]', (els) => els.map((e) => e.getAttribute('data-instance')))).join() === 'Pin');
  await page.fill('[data-tree-filter]', '');
  await page.click('[data-instance=Plate]');
  await canvas(page);
  await page.keyboard.press('f');
  await page.waitForFunction(() => window.JunctionAssembly.getState().instances[0].fixed === true);
  check('F fixes the selected instance; the tree says fixed, and free for the others', (await page.textContent('[data-instance=Plate] [data-badge]')) === 'fixed' && (await page.textContent('[data-instance=Pin] [data-badge]')) === 'free' && (await page.getAttribute('[data-instance=Pin]', 'data-state')) === 'free');
  // a folder, by the button; an instance moved into it and out again; the order changed
  await page.click('[data-new-folder]');
  await page.fill("[data-panel=instances] input[aria-label='Name']", 'Slide');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-group=Slide]');
  await page.click('[data-instance=Channel]');
  await page.click('[data-instance=Tab]', { modifiers: ['Shift'] });
  check('Shift selects a range', (await asm(page, () => window.JunctionAssembly.getState().selection.length)) === 2);
  await menu(page, '[data-instance=Tab]', 'Move to Slide');
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.instances.filter((i) => i.group === s.groups[0].id).length === 2; });
  await menu(page, '[data-instance=Disc]', 'Move up');
  await page.waitForFunction(() => window.JunctionAssembly.getState().instances.map((i) => i.name).join() === 'Plate,Disc,Pin,Channel,Tab');
  check('instances go into a folder and change places from the right-click menu', true);
  await menu(page, '[data-instance=Disc]', 'Move down');
  await page.waitForFunction(() => window.JunctionAssembly.getState().instances.map((i) => i.name).join() === 'Plate,Pin,Disc,Channel,Tab');
  await settled(page, 5);

  // ---------------------------------------------------------------- a Revolute mate from the bar, with an offset: a disc on the plate's first hole
  await look(page, [-0.5, 0.8, -0.7]);
  await page.waitForTimeout(300);
  await page.click('[data-mate-tool=revolute]');
  await page.waitForSelector('[data-mate-dialog=revolute] [data-connector=a][data-armed]');
  check('while a mate is open the bar offers Accept and Cancel', await page.isVisible('.cad-toolbar [data-tool=Accept]') && await page.isVisible('.cad-toolbar [data-tool=Cancel]'));
  // edges only: the rim of the hole, not the face round it
  await page.click('[data-mate-dialog] [data-filter=face]');
  await page.click('[data-mate-dialog] [data-filter=vertex]');
  const rim = (c, r, z, a = 2.2) => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a), z];
  await click(page, await at(page, rim(HOLES[0], 3, 10)));
  await page.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  await click(page, await at(page, rim([200, 30], 15, 5)));
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  const picked = await asm(page, () => { const m = window.JunctionAssembly.getState().mating; return [m.a.ref.kind, m.b.ref.kind, m.a.instance !== m.b.instance]; });
  check('with Faces and Points off, the two clicks take the two rims', picked[0] === 'edge' && picked[1] === 'edge' && picked[2]);
  // the disc's top rim is now in the plate's top: lift it by its thickness with the mate's offset
  let disc = await inst(page, 'Disc');
  const sunk = disc.t[11];
  await page.fill('[data-mate-dialog] input[data-param=offset]', '5');
  await page.waitForFunction((z) => Math.abs(window.JunctionAssembly.transformOf(window.JunctionAssembly.getState().instances.find((i) => i.name === 'Disc').id)[11] - z) > 4.9, sunk);
  disc = await inst(page, 'Disc');
  if (disc.t[11] < sunk) { await page.fill('[data-mate-dialog] input[data-param=offset]', '-5'); await page.waitForFunction((z) => window.JunctionAssembly.transformOf(window.JunctionAssembly.getState().instances.find((i) => i.name === 'Disc').id)[11] > z + 4.9, sunk); }
  await page.check('[data-mate-dialog] input[data-param=offsets]');
  check('every mate has an Offset: X, Y and a turn beside the one along its axis', await page.isVisible('[data-mate-dialog] input[data-param=offsetX]') && await page.isVisible('[data-mate-dialog] input[data-param=offsetY]'));
  await shot(page, '03-mate-dialog');
  await page.click('.cad-toolbar [data-tool=Accept]');
  await settled(page, 5);
  disc = await inst(page, 'Disc');
  check('the disc sits on the plate over the first hole, free to turn', near(disc.t[3] + 200, HOLES[0][0], 1e-3) && near(disc.t[7] + 30, HOLES[0][1], 1e-3) && near(disc.t[11], 10, 1e-3) && disc.info.dof === 1, `${disc.t[3] + 200} ${disc.t[7] + 30} ${disc.t[11]} dof ${disc.info.dof}`);
  check('the list is headed "Mate features (1)"', /Mate features\s*\(1\)/.test(await page.textContent('[data-panel=mates] header')));

  // a second disc, and its hinge on the second hole made the same way
  await menu(page, '[data-instance=Disc]', 'Copy in a row…');
  await page.fill('[data-form] input[data-param=count]', '1');
  await page.fill('[data-form] input[data-param=x]', '60');
  await page.fill('[data-form] input[data-param=z]', '30');
  await page.click('[data-form] [data-accept]');
  await settled(page, 6);
  await page.click('[data-mate-tool=revolute]');
  await page.waitForSelector('[data-mate-dialog=revolute] [data-connector=a][data-armed]');
  await click(page, await at(page, rim(HOLES[1], 3, 10)));
  await page.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  const d2 = await inst(page, 'Disc 2');
  await click(page, await at(page, rim([200 + d2.t[3], 30 + d2.t[7], 0], 15, 5 + d2.t[11])));
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  await page.fill('[data-mate-dialog] input[data-param=offset]', String((await mateOf(page, 'Revolute 1')).params.offset));
  await canvas(page);
  await page.keyboard.press('Enter');
  await settled(page, 6);
  check('a second hinge: two freedoms now, one each', (await asm(page, () => window.JunctionAssembly.getState().dof)) === 2 + 18);

  // ---------------------------------------------------------------- a Gear relation between the two hinges
  await page.click('[data-mate="Revolute 1"]');
  check('a click on a mate lights up its two instances in the model', (await asm(page, () => window.JunctionAssembly.scene.stats.selected ?? -1)) !== 0);
  await page.click('.cad-toolbar [data-slot="relation/Relations"] [data-tool]');
  await page.waitForSelector("[data-form='Gear relation']");
  await page.fill('[data-form] input[data-param=ratio]', '2');
  await shot(page, '04-gear-form');
  await page.click('[data-form] [data-accept]');
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.relations.length === 1 && s.relationInfo[s.relations[0].id]?.state === 'ok' && s.dof === 19; }, null, { timeout: 10000 });
  check('the gear ties the two hinges: one freedom between them, listed among the mate features', (await page.textContent('[data-relation="Gear 1"] [data-value]')).includes('2 : 1') && /\(3\)/.test(await page.textContent('[data-panel=mates] header')));
  // drive one from the Animate panel's slider: the other follows, twice as far, the other way
  await page.click('[data-rail-tool=animate]');
  await page.waitForSelector('[data-animate-panel] [data-drive]');
  const before = await asm(page, () => { const s = window.JunctionAssembly.getState(); return s.mates.map((m) => s.mateInfo[m.id].values.angle); });
  const which = await page.getAttribute('[data-animate-panel]', 'data-mate');
  await page.focus('[data-animate-panel] [data-drive]');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => window.JunctionAssembly.session.unsaved === 0 && window.JunctionAssembly.unsettled < 1e-6);
  const after = await asm(page, () => { const s = window.JunctionAssembly.getState(); return s.mates.map((m) => s.mateInfo[m.id].values.angle); });
  const turned = after.map((v, i) => ((v - before[i] + 540) % 360) - 180);
  const driven = which === 'Revolute 1' ? 0 : 1, other = 1 - driven;
  // Gear 1 says: its first mate (Revolute 1) turns twice for one turn of the second, reversed
  check('the slider turns one disc 20° and the gear turns the other with it, in the ratio', near(turned[driven], 20, 1e-3) && (driven === 1 ? near(turned[other], -40, 1e-2) : near(turned[other], -10, 1e-2)), `${which}: ${turned.map((v) => v.toFixed(3)).join(' / ')}`);
  await page.click('[data-animate-panel] [data-play]');
  await page.waitForFunction(() => !!window.JunctionAssembly.getState().animating);
  await page.waitForTimeout(500);
  const mid = await asm(page, () => { const s = window.JunctionAssembly.getState(); return s.mates.map((m) => s.mateInfo[m.id].values.angle); });
  await shot(page, '05-gear-animate');
  await page.click('[data-animate-panel] [data-play]');
  await page.waitForFunction(() => !window.JunctionAssembly.getState().animating);
  await settled(page, 6);
  const rest = await asm(page, () => { const s = window.JunctionAssembly.getState(); return s.mates.map((m) => s.mateInfo[m.id].values.angle); });
  check('Play sweeps it, both discs turning; Stop puts them back', Math.abs(mid[0] - after[0]) > 1 && Math.abs(mid[1] - after[1]) > 1 && near(rest[0], after[0], 1e-3) && near(rest[1], after[1], 1e-3), `${mid.map((v) => v.toFixed(1))} → ${rest.map((v) => v.toFixed(1))}`);
  await page.click('[data-panel=animate] [aria-label="Close Animate"]');

  // ---------------------------------------------------------------- a pin fastened in the third hole, then Replicate
  await page.click('[data-mate-tool=fastened]');
  await page.waitForSelector('[data-mate-dialog=fastened] [data-connector=a][data-armed]');
  await click(page, await at(page, rim(HOLES[2], 3, 10)));
  await page.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  await click(page, await at(page, rim([150, 30], 3, 15)));
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  await page.click('[data-mate-dialog] [data-accept]');
  await settled(page, 6);
  check('the pin is fastened in the third hole: the tree says held', (await page.textContent('[data-instance=Pin] [data-badge]')) === 'held' && near((await inst(page, 'Pin')).t[3] + 150, HOLES[2][0], 1e-3));
  await page.click('[data-instance=Pin]');
  await page.click('.cad-toolbar [data-menu=Pattern]');
  await page.waitForSelector('[data-menu-of=Pattern]');
  check('Pattern ▾ lists Linear pattern, Circular pattern and Replicate', (await page.$$eval('[data-menu-of=Pattern] [data-tool]', (els) => els.map((e) => e.getAttribute('data-tool')))).join() === 'Linear pattern,Circular pattern,Replicate');
  await shot(page, '06-pattern-menu');
  await page.click('[data-menu-of=Pattern] [data-tool=Replicate]');
  await settled(page, 9);
  const pins = await asm(page, () => { const a = window.JunctionAssembly; return a.getState().instances.filter((i) => /^Pin/.test(i.name)).map((i) => { const t = a.transformOf(i.id); return [Math.round(t[3] + 150), Math.round(t[7] + 30)].join(); }).sort(); });
  check('Replicate puts a pin, with its mate, in each of the other three holes', pins.join(' ') === HOLES.map((h) => h.join()).sort().join(' ') && (await asm(page, () => window.JunctionAssembly.getState().mates.filter((m) => m.mateType === 'fastened').length)) === 4, pins.join(' '));

  // ---------------------------------------------------------------- Width: the tab centred in the channel (four faces, the view turned between them)
  await page.click('[data-mate-tool=width]');
  await page.waitForSelector('[data-mate-dialog=width] [data-connector=a][data-armed]');
  await look(page, [-1, -1, -0.5]);
  await page.waitForTimeout(300);
  await click(page, await at(page, [10, 130, 15]));
  await page.waitForSelector('[data-mate-dialog] [data-connector=a2][data-armed]');
  await look(page, [1, -1, -0.5]);
  await page.waitForTimeout(300);
  await click(page, await at(page, [50, 130, 15]));
  await page.waitForSelector('[data-mate-dialog] [data-connector=b][data-armed]');
  await click(page, await at(page, [100, 110, 15]));
  await page.waitForSelector('[data-mate-dialog] [data-connector=b2][data-armed]');
  await look(page, [-1, -1, -0.5]);
  await page.waitForTimeout(300);
  const tab0 = await inst(page, 'Tab');
  await click(page, await at(page, [120 + tab0.t[3], 110 + tab0.t[7], 15 + tab0.t[11]]));
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && !s.mating.field && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  await shot(page, '07-width-mate');
  await page.click('[data-mate-dialog] [data-accept]');
  await settled(page, 9);
  const tab = await inst(page, 'Tab'), channel = await inst(page, 'Channel');
  // the middle of the tab (110, 110, 15 in its own space) lies in the plane half-way between the walls (x = 30 in the channel's)
  const put = (t, p) => [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]];
  const tabMid = put(tab.t, [110, 110, 15]), slot = put(channel.t, [30, 125, 15]), across = [channel.t[0], channel.t[4], channel.t[8]];
  const off = (tabMid[0] - slot[0]) * across[0] + (tabMid[1] - slot[1]) * across[1] + (tabMid[2] - slot[2]) * across[2];
  check('Width centres the tab between the channel\'s two walls', Math.abs(off) < 1e-4 && Math.hypot(tab.t[3], tab.t[7], tab.t[11]) > 30, `the tab's middle is ${off.toExponential(1)} mm from the slot's middle plane`);

  // ---------------------------------------------------------------- Group: the channel and the tab move as one
  await page.click('[data-instance=Channel]');
  await page.click('[data-instance=Tab]', { modifiers: ['Control'] });
  const dofBefore = await asm(page, () => window.JunctionAssembly.getState().dof);
  await canvas(page);
  await page.keyboard.press('g');
  await page.waitForFunction(() => window.JunctionAssembly.getState().rigids.length === 1);
  await page.waitForFunction((d) => window.JunctionAssembly.getState().dof === d - 3, dofBefore);
  check('G groups the selected instances: they keep their places and move as one', await page.isVisible('[data-rigid="Group 1"]'), `freedoms ${dofBefore} → ${dofBefore - 3}`);

  // ---------------------------------------------------------------- a linear pattern of the tab, changed afterwards
  await page.click('[data-instance=Tab]');
  await search(page, 's', 'linear pat');
  await page.keyboard.press('Enter');
  await page.waitForSelector("[data-form='Linear pattern']");
  await page.fill('[data-form] input[data-param=count]', '3');
  await page.fill('[data-form] input[data-param=spacing]', '40');
  await page.click('[data-form] [data-param=along]');
  await page.click('[role=option] >> text="Along Z"');
  await page.click('[data-form] [data-accept]');
  await settled(page, 11);
  const zs = await asm(page, () => { const a = window.JunctionAssembly, s = a.getState(); const tab = s.instances.find((i) => i.name === 'Tab'); return s.instances.filter((i) => i.pattern).map((i) => Math.round((a.transformOf(i.id)[11] - a.transformOf(tab.id)[11]) * 1000) / 1000).sort((p, q) => p - q); });
  check('a linear pattern: two copies of the tab, 40 and 80 mm up, listed under their pattern', zs.join() === '40,80' && await page.isVisible('[data-pattern="Linear pattern 1"]') && (await page.$$('[data-panel=instances] [data-instance^="Tab "]')).length === 2, zs.join());
  await menu(page, '[data-pattern-row="Linear pattern 1"]', 'Edit…');
  await page.fill('[data-form] input[data-param=count]', '2');
  await page.click('[data-form] [data-accept]');
  await settled(page, 10);
  check('its count is changed from the mate features list: one copy goes', (await asm(page, () => window.JunctionAssembly.getState().instances.filter((i) => i.pattern).length)) === 1);
  await look(page, [-0.6, 0.8, -0.6]);
  await page.click('[data-panel=instances] [data-root]');
  await shot(page, '08-assembled');

  // ---------------------------------------------------------------- an exploded view, saved, shut, opened again
  await page.click("[data-tool='Exploded view']");
  await page.waitForSelector('[data-explode]');
  await page.click('[data-explode] [data-explode-save-as]');
  await page.fill('[data-form] input[data-param=name]', 'Service');
  await page.click('[data-form] [data-accept]');
  await page.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.explodes.length === 1 && s.explodeView === s.explodes[0].id && window.JunctionAssembly.session.unsaved === 0; });
  const saved = await asm(page, () => Object.keys(window.JunctionAssembly.getState().explodes[0].offsets).length);
  await shot(page, '09-exploded');
  await page.click('[data-explode] >> text=Done');
  await page.waitForSelector('[data-explode]', { state: 'detached' });
  const home = await inst(page, 'Disc');
  await page.click('[data-explode-row=Service]');
  await page.waitForSelector('[data-explode][data-view=Service]');
  const apart = await asm(page, () => { const a = window.JunctionAssembly, i = a.getState().instances.find((x) => x.name === 'Disc'); return { shown: a.scene.transformOf(i.id), stored: a.transformOf(i.id) }; });
  check('an exploded view is kept under a name and comes back from the list; the assembly itself has not moved', saved >= 5 && Math.hypot(apart.shown[3] - apart.stored[3], apart.shown[7] - apart.stored[7], apart.shown[11] - apart.stored[11]) > 3 && near(apart.stored[3], home.t[3], 1e-6), `${saved} instances pulled`);
  await page.click('[data-explode-row=Service]');
  await page.waitForSelector('[data-explode]', { state: 'detached' });

  // ---------------------------------------------------------------- the section, Measure, Mass properties, the bill of materials
  await page.click('[data-rail-tool=section]');
  await page.waitForSelector('[data-section-bar]');
  await page.click('[data-section-bar] [data-section-axis=y]');
  await page.click('[data-section-bar] [data-section-flip]');
  check('Section view cuts the model across an axis', (await asm(page, () => window.JunctionAssembly.viewport.renderer.clippingPlanes.length)) === 1 && (await page.getAttribute('[data-section-bar]', 'data-axis')) === 'y');
  await shot(page, '10-section');
  await page.click('[data-section-bar] >> text=Done');
  check('…and Done makes it whole again', (await asm(page, () => window.JunctionAssembly.viewport.renderer.clippingPlanes.length)) === 0);

  await canvas(page);
  await page.keyboard.press('m');
  await page.waitForSelector('[data-measure-panel][data-picking]');
  await click(page, await at(page, [60, 40, 10]));                       // the plate's top face
  await page.waitForSelector('[data-measured="1"]');
  await click(page, await at(page, [HOLES[0][0] - 8, HOLES[0][1] - 6, 15]));   // the top face of the disc that turns on the first hole
  await page.waitForSelector('[data-measure=distance]');
  const apartText = await page.textContent('[data-measure=apart]').catch(() => '');
  check('Measure: two flat faces, the distance between their planes', /^5 mm$/.test(apartText.trim()) && /^0°$/.test((await page.textContent('[data-measure=angle]')).trim()), apartText);
  await shot(page, '11-measure');
  await page.keyboard.press('Escape');
  await page.click('[data-panel=measure] [aria-label="Close Measure"]');

  await page.click('[data-panel=instances] [data-root]');
  await page.click("[data-tool='Mass properties']");
  await page.waitForFunction(() => { const el = document.querySelector('[data-mass=volume]'); return !!el && /\d/.test(el.textContent || ''); }, null, { timeout: 120000 });
  const massCount = await page.textContent('[data-mass=count]'), vol = await page.textContent('[data-mass=volume]');
  // plate 120·80·10 less four holes, 4 pins, 2 discs less their eyes, the channel, 2 tabs
  const expect = (120 * 80 * 10 - 4 * Math.PI * 9 * 10) + 4 * Math.PI * 9 * 15 + 2 * (Math.PI * 225 * 5 - Math.PI * 9 * 5) + (60 * 40 - 40 * 30) * 30 + 2 * 20 * 20 * 30;
  check('Mass properties adds up the ten parts where they stand', massCount.trim() === '10' && near(parseFloat(vol), expect / 1000, 0.5), `${massCount} parts, ${vol} (expected ${(expect / 1000).toFixed(2)} cm³)`);
  await shot(page, '12-mass');
  await page.click('[data-rail-tool=mass]');
  await page.waitForSelector('[data-panel=mass]', { state: 'detached' });

  await page.click("[data-tool='Bill of materials']");
  await page.waitForSelector('[data-panel=bom] table tbody tr', { timeout: 60000 });
  const bom = await page.$$eval('[data-panel=bom] table tbody tr', (rows) => rows.map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.textContent.trim())));
  const qty = (name) => { const r = bom.find((x) => x[1] === name); return r ? Number(r[3]) : 0; };
  check('the bill of materials counts them: 4 pins, 2 discs, 2 tabs; it exports CSV', bom.some((r) => Number(r[3]) === 4) && bom.filter((r) => Number(r[3]) === 2).length === 2 && await page.isVisible('[data-panel=bom] >> text=Export CSV'), bom.map((r) => `${r[1]}×${r[3]}`).join(' ') + ` (${qty('Pin')})`);
  await shot(page, '13-bom');
  await page.click("[data-tool='Bill of materials']");
  await page.waitForSelector('[data-panel=bom]', { state: 'detached' });

  // ---------------------------------------------------------------- the right-click menu and its ring
  const onPlate = await at(page, [60, 40, 10]);
  await page.mouse.click(onPlate.x, onPlate.y, { button: 'right' });
  await page.waitForSelector('[data-view-menu]');
  const ring = await page.$$eval('[data-marking] [data-marking-item]', (els) => els.map((e) => e.getAttribute('data-marking-title')));
  const items = await page.$$eval('[data-view-menu] [data-menu-item]', (els) => els.map((e) => e.getAttribute('data-menu-item')));
  check('a right click on a part: the marking ring of eight tools, and under it what can be done with the part', ring.length === 8 && ring.includes('Insert') && ring.includes('Undo') && items.includes('Edit the part') && items.includes('Unfix') && items.includes('Hide'), `${ring.join(', ')} | ${items.join(', ')}`);
  await shot(page, '14-marking-menu');
  await page.click('[data-view-menu] [data-menu-item=Hide]');
  await page.waitForFunction(() => window.JunctionAssembly.getState().instances[0].hidden === true);
  await canvas(page);
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await page.waitForFunction(() => window.JunctionAssembly.getState().instances.every((i) => !i.hidden));
  check('Hide from the menu; H with nothing selected shows everything again', true);

  // ---------------------------------------------------------------- keys: the sheet, and a key changed
  await page.keyboard.press('?');
  await page.waitForSelector('[data-shortcuts]');
  await shot(page, '15-shortcuts');
  await page.click('[data-keymap-open]');
  await page.waitForSelector('[data-sheet=keymap]');
  await page.click('[data-key-row=fix] [data-key-set]');
  await page.keyboard.press('Shift+X');
  await page.waitForSelector('[data-key-row=fix][data-key-chord="Shift+X"]');
  await page.click('[data-key-row=insert] [data-key-set]');
  await page.keyboard.press('s');
  const refused = await page.textContent('[data-key-row=insert] [data-key-problem]');
  await page.keyboard.press('Escape');
  await page.click('[data-sheet-close]');
  await page.click('[data-instance=Disc]');
  await canvas(page);
  await page.keyboard.press('Shift+X');
  await page.waitForFunction(() => window.JunctionAssembly.getState().instances.find((i) => i.name === 'Disc').fixed === true);
  await page.hover('[data-tool=Fix]');
  await page.waitForSelector('.cad-tip');
  const fixTip = await page.textContent('.cad-tip');
  check('a key is changed in the sheet and works at once; the assembly\'s own keys cannot be given away', /Shift\+X/.test(fixTip) && /assembly's own key/.test(refused), refused);
  await page.keyboard.press('Shift+X');
  await page.waitForFunction(() => !window.JunctionAssembly.getState().instances.find((i) => i.name === 'Disc').fixed);
  await page.evaluate(() => localStorage.removeItem('junction.asm.keymap'));

  // ---------------------------------------------------------------- a double click on a part opens its part studio
  await page.mouse.move(700, 300);
  await settled(page, 10);
  const tabBefore = await page.$eval('#doctabs [role=tab][aria-selected=true]', (e) => e.textContent.trim());
  await page.mouse.dblclick(onPlate.x, onPlate.y);
  await page.waitForFunction(() => /Plate/.test(document.querySelector('#doctabs [role=tab][aria-selected=true]')?.textContent || ''), null, { timeout: 60000 });
  check('a double click on a part opens its part studio in its own tab', true, `${tabBefore} → Plate`);
  await page.click(`#doctabs [role=tab] >> text=${tabBefore}`);
  await page.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded && window.JunctionAssembly.getState().instances.length === 10, null, { timeout: 60000 });
  await settled(page, 10);
  const again = await asm(page, () => { const s = window.JunctionAssembly.getState(); return { mates: s.mates.length, relations: s.relations.length, rigids: s.rigids.length, patterns: s.patterns.length, explodes: s.explodes.length, ok: s.mates.every((m) => s.mateInfo[m.id].state === 'ok') && s.relations.every((r) => s.relationInfo[r.id].state === 'ok') }; });
  check('opened again, everything is as it was left: mates, the relation, the group, the pattern, the exploded view', again.mates === 7 && again.relations === 1 && again.rigids === 1 && again.patterns === 1 && again.explodes === 1 && again.ok, JSON.stringify(again));
  await look(page, [-0.6, 0.8, -0.6]);
  await shot(page, '16-final');

  check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error('the run stopped:', e);
  fail++;
  if (errors.length) console.error('page errors:', errors.slice(0, 8).join('\n'));
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) {
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/asm-stopped.png` }).catch(() => undefined);
    const state = await page.evaluate(() => { const a = window.JunctionAssembly; if (!a) return null; const s = a.getState(); return { instances: s.instances.map((i) => [i.name, s.instanceInfo[i.id]?.status, (a.transformOf(i.id) || []).filter((_, k) => k % 4 === 3).map((v) => Math.round(v * 100) / 100).join(' ')]), mates: s.mates.map((m) => [m.name, s.mateInfo[m.id]?.state, s.mateInfo[m.id]?.message]), mating: s.mating, dof: s.dof, building: s.building, unsettled: a.unsettled, unsaved: a.session.unsaved }; }).catch(() => null);
    if (state) console.error('assembly state:', JSON.stringify(state));
  }
} finally {
  await browser.close();
  try { sql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = 990021)"); } catch { /* left for the next run */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
