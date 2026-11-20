// Browser test of the default planes and the view cube of a part studio, as Onshape has them:
//
//   planes     a new part studio opens in the isometric view with Top, Front and Right filling the middle of the
//              viewport; each carries its name painted on it; the plane under the pointer gets an orange
//              outline and nothing else; a corner of a plane, near enough, is a handle: dragging it resizes the
//              plane about the origin; the size is the document's (undone and redone like an edit, kept over a
//              reload, seen by a second person) and a resized plane no longer grows with the model
//   view cube  a face, an edge and a corner turn the view to look from there; the triangles turn it 90°, the
//              curved arrows roll it 90°; the ▼ menu has the standard views, zoom to fit and the projection; the
//              region under the pointer lights up; the triad is drawn over the cube
//
// Setup as the other cad-*-ui.mjs scripts (see cad-ui.mjs): a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-planes-ui.mjs
//
// With SHOTS it saves planes-default, planes-hover, planes-resized, viewcube-light and viewcube-dark (and the
// same in dark) there.
import fs from 'node:fs';
import { viewFrom, viewMenu } from './cad-chrome.mjs';
import { BASE, S, focusViewport, launch, newPartStudio, screenOf, signedIn, user, viewDir, viewStill } from './cad-ux-lib.mjs';

const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180 / Math.PI;
const SIZE = { width: 1350, height: 1250 };

const browser = await launch();
const aliceId = user('cad-planes-alice', 991301), bobId = user('cad-planes-bob', 991302);
const alice = await signedIn(browser, aliceId, 'cad-planes-alice', SIZE);
const shot = async (name, p = alice, clip) => { if (SHOTS) { await p.waitForTimeout(350); await p.screenshot({ path: `${SHOTS}/${name}.png`, clip }); } };
const outline = (p, id) => S(p, (id) => window.JunctionPartStudio.view.planeLayer.outlineOf(id), id);
const half = (p, id) => S(p, (id) => window.JunctionPartStudio.view.planeLayer.halfOf(id)[0], id);
const sizes = (p) => S(p, () => JSON.parse(JSON.stringify(window.JunctionPartStudio.doc.items.get('studio').planeSizes || {})));
const pickAt = (p, at) => S(p, (at) => { const v = window.JunctionPartStudio.view.pick({ clientX: at.x, clientY: at.y }); return v ? v.kind + ':' + (v.plane || '') : null; }, at);
const upDir = (p) => S(p, () => { const st = window.JunctionPartStudio, v = st.viewport.target.clone().set(0, 1, 0).applyQuaternion(st.viewport.camera.quaternion); return [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000); });
const cubeBox = (p) => p.$eval('.cad-viewcube', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });

try {
  // ================================================================ a new part studio, as Onshape opens one
  const pid = await newPartStudio(alice, 'CAD planes test');
  await alice.evaluate(async ({ pid }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cad-planes-bob', role: 'editor' }) })).status, { pid });
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 90000 });
  await alice.mouse.move(5, SIZE.height - 5);
  await alice.waitForTimeout(300);
  const iso = await viewDir(alice);
  check('a new part studio opens in the isometric view (from +X −Y +Z)', near(iso[0], -0.577, 0.01) && near(iso[1], 0.577, 0.01) && near(iso[2], -0.577, 0.01), iso.join());
  const shown = await S(alice, () => window.JunctionPartStudio.view.planeLayer.labelInfo().filter((l) => l.shown && l.opacity > 0.5).map((l) => l.text).sort().join());
  check('Top, Front and Right carry their names', shown === 'Front,Right,Top', shown);
  // the three fill the middle of the view: the box of their corners on screen against the canvas
  const fill = await S(alice, () => {
    const st = window.JunctionPartStudio, h = st.view.planeLayer.halfOf('top')[0], pts = [];
    for (const a of [-h, h]) for (const b of [-h, h]) pts.push([a, b, 0], [a, 0, b], [0, a, b]);
    const s = pts.map((p) => st.viewport.project(st.viewport.target.clone().set(...p)));
    const xs = s.map((q) => q.x), ys = s.map((q) => q.y);
    return { w: (Math.max(...xs) - Math.min(...xs)) / st.viewport.width, h: (Math.max(...ys) - Math.min(...ys)) / st.viewport.height, cx: (Math.max(...xs) + Math.min(...xs)) / 2 / st.viewport.width, cy: (Math.max(...ys) + Math.min(...ys)) / 2 / st.viewport.height };
  });
  check('the planes fill about the middle two thirds of the view', Math.max(fill.w, fill.h) > 0.55 && Math.max(fill.w, fill.h) < 0.8 && near(fill.cx, 0.5, 0.05) && near(fill.cy, 0.5, 0.05), JSON.stringify(fill));
  const rest = await outline(alice, 'top');
  check('a plane has a thin pale blue outline', rest.color === '#a9bcdc' && rest.width <= 2, JSON.stringify(rest));
  await shot('planes-default');

  // ================================================================ the plane under the pointer
  const onTop = await screenOf(alice, [12, -12, 0]);
  check('a point of Top in front of the others picks Top', (await pickAt(alice, onTop)) === 'plane:top');
  await alice.mouse.move(onTop.x, onTop.y, { steps: 3 });
  await alice.waitForTimeout(120);
  const over = await outline(alice, 'top'), others = [await outline(alice, 'front'), await outline(alice, 'right')];
  check('the plane under the pointer gets an orange outline, a little heavier', over.color === '#f0b97a' && over.width > rest.width, JSON.stringify(over));
  check('… and the others stay as they were', others.every((o) => o.color === rest.color && o.width === rest.width), JSON.stringify(others));
  await shot('planes-hover');

  // ================================================================ a corner is a handle
  const h0 = await half(alice, 'top');
  const corner = await screenOf(alice, [h0, -h0, 0]);
  await alice.mouse.move(corner.x + 3, corner.y - 2, { steps: 3 });
  await alice.waitForTimeout(100);
  const handle = await S(alice, () => ({ corner: window.JunctionPartStudio.viewport.canvas.dataset.planeCorner, cursor: window.JunctionPartStudio.viewport.canvas.style.cursor }));
  check('near a corner of a plane the pointer takes hold of it: a resize cursor', handle.corner === 'top:1:-1' && /resize/.test(handle.cursor), JSON.stringify(handle));
  const to = await screenOf(alice, [h0 * 1.4, -h0 * 1.4, 0]);
  await alice.mouse.down();
  await alice.mouse.move((corner.x + to.x) / 2, (corner.y + to.y) / 2, { steps: 4 });
  const mid = await half(alice, 'top');
  check('dragging the corner resizes the plane as it goes', mid > h0 * 1.1 && mid < h0 * 1.5 && (await sizes(alice)).top === undefined, `${h0} → ${mid}`);
  await alice.mouse.move(to.x, to.y, { steps: 4 });
  await alice.mouse.up();
  await alice.waitForTimeout(150);
  const h1 = await half(alice, 'top'), stored = await sizes(alice);
  check('let go, the plane keeps its new size, centred on the origin, square', near(h1, h0 * 1.4, 0.5) && near(stored.top, 2 * h1, 0.02), `${h0} → ${h1}; stored ${JSON.stringify(stored)}`);
  check('… the other planes are not resized, and nothing was selected', (await half(alice, 'front')) === h0 && (await half(alice, 'right')) === h0 && Object.keys(stored).join() === 'top' && (await S(alice, () => window.JunctionPartStudio.getState().selection.length)) === 0);
  // the pointer back on the new corner: its handle and the orange outline
  await alice.mouse.move(to.x + 2, to.y - 1, { steps: 3 });
  await shot('planes-resized');
  // undo and redo
  await focusViewport(alice);
  await alice.keyboard.press('Control+z');
  await alice.waitForTimeout(150);
  check('Ctrl+Z gives the plane its size back', (await half(alice, 'top')) === h0 && (await sizes(alice)).top === undefined);
  await alice.keyboard.press('Control+y');
  await alice.waitForTimeout(150);
  check('… and Ctrl+Y resizes it again', near(await half(alice, 'top'), h1, 0.02));
  // a drag on the plane, away from its corners, is a selection box as before
  const inside = await screenOf(alice, [h1 * 0.4, -h1 * 0.4, 0]);
  await alice.mouse.click(inside.x, inside.y);
  check('a click inside a plane still selects it', await S(alice, () => { const s = window.JunctionPartStudio.getState().selection; return s.length === 1 && s[0].kind === 'plane' && s[0].plane === 'top'; }));
  await alice.keyboard.press('Escape');

  // ================================================================ kept, and shared
  await alice.waitForFunction(() => window.JunctionPartStudio.session.unsaved === 0, null, { timeout: 15000 });
  const url = alice.url();
  await alice.reload();
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  await alice.waitForTimeout(200);
  check('the size is kept over a reload', near(await half(alice, 'top'), h1, 0.02) && (await half(alice, 'front')) === h0);
  const bob = await signedIn(browser, bobId, 'cad-planes-bob', SIZE);
  await bob.goto(url);
  await bob.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  await bob.waitForTimeout(200);
  check('a second person sees the plane at its size', near(await half(bob, 'top'), h1, 0.02));
  // Bob resizes Right while Alice looks
  await bob.waitForFunction(() => window.JunctionPartStudio.getState().canEdit, null, { timeout: 15000 });
  await bob.mouse.move(5, 5);
  const rc = await screenOf(bob, [0, h0, h0]), rto = await screenOf(bob, [0, h0 * 0.6, h0 * 0.6]);
  await bob.mouse.move(rc.x - 2, rc.y + 2, { steps: 3 });
  await bob.mouse.down();
  await bob.mouse.move(rto.x, rto.y, { steps: 5 });
  await bob.mouse.up();
  const bobRight = await half(bob, 'right');
  check('the second person shrinks Right by its corner', near(bobRight, h0 * 0.6, 0.5), `${h0} → ${bobRight}`);
  await alice.waitForFunction((h) => Math.abs(window.JunctionPartStudio.view.planeLayer.halfOf('right')[0] - h) < 0.02, bobRight, { timeout: 15000 }).catch(() => {});
  check('… and the first sees it at once', near(await half(alice, 'right'), bobRight, 0.02) && near(await half(alice, 'top'), h1, 0.02));
  await bob.context().close();

  // ================================================================ a resized plane no longer grows with the model
  await S(alice, () => {
    const st = window.JunctionPartStudio, id = () => crypto.randomUUID(), s = id(), e = id();
    const pts = [[-90, -60], [90, -60], [90, 60], [-90, 60]], ent = {};
    pts.forEach(([x, y], i) => { ent['p' + i] = { type: 'point', x, y }; });
    pts.forEach((_, i) => { ent['l' + i] = { type: 'line', a: 'p' + i, b: 'p' + ((i + 1) % 4) }; });
    const feat = (id, featureType, name, order, params) => ({ id, kind: 'ADDED', typeName: 'feature', item: { id, type: 'feature', featureType, name, order, params } });
    st.commit([feat(s, 'sketch', 'Sketch 1', 'F', { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities: ent, constraints: {} } }), feat(e, 'extrude', 'Extrude 1', 'K', { profile: { sketch: s, regions: null }, operation: 'new', endType: 'blind', depth: 20, flip: false, targets: [] })]);
  });
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().bodies.length === 1, null, { timeout: 90000 });
  await alice.waitForTimeout(200);
  check('a plane nobody resized grows past a large model', (await half(alice, 'front')) >= 90 * 1.2 - 0.01, String(await half(alice, 'front')));
  check('… a resized one keeps its size', near(await half(alice, 'top'), h1, 0.02) && near(await half(alice, 'right'), bobRight, 0.02));

  // ================================================================ the view cube
  await viewFrom(alice, 'iso'); await viewStill(alice);
  const cube = await cubeBox(alice), canvas = await alice.$eval('.cad-stage canvas', (c) => { const r = c.getBoundingClientRect(); return { right: r.right, top: r.top }; });
  check('the view cube is in the top right corner, about 180 px square', near(cube.x + cube.width, canvas.right, 12) && near(cube.y, canvas.top, 12) && near(cube.width, 184, 20) && near(cube.height, 184, 20), JSON.stringify(cube));
  check('it has 6 faces, 12 edges and 8 corners, and a triad', await alice.locator('.cad-viewcube [data-region=face]').count() === 6 && await alice.locator('.cad-viewcube [data-region=edge]').count() === 12 && await alice.locator('.cad-viewcube [data-region=corner]').count() === 8 && await alice.locator('.cad-viewcube [data-triad] text').count() === 3);
  // the region under the pointer lights up
  const frontFace = alice.locator('.cad-viewcube [data-face=front]');
  const bg = () => frontFace.evaluate((e) => e.style.background);
  const before = await bg();
  await frontFace.hover();
  check('the face under the pointer lights up', (await bg()) !== before, `${before} → ${await bg()}`);
  await alice.mouse.move(cube.x - 100, cube.y + 300);
  await shot('viewcube-light', alice, { x: cube.x - 16, y: cube.y - 8, width: cube.width + 24, height: cube.height + 24 });
  await frontFace.click(); await viewStill(alice);
  check('a click on Front looks from the front (−Y), Z up', (await viewDir(alice)).join() === '0,1,0' && (await upDir(alice)).join() === '0,0,1', (await viewDir(alice)).join());
  await viewFrom(alice, 'iso'); await viewStill(alice);
  // an edge and a corner that face the camera in the isometric view
  await alice.click('.cad-viewcube [data-from="1,0,1"]'); await viewStill(alice);
  const e = await viewDir(alice);
  check('a click on an edge looks from between its two faces', near(e[0], -0.707, 0.01) && near(e[1], 0, 0.01) && near(e[2], -0.707, 0.01), e.join());
  await alice.click('.cad-viewcube [data-from="1,-1,1"]'); await viewStill(alice);
  const c = await viewDir(alice);
  check('a click on a corner looks from that corner: the isometric view', near(c[0], -0.577, 0.01) && near(c[1], 0.577, 0.01) && near(c[2], -0.577, 0.01), c.join());
  // the arrows: 90° at a time
  await alice.click('.cad-viewcube [data-face=front]'); await viewStill(alice);
  await alice.click('.cad-viewcube [data-turn="Turn up"]'); await viewStill(alice);
  const up = await viewDir(alice);
  check('from the front, the triangle above the cube turns the view 90° to look from the top', up.join() === '0,0,-1', up.join());
  await alice.click('.cad-viewcube [data-turn="Turn down"]'); await viewStill(alice);
  check('… the one below turns it back', (await viewDir(alice)).join() === '0,1,0', (await viewDir(alice)).join());
  await alice.click('.cad-viewcube [data-turn="Turn right"]'); await viewStill(alice);
  const right = await viewDir(alice);
  check('the triangle to the right turns the view 90° about the vertical', near(angle(right, [0, 1, 0]), 90, 1) && near(right[2], 0, 0.01), right.join());
  await alice.click('.cad-viewcube [data-turn="Turn left"]'); await viewStill(alice);
  check('… the one to the left turns it back', (await viewDir(alice)).join() === '0,1,0', (await viewDir(alice)).join());
  await alice.click('.cad-viewcube [data-turn="Roll left"]'); await viewStill(alice);
  const rolled = await upDir(alice);
  check('the curved arrow at the top left rolls the view 90° counter-clockwise: +X is up', (await viewDir(alice)).join() === '0,1,0' && rolled.join() === '1,0,0', rolled.join());
  await alice.click('.cad-viewcube [data-turn="Roll right"]'); await viewStill(alice);
  check('… the one at the top right rolls it back', (await upDir(alice)).join() === '0,0,1', (await upDir(alice)).join());
  // the menu
  await alice.click('.cad-viewcube [data-view-menu]');
  const items = await alice.$$eval('.cad-view-menu [data-view-item]', (els) => els.map((e) => e.getAttribute('data-view-item')));
  check('the menu has the standard views, zoom to fit and the projection', ['std-iso', 'std-front', 'std-back', 'std-left', 'std-right', 'std-top', 'std-bottom', 'fit', 'Perspective', 'Orthographic'].every((i) => items.includes(i)), items.join(' '));
  await alice.click('.cad-view-menu [data-view-item=std-top]'); await viewStill(alice);
  check('Top from the menu looks from above, +Y up', (await viewDir(alice)).join() === '0,0,-1' && (await upDir(alice)).join() === '0,1,0');
  await viewMenu(alice, 'std-iso'); await viewStill(alice);
  check('Isometric from the menu', (await viewDir(alice)).join() === '-0.577,0.577,-0.577', (await viewDir(alice)).join());
  await viewMenu(alice, 'Perspective');
  check('Perspective from the menu', (await alice.getAttribute('.cad-viewcube', 'data-projection')) === 'perspective');
  await viewMenu(alice, 'Orthographic');
  const zoom0 = await S(alice, () => window.JunctionPartStudio.viewport.camera.zoom);
  await S(alice, () => { const v = window.JunctionPartStudio.viewport; v.camera.zoom *= 3; v.camera.updateProjectionMatrix(); v.invalidate(); });
  await viewMenu(alice, 'fit');
  check('Zoom to fit from the menu', near(await S(alice, () => window.JunctionPartStudio.viewport.camera.zoom), zoom0, zoom0 * 0.05));
  check('no script errors', alice.errors.length === 0, alice.errors.join(' | '));

  // ================================================================ dark
  {
    const p = await signedIn(browser, aliceId, 'cad-planes-alice', { ...SIZE, dark: true });
    await p.goto(url);
    await p.waitForFunction(() => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.bodies.length === 1; }, null, { timeout: 90000 });
    await p.mouse.move(5, SIZE.height - 5);
    const dark = await outline(p, 'front');
    check('dark: the planes have their dark outline', dark.color !== '#a9bcdc', JSON.stringify(dark));
    await shot('planes-dark', p);
    const cb = await cubeBox(p);
    await shot('viewcube-dark', p, { x: cb.x - 16, y: cb.y - 8, width: cb.width + 24, height: cb.height + 24 });
    check('dark: no script errors', p.errors.length === 0, p.errors.join(' | '));
    await p.context().close();
  }
} catch (e) {
  check('the run reached its end', false, String(e && e.stack || e));
}
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
process.exit(fail ? 1 : 0);
