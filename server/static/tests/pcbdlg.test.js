// pcbdlg.test.js — the board dialogs' models: Set Track and Via Properties (pcb-tools/global-tracks.ts) and
// Filter Selected Items (pcb-tools/filter-selection.ts).
// Run: node server/static/tests/pcbdlg.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, T = globalThis.PcbTools;

const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (4 "In1.Cu" signal) (25 "Edge.Cuts" user) (5 "F.SilkS" user))
  (net 0 "") (net 1 "GND") (net 2 "VCC")
  (footprint "Lib:R" (layer "F.Cu") (uuid "fp1") (at 10 10) (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15)))))
  (footprint "Lib:R" (layer "F.Cu") (locked yes) (uuid "fp2") (at 20 10) (property "Reference" "R2" (at 0 0 0) (layer "F.SilkS") (uuid "r2") (effects (font (size 1 1) (thickness 0.15)))))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 0 1) (end 5 1) (width 0.2) (layer "B.Cu") (net 2) (uuid "s2"))
  (via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (via micro (at 2 2) (size 0.3) (drill 0.1) (layers "F.Cu" "In1.Cu") (net 1) (uuid "v2"))
  (gr_line (start 0 0) (end 30 0) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "e1"))
  (gr_line (start 0 5) (end 30 5) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "g1"))
  (gr_text "hi" (at 3 3 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
  (target plus (at 5 5) (size 5) (width 0.1) (layer "Edge.Cuts") (uuid "tg"))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const settings = () => T.designSettings({ net_settings: { classes: [{ name: "Default", track_width: 0.3, via_diameter: 0.7, via_drill: 0.35, microvia_diameter: 0.25, microvia_drill: 0.12, clearance: 0.2 }] } });
const ALL = { tracks: true, throughVias: true, microVias: true, blindVias: true, buriedVias: true };
const run = (job) => new Map(T.globalTrackViaChanges(doc(), Object.assign({ scope: ALL, filter: {}, specified: true, values: {}, settings: settings() }, job)).map((c) => [c.id, c]));
// a MODIFIED change carries the item as the board text it becomes
const nodeOf = (c) => { const t = K.parse(c.sexpr); return t[t.length - 1]; };
const kidv = (n, k, i = 1) => K.kid(n, k)[i];

test("specified track width and via size, net filter", () => {
  const m = run({ filter: { net: "GND" }, values: { trackWidth: 0.5, via: { diameter: 1.0, drill: 0.5 } } });
  assert.deepEqual([...m.keys()].sort(), ["s1", "v1", "v2"]);
  assert.equal(kidv(nodeOf(m.get("s1")), "width"), 0.5);
  assert.equal(kidv(nodeOf(m.get("v1")), "size"), 1); assert.equal(kidv(nodeOf(m.get("v1")), "drill"), 0.5);
  // a microvia takes the net class's uvia sizes (SetTrackSegmentWidth)
  assert.equal(kidv(nodeOf(m.get("v2")), "size"), 0.25); assert.equal(kidv(nodeOf(m.get("v2")), "drill"), 0.12);
});
test("scope, layer and width filters, leave unchanged", () => {
  assert.deepEqual([...run({ scope: { tracks: true }, values: { trackWidth: 0.5 } }).keys()].sort(), ["s1", "s2"]);
  assert.deepEqual([...run({ filter: { layer: "B.Cu" }, values: { trackWidth: 0.5 } }).keys()], ["s2"]);
  assert.deepEqual([...run({ filter: { trackWidth: 0.25 }, values: { trackWidth: 0.5 } }).keys()], ["s1"]);
  assert.deepEqual([...run({ scope: { microVias: true }, filter: { viaDiameter: 0.8 }, values: { via: { diameter: 1, drill: 0.5 } } }).keys()], []);
  assert.equal(run({ values: {} }).size, 0, "nothing specified changes nothing");
  assert.deepEqual([...run({ filter: { selection: new Set(["s2"]) }, values: { trackWidth: 0.5 } }).keys()], ["s2"]);
});
test("layer, annular rings and protection on vias", () => {
  const m = run({ values: { layer: "In1.Cu", annular: 2, protection: 3 } });
  assert.equal(kidv(nodeOf(m.get("s1")), "layer"), "In1.Cu");
  const v = K.serialize(nodeOf(m.get("v1")));
  assert.ok(v.includes("(remove_unused_layers yes)") && v.includes("(keep_end_layers no)"), v);
  assert.ok(/\(tenting/.test(v), v);
  assert.ok(!K.serialize(nodeOf(m.get("v1"))).includes("In1.Cu"), "a via keeps its layers");
});
test("net class values", () => {
  const m = run({ specified: false });
  assert.equal(kidv(nodeOf(m.get("s1")), "width"), 0.3);
  assert.equal(kidv(nodeOf(m.get("v1")), "size"), 0.7); assert.equal(kidv(nodeOf(m.get("v1")), "drill"), 0.35);
  assert.equal(kidv(nodeOf(m.get("v2")), "size"), 0.25);
});
test("Filter Selected Items: KiCad's eight options", () => {
  const d = doc(), all = [...d.items.keys()], D = T.FILTER_SELECTION_DEFAULTS;
  const keep = (o) => T.filterSelectionIds(d, all, Object.assign({}, D, o)).sort();
  assert.ok(keep({}).includes("fp2") && keep({}).includes("tg"));
  assert.deepEqual(keep({ includeLockedFootprints: false }).filter((i) => i.startsWith("fp")), ["fp1"]);
  assert.deepEqual(keep({ includeFootprints: false }).filter((i) => i.startsWith("fp")), []);
  const edgeOff = keep({ includeBoardOutlineLayer: false });
  assert.ok(!edgeOff.includes("e1") && !edgeOff.includes("tg") && edgeOff.includes("g1"));
  const off = Object.fromEntries(Object.keys(D).map((k) => [k, false]));
  assert.deepEqual(keep(Object.assign({}, off, { includeVias: true })), ["v1", "v2"]);
  assert.deepEqual(keep(Object.assign({}, off, { includePcbTexts: true })), ["t1"]);
  assert.deepEqual(keep(Object.assign({}, off, { includeZones: true, includeTracks: true })), ["s1", "s2", "z1"]);
});
