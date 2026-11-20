// Node test for the sketch's free-form curves (web/domains/mechanical/sketch/curves.ts): ellipses, splines,
// Bézier curves, conics and text as geometry, in the solver (PlaneGCS ellipses, the spline constraints) and as
// regions an extrude can use.
// Run: node server/static/tests/sketch-curves.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./sketch-load");

const C = load("domains/mechanical/sketch/curves.ts");
const L = load("domains/mechanical/sketch/solver/load.ts");
const PL = load("domains/mechanical/sketch/planar.ts");

const pt = (x, y) => ({ type: "point", x, y });
const sketch = (entities, constraints = {}) => ({ version: 1, entities, constraints });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const P = (r, id) => [r.data.entities[id].x, r.data.entities[id].y];

test("an ellipse is exact: every sampled point satisfies its equation, and its area is πab", () => {
  const s = sketch({ c: pt(5, 3), m: pt(25, 3), e: { type: "ellipse", center: "c", major: "m", minor: 8 } });
  const [pc] = C.freeformPieces(s, "e");
  for (const p of C.samplePiece(pc)) near(((p[0] - 5) / 20) ** 2 + ((p[1] - 3) / 8) ** 2, 1, 1e-9);
  const r = PL.findRegions(s);
  assert.equal(r.regions.length, 1);
  near(r.regions[0].outer.area, Math.PI * 20 * 8, 2);   // the polygon is a sampling of the curve
});

test("a spline passes through its points, and a handle sets the direction it leaves in", () => {
  const pts = [[0, 0], [10, 5], [20, -3], [30, 4]];
  const n = C.interpolate(pts, false, null, null);
  const whole = { nurbs: n, t0: n.knots[3], t1: n.knots[n.knots.length - 1], closed: false };
  for (const p of pts) { const best = C.nearestOnPiece(whole, p).d; assert.ok(best < 1e-9, `${p} is ${best} away`); }
  const s = sketch({ a: pt(0, 0), b: pt(10, 5), c: pt(20, 0), h: pt(0, 6), k: { type: "spline", points: ["a", "b", "c"], startHandle: "h" } });
  const [pc] = C.freeformPieces(s, "k");
  const t = C.pieceTangent(pc, pc.t0);
  near(Math.atan2(t[1], t[0]), Math.PI / 2, 1e-6);
});

test("a closed spline makes a region; a Bézier and a conic close a loop with a line", () => {
  const s = sketch({
    a: pt(0, 0), b: pt(20, 0), c: pt(20, 20), d: pt(0, 20),
    k: { type: "spline", points: ["a", "b", "c", "d"], closed: true },
  });
  assert.equal(PL.findRegions(s).regions.length, 1);
  const z = sketch({
    a: pt(0, 0), b: pt(30, 0), c1: pt(10, 20), c2: pt(20, 20),
    l: { type: "line", a: "a", b: "b" }, z: { type: "bspline", poles: ["b", "c2", "c1", "a"], degree: 3 },
  });
  const rz = PL.findRegions(z);
  assert.equal(rz.regions.length, 1);
  near(rz.regions[0].outer.area, 30 * 15 * 0.5 + 30 * 15 * 0.5 * 0.0, 300);   // a cubic arch over the line
  const q = sketch({ a: pt(0, 0), b: pt(30, 0), x: pt(15, 20), l: { type: "line", a: "a", b: "b" }, q: { type: "conic", start: "b", apex: "x", end: "a", rho: 0.5 } });
  const rq = PL.findRegions(q);
  assert.equal(rq.regions.length, 1);
  near(rq.regions[0].outer.area, (2 / 3) * 30 * 10, 2);   // a parabola: two thirds of its box (height 10 at rho 0.5); the polygon samples it
});

test("a line across an ellipse splits it into two regions, cut exactly where they cross", () => {
  const s = sketch({ c: pt(0, 0), m: pt(20, 0), e: { type: "ellipse", center: "c", major: "m", minor: 10 }, a: pt(0, -15), b: pt(0, 15), l: { type: "line", a: "a", b: "b" } });
  const r = PL.findRegions(s);
  assert.equal(r.regions.length, 2);
  for (const g of r.regions) near(g.outer.area, Math.PI * 200 / 2, 2);
  const cut = r.regions[0].outer.edges.find((e) => e.entity === "e");
  assert.ok(cut.span, "the ellipse is used in part");
});

test("text makes regions: the letters' outlines, with their holes", () => {
  const s = sketch({ a: pt(0, 0), b: pt(0, 10), t: { type: "text", a: "a", b: "b", text: "IO" } });
  const r = PL.findRegions(s);
  assert.equal(r.regions.length, 2);   // I, and O with its counter as a hole
  assert.ok(r.regions.some((g) => g.holes.length === 1));
  for (const g of r.regions) assert.ok(g.outer.area > 5);
});

test("the solver holds an ellipse: a point on it, its minor radius, and the major-axis point", async () => {
  const s = await L.loadSolver();
  let r = s.solve(sketch({ c: pt(0, 0), m: pt(20, 0), e: { type: "ellipse", center: "c", major: "m", minor: 10 }, p: pt(3, 14) },
    { k1: { type: "coincident", refs: [{ entity: "p" }, { entity: "e" }] }, k2: { type: "fix", refs: [{ entity: "e" }] } }));
  assert.ok(r.ok, "solves");
  const [x, y] = P(r, "p");
  near((x / 20) ** 2 + (y / 10) ** 2, 1, 1e-6);
  near(r.data.entities.e.minor, 10);
  // dragging the major point along keeps it an ellipse: the minor radius is free
  r = s.solve(sketch({ c: pt(0, 0), m: pt(20, 0), e: { type: "ellipse", center: "c", major: "m", minor: 10 } }, { h: { type: "horizontal", refs: [{ entity: "c" }, { entity: "m" }] } }));
  assert.ok(r.ok);
  assert.equal(r.dof, 4);   // centre (2), major radius (1), minor radius (1)
});

test("tangency of a line and an ellipse, and a partial ellipse ending on a line", async () => {
  const s = await L.loadSolver();
  const r = s.solve(sketch({
    c: pt(0, 0), m: pt(20, 0), e: { type: "ellipse", center: "c", major: "m", minor: 10 }, a: pt(-30, 12), b: pt(30, 13), l: { type: "line", a: "a", b: "b" },
  }, { f: { type: "fix", refs: [{ entity: "e" }] }, h: { type: "horizontal", refs: [{ entity: "l" }] }, t: { type: "tangent", refs: [{ entity: "l" }, { entity: "e" }] } }));
  assert.ok(r.ok);
  near(P(r, "a")[1], 10, 1e-6);
  const q = s.solve(sketch({
    c: pt(0, 0), m: pt(20, 0), s: pt(20, 0.001), en: pt(0, 10), e: { type: "ellipticalArc", center: "c", major: "m", minor: 10, start: "s", end: "en" },
  }, { f: { type: "fix", refs: [{ entity: "c" }, { entity: "m" }] } }));
  assert.ok(q.ok);
  const [sx, sy] = P(q, "s");
  near((sx / 20) ** 2 + (sy / q.data.entities.e.minor) ** 2, 1, 1e-6);
});

test("a Bézier curve tangent and curvature-continuous to a line, and tangent to an arc", async () => {
  const s = await L.loadSolver();
  const base = {
    a: pt(0, 0), b: pt(20, 0), l: { type: "line", a: "a", b: "b" },
    c1: pt(28, 3), c2: pt(35, 12), d: pt(40, 20), z: { type: "bspline", poles: ["b", "c1", "c2", "d"], degree: 3 },
  };
  let r = s.solve(sketch(base, { f: { type: "fix", refs: [{ entity: "l" }] }, t: { type: "tangent", refs: [{ entity: "l" }, { entity: "z" }] } }));
  assert.ok(r.ok);
  near(P(r, "c1")[1], 0, 1e-7);
  r = s.solve(sketch(base, { f: { type: "fix", refs: [{ entity: "l" }] }, g: { type: "curvature", refs: [{ entity: "l" }, { entity: "z" }] } }));
  assert.ok(r.ok);
  near(P(r, "c1")[1], 0, 1e-7); near(P(r, "c2")[1], 0, 1e-7);
  const arc = {
    o: pt(0, 0), s0: pt(10, 0), e0: pt(0, 10), k: { type: "arc", center: "o", start: "s0", end: "e0" },
    h1: pt(-3, 14), d: pt(-8, 20), z: { type: "bspline", poles: ["e0", "h1", "d"], degree: 2 },
  };
  r = s.solve(sketch(arc, { f: { type: "fix", refs: [{ entity: "k" }] }, t: { type: "tangent", refs: [{ entity: "k" }, { entity: "z" }] } }));
  assert.ok(r.ok);
  near(P(r, "h1")[1], 10, 1e-7);   // square to the radius at the top of the arc: level
});

test("two Bézier curves joined with curvature continuity agree in first and second derivative", async () => {
  const s = await L.loadSolver();
  const r = s.solve(sketch({
    a0: pt(0, 0), a1: pt(5, 8), a2: pt(12, 10), p: pt(20, 6), b1: pt(27, 1), b2: pt(33, 5), b3: pt(40, 0),
    za: { type: "bspline", poles: ["a0", "a1", "a2", "p"], degree: 3 }, zb: { type: "bspline", poles: ["p", "b1", "b2", "b3"], degree: 3 },
  }, { f: { type: "fix", refs: [{ entity: "za" }] }, g: { type: "curvature", refs: [{ entity: "za" }, { entity: "zb" }] } }));
  assert.ok(r.ok);
  const at = (id) => P(r, id);
  const [A2, A1, Pp, B1, B2] = [at("a1"), at("a2"), at("p"), at("b1"), at("b2")];
  near(Pp[0] - A1[0], B1[0] - Pp[0], 1e-6); near(Pp[1] - A1[1], B1[1] - Pp[1], 1e-6);
  near(Pp[0] - 2 * A1[0] + A2[0], Pp[0] - 2 * B1[0] + B2[0], 1e-6); near(Pp[1] - 2 * A1[1] + A2[1], Pp[1] - 2 * B1[1] + B2[1], 1e-6);
});

const SH = load("domains/mechanical/sketch/curve-shapes.ts");
const M = load("domains/mechanical/sketch/model.ts");
const OPS = load("domains/mechanical/sketch/ops.ts");
const AR = load("domains/mechanical/sketch/arrange.ts");
const snapAt = (x, y) => ({ p: [x, y], hints: [], guides: [] });
const build = (spec, clicks, typed = {}, data = sketch({})) => { const d = new M.Draft(data); const r = spec.build(d, clicks.map(([x, y]) => snapAt(x, y)), typed, null); assert.ok(r, `${spec.id} builds`); return d.data; };

test("the new drawing tools build what they say, constrained as a person means it", async () => {
  const s = await L.loadSolver();
  // a hexagon stays regular: four freedoms (centre, size, turn)
  let r = s.solve(build(SH.polygon(false), [[0, 0], [10, 0]]));
  assert.ok(r.ok); assert.equal(r.dof, 4);
  const lines = Object.values(r.data.entities).filter((e) => e.type === "line" && !e.construction);
  assert.equal(lines.length, 6);
  const len = (l) => Math.hypot(r.data.entities[l.a].x - r.data.entities[l.b].x, r.data.entities[l.a].y - r.data.entities[l.b].y);
  for (const l of lines) near(len(l), 10, 1e-6);
  // circumscribed: the sides touch a circle of the clicked radius
  r = s.solve(build(SH.polygon(true), [[0, 0], [0, 10]], { diameter: 20 }));
  assert.ok(r.ok); assert.equal(r.dof, 3);
  near(PL.findRegions(r.data).regions[0].outer.area, 6 * 10 * 10 * Math.tan(Math.PI / 6), 1e-3);
  // an aligned rectangle at 30°: five freedoms, square corners
  r = s.solve(build(SH.alignedRectangle, [[0, 0], [Math.cos(Math.PI / 6) * 20, 10], [0, 30]]));
  assert.ok(r.ok); assert.equal(r.dof, 5);
  near(PL.findRegions(r.data).regions[0].outer.area, 20 * Math.abs(30 * Math.cos(Math.PI / 6)), 1e-3);
  // three-point circle through its points; ellipse; partial ellipse; conic; spline; Bézier
  r = s.solve(build(SH.circle3, [[0, 0], [10, 0], [5, 5]]));
  assert.ok(r.ok); near(Object.values(r.data.entities).find((e) => e.type === "circle").r, 5, 1e-9);
  const el = build(SH.ellipse, [[0, 0], [20, 0], [3, 8]]);
  const e = Object.values(el).length && Object.values(el.entities).find((x) => x.type === "ellipse");
  near(e.minor, 8, 1e-9);
  const pe = SH.partialEllipse();
  pe.preview([snapAt(0, 0), snapAt(20, 0), snapAt(0, 8), snapAt(20, 0.1)], snapAt(0, 9), sketch({}));   // swept counter-clockwise a quarter
  const pd = build(pe, [[0, 0], [20, 0], [0, 8], [20, 0.1], [-0.1, 9]]);
  assert.equal(PL.findRegions(pd).regions.length, 0);
  assert.ok(Object.values(pd.entities).some((x) => x.type === "ellipticalArc"));
  const cd = build(SH.conic, [[0, 0], [30, 0], [15, 20]]);
  assert.ok(Object.values(cd.entities).some((x) => x.type === "conic" && x.rho === 0.5));
  const sd = build(SH.spline, [[0, 0], [10, 10], [20, 0], [10, -10], [0, 0.01]]);
  const sp = Object.values(sd.entities).find((x) => x.type === "spline");
  assert.ok(sp.closed, "a click back on the first point closes it"); assert.equal(sp.points.length, 4);
  assert.equal(PL.findRegions(sd).regions.length, 1);
  const bd = build(SH.bezier, [[0, 0], [10, 20], [20, 20], [30, 0]]);
  assert.ok(Object.values(bd.entities).some((x) => x.type === "bspline" && x.degree === 3));
  assert.equal(Object.values(bd.entities).filter((x) => x.type === "line" && x.construction).length, 3, "the control polygon");
});

test("split, linear and circular copies, and moving keep the geometry and its own constraints", async () => {
  const s = await L.loadSolver();
  let d = new M.Draft(sketch({ a: pt(0, 0), b: pt(10, 0), l: { type: "line", a: "a", b: "b" }, q: pt(10, 5), m: { type: "line", a: "b", b: "q" } }, { k: { type: "horizontal", refs: [{ entity: "l" }] } }));
  assert.equal(OPS.split(d, "l", [4, 0]), null);
  assert.equal(Object.values(d.data.entities).filter((e) => e.type === "line").length, 3);
  assert.ok(s.solve(d.data).ok);
  // a rectangle copied in a row three times and round a centre: rectangles each
  const rect = { r1: pt(0, 0), r2: pt(4, 0), r3: pt(4, 2), r4: pt(0, 2), la: { type: "line", a: "r1", b: "r2" }, lb: { type: "line", a: "r2", b: "r3" }, lc: { type: "line", a: "r3", b: "r4" }, ld: { type: "line", a: "r4", b: "r1" } };
  const cons = { h1: { type: "horizontal", refs: [{ entity: "la" }] }, h2: { type: "horizontal", refs: [{ entity: "lc" }] }, v1: { type: "vertical", refs: [{ entity: "lb" }] }, v2: { type: "vertical", refs: [{ entity: "ld" }] }, f: { type: "fix", refs: [{ entity: "r1" }] } };
  d = new M.Draft(sketch(rect, cons));
  for (let i = 1; i < 3; i++) AR.copyEntities(d, ["la", "lb", "lc", "ld"], (p) => [p[0] + 10 * i, p[1]]);
  let r = s.solve(d.data);
  assert.ok(r.ok);
  assert.equal(PL.findRegions(r.data).regions.length, 3);
  assert.equal(Object.values(r.data.constraints).filter((c) => c.type === "horizontal").length, 6, "each copy keeps its own constraints");
  assert.equal(Object.values(r.data.constraints).filter((c) => c.type === "fix").length, 1, "what pins it to the sketch stays with the original");
  d = new M.Draft(sketch(rect));
  AR.copyEntities(d, ["la", "lb", "lc", "ld"], (p) => [-p[1], p[0]]);
  assert.equal(PL.findRegions(d.data).regions.length, 2);
  d = new M.Draft(sketch(rect, cons));
  AR.moveEntities(d, ["la", "lb", "lc", "ld"], (p) => [p[0] + 5, p[1] + 1]);
  r = s.solve(d.data);
  assert.ok(r.ok); assert.deepEqual(P(r, "r1"), [5, 1]);
});

test("normal and pierce in the solver", async () => {
  const s = await L.loadSolver();
  let r = s.solve(sketch({ o: pt(0, 0), c: { type: "circle", center: "o", r: 5 }, a: pt(3, 7), b: pt(9, 2), l: { type: "line", a: "a", b: "b" } }, { f: { type: "fix", refs: [{ entity: "c" }] }, fa: { type: "fix", refs: [{ entity: "a" }] }, n: { type: "normal", refs: [{ entity: "l" }, { entity: "c" }] } }));
  assert.ok(r.ok);
  const [bx, by] = P(r, "b");
  near(3 * by - 7 * bx, 0, 1e-6);   // the line runs through the centre
  r = s.solve(sketch({ p: pt(1, 1) }, { k: { type: "pierce", refs: [{ entity: "p" }], x: 4, y: -2, from: { kind: "edge", body: "b", name: "x" } } }));
  assert.ok(r.ok); assert.deepEqual(P(r, "p"), [4, -2]); assert.equal(r.dof, 0);
});

test("the MCP shorthand shapes include the new curves", () => {
  const MM = load("domains/mechanical/mcp/model.ts");
  const { entities, problems } = MM.shapesToEntities([
    { type: "ellipse", cx: 0, cy: 0, rx: 10, ry: 20 },
    { type: "regular_polygon", cx: 50, cy: 0, r: 10, sides: 6 },
    { type: "spline", points: [[100, 0], [110, 10], [120, 0], [110, -10]], closed: true },
    { type: "bezier", points: [[0, 50], [10, 70], [20, 50]] },
    { type: "text", x: 0, y: 100, height: 10, text: "O" },
  ]);
  assert.deepEqual(problems, []);
  const r = PL.findRegions(sketch(entities));
  assert.equal(r.regions.length, 4);   // ellipse, hexagon, closed spline, the O (with its hole)
  assert.ok(r.regions.some((g) => g.holes.length === 1));
  near(Object.values(entities).find((e) => e.type === "ellipse").minor, 10);
});
