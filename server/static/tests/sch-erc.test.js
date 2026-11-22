// sch-erc.test.js — ERC parity with KiCad (eeschema/erc/erc.cpp, connection_graph.cpp, sch_reference_list.cpp,
// dialog_erc.cpp): the browser engine's messages and rules, the tests over whole nets of the hierarchy, and the
// dialog's pure parts (row texts, list order, counts, exclusions as KiCad stores them, the text and JSON reports,
// FocusOnLocation's scroll rule).
// Run: node server/static/tests/sch-erc.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const R = load(["dialogs", "erc-rules.ts"]), X = load(["dialogs", "erc-exclusions.ts"]), REP = load(["dialogs", "erc-report.ts"]), KC = load(["editor", "kicad-check.ts"]);
const IU = 1e4;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const HEAD = '(kicad_sch (version 20250114) (generator "t") (uuid "root-uuid") (paper "A4") ';
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(),
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU)); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
const PIN = (type, name, num, x, y, hide) => `(pin ${type} line (at ${x} ${y} 0) (length 2.54)${hide ? " (hide yes)" : ""} (name "${name}" (effects (font (size 1.27 1.27)))) (number "${num}" (effects (font (size 1.27 1.27)))))`;
const LIB = (name, ref, pins, extra) => `(symbol "${name}" ${extra || ""} (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "${ref}" (at 0 -2.54 0) (effects (font (size 1.27 1.27)))) (property "Value" "${name.split(":")[1]}" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
  (symbol "${name.split(":")[1]}_1_1" ${pins}))`;
function fresh() { const d = K.parseDoc(HEAD + ")"), c = makeCtx(d); sch.onDocChanged(c); return { d, c }; }
function place(c, lib, at, ref) { const n = _.symbolNode(c.doc, lib, at, 0, ""); if (ref) _.setReference(n, ref); return K.createItem(c.doc, n); }
const wire = (d, a, b) => K.createItem(d, _.lineNode("wire", a, b));
const label = (d, kind, text, at) => K.createItem(d, _.labelNode(kind, text, at, 0));
const of = (ms, code) => ms.filter((m) => m.code === code);
const types = (d) => { for (const t of ["output", "input", "passive", "power_in", "power_out", "no_connect", "free", "bidirectional"]) d.lib.set("T:" + t.toUpperCase(), K.parse(LIB("T:" + t.toUpperCase(), "U", PIN(t, "P", "1", 0, 0)))); };
const setProp = (it, name, v) => { const p = K.kids(it.node, "property").find((q) => K.str(q[1]) === name); if (p) p[2] = v; else it.node.push(K.parse(`(property "${name}" "${v}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))`)); };

// ---------------------------------------------------------------- the browser engine
test("annotation (CheckAnnotation): power symbols left out, the first unannotated symbol only, the duplicate on the first item, extra units and unit counts", () => {
  const { d, c } = fresh(); types(d);
  d.lib.set("power:VCC", K.parse(LIB("power:VCC", "#PWR", PIN("power_in", "VCC", "1", 0, 0), "(power)")));
  place(c, "power:VCC", [20, 20], "#PWR?"); place(c, "power:VCC", [30, 20], "#PWR01"); place(c, "power:VCC", [40, 20], "#PWR01");
  const q1 = place(c, "T:PASSIVE", [50.8, 50.8], "R?"), q2 = place(c, "T:PASSIVE", [63.5, 50.8], "R?");
  let ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "unannotated").map((m) => [m.text, m.ids.join()]), [["Item not annotated: R?", q1.id]], "one marker, and none for #PWR?");
  // two "R?" are also the same reference twice (CheckAnnotation's second pass does not ask whether they are annotated)
  assert.deepStrictEqual(of(ms, "duplicate_reference").map((m) => [m.text, m.x, m.ids.join()]), [["Duplicate items R?\n", 50.8, q1.id + "," + q2.id]]);
  _.setReference(q1.node, "R1"); _.setReference(q2.node, "R1"); K.buildGeom(d, q1); K.buildGeom(d, q2);
  ms = sch.ercCheck(d);
  assert.strictEqual(of(ms, "unannotated").length, 0);
  const dup = of(ms, "duplicate_reference");
  assert.deepStrictEqual(dup.map((m) => [m.text, m.x, m.y, m.ids.join()]), [["Duplicate items R1\n", 50.8, 50.8, q1.id + "," + q2.id]], "at the first symbol, (first, second); the #PWR01 pair is not one");
  // a unit the library symbol does not have; then the same reference on packages of different unit counts
  const u = place(c, "T:INPUT", [76.2, 50.8], "U7"); u.node.splice(u.node.findIndex((x) => Array.isArray(x) && x[0] === "unit"), 1, ["unit", 3]);
  ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "extra_units").map((m) => m.text), ["Error: symbol U7C (unit 3) exceeds units defined (1)"]);
  d.lib.set("T:DUAL", K.parse(`(symbol "T:DUAL" (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "DUAL" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "DUAL_1_1" ${PIN("passive", "A", "1", 0, 0)}) (symbol "DUAL_2_1" ${PIN("passive", "B", "2", 0, 0)}))`));
  u.node.splice(u.node.findIndex((x) => Array.isArray(x) && x[0] === "unit"), 1, ["unit", 1]);
  const v = place(c, "T:DUAL", [88.9, 50.8], "U7"); v.node.splice(v.node.findIndex((x) => Array.isArray(x) && x[0] === "unit"), 1, ["unit", 2]);
  ms = sch.ercCheck(d);
  assert.ok(of(ms, "duplicate_reference").some((m) => /^Differing unit counts for item U7[AB] and U7[AB]\n$/.test(m.text)), of(ms, "duplicate_reference").map((m) => m.text).join("|"));
  assert.strictEqual(_.strNumCmp("U2", "U10") < 0, true);
});

test("pin not connected (ercCheckNoConnects): a wire stub does not connect a pin, 'free' and 'no connection' pins are not reported", () => {
  const { d, c } = fresh(); types(d);
  const a = place(c, "T:INPUT", [50.8, 50.8], "U1"); wire(d, [50.8, 50.8], [63.5, 50.8]);
  place(c, "T:FREE", [50.8, 76.2], "U2"); place(c, "T:NO_CONNECT", [50.8, 88.9], "U3");
  const ms = sch.ercCheck(d), pnc = of(ms, "pin_not_connected");
  assert.deepStrictEqual(pnc.map((m) => [m.text, m.severity, m.ids.join(), m.items[0].desc]), [["Pin not connected", "error", a.id, "Symbol U1 Pin 1 [P, Input, Line]"]]);
  assert.deepStrictEqual(of(ms, "unconnected_wire_endpoint").map((m) => [m.text, m.x]), [["Unconnected wire endpoint", 63.5]]);
  // a label on the stub is something to connect to
  label(d, "label", "SIG", [63.5, 50.8]);
  assert.strictEqual(of(sch.ercCheck(d), "pin_not_connected").length, 0);
});

test("no-connect checks: a flag on a net of two pins, a 'no connection' pin that is wired, a flag on nothing", () => {
  const { d, c } = fresh(); types(d);
  // one pin, a stub and a flag: fine
  place(c, "T:INPUT", [50.8, 50.8], "U1"); wire(d, [50.8, 50.8], [63.5, 50.8]); K.createItem(d, _.noConnectNode([63.5, 50.8]));
  let ms = sch.ercCheck(d);
  assert.strictEqual(of(ms, "no_connect_connected").length, 0); assert.strictEqual(of(ms, "pin_not_connected").length, 0);
  // two pins and a flag
  const a = place(c, "T:PASSIVE", [50.8, 76.2], "R1"), b = place(c, "T:PASSIVE", [76.2, 76.2], "R2"); wire(d, [50.8, 76.2], [76.2, 76.2]); const nc = K.createItem(d, _.noConnectNode([50.8, 76.2]));
  ms = sch.ercCheck(d);
  const ncc = of(ms, "no_connect_connected");
  assert.strictEqual(ncc.length, 1); assert.strictEqual(ncc[0].text, 'A pin with a "no connection" flag is connected'); assert.strictEqual(ncc[0].severity, "warning");
  assert.ok(ncc[0].ids.includes(nc.id) && (ncc[0].ids.includes(a.id) || ncc[0].ids.includes(b.id)) && ncc[0].items.length === 2 && /^Symbol R[12] Pin 1/.test(ncc[0].items[0].desc) && ncc[0].items[1].desc === "No Connect", JSON.stringify(ncc[0]));
  // TestNoConnectPins: a pin of the "no connection" type with a wire on it
  place(c, "T:NO_CONNECT", [50.8, 101.6], "U5"); wire(d, [50.8, 101.6], [63.5, 101.6]); place(c, "T:PASSIVE", [63.5, 101.6], "R3");
  ms = sch.ercCheck(d);
  assert.deepStrictEqual(ms.filter((m) => m.text === "Pin with 'no connection' type is connected").map((m) => [m.code, m.severity, m.x, m.y]), [["no_connect_connected", "warning", 50.8, 101.6]]);
  // a flag on nothing
  K.createItem(d, _.noConnectNode([150, 150]));
  assert.deepStrictEqual(of(sch.ercCheck(d), "no_connect_dangling").map((m) => [m.text, m.x]), [['Unconnected "no connection" flag', 150]]);
});

test("four items at one point (TestFourWayJunction): pins count, one per symbol, and wire ends; a junction dot is not needed", () => {
  const { d, c } = fresh(); types(d);
  place(c, "T:PASSIVE", [101.6, 101.6], "R1"); place(c, "T:PASSIVE", [101.6, 101.6], "R2");
  wire(d, [101.6, 101.6], [114.3, 101.6]); const w3 = wire(d, [101.6, 101.6], [101.6, 114.3]);
  let ms = of(sch.ercCheck(d), "four_way_junction");
  assert.deepStrictEqual(ms.map((m) => [m.text, m.severity, m.ids.length]), [["Four items connected at 1016000, 1016000", "warning", 4]]);
  K.applyChange(d, { kind: "REMOVED", id: w3.id }, IU);
  assert.strictEqual(of(sch.ercCheck(d), "four_way_junction").length, 0, "three items");
});

test("dangling wires: buses are not wires, a floating group is one wire_dangling at its first wire's start", () => {
  const { d } = fresh();
  K.createItem(d, _.lineNode("bus", [20, 20], [40, 20]));
  let ms = sch.ercCheck(d);
  assert.strictEqual(of(ms, "unconnected_wire_endpoint").length, 0); assert.strictEqual(of(ms, "wire_dangling").length, 0);
  const w1 = wire(d, [50.8, 50.8], [63.5, 50.8]), w2 = wire(d, [63.5, 50.8], [63.5, 63.5]);
  ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "wire_dangling").map((m) => [m.text, m.x, m.y, m.ids.join()]), [["Wires not connected to anything", 50.8, 50.8, w1.id + "," + w2.id]]);
  assert.strictEqual(of(ms, "unconnected_wire_endpoint").length, 2, "the endpoint warnings come as well");
});

test("labels (ercCheckLabels): one pin on a global label's net, no pin at all, a directive label on nothing", () => {
  const { d, c } = fresh(); types(d);
  place(c, "T:PASSIVE", [50.8, 50.8], "R1"); wire(d, [50.8, 50.8], [63.5, 50.8]); const g = label(d, "global_label", "ONLY", [63.5, 50.8]);
  let ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "isolated_pin_label").map((m) => [m.text, m.severity, m.ids.join()]), [["Label connected to only one pin", "warning", g.id]]);
  // the same name with a second pin elsewhere on the sheet: the net has two pins
  place(c, "T:PASSIVE", [50.8, 76.2], "R2"); wire(d, [50.8, 76.2], [63.5, 76.2]); label(d, "global_label", "ONLY", [63.5, 76.2]);
  ms = sch.ercCheck(d); assert.strictEqual(of(ms, "isolated_pin_label").length, 0); assert.strictEqual(of(ms, "label_dangling").length, 0);
  // a label on a wire whose net has no pin
  wire(d, [101.6, 50.8], [114.3, 50.8]); const l = label(d, "label", "EMPTY", [101.6, 50.8]);
  ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "label_dangling").map((m) => [m.text, m.severity, m.ids.join()]), [["Label not connected", "error", l.id]]);
  // a directive label touching nothing
  const nf = K.createItem(d, K.parse('(netclass_flag "" (length 2.54) (shape round) (at 150 150 0) (effects (font (size 1.27 1.27))) (uuid "nf1") (property "Netclass" "HV" (at 150 148 0) (effects (font (size 1.27 1.27)))))'));
  ms = sch.ercCheck(d);
  assert.ok(of(ms, "label_dangling").some((m) => m.ids.includes(nf.id) && m.text === "Label not connected"), JSON.stringify(of(ms, "label_dangling")));
});

test("a lone input on a labelled wire is not driven (no minimum pin count); a single-unit reference used twice gets no different_unit_footprint", () => {
  const { d, c } = fresh(); types(d);
  const i1 = place(c, "T:INPUT", [50.8, 50.8], "U1"); wire(d, [50.8, 50.8], [63.5, 50.8]); label(d, "label", "IN", [63.5, 50.8]);
  let ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "pin_not_driven").map((m) => [m.text, m.severity, m.ids.join()]), [["Input pin not driven by any Output pins", "error", i1.id]]);
  const a = place(c, "T:PASSIVE", [50.8, 76.2], "R1"), b = place(c, "T:PASSIVE", [76.2, 76.2], "R1");
  setProp(a, "Footprint", "Resistor_SMD:R_0402"); setProp(b, "Footprint", "Resistor_SMD:R_0603");
  ms = sch.ercCheck(d);
  assert.strictEqual(of(ms, "different_unit_footprint").length, 0); assert.strictEqual(of(ms, "duplicate_reference").length, 1);
});

test("hierarchy (ercCheckHierSheets): labels on a top-level sheet, a dangling sheet pin, the label marker once and on the sub-sheet", () => {
  const { d, c } = fresh(); types(d);
  const hl = label(d, "hierarchical_label", "UP", [30, 30]);
  let ms = sch.ercCheck(d, { root: true });
  assert.ok(ms.some((m) => m.code === "pin_not_connected" && m.text === "Hierarchical label 'UP' in root sheet cannot be connected to non-existent parent sheet" && m.ids.includes(hl.id)));
  assert.ok(!sch.ercCheck(d).some((m) => /root sheet/.test(m.text)), "only when the sheet is known to be top-level");
  K.applyChange(d, { kind: "REMOVED", id: hl.id }, IU);
  const sheet = K.createItem(d, _.sheetNode([152.4, 152.4], [177.8, 165.1], "Sub", "Sub.kicad_sch")); _.placeSheetPin(c, sheet, "A", [152.4, 154.94], "left"); _.placeSheetPin(c, d.items.get(sheet.id), "B", [152.4, 157.48], "left");
  wire(d, [139.7, 154.94], [152.4, 154.94]); place(c, "T:PASSIVE", [139.7, 154.94], "R9");
  ms = sch.ercCheck(d, { root: true });
  const pin = ms.filter((m) => m.code === "pin_not_connected" && m.ids.includes(sheet.id));
  assert.deepStrictEqual(pin.map((m) => [m.text, m.x, m.y, m.items[0].desc]), [["Pin not connected", 152.4, 157.48, "Hierarchical Sheet Pin 'B'"]]);
  // the whole hierarchy: the sub-sheet's label without a sheet pin is reported once, on the sub-sheet
  const sub = K.parseDoc(HEAD.replace("root-uuid", "sub-uuid") + '(hierarchical_label "A" (shape input) (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "ha")) (hierarchical_label "C" (shape input) (at 10 20 0) (effects (font (size 1.27 1.27)) (justify left)) (uuid "hc")))');
  const top = sch.ercCheck(d, { root: true, crossSheet: false, sheetDocs: new Map([["Sub.kicad_sch", sub]]) });
  const child = sch.ercCheck(sub, { crossSheet: false, parentPins: ["A", "B"] });
  assert.deepStrictEqual(of(top, "hier_label_mismatch").map((m) => m.text), ["Sheet pin B has no matching hierarchical label inside the sheet"]);
  assert.deepStrictEqual(of(child, "hier_label_mismatch").map((m) => [m.text, m.ids.join()]), [["Hierarchical label C has no matching sheet pin in the parent sheet", "hc"]]);
});

test("whole nets (TestPinToPin over the hierarchy): a conflict between two sheets, a driver on another sheet, a net leaving an unlinked sheet", () => {
  const top = fresh(), sub = fresh(); types(top.d); types(sub.d);
  // top: an output on sheet pin S; sub: an output on hierarchical label S
  const o1 = place(top.c, "T:OUTPUT", [50.8, 50.8], "U1");
  const sheet = K.createItem(top.d, _.sheetNode([76.2, 45.72], [101.6, 58.42], "Sub", "Sub.kicad_sch")); _.placeSheetPin(top.c, sheet, "S", [76.2, 50.8], "left");
  wire(top.d, [50.8, 50.8], [76.2, 50.8]);
  const o2 = place(sub.c, "T:OUTPUT", [50.8, 50.8], "U2"); wire(sub.d, [50.8, 50.8], [63.5, 50.8]); label(sub.d, "hierarchical_label", "S", [63.5, 50.8]);
  // each sheet alone: nothing to say about a net that leaves the sheet
  assert.strictEqual(of(sch.ercCheck(top.d), "pin_to_pin").length, 0);
  const per = sch.ercHierarchy([{ doc: top.d, key: "", root: true }, { doc: sub.d, key: "s", parent: 0, sheetId: sheet.id }]);
  const pp = per[0].concat(per[1]).filter((m) => m.code === "pin_to_pin");
  assert.strictEqual(pp.length, 1); assert.strictEqual(pp[0].text, "Pins of type Output and Output are connected");
  assert.deepStrictEqual(pp[0].ids, [o1.id, o2.id]); assert.strictEqual(per[0].includes(pp[0]), true, "the marker sits on its first pin's sheet");
  assert.ok(pp[0].kiids && pp[0].kiids.length === 2 && pp[0].kiids[0] !== o1.id, "the exclusion ids are the pins' own uuids");
  // an input on the top sheet driven by the sub-sheet's output is driven; without the link it is left alone, not flagged
  const t2 = fresh(), s2 = fresh(); types(t2.d); types(s2.d);
  place(t2.c, "T:INPUT", [50.8, 50.8], "U1"); const sh2 = K.createItem(t2.d, _.sheetNode([76.2, 45.72], [101.6, 58.42], "Sub", "Sub.kicad_sch")); _.placeSheetPin(t2.c, sh2, "S", [76.2, 50.8], "left"); wire(t2.d, [50.8, 50.8], [76.2, 50.8]);
  const inSub = place(s2.c, "T:INPUT", [50.8, 50.8], "U2"); wire(s2.d, [50.8, 50.8], [63.5, 50.8]); label(s2.d, "hierarchical_label", "S", [63.5, 50.8]);
  let linked = sch.ercHierarchy([{ doc: t2.d, key: "", root: true }, { doc: s2.d, key: "s", parent: 0, sheetId: sh2.id }]);
  assert.deepStrictEqual(of(linked[0], "pin_not_driven").map((m) => m.text), ["Input pin not driven by any Output pins"], "two inputs across two sheets: one marker, on the first pin");
  assert.strictEqual(of(linked[1], "pin_not_driven").length, 0);
  assert.strictEqual(of(sch.ercHierarchy([{ doc: t2.d, key: "", root: true }, { doc: s2.d, key: "s", parent: 0, sheetId: sh2.id }], { showAllErrors: true }).flat(), "pin_not_driven").length, 2, "Show all errors: every pin needing a driver");
  // an output on the sub-sheet drives the top sheet's input
  K.applyChange(s2.d, { kind: "REMOVED", id: inSub.id }, IU); place(s2.c, "T:OUTPUT", [50.8, 50.8], "U2");
  linked = sch.ercHierarchy([{ doc: t2.d, key: "", root: true }, { doc: s2.d, key: "s", parent: 0, sheetId: sh2.id }]);
  assert.strictEqual(of(linked.flat(), "pin_not_driven").length, 0);
  const loose = sch.ercHierarchy([{ doc: t2.d, key: "a" }, { doc: s2.d, key: "b" }]);
  assert.strictEqual(of(loose[0], "pin_not_driven").length, 0, "the rest of the net is unknown");
  // global names join sheets: a power input on one sheet, the PWR_FLAG on the other
  const g1 = fresh(), g2 = fresh(); types(g1.d); types(g2.d);
  place(g1.c, "T:POWER_IN", [50.8, 50.8], "U1"); wire(g1.d, [50.8, 50.8], [63.5, 50.8]); label(g1.d, "global_label", "VBUS", [63.5, 50.8]);
  assert.strictEqual(of(sch.ercHierarchy([{ doc: g1.d, key: "", root: true }])[0], "power_pin_not_driven").length, 1);
  place(g2.c, "T:POWER_OUT", [50.8, 50.8], "U2"); wire(g2.d, [50.8, 50.8], [63.5, 50.8]); label(g2.d, "global_label", "VBUS", [63.5, 50.8]);
  const both = sch.ercHierarchy([{ doc: g1.d, key: "", root: true }, { doc: g2.d, key: "x", root: true }]);
  assert.strictEqual(of(both[0], "power_pin_not_driven").length, 0);
});

test("tests the engine now has: two names on one net, a unit pin on two nets, duplicate pin numbers on two nets, footprint filters", () => {
  const { d, c } = fresh(); types(d);
  place(c, "T:PASSIVE", [50.8, 50.8], "R1"); place(c, "T:PASSIVE", [76.2, 50.8], "R2"); wire(d, [50.8, 50.8], [76.2, 50.8]);
  const la = label(d, "label", "AAA", [55.88, 50.8]), lb = label(d, "label", "BBB", [66.04, 50.8]);
  let ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "multiple_net_names").map((m) => [m.text, m.severity, m.x, m.ids.join()]), [["Both AAA and BBB are attached to the same items; AAA will be used in the netlist", "warning", 66.04, la.id + "," + lb.id]]);
  // TestDuplicatePinNets: a symbol with two pins numbered 1 on different nets
  d.lib.set("T:TWIN", K.parse(LIB("T:TWIN", "J", PIN("passive", "A", "1", 0, 0) + " " + PIN("passive", "B", "1", 0, 5.08))));
  const j = place(c, "T:TWIN", [50.8, 101.6], "J1");
  wire(d, [50.8, 101.6], [63.5, 101.6]); label(d, "label", "N1", [63.5, 101.6]); place(c, "T:PASSIVE", [63.5, 101.6], "R3");
  ms = sch.ercCheck(d);
  const dp = of(ms, "duplicate_pins");
  assert.strictEqual(dp.length, 1); assert.strictEqual(dp[0].severity, "error"); assert.ok(dp[0].ids.includes(j.id));
  assert.ok(/^Pin 1 on symbol 'J1' is connected to different nets: \S+ and \S+$/.test(dp[0].text), dp[0].text);
  assert.strictEqual(R.ercRuleTitle("duplicate_pins"), "Duplicate pins with different nets");
  // TestMultUnitPinConflicts: pin 8 of U1 on two nets in two units
  d.lib.set("T:QUAD", K.parse(`(symbol "T:QUAD" (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "QUAD" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "QUAD_1_1" ${PIN("passive", "V", "8", 0, 0)}) (symbol "QUAD_2_1" ${PIN("passive", "V", "8", 0, 0)}))`));
  const ua = place(c, "T:QUAD", [127, 50.8], "U1"), ub = place(c, "T:QUAD", [127, 76.2], "U1"); ub.node.splice(ub.node.findIndex((x) => Array.isArray(x) && x[0] === "unit"), 1, ["unit", 2]);
  wire(d, [127, 50.8], [139.7, 50.8]); label(d, "label", "PA", [139.7, 50.8]); place(c, "T:PASSIVE", [139.7, 50.8], "R4");
  wire(d, [127, 76.2], [139.7, 76.2]); label(d, "label", "PB", [139.7, 76.2]); place(c, "T:PASSIVE", [139.7, 76.2], "R5");
  ms = sch.ercCheck(d);
  const du = of(ms, "different_unit_net");
  assert.strictEqual(du.length, 1); assert.ok(/^Pin 8 is connected to both \/P[AB] and \/P[AB]$/.test(du[0].text), du[0].text); assert.ok(du[0].ids.includes(ua.id) && du[0].ids.includes(ub.id));
  // TestFootprintFilters
  d.lib.set("T:FILT", K.parse(LIB("T:FILT", "C", PIN("passive", "A", "1", 0, 0)).replace('(symbol "FILT_1_1"', '(property "ki_fp_filters" "C_* Cap?_*" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes))) (symbol "FILT_1_1"')));
  const cap = place(c, "T:FILT", [152.4, 101.6], "C1"); setProp(cap, "Footprint", "Resistor_SMD:R_0402");
  ms = sch.ercCheck(d);
  assert.deepStrictEqual(of(ms, "footprint_filter").map((m) => [m.text, m.severity, m.ids.join()]), [["Assigned footprint (r_0402) doesn't match footprint filters (C_* Cap?_*)", "warning", cap.id]]);
  setProp(cap, "Footprint", "Capacitor_SMD:C_0402"); assert.strictEqual(of(sch.ercCheck(d), "footprint_filter").length, 0);
  setProp(cap, "Footprint", "Capacitor_SMD:CapX_1"); assert.strictEqual(of(sch.ercCheck(d), "footprint_filter").length, 0);
});

test("markers come in KiCad's sheet order (x, then y, then the message) and count annotation errors for the dialog", () => {
  const { d, c } = fresh(); types(d);
  place(c, "T:INPUT", [76.2, 25.4], "U2"); place(c, "T:INPUT", [50.8, 101.6], "U1"); place(c, "T:PASSIVE", [50.8, 50.8], "R?");
  const ms = sch.ercCheck(d).filter((m) => m.code === "pin_not_connected");
  assert.deepStrictEqual(ms.map((m) => [m.x, m.y]), [[50.8, 50.8], [50.8, 101.6], [76.2, 25.4]]);
  assert.strictEqual(sch.checkAnnotate([d]), 1);
  assert.deepStrictEqual(R.sheetOrder([{ x: 2, y: 1, text: "b" }, { x: 1, y: 9, text: "z" }, { x: 2, y: 1, text: "a" }]).map((m) => m.text), ["z", "a", "b"]);
});

// ---------------------------------------------------------------- the dialog's pure parts
test("rule table: the four rules KiCad lists, their default severities, titles of the internal codes", () => {
  const keys = R.ERC_RULES.filter((r) => r.length === 2).map((r) => r[1]), at = (k) => keys.indexOf(k);
  assert.ok(at("empty_power_value") === at("empty_label_name") + 1 && at("wired_implicit_power") === at("empty_power_value") + 1);
  assert.strictEqual(at("duplicate_sheet_suffix"), at("duplicate_sheet_names") + 1); assert.strictEqual(at("ref_suffix_mismatch"), at("unannotated") + 1);
  assert.deepStrictEqual(["empty_power_value", "wired_implicit_power", "duplicate_sheet_suffix", "ref_suffix_mismatch"].map(R.defaultSeverity), ["error", "warning", "error", "warning"]);
  assert.strictEqual(R.ercRuleTitle("wired_implicit_power"), "Wired hidden power input pin also connects globally by name");
  assert.strictEqual(R.ercRuleTitle("generic-warning"), "Warning"); assert.strictEqual(R.ercRuleTitle("generic-error"), "Error"); assert.strictEqual(R.ercRuleTitle("nope"), "");
  assert.deepStrictEqual(R.ignoredRules({ pin_not_connected: "ignore", four_way_junction: "warning" }).map((r) => r[1]).slice(0, 1), ["pin_not_connected"]);
  assert.ok(R.ignoredRules({}).every((r) => R.defaultSeverity(r[1]) === "ignore"));
});

test("violation tree texts, list order and counts (ERC_TREE_MODEL::GetValue, SetSeverities' stable sort, updateDisplayedCounts)", () => {
  assert.strictEqual(R.markerPrefix({ severity: "error" }), "Error: "); assert.strictEqual(R.markerPrefix({ severity: "warning" }), "Warning: ");
  assert.strictEqual(R.markerPrefix({ severity: "exclusion", base: "warning" }), "Excluded warning: "); assert.strictEqual(R.markerPrefix({ severity: "exclusion", base: "error" }), "Excluded error: ");
  const l = [{ severity: "warning", n: 1 }, { severity: "exclusion", n: 2 }, { severity: "error", n: 3 }, { severity: "warning", n: 4 }, { severity: "error", n: 5 }];
  assert.deepStrictEqual(R.sortBySeverity(l).map((m) => m.n), [3, 5, 1, 4, 2]);
  assert.strictEqual(R.badgeText(0, false), ""); assert.strictEqual(R.badgeText(0, true), "0"); assert.strictEqual(R.badgeText(7, false), "7"); assert.strictEqual(R.badgeText(1000, true), "999+");
});

test("'Ignore' on pin conflicts: the project's pin_to_pin key is the warning's; errors stay (ERC_SETTINGS)", () => {
  const ms = [{ code: "pin_to_pin", severity: "error" }, { code: "pin_to_pin", severity: "warning" }, { code: "pin_not_connected", severity: "error" }];
  assert.deepStrictEqual(R.applySeverities(ms.map((m) => Object.assign({}, m)), { pin_to_pin: "ignore" }).map((m) => m.code + ":" + m.severity), ["pin_to_pin:error", "pin_not_connected:error"]);
  assert.deepStrictEqual(R.applySeverities(ms.map((m) => Object.assign({}, m)), { pin_not_connected: "ignore" }).map((m) => m.code + ":" + m.severity), ["pin_to_pin:error", "pin_to_pin:warning"]);
});

test("FocusOnLocation: the view moves only for a point near the edge, off screen or under the dialog, onto the free area", () => {
  const scr = { w: 1000, h: 600 };
  assert.strictEqual(R.focusScreenPoint([500, 300], scr, []), null, "in the middle: stays");
  assert.strictEqual(R.focusScreenPoint([120, 300], scr, []), null, "inside the viewport less a tenth of its width");
  assert.deepStrictEqual(R.focusScreenPoint([50, 300], scr, []), [500, 300], "within a tenth of the edge: centred");
  assert.deepStrictEqual(R.focusScreenPoint([1500, 300], scr, []), [500, 300]);
  // a dialog over the right half: a point under it (or within a tenth of its width) goes to the middle of the left half
  const dlg = { x: 500, y: 0, w: 500, h: 600 };
  assert.deepStrictEqual(R.focusScreenPoint([700, 300], scr, [dlg]), [250, 300]);
  assert.deepStrictEqual(R.focusScreenPoint([470, 300], scr, [dlg]), [250, 300], "within a tenth of the dialog's width of its edge");
  assert.strictEqual(R.focusScreenPoint([300, 300], scr, [dlg]), null);
  // a dialog in a corner: the free area's deepest part, not the screen centre
  const p = R.focusScreenPoint([900, 500], scr, [{ x: 600, y: 300, w: 400, h: 300 }]);
  assert.ok(p && p[0] < 600 && p[1] < 600 && !(p[0] > 600 && p[1] > 300), JSON.stringify(p));
});

test("exclusions as KiCad stores them (ERC_EXCLUSION::FromMarker): the pins' own uuids, the sheet paths, every item; KiCad's entries match", () => {
  const m = { code: "pin_to_pin", severity: "error", x: 50.8, y: 50.8, ids: ["sym-1", "sym-2"], kiids: ["pin-a", "pin-b"], uuidPath: ["root-uuid", "sheet-1"] };
  const erc = { meta: { version: 1 } };
  X.setExcluded(erc, m, true, "why");
  const e = erc.erc_exclusions[0];
  assert.deepStrictEqual(e.marker.items, [{ value: "pin-a" }, { value: "pin-b" }]);
  assert.deepStrictEqual(e.marker.sheet_specific_path, { path: [{ value: "root-uuid" }, { value: "sheet-1" }] });
  assert.deepStrictEqual(e.marker.main_item_sheet_path, e.marker.sheet_specific_path); assert.deepStrictEqual(e.marker.aux_item_sheet_path, e.marker.sheet_specific_path);
  assert.strictEqual(e.comment, "why");
  const back = X.readExclusions(erc);
  assert.deepStrictEqual(back[0].ids, ["pin-a", "pin-b"]); assert.deepStrictEqual(back[0].sheet, ["root-uuid", "sheet-1"]);
  assert.strictEqual(X.sameViolation(m, back[0]), true);
  assert.strictEqual(X.sameViolation(Object.assign({}, m, { uuidPath: ["root-uuid", "sheet-2"] }), back[0]), false, "another instance of a reused sheet");
  assert.strictEqual(X.sameViolation(Object.assign({}, m, { kiids: ["pin-a", "pin-c"] }), back[0]), false);
  // annotation markers are not sheet-specific; a legacy string with sheet paths reads back
  const an = { code: "duplicate_reference", severity: "error", x: 1, y: 2, ids: ["a", "b"], uuidPath: ["root-uuid"] };
  assert.strictEqual(X.legacyKey(an), "duplicate_reference|10000|20000|a|b");
  assert.strictEqual(X.legacyKey(m), "pin_to_pin|508000|508000|pin-a|pin-b|/root-uuid/sheet-1|/root-uuid/sheet-1|/root-uuid/sheet-1");
  const legacy = X.readExclusions({ erc_exclusions: ["pin_to_pin|508000|508000|pin-a|pin-b|/root-uuid/sheet-1|/root-uuid/sheet-1|/root-uuid/sheet-1"] });
  assert.strictEqual(X.sameViolation(m, legacy[0]), true);
  // an entry this editor wrote before (the owners' ids, no paths) still matches; kicad-cli's own "excluded" is honoured
  const old = X.readExclusions({ erc_exclusions: [{ marker: { error_type: X.protoExclusion(m, "").marker.error_type, position: { x_nm: 50800000, y_nm: 50800000 }, items: [{ value: "sym-1" }, { value: "sym-2" }] }, comment: "" }] });
  assert.strictEqual(X.sameViolation(m, old[0]), true);
  const marked = X.markExcluded([Object.assign({}, m, { excluded: true, comment: "from KiCad" }), Object.assign({}, m, { x: 9 })], []);
  assert.deepStrictEqual(marked.map((x) => [x.severity, x.base, x.comment]), [["exclusion", "error", "from KiCad"], ["error", undefined, undefined]]);
});

test("kicad-cli violations keep each item's own uuid beside the item that holds it", () => {
  const ix = new Map([["pin-a", "sym-1"], ["sym-1", "sym-1"]]);
  const m = KC.toMarker({ type: "pin_not_connected", severity: "error", description: "Pin not connected", items: [{ description: "Symbol U1 Pin 3 [IN+, Input, Line]", uuid: "pin-a", pos: { x: 10, y: 20 } }] }, ix);
  assert.deepStrictEqual(m.ids, ["sym-1"]); assert.deepStrictEqual(m.kiids, ["pin-a"]);
  assert.deepStrictEqual(m.items, [{ x: 10, y: 20, desc: "Symbol U1 Pin 3 [IN+, Input, Line]", uuid: "pin-a", id: "sym-1" }]);
});

test("reports: the text report prints the violation's message; the JSON report is ERC_REPORT::WriteJsonReport's", () => {
  const ms = [
    { code: "pin_to_pin", severity: "error", x: 50.8, y: 50.8, text: "Pins of type Output and Output are connected", ids: ["s1", "s2"],
      items: [{ x: 50.8, y: 50.8, desc: "Symbol U1 Pin 1 [P, Output, Line]", id: "s1", uuid: "p1" }, { x: 76, y: 50.8, desc: "Symbol U2 Pin 1 [P, Output, Line]", id: "s2", uuid: "p2" }] },
    { code: "unconnected_wire_endpoint", severity: "exclusion", base: "warning", comment: "ok", x: 1.27, y: 2.54, text: "Unconnected wire endpoint", ids: ["w1"], items: [{ x: 1.27, y: 2.54, desc: "Horizontal Wire, length %L", len: 12.7, id: "w1" }] },
  ];
  const txt = REP.ercTextReport(ms, { errors: true, warnings: true, exclusions: true, units: "mm", date: "2026-01-02T03:04:05", ignored: [], title: (m) => m.text });
  assert.ok(txt.includes("[pin_to_pin]: Pins of type Output and Output are connected\n    ; error\n    @(50.80 mm, 50.80 mm): Symbol U1 Pin 1 [P, Output, Line]\n"), txt);
  const json = REP.ercJsonReport(ms, { errors: true, warnings: false, exclusions: true, units: "mm", date: "2026-01-02T03:04:05", source: "top.kicad_sch", kicadVersion: "10.99.0",
    ignored: [["Four connection points are joined together", "four_way_junction"]], sheets: [{ path: "/", uuidPath: "/root-uuid" }, { path: "/Sub/", uuidPath: "/root-uuid/s1" }], sheetOf: (m) => (m.code === "pin_to_pin" ? 1 : 0), title: (m) => m.text });
  const o = JSON.parse(json);
  assert.deepStrictEqual(Object.keys(o), ["$schema", "coordinate_units", "date", "ignored_checks", "included_severities", "kicad_version", "sheets", "source"], "nlohmann writes the keys in order");
  assert.strictEqual(o.$schema, "https://schemas.kicad.org/erc.v1.json"); assert.strictEqual(o.coordinate_units, "mm"); assert.strictEqual(o.source, "top.kicad_sch");
  assert.deepStrictEqual(o.included_severities, ["error", "exclusion"]); assert.deepStrictEqual(o.ignored_checks, [{ description: "Four connection points are joined together", key: "four_way_junction" }]);
  assert.deepStrictEqual(o.sheets.map((s) => [s.path, s.uuid_path, s.violations.length]), [["/", "/root-uuid", 1], ["/Sub/", "/root-uuid/s1", 1]]);
  assert.deepStrictEqual(o.sheets[1].violations[0], { description: "Pins of type Output and Output are connected", severity: "error", type: "pin_to_pin",
    items: [{ description: "Symbol U1 Pin 1 [P, Output, Line]", pos: { x: 50.8, y: 50.8 }, uuid: "p1" }, { description: "Symbol U2 Pin 1 [P, Output, Line]", pos: { x: 76, y: 50.8 }, uuid: "p2" }] });
  const ex = o.sheets[0].violations[0];
  assert.strictEqual(ex.excluded, true); assert.strictEqual(ex.comment, "ok"); assert.strictEqual(ex.severity, "warning"); assert.strictEqual(ex.items[0].description, "Horizontal Wire, length 12.70 mm");
  assert.ok(json.startsWith('{\n    "$schema": "https://schemas.kicad.org/erc.v1.json",\n    "coordinate_units": "mm",'), json.slice(0, 120));
  assert.ok(json.includes('"x": 76.0,'), "a double keeps its decimal point");
});

test("ERC marker colours follow the colour theme (LAYER_ERC_ERR / WARN / EXCLUSION)", () => {
  assert.strictEqual(K.SCH_DEFAULT.ercErr, "rgba(230,9,13,0.8)"); assert.strictEqual(K.SCH_DEFAULT.ercWarn, "rgba(209,146,0,0.8)"); assert.strictEqual(K.SCH_DEFAULT.ercExcl, "rgba(194,194,194,0.8)");
  const classic = K.schThemeColors("classic");
  assert.deepStrictEqual([classic.ercErr, classic.ercWarn, classic.ercExcl], ["rgba(255,0,0,0.8)", "rgba(0,255,0,0.8)", "#C2C2C2"]);
  const fills = [], ctx = { save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, setLineDash() {}, fill() { fills.push(this.fillStyle); } };
  const draw = () => { fills.length = 0; K.drawMarkers(ctx, [{ x: 1, y: 1, severity: "error" }, { x: 2, y: 2, severity: "warning", brightened: true }], "sch", 0.15, "#FFFFFF"); return fills.slice(); };
  if (K.drawMarkers && K.setSchTheme) {
    K.setSchTheme("default"); assert.deepStrictEqual(draw(), ["rgba(230,9,13,0.8)", K.SCH.brightened], "a brightened marker takes LAYER_BRIGHTENED");
    K.setSchTheme("classic"); assert.strictEqual(draw()[0], "rgba(255,0,0,0.8)"); K.setSchTheme("default");
  }
});

console.log(`sch-erc: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
