// sch-frame-chrome.test.js — the schematic frame's panes and chrome against eeschema: the Search pane's matcher
// (EDA_COMBINED_MATCHER, CTX_SEARCH), its per-sheet-instance rows and virtual list, the Hierarchy navigator's order
// and keyboard (wxTreeCtrl), the menu / toolbar enable and check conditions (SCH_EDIT_FRAME::setupUIConditions,
// SCH_EDIT_TOOL's attribute conditions) and the Properties panel of a field selected on its own (SCH_FIELD_DESC).
// Run: node server/static/tests/sch-frame-chrome.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const S = load("editor/panels/search-model.ts");
const NAV = load("components/panes/hier-nav.ts");
const PG = load("sim/sheet-pages.ts");
const T = load("tables.ts");
const VM = load("canvas/variant-model.ts");
const FP = load("editor/panels/field-props.ts");
const SIL = load("dialogs/sch-items-logic.ts");
const CMP = load("dialogs/import-fp-assignments.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("schematic frame chrome under node");

// ---------------------------------------------------------------- Search pane
test("permissive search: an unanchored wildcard, a substring, an explicit regular expression", () => {
  const m = (q, t) => S.permissiveMatcher(q)([t]);
  assert.ok(m("", "anything"), "an empty query matches everything");
  assert.ok(m("R1*", "CR10"), "the wildcard is not anchored");
  assert.ok(m("r1", "CR10"), "case is ignored: both sides are upper-cased");
  assert.ok(m("R?0", "CR10")); assert.ok(!m("R?0", "R0"));
  assert.ok(!m("^R1$", "CR10")); assert.ok(m("^R1$", "r1"), "^…$ is a regular expression");
  assert.ok(m("/R[0-9]+/", "xr22")); assert.ok(m("/R[0-9]+", "r22"), "the closing slash is optional");
  assert.ok(!m("/R[0-9]+/", "RX"));
  assert.ok(m("a.b", "xA.By")); assert.ok(!m("a.b", "axb"), "a dot is literal outside a regular expression");
  assert.ok(m("^[$", "x^[$y"), "a pattern that does not compile is searched as text");
  assert.ok(m(" r1", "a r1"), "the query is not trimmed"); assert.ok(!m(" r1", "ar1"));
});
test("a symbol's reference and unit come from the sheet instance; the unit letter is LetterSubReference", () => {
  const sym = ["symbol", ["lib_id", "Amp:LM358"], ["unit", 1], ["property", "Reference", "U?"],
    ["instances", ["project", "p", ["path", "/a", ["reference", "U1"], ["unit", 2]], ["path", "/a/b", ["reference", "U7"], ["unit", 1]]]]];
  assert.deepStrictEqual(S.symbolInstanceRef(sym, "/a"), { ref: "U1", unit: 2 });
  assert.deepStrictEqual(S.symbolInstanceRef(sym, "/a/b"), { ref: "U7", unit: 1 });
  assert.deepStrictEqual(S.symbolInstanceRef(sym, "/zz"), { ref: "U?", unit: 1 }, "no instance: the field and the symbol's unit");
  assert.deepStrictEqual([1, 2, 26, 27, 28, 52, 53].map(S.unitSuffix), ["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
  assert.deepStrictEqual(S.refMatchTexts("U1", 2, 2), ["U1", "U1B"]); assert.deepStrictEqual(S.refMatchTexts("R1", 1, 1), ["R1"]);
});
test("a power symbol is one whose library symbol has (power); a missing library symbol is not power", () => {
  assert.ok(S.libIsPower(["symbol", "power:GND", ["power"], ["pin_names"]]));
  assert.ok(!S.libIsPower(["symbol", "Device:R", ["pin_names"]])); assert.ok(!S.libIsPower(null));
});
test("the result list is virtual: only the rows in view (and a margin) are built", () => {
  assert.deepStrictEqual(S.rowWindow(10000, 0, 200, 20, 8), { start: 0, end: 18, before: 0, after: 9982 * 20 });
  assert.deepStrictEqual(S.rowWindow(10000, 4000, 200, 20, 8), { start: 192, end: 218, before: 3840, after: (10000 - 218) * 20 });
  assert.deepStrictEqual(S.rowWindow(5, 4000, 200, 20, 8), { start: 5, end: 5, before: 100, after: 0 }, "scrolled past a list that shrank");
  assert.deepStrictEqual(S.rowWindow(0, 0, 200, 20, 8), { start: 0, end: 0, before: 0, after: 0 });
});
test("the rows sort by the first column when no column is chosen (StrNumCmp, ascending)", () => {
  const rows = ["R10", "R2", "C1", "r1"].map((r) => ({ cells: [r, "x"] }));
  assert.deepStrictEqual(S.sortRows(rows, 0, true).map((r) => r.cells[0]), ["C1", "r1", "R2", "R10"]);
});

// ---------------------------------------------------------------- Hierarchy navigator
const node = (path, page, children, extra) => Object.assign({ path, name: path, page, children: children || [] }, extra || {});
test("sub-sheets list in page order: integers numerically and first, equal pages in file order", () => {
  const tree = node("/", "1", [node("/c", "10"), node("/b", "2"), node("/x", "A"), node("/a", "2"), node("/d", "3", [node("/d/2", "7"), node("/d/1", "5")])]);
  PG.sortTreeByPage(tree);
  assert.deepStrictEqual(tree.children.map((c) => c.path), ["/b", "/a", "/d", "/c", "/x"]);
  assert.deepStrictEqual(tree.children[2].children.map((c) => c.path), ["/d/1", "/d/2"]);
  const top = node("", "", [node("/t2", "9"), node("/t1", "1")], { virtual: true });
  PG.sortTreeByPage(top);
  assert.deepStrictEqual(top.children.map((c) => c.path), ["/t2", "/t1"], "the top-level sheets keep the project's order");
});
const TREE = () => node("/", "1", [node("/a", "2", [node("/a/x", "3"), node("/a/y", "4", [], { current: true })]), node("/b", "5")]);
test("the tree's arrow keys move between the rows in view and fold the nodes", () => {
  const t = TREE(), none = new Set();
  assert.deepStrictEqual(NAV.visibleRows(t, none).map((r) => r.node.path), ["/", "/a", "/a/x", "/a/y", "/b"]);
  assert.deepStrictEqual(NAV.visibleRows(t, new Set(["/a"])).map((r) => r.node.path), ["/", "/a", "/b"]);
  assert.deepStrictEqual(NAV.treeKey(t, none, "/a", "ArrowDown"), { select: "/a/x" });
  assert.deepStrictEqual(NAV.treeKey(t, none, "/a", "ArrowUp"), { select: "/" });
  assert.deepStrictEqual(NAV.treeKey(t, none, "/", "ArrowUp"), {}, "the first row stays");
  assert.deepStrictEqual(NAV.treeKey(t, none, "/b", "ArrowDown"), {}, "the last row stays");
  assert.deepStrictEqual(NAV.treeKey(t, new Set(["/a"]), "/a", "ArrowDown"), { select: "/b" }, "a folded node's children are skipped");
  assert.deepStrictEqual(NAV.treeKey(t, none, "/a/y", "Home"), { select: "/" }); assert.deepStrictEqual(NAV.treeKey(t, none, "/a", "End"), { select: "/b" });
  assert.deepStrictEqual(Array.from(NAV.treeKey(t, none, "/a", "ArrowLeft").closed), ["/a"], "Left folds an open node");
  assert.deepStrictEqual(NAV.treeKey(t, new Set(["/a"]), "/a", "ArrowLeft"), { select: "/" }, "then goes to the parent");
  assert.deepStrictEqual(NAV.treeKey(t, none, "/a/x", "ArrowLeft"), { select: "/a" });
  assert.deepStrictEqual(Array.from(NAV.treeKey(t, new Set(["/a"]), "/a", "ArrowRight").closed), [], "Right unfolds a folded node");
  assert.deepStrictEqual(NAV.treeKey(t, none, "/a", "ArrowRight"), { select: "/a/x" }, "then goes to the first child");
  assert.deepStrictEqual(NAV.treeKey(t, none, "/b", "ArrowRight"), {});
  assert.deepStrictEqual(Array.from(NAV.treeKey(t, none, "/a", "-").closed), ["/a"]); assert.deepStrictEqual(Array.from(NAV.treeKey(t, new Set(["/a"]), "/a", "+").closed), []);
  assert.deepStrictEqual(Array.from(NAV.treeKey(t, new Set(["/", "/a"]), "/", "*").closed), []);
  assert.strictEqual(NAV.treeKey(t, none, "/a", "x"), null, "any other key is not the tree's");
});
test("the row of the sheet on screen is unfolded into view; rows of the same sheet symbol are found", () => {
  const t = TREE();
  assert.deepStrictEqual(Array.from(NAV.revealCurrent(t, new Set(["/a", "/b"]))), ["/b"]);
  const same = new Set(["/b"]); assert.strictEqual(NAV.revealCurrent(t, same), same, "nothing folded above it: the same set");
  assert.deepStrictEqual(NAV.parentPaths(t), ["/", "/a"]);
  const twice = node("/", "1", [node("/p", "2", [node("/p/s", "3", [], { sheetId: "s1", parentDocId: "d" })]), node("/q", "4", [node("/q/s", "5", [], { sheetId: "s1", parentDocId: "d" }), node("/q/o", "6", [], { sheetId: "s2", parentDocId: "d" })])]);
  assert.deepStrictEqual(NAV.identicalPaths(twice, "/p/s"), ["/q/s"]); assert.deepStrictEqual(NAV.identicalPaths(twice, "/q/o"), []);
});
test("the folded nodes are kept per project", () => {
  const mem = new Map(), store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, v); } };
  NAV.saveCollapsed(store, "p1", new Set(["/a", "/b"]));
  assert.deepStrictEqual(Array.from(NAV.loadCollapsed(store, "p1")), ["/a", "/b"]); assert.deepStrictEqual(Array.from(NAV.loadCollapsed(store, "p2")), []);
  assert.strictEqual(NAV.collapsedKey("p1"), "kui.hierCollapsed.p1");
  mem.set(NAV.collapsedKey("p3"), "{bad"); assert.deepStrictEqual(Array.from(NAV.loadCollapsed(store, "p3")), []);
  assert.deepStrictEqual(Array.from(NAV.loadCollapsed(null, "p1")), []);
});

// ---------------------------------------------------------------- menu and toolbar conditions
const st = (o) => Object.assign({ selCount: 0, selKinds: [], itemCount: 3, idle: true, drawingWire: false, undo: 0, redo: 0, legacyLibIds: false, checks: {} }, o || {});
test("the schematic frame's enable conditions (setupUIConditions)", () => {
  const why = (id, o) => T.conditionWhy("sch", id, st(o));
  assert.ok(why("undo")); assert.strictEqual(why("undo", { undo: 1 }), null); assert.strictEqual(why("undo", { drawingWire: true }), null, "undo takes back the last wire segment");
  assert.ok(why("redo")); assert.strictEqual(why("redo", { redo: 2 }), null);
  assert.strictEqual(why("zoomFitSelection"), null, "no condition in eeschema");
  for (const id of T.SCH_ATTRIBUTE_CHECKS) assert.strictEqual(why(id), null, id + " is always enabled");
  assert.ok(why("ungroup", { selCount: 1, selKinds: ["symbol"] })); assert.strictEqual(why("ungroup", { selCount: 1, selKinds: ["group"] }), null);
  assert.ok(why("paste", { idle: false })); assert.strictEqual(why("paste"), null);
  assert.ok(why("remapSymbols")); assert.strictEqual(why("remapSymbols", { legacyLibIds: true }), null);
  assert.ok(T.CONDITION_FIRST.has("remapSymbols"));
  assert.strictEqual(why("cut"), null, "hasElements: a sheet with items, whatever is selected"); assert.ok(why("cut", { itemCount: 0 }), "an empty sheet");
  assert.ok(why("rotateCCW"), "the rest keep the selection rule"); assert.strictEqual(why("rotateCCW", { selCount: 1 }), null);
  assert.strictEqual(T.conditionWhy("pcb", "zoomFitSelection", st()), "Nothing selected");
});
test("an attribute entry is checked when every selected symbol, sheet and rule area carries it", () => {
  const sym = (dnp) => ["symbol", ["lib_id", "Device:R"], ["dnp", dnp ? "yes" : "no"], ["in_bom", "yes"], ["on_board", "yes"]];
  assert.strictEqual(VM.attributeChecked([sym(true), sym(true)], "dnp"), true);
  assert.strictEqual(VM.attributeChecked([sym(true), sym(false)], "dnp"), false);
  assert.strictEqual(VM.attributeChecked([["wire", ["pts"]]], "dnp"), false, "nothing that carries attributes");
  assert.strictEqual(VM.attributeChecked([sym(true), ["wire", ["pts"]], ["sheet", ["dnp", "yes"]]], "dnp"), true, "other items do not count");
});
test("File and the collaboration menu: For Older KiCad Version and Proposed Changes are listed", () => {
  const text = JSON.stringify(T);
  assert.ok(text.includes("exportForOlderVersion|For Older KiCad Version..."));
  assert.ok(/"collabComments","collabProposals"/.test(text), "Proposed Changes follows Comments");
  assert.ok(T.READ_ONLY_OK.has("collabProposals")); assert.ok(T.READ_ONLY_OK.has("showProjectManager"));
});

// ---------------------------------------------------------------- a field selected on its own
const FIELD = () => ["property", "Value", "10k", ["at", 10, 20, 0], ["effects", ["font", ["size", 1.27, 1.27]], ["justify", "left"]]];
const rgba = (t) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(t); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1] : null; };
test("a selected field shows SCH_FIELD's properties, not its symbol's", () => {
  const defs = FP.fieldProps(["Roboto"], rgba);
  assert.deepStrictEqual(defs.map((d) => d.group + "/" + d.name), ["Text", "Font", "Auto Thickness", "Italic", "Bold", "Visible", "Horizontal Justification", "Vertical Justification", "Color", "Text Size"].map((n) => "Text Properties/" + n)
    .concat(["Basic Properties/Show Field Name", "Basic Properties/Allow Autoplacement"]));
  const f = FIELD(), get = (n) => defs.find((d) => d.name === n).get(f);
  assert.strictEqual(get("Text"), "10k"); assert.strictEqual(get("Font"), "KiCad Font"); assert.strictEqual(get("Auto Thickness"), true); assert.strictEqual(get("Visible"), true);
  assert.strictEqual(get("Horizontal Justification"), "left"); assert.strictEqual(get("Vertical Justification"), "center"); assert.strictEqual(get("Color"), "");
  assert.strictEqual(get("Text Size"), 1.27); assert.strictEqual(get("Show Field Name"), false); assert.strictEqual(get("Allow Autoplacement"), true);
  assert.deepStrictEqual(defs.find((d) => d.name === "Font").choices.map((c) => c[0]), ["KiCad Font", "Roboto"]);
});
test("a field property edits a copy of the field's node and leaves the rest of it alone", () => {
  const defs = FP.fieldProps([], rgba), f = FIELD(), before = JSON.stringify(f);
  const put = (n, v, from) => defs.find((d) => d.name === n).set(from || f, v), get = (n, node) => defs.find((d) => d.name === n).get(node);
  let n = put("Visible", false); assert.strictEqual(get("Visible", n), false); assert.strictEqual(get("Text", n), "10k");
  n = put("Bold", true); assert.strictEqual(get("Bold", n), true);
  n = put("Text Size", 2.54); assert.strictEqual(get("Text Size", n), 2.54); assert.strictEqual(put("Text Size", 0), null, "a size must be positive");
  n = put("Horizontal Justification", "right"); assert.strictEqual(get("Horizontal Justification", n), "right");
  n = put("Show Field Name", true); assert.strictEqual(get("Show Field Name", n), true);
  n = put("Allow Autoplacement", false); assert.strictEqual(get("Allow Autoplacement", n), false);
  n = put("Color", "#ff0080"); assert.strictEqual(get("Color", n), "#ff0080"); assert.strictEqual(put("Color", "nope"), null);
  assert.strictEqual(get("Color", put("Color", "", n)), "", "an empty colour is unspecified");
  n = put("Text", "4k7"); assert.strictEqual(get("Text", n), "4k7");
  // SetAutoThickness: off stores the pen the text draws with, on drops it
  n = put("Auto Thickness", false); assert.strictEqual(get("Auto Thickness", n), false); assert.ok(JSON.stringify(n).includes('["thickness",0.1588]') || JSON.stringify(n).includes('["thickness",0.1587]'));
  assert.strictEqual(put("Auto Thickness", true), null, "already automatic");
  assert.strictEqual(get("Auto Thickness", put("Auto Thickness", true, n)), true);
  assert.strictEqual(FP.effectivePenWidth(1.27, true), 0.254);
  assert.strictEqual(JSON.stringify(f), before, "the field's own node is not touched");
});
test("the field's node inside its parent; the parent's row that edits its text", () => {
  const sym = ["symbol", ["lib_id", "Device:R"], ["property", "Reference", "R1"], FIELD()];
  assert.strictEqual(FP.fieldNodeOf(sym, "Value")[2], "10k"); assert.strictEqual(FP.fieldNodeOf(sym, "MPN"), null);
  const next = FIELD(); next[2] = "22k"; assert.ok(FP.replaceField(sym, "Value", next)); assert.strictEqual(FP.fieldNodeOf(sym, "Value")[2], "22k"); assert.ok(!FP.replaceField(sym, "MPN", next));
  assert.strictEqual(FP.parentFieldRow("sheet", "Sheetname"), "Sheet Name"); assert.strictEqual(FP.parentFieldRow("sheet", "Sheetfile"), "Sheet File");
  assert.strictEqual(FP.parentFieldRow("sheet", "Reference Suffix"), "Reference Suffix"); assert.strictEqual(FP.parentFieldRow("symbol", "Value"), "Value");
});

test("a sheet's reference suffix is validated as GetFieldValidationErrorMessage( SHEET_REF_SUFFIX ) does", () => {
  assert.strictEqual(SIL.fieldValidationError("SHEET_REF_SUFFIX", ""), "", "an empty suffix is allowed");
  assert.strictEqual(SIL.fieldValidationError("SHEET_REF_SUFFIX", "_A"), "");
  assert.strictEqual(SIL.fieldValidationError("SHEET_REF_SUFFIX", "a b"), "The reference suffix cannot contain space character(s).");
  assert.strictEqual(SIL.fieldValidationError("SHEET_REF_SUFFIX", "a?,"), "The reference suffix cannot contain '?' or ',' character(s).");
  assert.strictEqual(SIL.fieldValidationError("SHEET_REF_SUFFIX", "x{comma}y"), "The reference suffix cannot contain ',' character(s).", "an escaped comma is unescaped first");
  assert.strictEqual(SIL.fieldValidationError("SHEET_NAME", ""), "A sheet must have a name.");
});
test("Compare Schematic with Local History keeps KiCad's label", () => {
  const file = T.MENUS.sch.find((m) => m[0] === "&File")[1];
  assert.ok(file.includes("compareSchematicWithHistory")); assert.ok(!file.some((e) => typeof e === "string" && e.startsWith("compareSchematicWithHistory|")));
});

// ---------------------------------------------------------------- File > Import > Footprint Assignments
test("a .cmp file is read as processCmpToFootprintLinkFile reads it", () => {
  const text = "Cmp-Mod V01 Created by CvPcb\r\n\r\nBeginCmp\r\nTimeStamp = /1234;\r\nReference = U1;\r\nValueeCmp = LM358;\r\nIdModule  =  Package_SO:SOIC-8 ;\r\nEndCmp\r\n\nBeginCmp\nReference = R1;\nIdModule = ;\nEndCmp\nBeginCmp\nIdModule = X:Y;\nEndCmp\nBeginCmp\nReference = C1\nEndCmp\n";
  assert.deepStrictEqual(CMP.parseCmpFile(text), [{ reference: "U1", footprint: "Package_SO:SOIC-8" }, { reference: "R1", footprint: "" }, { reference: "", footprint: "X:Y" }, { reference: "", footprint: "" }],
    "the value lies between '=' and the last ';' (none: empty)");
});
test("every unit with the reference takes the footprint; visibility kept, shown or hidden", () => {
  const sym = (ref, fp, hidden) => ["symbol", ["lib_id", "Amp:LM358"], ["at", 0, 0, 0], ["property", "Reference", ref, ["at", 0, 0, 0], ["effects", ["font", ["size", 1.27, 1.27]]]],
    ["property", "Footprint", fp, ["at", 0, 0, 0], ["effects", ["font", ["size", 1.27, 1.27]]].concat(hidden ? [["hide", "yes"]] : [])]];
  const nodes = { "d1:a": sym("U1", "", true), "d1:b": sym("U1", "", false), "d2:c": sym("U2", "Old:Fp", true) };
  const refs = [{ docId: "d1", id: "a", ref: "U1" }, { docId: "d1", id: "b", ref: "U1" }, { docId: "d2", id: "c", ref: "U2" }];
  const nodeOf = (d, id) => nodes[d + ":" + id] || null;
  const fpOf = (n) => n.find((c) => Array.isArray(c) && c[0] === "property" && c[1] === "Footprint");
  const hidden = (n) => SIL.isHidden(fpOf(n));
  const e0 = CMP.cmpEdits([{ reference: "U1", footprint: "Pkg:SO8" }], refs, nodeOf, 0);
  assert.deepStrictEqual(Array.from(e0.keys()), ["d1"]); assert.deepStrictEqual(Array.from(e0.get("d1").keys()), ["a", "b"], "both units");
  assert.strictEqual(fpOf(e0.get("d1").get("a"))[2], "Pkg:SO8"); assert.strictEqual(hidden(e0.get("d1").get("a")), true); assert.strictEqual(hidden(e0.get("d1").get("b")), false, "kept as it was");
  const e1 = CMP.cmpEdits([{ reference: "U1", footprint: "Pkg:SO8" }, { reference: "U2", footprint: "" }], refs, nodeOf, 1);
  assert.strictEqual(hidden(e1.get("d1").get("a")), false, "shown"); assert.strictEqual(fpOf(e1.get("d2").get("c"))[2], "", "an empty footprint is written too");
  const e2 = CMP.cmpEdits([{ reference: "U1", footprint: "Pkg:SO8" }], refs, nodeOf, 2);
  assert.strictEqual(hidden(e2.get("d1").get("b")), true, "hidden");
  assert.strictEqual(CMP.cmpEdits([{ reference: "", footprint: "X:Y" }, { reference: "Q9", footprint: "X:Y" }], refs, nodeOf, 0).size, 0, "no reference, or no such symbol");
  assert.strictEqual(fpOf(nodes["d1:a"])[2], "", "the symbols' own nodes are not touched");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
