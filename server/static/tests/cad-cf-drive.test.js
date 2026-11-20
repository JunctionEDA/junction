// Node test for the power transmission custom features (web/domains/mechanical/features/cf-drive-*.ts and
// kernel/ops/cf-drive.ts): gears, pulleys, belts, sprockets, chains, ratchets, Geneva wheels, cams, splines,
// keyways, shafts, bearing seats, ring grooves and springs.  The real OpenCascade build runs here.
// Run: node server/static/tests/cad-cf-drive.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));
const mech = path.join(server, "web", "domains", "mechanical");

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const load = (options) => {
  const bundle = esbuild.buildSync({ bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node", ...options });
  const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
  return M.exports;
};
const K = load({ entryPoints: [path.join(mech, "kernel", "index.ts")] });
// the geometry the features draw from, without the kernel
const G = load({ stdin: { resolveDir: mech, loader: "ts", contents: 'export * from "./features/_cf-drive"; export * from "./features/_cf-drive-data"; export * from "./features/_cf-drive-path"; export { cycloidPoints } from "./features/cf-drive-cycloidal"; export { sprocketLoop } from "./features/cf-drive-sprocket"; export { pulleyLoop } from "./features/cf-drive-timing-pulley"; export { parseSteps } from "./features/cf-drive-stepped-shaft"; export { parseLiftTable } from "./features/cf-drive-cam";' } });

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

const MINE = K.FEATURES.filter((f) => ["cf-spur-gear", "cf-helical-gear", "cf-herringbone-gear", "cf-internal-gear", "cf-rack", "cf-bevel-gear", "cf-worm", "cf-planetary", "cf-cycloidal",
  "cf-timing-pulley", "cf-timing-belt", "cf-v-pulley", "cf-sprocket", "cf-chain", "cf-ratchet", "cf-geneva", "cf-cam", "cf-keyway", "cf-stepped-shaft", "cf-d-cut", "cf-ring-groove", "cf-bearing-seat", "cf-spline",
  "cf-compression-spring", "cf-extension-spring", "cf-torsion-spring"].includes(f.type));
const def = (type) => K.FEATURES.find((f) => f.type === type);
const feature = (id, type, over = {}) => ({ id, type, name: id, suppressed: false, params: { ...def(type).defaults(), ...over } });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const within = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

/** Build features; returns the kernel, the last feature's report and the bodies by id. */
async function build(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const t0 = Date.now();
  const r = await engine.regenerate(features, features.length);
  const state = engine.entries[engine.entries.length - 1].state;
  const bodies = {}; for (const b of state.bodies) bodies[b.id] = b;
  return { k, r, last: r.features[r.features.length - 1], bodies, list: state.bodies, ms: Date.now() - t0 };
}
const make = (type, over, before = []) => build([...before, feature("g", type, over)]);
const ok = (b) => assert.equal(b.last.status, "ok", `${b.last.status}: ${b.last.message}`);
const valid = (k, body) => { const c = new k.oc.BRepCheck_Analyzer(body.shape, true, false); try { return c.IsValid(); } finally { c.delete(); } };
const names = (body) => body.topo.faces.map((f) => f.name);
const faceNamed = (body, name) => { const f = body.topo.faces.find((x) => x.name === name); assert.ok(f, `no face ${name} among ${names(body).slice(0, 12).join(" ")} …`); return f.shape; };
/** The box round a body's vertices: [xmin, ymin, zmin, xmax, ymax, zmax]. */
function extent(k, body) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const v of k.sub(body.shape, "vertex")) { const p = k.vertexPoint(v); for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], p[i]); b[i + 3] = Math.max(b[i + 3], p[i]); } }
  return b;
}
/** The least and greatest distance of a body's vertices from the z axis through (cx, cy). */
function radii(k, body, cx = 0, cy = 0) {
  let lo = Infinity, hi = 0;
  for (const v of k.sub(body.shape, "vertex")) { const p = k.vertexPoint(v), r = Math.hypot(p[0] - cx, p[1] - cy); lo = Math.min(lo, r); hi = Math.max(hi, r); }
  return [lo, hi];
}
/** The volume two bodies share. */
function shared(k, a, b) {
  const oc = k.oc, range = new oc.Message_ProgressRange(), algo = new oc.BRepAlgoAPI_Common(a.shape, b.shape, range);
  algo.Build(range);
  const s = algo.Shape(), v = k.volume(s); s.delete(); algo.delete(); range.delete();
  return v;
}
/** The tight box round a body (springs have no vertices worth the name). */
function tight(k, body) {
  const oc = k.oc, box = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(body.shape, box, false, false);
  const out = [box.GetXMin(), box.GetYMin(), box.GetZMin(), box.GetXMax(), box.GetYMax(), box.GetZMax()]; box.delete();
  return out;
}

const shaft = (steps, over = {}) => feature("sh", "cf-stepped-shaft", { steps, chamfer: 0, fillet: 0, ...over });
const on = (name) => ({ kind: "face", body: "sh", name });

test("every power transmission feature is in the Custom features drop-down with an icon, a hint and search words", () => {
  assert.equal(MINE.length, 26);
  for (const f of MINE) {
    assert.equal(f.toolbarSection, "library", f.type);
    assert.ok(f.toolbarMenu === "Gears" || f.toolbarMenu === "Power transmission", f.type);
    assert.equal(f.toolbarKeep, 0, f.type);
    assert.ok(f.icon && f.hint && f.keywords, f.type);
    assert.ok(!/\d\.\d*00/.test(f.icon), `${f.type}: icon numbers`);
  }
  assert.equal(new Set(MINE.map((f) => f.icon)).size, MINE.length, "two features share an icon");
  assert.equal(MINE.filter((f) => f.toolbarMenu === "Gears").length, 9);
});

test("every feature builds with its defaults: one valid solid per body, every face named", async () => {
  const needFace = new Set(["cf-keyway", "cf-d-cut", "cf-ring-groove"]);
  for (const f of MINE) {
    const before = needFace.has(f.type) ? [shaft(f.type === "cf-d-cut" ? "5 x 24" : "20 x 60")] : f.type === "cf-bearing-seat" ? [shaft("40 x 20")] : [];
    const over = needFace.has(f.type) ? { face: on("sh:step1") } : f.type === "cf-bearing-seat" ? { plane: { kind: "face", ref: on("sh:end") } } : {};
    const b = await make(f.type, over, before);
    ok(b);
    assert.ok(b.list.length >= 1, f.type);
    for (const body of b.list) {
      assert.ok(valid(b.k, body), `${f.type}: ${body.id} is not a valid shape`);
      assert.ok(b.k.volume(body.shape) > 1, `${f.type}: ${body.id} has no volume`);
      if (f.type !== "cf-chain" && f.type !== "cf-cycloidal") assert.equal(b.k.solids(body.shape).length, 1, `${f.type}: ${body.id}`);
      assert.ok(!names(body).some((n) => /:new#/.test(n)), `${f.type}: ${body.id} has faces without a name: ${names(body).filter((n) => /:new#/.test(n)).slice(0, 4)}`);
    }
  }
});

test("a feature that needs a cylindrical face says so", async () => {
  for (const type of ["cf-keyway", "cf-d-cut", "cf-ring-groove"]) {
    const b = await make(type, {});
    assert.equal(b.last.status, "error");
    assert.match(b.last.message, /Pick the cylindrical face/);
  }
  const flat = await make("cf-keyway", { face: on("sh:end") }, [shaft("20 x 60")]);
  assert.match(flat.last.message, /not cylindrical/);
});

// ------------------------------------------------------------------ gears

test("the involute: a flank's points lie on the involute of the base circle, and the tooth is as thick as the standard says", () => {
  const m = 2, z = 20, alpha = (20 * Math.PI) / 180;
  const t = { z, r: (m * z) / 2, alpha, ha: m, hf: 1.25 * m, s: (Math.PI * m) / 2, fillet: 0.38 * m };
  const rb = t.r * Math.cos(alpha);
  // a point of the involute at roll angle u is at radius rb·√(1 + u²) and polar angle u − atan(u): the tooth's flank mirrors it about the tooth's half angle at the base
  for (const u of [0.1, 0.25, 0.4, 0.5]) {
    const rho = rb * Math.sqrt(1 + u * u), invAngle = u - Math.atan(u);
    near(G.halfAngle(t, rb) - G.halfAngle(t, rho), invAngle, 1e-12);
  }
  near(2 * t.r * G.halfAngle(t, t.r), (Math.PI * m) / 2, 1e-12);
  // the outline: every flank point of tooth 1 is on that curve, tips on the tip circle, roots on the root circle
  const loop = G.gearLoop(t);
  const flank = loop.segs.find((s) => s.label === "t1:b");
  for (const q of [...flank.pts, flank.to]) { const rho = Math.hypot(q[0], q[1]); near(Math.atan2(q[1], q[0]), G.halfAngle(t, rho), 1e-9); }
  const tip = loop.segs.find((s) => s.label === "t1:tip");
  near(Math.hypot(tip.to[0], tip.to[1]), t.r + m, 1e-12);
  assert.equal(loop.segs.filter((s) => /:tip$/.test(s.label)).length, z);
  // few teeth: the flank goes on below the base circle as a radial line
  const few = G.gearLoop({ ...t, z: 9, r: 9 });
  assert.ok(few.segs.some((s) => s.label === "t1:ua"));
  // a pointed tooth is cut short of the tip circle
  assert.equal(G.tipRadius({ ...t, z: 8, r: 8, ha: 1.9 * m, s: 5.2 }).pointed, true);
  assert.equal(G.tipRadius(t).pointed, false);
});

test("spur gear: the flank on the solid is the involute; module, DP, profile shift, keyway and hub", async () => {
  const b = await make("cf-spur-gear", {});
  ok(b);
  const k = b.k, oc = k.oc, g = b.bodies.g;
  assert.equal(names(g).length, 20 * 8 + 3);
  const [, tip] = radii(k, g);
  near(tip, 22, 1e-9);
  near(extent(k, g)[5], 10, 1e-9);
  // less than the tip cylinder, more than the root cylinder, close to the pitch cylinder
  const v = k.volume(g.shape), bore = Math.PI * 16 * 10;
  assert.ok(v < Math.PI * 22 * 22 * 10 - bore && v > Math.PI * 17.5 * 17.5 * 10 - bore);
  within(v, Math.PI * 400 * 10 - bore, 0.03 * v);
  // along the edge of a flank face on the bottom of the gear, every point satisfies the involute equation
  const t = { z: 20, r: 20, alpha: (20 * Math.PI) / 180, ha: 2, hf: 2.5, s: Math.PI, fillet: 0.76 };
  const edges = k.sub(faceNamed(g, "g:t1:b"), "edge").filter((e) => { const c = k.centre(e, "edge"); return Math.abs(c[2]) < 1e-9; });
  assert.equal(edges.length, 1);
  const ad = new oc.BRepAdaptor_Curve(edges[0]);
  let worst = 0;
  for (let i = 0; i <= 40; i++) {
    const p = ad.Value(ad.FirstParameter() + ((ad.LastParameter() - ad.FirstParameter()) * i) / 40), rho = Math.hypot(p.X(), p.Y());
    worst = Math.max(worst, Math.abs(Math.atan2(p.Y(), p.X()) - G.halfAngle(t, rho)) * rho);
    p.delete();
  }
  ad.delete();
  assert.ok(worst < 2e-4, `the flank is ${worst} mm off the involute`);

  const dp = await make("cf-spur-gear", { system: "dp", dp: 12, teeth: 9, shift: 0.3, keyway: true, hubDiameter: 12, hubLength: 5 });
  ok(dp);
  const m = 25.4 / 12;
  near(radii(dp.k, dp.bodies.g)[1], m * (9 / 2 + 1 + 0.3), 1e-9);
  near(extent(dp.k, dp.bodies.g)[5], 15, 1e-9);
  for (const n of ["g:key:floor", "g:hub:side", "g:hub:top", "g:bore", "g:top", "g:bottom", "g:t9:tip"]) faceNamed(dp.bodies.g, n);
  // the keyway is DIN 6885's for an 8 mm bore: 2 wide, 1.0 into the hub
  near(k.faceFrame(faceNamed(dp.bodies.g, "g:key:floor")).origin[1], 4 + 1.0, 1e-9);

  assert.match((await make("cf-spur-gear", { bore: 40 })).last.message, /bore .* does not fit/);
  assert.match((await make("cf-spur-gear", { teeth: 3 })).last.message, /whole number from 4/);
  assert.match((await make("cf-spur-gear", { bore: 5, keyway: true })).last.message, /DIN 6885/);
});

test("a gear joins a body it stands on, and keeps its names when a tooth count stands", async () => {
  const b = await build([shaft("12 x 30"), feature("g", "cf-spur-gear", { operation: "add", bore: 0, plane: { kind: "face", ref: on("sh:end") } })]);
  ok(b);
  assert.equal(b.list.length, 1);
  near(extent(b.k, b.list[0])[5], 40, 1e-9);
  const a = await make("cf-spur-gear", {}), c = await make("cf-spur-gear", { module: 3, width: 14, bore: 10 });
  assert.deepEqual(names(a.bodies.g).sort(), names(c.bodies.g).sort());
});

test("helical gear: the teeth turn by width × tan β / pitch radius; herringbone: there and back", async () => {
  const b = await make("cf-helical-gear", { bore: 0 });
  ok(b);
  const k = b.k, g = b.bodies.g, beta = (20 * Math.PI) / 180, r = (2 / Math.cos(beta)) * 10;
  near(radii(k, g)[1], r + 2, 1e-6);
  // the tip corner of tooth 1 at the bottom and at the top
  const corner = (z) => { let best = null; for (const v of k.sub(faceNamed(g, "g:t1:tip"), "vertex")) { const p = k.vertexPoint(v); if (Math.abs(p[2] - z) < 1e-6 && (!best || Math.atan2(p[1], p[0]) < Math.atan2(best[1], best[0]))) best = p; } return Math.atan2(best[1], best[0]); };
  near(corner(12) - corner(0), (12 * Math.tan(beta)) / r, 1e-6);
  const left = await make("cf-helical-gear", { bore: 0, left: true });
  const cl = (z) => { let best = null; for (const v of left.k.sub(faceNamed(left.bodies.g, "g:t1:tip"), "vertex")) { const p = left.k.vertexPoint(v); if (Math.abs(p[2] - z) < 1e-6 && (!best || Math.atan2(p[1], p[0]) < Math.atan2(best[1], best[0]))) best = p; } return Math.atan2(best[1], best[0]); };
  near(cl(12) - cl(0), -(12 * Math.tan(beta)) / r, 1e-6);
  // the volume is the transverse outline's area times the width, whatever the twist: a spur gear of the transverse module and pressure angle has that outline
  near(k.volume(g.shape), k.volume(left.bodies.g.shape), 1e-4);
  const keyed = await make("cf-helical-gear", { keyway: true, hubDiameter: 16, hubLength: 6 });
  ok(keyed);
  for (const n of ["g:key:floor", "g:bore", "g:hub:side"]) faceNamed(keyed.bodies.g, n);
  assert.ok(valid(keyed.k, keyed.bodies.g));

  const h = await make("cf-herringbone-gear", {});
  ok(h);
  assert.equal(names(h.bodies.g).length, 2 * 20 * 8 + 3);
  faceNamed(h.bodies.g, "g:t1:a:2");
  const tips = h.k.sub(faceNamed(h.bodies.g, "g:t1:tip"), "vertex").map((v) => h.k.vertexPoint(v));
  const at = (z) => tips.filter((p) => Math.abs(p[2] - z) < 1e-6).map((p) => Math.atan2(p[1], p[0])).sort((x, y) => x - y)[0];
  const top = h.k.sub(faceNamed(h.bodies.g, "g:t1:tip:2"), "vertex").map((v) => h.k.vertexPoint(v)).filter((p) => Math.abs(p[2] - 16) < 1e-6).map((p) => Math.atan2(p[1], p[0])).sort((x, y) => x - y)[0];
  near(top, at(0), 1e-6);
  const beta2 = (25 * Math.PI) / 180;
  near(at(8) - at(0), (8 * Math.tan(beta2)) / ((2 / Math.cos(beta2)) * 10), 1e-6);
});

test("internal gear and rack", async () => {
  const b = await make("cf-internal-gear", {});
  ok(b);
  const at = (name) => b.k.sub(faceNamed(b.bodies.g, name), "vertex").map((v) => { const p = b.k.vertexPoint(v); return Math.hypot(p[0], p[1]); });
  for (const r of at("g:t1:root")) near(r, 48 - 2, 1e-9);        // the ring's teeth reach one module inside the pitch circle
  for (const r of at("g:t1:tip")) near(r, 48 + 2.5, 1e-9);       // and their roots are 1.25 outside it
  near(radii(b.k, b.bodies.g)[1], 48 + 2.5 + 6, 1e-9);           // the rim
  faceNamed(b.bodies.g, "g:rim");
  assert.match((await make("cf-internal-gear", { teeth: 12, pressureAngle: 14.5 })).last.message, /more teeth/);

  const r = await make("cf-rack", {});
  ok(r);
  const e = extent(r.k, r.bodies.g);
  near(e[3] - e[0], 10 * Math.PI * 2, 1e-9); near(e[1], -(2.5 + 6), 1e-9); near(e[4], 2, 1e-9);
  // ten trapezoid teeth on a 6 mm base, 10 wide
  const tooth = 4.5 * (Math.PI + 0.5 * Math.tan((20 * Math.PI) / 180));
  near(r.k.volume(r.bodies.g.shape), (20 * Math.PI * 6 + 10 * tooth) * 10, 1e-9);
  const d = await make("cf-rack", { system: "dp", dp: 8, teeth: 3, pressureAngle: 14.5 });
  ok(d);
  near(extent(d.k, d.bodies.g)[3], (3 * Math.PI * 25.4) / 8, 1e-9);
});

test("a rack meshes with a spur gear whose pitch circle touches its pitch line", async () => {
  // gear of 20 teeth, module 2, standing at (π·m·5, 20): its tooth at −90° sits in the rack's gap at x = 5 pitches
  const b = await build([feature("r", "cf-rack", { backlash: 0.1 }), feature("g", "cf-spur-gear", { x: 5 * Math.PI * 2, y: 20, angle: -90, backlash: 0.1 })]);
  ok(b);
  assert.ok(shared(b.k, b.bodies.r, b.bodies.g) < 1e-3, "the gear and the rack overlap");
  // moved in by a fifth of a module they do
  const c = await build([feature("r", "cf-rack", { backlash: 0.1 }), feature("g", "cf-spur-gear", { x: 5 * Math.PI * 2, y: 19.6, angle: -90, backlash: 0.1 })]);
  assert.ok(shared(c.k, c.bodies.r, c.bodies.g) > 0.1);
});

test("planetary gear set: sun, planets and ring in mesh; impossible sets are refused", async () => {
  const b = await make("cf-planetary", {});
  ok(b);
  assert.deepEqual(b.list.map((x) => x.id), ["g:sun", "g:planet1", "g:planet2", "g:planet3", "g:ring"]);
  for (const [x, y] of [["g:sun", "g:planet1"], ["g:sun", "g:planet2"], ["g:planet3", "g:ring"], ["g:planet1", "g:ring"], ["g:planet1", "g:planet2"]]) {
    assert.ok(shared(b.k, b.bodies[x], b.bodies[y]) < 1e-3, `${x} and ${y} overlap`);
  }
  // they are engaged, not merely apart: the planet's tips are inside the sun's tip circle
  const a = (1.5 * (18 + 15)) / 2;
  assert.ok(a - radii(b.k, b.bodies["g:planet1"], a, 0)[1] < radii(b.k, b.bodies["g:sun"])[1] - 1);
  assert.match((await make("cf-planetary", { planets: 5 })).last.message, /cannot be spaced evenly.*divides by 2, 3, 6/);
  assert.match((await make("cf-planetary", { sunTeeth: 12, planetTeeth: 30, planets: 6 })).last.message, /run into each other/);
  const four = await make("cf-planetary", { sunTeeth: 12, planetTeeth: 18, planets: 4, backlash: 0.1 });
  ok(four);
  assert.equal(four.list.length, 6);
  assert.ok(shared(four.k, four.bodies["g:sun"], four.bodies["g:planet2"]) < 1e-3);
  assert.ok(shared(four.k, four.bodies["g:planet4"], four.bodies["g:ring"]) < 1e-3);
});

test("bevel gear: the cone from the tooth counts, the gear on the plane, and its mate in mesh", async () => {
  const b = await make("cf-bevel-gear", { mate: true });
  ok(b);
  const k = b.k, g = b.bodies.g, mate = b.bodies["g:mate"];
  const delta = Math.atan2(1, 30 / 20);
  near(radii(k, g)[1], 20 + 2 * Math.cos(delta), 1e-6);     // the tips at the large end
  near(extent(k, g)[2], 0, 1e-9);
  assert.ok(valid(k, g) && valid(k, mate));
  assert.ok(shared(k, g, mate) < 0.01, `the gears overlap by ${shared(k, g, mate)}`);
  assert.equal(names(g).filter((n) => /^g:t\d+:tip$/.test(n)).length, 20);
  assert.equal(names(mate).filter((n) => /^g:mate:t\d+:tip$/.test(n)).length, 30);
  // every flank is a piece of a cone through the apex: a tooth's tip at the small end is the large end's, scaled towards the apex
  const R = 20 / Math.sin(delta), apexZ = R * Math.cos(delta) + (2.5 + 2.5) * Math.sin(delta);
  for (const v of k.sub(faceNamed(g, "g:t1:tip"), "vertex")) {
    const p = k.vertexPoint(v), s = Math.hypot(p[0], p[1]);
    // the tip cone: its half angle is the pitch angle plus the addendum angle
    near(Math.atan2(s, apexZ - p[2]), delta + Math.atan(2 / R), 2e-3);
  }
  // a mitre pair with hubs
  const m = await make("cf-bevel-gear", { mate: true, teeth: 16, mateTeeth: 16, width: 6, hubDiameter: 16, hubLength: 6, backlash: 0.05 });
  ok(m);
  for (const n of ["g:hub", "g:hub:end", "g:bore", "g:back", "g:front"]) faceNamed(m.bodies.g, n);
  assert.ok(shared(m.k, m.bodies.g, m.bodies["g:mate"]) < 0.01);
  assert.match((await make("cf-bevel-gear", { width: 30 })).last.message, /face width must be less than/);
  assert.match((await make("cf-bevel-gear", { bore: 30 })).last.message, /bore .* leaves nothing/);
});

test("worm and wheel: lead, centre distance, hand, and the pair in mesh", async () => {
  const b = await make("cf-worm", {});
  ok(b);
  const k = b.k, worm = b.bodies["g:worm"], wheel = b.bodies["g:wheel"];
  // the worm lies along y at the centre distance, level with the middle of the wheel
  const e = tight(k, worm);
  within(e[4] - e[1], 30, 1e-3);
  const centres = 10 + 30;
  within((e[0] + e[3]) / 2, centres, 0.6); within((e[2] + e[5]) / 2, 7, 0.6);
  const gamma = Math.atan((Math.PI * 2) / (Math.PI * 20));
  near(radii(k, wheel)[1], 30 + 2 * Math.cos(gamma), 1e-6);
  assert.ok(shared(k, worm, wheel) < 0.05, `the worm and the wheel overlap by ${shared(k, worm, wheel)}`);
  // engaged: the worm's threads reach inside the wheel's tip circle
  assert.ok(centres - 12 < 30 + 2);
  const two = await make("cf-worm", { starts: 2, left: true, make: "worm", wormBore: 5, length: 20 });
  ok(two);
  assert.equal(names(two.bodies.g).filter((n) => /^g:s[12]:tip$/.test(n)).length, 2);
  faceNamed(two.bodies.g, "g:bore");
  // a wrong hand does not mesh: the same pair with the wheel's hand turned collides
  assert.match((await make("cf-worm", { diameter: 5 })).last.message, /pitch diameter must be more than/);
  assert.match((await make("cf-worm", { starts: 8, diameter: 12 })).last.message, /lead angle/);
});

test("cycloidal disc: the outline touches every pin and crosses none", async () => {
  const N = 11, R = 30, r = 2.5, e = 1.5;
  const pts = G.cycloidPoints(N, R, r, e, 600);
  let least = Infinity; const touched = new Set();
  for (const q of pts) for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N, d = Math.hypot(q[0] + e - R * Math.cos(a), q[1] - R * Math.sin(a)) - r;
    least = Math.min(least, d);
    if (d < 1e-4) touched.add(i);
  }
  assert.ok(least > -1e-9, `the disc cuts into a pin by ${-least}`);
  assert.ok(least < 1e-6);
  assert.ok(touched.size >= N - 2, `only ${touched.size} pins are touched`);
  const b = await make("cf-cycloidal", { withPins: true });
  ok(b);
  assert.ok(shared(b.k, b.bodies.g, b.bodies["g:pins"]) < 0.01);
  assert.equal(b.k.solids(b.bodies["g:pins"].shape).length, 11);
  for (const n of ["g:profile", "g:bore", "g:out5", "g:pins:p11:side"]) faceNamed(n.startsWith("g:pins") ? b.bodies["g:pins"] : b.bodies.g, n);
  assert.match((await make("cf-cycloidal", { eccentricity: 3 })).last.message, /eccentricity must be under 2\.73/);
  assert.match((await make("cf-cycloidal", { pinDiameter: 18 })).last.message, /pins overlap/);
  assert.match((await make("cf-cycloidal", { pinDiameter: 17, eccentricity: 2.5, outputs: 0, bore: 0 })).last.message, /crosses itself/);
  assert.match((await make("cf-cycloidal", { outputCircle: 26 })).last.message, /output holes run into the lobes/);
});

// ------------------------------------------------------------------ belts and chains

test("timing belt tooth profiles: the GT2 tooth is the published one", () => {
  const t = G.toothShape(G.BELTS.GT2.tooth);
  near(t.h, 0.75, 1e-12);
  // the flank arcs' centres lie on the tooth's base line: (r2 − r3)² = b² + (h − r3)² for the published radii
  near(Math.hypot(0.4, 0.75 - 0.555), 1.0 - 0.555, 2e-3);
  // the outline runs from land to land, symmetric, through the tooth's tip
  near(t.start[0], -t.w, 1e-12); near(t.segs[t.segs.length - 1].to[0], t.w, 1e-12);
  assert.ok(t.segs.some((s) => s.via && Math.abs(s.via[0]) < 1e-9 && Math.abs(s.via[1] + 0.75) < 1e-9));
  assert.ok(t.w > 0.6 && t.w < 0.9);
  for (const [name, b] of Object.entries(G.BELTS)) {
    const s = G.toothShape(b.tooth);
    assert.ok(2 * s.w < b.pitch, `${name}: the tooth is wider than the pitch`);
    const grown = G.toothShape(b.tooth, 0.1);
    assert.ok(grown.w > s.w && grown.h > s.h, name);
  }
});

test("timing pulley: pitch and outside diameters, flanges, bore and hub", async () => {
  const b = await make("cf-timing-pulley", {});
  ok(b);
  const k = b.k, g = b.bodies.g;
  const od = (20 * 2) / Math.PI - 2 * 0.254;
  // the lands of the teeth are on the outside diameter
  const lands = k.sub(faceNamed(g, "g:g1:land"), "vertex").map((v) => k.vertexPoint(v));
  for (const p of lands) near(Math.hypot(p[0], p[1]), od / 2, 1e-9);
  // both flanges stand 1.5 above the teeth; the toothed part is the belt's width and a millimetre
  near(k.faceFrame(faceNamed(g, "g:flange2:top")).origin[2], 1 + 7 + 1, 1e-9);
  for (const n of ["g:flange:rim", "g:flange:bottom", "g:flange2:rim", "g:bore", "g:g20:floor"]) faceNamed(g, n);
  // the groove's floor is the tooth height and the clearance below the outside diameter
  near(G.pulleyLoop("GT2", 20, 0.05).root, od / 2 - 0.8, 1e-12);
  const h = await make("cf-timing-pulley", { profile: "HTD5M", teeth: 24, flanges: "none", bore: 8, keyway: true, beltWidth: 15, hubDiameter: 20, hubLength: 8 });
  ok(h);
  near(radii(h.k, h.bodies.g)[1], (24 * 5) / Math.PI / 2 - 0.5715, 1e-9);
  near(extent(h.k, h.bodies.g)[5], 16 + 8, 1e-9);
  for (const n of ["g:key:floor", "g:hub:side", "g:g24:ra"]) faceNamed(h.bodies.g, n);
  const t5 = await make("cf-timing-pulley", { profile: "T5", teeth: 16, flanges: "one", bore: 8, hubDiameter: 16, hubLength: 6, beltWidth: 10 });
  ok(t5);
  assert.ok(valid(t5.k, t5.bodies.g));
  assert.match((await make("cf-timing-pulley", { bore: 12 })).last.message, /does not fit/);
});

test("timing belt: its length is a whole number of pitches round the two pitch circles", async () => {
  const b = await make("cf-timing-belt", {});
  ok(b);
  const body = b.bodies.g, m = /Belt 100T, centres ([\d.]+) mm/.exec(body.name);
  assert.ok(m, body.name);
  const c = Number(m[1]), r1 = 20 / Math.PI, r2 = 40 / Math.PI, beta = Math.asin((r2 - r1) / c);
  within(2 * c * Math.cos(beta) + r1 * (Math.PI - 2 * beta) + r2 * (Math.PI + 2 * beta), 200, 0.02);
  assert.equal(names(body).filter((n) => /^g:t\d+:floor$/.test(n)).length, 100);
  const e = extent(b.k, body);
  near(e[2], 1.5, 1e-9); near(e[5], 7.5, 1e-9);
  // the belt's teeth fit the grooves of a pulley of the same profile standing at its centre
  const pair = await build([feature("p", "cf-timing-pulley", { flanges: "none", bore: 3, clearance: 0.05 }), feature("g", "cf-timing-belt", { lift: 0.5 })]);
  ok(pair);
  assert.ok(shared(pair.k, pair.bodies.p, pair.bodies.g) < 0.02, `the belt and the pulley overlap by ${shared(pair.k, pair.bodies.p, pair.bodies.g)}`);
  const by = await make("cf-timing-belt", { profile: "HTD5M", sizeBy: "centres", centres: 120, teeth1: 24, teeth2: 24 });
  ok(by);
  // equal pulleys: length = 2·centres + one pulley's pitch circle; 120 mm asks for 72 teeth, which puts the centres exactly there
  assert.match(by.bodies.g.name, /Belt 72T, centres 120\.00 mm/);
  assert.match((await make("cf-timing-belt", { beltTeeth: 20 })).last.message, /too short .* at least/);
});

test("V-belt pulley: ISO 4183 grooves", async () => {
  const b = await make("cf-v-pulley", {});
  ok(b);
  const k = b.k, e = extent(k, b.bodies.g);
  near(e[3], 100 / 2 + 2.75, 1e-9);     // outside = pitch + 2 × b
  near(e[5], 18, 1e-9);                 // one groove: twice the edge distance
  // an A groove on a 100 mm pulley is 34°: its walls are 17° off the plane of the pulley
  const wall = k.sub(faceNamed(b.bodies.g, "g:g1:a"), "vertex").map((v) => k.vertexPoint(v));
  const dz = Math.abs(wall[0][2] - wall[wall.length - 1][2]), dr = Math.abs(Math.hypot(wall[0][0], wall[0][1]) - Math.hypot(wall[wall.length - 1][0], wall[wall.length - 1][1]));
  near(Math.atan2(dz, dr), (17 * Math.PI) / 180, 1e-6); near(dr, 2.75 + 8.7, 1e-9);
  const m = await make("cf-v-pulley", { section: "SPB", grooves: 3, pitchDiameter: 200, bore: 38, keyway: true, hubDiameter: 70, hubLength: 20 });
  ok(m);
  near(extent(m.k, m.bodies.g)[5], 2 * 19 + 2 * 12.5 + 20, 1e-9);
  // above 190 mm an SPB groove is 38°
  const w = m.k.sub(faceNamed(m.bodies.g, "g:g2:b"), "vertex").map((v) => m.k.vertexPoint(v));
  near(Math.atan2(Math.abs(w[0][2] - w[w.length - 1][2]), 17.5), (19 * Math.PI) / 180, 1e-6);
  near(m.k.faceFrame(faceNamed(m.bodies.g, "g:key:floor")).origin[1], 19 + 3.3, 1e-9);
  assert.match((await make("cf-v-pulley", { pitchDiameter: 30 })).last.message, /too small/);
});

test("chain sprocket: ISO 606 tooth form on the pitch circle", async () => {
  const s = G.sprocketLoop(12.7, 8.51, 18);
  near(s.pitchRadius, 12.7 / (2 * Math.sin(Math.PI / 18)), 1e-12);
  near(s.root, s.pitchRadius - 0.505 * 8.51, 1e-12);
  near(2 * s.tip, 2 * s.pitchRadius + (1 - 1.6 / 18) * 12.7 - 8.51, 1e-6);
  // a roller in its seat touches the seat's bottom and is clear of the flanks
  const seat = s.loop.segs.find((x) => x.label === "t1:seat");
  near(Math.hypot(seat.via[0] - s.pitchRadius, seat.via[1]), 0.505 * 8.51, 1e-9);
  const b = await make("cf-sprocket", {});
  ok(b);
  near(radii(b.k, b.bodies.g)[1], s.tip, 1e-6);
  near(extent(b.k, b.bodies.g)[5], 7.21, 1e-9);     // 0.93 × 7.75
  const roller = await build([feature("g", "cf-sprocket", {}), feature("c", "cf-chain", { teeth1: 18, teeth2: 18, links: 40, plates: false, lift: 3.6 })]);
  ok(roller);
  assert.ok(shared(roller.k, roller.bodies.g, roller.bodies.c) < 1e-3, "the chain's rollers cut into the sprocket");
  const small = await make("cf-sprocket", { chain: "40", teeth: 9, keyway: true, hubDiameter: 22, hubLength: 10 });
  ok(small);
  for (const n of ["g:key:floor", "g:hub:side", "g:t9:a"]) faceNamed(small.bodies.g, n);
  assert.equal((await make("cf-sprocket", { thickness: 9 })).last.status, "warning");
});

test("roller chain: links one pitch apart, closed, at the centre distance the name gives", async () => {
  const b = await make("cf-chain", {});
  ok(b);
  const k = b.k, body = b.bodies.g;
  // equal sprockets of 18 and 40 links: seated, 11 pitches between centres; drawn on the tangents, within a few hundredths of that
  const centresOf = /Chain 08B, 40 links, centres ([\d.]+) mm/.exec(body.name);
  assert.ok(centresOf, body.name);
  within(Number(centresOf[1]), 11 * 12.7, 0.05);
  assert.equal(k.solids(body.shape).length, 40 * 3);
  // the rollers' axes are one pitch apart all the way round
  const centres = [];
  for (let i = 1; i <= 40; i++) { const c = k.centre(faceNamed(body, `g:r${i}:side`), "face"); centres.push(c); }
  for (let i = 0; i < 40; i++) { const a = centres[i], n = centres[(i + 1) % 40]; near(Math.hypot(n[0] - a[0], n[1] - a[1]), 12.7, 1e-6); }
  const u = await make("cf-chain", { sizeBy: "centres", centres: 200, teeth2: 36, plates: false });
  ok(u);
  const m = /(\d+) links, centres ([\d.]+) mm/.exec(u.bodies.g.name);
  assert.equal(Number(m[1]) % 2, 0);
  within(Number(m[2]), 200, 6.4);
  const cs = []; for (let i = 1; i <= Number(m[1]); i++) cs.push(u.k.centre(faceNamed(u.bodies.g, `g:r${i}:side`), "face"));
  for (let i = 0; i < cs.length; i++) { const a = cs[i], n = cs[(i + 1) % cs.length]; near(Math.hypot(n[0] - a[0], n[1] - a[1]), 12.7, 1e-6); }
  assert.match((await make("cf-chain", { links: 12 })).last.message, /too short/);
  assert.equal((await make("cf-chain", { links: 41, plates: false })).last.status, "warning");
});

// ------------------------------------------------------------------ mechanisms

test("ratchet and pawl", async () => {
  const b = await make("cf-ratchet", {});
  ok(b);
  const k = b.k, w = b.bodies.g, pawl = b.bodies["g:pawl"];
  assert.equal(names(w).length, 2 * 16 + 3);
  const [lo, hi] = radii(k, w);
  near(hi, 25, 1e-9); near(lo, 4, 1e-9);     // the tips, and the bore's seam
  assert.ok(shared(k, w, pawl) < 1e-6, "the pawl cuts into the wheel");
  // the pawl's nose is within a tenth of a millimetre of the tooth's face
  const nose = k.centre(faceNamed(pawl, "g:pawl:nose"), "face"), face = k.centre(faceNamed(w, "g:t1:face"), "face");
  assert.ok(Math.hypot(nose[0] - face[0], nose[1] - face[1]) < 1.5);
  faceNamed(pawl, "g:pawl:pivot");
  const r = await make("cf-ratchet", { reverse: true, teeth: 8, rake: 0, keyway: true, pawl: false });
  ok(r);
  assert.equal(r.list.length, 1);
  assert.match((await make("cf-ratchet", { toothHeight: 30 })).last.message, /too tall/);
});

test("Geneva wheel and crank: the proportions, and the pair free of each other mid-step", async () => {
  const b = await make("cf-geneva", {});
  ok(b);
  const k = b.k, w = b.bodies.g, crank = b.bodies["g:crank"];
  near(radii(k, w)[1], 50 * Math.cos(Math.PI / 6), 1e-9);
  assert.equal(names(w).filter((n) => /^g:slot\d:end$/.test(n)).length, 6);
  assert.equal(names(w).filter((n) => /^g:lock\d$/.test(n)).length, 6);
  assert.ok(shared(k, w, crank) < 1e-6);
  // the pin stands on the crank's radius c·sin(π/n) from its axis, on the line of centres
  const pin = k.centre(faceNamed(crank, "g:crank:pin:top"), "face");
  near(pin[0], 50 - 50 * Math.sin(Math.PI / 6), 1e-6); near(pin[1], 0, 1e-6);
  // a slot is the pin and twice the clearance wide
  const a = k.faceFrame(faceNamed(w, "g:slot1:a")), bb = k.faceFrame(faceNamed(w, "g:slot1:b"));
  near(Math.abs(a.origin[1] - bb.origin[1]), 5.4, 1e-9);
  const four = await make("cf-geneva", { slots: 4, pin: 4, crank: false });
  ok(four);
  assert.equal(four.list.length, 1);
  assert.match((await make("cf-geneva", { pin: 14 })).last.message, /pin is too thick/);
});

test("plate cam: the lift at every angle follows the motion law; a roller follower's cam is smaller by the roller", async () => {
  const b = await make("cf-cam", {});
  ok(b);
  const k = b.k, oc = k.oc, g = b.bodies.g;
  // sample the profile's edge at the bottom: radius = base + lift(angle), cycloidal rise over 90°, dwell 60°, fall 90°
  const edge = k.sub(faceNamed(g, "g:profile"), "edge").find((e) => Math.abs(k.centre(e, "edge")[2]) < 1e-9 && !k.sub(e, "vertex").some((v) => Math.abs(k.vertexPoint(v)[2]) > 1e-9));
  const ad = new oc.BRepAdaptor_Curve(edge);
  const cyc = (s) => s - Math.sin(2 * Math.PI * s) / (2 * Math.PI);
  let worst = 0, top = 0;
  for (let i = 0; i < 400; i++) {
    const p = ad.Value(ad.FirstParameter() + ((ad.LastParameter() - ad.FirstParameter()) * i) / 400), r = Math.hypot(p.X(), p.Y());
    let deg = (Math.atan2(p.Y(), p.X()) * 180) / Math.PI; if (deg < 0) deg += 360;
    const lift = deg < 90 ? 8 * cyc(deg / 90) : deg < 150 ? 8 : deg < 240 ? 8 * (1 - cyc((deg - 150) / 90)) : 0;
    worst = Math.max(worst, Math.abs(r - 20 - lift)); top = Math.max(top, r);
    p.delete();
  }
  ad.delete();
  assert.ok(worst < 0.01, `the profile is ${worst} mm off the lift curve`);
  near(top, 28, 1e-3);
  const roller = await make("cf-cam", { follower: "roller", roller: 10, law: "harmonic", keyway: true });
  ok(roller);
  // on the base circle and on the dwell the cam is the pitch curve less the roller's radius
  assert.ok(roller.k.volume(roller.bodies.g.shape) < k.volume(g.shape) * 0.7);
  faceNamed(roller.bodies.g, "g:key:floor");
  const table = await make("cf-cam", { profile: "table", table: "0: 0, 90: 8, 180: 8, 270: 0" });
  ok(table);
  assert.deepEqual(G.parseLiftTable("90 8; 0:0, 180=8").rows, [[0, 0], [90, 8], [180, 8]]);
  assert.match(G.parseLiftTable("0:0, x:1").error, /not an angle and a lift/);
  assert.match((await make("cf-cam", { profile: "table", table: "0:0, 400:3, 90:1" })).last.message, /must be from 0/);
  assert.match((await make("cf-cam", { follower: "roller", roller: 60 })).last.message, /roller cannot follow/);
  assert.match((await make("cf-cam", { rise: 200, fall: 200 })).last.message, /must fit in 360/);
});

// ------------------------------------------------------------------ shafts

test("stepped shaft from a table of steps", async () => {
  assert.deepEqual(G.parseSteps("20 x 30, Ø25×50; 20*30").steps, [[20, 30], [25, 50], [20, 30]]);
  assert.match(G.parseSteps("20 x").error, /not a diameter and a length/);
  const b = await make("cf-stepped-shaft", { steps: "20 x 30, 30 x 10", chamfer: 0, fillet: 0 });
  ok(b);
  near(b.k.volume(b.bodies.g.shape), Math.PI * (100 * 30 + 225 * 10), 1e-9);
  assert.deepEqual(names(b.bodies.g).sort(), ["g:end", "g:shoulder1", "g:start", "g:step1", "g:step2"]);
  const d = await make("cf-stepped-shaft", {});
  ok(d);
  near(extent(d.k, d.bodies.g)[5], 30 + 50 + 8 + 40 + 30, 1e-9);
  for (const n of ["g:chamfer:start", "g:chamfer:end", "g:fillet1", "g:fillet4", "g:shoulder3", "g:step5"]) faceNamed(d.bodies.g, n);
  // a hole through, and a fillet in each inside corner (the corner keeps material: more volume than without)
  const plain = await make("cf-stepped-shaft", { steps: "10x20; 30x5; 12 x 40", bore: 4, chamfer: 0, fillet: 0 });
  const fil = await make("cf-stepped-shaft", { steps: "10x20; 30x5; 12 x 40", bore: 4, chamfer: 0, fillet: 2 });
  near(plain.k.volume(plain.bodies.g.shape), Math.PI * (25 * 20 + 225 * 5 + 36 * 40 - 4 * 65), 1e-9);
  assert.ok(fil.k.volume(fil.bodies.g.shape) > plain.k.volume(plain.bodies.g.shape));
  faceNamed(fil.bodies.g, "g:bore");
  assert.match((await make("cf-stepped-shaft", { steps: "abc" })).last.message, /not a diameter and a length/);
  assert.match((await make("cf-stepped-shaft", { steps: "10 x 20", bore: 12 })).last.message, /does not fit/);
});

test("keyway: DIN 6885 by the diameter, in a shaft and in a bore", async () => {
  assert.deepEqual([G.keyFor(20).b, G.keyFor(20).t1, G.keyFor(20).t2], [6, 3.5, 2.8]);
  assert.deepEqual([G.keyFor(22).b, G.keyFor(22.01).b, G.keyFor(8).b, G.keyFor(8.5).b], [6, 8, 2, 3]);
  assert.equal(G.keyFor(5), null);
  const b = await make("cf-keyway", { face: on("sh:step1") }, [shaft("20 x 60")]);
  ok(b);
  const k = b.k, sh = b.bodies.sh;
  // the keyseat's floor is t1 below the surface; its sides are the key's width apart; it is 20 long, 5 from the end, round-ended
  near(Math.hypot(...k.faceFrame(faceNamed(sh, "g:floor")).origin), 10 - 3.5, 1e-9);
  const fa = k.faceFrame(faceNamed(sh, "g:a")), fb = k.faceFrame(faceNamed(sh, "g:b"));
  near(Math.hypot(fa.origin[0] - fb.origin[0], fa.origin[1] - fb.origin[1], fa.origin[2] - fb.origin[2]), 6, 1e-9);
  const zs = k.sub(faceNamed(sh, "g:floor"), "vertex").map((v) => k.vertexPoint(v)[2]);
  near(Math.min(...zs), 5 + 3, 1e-9); near(Math.max(...zs), 25 - 3, 1e-9);
  const removed = Math.PI * 100 * 60 - k.volume(sh.shape);
  assert.ok(removed > 6 * 14 * 3 && removed < 6 * 20 * 3.5 + 20);
  // in a bore: the hub's keyway, t2 deep, right through
  const h = await make("cf-keyway", { face: on("sh:bore"), length: 0 }, [shaft("40 x 30", { bore: 20 })]);
  ok(h);
  near(Math.hypot(...h.k.faceFrame(faceNamed(h.bodies.sh, "g:floor")).origin), 10 + 2.8, 1e-9);
  // the slot's section: 6 wide, from the bore's wall out to 12.8 from the axis
  const slot = 12.8 * 6 - (3 * Math.sqrt(91) + 100 * Math.asin(0.3));
  near(Math.PI * (400 - 100) * 30 - h.k.volume(h.bodies.sh.shape), slot * 30, 1e-6);
  // from the other end, turned a quarter, square ends, custom size
  const c = await make("cf-keyway", { face: on("sh:step1"), size: "custom", width: 4, depth: 2, flip: true, angle: 90, ends: "square", offset: 0, length: 10 }, [shaft("20 x 60")]);
  ok(c);
  const zz = c.k.sub(faceNamed(c.bodies.sh, "g:floor"), "vertex").map((v) => c.k.vertexPoint(v)[2]);
  near(Math.min(...zz), 50, 1e-9); near(Math.max(...zz), 60, 1e-9);
  assert.match((await make("cf-keyway", { face: on("sh:step1") }, [shaft("5 x 20")])).last.message, /over 6 mm up to 150 mm; this face is 5\.00 mm/);
});

test("D-cut: a flat by the height across it, and a double D", async () => {
  const b = await make("cf-d-cut", { face: on("sh:step1") }, [shaft("5 x 24")]);
  ok(b);
  const k = b.k, sh = b.bodies.sh;
  near(Math.hypot(...k.faceFrame(faceNamed(sh, "g:flat")).origin.slice(0, 2)), 2.0, 1e-9);     // 4.5 across a 5 mm shaft
  near(k.faceFrame(faceNamed(sh, "g:shoulder")).origin[2], 10, 1e-9);
  const segment = 6.25 * Math.acos(0.8) - 2 * 1.5;
  near(Math.PI * 6.25 * 24 - k.volume(sh.shape), segment * 10, 1e-6);
  const d = await make("cf-d-cut", { face: on("sh:step1"), double: true, across: 4, length: 0 }, [shaft("5 x 24")]);
  ok(d);
  const f1 = d.k.faceFrame(faceNamed(d.bodies.sh, "g:flat")), f2 = d.k.faceFrame(faceNamed(d.bodies.sh, "g:flat2"));
  near(Math.hypot(f1.origin[0] - f2.origin[0], f1.origin[1] - f2.origin[1]), 4, 1e-9);
  near(Math.PI * 6.25 * 24 - d.k.volume(d.bodies.sh.shape), 2 * segment * 24, 1e-6);
  assert.match((await make("cf-d-cut", { face: on("sh:step1"), across: 6 }, [shaft("5 x 24")])).last.message, /must be less/);
  assert.match((await make("cf-d-cut", { face: on("sh:bore") }, [shaft("20 x 24", { bore: 5 })])).last.message, /wall of a hole/);
});

test("retaining ring groove: DIN 471 on a shaft, DIN 472 in a bore", async () => {
  const b = await make("cf-ring-groove", { face: on("sh:step1") }, [shaft("20 x 60")]);
  ok(b);
  near(Math.PI * 100 * 60 - b.k.volume(b.bodies.sh.shape), Math.PI * (100 - 9.5 * 9.5) * 1.3, 1e-6);     // Ø20: groove Ø19 × 1.3
  near(b.k.faceFrame(faceNamed(b.bodies.sh, "g:a")).origin[2], 2, 1e-9);
  const h = await make("cf-ring-groove", { face: on("sh:bore"), flip: true }, [shaft("40 x 30", { bore: 22 })]);
  ok(h);
  near(Math.PI * (400 - 121) * 30 - h.k.volume(h.bodies.sh.shape), Math.PI * (11.5 * 11.5 - 121) * 1.1, 1e-6);     // Ø22 bore: groove Ø23 × 1.1
  near(h.k.faceFrame(faceNamed(h.bodies.sh, "g:a")).origin[2], 28, 1e-9);
  assert.match((await make("cf-ring-groove", { face: on("sh:step1") }, [shaft("20.5 x 60")])).last.message, /DIN 471 has no ring for a shaft of 20\.50 mm \(the nearest is 20 mm\)/);
  assert.equal((await make("cf-ring-groove", { face: on("sh:step1"), offset: 0.5 }, [shaft("20 x 60")])).last.status, "warning");
  const c = await make("cf-ring-groove", { face: on("sh:step1"), size: "custom", grooveDiameter: 18, width: 2, offset: 4 }, [shaft("20.5 x 60")]);
  ok(c);
  // the tables: a groove is always below the shaft and above the bore
  for (const [d1, d2, m] of G.RINGS_SHAFT) assert.ok(d2 < d1 && d2 > d1 * 0.9 && m > 0.4 && m < 3.2);
  for (const [d1, d2, m] of G.RINGS_BORE) assert.ok(d2 > d1 && d2 < d1 * 1.1 && m > 0.8 && m < 3.2);
});

test("bearing seat by bearing number, and the bearing", async () => {
  assert.deepEqual([...G.BEARINGS["608"]], [8, 22, 7]); assert.deepEqual([...G.BEARINGS["6204"]], [20, 47, 14]); assert.deepEqual([...G.BEARINGS["6001"]], [12, 28, 8]);
  for (const [n, [d, D, B]] of Object.entries(G.BEARINGS)) assert.ok(d < D && B < D && B >= 3, n);
  const top = { kind: "face", ref: on("sh:end") };
  const b = await make("cf-bearing-seat", { plane: top }, [shaft("40 x 20")]);
  ok(b);
  // a 608: Ø22 × 7 deep, then Ø15 through the remaining 13
  near(Math.PI * 400 * 20 - b.k.volume(b.bodies.sh.shape), Math.PI * (121 * 7 + 56.25 * 13), 1e-6);
  near(b.k.faceFrame(faceNamed(b.bodies.sh, "g:shoulder")).origin[2], 13, 1e-9);
  faceNamed(b.bodies.sh, "g:seat"); faceNamed(b.bodies.sh, "g:through");
  const both = await make("cf-bearing-seat", { plane: top, make: "both", bearing: "6001", through: "none", fit: 0.1 }, [shaft("40 x 20")]);
  ok(both);
  near(Math.PI * 400 * 20 - both.k.volume(both.bodies.sh.shape), Math.PI * 14.05 * 14.05 * 8, 1e-6);
  const bearing = both.bodies["g:bearing"], e = extent(both.k, bearing);
  near(e[2], 12, 1e-9); near(e[5], 20, 1e-9); near(e[3], 14, 1e-9);
  assert.ok(shared(both.k, both.bodies.sh, bearing) < 1e-6, "the bearing does not go into its seat");
  near(radii(both.k, bearing)[0], 6, 1e-9);
  assert.match((await make("cf-bearing-seat", { plane: top, throughDiameter: 30 }, [shaft("40 x 20")])).last.message, /smaller than the bearing/);
});

test("spline: involute and straight-sided, as a shaft and as a hub's bore", async () => {
  const b = await make("cf-spline", {});
  ok(b);
  const [lo, hi] = radii(b.k, b.bodies.g);
  near(hi, 10 + 0.5, 1e-9); near(lo, 10 - 0.6, 1e-9);     // DIN 5480 proportions on module 1, 20 teeth
  const s = await make("cf-spline", { kind: "straight" });
  ok(s);
  // 6 × 23 × 26, keys 6 wide: the area is the small circle plus six key ends
  const keyEnd = (R) => R * R * Math.asin(3 / R) + 3 * Math.sqrt(R * R - 9);     // the area between a chord 6 wide's two sides, from the axis out to the circle
  near(s.k.volume(s.bodies.g.shape) / 25, Math.PI * 11.5 * 11.5 + 6 * (keyEnd(13) - keyEnd(11.5)), 1e-6);
  const top = { kind: "face", ref: on("sh:end") };
  const hub = await make("cf-spline", { kind: "straight", operation: "remove", plane: top, clearance: 0, length: 30 }, [shaft("40 x 20")]);
  ok(hub);
  near(Math.PI * 400 * 20 - hub.k.volume(hub.bodies.sh.shape), (s.k.volume(s.bodies.g.shape) / 25) * 20, 1e-6);
  faceNamed(hub.bodies.sh, "g:k3:top");
  const loose = await make("cf-spline", { kind: "straight", operation: "remove", plane: top, clearance: 0.1, length: 30 }, [shaft("40 x 20")]);
  assert.ok(loose.k.volume(loose.bodies.sh.shape) < hub.k.volume(hub.bodies.sh.shape) - 10);
  const custom = await make("cf-spline", { kind: "straight", size: "custom", keys: 4, minor: 16, major: 20, keyWidth: 5 });
  ok(custom);
  near(radii(custom.k, custom.bodies.g)[1], 10, 1e-9);
  assert.match((await make("cf-spline", { kind: "straight", size: "custom", keys: 12, minor: 16, major: 20, keyWidth: 5 })).last.message, /wider than the gaps/);
});

// ------------------------------------------------------------------ springs

test("compression spring: free length, diameters, ends", async () => {
  const b = await make("cf-compression-spring", {});
  ok(b);
  const k = b.k, e = tight(k, b.bodies.g);
  within(e[2], 0, 1e-3); within(e[5], 40, 1e-3);          // the free length, over closed ends
  within(e[3], 8, 5e-3); within(e[0], -8, 5e-3);          // 16 outside
  // the wire's length: two end coils and six active ones on the mean diameter, the active ones climbing
  const coil = 2 * Math.PI * 7.2, pitch = (40 - 1.6 - 2 * 1.632) / 6;
  within(k.volume(b.bodies.g.shape) / (Math.PI * 0.64), 2 * coil + 6 * Math.hypot(coil, pitch), 6);
  const open = await make("cf-compression-spring", { ends: "open", left: true, coils: 10, diameterIs: "mean" });
  ok(open);
  const eo = tight(open.k, open.bodies.g);
  within(eo[5] - eo[2], 40, 0.01); within(eo[3], 8.8, 5e-3);     // an open end is cut square to the wire, a hair short of the full height
  within(open.k.volume(open.bodies.g.shape) / (Math.PI * 0.64), 10 * Math.hypot(2 * Math.PI * 8, 3.84), 2);
  const ground = await make("cf-compression-spring", { ends: "ground" });
  ok(ground);
  near(ground.k.faceFrame(faceNamed(ground.bodies.g, "g:ground:start")).origin[2], 0, 1e-9);
  near(Math.abs(ground.k.faceFrame(faceNamed(ground.bodies.g, "g:ground:end")).origin[2]), 40, 1e-9);
  assert.ok(valid(ground.k, ground.bodies.g));
  assert.match((await make("cf-compression-spring", { length: 12 })).last.message, /14\.4 mm long when solid/);
  assert.match((await make("cf-compression-spring", { wire: 6 })).last.message, /too tight for this wire/);
});

test("extension and torsion springs", async () => {
  const b = await make("cf-extension-spring", {});
  ok(b);
  const e = tight(b.k, b.bodies.g);
  within(e[2], 0, 1e-3);
  // ten close-wound coils between two hooks of the coil's own radius
  const body = 10 * 1.2 * 1.02, hooks = 2 * (4.4 + 0.9);
  within(e[5], body + hooks + 1.2, 0.02);
  within(e[3], 5, 5e-3); within(e[0], -5, 5e-3);
  // inside the hooks: the body, and each hook's inner radius and lift
  assert.match(b.bodies.g.name, /Extension spring, 21\.6 mm inside the hooks/);
  const plain = await make("cf-extension-spring", { hooks: false, coils: 20, left: true });
  ok(plain);
  within(tight(plain.k, plain.bodies.g)[5], 20 * 1.224 + 1.2, 1e-3);
  within(plain.k.volume(plain.bodies.g.shape) / (Math.PI * 0.36), 20 * 2 * Math.PI * 4.4, 3);

  const t = await make("cf-torsion-spring", {});
  ok(t);
  // 5.25 coils on a 10.8 mean diameter and two 20 mm legs
  within(t.k.volume(t.bodies.g.shape) / (Math.PI * 0.36), 5.25 * 2 * Math.PI * 5.4 + 40, 1);
  // the legs are tangent: the first runs back along −y from (5.4, 0), the second (a quarter turn on) along −x from (0, 5.4)
  const et = tight(t.k, t.bodies.g);
  within(et[1], -20, 0.06); within(et[0], -20, 0.06); within(et[3], 6, 0.02); within(et[4], 6, 0.02);
  const one = await make("cf-torsion-spring", { coils: 3.5, leg1: 0, left: true });
  ok(one);
  assert.match((await make("cf-torsion-spring", { coils: 0.5 })).last.message, /from 1 to 100/);
});
