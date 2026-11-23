// constraint-pages-via-preview.test.js — Board Setup's Design Rules constraint family pages (PANEL_SETUP_CONSTRAINT_RULES,
// CONSTRAINT_RULES_LIST, DRC_RULE_DOCUMENT, DRC_PANEL_MATCHER::GetHomePanel) with the hole size and minimum via
// diameter rule types, and the via cross section preview (VIA_CROSS_SECTION_GEOMETRY) of the via properties dialog and
// the Board Finish page.
// Run: node server/static/tests/constraint-pages-via-preview.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webPath } = require("./web-path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const P = globalThis.PcbTools;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
globalThis.window = globalThis.window || globalThis;
const load = (...rel) => {
  const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
  const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports;
};
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");
const CR = load("domains", "pcb", "editor", "pcbdialogs", "constraint-rules.ts");
const VX = load("domains", "pcb", "editor", "pcbdialogs", "via-cross-section.ts");
const parses = (t) => { const r = P.parseDru(t); return r.messages ? !r.messages.some((m) => m.severity === "error" || m.fatal) : !r.errors.length; };
const mm = (v) => `${+v.toFixed(4)} mm`;

test("sections: the seven families and their pages, in dialog_board_setup's order", () => {
  assert.deepEqual(CR.FAMILIES.map((f) => f[1]), ["Clearance", "Tracks and Vias", "Holes", "Silkscreen", "Mask and Paste", "High Speed", "Footprints"]);
  assert.deepEqual(CR.sectionsFor("HOLES").map((s) => s.title), ["Minimum drill size", "Hole size", "Hole to hole clearance", "Microvia stack depth", "Hole aspect ratio"]);
  assert.deepEqual(CR.sectionsFor("TRACKS_AND_VIAS").map((s) => s.ruleType), ["ROUTING_WIDTH", "MINIMUM_CONNECTION_WIDTH", "MINIMUM_ANNULAR_WIDTH", "MINIMUM_VIA_DIAMETER", "VIA_STYLE", "MAXIMUM_VIA_COUNT"]);
  const via = CR.sectionsFor("TRACKS_AND_VIAS")[3];
  assert.deepEqual(via.defaults.map((d) => d.setting), ["min_via_diameter", "min_microvia_diameter"]);
  assert.equal(via.netclass, "via_diameter"); assert.equal(via.part, "opt");
  assert.equal(CR.pageEditingDefault("min_resolved_spokes"), "Minimum thermal relief spoke count");
  assert.equal(CR.pageEditingDefault("solder_mask_min_width"), "Minimum solder mask sliver");
  assert.equal(CR.importGroup(CR.sectionsFor("SOLDER_MASK")[0]), "Solder Mask/Paste");
  assert.equal(CR.rulesCanOverride("min_text_thickness"), "text_thickness");
  assert.equal(CR.rulesCanOverride("max_error"), null);
});

test("rule types: hole size and minimum via diameter, and the panel matcher's home pages", () => {
  const ids = CR.RULE_TYPES.map((t) => t.id);
  assert.ok(ids.includes("HOLE_SIZE") && ids.includes("MINIMUM_VIA_DIAMETER"));
  assert.equal(CR.homePanel("hole_size"), "HOLE_SIZE");
  assert.equal(CR.homePanel("via_diameter"), "MINIMUM_VIA_DIAMETER");
  assert.equal(CR.homePanel("silk_clearance"), "SILK_TO_SILK_CLEARANCE");
  assert.equal(CR.homePanel("length"), "ABSOLUTE_LENGTH");
  assert.equal(CR.homePanel("clearance"), "MINIMUM_CLEARANCE");
  assert.equal(CR.homePanel("text_thickness"), "MINIMUM_TEXT_HEIGHT_AND_THICKNESS");
  const d = new CR.RuleDocument(parses);
  d.load('(version 1)\n(rule drills\n\t(constraint hole_size (min 0.3mm))\n)\n(rule vd\n\t(constraint via_diameter (min 0.5mm))\n)\n');
  assert.deepEqual(d.entries.map((r) => r.type), ["HOLE_SIZE", "MINIMUM_VIA_DIAMETER"], "a lone hole_size loads on the Hole size page");
});

test("rule document: add, duplicate, move, remove, unique names and the text written once", () => {
  const d = new CR.RuleDocument(parses);
  d.load("(version 1)\n(rule a\n\t(constraint clearance (min 0.2mm))\n\t(condition \"A.NetName == 'GND'\")\n)\n");
  assert.equal(d.modified, false);
  assert.deepEqual(d.indicesFor("MINIMUM_CLEARANCE"), [0]);
  const r = CR.newRule("MINIMUM_CLEARANCE", d.uniqueRuleName("Minimum clearance")); r.v.value = 0.3;
  assert.equal(r.name, "Minimum clearance 1");
  d.add(r); assert.equal(d.modified, true);
  assert.equal(d.duplicate(1), 2); assert.equal(d.entries[2].name, "Minimum clearance 2", "a trailing number is dropped before numbering");
  assert.equal(d.isRuleNameUnique("a", "MINIMUM_CLEARANCE", -1), false);
  assert.equal(d.isRuleNameUnique("a", "ROUTING_WIDTH", -1), true, "a name is unique per type");
  assert.equal(d.move(2, -1, "MINIMUM_CLEARANCE"), true); assert.equal(d.entries[1].name, "Minimum clearance 2");
  assert.equal(d.move(0, -1, "MINIMUM_CLEARANCE"), false, "the first rule does not move up");
  d.remove(0);
  const text = d.getText();
  assert.match(text, /^\(version 1\)/);
  assert.ok(parses(text), "the written rules parse");
  assert.deepEqual(P.parseDru(text).rules.map((x) => x.name), ["Minimum clearance 2", "Minimum clearance 1"]);
  assert.deepEqual(d.indicesSetting("clearance"), [0, 1]);
});

test("rule document: text that does not parse blocks the pages, the Custom Rules text round-trips", () => {
  const d = new CR.RuleDocument(parses);
  d.load("(version 1)\n(rule broken (constraint clearance (min 0.2mm)\n");
  assert.equal(d.hasUnparsedText(), true);
  assert.deepEqual(d.indicesFor("MINIMUM_CLEARANCE"), []);
  assert.equal(d.add(CR.newRule("MINIMUM_CLEARANCE", "x")), -1);
  assert.equal(d.getText(), "(version 1)\n(rule broken (constraint clearance (min 0.2mm)\n", "the text is kept as typed");
  d.setText("(version 1)\n(rule ok (constraint clearance (min 0.2mm)))\n");
  assert.equal(d.hasUnparsedText(), false); assert.equal(d.modified, true); assert.equal(d.entries.length, 1);
  const e = new CR.RuleDocument(parses); e.load(null); assert.equal(e.entries.length, 0); e.loadFrom(null); assert.equal(e.modified, false);
});

test("rule table text: constraint, layers, severity, a text rule's clause and the override note", () => {
  const d = new CR.RuleDocument(parses);
  d.load("(version 1)\n(rule t\n\t(layer outer)\n\t(constraint track_width (min 0.2mm) (opt 0.25mm))\n\t(severity warning)\n)\n(rule c\n\t(constraint clearance (min 10mil))\n\t(constraint hole_clearance (min 0.25mm))\n\t(condition \"A.Type == 'Via'\")\n)\n");
  const t = d.entries[0], c = d.entries[1];
  assert.equal(t.type, "ROUTING_WIDTH");
  assert.equal(CR.constraintText(t, "ROUTING_WIDTH", mm), "(min 0.2 mm) (opt 0.25 mm)");
  assert.equal(CR.layersText(t), "outer"); assert.equal(CR.severityText(t), ", warning only");
  assert.equal(c.type, "CUSTOM_RULE");
  assert.deepEqual(CR.constraintsOf(c), ["clearance", "hole_clearance"]);
  assert.ok(d.indicesFor("MINIMUM_CLEARANCE").includes(1), "a text rule is listed on its home pages");
  assert.equal(CR.constraintText(c, "MINIMUM_CLEARANCE", mm), "(min 0.254 mm)  (text rule)");
  assert.equal(CR.constraintText(c, "ROUTING_WIDTH", mm), "Custom rule");
  assert.equal(CR.entryCondition(c), "A.Type == 'Via'");
  assert.equal(CR.overrideNote([["Minimum clearance", "0.2 mm"]], "", ""), "Overrides the board default, Minimum clearance 0.2 mm, everywhere");
  assert.equal(CR.overrideNote([["Board default", "0.5 mm"], ["Microvia default", "0.2 mm"]], "A.NetName == 'x'", "F.Cu"),
    "Overrides the board default, Board default 0.5 mm and Microvia default 0.2 mm, on F.Cu where A.NetName == 'x'");
  assert.equal(CR.ruleScopeText("0.2 mm", "", "inner"), "0.2 mm, on inner");
});

test("rule form: validation messages, layer categories and net class values", () => {
  const r = CR.newRule("HOLE_SIZE", "");
  assert.equal(CR.validateRule(r, false), "1. Rule name must be unique.\n2. Rule Name should not be empty.\n3. The value of Hole size must be greater than 0.\n");
  r.name = "h"; r.v.value = 0.3; assert.equal(CR.validateRule(r, true), "");
  assert.deepEqual(CR.layerChoices("COURTYARD_CLEARANCE", ["F.Cu", "B.Cu"], (l) => l), [["F.CrtYd", "Top"], ["B.CrtYd", "Bottom"]]);
  assert.deepEqual(CR.layerChoices("MINIMUM_VIA_DIAMETER", ["F.Cu", "F.SilkS", "B.Cu"], (l) => l).map((x) => x[0]), ["outer", "inner", "F.Cu", "B.Cu"]);
  assert.deepEqual(CR.layerChoices("HOLE_ASPECT_RATIO", ["F.Cu"], (l) => l), []);
  const classes = [{ name: "Power", clearance: 0.3 }, { name: "Default", clearance: 0.2 }, { name: "HV", clearance: 0.3 }];
  assert.deepEqual(CR.netclassValuesFor("min_clearance", classes), [[0.2, ["Default"]], [0.3, ["HV", "Power"]]]);
});

test("via cross section: layers, bores, cuts and protection follow VIA_CROSS_SECTION_GEOMETRY", () => {
  const s = VX.newViaSectionState();
  s.innerLayers = 2;
  let g = new VX.ViaSectionGeometry(s);
  assert.equal(g.gridHeight, 76 + 2 * 28);
  assert.deepEqual(g.bodies.map((b) => b.material), ["SOLDER_MASK", "CORE", "PLUG", "COPPER", "COVER"]);
  // every feature mixed: the fill supersedes plugs and is hatched; the tent and the cover are drawn hatched too
  assert.equal(g.body("PLUG").pieces.length, 1); assert.equal(g.body("PLUG").pieces[0].mixed, true);
  assert.ok(g.body("SOLDER_MASK").pieces.some((p) => p.mixed));
  // nothing on: open mask both sides, no plug, no cover
  Object.assign(s, { tentFront: false, tentBack: false, coverFront: false, coverBack: false, plugFront: false, plugBack: false, filled: false, capped: false });
  g = new VX.ViaSectionGeometry(s);
  assert.equal(g.body("PLUG").pieces.length, 0); assert.equal(g.body("COVER").pieces.length, 0); assert.equal(g.body("SOLDER_MASK").pieces.length, 4);
  // plugged both sides: two rounded blobs of 11 points
  Object.assign(s, { plugFront: true, plugBack: true });
  g = new VX.ViaSectionGeometry(s);
  assert.deepEqual(g.body("PLUG").pieces.map((p) => p.points.length), [11, 11]);
  // a cover needs a fill, a tent or a plug
  Object.assign(s, { plugFront: false, plugBack: false, coverFront: true });
  assert.equal(new VX.ViaSectionGeometry(s).body("COVER").pieces.length, 0);
  Object.assign(s, { tentFront: true });
  assert.equal(new VX.ViaSectionGeometry(s).body("COVER").pieces.length, 1);
  // a front backdrill of 2 layers: a bore down to half way between layers 1 and 2, no tent over it
  Object.assign(s, { backdrillFrontLayers: 2 });
  g = new VX.ViaSectionGeometry(s);
  assert.equal(g.bores.length, 1);
  assert.equal(g.bores[0].points[1].y, (g.layerCentre(1) + g.layerCentre(2)) / 2);
  assert.equal(g.body("COVER").pieces.length, 0);
  // a buried via (1..2) fills with resin and takes no backdrill
  Object.assign(s, { topLayer: 1, bottomLayer: 2 });
  g = new VX.ViaSectionGeometry(s);
  assert.equal(g.bores.length, 0); assert.equal(g.body("CORE").pieces.length, 5);
  // a counterbore and a countersink
  Object.assign(s, { topLayer: 0, bottomLayer: undefined, backdrillFrontLayers: 0 });
  s.postMachiningFront = { mode: "counterbore", widthRatio: 2, depthFraction: 0.2 };
  s.postMachiningBack = { mode: "countersink", widthRatio: 2.5, depthFraction: 0.1 };
  g = new VX.ViaSectionGeometry(s);
  assert.equal(g.cuts.length, 2); assert.equal(g.cuts[0].rect, true); assert.equal(g.cuts[1].points.length, 6);
});

test("via cross section: stackup depths and the default stackup", () => {
  const s = VX.newViaSectionState();
  const items = VX.stackupItems([], 4, 1.6);
  assert.equal(items.filter((x) => x.copper).length, 4);
  assert.ok(Math.abs(items[1].thicknesses[0] - (1.6 - 0.035 * 4 - 0.02) / 3) < 1e-9, "BuildDefaultStackupList shares the rest among the dielectrics");
  const total = VX.setLayersFromStackup(s, items, 4);
  assert.ok(Math.abs(total - (0.035 * 4 + (1.6 - 0.14 - 0.02))) < 1e-9);
  assert.equal(s.layerDepths.length, 4); assert.ok(Math.abs(s.layerDepths[0] - 0.0175 / total) < 1e-12);
  VX.setLayersFromStackup(s, items, 6);
  assert.deepEqual(s.layerDepths, [], "a stackup that does not match the copper count is not used");
  const real = VX.stackupItems([{ name: "F.Cu", type: "copper", thickness: 0.035 }, { name: "dielectric 1", type: "core", thickness: 1.5, subs: [{ thickness: 0.02 }] }, { name: "B.Cu", type: "copper", thickness: 0.035 }], 2, 1.6);
  assert.deepEqual(real.map((x) => x.thicknesses), [[0.035], [1.5, 0.02], [0.035]]);
});

test("pages and dialog: strings and wiring", () => {
  const page = src("domains", "pcb", "editor", "pcbdialogs", "constraint-rules-page.ts");
  for (const s of ["Used where no rule below matches. Kept with the board, not in the rules file.", "Edit net classes", "No rules yet.",
    "Design rules cannot be added without a project", "The custom rules text does not parse. Fix it on the Custom Rules page first.",
    "Move the selected rule one place earlier. ", "Copy the selected rule and place the copy after it.", "Delete the selected rule.",
    "Check the form and add it to the list of rules above.", "Save the form back to the selected rule.",
    "Empty the form so another rule can be written. Anything typed and not added is discarded.", "It is a text rule and every constraint it sets goes with it.",
    "Rule Not Added", "Rule Not Applied", "This rule is still in the form. Only the rules in the list apply.", "The rule does not compile.", "No board items match.",
    "board items match.", "A.hasExactNetclass('", "Also on the ${page} page. Click to open it.", "small_new_window"]) assert.ok(page.includes(s), s);
  const bs = src("domains", "pcb", "editor", "pcbdialogs", "board-setup.ts");
  for (const s of ["User clearance rules", "Overridden by user rules", "Net class values", "Edit on the ${page} page", "ruleDoc.getText()", "confirmPendingRule", "viaSectionPreview({ width: 240, height: 120 })"]) assert.ok(bs.includes(s), s);
  assert.ok(/label: "Board Stackup", pages: \[[^\]]*\]/.exec(bs)[0].indexOf("Solder Mask/Paste") < 0, "Solder Mask/Paste moved under Mask and Paste");
  const tv = src("domains", "pcb", "editor", "pcbdialogs", "track-via.ts");
  assert.ok(tv.includes("updateViaPreview") && tv.includes('staticBitmap("teardrop_sizes", 180, 110)'));
  const vx = src("domains", "pcb", "editor", "pcbdialogs", "via-cross-section.ts");
  assert.ok(vx.includes("Schematic cross section. Layer positions and cut depths are to scale with the board thickness, widths are relative to the hole. Copper and mask thickness are exaggerated."));
});
