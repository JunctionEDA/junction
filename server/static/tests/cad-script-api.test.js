// Node test: the Junction Feature API (web/domains/mechanical/script): the 2D geometry on its own (geom2d.ts),
// and every group of the API called from a script on real geometry, with the numbers the kernel gives back:
// query (bodies, faces, edges, holes, outlines), build (extrude, cut, add, holes, booleans, fillet, chamfer,
// shell, copies, patterns, moves), measure, results (reports, warnings, labels, drag handles), and the type
// file the editor and the assistant read.
// Run: node server/static/tests/cad-script-api.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("./cad-script-kit");
const { load, server } = require("./cad-load");

const K = T.kit(), G = K.Geo2;
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const feature = (body, params = "{}") => `feature({ title: "T", params: ${params}, evaluate(ctx, p) {\n${body}\n} });`;
/** run a script whose console lines are JSON values; returns them and the report */
async function ask(plate, body, values) {
  const r = await T.run(plate, feature(body), values);
  assert.notEqual(r.status, "error", r.error && r.error.message);
  return { r, out: r.console.map((c) => { try { return JSON.parse(c); } catch (e) { return c; } }) };
}

// ---------------------------------------------------------------- 2D

test("offsets, booleans and measures", () => {
  const sq = G.rect(0, 0, 10, 10);
  near(G.area(sq), 100);
  near(G.area(G.offset(sq, 1, "miter")), 144);
  near(G.area(G.offset(sq, 1)), 100 + 40 + Math.PI, 1e-3);
  near(G.area(G.offset(sq, -2)), 36);
  assert.deepEqual(G.offset(sq, -6), []);
  near(G.area(G.circle([0, 0], 5)), Math.PI * 25, 1e-3);
  near(G.area(G.difference(sq, G.circle([5, 5], 2))), 100 - Math.PI * 4, 1e-3);
  near(G.area(G.intersection(sq, G.rect(5, 5, 10, 10))), 25);
  near(G.area(G.union(sq, G.rect(5, 5, 10, 10))), 175);
  const holed = G.difference(sq, G.rect(4, 4, 2, 2));
  assert.equal(holed.length, 1); assert.equal(holed[0].holes.length, 1);
  assert.equal(G.contains(holed, [1, 1]), true); assert.equal(G.contains(holed, [5, 5]), false); assert.equal(G.contains(holed, [20, 5]), false);
  near(G.distance(sq, [5, 5]), 5); near(G.distance(sq, [13, 5]), 3);
  near(G.clearance(sq, G.rect(13, 0, 5, 5)), 3); assert.equal(G.clearance(sq, G.rect(9, 9, 5, 5)), 0);
  assert.deepEqual(G.bounds(G.translate(sq, [5, -5])).min, [5, -5]);
  near(G.area(G.rotate(sq, 30, [3, 3])), 100); near(G.area(G.scale(sq, 2)), 400); near(G.area(G.mirror(holed, [0, 0], [1, 1])), 96);
  assert.deepEqual(G.centroid(sq), [5, 5]);
  near(G.area(G.slot([0, 0], [10, 0], 4)), 40 + Math.PI * 4, 1e-3);
  near(G.area(G.thicken([[[0, 0], [10, 0]], [[0, 0], [0, 10]]], 2)), 39 + 1.25 * Math.PI, 1e-3);
  assert.throws(() => G.offset("x", 1), /Expected a loop/);
  assert.throws(() => G.circle([0, 0], 0), /radius above zero/);
});

test("rounding corners, and arcs read back from polygons", () => {
  const sq = G.rect(0, 0, 20, 10);
  const r = G.round(sq, 2);
  near(G.area(r), 200 - (4 - Math.PI) * 4, 1e-3);
  const arcs = G.withArcs(r)[0].outer;
  assert.equal(arcs.length, 8, "four straight edges and four arcs");
  assert.equal(arcs.filter((v) => v[2]).length, 4);
  for (const v of arcs.filter((x) => x[2])) near(Math.abs(v[2]), Math.tan(Math.PI / 8), 1e-3);
  // what is too narrow for the cutter goes
  assert.deepEqual(G.round(G.rect(0, 0, 20, 3), 2), []);
  // a circle that has been through a boolean is a circle again: two half arcs
  const c = G.withArcs(G.intersection(G.circle([5, 5], 3), G.rect(0, 0, 10, 10)))[0].outer;
  assert.equal(c.length, 2); near(Math.abs(c[0][2]), 1);
  // a circle cut by a line keeps one arc and one straight edge
  const half = G.withArcs(G.intersection(G.circle([5, 5], 3), G.rect(0, 5, 10, 10)))[0].outer;
  assert.equal(half.length, 2); assert.equal(half.filter((v) => v[2]).length, 1);
  // nearly straight runs stay straight edges, with their in-between corners dropped
  const flat = G.fitArcs([[0, 0], [5, 0.001], [10, 0], [10, 10], [0, 10]]);
  assert.equal(flat.length, 4); assert.ok(flat.every((v) => !v[2]));
  // reflex corners too
  const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
  near(G.area(G.round(L, 0, 2)), 300 + (4 - Math.PI), 1e-3);
});

test("Delaunay, Voronoi, triangles and the patterns", () => {
  const pts = [[0, 0], [10, 0], [10, 10], [0, 10], [5, 5]];
  const d = G.delaunay(pts);
  assert.equal(d.triangles.length, 4); assert.equal(d.edges.length, 8);
  assert.ok(d.triangles.every((t) => t.includes(4)));
  assert.deepEqual(G.delaunay([[0, 0], [1, 1], [0, 0]]).edges, [[0, 1]]);
  assert.deepEqual(G.delaunay(pts), G.delaunay(pts.slice()), "the same every time");
  const cells = G.voronoi(pts, G.rect(0, 0, 10, 10));
  assert.equal(cells.length, 5); near(cells.reduce((n, c) => n + G.area(c), 0), 100); near(G.area(cells[4]), 50);
  near(G.triangulate(G.difference(G.rect(0, 0, 10, 10), G.rect(4, 4, 2, 2))).reduce((n, t) => n + G.area(t), 0), 96);
  const box = G.rect(0, 0, 100, 60);
  for (const kind of ["tri", "hex", "square", "diamond"]) {
    const all = G.cells(kind, box, { pitch: 10 }), inset = G.cells(kind, box, { pitch: 10, inset: 1 });
    assert.ok(all.length > 40, kind);
    near(G.area(G.intersection(all, box)), 6000, 1e-3);
    assert.ok(G.area(inset) < G.area(all) * 0.9, kind);
    assert.equal(G.union(inset).length, inset.length, `${kind}: inset cells do not touch`);
  }
  near(G.area(G.cells("hex", box, { pitch: 10 })[0]), 100 * Math.sqrt(3) / 2, 1e-4);
  near(G.area(G.cells("tri", box, { pitch: 10 })[0]), 25 * Math.sqrt(3), 1e-4);
  assert.throws(() => G.cells("star", box, { pitch: 10 }), /one of "tri", "hex"/);
  const grid = G.grid(box, { dx: 10, margin: 5 });
  assert.equal(grid.length, 9 * 5); assert.ok(grid.every((p) => p[0] >= 5 && p[0] <= 95 && p[1] >= 5 && p[1] <= 55));
  assert.ok(G.grid(box, { dx: 10, stagger: true }).length > 50);
  assert.equal(G.outlinePoints(box).length, 4);
  assert.equal(G.outlinePoints(box, { spacing: 20 }).length, 4 + 4 + 2 + 4 + 2);
  // a rounded rectangle has a corner or two per corner, not a hundred
  const rounded = G.outlinePoints(G.round(box, 8)).length;
  assert.ok(rounded >= 4 && rounded <= 12, String(rounded));
});

// ---------------------------------------------------------------- the API from a script, on the kernel

test("query: bodies, faces by kind, normal and area, edges, the outline of a face with its arcs, holes", async () => {
  const { out } = await ask(T.PLATE_B(), `
    const b = ctx.body();
    console.log(JSON.stringify({ n: ctx.bodies().length, volume: b.volume, area: b.area, size: b.bounds.size, centre: b.centre, mass: b.mass(2.7) }));
    const top = b.face({ kind: "plane", normal: [0, 0, 1] }), bottom = b.face({ normal: [0, 0, -1] });
    console.log(JSON.stringify({ kinds: [...new Set(b.faces().map((f) => f.kind))].sort(), flat: b.faces({ kind: "plane" }).length, cyl: b.faces({ kind: "cylinder" }).length, parallel: b.faces({ parallelTo: [0, 0, 1] }).length, big: b.faces({ minArea: 5000 }).length, small: b.faces({ maxArea: 400 }).length }));
    console.log(JSON.stringify({ topArea: top.area, same: top.area === bottom.area, normal: top.normal, plane: top.plane.normal, z: top.centre[2], bottomZ: bottom.centre[2], largestFirst: b.faces()[0].area >= b.faces()[1].area }));
    const o = top.outline();
    console.log(JSON.stringify({ outer: o.outer.length, arcs: o.outer.filter((v) => v[2]).length, holes: o.holes.length, area: Geo2.area(o), ccw: Geo2.area(o.outer) > 0 }));
    console.log(JSON.stringify(top.holes().map((h) => [h.centre.map(Math.round), h.diameter, h.centre3[2]])));
    console.log(JSON.stringify(b.holes().map((h) => [h.diameter, h.depth, h.axis.map(Math.abs), h.faces.length])));
    console.log(JSON.stringify({ min: b.holes({ minDiameter: 9 }).length, max: b.holes({ maxDiameter: 9 }).length }));
    const wall = b.holes({ minDiameter: 25 })[0].faces[0];
    console.log(JSON.stringify({ kind: wall.kind, radius: wall.radius, axis: wall.axis.direction.map(Math.abs), normal: wall.normal, neighbours: wall.neighbours().length, edges: wall.edges().length }));
    const lines = b.edges({ kind: "line" }), up = b.edges({ kind: "line", parallelTo: [0, 0, 1] }), circles = b.edges({ kind: "circle" });
    console.log(JSON.stringify({ all: b.edges().length, lines: lines.length, up: up.length, upLen: up[0].length, dir: up[0].direction.map(Math.abs), circles: circles.length, faces: up[0].faces().length, long: b.edges({ minLength: 150 }).length }));
    console.log(JSON.stringify({ local: top.toLocal([10, 20, 8]), world: top.toWorld([10, 20]), lifted: top.toWorld([10, 20], 3), top: ctx.plane("top").normal, front: ctx.plane("front").normal, at: ctx.planeAt([1, 2, 3], [0, 0, 2]).normal }));
  `);
  const outlineArea = 160 * 80 - 60 * 30 + Math.PI * 40 * 40 / 2, holesArea = Math.PI * (3 * 2.75 ** 2 + 15 ** 2 + 5 ** 2);
  near(out[0].volume, (outlineArea - holesArea) * 8, 1e-4); assert.equal(out[0].n, 1); near(out[0].size[0], 200); near(out[0].size[2], 8); near(out[0].mass, out[0].volume * 2.7 / 1000, 1e-6);
  assert.deepEqual(out[1].kinds, ["cylinder", "plane"]); assert.equal(out[1].flat, 7); assert.equal(out[1].cyl, 6); assert.equal(out[1].parallel, 2); assert.equal(out[1].big, 2);
  near(out[2].topArea, outlineArea - holesArea, 1e-4); assert.ok(out[2].same); assert.deepEqual(out[2].normal, [0, 0, 1]); assert.equal(out[2].z, 8); assert.equal(out[2].bottomZ, 0); assert.ok(out[2].largestFirst);
  assert.equal(out[3].outer, 6); assert.equal(out[3].arcs, 1); assert.equal(out[3].holes, 5); near(out[3].area, outlineArea - holesArea, 1e-3); assert.ok(out[3].ccw);
  assert.deepEqual(out[4], [[[12, 12], 5.5, 8], [[12, 38], 5.5, 8], [[72, 68], 5.5, 8], [[110, 20], 10, 8], [[160, 40], 30, 8]]);
  assert.deepEqual(out[4].map((h) => h[1]).sort((a, b) => a - b), [5.5, 5.5, 5.5, 10, 30]);
  assert.equal(out[5].length, 5); assert.ok(out[5].every((h) => h[1] === 8 && h[2][2] === 1));
  assert.deepEqual(out[6], { min: 2, max: 3 });
  assert.equal(out[7].kind, "cylinder"); assert.equal(out[7].radius, 15); assert.equal(out[7].normal, null); assert.equal(out[7].neighbours, 2);
  assert.equal(out[8].up, 6 + 5, "the outline's six corners and the five holes' seams"); assert.equal(out[8].upLen, 8); assert.deepEqual(out[8].dir, [0, 0, 1]); assert.equal(out[8].faces, 2); assert.equal(out[8].circles, 10 + 2);
  assert.deepEqual(out[9].world, [10, 20, 8]); assert.deepEqual(out[9].lifted, [10, 20, 11]); assert.deepEqual(out[9].local, [10, 20]); assert.deepEqual(out[9].top, [0, 0, 1]); assert.deepEqual(out[9].front, [0, -1, 0]); assert.deepEqual(out[9].at, [0, 0, 1]);
});

test("build: cut to a depth and through, add, holes, with the volumes the shapes say", async () => {
  const V = 48000;
  let x = await ask(T.PLATE_C(), `const f = ctx.body().face({ normal: [0, 0, 1] }); f.cut(Geo2.rect(10, 10, 20, 10), { depth: 2 }); console.log(ctx.body().volume);`);
  near(x.out[0], V - 400); near(x.r.volume_after_mm3, V - 400); assert.equal(x.r.sound, true); assert.equal(x.r.volume_change_percent, -0.83);
  x = await ask(T.PLATE_C(), `const f = ctx.body().face({ normal: [0, 0, 1] }); f.cut([Geo2.circle([20, 20], 5), Geo2.circle([60, 40], 10), Geo2.slot([90, 20], [100, 60], 6)], { through: true });`);
  near(x.r.volume_after_mm3, V - 5 * (Math.PI * 25 + Math.PI * 100 + 6 * Math.hypot(10, 40) + Math.PI * 9), 1e-4);
  // a round cut has ONE cylindrical wall, not facets: 6 faces of the plate + 1
  x = await ask(T.PLATE_C(), `ctx.body().face({ normal: [0, 0, 1] }).cut(Geo2.offset(Geo2.circle([60, 40], 8), 2), { through: true }); console.log(ctx.body().faces({ kind: "cylinder" }).length, ctx.body().faces().length);`);
  assert.equal(x.out[0], "1 7");
  x = await ask(T.PLATE_C(), `const f = ctx.body().face({ normal: [0, 0, 1] }); f.add(Geo2.rect(10, 10, 20, 10), { height: 3 }); const under = f.body.face({ normal: [0, 0, -1] }); under.hole([under.toLocal([100, 20, 0]), under.toLocal([100, 60, 0])], { diameter: 6, depth: 2 }); ctx.body().face({ normal: [1, 0, 0] }).hole([40, 2.5], { diameter: 2, through: true }); console.log(ctx.bodies().length);`);
  near(x.r.volume_after_mm3, V + 600 - 2 * Math.PI * 9 * 2 - Math.PI * 120, 1e-4); assert.equal(x.out[0], 1);
});

test("build: new bodies, booleans, fillet, chamfer, shell, copies, patterns and moves", async () => {
  let x = await ask([], `
    const box = ctx.extrude(Geo2.rect(0, 0, 20, 10), ctx.plane("top"), { height: 5 });
    const post = ctx.extrude(Geo2.circle([10, 5], 2), ctx.plane("top"), { height: 8, offset: 5 });
    console.log(JSON.stringify([box.volume, post.volume, post.bounds.min[2], ctx.bodies().length]));
    const one = ctx.union(box, post);
    console.log(JSON.stringify([one.volume, ctx.bodies().length, one.id === box.id]));
    const both = ctx.extrude(Geo2.rect(0, 0, 4, 4), ctx.planeAt([0, 0, 20], [0, 0, 1]), { height: 3, both: true });
    console.log(JSON.stringify([both.volume, both.bounds.min[2], both.bounds.max[2]]));
    const cutter = ctx.extrude(Geo2.rect(15, 0, 10, 10), ctx.plane("top"), { height: 20 });
    ctx.subtract(one, cutter);
    console.log(JSON.stringify([ctx.body().volume, ctx.bodies().length]));
    const keep = ctx.intersect(both, ctx.extrude(Geo2.rect(0, 0, 2, 9), ctx.planeAt([0, 0, 17], [0, 0, 1]), { height: 9 }));
    console.log(keep.volume);
  `);
  near(x.out[0][0], 1000); near(x.out[0][1], Math.PI * 32, 1e-5); assert.equal(x.out[0][2], 5); assert.equal(x.out[0][3], 2);
  near(x.out[1][0], 1000 + Math.PI * 32, 1e-5); assert.equal(x.out[1][1], 1); assert.equal(x.out[1][2], true);
  near(x.out[2][0], 96); assert.equal(x.out[2][1], 17); assert.equal(x.out[2][2], 23);
  near(x.out[3][0], 750 + Math.PI * 32, 1e-5); assert.equal(x.out[3][1], 2);
  near(x.out[4], 2 * 4 * 6);
  assert.equal(x.r.sound, true);

  x = await ask(T.PLATE_C(), `
    const b = ctx.body();
    b.fillet(b.edges({ kind: "line", parallelTo: [0, 0, 1] }), 10);
    console.log(JSON.stringify([b.volume, b.faces({ kind: "cylinder" }).length]));
    b.chamfer(b.face({ normal: [0, 0, 1] }).edges().filter((e) => e.kind === "line"), 1);
    console.log(b.faces().length);
    b.shell(1, [b.face({ normal: [0, 0, -1] })]);
    console.log(b.volume < 48000 * 0.45);
  `);
  near(x.out[0][0], 48000 - (4 - Math.PI) * 100 * 5, 1e-4); assert.equal(x.out[0][1], 4); assert.ok(x.out[1] >= 14); assert.equal(x.out[2], true); assert.equal(x.r.sound, true);

  x = await ask([], `
    const pin = ctx.extrude(Geo2.circle([20, 0], 2), ctx.plane("top"), { height: 10 });
    const ring = ctx.circularPattern(pin, [0, 0, 0], [0, 0, 1], 6);
    const row = ctx.linearPattern(pin, [0, 0, 1], 3, 15);
    console.log(JSON.stringify([ring.length, row.length, ctx.bodies().length, ring[2].centre.map((v) => Math.round(v)), row[1].bounds.min[2]]));
    const c = pin.copy().translate([0, 50, 0]); c.rotate([0, 50, 0], [0, 0, 1], 90); c.mirror(ctx.plane("right"));
    console.log(JSON.stringify([c.centre.map((v) => Math.round(v)), c.id !== pin.id, c.volume]));
    row[0].remove();
    console.log(ctx.bodies().length);
  `);
  assert.deepEqual(x.out[0].slice(0, 3), [5, 2, 8]); assert.deepEqual(x.out[0][3], [-20, 0, 5]); assert.equal(x.out[0][4], 30);
  assert.deepEqual(x.out[1][0], [0, 70, 5]); assert.equal(x.out[1][1], true); near(x.out[1][2], Math.PI * 40, 1e-5);
  assert.equal(x.out[2], 8);
  near(x.r.volume_after_mm3, 8 * Math.PI * 40, 1e-4);
});

test("results: reports, warnings, labels the next feature can use, drag handles; faces keep their names", async () => {
  const k = await T.boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const src = feature(`
    const f = ctx.body().face({ normal: [0, 0, 1] });
    const before = f.id;
    f.cut(Geo2.rect(10, 10, 30, 20), { depth: p.depth });
    const top = ctx.body().face({ normal: [0, 0, 1] });
    console.log(top.id === before, ctx.body().faces().map((x) => x.id).filter((n) => /:floor|:wall/.test(n)).length);
    ctx.body().faces({ normal: [0, 0, 1] }).find((x) => x.centre[2] < 5).label("seat");
    ctx.report("Depth", p.depth); ctx.report("Note", "as asked");
    ctx.warn("Shallow.");
    ctx.handle("depth", f.toWorld([25, 20]), [0, 0, -1]);
  `, '{ depth: { type: "length", label: "Depth", default: 2, min: 0.1 } }');
  const cf = T.scriptFeature("cf", src, { depth: 2 });
  // a later, built-in feature refers to the labelled face by its name
  const fillet = { id: "fl", type: "fillet", name: "fl", suppressed: false, params: { edges: [], radius: 1 } };
  const r = await engine.regenerate([...T.PLATE_C(), cf, fillet], 3);
  const rep = r.features[2];
  assert.equal(rep.status, "warning"); assert.equal(rep.message, "Shallow."); assert.equal(rep.info, "Depth: 2 · Note: as asked");
  assert.deepEqual(rep.handles, [{ key: "depth", value: 2, origin: [25, 20, 5], dir: [0, 0, -1], scale: 1 }]);
  const names = engine.state.bodies[0].topo.faces.map((f) => f.name);
  assert.ok(names.includes("cf:seat"), names.join());
  assert.ok(names.includes("plate:end:pl0") || names.some((n) => n.startsWith("plate:end")), "the plate's top keeps its name");
  assert.equal(K.lastRunOf("cf").console[0], "true 5");
  assert.deepEqual(K.lastRunOf("cf").reports, [{ label: "Depth", value: "2" }, { label: "Note", value: "as asked" }]);
  // rebuilt from scratch the names are the same
  const again = new K.RegenEngine(k, K.FEATURES);
  await again.regenerate([...T.PLATE_C(), cf], 3);
  assert.deepEqual(again.state.bodies[0].topo.faces.map((f) => f.name).sort(), names.slice().sort());
  engine.dispose(); again.dispose();
});

test("parameters reach evaluate as the script declares them: picks as faces, edges, bodies and sketches", async () => {
  const k = await T.boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(T.PLATE_A(), 2);
  const body = engine.state.bodies[0];
  const topFace = body.topo.faces.find((f) => { const fr = k.faceFrame(f.shape); return fr && fr.normal[2] > 0.9; });
  const edge = body.topo.edges[0];
  const src = feature(`console.log(JSON.stringify([p.f && p.f.normal, p.fs.length, p.e && p.e.kind, p.b && p.b.id, p.bs.length, p.s && [p.s.regions.length, p.s.plane.normal, Math.round(Geo2.area(p.s.regions))], p.n, p.i, p.t, p.k, p.on, p.none]));`,
    '{ f: { type: "face", label: "F" }, fs: { type: "faces", label: "Fs" }, e: { type: "edge", label: "E" }, b: { type: "body", label: "B" }, bs: { type: "bodies", label: "Bs" }, s: { type: "sketch", label: "S" }, n: { type: "length", label: "N", default: 2 }, i: { type: "integer", label: "I", default: 3 }, t: { type: "text", label: "T", default: "x" }, k: { type: "enum", label: "K", options: { a: "A", b: "B" }, default: "a" }, on: { type: "boolean", label: "On", default: true }, none: { type: "face", label: "None" } }');
  const values = { f: { kind: "face", body: body.id, name: topFace.name }, fs: [{ kind: "face", body: body.id, name: topFace.name }], e: { kind: "edge", body: body.id, name: edge.name }, b: [body.id], bs: [body.id], s: { sketch: "s", regions: null }, n: 4.5, i: 6.6, t: "hello", k: "b", on: false };
  const r = await K.runReport(k, engine, [...T.PLATE_A(), T.scriptFeature("cf", src, values)], "cf", { image: false });
  assert.equal(r.status, "ok", r.error && r.error.message);
  const got = JSON.parse(r.console[0]);
  assert.deepEqual(got.slice(0, 5), [[0, 0, 1], 1, got[2], body.id, 1]);
  assert.ok(["line", "circle"].includes(got[2]));
  assert.equal(got[5][0], 1); assert.deepEqual(got[5][1], [0, 0, 1]); near(got[5][2], Math.round(86596.524 / 6), 1e-3);
  assert.deepEqual(got.slice(6), [4.5, 7, "hello", "b", false, null]);
  // a pick whose face is gone fails as any feature's does
  const gone = await K.runReport(k, engine, [...T.PLATE_A(), T.scriptFeature("cf", src, { ...values, f: { kind: "face", body: body.id, name: "no-such-face" } })], "cf", { image: false });
  assert.match(gone.error.message, /face this feature refers to no longer exists/);
  engine.dispose();
});

test("a cut that misses the part says so", async () => {
  const r = await T.run(T.PLATE_C(), feature(`ctx.body().face({ normal: [0, 0, 1] }).cut(Geo2.circle([500, 500], 5), { depth: 1 });`));
  assert.equal(r.status, "warning"); assert.match(r.warnings[0], /removed nothing/); assert.equal(r.volume_after_mm3, 48000);
});

test("a face that an operation removed says so; limits on one operation are sentences", async () => {
  let r = await T.run(T.PLATE_C(), feature(`const b = ctx.body(), side = b.face({ normal: [1, 0, 0] }); b.fillet(b.edges({ kind: "line", parallelTo: [0, 0, 1] }), 39.9); console.log(side.area);`));
  assert.ok(r.status === "ok" || /no longer exists on the part/.test(r.error.message));
  r = await T.run(T.PLATE_C(), feature(`const b = ctx.body(); const tool = ctx.extrude(Geo2.rect(0, 0, 5, 5), ctx.plane("top"), { height: 9 }); ctx.subtract(b, tool); console.log(tool.volume);`));
  assert.match(r.error.message, /no longer in the model/);
  r = await T.run(T.PLATE_C(), feature(`ctx.body().face({ kind: "cylinder" });  ctx.body().faces({ kind: "plane" })[0].cut(Geo2.cells("square", Geo2.rect(0, 0, 4000, 4000), { pitch: 1, inset: 0.2 }), { depth: 1 });`));
  assert.match(r.error.message, /more than 20 000 cells|more than one operation takes|too many points/);
  r = await T.run(T.PLATE_C(), feature(`ctx.body().faces({ kind: "plane" })[0].cut(Geo2.rect(1, 1, 2, 2), { depth: 0 });`));
  assert.match(r.error.message, /depth of a cut must be more than zero/);
  r = await T.run(T.PLATE_C(), feature(`ctx.body().fillet([], 2);`));
  assert.match(r.error.message, /no edges to round/);
  r = await T.run(T.PLATE_C(), feature(`const b = ctx.body(); b.fillet(b.edges(), 50);`));
  assert.equal(r.status, "error"); assert.equal(r.volume_after_mm3, 48000);
  r = await T.run([], feature(`ctx.body();`));
  assert.match(r.error.message, /no part to work on yet/);
});

test("the report on a part, and the report as text", async () => {
  const k = await T.boot(), engine = new K.RegenEngine(k, K.FEATURES);
  await engine.regenerate(T.PLATE_A(), 2);
  const s = K.partSummary(k, engine.state);
  assert.equal(s.bodies.length, 1);
  const b = s.bodies[0];
  assert.deepEqual(b.bbox_mm.size, [160, 100, 6]); near(b.volume_mm3, 86596.524, 1e-5);
  assert.equal(b.faces.by_kind.plane, 7); assert.equal(b.faces.by_kind.cylinder, 6);
  assert.deepEqual(b.faces.flat[0].normal.map(Math.abs), [0, 0, 1]); assert.equal(b.faces.flat[0].openings, 6);
  assert.deepEqual(b.holes, [{ diameter_mm: 6.6, count: 4 }, { diameter_mm: 8, count: 1 }, { diameter_mm: 22, count: 1 }]);
  engine.dispose();
  const r = await T.run(T.PLATE_A(), T.exemplar("lighten-plate"), {}, { image: { view: "top", width: 400 }, density: 2.7 });
  assert.match(K.reportText(r), /^Built: the result is a sound solid\.\nVolume 86596\.524 → \d+\.\d+ mm³ \(-4\d\.\d+ %\); 1 body, \d+ faces\.\nMass 233\.811 → \d+\.\d+ g\.\nPockets: 7\nMass saved: 4\d\.\d %$/);
  const png = Buffer.from(r.png, "base64");
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 400); assert.equal(png.readUInt32BE(20), 300);
  assert.ok(png.length > 3000 && png.length < 400000);
  if (process.env.SHOTS) fs.writeFileSync(path.join(process.env.SHOTS, "script-report-truss.png"), png);
});

// ---------------------------------------------------------------- the type file

test("the type file names exactly what a script can call, and the editor's index is read from it", () => {
  const A = load("domains/mechanical/script/apidoc.ts");
  const idx = A.parseApi(K.API_DTS);
  assert.deepEqual(idx.globals.map((g) => g.name).sort(), ["Geo2", "V3", "console", "feature"]);
  const prelude = fs.readFileSync(path.join(server, "web", "domains", "mechanical", "script", "assets", "prelude.js"), "utf8");
  // every Geo2 function of the type file exists in the sandbox, and the other way round
  const declared = idx.types.Geo2.map((m) => m.name).sort();
  const made = /for \(const name of \[([^\]]+)\]\)/.exec(prelude)[1].split(",").map((s) => s.trim().replace(/"/g, "")).sort();
  assert.deepEqual(declared, made);
  // every method the type file gives the context, a body, a face and an edge is one the prelude defines
  for (const [type, re] of [["Context", (n) => new RegExp(`\\b${n}: `)], ["Body", (n) => new RegExp(`\\b${n}\\(|"${n}"`)], ["Face", (n) => new RegExp(`\\b${n}\\(|"${n}"|get ${n}\\(`)], ["Edge", (n) => new RegExp(`\\b${n}\\(|"${n}"|get ${n}\\(`)], ["V3", (n) => new RegExp(`\\b${n}: function`)]]) {
    for (const m of idx.types[type]) if (!['id', 'body'].includes(m.name)) assert.match(prelude, re(m.name), `${type}.${m.name}`);
  }
  const cut = idx.types.Face.find((m) => m.name === "cut");
  assert.match(cut.signature, /^cut\(shape: Shape2, opts:/); assert.match(cut.doc, /Cut a 2D shape/);
  assert.equal(A.receiverType("ctx"), "Context"); assert.equal(A.receiverType("Geo2"), "Geo2");
  assert.deepEqual(A.unionValues(K.API_DTS, "IconName").sort(), Object.keys(K.ICONS).sort());
  // the parameter types of the type file are the ones the manifest reader takes
  const types = /interface PickParam[^{]*\{ type: ([^}]+)\}/.exec(K.API_DTS)[1].match(/"(\w+)"/g).map((s) => s.replace(/"/g, ""));
  for (const t of [...types, "length", "angle", "number", "integer", "boolean", "enum", "text"]) assert.equal(K.readManifest({ title: "x", params: [{ key: "a", type: t, label: "A", default: t === "boolean" ? true : t === "text" ? "" : 1, options: { a: "A", b: "B" } }] }).manifest.params.length, 1, t);
});
