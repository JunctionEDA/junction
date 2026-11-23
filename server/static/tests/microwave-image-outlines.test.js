// Node test for KiCad parity round 3 (microwave-image-outlines): the potrace port (thirdparty/potrace), Convert Image
// to Outlines (common/bitmap_tracing.cpp, DRAWING_TOOL / SCH_EDIT_TOOL::ConvertImageToOutlines and their context
// menu rows) and the microwave tools (pcbnew/microwave: gaps, stubs, arc stubs, polygonal shapes, inductor lines).
// Run: node server/static/tests/microwave-image-outlines.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (...p) => { const out = esbuild.buildSync({ entryPoints: [webPath(...p)], bundle: true, format: "cjs", write: false, logLevel: "silent" }); const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require); return mod.exports; };

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb, MW = P.microwave;
const PT = load("domains", "pcb", "tools", "potrace.ts");
const BT = load("domains", "pcb", "tools", "bitmap-tracing.ts");

// ---------------------------------------------------------------- potrace
// KiCad's own potrace (thirdparty/potrace, built with g++) on these bitmaps, turdsize 0, opttolerance 0.2: each path's
// area, sign and curve (tag, then c[0..2]).
const REF = {"ring":{"w":20,"h":14,"rows":["00000000000000000000","00000000000000000000","00111111111111110100","00111111111111110010","00111111111111110100","00111100000011110000","00111100110011110000","00111100110011110000","00111100000011110000","00111111111111110000","00111111111111110000","00111111111111110000","00000000000000000000","00000000000000000000"],"paths":[{"area":140,"sign":"+","n":4,"seg":[[2,0.0,0.0,2.0,2.0,9.0,2.0],[2,0.0,0.0,16.0,2.0,16.0,7.0],[2,0.0,0.0,16.0,12.0,9.0,12.0],[2,0.0,0.0,2.0,12.0,2.0,7.0]]},{"area":24,"sign":"-","n":4,"seg":[[1,12.0,5.44444444,11.3333333,5.0,9.0,5.0],[1,6.66666667,5.0,6.0,5.44444444,6.0,7.0],[1,6.0,8.55555556,6.66666667,9.0,9.0,9.0],[1,11.3333333,9.0,12.0,8.55555556,12.0,7.0]]},{"area":3,"sign":"+","n":3,"seg":[[1,17.3333333,2.74318244,17.7156737,2.32427667,18.1829786,2.61308697],[1,18.6502834,2.90189727,18.7737258,3.55710237,18.4572949,4.0690983],[1,17.6486704,5.37748015,17.3333333,5.23015612,17.3333333,3.54398867]]},{"area":4,"sign":"+","n":4,"seg":[[1,8.0,6.45,8.45,6.0,9.0,6.0],[1,9.55,6.0,10.0,6.45,10.0,7.0],[1,10.0,7.55,9.55,8.0,9.0,8.0],[1,8.45,8.0,8.0,7.55,8.0,7.0]]}]},"disc":{"w":24,"h":24,"rows":["000000000000000000000000","000000000000000000000000","000000000000000000000000","000000000111111000000000","000000011111111110000000","000000111111111111000000","000001111111111111100000","000011111111111111110000","000011111111111111110000","000111111111111111111000","000111111111111111111000","000111111111111111111000","000111111111111111111000","000111111111111111111000","000111111111111111111000","000011111111111111110000","000011111111111111110000","000001111111111111100000","000000111111111111000000","000000011111111110000000","000000000111111000000000","000000000000000000000000","000000000000000000000000","000000000000000000000000"],"paths":[{"area":256,"sign":"+","n":5,"seg":[[1,3.92808005,16.0819262,3.0,14.1524966,3.0,12.0],[1,3.0,7.69809322,7.69809322,3.0,12.0,3.0],[1,16.3019068,3.0,21.0,7.69809322,21.0,12.0],[1,21.0,16.3019068,16.3019068,21.0,12.0,21.0],[1,9.84750337,21.0,7.9180738,20.0719199,5.92307692,18.0769231]]}]}};
function bitmapOf(r) { const bm = PT.bmNew(r.w, r.h); r.rows.forEach((row, y) => { for (let x = 0; x < r.w; x++) PT.bmPut(bm, x, y, row[x] === "1"); }); return bm; }
test("potrace: the decomposition, the path tree order and the fitted curves match KiCad's potrace", () => {
  for (const [name, r] of Object.entries(REF)) {
    const prm = PT.potraceParamDefault(); prm.turdsize = 0; prm.opttolerance = 0.2;
    const st = PT.potraceTrace(prm, bitmapOf(r)); assert.equal(st.status, PT.STATUS_OK);
    const got = []; for (let p = st.plist; p; p = p.next) got.push(p);
    assert.equal(got.length, r.paths.length, name);
    got.forEach((p, i) => {
      const want = r.paths[i];
      assert.equal(p.area, want.area, name + " area"); assert.equal(p.sign, want.sign, name + " sign"); assert.equal(p.curve.n, want.n, name + " n");
      want.seg.forEach((s, j) => {
        assert.equal(p.curve.tag[j], s[0], name + " tag");
        for (let k = 0; k < 3; k++) {
          if (s[0] === PT.CORNER && k === 0) continue;   // c[0] is unused at a corner
          assert.ok(Math.abs(p.curve.c[j][k].x - s[1 + 2 * k]) < 1e-7 && Math.abs(p.curve.c[j][k].y - s[2 + 2 * k]) < 1e-7, `${name} path ${i} seg ${j} c[${k}]`);
        }
      });
    });
  }
});
test("potrace: turds (paths of area <= turdsize) are dropped; an empty bitmap has no paths", () => {
  const r = { w: 6, h: 6, rows: ["000000", "011000", "011000", "000000", "000010", "000000"] };
  const prm = PT.potraceParamDefault();   // turdsize 2
  const st = PT.potraceTrace(prm, bitmapOf(r)); const areas = []; for (let p = st.plist; p; p = p.next) areas.push(p.area);
  assert.deepEqual(areas, [4]);
  assert.equal(PT.potraceTrace(prm, PT.bmNew(5, 5)).plist, null);
});

// ---------------------------------------------------------------- bitmap tracing
const rgba = (w, h, f) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a] = f(x, y); d.set([r, g, b, a], (y * w + x) * 4); } return { w, h, data: d }; };
test("ConvertImageToBilevel: grey under the threshold is black, opaque enough (alpha over 0.7 of it); invert flips the grey", () => {
  const img = rgba(5, 1, (x) => [[0, 0, 0, 255], [127, 127, 127, 255], [128, 128, 128, 255], [0, 0, 0, 89], [0, 0, 0, 90]][x]);
  // threshold 0.5: (uchar) 127.5 = 127, alpha threshold (uchar) 88.9 = 88
  assert.deepEqual([...BT.convertImageToBilevel(img, 0.5, false)], [0, 255, 255, 0, 0]);
  assert.deepEqual([...BT.convertImageToBilevel(img, 0.5, true)], [255, 255, 255, 255, 255]);   // ~127 = 128, ~128 = 127: neither is under 127
  // the luma weights (wxColour::MakeGrey): pure red 76, green 150, blue 29
  const c = rgba(3, 1, (x) => [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]][x]);
  assert.deepEqual([...BT.convertImageToBilevel(c, 0.3, false)], [255, 255, 0]);   // threshold (uchar) 76.5 = 76: red's 76 is not under it
});

const shoelace = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]); return Math.abs(a) / 2; };
test("TraceBilevelImage: a black frame becomes one outline with its hole joined in (Fracture); scaled to units per pixel", () => {
  const w = 20, h = 20, lv = new Uint8Array(w * h).fill(255);
  for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) if (!(x >= 8 && x < 12 && y >= 8 && y < 12)) lv[y * w + x] = 0;
  const r = BT.traceBilevelImage(lv, w, h, 1000, 1000);
  assert.deepEqual(r.warnings, []); assert.equal(r.outlines.length, 1);
  for (const p of r.outlines[0]) assert.ok(Number.isInteger(p[0]) && Number.isInteger(p[1]));
  // 12 x 12 px less 4 x 4 px, potrace's corners rounded: the area within 5 percent
  const a = shoelace(r.outlines[0]); assert.ok(Math.abs(a - (144 - 16) * 1e6) < 0.05 * 128e6, String(a));
  // two separate blobs: two outlines; a white image: none
  const two = new Uint8Array(w * h).fill(255); for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) { two[y * w + x] = 0; two[(y + 10) * w + x + 10] = 0; }
  assert.equal(BT.traceBilevelImage(two, w, h, 1, 1).outlines.length, 2);
  assert.equal(BT.traceBilevelImage(new Uint8Array(w * h).fill(255), w, h, 1, 1).outlines.length, 0);
});
test("Convert to Outlines placement: moved by position - size / 2, turned by the orientation about the position", () => {
  const place = { posX: 1000, posY: 2000, sizeX: 400, sizeY: 200, rotation: 0 };
  assert.deepEqual(BT.placeTracedOutlines([[[0, 0], [400, 200]]], place), [[[800, 1900], [1200, 2100]]]);
  // 90 degrees (RotatePoint exact: x' = y, y' = -x about the position)
  assert.deepEqual(BT.placeTracedOutlines([[[0, 0]]], { ...place, rotation: 90 }), [[[900, 2200]]]);
  assert.deepEqual(BT.rotatePointIU(1000, 0, 45), [707, -707]);
  // the whole conversion: a 10 x 10 black square in a 20 x 20 image of 2 mm (2e6 nm), centred at the origin
  const img = rgba(20, 20, (x, y) => (x >= 5 && x < 15 && y >= 5 && y < 15 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const res = BT.imageToOutlines(img, 0.5, false, { posX: 0, posY: 0, sizeX: 2e6, sizeY: 2e6, rotation: 0 });
  assert.equal(res.outlines.length, 1);
  const xs = res.outlines[0].map((p) => p[0]), ys = res.outlines[0].map((p) => p[1]);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [-5e5, 5e5, -5e5, 5e5]);
  assert.equal(BT.imageToOutlines(img, 0.5, true, { posX: 0, posY: 0, sizeX: 2e6, sizeY: 2e6, rotation: 0 }).outlines.length, 1);   // inverted: the frame around it
  assert.equal(BT.imageToOutlines(img, 0, false, { posX: 0, posY: 0, sizeX: 2e6, sizeY: 2e6, rotation: 0 }).outlines.length, 0);   // threshold 0: nothing is black
});
test("context menus: Convert to Outlines on exactly one image, in both editors' selection menus", () => {
  const { menuFor, evaluate } = load("domains", "pcb", "editor", "ctxmenus.ts");
  const base = { kinds: [], tool: "select", busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: true, hasItems: true };
  const acts = (o) => { const c = Object.assign({}, base, o); const walk = (l, acc = []) => { for (const e of l) { if (e.act) acc.push(e.act); if (e.items) walk(e.items, acc); } return acc; }; return walk(evaluate(menuFor(c, false), c)); };
  assert.ok(acts({ editor: "sch", kinds: ["image"] }).includes("SCH_ACTIONS::convertImageToOutlines"));
  assert.ok(acts({ editor: "pcb", kinds: ["image"] }).includes("PCB_ACTIONS::convertImageToOutlines"));
  assert.ok(!acts({ editor: "pcb", kinds: ["image", "image"] }).includes("PCB_ACTIONS::convertImageToOutlines"));
  assert.ok(!acts({ editor: "sch", kinds: ["image", "symbol"] }).includes("SCH_ACTIONS::convertImageToOutlines"));
});

// ---------------------------------------------------------------- microwave tools
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (49 "F.Fab" user) (48 "B.Fab" user))
)`;
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select", selection: [] };
  const ctx = {
    K, doc, IU: 1e6, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    selection: new Set(), cursor: null, activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(list) { log.selection = Array.from(list); ctx.selection = new Set(list); },
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, 1e6); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
/** Forms answered in order: each answer is { values } (OK) or null (Cancel); the specs are kept. */
function answer(...answers) {
  const specs = [];
  pcb.setForm((spec) => { specs.push(spec); const a = answers.shift(); if (a) spec.apply(Object.assign({}, a)); return true; });
  return specs;
}
const tw = () => K.pcbSizes.state.currentTrackWidth();
const kids = (n, k) => n.filter((c) => Array.isArray(c) && c[0] === k);
const padsOf = (n) => kids(n, "pad").map((p) => ({ number: p[1], shape: p[3], at: K.kid(p, "at").slice(1), size: K.kid(p, "size").slice(1) }));
const placed = (log) => { const c = log.commits.at(-1); return { label: c.label, node: K.parse(c.changes[0].sexpr).find ? K.parse(c.changes[0].sexpr).slice(-1)[0] : null }; };
const lastNode = (doc, log) => doc.items.get(log.commits.at(-1).changes[0].id).node;

test("ValueFromString: the user units, or a suffix's (um, mm, cm, mil / th, in / \", oz); a comma is a decimal point", () => {
  assert.equal(MW.valueFromString("1", "mm"), 1e6);
  assert.equal(MW.valueFromString(" 40 mil", "mm"), 1016000);
  assert.equal(MW.valueFromString("1in", "mm"), 25400000);
  assert.equal(MW.valueFromString("2oz", "mm"), 69596);
  assert.equal(MW.valueFromString("1,5", "mm"), 1500000);
  assert.equal(MW.valueFromString("10", "mil"), 254000);
  assert.equal(MW.valueFromString("250um", "in"), 250000);
  assert.equal(MW.valueFromString("x", "mm"), 0);
});

test("Draw Microwave Gaps: a click asks Gap Size (the track width), the footprint rides the cursor, the next click places it; the tool stays", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc);
  const specs = answer({ value: "1" });
  pcb.onActivate("mwgap", ctx); pcb.onPointerDown(ev(), [10, 10], ctx);
  assert.equal(specs[0].title, "Create Microwave Footprint"); assert.equal(specs[0].fields[0].label, "Gap Size:");
  assert.equal(specs[0].fields[0].value, MW.stringFromIU(Math.round(tw() * 1e6)));
  assert.equal(log.commits.length, 0); assert.ok(MW.mwCarrying());
  pcb.onPointerMove(ev(), [20, 5], ctx); pcb.onPointerDown(ev(), [20, 5], ctx);
  assert.equal(log.commits.at(-1).label, "Place microwave feature"); assert.ok(!MW.mwCarrying());
  const n = lastNode(doc, log);
  assert.equal(n[1], "muwave_gap"); assert.deepEqual(K.kid(n, "at").slice(1), [20, 5]);
  const w = tw(), off = Math.trunc(-(1e6 + Math.round(w * 1e6)) / 2) / 1e6;
  // pads in the order FOOTPRINT::Add( INSERT ) leaves them: pad 2 shifted left, pad 1 right of the gap
  const pads = padsOf(n);
  assert.deepEqual(pads.map((p) => p.number), ["2", "1"]);
  assert.ok(Math.abs(pads[0].at[0] - off) < 1e-9 && Math.abs(pads[1].at[0] - (off + 1 + w)) < 1e-9, JSON.stringify(pads));   // footprint coordinates
  assert.deepEqual(pads[0].size, [w, w]); assert.equal(pads[0].shape, "rect");
  assert.deepEqual(kids(n, "attr")[0].slice(1), ["exclude_from_pos_files", "exclude_from_bom"]);
  // createBaseFootprint: reference and value at the gap's text size (the track width), thickness a fifth of it
  const ref = kids(n, "property").find((p) => p[1] === "Reference"); assert.equal(ref[2], "REF**");
  assert.deepEqual(K.kid(K.kid(K.kid(ref, "effects"), "font"), "size").slice(1), [w, w]);
  const val = kids(n, "property").find((p) => p[1] === "Value"); assert.equal(val[2], "muwave_gap");
  assert.ok(kids(n, "fp_text").some((t) => t[2] === "${REFERENCE}"));
  // IPO_REPEAT: another click asks again
  const again = answer(null); pcb.onPointerDown(ev(), [30, 30], ctx); assert.equal(again.length, 1); assert.ok(!MW.mwCarrying());
  pcb.setForm(null);
});

test("Draw Microwave Stubs: pad 1 and a second pad 1 the stub's length tall, moved up by half of it", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc);
  answer({ value: "2" }); pcb.onActivate("mwstub", ctx); pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [0, 0], ctx);
  const n = lastNode(doc, log), pads = padsOf(n), w = tw();
  assert.equal(n[1], "muwave_stub");
  assert.deepEqual(pads.map((p) => p.number), ["1", "1"]);
  assert.deepEqual(pads[0].at, [0, 0]); assert.deepEqual(pads[1].size, [w, 2]);
  assert.ok(Math.abs(pads[1].at[1] - Math.trunc(-(2e6 + Math.round(w * 1e6)) / 2) / 1e6) < 1e-9);
  pcb.setForm(null);
});

test("Draw Microwave Arc Stubs: radius, then the angle (made positive, at most 180); a custom pad holding the fan polygon", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc);
  const specs = answer({ value: "3" }, { value: "-30" });
  pcb.onActivate("mwstubarc", ctx); pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.equal(specs[0].fields[0].label, "Arc Stub Radius Value:"); assert.equal(specs[1].fields[0].label, "Angle in degrees:"); assert.equal(specs[1].fields[0].value, "0.0");
  pcb.onPointerDown(ev(), [0, 0], ctx);
  const n = lastNode(doc, log), pad = kids(n, "pad")[0];
  assert.equal(n[1], "muwave_arcstub"); assert.equal(kids(n, "pad").length, 1); assert.equal(pad[3], "custom");
  assert.deepEqual(K.kid(pad, "options").slice(1), [["clearance", "outline"], ["anchor", "rect"]]);
  const pts = K.kid(K.kid(K.kid(pad, "primitives"), "gr_poly"), "pts").slice(1).map((p) => [p[1], p[2]]);
  // numPoints = int( 30 / 5 ) + 3 = 9: the centre, 7 points from -15 to +15 degrees, the centre again
  assert.equal(pts.length, 9); assert.deepEqual(pts[0], [0, 0]); assert.deepEqual(pts[8], [0, 0]);
  const exp = (deg) => { const a = (deg + 360) % 360, s = Math.sin(a * Math.PI / 180), c = Math.cos(a * Math.PI / 180); return [Math.round(-3e6 * s) / 1e6, Math.round(-3e6 * c) / 1e6]; };
  assert.deepEqual(pts[1], exp(-15)); assert.deepEqual(pts[7], exp(15));
  // a text that is not a number: DisplayError, nothing placed
  answer({ value: "3" }, { value: "abc" }); pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.ok(!MW.mwCarrying()); assert.equal(log.toasts.at(-1), "Incorrect number, abort");
  pcb.setForm(null);
});

test("Microwave footprint on the cursor: R turns it by the rotation step, F flips it, Escape (cancel) drops it and then ends the tool", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc);
  answer({ value: "1" }); pcb.onActivate("mwgap", ctx); pcb.onPointerDown(ev(), [5, 5], ctx);
  pcb.actions.rotateSelection.run(ctx);
  assert.equal(K.atOf(MW.MW.carry)[2], 90);
  pcb.actions.flipSelection.run(ctx);
  assert.equal(K.str(K.kid(MW.MW.carry, "layer")[1]), "B.Cu");
  assert.equal(MW.mwCancel(), true); assert.ok(!MW.mwCarrying()); assert.equal(MW.mwCancel(), false);
  assert.equal(log.commits.length, 0);
  pcb.setForm(null);
});

const SHAPE_FILE = `# a test shape
Unit=MM
XScale=10
YScale=2

$COORD
0 0
0.5 1
1 0.5
$ENDCOORD
`;
test("Draw Microwave Polygonal Shapes: Complex Shape reads the description file; the polygon on F.Cu, the pads at both ends", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc);
  // no file read yet: the scales are 0
  answer({ shape: "0", sx: "", sy: "" }); pcb.onActivate("mwshape", ctx); pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.equal(log.toasts.at(-1), "Shape has a null size.");
  // read the file through the button, then OK
  let spec = null; pcb.setForm((s) => { spec = s; return true; });
  pcb.setShapeFilePicker((done) => done(SHAPE_FILE));
  pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.equal(spec.title, "Complex Shape");
  assert.deepEqual(spec.fields.find((f) => f.k === "shape").options.map((o) => o[1]), ["Normal", "Symmetrical", "Mirrored"]);
  const set = {}; spec.change("read", true, (k, v) => { set[k] = v; });
  assert.deepEqual(set, { sx: "10", sy: "2" });
  spec.apply({ shape: "1", sx: "10", sy: "2" });
  pcb.onPointerDown(ev(), [0, 0], ctx);
  const n = lastNode(doc, log);
  assert.equal(n[1], "muwave_polygon");
  const pts = K.kid(kids(n, "fp_poly")[0], "pts").slice(1).map((p) => [p[1], p[2]]);
  // (offset, 0), the points scaled (Y up), (last x, 0), then the mirrored copy in reverse (symmetrical); duplicates dropped
  assert.deepEqual(pts, [[-5, 0], [0, -2], [5, -1], [5, 0], [5, 1], [0, 2], [-5, 0]]);
  assert.deepEqual(padsOf(n).map((p) => [p.number, p.at[0]]), [["2", -5], ["1", 5]]);
  // a second dialog without reading again: the points are gone ("Shape has no points.")
  answer({ shape: "0", sx: "", sy: "" }); pcb.onPointerDown(ev(), [0, 0], ctx);
  assert.equal(log.toasts.at(-1), "Shape has no points.");
  assert.deepEqual(MW.parseShapeDescription("Unit=inch\nXScale=1\n$COORD\n0 0\n$ENDCOORD\n"), { edges: [[0, 0]], scaleX: 25400000, scaleY: 25400000 });
  pcb.setForm(null); pcb.setShapeFilePicker(null);
});

test("Draw Microwave Lines: two points, then Length of track and Component value; the S-shaped coil as mw_inductor, selected", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc);
  const specs = answer({ value: "30" }, { value: "L1" });
  pcb.onActivate("mwline", ctx); pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerMove(ev(), [10, 0], ctx); pcb.onPointerDown(ev(), [10, 0], ctx);
  assert.equal(specs[0].fields[0].label, "Length of track:"); assert.equal(specs[0].fields[0].value, "10");
  assert.equal(specs[1].fields[0].label, "Component value:"); assert.equal(specs[1].fields[0].value, "L");
  assert.equal(log.commits.at(-1).label, "Add Microwave Inductor");
  const id = log.commits.at(-1).changes[0].id, n = doc.items.get(id).node;
  assert.equal(n[1], "mw_inductor"); assert.deepEqual(K.kid(n, "at").slice(1), [10, 0]);
  assert.equal(kids(n, "property").find((p) => p[1] === "Value")[2], "L1");
  assert.deepEqual(log.selection, [id]);
  const pads = padsOf(n); assert.deepEqual(pads.map((p) => [p.number, p.shape, p.at]), [["1", "circle", [0, 0]], ["2", "circle", [-10, 0]]]);
  const lines = kids(n, "fp_line").map((l) => [K.kid(l, "start").slice(1), K.kid(l, "end").slice(1)]);
  assert.deepEqual(lines[0][0], [-10, 0]); assert.deepEqual(lines.at(-1)[1], [0, 0]);   // from the start to the end (footprint coordinates)
  for (let i = 1; i < lines.length; i++) assert.deepEqual(lines[i][0], lines[i - 1][1]);
  const len = lines.reduce((a, l) => a + Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]), 0);
  assert.ok(Math.abs(len - 30) < 0.5, String(len));
  // too short, too long
  answer({ value: "5" }); pcb.onPointerDown(ev(), [20, 20], ctx); pcb.onPointerDown(ev(), [30, 20], ctx);
  assert.equal(log.toasts.at(-1), "Requested length < minimum length");
  answer({ value: "1000" }); pcb.onPointerDown(ev(), [20, 20], ctx); pcb.onPointerDown(ev(), [30, 20], ctx);
  assert.equal(log.toasts.at(-1), "Requested length too large");
  // Escape with the origin set clears it, the tool stays
  pcb.onPointerDown(ev(), [20, 20], ctx); assert.equal(MW.mwCancel(), true); assert.equal(MW.mwCancel(), false);
  pcb.setForm(null);
});

test("Component value: the footprint name validator keeps < > \" \\ : % $ / out", () => {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx } = fakeCtx(doc);
  let spec = null; let n = 0; pcb.setForm((s) => { spec = s; if (n++ === 0) s.apply({ value: "30" }); return true; });
  pcb.onActivate("mwline", ctx); pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [10, 0], ctx);
  const set = {}; spec.change("value", "a<b/c", (k, v) => { set[k] = v; }); assert.equal(set.value, "abc");
  pcb.setForm(null);
});
