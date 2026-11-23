// Browser test of Render mode (web/shared/render): the ray traced picture of a part studio and of an assembly.
// A bracket is opened in a part studio; Render is found by the words people look for it by and turned on; the
// picture gathers samples, is not blank and is not the shaded viewport; it starts again when the view turns, when
// the lights are changed in the panel and when the part is dressed in another appearance (whose finish is stored
// with it); the focus is picked by a click; a still is saved from the panel (and one wide enough to be traced in
// two tiles); a small turntable film is rendered and is a film a <video> element plays, and its fallback is a zip
// of PNG frames; a long film is cancelled; the picture pauses while the tab is hidden; a lost graphics context
// ends the mode with a message and leaves the viewport working.  Then an assembly of four parts in three
// appearances is rendered the same way, and a film of it coming apart.
//
// Headless Chromium has no graphics card: it draws with SwiftShader, on the processor.  Render mode refuses that
// unless it is forced (localStorage "junction.cad.render.force"), which this script checks first and then does;
// pictures here are small and take few samples, and the script still needs several minutes.
//
// Setup as the other cad-*-ui.mjs scripts (a server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql):
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-render-ui.mjs
//
// SHOTS: a folder for what it made (render-*.png, the stills, the film).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';
import { pickOption } from './kselect-pick.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
function user(login, githubId) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${login}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

// ---- part studios as files (the format of mechanical/CONTRACT.md)
const poly = (pts) => { const e = {}; pts.forEach(([x, y], i) => { e['p' + i] = { type: 'point', x, y }; }); pts.forEach((_, i) => { e['l' + i] = { type: 'line', a: 'p' + i, b: 'p' + ((i + 1) % pts.length) }; }); return e; };
const circle = (id, x, y, r) => ({ [id + 'c']: { type: 'point', x, y }, [id]: { type: 'circle', center: id + 'c', r } });
const studioText = (items) => JSON.stringify({ junction: 'part-studio', version: 1, items: [{ id: 'studio', type: 'studio', units: 'mm', rollback: null }, ...items] });
const ORDERS = 'DFHJLNPRTVXZbdfhjlnprtvxz';
const ordered = (features) => features.map((f, i) => ({ ...f, order: ORDERS[i] }));
const sketch = (id, entities, plane = 'top') => ({ id, type: 'feature', featureType: 'sketch', name: id, params: { plane: { kind: 'plane', plane }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, depth, name, o = {}) => ({ id, type: 'feature', featureType: 'extrude', name, params: { profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [], ...o } });
const fillet = (id, edges, radius) => ({ id, type: 'feature', featureType: 'fillet', name: id, params: { edges: edges.map((name) => ({ kind: 'edge', body: 'br', name })), measure: 'radius', radius, width: 1.5 } });
const rect = (x0, y0, x1, y1) => poly([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
// an L bracket, 70 × 44 × 55 and 8 thick: the bend rounded inside and out, the corners rounded, two holes in each leg.
// It is brushed aluminium as a document written before finishes were stored says it: the appearance's id, no finish.
const BRACKET = studioText([
  ...ordered([
    sketch('s1', poly([[0, 0], [70, 0], [70, 8], [8, 8], [8, 55], [0, 55]]), 'front'), extrude('br', 's1', 44, 'Bracket'),
    fillet('bend', ['edge(br:side:l2|br:side:l3)'], 9), fillet('heel', ['edge(br:side:l0|br:side:l5)'], 5),
    fillet('corners', ['edge(br:side:l4|br:start:l0)', 'edge(br:end:l0|br:side:l4)', 'edge(br:side:l1|br:start:l0)', 'edge(br:end:l0|br:side:l1)'], 9),
    sketch('s2', { ...circle('h1', 50, -11, 3.4), ...circle('h2', 50, -33, 3.4) }), extrude('base-holes', 's2', 40, 'Base holes', { operation: 'remove', endType: 'symmetric' }),
    sketch('s3', { ...circle('h3', -11, 37, 3.2), ...circle('h4', -33, 37, 3.2) }, 'right'), extrude('flange-holes', 's3', 40, 'Flange holes', { operation: 'remove', endType: 'symmetric' }),
  ]),
  { id: 'appearance', type: 'appearance', bodies: { br: { color: '#c8ccd0', metalness: 1, roughness: 0.38, appearance: 'aluminium-brushed' } } },
]);
// a plate, a pin, a knob and a clear window, each in a library appearance
const PARTS = studioText([
  ...ordered([
    sketch('ps', { ...rect(0, 0, 80, 60), ...circle('ph', 20, 30, 4) }), extrude('plate', 'ps', 6, 'Plate'),
    sketch('s1', circle('pin', 20, 30, 3.9)), extrude('pin', 's1', 26, 'Pin'),
    sketch('s2', circle('knob', 55, 30, 11)), extrude('knob', 's2', 18, 'Knob'),
    sketch('s3', rect(100, 0, 130, 40)), extrude('window', 's3', 3, 'Window'),
  ]),
  { id: 'appearance', type: 'appearance', bodies: {
    plate: { color: '#2f5fa8', metalness: 1, roughness: 0.4, appearance: 'aluminium-anodised-blue' },
    pin: { color: '#b9bcc0', metalness: 1, roughness: 0.25, appearance: 'steel-stainless' },
    knob: { color: '#c8372d', metalness: 0, roughness: 0.45, appearance: 'pla-red' },
    window: { color: '#f2f8fa', metalness: 0, roughness: 0.04, opacity: 0.3, appearance: 'acrylic-clear' },
  } },
]);

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];

/** A picture's numbers, read in the page: its size, how bright it is on average, how much it varies, its mean colour, and a small grey copy to compare with another. */
const measure = (page, dataUrl) => page.evaluate(async (url) => {
  const img = new Image();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('the picture did not load')); img.src = url; });
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0, sq = 0, r = 0, gr = 0, b = 0, alpha = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) { const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; sum += l; sq += l * l; r += d[i]; gr += d[i + 1]; b += d[i + 2]; alpha += d[i + 3]; }
  const small = document.createElement('canvas'); small.width = 32; small.height = 24;
  const sg = small.getContext('2d', { willReadFrequently: true }); sg.drawImage(img, 0, 0, 32, 24);
  const sd = sg.getImageData(0, 0, 32, 24).data, grey = [];
  for (let i = 0; i < sd.length; i += 4) grey.push(Math.round(0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]));
  // the middle third, where the model is
  const mid = g.getImageData(Math.floor(c.width / 3), Math.floor(c.height / 3), Math.ceil(c.width / 3), Math.ceil(c.height / 3)).data;
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < mid.length; i += 4) { mr += mid[i]; mg += mid[i + 1]; mb += mid[i + 2]; }
  const m = mid.length / 4;
  return { width: c.width, height: c.height, mean: sum / n, std: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)), rgb: [r / n, gr / n, b / n], alpha: alpha / n, middle: [mr / m, mg / m, mb / m], grey };
}, dataUrl);
const differ = (a, b) => a.grey.reduce((s, v, i) => s + Math.abs(v - b.grey[i]), 0) / a.grey.length;
const asUrl = (buffer, type = 'image/png') => `data:${type};base64,${buffer.toString('base64')}`;

const mode = (page) => page.evaluate(() => { const m = window.JunctionRenderMode; if (!m) return null; const s = m.getState(); return { on: s.on, phase: s.phase, samples: s.samples, target: s.target, size: s.size, error: s.error, settings: s.settings, job: s.job, focusing: s.focusing, software: s.software, triangles: s.triangles, last: s.last }; });
const samples = (page, n, timeout = 600000) => page.waitForFunction((n) => { const m = window.JunctionRenderMode; return !!m && m.getState().on && m.getState().samples >= n; }, n, { timeout, polling: 250 });
/** The rendered picture as it is on screen: the engine's canvas. */
const picture = (page) => page.$eval('canvas[data-render-canvas]', (c) => c.toDataURL('image/png'));
const stage = async (page, name) => { const box = await page.$eval('.cad-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }); const png = await page.screenshot({ clip: box }); if (SHOTS && name) fs.writeFileSync(`${SHOTS}/render-${name}.png`, png); return png; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/render-${name}.png` }); };
async function search(page, api, key, text) {
  await page.evaluate((api) => window[api].viewport.canvas.focus(), api);
  await page.keyboard.press(key);
  await page.waitForSelector('[data-palette-input]');
  await page.fill('[data-palette-input]', text);
  await page.waitForTimeout(150);
  return page.$$eval('#cad-palette-list [role=option], #asm-palette-list [role=option]', (els) => els.map((el) => el.getAttribute('data-command')));
}
/** Do something and say whether the picture started again because of it (its samples went back to none). */
const restarted = (page, act, wait = 60000) => Promise.all([
  page.evaluate((wait) => new Promise((done) => { const m = window.JunctionRenderMode; const off = m.subscribe(() => { if (m.getState().samples <= 1) { off(); done(true); } }); setTimeout(() => { off(); done(false); }, wait); }), wait),
  act(),
]).then(([again]) => again);
const closeSearch = async (page) => { await page.keyboard.press('Escape'); await page.waitForSelector('[data-palette-input]', { state: 'detached' }); };
/** Start something that hands a file to the browser's downloads, and read the file. */
async function saved(page, start, timeout = 900000) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout }), start()]);
  const file = await download.path();
  return { name: download.suggestedFilename(), data: fs.readFileSync(file) };
}
const pngSize = (data) => (data.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n' ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) } : null);
/** The names in a zip's central directory. */
function zipNames(data) {
  const names = [];
  let at = data.length - 22;
  while (at >= 0 && data.readUInt32LE(at) !== 0x06054b50) at--;
  if (at < 0) return names;
  const count = data.readUInt16LE(at + 10); let p = data.readUInt32LE(at + 16);
  for (let i = 0; i < count; i++) { if (data.readUInt32LE(p) !== 0x02014b50) break; const n = data.readUInt16LE(p + 28), x = data.readUInt16LE(p + 30), c = data.readUInt16LE(p + 32); names.push(data.subarray(p + 46, p + 46 + n).toString('utf8')); p += 46 + n + x + c; }
  return names;
}

try {
  const uid = user('cad-render', 990077);
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 1, colorScheme: 'light', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  // the tracer's shader takes SwiftShader the better part of a minute to compile, and the page waits for it
  page.setDefaultTimeout(180000);
  await setCad(BASE, jwt(uid, 'cad-render'));
  // the draft quality: half the viewport's pixels each way, 64 samples (what a person on a slow machine would choose)
  await page.addInitScript(() => { try { if (!localStorage.getItem('junction.cad.render')) localStorage.setItem('junction.cad.render', JSON.stringify({ quality: 'draft' })); } catch (e) { /* no storage */ } });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-render')}&next=/`);
  await page.waitForLoadState('networkidle');

  const project = await page.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Render test', template: 'pcb' }) })).json()));
  const pid = project.projectId;
  const newDoc = (name, text) => page.evaluate(async ({ pid, name, text }) => {
    const made = await (await fetch(`/api/projects/${pid}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: name }) })).json();
    await fetch(`/api/docs/${made.docId}/snapshots?seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text });
    return made.docId;
  }, { pid, name, text });
  const bracketDoc = await newDoc('Bracket.jpart', BRACKET), partsDoc = await newDoc('Parts.jpart', PARTS);
  const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
  const inst = (id, name, body, t) => ({ id, type: 'instance', name, order: id, source: { kind: 'part', docId: partsDoc, body }, transform: t });
  const asmDoc = await newDoc('Fixture.jasm', JSON.stringify({ junction: 'assembly', version: 1, items: [
    { id: 'assembly', type: 'assembly', units: 'mm' },
    inst('i1', 'Plate <1>', 'plate', T(0, 0, 0)), inst('i2', 'Pin <1>', 'pin', T(0, 0, -4)), inst('i3', 'Knob <1>', 'knob', T(0, 0, 6)), inst('i4', 'Window <1>', 'window', T(-60, 8, 30)),
  ] }));
  const openStudio = async () => {
    await page.goto(`${BASE}/p/${pid}/edit?doc=${bracketDoc}`);
    await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().kernel.state === 'ready' && window.JunctionPartStudio.getState().bodies.length === 1, null, { timeout: 120000 });
    // fold the docks away: the viewport is what is looked at
    await page.evaluate(() => { const v = window.JunctionPartStudio.viewport; v.setProjection('perspective'); v.fit(undefined, false); });
    await page.waitForTimeout(500);
  };

  // ================================================================ a part studio
  await openStudio();
  const built = await page.evaluate(() => Object.values(window.JunctionPartStudio.getState().reports).map((r) => r.status));
  check('the bracket is built: an L with a rounded bend, rounded corners and four holes', built.length === 9 && built.every((s) => s === 'ok'), built.join());
  const raster = await measure(page, asUrl(await stage(page, 'viewport')));

  // ---------------------------------------------------------------- finding it
  const found = {};
  for (const word of ['render', 'raytrace', 'photo', 'turntable']) { found[word] = await search(page, 'JunctionPartStudio', 's', word); await closeSearch(page); }
  check('the tool search finds Render by "render", "raytrace" and "turntable" first, and among what "photo" finds', found.render[0] === 'Render' && found.raytrace[0] === 'Render' && found.turntable[0] === 'Render' && found.photo.includes('Render'), JSON.stringify(Object.fromEntries(Object.entries(found).map(([k, v]) => [k, v.slice(0, 3)]))));

  // ---------------------------------------------------------------- where graphics are drawn by the processor
  await search(page, 'JunctionPartStudio', 's', 'render');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /drawn by the processor/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  const refused = await page.evaluate(() => ({ panel: !!document.querySelector('[data-render-panel]'), canvas: !!document.querySelector('canvas[data-render-canvas]'), text: document.body.innerText }));
  check('without a graphics card Render says why it will not start, and the viewport stays as it was', !refused.panel && !refused.canvas && /drawn by the processor/.test(refused.text), refused.text.match(/Graphics[^\n]*/)?.[0] || 'no message');
  check('… and the part studio still works', (await page.evaluate(() => { const st = window.JunctionPartStudio; st.viewport.rotateBy(0.2, 0, false); st.viewport.rotateBy(-0.2, 0, false); return st.getState().bodies.length; })) === 1);

  // ---------------------------------------------------------------- forced on: the picture
  await page.evaluate(() => localStorage.setItem('junction.cad.render.force', '1'));
  await search(page, 'JunctionPartStudio', 's', 'render');
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-render-panel]', { timeout: 60000 });
  check('Render opens its panel over the viewport and lays its own canvas on the viewport\'s', await page.isVisible('[data-render-panel]') && (await page.$$('canvas[data-render-canvas]')).length === 1);
  check('… it says graphics are drawn by the processor here', /drawn by the processor/.test(await page.textContent('[data-render-panel]')));
  await samples(page, 4);
  const first = Date.now() - t0;
  let m = await mode(page);
  check('samples gather while nothing moves', m.samples >= 4 && m.target === 64 && m.phase === 'rendering' && m.size[0] > 60 && m.size[1] > 60, `${m.samples} of ${m.target} samples at ${m.size.join(' × ')} after ${(first / 1000).toFixed(0)} s (the shader is compiled first)`);
  check('the status line counts them', /\d+ of 64 samples/.test(await page.textContent('[data-render-status]')), await page.textContent('[data-render-status]'));
  check('the finer triangles the kernel sends replace the viewport\'s', m.triangles > 2 * (await page.evaluate(() => window.JunctionPartStudio.getState().bodies[0].mesh.indices.length / 3)), `${m.triangles} triangles traced`);
  await samples(page, 8);
  const softbox = await measure(page, await picture(page));
  await shot(page, '01-studio');
  const shown = await measure(page, asUrl(await stage(page)));
  check('the picture is not blank: a model on a light backdrop', softbox.std > 12 && softbox.mean > 120 && softbox.alpha > 254, `mean ${softbox.mean.toFixed(0)}, spread ${softbox.std.toFixed(1)}`);
  check('… and is not the shaded viewport', differ(shown, raster) > 4, `the two differ by ${differ(shown, raster).toFixed(1)} grey levels a pixel`);
  await page.waitForFunction(() => window.JunctionRenderMode.getState().phase === 'done', null, { timeout: 300000 });
  m = await mode(page);
  check('… and refines until it has the samples the quality asks for, then rests', m.samples === 64 && m.phase === 'done' && /Done: 64 samples/.test(await page.textContent('[data-render-status]')), `${m.samples} samples, ${m.phase}`);

  // ---------------------------------------------------------------- it follows the view
  const home = await page.evaluate(() => window.JunctionPartStudio.viewport.cameraState());
  let again = await restarted(page, () => page.evaluate(() => window.JunctionPartStudio.viewport.rotateBy(0.9, 0.1, false)));
  await samples(page, 6);
  const turned = await measure(page, await picture(page));
  check('turning the view starts the picture again from the new side', again && differ(turned, softbox) > 2, `differs by ${differ(turned, softbox).toFixed(1)}`);
  await restarted(page, () => page.evaluate((home) => window.JunctionPartStudio.viewport.setCameraState(home, false), home));
  await samples(page, 6);

  // ---------------------------------------------------------------- the lights, in the panel
  again = await restarted(page, () => pickOption(page, '[data-render=environment]', 'dark'));
  m = await mode(page);
  check('choosing the dark studio also gives it the glossy floor that suits it', m.settings.environment === 'dark' && m.settings.ground === 'glossy', JSON.stringify({ environment: m.settings.environment, ground: m.settings.ground }));
  await samples(page, 6);
  const dark = await measure(page, await picture(page));
  await shot(page, '02-dark');
  check('the picture is traced again under the new lights: a dark room', again && dark.mean < softbox.mean * 0.45 && dark.std > 4, `mean ${dark.mean.toFixed(0)} (it was ${softbox.mean.toFixed(0)})`);
  await restarted(page, () => pickOption(page, '[data-render=environment]', 'softbox'));
  m = await mode(page);
  check('back in the softbox studio the ground is the shadow catcher again', m.settings.environment === 'softbox' && m.settings.ground === 'shadow');
  await samples(page, 8);
  // exposure develops the picture differently and traces nothing again
  const plain = await measure(page, await picture(page));
  const had = (await mode(page)).samples;
  again = await restarted(page, () => page.evaluate(() => window.JunctionRenderMode.setSettings({ exposure: 1.5 })), 2500);
  const exposed = await measure(page, await picture(page));
  m = await mode(page);
  check('more exposure brightens the model without starting again', !again && m.samples >= had && exposed.middle[1] > plain.middle[1] + 6, `${had} → ${m.samples} samples; the middle went from ${plain.middle[1].toFixed(0)} to ${exposed.middle[1].toFixed(0)}`);
  await page.evaluate(() => window.JunctionRenderMode.setSettings({ exposure: 0 }));

  // ---------------------------------------------------------------- the material
  const stored = await page.evaluate(() => window.JunctionPartStudio.doc.items.get('appearance').bodies.br);
  check('the bracket is brushed aluminium by its appearance\'s id alone (an older document)', stored.appearance === 'aluminium-brushed' && stored.finish === undefined);
  if (!(await page.$('[data-panel=appearance-library][data-open]'))) await page.click('[data-panel-toggle=appearance-library]');
  await page.click('[data-body=br]');
  again = await restarted(page, () => page.click('[data-appearance=paint-gloss-red]'));
  await page.waitForFunction(() => window.JunctionPartStudio.doc.items.get('appearance')?.bodies?.br?.appearance === 'paint-gloss-red', null, { timeout: 15000 });
  const dressed = await page.evaluate(() => window.JunctionPartStudio.doc.items.get('appearance').bodies.br);
  check('dressing the part in gloss red paint stores its finish beside the colour: a clear coat', dressed.color === '#b3201c' && dressed.finish && dressed.finish.clearcoat === 1 && dressed.finish.clearcoatRoughness === 0.03, JSON.stringify(dressed));
  await samples(page, 6);
  const red = await measure(page, await picture(page));
  await shot(page, '03-red');
  check('the picture is traced again in the new material: red', again && red.middle[0] > red.middle[1] * 1.25 && red.middle[0] > red.middle[2] * 1.25, `the middle is ${red.middle.map((v) => v.toFixed(0)).join(', ')}`);
  check('the shaded viewport still draws the part from the same data', await page.evaluate(() => { const st = window.JunctionPartStudio, o = st.view.bodyObjects('br'); const mat = Array.isArray(o.mesh.material) ? o.mesh.material[0] : o.mesh.material; return mat.isMeshStandardMaterial && mat.color.r > mat.color.g * 2 && Math.abs(mat.roughness - 0.15) < 1e-6; }));

  // ---------------------------------------------------------------- focus
  await page.click('[data-render-dof]');
  await page.waitForFunction(() => window.JunctionRenderMode.getState().settings.dof === true, null, { timeout: 5000 });
  check('depth of field turns the view to perspective if it is not', await page.evaluate(() => window.JunctionPartStudio.viewport.projection === 'perspective'));
  await page.click('[data-render-focus]');
  check('Pick focus waits for a click on the model', (await mode(page)).focusing === true);
  const at = await page.evaluate(() => { const v = window.JunctionPartStudio.viewport, p = v.project(v.target.clone().set(50, -22, 8)), r = v.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
  const selectedBefore = await page.evaluate(() => window.JunctionPartStudio.getState().selection.length);
  await page.mouse.click(at.x, at.y);
  await page.waitForFunction(() => !window.JunctionRenderMode.getState().focusing, null, { timeout: 5000 });
  m = await mode(page);
  const f = m.settings.focus;
  check('a click on the model focuses there (on the base of the bracket)', !!f && Math.abs(f[0] - 50) < 3 && Math.abs(f[1] + 22) < 3 && Math.abs(f[2] - 8) < 0.5, JSON.stringify(f && f.map((v) => Math.round(v * 10) / 10)));
  check('… and that click selects nothing', (await page.evaluate(() => window.JunctionPartStudio.getState().selection.length)) === selectedBefore);
  await samples(page, 4);
  await page.click('[data-render-dof]');

  // ---------------------------------------------------------------- a still
  // (a small window: the panel's button renders the view's own size at the quality's 64 samples)
  await page.setViewportSize({ width: 860, height: 560 });
  await page.waitForTimeout(600);
  await pickOption(page, '[data-render=image-size]', 'view');
  const [vw, vh] = await page.evaluate(() => window.JunctionRenderMode.imagePixels());
  await page.locator('[data-render-save]').scrollIntoViewIfNeeded();
  const still = await saved(page, () => page.click('[data-render-save]'));
  await page.setViewportSize({ width: 1180, height: 760 });
  const size = pngSize(still.data);
  if (SHOTS) fs.writeFileSync(`${SHOTS}/render-still.png`, still.data);
  check('Save image hands over a PNG named after the document, the size of the view', still.name === 'Bracket.png' && !!size && size.width === vw && size.height === vh, `${still.name}, ${size ? size.width + ' × ' + size.height : 'not a PNG'}, ${still.data.length} bytes`);
  const stillPic = await measure(page, asUrl(still.data));
  check('… of the model in red on the backdrop, opaque', stillPic.std > 10 && stillPic.alpha > 254 && stillPic.middle[0] > stillPic.middle[1] * 1.2, `spread ${stillPic.std.toFixed(1)}`);
  check('… and the panel says what was saved', /Saved Bracket\.png/.test(await page.textContent('[data-render-last]')));
  // wider than one tile: traced in two, with no seam between them
  const wide = await saved(page, () => page.evaluate(() => { void window.JunctionRenderMode.saveImage({ width: 1300, height: 96, samples: 3 }); }));
  const wideSize = pngSize(wide.data);
  if (SHOTS) fs.writeFileSync(`${SHOTS}/render-wide.png`, wide.data);
  const seam = await page.evaluate(async (url) => {
    const img = new Image(); await new Promise((ok) => { img.onload = ok; img.src = url; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    // the backdrop either side of the join (the top rows are backdrop): the same colour
    const a = g.getImageData(646, 2, 4, 8).data, b = g.getImageData(650, 2, 4, 8).data;
    let d = 0; for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
    return d;
  }, asUrl(wide.data));
  check('a picture wider than one tile is traced in two and joined without a seam', !!wideSize && wideSize.width === 1300 && wideSize.height === 96 && seam <= 3, `${wideSize ? wideSize.width + ' × ' + wideSize.height : 'not a PNG'}, the join differs by ${seam}`);
  // transparent: the model alone
  await pickOption(page, '[data-render=background]', 'transparent');
  const clear = await saved(page, () => page.evaluate(() => { void window.JunctionRenderMode.saveImage({ width: 200, height: 150, samples: 4 }); }));
  const clearPic = await measure(page, asUrl(clear.data));
  check('with no backdrop the PNG is transparent round the model', clearPic.alpha > 20 && clearPic.alpha < 200, `mean coverage ${(clearPic.alpha / 2.55).toFixed(0)} %`);
  await pickOption(page, '[data-render=background]', 'color');

  // ---------------------------------------------------------------- a turntable film
  await page.click('[data-render-film-toggle]');
  await page.waitForSelector('[data-render-film]');
  await page.evaluate(() => window.JunctionRenderMode.setTurntable({ duration: 1, fps: 8, width: 160, height: 120, samples: 3, path: 'orbit', axis: 'z', elevation: 25 }));
  check('the film is set up in the panel: eight frames of 160 × 120', /8 frames, 160 × 120/.test(await page.textContent('[data-render-film]')), (await page.textContent('[data-render-film]')).match(/\d+ frames[^R]*/)?.[0]);
  const t1 = Date.now();
  let sawProgress = '';
  const watch = setInterval(() => { page.textContent('[data-render-status]').then((t) => { if (/frame \d+ of 8/.test(t || '')) sawProgress = t; }).catch(() => {}); }, 400);
  const film = await saved(page, () => page.click('[data-render-film-start]'));
  clearInterval(watch);
  if (SHOTS) fs.writeFileSync(`${SHOTS}/render-${film.name}`, film.data);
  const kind = film.data.subarray(4, 8).toString('latin1') === 'ftyp' ? 'mp4' : film.data.readUInt32BE(0) === 0x1a45dfa3 ? 'webm' : 'other';
  check('Render film hands over a film: an MP4, or a WebM where the browser has no H.264 encoder', (kind === 'mp4' && /turntable\.mp4$/.test(film.name)) || (kind === 'webm' && /turntable\.webm$/.test(film.name)), `${film.name}, ${film.data.length} bytes in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  check('… with its progress shown frame by frame while it renders', /frame \d+ of 8/.test(sawProgress), sawProgress);
  const played = await page.evaluate(async ({ url }) => {
    const v = document.createElement('video'); v.muted = true; v.src = url;
    await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('the film did not load: ' + (v.error && v.error.message))); });
    const frames = [];
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d', { willReadFrequently: true });
    for (const t of [0.01, 0.4, 0.8]) {
      await new Promise((ok) => { v.onseeked = ok; v.currentTime = t; });
      g.drawImage(v, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data; let sum = 0, sq = 0; const grey = [];
      for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; if ((i / 4) % 97 === 0) grey.push(l); }
      const n = d.length / 4; frames.push({ mean: sum / n, std: Math.sqrt(sq / n - (sum / n) ** 2), grey });
    }
    return { width: v.videoWidth, height: v.videoHeight, duration: v.duration, frames };
  }, { url: asUrl(film.data, kind === 'mp4' ? 'video/mp4' : 'video/webm') }).catch((e) => ({ error: String(e) }));
  const moved = played.frames ? played.frames[0].grey.reduce((s, v, i) => s + Math.abs(v - played.frames[1].grey[i]), 0) / played.frames[0].grey.length : 0;
  check('the film plays: 160 × 120, a second long, the model in every frame and turning', !played.error && played.width === 160 && played.height === 120 && Math.abs(played.duration - 1) < 0.2 && played.frames.every((fr) => fr.std > 8) && moved > 1.5, played.error || `${played.width} × ${played.height}, ${played.duration.toFixed(2)} s, frames differ by ${moved.toFixed(1)}`);
  // where there is no video encoder: the frames as PNG files in a zip
  const zip = await saved(page, () => page.evaluate(() => { void window.JunctionRenderMode.setTurntable({ duration: 0.5, fps: 6 }); void window.JunctionRenderMode.renderFilm(['png-zip']); }));
  const names = zipNames(zip.data);
  check('with no video encoder the film is a zip of its frames as PNGs', /turntable\.zip$/.test(zip.name) && names.length === 3 && names[0] === 'frame-0001.png' && names[2] === 'frame-0003.png', `${zip.name}: ${names.join(', ')}`);
  // a long film, cancelled
  await page.waitForFunction(() => !window.JunctionRenderMode.getState().job, null, { timeout: 60000 });
  await page.evaluate(() => window.JunctionRenderMode.setTurntable({ duration: 20, fps: 30, width: 320, height: 240, samples: 16 }));
  await page.waitForFunction(() => /600 frames/.test(document.querySelector('[data-render-film]')?.textContent || ''), null, { timeout: 10000 });
  await page.locator('[data-render-film-start]').scrollIntoViewIfNeeded();
  await page.click('[data-render-film-start]');
  // While a film renders the page answers between samples but SwiftShader leaves it few animation frames, and
  // Playwright's own waits and clicks wait for those: the button is found by polling and pressed by its handler.
  await page.waitForFunction(() => /frame \d+ of 600/.test(document.querySelector('[data-render-status]')?.textContent || '') && !!document.querySelector('[data-render-cancel]'), null, { timeout: 60000, polling: 250 });
  await page.$eval('[data-render-cancel]', (b) => b.click());
  await page.waitForFunction(() => !window.JunctionRenderMode.getState().job, null, { timeout: 120000 });
  check('a film of 600 frames is cancelled from the panel, and the live picture comes back', (await mode(page)).job === null);
  await samples(page, 2);

  // ---------------------------------------------------------------- hidden, and a lost context
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(400);
  const paused = (await mode(page)).samples;
  await page.waitForTimeout(2500);
  m = await mode(page);
  check('the picture pauses while the tab is hidden', m.phase === 'paused' && m.samples === paused, `${m.phase}, ${paused} → ${m.samples} samples`);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForFunction((n) => window.JunctionRenderMode.getState().samples > n, paused, { timeout: 120000 });
  check('… and carries on when it is shown again', true);
  await page.evaluate(() => { const c = document.querySelector('canvas[data-render-canvas]'); const gl = c.getContext('webgl2'); gl.getExtension('WEBGL_lose_context').loseContext(); });
  await page.waitForFunction(() => !window.JunctionRenderMode.getState().on, null, { timeout: 20000 });
  const lost = await page.evaluate(() => ({ panel: !!document.querySelector('[data-render-panel]'), canvas: !!document.querySelector('canvas[data-render-canvas]'), error: window.JunctionRenderMode.getState().error, bodies: window.JunctionPartStudio.getState().bodies.length }));
  check('a lost graphics context ends Render mode with a sentence, and the viewport is as it was', !lost.panel && !lost.canvas && /context was lost/.test(lost.error) && lost.bodies === 1, lost.error);
  // and it can be turned on again, and off with Close
  await search(page, 'JunctionPartStudio', 's', 'render');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-render-panel]', { timeout: 60000 });
  await samples(page, 2);
  await page.click('[data-render-close]');
  await page.waitForSelector('[data-render-panel]', { state: 'detached' });
  check('Render is turned on again after that, and Close leaves it: its canvas is gone', (await page.$$('canvas[data-render-canvas]')).length === 0 && !(await mode(page)).on);

  // ================================================================ an assembly
  await page.goto(`${BASE}/p/${pid}/edit?doc=${asmDoc}`);
  await page.waitForFunction(() => { const a = window.JunctionAssembly, s = a && a.getState(); return !!s && s.loaded && s.instances.length === 4 && s.instances.every((i) => s.instanceInfo[i.id]?.status === 'ready'); }, null, { timeout: 180000 });
  await page.evaluate(() => { const a = window.JunctionAssembly; a.viewport.setProjection('perspective'); a.fit(); });
  await page.waitForTimeout(600);
  const asmRaster = await measure(page, asUrl(await stage(page, 'assembly-viewport')));
  const asmFound = {};
  for (const word of ['render', 'raytrace', 'turntable']) { asmFound[word] = await search(page, 'JunctionAssembly', 's', word); await closeSearch(page); }
  check('the assembly\'s tool search finds Render by "render", "raytrace" and "turntable"', Object.values(asmFound).every((t) => t[0] === 'Render'), JSON.stringify(Object.fromEntries(Object.entries(asmFound).map(([k, v]) => [k, v.slice(0, 2)]))));
  await search(page, 'JunctionAssembly', 's', 'render');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-render-panel]', { timeout: 60000 });
  await samples(page, 6);
  const asmPic = await measure(page, await picture(page));
  await shot(page, '04-assembly');
  m = await mode(page);
  check('the assembly is rendered: its panel in the dock, the picture over the viewport', m.on && m.samples >= 6 && asmPic.std > 12 && differ(await measure(page, asUrl(await stage(page))), asmRaster) > 3, `${m.triangles} triangles, spread ${asmPic.std.toFixed(1)}`);
  // each part in the look its part studio gives it: the plate is blue anodised aluminium, the knob red
  const looks = await page.evaluate(async () => {
    const scene = await window.JunctionRenderMode.source.scene();
    return scene.meshes.map((x) => ({ color: x.groups[0].surface.color.map((v) => Math.round(v * 100) / 100), metal: x.groups[0].surface.metalness, transmission: x.groups[0].surface.transmission, ior: x.groups[0].surface.ior, clearcoat: x.groups[0].surface.clearcoat }));
  });
  check('each part is rendered in the look its part studio gives it: anodised aluminium, steel, red plastic, clear acrylic', looks.length === 4 && looks[0].metal === 1 && looks[0].color[2] > looks[0].color[0] * 2 && looks[0].clearcoat > 0 && looks[1].metal === 1 && looks[2].metal === 0 && looks[2].color[0] > looks[2].color[1] * 2 && looks[3].transmission === 1 && Math.abs(looks[3].ior - 1.49) < 1e-9, JSON.stringify(looks));
  const motions = await page.evaluate(() => window.JunctionRenderMode.source.motions().map((x) => x.title));
  check('the assembly can be filmed coming apart', motions.includes('Coming apart'), motions.join(', '));
  await page.click('[data-render-film-toggle]');
  await pickOption(page, '[data-render=film-of]', 'explode');
  await page.evaluate(() => window.JunctionRenderMode.setTurntable({ duration: 0.5, fps: 6, width: 160, height: 120, samples: 2 }));
  const apart = await saved(page, () => page.click('[data-render-film-start]'));
  if (SHOTS) fs.writeFileSync(`${SHOTS}/render-${apart.name}`, apart.data);
  const after = await page.evaluate(() => ({ exploding: window.JunctionAssembly.getState().exploding, job: window.JunctionRenderMode.getState().job }));
  check('… three frames of it, and the assembly is put back together afterwards', /explode\.(mp4|webm)$/.test(apart.name) && apart.data.length > 500 && after.exploding === false && after.job === null, `${apart.name}, ${apart.data.length} bytes`);
  await page.click('[data-render-close]');
  await page.waitForSelector('[data-render-panel]', { state: 'detached' });
  check('Close ends it: the panel leaves the dock and the canvas goes', (await page.$$('canvas[data-render-canvas]')).length === 0 && !(await page.evaluate(() => window.JunctionAssembly.getState().panels.some((p) => p.id === 'render'))));

  // ================================================================ off: nothing of it is there
  check('nothing was logged as an error', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  // with the CAD setting off the engine is never fetched (there is no part studio to turn it on in)
  const uid2 = user('cad-render-off', 990078);
  const ctx2 = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const p2 = await ctx2.newPage();
  const fetched = [];
  p2.on('request', (r) => { if (/cad-render\.js|mechanical\.js|assembly\.js/.test(r.url())) fetched.push(r.url()); });
  await p2.goto(`${BASE}/auth/dev?jwt=${jwt(uid2, 'cad-render-off')}&next=/`);
  await p2.waitForLoadState('networkidle');
  const made = await p2.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No CAD', template: 'pcb' }) })).json()));
  await p2.goto(`${BASE}/p/${made.projectId}/edit`);
  await p2.waitForLoadState('networkidle');
  await p2.waitForTimeout(1500);
  check('with Mechanical CAD off the render engine is never fetched', fetched.length === 0, fetched.join(' '));
  await ctx2.close();
} catch (e) {
  check('the script ran to its end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
