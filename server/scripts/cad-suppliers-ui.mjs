// Test of 3D models from suppliers (server/src/models3d, web/domains/assembly/suppliers): the server's providers
// over HTTP against the stand-ins of scripts/fake-models.mjs, then the real app in Chromium — the Insert dialog's
// Suppliers tab: search a size and a part number, see the results, click one, and it is an instance like any other.
//
// The providers read their settings when the server starts, so "not connected" and "connected" are two runs of
// this script against two servers; it looks at GET /api/models3d/providers and checks what that server should do.
//
//   node scripts/fake-vendors.mjs &          # FAKE_VENDORS_PORT=8097; it mounts fake-models.mjs
//   V=http://127.0.0.1:8097
//
//   # run 1 — no supplier credentials: standard parts, LCSC, the KiCad and FreeCAD libraries, and McMaster-Carr
//   #         numbers answered with a generated equivalent
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 \
//   EASYEDA_API_URL=$V EASYEDA_MODELS_URL=$V JLCPCB_API_URL=$V JLCSEARCH_URL=$V KICAD_LIBS_URL=$V \
//   FREECAD_LIBRARY_API_URL=$V FREECAD_LIBRARY_RAW_URL=$V MCMASTER_API_URL=$V TRACEPARTS_API_URL=$V cargo run
//
//   # run 2 — the same, with the stand-ins' credentials: McMaster-Carr's API, TraceParts, a library of one's own
//   … MCMASTER_USERNAME=test-mcmaster MCMASTER_PASSWORD=test-mcmaster-password \
//     TRACEPARTS_TENANT_UID=test-tenant TRACEPARTS_API_KEY=test-traceparts-key TRACEPARTS_USER_EMAIL=cad@example.com \
//     MODELS3D_LIBRARY_URL=$V/library cargo run
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [E2E_FAKE_VENDORS=$V] [SHOTS=/some/dir] \
//     node scripts/cad-suppliers-ui.mjs
//
// As scripts/cad-assembly-ui.mjs: KC_DEV_LOGIN=1, Playwright, psql; E2E_LOCAL_DIST=static/dist serves bundles newer
// than the server binary.  Waits are on the assembly's own state, not on timers.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { setCad } from './cad-setting.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const FAKE = (process.env.E2E_FAKE_VENDORS || 'http://127.0.0.1:8097').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', PREFIX = process.env.SHOT_PREFIX || '';
const LOCAL = process.env.E2E_LOCAL_DIST ? path.resolve(process.env.E2E_LOCAL_DIST) : '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/${PREFIX}${name}.png` }); } };

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
const ctl = async (what, body) => (await fetch(`${FAKE}/__ctl/${what}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();

const aliceId = user('sup-ui-alice', 990031), offId = user('sup-ui-off', 990032);
const alice = jwt(aliceId, 'sup-ui-alice');
sql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (990031, 990032))");
// models kept by an earlier run would hide whether this one fetched them
sql("DELETE FROM part_models WHERE uuid LIKE 'm3d:%' OR uuid LIKE 'kicad:%'");
await setCad(BASE, alice);
await ctl('reset', {});

const api = async (token, pathAndQuery) => {
  const r = await fetch(BASE + pathAndQuery, { headers: { Authorization: `Bearer ${token}` } });
  const type = r.headers.get('content-type') || '';
  const bytes = Buffer.from(await r.arrayBuffer());
  let j = null; if (type.includes('json')) { try { j = JSON.parse(bytes.toString('utf8')); } catch { /* not json */ } }
  return { status: r.status, type, format: r.headers.get('x-model-format'), bytes, j };
};
const search = async (q) => (await api(alice, `/api/models3d/search?q=${encodeURIComponent(q)}`)).j;
const model = (provider, id, token = alice) => api(token, `/api/models3d/model?provider=${provider}&id=${encodeURIComponent(id)}`);
const sized = (got, want, eps = 0.05) => !!got && got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= eps);
const isStep = (r) => r.status === 200 && r.format === 'step' && r.bytes.subarray(0, 12).toString() === 'ISO-10303-21';

// ================================================================ the server's providers, over HTTP
const providers = (await api(alice, '/api/models3d/providers')).j.providers;
const configured = (id) => !!providers.find((p) => p.id === id)?.configured;
const WITH = configured('mcmaster');
console.log(`\n== providers (${WITH ? 'run 2: suppliers connected' : 'run 1: no supplier credentials'}) ==`);
check('the providers that need nothing are always there', ['standard', 'lcsc', 'kicad', 'freecad'].every(configured), providers.map((p) => `${p.id}:${p.configured}`).join(' '));
check('McMaster-Carr, TraceParts and a library say which settings connect them', ['mcmaster', 'traceparts', 'library'].every((id) => providers.find((p) => p.id === id)?.needs.length > 0)
  && providers.find((p) => p.id === 'mcmaster').needs.includes('MCMASTER_CLIENT_CERT'));
check('McMaster-Carr, TraceParts and the library are connected together or not at all in this test', configured('traceparts') === WITH && configured('library') === WITH);
{
  const off = await api(jwt(offId, 'sup-ui-off'), '/api/models3d/search?q=M5x20');
  check('with Mechanical CAD off the search is refused', off.status === 403 && off.j.error === 'cad_off', `${off.status} ${off.j && off.j.error}`);
  const anon = await fetch(`${BASE}/api/models3d/search?q=M5x20`);
  check('and nobody searches without signing in', anon.status === 401, String(anon.status));
}

console.log('\n== standard parts ==');
{
  const r = await search('M5x20 socket head');
  const h = r.results[0];
  check('"M5x20 socket head" is the ISO 4762 screw, drawn by Junction', h && h.provider === 'standard' && h.id === 'shcs:M5:20' && h.title === 'ISO 4762 M5x20' && h.format === 'jpart' && h.generated && !h.equivalent, JSON.stringify(h && [h.id, h.title, h.format]));
  check('with its size and an outline for the row', h && JSON.stringify(h.size) === '[8.5,8.5,25]' && h.thumb && h.thumb.d.startsWith('M') && h.thumb.box.length === 4, JSON.stringify(h && h.size));
  check('"DIN 912 M5x20" is the same part', (await search('DIN 912 M5x20')).results[0]?.id === 'shcs:M5:20');
  check('an inch size reads too', (await search('1/4-20 x 1 button head')).results[0]?.id === 'button:1/4:1in');
  check('a thread alone offers what goes on it', (await search('M5')).results.slice(0, 2).map((x) => x.id).join() === 'nut:M5,washer:M5');
  const m = await model('standard', 'shcs:M5:20');
  const doc = m.status === 200 && m.format === 'jpart' ? JSON.parse(m.bytes.toString('utf8')) : null;
  check('its model is a part studio: sketches, a revolve, an extrude', !!doc && doc.junction === 'part-studio' && ['sketch', 'revolve', 'plane', 'extrude'].every((t) => doc.items.some((i) => i.featureType === t)), `${m.status} ${m.format}`);
  check('a size the standard does not have is not found', (await model('standard', 'shcs:M7:20')).status === 404 && (await api(alice, '/api/models3d/model?provider=nope&id=x')).status === 400);
  check('no error and no supplier is asked for a size alone', r.errors.length === 0, JSON.stringify(r.errors));
}

console.log('\n== LCSC, the KiCad library, the FreeCAD library ==');
{
  const l = (await search('C25804')).results;
  check('an LCSC number is that part, with a model and a picture', l.length === 1 && l[0].provider === 'lcsc' && l[0].title === 'LCSC C25804' && l[0].format === 'step' && l[0].image.includes('/api/parts/image'), JSON.stringify(l.map((x) => [x.title, x.format])));
  const before = (await ctl('hits')).model || 0;
  const a = await model('lcsc', 'C25804'), b = await model('lcsc', 'C25804');
  check('its STEP file is EasyEDA\'s, fetched once and kept', isStep(a) && isStep(b) && a.bytes.length > 100000 && ((await ctl('hits')).model || 0) - before <= 1, `${a.status} ${a.bytes.length} bytes`);
  check('an LCSC number that does not exist finds nothing', (await search('C999999999')).results.length === 0);

  const k = (await search('usb_c gct')).results.filter((x) => x.provider === 'kicad');
  check('KiCad\'s 3D library is searched by words', k.length === 1 && k[0].title === 'KiCad USB_C_Receptacle_GCT_USB4085' && k[0].id === 'Connector_USB/USB_C_Receptacle_GCT_USB4085' && /CC-BY-SA/.test(k[0].license) && k[0].url.includes('kicad-packages3D'), JSON.stringify(k.map((x) => x.id)));
  check('and gives the model', isStep(await model('kicad', k[0]?.id || 'x/y')));
  check('a model the library does not have is not found', (await model('kicad', 'Connector_USB/Nope')).status === 404);

  const f = (await search('608')).results;
  check('"608" is the bearing Junction draws and the FreeCAD library\'s file', f[0]?.id === 'bearing:608' && f.some((x) => x.provider === 'freecad' && x.part_number === '608ZZ' && /CC BY 3\.0/.test(x.license) && x.url.startsWith('https://github.com/FreeCAD/FreeCAD-library/blob/master/Mechanical%20Parts/')), JSON.stringify(f.map((x) => x.id)));
  const id = f.find((x) => x.provider === 'freecad')?.id || '';
  const h0 = (await ctl('hits'))['freecad-file'] || 0;
  const one = await model('freecad', id), two = await model('freecad', id);
  check('its file is fetched once and kept beside the vendor models', isStep(one) && isStep(two) && ((await ctl('hits'))['freecad-file'] || 0) - h0 === 1 && sql(`SELECT count(*) FROM part_models WHERE uuid = 'm3d:freecad:${id.replace(/'/g, "''")}'`) === '1');
  check('only STEP files of the library are offered', (await search('aluminium profile')).results.every((x) => x.provider !== 'freecad'));
  check('and only files its listing has are fetched', (await model('freecad', '../../etc/passwd.step')).status === 404);
}

console.log('\n== McMaster-Carr ==');
if (!WITH) {
  const alone = (await search('91251A431')).results;
  check('a number alone, without the API: what it is, its page, and what to type', alone.length === 1 && alone[0].provider === 'mcmaster' && alone[0].format === '' && alone[0].url === 'https://www.mcmaster.com/91251A431/' && /socket head screw/.test(alone[0].description) && alone[0].hint === '91251A431 1/4-20 x 1', JSON.stringify(alone));
  const eq = (await search('91251A431 1/4-20 x 1')).results;
  check('with its size: one row, the generated equivalent, said to be one', eq.length === 1 && eq[0].title === 'McMaster-Carr 91251A431' && eq[0].format === 'jpart' && eq[0].generated && eq[0].equivalent && /not McMaster-Carr's own model/.test(eq[0].note) && eq[0].url === 'https://www.mcmaster.com/91251A431/', JSON.stringify(eq.map((x) => [x.title, x.format, x.equivalent])));
  const m = await model('mcmaster', eq[0]?.id || '');
  const doc = m.format === 'jpart' ? JSON.parse(m.bytes.toString('utf8')) : null;
  const said = doc && doc.items.find((i) => i.id === 'standard-part');
  check('its part studio names McMaster\'s number and links to McMaster\'s page', !!said && said.title === 'McMaster-Carr 91251A431' && said.link === 'https://www.mcmaster.com/91251A431/' && said.spec === 'shcs:1/4:1in');
  check('a metric size for an inch family is not offered as that part', (await search('91251A431 M5x20')).results[0]?.format === '');
  check('a number of a family Junction does not know is linked and not drawn', (await search('6384K365')).results[0]?.format === '' && (await search('6384K365')).results[0]?.url === 'https://www.mcmaster.com/6384K365/');
  const real = await model('mcmaster', '91251A431');
  check('McMaster\'s own model is not fetched without the API, and its website is never asked', real.status === 409 && real.j.error === 'vendor_not_configured' && !(await ctl('hits')).mcmaster, `${real.status} ${JSON.stringify(await ctl('hits'))}`);
  check('"not connected" is a state of the provider, not an error of the search', (await search('91251A431')).errors.length === 0);
} else {
  const r = (await search('91251A431')).results;
  check('a number, through the API: McMaster\'s own description, picture and STEP model', r.length === 1 && r[0].format === 'step' && !r[0].generated && r[0].description === 'Black-Oxide Alloy Steel Socket Head Screw, 1/4"-20 Thread Size, 1" Long' && r[0].image.includes('/api/models3d/image'), JSON.stringify(r));
  const hits = await ctl('hits');
  check('the account logged in once and subscribed to the product once', hits['mcmaster-login'] === 1 && hits['mcmaster-subscribe'] === 1, JSON.stringify(hits));
  const a = await model('mcmaster', '91251A431'), b = await model('mcmaster', '91251A431');
  check('its STEP file comes through the API once and is kept', isStep(a) && isStep(b) && a.bytes.toString().includes('McMaster-Carr 91251A431') && (await ctl('hits'))['mcmaster-cad'] === 1);
  const img = await api(alice, '/api/models3d/image?provider=mcmaster&id=91251A431');
  check('its picture too', img.status === 200 && img.type === 'image/png');
  const none = (await search('7122K19')).results;
  check('a part McMaster lists without CAD is shown and cannot be placed', none.length === 1 && none[0].format === '' && /no STEP model/.test(none[0].note) && (await model('mcmaster', '7122K19')).status === 404);
  const missing = await search('99999A999');
  check('a number McMaster does not have finds nothing, without an error', missing.results.length === 0 && missing.errors.length === 0, JSON.stringify(missing));
  await ctl('down', { mcmaster: true });
  const down = await search('92196A537');
  check('McMaster-Carr being down is said, and the other providers still answer', down.errors.length === 1 && down.errors[0].provider === 'mcmaster' && down.errors[0].code === 'vendor_unreachable', JSON.stringify(down.errors));
  await ctl('down', {});

  console.log('\n== TraceParts and a library of one\'s own ==');
  const t = (await search('mgn12')).results.filter((x) => x.provider === 'traceparts');
  check('TraceParts is searched by words', t.length === 1 && t[0].title === 'HIWIN MGN12H-1R300' && t[0].supplier === 'HIWIN' && t[0].format === 'step', JSON.stringify(t));
  check('and its model is asked for, waited for and fetched', isStep(await model('traceparts', t[0]?.id || 'x')));
  const l = (await search('bracket')).results.filter((x) => x.provider === 'library');
  check('the library lists its own parts by supplier and part number', l.length === 1 && l[0].title === 'Acme BR-40' && l[0].url === 'https://parts.acme.example/BR-40' && l[0].license === 'Internal use', JSON.stringify(l));
  check('and serves their files', isStep(await model('library', 'acme-bracket-40')));
  check('a part without a supplier is the library\'s', (await search('knurled knob')).results.find((x) => x.provider === 'library')?.title === 'Acme parts KN-6');
  check('a file outside the library is never offered or fetched', (await search('XX-1')).results.every((x) => x.provider !== 'library') && (await model('library', 'acme-escape')).status === 404);
}

// ================================================================ the app
console.log('\n== the Insert dialog ==');
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light' });
  if (LOCAL) {
    for (const f of ['assembly.js', 'mechanical.js', 'cad-worker.js', 'ui.css']) {
      await ctx.route(new RegExp(`/static/dist/${f.replace('.', '\\.')}(\\?.*)?$`), (route) => route.fulfill({ path: path.join(LOCAL, f), contentType: f.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }));
    }
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${alice}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Supplier models test', template: 'pcb' }) })).json()));
  const pid = project.projectId;
  await page.goto(`${BASE}/p/${pid}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New assembly');
  await page.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });

  const settled = (n) => page.waitForFunction((n) => {
    const a = window.JunctionAssembly, s = a && a.getState();
    return !!s && s.loaded && !s.building && s.instances.length === n && s.instances.every((i) => i.suppressed || s.instanceInfo[i.id]?.status === 'ready') && a.session.unsaved === 0;
  }, n, { timeout: 180000 });
  /** An instance by name: its supplier, whether it is ready, and the size of what it shows. */
  const inst = (name) => page.evaluate((name) => {
    const a = window.JunctionAssembly, s = a.getState(), i = s.instances.find((x) => x.name === name);
    if (!i) return null;
    const p = a.placed().find((x) => x.item.id === i.id), b = p && p.pieces[0] ? p.pieces[0].mesh.bbox : null;
    return { id: i.id, supplier: i.supplier || null, source: i.source, status: s.instanceInfo[i.id]?.status, fixed: !!i.fixed, size: b ? [b[3] - b[0], b[4] - b[1], b[5] - b[2]].map((v) => Math.round(v * 100) / 100) : null, x: a.transformOf(i.id)[3] };
  }, name);
  const docsOf = () => page.evaluate(async (pid) => (await (await fetch(`/api/projects/${pid}/info`, { headers: { 'content-type': 'application/json' } })).json()).docs.map((d) => d.path).sort(), pid);
  const openSuppliers = async () => {
    if (!(await page.isVisible('[data-insert-dialog]'))) await page.click('[data-tool=Insert]');
    await page.waitForSelector('[data-insert-dialog] [data-insert-tab=suppliers]');
    if (!(await page.isVisible('[data-supplier-search]'))) await page.click('[data-insert-tab=suppliers]');
    await page.waitForSelector('[data-supplier-query]');
  };
  const type = async (q) => { await page.fill('[data-supplier-query]', q); await page.waitForSelector('[data-supplier-search][data-state=done]', { timeout: 30000 }); await page.waitForFunction((q) => document.querySelector('[data-supplier-query]').value === q, q); };
  const rows = () => page.$$eval('[data-supplier-search] [data-model]', (els) => els.map((e) => ({ title: e.getAttribute('data-model'), provider: e.getAttribute('data-provider'), format: e.getAttribute('data-format'), kind: e.querySelector('[data-kind]')?.textContent || '', thumb: e.querySelector('[data-thumb]')?.getAttribute('data-thumb'), link: e.querySelector('a[data-supplier-link]')?.getAttribute('href') || '', text: e.textContent })));

  // ---------------------------------------------------------------- the tab, and a standard part
  await page.click('[data-tool=Insert]');
  await page.waitForSelector('[data-insert-dialog]');
  check('Insert opens on the project\'s own parts, with a Suppliers tab beside it', await page.isVisible('[data-insert-tab=project][aria-selected=true]') && await page.isVisible('[data-insert-tab=suppliers]') && !(await page.isVisible('[data-supplier-search]')));
  await openSuppliers();
  check('the Suppliers tab asks for a part number or a size, with examples to click', await page.isVisible('[data-supplier-query]') && (await page.$$('[data-example]')).length >= 5);
  await shot(page, '01-suppliers-tab');
  await type('M5x20 socket head');
  let list = await rows();
  check('typing a size lists the matching models: supplier, part number, description, format, a picture', list[0]?.title === 'ISO 4762 M5x20' && list[0].provider === 'standard' && list[0].kind === 'Generated' && list[0].thumb === 'outline' && /Socket head cap screw M5 × 20 mm/.test(list[0].text) && /8\.5 × 8\.5 × 25 mm/.test(list[0].text), JSON.stringify(list.map((r) => [r.title, r.kind, r.thumb])));
  check('the FreeCAD library\'s own file of it is offered beside it, as a STEP model with its page', list.some((r) => r.provider === 'freecad' && r.kind === 'STEP' && r.link.startsWith('https://github.com/FreeCAD/')), JSON.stringify(list.map((r) => [r.provider, r.kind])));
  const off = await page.$eval('[data-not-configured]', (e) => e.textContent).catch(() => '');
  check(WITH ? 'every provider is connected: nothing is listed as missing' : 'the providers without credentials are named as not connected, not as errors', WITH ? off === '' : /McMaster-Carr/.test(off) && /TraceParts/.test(off) && (await page.$$('[data-provider-error]')).length === 0, off);
  await shot(page, '02-results');
  const docs0 = await docsOf();
  await page.click('[data-supplier-search] [data-model="ISO 4762 M5x20"]');
  await settled(1);
  let screw = await inst('ISO 4762 M5x20');
  check('a click places it at once: an instance named after the part, built by the kernel to the standard\'s size', !!screw && screw.status === 'ready' && sized(screw.size, [8.5, 8.5, 25]) && screw.source.kind === 'part', JSON.stringify(screw));
  check('it remembers where it came from', screw?.supplier?.provider === 'standard' && screw.supplier.title === 'ISO 4762 M5x20' && screw.supplier.generated === true && screw.supplier.id === 'shcs:M5:20', JSON.stringify(screw?.supplier));
  const docs1 = await docsOf();
  check('and is a part studio of the project', docs1.includes('ISO 4762 M5x20.jpart') && docs1.length === docs0.length + 1, docs1.join(', '));
  check('the dialog closes on the model, as Insert does', !(await page.isVisible('[data-insert-dialog]')));
  await shot(page, '03-screw-placed');

  // again: another instance of the same studio, beside the first
  await openSuppliers();
  check('the tab is remembered', await page.isVisible('[data-supplier-search]'));
  await type('DIN 912 M5x20');
  await page.click('[data-supplier-search] [data-model="ISO 4762 M5x20"]');
  await settled(2);
  const second = await inst('ISO 4762 M5x20 2');
  check('placing it again adds an instance of the same part studio, set beside the first', !!second && second.source.docId === screw.source.docId && second.x > 5 && (await docsOf()).length === docs1.length, JSON.stringify(second));

  // a mate, picked in the model: the two screws' shanks, which are true cylinders
  const at = (p) => page.evaluate((p) => { const v = window.JunctionAssembly.viewport, q = v.project(v.target.clone().set(p[0], p[1], p[2])), r = v.canvas.getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; }, p);
  const pick = async (p) => { const q = await at(p); await page.mouse.move(q.x, q.y, { steps: 4 }); await page.mouse.down(); await page.mouse.up(); };
  await page.evaluate(() => window.JunctionAssembly.fit());
  await page.click('[data-mate-tool=parallel]');
  await page.waitForSelector('[data-mate-dialog=parallel] [data-connector=a][data-armed]');
  await pick([0, 0, -12]);
  await page.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]', { timeout: 10000 });
  await pick([second.x, 0, -12]);
  await page.waitForSelector('[data-mate-dialog] [data-connector=b][data-set]', { timeout: 10000 });
  await shot(page, '03b-mate');
  await page.click('[data-mate-dialog] [data-accept]');
  await page.waitForFunction(() => window.JunctionAssembly.getState().mates.length === 1 && window.JunctionAssembly.session.unsaved === 0, null, { timeout: 20000 });
  const mateNow = await page.evaluate(() => { const s = window.JunctionAssembly.getState(), m = s.mates[0]; return { type: m.mateType, state: s.mateInfo[m.id]?.state, a: m.a.ref.name, b: m.b.ref.name }; });
  check('it mates like any part: a mate picked on the two screws in the model holds', mateNow.type === 'parallel' && mateNow.state !== 'error' && !!mateNow.a && !!mateNow.b, JSON.stringify(mateNow));

  // ---------------------------------------------------------------- a McMaster-Carr number
  await openSuppliers();
  if (!WITH) {
    await type('91251A431');
    list = await rows();
    check('a McMaster-Carr number without the API: the row says what it is and what to type, and cannot be placed', list.length === 1 && list[0].title === 'McMaster-Carr 91251A431' && list[0].format === '' && /Type its size/.test(list[0].text) && list[0].link === 'https://www.mcmaster.com/91251A431/', JSON.stringify(list));
    await shot(page, '04-mcmaster-number');
    await page.click('[data-supplier-search] [data-model="McMaster-Carr 91251A431"]');
    await page.waitForFunction(() => document.querySelector('[data-supplier-query]').value === '91251A431 1/4-20 x 1');
    await page.waitForSelector('[data-supplier-search] [data-model][data-format=jpart]', { timeout: 30000 });
    list = await rows();
    check('clicking it fills in an example size, and the row becomes a generated equivalent, said to be one', list.length === 1 && list[0].kind === 'Generated equivalent' && /Not McMaster-Carr's own model/.test(list[0].text) && list[0].link === 'https://www.mcmaster.com/91251A431/', JSON.stringify(list));
    await shot(page, '05-mcmaster-equivalent');
  } else {
    await type('91251A431');
    list = await rows();
    check('a McMaster-Carr number through the API: McMaster\'s own STEP model, with their picture', list.length === 1 && list[0].title === 'McMaster-Carr 91251A431' && list[0].kind === 'STEP' && list[0].thumb === 'photo' && list[0].link === 'https://www.mcmaster.com/91251A431/', JSON.stringify(list));
    await shot(page, '04-mcmaster-api');
  }
  await page.click('[data-supplier-search] [data-model="McMaster-Carr 91251A431"]');
  await settled(3);
  const mc = await inst('McMaster-Carr 91251A431');
  const docs2 = await docsOf();
  if (!WITH) {
    check('it is placed under McMaster\'s name and number, marked as an equivalent', !!mc && mc.status === 'ready' && mc.supplier.title === 'McMaster-Carr 91251A431' && mc.supplier.equivalent === true && mc.supplier.url === 'https://www.mcmaster.com/91251A431/' && sized(mc.size, [9.525, 9.525, 31.75]) && docs2.includes('McMaster-Carr 91251A431.jpart'), JSON.stringify(mc));
  } else {
    check('it is placed from McMaster\'s STEP file, kept in the project and imported by a part studio', !!mc && mc.status === 'ready' && mc.supplier.title === 'McMaster-Carr 91251A431' && !mc.supplier.equivalent && !mc.supplier.generated && sized(mc.size, [9.5, 9.5, 31.75]) && docs2.includes('McMaster-Carr 91251A431.jpart') && docs2.includes('models/McMaster-Carr 91251A431.step'), JSON.stringify([mc, docs2]));
  }
  check('a model new to the assembly is set down beside what is there, not on top of it', !!mc && mc.x > second.x + 5, String(mc && mc.x));
  const link = await page.$eval('[data-instance="McMaster-Carr 91251A431"] a[data-supplier-link]', (a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]).catch(() => null);
  check('its row in the instance list links to the supplier\'s page', !!link && link[0] === 'https://www.mcmaster.com/91251A431/' && link[1] === '_blank' && /noopener/.test(link[2]), JSON.stringify(link));
  check('a standard part has a mark and no link', await page.isVisible('[data-instance="ISO 4762 M5x20"] [data-supplier="ISO 4762 M5x20"]') && !(await page.$('[data-instance="ISO 4762 M5x20"] a[data-supplier-link]')));

  // ---------------------------------------------------------------- an LCSC part: a real STEP file through the Import feature
  await openSuppliers();
  await type('C25804');
  list = await rows();
  // (its photo is LCSC's own link, which this network cannot reach: the row then shows the plain box)
  check('an LCSC number lists the part', list.length === 1 && list[0].title === 'LCSC C25804' && list[0].kind === 'STEP' && list[0].link.includes('lcsc.com'), JSON.stringify(list));
  await page.click('[data-supplier-search] [data-model="LCSC C25804"]');
  await page.waitForSelector('[data-supplier-search] [data-placing]', { timeout: 10000 }).catch(() => {});
  await settled(4);
  const res = await inst('LCSC C25804');
  const docs3 = await docsOf();
  check('it is stored in models/, imported by a part studio as one part (its file holds several solids) and placed', !!res && res.status === 'ready' && res.supplier.title === 'LCSC C25804' && docs3.includes('models/LCSC C25804.step') && docs3.includes('LCSC C25804.jpart') && res.size[0] > 0.5 && res.size[0] < 3, JSON.stringify([res, docs3]));

  // ---------------------------------------------------------------- like any other instance
  await page.evaluate((id) => window.JunctionAssembly.setFixed([id], true), screw.id);
  await page.waitForFunction((id) => window.JunctionAssembly.getState().instances.find((i) => i.id === id).fixed === true, screw.id);
  screw = await inst('ISO 4762 M5x20');
  check('it is fixed like any instance, and keeps its supplier', screw.fixed && screw.supplier.title === 'ISO 4762 M5x20');
  await page.click('[data-tool="Bill of materials"]');
  await page.waitForSelector('.asm-bom[data-state=done]', { timeout: 60000 });
  const bom = await page.$$eval('.asm-bom tbody tr', (trs) => trs.map((tr) => ({ cells: Array.from(tr.children).map((td) => td.textContent), link: tr.querySelector('a[data-supplier-link]')?.getAttribute('href') || '' })));
  const row = (name) => bom.find((r) => r.cells[1] === name);
  check('the bill of materials names each by supplier and part number, with quantities', row('ISO 4762 M5x20')?.cells[3] === '2' && row('McMaster-Carr 91251A431')?.cells[3] === '1' && row('LCSC C25804')?.cells[3] === '1', JSON.stringify(bom.map((r) => r.cells.slice(1, 4))));
  check('and links to the supplier\'s page, with the supplier\'s number in the part column', row('McMaster-Carr 91251A431')?.link === 'https://www.mcmaster.com/91251A431/' && row('McMaster-Carr 91251A431')?.cells[6] === 'McMaster-Carr 91251A431' && (WITH || /generated equivalent/.test(row('McMaster-Carr 91251A431')?.cells[2])), JSON.stringify(row('McMaster-Carr 91251A431')));
  await shot(page, '06-placed-and-bom');

  // ---------------------------------------------------------------- undo, reload
  await page.evaluate(() => window.JunctionAssembly.closePanel('bom'));
  await page.evaluate(() => window.JunctionAssembly.undo());
  await page.evaluate(() => window.JunctionAssembly.undo());
  await settled(3);
  check('undo takes the placed model away again (the fix first, then the part)', !(await inst('LCSC C25804')) && !(await inst('ISO 4762 M5x20')).fixed);
  await page.reload();
  await page.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
  await settled(3);
  const again = await inst('McMaster-Carr 91251A431');
  check('after a reload the instances are there with their suppliers and their links', !!again && again.status === 'ready' && again.supplier.title === 'McMaster-Carr 91251A431' && await page.isVisible('[data-instance="McMaster-Carr 91251A431"] a[data-supplier-link]'));
  await page.click('[data-tool=Insert]');
  await page.waitForSelector('[data-insert-dialog] [data-source-doc]');
  const listed = await page.$$eval('[data-insert-dialog] [data-source-doc]', (els) => els.map((e) => e.getAttribute('data-source-doc')));
  check('the placed models are part studios of the project: the Project tab lists them', listed.includes('ISO 4762 M5x20') && listed.includes('McMaster-Carr 91251A431') && listed.includes('LCSC C25804'), listed.join(', '));
  await page.click('[data-insert-dialog] [data-cancel]');
  await page.evaluate(() => window.JunctionAssembly.fit());
  await shot(page, '07-after-reload');
  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error(e);
  fail++;
  if (errors.length) console.error('page errors:', errors.slice(0, 8).join('\n'));
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) {
    const state = await page.evaluate(() => { const a = window.JunctionAssembly; if (!a) return null; const s = a.getState(); return { instances: s.instances.map((i) => [i.name, s.instanceInfo[i.id]?.status, s.instanceInfo[i.id]?.message]), building: s.building, unsaved: a.session.unsaved, status: s.status.text, dialog: document.querySelector('[data-supplier-search]')?.textContent?.slice(0, 400) }; }).catch(() => null);
    if (state) console.error('assembly state:', JSON.stringify(state));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${PREFIX}failure.png` }).catch(() => {});
  }
} finally {
  await browser.close();
  try { sql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (990031, 990032))"); } catch { /* left for the next run */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
