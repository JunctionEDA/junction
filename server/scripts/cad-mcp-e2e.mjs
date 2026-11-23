// End-to-end proof of the Mechanical CAD tools on the real MCP endpoint: a JSON-RPC session, and nothing else,
// designs a small mechanism from an empty project, the way an AI assistant would:
//
//   a hinged box: a shelled box with two hinge lugs and two screw holes in its floor, a lid with a lug of its
//   own, a hinge pin, and two M3 socket head screws from the server's standard parts
//
// It reads the guide and the catalogue in steps, builds each part in one cad_edit_features call (variables,
// references picked by description, a dry run first), names the parts and gives them materials, puts them in an
// assembly with a revolute mate, two fastened screws and the pin, reads the solve report, opens the lid, checks
// interference and mass, renders (four views in one picture, a section, a motion, an exploded view), reads the
// bill of materials, exports STEP, STL and DXF and reads the STEP back as an MCP resource, and imports it again.
// Error paths are walked on the way: every refusal must say what to do next.
//
// Server as for the other *-e2e scripts, with node on its PATH (the tool host runs in it) and the modelling
// kernel where the host finds it (static/dist/pyodide/occ-kernel.wasm after `npm run build`, or KC_OCC_WASM):
//   DATABASE_URL=… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=dir] node scripts/cad-mcp-e2e.mjs
// With SHOTS the pictures are written there as mcp-*.png and the exports as mcp-*.step / .stl / .dxf.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setCad } from './cad-setting.mjs';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 700) : ''}`); ok ? pass++ : fail++; return ok; };
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

const adaId = user('cad-e2e-ada', 990611), token = jwt(adaId, 'cad-e2e-ada');
const offId = user('cad-e2e-off', 990612), offToken = jwt(offId, 'cad-e2e-off');
const eveId = user('cad-e2e-eve', 990613), eveToken = jwt(eveId, 'cad-e2e-eve');
await setCad(BASE, token); await setCad(BASE, eveToken); await setCad(BASE, offToken, false);

let rpcId = 0, sent = 0, received = 0;
async function rpc(method, params, tok = token, raw = false) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${tok}` }, body });
  const text = await r.text();
  if (tok === token) { sent += body.length; received += text.length; }
  const j = JSON.parse(text);
  if (raw) return j;
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
/** Call a tool: { data (the JSON text parsed, or the text), text, image, links, error, chars }. */
async function tool(name, args, tok = token) {
  const r = await rpc('tools/call', { name, arguments: args }, tok);
  const text = r.content.find((c) => c.type === 'text'), image = r.content.find((c) => c.type === 'image');
  if (r.isError) return { error: text ? text.text : 'failed', data: null, image: null, links: [], chars: text ? text.text.length : 0 };
  let data = null; try { data = JSON.parse(text.text); } catch { data = text.text; }
  return { data, text: text.text, image: image ? Buffer.from(image.data, 'base64') : null, links: r.content.filter((c) => c.type === 'resource_link'), error: null, chars: text.text.length };
}
const shot = (name, t) => { if (SHOTS && t && t.image) fs.writeFileSync(path.join(SHOTS, name), t.image); };
const pngSize = (b) => (b && b.subarray(1, 4).toString() === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
const near = (a, b, eps = 0.05) => typeof a === 'number' && Math.abs(a - b) <= eps;

try {
  // ---------------------------------------------------------------- what the server says of itself
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cad-mcp-e2e', version: '1' } });
  check('the instructions say how to start with the cad tools', /cad_reference topic "guide"/.test(init.instructions) && /cad_edit_assembly/.test(init.instructions) && /millimetres/.test(init.instructions));
  check('the server offers tools, prompts and resources', !!init.capabilities.tools && !!init.capabilities.prompts && !!init.capabilities.resources);
  const listed = (await rpc('tools/list', {})).tools;
  const cad = listed.filter((t) => t.name.startsWith('cad_'));
  const names = cad.map((t) => t.name);
  const want = ['cad_reference', 'cad_feature_types', 'cad_describe', 'cad_get_features', 'cad_get_bodies', 'cad_find_geometry', 'cad_edit_features', 'cad_measure', 'cad_check', 'cad_render_view', 'cad_export', 'cad_import',
    'cad_create_part_studio', 'cad_create_assembly', 'cad_get_assembly', 'cad_edit_assembly', 'cad_search_models', 'cad_get_bom'];
  check('the catalog lists every cad tool', want.every((n) => names.includes(n)), want.filter((n) => !names.includes(n)).join(' ') || names.join(' '));
  check('…with their annotations: reads are read-only, edits destructive', cad.every((t) => t.annotations && typeof t.annotations.readOnlyHint === 'boolean' && t.title)
    && cad.find((t) => t.name === 'cad_get_assembly').annotations.readOnlyHint === true && cad.find((t) => t.name === 'cad_edit_assembly').annotations.destructiveHint === true
    && cad.find((t) => t.name === 'cad_search_models').annotations.openWorldHint === true);
  const catalogChars = JSON.stringify(cad).length;
  check('…and the whole cad catalog is under 45 000 characters', catalogChars < 45000, `${catalogChars} characters for ${cad.length} tools`);
  const off = (await rpc('tools/list', {}, offToken)).tools;
  check('a person with Mechanical CAD off is shown none of it', !off.some((t) => t.name.startsWith('cad_')) && off.some((t) => t.name === 'apply_changes'));
  const refused = await tool('cad_describe', { project: 'x' }, offToken);
  check('…and a call is refused with where to turn it on', /Mechanical CAD is turned off/.test(refused.error || ''), refused.error || 'no error');
  const res = (await rpc('resources/list', {})).resources.map((r) => r.uri);
  check('the resources are the guide, the reference pages and the catalogue', ['junction://cad/guide', 'junction://cad/mates', 'junction://cad/features'].every((u) => res.includes(u)), res.join(' '));
  check('…none of them with CAD off', !(await rpc('resources/list', {}, offToken)).resources.some((r) => r.uri.startsWith('junction://cad/')));
  const guideRes = await rpc('resources/read', { uri: 'junction://cad/guide' });
  check('the guide is read as a resource', /Modelling in Junction/.test(guideRes.contents[0].text) && guideRes.contents[0].text.length < 6000, `${guideRes.contents[0].text.length} characters`);
  const catRes = await rpc('resources/read', { uri: 'junction://cad/features' });
  check('the feature catalogue is read as a resource, one line a type', /- extrude: Extrude/.test(catRes.contents[0].text) && /## Gears/.test(catRes.contents[0].text));
  const prompts = (await rpc('prompts/list', {})).prompts.map((p) => p.name);
  check('the prompts include a bracket and an assembly', prompts.includes('design_bracket') && prompts.includes('make_assembly') && prompts.includes('design_part'), prompts.join(' '));
  const prompt = await rpc('prompts/get', { name: 'make_assembly', arguments: { project: 'Hinge', description: 'a box with a lid' } });
  check('…filled in with what was asked', /project Hinge/.test(prompt.messages[0].content.text) && /a box with a lid/.test(prompt.messages[0].content.text));

  // ---------------------------------------------------------------- discovery, in steps
  const guide = await tool('cad_reference', { topic: 'guide' });
  check('cad_reference gives the same guide as text', !guide.error && typeof guide.data === 'string' && guide.data === guideRes.contents[0].text);
  const badTopic = await tool('cad_reference', { topic: 'welding' });
  check('an unknown topic lists the topics', /topic is one of "guide"/.test(badTopic.error || ''), badTopic.error || '');
  const types = await tool('cad_feature_types', {});
  check('the feature types: the everyday ones a line each, every family named, under 12 000 characters', !types.error && types.data.feature_types.some((f) => f.type === 'shell') && types.data.families.some((f) => f.family === 'Gears') && types.chars < 12000,
    `${types.chars} characters, ${types.data.feature_types && types.data.feature_types.length} types listed`);
  const search = await tool('cad_feature_types', { query: 'hinge' });
  check('a search finds the ready-made hinges', !search.error && search.data.feature_types.some((f) => /hinge/.test(f.type)) && search.chars < 2500, JSON.stringify(search.data.feature_types.map((f) => f.type)));
  const shellType = await tool('cad_feature_types', { type: 'shell' });
  check('one type in full has its parameters and an example', !shellType.error && shellType.data.feature_types[0].parameters.some((p) => p.key === 'thickness') && Array.isArray(shellType.data.feature_types[0].example));
  const noType = await tool('cad_feature_types', { type: 'hollow' });
  check('an unknown type says how to search', /no feature type "hollow"/.test(noType.error || '') && /query/.test(noType.error), noType.error || '');

  // ---------------------------------------------------------------- the project and its documents
  const made = await tool('create_project', { name: `hinged-box-${Date.now().toString(36)}` });
  const project = made.data.project_id;
  check('a project is created', !made.error && !!project, made.error || '');
  for (const name of ['Box', 'Lid', 'Pin']) { const r = await tool('cad_create_part_studio', { project, name }); check(`part studio ${name} is created`, !r.error && r.data.document === `${name}.jpart`, r.error || ''); }
  const twice = await tool('cad_create_part_studio', { project, name: 'Box' });
  check('creating it twice is refused, not doubled', /already has a document called Box\.jpart/.test(twice.error || ''), twice.error || 'no error');
  const asm = await tool('cad_create_assembly', { project, name: 'Hinged box' });
  check('an assembly is created', !asm.error && asm.data.document === 'Hinged box.jasm', asm.error || '');
  const info = await tool('get_project', { project });
  check('get_project lists the part studios and the assembly by kind', info.data.documents.some((d) => d.path === 'Box.jpart' && d.type === 'part studio') && info.data.documents.some((d) => d.path === 'Hinged box.jasm' && /assembly/.test(d.type)), JSON.stringify(info.data.documents));
  const which = await tool('cad_describe', { project });
  check('a call that does not say which document is told the choices', /Say which part studio or assembly \(document\): .*Box\.jpart.*Hinged box\.jasm/.test(which.error || ''), which.error || '');

  // ---------------------------------------------------------------- the box, in one call
  // The hinge axis runs along X at y 54, z 30: behind the back wall, level with the rim.
  const lug = (name, at) => [
    { op: 'add', type: 'plane', ref: `pl${name}`, name: `Lug plane ${name}`, params: { method: 'offset', ref: { kind: 'plane', plane: 'right' }, distance: at } },
    { op: 'add', type: 'sketch', ref: `ls${name}`, name: `Lug ${name} sketch`, plane: `$pl${name}`, shapes: [{ type: 'circle', cx: 54, cy: 30, r: 4 }, { type: 'rectangle', x1: 49, y1: 24, x2: 54, y2: 30 }] },
    { op: 'add', type: 'extrude', name: `Lug ${name}`, params: { profile: `$ls${name}`, operation: 'add', depth: 20 } },
  ];
  const boxEdits = [
    { op: 'set_variable', name: 'wall', value: 2.5 },
    { op: 'add', type: 'sketch', ref: 's', name: 'Outline', plane: 'top', define: true, shapes: [{ type: 'rectangle', x1: 0, y1: 0, x2: 80, y2: 50 }] },
    { op: 'add', type: 'extrude', ref: 'body', name: 'Body', params: { profile: '$s', depth: 30 } },
    { op: 'add', type: 'shell', name: 'Hollow', params: { faces: [{ kind: 'face', body: '$body', pick: 'top' }], thickness: 'wall' } },
    { op: 'add', type: 'sketch', ref: 'holes', name: 'Screw holes', plane: 'top', shapes: [{ type: 'circle', cx: 15, cy: 25, r: 1.7 }, { type: 'circle', cx: 65, cy: 25, r: 1.7 }] },
    { op: 'add', type: 'extrude', name: 'Drill', params: { profile: '$holes', operation: 'remove', depth: 'wall' } },
    ...lug('A', 5), ...lug('B', 55),
    { op: 'add', type: 'sketch', ref: 'pin', name: 'Pin hole sketch', plane: 'right', shapes: [{ type: 'circle', cx: 54, cy: 30, r: 1.5 }] },
    { op: 'add', type: 'extrude', name: 'Pin hole', params: { profile: '$pin', operation: 'remove', endType: 'through' } },
    { op: 'set_part', body: '$body', name: 'Box', material: 'abs', color: '#4a7fb5' },
  ];
  const dry = await tool('cad_edit_features', { project, document: 'Box', edits: boxEdits, dry_run: true });
  check('a dry run of the whole box builds and changes nothing', !dry.error && dry.data.dry_run === true && dry.data.features.length === 13 && dry.data.features.every((f) => f.status === 'ok') && !dry.data.would_fail && dry.data.bodies.length === 1, dry.error || JSON.stringify(dry.data.problems || dry.data.features.filter((f) => f.status !== 'ok')));
  check('…the part studio is still empty', (await tool('cad_get_features', { project, document: 'Box' })).data.features.length === 0);
  const box = await tool('cad_edit_features', { project, document: 'Box', edits: boxEdits, atomic: true });
  check('the box is built by one call of 15 edits', !box.error && box.data.applied.length === 15 && box.data.features.every((f) => f.status === 'ok') && typeof box.data.change_id === 'number', box.error || JSON.stringify(box.data.problems));
  const boxBody = box.data && box.data.bodies[0];
  // 80 x 50 x 30 less the cavity, less two floor holes, plus two lugs, less the pin hole through the lugs
  const lugArea = Math.PI * 16 + 5 * 6 - (Math.PI * 16) * (0.25) - 0;   // the circle and the web, less their overlap (a quarter of the circle lies in the web)
  const boxExpect = 80 * 50 * 30 - 75 * 45 * 27.5 - 2 * Math.PI * 1.7 * 1.7 * 2.5 + 2 * 20 * (lugArea - Math.PI * 2.25);
  check('one body, named Box, of the volume the numbers give (within 1.5 %)', !!boxBody && box.data.bodies.length === 1 && boxBody.name === 'Box' && Math.abs(boxBody.volume_mm3 - boxExpect) / boxExpect < 0.015, boxBody && `${boxBody.volume_mm3} vs ${boxExpect.toFixed(1)}`);
  check('the outline sketch is fully defined, and the answer is small', box.data.sketches.Outline.fully_defined === true && box.data.sketches.Outline.freedoms === 0 && box.chars < 3500, `${box.chars} characters`);
  check('the expression is kept and the variable listed', box.data.variables[0].name === 'wall' && box.data.variables[0].used_by === 2, JSON.stringify(box.data.variables));

  const described = await tool('cad_describe', { project, document: 'Box' });
  check('cad_describe says what is there in a few lines', !described.error && /Box: 80 × 58 × 34 mm/.test(described.data) && /hole walls: .*⌀3\.4 along z/.test(described.data) && /⌀3 along x/.test(described.data) && /g of ABS/.test(described.data) && described.chars < 1500, `${described.chars} characters: ${String(described.data).slice(0, 300)}`);
  const oneFeature = await tool('cad_get_features', { project, document: 'Box', feature: 'Outline' });
  check('one feature in full: the sketch with its entities, regions and definedness', !oneFeature.error && oneFeature.data.feature.params.sketch.entities.p1.type === 'point' && oneFeature.data.feature.sketch.regions === 1 && oneFeature.data.feature.sketch.fully_defined === true && oneFeature.data.used_by.includes('Body'), oneFeature.error || '');
  const compact = await tool('cad_get_features', { project, document: 'Box', compact: true, bodies: false });
  check('the tree read compactly is a line a feature', !compact.error && compact.data.features.length === 13 && !compact.data.features[0].params && !compact.data.bodies && compact.chars < 2200, `${compact.chars} characters`);
  const some = await tool('cad_get_features', { project, document: 'Box', fields: ['status'], bodies: false });
  check('…or with only the keys asked for', !some.error && some.data.features.length === 13 && Object.keys(some.data.features[0]).sort().join() === 'name,status' && some.chars < 900, `${some.chars} characters`);
  const noKey = await tool('cad_get_features', { project, document: 'Box', fields: ['colour'] });
  check('a key that is not there is refused with the keys there are', /A feature has no "colour"\. Its keys are: index, id, name, type, status/.test(noKey.error || ''), noKey.error || '');
  const bodies = await tool('cad_get_bodies', { project, document: 'Box' });
  check('the body has a mass from its material', !bodies.error && bodies.data.bodies[0].material === 'ABS' && near(bodies.data.bodies[0].mass_g, (boxBody.volume_mm3 * 1.04) / 1000, 0.01) && near(bodies.data.total_mass_g, bodies.data.bodies[0].mass_g, 1e-6), JSON.stringify(bodies.data.bodies[0]).slice(0, 300));

  // finding geometry by description
  const holesFound = await tool('cad_find_geometry', { project, document: 'Box', kind: 'face', pick: { hole: true } });
  check('the holes are found by description: two screw holes and the pin hole through two lugs', !holesFound.error && holesFound.data.count === 4 && holesFound.data.matches.filter((m) => m.radius === 1.7).length === 2 && holesFound.data.matches.filter((m) => m.radius === 1.5 && m.axis[0] === 1).length === 2 && holesFound.data.matches.every((m) => m.ref.kind === 'face' && m.ref.body && m.ref.name),
    holesFound.error || JSON.stringify(holesFound.data.matches.map((m) => [m.type, m.radius, m.at])));
  const noHole = await tool('cad_find_geometry', { project, document: 'Box', pick: { hole: true, diameter: 12 } });
  check('a pick that matches nothing says what there is', /No face of this body matches/.test(noHole.error || '') && /cylinder \(hole\)/.test(noHole.error), noHole.error || '');
  const inner = await tool('cad_measure', { project, document: 'Box', items: [{ kind: 'face', pick: { normal: '+x', nearest: [2.5, 25, 15] } }, { kind: 'face', pick: { normal: '-x', nearest: [77.5, 25, 15] } }] });
  check('the inside is 75 mm wide, measured between two picked faces', !inner.error && near(inner.data.between.plane_distance, 75, 1e-3) && near(inner.data.between.min_distance, 75, 1e-3) && inner.data.between.angle === 180, inner.error || JSON.stringify(inner.data.between));
  const thin = await tool('cad_check', { project, document: 'Box', checks: ['validity', 'thickness'], min_wall: 3 });
  check('the thinnest wall is found (2.5 mm), and reported as under the 3 mm asked for', !thin.error && near(thin.data.thickness[0].min_wall_mm, 2.5, 0.05) && thin.data.ok === false && /Box is 2\.\d+ mm thin near/.test(thin.data.findings.join(' ')) && thin.data.validity.ok === true, thin.error || JSON.stringify(thin.data).slice(0, 400));

  // ---------------------------------------------------------------- error paths of an edit
  const wrong = await tool('cad_edit_features', { project, document: 'Box', edits: [{ op: 'set', feature: 'Body', params: { depth: -3 } }, { op: 'add', type: 'filet' }, { op: 'set', feature: 'Hollow', params: { thick: 2 } }] });
  check('invalid edits change nothing and say why, each one', /Nothing was changed/.test(wrong.error || '') && /depth must be at least/.test(wrong.error) && /Did you mean: .*fillet/.test(wrong.error) && /has no parameter "thick"\. Its parameters are: .*thickness/.test(wrong.error), wrong.error || 'no error');
  const tooBig = await tool('cad_edit_features', { project, document: 'Box', atomic: true, edits: [{ op: 'add', type: 'fillet', name: 'Too big', params: { edges: [{ kind: 'edge', body: 'Box', pick: { parallel_to: 'z', length: 30, all: true } }], radius: 60 } }] });
  check('atomic: a valid edit that would not build is refused whole, with a hint', /Nothing was changed \(atomic\)/.test(tooBig.error || '') && /Too big: /.test(tooBig.error) && /Hint: /.test(tooBig.error), tooBig.error || 'no error');
  check('…and nothing was added', (await tool('cad_get_features', { project, document: 'Box', compact: true, bodies: false })).data.features.length === 13);
  const lostPick = await tool('cad_edit_features', { project, document: 'Box', edits: [{ op: 'add', type: 'sketch', plane: { kind: 'face', body: 'Lid', pick: 'top' }, shapes: [{ type: 'circle', cx: 0, cy: 0, r: 1 }] }] });
  check('a pick on a body that is not there names the bodies', /There is no body "Lid"\. The bodies are: Box/.test(lostPick.error || ''), lostPick.error || 'no error');
  // rounding the four outside corners, by a pick
  const corners = await tool('cad_edit_features', { project, document: 'Box', atomic: true, edits: [{ op: 'add', type: 'fillet', name: 'Corners', params: { edges: [{ kind: 'edge', body: 'Box', pick: { parallel_to: 'z', length: 30, all: true } }], radius: 3 } }] });
  check('the four outside corners are rounded by a pick, in one edit', !corners.error && corners.data.features.find((f) => f.name === 'Corners').status === 'ok' && corners.data.bodies[0].volume_mm3 < boxBody.volume_mm3, corners.error || JSON.stringify(corners.data.problems));
  const undone = await tool('undo_changes', { project, change_id: corners.data.change_id });
  check('undo_changes takes it back', !undone.error && undone.data.features.length === 13 && near(undone.data.bodies[0].volume_mm3, boxBody.volume_mm3, 0.01), undone.error || '');

  // ---------------------------------------------------------------- the lid and the pin
  const lid = await tool('cad_edit_features', { project, document: 'Lid', atomic: true, edits: [
    { op: 'add', type: 'plane', ref: 'rim', name: 'Rim', params: { method: 'offset', ref: { kind: 'plane', plane: 'top' }, distance: 30 } },
    { op: 'add', type: 'sketch', ref: 's', name: 'Outline', plane: '$rim', shapes: [{ type: 'rounded_rectangle', x1: 0, y1: 0, x2: 80, y2: 50, radius: 3 }] },
    { op: 'add', type: 'extrude', ref: 'plate', name: 'Plate', params: { profile: '$s', depth: 3 } },
    { op: 'add', type: 'plane', ref: 'pl', name: 'Lug plane', params: { method: 'offset', ref: { kind: 'plane', plane: 'right' }, distance: 30 } },
    { op: 'add', type: 'sketch', ref: 'ls', name: 'Lug sketch', plane: '$pl', shapes: [{ type: 'circle', cx: 54, cy: 30, r: 4 }, { type: 'rectangle', x1: 48, y1: 30, x2: 54, y2: 33 }] },
    { op: 'add', type: 'extrude', name: 'Lug', params: { profile: '$ls', operation: 'add', depth: 20 } },
    { op: 'add', type: 'sketch', ref: 'pin', name: 'Pin hole sketch', plane: 'right', shapes: [{ type: 'circle', cx: 54, cy: 30, r: 1.5 }] },
    { op: 'add', type: 'extrude', name: 'Pin hole', params: { profile: '$pin', operation: 'remove', endType: 'through' } },
    { op: 'set_part', body: '$plate', name: 'Lid', material: 'abs', color: '#d9a441' },
  ] });
  check('the lid is built in place above the box, as one body', !lid.error && lid.data.bodies.length === 1 && lid.data.features.every((f) => f.status === 'ok') && near(lid.data.bodies[0].bbox_mm.min[2], 26, 0.01) && near(lid.data.bodies[0].bbox_mm.max[2], 34, 0.01), lid.error || JSON.stringify(lid.data.problems || lid.data.bodies));
  const pin = await tool('cad_edit_features', { project, document: 'Pin', atomic: true, edits: [
    { op: 'add', type: 'sketch', ref: 's', plane: 'top', shapes: [{ type: 'circle', cx: 0, cy: 0, r: 1.45 }], define: true },
    { op: 'add', type: 'extrude', ref: 'rod', name: 'Rod', params: { profile: '$s', depth: 72 } },
    { op: 'add', type: 'chamfer', name: 'Ends', params: { edges: [{ kind: 'edge', body: '$rod', pick: { type: 'circle', all: true } }], distance: 0.3 } },
    { op: 'set_part', body: '$rod', name: 'Pin', material: 'stainless-steel' },
  ] });
  check('the pin: a rod with both ends chamfered by one pick', !pin.error && pin.data.features.every((f) => f.status === 'ok') && near(pin.data.bodies[0].volume_mm3, Math.PI * 1.45 * 1.45 * 72, 3), pin.error || JSON.stringify(pin.data.problems || pin.data.bodies));

  // ---------------------------------------------------------------- hardware from the standard parts
  const found = await tool('cad_search_models', { query: 'M3x8 socket head' });
  const hit = found.data && found.data.results.find((r) => r.placeable);
  check('the search offers an M3 x 8 socket head screw that can be placed', !found.error && !!hit && /M3/.test(hit.title) && hit.model.provider && hit.size_mm[2] === 11, found.error || JSON.stringify(found.data).slice(0, 300));
  check('a search with nothing to look for says what to type', /query is what to look for/.test((await tool('cad_search_models', { query: ' ' })).error || ''));

  // ---------------------------------------------------------------- the assembly
  const mates = await tool('cad_reference', { topic: 'mates' });
  check('the mates page lists every mate type and has a hinge in one call', !mates.error && /- revolute: Revolute/.test(mates.data) && /- fastened: Fastened/.test(mates.data) && /A hinge in one call/.test(mates.data) && mates.chars < 7000, `${mates.chars} characters`);
  const A = [15, 54, 30];   // the middle of lug A's pin hole
  const asmEdits = [
    { op: 'insert', part: 'Box', ref: 'box', fixed: true },
    { op: 'insert', part: 'Lid', ref: 'lid' },
    { op: 'insert', part: 'Pin', ref: 'pin', at: [120, 0, 0] },
    // the lid's lug is in the middle: its hole's middle is 25 mm along the axis from lug A's
    { op: 'mate', type: 'revolute', name: 'Hinge', a: { instance: '$box', face: { hole: true, diameter: 3, nearest: A } }, b: { instance: '$lid', face: { hole: true, diameter: 3 } }, params: { offset: 25 } },
    { op: 'mate', type: 'fastened', name: 'Pin in lugs', a: { instance: '$box', face: { hole: true, diameter: 3, nearest: A } }, b: { instance: '$pin', face: { type: 'cylinder' } }, params: { offset: 25 } },
    { op: 'insert', standard: 'M3x8 socket head', ref: 's1', name: 'Screw 1' },
    { op: 'insert', model: hit.model, ref: 's2', name: 'Screw 2' },
    // a screw sits with the underside of its head on the rim of its hole in the floor
    { op: 'mate', type: 'fastened', name: 'Screw 1 seat', a: { instance: '$box', edge: { type: 'circle', diameter: 3.4, nearest: [15, 25, 2.5] } }, b: { instance: '$s1', edge: { type: 'circle', diameter: 3, side: 'top' } } },
    { op: 'mate', type: 'fastened', name: 'Screw 2 seat', a: { instance: '$box', edge: { type: 'circle', diameter: 3.4, nearest: [65, 25, 2.5] } }, b: { instance: '$s2', edge: { type: 'circle', diameter: 3, side: 'top' } } },
  ];
  const asmDry = await tool('cad_edit_assembly', { project, document: 'Hinged box', edits: asmEdits, dry_run: true });
  check('a dry run of the assembly solves and places nothing', !asmDry.error && asmDry.data.dry_run === true && asmDry.data.instances.length === 5 && asmDry.data.solve.ok === true, asmDry.error || JSON.stringify(asmDry.data.solve));
  check('…the assembly is still empty', (await tool('cad_get_assembly', { project, document: 'Hinged box' })).data.instances.length === 0);
  const built = await tool('cad_edit_assembly', { project, document: 'Hinged box', edits: asmEdits });
  check('the assembly is made by one call: five instances, four mates', !built.error && built.data.applied.length === 9 && built.data.instances.length === 5 && built.data.mates.length === 4 && built.data.mates.every((m) => m.state === 'ok'), built.error || JSON.stringify(built.data.mates));
  const inst = (r, name) => r.data.instances.find((i) => i.name === name);
  check('the solver leaves one freedom: the lid on its hinge', built.data.solve.ok === true && built.data.solve.freedoms === 1 && inst(built, 'Lid').freedoms === 1 && inst(built, 'Pin').freedoms === 0 && inst(built, 'Screw 1').freedoms === 0 && inst(built, 'Box').fixed === true, JSON.stringify(built.data.solve));
  check('the screws stand in their holes, heads on the floor', near(inst(built, 'Screw 1').position[0], 15, 1e-3) && near(inst(built, 'Screw 1').position[1], 25, 1e-3) && near(inst(built, 'Screw 1').position[2], 2.5, 1e-3) && near(inst(built, 'Screw 2').position[0], 65, 1e-3), JSON.stringify([inst(built, 'Screw 1').position, inst(built, 'Screw 2').position]));
  check('the lid stayed where it was designed (the hinge holds it there)', inst(built, 'Lid').position.every((v) => Math.abs(v) < 1e-3) && !inst(built, 'Lid').rotation, JSON.stringify(inst(built, 'Lid')));
  check('the answer is small', built.chars < 2600, `${built.chars} characters`);

  const pinFound = await tool('cad_find_geometry', { project, document: 'Hinged box', instance: 'Pin', pick: { type: 'cylinder' } });
  check('the pin lies along the hinge axis, through both of the box\'s lugs', !pinFound.error && pinFound.data.matches[0].axis[0] === 1 && near(pinFound.data.matches[0].at[0], 40, 1e-2) && near(pinFound.data.matches[0].at[1], 54, 1e-2) && near(pinFound.data.matches[0].at[2], 30, 1e-2) && pinFound.data.matches[0].ref.instance === 'Pin',
    pinFound.error || JSON.stringify(pinFound.data.matches[0]));

  // error paths of an assembly edit
  const asmWrong = await tool('cad_edit_assembly', { project, document: 'Hinged box', edits: [{ op: 'mate', type: 'hinge', a: {}, b: {} }, { op: 'mate', type: 'revolute', a: { instance: 'Box', face: { hole: true, diameter: 8 } }, b: { instance: 'Lid', face: 'top' } }, { op: 'drive', mate: 'Pin in lugs', value: 10 }, { op: 'insert', standard: 'M3 unobtainium flange' }, { op: 'fix', instance: 'Cover' }] });
  check('invalid assembly edits change nothing and say why, each one', /Nothing was changed/.test(asmWrong.error || '') && /unknown mate type "hinge"\. The types are: /.test(asmWrong.error) && /a on Box: No face of this body matches/.test(asmWrong.error) && /a fastened mate has no value to drive/.test(asmWrong.error) && /no instance "Cover"\. The instances are: Box, Lid/.test(asmWrong.error), asmWrong.error || 'no error');
  check('…the unknown hardware among them', /edit 4 \(insert\): nothing that can be placed matches "M3 unobtainium flange"/.test(asmWrong.error || ''), (asmWrong.error || '').slice(0, 900));

  // ---------------------------------------------------------------- checks: interference, mass
  const clash0 = await tool('cad_check', { project, document: 'Hinged box' });
  check('nothing interferes with the lid closed', !clash0.error && clash0.data.interference.clashes.length === 0 && clash0.data.interference.pairs_checked >= 4 && clash0.data.ok === true, clash0.error || JSON.stringify(clash0.data.findings));
  const gap = await tool('cad_measure', { project, document: 'Hinged box', between: ['Lid', 'Screw 1'] });
  check('the clearance between the lid and a screw head is what the design leaves', !gap.error && near(gap.data.clearance.distance_mm, 30 - 5.5, 0.01), gap.error || JSON.stringify(gap.data.clearance));
  // the screws have no material yet: the total says so; then they get one
  const mass0 = await tool('cad_measure', { project, document: 'Hinged box' });
  check('the total mass is withheld while a part has no material, with what to do', !mass0.error && mass0.data.total.mass_g === undefined && /set_part/.test(mass0.data.total.mass_note), mass0.error || JSON.stringify(mass0.data.total));
  const screwDoc = info.data && (await tool('get_project', { project })).data.documents.find((d) => /M3x8/.test(d.path) && d.type === 'part studio');
  check('the screw is a part studio of the project', !!screwDoc, screwDoc && screwDoc.path);
  const steel = await tool('cad_edit_features', { project, document: screwDoc.path, edits: [{ op: 'set_part', body: (await tool('cad_get_bodies', { project, document: screwDoc.path })).data.bodies[0].id, material: 'steel' }] });
  check('the screw is given a material', !steel.error, steel.error || '');
  const mass = await tool('cad_measure', { project, document: 'Hinged box' });
  const expectMass = (bodies.data.bodies[0].volume_mm3 * 1.04 + lid.data.bodies[0].volume_mm3 * 1.04 + pin.data.bodies[0].volume_mm3 * 8.0) / 1000;
  const screwMass = mass.data && mass.data.instances.find((i) => i.name === 'Screw 1').mass_g;
  check('the assembly has a total mass: the parts by their materials', !mass.error && near(mass.data.total.mass_g, expectMass + 2 * screwMass, 0.02) && screwMass > 0.5 && screwMass < 1.5 && mass.data.total.parts === 5, mass.error || `${mass.data.total.mass_g} vs ${(expectMass + 2 * screwMass).toFixed(3)}`);
  check('…and a centre of mass inside the box', mass.data.total.centre_of_mass[0] > 30 && mass.data.total.centre_of_mass[0] < 50 && mass.data.total.centre_of_mass[2] > 5 && mass.data.total.centre_of_mass[2] < 30, JSON.stringify(mass.data.total.centre_of_mass));

  // ---------------------------------------------------------------- the motion
  // which way the angle opens depends on the axis: find it by trying, as an assistant would with a picture
  let open = 0;
  for (const value of [70, -70]) {
    const driven = await tool('cad_edit_assembly', { project, document: 'Hinged box', edits: [{ op: 'drive', mate: 'Hinge', value }] });
    if (driven.error) continue;
    const top = (await tool('cad_measure', { project, document: 'Hinged box' })).data.total.bbox_mm.max[2];
    if (top > 60) { open = value; break; }
  }
  check('the hinge is driven open: the lid stands up', open !== 0, `opened at ${open}°`);
  const opened = await tool('cad_get_assembly', { project, document: 'Hinged box' });
  const few = await tool('cad_get_assembly', { project, document: 'Hinged box', fields: ['freedoms', 'state', 'values'] });
  check('the assembly read with only the keys asked for', !few.error && Object.keys(few.data.instances[1]).sort().join() === 'freedoms,name' && few.data.instances[1].freedoms === 1 && few.data.mates[0].state === 'ok' && few.chars < 700, few.error || `${few.chars} characters`);
  check('…stored: the mate\'s angle and the lid\'s turn about X', !opened.error && near(opened.data.mates.find((m) => m.name === 'Hinge').values.angle, open, 1e-2) && near(inst(opened, 'Lid').rotation.angle, 70, 1e-2) && Math.abs(inst(opened, 'Lid').rotation.axis[0]) === 1, JSON.stringify(inst(opened, 'Lid')));
  const clash1 = await tool('cad_check', { project, document: 'Hinged box', checks: ['interference'] });
  check('nothing interferes with the lid open either', !clash1.error && clash1.data.interference.clashes.length === 0, clash1.error || JSON.stringify(clash1.data.findings));
  // a clash is found when there is one: the pin pushed sideways into the lug wall would not be one (it is fastened),
  // so move a free copy of the lid down into the box
  const bump = await tool('cad_edit_assembly', { project, document: 'Hinged box', edits: [{ op: 'insert', part: 'Lid', name: 'Stray lid', at: [0, 0, -10] }] });
  const clash2 = await tool('cad_check', { project, document: 'Hinged box', checks: ['interference'] });
  check('a part pushed into another is found, with the overlap in mm3', !bump.error && !clash2.error && clash2.data.ok === false && clash2.data.interference.clashes.some((c) => [c.a, c.b].includes('Stray lid') && [c.a, c.b].includes('Box') && c.volume_mm3 > 100), clash2.error || JSON.stringify(clash2.data.interference));
  const unbump = await tool('undo_changes', { project, change_id: bump.data.change_id });
  check('…and undo_changes takes the stray part out again', !unbump.error && unbump.data.instances.length === 5, unbump.error || '');

  // ---------------------------------------------------------------- seeing it
  const sheet = await tool('cad_render_view', { project, document: 'Hinged box', views: ['iso', 'top', 'front', 'right'], width_px: 1400 });
  shot('mcp-assembly-views.png', sheet);
  check('four views of the open box in one picture', !sheet.error && !!pngSize(sheet.image) && pngSize(sheet.image)[0] === 1400 && sheet.data.instances.length === 5 && /iso, top, front, right/.test(sheet.data.cells), sheet.error || JSON.stringify(sheet.data));
  const motion = await tool('cad_render_view', { project, document: 'Hinged box', view: 'right', drive: { mate: 'Hinge', values: [0, open / 2, open, open * 1.5] }, width_px: 1400 });
  shot('mcp-assembly-motion.png', motion);
  check('the lid\'s motion as four cells of one picture, nothing stored', !motion.error && !!motion.image && motion.data.cells.length === 4 && /Hinge angle 0°/.test(motion.data.cells[0]) && near((await tool('cad_get_assembly', { project, document: 'Hinged box', compact: true })).data.mates[0].values.angle, open, 1e-2), motion.error || JSON.stringify(motion.data));
  const exploded = await tool('cad_render_view', { project, document: 'Hinged box', explode: 1.2, view: 'iso' });
  shot('mcp-assembly-exploded.png', exploded);
  check('an exploded view', !exploded.error && !!exploded.image);
  const section = await tool('cad_render_view', { project, document: 'Hinged box', section: { plane: 'right', offset: -25 }, highlight: [{ kind: 'face', instance: 'Screw 1', pick: { type: 'cylinder', radius: 1.5 } }] });
  shot('mcp-assembly-section.png', section);
  check('a section through a screw, the screw\'s shank highlighted', !section.error && !!section.image && section.data.highlighted === 1 && near(section.data.section.point[0], 15, 0.6), section.error || JSON.stringify(section.data));
  const boxPic = await tool('cad_render_view', { project, document: 'Box', views: ['iso', 'iso_back', 'top', 'right'], highlight: [{ kind: 'face', pick: { hole: true, diameter: 3 } }, { kind: 'edge', pick: { of_face: 'top', all: true } }] });
  shot('mcp-box-views.png', boxPic);
  check('the box alone, its pin holes and rim highlighted', !boxPic.error && !!boxPic.image && boxPic.data.highlighted > 5, boxPic.error || JSON.stringify(boxPic.data));
  const zoom = await tool('cad_render_view', { project, document: 'Hinged box', view: 'iso', zoom_to: ['Pin', 'Lid'], width_px: 700 });
  shot('mcp-assembly-zoom.png', zoom);
  check('zoomed to the lid and the pin', !zoom.error && pngSize(zoom.image)[0] === 700 && zoom.data.zoomed_to.includes('Pin'), zoom.error || '');
  const badView = await tool('cad_render_view', { project, document: 'Hinged box', view: 'sideways' });
  check('an unknown view is refused with the list', /view is one of iso, top/.test(badView.error || ''), badView.error || '');
  const text = await tool('cad_describe', { project, document: 'Hinged box' });
  check('the assembly in words: instances, mates, freedoms', !text.error && /5 instances/.test(text.data) && /Hinge \(revolute: Box to Lid, angle/.test(text.data) && /Freedoms left: 1/.test(text.data) && text.chars < 2200, `${text.chars} characters: ${String(text.data).slice(0, 200)}`);

  // ---------------------------------------------------------------- the bill of materials
  const bom = await tool('cad_get_bom', { project, document: 'Hinged box' });
  const screwRow = bom.data && bom.data.rows.find((r) => /M3x8/.test(r.name));
  check('the bill of materials: four lines, two screws on one', !bom.error && bom.data.lines === 4 && bom.data.parts === 5 && !!screwRow && screwRow.quantity === 2 && bom.data.rows.some((r) => r.name === 'Box' && r.material === 'ABS'), bom.error || JSON.stringify(bom.data.rows));
  const csv = await tool('cad_get_bom', { project, document: 'Hinged box', format: 'csv' });
  check('…and as CSV', !csv.error && typeof csv.data === 'string' && csv.data.split('\n').length >= 5 && /Pin/.test(csv.data), csv.error || '');

  // ---------------------------------------------------------------- files out, and in again
  const step = await tool('cad_export', { project, document: 'Hinged box', format: 'step' });
  check('the assembly is exported as STEP: a link for the person and a resource for the client', !step.error && /\/api\/exports\//.test(step.data.download) && /^junction:\/\/exports\//.test(step.data.resource) && step.data.parts.length === 5 && step.links.length === 1 && step.links[0].uri === step.data.resource, step.error || JSON.stringify(step.data));
  const stepFile = await rpc('resources/read', { uri: step.data.resource });
  const stepText = stepFile.contents[0].text || '';
  check('the resource is the STEP file, with every part named in it', /^ISO-10303-21;/.test(stepText) && /'Box'/.test(stepText) && /'Lid'/.test(stepText) && /'Pin'/.test(stepText) && stepFile.contents[0].mimeType === 'model/step', stepText.slice(0, 80));
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'mcp-hinged-box.step'), stepText);
  const viaLink = await fetch(step.data.download, { headers: { authorization: `Bearer ${token}` } });
  check('the download link gives the same file to a member', viaLink.ok && (await viaLink.text()) === stepText);
  // a project is public to signed-in people unless its owner says otherwise: make this one private
  sql(`UPDATE projects SET public = false WHERE id = '${project}'`);
  const stranger = await rpc('resources/read', { uri: step.data.resource }, eveToken, true);
  check('somebody who is not in the project cannot read it', !!stranger.error && /no such export/.test(stranger.error.message), JSON.stringify(stranger.error || stranger.result).slice(0, 200));
  const stl = await tool('cad_export', { project, document: 'Box', format: 'stl', resolution: 'fine' });
  const stlFile = !stl.error && (await rpc('resources/read', { uri: stl.data.resource })).contents[0];
  check('the box as STL, read as a binary resource', !stl.error && stl.data.triangles > 500 && !!stlFile && typeof stlFile.blob === 'string' && Buffer.from(stlFile.blob, 'base64').length === 84 + 50 * stl.data.triangles, stl.error || JSON.stringify(stl.data));
  if (SHOTS && stlFile) fs.writeFileSync(path.join(SHOTS, 'mcp-box.stl'), Buffer.from(stlFile.blob, 'base64'));
  const dxf = await tool('cad_export', { project, document: 'Lid', format: 'dxf', face: 'top' });
  check('the lid\'s top face as DXF, returned in the answer too', !dxf.error && /SECTION/.test(dxf.data.content) && /ARC|CIRCLE|LINE/.test(dxf.data.content) && dxf.data.curves >= 8, dxf.error || JSON.stringify(dxf.data).slice(0, 300));
  if (SHOTS && dxf.data) fs.writeFileSync(path.join(SHOTS, 'mcp-lid-top.dxf'), dxf.data.content);
  const svg = await tool('cad_export', { project, document: 'Box', format: 'svg', sketch: 'Screw holes' });
  check('a sketch as SVG', !svg.error && /<svg/.test(svg.data.content) && svg.data.curves === 2, svg.error || '');
  const noFace = await tool('cad_export', { project, document: 'Box', format: 'dxf' });
  check('a DXF with nothing to outline says what it needs', /give face .* or sketch/.test(noFace.error || ''), noFace.error || '');
  const curved = await tool('cad_export', { project, document: 'Pin', format: 'dxf', face: { pick: { type: 'cylinder' } } });
  check('…and a curved face is refused with what to pick', /not flat/.test(curved.error || ''), curved.error || '');

  const pinStep = await tool('cad_export', { project, document: 'Pin', format: 'step', name: 'pin-out' });
  const pinText = (await rpc('resources/read', { uri: pinStep.data.resource })).contents[0].text;
  const imported = await tool('cad_import', { project, content: pinText, name: 'Pin copy' });
  check('a STEP file is imported as a new part studio with the same solid', !imported.error && imported.data.document === 'Pin copy.jpart' && imported.data.bodies.length === 1 && near(imported.data.bodies[0].volume_mm3, pin.data.bodies[0].volume_mm3, 0.05) && imported.data.features[0].type === 'import', imported.error || JSON.stringify(imported.data).slice(0, 300));
  const byFile = await tool('cad_import', { project, file: imported.data.from, name: 'Pin again', split: 'one' });
  check('…and again from the file now in the project', !byFile.error && byFile.data.bodies.length === 1, byFile.error || '');
  const notStep = await tool('cad_import', { project, content: 'solid nothing' });
  check('what is not a STEP file is refused', /starts with ISO-10303-21/.test(notStep.error || ''), notStep.error || '');
  const noFile = await tool('cad_import', { project, file: 'models/nope.step' });
  check('a file that is not there lists the ones that are', /There is no STEP file "models\/nope\.step"/.test(noFile.error || '') && /pin-out|Pin copy|models\//.test(noFile.error), noFile.error || '');

  // ---------------------------------------------------------------- the assembly follows its parts
  const wider = await tool('cad_edit_features', { project, document: 'Pin', edits: [{ op: 'set', feature: 'Rod', params: { depth: 76 } }] });
  const after = await tool('cad_find_geometry', { project, document: 'Hinged box', instance: 'Pin', pick: { type: 'cylinder' } });
  check('a part changed in its studio is changed in the assembly: the pin is longer, still centred on the hinge', !wider.error && !after.error && near(after.data.matches[0].length, 76 - 0.6, 0.05) && near(after.data.matches[0].at[0], 40, 0.05), after.error || JSON.stringify(after.data.matches[0]));

  // ---------------------------------------------------------------- roles
  const pid = project;
  sql(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ('${pid}', ${eveId}, 'viewer', ${adaId})`);
  const eveRead = await tool('cad_get_assembly', { project: pid, document: 'Hinged box', compact: true }, eveToken);
  check('a viewer\'s assistant can read the assembly', !eveRead.error && eveRead.data.instances.length === 5, eveRead.error || '');
  const eveEdit = await tool('cad_edit_assembly', { project: pid, document: 'Hinged box', edits: [{ op: 'drive', mate: 'Hinge', value: 0 }] }, eveToken);
  check('…and is refused an edit, with the reason', /can only view/.test(eveEdit.error || ''), eveEdit.error || 'no error');
  const eveExport = await tool('cad_export', { project: pid, document: 'Pin', format: 'step' }, eveToken);
  check('…but may export what they can see', !eveExport.error && /^junction:\/\/exports\//.test(eveExport.data.resource), eveExport.error || '');

  console.log(`\nThe whole session: ${rpcId} requests, ${Math.round(sent / 1000)} k characters sent, ${Math.round(received / 1000)} k received (pictures and files included).`);
} catch (e) {
  check('the session ran to the end', false, e.stack || e.message);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
