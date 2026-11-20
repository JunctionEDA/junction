// Node test for the hardware custom features of the part studio (web/domains/mechanical/features/cf-hw-*.ts,
// kernel/ops/cf-hw*.ts): threads and fasteners, enclosures and hardware.  The real OpenCascade build runs here.
// Each feature is built with its defaults and in one other case, and measured.
// Run: node server/static/tests/cad-cf-hw.test.js
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
const circle = (id, x, y, r) => ({ [`${id}c`]: { type: "point", x, y }, [id]: { type: "circle", center: `${id}c`, r } });
const point = (id, x, y) => ({ [id]: { type: "point", x, y } });
const topPlane = { kind: "plane", plane: "top" };
const sketch = (id, entities, plane = topPlane) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
/** A feature with its defaults, and what is given over them. */
const feature = (id, type, params = {}) => {
  const def = K.FEATURES.find((f) => f.type === type);
  assert.ok(def, `no feature type ${type}`);
  return { id, type, name: id, suppressed: false, params: { ...def.defaults(), ...params } };
};
const face = (body, name) => ({ kind: "face", body, name });
const onFace = (body, name) => ({ kind: "face", ref: face(body, name) });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const between = (v, lo, hi) => assert.ok(v > lo && v < hi, `${v} is not between ${lo} and ${hi}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  const bodies = engine.entries[engine.entries.length - 1].state.bodies;
  const vol = (i = 0) => k.volume(bodies[i].shape);
  return { k, engine, r, bodies, vol };
}
const valid = (k, shape) => { const a = new k.oc.BRepCheck_Analyzer(shape, true, false); try { return a.IsValid(); } finally { a.delete(); } };
const allValid = (res) => { for (const b of res.bodies) assert.ok(valid(res.k, b.shape), `${b.id} is not a valid solid`); };
const box = (k, shape) => { const b = new k.oc.Bnd_Box(); k.oc.BRepBndLib.Add(shape, b, false); const o = [b.GetXMin(), b.GetYMin(), b.GetZMin(), b.GetXMax(), b.GetYMax(), b.GetZMax()]; b.delete(); return o; };
const names = (body, prefix) => body.topo.faces.map((f) => f.name).filter((n) => n.startsWith(prefix));
const message = (res, id) => (res.r.features.find((f) => f.id === id) || {}).message || "";
/**
 * How many separate pieces of a solid a thin bar meets: the bar runs along z from z0 to z1 at x = `r` (and `y`).
 * Along a thread, at a radius between its minor and major diameter, that is its number of turns.
 */
function pieces(k, shape, r, z0, z1, y = 0) {
  const oc = k.oc;
  const at = new oc.gp_Pnt(r - 0.005, y - 0.005, z0);
  const bar = new oc.BRepPrimAPI_MakeBox(at, 0.01, 0.01, z1 - z0).Shape();
  const range = new oc.Message_ProgressRange();
  const common = new oc.BRepAlgoAPI_Common(shape, bar, range);
  common.Build();
  const n = k.withScope(() => k.sub(common.Shape(), "solid").length);
  common.delete(); range.delete(); at.delete();
  return n;
}

const shaft = (r, h, id = "e1") => [sketch("s1", circle("c", 0, 0, r)), extrude(id, "s1", { depth: h })];
const plate = (h = 10, w = 40) => [sketch("s0", rect(-w, -w * 0.75, w, w * 0.75, "p")), extrude("e0", "s0", { depth: h })];
const top = onFace("e0", "e0:end:pa"), bottom = onFace("e0", "e0:start:pa");
/** The volume of one millimetre of rod threaded with the 60° basic profile: flats of P/4 at the minor and P/8 at the major diameter. */
const threadedArea = (major, pitch) => { const r1 = major / 2, r0 = r1 - 0.541266 * pitch; return Math.PI * (0.25 * r0 * r0 + 0.125 * r1 * r1 + 0.625 * (r0 * r0 + r0 * r1 + r1 * r1) / 3); };

// ------------------------------------------------------------------ the tables

test("tables: thread sizes, O-rings, glands", () => {
  const H = K.FEATURES.find((f) => f.type === "cf-hw-thread");
  const sizes = H.schema.find((f) => f.key === "size_iso").options.map((o) => o.value);
  assert.ok(sizes.includes("M8×1.25") && sizes.includes("M3×0.5") && sizes[0] === "auto");
  assert.ok(K.FEATURES.find((f) => f.type === "cf-hw-thread").schema.find((f) => f.key === "size_unc").options.some((o) => o.value === "1/4-20 UNC"));
  assert.ok(K.FEATURES.find((f) => f.type === "cf-hw-pipe-thread").schema.find((f) => f.key === "size_npt").options.some((o) => o.value === "1/2 NPT"));
});

test("every hardware feature is in the Custom features section, with an icon, a hint and search words", () => {
  const mine = K.FEATURES.filter((f) => f.type.startsWith("cf-hw-"));
  assert.equal(mine.length, 26);
  for (const f of mine) {
    assert.equal(f.toolbarSection, "library", f.type);
    assert.ok(["Threads & fasteners", "Enclosures & hardware"].includes(f.toolbarMenu), f.type);
    assert.equal(f.toolbarKeep, 0, f.type);
    assert.ok(f.icon && f.hint && f.keywords, f.type);
    assert.doesNotThrow(() => JSON.stringify(f.defaults()), f.type);
  }
  assert.equal(new Set(mine.map((f) => f.icon)).size, mine.length, "two features share an icon");
});

// ------------------------------------------------------------------ threads

test("thread: M8 on a Ø8 shaft has the ISO profile's section and 1.25 mm turns", async () => {
  const res = await run([...shaft(4, 16), feature("t", "cf-hw-thread", { face: face("e1", "e1:side:c"), leadIn: false, runout: false })]);
  allOk(res.r); allValid(res);
  near(res.vol(), threadedArea(8, 1.25) * 16, 2e-4);
  // a bar at the pitch radius crosses a ridge every pitch: 16 / 1.25 = 12.8
  between(pieces(res.k, res.bodies[0].shape, 3.66, 0, 16), 11.5, 14.5);
  // nothing outside the major diameter, the core left whole
  assert.equal(pieces(res.k, res.bodies[0].shape, 4.01, 0, 16), 0);
  assert.equal(pieces(res.k, res.bodies[0].shape, 3.3, 0, 16), 1);
  assert.ok(names(res.bodies[0], "t:crest").length && names(res.bodies[0], "t:flank").length && names(res.bodies[0], "t:root").length);
  assert.ok(res.bodies[0].topo.faces.some((f) => f.name === "e1:start:c") && res.bodies[0].topo.faces.some((f) => f.name === "e1:end:c"), "the shaft's ends keep their names");
});

test("thread: part length with a chamfered start and a run-out; fine pitch, two starts, left-handed; sizes that do not fit", async () => {
  const side = face("e1", "e1:side:c");
  let res = await run([...shaft(4, 16), feature("t", "cf-hw-thread", { face: side, full: false, length: 8 })]);
  allOk(res.r); allValid(res);
  // the unthreaded half is whole, the threaded half lost less than a full thread's worth
  between(res.vol(), Math.PI * 16 * 8 + threadedArea(8, 1.25) * 8, Math.PI * 16 * 16);
  assert.equal(pieces(res.k, res.bodies[0].shape, 3.9, 0, 7.5), 1, "the lower half is not threaded");
  between(pieces(res.k, res.bodies[0].shape, 3.66, 8.5, 15.5), 4.5, 7.5);
  res = await run([...shaft(4, 16), feature("t", "cf-hw-thread", { face: side, standard: "isoFine", left: true, starts: 2 })]);
  allOk(res.r); allValid(res);
  between(pieces(res.k, res.bodies[0].shape, 3.75, 2, 14), 10.5, 13.5);   // M8×1: twelve ridges in 12 mm, whatever the lead
  res = await run([...shaft(4, 16), feature("t", "cf-hw-thread", { face: side, size_iso: "M12×1.75" })]);
  assert.match(message(res, "t"), /does not fit the cylinder/);
  res = await run([...shaft(4, 16), feature("t", "cf-hw-thread-internal", { face: side })]);
  assert.match(message(res, "t"), /shaft, not a hole/);
});

test("internal thread: M8 tapped in a 6.8 mm hole, through and blind", async () => {
  const drilled = [sketch("s0", { ...rect(-10, -10, 10, 10, "p"), ...circle("h", 0, 0, 3.4) }), extrude("e0", "s0", { depth: 10 })];
  let res = await run([...drilled, feature("t", "cf-hw-thread-internal", { face: face("e0", "e0:side:h") })]);
  allOk(res.r); allValid(res);
  // between a plate with a hole of the major and of the minor diameter
  between(res.vol(), 4000 - Math.PI * 16 * 10, 4000 - Math.PI * 3.3234 ** 2 * 10);
  between(pieces(res.k, res.bodies[0].shape, 3.66, 1, 9), 5.5, 7.5);   // 8 mm of 1.25 mm pitch
  assert.equal(pieces(res.k, res.bodies[0].shape, 4.05, 0, 10), 1, "the plate is whole outside the major diameter");
  const blind = [sketch("s0", rect(-10, -10, 10, 10, "p")), extrude("e0", "s0", { depth: 12 }), sketch("s1", circle("h", 0, 0, 2.5), onFace("e0", "e0:end:pa")), extrude("e1", "s1", { depth: 8, operation: "remove", flip: true })];
  res = await run([...blind, feature("t", "cf-hw-thread-internal", { face: face("e0", "e1:side:h") })]);
  allOk(res.r); allValid(res);
  between(res.vol(), 4800 - Math.PI * 9 * 8, 4800 - Math.PI * 6.25 * 8);
  assert.equal(pieces(res.k, res.bodies[0].shape, 2.4, 0, 3.9), 1, "the floor under the hole is untouched");
});

test("pipe thread: 1/2 NPT on a pipe grows 1 in 16 and vanishes into the pipe; BSPT; in a hole", async () => {
  const pipe = [sketch("s1", { ...circle("c", 0, 0, 10.668), ...circle("b", 0, 0, 7.9) }), extrude("e1", "s1", { depth: 30 })];
  let res = await run([...pipe, feature("t", "cf-hw-pipe-thread", { face: face("e1", "e1:side:c") })]);
  allOk(res.r); allValid(res);
  // at the end (z = 30) the crests are at 0.75843" + 0.8 P; further down they are wider
  const tip = (0.75843 * 25.4 + 0.8 * 25.4 / 14) / 2;
  assert.equal(pieces(res.k, res.bodies[0].shape, tip + 0.15, 28.2, 29.9), 0, "nothing outside the thread at its small end");
  assert.ok(pieces(res.k, res.bodies[0].shape, tip + 0.15, 20, 26) >= 2, "the thread is wider further from the end");
  assert.equal(pieces(res.k, res.bodies[0].shape, 10.6, 0, 12), 1, "the pipe is plain beyond the thread");
  between(pieces(res.k, res.bodies[0].shape, tip - 0.5, 20, 29), 4, 6.5);   // 14 turns an inch
  res = await run([...pipe, feature("t", "cf-hw-pipe-thread", { face: face("e1", "e1:side:c"), standard: "bspt" })]);
  allOk(res.r); allValid(res);
  const block = [sketch("s0", { ...rect(-15, -15, 15, 15, "p"), ...circle("h", 0, 0, 9) }), extrude("e0", "s0", { depth: 20 })];
  res = await run([...block, feature("t", "cf-hw-pipe-thread", { face: face("e0", "e0:side:h") })]);
  allOk(res.r); allValid(res);
  between(res.vol(), 900 * 20 - Math.PI * 11 ** 2 * 20, 900 * 20 - Math.PI * 81 * 20);
});

test("cosmetic thread: a helix curve on the face, the body untouched", async () => {
  const res = await run([...shaft(4, 16), feature("t", "cf-hw-thread-cosmetic", { face: face("e1", "e1:side:c"), full: false, length: 8 })]);
  allOk(res.r);
  near(res.vol(), Math.PI * 16 * 16, 1e-9);
  const curve = res.r.datums.find((d) => d.featureId === "t");
  assert.equal(curve.kind, "curve");
  const zs = []; for (let i = 2; i < curve.points.length; i += 3) if (!Number.isNaN(curve.points[i])) zs.push(curve.points[i]);
  near(Math.max(...zs), 16, 1e-6); near(Math.min(...zs), 8, 1e-6);   // from the top end, 8 mm down
  const hole = [sketch("s0", { ...rect(-10, -10, 10, 10, "p"), ...circle("h", 0, 0, 2.5) }), extrude("e0", "s0", { depth: 10 })];
  allOk((await run([...hole, feature("t", "cf-hw-thread-cosmetic", { face: face("e0", "e0:side:h") })])).r);   // M6 by its tap drill
});

// ------------------------------------------------------------------ fasteners

test("bolt: the four heads by the table; a modelled thread", async () => {
  for (const [head, size, zTop, across] of [["socket", 10, 6, 10], ["hex", 11.547, 4, 11.547], ["button", 10.5, 3.3, 10.5], ["flat", 12, 0, 12]]) {
    const res = await run([feature("b", "cf-hw-bolt", { head })]);
    allOk(res.r); allValid(res);
    const b = box(res.k, res.bodies[0].shape);
    near(b[5], zTop, 1e-3); near(b[2], -20, 1e-3); near(b[3] - b[0], across, 2e-3);
    void size;
  }
  const plain = await run([feature("b", "cf-hw-bolt", { head: "hex", size: "M8", length: 30 })]);
  const res = await run([feature("b", "cf-hw-bolt", { head: "hex", size: "M8", length: 30, thread: "modelled", threaded: 12 })]);
  allOk(res.r); allValid(res);
  assert.ok(res.vol() < plain.vol() && res.vol() > plain.vol() - (Math.PI * 16 - threadedArea(8, 1.25)) * 12 - 3);
  between(pieces(res.k, res.bodies[0].shape, 3.66, -29, -19.5), 6.5, 8.5);   // 9.5 mm of 1.25 pitch
  assert.equal(pieces(res.k, res.bodies[0].shape, 3.9, -17, -0.5), 1, "the shank above the thread is plain");
  assert.ok(names(res.bodies[0], "b:thread:crest").length && names(res.bodies[0], "b:head:flat").length === 6);
});

test("nut, washer and standoff by the table", async () => {
  let res = await run([feature("n", "cf-hw-nut", {})]);   // M6: 10 across flats, 5.2 high
  allOk(res.r); allValid(res);
  let b = box(res.k, res.bodies[0].shape);
  near(b[5], 5.2, 1e-6); near(b[4] - b[1], 10 / Math.cos(Math.PI / 6), 1e-3);
  between(res.vol(), 0.95 * (0.866025 * 100 - Math.PI * 2.4587 ** 2) * 5.2, (0.866025 * 100 - Math.PI * 2.4587 ** 2) * 5.2);
  for (const kind of ["nyloc", "square", "wing"]) { res = await run([feature("n", "cf-hw-nut", { kind })]); allOk(res.r); allValid(res); }
  res = await run([feature("n", "cf-hw-nut", { thread: "modelled", size: "M8" })]);
  allOk(res.r); allValid(res);
  between(pieces(res.k, res.bodies[0].shape, 3.66, 0.4, 6.4), 3.5, 5.5);

  res = await run([feature("w", "cf-hw-washer", {})]);   // M6 plain: 6.4 × 12 × 1.6
  allOk(res.r);
  near(res.vol(), Math.PI * (36 - 10.24) * 1.6, 1e-6);
  res = await run([feature("w", "cf-hw-washer", { kind: "spring", size: "M8" })]);
  allOk(res.r); allValid(res);
  between(res.vol(), 0.9 * Math.PI * (7.4 ** 2 - 4.05 ** 2) * 2, Math.PI * (7.4 ** 2 - 4.05 ** 2) * 2);
  res = await run([feature("w", "cf-hw-washer", { kind: "custom", inner: 10, outer: 8 })]);
  assert.match(message(res, "w"), /wider than its hole/);

  res = await run([feature("s", "cf-hw-standoff", {})]);   // M3 hex, 10 long, tapped through
  allOk(res.r); allValid(res);
  b = box(res.k, res.bodies[0].shape);
  near(b[5] - b[2], 10, 1e-6);
  between(res.vol(), 0.97 * (0.866025 * 5.5 ** 2 - Math.PI * 1.2294 ** 2) * 10, (0.866025 * 5.5 ** 2 - Math.PI * 1.2294 ** 2) * 10);
  res = await run([feature("s", "cf-hw-standoff", { ends: "mf", body: "round", thread: "modelled", length: 12 })]);
  allOk(res.r); allValid(res);
  near(box(res.k, res.bodies[0].shape)[2], -6, 1e-6);   // the stud goes into the surface
  assert.ok(names(res.bodies[0], "s:stud:thread:crest").length && names(res.bodies[0], "s:thread1:crest").length);
});

test("fastener holes: a counterbore, a clearance hole and a tap drill hole through a stack of three parts", async () => {
  const stack = [sketch("s0", rect(-20, -15, 20, 15, "p")), extrude("a", "s0", { depth: 12 }),
    sketch("s1", rect(-20, -15, 20, 15, "q"), onFace("a", "a:end:pa")), extrude("b", "s1", { depth: 4 }),
    sketch("s2", rect(-20, -15, 20, 15, "r"), onFace("b", "b:end:qa")), extrude("c", "s2", { depth: 6 }),
    sketch("sp", { ...point("p1", -10, 0), ...point("p2", 10, 0) }, onFace("c", "c:end:ra"))];
  const at = [{ kind: "sketch", feature: "sp", entity: "p1" }, { kind: "sketch", feature: "sp", entity: "p2" }];
  let res = await run([...stack, feature("h", "cf-hw-fastener-holes", { at })]);   // M4 socket head, last part tapped
  allOk(res.r); allValid(res);
  near(res.vol(2), 7200 - 2 * (Math.PI * 16 * 4.4 + Math.PI * 2.25 ** 2 * 1.6), 1e-6);          // top: counterbore 8 × 4.4, clearance 4.5
  near(res.vol(1), 4800 - 2 * Math.PI * 2.25 ** 2 * 4, 1e-6);                                      // middle: clearance
  near(res.vol(0), 14400 - 2 * (Math.PI * 1.65 ** 2 * 8 + Math.PI * 1.65 ** 3 / Math.tan(59 * Math.PI / 180) / 3), 1e-6);   // bottom: 3.3 tap drill, 8 deep
  assert.ok(res.bodies[2].topo.faces.some((f) => f.name === "h:p1:c:cbore") && res.bodies[0].topo.faces.some((f) => f.name === "h:p2:a:floor"));
  res = await run([...stack, feature("h", "cf-hw-fastener-holes", { at, head: "flat", size: "M3", last: "insert" })]);
  allOk(res.r); allValid(res);
  assert.ok(res.bodies[2].topo.faces.some((f) => f.name === "h:p1:c:csink"));
  near(res.vol(0), 14400 - 2 * Math.PI * 4 * 5.5, 1e-6);   // an M3 insert's hole: 4 × 5.5
});

test("nut pocket: a hexagon recess with its bolt hole; a side trap", async () => {
  const base = [...plate(10, 20), sketch("sp", point("p1", 0, 0), top)];
  const at = [{ kind: "sketch", feature: "sp", entity: "p1" }];
  let res = await run([...base, feature("n", "cf-hw-nut-pocket", { at })]);   // M4: 7 + 0.2 across, 3.2 + 0.2 + 0.2 deep
  allOk(res.r); allValid(res);
  near(res.vol(), 12000 - 0.866025 * 7.2 ** 2 * 3.6 - Math.PI * 2.25 ** 2 * 6.4, 1e-4);
  res = await run([...base, feature("n", "cf-hw-nut-pocket", { at, style: "trap", nut: "square", reach: 25 })]);
  allOk(res.r); allValid(res);
  // a slot 7.2 wide and 2.4 high from 3.6 behind the axis out through the side at x = 20, and the bolt hole less the slot
  near(res.vol(), 12000 - 7.2 * 2.4 * 23.6 - Math.PI * 2.25 ** 2 * (10 - 2.4), 1e-4);
});

test("knurl: diamond and straight, on a plain cylinder and on a stepped one", async () => {
  const side = face("e1", "e1:side:c");
  let res = await run([...shaft(10, 10), feature("k", "cf-hw-knurl", { face: side })]);
  allOk(res.r); allValid(res);
  between(res.vol(), Math.PI * 9.5 ** 2 * 10 * 0.99, Math.PI * 100 * 10);
  const teeth = names(res.bodies[0], "k:tooth").length;
  assert.equal(teeth % 31, 0, "31 teeth round a Ø20 at 2 mm pitch");   // 2π·10 / 2 = 31.4
  assert.ok(teeth >= 4 * 31 * 4);
  const b = box(res.k, res.bodies[0].shape);
  assert.ok(b[3] <= 10 + 1e-6 && b[5] - b[2] < 10 + 1e-6, "a knurl never stands proud of its face");
  res = await run([...shaft(10, 10), feature("k", "cf-hw-knurl", { face: side, pattern: "straight", pitch: 3, depth: 0.8 })]);
  allOk(res.r); allValid(res);
  assert.equal(names(res.bodies[0], "k:tooth").length, 42);   // 21 ridges, two flanks each
  near(res.vol(), 21 * (9.2 * 10 * Math.sin(Math.PI / 21)) * 10, 1e-6);   // a 42-pointed star: 21 kites of 9.2 × 10
  const stepped = [sketch("s0", circle("a", 0, 0, 14)), extrude("e0", "s0", { depth: 4 }), sketch("s1", circle("c", 0, 0, 10), onFace("e0", "e0:end:a")), extrude("e1", "s1", { depth: 10, operation: "add" })];
  res = await run([...stepped, feature("k", "cf-hw-knurl", { face: face("e0", "e1:side:c") })]);
  allOk(res.r); allValid(res);
  res = await run([...shaft(10, 10), feature("k", "cf-hw-knurl", { face: side, depth: 6 })]);
  assert.match(message(res, "k"), /too deep/);
});

// ------------------------------------------------------------------ seals

test("O-ring groove: round a shaft, in a bore, in a flat face; the ring itself", async () => {
  const side = face("e1", "e1:side:c");
  // Ø30 shaft, 2.62 section, static: the gland is 2.08 deep less the 0.05 gap, and 3.6 wide
  let res = await run([...shaft(15, 30), feature("g", "cf-hw-oring-groove", { face: side })]);
  allOk(res.r); allValid(res);
  const depth = 2.08 - 0.05;
  between(Math.PI * 225 * 30 - res.vol(), 0.98 * Math.PI * (225 - (15 - depth) ** 2) * 3.6, Math.PI * (225 - (15 - depth) ** 2) * 3.6);
  assert.equal(pieces(res.k, res.bodies[0].shape, 15 - depth + 0.1, 0, 30), 2, "the groove is half way along");
  assert.equal(pieces(res.k, res.bodies[0].shape, 15 - depth - 0.1, 0, 30), 1);
  assert.deepEqual(names(res.bodies[0], "g:").sort(), ["g:corner", "g:corner~2", "g:floor", "g:side", "g:side~2"]);
  res = await run([...shaft(15, 30), feature("g", "cf-hw-oring-groove", { face: side, dash: "214", service: "dynamic", centred: false, offset: 6 })]);
  allOk(res.r); allValid(res);
  assert.equal(pieces(res.k, res.bodies[0].shape, 15 - 1, 20.5, 27.5), 2, "6 mm from the top end");
  res = await run([...shaft(15, 30), feature("g", "cf-hw-oring-groove", { face: face("e1", "e1:end:c"), diameter: 20 })]);   // a face seal about Ø20
  allOk(res.r); allValid(res);
  // the -115 ring (17.12 inside) is the nearest to Ø20 less a section: a groove 3.55 wide and 1.96 deep, its outside 1 % under the ring's
  between(Math.PI * 225 * 30 - res.vol(), 0.97 * Math.PI * (11.07 ** 2 - 7.52 ** 2) * 1.96, Math.PI * (11.07 ** 2 - 7.52 ** 2) * 1.96);
  const bore = [sketch("s0", { ...rect(-25, -25, 25, 25, "p"), ...circle("h", 0, 0, 12) }), extrude("e0", "s0", { depth: 20 })];
  res = await run([...bore, feature("g", "cf-hw-oring-groove", { face: face("e0", "e0:side:h") })]);
  allOk(res.r); allValid(res);
  assert.ok(res.vol() < 2500 * 20 - Math.PI * 144 * 20);
  res = await run([...shaft(15, 30), feature("g", "cf-hw-oring-groove", { face: side, dash: "999" })]);
  assert.match(message(res, "g"), /AS568 has no size -999/);

  res = await run([feature("o", "cf-hw-oring", {})]);   // -214: 0.984" inside, 0.139" section
  allOk(res.r);
  near(res.vol(), 2 * Math.PI ** 2 * ((0.984 + 0.139) * 25.4 / 2) * (0.139 * 25.4 / 2) ** 2, 1e-6);
  const free = await run([feature("o", "cf-hw-oring", { dash: "", inner: 10, section: 2 })]);
  res = await run([feature("o", "cf-hw-oring", { dash: "", inner: 10, section: 2, installed: 12 })]);
  allOk(res.r);
  near(res.vol(), free.vol(), 1e-6);   // stretched, it is the same rubber
  assert.equal(pieces(res.k, res.bodies[0].shape, 5.9, 0, 2), 0); assert.equal(pieces(res.k, res.bodies[0].shape, 6.1, 0, 2), 1);   // its inside is now Ø12
});

test("gasket: a face's outline with its holes; drawn back from the edge, the holes opened", async () => {
  const flange = [sketch("s0", { ...rect(-20, -15, 20, 15, "p"), ...circle("h", 0, 0, 6), ...circle("b1", -15, -10, 2), ...circle("b2", 15, 10, 2) }), extrude("e0", "s0", { depth: 5 })];
  let res = await run([...flange, feature("g", "cf-hw-gasket", { faces: [face("e0", "e0:end:pa")] })]);
  allOk(res.r); allValid(res);
  assert.equal(res.bodies[1].name, "Gasket");
  near(res.vol(1), 1200 - Math.PI * 36 - 2 * Math.PI * 4, 1e-9);
  near(box(res.k, res.bodies[1].shape)[2], 5, 1e-6); near(box(res.k, res.bodies[1].shape)[5], 6, 1e-6);   // it lies on the face
  res = await run([...flange, feature("g", "cf-hw-gasket", { faces: [face("e0", "e0:end:pa")], inset: 1, holes: 0.5, thickness: 2 })]);
  allOk(res.r); allValid(res);
  near(res.vol(1), 2 * (38 * 28 - Math.PI * 6.5 ** 2 - 2 * Math.PI * 2.5 ** 2), 1e-6);
  near(box(res.k, res.bodies[1].shape)[5], 7, 1e-6);
  assert.equal(names(res.bodies[1], "g:e0:end:pa:hole").length, 3);
});

// ------------------------------------------------------------------ enclosures

test("enclosure: a base and a lid that fit; a flat lid; no lip", async () => {
  let res = await run([feature("e", "cf-hw-enclosure", {})]);   // 100 × 60 × 40, lid 10, lip 2
  allOk(res.r); allValid(res);
  assert.deepEqual(res.bodies.map((b) => b.name), ["Base", "Lid"]);
  let b = box(res.k, res.bodies[0].shape), l = box(res.k, res.bodies[1].shape);
  near(b[3] - b[0], 100, 1e-6); near(b[4] - b[1], 60, 1e-6); near(b[5], 32, 1e-6);   // the lip stands 2 above the split
  near(l[2], 30, 1e-6); near(l[5], 40, 1e-6);
  // the two halves do not run into each other
  const range = new res.k.oc.Message_ProgressRange();
  const clash = new res.k.oc.BRepAlgoAPI_Common(res.bodies[0].shape, res.bodies[1].shape, range); clash.Build();
  assert.ok(res.k.volume(clash.Shape()) < 1e-6, "the base and the lid overlap");
  clash.delete(); range.delete();
  assert.ok(res.bodies[0].topo.faces.some((f) => f.name === "e:base:floor") && res.bodies[0].topo.faces.some((f) => f.name === "e:base:outer:front") && res.bodies[0].topo.faces.some((f) => f.name === "e:base:boss1:hole"));
  assert.ok(res.bodies[1].topo.faces.some((f) => f.name === "e:lid:ceiling") && res.bodies[1].topo.faces.some((f) => f.name === "e:lid:boss3:counterbore"));
  // a shell: far less than the solid box
  between(res.vol(0) + res.vol(1), 0.15 * 240000, 0.3 * 240000);
  res = await run([feature("e", "cf-hw-enclosure", { lidHeight: 2, bosses: false })]);
  allOk(res.r); allValid(res);
  l = box(res.k, res.bodies[1].shape);
  near(l[2], 36, 1e-6);   // the rim under a flat lid drops 2 into the base
  res = await run([feature("e", "cf-hw-enclosure", { lip: false, radius: 0, baseHole: "insert", bosses: false })]);
  allOk(res.r);
  near(res.vol(0), 100 * 60 * 30 - 96 * 56 * 28, 1e-6); near(res.vol(1), 100 * 60 * 10 - 96 * 56 * 8, 1e-6);
  res = await run([feature("e", "cf-hw-enclosure", { wall: 40 })]);
  assert.match(message(res, "e"), /walls are thicker/);
});

test("PCB mounts and feet", async () => {
  let res = await run([...plate(3), feature("m", "cf-hw-pcb-mounts", { plane: top })]);   // Raspberry Pi: M2.5, posts Ø6 × 5
  allOk(res.r); allValid(res);
  assert.equal(res.bodies.length, 1);
  near(res.vol(), 14400 + 4 * (Math.PI * 9 * 5 - Math.PI * 1.025 ** 2 * 4.4), 1e-6);
  assert.equal(pieces(res.k, res.bodies[0].shape, 29, 4, 7.9, 24.5), 0, "the screw hole is where the board's hole is");
  assert.equal(pieces(res.k, res.bodies[0].shape, 29 + 2, 4, 7.9, 24.5), 1);
  res = await run([feature("m", "cf-hw-pcb-mounts", { operation: "new", board: "uno", top: "pin" })]);
  allOk(res.r);
  assert.equal(res.bodies.length, 4);
  near(box(res.k, res.bodies[0].shape)[5], 7.5, 1e-6);   // 5 high and a 2.5 pin

  res = await run([...plate(3), feature("f", "cf-hw-feet", { plane: bottom })]);
  allOk(res.r); allValid(res);
  near(box(res.k, res.bodies[0].shape)[2], -3, 1e-6);   // under the plate
  between(res.vol() - 14400, 4 * Math.PI * 4 ** 2 * 3, 4 * Math.PI * 25 * 3);
  res = await run([...plate(3), feature("f", "cf-hw-feet", { plane: bottom, style: "recess" })]);
  allOk(res.r);
  near(res.vol(), 14400 - 4 * Math.PI * 5.2 ** 2 * 1, 1e-6);
});

test("lip and groove: a lip on one half, its groove a clearance larger in the other", async () => {
  const halves = [sketch("s0", rect(-30, -20, 30, 20, "p")), extrude("lo", "s0", { depth: 15 }), feature("sh", "shell", { faces: [face("lo", "lo:end:pa")], thickness: 3 }),
    sketch("s1", rect(-30, -20, 30, 20, "q"), onFace("lo", "lo:end:pa")), extrude("lid", "s1", { depth: 4 })];
  const before = await run(halves);
  const res = await run([...halves, feature("lg", "cf-hw-lip-groove", { face: face("lo", "lo:end:pa") })]);
  allOk(res.r); allValid(res);
  // a band 1 wide, 1 in from the edge of a 60 × 40 rim, 1.5 high; the groove 0.15 larger all round
  const band = (inner, outer, h) => ((60 - 2 * inner) * (40 - 2 * inner) - (60 - 2 * outer) * (40 - 2 * outer)) * h;
  near(res.vol(0) - before.vol(0), band(1, 2, 1.5), 1e-6);
  near(before.vol(1) - res.vol(1), band(0.85, 2.15, 1.65), 1e-6);
  near(box(res.k, res.bodies[0].shape)[5], 16.5, 1e-6);
  const alone = await run([...halves.slice(0, 3), feature("lg", "cf-hw-lip-groove", { face: face("lo", "lo:end:pa"), inset: 0.5, width: 1.5 })]);
  assert.equal(alone.r.features[3].status, "warning");   // nothing to groove
  assert.match(message(alone, "lg"), /no groove was cut/);
});

test("vents, cable gland hole, mount pattern", async () => {
  let res = await run([...plate(3), feature("v", "cf-hw-vents", { plane: top })]);   // six slots 30 × 2
  allOk(res.r); allValid(res);
  near(res.vol(), 14400 - 6 * (28 * 2 + Math.PI) * 3, 1e-6);
  res = await run([...plate(3), feature("v", "cf-hw-vents", { plane: top, tilt: 40, depth: 3 })]);
  allOk(res.r); allValid(res);
  near(res.vol(), 14400 - 6 * (28 * 2 + Math.PI) * 3, 1e-4);   // on a slant the same is removed
  res = await run([...plate(3), feature("v", "cf-hw-vents", { plane: top, style: "hex", columns: 8, rows: 6, width: 5, pitch: 6 })]);
  allOk(res.r); allValid(res);
  near(res.vol(), 14400 - 48 * 0.866025404 * 25 * 3, 1e-6);
  res = await run([...plate(3), feature("v", "cf-hw-vents", { plane: top, style: "holes", width: 6, pitch: 5 })]);
  assert.match(message(res, "v"), /overlap/);

  res = await run([...plate(3), feature("g", "cf-hw-cable-gland", { plane: top })]);   // PG9: 15.2 + 0.3
  allOk(res.r);
  near(res.vol(), 14400 - Math.PI * 7.75 ** 2 * 3, 1e-6);
  res = await run([...plate(2), feature("g", "cf-hw-cable-gland", { plane: top, kind: "grommet" })]);
  allOk(res.r); allValid(res);
  assert.equal(res.bodies[1].name, "Grommet");
  near(res.vol(0), 9600 - Math.PI * 25 * 2, 1e-6);
  res = await run([...plate(3), feature("g", "cf-hw-cable-gland", { plane: top, flat: true, size: "M20×1.5", seat: 1 })]);
  allOk(res.r); allValid(res);

  res = await run([...plate(5), feature("m", "cf-hw-mount-pattern", { plane: top })]);   // NEMA 17: 4 × M3 on 31, pilot 22 + 0.5
  allOk(res.r); allValid(res);
  near(res.vol(), 24000 - (4 * Math.PI * 1.7 ** 2 + Math.PI * 11.25 ** 2) * 5, 1e-6);
  assert.equal(pieces(res.k, res.bodies[0].shape, 15.5, 0, 5, 15.5), 0, "a screw hole at a corner of the 31 mm square");
  assert.equal(pieces(res.k, res.bodies[0].shape, 15.5, 0, 5, 0), 1);
  res = await run([...plate(5, 70), feature("m", "cf-hw-mount-pattern", { plane: top, standard: "VESA 100", depth: 3 })]);
  allOk(res.r);
  near(res.vol(), 140 * 105 * 5 - 4 * Math.PI * 2.25 ** 2 * 3, 1e-6);
  res = await run([...plate(5), feature("m", "cf-hw-mount-pattern", { plane: top, slots: 6 })]);
  allOk(res.r); allValid(res);
});

test("bearing pocket and magnet pocket", async () => {
  let res = await run([...plate(12), feature("b", "cf-hw-bearing-pocket", { plane: top })]);   // 608: 22 × 7, shoulder 1.75
  allOk(res.r); allValid(res);
  const R = 11.025, Rs = R - 1.75;
  near(57600 - res.vol(), Math.PI * R * R * 7 + Math.PI * Rs * Rs * 5 + Math.PI * 0.4 * 0.4 * (R + 0.4 / 3), 1e-5);   // bore, hole behind, chamfer
  assert.deepEqual(names(res.bodies[0], "b:").sort(), ["b:chamfer", "b:seat", "b:through", "b:wall"]);
  res = await run([...plate(12), feature("b", "cf-hw-bearing-pocket", { plane: top, bearing: "6001", behind: "relief", chamfer: 0 })]);
  allOk(res.r); allValid(res);
  assert.equal(pieces(res.k, res.bodies[0].shape, 0.5, 0, 12), 1, "a relief does not go through");
  res = await run([...plate(12), feature("b", "cf-hw-bearing-pocket", { plane: top, bearing: "custom", outer: 10, inner: 9, width: 3 })]);
  assert.match(message(res, "b"), /shoulder would cover the inner ring/);

  res = await run([...plate(), feature("m", "cf-hw-magnet-pocket", { plane: top })]);   // Ø6 × 3 disc, three ribs
  allOk(res.r); allValid(res);
  between(48000 - res.vol(), 0.97 * Math.PI * 3.1 ** 2 * 3.2, Math.PI * 3.1 ** 2 * 3.2);
  assert.equal(names(res.bodies[0], "m:rib").length, 3);
  // the ribs leave less room than the magnet needs: 0.15 less across
  assert.equal(pieces(res.k, res.bodies[0].shape, 3 - 0.05, 0, 10), 1, "a rib stands where the magnet's edge would be");
  res = await run([...plate(), feature("m", "cf-hw-magnet-pocket", { plane: top, shape: "block", ribs: 2, push: 2 })]);
  allOk(res.r); allValid(res);
  assert.equal(names(res.bodies[0], "m:rib").length, 4);
});

test("DIN rail clip, hinge and knob", async () => {
  let res = await run([feature("d", "cf-hw-din-clip", {})]);
  allOk(res.r); allValid(res);
  let b = box(res.k, res.bodies[0].shape);
  near(b[3] - b[0], 35 + 2 * 0.2 + 2 * 2, 1e-6); near(b[4] - b[1], 12, 1e-6); near(b[5], 3 + 1 + 0.2 + 2, 1e-6);
  // a 35 mm rail's lips (1 thick, lying on the plate) go in: the room under the hooks is 35.4 wide and 1.2 high
  assert.equal(pieces(res.k, res.bodies[0].shape, 17.6, 3.05, 4.15), 0);
  assert.equal(pieces(res.k, res.bodies[0].shape, 16, 4.3, 6.1), 1, "the fixed hook reaches over the lip");
  res = await run([feature("d", "cf-hw-din-clip", { holes: 2, width: 20, countersunk: false })]);
  allOk(res.r); allValid(res);

  res = await run([feature("h", "cf-hw-hinge", {})]);
  allOk(res.r); allValid(res);
  assert.deepEqual(res.bodies.map((x) => x.name), ["Leaf A", "Leaf B", "Pin"]);
  near(res.vol(2), Math.PI * 1.5 ** 2 * 40, 1e-9);
  const range = new res.k.oc.Message_ProgressRange();
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) { const c = new res.k.oc.BRepAlgoAPI_Common(res.bodies[i].shape, res.bodies[j].shape, range); c.Build(); assert.ok(res.k.volume(c.Shape()) < 1e-6, "the hinge's parts overlap"); c.delete(); }
  range.delete();
  b = box(res.k, res.bodies[1].shape);
  near(b[3], 18, 1e-6);   // flat open
  res = await run([feature("h", "cf-hw-hinge", { open: 90, knuckles: 3, pin: "none", holes: 0 })]);
  allOk(res.r); allValid(res);
  assert.equal(res.bodies.length, 2);
  near(box(res.k, res.bodies[1].shape)[5], 3.65 + 18, 1e-6);   // leaf B stands up

  res = await run([feature("k", "cf-hw-knob", {})]);
  allOk(res.r); allValid(res);
  b = box(res.k, res.bodies[0].shape);
  near(b[5], 18, 5e-3); between(b[3] - b[0], 30, 32.01);
  assert.equal(names(res.bodies[0], "k:grip").length, 10);   // five lobes, five scallops
  between(res.vol(), 0.6 * Math.PI * 256 * 12, Math.PI * 256 * 12 + Math.PI * 49 * 6);
  for (const o of [{ style: "knurled", bore: "nut" }, { style: "round", bore: "d", stemHeight: 0 }, { lobes: 3, bore: "head" }, { bore: "insert", screw: "M4" }]) {
    res = await run([feature("k", "cf-hw-knob", o)]);
    allOk(res.r); allValid(res);
  }
  res = await run([feature("k", "cf-hw-knob", { lobes: 12, grip: 0.1 })]);
  assert.match(message(res, "k"), /grip must be deeper/);
});

test("placement: at picked sketch points on a face, turned, and the names carry the point", async () => {
  const base = [...plate(5), sketch("sp", { ...point("p1", -20, 0), ...point("p2", 20, 10) }, top)];
  const at = [{ kind: "sketch", feature: "sp", entity: "p1" }, { kind: "sketch", feature: "sp", entity: "p2" }];
  const res = await run([...base, feature("b", "cf-hw-bolt", { at, size: "M4", length: 8 })]);
  allOk(res.r);
  assert.equal(res.bodies.length, 3);
  const b1 = box(res.k, res.bodies[1].shape), b2 = box(res.k, res.bodies[2].shape);
  near((b1[0] + b1[3]) / 2, -20, 1e-6); near((b2[1] + b2[4]) / 2, 10, 1e-6);
  near(b1[5], 9, 1e-6); near(b1[2], -3, 1e-6);   // the head on the plate's top (z = 5), the shank 8 into it
  assert.ok(res.bodies[1].topo.faces.some((f) => f.name === "b:p1:shank") && res.bodies[2].topo.faces.some((f) => f.name === "b:p2:shank"));
  // with no point, the middle of the picked face
  const mid = await run([...plate(5), feature("w", "cf-hw-washer", { plane: top })]);
  const w = box(mid.k, mid.bodies[1].shape);
  near(w[0] + w[3], 0, 1e-6); near(w[2], 5, 1e-6);
});
