// Node test for the board graphic items of KiCad parity round 2 (board-graphics-a): ellipses and elliptical arcs
// (DRAWING_TOOL::DrawEllipse / DrawEllipseArc, EDA_SHAPE transforms, EDA_ELLIPSE_POINT_EDIT_BEHAVIOR, the Shape
// Properties pages, the hit test).
// Run: node server/static/tests/board-graphics-a.test.js
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
  (gr_ellipse (center 50 50) (major_radius 10) (minor_radius 4) (rotation_angle 0) (stroke (width 0.2) (type default)) (fill no) (layer "F.SilkS") (uuid "e-1"))
  (gr_ellipse_arc (center 100 50) (major_radius 6) (minor_radius 3) (rotation_angle 30) (start_angle 0) (end_angle 90) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "ea-1"))
)`;
const fixture = () => K.parseDoc(FIXTURE, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select", shown: [], selection: [] };
  let origin = null;
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    selection: new Set(), cursor: null, activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(list) { log.selection = Array.from(list); ctx.selection = new Set(list); },
    commit(changes, label) { log.commits.push({ changes, label }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
    showLayer(l) { log.shown.push(l); }, localOrigin() { return origin; }, setLocalOrigin(p) { origin = p; },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const last = (log) => log.commits.at(-1);
const nodeOf = (doc, id) => doc.items.get(id).node;
const val = (n, k) => K.num(K.kid(n, k)[1]);

test("Draw Ellipse: two corners make the inscribed ellipse, major axis along the longer side; unfilled, selected", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("gellipse", ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [20, 30], ctx);
  assert.equal(last(log).label, "Draw Ellipse");
  const id = last(log).changes[0].id, n = nodeOf(doc, id);
  assert.deepEqual(n.slice(0, 8), ["gr_ellipse", ["center", 15, 20], ["major_radius", 10], ["minor_radius", 5], ["rotation_angle", 90], ["stroke", ["width", 0.1], ["type", "default"]], ["fill", "no"], ["layer", "F.SilkS"]]);
  assert.deepEqual([...P.selectionIds(ctx)], [id]);
  // a wide box: rotation 0
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [8, 2], ctx);
  const m = nodeOf(doc, last(log).changes[0].id); assert.equal(val(m, "rotation_angle"), 0); assert.equal(val(m, "major_radius"), 4); assert.equal(val(m, "minor_radius"), 1);
});

test("Draw Elliptical Arc: box corners, start angle, end angle; End keeps what there is", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("gellipsearc", ctx);
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [20, 10], ctx);   // centre (10, 5), a = 10, b = 5
  pcb.onPointerDown(ev(), [20, 5], ctx);    // angle 0
  assert.equal(log.commits.length, 0);
  pcb.onPointerDown(ev(), [10, 10], ctx);   // angle 90 (Y down)
  assert.equal(last(log).label, "Draw Elliptical Arc");
  const n = nodeOf(doc, last(log).changes[0].id);
  assert.equal(n[0], "gr_ellipse_arc"); assert.equal(val(n, "start_angle"), 0); assert.equal(val(n, "end_angle"), 90);
  assert.equal(K.kid(n, "fill"), null, "an elliptical arc has no fill");
  assert.equal(P.state.draw, null);
  // the end before the start wraps by a turn
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [20, 10], ctx); pcb.onPointerDown(ev(), [10, 10], ctx); pcb.onPointerDown(ev(), [20, 5], ctx);
  const m = nodeOf(doc, last(log).changes[0].id); assert.equal(val(m, "start_angle"), 90); assert.equal(val(m, "end_angle"), 360);
  // End after two clicks: the whole turn from the cursor's angle
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [20, 10], ctx); pcb.onPointerMove(ev(), [0, 5], ctx);
  const before = log.commits.length; assert.equal(pcb.onKey("End", ev(), ctx), true); assert.equal(log.commits.length, before + 1);
  const q = nodeOf(doc, last(log).changes[0].id); assert.equal(val(q, "start_angle"), 180); assert.equal(val(q, "end_angle"), 540);
  // Backspace takes back a point
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [20, 10], ctx); pcb.onKey("Backspace", ev(), ctx); assert.equal(P.state.draw.pts.length, 1);
});

test("ellipse transforms: rotate (Rotation -= angle), flip and mirror (ELLIPSE::Mirror), mirror about an axis", () => {
  const E = P.ellipse;
  const node = () => K.parse('(gr_ellipse_arc (center 10 0) (major_radius 6) (minor_radius 3) (rotation_angle 30) (start_angle 10) (end_angle 100) (stroke (width 0.1) (type default)) (layer "F.SilkS"))');
  const r = P.rotateNode(node(), 0, 0, 90);
  assert.deepEqual(K.kid(r, "center").slice(1), [0, -10]); assert.equal(val(r, "rotation_angle"), -60);
  const f = P.flipNode(node(), 0, null);
  assert.deepEqual(K.kid(f, "center").slice(1), [-10, 0]); assert.equal(val(f, "rotation_angle"), -30);
  assert.equal(val(f, "start_angle"), 80); assert.equal(val(f, "end_angle"), 170); assert.equal(K.str(K.kid(f, "layer")[1]), "B.SilkS");
  const tb = P.flipNode(node(), 0, null, 5, "tb");
  assert.deepEqual(K.kid(tb, "center").slice(1), [10, 10]); assert.equal(val(tb, "start_angle"), -100); assert.equal(val(tb, "end_angle"), -10);
  const mv = P.mirrorNode(node(), 0, 0, "v"); assert.equal(K.str(K.kid(mv, "layer")[1]), "F.SilkS", "a mirror keeps the side");
  const ax = P.mirrorNodeAxis(node(), [0, 0], [1, 1]);   // axis at 45 degrees: Rotation = 2 * 45 - 30
  assert.deepEqual(K.kid(ax, "center").slice(1), [0, 10]); assert.equal(val(ax, "rotation_angle"), 60);
  assert.equal(val(ax, "start_angle"), -100); assert.equal(val(ax, "end_angle"), -10);
  assert.ok(E.ELLIPSE_KINDS.has("gr_ellipse"));
});

test("point editor: centre, major and minor handles, arc ends; dragging each as EDA_ELLIPSE_POINT_EDIT_BEHAVIOR does", () => {
  const doc = fixture(); const it = doc.items.get("e-1");
  const pts = P.editPoints(it).map((h) => [h.key, h.p]);
  assert.deepEqual(pts, [["center", [50, 50]], ["major", [60, 50]], ["minor", [50, 54]]]);
  let n = P.editPointNode(it.node, "gr_ellipse", "major", [50, 62], null, null, {});
  assert.equal(val(n, "major_radius"), 12); assert.equal(val(n, "rotation_angle"), 90);
  n = P.editPointNode(it.node, "gr_ellipse", "minor", [53, 44], null, null, {}); assert.equal(val(n, "minor_radius"), 6);
  n = P.editPointNode(it.node, "gr_ellipse", "center", [40, 41], null, null, {}); assert.deepEqual(K.kid(n, "center").slice(1), [40, 41]);
  const arc = doc.items.get("ea-1"); const keys = P.editPoints(arc).map((h) => h.key);
  assert.deepEqual(keys, ["center", "major", "minor", "estart", "eend"]);
  // moving the start keeps the sweep
  const e = P.ellipse.ellipseOf(arc.node), at45 = P.ellipse.ellipsePointAt(e, 45);
  n = P.editPointNode(arc.node, "gr_ellipse_arc", "estart", at45, null, null, {});
  assert.ok(Math.abs(val(n, "start_angle") - 45) < 1e-3); assert.ok(Math.abs(val(n, "end_angle") - 135) < 1e-3);
});

test("Shape Properties pages for an ellipse and an elliptical arc, and their checks", () => {
  const doc = fixture();
  const g = P.shapeGeomOf(doc.items.get("ea-1").node); assert.equal(g.kind, "ellipse_arc");
  const pages = P.geomPages("ellipse_arc"); assert.equal(pages.length, 1); assert.equal(pages[0].title, "Elliptical Arc");
  assert.deepEqual(pages[0].groups.map((x) => x.title), ["Center", "Major Radius", "Minor Radius", "Rotation", "Start Angle", "End Angle"]);
  const v = pages[0].get(g); assert.deepEqual(v, { cx: 100, cy: 50, major: 6, minor: 3, rot: 30, sa: 0, ea: 90 });
  assert.equal(pages[0].validate(Object.assign({}, v, { major: 0 })), "Major radius must be greater than 0");
  assert.equal(pages[0].validate(Object.assign({}, v, { minor: 0 })), "Minor radius must be greater than 0");
  const ng = pages[0].set(Object.assign({}, v, { ea: 120, rot: 45 }), g); const node = K.cloneNode(doc.items.get("ea-1").node);
  P.setShapeGeom(node, ng); assert.equal(val(node, "end_angle"), 120); assert.equal(val(node, "rotation_angle"), 45);
  assert.deepEqual(P.geomPages("ellipse")[0].groups.map((x) => x.title), ["Center", "Major Radius", "Minor Radius", "Rotation"]);
});

test("hit test: an unfilled ellipse is hit on its outline only, a filled one inside too", () => {
  const doc = fixture();
  assert.equal(P.hitTestItem(doc, 60.05, 50, 0.2).id, "e-1");
  assert.equal(P.hitTestItem(doc, 50, 50, 0.2), null, "inside an unfilled ellipse is no hit");
  const E = P.ellipse; const filled = K.cloneNode(doc.items.get("e-1").node); K.kid(filled, "fill")[1] = "yes";
  assert.equal(E.ellipseHitDistance(filled, 50, 50), 0);
  assert.ok(E.ellipseHitDistance(doc.items.get("e-1").node, 50, 54) < 1e-6);
});

test("hatch knockouts (PCB_SHAPE::getHatchingKnockouts): lines skip other drawings on the layer, grown by half the spacing", () => {
  const src = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (37 "F.SilkS" user) (49 "F.Fab" user))
  (gr_rect (start 0 0) (end 20 20) (stroke (width 0.1) (type default)) (fill hatch) (layer "F.SilkS") (uuid "h-1"))
  (gr_circle (center 10 10) (end 12 10) (stroke (width 0.1) (type default)) (fill yes) (layer "F.SilkS") (uuid "c-1"))
  (gr_circle (center 5 5) (end 6 5) (stroke (width 0.1) (type default)) (fill yes) (layer "F.Fab") (uuid "c-2"))
)`;
  const doc = K.parseDoc(src, "kicad_pcb"); K.ensureHatchKnockouts(doc);
  const lines = doc.items.get("h-1").geom.filter((g) => g.hatchLine);
  assert.ok(lines.length > 10);
  // the disc of radius 2 + 0.05 (pen) + 0.5 (half of the 1 mm spacing) is clear of hatch lines
  const distSeg = (g, x, y) => { const dx = g.x2 - g.x1, dy = g.y2 - g.y1, t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (y - g.y1) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - g.x1 - t * dx, y - g.y1 - t * dy); };
  const nearest = Math.min(...lines.map((g) => distSeg(g, 10, 10)));
  assert.ok(nearest > 2.5, `hatch keeps out of the knocked-out disc (${nearest})`);
  // another layer's drawing knocks nothing out
  assert.ok(Math.min(...lines.map((g) => distSeg(g, 5, 5))) < 0.8);
  // moving the disc away brings the hatch back on the next pass
  K.applyChange(doc, { kind: "MODIFIED", id: "c-1", sexpr: '(gr_circle (center 40 40) (end 42 40) (stroke (width 0.1) (type default)) (fill yes) (layer "F.SilkS") (uuid "c-1"))' }, IU);
  K.ensureHatchKnockouts(doc);
  assert.ok(Math.min(...doc.items.get("h-1").geom.filter((g) => g.hatchLine).map((g) => distSeg(g, 10, 10))) < 0.8);
});

test("Place Point: a 1 mm point on the active layer at each click, \"Place point\", not selected; the tool stays", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc);
  pcb.onActivate("placepoint", ctx);
  pcb.onPointerDown(ev(), [3, 4], ctx); pcb.onPointerDown(ev(), [5, 6], ctx);
  assert.equal(log.commits.length, 2); assert.equal(last(log).label, "Place point");
  const n = nodeOf(doc, last(log).changes[0].id);
  assert.deepEqual(n.slice(0, 4), ["point", ["at", 5, 6], ["size", 1], ["layer", "F.Cu"]]);
  assert.equal(P.selectionIds(ctx).size, 0); assert.ok(log.shown.includes("F.Cu"));
});

test("Place Sub-grid: the centre, then the cursor sets the extent and the angle (-EDA_ANGLE of the offset)", () => {
  const doc = fixture(); const { ctx, log } = fakeCtx(doc); const shown = []; ctx.showObject = (id) => shown.push(id);
  pcb.onActivate("subgrid", ctx); assert.deepEqual(shown, ["subgrids"]);
  pcb.onPointerDown(ev(), [10, 10], ctx); assert.equal(log.commits.length, 0);
  pcb.onPointerMove(ev(), [10, 7], ctx); assert.equal(P.state.subGrid.len, 3); assert.equal(P.state.subGrid.angle, 90);
  pcb.onPointerDown(ev(), [14, 13], ctx);
  assert.equal(last(log).label, "Place Sub-grid");
  const n = nodeOf(doc, last(log).changes[0].id);
  assert.deepEqual(n.slice(0, 8), ["grid_item", "xy", ["at", 10, 10], ["extent", 5, 5], ["spacing", 1, 1], ["angle", 323.1301024], ["priority", 1], ["affects", ["cursor", "yes"], ["routing", "yes"], ["placement", "yes"]]]);
  assert.equal(P.state.subGrid, null, "the tool waits for the next centre");
  // a cursor straight to the right: no (angle)
  pcb.onPointerDown(ev(), [0, 0], ctx); pcb.onPointerDown(ev(), [2, 0], ctx);
  assert.equal(K.kid(nodeOf(doc, last(log).changes[0].id), "angle"), null);
});
