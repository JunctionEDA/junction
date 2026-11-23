// pcb-dialogs-tools.test.js — KiCad parity of the PCB dialogs and tools (findings/pcb-dialogs-tools.md):
// global deletion of ellipses / barcodes, edit text & graphics (ellipses, nested groups, selected fields, Footprint Editor),
// netclass filters (NETCLASS::ContainsNetclassWithName), BOARD::RemoveAllItemsOnLayer, the custom rules plausibility
// check, the DRC report files and counts, and the dialog strings.
// Run: node server/static/tests/pcb-dialogs-tools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webPath } = require("./web-path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
globalThis.window = globalThis.window || globalThis;
const load = (...rel) => {
  const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
  const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports;
};
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");

const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user) (35 "F.Fab" user) (39 "User.1" user))
  (net 0 "") (net 1 "GND")
  (footprint "Lib:R_0603" (layer "F.Cu") (uuid "fp1") (at 10 10)
    (property "Reference" "R1" (at 0 -1.5 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 1.5 0) (layer "F.Fab") (uuid "v1") (effects (font (size 1 1) (thickness 0.15))))
    (fp_line (start 0 0) (end 1 0) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "l1")))
  (gr_ellipse (center 5 5) (major_radius 3) (minor_radius 1) (angle 0) (stroke (width 0.2) (type solid)) (layer "User.1") (uuid "el"))
  (gr_text "hello" (at 3 3 0) (layer "F.SilkS") (uuid "gt") (effects (font (size 2 2) (thickness 0.3))))
  (gr_line (start 0 0) (end 30 0) (stroke (width 0.5) (type default)) (layer "User.1") (uuid "ul"))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "In1.Cu") (net 1) (uuid "s1"))
  (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "thru"))
  (via blind (at 2 2) (size 0.6) (drill 0.3) (layers "F.Cu" "In1.Cu") (net 1) (uuid "bl"))
  (zone (net 1) (net_name "GND") (layers "F.Cu" "In1.Cu") (uuid "z1") (hatch edge 0.5)
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)))
    (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10)))
    (filled_polygon (layer "In1.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10))))
  (group "" (uuid "outer") (members "inner"))
  (group "" (uuid "inner") (members "gt"))
)`;
const doc = () => K.parseDoc(BOARD, "kicad_pcb");

test("global deletion: ellipses are graphic shapes (PCB_SHAPE_T)", () => {
  const G = P.globalDeletion, d = doc();
  const ids = G.globalDeletionIds(d, Object.assign({}, G.GLOBAL_DELETION_DEFAULTS, { graphics: true, boardGraphics: true }), "F.Cu");
  if (d.items.has("el")) assert.ok(ids.includes("el"), "an ellipse is deleted with the board graphics");
});

test("text & graphics: nested group membership and ellipse widths", () => {
  const T = P.textGraphics;
  const m = new Map(T.editTextAndGraphics(doc(), { scope: { boardText: true }, filter: { selectedOnly: true }, specified: true, values: { textHeight: 3 }, selection: new Set(["outer"]) }));
  assert.ok(m.has("gt"), "text inside a group nested in the selected group is selected (PCB_GROUP walk)");
  const d = doc();
  if (d.items.has("el")) {
    const w = new Map(T.editTextAndGraphics(d, { scope: { boardGraphics: true }, filter: {}, specified: true, values: { lineWidth: 0.4 } }));
    assert.ok(w.has("el"), "an ellipse's stroke is edited with the other shapes");
  }
});

test("text & graphics: a field selected on its own passes 'selected only'", () => {
  const T = P.textGraphics;
  const m = new Map(T.editTextAndGraphics(doc(), { scope: { references: true }, filter: { selectedOnly: true }, specified: true, values: { textHeight: 2 }, selection: new Set(), selectedFields: [{ id: "fp1", name: "Reference" }] }));
  assert.ok(m.has("fp1"), "the footprint carrying the selected reference is edited");
});

test("netclass filter: explicit assignment and pattern constituents (wildcard match)", () => {
  const D = P;
  // .kicad_pro netclass_assignments hold a list per net (NET_SETTINGS); Power and HV are not defined, so both are
  // implicit classes and Default joins the composite for the values they leave unset (makeEffectiveNetclass)
  const s = { netclasses: {}, netclassOf: { VCC: ["Power", "HV"] }, patterns: [{ re: /^GND.*$/, netclass: "Ground" }] };
  assert.deepEqual(D.netclassConstituents(s, "VCC"), ["HV", "Power", "Default"]);
  assert.deepEqual(D.netclassConstituents(s, "GND1"), ["Ground"]);
  assert.deepEqual(D.netclassConstituents(s, "X"), [], "no class: the net is in Default");
  assert.ok(D.netInNetclass(s, "X", "Default"), "a net with no class matches Default");
  assert.ok(D.netInNetclass(s, "VCC", "HV"), "a net in a composite class matches either constituent");
  assert.ok(D.netInNetclass(s, "VCC", "Pow*"), "wildcards match like wxString::Matches");
  assert.ok(!D.netInNetclass(s, "GND1", "Power"));
});

test("removed layers: listed items and BOARD::RemoveAllItemsOnLayer", () => {
  const G = P.globalDeletion, d = doc();
  const listed = G.removedLayerItems(d, ["In1.Cu"], "mm").map((x) => x.id);
  assert.ok(listed.includes("s1") && listed.includes("bl") && listed.includes("z1"));
  const ch = G.removeItemsOnLayers(d, ["In1.Cu"]);
  const byId = new Map(ch.map((c) => [c.id, c]));
  assert.ok(byId.has("s1"), "a track on the layer is removed");
  assert.ok(byId.has("bl"), "a blind via ending on the layer is removed");
  assert.ok(!byId.has("thru"), "a through via is kept");
  const z = byId.get("z1"); assert.ok(z && z.kind === "MODIFIED", "a zone on more layers is modified, not removed");
  assert.match(z.sexpr, /\(layers "F\.Cu"\)/);
  assert.equal((z.sexpr.match(/filled_polygon/g) || []).length, 1, "the fill on the removed layer goes");
  assert.ok(!byId.has("fp1"), "footprints are kept");
});

test("custom rules plausibility (PANEL_SETUP_RULES::checkPlausibility)", () => {
  const R = (name, condition, layer = null) => ({ name, condition, layer, severity: null, constraints: [], expr: null, error: null });
  const out = P.rulesPlausibility([R("a", "A.NetClass == 'HV'"), R("b", " A.NetClass == 'HV' "), R("c", "A.Type == 'Via'", "In5.Cu"), R("d", "x", "outer")],
    new Set(["F.Cu", "B.Cu"]), new Set(["Power"]));
  assert.ok(out.includes("Rules 'b' and 'a' share the same condition."), out.join("\n"));
  assert.ok(out.some((l) => /^Rule 'a' references undefined netclass 'HV/.test(l)), out.join("\n"));
  assert.ok(out.includes("Rule 'c' references undefined layer(s): In5.Cu."), out.join("\n"));
  assert.ok(!out.some((l) => l.startsWith("Rule 'd'")), "'outer' is never an undefined layer");
});

test("DRC report: text report and counts (DRC_REPORT, DIALOG_DRC::updateDisplayedCounts)", () => {
  const R = load("domains", "pcb", "editor", "pcbdialogs", "drc-report.ts");
  assert.equal(R.formatSeverities({ errors: true, warnings: true, exclusions: false }), "Errors, Warnings");
  assert.equal(R.formatSeverities({ errors: false, warnings: false, exclusions: false }), "None");
  const m = { code: "clearance", text: "Clearance violation", severity: "error", x: 1, y: 2, layer: "F.Cu", its: [{ desc: "Track", x: 1, y: 2 }, { desc: "Pad", x: 3, y: 4 }] };
  const input = (show, ignored) => ({ violations: [m], unconnected: [], parity: [], show, units: "mm", date: "D", file: "b.kicad_pcb",
    severityOf: () => "error", items: (x) => x.its, ruleDesc: () => "Local override", ignored, layerName: (l) => (l === "F.Cu" ? "Top" : l) });
  const txt = R.drcTextReport(input({ errors: true, warnings: true, exclusions: false }, []));
  assert.match(txt, /^\*\* Drc report for b\.kicad_pcb \*\*\n\*\* Created on D \*\*\n\*\* Report includes: Errors, Warnings \*\*\n/);
  assert.match(txt, /\[clearance\]: Clearance violation\n    Local override; error\n    @\(1\.0000 mm, 2\.0000 mm\): Track\n    @\(3\.0000 mm, 4\.0000 mm\): Pad\n/);
  assert.match(txt, /\*\* Found 0 Footprint errors \*\*\n\n\*\* Ignored checks \*\*\n    - None\n\n\*\* End of Report \*\*\n$/);
  const js = JSON.parse(R.drcJsonReport(input({ errors: true, warnings: false, exclusions: false }, [["t", "k"]])));
  assert.equal(js.$schema, "https://schemas.kicad.org/drc.v1.json");
  assert.deepEqual(js.included_severities, ["error"]);
  assert.deepEqual(js.ignored_checks, [{ key: "k", description: "t" }]);
  assert.equal(js.violations[0].items[1].pos.x, 3);
  assert.equal(js.violations[0].layer, "Top", "setMarkerLocation writes BOARD::GetLayerName");
  // updateDisplayedCounts: "(%s)" removed from the templates before a run
  assert.deepEqual(R.tabTitles({ ran: false, parityRan: false, counts: [0, 0, 0], overflow: [false, false, false], ignored: 2 }), ["Violations ", "Unconnected Items ", "Schematic Parity ", "Ignored Tests "]);
  assert.deepEqual(R.tabTitles({ ran: true, parityRan: false, counts: [3, 1, 0], overflow: [false, false, false], ignored: 2 }), ["Violations (3)", "Unconnected Items (1)", "Schematic Parity (not run)", "Ignored Tests (2)"]);
  assert.deepEqual(["error", "warning", "exclusion"].map((k) => R.badgeText(k, 0, false)), ["", "", ""]);
  assert.deepEqual(["error", "warning", "exclusion"].map((k) => R.badgeText(k, 0, true)), ["0", "0", ""]);
});

test("dialog strings match KiCad", () => {
  const dlg = (f) => src("domains", "pcb", "editor", "pcbdialogs", f);
  assert.match(dlg("update-pcb.ts"), /Changes Applied to PCB/);
  assert.match(dlg("update-pcb.ts"), /"Update Netlist"/);
  assert.match(dlg("board-setup.ts"), /Select layer to add:/);
  assert.match(dlg("board-setup.ts"), /All user-defined layers have already been added\./);
  assert.match(dlg("board-setup.ts"), /Clearance was too large\.  It has been clipped to/);
  assert.match(dlg("board-setup.ts"), /Footprints have some items on removed layers/);
  assert.match(dlg("inspect.ts"), /Edit ignored tests/);
  assert.match(dlg("inspect.ts"), /DRC incomplete: could not compile custom design rules\./);
  assert.match(dlg("inspect.ts"), /_report\.txt/);
  assert.match(dlg("transform-dialogs.ts"), /Rebuilding connectivity\.\.\./);
  assert.match(dlg("text-graphics.ts"), /-- leave unchanged --/);
});

test("board finish: via protection defaults read and written like formatSetup", () => {
  const B = K.boardSetup;
  const s = K.parse("(setup (pad_to_mask_clearance 0) (allow_soldermask_bridges_in_footprints no) (tenting (front yes) (back yes)) (pcbplotparams))");
  assert.deepEqual(B.viaProtection(s), { fill: false, cap: false, plugFront: false, plugBack: false, tentFront: true, tentBack: true, coverFront: false, coverBack: false });
  const out = B.sectionText(B.editSetup(s, { vias: { fill: true, cap: true, plugFront: false, plugBack: false, tentFront: false, tentBack: true, coverFront: true, coverBack: false } }));
  assert.match(out, /\(tenting \(front no\) \(back yes\)\) \(covering \(front yes\) \(back no\)\) \(plugging \(front no\) \(back no\)\) \(capping yes\) \(filling yes\) \(pcbplotparams\)/);
  assert.deepEqual(B.viaProtection(K.parse(out)).coverFront, true);
  const dlg = src("domains", "pcb", "editor", "pcbdialogs", "board-setup.ts");
  assert.match(dlg, /Settings for Vias with Protection Features Set to \\"From rules\\":/);
  assert.match(dlg, /enable\(capV, filled\); enable\(plugF, !filled\)/, "VIA_PROTECTION_RULES: cap needs a fill, plug needs none");
});
