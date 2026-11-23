// pcb-drc-parity.test.js — board DRC parity with KiCad (pcbnew/drc, pcbnew/dialogs/dialog_drc.cpp, drc_report.cpp,
// rc_item.cpp, pcb_marker.cpp): the dialog's row texts, list order, tab titles, badges, elapsed tick, violation layer
// and saved reports; the DRC item table; exclusion marker types, legacy strings and stale exclusions; the checker's
// user units, error limits, marker paths and the footprint / via / via-count providers; connectivity runs; the rules
// parser's fatal errors.
// Run: node server/static/tests/pcb-drc-parity.test.js
"use strict";
const assert = require("assert/strict");
const path = require("path");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
const R = load(["editor", "pcbdialogs", "drc-report.ts"]), ITEMS = load(["canvas", "drc-items.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("Board DRC parity");

const HEAD = '(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (43 "F.CrtYd" user)) ';
const board = (body) => K.parseDoc(HEAD + body + ")", "kicad_pcb");

// ---------------------------------------------------------------- the dialog (drc-report.ts)
test("A8: RC_TREE_MODEL row prefixes and the errors-first stable order", () => {
  assert.equal(R.rowText({ code: "clearance", severity: "error", text: "Clearance violation" }, "error"), "Error: Clearance violation");
  assert.equal(R.rowText({ code: "track_dangling", severity: "warning", text: "Track has unconnected end" }, "warning"), "Warning: Track has unconnected end");
  assert.equal(R.rowText({ code: "track_dangling", severity: "warning", text: "x", excluded: true }, "warning"), "Excluded warning: x");
  assert.equal(R.rowText({ code: "clearance", severity: "error", text: "x", excluded: true }, "error"), "Excluded error: x");
  const l = [{ severity: "warning" }, { severity: "error", excluded: true }, { severity: "error" }, { severity: "warning" }, { severity: "error" }];
  assert.deepEqual(R.listOrder(l), [2, 4, 0, 3, 1]);
});
test("A7: tab titles before a run, after a run without parity, the overflow '+' and the badges", () => {
  assert.deepEqual(R.tabTitles({ ran: false, parityRan: false, counts: [0, 0, 0], overflow: [false, false, false], ignored: 3 }), ["Violations ", "Unconnected Items ", "Schematic Parity ", "Ignored Tests "]);
  assert.deepEqual(R.tabTitles({ ran: true, parityRan: false, counts: [199, 2, 0], overflow: [true, false, false], ignored: 3 }), ["Violations (199+)", "Unconnected Items (2)", "Schematic Parity (not run)", "Ignored Tests (3)"]);
  assert.equal(R.tabTitles({ ran: true, parityRan: true, counts: [0, 0, 4], overflow: [false, false, false], ignored: 0 })[2], "Schematic Parity (4)");
  assert.equal(R.badgeText("error", 0, false), ""); assert.equal(R.badgeText("error", 0, true), "0"); assert.equal(R.badgeText("exclusion", 0, true), "");
  assert.equal(R.badgeText("warning", 199, true, true), "199+");
  const ov = R.overflowedTabs(Array.from({ length: 199 }, () => ({ code: "track_dangling" })), () => 0, (c) => (c === "clearance" ? 499 : 199), () => "warning", { errors: true, warnings: true });
  assert.deepEqual(ov.tabs, [true, false, false]); assert.equal(ov.warnings, true); assert.equal(ov.errors, false);
  assert.deepEqual(R.overflowedTabs(Array.from({ length: 199 }, () => ({ code: "track_dangling" })), () => 0, () => 199, () => "warning", { errors: true, warnings: false }).tabs, [false, false, false], "only the shown severities mark a tab");
});
test("A13: the elapsed tick is whole seconds, then minutes", () => {
  assert.equal(R.elapsedTick(0), "Elapsed: 0 s"); assert.equal(R.elapsedTick(59999), "Elapsed: 59 s"); assert.equal(R.elapsedTick(61500), "Elapsed: 1 min 1 s");
});
test("A4: DRC_ITEM::GetViolationLayers' principal layer", () => {
  assert.equal(R.principalLayer({ code: "copper_edge_clearance", layer: "F.Cu" }, []), "Edge.Cuts");
  assert.equal(R.principalLayer({ code: "invalid_outline" }, []), "Edge.Cuts");
  assert.equal(R.principalLayer({ code: "malformed_courtyard" }, []), "F.CrtYd"); assert.equal(R.principalLayer({ code: "malformed_courtyard" }, [], true), "B.CrtYd");
  assert.equal(R.principalLayer({ code: "clearance", layer: "B.Cu" }, [["F.Cu"]]), "B.Cu");
  assert.equal(R.principalLayer({ code: "clearance" }, [["F.Cu", "B.Cu"], ["B.Cu"]]), "B.Cu", "the first layer every item is on");
  assert.equal(R.principalLayer({ code: "clearance" }, [["F.Cu"], ["B.Cu"]]), "F.Cu");
  assert.equal(R.principalLayer({ code: "clearance" }, []), null);
});
const reportInput = (extra) => Object.assign({
  violations: [{ code: "clearance", severity: "error", text: "Clearance violation (netclass 'Default' clearance 0.2000 mm; actual 0.1000 mm)", x: 110, y: 50, layer: "F.Cu", ids: ["a", "b"] },
    { code: "track_dangling", severity: "warning", text: "Track has unconnected end", x: 1, y: 2, excluded: true, comment: "ok", ids: ["c"] }],
  unconnected: [], parity: [], show: { errors: true, warnings: true, exclusions: true }, units: "mm", date: "2026-11-23T10:00:00", file: "b.kicad_pcb", kicadVersion: "10.99.0",
  severityOf: (c) => (c === "track_dangling" ? "warning" : "error"),
  items: (m) => m.ids.map((id, i) => ({ x: 110 + i, y: 50, desc: `Track [${id}] on F.Cu`, uuid: "u-" + id })),
  ruleDesc: (m) => (m.code === "clearance" ? "Rule: netclass 'Default'" : "Local override"),
  ignored: [["Silkscreen overlap", "silk_overlap"]],
}, extra || {});
test("A10: DRC_REPORT::WriteTextReport's layout", () => {
  const t = R.drcTextReport(reportInput());
  assert.equal(t, [
    "** Drc report for b.kicad_pcb **", "** Created on 2026-11-23T10:00:00 **", "** Report includes: Errors, Warnings, Exclusions **", "",
    "** Found 2 DRC violations **",
    "[clearance]: Clearance violation (netclass 'Default' clearance 0.2000 mm; actual 0.1000 mm)", "    Rule: netclass 'Default'; error",
    "    @(110.0000 mm, 50.0000 mm): Track [a] on F.Cu", "    @(111.0000 mm, 50.0000 mm): Track [b] on F.Cu",
    "[track_dangling]: Track has unconnected end", "    Local override; warning (excluded)", "    @(110.0000 mm, 50.0000 mm): Track [c] on F.Cu", "    ok", "",
    "** Found 0 unconnected pads **", "", "** Found 0 Footprint errors **", "", "** Ignored checks **", "    - Silkscreen overlap", "", "** End of Report **", ""].join("\n"));
  const none = R.drcTextReport(reportInput({ violations: [], ignored: [], show: { errors: false, warnings: false, exclusions: false }, units: "mil" }));
  assert.ok(none.includes("** Report includes: None **") && none.includes("    - None\n"));
  assert.ok(R.drcTextReport(reportInput({ units: "mil" })).includes("@(4330.71 mils, 1968.50 mils)"));
  assert.match(R.isoNow(new Date(2026, 0, 2, 3, 4, 5)), /^2026-01-02T03:04:05$/);
});
test("A10: DRC_REPORT::WriteJsonReport (drc.v1)", () => {
  const j = JSON.parse(R.drcJsonReport(reportInput({ units: "mil" })));
  assert.deepEqual(Object.keys(j), ["$schema", "coordinate_units", "date", "ignored_checks", "included_severities", "kicad_version", "schematic_parity", "source", "unconnected_items", "violations"]);
  assert.equal(j.$schema, "https://schemas.kicad.org/drc.v1.json"); assert.equal(j.coordinate_units, "mils"); assert.deepEqual(j.included_severities, ["error", "warning", "exclusion"]);
  assert.deepEqual(j.ignored_checks, [{ description: "Silkscreen overlap", key: "silk_overlap" }]);
  const v = j.violations[0]; assert.equal(v.type, "clearance"); assert.equal(v.layer, "F.Cu"); assert.equal(v.excluded, undefined); assert.equal(v.items.length, 2); assert.equal(v.items[0].uuid, "u-a");
  assert.ok(Math.abs(v.pos.x - 110 / 0.0254) < 1e-6);
  assert.equal(j.violations[1].excluded, true); assert.equal(j.violations[1].comment, "ok"); assert.equal(j.violations[1].severity, "warning");
});

// ---------------------------------------------------------------- the DRC item table and exclusions
test("A11: DRC_ITEM::allItemTypes rows and the internal group", () => {
  const row = (k) => ITEMS.DRC_ITEMS.find((i) => i[1] === k);
  assert.deepEqual(row("copper_outside_board"), ["Copper outside board outline", "copper_outside_board", "warning"]);
  assert.deepEqual(row("hole_aspect_ratio"), ["Hole too deep for its diameter", "hole_aspect_ratio", "error"]);
  assert.equal(row("microvia_aspect_ratio"), undefined);
  assert.equal(row("microvia_spans_dielectrics")[2], "warning"); assert.equal(row("generic_warning")[2], "warning");
  for (const k of ["padstack_invalid", "generic_error", "generic_warning"]) assert.ok(!ITEMS.DRC_ITEMS_WITH_SEVERITIES.some((i) => i[1] === k), k);
});
test("A2 / A17 / B14: marker types, legacy strings and stale exclusions", () => {
  assert.equal(P.markerTypeOf("unconnected_items"), "MT_RATSNEST"); assert.equal(P.markerTypeOf("extra_footprint"), "MT_PARITY"); assert.equal(P.markerTypeOf("clearance"), "MT_DRC"); assert.equal(P.markerTypeOf("unresolved_variable", true), "MT_DRAWING_SHEET");
  assert.equal(P.exclusionOf(null, { code: "unconnected_items", x: 1, y: 2, ids: [], kiids: ["a", "b"] }).marker.marker_type, "MT_RATSNEST");
  assert.equal(P.legacyExclusion("unconnected_items|1000000|2000000|a|b|c", ""), null, "six fields are rejected");
  assert.ok(P.legacyExclusion("unconnected_items|1000000|2000000|a|b", ""));
  const st = P.legacyExclusion("starved_thermal|1000000|2000000|a|b|B.Cu", "");
  assert.ok(st && /B/.test(JSON.stringify(st.marker.layer || "")), "starved_thermal takes its layer from the sixth field");
  const doc = board('(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "s-1"))');
  const keep = P.exclusionOf(doc, { code: "track_dangling", x: 5, y: 0, ids: ["s-1"], kiids: ["s-1"], layer: "F.Cu" });
  const gone = P.exclusionOf(doc, { code: "track_dangling", x: 9, y: 9, ids: ["zz"], kiids: ["zz"], layer: "F.Cu" });
  const r = P.resolveStaleExclusions(doc, [], [keep, gone], (u) => (u === "s-1" ? "s-1" : null));
  assert.equal(r.added.length, 1); assert.equal(r.added[0].code, "track_dangling"); assert.equal(r.added[0].excluded, true); assert.deepEqual(r.added[0].ids, ["s-1"]);
  assert.equal(r.changed, true); assert.equal(r.entries.length, 1);
});

// ---------------------------------------------------------------- the checker
const DRC_BOARD = `(segment (start 110 50) (end 115 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-1"))
  (segment (start 110 50.35) (end 115 50.35) (width 0.25) (layer "F.Cu") (net "/SIG") (uuid "s-2"))
  (gr_rect (start 90 40) (end 150 90) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`;
test("A12: messages in the run's user units (formatMsg)", () => {
  const doc = board(DRC_BOARD);
  const mm = P.drc(doc, null, {}).find((m) => m.code === "clearance"); assert.equal(mm.text, "Clearance violation (netclass 'Default' clearance 0.2000 mm; actual 0.1000 mm)");
  const mil = P.drc(doc, null, { units: "mil" }).find((m) => m.code === "clearance"); assert.equal(mil.text, "Clearance violation (netclass 'Default' clearance 7.87 mils; actual 3.94 mils)");
  const inch = P.drc(doc, null, { units: "in" }).find((m) => m.code === "clearance"); assert.equal(inch.text, "Clearance violation (netclass 'Default' clearance 0.0079 in; actual 0.0039 in)");
  assert.equal(P.drc(doc, null, {}).find((m) => m.code === "clearance").text, mm.text, "the units do not stick after a run");
  assert.deepEqual(P.mmPair(0.2, 0.20004), ["0.2 mm", "0.20004 mm"], "equal at 4 places: StringFromValue");
});
test("A1: a clearance marker carries its two-point path (reportTwoShapeGeometry) and layer", () => {
  const m = P.drc(board(DRC_BOARD), null, {}).find((x) => x.code === "clearance");
  assert.equal(m.layer, "F.Cu"); assert.ok(Array.isArray(m.path));
  const [a, b] = m.path; assert.ok(Math.abs(a[1] - 50.125) < 1e-9 && Math.abs(b[1] - 50.225) < 1e-9, JSON.stringify(m.path));
  assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1]) - 0.1) < 1e-9);
});
test("B13: at most 199 violations of a code (499 for clearance and unconnected items)", () => {
  assert.equal(P.drcErrorLimit("clearance"), 499); assert.equal(P.drcErrorLimit("unconnected_items"), 499); assert.equal(P.drcErrorLimit("track_dangling"), 199);
  let body = ""; for (let i = 0; i < 210; i++) body += `(segment (start ${i} 0) (end ${i} 0.5) (width 0.1) (layer "F.Cu") (net "N${i}") (uuid "t-${i}"))`;
  const m = P.drc(board(body), null, { outline: false });
  assert.equal(m.filter((x) => x.code === "track_dangling").length, 199);
});
test("B1: track_not_centered_on_via (DRC_TEST_PROVIDER_CONNECTIVITY)", () => {
  const body = `(via (at 10 10) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "A") (uuid "v"))
    (segment (start 0 10) (end 10.2 10) (width 0.25) (layer "F.Cu") (net "A") (uuid "off"))
    (segment (start 10 10) (end 10 20) (width 0.25) (layer "B.Cu") (net "A") (uuid "ok"))`;
  const pro = { board: { design_settings: { rule_severities: { track_not_centered_on_via: "warning" } } } };
  const m = P.drc(board(body), P.designSettings(pro), { outline: false }).filter((x) => x.code === "track_not_centered_on_via");
  assert.equal(m.length, 1); assert.deepEqual(m[0].ids, ["off", "v"]); assert.deepEqual([m[0].x, m[0].y], [10.2, 10]); assert.equal(m[0].layer, "F.Cu"); assert.equal(m[0].text, "Track endpoint not centered on via"); assert.equal(m[0].severity, "warning");
  assert.equal(P.drc(board(body), null, { outline: false }).filter((x) => x.code === "track_not_centered_on_via").length, 0, "ignored by default");
  const centred = body + `(segment (start 10 10) (end 10 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "c"))`;
  assert.equal(P.drc(board(centred), P.designSettings(pro), { outline: false }).filter((x) => x.code === "track_not_centered_on_via").length, 0, "another track on the layer reaches the centre");
});
test("B1: too_many_vias from a via_count constraint (checkViaCounts)", () => {
  const body = `(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "s"))
    (via (at 5 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "A") (uuid "v1")) (via (at 9 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "A") (uuid "v2"))`;
  const m = P.customRuleMarkers(board(body), P.designSettings(null), '(version 1)\n(rule "vias" (constraint via_count (max 1)))');
  assert.equal(m.length, 1); assert.equal(m[0].code, "too_many_vias"); assert.equal(m[0].text, "Too many vias on a connection (rule 'vias' max count 1; actual 2)");
  const few = P.customRuleMarkers(board(body), P.designSettings(null), '(version 1)\n(rule "vias" (constraint via_count (min 3)))');
  assert.equal(few[0].text, "Too few vias on a connection (rule 'vias' min count 3; actual 2)");
});
test("B1: footprint checks (DRC_TEST_PROVIDER_FOOTPRINT_CHECKS)", () => {
  const body = `(footprint "T:A" (layer "F.Cu") (uuid "fa") (at 10 10) (attr smd)
      (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (uuid "pa1"))
      (pad "2" smd rect (at 3 0) (size 1 1) (drill 0.3) (layers "F.Cu" "F.Mask") (uuid "pa2")))
    (footprint "T:B" (layer "F.Cu") (uuid "fb") (at 30 10) (net_tie_pad_groups "1,9")
      (transform (translate 30 10) (scale 2 2))
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (uuid "pb1")))`;
  const pro = { board: { design_settings: { rule_severities: { footprint_type_mismatch: "error" } } } };
  const m = P.drc(board(body), P.designSettings(pro), { outline: false, footprintOwn: true });
  const by = (c) => m.filter((x) => x.code === c);
  assert.equal(by("footprint_type_mismatch").length, 1); assert.equal(by("footprint_type_mismatch")[0].text, "Footprint component type doesn't match footprint pads (expected 'Through hole'; actual 'SMD')");
  assert.deepEqual(by("padstack_invalid").map((x) => x.text), ["Padstack is not valid (SMD pad has a hole)"]); assert.deepEqual([by("padstack_invalid")[0].x, by("padstack_invalid")[0].y], [13, 10]);
  assert.equal(by("footprint_scaled_with_pads").length, 1); assert.equal(by("footprint_scaled_with_pads")[0].severity, "warning");
  assert.deepEqual(by("footprint").map((x) => x.text), ["Footprint is not valid (net-tie pad group contains unknown pad number 9)"]);
});
test("B12: connectivity runs follow T junctions and tracks ending off a via's centre", () => {
  const body = `(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "a"))
    (segment (start 5 0) (end 5 5) (width 0.25) (layer "F.Cu") (net "A") (uuid "t"))
    (via (at 10.2 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "A") (uuid "v"))
    (segment (start 10.2 0) (end 10.2 8) (width 0.25) (layer "B.Cu") (net "A") (uuid "b"))
    (segment (start 5 5) (end 5 9) (width 0.25) (layer "F.Cu") (net "B") (uuid "other"))
    (segment (start 5 5) (end 6 9) (width 0.25) (layer "B.Cu") (net "A") (uuid "elsewhere"))`;
  const run = Array.from(P.connectedRun(board(body), ["a"])).sort();
  assert.deepEqual(run, ["a", "b", "t", "v"], "the T, the via a track ends inside, the track on the far side; not another net nor another layer");
});
test("B9 / A13: a PARSE_ERROR out of the rules parser is fatal (InitEngine fails)", () => {
  const bad = P.parseDru('(version 1)\n(rule "x" (constraint clearance (min "0.2mm)))');
  assert.ok(bad.messages.some((m) => m.fatal && m.text === "Unterminated delimited string"));
  const units = P.parseDru('(version 1)\n(rule "a" (constraint clearance (min 0.2)))');
  assert.ok(!units.messages.some((m) => m.fatal)); assert.equal(units.errors.length, 0); assert.equal(units.messages[0].text, "Missing units for '0.2'");
  const cond = P.parseDru('(version 1)\n(rule "c" (constraint clearance (min 0.2mm)) (condition "A.Foo == 1"))');
  assert.ok(cond.errors.length > 0, "a condition that does not compile");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
