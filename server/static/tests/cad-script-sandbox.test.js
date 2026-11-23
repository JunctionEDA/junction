// Node test: the sandbox a custom feature's script runs in (web/domains/mechanical/script/sandbox.ts) and what a
// script that misbehaves does to a part studio: nothing.  The interpreter is the real one (QuickJS as
// WebAssembly) and the kernel is the real OpenCascade build.
//   • a script sees the language and the Feature API, and nothing of the host (escape attempts)
//   • a script that never ends, eats memory, or calls itself for ever is stopped with a sentence
//   • a script that throws, misuses the API or returns garbage fails its feature and leaves the model as it was
//   • the same script builds the same thing every time (no clock, a fixed random sequence)
// Run: node server/static/tests/cad-script-sandbox.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("./cad-script-kit");

const K = T.kit();
const feature = (body, params = "{}") => `feature({ title: "T", params: ${params}, evaluate(ctx, p) {\n${body}\n} });`;
const V0 = 48000;   // PLATE_C: 120 × 80 × 5
const run = (source, values, o) => T.run(T.PLATE_C(), source, values, o);
const failed = async (source, re, values) => {
  const r = await run(source, values);
  assert.equal(r.status, "error", JSON.stringify(r).slice(0, 400));
  assert.match(r.error.message, re);
  assert.equal(r.volume_after_mm3, V0, "the model is as the feature found it");
  return r;
};

test("a script sees the language and the Feature API, and nothing of the host", async () => {
  const r = await run(feature(`
    const names = ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "postMessage", "self", "window", "document", "process", "require", "module", "Buffer", "globalThis.__host", "globalThis.__hooks", "setTimeout", "setInterval", "queueMicrotask", "Date", "performance", "indexedDB", "navigator", "WebAssembly", "Worker", "Atomics"];
    console.log(names.map((n) => { try { return typeof (0, eval)(n); } catch (e) { return "undefined"; } }).join(","));
    console.log("globals:" + Object.getOwnPropertyNames(globalThis).filter((n) => !/^(Object|Function|Error|EvalError|RangeError|ReferenceError|SyntaxError|TypeError|URIError|InternalError|AggregateError|Array|parseInt|parseFloat|isNaN|isFinite|decodeURI|decodeURIComponent|encodeURI|encodeURIComponent|escape|unescape|Infinity|NaN|undefined|Number|Boolean|String|Math|Reflect|Symbol|eval|globalThis|JSON|RegExp|Proxy|Map|Set|WeakMap|WeakSet|ArrayBuffer|Uint8ClampedArray|Int8Array|Uint8Array|Int16Array|Uint16Array|Int32Array|Uint32Array|BigInt64Array|BigUint64Array|Float16Array|Float32Array|Float64Array|DataView|Promise|BigInt|WeakRef|FinalizationRegistry|Iterator|DOMException|SharedArrayBuffer)$/.test(n)).sort().join(" "));
  `));
  assert.equal(r.status, "ok", JSON.stringify(r.error));
  assert.equal(r.console[0], Array(24).fill("undefined").join(","));
  assert.equal(r.console[1], "globals:Geo2 V3 console feature");
});

test("the usual ways out of a sandbox lead back into it", async () => {
  const r = await run(feature(`
    const F = (function () {}).constructor, G = F("return this")();
    console.log("same global:", G === globalThis, typeof G.fetch, typeof G.process);
    // the functions of the API are the interpreter's own: their constructors make interpreter functions
    const viaApi = ctx.bodies.constructor("return typeof process + typeof require + typeof fetch")();
    console.log("via the API:", viaApi);
    const viaError = (() => { try { null.x; } catch (e) { return e.constructor.constructor("return typeof process")(); } })();
    console.log("via an error:", viaError);
    // what comes back from the host is plain data made inside the interpreter
    const b = ctx.bodies()[0], info = b.bounds;
    console.log("data:", Object.getPrototypeOf(info) === Object.prototype, Object.getPrototypeOf(info.min) === Array.prototype, typeof b.toJSON().$b);
    // and handing the host something odd gets a sentence, not a way in
    for (const odd of [{ $b: "__proto__" }, { $f: ["constructor", "prototype"] }, { $b: { toString() { return "x"; } } }]) { try { ctx.union(odd, odd); } catch (e) { console.log("odd:", e.name); } }
    try { Geo2.offset({ __proto__: { outer: 1 }, outer: "constructor", holes: null }, 1); } catch (e) { console.log("odd shape:", e.name); }
  `));
  assert.equal(r.status, "ok", JSON.stringify(r.error));
  assert.deepEqual(r.console, ["same global: true undefined undefined", "via the API: undefinedundefinedundefined", "via an error: undefined", "data: true true string", "odd: ApiError", "odd: ApiError", "odd: ApiError", "odd shape: ApiError"]);
});

test("the host's table cannot be reached by an op's name", async () => {
  const sb = await K.loadSandbox();
  const seen = [];
  // a script cannot name the host function; this stands in for one that could: only listed ops answer
  const host = (op, args) => { seen.push(op); throw new Error(`"${op}" is not part of the Feature API.`); };
  assert.throws(() => sb.run(`feature({ title: "T", params: {}, evaluate(ctx) { ctx.plane("top"); } });`, { id: "f", name: "f" }, "{}", host), /not part of the Feature API\. \(line 1\)/);
  assert.deepEqual(seen, ["plane"]);
  for (const op of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const r = await run(feature(`try { ctx.plane.call(null); } catch (e) {} ; throw ctx.fail("ok")`));
    assert.equal(r.error.message, "ok", op);
  }
});

test("a script that never ends is stopped, with a sentence, and the model is as it was", async () => {
  const t0 = Date.now();
  const r = await failed(feature("let i = 0; while (true) { i++; }"), /took too long and was stopped/);
  assert.equal(r.error.kind, "timeout");
  assert.ok(Date.now() - t0 < 60000, "well inside a minute");
  // swallowing the stop does not help
  await failed(feature("for (;;) { try { for (;;) {} } catch (e) {} }"), /took too long/);
  // nor does spending the time in the API
  await failed(feature("const big = Geo2.rect(0, 0, 100, 100); for (;;) Geo2.offset(big, 1);"), /more than 50000 calls|took too long/);
});

test("the time allowance is a count of work, the same on every machine", async () => {
  const sb = await K.loadSandbox();
  const src = feature("let s = 0; for (let i = 0; i < 2e5; i++) s += Math.sqrt(i); console.log(s > 0);");
  const used = [0, 1, 2].map(() => sb.run(src, { id: "f", name: "f" }, "{}", () => ({ value: null })).ticks);
  assert.ok(used[0] > 5 && used[0] === used[1] && used[1] === used[2], `ticks ${used}`);
  assert.throws(() => sb.run(src, { id: "f", name: "f" }, "{}", () => ({ value: null }), { ...K.RUN_LIMITS, ticks: Math.floor(used[0] / 2) }), /took too long/);
});

test("a script that eats memory, or calls itself for ever, is stopped", async () => {
  const mem = await failed(feature("const a = []; for (;;) a.push(new Array(100000).fill(1.5));"), /too much memory/);
  assert.equal(mem.error.kind, "memory");
  await failed(feature("const f = () => f(); f();"), /called itself too deeply|too much memory/);
  await failed(feature('let s = "x"; for (;;) s += s;'), /too much memory|string too long|took too long|RangeError|InternalError/);
});

test("a script that throws, misuses the API or answers nonsense fails its feature with the line", async () => {
  const thrown = await failed(feature("const x = null;\nx.y = 1;"), /TypeError.*\(line 3\)/);
  assert.equal(thrown.error.line, 3);
  await failed(feature('throw ctx.fail("Pick the face to pocket.");'), /^Pick the face to pocket\.$/);
  await failed(feature('throw "a bare string";'), /stopped with/);
  await failed(feature("ctx.body().face({ kind: \"plane\" }).cut([[0, 0], [1, 1]], { depth: 1 });"), /empty|nothing to build/);
  await failed(feature("ctx.body().face({ kind: \"plane\" }).cut(42, { depth: 1 });"), /Expected a loop.*\(line 2\)/);
  await failed(feature("ctx.body().face({ kind: \"plane\" }).cut([[NaN, 0], [1, 0], [1, 1]], { depth: 1 });"), /finite numbers|must be|\(line 2\)/);
  await failed(feature("ctx.extrude(Geo2.rect(0, 0, 1, 1), { origin: [0, 0, 0], normal: [0, 0, 0] }, { height: 1 });"), /has no length/);
  await failed(feature("Geo2.nothing(1);"), /not a function \(line 2\)/);
  await failed(feature("return new Promise(() => {});").replace("evaluate(ctx, p)", "async evaluate(ctx, p)"), /must not be async/);
  // a part the kernel would hand back broken is refused by the engine's own check
  const cut = await failed(feature("const f = ctx.body().face({ kind: \"plane\" }); f.cut(Geo2.rect(-50, -50, 500, 500), { through: true });"), /leave nothing of the part/);
  assert.equal(cut.sound, false);
});

test("what a script declares is read without building, and a bad declaration is named", async () => {
  const sb = await K.loadSandbox();
  const ok = sb.describe(`feature({ title: "Good", icon: "hex", params: { a: { type: "length", label: "A", default: 2, min: 1 }, f: { type: "face", label: "F" }, k: { type: "enum", label: "K", options: { x: "X", y: "Y" }, default: "y", show: { a: 2 } } }, evaluate() {} });`);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.manifest.params.map((p) => [p.key, p.type, p.default]), [["a", "length", 2], ["f", "face", undefined], ["k", "enum", "y"]]);
  const cases = [
    ["feature({ title: 'x', params: {}, evaluate() {} }", /cannot be read/],
    ["const a = 1;", /never called feature/],
    ["feature({ title: 'x', params: {} });", /needs an evaluate/],
    ["feature({ title: 'x', params: { a: { type: 'lenght', label: 'A', default: 1 } }, evaluate() {} });", /type "lenght" is not one of/],
    ["feature({ title: 'x', params: { a: { type: 'length', label: 'A' } }, evaluate() {} });", /needs a default number/],
    ["feature({ title: 'x', params: { 'a b': { type: 'boolean', label: 'A', default: true } }, evaluate() {} });", /must start with a letter/],
    ["feature({ title: 'x', icon: 'nope', params: {}, evaluate() {} });", /icon "nope" is not one of/],
    ["feature({ title: 'x', icon: { path: 'M0 0<script>' }, params: {}, evaluate() {} });", /only SVG path commands/],
    ["feature({ title: 'x', params: {}, evaluate() {} }); feature({ title: 'y', params: {}, evaluate() {} });", /more than once/],
    ["while (true) {}", /too long just to be read/],
    ["Geo2.offset([[0,0],[1,0],[1,1]], 1); feature({ title: 'x', params: {}, evaluate() {} });", /only be used inside evaluate/],
  ];
  for (const [src, re] of cases) { const d = sb.describe(src); assert.equal(d.manifest, null, src); assert.match(d.problems[0].message, re, src); }
  assert.equal(sb.describe("feature({ title: 'x',\n params: {},\n evaluate() {} }\n").problems[0].line, 4);
});

test("a manifest from a document is cleaned: an icon is a name or path data, never markup", () => {
  const dirty = { title: "<img src=x onerror=alert(1)>", icon: { path: 'M0 0"/><script>alert(1)</script>' }, description: "d", params: [{ key: "a", type: "length", label: "<b>A</b>", default: 1 }, { key: "__proto__", type: "length", label: "x", default: 1 }, { key: "ok", type: "nope" }] };
  const m = K.cleanManifest(dirty);
  assert.equal(K.iconMarkup(m.icon), K.ICONS.cube, "a bad path falls back to a named icon");
  assert.deepEqual(m.params.map((p) => p.key), ["a"]);
  assert.equal(K.iconMarkup({ path: "M4 4h16v16H4z" }), '<path d="M4 4h16v16H4z"/>');
  assert.equal(K.iconMarkup({ name: "constructor" }), K.ICONS.cube);
  assert.equal(K.iconMarkup({ path: "M0 0' onload='x" }), K.ICONS.cube);
  for (const svg of Object.values(K.ICONS)) assert.ok(!/script|on\w+=|href/i.test(svg));
  // a script reference whose manifest is not one, or whose id is not an id, is not a script
  assert.equal(K.cleanScriptRef({ id: "a/b", source: "x", manifest: m }), null);
  assert.equal(K.cleanScriptRef({ id: "abc", source: "x", manifest: null }), null);
  assert.equal(K.cleanScriptRef({ id: "abc", source: "x", manifest: m }).hash, K.sourceHash("x"));
});

test("the same script builds the same part every time: no clock, and random numbers that repeat", async () => {
  const src = feature(`
    const f = ctx.body().face({ kind: "plane", normal: [0, 0, 1] });
    const holes = [];
    for (let i = 0; i < 12; i++) holes.push(Geo2.circle([10 + Math.random() * 100, 10 + Math.random() * 60], 1 + Math.random() * 2));
    f.cut(Geo2.union(holes), { depth: 2 });
    console.log(typeof Date, Math.random().toFixed(6));
  `);
  const a = await run(src), b = await run(src);
  assert.equal(a.status, "ok", JSON.stringify(a.error));
  assert.equal(a.volume_after_mm3, b.volume_after_mm3);
  assert.deepEqual(a.console, b.console);
  assert.match(a.console[0], /^undefined 0\.\d{6}$/);
  assert.equal(a.bodies[0].faces, b.bodies[0].faces);
});

test("a failed script feature does not stop the features after it, and its values are checked against the script's limits", async () => {
  const k = await T.boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const loops = T.scriptFeature("bad", feature("for (;;) {}"));
  const hole = { ...T.scriptFeature("good", feature('ctx.body().face({ kind: "plane", normal: [0, 0, 1] }).cut(Geo2.circle([60, 40], p.r), { through: true });', '{ r: { type: "length", label: "Radius", default: 5, min: 1, max: 30 } }')), id: "good" };
  const r = await engine.regenerate([...T.PLATE_C(), loops, hole], 4);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "error", "ok"]);
  assert.match(r.features[2].message, /took too long/);
  assert.ok(Math.abs(k.volume(engine.state.bodies[0].shape) - (V0 - Math.PI * 25 * 5)) < 0.5);
  const tooBig = await engine.regenerate([...T.PLATE_C(), loops, { ...hole, params: { ...hole.params, r: 31 } }], 4);
  assert.equal(tooBig.features[3].status, "error");
  assert.match(tooBig.features[3].message, /Radius must be at most 30 mm/);
  // a feature that lost its script says so
  const lost = await engine.regenerate([...T.PLATE_C(), { id: "x", type: "script:gone.abc", name: "x", suppressed: false, params: {} }], 3);
  assert.match(lost.features[2].message, /lost its script/);
  engine.dispose();
});
