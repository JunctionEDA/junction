// Node test for what the assembly rework added under the solver and the document: relations between mate
// values (gear, rack and pinion, screw, linear), the Width mate, limits on a Planar mate, instance patterns that
// follow their seeds, saved exploded views, the order of the list, and what a delete takes with it.
// Run: node server/static/tests/assembly-relations.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const S = load("domains/assembly/solver/solver.ts");
const M = load("domains/assembly/solver/math.ts");
const FR = load("domains/assembly/solver/frames.ts");
const G = load("domains/assembly/generated/page.ts");
const P = load("domains/assembly/model/problem.ts");
const R = load("domains/assembly/model/relations.ts");
const E = load("domains/assembly/document/edits.ts");
const X = load("domains/assembly/document/extras.ts");
const F = load("domains/assembly/document/format.ts");
const D = load("shared/itemdoc/itemdoc.ts");

const mate = (type) => G.MATES.find((m) => m.type === type);
const frame = (o, z = [0, 0, 1], extra = {}) => ({ ...FR.frameFromAxis(o, z), ...extra });
const pose = (p = [0, 0, 0], axis = [0, 0, 1], deg = 0) => ({ p, q: M.qaxis(M.unit(axis), (deg * Math.PI) / 180) });
const body = (id, p, fixed = false) => ({ id, pose: p || pose(), fixed });
const mk = (id, type, a, fa, b, fb, params = {}) => { const def = mate(type), p = { ...def.defaults(), ...params }; return { id, solve: def.solve, a: { body: a, frame: FR.prepareA(fa, false, p) }, b: { body: b, frame: FR.prepareB(fb, false, p) }, params: p }; };
const near = (a, b, eps = 1e-6, what = "") => assert.ok(Math.abs(a - b) <= eps, `${what} ${a} is not ${b}`);
const rad = (d) => (d * Math.PI) / 180;
const rel = (type, a, b, params = {}) => { const def = R.relationDef(type); return { id: type, a, b, ratio: def.ratio({ ...def.defaults(), ...params }) }; };
/** solve again and again from where the last solve left the bodies, as a drag or an animation does */
function run(bodies, mates, relations, steps, opts) {
  let state = bodies, r = null;
  for (let s = 1; s <= steps; s++) { r = S.solve(state, mates, { relations, ...opts(s) }); assert.equal(r.ok, true, `step ${s}`); state = state.map((b) => ({ ...b, pose: r.poses.get(b.id) })); }
  return r;
}

test("the four relations are there, each with what it ties", () => {
  assert.deepEqual(R.RELATIONS.map((r) => r.type), ["gear", "rack", "screw", "linear"]);
  near(R.relationDef("gear").ratio({ ratio: 3, reverse: true }), -3);
  near(R.relationDef("rack").ratio({ travel: 20 * Math.PI }), 10, 1e-12, "a pinion of pitch radius 10 moves the rack 10 mm per radian:");
  near(R.relationDef("screw").ratio({ pitch: 2, reverse: true }), -2 / (2 * Math.PI), 1e-12);
});

test("gear: two hinges turn in the ratio, the other way round, past half a turn and through several turns", () => {
  const h1 = mk("h1", "revolute", "base", frame([0, 0, 0]), "big", frame([0, 0, 0])), h2 = mk("h2", "revolute", "base", frame([30, 0, 0]), "small", frame([0, 0, 0]));
  const bodies = [body("base", pose(), true), body("big", pose()), body("small", pose([30, 0, 0]))];
  const gear = rel("gear", { mate: "h2", key: "angle" }, { mate: "h1", key: "angle" }, { ratio: 2, reverse: true });   // the small one turns twice as fast, backwards
  // without the relation each hinge is a freedom; with it they are one
  assert.equal(S.solve(bodies, [h1, h2], { analyze: true }).dof, 2);
  const a = S.solve(bodies, [h1, h2], { analyze: true, relations: [gear] });
  assert.equal(a.ok, true); assert.equal(a.dof, 1); assert.equal(a.relations.get("gear").status, "ok");
  assert.equal(a.bodies.get("small").dof, 1);
  // drive the big gear through two whole turns in steps of 20°: the small one makes four, the other way
  let turned = 0, lastSmall = 0, total = 0;
  const r = run(bodies, [h1, h2], [gear], 36, (s) => ({ drives: [{ mate: "h1", key: "angle", value: Math.atan2(Math.sin(rad(20 * s)), Math.cos(rad(20 * s))) }] }));
  // follow the small gear's angle by solving again, summing its steps
  let state = bodies;
  for (let s = 1; s <= 36; s++) {
    const step = S.solve(state, [h1, h2], { relations: [gear], drives: [{ mate: "h1", key: "angle", value: Math.atan2(Math.sin(rad(20 * s)), Math.cos(rad(20 * s))) }] });
    const now = step.mates.get("h2").values.angle;
    let d = now - lastSmall; d = ((d + 540) % 360) - 180;
    total += d; lastSmall = now; turned += 20;
    state = state.map((b) => ({ ...b, pose: step.poses.get(b.id) }));
  }
  near(turned, 720); near(total, -1440, 1e-3, "the small gear has turned four times backwards:");
  near(r.mates.get("h1").values.angle, 0, 1e-4); near(r.mates.get("h2").values.angle, 0, 1e-3);
  // dragging the small gear's rim turns the big one half as far
  const d = S.solve(bodies, [h1, h2], { relations: [gear], drag: { body: "small", point: [8, 0, 0], target: [30 + 8 * Math.cos(rad(40)), 8 * Math.sin(rad(40)), 0] }, maxIterations: 24 });
  assert.equal(d.ok, true);
  near(d.mates.get("h2").values.angle, 40, 0.5); near(d.mates.get("h1").values.angle, -20, 0.25);
  near(d.mates.get("h2").values.angle, -2 * d.mates.get("h1").values.angle, 1e-4, "the ratio holds exactly whatever the drag reached:");
});

test("rack and pinion: the slide follows the hinge, 20 mm a turn", () => {
  const hinge = mk("hinge", "revolute", "base", frame([0, 0, 10], [0, 1, 0]), "pinion", frame([0, 0, 0], [0, 1, 0])), slide = mk("slide", "slider", "base", frame([0, 0, 0], [1, 0, 0]), "rack", frame([0, 0, 0], [1, 0, 0]));
  const bodies = [body("base", pose(), true), body("pinion", pose([0, 0, 10])), body("rack", pose())];
  const rk = rel("rack", { mate: "slide", key: "distance" }, { mate: "hinge", key: "angle" }, { travel: 20 });
  const a = S.solve(bodies, [hinge, slide], { analyze: true, relations: [rk] });
  assert.equal(a.dof, 1);
  const r = run(bodies, [hinge, slide], [rk], 9, (s) => ({ drives: [{ mate: "hinge", key: "angle", value: rad(10 * s) }] }));
  near(r.mates.get("hinge").values.angle, 90, 1e-4); near(r.mates.get("slide").values.distance, 5, 1e-4, "a quarter turn is 5 mm:");
  // and the other way: push the rack, the pinion turns
  const back = S.solve(bodies, [hinge, slide], { relations: [rk], drives: [{ mate: "slide", key: "distance", value: -2 }] });
  assert.equal(back.ok, true); near(back.mates.get("hinge").values.angle, -36, 1e-3);
});

test("screw: one Cylindrical mate, its distance tied to its angle; linear: two slides in a ratio", () => {
  const cyl = mk("cyl", "cylindrical", "nut", frame([0, 0, 0]), "bolt", frame([0, 0, 0]));
  const bodies = [body("nut", pose(), true), body("bolt", pose())];
  const screw = rel("screw", { mate: "cyl", key: "distance" }, { mate: "cyl", key: "angle" }, { pitch: 1.5 });
  const a = S.solve(bodies, [cyl], { analyze: true, relations: [screw] });
  assert.equal(a.ok, true); assert.equal(a.dof, 1, "a screw has one freedom, not two");
  const r = run(bodies, [cyl], [screw], 24, (s) => ({ drives: [{ mate: "cyl", key: "angle", value: Math.atan2(Math.sin(rad(30 * s)), Math.cos(rad(30 * s))) }] }));
  near(r.mates.get("cyl").values.distance, 3, 1e-4, "two turns advance two leads:");
  // linear
  const s1 = mk("s1", "slider", "base", frame([0, 0, 0], [1, 0, 0]), "one", frame([0, 0, 0], [1, 0, 0])), s2 = mk("s2", "slider", "base", frame([0, 20, 0], [1, 0, 0]), "two", frame([0, 0, 0], [1, 0, 0]));
  const lb = [body("base", pose(), true), body("one", pose()), body("two", pose([0, 20, 0]))];
  const lin = rel("linear", { mate: "s2", key: "distance" }, { mate: "s1", key: "distance" }, { ratio: 2, reverse: true });
  const l = S.solve(lb, [s1, s2], { analyze: true, relations: [lin], drives: [{ mate: "s1", key: "distance", value: 7 }] });
  assert.equal(l.ok, true); assert.equal(l.dof, 1);
  near(l.mates.get("s2").values.distance, -14, 1e-5);
});

test("a relation that cannot hold is the conflict, not its mates; one whose mate is gone says so", () => {
  // the second hinge is on a part fastened to the base: it cannot turn, the first is driven
  const h1 = mk("h1", "revolute", "base", frame([0, 0, 0]), "a", frame([0, 0, 0])), h2 = mk("h2", "revolute", "base", frame([30, 0, 0]), "b", frame([0, 0, 0])), lock = mk("lock", "fastened", "base", frame([30, 0, 9]), "b", frame([0, 0, 9]));
  const bodies = [body("base", pose(), true), body("a", pose()), body("b", pose([30, 0, 0]))];
  const gear = rel("gear", { mate: "h1", key: "angle" }, { mate: "h2", key: "angle" });
  const held = S.solve(bodies, [h1, h2, lock], { analyze: true, relations: [gear] });
  assert.equal(held.ok, true); assert.equal(held.dof, 0, "a gear meshed with a locked one cannot turn either");
  const r = S.solve(bodies, [h1, h2, lock], { analyze: true, relations: [gear], drives: [{ mate: "h1", key: "angle", value: rad(25) }] });
  assert.equal(r.ok, false);
  assert.equal(r.relations.get("gear").status, "conflict"); assert.match(r.relations.get("gear").message, /conflicts/);
  for (const id of ["h1", "h2", "lock"]) assert.equal(r.mates.get(id).status, "ok", id);
  const lost = S.solve(bodies, [h1], { relations: [gear] });
  assert.equal(lost.relations.get("gear").status, "error");
});

// ---- the document side: a stand-in for the geometry, named frames per instance
const GEOM = {
  frame: (inst, ref) => (inst.frames && inst.frames[ref.name]) || null,
};
const inst = (id, name, t, frames, extra = {}) => ({ id, type: "instance", name, order: id, source: { kind: "part", docId: "d", body: id }, transform: t || F.IDENTITY.slice(), frames, ...extra });
const docOf = (items) => D.newItemDoc("assembly", [{ id: "assembly", type: "assembly", units: "mm" }, ...items]);
const apply = (doc, changes) => { D.applyChanges(doc, changes); return doc; };
const at = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const connectors = new Map();

test("Width: a tab is centred between the two walls of a slot, and still slides along it", () => {
  // a slot 20 wide (walls at y = 0 and y = 20, facing each other) and a tab 8 thick (flanks at y = -4 and 4)
  const slot = inst("slot", "Slot", at(0, 0, 0), { w1: frame([50, 0, 5], [0, 1, 0], { surface: "plane" }), w2: frame([50, 20, 5], [0, -1, 0], { surface: "plane" }) }, { fixed: true });
  const tab = inst("tab", "Tab", at(7, 33, -2), { f1: frame([0, -4, 0], [0, -1, 0], { surface: "plane" }), f2: frame([0, 4, 0], [0, 1, 0], { surface: "plane" }) });
  const m = { id: "w", type: "mate", mateType: "width", name: "Width 1", order: "a", a: { instance: "slot", ref: { kind: "face", body: "slot", name: "w1" }, ref2: { kind: "face", body: "slot", name: "w2" } }, b: { instance: "tab", ref: { kind: "face", body: "tab", name: "f1" }, ref2: { kind: "face", body: "tab", name: "f2" } }, params: {} };
  const p = P.buildProblem([slot, tab], [m], connectors, G.MATES, GEOM);
  const s = P.solveProblem(p, { analyze: true });
  assert.equal(s.mates.get("w").state, "ok");
  near(s.result.poses.get("tab").p[1], 10, 1e-6, "the tab's middle is in the slot's middle plane:");
  near(s.result.poses.get("tab").p[0], 7, 1e-6, "and it stayed where it was along the slot:");
  assert.equal(s.result.dof, 3);
  // with one face only it is an error a person can act on
  const half = P.solveProblem(P.buildProblem([slot, tab], [{ ...m, b: { instance: "tab", ref: m.b.ref } }], connectors, G.MATES, GEOM));
  assert.equal(half.mates.get("w").state, "error"); assert.match(half.mates.get("w").message, /two faces on each part/);
  // the middle of two faces
  const mid = P.middleFrame(slot.frames.w1, slot.frames.w2);
  near(mid.o[1], 10); near(Math.abs(mid.z[1]), 1); assert.equal(mid.surface, "plane");
});

test("Planar: its three values can be limited, and a drag stops at the limit", () => {
  const m = mk("p", "planar", "table", frame([0, 0, 0]), "puck", frame([0, 0, 0]), { limits: true, xMin: -10, xMax: 25, yMin: -5, yMax: 5, angleMin: -180, angleMax: 180 });
  const bodies = [body("table", pose(), true), body("puck", pose())];
  const r = S.solve(bodies, [m], { drag: { body: "puck", point: [0, 0, 0], target: [80, 40, 30] }, maxIterations: 40 });
  assert.equal(r.ok, true);
  near(r.mates.get("p").values.x, 25, 1e-3); near(r.mates.get("p").values.y, 5, 1e-3);
  near(r.poses.get("puck").p[2], 0, 1e-6, "it stays on the table:");
  assert.deepEqual(mate("planar").solve.values.map((v) => v.key), ["x", "y", "angle"]);
});

test("a gear relation through the document: built, solved, driven in one go, and refused for the wrong mates", () => {
  const base = inst("base", "Base", at(0, 0, 0), { h1: frame([0, 0, 0]), h2: frame([30, 0, 0]), s: frame([0, 40, 0], [1, 0, 0]) }, { fixed: true });
  const big = inst("big", "Big", at(0, 0, 0), { c: frame([0, 0, 0]) }), small = inst("small", "Small", at(30, 0, 0), { c: frame([0, 0, 0]) }), bar = inst("bar", "Bar", at(0, 40, 0), { c: frame([0, 0, 0], [1, 0, 0]) });
  const ref = (i, n) => ({ instance: i, ref: { kind: "face", body: i, name: n } });
  const doc = docOf([base, big, small, bar]);
  apply(doc, E.addMate(doc, { mateType: "revolute", name: "Hinge 1", a: ref("base", "h1"), b: ref("big", "c"), params: mate("revolute").defaults() }, "m1").changes);
  apply(doc, E.addMate(doc, { mateType: "revolute", name: "Hinge 2", a: ref("base", "h2"), b: ref("small", "c"), params: mate("revolute").defaults() }, "m2").changes);
  apply(doc, E.addMate(doc, { mateType: "slider", name: "Slide", a: ref("base", "s"), b: ref("bar", "c"), params: mate("slider").defaults() }, "m3").changes);
  const made = X.addRelation(doc, { relationType: "gear", title: "Gear", a: { mate: "m2", key: "angle" }, b: { mate: "m1", key: "angle" }, params: { ratio: 5, reverse: false } });
  apply(doc, made.changes);
  assert.equal(made.item.name, "Gear 1");
  const build = () => P.buildProblem(F.instancesOf(doc), F.matesOf(doc), connectors, G.MATES, GEOM, undefined, { relations: X.relationsOf(doc), patterns: X.patternsOf(doc) });
  let p = build();
  assert.equal(p.relations.length, 1);
  // 60° typed on the slow gear in one go: the fast one must make 300°, far past half a turn; the steps get it there
  const s = P.solveProblem(p, { analyze: true, drives: [{ mate: "m1", key: "angle", value: rad(60) }] });
  assert.equal(s.result.ok, true); assert.equal(s.relations.get(made.item.id).state, "ok");
  near(s.mates.get("m1").values.angle, 60, 1e-4); near(s.mates.get("m2").values.angle, 300 - 360, 1e-3);
  assert.equal(s.result.dof, 2, "the two gears are one freedom, the slide another");
  // a gear between a hinge and a slide is refused in words
  apply(doc, X.updateRelation(doc, made.item.id, { b: { mate: "m3", key: "distance" } }));
  p = build();
  assert.equal(p.relations.length, 0); assert.equal(p.relationInfo.get(made.item.id).state, "error"); assert.match(p.relationInfo.get(made.item.id).message, /mate that turns/);
  // deleting a mate deletes the relations on it; a document without any of this still reads
  apply(doc, X.updateRelation(doc, made.item.id, { b: { mate: "m1", key: "angle" } }));
  apply(doc, E.deleteItems(doc, ["m1"]));
  assert.equal(X.relationsOf(doc).length, 0);
  const round = D.parseItemDoc(D.serializeItemDoc(doc), "assembly");
  assert.equal(F.matesOf(round).length, 2);
});

test("a linear pattern: its copies stand along the direction, follow the seed when it moves and turns, and go with it", () => {
  const seed = inst("seed", "Post", at(10, 0, 0), { c: frame([0, 0, 0]) }), other = inst("other", "Plate", at(0, 0, 0), { c: frame([0, 0, 0]) }, { fixed: true });
  const doc = docOf([other, seed]);
  const frames = X.patternFrames(doc, ["seed"], { direction: [1, 0, 0] });
  const made = X.addPattern(doc, { patternType: "linear", seeds: ["seed"], count: 4, spacing: 25, frames });
  apply(doc, made.changes);
  assert.equal(made.item.name, "Linear pattern 1"); assert.equal(made.members.length, 3);
  const copies = () => F.instancesOf(doc).filter((i) => i.pattern === made.item.id).sort((a, b) => a.index - b.index);
  assert.deepEqual(copies().map((i) => i.transform[3]), [35, 60, 85]);
  assert.deepEqual(copies().map((i) => i.name), ["Post 2", "Post 3", "Post 4"]);
  // the seed is moved and turned a quarter about z: the solver carries the copies with it, as one rigid thing
  const moved = M.transformOf(pose([10, 50, 0], [0, 0, 1], 90));
  apply(doc, E.setTransforms(doc, new Map([["seed", moved]])));
  const p = P.buildProblem(F.instancesOf(doc), F.matesOf(doc), connectors, G.MATES, GEOM, undefined, { patterns: X.patternsOf(doc) });
  const s = P.solveProblem(p, { analyze: true });
  assert.equal(s.result.ok, true);
  assert.equal(Array.from(s.mates.keys()).filter(P.isPatternMate).length, 0, "the welds are the solver's, not mates a person sees");
  const c3 = s.result.poses.get(copies()[2].id);
  near(c3.p[0], 10, 1e-6); near(c3.p[1], 50 + 75, 1e-6, "the row turned with the seed:");
  assert.equal(s.result.bodies.get(copies()[0].id).dof, 6); assert.equal(s.result.dof, 6, "seed and copies are one free body");
  // fewer, then more
  apply(doc, X.updatePattern(doc, made.item.id, { count: 2 }));
  assert.equal(copies().length, 1);
  apply(doc, X.updatePattern(doc, made.item.id, { count: 3, spacing: 10 }));
  assert.equal(copies().length, 2);
  near(M.len(M.sub(M.poseOf(copies()[1].transform).p, [10, 50, 0])), 20, 1e-6);
  // a mate on a copy goes when the copy does; deleting the seed takes the copies and the pattern
  apply(doc, E.addMate(doc, { mateType: "ball", name: "Ball 1", a: { instance: "other", ref: { kind: "face", body: "other", name: "c" } }, b: { instance: copies()[1].id, ref: { kind: "face", body: "seed", name: "c" } }, params: {} }, "onCopy").changes);
  apply(doc, X.updatePattern(doc, made.item.id, { count: 2 }));
  assert.equal(F.matesOf(doc).length, 0);
  apply(doc, E.deleteItems(doc, ["seed"]));
  assert.equal(F.instancesOf(doc).length, 1); assert.equal(X.patternsOf(doc).length, 0);
});

test("a circular pattern about an axis; dissolving it leaves plain instances", () => {
  const seed = inst("seed", "Bolt", at(20, 0, 0), {});
  const doc = docOf([seed]);
  const made = X.addPattern(doc, { patternType: "circular", seeds: ["seed"], count: 6, angle: 60, frames: X.patternFrames(doc, ["seed"], { origin: [0, 0, 0], axis: [0, 0, 1] }) });
  apply(doc, made.changes);
  const copies = F.instancesOf(doc).filter((i) => i.pattern === made.item.id).sort((a, b) => a.index - b.index);
  assert.equal(copies.length, 5);
  near(copies[0].transform[3], 10, 1e-6); near(copies[0].transform[7], 20 * Math.sin(rad(60)), 1e-6);
  near(copies[2].transform[3], -20, 1e-6); near(copies[2].transform[7], 0, 1e-6);
  near(copies[2].transform[0], -1, 1e-9, "each copy is turned as well as moved:");
  apply(doc, X.dissolvePattern(doc, made.item.id));
  assert.equal(X.patternsOf(doc).length, 0); assert.equal(F.instancesOf(doc).length, 6);
  assert.ok(F.instancesOf(doc).every((i) => i.pattern === undefined && i.seed === undefined));
});

test("saved exploded views, folders, and the order of the list", () => {
  const doc = docOf([inst("a", "A"), inst("b", "B"), inst("c", "C"), inst("d", "D")]);
  const ex = X.addExplode(doc, new Map([["a", [0, 0, 30]], ["b", [0, 0, 0]], ["c", [12.5, 0, 0]]]));
  apply(doc, ex.changes);
  assert.equal(ex.item.name, "Exploded view 1"); assert.deepEqual(X.explodesOf(doc)[0].offsets, { a: [0, 0, 30], c: [12.5, 0, 0] });
  apply(doc, X.updateExplode(doc, ex.item.id, new Map([["d", [1, 2, 3]]])));
  assert.deepEqual(X.explodesOf(doc)[0].offsets, { d: [1, 2, 3] });
  const names = () => F.instancesOf(doc).map((i) => i.name).join("");
  apply(doc, X.moveInstances(doc, ["d"], "a"));
  assert.equal(names(), "DABC");
  apply(doc, X.moveInstances(doc, ["a", "d"], null));
  assert.equal(names(), "BCAD");
  const folder = X.addFolder(doc);
  apply(doc, folder.changes);
  assert.equal(folder.group.name, "Folder 1");
  apply(doc, X.moveInstances(doc, ["c", "b"], null, folder.group.id));
  assert.equal(names(), "ADCB"); assert.deepEqual(F.instancesOf(doc).filter((i) => i.group === folder.group.id).map((i) => i.name), ["C", "B"]);
  apply(doc, X.moveInstances(doc, ["a"], "b"));   // before B, which is in the folder: A joins it
  assert.equal(F.instancesOf(doc).find((i) => i.name === "A").group, folder.group.id);
  apply(doc, X.moveInstances(doc, ["a"], null, null));
  assert.equal(F.instancesOf(doc).find((i) => i.name === "A").group, undefined);
  apply(doc, E.deleteItems(doc, [ex.item.id]));
  assert.equal(X.explodesOf(doc).length, 0);
});

test("mass properties add up where the instances stand; Measure between two connectors", () => {
  const MS = load("domains/assembly/services/mass.ts");
  const body = { volume: 1000, mass: 0.0027, centre: [5, 0, 0] };
  const rows = [MS.placeMass("a", "A", body, at(0, 0, 0)), MS.placeMass("b", "B", body, at(100, 0, 0)), MS.placeMass("c", "C", { volume: 2000, mass: 0.0054, centre: [0, 0, 0] }, at(0, 60, 0))];
  const t = MS.totalMass(rows);
  assert.equal(t.count, 3); near(t.volume, 4000); near(t.mass, 0.0108, 1e-12); assert.equal(t.centreBy, "mass");
  near(t.centre[0], (5 + 105) / 4, 1e-9); near(t.centre[1], 30, 1e-9);
  // one part without a material: the mass is of the others, and the centre is by volume
  const some = MS.totalMass([...rows, MS.placeMass("d", "D", { volume: 4000, mass: null, centre: [0, 0, 10] }, at(0, 0, 0))]);
  assert.equal(some.unweighed, 1); assert.equal(some.centreBy, "volume"); near(some.centre[2], 5, 1e-9); near(some.mass, 0.0108, 1e-12);
  assert.equal(MS.totalMass([]).centre, null);
  // two parallel planes 5 apart; a plane and an axis lying in it; two crossing axes
  const plane = (z) => ({ o: [3, 4, z], z: [0, 0, 1], surface: "plane" });
  let m = MS.measureFrames(plane(10), { ...plane(15), o: [40, 0, 15] });
  near(m.angle, 0); near(m.apart, 5); near(m.distance, Math.hypot(37, 4, 5), 1e-9);
  m = MS.measureFrames(plane(0), { o: [0, 0, 7], z: [1, 0, 0], surface: "line" });
  near(m.angle, 0, 1e-9, "a line lying along a plane is at no angle to it:"); assert.equal(m.apart, null);
  m = MS.measureFrames({ o: [0, 0, 0], z: [1, 0, 0], surface: "cylinder" }, { o: [0, 9, 0], z: [0, 0, 1], surface: "cylinder" });
  near(m.angle, 90, 1e-9);
  m = MS.measureFrames({ o: [0, 0, 0], z: [0, 0, 1], surface: "cylinder" }, { o: [3, 4, 20], z: [0, 0, -1], surface: "circle" });
  near(m.apart, 5, 1e-9, "two parallel axes:");
  assert.equal(MS.measureFrames({ o: [0, 0, 0], z: [0, 0, 1], surface: "point" }, plane(3)).angle, null);
});

test("Replicate finds the holes like the one a mate is in", () => {
  const K = load("domains/assembly/model/replicate.ts"), C = load("domains/assembly/connectors/infer.ts");
  // a mesh by hand: four circular rims of radius 3 in the plane z = 10, one of radius 5, and one of radius 3 at z = 0
  const ring = (cx, cy, z, r) => { const out = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * 2 * Math.PI, b = ((i + 1) / 24) * 2 * Math.PI; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a), z, cx + r * Math.cos(b), cy + r * Math.sin(b), z); } return out; };
  const rims = [["h0", 20, 20, 10, 3], ["h1", 100, 20, 10, 3], ["h2", 20, 60, 10, 3], ["h3", 100, 60, 10, 3], ["big", 60, 40, 10, 5], ["under", 20, 20, 0, 3]];
  const positions = [], start = [], count = [];
  for (const [, x, y, z, r] of rims) { start.push(positions.length / 3); const p = ring(x, y, z, r); count.push(p.length / 3); positions.push(...p); }
  const mesh = { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), faces: { names: [], start: new Uint32Array(0), count: new Uint32Array(0) }, edges: { names: rims.map((r) => r[0]), positions: Float32Array.from(positions), start: Uint32Array.from(start), count: Uint32Array.from(count) }, vertices: { names: [], positions: new Float32Array(0) }, bbox: [0, 0, 0, 120, 80, 10] };
  const f = C.connectorOf(mesh, { kind: "edge", name: "h2" });
  assert.equal(f.surface, "circle"); near(f.radius, 3, 1e-3);
  const found = K.matchingRefs(mesh, { kind: "edge", body: "plate", name: "h2" });
  assert.deepEqual(found.map((r) => r.name), ["h0", "h3", "h1"], "the three other rims of that size in that plane, the nearest first; not the bigger one, not the far end of the same hole");
  assert.ok(found.every((r) => r.body === "plate" && r.kind === "edge"));
  assert.deepEqual(K.matchingRefs(mesh, { kind: "edge", body: "plate", name: "big" }), []);
});
