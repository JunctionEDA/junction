// length-delay.test.js — LENGTH_DELAY_CALCULATION and the tuner's routed baseline (pcb-tools.js, after
// pcbnew/length_delay_calculation/*.cpp, pcbnew/router/pns_topology.cpp AssembleTuningPath, pns_meander_placer*.cpp
// calculateTimeDomainTargets, pcbnew/generators/pcb_tuning_pattern.cpp), the tuning profile DRC rules
// (drc_engine.cpp loadImplicitRules, drc_test_provider_misc.cpp), arcs in tuned lines, the time domain in the Tuning
// Pattern Properties dialog (web/domains/pcb/editor/routersettings.ts) and the stackup's spec frequency / dielectric
// model (web/domains/pcb/canvas/board-setup.ts).
// Run: node server/static/tests/length-delay.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, B = K.boardSetup;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// SIG: pad U1 (F.Cu, die 2 mm / 3 ps) — a dog-leg into the pad — via — B.Cu track — pad U2 (B.Cu)
const BOARD = `(kicad_pcb (version 20251024) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "SIG") (net 2 "GND")
  (footprint "R" (layer "F.Cu") (at 10 10) (uuid "fp1") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "SIG") (die_length 2) (die_delay 3) (uuid "p1")))
  (footprint "R" (layer "B.Cu") (at 30 10) (uuid "fp2") (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (net 1 "SIG") (uuid "p2")))
  (segment (start 10 10) (end 10.4 10.4) (width 0.2) (layer "F.Cu") (net 1) (uuid "a1"))
  (segment (start 10.4 10.4) (end 20 10) (width 0.2) (layer "F.Cu") (net 1) (uuid "a2"))
  (via (at 20 10) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1"))
  (segment (start 20 10) (end 30 10) (width 0.2) (layer "B.Cu") (net 1) (uuid "b1"))
)`;
const PRO = (extra) => Object.assign({
  board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 }, rule_severities: {} } },
  net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, tuning_profile: "P" }] },
  tuning_profiles: { tuning_profiles_impedance_geometric: [{ profile_name: "P", type: 0, enable_time_domain_tuning: true, via_prop_delay: 5000,
    layer_entries: [{ signal_layer: "F.Cu", width: 200000, diff_pair_gap: 0, delay: 6000 }, { signal_layer: "B.Cu", width: 200000, diff_pair_gap: 0, delay: 7000 }] }] },
}, extra || {});
const doc = () => K.parseDoc(BOARD, "kicad_pcb");
const VIA_H = 1.58;   // the default 2-layer stackup between F.Cu and B.Cu (with height in lengths)
// the dog-leg cut at the pad's edge (x = 10.5) then straight to the pad's centre (OptimiseTraceInPad)
const yEdge = 10.4 - 0.1 * (0.4 / 9.6), LEG_F = Math.hypot(0.5, yEdge - 10) + Math.hypot(9.5, yEdge - 10);

test("AssembleTuningPath: pad to pad through the via, the lines clipped in the pad and the via", () => {
  const d = doc(), s = P.designSettings(PRO()); const ld = P.ldContext(d, s);
  const path = P.assembleTuningPath(ld, "b1");
  assert.deepEqual(path.items.map((i) => i.kind), ["line", "via", "line"]);
  assert.ok(path.startPad && path.endPad, "both end pads found");
  assert.deepEqual(path.items[0].ln.ids.slice().sort(), ["a1", "a2"]);
  near(P.origPathLength(ld, path), LEG_F + VIA_H + 10 + 2);   // routed (with the via's stackup height) + pad-to-die
});
test("origPathDelay: track delays per layer, via delay over the stackup height, the pad's die delay", () => {
  const d = doc(), s = P.designSettings(PRO()); const ld = P.ldContext(d, s);
  const path = P.assembleTuningPath(ld, "a1");
  const want = Math.trunc(6000 * LEG_F) + Math.trunc(5000 * VIA_H) + Math.trunc(7000 * 10) + 3e6;
  assert.ok(Math.abs(P.origPathDelay(ld, path) - want) <= 2, `${P.origPathDelay(ld, path)} vs ${want}`);
  near(P.lengthForDelay(ld, 6e6, { net: "SIG", layer: "F.Cu" }), 1000);   // 6000 as/mm: 6 ps take 1000 mm
});
test("a profile without time domain tuning gives no delay; a missing profile is reported", () => {
  const pro = PRO(); pro.tuning_profiles.tuning_profiles_impedance_geometric[0].enable_time_domain_tuning = false;
  const s = P.designSettings(pro); const ld = P.ldContext(doc(), s);
  assert.equal(P.origPathDelay(ld, P.assembleTuningPath(ld, "b1")), 3e6);   // the pad's die delay only
  const s2 = P.designSettings(PRO({ net_settings: { classes: [{ name: "Default", clearance: 0.2, track_width: 0.25 }, { name: "HS", tuning_profile: "Nope" }] } }));
  const m = P.missingTuningProfileMarkers(s2);
  assert.equal(m.length, 1); assert.equal(m[0].code, "missing_tuning_profile");
  assert.equal(m[0].text, "Missing tuning profile (Net Class: HS, Tuning Profile: Nope)");
});
test("calculateTimeDomainTargets: the length target moves by the track the delay difference takes", () => {
  const s = P.designSettings(PRO()); const ld = P.ldContext(doc(), s);
  const st = P.meanderDefaults(); st.isTimeDomain = true; P.setTargetLengthDelay(st, 200e6);   // 200 ps, ±0.1 ps
  P.timeDomainTargets(ld, st, { net: "SIG", layer: "F.Cu", width: 0.2, coupled: false, gap: 0 }, { length: 20e6, delay: 200e6 - 60000 });
  // 60000 as more at 6000 as/mm: 10 mm more; the 0.1 ps tolerance is 1e5 / 6000 mm each way
  near(st.target.opt, 30e6, 1); near(st.target.min, 30e6 - Math.trunc(0.1e6 / 6000 * 1e6), 2); near(st.target.max, 30e6 + Math.trunc(0.1e6 / 6000 * 1e6), 2);
});
test("calculateTimeDomainTargets with a net chain delay target: the chain's other nets come off the target and the current delay", () => {
  const s = P.designSettings(PRO()); const ld = P.ldContext(doc(), s); const C = P.tuningChain;
  const st = P.meanderDefaults(); st.isTimeDomain = true; C.setTargetSignalLengthDelay(st, 500e6);   // the chain: 500 ps, ±0.1 ps
  // MEANDER_PLACER: origPathDelay carries the 300 ps of the chain's other nets; the net's own share is 200 ps against 200 ps - 60000 as
  P.timeDomainTargets(ld, st, { net: "SIG", layer: "F.Cu", width: 0.2, coupled: false, gap: 0 }, { length: 20e6, delay: 500e6 - 60000 }, null, 300e6);
  near(st.target.opt, 30e6, 1); near(st.target.min, 30e6 - Math.trunc(0.1e6 / 6000 * 1e6), 2);
  // without the chain target the net's own delay target is measured against the whole origPathDelay
  const st2 = P.meanderDefaults(); st2.isTimeDomain = true; P.setTargetLengthDelay(st2, 500e6);
  P.timeDomainTargets(ld, st2, { net: "SIG", layer: "F.Cu", width: 0.2, coupled: false, gap: 0 }, { length: 20e6, delay: 500e6 - 60000 }, null, 300e6);
  near(st2.target.opt, 30e6, 1);
});
test("tuning profile rules: track width on the profile's layers, named after the profile", () => {
  const pro = PRO(); pro.board.design_settings.rule_severities = { tuning_profile_track_geometries: "error" };
  pro.tuning_profiles.tuning_profiles_impedance_geometric[0].layer_entries[0].width = 300000;   // F.Cu wants 0.3 mm
  const s = P.designSettings(pro); const d = doc();
  const rules = P.tuningProfileRules(s, d);
  assert.ok(rules.length >= 2 && rules.every((r) => r.implicit && r.name === "tuning profile 'P'"));
  const tw = P.drc(d, s, { unconnected: false, outline: false }).filter((m) => m.code === "track_width");
  assert.deepEqual(tw.map((m) => m.ids[0]).sort(), ["a1", "a2"]);   // the B.Cu track is 0.2 as its entry wants
  assert.match(tw[0].text, /^Track width \(tuning profile 'P' min width 0\.3000 mm; actual 0\.2000 mm\)$/);
  // the default severity (ignore) leaves the tracks alone
  const s0 = P.designSettings(Object.assign(PRO(), { tuning_profiles: pro.tuning_profiles }));
  assert.equal(P.drc(d, s0, { unconnected: false, outline: false }).filter((m) => m.code === "track_width").length, 0);
});
test("tuning profile rules: a differential profile adds the pair's width, gap and (under the class clearance) clearance", () => {
  const pro = PRO(); const tp = pro.tuning_profiles.tuning_profiles_impedance_geometric[0]; tp.type = 1;
  tp.layer_entries = [{ signal_layer: "F.Cu", width: 200000, diff_pair_gap: 150000, delay: 0 }];
  const rules = P.tuningProfileRules(P.designSettings(pro), doc());
  assert.deepEqual(rules.map((r) => r.constraints[0].type), ["track_width", "diff_pair_gap", "clearance"]);
  assert.equal(rules[1].constraints[0].min, 0.15); assert.equal(rules[2].constraints[0].min, 0.15);
  assert.match(rules[2].condition, /AB\.isCoupledDiffPair\(\)/);
});
test("splitChain keeps arcs: the stretch between two points cut into sub-arcs", () => {
  const IU = 1e6; const ch = [{ p: [0, 0] }, { p: [10 * IU, 0] }, { p: [20 * IU, 10 * IU], m: [10 * IU + 10 * IU * Math.SQRT1_2, 10 * IU - 10 * IU * Math.SQRT1_2] }];
  const sp = P.splitChain(ch, [5 * IU, 0], [20 * IU, 10 * IU]);
  assert.equal(sp.mid.length, 3); assert.ok(sp.mid[2].m, "the arc is still an arc");
  near(P.chLength(sp.mid), 5 * IU + Math.PI / 2 * 10 * IU, 2);
});
test("meanderMove over a line with an arc: the arc stays, the straight part meanders", () => {
  const IU = 1e6; const r = 10 * IU, c = [40 * IU, 10 * IU];
  const ch = [{ p: [0, 0] }, { p: [40 * IU, 0] }, { p: [50 * IU, 10 * IU], m: [c[0] + r * Math.SQRT1_2, c[1] - r * Math.SQRT1_2] }];
  const st = P.meanderDefaults(); P.setTargetLength(st, 70 * IU); st.keepEndpoints = true;
  const len0 = P.chLength(ch);
  const res = P.meanderMove({ pts: ch.map((n) => n.p), ch, origin: [0, 0], end: [50 * IU, 10 * IU], cursor: [20 * IU, 5 * IU], st, width: 0.2 * IU, clearance: 0.2 * IU, lineLength: len0 });
  assert.ok(res.hasMeanders);
  assert.ok(res.final.some((n) => n.m && Math.abs(Math.hypot(n.p[0] - 50 * IU, n.p[1] - 10 * IU)) < 1), "the arc ends the tuned line");
  near(res.length, P.chLength(res.final), 2);
});
test("base_line with arcs: (arc (start) (mid) (end)) written and read back", () => {
  const ch = [{ p: [0, 0] }, { p: [10, 0] }, { p: [20, 10], m: [17.071068, 2.928932] }, { p: [20, 20] }];
  const t = P.polyPtsText(ch);
  assert.equal(t, "(pts (xy 0 0) (arc (start 10 0) (mid 17.071068 2.928932) (end 20 10)) (xy 20 20))");
  const gen = { node: K.parse(`(generated (type tuning_pattern) (layer "F.Cu") (base_line ${t}) (is_time_domain yes) (target_delay 120) (target_delay_min 119.9) (target_delay_max 120.1))`) };
  const info = P.tuningPatternInfo(gen);
  assert.equal(info.baseCh.length, 4); assert.deepEqual(info.baseCh[2].m, [17.071068, 2.928932]);
  assert.equal(info.st.isTimeDomain, true); assert.equal(info.st.targetDelay.opt, 120e6); assert.equal(info.st.targetDelay.min, 119.9e6);
});
test("Tuning Pattern Properties: Length / Delay radios choose the enabled target; delay targets in ps", () => {
  const RS = load(["editor", "routersettings.ts"]);
  const base = { targetLength: 25, minAmp: 0.2, maxAmp: 1, spacing: 0.6, round: true, crPct: 80, singleSided: false, overrideCustomRules: false, isTimeDomain: true, targetDelay: 150 };
  const f = RS.tuneForm("single", base);
  assert.equal(f.targetEnabled(), false); assert.equal(f.delayEnabled(), true); assert.equal(f.targetText("mm"), ""); assert.equal(f.delayText(), "150");
  assert.equal(RS.tuneForm("diff_pair_skew", base).delayLabel, "Target Skew Delay: ");
  const ruled = RS.tuneForm("single", Object.assign({}, base, { constraint: "rule 'x'" }));
  assert.equal(ruled.modeEnabled(), false); assert.equal(ruled.delayEnabled(), false);
  assert.ok(f.setDelay("200")); const out = f.result(); assert.equal(out.targetDelay, 200); assert.equal(out.targetLength, null);
  const st = P.meanderDefaults(); P.applyTuneSettings(st, out, "single");
  assert.equal(st.isTimeDomain, true); assert.equal(st.targetDelay.opt, 200e6); near(st.targetDelay.max - st.targetDelay.opt, 0.1e6);
  const view = P.tuneSettingsView(st, "single"); assert.equal(view.isTimeDomain, true); assert.equal(view.targetDelay, 200);
});
test("tuning pattern node: is_time_domain and the delay targets as the pattern holds them", () => {
  const st = P.meanderDefaults(); st.isTimeDomain = true; P.setTargetLengthDelay(st, 150e6);
  const res = { final: [], tuned: [], status: "tuned", length: 0, delay: 0, hasMeanders: true, settings: st, baseline: [{ p: [0, 0] }, { p: [10e6, 0] }] };
  const n = P.tuningPatternNode({ st, dpGap: 0.2, netName: "SIG", width: 0.2, mode: "single", layer: "F.Cu" }, res, []);
  const v = (k) => K.kid(n, k);
  assert.equal(K.str(v("is_time_domain")[1]), "yes"); assert.equal(K.num(v("target_delay")[1]), 150); assert.equal(K.num(v("target_delay_min")[1]), 149.9);
});
test("stackup: Spec Freq and Dielectric Model read, written, left out where an older file implies them", () => {
  const setup = B.boardHeader(`(kicad_pcb (version 20240108) (generator "t") (setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 1" (type "core") (thickness 1.51) (material "FR4") (epsilon_r 4.5) (loss_tangent 0.02) (spec_frequency 2000000000) (dielectric_model djordjevic_sarkar))
    (layer "B.Cu" (type "copper") (thickness 0.035)))))`).setup;
  const L = B.stackupLayers(setup); const d = L.find((l) => l.name === "dielectric 1");
  assert.equal(d.specFreq, 2e9); assert.equal(d.dielectricModel, "djordjevic_sarkar");
  assert.match(B.stackupText(L, B.boardFinish(setup), false, false, 20240108), /\(loss_tangent 0\.02\) \(spec_frequency 2000000000\) \(dielectric_model djordjevic_sarkar\)\)/);
  d.specFreq = 1e9; d.dielectricModel = "constant";
  assert.doesNotMatch(B.stackupText(L, B.boardFinish(setup), false, false, 20240108), /spec_frequency/);   // implied by the older format
  assert.match(B.stackupText(L, B.boardFinish(setup), false, false, 20260511), /\(spec_frequency 1000000000\) \(dielectric_model constant\)/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
