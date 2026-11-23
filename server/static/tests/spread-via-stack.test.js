// spread-via-stack.test.js — microvia stacks (pcbnew/generators/pcb_via_stack.cpp, DRAWING_TOOL::PlaceMicroviaStack,
// GENERATOR_TOOL::MakeViaStackFromSelection, ROUTER_TOOL::onViaStackCommand), their DRC (drc_test_provider_via_stack.cpp)
// and Spread Tracks (ROUTER_TOOL::SpreadTracks, pns_tracks_spreader.cpp).
// Run: node server/static/tests/spread-via-stack.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const VS = P.viaStack, SP = P.spread;
const IU = 1e6;

let passed = 0, failed = 0;
function test(name, fn) { reset(); try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 8).join("\n       ")); } }

const LAYERS = `(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user))`;
const BOARD = `(kicad_pcb (version 20260728) (generator "pcbnew") ${LAYERS}
  (footprint "T:P" (layer "F.Cu") (uuid "fa") (at 10 10)
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "N1") (uuid "pa")))
  (segment (start 0 20) (end 5 20) (width 0.2) (layer "F.Cu") (net "N1") (uuid "s1"))
)`;
const PRESETS = { board: { design_settings: { via_stack_presets: [
  { name: "S1", start_layer: "F.Cu", end_layer: "In2.Cu", staggered: false, via_size: 0.3, via_drill: 0.15, use_netclass: false, filled: true, capped: false, pitch: 0 },
  { name: "G1", start_layer: "F.Cu", end_layer: "In2.Cu", staggered: true, via_size: 0.3, via_drill: 0.15, use_netclass: false, filled: false, capped: true, pitch: 0.5 },
] } } };
const board = (src) => K.parseDoc(src || BOARD, "kicad_pcb");
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], tool: "select" };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    designSettings: JSON.stringify(PRESETS),
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
  P.setRouterSettings(Object.assign({}, P.RS_DEFAULTS)); P.state.layer = "F.Cu"; P.state.sel = new Set();
  P.setMagneticOption("pads", 1); P.setMagneticOption("tracks", 1);
  K.pcbSizes.state.viaStackIndex = 0;
}
const move = (ctx, p, extra) => pcb.onPointerMove(ev(extra), p, ctx);
const click = (ctx, p, extra) => { move(ctx, p, extra); return pcb.onPointerDown(ev(extra), p, ctx); };
const items = (doc, kind) => [...doc.items.values()].filter((it) => it.kind === kind);
const layersOf = (it) => K.kid(it.node, "layers").slice(1).map(K.str);
const at = (it, k = "at") => { const n = K.kid(it.node, k); return [K.num(n[1]), K.num(n[2])]; };
const stacks = (doc) => items(doc, "generated").filter((g) => K.str(K.kid(g.node, "type")[1]) === "via_stack");

console.log("microvia stacks and spread tracks");

test("presets: BOARD_DESIGN_SETTINGS' reader (case-insensitive dedupe, defaults, pitch clamp)", () => {
  const ps = VS.viaStackPresets(JSON.stringify({ board: { design_settings: { via_stack_presets: [
    { name: "A", start_layer: "In1.Cu", end_layer: "In3.Cu", pitch: 40 }, { name: "a" }, { start_layer: "F.Cu" }, { name: "B", start_layer: "Edge.Cuts", via_size: -1 }] } } }));
  assert.deepEqual(ps.map((p) => p.name), ["A", "B"]);
  assert.equal(ps[0].pitch, 25, "MAX_MICROVIA_STACK_PITCH_MM"); assert.equal(ps[0].filled, true); assert.equal(ps[0].capped, false); assert.equal(ps[0].staggered, false);
  assert.equal(ps[1].start_layer, "F.Cu"); assert.equal(ps[1].end_layer, "In1.Cu"); assert.equal(ps[1].via_size, 0);
});

test("ViaStackTargetLayer: the other end of the span, nothing from a layer inside it", () => {
  assert.equal(VS.viaStackTargetLayer("F.Cu", "In2.Cu", "F.Cu"), "In2.Cu");
  assert.equal(VS.viaStackTargetLayer("F.Cu", "In2.Cu", "In2.Cu"), "F.Cu");
  assert.equal(VS.viaStackTargetLayer("F.Cu", "In2.Cu", "In1.Cu"), null);
  assert.equal(VS.viaStackTargetLayer("F.Cu", "F.Cu", "F.Cu"), null);
});

test("BuildMembers: stacked hops coaxial and filled; staggered hops along the chain with traces on the landing layers", () => {
  const { ctx } = fakeCtx(board());
  const st = Object.assign(VS.defaultSettings(), { start: "F.Cu", end: "B.Cu", viaSize: 0.3, viaDrill: 0.15, origin: [1, 2] });
  const m = VS.buildMembers(ctx, st, { code: 0, name: "" });
  assert.deepEqual(m.map((n) => n[0]), ["via", "via", "via"]);
  assert.deepEqual(m.map((n) => K.kid(n, "layers").slice(1).map(K.str)), [["F.Cu", "In1.Cu"], ["In1.Cu", "In2.Cu"], ["In2.Cu", "B.Cu"]]);
  assert.ok(m.every((n) => n[1] === "micro" && K.str(K.kid(n, "filling")[1]) === "yes"));
  const g = Object.assign(VS.defaultSettings(), { start: "F.Cu", end: "B.Cu", staggered: true, filled: false, capped: true, pitch: 0.5, viaSize: 0.3, viaDrill: 0.15, origin: [0, 0], hops: [[0, 0], [0.5, 0]] });
  const n = VS.buildMembers(ctx, g, { code: 0, name: "" });
  const vias = n.filter((x) => x[0] === "via"), segs = n.filter((x) => x[0] === "segment");
  assert.deepEqual(vias.map((v) => [K.num(K.kid(v, "at")[1]), K.num(K.kid(v, "at")[2])]), [[0, 0], [0.5, 0], [1, 0]], "the third hop extrapolates the last step");
  assert.deepEqual(vias.map((v) => K.str(K.kid(v, "capping")[1])), ["yes", "no", "yes"], "capped only where a hop reaches an outer layer");
  assert.deepEqual(vias.map((v) => K.str(K.kid(v, "filling")[1])), ["yes", "no", "yes"], "filled = stacked || filled || capped");
  assert.deepEqual(segs.map((x) => K.str(K.kid(x, "layer")[1])), ["In1.Cu", "In2.Cu"]);
});

test("the generator node: PCB_IO_KICAD_SEXPR's property order and the sorted members", () => {
  const st = Object.assign(VS.defaultSettings(), { start: "F.Cu", end: "In2.Cu", viaSize: 0.3, viaDrill: 0.15, origin: [1, 2], presetName: "S1" });
  const n = VS.viaStackNode(st, ["b", "a"], "u1");
  assert.equal(K.serialize ? K.serialize(n).replace(/\s+/g, " ") : JSON.stringify(n),
    K.serialize(K.parse('(generated (uuid "u1") (type via_stack) (name "Microvia Stack") (layer "F.Cu") (capped no) (end_layer "In2.Cu") (filled yes) (origin (xy 1 2)) (pitch 0) (preset "S1") (start_layer "F.Cu") (style "stacked") (use_netclass no) (via_drill 0.15) (via_size 0.3) (members "a" "b"))')).replace(/\s+/g, " "));
  const back = VS.viaStackInfo(board(), n);
  assert.equal(back.start, "F.Cu"); assert.equal(back.end, "In2.Cu"); assert.equal(back.viaSize, 0.3); assert.equal(back.presetName, "S1"); assert.deepEqual(back.origin, [1, 2]);
});

test("Place Microvia Stack (stacked preset): one click, the pad's net, \"Place Microvia Stack\"", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  ctx.setTool("viastack"); assert.equal(P.state.modTool, "viastack");
  click(ctx, [10, 10]);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Place Microvia Stack");
  const [g] = stacks(doc); assert.ok(g, "the generator");
  const vias = items(doc, "via"); assert.equal(vias.length, 2);
  assert.deepEqual(vias.map(layersOf).sort(), [["F.Cu", "In1.Cu"], ["In1.Cu", "In2.Cu"]]);
  assert.ok(vias.every((v) => K.str(K.kid(v.node, "net")[1]) === "N1" || K.num(K.kid(v.node, "net")[1]) > 0), "FindNetAtPosition: the pad's net");
  const mem = K.kid(g.node, "members").slice(1).map(K.str).sort(); assert.deepEqual(mem, vias.map((v) => v.id).sort());
});

test("Place Microvia Stack (staggered preset): one click per hop on the pitch circle; undo takes a hop back", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); K.pcbSizes.state.viaStackIndex = 1; P.setAngleSnap(ctx, "45");
  ctx.setTool("viastack");
  click(ctx, [20, 20]); assert.equal(log.commits.length, 0);
  assert.equal(pcb.onKey("Backspace", ev(), ctx), true); assert.equal(VS.stackPlacing().hops.length, 0);
  click(ctx, [20, 20]); click(ctx, [21, 20.1]);
  assert.equal(log.commits.length, 1);
  const vias = items(doc, "via"); assert.deepEqual(vias.map((v) => at(v)).sort((a, b) => a[0] - b[0]), [[20, 20], [20.5, 20]], "the hop held on the 0.5 mm pitch, snapped to 45°");
  assert.equal(items(doc, "segment").filter((s) => K.str(K.kid(s.node, "layer")[1]) === "In1.Cu").length, 1, "the landing trace");
  P.setAngleSnap(ctx, "free"); ctx.setTool("select");
});

test("Create Stack from Selection: coaxial single-step microvias become a stacked stack; a gap is refused", () => {
  const src = `(kicad_pcb (version 20260728) (generator "pcbnew") ${LAYERS}
    (via micro (at 5 5) (size 0.3) (drill 0.15) (layers "F.Cu" "In1.Cu") (net "N") (uuid "v1"))
    (via micro (at 5 5) (size 0.3) (drill 0.15) (layers "In1.Cu" "In2.Cu") (net "N") (uuid "v2"))
    (via micro (at 8 8) (size 0.3) (drill 0.15) (layers "In2.Cu" "B.Cu") (net "N") (uuid "v3"))
    (via micro (at 9 9) (size 0.4) (drill 0.15) (layers "In2.Cu" "B.Cu") (net "N") (uuid "v4")))`;
  const doc = board(src); const { ctx, log } = fakeCtx(doc);
  P.state.sel = new Set(["v1", "v3"]); pcb.actions.makeViaStack.run(ctx);
  assert.equal(log.commits.length, 0); assert.equal(log.toasts.pop(), VS.STACK_NEEDS);
  P.state.sel = new Set(["v1", "v2", "v4"]); pcb.actions.makeViaStack.run(ctx);
  assert.equal(log.toasts.pop(), VS.STACK_MIXED_SIZES);
  P.state.sel = new Set(["v1", "v2"]); pcb.actions.makeViaStack.run(ctx);
  assert.equal(log.commits.pop().label, "Create Microvia Stack");
  const [g] = stacks(doc); const st = VS.viaStackInfo(doc, g.node);
  assert.equal(st.staggered, false); assert.equal(st.start, "F.Cu"); assert.equal(st.end, "In2.Cu"); assert.equal(st.filled, true);
});

test("ExpandMultiHopMicrovias: a loose F.Cu-In2.Cu microvia becomes a stacked stack of single hops", () => {
  const src = `(kicad_pcb (version 20260728) (generator "pcbnew") ${LAYERS}
    (via micro (at 5 5) (size 0.3) (drill 0.15) (layers "F.Cu" "In2.Cu") (net "N") (uuid "v1")))`;
  const doc = board(src); const { ctx } = fakeCtx(doc);
  const ch = VS.expandMultiHopMicrovias(ctx, null); ctx.commit(ch, "Expand Microvia Stacks");
  assert.equal(doc.items.has("v1"), false);
  assert.deepEqual(items(doc, "via").map(layersOf).sort(), [["F.Cu", "In1.Cu"], ["In1.Cu", "In2.Cu"]]);
  assert.equal(stacks(doc).length, 1);
});

test("Place Microvia Stack at Track End (stacked): the route's multi-hop microvia is expanded, joined to the route's undo", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); ctx.setTool("route");
  click(ctx, [5, 20]); move(ctx, [8, 20]);
  pcb.actions.ACT_PlaceViaStack.run(ctx);
  assert.equal(P.state.route.placingVia.type, "micro"); assert.equal(P.state.route.placingVia.toLayer, "In2.Cu");
  assert.equal(P.state.route.placingVia.diameter, 0.3);
  click(ctx, [8, 20]); pcb.onKey("End", ev(), ctx);
  const labels = log.commits.map((c) => c.label); assert.deepEqual(labels, ["Routing", "Expand Microvia Stacks"]);
  assert.equal(log.commits[1].opts.amend, true, "APPEND_UNDO");
  assert.deepEqual(items(doc, "via").map(layersOf).sort(), [["F.Cu", "In1.Cu"], ["In1.Cu", "In2.Cu"]]);
  assert.equal(stacks(doc).length, 1);
});

test("Place Microvia Stack at Track End (staggered): the track is fixed, the stack tool takes over at its end, routing resumes on the far layer", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); K.pcbSizes.state.viaStackIndex = 1; P.setAngleSnap(ctx, "45"); ctx.setTool("route");
  click(ctx, [5, 20]); move(ctx, [8, 20]);
  pcb.actions.ACT_PlaceViaStack.run(ctx);
  assert.equal(P.state.route, null, "the route ended"); assert.equal(log.commits[0].label, "Routing");
  assert.equal(log.tool, "viastack"); assert.deepEqual(VS.stackPlacing().hops, [[8, 20]], "seeded at the routed head");
  click(ctx, [8.6, 20]);
  assert.equal(log.commits[1].label, "Place Microvia Stack");
  assert.deepEqual(items(doc, "via").map((v) => at(v)).sort((a, b) => a[0] - b[0]), [[8, 20], [8.5, 20]]);
  assert.equal(log.tool, "route"); assert.ok(P.state.route, "routing resumes"); assert.equal(P.state.route.layer, "In2.Cu"); assert.deepEqual(P.state.route.last, [8.5, 20]);
  pcb.cancel(); P.setAngleSnap(ctx, "free");
});

test("Place Microvia Stack at Track End: refused off the preset's layers, and with no presets", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); ctx.setTool("route");
  click(ctx, [5, 20]); move(ctx, [8, 20]); P.state.route.layer = "In1.Cu";
  pcb.actions.ACT_PlaceViaStack.run(ctx);
  assert.equal(log.toasts.pop(), "The microvia stack runs between F.Cu and In2.Cu. Route on one of those layers to place it.");
  ctx.designSettings = null; pcb.actions.ACT_PlaceViaStack.run(ctx);
  assert.equal(log.toasts.pop(), "No microvia stack presets defined. Add one in Board Setup, Microvia Stacks.");
});

test("via_stack DRC: unfilled column, stack depth, core and dielectric spans, aspect ratio, malformed span", () => {
  const src = `(kicad_pcb (version 20260728) (generator "pcbnew") (general (thickness 1.6)) ${LAYERS}
    (via micro (at 5 5) (size 0.3) (drill 0.15) (layers "F.Cu" "In1.Cu") (net "N") (uuid "v1"))
    (via micro (at 5 5) (size 0.3) (drill 0.15) (layers "In1.Cu" "In2.Cu") (filling yes) (net "N") (uuid "v2"))
    (via micro (at 9 9) (size 0.3) (drill 0.1) (layers "F.Cu" "In2.Cu") (net "N") (uuid "v3"))
    (generated (uuid "g1") (type via_stack) (name "Microvia Stack") (layer "F.Cu") (capped no) (end_layer "B.Cu") (filled yes) (origin (xy 5 5)) (pitch 0) (preset "") (start_layer "F.Cu") (style "stacked") (use_netclass no) (via_drill 0.15) (via_size 0.3) (members "v1" "v2")))`;
  const doc = board(src); const s = P.designSettings(null);
  const rules = P.parseDru(`(version 1)
(rule depth (constraint microvia_stack_depth (max 1)))
(rule ratio (constraint hole_aspect_ratio (max 1)))`).rules;
  const ms = P.viaStackMarkers(doc, s, rules, null, K.kid(K.parse(src), "general"));
  const by = (code) => ms.filter((m) => m.code === code);
  assert.equal(by("malformed_microvia_stack_span").length, 1, "the hops do not tile F.Cu-B.Cu");
  assert.equal(by("microvia_stack_not_filled").length, 1, "v1 (board default: not filled); v2 is filled");
  assert.equal(by("microvia_stack_not_filled")[0].ids[0], "v1");
  const depth = by("microvia_stack_depth"); assert.equal(depth.length, 1); assert.equal(depth[0].text, "Microvia stack too deep (Stack is 2 hops deep, limit is 1)");
  const core = by("microvia_crosses_core"); assert.equal(core.length, 2, "the default stackup's first dielectric is core: v1 and v3");
  assert.equal(core[0].text, "Microvia crosses core material (The stackup gives the dielectric between F.Cu and In1.Cu as core)");
  const sp = by("microvia_spans_dielectrics"); assert.equal(sp.length, 1); assert.equal(sp[0].text, "Microvia spans more than one dielectric (The stackup gives 2 dielectrics between F.Cu and In2.Cu)");
  // default stackup: dielectric (1.6 - 4 * 0.035 - 0.02) / 3 = 0.48; v1: 0.48 + 0.035 over a 0.15 drill
  const ar = by("hole_aspect_ratio").find((m) => m.ids[0] === "v1"); assert.ok(ar);
  assert.equal(ar.text, `Hole too deep for its diameter (Aspect ratio ${((0.48 + 0.035) / 0.15).toFixed(2)} exceeds the 1.00 limit)`);
});

test("spreading distance: E's dialog value is nanometres; ] / [ step to the next grid multiple and one more", () => {
  const doc = board(); const { ctx } = fakeCtx(doc); ctx.gridPitch = 0.1;
  P.setRouterSettings({ spread_tracks_distance: 150000 });
  SP.spreadStepDistance(ctx, true); assert.equal(P.state.rs ? P.state.rs.spread_tracks_distance : null, 300000);
  SP.spreadStepDistance(ctx, false); assert.equal(P.state.rs.spread_tracks_distance, 200000);
  P.setRouterSettings({ spread_tracks_distance: 50000 }); SP.spreadStepDistance(ctx, false); assert.equal(P.state.rs.spread_tracks_distance, 0, "never below 0");
  assert.equal(pcb.actions.ACT_SpreadTracksSetDistance.label, "Set Spreading Distance...");
  assert.equal(pcb.actions.ACT_SpreadTracksSetDistance.key, "E");
});

test("Spread Tracks: nothing selected is refused; the picked track's neighbours walk away from it at the distance", () => {
  const src = `(kicad_pcb (version 20260728) (generator "pcbnew") ${LAYERS}
    (segment (start 0 10) (end 20 10) (width 0.2) (layer "F.Cu") (net "A") (uuid "ra"))
    (segment (start 0 10.4) (end 20 10.4) (width 0.2) (layer "F.Cu") (net "B") (uuid "rb")))`;
  const doc = board(src); const { ctx, log } = fakeCtx(doc);
  P.state.sel = new Set(); ctx.setTool("spread");
  assert.equal(log.toasts.pop(), "Please select a group of tracks you want to spread."); assert.equal(log.tool, "select");
  P.setRouterSettings({ spread_tracks_distance: 1000000 });   // 1 mm
  P.state.sel = new Set(["rb"]); ctx.setTool("spread"); assert.ok(SP.spreading());
  click(ctx, [5, 10]);   // the root: net A
  move(ctx, [15, 10]);
  ctx.cursor = [15, 10]; click(ctx, [15, 10]);
  assert.equal(log.commits.length, 1); assert.equal(log.commits[0].label, "Routing");
  const b = [...doc.items.values()].filter((it) => it.kind === "segment" && it.id !== "ra" && K.str(K.kid(it.node, "net")[1]) !== "A");
  const ys = b.flatMap((it) => [at(it, "start")[1], at(it, "end")[1]]);
  assert.ok(Math.max(...ys) > 10.4 + 0.5, "net B was walked out from the root: " + ys.join(","));
  assert.ok(b.some((it) => at(it, "start")[0] === 0 || at(it, "end")[0] === 0), "the line's far end stays");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
