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

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
