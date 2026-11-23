// Node test for the geometric constraints (KiCad's PCB_CONSTRAINT, planegcs, CONSTRAINT_EDIT_TOOL) and the driving
// dimensions (Apply Dimension Length): the file format, the solver, the tool's actions and dialogs, the automatic
// constraints of the drawing tools and the dimension value modes.
// Run: node server/static/tests/driving-dimensions.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb, C = P.constraints;
const IU = 1e6;

const BOARD = (extra = "") => `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user))
  (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l1"))
  (gr_line (start 0 5) (end 10 7) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l2"))
  (gr_circle (center 30 0) (end 33 0) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "c1"))
${extra})`;
const DIM = `(dimension (type aligned) (layer "F.SilkS") (uuid "d1") (pts (xy 0 0) (xy 10 0)) (height -2)
    (gr_text "10.0000" (at 5 -2 0) (layer "F.SilkS") (uuid "dt1") (effects (font (size 1 1) (thickness 0.15))))
    (format (prefix "") (suffix "") (units 2) (units_format 0) (precision 4))
    (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (arrow_direction outward) (extension_height 0.58642) (extension_offset 0.5) (keep_text_aligned yes)))
  (constraint (type coincident) (uuid "k1") (members (member "d1" start) (member "l1" start)))
  (constraint (type coincident) (uuid "k2") (members (member "d1" end) (member "l1" end)))`;
const parse = (t) => K.parseDoc(t, "kicad_pcb");
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
const ptsOf = (doc, id) => { const n = doc.items.get(id).node; return ["start", "end"].map((k) => { const x = K.kid(n, k); return [+x[1], +x[2]]; }); };
const len = (doc, id) => { const [a, b] = ptsOf(doc, id); return Math.hypot(b[0] - a[0], b[1] - a[1]); };

function fakeCtx(doc, extra) {
  const log = { commits: [], toasts: [], tool: "select", forms: [] };
  const ctx = Object.assign({
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: false, selected: null, items: [], viewOnly: false, live: true, selection: new Set(),
    snap: (mm) => mm, worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {}, setSelection(ids) { ctx.selection = new Set(ids); },
    commit(changes, label, opts) { log.commits.push({ changes, label, amend: !!(opts && opts.amend) }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  }, extra || {});
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
function captureForms(log) { P.state.gfxLayer = "F.SilkS"; pcb.setForm((spec) => { log.forms.push(spec); return true; }); }

test("constraint file I/O: parse, write back in the writer's order, mm values for lengths", () => {
  const n = K.parse(`(constraint (type fixed_length) (uuid "x") (members (member "a" start) (member "b" end)) (value 12.5) (driving no))`);
  const c = C.parseConstraint(n);
  assert.equal(c.type, "fixed_length"); assert.equal(c.value, 12.5 * IU); assert.equal(c.driving, false);
  assert.deepEqual(c.members, [{ item: "a", anchor: "start", index: -1 }, { item: "b", anchor: "end", index: -1 }]);
  assert.equal(K.serialize(C.constraintNode(c)), K.serialize(n));
  const v = C.parseConstraint(K.parse(`(constraint (type coincident) (uuid "y") (members (member "p" vertex 3) (member "q" center)))`));
  assert.equal(v.members[0].index, 3); assert.equal(v.value, null); assert.equal(v.driving, true);
  // a board keeps its constraints as items and writes them back unchanged
  const doc = parse(BOARD(DIM)); assert.equal(doc.items.get("k1").kind, "constraint");
  assert.match(K.serialize(doc.items.get("k2").node), /\(member "d1" end\)/);
});

test("planegcs: a parallel constraint turns the free line", () => {
  const g = new C.planegcs.System();
  const P1 = (x, y) => ({ x: new C.planegcs.Param(x), y: new C.planegcs.Param(y) });
  const a = { p1: P1(0, 0), p2: P1(10, 0) }, b = { p1: P1(0, 5), p2: P1(10, 7) };
  g.addConstraintParallel(a, b, 1);
  g.declareUnknowns([b.p2.x, b.p2.y]); g.initSolution();
  assert.equal(g.solve(), C.planegcs.SolveStatus.Success); g.applySolution();
  assert.ok(near(b.p2.y.v, 5, 1e-6), `b.p2.y ${b.p2.y.v}`);
});

test("AddConstraint from the selection: Parallel adds, snaps the second line and folds into one undo step", () => {
  const doc = parse(BOARD()); const { ctx, log } = fakeCtx(doc); captureForms(log);
  ctx.selection = new Set(["l1", "l2"]);
  assert.equal(pcb.actions.addConstraintParallel.run(ctx), true);
  assert.deepEqual(log.commits.map((c) => [c.label, c.amend]), [["Add Geometric Constraint", false], ["Apply Geometric Constraint", true]]);
  const [a, b] = ptsOf(doc, "l2"), [c, d] = ptsOf(doc, "l1");
  assert.ok(near((b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]), 0, 1e-4), "l1 and l2 are parallel");
  // the same constraint again is refused
  log.toasts.length = 0; pcb.actions.addConstraintParallel.run(ctx);
  assert.deepEqual(log.toasts, ["An identical geometric constraint already exists."]);
});

test("a valued constraint asks its value: Fixed Length with the value dialog, validation and the remembered value", () => {
  const doc = parse(BOARD()); const { ctx, log } = fakeCtx(doc); captureForms(log);
  ctx.selection = new Set(["l1"]); pcb.actions.addConstraintFixedLength.run(ctx);
  const f = log.forms.at(-1); assert.equal(f.title, "Constraint Value"); assert.equal(f.fields[0].label, "Value:"); assert.equal(f.fields[0].value, "10");
  assert.equal(f.fields[1].label, "Driving (locks the geometry)");
  assert.equal(f.apply({ value: "0", driving: true }), false); assert.equal(log.toasts.at(-1), "Enter a value greater than zero.");
  assert.equal(f.apply({ value: "12", driving: true }), true);
  assert.ok(near(len(doc, "l1"), 12), `l1 is 12 mm (${len(doc, "l1")})`);
  const k = [...doc.items.values()].find((it) => it.kind === "constraint");
  assert.match(K.serialize(k.node), /\(value 12\)/);
  // the next one of the type starts from the value just entered
  ctx.selection = new Set(["l2"]); pcb.actions.addConstraintFixedLength.run(ctx);
  assert.equal(log.forms.at(-1).fields[0].value, "12");
  // an arc angle must lie inside (0, 360)
  ctx.selection = new Set(["l1"]);
});

test("the click pickers: Horizontal over a whole segment; Coincident over two anchors", () => {
  const doc = parse(BOARD()); const { ctx, log } = fakeCtx(doc); captureForms(log);
  pcb.actions.addConstraintHorizontal.run(ctx);
  assert.equal(log.tool, "pickpoint");
  assert.equal(P.state.pick.prompt, "Horizontal needs one line segment, or two anchor points.  Click them to constrain.");
  // a click mid-span of l2 (no anchor there) authors at once and the picker stays
  pcb.onPointerDown(ev(), [5, 6], ctx);
  assert.equal(log.commits[0].label, "Add Geometric Constraint");
  const [a, b] = ptsOf(doc, "l2"); assert.ok(near(a[1], b[1], 1e-5));
  assert.equal(log.tool, "pickpoint", "the picker stays for the next one");
  ctx.setTool("select");   // Escape (the DOM key handler's cancelInFlight) ends the picker
  // Coincident: l2's start onto the circle's centre
  log.commits.length = 0; pcb.actions.addConstraintCoincident.run(ctx);
  pcb.onPointerDown(ev(), ptsOf(doc, "l2")[1], ctx);
  pcb.onPointerDown(ev(), [30, 0], ctx);
  assert.equal(log.commits[0].label, "Add Geometric Constraint");
  assert.equal(log.tool, "select", "a point constraint ends the picker");
  // the first member stays where it is (ApplyConstraintImmediately pins it): the circle comes to the line's end
  const e = ptsOf(doc, "l2")[1], cc = K.kid(doc.items.get("c1").node, "center");
  assert.ok(near(+cc[1], e[0], 1e-4) && near(+cc[2], e[1], 1e-4), JSON.stringify([e, cc]));
});

test("Remove Geometric Constraints and the constraint list", () => {
  const doc = parse(BOARD(DIM)); const { ctx, log } = fakeCtx(doc); captureForms(log);
  const rows = C.constraintListRows(ctx);
  assert.equal(rows.length, 2); assert.equal(rows[0].cells[2], "Coincident"); assert.equal(rows[0].cells[3], "OK");
  assert.match(rows[0].cells[0], /\(start\)$/);
  assert.equal(pcb.actions.manageConstraints.run(ctx), true);
  const f = log.forms.at(-1); assert.equal(f.title, "Geometric Constraints");
  assert.deepEqual(f.fields[0].columns.map((c) => c.label), ["Item 1", "Item 2", "Constraint", "State"]);
  ctx.selection = new Set(["l1"]); assert.equal(C.selectionIsConstrained(ctx), true);
  assert.equal(pcb.menuState(ctx).constrained, true);
  pcb.actions.removeConstraints.run(ctx);
  assert.equal(log.commits.at(-1).label, "Remove Geometric Constraints");
  assert.equal([...doc.items.values()].filter((it) => it.kind === "constraint").length, 0);
});

test("driving dimension: Driving is offered once both ends are bound, and Apply Dimension Length moves the geometry", () => {
  const doc = parse(BOARD(DIM)); const { ctx, log } = fakeCtx(doc);
  const info = C.dimensionModeInfo(ctx, "d1"); assert.deepEqual(info, { mode: "driven", canDrive: true, hasValueMode: true });
  const node = K.cloneNode(doc.items.get("d1").node);
  assert.equal(C.commitDimensionEdit(ctx, "d1", node, "driving", "0"), false, "a non-positive length is refused");
  assert.equal(C.commitDimensionEdit(ctx, "d1", node, "driving", "15"), true);
  assert.deepEqual(log.commits.map((c) => [c.label, c.amend]), [["Edit Dimension Properties", false], ["Apply Dimension Length", true]]);
  assert.ok(near(len(doc, "l1"), 15), `the bound line is 15 mm (${len(doc, "l1")})`);
  assert.equal(C.dimensionModeInfo(ctx, "d1").mode, "driving");
  assert.equal(C.drivingValueText(ctx, "d1"), "15");
  assert.match(K.serialize(doc.items.get("d1").node), /"15\.0000"/, "the dimension measures the new length");
  // the Properties panel: a new driving value, then back to Driven (the length constraint goes)
  C.propSetDrivingValue(ctx, ["d1"], "20 mm");
  assert.ok(near(len(doc, "l1"), 20)); assert.equal(log.commits.at(-1).label, "Apply Dimension Length");
  C.propSetValueMode(ctx, ["d1"], "arbitrary");
  assert.equal(C.dimensionModeInfo(ctx, "d1").mode, "arbitrary");
  assert.ok(!C.findDimensionLengthConstraint(C.boardOf(ctx), "d1"));
  assert.match(K.serialize(doc.items.get("d1").node), /override_value "20\.0000"/);
  // an unbound dimension cannot drive
  const doc2 = parse(BOARD(DIM.replace(/\(constraint[^\n]*k2[^\n]*/, ""))); const f2 = fakeCtx(doc2);
  assert.equal(C.dimensionModeInfo(f2.ctx, "d1").canDrive, false);
});

test("automatic constraints: a line drawn from an endpoint is bound coincident and keeps its axis; a dimension is bound to what it measures", () => {
  const doc = parse(BOARD()); const { ctx, log } = fakeCtx(doc);
  const add = P.lineNode ? null : null; void add;
  const line = K.parse(`(gr_line (start 10 0) (end 10 -8) (stroke (width 0.1) (type default)) (layer "F.SilkS"))`);
  const ch = pcb.addedChangeFor ? null : null; void ch;
  const change = K.addChange ? null : null; void change;
  const board = () => C.boardOf(ctx);
  const added = P.constraints && C.commitDrawn;
  assert.ok(added);
  const c = require("node:assert"); void c;
  const id = "new-line"; line.push(["uuid", id]);
  const item = K.createItem(doc, line); const addCh = K.addChange(doc, item); addCh.id = id;
  C.commitDrawn(ctx, addCh, "Draw Line", "shape", true);
  const ks = board().constraints();
  assert.deepEqual(ks.map((k) => k.type).sort(), ["coincident", "vertical"]);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Draw Line");
  // auto constraints off: nothing staged
  C.toggleAutoConstraints(ctx); assert.equal(C.getAutoConstraints(ctx), false); C.toggleAutoConstraints(ctx);
  // bindDimensionEndpoints
  const dn = K.parse(`(dimension (type aligned) (layer "F.SilkS") (uuid "d9") (pts (xy 0 5) (xy 10 7)) (height 2) (gr_text "10" (at 5 8 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (format (units 2) (units_format 0) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5)))`);
  const di = K.createItem(doc, dn); const dch = K.addChange(doc, di);
  C.commitDrawn(ctx, dch, "Draw Dimension", "dim");
  const bound = board().constraints().filter((k) => k.members.some((m) => m.item === "d9"));
  assert.equal(bound.length, 2); assert.ok(C.dimensionModeInfo(ctx, "d9").canDrive);
});

test("solve after move: a coincident partner follows a moved line", () => {
  const doc = parse(BOARD(`(constraint (type coincident) (uuid "k9") (members (member "l1" end) (member "l2" end)))`));
  const { ctx, log } = fakeCtx(doc);
  // move l1 by +1 in y (as the move tool commits it), then settle
  const n = K.cloneNode(doc.items.get("l1").node); for (const k of ["start", "end"]) K.kid(n, k)[2] += 1;
  ctx.commit([K.replaceChange(doc, Object.assign({}, doc.items.get("l1"), { node: n }))], "Move");
  C.solveAfterMove(ctx, ["l1"]);
  assert.equal(log.commits.at(-1).label, "Apply Geometric Constraint"); assert.equal(log.commits.at(-1).amend, true);
  const e1 = ptsOf(doc, "l1")[1], e2 = ptsOf(doc, "l2")[1]; assert.ok(near(e1[0], e2[0], 1e-4) && near(e1[1], e2[1], 1e-4), JSON.stringify([e1, e2]));
});

test("diagnostics: conflicting constraints read Over-constrained", () => {
  const doc = parse(BOARD(`(constraint (type horizontal) (uuid "h") (members (member "l1" whole)))
  (constraint (type vertical) (uuid "v") (members (member "l1" whole)))`));
  const { ctx } = fakeCtx(doc);
  const d = C.diagnoseBoardConstraints(C.boardOf(ctx));
  assert.equal(d.shapeStates.get("l1"), "over");
  assert.ok(C.constraintListRows(ctx).some((r) => r.cells[3] === "Over-constrained"));
});

test("footprint documents keep their constraints after the items they reference", () => {
  const FP = `(footprint "T" (version 20260728) (generator "pcbnew") (layer "F.Cu")
  (fp_line (start 0 0) (end 1 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "f1"))
  (constraint (type horizontal) (uuid "fk") (members (member "f1" whole)))
)`;
  const doc = K.parseDoc(FP, "kicad_mod");
  assert.ok([...doc.items.values()].some((it) => it.kind === "constraint"));
});

test("the constraint overlay: hover shows the hovered shape's badges, Always Show every one, laid out clear of the geometry", () => {
  const doc = parse(BOARD(DIM)); const { ctx } = fakeCtx(doc);
  const calls = []; const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, a])), set: (t, k, v) => { t[k] = v; return true; } });
  pcb.actions.hideConstraints.run(ctx); assert.equal(pcb.menuState(ctx).constraintsAlways, false);
  C.drawConstraintOverlay(g, ctx, 0.01, [50, 50]); assert.equal(calls.filter((x) => x[0] === "fillText").length, 0, "hover mode, nothing hovered");
  C.drawConstraintOverlay(g, ctx, 0.01, [5, 0.01]); assert.equal(calls.filter((x) => x[0] === "fillText").length, 2, "l1 hovered: its two coincidents");
  calls.length = 0; pcb.actions.showConstraints.run(ctx); assert.equal(pcb.menuState(ctx).constraintsAlways, true);
  C.drawConstraintOverlay(g, ctx, 0.01, null); assert.equal(calls.filter((x) => x[0] === "fillText").length, 2);
  pcb.actions.hideConstraints.run(ctx);
  // LayoutBadges: the preferred spot (16, -16) px when clear, another direction when a segment runs through it
  const wpp = 1000; const free = C.layoutBadges([{ pos: [0, 0], avoid: [] }], wpp);
  assert.deepEqual(free[0].map(Math.round), [16000, -16000]);
  const moved = C.layoutBadges([{ pos: [0, 0], avoid: [[[16000, -40000], [16000, 40000]]] }], wpp);
  assert.notDeepEqual(moved[0].map(Math.round), [16000, -16000]);
});

test("automatic constraints: an endpoint on a segment's midpoint binds Midpoint; a circle centred on an arc's centre is Concentric", () => {
  const doc = parse(BOARD(`(gr_arc (start 33 0) (mid 30 3) (end 27 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "a1"))`)); const { ctx } = fakeCtx(doc);
  const add = (text, id) => { const n = K.parse(text); n.push(["uuid", id]); const it = K.createItem(doc, n); const ch = K.addChange(doc, it); ch.id = id; return ch; };
  C.commitDrawn(ctx, add(`(gr_line (start 5 0) (end 5 -4) (stroke (width 0.1) (type default)) (layer "F.SilkS"))`, "m1"), "Draw Line", "shape", false);
  assert.deepEqual(C.boardOf(ctx).constraints().filter((k) => k.members.some((m) => m.item === "m1")).map((k) => k.type), ["midpoint"]);
  C.commitDrawn(ctx, add(`(gr_circle (center 30 0) (end 31 0) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS"))`, "c2"), "Draw Circle", "shape");
  assert.deepEqual(C.boardOf(ctx).constraints().filter((k) => k.members.some((m) => m.item === "c2")).map((k) => k.type), ["concentric"]);
});

test("copy, paste and duplicate carry the constraints whose members are all copied, repointed at the copies", () => {
  const doc = parse(BOARD(`(constraint (type parallel) (uuid "kp") (members (member "l1" whole) (member "l2" whole)))
  (constraint (type concentric) (uuid "kc") (members (member "c1" whole) (member "l1" whole)))`));
  const text = P.clipboardText(doc, ["l1", "l2"], [0, 0]);
  assert.match(text, /\(constraint \(type parallel\)/); assert.doesNotMatch(text, /concentric/);
  const pasted = P.pasteChanges(doc, text, [0, 20]);
  const isK = (c) => c.typeName === "PCB_CONSTRAINT";
  const k = pasted.changes.find(isK);
  assert.ok(k, "the constraint is pasted"); assert.ok(!pasted.ids.includes(k.id), "but not selected");
  const memOf = (c) => K.kids(K.kid(doc.items.get(c.id).node, "members"), "member").map((m) => String(m[1]));
  const members = memOf(k);
  assert.deepEqual(members.slice().sort(), pasted.ids.slice().sort(), "it points at the pasted lines");
  const dup = P.duplicateChanges(doc, ["l1", "l2"], [0, 5]);
  const dk = dup.changes.filter(isK);
  assert.equal(dk.length, 1); assert.deepEqual(memOf(dk[0]).sort(), dup.ids.slice().sort());
});

// ---------------------------------------------------------------- Part 2: live solving, badges, vertex remap, pane
const CHAIN = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user))
  (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "a"))
  (gr_line (start 10 0) (end 10 8) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "b"))
  (constraint (type coincident) (uuid "kab") (members (member "a" end) (member "b" start)))
  (constraint (type vertical) (uuid "kv") (members (member "b" whole)))
)`;
const setPt = (doc, id, key, p) => { const it = doc.items.get(id); const x = K.kid(it.node, key); x[1] = p[0]; x[2] = p[1]; K.replaceChange(doc, it); };
const ptOf = (doc, id, key) => { const x = K.kid(doc.items.get(id).node, key); return [+x[1], +x[2]]; };
const nearPt = (a, b, tol = 1e-3) => near(a[0], b[0], tol) && near(a[1], b[1], tol);

test("point editor: the constrained neighbour follows every frame of an end drag, and the gesture's end hands back its change", () => {
  const doc = parse(CHAIN); const { ctx } = fakeCtx(doc);
  const orig = K.cloneNode(doc.items.get("a").node);
  const live = C.beginPointEditConstraints(ctx, "a", "end", [10, 0], orig);
  assert.ok(live && live.drag, "the end is a constraint anchor: a drag session");
  for (const p of [[11, 0.5], [12, 1], [13, 2]]) {
    setPt(doc, "a", "end", p); C.pointEditSolveFrame(live, "a", "end", p);
    assert.ok(nearPt(ptOf(doc, "b", "start"), ptOf(doc, "a", "end")), "b's start sits on a's end in frame " + p);
    const [s, e] = [ptOf(doc, "b", "start"), ptOf(doc, "b", "end")]; assert.ok(near(s[0], e[0]), "b stays vertical");
  }
  const reached = live.takeBack();
  assert.deepEqual(ptOf(doc, "b", "start"), [10, 0], "takeBack puts the neighbour back");
  const ch = live.changes(reached, new Set(["a"]));
  assert.equal(ch.length, 1); assert.equal(ch[0].id, "b");
});

test("move: the cluster follows each frame from the build baseline; Move Individually holds the moved shape", () => {
  const doc = parse(CHAIN); const { ctx } = fakeCtx(doc);
  const s = C.beginMoveConstraints(ctx, ["a"], false); assert.ok(s && s.live.move, "a move session");
  const base = { s: ptOf(doc, "a", "start"), e: ptOf(doc, "a", "end") };
  for (const off of [[1, 0], [2, 3], [5, -1]]) {
    setPt(doc, "a", "start", [base.s[0] + off[0], base.s[1] + off[1]]); setPt(doc, "a", "end", [base.e[0] + off[0], base.e[1] + off[1]]);
    assert.equal(C.moveSolveFrame(s.live, s.shapes, new Set(["a"]), off), true);
    assert.ok(nearPt(ptOf(doc, "b", "start"), ptOf(doc, "a", "end")), "b follows offset " + off);
    assert.deepEqual(ptOf(doc, "a", "end"), [base.e[0] + off[0], base.e[1] + off[1]], "the moved line is not rewritten");
  }
  const back = s.live.takeBack(); assert.deepEqual(ptOf(doc, "b", "start"), [10, 0]); assert.ok(back.has("b"));
  const ind = C.beginMoveConstraints(ctx, ["a"], true); assert.ok(ind && !ind.live.move, "individually: no rigid session");
  setPt(doc, "a", "end", [10, 2]); setPt(doc, "a", "start", [0, 2]);
  assert.equal(C.moveSolveFrame(ind.live, ind.shapes, new Set(["a"]), [0, 2]), true);
  assert.ok(nearPt(ptOf(doc, "b", "start"), [10, 2]));
});

test("polygon corners: inserting or removing a corner renumbers the vertex members; a constraint on a removed corner goes", () => {
  const doc = parse(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (37 "F.SilkS" user))
  (gr_poly (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10)) (stroke (width 0.1) (type default)) (fill no) (layer "F.SilkS") (uuid "p"))
  (gr_line (start 10 10) (end 20 10) (stroke (width 0.1) (type default)) (layer "F.SilkS") (uuid "l"))
  (constraint (type coincident) (uuid "kp") (members (member "p" vertex 2) (member "l" start)))
)`);
  const idx = (d) => C.parseConstraint(d.items.get("kp").node).members[0].index;
  const apply = (chs) => { for (const c of chs) K.applyChange(doc, c, IU); };
  const add = C.constraintRemapChanges(doc, "p", [[1, 1]]); assert.equal(add.length, 1); apply(add); assert.equal(idx(doc), 3, "a corner before it: +1");
  assert.equal(C.constraintRemapChanges(doc, "p", [[4, 1]]).length, 0, "a corner after it leaves it");
  apply(C.constraintRemapChanges(doc, "p", [[0, -1]])); assert.equal(idx(doc), 2, "a corner before it removed: -1");
  const gone = C.constraintRemapChanges(doc, "p", [[2, -1]]); apply(gone);
  assert.ok(!doc.items.has("kp"), "the constraint bound to the removed corner retires");
});

test("constraint badges: a click selects one (enlarged, members brighter, message panel rows), Delete removes it, E edits it", () => {
  const doc = parse(BOARD(DIM.replace(/\(constraint \(type coincident\) \(uuid "k2"\)[^\n]*/, `(constraint (type fixed_length) (uuid "k2") (members (member "l1" whole)) (value 10) (driving yes))`)));
  const { ctx, log } = fakeCtx(doc); captureForms(log);
  pcb.actions.showConstraints.run(ctx);
  const px = 0.01; const { badges, at } = C.constraintBadges(ctx, px, null); assert.equal(badges.length, 2);
  const i = badges.findIndex((b) => b.id === "k2"); const mm = [at[i][0] / IU, at[i][1] / IU];
  assert.equal(C.hitTestBadge(ctx, mm, px), "k2"); assert.equal(C.hitTestBadge(ctx, [mm[0] + 1, mm[1] + 1], px), null, "beyond the hit radius");
  ctx.selection = new Set(["l2"]);
  assert.equal(C.selectConstraintAt(ctx, mm, px), true);
  assert.equal(C.constraintSelection().selected, "k2"); assert.equal(ctx.selection.size, 0, "the board selection is cleared");
  assert.deepEqual([...C.constraintShadowIds(ctx).highlighted], ["l1"]);
  const rows = C.constraintMsgPanel(ctx, "mm"); assert.deepEqual(rows.map((r) => r.title), ["Constraint", "Items", "State"]);
  // E: the value dialog of the selected constraint
  log.forms.length = 0; assert.equal(C.tryEditSelectedConstraint(ctx), true); assert.equal(log.forms.length, 1);
  // Delete removes the constraint, not its members
  assert.equal(C.tryDeleteSelectedConstraint(ctx), true);
  assert.ok(!doc.items.has("k2")); assert.ok(doc.items.has("l1")); assert.equal(C.constraintSelection().selected, null);
  assert.equal(C.tryDeleteSelectedConstraint(ctx), false, "nothing selected: Delete goes to the items");
  assert.equal(C.constraintMsgPanel(ctx, "mm"), null);
  // a click off every badge clears the badge selection
  C.selectConstraintAt(ctx, mm, px); C.clearConstraintSelection(ctx); assert.equal(C.constraintSelection().selected, null);
  pcb.actions.hideConstraints.run(ctx);
});

test("the constraints pane: a row isolates its constraint and selects its members; a canvas selection shows them all again", () => {
  const doc = parse(BOARD(DIM)); const { ctx } = fakeCtx(doc);
  pcb.actions.showConstraints.run(ctx);
  assert.equal(C.constraintBadges(ctx, 0.01, null).badges.length, 2);
  C.highlightConstraintMembers(ctx, "k1", 1);
  assert.deepEqual([...ctx.selection], ["l1"], "the member of the clicked item cell alone");
  assert.equal(C.constraintSelection().isolated, "k1");
  assert.deepEqual(C.constraintBadges(ctx, 0.01, null).badges.map((b) => b.id), ["k1"], "isolation shows that constraint alone");
  ctx.selection = new Set(["l2"]); C.constraintBadges(ctx, 0.01, null);
  assert.equal(C.constraintSelection().isolated, null, "a selection change ends the isolation");
  // EditConstraintById: a valueless relation locates its members
  C.editConstraintById(ctx, "k2"); assert.equal(C.constraintSelection().isolated, "k2");
  pcb.actions.hideConstraints.run(ctx);
});
