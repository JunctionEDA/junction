// Node test for the inspection and analysis tools of the mechanical and assembly domains: the measure, mass
// properties, interference, clearance and body-brep worker services on the real kernel, the inertia arithmetic,
// and the pure page-side logic (the measure readout, the appearance and material items, the section plane, the
// assembly's broad phase and its combined bill of materials).
// Run: node server/static/tests/cad-analysis.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

const K = load("domains/mechanical/kernel/index.ts");
const MM = load("domains/mechanical/services/_mass-math.ts");

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const sketch = (id, entities, plane = { kind: "plane", plane: "top" }) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
/** a 40 × 20 × 10 block with a 3 mm hole at (10, 10) */
const plate = () => [sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: { type: "point", x: 10, y: 10 }, hole: { type: "circle", center: "hc", r: 3 } }), extrude("e1", "s1")];
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const nearV = (a, b, eps = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], eps)); };

async function model(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  assert.ok(r.features.every((f) => f.status === "ok"), JSON.stringify(r.features));
  const call = async (name, args) => {
    const svc = K.SERVICES.find((s) => s.name === name);
    assert.ok(svc, `service ${name}`);
    // as the worker does: wrappers handed out during the call are deleted after it
    const mine = []; k.scope = mine;
    try { return JSON.parse(JSON.stringify(await svc.run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, args))); }
    finally { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (e) { /* gone */ } } }
  };
  return { k, engine, call };
}
const face = (name, body = "e1") => ({ kind: "face", body, name });
const edge = (name, body = "e1") => ({ kind: "edge", body, name });

test("the analysis services are registered", () => {
  for (const n of ["measure", "mass-properties", "interference", "clearance", "body-brep"]) assert.ok(K.SERVICES.some((s) => s.name === n), n);
});

test("measure one thing: exact area, perimeter, length, radius, axis and position from the B-rep", async () => {
  const { call } = await model(plate());
  const top = (await call("measure", { items: [face("e1:end:ra")] })).items[0];
  assert.equal(top.surface, "plane");
  near(top.area, 800 - 9 * Math.PI); near(top.perimeter, 120 + 6 * Math.PI);
  nearV(top.normal, [0, 0, 1]);
  nearV(top.centroid.slice(2), [10]);

  const hole = (await call("measure", { items: [face("e1:side:hole")] })).items[0];
  assert.equal(hole.surface, "cylinder");
  near(hole.radius, 3); near(Math.abs(hole.axis[2]), 1); nearV(hole.center, [10, 10, 5]);
  near(hole.area, 2 * Math.PI * 3 * 10);
  near(hole.perimeter, 2 * 2 * Math.PI * 3, 1e-6);   // the two circles, not the seam

  const long = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)")] })).items[0];
  assert.equal(long.curve, "line"); near(long.length, 40); near(Math.abs(long.direction[0]), 1);
  const ring = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:hole)")] })).items[0];
  assert.equal(ring.curve, "circle"); near(ring.radius, 3); assert.equal(ring.closed, true); near(ring.length, 6 * Math.PI); nearV(ring.center, [10, 10, 10]);

  const v = (await call("measure", { items: [{ kind: "vertex", body: "e1", name: "vertex(e1:end:ra|e1:side:ra|e1:side:rb)" }] })).items[0];
  nearV(v.point, [40, 0, 10]);

  const totals = await call("measure", { items: [face("e1:end:ra"), face("e1:start:ra"), face("e1:side:ra")] });
  near(totals.totals.area, 2 * (800 - 9 * Math.PI) + 400);
  assert.equal(totals.pair, undefined);
});

test("measure two things: shortest distance, centre to centre, angle and the gap between parallel planes", async () => {
  const { call } = await model(plate());
  const caps = (await call("measure", { items: [face("e1:end:ra"), face("e1:start:ra")] })).pair;
  near(caps.min.distance, 10); near(caps.normalDistance, 10); near(caps.angle, 0);
  near(Math.abs(caps.min.a[2] - caps.min.b[2]), 10);

  const sides = (await call("measure", { items: [face("e1:side:ra"), face("e1:side:rb")] })).pair;
  near(sides.angle, 90); near(sides.min.distance, 0);
  assert.equal(sides.normalDistance, undefined);

  // a point to a hole: centre to centre is square to the hole's axis
  const toHole = (await call("measure", { items: [{ kind: "vertex", body: "e1", name: "vertex(e1:end:ra|e1:side:ra|e1:side:rd)" }, face("e1:side:hole")] })).pair;
  near(toHole.centre.distance, Math.hypot(10, 10));
  near(toHole.min.distance, Math.hypot(10, 10) - 3, 1e-5);

  // a default plane: the top face is 10 above Top; an edge along X lies at 90° to the Right plane
  const toTop = (await call("measure", { items: [face("e1:end:ra"), { kind: "plane", plane: "top" }] })).pair;
  near(toTop.min.distance, 10); near(toTop.normalDistance, 10);
  const lineToRight = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)"), { kind: "plane", plane: "right" }] })).pair;
  near(lineToRight.angle, 90);
  const lineToTop = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)"), { kind: "plane", plane: "top" }] })).pair;
  near(lineToTop.angle, 0);

  // two parallel edges: the distance between the lines
  const edges = (await call("measure", { items: [edge("edge(e1:end:ra|e1:side:ra)"), edge("edge(e1:end:ra|e1:side:rc)")] }));
  near(edges.pair.normalDistance, 20); near(edges.totals.length, 80);

  await assert.rejects(call("measure", { items: [face("gone")] }), /no longer in the model/);
});

test("mass properties: volume, area, mass, centre, inertia tensor, principal moments and box against the formulas", async () => {
  const { call } = await model([sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1")]);
  const r = await call("mass-properties", { bodies: null, density: { e1: 7.85 } });
  const p = r.parts[0];
  near(p.volume, 8000); near(p.area, 2 * (800 + 400 + 200)); nearV(p.centre, [20, 10, 5]);
  nearV(p.bbox, [0, 0, 0, 40, 20, 10], 1e-6);
  const m = 8000 * 7.85e-6;
  near(p.mass, m);
  near(p.inertia.xx, (m * (20 * 20 + 10 * 10)) / 12, 1e-6); near(p.inertia.yy, (m * (40 * 40 + 10 * 10)) / 12, 1e-6); near(p.inertia.zz, (m * (40 * 40 + 20 * 20)) / 12, 1e-6);
  for (const k of ["xy", "xz", "yz"]) assert.ok(Math.abs(p.inertia[k]) < 1e-9, k);
  nearV(r.total.principal.moments, [p.inertia.xx, p.inertia.yy, p.inertia.zz].sort((a, b) => a - b), 1e-6);
  // the old one-body form still answers
  const one = await call("mass-properties", { body: "e1" });
  near(one.volume, 8000); assert.equal(one.parts[0].mass, null); assert.equal(one.total.mass, null);
  await assert.rejects(call("mass-properties", { body: "nope" }), /no longer exists/);
});

test("mass properties of two bodies: the parallel-axis theorem about the common centre", async () => {
  const { call } = await model([sketch("s1", rect(0, 0, 10, 10, "a")), extrude("e1", "s1"), sketch("s2", rect(20, 0, 30, 10, "b")), extrude("e2", "s2")]);
  const r = await call("mass-properties", { density: { e1: 1, e2: 1 } });
  assert.equal(r.parts.length, 2);
  const m = 1000e-6, ic = (m * 200) / 12;
  near(r.total.mass, 2 * m); nearV(r.total.centre, [15, 5, 5]);
  near(r.total.inertia.xx, 2 * ic, 1e-6); near(r.total.inertia.yy, 2 * ic + 2 * m * 100, 1e-6); near(r.total.inertia.zz, 2 * ic + 2 * m * 100, 1e-6);
  nearV(r.total.bbox, [0, 0, 0, 30, 10, 10], 1e-6);
  // one body without a material: no total mass, the centre is by volume
  const half = await call("mass-properties", { density: { e1: 2 } });
  assert.equal(half.total.mass, null); nearV(half.total.centre, [15, 5, 5]);
});

test("inertia arithmetic: a rotated tensor's principal moments, and combining is order-free", () => {
  const c = Math.cos(0.3), s = Math.sin(0.3);
  // diag(1, 4, 9) turned 0.3 rad about z: R D Rᵀ
  const t = { xx: c * c * 1 + s * s * 4, yy: s * s * 1 + c * c * 4, zz: 9, xy: c * s * (1 - 4), xz: 0, yz: 0 };
  const p = MM.principal(t);
  nearV(p.moments, [1, 4, 9], 1e-9);
  near(Math.abs(p.axes[0][0]), c, 1e-9); near(Math.abs(p.axes[0][1]), s, 1e-9);
  const parts = [{ mass: 2, centre: [1, 2, 3], inertia: t }, { mass: 3, centre: [-1, 0, 4], inertia: MM.ZERO_TENSOR }];
  const a = MM.combine(parts), b = MM.combine(parts.slice().reverse());
  for (const k of ["xx", "yy", "zz", "xy", "xz", "yz"]) near(a.inertia[k], b.inertia[k], 1e-12);
  nearV(a.centre, [(2 - 3) / 5, 4 / 5, (6 + 12) / 5], 1e-12);
});

test("interference: shapes go between workers as BRep text, overlapping placements give the exact common volume", async () => {
  const { call } = await model(plate());
  const { bodies } = await call("body-brep", {});
  assert.equal(bodies.length, 1); assert.ok(bodies[0].brep.length > 100); nearV(bodies[0].bbox, [0, 0, 0, 40, 20, 10], 1e-6);
  const brep = bodies[0].brep;
  const at = (x) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0];
  // a fresh worker has not seen the key: it asks for the text
  const ask = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(30) }] });
  assert.deepEqual(ask.missing, ["plate-test-1"]);
  const r = await call("interference", { shapes: [{ key: "plate-test-1", brep, transform: at(0) }, { key: "plate-test-1", transform: at(30) }], mesh: true });
  assert.equal(r.missing.length, 0); assert.equal(r.checked, 1); assert.equal(r.clashes.length, 1);
  // x 30 … 40 of the first plate, less the half of the second plate's hole that reaches into it
  near(r.clashes[0].volume, (10 * 20 - 4.5 * Math.PI) * 10, 1e-6);
  nearV(r.clashes[0].bbox.map((v) => Math.round(v * 1e3) / 1e3), [30, 0, 0, 40, 20, 10]);
  assert.ok(r.clashes[0].mesh.indices.length >= 3 && r.clashes[0].mesh.positions.length % 3 === 0);
  // apart, and face to face: no clash
  const apart = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(45) }] });
  assert.equal(apart.clashes.length, 0); assert.equal(apart.checked, 0);
  const touching = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(40) }] });
  assert.equal(touching.clashes.length, 0); assert.equal(touching.checked, 1);
  // only the listed pairs are checked
  const listed = await call("interference", { shapes: [{ key: "plate-test-1", transform: at(0) }, { key: "plate-test-1", transform: at(30) }, { key: "plate-test-1", transform: at(35) }], pairs: [[0, 2]] });
  assert.equal(listed.clashes.length, 1); assert.deepEqual([listed.clashes[0].a, listed.clashes[0].b], [0, 2]);
});

test("clearance: the smallest gap between two placed solids, and where it is", async () => {
  const { call } = await model(plate());
  const { bodies } = await call("body-brep", { bodies: ["e1"] });
  const quarter = [0, -1, 0, 70, 1, 0, 0, 0, 0, 0, 1, 0];   // turned 90° about z, then moved to x = 70
  const r = await call("clearance", { shapes: [{ key: "plate-test-2", brep: bodies[0].brep, transform: null }, { key: "plate-test-2", transform: quarter }] });
  // turned, the copy spans x 50 … 70: a 10 mm gap to the first plate's end at x = 40
  near(r.results[0].distance, 10, 1e-7);
  near(r.results[0].pa[0], 40, 1e-7); near(r.results[0].pb[0], 50, 1e-7);
});

module.exports = { load };
