// Assign Footprints (KiCad's CvPcb) in the web editor, and the Preferences dialogs it opens: the toolbar and its
// three filter tools, the lists, the status bar, assigning / deleting / undo / redo / saving, Manage Footprint
// Libraries and Configure Paths.  One Chromium window on KiCad's pic_programmer demo.
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, able to fetch the KiCad libraries
// (behind a proxy with its own certificate authority: KC_EXTRA_CA_FILE=<bundle> on the server).
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node assign-footprints-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [9801, 'af-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'af-alice');

const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'demos', 'pic_programmer');
const dir = fs.mkdtempSync('/tmp/af-ui-');
execSync(`cd "${demo}" && zip -qr "${dir}/p.zip" pic_programmer.kicad_pro pic_programmer.kicad_sch pic_sockets.kicad_sch pic_programmer.kicad_sym pic_programmer.kicad_pcb sym-lib-table fp-lib-table`);
fs.writeFileSync(path.join(dir, 'parts.equ'), "# test association file\n'22uF/25V' 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'\n");
execSync(`cd "${dir}" && zip -q p.zip parts.equ`);
const form = new FormData(); form.append('name', 'Assign footprints'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const res = await fetch(BASE + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
const created = await res.json();
const sch = created.docs && created.docs.find((d) => d.path === 'pic_programmer.kicad_sch');
check('project uploaded', res.status === 200 && !!sch, JSON.stringify(created).slice(0, 200));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'dark' });
const page = await ctx.newPage(); page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${created.projectId}/edit?doc=${sch.docId}`)}`);
await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
await page.waitForTimeout(800);
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const until = async (fn, ms = 60000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 150)); } };
const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const symRows = () => page.evaluate(() => { const E = window.CollabEditor; const out = []; for (const it of E.kdoc.items.values()) if (it.kind === 'symbol') { const p = (n) => { const q = it.node.find((c) => Array.isArray(c) && c[0] === 'property' && c[1] === n); return q ? String(q[2]) : ''; }; out.push({ ref: p('Reference'), fp: p('Footprint') }); } return out; });
const count = async () => Number((/: (\d+) matching footprints/.exec((await text('#kd-af-status')) || '') || [])[1]);
const symLine = (i) => page.evaluate((i) => { const el = document.querySelector('#kd-af-syms'); el.scrollTop = i * 20; return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => { const row = [...el.querySelectorAll('.cv-row')].find((x) => Number(x.dataset.i) === i); r(row ? row.textContent : null); }))); }, i);
const pressed = (id) => page.evaluate((id) => document.querySelector('#kd-af-' + id).classList.contains('on'), id);

try {
  await page.evaluate(() => { localStorage.removeItem('kui.cvpcb.filter_footprint'); window.CollabApp.dispatch({ type: 'action', id: 'assignFootprints' }); });
  await page.waitForSelector('.cv-frame');
  // ---- the frame
  const ids = ['save', 'libtable', 'view', 'prev', 'next', 'undo', 'redo', 'auto', 'delall', 'fpfilters', 'pins', 'lib'];
  const have = await page.evaluate((ids) => ids.map((i) => { const b = document.querySelector('#kd-af-' + i); return !!b && !!b.querySelector('svg'); }), ids);
  check("toolbar has CvPcb's twelve tools, each with an icon", have.every(Boolean), JSON.stringify(have));
  check('menu bar is File, Edit, Preferences', (await page.evaluate(() => [...document.querySelectorAll('.cv-menubar button')].map((b) => b.textContent).join(','))) === 'File,Edit,Preferences');
  check('"Footprint Filters:" label and the search text are in the toolbar', (await text('.cv-toolbar b')) === 'Footprint Filters:' && !!(await page.$('#kd-af-filter')));
  check('no filter tool is pressed at first (filter_footprint = 0)', !(await pressed('fpfilters')) && !(await pressed('pins')) && !(await pressed('lib')));
  check('every library is loaded and listed', await until(async () => /^No Filtering: \d{4,} matching footprints$/.test((await text('#kd-af-status')) || ''), 180000), String(await text('#kd-af-status')));
  const all = await count();
  check('unfiltered list is the whole footprint set', all > 10000, String(all));
  const icons = await page.evaluate(() => [...document.querySelectorAll('.cv-tool svg')].every((s) => s.innerHTML.length > 20));
  check('icons are drawn', icons);
  const first = await symLine(0);
  check('symbol rows read "  n  ref -  value : footprint"', /^ {2}1 +\S+ - +\S.* : /.test(first || ''), JSON.stringify(first));
  await shot('01-assign-footprints');

  // ---- filters
  await page.click('#kd-af-lib');
  check('Filter by library is pressed and kept', await pressed('lib') && (await page.evaluate(() => localStorage.getItem('kui.cvpcb.filter_footprint'))) === '4');
  const libName = await page.evaluate(() => { const el = document.querySelector('#kd-af-libs'); const row = [...el.querySelectorAll('.cv-row')].find((r) => r.textContent === 'Capacitor_THT') || el.querySelector('.cv-row'); row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return row.textContent; });
  check('picking a library narrows the list to it', await until(async () => (await count()) < all && (await count()) > 0, 5000) && ((await text('#kd-af-status')) || '').includes(`Library (${libName})`), String(await text('#kd-af-status')));
  const inLib = await count();
  await page.click('#kd-af-pins');
  check('Filter by pin count filters on the pad count and shows the count', await until(async () => (await count()) <= inLib && /Pin Count/.test((await text('#kd-af-status')) || ''), 5000) && /Pin Count \(\d+\)/.test((await text('#kd-af-status')) || ''), String(await text('#kd-af-status')));
  await page.click('#kd-af-fpfilters');
  check('Use symbol footprint filters is named "Keywords" in the status bar', ((await text('#kd-af-status')) || '').startsWith('Filtered by Keywords'), String(await text('#kd-af-status')));
  await page.click('#kd-af-fpfilters'); await page.click('#kd-af-pins');
  await page.fill('#kd-af-filter', 'radial d5.0mm p2.50'); await page.keyboard.press('Enter');
  check('search text filters and is named in the status bar', await until(async () => ((await text('#kd-af-status')) || '').includes('Search Text (radial d5.0mm p2.50)') && (await count()) >= 1, 5000), String(await text('#kd-af-status')));
  await shot('02-filtered');

  // ---- assigning
  const fpLine = await page.evaluate(() => document.querySelector('#kd-af-fps .cv-row').textContent);
  const fpid = fpLine.trim().replace(/^\d+ /, '');
  check('footprint rows read "  n Library:Name"', /^ {2}1 Capacitor_THT:/.test(fpLine), JSON.stringify(fpLine));
  check('status shows the selected footprint and its library', ((await text('#kd-af-status-fp')) || '').startsWith('Description: ') && ((await text('#kd-af-status-lib')) || '') === 'Library location: ${KICAD10_FOOTPRINT_DIR}/Capacitor_THT.pretty', `${await text('#kd-af-status-fp')} | ${await text('#kd-af-status-lib')}`);
  const before = await symLine(0), ref0 = before.trim().split(/\s+/)[1];
  await page.evaluate(() => document.querySelector('#kd-af-syms .cv-row[data-i="0"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  await page.dblclick('#kd-af-fps .cv-row');
  check('double-click assigns the footprint to the selected symbol', (await symLine(0)).endsWith(' : ' + fpid), String(await symLine(0)));
  check('and moves to the next symbol', await page.evaluate(() => { const r = document.querySelector('#kd-af-syms .cv-row.sel'); return !!r && r.dataset.i === '1'; }));
  check('Undo and Save are enabled after an assignment', await page.evaluate(() => !document.querySelector('#kd-af-undo').disabled && !document.querySelector('#kd-af-save').disabled && document.querySelector('#kd-af-redo').disabled));
  await page.click('#kd-af-undo');
  check('Undo puts the old footprint back', (await symLine(0)) === before, String(await symLine(0)));
  await page.click('#kd-af-redo');
  check('Redo assigns it again', (await symLine(0)).endsWith(' : ' + fpid));
  await page.evaluate(() => document.querySelector('#kd-af-syms .cv-row[data-i="1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  const second = await symLine(1);
  await page.focus('#kd-af-syms'); await page.keyboard.press('Delete');
  check('Delete removes the selected assignment', (await symLine(1)).endsWith(' : ') && second !== (await symLine(1)), String(await symLine(1)));
  await page.click('#kd-af-prev'); await page.click('#kd-af-next');
  check('next / previous unassigned select a symbol without a footprint', await page.evaluate(() => { const r = document.querySelector('#kd-af-syms .cv-row.sel'); return !!r && / : $/.test(r.textContent); }));
  await page.keyboard.press('Control+z');
  check('Ctrl+Z undoes the delete', (await symLine(1)) === second, String(await symLine(1)));
  await page.keyboard.press('Tab');
  check('Tab moves the focus to the footprint list', await page.evaluate(() => document.activeElement && document.activeElement.id === 'kd-af-fps'));

  // ---- view selected footprint
  await page.click('#kd-af-view');
  check('View Selected Footprint opens the footprint in its own window', await until(async () => (await page.evaluate(() => { const c = document.querySelector('#kd-af-viewer canvas'); return !!c && c.width > 50 && !document.querySelector('#kd-af-viewer .kd-note').textContent; })), 15000));
  await shot('03-view-footprint');
  await page.keyboard.press('Escape');
  check('the viewer closes and Assign Footprints stays', await page.evaluate(() => !document.querySelector('#kd-af-viewer') && !!document.querySelector('.cv-frame')));

  // ---- menus
  await page.click('.cv-menubar button[data-menu="Edit"]');
  check('Edit menu lists Undo, Redo, Cut, Copy, Paste', await page.evaluate(() => [...document.querySelectorAll('.kd-pop .kd-pop-row')].map((r) => r.textContent.replace(/\s{2,}.*$/, '').trim()).join(',') === 'Undo,Redo,Cut,Copy,Paste'), await page.evaluate(() => [...document.querySelectorAll('.kd-pop .kd-pop-row')].map((r) => r.textContent).join('|')));
  await page.keyboard.press('Escape');
  await page.click('.cv-menubar button[data-menu="Preferences"]');
  check('Preferences menu has the four CvPcb entries', await page.evaluate(() => [...document.querySelectorAll('.kd-pop .kd-pop-row')].map((r) => r.textContent.replace(/\s{2,}.*$/, '').trim()).join('|') === 'Configure Paths...|Manage Footprint Libraries...|Manage Footprint Association Files...|Preferences...'));
  await page.keyboard.press('Escape');

  // ---- saving
  await page.click('#kd-af-apply');
  check('Apply, Save Schematic & Continue writes the Footprint field', await until(async () => (await symRows()).some((r) => r.ref === ref0 && r.fp === fpid), 8000), JSON.stringify((await symRows()).find((r) => r.ref === ref0)));
  check('and keeps the frame open with Save disabled', await page.evaluate(() => !!document.querySelector('.cv-frame') && document.querySelector('#kd-af-save').disabled));

  // ---- automatic assignment from the project's association file
  const target = await page.evaluate(() => { const E = window.CollabEditor; for (const it of E.kdoc.items.values()) if (it.kind === 'symbol') { const p = (n) => { const q = it.node.find((c) => Array.isArray(c) && c[0] === 'property' && c[1] === n); return q ? String(q[2]) : ''; }; if (p('Value') === '22uF/25V') return p('Reference'); } return null; });
  if (target) {
    const idx = await page.evaluate((ref) => { const el = document.querySelector('#kd-af-syms'); const n = Math.round(el.querySelector('.cv-rows').offsetHeight / 20); return ref ? n : -1; }, target);
    let at = -1; for (let i = 0; i < idx; i++) { const l = await symLine(i); if (l && l.trim().split(/\s+/)[1] === target) { at = i; break; } }
    await page.evaluate((i) => document.querySelector(`#kd-af-syms .cv-row[data-i="${i}"]`).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), at);
    await page.focus('#kd-af-syms'); await page.keyboard.press('Delete');
    await page.click('#kd-af-auto');
    check('Automatically Assign Footprints reads the project .equ file', await until(async () => ((await symLine(at)) || '').endsWith(' : Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'), 8000), String(await symLine(at)));
    check('and reports the equivalences found', ((await text('#kd-af-status')) || '') === '1 footprint/symbol equivalences found.', String(await text('#kd-af-status')));
  } else check('demo has a 22uF/25V part for the association test', false);

  // ---- Manage Footprint Libraries, Configure Paths
  await page.keyboard.press('Escape');
  await page.waitForSelector('.cv-frame', { state: 'detached' });
  check('the handlers are published to the menus', await page.evaluate(() => { const h = window.CollabApp.getState().tool.handled; return ['configurePaths', 'showFootprintLibTable', 'showSymbolLibTable'].every((i) => h.includes(i)); }));
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'showFootprintLibTable' }));
  await page.waitForSelector('.kd-dialog .kd-title');
  check('Manage Footprint Libraries opens on the project table', (await text('.kd-dialog .kd-title span')) === 'Footprint Libraries' && await page.evaluate(() => [...document.querySelectorAll('.kd-dialog th')].map((t) => t.textContent).join('|').includes('Active|Visible|Nickname|Library Path|Library Format|Options|Description')), await page.evaluate(() => [...document.querySelectorAll('.kd-dialog th')].map((t) => t.textContent).join('|')));
  await shot('04-footprint-libraries');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'showSymbolLibTable' }));
  check('Manage Symbol Libraries opens', await until(async () => (await text('.kd-dialog .kd-title span')) === 'Symbol Libraries', 5000));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'configurePaths' }));
  check('Configure Paths lists the environment variables', await until(async () => (await text('.kd-dialog .kd-title span')) === 'Configure Paths', 5000) && await page.evaluate(() => document.querySelector('.kd-dialog').textContent.includes('KICAD10_FOOTPRINT_DIR') && document.querySelector('.kd-dialog').textContent.includes('Environment Variables')));
  await shot('05-configure-paths');
  await page.keyboard.press('Escape');
} catch (e) {
  check('run completed', false, String(e.message).split('\n').slice(0, 4).join(' / '));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'failure.png') });
}
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
