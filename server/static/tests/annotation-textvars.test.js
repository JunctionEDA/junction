// annotation-textvars.test.js — round 2 parity: annotation (reused-sheet suffixes, the designator tracker, power
// symbols on paste), variants (variant symbols, per-variant pin maps) and text variables on the schematic and the board.
// Run: node server/static/tests/annotation-textvars.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const fs = require("fs");
const { webPath } = require("./web-path");
const esbuild = require("esbuild");
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._, P = globalThis.PcbTools;
/** A module of web/domains/pcb bundled for node (the dialogs' logic halves). */
function load(...file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(...file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const kid = K.kid, kids = K.kids, str = K.str;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const HEAD = '(kicad_sch (version 20250114) (generator "t") (uuid "root") (paper "A4") ';
const LIB = (id, ref, extra, units) => `(symbol "${id}" ${extra || ""} (property "Reference" "${ref}" (at 0 2 0) (effects (font (size 1.27 1.27)))) (property "Value" "V" (at 0 -2 0) (effects (font (size 1.27 1.27))))` +
  Array.from({ length: units || 1 }, (x, i) => `(symbol "${id.split(":")[1]}_${i + 1}_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none))) (pin passive line (at -3.81 0 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "${i + 1}" (effects (font (size 1.27 1.27))))))`).join("") + ")";
const LIBS = `(lib_symbols ${LIB("D:R", "R")} ${LIB("D:U", "U", "", 2)} ${LIB("power:GND", "#PWR", "(power)")})`;
const sym = (id, lib, ref, x, y, o) => `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit ${(o && o.unit) || 1}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${id}")` +
  ` (property "Reference" "${ref}" (at ${x} ${y - 2} 0) (effects (font (size 1.27 1.27)))) (property "Value" "${(o && o.value) || "V"}" (at ${x} ${y + 2} 0) (effects (font (size 1.27 1.27))))` +
  ((o && o.extra) || "") +
  ` (instances (project "p" ${((o && o.paths) || [["/root", ref]]).map(([p, r, u]) => `(path "${p}" (reference "${r}") (unit ${u || (o && o.unit) || 1}))`).join(" ")})))`;
const docOf = (body) => K.parseDoc(HEAD + LIBS + body + ")", "kicad_sch");
const refOf = (n) => str(kids(n, "property").find((p) => str(p[1]) === "Reference")[2]);

test("paste in remove-annotation mode annotates power symbols again (SCH_REFERENCE::AlwaysAnnotate)", () => {
  const d = docOf(sym("g1", "power:GND", "#PWR01", 20, 20) + sym("r1", "D:R", "R1", 40, 40));
  const text = sch.clipboardText(d, [d.items.get("g1"), d.items.get("r1")]);
  const { ids } = _.pasteChanges(d, sch.parseClipboard(text), [100, 100], { pasteMode: "remove", annotate: { method: 0, sortY: false, startNum: 0 } });
  const refs = ids.map((id) => refOf(d.items.get(id).node)).sort();
  assert.deepStrictEqual(refs, ["#PWR02", "R?"], "the power symbol takes the next number, the resistor is cleared");
});

test("designators handed out by place / paste go to the project's used_designators (REFDES_TRACKER in SCHEMATIC_SETTINGS)", () => {
  const A = load("dialogs", "annotate-logic.ts");
  assert.strictEqual(A.trackerToStore("R1-2", new Set(["R1", "R2"]), sch.serializeTracker, sch.deserializeTracker), null, "nothing new: no write");
  assert.strictEqual(A.trackerToStore("R1-2", new Set(["R1", "R3", "C1"]), sch.serializeTracker, sch.deserializeTracker), "C1,R1-3");
  assert.strictEqual(A.trackerToStore("", ["#PWR01"], sch.serializeTracker, sch.deserializeTracker), "#PWR1");
});

test("a pin's Unit row is its own unit: 'All units' for a pin common to every unit (SCH_ITEM::GetMsgPanelInfo)", () => {
  const lib = `(symbol "D:Q" (property "Reference" "Q" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "Q" (at 0 0 0) (effects (font (size 1.27 1.27))))` +
    ` (symbol "Q_0_1" (pin power_in line (at 0 5.08 270) (length 2.54) (name "V" (effects (font (size 1.27 1.27)))) (number "8" (effects (font (size 1.27 1.27))))))` +
    ` (symbol "Q_1_1" (unit_name "Left") (pin input line (at -5.08 0 0) (length 2.54) (name "I" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))` +
    ` (symbol "Q_2_1" (pin input line (at -5.08 0 0) (length 2.54) (name "J" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
  const d = K.parseDoc(HEAD + `(lib_symbols ${lib})` + sym("q", "D:Q", "Q1", 50, 50, { unit: 2 }) + ")", "kicad_sch");
  const row = (pin) => sch.msgPanelInfo(d, { id: "q", pin }, { units: "mm" }).find((r) => r.title === "Unit").value;
  assert.strictEqual(row("8"), "All units");
  assert.strictEqual(row("2"), "B");
  const d1 = K.parseDoc(HEAD + `(lib_symbols ${lib})` + sym("q", "D:Q", "Q1", 50, 50, { unit: 1 }) + ")", "kicad_sch");
  assert.strictEqual(sch.msgPanelInfo(d1, { id: "q", pin: "1" }, { units: "mm" }).find((r) => r.title === "Unit").value, "Left", "the unit's display name");
});

test("Symbol Fields Table: the cursor column on open and a dragged column (GoToCell, OnColMove / MoveColumn)", () => {
  const D = load("dialogs", "logic.ts");
  assert.strictEqual(D.cursorColumn(["Reference", "Value", "Footprint"]), "Value");
  assert.strictEqual(D.cursorColumn(["Reference", "Footprint"]), "Reference");
  assert.strictEqual(D.cursorColumn(["Footprint", "MPN"]), "Footprint");
  assert.strictEqual(D.cursorColumn([]), null);
  const f = (n) => ({ name: n, label: n, show: true, group_by: false });
  const order = [f("Reference"), f("Value"), f("Footprint"), f("MPN")];
  assert.ok(D.moveColumn(order, "Reference", "Footprint"));
  assert.deepStrictEqual(order.map((x) => x.name), ["Value", "Footprint", "Reference", "MPN"], "moved right: the others shift left (std::rotate)");
  assert.ok(D.moveColumn(order, "MPN", "Value"));
  assert.deepStrictEqual(order.map((x) => x.name), ["MPN", "Value", "Footprint", "Reference"], "moved left");
  assert.strictEqual(D.moveColumn(order, "MPN", "MPN"), false);
  const src = fs.readFileSync(webPath("tools", "kicad-dialogs", "widgets.ts"), "utf8");
  assert.ok(/onColMove/.test(src) && /draggable = true/.test(src), "the shared grid's headers drag (EnableDragColMove)");
});

test("schematic item dialogs note overridden item colours (GetOverrideSchItemColors)", () => {
  const note = /itemColorsOverriddenNotice\(/;
  for (const f of ["dialogs/sch-items.ts", "dialogs/sch-symbol-sheet.ts", "editor/tabledialogs.ts"]) assert.ok(note.test(fs.readFileSync(webPath(f), "utf8")), f);
  const prefs = fs.readFileSync(webPath("dialogs", "prefs.ts"), "utf8");
  assert.ok(prefs.includes("Note: individual item colors overridden in Preferences.") && prefs.includes("Note: item colors are overridden in the current color theme."));
});

test("ERC items name the sheet instance they are on, so cross-probing an aux item goes to its sheet (SetItemsSheetPaths)", () => {
  const a = docOf(sym("r1", "D:R", "R1", 40, 40, { paths: [["/root", "R1"]] }));
  const b = docOf(sym("r2", "D:R", "R1", 60, 60, { paths: [["/root/s1", "R1"]] }));
  const res = sch.ercHierarchy([{ doc: a, key: "", path: "/root", page: 1, root: true }, { doc: b, key: "s1", path: "/root/s1", page: 2, parent: 0, sheetId: "s1" }], {});
  const dup = res.flat().find((m) => m.code === "duplicate_reference");
  assert.ok(dup, "duplicate reference found");
  assert.deepStrictEqual(dup.items.map((it) => it.sheet).sort(), [0, 1], "main and aux item each on their own sheet");
  const src = fs.readFileSync(webPath("dialogs", "erc.ts"), "utf8");
  assert.ok(/it && it\.docId \? it : m/.test(src), "the dialog follows an item's own sheet");
});

test("symbol text variables: ${REF:FIELD} cross-references, ${PROPERTY.*} and the net functions (SCH_SYMBOL::ResolveTextVar)", () => {
  const d = docOf(sym("r1", "D:R", "R1", 40, 40, { value: "10k" }) + sym("u1", "D:U", "U1", 80, 40, { unit: 2, paths: [["/root", "U1", 2]] }));
  const R = (id) => K.symbolResolver(d, d.items.get(id), "/root");
  const tv = (id, t) => K.expandTextVars ? K.expandTextVars(t, (tok) => R(id).resolve(tok, 0)) : null;
  const res = (id, tok) => R(id).resolve(tok, 0);
  assert.strictEqual(res("u1", "R1:Value"), "10k", "by reference designator");
  assert.strictEqual(res("u1", "/root/r1:Value"), "10k", "by KIID path, as ConvertRefsToKIIDs stores it");
  assert.strictEqual(res("u1", "r1:Nope"), "<Unresolved: R1:Nope>");
  assert.strictEqual(res("u1", "R9:Value"), "<Unresolved: R9>");
  assert.strictEqual(res("r1", "U1B:Reference"), "U1B", "a unit reference names that unit exactly");
  assert.strictEqual(res("r1", "PROPERTY.Value"), "10k");
  assert.strictEqual(res("r1", "PROPERTY.Library_Link"), "D:R", "underscores read as spaces");
  assert.strictEqual(res("r1", "PROPERTY.Do_not_Populate"), "false");
  assert.strictEqual(res("u1", "PROPERTY.Unit"), "2");
  assert.strictEqual(res("r1", "PROPERTY.Unit"), null, "Unit is not available on a one-unit symbol");
  assert.strictEqual(res("r1", "PROPERTY.Position_X"), "1574.803 mils");
  assert.strictEqual(res("r1", "PROPERTY.Mirror_Y"), "false");
  // the host's connection graph answers the pin functions
  const saved = K.symVars.net;
  K.symVars.net = (item, pin, kind) => (item.id === "r1" && pin === "1" ? (kind === "NET_CLASS" ? "Power" : kind === "SHORT_NET_NAME" ? "VCC" : "/VCC") : null);
  try { assert.strictEqual(res("r1", "NET_NAME(1)"), "/VCC"); assert.strictEqual(res("r1", "NET_CLASS(1)"), "Power"); assert.strictEqual(res("r1", "SHORT_NET_NAME(1)"), "VCC"); }
  finally { K.symVars.net = saved; }
  const withNet = docOf(sym("r2", "D:R", "R2", 40, 40, { extra: ' (property "N" "${NET_NAME(1)}" (at 0 0 0) (effects (font (size 1.27 1.27))))' }));
  assert.ok(K.refreshLabelTextVars(withNet), "a symbol showing a pin's net is drawn again when the nets change");
});

test("ERC text variables: unresolved ${…} and ${ERC_WARNING} / ${ERC_ERROR} assertions (ERC_TESTER::TestTextVars)", () => {
  const fld = (name, v) => ` (property "${name}" "${v}" (at 0 0 0) (effects (font (size 1.27 1.27))))`;
  const d = docOf(sym("r1", "D:R", "R1", 40, 40, { extra: fld("A", "${NOPE}") + fld("B", "${VALUE}") + fld("C", "\\\\${NOPE}") + fld("D", "${ERC_WARNING check me} ${ERC_ERROR bad}") }) +
    '(text "${ALSO_NOPE}" (at 10 20 0) (effects (font (size 1.27 1.27))) (uuid "t1"))' +
    '(text "${TITLE}" (at 10 30 0) (effects (font (size 1.27 1.27))) (uuid "t2"))' +
    '(global_label "G" (shape input) (at 60 60 0) (effects (font (size 1.27 1.27))) (uuid "g1")' + fld("Intersheetrefs", "${INTERSHEET_REFS}") + ")");
  const checks = K.textChecks(d, "/root");
  assert.ok(checks.every((c) => c.item !== "g1"), "INTERSHEET_REFS is answered");
  const ms = sch.ercCheck(d, {});
  const unres = ms.filter((m) => m.code === "unresolved_variable");
  assert.deepStrictEqual(unres.map((m) => m.ids[0]).sort(), ["r1", "t1"], "only ${NOPE} and ${ALSO_NOPE}; ${VALUE} resolves and \\${…} is escaped");
  assert.ok(unres.every((m) => m.text === "Unresolved text variable"));
  const gw = ms.filter((m) => m.code === "generic-warning"), ge = ms.filter((m) => m.code === "generic-error");
  assert.deepStrictEqual(gw.map((m) => [m.text, m.severity]), [["check me", "warning"]]);
  assert.deepStrictEqual(ge.map((m) => [m.text, m.severity]), [["bad", "error"]]);
  assert.deepStrictEqual([ge[0].x, ge[0].y], [0, 0], "at the field's position");
  // the test is off when unresolved_variable is ignored
  assert.strictEqual(sch.ercCheck(d, { textVars: false }).filter((m) => /unresolved_variable|generic-/.test(m.code)).length, 0);
  // the drawing sheet's texts
  d.drawingSheet = K.parseDrawingSheet('(kicad_wks (version 20231118) (generator "t") (setup (textsize 1.5 1.5) (linewidth 0.15) (textlinewidth 0.15) (left_margin 10) (right_margin 10) (top_margin 10) (bottom_margin 10)) (tbtext "${UNKNOWN_VAR}" (name "") (pos 50 30)) (tbtext "${ERC_WARNING ws}" (name "") (pos 50 40)))');
  const ds = sch.ercCheck(d, {});
  assert.ok(ds.some((m) => m.code === "unresolved_variable" && m.text === "Unresolved text variable in drawing sheet"), "an unknown variable in the drawing sheet");
  assert.ok(ds.some((m) => m.code === "generic-warning" && m.text === "ws (in drawing sheet)"));
});

const PCB_HEAD = '(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (35 "F.Fab" user "Fab Top")) (property "BOARDVAR" "bv") ';
const pfld = (name, v, layer) => `(property "${name}" "${v}" (at 0 0 0) (layer "${layer || "F.SilkS"}") (effects (font (size 1 1) (thickness 0.15))))`;
const pboard = (body) => K.parseDoc(PCB_HEAD + body + ")", "kicad_pcb");
const FP = (uuid, ref, extra) => `(footprint "Lib:R_0603" (layer "F.Cu") (uuid "${uuid}") (at 10 20 90) (descr "a resistor") (attr smd dnp) ${pfld("Reference", ref)} ${pfld("Value", "10k", "F.Fab")} ${pfld("MPN", "X-" + ref)}` +
  ` (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "/VCC") (pinfunction "VIN")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu")) ${extra || ""})`;

test("board text variables: BOARD / FOOTPRINT::ResolveTextVar and PCB_TEXT::GetShownText", () => {
  const d = pboard(FP("f1", "R1") + FP("f2", "R2") + '(gr_text "${R1:VALUE} ${f2:MPN} ${R9:VALUE} ${BOARDVAR} ${LAYER} ${PAPER}" (at 0 0 0) (layer "F.Fab") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))');
  d.projectVars = { PV: "proj" };
  const fp = d.items.get("f1").node;
  const sh = (t, layer, f, field) => K.pcbTextShown(d, t, layer || "F.SilkS", f === undefined ? fp : f, field);
  assert.strictEqual(sh("${REFERENCE}/${VALUE}/${MPN}"), "R1/10k/X-R1");
  assert.strictEqual(sh("${LAYER}", "F.Fab"), "Fab Top", "the text's own layer, by its user name");
  assert.strictEqual(sh("${FOOTPRINT_LIBRARY}|${FOOTPRINT_NAME}"), "Lib|R_0603");
  assert.strictEqual(sh("${NET_NAME(1)}|${SHORT_NET_NAME(1)}|${PIN_NAME(1)}|${NET_NAME(2)}|${NET_CLASS(1)}"), "/VCC|VCC|VIN||Default");
  const saved = K.pcbVars.netClass; K.pcbVars.netClass = (n) => (n === "/VCC" ? "Power" : null);
  try { assert.strictEqual(sh("${NET_CLASS(1)}"), "Power", "the host's net class"); } finally { K.pcbVars.netClass = saved; }
  assert.strictEqual(sh("${DNP}|${EXCLUDE_FROM_BOM}|${EXCLUDE_FROM_BOARD}"), "DNP||");
  assert.strictEqual(sh("${PROPERTY.Library_Description}|${PROPERTY.Orientation}|${PROPERTY.Position_X}|${PROPERTY.Footprint_Type}|${PROPERTY.Do_not_Populate}"), "a resistor|90.0°|10 mm|SMD|true");
  assert.strictEqual(sh("${PV}|${BOARDVAR}|${NOPE}"), "proj|bv|${NOPE}", "the project's variables, then the board's properties");
  assert.strictEqual(sh("${R2:MPN}|${r2:Value}|${R9:X}|${f1:NOPE}"), "X-R2|10k|<Unresolved: R9:X>|<Unresolved: R1:NOPE>", "cross-references by reference (without case) and by uuid");
  assert.strictEqual(sh("${PAPER}", "F.SilkS", null), "${PAPER}", "the drawing sheet's own tokens are not the board's");
  // a variant's field value is taken as it is
  const dv = pboard(FP("f1", "R1", '(variant (name "V2") (field (name "Value") (value "22k")))')); dv.variantName = "V2";
  assert.strictEqual(K.pcbTextShown(dv, "${VALUE}", "F.SilkS", dv.items.get("f1").node), "22k");
  assert.strictEqual(K.pcbTextShown(dv, "${VARIANT}", "F.SilkS", null), "V2");
});

test("DRC: unresolved text variables and ${DRC_WARNING} / ${DRC_ERROR} assertions (DRC_TEST_PROVIDER_MISC::testTextVars)", () => {
  const d = pboard(FP("f1", "R1", pfld("Bad", "${NOPE}") + pfld("Warn", "${DRC_WARNING look here}")) +
    '(gr_text "${ALSO_NOPE}" (at 5 5 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))' +
    '(gr_text "\\\\${ESCAPED} ${REFERENCE} ${DRILL_SITES}" (at 5 8 0) (layer "F.SilkS") (uuid "t2") (effects (font (size 1 1) (thickness 0.15))))' +
    '(gr_text "${DRC_ERROR stop}" (at 5 9 0) (layer "F.SilkS") (uuid "t3") (effects (font (size 1 1) (thickness 0.15))))');
  const ms = P.drc(d, null, {});
  const un = ms.filter((m) => m.code === "unresolved_variable");
  assert.deepStrictEqual(un.map((m) => m.ids[0]).sort(), ["f1", "t1", "t2"], "the footprint's field, ${ALSO_NOPE} and a board text's ${REFERENCE}");
  assert.ok(un.every((m) => m.text === "Unresolved text variable"));
  const gw = ms.filter((m) => m.code === "generic_warning"), ge = ms.filter((m) => m.code === "generic_error");
  assert.deepStrictEqual(gw.map((m) => [m.text, m.ids[0]]), [["look here", "f1"]]);
  assert.deepStrictEqual(ge.map((m) => [m.text, m.ids[0], m.x, m.y]), [["stop", "t3", 5, 9]]);
  const ign = P.drc(d, { board: { design_settings: { rule_severities: { unresolved_variable: "ignore" } } } }, {});
  assert.ok(ign.every((m) => m.code !== "unresolved_variable" && m.code !== "generic_warning"), "the test is off when its rule is ignored");
});

test("Copy as Text copies the shown text (EDIT_TOOL::copyToClipboardAsText: GetShownText( FOR_CANVAS ))", () => {
  const d = pboard(FP("f1", "R1") + '(gr_text "V=${R1:VALUE}" (at 5 5 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))' +
    '(table (column_count 2) (layer "F.SilkS") (uuid "tb") (cells (table_cell "${ROW}:${COL}" (start 0 0) (end 1 1) (layer "F.SilkS") (effects (font (size 1 1)))) (table_cell "${BOARDVAR}" (start 1 0) (end 2 1) (layer "F.SilkS") (effects (font (size 1 1))))))');
  assert.strictEqual(P.textOfItem(d.items.get("t1"), d), "V=10k");
  assert.strictEqual(P.textOfItem(d.items.get("tb"), d), "1:1\tbv");
});

test("PCB text dialogs complete ${ with PCB_BASE_EDIT_FRAME::GetContextualTextVars", () => {
  const X = load("editor", "pcbdialogs", "xref.ts");
  const d = pboard(FP("f1", "R1")); d.projectVars = { MYVAR: "1" };
  const board = X.pcbContextualTextVars(d, "", null);
  assert.deepStrictEqual(board.slice(0, 11), ["LAYER", "FILENAME", "FILEPATH", "PROJECTNAME", "DRC_ERROR <message_text>", "DRC_WARNING <message_text>", "VARIANT", "VARIANT_DESC", "DRILL_OPERATIONS", "DRILL_SITES", "DRILL_GROUPS"]);
  assert.ok(board.includes("COMMENT9") && board.includes("MYVAR") && !board.includes("REFERENCE"));
  const inFp = X.pcbContextualTextVars(d, "", d.items.get("f1").node);
  assert.ok(inFp.includes("REFERENCE") && inFp.includes("PIN_NAME(<pad_number>)"), "a footprint's text adds the footprint's variables");
  assert.deepStrictEqual(X.pcbContextualTextVars(d, "R1", null)[0], "REFERENCE", "${R1: lists R1's variables");
  assert.deepStrictEqual(X.pcbContextualTextVars(d, "R9", null), []);
  for (const f of [["editor", "pcbdialogs", "item-props.ts"], ["editor", "pcbdialogs", "textbox.ts"], ["editor", "pcbdialogs", "table.ts"], ["editor", "tabledialogs.ts"]])
    assert.ok(/boardTextVarAutocomplete\([a-z]+, doc, parentFootprintOf/.test(fs.readFileSync(webPath(...f), "utf8")), f.join("/") + " completes text variables");
  assert.ok(/textVarAutocompleter\.fn = textVarAutocomplete;/.test(fs.readFileSync(webPath("dialogs", "sch-items.ts"), "utf8")), "the schematic's completer is the board dialogs' too");
  // the hook hands the board's list to the registered completer
  let got = null; X.textVarAutocompleter.fn = (input, get) => { got = get(""); };
  X.boardTextVarAutocomplete({}, d, d.items.get("f1").node); assert.ok(got && got.includes("REFERENCE") && got.includes("LAYER"));
});

test("the field dialog's ${OP: lists the simulation model's ports (SCH_FIELD::OnScintillaCharAdded, SIM_MODEL::GetPinNames)", () => {
  const L = load("dialogs", "sch-items-logic.ts");
  const node = (ref, value, extra) => K.parse(`(symbol (lib_id "D:R") (at 0 0 0) (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "${value}" (at 0 0 0)) ${extra || ""})`);
  const lib = K.parse(LIB("D:R", "R").replace('(pin passive line (at -3.81 0 0)', '(pin passive line (at 3.81 0 0) (length 2.54) (name "B") (number "2")) (pin passive line (at -3.81 0 0)'));
  assert.deepStrictEqual(L.simModelPorts(node("R1", "10k"), lib, () => null), ["+", "-", "power"], "an inferred resistor");
  const q = node("Q1", "BC547", '(property "Sim.Device" "NPN" (at 0 0 0)) (property "Sim.Type" "GUMMELPOON" (at 0 0 0))');
  assert.deepStrictEqual(L.simModelPorts(q, lib, () => null), ["C", "B", "E", "S", "power"], "an optional pin loses its angle brackets");
  const d = node("D1", "x", '(property "Sim.Library" "my.lib" (at 0 0 0)) (property "Sim.Name" "DMOD" (at 0 0 0))');
  assert.strictEqual(L.simLibraryPath(d, lib), "my.lib");
  assert.deepStrictEqual(L.simModelPorts(d, lib, (p) => (p === "my.lib" ? ".model DMOD D(Is=1e-14)\n" : null)), ["A", "K", "power"], "a library model's type");
  assert.ok(/if \(xref === "OP" && parent\) return parent\.kind === "symbol" \? opPortNames\(doc, parent\)/.test(fs.readFileSync(webPath("dialogs", "sch-items.ts"), "utf8")));
});

test("autoplaced fields clear the pins' shown numbers and names (getPinsBox merges SCH_PIN::GetBoundingBox)", () => {
  const pin = (x, y, a, n, sz) => `(pin passive line (at ${x} ${y} ${a}) (length 2.54) (name "N${n}" (effects (font (size 1.27 1.27)))) (number "${n}" (effects (font (size ${sz} ${sz})))))`;
  const lib = (sz) => `(lib_symbols (symbol "D:Q" (property "Reference" "Q" (at 0 2 0) (effects (font (size 1.27 1.27)))) (property "Value" "V" (at 0 -2 0) (effects (font (size 1.27 1.27)))) (symbol "Q_1_1" (rectangle (start -2.54 -2.54) (end 2.54 2.54) (stroke (width 0) (type default)) (fill (type none))) ${pin(-5.08, 0, 0, 1, sz)}${pin(5.08, 0, 180, 2, sz)}${pin(0, 5.08, 270, 3, sz)}${pin(0, -5.08, 90, 4, sz)})))`;
  const place = (sz) => {
    const d = K.parseDoc(HEAD + lib(sz) + '(symbol (lib_id "D:Q") (at 50.8 50.8 0) (unit 1) (in_bom yes) (on_board yes) (uuid "q1") (property "Reference" "Q1" (at 50 40 0) (effects (font (size 1.27 1.27)))) (property "Value" "V" (at 50 60 0) (effects (font (size 1.27 1.27)))) (instances (project "p" (path "/root" (reference "Q1") (unit 1)))))' + ")", "kicad_sch");
    const it = d.items.get("q1"), n = _.autoplaceNode(d, it, { manual: false });
    const at = (f) => kid(kids(n, "property").find((p) => str(p[1]) === f), "at");
    const pin2 = _.symbolPins(d, it).find((p) => p.number === "2");
    return { ref: K.num(at("Reference")[2]), val: K.num(at("Value")[2]), box: _.pinBox(it, pin2) };
  };
  const small = place(1.27), big = place(5);
  assert.ok(big.ref < small.ref - 3, "a taller pin number pushes the fields up: " + small.ref + " -> " + big.ref);
  assert.ok(big.val + 0.635 <= big.box[1], "the field box sits above the pin's number text: " + big.val + " vs " + big.box[1]);
});
console.log(`annotation-textvars: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
