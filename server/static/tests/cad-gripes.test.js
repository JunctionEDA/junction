// Node test for the pure logic behind the part studio's answers to the common complaints about browser CAD
// (web/domains/mechanical): a person's own keys (ui/keymap.ts), the marking menu's geometry (ui/marking.ts), the
// timeline's layout (ui/timeline-model.ts), what Press/Pull does with a pick (ui/press-pull.ts), the parameters
// table (document/parameters.ts), the undo history's words (ui/undo-labels.ts), the edits kept while offline
// (shared/itemdoc/journal.ts), selection sets (document/selection-sets.ts), the appearance library
// (document/materials-library.ts), batch export names (tools/_batch.ts), dual dimensions (document/dual-units.ts).
// Run: node server/static/tests/cad-gripes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");

// ---------------------------------------------------------------- keys
const K = load("domains/mechanical/ui/keymap.ts");
const CMDS = [
  { id: "measure", title: "Measure", context: "model", chord: "m" },
  { id: "sketch-mirror", title: "Mirror", context: "sketch", chord: "m" },
  { id: "sketch-line", title: "Line", context: "sketch", chord: "l" },
  { id: "f:extrude", title: "Extrude", context: "any", chord: "Shift+E" },
  { id: "f:shell", title: "Shell", context: "any", chord: null },
  { id: "delete", title: "Delete", context: "model", chord: "Delete" },
];

test("keys: a chord is read from a key event the way it is shown", () => {
  assert.equal(K.chordOf({ key: "m", code: "KeyM" }), "M");
  assert.equal(K.chordOf({ key: "E", code: "KeyE", shiftKey: true }), "Shift+E");
  assert.equal(K.chordOf({ key: "!", code: "Digit1", shiftKey: true }), "Shift+1", "the key, not what Shift made of it");
  assert.equal(K.chordOf({ key: "?", code: "Slash", shiftKey: true }), "?", "a symbol is its own key");
  assert.equal(K.chordOf({ key: "m", code: "KeyM", metaKey: true, altKey: true }), "Ctrl+Alt+M", "Cmd is Ctrl");
  assert.equal(K.chordOf({ key: "Delete", code: "Delete" }), "Del");
  assert.equal(K.chordOf({ key: "F8", code: "F8" }), "F8");
  assert.equal(K.chordOf({ key: "Shift", code: "ShiftLeft", shiftKey: true }), null, "a modifier alone is no chord");
  assert.equal(K.normalChord("shift + e"), "Shift+E");
  assert.equal(K.normalChord("Delete"), "Del");
  assert.equal(K.normalChord("hyper+e"), null);
});

test("keys: the defaults hold until a person changes them, and the same letter may mean two things", () => {
  const b = K.bindingsOf(CMDS);
  assert.deepEqual(b.map((x) => x.chord), ["M", "M", "L", "Shift+E", null, "Del"]);
  assert.deepEqual(K.conflictsOf(b), {}, "M outside a sketch and M inside one do not meet");
  assert.equal(K.commandFor(b, "M", false).id, "measure");
  assert.equal(K.commandFor(b, "M", true).id, "sketch-mirror", "in a sketch its own tool wins");
  assert.equal(K.commandFor(b, "Shift+E", true).id, "f:extrude");
  assert.equal(K.commandFor(b, "L", false), null, "a sketch tool is not heard outside a sketch");
  assert.equal(K.commandFor(b, "Del", true).id, "delete", "a part studio tool is heard in a sketch when no sketch tool has the key");
  assert.equal(K.commandFor(b, "M", true, (x) => x.context === "sketch").id, "sketch-mirror");
});

test("keys: giving a command a key takes it from whoever had it, and nothing that repeats a default is kept", () => {
  let r = K.rebind(CMDS, {}, "f:shell", "Shift+E");
  assert.deepEqual(r.taken, ["f:extrude"]);
  assert.deepEqual(r.overrides, { "f:shell": "Shift+E", "f:extrude": null });
  let b = K.bindingsOf(CMDS, r.overrides);
  assert.equal(b.find((x) => x.id === "f:extrude").chord, null);
  assert.equal(b.find((x) => x.id === "f:extrude").custom, true);
  assert.equal(b.find((x) => x.id === "f:extrude").default, "Shift+E");
  // back to the default: the chord is now on two commands, and that is shown, not hidden
  const back = K.resetBinding(r.overrides, "f:extrude");
  b = K.bindingsOf(CMDS, back);
  assert.deepEqual(K.conflictsOf(b), { "f:extrude": ["f:shell"], "f:shell": ["f:extrude"] });
  // a feature's key is heard everywhere, so it meets a sketch tool's
  r = K.rebind(CMDS, {}, "f:shell", "L");
  assert.deepEqual(r.taken, ["sketch-line"]);
  // a model tool may share with a sketch tool
  r = K.rebind(CMDS, {}, "measure", "L");
  assert.deepEqual(r.taken, []);
  // typing the default again leaves nothing stored
  r = K.rebind(CMDS, { measure: "X" }, "measure", "m");
  assert.deepEqual(r.overrides, {});
  assert.deepEqual(K.rebind(CMDS, {}, "nothing", "X").overrides, {});
  assert.deepEqual(K.rebind(CMDS, {}, "measure", null).overrides, { measure: null }, "a key can be taken away");
});

test("keys: the part studio's own keys and the browser's cannot be given away", () => {
  assert.match(K.chordProblem("S", "model"), /Search tools/);
  assert.match(K.chordProblem("F", "model"), /Zoom to fit/);
  assert.equal(K.chordProblem("F", "sketch"), null, "F is free in a sketch (Sketch fillet has it)");
  assert.match(K.chordProblem("Shift+7", "any"), /standard view/);
  assert.match(K.chordProblem("Ctrl+Z", "model"), /Undo/);
  assert.match(K.chordProblem("Ctrl+W", "model"), /browser/);
  assert.equal(K.chordProblem("Ctrl+Alt+M", "model"), null);
  assert.equal(K.chordProblem("Q", "model"), null);
  assert.ok(K.chordProblem(null, "model"));
  // no default of the part studio is one of its reserved keys
  for (const c of CMDS) { const ch = K.normalChord(c.chord); if (ch) assert.equal(K.chordProblem(ch, c.context), null, c.id); }
});

test("keys: what is stored is checked on the way in", () => {
  assert.deepEqual(K.cleanOverrides({ a: "shift+q", b: null, c: 7, d: "", e: "x".repeat(60) }), { a: "Shift+Q", b: null });
  assert.deepEqual(K.cleanOverrides("nonsense"), {});
  assert.deepEqual(K.cleanOverrides([1, 2]), {});
});

// ---------------------------------------------------------------- Press/Pull
const PP = load("domains/mechanical/ui/press-pull.ts");
test("press/pull: what a pick calls for", () => {
  assert.equal(PP.pullFor({ kind: "face" }, true).feature, "extrude");
  assert.deepEqual([PP.pullFor({ kind: "face" }, false).feature, PP.pullFor({ kind: "face" }, false).params], ["move-face", { type: "offset" }]);
  assert.ok(PP.pullFor({ kind: "face" }, false, () => false).why, "a build without Move face says so");
  assert.equal(PP.pullFor({ kind: "edge" }, false).feature, "fillet");
  assert.equal(PP.pullFor({ kind: "sketch", region: "r1", entity: null }, true).feature, "extrude");
  assert.equal(PP.pullFor({ kind: "sketch", region: null, entity: null }, true).feature, "extrude", "a whole sketch");
  assert.ok(PP.pullFor({ kind: "sketch", region: null, entity: "l1" }, true).why, "a curve of a sketch is not a region");
  assert.ok(PP.pullFor({ kind: "vertex" }, false).why);
  assert.ok(PP.pullFor({ kind: "plane" }, true).why);
});

// ---------------------------------------------------------------- the marking menu
const MK = load("domains/mechanical/ui/marking.ts");
test("marking menu: eight directions, a dead middle, up first and clockwise", () => {
  assert.equal(MK.wedgeAt(0, -50), 0);    // N
  assert.equal(MK.wedgeAt(40, -40), 1);   // NE
  assert.equal(MK.wedgeAt(50, 0), 2);     // E
  assert.equal(MK.wedgeAt(0, 50), 4);     // S
  assert.equal(MK.wedgeAt(-50, 2), 6);    // W
  assert.equal(MK.wedgeAt(-40, -40), 7);  // NW
  assert.equal(MK.wedgeAt(5, 5), -1, "the middle chooses nothing");
  for (let i = 0; i < 8; i++) { const p = MK.wedgePlace(i); assert.equal(MK.wedgeAt(p.x / 1.18, p.y), i, `a label is in its own wedge (${i})`); }
});
test("marking menu: a flick is short, quick and straight", () => {
  assert.equal(MK.flickWedge(80, 0, 120), 2);
  assert.equal(MK.flickWedge(60, -60, 200), 1);
  assert.equal(MK.flickWedge(80, 0, 400), -1, "slow: that is turning the view");
  assert.equal(MK.flickWedge(20, 0, 80), -1, "too short to have a direction");
  assert.equal(MK.flickWedge(600, 0, 80), -1, "too long");
  assert.equal(MK.flickWedge(80, 0, 120, 200), -1, "a wiggle");
});
test("marking menu: the tools follow the mode, and the ring and its list stay on screen", () => {
  const model = MK.markingSlots("model"), sketch = MK.markingSlots("sketch"), dialog = MK.markingSlots("dialog");
  assert.equal(model.length, 8); assert.equal(sketch.length, 8); assert.equal(dialog.length, 8);
  assert.equal(model[6], "undo"); assert.equal(sketch[6], "undo");
  assert.equal(model[0], MK.REPEAT); assert.equal(sketch[4], MK.FINISH); assert.equal(dialog[0], MK.ACCEPT); assert.equal(dialog[4], MK.CANCEL);
  assert.equal(MK.markingSlots("model", { edge: true })[5], "f:chamfer");
  for (const [x, y] of [[5, 5], [1495, 895], [700, 400], [700, 880], [1490, 10]]) {
    const p = MK.markingPlace(x, y, 1500, 900, 400);
    assert.ok(p.cx >= 150 && p.cx <= 1350 && p.cy >= 100 && p.cy <= 800, `the ring is on screen for ${x},${y}`);
    assert.ok(p.listTop >= 6 && p.listTop + 400 <= 900 && p.listLeft >= 6 && p.listLeft + 220 <= 1500, `the list is on screen for ${x},${y}`);
    const clearY = p.listTop >= p.cy + 96 || p.listTop + 400 <= p.cy - 96, clearX = p.listLeft >= p.cx + 113 || p.listLeft + 220 <= p.cx - 113;
    assert.ok(clearY || clearX, `the list is clear of the ring for ${x},${y}`);
  }
});

// ---------------------------------------------------------------- the timeline
const TL = load("domains/mechanical/ui/timeline-model.ts");
const FO = load("domains/mechanical/document/folders.ts");
test("timeline: cells in build order, folders as brackets or one cell, the marker and what a drag means", () => {
  const f = (id, order, folder) => ({ id, type: "feature", featureType: "extrude", name: id, order, params: {}, ...(folder ? { folder } : {}) });
  const features = [f("a", "A"), f("b", "B", "g"), f("c", "C", "g"), f("d", "D", "h"), f("e", "E")];
  const folders = new Map([["g", { id: "g", type: "folder", name: "G" }], ["h", { id: "h", type: "folder", name: "H", parent: "g" }]]);
  const tree = FO.featureTree(features, folders);
  let t = TL.timelineOf(tree);
  assert.deepEqual(t.cells.map((c) => c.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(t.spans.map((s) => [s.id, s.from, s.to, s.depth]).sort(), [["g", 1, 3, 0], ["h", 3, 3, 1]]);
  assert.deepEqual(TL.markerSlot(t.cells, 5), { slot: 5, inside: false });
  assert.deepEqual(TL.markerSlot(t.cells, 2), { slot: 2, inside: false });
  assert.deepEqual(TL.markerSlot(t.cells, 0), { slot: 0, inside: false });
  assert.equal(TL.rollbackAt(t.cells, 3, 5), 3); assert.equal(TL.rollbackAt(t.cells, 5, 5), 5); assert.equal(TL.rollbackAt(t.cells, 99, 5), 5);
  // folded: one cell for the folder and everything in it
  t = TL.timelineOf(tree, new Set(["g"]));
  assert.deepEqual(t.cells.map((c) => [c.kind, c.id]), [["feature", "a"], ["folder", "g"], ["feature", "e"]]);
  assert.equal(t.cells[1].count, 3);
  assert.deepEqual(TL.markerSlot(t.cells, 2), { slot: 1, inside: true }, "a bar inside a folded folder stands before it");
  assert.equal(TL.cellBuilt(t.cells[1], 2), "part"); assert.equal(TL.cellBuilt(t.cells[1], 4), "yes"); assert.equal(TL.cellBuilt(t.cells[2], 4), "no");
  assert.equal(TL.rollbackAt(t.cells, 2, 5), 4, "the gap after a folded folder is after its last feature");
  assert.equal(TL.rollbackAt(t.cells, 1, 5), 1);
  assert.equal(TL.slotAt(44, 0, 30, 5), 1); assert.equal(TL.slotAt(46, 0, 30, 5), 2); assert.equal(TL.slotAt(-9, 0, 30, 5), 0); assert.equal(TL.slotAt(999, 0, 30, 5), 5);
  assert.deepEqual(TL.timelineOf(FO.featureTree([], new Map())), { cells: [], spans: [] });
});

// ---------------------------------------------------------------- the parameters table
const PM = load("domains/mechanical/document/parameters.ts");
test("parameters: one table of variables, feature values and sketch dimensions, changed where they live", () => {
  const ID2 = load("shared/itemdoc/itemdoc.ts");
  const schema = [{ key: "depth", label: "Depth", kind: "number", unit: "mm", min: 0.001 }, { key: "angle", label: "Draft", kind: "number", unit: "deg", visible: (p) => !!p.draft }, { key: "flip", label: "Flip", kind: "boolean" }];
  const schemaOf = (t) => (t === "extrude" ? schema : []);
  const sketch = { version: 1, entities: { p1: { type: "point", x: 0, y: 0 }, p2: { type: "point", x: 40, y: 0 }, l1: { type: "line", a: "p1", b: "p2" } }, constraints: { d1: { type: "distance", refs: [], value: 40 }, d2: { type: "distance", refs: [], value: 7, driving: false }, k1: { type: "horizontal", refs: [] }, a1: { type: "angle", refs: [], value: 30, expr: "15 * 2" } } };
  const doc = ID2.newItemDoc("part-studio", [
    { id: "studio", type: "studio", units: "mm", rollback: null },
    { id: "v1", type: "variable", name: "wall", expr: "2 mm", order: "A" }, { id: "v2", type: "variable", name: "n", expr: "wall * 2", order: "B" },
    { id: "s1", type: "feature", featureType: "sketch", name: "Sketch 1", order: "A", params: { sketch } },
    { id: "e1", type: "feature", featureType: "extrude", name: "Extrude 1", order: "B", params: { depth: 4, angle: 3, $expr: { depth: "wall * 2" } } },
  ]);
  const mm = { length: "mm", angle: "deg", places: 3 }, inch = { length: "in", angle: "deg", places: 3 };
  let rows = PM.parameterRows(doc, schemaOf, mm);
  assert.deepEqual(rows.map((r) => r.key), ["v:v1", "v:v2", "d:s1:a1", "d:s1:d1", "f:e1:depth"], "a reference dimension, a hidden field and a checkbox are not parameters");
  assert.deepEqual(rows.map((r) => [r.text, r.value, r.unit]), [["2 mm", 2, "mm"], ["wall * 2", 4, "mm"], ["15 * 2", 30, "°"], ["40", 40, "mm"], ["wall * 2", 4, "mm"]]);
  assert.equal(PM.parameterRows(doc, schemaOf, inch).find((r) => r.key === "d:s1:d1").text, "1.574803", "a plain number is shown in the document's unit");
  assert.equal(PM.parameterRows(null, schemaOf).length, 0);
  const apply = (r) => { assert.ok(r.ok, r.error); ID2.applyChanges(doc, r.changes); };
  // a feature's value: a number, an expression, a unit typed with it
  apply(PM.editParameter(doc, "f:e1:depth", "12", schemaOf, mm));
  assert.deepEqual([doc.items.get("e1").params.depth, doc.items.get("e1").params.$expr], [12, undefined], "a plain number leaves no expression behind");
  apply(PM.editParameter(doc, "f:e1:depth", "wall + 1 in", schemaOf, mm));
  assert.deepEqual([doc.items.get("e1").params.depth, doc.items.get("e1").params.$expr], [27.4, { depth: "wall + 1 in" }]);
  apply(PM.editParameter(doc, "f:e1:depth", "n / 2", schemaOf, inch));
  assert.deepEqual([doc.items.get("e1").params.depth, doc.items.get("e1").params.$unit], [2, { depth: "in" }], "an expression records the unit its bare numbers were typed in");
  assert.match(PM.editParameter(doc, "f:e1:depth", "0", schemaOf, mm).error, /at least/);
  assert.match(PM.editParameter(doc, "f:e1:depth", "wall +", schemaOf, mm).error, /number/);
  assert.ok(PM.editParameter(doc, "f:gone:depth", "1", schemaOf, mm).error);
  assert.ok(PM.editParameter(doc, "f:e1:flip", "1", schemaOf, mm).error);
  assert.ok(PM.editParameter(doc, "f:e1:depth", "  ", schemaOf, mm).error);
  // a variable: what uses it follows; one that would need itself is refused
  apply(PM.editParameter(doc, "v:v1", "5 mm", schemaOf, mm));
  assert.equal(doc.items.get("v1").expr, "5 mm");
  assert.equal(doc.items.get("e1").params.depth, 5, "n / 2 with n = wall * 2");
  assert.ok(PM.editParameter(doc, "v:v1", "n + 1", schemaOf, mm).error, "a ring of variables");
  assert.ok(PM.editParameter(doc, "v:nope", "1", schemaOf, mm).error);
  // a sketch dimension: handed back to be solved, never stored unsolved
  const d = PM.editParameter(doc, "d:s1:d1", "wall * 10", schemaOf, mm);
  assert.ok(d.ok && d.solve && !d.changes);
  assert.deepEqual([d.solve.data.constraints.d1.value, d.solve.data.constraints.d1.expr], [50, "wall * 10"]);
  assert.equal(doc.items.get("s1").params.sketch.constraints.d1.value, 40, "the document is untouched until the sketch is solved");
  assert.equal(PM.editParameter(doc, "d:s1:d1", "55", schemaOf, mm).solve.data.constraints.d1.expr, undefined);
  assert.match(PM.editParameter(doc, "d:s1:d1", "-3", schemaOf, mm).error, /more than zero/);
  ID2.applyChanges(doc, PM.storeSolvedSketch(doc, "s1", d.solve.data));
  assert.equal(doc.items.get("s1").params.sketch.constraints.d1.value, 50);
  // comments and stars: one item, one path each
  let c = PM.setParamNote(doc, "d:s1:d1", { comment: " Overall width ", favourite: true });
  assert.equal(c[0].kind, "ADDED"); ID2.applyChanges(doc, c);
  c = PM.setParamNote(doc, "f:e1:depth", { comment: "Wall" });
  assert.deepEqual(c[0].props, [{ path: ["comments", "f:e1:depth"], value: "Wall" }]); ID2.applyChanges(doc, c);
  assert.deepEqual(PM.setParamNote(doc, "f:e1:depth", { comment: "Wall" }), [], "nothing changed, nothing sent");
  rows = PM.parameterRows(doc, schemaOf, mm);
  assert.deepEqual(rows.filter((r) => r.favourite).map((r) => r.key), ["d:s1:d1"]);
  assert.equal(rows.find((r) => r.key === "d:s1:d1").comment, "Overall width");
  assert.deepEqual(PM.filterRows(rows, "overall").map((r) => r.key), ["d:s1:d1"]);
  assert.deepEqual(PM.filterRows(rows, "extrude depth").map((r) => r.key), ["f:e1:depth"]);
  assert.deepEqual(PM.filterRows(rows, "", true).map((r) => r.key), ["d:s1:d1"]);
  ID2.applyChanges(doc, PM.setParamNote(doc, "d:s1:d1", { comment: "", favourite: false }));
  assert.deepEqual([doc.items.get(PM.NOTES_ID).comments, doc.items.get(PM.NOTES_ID).favourites], [{ "f:e1:depth": "Wall" }, {}]);
  assert.deepEqual(PM.setParamNote(ID2.newItemDoc("part-studio", []), "x", { comment: "" }), [], "no item is made to hold nothing");
});

// ---------------------------------------------------------------- export every part
const BT = load("domains/mechanical/tools/_batch.ts");
test("export every part: names from a template, never two the same, and a .zip that reads back", () => {
  const parts = [{ name: "Lid" }, { name: "Base/Tray" }, { name: "Lid" }];
  assert.deepEqual(BT.batchNames("{document} - {part}", "Box", parts, ".step"), ["Box - Lid.step", "Box - Base_Tray.step", "Box - Lid (2).step"]);
  assert.deepEqual(BT.batchNames("{n} {part}", "Box", parts, ".stl"), ["1 Lid.stl", "2 Base_Tray.stl", "3 Lid.stl"]);
  assert.deepEqual(BT.batchNames("{document}", "Box", parts, ".3mf"), ["Box.3mf", "Box (2).3mf", "Box (3).3mf"], "a template that names no part still gives each a file");
  assert.deepEqual(BT.batchNames("  ", "Box", parts.slice(0, 1), ".step"), ["Box - Lid.step"], "an empty template is the default");
  assert.equal(BT.batchNames("{n}", "B", Array.from({ length: 12 }, () => ({ name: "p" })), ".stl")[0], "01.stl", "numbers are padded so the files sort");
  assert.equal(BT.expandTemplate("{DATE} {part} {count} {what}", { document: "d", part: "P", index: 0, count: 3, date: "2026-03-09" }), "2026-03-09 P 3 {what}");
  assert.deepEqual(BT.unknownWords("{part} {parts} {x} {parts}"), ["{parts}", "{x}"]);
  assert.equal(BT.cleanName('a<b>:c?"d|e*. '), "a_b_c_d_e_");
  assert.equal(BT.cleanName("..."), "part");
  assert.equal(BT.isoDate(new Date(2026, 2, 9)), "2026-03-09");
  assert.equal(BT.crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  // the .zip: read back with the format's own rules
  const files = [{ name: "Box - Lid.step", data: "ISO-10303-21;" }, { name: "Bäse.stl", data: new Uint8Array([1, 2, 3, 4, 5]) }];
  const zip = BT.zipStore(files, new Date(2026, 2, 9, 10, 30, 0));
  const v = new DataView(zip.buffer), end = zip.length - 22;
  assert.equal(v.getUint32(end, true), 0x06054b50);
  assert.equal(v.getUint16(end + 10, true), 2);
  let at = v.getUint32(end + 16, true);
  const dec = new TextDecoder();
  for (const f of files) {
    assert.equal(v.getUint32(at, true), 0x02014b50);
    const size = v.getUint32(at + 24, true), nameLen = v.getUint16(at + 28, true), local = v.getUint32(at + 42, true);
    assert.equal(dec.decode(zip.subarray(at + 46, at + 46 + nameLen)), f.name);
    assert.equal(v.getUint32(local, true), 0x04034b50);
    const data = zip.subarray(local + 30 + v.getUint16(local + 26, true), local + 30 + v.getUint16(local + 26, true) + size);
    const want = typeof f.data === "string" ? new TextEncoder().encode(f.data) : f.data;
    assert.deepEqual(Array.from(data), Array.from(want));
    assert.equal(v.getUint32(at + 16, true), BT.crc32(want));
    at += 46 + nameLen;
  }
  assert.equal(at, end, "the directory ends where the end record begins");
  assert.equal(BT.zipStore([]).length, 22);
});

// ---------------------------------------------------------------- the appearance library
const ML = load("domains/mechanical/document/materials-library.ts");
const AI = load("domains/mechanical/document/appearance-items.ts");
test("appearance library: standard looks, stored as colour, metalness and roughness", () => {
  const ID3 = load("shared/itemdoc/itemdoc.ts");
  assert.ok(ML.APPEARANCES.length >= 24);
  assert.equal(new Set(ML.APPEARANCES.map((a) => a.id)).size, ML.APPEARANCES.length, "ids are unique");
  for (const a of ML.APPEARANCES) {
    assert.ok(AI.isColor(a.color) && /^[a-z0-9-]+$/.test(a.id) && a.name, a.id);
    assert.ok(a.metalness >= 0 && a.metalness <= 1 && a.roughness >= 0 && a.roughness <= 1 && (a.opacity === undefined || (a.opacity > 0 && a.opacity < 1)), a.id);
  }
  assert.deepEqual(ML.APPEARANCE_GROUPS, ["Metal", "Plastic", "Other"]);
  assert.ok(ML.findAppearances("alumin brush").some((a) => a.id === "aluminium-brushed"));
  assert.ok(ML.findAppearances("metal").every((a) => a.group === "Metal"));
  assert.equal(ML.findAppearances("").length, ML.APPEARANCES.length);
  const doc = ID3.newItemDoc("part-studio", []);
  const put = (targets, id) => { const c = ML.applyAppearance(doc, targets, id); ID3.applyChanges(doc, c); return c; };
  // a whole part
  assert.equal(put([{ kind: "body", body: "b1" }], "aluminium-brushed").length, 1);
  assert.deepEqual(AI.looksOf(doc).b1, { color: "#c8ccd0", metalness: 1, roughness: 0.38, appearance: "aluminium-brushed" });
  assert.equal(ML.appearanceOfBody(doc, "b1").id, "aluminium-brushed");
  // one face of another part: a face has a colour only
  put([{ kind: "face", body: "b2", name: "f:top" }], "brass");
  assert.deepEqual(AI.looksOf(doc).b2, { faces: { "f:top": "#c9a44c" } });
  // a see-through one, and a part with a face in one change
  const c = put([{ kind: "body", body: "b2" }, { kind: "face", body: "b1", name: "f:side" }, { kind: "face", body: "b2", name: "f:x" }], "acrylic-clear");
  assert.equal(c.length, 1, "one change: undone as one step");
  assert.deepEqual(AI.looksOf(doc).b2, { color: "#f2f8fa", opacity: 0.3, metalness: 0, roughness: 0.04, appearance: "acrylic-clear" }, "the part's own face colours give way");
  assert.deepEqual(AI.looksOf(doc).b1.faces, { "f:side": "#f2f8fa" });
  // an opaque appearance over a see-through one is opaque again
  put([{ kind: "body", body: "b2" }], "steel");
  assert.equal(AI.looksOf(doc).b2.opacity, undefined);
  // a colour mixed by hand afterwards: no longer the library's, the finish stays
  ID3.applyChanges(doc, AI.setBodyLook(doc, ["b2"], { color: "#ff0000" }));
  assert.deepEqual(AI.looksOf(doc).b2, { color: "#ff0000", metalness: 1, roughness: 0.42 });
  assert.equal(ML.appearanceOfBody(doc, "b2"), undefined);
  assert.deepEqual(ML.applyAppearance(doc, [{ kind: "body", body: "b1" }], "no-such"), []);
  assert.deepEqual(ML.applyAppearance(doc, [], "steel"), []);
  // nonsense in the file is dropped on the way in
  doc.items.get("appearance").bodies.b9 = { color: "#112233", metalness: 7, roughness: "x", appearance: 5 };
  assert.deepEqual(AI.looksOf(doc).b9, { color: "#112233", metalness: 1 });
});

// ---------------------------------------------------------------- selection sets and the selection filter
const SS = load("domains/mechanical/document/selection-sets.ts");
test("selection: sets kept by name follow the model, and a filter that cannot select nothing", () => {
  const ID4 = load("shared/itemdoc/itemdoc.ts");
  const doc = ID4.newItemDoc("part-studio", []);
  const picks = [{ kind: "face", body: "b1", name: "f1", point: [1, 2, 3] }, { kind: "edge", body: "b1", name: "e1" }, { kind: "face", body: "b1", name: "f1" }, { kind: "plane", plane: "top" }, { kind: "datum", featureId: "ax", datum: "axis" }, { kind: "sketch", featureId: "s1", region: "r" }, { kind: "vertex", body: "b2", name: "v1" }];
  assert.deepEqual(SS.packPicks(picks), [["f", "b1", "f1"], ["e", "b1", "e1"], ["p", "top"], ["d", "ax", "axis"], ["v", "b2", "v1"]], "once each, and no sketch regions");
  let r = SS.saveSelectionSet(doc, " Seal ", picks);
  assert.deepEqual([r.kept, r.left, r.changes[0].kind], [5, 2, "ADDED"]);
  ID4.applyChanges(doc, r.changes);
  assert.deepEqual(SS.selectionSets(doc).map((s) => [s.name, s.picks.length]), [["Seal", 5]]);
  // the same name again replaces the set, in its place
  r = SS.saveSelectionSet(doc, "seal", picks.slice(0, 2));
  assert.equal(r.changes[0].kind, "MODIFIED"); ID4.applyChanges(doc, r.changes);
  assert.deepEqual(SS.selectionSets(doc).map((s) => [s.name, s.picks.length]), [["seal", 2]]);
  ID4.applyChanges(doc, SS.saveSelectionSet(doc, "", picks.slice(3, 5)).changes);
  assert.deepEqual(SS.selectionSets(doc).map((s) => s.name), ["seal", "Selection 1"], "no name: the next free one, at the end");
  assert.equal(SS.nextSetName(doc), "Selection 2");
  assert.deepEqual(SS.saveSelectionSet(doc, "x", [{ kind: "sketch", featureId: "s1", region: "r" }]).changes, [], "nothing a set can keep: no set");
  // selecting a set: what is gone is left out and counted
  const model = { has: (k, b, n) => b === "b1" && n === "f1" && k === "face", hasPlane: (p) => p === "top", hasDatum: () => false };
  assert.deepEqual(SS.unpackPicks([["f", "b1", "f1"], ["e", "b1", "e1"], ["p", "top"], ["d", "ax", "axis"], ["x", 1], "junk"], model), { picks: [{ kind: "face", body: "b1", name: "f1" }, { kind: "plane", plane: "top" }], missing: 4 });
  const id = SS.selectionSets(doc)[0].id;
  ID4.applyChanges(doc, SS.renameSelectionSet(doc, id, "Gasket"));
  assert.equal(SS.selectionSets(doc)[0].name, "Gasket");
  assert.deepEqual(SS.renameSelectionSet(doc, id, " "), []);
  ID4.applyChanges(doc, SS.removeSelectionSet(doc, id));
  assert.deepEqual(SS.selectionSets(doc).map((s) => s.name), ["Selection 1"]);
  assert.deepEqual(SS.removeSelectionSet(doc, "nope"), []);
  // the filter
  assert.equal(SS.cleanFilter(null), null); assert.equal(SS.cleanFilter("face"), null); assert.equal(SS.cleanFilter([]), null);
  assert.deepEqual(SS.cleanFilter(["edge", "face", "bogus"]), ["face", "edge"]);
  assert.equal(SS.cleanFilter(SS.SELECT_KINDS.map((k) => k.id)), null, "every kind is no filter");
  assert.deepEqual(SS.toggleKind(null, "face"), ["edge", "vertex", "sketch", "plane", "datum"]);
  assert.deepEqual(SS.toggleKind(["face"], "edge"), ["face", "edge"]);
  assert.equal(SS.toggleKind(["face"], "face"), null, "taking the last kind away gives everything back");
  assert.equal(SS.filterLabel(null), "All"); assert.equal(SS.filterLabel(["face", "edge"]), "Faces, Edges"); assert.equal(SS.filterLabel(["face", "edge", "vertex"]), "3 kinds");
});

// ---------------------------------------------------------------- the history of edits
const UL = load("domains/mechanical/ui/undo-labels.ts");
const ID = load("shared/itemdoc/itemdoc.ts");
test("history of edits: a step in words", () => {
  const feat = (id, name, extra = {}) => ({ id, type: "feature", featureType: "extrude", name, order: "V", params: { depth: 5 }, ...extra });
  const doc = ID.newItemDoc("part-studio", [{ id: "studio", type: "studio", units: "mm", rollback: null }, feat("e1", "Extrude 1"), { id: "v1", type: "variable", name: "wall", expr: "2", order: "V" }]);
  const step = (redo) => { const undo = redo.map((c) => ID.invertChange(doc, c)).filter(Boolean).reverse(); return { redo, undo }; };
  const mod = (id, typeName, path, value) => ({ id, kind: "MODIFIED", typeName, props: [value === undefined ? { path, del: true } : { path, value }] });
  assert.equal(UL.describeStep(step([ID.addedChange(feat("f2", "Fillet 1"))]), doc), "Add Fillet 1");
  assert.equal(UL.describeStep(step([ID.addedChange(feat("f2", "Fillet 1")), mod("studio", "studio", ["rollback"], null)]), doc), "Add Fillet 1", "what came with it is not the step");
  assert.equal(UL.describeStep(step([ID.removedChange(doc.items.get("e1"))]), doc), "Delete Extrude 1", "the name comes from what takes the step back");
  assert.equal(UL.describeStep(step([mod("e1", "feature", ["params", "depth"], 9)]), doc), "Edit Extrude 1");
  assert.equal(UL.describeStep(step([mod("e1", "feature", ["name"], "Boss")]), doc), "Rename to Boss");
  assert.equal(UL.describeStep(step([mod("e1", "feature", ["suppressed"], true)]), doc), "Suppress Extrude 1");
  assert.equal(UL.describeStep(step([mod("e1", "feature", ["suppressed"])]), doc), "Unsuppress Extrude 1");
  assert.equal(UL.describeStep(step([mod("e1", "feature", ["order"], "X")]), doc), "Move Extrude 1");
  assert.equal(UL.describeStep(step([mod("studio", "studio", ["rollback"], "e1")]), doc), "Move the rollback bar");
  assert.equal(UL.describeStep(step([mod("studio", "studio", ["units"], "in")]), doc), "Change the units");
  assert.equal(UL.describeStep(step([mod("v1", "variable", ["expr"], "3"), mod("e1", "feature", ["params", "depth"], 3)]), doc), "Change variable wall");
  assert.equal(UL.describeStep(step([ID.addedChange({ id: "v2", type: "variable", name: "gap", expr: "1", order: "W" })]), doc), "Add variable gap");
  assert.equal(UL.describeStep(step([ID.addedChange(feat("a", "A")), ID.addedChange(feat("b", "B"))]), doc), "Add 2 features");
  assert.equal(UL.describeStep(step([mod("parts", "parts", ["names", "b1"], "Lid")]), doc), "Rename a part");
  assert.equal(UL.describeStep({ redo: [], undo: [] }, doc), "Nothing");
  assert.equal(UL.describeStep(step([mod("gone", "widget", ["x"], 1)]), null), "Change a widget", "something this does not know is still a step");
  assert.equal(UL.stepsTo(4, 3), 0); assert.equal(UL.stepsTo(4, 0), 3); assert.equal(UL.stepsTo(4, -1), 4); assert.equal(UL.stepsTo(2, 4), -3);
  assert.equal(UL.ago(1000, 4000), "just now"); assert.equal(UL.ago(0, 4000), ""); assert.equal(UL.ago(1000, 1000 + 125000), "2 min ago");
});

// ---------------------------------------------------------------- offline
const J = load("shared/itemdoc/journal.ts");
const OFF = load("domains/mechanical/ui/offline.ts");
test("offline: unsent edits are kept in the browser and read back checked", () => {
  const mem = { data: {}, getItem(k) { return k in this.data ? this.data[k] : null; }, setItem(k, v) { this.data[k] = v; }, removeItem(k) { delete this.data[k]; } };
  const j = J.storedJournal("doc1", mem);
  assert.deepEqual(j.load(), []);
  const ops = [{ clientOpId: "web:1", changes: [{ id: "e1", kind: "MODIFIED", typeName: "feature", props: [{ path: ["params", "depth"], value: 9 }] }] }, { clientOpId: "web:2", changes: [{ id: "x", kind: "REMOVED" }] }];
  j.save(ops);
  assert.equal(J.journalled("doc1", mem), 2);
  assert.deepEqual(J.storedJournal("doc1", mem).load(), ops, "the next session on the document reads them back");
  assert.deepEqual(J.storedJournal("doc2", mem).load(), [], "a journal is one document's");
  j.save([ops[1]]); assert.equal(J.journalled("doc1", mem), 1);
  j.save([]); assert.equal(mem.getItem(J.journalKey("doc1")), null, "nothing waiting, nothing kept");
  // what is in storage is not trusted
  assert.deepEqual(J.parseJournal("not json"), []);
  assert.deepEqual(J.parseJournal(JSON.stringify({ ops: "x" })), []);
  const dirty = { ops: [ops[0], { clientOpId: 7, changes: [] }, { clientOpId: "a", changes: [{ id: "q", kind: "EXPLODE" }] }, { clientOpId: "b", changes: [{ id: "q", kind: "ADDED", item: { id: "other", type: "t" } }] }, ops[0], { clientOpId: "c", changes: [] }] };
  assert.deepEqual(J.parseJournal(JSON.stringify(dirty)), [ops[0]]);
  // more than the browser will keep: said once, and nothing thrown
  let full = 0;
  const big = J.storedJournal("doc3", mem, () => full++);
  const huge = [{ clientOpId: "h", changes: [{ id: "t", kind: "MODIFIED", props: [{ path: ["x"], value: "y".repeat(J.JOURNAL_LIMIT) }] }] }];
  big.save(huge); big.save(huge);
  assert.equal(full, 1);
  // storage that throws (a private window): the session carries on
  const broken = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); }, removeItem() { throw new Error("no"); } };
  assert.deepEqual(J.storedJournal("d", broken).load(), []);
  J.storedJournal("d", broken).save(ops);
  assert.deepEqual(J.storedJournal("d", null).load(), []);
});
test("offline: what the banner says, and when it says nothing", () => {
  const base = { state: "live", loaded: true, unsaved: 0, cameBack: null, restored: 0, canEdit: true };
  assert.equal(OFF.offlineNotice(base), null);
  assert.equal(OFF.offlineNotice({ ...base, loaded: false, state: "connecting" }), null, "the first load is not being offline");
  assert.equal(OFF.offlineNotice({ ...base, state: "error" }), null, "an error is the status bar's to tell");
  let n = OFF.offlineNotice({ ...base, state: "offline" });
  assert.equal(n.kind, "offline"); assert.equal(n.text, "Offline"); assert.match(n.detail, /Keep working/);
  n = OFF.offlineNotice({ ...base, state: "connecting", unsaved: 3 });
  assert.equal(n.text, "Offline: 3 edits waiting"); assert.match(n.detail, /even if you close the tab/);
  assert.equal(OFF.offlineNotice({ ...base, state: "offline", unsaved: 1 }).text, "Offline: 1 edit waiting");
  assert.match(OFF.offlineNotice({ ...base, state: "offline", canEdit: false }).detail, /looking/);
  assert.equal(OFF.offlineNotice({ ...base, cameBack: 2, unsaved: 1 }), null, "not until everything is sent");
  assert.match(OFF.offlineNotice({ ...base, cameBack: 2 }).detail, /2 edits made offline were sent/);
  assert.equal(OFF.offlineNotice({ ...base, cameBack: 0 }), null, "nothing was waiting: nothing to say");
  assert.match(OFF.offlineNotice({ ...base, restored: 1 }).detail, /1 edit from your last visit was still waiting/);
});
