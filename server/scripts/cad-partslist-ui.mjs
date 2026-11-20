// Browser test of the parts list of a part studio (web/domains/mechanical/ui/PartsList.tsx), in the real app:
//
//   sections   Parts, Surfaces, Curves and Composite parts with their icons and counts; a heading folds its
//              section (remembered), and its eye hides and shows everything in it
//   selecting  a click selects the part in the model, Ctrl adds, Shift takes the range, Ctrl+A everything, the
//              arrows move; a click on a face in the model marks the row, the pointer over the model marks it
//              lightly, the pointer over a row lights the part up; the features that made the selection are
//              marked in the feature list; a dialog's field that listens takes a click on a row
//   hiding     the eye of a row, of a section; a hidden entry shows its outline while the pointer is on its row
//   the menu   Rename (also F2 and a double click), Properties, Assign material (and a new material), Edit
//              appearance, Move or copy, Export, Hide, Show, Hide others, Hide all, Show all, Isolate, Make
//              transparent, the centre of mass, Add comment, Zoom to selection, Delete; what applies to a
//              surface, a curve and several rows at once; a heading's own menu with "Show parts list properties"
//   document   names, properties, materials and colours are stored, undone and redone, seen by a second person
//              at once and kept over a reload; hiding and transparency are not
//   rights     a viewer sees the list and its menu, with what edits the document greyed
//
// Setup as the other cad-*-ui.mjs scripts (see cad-ui.mjs): a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-partslist-ui.mjs
//
// With SHOTS it saves plist-*.png there (light theme, two device pixels per pixel).
import fs from 'node:fs';
import { openPanel } from './cad-chrome.mjs';
import { setCad } from './cad-setting.mjs';
import { BASE, S, focusViewport, jwt, launch, newPartStudio, user } from './cad-ux-lib.mjs';
import { pickOption } from './kselect-pick.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const SIZE = { width: 1500, height: 940 };
const PANEL = '.cad-dock [data-panel=parts]';

const browser = await launch();
const errors = [];
async function signedIn(uid, login) {
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, colorScheme: 'light', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await setCad(BASE, jwt(uid, login));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}
const shot = async (page, name, clip) => {
  if (!SHOTS) return;
  await page.waitForTimeout(350);
  // software WebGL now and then fails a capture: once more, and a picture that cannot be taken fails no check
  for (let i = 0; i < 3; i++) { try { await page.screenshot({ path: `${SHOTS}/plist-${name}.png`, clip }); return; } catch (e) { await page.waitForTimeout(500); } }
  console.log(`(no picture of ${name})`);
};

// ---- what the scripts ask the page
const st = (page) => S(page, () => {
  const studio = window.JunctionPartStudio, s = studio.getState();
  const item = (id) => { const i = studio.doc.items.get(id); return i ? JSON.parse(JSON.stringify(i)) : null; };
  return {
    bodies: s.bodies.map((b) => ({ id: b.id, name: b.name, faces: b.mesh ? b.mesh.faces.names.length : (studio.view.bodyObjects(b.id)?.result.mesh?.faces.names.length || 0) })),
    features: s.features.map((f) => ({ id: f.id, name: f.name, type: f.featureType })),
    selection: s.selection.map((p) => (p.kind === 'datum' ? `curve:${p.featureId}` : p.body || p.kind)),
    editing: s.editing ? { type: s.editing.draft.featureType, params: JSON.parse(JSON.stringify(s.editing.draft.params)) } : null,
    parts: item('parts'), materials: item('materials'), appearance: item('appearance'),
    canUndo: s.canUndo, canEdit: s.canEdit,
  };
});
const built = (page, n, bodies) => page.waitForFunction(([n, bodies]) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]) && (bodies == null || s.bodies.length === bodies);
}, [n, bodies ?? null], { timeout: 120000, polling: 200 });
const rows = (page) => page.$$eval(`${PANEL} [data-entry]`, (els) => els.map((e) => ({ id: e.getAttribute('data-entry'), kind: e.getAttribute('data-kind'), name: e.querySelector('[data-row-name]')?.firstChild?.textContent || '', selected: e.getAttribute('aria-selected') === 'true', visible: e.getAttribute('data-visible') === 'true', hover: e.hasAttribute('data-hover'), icon: !!e.querySelector('svg.cad-glyph path, svg.cad-glyph rect') })));
const headings = (page) => page.$$eval(`${PANEL} [data-section]`, (els) => els.map((e) => ({ kind: e.getAttribute('data-section'), text: e.querySelector('[data-group]').textContent, count: Number(e.querySelector('[data-group]').getAttribute('data-count')), folded: e.hasAttribute('data-folded'), icon: !!e.querySelector('[data-section-toggle] svg.cad-glyph path'), rows: e.querySelectorAll('[data-entry]').length })));
const row = (id) => `${PANEL} [data-entry="${id}"]`;
const selectedRows = async (page) => (await rows(page)).filter((r) => r.selected).map((r) => r.id);
/** the menu of a row: of that row alone, or with `several` of every selected row when it is one of them */
const menu = async (page, id, o = {}) => {
  if (!o.several && !(await page.evaluate(() => !!window.JunctionPartStudio.getState().editing))) await S(page, () => window.JunctionPartStudio.select([]));
  await page.click(row(id), { button: 'right' });
  await page.waitForSelector('.cad-parts-menu');
};
const menuItems = (page) => page.$$eval('.cad-parts-menu [data-command]', (els) => els.map((e) => ({ id: e.getAttribute('data-command'), label: e.getAttribute('data-menu-item'), off: e.getAttribute('aria-disabled') === 'true', why: e.getAttribute('title') || '' })));
const choose = (page, command) => page.click(`.cad-parts-menu [data-command="${command}"]`);
const visibleInModel = (page, body) => S(page, (body) => { const o = window.JunctionPartStudio.view.bodyObjects(body); return !!o && o.group.visible; }, body);
const overlayLines = (page) => S(page, () => window.JunctionPartStudio.view.overlay.children.length);
const undo = async (page) => { await focusViewport(page); await page.keyboard.press('Control+z'); await page.waitForTimeout(250); };
const redo = async (page) => { await focusViewport(page); await page.keyboard.press('Control+y'); await page.waitForTimeout(250); };
const dialogOk = (page) => page.click('.kd-dialog .kd-foot button.primary');
/** a point of the model on screen where the viewport picks a face of this body */
const faceOf = (page, body) => S(page, (body) => {
  const studio = window.JunctionPartStudio, m = studio.view.bodyObjects(body).result.mesh, c = studio.viewport.canvas.getBoundingClientRect();
  for (let i = 0; i < m.faces.names.length; i++) {
    for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
      const v = [0, 1, 2].map((k) => { const j = m.indices[t + k] * 3; return [m.positions[j], m.positions[j + 1], m.positions[j + 2]]; });
      const mid = [0, 1, 2].map((k) => (v[0][k] + v[1][k] + v[2][k]) / 3);
      const q = studio.viewport.project(studio.viewport.target.clone().set(mid[0], mid[1], mid[2]));
      const at = { x: c.left + q.x, y: c.top + q.y };
      if (document.elementFromPoint(at.x, at.y) !== studio.viewport.canvas) continue;
      const hit = studio.view.pick({ clientX: at.x, clientY: at.y });
      if (hit && hit.kind === 'face' && hit.body === body) return at;
    }
  }
  return null;
}, body);

// ---- the model: three boxes, a surface and a helix, written as features (the format of mechanical/CONTRACT.md)
const rect = (x0, y0, x1, y1) => ({
  p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
  la: { type: 'line', a: 'p1', b: 'p2' }, lb: { type: 'line', a: 'p2', b: 'p3' }, lc: { type: 'line', a: 'p3', b: 'p4' }, ld: { type: 'line', a: 'p4', b: 'p1' },
});
const addFeatures = (page, list) => S(page, (list) => {
  const studio = window.JunctionPartStudio;
  studio.commit(list.map((f) => ({ id: f.id, kind: 'ADDED', typeName: 'feature', item: { ...f, type: 'feature' } })));
}, list);
const uuid = () => crypto.randomUUID();
const F = { sk1: uuid(), ex1: uuid(), sk2: uuid(), ex2: uuid(), sk3: uuid(), ex3: uuid(), sk4: uuid(), su1: uuid(), hx1: uuid(), cp1: uuid() };
const sketch = (id, order, name, entities) => ({ id, featureType: 'sketch', name, order, params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, order, name, sk, depth, extra = {}) => ({ id, featureType: 'extrude', name, order, params: { bodyType: 'solid', profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [], ...extra } });

const aliceId = user('cad-plist-alice', 991401), bobId = user('cad-plist-bob', 991402), carolId = user('cad-plist-carol', 991403);
const alice = await signedIn(aliceId, 'cad-plist-alice');

try {
  const pid = await newPartStudio(alice, 'CAD parts list test');
  for (const [login, role] of [['cad-plist-bob', 'editor'], ['cad-plist-carol', 'viewer']]) {
    await alice.evaluate(async ({ pid, login, role }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, role }) })).status, { pid, login, role });
  }
  const url = alice.url();
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 120000 });
  await openPanel(alice, 'parts');
  check('an empty part studio says what the list will hold', (await alice.textContent(`${PANEL} [data-empty]`)).includes('No parts yet'));

  await addFeatures(alice, [
    sketch(F.sk1, 'C', 'Sketch 1', rect(0, 0, 40, 30)), extrude(F.ex1, 'D', 'Extrude 1', F.sk1, 20),
    sketch(F.sk2, 'E', 'Sketch 2', rect(60, 0, 90, 30)), extrude(F.ex2, 'F', 'Extrude 2', F.sk2, 10),
    sketch(F.sk3, 'G', 'Sketch 3', rect(110, 0, 130, 30)), extrude(F.ex3, 'H', 'Extrude 3', F.sk3, 30),
    sketch(F.sk4, 'I', 'Sketch 4', rect(0, 50, 40, 80)), extrude(F.su1, 'J', 'Extrude 4', F.sk4, 15, { bodyType: 'surface' }),
    { id: F.hx1, featureType: 'helix', name: 'Helix 1', order: 'K', params: { axis: { kind: 'plane', plane: 'top' }, radius: 8, pitch: 5, turns: 4, start: 0, left: false } },
  ]);
  await built(alice, 9, 4);
  await S(alice, () => window.JunctionPartStudio.fit());
  await alice.waitForTimeout(500);
  const CURVE = `curve:${F.hx1}`;

  // ================================================================ sections, icons, counts
  let heads = await headings(alice);
  check('the list has Parts, Surfaces and Curves, in that order, with their counts', heads.map((h) => h.text).join(' | ') === 'Parts (3) | Surfaces (1) | Curves (1)', heads.map((h) => h.text).join(' | '));
  check('every section and every row carries its type icon', heads.every((h) => h.icon) && (await rows(alice)).every((r) => r.icon));
  let list = await rows(alice);
  check('the rows are the bodies and the curve, by kind', list.map((r) => r.kind).join() === 'part,part,part,surface,curve' && list.map((r) => r.id).join() === [F.ex1, F.ex2, F.ex3, F.su1, CURVE].join(), list.map((r) => `${r.kind}:${r.name}`).join());
  check('… named as the kernel names them, the curve after its feature', list.map((r) => r.name).join() === 'Part 1,Part 2,Part 3,Surface 1,Helix 1', list.map((r) => r.name).join());
  check('the panel counts the parts', (await alice.getAttribute(`${PANEL} [data-panel-count]`, 'data-panel-count')) === '3');
  const icons = await alice.$$eval(`${PANEL} [data-section-toggle] svg.cad-glyph`, (els) => els.filter((e) => e.querySelector('path, rect, circle') && !e.innerHTML.includes('M9 6l6 6-6 6')).map((e) => e.innerHTML));
  check('each kind has an icon of its own', new Set(icons).size === 3, String(new Set(icons).size));
  await shot(alice, 'sections');

  // folding
  await alice.click(`${PANEL} [data-section-toggle=part]`);
  heads = await headings(alice);
  check('a heading folds its section', heads[0].folded && heads[0].rows === 0 && heads[1].rows === 1);
  check('… which is remembered in this browser', (await S(alice, () => JSON.parse(localStorage.getItem('junction.cad.partslist')).folded.part)) === true);
  await alice.click(`${PANEL} [data-section-toggle=part]`);
  check('… and unfolds it again', (await headings(alice))[0].rows === 3);

  // ================================================================ selecting
  await alice.click(row(F.ex1));
  let s = await st(alice);
  check('a click selects the part in the model: every face of it', s.selection.length === 6 && s.selection.every((b) => b === F.ex1) && (await selectedRows(alice)).join() === F.ex1, s.selection.length + ' picks');
  const cross = await alice.$$eval('.cad-features [data-feature-row]', (els) => els.filter((e) => e.querySelector('[data-part-cross]')).map((e) => e.getAttribute('data-feature-row')));
  check('the features that made it are marked in the feature list: its sketch and its extrusion', cross.slice().sort().join() === [F.sk1, F.ex1].sort().join(), cross.length + ' marked');
  await shot(alice, 'selected');
  await alice.click(row(F.ex3), { modifiers: ['Control'] });
  check('Ctrl adds a row', (await selectedRows(alice)).join() === [F.ex1, F.ex3].join());
  await alice.click(row(F.ex1), { modifiers: ['Control'] });
  check('… and takes one away', (await selectedRows(alice)).join() === F.ex3);
  await alice.click(row(F.ex1));
  await alice.click(row(F.su1), { modifiers: ['Shift'] });
  check('Shift takes the range, across sections', (await selectedRows(alice)).join() === [F.ex1, F.ex2, F.ex3, F.su1].join(), (await selectedRows(alice)).length + ' rows');
  await alice.click(row(CURVE));
  s = await st(alice);
  check('a click on a curve selects the curve', s.selection.join() === CURVE && (await selectedRows(alice)).join() === CURVE, s.selection.join());
  check('… and marks the feature that made it', (await alice.locator(`.cad-features [data-feature-row="${F.hx1}"] [data-part-cross]`).count()) === 1);
  await alice.click(row(CURVE));
  check('a click on the one selected row takes the selection away', (await st(alice)).selection.length === 0);
  // the keyboard
  await alice.click(row(F.ex1));
  await alice.keyboard.press('ArrowDown');
  check('↓ moves to the next row', (await selectedRows(alice)).join() === F.ex2 && (await alice.evaluate(() => document.activeElement?.getAttribute('data-entry'))) === F.ex2);
  await alice.keyboard.press('Shift+ArrowDown');
  check('Shift+↓ extends the selection', (await selectedRows(alice)).join() === [F.ex2, F.ex3].join());
  await alice.keyboard.press('Control+a');
  check('Ctrl+A selects every row', (await selectedRows(alice)).length === 5);
  await alice.keyboard.press('Escape');
  await alice.waitForTimeout(100);

  // the model marks the rows
  await S(alice, () => window.JunctionPartStudio.select([]));
  const at2 = await faceOf(alice, F.ex2);
  await alice.mouse.move(at2.x, at2.y, { steps: 3 });
  await alice.waitForTimeout(120);
  check('the pointer over a part in the model marks its row', (await rows(alice)).filter((r) => r.hover).map((r) => r.id).join() === F.ex2);
  await alice.mouse.down(); await alice.mouse.up();
  await alice.waitForTimeout(100);
  check('a face clicked in the model marks the row of its part as selected', (await selectedRows(alice)).join() === F.ex2);
  check('… and the feature that made the face in the feature list', (await alice.locator(`.cad-features [data-feature-row="${F.ex2}"] [data-part-cross]`).count()) === 1 && (await alice.locator(`.cad-features [data-feature-row="${F.ex1}"] [data-part-cross]`).count()) === 0);
  await S(alice, () => window.JunctionPartStudio.select([]));
  await alice.hover(row(F.ex3));
  check('the pointer over a row lights the part up in the model', (await S(alice, () => window.JunctionPartStudio.view.featureHover.map((p) => p.body))).every((b) => b === F.ex3) && (await S(alice, () => window.JunctionPartStudio.view.featureHover.length)) === 6);
  await alice.mouse.move(700, 500);

  // ================================================================ hiding and showing
  await alice.hover(row(F.ex2));
  await alice.click(`${row(F.ex2)} [data-eye]`);
  check('the eye of a row hides the part', (await rows(alice)).find((r) => r.id === F.ex2).visible === false && !(await visibleInModel(alice, F.ex2)));
  await alice.mouse.move(700, 500);
  check('nothing is drawn of it', (await overlayLines(alice)) === 0);
  await alice.hover(row(F.ex2));
  await alice.waitForTimeout(80);
  check('with the pointer on its row, a hidden part shows its outline', (await overlayLines(alice)) > 0);
  await shot(alice, 'hidden-outline');
  await alice.mouse.move(700, 500);
  await alice.waitForTimeout(80);
  check('… which goes when the pointer leaves', (await overlayLines(alice)) === 0);
  check('"Show all parts" is offered while something is hidden', (await alice.locator(`${PANEL} [data-show-all]`).count()) === 1);
  await alice.click(`${row(F.ex2)} [data-eye]`);
  check('the eye shows it again', (await visibleInModel(alice, F.ex2)) && (await alice.locator(`${PANEL} [data-show-all]`).count()) === 0);
  await alice.hover(`${PANEL} [data-section=part] [data-section-toggle]`);
  await alice.click(`${PANEL} [data-section=part] > div [data-eye]`);
  check('the eye of a heading hides every part', (await rows(alice)).filter((r) => r.kind === 'part').every((r) => !r.visible) && (await rows(alice)).find((r) => r.kind === 'surface').visible);
  await alice.click(`${PANEL} [data-section=part] > div [data-eye]`);
  check('… and shows them all again', (await rows(alice)).every((r) => r.visible));
  await alice.hover(row(CURVE));
  await alice.click(`${row(CURVE)} [data-eye]`);
  check('a curve hides too (it is reference geometry: the same switch as its eye in the feature list)', (await S(alice, (id) => window.JunctionPartStudio.isVisible(id), F.hx1)) === false && (await rows(alice)).find((r) => r.id === CURVE).visible === false);
  await alice.click(`${row(CURVE)} [data-eye]`);

  // ================================================================ the menu
  await menu(alice, F.ex1);
  let items = await menuItems(alice);
  const WANT = ['Rename', 'Properties…', 'Assign material…', 'Edit appearance…', 'Move or copy…', 'Export…', 'Hide', 'Hide other items', 'Hide all', 'Isolate', 'Make transparent', 'Show centre of mass', 'Add comment…', 'Zoom to selection', 'Delete part…'];
  check('the menu of a part', items.map((i) => i.label).join(' | ') === WANT.join(' | '), items.map((i) => i.label).join(' | '));
  check('a right click selects the row it is on', (await selectedRows(alice)).join() === F.ex1);
  check('the centre of mass waits for a material, and says so', items.find((i) => i.id === 'centre-show').off && items.find((i) => i.id === 'centre-show').why.includes('material'));
  await shot(alice, 'menu');
  await alice.keyboard.press('Escape');
  check('Esc closes the menu', (await alice.locator('.cad-parts-menu').count()) === 0);
  await menu(alice, F.su1);
  items = await menuItems(alice);
  check('a surface has no material and no centre of mass', !items.some((i) => i.id === 'material' || i.id === 'centre-show') && items.some((i) => i.label === 'Delete surface…'), items.map((i) => i.label).join(' | '));
  await alice.keyboard.press('Escape');
  await menu(alice, CURVE);
  items = await menuItems(alice);
  check('a curve is renamed, described, hidden, commented on and looked at', items.map((i) => i.id).join() === 'rename,properties,hide,hide-others,hide-all,comment,zoom', items.map((i) => i.id).join());
  await alice.keyboard.press('Escape');
  await alice.click(row(F.ex1));
  await alice.click(row(F.ex2), { modifiers: ['Control'] });
  await menu(alice, F.ex2, { several: true });
  items = await menuItems(alice);
  check('with several rows selected the menu is for all of them', (await alice.textContent('.cad-parts-menu [data-menu-head]')) === '2 selected' && !items.some((i) => i.id === 'rename' || i.id === 'properties') && items.some((i) => i.label === 'Delete 2 items…'), items.map((i) => i.label).join(' | '));
  await shot(alice, 'menu-several');
  await alice.keyboard.press('Escape');

  // ---------------------------------------------------------------- rename
  await menu(alice, F.ex1);
  await choose(alice, 'rename');
  await alice.waitForSelector(`${row(F.ex1)} [data-rename]`);
  await alice.keyboard.type('Bracket');
  await alice.keyboard.press('Enter');
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Bracket', F.ex1, { timeout: 15000 });
  s = await st(alice);
  check('Rename names the part in the document', s.parts && s.parts.names[F.ex1] === 'Bracket' && (await rows(alice))[0].name === 'Bracket', JSON.stringify(s.parts));
  check('… and everything that shows the part by name follows', s.bodies.find((b) => b.id === F.ex1).name === 'Bracket');
  await undo(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Part 1', F.ex1, { timeout: 15000 });
  check('undo takes the name back', (await rows(alice))[0].name === 'Part 1');
  await redo(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Bracket', F.ex1, { timeout: 15000 });
  check('… and redo gives it again', (await rows(alice))[0].name === 'Bracket');
  await alice.click(row(F.ex2));
  await alice.keyboard.press('F2');
  await alice.waitForSelector(`${row(F.ex2)} [data-rename]`);
  await alice.keyboard.type('Lid');
  await alice.keyboard.press('Enter');
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Lid', F.ex2, { timeout: 15000 });
  check('F2 renames the row that has the keyboard', (await rows(alice))[1].name === 'Lid');
  await alice.dblclick(`${row(F.ex3)} [data-row-name]`);
  await alice.waitForSelector(`${row(F.ex3)} [data-rename]`);
  await alice.keyboard.type('Nothing');
  await alice.keyboard.press('Escape');
  await alice.waitForTimeout(150);
  check('a double click renames too, and Esc leaves the name alone', (await rows(alice))[2].name === 'Part 3' && !(await st(alice)).parts.names[F.ex3]);
  await alice.dblclick(`${row(CURVE)} [data-row-name]`);
  await alice.waitForSelector(`${row(CURVE)} [data-rename]`);
  await alice.keyboard.type('Spring path');
  await alice.keyboard.press('Enter');
  await alice.waitForTimeout(200);
  check('a curve takes a name of its own; its feature keeps its', (await rows(alice))[4].name === 'Spring path' && (await st(alice)).features.find((f) => f.id === F.hx1).name === 'Helix 1');

  // ---------------------------------------------------------------- a second person
  const bob = await signedIn(bobId, 'cad-plist-bob');
  await bob.goto(url);
  await bob.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().bodies.length === 4, null, { timeout: 120000 });
  await openPanel(bob, 'parts');
  check('a second person sees the names', (await rows(bob)).map((r) => r.name).join() === 'Bracket,Lid,Part 3,Surface 1,Spring path', (await rows(bob)).map((r) => r.name).join());
  await bob.waitForFunction(() => window.JunctionPartStudio.getState().canEdit, null, { timeout: 15000 });
  // both rename a different part at the same moment
  await Promise.all([
    S(alice, (id) => { const st = window.JunctionPartStudio; const it = JSON.parse(JSON.stringify(st.doc.items.get('parts'))); st.commit([{ id: 'parts', kind: 'MODIFIED', typeName: 'parts', props: [{ path: ['names', id], value: 'Cover' }] }]); return it; }, F.ex2),
    S(bob, (id) => { const st = window.JunctionPartStudio; st.commit([{ id: 'parts', kind: 'MODIFIED', typeName: 'parts', props: [{ path: ['names', id], value: 'Post' }] }]); }, F.ex3),
  ]);
  await alice.waitForFunction(([a, b]) => { const n = window.JunctionPartStudio.doc.items.get('parts').names; return n[a] === 'Cover' && n[b] === 'Post'; }, [F.ex2, F.ex3], { timeout: 15000 });
  await bob.waitForFunction(([a, b]) => { const n = window.JunctionPartStudio.doc.items.get('parts').names; return n[a] === 'Cover' && n[b] === 'Post'; }, [F.ex2, F.ex3], { timeout: 15000 });
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().bodies.map((b) => b.name).join() === 'Bracket,Cover,Post,Surface 1', null, { timeout: 15000 });
  check('two people naming two parts at once both win, and both see both', (await rows(alice)).map((r) => r.name).slice(0, 3).join() === 'Bracket,Cover,Post' && (await rows(bob)).map((r) => r.name).slice(0, 3).join() === 'Bracket,Cover,Post');

  // ---------------------------------------------------------------- properties
  await menu(alice, F.ex1);
  await choose(alice, 'properties');
  await alice.waitForSelector('[data-part-properties]');
  await alice.waitForSelector('[data-part-properties] [data-prop=volume]', { timeout: 30000 });
  const info = await alice.$$eval('[data-part-properties] [data-prop]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-prop'), e.value ?? e.textContent])));
  check('Properties shows the name, the type, what made it and its volume', info.name === 'Bracket' && info.type === 'Part' && info['made-by'] === 'Extrude 1' && /24[ ,.]?000/.test(info.volume.replace(/\s/g, '')) && info.material === 'None', JSON.stringify(info));
  await alice.fill('[data-part-properties] [data-prop=description]', 'Holds the motor');
  await alice.click('[data-part-properties] [data-prop-add]');
  await alice.fill('[data-part-properties] [data-prop-field] input[aria-label=Property]', 'Vendor');
  await alice.fill('[data-part-properties] [data-prop-field] input[placeholder=Value]', 'Acme');
  await alice.fill('[data-part-properties] [data-prop=name]', 'Motor bracket');
  await shot(alice, 'properties');
  await dialogOk(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Motor bracket', F.ex1, { timeout: 15000 });
  s = await st(alice);
  check('its description, a field of one\'s own and a new name are stored', s.parts.props[F.ex1].description === 'Holds the motor' && s.parts.props[F.ex1].fields.Vendor === 'Acme' && s.parts.names[F.ex1] === 'Motor bracket', JSON.stringify(s.parts.props));
  await undo(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Bracket', F.ex1, { timeout: 15000 });
  s = await st(alice);
  check('… as one step: one undo takes all three back', !s.parts.props[F.ex1] && s.parts.names[F.ex1] === 'Bracket', JSON.stringify(s.parts));
  await redo(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().bodies.find((b) => b.id === id)?.name === 'Motor bracket', F.ex1, { timeout: 15000 });
  await bob.waitForFunction((id) => window.JunctionPartStudio.doc.items.get('parts').props?.[id]?.description === 'Holds the motor', F.ex1, { timeout: 15000 });
  check('the second person has them too', true);

  // ---------------------------------------------------------------- material
  await menu(alice, F.ex1);
  await choose(alice, 'material');
  await alice.waitForSelector('[data-part-material]');
  await pickOption(alice, '[data-part-material] [data-param=material]', 'aluminium');
  check('Assign material lists the library and shows the density', (await alice.textContent('[data-part-material] [data-material-density]')).includes('2.7'));
  await shot(alice, 'material');
  await dialogOk(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.doc.items.get('materials')?.assign?.[id] === 'aluminium', F.ex1, { timeout: 15000 });
  check('the part is of that material, in the document', (await st(alice)).materials.assign[F.ex1] === 'aluminium');
  await alice.click(row(F.ex2));
  await alice.click(row(F.ex3), { modifiers: ['Control'] });
  await menu(alice, F.ex3, { several: true });
  await choose(alice, 'material');
  await alice.waitForSelector('[data-part-material]');
  await pickOption(alice, '[data-part-material] [data-param=material]', '+new');
  check('a new material needs a name and a density before it can be assigned', await alice.$eval('.kd-dialog .kd-foot button.primary', (b) => b.disabled));
  await alice.fill('[data-part-material] [data-param=material-name]', 'PETG');
  await alice.fill('[data-part-material] [data-param=material-density]', '1.27');
  await dialogOk(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.doc.items.get('materials')?.assign?.[id] === 'petg', F.ex3, { timeout: 15000 });
  s = await st(alice);
  check('a new material joins the document\'s library and is given to both selected parts', s.materials.library.petg.density === 1.27 && s.materials.assign[F.ex2] === 'petg' && s.materials.assign[F.ex3] === 'petg', JSON.stringify(s.materials.library.petg));
  await undo(alice);
  s = await st(alice);
  check('… as one step', !s.materials.library.petg && !s.materials.assign[F.ex2] && s.materials.assign[F.ex1] === 'aluminium', JSON.stringify(s.materials.assign));
  await redo(alice);

  // the properties beside the names
  await alice.click(`${PANEL} [data-section=part] [data-section-toggle]`, { button: 'right' });
  await alice.waitForSelector('.cad-parts-menu');
  items = await menuItems(alice);
  check('a heading\'s menu hides, shows and selects its section and shows the properties', ['Hide all parts', 'Select all parts', 'Show parts list properties', 'Fold parts'].every((l) => items.some((i) => i.label === l)), items.map((i) => i.label).join(' | '));
  await choose(alice, 'props');
  const about = await alice.$$eval(`${PANEL} [data-entry] [data-row-props]`, (els) => els.map((e) => e.textContent));
  check('"Show parts list properties" writes each part\'s material and description beside its name', about[0] === 'Aluminium 6061 · Holds the motor' && about[1] === 'PETG', about.join(' | '));
  await shot(alice, 'properties-shown');
  await alice.click(`${PANEL} [data-section=part] [data-section-toggle]`, { button: 'right' });
  check('… and offers to hide them again', (await menuItems(alice)).some((i) => i.label === 'Hide parts list properties'));
  await choose(alice, 'section-select');
  check('"Select all parts" selects the section', (await selectedRows(alice)).join() === [F.ex1, F.ex2, F.ex3].join());

  // ---------------------------------------------------------------- appearance
  await alice.click(row(F.ex1));
  await menu(alice, F.ex1);
  await choose(alice, 'appearance');
  await alice.waitForSelector('[data-part-appearance]');
  await alice.$eval('[data-part-appearance] [data-param=color]', (el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '#3d7bd9'); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
  await dialogOk(alice);
  await alice.waitForFunction((id) => window.JunctionPartStudio.doc.items.get('appearance')?.bodies?.[id]?.color === '#3d7bd9', F.ex1, { timeout: 15000 });
  check('Edit appearance colours the part, in the document', true);
  await bob.waitForFunction((id) => window.JunctionPartStudio.doc.items.get('appearance')?.bodies?.[id]?.color === '#3d7bd9', F.ex1, { timeout: 15000 });
  check('… for everyone', true);

  // ---------------------------------------------------------------- hide, isolate, transparent
  await menu(alice, F.ex1);
  await choose(alice, 'hide-others');
  list = await rows(alice);
  check('Hide other items leaves only this one', list.filter((r) => r.visible).map((r) => r.id).join() === F.ex1);
  await menu(alice, F.ex1);
  items = await menuItems(alice);
  check('… and the menu now offers Show all', items.some((i) => i.id === 'show-all'));
  await choose(alice, 'hide-all');
  check('Hide all hides everything, the selected part too', (await rows(alice)).every((r) => !r.visible));
  await menu(alice, F.ex1);
  check('a hidden part is offered Show', (await menuItems(alice)).some((i) => i.id === 'show') && !(await menuItems(alice)).some((i) => i.id === 'hide'));
  await choose(alice, 'show-all');
  check('Show all brings everything back', (await rows(alice)).every((r) => r.visible));
  await menu(alice, F.ex1);
  await choose(alice, 'isolate');
  check('Isolate shows the part alone', (await visibleInModel(alice, F.ex1)) && !(await visibleInModel(alice, F.ex2)) && !(await visibleInModel(alice, F.su1)));
  await menu(alice, F.ex1);
  check('… and the menu offers the way out', (await menuItems(alice)).some((i) => i.label === 'Exit isolate'));
  await choose(alice, 'unisolate');
  check('Exit isolate shows the others again', await visibleInModel(alice, F.ex2));
  await menu(alice, F.ex1);
  await choose(alice, 'transparent');
  const through = await S(alice, (id) => { const st = window.JunctionPartStudio, m = st.view.bodyObjects(id).mesh.material; return { opacity: (Array.isArray(m) ? m[0] : m).opacity, stored: st.doc.items.get('appearance').bodies[id].opacity ?? null }; }, F.ex1);
  check('Make transparent draws the part see-through, in this view only', through.opacity < 0.5 && through.stored === null && (await alice.locator(`${row(F.ex1)} [data-through]`).count()) === 1, JSON.stringify(through));
  check('… not for the second person', (await S(bob, (id) => { const m = window.JunctionPartStudio.view.bodyObjects(id).mesh.material; return (Array.isArray(m) ? m[0] : m).opacity; }, F.ex1)) === 1);
  await S(alice, () => window.JunctionPartStudio.select([]));
  await shot(alice, 'transparent');
  await menu(alice, F.ex1);
  check('… and can be made opaque again', (await menuItems(alice)).some((i) => i.label === 'Make opaque'));
  await choose(alice, 'opaque');
  check('Make opaque draws it solid', (await S(alice, (id) => { const m = window.JunctionPartStudio.view.bodyObjects(id).mesh.material; return (Array.isArray(m) ? m[0] : m).opacity; }, F.ex1)) === 1);

  // ---------------------------------------------------------------- the centre of mass, zoom
  await menu(alice, F.ex1);
  items = await menuItems(alice);
  check('with a material the centre of mass can be shown', items.find((i) => i.id === 'centre-show') && !items.find((i) => i.id === 'centre-show').off);
  await choose(alice, 'centre-show');
  await alice.waitForTimeout(600);
  await menu(alice, F.ex1);
  check('Show centre of mass marks it, and the menu then hides it', (await menuItems(alice)).some((i) => i.label === 'Hide centre of mass'));
  await choose(alice, 'centre-hide');
  await S(alice, () => window.JunctionPartStudio.fit());
  await alice.waitForTimeout(500);
  const zoom0 = await S(alice, () => window.JunctionPartStudio.viewport.camera.zoom);
  await menu(alice, F.ex2);
  await choose(alice, 'zoom');
  await alice.waitForTimeout(700);
  const zoom1 = await S(alice, () => window.JunctionPartStudio.viewport.camera.zoom);
  check('Zoom to selection fills the view with the part', zoom1 > zoom0 * 1.5, `${zoom0.toFixed(2)} → ${zoom1.toFixed(2)}`);
  await S(alice, () => window.JunctionPartStudio.fit());
  await alice.waitForTimeout(500);

  // ---------------------------------------------------------------- export, move or copy, comment
  await menu(alice, F.ex2);
  await choose(alice, 'export');
  await alice.waitForSelector('[data-export-dialog]');
  const exp = await alice.$$eval('[data-export-dialog] [data-param=bodies] [data-body]', (els) => els.filter((e) => e.querySelector('input').checked).map((e) => e.getAttribute('data-body')));
  check('Export opens the export dialog with this part chosen, under its name', exp.join() === F.ex2 && (await alice.inputValue('[data-export-dialog] [data-param=name]')).endsWith('Cover'), exp.length + ' checked');
  await alice.click('.kd-dialog .kd-foot button:not(.primary)');
  await alice.waitForSelector('[data-export-dialog]', { state: 'detached' });
  await menu(alice, F.ex2);
  await choose(alice, 'transform');
  await alice.waitForSelector('.cad-dialog[data-feature=transform]');
  s = await st(alice);
  check('Move or copy opens Transform on the part', s.editing.type === 'transform' && s.editing.params.bodies.join() === F.ex2);
  // a field that listens takes a click on a row
  await alice.click(row(F.ex3));
  s = await st(alice);
  check('a dialog\'s field that listens takes a click on a row of the list', s.editing.params.bodies.join() === [F.ex2, F.ex3].join(), JSON.stringify(s.editing.params.bodies));
  await menu(alice, F.ex1);
  items = await menuItems(alice);
  check('with a dialog open, what starts another feature says why it cannot', items.find((i) => i.id === 'delete').off && items.find((i) => i.id === 'delete').why.includes('Finish'));
  await alice.keyboard.press('Escape');
  await alice.click('.cad-dialog [data-cancel]');
  await openPanel(alice, 'comments');
  await menu(alice, F.ex1);
  items = await menuItems(alice);
  check('a comment can be started on a part', !items.find((i) => i.id === 'comment').off, items.find((i) => i.id === 'comment').why);
  await choose(alice, 'comment');
  await alice.waitForFunction(() => !!window.JunctionCadCollab.comments.getState().composing, null, { timeout: 10000 });
  const composing = await S(alice, () => { const c = window.JunctionCadCollab.comments.getState().composing; return { label: c.label, kind: c.target.kind, body: c.target.body, point: c.point }; });
  check('Add comment opens the composer pinned to the part, under its name', composing.label === 'Motor bracket' && composing.kind === 'face' && composing.body === F.ex1 && Array.isArray(composing.point), JSON.stringify(composing));
  await S(alice, () => window.JunctionCadCollab.comments.compose(null));

  // ---------------------------------------------------------------- delete
  await menu(alice, F.ex3);
  await choose(alice, 'delete');
  await alice.waitForSelector('.cad-dialog[data-feature=delete-body]');
  check('Delete opens Delete part on the part', (await st(alice)).editing.params.bodies.join() === F.ex3);
  await alice.click('.cad-dialog [data-accept]');
  await built(alice, 10, 3);
  heads = await headings(alice);
  check('accepted, the part is gone from the model and the list, as a feature of its own', heads[0].text === 'Parts (2)' && !(await rows(alice)).some((r) => r.id === F.ex3) && (await st(alice)).features[9].type === 'delete-body');
  await undo(alice);
  await built(alice, 9, 4);
  check('undo brings it back, with its name and material', (await rows(alice))[2].name === 'Post' && (await st(alice)).materials.assign[F.ex3] === 'petg');
  await alice.click(row(F.ex3));
  await alice.keyboard.press('Delete');
  await alice.waitForSelector('.cad-dialog[data-feature=delete-body]');
  check('Del on a row starts the same', (await st(alice)).editing.params.bodies.join() === F.ex3);
  await alice.click('.cad-dialog [data-cancel]');

  // ================================================================ a composite part
  await addFeatures(alice, [{ id: F.cp1, featureType: 'composite-part', name: 'Bearing', order: 'L', params: { bodies: [F.ex2, F.ex3], closed: true } }]);
  await built(alice, 10, 3);
  heads = await headings(alice);
  check('a composite part has a section of its own, and takes its parts out of Parts', heads.map((h) => h.text).join(' | ') === 'Parts (1) | Surfaces (1) | Curves (1) | Composite parts (1)', heads.map((h) => h.text).join(' | '));
  const comp = (await rows(alice)).find((r) => r.kind === 'composite');
  check('… named after its feature', comp && comp.name === 'Bearing', comp && comp.name);
  await menu(alice, comp.id);
  items = await menuItems(alice);
  check('… with a material, an appearance and a delete of its own', ['material', 'appearance', 'delete'].every((id) => items.some((i) => i.id === id)) && items.some((i) => i.label === 'Delete composite part…'), items.map((i) => i.label).join(' | '));
  await alice.keyboard.press('Escape');
  await S(alice, () => window.JunctionPartStudio.select([]));
  await alice.mouse.move(700, 500);
  await shot(alice, 'composite');
  await shot(alice, 'list', await alice.$eval('.cad-dock[data-side=left]', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }));

  // ================================================================ a reload
  await alice.reload();
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().bodies.length === 3, null, { timeout: 120000 });
  await openPanel(alice, 'parts');
  list = await rows(alice);
  check('after a reload the names, the properties and the choice to show them are there', list[0].name === 'Motor bracket' && list.find((r) => r.kind === 'curve').name === 'Spring path' && (await alice.$$eval(`${PANEL} [data-entry] [data-row-props]`, (els) => els.map((e) => e.textContent)))[0] === 'Aluminium 6061 · Holds the motor', list.map((r) => r.name).join());
  check('… and nothing is hidden or see-through: those were ways of looking', list.every((r) => r.visible) && (await alice.locator(`${PANEL} [data-through]`).count()) === 0);

  // ================================================================ a viewer
  const carol = await signedIn(carolId, 'cad-plist-carol');
  await carol.goto(url);
  await carol.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().bodies.length === 3, null, { timeout: 120000 });
  await openPanel(carol, 'parts');
  check('a viewer sees the list', (await rows(carol)).length === 4 && (await st(carol)).canEdit === false);
  await menu(carol, F.ex1);
  items = await menuItems(carol);
  check('… and its menu, with what would change the document greyed', ['rename', 'material', 'appearance', 'transform', 'delete'].every((id) => items.find((i) => i.id === id)?.off) && ['properties', 'export', 'hide', 'isolate', 'transparent', 'zoom'].every((id) => !items.find((i) => i.id === id)?.off), items.filter((i) => i.off).map((i) => i.id).join());
  await carol.click('.cad-parts-menu [data-command=rename]', { force: true });
  check('a greyed item does nothing', (await carol.locator(`${row(F.ex1)} [data-rename]`).count()) === 0);
  await carol.keyboard.press('Escape');
  await carol.dblclick(`${row(F.ex1)} [data-row-name]`);
  check('… nor does a double click rename', (await carol.locator(`${row(F.ex1)} [data-rename]`).count()) === 0);
  await carol.click(`${row(F.ex1)}`);
  await menu(carol, F.ex1);
  await choose(carol, 'hide');
  check('hiding is the viewer\'s own to do', (await rows(carol))[0].visible === false && (await rows(alice))[0].visible === true);

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the script ran to its end', false, e.stack || String(e));
  if (SHOTS) await alice.screenshot({ path: `${SHOTS}/plist-failure.png` }).catch(() => {});
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
