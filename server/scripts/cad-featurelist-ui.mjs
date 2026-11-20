// Browser test of the part studio's feature list, against what Onshape's "Features and Parts Lists" page says of
// the feature half (the parts list under the separator has a script of its own):
//
//   top        the number of features, the search box with its filter menu and every command (:part :type :name
//              :errors :warnings :folder :variable :suppressed :hidden :shown), the error count that filters
//   rollback   the bar is dragged, moved with ↑ ↓ Home End once it is selected, "Roll to here" on a feature,
//              "Roll to end" on the bar; someone who cannot edit gets a bar of their own
//   selection  a face selected in the model marks the rows of the features behind it; a click on a sketch's row
//              fills the listening field of a dialog; Ctrl and Shift select several rows; several rows are
//              dragged to another place as one step
//   folders    Add selection to folder (the menu and the button), nesting, collapse and expand (one, all), drag
//              into a folder, move out, rename, suppress a folder as one thing, unpack, delete with its contents;
//              a second person sees them
//   the menu   Rename, Suppress, dynamic suppression (add, edit, remove; it follows a variable), Show
//              dependencies, Hide, Copy sketch and Paste sketch, Add comment, Delete
//   building   pause regeneration (Regenerate, Regenerate and exit, Discard and exit, Restore; no sketching
//              meanwhile), regeneration times, the mark on a sketch that is not fully defined
//   the frame  the bar between the feature list and the parts list is dragged (and remembered), each list
//              scrolls by itself, the dock folds away and comes back
//
// Setup as the other cad-*-ui.mjs scripts (see cad-ui.mjs): a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-featurelist-ui.mjs
//
// With SHOTS it saves flist-*.png there (light theme, two device pixels per pixel).
import fs from 'node:fs';
import { setCad } from './cad-setting.mjs';
import { BASE, S, click, faceOnScreen, focusViewport, jwt, launch, newPartStudio, user } from './cad-ux-lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const browser = await launch();
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${login}: ${e.message}`));
  await setCad(BASE, jwt(uid, login));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}
const aliceId = user('flist-alice', 991401), bobId = user('flist-bob', 991402), carolId = user('flist-carol', 991403);
const alice = await open(aliceId, 'flist-alice');
const shot = async (name, p = alice, clip) => { if (SHOTS) { await p.waitForTimeout(350); await p.screenshot({ path: `${SHOTS}/flist-${name}.png`, clip }); } };

const st = (p = alice) => S(p, () => {
  const s = window.JunctionPartStudio.getState();
  return { n: s.features.length, order: s.features.map((f) => f.name), rollback: s.rollback, bodies: s.bodies.length, selected: s.selectedFeatures.slice(), pause: s.pause || null, discarded: s.discarded || 0, own: !!s.ownRollback, sketch: s.sketch ? s.sketch.featureId : null, editing: s.editing ? s.editing.draft : null, hover: s.hoverFeature, filter: (s.ui && s.ui.featureFilter) || '' };
});
/** The kernel is idle and every feature above the bar has reported. */
const built = (p = alice) => p.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.loaded && s.kernel.state === 'ready' && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, null, { timeout: 90000 });
const calm = async (p = alice) => { await p.waitForTimeout(120); await built(p); await p.waitForTimeout(120); };
const rows = (p = alice) => p.$$eval('.cad-features [data-feature-row]', (els) => els.map((e) => e.querySelector('[data-row-name]')?.textContent || ''));
const rowOf = (name, kind = 'feature') => `.cad-features [data-${kind}-row]:has([data-row-name]:text-is("${name}"))`;
const attr = (sel, a, p = alice) => p.locator(sel).first().getAttribute(a);
const item = (id, p = alice) => S(p, (id) => { const i = window.JunctionPartStudio.doc.items.get(id); return i ? JSON.parse(JSON.stringify(i)) : null; }, id);
const folderItems = (p = alice) => S(p, () => Array.from(window.JunctionPartStudio.doc.items.values()).filter((i) => i.type === 'folder').map((i) => JSON.parse(JSON.stringify(i))));
const menu = async (sel, label, p = alice) => { await p.click(sel, { button: 'right' }); await p.click(`.cad-feature-menu [data-menu-item="${label}"]`); };
const menuItems = async (sel, p = alice) => { await p.click(sel, { button: 'right' }); const out = await p.$$eval('.cad-feature-menu [data-menu-item]', (els) => els.map((e) => e.getAttribute('data-menu-item'))); return out; };
const closeMenu = async (p = alice) => { await p.mouse.click(900, 700); await p.waitForTimeout(60); };
const filter = async (text, p = alice) => { await p.fill('.cad-features [data-feature-filter]', text); await p.waitForTimeout(80); };
const zmax = (p = alice) => S(p, () => Math.max(...window.JunctionPartStudio.getState().bodies.map((b) => (window.JunctionPartStudio.view.bodyObjects(b.id)?.result.mesh || b.mesh).bbox[5])));
const undo = async (p = alice) => { await S(p, () => window.JunctionPartStudio.undo()); await calm(p); };
/** Drag a row by its name onto another, `where` of the way down it. */
async function dragRow(from, to, where = 0.2, p = alice) {
  const a = await p.locator(from).first().boundingBox(), b = await p.locator(to).first().boundingBox();
  await p.mouse.move(a.x + 60, a.y + a.height / 2);
  await p.mouse.down();
  await p.mouse.move(a.x + 64, a.y + a.height / 2 + 4, { steps: 3 });
  await p.mouse.move(b.x + 60, b.y + b.height * where, { steps: 8 });
  await p.waitForTimeout(80);
  await p.mouse.up();
  await calm(p);
}

try {
  // ================================================================ a model: two parts, a sketch nothing uses, a feature that fails
  const pid = await newPartStudio(alice, 'Feature list test');
  for (const [login, role] of [['flist-bob', 'viewer'], ['flist-carol', 'editor']]) {
    await alice.evaluate(async ({ pid, login, role }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, role }) })).status, { pid, login, role });
  }
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 90000 });
  const ids = await S(alice, () => {
    const stu = window.JunctionPartStudio, id = () => crypto.randomUUID();
    const rect = (x0, y0, x1, y1) => ({ p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
      l1: { type: 'line', a: 'p1', b: 'p2' }, l2: { type: 'line', a: 'p2', b: 'p3' }, l3: { type: 'line', a: 'p3', b: 'p4' }, l4: { type: 'line', a: 'p4', b: 'p1' } });
    const feat = (id, featureType, name, order, params) => ({ id, kind: 'ADDED', typeName: 'feature', item: { id, type: 'feature', featureType, name, order, params } });
    const sketch = (entities) => ({ plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints: {} } });
    const extrude = (s, depth) => ({ profile: { sketch: s, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [] });
    const s1 = id(), e1 = id(), s2 = id(), e2 = id(), s3 = id(), e3 = id(), v = id();
    stu.commit([
      feat(s1, 'sketch', 'Sketch 1', 'F', sketch(rect(-40, -25, 0, 25))), feat(e1, 'extrude', 'Extrude 1', 'K', extrude(s1, 20)),
      feat(s2, 'sketch', 'Sketch 2', 'P', sketch(rect(15, -15, 45, 15))), feat(e2, 'extrude', 'Extrude 2', 'U', extrude(s2, 10)),
      feat(s3, 'sketch', 'Sketch 3', 'a', sketch({ p1: { type: 'point', x: 60, y: 0 }, p2: { type: 'point', x: 80, y: 10 }, l1: { type: 'line', a: 'p1', b: 'p2' } })), feat(e3, 'extrude', 'Extrude 3', 'f', extrude(s3, 5)),
      { id: v, kind: 'ADDED', typeName: 'variable', item: { id: v, type: 'variable', name: 'depth', expr: '8 mm', order: 'V' } },
    ]);
    return { s1, e1, s2, e2, s3, e3, v };
  });
  await calm();
  await S(alice, () => window.JunctionPartStudio.fit());
  await alice.mouse.move(900, 860);
  const ALL = ['Sketch 1', 'Extrude 1', 'Sketch 2', 'Extrude 2', 'Sketch 3', 'Extrude 3'];

  // ================================================================ the top of the list
  check('the list shows the number of features', (await alice.textContent('.cad-features [data-feature-count]')).trim() === '6' && (await attr('[data-panel=features] [data-panel-count]', 'data-panel-count')) === '6');
  check('every feature has its row with its tool icon, under the default geometry', (await rows()).join() === ALL.join() && (await alice.locator('.cad-features [data-feature-row] svg.cad-glyph').count()) >= 6 && (await alice.locator('.cad-features [data-default-geometry]').count()) === 4);
  check('a feature that failed is counted at the top of the list', (await attr('.cad-features [data-error-badge]', 'data-error-badge')) === '1' && (await attr(rowOf('Extrude 3'), 'data-state')) === 'error');
  await alice.waitForSelector(`${rowOf('Sketch 3')} [data-underdefined]`, { timeout: 30000 });
  check('a sketch that is not fully defined carries a mark that says how free it is', Number(await attr(`${rowOf('Sketch 3')} [data-underdefined]`, 'data-underdefined')) === 4, await attr(`${rowOf('Sketch 3')} [data-underdefined]`, 'data-underdefined'));
  await shot('overview');

  await filter('extr');
  check('plain text finds by a piece of the name or the type; the count says how many of how many', (await rows()).join() === 'Extrude 1,Extrude 2,Extrude 3' && (await alice.textContent('.cad-features [data-feature-count]')).trim() === '3/6', (await rows()).join());
  check('the text is the studio\'s, so the parts list can follow it', (await st()).filter === 'extr');
  await alice.keyboard.press('Escape');
  check('Esc in the box clears it', (await rows()).length === 6 && (await st()).filter === '');
  await alice.click('.cad-features [data-filter-menu]');
  const options = await alice.$$eval('.cad-features [data-filter-options] [data-filter-option]', (els) => els.map((e) => e.getAttribute('data-filter-option')));
  check('the filter button opens the commands', options.join() === 'all,part,type,name,errors,warnings,folder,variable,suppressed,hidden,shown', options.join());
  await shot('filter-menu', alice, { x: 0, y: 60, width: 520, height: 520 });
  await alice.click('.cad-features [data-filter-option=errors]');
  check('choosing one writes it into the box and filters', (await st()).filter === ':errors ' && (await rows()).join() === 'Extrude 3', `${(await st()).filter} / ${(await rows()).join()}`);
  await filter(':pa');
  check('a command half typed filters nothing and offers what it could be', (await rows()).length === 6 && (await alice.$$eval('.cad-features [data-filter-options] [data-filter-option]', (els) => els.map((e) => e.getAttribute('data-filter-option')))).join() === 'part');
  await alice.press('.cad-features [data-feature-filter]', 'Tab');
  check('Tab finishes it', (await st()).filter === ':part ');
  await filter(':part part 2');
  check(':part shows the features that made the part', (await rows()).join() === 'Extrude 2', (await rows()).join());
  await filter(':type sketch');
  check(':type', (await rows()).join() === 'Sketch 1,Sketch 2,Sketch 3', (await rows()).join());
  await filter(':name extrude 1');
  check(':name', (await rows()).join() === 'Extrude 1');
  await filter(':hidden');
  check(':hidden shows the sketches a feature uses (hidden until asked for)', (await rows()).join() === 'Sketch 1,Sketch 2,Sketch 3', (await rows()).join());
  await alice.click(`${rowOf('Sketch 3')} [data-eye]`);
  await filter(':shown sketch');
  check(':shown shows what is not hidden', (await rows()).join() === 'Sketch 3', (await rows()).join());
  await alice.click(`${rowOf('Sketch 3')} [data-eye]`);
  await filter(':warnings');
  check(':warnings with none says so', (await rows()).length === 0 && await alice.isVisible('.cad-features [data-no-match]'));
  await S(alice, (ids) => window.JunctionPartStudio.commit([{ id: ids.e1, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', '$expr'], value: { depth: 'depth * 2' } }] }]), ids);
  await calm();
  await filter(':variable depth');
  check(':variable shows the features that use it', (await rows()).join() === 'Extrude 1', (await rows()).join());
  await filter(':variable Depth');
  check('… and minds capitals', (await rows()).length === 0);
  await filter('');
  await alice.click('.cad-features [data-error-badge]');
  check('the error count filters to the failures; again shows everything', (await rows()).join() === 'Extrude 3');
  await alice.click('.cad-features [data-error-badge]');
  check('… and again shows everything', (await rows()).length === 6);

  // ================================================================ the rollback bar
  const BAR = '.cad-features [data-rollback]';
  check('the bar is at the end, a slider that says where it is', (await attr(BAR, 'role')) === 'slider' && (await attr(BAR, 'aria-valuenow')) === '6' && (await attr(BAR, 'aria-valuemax')) === '6');
  await alice.click(BAR);
  await alice.keyboard.press('ArrowUp'); await calm();
  check('with the bar selected, ↑ rolls back one feature', (await st()).rollback === 5 && (await attr(rowOf('Extrude 3'), 'data-state')) === 'rolled-back', String((await st()).rollback));
  await alice.keyboard.press('ArrowUp'); await calm();
  await alice.keyboard.press('ArrowUp'); await calm();
  check('… and again, keeping the keyboard', (await st()).rollback === 3 && (await st()).bodies === 1 && await alice.evaluate(() => document.activeElement?.hasAttribute('data-rollback')), `${(await st()).rollback} ${(await st()).bodies}`);
  await alice.keyboard.press('ArrowDown'); await calm();
  check('↓ rolls forward', (await st()).rollback === 4 && (await st()).bodies === 2);
  await alice.keyboard.press('Home'); await calm();
  check('Home rolls to the start', (await st()).rollback === 0 && (await st()).bodies === 0);
  await alice.keyboard.press('End'); await calm();
  check('End rolls to the end', (await st()).rollback === 6);
  {
    const bar = await alice.locator(BAR).boundingBox(), to = await alice.locator(rowOf('Sketch 2')).boundingBox();
    await alice.mouse.move(bar.x + 40, bar.y + bar.height / 2); await alice.mouse.down();
    await alice.mouse.move(bar.x + 40, to.y + 4, { steps: 6 }); await alice.mouse.up(); await calm();
    check('the bar is dragged above a feature', (await st()).rollback === 2 && (await st()).bodies === 1 && (await attr(BAR, 'data-rolled')) === '4', String((await st()).rollback));
  }
  await shot('rolled-back');
  await alice.click(BAR, { button: 'right' });
  check('a right click on the bar offers Roll to end', (await alice.$$eval('.cad-feature-menu [data-menu-item]', (els) => els.map((e) => e.getAttribute('data-menu-item')))).includes('Roll to end'));
  await alice.click('.cad-feature-menu [data-menu-item="Roll to end"]'); await calm();
  check('… which puts it back', (await st()).rollback === 6 && (await st()).bodies === 2);
  await menu(rowOf('Extrude 2'), 'Roll to here'); await calm();
  check('Roll to here puts the bar right under the feature', (await st()).rollback === 4);
  await undo();
  check('rolling is an edit of the document: undo takes it back', (await st()).rollback === 6);

  // ================================================================ selecting
  await focusViewport(alice);
  const face = await faceOnScreen(alice, ['^' + ids.e1]);
  await click(alice, face);
  check('a face selected in the model marks the row of the feature behind it', (await attr(rowOf('Extrude 1'), 'data-cross')) === 'true' && (await alice.locator('.cad-features [data-feature-row][data-cross]').count()) === 1, face ? face.name : 'no face');
  await shot('cross-highlight');
  await alice.keyboard.press('Escape');
  check('… until the selection is cleared', (await alice.locator('.cad-features [data-feature-row][data-cross]').count()) === 0);
  await alice.click(rowOf('Sketch 1'));
  await alice.click(rowOf('Sketch 2'), { modifiers: ['Control'] });
  check('Ctrl selects several rows', (await st()).selected.length === 2);
  await alice.click(rowOf('Sketch 1'));
  await alice.click(rowOf('Extrude 2'), { modifiers: ['Shift'] });
  check('Shift takes the range', (await st()).selected.length === 4);
  await alice.keyboard.press('Escape'); await alice.keyboard.press('Escape');
  // a dialog's listening field takes a click on a sketch's row
  await S(alice, () => window.JunctionPartStudio.startFeature('extrude'));
  await alice.waitForFunction(() => !!window.JunctionPartStudio.getState().editing);
  await S(alice, () => window.JunctionPartStudio.setField('profile'));
  await alice.click(rowOf('Sketch 2'));
  check('with a dialog listening, a click on a sketch\'s row gives it the sketch', (await st()).editing?.params.profile?.sketch === ids.s2, JSON.stringify((await st()).editing?.params.profile));
  await S(alice, () => window.JunctionPartStudio.cancelFeature());
  await calm();

  // several rows dragged as one
  await alice.click(rowOf('Sketch 3'));
  await alice.click(rowOf('Extrude 3'), { modifiers: ['Control'] });
  await dragRow(rowOf('Extrude 3'), rowOf('Sketch 2'));
  check('the selected rows are dragged to another place together', (await st()).order.join() === 'Sketch 1,Extrude 1,Sketch 3,Extrude 3,Sketch 2,Extrude 2', (await st()).order.join());
  await undo();
  check('… as one step', (await st()).order.join() === ALL.join(), (await st()).order.join());
  await alice.click(rowOf('Extrude 1'));
  await alice.click(rowOf('Sketch 3'), { modifiers: ['Control'] });
  await dragRow(rowOf('Sketch 3'), BAR, 0.5);
  check('rows that are not next to each other move too, keeping their order', (await st()).order.join() === 'Sketch 1,Sketch 2,Extrude 2,Extrude 3,Extrude 1,Sketch 3', (await st()).order.join());
  await undo();
  await alice.keyboard.press('Escape');

  // ================================================================ folders
  check('with nothing selected the folder button waits', await alice.isDisabled('.cad-features [data-new-folder]'));
  await alice.click(rowOf('Sketch 2'));
  await alice.click(rowOf('Extrude 2'), { modifiers: ['Control'] });
  await alice.click('.cad-features [data-new-folder]');
  await alice.waitForSelector('[data-folder-dialog] [data-folder-name]');
  check('the folder button asks for a name', (await alice.inputValue('[data-folder-dialog] [data-folder-name]')) === 'Folder 1');
  await alice.fill('[data-folder-dialog] [data-folder-name]', 'Second part');
  await alice.keyboard.press('Enter'); await calm();
  let folders = await folderItems();
  const F1 = rowOf('Second part', 'folder');
  check('the folder is in the list, holding the two', folders.length === 1 && folders[0].name === 'Second part' && (await attr(`${F1} [data-folder-count]`, 'data-folder-count')) === '2' && (await attr(rowOf('Extrude 2'), 'data-depth')) === '1' && (await attr(rowOf('Extrude 2'), 'data-folder')) === folders[0].id);
  check('… and the features are built in the order they were', (await st()).order.join() === ALL.join() && (await st()).bodies === 2);
  await alice.click(`${F1} [data-folder-toggle]`);
  check('its arrow collapses it', (await rows()).join() === 'Sketch 1,Extrude 1,Sketch 3,Extrude 3' && !(await attr(F1, 'data-open')));
  await alice.click(`${F1} [data-folder-toggle]`);
  check('… and expands it', (await rows()).length === 6 && (await attr(F1, 'data-open')) === 'true');
  // nesting
  await menu(rowOf('Extrude 2'), 'Add to folder…');
  await alice.fill('[data-folder-dialog] [data-folder-name]', 'Inner');
  await alice.click('[data-folder-dialog] [data-accept]'); await calm();
  folders = await folderItems();
  const outer = folders.find((f) => f.name === 'Second part'), inner = folders.find((f) => f.name === 'Inner');
  check('a folder made inside a folder is nested in it', !!inner && inner.parent === outer.id && (await attr(rowOf('Extrude 2'), 'data-depth')) === '2' && (await attr(rowOf('Inner', 'folder'), 'data-depth')) === '1');
  await shot('folders');
  const fm = await menuItems(F1);
  check('the menu of a folder', ['Rename', 'Suppress', 'Add dynamic suppression…', 'Collapse', 'Expand all', 'Collapse all', 'Roll to here', 'Add to folder…', 'Unpack folder', 'Delete folder and what is in it'].every((m) => fm.includes(m)), fm.join(' | '));
  await shot('folder-menu');
  await alice.click('.cad-feature-menu [data-menu-item="Collapse all"]');
  check('Collapse all', (await rows()).join() === 'Sketch 1,Extrude 1,Sketch 3,Extrude 3');
  await menu(F1, 'Expand all');
  check('Expand all', (await rows()).length === 6);
  // suppressing a folder
  await menu(F1, 'Suppress'); await calm();
  check('a suppressed folder is not built, as one thing', (await st()).bodies === 1 && (await attr(F1, 'data-state')) === 'suppressed' && (await attr(`${rowOf('Extrude 2')} [data-off]`, 'data-off')) === 'folder' && (await item(ids.e2)).suppressed === undefined, `${(await st()).bodies}`);
  await filter(':suppressed');
  check(':suppressed shows what a folder suppresses', (await rows()).join() === 'Sketch 2,Extrude 2', (await rows()).join());
  await filter(':folder inner');
  check(':folder shows a folder and what it holds', (await rows()).join() === 'Extrude 2' && (await alice.locator('.cad-features [data-folder-row]').count()) === 2, (await rows()).join());
  await filter('');
  await menu(F1, 'Unsuppress'); await calm();
  check('… and unsuppressing it builds them again', (await st()).bodies === 2);
  // dragging into a folder, and out
  await alice.click(rowOf('Sketch 3'));
  await dragRow(rowOf('Sketch 3'), F1, 0.5);
  check('a row dropped on a folder goes into it, at its end', (await item(ids.s3)).folder === outer.id && (await st()).order.join() === 'Sketch 1,Extrude 1,Sketch 2,Extrude 2,Sketch 3,Extrude 3', `${(await item(ids.s3)).folder} ${(await st()).order.join()}`);
  await menu(rowOf('Sketch 3'), 'Move out of folder'); await calm();
  check('Move out of folder', (await item(ids.s3)).folder === undefined && (await attr(rowOf('Sketch 3'), 'data-depth')) === '0');
  const moveTo = await menuItems(rowOf('Sketch 3'));
  check('the menu offers the folders to move to', moveTo.includes('Move to “Second part”') && moveTo.includes('Move to “Inner”'), moveTo.join(' | '));
  await closeMenu();
  // a folder with the bar inside it stays open
  await alice.click(`${F1} [data-folder-toggle]`);
  await S(alice, (ids) => window.JunctionPartStudio.rollTo(ids.e2), ids); await calm();
  check('a collapsed folder opens when the bar is inside it', (await attr(F1, 'data-open')) === 'true' && (await st()).rollback === 3);
  await S(alice, () => window.JunctionPartStudio.rollTo(null)); await calm();
  await alice.click(`${F1} [data-folder-toggle]`);
  // rename
  await menu(F1, 'Rename');
  await alice.fill('.cad-features input[aria-label="Folder name"]', 'Lid');
  await alice.keyboard.press('Enter'); await calm();
  check('a folder is renamed in the list', (await folderItems()).some((f) => f.name === 'Lid'));
  const L = rowOf('Lid', 'folder');
  // a second person sees the folders
  const carol = await open(carolId, 'flist-carol');
  await carol.goto(alice.url());
  await carol.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().features.length === 6, null, { timeout: 60000 });
  await carol.waitForSelector(L);
  check('a second person sees the folders', (await carol.locator('.cad-features [data-folder-row]').count()) === 2 && (await attr(rowOf('Extrude 2'), 'data-depth', carol)) === '2');
  await menu(rowOf('Inner', 'folder'), 'Unpack folder', carol);
  await alice.waitForFunction(() => document.querySelectorAll('.cad-features [data-folder-row]').length === 1);
  check('… and unpacking one is seen by the first; what it held stays in the folder around', (await item(ids.e2)).folder === outer.id && (await attr(rowOf('Extrude 2'), 'data-depth')) === '1');
  await carol.context().close();
  // deleting a folder takes what it holds
  await alice.click(L);
  await focusViewport(alice);
  await alice.keyboard.press('Delete'); await calm();
  check('Delete on a selected folder deletes it and what it holds', (await st()).n === 4 && (await folderItems()).length === 0 && (await st()).bodies === 1, `${(await st()).n}`);
  await undo();
  check('… and undo brings all of it back', (await st()).n === 6 && (await folderItems()).length === 1 && (await st()).bodies === 2 && (await attr(rowOf('Extrude 2'), 'data-depth')) === '1');
  await menu(L, 'Unpack folder'); await calm();
  check('Unpack folder leaves the features in the list', (await folderItems()).length === 0 && (await rows()).join() === ALL.join() && (await item(ids.e2)).folder === undefined);

  // ================================================================ the menu of a feature
  const items = await menuItems(rowOf('Sketch 2'));
  check('the menu of a feature', ['Edit sketch', 'Rename', 'Suppress', 'Add dynamic suppression…', 'Roll to here', 'Hide', 'Zoom to', 'Show dependencies…', 'Add to folder…', 'Copy sketch', 'Add comment…', 'Delete'].every((m) => items.includes(m) || (m === 'Hide' && items.includes('Show'))), items.join(' | '));
  await shot('menu');
  await alice.click('.cad-feature-menu [data-menu-item="Copy sketch"]');
  await menu(rowOf('Extrude 1'), 'Paste sketch'); await calm();
  {
    const s = await st(), pasted = await S(alice, () => { const f = window.JunctionPartStudio.getState().features.find((x) => x.name === 'Sketch 4'); return f ? { n: Object.keys(f.params.sketch.entities).length, plane: f.params.plane.plane } : null; });
    check('Copy sketch and Paste sketch make a new sketch with the same curves', s.n === 7 && !!pasted && pasted.n === 8 && pasted.plane === 'top', JSON.stringify(pasted));
  }
  await undo();
  await menu(rowOf('Extrude 1'), 'Rename');
  await alice.fill('.cad-features input[aria-label="Feature name"]', 'Base');
  await alice.keyboard.press('Enter'); await calm();
  check('Rename edits the name in the list', (await item(ids.e1)).name === 'Base');
  await undo();
  // dependencies
  await menu(rowOf('Extrude 1'), 'Show dependencies…');
  await alice.waitForSelector('[data-deps]');
  check('Show dependencies lists the parents above and the children below', (await alice.$$eval('[data-deps] [data-dep-row=parent]', (els) => els.map((e) => e.textContent.trim()))).join() === 'Sketch 1' && (await alice.locator('[data-deps] [data-dep-row=child]').count()) === 0 && (await attr(`${rowOf('Sketch 1')} [data-dep]`, 'data-dep')) === 'uses');
  await alice.hover('[data-deps] [data-dep-row=parent]');
  check('… and the pointer over one lights it up in the model', (await st()).hover === ids.s1);
  await shot('dependencies');
  await alice.click('[data-deps] [data-close]');
  await menu(rowOf('Sketch 1'), 'Show dependencies…');
  check('… a sketch has the feature made from it as its child', (await alice.$$eval('[data-deps] [data-dep-row=child]', (els) => els.map((e) => e.textContent.trim()))).join() === 'Extrude 1');
  await alice.keyboard.press('Escape');
  await alice.click('[data-deps] [data-close]').catch(() => {});
  // dynamic suppression
  await menu(rowOf('Extrude 2'), 'Add dynamic suppression…');
  await alice.waitForSelector('[data-suppression-dialog] [data-suppress-if]');
  await alice.fill('[data-suppression-dialog] [data-suppress-if]', '#depth <');
  check('a condition that cannot be read is said so and cannot be accepted', (await attr('[data-suppression-dialog] [data-condition-state]', 'data-condition-state')) === 'error' && await alice.isDisabled('[data-suppression-dialog] [data-accept]'));
  await alice.fill('[data-suppression-dialog] [data-suppress-if]', '#depth < 10 mm');
  check('the dialog says what the condition is worth now', (await attr('[data-suppression-dialog] [data-condition-state]', 'data-condition-state')) === 'suppressed');
  await shot('dynamic-suppression');
  await alice.keyboard.press('Enter'); await calm();
  check('dynamic suppression: the feature is suppressed while its condition holds', (await item(ids.e2)).suppressIf === '#depth < 10 mm' && (await st()).bodies === 1 && (await attr(`${rowOf('Extrude 2')} [data-off]`, 'data-off')) === 'condition' && (await attr(`${rowOf('Extrude 2')} [data-suppress-if]`, 'data-condition')) === 'true');
  await S(alice, (ids) => window.JunctionPartStudio.commit([{ id: ids.v, kind: 'MODIFIED', typeName: 'variable', props: [{ path: ['expr'], value: '15 mm' }] }]), ids);
  await calm();
  check('… and built again when the variable changes', (await st()).bodies === 2 && (await attr(rowOf('Extrude 2'), 'data-state')) === 'ok' && (await attr(`${rowOf('Extrude 2')} [data-suppress-if]`, 'data-condition')) === 'false');
  await alice.click(`${rowOf('Extrude 2')} [data-suppress-if]`);
  check('its mark opens the expression again', (await alice.inputValue('[data-suppression-dialog] [data-suppress-if]')) === '#depth < 10 mm');
  await alice.click('[data-suppression-dialog] [data-remove-condition]'); await calm();
  check('Remove expression takes it away', (await item(ids.e2)).suppressIf === undefined && (await alice.locator(`${rowOf('Extrude 2')} [data-suppress-if]`).count()) === 0);
  // suppress, hide
  await menu(rowOf('Extrude 2'), 'Suppress'); await calm();
  check('Suppress', (await item(ids.e2)).suppressed === true && (await st()).bodies === 1 && (await attr(`${rowOf('Extrude 2')} [data-off]`, 'data-off')) === 'own');
  await menu(rowOf('Extrude 2'), 'Unsuppress'); await calm();
  await menu(rowOf('Sketch 3'), 'Show');
  check('Show shows a sketch a feature uses (in this person\'s view)', (await attr(`${rowOf('Sketch 3')} [data-eye]`, 'data-eye')) === 'shown');
  await menu(rowOf('Sketch 3'), 'Hide');
  check('… and Hide hides it again; so does its eye', (await attr(`${rowOf('Sketch 3')} [data-eye]`, 'data-eye')) === 'hidden');
  // comment
  await menu(rowOf('Extrude 1'), 'Add comment…');
  await alice.waitForTimeout(300);
  check('Add comment starts a thread on the feature', (await alice.locator('[data-panel=comments][data-open] textarea').count()) > 0 || (await alice.locator('.cad-root textarea').count()) > 0);
  await alice.keyboard.press('Escape');
  await S(alice, () => { const b = document.querySelector('[data-panel=comments][data-open] [data-panel-toggle]'); if (b) b.click(); });

  // ================================================================ pausing regeneration, and how long it takes
  const z0 = await zmax();
  await alice.click('.cad-features [data-regen-pause]');
  check('Pause regeneration says so', (await st()).pause?.edits === 0 && await alice.isVisible('.cad-features [data-regen-paused]') && (await attr('.cad-features [data-regen-pause]', 'aria-pressed')) === 'true');
  const depth = (d) => S(alice, ([ids, d]) => window.JunctionPartStudio.commit([{ id: ids.e2, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'depth'], value: d }] }]), [ids, d]);
  await depth(60); await alice.waitForTimeout(700);
  check('while paused an edit is made but the model waits', (await item(ids.e2)).params.depth === 60 && (await zmax()) === z0 && (await attr('.cad-features [data-regen-paused]', 'data-regen-paused')) === '1', `${await zmax()} ${z0}`);
  await shot('paused');
  await S(alice, () => window.JunctionPartStudio.startFeature('sketch'));
  check('a sketch cannot be started meanwhile', (await st()).sketch === null && (await st()).editing === null && (await st()).n === 6);
  await alice.click('.cad-features [data-regen-now]'); await calm();
  check('Regenerate rebuilds and stays paused', (await zmax()) === 60 && (await st()).pause?.edits === 0, String(await zmax()));
  await depth(70); await alice.waitForTimeout(300);
  await alice.click('.cad-features [data-regen-discard]'); await calm();
  check('Discard and exit takes back what was not regenerated, and only that', (await item(ids.e2)).params.depth === 60 && (await st()).pause === null && (await zmax()) === 60 && (await st()).discarded === 1);
  await alice.click('.cad-features [data-regen-restore]'); await alice.waitForTimeout(300);
  check('Restore brings it back, paused again', (await item(ids.e2)).params.depth === 70 && (await st()).pause?.edits === 1 && (await zmax()) === 60);
  await alice.click('.cad-features [data-regen-exit]'); await calm();
  check('Regenerate and exit rebuilds and goes on as usual', (await st()).pause === null && (await zmax()) === 70 && !(await alice.locator('.cad-features [data-regen-paused]').count()));
  await depth(10); await calm();
  check('… every edit rebuilds again', (await zmax()) === z0);

  await alice.click('.cad-features [data-regen-times]');
  await alice.waitForSelector('[data-regen-times-dialog]');
  const times = await alice.$$eval('[data-regen-times-dialog] [data-time-row]', (els) => els.map((e) => e.getAttribute('data-ms')));
  check('Regeneration times lists every feature with the time it took', times.length === 6 && times.filter((t) => t !== null && Number(t) >= 0).length >= 5 && Number(await attr('[data-regen-times-dialog] [data-regen-total]', 'data-regen-total')) > 0, times.join());
  await alice.hover(`[data-regen-times-dialog] [data-time-row="${ids.e1}"]`);
  check('… and the pointer over a row lights the feature up', (await st()).hover === ids.e1);
  await shot('times');
  await alice.click(`[data-regen-times-dialog] [data-time-row="${ids.e2}"] [data-time-suppress]`); await calm();
  check('… and a feature is suppressed from there', (await item(ids.e2)).suppressed === true);
  await undo();
  await alice.click('[data-regen-times-dialog] [data-close]');

  // ================================================================ the frame
  const SEP = '.cad-dock[data-side=left] [data-dock-separator]';
  const partsH = () => alice.$eval('.cad-dock[data-side=left] [data-dock-separator] + section', (e) => Math.round(e.getBoundingClientRect().height));
  const featuresH = () => alice.$eval('[data-panel=features]', (e) => Math.round(e.getBoundingClientRect().height));
  check('a bar separates the feature list from the parts list', (await alice.locator(SEP).count()) === 1 && (await attr(SEP, 'role')) === 'separator');
  const h0 = await partsH(), f0 = await featuresH();
  {
    const b = await alice.locator(SEP).boundingBox();
    await alice.mouse.move(b.x + b.width / 2, b.y + 3); await alice.mouse.down();
    await alice.mouse.move(b.x + b.width / 2, b.y + 3 - 120, { steps: 5 }); await alice.mouse.up();
  }
  const h1 = await partsH(), f1 = await featuresH();
  check('dragging it up gives the parts list more room and the feature list less', Math.abs(h1 - h0 - 120) <= 3 && Math.abs(f0 - f1 - 120) <= 3, `${h0}→${h1}, ${f0}→${f1}`);
  check('each of the two scrolls by itself', await alice.evaluate(() => ['features', 'parts'].every((id) => { const e = document.querySelector(`[data-panel=${id}] > div`); return !!e && getComputedStyle(e).overflowY === 'auto'; })));
  await shot('separator');
  check('the choice is kept in this browser', (await alice.evaluate(() => localStorage.getItem('junction.cad.dockSplit'))) === String(h1));
  await alice.dblclick(SEP);
  check('a double click gives it back', (await partsH()) === h0 && (await alice.evaluate(() => localStorage.getItem('junction.cad.dockSplit'))) === null, `${await partsH()}`);
  await alice.click('[data-dock-fold=left]');
  check('the button at the top folds the lists away', (await attr('.cad-dock[data-side=left]', 'data-folded')) === 'true' && !(await alice.isVisible('.cad-features')));
  await alice.click('[data-dock-unfold=left]');
  check('… and brings them back', await alice.isVisible('.cad-features') && (await rows()).length === 6);
  await focusViewport(alice);
  await alice.keyboard.press('?');
  check('the sheet of keys has the bar\'s', /rollback bar/i.test(await alice.textContent('.cad-shortcuts')));
  await alice.keyboard.press('Escape');

  // ================================================================ someone who cannot edit
  const bob = await open(bobId, 'flist-bob');
  await bob.goto(alice.url());
  await bob.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().features.length === 6, null, { timeout: 60000 });
  await calm(bob);
  check('a viewer sees the list but not the edits', !(await bob.evaluate(() => window.JunctionPartStudio.getState().canEdit)) && await bob.isDisabled('.cad-features [data-new-folder]') && !(await menuItems(rowOf('Extrude 1'), bob)).includes('Delete'));
  await closeMenu(bob);
  await bob.click(BAR);
  await bob.keyboard.press('ArrowUp'); await bob.keyboard.press('ArrowUp'); await calm(bob);
  check('a viewer rolls back for themselves: the document\'s bar stays', (await st(bob)).rollback === 4 && (await st(bob)).own && (await st()).rollback === 6 && (await attr(BAR, 'data-own', bob)) === 'true', `${(await st(bob)).rollback} ${(await st()).rollback}`);
  await bob.click(BAR, { button: 'right' });
  await bob.click('.cad-feature-menu [data-menu-item="Follow the document\'s bar"]'); await calm(bob);
  check('… and can follow the document\'s again', (await st(bob)).rollback === 6 && !(await st(bob)).own);
  check('no page errors', alice.errors.length === 0 && bob.errors.length === 0, [...alice.errors, ...bob.errors].join(' | '));
} catch (e) {
  check('the script ran to its end', false, e.stack || String(e));
  await shot('failed');
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
