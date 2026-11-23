// creepage-chain-drc.test.js — KiCad parity round 3, creepage and net chain DRC and the SPICE model ERC:
//   * DRC_TEST_PROVIDER_CREEPAGE over the creepage graph (drc_creepage_utils.cpp): the shortest path along the board
//     between two nets, around board edge cut-outs, NPTH holes and slots, the rule of the path's end items, the
//     marker's error legend shapes;
//   * DRC_TEST_PROVIDER_MATCHED_LENGTH's net chain checks: net_chain_length over the chain's trunk (CHAIN_TOPOLOGY,
//     bridged across the footprints), stub_length of the branches off the trunk, return_path on a reference layer;
//   * ERC_TESTER::TestSimModelIssues: each symbol's model created (SIM_LIB_MGR::CreateModel), its messages a marker at it.
// Run: node server/static/tests/creepage-chain-drc.test.js
"use strict";
const assert = require("assert/strict");
const path = require("path");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, T = globalThis.PcbTools, sch = globalThis.CollabTools.sch;
const SP = load(["sim", "spice-netlist.ts"]), SL = load(["dialogs", "sim-model-logic.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("creepage, net chain DRC and SPICE model ERC");

const HEAD = '(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user)) (setup) (net 0 "") (net 1 "GND") (net 2 "VCC") ';
const board = (body) => K.parseDoc(HEAD + body + ")", "kicad_pcb");
const settings = () => Object.assign(T.designSettings({ net_settings: { classes: [{ name: "Default", track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, clearance: 0.2 }] } }), { minClearance: 0.1 });
const drcWith = (d, rules, code) => { T.setCustomRules(rules); try { return T.drc(d, settings(), { rules }).filter((m) => m.code === code); } finally { T.setCustomRules(null); } };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const actualOf = (m) => +/actual ([\d.]+) mm/.exec(m.text)[1];

// ---------------------------------------------------------------- creepage
const OUTLINE = '(gr_rect (start 0 0) (end 20 10) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "e1")) ';
const SLOT = '(gr_rect (start 9.9 0.5) (end 10.1 8) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") (uuid "e2")) ';
const TRACKS = '(segment (start 5 2) (end 9.5 2) (width 0.25) (layer "F.Cu") (net 1 "GND") (uuid "s1")) (segment (start 10.5 2) (end 15 2) (width 0.25) (layer "F.Cu") (net 2 "VCC") (uuid "s2")) ';
const CR = (mm) => `(version 1)\n(rule cr (constraint creepage (min ${mm}mm)))`;

test("creepage: two tracks across open board creep the straight gap (no rule, no check; a short path is not reported)", () => {
  const d = board(OUTLINE + TRACKS);
  assert.equal(drcWith(d, "(version 1)", "creepage").length, 0, "no creepage rule: the test does not run");
  const m = drcWith(d, CR(3), "creepage");
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "Creepage violation (rule 'cr' creepage 3.0000 mm; actual 0.7500 mm)");
  assert.deepEqual(m[0].ids.slice().sort(), ["s1", "s2"]);
  assert.equal(m[0].layer, "F.Cu");
  assert.deepEqual(m[0].pathShapes, [{ t: "seg", a: [9.625, 2], b: [10.375, 2] }]);
  assert.equal(drcWith(d, CR(0.7), "creepage").length, 0, "longer than the constraint: no violation");
});

test("creepage: a cut-out between the nets makes the path go round it (tangent, along the edge, tangent)", () => {
  const d = board(OUTLINE + SLOT + TRACKS);
  assert.equal(drcWith(d, CR(3), "creepage").length, 0, "round the slot is longer than 3 mm");
  const m = drcWith(d, CR(12), "creepage");
  assert.equal(m.length, 1);
  // from the track end caps (r 0.125 at x 9.5 and 10.5) to the slot's top corners, and across its 0.2 mm top
  const leg = Math.hypot(0.4, 1.5) - 0.125;
  assert.ok(near(actualOf(m[0]), +(2 * leg + 0.2).toFixed(4)), m[0].text);
  assert.equal(m[0].pathShapes.length, 3);
  assert.ok(m[0].pathShapes.every((p) => p.t === "seg"));
  assert.ok(near(m[0].x, 10.467792) && near(m[0].y, 1.879221), "the marker at the second connection's far end");
});

const FP = (hole) => '(footprint "L:X" (layer "F.Cu") (uuid "fp1") (at 10 5) (pad "1" smd rect (at -2 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "p1")) (pad "2" smd circle (at 2 0) (size 1 1) (layers "F.Cu") (net 2 "VCC") (uuid "p2"))' + hole + ') ';
const PADRULES = `(version 1)\n(rule cr (constraint creepage (min 8mm)))\n(rule c2 (condition "A.Type == 'Pad'") (constraint creepage (min 9mm)))`;

test("creepage: a conditional rule is evaluated on the items at the path's ends (pads)", () => {
  const m = drcWith(board(OUTLINE + FP("")), PADRULES, "creepage");
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "Creepage violation (rule 'c2' creepage 9.0000 mm; actual 3.0000 mm)");
});

test("creepage: an NPTH hole is board edge (a circle the path wraps round, drawn as an arc in the legend)", () => {
  const m = drcWith(board(OUTLINE + FP(' (pad "" np_thru_hole circle (at 0 0) (size 2 2) (drill 2) (layers "*.Cu") (uuid "h1"))')), PADRULES, "creepage");
  assert.equal(m.length, 1);
  assert.ok(actualOf(m[0]) > 3, "longer than the straight gap");
  assert.deepEqual(m[0].pathShapes.map((p) => p.t), ["seg", "arc", "seg"]);
  const arc = m[0].pathShapes[1];
  assert.ok(near(Math.hypot(arc.a[0] - 10, arc.a[1] - 5), 1) && near(Math.hypot(arc.b[0] - 10, arc.b[1] - 5), 1), "the arc on the hole");
});

test("creepage: an NPTH slot is two sides and two round caps; the path goes round a cap", () => {
  const m = drcWith(board(OUTLINE + FP(' (pad "" np_thru_hole oval (at 0 0) (size 1 4) (drill oval 1 4) (layers "*.Cu") (uuid "h1"))')), PADRULES, "creepage");
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].pathShapes.map((p) => p.t), ["seg", "arc", "seg"]);
  assert.ok(actualOf(m[0]) > 4.2, m[0].text);
});

// ---------------------------------------------------------------- net chains
const CHAIN_BOARD = (extra = "") => K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup) (net 0 "") (net 1 "/A") (net 2 "/B") (net 3 "/C") (net 4 "GND")
  (footprint "R:R" (layer "F.Cu") (uuid "fp-1") (at 100 50) (property "Reference" "R1" (at 0 -2 0) (layer "F.Cu") (uuid "r1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "/A") (uuid "pad-r1-1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "pad-r1-2")))
  (footprint "R:R" (layer "F.Cu") (uuid "fp-2") (at 110 50) (property "Reference" "R2" (at 0 -2 0) (layer "F.Cu") (uuid "r2-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "pad-r2-1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 3 "/C") (uuid "pad-r2-2")))
  (segment (start 101 50) (end 109 50) (width 0.25) (layer "F.Cu") (net 2 "/B") (uuid "seg-b"))
  (segment (start 99 50) (end 95 50) (width 0.25) (layer "F.Cu") (net 1 "/A") (uuid "seg-a"))
  (segment (start 111 50) (end 115 50) (width 0.25) (layer "F.Cu") (net 3 "/C") (uuid "seg-c"))
  ${extra}
  (net_chains (net_chain (name "SIG") (members (net "/A") (net "/B") (net "/C")) (terminal_pad "pad-r1-1") (terminal_pad "pad-r2-2")))
  (embedded_fonts no))`, "kicad_pcb");
const chainRules = (body) => `(version 1)\n(rule ch (condition "A.inNetChain('SIG')") ${body})`;
const lengthMarkers = (d, rules) => T.customRuleMarkers(d, settings(), rules);

test("net_chain_length: the trunk between the terminal pads, bridged through the footprints, against the rule", () => {
  const d = CHAIN_BOARD();
  const all = lengthMarkers(d, chainRules("(constraint net_chain_length (max 5mm))")).filter((m) => m.code === "length_out_of_range");
  assert.ok(all.length >= 1, "an 8 mm trunk (plus the bridges) is over 5 mm");
  // R1's bridge (2 mm), the 8 mm track, R2's bridge (2 mm); the stubs off the terminal pads are not trunk
  assert.equal(all[0].text, "Track length out of range (rule 'ch' max length 5.0000 mm; actual 12.0000 mm)");
  assert.equal(lengthMarkers(d, chainRules("(constraint net_chain_length (max 50mm))")).filter((m) => m.code === "length_out_of_range").length, 0);
});

test("stub_length: the tracks off the trunk at the terminal pads are stubs of the chain", () => {
  const d = CHAIN_BOARD();
  const m = lengthMarkers(d, chainRules("(constraint stub_length (max 1mm))")).filter((x) => x.code === "net_chain_stub_length");
  assert.ok(m.length >= 1);
  assert.ok(m.every((x) => /^Stub length \(.+\) out of range for net chain 'SIG'/.test(x.text)), m.map((x) => x.text).join("\n"));
  assert.equal(lengthMarkers(d, chainRules("(constraint stub_length (max 10mm))")).filter((x) => x.code === "net_chain_stub_length").length, 0);
});

test("return_path: each stretch of the chain with no copper of the reference net under it on the reference layer is reported", () => {
  const rule = chainRules('(constraint return_path (layer "B.Cu") (net "GND"))');
  const bare = lengthMarkers(CHAIN_BOARD(), rule).filter((x) => x.code === "net_chain_return_path");
  // each uncovered stretch that touches no other is its own violation (the union-find grouping), at its middle
  assert.deepEqual(bare.map((x) => x.ids[0]).sort(), ["seg-a", "seg-b", "seg-c"]);
  assert.ok(bare.every((x) => x.text === "Net chain 'SIG' has no copper return path on reference layer 'B.Cu'. (net 'GND')"), bare[0].text);
  const plane = '(zone (net 4) (net_name "GND") (layer "B.Cu") (uuid "z1") (hatch edge 0.5) (connect_pads (clearance 0.2)) (min_thickness 0.2) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 90 45) (xy 120 45) (xy 120 55) (xy 90 55))) (filled_polygon (layer "B.Cu") (pts (xy 90 45) (xy 120 45) (xy 120 55) (xy 90 55))))';
  assert.equal(lengthMarkers(CHAIN_BOARD(plane), rule).filter((x) => x.code === "net_chain_return_path").length, 0, "a GND plane under the whole chain");
});

// ---------------------------------------------------------------- the tuner's net chain target
// PCB_TUNING_PATTERN::CreateNew's NET_CHAIN_LENGTH_CONSTRAINT target (bridging subtracted), MEANDER_PLACER_BASE's chain
// extras and MEANDER_PLACER::Move's per-net budget, the status line of the chain, the message panel and the dialog.
const pcb = globalThis.CollabTools.pcb, IU = 1e6, C = T.tuningChain;
function tuneCtx(d) {
  const log = { commits: [], toasts: [] };
  const ctx = { K, doc: d, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.05, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(d, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); } };
  pcb.onDocChanged(ctx); pcb.setLayer(ctx, "F.Cu"); return { ctx, log };
}
const ev = () => ({ button: 0, shiftKey: false, clientX: 0, clientY: 0 });
const CHAIN_RULE = chainRules("(constraint net_chain_length (min 29mm) (opt 30mm) (max 31mm))");
const resetTuner = () => { try { pcb.cancel && pcb.cancel(); } catch (e) { /* idle */ } T.state.tune.pattern = null; T.state.tune.picker = null; T.state.tuneSettings.single = T.meanderDefaults(); T.setCustomRules(null); };

test("GetSignalAggregate / chainNarrowingOffset: the chain's other nets (each net's first track, GetTrackLength) and the unmeasured copper", () => {
  const d = CHAIN_BOARD(); const L = T.ldContext(d, settings());
  const a = C.signalAggregate(L, "/B", "/B");
  const len = (id) => { const r = T.boardTrackLength(L, id); return Math.round((r.length + r.padToDie) * IU); };
  assert.equal(a.valid, true); assert.equal(a.length, len("seg-a") + len("seg-c")); assert.equal(a.delay, 0);
  assert.deepEqual(C.signalAggregate(L, "GND", "GND"), { valid: false, length: 0, delay: 0 }, "a net on no chain");
  assert.equal(C.signalAggregate(L, "/B", "GND").valid, false, "a pair whose nets are not on one chain");
  assert.equal(C.netBoardLength(L, "/B"), len("seg-b"));
  const ex = C.chainExtras(L, ["/B"], len("seg-b") - 2 * IU);   // the tuning path measures 2 mm less than the board
  assert.equal(ex.length, a.length); assert.equal(ex.offset, a.length + 2 * IU);
  assert.equal(C.chainExtras(L, ["GND"], 0).offset, 0, "no chain, no copper of the net: nothing");
});

test("MEANDER_PLACER::Move: the chain target less the rest of the chain is the net's budget, or narrows the net's own target", () => {
  const st = T.meanderDefaults(); C.setTargetSignalLength(st, { min: 29 * IU, opt: 30 * IU, max: 31 * IU });
  C.chainBudget(st, 10 * IU); assert.deepEqual(st.target, { min: 19 * IU, opt: 20 * IU, max: 21 * IU });
  const st2 = T.meanderDefaults(); T.setTargetLength(st2, 18 * IU); C.setTargetSignalLength(st2, { min: 29 * IU, opt: 30 * IU, max: 31 * IU });
  C.chainBudget(st2, 10 * IU); assert.deepEqual(st2.target, { min: 19 * IU, opt: 18 * IU, max: 18.1 * IU }, "the tighter of the two");
  const st3 = T.meanderDefaults(); C.setTargetSignalLength(st3, { opt: 5 * IU }); C.chainBudget(st3, 10 * IU);
  assert.deepEqual(st3.target, { min: 0, opt: 0, max: 0 }, "a chain already over its target leaves no budget");
  const none = T.meanderDefaults(); C.chainBudget(none, 10 * IU); assert.equal(none.target.opt, T.LENGTH_UNCONSTRAINED, "no chain target: unchanged");
});

test("Tune Length on a chain net: the net_chain_length rule less the bridging is the chain target; the net is tuned to its share", () => {
  resetTuner(); const d = CHAIN_BOARD(); const { ctx, log } = tuneCtx(d);
  T.setCustomRules(CHAIN_RULE);
  try {
    ctx.setTool("tunesingle");
    pcb.onPointerMove(ev(), [103, 50], ctx); pcb.onPointerDown(ev(), [103, 50], ctx);
    const P = T.state.tune.pattern; assert.ok(P, "anchored");
    // R1 and R2 each bridge 2 mm between their pads: 30 - 4 mm
    assert.deepEqual(P.st.signalTarget, { min: 25 * IU, opt: 26 * IU, max: 27 * IU });
    assert.equal(P.st.target.opt, T.LENGTH_UNCONSTRAINED, "a chain rule alone leaves the net's own target open");
    assert.equal(P.hasRuleTarget, true);
    const L = T.ldContext(d, settings()), other = C.signalAggregate(L, "/B", "/B").length;
    assert.equal(P.chainEx.length, other);
    const budget = 26 * IU - P.chainEx.offset;
    assert.ok(budget > 8 * IU && budget < 20 * IU, "the budget is the 8 mm track plus meanders: " + budget);
    pcb.onPointerMove(ev(), [108, 49], ctx);
    assert.equal(P.res.status, "tuned", "tuned to the share");
    assert.ok(Math.abs(P.res.length - budget) <= 0.1 * IU, P.res.length + " vs " + budget);
    assert.deepEqual(P.st.target, { min: 25 * IU - P.chainEx.offset, opt: budget, max: 27 * IU - P.chainEx.offset }, "the budget is the pattern's target now");
    // the status: "<net> | <chain>", the net line, and the chain line with the chain rule's min / max
    const info = T.tuneStatus(ctx);
    assert.equal(info.scope, "/B | SIG"); assert.equal(info.min, "---");
    assert.ok(info.chain && /^Chain: \d+\.\d{4} mm$/.test(info.chain.value), JSON.stringify(info.chain));
    assert.equal(info.chain.min, "29.0000"); assert.equal(info.chain.max, "31.0000");
    pcb.onPointerDown(ev(), [108, 49], ctx);
    assert.equal(log.commits.at(-1).label, "Tune");
    const gen = [...d.items.values()].find((it) => it.kind === "generated"); assert.ok(gen);
    assert.ok(Math.abs(K.kid(gen.node, "target_length")[1] - budget / IU) < 1e-6, "target_length is the budget");
    // the message panel: the chain, its full length with the bridging, the chain rule first
    const rows = T.msgPanelInfo(d, [...T.expandGroups(d, [gen.id])], { units: "mm" }); const t = (k) => (rows.find((r) => r.title === k) || {}).value;
    assert.equal(t("Net Chain"), "SIG");
    const full = +/^([\d.]+) mm$/.exec(t("Net Chain Full Length"))[1];
    const routed = +/^([\d.]+) mm$/.exec(t("Routed Length"))[1];
    assert.ok(Math.abs(full - (routed + other / IU + 4)) < 1e-3, full + " = " + routed + " + others + 4 mm bridging");
    assert.ok(rows.some((r) => r.title === "Length Constraints: min 29.0000 mm; opt 30.0000 mm; max 31.0000 mm" && r.value === "(from rule 'ch')"), JSON.stringify(rows));
  } finally { resetTuner(); }
});

test("Tune Length on a track with the bare (net N) code: the new copper carries the net in the file's own form", () => {
  // a track written (net 2) has no name of its own: the board's net table gives it (by name from 20251028, else the code)
  for (const [ver, want] of [[20260728, '(net "/B")'], [20241229, "(net 2)"]]) {
    resetTuner();
    const d = K.parseDoc(`(kicad_pcb (version ${ver}) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (setup) (net 0 "") (net 1 "/A") (net 2 "/B") (net 3 "/C")
  (footprint "R:R" (layer "F.Cu") (uuid "fp-1") (at 100 50) (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "/A") (uuid "p11")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "p12")))
  (footprint "R:R" (layer "F.Cu") (uuid "fp-2") (at 110 50) (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "p21")) (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 3 "/C") (uuid "p22")))
  (segment (start 101 50) (end 109 50) (width 0.25) (layer "F.Cu") (net 2) (uuid "seg-b")))`, "kicad_pcb");
    const { ctx, log } = tuneCtx(d);
    try {
      T.setTargetLength(T.state.tuneSettings.single, 14 * IU);
      ctx.setTool("tunesingle");
      pcb.onPointerMove(ev(), [103, 50], ctx); pcb.onPointerDown(ev(), [103, 50], ctx);
      pcb.onPointerMove(ev(), [108, 49], ctx); pcb.onPointerDown(ev(), [108, 49], ctx);
      const c = log.commits.at(-1); assert.equal(c && c.label, "Tune", String(ver));
      const copper = c.changes.filter((x) => x.kind === "ADDED" && /^PCB_(TRACK|ARC)$/.test(x.typeName));
      assert.ok(copper.length > 2, "meanders added");
      for (const x of copper) assert.equal((/\(net [^()]*\)/.exec(x.sexpr) || [""])[0], want, ver + ": " + x.sexpr);
    } finally { resetTuner(); }
  }
});

test("Override Custom Rules: no chain target, the tool's own target; a net length rule beside the chain rule wins where tighter", () => {
  resetTuner(); const d = CHAIN_BOARD(); const { ctx } = tuneCtx(d);
  try {
    T.setCustomRules(CHAIN_RULE); T.state.tuneSettings.single.overrideCustomRules = true; T.setTargetLength(T.state.tuneSettings.single, 12 * IU);
    ctx.setTool("tunesingle"); pcb.onPointerDown(ev(), [103, 50], ctx);
    assert.equal(T.state.tune.pattern.st.signalTarget.opt, T.LENGTH_UNCONSTRAINED); assert.equal(T.state.tune.pattern.st.target.opt, 12 * IU);
    resetTuner(); const d2 = CHAIN_BOARD(); const f = tuneCtx(d2);
    T.setCustomRules(CHAIN_RULE + "\n(rule net (condition \"A.NetName == '/B'\") (constraint length (opt 9mm)))");
    f.ctx.setTool("tunesingle"); pcb.onPointerDown(ev(), [103, 50], f.ctx);
    const P = T.state.tune.pattern; assert.equal(P.st.target.opt, 9 * IU, "the net's rule"); assert.equal(P.st.signalTarget.opt, 26 * IU, "and the chain's");
    const st = C.moveSettings(P); assert.equal(st.target.opt, Math.min(9 * IU, 26 * IU - P.chainEx.offset), "the tighter opt");
    // ApplyToolSettings: the tool's settings (Ctrl+L) keep the pattern's rule and chain targets unless they override the rules
    const tool = T.meanderDefaults(); T.setTargetLength(tool, 40 * IU); tool.maxAmp = 2 * IU;
    const Q = { st: T.tuneCopy ? T.tuneCopy(P.st) : JSON.parse(JSON.stringify(P.st)), hasRuleTarget: true };
    C.applyToolSettings(Q, tool); assert.equal(Q.st.target.opt, 9 * IU); assert.equal(Q.st.signalTarget.opt, 26 * IU); assert.equal(Q.st.maxAmp, 2 * IU);
    tool.overrideCustomRules = true; C.applyToolSettings(Q, tool); assert.equal(Q.st.target.opt, 40 * IU); assert.equal(Q.st.signalTarget.opt, T.LENGTH_UNCONSTRAINED);
  } finally { resetTuner(); }
});

test("E on a chain net's pattern: the dialog takes the net_chain_length rule (its name as the source) before the length rule", () => {
  resetTuner(); const d = CHAIN_BOARD(); const { ctx } = tuneCtx(d);
  try {
    T.setTargetLength(T.state.tuneSettings.single, 12 * IU);
    ctx.setTool("tunesingle"); pcb.onPointerDown(ev(), [103, 50], ctx); pcb.onPointerMove(ev(), [108, 49], ctx); pcb.onPointerDown(ev(), [108, 49], ctx);
    ctx.setTool("select");
    const gen = [...d.items.values()].find((it) => it.kind === "generated"); assert.ok(gen);
    T.setCustomRules(CHAIN_RULE + "\n(rule net (condition \"A.NetName == '/B'\") (constraint length (opt 9mm)))");
    let req = null; pcb.setRoutingDialogs({ tuning: (o) => { req = o; } });
    for (const id of T.expandGroups(d, [gen.id])) T.state.sel.add(id);
    assert.equal(pcb.tunerProperties(ctx), true);
    assert.equal(req.settings.constraint, "rule 'ch'"); assert.equal(req.settings.targetLength, 30, "the chain rule's opt as it stands");
    T.state.sel.clear();
  } finally { resetTuner(); }
});

// ---------------------------------------------------------------- SPICE model ERC
const fact = (ref, fields, pins = ["1", "2"]) => ({ id: "x", sheet: 0, uuidPath: ["root"], at: [0, 0], ref, fields: Object.entries(Object.assign({ Reference: ref }, fields)).map(([name, value]) => ({ name, value })), inferencePins: pins, modelPins: pins });
const noLib = () => null;

test("CreateModel: a value-only passive infers its model; nothing reported", () => {
  assert.deepEqual(SP.createSymbolModel(fact("R1", { Value: "10k" }), noLib), []);
  assert.deepEqual(SP.createSymbolModel(fact("C1", { Value: "100n" }), noLib), []);
});

test("CreateModel: a library that cannot be read, no Sim.Name, a model the library does not have", () => {
  assert.deepEqual(SP.createSymbolModel(fact("U1", { Value: "X", "Sim.Library": "missing.lib", "Sim.Name": "OPA" }), noLib), ["Simulation model library not found at 'missing.lib'"]);
  const lib = SL.parseSpiceLibrary(".model D1N4148 D(Is=2.52n)\n");
  assert.deepEqual(SP.createSymbolModel(fact("D1", { Value: "X", "Sim.Library": "d.lib" }), () => lib), ["Error loading simulation model: no 'Sim.Name' field"]);
  assert.deepEqual(SP.createSymbolModel(fact("D1", { Value: "X", "Sim.Library": "d.lib", "Sim.Name": "D1N4007" }), () => lib), ["Error loading simulation model: could not find base model 'D1N4007' in library 'd.lib'"]);
  assert.deepEqual(SP.createSymbolModel(fact("D1", { Value: "X", "Sim.Library": "d.lib", "Sim.Name": "D1N4148", "Sim.Pins": "1=K 2=A" }), () => lib), []);
});

test("CreateModel: a Sim.Pins map that cannot be read is an error of the symbol", () => {
  const msgs = SP.createSymbolModel(fact("V1", { Value: "X", "Sim.Device": "V", "Sim.Type": "DC", "Sim.Params": "dc=bogus(", "Sim.Pins": "1=+ 2" }), noLib);
  assert.ok(msgs.length >= 1, "reported");
});

const LIB = `(lib_symbols (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
const U_ROOT = "11111111-1111-1111-1111-111111111111";
const sym = (ref, x, y, uuid, extra = "") => `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (uuid "${uuid}") (property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "1k" (at ${x + 2} ${y + 2} 0) (effects (font (size 1.27 1.27)))) ${extra} (pin "1" (uuid "${uuid}-p1")) (pin "2" (uuid "${uuid}-p2")) (instances (project "demo" (path "/${U_ROOT}" (reference "${ref}") (unit 1)))))`;
const SCH = `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") ${LIB}
  ${sym("R1", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001")}
  ${sym("R2", 120, 50, "aaaaaaaa-0000-0000-0000-000000000002", '(property "Sim.Library" "nowhere.lib" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes))) (property "Sim.Name" "RX" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')}
  ${sym("R3", 140, 50, "aaaaaaaa-0000-0000-0000-000000000003", "(exclude_from_sim yes)")}
  (sheet_instances (path "/" (page "1"))))`;

test("ExtractSimulationModelFacts: each simulated symbol of each sheet instance, its fields, pins and position", () => {
  const doc = K.parseDoc(SCH, "kicad_sch"), facts = [];
  SP.readHierarchy({ sheets: [{ index: 0, uuidPath: [U_ROOT], doc }], netMap: new Map(), symbolPins: sch._.symbolPins, isPower: () => false, facts });
  assert.deepEqual(facts.map((f) => f.ref), ["R1", "R2"], "R3 is excluded from simulation");
  assert.deepEqual(facts[1].at, [120, 50]);
  assert.deepEqual(facts[0].inferencePins, ["1", "2"]);
  assert.deepEqual(facts.map((f) => SP.createSymbolModel(f, noLib)), [[], ["Simulation model library not found at 'nowhere.lib'"]]);
});

test("TestSimModelIssues: the messages become a simulation_model_issue marker at the symbol", () => {
  const doc = K.parseDoc(SCH, "kicad_sch");
  const facts = []; SP.readHierarchy({ sheets: [{ index: 0, uuidPath: [U_ROOT], doc }], netMap: new Map(), symbolPins: sch._.symbolPins, isPower: () => false, facts });
  const issues = new Map(); for (const f of facts) { const msgs = SP.createSymbolModel(f, noLib); if (msgs.length) issues.set(f.id, msgs.join("\n")); }
  const id = facts[1].id;
  const m = sch.ercCheck(doc, { simModelIssues: issues }).filter((x) => x.code === "simulation_model_issue");
  assert.equal(m.length, 1);
  assert.equal(m[0].text, "Simulation model library not found at 'nowhere.lib'");
  assert.deepEqual([m[0].x, m[0].y], [120, 50]);
  assert.deepEqual(m[0].ids, [id]);
  assert.equal(sch.ercCheck(doc, {}).filter((x) => x.code === "simulation_model_issue").length, 0, "the test off: no markers");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
