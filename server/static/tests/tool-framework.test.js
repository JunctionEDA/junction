// tool-framework.test.js — KiCad parity of the common tool framework (common/tool/*.cpp) in the editor shell:
//  · TOOL_DISPATCHER::IsPastDragThreshold (per axis, in screen pixels; 4 px on Windows, 8 elsewhere; 300 ms on macOS);
//  · COMMON_TOOLS::CursorControl's keyboard clicks (events, held modifiers) and where the keyboard cursor starts;
//  · ZOOM_TOOL::selectRegion, the right click's selection, the Clarify Selection menu's keys, the redo key;
//  · EDIT_POINTS::FindPoint and the edit points' colours;
//  · SNAP_LINE_MANAGER / GRID_HELPER::SnapToConstructionLines (the active direction's 1.5 x range, the origin moved
//    onto a snapped anchor, the guide), GRID_HELPER::Align's auxiliary axis and CONSTRUCTION_MANAGER's batches;
//  · PCB_PICKER_TOOL's context menu for the board's picker tools.
// Run: node server/static/tests/tool-framework.test.js
"use strict";
const assert = require("assert/strict");
const path = require("path");
const fs = require("fs");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const DT = load(["tools", "drag-threshold.ts"]);
const KI = load(["editor", "kicad-input.ts"]);
const EPS = load(["tools", "edit-point-style.ts"]);
const CM = load(["editor", "ctxmenus.ts"]);
const C = P.construction;
const src = (rel) => fs.readFileSync(webPath(rel), "utf8");

let passed = 0, failed = 0;
const queue = [];
const test = (name, fn) => queue.push([name, fn]);   // run one after another: the snapping state is shared

test("IsPastDragThreshold: per axis, strictly past the system drag distance; macOS also after 300 ms", () => {
  assert.equal(DT.dragMinPx("win"), 4); assert.equal(DT.dragMinPx("linux"), 8); assert.equal(DT.dragMinPx("mac"), 8);
  assert.equal(DT.isPastDragThreshold(4, 4, 0, "win"), false, "4 px on both axes is not past 4");
  assert.equal(DT.isPastDragThreshold(5, 0, 0, "win"), true);
  assert.equal(DT.isPastDragThreshold(7, 7, 0, "linux"), false, "per axis, not the distance (7,7 is ~9.9 px)");
  assert.equal(DT.isPastDragThreshold(0, -9, 0, "linux"), true);
  assert.equal(DT.isPastDragThreshold(1, 1, 301, "mac"), true, "macOS: held past DragTimeThreshold");
  assert.equal(DT.isPastDragThreshold(1, 1, 301, "linux"), false, "only on macOS");
  assert.equal(DT.isPastDragThreshold(1, 1, 300, "mac"), false);
});

test("CursorControl: a keyboard click and double click, with the held modifiers (MD_CTRL is Cmd on macOS)", () => {
  assert.deepEqual(KI.cursorClickEvents(1), [["pointerdown", 1], ["pointerup", 1], ["click", 1]]);
  assert.deepEqual(KI.cursorClickEvents(2), [["pointerdown", 2], ["pointerup", 2], ["dblclick", 2]], "a double click: no click event first");
  assert.deepEqual(KI.heldMods({ shift: true, ctrl: true, alt: false }, false), { shiftKey: true, ctrlKey: true, metaKey: false, altKey: false });
  assert.deepEqual(KI.heldMods({ shift: false, ctrl: true, alt: true }, true), { shiftKey: false, ctrlKey: false, metaKey: true, altKey: true });
});

test("CursorControl: the keyboard cursor starts from where it is, else the selection's reference point, else the mouse", () => {
  assert.deepEqual(KI.cursorStepOrigin([1, 2], [3, 4], [5, 6]), [1, 2]);
  assert.deepEqual(KI.cursorStepOrigin(null, [3, 4], [5, 6]), [3, 4]);
  assert.deepEqual(KI.cursorStepOrigin(null, null, [5, 6]), [5, 6]);
});

test("ZOOM_TOOL::selectRegion: left box fills the view, right box zooms out by the same ratio, a flat box does nothing", () => {
  const view = { w: 100, h: 50 };
  let z = KI.zoomRegion({ x: 10, y: 10, w: 20, h: 5 }, view, false);
  assert.equal(z.factor, 5, "ratio = max(20/100, 5/50) = 0.2: scale / ratio"); assert.deepEqual(z.center, [20, 12.5]);
  z = KI.zoomRegion({ x: 30, y: 15, w: -20, h: -5 }, view, true);
  assert.equal(z.factor, 0.2, "a right drag: scale * ratio"); assert.deepEqual(z.center, [20, 12.5]);
  assert.equal(KI.zoomRegion({ x: 0, y: 0, w: 0, h: 10 }, view, false), null);
  assert.equal(KI.zoomRegion({ x: 0, y: 0, w: 10, h: 0 }, view, true), null);
});

test("right click: the board keeps any selection; the schematic keeps it inside its box grown by a grid step", () => {
  assert.equal(KI.rightClickKeepsSelection(false, 0, null, [0, 0], 1), false, "nothing selected: select under the cursor");
  assert.equal(KI.rightClickKeepsSelection(false, 2, [0, 0, 1, 1], [50, 50], 1), true, "PCB: a selection stays wherever the click is");
  assert.equal(KI.rightClickKeepsSelection(true, 1, [0, 0, 10, 10], [11.2, 5], 1.27), true);
  assert.equal(KI.rightClickKeepsSelection(true, 1, [0, 0, 10, 10], [11.3, 5], 1.27), false);
});

test("Clarify Selection: &1-9, Select &All and Show &More pick by key, case aside; disabled rows and separators never", () => {
  const items = [{ key: "1" }, { sep: true, separator: true }, { key: "2", disabled: true }, { key: "A" }, { key: "M" }];
  assert.equal(KI.menuKeyIndex(items, "1"), 0);
  assert.equal(KI.menuKeyIndex(items, "a"), 3);
  assert.equal(KI.menuKeyIndex(items, "m"), 4);
  assert.equal(KI.menuKeyIndex(items, "2"), -1, "a disabled row");
  assert.equal(KI.menuKeyIndex(items, "Enter"), -1);
});

test("ACTIONS::redo: Cmd+Shift+Z on macOS, Ctrl+Y elsewhere, nothing else (no Alt)", () => {
  assert.equal(KI.redoCombo(true, { ctrl: true, shift: true, alt: false, key: "z" }), true);
  assert.equal(KI.redoCombo(true, { ctrl: true, shift: false, alt: false, key: "y" }), false);
  assert.equal(KI.redoCombo(false, { ctrl: true, shift: false, alt: false, key: "y" }), true);
  assert.equal(KI.redoCombo(false, { ctrl: true, shift: true, alt: false, key: "z" }), false, "Ctrl+Shift+Z is no redo on Windows / Linux");
  assert.equal(KI.redoCombo(false, { ctrl: true, shift: true, alt: false, key: "y" }), false);
  assert.equal(KI.redoCombo(false, { ctrl: true, shift: false, alt: true, key: "y" }), false);
});

test("EDIT_POINTS::FindPoint: points before edge lines, strictly inside the square on each axis", () => {
  const pts = [{ key: "m0", p: [0, 0] }, { key: "start", p: [0.5, 0] }, { key: "e1", p: [3, 0] }];
  assert.equal(P.findEditHandle(pts, 0.2, 0, 1).key, "start", "the corner wins over the edge line it overlaps");
  assert.equal(P.findEditHandle(pts, 3.5, 0.5, 1).key, "e1");
  assert.equal(P.findEditHandle(pts, 4, 0, 1), null, "exactly on the square's edge is outside");
});

test("EDIT_POINTS::ViewDraw colours: the highlight shade is Darkened( 0.5 ) on a light point, Brightened otherwise", () => {
  const w = EPS.editPointColors("#FFFFFF", "#001023");
  assert.equal(w.fill, "rgb(255,255,255)"); assert.equal(w.highlight, "rgba(128,128,128,0.8)"); assert.equal(w.border, "rgba(77,77,77,0.8)");
  const d = EPS.editPointColors("#202020", "#FFFFFF");
  assert.equal(d.highlight, "rgba(144,144,144,0.8)", "a dark point: Brightened( 0.5 )");
});

// ---------------------------------------------------------------- snapping
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (40 "Dwgs.User" user))
  (gr_line (start 20 20) (end 30 20) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "g1"))
  (gr_line (start 60 0) (end 60 3) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "g2"))
  (gr_line (start 40 8) (end 90 8) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "g3")))`;
function fakeCtx(doc) {
  const ctx = { K, doc, IU: 1e6, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: false, selection: new Set(), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), requestRender() {}, applyLocal() {}, setSelected() {}, setSelection() {}, setHighlight() {}, toast() {}, commit() {}, setTool(t) { pcb.onActivate(t, ctx); } };
  pcb.onDocChanged(ctx); pcb.onActivate("select", ctx); P.state.snapAllLayers = true;
  return ctx;
}
const board = () => K.parseDoc(BOARD, "kicad_pcb");
const HV = [[1, 0], [0, 1]];

test("snap lines: the active direction holds to 1.5 x the range (SnapToConstructionLines), then lets go", () => {
  const ctx = fakeCtx(board()); C.snapLineClear();
  const line = { origin: [0, 0], dirs: HV };
  let s = P.snapCursor(ctx, [10, 2], null, {}, line);   // range 25 px = 2.5 mm
  assert.deepEqual(s.p, [10, 0]); assert.deepEqual(s.guide, [[0, 0], [10, 0]]); assert.equal(C.snapLineState().active, 0);
  s = P.snapCursor(ctx, [10, 3], null, {}, line);
  assert.deepEqual(s.p, [10, 0], "3 mm: past the range, inside 1.5 x for the active line"); assert.equal(C.snapLineState().active, 0);
  s = P.snapCursor(ctx, [10, 4], null, {}, line);
  assert.deepEqual(s.p, [10, 4], "past 3.75 mm the line lets go"); assert.equal(s.guide, null); assert.equal(C.snapLineState().active, null);
  s = P.snapCursor(ctx, [10, 3], null, {}, line);
  assert.deepEqual(s.p, [10, 3], "coming back, the plain range applies again");
});

test("snap lines: an anchor off the lines becomes the origin (SetSnappedAnchor); one on a line is the line's end", () => {
  const ctx = fakeCtx(board()); C.snapLineClear();
  const line = { origin: [0, 0], dirs: HV };
  let s = P.snapCursor(ctx, [20.3, 20.2], null, {}, line);
  assert.deepEqual(s.p, [20, 20]); assert.deepEqual(C.snapLineState().origin, [20, 20], "the snapped end is the new origin"); assert.equal(s.guide, null);
  P.state.snapItem = null;
  s = P.snapCursor(ctx, [20.4, 40], null, {}, line);
  assert.deepEqual(s.p, [20, 40], "held on the vertical through the new origin"); assert.deepEqual(s.guide, [[20, 20], [20, 40]]);
  assert.equal(C.snapLineState().active, 1);
  // a new move (another origin) starts over at its own origin
  s = P.snapCursor(ctx, [5.5, 40], null, {}, { origin: [5, 0], dirs: HV });
  assert.deepEqual(s.p, [5, 40]); assert.deepEqual(s.guide, [[5, 0], [5, 40]]);
  // Shift: no snapping at all, no snap line end
  s = P.snapCursor(ctx, [5.5, 40], null, { shiftKey: true }, { origin: [5, 0], dirs: HV });
  assert.deepEqual(s.p, [5.5, 40]); assert.equal(C.snapLineState().end, null);
});

test("GRID_HELPER::Align: the auxiliary axis through the drag origin beats a farther grid line, per axis, with the grid on only", () => {
  assert.deepEqual(P.alignAux([0.25, 0.5], [0.1, 0.45], [0.12, 10]), [0.12, 0.5]);
  const ctx = fakeCtx(board()); ctx.snapOn = true;
  assert.deepEqual(P.snapCursor(ctx, [10.13, 5.06], null, {}, { origin: [10.12, 0], dirs: [], aux: [10.12, 0] }).p, [10.12, 5]);
  assert.deepEqual(P.snapCursor(ctx, [10.13, 5.06], null, {}, { origin: [10.12, 0], dirs: [] }).p, [10.25, 5], "no axis: the grid");
  assert.deepEqual(P.snapCursor(ctx, [10.13, 5.06], null, { ctrlKey: true }, { origin: [10.12, 0], dirs: [], aux: [10.12, 0] }).p, [10.13, 5.06], "Ctrl: no grid, no axis");
});

test("SnapToConstructionLines: nearest line first, then the point nearer the cursor; GetNearestSnapLinePoint yields to a near anchor", () => {
  const id = (q) => q;
  assert.deepEqual(P.snapToConstructionLines([0, 0], HV, null, [5, 1], [5, 1], 2, 0, id), [5, 0]);
  assert.equal(P.snapToConstructionLines([0, 0], HV, null, [5, 2.5], [5, 2.5], 2, 0, id), null);
  assert.deepEqual(P.snapToConstructionLines([0, 0], HV, 0, [5, 2.5], [5, 2.5], 2, 0, id), [5, 0], "the active line: 1.5 x");
  assert.deepEqual(P.snapToConstructionLines([0, 0], HV, null, [5, 1], [5.25, 1], 2, 0.25, id), [5.25, 0], "grid on: the grid's x on a horizontal line");
  assert.deepEqual(P.nearestSnapLinePoint([0, 0], HV, [5, 1], [5, 1], 2, 0, id), [5, 0]);
  assert.equal(P.nearestSnapLinePoint([0, 0], HV, [5, 1], [5, 1], 2, 0, id, 1.5), null, "an anchor within the range: no snap line point");
});

test("construction geometry: a line's rays, an arc's rest and centre; batches: persistent at once, temporary after the timeout", async () => {
  const doc = board(); const ctx = fakeCtx(doc); C.clearConstruction();
  const g2 = doc.items.get("g2"); const [sh] = C.itemShapes(g2);
  const d = C.shapeConstruction(sh.shape, true, false);
  assert.deepEqual(d, [{ t: "half", a: [60, 0], b: [60, -3] }, { t: "half", a: [60, 3], b: [60, 6] }]);
  assert.equal(C.shapeHit(sh.shape, [60.04, 1]), true); assert.equal(C.shapeHit(sh.shape, [60.06, 1]), false, "HitTest( p, 0 ): half the stroke");
  const arc = { kind: "arc", start: [1, 0], end: [-1, 0], w: 0, filled: false, arc: { c: [0, 0], r: 1, a0: 0, a1: Math.PI, anticlockwise: false } };
  const ad = C.shapeConstruction(arc, true, false);
  assert.deepEqual(ad[0], { t: "arc", c: [0, 0], r: 1, a0: Math.PI, a1: 0, anticlockwise: false }, "the rest of the circle"); assert.deepEqual(ad[1], { t: "pt", p: [0, 0] });
  // grid off: with no construction the cursor lands on g3; with g2's rays accepted, on their crossing with g3
  P.snapCursor(ctx, [0, 0], null, {});
  let s = P.snapCursor(ctx, [60.3, 8.2], null, {}); assert.deepEqual(s.p, [60.3, 8]); assert.equal(s.anchor.t, "onElement");
  C.proposeConstructionItems(C.constructionBatchFor([{ key: "g2", drawables: d }]), true);
  assert.equal(C.constructionBatches().length, 1, "a persistent batch is accepted at once");
  P.state.snapItem = null; s = P.snapCursor(ctx, [60.3, 8.2], null, {}); assert.deepEqual(s.p, [60, 8]); assert.equal(s.anchor.t, "intersection");
  // temporary batches: at most two, accepted when the timeout passes, the same one not proposed twice
  C.clearConstruction();
  const batch = (k) => C.constructionBatchFor([{ key: k, drawables: [{ t: "pt", p: [0, 0] }] }]);
  C.proposeConstructionItems(batch("a"), false, 5); assert.equal(C.constructionBatches().length, 0, "pending");
  await new Promise((r) => setTimeout(r, 20)); assert.equal(C.constructionBatches().length, 1);
  C.proposeConstructionItems(batch("b"), false, 5); await new Promise((r) => setTimeout(r, 20));
  C.proposeConstructionItems(batch("c"), false, 5); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(C.constructionBatches().map((b) => b[0].item), ["b", "c"], "the oldest temporary batch goes");
  C.proposeConstructionItems(batch("d"), false, 5); C.cancelConstructionProposal(); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(C.constructionBatches().map((b) => b[0].item), ["b", "c"], "a cancelled proposal is never accepted");
  // a free construction point is a snappable anchor
  C.clearConstruction(); C.proposeConstructionItems(C.constructionBatchFor([{ key: "g1", drawables: [{ t: "pt", p: [70, 30] }] }]), true);
  P.state.snapItem = null; s = P.snapCursor(ctx, [70.5, 30.3], null, {}); assert.deepEqual(s.p, [70, 30]);
  C.clearConstruction();
});

test("hovering a graphic proposes its rays; snapping to its end does too (ExtensionSnapActivateOnHover)", async () => {
  const doc = board(); const ctx = fakeCtx(doc); C.clearConstruction(); P.snapCursor(ctx, [0, 0], null, {});
  P.snapCursor(ctx, [60.02, 1.5], null, {});
  await new Promise((r) => setTimeout(r, 600));
  const b = C.constructionBatches(); assert.equal(b.length, 1); assert.equal(b[0][0].item, "g2"); assert.equal(b[0][0].drawables[0].d.t, "half");
  C.clearConstruction();
});

test("SNAP_LINE_MANAGER: directions normalised and de-duplicated; a delta along a direction finds it", () => {
  assert.deepEqual(C.normalizeDirection([-2, 0]), [1, 0]); assert.deepEqual(C.normalizeDirection([0, -3]), [0, 1]); assert.deepEqual(C.normalizeDirection([-2, 2]), [1, -1]);
  assert.equal(C.findDirectionIndex(P.angleSnapDirections("45"), [3, -3]), 3);
  assert.equal(C.findDirectionIndex(P.angleSnapDirections("45"), [3, -2]), null);
});

test("PCB_PICKER_TOOL's menu: Grid Origin, Drill Origin, Interactive Delete and the picks get Cancel, the snap layer mode, Zoom, Grid", () => {
  for (const tool of ["gridorigin", "drillorigin", "delete", "pickpoint", "pickitem"]) {
    const c = { editor: "pcb", kinds: [], tool, busy: false, snapAllLayers: false };
    const acts = CM.evaluate(CM.menuFor(c, true), c).filter((e) => e.act).map((e) => e.act);
    assert.deepEqual(acts, ["ACTIONS::cancelInteractive", "PCB_ACTIONS::magneticSnapAllLayers"], tool);
  }
});

test("source: the schematic's +/- zoom keys are gone, the shell's zoom tool zooms out on a right drag", () => {
  const idx = src("editor/index.ts"), ges = src("editor/gestures.ts");
  assert.ok(!/zoomBy\(1\.25\)/.test(idx) && !/zoomBy\(0\.8\)/.test(idx), "no +/- zoom in the schematic (no such KiCad hotkey)");
  assert.ok(/E\.zoomRect = \{ start: \[r\.x, r\.y\], out: true \}/.test(ges), "ZOOM_TOOL: a right drag zooms out");
});

(async () => {
  for (const [name, fn] of queue) {
    try { P.state.snapItem = null; P.state.magnetic = null; await fn(); passed++; console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
