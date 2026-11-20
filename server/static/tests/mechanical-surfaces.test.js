// Node test for surface bodies and the surface features of the mechanical domain (web/domains/mechanical:
// kernel/ops/surface.ts, surface-sweeps.ts, features/offset-surface.ts, boundary-surface.ts, fill.ts,
// move-boundary.ts, ruled-surface.ts, mutual-trim.ts, constrained-surface.ts).  The real OpenCascade build runs
// here, as it does in the browser's worker.
// Run: node server/static/tests/mechanical-surfaces.test.js
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

// ---- documents
const pt = (x, y) => ({ type: "point", x, y });
/** an open polyline through points: lines `<p>1`, `<p>2`, … */
const polyline = (pts, p, closed = false) => {
  const out = {};
  pts.forEach((q, i) => { out[`${p}p${i}`] = pt(q[0], q[1]); });
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) out[`${p}${i + 1}`] = { type: "line", a: `${p}p${i}`, b: `${p}p${(i + 1) % pts.length}` };
  return out;
};
const rect = (x0, y0, x1, y1, p) => polyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], p, true);
const sketch = (id, entities, plane = "top") => ({ id, type: "sketch", name: id, suppressed: false, params: { plane: typeof plane === "string" ? { kind: "plane", plane } : plane, sketch: { version: 1, entities, constraints: {} } } });
const feature = (id, type, params) => ({ id, type, name: id, suppressed: false, params });
const extrude = (id, sk, o = {}) => feature(id, "extrude", { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o });
const curve = (feature, entity) => ({ kind: "sketch", feature, entity });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);

const area = (k, shape) => { const g = new k.oc.GProp_GProps(); k.oc.BRepGProp.SurfaceProperties(shape, g, false, false); const a = g.Mass(); g.delete(); return a; };
const box = (k, shape) => { const b = new k.oc.Bnd_Box(); k.oc.BRepBndLib.Add(shape, b, false); const out = [b.GetXMin(), b.GetYMin(), b.GetZMin(), b.GetXMax(), b.GetYMax(), b.GetZMax()].map((v) => Math.round(v * 1e4) / 1e4 + 0); b.delete(); return out; };
async function build(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r, body: (id) => engine.state.bodies.find((b) => b.id === id), status: r.features.map((f) => f.status + (f.message ? ": " + f.message : "")) };
}
const ok = (m, n) => assert.deepEqual(m.status, new Array(n ?? m.status.length).fill("ok"));
const service = (name) => K.SERVICES.find((s) => s.name === name);
function call(k, engine, name, args) {
  const mine = []; k.scope = mine;
  return Promise.resolve(service(name).run({ oc: k.oc, k, state: engine.state, fail: (m) => new Error(m) }, args)).finally(() => { k.scope = null; for (const o of mine.reverse()) { try { o.delete(); } catch (e) { /* gone */ } } });
}


const face = (body, name) => ({ kind: "face", body, name });
const edge = (body, name) => ({ kind: "edge", body, name });
/** how far a point is from a body */
const distTo = (m, id, p) => { const oc = m.k.oc, v = new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(p[0], p[1], p[2])).Vertex(), d = new oc.BRepExtrema_DistShapeShape(); d.LoadS1(v); d.LoadS2(m.body(id).shape); d.Perform(new oc.Message_ProgressRange()); const out = d.Value(); d.delete(); return out; };
const names = (body) => body.topo.faces.map((f) => f.name).sort();
/** the name of the edge of a body whose box is this one */
const edgeAt = (m, id, want) => { const e = m.body(id).topo.edges.find((x) => box(m.k, x.shape).join(",") === want.join(",")); assert.ok(e, `no edge at ${want}`); return edge(id, e.name); };
const blockDoc = () => [sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1")];
/** a flat 20 × 10 sheet standing on the X axis, in the XZ plane */
const sheetDoc = () => [sketch("s1", polyline([[0, 0], [20, 0]], "l")), extrude("x1", "s1", { bodyType: "surface", depth: 10 })];

test("the surface features are in the registry, in the toolbar's surface section, in Onshape's order", () => {
  const surface = K.FEATURES.filter((f) => f.toolbarSection === "surface").sort((a, b) => a.toolbarOrder - b.toolbarOrder);
  assert.deepEqual(surface.map((f) => f.title), ["Offset surface", "Boundary surface", "Fill", "Move boundary", "Ruled surface", "Mutual trim", "Constrained surface"]);
  for (const f of surface) { assert.ok(f.icon && f.hint && f.keywords, f.type); assert.equal(f.toolbarMenu, undefined); }
  for (const t of ["extrude", "revolve", "sweep", "loft"]) {
    const f = K.FEATURES.find((x) => x.type === t);
    assert.deepEqual(f.schema[0].options.map((o) => o.label), ["Solid", "Surface"], t);
    assert.equal(f.defaults().bodyType, "solid");
    // what means nothing for a sheet is hidden while Surface is chosen
    const hidden = f.schema.filter((x) => x.visible && !x.visible({ ...f.defaults(), bodyType: "surface", operation: "add" })).map((x) => x.key);
    assert.ok(hidden.includes("operation") && hidden.includes("targets"), t);
  }
});

test("Extrude as a surface: the sketch's curves, open or closed, become sheets; a sheet is a surface body", async () => {
  const m = await build([sketch("s1", polyline([[0, 0], [20, 0], [20, 10]], "l")), extrude("x1", "s1", { bodyType: "surface", depth: 5 })]);
  ok(m);
  const b = m.body("x1");
  assert.equal(b.sheet, true); assert.equal(b.name, "Surface 1");
  assert.deepEqual(names(b), ["x1:side:l1", "x1:side:l2"]);
  assert.equal(b.topo.edges.length, 7, "the two faces are sewn along the edge they share");
  near(area(m.k, b.shape), 30 * 5);
  assert.equal(m.r.bodies[0].sheet, true, "the page is told it is a surface");
  assert.ok(m.r.bodies[0].mesh.indices.length > 0 && m.r.bodies[0].mesh.faces.names.length === 2, "and gets its mesh, face by face");

  // closed curves: a tube and a cylinder, with no caps; symmetric about the sketch
  const c = await build([sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: pt(10, 10), hole: { type: "circle", center: "hc", r: 3 } }), extrude("x1", "s1", { bodyType: "surface", depth: 5, endType: "symmetric" })]);
  ok(c);
  assert.deepEqual(c.engine.state.bodies.map((x) => [x.id, x.name, x.sheet, x.topo.faces.length]), [["x1:s1", "Surface 1", true, 4], ["x1:s2", "Surface 2", true, 1]]);
  near(area(c.k, c.body("x1:s1").shape), 120 * 5); near(area(c.k, c.body("x1:s2").shape), 2 * Math.PI * 3 * 5);
  assert.deepEqual(box(c.k, c.body("x1:s1").shape), [0, 0, -2.5, 40, 20, 2.5]);

  // what a sheet cannot do says so
  const bad = await build([sketch("s1", polyline([[0, 0], [20, 0]], "l")), extrude("x1", "s1", { bodyType: "surface", endType: "through" })]);
  assert.match(bad.status[1], /error: A surface is extruded by a depth/);
});

test("solid features leave surfaces alone, and a part is still numbered among the parts", async () => {
  const m = await build([
    sketch("s0", polyline([[0, 0], [40, 0]], "l")), extrude("x0", "s0", { bodyType: "surface", depth: 10 }),
    sketch("s1", rect(0, 0, 40, 20, "r")), extrude("e1", "s1"),
    sketch("s2", rect(10, 5, 20, 15, "q")), extrude("e2", "s2", { operation: "add", depth: 15 }),
    sketch("s3", rect(25, 5, 35, 15, "h")), extrude("e3", "s3", { operation: "remove", endType: "through" }),
  ]);
  ok(m);
  assert.deepEqual(m.engine.state.bodies.map((b) => [b.id, b.name, !!b.sheet]), [["x0", "Surface 1", true], ["e1", "Part 1", false]]);
  near(m.k.volume(m.body("e1").shape), 40 * 20 * 10 + 10 * 10 * 5 - 10 * 10 * 10);
  near(area(m.k, m.body("x0").shape), 400);
  // a surface can still be given to a feature that takes bodies
  const moved = await build([...sheetDoc(), feature("t1", "delete-body", { bodies: ["x1"] })]);
  ok(moved); assert.equal(moved.engine.state.bodies.length, 0);
});

test("Revolve, Sweep and Loft as surfaces", async () => {
  const rv = await build([sketch("s1", { ...polyline([[5, 0], [5, 10]], "l"), ...polyline([[0, 0], [0, 10]], "ax") }), feature("r1", "revolve", { bodyType: "surface", profile: { sketch: "s1", regions: null }, operation: "new", axisType: "line", endType: "full", angle: 180, flip: false, targets: [] })]);
  // two loose lines: the first by id is the axis ("ax1"), the other is the profile
  assert.match(rv.status[1], /^warning/);
  assert.deepEqual(names(rv.body("r1")), ["r1:side:l1"]);
  near(area(rv.k, rv.body("r1").shape), 2 * Math.PI * 5 * 10);
  const half = await build([sketch("s1", polyline([[5, 0], [5, 10]], "l")), feature("r1", "revolve", { bodyType: "surface", profile: { sketch: "s1", regions: null }, operation: "new", axisType: "y", endType: "angle", angle: 90, flip: false, targets: [] })]);
  ok(half); near(area(half.k, half.body("r1").shape), (Math.PI / 2) * 5 * 10);

  const sw = await build([sketch("s1", polyline([[0, 0], [10, 0], [10, 5]], "l")), sketch("s2", polyline([[0, 0], [0, 30]], "p"), "front"), feature("w1", "sweep", { bodyType: "surface", profile: { sketch: "s1", regions: null }, path: [curve("s2", "p1")], corners: "round", operation: "new", targets: [] })]);
  ok(sw);
  assert.deepEqual(names(sw.body("w1")), ["w1:side:l1", "w1:side:l2"]);
  near(area(sw.k, sw.body("w1").shape), 15 * 30);

  // two lines drawn in opposite directions: the loft does not twist
  const lf = await build([sketch("s1", polyline([[0, 10], [20, 10]], "l")), sketch("s2", polyline([[20, 10], [0, 10]], "p"), "front"), feature("l1", "loft", { bodyType: "surface", profiles: ["s1", "s2"], ruled: false, operation: "new", targets: [] })]);
  ok(lf);
  assert.equal(lf.body("l1").sheet, true);
  near(area(lf.k, lf.body("l1").shape), 20 * Math.hypot(10, 10), 1e-5);
});

test("Offset surface: faces of a part carried out or in, a copy at zero, sketch regions", async () => {
  const two = [face("e1", "e1:end:r1"), face("e1", "e1:side:r1")];
  const m = await build([...blockDoc(),
    feature("o1", "offset-surface", { faces: two, profile: null, distance: 3, flip: false }),
    feature("o2", "offset-surface", { faces: two, profile: null, distance: 3, flip: true }),
    feature("o3", "offset-surface", { faces: [face("e1", "e1:end:r1")], profile: { sketch: "s1", regions: null }, distance: 0, flip: false }),
  ]);
  ok(m);
  // the two faces stay joined: each is carried on to where they meet again
  assert.deepEqual(names(m.body("o1")), ["o1:from(e1:end:r1)", "o1:from(e1:side:r1)"]);
  assert.equal(m.body("o1").topo.edges.length, 7);
  near(area(m.k, m.body("o1").shape), 40 * 23 + 40 * 13); assert.deepEqual(box(m.k, m.body("o1").shape), [0, -3, 0, 40, 20, 13]);
  near(area(m.k, m.body("o2").shape), 40 * 17 + 40 * 7); assert.deepEqual(box(m.k, m.body("o2").shape), [0, 3, 0, 40, 20, 7]);
  assert.deepEqual(m.engine.state.bodies.map((b) => b.id), ["e1", "o1", "o2", "o3:s1", "o3:s2"]);
  assert.deepEqual(box(m.k, m.body("o3:s1").shape), [0, 0, 10, 40, 20, 10]); assert.deepEqual(names(m.body("o3:s1")), ["o3:from(e1:end:r1)"]);
  assert.deepEqual(names(m.body("o3:s2")), ["o3:region:r1"]);
  near(m.k.volume(m.body("e1").shape), 8000, 1e-9);
  // a curved face
  const c = await build([sketch("s1", { c: pt(0, 0), o: { type: "circle", center: "c", r: 5 } }), extrude("e1", "s1"), feature("o1", "offset-surface", { faces: [face("e1", "e1:side:o")], profile: null, distance: 1, flip: false })]);
  ok(c); near(area(c.k, c.body("o1").shape), 2 * Math.PI * 6 * 10);
  const none = await build([...blockDoc(), feature("o1", "offset-surface", { faces: [], profile: null, distance: 1, flip: false })]);
  assert.match(none.status[2], /error: Pick the faces/);
});

test("Fill: a flat loop gets a plane, a loop that is not flat a patch; guides; merging with the surface around", async () => {
  // a sketch outline: picking one curve picks the loop
  const flat = await build([sketch("s2", polyline([[0, 0], [10, 0], [10, 10], [0, 10]], "q", true), "front"), feature("f1", "fill", { edges: [curve("s2", "q1")], continuity: "position", guides: [], merge: false })]);
  ok(flat); near(area(flat.k, flat.body("f1").shape), 100); assert.deepEqual(names(flat.body("f1")), ["f1:fill"]);
  assert.ok(flat.k.faceFrame(flat.body("f1").topo.faces[0].shape), "a plane");

  // the round edge of a hole through a block, closed with a disc
  const holed = [sketch("s1", { ...rect(0, 0, 40, 20, "r"), hc: pt(10, 10), hole: { type: "circle", center: "hc", r: 3 } }), extrude("e1", "s1")];
  const disc = await build([...holed, feature("f1", "fill", { edges: [edge("e1", "edge(e1:end:r1|e1:side:hole)")], continuity: "position", guides: [], merge: false })]);
  ok(disc); near(area(disc.k, disc.body("f1").shape), Math.PI * 9); assert.deepEqual(box(disc.k, disc.body("f1").shape), [7, 7, 10, 13, 13, 10]);

  // the open top of a tube (a surface), with a guide point above it: a domed patch, sewn to the tube
  const tube = [sketch("s1", rect(0, 0, 20, 20, "r")), extrude("x1", "s1", { bodyType: "surface", depth: 10 })];
  const t = await build(tube);
  const top = t.body("x1").topo.edges.filter((e) => { const b = box(t.k, e.shape); return b[2] === 10 && b[5] === 10; }).map((e) => edge("x1", e.name));
  assert.equal(top.length, 4);
  const dome = await build([...tube, feature("f1", "fill", { edges: top, continuity: "position", guides: [], merge: true })]);
  ok(dome);
  assert.deepEqual(dome.engine.state.bodies.map((b) => [b.id, b.sheet, b.topo.faces.length]), [["x1", true, 5]]);
  assert.ok(names(dome.body("x1")).includes("f1:fill") && names(dome.body("x1")).includes("x1:side:r1"));
  near(area(dome.k, dome.body("x1").shape), 80 * 10 + 400);
  assert.equal(dome.body("x1").topo.edges.length, 12, "the cap shares the tube's four top edges");

  // a loop of four lines that is not flat (three sketches on the three default planes): a patch through all of
  // them, and through a guide point when there is one
  const loop = [
    sketch("t", polyline([[20, 0], [20, 20], [0, 20]], "t")),                 // (20,0,0) → (20,20,0) → (0,20,0)
    sketch("r", polyline([[20, 0], [0, 15]], "r"), "right"),                  // (0,20,0) → (0,0,15)
    sketch("f", polyline([[0, 15], [20, 0]], "f"), "front"),                  // (0,0,15) → (20,0,0)
    sketch("k", rect(8, 8, 12, 12, "r")), extrude("k1", "k", { depth: 8 }),   // a small block: its corner (8,8,8) is the guide
  ];
  const picks = [curve("t", "t1"), curve("r", "r1"), curve("f", "f1")];
  const patch = await build([...loop, feature("f1", "fill", { edges: picks, continuity: "position", guides: [], merge: false })]);
  ok(patch);
  assert.equal(patch.k.faceFrame(patch.body("f1").topo.faces[0].shape), null, "not a plane");
  for (const q of [[20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 15], [10, 0, 7.5]]) assert.ok(distTo(patch, "f1", q) < 1e-3, `${q}`);
  const guided = await build([...loop, feature("f1", "fill", { edges: picks, continuity: "position", guides: [{ kind: "vertex", body: "k1", name: "vertex(k1:end:r1|k1:side:r1|k1:side:r4)" }], merge: false })]);
  ok(guided);
  assert.ok(distTo(guided, "f1", [8, 8, 8]) < 1e-3, "the patch passes through the guide point");
  assert.ok(distTo(patch, "f1", [8, 8, 8]) > 0.5, "which it did not before");
  const open = await build([...sheetDoc(), feature("f1", "fill", { edges: [edgeAt(await build(sheetDoc()), "x1", [0, 0, 0, 20, 0, 0])], continuity: "position", guides: [], merge: false })]);
  assert.match(open.status[2], /error: The edges do not make a closed loop/);
});

test("Boundary surface: through U profiles, and a four-sided patch from U and V profiles", async () => {
  const two = await build([sketch("s1", polyline([[0, 0], [20, 0]], "a")), sketch("s2", polyline([[20, 12], [0, 5]], "b"), "front"), feature("b1", "boundary-surface", { u: [curve("s1", "a1"), curve("s2", "b1")], v: [] })]);
  ok(two);
  assert.deepEqual(names(two.body("b1")), ["b1:surface"]); assert.equal(two.body("b1").sheet, true);
  near(area(two.k, two.body("b1").shape), 20 * 8.5, 1e-6);

  // U: two opposite sides of a loop that is not flat; V: the two sides that join their ends
  const uv = await build([
    sketch("u1", polyline([[20, 0], [20, 20]], "a")),                          // (20,0,0) → (20,20,0)
    sketch("v1", polyline([[20, 20], [0, 20]], "b")),                          // (20,20,0) → (0,20,0)
    sketch("u2", polyline([[20, 0], [0, 15]], "c"), "right"),                  // (0,20,0) → (0,0,15)
    sketch("v2", polyline([[0, 15], [20, 0]], "d"), "front"),                  // (0,0,15) → (20,0,0)
    feature("b1", "boundary-surface", { u: [curve("u1", "a1"), curve("u2", "c1")], v: [curve("v1", "b1"), curve("v2", "d1")] }),
  ]);
  ok(uv);
  assert.equal(uv.k.faceFrame(uv.body("b1").topo.faces[0].shape), null, "not a plane");
  for (const q of [[20, 0, 0], [20, 20, 0], [0, 20, 0], [0, 0, 15], [20, 10, 0], [10, 0, 7.5]]) assert.ok(distTo(uv, "b1", q) < 1e-3, `${q}`);
  assert.equal(uv.body("b1").topo.edges.length, 4);
  const gap = await build([sketch("u1", polyline([[0, 0], [20, 0]], "a")), sketch("u2", polyline([[0, 20], [20, 20]], "b")), sketch("v1", polyline([[0, 0], [0, 20]], "c")), sketch("v2", polyline([[25, 0], [25, 20]], "d")),
    feature("b1", "boundary-surface", { u: [curve("u1", "a1"), curve("u2", "b1")], v: [curve("v1", "c1"), curve("v2", "d1")] })]);
  assert.match(gap.status[4], /error: The first and last U profiles/);
  const one = await build([sketch("u1", polyline([[0, 0], [20, 0]], "a")), feature("b1", "boundary-surface", { u: [curve("u1", "a1")], v: [] })]);
  assert.match(one.status[1], /error: Pick two or more curves/);
});

test("Ruled surface: normal, tangent, aligned with a vector, at an angle from it; round edges", async () => {
  const e = edge("e1", "edge(e1:end:r1|e1:side:r1)");
  const base = { edges: [e], ruledType: "normal", distance: 5, direction: null, angle: 30, face: null, flip: false };
  const m = await build([...blockDoc(),
    feature("r1", "ruled-surface", { ...base, face: face("e1", "e1:end:r1") }),                       // square to the top face: up
    feature("r2", "ruled-surface", { ...base, ruledType: "tangent", face: face("e1", "e1:end:r1") }), // the top face carried on: outwards
    feature("r3", "ruled-surface", { ...base, edges: [e, edge("e1", "edge(e1:end:r1|e1:side:r2)")], ruledType: "vector", direction: { kind: "plane", plane: "top" } }),
    feature("r4", "ruled-surface", { ...base, ruledType: "angle", direction: { kind: "plane", plane: "top" } }),
    feature("r5", "ruled-surface", { ...base, ruledType: "normal", face: face("e1", "e1:end:r1"), flip: true }),
  ]);
  ok(m);
  assert.deepEqual(box(m.k, m.body("r1").shape), [0, 0, 10, 40, 0, 15]);
  assert.deepEqual(box(m.k, m.body("r2").shape), [0, -5, 10, 40, 0, 10]);
  assert.deepEqual(names(m.body("r1")), ["r1:ruled:edge(e1:end:r1|e1:side:r1)"]);
  // two edges that meet: one surface of two strips
  assert.equal(m.body("r3").topo.faces.length, 2); assert.equal(m.body("r3").topo.edges.length, 7);
  near(area(m.k, m.body("r3").shape), 60 * 5); assert.deepEqual(box(m.k, m.body("r3").shape), [0, 0, 10, 40, 20, 15]);
  near(area(m.k, m.body("r4").shape), 200); assert.equal(box(m.k, m.body("r4").shape)[5], 14.3301);
  assert.deepEqual(box(m.k, m.body("r5").shape), [0, 0, 5, 40, 0, 10]);
  for (const id of ["r1", "r2", "r3", "r4", "r5"]) assert.equal(m.body(id).sheet, true);

  // the rim of a cylinder: normal to its flat end is a tube, tangent to it a ring, normal to its wall a ring too
  const cyl = [sketch("s1", { c: pt(0, 0), o: { type: "circle", center: "c", r: 5 } }), extrude("e1", "s1")];
  const rim = edge("e1", "edge(e1:end:o|e1:side:o)");
  const c = await build([...cyl,
    feature("r1", "ruled-surface", { ...base, edges: [rim], distance: 2, face: face("e1", "e1:end:o") }),
    feature("r2", "ruled-surface", { ...base, edges: [rim], distance: 2, ruledType: "tangent", face: face("e1", "e1:end:o") }),
    feature("r3", "ruled-surface", { ...base, edges: [rim], distance: 2, face: face("e1", "e1:side:o") }),
  ]);
  ok(c);
  near(area(c.k, c.body("r1").shape), 2 * Math.PI * 5 * 2, 1e-6);
  near(area(c.k, c.body("r2").shape), Math.PI * (49 - 25), 1e-4);
  near(area(c.k, c.body("r3").shape), Math.PI * (49 - 25), 1e-4);
  // a sketch curve: its sketch plane stands in for the surface
  const sk = await build([sketch("s1", polyline([[0, 0], [20, 0]], "l")), feature("r1", "ruled-surface", { ...base, edges: [curve("s1", "l1")] })]);
  ok(sk); assert.deepEqual(box(sk.k, sk.body("r1").shape), [0, 0, 0, 20, 0, 5]);
  const nodir = await build([...blockDoc(), feature("r1", "ruled-surface", { ...base, ruledType: "vector" })]);
  assert.match(nodir.status[2], /error: Pick the direction/);
});

test("Move boundary: an open edge of a surface moved out extends it, moved in trims it", async () => {
  const start = await build(sheetDoc());
  const right = edgeAt(start, "x1", [20, 0, 0, 20, 0, 10]), top = edgeAt(start, "x1", [0, 0, 10, 20, 0, 10]);
  const ext = await build([...sheetDoc(), feature("m1", "move-boundary", { edges: [right], moveType: "extend", distance: 5 })]);
  ok(ext);
  // a flat face carried on is still that one face, under its name
  assert.deepEqual(names(ext.body("x1")), ["x1:side:l1"]); assert.equal(ext.body("x1").topo.edges.length, 4);
  near(area(ext.k, ext.body("x1").shape), 250); assert.deepEqual(box(ext.k, ext.body("x1").shape), [0, 0, 0, 25, 0, 10]);
  const trim = await build([...sheetDoc(), feature("m1", "move-boundary", { edges: [right, top], moveType: "trim", distance: 4 })]);
  ok(trim);
  assert.deepEqual(names(trim.body("x1")), ["x1:side:l1"]);
  near(area(trim.k, trim.body("x1").shape), 16 * 6); assert.deepEqual(box(trim.k, trim.body("x1").shape), [0, 0, 0, 16, 0, 6]);

  // a cylinder's open rim: along its straight lines the extension is the cylinder itself
  const tube = [sketch("s1", { c: pt(0, 0), o: { type: "circle", center: "c", r: 5 } }), extrude("x1", "s1", { bodyType: "surface", depth: 10 })];
  const t = await build(tube);
  const rimTop = t.body("x1").topo.edges.find((e) => { const b = box(t.k, e.shape); return b[2] === 10 && b[5] === 10; });
  const longer = await build([...tube, feature("m1", "move-boundary", { edges: [edge("x1", rimTop.name)], moveType: "extend", distance: 4 })]);
  ok(longer);
  near(area(longer.k, longer.body("x1").shape), 2 * Math.PI * 5 * 14, 1e-6); assert.equal(box(longer.k, longer.body("x1").shape)[5], 14);
  const shorter = await build([...tube, feature("m1", "move-boundary", { edges: [edge("x1", rimTop.name)], moveType: "trim", distance: 4 })]);
  ok(shorter);
  near(area(shorter.k, shorter.body("x1").shape), 2 * Math.PI * 5 * 6, 1e-4); assert.equal(box(shorter.k, shorter.body("x1").shape)[5], 6);

  const solid = await build([...blockDoc(), feature("m1", "move-boundary", { edges: [edge("e1", "edge(e1:end:r1|e1:side:r1)")], moveType: "extend", distance: 5 })]);
  assert.match(solid.status[2], /error: “Part 1” is a solid part/);
});

test("Mutual trim: two crossing surfaces cut along each other, one side of each kept", async () => {
  const cross = [sketch("s1", polyline([[-10, 0], [10, 0]], "l")), extrude("x1", "s1", { bodyType: "surface", depth: 10 }), sketch("s2", polyline([[0, -10], [0, 15]], "p")), extrude("x2", "s2", { bodyType: "surface", depth: 10 })];
  const t = (o) => feature("t1", "mutual-trim", { surfaces: ["x1", "x2"], flipFirst: false, flipSecond: false, merge: true, ...o });
  const m = await build([...cross, t({})]);
  ok(m);
  // one surface of two faces that share the edge where they crossed
  assert.deepEqual(m.engine.state.bodies.map((b) => [b.id, b.sheet, b.topo.faces.length, b.topo.edges.length]), [["x1", true, 2, 7]]);
  assert.deepEqual(names(m.body("x1")), ["x1:side:l1", "x2:side:p1"]);
  const kept = box(m.k, m.body("x1").shape);
  const other = await build([...cross, t({ flipFirst: true, flipSecond: true })]);
  ok(other);
  const flipped = box(other.k, other.body("x1").shape);
  // the two choices keep opposite halves of each
  assert.equal(kept[0] + flipped[0], -10); assert.equal(kept[3] + flipped[3], 10);
  assert.equal(Math.round((area(m.k, m.body("x1").shape) + area(other.k, other.body("x1").shape)) * 1e6) / 1e6, 200 + 250);
  const apart = await build([...cross, t({ merge: false })]);
  ok(apart);
  assert.deepEqual(apart.engine.state.bodies.map((b) => [b.id, b.name, b.topo.faces.length]), [["x1", "Surface 1", 1], ["x2", "Surface 2", 1]]);
  near(area(apart.k, apart.body("x1").shape), 100);

  const miss = await build([sketch("s1", polyline([[-10, 0], [10, 0]], "l")), extrude("x1", "s1", { bodyType: "surface" }), sketch("s2", polyline([[20, -10], [20, 10]], "p")), extrude("x2", "s2", { bodyType: "surface" }), t({})]);
  assert.match(miss.status[4], /error: The surfaces do not cross/);
  const part = await build([...blockDoc(), ...cross.map((f) => ({ ...f, id: f.id + "b", params: f.type === "extrude" ? { ...f.params, profile: { sketch: "s1b", regions: null } } : f.params })), feature("t1", "mutual-trim", { surfaces: ["e1", "x1b"], merge: true })]);
  assert.match(part.status[part.status.length - 1], /error: “Part 1” is a solid part/);
});

test("Constrained surface: one smooth surface through the points, within the tolerance", async () => {
  const m = await build([...blockDoc(),
    sketch("p", { a: pt(5, 5), b: pt(30, 8), c: pt(20, 15), d: pt(8, 16) }, { kind: "face", ref: face("e1", "e1:end:r1") }),
    feature("c1", "constrained-surface", { points: [{ kind: "vertex", body: "e1", name: "vertex(e1:side:r1|e1:side:r4|e1:start:r1)" }, { kind: "vertex", body: "e1", name: "vertex(e1:side:r1|e1:side:r2|e1:start:r1)" }], sketches: ["p"], tolerance: 0.01, margin: 0 }),
  ]);
  ok(m);
  const b = m.body("c1");
  assert.equal(b.sheet, true); assert.deepEqual(names(b), ["c1:surface"]);
  // it passes through every point: the four on the top face (z = 10) and the two corners at the bottom (z = 0)
  for (const p of [[5, 5, 10], [30, 8, 10], [20, 15, 10], [8, 16, 10], [0, 0, 0], [40, 0, 0]]) assert.ok(distTo(m, "c1", p) <= 0.01, `${p}: ${distTo(m, "c1", p)}`);
  assert.equal(m.k.faceFrame(b.topo.faces[0].shape), null, "not a plane");
  // three points: a plane
  const flat = await build([sketch("p", { a: pt(0, 0), b: pt(10, 0), c: pt(0, 10) }), feature("c1", "constrained-surface", { points: [], sketches: ["p"], tolerance: 0.01, margin: 2 })]);
  ok(flat); near(area(flat.k, flat.body("c1").shape), 14 * 14, 1e-6); assert.deepEqual(box(flat.k, flat.body("c1").shape), [-2, -2, 0, 12, 12, 0]);
  const few = await build([sketch("p", { a: pt(0, 0), b: pt(10, 0) }), feature("c1", "constrained-surface", { points: [], sketches: ["p"], tolerance: 0.01, margin: 0 })]);
  assert.match(few.status[1], /error: Pick three or more points/);
  const line = await build([sketch("p", { a: pt(0, 0), b: pt(10, 0), c: pt(20, 0) }), feature("c1", "constrained-surface", { points: [], sketches: ["p"], tolerance: 0.01, margin: 0 })]);
  assert.match(line.status[1], /error: The points lie on one line/);
});

test("surfaces through a rebuild, mass properties and STEP", async () => {
  const doc = (depth) => [
    sketch("s1", polyline([[0, 0], [20, 0], [20, 10]], "l")), extrude("x1", "s1", { bodyType: "surface", depth }),
    sketch("s2", rect(30, 0, 40, 10, "r")), extrude("e1", "s2"),
    feature("o1", "offset-surface", { faces: [face("x1", "x1:side:l1")], profile: null, distance: 2, flip: false }),
  ];
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  let r = await engine.regenerate(doc(5), 5);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok", "ok"]);
  const before = engine.state.bodies.map((b) => [b.id, b.name, !!b.sheet, b.topo.faces.map((f) => f.name), b.topo.edges.map((e) => e.name)]);
  // a deeper sheet: the same bodies, the same names, and the offset follows
  r = await engine.regenerate(doc(8), 5);
  assert.deepEqual(r.features.map((f) => f.status), ["ok", "ok", "ok", "ok", "ok"]);
  assert.deepEqual(engine.state.bodies.map((b) => [b.id, b.name, !!b.sheet, b.topo.faces.map((f) => f.name), b.topo.edges.map((e) => e.name)]), before);
  near(area(k, engine.state.bodies.find((b) => b.id === "o1").shape), 20 * 8);
  assert.deepEqual(r.bodies.map((b) => [b.id, !!b.sheet]), [["x1", true], ["e1", false], ["o1", true]]);

  // mass properties: a surface has an area and no volume
  const mass = await call(k, engine, "mass-properties", {});
  const sheet = mass.parts.find((p) => p.id === "x1");
  assert.equal(sheet.volume, 0); near(sheet.area, 30 * 8);
  near(mass.total.volume, 1000);

  // STEP: the surfaces are written beside the part and read back as shells
  const out = await call(k, engine, "export-step", { format: "step" });
  assert.equal(out.parts, 3);
  const text = Buffer.from(out.data).toString("latin1");
  assert.ok(/SHELL_BASED_SURFACE_MODEL|OPEN_SHELL/.test(text), "the sheets are open shells in the file");
  assert.ok(/MANIFOLD_SOLID_BREP/.test(text), "and the part is a solid");
  assert.ok(text.includes("Surface 1") && text.includes("Part 1"));
  const only = await call(k, engine, "export-step", { format: "step", bodies: ["x1"] });
  assert.ok(!/MANIFOLD_SOLID_BREP/.test(Buffer.from(only.data).toString("latin1")));
  engine.dispose();
});
