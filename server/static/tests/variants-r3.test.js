// variants-r3.test.js — design variants, round 3: per-variant pin-to-pad maps resolved in the netlists
// (NETLIST_EXPORTER_BASE::resolvePadNumbers for Update PCB and the KiCad netlist), variant symbols
// (SCH_EDIT_TOOL::SetVariantSymbol's compatibility check and message, the context menu rows, the alternate drawn and
// its fields shown under the variant), ERC_TESTER::TestVariantSymbols in the browser's checks, and Update PCB's
// component classes, nested groups and design-variant registry (BOARD_NETLIST_UPDATER).
// Run: node server/static/tests/variants-r3.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (...rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
const VM = load("domains", "pcb", "canvas", "variant-model.ts");
const CM = load("domains", "pcb", "editor", "ctxmenus.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); } }
console.log("design variants (round 3) under node");

const U_ROOT = "11111111-1111-1111-1111-111111111111";
const F = `(effects (font (size 1.27 1.27)))`;
const pin = (num, x, y, rot, type = "passive") => `(pin ${type} line (at ${x} ${y} ${rot}) (length 1.27) (name "~" ${F}) (number "${num}" ${F}))`;
const libSym = (id, pins, extra = "") => `(symbol "${id}" (property "Reference" "U" (at 0 0 0) ${F}) (property "Value" "${id}" (at 0 0 0) ${F}) ${extra}
  (symbol "${id.split(":")[1]}_1_1" ${pins}))`;
const TWO = pin("1", 0, 3.81, 270) + pin("2", 0, -3.81, 90);
const MAPPED = libSym("Dev:Q", TWO, `(associated_footprints (footprint "Pkg:FP" (map "M1"))) (pin_maps (pin_map "M1" (entry "1" "A") (entry "2" "B")) (pin_map "M2" (entry "1" "B") (entry "2" "A")))`);
const symbol = (ref, x, y, uuid, lib, extra = "", variants = "", fp = "Pkg:FP") => `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) ${extra} (uuid "${uuid}")
  (property "Reference" "${ref}" (at ${x + 2} ${y} 0) ${F}) (property "Value" "v" (at ${x + 2} ${y + 2} 0) ${F}) (property "Footprint" "${fp}" (at ${x} ${y} 0) ${F})
  (pin "1" (uuid "${uuid}-p1")) (pin "2" (uuid "${uuid}-p2"))
  (instances (project "demo" (path "/${U_ROOT}" (reference "${ref}") (unit 1) ${variants}))))`;
const wire = (a, b, id) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const label = (name, at, id) => `(label "${name}" (at ${at[0]} ${at[1]} 0) ${F} (uuid "${id}"))`;
const sheet = (libs, body) => `(kicad_sch (version 20260306) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") (lib_symbols ${libs}) ${body} (sheet_instances (path "/" (page "1"))))`;
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
// Q1 at (100,50): pin 1 (100,46.19) on net TOP, pin 2 (100,53.81) on net BOT
const netlistOf = (extra, pads, variants) => {
  const text = sheet(MAPPED, symbol("Q1", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001", "Dev:Q", extra, variants)
    + wire([100, 40], [100, 46.19], "w1") + label("TOP", [100, 40], "l1") + wire([100, 53.81], [100, 60], "w2") + label("BOT", [100, 60], "l2"));
  const doc = K.parseDoc(text, "kicad_sch");
  return N.buildNetlist({ doc, uuid: U_ROOT, file: "demo.kicad_sch" }, () => null, helpers, "demo", Object.assign(N.netlistOptions(null), { footprintPads: pads }));
};
const padsOf = (nl) => { const c = nl.components.find((x) => x.ref === "Q1"); return [...c.pins].map(([p, v]) => p + "=" + v.net).sort(); };

// ---------------------------------------------------------------- item 1: pin-to-pad maps in the netlists
test("resolvePadNumbers: the library default goes through the footprint's associated map (pin 1 -> A, 2 -> B)", () => {
  const nl = netlistOf("", () => new Set(["A", "B"]));
  assert.deepEqual(padsOf(nl), ["A=/TOP", "B=/BOT"]);
  assert.deepEqual(nl.pinMapFootprints, ["Pkg:FP"], "Update PCB loads the footprint whose pads the map resolves against");
  assert.deepEqual(nl.nets.get("/TOP"), [{ ref: "Q1", pin: "A" }]);
});
test("resolvePadNumbers: a named map override, the identity override and sparse edits", () => {
  assert.deepEqual(padsOf(netlistOf(`(pin_map_override (mode named_map) (map "M2"))`, () => new Set(["A", "B"]))), ["A=/BOT", "B=/TOP"]);
  assert.deepEqual(padsOf(netlistOf(`(pin_map_override (mode identity))`, () => new Set(["1", "2"]))), ["1=/TOP", "2=/BOT"]);
  assert.deepEqual(padsOf(netlistOf(`(pin_map_override (mode library_default) (edit "2" "C"))`, () => new Set(["A", "C"]))), ["A=/TOP", "C=/BOT"]);
});
test("resolvePadNumbers: a pin the map leaves unmapped reaches no pad when the footprint's pads are known", () => {
  // identity forced, but the footprint only has pads A and B: neither pin has an identity pad
  const nl = netlistOf(`(pin_map_override (mode identity))`, () => new Set(["A", "B"]));
  assert.deepEqual(padsOf(nl), []);
  assert.equal(nl.nets.get("/TOP"), undefined);
  // pads unknown: the painter path, the number itself
  assert.deepEqual(padsOf(netlistOf(`(pin_map_override (mode identity))`, () => null)), ["1=/TOP", "2=/BOT"]);
});
test("resolvePadNumbers: Update PCB's netlist reads the default variant's map, not a variant's own", () => {
  const nl = netlistOf("", () => new Set(["A", "B"]), `(variant (name "Alt") (pin_map_override (mode named_map) (map "M2")))`);
  assert.deepEqual(padsOf(nl), ["A=/TOP", "B=/BOT"]);
});
test("pin map overrides: delegation takes unit 1's record; a unit 1 that delegates gives the library default", () => {
  const u1 = K.parse(`(symbol (lib_id "Dev:Q") (unit 1) (pin_map_override (mode named_map) (map "M2")) (uuid "u1") (instances (project "demo" (path "/r" (reference "Q1") (unit 1)))))`);
  assert.equal(VM.delegatedPinMapOverrideOf({ node: u1, path: "/r" }, "").map, "M2");
  const del = K.parse(`(symbol (lib_id "Dev:Q") (unit 1) (pin_map_override (mode delegate)) (uuid "u1"))`);
  assert.equal(VM.delegatedPinMapOverrideOf({ node: del, path: null }, "").mode, "library_default");
  assert.equal(VM.delegatedPinMapOverrideOf(null, "").mode, "library_default");
});
test("pin map overrides: a variant's own record is written after its symbol override and read back", () => {
  const s0 = K.parse(symbol("Q1", 0, 0, "q", "Dev:Q"));
  const o = { mode: "named_map", map: "M2", edits: new Map([["1", "Z"]]) };
  const s1 = VM.setSymbolVariantOverride(s0, "Alt", "Dev:Q2", "/" + U_ROOT, 20260306);
  const s2 = VM.setSymbolPinMapOverride(s1, o, "Alt", "/" + U_ROOT, 20260306);
  const text = K.serialize(s2);
  assert.ok(/\(symbol_override "Dev:Q2"\)\s*\(pin_map_override \(mode named_map\) \(map "M2"\) \(edit "1" "Z"\)\)/.test(text), text);
  const back = VM.symbolPinMapOverride(s2, "Alt", "/" + U_ROOT);
  assert.equal(back.mode, "named_map"); assert.equal(back.edits.get("1"), "Z");
  assert.equal(VM.symbolPinMapOverride(s2, "", "/" + U_ROOT).mode, "library_default", "the base override is untouched");
  assert.equal(VM.effectivePadNumber(K.parse(MAPPED), back, "Pkg:FP", "1").pad, "Z");
  assert.equal(VM.effectivePadNumber(K.parse(MAPPED), back, "Pkg:FP", "2").pad, "A");
});

// ---------------------------------------------------------------- item 2: variant symbols
const BASE = K.parse(libSym("Dev:Q", TWO));
test("ValidateVariantSymbolCompatibility: same pins compatible; position, type, missing and extra pins reported", () => {
  assert.deepEqual(VM.variantSymbolCompatibility(BASE, K.parse(libSym("Dev:Q2", TWO))), []);
  const moved = VM.variantSymbolCompatibility(BASE, K.parse(libSym("Dev:Q3", pin("1", 0, 5.08, 270) + pin("2", 0, -3.81, 90))));
  assert.deepEqual(moved.map((x) => x.detail), ["Unit 1, body style 1: pin '1' position mismatch (0,-38100) vs (0,-50800)"]);
  const typed = VM.variantSymbolCompatibility(BASE, K.parse(libSym("Dev:Q4", pin("1", 0, 3.81, 270, "input") + pin("2", 0, -3.81, 90))));
  assert.equal(typed.length, 1); assert.equal(typed[0].error, "PIN_TYPE_MISMATCH");
  const extra = VM.variantSymbolCompatibility(BASE, K.parse(libSym("Dev:Q5", TWO + pin("3", 2.54, 0, 180))));
  assert.deepEqual(extra.map((x) => x.error), ["EXTRA_PIN_NUMBER"]);
  const missing = VM.variantSymbolCompatibility(BASE, K.parse(libSym("Dev:Q6", pin("1", 0, 3.81, 270))));
  assert.deepEqual(missing.map((x) => x.error), ["MISSING_PIN_NUMBER"]);
});
test("Set Variant Symbol: the override recorded on the instance's variant; Clear Variant Symbol drops it", () => {
  const s0 = K.parse(symbol("Q1", 0, 0, "q", "Dev:Q"));
  const s1 = VM.setSymbolVariantOverride(s0, "Alt", "Dev:Q2", "/" + U_ROOT, 20260306);
  assert.equal(VM.symbolVariantOverride(s1, "Alt", "/" + U_ROOT), "Dev:Q2");
  assert.deepEqual(VM.symbolVariantOverrides(s1), ["Dev:Q2"]);
  const s2 = VM.clearSymbolVariantOverride(s1, "Alt", "/" + U_ROOT, 20260306);
  assert.equal(VM.symbolVariantOverride(s2, "Alt", "/" + U_ROOT), "");
  assert.ok(!K.serialize(s2).includes("(variant"), "a variant left with nothing to differ is dropped");
});
test("variant symbol: the alternate's non-empty fields show under the variant unless the variant overrides them", () => {
  const s1 = VM.setSymbolVariantOverride(K.parse(symbol("Q1", 0, 0, "q", "Dev:Q", "", "", "")), "Alt", "Dev:Q2", "/" + U_ROOT, 20260306);
  const alt = K.parse(`(symbol "Dev:Q2" (property "Reference" "U" (at 0 0 0)) (property "Value" "Q2" (at 0 0 0)) (property "Footprint" "Pkg:Other" (at 0 0 0)) (symbol "Q2_1_1" ${TWO}))`);
  assert.equal(VM.symbolFieldForVariant(s1, "Alt", "/" + U_ROOT, "Footprint", alt), "Pkg:Other");
  assert.equal(VM.symbolFieldForVariant(s1, "", "/" + U_ROOT, "Footprint", alt), "", "the default variant keeps the symbol's own");
  const lib = (id) => (id === "Dev:Q2" ? alt : null);
  assert.equal(VM.variantLibSymbol(s1, "Alt", "/" + U_ROOT, BASE, lib), alt);
  assert.equal(VM.variantLibSymbol(s1, "Other", "/" + U_ROOT, BASE, lib), null);
});
test("context menu: Change Symbol only without a variant; Set / Clear Variant Symbol with one", () => {
  const ctx = (o) => Object.assign({ editor: "sch", kinds: ["symbol"], tool: "select", busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: true, hasItems: true, checks: {} }, o);
  const acts = (o) => { const c = ctx(o); return CM.evaluate(CM.menuFor(c, false), c).filter((e) => e.act).map((e) => e.act.split("::").pop()); };
  const none = acts({});
  assert.ok(none.includes("changeSymbol") && !none.includes("setVariantSymbol") && !none.includes("clearVariantSymbol"));
  const v = acts({ variantActive: true });
  assert.ok(!v.includes("changeSymbol") && v.includes("updateSymbol") && v.includes("setVariantSymbol") && !v.includes("clearVariantSymbol"));
  const both = acts({ variantActive: true, hasVariantSymbol: true });
  assert.ok(both.indexOf("setVariantSymbol") > both.indexOf("updateSymbol") && both.indexOf("clearVariantSymbol") === both.indexOf("setVariantSymbol") + 1, both.join(","));
  const spec = require(webPath("domains", "pcb", "generated", "kicad-context-spec.json")).actions;
  assert.equal(spec["SCH_ACTIONS::setVariantSymbol"].label, "Set Variant Symbol...");
  assert.equal(spec["SCH_ACTIONS::clearVariantSymbol"].label, "Clear Variant Symbol");
});
test("variant symbol: the alternate library symbol is drawn under the variant", () => {
  const ALT = libSym("Dev:Q2", TWO.replace(/\(length 1\.27\)/g, "(length 2.54)"));
  const text = sheet(libSym("Dev:Q", TWO) + ALT, symbol("Q1", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001", "Dev:Q", "", `(variant (name "Alt") (symbol_override "Dev:Q2"))`));
  const doc = K.parseDoc(text, "kicad_sch"), it = doc.items.get("aaaaaaaa-0000-0000-0000-000000000001");
  const geomText = () => JSON.stringify(it.geom);
  doc.instancePath = "/" + U_ROOT;
  doc.variantName = ""; K.buildGeom(doc, it); const base = geomText();
  doc.variantName = "Alt"; K.buildGeom(doc, it); const alt = geomText();
  assert.notEqual(base, alt, "the longer pins of the alternate");
  doc.variantName = "Other"; K.buildGeom(doc, it); assert.equal(geomText(), base);
});

// ---------------------------------------------------------------- item 3: ERC TestVariantSymbols
test("ERC TestVariantSymbols: an alternate no library holds, and one that is not pin-compatible", () => {
  const variants = `(variant (name "B") (symbol_override "Dev:Moved")) (variant (name "A") (symbol_override "Dev:Gone")) (variant (name "C") (symbol_override "Dev:Q"))`;
  const text = sheet(libSym("Dev:Q", TWO), symbol("Q1", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001", "Dev:Q", "", variants));
  const doc = K.parseDoc(text, "kicad_sch");
  const moved = K.parse(libSym("Dev:Moved", pin("1", 0, 5.08, 270) + pin("2", 0, -3.81, 90)));
  const ms = sch.ercCheck(doc, { path: "/" + U_ROOT, variantSymbol: (id) => (id === "Dev:Moved" ? moved : null), silent: true })
    .filter((m) => m.code.startsWith("variant_symbol"));
  assert.deepEqual(ms.map((m) => [m.code, m.severity, m.text]), [
    ["variant_symbol_invalid", "error", "Variant 'A': symbol 'Dev:Gone' not found in libraries"],
    ["variant_symbol_incompatible", "warning", "Variant 'B', alternate 'Dev:Moved': Unit 1, body style 1: pin '1' position mismatch (0,-38100) vs (0,-50800)"]]);
  assert.deepEqual([ms[0].x, ms[0].y], [100, 50], "at the symbol's position");
  const none = sch.ercCheck(doc, { path: "/" + U_ROOT, silent: true }).filter((m) => m.code.startsWith("variant_symbol"));
  assert.equal(none.length, 0, "no library adapter: the test does not run");
});

// ---------------------------------------------------------------- item 4: Update PCB's component classes, groups, variants
test("KIID::FromName: the name-based (SHA-1, version 5) uuid in KiCad's namespace; a group's instance path collapses to it", () => {
  const p = "/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222";
  assert.equal(N.kiidFromName(p), "a2056dbe-33fc-59e1-8781-7cf349ec8e2e");
  assert.equal(N.kiidFromName("/abc"), "985b03e8-19b8-5093-ab82-fecc60c6dfe4");
  assert.equal(N.deriveGroupUuid(p.toUpperCase() + "/"), "a2056dbe-33fc-59e1-8781-7cf349ec8e2e", "KIID_PATH( … ).AsString(): lower case, no trailing slash");
  assert.equal(N.deriveGroupUuid("33333333-3333-3333-3333-333333333333"), "33333333-3333-3333-3333-333333333333");
});
const LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))`;
const bfp = (ref, uuid, path, extra = "") => `(footprint "Pkg:FP" (layer "F.Cu") (uuid "${uuid}") (at 10 10)
  (property "Reference" "${ref}" (at 0 -1.4 0) (layer "F.SilkS") (uuid "${uuid}-r") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "v" (at 0 1.4 0) (layer "F.Fab") (uuid "${uuid}-v") (effects (font (size 1 1) (thickness 0.15))))
  ${extra} (path "${path}") (sheetname "/") (sheetfile "demo.kicad_sch") (attr smd))`;
const board = (body, header = "") => K.parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") (general (thickness 1.6)) (paper "A4") ${LAYERS} (setup) ${header}\n${body})`, "kicad_pcb");
const comp = (ref, path) => ({ ref, value: "v", footprint: "Pkg:FP", libId: "Dev:Q", paths: [path], fields: {}, sheetName: "/", sheetFile: "demo.kicad_sch", dnp: false, excludeFromBom: false, excludeFromBoard: false, pins: new Map() });
const actions = (plan) => plan.report.filter((r) => r.severity === "action" && r.text).map((r) => r.text);
const nlText = (comps, groups, variants) => `(export (version "E") (components ${comps}) (groups ${groups}) (variants ${variants}))`;
test("updateComponentClass: dry-run and applied wording; the footprint's (component_classes …) sorted, before its (path …)", () => {
  const nl = { components: [comp("U1", "/s1"), comp("U2", "/s2"), comp("U3", "/s3")], nets: new Map(), warnings: [] };
  N.readKicadNetlistExtras(nl, nlText(`(comp (ref "U1") (component_classes (class "Zeta") (class "Alpha"))) (comp (ref "U2")) (comp (ref "U3") (component_classes (class "B")))`, "", ""));
  assert.deepEqual(nl.components.map((c) => c.componentClasses), [["Zeta", "Alpha"], [], ["B"]]);
  const doc = board(bfp("U1", "f1", "/s1") + bfp("U2", "f2", "/s2", `(component_classes (class "Old"))`) + bfp("U3", "f3", "/s3", `(component_classes (class "A"))`));
  assert.deepEqual(actions(N.planUpdate(doc, nl, {})), ["Change U1 component class to 'Alpha,Zeta'.", "Remove U2 component class (currently 'Old').", "Change U3 component class from 'A' to 'B'."]);
  const plan = N.planUpdate(doc, nl, { applied: true });
  assert.deepEqual(actions(plan), ["Changed U1 component class to 'Alpha,Zeta'.", "Removed U2 component class (was 'Old').", "Changed U3 component class from 'A' to 'B'."]);
  const t1 = K.serialize(plan.modified.get("f1"));
  assert.ok(/\(component_classes \(class "Alpha"\) \(class "Zeta"\)\)\s*\(path "\/s1"\)/.test(t1), t1);
  assert.ok(!K.serialize(plan.modified.get("f2")).includes("component_classes"));
  const same = board(bfp("U1", "f1", "/s1", `(component_classes (class "Alpha") (class "Zeta"))`));
  assert.deepEqual(actions(N.planUpdate(same, { components: [nl.components[0]], nets: new Map(), warnings: [] }, {})), []);
});
test("groups: AssignGroups by instance path, the board group's uuid from the path; renames, library links and nesting", () => {
  const R = "11111111-1111-1111-1111-111111111111", S1 = "aaaaaaaa-0000-0000-0000-000000000001", S2 = "aaaaaaaa-0000-0000-0000-000000000002";
  const GA = "bbbbbbbb-0000-0000-0000-00000000000a", GB = "bbbbbbbb-0000-0000-0000-00000000000b";
  const nl = { components: [comp("U1", "/" + S1), comp("U2", "/" + S2)], nets: new Map(), warnings: [] };
  // group A (renamed "Power", linked to a design block) holds U1 and the nested group B, which holds U2
  N.readKicadNetlistExtras(nl, nlText(`(comp (ref "U1")) (comp (ref "U2"))`,
    `(group (name "Power") (uuid "/${GA}") (lib_id "Blocks:LDO") (members (member (uuid "/${S1}")) (member (uuid "/${GB}")))) (group (name "Inner") (uuid "/${GB}") (lib_id "") (members (member (uuid "/${S2}"))))`, ""));
  const uA = N.kiidFromName("/" + GA), uB = N.kiidFromName("/" + GB);
  assert.deepEqual(nl.groups.map((g) => [g.name, g.uuid, g.path]), [["Power", uA, GA], ["Inner", uB, GB]]);
  assert.deepEqual(nl.components.map((c) => c.group && c.group.uuid), [uA, uB]);
  // on the board: both groups already there under their derived uuids, A under its old name and not holding B
  const doc = board(bfp("U1", "f1", "/" + S1) + bfp("U2", "f2", "/" + S2) + bfp("U9", "f9", "/x") + `(group "Old" (uuid "${uA}") (members "f1" "f9")) (group "Inner" (uuid "${uB}") (members "f2" "f9"))`);
  const dry = actions(N.planUpdate(doc, nl, { transferGroups: true }));
  assert.deepEqual(dry, ["Change group name from 'Old' to 'Power'.", "Change group library link from '' to 'Blocks:LDO'.", "Add group 'Inner' to group 'Old'."]);
  const plan = N.planUpdate(doc, nl, { transferGroups: true, applied: true });
  assert.deepEqual(actions(plan), ["Changed group name from 'Old' to 'Power'.", "Changed group library link from '' to 'Blocks:LDO'.", "Added group 'Inner' to group 'Power'."]);
  const gA = [...doc.items.values()].find((i) => i.kind === "group" && String(K.kid(i.node, "uuid")[1]) === uA);
  const ga = K.serialize(plan.modified.get(gA.id));
  assert.equal(ga, `(group "Power" (uuid "${uA}") (lib_id "Blocks:LDO") (members "f1" "f9" "${uB}"))`);
  // a nested group the netlist no longer puts there leaves it
  const nl2 = { components: nl.components, nets: new Map(), warnings: [] };
  N.readKicadNetlistExtras(nl2, nlText(`(comp (ref "U1")) (comp (ref "U2"))`, `(group (name "Power") (uuid "/${GA}") (lib_id "") (members (member (uuid "/${S1}")))) (group (name "Inner") (uuid "/${GB}") (lib_id "") (members (member (uuid "/${S2}"))))`, ""));
  const doc2 = board(bfp("U1", "f1", "/" + S1) + bfp("U2", "f2", "/" + S2) + bfp("U9", "f9", "/x") + `(group "Power" (uuid "${uA}") (members "f1" "f9" "${uB}")) (group "Inner" (uuid "${uB}") (members "f2" "f9"))`);
  assert.deepEqual(actions(N.planUpdate(doc2, nl2, { transferGroups: true })), ["Remove group 'Inner' from group 'Power'."]);
  // a parent group the board lacks: the dry run says so, the real run makes it and nests the child in it
  const doc3 = board(bfp("U1", "f1", "/" + S1) + bfp("U2", "f2", "/" + S2) + bfp("U9", "f9", "/x") + `(group "Inner" (uuid "${uB}") (members "f2" "f9"))`);
  const nl3 = { components: [comp("U2", "/" + S2)], nets: new Map(), warnings: [] };
  N.readKicadNetlistExtras(nl3, nlText(`(comp (ref "U2"))`, `(group (name "Power") (uuid "/${GA}") (lib_id "") (members (member (uuid "/${GB}")))) (group (name "Inner") (uuid "/${GB}") (lib_id "") (members (member (uuid "/${S2}"))))`, ""));
  assert.deepEqual(actions(N.planUpdate(doc3, nl3, { transferGroups: true })), ["Add group 'Inner' to group 'Power'."]);
  const p3 = N.planUpdate(doc3, nl3, { transferGroups: true, applied: true });
  assert.deepEqual(actions(p3), ["Added group 'Inner' to group 'Power'."]);
  const made = p3.added.find((n) => n[0] === "group");
  assert.ok(made && String(K.kid(made, "uuid")[1]) === uA && K.serialize(made).includes(uB), K.serialize(made || []));
});
test("design variant registry: added, description updated, others removed with the footprints' records (the real run only)", () => {
  const nl = { components: [comp("U1", "/s1")], nets: new Map(), warnings: [] };
  N.readKicadNetlistExtras(nl, nlText(`(comp (ref "U1"))`, "", `(variant (name "lite") (description "Cheap")) (variant (name "Pro"))`));
  assert.deepEqual(nl.variantRegistry, [{ name: "lite", description: "Cheap" }, { name: "Pro", description: "" }]);
  // U9 is on the board only (no symbol): its records stay but for the deleted variant's (FOOTPRINT::DeleteVariant)
  const doc = board(bfp("U1", "f1", "/s1") + bfp("U9", "f9", "/x", `(variant (name "Gone") (dnp yes)) (variant (name "Lite") (dnp yes))`), `(variants (variant (name "Lite") (description "Old")) (variant (name "Gone")))`);
  doc.boardSetup = K.boardSetup.boardHeader(`(kicad_pcb (version 20260206) (variants (variant (name "Lite") (description "Old")) (variant (name "Gone"))))`);
  const dry = N.planUpdate(doc, nl, {});
  assert.equal(dry.variantsSection, undefined);
  assert.ok(!dry.report.some((r) => /variant/i.test(r.text) && !/footprint/.test(r.text)));
  const plan = N.planUpdate(doc, nl, { applied: true });
  const texts = plan.report.map((r) => r.text);
  const i = texts.indexOf("Updating design variants...");
  assert.ok(i >= 0);
  assert.deepEqual(texts.slice(i, i + 4), ["Updating design variants...", "Updated description for variant 'Lite'.", "Added variant 'Pro'.", "Removed variant 'Gone'."]);
  assert.equal(plan.variantsSection, `(variants(variant (name "Lite")(description "Cheap"))(variant (name "Pro")))`);
  const f9 = K.serialize(plan.modified.get("f9"));
  assert.ok(!f9.includes('"Gone"') && f9.includes('(variant (name "Lite") (dnp yes))'), f9);
  assert.equal(K.serialize(K.parse(K.boardSetup.variantsSection([{ name: "A", description: "" }]))), `(variants (variant (name "A")))`);
});

test("the board file: the (variants …) registry written after the setup and nets, replaced in place, dropped with \"\"", () => {
  const C = load("domains", "pcb", "mcp", "compact.ts");
  const file = `(kicad_pcb\n\t(version 20260206)\n\t(generator "pcbnew")\n\t(generator_version "10.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n\t${LAYERS}\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n\t(gr_line\n\t\t(start 0 0)\n\t\t(end 10 0)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "e1e1e1e1-0000-4000-8000-000000000001")\n\t)\n)\n`;
  const op = (t) => [{ changes: [K.boardSetup.variantsChange(t)] }];
  const r = C.foldOps(K, "kicad_pcb", file, op(K.boardSetup.variantsSection([{ name: "Lite", description: "Cheap" }])));
  assert.ok(r.ok, r.reason);
  assert.ok(/\(setup[\s\S]*?\n\t\)\n\t\(variants\s*\(variant\s*\(name "Lite"\)\s*\(description "Cheap"\)\s*\)\s*\)\n\t\(gr_line/.test(r.text), r.text);
  const r2 = C.foldOps(K, "kicad_pcb", r.text, op(K.boardSetup.variantsSection([{ name: "Pro", description: "" }])));
  assert.ok(r2.ok, r2.reason); assert.ok(r2.text.includes('"Pro"') && !r2.text.includes('"Lite"'), r2.text);
  const r3 = C.foldOps(K, "kicad_pcb", r2.text, op(""));
  assert.ok(r3.ok, r3.reason); assert.ok(!r3.text.includes("(variants"), r3.text);
  // the open board takes it too: the toolbar's registry
  const doc = board("");
  K.boardSetup.applyBoardSetup(doc, K.boardSetup.variantsChange(K.boardSetup.variantsSection([{ name: "Lite", description: "" }])));
  assert.equal(K.serialize(doc.variantsNode), `(variants (variant (name "Lite")))`);
  K.boardSetup.applyBoardSetup(doc, K.boardSetup.variantsChange(""));
  assert.equal(doc.variantsNode, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
