// Node test for the families of Mechanical CAD tools an AI assistant has over MCP (web/domains/mechanical/mcp and
// web/domains/assembly/mcp), driven below the network: the feature catalogue asked in steps, sketch shapes with
// their constraints solved by the real solver, references picked by description on bodies the real kernel built,
// a batch that picks geometry it made itself, variables, parts and materials, the text description and the thin
// wall estimate, the picture (several views, a section, a highlight), and an assembly inserted, mated, driven and
// reported by the editor's own solver.  Error paths are checked beside each: what a model is told must say what
// to do next.
// Run: node server/static/tests/cad-mcp-tools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

const M = load("domains/mechanical/mcp/model.ts");
const C = load("domains/mechanical/mcp/catalog.ts");
const S = load("domains/mechanical/mcp/select.ts");
const SK = load("domains/mechanical/mcp/sketch.ts");
const D = load("domains/mechanical/mcp/describe.ts");
const R = load("domains/mechanical/mcp/render.ts");
const REF = load("domains/mechanical/mcp/reference.ts");
const K = load("domains/mechanical/kernel/index.ts");
const F = load("domains/mechanical/document/format.ts");
const IN = load("domains/mechanical/document/inputs.ts");
const MAT = load("domains/mechanical/document/mass-materials.ts");
const I = load("shared/itemdoc/itemdoc.ts");
const SOLVER = require("./sketch-load").load("domains/mechanical/sketch/solver/load.ts");
const A = load("domains/assembly/mcp/model.ts");
const AF = load("domains/assembly/document/format.ts");
const MATES = load("domains/assembly/generated/mates.ts").MATES;

const emptyDoc = () => I.parseItemDoc(F.newPartStudioText(), "part-studio");
const apply = (doc, plan) => { I.applyChanges(doc, plan.changes); return doc; };

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}
/** Build a part studio as the host does: variables applied; the bodies as the edits may name them. */
async function build(doc) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const input = IN.studioInputs(doc);
  const result = await engine.regenerate(input.features, input.rollback);
  const bodies = engine.state.bodies.map((b) => ({ id: b.id, name: b.name, createdBy: b.createdBy, mesh: result.bodies.find((r) => r.id === b.id).mesh }));
  const features = F.featuresOf(doc);
  return { k, engine, result, bodies, failed: result.features.filter((r) => r.status === "error").map((r) => ({ name: features.find((f) => f.id === r.id).name, message: r.message || "" })) };
}
const staged = (doc, edits, o = {}) => M.planStaged(doc, K.FEATURES, edits, o, async (d) => { const b = await build(d); return { bodies: b.bodies, failed: b.failed }; });

// a 60 x 40 x 20 block with a 6 mm hole through it, standing on the top plane
const BLOCK = [
  { op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 60, y2: 40 }, { type: "circle", cx: 15, cy: 20, r: 3 }] },
  { op: "add", type: "extrude", ref: "b", name: "Block", params: { profile: "$s", depth: 20 } },
];

// ---------------------------------------------------------------- discovery

test("the catalogue is asked in steps: families, a search, one type in full", () => {
  const all = C.featureCatalog(K.FEATURES).result;
  assert.ok(all.feature_types.length < 45, `the first answer lists the everyday types only (${all.feature_types.length})`);
  assert.ok(JSON.stringify(all).length < 16000, `…and is small (${JSON.stringify(all).length} characters)`);
  assert.deepEqual(Object.keys(all.feature_types[0]), ["type", "title", "family", "about"]);
  assert.ok(all.feature_types.some((f) => f.type === "extrude") && !all.feature_types.some((f) => f.type.startsWith("cf-")));
  // every registered type is named under its family
  const named = all.families.flatMap((f) => f.types.split(" "));
  assert.deepEqual(named.slice().sort(), K.FEATURES.map((f) => f.type).sort());
  assert.equal(all.families.reduce((n, f) => n + f.count, 0), K.FEATURES.length);

  const gears = C.featureCatalog(K.FEATURES, { query: "gears" }).result;
  assert.ok(gears.feature_types.length >= 5 && gears.feature_types.length < 30);
  assert.ok(gears.feature_types.some((f) => f.type === "cf-spur-gear"), "a plural finds the singular");
  assert.equal(gears.feature_types[0].family, "Gears");
  const family = C.featureCatalog(K.FEATURES, { family: "sheetmetal" }).result;
  assert.ok(family.feature_types.length >= 5 && family.feature_types.every((f) => f.family === "sheetmetal"));
  const paged = C.featureCatalog(K.FEATURES, { family: "Power transmission", limit: 5 }).result;
  assert.equal(paged.feature_types.length, 5); assert.equal(paged.next_offset, 5);
  assert.equal(C.featureCatalog(K.FEATURES, { family: "Power transmission", limit: 5, offset: 5 }).result.feature_types[0].type !== paged.feature_types[0].type, true);

  const one = C.featureCatalog(K.FEATURES, { type: "extrude" }).result.feature_types;
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].defaults, K.FEATURES.find((f) => f.type === "extrude").defaults());
  assert.ok(one[0].parameters.find((p) => p.key === "depth").stores.includes("millimetres"));
  assert.ok(Array.isArray(one[0].example) && one[0].example.some((e) => e.type === "extrude"));
  // a type that has no hand-written example still gets an edit that names what it needs
  const gear = C.featureCatalog(K.FEATURES, { type: "cf-spur-gear" }).result.feature_types[0];
  assert.equal(gear.example[0].op, "add"); assert.ok(gear.about.length > 10);
});

test("the catalogue says what to do when nothing is found", () => {
  assert.match(C.featureCatalog(K.FEATURES, { type: "lathe" }).error, /no feature type "lathe"/);
  assert.match(C.featureCatalog(K.FEATURES, { type: "extrud" }).error, /Did you mean: .*extrude/);
  assert.match(C.featureCatalog(K.FEATURES, { family: "magic" }).error, /The families are: .*solid/);
  const none = C.featureCatalog(K.FEATURES, { query: "zzzz" }).result;
  assert.equal(none.count, 0); assert.match(none.note, /Try one word/);
  // the text for the resource names every type once
  const text = C.catalogText(K.FEATURES);
  for (const d of K.FEATURES) assert.ok(text.includes(`- ${d.type}: `), d.type);
});

test("every hand-written example of the catalogue plans and builds", async () => {
  const full = emptyDoc();
  apply(full, await staged(full, C.featureCatalog(K.FEATURES, { type: "extrude" }).result.feature_types[0].example));
  const base = await build(full);
  assert.deepEqual(base.failed, []);
  assert.deepEqual(F.featuresOf(full).map((f) => f.name), ["Sketch 1", "Extrude 1", "Sketch 2", "Pocket"]);
  // the plain block, for what would not go round the pocket
  const plain = I.parseItemDoc(I.serializeItemDoc(full), "part-studio");
  apply(plain, M.planEdits(plain, K.FEATURES, [{ op: "delete", feature: "Pocket" }, { op: "delete", feature: "Sketch 2" }]));
  for (const type of ["fillet", "chamfer", "shell", "hole", "mirror", "linear-pattern", "transform", "plane", "boolean", "revolve", "sketch"]) {
    const example = C.featureCatalog(K.FEATURES, { type }).result.feature_types[0].example;
    const doc = type === "shell" ? plain : full;
    // the boolean example needs a second body: give it one
    const before = type === "boolean" ? [{ op: "add", type: "sketch", ref: "t", plane: "top", shapes: [{ type: "circle", cx: 5, cy: 5, r: 2 }] }, { op: "add", type: "extrude", name: "Extrude 2", params: { profile: "$t", depth: 30 } }] : [];
    const plan = await staged(doc, [...before, ...example]);
    assert.deepEqual(plan.problems, [], `${type}: ${plan.problems.join("; ")}`);
    const built = await build(plan.after);
    assert.deepEqual(built.failed, [], `${type}: ${JSON.stringify(built.failed)}`);
  }
});

test("the reference pages exist, are short, and another domain can add one", () => {
  const topics = REF.referenceTopics().map((t) => t.topic);
  for (const t of ["guide", "sketch", "references", "variables"]) { assert.ok(topics.includes(t)); const text = REF.reference(t); assert.ok(text.length > 400 && text.length < 6000, `${t} is ${text.length} characters`); }
  assert.match(REF.reference("guide"), /cad_edit_features/); assert.match(REF.reference("references"), /of_face/);
  assert.equal(REF.reference("nope"), null);
  REF.addReference("mates", "Mates", () => "about mates");
  assert.equal(REF.reference("Mates"), "about mates");
});

// ---------------------------------------------------------------- sketches

test("sketch shapes: slot, rounded and centre rectangles, arcs, paths and points, with their ids", () => {
  const made = M.shapesToEntities([
    { type: "slot", x1: 0, y1: 0, x2: 20, y2: 0, width: 6 },
    { type: "center_rectangle", cx: 0, cy: 30, width: 10, height: 4 },
    { type: "rounded_rectangle", x1: 40, y1: 0, x2: 70, y2: 20, radius: 4 },
    { type: "arc", cx: 0, cy: 60, r: 5, start: 0, end: 90 },
    { type: "polyline", points: [[0, 80], [10, 80], [10, 90]] },
    { type: "point", x: 5, y: 5 },
    { type: "line", x1: -5, y1: -5, x2: 5, y2: -5, construction: true },
  ]);
  assert.deepEqual(made.problems, []);
  assert.deepEqual(made.shapes.map((s) => [s.type, s.points.length, s.curves.length]), [["slot", 6, 4], ["center_rectangle", 4, 4], ["rounded_rectangle", 12, 8], ["arc", 3, 1], ["polyline", 3, 2], ["point", 1, 0], ["line", 2, 1]]);
  const e = made.entities;
  assert.equal(e[made.shapes[6].curves[0]].construction, true);
  // the slot is two lines and two arcs that close into one region; so are the rectangles; the open path is none
  const data = { version: 1, entities: e, constraints: {} };
  const r = SK.sketchReport(data).report;
  assert.equal(r.regions, 3); assert.ok(r.open_curves >= 3, `the arc and the path are open (${r.open_curves})`);
  const arc = e[made.shapes[3].curves[0]];
  assert.deepEqual([e[arc.start].x, e[arc.start].y], [5, 60]);
  assert.ok(Math.abs(e[arc.end].x) < 1e-9 && Math.abs(e[arc.end].y - 65) < 1e-9);
});

test("sketch shapes are refused with what they need", () => {
  const bad = M.shapesToEntities([{ type: "slot", x1: 0, y1: 0, x2: 0, y2: 0, width: 2 }, { type: "rounded_rectangle", x1: 0, y1: 0, x2: 10, y2: 10, radius: 6 }, { type: "blob" }, { type: "arc", cx: 0, cy: 0, r: 0, start: 0, end: 90 }]);
  assert.equal(bad.problems.length, 4);
  assert.match(bad.problems[0], /same point; draw a circle/); assert.match(bad.problems[1], /less than half the shorter side \(5\)/);
  assert.match(bad.problems[2], /unknown shape type "blob" \(rectangle, center_rectangle/); assert.match(bad.problems[3], /radius r above zero/);
});

test("define: true holds the shapes as drawn; the solver finds the sketch fully defined", async () => {
  const solver = await SOLVER.loadSolver();
  const doc = emptyDoc();
  const plan = M.planEdits(doc, K.FEATURES, [{ op: "add", type: "sketch", name: "Plate", plane: "top", define: true, shapes: [{ type: "rectangle", x1: -10, y1: 5, x2: 30, y2: 25 }, { type: "circle", cx: 0, cy: 0, r: 2.5 }, { type: "slot", x1: 5, y1: 15, x2: 20, y2: 15, width: 4 }] }], { solver });
  assert.deepEqual(plan.problems, []);
  const report = plan.sketches.Plate;
  assert.equal(report.fully_defined, true, JSON.stringify(report)); assert.equal(report.freedoms, 0);
  assert.equal(report.regions, 2, "the plate with the slot as a hole in it, and the circle beside it");
  assert.deepEqual(report.shapes.slice(0, 2), ["rectangle: p1 p2 p3 p4 | l1 l2 l3 l4", "circle: p5 | c1"]);
  assert.match(report.shapes[2], /^slot: p6 p7 p8 p9 p10 p11 \| l5 a1 l6 a2$/);
  const sketch = plan.changes[0].item.params.sketch;
  const dims = Object.values(sketch.constraints).filter((c) => c.value !== undefined).map((c) => [c.type, c.value]);
  assert.ok(dims.some(([t, v]) => t === "distance" && v === 40) && dims.some(([t, v]) => t === "distance" && v === 20), JSON.stringify(dims));
  assert.ok(dims.some(([t, v]) => t === "diameter" && v === 5));
  // the stored coordinates are the drawn ones: the solver had nothing to move
  assert.deepEqual([sketch.entities.p1.x, sketch.entities.p1.y, sketch.entities.p3.x, sketch.entities.p3.y], [-10, 5, 30, 25]);
  // without define the same shapes are free, and the report says so when asked with a solver
  const free = SK.sketchReport({ version: 1, entities: sketch.entities, constraints: {} }, solver).report;
  assert.ok(free.freedoms > 0 && free.fully_defined === false);
});

test("constraints by hand are solved, and a conflict changes nothing and names itself", async () => {
  const solver = await SOLVER.loadSolver();
  const doc = emptyDoc();
  apply(doc, M.planEdits(doc, K.FEATURES, [{ op: "set_variable", name: "width", value: 50 }]));
  const plan = M.planEdits(doc, K.FEATURES, [{ op: "add", type: "sketch", name: "S", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 40, y2: 20 }],
    constraints: [{ type: "horizontal", refs: ["l1"] }, { type: "vertical", refs: ["l2"] }, { type: "horizontal", refs: ["l3"] }, { type: "vertical", refs: ["l4"] }, { type: "coincident", refs: ["p1", "$origin"] }, { type: "distance", refs: ["l1"], value: "width" }, { type: "distance", refs: ["l2"], value: 20 }] }], { solver });
  assert.deepEqual(plan.problems, []);
  const sk = plan.changes[0].item.params.sketch;
  assert.ok(Math.abs(sk.entities.p2.x - 50) < 1e-6, `the dimension moved the corner to the variable's value (${sk.entities.p2.x})`);
  assert.equal(Object.values(sk.constraints).find((c) => c.expr).expr, "width");
  assert.equal(plan.sketches.S.fully_defined, true);
  const clash = M.planEdits(doc, K.FEATURES, [{ op: "add", type: "sketch", shapes: [{ type: "line", x1: 0, y1: 0, x2: 10, y2: 0 }], constraints: [{ type: "distance", refs: ["l1"], value: 10 }, { type: "distance", refs: ["l1"], value: 25 }] }], { solver });
  assert.equal(clash.changes.length, 0);
  assert.match(clash.problems[0], /constraints cannot all hold \(.*d\d.*conflict\)\. Nothing was changed/);
  const wrong = M.planEdits(doc, K.FEATURES, [{ op: "add", type: "sketch", shapes: [{ type: "circle", cx: 0, cy: 0, r: 2 }], constraints: [{ type: "glue", refs: ["c1"] }, { type: "radius", refs: ["c9"], value: 2 }, { type: "radius", refs: ["c1"] }, { type: "radius", refs: ["c1"], value: "nope * 2" }] }], { solver });
  assert.match(wrong.problems[0], /unknown constraint type "glue" \(coincident, horizontal/);
  assert.match(wrong.problems[1], /no entity "c9" in the sketch\. Its entities are: p1, c1/);
  assert.match(wrong.problems[2], /a radius needs a value/); assert.match(wrong.problems[3], /"nope \* 2" has no value/);
  // define without shapes says what it wants
  assert.match(M.planEdits(doc, K.FEATURES, [{ op: "add", type: "sketch", define: true }], { solver }).problems[0], /give shapes too/);
});

test("an open outline is flagged before the extrude fails on it", () => {
  const plan = M.planEdits(emptyDoc(), K.FEATURES, [{ op: "add", type: "sketch", name: "Open", shapes: [{ type: "polyline", points: [[0, 0], [10, 0], [10, 10]] }] }]);
  assert.equal(plan.sketches.Open.regions, 0);
  assert.match(plan.sketches.Open.note, /encloses no region.*Close the outline/);
});

// ---------------------------------------------------------------- references by description

test("faces and edges say what they are, and are picked by description", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const { bodies } = await build(doc);
  const mesh = bodies[0].mesh;
  const faces = S.summarise(mesh, "face");
  assert.equal(faces.length, 7);
  assert.deepEqual(faces.map((f) => f.type).sort(), ["cylinder", "plane", "plane", "plane", "plane", "plane", "plane"]);
  const hole = faces.find((f) => f.type === "cylinder");
  assert.equal(hole.hole, true); assert.equal(hole.radius, 3); assert.deepEqual(hole.axis, [0, 0, 1]); assert.deepEqual(hole.at, [15, 20, 10]);
  const top = S.pickGeometry(mesh, "face", "top")[0];
  assert.deepEqual(top.normal, [0, 0, 1]); assert.match(top.name, /:end:/);
  assert.ok(Math.abs(top.area - (60 * 40 - Math.PI * 9)) < 0.3, `the top's area is the rectangle less the hole, as finely as the hole is faceted (${top.area})`);
  assert.deepEqual(S.pickGeometry(mesh, "face", "bottom")[0].normal, [0, 0, -1]);
  assert.deepEqual(S.pickGeometry(mesh, "face", "front")[0].normal, [0, -1, 0]);
  assert.deepEqual(S.pickGeometry(mesh, "face", { normal: "+x" })[0].at, [60, 20, 10]);
  assert.equal(S.pickGeometry(mesh, "face", { hole: true, diameter: 6 })[0].name, hole.name);
  assert.equal(S.pickGeometry(mesh, "face", { nearest: [61, 20, 10] })[0].normal[0], 1);
  // a name is taken as it is
  assert.equal(S.pickGeometry(mesh, "face", top.name)[0].name, top.name);

  const round = S.pickGeometry(mesh, "edge", { of_face: "top", all: true });
  assert.equal(round.length, 5, "four sides and the hole's rim");
  assert.equal(round.filter((e) => e.type === "circle").length, 1);
  assert.deepEqual(S.pickGeometry(mesh, "edge", { of_face: "top", type: "circle" })[0].at, [15, 20, 20]);
  const upright = S.pickGeometry(mesh, "edge", { parallel_to: "z", all: true });
  assert.equal(upright.length, 4); assert.ok(upright.every((e) => e.type === "line" && e.length === 20));
  assert.equal(S.pickGeometry(mesh, "edge", { length: 60, all: true }).length, 4);
  assert.deepEqual(S.pickGeometry(mesh, "vertex", { nearest: [59, 39, 19] })[0].at, [60, 40, 20]);
  assert.equal(S.pickGeometry(mesh, "vertex", { of_face: "top", all: true }).length, 5, "the four corners, and the point where the hole's rim closes");
  assert.equal(S.edgesOfFace(mesh, hole.name).length, 2, "a hole's wall lies between its two rims");
  // the line where the hole's wall closes on itself is an edge of the kernel's, not of the part: no pick finds it
  const seam = S.summarise(mesh, "edge").filter((e) => e.seam);
  assert.equal(seam.length, 1); assert.equal(seam[0].type, "line");
  assert.equal(S.pickGeometry(mesh, "edge", "all").length, S.summarise(mesh, "edge").length - 1);
  assert.equal(S.pickGeometry(mesh, "edge", seam[0].name)[0].seam, true, "…but its name still does");
});

test("a pick that finds nothing says what there is, and a wrong pick says how to write one", async () => {
  const { bodies } = await build(apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK)));
  const mesh = bodies[0].mesh;
  assert.throws(() => S.pickGeometry(mesh, "face", { hole: true, diameter: 9 }), (e) => e instanceof S.PickError && /No face of this body matches .*It has 7 faces: .*6 plane.*1 cylinder \(hole\).*cad_find_geometry/.test(e.message));
  assert.throws(() => S.pickGeometry(mesh, "face", "upwards"), /neither a pick nor the name of a face.*pick is "top", "bottom"/);
  assert.throws(() => S.pickGeometry(mesh, "face", { colour: "red" }), /Unknown pick condition "colour"/);
  assert.throws(() => S.pickGeometry(mesh, "face", { of_face: "top" }), /of_face applies to edges and vertices/);
  assert.throws(() => S.pickGeometry(mesh, "edge", { type: "plane" }), /An edge's type is one of line, circle, arc, other/);
  assert.throws(() => S.pickGeometry(mesh, "edge", { nearest: "here" }), /nearest is a point: \[x, y, z\]/);
});

test("one batch extrudes a block, then picks its own faces: a pocket, a shell, fillets", async () => {
  const doc = emptyDoc();
  const plan = await staged(doc, [
    ...BLOCK,
    { op: "add", type: "sketch", ref: "p", name: "Pocket sketch", plane: { kind: "face", body: "$b", pick: "top" }, shapes: [{ type: "circle", cx: 45, cy: 20, r: 6 }] },
    { op: "add", type: "extrude", name: "Pocket", params: { profile: "$p", operation: "remove", depth: 5, flip: true } },
    { op: "add", type: "fillet", name: "Corners", params: { edges: [{ kind: "edge", body: "Block", pick: { parallel_to: "z", length: 20, all: true } }], radius: 4 } },
  ]);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.changes.length, 5); assert.equal(plan.done.length, 5);
  const fillet = plan.changes[4].item;
  assert.equal(fillet.params.edges.length, 4, "the pick with all became four named edges");
  assert.ok(fillet.params.edges.every((e) => e.kind === "edge" && typeof e.name === "string" && e.body === plan.changes[1].item.id && e.pick === undefined));
  const plane = plan.changes[2].item.params.plane;
  assert.equal(plane.kind, "face"); assert.match(plane.ref.name, /:end:/);
  // undoing the whole batch needs its inverse in the right order: newest first
  assert.equal(plan.inverse.length, 5); assert.equal(plan.inverse[0].id, fillet.id);
  const built = await build(plan.after);
  assert.deepEqual(built.failed, []);
  const volume = built.k.volume(built.engine.state.bodies[0].shape);
  const expect = (60 * 40 - Math.PI * 9) * 20 - Math.PI * 36 * 5 - (16 - Math.PI * 4) * 4 * 20;
  assert.ok(Math.abs(volume - expect) < 0.5, `${volume} is not ${expect}`);
  // the document was not touched by planning; nothing is half applied
  assert.equal(F.featuresOf(doc).length, 0);
});

test("a pick on a body that is not there, or on nothing, stops the batch with the reason", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const none = await staged(doc, [{ op: "add", type: "fillet", params: { edges: [{ kind: "edge", body: "Lid", pick: "all" }] } }]);
  assert.equal(none.changes.length, 0);
  assert.match(none.problems[0], /edit 1 \(add\): There is no body "Lid"\. The bodies are: .*\(made by Block\)/);
  const far = await staged(doc, [{ op: "rename", feature: "Block", name: "Base" }, { op: "add", type: "shell", params: { faces: [{ kind: "face", body: "Base", pick: { type: "cylinder", radius: 99 } }] } }]);
  assert.equal(far.changes.length, 0, "the rename before it is not applied either");
  assert.match(far.problems[0], /edit 2 \(add\): No face of this body matches/);
  // a pick where one thing is wanted, finding several
  const many = await staged(doc, [{ op: "add", type: "sketch", plane: { kind: "face", body: "Block", pick: { type: "plane", all: true } } }]);
  assert.match(many.problems[0], /finds 6 faces, and one is wanted here/);
  // a feature that failed upstream is named when its body is asked for
  const broken = await staged(emptyDoc(), [{ op: "add", type: "sketch", ref: "s", shapes: [{ type: "line", x1: 0, y1: 0, x2: 5, y2: 0 }] }, { op: "add", type: "extrude", ref: "e", name: "Bad", params: { profile: "$s" } }, { op: "add", type: "fillet", params: { edges: [{ kind: "edge", body: "$e", pick: "all" }] } }]);
  assert.match(broken.problems[0], /edit 3 \(add\): .*"Bad" failed: /);
});

// ---------------------------------------------------------------- variables, expressions, parts

test("variables drive parameters through expressions, and renaming one carries through", async () => {
  const doc = emptyDoc();
  apply(doc, M.planEdits(doc, K.FEATURES, [
    { op: "set_variable", name: "height", value: 12 }, { op: "set_variable", name: "wall", value: "height / 4 + 1" },
    ...BLOCK.slice(0, 1), { op: "add", type: "extrude", name: "Block", params: { profile: "Sketch 1", depth: "height * 2" } },
  ]));
  const block = F.featuresOf(doc).find((f) => f.name === "Block");
  assert.equal(block.params.depth, 24); assert.deepEqual(block.params.$expr, { depth: "height * 2" });
  assert.deepEqual(M.variablesJson(doc).map((v) => [v.name, v.value]), [["height", 12], ["wall", 4]]);
  assert.equal(M.variablesJson(doc)[0].used_by, 1);
  assert.deepEqual(M.treeOf(doc, null).variables.map((v) => v.name), ["height", "wall"]);
  const changed = M.planEdits(doc, K.FEATURES, [{ op: "set_variable", name: "height", value: 15, rename: "h" }]);
  assert.deepEqual(changed.problems, []);
  apply(doc, changed);
  const after = F.featuresOf(doc).find((f) => f.name === "Block");
  assert.equal(after.params.depth, 30); assert.deepEqual(after.params.$expr, { depth: "h * 2" });
  assert.ok(changed.touched.includes(after.id));
  assert.equal((await build(doc)).bodies[0].mesh.bbox[5], 30);
  // a plain number given afterwards takes the expression away
  apply(doc, M.planEdits(doc, K.FEATURES, [{ op: "set", feature: "Block", params: { depth: 8 } }]));
  assert.equal(F.featuresOf(doc).find((f) => f.name === "Block").params.$expr, undefined);
  const bad = M.planEdits(doc, K.FEATURES, [{ op: "set", feature: "Block", params: { depth: "tall + 1" } }, { op: "set_variable", name: "2x", value: 1 }, { op: "set_variable", name: "loop", value: "loop + 1" }, { op: "delete_variable", name: "gone" }, { op: "set", feature: "Block", params: { deep: 4 } }]);
  assert.equal(bad.changes.length, 0); assert.equal(bad.problems.length, 5);
  assert.match(bad.problems[0], /depth: "tall \+ 1" has no value: .*set_variable/);
  assert.match(bad.problems[2], /"loop \+ 1" has no value/);
  assert.match(bad.problems[3], /no variable "gone"\. The variables are: h, wall/);
  assert.match(bad.problems[4], /"Block" \(extrude\) has no parameter "deep"\. Its parameters are: .*depth/);
});

test("a part is named, given a material and a colour by the feature that made it", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const plan = await staged(doc, [{ op: "set_part", body: "Block", name: "Base plate", material: "Aluminium 6061", color: "#3366CC", description: "The base" }]);
  assert.deepEqual(plan.problems, []);
  apply(doc, plan);
  const id = F.featuresOf(doc)[1].id;
  assert.equal(doc.items.get("parts").names[id], "Base plate"); assert.equal(doc.items.get("parts").props[id].description, "The base");
  assert.equal(MAT.materialOf(doc, id).id, "aluminium"); assert.equal(MAT.densities(doc)[id], 2.7);
  assert.equal(doc.items.get("appearance").bodies[id].color, "#3366cc");
  // by its new part name now, and the material taken away again
  const again = await staged(doc, [{ op: "set_part", body: "base plate", material: null }]);
  assert.deepEqual(again.problems, []); apply(doc, again);
  assert.equal(MAT.materialOf(doc, id), null);
  const bad = await staged(doc, [{ op: "set_part", body: "Base plate", material: "unobtainium" }]);
  assert.match(bad.problems[0], /no material "unobtainium"\. The materials are: steel \(7\.85 g\/cm3\)/);
  assert.match((await staged(doc, [{ op: "set_part", body: "Nope", name: "x" }])).problems[0], /no body "Nope"\. The bodies are: Base plate/);
  assert.match((await staged(doc, [{ op: "set_part", body: "Base plate" }])).problems[0], /give name, material, color or description/);
  assert.match((await staged(doc, [{ op: "set_part", body: "Base plate", color: "blue" }])).problems[0], /color is "#rrggbb"/);
});

test("the tree is read compactly, one feature in full, and in pages", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const { result } = await build(doc);
  const compact = M.treeOf(doc, result.features, { compact: true });
  assert.deepEqual(Object.keys(compact.features[1]), ["index", "id", "name", "type", "status"]);
  const one = M.treeOf(doc, result.features, { only: F.featuresOf(doc)[0].id });
  assert.equal(one.features.length, 1); assert.equal(one.features[0].params.sketch.entities.p1.type, "point");
  const page = M.treeOf(doc, result.features, { offset: 1, limit: 1 });
  assert.equal(page.features[0].name, "Block"); assert.equal(page.feature_count, 2);
  assert.equal(M.treeOf(doc, result.features, { limit: 1 }).next_offset, 1);
});

// ---------------------------------------------------------------- describing, checking, seeing

test("a part is described in a sentence, and its thinnest wall is found", async () => {
  const doc = emptyDoc();
  apply(doc, await staged(doc, [...BLOCK, { op: "add", type: "shell", name: "Hollow", params: { faces: [{ kind: "face", body: "$b", pick: "top" }], thickness: 1.5 } }]));
  const { bodies, failed } = await build(doc);
  assert.deepEqual(failed, []);
  const text = D.describePart("Tray", bodies[0].mesh, { volume: 1234.5, mass_g: 3.33, material: "ABS" });
  assert.match(text, /^Tray: 60 × 40 × 20 mm, from \[0, 0, 0\] to \[60, 40, 20\]; volume 1234\.5 mm3, 3\.33 g of ABS; \d+ faces/);
  assert.match(text, /⌀6 along z/);
  const t = D.minThickness(bodies[0].mesh);
  assert.ok(t && Math.abs(t.min - 1.5) < 0.02, `the wall is 1.5 mm (${t && t.min})`); assert.ok(t.samples > 20 && t.face);
  // moved, the box moves with it
  assert.deepEqual(D.placedBox(bodies[0].mesh, [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 5]), [100, 0, 5, 160, 40, 25]);
  const f = F.featuresOf(doc);
  assert.equal(D.describeFeature(K.FEATURES.find((d) => d.type === "extrude"), f[1], "ok"), "Block (extrude: depth 20)");
  assert.match(D.describeFeature(K.FEATURES.find((d) => d.type === "sketch"), f[0], "ok"), /^Sketch 1 \(sketch: on top, 4 lines, 1 circle\)$/);
  assert.match(D.describeFeature(K.FEATURES.find((d) => d.type === "shell"), f[2], "error", "too thick"), /\[error: too thick\]$/);
});

test("the picture: several views in one, a section that opens the part, a highlighted face", async () => {
  const doc = apply(emptyDoc(), M.planEdits(emptyDoc(), K.FEATURES, BLOCK));
  const { bodies } = await build(doc);
  const mesh = bodies[0].mesh;
  const count = (pic, test) => { let n = 0; for (let i = 0; i < pic.rgba.length; i += 4) if (test(pic.rgba[i], pic.rgba[i + 1], pic.rgba[i + 2])) n++; return n; };
  const orange = (r, g, b) => r > 140 && r > g * 1.4 && g > b * 1.8;
  const plain = R.renderMeshes([mesh], { width: 400, height: 300, view: "top" });
  assert.equal(count(plain, orange), 0);
  const top = S.pickGeometry(mesh, "face", "top")[0];
  const lit = R.renderMeshes([mesh], { width: 400, height: 300, view: "top", highlight: [{ mesh: 0, kind: "face", name: top.name }] });
  assert.ok(count(lit, orange) > 30000, `the top face is drawn in the highlight colour (${count(lit, orange)} pixels)`);
  const rim = S.pickGeometry(mesh, "edge", { of_face: "top", type: "circle" })[0];
  assert.ok(count(R.renderMeshes([mesh], { width: 400, height: 300, view: "iso", highlight: [{ mesh: 0, kind: "edge", name: rim.name }] }), orange) > 60);
  // four views in one picture: twice two cells, each framed on its own
  const sheet = R.renderSheet([mesh], ["iso", "top", "front", "right"], { width: 800 });
  assert.equal(sheet.width, 800); assert.equal(sheet.height, 2 * Math.round(398 * 0.8) + 4);
  const png = R.encodePng(sheet);
  assert.equal(Buffer.from(png.subarray(1, 4)).toString(), "PNG");
  assert.equal(R.renderSheet([mesh], ["iso", "top", "front"], { width: 900 }).height, Math.round(Math.floor((900 - 8) / 3) * 0.8));
  // a section through the middle, seen from the front: the cut shows the hole as a gap in the dark cut face
  const dark = (r, g, b) => r < 110 && g < 120 && b < 130 && r > 40;
  const whole = R.renderMeshes([mesh], { width: 400, height: 300, view: "front" });
  const cut = R.renderMeshes([mesh], { width: 400, height: 300, view: "front", section: { point: [30, 20, 10], normal: [0, -1, 0] } });
  assert.ok(count(cut, dark) > count(whole, dark) + 20000, `the cut face is drawn dark (${count(cut, dark)} against ${count(whole, dark)})`);
  // a placement moves what is drawn: two copies side by side fill more of the picture's width than one
  const two = R.renderMeshes([mesh, mesh], { width: 400, height: 300, view: "top", transforms: [null, [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0]] });
  const bg = (r, g, b) => r === 0xf3 && g === 0xf4 && b === 0xf6;
  assert.ok(count(two, bg) > count(plain, bg), "framed on both, each is smaller");
  // zooming on a box frames that box
  const zoom = R.renderMeshes([mesh], { width: 400, height: 300, view: "top", frame: [10, 15, 0, 20, 25, 20] });
  assert.ok(count(zoom, bg) > 2000 && count(zoom, bg) < count(plain, bg) * 3, "the hole fills the middle of the zoomed picture");
  if (process.env.SHOTS) { fs.writeFileSync(path.join(process.env.SHOTS, "mcp-unit-sheet.png"), png); fs.writeFileSync(path.join(process.env.SHOTS, "mcp-unit-section.png"), R.encodePng(cut)); }
});

// ---------------------------------------------------------------- assemblies

/** A box with a hinge hole along x at its back top edge, and a lid with the same hole: two part studios, built. */
async function hingeParts() {
  const boxDoc = emptyDoc();
  apply(boxDoc, await staged(boxDoc, [
    { op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 60, y2: 40 }] },
    { op: "add", type: "extrude", ref: "b", name: "Box", params: { profile: "$s", depth: 20 } },
    { op: "add", type: "sketch", ref: "h", plane: "right", shapes: [{ type: "circle", cx: 36, cy: 16, r: 1.5 }] },
    { op: "add", type: "extrude", name: "Hinge hole", params: { profile: "$h", operation: "remove", endType: "through", second: true, secondType: "through" } },
  ]));
  const lidDoc = emptyDoc();
  apply(lidDoc, await staged(lidDoc, [
    { op: "add", type: "sketch", ref: "s", plane: "top", shapes: [{ type: "rectangle", x1: 0, y1: 0, x2: 60, y2: 40 }] },
    { op: "add", type: "extrude", ref: "b", name: "Lid", params: { profile: "$s", depth: 6 } },
    { op: "add", type: "sketch", ref: "h", plane: "right", shapes: [{ type: "circle", cx: 36, cy: 3, r: 1.5 }] },
    { op: "add", type: "extrude", name: "Hinge hole", params: { profile: "$h", operation: "remove", endType: "through", second: true, secondType: "through" } },
  ]));
  const box = await build(boxDoc), lid = await build(lidDoc);
  assert.deepEqual([...box.failed, ...lid.failed], []);
  return { box, lid };
}

test("an assembly: parts inserted, a hinge mated by picked holes, driven, and reported by the solver", async () => {
  const { box, lid } = await hingeParts();
  const sources = { box: { status: "ready", pieces: [{ id: box.bodies[0].id, name: "Box", mesh: box.bodies[0].mesh, local: null }] }, lid: { status: "ready", pieces: [{ id: lid.bodies[0].id, name: "Lid", mesh: lid.bodies[0].mesh, local: null }] } };
  const geo = { pieces: (s) => sources[s.docId] || { status: "error", message: "gone", pieces: [] } };
  const offer = (docId) => ({ offers: [{ source: { kind: "part", docId, body: sources[docId].pieces[0].id }, name: docId === "box" ? "Box" : "Lid" }] });
  const doc = I.parseItemDoc(AF.newAssemblyText(), "assembly");
  const holeOf = (m) => S.summarise(m, "face").find((f) => f.type === "cylinder");
  assert.equal(holeOf(box.bodies[0].mesh).radius, 1.5); assert.deepEqual(holeOf(box.bodies[0].mesh).axis, [1, 0, 0]);

  const edits = [
    { op: "insert", part: "Box.jpart", ref: "box", fixed: true },
    { op: "insert", part: "Lid.jpart", ref: "lid", at: [0, 0, 60] },
    { op: "mate", type: "revolute", name: "Hinge", ref: "hinge", a: { instance: "$box", face: { hole: true, diameter: 3 } }, b: { instance: "$lid", face: { hole: true, diameter: 3 } }, params: { limits: true, angleMin: 0, angleMax: 110 } },
  ];
  const plan = A.planAssemblyEdits(doc, edits, { defs: MATES, geo, inserts: new Map([[0, offer("box")], [1, offer("lid")]]) });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.done.length, 3); assert.match(plan.done[2], /added revolute mate "Hinge": Box \(cylinder ⌀3\) to Lid \(cylinder ⌀3\)/);
  I.applyChanges(doc, plan.changes);
  assert.equal(I.serializeItemDoc(doc), I.serializeItemDoc(plan.after), "the changes make the planned document");
  const read = A.assemblyJson(doc, MATES, geo);
  assert.deepEqual(read.instances.map((i) => [i.name, !!i.fixed, i.freedoms]), [["Box", true, 0], ["Lid", false, 1]]);
  assert.equal(read.mates[0].state, "ok"); assert.equal(read.solve.ok, true); assert.equal(read.solve.freedoms, 1);
  assert.match(read.solve.hints.join(" "), /Lid \(1\) can still move/);
  // the lid's hole is on the box's: the lid's origin is where that puts it, whatever the insert said
  const lidRow = read.instances[1];
  assert.ok(Math.abs(lidRow.position[0]) < 1e-3, JSON.stringify(lidRow.position));
  const angle = read.mates[0].values.angle;
  assert.ok(typeof angle === "number");

  // drive the hinge to 90°: the lid stands up; the document stores the placement and the value
  const drive = A.planAssemblyEdits(doc, [{ op: "drive", mate: "Hinge", value: 90 }], { defs: MATES, geo, inserts: new Map() });
  assert.deepEqual(drive.problems, []);
  I.applyChanges(doc, drive.changes);
  const mate = AF.matesOf(doc)[0];
  assert.ok(Math.abs(mate.values.angle - 90) < 1e-3, JSON.stringify(mate.values));
  const lidT = AF.transformOf(AF.instancesOf(doc)[1]);
  assert.ok(Math.abs(Math.abs(lidT[6]) - 1) < 1e-6, `the lid is turned a quarter about x (${lidT.map((v) => Math.round(v * 100) / 100)})`);
  assert.equal(A.assemblyJson(doc, MATES, geo).instances[1].rotation.angle, 90);
  // beyond its limit it is refused, and nothing changes
  const over = A.planAssemblyEdits(doc, [{ op: "drive", mate: "Hinge", value: 150 }], { defs: MATES, geo, inserts: new Map() });
  assert.equal(over.changes.length, 0); assert.match(over.problems[0], /"Hinge" cannot be at angle 150°/);
  // what undoes the first plan takes the assembly back to empty
  I.applyChanges(doc, drive.inverse); I.applyChanges(doc, plan.inverse);
  assert.equal(AF.instancesOf(doc).length, 0); assert.equal(AF.matesOf(doc).length, 0);
});

test("two flat faces are mated facing each other; copy, move, suppress and delete", async () => {
  const { box, lid } = await hingeParts();
  const sources = { box: { status: "ready", pieces: [{ id: box.bodies[0].id, name: "Box", mesh: box.bodies[0].mesh, local: null }] }, lid: { status: "ready", pieces: [{ id: lid.bodies[0].id, name: "Lid", mesh: lid.bodies[0].mesh, local: null }] } };
  const geo = { pieces: (s) => sources[s.docId] };
  const offer = (docId, name) => ({ offers: [{ source: { kind: "part", docId, body: sources[docId].pieces[0].id }, name }] });
  const doc = I.parseItemDoc(AF.newAssemblyText(), "assembly");
  const plan = A.planAssemblyEdits(doc, [
    { op: "insert", part: "Box", ref: "box", fixed: true }, { op: "insert", part: "Lid", ref: "lid", at: [200, 50, 0] },
    { op: "mate", type: "fastened", a: { instance: "$box", face: "top" }, b: { instance: "$lid", face: "bottom" } },
  ], { defs: MATES, geo, inserts: new Map([[0, offer("box", "Box")], [1, offer("lid", "Lid")]]) });
  assert.deepEqual(plan.problems, []);
  assert.match(plan.done[2], /Box \(flat face\) to Lid \(flat face, flipped\)/);
  I.applyChanges(doc, plan.changes);
  const read = A.assemblyJson(doc, MATES, geo);
  assert.equal(read.solve.freedoms, 0); assert.equal(read.mates[0].name, "Fastened 1");
  // the lid sits on the box: its bottom at z 20, its middle over the box's middle
  const t = AF.transformOf(AF.instancesOf(doc)[1]);
  const lidBox = D.placedBox(lid.bodies[0].mesh, t);
  assert.ok(Math.abs(lidBox[2] - 20) < 1e-3 && Math.abs(lidBox[5] - 26) < 1e-3, `the lid stands on the box (${lidBox.map((v) => Math.round(v * 100) / 100)})`);
  assert.ok(Math.abs((lidBox[0] + lidBox[3]) / 2 - 30) < 1e-3 && Math.abs((lidBox[1] + lidBox[4]) / 2 - 20) < 1e-3);

  const more = A.planAssemblyEdits(doc, [
    { op: "copy", instance: "Box", count: 2, step: [100, 0, 0], ref: "c" }, { op: "move", instance: "$c", by: [0, 0, 5] }, { op: "rename", instance: "$c", name: "Second box" },
    { op: "hide", instance: "Second box" }, { op: "suppress", mate: "Fastened 1" }, { op: "move", instance: "Lid", to: [0, 0, 80], rotate: { axis: "z", angle: 90 } },
  ], { defs: MATES, geo, inserts: new Map() });
  assert.deepEqual(more.problems, []);
  I.applyChanges(doc, more.changes);
  const after = A.assemblyJson(doc, MATES, geo);
  assert.deepEqual(after.instances.map((i) => i.name), ["Box", "Lid", "Second box", "Box 3"]);
  assert.deepEqual(after.instances[2].position, [100, 0, 5]); assert.equal(after.instances[2].hidden, true);
  assert.equal(after.mates[0].state, "suppressed");
  assert.deepEqual(after.instances[1].position, [0, 0, 80]); assert.deepEqual(after.instances[1].rotation, { axis: [0, 0, 1], angle: 90 });
  const del = A.planAssemblyEdits(doc, [{ op: "delete", instance: "Lid" }], { defs: MATES, geo, inserts: new Map() });
  assert.match(del.done[0], /deleted "Lid" and its mates \(Fastened 1\)/);
  I.applyChanges(doc, del.changes);
  assert.equal(AF.matesOf(doc).length, 0);
});

test("assembly edits are refused together, each with what to do", async () => {
  const { box } = await hingeParts();
  const sources = { box: { status: "ready", pieces: [{ id: box.bodies[0].id, name: "Box", mesh: box.bodies[0].mesh, local: null }] } };
  const geo = { pieces: (s) => sources[s.docId] || { status: "error", message: "Its part studio failed to build", pieces: [] } };
  const doc = I.parseItemDoc(AF.newAssemblyText(), "assembly");
  const offer = { offers: [{ source: { kind: "part", docId: "box", body: sources.box.pieces[0].id }, name: "Box" }] };
  I.applyChanges(doc, A.planAssemblyEdits(doc, [{ op: "insert", part: "Box", fixed: true }, { op: "insert", part: "Box" }], { defs: MATES, geo, inserts: new Map([[0, offer], [1, offer]]) }).changes);
  assert.deepEqual(AF.instancesOf(doc).map((i) => i.name), ["Box", "Box 2"]);
  assert.ok(AF.transformOf(AF.instancesOf(doc)[1])[3] > 60, "the second of the same body is set beside the first");
  const p = A.planAssemblyEdits(doc, [
    { op: "mate", type: "glue", a: {}, b: {} },
    { op: "mate", type: "revolute", a: { instance: "Box", face: { hole: true, diameter: 9 } }, b: { instance: "Box 2", face: "top" } },
    { op: "mate", type: "fastened", a: { instance: "Box", face: "top" }, b: { instance: "Box", face: "bottom" } },
    { op: "mate", type: "fastened", a: { instance: "Box", face: "top" }, b: { instance: "Box 2", face: "bottom" }, params: { gap: 2 } },
    { op: "move", instance: "Lid", by: [0, 0, 1] },
    { op: "move", instance: "Box 2" },
    { op: "drive", mate: "Hinge", value: 5 },
    { op: "insert", part: "Nothing" },
    { op: "copy", instance: "Box", step: [1, 2] },
    { op: "weld" },
  ], { defs: MATES, geo, inserts: new Map([[7, { offers: [], problem: "There is no part studio \"Nothing\" in the project" }]]) });
  assert.equal(p.changes.length, 0); assert.equal(p.problems.length, 10);
  assert.match(p.problems[0], /unknown mate type "glue"\. The types are: .*revolute.*cad_reference topic "mates"/);
  assert.match(p.problems[1], /a on Box: No face of this body matches/);
  assert.match(p.problems[2], /a and b must be on two different instances/);
  assert.match(p.problems[3], /a fastened mate has no parameter "gap"\. Its parameters are: .*offset/);
  assert.match(p.problems[4], /no instance "Lid"\. The instances are: Box, Box 2/);
  assert.match(p.problems[5], /give to, by or rotate/);
  assert.match(p.problems[6], /no mate "Hinge"\. The mates are: \(none\)/);
  assert.match(p.problems[7], /no part studio "Nothing"/);
  assert.match(p.problems[8], /step is the displacement/);
  assert.match(p.problems[9], /unknown op "weld" \(insert, move, fix/);
  // with nothing fixed the report says so; a mate that cannot hold says conflict
  const loose = I.parseItemDoc(AF.newAssemblyText(), "assembly");
  I.applyChanges(loose, A.planAssemblyEdits(loose, [{ op: "insert", part: "Box" }], { defs: MATES, geo, inserts: new Map([[0, offer]]) }).changes);
  assert.match(A.assemblyJson(loose, MATES, geo).solve.hints[0], /No instance is fixed/);
  // an instance whose source is gone is reported, not thrown
  const lost = A.planAssemblyEdits(loose, [{ op: "insert", part: "Gone" }], { defs: MATES, geo, inserts: new Map([[0, { offers: [{ source: { kind: "part", docId: "gone", body: "x" }, name: "Gone" }] }]]) });
  I.applyChanges(loose, lost.changes);
  assert.match(A.assemblyJson(loose, MATES, geo).instances[1].problem, /failed to build/);
});

test("the mate types are described from the registry, with what can be driven", () => {
  const text = A.mateTypesText(MATES, C.fieldDoc);
  for (const d of MATES) assert.ok(text.includes(`- ${d.type}: ${d.title}.`), d.type);
  assert.match(text, /- revolute: Revolute\. Leaves 0 translations and 1 rotation\. Values that can be driven and limited: angle \(deg\)/);
  assert.match(text, /- fastened: Fastened\. Leaves no freedom\./);
  assert.deepEqual(A.placementJson([1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7]), { position: [5, 6, 7] });
  assert.deepEqual(A.rotation([0, 0, 1], 90, [0, 0, 0]).map((v) => Math.round(v * 1e6) / 1e6), [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]);
});

// ---------------------------------------------------------------- the catalog of tools

test("every tool of both domains is described, has a function in its host, and names its units", () => {
  const all = [];
  for (const domain of ["mechanical", "assembly"]) {
    const tools = JSON.parse(fs.readFileSync(path.join(server, "web", "domains", domain, "mcp", "tools.json"), "utf8"));
    const host = fs.readFileSync(path.join(server, "web", "domains", domain, "mcp", "host.ts"), "utf8");
    for (const t of tools) {
      assert.match(t.name, /^cad_/); assert.ok(!t.name.startsWith("cad_script_"), "cad_script_ is another feature's name space");
      assert.ok(host.includes(`${t.name}:`), `${t.name} has a function in ${domain}/mcp/host.ts`);
      assert.ok(t.title && t.description.length > 120, `${t.name} is described`);
      assert.equal(t.input_schema.type, "object"); assert.equal(t.input_schema.additionalProperties, false);
      if (t.input_schema.properties.project) assert.ok(t.input_schema.required.includes("project"));
      for (const [key, prop] of Object.entries(t.input_schema.properties)) assert.ok(prop.description || prop.type === "boolean" || prop.type === "string", `${t.name}.${key} is described`);
      if (t.destructive) assert.ok(t.write, `${t.name}: only a write is destructive`);
      all.push(t);
    }
  }
  const names = all.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const kept of ["cad_feature_types", "cad_get_features", "cad_get_bodies", "cad_edit_features", "cad_render_view", "cad_create_part_studio"]) assert.ok(names.includes(kept), `${kept} is still there`);
  // the tools that return lengths say the unit
  for (const t of all.filter((x) => /measure|bodies|find_geometry|edit_features|edit_assembly|get_assembly|export|check|describe/.test(x.name))) assert.match(t.description, /[Mm]illimetres|mm3/, `${t.name} states its unit`);
  // the whole catalogue of CAD tools is cheap to list
  const size = JSON.stringify(all).length;
  assert.ok(size < 40000, `the CAD tool definitions are ${size} characters`);
  // the ops the tool describes are the ops the planner takes
  const ops = all.find((t) => t.name === "cad_edit_features").input_schema.properties.edits.items.properties.op.enum;
  assert.deepEqual(ops, M.EDIT_OPS);
  assert.deepEqual(all.find((t) => t.name === "cad_edit_assembly").input_schema.properties.edits.items.properties.op.enum, A.ASSEMBLY_OPS);
});
