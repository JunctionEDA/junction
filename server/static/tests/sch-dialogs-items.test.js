// sch-dialogs-items.test.js — KiCad parity of the schematic item property dialogs (eeschema/dialogs): the pure halves in
// web/domains/pcb/dialogs/{sch-items-logic,sym-props-logic,change-symbols-logic,variant-edits}.ts.
// Run: node server/static/tests/sch-dialogs-items.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs/sch-items-logic.ts"), P = load("dialogs/sym-props-logic.ts"), C = load("dialogs/change-symbols-logic.ts"), V = load("dialogs/variant-edits.ts"), M = load("symedit/model.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n       ")); } }
const S = (n) => K.serialize(n);
const sym = (rot, mirror, field) => K.parse(`(symbol (lib_id "Device:R") (at 100 50 ${rot}) ${mirror ? `(mirror ${mirror})` : ""} (unit 1) (uuid "s")
  ${field} (instances (project "p" (path "/root" (reference "R1") (unit 1)))))`);
console.log("schematic item dialogs: KiCad parity");

test("field alignment is the displayed one (GetEffectiveHorizJustify): a symbol turned 180 shows Left as Right and writes it back flipped", () => {
  const f = `(property "Reference" "R1" (at 102 48 0) (effects (font (size 1.27 1.27)) (justify left top)))`;
  const n0 = sym(0, "", f), n180 = sym(180, "", f);
  assert.deepStrictEqual([L.fieldRows(n0, [100, 50])[0].h, L.fieldRows(n0, [100, 50])[0].v], ["left", "top"]);
  const rows = L.fieldRows(n180, [100, 50]);
  assert.deepStrictEqual([rows[0].h, rows[0].v], ["right", "bottom"], "180 degrees flips both axes");
  assert.strictEqual(L.rowMoved(rows[0], [100, 50]), false, "unchanged row: effective values compare equal");
  L.writeFields(n180, rows, [100, 50]);
  assert.ok(S(n180).includes("(justify left top)"), "an untouched row writes the stored justification back");
  rows[0].h = "left"; L.writeFields(n180, rows, [100, 50]);
  assert.ok(S(n180).includes("(justify right top)"), "Left on screen is stored as right on a flipped symbol");
  // mirror around the Y axis flips the horizontal side only
  const my = L.fieldRows(sym(0, "y", f), [100, 50])[0]; assert.deepStrictEqual([my.h, my.v], ["right", "top"]);
  const mx = L.fieldRows(sym(0, "x", f), [100, 50])[0]; assert.deepStrictEqual([mx.h, mx.v], ["left", "bottom"]);
  // the same rule the autoplacer uses for a symbol at 90 / 270 whose fields are stored vertical
  for (const rot of [0, 90, 180, 270]) for (const mir of ["", "x", "y"]) {
    const T = K.symbolTransform(rot, mir), vertical = T[1] !== 0, want = (T[1] !== 0 ? T[1] : T[0]) < 0;
    assert.strictEqual(L.justifyFlips(sym(rot, mir, ""), vertical).h, want, `rot ${rot} mirror '${mir}'`);
  }
  // sheets and labels have no transform
  const lab = K.parse(`(global_label "A" (at 0 0 180) (uuid "g") (property "Intersheetrefs" "x" (at 0 0 0) (effects (font (size 1.27 1.27)) (justify right))))`);
  assert.strictEqual(L.fieldRows(lab, [0, 0])[0].h, "right");
});
test("Add field: symbol / sheet rows are 'Field<row count>', hidden, with the Reference / Sheetname angle; a label's follow the last row", () => {
  const rows = ["Reference", "Value", "Footprint", "Datasheet", "Description"].map((n) => L.newRow(n, [0, 0])); rows[0].orient = 90;
  const r = L.newParentFieldRow(rows, ["Reference"]);
  assert.deepStrictEqual([r.name, r.show, r.orient], ["Field5", false, 90]);
  const sh = [L.newRow("Sheetname", [0, 0]), L.newRow("Sheetfile", [0, 0])];
  assert.deepStrictEqual([L.newParentFieldRow(sh, ["Sheetname"]).name, L.newParentFieldRow(sh, ["Sheetname"]).show], ["Field2", false]);
  const first = L.newLabelFieldRow([]);
  assert.deepStrictEqual([first.name, first.show, first.italic], ["Netclass", true, true], "the first field of a label: Net Class, shown, italic");
  const isr = Object.assign(L.newRow("Intersheetrefs", [0, 0]), { mandatory: true, show: false, size: 2, bold: true, h: "right" });
  const second = L.newLabelFieldRow([isr]);
  assert.deepStrictEqual([second.name, second.show, second.size, second.bold, second.h], ["Netclass", false, 2, true, "right"], "copies the last row's attributes and visibility");
  assert.strictEqual(L.newLabelFieldRow([isr, L.newRow("MPN", [0, 0])]).name, "Field", "any other field: 'Field'");
  assert.strictEqual(L.labelFieldDisplayName("Netclass"), "Net Class"); assert.strictEqual(L.labelFieldDisplayName("Intersheetrefs"), "Sheet References");
  assert.strictEqual(L.labelFieldStoredName("Net Class"), "Netclass"); assert.strictEqual(L.labelFieldDisplayName("MPN"), "MPN");
});
test("duplicate field names: case variants of a mandatory name clash, per parent (FieldNamesAreDuplicates)", () => {
  const rows = [{ name: "Reference" }, { name: "MPN" }, { name: "x" }];
  assert.strictEqual(L.fieldNameClash(rows, 2, "reference", L.mandatoryNamesOf("symbol")), "Field name 'reference' already in use.");
  assert.strictEqual(L.fieldNameClash(rows, 2, "mpn", L.mandatoryNamesOf("symbol")), null, "user fields compare with case");
  assert.strictEqual(L.fieldNameClash(rows, 2, "MPN", L.mandatoryNamesOf("symbol")), "Field name 'MPN' already in use.");
  assert.strictEqual(L.fieldNameClash([{ name: "Sheetname" }, { name: "" }], 1, "sheetname", L.mandatoryNamesOf("sheet")), "Field name 'sheetname' already in use.");
  assert.strictEqual(L.fieldNameClash([{ name: "Sheetname" }, { name: "" }], 1, "reference", L.mandatoryNamesOf("sheet")), null);
  assert.strictEqual(L.fieldNameClash([{ name: "Intersheetrefs" }, { name: "" }], 1, "intersheetrefs", L.mandatoryNamesOf("global_label")), "Field name 'intersheetrefs' already in use.");
  assert.strictEqual(L.fieldNameClash([{ name: "Intersheetrefs" }, { name: "" }], 1, "intersheetrefs", L.mandatoryNamesOf("label")), null, "only a global label has a mandatory field");
  const r = (name) => L.newRow(name, [0, 0]);
  assert.strictEqual(L.duplicateFieldName([r("Value"), r("value")], L.mandatoryNamesOf("symbol")), "Field name 'value' already in use.");
  assert.strictEqual(L.fieldNamesAreDuplicates("VALUE", "value"), true, "the default list is the symbol's");
});
test("empty rows: a sheet / symbol saves every row but the ones with neither name nor text; generated fields", () => {
  const a = L.newRow("", [0, 0]), b = Object.assign(L.newRow("", [0, 0]), { value: "v" }), c = L.newRow("MPN", [0, 0]), m = Object.assign(L.newRow("Sheetname", [0, 0]), { mandatory: true });
  assert.deepStrictEqual(L.withoutBlankRows([a, b, c, m]).map((x) => x.name + "=" + x.value), ["=v", "MPN=", "Sheetname="]);
  assert.strictEqual(L.isGeneratedField("${DNP}"), true); assert.strictEqual(L.isGeneratedField("${ROW.x}"), true); assert.strictEqual(L.isGeneratedField("@{1+1}"), true);
  assert.strictEqual(L.isGeneratedField("MPN"), false); assert.strictEqual(L.isGeneratedField("a ${B}"), false);
});
test("UNIT_BINDER::Validate's wording for the text size / pin length range", () => {
  const fmt = (mm) => mm + " mm";
  assert.strictEqual(L.rangeError("Text size:", 0.001, 0.01, 1000, fmt), "Text size must be at least 0.01 mm.");
  assert.strictEqual(L.rangeError("Pin length:", undefined, 0.01, 1000, fmt), "Pin length must be at least 0.01 mm.");
  assert.strictEqual(L.rangeError("Text size:", 2000, 0.01, 1000, fmt), "Text size must be less than 1000 mm.");
  assert.strictEqual(L.rangeError("Text size:", 1.27, 0.01, 1000, fmt), null);
});
test("SCH_NETNAME_VALIDATOR on a sheet pin name", () => {
  assert.strictEqual(L.netNameError("CLK"), ""); assert.strictEqual(L.netNameError("D[0..7]"), ""); assert.strictEqual(L.netNameError("BUS{A B}"), "");
  assert.strictEqual(L.netNameError("~{RESET}"), "", "an overbar is not a bus group"); assert.strictEqual(L.netNameError("${VAR}"), "");
  assert.strictEqual(L.netNameError("a\nb"), "Signal names cannot contain CR or LF characters");
  assert.strictEqual(L.netNameError("A{B"), "", "an opening brace alone is fine");
  assert.strictEqual(L.netNameError("A {B}"), "Signal name contains '{' and '}' but is not a valid bus name");
  assert.strictEqual(L.netNameError("A{B{C}"), "Signal name contains '{' and '}' but is not a valid bus name");
  assert.strictEqual(L.netNameError("D[0..]"), "Signal name contains '[' or ']' but is not a valid bus name.");
  assert.strictEqual(L.netNameError("D]"), "Signal name contains '[' or ']' but is not a valid bus name.");
  assert.strictEqual(L.netNameError("["), "", "a single character is not checked");
});
test("KIUI::SelectReferenceNumber and GetUnitDisplayName", () => {
  assert.deepStrictEqual(L.referenceNumberRange("R12"), [1, 3]); assert.deepStrictEqual(L.referenceNumberRange("R?"), [1, 2]);
  assert.deepStrictEqual(L.referenceNumberRange("U??"), [1, 3]); assert.deepStrictEqual(L.referenceNumberRange("IC7A"), [2, 3]);
  assert.strictEqual(L.referenceNumberRange("REF"), null); assert.deepStrictEqual(L.referenceNumberRange("R*"), [1, 2]);
  const lib = K.parse(`(symbol "X" (symbol "X_1_1" (unit_name "Amp")) (symbol "X_2_1"))`), letter = (u) => "ABC"[u - 1];
  assert.strictEqual(L.unitDisplayName(lib, 1, letter), "Amp"); assert.strictEqual(L.unitDisplayName(lib, 2, letter), "B"); assert.strictEqual(L.unitDisplayName(null, 3, letter), "C");
});
test("text variable cross-references: ConvertKIIDsToRefs / ConvertRefsToKIIDs", () => {
  const syms = [{ path: "/root/u1", uuid: "u1", ref: "R1" }, { path: "/root/sh/u2", uuid: "u2", ref: "U3A" }, { path: "/root/u3", uuid: "u3", ref: "#PWR01", power: true }];
  assert.strictEqual(L.schRefsToKiids("v=${R1:Value} ${U3A:MPN}", syms), "v=${/root/u1:Value} ${/root/sh/u2:MPN}");
  assert.strictEqual(L.schKiidsToRefs("v=${/root/u1:Value} ${u2:MPN}", syms), "v=${R1:Value} ${U3A:MPN}");
  assert.strictEqual(L.schRefsToKiids("${R9:Value} ${TITLE} \\${R1:Value}", syms), "${R9:Value} ${TITLE} \\${R1:Value}", "unknown references, plain variables and escaped expressions stay");
  assert.strictEqual(L.schRefsToKiids("${#PWR01:Value}", syms), "${#PWR01:Value}", "power symbols are not cross-referenced");
  assert.strictEqual(L.schKiidsToRefs("${zz:Value}", syms), "${zz:Value}");
  assert.strictEqual(L.schKiidsToRefs(L.schRefsToKiids("a ${R1:X_{1}} b", syms), syms), "a ${R1:X_{1}} b");
});
test("a text box grows to fit its text (DIALOG_TEXT_PROPERTIES)", () => {
  const n = K.parse(`(text_box "a" (at 10 10 0) (size 20 2) (uuid "t"))`);
  assert.strictEqual(L.growTextBox(n, [0, 5]), true); assert.strictEqual(S(K.kid(n, "size")), "(size 20 5)");
  assert.strictEqual(L.growTextBox(n, [0, 3]), false, "large enough already");
  const neg = K.parse(`(text_box "a" (at 10 10 0) (size -4 -2) (uuid "t"))`);
  L.growTextBox(neg, [6, 0]); assert.strictEqual(S(K.kid(neg, "size")), "(size -6 -2)", "the end corner moves away from the start");
});
test("Sheet Properties: the page of the sheet instance on the open sheet path, written as typed and created when missing", () => {
  const sh = K.parse(`(sheet (at 0 0) (size 10 10) (uuid "s") (property "Sheetname" "A" (at 0 0 0)) (property "Sheetfile" "a.kicad_sch" (at 0 0 0))
    (instances (project "p" (path "/r/x" (page "2")) (path "/r/y" (page "5")))))`);
  assert.strictEqual(L.sheetPageNumber(sh, "/r/y", "p"), "5"); assert.strictEqual(L.sheetPageNumber(sh, "/r/x", "p"), "2");
  assert.strictEqual(L.sheetPageNumber(sh, "/r/z", "p"), "", "no entry for this path: empty, not another instance's page");
  L.setSheetPageNumber(sh, "/r/y", "p", "7"); assert.strictEqual(L.sheetPageNumber(sh, "/r/y", "p"), "7"); assert.strictEqual(L.sheetPageNumber(sh, "/r/x", "p"), "2", "the other instance is untouched");
  L.setSheetPageNumber(sh, "/r/y", "p", ""); assert.ok(S(sh).includes('(path "/r/y" (page ""))'), "an empty page is written as typed");
  L.setSheetPageNumber(sh, "/r/z", "p", "9"); assert.ok(S(sh).includes('(path "/r/z" (page "9"))'), "the entry is made when missing");
  const bare = K.parse(`(sheet (at 0 0) (uuid "s"))`); L.setSheetPageNumber(bare, "/r", "p", "3");
  assert.strictEqual(S(K.kid(bare, "instances")), '(instances (project "p" (path "/r" (page "3"))))');
});
test("Sheet Properties: the Reference Suffix row is always there, hidden, right after the mandatory rows", () => {
  const name = Object.assign(L.newRow("Sheetname", [0, 0], 2), { mandatory: true, orient: 90 }), file = Object.assign(L.newRow("Sheetfile", [0, 0]), { mandatory: true }), u = L.newRow("MPN", [0, 0]);
  const rows = L.sheetFieldsForEditing([name, u, file], "Reference Suffix");
  assert.deepStrictEqual(rows.map((r) => r.name), ["Sheetname", "Sheetfile", "Reference Suffix", "MPN"]);
  assert.deepStrictEqual([rows[2].show, rows[2].size, rows[2].orient, rows[2].src], [false, 2, 90, null]);
  const again = L.sheetFieldsForEditing(rows, "Reference Suffix"); assert.strictEqual(again.filter((r) => r.name === "Reference Suffix").length, 1);
});
test("renaming a sheet retargets netclass patterns and net colours (NET_SETTINGS::RenameNetPathPrefix)", () => {
  const pro = { net_settings: { netclass_patterns: [{ netclass: "HV", pattern: "/Power/VIN" }, { netclass: "X", pattern: "/Other/A" }], net_colors: { "/Power/VIN": "rgb(1, 2, 3)", "/GND": "rgb(0, 0, 0)" } } };
  assert.strictEqual(L.renameNetPathPrefix(pro, "/Power/", "/Supply/"), true);
  assert.deepStrictEqual(pro.net_settings.netclass_patterns.map((p) => p.pattern), ["/Supply/VIN", "/Other/A"]);
  assert.deepStrictEqual(Object.keys(pro.net_settings.net_colors), ["/Supply/VIN", "/GND"]);
  assert.strictEqual(L.renameNetPathPrefix(pro, "/Power/", "/Supply/"), false, "nothing left to rename");
  assert.strictEqual(L.renameNetPathPrefix(pro, "/A/", "/A/"), false); assert.strictEqual(L.renameNetPathPrefix({}, "/A/", "/B/"), false);
});
test("Sheet Properties under a design variant: user field texts and the three flags go to the variant, Exclude from board stays the sheet's", () => {
  const base = K.parse(`(sheet (at 0 0) (size 10 10) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "s")
    (property "Sheetname" "A" (at 0 0 0)) (property "Sheetfile" "a.kicad_sch" (at 0 0 0)) (property "Note" "base" (at 0 0 0))
    (instances (project "p" (path "/r" (page "2")))))`);
  const edited = K.cloneNode(base);
  K.kids(edited, "property")[2][2] = "variant text"; K.kids(edited, "property")[0][2] = "B";
  K.kid(edited, "dnp")[1] = "yes"; K.kid(edited, "on_board")[1] = "no";
  const out = V.writeSheetVariant(edited, base, "Fab", "/r", 20260306);
  const s = S(out);
  assert.ok(s.includes('(property "Note" "base"'), "the sheet keeps its default text");
  assert.ok(s.includes('(property "Sheetname" "B"'), "the sheet name is the sheet's own");
  assert.ok(s.includes("(on_board no)"), "Exclude from board is global");
  assert.ok(/\(dnp no\)[^]*\(variant \(name "Fab"\) \(dnp yes\) \(field \(name "Note"\) \(value "variant text"\)\)\)/.test(s), s);
});
test("Pin Functions table: PIN_NUMBERS::Compare, the pin number as the second key, the Alternate column by its shown name", () => {
  assert.ok(P.pinNumbersCompare("2", "10") < 0); assert.ok(P.pinNumbersCompare("A2", "A10") < 0); assert.ok(P.pinNumbersCompare("A1", "1") > 0);
  assert.strictEqual(P.pinNumbersCompare("B3", "B3"), 0); assert.ok(P.pinNumbersCompare("1", "A") < 0); assert.ok(P.pinNumbersCompare("3v3", "3v4") < 0);
  const r = (number, name, alt, type) => ({ number, name, alt, type, style: "Line" });
  const rows = [r("10", "IO", "", "Passive"), r("2", "IO", "", "Input"), r("1", "VCC", "ALT1", "Input")];
  assert.deepStrictEqual(rows.slice().sort((a, b) => P.pinRowCompare(a, b, "name", true)).map((x) => x.number), ["2", "10", "1"], "equal names fall back to the number");
  assert.deepStrictEqual(rows.slice().sort((a, b) => P.pinRowCompare(a, b, "alt", true)).map((x) => x.number), ["1", "2", "10"], "ALT1 < IO: the shown alternate, not the stored empty one");
  assert.deepStrictEqual(rows.slice().sort((a, b) => P.pinRowCompare(a, b, "type", true)).map((x) => x.number), ["1", "2", "10"], "type without case; ties by number");
  assert.deepStrictEqual(rows.slice().sort((a, b) => P.pinRowCompare(a, b, "number", false)).map((x) => x.number), ["10", "2", "1"]);
});
test("Symbol Properties' Embedded Files page writes the library copy", () => {
  const lib = K.parse(`(symbol "Device:R" (symbol "R_1_1") (embedded_fonts no) (embedded_files (file (name "a.pdf") (type datasheet) (data |x|)) (file (name "b.pdf") (type datasheet) (data |y|))))`);
  assert.deepStrictEqual(P.embeddedFileNames(lib), ["a.pdf", "b.pdf"]);
  assert.strictEqual(P.applyEmbeddedFiles(K.cloneNode(lib), ["a.pdf", "b.pdf"], [], false), false, "nothing changed");
  const n = K.cloneNode(lib);
  assert.strictEqual(P.applyEmbeddedFiles(n, ["b.pdf"], ['(file (name "c.txt") (type other) (data |z|))'], true), true);
  assert.deepStrictEqual(P.embeddedFileNames(n), ["b.pdf", "c.txt"]); assert.ok(S(n).includes("(embedded_fonts yes)"));
  const none = K.cloneNode(lib); P.applyEmbeddedFiles(none, [], [], false); assert.strictEqual(K.kid(none, "embedded_files"), null, "an empty list goes");
  const fresh = K.parse(`(symbol "Device:C" (symbol "C_1_1"))`); P.applyEmbeddedFiles(fresh, [], ['(file (name "c.txt") (type other) (data |z|))'], true);
  assert.ok(/\(embedded_fonts yes\) \(embedded_files \(file \(name "c.txt"\)/.test(S(fresh)), S(fresh));
});
test("Update / Change Symbols: the Private flag follows the library field, pin map overrides are reset only when asked", () => {
  const lib = K.parse(`(symbol "Device:R" (property "Reference" "R" (at 0 0 0)) (property "Value" "R" (at 0 0 0)) (property private "Secret" "s" (at 0 0 0)) (property "Open" "o" (at 0 0 0))
    (symbol "R_1_1" (pin passive line (at 0 0 0) (length 1) (name "~") (number "1"))))`);
  const mk = () => K.parse(`(symbol (lib_id "Device:R") (at 0 0 0) (unit 1) (dnp no) (pin_map_override (mode identity)) (uuid "u")
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "R" (at 0 0 0)) (property "Secret" "mine" (at 0 0 0)) (property private "Open" "mine" (at 0 0 0)) (pin "1" (uuid "p")))`);
  const o = C.defaultOptions("update"); o.fields = new Set(["Secret", "Open"]); o.resetText = false;
  const refs = { used: new Set(), renamed: new Map() };
  const kept = C.updateSymbolNode(mk(), lib, "Device:R", o, refs, () => "new");
  assert.ok(S(kept).includes('(property private "Secret" "mine"'), "the library field is private: so is the symbol's");
  assert.ok(S(kept).includes('(property "Open" "mine"'), "and the other way round");
  assert.ok(S(kept).includes("(pin_map_override (mode identity))"), "kept while 'Update/reset pin map overrides' is off");
  o.resetPinMaps = true;
  assert.ok(!S(C.updateSymbolNode(mk(), lib, "Device:R", o, refs, () => "new")).includes("pin_map_override"), "reset to the library default when it is on");
  // keepPinMaps: the old library copy's maps written onto the new one
  const old = K.parse(`(symbol "Device:R" (associated_footprints (footprint "R:0603" (map "m"))) (pin_maps (pin_map "m" (entry "1" "2"))) (symbol "R_1_1"))`);
  const fresh = K.cloneNode(lib); P.writePinMaps(fresh, P.readPinMaps(old));
  assert.ok(S(fresh).includes('(pin_maps (pin_map "m" (entry "1" "2")))') && S(fresh).includes('(associated_footprints (footprint "R:0603" (map "m")))'));
});
test("text variable autocompletion: the caret's context, the matches and the names offered", () => {
  assert.deepStrictEqual(L.textVarContext("a ${SH", 6), { partial: "SH", xref: "", start: 4 });
  assert.deepStrictEqual(L.textVarContext("${", 2), { partial: "", xref: "", start: 2 });
  assert.deepStrictEqual(L.textVarContext("${R1:Va", 7), { partial: "Va", xref: "R1", start: 5 });
  assert.strictEqual(L.textVarContext("plain SH", 8), null); assert.strictEqual(L.textVarContext("${A} b", 6), null);
  assert.deepStrictEqual(L.autocompleteMatches("name", ["SHEETNAME", "FILENAME", "TITLE", "b_name"]), ["b_name", "FILENAME", "SHEETNAME"]);
  const s = K.parse(`(symbol (lib_id "D:R") (property "Reference" "R1" (at 0 0 0)) (property "MPN" "x" (at 0 0 0)) (property private "Hidden" "x" (at 0 0 0)) (property "ki_fp_filters" "x" (at 0 0 0)))`);
  const sv = L.symbolTextVars(s);
  assert.deepStrictEqual(sv.slice(0, 3), ["REFERENCE", "MPN", "OP"]); assert.ok(sv.includes("NET_NAME(<pin_number>)") && !sv.includes("Hidden"));
  const sheet = K.parse(`(sheet (property "Sheetname" "A" (at 0 0 0)) (property "Sheetfile" "a.kicad_sch" (at 0 0 0)) (property "Rev" "1" (at 0 0 0)))`);
  const tv = L.sheetTextVars([sheet], ["MYVAR"]);
  assert.deepStrictEqual(tv.slice(0, 3), ["SHEETNAME", "SHEETFILE", "Rev"]);
  for (const v of ["#", "##", "SHEETPATH", "FILENAME", "PROJECTNAME", "VARIANT", "ISSUE_DATE", "COMMENT9", "MYVAR", "DNP", "ERC_ERROR <message_text>"]) assert.ok(tv.includes(v), v);
  assert.strictEqual(tv.filter((v) => v === "SHEETNAME").length, 1, "each name once");
  const lab = K.parse(`(global_label "A" (property "Intersheetrefs" "x" (at 0 0 0)) (property "Netclass" "HV" (at 0 0 0)))`);
  assert.deepStrictEqual(L.labelTextVars("global_label", lab), ["INTERSHEETREFS", "Netclass", "OP", "CONNECTION_TYPE", "SHORT_NET_NAME", "NET_NAME", "NET_CLASS"]);
});
test("Pin Properties: the 50 mils grid question tests the value in internal units, as KiCad does", () => {
  assert.strictEqual(M.pinOffStandardGrid(1.27), false); assert.strictEqual(M.pinOffStandardGrid(0.635), false, "a 25 mil position is not questioned");
  assert.strictEqual(M.pinOffStandardGrid(0.001), true); assert.strictEqual(M.pinOffStandardGrid(-2.54), false);
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
