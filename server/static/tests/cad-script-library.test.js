// Node test: custom features as documents and as a conversation (web/domains/mechanical/script):
//   • the project's library: scripts are items of the project's own document; add, replace, rename, duplicate,
//     delete as item changes; what is stored comes back the same from the file, beside the tab order
//   • a feature made from a script carries its own copy: it survives the file and builds the same; it is told
//     apart from the library's version (current, changed, missing) and brought up to date keeping its values
//   • the assistant's loop, with a scripted stand-in for the model (no model is called here): the tools run a
//     candidate on a real part through the real kernel, a proposal that was not run is refused, the report
//     and the picture go back to the model, the conversation carries on
//   • the difference shown for a proposal, and the tool catalog of the MCP endpoint
// Run: node server/static/tests/cad-script-library.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("./cad-script-kit");
const { load, server } = require("./cad-load");

const K = T.kit();
const L = load("domains/mechanical/script/library.ts");
const I = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/mechanical/document/format.ts");
const E = load("platform/doctabs/elements.ts");
const A = load("domains/mechanical/script/assistant/loop.ts");
const D = load("domains/mechanical/script/ui/diff.ts");

const manifestOf = async (source) => { const d = (await K.loadSandbox()).describe(source); assert.deepEqual(d.problems, []); return d.manifest; };
const shell = () => I.parseItemDoc(E.newShellText(), E.SHELL_KIND);
const items = (doc) => Array.from(doc.items.values());

test("the library is items of the project's own document, and comes back the same from the file", async () => {
  const doc = shell();
  // somebody placed a tab: the library lives beside what the shell already keeps
  I.applyChanges(doc, [I.addedChange({ id: "tab:abc", type: "tab", order: "M" })]);
  const lighten = T.exemplar("lighten-plate"), slot = T.exemplar("hole-slot");
  const a = L.saveScript(items(doc), { name: "Lighten plate", source: lighten, manifest: await manifestOf(lighten) });
  I.applyChanges(doc, a.changes);
  const b = L.saveScript(items(doc), { name: L.freeName(items(doc), "Lighten plate"), source: slot, manifest: await manifestOf(slot) });
  I.applyChanges(doc, b.changes);
  let lib = L.scriptsOf(items(doc));
  assert.deepEqual(lib.map((s) => s.name), ["Lighten plate", "Lighten plate 2"]);
  assert.equal(lib[0].id, a.id); assert.equal(lib[0].hash, K.sourceHash(lighten)); assert.equal(lib[0].manifest.params.length, 12);
  // through the file
  const again = I.parseItemDoc(I.serializeItemDoc(doc), E.SHELL_KIND);
  assert.deepEqual(L.scriptsOf(items(again)), lib);
  assert.equal(again.items.get("tab:abc").order, "M");
  assert.equal(again.items.get(`cfs:${a.id}`).source, lighten);
  // the shell's own readers do not trip over the scripts
  assert.deepEqual(E.orderedElements([{ key: "abc" }, { key: "x" }], items(again)).map((e) => e.key), ["abc", "x"]);

  // replace: one changed path, the same id; rename; duplicate; delete
  const v2 = lighten.replace("default: 4, min: 0.5", "default: 6, min: 0.5");
  const rep = L.saveScript(items(doc), { id: a.id, name: "Lighten plate", source: v2, manifest: await manifestOf(v2) });
  assert.equal(rep.changes.length, 1); assert.equal(rep.changes[0].kind, "MODIFIED");
  assert.deepEqual(rep.changes[0].props.map((p) => p.path.join(".")).sort(), ["manifest.params", "source"].sort());
  I.applyChanges(doc, rep.changes);
  I.applyChanges(doc, L.renameScript(items(doc), b.id, "Slot between holes"));
  const dup = L.duplicateScript(items(doc), a.id); I.applyChanges(doc, dup.changes);
  lib = L.scriptsOf(items(doc));
  assert.deepEqual(lib.map((s) => s.name), ["Lighten plate", "Slot between holes", "Lighten plate copy"]);
  assert.equal(lib[0].source, v2); assert.equal(lib[2].source, v2); assert.notEqual(lib[2].id, a.id);
  I.applyChanges(doc, L.deleteScript(items(doc), b.id));
  assert.deepEqual(L.scriptsOf(items(doc)).map((s) => s.name), ["Lighten plate", "Lighten plate copy"]);
  assert.deepEqual(L.deleteScript(items(doc), "no-such"), []);
  // two people at once: one renames while the other saves a new source; both land (different paths of one item)
  const mine = shell(), theirs = shell();
  for (const d of [mine, theirs]) I.applyChanges(d, a.changes);
  const rename = L.renameScript(items(mine), a.id, "Pockets"), save = L.saveScript(items(theirs), { id: a.id, name: "Lighten plate", source: v2, manifest: await manifestOf(v2) }).changes;
  for (const d of [mine, theirs]) { I.applyChanges(d, rename); I.applyChanges(d, save); }
  assert.equal(L.scriptsOf(items(mine))[0].name, "Pockets"); assert.equal(L.scriptsOf(items(mine))[0].source, v2);
  assert.deepEqual(L.scriptsOf(items(mine)), L.scriptsOf(items(theirs)));
  // an item that is not a readable script is left out, not thrown on
  I.applyChanges(doc, [I.addedChange({ id: "cfs:bad", type: "feature-script", name: "x", source: 42, manifest: null }), I.addedChange({ id: "cfs:worse", type: "feature-script", name: "x", source: "x", manifest: { title: "<x>", params: "no" } })]);
  assert.equal(L.scriptsOf(items(doc)).filter((s) => s.id === "bad").length, 0);
  assert.equal(L.exportName('Lighten: "plate"/2'), "Lighten plate 2.feature.js"); assert.equal(L.importName("Lighten plate.feature.js"), "Lighten plate");
});

test("a feature made from a script carries its copy through the file and builds the same", async () => {
  const k = await T.boot();
  const source = T.exemplar("lighten-plate"), manifest = await manifestOf(source);
  const ref = { id: "lp", name: "Lighten plate", hash: K.sourceHash(source), source, manifest };
  const def = K.definitionOf(ref);
  assert.equal(def.type, `script:lp.${ref.hash}`); assert.equal(def.toolbarSection, "library"); assert.equal(def.toolbarMenu, "This project");
  assert.deepEqual(def.schema.map((f) => `${f.key}:${f.kind}`).slice(0, 4), ["face:refs", "pattern:enum", "rib:number", "margin:number"]);
  // fields that depend on others are shown and hidden by what the script declares
  const pitch = def.schema.find((f) => f.key === "pitch"), depth = def.schema.find((f) => f.key === "depth");
  assert.equal(pitch.visible({ pattern: "truss" }), false); assert.equal(pitch.visible({ pattern: "hex" }), true);
  assert.equal(depth.visible({ through: true }), false); assert.equal(depth.visible({ through: false }), true);
  const defaults = def.defaults();
  assert.equal(defaults.rib, 4); assert.equal(defaults.face, null); assert.equal(defaults.$script.source, source);

  // a part studio with the plate and the feature, written to its file and read back
  const doc = I.parseItemDoc(F.newPartStudioText(), "part-studio");
  const plate = T.PLATE_A();
  const order = ["F", "M", "T"];
  I.applyChanges(doc, [...plate, { id: "cf", type: def.type, name: "Lighten plate 1", params: { ...defaults, pattern: "isogrid" } }].map((f, i) => I.addedChange({ id: f.id, type: "feature", featureType: f.type, name: f.name, order: order[i], params: f.params })));
  const text = I.serializeItemDoc(doc);
  assert.ok(text.includes('"featureType":"script:lp.'));
  const back = I.parseItemDoc(text, "part-studio");
  const build = async (d) => { const e = new K.RegenEngine(k, K.FEATURES); const feats = F.featuresOf(d); const r = await e.regenerate(F.featureInputs(feats), feats.length); const v = k.volume(e.state.bodies[0].shape); e.dispose(); return { r, v }; };
  const one = await build(doc), two = await build(back);
  assert.deepEqual(one.r.features.map((f) => f.status), ["ok", "ok", "ok"]);
  assert.equal(one.v, two.v); assert.ok(one.v < 86596 * 0.8);
  assert.equal(one.r.features[2].info, two.r.features[2].info);

  // against the library: current, changed, missing; and brought up to date keeping its values
  const lib = (src) => [{ ...ref, source: src, hash: K.sourceHash(src), order: "V" }];
  assert.equal(L.versionOf(lib(source), def.type), "current");
  assert.equal(L.versionOf([], def.type), "missing");
  assert.equal(L.versionOf(lib(source), "extrude"), null);
  const v2 = source.replace('narrowest: { type: "length"', 'extra: { type: "boolean", label: "Extra", default: true },\n    narrowest: { type: "length"').replace('angle: { type: "angle", label: "Pattern angle", default: 0, min: -180, max: 180, show: { pattern: ["isogrid", "hex"] } },\n', "");
  const m2 = await manifestOf(v2);
  assert.equal(L.versionOf(lib(v2), def.type), "changed");
  const feature = back.items.get("cf");
  const up = L.updatedFeature({ ...feature, params: { ...feature.params, rib: 5, $expr: { rib: "#wall" } } }, { ...ref, source: v2, hash: K.sourceHash(v2), manifest: m2 });
  assert.equal(up.featureType, `script:lp.${K.sourceHash(v2)}`); assert.equal(up.id, "cf");
  assert.equal(up.params.pattern, "isogrid"); assert.equal(up.params.rib, 5); assert.equal(up.params.extra, true); assert.equal(up.params.angle, undefined);
  assert.deepEqual(up.params.$expr, { rib: "#wall" }); assert.equal(up.params.$script.source, v2);
  const change = I.modifiedChange(feature, up);
  I.applyChanges(back, [change]);
  const three = await build(back);
  assert.equal(three.r.features[2].status, "ok"); assert.notEqual(three.v, one.v);
});

test("the assistant's loop: tools on a real part, a proposal only after a sound run, the report and picture sent back", async () => {
  const k = await T.boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const sb = await K.loadSandbox();
  const plate = T.PLATE_A();
  const workbench = {
    async describe(source) { const d = sb.describe(source); return { ok: !!d.manifest, problems: d.problems }; },
    async run(source, params, view) { return K.runReport(k, engine, [...plate, T.scriptFeature("cf-try", source, params)], "cf-try", { image: { view, width: 320 } }); },
    async part() { await engine.regenerate(plate, 2); return K.partSummary(k, engine.state); },
  };
  const good = T.exemplar("lighten-plate"), broken = good.replace("Geo2.delaunay(points)", "Geo2.delauney(points)"), unread = "feature({ title: 'x' ";
  // what a model would answer, turn by turn, in the API's own shapes
  const turns = [
    [{ type: "text", text: "A truss lightening feature." }, { type: "tool_use", id: "a", name: "propose_script", input: { source: good, summary: "Not tried." } }],
    [{ type: "tool_use", id: "b", name: "run_script", input: { source: unread } }, { type: "tool_use", id: "c", name: "run_script", input: { source: broken } }, { type: "tool_use", id: "d", name: "get_part", input: {} }],
    [{ type: "tool_use", id: "e", name: "run_script", input: { source: good, params: { pattern: "hex", rib: 3 }, view: "top" } }, { type: "tool_use", id: "f", name: "run_script", input: "not an object" }, { type: "tool_use", id: "g", name: "run_script", input: { source: good, view: "sideways" } }, { type: "tool_use", id: "h", name: "erase_disk", input: {} }],
    [{ type: "text", text: "It builds in both patterns." }, { type: "tool_use", id: "i", name: "propose_script", input: { source: good, summary: "Pockets the plate between its holes, leaving ribs. Tried as a truss and with hexagons on your plate." } }],
    [{ type: "text", text: "This should not be asked for." }],
  ];
  const sent = [];
  let n = 0;
  const model = { async send(req) { sent.push(JSON.parse(JSON.stringify({ system: req.system, tools: req.tools, messages: req.messages }))); const content = turns[n++]; return { id: `m${n}`, type: "message", role: "assistant", model: "stand-in", content, stop_reason: content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }; } };
  const events = [];
  const part = await workbench.part();
  const messages = [{ role: "user", content: A.requestMessage({ request: "Lighten this plate, keeping 4 mm ribs.", source: null, part }) }];
  const proven = new Set();
  const out = await A.runAssistant({ model, workbench, messages, onEvent: (e) => events.push(e), proven });
  assert.equal(n, 4, "the loop ends with the proposal");
  assert.equal(out.proposal.source, good); assert.match(out.proposal.summary, /Pockets the plate/);

  // what the model was given
  const system = sent[0].system.map((b) => b.text).join("");
  assert.ok(system.startsWith(K.PROMPTS.assistant.trim().slice(0, 80)));
  for (const piece of [K.PROMPTS.guide.trim().slice(0, 200), "declare function feature(def: FeatureDef): void;", "interface Context {", "### lighten-plate.js", "### hole-slot.js", "### bracket.js", "### vent-pattern.js", "### engrave-text.js"]) assert.ok(system.includes(piece), piece.slice(0, 40));
  assert.deepEqual(sent[0].system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(sent[0].tools.map((t) => [t.name, t.eager_input_streaming, t.input_schema.required || []]), [["run_script", true, ["source"]], ["get_part", true, []], ["propose_script", true, ["source", "summary"]]]);
  assert.ok(sent[0].tools.every((t) => t.description.length > 80));
  const first = sent[0].messages[0].content;
  assert.match(first, /"diameter_mm":22/); assert.match(first, /The editor is empty: write a new script\./); assert.match(first, /Lighten this plate/);
  assert.deepEqual(sent.map((s) => s.system[0].text === system), [true, true, true, true], "the same instructions every turn: the prefix is cached");

  // what each tool answered
  const results = (i) => sent[i].messages[sent[i].messages.length - 1].content;
  const text = (r) => (typeof r.content === "string" ? r.content : r.content.filter((c) => c.type === "text").map((c) => c.text).join(""));
  let r = results(1);
  assert.equal(r.length, 1); assert.equal(r[0].tool_use_id, "a"); assert.equal(r[0].is_error, true); assert.match(text(r[0]), /has not built a sound result with run_script/);
  r = results(2);
  assert.deepEqual(r.map((x) => x.tool_use_id), ["b", "c", "d"], "every result of a turn in one message, in order");
  assert.equal(r[0].is_error, true); assert.match(text(r[0]), /could not be read, so nothing was built/);
  assert.equal(r[1].is_error, true); assert.match(text(r[1]), /^FAILED: The script stopped with TypeError: not a function \(line \d+\)\./);
  assert.match(text(r[2]), /"holes":\[\{"diameter_mm":6\.6,"count":4\}/);
  r = results(3);
  assert.deepEqual(r.map((x) => x.tool_use_id), ["e", "f", "g", "h"]);
  assert.equal(r[0].is_error, undefined);
  assert.match(text(r[0]), /^Built: the result is a sound solid\.\nVolume 86596\.524 → \d+\.\d+ mm³ \(-\d+\.\d+ %\); 1 body, \d+ faces\.\nPockets: \d+\nMass saved: \d+\.\d %$/);
  const image = r[0].content.find((c) => c.type === "image");
  assert.equal(image.source.type, "base64"); assert.equal(image.source.media_type, "image/png");
  assert.deepEqual(Array.from(Buffer.from(image.source.data, "base64").subarray(1, 4)), [80, 78, 71]);
  assert.equal(r[1].is_error, true); assert.match(text(r[1]), /INVALID_JSON/);
  assert.equal(r[2].is_error, true); assert.match(text(r[2]), /INVALID_JSON/);
  assert.equal(r[3].is_error, true); assert.match(text(r[3]), /no tool called erase_disk/);

  // what the person is shown
  assert.deepEqual(events.filter((e) => e.type === "tool").map((e) => [e.name, e.ok]), [["propose_script", false], ["run_script", false], ["run_script", false], ["get_part", true], ["run_script", true]]);
  assert.ok(events.find((e) => e.type === "tool" && e.ok && e.name === "run_script").png.length > 1000);
  assert.deepEqual(events.filter((e) => e.type === "text").map((e) => e.text), ["A truss lightening feature.", "It builds in both patterns."]);
  assert.deepEqual(events.slice(-2).map((e) => e.type), ["proposal", "stopped"]);

  // a follow-up goes on in the same conversation, and what has been run stays proven
  turns.push([{ type: "tool_use", id: "j", name: "propose_script", input: { source: good, summary: "The same again." } }]);
  n = 5;
  messages.push({ role: "user", content: "Propose it once more." });
  const more = await A.runAssistant({ model, workbench, messages, onEvent: () => {}, proven });
  assert.equal(more.proposal.summary, "The same again.");
  assert.ok(sent[sent.length - 1].messages.length > 8);
  engine.dispose();
});

test("the loop stops with a sentence when the model has nothing to run, refuses, is cut off, or runs out of turns", async () => {
  const workbench = { describe: async () => ({ ok: false, problems: [{ message: "no" }] }), run: async () => { throw new Error("unused"); }, part: async () => ({ units: "mm", bodies: [] }) };
  const once = (content, stop_reason) => ({ async send() { return { id: "m", type: "message", role: "assistant", model: "stand-in", content, stop_reason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }; } });
  const go = async (model, o = {}) => { const events = []; const out = await A.runAssistant({ model, workbench, messages: [{ role: "user", content: "x" }], onEvent: (e) => events.push(e), ...o }); return { out, last: events[events.length - 1], events }; };
  let r = await go(once([{ type: "text", text: "Which face do you mean?" }], "end_turn"));
  assert.equal(r.out.proposal, null); assert.deepEqual(r.last, { type: "stopped", reason: "done" }); assert.equal(r.events[0].text, "Which face do you mean?");
  r = await go(once([{ type: "tool_use", id: "a", name: "run_script", input: { source: "x" } }], "refusal"));
  assert.equal(r.last.reason, "refused");
  r = await go(once([{ type: "tool_use", id: "a", name: "run_script", input: { source: "feature({" } }], "max_tokens"));
  assert.equal(r.last.reason, "error"); assert.match(r.last.message, /cut off/);
  r = await go(once([{ type: "tool_use", id: "a", name: "run_script", input: { source: "x" } }], "tool_use"), { maxTurns: 3 });
  assert.equal(r.last.reason, "turns"); assert.equal(r.events.filter((e) => e.type === "tool").length, 3);
  r = await go({ async send() { throw new Error("The API key was not accepted."); } });
  assert.deepEqual(r.last, { type: "stopped", reason: "error", message: "The API key was not accepted." });
  let calls = 0;
  r = await go({ async send() { if (calls++ < 2) throw Object.assign(new Error("dropped"), { retryable: true }); return { id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }; } });
  assert.equal(calls, 3); assert.equal(r.last.reason, "done");
  const aborted = new AbortController(); aborted.abort();
  r = await go(once([], "end_turn"), { signal: aborted.signal });
  assert.equal(r.last.reason, "aborted");
  assert.match(A.requestMessage({ request: "x", source: "feature({})", part: null, scriptIsStarter: true }), /no body yet[\s\S]*only the starter template/);
});

test("the difference shown for a proposal", () => {
  const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten", b = "one\ntwo\nthree\nFOUR\nfive\nsix\nseven\neight\nnine\nten\neleven";
  const d = D.diffLines(a, b);
  assert.deepEqual(D.diffStat(d), { added: 2, removed: 1 });
  assert.deepEqual(d.filter((l) => l.kind !== "same").map((l) => `${l.kind}:${l.text}:${l.a || ""}:${l.b || ""}`), ["del:four:4:", "add:FOUR::4", "add:eleven::11"]);
  assert.equal(d.filter((l) => l.kind !== "del").map((l) => l.text).join("\n"), b);
  assert.equal(d.filter((l) => l.kind !== "add").map((l) => l.text).join("\n"), a);
  const h = D.hunks(D.diffLines("a\n".repeat(40) + "x", "a\n".repeat(40) + "y"), 2);
  assert.deepEqual(h[0], { kind: "gap", count: 38 }); assert.equal(h.length, 1 + 2 + 2);
  assert.deepEqual(D.diffStat(D.diffLines("same", "same")), { added: 0, removed: 0 });
  const lighten = T.exemplar("lighten-plate");
  assert.deepEqual(D.diffStat(D.diffLines(lighten, lighten.replace("default: 4, min: 0.5", "default: 6, min: 0.5"))), { added: 1, removed: 1 });
});

test("the MCP endpoint's catalog has the cad_script tools, and the server reads them", () => {
  const tools = JSON.parse(fs.readFileSync(path.join(server, "web", "domains", "mechanical", "mcp", "script-tools.json"), "utf8"));
  assert.deepEqual(tools.map((t) => t.name), ["cad_script_guide", "cad_script_list", "cad_script_read", "cad_script_validate", "cad_script_run", "cad_script_write"]);
  assert.deepEqual(tools.filter((t) => t.write).map((t) => t.name), ["cad_script_write"]);
  for (const t of tools) { assert.ok(t.title && t.description.length > 60, t.name); assert.equal(t.input_schema.type, "object"); assert.equal(t.input_schema.additionalProperties, false); for (const k of t.input_schema.required || []) assert.ok(t.input_schema.properties[k], `${t.name}.${k}`); }
  const rust = fs.readFileSync(path.join(server, "src", "mcp.rs"), "utf8");
  assert.ok(rust.includes('include_str!("../web/domains/mechanical/mcp/script-tools.json")'));
  // the host's table has a function for every one of them
  const host = fs.readFileSync(path.join(server, "web", "domains", "mechanical", "mcp", "script-host.ts"), "utf8");
  for (const t of tools) assert.ok(new RegExp(`\\b${t.name}: \\w+`).test(host), t.name);
  assert.ok(fs.readFileSync(path.join(server, "web", "domains", "mcp-tools.ts"), "utf8").includes("SCRIPT_TOOLS"));
  // no other mechanical tool is called cad_script_*, and none of these shadows one
  const others = JSON.parse(fs.readFileSync(path.join(server, "web", "domains", "mechanical", "mcp", "tools.json"), "utf8")).map((t) => t.name);
  assert.ok(!others.some((n) => n.startsWith("cad_script_")));
});
