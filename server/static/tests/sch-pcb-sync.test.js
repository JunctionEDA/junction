// sch-pcb-sync.test.js — schematic <-> board synchronisation as KiCad does it: Update PCB from Schematic
// (BOARD_NETLIST_UPDATER), Update Schematic from PCB (BACK_ANNOTATE), cross-probing (FindItemsFromSyncSelection,
// ZoomFitCrossProbeBBox) and the Geographical Reannotate change log order.
// Run: node server/static/tests/sch-pcb-sync.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, P = globalThis.PcbTools;
const BA = load(["dialogs", "update-from-pcb-logic.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

// ---------------------------------------------------------------- Update PCB from Schematic
const LAYERS = `(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))`;
const fp = (uuid, ref, p, nets) => `(footprint "Capacitor_SMD:C_0805" (layer "F.Cu") (uuid "${uuid}") (at 10 10)
  (property "Reference" "${ref}" (at 0 -1.4 0) (layer "F.SilkS") (uuid "r${uuid}") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "47uF" (at 0 1.4 0) (layer "F.Fab") (uuid "v${uuid}") (effects (font (size 1 1) (thickness 0.15))))
  ${p ? `(path "${p}") (sheetname "/") (sheetfile "demo.kicad_sch")` : ""} (attr smd)
  (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") ${nets[0] ? `(net 1 "${nets[0]}")` : ""} (uuid "p1${uuid}"))
  (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") ${nets[1] ? `(net 2 "${nets[1]}")` : ""} (uuid "p2${uuid}")))`;
const board = (fps) => K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6)) (paper "A4") ${LAYERS} (net 0 "") (net 1 "/A") (net 2 "/OLD")\n${fps})`, "kicad_pcb");
const comp = (ref, p, pins) => ({ ref, value: "47uF", footprint: "Capacitor_SMD:C_0805", libId: "Device:C", paths: [p], fields: {}, sheetName: "/", sheetFile: "demo.kicad_sch",
  dnp: false, excludeFromBom: false, excludeFromBoard: false, pins: new Map(pins), variants: [] });
const texts = (plan, sev) => plan.report.filter((r) => !sev || r.severity === sev).map((r) => r.text);

test("BOARD_COMMIT::Push: the pads' new nets propagate along the copper that touches them; other copper keeps its net", () => {
  const tracks = `(segment (start 11 10) (end 20 10) (width 0.25) (layer "F.Cu") (net 2) (uuid "s1"))
    (segment (start 20 10) (end 20 20) (width 0.25) (layer "F.Cu") (net 2) (uuid "s2"))
    (segment (start 40 40) (end 50 40) (width 0.25) (layer "F.Cu") (net 1) (uuid "s3"))
    (segment (start 11 10) (end 20 10) (width 0.25) (layer "B.Cu") (net 2) (uuid "s4"))`;
  const doc = board(fp("f1", "C1", "/s1", ["/A", "/OLD"]) + tracks);
  const nl = { components: [comp("C1", "/s1", [["1", { net: "/A", type: "passive" }], ["2", { net: "/NEW", type: "passive" }]])], nets: new Map(), warnings: [] };
  const plan = N.planUpdate(doc, nl, { updateFields: true, applied: true });
  // the net as the modified item records it (a code, or the name the new pad carries for that code)
  const pad2 = K.kids(plan.modified.get("f1"), "pad").find((p) => K.str(p[1]) === "2"), padNet = K.kid(pad2, "net");
  assert.equal(K.str(padNet[padNet.length - 1]), "/NEW");
  const NEW = String(padNet[1]);
  const netOf = (id) => { const n = plan.modified.get(id); if (!n) return null; const k = K.kid(n, "net"); return String(k[1]) === NEW ? "/NEW" : String(k[1]); };
  assert.equal(netOf("s1"), "/NEW"); assert.equal(netOf("s2"), "/NEW");
  assert.equal(netOf("s3"), null, "copper on a net its pads keep is untouched");
  // the pad is on F.Cu only: the B.Cu track reaches no pad, and its net (no pad keeps /OLD) follows the rename
  assert.equal(netOf("s4"), "/NEW");
});
test("dry run vs applied: present / past tense, 'Removed unused net' only after applying, two blank lines before the totals", () => {
  const doc = board(fp("f1", "C1", "/s1", ["/A", "/OLD"]));
  const nl = { components: [comp("C1", "/s1", [["1", { net: "/A", type: "passive" }], ["2", { net: "/NEW", type: "passive" }]])], nets: new Map(), warnings: [] };
  const dry = N.planUpdate(doc, nl, { updateFields: true });
  assert.ok(texts(dry).includes("Reconnect C1 pin 2 from /OLD to /NEW."), texts(dry).join("\n"));
  assert.ok(!texts(dry).some((t) => /unused net/.test(t)));
  const run = N.planUpdate(doc, nl, { updateFields: true, applied: true });
  const t = texts(run);
  assert.ok(t.includes("Reconnected C1 pin 2 from /OLD to /NEW."), t.join("\n"));
  assert.ok(t.includes("Add net /NEW."), "'Add net' has no past tense in KiCad");
  assert.ok(t.includes("Removed unused net /OLD."));
  assert.deepStrictEqual(t.slice(-3), ["", "", "Total warnings: 0, errors: 0."]);
});

test("a footprint without a symbol keeps its pad nets; footprints are matched by path unless re-linking (then by reference, any case)", () => {
  const doc = board(fp("f1", "C1", "/s1", ["/A", "/OLD"]) + fp("f2", "H1", "", ["/A", ""]));
  const nl = { components: [comp("C1", "/s1", [["1", { net: "/A", type: "passive" }], ["2", { net: "/OLD", type: "passive" }]])], nets: new Map(), warnings: [] };
  const plan = N.planUpdate(doc, nl, { updateFields: true });
  assert.ok(!texts(plan).some((t) => /H1/.test(t)), texts(plan).join("\n"));
  assert.ok(!plan.modified.has("f2"));
  const nl2 = { components: [comp("c1", "/zz", [["1", { net: "/A", type: "passive" }], ["2", { net: "/OLD", type: "passive" }]])], nets: new Map(), warnings: [] };
  assert.ok(texts(N.planUpdate(board(fp("f1", "C1", "/s1", ["/A", "/OLD"])), nl2, {})).some((t) => /^Cannot add c1 /.test(t)));
  const rl = N.planUpdate(board(fp("f1", "C1", "/s1", ["/A", "/OLD"])), nl2, { relinkByRef: true });
  assert.ok(!texts(rl).some((t) => /^Cannot add/.test(t)), texts(rl).join("\n"));
});

// ---------------------------------------------------------------- Update Schematic from PCB
const sym = (o) => Object.assign({ key: "/a", keys: ["/a"], ref: "R1", power: false, value: "1k", footprint: "R:R_0603", dnp: false, inBom: true, inPos: true, onBoard: true, exSim: false, fields: new Map(), pins: new Map(), sheetPath: ["root"], uuid: "a" }, o);
const fpd = (o) => Object.assign({ ref: "R1", path: "/a", fpid: "R:R_0603", value: "1k", dnp: false, excludeFromBom: false, excludeFromSim: false, excludeFromPos: false, fields: new Map(), pads: new Map() }, o);
const ALL = { relink: false, references: true, footprints: true, values: true, netNames: true, attributes: true, otherFields: true };

test("back-annotation: head lines (changes) before tail lines (cannot find symbol), no totals line", () => {
  const r = BA.backAnnotate([sym()], [fpd({ ref: "R9", path: "/zz" }), fpd({ value: "2k" })], ALL);
  assert.deepStrictEqual(r.lines.map((l) => l.severity + ":" + l.text), ["action:Change R1 value from '1k' to '2k'.", "error:Cannot find symbol for footprint 'R9'."]);
});
test("back-annotation: 'Exclude from simulation' between the BOM and position-files lines", () => {
  const r = BA.backAnnotate([sym()], [fpd({ excludeFromBom: true, excludeFromSim: true, excludeFromPos: true })], ALL);
  assert.deepStrictEqual(r.lines.map((l) => l.text), ["Change R1 'Exclude from bill of materials' from 'false' to 'true'.", "Change R1 'Exclude from simulation' from 'false' to 'true'.", "Change R1 'Exclude from position files' from 'false' to 'true'."]);
  assert.strictEqual(r.edits[0].exSim, true);
  assert.strictEqual(BA.fpData(K.parse('(footprint "X:Y" (path "/a") (property "Reference" "R1") (attr smd exclude_from_sim))')).excludeFromSim, true);
});
test("back-annotation: a reference change is never refused for duplicates (two footprints swapping references)", () => {
  const r = BA.backAnnotate([sym({ key: "/a", uuid: "a" }), sym({ key: "/b", uuid: "b", ref: "R2" })], [fpd({ ref: "R2", path: "/a" }), fpd({ ref: "R1", path: "/b" })], Object.assign({}, ALL, { footprints: false, values: false, attributes: false, netNames: false, otherFields: false }));
  assert.deepStrictEqual(r.lines.map((l) => l.text), ["Change R1 reference designator to 'R2'.", "Change R2 reference designator to 'R1'."]);
});
test("back-annotation: unused-symbol warnings only for symbols excluded from the board, passed over before a linked one", () => {
  const syms = [sym({ key: "/a", uuid: "a", ref: "R1", onBoard: false }), sym({ key: "/b", uuid: "b", ref: "R2", onBoard: true }), sym({ key: "/c", uuid: "c", ref: "R3" }), sym({ key: "/d", uuid: "d", ref: "R4", onBoard: false })];
  const r = BA.backAnnotate(syms, [fpd({ ref: "R3", path: "/c" })], ALL);
  assert.deepStrictEqual(r.lines.map((l) => l.text), ["Footprint 'R1' is not present on PCB. Corresponding symbols in schematic must be manually deleted (if desired)."]);
  const rl = BA.backAnnotate(syms, [fpd({ ref: "R3", path: "/c" })], Object.assign({}, ALL, { relink: true, references: false, annotated: false }));
  assert.strictEqual(rl.lines[rl.lines.length - 1].text, "Footprint re-linking canceled by user.");
});
test("back-annotation: the footprint of a multi-unit symbol reports each unit's change", () => {
  const units = [{ key: "/u1", unit: 1, unitPins: new Map([[1, ["1"]], [2, ["2"]]]), pinTypes: new Map() }, { key: "/u2", unit: 2, unitPins: new Map([[1, ["1"]], [2, ["2"]]]), pinTypes: new Map() }];
  const syms = units.map((u) => sym({ key: u.key, uuid: u.key, keys: ["/u1", "/u2"], ref: "U1", multi: true, units, self: u, value: "LM358" }));
  const r = BA.backAnnotate(syms, [fpd({ ref: "U1", path: "/u2", value: "TL072" })], Object.assign({}, ALL, { footprints: false }));
  assert.deepStrictEqual(r.lines.map((l) => l.text), ["Change U1 value from 'LM358' to 'TL072'.", "Change U1 value from 'LM358' to 'TL072'."]);
  assert.deepStrictEqual(r.edits.map((e) => e.key), ["/u1", "/u2"]);
});
test("back-annotation pin swaps: only hidden power_in pins are left out; a symbol on several sheets names them", () => {
  const self = { key: "/u1", unit: 1, unitPins: new Map([[1, ["1", "2"]]]), pinTypes: new Map([["1", "power_in"], ["2", "power_in"]]), hiddenPins: new Set(), shared: true, sharedSheets: ["A", "B"], sharedProjects: [] };
  const s = sym({ key: "/u1", ref: "U1", pins: new Map([["1", "/A"], ["2", "/B"]]), self });
  const o = Object.assign({}, ALL, { footprints: false, values: false, references: false, attributes: false, otherFields: false, pinSwaps: true, allowPinSwaps: true });
  const r = BA.backAnnotate([s], [fpd({ ref: "U1", path: "/u1", pads: new Map([["1", "/B"], ["2", "/A"]]) })], o);
  assert.strictEqual(r.lines[0].text, "Would swap U1 pins 1 and 2 to match PCB, but the symbol is used by multiple sheet instances (A, B).");
  self.hiddenPins = new Set(["1"]);
  const h = BA.backAnnotate([s], [fpd({ ref: "U1", path: "/u1", pads: new Map([["1", "/B"], ["2", "/A"]]) })], o);
  assert.ok(!h.lines.some((l) => /swap/.test(l.text)), h.lines.map((l) => l.text).join("\n"));
});

// ---------------------------------------------------------------- cross-probing
test("FindItemsFromSyncSelection: footprints by reference, pads by reference and number, footprints within a sheet path", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20241229) (generator "pcbnew") ${LAYERS}
    ${fp("f1", "C1", "/s1/c1", ["", ""])}
    ${fp("f2", "C2", "/s2/c2", ["", ""])})`, "kicad_pcb");
  assert.deepStrictEqual(P.findItemsFromSyncSelection(doc, [{ footprint: "C2" }]), ["f2"]);
  assert.deepStrictEqual(P.findItemsFromSyncSelection(doc, [{ pad: { ref: "C1", number: "2" } }]), ["f1#1"]);
  assert.deepStrictEqual(P.findItemsFromSyncSelection(doc, [{ sheetPath: ["root", "s2"] }]), ["f2"]);
  // ordered by the spec that found them
  assert.deepStrictEqual(P.findItemsFromSyncSelection(doc, [{ footprint: "C2" }, { footprint: "C1" }]), ["f2", "f1"]);
});
test("ZoomFitCrossProbeBBox (board): the bent ratio, no zoom within 0.5 .. 1", () => {
  // a 2 x 1 mm part grows by 0.4 mm on each side: 2.8 x 1.8 mm, compRatio 1.8 bends to 5 + (3 - 5) * 0.3 / 1.5 = 4.6; ratio 1.8 / 100 * 4.6
  const r = P.crossProbeZoomRatio(2, 1, 200, 100);
  assert.ok(Math.abs(r - 1.8 / 100 * 4.6) < 1e-9, String(r));
  assert.strictEqual(P.crossProbeZoomRatio(0, 1, 200, 100), null);
  // a 50 x 40 mm box in a 100 x 100 mm view: ratio (40 + 20) / 100 = 0.6 with factor 1: the zoom stays
  assert.strictEqual(P.crossProbeZoomRatio(50, 40, 100, 100), null);
});

// ---------------------------------------------------------------- Geographical Reannotate
test("Geographical Reannotate: the change log sorts case-sensitively (StrNumCmp, CMP_T::CASE_SENSITIVE)", () => {
  const f = (ref, x) => `(footprint "T:R" (layer "F.Cu") (uuid "u-${ref}") (at ${x} 10) (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "p-${ref}") (effects (font (size 1 1) (thickness 0.15)))))`;
  const doc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) ${f("a5", 10)} ${f("B5", 20)})`, "kicad_pcb");
  const r = P.geographicalReannotate(doc, { sortCode: 0, useFootprintLocation: true, grid: 1.27, scope: "all", excludeLocked: true, exclude: "", frontStart: "1", backStart: "", frontPrefix: "", backPrefix: "", removeFrontPrefix: false, removeBackPrefix: false });
  const t = r.report.map((l) => l.text), i = t.indexOf("Change Log");
  assert.deepStrictEqual(t.slice(i + 2, i + 4), ["B5 -> B1", "a5 -> a1"], "'B' (66) sorts before 'a' (97)");
});

console.log(`sch-pcb-sync: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
