// Browser test of the solid, direct-editing, pattern, curve and reference features added for parity with
// Onshape's part studio toolbar, in the real app: every new button is on the toolbar where Onshape has it (the
// Fillet, Pattern and Curve families under their carets), has a tooltip and is found by the tool search; then a
// small part is built with each of them.  Sketches are drawn with the sketch tools by clicking; each feature is
// started from its toolbar button and its numbers typed into its dialog; what a feature refers to (faces, edges,
// sketch curves, reference geometry) is put into the open dialog with `studio.setDraft`, as a click on it does
// (picking by clicking is what scripts/cad-features-ui.mjs and cad-patterns-ui.mjs test).  Each result is checked
// (the feature built, the size or volume or curve length it should give), then undo and redo, a reload, and a
// second person who opens the part studio sees the same.
//
// Setup as scripts/cad-ui.mjs: a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=… E2E_BASE=http://127.0.0.1:8202 [SHOTS=dir] node scripts/cad-solid-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name, clip) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, clip }); };

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
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && !s.sketch && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 120000 });
const previewed = (page) => page.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id];
}, null, { timeout: 120000 });
const click = async (page, p) => { await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.down(); await page.mouse.up(); };
const screenOf = (page, p) => S(page, (p) => {
  const st = window.JunctionPartStudio, c = st.viewport.canvas.getBoundingClientRect();
  const v = new (Object.getPrototypeOf(st.viewport.camera.position).constructor)(p[0], p[1], p[2]);
  const q = st.viewport.project(v);
  return { x: c.left + q.x, y: c.top + q.y };
}, p);

/** What the model is: per body its faces (name, centre, area-weighted normal), vertices, bbox and volume; the datums. */
const model = (page) => S(page, () => {
  const s = window.JunctionPartStudio.getState();
  const bodies = s.bodies.filter((b) => b.mesh).map((b) => {
    const m = b.mesh, P = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    let vol = 0;
    const faces = m.faces.names.map((name, f) => {
      const c = [0, 0, 0], n = [0, 0, 0]; let area = 0;
      for (let t = m.faces.start[f]; t < m.faces.start[f] + m.faces.count[f]; t += 3) {
        const a = P(m.indices[t]), bb = P(m.indices[t + 1]), cc = P(m.indices[t + 2]);
        const u = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]], w = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
        const x = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], ar = Math.hypot(...x) / 2;
        for (let k = 0; k < 3; k++) { c[k] += ((a[k] + bb[k] + cc[k]) / 3) * ar; n[k] += x[k] / 2; }
        area += ar;
        vol += (a[0] * (bb[1] * cc[2] - bb[2] * cc[1]) - a[1] * (bb[0] * cc[2] - bb[2] * cc[0]) + a[2] * (bb[0] * cc[1] - bb[1] * cc[0])) / 6;
      }
      const l = Math.hypot(...n) || 1;
      return { name, centre: c.map((v) => v / (area || 1)), normal: n.map((v) => v / l), area };
    });
    const vertices = m.vertices.names.map((name, i) => ({ name, at: [m.vertices.positions[i * 3], m.vertices.positions[i * 3 + 1], m.vertices.positions[i * 3 + 2]] }));
    return { id: b.id, name: b.name, faces, vertices, bbox: Array.from(m.bbox), volume: vol, reference: !!b.reference };
  });
  const curveLength = (pts) => { let L = 0; for (let i = 3; i + 2 < pts.length; i += 3) { const d = [0, 1, 2].map((k) => pts[i + k] - pts[i - 3 + k]); if (d.every(Number.isFinite)) L += Math.hypot(...d); } return L; };
  return {
    features: s.features.map((f) => ({ id: f.id, type: f.featureType, name: f.name, params: f.params, status: s.reports[f.id]?.status, message: s.reports[f.id]?.message })),
    bodies, datums: s.datums.map((d) => ({ featureId: d.featureId, kind: d.kind, mate: !!d.mate, frame: d.frame, length: d.points ? curveLength(d.points) : 0 })),
  };
});
const near = (a, b, eps) => Math.abs(a - b) <= eps;
const round = (v) => Math.round(v * 1000) / 1000;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await setCad(BASE, jwt(uid, login));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

const NEW = ['Thicken', 'Enclose', 'Variable fillet', 'Face blend', 'Rib', 'Wrap', 'Composite part', 'Modify fillet', 'Delete face', 'Move face', 'Replace face', 'Curve pattern',
  'Mate connector', 'Variable', 'Fit spline', 'Projected curve', 'Bridging curve', 'Composite curve', 'Intersection curve', 'Trim curve', 'Isocline', 'Routing curve'];

try {
  const uid = user('cad-solid-ui', 990311), uid2 = user('cad-solid-ui-2', 990312);
  const page = await open(uid, 'cad-solid-ui');
  const project = await page.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Solid tools test', template: 'pcb' }) });
    return r.json();
  });
  const pid = project.projectId;
  const invited = await page.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cad-solid-ui-2', role: 'editor' }) })).status, pid);
  check('a second person is invited as an editor', invited === 200, `status ${invited}`);
  await page.goto(`${BASE}/p/${pid}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  await page.waitForTimeout(500);

  // ---------------------------------------------------------------- the toolbar, tooltips, the search
  const all = await toolTitles(page, 'feature');
  const missing = NEW.filter((t) => !all.includes(t));
  check('every new tool is on the toolbar', !missing.length, missing.length ? `missing: ${missing.join(', ')}` : `${NEW.length} tools`);
  const menus = await S(page, () => Object.fromEntries(Array.from(document.querySelectorAll('.cad-toolbar [data-group] [data-menu]')).map((m) => [m.getAttribute('data-menu'), (m.getAttribute('data-items') || '').split('|')])));
  check('Fillet ▾ holds Fillet, Variable fillet and Face blend', JSON.stringify(menus.Fillet) === JSON.stringify(['Fillet', 'Variable fillet', 'Face blend']), JSON.stringify(menus.Fillet));
  check('Pattern ▾ holds Linear, Circular and Curve pattern', JSON.stringify(menus.Pattern) === JSON.stringify(['Linear pattern', 'Circular pattern', 'Curve pattern']), JSON.stringify(menus.Pattern));
  check('Curve ▾ holds the eight curve tools', (menus.Curve || []).length === 8 && menus.Curve[0] === 'Fit spline', JSON.stringify(menus.Curve));
  const order = await S(page, () => Array.from(document.querySelectorAll('.cad-toolbar [data-group] [data-tool]:not([data-variant]), .cad-toolbar [data-group] [data-menu]')).map((b) => b.getAttribute('data-menu') || b.getAttribute('data-tool')));
  const at = (t) => order.indexOf(t);
  check('the toolbar runs in Onshape\'s order: … Loft, Thicken, Enclose │ Fillet ▾ … Rib, Shell │ … │ Direct edit ▾ │ Pattern ▾ │ Plane ▾, Curve ▾ …',
    at('Loft') < at('Thicken') && at('Thicken') < at('Enclose') && at('Enclose') < at('Fillet') && at('Draft') < at('Rib') && at('Rib') < at('Shell') && at('Composite part') < at('Direct edit') && at('Direct edit') < at('Pattern') && at('Reference') < at('Curve'),
    order.join(' '));
  // the direct editing tools are a section of their own, one button and a caret as Onshape groups them
  check('Direct edit ▾ holds Modify fillet, Delete face, Move face and Replace face', JSON.stringify(menus['Direct edit']) === JSON.stringify(['Modify fillet', 'Delete face', 'Move face', 'Replace face']) && !order.includes('Delete face'), JSON.stringify(menus['Direct edit']));
  // a tooltip
  await page.hover('.cad-toolbar [data-tool=Thicken]');
  await page.waitForTimeout(900);
  const tip = await S(page, () => document.querySelector('.cad-toolbar [data-tool=Thicken]').getAttribute('aria-description') || '');
  check('a new button has a tooltip that says what it does', /Thicken|thick/i.test(tip) && tip.length > 20, tip);
  // the tool search, by another word for it
  await page.mouse.move(5, 500);
  for (const [words, want] of [['parting', 'Isocline'], ['gusset', 'Rib'], ['csys', 'Mate connector'], ['interpolate', 'Fit spline'], ['silhouette', 'Isocline'], ['bridge', 'Bridging curve'], ['parameter', 'Variable']]) {
    await page.click('.cad-toolbar [data-tool-search]');
    await page.waitForSelector('.cad-palette [data-palette-input]');
    await page.fill('.cad-palette [data-palette-input]', words);
    await page.waitForTimeout(200);
    const found = await page.$$eval('.cad-palette [data-command]', (els) => els.map((e) => e.getAttribute('data-command')));
    check(`the tool search finds ${want} by “${words}”`, found.slice(0, 3).includes(want), found.slice(0, 5).join(' | '));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.cad-palette', { state: 'detached' });
    await page.waitForTimeout(150);
  }
  if (SHOTS) {
    const bar = await page.$eval('.cad-toolbar', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
    await shot(page, 'toolbar', bar);
    // the Curve family open
    await page.click('.cad-toolbar [data-menu=Curve]');
    await page.waitForTimeout(300);
    const menu = await page.$eval('.cad-tb-menu', (e) => { const r = e.getBoundingClientRect(); return { x: Math.max(0, r.left - 40), y: 0, width: Math.min(1920 - Math.max(0, r.left - 40), r.width + 260), height: r.bottom + 10 }; });
    await shot(page, 'toolbar-curve-menu', menu);
    await page.keyboard.press('Escape');
  }

  // ---------------------------------------------------------------- helpers to build
  let count = 0;
  /** Start a feature from its button, put its references in, type its numbers, accept; returns its report. */
  async function feature(title, type, params = {}, typed = {}, o = {}) {
    await tool(page, title);
    await page.waitForSelector(`.cad-dialog[data-feature=${type}]`, { timeout: 30000 });
    // what was built for the dialog as it opened (nothing picked yet) is not the answer: wait for a newer report
    await S(page, () => { const s = window.JunctionPartStudio.getState(); window.__seen = s.reports[s.editing.draft.id] || null; });
    if (Object.keys(params).length) await S(page, (p) => window.JunctionPartStudio.setDraft({ params: p }), params);
    for (const [k, v] of Object.entries(typed)) { await page.fill(`.cad-dialog input[data-param=${k}]`, String(v)); await page.keyboard.press('Tab'); }
    await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const r = s.reports[s.editing.draft.id]; return s.kernel.state === 'ready' && r && r !== window.__seen; }, null, { timeout: 120000 });
    await previewed(page);
    const report = await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.reports[s.editing.draft.id]; });
    if (o.keepIfError || report.status !== 'error') { await page.click('.cad-dialog [data-accept]'); count++; await settled(page, count); }
    else await page.click('.cad-dialog [data-cancel]').catch(() => page.keyboard.press('Escape'));
    const m = await model(page);
    return { report, m, id: m.features[m.features.length - 1]?.id };
  }
  const okNow = (r) => r.report.status === 'ok' || r.report.status === 'warning';
  /** A sketch on a default plane or on the selected face/plane, drawn by clicking world points with a sketch tool. */
  async function sketch(where, draw) {
    if (where.select) await S(page, (p) => window.JunctionPartStudio.select([p]), where.select);
    else await S(page, () => window.JunctionPartStudio.select([]));
    await page.click('[data-tool=Sketch]');
    await page.waitForSelector('.cad-sketch-dialog');
    if (await page.locator('.cad-sketch-dialog[data-sketch-waiting]').count()) await page.click(`.cad-features [data-default-geometry=${where.plane}]`);
    await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.sketches.some((v) => v.featureId === s.sketch.featureId) && s.kernel.state === 'ready'; }, null, { timeout: 60000 });
    await page.waitForTimeout(800);
    const frame = await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.sketches.find((v) => v.featureId === s.sketch.featureId).frame; });
    await draw(frame);
    const id = await S(page, () => window.JunctionPartStudio.getState().sketch.featureId);
    const entities = await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.find((x) => x.id === s.sketch.featureId).params.sketch.entities; });
    await page.click("[data-tool='Finish sketch']");
    count++;
    await settled(page, count);
    return { id, entities, frame };
  }
  const nEntities = (n) => page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.keys(f.params.sketch.entities).length >= n; }, n, { timeout: 15000 });
  const clickWorld = async (p) => { const q = await screenOf(page, p); await page.mouse.move(q.x, q.y, { steps: 4 }); await click(page, q); };
  const fit = () => S(page, () => window.JunctionPartStudio.viewport.fit());
  const mainBody = (m) => m.bodies.find((b) => b.id === blockId);
  const faceOf = (m, pred, body = blockId) => (m.bodies.find((b) => b.id === body)?.faces || []).filter(pred).sort((a, b) => b.area - a.area)[0];
  const ref = (f, body = blockId) => ({ kind: 'face', body, name: f.name });
  const edgeRef = (a, b, body = blockId) => ({ kind: 'edge', body, name: `edge(${[a.name, b.name].sort().join('|')})` });

  // ---------------------------------------------------------------- the block: 60 × 40, 20 tall
  await page.keyboard.press('Shift+7').catch(() => {});
  const base = await sketch({ plane: 'top' }, async () => {
    await page.click('[data-tool=Rectangle]');
    await clickWorld([-30, -20, 0]); await clickWorld([30, 20, 0]);
    await nEntities(8);
  });
  const basePts = Object.entries(base.entities).filter(([, e]) => e.type === 'point').map(([id, e]) => ({ id, x: e.x, y: e.y }));
  const baseLines = Object.entries(base.entities).filter(([, e]) => e.type === 'line').map(([id]) => id);
  check('a 60 × 40 rectangle is drawn by clicking', basePts.length === 4 && basePts.some((p) => near(p.x, 30, 0.6) && near(p.y, 20, 0.6)), JSON.stringify(basePts));
  let r = await feature('Extrude', 'extrude', {}, { depth: 20 });
  const blockId = r.id;
  let m = r.m;
  check('the block is built', okNow(r) && near(mainBody(m).bbox[5], 20, 1e-3), JSON.stringify(mainBody(m)?.bbox));
  await fit();
  const TOP = faceOf(m, (f) => f.normal[2] > 0.99), BOTTOM = faceOf(m, (f) => f.normal[2] < -0.99);
  const SA = faceOf(m, (f) => f.normal[1] < -0.99), SB = faceOf(m, (f) => f.normal[0] > 0.99), SC = faceOf(m, (f) => f.normal[1] > 0.99), SD = faceOf(m, (f) => f.normal[0] < -0.99);

  // ---------------------------------------------------------------- Variable: #v1 = 10 mm
  await tool(page, 'Variable');
  await page.waitForSelector('[data-variable=v1]');
  // the name takes the keyboard once the panel has drawn the row (a frame or two after it is there)
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Variable name', null, { timeout: 2000 }).catch(() => {});
  check('Variable adds v1 in the Variables panel, its name ready to type', await S(page, () => document.activeElement?.getAttribute('aria-label') === 'Variable name'));
  await page.fill('[data-variable=v1] input[aria-label="Value of v1"]', '10 mm');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-variable=v1] [data-value]')?.getAttribute('data-value') === '10');

  // ---------------------------------------------------------------- reference planes used below
  const plane = async (refPlane, distance) => (await feature('Plane', 'plane', { method: 'offset', ref: { kind: 'plane', plane: refPlane } }, { distance })).id;
  const P10 = await plane('top', 10), PM8 = await plane('top', -8);

  // ---------------------------------------------------------------- direct editing
  r = await feature('Replace face', 'replace-face', { faces: [ref(TOP)], target: { kind: 'datum', feature: P10 } }, { offset: 14 });
  check('Replace face: the top is put on a plane 10 up, offset 14: the block is 24 tall', okNow(r) && near(mainBody(r.m).bbox[5], 24, 1e-3), `${r.report.status} ${r.report.message || ''} ${mainBody(r.m)?.bbox}`);
  r = await feature('Move face', 'move-face', { faces: [ref(SD)], type: 'translate' }, { distance: 4 });
  check('Move face: the x = −30 side moved 4 out', okNow(r) && near(mainBody(r.m).bbox[0], -34, 1e-3), `${r.report.status} ${r.report.message || ''} ${mainBody(r.m)?.bbox}`);
  m = r.m;
  r = await feature('Fillet', 'fillet', { edges: [edgeRef(SA, SB)] }, { radius: 4 });
  const filletId = r.id;
  check('Fillet rounds the corner edge', okNow(r), r.report.message);
  const v0 = mainBody(r.m).volume;
  const roundFace = faceOf(r.m, (f) => f.name.startsWith(`${filletId}:`));
  r = await feature('Modify fillet', 'modify-fillet', { faces: [ref(roundFace)], mode: 'radius' }, { radius: 6 });
  check('Modify fillet: the rounding made 6 in radius takes off more', okNow(r) && near(v0 - mainBody(r.m).volume, (36 - 16) * (1 - Math.PI / 4) * 24, 2), `${round(v0 - mainBody(r.m).volume)} ${r.report.message || ''}`);
  const v1 = mainBody(r.m).volume, modId = r.id;
  const isRound = (f) => f.name.startsWith(`${filletId}:`) || f.name.startsWith(`${modId}:`);
  r = await feature('Face blend', 'face-blend', { side1: [ref(TOP)], side2: [ref(SC)] }, { radius: 2 });
  check('Face blend: the top and the back side blended along the 64 long edge', okNow(r) && mainBody(r.m).faces.some((f) => f.name.startsWith(`${r.id}:`)) && near(v1 - mainBody(r.m).volume, (4 - Math.PI) * 64, 1), `${round(v1 - mainBody(r.m).volume)} ${r.report.message || ''}`);
  const v2 = mainBody(r.m).volume;
  const rounded = faceOf(r.m, isRound);
  r = await feature('Delete face', 'delete-face', { faces: [ref(rounded)], mode: 'heal' });
  check('Delete face: the corner\'s rounding deleted and healed: the corner is sharp again', okNow(r) && near(mainBody(r.m).volume - v2, 36 * (1 - Math.PI / 4) * 24, 4) && !mainBody(r.m).faces.some(isRound), `${round(mainBody(r.m).volume - v2)} ${r.report.message || ''}`);
  const v3 = mainBody(r.m).volume;
  r = await feature('Variable fillet', 'variable-fillet', { edges: [edgeRef(TOP, SA)] }, { radius: 1, radius2: 3 });
  check('Variable fillet: the top front edge rounded from 1 to 3', okNow(r) && v3 - mainBody(r.m).volume > 10 && v3 - mainBody(r.m).volume < (4 - Math.PI) * 64 * 2.25, `${round(v3 - mainBody(r.m).volume)} ${r.report.message || ''}`);

  // ---------------------------------------------------------------- a boss with a rib and a wrapped emboss
  m = await model(page);
  const top2 = faceOf(m, (f) => f.normal[2] > 0.99 && f.centre[2] > 23);
  await sketch({ select: { kind: 'face', body: blockId, name: top2.name, point: [0, 0, 24] } }, async () => {
    await page.click('[data-tool=Circle]');
    await clickWorld([0, 0, 24]); await clickWorld([6, 0, 24]);
    await nEntities(2);
  });
  r = await feature('Extrude', 'extrude', { operation: 'add' }, { depth: 15 });
  check('a boss 15 tall on the top', okNow(r) && near(mainBody(r.m).bbox[5], 39, 0.05), `${r.report.status} ${r.report.message || ''} ${JSON.stringify(mainBody(r.m)?.bbox)} ${JSON.stringify(r.m.features[r.m.features.length - 1].params)}`);
  const bossSide = faceOf(r.m, (f) => f.name.startsWith(`${r.id}:side:`));
  // the rib's line, in the Front plane (y = 0): from the boss's wall down to the block's top, on the −x side
  const ribSk = await sketch({ plane: 'front' }, async () => {
    await page.click('[data-tool=Line]');
    await clickWorld([-6, 0, 34]); await clickWorld([-22, 0, 24]);
    await page.keyboard.press('Escape');
    await nEntities(3);
  });
  const ribLine = Object.entries(ribSk.entities).find(([, e]) => e.type === 'line')[0];
  let rib = null;
  for (const flip of [false, true]) {
    rib = await feature('Rib', 'rib', { profile: [{ kind: 'sketch', feature: ribSk.id, entity: ribLine }], flip, direction: 'parallel', extend: true }, { thickness: 2 });
    if (okNow(rib)) break;
  }
  const v4 = (await model(page)).bodies.find((b) => b.id === blockId).volume;
  check('Rib: a gusset between the boss and the top, joined to the part', okNow(rib) && (await model(page)).bodies.filter((b) => !b.reference).length === 1, `${rib.report.status} ${rib.report.message || ''}`);
  // Isocline: the boss's silhouette seen along x
  r = await feature('Isocline', 'isocline', { faces: [ref(bossSide)], direction: { kind: 'plane', plane: 'right' } }, { angle: 0 });
  const iso = r.m.datums.find((d) => d.featureId === r.id);
  check('Isocline: the boss\'s silhouette along x, two lines 15 long', okNow(r) && near(iso.length, 30, 0.5), `${round(iso?.length)} ${r.report.message || ''}`);
  // Wrap: a 4 × 6 rectangle on a plane touching the boss at x = 6, raised #v1 / 5 = 2 from it
  const P6 = await plane('right', 6);
  const wrapSk = await sketch({ select: { kind: 'datum', featureId: P6, datum: 'plane', point: [6, 0, 30] } }, async () => {
    await page.click('[data-tool=Rectangle]');
    await clickWorld([6, -2, 28]); await clickWorld([6, 2, 34]);
    await nEntities(8);
  });
  r = await feature('Wrap', 'wrap', { profile: { sketch: wrapSk.id, regions: null }, face: ref(bossSide), result: 'emboss' }, { depth: '#v1 / 5' });
  const wrapF = r.m.features.find((f) => f.id === r.id);
  check('Wrap: the rectangle raised round the boss, its depth typed as #v1 / 5', okNow(r) && wrapF.params.depth === 2 && mainBody(r.m).volume > v4 + 40 && near(mainBody(r.m).bbox[3], 30, 1e-3), `${r.report.status} ${r.report.message || ''} depth ${wrapF?.params.depth} +${round(mainBody(r.m).volume - v4)}`);

  // ---------------------------------------------------------------- Enclose, Thicken, Mate connector
  m = await model(page);
  const bottom = faceOf(m, (f) => f.normal[2] < -0.99);
  const PX = await plane('right', 20), PY = await plane('front', 15);
  m = await model(page);
  const v5 = mainBody(m).volume;
  r = await feature('Enclose', 'enclose', { operation: 'add', entities: [ref(bottom), ...[PM8, PX, PY].map((feature) => ({ kind: 'datum', feature })), { kind: 'plane', plane: 'front' }, { kind: 'plane', plane: 'right' }] });
  check('Enclose: the space closed off under the block by its bottom face and five planes is added (20 × 15 × 8)', okNow(r) && near(mainBody(r.m).volume - v5, 20 * 15 * 8, 3) && near(mainBody(r.m).bbox[2], -8, 1e-3), `${round(mainBody(r.m).volume - v5)} ${r.report.message || ''}`);
  m = r.m;
  const back = faceOf(m, (f) => f.normal[1] > 0.99);
  r = await feature('Thicken', 'thicken', { faces: [ref(back)], operation: 'new' }, { thickness: 3 });
  const slab = r.m.bodies.find((b) => b.id !== blockId && !b.reference);
  check('Thicken: the back face made a 3 thick slab, a part of its own', okNow(r) && !!slab && near(slab.bbox[4] - slab.bbox[1], 3, 1e-3), `${r.report.status} ${r.report.message || ''} ${slab?.bbox}`);
  r = await feature('Mate connector', 'mate-connector', { origin: ref(faceOf(r.m, (f) => f.normal[2] > 0.99 && f.centre[2] > 38)) });
  const mc = r.m.datums.find((d) => d.featureId === r.id);
  check('Mate connector: on the boss\'s top, z up', okNow(r) && mc?.mate && near(mc.frame.origin[2], 39, 1e-3) && near(mc.frame.normal[2], 1, 1e-6), JSON.stringify(mc?.frame));

  // ---------------------------------------------------------------- curves
  const pt = (x, y) => basePts.slice().sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0].id;
  const sk = (feature, entity) => ({ kind: 'sketch', feature, entity });
  const rectLineAt = (y) => baseLines.find((l) => { const e = base.entities[l]; const a = base.entities[e.a], b = base.entities[e.b]; return near(a.y, y, 0.6) && near(b.y, y, 0.6); });
  const len = (r) => r.m.datums.find((d) => d.featureId === r.id)?.length ?? NaN;
  r = await feature('Fit spline', 'fit-spline', { points: [sk(base.id, pt(-30, -20)), sk(base.id, pt(30, -20)), sk(base.id, pt(30, 20))] });
  check('Fit spline: through three corners of the sketch, longer than its chords', okNow(r) && len(r) > 100, `${round(len(r))} ${r.report.message || ''}`);
  r = await feature('Composite curve', 'composite-curve', { curves: [sk(base.id, baseLines[0])] });
  check('Composite curve: the rectangle\'s four lines as one closed curve, 200 long', okNow(r) && near(len(r), 200, 1.5), `${round(len(r))} ${r.report.message || ''}`);
  const routing = await feature('Routing curve', 'routing-curve', { points: [sk(base.id, pt(-30, -20)), sk(base.id, pt(30, -20)), sk(base.id, pt(30, 20))] }, { radius: 5 });
  check('Routing curve: two runs and a bend of 5', okNow(routing) && near(len(routing), 100 - 10 + Math.PI * 5 / 2, 1.5), `${round(len(routing))} ${routing.report.message || ''}`);
  r = await feature('Projected curve', 'projected-curve', { method: 'curves', curves: [sk(ribSk.id, ribLine)], curves2: [sk(base.id, rectLineAt(-20))] });
  check('Projected curve: the rib\'s line (seen from the front) and the base\'s front line (seen from above) give a 3D line', okNow(r) && near(len(r), Math.hypot(16, 10), 1), `${round(len(r))} ${r.report.message || ''}`);
  r = await feature('Bridging curve', 'bridging-curve', { start: sk(ribSk.id, ribLine), end: sk(base.id, rectLineAt(-20)), match: 'tangency' });
  check('Bridging curve: a tangent bridge from the rib\'s line to the base\'s', okNow(r) && len(r) > 10, `${round(len(r))} ${r.report.message || ''}`);
  m = await model(page);
  r = await feature('Intersection curve', 'intersection-curve', { first: mainBody(m).faces.map((f) => ref(f)), second: [{ kind: 'datum', feature: P10 }] });
  check('Intersection curve: the block\'s outline 10 up', okNow(r) && len(r) > 180, `${round(len(r))} ${r.report.message || ''}`);
  r = await feature('Trim curve', 'trim-curve', { curve: sk(ribSk.id, ribLine), end: 'end', by: 'distance' }, { distance: -4 });
  check('Trim curve: the rib\'s line 4 shorter', okNow(r) && near(len(r), Math.hypot(16, 10) - 4, 0.2), `${round(len(r))} ${r.report.message || ''}`);

  // ---------------------------------------------------------------- Curve pattern, Composite part
  r = await feature('Curve pattern', 'curve-pattern', { of: 'bodies', bodies: [slab.id], path: [{ kind: 'datum', feature: routing.id }], keepOrientation: true }, { count: 3 });
  const parts = (mm) => mm.bodies.filter((b) => !b.reference);
  check('Curve pattern: the slab copied along the routing curve, 3 in all', okNow(r) && parts(r.m).length === 4, `${parts(r.m).length} parts ${r.report.message || ''}`);
  const before = parts(r.m).length;
  r = await feature('Composite part', 'composite-part', { bodies: [blockId, slab.id], closed: true });
  check('Composite part: the block and the slab held as one part', okNow(r) && parts(r.m).length === before - 1, `${parts(r.m).length} parts ${r.report.message || ''}`);
  // the picture: the planes hidden (P), the curves and the mate connector left in view
  await S(page, () => { const st = window.JunctionPartStudio; st.setPlanesVisible(false); const vp = st.viewport; vp.setView('iso', false); vp.fit(); });
  await page.waitForTimeout(800);
  await shot(page, 'model');
  await S(page, () => window.JunctionPartStudio.setPlanesVisible(true));
  m = await model(page);
  const bad = m.features.filter((f) => f.status === 'error');
  check('every feature built', !bad.length, bad.map((f) => `${f.name}: ${f.message}`).join(' | '));

  // ---------------------------------------------------------------- undo, redo, reload, a second person
  const n = m.features.length;
  await page.click('.cad-toolbar [data-tool=Undo]');
  await settled(page, n - 1);
  const partsAre = (k) => page.waitForFunction((k) => window.JunctionPartStudio.getState().bodies.filter((b) => b.mesh && !b.reference).length === k, k, { timeout: 30000 }).then(() => true, () => false);
  check('Undo takes the composite part away', await partsAre(before));
  await page.click('.cad-toolbar [data-tool=Redo]');
  await settled(page, n);
  check('Redo puts it back', await partsAre(before - 1));
  const sig = (mm) => JSON.stringify({ f: mm.features.map((f) => `${f.type}:${f.status}`), b: mm.bodies.map((b) => [b.faces.length, Math.round(b.volume)]).sort(), d: mm.datums.map((d) => [d.kind, Math.round(d.length)]).sort() });
  const was = sig(await model(page));
  await page.reload();
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  await settled(page, n);
  check('after a reload the model is rebuilt the same', sig(await model(page)) === was);
  const url = page.url();
  const other = await open(uid2, 'cad-solid-ui-2');
  await other.goto(url);
  await other.waitForFunction((n) => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && s.features.every((f) => s.reports[f.id]); }, n, { timeout: 120000 });
  check('a second person who opens it sees the same model', sig(await model(other)) === was);
  check('no page errors', !errors.length, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('the script ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : String(e));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
