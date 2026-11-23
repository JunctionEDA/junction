// transline.test.js — common/transline_calculations ported to web/domains/pcb/calculator/transline.ts (MICROSTRIP,
// STRIPLINE, COUPLED_MICROSTRIP, COUPLED_STRIPLINE, DIELECTRIC_DJORDJEVIC_SARKAR, the soldermask correction) and the
// Tuning Profiles calculator of Board Setup (pcbnew/dialogs/panel_setup_tuning_profile_info.cpp
// calculateTrackParametersForCell and friends, web/domains/pcb/editor/pcbdialogs/tuning-profile-calc.ts).
// The reference numbers come from the KiCad C++ compiled as it is and driven with the same parameters.
// Run: node server/static/tests/transline.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const B = globalThis.KiCadCanvas.boardSetup;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const TL = load(["calculator", "transline.ts"]);
const TP = load(["editor", "pcbdialogs", "tuning-profile-calc.ts"]);
const P = TL.TCP;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
const rel = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

const RHO = 1.72e-8, skin = (f) => 1.0 / Math.sqrt(Math.PI * f * TL.MU0 / RHO);
const set = (c, o) => { for (const [k, v] of Object.entries(o)) c.SetParameter(P[k], v); };

test("MICROSTRIP synthesis, with and without the soldermask cover, matches KiCad", () => {
  const c = new TL.MICROSTRIP();
  set(c, { PHYS_WIDTH: 0.001, SIGMA: 1 / RHO, EPSILON_EFF: 1, SKIN_DEPTH: skin(1e9), EPSILONR: 4.5, H_T: 1e20, H: 0.00048, T: 0.000035, Z0: 50, FREQUENCY: 1e9, ROUGH: 0, TAND: 0.02, PHYS_LEN: 10, MUR: 1, MURC: 1, ANG_L: 1 });
  assert.equal(c.Synthesize(TL.SYNTHESIZE_OPTS.DEFAULT), true);
  let r = c.GetSynthesisResults();
  rel(r.get(P.PHYS_WIDTH)[0], 0.000875954173931); rel(r.get(P.UNIT_PROP_DELAY)[0], 60.5802194558);
  assert.equal(r.get(P.PHYS_WIDTH)[1], TL.TRANSLINE_STATUS.OK);
  set(c, { SOLDERMASK_PRESENT: 1, SOLDERMASK_THICKNESS: 0.00001, SOLDERMASK_EPSILONR: 3.3, SOLDERMASK_TAND: 0, PHYS_WIDTH: 0.001, Z0: 50 });
  c.Synthesize(TL.SYNTHESIZE_OPTS.DEFAULT); r = c.GetSynthesisResults();
  rel(r.get(P.PHYS_WIDTH)[0], 0.000871480230542); rel(r.get(P.UNIT_PROP_DELAY)[0], 60.7432757581);
  // a parameter the calculation does not use is refused, as m_parameters.at() throws
  assert.throws(() => c.SetParameter(P.PHYS_S, 1));
});

test("STRIPLINE synthesis matches KiCad; zero width is a warning on analysis", () => {
  const c = new TL.STRIPLINE();
  set(c, { PHYS_WIDTH: 0.001, SKIN_DEPTH: skin(1), EPSILONR: 4.5, T: 0.000035, STRIPLINE_A: 0.00048, H: 0.00048 * 2 + 0.000035, Z0: 50, PHYS_LEN: 1, FREQUENCY: 1e9, TAND: 0.02, ANG_L: 1, SIGMA: 1 / RHO, MURC: 1 });
  c.Synthesize(TL.SYNTHESIZE_OPTS.DEFAULT);
  const r = c.GetSynthesisResults();
  rel(r.get(P.PHYS_WIDTH)[0], 0.000372965137571); rel(r.get(P.UNIT_PROP_DELAY)[0], 70.9471686809);
  c.SetParameter(P.PHYS_WIDTH, 0); c.Analyse();
  assert.equal(c.GetAnalysisResults().get(P.PHYS_WIDTH)[1], TL.TRANSLINE_STATUS.WARNING);
});

test("COUPLED_MICROSTRIP fixed-spacing and fixed-width synthesis match KiCad", () => {
  const c = new TL.COUPLED_MICROSTRIP();
  set(c, { Z0_E: 50, Z0_O: 50, Z_DIFF: 100, PHYS_WIDTH: 0, PHYS_S: 0.0002, EPSILONR: 4.5, PHYS_LEN: 10, H: 0.00048, T: 0.000035, H_T: 1e20, FREQUENCY: 1e9, MURC: 1, SKIN_DEPTH: skin(1), SIGMA: 1 / RHO, ROUGH: 0, TAND: 0.02, ANG_L: 1 });
  c.Synthesize(TL.SYNTHESIZE_OPTS.FIX_SPACING);
  let r = c.GetSynthesisResults();
  rel(r.get(P.PHYS_WIDTH)[0], 0.000468364244499); rel(r.get(P.PHYS_S)[0], 0.0002); rel(r.get(P.UNIT_PROP_DELAY_ODD)[0], 56.9070353266);
  set(c, { Z0_E: 50, Z0_O: 50, PHYS_WIDTH: 0.0002, PHYS_S: 0 });
  c.Synthesize(TL.SYNTHESIZE_OPTS.FIX_WIDTH);
  r = c.GetSynthesisResults();
  rel(r.get(P.PHYS_S)[0], 6.97742989228e-05); rel(r.get(P.UNIT_PROP_DELAY_ODD)[0], 55.9826927176);
});

test("COUPLED_STRIPLINE centred synthesis and offset (image method) analysis match KiCad", () => {
  const c = new TL.COUPLED_STRIPLINE();
  const H = 0.00048 * 2 + 0.000035, A = 0.00048 + 0.0000175;
  assert.equal(TL.COUPLED_STRIPLINE.IsCenteredOffset(A, H), true);
  set(c, { Z0_E: 50, Z0_O: 50, Z_DIFF: 100, PHYS_WIDTH: 0, PHYS_S: 0.0002, T: 0.000035, H, STRIPLINE_A: 0, EPSILONR: 4.5, SKIN_DEPTH: skin(1), PHYS_LEN: 1, FREQUENCY: 1e9, ANG_L: 1, SIGMA: 1 / RHO, MURC: 1 });
  c.Synthesize(TL.SYNTHESIZE_OPTS.FIX_SPACING);
  const r = c.GetSynthesisResults();
  rel(r.get(P.PHYS_WIDTH)[0], 0.000168039643091); rel(r.get(P.UNIT_PROP_DELAY_ODD)[0], 70.9471686809);
  set(c, { STRIPLINE_A: 0.0003, Z0_O: 50, PHYS_WIDTH: 0.0002, PHYS_S: 0.0002 });
  c.Analyse();
  const a = c.GetAnalysisResults();
  rel(a.get(P.Z0_O)[0], 45.2416536647); rel(a.get(P.Z0_E)[0], 71.0546605148);
});

test("DIELECTRIC_DJORDJEVIC_SARKAR fit matches KiCad and refuses a spec frequency outside the band", () => {
  const d = new TL.DIELECTRIC_DJORDJEVIC_SARKAR();
  d.Fit(4.5, 0.02, 1e9);
  rel(d.EpsilonRealAt(5e9), 4.4077278868); rel(d.TanDeltaAt(5e9), 0.0203666653844);
  rel(d.EpsilonRealAt(1e9), 4.5); rel(d.TanDeltaAt(1e9), 0.02);
  assert.throws(() => new TL.DIELECTRIC_DJORDJEVIC_SARKAR().Fit(4.5, 0.02, 10));
});

// ---------------------------------------------------------------- the Tuning Profiles calculator
const NAMES = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"];
const ENABLED = ["F.SilkS", "F.Paste", "F.Mask", "F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "B.Mask", "B.Paste", "B.SilkS"];
const STACK = TP.defaultStackup(ENABLED, 4, 1.6);
const inp = (type, z, extra) => Object.assign({ type, targetImpedance: z, frequency: 1e9, modelSolderMask: false, layerNames: NAMES, stackup: STACK }, extra || {});
const row = (signal, top, bottom, width = NaN, gap = NaN) => ({ signal, top, bottom, width, gap });

test("BuildDefaultStackupList: masks, 35 µm copper and the dielectrics splitting the rest of 1.6 mm", () => {
  assert.deepEqual(STACK.map((i) => [i.type, i.layer, i.subs[0].thickness]), [["silkscreen", "F.SilkS", 0], ["solderpaste", "F.Paste", 0], ["soldermask", "F.Mask", 10000], ["copper", "F.Cu", 35000],
    ["dielectric", null, 480000], ["copper", "In1.Cu", 35000], ["dielectric", null, 480000], ["copper", "In2.Cu", 35000], ["dielectric", null, 480000], ["copper", "B.Cu", 35000],
    ["soldermask", "B.Mask", 10000], ["solderpaste", "B.Paste", 0], ["silkscreen", "B.SilkS", 0]]);
  assert.equal(STACK[4].subs[0].epsilonR, 4.5); assert.equal(STACK[4].subs[0].lossTangent, 0.02); assert.equal(STACK[2].subs[0].epsilonR, 3.3);
});

test("calculateTrackParametersForCell: single microstrip and stripline width and delay", () => {
  const c = new TP.TuningProfileCalculator();
  assert.deepEqual(c.calculateTrackParametersForCell(row("F.Cu", "", "In1.Cu"), "width", inp(0, 50)), { width: 875954, delay: 6058021 });
  assert.deepEqual(c.calculateTrackParametersForCell(row("In1.Cu", "F.Cu", "In2.Cu"), "width", inp(0, 50)), { width: 372965, delay: 7094716 });
  // delay from the width in the row
  const d = c.calculateTrackParametersForCell(row("F.Cu", "", "In1.Cu", 0.875954), "delay", inp(0, 50));
  assert.deepEqual(Object.keys(d), ["delay"]); assert.ok(Math.abs(d.delay - 6058021) < 5);
  // the solder mask over the outer layer
  assert.deepEqual(c.calculateTrackParametersForCell(row("F.Cu", "", "In1.Cu"), "width", inp(0, 50, { modelSolderMask: true })), { width: 871480, delay: 6074327 });
});

test("calculateTrackParametersForCell: differential microstrip and stripline width, gap and delay", () => {
  const c = new TP.TuningProfileCalculator();
  assert.deepEqual(c.calculateTrackParametersForCell(row("F.Cu", "", "In1.Cu", NaN, 0.2), "width", inp(1, 100)), { width: 468364, delay: 5690703 });
  assert.deepEqual(c.calculateTrackParametersForCell(row("F.Cu", "", "In1.Cu", 0.2, NaN), "gap", inp(1, 100)), { gap: 69774, delay: 5598269 });
  assert.deepEqual(c.calculateTrackParametersForCell(row("In1.Cu", "F.Cu", "In2.Cu", NaN, 0.2), "width", inp(1, 100)), { width: 168039, delay: 7094716 });
  assert.deepEqual(c.calculateTrackParametersForCell(row("In1.Cu", "F.Cu", "In2.Cu", 0.2, 0.2), "delay", inp(1, 100)), { delay: 7094716 });
});

test("calculateTrackParametersForCell: KiCad's error messages", () => {
  const c = new TP.TuningProfileCalculator();
  const err = (r, col, i) => c.calculateTrackParametersForCell(r, col, i);
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "width", inp(0, 0)), { error: "Error: Target impedance must be greater than 0" });
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "width", inp(0, NaN)), { error: "Error: Target impedance must be greater than 0" });
  assert.deepEqual(err(row("F.Cu", "", ""), "width", inp(0, 50)), { error: "Error: Reference layer not found in stackup" });
  assert.deepEqual(err(row("In1.Cu", "", "In2.Cu"), "width", inp(0, 50)), { error: "Error: Top reference layer not found in stackup" });
  assert.deepEqual(err(row("In1.Cu", "In2.Cu", "B.Cu"), "width", inp(0, 50)), { error: "Error: Top reference layer must be above signal layer in board stackup" });
  assert.deepEqual(err(row("In1.Cu", "F.Cu", ""), "width", inp(0, 50)), { error: "Error: Bottom reference layer not found in stackup" });
  assert.deepEqual(err(row("In2.Cu", "F.Cu", "In1.Cu"), "width", inp(0, 50)), { error: "Error: Bottom reference layer must be below signal layer in board stackup" });
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "width", inp(1, 100)), { error: "Error: Diff pair gap must be greater than 0 to calculate width" });
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "gap", inp(1, 100)), { error: "Error: Width must be greater than 0 to calculate diff pair gap" });
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu", 0.2), "delay", inp(1, 100)), { error: "Error: Width and diff pair gap must be greater than 0 to calculate delay" });
  // a zero width analysed: the width status is a warning, "Width calculation failed"
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "delay", inp(0, 50)), { error: "Error: Width calculation failed" });
  // no dielectric between the signal and its reference
  const thin = STACK.map((it) => (it.type === "dielectric" ? { ...it, subs: [{ ...it.subs[0], thickness: 0 }] } : it));
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "width", inp(0, 50, { stackup: thin })), { error: "Error: Dielectric height must be greater than 0" });
  assert.deepEqual(err(row("In1.Cu", "F.Cu", "In2.Cu"), "width", inp(0, 50, { stackup: thin })), { error: "Error: Dielectric heights must be greater than 0" });
  const noCu = STACK.map((it) => (it.layer === "F.Cu" ? { ...it, subs: [{ ...it.subs[0], thickness: 0 }] } : it));
  assert.deepEqual(err(row("F.Cu", "", "In1.Cu"), "width", inp(0, 50, { stackup: noCu })), { error: "Error: Signal layer thickness must be greater than 0" });
  // a signal layer that is not a copper layer of the board does nothing
  assert.equal(err(row("In5.Cu", "", ""), "width", inp(0, 50)), null);
});

test("the board's (stackup …): parser defaults and a Djordjevic-Sarkar dielectric evaluated at the profile frequency", () => {
  const setup = KiCadParse(`(setup (stackup (layer "F.Mask" (type "Top Solder Mask") (thickness 0.02)) (layer "F.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 1" (type "core") (thickness 0.2) (material "FR4") (epsilon_r 4.2) (loss_tangent 0.02) (spec_frequency 1000000000) (dielectric_model djordjevic_sarkar))
    (layer "B.Cu" (type "copper") (thickness 0.035)) (layer "B.Mask" (type "Bottom Solder Mask") (thickness 0.01))))`);
  const st = TP.stackupFromLayers(B.stackupLayers(setup));
  assert.deepEqual(st.map((i) => i.type), ["soldermask", "copper", "dielectric", "copper", "soldermask"]);
  assert.equal(st[0].subs[0].epsilonR, 3.3); assert.equal(st[0].subs[0].thickness, 20000);
  assert.equal(st[2].subs[0].model, "djordjevic_sarkar");
  const info = TP.TuningProfileCalculator.calculateAverageDielectricConstants(st, [2], 5e9);
  const ds = new TL.DIELECTRIC_DJORDJEVIC_SARKAR(); ds.Fit(4.2, 0.02, 1e9);
  rel(info.E_r, ds.EpsilonRealAt(5e9)); rel(info.Height, 0.0002);
  const at1G = TP.TuningProfileCalculator.calculateAverageDielectricConstants(st, [2], 1e9);
  rel(at1G.E_r, 4.2);
  const mask = TP.TuningProfileCalculator.getSolderMaskParameters(st, "F.Cu");
  rel(mask.Height, 0.00002); assert.equal(mask.E_r, 3.3);
  assert.deepEqual(TP.TuningProfileCalculator.getSolderMaskParameters(st, "In1.Cu"), { Height: 0, E_r: 0, Loss_Tangent: 0 });
});

test("OnAddTrackRow: the next signal layer between its neighbours, wrapping to the front", () => {
  assert.deepEqual(TP.newTrackRowLayers(NAMES, null), { signal: "F.Cu", top: "", bottom: "In1.Cu" });
  assert.deepEqual(TP.newTrackRowLayers(NAMES, "F.Cu"), { signal: "In1.Cu", top: "F.Cu", bottom: "In2.Cu" });
  assert.deepEqual(TP.newTrackRowLayers(NAMES, "In2.Cu"), { signal: "B.Cu", top: "In2.Cu", bottom: "" });
  assert.deepEqual(TP.newTrackRowLayers(NAMES, "B.Cu"), { signal: "F.Cu", top: "", bottom: "In1.Cu" });
  assert.deepEqual(TP.newTrackRowLayers(NAMES, "In9.Cu"), { signal: "", top: "", bottom: "" });
  assert.equal(TP.isCopperLayerLowerThan("B.Cu", "In2.Cu"), true); assert.equal(TP.isCopperLayerLowerThan("In1.Cu", "In2.Cu"), false); assert.equal(TP.isCopperLayerLowerThan("In2.Cu", "F.Cu"), true);
});

function KiCadParse(text) { return globalThis.KiCadCanvas.parse ? globalThis.KiCadCanvas.parse(text) : load(["canvas", "sexpr.ts"]).parse(text); }

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
