// common-core.test.js — the shared text, unit and drawing code checked against KiCad's own: StringFromValue,
// ExpandTextVars with the expression evaluator, EDA_ITEM::Matches / Replace, STRING_INCREMENTER, UnescapeString,
// the markup parser and word wrap, GetTextBox, (line_spacing), the drawing sheet parser (polygons, bitmaps, headers,
// legacy codes, constrained text), the message panel for ellipses, the text pens, board hatch fills and rounded
// rectangles, dashed strokes and the unlimited undo list.
// Run: node server/static/tests/common-core.test.js
"use strict";
const fs = require("fs"), path = require("path"), assert = require("assert");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));
const web = path.join(server, "web");
const load = (contents) => {
  const out = esbuild.buildSync({ bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node", stdin: { resolveDir: web, loader: "ts", contents } });
  const M = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(M, M.exports, require);
  return M.exports;
};
const L = load(`
  export { stringFromValue } from "./shared/units";
  export { expandTextVars, hasTextVars, incrementString, parseDrawingSheet, buildDrawingSheet, convertLegacyVariableRefs, convertToNewOverbarNotation, constrainedTextSize, sheetTextPen, sheetTextVars } from "./domains/pcb/canvas/sheet";
  export { evaluateText } from "./domains/pcb/canvas/text-eval";
  export { unescapeText, parseMarkup, strokeTextBox, textPen, layoutPen, textWidth } from "./domains/pcb/canvas/text";
  export { linebreakText, parseStrokeMarkup } from "./domains/pcb/canvas/stroke-font";
  export { ellipseLength, effectsOf, fillOf, parse } from "./domains/pcb/canvas/sexpr";
  export { matcher, replaceText } from "./domains/pcb/dialogs/logic";
`);
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, P = globalThis.CollabTools.pcb;

const BOARD = (body) => K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (25 "Dwgs.User" user))
  (net 0 "")
  ${body})`, "kicad_pcb");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= (tol || 1e-9), `${msg || ""} ${a} != ${b}`);

// #1
test("#1 StringFromValue: %.3f mils on the schematic, %.5f on the board, %.6f / %.8f inches, %.10f mm, on the IU grid", () => {
  assert.strictEqual(L.stringFromValue(0.001, "mil", "pcb"), "0.03937 mils");
  assert.strictEqual(L.stringFromValue(0.001, "mil", "sch"), "0.039 mils");
  assert.strictEqual(L.stringFromValue(0.00762, "in", "pcb"), "0.0003 in");
  assert.strictEqual(L.stringFromValue(0.00762, "in", "sch"), "0.000299 in", "0.0076 mm on the 100 nm grid, %.6f");
  assert.strictEqual(L.stringFromValue(1.27, "in", "sch"), "0.05 in");
  assert.strictEqual(L.stringFromValue(0.123456789, "mm", "pcb"), "0.123457 mm", "rounded to the 1 nm IU first");
  assert.strictEqual(L.stringFromValue(0.123456789, "mm", "sch", false), "0.1235", "100 nm IU, no unit");
  assert.strictEqual(L.stringFromValue(0.000001, "mil", "pcb"), "0.00004 mils", "one IU");
  assert.strictEqual(L.stringFromValue(0, "mm", "pcb"), "0 mm");
});

// #2 – #7
test("#2 @{…} expressions are evaluated (EXPRESSION_EVALUATOR): precedence, units, functions, errors left as typed", () => {
  const E = L.evaluateText;
  assert.strictEqual(E("@{1+2*3}"), "7");
  assert.strictEqual(E("@{-2^2}"), "-4");
  assert.strictEqual(E("@{1in}"), "25.4");
  assert.strictEqual(E("@{3k3*2}"), "6600");
  assert.strictEqual(E("@{round(-2.5)}"), "-3");
  assert.strictEqual(E("@{format(2.5,0)}"), "2");
  assert.strictEqual(E("@{1e-7}"), "1e-07");
  assert.strictEqual(E("@{1/0}"), "@{1/0}");
  const vars = { ROW: "3" };
  assert.strictEqual(L.expandTextVars("R@{${ROW}-1}", (t) => vars[t]), "R2");
});
test("#3 \\${…} and \\@{…} are shown literally", () => {
  assert.strictEqual(L.expandTextVars("\\${TITLE}", () => "x"), "${TITLE}");
  assert.strictEqual(L.expandTextVars("\\@{1+1}", () => undefined), "@{1+1}");
});
test("#4 / #5 VCSHASH, VCSSHORTHASH and CURRENT_TIME_HH_MM_SS as KiCad formats it", () => {
  const v = L.sheetTextVars({ vcsHash: "0123456789abcdef", vcsShortHash: "0123456" });
  assert.strictEqual(v.VCSHASH, "0123456789abcdef"); assert.strictEqual(v.VCSSHORTHASH, "0123456");
  assert.ok(/^\d\dh\d\dm\d\ds$/.test(v.CURRENT_TIME_HH_MM_SS), v.CURRENT_TIME_HH_MM_SS);
});
test("#6 / #7 ERC / DRC tokens are hidden outside ERC; empty and unterminated references", () => {
  assert.strictEqual(L.expandTextVars("a${ERC_WARNING x}b", () => undefined), "ab");
  assert.strictEqual(L.expandTextVars("a${DRC_ERROR x}b", () => undefined), "ab");
  assert.strictEqual(L.expandTextVars("a${}b", () => "z"), "ab");
  assert.strictEqual(L.expandTextVars("${TITLE", (t) => (t === "TITLE" ? "T" : undefined)), "T");
  assert.strictEqual(L.expandTextVars("${NOPE}", () => undefined), "${NOPE}");
});

// #8
test("#8 Find: whole word is bounded by non-word characters, no wildcards; Replace follows EDA_ITEM::Replace", () => {
  const m = (q, o, t) => { const f = L.matcher(Object.assign({ query: q }, o)); return !!f && f(t); };
  assert.ok(m("VPP", { wholeWord: true }, "note about VPP"));
  assert.ok(!m("VPP", { wholeWord: true }, "VPP_ON"), "_ is a word character");
  assert.ok(m("vpp", { wholeWord: true }, "x-vpp-y"));
  assert.ok(!m("vpp*", {}, "vpp_on"), "* is a plain character");
  assert.ok(m("vpp*", {}, "vpp*"));
  assert.strictEqual(L.replaceText("VPP and VPP_ON", { query: "VPP", wholeWord: true, matchCase: true }, "VCC"), "VCC and VPP_ON");
});

// #9
test("#9 STRING_INCREMENTER: primary / secondary parts, IOSQXZ skipping, the alphabetic bound", () => {
  const I = L.incrementString;
  assert.strictEqual(I("A1", 1, 0), "A2"); assert.strictEqual(I("A1", 1, 1), "B1");
  assert.strictEqual(I("D7b", 1, 0), "D7c"); assert.strictEqual(I("D7b", 1, 1), "D8b");
  assert.strictEqual(I("R009", 1, 0), "R010"); assert.strictEqual(I("R0", -1, 0), null);
  assert.strictEqual(I("H1", 1, 1, true), "J1", "I is skipped");
  assert.strictEqual(I("I1", 1, 1, true), "J1", "a run that holds I uses the full alphabet");
  assert.strictEqual(I("Z", 1, 0), "AA");
  assert.strictEqual(I("BZ", 1, 0, false, 50), null, "index 77 is above m_AlphabeticMaxIndex");
  assert.strictEqual(I("x", 1, 1), null);
  assert.strictEqual(sch._.incrementStringPart("A1", 1, 1), "B1");
});
test("#9 schematic Increment Primary / Secondary actions: labels of one kind, one \"Increment\" step", () => {
  const doc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "r") (paper "A4")
  (label "D7b" (at 10 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l1"))
  (label "A1" (at 20 10 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "l2"))
  (text "T" (at 30 10 0) (effects (font (size 1.27 1.27))) (uuid "t1")))`);
  const log = [];
  const ctx = { K, doc, IU: 1e4, isSch: true, zoom: 1, pxPerMm: 8, gridPitch: 1.27, snapOn: true, items: [], viewOnly: false, live: true, selection: new Set(["l1", "l2"]), selected: null,
    snap: (p) => p, setSelected() {}, setSelection() {}, requestRender() {}, toast() {}, commit(ch, label) { log.push(label); for (const c of ch) assert.ok(K.applyChange(doc, c, 1e4)); } };
  sch.onDocChanged(ctx);
  assert.ok(sch.actions.incrementSecondary && sch.actions.decrementPrimary, "the four actions exist");
  sch.actions.incrementSecondary.run(ctx);
  assert.deepStrictEqual(log, ["Increment"]);
  assert.strictEqual(doc.items.get("l1").node[1], "D8b"); assert.strictEqual(doc.items.get("l2").node[1], "B1");
  ctx.selection = new Set(["l1", "t1"]);
  assert.strictEqual(sch.actions.incrementPrimary.run(ctx), false, "mixed types do nothing");
});
test("#9 board Increment Primary: PCB text steps with IOSQXZ skipped; pads only in the footprint editor", () => {
  assert.ok(P.actions.incrementPrimary && P.actions.decrementSecondary && P.actions.increment, "the actions exist");
  const doc = BOARD(`(gr_text "H1" (at 10 10) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))`);
  const log = [];
  const ctx = { K, doc, IU: 1e6, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, selection: new Set(["t1"]), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(l) { ctx.selection = new Set(l); }, setHighlight() {},
    commit(ch, label) { log.push(label); for (const c of ch) K.applyChange(doc, c, 1e6); P.onDocChanged(ctx); }, toast() {} };
  P.onDocChanged(ctx);
  P.runAction("incrementSecondary", ctx);
  assert.deepStrictEqual(log, ["Increment"]); assert.strictEqual(doc.items.get("t1").node[1], "J1", "H steps to J: I is skipped");
  P.runAction("decrementPrimary", ctx); assert.strictEqual(doc.items.get("t1").node[1], "J0");
});

// #10 / #11
test("#10 board hatch fills: hatch / reverse_hatch / cross_hatch lines, width = stroke, spacing = 10 x width", () => {
  const doc = BOARD(`(gr_rect (start 0 0) (end 10 10) (stroke (width 0.1) (type solid)) (fill hatch) (layer "F.SilkS") (uuid "r1"))
  (gr_circle (center 30 5) (end 35 5) (stroke (width 0.1) (type solid)) (fill cross_hatch) (layer "F.SilkS") (uuid "c1"))
  (gr_rect (start 50 0) (end 60 10) (stroke (width 0.1) (type solid)) (fill no) (layer "F.SilkS") (uuid "r2"))`);
  assert.strictEqual(L.fillOf(L.parse("(gr_rect (fill reverse_hatch))")).type, "reverse_hatch");
  const lines = (id) => doc.items.get(id).geom.filter((g) => g.t === "line");
  const r = lines("r1"); assert.ok(r.length >= 10 && r.length <= 20, "about 10 / 1 mm lines across a 10 mm square: " + r.length);
  for (const g of r) { near(g.w, 0.1); near((g.y2 - g.y1) / (g.x2 - g.x1), -1, 1e-6, "slope -1"); }
  const c = lines("c1"); assert.ok(c.some((g) => (g.y2 - g.y1) / (g.x2 - g.x1) > 0) && c.some((g) => (g.y2 - g.y1) / (g.x2 - g.x1) < 0), "cross hatch has both slopes");
  assert.strictEqual(lines("r2").length, 0);
});
test("#11 board rectangles with (radius r) are drawn rounded", () => {
  const doc = BOARD(`(gr_rect (start 0 0) (end 10 6) (radius 2) (stroke (width 0.1) (type dash)) (fill no) (layer "F.SilkS") (uuid "r1"))`);
  const g = doc.items.get("r1").geom.find((q) => q.t === "poly");
  assert.ok(g.pts.length > 4, "corner arcs");
  assert.ok(!g.pts.some(([x, y]) => (x === 0 && y === 0) || (x === 10 && y === 6)), "no sharp corner");
  // each corner arc is segmented to the board's ARC_HIGH_DEF (0.005 mm): r = 2 mm gives 12 segments, 13 points per corner
  const k = g.pts.length / 4; assert.strictEqual(k, 13);
  assert.deepStrictEqual(g.dashBreaks, [0, k - 1, k, 2 * k - 1, 2 * k, 3 * k - 1, 3 * k, 4 * k - 1], "the dash restarts on each side and corner arc");
});

// #12 / #13
test("#12 stroke-text hit box is EDA_TEXT::GetTextBox: 0.17 x height fudge, overbar sixth, italic offset", () => {
  const b = L.strokeTextBox({ text: "AB", size: 1, sizeX: 1, w: 0.15, h: "left", v: "bottom" });
  assert.ok(b[3] > 0, "the bottom-justified box reaches below the baseline (fudge factor)");
  const over = L.strokeTextBox({ text: "AB", raw: "~{AB}", size: 1, sizeX: 1, w: 0.15, h: "left", v: "bottom" });
  assert.ok(over[3] - over[1] > b[3] - b[1], "an overbar makes the box taller");
});
test("#13 (line_spacing N) is read and scales the interline", () => {
  const ef = L.effectsOf(L.parse(`(text "a" (effects (font (size 1 1) (line_spacing 1.5))))`));
  assert.strictEqual(ef.lineSpacing, 1.5);
  const doc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "r") (paper "A4")
  (text "a\\nb" (at 10 10 0) (effects (font (size 1 1) (line_spacing 2)) (justify left bottom)) (uuid "t1"))
  (text "a\\nb" (at 50 10 0) (effects (font (size 1 1)) (justify left bottom)) (uuid "t2")))`);
  const ys = (id) => doc.items.get(id).geom.filter((g) => g.t === "text").map((g) => g.y);
  const d1 = Math.abs(ys("t1")[1] - ys("t1")[0]), d2 = Math.abs(ys("t2")[1] - ys("t2")[0]);
  near(d1, 2 * d2, 1e-6, "twice the interline");
});

// #14 – #16
const PNG_HEX = "89 50 4E 47 0D 0A 1A 0A 00 00 00 0D 49 48 44 52 00 00 00 01 00 00 00 01 08 06 00 00 00 1F 15 C4 89 00 00 00 0D 49 44 41 54 78 9C 63 F8 0F 00 00 01 01 01 00 18 DD 8D B0 00 00 00 00 49 45 4E 44 AE 42 60 82";
test("#14 drawing sheet polygons and bitmaps are parsed and drawn (bitmap first, pixel = 25.4 / ppi x scale)", () => {
  const wks = L.parseDrawingSheet(`(kicad_wks (version 20231118) (generator pl_editor)
  (setup (textsize 1.5 1.5) (linewidth 0.15) (textlinewidth 0.15) (left_margin 10) (right_margin 10) (top_margin 10) (bottom_margin 10))
  (polygon (name "") (pos 50 50 ltcorner) (linewidth 0) (pts (xy 0 0) (xy 10 0) (xy 10 10)))
  (bitmap (name "") (pos 100 100 ltcorner) (scale 2) (pngdata (data "${PNG_HEX}"))))`);
  const draws = L.buildDrawingSheet([297, 210], {}, wks, true);
  const poly = draws.find((d) => d.t === "poly"), img = draws.find((d) => d.t === "image");
  assert.ok(poly && poly.polys[0].length === 3, "polygon outline");
  assert.ok(img, "bitmap"); near(img.w, 25.4 / 300 * 2, 1e-9, "one pixel at 300 ppi, scale 2");
});
test("#15 tbtext maxlen / maxheight: SetConstrainedTextSize scales X and Y on their own", () => {
  const [sx, sy] = L.constrainedTextSize("WWWWWWWWWWWWWWWWWWWW", 2, 2, false, 10, 0);
  assert.ok(sx < 2 && sy === 2, `${sx} ${sy}`);
  near(L.sheetTextPen(0, 1, true, 2), 0.25, 1e-12, "bold pen is the X size / 5, clamped to min / 4");
});
test("#16 drawing_sheet / page_layout headers, legacy % codes and old overbars", () => {
  assert.strictEqual(L.convertLegacyVariableRefs("Rev %R %C0 %%"), "Rev ${REVISION} ${COMMENT1} %");
  assert.strictEqual(L.convertToNewOverbarNotation("~RESET~ x"), "~{RESET} x");
  assert.strictEqual(L.convertToNewOverbarNotation("a~~b"), "a~b");
  const legacy = L.parseDrawingSheet(`(page_layout (setup (textsize 1.5 1.5)) (tbtext "%T ~CS~" (name "") (pos 10 10)))`);
  const t = legacy.items.find((i) => i.kind === "tbtext"); assert.strictEqual(t.text, "${TITLE} ~{CS}");
  const modern = L.parseDrawingSheet(`(drawing_sheet (version 20231118) (setup (textsize 1.5 1.5)) (tbtext "~X~" (name "") (pos 10 10)))`);
  assert.strictEqual(modern.items.find((i) => i.kind === "tbtext").text, "~X~", "no overbar conversion from 20210606 on");
});

// #17
test("#17 message panel: ellipse and elliptical arc rows (EDA_SHAPE::ShapeGetMsgPanelInfo)", () => {
  near(L.ellipseLength(L.parse("(gr_ellipse (center 0 0) (major_radius 2) (minor_radius 2))")), 4 * Math.PI, 1e-9, "a circle");
  near(L.ellipseLength(L.parse("(gr_ellipse_arc (center 0 0) (major_radius 3) (minor_radius 3) (start_angle 0) (end_angle 90))")), 1.5 * Math.PI, 1e-7, "a quarter circle");
  const doc = BOARD(`(gr_ellipse_arc (center 10 10) (major_radius 4) (minor_radius 2) (rotation_angle 30) (start_angle 0) (end_angle 90) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "e1"))`);
  const rows = P.msgPanelInfo(doc, ["e1"], { units: "mm" });
  const val = (t) => (rows.find((r) => r.title === t) || {}).value;
  assert.strictEqual(val("Shape"), "Elliptical Arc");
  for (const t of ["Length", "Major Radius", "Minor Radius", "Rotation", "Start Angle", "End Angle"]) assert.ok(val(t) !== undefined, t);
  assert.strictEqual(val("Rotation"), "30.0°"); assert.strictEqual(val("End Angle"), "90.0°");
  const sd = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "r") (paper "A4")
  (ellipse (center 10 10) (major_radius 4) (minor_radius 2) (rotation_angle 0) (stroke (width 0) (type default)) (fill (type none)) (uuid "e2")))`);
  const sr = sch.msgPanelInfo(sd, { id: "e2" }, { units: "mm" });
  assert.deepStrictEqual(sr.map((r) => r.title).slice(0, 5), ["Shape", "Length", "Major Radius", "Minor Radius", "Rotation"]);
});

// #18, #21, #22
test("#18 UnescapeString: tokens, {brace}, a {…} after $ ~ ^ _ stays a group", () => {
  assert.strictEqual(L.unescapeText("a{slash}b{colon}{dblquote}"), "a/b:\"");
  assert.strictEqual(L.unescapeText("{brace}x"), "{x");
  assert.strictEqual(L.unescapeText("~{A{slash}B}"), "~{A/B}");
  assert.strictEqual(L.unescapeText("{unknown}"), "{unknown}");
});
test("#21 word wrap keeps a markup run whole", () => {
  const out = L.linebreakText("~{CHIP SELECT} pin and more words here", 6, 1, 0.125);
  assert.ok(out.split("\n").some((l) => l.includes("~{CHIP SELECT}")), out);
});
test("#22 markup parser: {identifier} inside a group does not close it", () => {
  const root = L.parseStrokeMarkup("_{a{b}c}");
  const sub = root.children.find((c) => c.kind === "_");
  assert.ok(sub, "a subscript group");
  const text = (n) => n.text + n.children.map(text).join("");
  assert.strictEqual(text(sub), "a{b}c");
});

// #20
test("#20 text pens: bold is the text width / 5, a stored thickness x1.6 when bold, clamped to min(w, h) / 4", () => {
  near(L.textPen({ sizeX: 2, thick: 0, bold: true }, 1), 0.25, 1e-12);
  near(L.layoutPen({ sizeX: 2, thick: 0, bold: false }, 2), 0.25, 1e-12, "normal: width / 8");
  near(L.layoutPen({ sizeX: 1, thick: 0.1, bold: true }, 1), 0.16, 1e-12, "BOLD_STROKE_MULTIPLIER");
  near(L.layoutPen({ sizeX: 0.4, thick: 0.3, bold: false }, 1), 0.1, 1e-12, "ClampTextPenSize");
});

// #19, #23 — the renderer and the undo list
test("#19 dashed strokes: round caps on every primitive, rectangle sides dashed one by one", () => {
  const src = fs.readFileSync(path.join(web, "domains", "pcb", "canvas", "render.ts"), "utf8");
  assert.ok(/setCap\(g\.dash \? "round"/.test(src), "round cap whenever dashed");
  assert.ok(/SH_RECT: one SHAPE_SEGMENT per side/.test(src), "per-side rectangle");
  assert.ok(/g\.dash && t === "poly" && g\.dashBreaks/.test(src), "a polygon with dash breaks restarts the pattern there");
});
test("#23 the undo list is not trimmed and an empty undo / redo is silent", () => {
  const tools = fs.readFileSync(path.join(web, "domains", "pcb", "editor", "tools.ts"), "utf8");
  const sync = fs.readFileSync(path.join(web, "shared", "itemdoc", "sync.ts"), "utf8");
  assert.ok(!/undoStack\.length > 200/.test(tools) && !/undoStack\.length > 200/.test(sync), "no 200-step cap");
  assert.ok(!/Nothing to undo|Nothing to redo/.test(tools), "no toast");
});

console.log(`common-core: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
