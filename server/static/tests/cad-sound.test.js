// Node test: a feature whose result the kernel hands back broken (faces crossing, a skin left open) fails with a
// message and leaves the model as it was (kernel/regen.ts, Kernel.sound in kernel/occ.ts).
// The real OpenCascade build runs here.
// Run: node server/static/tests/cad-sound.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, '..', '..');
const esbuild = require(path.join(server, "node_modules", "esbuild"));

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const bundle = esbuild.buildSync({ entryPoints: [path.join(server, "web", "domains", "mechanical", "kernel", "index.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
const K = M.exports;

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

// ---- document helpers
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [`${p}`]: { type: "circle", center: `${p}c`, r } });
const line = (x0, y0, x1, y1, p) => ({ [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y1 }, [`${p}`]: { type: "line", a: `${p}1`, b: `${p}2` } });
const top = { kind: "plane", plane: "top" }, front = { kind: "plane", plane: "front" }, right = { kind: "plane", plane: "right" };
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const feature = (id, type, params) => ({ id, type, name: id, suppressed: false, params });
const datum = (f) => ({ kind: "datum", feature: f });
const face = (body, name) => ({ kind: "face", body, name });
const onFace = (body, name) => ({ kind: "face", ref: face(body, name) });
const edge = (body, a, b) => ({ kind: "edge", body, name: `edge(${[a, b].sort().join("|")})` });

/** A 40 × 20 × 10 block: sides e:side:pa (y = 0), pb (x = 40), pc (y = 20), pd (x = 0); e:start:pa below, e:end:pa on top. */
const block = () => [sketch("s", rect(0, 0, 40, 20, "p")), extrude("e", "s", { depth: 10 })];
const TOP = "e:end:pa", BOTTOM = "e:start:pa", SIDE = (c) => `e:side:p${c}`;
/** The block with a Ø8 hole through it at (10, 10). */
const holed = () => [...block(), sketch("s2", circle(10, 10, 4, "h")), extrude("cut", "s2", { operation: "remove", depth: 10 })];
/** The block with a Ø8 boss 5 high on top at (30, 10). */
const bossed = () => [...block(), sketch("s3", circle(30, 10, 4, "b"), onFace("e", TOP)), extrude("boss", "s3", { operation: "add", depth: 5 })];

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));
const failed = (r, id, re) => { const f = r.features.find((x) => x.id === id); assert.equal(f.status, "error", statuses(r).join("\n")); assert.match(f.message, re); };

const body = (e, id) => (id ? e.state.bodies.find((b) => b.id === id) : e.state.bodies[0]);
const vol = (k, e, id) => k.volume(body(e, id).shape);
async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r };
}

const half = () => ({ a1: { type: "point", x: -30, y: 0 }, a2: { type: "point", x: 30, y: 0 }, ac: { type: "point", x: 0, y: 0 }, al: { type: "line", a: "a1", b: "a2" }, aa: { type: "arc", center: "ac", start: "a1", end: "a2", r: 30 } });
/** A half disc, radius 30 and 15 thick. */
const base = () => [sketch("s", half()), extrude("e", "s", { depth: 15 })];
const FACES = ["e:side:aa", "e:side:al", "e:start:aa", "e:end:aa"];
const filleted = (R) => [...base(), feature("f", "fillet", { edges: FACES.map((n) => face("e", n)), measure: "radius", radius: R })];

test("a sound body is told from a broken one", async () => {
  const { k, engine } = await run(base());
  const shape = body(engine).shape;
  assert.equal(k.sound(shape), true);
  // the same solid inside out
  const inside = shape.Reversed();
  assert.equal(k.sound(inside), false);
  inside.delete();
});

test("a fillet on every edge that fits is built", async () => {
  const { r } = await run(filleted(3));
  allOk(r);
});

test("a fillet on every edge too big for the 15 mm thickness fails, and the part stays as it was", async () => {
  for (const R of [8, 10, 14]) {
    const { k, engine, r } = await run(filleted(R));
    const f = r.features.find((x) => x.id === "f");
    assert.equal(f.status, "error", `radius ${R}: ${statuses(r).join(" ")}`);
    assert.match(f.message, /smaller/);
    near(vol(k, engine), Math.PI * 900 / 2 * 15, 1e-6);
    assert.equal(body(engine).topo.faces.length, 4);
  }
});
