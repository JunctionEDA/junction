// Node test for a face of a part used as a profile (web/domains/mechanical/features/_profile.ts,
// kernel/ops/profile.ts): Extrude, Revolve and Sweep take flat faces beside or instead of a sketch; the dialog
// rules that put a clicked face into a profile field (ui/fields.ts); and what the AI tools accept (mcp/model.ts).
// The real OpenCascade build runs here.
// Run: node server/static/tests/cad-extrude-face.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

const K = load("domains/mechanical/kernel/index.ts");
const F = load("domains/mechanical/ui/fields.ts");
const P = load("domains/mechanical/features/_profile.ts");
const M = load("domains/mechanical/mcp/model.ts");
const D = load("domains/mechanical/document/format.ts");
const I = load("shared/itemdoc/itemdoc.ts");

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
const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [`${p}`]: { type: "circle", center: `${p}c`, r } });
const line = (x0, y0, x1, y1, p) => ({ [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y1 }, [`${p}`]: { type: "line", a: `${p}1`, b: `${p}2` } });
const top = { kind: "plane", plane: "top" }, front = { kind: "plane", plane: "front" };
const feature = (id, type, params) => ({ id, type, name: id, suppressed: false, params });
const sketch = (id, entities, plane = top) => feature(id, "sketch", { plane, sketch: { version: 1, entities, constraints: {} } });
const face = (body, name) => ({ kind: "face", body, name });
const faces = (...refs) => ({ sketch: null, regions: null, faces: refs });
const extrude = (id, profile, o = {}) => feature(id, "extrude", { profile: typeof profile === "string" ? { sketch: profile, regions: null } : profile, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o });

/** A 40 × 20 × 10 block: sides e:side:pa (y = 0), pb (x = 40), pc (y = 20), pd (x = 0); e:start:pa below, e:end:pa on top. */
const block = (depth = 10) => [sketch("s", rect(0, 0, 40, 20, "p")), extrude("e", "s", { depth })];
const TOP = face("e", "e:end:pa"), RIGHT = face("e", "e:side:pb");
const holed = () => [...block(), sketch("s2", circle(10, 10, 4, "h")), extrude("cut", "s2", { operation: "remove", depth: 10 })];
const BLOCK = 40 * 20 * 10;

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));
const failed = (r, id, re) => { const f = r.features.find((x) => x.id === id); assert.equal(f.status, "error", statuses(r).join("\n")); assert.match(f.message, re); };
const vol = (k, e, i = 0) => k.volume(e.state.bodies[i].shape);
const bboxOf = (r, i = 0) => r.bodies[i].mesh.bbox.map((v) => Math.round(v * 1e4) / 1e4);
const faceNames = (e, i = 0) => e.state.bodies[i].topo.faces.map((f) => f.name).sort();

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r };
}

// ---------------------------------------------------------------- the kernel

test("a top face extruded, added: the block grows along the face's normal", async () => {
  const { k, engine, r } = await run([...block(), extrude("up", faces(TOP), { operation: "add", depth: 5 })]);
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 40 * 20 * 15);
  assert.deepEqual(bboxOf(r), [0, 0, 0, 40, 20, 15]);
  // the new end is named from the face, as a sketch region's cap is from the region
  const id = P.faceRegionId(TOP);
  assert.ok(faceNames(engine).includes(`up:end:${id}`), faceNames(engine).join(" "));
  assert.match(id, /^face\.[0-9a-z]+$/);
  engine.dispose();
});

test("a side face extruded, removed: it goes into the solid; Opposite direction turns it round", async () => {
  const cut = await run([...block(), extrude("in", faces(RIGHT), { operation: "remove", depth: 3 })]);
  allOk(cut.r);
  near(vol(cut.k, cut.engine), BLOCK - 20 * 10 * 3);
  assert.deepEqual(bboxOf(cut.r), [0, 0, 0, 37, 20, 10]);
  cut.engine.dispose();
  // turned round it is outside the block and removes nothing, which the feature says
  const out = await run([...block(), extrude("in", faces(RIGHT), { operation: "remove", depth: 3, flip: true })]);
  assert.equal(out.r.features[2].status, "warning", statuses(out.r).join("\n"));
  near(vol(out.k, out.engine), BLOCK);
  out.engine.dispose();
});

test("New makes a body on the face; Intersect keeps what lies under it", async () => {
  const fresh = await run([...block(), extrude("n", faces(TOP), { depth: 4 })]);
  allOk(fresh.r);
  assert.equal(fresh.r.bodies.length, 2);
  near(vol(fresh.k, fresh.engine, 1), 40 * 20 * 4);
  assert.deepEqual(bboxOf(fresh.r, 1), [0, 0, 10, 40, 20, 14]);
  fresh.engine.dispose();
  const keep = await run([...block(), extrude("i", faces(TOP), { operation: "intersect", depth: 4 })]);
  allOk(keep.r);
  near(vol(keep.k, keep.engine), 40 * 20 * 4);
  assert.deepEqual(bboxOf(keep.r), [0, 0, 6, 40, 20, 10]);
  keep.engine.dispose();
});

test("the reference is a name: the extrusion follows the face when the block changes upstream", async () => {
  const { k, engine, r } = await run([...block(20), extrude("up", faces(TOP), { operation: "add", depth: 5 })]);
  allOk(r);
  near(vol(k, engine), 40 * 20 * 25);
  assert.deepEqual(bboxOf(r), [0, 0, 0, 40, 20, 25]);
  engine.dispose();
});

test("a face is taken with its holes, and several faces each go their own way", async () => {
  const one = await run([...holed(), extrude("up", faces(TOP), { operation: "add", depth: 5 })]);
  allOk(one.r);
  near(vol(one.k, one.engine), (800 - Math.PI * 16) * 15, 1e-4);
  one.engine.dispose();
  const two = await run([...block(), extrude("both", faces(TOP, RIGHT), { operation: "add", depth: 5 })]);
  allOk(two.r);
  assert.equal(two.r.bodies.length, 1);
  near(vol(two.k, two.engine), BLOCK + 800 * 5 + 200 * 5);
  assert.deepEqual(bboxOf(two.r), [0, 0, 0, 45, 20, 15]);
  two.engine.dispose();
});

test("a sketch's regions and a face in one extrude", async () => {
  const boss = sketch("s3", circle(30, 10, 4, "b"), { kind: "face", ref: TOP });
  const { k, engine, r } = await run([...block(), boss, extrude("mix", { sketch: "s3", regions: null, faces: [RIGHT] }, { operation: "add", depth: 5 })]);
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), BLOCK + Math.PI * 16 * 5 + 200 * 5, 1e-4);
  const names = faceNames(engine);
  assert.ok(names.includes("mix:side:b") && names.some((n) => n.startsWith(`mix:end:${P.faceRegionId(RIGHT)}`)), names.join(" "));
  engine.dispose();
});

test("the end conditions and options are a sketch's: symmetric, up to face, draft, thin wall, a second direction", async () => {
  const sym = await run([...block(), extrude("m", faces(RIGHT), { endType: "symmetric", depth: 6 })]);
  allOk(sym.r);
  assert.deepEqual(bboxOf(sym.r, 1), [37, 0, 0, 43, 20, 10]);
  sym.engine.dispose();
  // a second block 20 above the first: the top face goes up to its underside
  const far = [sketch("pl", rect(0, 0, 40, 20, "q")), feature("off", "plane", { method: "offset", ref: top, distance: 30 })];
  const upTo = await run([...block(), ...far, sketch("s9", rect(0, 0, 40, 20, "r"), { kind: "datum", feature: "off" }), extrude("lid", "s9", { depth: 5 }),
    extrude("fill", faces(TOP), { operation: "add", endType: "upToFace", face: face("lid", "lid:start:ra") })]);
  allOk(upTo.r);
  assert.equal(upTo.r.bodies.length, 1, "the fill joins the block and the lid");
  near(vol(upTo.k, upTo.engine), 800 * 35, 1e-6);
  upTo.engine.dispose();
  const draft = await run([...block(), extrude("d", faces(TOP), { operation: "add", depth: 5, draft: true, draftAngle: 10 })]);
  allOk(draft.r);
  const v = vol(draft.k, draft.engine);
  assert.ok(v > BLOCK + 2000 && v < BLOCK + 4000 - 1, `drafted: ${v}`);
  draft.engine.dispose();
  const thin = await run([...block(), extrude("t", faces(TOP), { operation: "add", depth: 5, thin: true, thickness: 2, thinSide: "inside" })]);
  allOk(thin.r);
  near(vol(thin.k, thin.engine), BLOCK + (800 - 36 * 16) * 5, 1e-6);
  thin.engine.dispose();
  const second = await run([...block(), extrude("s2d", faces(TOP), { depth: 5, second: true, secondType: "blind", secondDepth: 2 })]);
  allOk(second.r);
  assert.deepEqual(bboxOf(second.r, 1), [0, 0, 8, 40, 20, 15]);
  second.engine.dispose();
});

test("what cannot be a profile says so: a curved face, a face that is gone, nothing at all", async () => {
  const curved = await run([...holed(), extrude("x", faces(face("e", "cut:side:h")), { operation: "add", depth: 5 })]);
  failed(curved.r, "x", /must be flat/);
  curved.engine.dispose();
  const gone = await run([...block(), extrude("x", faces(face("e", "e:end:nothing")), { depth: 5 })]);
  failed(gone.r, "x", /no longer exists/);
  gone.engine.dispose();
  const none = await run([...block(), extrude("x", null, { depth: 5 })]);
  failed(none.r, "x", /Pick a sketch or a flat face to extrude/);
  none.engine.dispose();
  // a sketch-only profile is what it was
  const plain = await run([...block(), sketch("s3", circle(30, 10, 4, "b"), { kind: "face", ref: TOP }), extrude("boss", "s3", { operation: "add", depth: 5 })]);
  allOk(plain.r);
  near(vol(plain.k, plain.engine), BLOCK + Math.PI * 16 * 5, 1e-4);
  plain.engine.dispose();
});

test("Extrude as a surface: the edges round the face, pulled along its normal", async () => {
  const { engine, r } = await run([...block(), extrude("w", faces(TOP), { bodyType: "surface", depth: 5 })]);
  allOk(r);
  assert.equal(r.bodies.length, 2);
  assert.ok(r.bodies[1].sheet, "a surface body");
  assert.equal(engine.state.bodies[1].topo.faces.length, 4);
  assert.deepEqual(bboxOf(r, 1), [0, 0, 10, 40, 20, 15]);
  engine.dispose();
});

test("Revolve takes a face: turned about one of its own edges", async () => {
  const axis = { kind: "edge", body: "e", name: `edge(${[RIGHT.name, TOP.name].sort().join("|")})` };
  const params = { profile: faces(RIGHT), operation: "new", axisType: "edge", axisEdge: axis, endType: "full", angle: 180, flip: false, targets: [] };
  const full = await run([...block(), feature("rv", "revolve", params)]);
  allOk(full.r);
  near(vol(full.k, full.engine, 1), Math.PI * 100 * 20, 1e-4);
  full.engine.dispose();
  // a quarter turn, added: it leaves the face outwards and joins the block
  const part = await run([...block(), feature("rv", "revolve", { ...params, operation: "add", endType: "angle", angle: 90 })]);
  allOk(part.r);
  assert.equal(part.r.bodies.length, 1);
  near(vol(part.k, part.engine), BLOCK + (Math.PI * 100 * 20) / 4, 1e-4);
  part.engine.dispose();
  // removed, it turns into the block instead
  const cut = await run([...block(), feature("rv", "revolve", { ...params, operation: "remove", endType: "angle", angle: 90 })]);
  allOk(cut.r);
  near(vol(cut.k, cut.engine), BLOCK - (Math.PI * 100 * 20) / 4, 1e-4);
  cut.engine.dispose();
  // a face has no sketch line: the feature says to pick an axis
  const noAxis = await run([...block(), feature("rv", "revolve", { ...params, axisType: "line", axisEdge: null })]);
  failed(noAxis.r, "rv", /no sketch line/);
  noAxis.engine.dispose();
  // an axis through the middle of the face is refused, as for a sketch
  const cross = await run([...block(), feature("rv", "revolve", { ...params, axisEdge: { kind: "edge", body: "e", name: `edge(${["e:side:pa", TOP.name].sort().join("|")})` } })]);
  assert.equal(cross.r.features[2].status, "error", statuses(cross.r).join("\n"));
  cross.engine.dispose();
});

test("Sweep takes a face: carried along a path", async () => {
  // a path straight up from the top face, drawn on the front plane (x → X, y → Z)
  const path = sketch("path", line(20, 10, 20, 30, "l"), front);
  const { k, engine, r } = await run([...block(), path, feature("sw", "sweep", { profile: faces(TOP), path: [{ kind: "sketch", feature: "path", entity: "l" }], corners: "round", operation: "add", targets: [] })]);
  allOk(r);
  assert.equal(r.bodies.length, 1);
  near(vol(k, engine), 800 * 30, 1e-6);
  engine.dispose();
});

// ---------------------------------------------------------------- the dialog's rules

const PROFILE = { key: "profile", label: "Sketch or faces", kind: "profile", faces: true };
const SKETCH_ONLY = { key: "profile", label: "Sketch", kind: "profile" };
const UPTO = { key: "face", label: "Up to", kind: "refs", of: ["face"], single: true };
const pick = (name, body = "b1") => ({ kind: "face", body, name });
const region = (id, sk = "sk1") => ({ kind: "sketch", featureId: sk, entity: null, region: id });

test("a profile field that takes faces: clicks add faces, a click on one it holds takes it out", () => {
  assert.deepEqual(F.pickKindsFor(PROFILE), ["sketch", "face"]);
  assert.deepEqual(F.pickKindsFor(SKETCH_ONLY), ["sketch"]);
  let v = F.valueAfterPick(PROFILE, null, pick("f1"));
  assert.deepEqual(v, { sketch: null, regions: null, faces: [{ kind: "face", body: "b1", name: "f1" }] });
  v = F.valueAfterPick(PROFILE, v, pick("f2"));
  assert.deepEqual(v.faces.map((f) => f.name), ["f1", "f2"]);
  assert.equal(F.valueAfterPick(PROFILE, v, pick("f1"), { addOnly: true }), undefined, "a box never takes out");
  v = F.valueAfterPick(PROFILE, v, pick("f1"));
  assert.deepEqual(v.faces.map((f) => f.name), ["f2"]);
  assert.equal(F.valueAfterPick(PROFILE, v, pick("f2")), null, "the last one out leaves nothing");
  assert.equal(F.valueAfterPick(PROFILE, null, { kind: "edge", body: "b1", name: "e1" }), undefined);
  // a field that does not say `faces` is a sketch's alone
  assert.equal(F.valueAfterPick(SKETCH_ONLY, null, pick("f1")), undefined);
  assert.ok(F.isEmpty(PROFILE, null) && F.isEmpty(PROFILE, { sketch: null, regions: null }) && !F.isEmpty(PROFILE, v) && !F.isEmpty(PROFILE, { sketch: "sk1", regions: null }));
});

test("a sketch and faces in one profile: each click changes its own part", () => {
  let v = F.valueAfterPick(PROFILE, null, region("r1"));
  assert.deepEqual(v, { sketch: "sk1", regions: null }, "a sketch alone is stored as it always was");
  v = F.valueAfterPick(PROFILE, v, pick("f1"));
  assert.deepEqual(v, { sketch: "sk1", regions: null, faces: [{ kind: "face", body: "b1", name: "f1" }] });
  v = F.valueAfterPick(PROFILE, v, region("r1"));
  assert.deepEqual([v.sketch, v.regions, v.faces.length], ["sk1", ["r1"], 1], "choosing a region keeps the face");
  v = F.valueAfterPick(PROFILE, v, pick("f1"));
  assert.deepEqual(v, { sketch: "sk1", regions: ["r1"] }, "taking the face out keeps the regions");
  v = F.valueAfterPick(PROFILE, F.valueAfterPick(PROFILE, v, pick("f3")), region("r9", "sk2"));
  assert.deepEqual([v.sketch, v.regions, v.faces.length], ["sk2", null, 1], "another sketch replaces the sketch, not the faces");
});

test("faces selected before the tool is started are the profile; what a field holds is listed and marked", () => {
  const got = F.fillFromSelection([PROFILE, UPTO], {}, [pick("f1"), pick("f2")]);
  assert.deepEqual(got.profile.faces.map((f) => f.name), ["f1", "f2"], "every selected face, not only the first");
  assert.equal(got.face, undefined);
  // a face the profile turns away (not flat) goes to the next field that takes it
  const flat = F.fillFromSelection([PROFILE, UPTO], {}, [pick("round"), pick("f2")], (field, p) => !(field.kind === "profile" && p.name === "round"));
  assert.deepEqual(flat.profile.faces.map((f) => f.name), ["f2"]);
  assert.equal(flat.face.name, "round");
  // a sketch is one pick, as before; a face selected with it goes on to the next field
  const sk = F.fillFromSelection([SKETCH_ONLY, UPTO], {}, [pick("f1"), region("r1")]);
  assert.deepEqual(sk.profile, { sketch: "sk1", regions: null });
  assert.equal(sk.face.name, "f1");
  const names = { feature: () => "Sketch 1", body: () => "Part 1" };
  const items = F.heldItems(PROFILE, got.profile, names);
  assert.deepEqual(items.map((i) => [i.label, i.pick.name]), [["Face 1 of Part 1", "f1"], ["Face 2 of Part 1", "f2"]]);
  assert.deepEqual(F.heldItems(SKETCH_ONLY, { sketch: "sk1", regions: null }, names), []);
  const held = F.heldPicks([PROFILE, UPTO], { profile: got.profile }, "profile", names);
  assert.deepEqual(held.active.map((p) => p.name), ["f1", "f2"]);
  assert.equal(F.nextEmptyField([PROFILE, UPTO], { profile: got.profile }), "face");
  assert.equal(F.nextEmptyField([PROFILE, UPTO], { profile: { sketch: null, regions: null, faces: [] } }), "profile");
});

test("the stored shape: helpers read it whatever it holds, and a face's region id follows from its reference", () => {
  assert.deepEqual(P.profileFaces({ sketch: "s", regions: null }), []);
  assert.deepEqual(P.profileFaces({ sketch: null, faces: [pick("f1"), { kind: "edge", body: "b", name: "e" }, null] }).map((f) => f.name), ["f1"]);
  assert.equal(P.profileSketch({ sketch: "", faces: [] }), null);
  assert.ok(P.profileEmpty(null) && P.profileEmpty({}) && !P.profileEmpty({ sketch: "s" }));
  assert.equal(P.makeProfile(null, null, []), null);
  assert.deepEqual(P.makeProfile("s", [], []), { sketch: "s", regions: null });
  assert.equal(P.faceRegionId(pick("f1")), P.faceRegionId({ body: "b1", name: "f1" }));
  assert.notEqual(P.faceRegionId(pick("f1")), P.faceRegionId(pick("f1", "b2")));
  assert.notEqual(P.faceRegionId(pick("f1")), P.faceRegionId(pick("f2")));
});

// ---------------------------------------------------------------- the AI tools

test("cad_edit_features: a profile of faces is accepted where the feature takes faces, and built", async () => {
  const emptyDoc = () => I.parseItemDoc(D.newPartStudioText(), "part-studio");
  const doc = emptyDoc();
  I.applyChanges(doc, M.planEdits(doc, K.FEATURES, [
    { op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 40, y2: 20 }] },
    { op: "add", type: "extrude", ref: "e", params: { profile: "$s", depth: 10 } },
  ]).changes);
  const base = D.featuresOf(doc), eid = base[1].id;
  const k = await boot();
  const first = new K.RegenEngine(k, K.FEATURES);
  await first.regenerate(D.featureInputs(base), base.length);
  const topName = first.state.bodies[0].topo.faces.map((f) => f.name).find((n) => n.startsWith(`${eid}:end:`));
  first.dispose();
  const ref = { kind: "face", body: eid, name: topName };

  const types = M.featureTypes(K.FEATURES).feature_types;
  const stores = (type) => types.find((t) => t.type === type).parameters.find((p) => p.key === "profile").stores;
  assert.match(stores("extrude"), /faces: \[\{ kind: "face", body, name \}\]/);
  assert.match(stores("revolve"), /faces/);
  assert.doesNotMatch(stores("wrap"), /faces/);

  // the full form, a bare face reference, and a list of them all mean the same
  for (const profile of [{ sketch: null, faces: [ref] }, ref, [ref]]) {
    const plan = M.planEdits(doc, K.FEATURES, [{ op: "add", type: "extrude", params: { profile, operation: "add", depth: 5 } }]);
    assert.deepEqual(plan.problems, []);
    const after = D.featuresOf(plan.after);
    assert.deepEqual(after[2].params.profile.faces, [ref]);
    assert.equal(after[2].params.profile.sketch, null);
    const engine = new K.RegenEngine(k, K.FEATURES);
    const r = await engine.regenerate(D.featureInputs(after), after.length);
    allOk(r);
    near(k.volume(engine.state.bodies[0].shape), 40 * 20 * 15);
    engine.dispose();
  }
  // a sketch beside faces keeps both
  const both = M.planEdits(doc, K.FEATURES, [{ op: "add", type: "extrude", params: { profile: { sketch: base[0].name, faces: [ref] }, depth: 5 } }]);
  assert.deepEqual(both.problems, []);
  assert.deepEqual(D.featuresOf(both.after)[2].params.profile, { sketch: base[0].id, regions: null, faces: [ref] });

  const bad = (profile, type = "extrude") => M.planEdits(doc, K.FEATURES, [{ op: "add", type, params: { profile } }]).problems.join(" ");
  assert.match(bad({ sketch: null, faces: [{ kind: "edge", body: eid, name: "x" }] }), /faces must be a list of \{ kind: "face", body, name \}/);
  assert.match(bad({ sketch: null, faces: [] }), /sketch must be the id of a sketch feature, or give flat faces/);
  assert.match(bad({ sketch: null, faces: [ref] }, "wrap"), /takes a sketch only/);
  assert.match(bad({ sketch: "nothing" }, "wrap"), /must be the id of a sketch feature/);
});
