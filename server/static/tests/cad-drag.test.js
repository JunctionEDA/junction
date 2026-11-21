// Node test for the numbers that are dragged in the model: where an extrusion says its depth can be taken hold of
// (kernel/protocol.ts DragHandle, features/extrude.ts) and the values a drag stops at (ui/drag-snap.ts).
// The real OpenCascade build runs here.
// Run: node server/static/tests/cad-drag.test.js
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

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r };
}

const snapBundle = esbuild.buildSync({ entryPoints: [path.join(server, "web", "domains", "mechanical", "ui", "drag-snap.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const SM = { exports: {} }; new Function("module", "exports", "require", snapBundle.outputFiles[0].text)(SM, SM.exports, require);
const { snapStep, snapLength } = SM.exports;

const plate = (o = {}) => [sketch("s", rect(-30, -20, 30, 20, "p")), extrude("e", "s", { depth: 12, ...o })];
const handleOf = (r) => r.features.find((f) => f.id === "e").handles;

test("an extrusion says where its depth ends: the middle of the region, along the way it goes", async () => {
  const { r } = await run(plate());
  const h = handleOf(r);
  assert.equal(h.length, 1);
  assert.equal(h[0].key, "depth"); assert.equal(h[0].value, 12); assert.equal(h[0].scale, 1); assert.equal(h[0].flip, "flip");
  h[0].origin.forEach((v, i) => near(v + 1, [0, 0, 0][i] + 1));
  h[0].dir.forEach((v, i) => near(v + 2, [0, 0, 1][i] + 2));
});

test("the other direction turns the arrow over; symmetric counts the depth both ways and has no direction to turn", async () => {
  let h = handleOf((await run(plate({ flip: true }))).r)[0];
  near(h.dir[2], -1);
  h = handleOf((await run(plate({ endType: "symmetric" }))).r)[0];
  assert.equal(h.scale, 2); assert.equal(h.flip, undefined); near(h.dir[2], 1);
});

test("through all has no depth to drag, and a depth that fails can still be dragged back", async () => {
  const cut = [...plate(), sketch("s2", rect(-5, -5, 5, 5, "q")), { ...extrude("c", "s2", { operation: "remove", endType: "through" }) }];
  const { r } = await run(cut);
  assert.equal(r.features.find((f) => f.id === "c").handles, undefined);
  const bad = await run(plate({ depth: -3 }));
  assert.equal(bad.r.features.find((f) => f.id === "e").status, "error");
});

test("the step is 1, 2 or 5 of a round size, finer the closer the view", () => {
  assert.equal(snapStep(0.1), 1);      // 14 px are 1.4 mm
  assert.equal(snapStep(0.2), 2);
  assert.equal(snapStep(0.5), 5);
  assert.equal(snapStep(1), 10);
  assert.equal(snapStep(0.01), 0.1);
  assert.equal(snapStep(0.004), 0.05);
  assert.equal(snapStep(1e-9, 3), 0.001);   // never finer than the places the document shows
});

test("a dragged length stops at a step, holds on at the round values, and is never nothing", () => {
  assert.equal(snapLength(12.4, 0.1), 12);
  assert.equal(snapLength(12.6, 0.1), 13);
  assert.equal(snapLength(9.2, 0.1), 10);     // within reach of the ten
  assert.equal(snapLength(8.9, 0.1), 9);
  assert.equal(snapLength(0.2, 0.1), 1);      // not zero
  assert.equal(snapLength(47, 0.5), 50);      // by fives, and the fifty holds
  assert.equal(snapLength(37, 0.5), 35);
  assert.equal(snapLength(3.14159, 0.01), 3.1);
  assert.equal(snapLength(12.3456789, 0.1, { free: true }), 12.346);
  assert.equal(snapLength(12.3456789, 0.1, { free: true, places: 1 }), 12.3);
});
