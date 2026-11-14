// schdlg.test.js — schematic dialogs parity: Sheet Pin Properties (DIALOG_SHEET_PIN_PROPERTIES) and the logic behind
// the simulator, library-link, update-from-PCB, setup and preference pages added with it.
// Run: node server/static/tests/schdlg.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas;
const L = load(["dialogs", "sch-items-logic.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

const SHEET = `(sheet (at 100 50) (size 40 30) (uuid "s")
  (property "Sheetname" "sub" (at 100 49 0) (effects (font (size 1.27 1.27))))
  (pin "VPP" input (at 100 60 180) (uuid "p1") (effects (font (size 1.524 1.524)) (justify left)))
  (pin "CLK/IN" output (at 140 70 0) (uuid "p2") (effects (font (face "Arial") (size 1.27 1.27) (italic yes)) (justify right))))`;

test("readSheetPin: name, shape token, text width as size, face, bold / italic", () => {
  const n = K.parse(SHEET), pins = L.kids(n, "pin");
  assert.deepEqual(L.readSheetPin(pins[0]), { text: "VPP", shape: "input", font: L.KICAD_FONT, size: 1.524, bold: false, italic: false, color: null });
  const b = L.readSheetPin(pins[1]); assert.equal(b.shape, "output"); assert.equal(b.font, "Arial"); assert.equal(b.italic, true);
});
test("writeSheetPin: escapes '/', writes the shape in place (no (shape …)), size w = h, bold", () => {
  const n = K.parse(SHEET), pin = L.kids(n, "pin")[0];
  L.writeSheetPin(pin, { text: "A/B", shape: "tri_state", font: L.KICAD_FONT, size: 2, bold: true, italic: false, color: null });
  const out = K.serialize(pin);
  assert.ok(/^\(pin "A\{slash\}B" tri_state/.test(out), out);
  assert.ok(!/\(shape/.test(out));
  assert.ok(/\(size 2 2\)/.test(out), out); assert.ok(/\(bold yes\)/.test(out), out);
});
test("sheetPinNameError: an empty or blank name is refused", () => {
  assert.equal(L.sheetPinNameError("  "), "Sheet pin name can not be empty.");
  assert.equal(L.sheetPinNameError("X"), null);
});
test("sheetPinAt: a left-edge pin reads rightwards into the sheet, a right-edge one leftwards", () => {
  const n = K.parse(SHEET);
  assert.equal(L.sheetPinAt(n, [100.5, 60]), 0);
  assert.equal(L.sheetPinAt(n, [103, 60.3]), 0);
  assert.equal(L.sheetPinAt(n, [98, 60]), -1);
  assert.equal(L.sheetPinAt(n, [138, 70]), 1);
  assert.equal(L.sheetPinAt(n, [141.5, 70]), -1);
  assert.equal(L.sheetPinAt(n, [120, 55]), -1);
});


// ---------------------------------------------------------------- simulator logic
const SL = load(["sim", "sim-logic.ts"]);
test("SPICE_VALUE: parse with SPICE prefixes, ToSpiceString normalised", () => {
  assert.equal(SL.parseSpiceValue("10u"), 10e-6); assert.equal(SL.parseSpiceValue("1Meg"), 1e6); assert.equal(SL.parseSpiceValue("2.2k"), 2200);
  assert.equal(SL.parseSpiceValue("5m"), 5e-3); assert.ok(Number.isNaN(SL.parseSpiceValue("abc")));
  assert.equal(SL.toSpiceString(1e-6), "1u"); assert.equal(SL.toSpiceString(4700), "4.7k"); assert.equal(SL.toSpiceString(1e7), "10Meg"); assert.equal(SL.toSpiceString(0.25), "250m");
  assert.equal(SL.spiceText("1000"), "1k");
});
test("SPICE_VALUE::ToString with a format: auto range, fixed range, degrees", () => {
  assert.equal(SL.formatValue(0.0012345, { precision: 3, range: "~V" }), "1.23mV");
  assert.equal(SL.formatValue(2500, { precision: 2, range: "KHz" }), "2.5KHz");
  assert.equal(SL.formatValue(190, { precision: 1, range: "°" }), "-170.0°");
  assert.deepEqual(SL.formatFromString(""), { precision: 3, range: "~V" });
  assert.equal(SL.formatToString(SL.updateUnits({ precision: 4, range: "~V" }, "s")), "4~s");
});
test("DIALOG_SIM_COMMAND: .tran with optional fields, uic defaulting the max step", () => {
  assert.equal(SL.tranCommand({ step: "1u", final: "1m", initial: "", maxStep: "", uic: false }), ".tran 1u 1m");
  assert.equal(SL.tranCommand({ step: "1u", final: "1m", initial: "", maxStep: "", uic: true }), ".tran 1u 1m 0 1u uic");
  assert.equal(SL.tranCommand({ step: "10u", final: "1m", initial: "0.1m", maxStep: "5u", uic: false }), ".tran 10u 1m 100u 5u");
});
test("DIALOG_SIM_COMMAND: .ac / .dc / .noise / .pz / fft and their errors", () => {
  assert.equal(SL.acCommand({ scale: "dec", points: "10", fStart: "1", fStop: "1Meg" }), ".ac dec 10 1 1Meg");
  assert.equal(SL.dcCommand({ src1: { type: "V", source: "V1", start: "0", stop: "5", incr: "0.1" }, src2: null }), ".dc V1 0 5 100m");
  assert.deepEqual(SL.dcCommand({ src1: { type: "V", source: "V1", start: "0", stop: "5", incr: "1" }, src2: { type: "V", source: "V1", start: "0", stop: "1", incr: "1" } }), { error: "Source 1 and Source 2 must be different." });
  assert.deepEqual(SL.dcCommand({ src1: { type: "V", source: "", start: "0", stop: "5", incr: "1" }, src2: null }), { error: "A DC source must be specified." });
  assert.equal(SL.noiseCommand({ meas: "/out", ref: "", src: "V1", scale: "dec", points: "10", fStart: "1", fStop: "1k", saveAll: false }), ".noise v(/out) V1 dec 10 1 1k");
  assert.deepEqual(SL.noiseCommand({ meas: "/out", ref: "", src: "V1", scale: "dec", points: "10", fStart: "", fStop: "1k", saveAll: false }), { error: "A frequency range must be specified." });
  assert.equal(SL.pzCommand({ input: "in", inputRef: "0", output: "out", outputRef: "0", func: "vol", find: "pz" }), ".pz in 0 out 0 vol pz");
  assert.equal(SL.fftCommand({ signals: ["V(a)", "V(b)"], linearize: true }), "linearize V(a) V(b)\nfft V(a) V(b)");
});
test("parseCommand round-trips the pages; CommandToSimType", () => {
  assert.equal(SL.commandToSimType(".tran 1u 1m"), "TRAN"); assert.equal(SL.commandToSimType(".op"), "OP"); assert.equal(SL.commandToSimType("linearize v(a)\nfft v(a)"), "FFT"); assert.equal(SL.commandToSimType(".foo"), "Custom");
  const t = SL.parseCommand(".tran 1u 1m 0 1u uic").tran; assert.deepEqual(t, { step: "1u", final: "1m", initial: "0", maxStep: "1u", uic: true });
  const d = SL.parseCommand(".dc V1 0 5 0.1 TEMP 0 100 10").dc; assert.equal(d.src1.source, "V1"); assert.equal(d.src1.incr, "100m"); assert.equal(d.src2.type, "TEMP");
  const n = SL.parseCommand(".noise v(/out,/ref) V1 oct 5 10 100k 1").noise; assert.deepEqual(n, { meas: "/out", ref: "/ref", src: "V1", scale: "oct", points: "5", fStart: "10", fStop: "100k", saveAll: true });
  assert.deepEqual(SL.parseCommand(".ac lin 100 1k 10k").ac, { scale: "lin", points: "100", fStart: "1k", fStop: "10k" });
});
test("the circuit, signals list and vector names", () => {
  const c = SL.readCircuit(".title t\nV1 /in 0 DC 1\nR1 /in /out 1k\nC1 /out 0 1u\nQ1 /c /b 0 BC547\n.subckt X a b\nR9 a b 1\n.ends\n.save v(/x)\n.end\n");
  assert.deepEqual(c.items.map((i) => i.name), ["V1", "R1", "C1", "Q1"]);
  assert.deepEqual(c.nets, ["/b", "/c", "/in", "/out", "0"]);
  const s = SL.signalsFor("TRAN", c, SL.DEFAULT_OPTIONS);
  assert.ok(s.includes("V(/out)") && !s.includes("V(0)") && s.includes("I(R1)") && s.includes("Ic(Q1)") && s.includes("P(R1)") && s.includes("V(/X)"));
  assert.ok(SL.signalsFor("AC", c, SL.DEFAULT_OPTIONS).includes("V(/out) (gain)"));
  assert.deepEqual(SL.vectorToSignal("r1#branch"), { signal: "I(r1)", kind: "I" });
  assert.deepEqual(SL.vectorToSignal("r1:power"), { signal: "P(r1)", kind: "P" });
  assert.deepEqual(SL.vectorToSignal("v(/out)"), { signal: "V(/out)", kind: "V" });
  assert.equal(SL.signalExpr("P(R1)"), "r1:power"); assert.equal(SL.signalExpr("Ic(Q1)"), "@q1[ic]");
});
test("ngspice ASCII raw: real and complex plots, lookup by signal", () => {
  const raw = "Title: t\nDate: x\nPlotname: Transient Analysis\nFlags: real\nNo. Variables: 3\nNo. Points: 2\nVariables:\n\t0\ttime\ttime\n\t1\tv(/out)\tvoltage\n\t2\ti(r1)\tcurrent\nValues:\n 0\t0.0\n\t1.5\n\t-2e-3\n\n 1\t1e-6\n\t2.5\n\t-1e-3\n" +
    "Title: t\nPlotname: AC Analysis\nFlags: complex\nNo. Variables: 2\nNo. Points: 1\nVariables:\n\t0\tfrequency\tfrequency\n\t1\tv(/out)\tvoltage\nValues:\n 0\t1.0,0.0\n\t0.0,1.0\n";
  const p = SL.parseRaw(raw); assert.equal(p.length, 2);
  assert.deepEqual(Array.from(SL.findVector(p[0], "V(/out)").re), [1.5, 2.5]);
  assert.deepEqual(Array.from(SL.findVector(p[0], "I(R1)").re), [-2e-3, -1e-3]);
  const v = SL.findVector(p[1], "V(/out)"); assert.ok(p[1].complex);
  assert.equal(Math.round(SL.acPart(v, "phase")[0]), 90); assert.equal(SL.acPart(v, "gain")[0], 0);
  assert.equal(SL.interpolate([0, 1, 2], [0, 10, 20], 1.5), 15);
});
test("measurements: units, meas line, rows from the signal grid", () => {
  assert.equal(SL.measurementUnits("MAX V(/out)", "TRAN"), "V"); assert.equal(SL.measurementUnits("MAX_AT V(/out)", "AC"), "Hz");
  assert.equal(SL.measurementUnits("INTEG P(R1)", "TRAN"), "J"); assert.equal(SL.measurementUnits("RMS I(R1)", "TRAN"), "A");
  assert.equal(SL.measCommand("AVG P(R1)", "TRAN", 2), "meas TRAN meas_result_2 AVG R1:power");
  assert.equal(SL.measurementFor("MAX", "V(/out) (gain)"), "MAX vdb(/out)"); assert.equal(SL.measurementFor("MAX", "V(/out) (phase)"), null);
});
test("workbook options <-> command lines; user signals; E series", () => {
  const cmds = SL.commandsFromOptions(".tran 1u 1m", SL.DEFAULT_OPTIONS); assert.deepEqual(cmds, [".tran 1u 1m", ".kicad adjustpaths", ".save all", ".probe alli", ".probe allp"]);
  assert.deepEqual(SL.optionsFromCommands(cmds), { command: ".tran 1u 1m", options: SL.DEFAULT_OPTIONS });
  assert.equal(SL.userSignalLet(0, "V(/a)-V(/b)*P(R1)"), "let user0 = v(/a)-v(/b)*r1:power");
  assert.equal(SL.snapToSeries(4600, 24), 4700); assert.equal(SL.eSeries(96).length, 96);
});

module.exports = { test, load, K };
process.on("exit", () => { console.log(`schdlg: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; });
