// sch-draw-inspect.test.js — KiCad parity of the schematic drawing tools, the point editor and the inspection commands
// (SCH_DRAWING_TOOLS, SCH_POINT_EDITOR, SCH_INSPECTION_TOOL): primed tools, undo / redo with an operation in flight,
// the rule area's 45-degree leader, sheets drawn by a drag, KiCad's commit descriptions, wires cut by a dropped symbol,
// label field autoplace, Place Next Symbol Unit, image formats and resolution, Show Datasheet.
// Run: node server/static/tests/sch-draw-inspect.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const { kid, kids, str, ptsOf, atOf } = K;
const IU = 1e4;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const FONT = "(effects (font (size 1.27 1.27)))";
const LIB_R = `(symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) ${FONT}) (property "Value" "R" (at 0 0 90) ${FONT})
  (property "Footprint" "" (at -1.778 0 90) ${FONT} (hide yes)) (property "Datasheet" "~" (at 0 0 0) ${FONT} (hide yes))
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${FONT}) (number "1" ${FONT}))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" ${FONT}) (number "2" ${FONT}))))`;
const LIB_OPA = `(symbol "Amp:OPA" (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "U" (at 0 5.08 0) ${FONT}) (property "Value" "OPA" (at 0 -5.08 0) ${FONT})
  (symbol "OPA_1_1" (pin input line (at -5.08 0 0) (length 2.54) (name "A" ${FONT}) (number "1" ${FONT})))
  (symbol "OPA_2_1" (pin input line (at -5.08 0 0) (length 2.54) (name "B" ${FONT}) (number "2" ${FONT})))
  (symbol "OPA_3_1" (pin input line (at -5.08 0 0) (length 2.54) (name "C" ${FONT}) (number "3" ${FONT}))))`;
const HEAD = `(kicad_sch (version 20250114) (generator "t") (uuid "root-uuid") (paper "A4") (lib_symbols ${LIB_R} ${LIB_OPA}) `;
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), entered: [], opened: [],
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label, opts) { ctx.log.push({ changes, label, opts }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU)); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, enterSheet(f) { ctx.entered.push(f); }, setTool(t) { ctx.tool = t; sch.onActivate(t, ctx); },
  };
  return ctx;
}
const wire = (a, b, u) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${u}"))`;
const sym = (lib, ref, unit, at, u, extra) => `(symbol (lib_id "${lib}") (at ${at[0]} ${at[1]} 0) (unit ${unit}) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${u}")
  (property "Reference" "${ref}" (at ${at[0]} ${at[1] - 5.08} 0) ${FONT}) (property "Value" "V" (at ${at[0]} ${at[1] + 5.08} 0) ${FONT}) ${extra || ""}
  (instances (project "t" (path "/root-uuid" (reference "${ref}") (unit ${unit})))))`;
function fresh(body) {
  const doc = K.parseDoc(HEAD + (body || "") + ")", "kicad_sch"), ctx = makeCtx(doc);
  sch.setPrompt((t, i, c, done) => done(null));
  sch.state.carry = null; sch.state.draw = null; sch.state.wire = null; sch.state.sel = null; sch.state.immediateActions = true; sch.state.placeOne = null;
  sch.onDocChanged(ctx); sch.setLineMode(ctx, "90"); sch.onActivate("select", ctx);
  return { doc, ctx };
}
const last = (ctx) => ctx.log[ctx.log.length - 1];
const ev = (x, y) => ({ button: 0, clientX: x || 0, clientY: y || 0 });
const of = (doc, kind) => [...doc.items.values()].filter((i) => i.kind === kind);

// ---------------------------------------------------------------- primed tools (findings 1 - 3)
test("J places a junction under the cursor at once; Q a no-connect (TOOL_MANAGER::PrimeTool)", () => {
  const { doc, ctx } = fresh(wire([0, 0], [20.32, 0], "w1") + wire([10.16, 0], [10.16, 10.16], "w2"));
  sch.onPointerMove(ev(), [10.16, 0], ctx);
  assert.ok(sch.onKey("j", {}, ctx));
  assert.strictEqual(last(ctx).label, "Add Junction");
  assert.strictEqual(of(doc, "junction").length, 1);
  assert.deepStrictEqual(atOf(of(doc, "junction")[0].node).slice(0, 2), [10.16, 0]);
  assert.strictEqual(sch.state.tool, "junction", "the tool stays for the next one");
  sch.onActivate("select", ctx);
  sch.onPointerMove(ev(), [30.48, 30.48], ctx);
  assert.ok(sch.onKey("q", {}, ctx));
  assert.strictEqual(last(ctx).label, "Add No Connect Flag");
  assert.strictEqual(of(doc, "no_connect").length, 1);
  sch.onActivate("select", ctx);
});

test("\"First hotkey selects tool\": the first press only selects, the second is primed", () => {
  const { doc, ctx } = fresh(wire([0, 0], [20.32, 0], "w1") + wire([10.16, 0], [10.16, 10.16], "w2"));
  sch.state.immediateActions = false;
  sch.onPointerMove(ev(), [10.16, 0], ctx);
  assert.ok(sch.onKey("j", {}, ctx));
  assert.strictEqual(sch.state.tool, "junction"); assert.strictEqual(of(doc, "junction").length, 0, "nothing placed by the first press");
  assert.ok(sch.onKey("j", {}, ctx));
  assert.strictEqual(of(doc, "junction").length, 1, "the tool was current: its hotkey is primed");
  sch.state.immediateActions = true; sch.onActivate("select", ctx);
});

test("a hotkey primes the label dialog once; a toolbar activation opens it too (immediate actions), not with the preference off", () => {
  const { ctx } = fresh();
  let asked = 0; sch.setPrompt((t, i, c, done) => { asked++; done(null); });
  sch.onPointerMove(ev(), [10.16, 10.16], ctx);
  assert.ok(sch.onKey("l", {}, ctx)); assert.strictEqual(asked, 1, "one dialog for the hotkey");
  sch.onActivate("select", ctx); asked = 0;
  ctx.setTool("label"); assert.strictEqual(asked, 1, "chosen from the toolbar: the dialog opens straight away");
  sch.onActivate("select", ctx); asked = 0;
  sch.state.immediateActions = false;
  ctx.setTool("label"); assert.strictEqual(asked, 0, "immediate actions off: the tool waits for a click");
  sch.state.immediateActions = true; sch.onActivate("select", ctx);
  // the sheet pin tool is never primed
  assert.strictEqual(sch.primeTool(ctx, "sheetpin"), false);
  sch.setPrompt((t, i, c, done) => done(null));
});

test("a context-menu entry starts its tool at the menu position: Add Junction on a wire places at once", () => {
  const { doc, ctx } = fresh(wire([0, 0], [20.32, 0], "w1") + wire([10.16, 0], [10.16, 10.16], "w2"));
  sch.onPointerMove(ev(), [50, 50], ctx);
  sch.hotkeyTool("junction", ctx, [10.16, 0]);
  assert.strictEqual(of(doc, "junction").length, 1);
  assert.deepStrictEqual(atOf(of(doc, "junction")[0].node).slice(0, 2), [10.16, 0]);
  sch.onActivate("select", ctx);
});

// ---------------------------------------------------------------- undo / redo / delete in flight (findings 6, 13, 24)
test("undo while drawing a sheet or a table cancels it, a rule area loses its last corner; redo is swallowed", () => {
  const { ctx } = fresh();
  sch.onActivate("sheet", ctx); sch.onPointerDown(ev(), [10.16, 10.16], ctx);
  assert.ok(sch.state.draw);
  assert.strictEqual(sch.undoRedo(ctx, "redo"), true); assert.ok(sch.state.draw, "redo only beeps");
  assert.strictEqual(sch.undoRedo(ctx, "undo"), true); assert.strictEqual(sch.state.draw, null, "the sheet in progress is dropped");
  assert.strictEqual(sch.undoRedo(ctx, "undo"), false, "nothing in flight: the document's undo");
  sch.onActivate("table", ctx); sch.onPointerDown(ev(), [10.16, 10.16], ctx);
  assert.strictEqual(sch.undoRedo(ctx, "undo"), true); assert.strictEqual(sch.state.draw, null);
  sch.setLineMode(ctx, "free");
  sch.onActivate("rulearea", ctx);
  for (const p of [[10.16, 10.16], [20.32, 10.16], [20.32, 20.32]]) sch.onPointerDown(ev(), p, ctx);
  const n = sch.state.draw.pts.length;
  assert.strictEqual(sch.undoRedo(ctx, "undo"), true); assert.strictEqual(sch.state.draw.pts.length, n - 1);
  assert.ok(sch.onKey("Delete", {}, ctx)); assert.strictEqual(sch.state.draw.pts.length, n - 2, "Delete takes a corner back too");
  sch.onActivate("select", ctx); assert.strictEqual(ctx.log.length, 0);
});

test("an idle label tool leaves on undo and swallows redo (TwoClickPlace)", () => {
  const { ctx } = fresh();
  sch.onActivate("label", ctx); ctx.tool = "label";
  assert.strictEqual(sch.undoRedo(ctx, "redo"), true); assert.strictEqual(sch.state.tool, "label");
  assert.strictEqual(sch.undoRedo(ctx, "undo"), true); assert.strictEqual(ctx.tool, "select");
});

test("End finishes a sheet or a table like the second click; Backspace does not cancel a sheet", () => {
  const { ctx } = fresh();
  let staged = null; sch.setPrompt((t, i, c, done) => { staged = t; done(null); });
  sch.onActivate("sheet", ctx); sch.onPointerDown(ev(), [10.16, 10.16], ctx); sch.onPointerMove(ev(), [40.64, 30.48], ctx);
  assert.ok(sch.onKey("Backspace", {}, ctx)); assert.ok(sch.state.draw, "Backspace is not the sheet tool's");
  assert.ok(sch.onKey("End", {}, ctx));
  assert.strictEqual(staged, "Sheet name", "the sheet is finished: its properties are asked");
  sch.setPrompt((t, i, c, done) => done(null)); sch.state.draw = null; sch.onActivate("select", ctx);
});

// ---------------------------------------------------------------- rule area (finding 7)
test("rule area: 45-degree leader outside the Free line mode, its corners are locked in and close the outline", () => {
  const { doc, ctx } = fresh();
  sch.setLineMode(ctx, "90");
  assert.deepStrictEqual(_.build45Leader([20.32, 12.7], [[10.16, 10.16]]), [[10.16, 10.16], [20.32, 10.16]], "the first leg snaps to 45 degrees");
  assert.deepStrictEqual(_.build45Leader([40.64, 20.32], [[10.16, 10.16], [20.32, 10.16]]), [[20.32, 10.16], [30.48, 10.16], [40.64, 20.32]], "one bend: straight on, then the diagonal");
  sch.onActivate("rulearea", ctx);
  sch.onPointerDown(ev(), [10.16, 10.16], ctx);
  sch.onPointerDown(ev(), [30.48, 10.16], ctx);
  sch.onPointerDown(ev(), [40.64, 30.48], ctx);                       // reached through a bend: two corners locked
  const pts = sch.state.draw.pts; assert.ok(pts.length >= 5);
  for (let i = 1; i < pts.length; i++) { const dx = Math.abs(pts[i][0] - pts[i - 1][0]), dy = Math.abs(pts[i][1] - pts[i - 1][1]); assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, "every edge is horizontal, vertical or diagonal"); }
  sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [10.16, 30.48], ctx);   // a double click ends it
  assert.strictEqual(last(ctx).label, "Draw Rule Area");
  const ra = of(doc, "rule_area")[0]; assert.ok(ra);
  const out = ptsOf(kid(ra.node, "polyline"));
  for (let i = 0; i < out.length; i++) { const a = out[i], b = out[(i + 1) % out.length]; const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]); assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6, "the closed outline keeps the 45-degree constraint"); }
  assert.strictEqual(sch.state.sel, ra.id, "the new rule area is selected");
  // Free mode: straight segments
  sch.setLineMode(ctx, "free");
  assert.deepStrictEqual(_.ruleAreaLeader([[0, 0]], [7, 3]), { leader: [[0, 0], [7, 3]], loop: [] });
  sch.setLineMode(ctx, "90"); sch.onActivate("select", ctx);
});

// ---------------------------------------------------------------- sheets (findings 11, 12, 15, 36)
test("a sheet is drawn by press-drag-release; a click releases nothing", () => {
  const { ctx } = fresh();
  let asked = 0; sch.setPrompt((t, i, c, done) => { asked++; done(null); });
  sch.onActivate("sheet", ctx);
  sch.onPointerDown(ev(100, 100), [10.16, 10.16], ctx);
  sch.onPointerUp(ev(101, 101), [10.16, 10.16], ctx);
  assert.ok(sch.state.draw && !sch.state.draw.await, "a click: the second click ends the sheet");
  assert.strictEqual(asked, 0);
  sch.state.draw = null;
  sch.onPointerDown(ev(100, 100), [10.16, 10.16], ctx);
  sch.onPointerMove(ev(300, 200), [50.8, 40.64], ctx);
  sch.onPointerUp(ev(300, 200), [50.8, 40.64], ctx);
  assert.strictEqual(asked, 1, "the release after a drag is the terminating click: the sheet's properties open");
  sch.setPrompt((t, i, c, done) => done(null)); sch.state.draw = null; sch.onActivate("select", ctx);
});

test("with the sheet tool active a click on the selected sheet is ignored and a double click enters it", () => {
  const { doc, ctx } = fresh(`(sheet (at 10.16 10.16) (size 25.4 12.7) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid "sh1")
    (property "Sheetname" "Sub" (at 10.16 9.4 0) ${FONT}) (property "Sheetfile" "sub.kicad_sch" (at 10.16 23.5 0) ${FONT}))`);
  const sh = doc.items.get("sh1"); assert.ok(sh);
  sch.onActivate("sheet", ctx); ctx.selected = { id: "sh1" };
  sch.onPointerDown(ev(), [20.32, 15.24], ctx);
  assert.strictEqual(sch.state.draw, null, "no new sheet starts inside the selected one");
  sch.onPointerDown(Object.assign(ev(), { detail: 2 }), [20.32, 15.24], ctx);
  assert.deepStrictEqual(ctx.entered, [sh.file || "sub.kicad_sch"]);
  ctx.selected = null; sch.onActivate("sheet", ctx);
  sch.onPointerDown(ev(), [60.96, 60.96], ctx); assert.ok(sch.state.draw, "elsewhere a sheet starts");
  sch.state.draw = null; sch.onActivate("select", ctx);
});

test("new sheets take the default border and background colours; the commit is flagged as a new sheet", () => {
  sch.state.sheetBorder = "#840000"; sch.state.sheetBackground = "#FFFFC280";
  const n = _.sheetNode([0, 0], [25.4, 12.7], "A", "a.kicad_sch");
  assert.deepStrictEqual(kid(n, "stroke"), ["stroke", ["width", 0.1524], ["type", "solid"], ["color", 132, 0, 0, 1]]);
  assert.deepStrictEqual(kid(n, "fill"), ["fill", ["color", 255, 255, 194, 0.502]]);
  sch.state.sheetBorder = ""; sch.state.sheetBackground = "";
  const d = _.sheetNode([0, 0], [25.4, 12.7], "A", "a.kicad_sch");
  assert.deepStrictEqual(kid(d, "stroke"), ["stroke", ["width", 0.1524], ["type", "solid"]]);
  assert.deepStrictEqual(kid(d, "fill"), ["fill", ["color", 0, 0, 0, 0]]);
});

// ---------------------------------------------------------------- placement (findings 5, 22, 36)
test("a symbol dropped on a wire cuts the wire between its pins, in the placement's commit (TrimOverLappingWires)", () => {
  const { doc, ctx } = fresh(wire([50.8, 20.32], [50.8, 60.96], "w1"));
  sch.onActivate("place", ctx);
  _.startCarry(ctx, "symbol", _.symbolNode(doc, "Device:R", [50.8, 40.64], 0, ""), [50.8, 40.64]);
  sch.onPointerDown(ev(), [50.8, 40.64], ctx);
  assert.strictEqual(last(ctx).label, "Place Symbol");
  const segs = of(doc, "wire").map((w) => JSON.stringify(ptsOf(w.node).map((p) => p[1]).sort((a, b) => a - b))).sort();
  assert.deepStrictEqual(segs, ["[20.32,36.83]", "[44.45,60.96]"], "nothing is left between the two pins");
  assert.strictEqual(ctx.log.length, 1, "one undo step");
  sch.state.carry = null; sch.onActivate("select", ctx);
});

test("KiCad's undo descriptions for placements", () => {
  assert.strictEqual(_.placeLabel("symbol"), "Place Symbol"); assert.strictEqual(_.placeLabel("image"), "Place Image");
  assert.strictEqual(_.placeLabel("text"), "Add Text"); assert.strictEqual(_.placeLabel("label"), "Add Label");
  assert.strictEqual(_.placeLabel("global_label"), "Add Label"); assert.strictEqual(_.placeLabel("netclass_flag"), "Add Label");
  assert.strictEqual(_.placeLabel("hierarchical_label"), "Add Hierarchical Label");
});

test("a dropped label autoplaces its fields (SCH_LABEL_BASE::AutoplaceFields)", () => {
  const lab = K.parse(`(label "NET" (at 10.16 10.16 0) ${FONT} (uuid "l1") (property "Netclass" "PWR" (at 0 0 90) (effects (font (size 1.27 1.27)) (justify right))))`);
  const out = _.autoplaceLabelNode("label", lab, 0);
  const f = kids(out, "property")[0];
  // spin right: horizontal, left justified, half the label's text height plus half the field's below the anchor
  assert.deepStrictEqual(atOf(f), [10.16, 11.43, 0]);
  assert.deepStrictEqual(kid(kid(f, "effects"), "justify"), ["justify", "left"]);
  assert.strictEqual(str(kid(out, "fields_autoplaced")[1]), "yes");
  const up = K.parse(`(global_label "NET" (shape input) (at 10.16 10.16 90) ${FONT} (uuid "g1") (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 0 0 0) ${FONT}))`);
  const g = kids(_.autoplaceLabelNode("global_label", up, 5.08), "property")[0];
  // spin up: vertical, left justified, the body length plus twice the text offset (0.15 x 1.27, in nanometres) above
  assert.deepStrictEqual(atOf(g), [10.16, 10.16 - 5.08 - 0.381, 90].map((v) => +v.toFixed(4)));
  assert.strictEqual(_.autoplaceLabelNode("label", K.parse(`(label "X" (at 0 0 0) ${FONT} (uuid "l2"))`), 0), null, "no fields: nothing to place");
});

// ---------------------------------------------------------------- Place Next Symbol Unit (finding 19)
test("Place Next Symbol Unit: KiCad's messages, units counted over the hierarchy, the tool ends with the placement", () => {
  const { doc, ctx } = fresh(sym("Amp:OPA", "U1", 1, [50.8, 50.8], "u1a") + sym("Device:R", "R1", 1, [80, 50.8], "r1"));
  assert.strictEqual(_.placeNextUnit(ctx), false); assert.strictEqual(ctx.toasts.pop(), "Select a single symbol to place the next unit.");
  ctx.selected = { id: "r1" };
  assert.strictEqual(_.placeNextUnit(ctx), false); assert.strictEqual(ctx.toasts.pop(), "This symbol has only one unit.");
  ctx.selected = { id: "u1a" };
  sch.state.otherUnits = [{ ref: "U1", lib: "Amp:OPA", value: "V", unit: 2 }];   // unit B sits on another sheet
  assert.deepStrictEqual(_.unplacedUnits(doc, doc.items.get("u1a")), [3]);
  assert.strictEqual(_.placeNextUnit(ctx, { unit: 2 }), false); assert.strictEqual(ctx.toasts.pop(), "Requested unit already placed.");
  assert.strictEqual(_.placeNextUnit(ctx), true);
  const c = sch.state.carry; assert.ok(c && c.kind === "symbol");
  assert.strictEqual(K.num(kid(c.node, "unit")[1]), 3);
  assert.strictEqual(str(kids(c.node, "property")[0][2]), "U1", "the reference is kept");
  ctx.tool = "place";
  sch.onPointerDown(ev(), [101.6, 50.8], ctx);
  assert.strictEqual(last(ctx).label, "Place Symbol"); assert.strictEqual(ctx.tool, "select", "placeOneOnly: back to the selection tool");
  ctx.selected = { id: "u1a" };
  assert.strictEqual(_.placeNextUnit(ctx), false); assert.strictEqual(ctx.toasts.pop(), "All units of this symbol are already placed.");
  sch.state.otherUnits = null;
});

// ---------------------------------------------------------------- images and datasheets (findings 23, 32)
test("images: png, jpeg, bmp and gif are accepted; the size follows the file's resolution; KiCad's error text", () => {
  assert.ok(/\.bmp/.test(_.IMAGE_ACCEPT) && /\.gif/.test(_.IMAGE_ACCEPT) && /\.jpeg/.test(_.IMAGE_ACCEPT) && /\.png/.test(_.IMAGE_ACCEPT));
  const bmp = new Uint8Array(54); bmp[0] = 0x42; bmp[1] = 0x4D; new DataView(bmp.buffer).setInt32(18, 200, true); new DataView(bmp.buffer).setInt32(22, -100, true); new DataView(bmp.buffer).setInt32(38, 3780, true);
  assert.deepStrictEqual(K.imageInfo(bmp), { mime: "image/bmp", w: 200, h: 100, ppi: 94 }, "3780 px/m -> 37 px/cm -> 94 PPI (wx reports whole px/cm)");
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xF0, 0x00]);
  assert.deepStrictEqual(K.imageInfo(gif), { mime: "image/gif", w: 320, h: 240, ppi: 300 });
  const { ctx } = fresh();
  sch.setImagePicker((c, done) => done({ name: "pic.bmp", bytes: bmp }));
  sch.onActivate("image", ctx);
  assert.ok(sch.state.carry && sch.state.carry.kind === "image");
  assert.deepStrictEqual(sch.state.carry.size.map((v) => +v.toFixed(3)), [+(200 * 25.4 / 94).toFixed(3), +(100 * 25.4 / 94).toFixed(3)]);
  sch.state.carry = null; sch.onActivate("select", ctx);
  sch.setImagePicker((c, done) => done({ name: "notes.txt", bytes: new Uint8Array([1, 2, 3, 4, 5]) }));
  sch.onActivate("image", ctx);
  assert.strictEqual(sch.state.carry, null); assert.strictEqual(ctx.toasts.pop(), "Could not load image from 'notes.txt'.");
  sch.onActivate("select", ctx);
});

test("Show Datasheet: the field's shown text (variables resolved), KiCad's message, the editor's document opener", () => {
  const { doc, ctx } = fresh(sym("Device:R", "R1", 1, [50.8, 50.8], "r1", `(property "Datasheet" "https://example.org/\${MPN}.pdf" (at 0 0 0) ${FONT}) (property "MPN" "RC0603" (at 0 0 0) ${FONT})`)
    + sym("Device:R", "R2", 1, [70, 50.8], "r2", `(property "Datasheet" "~" (at 0 0 0) ${FONT})`));
  ctx.openDatasheet = (v, it) => ctx.opened.push([v, it.id]);
  ctx.selected = { id: "r1" };
  assert.strictEqual(_.showDatasheet(ctx), true);
  assert.deepStrictEqual(ctx.opened, [["https://example.org/RC0603.pdf", "r1"]]);
  ctx.selected = { id: "r2" };
  assert.strictEqual(_.showDatasheet(ctx), false); assert.strictEqual(ctx.toasts.pop(), "No datasheet defined.");
  assert.strictEqual(_.symbolShownText(doc.items.get("r1").node, "${REFERENCE}-${VALUE}-${NOPE}"), "R1-V-${NOPE}");
});

// ---------------------------------------------------------------- point editor (SCH_POINT_EDITOR)
const STROKE = `(stroke (width 0) (type default)) (fill (type none))`;
test("point editor: wires and buses have no edit points (pointEditorTypes); a graphic line keeps its two", () => {
  const { doc, ctx } = fresh(`(wire (pts (xy 10.16 10.16) (xy 20.32 10.16)) (stroke (width 0) (type default)) (uuid "w1"))
    (bus (pts (xy 10.16 20.32) (xy 20.32 20.32)) (stroke (width 0) (type default)) (uuid "b1"))
    (polyline (pts (xy 10.16 30.48) (xy 20.32 30.48)) (stroke (width 0) (type default)) (uuid "l1"))`);
  assert.strictEqual(_.editPoints(doc, doc.items.get("w1")), null);
  assert.strictEqual(_.editPoints(doc, doc.items.get("b1")), null);
  assert.strictEqual(_.editPoints(doc, doc.items.get("l1")).pts.length, 2);
  sch.onActivate("select", ctx); sch.state.sel = "w1";
  assert.ok(!_.pointEditStart(ctx, [10.16, 10.16], {}), "a wire end is dragged, never point-edited");
});
test("EDIT_POINTS::FindPoint: +/- 8 px strict box, points before edge handles, the first hit wins", () => {
  const ep = { pts: [[0, 0], [3, 0]], lines: [[0, 1]], guides: [] };
  assert.strictEqual(_.findEditPoint(ep, [1.9, 1.9], 0.25), 0, "inside the first point's 2 mm box");
  assert.strictEqual(_.findEditPoint(ep, [2, 0], 0.25), 1, "on the first box's border: outside it, inside the second's");
  assert.strictEqual(_.findEditPoint(ep, [1.6, 0], 0.25), 0, "nearer the edge handle and the second point, but the first point is tested first");
  assert.strictEqual(_.findEditPoint(ep, [1.5, 0], 0.05), 2, "zoomed in: only the edge handle's box holds it");
  assert.strictEqual(_.findEditPoint(ep, [1.5, 0.4], 0.05), -1);
});
test("arc editing modes (EDA_ARC_POINT_EDIT_BEHAVIOR) and Cycle Arc Editing Mode", () => {
  const { doc, ctx } = fresh(`(arc (start 60 50) (mid 57.0711 57.0711) (end 50 60) ${STROKE} (uuid "a1"))`);
  sch.onActivate("select", ctx); sch.state.sel = "a1"; ctx.snap = (mm) => [mm[0], mm[1]];
  const near = (a, b, msg) => assert.ok(Math.abs(a[0] - b[0]) < 2e-3 && Math.abs(a[1] - b[1]) < 2e-3, (msg || "") + " " + JSON.stringify(a) + " vs " + JSON.stringify(b));
  const P = (key) => kid(doc.items.get("a1").node, key).slice(1, 3);
  const drag = (at, to) => { assert.ok(_.pointEditStart(ctx, at, {}), "a handle at " + at); _.pointEditMove(ctx, to, {}); return _.pointEditEnd(ctx, true); };
  // keep centre and radius: the end slides round the circle, the start and the centre stay
  sch.state.arcEditMode = "radius";
  drag([50, 60], [30, 50]);
  near(P("end"), [40, 50], "the end at radius 10 towards the cursor"); near(P("start"), [60, 50], "the start stays");
  assert.strictEqual(ctx.log[ctx.log.length - 1].label, "Move Point");
  // keep endpoints: the centre slides along the chord's bisector, both ends stay
  sch.state.arcEditMode = "endpoints";
  const s0 = P("start"), e0 = P("end");
  drag([50, 50], [47, 47]);   // the centre handle (a half circle from (60,50) to (40,50): the chord is horizontal)
  near(P("start"), s0, "start kept"); near(P("end"), e0, "end kept");
  const m = P("mid"); assert.ok(Math.abs(m[0] - 50) < 2e-3, "the mid stays on the bisector x = 50: " + m);
  const c2 = _.editPoints(doc, doc.items.get("a1")).pts[3]; near(c2, [50, 47], "the centre took the cursor's projection on the bisector");
  // the mid handle: along its ray from the chord, the ends stay
  const m0 = P("mid"); drag(m0, [m0[0] + 3, m0[1] + 4]);
  near(P("start"), s0); near(P("end"), e0); const m1 = P("mid"); assert.ok(Math.abs(m1[0] - 50) < 2e-3 && Math.abs(m1[1] - (m0[1] + 4)) < 2e-3, "mid moved along the ray only: " + m1);
  // the cycle: centre -> radius -> endpoints -> centre, stored through the editor
  const stored = []; ctx.setArcEditMode = (v) => stored.push(v);
  sch.state.arcEditMode = "center";
  sch.actions.cycleArcEditMode.run(ctx); sch.actions.cycleArcEditMode.run(ctx); sch.actions.cycleArcEditMode.run(ctx);
  assert.deepStrictEqual(stored, ["radius", "endpoints", "center"]);
  assert.strictEqual(_.arcEditPoints([[60, 50], [57, 57], [50, 60], [50, 50]], 0, [70, 50], [70, 50], "center"), null, "the default mode keeps its own path");
});
test("Create Corner / Remove Corner on a polygon and a rule area (SCH_POINT_EDITOR::addCorner, removeCorner)", () => {
  const { doc, ctx } = fresh(`(polyline (pts (xy 10.16 10.16) (xy 30.48 10.16) (xy 30.48 30.48)) ${STROKE} (uuid "p1"))
    (rule_area (polyline (pts (xy 50.8 10.16) (xy 71.12 10.16) (xy 71.12 30.48)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra")))
    (polyline (pts (xy 10.16 50.8) (xy 30.48 50.8)) (stroke (width 0) (type default)) (uuid "l1"))`);
  sch.onActivate("select", ctx); sch.state.sel = "p1";
  assert.ok(_.editPoints(doc, doc.items.get("p1")), "the polygon is edited");
  assert.strictEqual(sch.canAddCorner(ctx, [20.32, 11]), true, "within 8 px of the outline");
  assert.strictEqual(sch.canAddCorner(ctx, [25.4, 16]), false, "inside an unfilled polygon: no hit");
  assert.strictEqual(sch.canAddCorner(ctx, [20.5, 20.5]), true, "the closing edge counts");
  assert.strictEqual(sch.canRemoveCorner(ctx, [20.32, 10.16]), false, "no corner under the cursor");
  ctx.cursor = [20.5, 10.4];
  assert.strictEqual(sch.actions.pointEditorAddCorner.run(ctx), true);
  assert.strictEqual(ctx.log[ctx.log.length - 1].label, "Add Corner");
  assert.deepStrictEqual(ptsOf(doc.items.get("p1").node), [[10.16, 10.16], [20.32, 10.16], [30.48, 10.16], [30.48, 30.48]], "after the nearest segment's start, on the grid");
  ctx.cursor = [20.32, 20.32];
  sch.actions.pointEditorAddCorner.run(ctx);
  assert.deepStrictEqual(ptsOf(doc.items.get("p1").node)[4], [20.32, 20.32], "on the closing segment: appended after the last corner");
  ctx.cursor = [20.32, 10.16]; assert.strictEqual(sch.canRemoveCorner(ctx, ctx.cursor), true);
  assert.strictEqual(sch.actions.pointEditorRemoveCorner.run(ctx), true);
  assert.strictEqual(ctx.log[ctx.log.length - 1].label, "Remove Corner");
  assert.strictEqual(ptsOf(doc.items.get("p1").node).length, 4);
  // a rule area keeps three corners
  sch.state.sel = "ra";
  assert.strictEqual(sch.canRemoveCorner(ctx, [50.8, 10.16]), false, "three corners: none may go");
  ctx.cursor = [60.96, 10.16]; assert.strictEqual(sch.canAddCorner(ctx, ctx.cursor), true); sch.actions.pointEditorAddCorner.run(ctx);
  assert.strictEqual(ptsOf(kid(doc.items.get("ra").node, "polyline")).length, 4);
  assert.strictEqual(sch.canRemoveCorner(ctx, [60.96, 10.16]), true);
  // a two-point graphic line is a line, not a polygon
  sch.state.sel = "l1"; assert.strictEqual(sch.canAddCorner(ctx, [20.32, 50.8]), false);
});

// ---------------------------------------------------------------- sheet navigation (SCH_NAVIGATE_TOOL)
test("Previous / Next Sheet order: sheet instances by page number, then the walk order (SCH_SHEET_LIST::SortByPageNumbers)", () => {
  const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
  const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", "domains", "pcb", "sim", "sheet-pages.ts")], bundle: true, format: "cjs", target: "es2020", write: false });
  const m = { exports: {} }; new Function("module", "exports", "require", built.outputFiles[0].text)(m, m.exports, require);
  const leaf = (name, page, children) => ({ name, page, children: children || [] });
  const tree = leaf("Root", "1", [leaf("power", "10", [leaf("ldo", "2")]), leaf("mcu", "3"), leaf("io", "A"), leaf("io2", "3")]);
  const order = m.exports.sheetsByPage(tree);
  assert.deepStrictEqual(order.map((o) => o.node.page + ":" + o.human), ["1:/", "2:/power/ldo/", "3:/mcu/", "3:/io2/", "10:/power/", "A:/io/"],
    "integers by value, the same page in walk order, text pages last");
  // several top-level sheets: the hidden project root is no page
  const multi = { name: "proj", page: "", virtual: true, children: [leaf("Main", "2"), leaf("Second", "1", [leaf("child", "3")])] };
  assert.deepStrictEqual(m.exports.sheetsByPage(multi).map((o) => o.human), ["/Second/", "/Main/", "/Second/child/"]);
  assert.deepStrictEqual(m.exports.sheetsByPage(null), []);
});

// ---------------------------------------------------------------- message panel (UpdateMsgPanel while a tool runs)
test("message panel subject: the item on the cursor, then the item being point-edited", () => {
  const { doc, ctx } = fresh(`(rectangle (start 10.16 10.16) (end 30.48 30.48) ${STROKE} (uuid "rc"))`);
  assert.strictEqual(sch.msgPanelSubject(), null, "nothing in flight: the selection decides");
  sch.onActivate("text", ctx); sch.state.carry = { kind: "text", node: K.parse(`(text "hello" (at 20.32 20.32 0) ${FONT} (uuid "tx"))`), item: null, pos: null };
  sch.onPointerMove({}, [20.32, 20.32], ctx);
  const a = sch.msgPanelSubject(); assert.ok(a && a.item.kind === "text" && !doc.items.has(a.item.id), "the carried ghost, not a document item");
  const rows = sch.msgPanelInfo(doc, { id: a.item.id, item: a.item }, { units: "mm" });
  assert.ok(rows.length && rows.some((r) => /hello/.test(r.value) || /hello/.test(r.title)), "its GetMsgPanelInfo rows: " + JSON.stringify(rows));
  sch.onPointerMove({}, [25.4, 20.32], ctx);
  assert.notStrictEqual(sch.msgPanelSubject().key, a.key, "the key follows the item as it changes");
  sch.state.carry = null; sch.onActivate("select", ctx); sch.state.sel = "rc";
  assert.ok(_.pointEditStart(ctx, [10.16, 10.16], {}));
  const b = sch.msgPanelSubject(); assert.strictEqual(b.item.id, "rc");
  _.pointEditMove(ctx, [5.08, 5.08], {}); assert.notStrictEqual(sch.msgPanelSubject().key, b.key);
  _.pointEditEnd(ctx, false); assert.strictEqual(sch.msgPanelSubject(), null);
});

// ---------------------------------------------------------------- the item on the cursor takes the edit commands
test("item on the cursor: Increment a label, DNP / body style / Autoplace Fields on a symbol, nothing committed", () => {
  const { doc, ctx } = fresh();
  const carry = (kind, src) => { sch.state.carry = { kind, node: K.parse(src), item: null, pos: null }; sch.onPointerMove({}, [50.8, 50.8], ctx); };
  sch.onActivate("label", ctx); carry("label", `(label "D7" (at 20.32 20.32 0) ${FONT} (uuid "lc"))`);
  assert.strictEqual(sch.actions.increment.run(ctx), true);
  assert.strictEqual(sch.state.carry.node[1], "D8"); assert.strictEqual(sch.state.carry.item.id, "lc", "the ghost follows");
  sch.onActivate("symbol", ctx); carry("symbol", sym("Device:R", "R?", 1, [20.32, 20.32], "sc"));
  assert.strictEqual(sch.actions.setDNP.run(ctx), true);
  assert.strictEqual(str(kid(sch.state.carry.node, "dnp")[1]), "yes");
  sch.actions.setDNP.run(ctx); assert.strictEqual(str(kid(sch.state.carry.node, "dnp")[1]), "no");
  assert.strictEqual(sch.actions.cycleBodyStyle.run(ctx), false, "Device:R has one body style");
  const before = JSON.stringify(sch.state.carry.node);
  sch.actions.autoplace.run(ctx); assert.ok(sch.state.carry && sch.state.carry.item, "still on the cursor"); void before;
  assert.strictEqual(ctx.log.length, 0, "nothing was committed: the item is not in the document yet");
  assert.ok(!doc.items.has("sc") && !doc.items.has("lc"));
  sch.state.carry = null; sch.onActivate("select", ctx);
});

console.log(`sch-draw-inspect: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
