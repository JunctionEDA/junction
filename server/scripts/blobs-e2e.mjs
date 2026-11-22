// End-to-end test of the stored-file blobs (server/src/blobs.rs, migration 0260).
//
// Snapshots written the old way (a whole file per row) are moved to blobs by the admin action, read back
// byte for byte through the API, shared between documents, kept as differences, and expanded again.
//
// Run against a LOCAL server (started with KC_ADMINS=blob-admin) and a THROWAWAY database:
//
//   E2E_PG_URL=postgres://postgres:test@127.0.0.1:5432/collabtest \
//   E2E_JWT_SECRET=testsecret [BOARD=/path/to/a/large.kicad_pcb] node blobs-e2e.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL });
await db.connect();
const mkUser = async (ghId, login) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login])).rows[0].id;
const adminId = await mkUser(-9301, 'blob-admin'), eveId = await mkUser(-9302, 'blob-eve');
const admin = mintJwt(adminId, 'blob-admin'), eve = mintJwt(eveId, 'blob-eve');
const get = async (token, path) => fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
const post = async (token, path) => fetch(BASE + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
const file = async (docId, seq) => Buffer.from(await (await get(admin, `/api/docs/${docId}/snapshots/${seq}`)).arrayBuffer());
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];

// a board big enough to matter, and the same board a few edits later
function board(n, moved = -1, extra = '') {
  let s = '(kicad_pcb (version 20241229) (generator "pcbnew")\n';
  for (let i = 0; i < n; i++) s += `  (footprint "R_0402" (layer "F.Cu") (uuid "${crypto.createHash('md5').update(String(i)).digest('hex')}") (at ${i === moved ? 999.5 : (i * 1.27).toFixed(2)} ${i % 50}))\n`;
  return Buffer.from(s + extra + ')\n');
}
const big = process.env.BOARD ? fs.readFileSync(process.env.BOARD) : board(20000);
const v0 = big;
const v1 = Buffer.concat([big.subarray(0, big.length - 2), Buffer.from('  (gr_text "rev B" (at 10 10) (layer "F.SilkS"))\n)\n')]);
const v2 = Buffer.concat([v1.subarray(0, v1.length - 2), Buffer.from('  (via (at 3 4) (size 0.5) (drill 0.2) (layers "F.Cu" "B.Cu") (net 1))\n)\n')]);
const binary = crypto.randomBytes(300000);

const pid = (await one(`INSERT INTO projects (owner_id, name) VALUES ($1, 'blobs-e2e') RETURNING id`, [adminId])).id;
const mkDoc = async (project, path, type) => (await one(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, $2, $3) RETURNING id`, [project, path, type])).id;
const old = (doc, seq, content, name = null) => db.query('INSERT INTO snapshots (doc_id, seq, content, name) VALUES ($1, $2, $3, $4)', [doc, seq, content, name]);
const a = await mkDoc(pid, 'a.kicad_pcb', 'kicad_pcb'), b = await mkDoc(pid, 'copy/a.kicad_pcb', 'kicad_pcb');
const bin = await mkDoc(pid, 'model.step', 'other'), empty = await mkDoc(pid, 'empty.txt', 'text');
await old(a, 0, v0); await old(a, 7, v1, 'First layout'); await old(a, 12, v2);
await old(b, 0, v0);
await old(bin, 0, binary); await old(empty, 0, Buffer.alloc(0));
const docs = [a, b, bin, empty];
// a preview stored before previews were packed, and more assistant changes than keep their undo
const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${'<path d="M0 0L10 10"/>'.repeat(4000)}</svg>`);
await db.query('INSERT INTO doc_previews (doc_id, fit, seq, svg) VALUES ($1, true, 0, $2)', [a, svg]);
for (let i = 0; i < 25; i++) await db.query(`INSERT INTO mcp_changes (user_id, project_id, doc_id, title, edits, undo) VALUES ($1, $2, $3, $4, '[]', $5)`, [adminId, pid, a, `change ${i}`, JSON.stringify({ items: 'x'.repeat(2000) })]);
await db.query(`INSERT INTO mcp_changes (user_id, project_id, doc_id, title, edits, undo, created_at) VALUES ($1, $2, $3, 'old', '[]', '{}', now() - interval '8 days')`, [eveId, pid, a]);
const sizeOf = async () => (await one(`SELECT COALESCE(sum(octet_length(content)), 0)::bigint AS whole,
  (SELECT COALESCE(sum(octet_length(data)), 0) FROM blobs WHERE hash IN (SELECT blob FROM snapshots WHERE doc_id = ANY($1))
     OR hash IN (SELECT base FROM blobs WHERE hash IN (SELECT blob FROM snapshots WHERE doc_id = ANY($1))))::bigint AS blobs
  FROM snapshots WHERE doc_id = ANY($1)`, [docs]));

check('an old whole-file snapshot is read as before', (await file(a, 7)).equals(v1));
check('only an administrator can compact', (await post(eve, '/api/admin/storage/compact')).status === 403 && (await get(eve, '/api/admin/storage')).status === 403);
const before = await sizeOf();

const settle = async () => { for (let i = 0; i < 600; i++) { await new Promise((r) => setTimeout(r, 500)); const s = await (await get(admin, '/api/admin/storage')).json(); if (!s.running) return s; } throw new Error('still running'); };
const waitingHere = async () => (await one('SELECT count(*)::int AS n FROM snapshots WHERE doc_id = ANY($1) AND content IS NOT NULL', [docs])).n;
check('compaction starts', (await post(admin, '/api/admin/storage/compact')).status === 200);
await new Promise((r) => setTimeout(r, 300));
const st = await settle();
check('every old snapshot was moved', (await waitingHere()) === 0, JSON.stringify(st));
const after = await sizeOf();
console.log(`      ${before.whole} bytes of whole files are now ${after.blobs} bytes of blobs (${(before.whole / Math.max(1, after.blobs)).toFixed(1)}x)`);
check('the files take far less room', after.whole === 0 && after.blobs < before.whole / 4, `${before.whole} to ${after.blobs}`);
check('every file reads back byte for byte', (await file(a, 0)).equals(v0) && (await file(a, 7)).equals(v1) && (await file(a, 12)).equals(v2)
  && (await file(b, 0)).equals(v0) && (await file(bin, 0)).equals(binary) && (await file(empty, 0)).length === 0);
const rows = (await db.query(`SELECT s.doc_id, s.seq, s.name, s.size, encode(s.blob, 'hex') AS blob, bl.enc, encode(bl.base, 'hex') AS base, octet_length(bl.data) AS stored
  FROM snapshots s JOIN blobs bl ON bl.hash = s.blob WHERE s.doc_id = ANY($1) ORDER BY s.doc_id, s.seq`, [docs])).rows;
const row = (d, s) => rows.find((r) => r.doc_id === d && r.seq === s);
check('a blob is named by the SHA-256 of its file', row(a, 0).blob === crypto.createHash('sha256').update(v0).digest('hex'));
check('the same file in two documents is stored once', row(a, 0).blob === row(b, 0).blob);
check('later snapshots are small differences from the first', row(a, 7).enc === 2 && row(a, 12).enc === 2 && row(a, 7).base === row(a, 0).blob && row(a, 12).base === row(a, 0).blob
  && row(a, 7).stored < 2000 && row(a, 12).stored < 2000, `${row(a, 7).stored} and ${row(a, 12).stored} bytes`);
check('a snapshot keeps its name and its size', row(a, 7).name === 'First layout' && row(a, 7).size === v1.length);
check('a file that does not compress is still kept whole and exact', row(bin, 0).enc === 1);

const pv = await one(`SELECT octet_length(svg) AS n, encode(substring(svg from 1 for 4), 'hex') AS magic FROM doc_previews WHERE doc_id = $1`, [a]);
check('an old preview is packed', pv.magic === '28b52ffd' && pv.n < svg.length / 10, `${svg.length} to ${pv.n}`);
const shown = await fetch(`${BASE}/api/docs/${a}/preview.svg?fit=true`, { headers: { Cookie: `kc_session=${admin}` } });
check('and still shows the same picture', shown.ok && Buffer.from(await shown.arrayBuffer()).equals(svg), `status ${shown.status}`);
const undo = await one(`SELECT count(*) FILTER (WHERE undo IS NOT NULL AND user_id = $2)::int AS kept, count(*)::int AS total,
  count(*) FILTER (WHERE undo IS NOT NULL AND user_id = $3)::int AS stale,
  (SELECT min(title) FROM mcp_changes WHERE project_id = $1 AND undo IS NULL AND user_id = $2) AS first_gone FROM mcp_changes WHERE project_id = $1`, [pid, adminId, eveId]);
check('only the newest 20 changes keep their undo, and none older than a week', undo.kept === 20 && undo.total === 26 && undo.stale === 0 && undo.first_gone === 'change 0', JSON.stringify(undo));

// new writes go straight to blobs
const up = async (doc, seq, content) => fetch(`${BASE}/api/docs/${doc}/snapshots?seq=${seq}`, { method: 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/octet-stream' }, body: content });
const c = await mkDoc(pid, 'c.kicad_pcb', 'kicad_pcb');
const r0 = await up(c, 0, v2);
check('an uploaded snapshot is accepted', r0.ok, `status ${r0.status}`);
const crow = await one(`SELECT content IS NULL AS no_copy, encode(blob, 'hex') AS blob FROM snapshots WHERE doc_id = $1 AND seq = 0`, [c]);
check('a new snapshot of a known file adds no bytes', crow && crow.no_copy && crow.blob === row(a, 12).blob);
check('and reads back', (await file(c, 0)).equals(v2));

// the way back
check('expanding starts', (await post(admin, '/api/admin/storage/expand')).status === 200);
await new Promise((r) => setTimeout(r, 300)); await settle();
const back = (await db.query('SELECT doc_id, seq, content FROM snapshots WHERE doc_id = ANY($1)', [docs])).rows;
const whole = (d, s) => back.find((r) => r.doc_id === d && r.seq === s).content;
check('expanding gives every snapshot its whole file back', back.every((r) => r.content !== null) && whole(a, 0).equals(v0) && whole(a, 7).equals(v1) && whole(a, 12).equals(v2) && whole(bin, 0).equals(binary));
await post(admin, '/api/admin/storage/compact'); await new Promise((r) => setTimeout(r, 300)); await settle();
check('and compacting again clears them', (await waitingHere()) === 0 && (await file(a, 12)).equals(v2));

// a base outlives the snapshot that brought it for as long as a difference needs it
await db.query('DELETE FROM snapshots WHERE seq = 0 AND doc_id = ANY($1)', [[a, b]]);
await db.query(`UPDATE blobs SET created_at = now() - interval '2 days'`);
await db.query(`DELETE FROM blobs b WHERE b.created_at < now() - interval '1 day' AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.blob = b.hash) AND NOT EXISTS (SELECT 1 FROM blobs d WHERE d.base = b.hash)`);
check('a difference still reads after its base snapshot is pruned', (await file(a, 7)).equals(v1) && (await file(a, 12)).equals(v2));

await db.query('DELETE FROM projects WHERE id = $1', [pid]);
await db.query('DELETE FROM users WHERE id = ANY($1)', [[adminId, eveId]]);
await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
