// Browser test of Mechanical CAD as a setting of each person (web/shared/cad.ts, users.cad_enabled, off by
// default).  Two people share a project: Ada has CAD on and made a part studio that drives the board's outline and
// a mounting hole, a second part studio and an assembly; Bob has CAD off.
//
//   Off:  a new account has CAD off · Bob's tabs, "+", the tab manager and Home's create buttons offer no part
//         studio or assembly · Home lists Ada's CAD documents with the note "Turn on Mechanical CAD in your
//         settings to open", and opening one shows the note with a button · so does a deep link to one · on the
//         board, no "Used in" button, no board-link badge, and the driven items are there, locked and grouped
//         under the part studio's name, and Bob's page writes nothing · no CAD bundle, worker or kernel is
//         fetched, no part studio is read · the MCP endpoint lists no cad_ tool and refuses one by name.
//   On:   from the account menu on the projects page, then into the project without a reload: the tabs, "+" and
//         a part studio open · off from the editor's app menu inside a part studio: the note takes its place ·
//         "Turn on Mechanical CAD and open" opens it again · on the board the badge and "Used in" come and go
//         with the app menu's switch · off again from the account menu · the MCP list follows each time.
//
// Setup as the other *-ui.mjs scripts (KC_DEV_LOGIN=1, Playwright, psql):
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-setting-ui.mjs
//
// Users: github ids 992701-992703.
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
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

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
async function api(token, method, path, body, raw) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': raw ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 200)}`);
  return j;
}
let rpcId = 0;
async function mcp(token, method, params) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const t = await r.text();
  const line = t.startsWith('{') ? t : (t.split('\n').filter((l) => l.startsWith('data: ')).pop() || 'data: {}').slice(6);
  return JSON.parse(line).result;
}
const cadTools = async (token) => (await mcp(token, 'tools/list', {})).tools.map((t) => t.name).filter((n) => n.startsWith('cad_'));

/** A part studio's file: sorted keys, one item per line. */
const sorted = (v) => Array.isArray(v) ? '[' + v.map(sorted).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + sorted(v[k])).join(',') + '}' : JSON.stringify(v);
const itemDoc = (kind, items) => `{"junction":"${kind}","version":1,"items":[\n${items.sort((a, b) => (a.id < b.id ? -1 : 1)).map(sorted).join(',\n')}\n]}\n`;
const TOP = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] };
const rect = (x0, y0, x1, y1) => [['l', x0, y0, x1, y0], ['l', x1, y0, x1, y1], ['l', x1, y1, x0, y1], ['l', x0, y1, x0, y0]].map((c) => c.map((v) => (typeof v === 'number' ? v * 1e6 : v)));
/** A part studio whose board link drives the board's outline and one mounting hole, already solved (as the studio's page stores it). */
const enclosureText = (board) => itemDoc('part-studio', [
  { id: 'studio', rollback: null, type: 'studio', units: 'mm' },
  { id: 'link1', type: 'board-link', board, plane: { kind: 'plane', plane: 'top' }, lift: 0, anchor: [100, 100], rotation: 0,
    drives: {
      o: { kind: 'outline', name: 'Outline', order: 'A', source: { kind: 'sketch', feature: 's' }, inset: 0, cutouts: true },
      h: { kind: 'holes', name: 'Mounting holes', order: 'B', source: { kind: 'sketch', feature: 's' }, diameter: 0, pad: 0 },
    },
    solved: { v: 1, frame: TOP, errors: {}, drives: {
      o: { kind: 'outline', curves: rect(100, 60, 160, 100) },
      h: { kind: 'holes', holes: [[108e6, 68e6, 3.2e6]], pad: 0 },
    } } },
]);
const EMPTY_STUDIO = itemDoc('part-studio', [{ id: 'studio', rollback: null, type: 'studio', units: 'mm' }]);
const EMPTY_ASSEMBLY = itemDoc('assembly', [{ id: 'assembly', type: 'assembly', units: 'mm' }]);
const DRIVEN = '6a756e63-';
/** The board as it is now (the stored file and every edit since), and how many edits there are. */
async function boardNow(token, docId) {
  const content = await (await fetch(`${BASE}/api/docs/${docId}/content`, { headers: { authorization: `Bearer ${token}` } })).text();
  const ops = (await api(token, 'GET', `/api/docs/${docId}/ops?since=0`)).ops || [];
  return { text: content + '\n' + JSON.stringify(ops), ops: ops.length };
}
/** The edits a person made to a document (the server may fold older ones into the stored file; these are seconds old). */
const editsBy = (docId, uid) => Number(sql(`SELECT count(*) FROM ops WHERE doc_id = '${docId}' AND author_id = ${uid}`));
const lockedDriven = (text) => (text.match(/6a756e63-[0-9a-f-]+/g) || []).length > 0 && /locked yes/.test(text) && !/\(locked no\)/.test(text);

const CAD_CODE = /\/static\/dist\/(mechanical|assembly|cad-worker)\.js|occ-kernel|\/pyodide\/.*\.wasm/;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  page.requests = []; page.workers = [];
  page.on('request', (r) => page.requests.push(r.url()));
  page.on('worker', (w) => page.workers.push(w.url()));
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}
const app = (page, fn, arg) => page.evaluate(fn, arg);
const meCad = (page) => app(page, () => !!(window.CollabApp.getState().me || {}).cad);
const visible = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden'; }, sel);
const count = (page, sel) => page.locator(sel).count();
const onBoard = (page) => page.waitForFunction(() => { const s = window.CollabApp.getState(); return s.view === 'editor' && s.document.hasDoc && s.document.docType === 'kicad_pcb'; }, null, { timeout: 45000 });
async function appMenu(page, id) {
  await page.locator('#appMenuBtn').dispatchEvent('pointerdown', { button: 0 });
  await page.waitForSelector('#appMenu');
  const checked = await page.getAttribute(`#appMenu [data-appmenu=${id}]`, 'aria-checked');
  return checked;
}

try {
  // ---------------------------------------------------------------- the people and the project
  sql(`DELETE FROM users WHERE github_id = 992703`);
  const newId = user('cadset-new', 992703);
  const fresh = await api(jwt(newId, 'cadset-new'), 'GET', '/api/me');
  check('a new account has Mechanical CAD off', fresh.cad === false, JSON.stringify(fresh));

  const adaId = user('cadset-ada', 992701), bobId = user('cadset-bob', 992702);
  const ada = jwt(adaId, 'cadset-ada'), bob = jwt(bobId, 'cadset-bob');
  await setCad(BASE, ada);
  await setCad(BASE, bob, false);   // a run before may have left it on
  const project = await api(ada, 'POST', '/api/projects/blank', { name: 'CAD setting test', template: 'pcb' });
  const pid = project.projectId;
  const docs = (await api(ada, 'GET', `/api/projects/${pid}/info`)).docs;
  const pcbId = docs.find((d) => d.docType === 'kicad_pcb').docId;
  const make = async (path, text) => { const d = await api(ada, 'POST', `/api/projects/${pid}/docs`, { path }); await api(ada, 'POST', `/api/docs/${d.docId}/snapshots?seq=0`, text, true); return d.docId; };
  const studioId = await make('Enclosure.jpart', enclosureText(pcbId));
  const bracketId = await make('Bracket.jpart', EMPTY_STUDIO);
  const asmId = await make('Box.jasm', EMPTY_ASSEMBLY);
  await api(ada, 'POST', `/api/projects/${pid}/invites`, { login: 'cadset-bob', role: 'editor' });
  check('Ada\'s project holds a PCB, two part studios and an assembly', [studioId, bracketId, asmId, pcbId].every(Boolean));

  // Ada, with CAD on, opens the board: her page makes it hold what the link asks for
  {
    const page = await open(adaId, 'cadset-ada');
    await page.goto(`${BASE}/p/${pid}/edit?doc=${pcbId}`);
    await onBoard(page);
    await page.waitForFunction(() => { const m = window.JunctionBoardMech.mech.getState(); return m.active && Object.values(m.driven).some((l) => l.length); }, null, { timeout: 45000 });
    check('with CAD on, the board shows the link\'s badge', await visible(page, '#mechBadge'));
    await page.context().close();
  }
  const before = await boardNow(ada, pcbId);
  check('the board holds the driven outline and hole, locked, in groups named after the part studio',
    before.text.includes(DRIVEN) && lockedDriven(before.text) && /Enclosure/.test(before.text) && /MountingHole/.test(before.text));

  // ================================================================ Bob, with CAD off
  check('Bob has CAD off', (await api(bob, 'GET', '/api/me')).cad === false);
  const page = await open(bobId, 'cadset-bob');
  await page.goto(`${BASE}/p/${pid}/edit?doc=home`);
  await page.waitForSelector('[data-project-home] [data-row-type=part_studio]', { timeout: 30000 });
  check('the page knows CAD is off', (await meCad(page)) === false);
  check('no part studio or assembly tab', (await count(page, '#doctabs [data-doc-type=part_studio], #doctabs [data-doc-type=assembly]')) === 0 && (await count(page, '#doctabs [data-doc-type=pcb]')) === 1);
  check('Home lists Ada\'s part studios and the assembly, each with the note',
    (await count(page, '[data-row-type=part_studio] [data-cad-off-note]')) === 2 && (await count(page, '[data-row-type=assembly] [data-cad-off-note]')) === 1
      && (await page.textContent('[data-row-type=assembly] [data-cad-off-note]')) === 'Turn on Mechanical CAD in your settings to open');
  check('Home offers a new PCB and no part studio or assembly', (await count(page, '[data-create=pcb]')) >= 1 && (await count(page, '[data-create=part_studio], [data-create=assembly]')) === 0);
  check('Home counts the tabs Bob has: the PCB', /^1 tab ·/.test(await page.textContent('[data-home-summary]')), await page.textContent('[data-home-summary]'));
  await shot(page, 'off-home');
  await page.click('[data-doc-add]');
  await page.waitForSelector('[data-add=pcb]');
  check('"+" offers a PCB and no part studio or assembly', (await count(page, '[data-add=part_studio], [data-add=assembly]')) === 0);
  await page.keyboard.press('Escape');
  await page.click('[data-tab-manager]');
  await page.waitForSelector('[data-tab-list] [data-list-tab=home]');
  check('the tab manager lists no part studio or assembly', (await count(page, `[data-tab-list] [data-list-tab="${studioId}"], [data-tab-list] [data-list-tab="${asmId}"]`)) === 0);
  await page.keyboard.press('Escape');
  // a STEP file brought in with CAD off is kept as the 3D model it is, not made a part studio
  {
    const chooser = page.waitForEvent('filechooser');
    await page.click('[data-home-import]');
    await (await chooser).setFiles({ name: 'bracket.step', mimeType: 'application/octet-stream', buffer: Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n') });
    let all = [];
    for (let i = 0; i < 40 && !all.some((d) => /bracket\.step$/.test(d.path)); i++) { await page.waitForTimeout(250); all = (await api(bob, 'GET', `/api/projects/${pid}/info`)).docs; }
    await page.waitForTimeout(500);   // a part studio, were one made, comes right after the file
    all = (await api(bob, 'GET', `/api/projects/${pid}/info`)).docs;
    check('a STEP file imported with CAD off is stored as a 3D model, and no part studio is made',
      all.some((d) => d.path === 'models/bracket.step') && all.filter((d) => d.docType === 'part_studio').length === 2, all.map((d) => `${d.path}:${d.docType}`).join(', '));
  }
  await page.click(`[data-row-type=assembly] [data-row-open]`);
  await page.waitForSelector(`[data-cad-off="${asmId}"] [data-cad-turn-on]`, { timeout: 15000 });
  check('opening the assembly from Home shows the note with the button', /Box is an assembly/.test(await page.textContent(`[data-cad-off="${asmId}"]`)));

  await page.goto(`${BASE}/p/${pid}/edit?doc=${studioId}`);
  await page.waitForSelector(`[data-cad-off="${studioId}"]`, { timeout: 30000 });
  const note = await page.textContent(`[data-cad-off="${studioId}"]`);
  check('a link to a part studio shows the note and the button instead of the editor',
    /Enclosure is a part studio/.test(note) && note.includes('Turn on Mechanical CAD in your settings to open') && (await count(page, '[data-cad-turn-on]')) === 1 && (await count(page, '.cad-root')) === 0, note);
  await shot(page, 'off-deeplink');

  await page.goto(`${BASE}/p/${pid}/edit?doc=${pcbId}`);
  await onBoard(page);
  await page.waitForTimeout(3000);   // anything that would follow the link has had its time
  const mechOff = await app(page, () => window.JunctionBoardMech.mech.getState());
  check('on the board: no board-link badge or panel, no "Used in" button', !(await visible(page, '#mechBadge')) && (await count(page, '#cadUsage')) === 0 && !mechOff.active && mechOff.sources.length === 0);
  const items = await app(page, () => window.CollabApp.getState().document.items.map((i) => i.id));
  check('the driven mounting hole is on Bob\'s board', items.some((id) => id.startsWith('6a756e63-')));
  const after = await boardNow(bob, pcbId);
  check('Bob\'s page wrote nothing to the board, and nothing came unlocked', editsBy(pcbId, bobId) === 0 && lockedDriven(after.text) && /Enclosure/.test(after.text), `${editsBy(pcbId, bobId)} edits by Bob`);
  await shot(page, 'off-board');
  const cadLoads = page.requests.filter((u) => CAD_CODE.test(u)), studioReads = page.requests.filter((u) => [studioId, bracketId, asmId].some((id) => u.includes(`/api/docs/${id}/`) && !u.includes('/preview.svg')));
  check('no CAD bundle, worker or kernel was fetched', !cadLoads.length && !page.workers.some((u) => /cad-worker/.test(u)), cadLoads.join(', '));
  check('no part studio or assembly was read', !studioReads.length, studioReads.join(', '));

  check('the MCP endpoint lists no cad_ tool to Bob', (await cadTools(bob)).length === 0);
  const refused = await mcp(bob, 'tools/call', { name: 'cad_get_features', arguments: { project: pid } });
  check('and refuses one by name, saying where the setting is', refused.isError && /Mechanical CAD is turned off/.test(refused.content[0].text), refused.content[0].text);
  check('Ada, who has CAD on, is listed the cad_ tools', (await cadTools(ada)).includes('cad_get_features'));

  // ================================================================ on, from the account menu
  await page.goto(`${BASE}/`);
  await page.waitForSelector('.hp-account');
  await page.evaluate(() => { window.__sameLoad = 'yes'; });
  await page.click('.hp-account');
  await page.waitForSelector('[data-menu-id=cad]');
  check('the account menu has the switch, off', (await page.getAttribute('[data-menu-id=cad]', 'aria-checked')) === 'false'
    && /Mechanical CAD \(part studios and assemblies\)/.test(await page.textContent('[data-menu-id=cad]')));
  await page.hover('[data-menu-id=cad]').catch(() => {});
  await shot(page, 'off-account-menu');
  await page.click('[data-menu-id=cad]');
  await page.waitForFunction(() => window.CollabApp.getState().me.cad === true);
  check('turning it on is stored', (await api(bob, 'GET', '/api/me')).cad === true);
  check('the MCP list now has the cad_ tools', (await cadTools(bob)).includes('cad_edit_features'));
  await page.click(`a.hp-item-link[href*="${pid}"]`);
  await page.waitForSelector('#doctabs [data-doc-type=pcb]', { timeout: 30000 });
  await page.click('#doctabs [data-doc-tab=home]');
  await page.waitForSelector('#doctabs [data-doc-type=part_studio]', { timeout: 15000 });
  check('into the project without a reload: the part studios and the assembly have tabs',
    (await page.evaluate(() => window.__sameLoad)) === 'yes' && (await count(page, '#doctabs [data-doc-type=part_studio]')) === 2 && (await count(page, '#doctabs [data-doc-type=assembly]')) === 1);
  await page.waitForSelector('[data-project-home] [data-row-type=part_studio]');
  check('Home has no note, and offers a part studio and an assembly', (await count(page, '[data-cad-off-note]')) === 0 && (await count(page, '[data-create=part_studio]')) >= 1);
  await shot(page, 'on-home');
  await page.click('[data-doc-add]');
  await page.waitForSelector('[data-add=part_studio]');
  check('"+" offers a part studio and an assembly', (await count(page, '[data-add=assembly]')) === 1);
  await page.keyboard.press('Escape');
  await page.click(`#doctabs [data-doc-tab="${bracketId}"]`);
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  check('a part studio opens, its bundle fetched now', page.requests.some((u) => /\/static\/dist\/mechanical\.js/.test(u)));

  // ================================================================ off from the app menu, in the part studio
  check('the app menu has the switch, on', (await appMenu(page, 'cadSetting')) === 'true');
  await page.hover('#appMenu [data-appmenu=cadSetting]');
  await shot(page, 'on-app-menu');
  await page.click('#appMenu [data-appmenu=cadSetting]');
  await page.waitForSelector(`[data-cad-off="${bracketId}"]`, { timeout: 15000 });
  check('off: the part studio gives way to the note, and its tabs go', (await count(page, '.cad-root')) === 0 && (await count(page, '#doctabs [data-doc-type=part_studio]')) === 0 && (await meCad(page)) === false);
  await page.click('[data-cad-turn-on]');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && document.querySelector('.cad-root'), null, { timeout: 60000 });
  check('"Turn on Mechanical CAD and open" turns it on and opens the part studio', (await meCad(page)) === true && (await api(bob, 'GET', '/api/me')).cad === true);

  // ================================================================ the board's CAD hooks follow the switch
  await page.evaluate((id) => window.CollabApp.dispatch({ type: 'openDoc', docId: id }), pcbId);
  await onBoard(page);
  await page.waitForSelector('#mechBadge', { state: 'visible', timeout: 30000 });
  await page.waitForSelector('#cadUsage button', { timeout: 30000 });
  // until every part studio is read the badge speaks of what it finds on the board alone
  await page.waitForFunction(() => /Enclosure/.test(document.querySelector('#mechBadge').textContent), null, { timeout: 30000 }).catch(() => {});
  const badgeText = await page.textContent('#mechBadge'), usedIn = await page.textContent('#cadUsage');
  check('on: the board shows the link\'s badge and "Used in Enclosure"', /Enclosure/.test(badgeText) && /Used in Enclosure/.test(usedIn), `${badgeText} | ${usedIn}`);
  await shot(page, 'on-board');
  await appMenu(page, 'cadSetting');
  await page.click('#appMenu [data-appmenu=cadSetting]');
  await page.waitForFunction(() => !window.CollabApp.getState().me.cad);
  await page.waitForTimeout(300);
  check('off from the app menu on the board: badge and button go', !(await visible(page, '#mechBadge')) && (await count(page, '#cadUsage')) === 0);
  check('… still the same page', (await page.evaluate(() => window.__sameLoad)) === 'yes');
  check('the app menu shows it off', (await appMenu(page, 'cadSetting')) === 'false');
  await page.click('#appMenu [data-appmenu=cadSetting]');
  await page.waitForSelector('#mechBadge', { state: 'visible', timeout: 30000 });
  check('on again from the app menu: the badge is back', true);
  const end = await boardNow(bob, pcbId);
  check('the board\'s driven items are as Ada\'s page left them: Bob\'s page, CAD on or off, found nothing to write', lockedDriven(end.text) && editsBy(pcbId, bobId) === 0, `${editsBy(pcbId, bobId)} edits by Bob`);

  // ================================================================ off again, from the account menu
  await page.click('#appMenuBtn').catch(() => {});
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'home' }));
  await page.waitForSelector('.hp-account', { timeout: 20000 });
  await page.click('.hp-account');
  await page.waitForSelector('[data-menu-id=cad]');
  check('the account menu shows it on', (await page.getAttribute('[data-menu-id=cad]', 'aria-checked')) === 'true');
  await page.click('[data-menu-id=cad]');
  await page.waitForFunction(() => window.CollabApp.getState().me.cad === false);
  check('off again from the account menu, stored', (await api(bob, 'GET', '/api/me')).cad === false && (await page.evaluate(() => window.__sameLoad)) === 'yes');
  check('and the MCP list has no cad_ tool again', (await cadTools(bob)).length === 0);

  check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error(e);
  fail++;
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
