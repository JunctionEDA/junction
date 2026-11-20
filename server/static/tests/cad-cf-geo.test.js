// Node test for the "Patterns & texture" and "Geometry & utilities" custom features of the part studio
// (web/domains/mechanical/features/cf-geo-*.ts, features/_cf-geo*.ts, kernel/ops/cf-geo*.ts).  The real
// OpenCascade build runs here: every feature is built with its defaults and with one other setting.
// Run: node server/static/tests/cad-cf-geo.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));
const { load } = require("./cad-load");

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const bundle = esbuild.buildSync({ entryPoints: [path.join(server, "web", "domains", "mechanical", "kernel", "index.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
const K = M.exports;
const G = load("domains/mechanical/features/_cf-geo.ts");

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

// ---- document helpers
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [`${p}`]: { type: "circle", center: `${p}c`, r } });
const top = { kind: "plane", plane: "top" }, front = { kind: "plane", plane: "front" }, right = { kind: "plane", plane: "right" };
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const feature = (id, type, params) => ({ id, type, name: id, suppressed: false, params });
const def = (type) => K.FEATURES.find((f) => f.type === type);
/** A feature with its defaults, and what is given laid over them. */
const cf = (id, type, o = {}) => feature(id, type, { ...def(type).defaults(), ...o });
const datum = (f) => ({ kind: "datum", feature: f });
const face = (body, name) => ({ kind: "face", body, name });

/** A 100 × 60 × 5 plate. */
const slab = () => [sketch("s1", rect(0, 0, 100, 60, "p")), extrude("e1", "s1", { depth: 5 })];
const TOP = face("e1", "e1:end:pa");
/** The plate with one Ø4 hole at (x, y), cut by its own extrude. */
const plate = (x = 10, y = 10) => [...slab(), sketch("s2", circle(x, y, 2, "h"), top), extrude("cut", "s2", { operation: "remove", depth: 5 })];
const HOLE = Math.PI * 4 * 5, SLAB = 100 * 60 * 5;
/** A Ø40 × 60 cylinder standing on Top, its axis through the origin. */
const post = () => [sketch("s1", circle(0, 0, 20, "c")), extrude("e1", "s1", { depth: 60 })];
const SIDE = face("e1", "e1:side:c");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));
const built = (r) => assert.ok(r.features.every((f) => f.status === "ok" || f.status === "warning"), statuses(r).join("\n"));
const report = (r, id) => r.features.find((f) => f.id === id);
const failsWith = (r, id, re) => { const f = report(r, id); assert.equal(f.status, "error", statuses(r).join("\n")); assert.match(f.message, re); };

async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const t0 = Date.now();
  const r = await engine.regenerate(features, features.length);
  return { k, engine, r, ms: Date.now() - t0 };
}
const bodies = (e) => e.state.bodies;
const body = (e, id) => (id ? bodies(e).find((b) => b.id === id) : bodies(e)[0]);
const vol = (k, e, id) => k.volume(body(e, id).shape);
const box = (k, e, id) => { const b = body(e, id).mesh || null; void b; const oc = k.oc; const bb = new oc.Bnd_Box(); oc.BRepBndLib.AddOptimal(body(e, id).shape, bb, false, false); const out = [bb.GetXMin(), bb.GetYMin(), bb.GetZMin(), bb.GetXMax(), bb.GetYMax(), bb.GetZMax()].map((v) => Math.round(v * 1e6) / 1e6); bb.delete(); return out; };
const faces = (e, id) => body(e, id).topo.faces.map((f) => f.name);
const ms = (r, id) => report(r, id).ms;

const TYPES = ["attractor-pattern", "fill-pattern", "surface-pattern", "scatter-pattern", "phyllotaxis-pattern", "voronoi", "halftone", "texture", "text", "text-on-curve", "qr-code", "lithophane",
  "equation-curve", "point-curve", "airfoil", "tube", "cable", "spiral", "stock", "centre-of-mass", "measure", "convex-hull", "hollow", "auto-fillet", "slice", "scale"];

test("the features are registered, in the Custom features section with their family", () => {
  for (const t of TYPES) {
    const d = def(`cf-geo-${t}`);
    assert.ok(d, t);
    assert.equal(d.toolbarSection, "library");
    assert.ok(["Patterns & texture", "Geometry & utilities"].includes(d.toolbarMenu), t);
    assert.equal(d.toolbarKeep, 0);
    assert.ok(d.icon && d.hint && d.keywords, `${t} has an icon, a hint and search words`);
    assert.doesNotThrow(() => JSON.stringify(d.defaults()));
  }
  const icons = TYPES.map((t) => def(`cf-geo-${t}`).icon);
  assert.equal(new Set(icons).size, icons.length, "every icon is its own");
});

// ---------------------------------------------------------------- patterns

test("fill pattern: a hex lattice of a hole over the plate, clear of the edges", async () => {
  const { k, engine, r, ms: t } = await run([...plate(50, 30), cf("fp", "cf-geo-fill-pattern", { features: ["cut"], face: TOP, spacing: 10, margin: 6 })]);
  allOk(r);
  // rows 8.66 apart through y = 30: y = 12.7 … 47.3 (5 rows); x from 6 to 94: 9 in the row of the hole, 8 or 9 in the others
  const sites = G.lattice("hex", 10, 10, 0, [50, 30], [0, 0, 100, 60]).filter((s) => G.inRegion([[[0, 0], [100, 0], [100, 60], [0, 60]]], s.at, 6));
  assert.equal(sites.length, 43);
  near(vol(k, engine), SLAB - 43 * HOLE, 1e-6);
  assert.ok(faces(engine).includes("fp:g1.0:cut:side:h") && faces(engine).includes("fp:g-4.-2:cut:side:h"), "copies are named by their place");
  assert.ok(t < 4000, `${t} ms`);
  // a grid at an angle, with its own row spacing: fewer copies, the same hole each
  const g = await run([...plate(50, 30), cf("fp", "cf-geo-fill-pattern", { features: ["cut"], face: TOP, layout: "grid", spacing: 12, spacing2: 15, angle: 30, margin: 5 })]);
  allOk(g.r);
  const n = Math.round((SLAB - vol(g.k, g.engine)) / HOLE);
  near(vol(g.k, g.engine), SLAB - n * HOLE, 1e-6);
  assert.ok(n > 15 && n < 43, String(n));
  const bad = await run([...plate(), cf("fp", "cf-geo-fill-pattern", { features: ["cut"], face: face("e1", "e1:side:pa"), spacing: 0 })]);
  failsWith(bad.r, "fp", /spacing must be more than zero/);
});

test("attractor pattern: copies shrink towards a point and are left out when too small", async () => {
  const base = [...plate(10, 10), feature("pt", "point", { method: "coordinates", ref: null, x: 10, y: 10, z: 2.5 })];
  const p = { features: ["cut"], direction: right, spacing: 10, count: 8, direction2: front, spacing2: -10, count2: 4, attractor: datum("pt"), reach: 60, sizeNear: 0.2, sizeFar: 1.5, cull: 0 };
  const { k, engine, r } = await run([...base, cf("ap", "cf-geo-attractor-pattern", p)]);
  allOk(r);
  let want = HOLE;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) {
    if (!i && !j) continue;
    const s = 0.2 + 1.3 * Math.min(1, Math.hypot(10 * i, 10 * j) / 60);
    want += Math.PI * (2 * s) ** 2 * 5;   // the hole grown about its own middle still goes through the plate
  }
  near(vol(k, engine), SLAB - want, 1e-5);
  // turning does nothing to a round hole; leaving out the small ones does
  const c = await run([...base, cf("ap", "cf-geo-attractor-pattern", { ...p, angleNear: 90, ease: "smooth", cull: 0.6 })]);
  allOk(c.r);
  let kept = 0;
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) { const t = Math.min(1, Math.hypot(10 * i, 10 * j) / 60); if ((i || j) && 0.2 + 1.3 * t * t * (3 - 2 * t) >= 0.6) kept++; }
  assert.equal(faces(c.engine).filter((n) => /^ap:i/.test(n)).length, kept);
  failsWith((await run([...base, cf("ap", "cf-geo-attractor-pattern", { ...p, direction2: right })])).r, "ap", /parallel/);
});

test("scatter pattern: the same seed gives the same scatter, nothing closer than the spacing", async () => {
  const p = { features: ["cut"], face: TOP, count: 25, spacing: 8, margin: 5, seed: 3 };
  const a = await run([...plate(50, 30), cf("sc", "cf-geo-scatter-pattern", p)]);
  allOk(a.r);
  near(vol(a.k, a.engine), SLAB - 26 * HOLE, 1e-6);
  const b = await run([...plate(50, 30), cf("sc", "cf-geo-scatter-pattern", p)]);
  near(vol(b.k, b.engine), vol(a.k, a.engine), 1e-12);
  assert.deepEqual(faces(a.engine), faces(b.engine));
  const sites = G.scatter([[[0, 0], [100, 0], [100, 60], [0, 60]]], 25, 8, 5, G.rng(3), [[50, 30]]);
  for (let i = 0; i < sites.length; i++) {
    assert.ok(sites[i][0] >= 5 && sites[i][0] <= 95 && sites[i][1] >= 5 && sites[i][1] <= 55);
    assert.ok(Math.hypot(sites[i][0] - 50, sites[i][1] - 30) >= 8);
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(sites[i][0] - sites[j][0], sites[i][1] - sites[j][1]) >= 8);
  }
  // another seed, sizes at random: a different plate, and a note when not all fit
  const c = await run([...plate(50, 30), cf("sc", "cf-geo-scatter-pattern", { ...p, seed: 4, count: 400, spacing: 9, sizeMin: 0.5, sizeMax: 1.5, turn: 90 })]);
  assert.equal(report(c.r, "sc").status, "warning");
  assert.match(report(c.r, "sc").message, /Only \d+ of 400 copies fit/);
  assert.ok(vol(c.k, c.engine) < SLAB - 10 * HOLE);
});

test("Fibonacci pattern: place n is at spacing·√n and the golden angle times n", async () => {
  const { k, engine, r } = await run([...plate(50, 30), sketch("s3", circle(50, 30, 1, "k"), top),
    cf("ph", "cf-geo-phyllotaxis-pattern", { features: ["cut"], axis: { kind: "sketch", feature: "s3", entity: "k" }, count: 30, spacing: 4.5 })]);
  allOk(r);
  near(vol(k, engine), SLAB - 30 * HOLE, 1e-6);   // the hole at the middle is place 0; 29 copies, none overlapping
  // where place 7 is: the wall of its hole is 2 mm from 4.5·√7 at 7 golden angles
  const a = (7 * G_ANGLE * Math.PI) / 180, want = [50 + 4.5 * Math.sqrt(7) * Math.cos(a), 30 + 4.5 * Math.sqrt(7) * Math.sin(a)];
  const wall = body(engine).topo.faces.find((f) => f.name === "ph:f7:cut:side:h");
  const c = k.centre(wall.shape, "face");
  near(c[0], want[0], 1e-6); near(c[1], want[1], 1e-6);
  // another angle and a size at the rim: places still at spacing·√n, the copies grown
  const g = await run([...plate(50, 30), sketch("s3", circle(50, 30, 1, "k"), top),
    cf("ph", "cf-geo-phyllotaxis-pattern", { features: ["cut"], axis: { kind: "sketch", feature: "s3", entity: "k" }, count: 12, spacing: 8, angle: 90, sizeEnd: 1.2, keepOrientation: false })]);
  allOk(g.r);
  let want2 = HOLE; for (let i = 1; i < 12; i++) want2 += HOLE * (1 + 0.2 * Math.sqrt(i) / Math.sqrt(11)) ** 2;
  near(vol(g.k, g.engine), SLAB - want2, 1e-6);
});
const G_ANGLE = 180 * (3 - Math.sqrt(5));

test("surface pattern: bosses round and along a cylinder, each standing on it", async () => {
  // a boss on the cylinder's side at +X, 15 up: a Ø6 pin 4 long, drawn on the Right plane
  const model = [...post(), sketch("s2", circle(0, 15, 3, "b"), right), extrude("boss", "s2", { operation: "add", depth: 24 })];
  const one = await run(model);
  allOk(one.r);
  const pin = vol(one.k, one.engine) - Math.PI * 400 * 60;
  assert.ok(pin > 100 && pin < 130, String(pin));
  const { k, engine, r } = await run([...model, cf("sp", "cf-geo-surface-pattern", { features: ["boss"], face: SIDE, countU: 6, countV: 3, inset: 0.25 })]);
  built(r);
  assert.equal(bodies(engine).length, 1);
  near(vol(k, engine), Math.PI * 400 * 60 + 18 * pin, 1e-4);
  const b = box(k, engine);
  near(b[3], 24, 1e-6); near(b[0], -24, 1e-6);          // a pin at +X and one opposite
  // the rows are at 15, 30 and 45 up (a quarter in from each end)
  const names = faces(engine).filter((n) => /^sp:u\d+\.-?\d+:boss:end/.test(n));
  assert.equal(names.length, 17);
  const zs = new Set(body(engine).topo.faces.filter((f) => /^sp:u\d+\.-?\d+:boss:end/.test(f.name)).map((f) => Math.round(k.centre(f.shape, "face")[2])));
  assert.deepEqual(Array.from(zs).sort((a, c) => a - c), [15, 30, 45]);
  // on a flat face it is a plain grid
  const flat = await run([...plate(20, 20), cf("sp", "cf-geo-surface-pattern", { features: ["cut"], face: TOP, countU: 3, countV: 2, inset: 0.2 })]);
  built(flat.r);
  near(vol(flat.k, flat.engine), SLAB - 6 * HOLE, 1e-6);
});

// ---------------------------------------------------------------- helpers for the rest
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const C = load("domains/mechanical/features/_cf-geo-code.ts");
const H = load("domains/mechanical/features/_cf-geo-hull.ts");
const IMG = load("domains/mechanical/features/_cf-geo-image.ts");
const MV = load("domains/mechanical/features/_cf-geo-measured.ts");
const I = load("shared/itemdoc/itemdoc.ts");
const V = load("domains/mechanical/document/variables.ts");
/** A grey PNG as a data: URL; `at(x, y)` gives each pixel 0 … 255. */
function png(w, h, at) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = at(x, y);
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = table[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const RAMP = png(64, 32, (x) => Math.round((x / 63) * 255));   // black at the left, white at the right
const picture = (x0, y0, x1, y1, src = RAMP) => ({ a: { type: "point", x: x0, y: y0 }, b: { type: "point", x: x1, y: y1 }, i: { type: "image", a: "a", b: "b", src, construction: true } });
const block = () => [sketch("s1", rect(0, 0, 40, 30, "p")), extrude("e1", "s1", { depth: 20 })];
// an L: a 40 × 30 footprint with a 20 × 15 notch, 20 high (one inside corner)
const ell = { p0: { type: "point", x: 0, y: 0 }, p1: { type: "point", x: 40, y: 0 }, p2: { type: "point", x: 40, y: 15 }, p3: { type: "point", x: 20, y: 15 }, p4: { type: "point", x: 20, y: 30 }, p5: { type: "point", x: 0, y: 30 },
  a: { type: "line", a: "p0", b: "p1" }, b: { type: "line", a: "p1", b: "p2" }, c: { type: "line", a: "p2", b: "p3" }, d: { type: "line", a: "p3", b: "p4" }, e: { type: "line", a: "p4", b: "p5" }, f: { type: "line", a: "p5", b: "p0" } };
const L = () => [sketch("s1", ell), extrude("e1", "s1", { depth: 20 })];
const sk = (feature, entity) => ({ kind: "sketch", feature, entity });
const valid = (k, shape) => { const a = new k.oc.BRepCheck_Analyzer(shape, true, false, false); const ok = a.IsValid(); a.delete(); return ok; };
const datumOf = (r, id) => r.datums.find((d) => d.featureId === id);
const pointsOf = (d) => { const out = []; for (let i = 0; i < d.points.length; i += 3) out.push([d.points[i], d.points[i + 1], d.points[i + 2]]); return out; };
const hash = (m) => crypto.createHash("sha1").update(m.dark.map((row) => row.map((c) => (c ? "1" : "0")).join("")).join("\n")).digest("hex").slice(0, 16);

// ---------------------------------------------------------------- cut patterns and textures

test("Voronoi pattern: cells with walls between them, the same for the same seed", async () => {
  const a = await run([...slab(), cf("v", "cf-geo-voronoi", { face: TOP })]);
  allOk(a.r);
  const left = vol(a.k, a.engine);
  assert.ok(left > SLAB * 0.25 && left < SLAB * 0.6, String(left));          // walls of 2 between 24 cells, a margin of 3
  assert.ok(valid(a.k, body(a.engine).shape));
  const b = box(a.k, a.engine); near(b[3] - b[0], 100, 1e-9); near(b[5] - b[2], 5, 1e-9);   // the outside is untouched
  assert.ok(faces(a.engine).some((n) => /^v:c\d+:\d+$/.test(n)), "a cell's faces are named by its number");
  const again = await run([...slab(), cf("v", "cf-geo-voronoi", { face: TOP })]);
  near(vol(again.k, again.engine), left, 1e-9);
  // the walls between cells really are the wall wide: no two cells closer, in the plane
  const sites = G.scatter([[[0, 0], [100, 0], [100, 60], [0, 60]]], 24, 0, 3, G.rng(1));
  const cells = G.voronoiCells(sites, [2, 2, 98, 58], 2);
  for (let i = 0; i < cells.length; i++) for (let j = 0; j < i; j++) for (const p of cells[i]) for (let q = 0; q < cells[j].length; q++) assert.ok(G.distToSegment(p, cells[j][q], cells[j][(q + 1) % cells[j].length]) >= 2 - 1e-9);
  // blind, sharp corners, another seed, on a face with a hole in it (trimmed to the face)
  const c = await run([sketch("s1", { ...rect(0, 0, 100, 60, "p"), ...circle(50, 30, 12, "h") }), extrude("e1", "s1", { depth: 5 }), cf("v", "cf-geo-voronoi", { face: TOP, cells: 30, seed: 7, radius: 0, through: false, depth: 2 })]);
  allOk(c.r);
  const ring = (6000 - Math.PI * 144) * 5;
  assert.ok(vol(c.k, c.engine) < ring - 1500 && vol(c.k, c.engine) > ring - (6000 - Math.PI * 144) * 2, "pockets 2 deep, not through");
  failsWith((await run([...slab(), cf("v", "cf-geo-voronoi", { face: SIDE_OF_SLAB, margin: 10 })])).r, "v", /margin leaves nothing/);
});
const SIDE_OF_SLAB = face("e1", "e1:side:pa");

test("halftone perforation: hole sizes follow a gradient, and a picture", async () => {
  const a = await run([...slab(), cf("h", "cf-geo-halftone", { face: TOP })]);
  allOk(a.r);
  // the same lattice and sizes, worked out here
  const sites = G.lattice("hex", 6, 6, 0, [50, 30], [0, 0, 100, 60]);
  let want = 0, count = 0;
  for (const s of sites) { const d = 1 + 4 * Math.max(0, Math.min(1, 0.5 + (s.at[0] - 50) / 100)); if (G.inRegion([[[0, 0], [100, 0], [100, 60], [0, 60]]], s.at, 4 + d / 2)) { want += Math.PI * d * d / 4 * 5; count++; } }
  near(vol(a.k, a.engine), SLAB - want, 1e-6);
  assert.equal(faces(a.engine).filter((n) => /^h:g-?\d+\.-?\d+:/.test(n)).length, count);
  // a picture: a ramp from black (left) to white drawn over the middle of the plate; no holes outside it
  const p = await run([...slab(), sketch("pic", picture(20, 10, 80, 50)), cf("h", "cf-geo-halftone", { face: TOP, source: "picture", picture: ["pic"], min: 0, max: 5, margin: 2 })]);
  allOk(p.r);
  const holes = body(p.engine).topo.faces.filter((f) => /^h:g/.test(f.name)).map((f) => ({ x: p.k.centre(f.shape, "face")[0], y: p.k.centre(f.shape, "face")[1], r: Math.sqrt(p.k.oc.BRepGProp ? areaOf(p.k, f.shape) / (2 * Math.PI * 5) * 1 : 0) }));
  assert.ok(holes.length > 20);
  for (const h of holes) assert.ok(h.x > 20 - 1e-6 && h.x < 80 + 1e-6 && h.y > 10 - 1e-6 && h.y < 50 + 1e-6, "inside the picture");
  const big = holes.filter((h) => h.x < 35), small = holes.filter((h) => h.x > 60);
  const mean = (l) => l.reduce((s, h) => s + areaOfHole(h), 0) / l.length;
  assert.ok(mean(big) > 3 * mean(small), "dark makes the large holes");
  failsWith((await run([...slab(), sketch("pic", rect(0, 0, 5, 5, "q")), cf("h", "cf-geo-halftone", { face: TOP, source: "picture", picture: ["pic"] })])).r, "h", /no picture in it/);
  failsWith((await run([...slab(), cf("h", "cf-geo-halftone", { face: TOP, max: 7 })])).r, "h", /smaller than the pitch/);
  const pic = await IMG.decodePicture(RAMP);
  assert.deepEqual([pic.width, pic.height], [64, 32]); near(pic.gray[0], 0, 1e-9); near(pic.gray[63], 1, 1e-9); near(IMG.brightness(pic, 0.5, 0.5), 0.5, 0.02);
});
const areaOf = (k, shape) => { const g = new k.oc.GProp_GProps(); k.oc.BRepGProp.SurfaceProperties(shape, g, false, false); const a = g.Mass(); g.delete(); return a; };
const areaOfHole = (h) => h.r * h.r;

test("surface texture: domes, dimples, studs, pyramids and ribs on a flat face, domes round a cylinder", async () => {
  const sites = G.lattice("hex", 6, 6, 0, [50, 30], [0, 0, 100, 60]).filter((s) => G.inRegion([[[0, 0], [100, 0], [100, 60], [0, 60]]], s.at, 3 + 2));
  const cap = (a, h) => (Math.PI * h * (3 * a * a + h * h)) / 6;   // a spherical cap of foot radius a and height h
  const dome = await run([...slab(), cf("t", "cf-geo-texture", { face: TOP })]);
  allOk(dome.r);
  near(vol(dome.k, dome.engine), SLAB + sites.length * cap(2, 1), 2e-4);
  near(box(dome.k, dome.engine)[5], 6, 1e-6);
  const dimple = await run([...slab(), cf("t", "cf-geo-texture", { face: TOP, kind: "dimple" })]);
  allOk(dimple.r);
  near(vol(dimple.k, dimple.engine), SLAB - sites.length * cap(2, 1), 2e-4);
  const hex = await run([...slab(), cf("t", "cf-geo-texture", { face: TOP, kind: "hex", layout: "grid", pitch: 8, size: 4, height: 1.5, angle: 30 })]);
  allOk(hex.r);
  const studs = Math.round((vol(hex.k, hex.engine) - SLAB) / (2 * Math.sqrt(3) * 4 * 1.5));   // a hexagon 4 across its flats: 2√3·2² in area
  near(vol(hex.k, hex.engine), SLAB + studs * 2 * Math.sqrt(3) * 4 * 1.5, 1e-5);
  assert.ok(studs > 30, String(studs));
  const pyr = await run([...slab(), cf("t", "cf-geo-texture", { face: TOP, kind: "pyramid", layout: "grid", pitch: 10, size: 6, height: 3 })]);
  allOk(pyr.r);
  const points = G.lattice("grid", 10, 10, 0, [50, 30], [0, 0, 100, 60]).filter((s) => G.inRegion([[[0, 0], [100, 0], [100, 60], [0, 60]]], s.at, 3 + 3 * Math.SQRT2)).length;
  near(vol(pyr.k, pyr.engine), SLAB + points * 36, 1e-4);          // 6 × 6 × 3 / 3 each
  const rib = await run([...slab(), cf("t", "cf-geo-texture", { face: TOP, kind: "rib", pitch: 10, size: 3, height: 2, margin: 5 })]);
  allOk(rib.r);
  near(vol(rib.k, rib.engine), SLAB + 5 * 3 * 2 * 90, 1e-6);       // five ribs across the 50 the margin leaves, each 90 long
  // round a Ø40 post: 16 to the turn (2π·20 / 8), 7 rows; each dome sunk so that it joins all round
  const post8 = await run([...post(), cf("t", "cf-geo-texture", { face: SIDE, pitch: 8, size: 5, height: 1.5 })]);
  allOk(post8.r);
  const b = box(post8.k, post8.engine); near(b[3], 21.5, 1e-4); near(b[1], -21.5, 1e-4);
  assert.equal(faces(post8.engine).filter((n) => /^t:g\d+\.-?\d+:/.test(n)).length, 16 * 7 * 1 + 0 || faces(post8.engine).filter((n) => /^t:g/.test(n)).length);
  assert.ok(vol(post8.k, post8.engine) > Math.PI * 400 * 60 + 16 * 7 * cap(2.5, 1.5) * 0.9);
  failsWith((await run([...post(), cf("t", "cf-geo-texture", { face: SIDE, kind: "rib" })])).r, "t", /Ribs go on a flat face/);
  failsWith((await run([...slab(), cf("t", "cf-geo-texture", { face: TOP, height: 3 })])).r, "t", /half as high/);
});

test("QR code and Data Matrix: the module grids are the ones an independent reader read back", () => {
  // these grids were decoded with ZXing (QRCodeReader, DataMatrixReader) and gave the text back; the hash is of the grid
  const qr = (t, l) => C.qrCode(t, l);
  assert.deepEqual([qr("A", "M").version, hash(qr("A", "M"))], [1, "66a90bf2fd844de9"]);
  assert.deepEqual([qr("https://example.com/part/1234?rev=B", "M").version, hash(qr("https://example.com/part/1234?rev=B", "M"))], [3, "3e9450365644b067"]);
  assert.deepEqual([qr("x".repeat(100), "H").version, hash(qr("x".repeat(100), "H"))], [10, "36c3acb23499ecc9"]);
  assert.deepEqual([qr("y".repeat(213), "M").version, hash(qr("y".repeat(213), "M"))], [10, "2c8cf10055760ce0"]);
  assert.throws(() => qr("y".repeat(300), "M"), /too long for a QR code/);
  const m = qr("A", "M");
  assert.equal(m.size, 21);
  for (const [x, y] of [[0, 0], [20, 0], [0, 20]]) assert.ok(m.dark[y][x], "the three finder corners are dark");
  for (let i = 8; i < 13; i++) assert.equal(m.dark[6][i], i % 2 === 0, "the timing row alternates");
  const dm = (t) => C.dataMatrix(t);
  assert.deepEqual([dm("Hello").size, hash(dm("Hello"))], [12, "770f5be6a38d56f7"]);
  assert.deepEqual([dm("SN-00042/B").size, hash(dm("SN-00042/B"))], [14, "5758630f867e0ee7"]);
  assert.deepEqual([dm("abcdefghij".repeat(6)).size, hash(dm("abcdefghij".repeat(6)))], [32, "090435358580b13e"]);
  assert.deepEqual([dm("w".repeat(170)).size, hash(dm("w".repeat(170)))], [48, "5038be44bcafa79c"]);
  assert.throws(() => dm("w".repeat(400)), /too long for a Data Matrix/);
  assert.throws(() => dm("日本"), /Latin-1/);
  const d = dm("Hello");
  for (let i = 0; i < 12; i++) { assert.ok(d.dark[i][0] && d.dark[11][i], "the solid L"); assert.equal(d.dark[0][i], i % 2 === 0, "the clock track"); }
  // the rectangles cover exactly the dark modules
  const cover = m.dark.map((row) => row.map(() => 0));
  for (const [x, y, w, h] of C.moduleRectangles(m)) for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) cover[y + j][x + i]++;
  m.dark.forEach((row, y) => row.forEach((c, x) => assert.equal(cover[y][x], c ? 1 : 0)));
});

test("QR code: raised from a face, cut into it, and as a tile", async () => {
  const code = C.qrCode("https://example.com", "M"), dark = code.dark.flat().filter(Boolean).length, mod = 25 / code.size;
  const a = await run([...slab(), cf("q", "cf-geo-qr-code", { target: TOP })]);
  allOk(a.r);
  near(vol(a.k, a.engine), SLAB + dark * mod * mod * 0.6, 1e-6);
  const b = box(a.k, a.engine); near(b[5], 5.6, 1e-9);
  assert.ok(faces(a.engine).includes("q:m0.0:1") || faces(a.engine).some((n) => /^q:m0\.0:/.test(n)), "the corner finder's rectangle is named by its module");
  const dm = C.dataMatrix("SN-00042/B"), dmDark = dm.dark.flat().filter(Boolean).length;
  const e = await run([...slab(), cf("q", "cf-geo-qr-code", { target: TOP, result: "engrave", kind: "datamatrix", text: "SN-00042/B", size: 14, depth: 0.5, x: 20, angle: 90 })]);
  allOk(e.r);
  near(vol(e.k, e.engine), SLAB - dmDark * 0.5, 1e-6);
  const t = await run([cf("q", "cf-geo-qr-code", { target: top, result: "new", invert: true, tile: 2, quiet: 4 })]);
  allOk(t.r);
  assert.equal(bodies(t.engine).length, 1);
  near(vol(t.k, t.engine), (25 + 8 * mod) ** 2 * 2 + (code.size * code.size - dark) * mod * mod * 0.6, 1e-6);
  failsWith((await run([...slab(), cf("q", "cf-geo-qr-code", { target: TOP, text: "" })])).r, "q", /Type the text/);
  failsWith((await run([cf("q", "cf-geo-qr-code", { target: top })])).r, "q", /need a face of a part/);
});

test("text: raised, cut, on its own, and round a cylinder with its width kept", async () => {
  const own = await run([cf("t", "cf-geo-text", { target: top, result: "new" })]);
  allOk(own.r);
  const area = vol(own.k, own.engine) / 0.8, b0 = box(own.k, own.engine);
  assert.ok(area > 60 && area < 140, String(area));       // "Junction", capitals 8 high
  assert.ok(b0[4] - b0[1] > 8 && b0[4] - b0[1] < 11, String(b0[4] - b0[1])); near(b0[5], 0.8, 1e-6);      // a J's tail and a j's dot reach past the capitals
  assert.equal(own.k.sub(body(own.engine).shape, "solid").length, 9, "eight letters and the dot of the i");
  const up = await run([...slab(), cf("t", "cf-geo-text", { target: TOP })]);
  allOk(up.r);
  near(vol(up.k, up.engine), SLAB + area * 0.8, 1e-5);
  const c = box(own.k, own.engine), mid = (c[0] + c[3]) / 2;
  assert.ok(Math.abs(mid) < 0.5, String(mid));                                      // centred on the plane's origin
  const down = await run([...slab(), cf("t", "cf-geo-text", { target: TOP, result: "engrave", text: "Rev B\\n2026", height: 6, depth: 0.5, bold: true, italic: true, angle: 10, x: -5 })]);
  allOk(down.r);
  assert.ok(vol(down.k, down.engine) < SLAB - 20 && vol(down.k, down.engine) > SLAB - 120);
  near(box(down.k, down.engine)[5], 5, 1e-9);
  // round a Ø40 post: the letters keep their widths along the arc, and stand out 0.8 all the way
  const flat = await run([cf("t", "cf-geo-text", { target: top, result: "new", height: 6 })]);
  const round = await run([...post(), cf("t", "cf-geo-text", { target: SIDE, height: 6 })]);
  allOk(round.r);
  const added = vol(round.k, round.engine) - Math.PI * 400 * 60;
  near(added, vol(flat.k, flat.engine) * (1 + 0.4 / 20), 2e-3);          // the same letters, a little wider at their tops
  assert.ok(valid(round.k, body(round.engine).shape));
  const width = flat.k && box(flat.k, flat.engine); const w = width[3] - width[0];
  const outer = body(round.engine).topo.faces.filter((f) => /^t:t\d+:/.test(f.name)).map((f) => round.k.centre(f.shape, "face"));
  const angles = outer.map((p) => Math.atan2(p[1], p[0])).map((a) => (a < 0 ? a + 2 * Math.PI : a));
  assert.ok(Math.max(...angles) - Math.min(...angles) < w / 20 + 0.02 && Math.max(...angles) - Math.min(...angles) > w / 20 - 0.2, "the text spans its own width as an arc");
  assert.ok(Math.max(...outer.map((p) => Math.hypot(p[0], p[1]))) <= 20.8 + 1e-6);
  const cut = await run([...post(), cf("t", "cf-geo-text", { target: SIDE, height: 6, result: "engrave", text: "abc" })]);
  allOk(cut.r);
  assert.ok(vol(cut.k, cut.engine) < Math.PI * 400 * 60 - 5);
  near(box(cut.k, cut.engine)[0], -20, 1e-6);
  failsWith((await run([...post(), cf("t", "cf-geo-text", { target: SIDE, height: 12, text: "far too long a text to go round this post" })])).r, "t", /longer than the cylinder is round|reaches round to the back/);
  failsWith((await run([...slab(), cf("t", "cf-geo-text", { target: TOP, text: "  " })])).r, "t", /Type the text/);
});

test("text on a curve: letters stand along an arc, on either side of it", async () => {
  const arc = { c: { type: "point", x: 0, y: 0 }, s: { type: "point", x: 30, y: 0 }, e: { type: "point", x: -30, y: 0 }, a: { type: "arc", center: "c", start: "s", end: "e" } };
  const a = await run([sketch("s1", arc), cf("t", "cf-geo-text-on-curve", { path: [sk("s1", "a")] })]);
  allOk(a.r);
  const flat = await run([cf("t", "cf-geo-text", { target: top, result: "new", height: 6, depth: 1 })]);
  near(vol(a.k, a.engine), vol(flat.k, flat.engine), 1e-6);            // the same letters, only placed differently
  const b = box(a.k, a.engine);
  assert.ok(b[1] > 20 && b[4] < 39 && Math.abs(b[0] + b[3]) < 1.5, "along the arc, about its top");   // baseline on r = 30
  near(b[5], 1, 1e-6);
  assert.ok(faces(a.engine).some((n) => /^t:c1:/.test(n)) && faces(a.engine).some((n) => /^t:c6\.2:/.test(n)), "letters are named by their place; the i has two pieces");
  const inner = await run([sketch("s1", arc), cf("t", "cf-geo-text-on-curve", { path: [sk("s1", "a")], below: true, text: "INSIDE", height: 4, spacing: 0.5, align: "start", flip: true })]);
  allOk(inner.r);
  const c = box(inner.k, inner.engine);
  const radii = (x) => body(x.engine).topo.faces.map((f) => { const q = x.k.centre(f.shape, "face"); return Math.hypot(q[0], q[1]); });
  const mean = (l) => l.reduce((s, v) => s + v, 0) / l.length;
  const side = (x) => (mean(radii(x)) < 29 && Math.max(...radii(x)) < 30.6 ? "in" : mean(radii(x)) > 31 && Math.min(...radii(x)) > 29.4 ? "out" : "across");
  assert.deepEqual([side(a), side(inner)].sort(), ["in", "out"], "the letters stand wholly on one side of the path, and on the other when asked");
  near(c[2], -1, 1e-9);
  // cut into a plate along one of its edges
  // (which way an edge runs is the kernel's affair: one side of it is on the plate, the other off it)
  const along = (below) => run([...slab(), cf("t", "cf-geo-text-on-curve", { path: [{ kind: "edge", body: "e1", name: "edge(e1:end:pa|e1:side:pa)" }], plane: TOP, operation: "remove", depth: 1, offset: 3, text: "EDGE", flip: true, below })]);
  const sides = [await along(false), await along(true)], cut = sides.find((x) => vol(x.k, x.engine) < SLAB - 10), miss = sides.find((x) => x !== cut);
  assert.ok(cut, "on one side the letters are cut into the plate"); built(cut.r);
  assert.match(report(miss.r, "t").message, /Nothing was removed/);
  failsWith((await run([cf("t", "cf-geo-text-on-curve", {})])).r, "t", /Pick the path/);
});

test("height map: a plate as thick as a picture is dark, and as an equation says", async () => {
  const a = await run([sketch("pic", picture(0, 0, 60, 30)), cf("l", "cf-geo-lithophane", { picture: ["pic"] })]);
  allOk(a.r);
  near(vol(a.k, a.engine), 60 * 30 * (0.8 + 3) / 2, 5e-3);            // a ramp from 3 (black) to 0.8 (white)
  const b = box(a.k, a.engine); near(b[3] - b[0], 60, 1e-6); near(b[4] - b[1], 30, 1e-6); near(b[2], 0, 1e-6); assert.ok(b[5] > 2.95 && b[5] < 3.2);
  assert.deepEqual(faces(a.engine).slice().sort(), ["l:back", "l:relief", "l:side", "l:side~2", "l:side~3", "l:side~4"]);
  assert.ok(valid(a.k, body(a.engine).shape));
  const inv = await run([sketch("pic", picture(0, 0, 60, 30)), cf("l", "cf-geo-lithophane", { picture: ["pic"], invert: true, samples: 40 })]);
  // thick where it was thin: where x is small the plate is now 0.8
  const com = (x) => { const g = new x.k.oc.GProp_GProps(); x.k.oc.BRepGProp.VolumeProperties(body(x.engine).shape, g, true, false, false); const c = g.CentreOfMass(); const out = c.X(); c.delete(); g.delete(); return out; };
  assert.ok(com(a) < 28 && com(inv) > 32, "the thick side is now on the right");
  const eq = await run([cf("l", "cf-geo-lithophane", { source: "equation", equation: "2 + x/30", width: 60, length: 40, plane: front })]);
  allOk(eq.r);
  near(vol(eq.k, eq.engine), 60 * 40 * 2, 1e-4);                     // a wedge from 1 to 3
  failsWith((await run([cf("l", "cf-geo-lithophane", { source: "equation", equation: "sqrt(x)" })])).r, "l", /no value somewhere/);
  failsWith((await run([cf("l", "cf-geo-lithophane", {})])).r, "l", /Pick the sketch/);
});

// ---------------------------------------------------------------- curves and what follows them

test("equation curve: the points of x(t), y(t), z(t); closed when it comes back", async () => {
  const { r } = await run([cf("c", "cf-geo-equation-curve")]);
  allOk(r);
  const d = datumOf(r, "c"); assert.equal(d.kind, "curve");
  for (const p of pointsOf(d)) { near(Math.hypot(p[0], p[1]), 20, 2e-4); assert.ok(Math.abs(p[2]) <= 5 + 1e-3); }
  const spiral = await run([cf("c", "cf-geo-equation-curve", { system: "cylindrical", x: "10 + t", y: "t", z: "t^2/10", t0: 0, t1: 12, plane: front })]);
  allOk(spiral.r);
  const pts = pointsOf(datumOf(spiral.r, "c")), end = pts[pts.length - 1];
  near(Math.hypot(end[0], end[2]), 22, 1e-6); near(Math.abs(end[1]), 14.4, 1e-6);          // r = 22 in the Front plane, 14.4 off it
  failsWith((await run([cf("c", "cf-geo-equation-curve", { x: "20*cas(t)" })])).r, "c", /no function “cas”/);
  failsWith((await run([cf("c", "cf-geo-equation-curve", { x: "1/(t-1)", t0: 0, t1: 2, samples: 3 })])).r, "c", /no value at t = 1/);
  assert.equal(G.compileExpr("2*(t+1)^2 - sqrt(16)/4 + min(3, t)", ["t"])({ t: 1 }), 8);
  near(G.compileExpr("sin(pi/2) + atan2(1, 1)", [])({}), 1 + Math.PI / 4, 1e-12);
});

test("curve through XYZ points: a pasted table, in its unit, smooth or straight", async () => {
  const { r } = await run([cf("c", "cf-geo-point-curve")]);
  allOk(r);
  const pts = pointsOf(datumOf(r, "c"));
  assert.deepEqual(pts[0].map((v) => Math.round(v)), [0, 0, 0]); assert.deepEqual(pts[pts.length - 1].map((v) => Math.round(v)), [60, -10, 30]);
  const sq = await run([cf("c", "cf-geo-point-curve", { points: "x,y,z\n0,0,0\n1,0,0\n1,1,0\n0,1,0", unit: "in", fit: "polyline", closed: true })]);
  allOk(sq.r);
  const d = pointsOf(datumOf(sq.r, "c"));
  let len = 0; for (let i = 1; i < d.length; i++) len += Math.hypot(d[i][0] - d[i - 1][0], d[i][1] - d[i - 1][1], d[i][2] - d[i - 1][2]);
  near(len, 4 * 25.4, 1e-6);
  assert.deepEqual(G.parsePoints("0 0 0 10 0 0 10 5 0", 3), [[0, 0, 0], [10, 0, 0], [10, 5, 0]], "a table pasted into one line");
  failsWith((await run([cf("c", "cf-geo-point-curve", { points: "1 2" })])).r, "c", /two or more rows of x y z/);
});

test("airfoil wing: a NACA section is the series' own; the wing's volume is the sections' areas lofted", async () => {
  const s = G.naca4("0012", 200, false);
  near(Math.max(...s.upper.map((p) => p[1])) * 2, 0.12, 1e-4);
  near(s.upper[s.upper.findIndex((p) => p[1] === Math.max(...s.upper.map((q) => q[1])))][0], 0.30, 0.01);
  near(G.airfoilArea(s), 0.68505 * 0.12, 2e-4);               // the integral of the thickness formula
  const c = G.naca4("2412", 200);
  near(Math.max(...c.upper.map((p, i) => (p[1] + c.lower[i][1]) / 2)), 0.02, 2e-3);        // 2 % camber
  assert.throws(() => G.naca4("24x2"), /four digits/);
  const straight = await run([cf("w", "cf-geo-airfoil", { naca: "0012", chord: 100, tipChord: 100, sweep: 0, span: 200, sharp: false })]);
  allOk(straight.r);
  near(vol(straight.k, straight.engine), 0.68505 * 0.12 * 1e4 * 200, 3e-4);
  const b = box(straight.k, straight.engine); near(b[3] - b[0], 100, 1e-4); near(b[5] - b[2], 12, 2e-3); near(b[4] - b[1], 200, 1e-9);
  assert.ok(valid(straight.k, body(straight.engine).shape));
  for (const n of ["w:root", "w:tip", "w:te", "w:skin:1", "w:skin:40"]) assert.ok(faces(straight.engine).includes(n), n);
  // tapered and swept (the defaults): the volume of a loft between similar sections
  const taper = await run([cf("w", "cf-geo-airfoil")]);
  allOk(taper.r);
  const a = G.airfoilArea(G.naca4("2412", 400, true)) * 1e4, at = a * 0.36;
  near(vol(taper.k, taper.engine), (200 / 3) * (a + at + Math.sqrt(a * at)), 2e-3);
  // a table of coordinates (Selig order), another section at the tip, twist and dihedral
  const sel = G.naca4("4415", 30, true), table = [...sel.upper.slice().reverse(), ...sel.lower.slice(1)].map((p) => `${p[0].toFixed(6)} ${p[1].toFixed(6)}`).join("\n");
  const custom = await run([cf("w", "cf-geo-airfoil", { source: "table", table: `NACA 4415\n${table}`, plane: right, twist: 4, dihedral: 5, operation: "new" })]);
  allOk(custom.r);
  assert.ok(vol(custom.k, custom.engine) > 100000);
  near(G.airfoilArea(G.airfoilFromTable(table)), G.airfoilArea(sel), 1e-5);
  failsWith((await run([cf("w", "cf-geo-airfoil", { naca: "12" })])).r, "w", /four digits/);
});

test("tube: along a path with a bend at each corner; hollow, or a bar with sharp corners", async () => {
  const path = { p0: { type: "point", x: 0, y: 0 }, p1: { type: "point", x: 60, y: 0 }, p2: { type: "point", x: 60, y: 40 }, p3: { type: "point", x: 100, y: 40 }, l1: { type: "line", a: "p0", b: "p1" }, l2: { type: "line", a: "p1", b: "p2" }, l3: { type: "line", a: "p2", b: "p3" } };
  const a = await run([sketch("s1", path), cf("t", "cf-geo-tube", { path: [sk("s1", "l1")] })]);
  allOk(a.r);
  const centre = 140 - 2 * (2 * 15 - (Math.PI * 15) / 2);            // two 90° bends of radius 15
  near(vol(a.k, a.engine), Math.PI * (25 - 16) * centre, 1e-6);
  for (const n of ["t:outer", "t:inner", "t:start", "t:end"]) assert.ok(faces(a.engine).includes(n), n);
  const bar = await run([sketch("s1", path), cf("t", "cf-geo-tube", { path: [sk("s1", "l1")], wall: 0, bend: 0, diameter: 6 })]);
  allOk(bar.r);
  assert.ok(Math.abs(vol(bar.k, bar.engine) - Math.PI * 9 * 140) < Math.PI * 9 * 3, "140 long, less a little where the corners overlap");
  const along = await run([cf("c", "cf-geo-point-curve"), cf("t", "cf-geo-tube", { path: [datum("c")], diameter: 4, wall: 0.5 })]);
  allOk(along.r);
  assert.ok(vol(along.k, along.engine) > Math.PI * (4 - 2.25) * 70);
  failsWith((await run([sketch("s1", path), cf("t", "cf-geo-tube", { path: [sk("s1", "l1")], bend: 30 })])).r, "t", /bend radius is too large for corner/);
  failsWith((await run([sketch("s1", path), cf("t", "cf-geo-tube", { path: [sk("s1", "l1")], wall: 6 })])).r, "t", /less than half the diameter/);
});

test("cable: a catenary between supports, by slack or by sag", async () => {
  const pts = { a: { type: "point", x: 0, y: 0 }, b: { type: "point", x: 100, y: 0 }, c: { type: "point", x: 160, y: 30 } };
  const curve = await run([sketch("s1", pts), cf("c", "cf-geo-cable", { points: [sk("s1", "a"), sk("s1", "b")], by: "sag", sag: 15, output: "curve" })]);
  allOk(curve.r);
  const line = pointsOf(datumOf(curve.r, "c"));
  near(Math.min(...line.map((p) => p[2])), -15, 2e-3);                 // it hangs 15 below, in the middle
  near(line.reduce((m, p) => (p[2] < m[2] ? p : m))[0], 50, 0.05);
  // the catenary itself: the length asked for, and the curve's own equation
  const hang = G.catenary([0, 0, 0], [100, 0, 20], [0, 0, -1], 130, 400);
  let len = 0; for (let i = 1; i < hang.length; i++) len += Math.hypot(hang[i][0] - hang[i - 1][0], hang[i][2] - hang[i - 1][2]);
  near(len, 130, 1e-5);
  near(G.sagOf([0, 0, 0], [100, 0, 0], [0, 0, -1], G.lengthForSag([0, 0, 0], [100, 0, 0], [0, 0, -1], 12)), 12, 1e-6);
  const solid = await run([sketch("s1", pts), cf("c", "cf-geo-cable", { points: [sk("s1", "a"), sk("s1", "b"), sk("s1", "c")] })]);
  allOk(solid.r);
  const total = 100 * 1.05 + Math.hypot(60, 30) * 1.05;
  near(vol(solid.k, solid.engine), Math.PI * 4 * total, 0.01);          // Ø4 along both spans, 5 % slack each
  assert.match(body(solid.engine).name, /^Cable 175\.4 mm$/);
  failsWith((await run([sketch("s1", pts), cf("c", "cf-geo-cable", { points: [sk("s1", "a")] })])).r, "c", /two or more supports/);
});

test("spiral: flat, conical and logarithmic, as a curve and as a coil", async () => {
  const flat = await run([cf("s", "cf-geo-spiral", { axis: top })]);
  allOk(flat.r);
  const pts = pointsOf(datumOf(flat.r, "s"));
  near(Math.hypot(pts[0][0], pts[0][1]), 5, 1e-6); near(Math.hypot(...pts[pts.length - 1].slice(0, 2)), 25, 1e-6);
  for (const p of pts) near(p[2], 0, 1e-9);
  // Archimedean: the radius grows evenly with the angle (checked at every sampled point)
  let turned = 0;
  for (let i = 1; i < pts.length; i++) { let da = Math.atan2(pts[i][1], pts[i][0]) - Math.atan2(pts[i - 1][1], pts[i - 1][0]); if (da < -Math.PI) da += 2 * Math.PI; turned += da; near(Math.hypot(pts[i][0], pts[i][1]), 5 + (20 * turned) / (8 * Math.PI), 2e-4); }
  near(turned, 8 * Math.PI, 1e-6);
  const cone = await run([cf("s", "cf-geo-spiral", { axis: top, kind: "conical", r0: 20, r1: 8, turns: 6, height: 40, output: "solid", wire: 3 })]);
  allOk(cone.r);
  let length = 0; { const n = 4000; let prev = null; for (let i = 0; i <= n; i++) { const s = i / n, a = 12 * Math.PI * s, r = 20 - 12 * s, p = [r * Math.cos(a), r * Math.sin(a), 40 * s]; if (prev) length += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); prev = p; } }
  near(vol(cone.k, cone.engine), Math.PI * 2.25 * length, 2e-3);
  const b = box(cone.k, cone.engine); near(b[5], 41.5, 0.02); near(b[2], -1.5, 0.02);
  const log = await run([cf("s", "cf-geo-spiral", { axis: front, kind: "log", r0: 2, r1: 30, turns: 3, left: true })]);
  allOk(log.r);
  const lp = pointsOf(datumOf(log.r, "s"));
  { let ang = 0; for (let i = 1; i < lp.length; i++) { let da = Math.atan2(lp[i][2], lp[i][0]) - Math.atan2(lp[i - 1][2], lp[i - 1][0]); if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; ang += Math.abs(da); near(Math.hypot(lp[i][0], lp[i][2]), 2 * Math.pow(15, ang / (6 * Math.PI)), 2e-3); } near(ang, 6 * Math.PI, 1e-6); }   // the radius grows by the same factor for the same turn
  failsWith((await run([cf("s", "cf-geo-spiral", { axis: top, output: "solid", wire: 8 })])).r, "s", /thicker than the turns are apart/);
  failsWith((await run([cf("s", "cf-geo-spiral", { axis: top, kind: "log", r0: 0 })])).r, "s", /both radii more than zero/);
});

// ---------------------------------------------------------------- utilities

test("stock body: the box or bar round a part, with allowance, rounded up to stock sizes", async () => {
  const a = await run([...L(), cf("s", "cf-geo-stock")]);
  allOk(a.r);
  assert.deepEqual(box(a.k, a.engine, "s").map((v) => Math.round(v * 1e6) / 1e6), [-2, -2, -2, 42, 32, 22]);
  assert.deepEqual(faces(a.engine, "s").slice().sort(), ["s:x+", "s:x-", "s:y+", "s:y-", "s:z+", "s:z-"]);
  near(vol(a.k, a.engine, "e1"), 18000, 1e-9);                         // the part is left alone
  const bar = await run([...post(), cf("s", "cf-geo-stock", { shape: "cylinder", allowance: 1, step: 5 })]);
  allOk(bar.r);
  near(vol(bar.k, bar.engine, "s"), Math.PI * 22.5 * 22.5 * 65, 1e-9);  // Ø42 → Ø45, 62 → 65
  assert.deepEqual(faces(bar.engine, "s").slice().sort(), ["s:end", "s:side", "s:start"]);
  const across = await run([...post(), cf("s", "cf-geo-stock", { shape: "cylinder", axis: "x", allowance: 0 })]);
  near(vol(across.k, across.engine, "s"), Math.PI * (400 + 900) * 40, 3e-4);          // the circle round a 40 × 60 rectangle
  const turned = await run([...L(), cf("s", "cf-geo-stock", { plane: front, allowance: 0, step: 25 })]);
  allOk(turned.r);
  near(vol(turned.k, turned.engine, "s"), 50 * 25 * 50, 1e-9);          // 40 × 20 × 30 in the Front plane's frame, each up to 25s
  assert.equal(def("cf-geo-stock").defaults().allowance, 2);
});

test("centre of mass: a point where the bodies balance, or a connector there", async () => {
  const a = await run([...L(), cf("c", "cf-geo-centre-of-mass")]);
  allOk(a.r);
  const d = datumOf(a.r, "c"); assert.equal(d.kind, "point");
  near(d.at[0], (600 * 20 + 300 * 10) / 900, 1e-9); near(d.at[1], 12.5, 1e-9); near(d.at[2], 10, 1e-9);
  const two = await run([...L(), sketch("s2", rect(100, 0, 110, 10, "q")), extrude("e2", "s2", { depth: 10 }), cf("c", "cf-geo-centre-of-mass", { output: "connector" })]);
  const m = datumOf(two.r, "c"); assert.equal(m.kind, "plane"); assert.equal(m.mate, true);
  near(m.frame.origin[0], (18000 * (50 / 3) + 1000 * 105) / 19000, 1e-9);
  failsWith((await run([cf("c", "cf-geo-centre-of-mass")])).r, "c", /no body/);
});

test("measure to variable: what is measured, and how it is written into the variables", async () => {
  const m = async (o) => { const x = await run([...block(), cf("m", "cf-geo-measure", o)]); allOk(x.r); return datumOf(x.r, "m").measure; };
  assert.deepEqual(await m({ a: face("e1", "e1:side:pa"), b: face("e1", "e1:side:pc") }), { name: "measured", value: 30, unit: "mm" });
  assert.deepEqual(await m({ what: "angle", a: face("e1", "e1:side:pa"), b: face("e1", "e1:end:pa"), name: "tilt" }), { name: "tilt", value: 90, unit: "deg" });
  assert.deepEqual(await m({ what: "volume" }), { name: "measured", value: 24000, unit: "mm3" });
  assert.deepEqual(await m({ what: "extent", axis: "z" }), { name: "measured", value: 20, unit: "mm" });
  near((await m({ what: "area", items: [face("e1", "e1:end:pa")] })).value, 1200, 1e-9);
  near((await m({ what: "length", items: [{ kind: "edge", body: "e1", name: "edge(e1:end:pa|e1:side:pa)" }, { kind: "edge", body: "e1", name: "edge(e1:end:pa|e1:side:pb)" }] })).value, 70, 1e-9);
  failsWith((await run([...block(), cf("m", "cf-geo-measure", { what: "volume", name: "2 wide" })])).r, "m", /Name the variable/);
  // the page's half: a missing variable is added, a stale one rewritten, a current one left alone
  const doc = I.newItemDoc("part-studio", []);
  const apply = (changes) => I.applyChanges(doc, changes);
  const first = MV.measuredChanges(doc, [{ name: "gap", value: 12.3456789, unit: "mm" }, { name: "tilt", value: 30, unit: "deg" }, { name: "bulk", value: 24000, unit: "mm3" }]);
  assert.equal(first.length, 3);
  assert.deepEqual([MV.measuredText({ name: "g", value: 12.3456789, unit: "mm" }), MV.measuredText({ name: "t", value: 30, unit: "deg" }), MV.measuredText({ name: "b", value: 24000, unit: "mm3" })], ["12.345679 mm", "30 deg", "24000"]);
  {
    apply(first);
    assert.deepEqual(V.variablesOf(doc).map((v) => `${v.name}=${v.expr}`), ["gap=12.345679 mm", "tilt=30 deg", "bulk=24000"]);
    assert.equal(MV.measuredChanges(doc, [{ name: "gap", value: 12.3456789, unit: "mm" }, { name: "tilt", value: 30, unit: "deg" }]).length, 0, "nothing to do when the values are there");
    const next = MV.measuredChanges(doc, [{ name: "gap", value: 14, unit: "mm" }]);
    assert.equal(next.length, 1); apply(next);
    assert.equal(V.variablesOf(doc).find((v) => v.name === "gap").expr, "14 mm");
    near(V.variableValues(V.variablesOf(doc)).values.get("gap"), 14, 1e-12);
  }
});

test("convex hull: exact for flat-faced bodies, facets within the accuracy of round ones", async () => {
  const a = await run([...L(), cf("h", "cf-geo-convex-hull")]);
  allOk(a.r);
  near(vol(a.k, a.engine, "h"), (1200 - 150) * 20, 1e-9);              // the notch's corner cut off by one flat face
  assert.deepEqual(faces(a.engine, "h").slice().sort(), ["h:h1", "h:h2", "h:h3", "h:h4", "h:h5", "h:h6", "h:h7"]);
  assert.equal(bodies(a.engine).length, 2);
  const round = await run([...post(), cf("h", "cf-geo-convex-hull", { keep: false, accuracy: 0.05 })]);
  allOk(round.r);
  assert.equal(bodies(round.engine).length, 1);
  const v = vol(round.k, round.engine), full = Math.PI * 400 * 60;
  assert.ok(v < full && v > full * 0.995, String(v / full));
  assert.ok(valid(round.k, body(round.engine).shape));
  const two = await run([...post(), sketch("s2", rect(30, -5, 50, 5, "q")), extrude("e2", "s2", { depth: 10 }), cf("h", "cf-geo-convex-hull")]);
  allOk(two.r);
  assert.ok(vol(two.k, two.engine, "h") > full + 2000 + 10000);
  // the hull itself: a cube's corners and points inside it give six square faces
  const pts = []; for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) pts.push([x, y, z]);
  pts.push([0.5, 0.5, 0.5], [0.2, 0.7, 0.1], [0.5, 0.5, 0], [0.5, 0, 0]);
  const hull = H.convexHull(pts, 1e-9);
  assert.equal(hull.length, 6); for (const f of hull) assert.equal(f.length, 4);
  assert.equal(H.convexHull([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], 1e-9), null);
});

test("hollow with drain holes: a closed shell, holes through its low side, split in two", async () => {
  const closed = await run([...block(), cf("h", "cf-geo-hollow", { holes: 0 })]);
  allOk(closed.r);
  near(vol(closed.k, closed.engine), 24000 - 36 * 26 * 16, 1e-6);
  const a = await run([...block(), cf("h", "cf-geo-hollow")]);
  allOk(a.r);
  near(vol(a.k, a.engine), 24000 - 36 * 26 * 16 - 2 * Math.PI * 2.25 * 2, 1e-6);     // two Ø3 holes through the 2 mm floor
  const walls = body(a.engine).topo.faces.filter((f) => /^h:d\d:/.test(f.name));
  assert.equal(walls.length, 2);
  for (const w of walls) { const c = a.k.centre(w.shape, "face"); near(c[2], 1, 1e-6); near(Math.hypot(c[0] - 20, c[1] - 15), 5, 1e-6); }
  assert.ok(faces(a.engine).includes("h:from(e1:end:pa)"), "the inner wall is named after the face it is offset from");
  const split = await run([...post(), cf("h", "cf-geo-hollow", { holes: 1, thickness: 3, split: right })]);
  allOk(split.r);
  assert.equal(bodies(split.engine).length, 2);
  const shell = Math.PI * 400 * 60 - Math.PI * 289 * 54 - Math.PI * 2.25 * 3;
  near(vol(split.k, split.engine) + split.k.volume(bodies(split.engine)[1].shape), shell, 1e-5);
  near(vol(split.k, split.engine), shell / 2, 1e-5);
  for (const b of bodies(split.engine)) assert.ok(b.topo.faces.some((f) => f.name === "h:cut"));
  failsWith((await run([...block(), cf("h", "cf-geo-hollow", { thickness: 0 })])).r, "h", /thicker than zero/);
});

test("fillet all edges: outside corners, inside corners, by sharpness, with some left alone", async () => {
  const k0 = await boot(), engine0 = new K.RegenEngine(k0, K.FEATURES);
  await engine0.regenerate(L(), 2);
  const out = await run([...L(), cf("f", "cf-geo-auto-fillet")]);
  allOk(out.r);
  assert.ok(vol(out.k, out.engine) < 18000 && vol(out.k, out.engine) > 17850);
  assert.equal(faces(out.engine).filter((n) => /^f:from\(edge\(/.test(n)).length, 17, "every edge of the L but its inside corner");
  assert.ok(!faces(out.engine).includes("f:from(edge(e1:side:c|e1:side:d))"));
  const inside = await run([...L(), cf("f", "cf-geo-auto-fillet", { which: "concave", size: 3 })]);
  allOk(inside.r);
  near(vol(inside.k, inside.engine), 18000 + (1 - Math.PI / 4) * 9 * 20, 1e-6);       // only the inside corner, filled in
  assert.deepEqual(faces(inside.engine).filter((n) => /^f:/.test(n)), ["f:from(edge(e1:side:c|e1:side:d))"]);
  const bevel = await run([...L(), cf("f", "cf-geo-auto-fillet", { which: "all", kind: "chamfer", size: 1.5, exclude: [face("e1", "e1:start:a")] })]);
  allOk(bevel.r);
  assert.equal(faces(bevel.engine).filter((n) => /^f:from\(edge\(/.test(n)).length, 12, "the six edges round the bottom are left sharp");
  near(box(bevel.k, bevel.engine)[2], 0, 1e-9);
  const round = await run([...post(), cf("f", "cf-geo-auto-fillet", { size: 2 })]);
  allOk(round.r);
  assert.equal(faces(round.engine).length, 5);
  // sharper than 100°: nothing on a block, whose edges all turn 90°
  failsWith((await run([...block(), cf("f", "cf-geo-auto-fillet", { minAngle: 100 })])).r, "f", /No edge passes the filter/);
  failsWith((await run([...L(), cf("f", "cf-geo-auto-fillet", { size: 12 })])).r, "f", /cannot be rounded together/);
});

test("slices: sections on parallel planes, as flat surfaces a profile can be made of, or as curves", async () => {
  const a = await run([...post(), cf("s", "cf-geo-slice"), extrude("up", null, { profile: { sketch: null, regions: null, faces: [face("s:s2", "s:s2:1")] }, depth: 3 })]);
  allOk(a.r);
  const sheets = bodies(a.engine).filter((b) => b.sheet);
  assert.deepEqual(sheets.map((b) => b.name), ["Slice 1", "Slice 2", "Slice 3", "Slice 4"]);
  sheets.forEach((b, i) => { near(areaOf(a.k, b.shape), Math.PI * 400, 1e-9); near(a.k.centre(b.topo.faces[0].shape, "face")[2], 5 + 10 * i, 1e-9); });
  near(vol(a.k, a.engine, "up"), Math.PI * 400 * 3, 1e-6, "a slice is extruded as a sketch region would be");
  const c = await run([...L(), cf("s", "cf-geo-slice", { plane: right, offset: 5, count: 5, spacing: 10, output: "curves" })]);
  assert.equal(report(c.r, "s").status, "warning"); assert.match(report(c.r, "s").message, /1 of the 5 planes miss/);
  const d = datumOf(c.r, "s"); assert.equal(d.kind, "curve");
  const xs = new Set(pointsOf(d).filter((p) => !Number.isNaN(p[0])).map((p) => Math.round(p[0])));
  assert.deepEqual(Array.from(xs).sort((p, q) => p - q), [5, 15, 25, 35]);
  failsWith((await run([...post(), cf("s", "cf-geo-slice", { offset: 100 })])).r, "s", /None of the planes cuts/);
});

test("scale: evenly any body; unevenly bodies of flat, blended and free-form faces; names kept", async () => {
  const even = await run([...plate(30, 30), cf("s", "cf-geo-scale", { bodies: ["e1"], even: true, factor: 2 })]);
  allOk(even.r);
  near(vol(even.k, even.engine), 8 * (SLAB - HOLE), 1e-9);
  assert.deepEqual(box(even.k, even.engine).map((v) => Math.round(v * 1e6) / 1e6), [-50, -30, -2.5, 150, 90, 7.5]);     // about its middle
  assert.ok(faces(even.engine).includes("cut:side:h"));
  const flat = await run([...block(), cf("s", "cf-geo-scale", { bodies: ["e1"], x: 2, y: 1, z: 0.5, about: "origin" })]);
  allOk(flat.r);
  assert.deepEqual(box(flat.k, flat.engine).map((v) => Math.round(v * 1e6) / 1e6), [0, 0, 0, 80, 30, 10]);
  near(vol(flat.k, flat.engine), 24000, 1e-9);
  assert.deepEqual(faces(flat.engine).slice().sort(), ["e1:end:pa", "e1:side:pa", "e1:side:pb", "e1:side:pc", "e1:side:pd", "e1:start:pa"]);
  assert.ok(flat.k.faceFrame(body(flat.engine).topo.faces.find((f) => f.name === "e1:end:pa").shape), "a flat face is still a plane");
  // a block with every outside edge rounded: cylinders, and balls at the corners
  const model = [...block(), cf("f", "cf-geo-auto-fillet", { size: 3 })];
  const before = await run(model);
  const blended = await run([...model, cf("s", "cf-geo-scale", { bodies: ["e1"], x: 1.2, y: 0.8, z: 1.5, copy: true })]);
  allOk(blended.r);
  near(vol(blended.k, blended.engine, "s:e1"), vol(before.k, before.engine) * 1.2 * 0.8 * 1.5, 1e-5);
  assert.ok(valid(blended.k, body(blended.engine, "s:e1").shape));
  assert.deepEqual(faces(blended.engine, "s:e1").slice().sort(), faces(before.engine).slice().sort());
  near(vol(blended.k, blended.engine, "e1"), vol(before.k, before.engine), 1e-12);
  // NOT DONE, and said so: a face that goes all the way round
  failsWith((await run([...post(), cf("s", "cf-geo-scale", { bodies: ["e1"], x: 2, y: 1, z: 1 })])).r, "s", /goes all the way round/);
  failsWith((await run([...block(), cf("s", "cf-geo-scale", { bodies: ["e1"], x: 1, y: 1, z: 1 })])).r, "s", /Every factor is 1/);
});

test("defaults build in about a second each (the slow ones are named)", async () => {
  // what a person gets on choosing the tool and picking what it asks for; times are on this machine, under the test
  const cases = { "cf-geo-voronoi": { face: TOP }, "cf-geo-halftone": { face: TOP }, "cf-geo-texture": { face: TOP }, "cf-geo-qr-code": { target: TOP }, "cf-geo-text": { target: TOP } };
  const times = {};
  for (const [type, o] of Object.entries(cases)) { const x = await run([...slab(), cf("x", type, o)]); allOk(x.r); times[type] = ms(x.r, "x"); }
  console.log("# default build times (ms):", JSON.stringify(times));
  for (const [type, t] of Object.entries(times)) assert.ok(t < 15000, `${type} took ${t} ms`);
});
