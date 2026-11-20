// Node test for sheet metal (web/domains/mechanical/features/sm-*.ts, kernel/ops/sheetmetal*.ts) and frames
// (features/frame*.ts, kernel/ops/frame*.ts) in the part studio.  The real OpenCascade build runs here.
// Run: node server/static/tests/cad-sheetmetal.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
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

const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const polyline = (pts, p) => {
  const e = {};
  pts.forEach((q, i) => { e[`${p}${i}`] = { type: "point", x: q[0], y: q[1] }; if (i) e[`${p}l${i}`] = { type: "line", a: `${p}${i - 1}`, b: `${p}${i}` }; });
  return e;
};
const top = { kind: "plane", plane: "top" }, front = { kind: "plane", plane: "front" };
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const feature = (id, type, params) => ({ id, type, name: id, suppressed: false, params });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r };
}
const state = (engine) => engine.entries[engine.entries.length - 1].state;
const bodies = (engine) => state(engine).bodies;
async function service(k, engine, name, args) {
  const def = K.SERVICES.find((s) => s.name === name);
  return def.run({ oc: k.oc, k, state: state(engine), fail: (m) => new K.FeatureError(m) }, args);
}
const smDefaults = (o) => ({ ...K.FEATURES.find((f) => f.type === "sm-model").defaults(), ...o });
/** A 100 × 60 plate, 1 mm thick, bend radius 1. */
const plate = () => [sketch("s1", rect(0, 0, 100, 60, "p")), feature("sm", "sm-model", smDefaults({ profile: { sketch: "s1", regions: null } }))];

test("sheet metal model: thicken a sketch region", async () => {
  const { k, engine, r } = await run(plate());
  allOk(r);
  assert.equal(bodies(engine).length, 1);
  near(k.volume(bodies(engine)[0].shape), 6000);
  const flat = await service(k, engine, "sm-flat-pattern", {});
  assert.equal(flat.models.length, 1);
  near(flat.models[0].pieces[0].area, 6000);
});

test("sheet metal model: extrude sketch lines into walls joined by bends", async () => {
  const { k, engine, r } = await run([
    sketch("s1", polyline([[0, 0], [50, 0], [50, 30]], "u"), top),
    feature("sm", "sm-model", smDefaults({ method: "extrude", lines: [{ kind: "sketch", feature: "s1", entity: "ul1" }], depth: 20, thickness: 2, radius: 2 })),
  ]);
  allOk(r);
  assert.equal(bodies(engine).length, 1);
  assert.equal(k.solids(bodies(engine)[0].shape).length, 1);
  const flat = await service(k, engine, "sm-flat-pattern", {});
  const piece = flat.models[0].pieces[0];
  assert.equal(piece.bends.length, 1);
  near(piece.bends[0].angle, 90, 1e-6);
});

test("sheet metal model: convert a box with its top excluded into a tray", async () => {
  const { k, engine, r } = await run([
    sketch("s1", rect(0, 0, 60, 40, "b")), extrude("e1", "s1", { depth: 20 }),
    feature("sm", "sm-model", smDefaults({ method: "convert", parts: ["e1"], exclude: [{ kind: "face", body: "e1", name: "e1:end:ba" }], thickness: 1, radius: 1 })),
  ]);
  allOk(r);
  assert.equal(bodies(engine).length, 1);
  const flat = await service(k, engine, "sm-flat-pattern", {});
  assert.equal(flat.models[0].pieces.length, 1);
  assert.equal(flat.models[0].pieces[0].bends.length, 4);
});

/** The names of a body's faces that start with a prefix. */
const facesOf = (engine, prefix) => bodies(engine)[0].topo.faces.map((f) => f.name).filter((n) => n.startsWith(prefix));
/** An edge of the plate's top face along its side face at y = 0 (the 100 mm edge): picked as its side face. */
const sideFace = (engine, angle) => ({ kind: "face", body: bodies(engine)[0].id, name: facesOf(engine, "sm:").find((n) => n.includes(`:side@${angle}:`)) });

test("flange: a 90° wall on an edge, its bend in the flat pattern with the right allowance", async () => {
  let { engine } = await run(plate());
  const edge = sideFace(engine, -90);
  assert.ok(edge.name, facesOf(engine, "sm:").join(" "));
  const res = await run([...plate(), feature("fl", "sm-flange", { ...K.FEATURES.find((f) => f.type === "sm-flange").defaults(), edges: [edge], length: 20 })]);
  allOk(res.r);
  const k = res.k; engine = res.engine;
  assert.equal(k.solids(bodies(engine)[0].shape).length, 1);
  const bb = res.r.bodies[0].mesh.bbox;
  near(bb[5] - bb[2], 20, 1e-3);   // 20 to the outside corner
  const flat = await service(k, engine, "sm-flat-pattern", { dxf: true });
  const piece = flat.models[0].pieces[0];
  assert.equal(piece.bends.length, 1);
  const ba = (Math.PI / 2) * (1 + 0.45 * 1);
  near(piece.bends[0].allowance, ba, 1e-6);
  // outer setback 2 off the plate, flange flat 18: developed = 60 - 2 + ba + 18
  near(piece.bbox[3] - piece.bbox[1], 60 - 2 + ba + 18, 1e-3);
  assert.match(piece.dxf, /BEND_UP|BEND_DOWN/);
  assert.match(piece.dxf, /EOF\n$/);
});

test("flange on all four edges: the corners are relieved and nothing overlaps", async () => {
  let { engine } = await run(plate());
  const edges = [-90, 0, 90, 180].map((a) => sideFace(engine, a));
  const res = await run([...plate(), feature("fl", "sm-flange", { ...K.FEATURES.find((f) => f.type === "sm-flange").defaults(), edges, length: 15 })]);
  allOk(res.r);
  engine = res.engine;
  const k = res.k, body = bodies(engine)[0];
  assert.equal(k.solids(body.shape).length, 1);
  const flat = await service(k, engine, "sm-flat-pattern", {});
  assert.equal(flat.models[0].pieces[0].bends.length, 4);
  // the solid's volume equals the flat pattern's area times the thickness, less nothing (no overlap): within the bends' K-factor difference
  const v = k.volume(body.shape), a = flat.models[0].pieces[0].area;
  assert.ok(Math.abs(v - a) / a < 0.02, `${v} vs ${a}`);
});

test("hem, tab, bend, rip, form, corner break, finish", async () => {
  let { engine } = await run(plate());
  const e0 = sideFace(engine, -90), e1 = sideFace(engine, 90);
  const d = (t) => K.FEATURES.find((f) => f.type === t).defaults();
  const feats = [
    ...plate(),
    feature("hem", "sm-hem", { ...d("sm-hem"), edges: [e0] }),
    sketch("tabs", rect(30, 60, 50, 70, "t"), top),
    feature("tab", "sm-tab", { profile: { sketch: "tabs", regions: null } }),
    sketch("bl", polyline([[70, -5], [70, 80]], "b"), top),
    feature("bend", "sm-bend", { ...d("sm-bend"), line: [{ kind: "sketch", feature: "bl", entity: "bl1" }], angle: 45 }),
    sketch("fp", { q: { type: "point", x: 20, y: 30 } }, top),
    feature("form", "sm-form", { ...d("sm-form"), points: [{ kind: "sketch", feature: "fp", entity: "q" }] }),
    sketch("rl", polyline([[40, -5], [40, 80]], "r"), top),
    feature("rip", "sm-rip", { ...d("sm-rip"), lines: [{ kind: "sketch", feature: "rl", entity: "rl1" }] }),
    feature("fin", "sm-finish", { models: [] }),
  ];
  const res = await run(feats);
  allOk(res.r);
  engine = res.engine;
  const flat = await service(res.k, engine, "sm-flat-pattern", {});
  const m = flat.models[0];
  assert.equal(m.finished, true);
  assert.equal(m.pieces.length, 2);   // the rip cut the plate in two
  assert.equal(m.pieces.reduce((n, p) => n + p.bends.length, 0), 2);   // the hem and the bend
  assert.equal(m.pieces.reduce((n, p) => n + p.forms.length, 0), 1);
  assert.equal(bodies(engine).length, 2);
});

test("modify joint, make joint, corner, bend relief", async () => {
  let { engine } = await run(plate());
  const d = (t) => K.FEATURES.find((f) => f.type === t).defaults();
  const e0 = sideFace(engine, -90), e1 = sideFace(engine, 0);
  const base = [...plate(), feature("fl", "sm-flange", { ...d("sm-flange"), edges: [e0, e1], length: 15 })];
  let res = await run(base);
  allOk(res.r);
  const bendFace = (eng) => ({ kind: "face", body: bodies(eng)[0].id, name: facesOf(eng, "sm:fl.").find((n) => n.endsWith(":in")) });
  const flatOf = async (r) => (await service(r.k, r.engine, "sm-flat-pattern", {})).models[0].pieces;
  // a rip in place of one bend: two pieces in the flat pattern
  const bf = bendFace(res.engine);
  res = await run([...base, feature("mj", "sm-modify-joint", { ...d("sm-modify-joint"), bends: [bf], jointType: "rip" })]);
  allOk(res.r);
  assert.equal((await flatOf(res)).length, 2);
  // a larger radius instead
  res = await run([...base, feature("mj", "sm-modify-joint", { ...d("sm-modify-joint"), bends: [bf], jointType: "bend", useModelRadius: false, radius: 4 })]);
  allOk(res.r);
  assert.ok((await flatOf(res))[0].bends.some((b) => Math.abs(b.radius - 4) < 1e-9));
  // the corner where the two flanges meet, closed
  const v = bodies(res.engine)[0].topo.vertices;
  const corner = v.map((x) => ({ x, p: res.k.vertexPoint(x.shape) })).filter((o) => Math.abs(o.p[2]) < 1e-6).sort((a, b) => (a.p[0] - 100) ** 2 + a.p[1] ** 2 - ((b.p[0] - 100) ** 2 + b.p[1] ** 2))[0];
  res = await run([...base, feature("co", "sm-corner", { ...d("sm-corner"), corners: [{ kind: "vertex", body: "sm", name: corner.x.name }], cornerType: "round" })]);
  allOk(res.r);
  // make joint: two walls of an extruded L, ripped, then joined again
  res = await run([
    sketch("s1", polyline([[0, 0], [50, 0], [50, 30]], "u"), top),
    feature("sm", "sm-model", smDefaults({ method: "extrude", lines: [{ kind: "sketch", feature: "s1", entity: "ul1" }], depth: 20 })),
  ]);
  const rip = { kind: "face", body: bodies(res.engine)[0].id, name: facesOf(res.engine, "sm:").find((n) => n.endsWith(":in")) };
  assert.ok(rip.name);
  res = await run([
    sketch("s1", polyline([[0, 0], [50, 0], [50, 30]], "u"), top),
    feature("sm", "sm-model", smDefaults({ method: "extrude", lines: [{ kind: "sketch", feature: "s1", entity: "ul1" }], depth: 20 })),
    feature("mj", "sm-modify-joint", { ...d("sm-modify-joint"), bends: [rip], jointType: "rip", close: false }),
  ]);
  allOk(res.r);
  assert.equal((await flatOf(res)).length, 2);
});

test("make joint: two walls thickened apart, joined by a bend into one part", async () => {
    let res = await run([
    sketch("s1", polyline([[0, 0], [50, 0], [50, 30]], "u"), top),
    feature("sm", "sm-model", smDefaults({ method: "extrude", lines: [{ kind: "sketch", feature: "s1", entity: "ul1" }], depth: 20 })),
  ]);
  const d = (t) => K.FEATURES.find((f) => f.type === t).defaults();
  const bend = { kind: "face", body: bodies(res.engine)[0].id, name: facesOf(res.engine, "sm:").find((n) => n.endsWith(":in")) };
  const ripped = [
    sketch("s1", polyline([[0, 0], [50, 0], [50, 30]], "u"), top),
    feature("sm", "sm-model", smDefaults({ method: "extrude", lines: [{ kind: "sketch", feature: "s1", entity: "ul1" }], depth: 20, gap: 0 })),
    feature("mj", "sm-modify-joint", { ...d("sm-modify-joint"), bends: [bend], jointType: "rip", close: true }),
  ];
  res = await run(ripped);
  allOk(res.r);
  assert.equal(bodies(res.engine).length, 2);
  const all = bodies(res.engine).flatMap((b) => b.topo.faces.map((f) => ({ body: b.id, name: f.name })));
  const end = all.find((f) => /:sm\.w1:side@0:/.test(f.name));
  assert.ok(end, all.map((f) => f.name).join(" "));
  res = await run([...ripped, feature("jn", "sm-joint", { ...d("sm-joint"), edges: [{ kind: "face", ...end }] })]);
  allOk(res.r);
  assert.equal(bodies(res.engine).length, 1);
});

test("bend relief and corner break on a flange kept back from the edge's ends", async () => {
  let { engine } = await run(plate());
  const d = (t) => K.FEATURES.find((f) => f.type === t).defaults();
  const base = [...plate(), feature("fl", "sm-flange", { ...d("sm-flange"), edges: [sideFace(engine, -90)], offset: true, start: 10, end: 10 })];
  let res = await run(base);
  allOk(res.r);
  const v0 = res.k.volume(bodies(res.engine)[0].shape);
  const vx = bodies(res.engine)[0].topo.vertices.map((x) => ({ x, p: res.k.vertexPoint(x.shape) })).filter((o) => Math.abs(o.p[2] - 1) < 1e-6);
  const nearest = (q) => vx.slice().sort((a, b) => Math.hypot(a.p[0] - q[0], a.p[1] - q[1]) - Math.hypot(b.p[0] - q[0], b.p[1] - q[1]))[0].x.name;
  res = await run([...base, feature("br", "sm-bend-relief", { ...d("sm-bend-relief"), ends: [{ kind: "vertex", body: "sm", name: nearest([10, 3]) }], reliefType: "rectangle", width: 3, depth: 4 })]);
  allOk(res.r);
  assert.ok(res.k.volume(bodies(res.engine)[0].shape) < v0 - 1e-3);
  res = await run([...base, feature("cb", "sm-corner-break", { ...d("sm-corner-break"), corners: [{ kind: "vertex", body: "sm", name: nearest([100, 60]) }], size: 5 })]);
  allOk(res.r);
  near(res.k.volume(bodies(res.engine)[0].shape), v0 - (25 - Math.PI * 25 / 4), 1e-6);
});
