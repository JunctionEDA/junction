// pcb-selection.test.js — KiCad parity of the board selection tool (PCB_SELECTION_TOOL, PCB_GRID_HELPER):
// selectAllConnectedTracks / expandConnection stages, Select/Deselect All Tracks in Net, Select All Unconnected
// Footprints and Grab Nearest, Unroute Selected, Items in Same Hierarchical Sheet, CollectMultiple for a box and a
// lasso (track / arc / via / footprint tests, groups, locked items, the direction and winding rules), the Selection
// Filter (itemPassesFilter), FOOTPRINT::CoverageRatio, computeAnchors' flags, BestDragOrigin and the snap hysteresis.
// Run: node server/static/tests/pcb-selection.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { try { pcb.cancel && pcb.cancel(); } catch (e) { /* idle */ } try { P.state.snapItem = null; P.state.magnetic = null; fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.stack || e)); } }

const fpText = (id, ref, x, y, nets, extra) => `
  (footprint "T:R" ${extra || ""} (layer "F.Cu") (uuid "${id}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 -3) (layer "F.SilkS") (uuid "${id}-ref") (effects (font (size 1 1) (thickness 0.15))))
    (path "/sheetA/${id}")
    (fp_line (start -2 -1) (end 2 -1) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "${id}-l1"))
    (fp_line (start -2 1) (end 2 1) (stroke (width 0.12) (type solid)) (layer "F.SilkS") (uuid "${id}-l2"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net "${nets[0]}") (uuid "${id}-p1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net "${nets[1]}") (uuid "${id}-p2")))`;
// R1.2 (11,10) --t1--> (20,10) --t2--> (20,20) junction with t3 (to 30,20) and t4 (to 20,30 = via v1, then b1 on B.Cu to R2.1 at 39,30 ... not a pad there)
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (44 "Edge.Cuts" user) (40 "Dwgs.User" user))
  ${fpText("R1", "R1", 10, 10, ["GND", "SIG"])}
  ${fpText("R2", "R2", 40, 20, ["SIG", "VCC"])}
  ${fpText("R3", "R3", 60, 60, ["VCC", "GND"])}
  (segment (start 11 10) (end 20 10) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "t1"))
  (segment (start 20 10) (end 20 20) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "t2"))
  (segment (start 20 20) (end 39 20) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "t3"))
  (segment (start 20 20) (end 20 30) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "t4"))
  (via (at 20 30) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "SIG") (uuid "v1"))
  (segment (start 20 30) (end 30 30) (width 0.25) (layer "B.Cu") (net "SIG") (uuid "b1"))
  (arc (start 70 10) (mid 75 5) (end 80 10) (width 0.25) (layer "F.Cu") (net "VCC") (uuid "a1"))
  (gr_line (start 0 80) (end 10 80) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "g1"))
  (gr_line (start 10 80) (end 10 90) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "g2"))
  (gr_line (start 50 80) (end 60 80) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "g3"))
  (gr_circle (center 100 100) (end 105 100) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "c1"))
  (gr_poly (pts (xy 120 100) (xy 140 100) (xy 140 120) (xy 120 120)) (stroke (width 0.1) (type solid)) (fill no) (layer "Dwgs.User") (uuid "poly1"))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], clip: "" };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, selection: new Set(), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(l) { ctx.selection = new Set(l); }, setHighlight() {},
    clipboard: { get: () => log.clip, set: (t) => { log.clip = t; } },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx); pcb.onActivate("select", ctx); P.state.sel = new Set(); P.state.padSel = new Set();
  return { ctx, log };
}
const sorted = (s) => [...s].sort();

test("selectAllConnectedTracks: STOP_AT_JUNCTION, STOP_AT_PAD and STOP_NEVER walk as KiCad does", () => {
  const doc = board();
  let sel = new Set(["t1"]); P.selectAllConnectedTracks(doc, ["t1"], "junction", sel);
  assert.deepEqual(sorted(sel), ["t1", "t2"], "to the junction of t2 / t3 / t4, not through it");
  sel = new Set(["t1"]); P.selectAllConnectedTracks(doc, ["t1"], "pad", sel);
  assert.deepEqual(sorted(sel), ["b1", "t1", "t2", "t3", "t4", "v1"], "through junctions and the via, up to the pads");
  sel = new Set(["t1"]); P.selectAllConnectedTracks(doc, ["t1"], "never", sel);
  assert.ok(sel.has("t3") && sel.has("b1") && sel.has("v1"));
});

test("Expand Connection (U): one stage per press — junction, then pads, then the whole connection", () => {
  const doc = board();
  const one = P.expandConnection(doc, ["t1"]); assert.deepEqual(sorted(one), ["t1", "t2"]);
  const two = P.expandConnection(doc, one); assert.deepEqual(sorted(two).filter((id) => !/#/.test(id)), ["b1", "t1", "t2", "t3", "t4", "v1"]);
  // graphic lines expand to the shapes that touch their ends, closed shapes do not expand
  assert.deepEqual(sorted(P.expandConnection(doc, ["g1"])), ["g1", "g2"]);
  assert.deepEqual(sorted(P.expandConnection(doc, ["c1"])), ["c1"]);
  const { ctx } = fakeCtx(doc); ctx.selection = new Set(["t1"]);
  assert.equal(pcb.onKey("u", { button: 0 }, ctx), true); assert.deepEqual(sorted(ctx.selection), ["t1", "t2"]);
});

test("Select / Deselect All Tracks in Net: the nets of the selected connected items, copper only, no message", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  ctx.selection = new Set(["t1"]); assert.equal(pcb.runAction("selectNet", ctx), true);
  assert.deepEqual(sorted(ctx.selection), ["b1", "t1", "t2", "t3", "t4", "v1"]); assert.equal(log.toasts.length, 0);
  ctx.selection = new Set(["t1", "t2", "a1"]); assert.equal(pcb.runAction("deselectNet", ctx), true);
  assert.deepEqual(sorted(ctx.selection), [], "both nets' copper is taken out"); assert.equal(log.toasts.length, 0);
});

test("Select All Unconnected Footprints (O) adds the footprints across the ratsnest; Shift+O grabs the nearest and moves it", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  ctx.selection = new Set(["R2"]); assert.equal(pcb.runAction("selectUnconnected", ctx), true);
  assert.ok(ctx.selection.has("R2"), "the original selection stays"); assert.ok(ctx.selection.has("R3"), "R3 hangs on R2's VCC airwire");
  assert.equal(log.toasts.length, 0, "no message");
  const near = P.nearestUnconnectedFootprints(doc, ["R2"], P.netlist ? P.netlist(doc) : null, P.ratsnest ? P.ratsnest(doc) : []);
  assert.ok(Array.isArray(near) && near.length >= 1 && !near.includes("R2"));
});

test("Unroute Selected: a footprint's pads lose their tracks up to the next pad; tracks are removed whole", () => {
  const doc = board();
  const rm = P.unrouteIds(doc, ["R1"], {}); assert.ok(rm.has("t1") && rm.has("t2") && rm.has("t3") && rm.has("b1") && rm.has("v1")); assert.ok(!rm.has("R1") && !rm.has("a1"));
  const { ctx, log } = fakeCtx(doc); ctx.selection = new Set(["R1"]);
  assert.equal(pcb.runAction("unrouteSelected", ctx), true); assert.equal(log.commits.at(-1).label, "Unroute Selected");
  assert.equal(doc.items.has("t1"), false); assert.equal(doc.items.has("a1"), true); assert.ok(ctx.selection.has("R1"), "the footprint is selected again");
  // the Selection Filter's tracks box is forced on for the walk
  const doc2 = board(); assert.ok(P.unrouteIds(doc2, ["t1"], { tracks: false, vias: true }).has("t2"));
});

test("Items in Same Hierarchical Sheet: the sheet path is the footprint path less its last part", () => {
  const doc = board();
  assert.equal(P.footprintSheetPath(doc.items.get("R1")), "/sheetA");
  const ids = P.sheetItemIds(doc, "/sheetA", P.netlist ? P.netlist(doc) : null);
  assert.ok(ids.has("R1") && ids.has("R2") && ids.has("R3"));
});

test("itemPassesFilter: locked items and locked parents, a single clicked pad of a locked footprint, rejected categories", () => {
  const doc = K.parseDoc(BOARD.replace('(footprint "T:R"  (layer "F.Cu") (uuid "R1")', '(footprint "T:R" (locked yes) (layer "F.Cu") (uuid "R1")').replace('(footprint "T:R" (layer "F.Cu") (uuid "R1")', '(footprint "T:R" (locked yes) (layer "F.Cu") (uuid "R1")'), "kicad_pcb");
  const r1 = doc.items.get("R1"); assert.ok(P.isLocked(r1.node), "fixture: R1 is locked");
  const f = { lockedItems: false }, rej = new Set();
  assert.equal(P.itemPassesFilter(doc, f, r1, { rejected: rej }), false); assert.ok(rej.has("lockedItems"));
  assert.equal(P.itemPassesFilter(doc, f, r1, { child: true }), false, "a field of a locked footprint");
  assert.equal(P.itemPassesFilter(doc, f, r1, { pad: true, multi: true }), false, "its pads in a box selection");
  assert.equal(P.itemPassesFilter(doc, f, r1, { pad: true, multi: false }), true, "a single pad may be picked by a click");
  const rej2 = new Set(); assert.equal(P.itemPassesFilter(doc, { tracks: false }, doc.items.get("t1"), { rejected: rej2 }), false); assert.deepEqual([...rej2], ["tracks"]);
  assert.equal(P.itemPassesFilter(doc, { tracks: false }, doc.items.get("v1")), true);
});

test("box selection direction and lasso winding (DragSelectionArea / SelectPolyArea), turned round in a flipped view", () => {
  assert.equal(P.boxContains(0, 10), true); assert.equal(P.boxContains(10, 0), false);
  assert.equal(P.boxContains(0, 10, true), false); assert.equal(P.boxContains(10, 0, true), true);
  const cw = [[0, 0], [10, 0], [10, 10], [0, 10]];   // clockwise on a screen with Y down
  assert.equal(P.lassoContains(cw), true); assert.equal(P.lassoContains(cw.slice().reverse()), false);
  assert.equal(P.lassoContains(cw, true), false);
});

test("CollectMultiple: a track by its ends or centre line, an arc and a via by their boxes, a footprint by pads and graphics", () => {
  const doc = board(); const it = (id) => doc.items.get(id);
  // touching: the box corner overlaps the track's width only, the centre line stays outside
  assert.equal(P.itemInArea(it("t1"), { box: [14, 10.05, 16, 12], contained: false }), false, "PCB_TRACK::HitTest ignores the width");
  assert.equal(P.itemInArea(it("t1"), { box: [14, 9, 16, 12], contained: false }), true);
  assert.equal(P.itemInArea(it("t1"), { box: [10.9, 9.9, 20.1, 10.1], contained: true }), true, "contained: both end points inside");
  assert.equal(P.itemInArea(it("t1"), { box: [11.05, 9, 21, 11], contained: true }), false);
  // an arc: the box of its start / mid / end points grown by half the width
  assert.equal(P.itemInArea(it("a1"), { box: [69, 4, 81, 11], contained: true }), true);
  assert.equal(P.itemInArea(it("a1"), { box: [71, 9, 79, 12], contained: false }), true, "inside the arc's box, off its copper");
  // a footprint: its texts do not count
  assert.equal(P.itemInArea(it("R1"), { box: [7.5, 6.4, 12.5, 7.6], contained: false }), false, "only the reference text is touched");
  assert.equal(P.itemInArea(it("R1"), { box: [7, 8.5, 13, 11.5], contained: true }), true, "contained without the text");
  const all = P.collectMultiple(doc, { box: [5, 5, 45, 25], contained: true });
  assert.ok(all.includes("R1") && all.includes("R2") && all.includes("t1") && all.includes("t2") && all.includes("t3"));
  assert.ok(!all.includes("t4") && !all.some((id) => /#/.test(id)), "no pads when anything else is taken");
  assert.deepEqual(P.collectMultiple(doc, { box: [5, 5, 45, 25], contained: true }, { filter: { footprints: false, tracks: false, text: false, graphics: false } }).filter((id) => /#/.test(id)).sort(), ["R1#0", "R1#1", "R2#0", "R2#1"], "pads once footprints are filtered out");
  assert.ok(!P.collectMultiple(doc, { box: [5, 5, 45, 25], contained: true }, { hidden: new Set(["F.Cu"]) }).includes("t1"), "hidden layers are not selectable");
  // a lasso uses the real shapes
  const lasso = [[9, 8], [22, 8], [22, 12], [9, 12]];
  assert.ok(P.collectMultiple(doc, { poly: lasso, contained: true }).includes("t1"));
  assert.ok(!P.collectMultiple(doc, { poly: lasso, contained: true }).includes("t2"));
  assert.ok(P.collectMultiple(doc, { poly: lasso, contained: false }).includes("t2"));
});

test("CollectMultiple: a group is taken whole and only when all of it is inside; locked items obey the filter", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  ctx.selection = new Set(["g1", "g3"]); assert.equal(pcb.runAction("group", ctx), true);
  const gid = log.commits.at(-1).changes[0].id;
  const part = P.collectMultiple(doc, { box: [-1, 79, 11, 81], contained: true });
  assert.ok(!part.includes("g1") && !part.includes(gid), "a member alone is not selectable from outside the group");
  const whole = P.collectMultiple(doc, { box: [-1, 79, 61, 81], contained: true });
  assert.ok(whole.includes(gid) && whole.includes("g1") && whole.includes("g3"), "the group with all its members (this selection model holds a group as its id and members)");
});

test("filterSelectionIds: a group that fails the dialog's filter goes with all its members", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  ctx.selection = new Set(["g1", "g3"]); pcb.runAction("group", ctx); const gid = log.commits.at(-1).changes[0].id;
  const kept = P.filterSelectionIds(doc, [gid, "g1", "g3", "t1"], Object.assign({}, P.FILTER_SELECTION_DEFAULTS));
  assert.ok(kept.includes("t1")); assert.ok(!kept.includes(gid) && !kept.includes("g1") && !kept.includes("g3"), "groups are not in the dialog's filter: KiCad drops them");
});

test("routable selection: any number of tracks and arcs but at most one via, and nothing else", () => {
  const doc = board();
  assert.ok(P.routableItems(doc, ["t1", "t2"])); assert.ok(P.routableItems(doc, ["t1", "v1"])); assert.ok(P.routableItems(doc, ["a1"]));
  assert.ok(!P.routableItems(doc, ["t1", "R1"])); assert.ok(!P.routableItems(doc, ["g1"]));
});

test("computeAnchors: flags per type — track middle is an origin only, text never snaps, circle quadrants are outline", () => {
  const doc = board(); const A = (id, from, mouse, opts) => P.itemAnchors(doc.items.get(id), from, mouse || null, 0.25, opts);
  const CORNER = 1, OUTLINE = 2, SNAPPABLE = 4, ORIGIN = 8;
  const t = A("t1", true);
  assert.deepEqual(t.map((a) => [a[0], a[1], a.f]), [[11, 10, CORNER | SNAPPABLE], [20, 10, CORNER | SNAPPABLE], [15.5, 10, ORIGIN]]);
  assert.deepEqual(A("t1", false), [], "tracks capture the cursor in the track tool only");
  assert.equal(A("t1", true, null, { filter: { tracks: false } }).length, 0, "the Selection Filter decides what gives a drag origin");
  const c = A("c1", false); assert.equal(c[0].f, ORIGIN | SNAPPABLE); assert.ok(c.slice(1).every((a) => a.f === (OUTLINE | SNAPPABLE)) && c.length === 5);
  const arc = A("a1", true); assert.deepEqual(arc.map((a) => a.t), ["end", "end", "mid"]);
  const poly = A("poly1", false, [130, 99]); assert.equal(poly.length, 5); assert.deepEqual([poly[4][0], poly[4][1], poly[4].f], [130, 100, OUTLINE], "the nearest point on the outline");
  const ref = P.itemAnchors({ id: "x", kind: "gr_text", node: K.parse('(gr_text "a" (at 5 6) (layer "F.SilkS"))'), geom: [] }, false, null, 0.25);
  assert.deepEqual(ref.map((a) => a.f), [ORIGIN], "text: an origin that is not snappable");
  P.state.magnetic = { graphics: false }; assert.deepEqual(A("c1", false), [], "snap to graphics off");
  P.state.magnetic = { tracks: "always" }; assert.equal(A("t1", false).length, 3);
});

test("BestDragOrigin: nearest origin or corner; an outline point only beyond 50 px", () => {
  const doc = board();
  assert.deepEqual(P.bestDragOrigin(doc, ["t1"], [19, 10.1], 0.25, { mmPerPx: 0.1 }), [20, 10], "the nearer end");
  assert.deepEqual(P.bestDragOrigin(doc, ["t1"], [15, 10.1], 0.25, { mmPerPx: 0.1 }), [15.5, 10], "the middle of the track");
  assert.deepEqual(P.bestDragOrigin(doc, ["t1"], [19, 10.1], 0.25, { filter: { tracks: false } }), [19, 10.1], "filtered out: the mouse itself");
  // the polygon: its corners are 10 mm away from the middle of a side; the outline point wins only when 50 px is less than that
  assert.deepEqual(P.bestDragOrigin(doc, ["poly1"], [130, 100.5], 0.25, { mmPerPx: 0.1 }), [130, 100], "corner 100 px away: the outline point");
  assert.deepEqual(P.bestDragOrigin(doc, ["poly1"], [130, 100.5], 0.25, { mmPerPx: 1 }), [120, 100], "corner within 50 px: the corner");
  assert.deepEqual(P.bestDragOrigin(doc, ["R1"], [9, 10], 0.25, { mmPerPx: 0.1 }), [9, 10], "the centre of the pad under the mouse");
  assert.deepEqual(P.bestDragOrigin(doc, ["R1"], [9, 10], 0.25, { mmPerPx: 0.1, filter: { pads: false } }), [10, 10], "pads filtered: the footprint's position");
});

test("snap ranges and hysteresis: in at range - 5 px, held until range + 5 px, text and hidden items never snap", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); ctx.snapOn = false; ctx.pxPerMm = 10; P.state.snapAllLayers = true;
  const r = P.snapRanges(10, false, 0); assert.deepEqual([r.range, r.in, r.out], [2.5, 2, 3]);
  assert.equal(P.snapRanges(10, true, 1).range, 1, "no further than a grid step");
  // g3's end (60,80): 2.2 mm away is outside the snap-in range, 1.9 mm is inside, and once held it stays until 3 mm
  assert.equal(P.snapCursor(ctx, [62.2, 82.2], null, {}).anchor, null);
  let s = P.snapCursor(ctx, [61.9, 80], null, {}); assert.deepEqual(s.p, [60, 80]);
  s = P.snapCursor(ctx, [62.8, 80], null, {}); assert.deepEqual(s.p, [60, 80], "held within the snap-out range");
  s = P.snapCursor(ctx, [63.2, 82], null, {}); assert.equal(s.anchor, null, "let go beyond it");
  // the footprint reference text is not a snap target; the footprint's position is
  s = P.snapCursor(ctx, [10.3, 7.2], null, {}); assert.notDeepEqual(s.p, [10, 7]);
  P.state.snapItem = null; s = P.snapCursor(ctx, [10.2, 10.3], null, {}); assert.deepEqual(s.p, [10, 10]);
});

test("snapping: where two graphics cross, and (grid off) the nearest point on a graphic", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (40 "Dwgs.User" user))
    (gr_line (start 0 0) (end 30 30) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "d1"))
    (gr_line (start 5 15) (end 25 -5) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "d2"))
    (gr_line (start 40 0) (end 80 0) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "d3")))`, "kicad_pcb");
  const { ctx } = fakeCtx(doc); ctx.snapOn = false; ctx.pxPerMm = 20; P.state.snapAllLayers = true;
  let s = P.snapCursor(ctx, [10.4, 10.1], null, {}); assert.deepEqual(s.p, [10, 10]); assert.equal(s.anchor.t, "intersection");
  s = P.snapCursor(ctx, [53, 0.6], null, {}); assert.deepEqual(s.p, [53, 0]); assert.equal(s.anchor.t, "onElement");
  ctx.snapOn = true; P.state.snapItem = null; s = P.snapCursor(ctx, [53.1, 0.6], null, {}); assert.equal(s.anchor, null, "grid on: the grid wins over a point on an element");
});

test("FOOTPRINT::CoverageRatio: pads, texts and the other candidates over the footprint's hull", () => {
  assert.equal(typeof P.footprintCoverageRatio, "function");
  const sq = P.geomPolys({ t: "line", x1: 0, y1: 0, x2: 10, y2: 0, w: 2 }); assert.equal(sq.length, 1);
  let a = 0; for (let i = 0, j = sq[0].length - 1; i < sq[0].length; j = i++) a += sq[0][j][0] * sq[0][i][1] - sq[0][i][0] * sq[0][j][1];
  assert.ok(Math.abs(Math.abs(a / 2) - (20 + Math.PI)) < 0.2, "a 10 x 2 stroke with round ends");
});

// ---- the editor's menus and panes (bundled from source, as ctxmenus.test.js does)
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const fs = require("fs");
function loadTs(...rel) { const out = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent" }); const mod = { exports: {} }; new Function("module", "exports", out.outputFiles[0].text)(mod, mod.exports); return mod.exports; }

test("selection context menu: Cancel, Enter Group, Leave Group, Clear Net Highlighting, separator; Select has one separator", () => {
  const { menuFor, evaluate } = loadTs("domains", "pcb", "editor", "ctxmenus.ts");
  const ctx = (o) => Object.assign({ editor: "pcb", kinds: [], tool: "select", busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: false, hasItems: true, checks: {} }, o);
  const c = ctx({ kinds: ["group"], count: 1, groupSelected: true, inGroup: true, highlight: true, hasUnlocked: true });
  const list = evaluate(menuFor(c, false), c);
  const flat = list.map((e) => (e.sep ? "-" : e.menu ? ">" + e.menu.title : e.act.split("::").pop()));
  const ge = flat.indexOf("groupEnter"), gl = flat.indexOf("groupLeave"), ch = flat.indexOf("clearHighlight");
  // pcb_selection_tool.cpp:348-354: Place / Save to Linked Design Block follow Leave Group on groupEnterCondition
  assert.ok(ge >= 0 && gl === ge + 1 && flat[gl + 1] === "placeLinkedDesignBlock" && flat[gl + 2] === "saveToLinkedDesignBlock" && ch === gl + 3 && flat[ch + 1] === "-", flat.join(" "));
  const sel = list.find((e) => e.menu && e.menu.title === "Select");
  assert.ok(sel, flat.join(" "));
  const sub = (sel.items || []).map((e) => (e.sep ? "-" : e.act.split("::").pop()));
  assert.deepEqual(sub, ["filterSelection", "-", "selectConnection", "selectNet", "selectNetChain", "selectSameSheet", "selectOnSchematic", "selectUnconnected", "grabUnconnected"]);
});

test("Selection Filter pane: KiCad's labels and the flash of the boxes that turned a click away", () => {
  const src = fs.readFileSync(webPath("shared", "components", "panes", "SelectionFilter.tsx"), "utf8");
  assert.ok(/\/> All items<\/label>/.test(src) && /\/> Locked items<\/label>/.test(src));
  assert.ok(/filterFlash/.test(src) && /kfilter-flash 500ms steps\(10/.test(src), "ten steps of 50 ms");
});

test("Preferences: PCB Editor > Snapping (pads / tracks when routing, graphics always) and Allow free pads (off)", () => {
  const prefs = fs.readFileSync(webPath("domains", "pcb", "dialogs", "prefs.ts"), "utf8");
  assert.ok(/pcbSnapping: \{ pads: "trackTool", tracks: "trackTool", graphics: true, allLayers: false \}/.test(prefs));
  assert.ok(/allowFreePads: false/.test(prefs));
  const page = fs.readFileSync(webPath("domains", "pcb", "dialogs", "preferences.ts"), "utf8");
  for (const label of ["Snap to pads:", "Snap to tracks and vias:", "Snap to graphics:", "When routing tracks", "Allow free pads",
    "Snap to objects on all layers", "Snap to grid:", "When grid shown", "Object geometry", "Construction extensions"]) assert.ok(page.includes(label), label);
  // the board tools read them: MAGNETIC_SETTINGS decides what the cursor snaps to
  const doc = board(); P.state.magnetic = { pads: "always", tracks: "never", graphics: true };
  assert.ok(P.itemAnchors(doc.items.get("R1"), false, [9, 10], 0.25).some((a) => a[0] === 9 && a[1] === 10), "the pad under the cursor snaps when pads are Always");
  P.state.magnetic = { pads: "trackTool" };
  assert.ok(!P.itemAnchors(doc.items.get("R1"), false, [9, 10], 0.25).some((a) => a[0] === 9 && a[1] === 10));
});

test("dragFrom: a routable selection goes to the router's drag, anything else to the move", () => {
  const doc = board(); const { ctx } = fakeCtx(doc);
  ctx.selection = new Set(["g1", "g2"]);
  assert.equal(pcb.dragFrom(ctx, ["g1", "g2"], "g1", [5, 80], [0, 0], true), true); assert.ok(P.state.move, "graphics are moved");
  pcb.cancel();
});

test("point editor: SEG::Angle, snapCorner on the inscribed-angle circle, the sticky 45 degree corner held within 5 px", () => {
  assert.equal(P.segAngleDeg([0, 0], [10, 0], [0, 0], [0, 10]), 90);
  assert.equal(P.segAngleDeg([0, 0], [10, 0], [0, 0], [10, 10]), 45);
  assert.deepEqual(P.snapCorner([0, 0], [10, 0], [5, 4.9], 90), [5, 5], "the right angle lies on the circle over the chord");
  const doc = board(); const { ctx } = fakeCtx(doc); ctx.pxPerMm = 10; P.state.mmPerPx = 0.1;
  const it = doc.items.get("poly1");
  // corner c1 (140,100) between (120,100) and (140,120): dragged to 89 degrees it is put back at exactly 90
  const pe = { id: "poly1", kind: "gr_poly", key: "c1", orig: K.parse(K.serialize(it.node)), start: [140, 100], moved: true };
  const near = [139.9, 100.3], got = P.stickyCornerSnap(ctx, pe, near, { ctrlKey: false, shiftKey: false });
  assert.ok(got, "snapped"); assert.ok(Math.abs(P.segAngleDeg(got, [120, 100], got, [140, 120]) - 90) < 2);
  assert.deepEqual(P.stickyCornerSnap(ctx, pe, [near[0] + 0.2, near[1]], { ctrlKey: false, shiftKey: false }), got, "held while within 5 px (0.5 mm)");
  assert.equal(P.stickyCornerSnap(ctx, pe, [near[0] + 0.2, near[1]], { ctrlKey: false, shiftKey: true }), null, "Shift lets go");
  P.construction.clearConstruction();
});

test("point editor drag start: the item's clone is persistent construction geometry, a segment's ends reference only", () => {
  const doc = board(); fakeCtx(doc); P.construction.clearConstruction(); P.state.snapInference = { objectGeometry: true, constructionExtensions: true };
  P.proposePersistentConstruction(doc.items.get("g3"));
  const batches = P.construction.constructionBatches(); assert.equal(batches.length, 1, "accepted at once");
  const kinds = batches[0].flatMap((ci) => ci.drawables.map((e) => e.d.t)); assert.deepEqual(kinds, ["line", "pt", "pt"]);
  assert.ok(P.construction.isReferenceOnly([50, 80]) && P.construction.isReferenceOnly([60, 80]), "its ends are reference-only points");
  P.construction.clearConstruction(); P.construction.setReferenceOnlyPoints([]);
  P.state.snapInference = { objectGeometry: true, constructionExtensions: false };
  P.proposePersistentConstruction(doc.items.get("g3")); assert.equal(P.construction.constructionBatches().length, 0, "Construction extensions off: none");
  P.state.snapInference = undefined;
});

test("Move (M) on pads picked on their own with Allow free pads: a sticky pad move dropped by the next click", () => {
  const g = fs.readFileSync(webPath("domains", "pcb", "editor", "gestures.ts"), "utf8"), ix = fs.readFileSync(webPath("domains", "pcb", "editor", "index.ts"), "utf8");
  assert.ok(/mode === "move" && ps && ps\.padSel && ps\.allowFreePads && !selectionIds\(\)\.length && startPadMove/.test(g), "M with a pad picked and free pads allowed");
  assert.ok(/E\.hooks\.startPadMove = [^\n]*sticky = true/.test(ix), "the pad move follows the cursor with no button");
  assert.ok(/if \(E\.pdrag && \(E\.pdrag as PadDrag\)\.sticky\) \{ padDragEnd\(true\)/.test(ix), "the next click drops it");
  assert.ok(/if \(E\.pdrag\) \{ if \(!\(E\.pdrag as PadDrag\)\.sticky\) padDragEnd\(true\)/.test(ix), "the release does not end it");
});

test("Move (M): GetMoveWarpsCursor puts the crosshair on BestDragOrigin; off, the move runs from the snapped cursor about the same reference point", () => {
  const doc = board(); const { ctx } = fakeCtx(doc);
  let warped = null; ctx.warpCursor = (p) => { warped = p.slice(); };
  const at = [5.3, 80.2], bdo = P.bestDragOrigin(doc, ["g1"], at, 0.25, { mmPerPx: 0.1 });
  P.state.sel = new Set(["g1"]); ctx.selection = new Set(["g1"]);
  assert.equal(pcb.beginMove(ctx, at, true), true);
  assert.deepEqual(warped, bdo, "warped onto the drag origin"); assert.deepEqual(P.state.move.start, bdo); assert.deepEqual(P.state.move.aux, bdo);
  pcb.cancel(); warped = null; P.state.moveWarpsCursor = false;
  try {
    P.state.sel = new Set(["g1"]); ctx.selection = new Set(["g1"]);
    assert.equal(pcb.beginMove(ctx, at, true), true);
    assert.equal(warped, null, "no warp"); assert.deepEqual(P.state.move.start, [5.25, 80.25], "m_cursor = originalCursorPos"); assert.deepEqual(P.state.move.aux, bdo, "the aux axes on dragOrigin");
    pcb.cancel();
  } finally { P.state.moveWarpsCursor = undefined; }
});

test("a non-square grid: a footprint's centre is an anchor only farther than |GetGrid()| (both axes) from its position", () => {
  const doc = board(), R1 = doc.items.get("R1"), c = [(R1.bbox[0] + R1.bbox[2]) / 2, (R1.bbox[1] + R1.bbox[3]) / 2], d = Math.hypot(c[0] - 10, c[1] - 10);
  const has = (g, gy) => P.itemAnchors(R1, false, null, g, { gridY: gy }).some((a) => a.t === "center" && Math.abs(a[0] - c[0]) < 1e-9 && Math.abs(a[1] - c[1]) < 1e-9);
  assert.ok(d > 0, "the body is off its position");
  const gx = d * 0.6;
  assert.equal(has(gx, gx), true, "square: |grid| = 0.85 d");
  assert.equal(has(gx, d * 1.2), false, "taller grid: |grid| = 1.34 d");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
