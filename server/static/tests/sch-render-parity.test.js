// sch-render-parity.test.js — the schematic painter against KiCad's SCH_PAINTER: SCH_LAYER_ORDER depths, pin
// alternates and pin-to-pad remaps on placed symbols, net class colour / width / style and the colour highlight pass,
// sheet pin and bus junction colours, field names ("show name") and text variables, borderless shapes, rule area
// fills and directive-only areas, the missing-symbol placeholder, pen widths, symbol text boxes, hidden sheet fields
// and body text, theme colours (value, sheet background, anchors, ERC markers), "Override individual item colors",
// the Symbol Editor's disabled and pin target colours, small text, selected images, group boxes and the selection
// preferences.
// Run: node server/static/tests/sch-render-parity.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, _ = globalThis.CollabTools.sch._;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
function recCtx(w, h) {
  const ops = []; let stroke = "", fill = "", alpha = 1, lw = 1;
  const ctx = { canvas: { width: w, height: h }, font: "", textAlign: "", textBaseline: "", lineCap: "", lineJoin: "", calls: {} };
  for (const n of ["setTransform", "beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "setLineDash", "clearRect", "bezierCurveTo", "quadraticCurveTo", "ellipse"]) ctx[n] = () => {};
  ctx.measureText = (t) => ({ width: t.length * 0.7 });
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +(+v).toFixed(3); }, get: () => alpha });
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = (...args) => { ops.push({ op: n, stroke, fill, alpha, lw, args }); };
  ctx.ops = ops; return ctx;
}
const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
const view = { ppm: 10, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
const FONT = '(effects (font (size 1.27 1.27)))';
const texts = (it, f) => it.geom.filter((g) => g.t === "text" && (!f || f(g)));
const near = (a, b, e = 1e-6) => assert(Math.abs(a - b) <= e, `${a} != ${b}`);
const wire = (a, b, u, stroke = "(stroke (width 0) (type default))") => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) ${stroke} (uuid "${u}"))`;

test("1: the layer depths follow SCH_LAYER_ORDER", () => {
  const Z = K.SCH_Z;
  const order = ["notesBg", "sheetBg", "deviceBg", "shapesBg", "bitmap", "sheet", "device", "bus", "wire", "privateNotes", "notes", "sheetFields", "sheetName", "sheetFile", "globlabel", "sheetPin", "noconnect", "junction", "busJunction", "ruleArea", "netclass", "intersheet", "fields", "value", "ref"];
  for (let i = 1; i < order.length; i++) assert(Z[order[i - 1]] < Z[order[i]], `${order[i - 1]} under ${order[i]}`);
  assert(Z.bitmap < 0 && Z.sheet >= 0, "only the background layers are negative");
  assert(Z.loclabel > Z.device && Z.loclabel < Z.bus && Z.hierlabel === Z.loclabel, "label bodies are on LAYER_DEVICE's side of the wires");
  // a graphic line over a wire over a bus; a filled sheet-level rectangle's fill over a symbol body fill; an image over both
  const doc = K.parseDoc(HEAD + wire([0, 0], [10, 0], "w") + '(bus (pts (xy 0 0) (xy 10 0)) (uuid "b")) (polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "p"))'
    + '(rectangle (start 0 0) (end 5 5) (stroke (width 0) (type default)) (fill (type color) (color 255 0 0 1)) (uuid "r")) (junction (at 0 0) (uuid "j")) (no_connect (at 3 3) (uuid "nc")))');
  const z = (id, f) => doc.items.get(id).geom.find(f || (() => true)).z;
  assert(z("b") < z("w") && z("w") < z("p"));
  assert.strictEqual(z("r", (g) => g.noStroke), Z.shapesBg);
  assert(z("nc") < z("j"), "junction above no-connect");
});

const ALT_LIB = `(lib_symbols (symbol "L:U" (pin_names (offset 0.508)) (property "Reference" "U" (at 0 0 0) ${FONT})
  (symbol "U_1_1" (rectangle (start -2.54 2.54) (end 2.54 -2.54) (stroke (width 0) (type default)) (fill (type background)))
    (pin input line (at -5.08 0 0) (length 2.54) (name "GPIO" ${FONT}) (number "1" ${FONT}) (alternate "NC_ALT" no_connect line) (alternate "CLK" input clock))
    (pin passive line (at 5.08 0 180) (length 2.54) (name "\${REFERENCE}_OUT" ${FONT}) (number "2" ${FONT})))))`;
const U = (id, extra = "") => `(symbol (lib_id "L:U") (at 50 50 0) (unit 1) (uuid "${id}") (property "Reference" "U7" (at 50 44 0) ${FONT}) (property "Value" "v" (at 50 56 0) ${FONT}) ${extra})`;

test("2: a pin's chosen alternate draws its name, type and shape", () => {
  let doc = K.parseDoc(HEAD + ALT_LIB + U("u1") + ")"), it = doc.items.get("u1");
  assert(texts(it, (g) => g.text === "GPIO").length === 1 && !texts(it, (g) => g.text === "CLK").length);
  const base = it.geom.filter((g) => g.pinNo === "1" && g.t !== "text").length;
  doc = K.parseDoc(HEAD + ALT_LIB + U("u1", '(pin "1" (uuid "p1") (alternate "CLK"))') + ")"); it = doc.items.get("u1");
  assert(texts(it, (g) => g.text === "CLK").length === 1 && !texts(it, (g) => g.text === "GPIO").length, "the alternate's name");
  assert(it.geom.some((g) => g.pinNo === "1" && g.t === "poly" && g.pts.length === 3), "the alternate's clock shape");
  doc = K.parseDoc(HEAD + ALT_LIB + U("u1", '(pin "1" (uuid "p1") (alternate "NC_ALT"))') + ")"); it = doc.items.get("u1");
  assert(texts(it, (g) => g.text === "NC_ALT").length === 1);
  assert(it.geom.filter((g) => g.pinNo === "1" && g.t === "line").length >= 3 && it.geom.filter((g) => g.pinNo === "1" && g.t !== "text").length > base, "a no_connect alternate draws the X");
});

test("3: wires, buses, junctions and labels take their net class's colour, width and line style; own values win", () => {
  const doc = K.parseDoc(HEAD + wire([0, 0], [10, 0], "w1") + wire([0, 5], [10, 5], "w2", "(stroke (width 0.5) (type dash) (color 1 2 3 1))")
    + '(bus (pts (xy 0 9) (xy 10 9)) (uuid "b1")) (junction (at 0 0) (diameter 0) (color 0 0 0 0) (uuid "j1"))'
    + `(label "A" (at 0 0 0) ${FONT} (uuid "l1") (property "Netclass" "x" (at 0 2 0) ${FONT}))` + ")");
  const ns = { color: "rgb(255,128,0)", wireWidth: 0.6, busWidth: 1.2, dashType: "dash_dot" };
  const g1 = doc.items.get("w1").geom[0], s1 = K.netStyled(doc.items.get("w1"), g1, ns, false);
  assert.notStrictEqual(s1, g1); assert.strictEqual(s1.color, ns.color); assert.strictEqual(s1.w, 0.6); assert(s1.dash && s1.dashType === "dash_dot");
  assert.strictEqual(g1.color, K.SCH.wire, "the item's own record is left alone");
  assert.strictEqual(K.netStyled(doc.items.get("w1"), g1, ns, false), s1, "cached while the style is the same");
  const g2 = doc.items.get("w2").geom[0], s2 = K.netStyled(doc.items.get("w2"), g2, ns, false);
  assert.strictEqual(s2, g2, "a wire with its own colour, width and style keeps them");
  const sb = K.netStyled(doc.items.get("b1"), doc.items.get("b1").geom[0], ns, false); assert.strictEqual(sb.w, 1.2); assert.strictEqual(sb.color, ns.color);
  const j = doc.items.get("j1"), sj = K.netStyled(j, j.geom[0], ns, false);
  assert.strictEqual(sj.color, ns.color); assert.strictEqual(sj.fill, ns.color); near(sj.r, 0.6 * 1.7 / 2);
  const l = doc.items.get("l1"), lt = texts(l, (g) => g.text === "A")[0], lf = texts(l, (g) => g.field === "Netclass")[0];
  assert.strictEqual(K.netStyled(l, lt, ns, false).color, ns.color, "SCH_LABEL_BASE::GetLabelColor");
  assert.strictEqual(K.netStyled(l, lf, ns, false).color, ns.color, "SCH_FIELD::GetFieldColor");
  // rendered: the wire is stroked in the class colour at the class width
  let ctx = recCtx(400, 300); K.render(doc, ctx, view, { schNetStyle: new Map([["w1", ns]]) });
  assert(ctx.ops.some((o) => o.op === "stroke" && o.stroke === ns.color && Math.abs(o.lw - 0.6) < 1e-9));
  // highlight_netclass_colors: the wire in the layer colour over a wider translucent pass in the class colour
  ctx = recCtx(400, 300); K.render(doc, ctx, view, { schNetStyle: new Map([["w1", ns]]), netclassHighlight: { thickness: 15, alpha: 0.6 } });
  const wide = ctx.ops.findIndex((o) => o.op === "stroke" && o.stroke === "rgba(255,128,0,0.6)"), own = ctx.ops.findIndex((o) => o.op === "stroke" && o.stroke === K.SCH.wire && Math.abs(o.lw - 0.6) < 1e-9);
  assert(wide >= 0 && own > wide, "the highlight pass under the wire");
  near(ctx.ops[wide].lw, 0.6 + 15 * 0.0254);
});

const SHEET = (extra = "", fill = "(fill (color 0 0 0 0))") => `(sheet (at 50 50) (size 20 10) (stroke (width 0.1524)) ${fill} (uuid "s1")
  (property "Sheetname" "sub" (at 50 49 0) ${FONT}) (property "Sheetfile" "sub.kicad_sch" (at 50 61 0) ${FONT}) ${extra}
  (pin "P" input (at 70 55 0) ${FONT} (uuid "p1")))`;

test("4, 5, 17: sheet pin shape in the hierarchical label colour, no File: prefix, the pin text offset follows the ratio", () => {
  const doc = K.parseDoc(HEAD + SHEET() + ")"), it = doc.items.get("s1");
  const shape = it.geom.find((g) => g.t === "poly" && g.pinNo === "P"), txt = texts(it, (g) => g.text === "P")[0];
  assert.strictEqual(shape.color, K.SCH.hlabel); assert.strictEqual(txt.color, K.SCH.sheetLabel);
  assert.strictEqual(shape.z, K.SCH_Z.sheetPin);
  assert.strictEqual(texts(it, (g) => g.field === "Sheetfile")[0].text, "sub.kicad_sch");
  assert(_.danglingEnds(doc).some((d) => d.item.id === "s1" && d.color === "hlabel"), "the dangling box too");
  K.setSchFormatting({ textOffsetRatio: 0.5 }, doc);
  try { near(texts(doc.items.get("s1"), (g) => g.text === "P")[0].x, 70 - (0.5 * 1.27 + 1.27)); } finally { K.setSchFormatting({ textOffsetRatio: 0.15 }, doc); }
});

test("6: a shape with a negative stroke width has no outline, its fill stays", () => {
  const doc = K.parseDoc(HEAD + '(rectangle (start 0 0) (end 5 5) (stroke (width -0.0001) (type default)) (fill (type color) (color 255 0 0 1)) (uuid "r"))'
    + '(circle (center 20 20) (radius 3) (stroke (width -0.0001) (type default)) (fill (type none)) (uuid "c")))');
  const r = doc.items.get("r"); assert.strictEqual(r.geom.length, 1); assert(r.geom[0].noStroke && r.geom[0].fill);
  const c = doc.items.get("c"); assert.strictEqual(c.geom.length, 0); assert(c.bbox && c.bbox[0] <= 17 + 1e-9 && c.bbox[2] >= 23 - 1e-9, "the borderless shape keeps its box");
  const ctx = recCtx(400, 300); K.render(doc, ctx, view, {});
  assert(!ctx.ops.some((o) => o.op === "stroke" && o.stroke === K.SCH.notes), "no hairline outline");
});

test("7: a junction on a bus is drawn in the bus junction colour", () => {
  const doc = K.parseDoc(HEAD + '(bus (pts (xy 0 0) (xy 10 0)) (uuid "b")) ' + wire([0, 5], [10, 5], "w") + '(junction (at 5 0) (diameter 0) (color 0 0 0 0) (uuid "jb")) (junction (at 5 5) (diameter 0) (color 0 0 0 0) (uuid "jw")) (junction (at 10 0) (diameter 0) (color 9 9 9 1) (uuid "jo")))');
  const ids = K.busJunctions(doc); assert(ids.has("jb") && ids.has("jo") && !ids.has("jw"));
  const ctx = recCtx(400, 300); K.render(doc, ctx, view, {});
  assert(ctx.ops.some((o) => o.op === "fill" && o.fill === K.SCH.busJunction), "LAYER_BUS_JUNCTION");
  assert(ctx.ops.some((o) => o.op === "fill" && o.fill === K.SCH.junction), "the wire junction keeps LAYER_JUNCTION");
  assert(ctx.ops.some((o) => o.op === "fill" && o.fill === "#090909"), "a junction's own colour wins");
  assert.strictEqual(K.schThemeColors("classic").busJunction, "#000084");
});

test("8, 20: show_name puts the field's name ahead of its text; variables resolve in sheet and label fields, body text and pin names", () => {
  const doc = K.parseDoc(HEAD + ALT_LIB.replace('(symbol "U_1_1"', `(symbol "U_1_1" (text "\${VALUE}/\${NOPE}" (at 0 1 0) ${FONT})`)
    + U("u1", `(property "MPN" "X1" (at 50 60 0) (show_name yes) ${FONT})`)
    + SHEET(`(property "Rev" "r\${SHEETNAME}" (at 50 63 0) (show_name) ${FONT})`)
    + `(global_label "G" (shape input) (at 10 10 0) ${FONT} (uuid "g1") (property "Info" "\${NET_NAME}" (at 10 12 0) (show_name yes) ${FONT}) (property "Raw" "\${NOPE}" (at 10 14 0) ${FONT}))` + ")");
  const u = doc.items.get("u1");
  assert.strictEqual(texts(u, (g) => g.field === "MPN")[0].text, "MPN: X1");
  assert(texts(u, (g) => g.text === "v/${NOPE}").length === 1, "body text: resolved against the symbol, the unknown variable left as written");
  assert(texts(u, (g) => g.text === "U7_OUT").length === 1, "pin name variables");
  assert.strictEqual(texts(doc.items.get("s1"), (g) => g.field === "Rev")[0].text, "Rev: rsub");
  K.setLabelTextVar((item, tok) => (tok === "NET_NAME" ? "/net7" : null));
  try {
    K.buildGeom(doc, doc.items.get("g1"));
    assert.strictEqual(texts(doc.items.get("g1"), (g) => g.field === "Info")[0].text, "Info: /net7");
    assert.strictEqual(texts(doc.items.get("g1"), (g) => g.field === "Raw")[0].text, "${NOPE}", "a field that stays unresolved is still drawn");
  } finally { K.setLabelTextVar(null); }
});

test("9: selection thickness, fill_shapes and draw_selected_children reach the shadow pass", () => {
  const doc = K.parseDoc(HEAD + ALT_LIB + U("u1") + '(rectangle (start 0 0) (end 5 5) (stroke (width 0.2) (type default)) (fill (type none)) (uuid "r")))');
  const SH = K.SCH.selection, px = 1 / 10;
  let ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["r"]) });
  let sh = ctx.ops.filter((o) => o.stroke === SH || o.fill === SH);
  assert(sh.length && sh.every((o) => o.op === "stroke"), "fill_shapes off: stroked only"); near(sh[0].lw, 0.2 + 3 * px + 3 * 0.0254);
  ctx = recCtx(800, 600); K.render(doc, ctx, view, { selected: new Set(["r"]), selThickness: 6, selFill: true });
  sh = ctx.ops.filter((o) => o.stroke === SH || o.fill === SH);
  assert(sh.some((o) => o.op === "fill" && o.fill === SH), "fill_shapes: the shape filled in the shadow colour");
  near(sh.find((o) => o.op === "stroke").lw, 0.2 + 6 * px + 6 * 0.0254);
  const count = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, Object.assign({ selected: new Set(["u1"]) }, opts)); return c.ops.filter((o) => o.stroke === SH).length; };
  assert(count({ selChildren: false }) < count({}), "draw_selected_children off: no shadow for the fields and pin texts");
  K.render(doc, recCtx(800, 600), view, {}); assert.strictEqual(K.SEL_STYLE.thickness, 3);
});

const MAP_LIB = ALT_LIB.replace('(symbol "U_1_1"', '(associated_footprints (footprint "P:SOT" (map "m1"))) (pin_maps (pin_map "m1" (entry "1" "A7"))) (symbol "U_1_1"');
test("10: a remapped pin shows its effective pad, and \"/\" + the original number at 4/5 size and half alpha", () => {
  const fp = `(property "Footprint" "P:SOT" (at 50 50 0) (effects (font (size 1.27 1.27)) (hide yes)))`;
  let doc = K.parseDoc(HEAD + MAP_LIB + U("u1", fp) + ")"), it = doc.items.get("u1");
  const num = texts(it, (g) => g.layer === "Pin numbers" && g.text === "A7")[0], from = texts(it, (g) => g.layer === "Pin numbers" && g.text === "/1")[0];
  assert(num && from, "pad and original"); assert.strictEqual(num.pinNo, "1", "the pin keeps its own number for the net highlight");
  near(from.size, 1.27 * 4 / 5); assert.strictEqual(from.alpha, 0.5); assert.strictEqual(from.h, "left");
  assert(from.x > num.x, "after the number");
  assert(texts(it, (g) => g.layer === "Pin numbers" && g.text === "2").length === 1, "an unmapped pin is unchanged");
  // identity override: no remap; an instance edit patches the map
  doc = K.parseDoc(HEAD + MAP_LIB + U("u1", fp + "(pin_map_override (mode identity))") + ")");
  assert(texts(doc.items.get("u1"), (g) => g.layer === "Pin numbers" && g.text === "1").length === 1);
  doc = K.parseDoc(HEAD + MAP_LIB + U("u1", fp + '(pin_map_override (mode library_default) (edit "2" "B9"))') + ")");
  assert(texts(doc.items.get("u1"), (g) => g.layer === "Pin numbers" && g.text === "B9").length === 1);
  // show_remapped_pin_numbers off: the pad alone
  K.setSchDisplay({ remappedPinNumbers: false });
  try { doc = K.parseDoc(HEAD + MAP_LIB + U("u1", fp) + ")"); assert(!texts(doc.items.get("u1"), (g) => g.text === "/1").length && texts(doc.items.get("u1"), (g) => g.text === "A7").length === 1); }
  finally { K.setSchDisplay({ remappedPinNumbers: true }); }
});

test("11: a selected or entered group draws its box in the anchor colour, with the name tab when it fits", () => {
  const doc = K.parseDoc(HEAD + wire([0, 0], [30, 0], "w1") + wire([0, 10], [30, 10], "w2") + '(group "G" (uuid "g1") (members "w1" "w2")))');
  const boxOps = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, opts); return c.ops.filter((o) => o.op === "stroke" && o.stroke === K.SCH.anchor && Math.abs(o.lw - 0.2) < 1e-9); };
  assert.strictEqual(boxOps({}).length, 0, "neither selected nor entered: nothing at the group level");
  assert(boxOps({ selected: new Set(["w1", "w2"]) }).length >= 2, "selected: the box and the title tab");
  assert.strictEqual(boxOps({ selected: new Set(["w1"]) }).length, 0, "one member alone is not the group");
  assert(boxOps({ schEnteredGroup: "g1" }).length >= 2, "entered");
});

test("12: field anchors for a selected sheet and for a global label's fields", () => {
  const doc = K.parseDoc(HEAD + SHEET() + `(global_label "G" (shape input) (at 10 10 0) ${FONT} (uuid "g1") (property "Info" "i" (at 10 12 0) ${FONT}))` + ")");
  assert.strictEqual(texts(doc.items.get("s1"), (g) => g.field === "Sheetname").length, 1, "sheet field text carries its field name");
  const anchors = (id) => { const c = recCtx(800, 600); K.render(doc, c, view, { selected: new Set([id]) }); return c.ops.filter((o) => o.op === "stroke" && o.stroke === K.SCH.anchor).length; };
  assert(anchors("s1") >= 1, "sheet"); assert(anchors("g1") >= 1, "global label");
});

test("14: rule areas draw their fill; directive labels off hides netclass flags and directive-only areas", () => {
  const area = (id, pts, extra = "") => `(rule_area ${extra} (polyline (pts ${pts.map((p) => `(xy ${p[0]} ${p[1]})`).join(" ")}) (stroke (width 0) (type dash)) (fill (type color) (color 0 255 0 0.5)) (uuid "${id}")))`;
  const doc = K.parseDoc(HEAD + area("a1", [[0, 0], [10, 0], [10, 10], [0, 10]]) + area("a2", [[20, 0], [30, 0], [30, 10], [20, 10]], "(dnp yes)") + area("a3", [[40, 0], [50, 0], [50, 10], [40, 10]])
    + `(netclass_flag "" (length 2.54) (shape round) (at 5 0 0) ${FONT} (uuid "d1") (property "Netclass" "x" (at 5 -3 0) ${FONT}))`
    + `(netclass_flag "" (length 2.54) (shape round) (at 25 0 0) ${FONT} (uuid "d2") (property "Netclass" "x" (at 25 -3 0) ${FONT}))` + ")");
  const a1 = doc.items.get("a1"), fill = a1.geom.find((g) => g.noStroke);
  assert(fill && fill.fill === "rgba(0,255,0,0.5)" && fill.z === K.SCH_Z.notesBg, "the fill on LAYER_NOTES_BACKGROUND");
  assert.deepStrictEqual([...K.directiveOnlyAreas(doc)], ["a1"], "a1 only carries a directive; a2 has DNP, a3 has no directive");
  const drawn = (opts) => { const c = recCtx(800, 600); K.render(doc, c, view, opts); return c.ops.filter((o) => o.op === "fill" && o.fill === "rgba(0,255,0,0.5)").length; };
  assert.strictEqual(drawn({}), 3); assert.strictEqual(drawn({ showDirectiveLabels: false }), 2, "the directive-only area is hidden");
  assert.strictEqual(drawn({ showDirectiveLabels: false, selected: new Set(["a1"]) }), 3, "unless selected");
  const c = recCtx(800, 600); K.render(doc, c, view, { showDirectiveLabels: false });
  assert(!c.ops.some((o) => o.stroke === K.SCH.netclass), "netclass_flag items are hidden too");
});

test("15: a symbol without its library symbol is LIB_SYMBOL::GetDummy: a 400 mil square and \"??\"", () => {
  const doc = K.parseDoc(HEAD + `(symbol (lib_id "No:Such") (at 50 50 0) (unit 1) (uuid "u1") (property "Reference" "U1" (at 50 40 0) ${FONT}))` + ")"), it = doc.items.get("u1");
  const r = it.geom.find((g) => g.t === "rect"); assert.deepStrictEqual([r.x, r.y, r.w, r.h].map((v) => +v.toFixed(4)), [44.92, 44.92, 10.16, 10.16]);
  const q = texts(it, (g) => g.text === "??")[0]; assert(q); near(q.size, 3.81);
});

test("16, 18, 19, 26, 29: label outline pen, graphic line default width, the DNP cross, directive label fields, zero-length NC pins", () => {
  let doc = K.parseDoc(HEAD + `(global_label "G" (shape input) (at 10 10 0) (effects (font (size 2.54 2.54) (bold yes))) (uuid "g1")) (hierarchical_label "H" (shape input) (at 10 20 0) (effects (font (size 2.54 2.54) (thickness 0.4))) (uuid "h1"))`
    + '(polyline (pts (xy 0 0) (xy 10 0)) (stroke (width 0) (type default)) (uuid "p"))' + wire([0, 5], [10, 5], "w")
    + `(netclass_flag "note" (length 2.54) (shape round) (at 5 5 0) ${FONT} (uuid "d1") (property "Netclass" "x" (at 5 2 0) ${FONT}))` + ")");
  near(doc.items.get("g1").geom.find((g) => g.t === "poly").w, 2.54 / 5);   // bold: size / 5 (GetEffectiveTextPenWidth)
  near(doc.items.get("h1").geom.find((g) => g.t === "poly").w, 0.4);        // its own thickness
  const d1 = doc.items.get("d1"); assert(!texts(d1, (g) => g.text === "note").length, "a directive label's own text is not drawn");
  const f = texts(d1, (g) => g.field === "Netclass")[0]; assert.strictEqual(f.color, K.SCH.field); assert.strictEqual(f.z, K.SCH_Z.fields);
  K.setSchFormatting({ lineWidth: 0.3 }, doc);
  try {
    near(doc.items.get("p").geom[0].w, 0.3); near(doc.items.get("w").geom[0].w, 0.1524);
    const dn = K.parseDoc(HEAD + ALT_LIB + U("u1", "(dnp yes)") + ")"); near(dn.items.get("u1").geom.find((g) => g.color === K.SCH.dnp).w, 3 * 0.1524);
  } finally { K.setSchFormatting({ lineWidth: 0.1524 }, doc); }
  const nc = ALT_LIB.replace("(pin input line (at -5.08 0 0) (length 2.54)", "(pin no_connect line (at -5.08 0 0) (length 0)");
  doc = K.parseDoc(HEAD + nc + U("u1") + ")");
  assert.strictEqual(doc.items.get("u1").geom.filter((g) => g.pinNo === "1" && g.t === "line" && g.layer === "Pins").length, 3, "the line and the two diagonals");
});

test("21, 22: a symbol's text box has its border, fill and wrapped text; hidden sheet fields and body text go to the hidden layer", () => {
  const lib = ALT_LIB.replace('(symbol "U_1_1"', `(symbol "U_1_1" (text_box "one two three four five six" (at -10 20 0) (size 8 -12) (stroke (width 0) (type dash)) (fill (type color) (color 0 0 255 1)) ${FONT}) (text "secret" (at 0 -1 0) (effects (font (size 1.27 1.27)) (hide yes)))`);
  const doc = K.parseDoc(HEAD + lib + U("u1") + SHEET(`(property "Hid" "h" (at 50 65 0) (effects (font (size 1.27 1.27)) (hide yes)))`) + ")"), it = doc.items.get("u1");
  const fill = it.geom.find((g) => g.t === "rect" && g.noStroke), border = it.geom.find((g) => g.t === "rect" && !g.noStroke);
  assert(fill && fill.fill === "#0000ff" && fill.z === K.SCH_Z.shapesBg); assert(border && border.dash && border.color === K.SCH.outline);
  assert.deepStrictEqual([border.x, border.y, border.w, border.h].map((v) => +v.toFixed(4)), [40, 30, 8, 12], "the box mapped through the symbol transform (library Y up)");
  assert(texts(it, (g) => /^(one|two|three|four|five|six)/.test(g.text)).length > 1, "wrapped to the box width");
  assert(!texts(it, (g) => g.text === "secret").length && it.hiddenGeom.some((g) => g.text === "secret" && g.color === K.SCH.hidden && g.hiddenText));
  const sh = doc.items.get("s1"); assert(!texts(sh, (g) => g.text === "h").length && sh.hiddenGeom.some((g) => g.field === "Hid" && g.color === K.SCH.hidden));
});

test("23, 24: theme colours (value, sheet background, ERC markers) and Override individual item colors", () => {
  const src = HEAD + ALT_LIB + U("u1") + SHEET("", "") + wire([0, 0], [10, 0], "w", "(stroke (width 0) (type default) (color 255 0 0 1))")
    + '(rectangle (start 0 0) (end 5 5) (stroke (width 0) (type default) (color 0 255 0 1)) (fill (type color) (color 0 0 255 1)) (uuid "r")))';
  const T = K.SCH_THEMES; T.t23 = { name: "t23", dark: false, colors: { value: "#123456", sheetBg: "rgba(10,20,30,0.5)", ercErr: "#010203" } };
  try {
    K.setSchTheme("t23");
    const doc = K.parseDoc(src);
    assert.strictEqual(texts(doc.items.get("u1"), (g) => g.field === "Value")[0].color, "#123456", "LAYER_VALUEPART");
    assert(doc.items.get("s1").geom.some((g) => g.noStroke && g.fill === "rgba(10,20,30,0.5)" && g.z === K.SCH_Z.sheetBg), "LAYER_SHEET_BACKGROUND when the sheet has none");
    const c = recCtx(400, 300); K.render(doc, c, view, { markers: [{ x: 5, y: 5, severity: "error", text: "e", ids: [] }] });
    assert(c.ops.some((o) => o.fill === "#010203"), "LAYER_ERC_ERR");
  } finally { K.setSchTheme("default"); delete T.t23; }
  const doc = K.parseDoc(src);
  assert(!doc.items.get("s1").geom.some((g) => g.noStroke), "KiCad Default's sheet background has alpha 0: not drawn");
  assert.strictEqual(doc.items.get("w").geom[0].color, "#ff0000");
  assert(K.setSchFormatting({ overrideItemColors: true }, doc));
  try {
    assert.strictEqual(doc.items.get("w").geom[0].color, K.SCH.wire, "the wire's own colour is ignored");
    const r = doc.items.get("r"); assert.strictEqual(r.geom.find((g) => !g.noStroke).color, K.SCH.notes); assert.strictEqual(r.geom.find((g) => g.noStroke).fill, "#0000ff", "a FILLED_WITH_COLOR fill keeps its colour");
  } finally { K.setSchFormatting({ overrideItemColors: false }, doc); }
  assert.strictEqual(doc.items.get("w").geom[0].color, "#ff0000");
});

test("25: the Symbol Editor darkens a disabled (inherited) item by half and brightens the pin target", () => {
  const sym = K.parse(`(symbol "U" (property "Reference" "U" (at 0 0 0) ${FONT}) (symbol "U_1_1" (rectangle (start -2 2) (end 2 -2) (stroke (width 0) (type default)) (fill (type none))) (pin input line (at -5.08 0 0) (length 2.54) (name "A" ${FONT}) (number "1" ${FONT}))))`);
  const d = K.parseLibSymbol(sym, { disabled: true });
  const rect = [...d.items.values()].find((i) => i.geom.some((g) => g.t === "poly" && g.close));
  const half = (c) => { const m = /^#(..)(..)(..)$/.exec(c); return "#" + [1, 2, 3].map((i) => Math.round(parseInt(m[i], 16) / 2).toString(16).padStart(2, "0")).join(""); };
  assert.strictEqual(rect.geom.find((g) => g.t === "poly").color.toLowerCase(), half(K.SCH.outline).toLowerCase(), "Darken( 0.5 )");
  const live = K.parseLibSymbol(sym, {}), pin = [...live.items.values()].find((i) => i.kind === "lib_pin");
  const target = pin.geom.find((g) => g.t === "circle"), m = /^#(..)(..)(..)$/.exec(K.SCH.pin);
  const br = "#" + [1, 2, 3].map((i) => Math.round(parseInt(m[i], 16) * 0.7 + 255 * 0.3).toString(16).padStart(2, "0")).join("");
  assert.strictEqual(target.color.toLowerCase(), br.toLowerCase(), "Brightened( 0.3 )");
});

test("27, 28: text below the legible size is still marked; a selected image keeps an alpha of at least 0.1", () => {
  const doc = K.parseDoc(HEAD + `(text "hello" (at 10 10 0) ${FONT} (uuid "t"))` + ")");
  const far = { ppm: 1, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };   // 1.27 px text
  const c = recCtx(400, 300); c.getTransform = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }); K.render(doc, c, far, {});
  assert(c.ops.some((o) => o.op === "stroke" && o.stroke === K.SCH.notes), "a small mark, not nothing");
  const img = K.parseDoc(HEAD + ")"); const it = { id: "i", kind: "image", node: ["image"], bbox: [0, 0, 10, 10], geom: [{ t: "image", x: 0, y: 0, w: 10, h: 10, opacity: 0.02, pxMm: 1, scale: 1, color: "#000000", layer: "Images", z: K.SCH_Z.bitmap, entry: null }] };
  img.items.set("i", it);
  // not decoded: the placeholder frame is stroked at the image's alpha
  const alphaOf = (opts) => { const x = recCtx(400, 300); K.render(img, x, view, opts); return x.ops.filter((o) => o.op === "strokeRect" && o.stroke !== K.SCH.selection && o.args[2] === 10 && o.args[3] === 10 && o.args[0] === 0)[0].alpha; };
  near(alphaOf({}), 0.02, 1e-9); near(alphaOf({ selected: new Set(["i"]) }), 0.1, 1e-9);
});

console.log(`sch-render-parity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
