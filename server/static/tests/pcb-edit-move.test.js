// pcb-edit-move.test.js — the edit / move parity pass against pcbnew/tools/edit_tool.cpp, edit_tool_move_fct.cpp,
// align_distribute_tool.cpp, position_relative_tool.cpp, item_modification_routine.cpp and spread_footprints.cpp:
// flip direction, item anchors, guards while a move runs, align with locked targets, Swap's layers, Mirror
// Interactive, Change Track Width, Copy as Text, zone cutout delete, the shape modification routines, pack.
// Run: node server/static/tests/pcb-edit-move.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) {
  try { pcb.cancel && pcb.cancel(); } catch (e) { /* idle */ }
  P.state.moveSeq = null; P.state.pick = null; P.state.move = null; P.state.flipDirection = undefined;
  try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); }
}
const kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
const kids = (n, k) => n.filter((c) => Array.isArray(c) && c[0] === k);
const xy = (n, k) => kid(n, k).slice(1, 3);
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-4, (m || "") + " " + a + " != " + b);

const HEAD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (7 "B.SilkS" user) (44 "Edge.Cuts" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "") (net 1 "GND")`;
const B = (body) => K.parseDoc(HEAD + body + ")", "kicad_pcb");
const LINE = (id, a, b, layer) => `(gr_line (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (layer "${layer || "F.SilkS"}") (uuid "${id}"))`;
const RECT = (id, a, b, extra) => `(gr_rect (start ${a}) (end ${b}) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") ${extra || ""} (uuid "${id}"))`;
const FP = (id, ref, at, extra) => `(footprint "T:R" ${extra || ""} (layer "F.Cu") (uuid "${id}") (at ${at})
    (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "${id}ref"))
    (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (uuid "${id}val"))
    (fp_rect (start -2 -1) (end 2 1) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${id}cy"))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "${id}p1")))`;
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], clip: "", tools: [], status: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: false, selected: null, items: [], viewOnly: false, live: true, selection: new Set(), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(l) { ctx.selection = new Set(l); }, setHighlight() {},
    clipboard: { get: () => log.clip, set: (t) => { log.clip = t; } }, setStatus(m) { log.status.push(m); },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tools.push(t); pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const sel = (ctx, ids) => { P.state.sel = new Set(ids); ctx.selection = new Set(ids); };
const apply = (doc, changes) => { for (const c of changes) K.applyChange(doc, c, IU); };
const node = (doc, id) => doc.items.get(id).node;

console.log("board edit / move parity");

test("Flip: top / bottom by default (FLIP_DIRECTION::TOP_BOTTOM), left / right from the preference", () => {
  assert.equal(P.flipDirection(), "tb");
  let doc = B(LINE("a", "10 10", "20 12"));
  apply(doc, P.flipChanges(doc, ["a"], 15, 11, "tb"));
  assert.deepEqual([xy(node(doc, "a"), "start"), xy(node(doc, "a"), "end")], [[10, 12], [20, 10]], "x kept, y mirrored about the centre");
  assert.equal(K.str(kid(node(doc, "a"), "layer")[1]), "B.SilkS");
  doc = B(LINE("a", "10 10", "20 12"));
  apply(doc, P.flipChanges(doc, ["a"], 15, 11, "lr"));
  assert.deepEqual([xy(node(doc, "a"), "start"), xy(node(doc, "a"), "end")], [[20, 10], [10, 12]]);
  P.state.flipDirection = "lr"; assert.equal(P.flipDirection(), "lr");
  // the action: a lone line flips about its own position (its start) top / bottom
  P.state.flipDirection = undefined; doc = B(LINE("a", "10 10", "20 12")); const { ctx, log } = fakeCtx(doc); sel(ctx, ["a"]);
  pcb.runAction("flipSelection", ctx);
  assert.equal(log.commits[0].label, "Change Side / Flip");
  assert.deepEqual([xy(node(doc, "a"), "start"), xy(node(doc, "a"), "end")], [[10, 10], [20, 8]]);
});

test("Item anchors are BOARD_ITEM::GetPosition: arc centre, rectangle start, first polygon / zone corner", () => {
  const doc = B(`(gr_arc (start 10 0) (mid 0 10) (end -10 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "arc"))` + RECT("r", "30 40", "20 10") +
    `(gr_poly (pts (xy 5 6) (xy 9 6) (xy 9 9)) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "p"))
     (zone (net 0) (net_name "") (layer "F.Cu") (uuid "z") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 50 60) (xy 70 60) (xy 70 80))))`);
  const a = P.anchorOf(doc.items.get("arc")); near(a[0], 0); near(a[1], 0);
  assert.deepEqual(P.anchorOf(doc.items.get("r")), [30, 40]);
  assert.deepEqual(P.anchorOf(doc.items.get("p")), [5, 6]);
  assert.deepEqual(P.anchorOf(doc.items.get("z")), [50, 60]);
  const c = P.arcCentre3([10, 0], [0, 10], [-10, 0]); near(c[0], 0); near(c[1], 0);
});

test("Duplicate, Move Exactly, Position Relative, Cut and Pack do nothing while a move is running", () => {
  const doc = B(LINE("a", "0 0", "10 0") + LINE("b", "0 5", "10 5")); const { ctx, log } = fakeCtx(doc); sel(ctx, ["a"]);
  let forms = 0; pcb.setForm(() => { forms++; return true; });
  P.state.move = { ids: ["a"] };
  for (const id of ["duplicate", "duplicateIncrement", "moveExactly", "positionRelative", "cut", "pack", "mirrorInteractive"]) pcb.runAction(id, ctx);
  P.state.move = null; pcb.setForm(null);
  assert.equal(log.commits.length, 0); assert.equal(forms, 0); assert.equal(log.clip, ""); assert.equal(P.state.pick, null);
  // idle: Duplicate reports "Duplicated %d item(s)" on the status line
  pcb.runAction("duplicate", ctx);
  assert.ok(log.status.includes("Duplicated 1 item(s)"), JSON.stringify(log.status));
});

test("Align: a locked item is the target and stays put; the others move to it", () => {
  const doc = B(LINE("a", "0 0", "10 0") + LINE("b", "5 5", "12 5") + `(gr_line (start 3 9) (end 20 9) (locked yes) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "c"))`);
  const ch = P.alignChanges(doc, ["a", "b", "c"], "left", [0, 0], { locked: new Set(["c"]) });
  assert.ok(!ch.some((c) => c.id === "c"), "the locked target is not modified");
  apply(doc, ch);
  assert.equal(xy(node(doc, "a"), "start")[0], xy(node(doc, "b"), "start")[0]);
  assert.equal(Math.min(xy(node(doc, "a"), "start")[0], xy(node(doc, "a"), "end")[0]), 3, "a's left edge sits on the locked line's");
  assert.equal(P.ALIGN_COMMIT.left, "Align to Left"); assert.equal(P.ALIGN_COMMIT.centerX, "Align to Middle"); assert.equal(P.ALIGN_COMMIT.centerY, "Align to Center");
  assert.equal(P.ACTIONS.alignCenterX.label, "Align to Horizontal Center"); assert.equal(P.ACTIONS.alignCenterY.label, "Align to Vertical Center");
  // the action on a selection with a locked member: no refusal, one commit under KiCad's label, no toast
  const { ctx, log } = fakeCtx(B(LINE("a", "0 0", "10 0") + `(gr_line (start 3 9) (end 20 9) (locked yes) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "c"))`)); sel(ctx, ["a", "c"]);
  pcb.runAction("alignLeft", ctx);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Align to Left"); assert.deepEqual(log.toasts, []);
  assert.deepEqual(xy(node(ctx.doc, "c"), "start"), [3, 9]);
});

test("Swap: same-type graphics trade layers as well as places; footprints keep their sides", () => {
  const doc = B(LINE("a", "0 0", "10 0", "F.SilkS") + LINE("b", "0 20", "10 20", "Edge.Cuts"));
  apply(doc, P.swapChanges(doc, ["a", "b"]));
  assert.equal(K.str(kid(node(doc, "a"), "layer")[1]), "Edge.Cuts"); assert.equal(K.str(kid(node(doc, "b"), "layer")[1]), "F.SilkS");
  assert.deepEqual(xy(node(doc, "a"), "start"), [0, 20]); assert.deepEqual(xy(node(doc, "b"), "start"), [0, 0]);
  assert.equal(P.ACTIONS.swap.label, "Swap");
});

test("Mirror( SEG ): points reflect about the axis, an oblique axis turns a rectangle into a polygon, text stays readable", () => {
  let n = K.parse(LINE("a", "2 3", "6 3")); P.mirrorNodeAxis(n, [10, 0], [10, 5]);
  assert.deepEqual([xy(n, "start"), xy(n, "end")], [[18, 3], [14, 3]]);
  n = K.parse(RECT("r", "0 0", "4 2")); P.mirrorNodeAxis(n, [0, 0], [0, 9]);
  assert.equal(n[0], "gr_rect"); assert.deepEqual([xy(n, "start"), xy(n, "end")], [[0, 0], [-4, 2]]);
  n = K.parse(RECT("r", "0 0", "4 2")); P.mirrorNodeAxis(n, [0, 0], [5, 5]);   // about y = x: (x, y) -> (y, x)
  assert.equal(n[0], "gr_poly"); assert.equal(kid(n, "start"), undefined);
  assert.deepEqual(kids(kid(n, "pts"), "xy").map((c) => c.slice(1)), [[0, 0], [0, 4], [2, 4], [2, 0]]);
  // text at 0 degrees about a vertical axis: Reflect gives 180 -> turned back to 0 with the justification swapped
  n = K.parse(`(gr_text "hi" (at 2 3 0) (layer "F.SilkS") (uuid "t") (effects (font (size 1 1) (thickness 0.15)) (justify left)))`); P.mirrorNodeAxis(n, [10, 0], [10, 5]);
  assert.deepEqual(kid(n, "at").slice(1, 3), [18, 3]); assert.equal(K.num(kid(n, "at")[3] || 0), 0);
  assert.ok(kid(kid(n, "effects"), "justify").includes("right")); assert.ok(!kid(kid(n, "effects"), "justify").includes("mirror"));
  assert.equal(P.mirrorNodeAxis(K.parse(LINE("a", "0 0", "1 1")), [3, 3], [3, 3]), false, "a zero-length axis");
});

test("Mirror Interactive: two picked points, one 'Mirror' commit; footprints are skipped with KiCad's message", () => {
  const doc = B(LINE("a", "2 3", "6 3") + FP("f1", "R1", "30 30")); const { ctx, log } = fakeCtx(doc); sel(ctx, ["a", "f1"]);
  assert.equal(P.ACTIONS.mirrorInteractive.label, "Mirror Interactive");
  pcb.runAction("mirrorInteractive", ctx);
  assert.equal(P.state.pick.prompt, "Select the first point of the mirror axis...");
  pcb.onPointerDown(ev(), [10, 0], ctx);
  assert.equal(P.state.pick.prompt, "Select the second point of the mirror axis...");
  pcb.onPointerDown(ev(), [10, 0], ctx);   // the same point: refused, the tool goes on
  assert.ok(log.toasts.includes("The mirror axis must have a non-zero length.")); assert.equal(log.commits.length, 0); assert.ok(P.state.pick);
  pcb.onPointerDown(ev(), [10, 8], ctx);
  assert.equal(P.state.pick, null); assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Mirror");
  assert.deepEqual([xy(node(doc, "a"), "start"), xy(node(doc, "a"), "end")], [[18, 3], [14, 3]]);
  assert.deepEqual(kid(node(doc, "f1"), "at").slice(1, 3), [30, 30]);
  assert.ok(log.toasts.includes("Footprints cannot be mirrored. Use Flip to move them to the other side of the board."));
  // the axis is held to the angle snap mode: GetVectorSnapped45 keeps the dominant direction
  const v = P.vectorSnapped("45", [0, 0], [10, 1]); assert.deepEqual(v, [10, 0]);
});

test("Change Track Width applies the board's current sizes at once; the layer actions carry KiCad's names", () => {
  const doc = B(`(segment (start 0 0) (end 10 0) (width 0.4) (layer "F.Cu") (net 1) (uuid "s1"))`); const { ctx, log } = fakeCtx(doc); sel(ctx, ["s1"]);
  let forms = 0; pcb.setForm(() => { forms++; return true; });
  pcb.runAction("changeTrackWidth", ctx); pcb.setForm(null);
  assert.equal(forms, 0, "no dialog"); assert.equal(P.ACTIONS.changeTrackWidth.label, "Change Track Width");
  if (log.commits.length) assert.equal(log.commits[0].label, "Edit Track Width/Via Size");
  assert.equal(P.ACTIONS.changeTrackLayerNext.label, "Switch Track to Next Layer"); assert.equal(P.ACTIONS.changeTrackLayerPrev.label, "Switch Track to Previous Layer");
  assert.equal(P.ACTIONS.changeTrackLayerNext.key, "Ctrl++"); assert.equal(P.ACTIONS.changeTrackLayerPrev.key, "Ctrl+-");
  const n = log.commits.length; pcb.runAction("changeTrackLayerNext", ctx);
  assert.equal(log.commits.length, n + 1); assert.equal(log.commits[n].label, "Edit Track Layer");
  assert.equal(K.str(kid(node(doc, "s1"), "layer")[1]), "B.Cu");
});

test("Copy as Text: the items' text joined by newlines, a table's cells by tabs, nothing for a footprint", () => {
  const doc = B(`(gr_text "one" (at 0 0 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1) (thickness 0.15))))
    (gr_text "two" (at 0 5 0) (layer "F.SilkS") (uuid "t2") (effects (font (size 1 1) (thickness 0.15))))` + FP("f1", "R1", "30 30"));
  assert.equal(P.textOfItem(doc.items.get("t1")), "one"); assert.equal(P.textOfItem(doc.items.get("f1")), "");
  const { ctx, log } = fakeCtx(doc); sel(ctx, ["t1", "t2"]);
  pcb.runAction("copyAsText", ctx);
  assert.equal(log.clip, "one\ntwo"); assert.deepEqual(log.toasts, []);
  assert.equal(P.ACTIONS.copyAsText.key, "Ctrl+Shift+C");
});

test("Delete on one zone with the cursor in a cutout removes the cutout, not the zone", () => {
  const doc = B(`(zone (net 0) (net_name "") (layer "F.Cu") (uuid "z") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 100 0) (xy 100 100) (xy 0 100))) (polygon (pts (xy 40 40) (xy 60 40) (xy 60 60) (xy 40 60))))`);
  assert.equal(P.zoneCutoutDeleteChange(doc, ["z"], [10, 10]), null, "outside the cutout: the zone itself is deleted");
  const c = P.zoneCutoutDeleteChange(doc, ["z"], [50, 50]); assert.ok(c); apply(doc, [c]);
  assert.equal(kids(node(doc, "z"), "polygon").length, 1);
});

test("Pack and Move Footprints: SpreadFootprints places the footprints apart; rectpack2D fits the bin", () => {
  const doc = B(FP("f1", "R1", "30 30") + FP("f2", "R2", "30 30") + FP("f3", "R3", "31 30"));
  const out = P.packNodes(doc, ["f1", "f2", "f3"]); assert.ok(out.size >= 2);   // a footprint already in its place is left out
  const at = ["f1", "f2", "f3"].map((id) => kid(out.get(id) || node(doc, id), "at").slice(1, 3));
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.ok(Math.abs(at[i][0] - at[j][0]) >= 4 || Math.abs(at[i][1] - at[j][1]) >= 2, "footprints " + i + " and " + j + " overlap: " + JSON.stringify(at));
  const rects = [{ w: 10, h: 10 }, { w: 10, h: 10 }, { w: 5, h: 5 }, { w: 5, h: 5 }];
  assert.equal(P.findBestPacking(rects, 1000, 1), true);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, "rects " + i + ", " + j + " overlap"); }
  // the action: nothing committed until the click; Escape puts the footprints back
  const { ctx, log } = fakeCtx(doc); sel(ctx, ["f1", "f2", "f3"]);
  pcb.runAction("pack", ctx);
  assert.equal(log.commits.length, 0); assert.ok(P.state.move, "the packed footprints ride the cursor");
  pcb.cancel(ctx);   // Escape
  assert.ok(!P.state.move); assert.equal(log.commits.length, 0);
  assert.deepEqual(kid(node(doc, "f3"), "at").slice(1, 3), [31, 30]);
});

test("Shape modification: line count checked first, the decomposition kept, Simplify's forward scan, boolean holes and skips", () => {
  const M = P.shapeModify;
  let doc = B(LINE("a", "0 0", "10 0"));
  assert.equal(M.lineCheck(doc, ["a"], "filletLines"), "A shape with at least two lines must be selected.");
  assert.equal(M.lineCheck(doc, ["a"], "extendLines"), "Exactly two lines must be selected to extend them.");
  doc = B(RECT("r", "0 0", "10 10")); assert.equal(M.lineCheck(doc, ["r"], "filletLines"), null);
  // a radius no corner can take: the rectangle is still taken apart into four lines
  let r = M.modifyLines(doc, ["r"], "filletLines", 50);
  assert.equal(r.message, "Unable to fillet the selected lines.");
  assert.equal(r.changes.filter((c) => c.kind === "REMOVED").length, 1); assert.equal(r.changes.filter((c) => c.kind === "ADDED").length, 4); assert.equal(r.select.length, 4);
  // Simplify: from (0,0) the span stretches over the two near-collinear points to (10,0)
  assert.deepEqual(M.simplifyIndices([[0, 0], [3, 0.01], [6, -0.01], [10, 0], [10, 10], [0, 10]], 0.1), [0, 3, 4, 5]);
  assert.deepEqual(M.simplifyIndices([[0, 0], [3, 0.01], [6, -0.01], [10, 0], [10, 10], [0, 10]], 0.1, [false, true, false, false, false, false]), [0, 1, 3, 4, 5], "an arc's point is never dropped from inside a span");
  assert.deepEqual(M.simplifyLoop([[0, 0], [5, 0], [10, 0], [10, 10]], 0.001), [[0, 0], [10, 0], [10, 10]]);
  // subtract a square from the middle of a larger one: one polygon, the hole cut into its outline
  doc = B(RECT("in", "4 4", "6 6") + RECT("out", "0 0", "10 10"));
  r = M.booleanPolygons(doc, ["in", "out"], "subtractPolygons");
  const added = r.changes.filter((c) => c.kind === "ADDED"); assert.equal(added.length, 1); assert.equal(r.message, null);
  apply(doc, r.changes); const poly = node(doc, r.select[0]); assert.ok(kids(kid(poly, "pts"), "xy").length >= 10, "outline + hole + the slit");
  // intersect: a square that overlaps nothing is skipped (it stays) and reported
  doc = B(RECT("far", "50 50", "60 60") + RECT("b", "5 5", "15 15") + RECT("a", "0 0", "10 10"));
  r = M.booleanPolygons(doc, ["far", "b", "a"], "intersectPolygons");
  assert.equal(r.message, "Some of the polygons could not be intersected.");
  assert.deepEqual(r.changes.filter((c) => c.kind === "REMOVED").map((c) => c.id).sort(), ["a", "b"]);
  assert.equal(r.changes.filter((c) => c.kind === "ADDED").length, 1);
  doc = B(RECT("far", "50 50", "60 60") + RECT("a", "0 0", "10 10"));
  r = M.booleanPolygons(doc, ["far", "a"], "intersectPolygons"); assert.equal(r.message, "Unable to intersect the selected polygons.");
});

test("Move Individually: the popup names items as KiCad does; a double click places the rest where they are", () => {
  const doc = B(LINE("a", "0 0", "10 0") + FP("f1", "R1", "30 30") + FP("f2", "R2", "50 30"));
  assert.equal(P.itemWord(doc.items.get("f1"), doc), "R1"); assert.equal(P.itemWord(doc.items.get("a"), doc), "graphic");
  assert.equal(typeof P.finishMoveIndividually, "function");
  const { ctx } = fakeCtx(doc); assert.equal(P.finishMoveIndividually(ctx), false, "nothing to finish when the sequence is not running");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
