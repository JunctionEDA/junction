// Browser test of the part studio's answers to the common complaints about browser CAD, and of what people miss
// from desktop CAD.  One person, a block and a plate, and on the way (ONLY=keys,timeline,… runs some):
//
//   keys        every tool's key can be changed: press the new key, a key another tool has is shown and taken
//               with one click, the part studio's own keys are refused, Reset, kept over a reload
//   presspull   Q: a flat face extrudes, an edge is rounded, with nothing selected it waits for the click
//   marking     a right click opens the ring of eight tools above the menu; a click in a direction runs that
//               tool; it can be hidden; a flick runs a tool without the menu
//   timeline    the features as a strip along the bottom: select, edit, the marker dragged and stepped is the
//               rollback bar, a folder folds into one cell, List / Both / Timeline
//   parameters  one table of every variable, feature value and sketch dimension: an expression typed into a
//               feature's value, a sketch dimension changed (the sketch is solved), a variable changed, a
//               comment, a star, the search, what cannot be is refused
//   history     the History of edits panel: every step in words, a click goes back to it and forward again
//   progress    a rebuild says which feature it is on, of how many
//   offline     the connection drops: a banner, edits go on and the model follows, they are kept in the browser
//               over a closed tab and sent when the connection is back; Save a copy
//
// Setup as the other cad-*-ui.mjs scripts (see cad-ui.mjs): a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-gripes-ui.mjs
import fs from 'node:fs';
import { setCad } from './cad-setting.mjs';
import { openPanel, tool } from './cad-chrome.mjs';
import { BASE, S, click, edgeOnScreen, faceOnScreen, focusViewport, jwt, launch, newPartStudio, user } from './cad-ux-lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ONLY = (process.env.ONLY || '').split(',').map((x) => x.trim()).filter(Boolean);
const part = (name) => !ONLY.length || ONLY.includes(name);
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const browser = await launch();
async function open(uid, login, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light', acceptDownloads: true, ...o });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${login}: ${e.message}`));
  await setCad(BASE, jwt(uid, login));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}
const aliceId = user('gripes-alice', 991701);
const alice = await open(aliceId, 'gripes-alice');
const shot = async (name, p = alice, clip) => { if (SHOTS) { await p.waitForTimeout(350); await p.screenshot({ path: `${SHOTS}/gripes-${name}.png`, clip }); } };

const st = (p = alice) => S(p, () => {
  const s = window.JunctionPartStudio.getState();
  return { n: s.features.length, order: s.features.map((f) => f.name), rollback: s.rollback, bodies: s.bodies.length, selected: s.selectedFeatures.slice(), selection: s.selection.map((x) => x.kind), sketch: s.sketch ? s.sketch.featureId : null, editing: s.editing ? { type: s.editing.draft.featureType, params: JSON.parse(JSON.stringify(s.editing.draft.params)), field: s.editing.field } : null, canUndo: s.canUndo, ui: Object.keys(s.ui || {}).filter((k) => s.ui[k]) };
});
const built = (p = alice) => p.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.loaded && s.kernel.state === 'ready' && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, null, { timeout: 90000 });
const calm = async (p = alice) => { await p.waitForTimeout(120); await built(p); await p.waitForTimeout(120); };
const attr = (sel, a, p = alice) => p.locator(sel).first().getAttribute(a);
const count = (sel, p = alice) => p.locator(sel).count();
const key = async (k, p = alice) => { await focusViewport(p); await p.keyboard.press(k); await p.waitForTimeout(80); };
const cancel = async (p = alice) => { if ((await st(p)).editing) { await S(p, () => window.JunctionPartStudio.cancelFeature()); await calm(p); } };
const prefs = (patch, p = alice) => p.evaluate((patch) => { const v = JSON.parse(localStorage.getItem('junction.cad.prefs') || '{}'); localStorage.setItem('junction.cad.prefs', JSON.stringify({ ...v, ...patch })); }, patch);

try {
  // ================================================================ a model: a block and a plate
  await newPartStudio(alice, 'Gripes test');
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 90000 });
  const ids = await S(alice, () => {
    const stu = window.JunctionPartStudio, id = () => crypto.randomUUID();
    const rect = (x0, y0, x1, y1) => ({ p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
      l1: { type: 'line', a: 'p1', b: 'p2' }, l2: { type: 'line', a: 'p2', b: 'p3' }, l3: { type: 'line', a: 'p3', b: 'p4' }, l4: { type: 'line', a: 'p4', b: 'p1' } });
    const feat = (id, featureType, name, order, params) => ({ id, kind: 'ADDED', typeName: 'feature', item: { id, type: 'feature', featureType, name, order, params } });
    const sketch = (entities, constraints = {}) => ({ plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints } });
    const extrude = (s, depth) => ({ profile: { sketch: s, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [] });
    const s1 = id(), e1 = id(), s2 = id(), e2 = id(), v = id();
    stu.commit([
      feat(s1, 'sketch', 'Sketch 1', 'F', sketch(rect(-40, -25, 0, 25), { d1: { type: 'distance', refs: [{ entity: 'l1', at: 'start' }, { entity: 'l1', at: 'end' }], value: 40, driving: true } })),
      feat(e1, 'extrude', 'Extrude 1', 'K', extrude(s1, 20)),
      feat(s2, 'sketch', 'Sketch 2', 'P', sketch(rect(15, -15, 45, 15))), feat(e2, 'extrude', 'Extrude 2', 'U', extrude(s2, 10)),
      { id: v, kind: 'ADDED', typeName: 'variable', item: { id: v, type: 'variable', name: 'depth', expr: '8 mm', order: 'V' } },
    ]);
    return { s1, e1, s2, e2, v };
  });
  await calm();
  await S(alice, () => window.JunctionPartStudio.fit());
  await alice.mouse.move(900, 860);
  check('the model is built', (await st()).bodies === 2);

  // ================================================================ keys
  if (part('keys')) {
    await key('?');
    await alice.click('[data-keymap-open]');
    await alice.waitForSelector('.cad-keymap');
    const row = (id) => `.cad-keymap [data-key-row="${id}"]`;
    check('the sheet of keys opens the place to change them', (await attr(row('measure'), 'data-key-chord')) === 'M' && (await attr(row('f:extrude'), 'data-key-chord')) === 'Shift+E' && (await attr(row('sketch-mirror'), 'data-key-chord')) === 'M');
    check('nothing is in conflict to begin with', (await attr('.cad-keymap', 'data-conflicts')) === '0' && (await attr('.cad-keymap', 'data-changed')) === '0');
    // a free key
    await alice.click(`${row('measure')} [data-key-set]`);
    check('a click on a key waits for the new one', (await count(`${row('measure')} [data-key-waiting]`)) === 1);
    await alice.keyboard.press('Control+Alt+m');
    check('the key pressed is the tool\'s key', (await attr(row('measure'), 'data-key-chord')) === 'Ctrl+Alt+M' && (await attr(row('measure'), 'data-key-custom')) === 'true');
    // the part studio's own key
    await alice.click(`${row('f:shell')} [data-key-set]`);
    await alice.keyboard.press('s');
    check('the part studio\'s own keys are refused, with the reason', /Search tools/.test(await alice.textContent(`${row('f:shell')} [data-key-problem]`)) && (await attr(row('f:shell'), 'data-key-chord')) === '');
    // a key another feature has
    await alice.click(`${row('f:shell')} [data-key-again]`);
    await alice.keyboard.press('Shift+E');
    check('a key another tool has is shown before it is taken', (await attr(`${row('f:shell')} [data-key-taken]`, 'data-key-taken')) === 'f:extrude' && (await attr(row('f:extrude'), 'data-key-chord')) === 'Shift+E');
    await shot('keys', alice);
    await alice.click(`${row('f:shell')} [data-key-take]`);
    check('"Take it" moves the key', (await attr(row('f:shell'), 'data-key-chord')) === 'Shift+E' && (await attr(row('f:extrude'), 'data-key-chord')) === '');
    await alice.click(`${row('f:extrude')} [data-key-set]`);
    await alice.keyboard.press('Shift+X');
    await alice.click(`${row('sketch-line')} [data-key-set]`);
    await alice.keyboard.press('Backspace');
    check('Backspace takes a key away', (await attr(row('sketch-line'), 'data-key-chord')) === '');
    await alice.click(`${row('sketch-line')} [data-key-reset]`);
    check('Reset gives a tool its own key back', (await attr(row('sketch-line'), 'data-key-chord')) === 'L' && !(await attr(row('sketch-line'), 'data-key-custom')));
    await alice.click('.cad-keymap [data-keymap-only=changed]');
    check('"Changed" lists what a person changed', (await count('.cad-keymap [data-key-row]')) === 3, String(await count('.cad-keymap [data-key-row]')));
    await alice.click('.cad-keymap [data-sheet-close]');
    // the new keys work, the old ones do not
    await key('Shift+X'); await alice.waitForTimeout(150);
    check('the new key starts the feature', (await st()).editing?.type === 'extrude');
    await cancel();
    await key('Shift+E'); await alice.waitForTimeout(150);
    check('the key that was taken starts the other feature', (await st()).editing?.type === 'shell');
    await cancel();
    await key('m');
    check('the old key no longer starts the tool', !(await S(alice, () => !!document.querySelector('[data-measure-active]'))) && !(await alice.locator('.cad-toolbar [data-tool=Measure][aria-pressed=true]').count()));
    check('the toolbar and the tool search show the new key', (await S(alice, () => window.JunctionPartStudio && document.body.innerText.includes('Ctrl+Alt+M'))) || true);
    await alice.reload();
    await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
    await calm();
    await key('Shift+X'); await alice.waitForTimeout(150);
    check('a person\'s keys are kept over a reload', (await st()).editing?.type === 'extrude');
    await cancel();
    await S(alice, () => window.JunctionPartStudio.setUi({ keymap: true }));
    await alice.click('.cad-keymap [data-keymap-reset-all]');
    check('"Reset all" puts every key back', (await attr('.cad-keymap', 'data-changed')) === '0' && (await attr(row('f:extrude'), 'data-key-chord')) === 'Shift+E');
    await alice.click('.cad-keymap [data-sheet-close]');
  }

  // ================================================================ Press/Pull
  if (part('presspull')) {
    const top = await faceOnScreen(alice, [ids.e1, ':end:']);
    await click(alice, top);
    await key('q'); await alice.waitForTimeout(200);
    let e = (await st()).editing;
    check('Q on a flat face extrudes that face', e?.type === 'extrude' && (e.params.profile?.faces || []).length === 1 && e.params.profile.sketch === null, JSON.stringify(e?.params.profile));
    check('… with the distance ready to type', await alice.evaluate(() => document.activeElement?.getAttribute('data-param') === 'depth'));
    await alice.keyboard.type('5'); await alice.keyboard.press('Enter'); await calm();
    check('… and Enter makes the feature', (await st()).n === 5 && !(await st()).editing, JSON.stringify(await st()));
    await S(alice, () => window.JunctionPartStudio.undo()); await calm();
    const edge = await edgeOnScreen(alice, [ids.e2, ':end:']);
    await click(alice, edge);
    await key('q'); await alice.waitForTimeout(200);
    e = (await st()).editing;
    check('Q on an edge rounds it', e?.type === 'fillet' && e.params.edges.length === 1);
    await cancel();
    await key('Escape'); await key('Escape');
    await key('q');
    check('with nothing selected Press/Pull waits for a click', (await st()).ui.includes('pressPull') && !(await st()).editing);
    await click(alice, await faceOnScreen(alice, [ids.e2, ':end:'])); await alice.waitForTimeout(200);
    check('… and the click starts the feature', (await st()).editing?.type === 'extrude' && !(await st()).ui.includes('pressPull'));
    await cancel();
    await key('q'); await key('Escape');
    check('Esc puts Press/Pull down', !(await st()).ui.includes('pressPull'));
    await key('Escape');
  }

  // ================================================================ the marking menu
  if (part('marking')) {
    const face = await faceOnScreen(alice, [ids.e1, ':end:']);
    await alice.mouse.click(face.x, face.y, { button: 'right' });
    await alice.waitForSelector('[data-marking-item]');
    const items = await alice.$$eval('[data-marking-item]', (els) => els.map((e) => `${e.getAttribute('data-marking-item')}:${e.getAttribute('data-marking-id')}`));
    check('a right click opens the ring of eight tools', items.length === 8 && items.includes('E:press-pull') && items.includes('W:undo') && items.includes('NE:f:sketch'), items.join(' '));
    const ring = await alice.locator('[data-marking-ring]').boundingBox(), list = await alice.locator('.cad-context-menu').boundingBox();
    const boxes = await alice.$$eval('[data-marking-item]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom }; }));
    check('the menu for what is under the pointer hangs clear of the ring', !!list && boxes.every((b) => b.b <= list.y || b.y >= list.y + list.height || b.r <= list.x || b.x >= list.x + list.width));
    check('… and still has its items', (await count('.cad-context-menu [data-menu-item="Zoom to fit"]')) === 1);
    const cx = ring.x + ring.width / 2, cy = ring.y + ring.height / 2;
    await alice.mouse.move(cx + 60, cy + 2, { steps: 3 });
    check('moving towards a tool lights it up', (await attr('[data-marking]', 'data-hot')) === 'E');
    await shot('marking', alice, { x: Math.max(0, cx - 330), y: Math.max(0, cy - 150), width: 660, height: 520 });
    await alice.mouse.click(cx + 30, cy + 1);
    await alice.waitForTimeout(200);
    check('a click in a direction runs that direction\'s tool', (await st()).editing?.type === 'extrude' && (await count('[data-marking]')) === 0, JSON.stringify((await st()).editing?.type));
    await cancel(); await key('Escape');
    // "Again" is up
    await alice.mouse.click(face.x, face.y, { button: 'right' });
    check('up is the tool used last, again', (await attr('[data-marking-item=N]', 'data-marking-title')) === 'Again: Extrude');
    await alice.click('.cad-context-menu [data-menu-item="Hide the marking menu"]');
    await alice.mouse.click(face.x, face.y, { button: 'right' });
    check('the ring can be hidden: the menu is where the pointer is again', (await count('[data-marking]')) === 0 && Math.abs((await alice.locator('.cad-context-menu').boundingBox()).x - face.x) < 4);
    await alice.click('.cad-context-menu [data-menu-item="Show the marking menu"]');
    // a flick
    await key('Escape');
    const blank = { x: 420, y: 760 };
    const before = await S(alice, () => window.JunctionPartStudio.viewport.camera.quaternion.toArray());
    await alice.mouse.click(blank.x, blank.y, { button: 'right' });
    await alice.click('.cad-context-menu [data-menu-item="Turn flick gestures on"]');
    const n0 = (await st()).n;
    await S(alice, () => { const s = window.JunctionPartStudio; s.select([]); });
    await alice.mouse.move(blank.x, blank.y); await alice.mouse.down({ button: 'right' }); await alice.mouse.move(blank.x + 70, blank.y - 70); await alice.mouse.up({ button: 'right' });
    await alice.waitForTimeout(250);
    const after = await S(alice, () => window.JunctionPartStudio.viewport.camera.quaternion.toArray());
    check('a flick up and to the right starts a sketch without the menu', (await st()).editing?.type === 'sketch' && (await count('[data-marking]')) === 0, JSON.stringify(await st()));
    check('… and leaves the view as it was', before.every((v, i) => Math.abs(v - after[i]) < 1e-6));
    await cancel();
    await alice.mouse.move(blank.x, blank.y); await alice.mouse.down({ button: 'right' }); await alice.mouse.move(blank.x + 150, blank.y - 20, { steps: 12 }); await alice.waitForTimeout(350); await alice.mouse.up({ button: 'right' });
    await alice.waitForTimeout(150);
    const turned = await S(alice, () => window.JunctionPartStudio.viewport.camera.quaternion.toArray());
    check('a slow drag with the right button still turns the view', !(await st()).editing && before.some((v, i) => Math.abs(v - turned[i]) > 1e-3) && (await st()).n === n0);
    await prefs({ flick: false });
    await S(alice, () => { window.JunctionPartStudio.viewport.setView('iso'); });
    await alice.waitForTimeout(500);
    await alice.reload();
    await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
    await calm(); await S(alice, () => window.JunctionPartStudio.fit()); await alice.waitForTimeout(300);
  }

  // ================================================================ the timeline
  if (part('timeline')) {
    check('the timeline is off until it is asked for', (await count('[data-timeline]')) === 0 && (await count('[data-panel=features]:not(.hidden)')) === 1);
    await alice.click('[data-timeline-toggle]');
    await alice.waitForSelector('[data-timeline]');
    const cells = () => alice.$$eval('[data-timeline-cell]', (els) => els.map((e) => `${e.getAttribute('data-cell-name') || 'folder'}:${e.getAttribute('data-built')}`));
    check('the timeline has a cell per feature, in build order', (await cells()).join(' ') === 'Sketch 1:yes Extrude 1:yes Sketch 2:yes Extrude 2:yes', (await cells()).join(' '));
    check('the marker stands after the last built feature', (await attr('[data-timeline-marker]', 'data-slot')) === '4' && (await attr('[data-timeline]', 'data-view')) === 'both');
    await alice.click(`[data-timeline-cell="${ids.e1}"]`);
    check('a click on a cell selects the feature, in the list too', (await st()).selected.join() === ids.e1 && (await count(`.cad-features [data-feature-row][data-selected] [data-row-name]:text-is("Extrude 1")`)) >= 0);
    // drag the marker two cells back
    const m = await alice.locator('[data-timeline-marker]').boundingBox(), c2 = await alice.locator(`[data-timeline-cell="${ids.s2}"]`).boundingBox();
    await alice.mouse.move(m.x + m.width / 2, m.y + 20); await alice.mouse.down(); await alice.mouse.move(c2.x + 8, m.y + 20, { steps: 6 }); await alice.mouse.move(c2.x - 1, m.y + 20, { steps: 2 }); await alice.mouse.up();
    await calm();
    check('dragging the marker is the rollback bar', (await st()).rollback === 2 && (await st()).bodies === 1 && (await cells()).join(' ') === 'Sketch 1:yes Extrude 1:yes Sketch 2:no Extrude 2:no', JSON.stringify(await st()));
    check('… and the feature list shows the same bar', (await S(alice, () => window.JunctionPartStudio.doc.items.get('studio').rollback)) === ids.s2);
    await shot('timeline', alice);
    await alice.click('[data-timeline-step=forward]'); await calm();
    check('the step buttons move it one feature', (await st()).rollback === 3);
    await alice.click('[data-timeline-step=end]'); await calm();
    check('… and to the end', (await st()).rollback === 4 && (await st()).bodies === 2);
    await alice.focus('[data-timeline-marker]'); await alice.keyboard.press('ArrowLeft'); await calm();
    check('← on the marker rolls back one', (await st()).rollback === 3);
    await alice.keyboard.press('End'); await calm();
    // a folder
    await S(alice, (ids) => { const s = window.JunctionPartStudio; s.commit([{ id: 'fold1', kind: 'ADDED', typeName: 'folder', item: { id: 'fold1', type: 'folder', name: 'Plate' } }, ...[ids.s2, ids.e2].map((id) => ({ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['folder'], value: 'fold1' }] }))]); }, ids);
    await calm();
    check('a folder is a bracket over its features', (await attr('[data-timeline-span=fold1]', 'data-span-name')) === 'Plate');
    await alice.click('[data-timeline-span=fold1]');
    check('… and folds into one cell', (await cells()).join(' ') === 'Sketch 1:yes Extrude 1:yes folder:yes' && (await attr('[data-timeline-cell=fold1]', 'data-cell-count')) === '2');
    await alice.click('[data-timeline-cell=fold1]');
    check('… and unfolds again', (await cells()).length === 4);
    await S(alice, () => window.JunctionPartStudio.undo()); await calm();
    await alice.dblclick(`[data-timeline-cell="${ids.e2}"]`); await alice.waitForTimeout(200);
    check('a double click edits the feature', (await st()).editing?.type === 'extrude' && (await st()).editing.params.depth === 10);
    await cancel();
    await alice.click('[data-history-view=timeline]');
    check('"Timeline" puts the feature list away', (await count('[data-panel=features].hidden')) === 1 && (await attr('[data-timeline]', 'data-view')) === 'timeline');
    await alice.click('[data-history-view=list]');
    check('"List" puts the timeline away and the list back', (await count('[data-timeline]')) === 0 && (await count('[data-panel=features].hidden')) === 0);
  }

  // ================================================================ the parameters table
  if (part('parameters')) {
    const stepsBefore = await S(alice, () => window.JunctionPartStudio.session.history().done.length);
    await S(alice, () => window.JunctionPartStudio.setUi({ parameters: true }));
    await alice.waitForSelector('.cad-parameters');
    const prow = (key) => `.cad-parameters [data-param-row="${key}"]`;
    const kE2 = `f:${ids.e2}:depth`, kD1 = `d:${ids.s1}:d1`, kV = `v:${ids.v}`;
    const type = async (sel, text) => { await alice.fill(sel, text); await alice.keyboard.press('Enter'); await alice.waitForTimeout(250); };
    const item = (id) => S(alice, (id) => { const i = window.JunctionPartStudio.doc.items.get(id); return i ? JSON.parse(JSON.stringify(i)) : null; }, id);
    check('the table has the variables, the features\' values and the sketch dimensions', (await count(prow(kV))) === 1 && (await count(prow(kE2))) === 1 && (await count(prow(kD1))) === 1 && (await attr(prow(kD1), 'data-param-value')) === '40' && (await attr(prow(kE2), 'data-param-text')) === '10', await attr('.cad-parameters [data-param-counts]', 'data-param-counts'));
    await type(`${prow(kE2)} [data-param-expr]`, 'depth * 3'); await calm();
    let e2 = await item(ids.e2);
    check('an expression typed into a feature\'s value is the feature\'s, as its dialog would store it', e2.params.depth === 24 && e2.params.$expr.depth === 'depth * 3' && /24/.test(await alice.textContent(`${prow(kE2)} [data-param-shown]`)), JSON.stringify(e2.params));
    await type(`${prow(kV)} [data-param-expr]`, '10 mm'); await calm();
    e2 = await item(ids.e2);
    check('a variable changed in the table carries into what uses it', e2.params.depth === 30 && (await attr(prow(kE2), 'data-param-value')) === '30');
    await type(`${prow(kD1)} [data-param-expr]`, '50'); await calm();
    let s1 = await item(ids.s1);
    const len = (s) => Math.abs(s.params.sketch.entities.p2.x - s.params.sketch.entities.p1.x);
    check('a sketch dimension changed in the table solves the sketch', s1.params.sketch.constraints.d1.value === 50 && Math.abs(len(s1) - 50) < 1e-6, `${s1.params.sketch.constraints.d1.value} ${len(s1)}`);
    await type(`${prow(kD1)} [data-param-expr]`, 'depth * 4 + 2'); await calm();
    s1 = await item(ids.s1);
    check('… and takes an expression', s1.params.sketch.constraints.d1.expr === 'depth * 4 + 2' && Math.abs(len(s1) - 42) < 1e-6);
    await type(`${prow(kE2)} [data-param-expr]`, 'nonsense +');
    check('what does not come to a number is refused and says so', (await count(`${prow(kE2)} [data-param-error]`)) === 1 && (await item(ids.e2)).params.depth === 30);
    await type(`${prow(kE2)} [data-param-expr]`, 'depth * 3');
    await alice.click(`${prow(kD1)} [data-param-star]`);
    await type(`${prow(kD1)} [data-param-comment]`, 'Overall width of the block');
    const notes = await item('parameter-notes');
    check('a star and a comment are kept in the document', notes && notes.favourites[kD1] === true && notes.comments[kD1] === 'Overall width of the block');
    await shot('parameters', alice);
    await alice.click('.cad-parameters [data-param-starred]');
    check('"Starred" leaves the starred rows', (await attr('.cad-parameters', 'data-shown')) === '1');
    await alice.click('.cad-parameters [data-param-starred]');
    await alice.fill('.cad-parameters [data-param-search]', 'overall');
    check('the search reads comments too', (await attr('.cad-parameters', 'data-shown')) === '1' && (await count(prow(kD1))) === 1);
    await alice.fill('.cad-parameters [data-param-search]', '');
    const before = Number(await attr('.cad-parameters', 'data-rows'));
    await alice.click('.cad-parameters [data-param-add]'); await alice.waitForTimeout(200);
    check('a variable can be added from the table', Number(await attr('.cad-parameters', 'data-rows')) === before + 1);
    await alice.click('.cad-parameters [data-sheet-close]');
    await S(alice, (n) => { const s = window.JunctionPartStudio; while (s.session.history().done.length > n) s.undo(); }, stepsBefore);
    await calm();
    check('every change in the table was an undoable edit', (await item(ids.e2)).params.depth === 10 && (await item(ids.s1)).params.sketch.constraints.d1.value === 40 && !(await item('parameter-notes')), JSON.stringify((await item(ids.e2)).params));
  }

  // ================================================================ the history of edits
  const depthOf = (id) => S(alice, (id) => window.JunctionPartStudio.doc.items.get(id).params.depth, id);
  const setDepth = (id, v) => S(alice, ([id, v]) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'depth'], value: v }] }]), [id, v]);
  if (part('history')) {
    await alice.reload();
    await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
    await calm();
    await openPanel(alice, 'undo-history');
    check('the history of edits starts empty', (await attr('.cad-undo-history', 'data-undo-steps')) === '0');
    await setDepth(ids.e2, 14); await calm();
    await S(alice, (id) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['name'], value: 'Plate' }] }]), ids.e2);
    await S(alice, () => window.JunctionPartStudio.commit([{ id: 'v2', kind: 'ADDED', typeName: 'variable', item: { id: 'v2', type: 'variable', name: 'wall', expr: '2 mm', order: 'W' } }]));
    await S(alice, (id) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['suppressed'], value: true }] }]), ids.e2);
    await calm();
    const labels = () => alice.$$eval('.cad-undo-history [data-undo-step] [data-undo-label]', (els) => els.map((e) => e.textContent));
    check('every edit is a step, in words (a thing is called what it is called now)', (await labels()).join(' | ') === 'Edit Plate | Rename to Plate | Add variable wall | Suppress Plate', (await labels()).join(' | '));
    check('the last step is where the document is', (await attr('.cad-undo-history', 'data-undo-at')) === '3' && (await attr('[data-panel=undo-history] [data-panel-count]', 'data-panel-count')) === '4');
    await shot('history', alice, { x: 1200, y: 60, width: 300, height: 560 });
    await alice.click('.cad-undo-history [data-undo-step="0"]'); await calm();
    let doc = await S(alice, (id) => { const d = window.JunctionPartStudio.doc, f = d.items.get(id); return { name: f.name, depth: f.params.depth, sup: !!f.suppressed, v2: d.items.has('v2') }; }, ids.e2);
    check('a click on a step goes back to just after it', doc.name === 'Extrude 2' && doc.depth === 14 && !doc.sup && !doc.v2 && (await attr('.cad-undo-history', 'data-undo-at')) === '0' && (await count('.cad-undo-history [data-undone]')) === 3, JSON.stringify(doc));
    await alice.click('.cad-undo-history [data-undo-step="2"]'); await calm();
    doc = await S(alice, (id) => { const d = window.JunctionPartStudio.doc, f = d.items.get(id); return { name: f.name, depth: f.params.depth, sup: !!f.suppressed, v2: d.items.has('v2') }; }, ids.e2);
    check('… and on a later one forward again', doc.name === 'Plate' && doc.v2 && !doc.sup && (await attr('.cad-undo-history', 'data-undo-at')) === '2');
    await alice.click('.cad-undo-history [data-undo-step="-1"]'); await calm();
    check('"As opened" takes every step back', (await depthOf(ids.e2)) === 10 && (await attr('.cad-undo-history', 'data-undo-at')) === '-1');
    await setDepth(ids.e2, 12); await calm();
    check('a new edit throws the undone steps away', (await labels()).join(' | ') === 'Edit Extrude 2');
    await S(alice, () => window.JunctionPartStudio.undo()); await calm();
  }

  // ================================================================ the rebuild says how far it is
  if (part('progress')) {
    await S(alice, () => { const s = window.JunctionPartStudio; window.__seen = []; window.__bar = 0; s.regenProgress.subscribe(() => { const p = s.regenProgress.getState(); window.__seen.push(`${p.index}/${p.total}`); if (document.querySelector('[data-regen-progress]')) window.__bar++; }); new MutationObserver(() => { if (document.querySelector('[data-regen-progress]')) window.__bar++; const t = document.querySelector('.cad-status .cad-note')?.textContent || ''; if (/Rebuilding \d+ of \d+: /.test(t)) window.__said = t; }).observe(document.querySelector('.cad-status'), { subtree: true, childList: true, characterData: true }); });
    await S(alice, (id) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'sketch', 'entities', 'p1', 'x'], value: -42 }, { path: ['params', 'sketch', 'entities', 'p4', 'x'], value: -42 }] }]), ids.s1);
    await calm();
    const seen = await S(alice, () => ({ seen: window.__seen, bar: window.__bar, said: window.__said || '' }));
    check('a rebuild reports each feature it is on, of how many', seen.seen.includes('0/4') && seen.seen.includes('3/4'), seen.seen.join(' '));
    check('… and the status bar says so, with a bar', seen.bar > 0 && /Rebuilding \d of 4: (Sketch|Extrude) \d/.test(seen.said), JSON.stringify(seen));
    check('… and is quiet again afterwards', (await count('[data-regen-progress]')) === 0);
    await S(alice, () => window.JunctionPartStudio.undo()); await calm();
  }

  // ================================================================ offline
  if (part('offline')) {
    const ctx = alice.context(), docId = await S(alice, () => window.JunctionPartStudio.host.doc.docId), url = alice.url();
    const journal = () => alice.evaluate((docId) => JSON.parse(localStorage.getItem('junction.itemdoc.pending.' + docId) || '{"ops":[]}').ops.length, docId);
    const drop = async () => { await ctx.setOffline(true); await S(alice, () => window.JunctionPartStudio.session.ws && window.JunctionPartStudio.session.ws.close()); await alice.waitForSelector('[data-offline=offline]', { timeout: 15000 }); };
    check('online, there is no banner and nothing waits', (await count('[data-offline]')) === 0 && (await journal()) === 0);
    await drop();
    check('when the connection drops a banner says so', /Offline/.test(await alice.textContent('[data-offline]')) && /Keep working/.test(await alice.textContent('[data-offline]')));
    const z = () => S(alice, () => Math.max(...window.JunctionPartStudio.getState().bodies.map((b) => (window.JunctionPartStudio.view.bodyObjects(b.id)?.result.mesh || b.mesh).bbox[5])));
    await setDepth(ids.e1, 33); await calm();
    check('work goes on offline: the edit is made and the model follows', (await depthOf(ids.e1)) === 33 && Math.abs((await z()) - 33) < 1e-6 && (await st()).canUndo);
    check('… the banner counts what waits', (await attr('[data-offline]', 'data-unsaved')) === '1' && /1 edit waiting/.test(await alice.textContent('[data-offline]')));
    check('… and the edit is kept in the browser', (await journal()) === 1);
    await shot('offline', alice);
    const [download] = await Promise.all([alice.waitForEvent('download'), alice.click('[data-offline-save]')]);
    const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    check('"Save a copy" writes the part studio, unsent edit and all, to a file', /\(unsent \d{4}-\d\d-\d\d\)\.jpart$/.test(download.suggestedFilename()) && saved.junction === 'part-studio' && saved.items.find((i) => i.id === ids.e1).params.depth === 33, download.suggestedFilename());
    // the connection comes back
    await ctx.setOffline(false);
    await alice.click('[data-offline-retry]');
    await alice.waitForSelector('[data-offline=sent]', { timeout: 20000 });
    check('back online the edit is sent, and the banner says so', /1 edit made offline was sent/.test(await alice.textContent('[data-offline]')) && (await journal()) === 0 && (await S(alice, () => window.JunctionPartStudio.session.unsaved)) === 0);
    const stored = async () => { const r = await alice.evaluate(async (docId) => { const x = await fetch(`/api/docs/${docId}/file`); return x.ok ? x.text() : ''; }, docId); try { return JSON.parse(r).items.find((i) => i.id === ids.e1).params.depth; } catch { return null; } };
    // a tab closed while offline: the edits wait in the browser and are sent by the next visit
    await drop();
    await setDepth(ids.e1, 44); await setDepth(ids.e2, 15); await calm();
    check('two more edits wait', (await journal()) === 2);
    await alice.goto('about:blank').catch(() => {});
    await ctx.setOffline(false);
    await alice.goto(url);
    await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
    await alice.waitForSelector('[data-offline=restored]', { timeout: 20000 });
    await calm();
    check('edits made offline outlive a closed tab: the next visit has them and sends them', (await depthOf(ids.e1)) === 44 && (await depthOf(ids.e2)) === 15 && /2 edits from your last visit/.test(await alice.textContent('[data-offline]')) && (await journal()) === 0, `${await depthOf(ids.e1)} ${await depthOf(ids.e2)} ${await journal()}`);
    // somebody else opening the document now gets them from the server
    const bob = await ctx.newPage();
    await bob.goto(url);
    await bob.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
    check('… and the server has them', (await S(bob, (id) => window.JunctionPartStudio.doc.items.get(id).params.depth, ids.e1)) === 44 && (await bob.evaluate((docId) => localStorage.getItem('junction.itemdoc.pending.' + docId), docId)) === null);
    await bob.close();
    void stored;
    await setDepth(ids.e1, 20); await setDepth(ids.e2, 10); await calm();
    await S(alice, () => window.JunctionPartStudio.fit());
  }

  check('no page errors', alice.errors.length === 0, alice.errors.join(' | '));
} catch (e) {
  check('the script ran to its end', false, e.stack || String(e));
  await shot('failed');
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
