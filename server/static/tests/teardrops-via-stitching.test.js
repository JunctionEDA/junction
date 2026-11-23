// teardrops-via-stitching.test.js — TEARDROP_MANAGER as BOARD_COMMIT::Push runs it (teardrop.cpp, teardrop_utils.cpp,
// board_commit.cpp), the Fill All teardrop rebuild, PCB_VIA_STITCH (pcb_via_stitch.cpp: the grid, staggered and Poisson
// placements, exclusions, the file format) and DRC_TEST_PROVIDER_VIA_STITCH's via_stitch_overlap.
// Run: node server/static/tests/teardrops-via-stitching.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, V = P.viaStitch;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n       ")); } }
const nodeOf = (ch) => { const root = K.parse(ch.sexpr); return root[root.length - 1]; };
const atOf = (n) => { const a = K.kid(n, "at"); return [K.num(a[1]), K.num(a[2])]; };

// ---------------------------------------------------------------- teardrops
const TD = "(teardrops (best_length_ratio 0.5) (max_length 1) (best_width_ratio 1) (max_width 2) (curved_edges no) (filter_ratio 0.9) (enabled yes) (allow_two_segments yes) (prefer_zone_connections yes))";
const VIA_ID = "11111111-1111-1111-1111-111111111111", SEG_ID = "22222222-2222-2222-2222-222222222222";
const viaText = (y) => `(via (at 10 ${y}) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) ${TD} (uuid "${VIA_ID}"))`;
const segText = '(segment (start 10 10) (end 14 10) (width 0.2) (layer "F.Cu") (net 1) (uuid "22222222-2222-2222-2222-222222222222"))';
const tdBoard = () => K.parseDoc(`(kicad_pcb (version 20240108) (generator "pcbnew") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
 (net 0 "") (net 1 "GND") ${viaText(10)})`);
const addSeg = [{ kind: "ADDED", id: SEG_ID, sexpr: `(kicad_pcb ${segText})` }];

test("a track ended on a via gets its teardrop zone in the same commit (UpdateTeardrops of the dirty track)", () => {
  const ch = P.teardropCommitChanges(tdBoard(), addSeg, {});
  assert.strictEqual(ch.length, 1);
  assert.strictEqual(ch[0].kind, "ADDED");
  // teardropUuid: KIID::Combine( track, via ) — the byte-wise XOR of the two uuids
  assert.strictEqual(ch[0].id, "33333333-3333-3333-3333-333333333333");
  const z = nodeOf(ch[0]);
  assert.strictEqual(K.str(K.kid(z, "net_name")[1]), "GND");
  assert.strictEqual(K.num(K.kid(z, "priority")[1]), 30000);   // SetTeardropPriorities starts at 30000
  assert.ok(K.serialize(z).includes("(attr (teardrop (type padvia)))"));
  assert.ok(K.serialize(z).includes("(connect_pads yes (clearance 0)) (min_thickness 0.0254) (fill yes (island_removal_mode 1))"));
  const pts = K.ptsOf(K.kid(z, "polygon")).map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]);
  assert.deepStrictEqual(pts, [[10.796578, 10.1], [10.796578, 9.9], [10.153073, 9.630448], [9.995578, 10], [10.153073, 10.369552]]);
});

test("moving the via rebuilds its teardrop in place (RemoveTeardrops + UpdateTeardrops folded into one MODIFIED)", () => {
  const doc = tdBoard(); const first = P.teardropCommitChanges(doc, addSeg, {});
  const d2 = P.teardropAppliedDoc(doc, [...addSeg, ...first]);
  const mv = [{ kind: "MODIFIED", id: VIA_ID, sexpr: `(kicad_pcb ${viaText(10.05)})` }];
  const ch = P.teardropCommitChanges(d2, mv, {});
  assert.deepStrictEqual(ch.map((c) => c.kind + " " + c.id), ["MODIFIED 33333333-3333-3333-3333-333333333333"]);
  assert.notStrictEqual(K.serialize(K.kid(nodeOf(ch[0]), "polygon")), K.serialize(K.kid(nodeOf(first[0]), "polygon")));
  // foldChanges keeps one change per item id (an undo step applies each id once)
  assert.strictEqual(P.foldChanges(mv, ch).length, 2);
  assert.strictEqual(P.foldChanges(ch, ch).length, 1);
});

test("deleting the track removes its teardrop", () => {
  const doc = tdBoard(); const first = P.teardropCommitChanges(doc, addSeg, {});
  const d2 = P.teardropAppliedDoc(doc, [...addSeg, ...first]);
  const del = [{ kind: "REMOVED", id: SEG_ID }];
  const ch = P.teardropCommitChanges(d2, del, {});
  assert.deepStrictEqual(ch.map((c) => c.kind + " " + c.id), ["REMOVED 33333333-3333-3333-3333-333333333333"]);
});

test("Fill All's full rebuild leaves up-to-date teardrops alone and recreates a stale one", () => {
  const doc = tdBoard(); const first = P.teardropCommitChanges(doc, addSeg, {});
  const d2 = P.teardropAppliedDoc(doc, [...addSeg, ...first]);
  assert.deepStrictEqual(P.teardropFullUpdate(d2, {}), []);
  // the via moved behind the manager's back (a commit that skipped teardrops): the full update fixes the zone
  const d3 = P.teardropAppliedDoc(d2, [{ kind: "MODIFIED", id: VIA_ID, sexpr: `(kicad_pcb ${viaText(10.05)})` }]);
  const ch = P.teardropFullUpdate(d3, {});
  assert.deepStrictEqual(ch.map((c) => c.kind + " " + c.id), ["MODIFIED 33333333-3333-3333-3333-333333333333"]);
});

test("a via with teardrops disabled gets none", () => {
  const off = K.parseDoc(`(kicad_pcb (version 20240108) (generator "pcbnew") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "") (net 1 "GND") ${viaText(10).replace("(enabled yes)", "(enabled no)")})`);
  assert.deepStrictEqual(P.teardropCommitChanges(off, addSeg, {}), []);
});

// ---------------------------------------------------------------- via stitching
const sq = (x0, y0, x1, y1) => `(pts (xy ${x0} ${y0}) (xy ${x1} ${y0}) (xy ${x1} ${y1}) (xy ${x0} ${y1}))`;
const zone = (l, u) => `(zone (net 1) (net_name "GND") (layer "${l}") (uuid "${u}") (hatch edge 0.5) (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon ${sq(0, 0, 20, 20)}) (filled_polygon (layer "${l}") ${sq(0, 0, 20, 20)}))`;
const GEN = "aaaaaaaa-0000-0000-0000-000000000001";
const gen = (o = {}) => `(generated (uuid "${o.uuid || GEN}") (type via_stitch) (name "Via Stitching") (layer "F.Cu") ${o.extra || ""} (layout ${o.layout || 0}) (mode 0) (net_name "${o.net || "GND"}") (origin (xy 0 0)) (origin_offset_x 0) (origin_offset_y 0) (outline ${o.outline || sq(2, 2, 10, 10)}) (pitch 2) (seed 0) (templates (template (name "via") (via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (free yes)))) (members))`;
const stBoard = (gens) => K.parseDoc(`(kicad_pcb (version 20260206) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
 (net 0 "") (net 1 "GND") (net 2 "VCC") ${zone("F.Cu", "bbbbbbbb-0000-0000-0000-000000000001")} ${zone("B.Cu", "bbbbbbbb-0000-0000-0000-000000000002")} ${gens.join(" ")})`);
const stitchOf = (doc, id = GEN) => V.readStitch(doc.items.get(id).node);
const placed = (r) => r.changes.slice(1).filter((c) => c.kind === "ADDED").map((c) => atOf(nodeOf(c))).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

test("plain grid: one via per pitch cell inside the outline deflated by the via radius", () => {
  const doc = stBoard([gen()]); const r = V.viaStitchUpdate(doc, stitchOf(doc), {}, null, true);
  assert.strictEqual(r.changes[0].id, GEN);
  assert.deepStrictEqual(placed(r), [[4, 4], [4, 6], [4, 8], [6, 4], [6, 6], [6, 8], [8, 4], [8, 6], [8, 8]]);
  const g = nodeOf(r.changes[0]);
  assert.strictEqual(K.groupMemberIds(g).length, 9);
  for (const c of r.changes.slice(1)) { const v = nodeOf(c); assert.strictEqual(K.str(K.kid(v, "net")[1]) === "GND" || K.num(K.kid(v, "net")[1]) === 1, true); }
});

test("staggered grid shifts odd rows by half a pitch", () => {
  const doc = stBoard([gen({ layout: 1 })]); const r = V.viaStitchUpdate(doc, stitchOf(doc), {}, null, true);
  const pts = placed(r);
  assert.ok(pts.some((p) => p[1] === 6 && p[0] % 2 === 1), JSON.stringify(pts));   // row 3 (y = 6) is odd
  assert.ok(pts.every((p) => (p[1] / 2) % 2 === 0 ? p[0] % 2 === 0 : p[0] % 2 === 1));
});

test("Poisson layout: the baked tile and the placement are deterministic and keep the minimum spacing", () => {
  const t1 = P.viaStitchTile(), t2 = P.viaStitchTile();
  assert.ok(t1.length > 10); assert.strictEqual(t1, t2);
  for (const [x, y] of t1) assert.ok(x >= 0 && x < 1 && y >= 0 && y < 1);
  const doc = stBoard([gen({ layout: 2, outline: sq(0, 0, 16, 16) })]);
  const a = placed(V.viaStitchUpdate(doc, stitchOf(doc), {}, null, true)), b = placed(V.viaStitchUpdate(doc, stitchOf(doc), {}, null, true));
  assert.deepStrictEqual(a, b); assert.ok(a.length > 5);
  for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) assert.ok(Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1]) >= 2 / 8 * 0.999);
});

test("excluded grid cells get no via and round-trip through the file format", () => {
  const doc = stBoard([gen({ extra: "(excluded_grid_cells (cells (ij 3 3) (ij 2 2)))" })]);
  const st = stitchOf(doc); assert.deepStrictEqual(st.exCells, [[3, 3], [2, 2]]);
  const r = V.viaStitchUpdate(doc, st, {}, null, true);
  const pts = placed(r); assert.strictEqual(pts.length, 7); assert.ok(!pts.some((p) => (p[0] === 6 && p[1] === 6) || (p[0] === 4 && p[1] === 4)));
  const text = K.serialize(V.writeStitch(st));
  assert.ok(text.includes("(excluded_grid_cells (cells (ij 2 2) (ij 3 3))) (layout 0) (mode 0) (net_name \"GND\") (origin (xy 0 0)) (origin_offset_x 0) (origin_offset_y 0) (outline"), text);
  assert.ok(V.hasExclusions(st)); V.clearAllExclusions(st); assert.ok(!V.hasExclusions(st));
});

test("deleting a stitch via excludes its cell (EDIT_TOOL::DeleteItems on a generator member)", () => {
  const doc = stBoard([gen()]); const r = V.viaStitchUpdate(doc, stitchOf(doc), {}, null, true);
  const d2 = P.teardropAppliedDoc(doc, r.changes);
  const victim = r.changes.slice(1).find((c) => { const p = atOf(nodeOf(c)); return p[0] === 6 && p[1] === 4; }).id;
  assert.strictEqual(V.stitchOfVia(d2, victim).id, GEN);
  const del = P.deleteChanges(d2, [victim]);
  const g = del.find((c) => c.id === GEN); assert.ok(g, "the stitch is modified");
  const st = V.readStitch(nodeOf(g)); assert.deepStrictEqual(st.exCells, [[3, 2]]); assert.ok(!st.members.includes(victim));
  assert.ok(del.some((c) => c.id === victim && c.kind === "REMOVED"));
  // deleting the stitch takes its vias with it
  const all = P.deleteChanges(d2, [GEN]); assert.strictEqual(all.filter((c) => c.kind === "REMOVED").length, 10);
});

test("an update of an unchanged stitch keeps its vias (no churn)", () => {
  const doc = stBoard([gen()]); const r = V.viaStitchUpdate(doc, stitchOf(doc), {}, null, true);
  const d2 = P.teardropAppliedDoc(doc, r.changes); const st = stitchOf(d2);
  const r2 = V.viaStitchUpdate(d2, st, {}, V.gridConfigOf(st), false);
  assert.ok(!r2.changedVias); assert.strictEqual(r2.changes.filter((c) => c.kind !== "MODIFIED" || c.id !== GEN).length, 0);
});

test("DRC via_stitch_overlap: two stitches of one net whose outlines overlap", () => {
  const G2 = "aaaaaaaa-0000-0000-0000-000000000002", G3 = "aaaaaaaa-0000-0000-0000-000000000003";
  const doc = stBoard([gen(), gen({ uuid: G2, outline: sq(8, 8, 14, 14) }), gen({ uuid: G3, net: "VCC", outline: sq(4, 4, 12, 12) })]);
  const m = V.viaStitchOverlapMarkers(doc);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].code || m[0].type || m[0].kind, "via_stitch_overlap");
  assert.ok(JSON.stringify(m[0]).includes(GEN) && JSON.stringify(m[0]).includes(G2));
  const all = P.drc(doc); assert.ok((all.markers || all).some((x) => (x.code || x.type || x.kind) === "via_stitch_overlap"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
