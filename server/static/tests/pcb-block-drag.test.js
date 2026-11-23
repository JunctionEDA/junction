// Node test for block anchor editing (PCB_POINT_EDITOR buildBlockHandles / BLOCK_DRAG_SESSION, block_drag_*.cpp,
// PNS::BLOCK_DRAGGER): the capability table, picking by click / Shift click / box, the joined graphics that follow,
// the release's outline checks and labels, and the router carrying a via with its tracks.
// Run: node server/static/tests/pcb-block-drag.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb, B = P.blockDrag;
const IU = 1e6;

const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user))
  (net 0 "") (net 1 "GND")
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "z-1") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 50 50) (xy 60 50) (xy 60 60) (xy 50 60))))
  (gr_poly (pts (xy 0 0) (xy 4 0) (xy 4 4) (xy 0 4)) (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS") (uuid "pl-1"))
  (gr_line (start 20 0) (end 30 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "ga"))
  (gr_line (start 30 0) (end 30 10) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "gb"))
  (gr_line (start 30 0) (end 40 5) (stroke (width 0.1) (type default)) (layer "B.SilkS") (uuid "gc"))
  (gr_rect (start 70 0) (end 80 10) (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS") (uuid "r-1"))
  (gr_circle (center 90 0) (end 92 0) (stroke (width 0.1) (type default)) (fill none) (layer "F.SilkS") (uuid "c-1"))
  (gr_text "T" (at 100 0) (layer "F.SilkS") (uuid "t-1") (effects (font (size 1 1) (thickness 0.15))))
  (generated (uuid "gen-x") (type "mystery") (name "x") (layer "F.Cu") (members))
  (segment (start 110 50) (end 118 50) (width 0.25) (layer "F.Cu") (net 1) (uuid "s-1"))
  (via (at 118 50) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v-1"))
  (segment (start 118 50) (end 118 60) (width 0.25) (layer "B.Cu") (net 1) (uuid "s-2"))
)`;

function fakeCtx(doc) {
  const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 20, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, tool: "select",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: (e) => e.mm, requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(ids) { ctx.selection = new Set(ids); },
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool() {},
  };
  return { ctx, log };
}
function setup(sel) {
  const doc = K.parseDoc(BOARD, "kicad_pcb"); const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  P.state.sel.clear(); P.state.mmPerPx = 0.05; P.state.areaAnchorPointSelection = true; P.state.blockDrag = null;
  ctx.selection = new Set(sel); B.cancel(ctx); B.cancel(ctx);
  return { doc, ctx, log };
}
const zpts = (doc) => K.kids(K.kid(K.kid(doc.items.get("z-1").node, "polygon"), "pts"), "xy").map((x) => [K.num(x[1]), K.num(x[2])]);
const xy = (doc, id, key) => { const k = K.kid(doc.items.get(id).node, key); return [K.num(k[1]), K.num(k[2])]; };
const pev = (mm, extra) => Object.assign({ mm, buttons: 1, clientX: mm[0] * 20, clientY: mm[1] * 20, type: "pointermove", shiftKey: false, ctrlKey: false }, extra || {});

test("BlockDragCapability, pickable handles, picks and the box (block_drag_capability.cpp, block_drag_pick.cpp)", () => {
  const { doc } = setup([]); const cap = (id, fp) => B.capability(doc.items.get(id), !!fp);
  assert.deepEqual(["z-1", "pl-1", "ga", "r-1", "c-1", "t-1", "gen-x", "s-1", "v-1"].map((id) => cap(id)), ["deformable", "deformable", "deformable", "deformable", "rigid", "rigid", "unsupported", "router", "router"]);
  assert.equal(cap("s-1", true), "unsupported", "copper cannot be carried in the footprint editor");
  const pick = (id, key) => B.handlePickable(doc.items.get(id), key, false);
  assert.equal(pick("z-1", "m0"), true, "a zone edge can be picked");
  assert.equal(pick("r-1", "e0"), false, "a rectangle edge cannot");
  assert.equal(pick("r-1", "rc"), false, "nor the centre that drives the whole shape"); assert.equal(pick("r-1", "r0"), true);
  const s = new Set(["a"]); B.applyPick(s, "b", true); assert.deepEqual([...s].sort(), ["a", "b"]); B.applyPick(s, "a", true); assert.deepEqual([...s], ["b"]); B.applyPick(s, "c", false); assert.deepEqual([...s], ["c"]);
});

test("picking: click, Shift click, box on empty canvas, Escape drops the picks", () => {
  const { ctx } = setup(["z-1", "pl-1"]);
  const { colls } = B.collections(ctx); assert.deepEqual(colls.map((c) => c.id).sort(), ["pl-1", "z-1"]);
  assert.equal(B.click(ctx, [60, 50], false), true); assert.deepEqual(B.picked(), ["z-1|c1"]);
  assert.equal(B.click(ctx, [60, 60], true), true); assert.deepEqual(B.picked(), ["z-1|c1", "z-1|c2"]);
  assert.equal(B.click(ctx, [60, 60], true), true, "Shift click toggles"); assert.deepEqual(B.picked(), ["z-1|c1"]);
  assert.equal(B.click(ctx, [30, 30], true), false, "a Shift click on nothing goes to the selection tool");
  assert.equal(B.click(ctx, [30, 30], false), true, "a plain click on nothing drops the picks"); assert.deepEqual(B.picked(), []);
  // a drag on empty canvas picks by box; on a selected item it is the selection tool's
  assert.equal(B.areaPickStarts(ctx, [48, 48], {}), true); assert.equal(B.areaPickStarts(ctx, [52, 50.5], {}), false, "on the selected zone's outline (SelectionContains)"); assert.equal(B.areaPickStarts(ctx, [55, 55], {}), true, "an unfilled zone's inside is empty canvas"); assert.equal(B.areaPickStarts(ctx, [48, 48], { ctrl: true }), false);
  assert.equal(B.areaDrag(ctx, [48, 48], [48, 48], {}), true);
  B.pointerMove(ctx, pev([61, 51])); assert.equal(B.pointerUp(ctx, pev([61, 51], { type: "pointerup", buttons: 0 })), true);
  assert.deepEqual(B.picked(), ["z-1|c0", "z-1|c1", "z-1|m0"], "the corners and the edge between them");
  assert.equal(B.cancel(ctx), true); assert.deepEqual(B.picked(), [], "the first Escape drops the picks");
  ctx.selection = new Set(["z-1"]); B.collections(ctx); assert.deepEqual(B.picked(), []);
});

test("block drag: picked corners move, the unpicked selection travels whole, a release commits Drag block", () => {
  const { doc, ctx, log } = setup(["z-1", "pl-1"]);
  B.click(ctx, [60, 50], false); B.click(ctx, [60, 60], true);
  assert.equal(B.begin(ctx, [60, 50], true), "start");
  B.move(ctx, [62.1, 50], {}); assert.deepEqual(zpts(doc), [[50, 50], [62, 50], [62, 60], [50, 60]], "the grabbed handle snaps to the grid, the other pick follows");
  assert.deepEqual(K.ptsOf(doc.items.get("pl-1").node)[0], [2, 0]);
  assert.equal(B.release(ctx, false), true); assert.equal(log.commits.at(-1).label, "Drag block");
  assert.deepEqual(zpts(doc), [[50, 50], [62, 50], [62, 60], [50, 60]]); assert.deepEqual(K.ptsOf(doc.items.get("pl-1").node)[0], [2, 0]);
  assert.deepEqual(B.picked(), ["z-1|c1", "z-1|c2"], "the picks stay");
  // a picked edge moves square to its neighbours; Escape puts everything back and keeps the picks
  B.click(ctx, [56, 50], false); assert.equal(B.begin(ctx, [56, 50], true), "start"); B.move(ctx, [56, 47], {});
  assert.deepEqual(zpts(doc).slice(0, 2), [[50, 47], [62, 47]]);
  assert.equal(B.cancel(ctx), true); assert.deepEqual(zpts(doc).slice(0, 2), [[50, 50], [62, 50]]); assert.deepEqual(B.picked(), ["z-1|m0"]);
});

test("one item with two picks: Move Points; a lone pick keeps the point editor's drag", () => {
  const { doc, ctx, log } = setup(["z-1"]);
  B.click(ctx, [50, 50], false); assert.equal(B.begin(ctx, [50, 50], true), "normal", "one pick of a lone object: the plain point editor");
  B.click(ctx, [50, 60], true); assert.equal(B.begin(ctx, [50, 50], true), "start");
  B.move(ctx, [48, 50], {}); assert.equal(B.release(ctx, false), true); assert.equal(log.commits.at(-1).label, "Move Points");
  assert.deepEqual(zpts(doc), [[48, 50], [60, 50], [60, 60], [48, 60]]);
});

test("joined graphics follow (BlockDragFindDependents); a lock or an unsupported item refuses by name", () => {
  const { doc, ctx, log } = setup(["ga", "z-1"]);
  B.click(ctx, [30, 0], false); assert.equal(B.begin(ctx, [30, 0], true), "start");
  B.move(ctx, [30, 2], {}); assert.deepEqual(xy(doc, "gb", "start"), [30, 2], "the joined segment on the same layer stretches");
  assert.deepEqual(xy(doc, "gc", "start"), [30, 0], "another layer's segment stays");
  B.release(ctx, false); assert.equal(log.commits.at(-1).label, "Drag block");
  assert.deepEqual(xy(doc, "ga", "end"), [30, 2]); assert.deepEqual(xy(doc, "gb", "start"), [30, 2]);
  // a locked follower stops the drag
  const gb = doc.items.get("gb"); gb.node.push(["locked", "yes"]);
  assert.equal(B.begin(ctx, [30, 2], true), "refused"); assert.match(log.toasts.at(-1), /A locked connected item prevents the drag/);
  const { ctx: c2, log: l2 } = setup(["z-1", "gen-x"]);
  B.click(c2, [60, 50], false); assert.equal(B.begin(c2, [60, 50], true), "refused"); assert.match(l2.toasts.at(-1), /cannot be dragged\.$/);
});

test("the release refuses a zone outline the drag broke, and puts it back", () => {
  const { doc, ctx, log } = setup(["z-1", "pl-1"]);
  B.click(ctx, [60, 50], false); B.begin(ctx, [60, 50], true); B.move(ctx, [55, 70], {});
  const n = log.commits.length; assert.equal(B.release(ctx, false), false);
  assert.equal(log.toasts.at(-1), "The move would break a zone outline."); assert.equal(log.commits.length, n);
  assert.deepEqual(zpts(doc), [[50, 50], [60, 50], [60, 60], [50, 60]]);
  assert.equal(B.zoneOutlineIsSound(["zone", ["polygon", ["pts", ["xy", 0, 0], ["xy", 1, 0]]]]), false);
});

test("the router carries a selected via with the block and rubber-bands its tracks (PNS::BLOCK_DRAGGER)", () => {
  const { doc, ctx, log } = setup(["z-1", "v-1"]);
  const R = B.draggerStart(doc, [doc.items.get("v-1")], [], []);
  assert.equal(R.conns.length, 2, "both tracks leave the block at the via"); assert.equal(R.bridges.size, 0);
  B.click(ctx, [60, 50], false); assert.equal(B.begin(ctx, [60, 50], true), "start");
  B.move(ctx, [61, 50], {});
  assert.deepEqual(xy(doc, "v-1", "at"), [119, 50]);
  assert.deepEqual([...B.hiddenIds()].sort(), ["s-1", "s-2"]);
  assert.equal(B.release(ctx, true), true); assert.equal(log.commits.at(-1).label, "Drag block");
  assert.deepEqual(xy(doc, "v-1", "at"), [119, 50]);
  const ends = [...doc.items.values()].filter((it) => it.kind === "segment").flatMap((it) => [xy(doc, it.id, "start"), xy(doc, it.id, "end")]);
  assert.ok(ends.filter((p) => p[0] === 119 && p[1] === 50).length >= 2, "both lines now end on the moved via: " + JSON.stringify(ends));
  assert.ok(ends.some((p) => p[0] === 110 && p[1] === 50) && ends.some((p) => p[0] === 118 && p[1] === 60), "their far ends stay");
});

test("the setting is off by default: no handles, no picks", () => {
  const { ctx } = setup(["z-1", "pl-1"]); P.state.areaAnchorPointSelection = false;
  assert.equal(B.collections(ctx).colls.length, 0); assert.equal(B.click(ctx, [60, 50], false), false); assert.equal(B.areaPickStarts(ctx, [48, 48], {}), false);
});
