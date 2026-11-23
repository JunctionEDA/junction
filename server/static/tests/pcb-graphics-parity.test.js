// Node test for the board graphic items against KiCad: GRAPHIC_EDIT_TOOL's Extend Line or Arc and Trim Shape
// (graphic_extend.cpp, graphic_trim.cpp), and the other round-two drawing / dialog items of the board graphics package.
// Run: node server/static/tests/pcb-graphics-parity.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { webPath } = require("./web-path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;
const src = (rel) => fs.readFileSync(webPath(rel), "utf8");

const board = (body) => K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user))
  ${body})`, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select", shown: [], selection: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: false, selected: null, items: [], viewOnly: false, live: true,
    selection: new Set(), cursor: null, activeLayer: "F.SilkS",
    snap: (mm) => mm.slice(), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(list) { log.selection = Array.from(list); ctx.selection = new Set(list); },
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
    showLayer(l) { log.shown.push(l); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: true, clientX: 0, clientY: 0 }, extra || {});   // Shift: no object snapping
const xy = (n, k) => K.kid(n, k).slice(1, 3).map(Number);
const line = (id, a, b, extra = "") => `(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.1) (type default)) ${extra} (layer "F.SilkS") (uuid "${id}"))`;

// ---------------------------------------------------------------- Extend / Trim
test("Extend Line or Arc: the end nearest the pointer grows to the first shape on its ray, one 'Extend Line or Arc' step", () => {
  const doc = board(line("l1", [0, 0], [10, 0]) + line("w1", [20, -5], [20, 5]) + line("w2", [30, -5], [30, 5]));
  const { ctx, log } = fakeCtx(doc);
  ctx.setSelection(["w1"]);
  pcb.runAction("extendGraphic", ctx);
  assert.equal(log.tool, "extendgraphic"); assert.deepEqual(log.selection, [], "the selection is cleared as the tool starts");
  pcb.onPointerMove(ev(), [9, 0], ctx);
  assert.deepEqual(pcb.brightenedIds().sort(), ["l1", "w1"], "the source and the boundary it reaches are brightened");
  pcb.onPointerDown(ev(), [9, 0], ctx);
  assert.equal(log.commits.at(-1).label, "Extend Line or Arc");
  assert.deepEqual(xy(doc.items.get("l1").node, "end"), [20, 0]);
  assert.deepEqual(xy(doc.items.get("l1").node, "start"), [0, 0]);
  // the start end: nothing lies behind it
  pcb.onPointerDown(ev(), [1, 0], ctx);
  assert.equal(log.toasts.at(-1), "There is nothing to reach in that direction.");
});

test("Extend: an arc grows round its circle to the nearest crossing; reaching nothing it closes into a circle", () => {
  // the arc from (10, 0) through (0, 10)... to (-10, 0) on the circle of radius 10 round (0, 0)
  const doc = board(`(gr_arc (start 10 0) (mid 0 10) (end -10 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "a1"))`
    + line("w1", [-5, -20], [-5, -5]));
  const { ctx, log } = fakeCtx(doc);
  const g = P.graphicEdit;
  ctx.setTool("extendgraphic");
  pcb.onPointerDown(ev(), [-9.9, 0.5], ctx);
  assert.equal(log.commits.at(-1).label, "Extend Line or Arc");
  let n = doc.items.get("a1").node; assert.equal(n[0], "gr_arc");
  const pts = ["start", "end"].map((k) => xy(n, k));
  assert.ok(pts.some((p) => Math.abs(p[0] + 5) < 1e-3 && Math.abs(p[1] + Math.sqrt(75)) < 1e-3), "the arc now ends where the line crosses its circle: " + JSON.stringify(pts));
  // a lone arc closes all the way round
  const doc2 = board(`(gr_arc (start 10 0) (mid 0 10) (end -10 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "a2"))`);
  const c2 = fakeCtx(doc2); c2.ctx.setTool("extendgraphic"); pcb.onPointerDown(ev(), [9.9, 0.5], c2.ctx);
  n = doc2.items.get("a2").node; assert.equal(n[0], "gr_circle"); assert.deepEqual(xy(n, "center"), [0, 0]); assert.deepEqual(xy(n, "end"), [10, 0]);
  assert.equal(K.str(K.kid(n, "fill")[1]), "no", "a circle is written with its fill");
  assert.ok(g.planExtend && g.planTrim);
});

test("Trim Shape: the span under the pointer between the nearest crossings goes; the rest stays as two lines", () => {
  const doc = board(line("l1", [0, 0], [30, 0]) + line("v1", [10, -5], [10, 5]) + line("v2", [20, -5], [20, 5]));
  const { ctx, log } = fakeCtx(doc);
  pcb.runAction("trimGraphic", ctx); assert.equal(log.tool, "trimgraphic");
  pcb.onPointerDown(ev(), [15, 0.05], ctx);
  const c = log.commits.at(-1); assert.equal(c.label, "Trim Shape");
  assert.deepEqual([xy(doc.items.get("l1").node, "start"), xy(doc.items.get("l1").node, "end")], [[0, 0], [10, 0]]);
  const added = c.changes.find((x) => x.kind === "ADDED"); assert.ok(added, "the second piece is a new line");
  const piece = doc.items.get(added.id).node; assert.deepEqual([xy(piece, "start"), xy(piece, "end")], [[20, 0], [30, 0]]);
  assert.notEqual(K.str(K.kid(piece, "uuid")[1]), "l1");
  // an end span: the line keeps only the part on the other side of the crossing
  pcb.onPointerDown(ev(), [2, 0.05], ctx);
  assert.equal(doc.items.has("l1"), false, "a span bounded by the shape's own end and one crossing removes the whole remaining piece");
});

test("Trim: a circle cut twice keeps the far side as one arc; a rectangle keeps its three other sides as lines", () => {
  const doc = board(`(gr_circle (center 0 0) (end 10 0) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "c1"))` + line("x1", [-20, 0], [20, 0]));
  const { ctx, log } = fakeCtx(doc);
  ctx.setTool("trimgraphic"); pcb.onPointerDown(ev(), [0, 9.95], ctx);
  assert.equal(log.commits.at(-1).label, "Trim Shape");
  const n = doc.items.get("c1").node; assert.equal(n[0], "gr_arc", "the circle opened up into an arc");
  assert.ok(Math.abs(xy(n, "mid")[1] + 10) < 1e-3, "the arc kept is the half away from the pointer");
  assert.equal(K.kid(n, "fill"), null, "an arc has no fill");
  const doc2 = board(`(gr_rect (start 0 0) (end 10 10) (stroke (width 0.1) (type default)) (fill yes) (layer "F.SilkS") (uuid "r1"))` + line("x1", [5, -5], [5, 5]));
  const c2 = fakeCtx(doc2); c2.ctx.setTool("trimgraphic"); pcb.onPointerDown(ev(), [2, 0.05], c2.ctx);
  const ch = c2.log.commits.at(-1).changes;
  assert.equal(doc2.items.get("r1").node[0], "gr_line"); assert.equal(K.kid(doc2.items.get("r1").node, "fill"), null);
  assert.deepEqual([xy(doc2.items.get("r1").node, "start"), xy(doc2.items.get("r1").node, "end")], [[5, 0], [10, 0]]);
  assert.equal(ch.filter((x) => x.kind === "ADDED").length, 3, "the three untouched sides become lines");
});

test("Trim / Extend refusals use KiCad's infobar texts: locked, nothing crossing, a shared run", () => {
  const doc = board(line("l1", [0, 0], [30, 0], "(locked yes)") + line("l2", [0, 10], [30, 10]) + line("l3", [0, 20], [30, 20]) + line("l4", [20, 20], [40, 20]));
  const { ctx, log } = fakeCtx(doc);
  ctx.setTool("trimgraphic");
  pcb.onPointerDown(ev(), [15, 0.05], ctx); assert.equal(log.toasts.at(-1), "That shape is locked.");
  pcb.onPointerDown(ev(), [15, 10.05], ctx); assert.equal(log.toasts.at(-1), "Nothing crosses the shape here.");
  pcb.onPointerDown(ev(), [5, 20.05], ctx); assert.equal(log.toasts.at(-1), "More than one shape meets this one here.");
  assert.equal(log.commits.length, 0);
});

test("Extend and Trim are in the Edit menus of both editors and run as tools", () => {
  const t = src("tables.ts"); assert.ok(/"extendGraphic", "trimGraphic"/.test(t));
  const A = pcb.actions; assert.equal(A.extendGraphic.label, "Extend Line or Arc"); assert.equal(A.trimGraphic.label, "Trim Shape");
  assert.equal(A.extendGraphic.tip, "Hover a graphical line or arc to extend it until it meets another");
});

// ---------------------------------------------------------------- DRAWING_TOOL details
test("SetStroke: Shape Properties' OK on a shape on the active layer gives the running drawing tool that stroke; a new layer or tool resets it", () => {
  const doc = board(""); const { ctx, log } = fakeCtx(doc);
  P.state.gfxLayer = "F.SilkS";
  ctx.setTool("gline");
  pcb.setStroke(0.5, "dash", "F.SilkS");
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [5, 0], ctx);
  const n = doc.items.get(log.commits.at(-1).changes[0].id).node, st = K.kid(n, "stroke");
  assert.equal(Number(K.kid(st, "width")[1]), 0.5); assert.equal(K.str(K.kid(st, "type")[1]), "dash");
  pcb.cancel();
  pcb.setLayer(ctx, "Edge.Cuts"); assert.equal(P.state.strokeW, null, "layerChanged: the new layer's default"); assert.equal(P.state.strokeStyle, null);
  pcb.setLayer(ctx, "F.SilkS"); pcb.setStroke(0.4, "solid", "F.SilkS"); ctx.setTool("grect"); assert.equal(P.state.strokeW, null, "Reset( RUN ): a tool starting takes the layer default");
  const s = src("editor/pcbdialogs/item-props.ts");
  assert.ok(s.includes("M.pcb.setStroke(w, style.get(), act)"), "the shape dialog hands its stroke over when the shape is on the active layer");
});

test("Drawing a zone, thieving zone or rule area turns the Zones object visibility on (SetObjectVisible( LAYER_ZONES ))", () => {
  const doc = board(""); const { ctx } = fakeCtx(doc); const shown = [];
  ctx.showObject = (id) => shown.push(id);
  for (const t of ["zone", "rulearea"]) ctx.setTool(t);
  ctx.setTool("gline");
  assert.deepEqual(shown, ["zones", "zones"]);
  assert.ok(src("editor/tools.ts").includes('appearanceDispatch({ t: "objVisible", id, on: true })'));
});

// ---------------------------------------------------------------- text dialogs (DIALOG_TEXT(BOX)_PROPERTIES, DIALOG_DIMENSION_PROPERTIES)
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
test("Text box Knockout: read from (knockout yes) and always written after the stroke (FormatBool)", () => {
  globalThis.window = globalThis.window || globalThis;
  const TB = load("editor/pcbdialogs/textbox.ts");
  const doc = board(`(gr_text_box "Hi" (start 0 0) (end 10 5) (margins 0.5 0.5 0.5 0.5) (layer "F.SilkS") (uuid "tb1")
    (effects (font (size 1 1) (thickness 0.15))) (border yes) (stroke (width 0.1) (type solid)) (knockout yes))`);
  const n = doc.items.get("tb1").node, v0 = TB.textBoxValues(n);
  assert.equal(v0.knockout, true);
  const out = TB.applyTextBox(n, { ...v0, knockout: false }, v0).node;
  assert.equal(K.str(K.kid(out, "knockout")[1]), "no");
  assert.ok(out.indexOf(K.kid(out, "knockout")) > out.indexOf(K.kid(out, "stroke")), "after the stroke");
  const plain = board(`(gr_text_box "Hi" (start 0 0) (end 10 5) (layer "F.SilkS") (uuid "tb2") (effects (font (size 1 1))) (border no) (stroke (width 0.1) (type solid)))`).items.get("tb2").node;
  const w0 = TB.textBoxValues(plain); assert.equal(w0.knockout, false);
  assert.equal(K.str(K.kid(TB.applyTextBox(plain, w0, w0).node, "knockout")[1]), "no", "KiCad writes (knockout no) too");
  const s = src("editor/pcbdialogs/textbox.ts");
  assert.ok(s.includes('kiconToggle("link", "Adjust the text thickness"'), "the auto thickness is the link button");
  assert.ok(s.includes('checkField(v0.knockout, "Knockout"'));
  assert.ok(/for \(const e of \[thickLabel, thick\.el, thickUnits\]\)/.test(s), "onFontSelected hides the thickness, not the link");
});
test("Dimension Properties: link button hidden with the thickness on an outline font; Driven value shows GetValueText(); missing layer message", () => {
  const s = src("editor/pcbdialogs/dimension.ts");
  assert.ok(s.includes('kiconToggle("link", "Adjust the text thickness"'));
  assert.ok(/for \(const e of \[thickLabel, thick\.el, thickUnits, auto\.el\]\)/.test(s), "m_autoTextThickness->Show( stroke )");
  assert.ok(s.includes('(fields.value as Field<string>).set(ownValue)'), "valueFieldTracksMeasurement: the item's own value text");
  assert.ok(s.includes('messageBox("Message", "This item was on a non-existing layer.\\nIt has been moved to the first defined layer.")'));
  const ip = src("editor/pcbdialogs/item-props.ts");
  assert.ok(!/\n  strokeOnly\(face0\);/.test(ip), "DIALOG_TEXT_PROPERTIES hides the thickness on a font choice only, not when it opens");
});

// ---------------------------------------------------------------- Mirror Interactive on reference images
test("Mirror Interactive mirrors a reference image: centre reflected, orientation reflected, pixels flipped top / bottom", async () => {
  const doc = board(`(image (at 10 5) (layer "F.SilkS") (data "AAAA" "BBBB") (uuid "im1"))` + line("l1", [0, 0], [4, 0]));
  P.setPcbImageFlipImpl(async (b64) => "TB:" + b64);
  const flipped = await P.flippedImagesOf(doc, ["im1", "l1"]);
  assert.deepEqual(Array.from(flipped), [["im1", "TB:AAAABBBB"]]);
  // axis x = 0 (vertical): axisAngle = -90, orientation 0 -> 2 * -90 - 0 = -180 -> 180
  const r = P.mirrorAxisChanges(doc, ["im1"], [0, 0], [0, 10], () => null, () => [], flipped);
  assert.equal(r.skips.items, 0);
  const n = r.changes[0].node || doc.items.get("im1").node;
  for (const c of r.changes) K.applyChange(doc, c, IU);
  const m = doc.items.get("im1").node;
  assert.deepEqual(xy(m, "at"), [-10, 5]);
  assert.equal(Number(K.kid(m, "rotate")[1]), 180);
  assert.equal(K.kid(m, "data").slice(1).join(""), "TB:AAAABBBB");
  assert.ok(n);
  const none = P.mirrorAxisChanges(board(`(image (at 1 1) (layer "F.SilkS") (data "AAAA") (uuid "im2"))`), ["im2"], [0, 0], [0, 10], () => null, () => []);
  assert.equal(none.skips.items, 1, "a picture that could not be decoded is still skipped");
  P.setPcbImageFlipImpl(null);
});

// ---------------------------------------------------------------- Properties (E) while drawing
test("E while drawing: Shape Properties edits the line being drawn, which keeps its layer and stroke when the end is placed", () => {
  const doc = board(""); const { ctx, log } = fakeCtx(doc); const seen = [];
  pcb.setNewItemDialogs({ shape: (c, node, done) => { seen.push(K.serialize(node)); const n = K.cloneNode(node); K.kid(n, "layer")[1] = "Edge.Cuts"; K.kid(K.kid(n, "stroke"), "width")[1] = 0.7; K.kid(n, "start")[1] = 1; done(n); return true; } });
  P.state.gfxLayer = "F.SilkS"; ctx.setTool("gline");
  assert.equal(pcb.draftProperties(ctx), false, "nothing started: EDIT_TOOL::Properties takes it");
  pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.equal(pcb.draftProperties(ctx), true);
  assert.ok(/gr_line/.test(seen[0]));
  pcb.onPointerDown(ev(), [5, 0], ctx);
  const n = doc.items.get(log.commits.at(-1).changes[0].id).node;
  assert.equal(K.str(K.kid(n, "layer")[1]), "Edge.Cuts"); assert.equal(Number(K.kid(K.kid(n, "stroke"), "width")[1]), 0.7);
  assert.deepEqual(xy(n, "start"), [1, 0], "the start the dialog set"); assert.deepEqual(xy(n, "end"), [5, 0], "the clicked end");
  pcb.cancel();
});
test("E while drawing a zone opens its properties; while drawing a dimension it opens Dimension Properties, then the draft is dropped and the tool ends", () => {
  const doc = board(""); const { ctx, log } = fakeCtx(doc); let zoneCalls = 0, dimCalls = 0;
  pcb.setNewItemDialogs({
    zone: (c, node, done) => { zoneCalls++; const n = K.cloneNode(node); if (zoneCalls === 2) { const nm = K.kid(n, "name"); if (nm) nm[1] = "EDITED"; else n.splice(1, 0, ["name", "EDITED"]); } done(n); return true; },
    dimension: (c, node, done) => { dimCalls++; assert.equal(node[0], "dimension"); done(node); return true; },
  });
  ctx.activeLayer = "F.Cu"; P.state.layer = "F.Cu";
  ctx.setTool("zone"); pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.equal(zoneCalls, 1, "createNewZone's dialog");
  assert.equal(pcb.draftProperties(ctx), true); assert.equal(zoneCalls, 2);
  assert.equal(K.str(K.kid(P.state.draw.template, "name")[1]), "EDITED");
  pcb.cancel();
  ctx.setTool("dimaligned"); pcb.onPointerDown(ev(), [0, 0], ctx);
  const before = log.commits.length;
  assert.equal(pcb.draftProperties(ctx), true); assert.equal(dimCalls, 1);
  assert.equal(P.state.draw, null); assert.equal(log.tool, "select"); assert.equal(log.commits.length, before, "nothing is added");
  pcb.setNewItemDialogs({ shape: undefined, zone: undefined, dimension: undefined });
});
test("E on the carried footprint opens Footprint Properties on it (library.ts), without the library buttons", () => {
  const s = src("editor/library.ts");
  assert.ok(s.includes("carriedFootprintDialog(ctxNow(), (K().cloneNode as (n: SNode) => SNode)(c.node)"));
  const ip = src("editor/pcbdialogs/item-props.ts");
  assert.ok(ip.includes("...(create ? [] : [fpButtons(ctx, item, body)])"));
  assert.ok(src("editor/pointer.ts").includes("CollabTools.pcb.draftProperties(ctx)"));
});

// ---------------------------------------------------------------- point editor: reference images
test("Reference image handles: corners scale about the transform origin (1 mm minimum), the origin moves, the top handle rotates", () => {
  const b = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  b.writeUInt32BE(300, 16); b.writeUInt32BE(150, 20);   // 300 x 150 px at 300 ppi: 25.4 x 12.7 mm
  const doc = board(`(image (at 10 10) (layer "F.SilkS") (data "${b.toString("base64")}") (uuid "im1"))`), it = doc.items.get("im1");
  const hs = P.editPoints(it), at = (k) => hs.find((h) => h.key === k).p.map((v) => +v.toFixed(4));
  assert.deepEqual(hs.map((h) => h.key), ["i0", "i1", "i2", "i3", "io", "ir"]);
  assert.deepEqual(at("i0"), [-2.7, 3.65]); assert.deepEqual(at("i2"), [22.7, 16.35]); assert.deepEqual(at("io"), [10, 10]);
  assert.deepEqual(at("ir"), [10, +(10 - 12.7 * 0.7).toFixed(4)], "70 % of the height above the origin");
  // the bottom right corner dragged to double the arm: the scale doubles about the centre
  let n = P.editPointNode(it.node, "image", "i2", [35.4, 22.7], null, null);
  assert.equal(Number(K.kid(n, "scale")[1]), 2); assert.deepEqual(xy(n, "at"), [10, 10]);
  // crossing the origin collapses the arm; the clamp takes min( 1 mm / width, 1 mm / height ) as KiCad does
  n = P.editPointNode(it.node, "image", "i2", [5, 5], null, null);
  assert.equal(+Number(K.kid(n, "scale")[1]).toFixed(4), +(1 / 25.4).toFixed(4));
  // the rotation handle dragged to the right of the origin: a quarter turn clockwise (-90)
  n = P.editPointNode(it.node, "image", "ir", [20, 10], null, null);
  assert.equal(Number(K.kid(n, "rotate")[1]), 270);
  // the transform origin moved: a later scale pins it instead of the centre
  n = P.editPointNode(it.node, "image", "io", [0, 0], null, null);
  const n2 = P.editPointNode(it.node, "image", "i2", [45.4, 32.7], null, null);   // (22.7, 16.35) is (12.7, 6.35) from the old origin... from (0, 0) it is twice as far
  assert.equal(+Number(K.kid(n2, "scale")[1]).toFixed(3), +(Math.hypot(45.4, 32.7) / Math.hypot(22.7, 16.35)).toFixed(3));
  assert.deepEqual(xy(n2, "at").map((v) => +v.toFixed(3)), [20, 20], "the centre scales away from the pinned origin");
});
test("A group of shapes gets box handles: the centre moves it, a corner scales the shapes and their widths about the old centre; other groups get none", () => {
  const doc = board(line("a", [0, 0], [10, 0]) + line("b", [0, 10], [10, 10]) + `(group "" (uuid "g1") (members "a" "b"))`
    + `(gr_text "T" (at 50 50) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.1))))` + line("c", [40, 40], [45, 40]) + `(group "" (uuid "g2") (members "c" "t1"))`);
  fakeCtx(doc);
  const g = doc.items.get("g1"), hs = P.editPoints(g);
  assert.deepEqual(hs.map((h) => h.key), ["g0", "g1", "g2", "g3", "gc"]);
  const box = P.groupShapesBox(P.groupShapeItems(doc, g));
  assert.deepEqual(box.map((v) => +v.toFixed(3)), [-0.05, -0.05, 10.05, 10.05], "GetBoundingBox grows by half the width");
  assert.equal(P.groupShapeItems(doc, doc.items.get("g2")), null, "a text member rejects the group");
  assert.deepEqual(P.editPoints(doc.items.get("g2")), []);
  const origs = new Map([["a", doc.items.get("a").node], ["b", doc.items.get("b").node]]);
  let out = P.groupEditNodes(origs, box, "gc", [7, 5]);
  assert.deepEqual(xy(out.get("a"), "start"), [2, 0]);
  out = P.groupEditNodes(origs, box, "g2", [20.15, 20.15]);   // the box twice as wide and high
  assert.deepEqual(xy(out.get("a"), "start").map((v) => +v.toFixed(4)), [-5, -5]); assert.deepEqual(xy(out.get("b"), "end").map((v) => +v.toFixed(4)), [15, 15]);
  assert.equal(Number(K.kid(K.kid(out.get("a"), "stroke"), "width")[1]), 0.2);
  out = P.groupEditNodes(origs, box, "g2", [-50, -50]);
  assert.equal(+Number(K.kid(K.kid(out.get("a"), "stroke"), "width")[1]).toFixed(6), 0.001, "MIN_SCALE 0.01");
});
test("Footprint editor pads get handles: a round pad's radius, a rectangle's corners (centred, or sized around the hole)", () => {
  const doc = K.parseDoc(`(footprint "X" (version 20241229) (generator "pcbnew") (layer "F.Cu")
    (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu" "F.Mask") (uuid "p1"))
    (pad "2" thru_hole rect (at 10 0) (size 2 2) (drill 1) (layers "*.Cu") (uuid "p2"))
    (pad "3" thru_hole circle (at 20 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu") (uuid "p3"))
    (pad "4" smd rect (at 30 0 45) (size 1 1) (layers "F.Cu") (uuid "p4")))`, "footprint");
  doc.fpEditor = true; const { ctx } = fakeCtx(doc); ctx.activeLayer = "F.Cu"; pcb.onDocChanged(ctx);
  const pad = (u) => [...doc.items.values()].find((i) => i.kind === "pad" && K.str(K.kid(i.node, "uuid")[1]) === u);
  assert.deepEqual(P.editPoints(pad("p1")).map((h) => h.p), [[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]]);
  assert.deepEqual(P.editPoints(pad("p3")).map((h) => h.p), [[20.75, 0]]);
  assert.deepEqual(P.editPoints(pad("p4")), [], "not at a cardinal angle");
  let n = P.editPointNode(pad("p1").node, "pad", "p2", [2, 1], null, null);
  assert.deepEqual(K.kid(n, "size").slice(1).map(Number), [3, 1.5]); assert.deepEqual(xy(n, "at"), [0.5, 0.25], "centred in the new shape");
  n = P.editPointNode(pad("p2").node, "pad", "p2", [12, 2], null, null);
  assert.deepEqual(K.kid(n, "size").slice(1).map(Number), [3, 3]); assert.deepEqual(xy(n, "at"), [10, 0], "the hole stays");
  assert.deepEqual(K.kid(K.kid(n, "drill"), "offset").slice(1).map(Number), [0.5, 0.5]);
  n = P.editPointNode(pad("p3").node, "pad", "p0", [21, 0], null, null);
  assert.deepEqual(K.kid(n, "size").slice(1).map(Number), [2, 2]);
  doc.fpEditor = false; assert.deepEqual(P.editPoints(pad("p1")), [], "board editor: no pad handles");
});

// ---------------------------------------------------------------- Convert tool (CONVERT_TOOL)
const resetConvert = () => Object.assign(pcb.convertSettings, { strategy: "centerline", gap: 0, lineWidth: 0, deleteOriginals: true });
const added = (c) => c.changes.filter((x) => x.kind === "ADDED").map((x) => K.parseDoc(x.sexpr, "kicad_pcb").items.values().next().value.node);
const removed = (c) => c.changes.filter((x) => x.kind === "REMOVED").map((x) => x.id);

test("Create Polygon from Selection: the Conversion Settings dialog first; chained lines become one filled polygon on the active layer ('Convert to Polygon')", () => {
  resetConvert();
  const doc = board(line("a", [0, 0], [10, 0]) + line("b", [10, 0], [10, 10]) + line("c", [10, 10], [0, 0]));
  const { ctx, log } = fakeCtx(doc); let shown = null;
  pcb.setConvertDialogs({ settings: (show, s, done) => { shown = show; done(true); } });
  ctx.setSelection(["a", "b", "c"]);
  pcb.runAction("convertToPoly", ctx);
  assert.deepEqual(shown, { copy: true, centerline: true, hull: true });
  const c = log.commits.at(-1); assert.equal(c.label, "Convert to Polygon");
  const [n] = added(c); assert.equal(n[0], "gr_poly"); assert.equal(K.kid(n, "layer")[1], "F.SilkS"); assert.equal(K.kid(n, "fill")[1], "yes");
  assert.equal(K.ptsOf(n).length, 3); assert.equal(removed(c).length, 3, "the sources are deleted");
  // keep the sources: 'Create Polygon', and the copy strategy takes the first object's line width
  pcb.setConvertDialogs({ settings: (show, s, done) => { s.strategy = "copy"; s.deleteOriginals = false; done(true); } });
  const d2 = board(line("a", [0, 0], [10, 0]) + line("b", [10, 0], [10, 10]) + line("c", [10, 10], [0, 0]));
  const f2 = fakeCtx(d2); f2.ctx.setSelection(["a", "b", "c"]); pcb.runAction("convertToPoly", f2.ctx);
  const c2 = f2.log.commits.at(-1); assert.equal(c2.label, "Create Polygon"); assert.equal(removed(c2).length, 0);
  const p2 = added(c2)[0]; assert.equal(K.kid(p2, "fill")[1], "no"); assert.equal(Number(K.kid(K.kid(p2, "stroke"), "width")[1]), 0.1);
  pcb.setConvertDialogs(null); resetConvert();
});

test("Create Polygon: an open chain is refused with KiCad's error; Cancel changes nothing", () => {
  resetConvert();
  const doc = board(line("a", [0, 0], [10, 0]) + line("b", [10, 0], [10, 10]));
  const { ctx, log } = fakeCtx(doc); const forms = [];
  pcb.setForm((spec) => { forms.push(spec); return true; });
  pcb.setConvertDialogs({ settings: (show, s, done) => done(true) });
  ctx.setSelection(["a", "b"]); pcb.runAction("convertToPoly", ctx);
  assert.equal(log.commits.length, 0);
  assert.equal(forms.at(-1).title, "Error");
  assert.deepEqual(forms.at(-1).fields.map((f) => f.value), ["Could not convert selection", "Objects must form a closed shape"]);
  pcb.setConvertDialogs({ settings: (show, s, done) => { s.strategy = "hull"; done(false); } });
  ctx.setSelection(["a", "b"]); pcb.runAction("convertToPoly", ctx);
  assert.equal(log.commits.length, 0);
  pcb.setConvertDialogs(null); pcb.setForm(() => false); resetConvert();
});

test("Create Polygon, bounding hull: open lines merged and grown by the gap plus half the line width", () => {
  resetConvert();
  const doc = board(line("a", [0, 0], [10, 0]));
  const { ctx, log } = fakeCtx(doc);
  pcb.setConvertDialogs({ settings: (show, s, done) => { s.strategy = "hull"; s.gap = 1; s.lineWidth = 0.2; done(true); } });
  ctx.setSelection(["a"]); pcb.runAction("convertToPoly", ctx);
  const n = added(log.commits.at(-1))[0]; assert.equal(K.kid(n, "fill")[1], "no");
  const ys = K.ptsOf(n).map((p) => p[1]);
  // the line's copper (0.05 each side) grown by 1 + 0.1
  assert.ok(Math.abs(Math.max(...ys) - 1.15) < 0.01 && Math.abs(Math.min(...ys) + 1.15) < 0.01, JSON.stringify([Math.min(...ys), Math.max(...ys)]));
  assert.equal(pcb.convertSettings.gap, 1, "the settings keep what was typed");
  pcb.setConvertDialogs(null); resetConvert();
});

test("A circle converts with centerlines to a polygon of two arc sides on the circle; arc sides of a polygon are kept", () => {
  const doc = board(`(gr_circle (center 5 5) (end 8 5) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "c1"))`
    + `(gr_poly (pts (xy 0 0) (arc (start 10 0) (mid 15 5) (end 10 10)) (xy 0 10)) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "p1"))`);
  const r = pcb.convertPolys([doc.items.get("c1")], "centerline", 0);
  assert.equal(r.outlines.length, 1); const els = r.outlines[0].outline; assert.equal(els.length, 2);
  const on = (p) => Math.abs(Math.hypot(p[0] - 5, p[1] - 5) - 3) < 1e-6;
  assert.ok(els.every((e) => e.arc.every(on)), JSON.stringify(els));
  assert.deepEqual(els[0].arc[0], els[1].arc[2], "closed: the second half ends where the first starts");
  assert.ok(els[0].arc[1][1] < 5 && els[1].arc[1][1] > 5, "through the top and the bottom");
  const p = pcb.convertPolys([doc.items.get("p1")], "centerline", 0).outlines[0].outline;
  assert.deepEqual(p[1], { arc: [[10, 0], [15, 5], [10, 10]] });
});

test("Create Zone from Selection: the zone dialog gets the conversion settings; the zone takes the outline ('Convert to Zone')", () => {
  resetConvert();
  const doc = board(`(gr_rect (start 0 0) (end 10 5) (stroke (width 0.1) (type default)) (fill no) (layer "F.Cu") (uuid "r1"))`);
  const { ctx, log } = fakeCtx(doc); let extra = null;
  ctx.activeLayer = "F.Cu";
  pcb.setNewItemDialogs({ zone: (c, node, done, conv) => { extra = conv; conv.deleteOriginals = false; done(node); return true; } });
  ctx.setSelection(["r1"]); pcb.runAction("convertToZone", ctx);
  assert.equal(extra, pcb.convertSettings);
  const c = log.commits.at(-1); assert.equal(c.label, "Create Zone"); assert.equal(removed(c).length, 0);
  const z = added(c)[0]; assert.equal(z[0], "zone"); assert.equal(K.ptsOf(K.kid(z, "polygon")).length, 4);
  pcb.setNewItemDialogs({ zone: undefined }); resetConvert();
});

test("Create Lines: a rectangle's four sides as lines on the active layer ('Create Lines'); Create Tracks on a non-copper layer asks for a copper layer", () => {
  resetConvert();
  const doc = board(`(gr_rect (start 0 0) (end 10 5) (stroke (width 0.2) (type default)) (fill no) (layer "F.SilkS") (uuid "r1"))`);
  const { ctx, log } = fakeCtx(doc); let shown = null;
  pcb.setConvertDialogs({ settings: (show, s, done) => { shown = show; done(true); } });
  ctx.setSelection(["r1"]); pcb.runAction("convertToLines", ctx);
  assert.deepEqual(shown, { copy: false, centerline: false, hull: false });
  const c = log.commits.at(-1); assert.equal(c.label, "Create Lines");
  const ls = added(c); assert.equal(ls.length, 4); assert.ok(ls.every((n) => n[0] === "gr_line"));
  const d2 = board(`(gr_rect (start 0 0) (end 10 5) (stroke (width 0.2) (type default)) (fill no) (layer "F.SilkS") (uuid "r2"))`);
  const f2 = fakeCtx(d2); let asked = null;
  pcb.setLayerPicker((o, done) => { asked = o; done("B.Cu"); });
  f2.ctx.setSelection(["r2"]); pcb.runAction("convertToTracks", f2.ctx);
  assert.ok(asked && asked.layers.includes("F.Cu"));
  const ts = added(f2.log.commits.at(-1)); assert.equal(ts.length, 4); assert.ok(ts.every((n) => n[0] === "segment" && K.kid(n, "layer")[1] === "B.Cu"));
  pcb.setLayerPicker(null); pcb.setConvertDialogs(null); resetConvert();
});

test("Conversion Settings dialog and the zone dialogs' conversion box follow KiCad's layout and titles", () => {
  const s = src("domains/pcb/editor/pcbdialogs/convert.ts"), ip = src("domains/pcb/editor/pcbdialogs/item-props.ts"), ix = src("domains/pcb/editor/pcbdialogs/index.ts");
  for (const t of ["Conversion Settings", "Copy line width of first object", "Use centerlines", "Create bounding hull", "Gap:", "Line width:", "Delete source objects after conversion"]) assert.ok(s.includes(t), t);
  for (const t of ["Convert to Copper Zone", "Convert to Rule Area", "Convert to Non Copper Zone"]) assert.ok(ip.includes(t), t);
  assert.ok(/setConvertDialogs/.test(ix));
});
