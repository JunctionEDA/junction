// sch-dialogs-parity.test.js — the schematic dialogs against KiCad's own behaviour: Annotate (project settings,
// CheckAnnotate, ReadyToNetlist's sheet-name test), Find (option rules, brightened matches), ERC (tree rows, counts,
// run messages, the JSON report), the Symbol Fields Table (remove / rename / group-by / sort rules, the field set, the
// changes Apply makes) and Schematic Setup (Formatting, Field Name Templates, Bus Alias Definitions, the reset
// button).  Run: node server/static/tests/sch-dialogs-parity.test.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [webPath("dialogs", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const src = (...p) => fs.readFileSync(webPath(...p), "utf8");
const A = load("annotate-logic.ts"), L = load("logic.ts"), R = load("erc-report.ts"), S = load("schematic-setup-logic.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
console.log("schematic dialogs: KiCad parity");

const sym = (id, ref, value, at, extra, props) => `(symbol (lib_id "Device:R") (at ${at} 0) (unit ${extra && extra.unit || 1}) (uuid "${id}")
    (property "Reference" "${ref}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${value}" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
    ${props || ""}
    (pin "1" (uuid "${id}-p1")))`;
const sheetItem = (id, name, file) => `(sheet (at 100 100) (size 20 10) (uuid "${id}") (property "Sheetname" "${name}" (at 100 99 0) (effects (font (size 1.27 1.27)))) (property "Sheetfile" "${file}" (at 100 111 0) (effects (font (size 1.27 1.27)))))`;
const docOf = (body) => K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4")
  (lib_symbols (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))
  ${body})`);

// ---------------------------------------------------------------- Annotate
test("annotate: order, method and start number come from the project (TransferDataToWindow)", () => {
  assert.deepStrictEqual(A.annotateSettingsFromProject({}), { sortY: false, method: 0, startNum: 0 });
  assert.deepStrictEqual(A.annotateSettingsFromProject({ annotation: { sort_order: 1, method: 2 }, annotate_start_num: 100 }), { sortY: true, method: 2, startNum: 100 });
  assert.deepStrictEqual(A.annotateSettingsFromProject({ annotation: { sort_order: 7, method: 9 }, annotate_start_num: "x" }), { sortY: false, method: 0, startNum: 0 }, "anything else is the default");
});
test("annotate: closing writes only the settings that differ from the project's (~DIALOG_ANNOTATE)", () => {
  const pro = { annotation: { sort_order: 1, method: 0 }, annotate_start_num: 10 };
  assert.strictEqual(A.annotateProjectChanges(pro, { sortY: true, method: 0, startNum: 10 }), null, "nothing modified, nothing saved");
  assert.deepStrictEqual(A.annotateProjectChanges(pro, { sortY: false, method: 1, startNum: 10 }), { sort_order: 0, method: 1 });
  assert.deepStrictEqual(A.annotateProjectChanges({}, { sortY: false, method: 0, startNum: 5 }), { annotate_start_num: 5 });
});
test("annotate: the dialog reads the project, stores on close, keeps Selection enabled and takes a modal message", () => {
  const t = src("dialogs", "annotate.ts");
  assert.ok(/annotateSettingsFromProject\(/.test(t) && /storeProjectSettings\(\)/.test(t));
  assert.ok(!/!hasSel/.test(t), "the Selection radio is never disabled");
  assert.ok(/radio\("scope", "all", "Entire schematic", A\.scope === "all", \(\) => \{ A\.scope = "all"; \}, !!message\)/.test(t), "modal mode disables Entire schematic, ticked");
  assert.ok(/h\("label", \{ for: "kd-inc-ref", title: "The symbol name in library/.test(t), "Increment Annotations: the tooltip is the label's");
});
// CheckAnnotate is the schematic module's (sch.checkAnnotate / sch.checkAnnotation, SCH_REFERENCE_LIST::CheckAnnotation)
const multiLib = `(symbol "X:U2" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "U2_1_1" (pin passive line (at 0 0 0) (length 1.27) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))) (symbol "U2_2_1" (pin passive line (at 0 5 0) (length 1.27) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
  (symbol "X:U4" (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "U4_1_1") (symbol "U4_2_1") (symbol "U4_3_1") (symbol "U4_4_1"))`;
const annDoc = (body) => K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4")
  (lib_symbols (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
    ${multiLib})
  ${body})`);
const usym = (id, ref, value, unit, lib = "Device:R") => sym(id, ref, value, `${10 + id.length * 7} 10`, { unit }).replace('(lib_id "Device:R")', `(lib_id "${lib}")`);
const count = (body) => sch.checkAnnotate([annDoc(body)]);
test("annotate: CheckAnnotation counts unannotated, duplicate, unit-count and value errors", () => {
  assert.strictEqual(count(usym("a", "R1", "10k") + usym("bb", "R2", "10k") + usym("ccc", "C1", "1u")), 0);
  assert.strictEqual(count(usym("a", "R1", "10k") + usym("bb", "R?", "10k")), 1, "an unannotated item");
  assert.strictEqual(count(usym("a", "R?", "10k") + usym("bb", "C?", "10k")), 1, "the scan stops at the first one");
  assert.strictEqual(count(usym("a", "R?", "10k") + usym("bb", "R?", "10k")), 2, "two unannotated items of one prefix are also a duplicate pair");
  assert.strictEqual(count(usym("a", "R1", "10k") + usym("bb", "R1", "10k")), 1, "the same reference and unit twice");
  assert.strictEqual(count(usym("a", "U1", "LM358", 1, "X:U2") + usym("bb", "U1", "LM358", 2, "X:U2")), 0, "two units of one package");
  assert.strictEqual(count(usym("a", "U1", "LM358", 1, "X:U2") + usym("bb", "U1", "LM324", 2, "X:U4")), 1, "differing unit counts");
  assert.strictEqual(count(usym("a", "U1", "LM358", 1, "X:U2") + usym("bb", "U1", "TL072", 2, "X:U2")), 1, "different values on one reference");
  assert.strictEqual(count(usym("a", "U1", "LM358", 3, "X:U2")), 1, "a unit the library symbol does not have");
  assert.strictEqual(count(usym("a", "U1", "10k") + usym("bb", "U01", "10k")), 1, "U1 and U01 are the same package reference");
  assert.strictEqual(count(usym("a", "R1", "10k") + usym("bb", "#PWR01", "GND") + usym("ccc", "R?", "1k")), 1, "power references are left out");
});
test("annotate: the reference suffix tells packages of reused sheets apart (sameBaseAndSuffix, GetRefSuffix)", () => {
  const d1 = annDoc(usym("a", "R1", "10k")), d2 = annDoc(usym("bb", "R1", "10k"));
  assert.strictEqual(sch.checkAnnotate([{ doc: d1, path: "/root/s1", page: 1 }, { doc: d2, path: "/root/s2", page: 2 }]), 1, "R1 twice");
  assert.strictEqual(sch.checkAnnotate([{ doc: d1, path: "/root/s1", page: 1, suffix: "_A" }, { doc: d2, path: "/root/s2", page: 2, suffix: "_B" }]), 0, "R1_A and R1_B");
  const msgs = []; const refs = [...sch.sheetReferences({ doc: d1, path: "/root/s1", page: 1 }, null, true), ...sch.sheetReferences({ doc: d2, path: "/root/s2", page: 2 }, null, true)];
  refs.forEach((r) => { r.suffix = "_A"; });
  sch.checkAnnotation(refs, (code, msg) => msgs.push(msg));
  assert.deepStrictEqual(msgs, ["Duplicate items R1_A\n"]);
});
test("readyToNetlist: duplicate sheet names are counted per screen without case (TestDuplicateSheetNames)", () => {
  const NK = load("../sim/netlist-kicad.ts");
  const d = docOf(`${sheetItem("sh1", "Power", "a.kicad_sch")} ${sheetItem("sh2", "power", "b.kicad_sch")} ${sheetItem("sh3", "IO", "c.kicad_sch")}`);
  assert.strictEqual(NK.duplicateSheetNames([{ doc: d }]), 1);
});

// ---------------------------------------------------------------- Export Netlist
test("export netlist: SPICE Model is .sub, the SPICE options start unticked, ReadyToNetlist runs first, success closes", () => {
  const t = src("editor", "export-netlist.ts");
  assert.ok(/"SPICE Model": "sub"/.test(t));
  assert.ok(!/saved\.saveAll\w+ !== false/.test(t), "no SPICE option defaults to ticked");
  assert.ok(/readyToNetlist\("Exporting netlist requires a fully annotated schematic\."\)/.test(t));
  assert.ok(/Error: duplicate sheet names\. Continue\?/.test(t));
  assert.ok(/openAnnotate\(\{ message: annotateMessage \}\)/.test(t));
  assert.strictEqual((t.match(/await readyToNetlist\(/g) || []).length, 1, "ReadyToNetlist runs once per export");
  assert.ok(/S\.checkAnnotate\(/.test(t), "the schematic module's CheckAnnotate");
  assert.ok((t.match(/if \(dlg\) dlg\.close\(\);/g) || []).length === 2, "both success paths end the dialog");
});

// ---------------------------------------------------------------- Find
test("find: Regular Expression excludes Match case and Whole words only (OnOptions)", () => {
  const o = { query: "x", matchCase: true, wholeWord: true, regex: false };
  const a = L.findOptionChanged(o, "regex", true);
  assert.deepStrictEqual([a.regex, a.matchCase, a.wholeWord], [true, false, false]);
  const b = L.findOptionChanged(a, "matchCase", true);
  assert.deepStrictEqual([b.regex, b.matchCase], [false, true]);
  const c = L.findOptionChanged(Object.assign({}, a), "wholeWord", false);
  assert.strictEqual(c.regex, false, "the event alone clears it, whatever the new value");
  const d = L.findOptionChanged(a, "pins", true);
  assert.deepStrictEqual([d.regex, d.pins], [true, true], "the other options leave it alone");
  assert.strictEqual(o.regex, false, "the input is not changed");
});
test("find: every matching item of the sheet is brightened once (UpdateFind)", () => {
  const d = docOf(`${sym("s1", "R1", "10k", "10 10")} ${sym("s2", "R2", "10k", "20 10")} (label "R1_OUT" (at 50 50 0) (effects (font (size 1.27 1.27))) (uuid "l1"))`);
  assert.deepStrictEqual(L.findHighlightIds(L.findHits(d, { query: "R1" })).sort(), ["l1", "s1"]);
  assert.deepStrictEqual(L.findHighlightIds(L.findHits(d, { query: "10k" })).sort(), ["s1", "s2"]);
  assert.deepStrictEqual(L.findHighlightIds([{ id: "a" }, { id: "a" }, { id: "b" }]), ["a", "b"]);
  const t = src("dialogs", "find.ts");
  assert.ok(/rb\.disabled = ro \|\| !q\.value \|\| !findHasMatch\(\)/.test(t) && /ra\.disabled = ro \|\| !q\.value/.test(t), "Replace needs a current match, Replace All a search text");
  assert.ok(/rw\.addEventListener\("keydown"/.test(t), "Enter in Replace with finds");
  assert.ok(/"Find and Replace"\)/.test(t) && /"Find and Replace All"/.test(t) && /No matches found\./.test(t) && /Reached end of schematic\./.test(t));
});

// ---------------------------------------------------------------- ERC
test("erc: the run's message lines (AdvancePhase) and its summary", () => {
  const all = R.ercPhaseMessages(() => true);
  assert.strictEqual(all[0], "Checking sheet names...");
  assert.deepStrictEqual(all.slice(2, 4), ["Checking conflicts...", "Checking units..."]);
  assert.strictEqual(all[all.length - 1], "Checking variant symbols...");
  const none = R.ercPhaseMessages(() => false);
  assert.deepStrictEqual(none, ["Checking conflicts...", "Checking units...", "Checking pins..."], "the unguarded phases always report");
  assert.ok(!R.ercPhaseMessages((c) => c !== "endpoint_off_grid").includes("Checking for off grid pins and wires..."));
  const t = src("dialogs", "erc.ts");
  assert.ok(/for \(const line of ercPhaseMessages\(\(code\) => severityOf\(code, sv\) !== "ignore"\)\) report\(line\);/.test(t), "the dialog reports them while the tests run");
  assert.ok(/symbol\(s\) require annotation\./.test(t) && /-------- ERC cancelled by user\./.test(t) && /"Done\."/.test(t));
});
test("erc: the JSON report follows erc.v1.json as nlohmann writes it", () => {
  const markers = [
    { code: "pin_not_connected", severity: "error", x: 10, y: 20, text: "Pin not connected", ids: ["u1"], items: [{ x: 25.4, y: 50.8, desc: "Symbol R1 Pin 1", uuid: "u1" }] },
    { code: "label_dangling", severity: "exclusion", base: "warning", comment: "known", x: 1, y: 2, text: "Label not connected", ids: ["u2"], items: [{ x: 1, y: 2.5, desc: "Label 'A'", uuid: "u2" }] },
    { code: "wire_dangling", severity: "warning", x: 0, y: 0, text: "w", ids: [], items: [] }];
  const text = R.ercJsonReport(markers, { errors: true, warnings: false, exclusions: true, units: "mm", date: "2026-01-02T03:04:05", source: "top.kicad_sch", kicadVersion: "10.99.0",
    sheets: [{ path: "/", uuidPath: "/root" }, { path: "/sub/", uuidPath: "/root/sh1" }], sheetOf: (m) => (m.code === "label_dangling" ? 1 : 0),
    title: (m) => m.text, ignored: [["Four-way junction", "four_way_junction"]] });
  const j = JSON.parse(text);
  assert.strictEqual(j.$schema, "https://schemas.kicad.org/erc.v1.json"); assert.strictEqual(j.source, "top.kicad_sch"); assert.strictEqual(j.coordinate_units, "mm"); assert.strictEqual(j.kicad_version, "10.99.0");
  assert.deepStrictEqual(j.included_severities, ["error", "exclusion"]);
  assert.deepStrictEqual(j.ignored_checks, [{ description: "Four-way junction", key: "four_way_junction" }]);
  assert.strictEqual(j.sheets.length, 2); assert.strictEqual(j.sheets[1].uuid_path, "/root/sh1");
  assert.deepStrictEqual(j.sheets[0].violations, [{ type: "pin_not_connected", description: "Pin not connected", severity: "error", items: [{ uuid: "u1", description: "Symbol R1 Pin 1", pos: { x: 25.4, y: 50.8 } }] }], "the warning is not among the reported severities");
  assert.deepStrictEqual(j.sheets[1].violations[0], { type: "label_dangling", description: "Label not connected", severity: "warning", excluded: true, comment: "known", items: [{ uuid: "u2", description: "Label 'A'", pos: { x: 1, y: 2.5 } }] });
  assert.ok(/^\{\n {4}"\$schema": /.test(text), "four-space indent, keys sorted");
  assert.ok(/"x": 1\.0,/.test(text), "a whole double keeps its .0");
  assert.ok(text.indexOf('"coordinate_units"') < text.indexOf('"date"') && text.indexOf('"date"') < text.indexOf('"ignored_checks"'), "object keys in sorted order");
  const mil = JSON.parse(R.ercJsonReport(markers, { errors: true, warnings: true, exclusions: true, units: "mil", date: "d", source: "s", kicadVersion: "v", sheets: [], title: (m) => m.text, ignored: [] }));
  assert.strictEqual(JSON.parse(R.ercJsonReport(markers, { errors: true, warnings: true, exclusions: true, units: "in", date: "d", source: "s", kicadVersion: "v", sheets: [], title: (m) => m.text, ignored: [] })).sheets[0].violations[0].items[0].pos.x, 1, "ToUserUnit: IU over IU_PER_INCH");
  assert.strictEqual(mil.coordinate_units, "mils"); assert.strictEqual(mil.sheets[0].violations[0].items[0].pos.x, 1000);
});
test("erc: the dialog's own wiring", () => {
  const t = src("dialogs", "erc.ts");
  assert.ok(/Schematic is not fully annotated\. ERC results will be incomplete\./.test(t) && /Show Annotation dialog/.test(t));
  assert.ok(!/No violations\. Run ERC to check the schematic\./.test(t) && !/No violations of the shown severities\./.test(t), "KiCad shows no empty-list text");
  assert.ok(!/toast\(\(all\.length \? `ERC:/.test(t), "the result is not a toast");
  assert.ok(/if \(nb && nb\.index\(\) !== 0\) \{ refresh\(\); return; \}/.test(t), "Delete Marker acts on the Violations page only");
  assert.ok(/close\.textContent = "Cancel"/.test(t) && /if \(running\) \{ cancelled = true; (?:if \(abort\) abort\.abort\(\); )?return false; \}/.test(t));
  assert.ok(/It will be excluded from the \$\{listName\} list/.test(t) && /Violation severities can also be edited in Schematic Setup/.test(t) && /Open the Schematic Setup dialog/.test(t));
  assert.ok(/\{ label: "Error", check: true, checked: cur === "error"/.test(t) && /\{ label: "Ignore", check: true, checked: cur === "ignore"/.test(t), "the ignored tests' severity menu");
  assert.ok(/Failed to create file '\$\{name\}'\./.test(t), "a report that cannot be written is an error box");
  assert.ok(/"Report files \(\*\.rpt\)"/.test(t) && /"Json files \(\*\.json\)"/.test(t) && /Report file '\$\{name\}' created\./.test(t));
  assert.ok(/el\.addEventListener\("dblclick", \(\) => hide\(\)\)/.test(t), "a double click hides the dialog");
});

// ---------------------------------------------------------------- Symbol Fields Table
test("fields table: remove / rename refusals and checks (OnRemoveField, OnRenameField)", () => {
  assert.strictEqual(L.removeFieldError("Value"), "The first 5 fields are mandatory.");
  assert.strictEqual(L.removeFieldError("${QUANTITY}"), "The 'Quantity' field cannot be removed.");
  assert.strictEqual(L.removeFieldError("MPN"), null);
  assert.strictEqual(L.renameFieldError("Datasheet"), "The first 5 fields are mandatory and names cannot be changed.");
  assert.strictEqual(L.renameFieldError("${ITEM_NUMBER}"), "The 'Item Number' field cannot be renamed.");
  assert.strictEqual(L.renameFieldError("MPN"), null);
  assert.strictEqual(L.renameFieldCheck(["Reference", "MPN", "LCSC"], "MPN", "MPN"), "", "the same name does nothing");
  assert.strictEqual(L.renameFieldCheck(["Reference", "MPN", "LCSC"], "MPN", ""), "Field must have a name.");
  assert.strictEqual(L.renameFieldCheck(["Reference", "MPN", "LCSC"], "MPN", "LCSC"), "Field name LCSC already exists.");
  assert.strictEqual(L.renameFieldCheck(["Reference", "MPN", "LCSC"], "MPN", "Part"), null);
  const v = { MPN: "RC0603", Value: "10k" };
  assert.strictEqual(L.renameRowField(v, "MPN", "Part"), true); assert.deepStrictEqual(v, { Value: "10k", Part: "RC0603" });
  assert.strictEqual(L.renameRowField(v, "Nope", "X"), false);
});
test("fields table: Quantity and Item Number cannot be grouped by; Item Number cannot be sorted on", () => {
  assert.strictEqual(L.groupByError("${QUANTITY}"), "The Quantity column cannot be grouped by.");
  assert.strictEqual(L.groupByError("${ITEM_NUMBER}"), "The Item Number column cannot be grouped by.");
  assert.strictEqual(L.groupByError("Value"), null);
  assert.strictEqual(L.canSortBy("${ITEM_NUMBER}"), false); assert.strictEqual(L.canSortBy("${QUANTITY}"), true); assert.strictEqual(L.canSortBy("Reference"), true);
});
test("fields table: user fields sorted, private fields skipped, power symbols by their library flag", () => {
  const d = docOf(`${sym("s1", "R1", "10k", "10 10", null, '(property "Zeta" "z" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Alpha" "a" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property private "Secret" "s" (at 0 0 0) (effects (font (size 1.27 1.27))))')}
    ${sym("s2", "#FLG01", "PWR_FLAG", "20 10")} ${sym("s3", "PWR1", "GND", "30 10", null, '(property "Mid" "m" (at 0 0 0) (effects (font (size 1.27 1.27))))')}`);
  const rows = L.symbolRows(d);
  assert.deepStrictEqual(rows.map((r) => r.ref), ["R1", "PWR1"], "without a library test the # references are left out");
  assert.ok(!("Secret" in rows[0].values) && !("private" in rows[0].values), "a private field is not a column");
  assert.deepStrictEqual(L.fieldNames(rows), ["Reference", "Value", "Footprint", "Datasheet", "Description", "Alpha", "Mid", "Zeta"]);
  const byLib = L.symbolRows(d, "", true, (it) => it.id === "s3");
  assert.deepStrictEqual(byLib.map((r) => r.ref), ["R1", "#FLG01"], "IsPower() decides, not the reference");
});
test("fields table: Apply removes, creates and renames fields on the symbol (ApplyData)", () => {
  const d = docOf(sym("s1", "R1", "10k", "10 10", null, '(property "MPN" "RC0603" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property private "Secret" "s" (at 0 0 0) (effects (font (size 1.27 1.27))))'));
  const names = (ch) => { const n = K.parseAll(ch.sexpr).find((x) => x[0] === "symbol"); return n.filter((p) => Array.isArray(p) && p[0] === "property").map((p) => p[1] === "private" ? "private:" + p[2] : p[1] + "=" + p[2]); };
  // a rename: the old field goes, the new one carries the value
  let ch = sch.fieldsTableChanges(d, [{ id: "s1", values: { Part: "RC0603" }, remove: ["MPN"], present: ["Part"] }]);
  assert.strictEqual(ch.length, 1);
  assert.ok(!names(ch[0]).some((x) => x.startsWith("MPN=")) && names(ch[0]).includes("Part=RC0603"), names(ch[0]).join());
  assert.ok(names(ch[0]).includes("private:Secret"), "private fields are left alone");
  // a renamed empty field still exists under its new name
  ch = sch.fieldsTableChanges(d, [{ id: "s1", values: { Part: "" }, remove: ["MPN"], present: ["Part"] }]);
  assert.ok(names(ch[0]).includes("Part="), names(ch[0]).join());
  // Remove Field / Clear Cell: the field leaves the symbol; a mandatory field never does
  ch = sch.fieldsTableChanges(d, [{ id: "s1", remove: ["MPN", "Value"] }]);
  assert.ok(!names(ch[0]).some((x) => x.startsWith("MPN=")) && names(ch[0]).includes("Value=10k"));
  assert.strictEqual(sch.fieldsTableChanges(d, [{ id: "s1", remove: ["Nope"] }]).length, 0, "nothing to remove, nothing changed");
  assert.strictEqual(sch.fieldsTableChanges(d, [{ id: "s1", values: { Other: "" } }]).length, 0, "an empty value alone creates no field");
});
test("fields table: the dialog's own wiring", () => {
  const t = src("dialogs", "fields-table.ts");
  assert.ok(/"Symbol Fields Table Edit"/.test(t) && !/commit\(ch, "symbol fields"\)/.test(t));
  assert.ok(!/toast\(`Updated \$\{n\}/.test(t) && !/toast\("Exported "/.test(t));
  assert.ok(/Are you sure you want to remove the field '/.test(t));
  assert.ok(/"Unsaved data", "Changes have not yet been saved\. Export unsaved data\?"/.test(t) && /No output file specified in Export tab\./.test(t) && /Wrote BOM output to '/.test(t));
  assert.ok(/Overwrite existing preset\?/.test(t) && /listDialog\("Delete Preset", \["Presets"\]/.test(t) && /listLabel: "Select preset:"/.test(t));
  assert.ok(/"Revert Row"/.test(t) && /"Clear Cell"/.test(t) && /"Select Footprint\.\.\."/.test(t) && /"Copy from Variant"/.test(t));
  assert.ok(/"Expand left panel"/.test(t) && /"Collapse left panel"/.test(t));
  assert.ok(/scope === "Selection" \|\| onExportTab\) return;/.test(t), "no cross-probe in the Selection scope or on the Export tab");
});

// ---------------------------------------------------------------- Schematic Setup
test("schematic setup: connection grid range, precision spin range (PANEL_SETUP_FORMATTING)", () => {
  assert.strictEqual(S.connectionGridError(50), null); assert.strictEqual(S.connectionGridError(25), null); assert.strictEqual(S.connectionGridError(10000), null);
  assert.strictEqual(S.connectionGridError(24.9), "Connection grid must be at least 25 mils.");
  assert.strictEqual(S.connectionGridError(NaN), "Connection grid must be at least 25 mils.");
  assert.strictEqual(S.connectionGridError(10001), "Connection grid must be less than 10000 mils.");
  assert.deepStrictEqual([0, 1, 3.4, 10, 99].map(S.clampPrecision), [1, 1, 3, 10, 10]);
  const t = src("dialogs", "schematic-setup.ts");
  assert.ok(/const units: string = "mils";/.test(t), "the Formatting sizes are in mils whatever the editor units");
  assert.ok(/isrEnable\(!!dv\("intersheets_ref_show"\)\)/.test(t), "the inter-sheet reference controls follow the checkbox");
});
test("schematic setup: field name templates (PANEL_TEMPLATE_FIELDNAMES)", () => {
  assert.strictEqual(S.untitledFieldName([]), "Untitled Field");
  assert.strictEqual(S.untitledFieldName(["Untitled Field"]), "Untitled Field 2");
  assert.strictEqual(S.untitledFieldName(["Untitled Field", "Untitled Field 2", "X"]), "Untitled Field 3");
  assert.deepStrictEqual(S.templateNamesWithWhitespace(["MPN", " LCSC", "Part ", "", "a b"]), [1, 2]);
  assert.strictEqual(S.templateFieldNameError(["MPN", "", "LCSC"]), null);
  assert.deepStrictEqual(S.templateFieldNameError(["MPN", "value"]), { row: 1, message: "Field name template 'value' already exists as a mandatory field." });
  assert.deepStrictEqual(S.templateFieldNameError(["MPN", "LCSC", "MPN"]), { row: 2, message: "Field name template 'MPN' already exists." });
  assert.strictEqual(S.templateFieldNameError(["MPN", "mpn"]), null, "only mandatory names are compared without case");
  const t = src("dialogs", "schematic-setup.ts");
  assert.ok(/"Keep White Space"/.test(t) && /"Remove White Space"/.test(t) && /contains trailing and\/or leading white space\./.test(t));
});
test("schematic setup: bus aliases sorted without case, duplicate and empty names refused (PANEL_SETUP_BUSES)", () => {
  assert.deepStrictEqual(S.sortAliases([{ name: "usb" }, { name: "ADDR" }, { name: "Data" }]).map((a) => a.name), ["ADDR", "Data", "usb"]);
  assert.strictEqual(S.aliasNameError(["A", "B", "C"], 2, "A"), "Alias name 'A' already in use.");
  assert.strictEqual(S.aliasNameError(["A", "B", "A"], 2, "A"), "Alias name 'A' already in use.");
  assert.strictEqual(S.aliasNameError(["A", "B", "C"], 1, "B"), null, "its own name");
  assert.strictEqual(S.memberNameError(""), "Member net/alias name cannot be empty."); assert.strictEqual(S.memberNameError("D0"), null);
});
test("schematic setup: the dialog's reset button (PAGED_DIALOG::UpdateResetButton)", () => {
  assert.deepStrictEqual(S.resetButtonState("Annotation"), { label: "Reset Annotation to Defaults", enabled: true });
  assert.deepStrictEqual(S.resetButtonState("Pin Conflicts Map"), { label: "Reset Pin Conflicts Map to Defaults", enabled: true });
  assert.deepStrictEqual(S.resetButtonState("Formatting"), { label: "Reset to Defaults", enabled: false });
  assert.deepStrictEqual(S.resetButtonState(null), { label: "Reset to Defaults", enabled: false });
  const t = src("dialogs", "schematic-setup.ts");
  assert.ok(/extra: \[\{ label: "Reset to Defaults", fn: resetPage, id: "kd-ss-reset" \}, \{ label: "Import Settings from Another Project\.\.\."/.test(t), "bottom left, before Import Settings");
  assert.ok(!/m_ResetMatrixButton/.test(t), "the pin map page has no button of its own");
});

// ---------------------------------------------------------------- titles and defaults
test("titles and defaults as KiCad has them", () => {
  assert.ok(/title: "Edit Text and Graphic Properties"/.test(src("dialogs", "global-edit.ts")));
  const plot = src("dialogs", "plot-schematic.ts");
  assert.ok(/title: "Plot Schematic", width/.test(plot) && /dxfInch: true/.test(plot) && /selectField<string>\(variants\[0\], variants/.test(plot) && /lenField\(pref\.minWidth/.test(plot));
  const prefs = src("dialogs", "prefs.ts");
  assert.ok(/remappedPinNumbers: true/.test(prefs) && /highlightNetclass: false/.test(prefs) && /pinSelectsSymbol: false/.test(prefs));
  assert.ok(/\["", "KiCad Font"\], \.\.\.boardFontFaces\(/.test(src("dialogs", "preferences.ts")), "the default font choice lists the faces the app knows");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
