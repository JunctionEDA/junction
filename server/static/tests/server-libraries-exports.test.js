// server-libraries-exports.test.js — round 3, the library-backed checks and the server / file exporters: ERC's
// library tests (TestLibSymbolIssues, TestPinMap, TestFootprintLinkIssues) and the DRC's library parity over the
// library-content lookup (library/lib-lookup.ts), Rescue Symbols (project_rescue.cpp), the legacy BOM generators
// (eeschema/python_scripts over the intermediate XML netlist), the 3D (STEP/GLB/…) export, Hyperlynx, Specctra
// session import, netlist import and 3D model migration.
// Run: node server/static/tests/server-libraries-exports.test.js
"use strict";
const assert = require("assert");
const path = require("path"), fs = require("fs");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
globalThis.window = globalThis;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
function load(...p) {
  const out = esbuild.buildSync({ entryPoints: [webPath(...p)], bundle: true, format: "cjs", target: "es2020", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const src = (...p) => fs.readFileSync(webPath(...p), "utf8");
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const LL = load("library", "lib-lookup.ts");

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
console.log("round 3: library checks, rescue, legacy BOM, 3D / Hyperlynx export, session / netlist import, 3D model migration");

// ---------------------------------------------------------------- the library configuration
test("lib-lookup: the project table first, then project libraries, then the official ones", () => {
  const rows = LL.tableRows('(sym_lib_table (version 7) (lib (name "own")(type "KiCad")(uri "${KIPRJMOD}/libs/own.kicad_sym")(options "")(descr "")) (lib (name "off")(type "KiCad")(uri "${KIPRJMOD}/x.kicad_sym")(options "")(descr "")(disabled)) (lib (name "gone")(type "KiCad")(uri "${KIPRJMOD}/gone.kicad_sym")(options "")(descr "")) (lib (name "Dev")(type "KiCad")(uri "${KICAD10_SYMBOL_DIR}/Device.kicad_symdir")(options "")(descr "")) (lib (name "abs")(type "KiCad")(uri "/home/me/a.kicad_sym")(options "")(descr "")))');
  const docs = [{ docId: "1", path: "libs/own.kicad_sym" }, { docId: "2", path: "loose.kicad_sym" }, { docId: "3", path: "fp/mine.pretty/A.kicad_mod" }];
  const off = new Set(["Device", "power"]);
  assert.deepStrictEqual(LL.librarySource("symbol", "own", rows, docs, off), { state: "ok", uri: "${KIPRJMOD}/libs/own.kicad_sym", project: "libs/own.kicad_sym" });
  assert.strictEqual(LL.librarySource("symbol", "off", rows, docs, off).state, "disabled");
  assert.deepStrictEqual(LL.librarySource("symbol", "gone", rows, docs, off), { state: "not_loaded", uri: "${KIPRJMOD}/gone.kicad_sym" });
  assert.deepStrictEqual(LL.librarySource("symbol", "Dev", rows, docs, off), { state: "ok", uri: "${KICAD10_SYMBOL_DIR}/Device.kicad_symdir", official: "Device" });
  assert.strictEqual(LL.librarySource("symbol", "abs", rows, docs, off).state, "not_loaded", "a path outside the project cannot be read");
  assert.strictEqual(LL.librarySource("symbol", "loose", rows, docs, off).project, "loose.kicad_sym", "a project library without a row is read by its name");
  assert.strictEqual(LL.librarySource("symbol", "power", rows, docs, off).official, "power");
  assert.strictEqual(LL.librarySource("symbol", "Nope", rows, docs, off).state, "missing");
  assert.strictEqual(LL.librarySource("symbol", "Nope", rows, docs, null), null, "unknown while the official list cannot be read");
  assert.strictEqual(LL.librarySource("footprint", "mine", [], docs, off).project, "fp/mine.pretty");
});

test("lib-lookup: one request for the official items, project symbols flattened over their parents", async () => {
  const libText = '(kicad_symbol_lib (symbol "Base" (property "Reference" "U" (at 0 0 0)) (symbol "Base_1_1" (pin input line (at 0 0 0) (length 2.54) (name "A") (number "1")))) (symbol "Kid" (extends "Base") (property "Value" "Kid" (at 0 0 0))))';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init && init.body ? JSON.parse(init.body) : null]);
    const ok = (body, text) => ({ ok: true, status: 200, json: async () => body, text: async () => text || JSON.stringify(body) });
    if (url === "/api/libs/symbols") return ok({ libraries: [{ name: "Device" }] });
    if (url === "/api/libs/footprints") return ok({ libraries: [{ name: "Resistor_SMD" }] });
    if (url === "/api/libs/lookup") return ok({ symbols: { "Device:R": { library: true, symbol: '(symbol "R" (symbol "R_1_1" (pin passive line (at 0 0 0) (length 1) (name "~") (number "1"))))', parents: [] }, "Device:Nope": { library: true } },
      footprints: { "Resistor_SMD:R_0603": { library: true, footprint: '(footprint "R_0603" (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu")))' } } });
    if (url === "/api/docs/L/content") return ok(null, libText);
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const r = await LL.lookupLibraryItems({ symbols: ["Device:R", "Device:Nope", "mine:Kid", "Gone:X"], footprints: ["Resistor_SMD:R_0603"] }, [{ docId: "L", path: "mine.kicad_sym" }]);
  const ask = calls.find((c) => c[0] === "/api/libs/lookup")[1];
  assert.deepStrictEqual(ask, { symbols: ["Device:R", "Device:Nope"], footprints: ["Resistor_SMD:R_0603"] }, "only official items go to the server, in one request");
  assert.strictEqual(K.str(r.symbols.get("Device:R").symbol[1]), "Device:R", "embedded under its lib id");
  assert.strictEqual(r.symbols.get("Device:Nope").symbol, null);
  const kid = r.symbols.get("mine:Kid").symbol;
  assert.ok(kid && !K.kid(kid, "extends") && K.kids(kid, "symbol").length, "a derived project symbol is flattened");
  assert.strictEqual(r.symbols.get("Gone:X").state, "missing");
  assert.deepStrictEqual(Array.from(LL.footprintPadNumbers(r.footprints.get("Resistor_SMD:R_0603").footprint)), ["1", "2"]);
});

// ---------------------------------------------------------------- ERC: TestLibSymbolIssues, TestPinMap, TestFootprintLinkIssues
const HEAD = '(kicad_sch (version 20250114) (generator "t") (uuid "root-uuid") (paper "A4") ';
const PIN = (num, x, y) => `(pin passive line (at ${x} ${y} 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "${num}" (effects (font (size 1.27 1.27)))))`;
function libSym(id, pins, extra) {
  const name = id.split(":")[1];
  return `(symbol "${id}" (in_bom yes) (on_board yes) ${extra || ""} (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "${name}" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "${name}_1_1" ${pins}))`;
}
function schDoc(libs, body) { return K.parseDoc(HEAD + `(lib_symbols ${libs.join(" ")}) ${body})`); }
function symInst(id, ref, at, fp, uuid, extra) {
  return `(symbol (lib_id "${id}") (at ${at[0]} ${at[1]} 0) (unit 1) (uuid "${uuid}") (property "Reference" "${ref}" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Value" "x" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Footprint" "${fp}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes))) ${extra || ""})`;
}
function libsOf(o) {
  const all = new Set(Object.keys(o.enabled || {}));
  return { symbols: new Map(Object.entries(o.symbols || {})), footprints: new Map(Object.entries(o.footprints || {})),
    differs: o.differs || (() => false), enabled: (code) => (o.only ? o.only.includes(code) : !all.has(code) || o.enabled[code]) };
}
const lookSym = (lib, name, state, symbol, uri) => ({ state, uri: uri || "", library: lib, name, symbol: symbol || null });
const lookFp = (lib, name, state, footprint) => ({ state, uri: "", library: lib, name, footprint: footprint ? K.parse(footprint) : null });

test("ERC TestLibSymbolIssues: missing / not found / not loaded libraries and the comparison with the library", () => {
  const libs = [libSym("A:One", PIN("1", 0, 0)), libSym("B:Two", PIN("1", 0, 0)), libSym("C:Three", PIN("1", 0, 0)), libSym("D:Four", PIN("1", 0, 0)), libSym("E:Five", PIN("1", 0, 0) + PIN("1", 0, 5.08))];
  const doc = schDoc(libs, [symInst("A:One", "U1", [10, 10], "", "u1"), symInst("B:Two", "U2", [20, 10], "", "u2"), symInst("C:Three", "U3", [30, 10], "", "u3"), symInst("D:Four", "U4", [40, 10], "", "u4"), symInst("E:Five", "U5", [50, 10], "", "u5")].join(" "));
  const lib = libsOf({ only: ["lib_symbol_issues", "lib_symbol_mismatch"], symbols: {
    "A:One": lookSym("A", "One", "missing"), "B:Two": lookSym("B", "Two", "not_loaded", null, "${KIPRJMOD}/b.kicad_sym"), "C:Three": lookSym("C", "Three", "ok", null),
    "D:Four": lookSym("D", "Four", "ok", K.parse(libSym("D:Four", PIN("2", 0, 0)))), "E:Five": lookSym("E", "Five", "ok", K.parse(libSym("E:Five", PIN("2", 0, 0)))) },
    differs: (a, b) => K.serialize(a) !== K.serialize(b) });
  const ms = sch.ercHierarchy([{ doc, key: "" }], { libraries: lib })[0].filter((m) => m.code.startsWith("lib_symbol"));
  const texts = ms.map((m) => `${m.code} ${m.text}`).sort();
  assert.deepStrictEqual(texts, [
    "lib_symbol_issues Symbol 'Three' not found in symbol library 'C'",
    "lib_symbol_issues The current configuration does not include the symbol library 'A'",
    "lib_symbol_issues The symbol library 'B' was not found at '${KIPRJMOD}/b.kicad_sym'",
    "lib_symbol_mismatch Symbol 'Four' doesn't match copy in library 'D'",
  ], "a schematic copy with duplicate pins is not compared (E)");
  const m = ms.find((x) => x.code === "lib_symbol_mismatch");
  assert.deepStrictEqual([m.x, m.y, m.ids[0]], [40, 10, "u4"], "the marker sits on the symbol");
  // ignored rules make no markers; no libraries: no library tests
  assert.strictEqual(sch.ercHierarchy([{ doc, key: "" }], { libraries: libsOf({ only: [], symbols: lib.symbols }) })[0].filter((x) => x.code.startsWith("lib_")).length, 0);
  assert.strictEqual(sch.ercHierarchy([{ doc, key: "" }], {})[0].filter((x) => x.code.startsWith("lib_")).length, 0);
});

test("ERC TestLibSymbolIssues: one lookup per sheet, a marker on every instance of a reused sheet", () => {
  const doc = schDoc([libSym("A:One", PIN("1", 0, 0))], symInst("A:One", "U1", [10, 10], "", "u1"));
  const ms = sch.ercHierarchy([{ doc, key: "a" }, { doc, key: "b" }], { libraries: libsOf({ only: ["lib_symbol_issues"], symbols: { "A:One": lookSym("A", "One", "disabled") } }) });
  assert.deepStrictEqual(ms.map((l) => l.filter((m) => m.code === "lib_symbol_issues").length), [1, 1]);
});

test("ERC TestPinMap: stale pins, two pins on one pad, pads the footprint lacks, connected pins without a pad", () => {
  const maps = `(associated_footprints (footprint "Pkg:SO8" (map "m1"))) (pin_maps (pin_map "m1" (entry "1" "3") (entry "9" "4") (entry "2" "7")))`;
  const doc = schDoc([libSym("A:Chip", PIN("1", 0, 0) + PIN("2", 0, 2.54) + PIN("3", 0, 5.08), maps)],
    symInst("A:Chip", "U1", [10, 10], "Pkg:SO8", "u1") + ` (wire (pts (xy 10 7.46) (xy 20 7.46)) (uuid "w1")) (wire (pts (xy 10 4.92) (xy 20 4.92)) (uuid "w2"))`);
  const so8 = '(footprint "SO8" (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "3" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "4" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';
  const ms = sch.ercHierarchy([{ doc, key: "" }], { libraries: libsOf({ only: ["pin_map_stale_pin", "pin_map_duplicate_pad", "pin_map_bad_pad", "pin_map_unmapped_pin"], footprints: { "Pkg:SO8": lookFp("Pkg", "SO8", "ok", so8) } }) })[0];
  const t = (code) => ms.filter((m) => m.code === code).map((m) => m.text);
  assert.deepStrictEqual(t("pin_map_stale_pin"), ["Pin map 'm1' references unknown symbol pin '9'"]);
  assert.deepStrictEqual(t("pin_map_duplicate_pad"), ["Symbol pins '3' and '1' both map to pad '3'"], "pin 3 keeps its identity pad, pin 1 maps onto it");
  assert.deepStrictEqual(t("pin_map_bad_pad"), ["Pin map 'm1' references pad '7' not present on footprint 'Pkg:SO8'"]);
  // pin 2 maps to pad 7 (MAPPED, not unmapped); pin 3 has its identity pad; a connected pin without either would be reported
  assert.deepStrictEqual(t("pin_map_unmapped_pin"), []);
  const so8b = '(footprint "SO8" (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))';
  const ms2 = sch.ercHierarchy([{ doc, key: "" }], { libraries: libsOf({ only: ["pin_map_unmapped_pin"], footprints: { "Pkg:SO8": lookFp("Pkg", "SO8", "ok", so8b) } }) })[0];
  assert.deepStrictEqual(ms2.map((m) => m.text), ["Pin '3' is connected but maps to no pad on footprint 'Pkg:SO8'"]);
  assert.ok(ms2[0].items[0].desc.includes("Pin 3"), "the marker's item is the pin");
  assert.deepStrictEqual(_.effectivePad(K.parse(libSym("A:Chip", PIN("1", 0, 0), maps)), K.parse(symInst("A:Chip", "U1", [0, 0], "Pkg:SO8", "u", '(pin_map_override (mode identity))')), "Pkg:SO8", "1", new Set(["1"])), { pad: "1", state: "identity" }, "forced identity ignores the map");
});

test("ERC TestFootprintLinkIssues: cvpcb's link test over every symbol's footprint", () => {
  const doc = schDoc([libSym("A:One", PIN("1", 0, 0))], [symInst("A:One", "U1", [10, 10], "X:Y", "u1"), symInst("A:One", "U2", [20, 10], "Dis:Y", "u2"), symInst("A:One", "U3", [30, 10], "Ok:Gone", "u3"), symInst("A:One", "U4", [40, 10], "Ok:Here", "u4"), symInst("A:One", "U5", [50, 10], "", "u5")].join(" "));
  const ms = sch.ercHierarchy([{ doc, key: "" }], { libraries: libsOf({ only: ["footprint_link_issues"], footprints: {
    "X:Y": lookFp("X", "Y", "missing"), "Dis:Y": lookFp("Dis", "Y", "disabled"), "Ok:Gone": lookFp("Ok", "Gone", "ok"), "Ok:Here": lookFp("Ok", "Here", "ok", '(footprint "Here")') } }) })[0];
  assert.deepStrictEqual(ms.map((m) => m.text).sort(), ["Footprint 'Gone' not found in library 'Ok'", "The current configuration does not include the footprint library 'X'", "The footprint library 'Dis' is not enabled in the current configuration"]);
  const w = sch.libraryWants([doc]);
  assert.deepStrictEqual([Array.from(w.symbols), Array.from(w.footprints).sort()], [["A:One"], ["Dis:Y", "Ok:Gone", "Ok:Here", "X:Y"]]);
});

test("ERC dialog: the browser run reads the libraries once and says when it could not", () => {
  const hier = src("dialogs", "erc-hier.ts"), erc = src("dialogs", "erc.ts"), el = src("dialogs", "erc-library.ts");
  assert.ok(/libraries = await ercLibraries\(/.test(hier));
  assert.ok(/libraryFallback \? ` The library symbol, pin map and footprint link tests were not made/.test(erc));
  assert.ok(!/library symbol and footprint links/.test(erc), "no longer listed as unchecked");
  assert.ok(/compareSymbols\(lib, embedded, parity, null\)/.test(el));
});

// ---------------------------------------------------------------- DRC library parity
test("DRC library parity: the configuration's footprints, FootprintNeedsUpdate with the DRC flags", async () => {
  const DL = load("editor", "pcbdialogs", "drc-library.ts");
  globalThis.fetch = async (url, init) => {
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url === "/api/libs/symbols") return ok({ libraries: [] });
    if (url === "/api/libs/footprints") return ok({ libraries: [{ name: "Lib" }] });
    if (url === "/api/libs/lookup") return ok({ symbols: {}, footprints: { "Lib:A": { library: true, footprint: '(footprint "A")' }, "Lib:B": { library: true, footprint: '(footprint "B")' }, "Lib:Gone": { library: true } } });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const doc = K.parseDoc('(kicad_pcb (version 20241229) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ' +
    '(footprint "Lib:A" (layer "F.Cu") (uuid "fa") (at 10 10)) (footprint "Lib:B" (layer "F.Cu") (uuid "fb") (at 20 20)) (footprint "Lib:Gone" (layer "F.Cu") (uuid "fg") (at 30 30)) (footprint "Nope:X" (layer "F.Cu") (uuid "fn") (at 40 40)) (footprint "NoNick" (layer "F.Cu") (uuid "fx") (at 50 50)))');
  const diff = (a, b, drc) => { assert.strictEqual(drc, true); return K.str(a[1]) === "Lib:B" ? ["Pad count differs."] : []; };
  const r = await DL.libraryParityMarkers(doc, [], () => "warning", diff);
  assert.deepStrictEqual(r.markers.map((m) => `${m.code} ${m.text}`).sort(), [
    "lib_footprint_issues Footprint 'Gone' not found in library 'Lib'",
    "lib_footprint_issues The current configuration does not include the footprint library 'Nope'",
    "lib_footprint_mismatch Footprint 'B' does not match copy in library 'Lib'"]);
  const none = await DL.libraryParityMarkers(doc, [], () => "ignore", diff);
  assert.deepStrictEqual(none.markers, []);
  globalThis.fetch = async () => { throw new Error("offline"); };
  const off = await DL.libraryParityMarkers(doc, [], () => "warning", diff);
  assert.ok(/could not be read/.test(off.skipped));
});

test("DRC library parity: COMPARE_FLAGS::DRC leaves out attributes and overrides", () => {
  const fpd = src("tools", "pcb-tools", "fp-diff.ts");
  assert.ok(/if \(!drc\) for \(const \[k, l\] of ATTR_FLAGS\)/.test(fpd) && /if \(!drc\) for \(const \[k, msg\] of OVERRIDES\)/.test(fpd) && /if \(out\.length \|\| drc\) return out;/.test(fpd));
  assert.ok(/libraryParityMarkers\(doc, projectDocs\(\)/.test(src("editor", "pcbdialogs", "inspect.ts")));
});


// ---------------------------------------------------------------- Rescue Symbols
const RS = load("editor", "rescue-symbols-logic.ts");
const CACHE_LIB = [
  "EESchema-LIBRARY Version 2.4", "#encoding utf-8", "#", "# Device-R", "#",
  "DEF Device-R R 0 0 N Y 1 F N",
  'F0 "R" 80 0 50 V V C CNN', 'F1 "Device-R" 0 0 50 V V C CNN', 'F2 "" -70 0 50 V I C CNN', 'F3 "" 0 0 50 H I C CNN', 'F4 "1%" 0 -200 50 H V L BIN "Tol"',
  "$FPLIST", " R_*", "$ENDFPLIST",
  "DRAW", "A 0 0 100 0 900 0 1 0 N 100 0 0 100", "S -40 -100 40 100 0 1 10 f", "X ~ 1 0 150 50 D 50 50 1 1 P", "X ~CLK 2 0 -150 50 U 50 50 1 1 I CI", "ENDDRAW",
  "ENDDEF",
  "DEF ~Mine-X U 0 40 Y Y 2 L N", 'F0 "U" 0 0 50 H V C CNN', 'F1 "Mine-X" 0 0 50 H V C CNN', 'F2 "" 0 0 50 H I C CNN', 'F3 "" 0 0 50 H I C CNN',
  "ALIAS Mine-Y", "DRAW", "X A 1 -200 0 100 R 50 50 1 1 W N", "X B 1 -200 0 100 R 50 50 2 1 W N", "T 0 0 0 50 0 1 1 Hello Normal 0 C C", "ENDDRAW", "ENDDEF", "#End Library"].join("\n");
const CACHE_DCM = "EESchema-DOCLIB  Version 2.0\n#\n$CMP Device-R\nD Resistor\nK R res\nF ~\n$ENDCMP\n#\n#End Doc Library\n";

test("rescue: the legacy cache library reader gives the symbols SCH_IO_KICAD_SEXPR writes", () => {
  const lib = RS.parseLegacyLibrary(CACHE_LIB, CACHE_DCM);
  assert.deepStrictEqual(Array.from(lib.keys()).sort(), ["Device-R", "Mine-X", "Mine-Y"]);
  const r = RS.legacySymbolNode(lib.get("Device-R"));
  const prop = (n, name) => K.kids(n, "property").find((p) => p[1] === name);
  assert.strictEqual(prop(r, "Value")[2], "Device-R");
  assert.deepStrictEqual(prop(r, "Reference").slice(2, 4), ["R", ["at", 2.032, 0, 90]]);
  assert.ok(K.kid(prop(r, "Footprint"), "hide"), "an invisible field is hidden");
  assert.strictEqual(prop(r, "Tol")[2], "1%");
  assert.ok(/\(justify left bottom\)/.test(K.serialize(prop(r, "Tol"))) && /\(italic yes\)/.test(K.serialize(prop(r, "Tol"))));
  assert.strictEqual(prop(r, "Description")[2], "Resistor", "the .dcm description");
  assert.strictEqual(prop(r, "ki_keywords")[2], "R res");
  assert.strictEqual(prop(r, "ki_fp_filters")[2], "R_*");
  assert.ok(/\(pin_numbers \(hide yes\)\)/.test(K.serialize(r)) && /\(pin_names \(offset 0\)\)/.test(K.serialize(r)));
  const u = K.kids(r, "symbol"); assert.deepStrictEqual(u.map((x) => x[1]), ["Device-R_0_1", "Device-R_1_1"]);
  const arc = K.kid(u[0], "arc");
  assert.deepStrictEqual([K.kid(arc, "start").slice(1), K.kid(arc, "mid").slice(1), K.kid(arc, "end").slice(1)], [[0, 2.54], [1.7961, 1.7961], [2.54, 0]], "MapAnglesV6 swaps the ends of a legacy arc");
  assert.strictEqual(K.kid(K.kid(u[0], "rectangle"), "fill")[1][1], "background");
  const pins = K.kids(u[1], "pin");
  assert.deepStrictEqual(pins.map((p) => [p[1], p[2], K.kid(p, "at").slice(1), K.kid(p, "number")[1], K.kid(p, "name")[1]]),
    [["passive", "line", [0, 3.81, 270], "1", "~"], ["input", "inverted_clock", [0, -3.81, 90], "2", "~{CLK}"]]);
  const x = RS.legacySymbolNode(lib.get("Mine-X"));
  assert.strictEqual(prop(x, "Value")[2], "Mine-X");
  assert.ok(prop(x, "ki_locked") && K.kid(K.kids(x, "symbol").find((s) => s[1] === "Mine-X_1_1"), "text"));
  assert.ok(K.kid(K.kids(K.kids(x, "symbol").find((s) => s[1] === "Mine-X_1_1"), "pin")[0], "hide"), "pin flag N hides the pin");
  const y = RS.legacySymbolNode(lib.get("Mine-Y"));
  assert.strictEqual(prop(y, "Value")[2], "Mine-Y", "an alias is its parent with its own value");
  assert.strictEqual(K.kids(y, "symbol").length, K.kids(x, "symbol").length);
  assert.throws(() => RS.parseLegacyLibrary("EESchema-LIBRARY Version 2.4\nDEF A U 0 40 Y Y 1 F N\nDRAW\nQ 1\nENDDRAW\nENDDEF\n"), /undefined DRAW entry/);
});

const RLIB = (name, pins) => K.parse(`(symbol "${name}" (property "Reference" "R" (at 0 0 0)) (property "Value" "R" (at 0 0 0)) (symbol "${name.split(":").pop()}_1_1" ${pins.map(([n, nm, x, y, a]) => `(pin passive line (at ${x} ${y} ${a}) (length 1.27) (name "${nm}" (effects (font (size 1.27 1.27)))) (number "${n}" (effects (font (size 1.27 1.27)))))`).join(" ")}))`);
test("rescue: PinsConflictWith tests number, name, type and orientation at each pin's place, never the length", () => {
  const a = RLIB("R", [["1", "~", 0, 3.81, 270], ["2", "~", 0, -3.81, 90]]);
  assert.strictEqual(RS.pinsConflictWith(a, RLIB("R", [["2", "~", 0, -3.81, 90], ["1", "~", 0, 3.81, 270]]), true, true, true, true, false), false);
  assert.strictEqual(RS.pinsConflictWith(a, RLIB("R", [["1", "~", 0, 3.81, 270], ["2", "X", 0, -3.81, 90]]), true, true, true, true, false), true);
  assert.strictEqual(RS.pinsConflictWith(a, RLIB("R", [["1", "~", 0, 3.81, 270]]), true, true, true, true, false), true);
  assert.strictEqual(RS.pinsConflictWith(RLIB("R", [["1", "~", 0, 3.81, 270]]), a, true, true, true, true, false), false, "only this symbol's pins need a match");
});

test("rescue: FindRescues over the cache and the library table, the action texts and the rescued library", () => {
  const cache = RS.parseLegacyLibrary(CACHE_LIB, CACHE_DCM);
  const cacheFind = (n) => (cache.has(n) ? RS.legacySymbolNode(cache.get(n)) : null);
  const libR = RLIB("Device:R", [["1", "~", 0, 3.81, 270], ["2", "~", 0, -3.81, 90]]);
  const libs = { "Device:R": libR, "Device:C": RLIB("Device:C", []), "Dev:A<B": RLIB("Dev:A<B", []) };
  const libFind = (id) => (libs[id] ? { symbol: libs[id], root: libs[id] } : null);
  const sym = (id, docId = "d", uid = id) => ({ docId, id: uid, libId: id, unit: 1, bodyStyle: 1, node: K.parse(`(symbol (lib_id "${id}") (property "Reference" "R1") (property "Value" "v"))`) });
  const list = [sym("Mine:X"), sym("Device:R"), sym("Device:R", "e", "r2"), sym("Device:C"), sym("Gone:Y"), sym("Dev:A<B")];
  const symbols = list.sort((a, b) => (a.libId < b.libId ? -1 : 1));
  // the cache's R has a clock pin the library lacks: a modified symbol
  let c = RS.findRescues(symbols, cacheFind, libFind, "proj-rescue");
  assert.deepStrictEqual(c.map((x) => [x.requestedId, x.newId]), [["Dev:A<B", "proj-rescue:A{lt}B-Dev"], ["Device:R", "proj-rescue:R-Device"], ["Mine:X", "proj-rescue:X-Mine"]]);
  assert.deepStrictEqual(c.map(RS.actionDescription), ["Rescue modified symbol Dev:A<B to proj-rescue:A<B-Dev", "Rescue modified symbol Device:R to proj-rescue:R-Device", "Rescue symbol Mine:X found only in cache library to proj-rescue:X-Mine."]);
  assert.strictEqual(RS.actionDescription({ requestedId: "Gone:Y", newId: "p:Y-Gone", cache: null, lib: null }), "Cannot rescue symbol Y which is not available in any library or the cache.");
  // the cache's symbol is what gets rescued, renamed with its units
  const n = RS.rescuedSymbol(c[1]);
  assert.strictEqual(n[1], "R-Device"); assert.deepStrictEqual(K.kids(n, "symbol").map((s) => s[1]), ["R-Device_0_1", "R-Device_1_1"]);
  const text = RS.rescueLibraryText('(kicad_symbol_lib (version 20241209) (generator "x") (symbol "Old" (symbol "Old_1_1")))', [n]);
  assert.ok(/\(symbol "Old"/.test(text) && /\(symbol "R-Device"/.test(text) && /^\(kicad_symbol_lib/.test(text));
  assert.deepStrictEqual(RS.instanceRows(symbols, "Device:R", "/x"), [["R1", "v"], ["R1", "v"]]);
  assert.strictEqual(RS.removeDuplicates(c.concat(c)).length, 3);
  // with the library's pins the same the R needs no rescue
  libs["Device:R"] = RS.legacySymbolNode(cache.get("Device-R"));
  c = RS.findRescues(symbols, cacheFind, libFind, "proj-rescue");
  assert.deepStrictEqual(c.map((x) => x.requestedId), ["Dev:A<B", "Mine:X"]);
  // the menu entry runs the tool
  assert.ok(/rescueSymbols: \(\) => \{ void rescueSymbolsTool\(\); \}/.test(src("editor", "menu-actions.ts")));
  const dlg = src("editor", "rescue-symbols.ts");
  assert.ok(/"This project has nothing to rescue\."/.test(dlg) && /"No symbols were rescued\."/.test(dlg) && /okLabel: "Rescue Symbols", cancelLabel: "Skip Symbol Rescue"/.test(dlg));
});


// ---------------------------------------------------------------- STEP / GLB / … export
const KJ = load("editor", "kicad-jobs-logic.ts");
test("3D export: DIALOG_EXPORT_STEP's formats, file extensions and kicad-cli options", () => {
  assert.deepStrictEqual(KJ.STEP_FORMATS.map((f) => f.cmd), ["step", "glb", "xao", "brep", "ply", "stl", "stpz", "u3d", "3dpdf"]);
  assert.strictEqual(KJ.stepFormatOfName("out/board.STP"), 0);
  assert.strictEqual(KJ.stepFormatOfName("board.glb"), 1);
  assert.strictEqual(KJ.stepFormatOfName("board.pdf"), 8);
  assert.strictEqual(KJ.stepFormatOfName("board"), -1);
  assert.strictEqual(KJ.withStepExtension("dir.v2/board", 1), "dir.v2/board.glb");
  assert.strictEqual(KJ.withStepExtension("board.step", 5), "board.stl");
  const body = KJ.stepJobBody(Object.assign({}, KJ.STEP_DEFAULTS, { format: 1, origin: "center", components: true, componentMode: "selected", tolerance: 2, optimizeStep: false, exportBody: false }), [12.5, 30], ["R1", "U2"]);
  assert.deepStrictEqual([body.job, body.format, body.origin, body.userOriginX, body.userOriginY, body.componentFilter, body.minDistance, body.noOptimizeStep, body.noBoardBody, body.substModels],
    ["3d", "glb", "user", 12.5, 30, "R1,U2", 0.1, true, true, true]);
  const d = KJ.stepJobBody(KJ.STEP_DEFAULTS, [0, 0], ["R1"]);
  assert.deepStrictEqual([d.origin, d.componentFilter, d.minDistance, d.noComponents], ["drill", "", 0.001, false]);
  const doc = K.parseDoc('(kicad_pcb (version 20241229) (generator "t") (footprint "R" (layer "F.Cu") (at 0 0) (model "${KICAD9_3DMODEL_DIR}/R.3dshapes/R.wrl" (scale (xyz 2 1 1)))) (footprint "C" (layer "F.Cu") (at 5 0) (model "x.step" (scale (xyz 1 1 1)))))');
  assert.deepStrictEqual(KJ.scaledModels(doc), ["${KICAD9_3DMODEL_DIR}/R.3dshapes/R.wrl"]);
  assert.ok(/exportSTEP: \(\) => \{/.test(src("editor", "menu-actions.ts")) && /okLabel: "Export", cancelLabel: "Close"/.test(src("editor", "kicad-jobs.ts")));
});

// ---------------------------------------------------------------- File > Import > Netlist...
const INL = load("editor", "pcbdialogs", "import-netlist-logic.ts");
test("import netlist: GuessNetlistFileType, KIID::FromName and the KiCad netlist parser", () => {
  assert.strictEqual(INL.guessNetlistFileType("(export (version \"E\")"), "KICAD");
  assert.strictEqual(INL.guessNetlistFileType("# EESchema Netlist Version 1.1\n("), "LEGACY");
  assert.strictEqual(INL.guessNetlistFileType("( { OrCAD"), "ORCAD");
  assert.strictEqual(INL.guessNetlistFileType("garbage"), "UNKNOWN");
  assert.strictEqual(INL.kiidFromName("/abc/def"), "ce95d26d-6f4b-5e88-be75-a777610fba1d", "the RFC 4122 v5 uuid of the name");
  assert.strictEqual(INL.deriveGroupUuid("/ABC/DEF"), "ce95d26d-6f4b-5e88-be75-a777610fba1d");
  const text = `(export (version "E")
  (components
    (comp (ref "R1") (value "10k") (footprint "Resistor_SMD:R_0603")
      (fields (field (name "Footprint") "Resistor_SMD:R_0603") (field (name "MPN") "RC0603"))
      (libsource (lib "Device") (part "R") (description ""))
      (property (name "Sheetname") (value "Root")) (property (name "Sheetfile") (value "a.kicad_sch")) (property (name "dnp"))
      (sheetpath (names "/") (tstamps "/"))
      (tstamps "AAAA-1"))
    (comp (ref "R2") (value "1k") (footprint "Resistor_SMD:R_0603")
      (sheetpath (names "/sub/") (tstamps "/S1/"))
      (tstamps "bbbb-2")))
  (groups (group (name "G") (uuid "/s1/bbbb-2") (members (member (uuid "/s1/bbbb-2")))))
  (nets
    (net (code "1") (name "VCC") (node (ref "R1") (pin "1") (pintype "passive")) (node (ref "R2") (pin "1")))
    (net (code "2") (name "") (node (ref "R1") (pin "2") (pinfunction "B")))
    (net (code "0") (name "X") (node (ref "R2") (pin "2")))))`;
  const r = INL.readNetlistFile(text, "a.net");
  assert.ok(r.netlist, JSON.stringify(r.error));
  const [r1, r2] = r.netlist.components;
  assert.deepStrictEqual([r1.ref, r1.value, r1.footprint, r1.libId, r1.paths, r1.fields, r1.sheetName, r1.sheetFile, r1.dnp], ["R1", "10k", "Resistor_SMD:R_0603", "Device:R", ["/aaaa-1"], { MPN: "RC0603" }, "/", "a.kicad_sch", true]);
  assert.deepStrictEqual(r2.paths, ["/s1/bbbb-2"]);
  assert.deepStrictEqual(r1.pins.get("2"), { net: "N-000002", name: "B", type: "" }, "an unnamed net takes its dummy name");
  assert.strictEqual(r2.pins.has("2"), false, "net code 0 is not a net");
  assert.deepStrictEqual(r2.group, { uuid: INL.kiidFromName("/s1/bbbb-2"), name: "G" });
  assert.ok(INL.readNetlistFile("(export (components (comp (ref \"R1\") (footprint \"a\\\"b\"))))", "b.net").error.startsWith("Error loading netlist.\n"));
  assert.strictEqual(INL.readNetlistFile("hello", "c.txt").error, "Cannot open netlist file 'c.txt'.");
});
test("import netlist: the legacy reader, the dialog and its menu entry", () => {
  const legacy = ["# EESchema Netlist Version 1.1 created  1/1/2020", "(", " ( /5E1C2A3B $noname  R1 10k {Lib=R}", "  (    1 VCC )", "  (    2 ? )", " )", " ( /5E1C2A3C Lib:FP  C1 1u {Lib=C}", "  (    1 VCC )", " )", ")",
    "{ Allowed footprints by component:", "$component R1", " R_*", " Resistor*", "$endlist", "$endfootprintlist", "}"].join("\n");
  const r = INL.readNetlistFile(legacy, "old.net");
  assert.ok(r.netlist, JSON.stringify(r.error));
  const [a, b] = r.netlist.components;
  assert.deepStrictEqual([a.ref, a.footprint, a.paths, a.pins.get("1").net, a.pins.get("2").net, a.fpFilters], ["R1", "", ["/5e1c2a3b"], "VCC", "", "R_* Resistor*"]);
  assert.deepStrictEqual([b.ref, b.footprint, b.value], ["C1", "Lib:FP", "1u"]);
  assert.deepStrictEqual(r.netlist.nets.get("VCC"), [{ ref: "R1", pin: "1" }, { ref: "C1", pin: "1" }]);
  const dlg = src("editor", "pcbdialogs", "import-netlist.ts");
  for (const s of ["Link footprints using component tstamps (unique ids)", "Link footprints using reference designators", "Delete footprints with no components in netlist", "Replace footprints with those specified in netlist",
    "Group footprints based on symbol group", "Delete/replace footprints even if locked", "Load and Test Netlist", "Please choose a valid netlist file.", "Changes Applied to PCB", "Using tstamps (unique IDs) to match symbols and footprints."]) assert.ok(dlg.includes(s), s);
  assert.ok(/action\("importNetlist", "Netlist\.\.\.", ""/.test(src("editor", "pcbdialogs", "index.ts")));
});

// ---------------------------------------------------------------- Generate Legacy BOM (DIALOG_BOM)
const BL = load("dialogs", "bom-legacy-logic.ts"), NKX = load("sim", "netlist-kicad.ts");
const BOM_SCRIPTS = path.join(__dirname, "..", "..", "plugins", "python", "kicad_bom_generators");
const stockBom = () => new Map(fs.readdirSync(BOM_SCRIPTS).filter((f) => f.endsWith(".py")).map((f) => [BL.STOCK_PLUGINS + "/" + f, fs.readFileSync(path.join(BOM_SCRIPTS, f), "utf8")]));
test("legacy BOM: BOM_GENERATOR_HANDLER's header, command line and output extension, MakeCommandLine, the wxExecute split", () => {
  const files = stockBom();
  const g = BL.generatorHandler("bom_csv_grouped_by_value.py", files);
  assert.ok(g.ok);
  assert.strictEqual(g.file, "/usr/share/kicad/plugins/bom_csv_grouped_by_value.py", "a relative path is found in the stock plugins folder");
  assert.strictEqual(g.cmd, 'python "/usr/share/kicad/plugins/bom_csv_grouped_by_value.py" "%I" "%O.csv"');
  assert.ok(g.info.startsWith("    Output: CSV (comma-separated)\n"), JSON.stringify(g.info.slice(0, 40)));   // readHeader skips the line break only
  assert.strictEqual(BL.generatorHandler("bom_html_with_advanced_grouping.py", files).cmd.endsWith('"%O.html"'), true);
  const gone = BL.generatorHandler("nope.py", files);
  assert.deepStrictEqual([gone.ok, gone.info], [false, "Script file:\nnope.py\nnot found. Script not available."]);
  const rows = BL.installGenerators([...BL.DEFAULT_BOM_PLUGINS, { name: "mine", path: "/x/mine.py", command: "python x" }], files);
  assert.deepStrictEqual(rows.map((r) => r.label), ["bom_csv_grouped_extra", "bom_csv_grouped_by_value", "bom_csv_grouped_by_value_with_fp", "mine (file missing)"]);
  assert.strictEqual(rows[3].gen.cmd, "python x");
  assert.strictEqual(BL.makeCommandLine('python "%P/a.py" "%I" "%O.csv" %B', "/p/s.xml", "/p/s", "/p"), 'python "/p/a.py" "/p/s.xml" "/p/s.csv" s');
  assert.deepStrictEqual(BL.splitCommandLine(`python "/a b/c.py" '/x y' plain\\ sp ""`), ["python", "/a b/c.py", "/x y", "plain sp", ""]);
  assert.deepStrictEqual(BL.resolveCommand(["python3", "/usr/share/kicad/plugins/bom_csv_sorted_by_ref.py", "i", "o"], files), { script: "/usr/share/kicad/plugins/bom_csv_sorted_by_ref.py", args: ["i", "o"] });
  assert.ok(/only Python generator scripts/.test(BL.resolveCommand(["xsltproc", "-o", "x"], files).error));
  assert.deepStrictEqual(BL.runReport("cmd", 2, "a\n", "b\nc\n").map((l) => l.severity + ":" + l.text), ["action:cmd", "error:Command error. Return code 2.", "info:a", "error:b", "error:c"]);
});

function bomProject(edit) {
  const QA = path.join(__dirname, "..", "..", "..", "qa", "data", "cli", "basic_test");
  const files = new Map();
  const loadFile = (f) => {
    if (files.has(f)) return files.get(f);
    const p = path.join(QA, f); if (!fs.existsSync(p)) return null;
    let t = fs.readFileSync(p, "utf8"); if (edit) t = edit(t);
    const r = { doc: K.parseDoc(t, "kicad_sch"), uuid: String((K.kid(K.parse(t), "uuid") || [])[1]), file: f }; files.set(f, r); return r;
  };
  const root = loadFile("basic_test.kicad_sch");
  const helpers = { symbolPins: _.symbolPins, isPower: (d, it) => _.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
  const nl = K.pcbNetlist.buildNetlist(root, (f) => loadFile(f), helpers, "basic_test");
  return { sheets: NKX.nlSheets(nl.instances, (f) => (loadFile(f) || {}).doc || null), netlist: nl, source: "/p/basic_test.kicad_sch", date: "d", version: "10.0" };
}
test("legacy BOM: the intermediate XML netlist (GNL_OPT_BOM) as wxXmlDocument writes it, the BOM exclusions left out", () => {
  const x = NKX.xmlNetlist(bomProject());
  assert.ok(x.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<export version="E">\n  <design>\n    <source>/p/basic_test.kicad_sch</source>\n'), x.slice(0, 200));
  assert.ok(x.includes('        <comment number="1" value=""/>\n'));
  assert.ok(x.includes('    <comp ref="C1">\n      <value>10u</value>\n'));
  assert.ok(x.includes('<net code="1" name="/IN" class="Default">'));
  assert.ok(!x.includes("<groups") && !x.includes("<variants"), "no groups or variants sections");
  assert.ok(x.endsWith("</export>\n"));
  assert.ok(/<node ref="R1"/.test(x));
  // R1 out of the BOM: no component, none of its pins on the nets
  const y = NKX.xmlNetlist(bomProject((t) => t.replace(/(\(symbol \(lib_id "Device:R_US"\) \(at 127 93\.98 90\) \(unit 1\)\s*)\(in_bom yes\)/, "$1(in_bom no)")));
  assert.ok(!/<comp ref="R1">/.test(y) && !/<node ref="R1"/.test(y), "R1 is left out");
  assert.ok(/<comp ref="C1">/.test(y));
  // the board netlist keeps it
  assert.ok(/\(comp\s+\(ref "R1"\)/.test(NKX.kicadNetlist(bomProject((t) => t.replace(/(\(symbol \(lib_id "Device:R_US"\) \(at 127 93\.98 90\) \(unit 1\)\s*)\(in_bom yes\)/, "$1(in_bom no)")))));
});
test("legacy BOM: KiCad's bom_csv_grouped_by_value.py run in Pyodide over the XML netlist", async () => {
  const pdir = path.join(__dirname, "..", "..", "node_modules", "pyodide");
  if (!fs.existsSync(path.join(pdir, "pyodide.asm.wasm"))) { console.log("  (skipped: no node_modules/pyodide)"); return; }
  const { loadPyodide } = require(path.join(pdir, "pyodide.js"));
  const py = await loadPyodide({ indexURL: pdir + "/" });
  py.FS.mkdirTree(BL.STOCK_PLUGINS);
  for (const [p, t] of stockBom()) py.FS.writeFile(p, t);
  py.runPython(BL.RUNNER_PY);
  const cwd = BL.PROJECT_DIR; py.FS.mkdirTree(cwd);
  py.FS.writeFile(cwd + "/basic_test.xml", NKX.xmlNetlist(bomProject()));
  const g = BL.generatorHandler("bom_csv_grouped_by_value.py", stockBom());
  const argv = BL.splitCommandLine(BL.makeCommandLine(g.cmd, cwd + "/basic_test.xml", cwd + "/basic_test", cwd));
  const how = BL.resolveCommand(argv, stockBom());
  const run = py.globals.get("_kc_bom_run");
  const res = run(how.script, py.toPy(how.args), cwd).toJs();
  assert.strictEqual(res[0], 0, res[2]);
  const csv = py.FS.readFile(cwd + "/basic_test.csv", { encoding: "utf8" });
  assert.ok(/"Source:","\/p\/basic_test\.kicad_sch"/.test(csv), csv.slice(0, 300));
  assert.ok(/"Component Count:","9"/.test(csv), csv);
  assert.ok(/"C1","10u"/.test(csv.replace(/"[0-9]+","[0-9]+",/g, "")) || /C1/.test(csv));
  // a script that fails: its traceback and status 1
  py.FS.writeFile("/tmp/bad.py", "import sys\nprint('out')\nraise ValueError('boom')\n");
  const bad = run("/tmp/bad.py", py.toPy([]), cwd).toJs();
  assert.deepStrictEqual([bad[0], bad[1]], [1, "out\n"]);
  assert.ok(/ValueError: boom/.test(bad[2]));
  const ex = run("/tmp/bad2.py", py.toPy([]), cwd).toJs();
  assert.strictEqual(ex[0], 1);
  assert.ok(/if \(E\.kdoc && isSch\(\)\) \{ void openBomLegacy\(\); return; \}/.test(src("dialogs", "index.ts")));
});

// ---------------------------------------------------------------- File > Export > Hyperlynx
const QA_PCB = path.join(__dirname, "..", "..", "..", "qa", "data", "pcbnew");
test("Hyperlynx: header, board, stackup, devices, per-layer padstacks (test_complex_padstack_export.cpp), nets", () => {
  const FAB = load("fab", "index.ts");
  const hypOf = (file) => { const text = fs.readFileSync(path.join(QA_PCB, file), "utf8"); return FAB.reports.hyperlynx({ doc: K.parseDoc(text, "kicad_pcb"), setup: text }, file); };
  const capture = (t, re) => new Set([...t.matchAll(re)].map((m) => m[1]));
  // HyperlynxEmitsShapePerLayer: pad 3's four sizes, one per copper layer
  const a = hypOf("padstacks_complex.kicad_pcb").text;
  assert.ok(a.startsWith('{VERSION=2.14}\n{UNITS=ENGLISH LENGTH}\n\n{BOARD "padstacks_complex.kicad_pcb"\n'), a.slice(0, 120));
  assert.ok(capture(a, /\("[^"]+", [0-9]+, ([0-9.]+),/g).size >= 4, "at least 4 distinct pad sizes");
  assert.ok(capture(a, /\("([^"]+)", [0-9]+, [0-9.]+,/g).size >= 4, "per-layer entries rather than one MDEF");
  assert.ok(/\{STACKUP\n  \(DIELECTRIC T=0\.000393701 C=3\.3 L="[^"]+" M="Solder Mask"\)\n  \(SIGNAL T=0\.00137795 P=0 C=1\.724e-08 L="[^"]+" M=COPPER\)\n  \(DIELECTRIC T=[0-9.e+-]+ C=[0-9.]+ L="DE_/.test(a), a.slice(a.indexOf("{STACKUP"), a.indexOf("{STACKUP") + 200));
  // HyperlynxOmitsDrillOnSmdPadstacks
  const b = hypOf("api_kitchen_sink.kicad_pcb").text;
  assert.ok(b.includes("{PADSTACK="));
  assert.ok(!capture(b, /\{PADSTACK=[0-9]+, ([0-9.]+)/g).has("0.000000000"), "a hole-less padstack has no drill");
  assert.ok(/\{PADSTACK=\d+\n/.test(b), "an SMD padstack without its drill");
  assert.ok(/\{DEVICES\n  \(\? REF="[^"]+" L="[FB]\.Cu"\)\n/.test(b));
  assert.ok(/\{NET="[^"]+"\n  \((PIN|SEG|VIA|ARC) /.test(b));
  assert.ok(/\(PIN X=-?[0-9]+\.[0-9]{10} Y=-?[0-9]+\.[0-9]{10} R="[^"]+\.[^"]+" P=\d+\)/.test(b));
  // %g
  assert.deepStrictEqual([FAB_G(0.0013779527559055118), FAB_G(1.724e-8), FAB_G(4.5), FAB_G(0), FAB_G(123456789)], ["0.00137795", "1.724e-08", "4.5", "0", "1.23457e+08"]);
  assert.ok(/exportHyperlynx", "Hyperlynx\.\.\."/.test(src("editor", "pcbdialogs", "index.ts")));
});
const FAB_G = (v) => load("fab", "hyperlynx.ts").fmtG(v);

// ---------------------------------------------------------------- File > Import > Specctra Session
test("Specctra session: the reader, FromSESSION's placement, wires, vias and skips (test_specctra_export.cpp)", () => {
  require(path.join(__dirname, "..", "pcb-tools.js"));
  const SS = load("editor", "pcbdialogs", "specctra-session-logic.ts"), FPT = globalThis.PcbTools;
  const boardText = fs.readFileSync(path.join(QA_PCB, "..", "cli", "basic_test", "basic_test.kicad_pcb"), "utf8");
  const doc = K.parseDoc(boardText, "kicad_pcb");
  let uid = 0;
  const env = { copper: ["F.Cu", "B.Cu"], layerName: (l) => l, hasNet: (n) => [...doc.nets.values()].includes(n), netNode: (n) => ["net", n], defaultViaDrill: 0.3,
    viaDrillFor: (net, micro) => (micro ? 0.1 : 0.3), newUuid: () => "u" + (++uid), flip: FPT.flipFootprintNode, rotate: FPT.rotateFootprintNode, setPosition: (n, x, y) => { const at = K.kid(n, "at"); at[1] = x; at[2] = y; } };
  const run = (ses) => SS.fromSession(doc.items.values(), SS.parseSession(ses, "t.ses"), env);
  // qa/data/pcbnew/specctra/basic_test.ses (a # comment first)
  const basic = run(fs.readFileSync(path.join(QA_PCB, "specctra", "basic_test.ses"), "utf8"));
  const tracks = [...doc.items.values()].filter((it) => it.kind === "segment" || it.kind === "arc" || it.kind === "via");
  assert.strictEqual(basic.removed.length, tracks.filter((it) => !/\(locked/.test(K.serialize(it.node))).length, "every unlocked track and via is removed");
  assert.deepStrictEqual(basic.added.map((n) => K.serialize(n)), ['(segment (start 50 0) (end 150 0) (width 0.16) (layer "F.Cu") (net "GND") (uuid "u1"))'.replace(/"(\w)/g, (m) => m)].map((x) => K.serialize(K.parse(x))));
  const j1 = [...doc.items.values()].find((it) => it.kind === "footprint" && /\(fp_text reference "J1"/.test(K.serialize(it.node)));
  assert.deepStrictEqual(K.atOf(basic.modified.get(j1.id)).slice(0, 2), [0, 0], "J1 placed at the origin");
  // SpecctraImportSkipsInvalidWireLayer: the bogus layer and the unknown reference are skipped, not fatal
  const skip = run('(session test.ses (base_design test.dsn) (placement (resolution um 10) (component test (place Nonexistent_Ref 0 0 front 0))) (routes (resolution um 10) (library_out ) (network_out (net "GND" (wire (path "F.Cu" 1600  0 0  1000 0)) (wire (path Bogus_Missing_Layer 1600  0 0  1000 1000))))))');
  assert.deepStrictEqual([skip.added.length, skip.skipped], [1, 2]);
  // a poly wire is a zone fill: ignored; (type fix) locks; vias from the library's padstack with the drill in its name
  const v = run('(session s (base_design d) (routes (resolution mil 10) (parser (string_quote ") (space_in_quoted_tokens on) (host_cad "KiCad") (host_version "10")) (library_out (padstack "Via[0-1]_800:400_um" (shape (circle F.Cu 315)) (shape (circle B.Cu 315)) (attach off)) (padstack "Via[0-1]_600:300_um" (shape (circle F.Cu 236)) (shape (circle B.Cu 236)))) (network_out (net GND (wire (poly F.Cu 0 0 0 10 0 10 10 0 0)) (wire (path B.Cu 100 0 0 100 0) (type fix)) (via "Via[0-1]_800:400_um" 100 -100 200 -200) (via "Via[0-1]_600:300_um" 0 0) (via Missing 0 0)))))');
  assert.strictEqual(v.skipped, 1, "the missing padstack");
  assert.deepStrictEqual(v.added.map((n) => K.serialize(n)), [
    '(segment (start 0 0) (end 0.254 0) (width 0.254) (locked yes) (layer "B.Cu") (net "GND") (uuid "u3"))',
    '(via (at 0.254 0.254) (size 0.8001) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "u4"))',
    '(via (at 0.508 0.508) (size 0.8001) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "u5"))',
    '(via (at 0 0) (size 0.59944) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "u6"))'].map((x) => K.serialize(K.parse(x))));
  // the missing sections and a malformed file
  assert.throws(() => run("(session s (base_design d))"), /Session file is missing the "routes" section/);
  assert.throws(() => run("(session s (routes (resolution um 10)))"), /Session file is missing the "library_out" section/);
  assert.throws(() => run("(session s (routes (frobnicate)))"), /Unexpected 'frobnicate' in input\/source\n't\.ses'\nline 1/);
  assert.ok(/action\("importSpecctraSession", "Specctra Session\.\.\."/.test(src("editor", "pcbdialogs", "index.ts")));
});

// ---------------------------------------------------------------- Tools > Migrate 3D Models
test("Migrate 3D Models: missing WRL references, the STEP catalog, ranking, ShortenPath and the rewrite (dialog_migrate_3d_models.cpp)", () => {
  const MG = load("editor", "pcbdialogs", "migrate-3d-models-logic.ts");
  assert.strictEqual(MG.levenshtein("kitten", "sitting"), 3);
  assert.strictEqual(MG.normalizeStem("R-0603 1608Metric.STEP.gz"), "r_0603_1608metric");
  assert.strictEqual(MG.normalizeStem("x.wrl"), "x");
  assert.strictEqual(MG.parentDirName("${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603.wrl"), "Resistor_SMD.3dshapes");
  assert.ok(MG.isWrlExtension("a.WRZ") && !MG.isWrlExtension("a.step"));
  const fp = (id, models, extra = "") => ({ id, kind: "footprint", node: K.parse(`(footprint "L:${id}" (layer "F.Cu") (at 1 2) ${extra} ${models.map((m) => `(model "${m}" (offset (xyz 0 0 0.5)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))`).join(" ")})`) });
  const items = [
    fp("R1", ["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl"]),
    fp("R2", ["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl", "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"]),
    fp("U1", ["${KIPRJMOD}/3d/part.wrl", "${KIPRJMOD}/3d/Gone-Part.wrl", "kicad-embed://own.wrl", "/opt/models/SOIC-8_3.9x4.9mm.wrl"], '(embedded_files (file (name "own.wrl") (type model) (data |x|)))'),
  ];
  const env = { projectFiles: ["3d/part.wrl", "3d/gone_part.step", "other/R_0603_1608Metric.stp", "readme.txt"], boardEmbedded: [] };
  const byName = MG.collectMissingWrlModels(items, env);
  // sorted by name; the resolving project file, the embedded file and the STEP reference are not missing; one entry per name
  assert.deepStrictEqual([...byName.keys()], ["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl", "${KIPRJMOD}/3d/Gone-Part.wrl", "/opt/models/SOIC-8_3.9x4.9mm.wrl"]);
  assert.strictEqual(byName.get("${KIPRJMOD}/3d/Gone-Part.wrl").fpId, "U1");
  assert.deepStrictEqual(byName.get("${KIPRJMOD}/3d/Gone-Part.wrl").xform, { scale: [1, 1, 1], rotation: [0, 0, 90], offset: [0, 0, 0.5], opacity: 1 });
  const sources = { projectFiles: env.projectFiles, kicadModels: ["Resistor_SMD:R_0603_1608Metric", "Resistor_SMD:R_0805_2012Metric", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "Capacitor_SMD:C_0603_1608Metric"], extraDirs: [] };
  const catalog = MG.buildCatalog(sources);
  // the project's STEP-family files first (${KIPRJMOD}), then KiCad's library; readme and .wrl are not candidates
  assert.deepStrictEqual(catalog.map((e) => e.absPath), ["/home/kicad/project/3d/gone_part.step", "/home/kicad/project/other/R_0603_1608Metric.stp",
    "/usr/share/kicad/3dmodels/Resistor_SMD.3dshapes/R_0603_1608Metric.step", "/usr/share/kicad/3dmodels/Resistor_SMD.3dshapes/R_0805_2012Metric.step",
    "/usr/share/kicad/3dmodels/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step", "/usr/share/kicad/3dmodels/Capacitor_SMD.3dshapes/C_0603_1608Metric.step"]);
  const r = MG.rankCandidatesFor("${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl", catalog);
  // the same stem in the same folder (1000), elsewhere (800), a close stem (500 - 10 per edit; R_0805_2012Metric is 6 edits, past 17 / 4), then "keep existing"
  assert.deepStrictEqual(r.map((c) => [c.display, c.score]), [["R_0603_1608Metric.step   —   Resistor_SMD.3dshapes", 1000], ["R_0603_1608Metric.stp   —   other", 800],
    ["C_0603_1608Metric.step   —   Capacitor_SMD.3dshapes", 490], ["(keep existing reference)", 0]]);
  assert.strictEqual(MG.autoSelect(r), 0);
  const none = MG.rankCandidatesFor("/opt/models/SOIC-8_3.9x4.9mm.wrl", catalog);
  assert.deepStrictEqual([none.length, MG.autoSelect(none)], [1, MG.UNSPECIFIED], "nothing within the edit distance: bold, keep only");
  // STEP_CATALOG::FindMatchFor prefers the same folder
  assert.strictEqual(MG.findMatchFor("${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl", catalog), "/usr/share/kicad/3dmodels/Resistor_SMD.3dshapes/R_0603_1608Metric.step");
  assert.strictEqual(MG.findMatchFor("x/R_0603_1608Metric.wrl", catalog), "/home/kicad/project/other/R_0603_1608Metric.stp");
  // an extra directory already under a search path adds nothing; a user pick goes on top
  const scanned = new Set(MG.scanDirs([]).map((d) => d.toLowerCase())), before = catalog.length;
  MG.scanDirectory("/home/kicad/project/other", sources, catalog, scanned);
  assert.strictEqual(catalog.length, before);
  const missing = [...byName.keys()];
  let cands = missing.map((m) => MG.rankCandidatesFor(m, catalog)), sel = cands.map(MG.autoSelect);
  const inj = MG.injectCandidate(cands[2], "/usr/share/kicad/3dmodels/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step");
  cands[2] = inj.cands; sel[2] = inj.sel;
  assert.deepStrictEqual([cands[2][0].display, cands[2][0].score, sel[2]], ["SOIC-8_3.9x4.9mm_P1.27mm.step   —   user-selected", 2000, 0]);
  sel[1] = MG.KEEP_EXISTING;
  const rr = MG.rerank(missing, catalog, cands, sel);
  assert.deepStrictEqual(rr.sel, [0, MG.KEEP_EXISTING, MG.UNSPECIFIED], "a user pick not in the catalog is lost on re-rank, keep stays");
  // OnReplaceClick: ShortenPath to the aliases, every footprint's reference rewritten
  const repl = MG.replacementsOf(missing, cands, sel);
  assert.deepStrictEqual([...repl.entries()], [["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl", "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"],
    ["/opt/models/SOIC-8_3.9x4.9mm.wrl", "${KICAD10_3DMODEL_DIR}/Package_SO.3dshapes/SOIC-8_3.9x4.9mm_P1.27mm.step"]]);
  assert.strictEqual(MG.shortenPath("/home/kicad/project/3d/gone_part.step"), "${KIPRJMOD}/3d/gone_part.step");
  assert.strictEqual(MG.expandPath("${KIPRJMOD}/3d/gone_part.step"), "/home/kicad/project/3d/gone_part.step");
  const out = MG.applyReplacements(items, repl, (n) => K.parse(K.serialize(n)));
  assert.deepStrictEqual([[...out.modified.keys()], out.rewritten], [["R1", "R2", "U1"], 3]);
  assert.deepStrictEqual(out.modified.get("R2").filter((c) => Array.isArray(c) && c[0] === "model").map((m) => m[1]),
    ["${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step", "${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step"]);
  assert.ok(/\(rotate \(xyz 0 0 90\)\)/.test(K.serialize(out.modified.get("R1"))), "the transform is kept");
  assert.ok(items[0].node.some((c) => Array.isArray(c) && c[0] === "model" && /\.wrl$/.test(c[1])), "the board's nodes are not touched");
  assert.ok(/action\("migrate3DModels", "Migrate 3D Models\.\.\."/.test(src("editor", "pcbdialogs", "index.ts")));
});

module.exports = { test, load, src, K, sch, _ };
// the later sections add their tests below, then the queue runs
setImmediate(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
});
