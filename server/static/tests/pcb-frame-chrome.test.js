// pcb-frame-chrome.test.js — the board editor's frame against KiCad: the Appearance panel's rules
// (appearance_controls.cpp), the "Visible layers" ratsnest filter (RATSNEST_VIEW_ITEM), the Search pane's cells
// (search_handlers.cpp), the menu / toolbar enable conditions (PCB_EDIT_FRAME::setupUIConditions), the inner-layer
// actions and the File / View / Preferences menu entries (menubar_pcb_editor.cpp).
// Run: node server/static/tests/pcb-frame-chrome.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const A = load(["editor", "panels", "appearance-model.ts"]), Q = load(["editor", "panels", "search-model.ts"]), T = load(["tables.ts"]);
// netlist.ts entered through the bundle's own entry, so its circular imports initialise in the bundle's order
require(path.join(__dirname, "..", "kicad-canvas.js"));
const N = (() => { const b = esbuild.buildSync({ stdin: { contents: 'import "./index"; export { ratsnestLineVisible } from "./netlist";', resolveDir: webPath("tools", "pcb-tools"), loader: "ts" }, bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; })();
const SPEC = require(webPath("generated", "kicad-menu-spec.json"));

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }
const sorted = (a) => a.slice().sort();

// ---------------------------------------------------------------- Appearance: presets and the active layer
test("PCB_LAYER_ID order: F.Cu, F.Mask, B.Cu, ... inner layers 2N+2, User.N after Rescue", () => {
  assert.deepEqual(["F.Cu", "F.Mask", "B.Cu", "B.Mask", "In1.Cu", "User.1"].map(A.layerSeqId), [0, 1, 2, 3, 4, 39]);
  assert.equal(A.firstInSeq(["B.Cu", "F.SilkS", "In2.Cu"]), "B.Cu");
  assert.equal(A.firstInSeq([]), null);
});
test("doApplyLayerPreset: the preset's own active layer, else the first of its layers when the current one is hidden", () => {
  const board = ["F.Cu", "In1.Cu", "B.Cu", "F.Mask", "B.Mask", "F.SilkS"];
  assert.equal(A.presetActiveLayer({ layers: ["F.Cu", "B.Cu"], active: "B.Cu" }, "F.Cu", board), "B.Cu");
  assert.equal(A.presetActiveLayer({ layers: ["F.Cu", "B.Cu"] }, "F.Cu", board), null, "the current layer stays when the preset shows it");
  assert.equal(A.presetActiveLayer({ layers: ["B.Cu", "B.Mask"] }, "F.Cu", board), "B.Cu");
  // a built-in preset's whole LSET decides: Front Assembly View starts at F.Mask
  assert.equal(A.presetActiveLayer({ layers: ["F.SilkS", "F.Mask"], seqFirst: "F.Mask" }, "F.Cu", board), "F.Mask");
  // only a layer the board has
  assert.equal(A.presetActiveLayer({ layers: ["In1.Cu"], seqFirst: "In1.Cu" }, "F.Cu", ["F.Cu", "B.Cu"]), null);
});
test("Hide All Copper / Non Copper: the active layer moves to the first visible layer only when it became hidden", () => {
  assert.equal(A.activeAfterHide(["F.SilkS", "F.Mask"], "F.Cu"), "F.Mask");
  assert.equal(A.activeAfterHide(["F.Cu", "F.Mask"], "F.Cu"), null);
  assert.equal(A.activeAfterHide([], "F.Cu"), null);
});

// ---------------------------------------------------------------- Appearance: objects, ratsnest, nets
test("onObjectVisibilityChanged: Footprint Text drags References and Values; showing either turns it back on", () => {
  assert.deepEqual(sorted(A.objectVisibilityChange([], "fpText", false)), ["fpText", "references", "values"]);
  assert.deepEqual(A.objectVisibilityChange(["fpText", "references", "values"], "fpText", true), []);
  assert.deepEqual(sorted(A.objectVisibilityChange(["fpText", "references", "values"], "values", true)), ["references"]);
  assert.deepEqual(sorted(A.objectVisibilityChange([], "values", false)), ["values"]);
});
test("Ratsnest radio: None while the global ratsnest is off; picking None keeps the All / Visible mode; the cycle", () => {
  assert.equal(A.ratsnestRadio(false, "visible"), "none");
  assert.equal(A.ratsnestRadio(true, "visible"), "visible");
  assert.equal(A.ratsnestRadio(true, "all"), "all");
  assert.deepEqual(A.ratsnestFromRadio("none", "visible"), { show: false, mode: "visible" });
  assert.deepEqual(A.ratsnestFromRadio("visible", "all"), { show: true, mode: "visible" });
  assert.deepEqual(A.ratsnestCycle(false, "visible"), { show: true, mode: "all" });
  assert.deepEqual(A.ratsnestCycle(true, "all"), { show: true, mode: "visible" });
  assert.deepEqual(A.ratsnestCycle(true, "visible"), { show: false, mode: "visible" });
});
test("Nets list: no code 0, no unconnected-( nets; classes Default first, then sorted", () => {
  const nets = [{ name: "", code: 0 }, { name: "GND", code: 1 }, { name: "unconnected-(U1-Pad3)", code: 2 }, { name: "VCC", code: 3 }];
  assert.deepEqual(A.appearanceNets(nets).map((n) => n.name), ["GND", "VCC"]);
  assert.deepEqual(A.sortNetClasses(["Power", "Default", "HS", "analog"]), ["Default", "HS", "Power", "analog"]);
});
test("showNetclass: the class eye shows or hides each net of the class, other nets untouched", () => {
  assert.deepEqual(sorted(A.showNetclassNets(["X"], ["A", "B"], false)), ["A", "B", "X"]);
  assert.deepEqual(A.showNetclassNets(["A", "B", "X"], ["A", "B"], true), ["X"]);
});

// ---------------------------------------------------------------- ratsnest "Visible layers"
test("RATSNEST_VIEW_ITEM VISIBLE: both ends on a visible copper layer; with inactive layers hidden only the active one", () => {
  const line = (a, b) => ({ layersA: a, layersB: b });
  const hidden = new Set(["B.Cu"]);
  assert.equal(N.ratsnestLineVisible(line(["F.Cu"], ["F.Cu", "B.Cu"]), hidden, null), true);
  assert.equal(N.ratsnestLineVisible(line(["F.Cu"], ["B.Cu"]), hidden, null), false);
  assert.equal(N.ratsnestLineVisible(line(["F.Cu", "F.Mask"], ["In1.Cu"]), hidden, null), true, "only copper layers count");
  assert.equal(N.ratsnestLineVisible(line(["F.Cu"], ["F.Cu"]), null, "B.Cu"), false, "with inactive layers hidden only the active layer is visible");
  assert.equal(N.ratsnestLineVisible(line(["B.Cu"], ["F.Cu", "B.Cu"]), null, "B.Cu"), true);
  assert.equal(N.ratsnestLineVisible({}, hidden, null), true, "a line without layer facts is drawn");
});

// ---------------------------------------------------------------- Search pane
test("ZONE_SEARCH_HANDLER: layers joined by ',' in UI order; Area through MessageTextFromValue( AREA )", () => {
  const rank = (l) => ["F.Cu", "In1.Cu", "B.Cu"].indexOf(l);
  assert.equal(Q.zoneLayersCell(["B.Cu", "F.Cu"], ["F.Cu", "In1.Cu", "B.Cu"], rank, (l) => l), "F.Cu,B.Cu");
  assert.equal(Q.zoneLayersCell(["*.Cu"], ["F.Cu", "In1.Cu", "B.Cu"], rank, (l) => l), "F.Cu,In1.Cu,B.Cu");
  assert.equal(Q.areaText(12.34, "mm"), "12.34 mm²");
  assert.equal(Q.areaText(12.345, "mm"), "12.345 mm²");
  assert.equal(Q.areaText(645.16, "in"), "1.000 in²");
  assert.equal(Q.areaText(645.16, "mil"), "1000000 mils²");
  assert.equal(Q.outlineArea([[0, 0], [10, 0], [10, 5], [0, 5]]), 50);
});
test("DRILL_SEARCH_HANDLER: a pad line carries the pads themselves (footprint#index) to select", () => {
  const fp = (id, ...pads) => ({ id, kind: "footprint", node: ["footprint", "x", ...pads] });
  const pad = (drill) => ["pad", "1", "thru_hole", "circle", ["drill", drill], ["layers", "*.Cu"]];
  const L = Q.drillLines([fp("a", pad(0.8), ["pad", "2", "smd", "rect", ["layers", "F.Cu"]], pad(0.8)), fp("b", pad(0.8))], ["F.Cu", "B.Cu"]);
  assert.deepEqual(L[0].padKeys, ["a#0", "a#2", "b#0"]);
});

// ---------------------------------------------------------------- enable conditions, actions, menus
test("setupUIConditions: undo, selection, group, lock, zone and net conditions", () => {
  const f = (o) => Object.assign({ kinds: [], hasLocked: false, hasUnlocked: false, haveNet: false, boardHasItems: true, idleNoTool: true, netHighlightSet: false, zonesEnabled: true, drawingOrRouting: false }, o);
  assert.ok(T.pcbEnableWhy("undo", f({}), 0));
  assert.equal(T.pcbEnableWhy("undo", f({}), 2), null);
  assert.ok(T.pcbEnableWhy("rotateCw", f({}), 0));
  assert.equal(T.pcbEnableWhy("rotateCw", f({ kinds: ["footprint"] }), 0), null);
  assert.ok(T.pcbEnableWhy("group", f({ kinds: ["footprint"] }), 0));
  assert.equal(T.pcbEnableWhy("lock", f({ kinds: ["track"], hasUnlocked: true }), 0), null);
  assert.ok(T.pcbEnableWhy("unlock", f({ kinds: ["track"], hasUnlocked: true }), 0));
  assert.ok(T.pcbEnableWhy("zoneMerge", f({ kinds: ["zone"] }), 0));
  assert.equal(T.pcbEnableWhy("zoneMerge", f({ kinds: ["zone", "zone"] }), 0), null);
  assert.ok(T.pcbEnableWhy("selectNet", f({ kinds: ["footprint"] }), 0));
  assert.ok(T.pcbEnableWhy("copy", f({ boardHasItems: false }), 0));
  assert.equal(T.pcbEnableWhy("zoomFitScreen", f({}), 0), undefined, "entries without a condition are left to the other rules");
});
test("Switch to Inner layer 1..30: board-only actions a viewer may use; the mode cycles too", () => {
  assert.equal(T.INNER_LAYER_ACTIONS.length, 30);
  assert.equal(T.INNER_LAYER_ACTIONS[0], "layerInner1");
  for (const id of [...T.INNER_LAYER_ACTIONS, "ratsnestModeCycle", "netColorModeCycle"]) assert.ok(T.READ_ONLY_OK.has(id), id);
  assert.equal(T.EDITOR_ONLY.layerInner5, "pcb");
});
test("menubar_pcb_editor.cpp: Export > For Older KiCad Version, Panels > Design Blocks, design block libraries, no fabPackage in Fabrication Outputs", () => {
  const menu = (t) => T.MENUS.pcb.find((m) => m[0].replace("&", "") === t)[1];
  const sub = (entries, t) => entries.find((e) => Array.isArray(e) && e[0].replace("&", "") === t)[1];
  const file = menu("File"), exp = sub(file, "Export");
  assert.equal(exp[exp.indexOf("exportSpecctraDSN|Specctra DSN...") + 1], "exportForOlderVersion|For Older KiCad Version...");
  assert.ok(!sub(file, "Fabrication Outputs").includes("fabPackage"));
  assert.ok(sub(menu("View"), "Panels").includes("showDesignBlockPanel|Design Blocks"));
  const prefs = menu("Preferences");
  assert.equal(prefs[prefs.indexOf("showFootprintLibTable") + 1], "showDesignBlockLibTable");
});
test("gen_kicad_menus.py: C escapes in tooltips become real characters", () => {
  const tip = SPEC.actions["PCB_ACTIONS::exportFootprints"].tip;
  assert.ok(tip.includes("\n(does not remove") && !tip.includes("\\n"), JSON.stringify(tip));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
