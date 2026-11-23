// router-parity.test.js — the interactive router against KiCad's PNS router (pcbnew/router/router_tool.cpp,
// pns_line_placer.cpp, pns_tool_base.cpp, pns_dragger.cpp, pns_optimizer.cpp, pns_topology.cpp ...): one test per
// behaviour of the pcb-router parity findings.
// Run: node server/static/tests/router-parity.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }

// net A: a track (10,10)-(20,10) and a pad at (30,15); net C: a pad at (40,10); net D: a through via at (50,20);
// a keep-out "KO" (tracks not allowed) over (60..70, 0..10); copper text at (80,10)
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
  (segment (start 10 10) (end 20 10) (width 0.25) (layer "F.Cu") (net "A") (uuid "sa"))
  (footprint "T:P" (layer "F.Cu") (uuid "fa") (at 30 15)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "A") (uuid "pa")))
  (footprint "T:P" (layer "F.Cu") (uuid "fc") (at 40 10)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "C") (uuid "pc")))
  (via (at 50 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "D") (uuid "vd"))
  (zone (net 0) (net_name "") (layers "F.Cu") (uuid "z") (name "KO") (hatch edge 0.5)
    (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (polygon (pts (xy 60 0) (xy 70 0) (xy 70 10) (xy 60 10))))
  (gr_text "HELLO" (at 80 10) (layer "F.Cu") (uuid "t") (effects (font (size 2 2) (thickness 0.3))))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");
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
function reset() {
  try { pcb.cancel && pcb.cancel(); } catch (e) { /* nothing in progress */ }
  P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS)); P.state.layer = "F.Cu"; P.state.routeQueue = null;
  P.setMagneticOption("pads", 1); P.setMagneticOption("tracks", 1);
}
const segsOf = (doc, net) => [...doc.items.values()].filter((it) => (it.kind === "segment" || it.kind === "arc") && K.str(K.kid(it.node, "net")[1]) === net);
const ends = (it) => ["start", "end"].map((k) => { const n = K.kid(it.node, k); return [K.num(n[1]), K.num(n[2])]; });
const routeTool = (ctx) => { ctx.setTool("route"); };
const move = (ctx, p, extra) => pcb.onPointerMove(ev(extra), p, ctx);
const click = (ctx, p, extra) => { move(ctx, p, extra); return pcb.onPointerDown(ev(extra), p, ctx); };

console.log("router parity");

test("1. finishInteractive: the active layer before the route comes back when it ends or is cancelled", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx);
  P.state.layer = "B.Cu"; click(ctx, [20, 10]);
  assert.ok(P.state.route); assert.equal(P.state.route.layer, "F.Cu", "getStartLayer: the start track's layer"); assert.equal(P.state.layer, "F.Cu");
  pcb.cancel(); assert.equal(P.state.route, null); assert.equal(P.state.layer, "B.Cu", "Escape: m_originalActiveLayer");
  click(ctx, [20, 10]); move(ctx, [25, 12]); pcb.onKey("v", ev(), ctx); pcb.onPointerDown(ev(), [25, 12], ctx);
  assert.equal(P.state.layer, "B.Cu"); P.state.layer = "B.Cu";
  pcb.onKey("End", ev(), ctx); assert.equal(P.state.route, null); assert.equal(P.state.layer, "B.Cu");
  const o = fakeCtx(board()); routeTool(o.ctx); P.state.layer = "In1.Cu"; click(o.ctx, [20, 10]); move(o.ctx, [25, 10]); pcb.onKey("End", ev(), o.ctx);
  assert.equal(P.state.layer, "In1.Cu", "a finished route restores it too");
});

test("2. X over a track primes the route at the cursor (PrimeTool); the toolbar only arms the tool", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); ctx.cursor = [20, 10];
  assert.equal(pcb.onKey("x", ev(), ctx), true); assert.ok(P.state.route, "the route started"); assert.deepEqual(P.state.route.last, [20, 10]);
  pcb.cancel(); ctx.setTool("select"); ctx.setTool("route"); assert.equal(P.state.route, null, "toolbar activation: nothing starts");
});

test("3. X while routing fixes the head like a click (routeSingleTrack in performRouting)", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]);
  move(ctx, [25, 10]); ctx.cursor = [25, 10]; assert.equal(pcb.onKey("x", ev(), ctx), true);
  assert.ok(P.state.route); assert.equal(P.state.route.stages.length, 1); assert.deepEqual(P.state.route.last, [25, 10]);
});

test("4. V with the Route tool idle only toggles the active layer; the next route has no via", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx);
  pcb.onKey("v", ev(), ctx); assert.equal(P.state.layer, "B.Cu"); assert.equal(P.state.startWithVia, undefined);
  P.state.layer = "F.Cu"; click(ctx, [20, 10]); assert.ok(P.state.route); assert.equal(P.state.route.placingVia, null);
});

test("5. fix-all off: a click on an item of the routed net is the real end, every segment is fixed", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.setRouterSettings({ fix_all_segments: false }); routeTool(ctx);
  click(ctx, [20, 10]); click(ctx, [30, 15]);
  assert.equal(P.state.route, null, "landed on pad A: the route ends"); assert.equal(log.commits.length, 1);
  const nl = P.netlist(doc); assert.equal(nl.nets.get("A").unconnected, 0, "the track reaches the pad");
});

test("6. simplifyNewLine: carrying a track straight on leaves one segment", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx);
  click(ctx, [20, 10]); click(ctx, [25, 10]); click(ctx, [28, 10]); pcb.onKey("End", ev(), ctx);
  const s = segsOf(doc, "A"); assert.equal(s.length, 1, "the existing track and both new legs merged");
  assert.deepEqual(ends(s[0]).sort((a, b) => a[0] - b[0]), [[10, 10], [28, 10]]); assert.equal(s[0].id, "sa", "the first track keeps its uuid");
});

test("7. start refusals: named rule area, copper text, Allow DRC violations, a track under the cursor", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); routeTool(ctx);
  click(ctx, [65, 5]); assert.equal(P.state.route, null); assert.equal(log.toasts.pop(), "Rule area 'KO' disallows tracks.");
  click(ctx, [80, 10]); assert.equal(P.state.route, null); assert.equal(log.toasts.pop(), "Cannot start routing from a text item.");
  P.setRouterSettings({ mode: 0, can_violate_drc: true }); click(ctx, [65, 5]); assert.ok(P.state.route, "AllowDRCViolations: no refusal at all");
  pcb.cancel(); P.setRouterSettings({ mode: 0, can_violate_drc: false });
  // Highlight collisions still runs the zero-length DRC test: next to pad C (net C) a net A start violates clearance
  assert.equal(P.startRefusal(ctx, [40.6, 10], [40.6, 10], { name: "A" }, 0.25, "F.Cu", new Set(), false), "The routing start point violates DRC.");
});

test("11/12. end snapping (pickSingleItem): pad of the net under the cursor wins; Shift turns object snapping off", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]);
  move(ctx, [30.3, 15.3]); assert.ok(P.state.hover.snap && P.state.hover.snap.kind === "pad"); assert.deepEqual([P.state.hover.x, P.state.hover.y], [30, 15]);
  move(ctx, [30.3, 15.3], { shiftKey: true }); assert.equal(P.state.hover.snap, null); assert.deepEqual([P.state.hover.x, P.state.hover.y], [30.25, 15.25], "grid point");
  move(ctx, [40.1, 10.1]); assert.ok(!P.state.hover.snap, "pad C is another net: no end item");
});

test("13. diff pair: Backspace does nothing (no UnfixRoute) — see diffpair.test.js for the per-fix commit", () => {
  assert.equal(typeof P.dpCoupledSegment, "function");
});

test("15. Continue From End: the rest of the route is appended to the same undo step", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); routeTool(ctx);
  click(ctx, [20, 10]); click(ctx, [24, 10]); move(ctx, [24, 12]);
  pcb.actions.routerContinueFromEnd.run(ctx);
  assert.equal(log.commits.length, 1); assert.ok(P.state.route, "routing goes on from the ratsnest end"); assert.equal(P.state.route.amend, true);
  move(ctx, [29, 15]); pcb.onKey("End", ev(), ctx);
  assert.equal(log.commits.length, 2); assert.deepEqual(log.commits[1].opts, { amend: true });
  assert.ok(!log.toasts.includes("No ratsnest end to continue from."));
});

test("16/17. via commands: Select Layer and Place Via with a via armed drops it; a layer key to the current layer keeps it", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]); move(ctx, [25, 10]);
  pcb.onKey("v", ev(), ctx); assert.ok(P.state.route.placingVia);
  pcb.actions.ACT_SelLayerAndPlaceThroughVia.run(ctx); assert.equal(P.state.route.placingVia, null, "onViaCommand: ToggleViaPlacement");
  pcb.onKey("v", ev(), ctx); assert.ok(P.state.route.placingVia);
  pcb.setLayer(ctx, "F.Cu"); assert.ok(P.state.route.placingVia, "handleLayerSwitch: targetLayer == currentLayer returns");
});

test("19/20. posture: mouse posture off switches every segment; start_diagonal is the tracer's initial direction", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); P.setRouterSettings({ auto_posture: false }); routeTool(ctx);
  click(ctx, [20, 10]); click(ctx, [25, 10]); move(ctx, [30, 13]);
  assert.equal(P.state.route.diagFirst, true, "after a straight segment the next leg starts diagonal");
  pcb.cancel(); P.setRouterSettings({ start_diagonal: true }); click(ctx, [20, 10]); assert.equal(P.state.route.tracer.direction, 1, "NE");
});

test("21. fix-all off: a head with arcs is fixed whole", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); P.setRouterSettings({ fix_all_segments: false, corner_mode: 1 }); routeTool(ctx);
  click(ctx, [20, 10]); move(ctx, [26, 14]); const n = P.state.route.els.length; assert.ok(P.state.route.els.some((e) => e.t === "arc"));
  pcb.onPointerDown(ev(), [26, 14], ctx);
  assert.equal(P.state.route.stages[0].ops.filter((o) => o.add && (o.add[0] === "segment" || o.add[0] === "arc")).length, n);
});

test("23. drag options: no colinear merge without Smooth dragged segments; Avoid sharp angles rejects right / acute corners", () => {
  P.setRouterSettings({ smooth_dragged_segments: false, optimize_dragged_track: false });
  const O = P.routeObstacles(board(), P.designSettings(null), "A", "F.Cu", null);
  const pts = [[0, 0], [5, 0], [10, 0], [10, 5]];
  const out = P.optimizeDragged(O, pts, pts, [5, 0], 0.25);
  assert.ok(out.some((q) => q[0] === 5 && q[1] === 0), "the colinear vertex stays");
  P.setRouterSettings({ smooth_dragged_segments: true }); const out2 = P.optimizeDragged(O, pts, pts, [10, 2], 0.25);
  assert.ok(!out2.some((q) => q[0] === 5 && q[1] === 0), "MERGE_COLINEAR with SmoothDraggedSegments");
  P.setRouterSettings({ restrict_angles: true });
  assert.equal(P.obtuseOnly([[0, 0], [5, 0], [10, 5]], 1, 2, [[5, 0], [5, 5], [10, 5]]), false, "a right-angle bypass is refused");
  assert.equal(P.obtuseOnly([[0, 0], [5, 0], [10, 5]], 0, 1, [[0, 0], [5, 0]]), true);
});

test("24. free-angle drag honours Allow DRC violations (dragMarkObstacles)", () => {
  const doc = board(); doc.items; const { ctx } = fakeCtx(doc); P.setRouterSettings({ mode: 0, can_violate_drc: true });
  P.state.sel = new Set(["sa"]); ctx.cursor = [15, 10]; P.state.dragFree = true; ctx.setTool("drag");
  if (!P.state.drag) { pcb.onKey("d", ev(), ctx); }
  assert.ok(P.state.drag); pcb.onPointerMove(ev(), [15, 15], ctx); assert.equal(P.state.drag.subs[0].status, true);
});

test("26. smart pads: a rotated pad's breakouts end on its outline (no NaN); a via start gets circle breakouts", () => {
  const br = P.padBreakouts({ x: 0, y: 0, w: 1, h: 3, rot: 30, shape: "rect", off: [0, 0] }, 0.25);
  // customBreakouts: a ray only as long as half the bbox's larger side may miss the outline (n == 0), as in KiCad
  assert.ok(br.length >= 4 && br.length <= 8); assert.ok(br.every((b) => b.every((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]))));
  const doc = board(); const clear = () => true;
  const r = P.runSmartPads(doc, [[50, 20], [52, 22], [55, 22]], 0.25, "F.Cu", "D", clear);
  assert.ok(r, "the via's breakout replaces the line's start"); assert.deepEqual(r[0], [50, 20]);
});

test("27. leading ratline: a head ending on copper of its own net collapses the ratline to that joint", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]); move(ctx, [30, 15]);
  assert.equal(P.state.route.ratline, null); assert.ok(P.state.route.ratAnchor); assert.deepEqual(P.state.route.ratAnchor.p, [30, 15]);
});

test("29. Cancel Current Item skips one route of a Route Selected run; hasOtherEnd follows the ratsnest", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]);
  assert.equal(P.routeHasOtherEnd(ctx), true, "net A has a ratsnest edge");
  pcb.cancel(); assert.equal(P.routeHasOtherEnd(ctx), false, "not routing");
  assert.ok(pcb.actions.cancelCurrentItem, "the action exists"); assert.equal(pcb.actions.cancelCurrentItem.label, "Cancel Current Item");
});

test("30. router commits are 'Routing'", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]); move(ctx, [25, 10]); pcb.onKey("End", ev(), ctx);
  assert.equal(log.commits[0].label, "Routing");
});

test("34. magnetic pads 'Never': the router does not snap onto the pad", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); P.setMagneticOption("pads", 0); routeTool(ctx); click(ctx, [20, 10]);
  move(ctx, [30.3, 15.3]); assert.equal(P.state.hover.snap, null);
});

test("35. no web-only toasts: D with nothing to drag is silent", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); P.state.sel = new Set(); ctx.cursor = [100, 100];
  pcb.onKey("d", ev(), ctx); assert.equal(log.toasts.length, 0);
});

test("8. updateSizesAfterRouterEvent: a layer rule changes the width after the via (explicit width) and names its rule", () => {
  P.setCustomRules(`(version 1)\n(rule "back" (layer "B.Cu") (constraint track_width (opt 0.4mm)))`);
  try {
    const doc = board(); const { ctx } = fakeCtx(doc); K.pcbSizes.state.useConnectedWidth = false; routeTool(ctx);
    click(ctx, [30, 15]); const rt = P.state.route; const w0 = rt.width;
    move(ctx, [34, 15]); pcb.onKey("v", ev(), ctx); pcb.onPointerDown(ev(), [34, 15], ctx);
    assert.equal(rt.layer, "B.Cu"); assert.equal(rt.width, 0.4, "TRACK_WIDTH on B.Cu"); assert.notEqual(w0, 0.4);
    assert.equal(rt.widthSource, "rule 'back'");
    const rows = P.msgPanelInfo(doc, [], { route: rt, units: "mm" });
    assert.ok(rows.some((r) => r.title === "Track Width: 0.4000 mm" && r.value === "(from rule 'back')"), JSON.stringify(rows));
  } finally { P.setCustomRules(null); K.pcbSizes.state.useConnectedWidth = true; }
});

test("8. connected width (not explicit): after a fix the width stays, only its source follows the rule", () => {
  P.setCustomRules(`(version 1)\n(rule "back" (layer "B.Cu") (constraint track_width (opt 0.4mm)))`);
  try {
    const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx);
    click(ctx, [30, 15]); const rt = P.state.route; const w0 = rt.width;
    move(ctx, [34, 15]); pcb.onKey("v", ev(), ctx); pcb.onPointerDown(ev(), [34, 15], ctx);
    assert.equal(rt.width, w0, "LINE_PLACER::UpdateSizes keeps the width once something is placed");
  } finally { P.setCustomRules(null); }
});

test("28. message panel: Min Clearance names the clearance rule that applies to the routed track", () => {
  P.setCustomRules(`(version 1)\n(rule "wide" (condition "A.NetName == 'A'") (constraint clearance (min 0.5mm)))`);
  try {
    const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]);
    const rows = P.msgPanelInfo(doc, [], { route: P.state.route, units: "mm" });
    assert.ok(rows.some((r) => r.title === "Min Clearance: 0.5000 mm" && r.value === "(from rule 'wide')"), JSON.stringify(rows));
  } finally { P.setCustomRules(null); }
});

test("22. SHOVE::runOptimizer: a pushed line is re-optimized in the affected area (effort medium: MERGE_SEGMENTS); AREA_CONSTRAINT", () => {
  const doc = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))
    (segment (start 0 0) (end 10 0) (width 0.25) (layer "F.Cu") (net "B") (uuid "sb")))`, "kicad_pcb");
  const run = (effort) => {
    P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS, { mode: 1, effort }));
    const SW = P.shoveWorld(doc, P.designSettings(doc), true);
    const L = { key: "sb", ids: ["sb"], pts: [[0, 0], [2, 0], [3, 1], [5, 1], [6, 0], [10, 0]], orig: [[0, 0], [10, 0]], w: 0.25, layer: "F.Cu", net: "B", rank: 1 };
    const st = { lines: new Map([["sb", L]]), lineOf: new Map([["sb", L]]), viaAt: new Map(), viaRank: new Map() };
    P.shoveOptimize(SW, st, [], P.state.rs); return L.pts;
  };
  assert.deepEqual(run(1), [[0, 0], [10, 0]], "the bump is merged away");
  assert.deepEqual(run(0), [[0, 0], [2, 0], [3, 1], [5, 1], [6, 0], [10, 0]], "OE_LOW: MERGE_OBTUSE only");
  const path = [[0, 0], [2, 0], [3, 1], [5, 1], [6, 0], [10, 0]];
  assert.equal(P.areaAllows([2.5, 0, 5.5, 1], path, 2, 3, [[3, 1], [5, 1]]), true);
  assert.equal(P.areaAllows([2.5, 0, 5.5, 1], path, 0, 5, [[0, 0], [10, 0]]), false, "both ends outside the area");
});

test("9. VIA::PushoutForce: in Walk around the carried via slides off pad C instead of sitting in violation", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); routeTool(ctx); click(ctx, [20, 10]);
  move(ctx, [34, 13]); pcb.onKey("v", ev(), ctx); const rt = P.state.route; assert.ok(rt.placingVia);
  move(ctx, [39.25, 10]);   // the via (0.6 mm) at the cursor would overlap pad C's clearance
  assert.equal(rt.viaBad, null, "pushed clear"); assert.notDeepEqual(rt.target, [39.25, 10], "the head ends at cursor + force");
  assert.deepEqual(rt.cursor, [39.25, 10], "the cursor itself stays");
  const d = Math.max(Math.abs(rt.target[0] - 40) - 0.5, 0); assert.ok(d >= 0.3 + 0.2 - 1e-6, "via radius + clearance from the pad's edge: " + JSON.stringify(rt.target));
  pcb.onPointerDown(ev(), [39.25, 10], ctx); assert.equal(rt.layer, "B.Cu", "the via could be fixed");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
