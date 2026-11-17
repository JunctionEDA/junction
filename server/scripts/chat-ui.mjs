// Browser test of the project chat: the API's rules, then two people in two Chromium windows (Alice on the
// board, Bob on the schematic) talking in the Chat pane, a link to a part that opens the other document, unread
// counts, edit and delete, and cursor chat (Alt+M) showing beside the pointer on the other screen.
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database:
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node chat-ui.mjs
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
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/pic_programmer');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const aliceId = await mkUser(9701, 'ch-alice', 'Alice'), bobId = await mkUser(9702, 'ch-bob', 'Bob'), carolId = await mkUser(9703, 'ch-carol', 'Carol'), danId = await mkUser(9704, 'ch-dan', 'Dan');
await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId, carolId, danId]]);
const alice = mintJwt(aliceId, 'ch-alice'), bob = mintJwt(bobId, 'ch-bob'), carol = mintJwt(carolId, 'ch-carol'), dan = mintJwt(danId, 'ch-dan');

const api = async (tok, url, o = {}) => {
  const r = await fetch(BASE + url, { method: o.method || (o.json ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${tok}`, ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, j, text: t };
};

// ---------------------------------------------------------------- fixtures: the project, Bob an editor, Dan a viewer
const zip = path.join(fs.mkdtempSync('/tmp/chat-ui-'), 'p.zip');
execSync(`cd "${DEMO}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', 'PIC programmer'); form.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const created = await api(alice, '/api/projects', { method: 'POST', body: form });
const pid = created.j.projectId;
const pcb = created.j.docs.find((d) => d.docType === 'kicad_pcb'), sch = created.j.docs.find((d) => d.path === 'pic_programmer.kicad_sch');
check('project uploaded', created.status === 200 && !!pcb && !!sch, created.text.slice(0, 200));
const edLink = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'editor' } });
await api(bob, `/api/join/${edLink.j.token}`, { method: 'POST' });
const viewLink = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'viewer' } });
await api(dan, `/api/join/${viewLink.j.token}`, { method: 'POST' });

// ---------------------------------------------------------------- the API on its own
{
  let r = await api(alice, `/api/projects/${pid}/chat`, { json: { body: '  first message  ' } });
  check('a member posts a message, trimmed', r.status === 200 && r.j.body === 'first message' && r.j.authorLogin === 'ch-alice' && r.j.authorName === 'Alice', r.text);
  const first = r.j.id;
  r = await api(alice, `/api/projects/${pid}/chat`, { json: { body: 'see this', link: { docId: pcb.docId, kind: 'item', id: 'abc', label: 'C1', x: 1, y: 2 } } });
  check('a message can link a part on one of the project\'s documents', r.status === 200 && r.j.link && r.j.link.path === pcb.path && r.j.link.label === 'C1', r.text);
  r = await api(alice, `/api/projects/${pid}/chat`, { json: { body: 'x', link: { docId: crypto.randomUUID(), kind: 'spot' } } });
  check('a link to a document outside the project is refused', r.status === 400, `${r.status} ${r.text}`);
  r = await api(alice, `/api/projects/${pid}/chat`, { json: { body: 'x', link: { docId: pcb.docId, kind: 'url', id: 'x' } } });
  check('an unknown link kind is refused', r.status === 400, `${r.status}`);
  r = await api(alice, `/api/projects/${pid}/chat`, { json: { body: '   ' } });
  check('an empty message is refused', r.status === 400, `${r.status}`);
  r = await api(bob, `/api/projects/${pid}/chat`);
  check('Bob reads the chat, with two unread', r.status === 200 && r.j.messages.length === 2 && r.j.unread === 2 && r.j.lastReadId === 0 && r.j.canWrite === true, r.text.slice(0, 300));
  r = await api(bob, `/api/projects/${pid}/chat/read`, { json: { id: first } });
  check('marking read counts down', r.status === 200 && r.j.unread === 1 && r.j.lastReadId === first, r.text);
  r = await api(bob, `/api/projects/${pid}/chat/read`, { json: { id: 0 } });
  check('a read mark never moves back', r.j.lastReadId === first, r.text);
  r = await api(alice, `/api/projects/${pid}/chat`);
  check('your own messages are never unread', r.j.unread === 0, r.text.slice(0, 200));
  r = await api(dan, `/api/projects/${pid}/chat`);
  check('a viewer reads the chat but may not write', r.status === 200 && r.j.messages.length === 2 && r.j.canWrite === false, r.text.slice(0, 200));
  r = await api(dan, `/api/projects/${pid}/chat`, { json: { body: 'hi' } });
  check('…and posting is refused', r.status === 403, `${r.status} ${r.text}`);
  r = await api(carol, `/api/projects/${pid}/chat`);
  check('someone outside the project cannot read it', r.status === 403 || r.status === 404, `${r.status}`);
  r = await api(bob, `/api/chat/${first}`, { method: 'PATCH', json: { body: 'not mine' } });
  check('only the author edits a message', r.status === 403, `${r.status}`);
  r = await api(alice, `/api/chat/${first}`, { method: 'PATCH', json: { body: 'first message, edited' } });
  check('the author edits it, and it says so', r.status === 200 && r.j.body === 'first message, edited' && !!r.j.editedAt, r.text);
  const bobs = (await api(bob, `/api/projects/${pid}/chat`, { json: { body: 'bob was here' } })).j.id;
  r = await api(dan, `/api/chat/${bobs}`, { method: 'DELETE' });
  check('a viewer cannot delete someone else\'s message', r.status === 403, `${r.status}`);
  r = await api(alice, `/api/chat/${bobs}`, { method: 'DELETE' });
  check('the owner deletes anyone\'s message', r.status === 200, r.text);
  for (let i = 0; i < 5; i++) await api(bob, `/api/projects/${pid}/chat`, { json: { body: `page ${i}` } });
  r = await api(alice, `/api/projects/${pid}/chat?limit=3`);
  const older = await api(alice, `/api/projects/${pid}/chat?limit=3&before=${r.j.messages[0].id}`);
  check('history pages back, oldest first', r.j.more === true && r.j.messages.length === 3 && r.j.messages[2].body === 'page 4' && older.j.messages.length === 3 && older.j.messages[2].id < r.j.messages[0].id, JSON.stringify(r.j.messages.map((m) => m.body)));
  // a clean slate for the browsers
  await db.query('DELETE FROM chat_messages WHERE project_id = $1', [pid]);
  await db.query('DELETE FROM chat_reads WHERE project_id = $1', [pid]);
}

// ---------------------------------------------------------------- browsers
const browser = await chromium.launch();
const errors = [];
async function open(jwt, doc, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1440, height: 900 }, deviceScaleFactor: opts.scale || 1, colorScheme: opts.scheme || 'dark' });
  const page = await ctx.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${pid}/edit?doc=${doc.docId}`)}`);
  await ready(page);
  return page;
}
const ready = async (page) => {
  await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
  await page.waitForTimeout(700);
};
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const scr = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, r = document.querySelector('#world').getBoundingClientRect();
  const w = E.vb[2] / E.vbPerMm, h = E.vb[3] / E.vbPerMm;
  return [r.left + (x - E.vb[0] / E.vbPerMm) / w * r.width, r.top + (y - E.vb[1] / E.vbPerMm) / h * r.height];
}, [x, y]);
const part = (page, ref) => page.evaluate((ref) => {
  for (const it of window.CollabEditor.kdoc.items.values()) if ((it.kind === 'footprint' || it.kind === 'symbol') && it.ref === ref) return { id: it.id, bbox: it.bbox };
  return null;
}, ref);
const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const chatOf = (page) => page.evaluate(() => { const c = window.CollabApp.getState().chat; return c ? { n: c.messages.length, unread: c.unread, bodies: c.messages.map((m) => m.body), last: c.messages[c.messages.length - 1] } : null; });
const until = async (fn, ms = 8000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 120)); } };
const step = async (name, page, fn) => { try { await fn(); } catch (e) { check(name, false, String(e.message).split('\n').slice(0, 4).join(' / ')); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'FAIL-' + name.replace(/\W+/g, '-') + '.png') }).catch(() => {}); await page.keyboard.press('Escape').catch(() => {}); } };

const a = await open(alice, pcb, { scale: 2 }), b = await open(bob, sch, { scheme: 'light', scale: 2 });

await step('open the chat', a, async () => {
  check('the menu bar has a Chat button', await a.locator('#chatBtn').count() === 1);
  await a.click('#chatBtn');
  await a.waitForSelector('#chatPane');
  check('it opens the Chat pane, empty', /No messages yet/.test(await a.locator('#chatPane').textContent()));
});

await step('send with a link to a part', a, async () => {
  const u1 = await part(a, 'U1');
  const [x, y] = await scr(a, ...mid(u1.bbox));
  await a.mouse.click(x, y); await a.waitForTimeout(200);
  await a.click('[data-chat-attach]');
  check('the pin links the selected part', /U1/.test(await a.locator('.chat-attached').textContent()), await a.locator('.chat-compose').textContent());
  await a.fill('#chatText', 'Can someone check the decoupling on U1? The caps look far from the pins.');
  await a.keyboard.press('Enter');
  check('the message shows for Alice', await until(async () => (await chatOf(a)).n === 1 && !(await chatOf(a)).last.pending));
  const m = (await chatOf(a)).last;
  check('it is stored with the link to U1', m.link && m.link.kind === 'item' && m.link.id === u1.id && m.link.label === 'U1', JSON.stringify(m));
  check('Bob, on the schematic, gets it live with an unread count', await until(async () => (await chatOf(b)).unread === 1));
  check('Bob\'s Chat button shows the count', await until(async () => (await b.locator('[data-chat-unread]').textContent().catch(() => '')) === '1'));
  check('…and a toast with the message', await until(async () => /decoupling on U1/.test(await b.locator('body').textContent())));
  await shot(a, '01-alice-sends-with-link');
  await shot(b, '02-bob-unread-badge');
});

await step('Bob follows the link', b, async () => {
  await b.click('#chatBtn');
  await b.waitForSelector('#chatPane [data-chat-link]');
  check('opening the pane clears the count', await until(async () => (await chatOf(b)).unread === 0 && await b.locator('[data-chat-unread]').count() === 0));
  check('the server keeps it read', await until(async () => (await api(bob, `/api/projects/${pid}/chat`)).j.unread === 0));
  await shot(b, '03-bob-chat-pane');
  await b.click('#chatPane [data-chat-link]');
  check('the link opens the board', await until(async () => b.evaluate((id) => location.search.includes(id), pcb.docId), 15000));
  await ready(b);
  const u1 = await part(b, 'U1');
  check('…and selects U1 there', await until(async () => b.evaluate((id) => { const E = window.CollabEditor; return (E.selected && E.selected.id === id) || (E.selection && E.selection.has && E.selection.has(id)); }, u1.id), 10000));
  check('the chat stays open on the other document', await b.locator('#chatPane').isVisible() && (await chatOf(b)).n === 1);
  await shot(b, '04-bob-followed-link-to-board');
});

await step('Bob replies', b, async () => {
  await b.fill('#chatText', 'Looking now.\nC2 should sit right under pin 1.');
  await b.click('#chatSend');
  check('Alice sees the reply at once (pane open: nothing unread)', await until(async () => (await chatOf(a)).n === 2 && (await chatOf(a)).unread === 0));
  check('the line break is kept', /Looking now\.\nC2/.test((await chatOf(a)).last.body));
  await shot(a, '05-alice-sees-reply');
});

await step('edit and delete', a, async () => {
  const mine = a.locator('.chat-msg.mine').first();
  await mine.hover();
  await mine.locator('[data-chat-edit]').click();
  await a.fill('.chat-edit textarea', 'Can someone check the decoupling on U1? C2 looks far from pin 1.');
  await a.keyboard.press('Enter');
  check('the edit reaches Bob, marked edited', await until(async () => /C2 looks far/.test((await chatOf(b)).bodies[0]) && /\(edited\)/.test(await b.locator('#chatPane').textContent())));
  await b.locator('.chat-msg.mine').first().hover();
  check('Bob may delete his own message, and not edit Alice\'s', await b.locator('.chat-msg.mine [data-chat-delete]').count() === 1 && await b.locator('.chat-msg:not(.mine) [data-chat-edit]').count() === 0);
  await shot(b, '06-bob-hover-actions');
});

await step('cursor chat', b, async () => {
  const c = await part(b, 'C2') || await part(b, 'C1');
  const [x, y] = await scr(b, ...mid(c.bbox));
  await b.mouse.move(x + 30, y + 10, { steps: 4 }); await b.waitForTimeout(150);
  await b.keyboard.press('Alt+m');
  await b.waitForSelector('#cursorChat input');
  await b.keyboard.type('this one, move it closer', { delay: 15 });
  check('what Bob types shows beside his cursor on Alice\'s board, as he types', await until(async () => /move it closer/.test(await a.locator('.peer-say').first().textContent().catch(() => ''))));
  await shot(b, '07-bob-cursor-chat-typing');
  await shot(a, '08-alice-sees-bob-say');
  await b.keyboard.press('Enter');
  check('Enter posts it to the chat with a link to that spot', await until(async () => { const l = (await chatOf(a)).last; return l.body === 'this one, move it closer' && l.link && l.link.kind === 'spot' && l.link.docId === pcb.docId; }));
  check('the bubble lingers, then goes', await a.locator('.peer-say').count() >= 1 && await until(async () => (await a.locator('.peer-say').count()) === 0, 9000));
  await shot(a, '09-alice-chat-with-spot-link');
});

await step('a viewer reads only', a, async () => {
  const d = await open(dan, pcb, { scheme: 'light' });
  await d.click('#chatBtn');
  await d.waitForSelector('#chatPane .chat-msg');
  check('a viewer sees the conversation with the composer locked', await d.locator('#chatText').isDisabled() && /read this chat but not write/.test(await d.locator('#chatText').getAttribute('placeholder')));
  await shot(d, '10-viewer-read-only');
  await d.context().close();
});

await step('narrow light window', a, async () => {
  const n = await open(bob, pcb, { scheme: 'light', viewport: { width: 420, height: 860 }, scale: 2 });
  await n.click('#chatBtn');
  await n.waitForSelector('#chatPane .chat-msg');
  const over = await n.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('the chat fits a phone-width window', !over);
  await shot(n, '11-narrow-light');
  await n.context().close();
});

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
