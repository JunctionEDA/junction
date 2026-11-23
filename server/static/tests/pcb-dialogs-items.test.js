// pcb-dialogs-items.test.js — the board item dialogs against KiCad's: Track & Via Properties' net change over the
// connected copper (shorting nets, changing pads), the rule area's placement sources, UNIT_BINDER range messages,
// the footprint dialog's field checks and solder paste margin / ratio field, the shape dialog's line endings and
// geometry validation, the Copper Only pad type and the remaining dialog details.
// Run: node server/static/tests/pcb-dialogs-items.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, T = globalThis.PcbTools, PM = K.padModel;
const IPM = load("editor/pcbdialogs/item-props-model.ts");
const src = (rel) => fs.readFileSync(webPath(rel), "utf8");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n       ")); } }
const mm = (v) => String(+v.toFixed(4)) + " mm";

// ---------------------------------------------------------------- 1. Track & Via Properties: the net change
const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "VCC") (net 3 "SIG")
  (footprint "Lib:R" (layer "F.Cu") (uuid "fp1") (at 10 0)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "p1"))
    (pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 3 "SIG") (uuid "p2")))
  (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
  (segment (start 10 0) (end 10 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "s2"))
  (segment (start 20 0) (end 30 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s3"))
  (segment (start 0 1) (end 5 1) (width 0.25) (layer "F.Cu") (net 2) (uuid "v1"))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z1") (polygon (pts (xy -1 -1) (xy 40 -1) (xy 40 6) (xy -1 6)))
    (filled_polygon (layer "F.Cu") (pts (xy -1 -1) (xy 40 -1) (xy 40 6) (xy -1 6))))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");

test("the net change takes the tracks connected through a pad, not through a zone; the pad of the old net changes too", () => {
  const d = board();
  const plan = T.trackNetChangePlan(d, ["s1"], new Map([["s1", K.cloneNode(d.items.get("s1").node)]]), "VCC");
  assert.deepEqual(plan.connected.sort(), ["s1", "s2"], "s2 meets s1 on R1's pad 1; s3 only shares the zone (EXCLUDE_ZONES)");
  assert.deepEqual(plan.changingPads.map((p) => `${p.ref}:${p.number}`), ["R1:1"]);
  assert.deepEqual(plan.shortingNets, []);
});
test("a widened track that now touches another net's track shorts it", () => {
  const d = board(), n = K.cloneNode(d.items.get("s1").node); K.kid(n, "width")[1] = 2.5;
  const plan = T.trackNetChangePlan(d, ["s1"], new Map([["s1", n]]), "GND");
  assert.deepEqual(plan.shortingNets, ["VCC"], "the VCC track 1 mm away is inside the 1.25 mm half width");
  assert.deepEqual(plan.changingPads, [], "a pad already on the new net does not change");
});
test("a pad of a third net the track touches shorts that net", () => {
  const d = board(), n = K.cloneNode(d.items.get("s2").node); K.kid(n, "end")[1] = 13; K.kid(n, "end")[2] = 0;
  const plan = T.trackNetChangePlan(d, ["s2"], new Map([["s2", n]]), "GND");
  assert.deepEqual(plan.shortingNets, ["SIG"]);
});
test("Track & Via Properties asks KiCad's two questions and changes the connected copper", () => {
  const s = src("editor/pcbdialogs/track-via.ts");
  for (const t of ["Applying these changes will short net ${shown} with ${plan.shortingNets[0]}.", "Applying these changes will short net ${shown} with other nets.",
    "Changing the net will also update ${ps[0].ref} pad ${ps[0].number} to ${shown}.", "Changing the net will also update ${ps.length} connected pads to ${shown}.",
    '"Cancel Changes"', '"Apply Anyway"', '"Change Nets"', '"Leave Nets Unchanged"'])
    assert.ok(s.includes(t), t);
  assert.ok(!/if \(isArc\) return/.test(s) && !/t\.kind === "arc"\)\) for \(const f of \[sx, sy, ex, ey\]\) f\.enable\(false\)/.test(s), "an arc's start and end are edited like a track's");
  assert.ok(!s.includes('[["-1", ""], ...tw.map'), "no blank pre-defined track width");
  assert.ok(s.includes("const minBd = typeof dr === \"number\" ? dr : minSize"), "a mixed drill checks backdrills against GEOMETRY_MIN_SIZE");
});

// ---------------------------------------------------------------- rule area / zones
test("UNIT_BINDER::Validate messages: the label without its colon", () => {
  assert.equal(IPM.rangeError("Outline hatch pitch:", 0.05, IPM.HATCH_PITCH_MIN, IPM.HATCH_PITCH_MAX, mm), "Outline hatch pitch must be at least 0.1 mm.");
  assert.equal(IPM.rangeError("Outline hatch pitch", 2.5, 0.1, 2, mm), "Outline hatch pitch must be less than 2 mm.");
  assert.equal(IPM.rangeError("Outline hatch pitch", 0.5, 0.1, 2, mm), null);
  assert.equal(IPM.rangeError("Size", 0.01, IPM.TARGET_MIN_SIZE, Infinity, mm), "Size must be at least 0.0254 mm.");
});
test("rule area placement sources: footprint sheets, named groups holding footprints (nested), component classes", () => {
  const doc = { items: new Map([
    ["f1", { id: "f1", kind: "footprint", node: K.parse('(footprint "x" (sheetname "/B/") (component_classes (class "PWR")))') }],
    ["f2", { id: "f2", kind: "footprint", node: K.parse('(footprint "x" (sheetname "/A/"))') }],
    ["g1", { id: "g1", kind: "group", node: K.parse('(group "" (uuid "g1") (members "f1"))') }],
    ["g2", { id: "g2", kind: "group", node: K.parse('(group "Outer" (uuid "g2") (members "g1"))') }],
    ["g3", { id: "g3", kind: "group", node: K.parse('(group "Lines" (uuid "g3") (members "l1"))') }]]) };
  const s = IPM.placementSources(doc, (n) => K.groupMemberIds(n));
  assert.deepEqual(s, { sheets: ["/A/", "/B/"], groups: ["Outer"], classes: ["PWR"] });
});
test("placement combos: no blank entry, the first preselected, a missing source shown as 'Not found on board: …'", () => {
  let c = IPM.placementCombo(["/A/", "/B/"], "", false); assert.deepEqual([c.labels, c.selected, c.value(0)], [["/A/", "/B/"], 0, "/A/"]);
  c = IPM.placementCombo(["/A/", "/B/"], "/B/", true); assert.equal(c.selected, 1);
  c = IPM.placementCombo(["/A/"], "/Gone/", true); assert.deepEqual(c.labels, ["Not found on board: /Gone/", "/A/"]); assert.equal(c.value(0), "/Gone/"); assert.equal(c.value(1), "/A/");
  c = IPM.placementCombo(["/A/"], "/Gone/", false); assert.deepEqual(c.labels, ["/A/"], "another kind's combo does not show it");
  assert.equal(IPM.placementText(false, "group", "Outer", (t) => JSON.stringify(t)), '(placement (enabled no) (group "Outer"))');
});
test("zone dialogs: rule area over every layer, 'No layers selected.', unique name, hatch pitch range; non-copper hatch checks; Open Zone Manager applies", () => {
  const s = src("editor/pcbdialogs/item-props.ts");
  assert.ok(s.includes('zoneLayerList(doc, node, allLayers(doc), ro, "No layers selected.")'));
  assert.ok(s.includes("uniqueZoneName(doc, nm)") && s.includes('put(n, "priority", null)'));
  assert.ok(s.includes('IPM.rangeError("Outline hatch pitch"'));
  assert.ok(s.includes('IPM.rangeError("Hatch width", hw.get(), mw') && s.includes('IPM.rangeError("Hatch gap", hg.get(), mw'));
  assert.ok(!s.includes("Minimum width must be at least"), "the invented minimum width message is gone");
  assert.ok(s.includes('"Fillet radius:"') && s.includes("min: 0, max: 3") && s.includes("min: 0, max: 1, step: 0.1"));
  assert.ok(s.includes("create ? null : h(\"div\", { class: \"pd-row\", style: \"margin-top:8px\" }, zm)"), "no Open Zone Manager for a new zone");
  assert.ok(/zm\.addEventListener\("click", \(\) => \{[\s\S]{0,400}ok\.click\(\);[\s\S]{0,120}isConnected\) return;/.test(s), "the edits are applied (OK) before the manager opens");
  assert.ok(s.includes("start: !anyKeepout && plOn ? 1 : 0"), "Placement page first when no keepout is set");
});

// ---------------------------------------------------------------- footprint properties
test("footprint field rows: KiCad's size limits and the pen clamp, in order", () => {
  assert.deepEqual(IPM.footprintFieldRowError(0.0005, 1, 0.1, mm), { col: "w", msg: "Text width must be at least 0.001 mm.", reset: 0.001 });
  assert.deepEqual(IPM.footprintFieldRowError(300, 1, 0.1, mm), { col: "w", msg: "Text width must be at most 250 mm.", reset: 250 });
  assert.equal(IPM.footprintFieldRowError(1, 0, 0.1, mm).msg, "Text height must be at least 0.001 mm.");
  assert.equal(IPM.footprintFieldRowError(1, 251, 0.1, mm).msg, "Text height must be at most 250 mm.");
  assert.deepEqual(IPM.footprintFieldRowError(1, 1, 0.5, mm), { col: "th", msg: "Text thickness is too large for the text size.\nIt will be clamped at 0.25 mm.", reset: 0.25 });
  assert.equal(IPM.footprintFieldRowError(1, 1, 0.15, mm), null);
});
test("MARGIN_OFFSET_BINDER: format and parse the absolute and / or ratio", () => {
  const fmt = (v) => String(+v.toFixed(4)), parse = (t) => { const m = /^([-+]?[\d.]+)\s*(mm)?$/.exec(t); return m ? Number(m[1]) : NaN; };
  assert.equal(IPM.marginText(-0.1, NaN, fmt), "-0.1");
  assert.equal(IPM.marginText(NaN, -0.05, fmt), "-5%");
  assert.equal(IPM.marginText(-0.1, -0.05, fmt), "-0.1 - 5%");
  assert.equal(IPM.marginText(0.1, 0.025, fmt), "0.1 + 2.5%");
  assert.equal(IPM.marginText(0, NaN, fmt), "0");
  assert.equal(IPM.marginText(NaN, NaN, fmt), "");
  assert.deepEqual(IPM.parseMarginText("-0.1mm - 5%", parse), { abs: -0.1, ratio: -0.05 });
  assert.deepEqual(IPM.parseMarginText("-5%", parse), { abs: NaN, ratio: -0.05 });
  assert.deepEqual(IPM.parseMarginText("0.2", parse), { abs: 0.2, ratio: NaN });
  assert.deepEqual(IPM.parseMarginText("", parse), { abs: NaN, ratio: NaN });
  assert.equal(IPM.parseMarginText("abc", parse), null);
});
test("jumper groups text", () => {
  assert.equal(IPM.jumperGroupsText(K.parse('(footprint "x")')), "none");
  assert.equal(IPM.jumperGroupsText(K.parse('(footprint "x" (duplicate_pad_numbers_are_jumpers yes))')), "all pads with duplicate numbers");
  assert.equal(IPM.jumperGroupsText(K.parse('(footprint "x" (jumper_pad_groups ("1" "2") ("3" "4")))')), "(1, 2);  (3, 4)");
});
test("Footprint Properties: KiCad's grid columns and their default visibility, paste ratio, bridges, validation", () => {
  const s = src("editor/pcbdialogs/item-props.ts");
  const cols = [...s.matchAll(/\{ label: "([^"]+)", key: "(?:label|value|show|w|ht|th|italic|layer|rot|upright|x|y|knockout|mirror)"[^}]*\}/g)].map((m) => [m[1], (/hidden: (true|false)/.exec(m[0]) || [])[1] || "-"]);
  assert.deepEqual(cols.map((c) => c[0]), ["Name", "Value", "Show", "Width", "Height", "Thickness", "Italic", "Layer", "Orientation", "Keep Upright", "X Offset", "Y Offset", "Knockout", "Mirrored"]);
  assert.deepEqual(cols.filter((c) => c[1] === "true").map((c) => c[0]), ["Italic", "Orientation", "Keep Upright", "X Offset", "Y Offset", "Knockout", "Mirrored"]);
  assert.ok(s.includes('"Allow bridged solder mask apertures between pads"') && s.includes("next.allow_soldermask_bridges = bridges.get()"));
  assert.ok(s.includes('"solder_paste_margin_ratio"') && s.includes("could not be parsed as a distance and/or percentage offset."));
  assert.ok(s.includes("IPM.footprintFieldRowError(") && s.includes('IPM.rangeError("Pad clearance"'));
  assert.ok(!s.includes('orientationField(at[2] || 0, ro, "orientation", ["0", "90", "-90", "180"])'), "the footprint's orientation presets are 0.0 / 90.0 / -90.0 / 180.0");
  assert.ok(s.includes('"Note: solder mask and paste values are used only for pads on copper layers."') && s.includes('"Jumper groups:"'));
  assert.ok(s.includes('"Edit Text Properties");   // commit.Push'), "a field's dialog commits 'Edit Text Properties'");
});
test("Target Properties: the 1 mil minimum", () => {
  const s = src("editor/pcbdialogs/item-props.ts");
  assert.ok(s.includes('IPM.rangeError("Size", s, IPM.TARGET_MIN_SIZE') && !s.includes('"Size must be greater than 0."'));
});

// ---------------------------------------------------------------- shape properties
test("line endings: loaded and written as LINE_ENDING::Format, negatives clamped to 0", () => {
  const n = K.parse('(gr_line (start 0 0) (end 5 0) (stroke (width 0.1) (type default)) (end_shape circle (length 1) (stroke (width 0.2) (type dash))) (layer "F.SilkS"))');
  assert.deepEqual(IPM.readEndingValues(n, "start_shape"), { style: "none", length: 0, width: 0, thickness: 0, strokeType: "default" });
  const e = IPM.readEndingValues(n, "end_shape"); assert.deepEqual(e, { style: "circle", length: 1, width: 0, thickness: 0.2, strokeType: "dash" });
  const f6 = (v) => String(+v.toFixed(6));
  assert.equal(IPM.endingText("end_shape", e, f6), "(end_shape circle (length 1) (stroke (width 0.2) (type dash)))");
  assert.equal(IPM.endingText("start_shape", { style: "arrow", length: -1, width: 0.5, thickness: 0, strokeType: "default" }, f6), "(start_shape arrow (width 0.5))");
  assert.equal(IPM.endingText("start_shape", { style: "none", length: 1, width: 1, thickness: 1, strokeType: "default" }, f6), null);
  assert.deepEqual(IPM.LINE_ENDING_CHOICES.map((c) => c[1]), ["None", "Arrow", "Open Arrow", "Circle", "Square"]);
});
test("shape geometry is validated whatever page is shown (GEOM_SYNCER::Validate)", () => {
  assert.equal(T.validateShapeGeom({ kind: "rect", start: [1, 1], end: [1, 1] }), "Rectangle cannot be zero-sized.");
  assert.equal(T.validateShapeGeom({ kind: "rect", start: [1, 1], end: [2, 1] }), null);
  assert.equal(T.validateShapeGeom({ kind: "circle", center: [1, 1], end: [1, 1] }), "Radius must be greater than 0");
  assert.equal(T.validateShapeGeom({ kind: "arc", start: [0, 0], mid: [0, 0], end: [2, 0] }), "Arc must have at least 2 distinct points");
  assert.equal(T.validateShapeGeom({ kind: "arc", start: [0, 0], mid: [1, 1], end: [2, 0] }), null);
  const s = src("editor/pcbdialogs/item-props.ts");
  assert.ok(!/SHAPE_HATCH_VERSION|ROUNDRECT_VERSION|SHAPE_MASK_VERSION|has no rounded rectangles/.test(s), "hatch fills, rounded rectangles and solder mask are always offered");
  assert.ok(s.includes("GT().validateShapeGeom(geom)") && !s.includes("const pi = nb.current(), pg = pages[pi]"));
  assert.ok(s.includes('"Set line ending sizes to 0 for automatic (5\\u00d7 line width)."'));
});

// ---------------------------------------------------------------- pad properties
test("Copper Only pads: KiCad's last pad type, every copper layer to choose, written as non_component", () => {
  const d = { copper: ["F.Cu", "In1.Cu", "B.Cu"], items: new Map() };
  assert.deepEqual(PM.copperChoices("copper", d.copper), ["F.Cu", "In1.Cu", "B.Cu"]);
  assert.deepEqual(PM.copperChoices("npth", d.copper, (l) => (l === "F.Cu" ? "Top" : l)), ["Top and B.Cu", "Top", "B.Cu", "None"]);
  const fp = K.parse('(footprint "x" (layer "F.Cu") (at 0 0) (pad "1" non_component rect (at 0 0) (size 1 1) (layers "In1.Cu") (uuid "a")))');
  d.items.set("f", { kind: "footprint", node: fp });
  const pad = K.kids(fp, "pad")[0], was = PM.readPad(d, fp, pad, "");
  assert.equal(was.type, "copper"); assert.equal(was.copper, 1);
  const m = structuredClone(was); m.copper = 2; PM.writePad(d, fp, pad, m, was, () => 0);
  assert.ok(K.serialize(pad).includes('non_component rect') && K.serialize(pad).includes('(layers "B.Cu")'), K.serialize(pad));
  const fp2 = K.parse('(footprint "x" (layer "F.Cu") (at 0 0) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "b")))');
  const p2 = K.kids(fp2, "pad")[0], w2 = PM.readPad(d, fp2, p2, ""), m2 = structuredClone(w2);
  m2.type = "copper"; m2.copper = 0; for (const k of Object.keys(m2.tech)) m2.tech[k] = false;
  PM.writePad(d, fp2, p2, m2, w2, () => 0);
  assert.ok(K.serialize(p2).startsWith('(pad "1" non_component rect') && K.serialize(p2).includes('(layers "F.Cu")'), K.serialize(p2));
  const s = src("editor/pcbdialogs/pad-props.ts");
  assert.ok(s.includes('["aperture", "SMD Aperture"], ["copper", "Copper Only"]'));
});
test("PadTypeSelected, the offset rule and no file-version gates", () => {
  const s = src("editor/pcbdialogs/pad-props.ts");
  assert.ok(s.includes("if (!holed()) { m.hx = m.hy = 0;") && s.includes("m.hx = was.hx; m.hy = was.hy;"), "no hole: 0; a hole of 0: the edited pad's drill");
  assert.ok(s.includes('m.number = ""; number.set(""); m.net = ""; net.set("");') && s.includes("m.dieOn = false; dieOn.set(false); m.dieDelayOn = false;"));
  assert.ok(s.includes("m.number = was.number; number.set(was.number); m.net = was.net;"), "back to a connected type: number and net restored");
  assert.ok(s.includes('holeRows.style.display = holed() ? "" : "none"') && s.includes('padstackRows.style.display = m.type === "pth" ? "" : "none"'));
  assert.ok(s.includes('offOn.input.disabled = ro || m.shape === "circle"') && s.includes('offRow.style.display = m.offset ? "" : "none"'));
  assert.ok(!/DIE_DELAY_VERSION|SIM_ELECTRICAL_TYPE_VERSION|tooNew/.test(s), "die delay and simulation type always editable");
  assert.ok(s.includes('"Edit Pad Properties"'));
});
test("Barcode Properties: no invented size check, KiCad's orientation presets, the Barcode Error title", () => {
  const s = src("editor/pcbdialogs/barcode.ts");
  assert.ok(!s.includes("Size must be greater than 0.") && s.includes('["0", "90", "-90", "180"]') && s.includes('messageBox("Barcode Error", sym.error)'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
