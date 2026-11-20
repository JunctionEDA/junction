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
