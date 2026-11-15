// panes.test.js — the docked panes' pure models: the Search pane's field / metadata matching (EDA_SEARCH_DATA
// searchAllFields / searchMetadata), StrNumCmp sorting and CopySelectionToClipboard text; more panes below.
// Run: node server/static/tests/panes.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const S = load("editor/panels/search-model.ts");
const PT = load("components/panes/prop-text.ts");
const SF = load("symedit/selfilter.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("docked panes under node");

const FP = ["footprint", "Lib:R_0805",
  ["property", "Reference", "R1", ["at", 0, 0]],
  ["property", "Value", "10k", ["at", 0, 0]],
  ["property", "MPN", "RC0805", ["at", 0, 0], ["hide", "yes"]],
  ["property", "Old", "legacy", ["effects", ["font"], "hide"]],
  ["property", "Shown", "visible", ["hide", "no"]]];
test("itemFields reads fields and their hidden flags", () => {
  const f = S.itemFields(FP);
  assert.deepStrictEqual(f.map((x) => [x.name, x.hidden]), [["Reference", false], ["Value", false], ["MPN", true], ["Old", true], ["Shown", false]]);
});
test("legacy fp_text reference / value are fields", () => {
  const f = S.itemFields(["footprint", "x", ["fp_text", "reference", "U3", ["at", 0, 0], "hide"], ["fp_text", "value", "LM358", ["at", 0, 0]], ["fp_text", "user", "note"]]);
  assert.deepStrictEqual(f, [{ name: "Reference", value: "U3", hidden: true }, { name: "Value", value: "LM358", hidden: false }]);
});
test("searchTexts: hidden fields only with Search Hidden Fields, metadata only with Search Metadata", () => {
  const f = S.itemFields(FP), meta = ["Lib:R_0805", "Resistor SMD", "resistor"];
  assert.deepStrictEqual(S.searchTexts(f, meta, { hidden: false, metadata: false }), ["R1", "10k", "visible"]);
  assert.deepStrictEqual(S.searchTexts(f, meta, { hidden: true, metadata: false }), ["R1", "10k", "RC0805", "legacy", "visible"]);
  assert.deepStrictEqual(S.searchTexts(f, meta, { hidden: false, metadata: true }), ["R1", "10k", "visible", "Lib:R_0805", "Resistor SMD", "resistor"]);
});
test("strNumCmp orders digit runs by value, ignoring case", () => {
  assert.ok(S.strNumCmp("R2", "R10") < 0);
  assert.ok(S.strNumCmp("r10", "R9") > 0);
  assert.strictEqual(S.strNumCmp("abc", "ABC"), 0);
  assert.ok(S.strNumCmp("C1", "C1a") < 0);
});
test("sortRows sorts by a column either way, stable, first column when none", () => {
  const rows = [{ cells: ["R10", "b"] }, { cells: ["R2", "a"] }, { cells: ["C1", "b"] }];
  assert.deepStrictEqual(S.sortRows(rows, 0, true).map((r) => r.cells[0]), ["C1", "R2", "R10"]);
  assert.deepStrictEqual(S.sortRows(rows, 0, false).map((r) => r.cells[0]), ["R10", "R2", "C1"]);
  assert.deepStrictEqual(S.sortRows(rows, 1, true).map((r) => r.cells[0]), ["R2", "R10", "C1"]);
  assert.deepStrictEqual(S.sortRows(rows, -1, true).map((r) => r.cells[0]), ["C1", "R2", "R10"]);
});
test("rowsAsText: tab-separated cells, a newline after each row", () => {
  assert.strictEqual(S.rowsAsText([{ cells: ["R1", "10k", "F.Cu"] }, { cells: ["R2", "", "B.Cu"] }]), "R1\t10k\tF.Cu\nR2\t\tB.Cu\n");
});

test("Properties colour cells keep the alpha (PGPROPERTY_COLOR4D)", () => {
  assert.strictEqual(PT.colorText([255, 0, 0], 1), "#ff0000");
  assert.strictEqual(PT.colorText([255, 0, 0], 0.5), "rgba(255,0,0,0.5)");
  assert.deepStrictEqual(PT.parseColorText("#FF000080"), [255, 0, 0, 0.502]);
  assert.deepStrictEqual(PT.parseColorText("rgba(10, 20, 30, 0.25)"), [10, 20, 30, 0.25]);
  assert.deepStrictEqual(PT.parseColorText("#00ff00"), [0, 255, 0, 1]);
  assert.strictEqual(PT.parseColorText("red"), null);
});

test("Symbol Editor selection filter: KiCad's rows and itemPassesFilter classes", () => {
  assert.deepStrictEqual(SF.SYM_FILTER_ROWS.map((r) => r[1]), ["All items", "Locked items", "Pins", "Text", "Graphics", "Other items"]);
  assert.strictEqual(SF.symFilterClass("pin"), "pins");
  assert.strictEqual(SF.symFilterClass("property"), "text");
  assert.strictEqual(SF.symFilterClass("text_box"), "text");
  assert.strictEqual(SF.symFilterClass("bezier"), "graphics");
  assert.strictEqual(SF.symFilterClass("something"), "otherItems");
});
test("Symbol Editor selection filter: Only <kind>, All items", () => {
  let f = SF.symSetFilter(SF.defaultSymFilter(), "only:graphics", true);
  assert.deepStrictEqual(f, { lockedItems: true, pins: false, text: false, graphics: true, otherItems: false });
  assert.ok(!SF.symAllChecked(f) && SF.symPasses(f, "arc") && !SF.symPasses(f, "pin"));
  f = SF.symSetFilter(f, "all", true); assert.ok(SF.symAllChecked(f));
  f = SF.symSetFilter(f, "text", false); assert.ok(!SF.symPasses(f, "property") && !SF.symAllChecked(f));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
