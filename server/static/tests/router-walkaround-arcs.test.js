// router-walkaround-arcs.test.js — the interactive router's WALKAROUND and its arcs against KiCad's PNS router
// (pcbnew/router/pns_walkaround.cpp, pns_line_placer.cpp rhWalkBase / splitHeadTail / cursorDistMinimum,
// pns_shove.cpp onCollidingArc / runOptimizer, pns_dragger.cpp startDragArc, pns_line.cpp LINE::DragArc,
// pns_component_dragger.cpp, pcb_grid_helper.cpp AlignToArc).
// Run: node server/static/tests/router-walkaround-arcs.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const W = P, D = P;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
function reset() { try { pcb.cancel && pcb.cancel(); } catch (e) { /* nothing in progress */ } P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS)); P.state.viewArea = null; }
const HEAD = `(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))`;
const board = (body) => K.parseDoc(HEAD + "\n" + body + "\n)", "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select" };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { log.tool = t; pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const nm = (pts) => pts.map(W.toNm), mm = (pts) => pts.map(W.fromNm);
const len = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const near = (a, b, tol = 1e-4) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
const obstacles = (doc, net) => W.routeObstacles(doc, P.designSettings(doc), net, "F.Cu");

// ---------------------------------------------------------------- WALKAROUND::Route
test("WALKAROUND::Route: clockwise and counter-clockwise go round opposite sides, WP_SHORTEST takes the shorter, all clear and DONE", () => {
  const doc = board(`(segment (start 5 -1) (end 5 3) (width 0.25) (layer "F.Cu") (net "B") (uuid "b"))`);
  const O = obstacles(doc, "A"); const init = nm([[0, 0], [10, 0]]);
  const wr = W.walkaroundRoute(O, init, 0.125, { policies: [W.WP_CW, W.WP_CCW, W.WP_SHORTEST] });
  for (const p of [W.WP_CW, W.WP_CCW, W.WP_SHORTEST]) {
    assert.equal(wr.status[p], W.ST_DONE, "policy " + p);
    const l = mm(wr.lines[p]); assert.ok(near(l[0], [0, 0]) && near(l[l.length - 1], [10, 0]), "the ends are kept");
    assert.ok(W.pathClear(O, l, 0.125), "clear: " + JSON.stringify(l));
  }
  const cw = mm(wr.lines[W.WP_CW]), ccw = mm(wr.lines[W.WP_CCW]);
  const side = (l) => Math.sign(l.reduce((s, p) => s + p[1], 0));
  assert.notEqual(side(cw), side(ccw), "the two walks pass on opposite sides");
  assert.ok(side(mm(wr.lines[W.WP_SHORTEST])) < 0, "the obstacle reaches further down (y 3) than up (y -1): the shortest walk goes over the top");
  assert.ok(Math.abs(len(mm(wr.lines[W.WP_SHORTEST])) - Math.min(len(cw), len(ccw))) < 1e-3);
});

test("WALKAROUND::Route: the iteration limit and the length limit leave a walk ALMOST_DONE", () => {
  const doc = board(`(segment (start 3 -1) (end 3 1) (width 0.25) (layer "F.Cu") (net "B") (uuid "b1"))
  (segment (start 7 -1) (end 7 1) (width 0.25) (layer "F.Cu") (net "B") (uuid "b2"))`);
  const O = obstacles(doc, "A"); const init = nm([[0, 0], [10, 0]]);
  assert.equal(W.walkaroundRoute(O, init, 0.125, { policies: [W.WP_CW], iterLimit: 1 }).status[W.WP_CW], W.ST_ALMOST_DONE, "one cluster per iteration: the second is still hit");
  assert.equal(W.walkaroundRoute(O, init, 0.125, { policies: [W.WP_CW], iterLimit: 40 }).status[W.WP_CW], W.ST_DONE);
  assert.equal(W.walkaroundRoute(O, init, 0.125, { policies: [W.WP_CW], lengthLimit: true, lengthFactor: 1.01 }).status[W.WP_CW], W.ST_ALMOST_DONE, "longer than lengthFactor times the first line");
});

// ---------------------------------------------------------------- LINE_PLACER: splitHeadTail, cursorDistMinimum
test("LINE_PLACER::splitHeadTail: the walked line keeps the old tail as far as it runs along it, the rest is the head", () => {
  const tail = [[0, 0], [5, 0], [8, 3]];
  assert.deepEqual(W.splitHeadTail([[0, 0], [5, 0], [8, 3], [12, 3]], tail), { tail: [[0, 0], [5, 0], [8, 3]], head: [[8, 3], [12, 3]] });
  // the first old tail point the new line does not hold (i) cuts it: tail = Slice( 0, i ), head = Slice( i, -1 )
  assert.deepEqual(W.splitHeadTail([[0, 0], [5, 0], [7, -2], [12, -2]], tail), { tail: [[0, 0], [5, 0], [7, -2]], head: [[7, -2], [12, -2]] }, "(8,3) is gone: cut at point 2");
  assert.deepEqual(W.splitHeadTail([[0, 0], [1, 1], [6, 1]], tail), { tail: [[0, 0], [1, 1]], head: [[1, 1], [6, 1]] }, "(5,0) is gone: cut at point 1");
  assert.deepEqual(W.splitHeadTail([[1, 0], [6, 0]], tail), { tail: [], head: [[1, 0], [6, 0]] }, "not even the start: no tail");
  assert.deepEqual(W.splitHeadTail([[0, 0], [9, 0]], []), { tail: [], head: [[0, 0], [9, 0]] });
});

test("LINE_PLACER::cursorDistMinimum: the walked line clipped at its point nearest the cursor (within the hug threshold)", () => {
  const doc = board(``); const O = obstacles(doc, "A");
  const L = nm([[0, 0], [10, 0], [10, 10]]);
  const out = W.cursorDistMinimum(O, 0.125, L, W.toNm([4, 1]), Infinity);
  assert.deepEqual(mm(out), [[0, 0], [4, 0]]);
});

test("module: in Walk around the head walks round another net's track (rhWalkBase) and reaches the cursor, clear", () => {
  const doc = board(`(segment (start 5 -3) (end 5 3) (width 0.25) (layer "F.Cu") (net "B") (uuid "b"))
  (segment (start 0 0) (end 1 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "a"))`);
  const { ctx } = fakeCtx(doc); P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS, { mode: 2 }));
  pcb.onActivate("route", ctx); pcb.onPointerMove(ev(), [1, 0], ctx); pcb.onPointerDown(ev(), [1, 0], ctx);
  pcb.onPointerMove(ev(), [10, 0], ctx);
  const rt = P.state.route; assert.ok(rt && rt.head && rt.head.length >= 2, "a head");
  const O = obstacles(doc, "A");
  assert.ok(W.pathClear(O, rt.head, 0.125), "the walked line is clear: " + JSON.stringify(rt.head));
  assert.ok(near(rt.head[rt.head.length - 1], [10, 0]), "it reaches the cursor");
  pcb.cancel();
});

// ---------------------------------------------------------------- SHOVE::runOptimizer: the visible view area
test("SHOVE::runOptimizer: the optimizer area is intersected with the visible view area (BOX2::Intersect, empty when apart)", () => {
  const doc = board(`(segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net "B") (uuid "sb"))`);
  const run = (view) => {
    P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS, { mode: 1, effort: 1 })); P.state.viewArea = view;
    const SW = P.shoveWorld(doc, P.designSettings(doc), true);
    const L = { key: "sb", ids: ["sb"], pts: [[0, 0], [2, 0], [3, 1], [5, 1], [6, 0], [10, 0]], orig: [[0, 0], [10, 0]], w: 0.25, layer: "F.Cu", net: "B", rank: 1 };
    const st = { lines: new Map([["sb", L]]), lineOf: new Map([["sb", L]]), viaAt: new Map(), viaRank: new Map() };
    P.shoveOptimize(SW, st, [], P.state.rs); return L.pts;
  };
  assert.deepEqual(run(null), [[0, 0], [10, 0]], "no view: the whole affected area");
  assert.deepEqual(run([-20, -20, 30, 20]), [[0, 0], [10, 0]], "the view holds the area");
  assert.deepEqual(run([100, 100, 120, 120]), [[0, 0], [2, 0], [3, 1], [5, 1], [6, 0], [10, 0]], "the view is elsewhere: nothing is optimized");
});

// ---------------------------------------------------------------- arcs: LINE::DragArc and CIRCLE::ConstructFromTanTanPt
test("CIRCLE::ConstructFromTanTanPt: the larger circle tangent to both lines through the point", () => {
  const c = D.tanTanPt([[0, 0], [10, 0]], [[0, 0], [0, 10]], [1, 1]);
  assert.ok(Math.abs(c.r - (2 + Math.SQRT2)) < 1e-9 && near(c.c, [2 + Math.SQRT2, 2 + Math.SQRT2], 1e-9), JSON.stringify(c));
  assert.equal(D.tanTanPt([[0, 0], [10, 0]], [[0, 0], [0, 10]], [0, 0]).r, 0, "the point at the crossing: no circle");
});

// a line (0,0)-(5,0), a 90° arc about (5,3) to (8,3), then (8,3)-(8,8)
const ARC_MID = [5 + 3 * Math.cos(-Math.PI / 4), 3 + 3 * Math.sin(-Math.PI / 4)].map((v) => Math.round(v * 1e6) / 1e6);
const arcLine = () => D.elemsLine([{ t: "seg", a: [0, 0], b: [5, 0] }, { t: "arc", a: [5, 0], m: ARC_MID, b: [8, 3] }, { t: "seg", a: [8, 3], b: [8, 8] }], 0.25);

test("LINE::DragArc: the arc follows the cursor tangent to the segments it joins; they grow or shrink to meet it", () => {
  const ln = arcLine(); const r = D.dragArcLine(ln.pts, ln.arcs, ln.starts[1], [7.5, 0.5], 0.25);
  const els = D.lineElems(r.pts, r.arcs);
  assert.deepEqual(els.map((e) => e.t), ["seg", "arc", "seg"]);
  const R = 0.5 / (1 - Math.SQRT1_2);   // the circle tangent to y = 0 and x = 8 through (7.5, 0.5)
  assert.ok(near(els[1].a, [8 - R, 0], 2e-6) && near(els[1].b, [8, R], 2e-6), JSON.stringify(els[1]));
  assert.ok(near(els[0].a, [0, 0]) && near(els[0].b, els[1].a) && near(els[2].a, els[1].b) && near(els[2].b, [8, 8]));
  const g = D.arcGeom(els[1].a, els[1].m, els[1].b); assert.ok(Math.abs(g.r - R) < 2e-6 && Math.abs(Math.abs(g.ca) - Math.PI / 2) < 1e-5, "still a quarter circle");
});

test("LINE::DragArc: the cursor is kept outside the largest tangent arc; an arc shrunk below m_MaxTrackLengthToKeep collapses", () => {
  const ln = arcLine();
  // pulled outwards past the largest arc that still fits on the tangent segments: clamped to that arc (radius 5: the
  // shorter tangent run from the corner (8,0) is the 5 mm to (8,5)... the far end of the start segment is 8 mm away)
  const r = D.dragArcLine(ln.pts, ln.arcs, ln.starts[1], [2, 6], 0.25); const els = D.lineElems(r.pts, r.arcs);
  const arc = els.find((e) => e.t === "arc"); const g = D.arcGeom(arc.a, arc.m, arc.b);
  assert.ok(Math.abs(g.r - 8) < 1e-4, "the largest tangent circle (radius 8): " + g.r);
  // almost into the corner: the arc collapses and the line joins the segment ends straight (Slice + Append)
  const c = D.dragArcLine(ln.pts, ln.arcs, ln.starts[1], [7.99995, 0.00005], 0.25);
  assert.deepEqual(c.pts, [[0, 0], [8, 8]]); assert.ok(c.arcs.seg.every((k) => k < 0));
});

test("DRAGGER::startDragArc: an arc of 179° or more is refused on the infobar; an isolated arc gets tangent stubs", () => {
  const doc = board(`(arc (start 0 0) (mid 5 -5) (end 10 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "half"))
  (arc (start 20 0) (mid 23.535534 -1.464466) (end 25 -5) (width 0.25) (layer "F.Cu") (net "A") (uuid "q"))`);
  const { ctx, log } = fakeCtx(doc);
  assert.equal(P.dragStart(ctx, doc.items.get("half"), [5, -5], false), null);
  assert.deepEqual(log.toasts, ["Unable to drag arc tracks of 179.0 degrees or greater."]);
  const d = P.dragStart(ctx, doc.items.get("q"), [23.5, -1.5], false); assert.ok(d); assert.equal(d.mode, "arc");
  const pts = d.lines[0].pts, n = pts.length;
  assert.ok(Math.abs(Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) - 0.00025) < 2e-6, "the start stub: half of 0.0005 mm");
  assert.ok(Math.abs(Math.hypot(pts[n - 1][0] - pts[n - 2][0], pts[n - 1][1] - pts[n - 2][1]) - 0.00025) < 2e-6, "the end stub");
  assert.ok(near(pts[1], [20, 0]) && near(pts[n - 2], [25, -5]));
  assert.ok(pts[0][0] < 20 && Math.abs(pts[0][1]) < 1e-5, "the start stub runs back along the arc's tangent (vertical radius, horizontal tangent)");
  assert.ok(pts[n - 1][1] < -5 && Math.abs(pts[n - 1][0] - 25) < 1e-5, "the end stub carries on along the end's tangent");
});

test("module: D on a selected arc drags it (DM_ARC) and commits the new arc with its tangent segments", () => {
  const doc = board(`(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "s1"))
  (arc (start 5 0) (mid ${ARC_MID[0]} ${ARC_MID[1]}) (end 8 3) (width 0.25) (layer "F.Cu") (net "A") (uuid "a1"))
  (segment (start 8 3) (end 8 8) (width 0.25) (layer "F.Cu") (net "A") (uuid "s2"))`);
  const { ctx, log } = fakeCtx(doc);
  P.state.sel = new Set(["a1"]); ctx.cursor = ARC_MID.slice(); assert.equal(pcb.onKey("d", ev(), ctx), true);
  assert.equal(P.state.drag.subs[0].mode, "arc");
  pcb.onPointerMove(ev(), [7.5, 0.5], ctx); pcb.onPointerDown(ev(), [7.5, 0.5], ctx);
  const c = log.commits.at(-1); assert.ok(c && c.label === "Routing", "committed");
  const arcs = [...doc.items.values()].filter((it) => it.kind === "arc"); assert.equal(arcs.length, 1);
  const R = 0.5 / (1 - Math.SQRT1_2);
  assert.ok(near(P.pt(arcs[0].node, "start"), [8 - R, 0], 2e-6) && near(P.pt(arcs[0].node, "end"), [8, R], 2e-6));
  const segs = [...doc.items.values()].filter((it) => it.kind === "segment").map((it) => [P.pt(it.node, "start"), P.pt(it.node, "end")]);
  assert.ok(segs.some(([a, b]) => near(a, [0, 0]) && near(b, [8 - R, 0], 2e-6)) && segs.some(([a, b]) => near(a, [8, R], 2e-6) && near(b, [8, 8])), JSON.stringify(segs));
});

test("PCB_GRID_HELPER::AlignToArc: an arc is grabbed where a grid line through the snapped point crosses it, or at an end", () => {
  const doc = board(``); const { ctx } = fakeCtx(doc);
  const a = [5, 0], m = ARC_MID, b = [8, 3];
  // the grid point (7, 1): its horizontal and vertical lines cross the arc 0.236 away, the 45° line down-right 0.172 away
  const p = D.alignToArc(ctx, [7.1, 0.9], a, m, b);
  assert.ok(near(p, [7 + (Math.sqrt(4.5) - 2), 1 - (Math.sqrt(4.5) - 2)], 2e-6), JSON.stringify(p));
  assert.ok(Math.abs(Math.hypot(p[0] - 5, p[1] - 3) - 3) < 1e-5, "on the arc");
  assert.deepEqual(D.alignToArc(ctx, [5.05, 0.02], a, m, b), [5, 0], "next to an end: the end");
});

// ---------------------------------------------------------------- COMPONENT_DRAGGER: arcs
test("COMPONENT_DRAGGER: a line with an arc attached to a dragged pad follows it, the arc it does not reach kept", () => {
  const doc = board(`(footprint "T:P" (layer "F.Cu") (uuid "f1") (at 0 0)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A") (uuid "p1")))
  (footprint "T:P" (layer "F.Cu") (uuid "f2") (at 8 8)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A") (uuid "p2")))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "s1"))
  (arc (start 5 0) (mid ${ARC_MID[0]} ${ARC_MID[1]}) (end 8 3) (width 0.25) (layer "F.Cu") (net "A") (uuid "a1"))
  (segment (start 8 3) (end 8 8) (width 0.25) (layer "F.Cu") (net "A") (uuid "s2"))`);
  const { ctx, log } = fakeCtx(doc);
  P.state.sel = new Set(); ctx.selected = { id: "f2" }; ctx.selection = new Set(["f2"]); ctx.cursor = [8, 8];
  assert.equal(pcb.onKey("d", ev(), ctx), true); const m = P.state.move; assert.ok(m && m.conns.length === 1);
  assert.ok(m.conns[0].l.ids.includes("a1") && m.conns[0].l.arcs, "the line through the arc (NODE::AssembleLine)");
  P.selectMoveTo(ctx, [8, 10]); P.finishSelectMove(ctx, true, false);
  assert.equal(log.commits.at(-1).label, "Routing");
  const a1 = doc.items.get("a1"); assert.ok(a1, "the arc is kept as it was");
  assert.ok(near(P.pt(a1.node, "start"), [5, 0]) && near(P.pt(a1.node, "end"), [8, 3]));
  const segs = [...doc.items.values()].filter((it) => it.kind === "segment").map((it) => [P.pt(it.node, "start"), P.pt(it.node, "end")]);
  assert.ok(segs.some(([a, b]) => (near(a, [8, 3]) && near(b, [8, 10])) || (near(b, [8, 3]) && near(a, [8, 10]))), JSON.stringify(segs));
  ctx.selected = null; ctx.selection = new Set();
});

test("COMPONENT_DRAGGER: an arc running between two dragged pads moves with them (SHAPE_ARC::Move)", () => {
  const doc = board(`(footprint "T:P" (layer "F.Cu") (uuid "f1") (at 0 0)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A") (uuid "p1"))
    (pad "2" smd rect (at 10 0) (size 1 1) (layers "F.Cu") (net "A") (uuid "p2")))
  (arc (start 0 0) (mid 5 -2) (end 10 0) (width 0.25) (layer "F.Cu") (net "A") (uuid "a1"))`);
  const { ctx, log } = fakeCtx(doc);
  P.state.sel = new Set(); ctx.selected = { id: "f1" }; ctx.selection = new Set(["f1"]); ctx.cursor = [0, 0];
  assert.equal(pcb.onKey("d", ev(), ctx), true);
  P.selectMoveTo(ctx, [1, 2]); P.finishSelectMove(ctx, true, false);
  const a1 = doc.items.get("a1");
  assert.deepEqual([P.pt(a1.node, "start"), P.pt(a1.node, "mid"), P.pt(a1.node, "end")], [[1, 2], [6, 0], [11, 2]]);
  ctx.selected = null; ctx.selection = new Set();
});

// ---------------------------------------------------------------- SHOVE::onCollidingArc
test("SHOVE::onCollidingArc: an arc's line is shoved (its untouched arcs kept); one that would more than double walks instead", () => {
  // net B: a gentle arc (0,1) - (5,1.6) - (10,1) with straight tails; the head (net A) runs under its middle
  const doc = board(`(segment (start -5 1) (end 0 1) (width 0.25) (layer "F.Cu") (net "B") (uuid "t1"))
  (arc (start 0 1) (mid 5 1.6) (end 10 1) (width 0.25) (layer "F.Cu") (net "B") (uuid "arc"))
  (segment (start 10 1) (end 15 1) (width 0.25) (layer "F.Cu") (net "B") (uuid "t2"))`);
  P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS, { mode: 1 }));
  const SW = P.shoveWorld(doc, P.designSettings(doc), true);
  assert.ok(SW.tracks.has("arc"), "an unlocked arc is movable");
  const st = P.shoveRun(SW, [{ pts: [[3, 1.5], [7, 1.5]], w: 0.25, layer: "F.Cu", net: "A" }], P.state.rs);
  assert.ok(st, "the shove succeeds");
  const L = st.lineOf.get("arc"); assert.ok(L && L.arcs, "the arc's whole line (with its arc tags) was pushed");
  for (let i = 0; i + 1 < L.pts.length; i++) assert.ok(P.segSegDist(L.pts[i], L.pts[i + 1], [3, 1.5], [7, 1.5]) >= 0.25 + 0.2 - 1e-4, "clear of the head");
  assert.ok(near(L.pts[0], [-5, 1]) && near(L.pts[L.pts.length - 1], [15, 1]), "its ends stay");
  const ops = P.shoveOps(doc, st); assert.ok(ops.length > 0);
  assert.ok(ops.some((o) => (o.node || o.add) && (o.node || o.add)[0] === "arc"), "the kept parts of the arc are written back as arcs");
  // a short arc crossed deep by a long head: shoving it round the head would more than double it -> SH_TRY_WALK, and a head cannot walk
  const doc2 = board(`(arc (start 4 0) (mid 5 0.2) (end 6 0) (width 0.25) (layer "F.Cu") (net "B") (uuid "arc"))`);
  const SW2 = P.shoveWorld(doc2, P.designSettings(doc2), true);
  assert.equal(P.shoveRun(SW2, [{ pts: [[5, -6], [5, 6]], w: 0.25, layer: "F.Cu", net: "A" }], P.state.rs), null);
  const doc3 = board(`(segment (start 4 0) (end 6 0) (width 0.25) (layer "F.Cu") (net "B") (uuid "seg"))`);
  const SW3 = P.shoveWorld(doc3, P.designSettings(doc3), true);
  assert.ok(P.shoveRun(SW3, [{ pts: [[5, -6], [5, 6]], w: 0.25, layer: "F.Cu", net: "A" }], P.state.rs), "the same as a segment is shoved (onCollidingSegment has no such limit)");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
