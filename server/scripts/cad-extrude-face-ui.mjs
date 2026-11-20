// Browser test of a face used as a profile, in the real app: with Extrude open a click on a flat face of a part
// makes it the profile (the top of a box, added; a side of it, removed, which goes into the part); a face
// selected beforehand is the profile when Shift+E starts the tool; a sketch that the tool only guessed gives
// way to the face that is clicked, and a sketch drawn on a face is still picked before the face under it.
//
// Setup as the other cad-*-ui.mjs scripts (scripts/cad-ux-lib.mjs): a server with KC_DEV_LOGIN=1 on a throwaway
// database, Playwright, psql on the PATH.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] [SHOT_SCALE=2] node scripts/cad-extrude-face-ui.mjs
import fs from 'node:fs';
import { S, click, focusViewport, launch, newPartStudio, previewed, screenOf, settled, signedIn, sketchPoint, state, user, viewStill } from './cad-ux-lib.mjs';

const SHOTS = process.env.SHOTS || '', PREFIX = process.env.SHOT_PREFIX || 'exface-';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const browser = await launch();
// screenshots at the device's pixel ratio asked for (2 for a sharp picture)
const scaled = { newContext: (o) => browser.newContext({ ...o, deviceScaleFactor: Number(process.env.SHOT_SCALE || 1) }) };
const uid = user('cad-exface-alice', 990951);
const page = await signedIn(scaled, uid, 'cad-exface-alice');
const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(350); await page.screenshot({ path: `${SHOTS}/${PREFIX}${name}.png` }); } };
const st = () => state(page);
const key = async (k) => { await focusViewport(page); await page.keyboard.press(k); await page.waitForTimeout(80); };
const round = (a) => a.map((v) => Math.round(v * 1000) / 1000);
/** The boxes round the parts as the model on screen has them (the preview while a dialog is open). */
const boxes = () => S(page, () => window.JunctionPartStudio.getState().bodies.filter((b) => b.mesh && !b.sheet).map((b) => Array.from(b.mesh.bbox)));
/** The flat face of a part that lies in the plane `axis` = `value` (0: x, 1: y, 2: z), with a point inside it on screen. */
const faceAt = (axis, value) => S(page, ([axis, value]) => {
  const stu = window.JunctionPartStudio, s = stu.getState(), c = stu.viewport.canvas.getBoundingClientRect();
  for (const b of s.bodies) {
    const m = b.mesh; if (!m) continue;
    for (let i = 0; i < m.faces.names.length; i++) {
      let on = m.faces.count[i] > 0, best = null, area = -1;
      for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
        const v = [0, 1, 2].map((k) => { const j = m.indices[t + k] * 3; return [m.positions[j], m.positions[j + 1], m.positions[j + 2]]; });
        if (v.some((p) => Math.abs(p[axis] - value) > 1e-6)) { on = false; break; }
        const u = v[1].map((x, k) => x - v[0][k]), w = v[2].map((x, k) => x - v[0][k]);
        const a = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
        if (a > area) { area = a; best = [0, 1, 2].map((k) => (v[0][k] + v[1][k] + v[2][k]) / 3); }
      }
      if (!on || !best) continue;
      const q = stu.viewport.project(stu.viewport.target.clone().set(best[0], best[1], best[2]));
      return { name: m.faces.names[i], body: b.id, x: c.left + q.x, y: c.top + q.y };
    }
  }
  return null;
}, [axis, value]);
const profile = async () => (await st()).editing?.params.profile || null;
const choose = (param, label) => page.click(`.cad-dialog [data-param=${param}] button:text-is("${label}")`);
const heldFaces = () => page.$$eval('.cad-dialog [data-param="profile.faces"] [data-held]', (els) => els.map((e) => e.textContent.replace('×', '').trim()));
const accept = async (n) => { await page.keyboard.press('Enter'); await settled(page, n); };
/** Look at the model from the front, the right and above, all of it in view. */
const iso = async () => { await key('Shift+7'); await viewStill(page); await key('f'); await viewStill(page); };

try {
  // ---------------------------------------------------------------- a 40 × 20 × 10 box, drawn and extruded
  await newPartStudio(page, 'Extrude a face');
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-dialog[data-feature=sketch] [data-sketch-plane][data-armed]');
  await page.click('.cad-features [data-default-geometry=top]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready, null, { timeout: 90000 });
  await viewStill(page);
  await page.click('.cad-toolbar [data-tool=Rectangle]');
  await click(page, await sketchPoint(page, 0, 0));
  await click(page, await sketchPoint(page, 40, 20));
  await key('Escape');
  await key('Shift+E');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await previewed(page);
  await accept(2);
  await iso();
  const box0 = (await boxes())[0];
  check('a box to work on: 40 × 20 × 10', !!box0 && round(box0).join() === '0,0,0,40,20,10', JSON.stringify(box0 && round(box0)));

  // ---------------------------------------------------------------- Extrude open, click the top face: Add
  await page.click('.cad-toolbar [data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  let e = (await st()).editing;
  check('Extrude with nothing to guess opens with its profile empty and listening', e.params.profile === null && e.field === 'profile', JSON.stringify({ profile: e.params.profile, field: e.field }));
  check('… and the viewport offers sketches and faces', (await S(page, () => window.JunctionPartStudio.pickFilter())).join() === 'sketch,face');
  const topFace = await faceAt(2, 10);
  await page.mouse.move(topFace.x, topFace.y, { steps: 3 });
  await page.waitForTimeout(120);
  const hover = await S(page, () => window.JunctionPartStudio.getState().hover);
  check('the face under the pointer is what a click will take', !!hover && hover.kind === 'face' && hover.name === topFace.name, JSON.stringify(hover));
  await click(page, topFace);
  let p = await profile();
  check('a click on the top face makes it the profile, as a stable reference', !!p && p.sketch === null && p.faces?.length === 1 && p.faces[0].kind === 'face' && p.faces[0].name === topFace.name && p.faces[0].body === topFace.body, JSON.stringify(p));
  check('the dialog lists the face', (await heldFaces()).join() === 'Face 1 of Part 1', (await heldFaces()).join());
  await choose('operation', 'Add');
  await page.fill('.cad-dialog [data-param=depth]', '5');
  await previewed(page);
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.length === 1 && s.bodies[0].mesh && Math.abs(s.bodies[0].mesh.bbox[5] - 15) < 1e-6; }, null, { timeout: 60000 }).catch(() => null);
  check('the preview follows: the box is 15 high', round((await boxes())[0]).join() === '0,0,0,40,20,15', JSON.stringify(await boxes()));
  // the face is inside the part now, so it is drawn from what it was before the feature, and stays chosen
  await page.waitForFunction((f) => window.JunctionPartStudio.view.hasGeometry({ kind: 'face', body: f.body, name: f.name, point: [0, 0, 0] }), topFace, { timeout: 15000 }).catch(() => null);
  check('the face the feature swallowed is still drawn as chosen', await S(page, (f) => window.JunctionPartStudio.view.hasGeometry({ kind: 'face', body: f.body, name: f.name, point: [0, 0, 0] }), topFace));
  await shot('01-top-face-add-preview');
  await accept(3);
  check('accepted: one part, 40 × 20 × 15', (await boxes()).length === 1 && round((await boxes())[0]).join() === '0,0,0,40,20,15' && (await st()).features[2].params.profile.faces.length === 1);

  // ---------------------------------------------------------------- a side face: Remove goes into the part
  await iso();
  await page.click('.cad-toolbar [data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  const side = await faceAt(0, 40);
  await click(page, side);
  p = await profile();
  check('a click on a side face makes it the profile', !!p && p.sketch === null && p.faces?.length === 1 && p.faces[0].name === side.name, JSON.stringify(p));
  await choose('operation', 'Remove');
  await page.fill('.cad-dialog [data-param=depth]', '3');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.length === 1 && s.bodies[0].mesh && Math.abs(s.bodies[0].mesh.bbox[3] - 37) < 1e-6; }, null, { timeout: 60000 }).catch(() => null);
  const report = await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.reports[s.editing.draft.id]; });
  check('Remove takes material from behind the face without flipping anything', round((await boxes())[0]).join() === '0,0,0,37,20,15' && report.status === 'ok', JSON.stringify([await boxes(), report]));
  await shot('02-side-face-remove-preview');
  // a second face joins the first; a click on one it holds takes it out
  const front = await faceAt(1, 0);
  await click(page, front);
  check('another face is added to the profile', (await profile()).faces.length === 2 && (await heldFaces()).length === 2, JSON.stringify(await profile()));
  await page.click('.cad-dialog [data-param="profile.faces"] [data-held]:nth-child(2) [data-held-remove]');
  check('× takes one face out again', (await profile()).faces.length === 1 && (await profile()).faces[0].name === side.name, JSON.stringify(await profile()));
  await accept(4);
  check('accepted: the part is 37 long', round((await boxes())[0]).join() === '0,0,0,37,20,15');

  // ---------------------------------------------------------------- select a face first, then Shift+E
  await iso();
  const top2 = await faceAt(2, 15);
  await click(page, top2);
  check('the top face is selected', (await st()).selection === 1);
  await key('Shift+E');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  p = await profile();
  check('Shift+E with a face selected extrudes that face', !!p && p.sketch === null && p.faces?.length === 1 && p.faces[0].name === top2.name, JSON.stringify(p));
  await page.fill('.cad-dialog [data-param=depth]', '4');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.length === 2 && s.bodies.every((b) => b.mesh) && Math.abs(s.bodies[1].mesh.bbox[5] - 19) < 1e-6; }, null, { timeout: 60000 }).catch(() => null);
  const two = (await boxes()).map(round);
  check('New makes a second part standing on the face', two.length === 2 && two[1].join() === '0,0,15,37,20,19', JSON.stringify(two));
  await shot('03-preselected-face-new-preview');
  await accept(5);
  check('accepted: two parts', (await boxes()).length === 2);
  await key('Control+z');
  await settled(page, 4);
  check('undo takes the feature away again', (await boxes()).length === 1);

  // ---------------------------------------------------------------- a sketch on a face, and a face, together
  await iso();
  await click(page, await faceAt(2, 15));
  await page.click('.cad-toolbar [data-tool=Sketch]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready, null, { timeout: 90000 });
  await viewStill(page);
  await page.click('.cad-toolbar [data-tool=Rectangle]');
  await click(page, await screenOf(page, [8, 5, 15]));
  await click(page, await screenOf(page, [20, 15, 15]));
  await key('Escape');
  await page.click('.cad-toolbar [data-tool="Finish sketch"]');
  await settled(page, 5);
  await iso();
  const sketchId = (await st()).features[4].id;
  await page.click('.cad-toolbar [data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  p = await profile();
  check('Extrude guesses the sketch nothing uses yet', !!p && p.sketch === sketchId && !p.faces, JSON.stringify(p));
  // a face clicked replaces the sketch nobody chose
  const side2 = await faceAt(0, 37);
  await click(page, side2);
  p = await profile();
  check('a face clicked replaces the guessed sketch', !!p && p.sketch === null && p.faces?.length === 1 && p.faces[0].name === side2.name, JSON.stringify(p));
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.length === 2 && s.bodies.every((b) => b.mesh); }, null, { timeout: 60000 }).catch(() => null);
  // the region drawn on the top face is picked before the face it lies on
  const inRegion = await screenOf(page, [14, 10, 15]);
  await page.mouse.move(inRegion.x, inRegion.y, { steps: 3 });
  await page.waitForTimeout(120);
  const overRegion = await S(page, () => window.JunctionPartStudio.getState().hover);
  check('the sketch region on a face is picked before the face', !!overRegion && overRegion.kind === 'sketch' && overRegion.featureId === sketchId, JSON.stringify(overRegion));
  // … while the face beside the region is still the face
  const beside = await screenOf(page, [30, 10, 15]);
  await page.mouse.move(beside.x, beside.y, { steps: 3 });
  await page.waitForTimeout(120);
  const overFace = await S(page, () => window.JunctionPartStudio.getState().hover);
  check('… and the face beside the region is still the face', !!overFace && overFace.kind === 'face', JSON.stringify(overFace));
  await click(page, inRegion);
  p = await profile();
  check('the sketch clicked after it joins the face in one profile', !!p && p.sketch === sketchId && p.faces?.length === 1, JSON.stringify(p));
  await choose('operation', 'Add');
  await page.fill('.cad-dialog [data-param=depth]', '2');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.length === 1 && s.bodies[0].mesh && Math.abs(s.bodies[0].mesh.bbox[3] - 39) < 1e-6 && Math.abs(s.bodies[0].mesh.bbox[5] - 17) < 1e-6; }, null, { timeout: 60000 }).catch(() => null);
  check('each goes along its own normal: the boss up, the side out', round((await boxes())[0]).join() === '0,0,0,39,20,17', JSON.stringify(await boxes()));
  await shot('04-sketch-and-face-together');
  await accept(6);
  const kept = (await st()).features[5].params.profile;
  check('accepted and stored: a sketch and a face', kept.sketch === sketchId && kept.faces.length === 1 && (await boxes()).length === 1);

  // ---------------------------------------------------------------- it is in the document: a reload builds the same
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  await settled(page, 6);
  check('after a reload the part is the same', (await boxes()).length === 1 && round((await boxes())[0]).join() === '0,0,0,39,20,17', JSON.stringify(await boxes()));
  // edit the first face extrude: its dialog shows the face it holds
  await page.dblclick('.cad-features [data-feature-row]:nth-child(3)').catch(() => null);
  const editing = await page.waitForSelector('.cad-dialog[data-feature=extrude]', { timeout: 5000 }).then(() => true, () => false);
  if (!editing) await S(page, () => { const st = window.JunctionPartStudio; st.editFeature(st.getState().features[2].id); });
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  check('editing a face extrude shows the face it holds', (await heldFaces()).length === 1, (await heldFaces()).join());
  await shot('05-edit-face-extrude');
  await key('Escape'); await key('Escape');
  check('no errors on the page', page.errors.length === 0, page.errors.join(' | '));
} catch (e) {
  check('the script ran to its end', false, String(e && e.message ? e.message : e).split('\n').slice(0, 3).join(' | '));
  await shot('zz-failed');
  if (page.errors.length) console.log('page errors:', page.errors.join(' | '));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
