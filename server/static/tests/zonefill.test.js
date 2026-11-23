// node server/static/tests/zonefill.test.js — the browser zone filler (server/web/domains/pcb/fab/zonefill.ts, a port of
// pcbnew's ZONE_FILLER) through the fab bundle's KiCadFab.fillZones / filledZoneNode.  `npm run build` must have
// produced static/kicad-canvas.js and static/dist/fab.js first.
"use strict";
const assert = require("assert");
const path = require("path");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab;

let passed = 0, failed = 0; const pending = [];
function test(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  ", name); }, (e) => { failed++; console.error("FAIL", name + ":", e && e.stack || e); })); }

const RULES = { netClearance: () => 0.2, minClearance: 0, holeClearance: 0.25, edgeClearance: 0.5 };
const area = (o) => { let a = 0; for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += o[j][0] * o[i][1] - o[i][0] * o[j][1]; return Math.abs(a / 2); };
const totalArea = (lf) => lf.outlines.reduce((s, o) => s + area(o), 0);
const inside = (o, x, y) => { let c = false; for (let i = 0, j = o.length - 1; i < o.length; j = i++) { const [xi, yi] = o[i], [xj, yj] = o[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const filledAt = (lf, x, y) => lf.outlines.some((o) => inside(o, x, y));
const bbox = (lf) => { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const o of lf.outlines) for (const [x, y] of o) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); } return b; };

const board = (...items) => `(kicad_pcb (version 20260206) (generator "pcbnew") (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (5 "F.SilkS" user "F.Silkscreen"))
 (setup (pad_to_mask_clearance 0))
 (net 0 "") (net 1 "GND") (net 2 "SIG")
 (gr_rect (start 100 100) (end 140 130) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
 ${items.join("\n ")})`;
const zone = (opts = {}) => `(zone (net "${opts.net || "GND"}") (layer "${opts.layer || "F.Cu"}") (uuid "${opts.uuid || "z1"}") (hatch edge 0.5) ${opts.priority ? `(priority ${opts.priority})` : ""}
  (connect_pads ${opts.connect || ""} (clearance ${opts.clearance ?? 0.5})) (min_thickness ${opts.minThickness ?? 0.25})
  (fill ${opts.fill || ""} (thermal_gap 0.5) (thermal_bridge_width 0.5) ${opts.smoothing || ""} (island_removal_mode ${opts.islands ?? 0}) ${opts.islandMin ? `(island_area_min ${opts.islandMin})` : ""} ${opts.hatch || ""})
  (polygon (pts ${(opts.pts || [[95, 95], [145, 95], [145, 135], [95, 135]]).map(([x, y]) => `(xy ${x} ${y})`).join(" ")})))`;
const smdFp = (ref, x, y, net, w = 2, h = 2) => `(footprint "T:SMD" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} ${y})
  (property "Reference" "${ref}" (at 0 -3) (layer "F.SilkS") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd rect (at 0 0) (size ${w} ${h}) (layers "F.Cu" "F.Mask") (net "${net}") (uuid "p-${ref}")))`;
const thtFp = (ref, x, y, net, extra = "") => `(footprint "T:THT" (layer "F.Cu") (uuid "fp-${ref}") (at ${x} ${y})
  (property "Reference" "${ref}" (at 0 -3) (layer "F.SilkS") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask") (net "${net}") ${extra} (uuid "p-${ref}")))`;
const seg = (x1, y1, x2, y2, net, w = 0.25, layer = "F.Cu") => `(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width ${w}) (layer "${layer}") (net "${net}") (uuid "s-${x1}-${y1}-${x2}-${y2}"))`;

async function fill(text, ids = null, rules = RULES) {
  const doc = K.parseDoc(text, "kicad_pcb");
  const res = await F.fillZones({ doc, setup: text }, rules, ids);
  return { doc, res, layer: (id, l) => res.find((r) => r.id === id).layers.find((x) => x.layer === l) };
}
const zid = (doc, uuid) => [...doc.items.values()].find((it) => it.kind === "zone" && K.str(K.kid(it.node, "uuid")[1]) === uuid).id;

test("a plain zone fills the board inside the edge clearance and the outline", async () => {
  const { doc, layer } = await fill(board(zone()));
  const lf = layer(zid(doc, "z1"), "F.Cu");
  assert.equal(lf.outlines.length, 1);
  const b = bbox(lf);
  // the zone outline overhangs the board: the fill is the board minus copper_edge_clearance (0.5) from the edge's centre line
  assert.ok(Math.abs(b[0] - 100.5) < 0.01 && Math.abs(b[1] - 100.5) < 0.01 && Math.abs(b[2] - 139.5) < 0.01 && Math.abs(b[3] - 129.5) < 0.01, b.join(","));
  assert.ok(Math.abs(totalArea(lf) - 39 * 29) < 0.5, "area " + totalArea(lf));
});

test("another net's pad is knocked out with the larger of the zone and netclass clearances", async () => {
  const { doc, layer } = await fill(board(zone(), smdFp("R1", 120, 115, "SIG")));
  const lf = layer(zid(doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lf, 120, 115), "no copper on the pad");
  assert.ok(!filledAt(lf, 121.4, 115), "no copper within the 0.5 mm zone clearance of the pad edge");
  assert.ok(filledAt(lf, 121.6, 115), "copper past the clearance");
  // area: the board minus a 2 x 2 pad grown by 0.5 (round corners)
  const hole = 3 * 3 - (1 - Math.PI / 4) * 0.25 * 4;
  assert.ok(Math.abs(totalArea(lf) - (39 * 29 - hole)) < 0.3, "area " + totalArea(lf));
});

test("a track of another net is cleared; the same net's track is poured over", async () => {
  const other = await fill(board(zone(), seg(105, 110, 135, 110, "SIG", 0.3)));
  const lf = other.layer(zid(other.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lf, 120, 110.6), "0.15 + 0.5 around the track"); assert.ok(filledAt(lf, 120, 110.7));
  const same = await fill(board(zone(), seg(105, 110, 135, 110, "GND", 0.3), smdFp("R1", 105, 110, "GND")));
  const ls = same.layer(zid(same.doc, "z1"), "F.Cu");
  assert.ok(filledAt(ls, 120, 110), "the zone covers its own net's track");
});

test("a same-net through-hole pad gets a thermal relief: a gap and four spokes", async () => {
  const { doc, layer } = await fill(board(zone(), thtFp("J1", 120, 115, "GND")));
  const lf = layer(zid(doc, "z1"), "F.Cu");
  // the gap ring (pad radius 1, thermal gap 0.5) is empty on the diagonals; circular pads get 45 degree spokes
  const r = 1.25;
  assert.ok(filledAt(lf, 120 + r * Math.SQRT1_2, 115 + r * Math.SQRT1_2), "a spoke on the diagonal");
  assert.ok(!filledAt(lf, 120 + r, 115), "the gap beside the spokes");
  assert.ok(!filledAt(lf, 120, 115), "the hole is never filled");
  assert.ok(filledAt(lf, 120 + 3, 115), "copper beyond the relief");
  // (connect_pads yes): the pad is poured over solid
  const solid = await fill(board(zone({ connect: "yes" }), thtFp("J1", 120, 115, "GND")));
  const ls = solid.layer(zid(solid.doc, "z1"), "F.Cu");
  assert.ok(filledAt(ls, 120 + r, 115), "a solid connection fills right up to the pad");
  // a pad's own (zone_connect 0) overrides the zone: no connection, the pad is cleared
  const none = await fill(board(zone(), thtFp("J1", 120, 115, "GND", "(zone_connect 0)")));
  const ln = none.layer(zid(none.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(ln, 120 + r * Math.SQRT1_2, 115 + r * Math.SQRT1_2), "no spokes"); assert.ok(!filledAt(ln, 121.4, 115));
});

test("islands: removed always (0), kept and flagged never (1), removed below the area (2)", async () => {
  // a box of SIG tracks walls off the corner 100..110 x 100..110: copper inside it holds no GND pad
  const walls = [seg(110, 99, 110, 111, "SIG", 0.4), seg(99, 110, 111, 110, "SIG", 0.4)];
  const items = (opts) => [zone(opts), smdFp("R1", 130, 120, "GND"), ...walls];
  const always = await fill(board(...items({ islands: 0 })));
  const la = always.layer(zid(always.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(la, 105, 105), "the island is gone"); assert.ok(filledAt(la, 120, 120)); assert.equal(la.islands.size, 0);
  const never = await fill(board(...items({ islands: 1 })));
  const ln = never.layer(zid(never.doc, "z1"), "F.Cu");
  assert.ok(filledAt(ln, 105, 105), "kept"); assert.equal(ln.islands.size, 1, "and flagged as an island");
  const small = await fill(board(...items({ islands: 2, islandMin: 200 })));
  assert.ok(!filledAt(small.layer(zid(small.doc, "z1"), "F.Cu"), 105, 105), "an 89 mm² island is under 200 mm²");
  const big = await fill(board(...items({ islands: 2, islandMin: 10 })));
  assert.ok(filledAt(big.layer(zid(big.doc, "z1"), "F.Cu"), 105, 105), "and over 10 mm²");
  // a zone with no pad anywhere is a deliberately unconnected pour: every island is kept
  const lone = await fill(board(zone({ islands: 0 }), ...walls));
  assert.ok(filledAt(lone.layer(zid(lone.doc, "z1"), "F.Cu"), 105, 105));
});

test("islands: a fragment linked to a pad only through a via and a track on another layer is kept (whole-board clusters)", async () => {
  // the corner 100..110 x 100..110 on F.Cu is walled off by SIG tracks; a GND via in it reaches a GND pad over B.Cu
  const walls = [seg(110, 99, 110, 111, "SIG", 0.4), seg(99, 110, 111, 110, "SIG", 0.4)];
  const via = `(via (at 105 105) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "v1"))`;
  const bottom = seg(105, 105, 130, 120, "GND", 0.25, "B.Cu");
  const pad = `(footprint "T:SMD" (layer "B.Cu") (uuid "fp-R9") (at 130 120)
  (property "Reference" "R9" (at 0 -3) (layer "B.SilkS") (uuid "r-R9") (effects (font (size 1 1) (thickness 0.15))))
  (pad "1" smd rect (at 0 0) (size 2 2) (layers "B.Cu" "B.Mask") (net "GND") (uuid "p-R9")))`;
  const items = [zone({ islands: 0 }), smdFp("R1", 130, 105, "GND"), ...walls, via, bottom, pad];
  const linked = await fill(board(...items));
  const lf = linked.layer(zid(linked.doc, "z1"), "F.Cu");
  assert.ok(filledAt(lf, 102, 102), "the walled-off fragment reaches R9 through the via and the B.Cu track");
  assert.equal(lf.islands.size, 0);
  // without the B.Cu track the via leads nowhere: the fragment is an island again
  const cut = await fill(board(...items.filter((x) => x !== bottom)));
  assert.ok(!filledAt(cut.layer(zid(cut.doc, "z1"), "F.Cu"), 102, 102), "removed");
});

test("a higher-priority zone of another net is filled first and cleared around; a keepout keeps copper out", async () => {
  const hi = zone({ net: "SIG", uuid: "z2", priority: 1, pts: [[110, 105], [125, 105], [125, 120], [110, 120]] });
  const { doc, layer } = await fill(board(zone(), hi, smdFp("R1", 130, 125, "GND"), smdFp("R2", 117, 112, "SIG")));
  const lo = layer(zid(doc, "z1"), "F.Cu"), up = layer(zid(doc, "z2"), "F.Cu");
  assert.ok(filledAt(up, 117, 107), "the high zone fills its outline");
  assert.ok(!filledAt(lo, 117, 107), "the low zone stays out of it"); assert.ok(!filledAt(lo, 109.6, 112), "by the clearance"); assert.ok(filledAt(lo, 109.3, 112));
  const ko = `(zone (layer "F.Cu") (uuid "k1") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25) (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed)) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 102 102) (xy 108 102) (xy 108 108) (xy 102 108))))`;
  const k = await fill(board(zone(), ko, smdFp("R1", 130, 125, "GND")));
  const lk = k.layer(zid(k.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lk, 105, 105), "no pour in the rule area"); assert.ok(filledAt(lk, 109, 109));
  assert.ok(!k.res.some((r) => r.id === zid(k.doc, "k1")), "a rule area is never filled");
});

test("hatch fill leaves a grid of holes; chamfered corners cut the outline", async () => {
  const hatch = await fill(board(zone({ fill: "yes (mode hatch)", hatch: "(hatch_thickness 1) (hatch_gap 1.5) (hatch_orientation 0) (hatch_border_algorithm hatch_thickness) (hatch_min_hole_area 0.3)" }), smdFp("R1", 130, 125, "GND")));
  const lh = hatch.layer(zid(hatch.doc, "z1"), "F.Cu");
  const solid = 39 * 29; const a = totalArea(lh);
  assert.ok(a < solid * 0.75 && a > solid * 0.3, "a hatch is mostly holes: " + a);
  const inner = [[100, 100], [140, 100], [140, 130], [100, 130]];
  const ch = await fill(board(zone({ pts: inner, smoothing: "(smoothing chamfer) (radius 3)" })));
  const lc = ch.layer(zid(ch.doc, "z1"), "F.Cu");
  assert.ok(!filledAt(lc, 101.2, 101.2), "the corner is chamfered off"); assert.ok(filledAt(lc, 104, 101.2));
});

test("filledZoneNode writes (fill yes …) and the filled polygons after the outline, layer by layer, islands flagged", async () => {
  const walls = [seg(110, 99, 110, 111, "SIG", 0.4), seg(99, 110, 111, 110, "SIG", 0.4)];
  const text = board(zone({ islands: 1, layer: "F.Cu" }).replace('(layer "F.Cu")', '(layers "F.Cu" "B.Cu")'), smdFp("R1", 130, 120, "GND"), ...walls);
  const { doc, res } = await fill(text);
  const it = doc.items.get(zid(doc, "z1")); const r = res[0];
  const node = F.filledZoneNode(it.node, r, doc.copper, K.cloneNode);
  const ser = K.serialize(node);
  assert.ok(/\(fill yes \(thermal_gap/.test(ser), ser.slice(0, 400));
  const kinds = node.slice(1).filter(Array.isArray).map((c) => c[0]);
  assert.ok(kinds.lastIndexOf("polygon") < kinds.indexOf("filled_polygon"), "after the outline");
  const layers = node.filter((c) => Array.isArray(c) && c[0] === "filled_polygon").map((c) => K.str(K.kid(c, "layer")[1]));
  assert.deepEqual([...new Set(layers)], ["F.Cu", "B.Cu"], "front first");
  assert.ok(/\(filled_polygon \(layer "F.Cu"\) \(island yes\) \(pts/.test(ser), "an island carries (island yes)");
  assert.ok(!/filled_areas_thickness/.test(ser));
});

// ---------------------------------------------------------------- automatic refill: BOARD_COMMIT::propagateDamage
{
  const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
  const b = esbuild.buildSync({ entryPoints: [webPath("domains", "pcb", "editor", "pcbdialogs", "zone-damage.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
  const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require);
  const D = m.exports, cu = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"];
  const zoneOn = (id, layer, extra = []) => ({ id, node: ["zone", ["layer", layer], ["fill", "yes"], ...extra], bbox: [0, 0, 50, 50] });
  const box = [10, 10, 20, 20];
  test("propagateDamage: a change dirties only zones on its copper layers", () => {
    const zones = [zoneOn("zb", "B.Cu"), zoneOn("zf", "F.Cu"), zoneOn("zi", "In1.Cu")];
    const seg = D.itemLayers(["segment", ["start", 1, 1], ["layer", "F.Cu"]], cu);
    assert.deepEqual(D.staleZones(zones, [{ box, layers: seg }], new Set(["s"]), cu), ["zf"], "an F.Cu track leaves the B.Cu zone alone");
    const silk = D.itemLayers(["gr_line", ["layer", "F.SilkS"]], cu);
    assert.deepEqual(D.staleZones(zones, [{ box, layers: silk }], new Set(["g"]), cu), [], "silkscreen dirties nothing");
    const edge = D.itemLayers(["gr_line", ["layer", "Edge.Cuts"]], cu);
    assert.deepEqual(D.staleZones(zones, [{ box, layers: edge }], new Set(["e"]), cu), ["zb", "zf", "zi"], "Edge.Cuts dirties every layer");
    const via = D.itemLayers(["via", ["at", 1, 1], ["layers", "F.Cu", "In1.Cu"]], cu);
    assert.deepEqual([...via].sort(), ["F.Cu", "In1.Cu"]);
    assert.deepEqual([...D.itemLayers(["via", ["layers", "F.Cu", "B.Cu"]], cu)], cu, "a through via spans every layer");
    const fp = D.itemLayers(["footprint", ["layer", "F.Cu"], ["fp_line", ["layer", "F.SilkS"]], ["pad", "1", "thru_hole", ["layers", "*.Cu", "*.Mask"]]], cu);
    assert.ok(cu.every((l) => fp.has(l)), "footprint children: a through pad on every copper layer");
    assert.deepEqual(D.staleZones(zones, [{ box: [60, 60, 70, 70], layers: seg }], new Set(["s"]), cu), [], "outside the zone's box");
  });
  test("propagateDamage: rule areas are never refilled; unfilled and changed zones always are", () => {
    const zones = [zoneOn("ka", "F.Cu", [["keepout", ["tracks", "not_allowed"]]]), { id: "zu", node: ["zone", ["layer", "B.Cu"]], bbox: [0, 0, 1, 1] }, zoneOn("zc", "In2.Cu")];
    zones[0].bbox = [0, 0, 50, 50];
    const seg = D.itemLayers(["segment", ["layer", "F.Cu"]], cu);
    assert.deepEqual(D.staleZones(zones, [{ box, layers: seg }], new Set(["zc"]), cu), ["zu", "zc"]);
    const multi = { id: "zm", node: ["zone", ["layers", "F.Cu", "B.Cu"], ["fill", "yes"], ["filled_polygon", ["layer", "In1.Cu"]]], bbox: [0, 0, 50, 50] };
    assert.deepEqual(D.staleZones([multi], [{ box, layers: D.itemLayers(["segment", ["layer", "In1.Cu"]], cu) }], new Set(), cu), [], "the zone's layers, not its fill's");
    assert.deepEqual(D.staleZones([multi], [{ box, layers: seg }], new Set(), cu), ["zm"]);
  });
}

// ---- copper thieving (ZONE_FILLER::addCopperThievingPattern)
const thief = (t, extra = {}) => zone(Object.assign({ net: "", uuid: "zt", connect: "no", fill: "(mode thieving)", hatch: t, pts: [[110, 110], [120, 110], [120, 120], [110, 120]] }, extra));
test("thieving dots: stamps of the element size on the size + gap grid, disconnected and kept", async () => {
  const { doc, layer } = await fill(board(thief("(thieving (type dots) (size 0.5) (gap 1) (width 0.3) (stagger no) (orientation 0))")));
  const lf = layer(zid(doc, "zt"), "F.Cu");
  // the zone is 10 mm wide less the 0.5 mm clearance on nothing: centres on the 1.5 mm grid inside 110 + 0.125 + 1 nm
  assert.ok(lf.outlines.length > 25, "many separate dots: " + lf.outlines.length);
  const d = bbox({ outlines: [lf.outlines[0]] }); assert.ok(Math.abs((d[2] - d[0]) - 0.5) < 0.015, "a dot is 0.5 mm across: " + (d[2] - d[0]));
  assert.equal(lf.islands.size, 0, "thieving stamps are never islands");
  const xs = [...new Set(lf.outlines.map((o) => Math.round(bbox({ outlines: [o] })[0] * 1000 + 250) / 1000))].sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 1.5) < 1e-3, "1.5 mm stride");
  assert.ok(xs.every((x) => Math.abs(x / 1.5 - Math.round(x / 1.5)) < 1e-6), "the grid is anchored at the origin: " + xs.join(","));
});
test("thieving squares and stagger: rows alternate by half a stride", async () => {
  const { doc, layer } = await fill(board(thief("(thieving (type squares) (size 0.6) (gap 0.9) (width 0.3) (stagger yes) (orientation 0))")));
  const lf = layer(zid(doc, "zt"), "F.Cu");
  const rows = new Map(); for (const o of lf.outlines) { const b = bbox({ outlines: [o] }); const y = Math.round((b[1] + b[3]) / 2 * 1000) / 1000; (rows.get(y) || rows.set(y, []).get(y)).push(Math.round((b[0] + b[2]) / 2 * 1000) / 1000); }
  const ys = [...rows.keys()].sort((a, b) => a - b); assert.ok(ys.length >= 4);
  const x0 = Math.min(...rows.get(ys[0])), x1 = Math.min(...rows.get(ys[1]));
  assert.ok(Math.abs(Math.abs(x1 - x0) - 0.75) < 1e-3, "staggered by half the 1.5 mm stride: " + x0 + " " + x1);
  const b = bbox({ outlines: [lf.outlines[0]] }); assert.ok(Math.abs((b[2] - b[0]) - 0.6) < 0.02, "square side 0.6 (reinflated by the min width): " + (b[2] - b[0]));
});
test("thieving hatch: one mesh with its border, square voids; zero gap gives no fill", async () => {
  const { doc, layer } = await fill(board(thief("(thieving (type hatch) (size 0.5) (gap 1) (width 0.3) (stagger no) (orientation 0))")));
  const lf = layer(zid(doc, "zt"), "F.Cu");
  assert.equal(lf.outlines.length, 1, "a single mesh");
  const full = 100; assert.ok(totalArea(lf) < full * 0.6 && totalArea(lf) > full * 0.2, "voids carved: " + totalArea(lf));
  assert.ok(filledAt(lf, 110.05, 115), "the border survives");
  const z = await fill(board(thief("(thieving (type dots) (size 0.5) (gap 0) (width 0.3) (stagger no) (orientation 0))")));
  assert.equal(z.layer(zid(z.doc, "zt"), "F.Cu").outlines.length, 0, "a zero gap gives no fill");
});
test("thieving dots keep clear of a pad by the clearance", async () => {
  const { doc, layer } = await fill(board(thief("(thieving (type dots) (size 0.5) (gap 1) (width 0.3) (stagger no) (orientation 0))"), smdFp("R1", 115, 115, "SIG")));
  const lf = layer(zid(doc, "zt"), "F.Cu");
  for (const o of lf.outlines) { const b = bbox({ outlines: [o] }); const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; const dx = Math.max(Math.abs(cx - 115) - 1, 0), dy = Math.max(Math.abs(cy - 115) - 1, 0); assert.ok(Math.hypot(dx, dy) >= 0.5 + 0.25 - 0.01, "dot clear of the pad: " + cx + "," + cy); }
});

test("iterative refill: a lower zone reclaims the space a higher zone's removed island leaves (Fill() 1320-1660)", async () => {
  // SIG (priority 1) is cut in two by a GND track; its right half has no SIG pad and goes, and GND below takes it back
  const hi = zone({ net: "SIG", uuid: "zhi", priority: 1, pts: [[110, 105], [130, 105], [130, 125], [110, 125]] });
  const lo = zone({ net: "GND", uuid: "zlo" });
  const phases = [];
  const doc = K.parseDoc(board(hi, lo, smdFp("R1", 113, 115, "SIG"), smdFp("R2", 104, 115, "GND"), seg(120, 101, 120, 129, "GND", 0.5)), "kicad_pcb");
  const res = await F.fillZones({ doc, setup: "" }, RULES, null, { phase: (n, t) => phases.push([n, t]), advance() {}, cancelled: () => false, yield: () => Promise.resolve() });
  const L = (uuid) => res.find((r) => r.id === zid(doc, uuid)).layers.find((x) => x.layer === "F.Cu");
  assert.ok(filledAt(L("zhi"), 114, 110) && !filledAt(L("zhi"), 126, 115), "the SIG island is gone");
  assert.ok(filledAt(L("zlo"), 126, 115), "GND refilled where the island was");
  assert.ok(!filledAt(L("zlo"), 114, 110), "GND still clears the connected SIG copper");
  assert.ok(phases.some(([, t]) => t === "Refilling overlapping zones..."), JSON.stringify(phases));
});

test("iterative refill: nothing to refill when no island is removed and no same-net zones overlap", async () => {
  const phases = [];
  const doc = K.parseDoc(board(zone({ net: "GND" }), smdFp("R2", 104, 115, "GND")), "kicad_pcb");
  await F.fillZones({ doc, setup: "" }, RULES, null, { phase: (n, t) => phases.push([n, t]), advance() {}, cancelled: () => false, yield: () => Promise.resolve() });
  assert.ok(!phases.some(([, t]) => t === "Refilling overlapping zones..."));
});

// custom rules (.kicad_dru): FillRules.custom is EvalRules' answer per zone, item and layer (PcbTools.zoneFillRules)
const fpid = (doc, ref) => [...doc.items.values()].find((it) => it.kind === "footprint" && K.str(K.kid(it.node, "uuid")[1]) === "fp-" + ref).id;
async function fillWithRules(text, custom) {
  const doc = K.parseDoc(text, "kicad_pcb");
  const table = typeof custom === "function" ? custom(doc) : custom;
  const res = await F.fillZones({ doc, setup: text }, Object.assign({}, RULES, { custom: table, customMax: 2 }), null);
  return { doc, layer: (uuid, l) => res.find((r) => r.id === zid(doc, uuid)).layers.find((x) => x.layer === l) };
}
test("a custom clearance rule replaces the netclass and zone clearances to a pad (EvalRules: the rule wins outright)", async () => {
  const text = board(zone(), smdFp("R1", 120, 115, "SIG"));
  const plain = await fill(text); const lp = plain.layer(zid(plain.doc, "z1"), "F.Cu");
  assert.ok(filledAt(lp, 121.7, 115), "0.5 mm by default");
  const r = await fillWithRules(text, (doc) => ({ [`clearance|${zid(doc, "z1")}|${fpid(doc, "R1")}#0|*`]: 1.5 }));
  const lf = r.layer("z1", "F.Cu");
  assert.ok(!filledAt(lf, 122.2, 115) && filledAt(lf, 122.8, 115), "1.5 mm from the rule");
  // a smaller rule clearance than the zone's own wins as well
  const r2 = await fillWithRules(text, (doc) => ({ [`clearance|${zid(doc, "z1")}|${fpid(doc, "R1")}#0|F.Cu`]: 0.2 }));
  assert.ok(filledAt(r2.layer("z1", "F.Cu"), 121.35, 115), "0.2 mm from the rule");
});
test("a pad's local clearance override beats a custom rule", async () => {
  const fp = smdFp("R1", 120, 115, "SIG").replace('(net "SIG")', '(net "SIG") (clearance 0.3)');
  const r = await fillWithRules(board(zone(), fp), (doc) => ({ [`clearance|${zid(doc, "z1")}|${fpid(doc, "R1")}#0|*`]: 1.5 }));
  assert.ok(filledAt(r.layer("z1", "F.Cu"), 121.5, 115), "the 0.3 mm override");
});
test("physical_clearance raises the gap: max( PHYSICAL_CLEARANCE, CLEARANCE )", async () => {
  const r = await fillWithRules(board(zone(), smdFp("R1", 120, 115, "SIG")), (doc) => ({ [`physical_clearance|${zid(doc, "z1")}|${fpid(doc, "R1")}#0|*`]: 1.2 }));
  const lf = r.layer("z1", "F.Cu");
  assert.ok(!filledAt(lf, 122.0, 115) && filledAt(lf, 122.5, 115));
});
test("thermal relief gap and zone connection from custom rules (a pad inherits its footprint's)", async () => {
  const text = board(zone(), thtFp("J1", 120, 115, "GND"));
  const d = 1.8;   // between the spokes (at 45 degrees on a round pad), 1.8 mm from the centre: inside a 1.0 gap, outside the zone's 0.5
  const plain = await fill(text); assert.ok(filledAt(plain.layer(zid(plain.doc, "z1"), "F.Cu"), 120 + d, 115));
  const g = await fillWithRules(text, (doc) => ({ [`thermal_relief_gap|${zid(doc, "z1")}|${fpid(doc, "J1")}|*`]: 1.0 }));
  assert.ok(!filledAt(g.layer("z1", "F.Cu"), 120 + d, 115), "1.0 mm thermal gap");
  const near = 1.2;
  assert.ok(!filledAt(plain.layer(zid(plain.doc, "z1"), "F.Cu"), 120 + near, 115), "a thermal ring by default");
  const c = await fillWithRules(text, (doc) => ({ [`zone_connection|${zid(doc, "z1")}|${fpid(doc, "J1")}#0|*`]: "FULL" }));
  assert.ok(filledAt(c.layer("z1", "F.Cu"), 120 + near, 115), "solid from the rule");
});
test("a custom edge_clearance replaces copper_edge_clearance", async () => {
  const r = await fillWithRules(board(zone()), (doc) => ({ [`edge_clearance|${zid(doc, "z1")}|edge|*`]: 1.5 }));
  const b = bbox(r.layer("z1", "F.Cu"));
  assert.ok(Math.abs(b[0] - 101.5) < 0.02 && Math.abs(b[3] - 128.5) < 0.02, b.join(","));
});

Promise.all(pending).then(() => { console.log(`zonefill: ${passed} passed, ${failed} failed`); if (failed) process.exit(1); });
