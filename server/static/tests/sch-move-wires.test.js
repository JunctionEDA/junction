// sch-move-wires.test.js — SCH_MOVE_TOOL, SCH_ALIGN_TOOL, JUNCTION_HELPERS and SCH_LINE_WIRE_BUS_TOOL behaviour ported
// from the KiCad source: orthoLineDrag's bends, slides and re-merges, the labels kept on a stretched wire, what a drag
// takes along, the cleanup after a move (TrimOverLappingWires, AddJunctionsIfNeeded, SCHEMATIC::CleanUp over the whole
// sheet), the hotkeys and modifiers of a move in progress, align to grid / edges, the bus unfold start, terminal points.
// Run: node server/static/tests/sch-move-wires.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const IU = 1e4;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const LIB = `(lib_symbols
    (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
const HEAD = '(kicad_sch (version 20250114) (generator "t") (uuid "root") (paper "A4") ' + LIB + " ";
// R1 at (25.4, 100.33): pin 1 at (25.4, 96.52), pin 2 at (25.4, 104.14)
const R = (id, x, y) => `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${id}")
    (property "Reference" "${id}" (at ${x + 2} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "10k" (at ${x + 2} ${y + 2} 0) (effects (font (size 1.27 1.27))))
    (pin "1" (uuid "${id}p1")) (pin "2" (uuid "${id}p2")) (instances (project "t" (path "/root" (reference "${id}") (unit 1)))))`;
const W = (id, a, b, width) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width ${width || 0}) (type default)) (uuid "${id}"))`;
const BUS = (id, a, b) => `(bus (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id}"))`;
const J = (id, p) => `(junction (at ${p[0]} ${p[1]}) (diameter 0) (color 0 0 0 0) (uuid "${id}"))`;
const RECT = (id, a, b) => `(rectangle (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0) (type default)) (fill (type none)) (uuid "${id}"))`;
const LBL = (id, p, text) => `(label "${text || "N"}" (at ${p[0]} ${p[1]} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${id}"))`;
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), cursor: null,
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label) {
      const ids = new Set(); for (const c of changes) { assert.ok(!ids.has(c.id), "one change per item: " + c.id); ids.add(c.id); }
      ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU), "applies: " + c.kind + " " + c.id);
    },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
function open(body, mode, lineMode) {
  const doc = K.parseDoc(HEAD + body + ")"), c = makeCtx(doc);
  sch.onDocChanged(c); sch.state.sel = null; sch.state.selEnds = null; sch.setDragMode(c, mode || "drag"); sch.setLineMode(c, lineMode || "90");
  return { doc, c };
}
const pts = (it) => K.kid(it.node, "pts").slice(1).map((p) => [+p[1], +p[2]]);
const at = (it) => K.kid(it.node, "at").slice(1, 3).map(Number);
const wires = (doc, kind) => [...doc.items.values()].filter((it) => it.kind === (kind || "wire")).map((it) => JSON.stringify(pts(it))).sort();
const want = (list) => list.map((l) => JSON.stringify(l)).sort();
const junctions = (doc) => [...doc.items.values()].filter((it) => it.kind === "junction").map((it) => at(it).join(",")).sort();
const last = (c) => c.log[c.log.length - 1];
/** drag `id` from `from` through every point of `path` (one mouse event each), then drop it */
function drag(doc, c, id, from, path) { assert.ok(_.beginDrag(c, doc.items.get(id), from, true), "drag started"); for (const p of path) _.moveDrag(c, p); _.endDrag(c, true); return last(c); }

// ---------------------------------------------------------------- 1, 2: orthoLineDrag
test("orthoLineDrag: several wires bent in one event get their elbows one grid further apart each (xBendCount)", () => {
  const { doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + W("wb", [12.7, 104.14], [25.4, 104.14]));
  const cm = drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41]]);
  assert.strictEqual(cm.label, "Drag");
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[24.13, 101.6], [25.4, 101.6]], "the original wire is the grid-long piece at the pin");
  assert.deepStrictEqual(pts(doc.items.get("wb")), [[22.86, 109.22], [25.4, 109.22]], "the second bend is one grid further out");
  assert.deepStrictEqual(wires(doc), want([[[24.13, 101.6], [25.4, 101.6]], [[22.86, 109.22], [25.4, 109.22]],
    [[24.13, 96.52], [12.7, 96.52]], [[24.13, 101.6], [24.13, 96.52]], [[22.86, 104.14], [12.7, 104.14]], [[22.86, 109.22], [22.86, 104.14]]]));
  assert.deepStrictEqual(junctions(doc), [], "corners need no junction");
});

test("orthoLineDrag: a bend whose cross piece goes back to nothing is merged away; the move is path dependent", () => {
  let { doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]));
  // down (the bend is made), back up (it is merged away again), then along the wire: it just stretches
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41], [25.4, 100.33], [27.94, 100.33]]);
  assert.deepStrictEqual(wires(doc), want([[[12.7, 96.52], [27.94, 96.52]]]));
  // down, then right: the grid-long piece at the pin runs the way of the second move and stretches
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52])));
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41], [30.48, 105.41]]);
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[24.13, 101.6], [30.48, 101.6]]);
  assert.deepStrictEqual(wires(doc), want([[[24.13, 101.6], [30.48, 101.6]], [[24.13, 96.52], [12.7, 96.52]], [[24.13, 101.6], [24.13, 96.52]]]));
  // right, then down: the wire stretched first, so the bend is one grid before the pin's new x
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52])));
  drag(doc, c, "R1", [25.4, 100.33], [[30.48, 100.33], [30.48, 105.41]]);
  assert.deepStrictEqual(wires(doc), want([[[29.21, 101.6], [30.48, 101.6]], [[29.21, 96.52], [12.7, 96.52]], [[29.21, 101.6], [29.21, 96.52]]]));
  // the live preview shows the same lines while the drag is in flight, and Esc puts everything back
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52])));
  assert.ok(_.beginDrag(c, doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(c, [25.4, 105.41]);
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[24.13, 101.6], [25.4, 101.6]]);
  assert.deepStrictEqual(want(sch.state.drag.preview.map((p) => p.pts)), want([[[24.13, 96.52], [12.7, 96.52]], [[24.13, 101.6], [24.13, 96.52]]]));
  _.endDrag(c, false);
  assert.deepStrictEqual(wires(doc), want([[[12.7, 96.52], [25.4, 96.52]]])); assert.strictEqual(c.log.length, 0);
});

test("orthoLineDrag: the corner of an L slides (the connected line running the way of the move stretches), a moved-back offset splits at zero", () => {
  const body = R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + W("wv", [12.7, 83.82], [12.7, 96.52]);
  let { doc, c } = open(body);
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41]]);
  assert.deepStrictEqual(wires(doc), want([[[12.7, 101.6], [25.4, 101.6]], [[12.7, 83.82], [12.7, 101.6]]]), "no new lines: the vertical wire lengthened");
  // through zero in one event: +5.08 then -2.54 of total offset is a move back to zero and the rest
  ({ doc, c } = open(body));
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41], [25.4, 97.79]]);
  assert.deepStrictEqual(wires(doc), want([[[12.7, 93.98], [25.4, 93.98]], [[12.7, 83.82], [12.7, 93.98]]]));
  // free line mode: the end just follows
  ({ doc, c } = open(body, "drag", "free"));
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41]]);
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[12.7, 96.52], [25.4, 101.6]]);
  sch.setLineMode(c, "90");
});

// ---------------------------------------------------------------- 7: labels on a stretched wire
test("a label on a wire the drag stretches stays on the wire (m_specialCaseLabels)", () => {
  // the L slides: both ends of the wire move alike, the label goes with it
  let { doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + W("wv", [12.7, 83.82], [12.7, 96.52]) + LBL("l1", [17.78, 96.52]));
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41]]);
  assert.deepStrictEqual(at(doc.items.get("l1")), [17.78, 101.6]);
  // a bend: the label is re-attached to the line left behind and keeps its place
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + LBL("l1", [17.78, 96.52])));
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41]]);
  assert.deepStrictEqual(at(doc.items.get("l1")), [17.78, 96.52]);
  // free mode, the wire shortened past the label: it goes to the nearest point, the moving end, and rides it
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + LBL("l1", [22.86, 96.52]), "drag", "free"));
  drag(doc, c, "R1", [25.4, 100.33], [[20.32, 100.33], [17.78, 100.33]]);
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[12.7, 96.52], [17.78, 96.52]]);
  assert.deepStrictEqual(at(doc.items.get("l1")), [17.78, 96.52], "tracks the moving end");
  // ... and when the wire is long enough again it is back where it was
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + LBL("l1", [22.86, 96.52]), "drag", "free"));
  drag(doc, c, "R1", [25.4, 100.33], [[20.32, 100.33], [30.48, 100.33]]);
  assert.deepStrictEqual(at(doc.items.get("l1")), [22.86, 96.52]);
  // MOVE leaves the label and the wire alone
  ({ doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]) + LBL("l1", [17.78, 96.52]), "move"));
  drag(doc, c, "R1", [25.4, 100.33], [[25.4, 105.41]]);
  assert.strictEqual(last(c).label, "Move");
  assert.deepStrictEqual([pts(doc.items.get("wa")), at(doc.items.get("l1"))], [[[12.7, 96.52], [25.4, 96.52]], [17.78, 96.52]]);
  sch.setLineMode(c, "90"); sch.setDragMode(c, "drag");
});

// ---------------------------------------------------------------- 8, 9: what a drag takes along
const SHEET = (id, x, y, w, h, pin) => `(sheet (at ${x} ${y}) (size ${w} ${h}) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid "${id}")
    (property "Sheetname" "S" (at ${x} ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom))) (property "Sheetfile" "s.kicad_sch" (at ${x} ${y + h + 0.6} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (pin "D[0..3]" input (at ${pin[0]} ${pin[1]} 180) (uuid "${id}pin") (effects (font (size 1.27 1.27)) (justify left)))
    (instances (project "t" (path "/root" (page "2")))))`;
test("dragging a sheet takes the bus on its pin along (SCH_LINE::CanConnect: sheets and sheet pins connect wires and buses)", () => {
  const { doc, c } = open(SHEET("sh", 50.8, 50.8, 25.4, 12.7, [50.8, 55.88]) + BUS("b1", [38.1, 55.88], [50.8, 55.88]));
  drag(doc, c, "sh", [50.8, 50.8], [[55.88, 50.8]]);
  assert.deepStrictEqual(pts(doc.items.get("b1")), [[38.1, 55.88], [55.88, 55.88]]);
});

test("dragging a bus entry off the middle of a wire splits the wire, adds the junction and a new wire to the entry", () => {
  const { doc, c } = open('(bus_entry (at 50.8 50.8) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "be"))' + W("w1", [45.72, 53.34], [60.96, 53.34]));
  drag(doc, c, "be", [50.8, 50.8], [[50.8, 45.72]]);
  assert.deepStrictEqual(wires(doc), want([[[45.72, 53.34], [53.34, 53.34]], [[53.34, 53.34], [60.96, 53.34]], [[53.34, 53.34], [53.34, 48.26]]]));
  assert.deepStrictEqual(junctions(doc), ["53.34,53.34"]);
});

// ---------------------------------------------------------------- 5, 6, 12, 18: the cleanup after a move
test("after a move: overlapping collinear wires merge (same stroke only), no junction on a collinear overlap", () => {
  let { doc, c } = open(W("w1", [0, 0], [10.16, 0]) + W("w2", [20.32, 0], [30.48, 0]), "move");
  drag(doc, c, "w2", [20.32, 0], [[5.08, 0]]);
  assert.deepStrictEqual(wires(doc), want([[[0, 0], [15.24, 0]]]), "SCHEMATIC::CleanUp merges the overlap");
  assert.deepStrictEqual(junctions(doc), [], "AnalyzePoint merges collinear lines first: no junction");
  ({ doc, c } = open(W("w1", [0, 0], [10.16, 0]) + W("w2", [20.32, 0], [30.48, 0], 0.5), "move"));
  drag(doc, c, "w2", [20.32, 0], [[10.16, 0]]);
  assert.strictEqual(wires(doc).length, 2, "SCH_LINE::MergeOverlap refuses lines with different strokes");
  sch.setDragMode(c, "drag");
});

test("after a move: a wire through both pins of the moved symbol is trimmed between them (TrimOverLappingWires)", () => {
  const { doc, c } = open(R("R1", 25.4, 100.33) + W("w1", [50.8, 88.9], [50.8, 111.76]), "move");
  drag(doc, c, "R1", [25.4, 100.33], [[50.8, 100.33]]);
  assert.deepStrictEqual(wires(doc), want([[[50.8, 88.9], [50.8, 96.52]], [[50.8, 104.14], [50.8, 111.76]]]));
  sch.setDragMode(c, "drag");
});

test("after a move or a drawn wire SCHEMATIC::CleanUp runs over the whole sheet: stale junctions, duplicates and mergeable lines anywhere go", () => {
  // far from the move: a junction on a plain wire, two junctions on one T, two wires meeting end to end
  const far = W("f1", [100, 100], [110, 100]) + J("jStale", [105, 100]) + W("f2", [200, 100], [210, 100]) + W("f3", [210, 100], [220, 100])
    + W("t1", [150, 150], [170, 150]) + W("t2", [160, 150], [160, 160]) + J("jT1", [160, 150]) + J("jT2", [160, 150]);
  let { doc, c } = open(R("R1", 25.4, 100.33) + far, "move");
  drag(doc, c, "R1", [25.4, 100.33], [[30.48, 100.33]]);
  assert.ok(!doc.items.get("jStale"), "a junction no longer allowed is removed");
  assert.strictEqual([...doc.items.values()].filter((it) => it.kind === "junction").length, 1, "one of the two junctions on the T is left");
  assert.ok(wires(doc).includes(JSON.stringify([[200, 100], [220, 100]])), "the touching wires are one");
  sch.setDragMode(c, "drag");
  ({ doc, c } = open(far));
  sch.onActivate("wire", c); _.startWire(c, "wire", [0, 0]); _.wireClick(c, [10.16, 0], false); _.wireFollow(c, [10.16, 10.16]); _.finishWire(c);
  assert.strictEqual(last(c).label, "Draw Wires");
  assert.ok(!doc.items.get("jStale")); assert.ok(wires(doc).includes(JSON.stringify([[200, 100], [220, 100]])));
  sch.onActivate("select", c);
});

// ---------------------------------------------------------------- 4: dropping a move into a sheet
test("MOVE: items dropped on a sheet symbol leave this sheet and are added to its sub-sheet, stepped clear of what is there", () => {
  const body = R("R1", 25.4, 100.33) + SHEET("sh", 50.8, 50.8, 25.4, 25.4, [50.8, 55.88]) + RECT("g", [10, 10], [12, 12]);
  const sub = K.parseDoc(HEAD + W("sw", [0, 0], [2.54, 0]) + ")");
  const mk = (mode) => { const o = open(body, mode); o.dropped = []; o.c.dropIntoSheet = (sheet, label, build) => { o.dropped.push({ sheet: sheet.id, label, changes: build(sub) }); }; return o; };
  let o = mk("move");
  assert.ok(_.beginDrag(o.c, o.doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(o.c, [63.5, 63.5], {});
  assert.strictEqual(sch.state.drag.hoverSheet && sch.state.drag.hoverSheet.id, "sh", "findTargetSheet: the sheet under the cursor");
  _.endDrag(o.c, true);
  assert.ok(!o.doc.items.get("R1"), "removed from this sheet"); assert.strictEqual(last(o.c).label, "Move");
  assert.deepStrictEqual(last(o.c).changes.map((x) => [x.id, x.kind]), [["R1", "REMOVED"]]);
  assert.strictEqual(o.dropped.length, 1); assert.strictEqual(o.dropped[0].sheet, "sh");
  const add = o.dropped[0].changes; assert.deepStrictEqual(add.map((x) => [x.id, x.kind, x.typeName]), [["R1", "ADDED", "SCH_SYMBOL"]]);
  assert.ok(/lib_symbols/.test(add[0].sexpr) || /Device:R/.test(add[0].sexpr), "the symbol goes with its library symbol");
  assert.ok(K.applyChange(sub, add[0], IU)); const moved = sub.items.get("R1"), b = moved.bbox;
  for (const it of sub.items.values()) if (it !== moved && it.bbox) assert.ok(!(b[0] <= it.bbox[2] && b[2] >= it.bbox[0] && b[1] <= it.bbox[3] && b[3] >= it.bbox[1]), "no overlap in the sub-sheet");
  // a drag (G) never drops; Esc never drops
  o = mk("drag"); assert.ok(_.beginDrag(o.c, o.doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(o.c, [63.5, 63.5], {});
  assert.strictEqual(sch.state.drag.hoverSheet, null); _.endDrag(o.c, true); assert.ok(o.doc.items.get("R1")); assert.strictEqual(o.dropped.length, 0);
  o = mk("move"); assert.ok(_.beginDrag(o.c, o.doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(o.c, [63.5, 63.5], {}); _.endDrag(o.c, false);
  assert.ok(o.doc.items.get("R1")); assert.strictEqual(o.dropped.length, 0);
  // a connection point landing on one of the sheet's pins is a connection, not a drop: pin 1 of R1 on (50.8, 55.88)
  o = mk("move"); assert.ok(_.beginDrag(o.c, o.doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(o.c, [50.8, 59.69], {});
  assert.strictEqual(sch.state.drag.hoverSheet, null); _.endDrag(o.c, false);
  // a graphics-only selection drops only with Ctrl held
  o = mk("move"); assert.ok(_.beginDrag(o.c, o.doc.items.get("g"), [10, 10], true)); _.moveDrag(o.c, [60.96, 60.96], {});
  assert.strictEqual(sch.state.drag.hoverSheet, null);
  _.moveDrag(o.c, [62.23, 62.23], { ctrlKey: true }); assert.strictEqual(sch.state.drag.hoverSheet && sch.state.drag.hoverSheet.id, "sh");
  _.endDrag(o.c, true); assert.ok(!o.doc.items.get("g")); assert.strictEqual(o.dropped.length, 1);
  sch.setDragMode(o.c, "drag");
});

// ---------------------------------------------------------------- 19: the junction a move makes redundant
test("a junction made redundant by the move is hidden while it lasts and migrates to the line's new end (same item, diameter kept)", () => {
  const body = W("w1", [50.8, 63.5], [63.5, 63.5]) + W("w2", [63.5, 63.5], [76.2, 63.5]) + W("w3", [63.5, 63.5], [63.5, 76.2])
    + '(junction (at 63.5 63.5) (diameter 1.5) (color 255 0 0 1) (uuid "j1"))';
  const { doc, c } = open(body);
  assert.ok(_.beginDrag(c, doc.items.get("w3"), [63.5, 68.58], true));
  assert.deepStrictEqual(sch.state.drag.hiddenJunctions.map((h) => [h.item.id, h.line.id, h.index]), [["j1", "w3", 0]], "recordRedundantJunctions");
  assert.strictEqual(doc.items.get("j1").geom.length, 0, "hidden: the painter has nothing to draw for it");
  _.moveDrag(c, [68.58, 68.58]); _.endDrag(c, true);
  const j = doc.items.get("j1"); assert.ok(j, "the same junction item");
  assert.deepStrictEqual(at(j), [68.58, 63.5]); assert.strictEqual(+K.kid(j.node, "diameter")[1], 1.5);
  assert.ok(j.geom.length > 0, "shown again");
  assert.deepStrictEqual(junctions(doc), ["68.58,63.5"]);
  assert.ok(last(c).changes.some((x) => x.id === "j1" && x.kind === "MODIFIED"));
  // Esc: shown again where it was
  const o = open(body);
  assert.ok(_.beginDrag(o.c, o.doc.items.get("w3"), [63.5, 68.58], true)); _.moveDrag(o.c, [68.58, 68.58]); _.endDrag(o.c, false);
  assert.ok(o.doc.items.get("j1").geom.length > 0); assert.deepStrictEqual(at(o.doc.items.get("j1")), [63.5, 63.5]);
});

// ---------------------------------------------------------------- 10, 11: keys and modifiers during a move
test("repeating the move / drag hotkey places the items; the other one restarts in the new mode", () => {
  const { doc, c } = open(R("R1", 25.4, 100.33) + W("wa", [12.7, 96.52], [25.4, 96.52]));
  sch.select("R1"); sch.state.sel = "R1"; sch.state.cursor = [25.4, 100.33];
  assert.ok(sch.onKey("m", {}, c)); assert.ok(sch.state.drag); assert.strictEqual(sch.state.dragMode, "move");
  _.moveDrag(c, [30.48, 100.33]);
  assert.ok(sch.onKey("g", {}, c)); assert.ok(sch.state.drag, "G during a move restarts it as a drag"); assert.strictEqual(sch.state.dragMode, "drag");
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[12.7, 96.52], [30.48, 96.52]], "the wire follows now");
  assert.ok(sch.onKey("G", {}, c)); assert.strictEqual(sch.state.drag, null, "G during a drag is a click: the items are placed");
  assert.strictEqual(last(c).label, "Drag"); assert.deepStrictEqual(at(doc.items.get("R1")), [30.48, 100.33]);
  sch.state.cursor = [30.48, 100.33];
  assert.ok(sch.onKey("m", {}, c)); _.moveDrag(c, [35.56, 100.33]); assert.ok(sch.onKey("m", {}, c));
  assert.strictEqual(sch.state.drag, null); assert.strictEqual(last(c).label, "Move"); assert.deepStrictEqual(at(doc.items.get("R1")), [35.56, 100.33]);
  sch.setDragMode(c, "drag");
});

test("while moving, Ctrl turns the grid off and Shift the snap to other items' anchors", () => {
  const body = R("R1", 25.4, 100.33) + W("wo", [40.1, 96.6], [50, 96.6]);          // an off-grid wire end to snap to
  let { doc, c } = open(body, "move");
  assert.ok(_.beginDrag(c, doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(c, [31.1, 101.2], { ctrlKey: true, shiftKey: true });
  assert.deepStrictEqual(at(doc.items.get("R1")), [31.1, 101.2], "Ctrl: no grid");
  _.moveDrag(c, [31.1, 101.2], { shiftKey: true }); assert.deepStrictEqual(at(doc.items.get("R1")), [30.48, 101.6], "the grid again");
  _.endDrag(c, false);
  // the drag origin (the symbol's position) lands on the other wire's off-grid end when it is within reach
  // (zoomed in so the anchor is inside the snap-in range: min( 25 px, grid ) less 5 px)
  ({ doc, c } = open(body, "move")); c.pxPerMm = 20;
  assert.ok(_.beginDrag(c, doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(c, [40.2, 96.5], {});
  assert.deepStrictEqual(at(doc.items.get("R1")), [40.1, 96.6], "snapped to the anchor");
  _.moveDrag(c, [40.2, 96.5], { shiftKey: true }); assert.deepStrictEqual(at(doc.items.get("R1")), [40.64, 96.52], "Shift: grid only");
  _.endDrag(c, false); sch.setDragMode(c, "drag");
});

// ---------------------------------------------------------------- 14, 15, 16, 25: align
test("align to edge: the target is the item under the cursor, else the first in the command's order; only connectable items are grid-corrected", () => {
  const body = RECT("a", [10, 10], [20, 20]) + RECT("b", [30.3, 30], [40.3, 40]) + RECT("cc", [50, 50], [60, 60]);
  let { doc, c } = open(body);
  const start = (id) => K.kid(doc.items.get(id).node, "start").slice(1).map(Number);
  c.selection = new Set(["a", "b", "cc"]); c.cursor = [35, 35];                       // inside b
  assert.ok(sch.runAction("alignLeft", c)); assert.strictEqual(last(c).label, "Align to Left");
  assert.deepStrictEqual([start("a")[0], start("b")[0], start("cc")[0]], [30.3, 30.3, 30.3], "b's left edge, and graphics move by the exact delta");
  ({ doc, c } = open(body));
  const start2 = (id) => K.kid(doc.items.get(id).node, "start").slice(1).map(Number);
  c.selection = new Set(["a", "b", "cc"]); c.cursor = [500, 500];
  assert.ok(sch.runAction("alignRight", c)); assert.strictEqual(last(c).label, "Align to Right");
  assert.deepStrictEqual([start2("a")[0], start2("b")[0], start2("cc")[0]], [50, 50, 50], "no item under the cursor: the first by GetRight descending");
  ({ doc, c } = open(body));
  const start3 = (id) => K.kid(doc.items.get(id).node, "start").slice(1).map(Number);
  c.selection = new Set(["a", "b", "cc"]); c.cursor = [500, 500];
  assert.ok(sch.runAction("alignCenterX", c)); assert.strictEqual(last(c).label, "Align to Middle");
  assert.ok(sch.runAction("alignCenterY", c)); assert.strictEqual(last(c).label, "Align to Center");
  assert.deepStrictEqual([start3("a"), start3("b"), start3("cc")], [[10, 10], [10, 10], [10, 10]], "centres: the first item's centre, not the average");
  // a connectable item ends on the grid: snap( position + delta ) - position
  ({ doc, c } = open(R("R1", 25.5, 100.2) + RECT("a", [40, 60], [50, 70])));
  c.selection = new Set(["R1", "a"]); c.cursor = [45, 65];
  assert.ok(sch.runAction("alignTop", c));
  assert.deepStrictEqual(at(doc.items.get("R1")), [25.4, 63.5], "the symbol's position is snapped in both axes");
  c.selection = new Set(["a"]); c.toasts.length = 0;
  assert.strictEqual(sch.runAction("alignTop", c), false); assert.deepStrictEqual(c.toasts, [], "fewer than two items: silently nothing");
});

test("align items to grid: attached wires follow, the shift is the most common pin delta, items without connection points stay", () => {
  // R1 0.1 mm off: its pins at (25.5, 96.42) and (25.5, 104.04); a wire on pin 1, a rectangle and a text off the grid
  const { doc, c } = open(R("R1", 25.5, 100.23) + W("wa", [12.7, 96.42], [25.5, 96.42]) + RECT("a", [40.1, 60.1], [50.1, 70.1])
    + '(text "T" (exclude_from_sim no) (at 70.1 70.1 0) (effects (font (size 1.27 1.27))) (uuid "tx"))');
  c.selection = new Set(["R1", "a", "tx"]);
  assert.ok(sch.runAction("alignToGrid", c)); assert.strictEqual(last(c).label, "Align Items to Grid");
  assert.deepStrictEqual(at(doc.items.get("R1")), [25.4, 100.33]);
  assert.deepStrictEqual(pts(doc.items.get("wa")), [[12.7, 96.42], [25.4, 96.52]], "the wire end on the pin moved with it (a drag with the line mode free)");
  assert.deepStrictEqual(K.kid(doc.items.get("a").node, "start").slice(1).map(Number), [40.1, 60.1], "a rectangle has no connection points");
  assert.deepStrictEqual(at(doc.items.get("tx")), [69.85, 69.85], "a text aligns by its position");
  c.toasts.length = 0; const n = c.log.length;
  assert.strictEqual(sch.runAction("alignToGrid", c), true); assert.strictEqual(c.log.length, n); assert.deepStrictEqual(c.toasts, []);
});

// ---------------------------------------------------------------- 20, 22: AnalyzePoint, terminal points
test("AnalyzePoint: a bus entry's bounding box forbids a junction on its free corners; IsTerminalPoint hit-tests the entry's segment", () => {
  const entry = '(bus_entry (at 50.8 50.8) (size 2.54 2.54) (stroke (width 0) (type default)) (uuid "be"))';
  // three wire ends meet on the entry's free corner (53.34, 50.8)
  const tee = W("w1", [53.34, 50.8], [60.96, 50.8]) + W("w2", [53.34, 50.8], [53.34, 40.64]) + W("w3", [53.34, 50.8], [53.34, 45.72], 0.3);
  const d1 = K.parseDoc(HEAD + W("w1", [53.34, 50.8], [60.96, 50.8]) + W("w2", [53.34, 50.8], [53.34, 40.64]) + W("w3", [53.34, 50.8], [45.72, 50.8]) + ")");
  assert.strictEqual(_.analyzePoint(d1, [53.34, 50.8], false).allows, true, "without the entry it is a junction");
  const d2 = K.parseDoc(HEAD + entry + W("w1", [53.34, 50.8], [60.96, 50.8]) + W("w2", [53.34, 50.8], [53.34, 40.64]) + W("w3", [53.34, 50.8], [45.72, 50.8]) + ")");
  const info = _.analyzePoint(d2, [53.34, 50.8], false);
  assert.strictEqual(info.hasBusEntry, true); assert.strictEqual(info.allows, false, "AllowsExplicitJunction() refuses a dot inside the entry's box");
  assert.ok(tee);
  // the middle of a 100 mil entry is a 50 mil grid point: a wire click there ends the wire
  const d3 = K.parseDoc(HEAD + entry + '(polyline (pts (xy 0 0) (xy 5.08 0) (xy 5.08 5.08)) (stroke (width 0) (type default)) (uuid "pl"))'
    + '(polyline (pts (xy 20.32 0) (xy 30.48 0)) (stroke (width 0) (type default)) (uuid "ln"))' + ")");
  assert.strictEqual(_.isTerminalPoint(d3, [52.07, 52.07], "wire"), true);
  assert.strictEqual(_.isTerminalPoint(d3, [53.34, 50.8], "wire"), false, "the box corner is not on the entry");
  assert.strictEqual(_.isTerminalPoint(d3, [2.54, 0], "polyline"), false, "a multi-point polyline is a shape, not a SCH_LINE");
  assert.strictEqual(_.isTerminalPoint(d3, [25.4, 0], "polyline"), true, "a two-point graphic line is");
});

// ---------------------------------------------------------------- 24: junction preview
test("the junction preview of a move counts the moved pins: a pin over the middle of a wire shows its dot", () => {
  const { doc, c } = open(R("R1", 25.4, 100.33) + W("w1", [50.8, 90], [50.8, 96.52]) + W("w2", [40.64, 104.14], [60.96, 104.14]), "move");
  assert.ok(_.beginDrag(c, doc.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(c, [50.8, 100.33]);
  const dots = _.dragJunctions(doc, sch.state.drag).map((p) => p.join(","));
  assert.deepStrictEqual(dots, ["50.8,104.14"], "pin 2 sits on the middle of w2; pin 1 on a wire end needs none");
  _.endDrag(c, false); sch.setDragMode(c, "drag");
});

console.log(`sch-move-wires: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
