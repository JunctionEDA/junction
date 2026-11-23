// net-chains.test.js — net chains under node: the schematic's chains (canvas/net-chains.ts, NETCHAIN_MANAGER's
// bridge detection, potentials and the committed chains restored from the root sheet's (net_chain …)), the board's
// (net_chains …) section (parser, writer, BOARD_SETUP change), the board tools (inNetChain / hasNetChain /
// inNetChainClass, Select Net Chain, the message panel's Net Chain row, Update PCB's chain assignments and terminal
// pads, the tuning profile DRC check, Set terminal pad) and Schematic Setup's ApplyEdits.
// Run: node server/static/tests/net-chains.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js")); require(path.join(__dirname, "..", "pcb-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, NC = K.netChains, sch = globalThis.CollabTools.sch, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const SP = load(["dialogs", "schematic-setup-logic.ts"]);
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
console.log("net chains under node");

// ---------------------------------------------------------------- a schematic: J1 -A- R1 -B- R2 -C- J2
const LIB = `(lib_symbols
  (symbol "Device:R" (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
const U_ROOT = "11111111-1111-1111-1111-111111111111";
const sym = (ref, x, y, uuid, extra = "") => `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) ${extra} (uuid "${uuid}") (property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "1k" (at ${x + 2} ${y + 2} 0) (effects (font (size 1.27 1.27)))) (pin "1" (uuid "${uuid}-p1")) (pin "2" (uuid "${uuid}-p2")) (instances (project "demo" (path "/${U_ROOT}" (reference "${ref}") (unit 1)))))`;
const wire = (a, b, id) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const label = (name, at, id) => `(label "${name}" (at ${at[0]} ${at[1]} 0) (effects (font (size 1.27 1.27))) (uuid "${id}"))`;
// R1 at (100,50): pin 1 (100,46.19), pin 2 (100,53.81); R2 at (100,70): pin 1 (100,66.19), pin 2 (100,73.81)
function schematic(opts = {}) {
  const r1 = sym("R1", 100, 50, "aaaaaaaa-0000-0000-0000-000000000001", opts.block ? "(passthrough block)" : "");
  const r2 = sym("R2", 100, 70, "aaaaaaaa-0000-0000-0000-000000000002");
  const chains = opts.saved || "";
  return `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${U_ROOT}") (paper "A4") ${LIB} ${r1} ${r2}
    ${wire([100, 40], [100, 46.19], "w1")} ${label("A", [100, 40], "l1")}
    ${wire([100, 53.81], [100, 66.19], "w2")} ${label("B", [100, 60], "l2")}
    ${wire([100, 73.81], [100, 80], "w3")} ${label("C", [100, 80], "l3")}
    ${chains} (sheet_instances (path "/" (page "1"))))`;
}
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
function model(text) {
  const doc = K.parseDoc(text, "kicad_sch"); const file = { doc, uuid: U_ROOT, file: "demo.kicad_sch" };
  const nl = N.buildNetlist(file, () => null, helpers, "demo", N.netlistOptions(null));
  const docs = new Map([["demo.kicad_sch", doc]]);
  return { doc, nl, m: NC.buildChains({ map: nl.netMap, instances: nl.instances, docs, symbolPins: helpers.symbolPins, project: "demo", saved: NC.savedChains(doc) }) };
}
const SIG = `(net_chain "SIG" (from "R1" "1") (to "R2" "2") (net_class "HS") (color 255 0 0 1))`;

test("chain names: IsValidName refuses spaces, quotes and parentheses", () => {
  assert.equal(NC.isValidName("CLK_1"), true);
  for (const bad of ["", "a b", "a\"b", "a'b", "a(b", "a)b"]) assert.equal(NC.isValidName(bad), false, bad);
});
test("bridges: two collinear passthrough resistors make one potential chain of three nets", () => {
  const { m } = model(schematic());
  assert.equal(m.edges.length, 2);
  assert.equal(m.potentials.length, 1);
  assert.deepEqual(m.potentials[0].nets.slice().sort(), ["/A", "/B", "/C"]);
  assert.equal(m.committed.length, 0, "nothing saved: no committed chain");
  assert.equal(NC.potentialBetween(m, "/A", "/C"), m.potentials[0]);
  // the terminals are the farthest pin pair: R1 pin 1 and R2 pin 2
  const t = [m.potentials[0].termA, m.potentials[0].termB].map((p) => p.ref + ":" + p.pin).sort();
  assert.deepEqual(t, ["R1:1", "R2:2"]);
});
test("passthrough block: the symbol bridges nothing", () => {
  const { m } = model(schematic({ block: true }));
  assert.equal(m.edges.length, 1);
  assert.deepEqual(m.potentials[0].nets.slice().sort(), ["/B", "/C"]);
});
test("committed chains: restored from the root sheet's (net_chain …) with their net class and colour", () => {
  const { m, doc } = model(schematic({ saved: SIG }));
  assert.equal(NC.savedChains(doc).length, 1);
  assert.equal(doc.items.has("net_chain:SIG"), true, "the entry is an item of the sheet, id net_chain:<name>");
  assert.equal(m.committed.length, 1);
  const c = NC.chainByName(m, "SIG");
  assert.deepEqual(c.nets.slice().sort(), ["/A", "/B", "/C"]);
  assert.equal(c.netClass, "HS"); assert.deepEqual(c.color, [255, 0, 0, 1]);
  assert.equal(NC.chainForNet(m, "/B"), c); assert.equal(NC.chainForNet(m, "/Z"), null);
  // a rename keeps terminals, class, colour and nets
  const text = NC.committedNodeText(c, { name: "SIG2" });
  const back = NC.parseChainNode(K.parse(text));
  assert.equal(back.name, "SIG2"); assert.deepEqual(back.from, { ref: "R1", pin: "1" }); assert.deepEqual(back.to, { ref: "R2", pin: "2" }); assert.equal(back.netClass, "HS");
  // the bridges of the middle net: both resistors
  assert.equal(NC.bridgeSymbols(m, c, "/B").length, 2);
});
test("netlist chains: name, classes, colour as #RRGGBBAA, members and terminal pins", () => {
  const { m } = model(schematic({ saved: SIG }));
  const [c] = NC.netlistChains(m, (n) => (n === "SIG" ? "fast" : ""));
  assert.equal(c.name, "SIG"); assert.equal(c.netClass, "HS"); assert.equal(c.chainClass, "fast"); assert.equal(c.color, "#FF0000FF");
  assert.deepEqual(c.members.slice().sort(), ["/A", "/B", "/C"]);
  assert.deepEqual(c.terminals, [{ ref: "R1", pin: "1" }, { ref: "R2", pin: "2" }]);
});

// ---------------------------------------------------------------- the board
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "/A") (net 2 "/B") (net 3 "/C") (net 4 "GND")
  (footprint "R:R" (layer "F.Cu") (uuid "fp-1") (at 100 50) (property "Reference" "R1" (at 0 -2 0) (layer "F.Cu") (uuid "r1-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "/A") (uuid "pad-r1-1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "pad-r1-2")))
  (footprint "R:R" (layer "F.Cu") (uuid "fp-2") (at 110 50) (property "Reference" "R2" (at 0 -2 0) (layer "F.Cu") (uuid "r2-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 2 "/B") (uuid "pad-r2-1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 3 "/C") (uuid "pad-r2-2")))
  (segment (start 101 50) (end 109 50) (width 0.25) (layer "F.Cu") (net 2) (uuid "seg-b"))
  (segment (start 99 50) (end 95 50) (width 0.25) (layer "F.Cu") (net 1) (uuid "seg-a"))
  (segment (start 111 50) (end 115 50) (width 0.25) (layer "F.Cu") (net 3) (uuid "seg-c"))
  (segment (start 95 60) (end 115 60) (width 0.25) (layer "F.Cu") (net 4) (uuid "seg-gnd"))
  NETCHAINS
  (embedded_fonts no))`;
const CHAINS = `(net_chains (net_chain (name "SIG") (members (net "/A") (net "/B") (net "/C")) (terminal_pad "pad-r1-1") (terminal_pad "pad-r2-2")))`;
const board = (chains = CHAINS) => K.parseDoc(BOARD.replace("NETCHAINS", chains), "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [] };
  const ctx = { K, doc, IU: 1e6, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, cursor: [105, 50],
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, 1e6); pcb.onDocChanged(ctx); },
    toast() {}, setTool() {} };
  return { ctx, log };
}

test("board file: (net_chains …) is kept on the document and read per net", () => {
  const doc = board();
  assert.ok(doc.netChainsNode && doc.netChainsNode[0] === "net_chains");
  assert.equal([...doc.items.values()].some((it) => it.kind === "net_chains"), false, "the section is not an item");
  const m = NC.parseBoardChains(doc.netChainsNode, doc.nets);
  assert.equal(m.get("/A").chain, "SIG"); assert.equal(m.get("/C").chain, "SIG"); assert.equal(m.has("GND"), false);
  assert.deepEqual(m.get("/A").pads, ["pad-r1-1", "pad-r2-2"]);
});
test("board file: the writer groups nets per chain in net-code order, ValueStringCompare between chains, first pads", () => {
  const m = new Map([["/B", { chain: "X10", pads: [null, null] }], ["/A", { chain: "X2", pads: ["p1", null] }], ["/C", { chain: "X10", pads: [null, "p3"] }]]);
  const text = NC.boardChainsText(m, ["", "/A", "/B", "/C", "GND"], () => true);
  assert.equal(text, `(net_chains (net_chain (name "X2") (members (net "/A")) (terminal_pad "p1")) (net_chain (name "X10") (members (net "/B") (net "/C")) (terminal_pad "p3")))`);
  assert.equal(NC.boardChainsText(new Map(), [], () => true), "");
  assert.ok(NC.valueStringCompare("X2", "X10") < 0);
});
test("BOARD_SETUP net_chains change: replaces the section on the open board, \"\" removes it", () => {
  const doc = board();
  const ch = K.boardSetup.netChainsChange(`(net_chains (net_chain (name "N") (members (net "/A") (net "/B"))))`);
  assert.equal(ch.typeName, "BOARD_SETUP"); assert.equal(ch.properties[0].name, "net_chains");
  assert.ok(K.boardSetup.applyBoardSetup(doc, ch));
  assert.equal(P.ruleCallFunc("inNetChain", { kind: "segment", node: doc.items.get("seg-b").node }, ["N"], { doc, s: P.designSettings(null), A: null, B: null, constraint: null, ver: 0 }, P.wildMatch, (p, s) => p === s).v, 1);
  K.boardSetup.applyBoardSetup(doc, K.boardSetup.netChainsChange(""));
  assert.equal(doc.netChainsNode, null);
});
test("rule functions: inNetChain, hasNetChain, inNetChainClass", () => {
  const doc = board();
  const s = P.designSettings({ net_settings: { classes: [{ name: "Default" }], net_chain_classes: { SIG: "fast" } } });
  const call = (fn, id, args) => P.ruleCallFunc(fn, { kind: "segment", node: doc.items.get(id).node }, args, { doc, s, A: null, B: null, constraint: null, ver: 0 }, P.wildMatch, (p, x) => P.wildMatch(p, x)).v;
  assert.equal(call("inNetChain", "seg-b", ["SIG"]), 1); assert.equal(call("inNetChain", "seg-b", ["S*"]), 1); assert.equal(call("inNetChain", "seg-b", ["OTHER"]), 0);
  assert.equal(call("inNetChain", "seg-gnd", ["SIG"]), 0);
  assert.equal(call("hasNetChain", "seg-a", []), 1); assert.equal(call("hasNetChain", "seg-gnd", []), 0);
  assert.equal(call("inNetChainClass", "seg-c", ["fast"]), 1); assert.equal(call("inNetChainClass", "seg-c", ["slow"]), 0);
  assert.equal(call("inNetChainClass", "seg-gnd", ["fast"]), 0);
});
test("message panel: a track, via or pad on a chain shows the Net Chain row after Net", () => {
  const doc = board(); const s = P.designSettings(null);
  const rows = P.msgPanelInfo(doc, ["seg-b"], { settings: s });
  const i = rows.findIndex((r) => r.title === "Net");
  assert.equal(rows[i + 1].title, "Net Chain"); assert.equal(rows[i + 1].value, "SIG");
  assert.equal(P.msgPanelInfo(doc, ["seg-gnd"], { settings: s }).some((r) => r.title === "Net Chain"), false);
  const pad = P.msgPanelInfo(doc, ["fp-1#0"], { settings: s });
  assert.equal(pad[pad.findIndex((r) => r.title === "Net") + 1].title, "Net Chain");
});
test("Select Net Chain: the copper of every net on the chain of the selected track", () => {
  const doc = board(); const { ctx } = fakeCtx(doc);
  pcb.onDocChanged(ctx); P.applySelection(ctx, ["seg-b"]);
  pcb.actions.selectNetChain.run(ctx);
  const sel = new Set(ctx.selectedIds ? ctx.selectedIds() : P.state.sel || []);
  for (const id of ["seg-a", "seg-b", "seg-c"]) assert.ok(sel.has(id), id);
  assert.equal(sel.has("seg-gnd"), false);
});
test("highlight: the same net twice escalates to its chain; Highlight Net Chain toggles the chain", () => {
  const doc = board(); const { ctx } = fakeCtx(doc);
  pcb.onDocChanged(ctx); pcb.actions.clearHighlight.run(ctx);
  pcb.highlightNetAt(ctx, [105, 50]);
  assert.deepEqual(P.state.hlShown, ["/B"]);
  pcb.highlightNetAt(ctx, [105, 50]);
  assert.deepEqual(P.state.hlShown.slice().sort(), ["/A", "/B", "/C"]); assert.equal(P.state.hlChain, "SIG");
  pcb.actions.clearHighlight.run(ctx); assert.equal(P.state.hlChain, "");
  pcb.highlightNetChainAt(ctx, [112, 50]);
  assert.equal(P.state.hlChain, "SIG"); assert.deepEqual(P.state.hlShown.slice().sort(), ["/A", "/B", "/C"]);
  pcb.highlightNetChainAt(ctx, [112, 50]);
  assert.equal(P.state.hlChain, ""); assert.deepEqual(P.state.hlShown, []);
});
test("Set terminal pad: the highlighted chain's terminal pad is replaced on every net of the chain", () => {
  const doc = board(); const { ctx } = fakeCtx(doc);
  pcb.onDocChanged(ctx); pcb.actions.clearHighlight.run(ctx);
  assert.equal(pcb.replaceTerminalPad(ctx, "pad-r1-1", "pad-r1-2"), null, "no chain highlighted: nothing");
  pcb.highlightNetChainAt(ctx, [105, 50]);
  const text = pcb.replaceTerminalPad(ctx, "pad-r1-1", "pad-r1-2");
  assert.ok(text && text.includes(`(terminal_pad "pad-r1-2")`) && !text.includes("pad-r1-1"), text);
});
test("Update PCB: chain assignments from the netlist, a cleared chain reported, terminal pads nearest the edge", () => {
  const doc = board(`(net_chains (net_chain (name "OLD") (members (net "GND") (net "/A"))))`); const { ctx } = fakeCtx(doc);
  pcb.onDocChanged(ctx);
  const r = pcb.netlistChainUpdate(ctx, [{ name: "SIG", members: ["/A", "/B", "/C"], terminals: [{ ref: "R1", pin: "1" }, { ref: "R2", pin: "2" }] }]);
  assert.deepEqual(r.warnings, ["Net chain assignment 'OLD' on net 'GND' cleared by netlist update."]);
  assert.equal(r.text, `(net_chains (net_chain (name "SIG") (members (net "/A") (net "/B") (net "/C")) (terminal_pad "pad-r1-1") (terminal_pad "pad-r2-2")))`);
  // nothing to change: null
  const same = board(); const c2 = fakeCtx(same).ctx; pcb.onDocChanged(c2);
  assert.equal(pcb.netlistChainUpdate(c2, [{ name: "SIG", members: ["/A", "/B", "/C"], terminals: [{ ref: "R1", pin: "1" }, { ref: "R2", pin: "2" }] }]).text, null);
});
test("DRC: the nets of a chain with different tuning profiles are reported once", () => {
  const doc = board();
  const pro = { net_settings: { classes: [{ name: "Default" }, { name: "Fast", tuning_profile: "P1", priority: 0 }], netclass_patterns: [{ netclass: "Fast", pattern: "/A" }] } };
  const m = P.drc(doc, P.designSettings(pro), { unconnected: false }).filter((x) => x.code === "net_chain_tuning_profiles");
  assert.equal(m.length, 1); assert.equal(m[0].text, "Net chain SIG nets have multiple tuning profiles assigned");
  assert.equal(P.drc(doc, P.designSettings(null), { unconnected: false }).filter((x) => x.code === "net_chain_tuning_profiles").length, 0);
});

// ---------------------------------------------------------------- Schematic Setup > Net Chains (ApplyEdits)
test("Net Inspector: a net's chain, and the chain length with the pad-to-pad distances inside each footprint", () => {
  const doc = board(), rows = P.netLengths(doc, null, {});
  assert.equal(P.netChainOf(doc, "/B"), "SIG"); assert.equal(P.netChainOf(doc, "GND"), "");
  const members = rows.filter((r) => ["/A", "/B", "/C"].includes(r.name)).reduce((t, r) => t + r.totalLength, 0);
  assert.ok(members > 0);
  const m = P.netChainLengths(doc, rows);
  assert.ok(Math.abs(m.get("SIG") - (members + 2 + 2)) < 1e-9, String(m.get("SIG")));
  assert.equal(m.has(""), false); assert.equal(m.size, 1);
});
test("Schematic Setup: validation of the chain rows", () => {
  const row = (name, extra = {}) => Object.assign({ name, origName: name, nets: [], chainClass: "", netClass: "", color: "", from: "", to: "" }, extra);
  assert.equal(SP.chainRowsError([row("A"), row("")]), "Net chain on row 2 cannot have an empty name.");
  assert.equal(SP.chainRowsError([row("a b")]), "Net chain name 'a b' contains invalid characters.");
  assert.equal(SP.chainRowsError([row("A"), row("B", { name: "A" })]), "Duplicate net chain name 'A' on row 1.");
  assert.equal(SP.chainRowsError([row("A"), row("A", { deleted: true })]), null);
  assert.deepEqual(SP.chainColorOf("rgba(255, 128, 0, 0.500)"), [255, 128, 0, 0.5]); assert.equal(SP.chainColorOf(""), null);
});
test("Schematic Setup: ApplyEdits renames in order, moves classes, deletes last, then the class list", () => {
  const row = (name, extra = {}) => Object.assign({ name, origName: name, nets: ["x"], chainClass: "", netClass: "", color: "", from: "", to: "" }, extra);
  // A -> B fails while B still exists (B is only renamed after it); B -> C works; D is deleted
  const st = { chains: [row("B", { origName: "A", chainClass: "k1" }), row("C", { origName: "B" }), row("D", { deleted: true, chainClass: "k1" })], classes: ["k2"], classOrig: ["k1"], deletedClasses: [] };
  const r = SP.applyChainEdits(st, ["A", "B", "D"], { A: "k1", D: "k1", STALE: "k1" });
  assert.deepEqual(r.edits.map((e) => [e.orig, e.name]), [["A", "A"], ["B", "C"], ["D", null]]);
  // the class rename k1 -> k2 reaches the entries left with k1; D's entry went with D
  // (ns->SetNetChainClass( row.newName, … ) takes the row's name even when its rename was refused)
  assert.deepEqual(r.classes, { A: "k2", B: "k2", STALE: "k2" });
  // a deleted class clears every chain still assigned to it
  const st2 = { chains: [row("A")], classes: [], classOrig: [], deletedClasses: ["k1"] };
  assert.deepEqual(SP.applyChainEdits(st2, ["A"], { A: "k1", Z: "k1", Y: "k3" }).classes, { Y: "k3" });
  // colour and net class edits ride on the chain under its final name
  const st3 = { chains: [row("N", { origName: "A", netClass: "HS", color: "rgba(0, 0, 255, 1)" })], classes: [] };
  assert.deepEqual(SP.applyChainEdits(st3, ["A"], {}).edits, [{ orig: "A", name: "N", netClass: "HS", color: [0, 0, 255, 1] }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
