// Node test for the solid, direct-editing and pattern features added for toolbar parity
// (web/domains/mechanical/features/{thicken,enclose,rib,wrap,variable-fillet,face-blend,modify-fillet,delete-face,
// move-face,replace-face,curve-pattern,composite-part,mate-connector}.ts, kernel/ops/{cells,thicken,wrap}.ts) and the
// curve features (fit-spline, projected-curve, bridging-curve, composite-curve, intersection-curve, trim-curve,
// isocline, routing-curve; kernel/ops/curves.ts).
// The real OpenCascade build runs here.
// Run: node server/static/tests/mechanical-solid-tools.test.js
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
const names = (e, id) => body(e, id).topo.faces.map((f) => f.name).sort();
const bboxOf = (r, i = 0) => r.bodies[i].mesh.bbox.map((v) => Math.round(v * 1e4) / 1e4);
const BLOCK = 40 * 20 * 10, HOLE = Math.PI * 16 * 10, BOSS = Math.PI * 16 * 5;

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r };
}

test("the new features are registered, each with an icon, a hint and a place on the toolbar", () => {
  const byType = new Map(K.FEATURES.map((f) => [f.type, f]));
  for (const t of ["thicken", "enclose", "rib", "wrap", "variable-fillet", "face-blend", "modify-fillet", "delete-face", "move-face", "replace-face", "curve-pattern", "composite-part", "mate-connector",
    "fit-spline", "projected-curve", "bridging-curve", "composite-curve", "intersection-curve", "trim-curve", "isocline", "routing-curve"]) {
    const f = byType.get(t);
    assert.ok(f, t);
    assert.ok(f.icon && f.hint && f.keywords && f.toolbarSection && f.toolbarOrder, `${t} lacks an icon, a hint, keywords or a place`);
    assert.doesNotMatch(f.icon, /\d\.\d*0\d|NaN|undefined/, `${t}: icon numbers`);
  }
  const menu = (m) => K.FEATURES.filter((f) => f.toolbarMenu === m).sort((a, b) => a.toolbarOrder - b.toolbarOrder).map((f) => f.type);
  assert.deepEqual(menu("Fillet"), ["fillet", "variable-fillet", "face-blend"]);
  assert.deepEqual(menu("Pattern"), ["linear-pattern", "circular-pattern", "curve-pattern"]);
  assert.deepEqual(menu("Curve"), ["fit-spline", "projected-curve", "bridging-curve", "composite-curve", "intersection-curve", "trim-curve", "isocline", "routing-curve"]);
});

// ---------------------------------------------------------------- thicken, enclose

test("thicken: a flat face becomes a slab, to one side, both sides, or symmetric", async () => {
  let x = await run([...block(), feature("t", "thicken", { faces: [face("e", TOP)], thickness: 3, thickness2: 0, midplane: false, operation: "new", targets: [] })]);
  allOk(x.r);
  assert.equal(x.r.bodies.length, 2);
  near(vol(x.k, x.engine, "t"), 40 * 20 * 3);
  assert.deepEqual(bboxOf(x.r, 1), [0, 0, 10, 40, 20, 13]);
  x = await run([...block(), feature("t", "thicken", { faces: [face("e", TOP)], thickness: 3, thickness2: 2, midplane: false, operation: "new", targets: [] })]);
  allOk(x.r); assert.deepEqual(bboxOf(x.r, 1), [0, 0, 8, 40, 20, 13]);
  x = await run([...block(), feature("t", "thicken", { faces: [face("e", TOP)], thickness: 4, thickness2: 0, midplane: true, operation: "add", targets: [] })]);
  allOk(x.r); assert.equal(x.r.bodies.length, 1); near(vol(x.k, x.engine), 40 * 20 * 12);
});

test("thicken: a cylindrical face becomes a tube wall, and joined faces one sheet", async () => {
  const cyl = [sketch("s", circle(0, 0, 10, "c")), extrude("e", "s", { depth: 20 })];
  let x = await run([...cyl, feature("t", "thicken", { faces: [face("e", "e:side:c")], thickness: 2, thickness2: 0, midplane: false, operation: "new", targets: [] })]);
  allOk(x.r);
  near(vol(x.k, x.engine, "t"), Math.PI * (144 - 100) * 20, 1e-4);
  x = await run([...cyl, feature("t", "thicken", { faces: [face("e", "e:side:c")], thickness: 0, thickness2: 3, midplane: false, operation: "new", targets: [] })]);
  allOk(x.r);
  near(vol(x.k, x.engine, "t"), Math.PI * (100 - 49) * 20, 1e-4);
  // two faces of the block that share an edge: an L of constant thickness outside it
  x = await run([...block(), feature("t", "thicken", { faces: [face("e", TOP), face("e", SIDE("b"))], thickness: 2, thickness2: 0, midplane: false, operation: "new", targets: [] })]);
  allOk(x.r);
  assert.equal(x.r.bodies.length, 2);
  assert.ok(vol(x.k, x.engine, "t") > 40 * 20 * 2 + 10 * 20 * 2 - 1e-6, "the L is at least its two slabs: " + vol(x.k, x.engine, "t") + " " + x.r.bodies.length);
  x = await run([...block(), feature("t", "thicken", { faces: [], thickness: 2, thickness2: 0, midplane: false, operation: "new", targets: [] })]);
  failed(x.r, "t", /Pick the faces/);
});

test("enclose: the space closed off by planes and faces becomes a solid", async () => {
  const planes = [
    feature("px", "plane", { method: "offset", ref: right, distance: 30, flip: false }),
    feature("py", "plane", { method: "offset", ref: front, distance: 20, flip: false }),
    feature("pz", "plane", { method: "offset", ref: top, distance: 10, flip: false }),
  ];
  let x = await run([...planes, feature("en", "enclose", { entities: [top, front, right, datum("px"), datum("py"), datum("pz")], operation: "new", targets: [] })]);
  allOk(x.r);
  assert.equal(x.r.bodies.length, 1);
  near(vol(x.k, x.engine), 30 * 20 * 10);
  assert.ok(names(x.engine).includes("en:on(top)") && names(x.engine).includes("en:on(pz)"), names(x.engine).join());
  // a box's faces close off the box itself
  x = await run([...block(), feature("en", "enclose", { entities: [TOP, BOTTOM, SIDE("a"), SIDE("b"), SIDE("c"), SIDE("d")].map((n) => face("e", n)), operation: "new", targets: [] })]);
  allOk(x.r);
  near(vol(x.k, x.engine, "en"), BLOCK);
  // open on one side: nothing is enclosed
  x = await run([...planes, feature("en", "enclose", { entities: [top, front, right, datum("px"), datum("py")], operation: "new", targets: [] })]);
  failed(x.r, "en", /do not close off a space/);
});

// ---------------------------------------------------------------- rib, wrap

/** An L bracket in the Front plane's view: a 40 × 20 base 4 thick with a wall 4 thick and 24 high along x = 0. */
const bracket = () => [
  sketch("s", rect(0, 0, 40, 20, "p")), extrude("e", "s", { depth: 4 }),
  sketch("sw", rect(0, 0, 4, 20, "w"), onFace("e", "e:end:pa")), extrude("wall", "sw", { operation: "add", depth: 20 }),
];

test("rib: a sketch line between two walls becomes a web joined to the part", async () => {
  // a line in a plane through the middle of the bracket (y = 10), from the wall's face down to the base
  const mid = feature("mid", "plane", { method: "offset", ref: front, distance: 10, flip: true });
  const probe = await run([...bracket(), mid, sketch("sr", line(1, 1, 2, 2, "l"), datum("mid"))]);
  allOk(probe.r);
  const f = probe.r.sketches.find((s) => s.featureId === "sr").frame;
  // sketch coordinates of a world point in that plane
  const uv = (p) => [0, 1].map((i) => { const a = i ? f.y : f.x; return (p[0] - f.origin[0]) * a[0] + (p[1] - f.origin[1]) * a[1] + (p[2] - f.origin[2]) * a[2]; });
  const a = uv([4, 10, 20]), b = uv([30, 10, 4]);
  const rib = (o = {}) => feature("rib", "rib", { profile: [{ kind: "sketch", feature: "sr", entity: "l" }], thickness: 3, direction: "parallel", flip: false, extend: false, targets: [], ...o });
  const base = await run(bracket());
  const was = vol(base.k, base.engine);
  let made = null;
  for (const flip of [false, true]) {
    const x = await run([...bracket(), mid, sketch("sr", line(a[0], a[1], b[0], b[1], "l"), datum("mid")), rib({ flip })]);
    if (x.r.features.find((q) => q.id === "rib").status === "ok") { made = x; break; }
  }
  assert.ok(made, "the rib builds towards the part in one of the two directions");
  assert.equal(made.r.bodies.length, 1);
  // the triangle between the line, the wall and the base, 3 thick
  near(vol(made.k, made.engine) - was, 0.5 * 26 * 16 * 3, 1e-4);
  assert.ok(names(made.engine).includes("e:start:pa"), "the part keeps its face names");
  // a line that stops short of the part is carried on to it
  const short = uv([10, 10, 16.3077]), end = uv([20, 10, 10.1538]);
  for (const flip of [false, true]) {
    const x = await run([...bracket(), mid, sketch("sr", line(short[0], short[1], end[0], end[1], "l"), datum("mid")), rib({ flip, extend: true })]);
    if (x.r.features.find((q) => q.id === "rib").status !== "ok") continue;
    near(vol(x.k, x.engine) - was, 0.5 * 26 * 16 * 3, 1e-3);
    return;
  }
  assert.fail("the extended rib did not build");
});

test("wrap: a rectangle laid round a cylinder is raised from it or sunk into it", async () => {
  const cyl = [sketch("s", circle(0, 0, 10, "c")), extrude("e", "s", { depth: 30 })];
  // a plane tangent to the cylinder at x = 10, with a 6 wide (round the cylinder) by 8 high rectangle on it
  const tangent = feature("pl", "plane", { method: "offset", ref: right, distance: 10, flip: false });
  const probe = await run([...cyl, tangent, sketch("sr", rect(0, 0, 1, 1, "r"), datum("pl"))]);
  const f = probe.r.sketches.find((s) => s.featureId === "sr").frame;
  const uv = (p) => [0, 1].map((i) => { const a = i ? f.y : f.x; return (p[0] - f.origin[0]) * a[0] + (p[1] - f.origin[1]) * a[1] + (p[2] - f.origin[2]) * a[2]; });
  const p0 = uv([10, -3, 10]), p1 = uv([10, 3, 18]);
  const sk = sketch("sr", rect(Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1]), "r"), datum("pl"));
  const wrap = (o) => feature("w", "wrap", { profile: { sketch: "sr", regions: null }, face: face("e", "e:side:c"), result: "emboss", depth: 1, ...o });
  const CYL = Math.PI * 100 * 30, angle = 6 / 10;
  let x = await run([...cyl, tangent, sk, wrap({})]);
  allOk(x.r);
  assert.equal(x.r.bodies.length, 1);
  near(vol(x.k, x.engine) - CYL, 0.5 * angle * (121 - 100) * 8, 1e-3);
  x = await run([...cyl, tangent, sk, wrap({ result: "deboss", depth: 2 })]);
  allOk(x.r);
  near(CYL - vol(x.k, x.engine), 0.5 * angle * (100 - 64) * 8, 1e-3);
  x = await run([...cyl, tangent, sk, wrap({ result: "new", depth: 1 })]);
  allOk(x.r);
  assert.equal(x.r.bodies.length, 2);
  // a sketch plane across the axis cannot be wrapped
  x = await run([...cyl, sketch("st", rect(0, 0, 2, 2, "r")), feature("w", "wrap", { profile: { sketch: "st", regions: null }, face: face("e", "e:side:c"), result: "emboss", depth: 1 })]);
  failed(x.r, "w", /parallel to the cylinder's axis/);
  x = await run([...block(), sketch("st", rect(0, 0, 2, 2, "r"), front), feature("w", "wrap", { profile: { sketch: "st", regions: null }, face: face("e", TOP), result: "emboss", depth: 1 })]);
  failed(x.r, "w", /cylindrical face/);
});

// ---------------------------------------------------------------- fillets

test("variable fillet: the radius changes along the edge", async () => {
  const e1 = edge("e", TOP, SIDE("a"));
  const vf = (o) => feature("vf", "variable-fillet", { edges: [e1], radius: 1, radius2: 3, between: "", swap: false, ...o });
  const lost = (r) => (1 - Math.PI / 4) * r * r * 40;
  let x = await run([...block(), vf({})]);
  allOk(x.r);
  const v13 = BLOCK - vol(x.k, x.engine);
  assert.ok(v13 > lost(1) && v13 < lost(3), `between a 1 and a 3 fillet: ${v13}`);
  assert.equal(names(x.engine).length, 7);
  assert.ok(names(x.engine).includes(`vf:from(${e1.name})`), names(x.engine).join());
  // the same radius at both ends is the plain fillet
  x = await run([...block(), vf({ radius: 2, radius2: 2 })]);
  allOk(x.r); near(BLOCK - vol(x.k, x.engine), lost(2), 1e-3);
  // a radius in between bulges the rounding
  x = await run([...block(), vf({ radius: 1, radius2: 1, between: "50%: 4" })]);
  allOk(x.r);
  assert.ok(BLOCK - vol(x.k, x.engine) > lost(1) * 1.5, "bigger in the middle");
  // swapping the ends mirrors it: the same volume, the other way round
  const a = await run([...block(), vf({})]), b = await run([...block(), vf({ swap: true })]);
  near(vol(a.k, a.engine), vol(b.k, b.engine), 1e-6);
  const cx = (q) => { const g = new q.k.oc.GProp_GProps(); q.k.oc.BRepGProp.VolumeProperties(body(q.engine).shape, g, true, false, false); const c = g.CentreOfMass(); const v = c.X(); c.delete(); g.delete(); return v; };
  assert.ok(Math.abs(cx(a) - 20) > 1e-4 && Math.abs((cx(a) - 20) + (cx(b) - 20)) < 1e-6, "mirrored about the middle of the edge");
  x = await run([...block(), vf({ between: "nonsense" })]);
  failed(x.r, "vf", /not a place and a radius/);
});

test("face blend: the edges between two sets of faces are rounded", async () => {
  let x = await run([...block(), feature("fb", "face-blend", { side1: [face("e", TOP)], side2: [face("e", SIDE("a")), face("e", SIDE("c"))], radius: 2 })]);
  allOk(x.r);
  near(BLOCK - vol(x.k, x.engine), 2 * (1 - Math.PI / 4) * 4 * 40, 1e-4);
  assert.equal(names(x.engine).length, 8);
  x = await run([...block(), feature("fb", "face-blend", { side1: [face("e", TOP)], side2: [face("e", BOTTOM)], radius: 2 })]);
  failed(x.r, "fb", /do not meet along an edge/);
});

// ---------------------------------------------------------------- direct editing

test("delete face: healing fills a hole, removes a boss and makes a rounded edge sharp again", async () => {
  let x = await run([...holed(), feature("d", "delete-face", { faces: [face("e", "cut:side:h")], mode: "heal" })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK, 1e-6);
  assert.deepEqual(names(x.engine), [BOTTOM, TOP, SIDE("a"), SIDE("b"), SIDE("c"), SIDE("d")].sort(), "the six faces, by their old names");
  x = await run([...bossed(), feature("d", "delete-face", { faces: [face("e", "boss:side:b"), face("e", "boss:end:b")], mode: "heal" })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK, 1e-6);
  assert.equal(names(x.engine).length, 6);
  const e1 = edge("e", TOP, SIDE("a"));
  x = await run([...block(), feature("f", "fillet", { edges: [e1], radius: 3 }), feature("d", "delete-face", { faces: [face("e", `f:from(${e1.name})`)], mode: "heal" })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK, 1e-6);
  assert.deepEqual(names(x.engine), [BOTTOM, TOP, SIDE("a"), SIDE("b"), SIDE("c"), SIDE("d")].sort());
  // a face whose neighbours never meet cannot be healed away
  x = await run([...block(), feature("d", "delete-face", { faces: [face("e", TOP)], mode: "heal" })]);
  failed(x.r, "d", /do not meet when extended/);
});

test("delete face: a cap closes the opening with a flat face", async () => {
  // a chamfered edge deleted and capped is the chamfer again; a hole's wall capped closes both mouths
  const x = await run([...holed(), feature("d", "delete-face", { faces: [face("e", "cut:side:h")], mode: "cap" })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK, 1e-6);
  assert.ok(names(x.engine).includes("d:cap") && names(x.engine).includes(SIDE("a")), names(x.engine).join());
});

test("modify fillet: a rounding gets a new radius or is removed, whatever made it", async () => {
  const e1 = edge("e", TOP, SIDE("a"));
  const filleted = [...block(), feature("f", "fillet", { edges: [e1], radius: 2 })];
  const lost = (r) => (1 - Math.PI / 4) * r * r * 40;
  const fname = `f:from(${e1.name})`;
  let x = await run([...filleted, feature("m", "modify-fillet", { faces: [face("e", fname)], mode: "radius", radius: 4 })]);
  allOk(x.r);
  near(BLOCK - vol(x.k, x.engine), lost(4), 1e-4);
  assert.ok(names(x.engine).includes(fname), "the rounding keeps its name: " + names(x.engine).join());
  x = await run([...filleted, feature("m", "modify-fillet", { faces: [face("e", fname)], mode: "radius", radius: 1 })]);
  allOk(x.r);
  near(BLOCK - vol(x.k, x.engine), lost(1), 1e-4);
  x = await run([...filleted, feature("m", "modify-fillet", { faces: [face("e", fname)], mode: "remove", radius: 1 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK, 1e-6);
  // an inner corner: the rounding there adds material, and removing it takes the material away again
  const inner = edge("e", "e:end:pa", "wall:side:wb");
  const b = await run(bracket()); const was = vol(b.k, b.engine);
  x = await run([...bracket(), feature("f", "fillet", { edges: [inner], radius: 3 }), feature("m", "modify-fillet", { faces: [face("e", `f:from(${inner.name})`)], mode: "remove", radius: 1 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), was, 1e-6);
});

test("move face: a flat face moved takes the faces around it along", async () => {
  const mv = (o) => feature("m", "move-face", { faces: [face("e", TOP)], type: "translate", direction: null, distance: 5, flip: false, axis: null, angle: 10, ...o });
  let x = await run([...block(), mv({})]);
  allOk(x.r);
  near(vol(x.k, x.engine), 40 * 20 * 15);
  assert.deepEqual(bboxOf(x.r), [0, 0, 0, 40, 20, 15]);
  assert.deepEqual(names(x.engine), [BOTTOM, TOP, SIDE("a"), SIDE("b"), SIDE("c"), SIDE("d")].sort(), "every face keeps its name");
  x = await run([...block(), mv({ flip: true, distance: 4 })]);
  allOk(x.r); near(vol(x.k, x.engine), 40 * 20 * 6);
  x = await run([...block(), mv({ type: "offset", distance: 2 })]);
  allOk(x.r); near(vol(x.k, x.engine), 40 * 20 * 12);
  // along an edge's direction: only the part of the motion along the face's normal counts for a flat face
  x = await run([...block(), mv({ faces: [face("e", SIDE("b"))], direction: right, distance: 10 })]);
  allOk(x.r); near(vol(x.k, x.engine), 50 * 20 * 10);
  // tilted about its edge at y = 0 by 10°: a wedge is added
  x = await run([...block(), mv({ type: "rotate", axis: edge("e", TOP, SIDE("a")), angle: 10 })]);
  allOk(x.r);
  const wedge = 0.5 * 20 * 20 * Math.tan((10 * Math.PI) / 180) * 40;
  near(Math.abs(vol(x.k, x.engine) - BLOCK), wedge, 1e-4);
  // the floor of a pocket moved down deepens the pocket
  const pocket = [...block(), sketch("sp", rect(10, 5, 30, 15, "q"), onFace("e", TOP)), extrude("pk", "sp", { operation: "remove", depth: 4, flip: true })];
  const p0 = await run(pocket); allOk(p0.r);
  const floor = names(p0.engine).find((n) => n.startsWith("pk:end") || n.startsWith("pk:start"));
  assert.ok(floor, names(p0.engine).join());
  for (const flip of [false, true]) {
    x = await run([...pocket, feature("m", "move-face", { faces: [face("e", floor)], type: "translate", direction: null, distance: 2, flip, axis: null, angle: 0 })]);
    allOk(x.r);
    near(Math.abs(vol(x.k, x.engine) - vol(p0.k, p0.engine)), 20 * 10 * 2, 1e-6);
  }
});

test("move face: a hole and a boss move as they are; an offset changes a hole's radius", async () => {
  let x = await run([...holed(), feature("m", "move-face", { faces: [face("e", "cut:side:h")], type: "translate", direction: right, distance: 15, flip: false, axis: null, angle: 0 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK - HOLE, 1e-6);
  const wall = body(x.engine).topo.faces.find((f) => f.name === "cut:side:h");
  assert.ok(wall, "the hole's wall keeps its name: " + names(x.engine).join());
  near(x.k.centre(wall.shape, "face")[0], 25, 1e-6);
  x = await run([...bossed(), feature("m", "move-face", { faces: [face("e", "boss:side:b"), face("e", "boss:end:b")], type: "translate", direction: right, distance: 12, flip: true, axis: null, angle: 0 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK + BOSS, 1e-6);
  near(x.k.centre(body(x.engine).topo.faces.find((f) => f.name === "boss:end:b").shape, "face")[0], 18, 1e-6);
  // offset: along the face's own normal, which for a hole points to its axis
  x = await run([...holed(), feature("m", "move-face", { faces: [face("e", "cut:side:h")], type: "offset", direction: null, distance: 1, flip: false, axis: null, angle: 0 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK - Math.PI * 9 * 10, 1e-6);
  x = await run([...holed(), feature("m", "move-face", { faces: [face("e", "cut:side:h")], type: "offset", direction: null, distance: 2, flip: true, axis: null, angle: 0 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK - Math.PI * 36 * 10, 1e-6);
  x = await run([...bossed(), feature("m", "move-face", { faces: [face("e", "boss:side:b")], type: "offset", direction: null, distance: 1, flip: false, axis: null, angle: 0 })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK + Math.PI * 25 * 5, 1e-6);
});

test("replace face: a face is put on a plane or a cylinder, and the part follows", async () => {
  const up = feature("pl", "plane", { method: "offset", ref: top, distance: 16, flip: false });
  let x = await run([...block(), up, feature("r", "replace-face", { faces: [face("e", TOP)], target: datum("pl"), offset: 0, flip: false })]);
  allOk(x.r);
  near(vol(x.k, x.engine), 40 * 20 * 16);
  assert.ok(names(x.engine).includes(TOP));
  x = await run([...block(), up, feature("r", "replace-face", { faces: [face("e", TOP)], target: datum("pl"), offset: -10, flip: false })]);
  allOk(x.r);
  near(vol(x.k, x.engine), 40 * 20 * 6);
  // the boss's top put on the block's own top plane, 2 above it: the boss is 2 high
  x = await run([...bossed(), feature("r", "replace-face", { faces: [face("e", "boss:end:b")], target: face("e", TOP), offset: 2, flip: false })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK + Math.PI * 16 * 2, 1e-6);
  // a tilted plane
  const tilt = feature("tp", "plane", { method: "angle", ref: top, axis: edge("e", BOTTOM, SIDE("a")), angle: 20, flip: false });
  const t = await run([...block(), tilt]);
  if (t.r.features.every((q) => q.status === "ok")) {
    x = await run([...block(), tilt, feature("r", "replace-face", { faces: [face("e", TOP)], target: datum("tp"), offset: 0, flip: false })]);
    allOk(x.r);
    assert.ok(Math.abs(vol(x.k, x.engine) - BLOCK) > 1, "the block is cut or grown to the tilted plane");
  }
  x = await run([...block(), feature("r", "replace-face", { faces: [face("e", TOP)], target: null, offset: 0, flip: false })]);
  failed(x.r, "r", /Pick the surface/);
});

// ---------------------------------------------------------------- curve pattern, composite part, mate connector

test("curve pattern: copies of a feature spaced along a sketch curve", async () => {
  // a Ø4 boss on the block's top at (5, 10), copied along a line to (35, 10): 4 bosses in all
  const path = sketch("sp", line(5, 10, 35, 10, "l"), onFace("e", TOP));
  const boss = [sketch("sb", circle(5, 10, 2, "b"), onFace("e", TOP)), extrude("boss", "sb", { operation: "add", depth: 3 })];
  const cp = (o = {}) => feature("cp", "curve-pattern", { of: "features", features: ["boss"], bodies: [], merge: false, path: [{ kind: "sketch", feature: "sp", entity: "l" }], count: 4, keepOrientation: false, reverse: false, skip: "", ...o });
  let x = await run([...block(), ...boss, path, cp()]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK + 4 * Math.PI * 4 * 3, 1e-6);
  x = await run([...block(), ...boss, path, cp({ skip: "3" })]);
  allOk(x.r);
  near(vol(x.k, x.engine), BLOCK + 3 * Math.PI * 4 * 3, 1e-6);
  x = await run([...block(), ...boss, path, cp({ path: [] })]);
  assert.equal(x.r.features.find((f) => f.id === "cp").status, "error");
});

test("composite part: two bodies become one part, closed or open", async () => {
  const two = [...block(), sketch("s2", rect(50, 0, 60, 10, "q")), extrude("e2", "s2", { depth: 5 })];
  let x = await run([...two, feature("c", "composite-part", { bodies: ["e", "e2"], closed: true })]);
  allOk(x.r);
  assert.equal(x.engine.state.bodies.length, 1);
  near(vol(x.k, x.engine), BLOCK + 500, 1e-6);
  assert.ok(names(x.engine).includes(`c:e:${TOP}`));
  x = await run([...two, feature("c", "composite-part", { bodies: ["e", "e2"], closed: false })]);
  allOk(x.r);
  assert.equal(x.engine.state.bodies.filter((b) => !b.reference).length, 2);
  x = await run([...two, feature("c", "composite-part", { bodies: ["e"], closed: true })]);
  failed(x.r, "c", /two or more/);
});

test("mate connector: a frame on a face, flipped, turned and moved; a sketch can sit on it", async () => {
  let x = await run([...block(), feature("m", "mate-connector", { origin: face("e", TOP), between: null, flip: false, turn: 0, x: 0, y: 0, z: 0 })]);
  allOk(x.r);
  const d = x.engine.state.datums.m;
  assert.equal(d.kind, "plane"); assert.ok(d.mate);
  near(d.frame.origin[0], 20); near(d.frame.origin[1], 10); near(d.frame.origin[2], 10); near(d.frame.normal[2], 1);
  x = await run([...block(), feature("m", "mate-connector", { origin: face("e", TOP), between: null, flip: true, turn: 90, x: 0, y: 0, z: 5 }),
    sketch("sm", rect(-2, -2, 2, 2, "r"), datum("m")), extrude("e3", "sm", { operation: "new", depth: 1 })]);
  allOk(x.r);
  const m = x.engine.state.datums.m;
  near(m.frame.normal[2], -1); near(m.frame.origin[2], 5);
  x = await run([...block(), feature("m", "mate-connector", { origin: null, between: null, flip: false, turn: 0, x: 0, y: 0, z: 0 })]);
  failed(x.r, "m", /Pick where/);
});

// ---------------------------------------------------------------- curves

const curveLen = (k, shape) => { const oc = k.oc; const props = new oc.GProp_GProps(); oc.BRepGProp.LinearProperties(shape, props, false, false); const m = props.Mass(); props.delete(); return m; };
const curveOf = (x, id) => x.engine.state.datums[id];
const pieces = (x, id) => x.k.sub(curveOf(x, id).shape, "wire").length || 1;
const vtx = (body, name) => ({ kind: "vertex", body, name });
/** the block's corner vertices: (x, y, z) → its name, read from the kernel */
async function cornerNames() {
  const x = await run(block());
  const b = body(x.engine);
  const out = {};
  for (const v of b.topo.vertices) out[x.k.vertexPoint(v.shape).map((c) => Math.round(c)).join(",")] = v.name;
  return out;
}

test("fit spline: a curve through points, open or closed, sweepable", async () => {
  const c = await cornerNames();
  const pts = ["0,0,10", "40,0,10", "40,20,10"].map((k) => vtx("e", c[k]));
  let x = await run([...block(), feature("fs", "fit-spline", { points: pts, closed: false, startDir: null, endDir: null, flipStart: false, flipEnd: false })]);
  allOk(x.r);
  const d = curveOf(x, "fs");
  assert.equal(d.kind, "curve");
  assert.ok(curveLen(x.k, d.shape) > 60, "longer than the chords");
  x = await run([...block(), feature("fs", "fit-spline", { points: [...pts, vtx("e", c["0,20,10"])], closed: true, startDir: null, endDir: null, flipStart: false, flipEnd: false })]);
  allOk(x.r);
  assert.ok(curveLen(x.k, curveOf(x, "fs").shape) > 120);
  x = await run([...block(), feature("fs", "fit-spline", { points: pts.slice(0, 1), closed: false })]);
  failed(x.r, "fs", /two or more points/);
});

test("composite curve: edges joined into one curve", async () => {
  const x = await run([...block(), feature("cc", "composite-curve", { curves: [edge("e", TOP, SIDE("a")), edge("e", TOP, SIDE("b")), edge("e", TOP, SIDE("c"))] })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "cc").shape), 100, 1e-6);
  const y = await run([...block(), feature("cc", "composite-curve", { curves: [edge("e", TOP, SIDE("a")), edge("e", TOP, SIDE("c"))] })]);
  failed(y.r, "cc", /join end to end/);
});

test("intersection curve: a plane through the block makes its outline there", async () => {
  const mid = feature("pl", "plane", { method: "offset", ref: top, distance: 5, flip: false });
  const x = await run([...holed(), mid, feature("ic", "intersection-curve", { first: [face("e", SIDE("a")), face("e", SIDE("b")), face("e", SIDE("c")), face("e", SIDE("d")), face("e", "cut:side:h")], second: [datum("pl")] })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "ic").shape), 120 + Math.PI * 8, 1e-4);
  assert.equal(pieces(x, "ic"), 2, "the outline and the hole: two loops");
});

test("projected curve: a sketch line projected onto a cylinder; two sketches crossing", async () => {
  const cyl = [sketch("s", circle(0, 0, 10, "c")), extrude("e", "s", { depth: 30 })];
  // a line on Right, 2 off the axis and 20 long along it, projected along x: a straight run on each side
  let x = await run([...cyl, sketch("sp", line(-2, 5, -2, 25, "l"), right), feature("pc", "projected-curve", { method: "face", curves: [{ kind: "sketch", feature: "sp", entity: "l" }], faces: [face("e", "e:side:c")], direction: null, curves2: [] })]);
  allOk(x.r);
  // two straight runs 20 long, one on each side of the cylinder
  near(curveLen(x.k, curveOf(x, "pc").shape), 40, 1e-4);
  // curve to curve: a line on Top (y = 5) and a line on Front (z = 3): their 3D curve is a line at y = 5, z = 3
  x = await run([sketch("a", line(0, 5, 20, 5, "l")), sketch("b", line(0, 3, 20, 3, "m"), front),
    feature("pc", "projected-curve", { method: "curves", curves: [{ kind: "sketch", feature: "a", entity: "l" }], faces: [], direction: null, curves2: [{ kind: "sketch", feature: "b", entity: "m" }] })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "pc").shape), 20, 1e-4);
});

test("bridging curve: tangent and curvature bridges between two lines", async () => {
  const two = [sketch("s", { ...line(0, 0, 10, 0, "a"), ...line(20, 10, 30, 10, "b") })];
  const br = (match) => feature("br", "bridging-curve", { start: { kind: "sketch", feature: "s", entity: "a" }, end: { kind: "sketch", feature: "s", entity: "b" }, match, startMagnitude: 1, endMagnitude: 1, flipStart: false, flipEnd: false });
  for (const match of ["position", "tangency", "curvature"]) {
    const x = await run([...two, br(match)]);
    allOk(x.r);
    const d = curveOf(x, "br"), L = curveLen(x.k, d.shape);
    if (match === "position") near(L, Math.hypot(10, 10), 1e-6);
    else assert.ok(L > Math.hypot(10, 10) && L < 25, `${match}: ${L}`);
    // the bridge starts at (10, 0) and ends at (20, 10)
    const p = d.points;
    near(p[0], 10, 1e-6); near(p[1], 0, 1e-6); near(p[p.length - 3], 20, 1e-6); near(p[p.length - 2], 10, 1e-6);
    if (match !== "position") {
      // it leaves along +x and arrives along +x: the second sample is above the first's x and nearly level
      assert.ok(Math.abs(p[4] - p[1]) < Math.abs(p[3] - p[0]), "tangent at the start");
    }
  }
});

test("trim curve: by a distance either way, and up to a plane", async () => {
  const sk = sketch("s", line(0, 0, 20, 0, "l"));
  const tc = (o) => feature("tc", "trim-curve", { curve: { kind: "sketch", feature: "s", entity: "l" }, end: "end", by: "distance", distance: -5, bound: null, ...o });
  let x = await run([sk, tc({})]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "tc").shape), 15, 1e-4);
  x = await run([sk, tc({ distance: 7, end: "start" })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "tc").shape), 27, 1e-6);
  near(curveOf(x, "tc").points[0], -7, 1e-6);
  const pl = (d) => feature("pl", "plane", { method: "offset", ref: right, distance: d, flip: false });
  x = await run([sk, pl(12), tc({ by: "entity", bound: datum("pl") })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "tc").shape), 12, 1e-4);
  x = await run([sk, pl(32), tc({ by: "entity", bound: datum("pl") })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "tc").shape), 32, 1e-4);
  x = await run([sk, tc({ distance: -25 })]);
  failed(x.r, "tc", /whole curve/);
});

test("isocline: the silhouette of a cylinder seen along x", async () => {
  const cyl = [sketch("s", circle(0, 0, 10, "c")), extrude("e", "s", { depth: 30 })];
  let x = await run([...cyl, feature("iso", "isocline", { faces: [face("e", "e:side:c")], direction: { kind: "plane", plane: "right" }, angle: 0 })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "iso").shape), 60, 1e-3);
  const p = curveOf(x, "iso").points.filter((v, i) => i % 3 === 0 && Number.isFinite(v));
  assert.ok(p.every((v) => Math.abs(v) < 1e-3), "every point at x = 0");
  x = await run([...cyl, feature("iso", "isocline", { faces: [face("e", "e:side:c")], direction: { kind: "plane", plane: "top" }, angle: 0 })]);
  failed(x.r, "iso", /nowhere/);
});

test("routing curve: runs between points with rounded bends", async () => {
  const c = await cornerNames();
  const pts = ["0,0,10", "40,0,10", "40,20,10", "40,20,0"].map((k) => vtx("e", c[k]));
  let x = await run([...block(), feature("rc", "routing-curve", { points: pts, radius: 0, closed: false })]);
  allOk(x.r);
  near(curveLen(x.k, curveOf(x, "rc").shape), 70, 1e-6);
  x = await run([...block(), feature("rc", "routing-curve", { points: pts, radius: 2, closed: false })]);
  allOk(x.r);
  // each right-angle bend saves 2r and adds a quarter circle
  near(curveLen(x.k, curveOf(x, "rc").shape), 70 - 2 * (4 - Math.PI), 1e-6);
  x = await run([...block(), feature("rc", "routing-curve", { points: pts, radius: 8, closed: false })]);
  failed(x.r, "rc", /too large/);
});

test("fillet by width: a right-angled edge rounded 2√2 across has a radius of 2", async () => {
  const byR = await run([...block(), feature("f", "fillet", { edges: [edge("e", TOP, SIDE("a"))], measure: "radius", radius: 2, width: 0 })]);
  const byW = await run([...block(), feature("f", "fillet", { edges: [edge("e", TOP, SIDE("a"))], measure: "width", radius: 0, width: 2 * Math.SQRT2 })]);
  allOk(byR.r); allOk(byW.r);
  near(vol(byW.k, byW.engine), vol(byR.k, byR.engine), 1e-6);
  near(BLOCK - vol(byR.k, byR.engine), (4 - Math.PI) * 40, 1e-6);
  // an old fillet with no measurement is by radius
  const old = await run([...block(), feature("f", "fillet", { edges: [edge("e", TOP, SIDE("a"))], radius: 2 })]);
  near(vol(old.k, old.engine), vol(byR.k, byR.engine), 1e-9);
});
