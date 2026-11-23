// End-to-end test of the cad_script_* tools on the real MCP endpoint (web/domains/mechanical/mcp/script-host.ts):
// an agent reads the guide, makes a plate, checks a script, tries it on the plate and reads the report and the
// picture, is told what is wrong with a broken one, saves the script to the project, finds it in the library,
// replaces it, and adds the feature to the part studio.  A person with read-only access can try but not write.
//
// Server as for the other *-mcp scripts, built from this checkout (the catalog is compiled in), with node on its
// PATH and the modelling kernel in static/dist/pyodide/occ-kernel.wasm:
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=dir] node scripts/cad-script-mcp.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setCad } from './cad-setting.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); ok ? pass++ : fail++; return ok; };
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
const exemplar = (id) => fs.readFileSync(path.join(here, '..', 'web', 'domains', 'mechanical', 'script', 'assets', 'exemplars', `${id}.js`), 'utf8');

const adaId = user('script-mcp-ada', 993101), token = jwt(adaId, 'script-mcp-ada');
const eveId = user('script-mcp-eve', 993102), eveToken = jwt(eveId, 'script-mcp-eve');
await setCad(BASE, token); await setCad(BASE, eveToken);

let rpcId = 0;
async function rpc(method, params, tok = token) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function tool(name, args, tok = token) {
  const r = await rpc('tools/call', { name, arguments: args }, tok);
  const text = r.content.find((c) => c.type === 'text'), image = r.content.find((c) => c.type === 'image');
  if (r.isError) return { error: text ? text.text : 'failed', data: null, image: null };
  let data = null; try { data = JSON.parse(text.text); } catch { data = text.text; }
  return { data, image: image ? Buffer.from(image.data, 'base64') : null, error: null };
}

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cad-script-mcp', version: '1' } });
  const listed = (await rpc('tools/list', {})).tools;
  const mine = listed.filter((t) => t.name.startsWith('cad_script_'));
  check('the catalog offers the cad_script tools', ['cad_script_guide', 'cad_script_list', 'cad_script_read', 'cad_script_validate', 'cad_script_run', 'cad_script_write'].every((n) => mine.some((t) => t.name === n)), mine.map((t) => t.name).join());
  check('only cad_script_write is marked as changing things', mine.filter((t) => t.annotations.readOnlyHint === false).map((t) => t.name).join() === 'cad_script_write');

  const guide = await tool('cad_script_guide', {});
  check('the guide comes with the API types and the examples', !guide.error && /# Writing custom features/.test(guide.data.guide) && /declare function feature/.test(guide.data.api.text) && guide.data.examples.length === 5 && guide.data.examples.some((e) => e.name === 'lighten-plate'), guide.error || '');

  // ---------------------------------------------------------------- a plate to work on
  const made = await tool('create_project', { name: `script-mcp-${Date.now().toString(36)}` });
  const project = made.data.id || made.data.project_id || made.data.projectId || made.data.name;
  await tool('cad_create_part_studio', { project, name: 'Plate' });
  const plate = await tool('cad_edit_features', { project, document: 'Plate.jpart', edits: [
    { op: 'add', type: 'sketch', ref: 's', plane: 'top', shapes: [{ type: 'rectangle', x1: 0, y1: 0, x2: 160, y2: 100 }, { type: 'circle', cx: 12, cy: 12, r: 3.3 }, { type: 'circle', cx: 148, cy: 12, r: 3.3 }, { type: 'circle', cx: 12, cy: 88, r: 3.3 }, { type: 'circle', cx: 148, cy: 88, r: 3.3 }, { type: 'circle', cx: 80, cy: 50, r: 11 }] },
    { op: 'add', type: 'extrude', params: { profile: '$s', depth: 6 } },
  ] });
  check('a plate with five holes is made with the ordinary cad tools', !plate.error && plate.data.bodies.length === 1, plate.error || '');
  const v0 = plate.data.bodies[0].volume_mm3;

  // ---------------------------------------------------------------- check, try, fix
  const lighten = exemplar('lighten-plate');
  const none = await tool('cad_script_list', { project });
  check('a new project has no custom features', !none.error && none.data.count === 0, none.error || '');
  const bad = await tool('cad_script_validate', { source: lighten.replace('type: "enum", label: "Pattern"', 'type: "choice", label: "Pattern"') });
  check('validate names what is wrong with a declaration', !bad.error && bad.data.ok === false && /type "choice" is not one of/.test(bad.data.problems[0].message), JSON.stringify(bad.data));
  const syntax = await tool('cad_script_validate', { source: 'feature({ title: "x",\n params: {},\n evaluate(ctx) { let = ; } });' });
  check('and gives a syntax error its line', syntax.data.ok === false && syntax.data.problems[0].line === 3, JSON.stringify(syntax.data));
  const good = await tool('cad_script_validate', { source: lighten });
  check('a script that reads comes back with its parameters', good.data.ok === true && good.data.title === 'Lighten plate' && good.data.parameters.find((p) => p.key === 'pattern').options.join() === 'truss,isogrid,hex' && good.data.parameters.find((p) => p.key === 'rib').min === 0.5);

  const broken = await tool('cad_script_run', { project, source: lighten.replace('Geo2.delaunay(points)', 'Geo2.delauney(points)') });
  check('a failing run reports the error and its line, and changes nothing', !broken.error && broken.data.status === 'error' && /not a function \(line \d+\)/.test(broken.data.error.message) && broken.data.error.line > 30 && broken.data.volume_after_mm3 === v0, JSON.stringify(broken.data.error));
  const loop = await tool('cad_script_run', { project, source: 'feature({ title: "L", params: {}, evaluate() { for (;;) {} } });', picture: false });
  check('a script that never ends is stopped on the server too', !loop.error && loop.data.status === 'error' && /took too long/.test(loop.data.error.message), loop.error || JSON.stringify(loop.data.error));
  const reach = await tool('cad_script_run', { project, source: 'feature({ title: "R", params: {}, evaluate() { console.log([typeof process, typeof require, typeof fetch, typeof globalThis.Buffer].join()); } });', picture: false });
  check('and sees nothing of the server it runs on', reach.data.console[0] === 'undefined,undefined,undefined,undefined', JSON.stringify(reach.data.console));

  const trial = await tool('cad_script_run', { project, document: 'Plate.jpart', source: lighten, view: 'top', density: 2.7 });
  check('a trial run reports a sound result, the volume and mass before and after, and what the script reported', !trial.error && trial.data.status === 'ok' && trial.data.sound === true && trial.data.volume_before_mm3 === v0 && trial.data.volume_after_mm3 < v0 * 0.65 && trial.data.mass_after_g < trial.data.mass_before_g && trial.data.reports.some((r) => r.label === 'Mass saved') && /^Built: the result is a sound solid/.test(trial.data.summary), trial.error || trial.data.summary);
  check('with a picture', !!trial.image && trial.image.length > 5000 && trial.image.readUInt32BE(16) === 900);
  if (SHOTS && trial.image) fs.writeFileSync(`${SHOTS}/script-mcp-truss.png`, trial.image);
  const hex = await tool('cad_script_run', { project, source: lighten, params: { pattern: 'hex', pitch: 20, rib: 3 }, view: 'iso' });
  check('parameters are set by key', hex.data.status === 'ok' && Number(hex.data.reports.find((r) => r.label === 'Pockets').value) > 15, hex.error || hex.data.summary);
  if (SHOTS && hex.image) fs.writeFileSync(`${SHOTS}/script-mcp-hex.png`, hex.image);
  const wrongKey = await tool('cad_script_run', { project, source: lighten, params: { ribs: 3 } });
  check('a parameter the script does not have is refused with the list of those it has', /has no parameter "ribs"/.test(wrongKey.error || '') && /rib, margin/.test(wrongKey.error || ''), wrongKey.error);
  const after = await tool('cad_get_bodies', { project });
  check('trials changed nothing', after.data.bodies[0].volume_mm3 === v0);

  // ---------------------------------------------------------------- save, find, replace, use
  const refused = await tool('cad_script_write', { project, source: 'not a script' });
  check('a script that does not read is not written', /Nothing was written/.test(refused.error || ''), refused.error);
  const wrote = await tool('cad_script_write', { project, source: lighten });
  check('the script is saved to the project under its title', !wrote.error && wrote.data.written === 'Lighten plate' && wrote.data.replaced === false, wrote.error || '');
  const list = await tool('cad_script_list', { project });
  check('and is in the library with its parameters', list.data.count === 1 && list.data.scripts[0].name === 'Lighten plate' && list.data.scripts[0].parameters.length === 12);
  const read = await tool('cad_script_read', { project, script: 'lighten plate' });
  check('its source reads back exactly', read.data.source === lighten);
  const byName = await tool('cad_script_run', { project, script: 'Lighten plate', params: { pattern: 'isogrid' }, picture: false });
  check('a saved script is run by name', byName.data.status === 'ok' && byName.data.script === 'Lighten plate');
  const v2 = lighten.replace('label: "Rib width", default: 4', 'label: "Rib width", default: 5');
  const replaced = await tool('cad_script_write', { project, script: 'Lighten plate', source: v2, add_to: 'Plate.jpart', params: { pattern: 'truss', margin: 6 } });
  check('replacing a script and adding the feature to the part studio in one call', !replaced.error && replaced.data.replaced === true && replaced.data.added === true && /Lighten plate 1/.test(replaced.data.feature.name) && replaced.data.run.sound === true, replaced.error || JSON.stringify(replaced.data).slice(0, 300));
  const tree = await tool('cad_get_features', { project });
  const cf = tree.data.features.find((f) => /Lighten plate/.test(f.name));
  check('the feature is in the part studio, built, with the values it was given', !!cf && cf.status === 'ok' && String(cf.type).startsWith('script:') && cf.params.margin === 6 && cf.params.rib === 5, JSON.stringify(cf && { type: cf.type, status: cf.status }));
  const lighter = await tool('cad_get_bodies', { project });
  check('and the plate is lightened', lighter.data.bodies[0].volume_mm3 < v0 * 0.7);
  const undone = await tool('undo_changes', { project });
  const back = await tool('cad_get_bodies', { project });
  check('undo_changes takes the feature back', !undone.error && back.data.bodies[0].volume_mm3 === v0, undone.error || '');

  // ---------------------------------------------------------------- a viewer
  const pid = (await tool('get_project', { project })).data.id;
  await fetch(`${BASE}/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ login: 'script-mcp-eve', role: 'viewer' }) });
  const eveRun = await tool('cad_script_run', { project: pid, script: 'Lighten plate', picture: false }, eveToken);
  check('a viewer can list and try', !eveRun.error && eveRun.data.status === 'ok', eveRun.error || '');
  const eveWrite = await tool('cad_script_write', { project: pid, source: lighten, name: 'Mine' }, eveToken);
  check('but not write', /can only view|read only/.test(eveWrite.error || ''), eveWrite.error);
} catch (e) {
  console.log('CRASH', e);
  fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
