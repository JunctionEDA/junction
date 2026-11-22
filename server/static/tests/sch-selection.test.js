// sch-selection.test.js — SCH_SELECTION_TOOL ported: the click collector (CollectHits: one threshold, each item's own
// HitTest), narrowSelection's filter and GuessSelectionCandidates, SelectMultiple over a box and a lasso, the staged
// Select Connection, Select Node, the magnetic snap ranges and anchors (EE_GRID_HELPER), the string incrementer behind
// Shift+Alt / Ctrl+Alt+wheel and the cross-probe zoom rule.
// Run: node server/static/tests/sch-selection.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._, IU = 1e4;

const HEAD = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "root-uuid") (paper "A4")
  (lib_symbols
    (symbol "Dev:U" (pin_names (offset 1.016)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 6.35 0) (effects (font (size 1.27 1.27))))
      (property "Value" "U" (at 0 -6.35 0) (effects (font (size 1.27 1.27))))
      (symbol "U_0_1" (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254) (type default)) (fill (type background))))
      (symbol "U_1_1"
        (pin input line (at -7.62 2.54 0) (length 2.54) (name "IN" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin output line (at 7.62 2.54 180) (length 2.54) (name "OUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))
  (symbol (lib_id "Dev:U") (at 50.8 50.8 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "u1")
    (property "Reference" "U1" (at 50.8 40.64 0) (effects (font (size 1.27 1.27))))
    (property "Value" "U" (at 50.8 60.96 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "p1")) (pin "2" (uuid "p2"))
    (instances (project "t" (path "/root-uuid" (reference "U1") (unit 1)))))
`;
const W = (id, a, b) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const EXTRA = W("w1", [30.48, 48.26], [43.18, 48.26]) + W("w2", [30.48, 48.26], [30.48, 60.96]) + W("w3", [30.48, 48.26], [20.32, 48.26]) + `
 (junction (at 30.48 48.26) (diameter 0) (color 0 0 0 0) (uuid "j1"))
 (label "NET" (at 35.56 48.26 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))
 (no_connect (at 20.32 48.26) (uuid "nc1"))
 (rectangle (start 80 40) (end 100 60) (stroke (width 0) (type default)) (fill (type color) (color 255 0 0 1)) (uuid "r1"))
 (rectangle (start 110 40) (end 130 60) (stroke (width 0) (type default)) (fill (type none)) (uuid "r2"))
 (text "hi" (at 90 50 0) (effects (font (size 1.27 1.27))) (uuid "t1"))
 (polyline (pts (xy 140 40) (xy 150 40)) (stroke (width 0) (type default)) (uuid "g1"))
 (polyline (pts (xy 150 40) (xy 150 50)) (stroke (width 0) (type default)) (uuid "g2"))
 (polyline (pts (xy 160 40) (xy 170 40)) (stroke (width 0) (type default)) (uuid "g3"))`;
const SHEET = HEAD + EXTRA + ")";

let passed = 0, failed = 0;
function test(name, fn) { try { globalThis.CollabEditor = undefined; sch.state.snapItem = null; fn(); passed++; } catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n     ")); } }
function makeCtx(doc, pxPerMm) {
  const ctx = { K, doc, IU, isSch: true, zoom: 1, pxPerMm: pxPerMm || 8, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), cursor: null, lastSelection: null,
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; }, setSelection(ids) { ctx.lastSelection = Array.from(ids); ctx.selection = new Set(ctx.lastSelection); },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU), c.sexpr); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); } };
  return ctx;
}
const fresh = (px) => { const d = K.parseDoc(SHEET), c = makeCtx(d, px); sch.onDocChanged(c); return { d, c }; };
const keys = (r) => r.cands.map((q) => q.key);
const collected = (c, mm) => _.collectHits(c, mm).map((q) => q.key).sort();

test("CollectHits: one threshold, max( 5 px, |grid| / 2 ), for every item; a symbol by its body box grown by half of it", () => {
  const { d, c } = fresh();
  const thr = _.selectThreshold(c); assert.ok(Math.abs(thr - Math.hypot(1.27, 1.27) / 2) < 1e-9);
  // 0.8 mm off a wire: inside the 0.898 mm threshold (the old 5 px = 0.625 mm would miss it)
  assert.deepStrictEqual(collected(c, [38, 49.06]), ["w1"]);
  assert.deepStrictEqual(collected(c, [38, 49.3]), []);
  const body = _.bodyBox(d, d.items.get("u1"));
  assert.ok(collected(c, [50.8, body[3] + thr / 2 - 0.02]).includes("u1"), "threshold / 2 outside the body box");
  assert.ok(!collected(c, [50.8, body[3] + thr / 2 + 0.05]).includes("u1"));
  // the Reference text is outside the body: its own candidate, the symbol is not hit there
  assert.deepStrictEqual(collected(c, [50.8, 40.64]), ["u1@field:Reference"]);
});

test("GuessSelectionCandidates: exact hits beat sloppy ones, an exact pin or junction wins outright", () => {
  const { c } = fresh();
  assert.deepStrictEqual(collected(c, [43.18, 48.26]), ["u1#pin:1", "w1"]);
  assert.deepStrictEqual(keys(_.clickCandidates(c, [43.18, 48.26])), ["u1#pin:1"], "the pin under a wire end");
  assert.deepStrictEqual(collected(c, [30.48, 48.26]), ["j1", "w1", "w2", "w3"]);
  assert.deepStrictEqual(keys(_.clickCandidates(c, [30.48, 48.26])), ["j1"], "the junction on three wire ends");
  // a label's body box is above its wire: on the wire only the wire is exact, on the text only the label
  assert.deepStrictEqual(collected(c, [36, 48.3]), ["l1", "w1"]);
  assert.deepStrictEqual(keys(_.clickCandidates(c, [36, 48.3])), ["w1"]);
  assert.deepStrictEqual(keys(_.clickCandidates(c, [36.5, 47.2])), ["l1"]);
  // inside the body: the symbol; RequestSelection( MovableItems ) scans no pins
  assert.deepStrictEqual(keys(_.clickCandidates(c, [52, 53])), ["u1"]);
  assert.deepStrictEqual(keys(_.clickCandidates(c, [43.18, 48.26], false, true)), ["w1"]);
  // skipping the heuristics (Alt, the long press) lists everything collected: pins and fields too
  assert.deepStrictEqual(keys(_.clickCandidates(c, [43.18, 48.26], true)).sort(), ["u1#pin:1", "w1"]);
});

test("a solid-filled shape is hit anywhere inside but never beats what lies in it; an unfilled one only on its outline", () => {
  const { d, c } = fresh();
  assert.ok(_.shapeFilled(d.items.get("r1"))); assert.ok(!_.shapeFilled(d.items.get("r2")));
  assert.deepStrictEqual(keys(_.clickCandidates(c, [85, 45])), ["r1"], "the interior of the filled rectangle");
  assert.deepStrictEqual(collected(c, [90, 50]), ["r1", "t1"]);
  assert.deepStrictEqual(keys(_.clickCandidates(c, [90, 50])), ["t1"], "the text inside it wins (the fill is dominating)");
  assert.deepStrictEqual(keys(_.clickCandidates(c, [120, 50])), [], "inside an unfilled rectangle");
  assert.deepStrictEqual(keys(_.clickCandidates(c, [110, 50])), ["r2"]);
  assert.strictEqual(_.hitNonSymbol(d, 85, 45, 0.9).id, "r1");
  assert.strictEqual(_.hitNonSymbol(d, 90, 50, 0.9).id, "t1");
  assert.strictEqual(_.pickNonSymbol(c, [85, 45]).id, "r1");
});

test("junction and no-connect hit shapes: the junction's circle, the no-connect's square of half side ( pen + size ) / 2", () => {
  const { d } = fresh();
  const cand = (id) => ({ key: id, kind: "item", item: d.items.get(id) });
  assert.ok(_.candHit(d, cand("j1"), [30.48 + 0.45, 48.26], 0)); assert.ok(!_.candHit(d, cand("j1"), [30.48 + 0.47, 48.26], 0), "radius 18 mils");
  d.items.get("j1").node.splice(2, 1, ["diameter", 2]);
  assert.ok(_.candHit(d, cand("j1"), [31.4, 48.26], 0), "its own diameter");
  assert.ok(_.candHit(d, cand("nc1"), [20.32 + 0.68, 48.26 + 0.68], 0), "a corner of the square");
  assert.ok(!_.candHit(d, cand("nc1"), [20.32 + 0.7, 48.26], 0));
  assert.ok(!_.hitNonSymbol(d, 20.32 + 0.75, 48.26 + 5, 0.01));
});

test("the Selection Filter rejects candidates by KiCad's categories and reports which; hidden directive labels are not selectable", () => {
  const { d, c } = fresh();
  const off = new Set(["wires"]);
  const cat = (it) => (it.kind === "symbol" || it.kind === "sheet" ? "symbols" : it.kind === "wire" || it.kind === "bus" || it.kind === "junction" ? "wires" : "other");
  globalThis.CollabEditor = { schCandRejects: (kind, it) => (kind === "pin" ? (off.has("pins") ? "pins" : null) : kind === "field" ? (off.has("text") ? "text" : null) : off.has(cat(it)) ? cat(it) : null) };
  let r = _.clickCandidates(c, [41, 48.26]);
  assert.deepStrictEqual([keys(r), r.pre, r.rejected], [[], 1, ["wires"]], "a wire with Wires off: the box to flash");
  r = _.clickCandidates(c, [30.48, 48.26]); assert.deepStrictEqual([keys(r), r.rejected], [[], ["wires"]], "a junction is filtered with the wires");
  // pins off: the pin brings its symbol (CollectHits appends the parent), which is then what the click picks
  off.clear(); off.add("pins");
  r = _.clickCandidates(c, [44.5, 48.26]); assert.deepStrictEqual(keys(r), ["u1"]);
  // "Clicking on a pin selects the symbol"
  globalThis.CollabEditor = { pinSelectsSymbol: true };
  assert.deepStrictEqual(keys(_.clickCandidates(c, [44.5, 48.26])), ["u1"]);
  globalThis.CollabEditor = undefined;
  assert.deepStrictEqual(keys(_.clickCandidates(c, [44.5, 48.26])), ["u1#pin:1"]);
  const dl = K.createItem(d, K.parse('(netclass_flag "" (length 2.54) (shape round) (at 38.1 48.26 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "d1") (property "Netclass" "X" (at 38.1 45 0) (effects (font (size 1.27 1.27)))))'));
  assert.ok(_.selectableItem(d, dl));
  globalThis.CollabEditor = { renderOpts: { showDirectiveLabels: false } };
  assert.ok(!_.selectableItem(d, dl)); assert.ok(_.selectableItem(d, d.items.get("w1")));
  assert.ok(!keys(_.clickCandidates(c, [38.1, 47])).includes("d1"));
});

test("SelectMultiple over a box: a symbol by its body box, shapes by their outline, lines by ends, fields and pins on their own", () => {
  const { d, c } = fresh();
  const ids = (r) => r.items.map((q) => q.item.id).sort();
  const body = _.bodyBox(d, d.items.get("u1"));
  // left to right around the body only (the Reference text at y 40.64 and the pin ends stay outside): the symbol is taken
  let r = _.areaCandidates(c, { box: [body[0] - 0.2, body[1] - 0.2, body[2] + 0.2, body[3] + 0.2], contained: true });
  assert.deepStrictEqual([ids(r), r.fields, r.pins], [["u1"], [], []]);
  // right to left touching only the Reference text: the field, not the symbol
  r = _.areaCandidates(c, { box: [49, 39.5, 52, 41.5], contained: false });
  assert.deepStrictEqual([ids(r), r.fields, r.pins], [[], [{ id: "u1", name: "Reference" }], []]);
  // a box over the tip of pin 2 alone: the pin (nothing else was boxed)
  r = _.areaCandidates(c, { box: [57, 47.5, 59, 49], contained: false });
  assert.deepStrictEqual([ids(r), r.fields, r.pins], [[], [], [{ id: "u1", number: "2" }]]);
  // a touching box inside the unfilled rectangle misses it; across its edge takes it; the filled one likewise by outline
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [115, 45, 125, 55], contained: false })), []);
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [105, 45, 115, 55], contained: false })), ["r2"]);
  // contained mode: a wire with one end inside is taken by that end when it dangles (w2's far end), not otherwise
  r = _.areaCandidates(c, { box: [28, 58, 33, 63], contained: true });
  assert.deepStrictEqual(r.items.map((q) => [q.item.id, q.end]), [["w2", 1]]);
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [28, 46, 33, 50], contained: true })), ["j1"], "ends on a junction are not dangling");
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [28, 46, 33, 50], contained: false })), ["j1", "w1", "w2", "w3"]);
});

test("box selection and groups: a member counts in contained mode only when the whole group is inside", () => {
  const { d, c } = fresh();
  K.createItem(d, K.parse('(group "G" (uuid "grp") (members "g1" "g2"))'));
  const ids = (r) => r.items.map((q) => q.item.id).sort();
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [139, 39, 151, 41], contained: true })), [], "g1 alone inside: a group member is left out");
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [139, 39, 151, 51], contained: true })), ["g1", "g2"], "the whole group inside");
  assert.deepStrictEqual(ids(_.areaCandidates(c, { box: [139, 39, 145, 41], contained: false })), ["g1"], "touching mode takes the member (its group follows)");
});

test("lasso: clockwise is INSIDE_LASSO (contained), anticlockwise TOUCHING_LASSO; items by their own shape", () => {
  const { c } = fresh();
  const ids = (r) => r.items.map((q) => q.item.id).sort();
  const cw = [[105, 35], [135, 35], [135, 65], [105, 65]], ccw = cw.slice().reverse();
  assert.ok(_.polyArea(cw) > 0, "clockwise on screen (Y down) is positive"); assert.ok(_.polyArea(ccw) < 0);
  assert.deepStrictEqual(ids(_.areaCandidates(c, { poly: cw, contained: _.polyArea(cw) > 0 })), ["r2"]);
  // a lasso across the rectangle's left edge only: contained misses it, touching takes it
  const part = [[105, 45], [115, 45], [115, 55], [105, 55]];
  assert.deepStrictEqual(ids(_.areaCandidates(c, { poly: part, contained: true })), []);
  assert.deepStrictEqual(ids(_.areaCandidates(c, { poly: part.slice().reverse(), contained: false })), ["r2"]);
  // a triangle whose bounding box holds the symbol's centre but whose area does not reach the body
  const tri = [[40, 30], [70, 30], [70, 36]];
  assert.deepStrictEqual(ids(_.areaCandidates(c, { poly: tri, contained: false })), []);
});

test("Select Connection is staged, keeps a starting symbol, and expands graphic lines by touching ends", () => {
  const { d, c } = fresh();
  const run = (sel) => { sch.select(null); c.selected = null; c.selection = new Set(sel); assert.ok(sch.runAction("selectConnection", c)); return c.lastSelection.slice().sort(); };
  assert.deepStrictEqual([..._.expandConnectionWithGraph(d, [d.items.get("w2")], [], "junction")].sort(), ["w2"], "stops at the junction");
  assert.deepStrictEqual(run(["w2"]), ["j1", "nc1", "w1", "w2", "w3"], "nothing new to the junction, so on to the pins");
  // a symbol as the start: its pins start the walk and the symbol is pulled in already at the junction stage
  assert.deepStrictEqual(run(["u1"]), ["u1", "w1"]);
  assert.deepStrictEqual(run(["u1", "w1"]), ["j1", "nc1", "u1", "w1", "w2", "w3"]);
  assert.deepStrictEqual(run(["j1", "nc1", "u1", "w1", "w2", "w3"]), ["j1", "l1", "nc1", "u1", "w1", "w2", "w3"], "then the whole net");
  // graphic lines: g1 touches g2 at (150, 40); g3 is apart
  assert.deepStrictEqual(run(["g1"]), ["g1", "g2"]);
  assert.deepStrictEqual([..._.expandConnectionGraphically(d, [d.items.get("g3")])], []);
});

test("Select Node takes connectedTypes: wires, junctions, labels, a pin's symbol; not graphics", () => {
  const { c } = fresh();
  const at = (p) => { c.cursor = p; const ok = sch.runAction("selectNode", c); return ok ? c.lastSelection : null; };
  assert.deepStrictEqual(at([38, 48.26]), ["w1"]); assert.deepStrictEqual(at([30.48, 48.26]), ["j1"]);
  assert.deepStrictEqual(at([36.5, 47.2]), ["l1"]); assert.deepStrictEqual(at([43.18, 48.26]), ["u1"]);
  assert.strictEqual(at([145, 40]), null, "a graphic line"); assert.strictEqual(at([200, 200]), null);
});

test("magnetic snap: range min( 25 px, grid ), in at range - 5 px, held to range + 5 px; anchors of every connectable kind", () => {
  const { c } = fresh(20);   // 20 px / mm: 25 px = 1.25 mm, 5 px = 0.25 mm
  const r = _.snapRanges(c); assert.deepStrictEqual([r.range, r.in, r.out].map((v) => +v.toFixed(4)), [1.25, 1, 1.5]);
  const lowZoom = _.snapRanges(makeCtx(c.doc, 4)); assert.ok(Math.abs(lowZoom.range - 1.27) < 1e-9, "clamped to the visible grid");
  // a label's connection point is an anchor for the wire tool (it is not a wire end or a pin)
  const lab = K.createItem(c.doc, K.parse('(label "X" (at 60.3 70.2 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "lx"))'));
  assert.ok(lab);
  assert.deepStrictEqual(_.snapConn(c, [60.9, 70.5], "wire"), [60.3, 70.2], "0.67 mm away: snapped");
  assert.deepStrictEqual(_.snapConn(c, [61.6, 70.5], "wire"), [60.3, 70.2], "1.33 mm away, still held (within range + 5 px)");
  assert.deepStrictEqual(_.snapConn(c, [62, 70.5], "wire"), [62.23, 71.12], "past the snap-out range: back on the grid");
  assert.deepStrictEqual(_.snapConn(c, [61.6, 70.5], "wire"), [62.23, 71.12], "coming back to 1.33 mm does not snap in");
  assert.deepStrictEqual(_.snapConn(c, [61.2, 70.5], "wire"), [60.3, 70.2], "0.95 mm: inside the snap-in range again");
  // the grid-aligned point on a horizontal wire
  assert.ok(_.snapAnchors(c, [38.3, 48.5], "wire", 1.5).some((p) => Math.abs(p[0] - 38.1) < 1e-6 && Math.abs(p[1] - 48.26) < 1e-6));
  // the graphic-line tool takes the non-connectable items only
  const g = _.snapAnchors(c, [149.8, 40.2], "polyline", 1.5); assert.ok(g.some((p) => p[0] === 150 && p[1] === 40));
  assert.deepStrictEqual(_.snapAnchors(c, [43.3, 48.3], "polyline", 1.5), [], "no pins or wire ends for graphics");
  assert.ok(_.snapAnchors(c, [43.3, 48.3], "bus", 1.5).length > 0, "a bus snaps to pins and wire ends like a wire");
});

test("STRING_INCREMENTER: the primary (rightmost) and secondary parts, zero padding, letters, never below zero", () => {
  const inc = _.incrementStringPart;
  assert.strictEqual(inc("D7", 1, 0), "D8"); assert.strictEqual(inc("A07", 1, 0), "A08"); assert.strictEqual(inc("D0", -1, 0), null);
  assert.strictEqual(inc("A1_3", 1, 1), "A2_3", "the secondary part is the next incrementable run to the left");
  assert.strictEqual(inc("A1_3", 1, 2), "B1_3");
  assert.strictEqual(inc("NET12_3", -1, 1), "NET11_3"); assert.strictEqual(inc("DATA_B", 1, 0), "DATA_C");
  assert.strictEqual(inc("Z", 1, 0), "AA"); assert.strictEqual(inc("x9", 1, 0), "x10"); assert.strictEqual(inc("7", 1, 1), null, "no such part");
  const { d, c } = fresh();
  K.createItem(d, K.parse('(label "D1_7" (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "la"))'));
  c.selection = new Set(["la"]);
  assert.ok(_.incrementSelection(c, 1, 0)); assert.strictEqual(K.str(d.items.get("la").node[1]), "D1_8");
  assert.ok(_.incrementSelection(c, -1, 1)); assert.strictEqual(K.str(d.items.get("la").node[1]), "D0_8");
  assert.strictEqual(_.incrementSelection(c, -1, 1), false, "cannot go below zero");
  c.selection = new Set(["la", "t1"]); assert.strictEqual(_.incrementSelection(c, 1, 0), false, "mixed types are left alone");
});

test("cross-probe zoom (ZoomFitCrossProbeBBox): small parts are not blown up, a ratio within 0.5 .. 1 keeps the zoom", () => {
  const z = _.crossProbeZoomRatio;
  assert.strictEqual(z(0, 5, 200, 100), null);
  // a 10 x 10 mm symbol in a 200 x 100 mm view: box 14 x 14, ratio 0.14, height 11.02 text heights -> bent 3.8 -> 0.53
  assert.strictEqual(z(10, 10, 200, 100), null);
  // a 2.54 mm part: ratio 0.0356 * 12 (2.8 text heights) = 0.41 -> zoom in to that
  const r = z(2.54, 2.54, 200, 100); assert.ok(r !== null && Math.abs(r - (3.556 / 100) * (12 + (8 - 12) * (2.8 - 2.5) / 2.5)) < 1e-9, String(r));
  // too wide for the screen: the plain fit ratio
  const wide = z(300, 10, 200, 100); assert.ok(Math.abs(wide - 420 / 200) < 1e-9, String(wide));
});

console.log(`sch-selection: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
