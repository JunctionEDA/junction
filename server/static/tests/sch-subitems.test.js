// sch-subitems.test.js — schematic sub-items as KiCad's SCH_SELECTION_TOOL holds them (sheet pins, sheet and label
// fields, pins, table cells) and the behaviour that hangs on them: sheet pins sliding on their sheet's edge, Find on
// pins and hidden fields, net-name search on the resolved net, Align to Grid on sheet pins, move into a sheet,
// repeat / paste into the entered group, table cells and Override individual item colors, stacked pin remaps,
// Swap Unit Labels / Swap Pins, and the symbol editor's pin layout boxes.
// Run: node server/static/tests/sch-subitems.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const { webPath } = require("./web-path");
const esbuild = require("esbuild");
function load(...file) {
  const out = esbuild.buildSync({ entryPoints: [webPath("domains", "pcb", ...file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const L = load("dialogs", "logic.ts");

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }   // run in order at the end: some wait for the browser's image flip
const tick = () => new Promise((r) => setTimeout(r, 0));
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const FONT = '(effects (font (size 1.27 1.27)))';
const IU = 1e4;
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), cursor: null,
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label, opts) { ctx.log.push({ changes, label, opts }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU), "applies: " + c.kind + " " + c.id); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
function open(body, mode) {
  const doc = K.parseDoc(HEAD + body + ")"), c = makeCtx(doc);
  sch.onDocChanged(c); sch.state.sel = null; sch.state.selEnds = null; sch.setDragMode(c, mode || "drag"); sch.setLineMode(c, "90");
  return { doc, c };
}
const last = (c) => c.log[c.log.length - 1];
const SHEET = (id, x, y, w, h, file, pins) => `(sheet (at ${x} ${y}) (size ${w} ${h}) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid "${id}")
    (property "Sheetname" "${id}" (at ${x} ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom))) (property "Sheetfile" "${file}" (at ${x} ${y + h + 0.6} 0) (effects (font (size 1.27 1.27)) (justify left top)))
    ${(pins || []).map((p) => `(pin "${p.name}" ${p.shape || "input"} (at ${p.at[0]} ${p.at[1]} ${p.rot || 0}) (uuid "${id}-${p.name}") (effects (font (size 1.27 1.27)) (justify ${p.just || "right"})))`).join(" ")}
    (instances (project "t" (path "/root" (page "2")))))`;

test("sch-render#24: table cells follow Override individual item colors (text and fill), borders keep their stroke", () => {
  const cell = (u, x) => `(table_cell "A" (exclude_from_sim no) (at ${x} 0 0) (size 10 5) (margins 0.9 0.9 0.9 0.9) (span 1 1) (fill (type color) (color 0 0 255 1)) (effects (font (size 1.27 1.27) (color 255 0 0 1))) (uuid "${u}"))`;
  const src = HEAD + `(table (column_count 2) (border (external yes) (header yes) (stroke (width 0) (type solid) (color 0 255 0 1))) (separators (rows yes) (cols yes) (stroke (width 0) (type solid) (color 0 255 0 1))) (column_widths 10 10) (row_heights 5) (cells ${cell("c1", 0)} ${cell("c2", 10)}) (uuid "t1")))`;
  const doc = K.parseDoc(src), t = () => doc.items.get("t1");
  assert(t().geom.some((g) => g.t === "text" && /255, ?0, ?0|#ff0000/i.test(String(g.color))), "own text colour");
  assert(t().geom.some((g) => g.noStroke), "own fill");
  assert(K.setSchFormatting({ overrideItemColors: true }, doc));
  try {
    assert(t().geom.filter((g) => g.t === "text").every((g) => g.color === K.SCH.notes), "LAYER_NOTES text");
    assert(!t().geom.some((g) => g.noStroke), "LAYER_NOTES_BACKGROUND is transparent: no cell fill");
    assert(t().geom.some((g) => g.t === "line" && !/^#0000c2$/i.test(g.color)), "borders keep their stroke colour");
  } finally { K.setSchFormatting({ overrideItemColors: false }, doc); }
});

test("sch-edit-clipboard#24: added groupable items join the entered group (SCH_COMMIT CHT_ADD), sheet pins and grouped items do not", () => {
  const doc = K.parseDoc(HEAD + `(junction (at 1 1) (diameter 0) (color 0 0 0 0) (uuid "j1")) ${L.groupSexpr("g", "g1", ["j1"])})`);
  const ch = [{ id: "n1", kind: "ADDED", typeName: "SCH_SYMBOL", sexpr: "" }, { id: "n2", kind: "ADDED", typeName: "SCH_SHEET_PIN", sexpr: "" }, { id: "n3", kind: "ADDED", typeName: "SCH_LINE", sexpr: "" }];
  const out = L.enteredGroupChanges(doc, ch, "g1");
  const g = out.find((c) => c.id === "g1"); assert(g, "the entered group is modified");
  assert.deepStrictEqual(g.groupMembers, ["j1", "n1", "n3"]);
  assert.strictEqual(L.enteredGroupChanges(doc, ch, null), ch, "no entered group: unchanged");
  // a new group made inside the entered one claims its members: only the group itself joins
  const nested = [{ id: "g2", kind: "ADDED", typeName: "SCH_GROUP", sexpr: L.groupSexpr("", "g2", ["n1"]), groupMembers: ["n1"] }, { id: "n1", kind: "ADDED", typeName: "SCH_SYMBOL", sexpr: "" }];
  assert.deepStrictEqual(L.enteredGroupChanges(doc, nested, "g1").find((c) => c.id === "g1").groupMembers, ["g2", "j1"]);
});

test("sch-move-wires#4: a sheet dropped into a sheet whose file it (or a sub-sheet of it) shows is refused (TestForRecursion)", () => {
  // sheet A shows a.kicad_sch, which itself holds a sheet of b.kicad_sch; B shows b.kicad_sch
  const body = SHEET("A", 10.16, 10.16, 12.7, 12.7, "a.kicad_sch") + SHEET("B", 50.8, 50.8, 25.4, 25.4, "b.kicad_sch") + SHEET("C", 101.6, 50.8, 25.4, 25.4, "c.kicad_sch");
  const subA = K.parseDoc(HEAD + SHEET("AB", 10.16, 10.16, 12.7, 12.7, "b.kicad_sch") + ")");
  const o = open(body, "move"); o.c.docPath = "root.kicad_sch"; o.c.sheetDocs = new Map([["a.kicad_sch", subA]]); o.c.dropIntoSheet = () => {};
  assert.ok(_.beginDrag(o.c, o.doc.items.get("A"), [10.16, 10.16], true)); _.moveDrag(o.c, [63.5, 63.5], {});
  assert.strictEqual(sch.state.drag.hoverSheet, null, "b.kicad_sch is a sub-sheet of the moved sheet: dropping would recurse");
  _.moveDrag(o.c, [114.3, 63.5], {});
  assert.strictEqual(sch.state.drag.hoverSheet && sch.state.drag.hoverSheet.id, "C", "c.kicad_sch is not in the moved hierarchy");
  _.endDrag(o.c, false); sch.setDragMode(o.c, "drag");
});

test("sch-edit-clipboard#19: an image mirrored while it moves gets its picture flipped too; once dropped, the flip amends the move", async () => {
  const img = `(image (at 50.8 50.8) (uuid "i1") (data "QUJD"))`;
  const calls = []; let hold = null;
  _.setImageFlipImpl((b64, leftRight) => { calls.push([b64, leftRight]); return new Promise((r) => { const done = () => r(b64.split("").reverse().join("")); if (hold) hold.push(done); else done(); }); });
  try {
    let o = open(img, "move");
    assert.ok(_.beginDrag(o.c, o.doc.items.get("i1"), [50.8, 50.8], true)); _.moveDrag(o.c, [60.96, 50.8], {});
    assert.ok(_.orientSelected(o.c, "y")); await tick(); await tick();
    assert.deepStrictEqual(calls, [["QUJD", true]]);
    assert.strictEqual(K.kid(o.doc.items.get("i1").node, "data").slice(1).join(""), "DJUQ", "the moving picture is flipped");
    _.endDrag(o.c, true);
    assert.strictEqual(K.kid(o.doc.items.get("i1").node, "data").slice(1).join(""), "DJUQ", "and committed so");
    // the flip answers only after the drop: it amends the move's own undo step
    o = open(img, "move"); hold = [];
    assert.ok(_.beginDrag(o.c, o.doc.items.get("i1"), [50.8, 50.8], true)); _.moveDrag(o.c, [60.96, 50.8], {});
    assert.ok(_.orientSelected(o.c, "x")); await tick(); _.endDrag(o.c, true);
    const n = o.c.log.length; for (const f of hold) f(); hold = null; await tick(); await tick();
    assert.strictEqual(K.kid(o.doc.items.get("i1").node, "data").slice(1).join(""), "DJUQ");
    assert.strictEqual(o.c.log.length, n + 1); assert.deepStrictEqual(o.c.log[n].opts, { amend: true });
    sch.setDragMode(o.c, "drag");
  } finally { _.setImageFlipImpl(null); }
});

test("sch-draw-inspect#35: the shape, sheet or table being drawn is the message panel's subject (SetMsgPanel( item ) on motion)", () => {
  const o = open("");
  for (const [tool, kind] of [["rect", "rectangle"], ["circle", "circle"], ["sheet", "sheet"], ["table", "table"], ["lines", "polyline"], ["textbox", "text_box"]]) {
    sch.onActivate(tool, o.c); sch.state.ctx = o.c;
    assert.strictEqual(sch.msgPanelSubject(), null, "nothing before the first click");
    _.drawClick(o.c, tool, [10.16, 10.16]); sch.state.draw.cur = [30.48, 25.4];
    const sub = sch.msgPanelSubject(); assert.ok(sub, tool + ": a subject"); assert.strictEqual(sub.item.kind, kind);
    assert.ok(!o.doc.items.has(sub.item.id), "not in the document");
    sch.state.draw.cur = [40.64, 25.4]; assert.notStrictEqual(sch.msgPanelSubject().key, sub.key, "refreshed as it changes");
    _.cancelDraw(o.c); sch.onActivate("select", o.c);
  }
});

const LIB2 = `(lib_symbols (symbol "L:U" (property "Reference" "U" (at 0 0 0) ${FONT}) (property "Value" "U" (at 0 0 0) ${FONT})
    (symbol "U_1_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A" ${FONT}) (number "1" ${FONT})) (pin output line (at 5.08 0 180) (length 2.54) (name "B" ${FONT}) (number "2" ${FONT})))
    (symbol "U_2_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A" ${FONT}) (number "3" ${FONT})) (pin output line (at 5.08 0 180) (length 2.54) (name "B" ${FONT}) (number "4" ${FONT})))))`;
const U = (id, unit, x, y, ref = "U1") => `(symbol (lib_id "L:U") (at ${x} ${y} 0) (unit ${unit}) (uuid "${id}") (property "Reference" "${ref}" (at ${x} ${y - 3} 0) ${FONT}) (property "Value" "U" (at ${x} ${y + 3} 0) ${FONT})
    (instances (project "t" (path "/root" (reference "${ref}") (unit ${unit})))))`;
const LBL = (id, x, y, t) => `(label "${t}" (at ${x} ${y} 0) ${FONT} (uuid "${id}"))`;
test("sch-selection#23: Swap Unit Labels rotates the single net labels of two units pin by pin (GetSameSymbolMultiUnitSelection)", () => {
  const body = LIB2 + U("a", 1, 50.8, 50.8) + U("b", 2, 50.8, 76.2) + LBL("la1", 45.72, 50.8, "A1") + LBL("la2", 55.88, 50.8, "A2") + LBL("lb1", 45.72, 76.2, "B1") + LBL("lb2", 55.88, 76.2, "B2");
  const o = open(body);
  const items = ["a", "b"].map((id) => o.doc.items.get(id));
  assert.strictEqual(_.sameSymbolMultiUnitSelection(o.doc, items).length, 2);
  assert.strictEqual(_.swapUnitLabels(o.c, items), null);
  assert.strictEqual(last(o.c).label, "Swap Unit Labels");
  const t = (id) => K.str(o.doc.items.get(id).node[1]);
  assert.deepStrictEqual([t("la1"), t("la2"), t("lb1"), t("lb2")], ["B1", "B2", "A1", "A2"]);
  // different references are not units of one symbol
  const p = open(LIB2 + U("a", 1, 50.8, 50.8) + U("b", 2, 50.8, 76.2, "U2"));
  assert.deepStrictEqual(_.sameSymbolMultiUnitSelection(p.doc, ["a", "b"].map((id) => p.doc.items.get(id))), []);
  // a pin without its label: the infobar error, nothing changed
  const q = open(LIB2 + U("a", 1, 50.8, 50.8) + U("b", 2, 50.8, 76.2) + LBL("la1", 45.72, 50.8, "A1"));
  assert.ok(/exactly one attached net label/.test(_.swapUnitLabels(q.c, ["a", "b"].map((id) => q.doc.items.get(id)))));
  assert.strictEqual(q.c.log.length, 0);
});
test("sch-selection#23: Swap Pins trades two pins' library geometry on the symbol's own library copy, only when allowed", () => {
  const o = open(LIB2 + U("a", 1, 50.8, 50.8) + U("c", 1, 101.6, 50.8, "U2"));
  assert.strictEqual(_.swapPins(o.c, [{ id: "a", number: "1" }, { id: "a", number: "2" }], false), null);
  assert.strictEqual(o.c.log.length, 0, "input.allow_unconstrained_pin_swaps off: nothing");
  const before = _.symbolPins(o.doc, o.doc.items.get("a")).map((p) => [p.number, p.x, p.y]);
  assert.strictEqual(_.swapPins(o.c, [{ id: "a", number: "1" }, { id: "a", number: "2" }], true), null);
  assert.strictEqual(last(o.c).label, "Swap Pins");
  const a = o.doc.items.get("a"), pins = _.symbolPins(o.doc, a);
  assert.deepStrictEqual(pins.map((p) => [p.number, p.x, p.y]).sort(), [["1", before[1][1], before[1][2]], ["2", before[0][1], before[0][2]]].sort());
  assert.strictEqual(K.str(K.kid(a.node, "lib_name")[1]), "U_1", "the shared library symbol is split into a variant");
  const c = _.symbolPins(o.doc, o.doc.items.get("c")); assert.strictEqual(c.find((p) => p.number === "1").x, 101.6 - 5.08, "the other symbol keeps its pins");
  // a symbol of several sheet instances is refused
  const shared = U("s", 1, 50.8, 50.8).replace('(path "/root" (reference "U1") (unit 1))', '(path "/root" (reference "U1") (unit 1)) (path "/root/x" (reference "U1") (unit 1))');
  const q = open(LIB2 + shared);
  assert.ok(/disabled for shared symbols/.test(_.swapPins(q.c, [{ id: "s", number: "1" }, { id: "s", number: "2" }], true)));
});

test("sch-render#10: a remapped stacked pin keeps its block and shows \"/\" + the original number after the whole block", () => {
  // a short pin whose stacked number [1,2,3,4] does not fit along it: the block is split into lines and remapped to "[A1,A2,A3,A4]"
  const lib = `(lib_symbols (symbol "L:S" (property "Reference" "U" (at 0 0 0) ${FONT}) (property "Value" "S" (at 0 0 0) ${FONT})
    (associated_footprints (footprint "P:Q" (map "m1"))) (pin_maps (pin_map "m1" (entry "[1,2,3,4]" "[A1,A2,A3,A4]")))
    (symbol "S_1_1" (pin passive line (at -5.08 0 0) (length 1.27) (name "~" ${FONT}) (number "[1,2,3,4]" ${FONT})))))`;
  const sym = `(symbol (lib_id "L:S") (at 50.8 50.8 0) (unit 1) (uuid "u1") (property "Reference" "U1" (at 50 44 0) ${FONT}) (property "Value" "S" (at 50 56 0) ${FONT}) (property "Footprint" "P:Q" (at 50 50 0) (effects (font (size 1.27 1.27)) (hide yes))))`;
  const doc = K.parseDoc(HEAD + lib + sym + ")"), it = doc.items.get("u1");
  const nums = it.geom.filter((g) => g.t === "text" && g.layer === "Pin numbers");
  const lines = nums.filter((g) => /^A\d$/.test(g.text)), from = nums.find((g) => g.text === "/[1,2,3,4]");
  assert.strictEqual(lines.length, 4, "the remapped block, one line per pad"); assert.ok(from, "the original number");
  assert.strictEqual(from.alpha, 0.5); assert.strictEqual(from.h, "left");
  const right = Math.max(...lines.map((g) => g.x + K.textWidth(g.text, g.size, 0) / 2));
  assert.ok(from.x >= right - 0.2, "left aligned at the block's right edge");
});

test("sch-draw-inspect#26/#27/#28: Find hits a pin of the unit shown as the pin itself, at its position; net names come from the resolved nets", () => {
  const o = open(LIB2 + U("a", 2, 50.8, 50.8) + LBL("l1", 40, 40, "SIG") + `(global_label "G" (shape input) (at 30 30 0) ${FONT} (uuid "g1"))`);
  const pins = (d, it) => _.symbolPins(d, it);
  const hits = L.findHits(o.doc, { query: "4", pins: true, symbolPins: pins }, null, (d, n) => K.resolveLib(d, n)).filter((x) => x.what === "Pin");
  assert.strictEqual(hits.length, 1, "unit 2 has pins 3 and 4 only");
  assert.strictEqual(hits[0].pin, "4"); assert.strictEqual(hits[0].id, "a");
  const p4 = _.symbolPins(o.doc, o.doc.items.get("a")).find((p) => p.number === "4");
  assert.deepStrictEqual([hits[0].x, hits[0].y], [p4.x, p4.y], "the pin's own position");
  assert.strictEqual(L.findHits(o.doc, { query: "1", pins: true, symbolPins: pins }, null).filter((x) => x.what === "Pin").length, 0, "unit 1's pins are not searched");
  // by name: both pins named A/B; the pin entry matches by name or number
  assert.deepStrictEqual(L.findHits(o.doc, { query: "B", pins: true, wholeWord: true, symbolPins: pins }, null).filter((x) => x.what === "Pin").map((x) => x.pin), ["4"]);
  // Search net names: the resolver's names, for pins and every label kind; nothing without a resolver
  const nets = (it, pin) => (it.id === "a" && pin === "3" ? ["/N$3"] : it.id === "g1" ? ["G"] : it.id === "l1" ? ["/SIG"] : []);
  const n = L.findHits(o.doc, { query: "N$3", netNames: true, netNamesOf: nets, symbolPins: pins }, null);
  assert.deepStrictEqual(n.map((x) => [x.what, x.pin]), [["Pin", "3"]]);
  assert.deepStrictEqual(L.findHits(o.doc, { query: "/SIG", netNames: true, netNamesOf: nets }, null).map((x) => x.id), ["l1"]);
  assert.deepStrictEqual(L.findHits(o.doc, { query: "/SIG", netNames: true }, null).map((x) => x.id), []);
  assert.deepStrictEqual(L.findHits(o.doc, { query: "G", wholeWord: true, matchCase: true, netNames: true, netNamesOf: nets }, null).map((x) => x.id), ["g1"]);
});

test("sch-move-wires#16: Align to Grid gives a sheet pin that changed sides its new side's justification, and takes the hovered item with nothing selected", () => {
  const o = open(SHEET("s1", 10, 10, 2, 10, "s1.kicad_sch", [{ name: "P", at: [12, 19.9], rot: 0, just: "right" }]));
  const ch = _.alignToGridChanges(o.c, [o.doc.items.get("s1")]);
  assert.ok(ch.length); o.c.commit(ch, "Align Items to Grid");
  const pin = K.kids(o.doc.items.get("s1").node, "pin")[0], a = K.atOf(pin), j = K.kid(K.kid(pin, "effects"), "justify");
  assert.deepStrictEqual([a[1], a[2]], [20.32, 270], "on the bottom edge");
  assert.strictEqual(K.str(j[1]), "left", "SetSide( BOTTOM ): justify left");
  // nothing selected: the label under the cursor is aligned and not left selected
  const p = open(LBL("l1", 50.9, 50.9, "N"));
  p.c.cursor = [50.9, 50.9];
  assert.strictEqual(_.alignToGrid(p.c), true);
  assert.deepStrictEqual(K.atOf(p.doc.items.get("l1").node).slice(0, 2), [50.8, 50.8]);
  assert.strictEqual(p.c.selection.size, 0);
});

test("sch-selection#13/#14/#8: sheet pins and sheet / label fields are candidates of their own; a box takes items, fields and pins together", () => {
  const body = SHEET("s1", 50.8, 50.8, 25.4, 20.32, "s1.kicad_sch", [{ name: "IN", at: [50.8, 55.88], rot: 180, just: "left" }])
    + `(global_label "G" (shape input) (at 101.6 50.8 0) ${FONT} (uuid "g1") (property "Intersheetrefs" "[1]" (at 110 50.8 0) ${FONT}))`
    + `(junction (at 35.56 53.34) (diameter 0) (color 0 0 0 0) (uuid "j1"))`;
  const o = open(body);
  const keys = (mm) => _.clickCandidates(o.c, mm).cands.map((q) => q.key);
  assert.strictEqual(keys([51.3, 55.88])[0], "s1#pin:IN", "the sheet pin ahead of its sheet");
  assert.strictEqual(keys([52, 50.1])[0], "s1@field:Sheetname", "the sheet name field");
  const ir = K.fieldBoxes(o.doc.items.get("g1"), null).find((f) => f.name === "Intersheetrefs");
  if (ir) { const c = ir.pts.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]); assert.strictEqual(keys(c)[0], "g1@field:Intersheetrefs", "a label's field"); }
  // a box holding the junction, the sheet name and the sheet pin, but not the whole sheet: all three
  const r = _.areaCandidates(o.c, { box: [29, 48, 57, 57], contained: true });
  assert.deepStrictEqual(r.items.map((q) => q.item.id), ["j1"]);
  assert.deepStrictEqual(r.fields, [{ id: "s1", name: "Sheetname" }]);
  assert.deepStrictEqual(r.pins, [{ id: "s1", number: "IN" }]);
  // the sheet itself taken: its pin and fields go with it (FilterCollectorForHierarchy)
  const all = _.areaCandidates(o.c, { box: [20, 40, 80, 80], contained: true });
  assert.ok(all.items.some((q) => q.item.id === "s1")); assert.deepStrictEqual([all.fields, all.pins], [[], []]);
});
test("sch-move-wires#17: a selected sheet pin moves along its sheet's edge (ConstrainOnEdge), taking its new side's justification; Drag takes the wire along", () => {
  const body = SHEET("s1", 50.8, 50.8, 25.4, 20.32, "s1.kicad_sch", [{ name: "IN", at: [50.8, 55.88], rot: 180, just: "left" }])
    + `(wire (pts (xy 40.64 55.88) (xy 50.8 55.88)) (stroke (width 0) (type default)) (uuid "w1"))`;
  const o = open(body); let sel = null; o.c.selectPins = (p) => { sel = p; };
  assert.strictEqual(_.beginSheetPinMove(o.c, "s1", "IN", [50.8, 55.88], false, true), true);
  assert.strictEqual(K.kids(o.doc.items.get("s1").node, "pin").length, 0, "the sheet without the pin while it moves");
  sch.onPointerMove(null, [60.96, 50], o.c);   // near the top edge
  sch.onPointerDown({ button: 0 }, [60.96, 50], o.c);
  assert.strictEqual(last(o.c).label, "Drag");
  const pin = K.kids(o.doc.items.get("s1").node, "pin")[0], a = K.atOf(pin);
  assert.deepStrictEqual([a[0], a[1], a[2]], [60.96, 50.8, 90], "on the top edge");
  assert.strictEqual(K.str(K.kid(K.kid(pin, "effects"), "justify")[1]), "right", "SetSide( TOP )");
  assert.strictEqual(K.str(K.kid(pin, "uuid")[1]), "s1-IN", "the same pin");
  assert.deepStrictEqual(K.ptsOf(o.doc.items.get("w1").node)[1], [60.96, 50.8], "the wire end follows");
  assert.deepStrictEqual(sel, [{ id: "s1", number: "IN" }], "the pin stays selected");
  // cancelled: the pin is back as it was, nothing committed
  const n = o.c.log.length;
  _.beginSheetPinMove(o.c, "s1", "IN", [0, 0], false, false); sch.onPointerMove(null, [76.2, 60], o.c); sch.undoRedo(o.c, "undo");
  assert.strictEqual(o.c.log.length, n);
  assert.deepStrictEqual(K.atOf(K.kids(o.doc.items.get("s1").node, "pin")[0]).slice(0, 2), [60.96, 50.8]);
});

test("sch-draw-inspect#25 / sch-dialogs-tools#8: a hidden field Find matches is drawn as shown (SetForceVisible), in its own colour", () => {
  function recCtx() {
    const ops = []; let stroke = "", fill = "";
    const ctx = { canvas: { width: 800, height: 600 }, font: "", textAlign: "", textBaseline: "", lineCap: "", lineJoin: "", globalAlpha: 1, lineWidth: 1 };
    for (const n of ["setTransform", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "setLineDash", "clearRect", "bezierCurveTo", "quadraticCurveTo", "ellipse"]) ctx[n] = () => {};
    ctx.measureText = (t) => ({ width: t.length * 0.7 });
    Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
    Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
    for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = () => { ops.push({ stroke, fill }); };
    ctx.ops = ops; return ctx;
  }
  const sym = U("a", 1, 50.8, 50.8).replace("(instances", `(property "MPN" "XYZ123" (at 50.8 60 0) (effects (font (size 1.27 1.27)) (hide yes))) (instances`);
  const doc = K.parseDoc(HEAD + LIB2 + sym + ")"), view = { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: 30, y0: 30, dpr: 1 };
  const g = doc.items.get("a").hiddenGeom.filter((q) => q.field === "MPN");
  assert.ok(g.length && g.every((q) => q.shownColor === K.SCH.field), "LAYER_FIELDS colour kept for a forced draw");
  const count = (opts) => { const c = recCtx(); K.render(doc, c, view, opts); return c.ops.filter((o) => o.stroke === K.SCH.field || o.fill === K.SCH.field).length; };
  const none = count({}), forced = count({ forceVisible: new Set(["a#field:MPN"]) });
  assert.ok(forced > none, "the forced field is drawn");
  assert.strictEqual(count({ forceVisible: new Set(["a#field:Other"]) }), none);
  // the dialog side: Find with "Search hidden fields" hits the hidden field by name
  const hits = L.findHits(doc, { query: "XYZ", hiddenFields: true }, null);
  assert.deepStrictEqual(hits.map((h) => [h.id, h.field]), [["a", "MPN"]]);
});

test("symedit sch-dialogs-items#32: the pin's number box (PIN_LAYOUT_CACHE::GetPinNumberBBox) decides whether Pin Properties opens on the number", () => {
  const M = load("symedit", "model.ts");
  const sym = K.parse(`(symbol "R" (property "Reference" "R" (at 0 0 0) ${FONT}) (symbol "R_1_1" (pin passive line (at -7.62 0 0) (length 5.08) (name "IN" ${FONT}) (number "12" ${FONT}))))`);
  const doc = K.parseLibSymbol(sym, { unit: 1, bodyStyle: 1 });
  const pin = [...doc.items.values()].find((it) => it.kind === "lib_pin");
  const box = M.pinNumberBox(pin.geom);
  const num = pin.geom.find((g) => g.t === "text" && g.layer === "Pin numbers"), name = pin.geom.find((g) => g.t === "text" && g.text === "IN");
  assert.ok(box && num && name);
  const inside = (x, y) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  assert.ok(inside(num.x, num.y), "the number text is inside");
  assert.ok(!inside(name.x, name.y), "the name is not");
  assert.strictEqual(M.pinNumberBox([]), null);
});

test("sch-dialogs-items#33: Table Properties opens on the first selected cell (rows, then columns)", () => {
  const T = load("editor", "tabledialogs.ts");
  assert.strictEqual(T.firstSelectedCell(new Set([5, 2, 7])), 2);
  assert.strictEqual(T.firstSelectedCell([]), null);
  assert.strictEqual(T.firstSelectedCell(null), null);
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
  console.log(`sch-subitems: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
