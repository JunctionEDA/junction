// pads-padstacks.test.js — the Footprint Editor's Create Array pad numbering (ARRAY_AXIS, ARRAY_PAD_NUMBER_PROVIDER,
// DIALOG_CREATE_ARRAY's numbering panels), the pad's padstack (mode, per-layer shapes, the (padstack …) writer),
// backdrills and post-machining (pad model and DRC's track_on_post_machined_layer), the Pad Properties dialog's
// extras, the through-hole size calculator, Footprint Properties' variant writes and Pad Edit Mode on undo / redo.
// Run: node server/static/tests/pads-padstacks.test.js
"use strict";
const fs = require("fs");
const path = require("path"), assert = require("assert/strict");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, M = K.padModel;
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
globalThis.window = globalThis.window || globalThis;
const load = (...rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("pads, padstacks and array pad numbering");

// ---------------------------------------------------------------- ARRAY_AXIS / ARRAY_PAD_NUMBER_PROVIDER
test("ARRAY_AXIS: alphabets, AlphabeticFromIndex and the numbering start", () => {
  assert.equal(P.axisAlphabet(0), "0123456789"); assert.equal(P.axisAlphabet(1), "0123456789ABCDEF");
  assert.equal(P.axisAlphabet(2), "ABCDEFGHJKLMNPRTUVWY"); assert.equal(P.axisAlphabet(3), "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  assert.equal(P.alphabeticFromIndex(0, P.axisAlphabet(3), true), "A");
  assert.equal(P.alphabeticFromIndex(25, P.axisAlphabet(3), true), "Z");
  assert.equal(P.alphabeticFromIndex(26, P.axisAlphabet(3), true), "AA", "the tens column starts at A");
  assert.equal(P.alphabeticFromIndex(10, P.axisAlphabet(0), false), "10");
  assert.equal(P.alphabeticFromIndex(255, P.axisAlphabet(1), false), "FF");
  assert.equal(P.axisNumberingOffset(3, "AA"), 26); assert.equal(P.axisNumberingOffset(2, "I"), null, "I is not in the IOSQXZ-free alphabet");
  assert.equal(P.axisNumberingOffset(0, "x"), null);
  const ax = { type: 3, offset: 0, step: 1 }; assert.equal(P.axisSetOffset(ax, "c"), true);
  assert.deepEqual([P.axisItemNumber(ax, 0), P.axisItemNumber(ax, 1)], ["c", "d"], "a lowercase start numbers in lowercase");
  const num = { type: 0, offset: 1, step: 2 }; assert.deepEqual([0, 1, 2].map((n) => P.axisItemNumber(num, n)), ["1", "3", "5"]);
});
test("ARRAY_GRID_OPTIONS::GetItemNumber in 2D and the pad number provider", () => {
  const g = { type: "grid", nx: 2, ny: 2, dx: 1, dy: 1, offX: 0, offY: 0, stagger: 1, staggerRows: true, centred: false, hThenV: true, twoD: true,
    pri: { type: 3, offset: 0, step: 1 }, sec: { type: 0, offset: 1, step: 1 } };
  assert.deepEqual([0, 1, 2, 3].map((n) => P.arrayItemNumber(g, n)), ["A1", "B1", "A2", "B2"]);
  const lin = { type: "grid", nx: 4, ny: 1, dx: 1, dy: 1, offX: 0, offY: 0, stagger: 1, staggerRows: true, centred: false, hThenV: true, pri: { type: 0, offset: 1, step: 1 }, shouldNumber: true };
  const p = P.arrayPadNumberProvider(["2", "3"], lin); assert.deepEqual([p.next(), p.next(), p.next()], ["1", "4", "5"], "numbers of unselected pads are skipped");
  const q = P.arrayPadNumberProvider(["2", "3"], { ...lin, numberingStartSpecified: true }); assert.deepEqual([q.next(), q.next()], ["1", "2"], "a set start reserves nothing");
});
const FP = `(footprint "Q"
	(version 20241229)
	(generator "pcbnew")
	(layer "F.Cu")
	(property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (uuid "11111111-1111-4111-8111-111111111111") (effects (font (size 1 1) (thickness 0.15))))
	(property "Value" "Q" (at 0 2 0) (layer "F.Fab") (uuid "22222222-2222-4222-8222-222222222222") (effects (font (size 1 1) (thickness 0.15))))
	(pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "44444444-4444-4444-8444-444444444444"))
	(pad "2" smd rect (at 5 5) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "55555555-5555-4555-8555-555555555555"))
)
`;
test("Create Array in the Footprint Editor numbers the pads (ARRAY_TOOL, footprint editor)", () => {
  const doc = K.parseDoc(FP, "footprint"); doc.fpEditor = true;
  const padId = [...doc.items.values()].find((it) => it.kind === "pad" && /\(pad "1"/.test(K.serialize(it.node)))?.id
    || [...doc.items.values()].find((it) => /\(pad "1"/.test(K.serialize(it.node)))?.id;
  assert.ok(padId, "the pad item");
  const o = { type: "grid", nx: 3, ny: 1, dx: 2, dy: 2, offX: 0, offY: 0, stagger: 1, staggerRows: true, centred: false, hThenV: true, shouldNumber: true, pri: { type: 0, offset: 1, step: 1 } };
  const r = P.arrayChanges(doc, [padId], o);
  const nums = r.changes.map((c) => /\(pad "([^"]*)"/.exec(c.sexpr)[1]);
  // pad "2" is not selected, so its number is reserved: the cells take 1, 3, 4 (the original, in the last cell, the last)
  assert.deepEqual(nums, ["1", "3", "4"]);
  const off = P.arrayChanges(K.parseDoc(FP, "footprint"), [padId], { ...o, shouldNumber: false });
  assert.ok(off.changes.every((c) => /\(pad "1"/.test(c.sexpr)), "Renumber pads off keeps the numbers");
});
test("DIALOG_CREATE_ARRAY: the numbering panels' options", () => {
  const A = load("domains", "pcb", "editor", "pcbdialogs", "array.ts"), D = A.ARRAY_DEFAULTS;
  let r = A.arrayOptions(D, true); assert.deepEqual(r.errors, []);
  assert.equal(r.opts.shouldNumber, true, "GridRenumberPads defaults on");
  assert.deepEqual([r.opts.pri.type, r.opts.pri.offset, r.opts.pri.step], [0, 1, 1]);
  r = A.arrayOptions({ ...D, gridNumStartSet: 1, grid2dArrayNumbering: 1, gridPrimaryAxisScheme: 3, gridPrimaryNumOffset: "1" }, true);
  assert.deepEqual(r.errors, ["Could not determine numbering start from '1': expected value consistent with alphabet 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'."]);
  assert.equal(A.startForScheme(3, "1"), "A"); assert.equal(A.startForScheme(0, "A"), "1");
  assert.equal(A.arrayOptions(D, false).opts.shouldNumber, false, "the board editor does not number pads");
});

// ---------------------------------------------------------------- the padstack
const D2 = (fps, copper = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"]) => ({ copper, items: new Map(fps.map((n, i) => [String(i), { kind: "footprint", node: n }])) });
const FP_THT = `(footprint "R" (layer "F.Cu") (at 0 0) (property "Reference" "R1")
  (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (uuid "a")))`;
const pad0 = (fp) => K.kids(fp, "pad")[0];
test("PADSTACK modes: read-through, mode change and the (padstack …) writer", () => {
  const fp = K.parse(FP_THT), d = D2([fp]); const was = M.readPad(d, fp, pad0(fp), ""); const m = structuredClone(was);
  assert.equal(m.psMode, "normal");
  const stack = { "F.Cu": M.layerShapeOf(m) };
  let edit = M.changePadstackMode(stack, "F.Cu", m, "fib"); m.psMode = "fib";
  assert.equal(edit, "F.Cu"); assert.ok(stack["In1.Cu"] && stack["B.Cu"], "the new layers start as F.Cu");
  assert.deepEqual(M.padstackEditLayers("fib", d.copper).map((x) => x[1]), ["F.Cu", "Inner Layers", "B.Cu"]);
  // edit the inner layers: an oval
  M.storeLayer(stack, edit, m); edit = "In1.Cu"; M.applyLayerShape(m, M.padstackLayer("fib", stack, stack["F.Cu"], edit));
  m.shape = "oval"; m.w = 2; m.h = 1.2; M.storeLayer(stack, edit, m);
  M.applyLayerShape(m, stack["F.Cu"]); const rest = { ...stack }; delete rest["F.Cu"]; m.psLayers = rest;
  assert.equal(M.padstackLayer("fib", m.psLayers, stack["F.Cu"], "In2.Cu").shape, "oval", "every inner layer reads the inner definition");
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  const s = K.serialize(pad0(fp));
  assert.ok(s.includes('(padstack (mode front_inner_back) (layer "Inner" (shape oval) (size 2 1.2) (thermal_bridge_angle 45)) (layer "B.Cu" (shape circle) (size 1.6 1.6)))'), s);
  // and it reads back the same
  const back = M.readPad(d, fp, pad0(fp), ""); assert.equal(back.psMode, "fib"); assert.equal(back.psLayers["In1.Cu"].shape, "oval"); assert.equal(back.psLayers["In1.Cu"].w, 2);
  // custom: every copper layer but F.Cu, in stack order
  const m2 = structuredClone(back); const st2 = { "F.Cu": M.layerShapeOf(m2), ...m2.psLayers };
  M.changePadstackMode(st2, "F.Cu", m2, "custom"); m2.psMode = "custom"; const r2 = { ...st2 }; delete r2["F.Cu"]; m2.psLayers = r2;
  const ps = M.formatPadstack(m2, M.cuStack(d.copper));
  assert.deepEqual([...ps.matchAll(/\(layer "([^"]+)"/g)].map((x) => x[1]), ["In1.Cu", "In2.Cu", "B.Cu"]);
  // back to normal drops the padstack
  const m3 = structuredClone(back); m3.psMode = "normal"; M.writePad(d, fp, pad0(fp), m3, back, () => 0);
  assert.ok(!K.serialize(pad0(fp)).includes("(padstack"), "Normal writes no padstack");
});
test("a flipped footprint's padstack is read front-relative and written back unchanged", () => {
  const FPB = `(footprint "R" (layer "B.Cu") (at 0 0) (property "Reference" "R1")
  (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no)
    (padstack (mode front_inner_back) (layer "Inner" (shape circle) (size 1.2 1.2)) (layer "B.Cu" (shape rect) (size 2 2))) (uuid "a")))`;
  const fp = K.parse(FPB), d = D2([fp]), before = K.serialize(fp); const was = M.readPad(d, fp, pad0(fp), "");
  assert.equal(was.shape, "rect", "the file's B.Cu is the front of a flipped footprint"); assert.equal(was.psLayers["B.Cu"].shape, "circle");
  M.writePad(d, fp, pad0(fp), structuredClone(was), was, () => 0); assert.equal(K.serialize(fp), before);
  assert.deepEqual(M.flipPadstack(M.flipPadstack(was, d.copper), d.copper).psLayers, was.psLayers, "FlipLayers twice is the identity");
});

// ---------------------------------------------------------------- backdrill and post-machining
test("Backdrill / post-machining: read, written per side, removed for a pad without a hole", () => {
  const fp = K.parse(FP_THT), d = D2([fp]); const was = M.readPad(d, fp, pad0(fp), ""); const m = structuredClone(was);
  Object.assign(m, { bdChoice: 1, bdTopSize: 1, bdTopEnd: "In1.Cu", pmBack: { mode: "countersink", size: 1.4, depth: 0, angle: 82 } });
  M.writePad(d, fp, pad0(fp), m, was, () => 0);
  let s = K.serialize(pad0(fp));
  assert.ok(s.includes('(backdrill (size 1) (layers "F.Cu" "In1.Cu"))'), s);
  assert.ok(s.includes("(back_post_machining countersink (size 1.4) (angle 82))"), s);
  const r = M.readPad(d, fp, pad0(fp), ""); assert.deepEqual([r.bdChoice, r.bdTopSize, r.bdTopEnd, r.pmBack.mode, r.pmBack.angle], [1, 1, "In1.Cu", "countersink", 82]);
  // a bottom one as well goes to the tertiary drill
  const m2 = structuredClone(r); Object.assign(m2, { bdChoice: 3, bdBotSize: 1.1, bdBotEnd: "In2.Cu" }); M.writePad(d, fp, pad0(fp), m2, r, () => 0);
  s = K.serialize(pad0(fp)); assert.ok(s.includes('(tertiary_drill (size 1.1) (layers "B.Cu" "In2.Cu"))'), s);
  // SMD: RemoveAllDrillsFromPadstack
  const r2 = M.readPad(d, fp, pad0(fp), ""); const m3 = structuredClone(r2); m3.type = "smd"; M.writePad(d, fp, pad0(fp), m3, r2, () => 0);
  s = K.serialize(pad0(fp)); assert.ok(!/backdrill|tertiary_drill|post_machining/.test(s), s);
});
const HEAD = '(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user)) (net 0 "") (net 1 "N") ';
const BD = `(footprint "R" (layer "F.Cu") (at 100 50) (uuid "fp") (property "Reference" "R1")
    (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (remove_unused_layers no) (net 1 "N")
      (backdrill (size 1) (layers "F.Cu" "In1.Cu")) (uuid "p")))
  (gr_rect (start 90 40) (end 120 60) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))`;
test("DRC: track_on_post_machined_layer on the backdrilled layers only", () => {
  const run = (layer) => { const doc = K.parseDoc(HEAD + BD + ` (segment (start 100 50) (end 105 50) (width 0.25) (layer "${layer}") (net 1) (uuid "s"))`, "kicad_pcb");
    return P.drc(doc, null, {}).filter((x) => x.code === "track_on_post_machined_layer"); };
  const f = run("F.Cu"); assert.equal(f.length, 1); assert.equal(f[0].text, "Track connected to post-machined or backdrilled layer"); assert.equal(f[0].severity, "error");
  assert.equal(run("In1.Cu").length, 1, "the must-cut layer is drilled too");
  assert.equal(run("In2.Cu").length, 0); assert.equal(run("B.Cu").length, 0);
  const doc = K.parseDoc(HEAD + BD + ")", "kicad_pcb"); const fp = [...doc.items.values()].find((it) => it.kind === "footprint"); const pad = K.kids(fp.node, "pad")[0];
  assert.ok(M.machiningKnockout(doc, pad, "F.Cu") > 0 && M.machiningKnockout(doc, pad, "In2.Cu") === 0);
});

// ---------------------------------------------------------------- the through-hole size calculator
test("PANEL_PTH_SIZE: IPC-2222B range, the recommended hole and the report", () => {
  const C = load("domains", "pcb", "calculator", "model.ts"), IU = 1e6;
  const lead = { shape: "round", minX: 0.6 * IU, maxX: 0.7 * IU, minY: 0, maxY: 0 };
  const r = C.pthHoleRange(1, lead); assert.deepEqual([r.holeMin, r.holeMax], [0.9 * IU, 1.3 * IU]);
  assert.equal(C.pthRecommendedHole(r, 0.05 * IU, true), 1.1 * IU);
  assert.equal(C.pthRecommendedHole({ ...r, holeMin: 1.01 * IU, holeMax: 1.03 * IU }, 0.05 * IU, false), 1.05 * IU, "never under the minimum");
  assert.equal(C.pthRecommendedHole({ ...r, holeMin: 1.0 * IU, holeMax: 1.03 * IU }, 0.05 * IU, false), 1.0 * IU, "the nearest step");
  const sq = C.pthHoleRange(0, { shape: "square", minX: 0.5 * IU, maxX: 0.5 * IU, minY: 0, maxY: 0 }); assert.equal(sq.leadMax, Math.round(Math.hypot(0.5, 0.5) * IU));
  assert.deepEqual([C.fmtMm3(1.1 * IU), C.fmtMm3(0.25 * IU), C.fmtMm3(1234 * IU)], ["1.1", "0.25", "1.23e+03"]);
  const t = C.pthReportText(1, lead, 0.4 * IU, r, 1.1 * IU, 1.9 * IU);
  assert.ok(t.startsWith("Standard:                      IPC-2222B\n"), t); assert.ok(t.includes("Pad diameter:                  1.9 mm\n"), t);
  assert.ok(src("domains", "pcb", "calculator", "index.ts").includes('{ label: "Footprint design", pages: [{ label: "Through-hole Size", build: pthSizePage }] }'));
});

// ---------------------------------------------------------------- the dialogs (source checks of the UI wiring)
test("Pad Properties: padstack edit, Backdrill page, warning, labels, pictures, memory", () => {
  const s = src("domains", "pcb", "editor", "pcbdialogs", "pad-props.ts");
  assert.ok(s.includes('onChange: (v) => onPadstackMode(v)') && s.includes("PM().changePadstackMode(stack, editLayer, m, v)"), "the mode select is live");
  assert.ok(s.includes('editLayerSel.addEventListener("change"') && s.includes("PM().padstackLayer(m.psMode, stack"), "the edit layer loads its shape");
  assert.ok(s.includes('{ label: "Backdrill", build: (el) => el.append(backdrill) }') && s.includes('box("Hole Post Machining"') && s.includes('box("Backdrilling"'));
  assert.ok(s.includes('"Switching to non-circular hole will disable backdrills and post-machining. Continue?"'));
  assert.ok(s.includes('"Diameter:" : "Hole size X:"') && s.includes('"Diameter:" : "Pad size X:"') && s.includes('"teardrop_sizes" : "teardrop_rect_sizes"'));
  assert.ok(s.includes('"pads_remove_unused_keep_bottom"') && s.includes("back side (mirrored)") && s.includes("rotated"));
  assert.ok(s.includes("lastPage = i") && s.includes("sketchPreview = v") && s.includes("mem.lastNumber = m.number"));
  assert.ok(s.includes('openCalculator("pth_size")'), "the hole size calculator button");
  const icons = JSON.parse(fs.readFileSync(webPath("domains", "pcb", "generated", "kicad-menu-icons.json"), "utf8")).icons;
  for (const n of ["pads_reset_unused", "pads_remove_unused_keep_bottom", "pads_remove_unused", "pads_npth_top_bottom", "pads_npth_top", "pads_npth_bottom", "pads_npth", "teardrop_sizes", "teardrop_rect_sizes", "calculator"]) assert.ok(icons[n], n);
});
test("Footprint Properties: page memory, Reference focus, every variant field and flag; shapes keep the mask margin", () => {
  const s = src("domains", "pcb", "editor", "pcbdialogs", "item-props.ts");
  assert.ok(s.includes("{ start: fpLastPage, onShow: (i) => { fpLastPage = i; } }") && s.includes("selectReferenceNumber(cell)"));
  assert.ok(s.includes("if (variant) variantFields[String(r.name)] =") && s.includes("for (const f of flags) if ((VM.FP_FLAG_KEYS as string[]).includes(f.k)) vpatch["));
  assert.ok(!s.includes('if (!mask) { if (mm0) put(n, "solder_mask_margin", null); }'), "the margin is not dropped with the mask off");
});
test("PAD_TOOL::OnUndoRedo: Pad Edit Mode follows the pad's ENTERED flag through undo and redo", () => {
  const s = src("domains", "pcb", "editor", "fpedit.ts");
  assert.ok(s.includes("flagPadEditStep(null, id)") && s.includes("flagPadEditStep(id, null)"));
  assert.ok(s.includes("e.undoOthers = () => { if (pu) pu(); padEditOnUndoRedo(before); }") && s.includes("e.redoOthers = () => { if (pr) pr(); padEditOnUndoRedo(after); }"));
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
