// drc-rules-inspection.test.js — DRC rules UI, rule providers and inspection reports (KiCad parity round 2):
// the Constraints / Clearance Resolution reports (board_inspection_tool.cpp over DRC_ENGINE::EvalRules), a DRC marker
// weighed with the items under it (GuessSelectionCandidates), the error legend of a server marker, the zone filler's
// "DRC rules contain errors" check, the browser DRC providers (physical_clearance, net-tie shorting_items,
// generic_error), the zone hatch offsets, the multi-item message panel and the Board Setup constraint pages.
// Run: node server/static/tests/drc-rules-inspection.test.js
"use strict";
const assert = require("assert/strict");
const path = require("path");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, T = globalThis.PcbTools;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("DRC rules and inspection");

const HEAD = '(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user) (5 "F.SilkS" user) (1 "F.Mask" user) (31 "F.CrtYd" user)) (setup (pad_to_mask_clearance 0.05) (pad_to_paste_clearance -0.02)) (net 0 "") (net 1 "GND") (net 2 "VCC") ';
const board = (body) => K.parseDoc(HEAD + body + ")", "kicad_pcb");
const settings = (extra) => Object.assign(T.designSettings({ net_settings: { classes: [{ name: "Default", track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, clearance: 0.2 }] } }), { minClearance: 0.1 }, extra || {});
const FMT = (v) => `${+v.toFixed(4)} mm`;
const withRules = (text, fn) => { T.setCustomRules(text); try { return fn(); } finally { T.setCustomRules(null); } };

const TRACKS = '(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1 "GND") (uuid "s1")) (segment (start 0 0.4) (end 10 0.4) (width 0.25) (layer "F.Cu") (net 2 "VCC") (uuid "s2")) ';
const PADFP = '(footprint "Lib:R" (layer "F.Cu") (uuid "fp1") (at 20 20) (solder_mask_margin 0.07) (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (uuid "r1") (effects (font (size 1 1) (thickness 0.15)))) ' +
  '(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (net 1 "GND") (uuid "p1")) (pad "2" thru_hole circle (at 2 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (solder_mask_margin 0.02) (net 2 "VCC") (uuid "p2"))) ';

// ---------------------------------------------------------------- Constraints Resolution (#26)
test("Constraints Resolution: a pad gets Hole Size, Solder Mask (its own override), Solder Paste, Keepouts, Assertions", () => {
  const d = board(PADFP);
  const fp = [...d.items.values()].find((it) => it.kind === "footprint");
  const pages = T.inspectConstraints(d, fp.id + "#1", settings(), FMT);
  assert.deepEqual(pages.map((p) => p.title), ["Hole Size", "Solder Mask", "Solder Paste", "Keepouts", "Assertions"]);
  const mask = pages[1].lines.join("\n");
  assert.match(mask, /Local override on PTH pad 2 \[VCC\] of R1; solder mask expansion: 0\.02 mm\./);
  assert.match(mask, /Resolved solder mask expansion: 0\.02 mm\.$/);
  // pad 1 has none of its own: the footprint's
  const m1 = T.inspectConstraints(d, fp.id + "#0", settings(), FMT);
  assert.deepEqual(m1.map((p) => p.title), ["Solder Mask", "Solder Paste", "Keepouts", "Assertions"], "an SMD pad has no hole");
  assert.match(m1[0].lines.join("\n"), /Local override on Footprint R1; solder mask expansion: 0\.07 mm\./);
  // no paste override anywhere: inherited from the footprint, then the board setup
  const paste = m1[1].lines.join("\n");
  assert.match(paste, /Inheriting from parent: Footprint R1\./);
  assert.match(paste, /Resolved solder paste absolute clearance: -0\.02 mm\./);
  assert.match(paste, /Solder paste relative clearance resolution for:/);
});
test("Constraints Resolution: text sizes, a keepout area and assertions", () => {
  const d = board('(gr_text "hi" (at 3 3 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15)))) ' +
    '(zone (net 0) (net_name "") (layer "F.Cu") (uuid "ko") (name "KEEP") (hatch edge 0.5) (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy -1 -1) (xy 11 -1) (xy 11 1) (xy -1 1)))) ' + TRACKS);
  const s = settings({ minTextHeight: 0.8, minSilkLineWidth: 0.1 });
  const t = withRules('(version 1)\n(rule a (constraint assertion "A.Layer == \'F.SilkS\'"))', () => T.inspectConstraints(d, "t1", s, FMT));
  assert.deepEqual(t.map((p) => p.title), ["Text Size", "Keepouts", "Assertions"]);
  const ts = t[0].lines.join("\n");
  assert.match(ts, /Checking board setup constraints silk text height: min 0\.8 mm\.\nUnconditional constraint applied\./);
  assert.match(ts, /Resolved height constraints: min 0\.8 mm; opt <i>undefined<\/i>; max <i>undefined<\/i>\./);
  assert.match(ts, /Text thickness resolution for:/);
  assert.match(t[2].lines.join("\n"), /Checking rule 'a'\.\nUnconditional rule applied\.\nChecking assertion 'A\.Layer == 'F\.SilkS''\.\nAssertion passed\./);
  const k = T.inspectConstraints(d, "s1", s, FMT).find((p) => p.title === "Keepouts").lines.join("\n");
  assert.match(k, /Checking keepout area 'KEEP'\.\nConstraint applied\./);
  assert.match(k, /Item <b>disallowed<\/b> at current location\.$/);
  // a via is not kept out by a tracks-only area
  const v = T.inspectConstraints(board('(zone (net 0) (net_name "") (layer "F.Cu") (uuid "ko") (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy -1 -1) (xy 11 -1) (xy 11 1) (xy -1 1)))) (via (at 1 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))'), "v1", s, FMT);
  const vk = v.find((p) => p.title === "Keepouts").lines.join("\n");
  assert.match(vk, /Checking keepout area\.\nKeepout constraint not met\./);
  assert.match(vk, /Item allowed at current location\.$/);
});

// ---------------------------------------------------------------- Clearance Resolution (#25)
test("Clearance Resolution: netclass, custom rule and board minimum on the one shared copper layer", () => {
  const d = board(TRACKS);
  const r = withRules('(version 1)\n(rule tight (constraint clearance (min 0.15mm)) (condition "A.NetName == \'VCC\'"))', () => T.inspectClearanceReport(d, "s1", "s2", settings(), "F.Cu", FMT));
  const titles = r.pages.map((p) => p.title);
  assert.equal(titles[0], "F.Cu", "one copper layer: a page named after it");
  assert.ok(titles.includes("Physical Clearances"));
  const t = r.pages[0].lines.join("\n");
  assert.match(t, /^<h7>Clearance resolution for:<\/h7>\n<ul><li>Layer F\.Cu<\/li><li>Track \[GND\] on F\.Cu, length 10\.0000 mm \[netclass Default\]<\/li><li>Track \[VCC\] on F\.Cu, length 10\.0000 mm \[netclass Default\]<\/li><\/ul>/);
  assert.match(t, /Checking netclass 'Default' clearance: 0\.2 mm\.\nConstraint applied\./);
  assert.match(t, /Checking rule 'tight' clearance: 0\.15 mm\.\nChecking rule condition 'A\.NetName == 'VCC''\.\nRule applied; overrides previous constraints\./, "conditions are commutative");
  assert.match(t, /Rule applied; overrides previous constraints\.\n\nResolved min clearance: 0\.15 mm\.$/, "a user rule ends EvalRules: no local clearance or board minimum after it");
  // without the rule the net class clearance stands and the board minimum is reported after it
  const n = T.inspectClearanceReport(d, "s1", "s2", settings(), "F.Cu", FMT).pages[0].lines.join("\n");
  assert.match(n, /Board minimum clearance: 0\.1 mm\.\n\nResolved min clearance: 0\.2 mm\.$/);
  // the implicit barcode separation rule always exists, so the page walks it and finds nothing in effect
  assert.match(r.pages.find((p) => p.title === "Physical Clearances").lines.join("\n"), /Checking barcode visual separation default clearance: 1 mm\.\nMembership not satisfied; constraint ignored\.\n\nNo 'physical_clearance' constraints in effect on F\.Cu\./);
});
test("Clearance Resolution: two shared layers give the Layer chooser; same net; empty group; hole page", () => {
  const d = board('(via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) (via (at 2 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "v2")) (via (at 4 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v3")) (group "" (uuid "g0") (members))');
  const r = T.inspectClearanceReport(d, "v1", "v2", settings(), "B.Cu", FMT);
  const cl = r.pages[0];
  assert.equal(cl.title, "Clearance"); assert.deepEqual(cl.layers.map((l) => l.name), ["B.Cu", "F.Cu"], "the active layer first");
  const hole = r.pages.find((p) => p.title === "Hole").lines.join("\n");
  assert.match(hole, /Hole clearance resolution for:/); assert.match(hole, /Hole-to-hole clearance resolution for:/);
  assert.match(T.inspectClearanceReport(d, "v1", "v3", settings(), "F.Cu", FMT).pages[0].layers[0].lines.join("\n"), /Items belong to the same net\. Min clearance is 0\./);
  const g = [...d.items.values()].find((it) => it.kind === "group");
  if (g) assert.deepEqual(T.inspectClearanceReport(d, g.id, "v1", settings(), "F.Cu", FMT), { error: "Cannot generate clearance report on empty group." });
});

// ---------------------------------------------------------------- the DRC marker pick and its legend (pcb-drc#A1)
test("A1: a marker over a track survives GuessSelectionCandidates (exact hit, much smaller area)", () => {
  const d = board(TRACKS);
  const pts = K.markerPolygon({ x: 5, y: 0 }, K.MARKER_SCALE.pcb);
  const kept = T.guessCandidates(d, ["s1"], [5 + 0.05, 0.05], { px: 0.01, activeLayer: "F.Cu", hidden: new Set(), marker: { pts, layer: "F.Cu" } });
  assert.deepEqual(kept, ["@marker"]);
  assert.deepEqual(T.guessCandidates(d, [], [5, 0], { marker: { pts } }), ["@marker"]);
});
test("A1: the error legend of a server marker comes from the items' copper", () => {
  const d = board(TRACKS);
  const u = (id) => K.uuidOf(d.items.get(id).node) || id;
  const p = T.markerPath(d, { code: "clearance", x: 5, y: 0.2, layer: "F.Cu", kiids: [u("s1"), u("s2")] });
  assert.ok(p); assert.ok(Math.abs(p[0][1] - 0.125) < 1e-6 && Math.abs(p[1][1] - 0.275) < 1e-6, JSON.stringify(p));
  assert.deepEqual(T.markerPath(d, { code: "shorting_items", x: 1, y: 2 }), [[1, 2], [1, 2]]);
  assert.equal(T.markerPath(d, { code: "silk_overlap", x: 1, y: 2 }), null);
});

// ---------------------------------------------------------------- the message panel of a selection (pcb-control-clipboard#11)
const rowsOf = (r) => Object.fromEntries(r.map((x) => [x.title, x.value]));
test("#11: two tracks give both descriptions, the resolved and actual clearance, their length and copper area", () => {
  const d = board(TRACKS);
  const r = T.msgPanelInfo(d, ["s1", "s2"], { settings: settings(), units: "mm", activeLayer: "F.Cu" });
  assert.equal(r[0].title, "Track [GND] on F.Cu, length 10.0000 mm"); assert.equal(r[0].value, "Track [VCC] on F.Cu, length 10.0000 mm");
  const m = rowsOf(r);
  assert.equal(m["Resolved Clearance"], "0.2000 mm"); assert.equal(m["Actual Clearance"], "0.1500 mm");
  assert.equal(m["Selected 2D Length"], "20.0000 mm");
  assert.match(m["Selected 2D Copper Area"], /^5\.\d{3} mm²$/);
  assert.ok(!("Pads" in m), "not the board summary");
  const custom = withRules('(version 1)\n(rule wide (condition "A.NetName == \'GND\'") (constraint clearance (min 0.3mm)))', () => rowsOf(T.msgPanelInfo(d, ["s1", "s2"], { settings: settings(), units: "mm" })));
  assert.equal(custom["Resolved Clearance"], "0.3000 mm");
});
test("#11: three items: the type count, the one netclass, no net when they differ; mixed types are broken down", () => {
  const d = board(TRACKS + '(segment (start 0 3) (end 5 3) (width 0.25) (layer "F.Cu") (net 1 "GND") (uuid "s3")) (gr_text "hi" (at 3 3 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15)))) (via (at 20 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1 "GND") (uuid "v1"))');
  const m = rowsOf(T.msgPanelInfo(d, ["s1", "s2", "s3"], { settings: settings(), units: "mm" }));
  assert.equal(m.Track, "3"); assert.equal(m["Resolved Netclass"], "Default"); assert.ok(!("Net" in m));
  assert.equal(m["Selected 2D Length"], "25.0000 mm");
  const mixed = rowsOf(T.msgPanelInfo(d, ["v1", "s1", "s3"], { settings: settings(), units: "mm" }));
  assert.equal(mixed["Selected Items"], "3 (Track: 2, Via: 1)"); assert.equal(mixed.Net, "GND");
  assert.equal(mixed["Selected 2D Length"], "15.0000 mm", "a via adds no 2D length");
  const txt = rowsOf(T.msgPanelInfo(d, ["t1", "s1", "s3"], { settings: settings(), units: "mm" }));
  assert.equal(txt["Selected Items"], "3 (Text: 1, Track: 2)"); assert.ok(!("Selected 2D Length" in txt), "text has no length");
  assert.ok("Selected 2D Total Area" in txt, "copper and silkscreen together");
});
test("#11: two pads of the same footprint and three equal pads", () => {
  const d = board('(footprint "Lib:R" (layer "F.Cu") (uuid "fp3") (at 0 0) (property "Reference" "R3" (at 0 -2 0) (layer "F.SilkS") (uuid "r3") (effects (font (size 1 1) (thickness 0.15)))) ' +
    '(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "q1")) (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "VCC") (uuid "q2")) (pad "3" smd rect (at 4 0) (size 1 1) (layers "F.Cu" "F.Mask") (net 2 "VCC") (uuid "q3")))');
  const fp = [...d.items.values()].find((it) => it.kind === "footprint");
  const two = rowsOf(T.msgPanelInfo(d, [fp.id + "#0", fp.id + "#1"], { settings: settings(), units: "mm" }));
  assert.equal(two["Actual Clearance"], "1.0000 mm"); assert.equal(two["Resolved Clearance"], "0.2000 mm");
  const m = rowsOf(T.msgPanelInfo(d, [fp.id + "#0", fp.id + "#1", fp.id + "#2"], { settings: settings(), units: "mm" }));
  assert.equal(m.Pad, "3"); assert.equal(m["Pad Shape"], "Rectangle"); assert.equal(m["Pad Size"], "1.0000 mm x 1.0000 mm");
  assert.ok(!("Selected 2D Length" in m));
  assert.match(m["Selected 2D Total Area"], /^6\.000 mm²$/, "three 1 mm² pads on F.Cu and on F.Mask");
});
test("#11: a hole and an edge in a pair; a diff pair track's gap and uncoupled-length rows", () => {
  const d = board('(via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1 "GND") (uuid "v1")) (segment (start 1 0) (end 5 0) (width 0.2) (layer "F.Cu") (net 2 "VCC") (uuid "s9")) (gr_line (start -5 3) (end 5 3) (layer "Edge.Cuts") (stroke (width 0.1) (type solid)) (uuid "e1"))');
  const m = rowsOf(T.msgPanelInfo(d, ["v1", "s9"], { settings: settings({ holeClearance: 0.25, edgeClearance: 0.5 }), units: "mm", activeLayer: "F.Cu" }));
  assert.equal(m["Resolved Hole Clearance"], "0.2500 mm"); assert.equal(m["Actual Hole Clearance"], "0.7500 mm");
  const e = rowsOf(T.msgPanelInfo(d, ["e1", "s9"], { settings: settings({ edgeClearance: 0.5 }), units: "mm", activeLayer: "F.Cu" }));
  assert.equal(e["Resolved Edge Clearance"], "0.5000 mm"); assert.ok(!("Resolved Clearance" in e));
  const dp = K.parseDoc(HEAD.replace('(net 2 "VCC") ', '(net 2 "VCC") (net 3 "D+") (net 4 "D-") ') + '(segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 3 "D+") (uuid "p1")) (segment (start 0 0.4) (end 10 0.4) (width 0.2) (layer "F.Cu") (net 4 "D-") (uuid "n1")))', "kicad_pcb");
  const r = withRules('(version 1)\n(rule dp (condition "A.inDiffPair(\'*\')") (constraint diff_pair_gap (min 0.1mm) (opt 0.15mm)) (constraint diff_pair_uncoupled (max 5mm)))', () => T.msgPanelInfo(dp, ["p1"], { settings: settings(), units: "mm" }));
  const gap = r.find((x) => /^DP Gap Constraints/.test(x.title));
  assert.ok(gap, JSON.stringify(r)); assert.equal(gap.title, "DP Gap Constraints: min 0.1000 mm; opt 0.1500 mm"); assert.equal(gap.value, "(from rule 'dp')");
  const unc = r.find((x) => /^DP Max Uncoupled-length/.test(x.title)); assert.equal(unc.title, "DP Max Uncoupled-length: 5.0000 mm");
});

// ---------------------------------------------------------------- browser DRC providers (pcb-drc#B1)
test("B1: CheckNetTies: footprint copper joining a pad outside the net-tie group shorts it", () => {
  const fp = (groups) => '(footprint "Lib:NT" (layer "F.Cu") (uuid "nt") (at 10 10) (attr smd) ' + groups +
    '(property "Reference" "NT1" (at 0 -2 0) (layer "F.SilkS") (uuid "ntr") (effects (font (size 1 1) (thickness 0.15)))) ' +
    '(fp_line (start -1 0) (end 3 0) (stroke (width 0.3) (type solid)) (layer "F.Cu") (uuid "bridge")) ' +
    '(pad "1" smd rect (at -1 0) (size 0.6 0.6) (layers "F.Cu") (net 1 "GND") (uuid "n1")) (pad "2" smd rect (at 1 0) (size 0.6 0.6) (layers "F.Cu") (net 2 "VCC") (uuid "n2")) (pad "3" smd rect (at 3 0) (size 0.6 0.6) (layers "F.Cu") (net 2 "VCC") (uuid "n3")))';
  const run = (g) => T.drc(board(fp(g)), settings()).filter((m) => m.code === "shorting_items" && /^Items shorting two nets$/.test(m.text));
  const m = run('(net_tie_pad_groups "1, 2") ');
  assert.equal(m.length, 1, JSON.stringify(m));
  assert.deepEqual(m[0].kiids, ["bridge", "n1", "n3"]);
  assert.ok(Math.abs(m[0].x - 11) < 0.2 && Math.abs(m[0].y - 10) < 0.2, JSON.stringify([m[0].x, m[0].y]));
  assert.equal(run('(net_tie_pad_groups "1, 2, 3") ').length, 0, "all three pads in one group");
});

test("B1: a net class name no rule can quote is reported (testUnquotableNetclasses) and has no implicit rules", () => {
  const s = Object.assign(T.designSettings({ net_settings: { classes: [{ name: "Default", clearance: 0.2 }, { name: "Odd\\", clearance: 0.3 }] } }), { minClearance: 0.1 });
  const m = T.drc(board(TRACKS), s).filter((x) => x.code === "generic_warning");
  assert.deepEqual(m.map((x) => x.text), ["Net class 'Odd\\' cannot be used in rules; its clearance and width are not checked"]);
  assert.equal(m[0].severity, "warning");
});

test("B1: physical_clearance and physical_hole_clearance rules whatever the nets; an internal clearance", () => {
  const d = board('(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net 1 "GND") (uuid "a1")) (segment (start 0 0.4) (end 10 0.4) (width 0.25) (layer "F.Cu") (net 1 "GND") (uuid "a2")) ' +
    '(via (at 20 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1 "GND") (uuid "v9")) (gr_line (start 19 0.6) (end 21 0.6) (layer "F.SilkS") (stroke (width 0.1) (type solid)) (uuid "silk")) ' +
    '(gr_poly (pts (xy 30 0) (xy 34 0) (xy 34 4) (xy 33.9 4) (xy 33.9 0.1) (xy 30 0.1)) (layer "F.Cu") (stroke (width 0.05) (type solid)) (fill no) (uuid "poly"))');
  const rules = "(version 1)\n(rule p (constraint physical_clearance (min 0.5mm)))\n(rule h (constraint physical_hole_clearance (min 1mm)))";
  const m = withRules(rules, () => T.drc(d, settings(), { rules }));
  const phys = m.filter((x) => /rule 'p'/.test(x.text));
  const tracks = phys.find((x) => x.code === "clearance" && x.kiids.includes("a1") && x.kiids.includes("a2"));
  assert.ok(tracks, JSON.stringify(m.map((x) => [x.code, x.text, x.kiids])));
  assert.equal(tracks.text, "Clearance violation (rule 'p' clearance 0.5000 mm; actual 0.1500 mm)");
  const hole = m.find((x) => x.code === "hole_clearance" && /rule 'h'/.test(x.text) && x.kiids.includes("silk"));
  assert.ok(hole, "the via's hole is too near the silkscreen line"); assert.match(hole.text, /^Hole clearance violation \(rule 'h' clearance 1\.0000 mm; actual 0\.4\d+ mm\)$/);
  const internal = m.filter((x) => /^Internal clearance violation \(rule 'p'/.test(x.text));
  assert.ok(internal.length >= 1 && internal.every((x) => x.kiids[0] === "poly"), JSON.stringify(internal));
  // without a physical rule (and no barcode) nothing of this
  assert.equal(T.drc(d, settings()).filter((x) => /rule 'p'|Internal clearance/.test(x.text)).length, 0);
});

// ---------------------------------------------------------------- zone hatch offsets (pcb-dialogs-tools#16)
test("#16: the Zones page's hatch offsets go to (setup (zone_defaults …)) before aux_axis_origin; null drops it", () => {
  const B = K.boardSetup;
  const setup = B.boardHeader('(kicad_pcb (version 20250302) (generator "t") (setup (pad_to_mask_clearance 0) (filling no) (aux_axis_origin 1 2)))').setup;
  const text = '(zone_defaults (property (layer "F.Cu") (hatch_position (xy 1.25 0))) (property (layer "B.Cu") (hatch_position (xy 0 0.5))))';
  const out = B.sectionText(B.editSetup(setup, { zoneDefaults: text }));
  assert.match(out, /\(filling no\)\s*\(zone_defaults \(property \(layer "F\.Cu"\) \(hatch_position \(xy 1\.25 0\)\)\) \(property \(layer "B\.Cu"\) \(hatch_position \(xy 0 0\.5\)\)\)\)\s*\(aux_axis_origin 1 2\)/);
  const again = B.boardHeader(`(kicad_pcb (version 1) ${out})`).setup;
  assert.ok(!/zone_defaults/.test(B.sectionText(B.editSetup(again, { zoneDefaults: null }))));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
