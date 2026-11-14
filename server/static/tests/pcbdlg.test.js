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
test("Zone Manager: automatically assign zone priorities", () => {
  const Z = (net, name, x0, y0, x1, y1, prio) => `(zone (net ${net}) (net_name "${name}") (layer "F.Cu") (uuid "z${name}")${prio ? ` (priority ${prio})` : ""} (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))))`;
  const board = (zones, extra = "") => K.parseDoc(`(kicad_pcb (version 20241229) (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (net 0 "") (net 1 "GND") (net 2 "VCC") ${zones} ${extra})`, "kicad_pcb");
  // the small VCC zone inside the big GND one, both without pads: the smaller zone wins
  let d = board(Z(1, "GND", 0, 0, 50, 50, 1) + Z(2, "VCC", 10, 10, 20, 20, 0));
  let p = T.autoZonePriorities(d);
  assert.ok(p.get("zVCC") > p.get("zGND"), JSON.stringify([...p]));
  // already in that order: nothing changes
  assert.equal(T.autoZonePriorities(board(Z(1, "GND", 0, 0, 50, 50, 0) + Z(2, "VCC", 10, 10, 20, 20, 1))), null);
  // GND vias in the overlap outnumber the VCC ones: GND goes on top
  const vias = [11, 12, 13, 14].map((x, i) => `(via (at ${x} 15) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v${i}"))`).join(" ");
  d = board(Z(1, "GND", 0, 0, 50, 50, 0) + Z(2, "VCC", 10, 10, 20, 20, 1), vias);
  p = T.autoZonePriorities(d);
  assert.ok(p.get("zGND") > p.get("zVCC"), JSON.stringify([...p]));
  // apart: no overlap, no change
  assert.equal(T.autoZonePriorities(board(Z(1, "GND", 0, 0, 5, 5, 0) + Z(2, "VCC", 10, 10, 20, 20, 1))), null);
});

test("Footprint Properties 3D Models: models and the extruded body read and written", () => {
  const M = T.fpModels;
  const fp = K.parse(`(footprint "Lib:C" (layer "F.Cu") (uuid "f") (at 0 0) (descr "d") (property "Reference" "C1" (at 0 0 0) (layer "F.SilkS") (uuid "r"))
    (model "\${KICAD10_3DMODEL_DIR}/A.3dshapes/a.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
    (embedded_files (file (name "a.pdf") (type datasheet) (data |abc|)) (file (name "b.step") (type model) (data |def|))))`);
  const models = M.readModels(fp);
  assert.equal(models.length, 1);
  assert.equal(M.readExtruded(fp), null);
  const before = K.serialize(fp);
  assert.equal(M.writeModels(fp, models, null), false, "unchanged models leave the node alone");
  assert.equal(K.serialize(fp), before);
  models[0].show = false;
  assert.ok(M.writeModels(fp, models, { show: true, height: 3, standoff: 0.5, layer: "F.CrtYd", material: "metal", color: null }));
  const t = K.serialize(fp);
  assert.match(t, /\(model "\$\{KICAD10_3DMODEL_DIR\}\/A\.3dshapes\/a\.step" \(hide yes\)/);
  assert.match(t, /\(model \(type extruded\) \(uuid "[^"]+"\) \(hide no\) \(overall_height 3\) \(body_pcb_gap 0\.5\) \(layer "F\.CrtYd"\) \(material metal\) \(color unspecified\)/);
  assert.ok(t.indexOf("(type extruded)") < t.indexOf("a.step"), "the body goes before the file models");
  const e = M.readExtruded(fp);
  assert.equal(e.height, 3); assert.equal(e.material, "metal"); assert.equal(e.layer, "F.CrtYd");
  // removing the body
  assert.ok(M.writeModels(fp, M.readModels(fp), null));
  assert.equal(M.readExtruded(fp), null);
  // embedded files: only removal
  assert.deepEqual(M.embeddedFileNames(fp), ["a.pdf", "b.step"]);
  assert.ok(M.keepEmbeddedFiles(fp, ["b.step"]));
  assert.deepEqual(M.embeddedFileNames(fp), ["b.step"]);
  assert.ok(M.keepEmbeddedFiles(fp, []));
  assert.equal(K.kid(fp, "embedded_files"), null);
});

test("Constraints Resolution: board setup, net class and custom rules in EvalRules order", () => {
  const d = doc(), s = settings();
  s.minTrackWidth = 0.1; s.minViaDiameter = 0.4; s.minThroughDrill = 0.2; s.minViaAnnular = 0.1;
  T.setCustomRules('(version 1)\n(rule wide (constraint track_width (min 0.3mm) (opt 0.4mm)) (condition "A.NetName == \'GND\'"))\n(rule other (constraint track_width (min 1mm)) (condition "A.NetName == \'VCC\'"))');
  try {
    const p = T.inspectConstraints(d, "s1", s);
    assert.equal(p.length, 1); assert.equal(p[0].title, "Track Width");
    const t = p[0].lines.join("\n");
    assert.match(t, /Checking board setup constraints track width: min 0\.1 mm\.\nUnconditional constraint applied\./);
    assert.match(t, /Checking netclass 'Default' track width: opt 0\.3 mm\.\nConstraint applied\./);
    assert.match(t, /Checking rule 'wide': min 0\.3 mm; opt 0\.4 mm; max <i>undefined<\/i>\.\nChecking rule condition 'A\.NetName == 'GND''\.\nRule applied; overrides previous constraints\./);
    assert.match(t, /Checking rule 'other'[^\n]*\n[^\n]*\nCondition not satisfied; rule ignored\./);
    assert.equal(p[0].resolved, "Resolved width constraints: min 0.3 mm; opt 0.4 mm; max <i>undefined</i>.");
    // a microvia: the micro-via board setup constraint and the uvia net class sizes
    const v = T.inspectConstraints(d, "v2", s);
    assert.deepEqual(v.map((x) => x.title), ["Via Diameter", "Via Annular Width", "Hole Size"]);
    assert.match(v[0].lines.join("\n"), /Checking netclass 'Default' uvia via diameter: opt 0\.25 mm\./);
    assert.match(T.inspectConstraints(d, "v1", s)[0].lines.join("\n"), /micro-via via diameter: min 0\.2 mm\.\nMembership not satisfied; constraint ignored\./);
    assert.equal(T.inspectConstraints(d, "fp1", s), null);
  } finally { T.setCustomRules(null); }
});

test("Compare Footprint with Library: FootprintNeedsUpdate's report lines", () => {
  const lib = `(footprint "Lib:R" (version 20241229) (layer "F.Cu") (attr smd)
    (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "l1"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "p1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "p2")))`;
  // the board copy: placed and rotated (children keep footprint coordinates; a pad's angle is the board's), which
  // the comparison takes back out
  const placed = (body) => K.parse(`(footprint "Lib:R" (layer "F.Cu") (uuid "b") (at 10 20 90) (attr smd)
    (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "x1"))
    ${body})`);
  const same = placed(`(pad "1" smd rect (at -1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q1")) (pad "2" smd rect (at 1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q2"))`);
  assert.deepEqual(T.footprintDiffLines(same, K.parse(lib)), []);
  const bigger = placed(`(pad "1" smd rect (at -1 0 90) (size 1.2 1) (layers "F.Cu" "F.Mask") (uuid "q1")) (pad "2" smd rect (at 1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q2"))`);
  assert.deepEqual(T.footprintDiffLines(bigger, K.parse(lib)), ["Pad 1 size differs on layer F.Cu."]);
  const one = placed(`(pad "1" smd rect (at -1 0 90) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "q1"))`);
  assert.deepEqual(T.footprintDiffLines(one, K.parse(lib)), ["Pad count differs."]);
  const dnp = K.parse(K.serialize(same).replace("(attr smd)", "(attr smd dnp)").replace("(uuid \"b\")", "(uuid \"b\") (clearance 0.3)"));
  assert.deepEqual(T.footprintDiffLines(dnp, K.parse(lib)), ["'Do not populate' settings differ.", "Pad clearance overridden."]);
});
