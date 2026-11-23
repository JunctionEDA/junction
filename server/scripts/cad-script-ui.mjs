// Browser test of custom features (web/domains/mechanical/script), in the real app:
//
//   editor     "New custom feature…" in the Custom features drop-down opens the editor on a starter script,
//              previewed on the part with its generated dialog; a script that does not read shows the problem on
//              its line and leaves the last good preview up; console output and the reports are listed
//   sandbox    a script that loops for ever is stopped with "took too long" and the studio goes on working; one
//              that reaches for the network or the page fails; neither changes the part
//   library    Add an example, Save, rename, duplicate, export, import, delete; the project's features under
//              "This project" in the drop-down and in the tool search
//   features   a custom feature is added to the part, its parameter edited, suppressed and unsuppressed, and
//              kept over a reload; a second person in the project sees it built, has it in their toolbar, and is
//              told on the feature's row when the script has changed (one click updates) or is gone
//   assistant  "describe the feature": with a scripted stand-in for the model (no API key is used here), the
//              loop runs the candidate on the part, is refused a proposal it has not run, proposes; the person
//              sees the difference and the preview, and nothing changes until Accept
//
// Setup as the other cad-*-ui.mjs scripts (see cad-ui.mjs): a server with KC_DEV_LOGIN=1, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8430] [SHOTS=/some/dir] node scripts/cad-script-ui.mjs
//
// With SHOTS it saves script-*.png there (light theme, two device pixels per pixel).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, toolTitles } from './cad-chrome.mjs';
import { setCad } from './cad-setting.mjs';
import { BASE, S, jwt, launch, user } from './cad-ux-lib.mjs';
import { pickOption } from './kselect-pick.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const SIZE = { width: 1600, height: 960 };
const exemplar = (id) => fs.readFileSync(path.join(here, '..', 'web', 'domains', 'mechanical', 'script', 'assets', 'exemplars', `${id}.js`), 'utf8');

const browser = await launch();
const errors = [];
async function signedIn(uid, login) {
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, colorScheme: 'light', acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await setCad(BASE, jwt(uid, login));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}
const shot = async (page, name, clip) => {
  if (!SHOTS) return;
  await page.waitForTimeout(500);
  for (let i = 0; i < 3; i++) { try { await page.screenshot({ path: `${SHOTS}/script-${name}.png`, clip }); return; } catch (e) { await page.waitForTimeout(500); } }
  console.log(`(no picture of ${name})`);
};

// ---- what the script asks the page
const st = (page) => S(page, () => {
  const studio = window.JunctionPartStudio, s = studio.getState();
  return {
    features: s.features.map((f) => ({ id: f.id, name: f.name, type: f.featureType, params: JSON.parse(JSON.stringify(f.params)), suppressed: !!f.suppressed })),
    reports: Object.fromEntries(Object.entries(s.reports).map(([id, r]) => [id, { status: r.status, message: r.message || '', info: r.info || '' }])),
    bodies: s.bodies.map((b) => ({ id: b.id, faces: b.mesh ? b.mesh.faces.names.length : (studio.view.bodyObjects(b.id)?.result.mesh?.faces.names.length || 0) })),
    editing: s.editing ? { id: s.editing.draft.id, type: s.editing.draft.featureType, isNew: s.editing.isNew, params: JSON.parse(JSON.stringify(s.editing.draft.params)) } : null,
    library: (window.JunctionShell ? window.JunctionShell.getState().items : []).filter((i) => i.type === 'feature-script').map((i) => ({ id: i.id, name: i.name, bytes: String(i.source).length })),
    canEdit: s.canEdit,
  };
});
const idle = (page) => page.waitForFunction(() => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.kernel.state === 'ready'; }, null, { timeout: 120000, polling: 100 });
/** every built feature has reported and no dialog is open */
const built = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 120000, polling: 150 });
/** the open dialog's preview has been built with what the dialog holds now */
const previewed = async (page) => {
  await page.waitForTimeout(120);   // the regeneration is scheduled a few milliseconds after a change
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id]; }, null, { timeout: 120000, polling: 150 });
};
const volume = (page) => S(page, async () => { const m = await window.JunctionPartStudio.kernel.call('mass-properties', { bodies: null, density: {} }); return m.total.volume; });
const editor = '[data-script-editor]';
/** replace the whole script as a person would: select all, type */
const setScript = async (page, text) => {
  await page.click(`${editor} .cm-content`);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
};
const scriptText = (page) => page.evaluate(() => window.JunctionScriptEditor.getState().source);
const output = (page) => page.$eval(`${editor} [data-script-output]`, (el) => el.textContent).catch(() => '');
const status = (page) => page.getAttribute(editor, 'data-script-status');
const rowPill = (page, id) => page.$eval(`[data-feature-row="${id}"]`, (el) => el.querySelector('[data-script-version]')?.getAttribute('data-script-version') || '').catch(() => '');

/** A 160 × 100 × 6 plate with one corner cut off, four M6 holes, a Ø22 bore and a Ø8 hole. */
async function plate(page) {
  await S(page, () => {
    const pts = [[0, 0], [160, 0], [160, 60], [110, 100], [0, 100]], holes = [[12, 12, 6.6], [148, 12, 6.6], [12, 88, 6.6], [104, 88, 6.6], [70, 50, 22], [130, 45, 8]];
    const e = {};
    pts.forEach(([x, y], i) => { e[`p${i}`] = { type: 'point', x, y }; });
    pts.forEach((_, i) => { e[`l${i}`] = { type: 'line', a: `p${i}`, b: `p${(i + 1) % pts.length}` }; });
    holes.forEach(([x, y, d], i) => { e[`h${i}c`] = { type: 'point', x, y }; e[`h${i}`] = { type: 'circle', center: `h${i}c`, r: d / 2 }; });
    const sk = crypto.randomUUID(), ex = crypto.randomUUID();
    window.JunctionPartStudio.commit([
      { id: sk, kind: 'ADDED', typeName: 'feature', item: { id: sk, type: 'feature', featureType: 'sketch', name: 'Sketch 1', order: 'F', params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities: e, constraints: {} } } } },
      { id: ex, kind: 'ADDED', typeName: 'feature', item: { id: ex, type: 'feature', featureType: 'extrude', name: 'Plate', order: 'M', params: { profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth: 6, flip: false, targets: [] } } },
    ]);
  });
  await built(page, 2);
}

try {
  const aliceId = user('script-alice', 993001), bobId = user('script-bob', 993002);
  const alice = await signedIn(aliceId, 'script-alice');
  const project = await alice.evaluate(async () => (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Custom features test' }) })).json());
  const pid = project.projectId;
  await alice.evaluate(async ({ pid }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'script-bob', role: 'editor' }) })).status, { pid });
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await alice.click('[data-doc-add]');
  await alice.click('text=New part studio');
  await alice.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 30000 });
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  const docId = await S(alice, () => window.JunctionPartStudio.host.doc.docId);
  await idle(alice);
  await plate(alice);
  const v0 = await volume(alice);
  check('the plate to work on is built', Math.abs(v0 - 86596.5) < 2, `${v0.toFixed(1)} mm³`);

  // ---------------------------------------------------------------- the editor
  const titles = await toolTitles(alice);
  check('the Custom features drop-down offers New custom feature and the library', titles.includes('New custom feature…') && titles.includes('Custom feature library…'));
  await tool(alice, 'New custom feature…');
  await alice.waitForSelector(editor);
  await previewed(alice);
  let s = await st(alice);
  check('the editor opens on a starter script, previewed as a new feature with its generated dialog', !!s.editing && s.editing.isNew && s.editing.type.startsWith('script:') && s.editing.params.diameter === 8 && s.editing.params.depth === 3 && s.reports[s.editing.id].status === 'ok', JSON.stringify(s.editing && s.reports[s.editing.id]));
  check('the dialog has the fields the script declares', (await alice.$$eval('.cad-dialog [data-param]', (els) => els.map((e) => e.getAttribute('data-param')))).join() === 'diameter,depth' || (await alice.$$eval('.cad-dialog [data-param]', (els) => els.map((e) => e.getAttribute('data-param')))).includes('diameter'));
  check('the preview cuts the part', (await volume(alice)) < v0 - 5);
  check('the output says it built', /Built: a sound solid/.test(await output(alice)), await output(alice));

  // a script that does not read: the problem is on its line, the last good preview stays
  const before = await scriptText(alice);
  await setScript(alice, before.replace('diameter: { type: "length"', 'diameter: { type: "lenght"'));
  await alice.waitForSelector(`${editor} [data-script-problem]`);
  check('a malformed parameter is named', /type "lenght" is not one of/.test(await output(alice)), await output(alice));
  await setScript(alice, before.replace('const middle', 'const middle = ;\n    const m2'));
  await alice.waitForFunction(() => /cannot be read/.test(document.querySelector('[data-script-editor] [data-script-output]')?.textContent || ''), null, { timeout: 20000 });
  const problemLine = await alice.getAttribute(`${editor} [data-script-problem]`, 'data-line');
  check('a syntax error shows with its line, and is marked in the editor', Number(problemLine) > 10 && (await alice.locator(`${editor} .cm-lintRange-error, ${editor} .cm-lint-marker-error`).count()) > 0, `line ${problemLine}`);
  s = await st(alice);
  check('the last good preview stays up meanwhile', !!s.editing && s.reports[s.editing.id].status === 'ok');
  check('Save is refused while the script does not read', (await status(alice)) === 'Does not read');

  // console output, a failure with a sentence, and a failure the script did not plan
  await setScript(alice, 'feature({ title: "Talks", params: { n: { type: "integer", label: "N", default: 3, min: 1 } },\n  evaluate(ctx, p) {\n    console.log("bodies", ctx.bodies().length, "n", p.n);\n    ctx.report("Faces", ctx.body().faces().length);\n    if (p.n > 5) throw ctx.fail("N is too large for this part.");\n    ctx.body().nothing();\n  } });');
  await alice.waitForFunction(() => /not a function/.test(document.querySelector('[data-script-editor] [data-script-output]')?.textContent || ''), null, { timeout: 30000 });
  const out1 = await output(alice);
  check('an exception is reported with its line, and the console output is shown', /not a function \(line 6\)/.test(out1) && /bodies 1 n 3/.test(out1), out1);
  check('the part is as it was when the script fails', Math.abs((await volume(alice)) - v0) < 1);

  // ---------------------------------------------------------------- the sandbox, in the real worker
  await setScript(alice, 'feature({ title: "Loops", params: {}, evaluate(ctx) { let i = 0; while (true) { i++; } } });');
  await alice.waitForFunction(() => /took too long/.test(document.querySelector('[data-script-editor] [data-script-output]')?.textContent || ''), null, { timeout: 120000 });
  check('a script that never ends is stopped and says so', /took too long and was stopped/.test(await output(alice)));
  await setScript(alice, 'feature({ title: "Reaches out", params: {}, evaluate(ctx) {\n  const seen = [typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof importScripts, typeof postMessage, typeof self, typeof window, typeof document, typeof indexedDB, typeof Date, typeof setTimeout, typeof globalThis.__host];\n  console.log(seen.join(","));\n  const F = (function () {}).constructor;\n  console.log("global:" + Object.keys(F("return this")()).sort().join(" "));\n  fetch("/api/me");\n} });');
  await alice.waitForFunction(() => /fetch/.test(document.querySelector('[data-script-editor] [data-script-output]')?.textContent || ''), null, { timeout: 60000 });
  const out2 = await output(alice);
  check('a script has no network, no page and no worker globals', /undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined/.test(out2) && /fetch.*not defined/.test(out2), out2.slice(0, 300));
  check('the constructor trick reaches only the sandbox\'s own globals', /global:Geo2 V3 console feature/.test(out2), out2.slice(0, 400));
  check('the studio still works after both', Math.abs((await volume(alice)) - v0) < 1);

  // ---------------------------------------------------------------- the lightening feature, written in the editor
  await setScript(alice, exemplar('lighten-plate'));
  await alice.waitForFunction(() => /Mass saved/.test(document.querySelector('[data-script-editor] [data-script-output]')?.textContent || ''), null, { timeout: 120000 });
  await previewed(alice);
  s = await st(alice);
  const lightened = await volume(alice);
  check('the lightening script previews on the plate: pockets, a sound solid, the mass saved reported', s.reports[s.editing.id].status === 'ok' && /Mass saved: 4\d\.\d %/.test(s.reports[s.editing.id].info) && lightened < v0 * 0.6 && lightened > v0 * 0.4, `${s.reports[s.editing.id].info}; ${lightened.toFixed(0)} mm³`);
  check('the dialog is generated from the script: pattern, rib, margins, corner radius, through', ['face', 'pattern', 'rib', 'margin', 'boss', 'fillet', 'through'].every((k) => s.editing.params[k] !== undefined) && (await alice.locator('.cad-dialog [data-param=pitch]').count()) === 0);
  check('the feature tells the dialog what it saved', /Mass saved/.test(await alice.textContent('.cad-dialog [data-feature-info]')));
  await S(alice, () => window.JunctionPartStudio.viewport.setView('top'));
  await shot(alice, 'editor-truss');

  // a parameter changed in the generated dialog: another pattern, and its own fields appear
  await pickOption(alice, '.cad-dialog [data-param=pattern]', 'isogrid').catch(async () => { await alice.click('.cad-dialog [data-param=pattern] >> text=Isogrid'); });
  await previewed(alice);
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.editing && s.editing.draft.params.pattern === 'isogrid' && /Pockets: [3-9]\d/.test(s.reports[s.editing.draft.id]?.info || ''); }, null, { timeout: 120000 });
  check('choosing Isogrid shows the cell size and rebuilds the preview', (await alice.locator('.cad-dialog [data-param=pitch]').count()) === 1);
  await shot(alice, 'editor-isogrid');

  // ---------------------------------------------------------------- saved to the project, added to the part
  check('nothing is in the project until Save', (await st(alice)).library.length === 0 && (await status(alice)) === 'Not saved to the project');
  check('the new script is named after its title', (await alice.inputValue(`${editor} [data-script-name]`)) === 'Lighten plate');
  await alice.click(`${editor} [data-script-save]`);
  await alice.waitForFunction(() => document.querySelector('[data-script-editor]')?.getAttribute('data-script-status') === 'Saved');
  s = await st(alice);
  check('Save puts the script in the project\'s library', s.library.length === 1 && s.library[0].name === 'Lighten plate' && s.library[0].bytes > 2000, JSON.stringify(s.library));
  await alice.click(`${editor} [data-script-add]`);
  await built(alice, 3);
  s = await st(alice);
  const cf = s.features[2];
  check('Add to part makes it a feature of the part, with its own copy of the script', cf.type.startsWith('script:') && cf.params.pattern === 'isogrid' && typeof cf.params.$script.source === 'string' && s.reports[cf.id].status === 'ok' && cf.name === 'Lighten plate 1', `${cf.name} ${cf.type}`);
  const vIso = await volume(alice);
  check('the part is lightened', vIso < v0 * 0.8 && vIso > v0 * 0.5, `${vIso.toFixed(0)} of ${v0.toFixed(0)} mm³`);
  await alice.click(`${editor} [data-script-close]`);
  await alice.waitForSelector(editor, { state: 'detached' });
  await S(alice, () => { window.JunctionPartStudio.viewport.setView('iso'); window.JunctionPartStudio.fit(); });
  await shot(alice, 'plate-isogrid');

  // edited like any feature: a double click, another value, ✓
  await alice.dblclick(`[data-feature-row="${cf.id}"]`);
  await alice.waitForSelector('.cad-dialog [data-param=pattern]');
  await alice.click('.cad-dialog [data-param=pattern] >> text=Truss');
  await previewed(alice);
  await alice.fill('.cad-dialog [data-param=rib]', '5');
  await alice.keyboard.press('Tab');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await built(alice, 3);
  s = await st(alice);
  check('its parameters are edited in the generated dialog', s.features[2].params.pattern === 'truss' && s.features[2].params.rib === 5 && s.reports[cf.id].status === 'ok' && /Pockets: \d+/.test(s.reports[cf.id].info), s.reports[cf.id].info);
  await S(alice, () => window.JunctionPartStudio.fit());
  await shot(alice, 'plate-truss');
  // a value outside the script's limits fails with a sentence naming the field
  await S(alice, (id) => { window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'rib'], value: 0.1 }] }]); }, cf.id);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().reports[id]?.status === 'error', cf.id, { timeout: 60000 });
  s = await st(alice);
  check('a value under the script\'s minimum fails with a sentence', /Rib width must be at least 0\.5 mm/.test(s.reports[cf.id].message), s.reports[cf.id].message);
  check('a failed custom feature leaves the plate as it was', Math.abs((await volume(alice)) - v0) < 1);
  await S(alice, () => window.JunctionPartStudio.undo());
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().reports[id]?.status === 'ok', cf.id, { timeout: 60000 });
  // suppressed and back
  await S(alice, (id) => { window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['suppressed'], value: true }] }]); }, cf.id);
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().reports[id]?.status === 'suppressed', cf.id, { timeout: 60000 });
  await idle(alice);
  check('suppressed, the plate is whole again', Math.abs((await volume(alice)) - v0) < 1);
  await S(alice, () => window.JunctionPartStudio.undo());
  await alice.waitForFunction((id) => window.JunctionPartStudio.getState().reports[id]?.status === 'ok', cf.id, { timeout: 60000 });
  await idle(alice);
  const vTruss = await volume(alice);

  // the toolbar and the tool search have the project's feature
  check('the project\'s feature is in the Custom features drop-down', (await toolTitles(alice)).includes('Lighten plate'));
  await alice.click('.cad-toolbar [data-menu*="Custom features"]');
  const menuText = await alice.textContent('.cad-tb-menu');
  check('under a "This project" heading', /This project/.test(menuText), menuText.slice(-120));
  await alice.keyboard.press('Escape');

  // ---------------------------------------------------------------- a reload, and a second person
  await alice.reload();
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  await built(alice, 3);
  check('after a reload the feature builds the same', Math.abs((await volume(alice)) - vTruss) < 1 && (await st(alice)).library.length === 1);

  const bob = await signedIn(bobId, 'script-bob');
  await bob.goto(`${BASE}/p/${pid}/edit?doc=${docId}`);
  await bob.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  await built(bob, 3);
  let b = await st(bob);
  check('a second person sees the custom feature built in their own browser', b.reports[cf.id].status === 'ok' && Math.abs((await volume(bob)) - vTruss) < 1 && b.canEdit);
  check('and has the project\'s feature in their toolbar', (await toolTitles(bob)).includes('Lighten plate'));
  check('its row carries no mark while it is the project\'s version', (await rowPill(bob, cf.id)) === '');
  await bob.dblclick(`[data-feature-row="${cf.id}"]`);
  await bob.waitForSelector('.cad-dialog [data-param=rib]');
  check('the second person gets the same generated dialog', (await bob.inputValue('.cad-dialog [data-param=rib]')).startsWith('5'));
  await bob.click('.cad-dialog [data-cancel]');

  // the first person changes the script and saves: the feature keeps its copy, and its row says so
  await tool(alice, 'Custom feature library…');
  await alice.waitForSelector('[data-script-library] [data-script-row]');
  await shot(alice, 'library');
  await alice.click('[data-script-library] [data-library-edit]');
  await alice.waitForSelector(editor);
  const v1 = await scriptText(alice);
  await setScript(alice, v1.replace('label: "Rib width", default: 4', 'label: "Rib width", default: 6'));
  await alice.waitForFunction(() => document.querySelector('[data-script-editor]')?.getAttribute('data-script-status') === 'Changed since it was saved');
  await previewed(alice);
  await alice.click(`${editor} [data-script-save]`);
  await alice.waitForFunction(() => document.querySelector('[data-script-editor]')?.getAttribute('data-script-status') === 'Saved');
  await alice.click(`${editor} [data-script-close]`);
  await bob.waitForFunction((id) => document.querySelector(`[data-feature-row="${id}"] [data-script-version]`)?.getAttribute('data-script-version') === 'changed', cf.id, { timeout: 30000 });
  check('when the script changes in the project, the feature\'s row says so for everybody', (await rowPill(bob, cf.id)) === 'changed' && (await rowPill(alice, cf.id)) === 'changed');
  check('and the feature still builds with the version it was made with', Math.abs((await volume(bob)) - vTruss) < 1);
  const typeBefore = (await st(bob)).features[2].type;
  await bob.click(`[data-feature-row="${cf.id}"] [data-script-version]`);
  await bob.waitForFunction((id) => !document.querySelector(`[data-feature-row="${id}"] [data-script-version]`), cf.id, { timeout: 30000 });
  await built(bob, 3);
  b = await st(bob);
  check('one click updates the feature to the project\'s version, keeping its values', b.features[2].type !== typeBefore && b.features[2].params.rib === 5 && /default: 6/.test(b.features[2].params.$script.source) && b.reports[cf.id].status === 'ok');
  await alice.waitForFunction((id) => !document.querySelector(`[data-feature-row="${id}"] [data-script-version]`), cf.id, { timeout: 30000 });

  // ---------------------------------------------------------------- the library
  await tool(bob, 'Custom feature library…');
  await bob.waitForSelector('[data-script-library] [data-script-row]');
  check('the library lists the project\'s feature and where it is used', /Lighten plate/.test(await bob.textContent('[data-script-library] [data-library-list]')) && /used 1 time/.test(await bob.textContent('[data-script-library] [data-library-list]')));
  await bob.click('[data-library-examples]');
  await bob.click('[data-example="hole-slot"]');
  await bob.waitForFunction(() => document.querySelectorAll('[data-script-library] [data-script-row]').length === 2);
  await alice.waitForFunction(() => window.JunctionShell.getState().items.filter((i) => i.type === 'feature-script').length === 2);
  check('an example added by one person is in the other\'s toolbar at once', (await toolTitles(alice)).includes('Hole-to-hole slot'));
  await bob.click('[data-script-row][data-script-name="Hole-to-hole slot"] [data-library-duplicate]');
  await bob.waitForFunction(() => document.querySelectorAll('[data-script-library] [data-script-row]').length === 3);
  await bob.click('[data-script-row][data-script-name="Hole-to-hole slot copy"] [data-library-rename]');
  await bob.fill('[data-library-rename-input]', 'Slot between holes');
  await bob.keyboard.press('Enter');
  await bob.waitForSelector('[data-script-row][data-script-name="Slot between holes"]');
  const [download] = await Promise.all([bob.waitForEvent('download'), bob.click('[data-script-row][data-script-name="Slot between holes"] [data-library-export]')]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
  const file = path.join(tmp, download.suggestedFilename());
  await download.saveAs(file);
  check('a script is exported as a file of its source', download.suggestedFilename() === 'Slot between holes.feature.js' && /feature\(\{/.test(fs.readFileSync(file, 'utf8')));
  await bob.click('[data-script-row][data-script-name="Slot between holes"] [data-library-delete]');
  await bob.click('[data-library-delete-yes]');
  await bob.waitForFunction(() => document.querySelectorAll('[data-script-library] [data-script-row]').length === 2);
  await bob.setInputFiles('[data-library-file]', file);
  await bob.waitForSelector('[data-script-row][data-script-name="Slot between holes"]');
  check('duplicate, rename, delete and import', (await st(bob)).library.map((x) => x.name).sort().join() === 'Hole-to-hole slot,Lighten plate,Slot between holes');
  fs.rmSync(tmp, { recursive: true, force: true });
  // the slot feature used from the library, on the same part
  await bob.click('[data-script-row][data-script-name="Hole-to-hole slot"] [data-library-use]');
  await previewed(bob);
  b = await st(bob);
  check('a library feature is started from the list with its own dialog', !!b.editing && b.editing.params.kind === 'slot' && b.reports[b.editing.id].status === 'ok', JSON.stringify(b.editing && b.reports[b.editing.id]));
  await bob.click('.cad-dialog [data-cancel]');
  // deleting the script from the project: the feature keeps its copy and says so
  await tool(bob, 'Custom feature library…');
  await bob.click('[data-script-row][data-script-name="Lighten plate"] [data-library-delete]');
  check('deleting says that features keep their own copy', /keep their own copy/.test(await bob.textContent('[data-script-library]')));
  await bob.click('[data-library-delete-yes]');
  await bob.click('[data-library-close]');
  await alice.waitForFunction((id) => document.querySelector(`[data-feature-row="${id}"] [data-script-version]`)?.getAttribute('data-script-version') === 'missing', cf.id, { timeout: 30000 });
  await S(alice, () => window.JunctionPartStudio.regenerateNow());
  await built(alice, 3);
  check('a feature whose script is gone from the project says so and still builds', (await rowPill(alice, cf.id)) === 'missing' && (await st(alice)).reports[cf.id].status === 'ok' && !(await toolTitles(alice)).includes('Lighten plate'));
  await bob.close();

  // ---------------------------------------------------------------- written with the assistant (a scripted model)
  await S(alice, (id) => { window.JunctionPartStudio.commit([{ id, kind: 'REMOVED', typeName: 'feature' }]); }, cf.id);
  await built(alice, 2);
  const good = exemplar('vent-pattern'), bad = good.replace('Geo2.grid(area', 'Geo2.gird(area');
  await alice.evaluate(({ good, bad }) => {
    // a stand-in for the model: it answers with what a model would, in the API's own shapes, and keeps what it was sent
    const seen = [], turns = [
      [{ type: 'text', text: 'Here is a vent pattern.' }, { type: 'tool_use', id: 't1', name: 'propose_script', input: { source: bad, summary: 'Untested.' } }],
      [{ type: 'tool_use', id: 't2', name: 'run_script', input: { source: bad } }],
      [{ type: 'text', text: 'A typo: Geo2.grid. Running again, looking from above.' }, { type: 'tool_use', id: 't3', name: 'get_part', input: {} }, { type: 'tool_use', id: 't4', name: 'run_script', input: { source: good, params: { shape: 'hex', size: 6 }, view: 'top' } }],
      [{ type: 'tool_use', id: 't5', name: 'propose_script', input: { source: good, summary: 'Perforates the largest flat face with a grid of openings, kept clear of the edges and the holes. Tried with hexagons on your plate.' } }],
    ];
    let n = 0;
    window.__assistantSeen = seen;
    window.JunctionScriptAssistant = { model: { async send(req) {
      seen.push({ system: req.system.map((b) => b.text).join('').length, tools: req.tools.map((t) => t.name), last: JSON.parse(JSON.stringify(req.messages[req.messages.length - 1])) });
      const content = turns[Math.min(n++, turns.length - 1)].map((b) => (b.type === 'tool_use' ? { ...b, id: `${b.id}_${n}` } : b));
      await new Promise((r) => setTimeout(r, 30));
      return { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'stand-in', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    } } };
  }, { good, bad });
  await tool(alice, 'New custom feature…');
  await alice.waitForSelector(editor);
  await previewed(alice);
  const starter = await scriptText(alice);
  await alice.click(`${editor} [data-script-tab=assistant]`);
  await alice.fill('[data-assistant-prompt]', 'Perforate the plate with a pattern of vent holes, keeping clear of the edges and the mounting holes.');
  await alice.click('[data-assistant-send]');
  await alice.waitForSelector('[data-proposal]', { timeout: 180000 });
  const seen = await alice.evaluate(() => window.__assistantSeen);
  const toolText = (m) => (Array.isArray(m.content) ? m.content.filter((x) => x.type === 'tool_result').map((x) => (typeof x.content === 'string' ? x.content : x.content.filter((c) => c.type === 'text').map((c) => c.text).join(''))).join('\n') : String(m.content));
  check('the assistant is given its instructions, the API, the examples and the three tools', seen[0].system > 20000 && seen[0].tools.join() === 'run_script,get_part,propose_script');
  check('its first message describes the part and carries the request', /"bodies":\[\{/.test(toolText(seen[0].last)) && /"diameter_mm":6\.6/.test(toolText(seen[0].last)) && /Perforate the plate/.test(toolText(seen[0].last)) && /starter template/.test(toolText(seen[0].last)));
  check('a script it has not run is refused as a proposal', /has not built a sound result with run_script/.test(toolText(seen[1].last)), toolText(seen[1].last).slice(0, 120));
  check('a failing run comes back with the error and its line', /FAILED: .*not a function \(line \d+\)/.test(toolText(seen[2].last)), toolText(seen[2].last).slice(0, 160));
  const third = seen[3].last.content;
  const run = third.find((x) => x.tool_use_id.startsWith('t4')), img = run && Array.isArray(run.content) ? run.content.find((c) => c.type === 'image') : null;
  check('a good run comes back with the soundness verdict, the volume change, the reports and a picture', !!run && /the result is a sound solid/.test(toolText(seen[3].last)) && /Volume 86596\.\d+ → \d+/.test(toolText(seen[3].last)) && /Openings: \d+/.test(toolText(seen[3].last)) && !!img && img.source.media_type === 'image/png' && img.source.data.length > 5000, toolText(seen[3].last).slice(0, 200));
  check('get_part answers in the same turn', third.some((x) => x.tool_use_id.startsWith('t3') && /"holes"/.test(typeof x.content === 'string' ? x.content : '')));
  check('the log shows what it did, with the picture of the run', (await alice.locator('[data-assistant-log] [data-entry=tool][data-ok=no]').count()) === 2 && (await alice.locator('[data-assistant-log] [data-entry=tool][data-ok=yes] img').count()) === 1);
  // the proposal: a difference and a preview; nothing is changed yet
  check('the proposal is shown as a difference', (await alice.locator(`${editor} [data-script-diff]`).count()) === 1 && Number(await alice.getAttribute(`${editor} [data-script-diff]`, 'data-added')) > 30);
  check('the buffer is not changed until it is accepted', (await scriptText(alice)) === starter && (await st(alice)).library.length === 2);
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.editing && /Openings: \d+/.test(s.reports[s.editing.draft.id]?.info || ''); }, null, { timeout: 120000 });
  check('the proposal is previewed on the part', (await volume(alice)) < v0 * 0.9);
  await S(alice, () => window.JunctionPartStudio.viewport.setView('top'));
  await shot(alice, 'assistant-proposal');
  await alice.click('[data-proposal-discard]');
  await alice.waitForSelector(`${editor} [data-script-diff]`, { state: 'detached' });
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const r = s.editing && s.reports[s.editing.draft.id]; return !!r && s.kernel.state === 'ready' && r.status === 'ok' && !/Openings/.test(r.info || ''); }, null, { timeout: 120000 });
  check('Discard puts the preview back to the person\'s own script', (await scriptText(alice)) === starter);
  // asked again, the stand-in proposes at once what it ran before (the conversation goes on): accept it
  await alice.fill('[data-assistant-prompt]', 'Propose it again.');
  await alice.click('[data-assistant-send]');
  await alice.waitForSelector('[data-proposal]', { timeout: 120000 });
  await alice.click('[data-proposal-accept]');
  await alice.waitForSelector(`${editor} [data-script-diff]`, { state: 'detached' });
  check('Accept makes the proposal the script in the editor, still unsaved', /Vent pattern/.test(await scriptText(alice)) && (await status(alice)) === 'Not saved to the project' && (await st(alice)).library.length === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) console.log('page errors:\n  ' + errors.join('\n  '));
} catch (e) {
  console.log('CRASH', e);
  for (const pg of browser.contexts().flatMap((c) => c.pages())) console.log('assistant log:', await pg.textContent('[data-assistant-log]').catch(() => '(none)'), '| output:', await pg.textContent('[data-script-output]').catch(() => '(none)'));
  fail++;
} finally {
  await browser.close();
}
process.exit(fail || errors.length ? 1 : 0);
