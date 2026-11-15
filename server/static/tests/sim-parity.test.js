// sim-parity.test.js — the SPICE netlist the simulator runs, against KiCad's exporter and ngspice:
//   * SIM_MODEL::InferSimModel (eeschema/sim/sim_model.cpp) on value-only passives and sources, as
//     SIM_LIB_MGR::CreateModel calls it on every symbol (also on one with Sim.Device / Sim.Type but no Sim.Params);
//   * the netlist NETLIST_EXPORTER_SPICE writes for KiCad's own simulation demos (demos/simulation), line by line,
//     each expectation read off the C++ (spice_generator.cpp, sim_model_source.cpp, sim_model_ideal.cpp, …);
//   * the simulator's copy for the WebAssembly ngspice (sim/ngspice-wasm.ts: POLY sources, unknown model parameters);
//   * KiCad's qa/tests/spice cases run through ngspice with the values test_netlist_exporter_spice.cpp expects, and
//     hand-computed results on the demos (an RC low-pass corner, an inverting op-amp's gain).
// Run: node server/static/tests/sim-parity.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
const { pathToFileURL } = require("url");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);
console.log("Simulator netlist parity under node");
const esbuild = require("esbuild");
const WEB = path.join(__dirname, "..", "..", "web");
const M = (() => {
  const out = esbuild.buildSync({ stdin: { contents: 'export * as SP from "./sim/spice-netlist"; export * as SL from "./dialogs/sim-model-logic"; export { NGSPICE } from "./dialogs/sim-model-ngspice"; export * as L from "./sim/sim-logic"; export * as SPICE from "./plugins/spice"; export * as BL from "./sim/builtin-libs"; export * as W from "./sim/ngspice-wasm";', resolveDir: WEB, loader: "ts" },
    bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
})();
const { SP, SL, L, W, BL } = M;
SL.setNgspiceData(M.NGSPICE);
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
const repo = (...p) => path.join(__dirname, "..", "..", "..", ...p);
const DEMOS = repo("demos", "simulation"), QA = repo("qa", "data", "eeschema", "spice_netlists");
const ALL = SP.OPTION_SAVE_ALL_VOLTAGES | SP.OPTION_SAVE_ALL_CURRENTS | SP.OPTION_SIM_COMMAND;

/** The netlist of a schematic file (its sub-sheets read from its folder), as the editor's export builds it. */
function exportFile(file, options = ALL) {
  const dir = path.dirname(file), name = path.basename(file, ".kicad_sch"), files = new Map();
  const get = (f) => {
    if (!files.has(f)) { const p = path.join(dir, f); if (!fs.existsSync(p)) files.set(f, null); else { const text = fs.readFileSync(p, "utf8"); files.set(f, { doc: K.parseDoc(text, "kicad_sch"), uuid: String((K.kid(K.parse(text), "uuid") || [])[1]), file: f }); } }
    return files.get(f);
  };
  const nl = N.buildNetlist(get(path.basename(file)), (f) => get(f), helpers, name);
  const sheets = nl.instances.map((i) => ({ index: i.index, uuidPath: i.uuidPath, doc: get(i.file).doc }));
  const { symbols, texts } = SP.readHierarchy({ sheets, netMap: nl.netMap, symbolPins: helpers.symbolPins, isPower: helpers.isPower, project: name });
  const msgs = []; let items = [];
  const out = SP.spiceNetlist({ symbols, texts, options, report: (m) => msgs.push(m), items: (l) => { items = l; }, library: (p) => {
    const b = BL.builtinLibrary(p); if (b !== null) return SL.parseSpiceLibrary(b);
    const f = path.join(dir, p.replace(/^\$\{KIPRJMOD\}\//, "")); return fs.existsSync(f) ? SL.parseSpiceLibrary(fs.readFileSync(f, "utf8")) : null; } });
  return { out, msgs, lines: out.split("\n"), items };
}
const fields = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const infer = (prefix, value, extra = {}, pins = ["1", "2"]) => SL.inferSimModel(prefix, pins, fields({ Value: value, ...extra }));

// ---------------------------------------------------------------- InferSimModel
test("InferSimModel: passives from the value alone (SI suffixes, R notation, units, µ, Meg, separators)", () => {
  const cases = [["R", "4k7", 'r="4.7k"'], ["R", "10k", 'r="10k"'], ["R", "2R2", 'r="2.2"'], ["R", "4.7kΩ", 'r="4.7k"'], ["R", "1M", 'r="1M"'], ["R", "1Meg", 'r="1M"'],
    ["R", "100 ohm", 'r="100"'], ["C", "100n", 'c="100n"'], ["C", "100nF", 'c="100n"'], ["C", "1µ", 'c="1u"'], ["C", "1μF", 'c="1u"'], ["C", "3,3u", 'c="3.3u"'],
    ["C", "3,300u", 'c="3300u"'], ["C", "0,47u", 'c="0.47u"'], ["C", "1UF", 'c="1U"'], ["L", "10mH", 'l="10m"'], ["L", "4u7", 'l="4.7u"']];
  for (const [p, v, want] of cases) {
    const r = infer(p, v);
    assert.ok(r.ok, `${p} ${v}`); assert.strictEqual(r.params, want, `${p} ${v}`);
    assert.strictEqual(r.deviceType, p); assert.strictEqual(r.modelType, ""); assert.strictEqual(r.pinMap, "1=+ 2=-");
  }
});
test("InferSimModel: a value that is no number is a behavioural passive (\"10k 1%\", \"2200uF;63V\", an expression)", () => {
  for (const [p, v] of [["R", "10k 1%"], ["C", "2200uF;63V"], ["R", "R = 'TIME > 300m ? 7 : 8'"]]) {
    const r = infer(p, v); assert.ok(r.ok); assert.strictEqual(r.modelType, "="); assert.strictEqual(r.params, `${p.toLowerCase()}="${v}"`);
  }
});
test("InferSimModel: sources from the value alone (\"5\", \"DC 5\", \"AC 1\", \"12V\", \"1mA\", \"sin(0 1 1k)\")", () => {
  const cases = [["V", "5", 'dc="5" '], ["V", "DC 5", 'dc="5" '], ["V", "AC 1", 'ac="1" '], ["V", "12V", 'dc="12" '], ["V", "2.345", 'dc="2.345" '], ["I", "1mA", 'dc="1m" '],
    ["V", "sin(0 1 1k)", 'dc="sin(0 1 1k)" '], ["V", "1,5V", 'dc="1.5" ']];
  for (const [p, v, want] of cases) {
    const r = infer(p, v); assert.ok(r.ok, v); assert.strictEqual(r.params, want, v); assert.strictEqual(r.deviceType, p); assert.strictEqual(r.modelType, "DC"); assert.strictEqual(r.pinMap, "1=+ 2=-");
  }
});
test("InferSimModel: Sim.Device V / Sim.Type DC without Sim.Params takes the value (Simulation_SPICE:VDC); other types and pin counts do not", () => {
  const r = infer("V", "12V", { "Sim.Device": "V", "Sim.Type": "DC", "Sim.Pins": "1=+ 2=-" });
  assert.ok(r.ok); assert.strictEqual(r.params, 'dc="12" '); assert.strictEqual(r.pinMap, "1=+ 2=-");
  const ac = infer("V", "1", { "Sim.Device": "V", "Sim.Type": "DC", "Sim.Params": "ac=1" });
  assert.strictEqual(ac.params, 'dc="1" ac=1', "the value comes first, the fields' parameters after it");
  assert.ok(!infer("V", "1", { "Sim.Device": "V", "Sim.Type": "SIN" }).ok);
  assert.ok(!infer("R", "10k", {}, ["1", "2", "3"]).ok, "only two-pin symbols");
  assert.ok(!infer("U", "10k").ok, "only R, L, C, V and I prefixes");
  assert.ok(!infer("R", "10k", { "Sim.Library": "x.lib", "Sim.Name": "R" }).ok, "a library model is not inferred");
  assert.strictEqual(infer("R", "10k", { "Sim.Params": "r=22k" }).params, "r=22k", "the fields' parameters win");
});
test("the netlist: a VDC with only its value (and one with Sim.Device/Sim.Type but no parameters) carries the value", () => {
  const sym = (ref, f, pins = [["1", "/a"], ["2", ""]]) => ({ ref, fields: fields({ Reference: ref, ...f }), pins: pins.map(([number, net]) => ({ number, net })) });
  const out = SP.spiceNetlist({ symbols: [sym("V1", { Value: "5" }), sym("V2", { Value: "12V", "Sim.Device": "V", "Sim.Type": "DC", "Sim.Pins": "1=+ 2=-" }), sym("R1", { Value: "4k7" }), sym("C1", { Value: "1µ" }),
    sym("V3", { Value: "sin(0 1 1k)" })], texts: [], options: 0, library: () => null });
  assert.ok(/^V1 \/a NC-1 DC 5 $/m.test(out), out);
  assert.ok(/^V2 \/a NC-2 DC 12 $/m.test(out), out);
  assert.ok(/^R1 \/a NC-3 4.7k$/m.test(out), out);
  assert.ok(/^C1 \/a NC-4 1u$/m.test(out), out);
  assert.ok(/^V3 \/a NC-5 DC sin\(0 1 1k\) $/m.test(out), out);
});
test("the netlist: a raw SPICE model that names no pins takes the symbol's pins in order (SPICE_GENERATOR_RAW_SPICE::ItemPins)", () => {
  const out = SP.spiceNetlist({ symbols: [{ ref: "Rload1", fields: fields({ Reference: "Rload1", Value: "~", "Sim.Device": "R", "Sim.Pins": "1=+ 2=-", "Sim.Params": "r='TIME > 350m ? 8 : 89'" }),
    pins: [{ number: "1", net: "/out" }, { number: "2", net: "GND" }] }], texts: [], options: 0, library: () => null });
  assert.ok(/^Rload1 \/out GND r='TIME > 350m \? 8 : 89'$/m.test(out), out);
});
test("the netlist: an ngspice model keeps its instance parameters (l=, w=) and its .model overrides", () => {
  const lib = SL.parseSpiceLibrary(".model pmos pmos(level=1 vto=0.5 kp=12e-6)\n");
  const out = SP.spiceNetlist({ symbols: [{ ref: "M1", fields: fields({ Reference: "M1", Value: "PMOS", "Sim.Library": "x.lib", "Sim.Name": "pmos", "Sim.Device": "PMOS", "Sim.Type": "MOS1", "Sim.Pins": "1=D 2=G 3=S 4=B", "Sim.Params": "l=1u w=1.4u" }),
    pins: ["1", "2", "3", "4"].map((n) => ({ number: n, net: "/n" + n })) }, { ref: "Q1", fields: fields({ Reference: "Q1", Value: "NPN", "Sim.Device": "NPN", "Sim.Type": "GUMMELPOON", "Sim.Pins": "1=C 2=B 3=E", "Sim.Params": "bf=200 is=1f" }),
    pins: ["1", "2", "3"].map((n) => ({ number: n, net: "/q" + n })) }], texts: [], options: 0, library: () => lib });
  assert.ok(/^M1 \/n1 \/n2 \/n3 \/n4 pmos l=1u w=1.4u$/m.test(out), out);
  assert.ok(/^\.model __Q1 NPN\n\+\s+is=1f\n\+\s+bf=200\n/m.test(out), out);
});
test("the netlist: ${KICAD*_SYMBOL_DIR}/Simulation_SPICE.sp is the installed library (kicad_builtin_opamp), included by its path", () => {
  assert.strictEqual(BL.expandIncludePath("${KICAD7_SYMBOL_DIR}/Simulation_SPICE.sp"), "/usr/share/kicad/symbols/Simulation_SPICE.sp");
  assert.strictEqual(BL.expandIncludePath("${KIPRJMOD}/models\\a.lib"), "models/a.lib");
  assert.ok(/\.subckt kicad_builtin_opamp in\+ in- vcc vee out/.test(BL.builtinLibrary("${KICAD10_SYMBOL_DIR}/Simulation_SPICE.sp")));
  assert.strictEqual(BL.builtinLibrary("${KIPRJMOD}/Simulation_SPICE.sp"), null);
});

// ---------------------------------------------------------------- SPICE_VALUE::ToSpiceString, the OP console
test("ToSpiceString: wxString::FromCDouble's %g of the normalised base, StripZeros, the SPICE prefix", () => {
  assert.strictEqual(L.toSpiceString(-2.69e-26), "-2.69e-11f");   // below the femto range: the digits stay
  assert.strictEqual(L.toSpiceString(1.234567e-3), "1.23457m");
  assert.strictEqual(L.toSpiceString(4700), "4.7k"); assert.strictEqual(L.toSpiceString(0), "0");
  assert.strictEqual(L.fromCDouble(1e-5), "1e-05"); assert.strictEqual(L.fromCDouble(123456789), "1.23457e+08"); assert.strictEqual(L.fromCDouble(0.0001), "0.0001");
  assert.strictEqual(L.formatValue(-2.69e-26, { precision: 3, range: "~V" }), "-2.69e-11fV");
});
test("CurrentNames: SPICE_GENERATOR_NGSPICE's terminals, a subcircuit's model pins, one I() otherwise", () => {
  const pins = (m, list) => { list.forEach((n, i) => m.pins.push({ name: n, symbolPinNumber: String(i + 1) })); return m; };
  const it = (ref) => ({ refName: ref, modelName: "", baseModelName: "" });
  assert.deepStrictEqual(SL.currentNames(SL.createModel("NPN_GUMMELPOON"), it("Q1")), ["I(Q1:c)", "I(Q1:b)", "I(Q1:e)"]);
  assert.deepStrictEqual(SL.currentNames(SL.createModel("NMOS_MOS1"), it("M1")), ["I(M1:d)", "I(M1:g)", "I(M1:s)"]);
  assert.deepStrictEqual(SL.currentNames(SL.createModel("D"), it("D1")), ["I(D1)"]);
  assert.deepStrictEqual(SL.currentNames(SL.createModel("R"), it("R1")), ["I(R1)"]);
  const sub = pins(new SL.SimModel("SUBCKT", "subckt"), ["in+", "in-", "vcc", "vee", "out"]);
  assert.deepStrictEqual(SL.currentNames(sub, it("U1")), ["I(XU1:in+)", "I(XU1:in-)", "I(XU1:vcc)", "I(XU1:vee)", "I(XU1:out)"]);
  assert.deepStrictEqual(SL.currentNames(pins(new SL.SimModel("SUBCKT", "subckt"), ["a", "b"]), it("X1")), ["I(X1)"]);
  assert.deepStrictEqual(L.currentNames({ name: "Q2", nodes: [] }), ["I(Q2:c)", "I(Q2:b)", "I(Q2:e)"]);
});

// ---------------------------------------------------------------- the demos, line by line
const demo = (rel) => path.join(DEMOS, rel);
const haveDemos = fs.existsSync(DEMOS);
function expectItems(rel, want, opts = {}) {
  const { out, msgs, lines } = exportFile(demo(rel));
  if (!opts.msgs) assert.deepStrictEqual(msgs, [], out);
  for (const w of want) assert.ok(lines.includes(w), `${rel}: no line ${JSON.stringify(w)} in\n${out}`);
  return out;
}
if (haveDemos) {
  test("demo rectifier: KiCad's netlist", () => {
    const out = expectItems("rectifier/rectifier.kicad_sch", [".title KiCad schematic", '.include "diode.mod"', ".save all", ".probe alli", ".tran 1u 10m",
      "V1 /signal_in GND DC 0 SIN( 0 1 1k 0 0 0 ) AC 1  ", "R1 /signal_in Net-_D1-A_ 1k", "D1 Net-_D1-A_ /rect_out 1N4148", "C1 /rect_out GND 100n", "R2 /rect_out GND 100k", ".end"]);
    assert.strictEqual(out.split("\n")[0], ".title KiCad schematic");
  });
  test("demo items: the transistors' and the op-amp's currents as their generators name them, model pins by symbol pin", () => {
    const amp = exportFile(demo("amplifier-ac/amplifier-ac.kicad_sch")).items.find((i) => i.ref === "Q1");
    assert.deepStrictEqual(amp.currents, ["I(Q1:c)", "I(Q1:b)", "I(Q1:e)"]);
    assert.deepStrictEqual(amp.pins, [{ symbolPin: "1", modelPin: "C" }, { symbolPin: "2", modelPin: "B" }, { symbolPin: "3", modelPin: "E" }]);
    const u1 = exportFile(demo("generic_models/generic_opamp_bip.kicad_sch")).items.find((i) => i.ref === "U1");
    assert.strictEqual(u1.name, "XU1");
    assert.deepStrictEqual(u1.currents, ["I(XU1:in+)", "I(XU1:in-)", "I(XU1:vcc)", "I(XU1:vee)", "I(XU1:out)"]);
  });
  test("demo amplifier-ac: the VDC with only Value 12V, 1UF / 10nF / 2.2k values, BJTs from the library", () => {
    expectItems("amplifier-ac/amplifier-ac.kicad_sch", ['.include "2n2222.model"', ".ac dec 100 10 1Meg", "V3 +12V GND DC 12 ", "C1 /VIN Net-_C1-Pad2_ 1U", "C4 VOUT Net-_C4-Pad2_ 10n",
      "R8 Net-_Q1-E_ GND 2.2k", "L1 Net-_C4-Pad2_ VOUT 100m", "Q1 VOUT /VBASE Net-_Q1-E_ Q2N2222", "V1 Net-_C1-Pad2_ GND DC 0 SIN( 0 1 1k 0 0 0 ) AC 1  "]);
  });
  test("demo sallen_key: Value ${SIM.PARAMS} resolved before inference, the supplies' values, the op-amp subcircuit", () => {
    expectItems("sallen_key/sallen_key.kicad_sch", ['.include "ad8051.lib"', ".ac dec 10 1 1Meg", ".control", "version", ".endc", "V1 Net-_R1-Pad2_ GND DC ac=1 AC 1  ", "V2 VDD GND DC 10 ", "V3 GND VSS DC 10 ",
      "XU1 Net-_U1-+_ /lowpass VDD VSS /lowpass AD8051", "R1 Net-_C1-Pad2_ Net-_R1-Pad2_ 1k", "C1 /lowpass Net-_C1-Pad2_ 100n", "C2 Net-_U1-+_ GND 100n"]);
  });
  test("demo v_i_sources: every source type (DC from the value, SIN, PULSE, EXP, PWL, AM/SFFM raw, noise, random)", () => {
    expectItems("v_i_sources/v_i_sources.kicad_sch", ["V2 /vdc GND DC 2.345 ", "I2 /idc GND DC 2.345 ", "V7 /vsin GND DC 0 SIN( 0 1 100Meg 1n 10G ) ", "V4 /vpulse GND PULSE( -1 1 2n 30n 2n 50n 100n ) ",
      "V3 /vexp GND EXP( -4 -1 2n 30n 60n 40n ) ", "V8 /vtrnoise GND TRNOISE( 100m 500p 0 0 0 0 0 ) AC 0 0 ", "V9 /vtrrandom GND TRRANDOM( 1 100ns 10ns 2 0 ) ",
      "V1 /vam GND am(0.5 1 10meg 50meg 20n)", "V6 /vsffm GND sffm(-5 1 100meg 5 10meg)", "V5 /vpwl GND pwl(0 -7 50n -7 51n -3 97n -4 171n -6.5 200n -6.5)"]);
  });
  test("demo generic_opamp_bip: the generic op-amp from ${KICAD7_SYMBOL_DIR}/Simulation_SPICE.sp, a built-in NPN", () => {
    expectItems("generic_models/generic_opamp_bip.kicad_sch", ['.include "/usr/share/kicad/symbols/Simulation_SPICE.sp"', ".model __Q1 NPN", "XU1 0 Net-_U1--_ +5V -5V /out kicad_builtin_opamp POLE=30 GAIN=100k VOFF=10u ROUT=10",
      "V2 +5V 0 DC 5 ", "V1 0 -5V DC 5 ", "Q1 Net-_Q1-C_ Net-_Q1-B_ Net-_Q1-E_ __Q1"]);
  });
  test("demo LM317 power supply: behavioural load (raw SPICE with the symbol's pins), library subcircuits", () => {
    expectItems("power_supplies/LM317_power_supply/power_supply.kicad_sch", ["Rload1 Net-_Rload1-Pad1_ GND r='TIME > 350m ? 8 : 89'", "XU1 /rect /adj /out LM317", "XT1 Net-_T1-AA_ Net-_T1-AB_ Net-_T1-SA_ Net-_T1-SB_ XFORMER",
      "V1 Net-_T1-AA_ Net-_T1-AB_ DC 0 SIN( 0 170 60 0 0 0 ) AC 170  ", "R3 Net-_T1-AB_ GND 1g"]);
  });
  test("demo subsheets: nets across the hierarchy (/subsheet1/in), a value-only source with pins 1=1 2=2", () => {
    expectItems("subsheets/mainsheet.kicad_sch", ["R1 /in /subsheet1/in 100", "C1 /subsheet1/in GND 1u", "R9 Net-_C3-Pad1_ /subsheet2/node 1k", "V1 GND /in DC SINE(0 1.5 1k 0 0 0 0) "]);
  });
  test("demo class-d: built-in BJTs, diodes and VDMOS get KiCad's .model lines, the subcircuit's parameters", () => {
    expectItems("class-d/Class-D.kicad_sch", [".model __Q5 PNP", ".model __Q2 VDMOS NCHAN", ".model __D2 D", "MQ2 /B+ Net-_D2-A_ /Vs __Q2", "D2 Net-_D2-A_ Net-_D2-K_ __D2",
      "XU1 /Ain /LO /B- /HO /Vs DAudioDriver freq=317k dtime=50n voutp=12 voutn=0", "V2 GND /B- DC 103 ", ".probe p(R15)"]);
  });
}

// ---------------------------------------------------------------- the simulator's reading of the netlist
test("the simulator's circuit: a .control block's commands are no elements (sallen_key's \"version\" is not a source)", () => {
  const c = L.readCircuit(".title x\nV1 a 0 DC 1\nR1 a b 1k\n.control\nversion\nlet x = 1\n.endc\n.ac dec 10 1 1Meg\n.end\n");
  assert.deepStrictEqual(c.items.map((i) => i.name), ["V1", "R1"]);
  assert.ok(c.directives.includes(".ac dec 10 1 1Meg"));
});
test("SPICE_VALUE::ToString: precision, auto range, and the shortest form of a value below the femto range", () => {
  assert.strictEqual(L.formatValue(8.971283830006410, { precision: 3, range: "~V" }), "8.97V");
  assert.strictEqual(L.formatValue(3.692116178111382e-03, { precision: 3, range: "~A" }), "3.69mA");
  assert.strictEqual(L.formatValue(0, { precision: 3, range: "~A" }), "0.00A");
  assert.strictEqual(L.formatValue(-2.6914e-31, { precision: 3, range: "~A" }), "-2.69e-16fA");
});

// ---------------------------------------------------------------- the simulator's copy for this ngspice
test("POLY sources become B sources with the SPICE2 coefficient order", () => {
  assert.strictEqual(W.polyToB("EOS 3 1 POLY(1) 53 98 1.7E-3 1"), "BEOS 3 1 V=(1.7E-3)+(1)*V(53,98)");
  assert.strictEqual(W.polyToB("EREF1 98 0 POLY(2) 99 0 50 0 0 0.5 0.5"), "BEREF1 98 0 V=(0.5)*V(99,0)+(0.5)*V(50,0)");
  assert.strictEqual(W.polyToB("G1 1 2 POLY(2) (3,0) (4,0) 0 1 2 3 4 5"), "BG1 1 2 I=(1)*V(3,0)+(2)*V(4,0)+(3)*V(3,0)*V(3,0)+(4)*V(3,0)*V(4,0)+(5)*V(4,0)*V(4,0)");
  assert.strictEqual(W.polyToB("fout1 0 99 poly(2) vo1 vcur1 -9.27e-3 1 -1"), "Bfout1 0 99 I=(-9.27e-3)+(1)*I(vo1)+(-1)*I(vcur1)");
  assert.strictEqual(W.polyToB("H1 a b POLY(1) Vx 0 0 2"), "BH1 a b V=(2)*I(Vx)*I(Vx)");
  assert.strictEqual(W.translatePoly("E1 1 0 POLY(1)\n+ 2 0 0 3\nR1 1 0 1k"), "BE1 1 0 V=(3)*V(2,0)\nR1 1 0 1k");
  assert.strictEqual(W.translatePoly("E1 1 0 2 0 3"), "E1 1 0 2 0 3");
});
test("a .model parameter the device does not have is left out with ngspice's warning; models it cannot check are left alone", () => {
  const warn = [];
  assert.strictEqual(W.dropUnknownModelParams(".model LASER D(Is=1e-22 Rs=6 N=1.5 Cjo=50p Xti=100 Iave=160m Vpk=5)", (w) => warn.push(w)), ".model LASER D(Is=1e-22 Rs=6 N=1.5 Cjo=50p Xti=100)");
  assert.deepStrictEqual(warn, ["Warning: Model issue: unrecognized parameter (iave) - ignored", "Warning: Model issue: unrecognized parameter (vpk) - ignored"]);
  assert.strictEqual(W.dropUnknownModelParams(".model Q1 NPN(IS=1f BF=100 VCEO=40\n+ MFG=X VAF=50)"), ".model Q1 NPN(IS=1f BF=100 VAF=50)");
  const keep = ".model SW1 SW(Ron=1 Roff=1Meg Vt=0.5 foo=1)\n.model pot potentiometer(r=1k)"; assert.strictEqual(W.dropUnknownModelParams(keep), keep);
  assert.strictEqual(W.forWasmNgspice("a\r\nb\rc"), "a\nb\nc");
});

// ---------------------------------------------------------------- through ngspice
const ENGINE = path.join(__dirname, "..", "dist", "pyodide", "ngspice.mjs");
let sp = null;
async function simulate(file, extra, pre) {
  const dir = path.dirname(file); const { out, msgs } = exportFile(file);
  for (const m of out.matchAll(/^\.include "([^"]+)"/gm)) {
    const b = BL.builtinLibrary(m[1]); if (b !== null) { sp.write(m[1], W.forWasmNgspice(b)); continue; }
    const f = path.join(dir, m[1]); if (fs.existsSync(f)) sp.write("/" + m[1], W.forWasmNgspice(fs.readFileSync(f, "utf8")));
  }
  let net = W.forWasmNgspice(out).replace(/^\.include "(?!\/)/gm, '.include "/'); if (extra) net = net.replace(/^\.end$/m, extra + "\n.end");
  sp.write("/t.cir", net);
  await sp.exec(["destroy all", "remcirc"]);
  const r = await sp.exec([...pre, "setseed 1", "source /t.cir", "run", "linearize"]);
  sp.remove("/o.raw"); await sp.exec(["set filetype=ascii", "write /o.raw"]);
  const raw = sp.read("/o.raw"); const plots = raw ? L.parseRaw(new TextDecoder().decode(raw)) : [];
  return { net, msgs, r, plot: plots[plots.length - 1] || null };
}
function at(plot, x, sig) {
  const xs = plot.vectors[0].re; let i = 0, best = Infinity; for (let k = 0; k < xs.length; k++) { const d = Math.abs(xs[k] - x); if (d < best) { best = d; i = k; } }
  const v = L.findVector(plot, sig); assert.ok(v, `no vector ${sig}`);
  return v.im ? Math.hypot(v.re[i], v.im[i]) : v.re[i];
}
// qa/tests/spice/test_netlist_exporter_spice.cpp: [x, {signal: value}] (x null: the operating point)
const QA_CASES = {
  rectifier: [[0, { "V(/in)": 0, "V(/out)": 0 }], [9250e-6, { "V(/in)": 5, "V(/out)": 4.26 }], [10e-3, { "V(/in)": 0, "V(/out)": 4.24 }]],
  opamp: [[0, { "V(/in)": 0, "V(/out)": 0 }], [250e-6, { "V(/in)": 500e-3, "V(/out)": 1 }], [500e-6, { "V(/in)": 0, "V(/out)": 0 }], [750e-6, { "V(/in)": -500e-3, "V(/out)": -1 }], [1e-3, { "V(/in)": 0, "V(/out)": 0 }]],
  npn_ce_amp: [[900e-6, { "V(/in)": 0, "V(/out)": 5.32 }], [925e-6, { "V(/in)": 10e-3, "V(/out)": 5.30 }], [950e-6, { "V(/in)": 0, "V(/out)": 5.88 }], [975e-6, { "V(/in)": -10e-3, "V(/out)": 5.91 }], [1e-3, { "V(/in)": 0, "V(/out)": 5.32 }]],
  rlc: [[9.43e-3, { "V(/Vp)": -19e-3, "I(Rs1)": 19e-3 }], [9.74e-3, { "V(/Vp)": 19e-3, "I(Rs1)": -19e-3 }]],
  tlines: [[910e-6, { "V(/z0_in)": 1, "V(/z0_out)": 0, "V(/rlgc_in)": 1, "V(/rlgc_out)": 0 }], [970e-6, { "V(/z0_in)": 0, "V(/z0_out)": 1, "V(/rlgc_in)": 0, "V(/rlgc_out)": 1 }]],
  cmos_not: [[0, { "V(/in)": 2.5, "V(/out)": 2.64 }], [250e-6, { "V(/in)": 5, "V(/out)": 0.013 }], [500e-6, { "V(/in)": 2.5, "V(/out)": 2.64 }], [750e-6, { "V(/in)": 0, "V(/out)": 5 }], [1e-3, { "V(/in)": 2.5, "V(/out)": 2.64 }]],
  fliege_filter: [[0.8e3, { "V(/in)": 1, "V(/out)": 1 }], [1.061e3, { "V(/in)": 1, "V(/out)": 0 }], [1.2e3, { "V(/in)": 1, "V(/out)": 1 }]],
  directives: [[9.25e-3, { "V(/in)": 1, "V(/out)": -900e-3, "I(XR1)": 1e-3 }], [9.50e-3, { "V(/in)": 0, "V(/out)": 0, "I(XR1)": 1e-3 }], [9.75e-3, { "V(/in)": -1, "V(/out)": 900e-3, "I(XR1)": 1e-3 }], [10e-3, { "V(/in)": 0, "V(/out)": 0, "I(XR1)": 1e-3 }]],
};
if (fs.existsSync(ENGINE)) {
  for (const [name, points] of Object.entries(QA_CASES)) {
    const file = path.join(QA, name, name + ".kicad_sch"); if (!fs.existsSync(file)) continue;
    test(`ngspice: qa ${name} gives test_netlist_exporter_spice.cpp's values`, async () => {
      const r = await simulate(file, "", ["set ngbehavior=ps"]);
      assert.ok(r.plot, r.r.err.join("\n") + "\n" + r.net);
      // TestTranPoint / TestACPoint: within MAX_DEFAULT_REL_ERROR (2e-2) of the reference, absolutely
      for (const [x, sigs] of points) for (const [s, want] of Object.entries(sigs)) { const got = at(r.plot, x, s); assert.ok(Math.abs(got - want) <= 2e-2 + Math.abs(want) * 0.02, `${s} at ${x}: ${got}, KiCad's QA expects ${want}`); }
    });
  }
  if (haveDemos) {
    test("ngspice: demo rectifier's TRAN — the peak follows the input less one diode drop", async () => {
      const r = await simulate(demo("rectifier/rectifier.kicad_sch"), "", ["set ngbehavior=ltpsa"]);
      assert.ok(r.plot && /transient/i.test(r.plot.plotname), r.r.err.join("\n"));
      const out = L.findVector(r.plot, "V(/rect_out)").re, vin = L.findVector(r.plot, "V(/signal_in)").re;
      const peakOut = Math.max(...out), peakIn = Math.max(...vin);
      assert.ok(Math.abs(peakIn - 1) < 1e-3, `input peak ${peakIn}`);
      assert.ok(peakOut > 0.2 && peakOut < peakIn - 0.3, `output peak ${peakOut}: 1 V less a 1N4148 drop`);
    });
    test("ngspice: demo sallen_key's AC — a 2nd-order low-pass, 0 dB in the passband, corner where the RC sets it", async () => {
      const r = await simulate(demo("sallen_key/sallen_key.kicad_sch"), "", ["set ngbehavior=ltpsa"]);
      assert.ok(r.plot && /ac/i.test(r.plot.plotname), r.r.err.join("\n"));
      const g = (f) => 20 * Math.log10(at(r.plot, f, "V(/lowpass)"));
      assert.ok(Math.abs(g(10)) < 0.1, `passband ${g(10)} dB`);
      // unity-gain Sallen-Key, R1=R2=1k, C1=C2=100n: f0 = 1/(2π·RC) = 1.59 kHz, Q = 0.5 → −6 dB at f0
      const f0 = 1 / (2 * Math.PI * 1e3 * 100e-9);
      assert.ok(Math.abs(g(f0) + 6) < 0.8, `gain at f0=${f0.toFixed(0)} Hz: ${g(f0)} dB`);
      assert.ok(g(1e5) < -60, `stop band ${g(1e5)} dB`);
    });
    test("ngspice: demo generic_opamp_bip's AC — the inverting stage's gain is R1/R2 = 100k/10k (20 dB)", async () => {
      const r = await simulate(demo("generic_models/generic_opamp_bip.kicad_sch"), ".ac dec 10 1 100Meg", ["set ngbehavior=ltpsa"]);
      assert.ok(r.plot, r.r.err.join("\n"));
      const g = 20 * Math.log10(at(r.plot, 100, "V(/out)") / at(r.plot, 100, "V(/in)"));
      assert.ok(Math.abs(g - 20) < 0.1, `gain ${g} dB`);
    });
    test("ngspice: .probe alli writes the currents CurrentNames names (I(Q1:c), I(XU1:out)) and findVector finds them", async () => {
      const r = await simulate(demo("amplifier-ac/amplifier-ac.kicad_sch"), ".tran 10u 1m", ["set ngbehavior=ltpsa"]);
      assert.ok(r.plot, r.r.err.join("\n"));
      for (const s of ["I(Q1:c)", "I(Q1:b)", "I(Q1:e)"]) assert.ok(L.findVector(r.plot, s), `${s} not in ${r.plot.vectors.map((v) => v.name).join(" ")}`);
      const o = await simulate(demo("generic_models/generic_opamp_bip.kicad_sch"), ".tran 10u 1m", ["set ngbehavior=ltpsa"]);
      assert.ok(o.plot, o.r.err.join("\n"));
      for (const s of ["I(XU1:out)", "I(XU1:in+)"]) assert.ok(L.findVector(o.plot, s), `${s} not in ${o.plot.vectors.map((v) => v.name).join(" ")}`);
    });
    test("ngspice: demo laser_driver's TRAN runs (POLY sources, the laser diode's extra model parameters)", async () => {
      const r = await simulate(demo("laser_driver/laser_driver.kicad_sch"), "", ["set ngbehavior=ltpsa"]);
      assert.ok(r.plot && /transient/i.test(r.plot.plotname), r.r.err.join("\n"));
      const id = L.findVector(r.plot, "I(D1)"); assert.ok(id, r.plot.vectors.map((v) => v.name).join(" "));
      assert.ok(Math.max(...id.re) > 0.3, `laser current peak ${Math.max(...id.re)}`);
    });
  }
} else console.log("  (ngspice runtime not built: the simulation cases are skipped)");

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 8).join("\n       ")); }
    if (!sp && fs.existsSync(ENGINE) && queue.findIndex((q) => q[0] === name) === queue.findIndex((q) => /^ngspice/.test(q[0])) - 1) sp = await M.SPICE.open(pathToFileURL(ENGINE).href);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
