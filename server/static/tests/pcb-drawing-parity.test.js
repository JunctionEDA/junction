// Node test for the board drawing tools against KiCad's DRAWING_TOOL, ZONE_CREATE_HELPER, PCB_POINT_EDITOR,
// CONVERT_TOOL and VIA_PLACER: what a click, a key and a finished shape do, and what the commit is called.
// Run: node server/static/tests/pcb-drawing-parity.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;
test.beforeEach(() => { P.state.gfxLayer = "F.SilkS"; P.state.draw = null; P.state.strokeW = null; });

const FIXTURE = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (36 "B.SilkS" user) (49 "F.Fab" user) (47 "F.CrtYd" user))
  (segment (start 110 50) (end 120 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "s-1"))
  (arc (start 140 50) (mid 141 51) (end 142 50) (width 0.25) (layer "F.Cu") (net "GND") (uuid "a-1"))
  (gr_line (start 90 40) (end 100 40) (stroke (width 0.05) (type default)) (layer "Edge.Cuts") (uuid "g-1"))
  (gr_arc (start 60 40) (mid 61 41) (end 62 40) (stroke (width 0.2) (type default)) (layer "F.SilkS") (uuid "ga-1"))
  (gr_rect (start 10 60) (end 20 70) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "r-1"))
  (gr_poly (pts (xy 30 60) (xy 40 60) (xy 40 70) (xy 30 70)) (stroke (width 0.1) (type solid)) (fill no) (layer "F.SilkS") (uuid "p-1"))
)`;
const fixture = () => K.parseDoc(FIXTURE, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select", shown: [], origins: [], selection: [] };
  let origin = null;
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    selection: new Set(), cursor: null, activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(list) { log.selection = Array.from(list); ctx.selection = new Set(list); },
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
    showLayer(l) { log.shown.push(l); }, localOrigin() { return origin; }, setLocalOrigin(p) { origin = p; log.origins.push(p); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const last = (log) => log.commits.at(-1);
const nodeOf = (doc, id) => doc.items.get(id).node;
const xy = (n, k) => K.kid(n, k).slice(1, 3);

test("commit labels and the selection after a shape: Draw Line / Rectangle / Circle / Polygon, the new item selected", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  // DrawRectangle: the rectangle is stored normalised whichever corner came first, and is selected
  pcb.onActivate("grect", ctx); pcb.onPointerDown(ev(), [30, 30], ctx); pcb.onPointerDown(ev(), [20, 10], ctx);
  assert.equal(last(log).label, "Draw Rectangle"); let id = last(log).changes[0].id;
  assert.deepEqual(xy(nodeOf(doc, id), "start"), [20, 10]); assert.deepEqual(xy(nodeOf(doc, id), "end"), [30, 30]);
  assert.deepEqual([...P.selectionIds(ctx)], [id]);
  assert.deepEqual(xy(P.rectNode([5, 9], [1, 2], "F.SilkS"), "start"), [1, 2]);
  pcb.onActivate("gcircle", ctx); pcb.onPointerDown(ev(), [50, 10], ctx);
  assert.equal(P.selectionIds(ctx).size, 0, "starting a shape clears the selection");
  pcb.onPointerDown(ev(), [53, 10], ctx);
  assert.equal(last(log).label, "Draw Circle"); assert.deepEqual([...P.selectionIds(ctx)], [last(log).changes[0].id]);
  pcb.onActivate("gline", ctx); pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [5, 0], ctx);
  assert.equal(last(log).label, "Draw Line"); pcb.cancel();
});

test("drawing shows the layer drawn on and moves the local origin to the first point, putting it back afterwards", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("grect", ctx); pcb.onPointerDown(ev(), [10, 10], ctx);
  assert.deepEqual(log.shown, ["F.SilkS"], "a hidden layer is made visible");
  assert.deepEqual(log.origins.at(-1), [10, 10], "the first corner is the local origin while the shape is drawn");
  pcb.onPointerDown(ev(), [20, 20], ctx);
  assert.deepEqual(log.origins.at(-1), [0, 0], "and the origin goes back to (0, 0) when the shape is done");
});

test("Delete or Backspace while a rectangle or circle is drawn cancels the shape and deletes nothing", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  ctx.setSelection(["g-1"]); const n = log.commits.length;
  pcb.onActivate("grect", ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerMove(ev(), [20, 20], ctx);
  assert.equal(pcb.onKey("Delete", ev(), ctx), true); assert.equal(P.state.draw, null); assert.equal(log.commits.length, n); assert.ok(doc.items.has("g-1"));
  pcb.onActivate("gcircle", ctx); pcb.onPointerDown(ev(), [10, 10], ctx);
  assert.equal(pcb.onKey("Backspace", ev(), ctx), true); assert.equal(P.state.draw, null); assert.equal(log.commits.length, n);
});

test("End does nothing to a line, rectangle or circle in progress; it finishes a bezier with what there is", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  for (const t of ["gline", "grect", "gcircle"]) {
    pcb.onActivate(t, ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerMove(ev(), [20, 14], ctx); const n = log.commits.length;
    pcb.onKey("End", ev(), ctx); assert.ok(P.state.draw && P.state.draw.shape === t, t + " goes on"); assert.equal(log.commits.length, n); pcb.cancel();
  }
  pcb.onActivate("gcurve", ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [12, 4], ctx); pcb.onPointerMove(ev(), [20, 10], ctx);
  pcb.onKey("End", ev(), ctx);
  assert.equal(last(log).label, "Draw Bezier"); assert.equal(P.state.draw, null, "no further curve is chained");
  assert.deepEqual(K.ptsOf(nodeOf(doc, last(log).changes[0].id)), [[10, 10], [12, 4], [20, 10], [20, 10]]);
});

test("a double click finishes a polygon; the last corner clicked again adds nothing", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("gpoly", ctx);
  for (const p of [[10, 10], [20, 10], [20, 20]]) pcb.onPointerDown(ev(), p, ctx);
  const n = log.commits.length; pcb.onPointerDown(ev(), [20, 20], ctx); assert.equal(log.commits.length, n); assert.equal(P.state.draw.pts.length, 3);
  pcb.onPointerDown(ev(), [10, 20], ctx); pcb.onPointerDown(ev({ detail: 2 }), [10, 20], ctx);
  assert.equal(last(log).label, "Draw Polygon"); assert.equal(P.state.draw, null);
  assert.deepEqual(K.ptsOf(nodeOf(doc, last(log).changes[0].id)), [[10, 10], [20, 10], [20, 20], [10, 20]]);
});

test("graphic polygon: filled except on Edge.Cuts and the courtyards (ZONE_CREATE_HELPER::createNewZone)", () => {
  assert.equal(P.polyFilledOn("F.SilkS"), true); assert.equal(P.polyFilledOn("F.Cu"), true);
  assert.equal(P.polyFilledOn("Edge.Cuts"), false); assert.equal(P.polyFilledOn("F.CrtYd"), false); assert.equal(P.polyFilledOn("B.CrtYd"), false);
});

test("SHAPE_LINE_CHAIN::Simplify on a finished outline: duplicate and collinear corners go", () => {
  assert.deepEqual(P.simplifyOutline([[0, 0], [5, 0], [10, 0], [10, 10], [10, 10], [0, 10]]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
  assert.deepEqual(P.simplifyOutline([[5, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), [[10, 0], [10, 10], [0, 10], [0, 0]], "a collinear start point goes too");
  assert.deepEqual(P.simplifyOutline([[0, 0], [10, 0], [10, 10]]), [[0, 0], [10, 0], [10, 10]]);
});

test("width keys: they work before the first click of a line, and do nothing while a zone or polygon is drawn", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); const A = pcb.actions;
  pcb.onActivate("gline", ctx); A.incWidth.run(ctx);
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [5, 0], ctx);
  const w = +K.kid(K.kid(nodeOf(doc, last(log).changes[0].id), "stroke"), "width")[1];
  assert.ok(w > 0.1 + 1e-9, "one step wider than the silkscreen default");
  pcb.cancel();
  // a layer change puts the layer's default width back
  pcb.setLayer(ctx, "F.Fab"); assert.equal(P.state.strokeW, null);
  pcb.setLayer(ctx, "F.SilkS");
  pcb.onActivate("gpoly", ctx); pcb.onPointerDown(ev(), [0, 0], ctx); const before = P.state.strokeW; A.incWidth.run(ctx);
  assert.equal(P.state.strokeW, before, "DrawZone has no width keys"); pcb.cancel();
});

test("the line tool ends its chain when the click lands on an existing graphic's point", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.setLayer(ctx, "Edge.Cuts"); pcb.onActivate("gline", ctx);
  pcb.onPointerDown(ev(), [90, 30], ctx); pcb.onPointerDown(ev(), [90, 40], ctx);   // g-1's start
  assert.equal(last(log).label, "Draw Line"); assert.equal(P.state.draw, null, "the chain is over");
  assert.deepEqual([...P.selectionIds(ctx)], [last(log).changes[0].id]);
});

test("new zones take Board Setup > Zones' defaults", () => {
  // ZONE_SETTINGS' own defaults when the project has none
  let z = P.zoneDefaultSettings();
  assert.deepEqual([z.clearance, z.minThickness, z.padConnection, z.thermalGap, z.spokeWidth, z.border, z.hatchPitch, z.fillMode, z.islands], [0.5, 0.25, 1, 0.5, 0.5, 2, 0.5, 0, 0]);
  P.designSettings({ board: { design_settings: { defaults: { zones: { min_clearance: 0.3, min_thickness: 0.2, pad_connection: 2, thermal_relief_gap: 0.4, thermal_relief_spoke_width: 0.6, border_display_style: 1, border_hatch_pitch: 0.8, remove_islands: 2, min_island_area: 4 } } } } });
  try {
    z = P.zoneDefaultSettings();
    assert.deepEqual([z.clearance, z.minThickness, z.padConnection, z.thermalGap, z.spokeWidth, z.border, z.hatchPitch, z.islands, z.islandArea], [0.3, 0.2, 2, 0.4, 0.6, 1, 0.8, 2, 4]);
    const doc = fixture(); const { ctx, log } = fakeCtx(doc);
    pcb.setLayer(ctx, "F.Cu"); pcb.onActivate("thievingzone", ctx);
    const node = P.zoneNode ? P.zoneNode(doc, [[0, 0], [10, 0], [10, 10]], "F.Cu", { code: 0, name: "" }) : null;
    if (node) {
      assert.deepEqual(K.kid(node, "hatch"), ["hatch", "full", 0.8]); assert.deepEqual(K.kid(node, "connect_pads"), ["connect_pads", "yes", ["clearance", 0.3]]);
      assert.deepEqual(K.kid(node, "min_thickness"), ["min_thickness", 0.2]);
      assert.deepEqual(K.kid(node, "fill"), ["fill", ["thermal_gap", 0.4], ["thermal_bridge_width", 0.6], ["island_removal_mode", 2], ["island_area_min", 4]]);
    }
    assert.equal(log.commits.length, 0); pcb.cancel();
  } finally { P.designSettings({ board: { design_settings: { defaults: {} } } }); }
});

test("Create Arc from Selection (CONVERT_TOOL::SegmentToArc): the source stays, the arc sits beside it", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  // a track: PCB_ARC through a midpoint a tenth of the length along the normal, same width, layer and net
  ctx.setSelection(["s-1"]); assert.equal(pcb.runAction("convertToArc", ctx), true);
  let c = last(log); assert.equal(c.label, "Create Arc"); assert.equal(c.changes.length, 1); assert.ok(doc.items.has("s-1"), "the segment is kept");
  let n = nodeOf(doc, c.changes[0].id); assert.equal(n[0], "arc");
  assert.deepEqual([xy(n, "start"), xy(n, "mid"), xy(n, "end")], [[110, 50], [115, 51], [120, 50]]);
  assert.equal(+K.kid(n, "width")[1], 0.25); assert.equal(K.kid(n, "layer")[1], "F.Cu"); assert.equal(P.netOf(n).name, "GND");
  // a graphic line: SetCenter / SetStart / SetEnd, the stroke copied; an EDA_SHAPE arc runs with the angle growing from start to end
  ctx.setSelection(["g-1"]); pcb.runAction("convertToArc", ctx); c = last(log); n = nodeOf(doc, c.changes[0].id);
  assert.equal(n[0], "gr_arc"); assert.deepEqual([xy(n, "start"), xy(n, "end")], [[90, 40], [100, 40]]);
  assert.deepEqual(K.kid(n, "stroke"), ["stroke", ["width", 0.05], ["type", "default"]]); assert.equal(K.kid(n, "layer")[1], "Edge.Cuts");
  { const m = xy(n, "mid"); assert.ok(Math.abs(m[0] - 95) < 1e-6 && Math.abs(m[1] - 15) < 1e-6, "centre (95, 28), radius 13: the arc from start to end with the angle growing passes (95, 15)"); }
  // a track arc becomes a graphic arc over the same three points, and a graphic arc a track arc
  ctx.setSelection(["a-1"]); pcb.runAction("convertToArc", ctx); n = nodeOf(doc, last(log).changes[0].id);
  assert.equal(n[0], "gr_arc"); assert.deepEqual([xy(n, "start"), xy(n, "mid"), xy(n, "end")], [[140, 50], [141, 51], [142, 50]]);
  assert.equal(+K.kid(K.kid(n, "stroke"), "width")[1], 0.25);
  ctx.setSelection(["ga-1"]); pcb.runAction("convertToArc", ctx); n = nodeOf(doc, last(log).changes[0].id);
  assert.equal(n[0], "arc"); assert.deepEqual([xy(n, "start"), xy(n, "mid"), xy(n, "end")], [[60, 40], [61, 41], [62, 40]]); assert.equal(+K.kid(n, "width")[1], 0.2);
  // anything else: nothing, and no message
  ctx.setSelection(["r-1"]); const k = log.commits.length, t = log.toasts.length; pcb.runAction("convertToArc", ctx);
  assert.equal(log.commits.length, k); assert.equal(log.toasts.length, t);
});

test("Place Via: the via takes the track's net and splits the track; Shift leaves the track whole", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("via", ctx); pcb.onPointerDown(ev(), [115, 50], ctx);
  const c = last(log); assert.equal(c.label, "Place via");
  const via = c.changes.map((x) => doc.items.get(x.id)).find((it) => it && it.kind === "via"); assert.ok(via);
  assert.deepEqual(xy(via.node, "at"), [115, 50]); assert.equal(P.netOf(via.node).name, "GND");
  const segs = [...doc.items.values()].filter((it) => it.kind === "segment").map((it) => [xy(it.node, "start"), xy(it.node, "end")]).sort((a, b) => a[0][0] - b[0][0]);
  assert.deepEqual(segs, [[[110, 50], [115, 50]], [[115, 50], [120, 50]]], "the segment is split at the via");
  // off any copper: a free via without a net
  pcb.onPointerDown(ev(), [10, 10], ctx); const v2 = last(log).changes.map((x) => doc.items.get(x.id)).find((it) => it && it.kind === "via");
  assert.ok(!P.netOf(v2.node).name, "nothing under it: no net"); assert.equal(last(log).changes.length, 1);
  const doc2 = fixture(); const f2 = fakeCtx(doc2);
  pcb.onActivate("via", f2.ctx); pcb.onPointerDown(ev({ shiftKey: true }), [115, 50], f2.ctx);
  assert.equal([...doc2.items.values()].filter((it) => it.kind === "segment").length, 1, "Shift: no split");
});

test("the via tool's Select Via Size menu (VIA_SIZE_MENU): Use Custom Values... then the board's via sizes", () => {
  const doc = fixture(); const { ctx } = fakeCtx(doc);
  const rows = pcb.viaSizeMenu(ctx);
  assert.equal(rows[0].label, "Use Custom Values..."); assert.equal(rows[0].tip, "Specify custom track and via sizes"); assert.equal(rows[1].sep, true);
  assert.ok(rows.slice(2).every((r) => /^Via /.test(r.label) && !/netclass/.test(r.label)), "the netclass entry is not listed");
});

test("point editor: a rectangle's centre and radius handles, chamfer and move-corner on a polygon", () => {
  const doc = fixture();
  assert.deepEqual(P.editPoints(doc.items.get("r-1")).map((h) => h.key), ["r0", "r1", "r2", "r3", "rc", "rr", "e0", "e1", "e2", "e3"]);
  // RECTANGLE_POINT_EDIT_BEHAVIOR: the centre handle moves the whole rectangle
  const moved = P.editPointNode(nodeOf(doc, "r-1"), "gr_rect", "rc", [25, 75]);
  assert.deepEqual([xy(moved, "start"), xy(moved, "end")], [[20, 70], [30, 80]]);
  // Move Corner To...: the corner goes to the typed position
  const mv = P.movePointChanges(doc, "p-1", "c1", [45, 55]); assert.equal(mv.length, 1);
  for (const c of mv) K.applyChange(doc, c, IU);
  assert.deepEqual(K.ptsOf(nodeOf(doc, "p-1")), [[30, 60], [45, 55], [40, 70], [30, 70]]);
  // Chamfer Corner: the corner becomes two
  const ch = P.chamferCornerChanges(doc, "p-1", [40, 70]); assert.equal(ch.length, 1);
  for (const c of ch) K.applyChange(doc, c, IU);
  assert.equal(K.ptsOf(nodeOf(doc, "p-1")).length, 5);
  // POLYGON_EDGE_DRAG_POLICY: an edge dragged between its neighbours keeps their directions
  const [a, b] = P.polyEdgeDrag([[0, 0], [10, 0], [10, 10], [0, 10]], 1, [12, 5], false, 0);
  assert.deepEqual([a, b], [[12, 0], [12, 10]]);
  // grid on: the perpendicular displacement is quantized to hypot( gridSize.x * perp.x, gridSize.y * perp.y )
  const q = (gx, gy) => P.polyEdgeDrag([[0, 0], [10, 0], [10, 10], [0, 10]], 2, [5, 11.6], false, gx, gy)[0][1];
  assert.equal(q(1, 1), 12, "a horizontal edge on a square grid: one X = Y step");
  assert.equal(q(1, 2), 12, "and with a 2 mm Y it moves by whole Y steps");
  assert.equal(q(1, 3), 13, "11.6 nearest multiple of 3 from 10 -> 13");
});
test("router pick slop and the table cells on a non-square grid (maxSlopRadius, gridSize.x / .y)", () => {
  assert.deepEqual(P.tableGrid([0, 0], [10.3, 4.1], "F.SilkS", 0.5), { x: 0, y: 0, cw: 10.5, ch: 4, rows: 1, cols: 1 });
  assert.deepEqual(P.tableGrid([0, 0], [10.3, 4.1], "F.SilkS", 0.5, 1.5), { x: 0, y: 0, cw: 10.5, ch: 4.5, rows: 1, cols: 1 });
  const src = require("fs").readFileSync(require("./web-path").webPath("tools/pcb-tools/app-state.ts"), "utf8");
  assert.ok(/const slop = Math\.max\(ctx\.gridPitch \|\| 0, ctx\.gridPitchY \|\| 0\)/.test(src), "pickSingleItem slop is max( GetGrid().x, GetGrid().y )");
});
