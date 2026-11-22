// sch-annotation-parity.test.js — annotation and symbol parity with KiCad: references per sheet path
// (SCH_REFERENCE_LIST over the hierarchy), power symbols left alone, the used-designator tracker, CheckAnnotation's
// messages, duplicate time stamps, the instance reference / sub-reference on the canvas, sheet field autoplacement
// and the field autoplacer's power test and drawable area.
// Run: node server/static/tests/sch-annotation-parity.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const IU = 1e4, kid = K.kid, kids = K.kids, str = K.str;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const HEAD = '(kicad_sch (version 20250114) (generator "t") (uuid "root") (paper "A4") ';
const LIB = (id, ref, extra, units) => `(symbol "${id}" ${extra || ""} (property "Reference" "${ref}" (at 0 2 0) (effects (font (size 1.27 1.27)))) (property "Value" "V" (at 0 -2 0) (effects (font (size 1.27 1.27))))` +
  Array.from({ length: units || 1 }, (x, i) => `(symbol "${id.split(":")[1]}_${i + 1}_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none))) (pin passive line (at -3.81 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "${i + 1}" (effects (font (size 1.27 1.27))))))`).join("") + ")";
const LIBS = `(lib_symbols ${LIB("D:R", "R")} ${LIB("D:U", "U", "", 2)} ${LIB("power:GND", "#PWR", "(power)")})`;
const sym = (id, lib, ref, x, y, o) => `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit ${(o && o.unit) || 1}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${id}")` +
  ` (property "Reference" "${ref}" (at ${x} ${y - 2} 0) (effects (font (size 1.27 1.27)))) (property "Value" "${(o && o.value) || "V"}" (at ${x} ${y + 2} 0) (effects (font (size 1.27 1.27))))` +
  ` (instances (project "p" ${((o && o.paths) || [["/root", ref]]).map(([p, r, u]) => `(path "${p}" (reference "${r}") (unit ${u || (o && o.unit) || 1}))`).join(" ")})))`;
const docOf = (body) => K.parseDoc(HEAD + LIBS + body + ")", "kicad_sch");
const frag = (ch) => K.parse(ch.sexpr || ch.after || ch.node && K.serialize(ch.node) || "");
const nodeOf = (doc, ch) => { assert.ok(K.applyChange(doc, ch, IU)); return doc.items.get(ch.id).node; };
const refAt = (node, p) => { const e = _.instanceOn(node, p); return e ? str(kid(e, "reference")[1]) : null; };

test("a shared sheet is annotated once per sheet path; power symbols are left alone; sheets go in page order", () => {
  const root = docOf(sym("a", "D:R", "R?", 50, 50) + sym("g", "power:GND", "#PWR?", 20, 20));
  const sub = docOf(sym("b", "D:R", "R?", 30, 30, { paths: [["/root/s1", "R?"], ["/root/s2", "R?"]] }));
  const sheets = [{ doc: sub, path: "/root/s2", page: 3 }, { doc: root, path: "/root", page: 1, shown: true }, { doc: sub, path: "/root/s1", page: 2 }];
  const res = sch.annotateHierarchy(sheets, { all: true, sheets: sheets.map((sheet) => ({ sheet })) }, {});
  assert.strictEqual(res.errors.length, 0);
  const rc = res.changes.get(root), sc = res.changes.get(sub);
  assert.deepStrictEqual(rc.map((c) => c.id), ["a"], "the power symbol is not annotated (SYMBOL_FILTER_NON_POWER)");
  assert.strictEqual(sc.length, 1, "one change for the shared symbol");
  const a = nodeOf(root, rc[0]), b = nodeOf(sub, sc[0]);
  assert.strictEqual(refAt(a, "/root"), "R1");
  assert.deepStrictEqual([refAt(b, "/root/s1"), refAt(b, "/root/s2")], ["R2", "R3"], "each path its own reference, page 2 before page 3");
  assert.strictEqual(str(kids(a, "property")[0][2]), "R1", "the shown path's reference is the Reference field");
  // clearing one path leaves the other
  const cl = sch.clearAnnotationHierarchy([{ sheet: sheets[2] }]);
  const b2 = nodeOf(sub, cl.changes.get(sub)[0]);
  assert.deepStrictEqual([refAt(b2, "/root/s1"), refAt(b2, "/root/s2")], ["R?", "R3"]);
});

test("CompareRef / Split: natural, case-insensitive order; digits inside the prefix stay", () => {
  assert.ok(_.compareRef("R2", "R10") < 0); assert.ok(_.compareRef("r1", "R2") < 0); assert.ok(_.compareRef("C1", "R1") < 0);
  assert.deepStrictEqual(_.splitRef("U3A12"), { prefix: "U3A", num: 12, numStr: "12", isNew: false });
  assert.deepStrictEqual(_.splitRef("R?"), { prefix: "R", num: -1, numStr: "", isNew: true });
});

test("the used-designator tracker: designators once used are skipped unless reuse is on; it serializes as ranges", () => {
  const mk = () => docOf(sym("a", "D:R", "R?", 50, 50));
  const run = (tracker) => { const d = mk(), sh = [{ doc: d, path: "/root", page: 1, shown: true }]; const r = sch.annotateHierarchy(sh, { all: true, sheets: [{ sheet: sh[0] }] }, { tracker }); return refAt(nodeOf(d, r.changes.get(d)[0]), "/root"); };
  const t = { reuse: false, used: new Set(["R1", "R2"]) };
  assert.strictEqual(run(t), "R3"); assert.ok(t.used.has("R3"), "the new designator is recorded");
  assert.strictEqual(run({ reuse: true, used: new Set(["R1", "R2"]) }), "R1");
  const text = sch.serializeTracker(["R1", "R2", "R3", "C7", "U10"]);
  assert.deepStrictEqual([...sch.deserializeTracker(text)].sort(), ["C7", "R1", "R2", "R3", "U10"]);
  assert.ok(/R1-R?3/.test(text), "consecutive numbers collapse to a range: " + text);
});

test("CheckAnnotation: KiCad's messages for unannotated items, duplicates and differing unit values", () => {
  const d = docOf(sym("a", "D:R", "R1", 10, 10) + sym("b", "D:R", "R1", 20, 10) + sym("u1", "D:U", "U1", 30, 10, { unit: 1, value: "X" }) + sym("u2", "D:U", "U1", 40, 10, { unit: 2, value: "Y" }) + sym("q", "D:R", "R?", 60, 10));
  const sh = { doc: d, path: "/root", page: 1, shown: true }, out = [];
  const n = sch.checkAnnotation(sch.sheetReferences(sh, null, true), (code, msg) => out.push([code, msg]));
  assert.strictEqual(n, out.length);
  assert.ok(out.some(([c, m]) => c === "unannotated" && m === "Item not annotated: R?"), JSON.stringify(out));
  assert.ok(out.some(([c, m]) => c === "duplicate_reference" && m === "Duplicate items R1\n"), JSON.stringify(out));
  assert.ok(out.some(([c, m]) => c === "different_unit_value" && /^Different values for U1A \(X\) and U1B \(Y\)/.test(m)), JSON.stringify(out));
});

test("ReplaceDuplicateTimeStamps: the second item with a uuid gets a new one", () => {
  const d1 = docOf(sym("dup", "D:R", "R1", 10, 10)), d2 = docOf(sym("dup", "D:R", "R2", 10, 10) + sym("ok", "D:R", "R3", 20, 10));
  const r = sch.replaceDuplicateIds([d1, d2]);
  assert.strictEqual(r.count, 1); assert.ok(!r.changes.get(d1)); const ch = r.changes.get(d2);
  assert.deepStrictEqual(ch.map((c) => c.kind).sort(), ["ADDED", "REMOVED"]);
  assert.notStrictEqual(ch.find((c) => c.kind === "ADDED").id, "dup");
});

test("canvas: the symbol shows the reference and unit of the sheet path on screen, with the project's sub-reference notation", () => {
  const d = docOf(sym("u", "D:U", "U?", 30, 30, { paths: [["/root/s1", "U4", 2], ["/root/s2", "U9", 1]] }));
  const shown = () => d.items.get("u").geom.filter((g) => g.t === "text" && g.field === "Reference").map((g) => g.text)[0];
  assert.ok(K.setInstancePath(d, "/root/s1")); assert.strictEqual(d.items.get("u").ref, "U4"); assert.strictEqual(shown(), "U4B");
  assert.ok(K.setInstancePath(d, "/root/s2")); assert.strictEqual(shown(), "U9A");
  K.setSchFormatting({ subpartIdSeparator: 46, subpartFirstId: 49 }); K.setInstancePath(d, "/root/s1"); 
  try { assert.strictEqual(d.items.get("u").geom.filter((g) => g.t === "text" && g.field === "Reference")[0].text, "U4.2"); }
  finally { K.setSchFormatting({ subpartIdSeparator: 0, subpartFirstId: 65 }); }
  assert.deepStrictEqual(K.symbolInstance(d.items.get("u").node, "/root/s2"), { ref: "U9", unit: 1 });
  assert.strictEqual(K.symbolInstance(d.items.get("u").node, "/root/none"), null);
});

test("SCH_SHEET::AutoplaceFields: name above / file below; pins only on top and bottom turn both upright beside the sheet", () => {
  const n = _.sheetNode([100, 100], [120, 130], "S", "s.kicad_sch");
  const at = (name) => kid(kids(n, "property").find((p) => str(p[1]) === name), "at").slice(1);
  assert.deepStrictEqual([at("Sheetname"), at("Sheetfile")], [[100, 99.2884, 0], [100, 130.5846, 0]], "border/2 + 4 IU + text size x 0.5 / 0.4");
  n.push(_.sheetPinNode("P", [110, 130], "bottom")); _.autoplaceSheetFields(n);
  assert.deepStrictEqual([at("Sheetname"), at("Sheetfile")], [[99.2884, 130, 90], [120.5846, 130, 90]]);
  n.push(_.sheetPinNode("Q", [100, 110], "left")); _.autoplaceSheetFields(n);
  assert.deepStrictEqual(at("Sheetname"), [100, 99.2884, 0], "a side pin makes it horizontal again");
});

test("Autoplace Fields on a selected sheet puts moved fields back", () => {
  const d = docOf(""), n = _.sheetNode([100, 100], [120, 130], "S", "s.kicad_sch");
  kid(kids(n, "property")[0], "at")[1] = 140; const it = K.createItem(d, n);
  const log = [], ctx = { K, doc: d, IU, isSch: true, viewOnly: false, live: true, selected: { id: it.id }, selection: new Set([it.id]), commit(ch, label) { log.push({ ch, label }); for (const c of ch) assert.ok(K.applyChange(d, c, IU)); }, requestRender() {}, toast() {}, setSelected() {}, setSelection() {} };
  sch.select(null);
  assert.ok(_.autoplaceSelection(ctx)); assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(kid(kids(d.items.get(it.id).node, "property")[0], "at").slice(1), [100, 99.2884, 0]);
});

test("field autoplacer: power means a reference starting with '#'; a field box off the drawable area counts as a collision", () => {
  // a 'power' library symbol given an ordinary reference is placed like a part, and the other way round
  const d = docOf(sym("p", "power:GND", "#PWR01", 100, 100) + sym("q", "power:GND", "GND1", 140, 100) + sym("r", "D:R", "#FLG1", 180, 100));
  const side = (id) => { const n = _.autoplaceNode(d, d.items.get(id), { manual: false }); const a = kid(kids(n, "property")[0], "at"); return [Math.sign(Math.round((a[1] - K.atOf(n)[0]) * 100)), Math.sign(Math.round((a[2] - K.atOf(n)[1]) * 100))]; };
  assert.deepStrictEqual(side("p"), side("r"), "both are power by reference");
  assert.notDeepStrictEqual(side("p"), side("q"), "the library power flag alone does not make it one");
  // right at the page's right margin (A4: 297 wide, 10 margin) the preferred right side leaves the drawable area
  const e = docOf(sym("a", "D:R", "R1", 150, 100) + sym("b", "D:R", "R2", 285, 100));
  const dx = (id) => { const n = _.autoplaceNode(e, e.items.get(id), { manual: true }); return kid(kids(n, "property")[0], "at")[1] - K.atOf(n)[0]; };
  assert.ok(dx("a") > 0, "in the open the fields go right"); assert.ok(dx("b") <= 0, "at the margin they do not: " + dx("b"));
});

console.log(`sch-annotation-parity: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
