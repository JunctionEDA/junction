// Node test for the fabrication custom features (web/domains/mechanical/features/cf-fab-*.ts, kernel/ops/
// cf-fab.ts): laser and CNC joints, 3D printing details.  The real OpenCascade build runs here; each feature
// is built with its defaults and once more with other values, and measured.
// Run: node server/static/tests/cad-cf-fab.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const server = path.join(__dirname, "..", "..");
const esbuild = require(path.join(server, "node_modules", "esbuild"));

execFileSync(process.execPath, [path.join(server, "scripts", "gen-cad-registry.mjs")]);
const bundle = esbuild.buildSync({ entryPoints: [path.join(server, "web", "domains", "mechanical", "kernel", "index.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const M = { exports: {} }; new Function("module", "exports", "require", bundle.outputFiles[0].text)(M, M.exports, require);
const K = M.exports;

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}

const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: "point", x: x0, y: y0 }, [`${p}2`]: { type: "point", x: x1, y: y0 }, [`${p}3`]: { type: "point", x: x1, y: y1 }, [`${p}4`]: { type: "point", x: x0, y: y1 },
  [`${p}a`]: { type: "line", a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: "line", a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: "line", a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: "line", a: `${p}4`, b: `${p}1` },
});
const points = (pts, p) => Object.fromEntries(pts.map((q, i) => [`${p}${i + 1}`, { type: "point", x: q[0], y: q[1] }]));
const top = { kind: "plane", plane: "top" }, front = { kind: "plane", plane: "front" }, right = { kind: "plane", plane: "right" };
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const defaults = (type) => { const d = K.FEATURES.find((f) => f.type === type); assert.ok(d, `no feature type ${type}`); return d.defaults(); };
const cf = (id, type, params = {}) => ({ id, type, name: id, suppressed: false, params: { ...defaults(type), ...params } });
const face = (body, name) => ({ kind: "face", body, name });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const statuses = (r) => r.features.map((f) => `${f.id}:${f.status}${f.message ? " (" + f.message + ")" : ""}`);
const allOk = (r) => assert.ok(r.features.every((f) => f.status === "ok"), statuses(r).join("\n"));
const failed = (r, id, re) => { const f = r.features.find((x) => x.id === id); assert.equal(f.status, "error", statuses(r).join("\n")); assert.match(f.message, re); };

const slow = [];
async function run(features) {
  const k = await boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate(features, features.length);
  for (const f of r.features) {
    const src = features.find((x) => x.id === f.id);
    if (!/^cf-fab-/.test(src.type)) continue;
    if (f.ms > 1500) slow.push(`${src.type}: ${Math.round(f.ms)} ms`);
    if (process.env.CAD_TIMES) console.log(`# ${Math.round(f.ms)} ms ${src.type} ${f.status}`);
  }
  const all = engine.entries[engine.entries.length - 1].state.bodies;
  const body = (id) => { const b = all.find((x) => x.id === id); assert.ok(b, `no body ${id} among ${all.map((x) => x.id).join(", ")}`); return b; };
  const vol = (id) => k.volume(body(id).shape);
  const box = (id) => { const b = new k.oc.Bnd_Box(); k.oc.BRepBndLib.Add(body(id).shape, b, false); const o = [b.GetXMin(), b.GetYMin(), b.GetZMin(), b.GetXMax(), b.GetYMax(), b.GetZMax()].map((v) => Math.round(v * 1e4) / 1e4 + 0); b.delete(); return o; };
  const common = (a, b) => { const range = new k.oc.Message_ProgressRange(); const c = new k.oc.BRepAlgoAPI_Common(body(a).shape, body(b).shape, range); c.Build(range); return k.volume(c.Shape()); };
  const names = (id) => body(id).topo.faces.map((f) => f.name);
  const valid = (id) => { const an = new k.oc.BRepCheck_Analyzer(body(id).shape, true, false); const ok = an.IsValid(); an.delete(); return ok; };
  return { k, engine, r, all, body, vol, box, common, names, valid, ms: (id) => r.features.find((f) => f.id === id).ms };
}

/** Two plates meeting at a corner along Y: a flat one (100 × 60 × 4 on the top plane) and an upright one at its x = 0 end, overlapping by the thickness. */
const corner = () => [
  sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }),
  sketch("s2", rect(0, 0, 60, 50, "q"), right), extrude("wall", "s2", { depth: 4 }),
];
/** A board lying flat (100 × 40 × 18) whose x = 100 end butts against an upright board (18 thick). */
const butt = (w = 40) => [
  sketch("s1", rect(0, 0, 100, w, "p")), extrude("rail", "s1", { depth: 18 }),
  sketch("s2", rect(100, -20, 118, w + 20, "q")), extrude("stile", "s2", { depth: 60 }),
];
/** A block 60 × 40 × 10 under the top plane, and a sketch of points on its top. */
const block = (pts = [[20, 20]]) => [
  sketch("s1", rect(0, 0, 60, 40, "p")), extrude("blk", "s1", { depth: 10, flip: true }),
  sketch("pts", points(pts, "h")),
];
const onPoints = { sketch: "pts", regions: null };
/** The volume a closed half profile of (radius, height) points sweeps round the axis. */
const turned = (pts) => Math.abs(pts.reduce((a, q, i) => { const n = pts[(i + 1) % pts.length]; return a + (q[0] * q[0] + q[0] * n[0] + n[0] * n[0]) * (n[1] - q[1]); }, 0)) * Math.PI / 3;
const shoelace = (pts) => Math.abs(pts.reduce((a, q, i) => { const n = pts[(i + 1) % pts.length]; return a + q[0] * n[1] - n[0] * q[1]; }, 0)) / 2;
const railEnd = face("rail", "rail:side:pb");

test("every fabrication feature is in the Custom features menu with an icon and words to find it by", () => {
  const mine = K.FEATURES.filter((f) => f.type.startsWith("cf-fab-"));
  assert.equal(mine.length, 25);
  for (const f of mine) {
    assert.equal(f.toolbarSection, "library", f.type);
    assert.ok(f.toolbarMenu === "Laser & CNC" || f.toolbarMenu === "3D printing", f.type);
    assert.equal(f.toolbarKeep, 0, f.type);
    assert.ok(f.icon && f.hint && f.keywords, f.type);
  }
  assert.equal(new Set(mine.map((f) => f.icon)).size, mine.length, "every icon is its own");
  assert.equal(mine.filter((f) => f.toolbarMenu === "Laser & CNC").length, 15);
  // the assistant's cad_feature_types is made from the same registry: every one has fields to describe
  for (const f of mine) assert.ok(f.schema.length >= 2 && f.schema.every((x) => x.key in f.defaults()), f.type);
  assert.equal(new Set(mine.map((f) => f.title)).size, mine.length);
});

test("laser joint: fingers along the overlap of two plates, each keeping every other one", async () => {
  const { r, vol, common, valid } = await run([...corner(), cf("j", "cf-fab-laser-joint")]);
  allOk(r);
  // the overlap is 4 × 4 × 60: 5 fingers of 12 (10 asked, odd count), 3 kept by the first plate
  near(vol("flat"), 100 * 60 * 4 - 2 * 12 * 16);
  near(vol("wall"), 60 * 50 * 4 - 3 * 12 * 16);
  near(common("flat", "wall"), 0, 1e-6);
  assert.ok(valid("flat") && valid("wall"));
});

test("laser joint: kerf leaves the fingers wider than their slots, clearance narrower", async () => {
  const tight = await run([...corner(), cf("j", "cf-fab-laser-joint", { kerf: 0.2 })]);
  allOk(tight.r);
  // every boundary between fingers moves by half the kerf on each plate: 4 boundaries, overlap 0.2 × 16 each
  near(tight.common("flat", "wall"), 4 * 0.2 * 16, 1e-6);
  const loose = await run([...corner(), cf("j", "cf-fab-laser-joint", { clearance: 0.3, fingerWidth: 6 })]);
  allOk(loose.r);
  near(loose.common("flat", "wall"), 0, 1e-6);
  // 60 / 6 = 10, made odd: 9 fingers; 8 boundaries each opened by 0.3
  near(loose.vol("flat") + loose.vol("wall"), 100 * 60 * 4 + 60 * 50 * 4 - 60 * 16 - 8 * 0.3 * 16, 1e-6);
});

test("laser joint: a plate through the middle of another gets tabs, the other closed slots", async () => {
  const { r, vol, names } = await run([
    sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }),
    sketch("s2", rect(10, 0, 50, 30, "q"), front), extrude("rib", "s2", { depth: 4, flip: true }),
    cf("j", "cf-fab-laser-joint", { fingerWidth: 8 }),
  ]);
  allOk(r);
  // the overlap is 40 long: 5 fingers of 8; the flat plate carries on past it, so it keeps the ends: 2 slots
  near(vol("flat"), 100 * 60 * 4 - 2 * 8 * 16);
  near(vol("rib"), 40 * 30 * 4 - 3 * 8 * 16);
  assert.ok(names("flat").some((n) => n.startsWith("j:j(flat,rib):2:")));
  const none = await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), sketch("s2", rect(0, 0, 10, 10, "q"), { kind: "plane", plane: "top" }), extrude("far", "s2", { depth: 4, flip: true }), cf("j", "cf-fab-laser-joint")]);
  failed(none.r, "j", /overlap/);
});

test("box joint: a counted row of fingers, the first board on both ends", async () => {
  const { r, vol, common } = await run([...corner(), cf("j", "cf-fab-box-joint", { bodies: ["flat", "wall"], gap: 0 })]);
  allOk(r);
  const w = 60 / 7;
  near(vol("flat"), 100 * 60 * 4 - 3 * w * 16);
  near(vol("wall"), 60 * 50 * 4 - 4 * w * 16);
  near(common("flat", "wall"), 0, 1e-6);
  const swapped = await run([...corner(), cf("j", "cf-fab-box-joint", { count: 5, swap: true, gap: 0.2 })]);
  allOk(swapped.r);
  near(swapped.vol("wall"), 60 * 50 * 4 - (2 * 12 + 2 * 0.1 * 2) * 16, 1e-6);
  near(swapped.vol("flat"), 100 * 60 * 4 - (3 * 12 + 4 * 0.1) * 16, 1e-6);
});

test("tab and slot: tabs on the edge face, slots in the plate against it", async () => {
  const { r, vol, common, names } = await run([...butt(), cf("t", "cf-fab-tab-slot", { face: railEnd })]);
  allOk(r);
  near(vol("rail"), 100 * 40 * 18 + 2 * 10 * 18 * 3);
  near(vol("stile"), 18 * 80 * 60 - 2 * 10 * 18 * 3);
  near(common("rail", "stile"), 0, 1e-6);
  assert.ok(names("rail").includes("t:tab1:end") && names("stile").includes("t:slot2:end"));
  const loose = await run([...butt(), cf("t", "cf-fab-tab-slot", { face: railEnd, count: 3, width: 8, length: 5, clearance: 0.2, kerf: 0.05 })]);
  allOk(loose.r);
  near(loose.vol("stile"), 18 * 80 * 60 - 3 * 8.15 * 18.075 * 5.15, 1e-6);
  failed((await run([...butt(), cf("t", "cf-fab-tab-slot", { face: railEnd, count: 5 })])).r, "t", /do not fit/);
  failed((await run([...butt(), cf("t", "cf-fab-tab-slot")])).r, "t", /Pick the edge face/);
});

test("T-slot joint: a T through the plate for bolt and nut, a clearance hole in the plate against it", async () => {
  const { r, vol } = await run([...butt(), cf("t", "cf-fab-tslot", { face: railEnd, boltLength: 30, mate: 18 })]);
  allOk(r);
  // M3: bolt slot 3.2 wide and 13 deep (12 of bolt and 1 over); nut slot 5.7 wide, 2.6 long
  near(vol("rail"), 100 * 40 * 18 - (3.2 * 13 + (5.7 - 3.2) * 2.6) * 18, 1e-6);
  near(vol("stile"), 18 * 80 * 60 - Math.PI * 1.6 * 1.6 * 18, 1e-6);
  const two = await run([...butt(), cf("t", "cf-fab-tslot", { face: railEnd, size: "M4", boltLength: 35, mate: 18, count: 2, nutDistance: 6, clearance: 0.3, kerf: 0.1 })]);
  allOk(two.r);
  near(two.vol("rail"), 100 * 40 * 18 - 2 * (4.2 * 18 + (7.2 - 4.2) * 3.4) * 18, 1e-6);
  failed((await run([...butt(), cf("t", "cf-fab-tslot", { face: railEnd, boltLength: 6, mate: 5 })])).r, "t", /longer bolt/);
});

/** A 100 × 60 × 4 plate with a 20 × 20 pocket through it. */
const pocketed = () => [
  sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }),
  sketch("s2", rect(40, 20, 60, 40, "q")), extrude("cut", "s2", { depth: 4, operation: "remove" }),
];
const flatTop = face("flat", "flat:end:pa");

test("dogbone: every inside corner along the cutter gets a relief through the corner", async () => {
  const rr = 3.175 / 2;
  const { r, vol, valid } = await run([...pocketed(), cf("d", "cf-fab-dogbone", { faces: [flatTop] })]);
  allOk(r);
  near(vol("flat"), (100 * 60 - 400) * 4 - 4 * rr * rr * (Math.PI / 2 - 1) * 4, 1e-6);
  assert.ok(valid("flat"));
  const t = await run([...pocketed(), cf("d", "cf-fab-dogbone", { faces: [flatTop], style: "tbone", diameter: 6 })]);
  allOk(t.r);
  near(t.vol("flat"), (100 * 60 - 400) * 4 - 4 * (Math.PI * 9 / 2) * 4, 1e-6);
  failed((await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("d", "cf-fab-dogbone", { faces: [flatTop] })])).r, "d", /no inside corner/);
});

test("kerf compensation: the outline grows by half the kerf, holes shrink, names stay", async () => {
  const before = await run(pocketed());
  const { r, vol, names, box } = await run([...pocketed(), cf("k", "cf-fab-kerf")]);
  allOk(r);
  near(vol("flat"), (100.2 * 60.2 - 19.8 * 19.8) * 4, 1e-6);
  assert.deepEqual(box("flat"), [-0.1, -0.1, 0, 100.1, 60.1, 4]);
  assert.deepEqual(names("flat").slice().sort(), before.names("flat").slice().sort());
  const inward = await run([...pocketed(), cf("k", "cf-fab-kerf", { kerf: -1 })]);
  allOk(inward.r);
  near(inward.vol("flat"), (99 * 59 - 21 * 21) * 4, 1e-6);
  // a part that is not a plate is refused
  const wedge = await run([...corner(), { id: "u", type: "boolean", name: "u", suppressed: false, params: { ...defaults("boolean"), operation: "union", bodies: ["flat", "wall"], tools: ["wall"], targets: ["flat"] } }, cf("k", "cf-fab-kerf")]);
  if (wedge.r.features.find((f) => f.id === "u").status === "ok") failed(wedge.r, "k", /not a flat plate/);
});

test("living hinge: staggered slits across a band, the plate still one piece", async () => {
  const { r, vol, all, ms } = await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("h", "cf-fab-living-hinge", { face: flatTop })]);
  allOk(r);
  // 15 rows 2 mm apart: 8 with two inner slits of 20, 7 with one of 20 and two of 17 that run out
  near(vol("flat"), 100 * 60 * 4 - 0.3 * 4 * (8 * 40 + 7 * 54), 1e-6);
  assert.equal(all.length, 1);
  const long = await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("h", "cf-fab-living-hinge", { face: flatTop, axis: "long", band: 10, offset: 10, slit: 30, bridge: 4, pitch: 3, width: 1 })]);
  allOk(long.r);
  assert.ok(long.vol("flat") < 100 * 60 * 4 - 200);
  failed((await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("h", "cf-fab-living-hinge", { face: flatTop, offset: 40 })])).r, "h", /does not fit/);
});

test("auto layout: parts laid flat in rows on a sheet, copied or moved, turned unless the grain is locked", async () => {
  const { r, all, box, vol, body, names } = await run([...corner(), cf("n", "cf-fab-nest")]);
  allOk(r);
  assert.deepEqual(all.map((b) => b.id), ["flat", "wall", "n:flat", "n:wall", "n:sheet1"]);
  assert.deepEqual(box("n:flat"), [5, 5, 0, 105, 65, 4]);
  assert.deepEqual(box("n:wall"), [108, 5, 0, 158, 65, 4]);   // turned to stand in the row: narrower
  near(vol("n:wall"), 60 * 50 * 4);
  assert.ok(body("n:sheet1").reference);
  assert.deepEqual(names("n:wall").slice().sort(), names("wall").slice().sort());
  const moved = await run([...corner(), cf("n", "cf-fab-nest", { sheetLength: 110, sheetWidth: 130, move: true, sheets: false })]);
  allOk(moved.r);
  assert.deepEqual(moved.all.map((b) => b.id), ["flat", "wall"]);
  assert.deepEqual(moved.box("wall"), [5, 68, 0, 65, 118, 4]);
  const turned = await run([...corner(), cf("n", "cf-fab-nest", { sheetLength: 70, sheetWidth: 200 })]);
  allOk(turned.r);
  assert.deepEqual(turned.box("n:flat"), [5, 5, 0, 65, 105, 4]);
  failed((await run([...corner(), cf("n", "cf-fab-nest", { sheetLength: 70, sheetWidth: 200, grain: true })])).r, "n", /larger than the sheet with its long side/);
});

test("box generator: panels that fill the walls exactly once, open, closed or with a lift-off lid", async () => {
  const open = await run([cf("b", "cf-fab-box")]);
  allOk(open.r);
  const ids = ["b:front", "b:back", "b:left", "b:right", "b:bottom"];
  assert.deepEqual(open.all.map((b) => b.id), ids);
  near(ids.reduce((a, id) => a + open.vol(id), 0), 100 * 60 * 40 - 94 * 54 * 37, 1e-9);
  for (let i = 0; i < ids.length; i++) { assert.ok(open.valid(ids[i]), ids[i]); for (let j = i + 1; j < ids.length; j++) near(open.common(ids[i], ids[j]), 0, 1e-6); }
  assert.deepEqual(open.box("b:front"), [-50, -30, 0, 50, -27, 40]);
  assert.deepEqual(open.box("b:left"), [-50, -30, 0, -47, 30, 40]);
  // the front keeps its corners: full width at the bottom; the bottom gives them up
  assert.ok(open.vol("b:front") > open.vol("b:back") - 1e-6 && open.vol("b:front") > 100 * 40 * 3 * 0.8);
  const closed = await run([cf("b", "cf-fab-box", { inside: true, lid: "jointed", fingerWidth: 7 })]);
  allOk(closed.r);
  const six = [...ids, "b:lid"];
  assert.deepEqual(closed.all.map((b) => b.id), six);
  near(six.reduce((a, id) => a + closed.vol(id), 0), 106 * 66 * 46 - 100 * 60 * 40, 1e-9);
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) near(closed.common(six[i], six[j]), 0, 1e-6);
  near(closed.vol("b:lid"), closed.vol("b:bottom"), 1e-9);
  // kerf: every joint is drawn tight by the width of the cut
  const tight = await run([cf("b", "cf-fab-box", { kerf: 0.15 })]);
  allOk(tight.r);
  assert.ok(tight.common("b:front", "b:left") > 0.1 && tight.common("b:left", "b:bottom") > 0.1 && tight.common("b:front", "b:bottom") > 0.1);
  assert.ok(tight.common("b:front", "b:left") < 20);
  const lift = await run([cf("b", "cf-fab-box", { lid: "liftoff" })]);
  allOk(lift.r);
  assert.deepEqual(lift.box("b:lid"), [-50, -30, 40, 50, 30, 43]);
  assert.deepEqual(lift.box("b:lid-key"), [-46.7, -26.7, 37, 46.7, 26.7, 40]);
  failed((await run([cf("b", "cf-fab-box", { width: 8 })])).r, "b", /too small/);
});

test("press-fit test comb: slots a step apart around the nominal thickness", async () => {
  const { r, vol, box, names } = await run([cf("c", "cf-fab-fit-comb")]);
  allOk(r);
  near(vol("c"), (85 * 18 - 4.8 * 4.8 / 2 - 2.25 - 21 * 10) * 3, 1e-9);
  assert.deepEqual(box("c"), [-42.5, 0, 0, 42.5, 18, 3]);
  assert.ok(names("c").includes("c:slot4-floor") && names("c").includes("c:mark"));
  const five = await run([cf("c", "cf-fab-fit-comb", { thickness: 6, step: 0.1, count: 5, depth: 12, land: 10 })]);
  allOk(five.r);
  // widths 5.8, 5.9, 6, 6.1, 6.2
  near(five.vol("c"), (90 * 22 - 18 - 2.25 - 30 * 12) * 6, 1e-9);
  failed((await run([cf("c", "cf-fab-fit-comb", { thickness: 1, step: 0.5, count: 7 })])).r, "c", /no width/);
});

test("mortise and tenon: a tenon on the rail's end, a mortise with clearance in the stile", async () => {
  const { r, vol, names } = await run([...butt(), cf("m", "cf-fab-mortise-tenon", { face: railEnd })]);
  allOk(r);
  near(vol("rail"), 100 * 40 * 18 + 30 * 6 * 20, 1e-9);
  near(vol("stile"), 18 * 80 * 60 - 30.2 * 6.2 * 18, 1e-9);
  assert.ok(names("rail").includes("m:tenon:end"));
  const round = await run([...butt(), cf("m", "cf-fab-mortise-tenon", { face: railEnd, round: true, length: 10, thickness: 8, shoulder: 4, clearance: 0, glueGap: 2 })]);
  allOk(round.r);
  const a = 24 * 8 + Math.PI * 16;
  near(round.vol("rail"), 100 * 40 * 18 + a * 10, 1e-7);
  near(round.vol("stile"), 18 * 80 * 60 - a * 12, 1e-7);
  near(round.common("rail", "stile"), 0, 1e-6);
  failed((await run([...butt(), cf("m", "cf-fab-mortise-tenon", { face: railEnd, shoulder: 19 })])).r, "m", /shoulders/);
});

test("dovetail joint: tails that widen toward the board's end, sockets to match", async () => {
  const { r, vol, common, names } = await run([...corner(), cf("d", "cf-fab-dovetail", { bodies: ["flat", "wall"] })]);
  allOk(r);
  const narrow = 7 - 4 * Math.tan(9.5 * Math.PI / 180), tails = 3 * (7 + narrow) * 4 * 4;
  near(vol("flat"), 100 * 60 * 4 - (60 * 16 - tails), 1e-9);
  near(vol("wall"), 60 * 50 * 4 - tails, 1e-9);
  near(common("flat", "wall"), 0, 1e-6);
  assert.ok(names("flat").includes("d:tail2:left") && names("wall").includes("d:tail2:right"));
  // the tail is wider at the end of its board (x = 0) than at the baseline (x = 4)
  const swapped = await run([...corner(), cf("d", "cf-fab-dovetail", { tails: 2, angle: 14, pin: 8, clearance: 0.1, swap: true })]);
  allOk(swapped.r);
  const n2 = 11 - 4 * Math.tan(14 * Math.PI / 180), t2 = 2 * (11 + n2) * 4 * 4;
  near(swapped.vol("wall"), 60 * 50 * 4 - (60 * 16 - t2), 1e-9);
  near(swapped.vol("flat"), 100 * 60 * 4 - t2 - 2 * 0.2 * 4 * 4, 1e-9);
  failed((await run([...corner(), cf("d", "cf-fab-dovetail", { tails: 12 })])).r, "d", /no neck/);
});

test("dowel and biscuit holes: the same holes in both boards across the joint face", async () => {
  const { r, vol, names } = await run([...butt(), cf("d", "cf-fab-dowel", { face: railEnd })]);
  allOk(r);
  near(vol("rail"), 100 * 40 * 18 - 2 * Math.PI * 16 * 15, 1e-9);
  near(vol("stile"), 18 * 80 * 60 - 2 * Math.PI * 16 * 15, 1e-9);
  assert.ok(names("rail").includes("d:d1:wall") && names("stile").includes("d:d2:wall"));
  const b = await run([...butt(100), cf("d", "cf-fab-dowel", { face: railEnd, kind: "biscuit", count: 1 })]);
  allOk(b.r);
  // a #20 slot: the 12 mm deep segment of a 100 mm blade, 4 mm thick, in each board
  const seg = 2500 * Math.acos(38 / 50) - 38 * Math.sqrt(2500 - 38 * 38);
  near(b.vol("rail"), 100 * 100 * 18 - seg * 4, 1e-7);
  near(b.vol("stile"), 18 * 140 * 60 - seg * 4, 1e-7);
  failed((await run([...butt(), cf("d", "cf-fab-dowel", { face: railEnd, kind: "biscuit" })])).r, "d", /fewer or smaller biscuits/);
  failed((await run([...butt(), cf("d", "cf-fab-dowel", { face: railEnd, diameter: 17 })])).r, "d", /too thick/);
});

test("pocket hole: a stepped hole at the jig's angle, out through the middle of the board's end", async () => {
  const one = await run([...butt(), cf("p", "cf-fab-pocket-hole", { face: railEnd, count: 1 })]);
  allOk(one.r);
  const removed = 100 * 40 * 18 - one.vol("rail");
  assert.ok(removed > 1400 && removed < 2000, `one pocket removes ${removed}`);
  near(one.vol("stile"), 18 * 80 * 60, 1e-9);
  assert.ok(one.names("rail").includes("p:h1:seat") && one.names("rail").includes("p:h1:pilot") && one.names("rail").includes("p:h1:pocket"));
  assert.ok(one.valid("rail"));
  const two = await run([...butt(), cf("p", "cf-fab-pocket-hole", { face: railEnd, flip: true })]);
  allOk(two.r);
  near(100 * 40 * 18 - two.vol("rail"), 2 * removed, 1e-6);
  failed((await run([...butt(), cf("p", "cf-fab-pocket-hole", { face: railEnd, pocket: 20 })])).r, "p", /too thin/);
});

test("puzzle joint: the plate in two pieces that lock, nothing lost", async () => {
  const { r, vol, common, all, names } = await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("z", "cf-fab-puzzle", { face: flatTop })]);
  allOk(r);
  assert.deepEqual(all.map((b) => b.id), ["flat", "z:flat.b"]);
  // a knob: a neck 6 wide to where it meets the head, and the head less the cap the neck covers
  const knob = 6 * 4 + Math.PI * 25 - (25 * Math.acos(4 / 5) - 12);
  const vols = [vol("flat"), vol("z:flat.b")].sort((a, b) => a - b);
  near(vols[0], (3000 - knob) * 4, 1e-7);
  near(vols[1], (3000 + knob) * 4, 1e-7);
  near(common("flat", "z:flat.b"), 0, 1e-6);
  assert.ok(names("flat").includes("z:seam") && names("z:flat.b").some((n) => n.startsWith("z:k2:head")));
  const loose = await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("z", "cf-fab-puzzle", { face: flatTop, across: "short", offset: 5, count: 4, neck: 5, head: 9, reach: 7, clearance: 0.2 })]);
  allOk(loose.r);
  const lost = 100 * 60 * 4 - loose.vol("flat") - loose.vol("z:flat.b");
  assert.ok(lost > 4 * 0.2 * 20 * 4 * 0.8 && lost < 4 * 0.2 * 45 * 4, `the clearance takes ${lost}`);
  failed((await run([sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 }), cf("z", "cf-fab-puzzle", { face: flatTop, head: 5 })])).r, "z", /wider than the neck/);
});

test("snap-fit hook: a cantilever with a nose at each point, strain checked", async () => {
  const { r, vol, box, all } = await run([...block([[20, 20], [40, 20]]), cf("h", "cf-fab-snap-hook", { points: onPoints })]);
  allOk(r);
  const top = 15.6 + 2 / Math.tan(Math.PI / 6);
  const side = 2 * 15 + 2 * 0.25 * (1 - Math.PI / 4) + shoelace([[1, 15], [2, 15], [2, 15.6], [0, top], [-1, top], [-1, 15]]);
  assert.equal(all.length, 1);
  near(vol("blk"), 60 * 40 * 10 + 2 * side * 6, 1e-7);
  near(box("blk")[5], top, 1e-4);
  const loose = await run([...block(), cf("h", "cf-fab-snap-hook", { points: onPoints, operation: "new", back: 45, angle: 90, root: 0, width: 4 })]);
  allOk(loose.r);
  // turned a quarter: the nose points along y, and its return face climbs by the overhang
  assert.deepEqual(loose.box("h").slice(0, 2), [18, 19]);
  near(loose.box("h")[4], 22, 1e-6);
  const t2 = 16.6 + 2 / Math.tan(Math.PI / 6);
  const s2 = 2 * 15 + shoelace([[1, 15], [2, 16], [2, 16.6], [0, t2], [-1, t2], [-1, 15]]);
  near(loose.vol("h"), s2 * 4, 1e-7);
  const stiff = await run([...block(), cf("h", "cf-fab-snap-hook", { points: onPoints, length: 5 })]);
  const f = stiff.r.features.find((x) => x.id === "h");
  assert.equal(f.status, "warning");
  assert.match(f.message, /strains 12\.0 %/);
  failed((await run([...block(), cf("h", "cf-fab-snap-hook")])).r, "h", /Pick a sketch/);
});

test("annular snap fit: a plug with a bead, and the socket whose groove is the bead's mirror", async () => {
  const z3 = 6.5, z2 = z3 - 0.4 / Math.tan(Math.PI / 6), z1 = z2 - 0.36, z0 = z1 - 0.4;
  const plug = await run([...block(), cf("a", "cf-fab-snap-annular", { points: onPoints, operation: "new", slots: 0 })]);
  allOk(plug.r);
  near(plug.vol("a"), turned([[3, 0], [5, 0], [5, z0], [5.4, z1], [5.4, z2], [5, z3], [5, 7.25], [4.25, 8], [3, 8]]), 1e-7);
  const slit = await run([...block(), cf("a", "cf-fab-snap-annular", { points: onPoints })]);
  allOk(slit.r);
  assert.equal(slit.all.length, 1);
  assert.ok(slit.vol("blk") > 60 * 40 * 10 + 0.6 * plug.vol("a") && slit.vol("blk") < 60 * 40 * 10 + plug.vol("a"));
  assert.ok(slit.names("blk").some((n) => n.startsWith("a:h1:slot2:")) && slit.names("blk").some((n) => n.startsWith("a:h1:bead")));
  const socket = await run([...block(), cf("a", "cf-fab-snap-annular", { points: onPoints, part: "socket", operation: "new" })]);
  allOk(socket.r);
  near(socket.vol("a"), turned([[5.15, 0], [7.55, 0], [7.55, 8], [5.65, 8], [5.15, 7.5], [5.15, 8 - z0], [5.55, 8 - z1], [5.55, 8 - z2], [5.15, 8 - z3]]), 1e-7);
  assert.ok(socket.names("a").includes("a:h1:groove"));
  failed((await run([...block(), cf("a", "cf-fab-snap-annular", { points: onPoints, height: 2 })])).r, "a", /does not fit/);
});

test("heat-set insert hole: sized from the table, deeper than the insert, with a lead-in", async () => {
  const { r, vol, names } = await run([...block([[20, 20], [40, 20]]), cf("i", "cf-fab-heat-insert", { points: onPoints })]);
  allOk(r);
  // M3: a 4.0 hole 5.7 + 1 deep with a 0.4 chamfer
  const hole = turned([[0, 0], [2.4, 0], [2, 0.4], [2, 6.7], [0, 6.7]]);
  near(vol("blk"), 60 * 40 * 10 - 2 * hole, 1e-7);
  assert.ok(names("blk").includes("i:h1:wall") && names("blk").includes("i:h2:floor") && names("blk").includes("i:h1:lead"));
  const thru = await run([...block(), cf("i", "cf-fab-heat-insert", { points: onPoints, size: "M4", extra: 0, chamfer: 0, screwHole: true })]);
  allOk(thru.r);
  // M4: 5.6 × 8.1, then a 4.5 clearance hole through the remaining 1.9
  near(thru.vol("blk"), 60 * 40 * 10 - Math.PI * 2.8 * 2.8 * 8.1 - Math.PI * 2.25 * 2.25 * 1.9, 1e-7);
  const own = await run([...block(), cf("i", "cf-fab-heat-insert", { points: onPoints, size: "custom", diameter: 5, length: 4, extra: 0.5, chamfer: 0 })]);
  allOk(own.r);
  near(own.vol("blk"), 60 * 40 * 10 - Math.PI * 6.25 * 4.5, 1e-7);
});

test("screw boss: proportioned by screw and plastic, with relief, draft and gussets", async () => {
  const { r, vol, all } = await run([...block(), cf("b", "cf-fab-screw-boss", { points: onPoints })]);
  allOk(r);
  assert.equal(all.length, 1);
  // a 3 mm screw in ABS: boss 6, pilot 2.4 to 8.4 deep, relief 3.2 × 0.9
  const boss = Math.PI * 9 * 10 - Math.PI * 1.6 * 1.6 * 0.9 - Math.PI * 1.2 * 1.2 * 7.5;
  near(vol("blk"), 60 * 40 * 10 + boss, 1e-7);
  const ribbed = await run([...block(), cf("b", "cf-fab-screw-boss", { points: onPoints, screw: "4", plastic: "pc", height: 12, draft: 2, gussets: 4, operation: "new" })]);
  allOk(ribbed.r);
  assert.ok(ribbed.valid("b"));
  // PC: boss 10 at the top, hole 3.4; drafted 2° it is wider at the foot; four gussets reach 4 mm past that
  const foot = 5 + 12 * Math.tan(2 * Math.PI / 180);
  const bare = turned([[0, 0], [foot, 0], [5, 12], [2.1, 12], [2.1, 10.8], [1.7, 10.8], [1.7, 0.8], [0, 0.8]]);
  assert.ok(ribbed.vol("b") > bare + 4 * 10 && ribbed.vol("b") < bare + 4 * 1.2 * 9 * 9 / 2, `${ribbed.vol("b")} against ${bare}`);
  const bb = ribbed.box("b");
  near(bb[3] - bb[0], 2 * (foot + 4), 1e-4);
  assert.ok(ribbed.names("b").some((n) => n.startsWith("b:h1:g3:slope")) && ribbed.names("b").includes("b:h1:pilot"));
  failed((await run([...block(), cf("b", "cf-fab-screw-boss", { points: onPoints, screw: "custom", bossDiameter: 3, holeDiameter: 2.4 })])).r, "b", /no wall/);
});

test("print-in-place hinge: two leaves that interleave and never touch, on cone pivots", async () => {
  const { k, r, body, common, box, valid, vol, ms } = await run([cf("h", "cf-fab-pip-hinge")]);
  allOk(r);
  assert.ok(valid("h:a") && valid("h:b"));
  near(common("h:a", "h:b"), 0, 1e-9);
  const d = new k.oc.BRepExtrema_DistShapeShape(), range = new k.oc.Message_ProgressRange();
  d.LoadS1(body("h:a").shape); d.LoadS2(body("h:b").shape); d.Perform(range);
  // the tightest place is the pivot: the clearance, square to the cone
  near(d.Value(), 0.3, 1e-3);
  d.delete(); range.delete();
  assert.deepEqual(box("h:a").map((v, i) => (i === 1 || i === 4 ? Math.round(v * 10) / 10 : v)).filter((_, i) => i !== 1), [-20, 0, 20, 24.4, 8]);
  assert.ok(box("h:b")[1] === -24.4 && box("h:b")[5] === 8);
  // five knuckles of 7.68 with 0.4 between: three on the first leaf
  assert.ok(vol("h:a") > 40 * 20 * 3 + 3 * Math.PI * 16 * 7.68 * 0.8 && vol("h:a") < 40 * 20 * 3 + 3 * Math.PI * 16 * 7.68 + 3 * 5 * 3 * 7.68 + 60);
  const seven = await run([cf("h", "cf-fab-pip-hinge", { length: 70, knuckles: 7, barrel: 10, thickness: 4, gap: 0.3, clearance: 0.2, plane: front })]);
  allOk(seven.r);
  near(seven.common("h:a", "h:b"), 0, 1e-9);
  failed((await run([cf("h", "cf-fab-pip-hinge", { knuckles: 4 })])).r, "h", /odd/);
  failed((await run([cf("h", "cf-fab-pip-hinge", { knuckles: 15 })])).r, "h", /too short/);
});

/** A block 60 × 40 × 20 centred on the origin's vertical axis, standing on the top plane. */
const centred = () => [sketch("s1", rect(-30, -20, 30, 20, "p")), extrude("blk", "s1", { depth: 20 })];

test("split with pins: two pieces, pins on one and sockets with clearance in the other", async () => {
  const { r, vol, all, names, common } = await run([...centred(), cf("sp", "cf-fab-split-pins", { plane: right })]);
  allOk(r);
  assert.deepEqual(all.map((b) => b.id), ["blk", "sp:blk.front"]);
  const pin = turned([[0, 0], [2, 0], [2, 3.2], [1.2, 4], [0, 4]]);
  near(vol("blk"), 30 * 40 * 20 + 2 * pin, 1e-7);
  near(vol("sp:blk.front"), 30 * 40 * 20 - 2 * Math.PI * 2.15 * 2.15 * 4.15, 1e-7);
  near(common("blk", "sp:blk.front"), 0, 1e-6);
  assert.ok(names("blk").includes("sp:pin1:side") && names("sp:blk.front").includes("sp:socket2:wall") && names("blk").some((n) => n.startsWith("sp:cut")));
  const loose = await run([...centred(), cf("sp", "cf-fab-split-pins", { plane: right, kind: "loose", count: 3, diameter: 1.75, length: 6, clearance: 0.1 })]);
  allOk(loose.r);
  const hole = Math.PI * 0.975 * 0.975 * 6.1;
  near(loose.vol("blk"), 30 * 40 * 20 - 3 * hole, 1e-7);
  near(loose.vol("sp:blk.front"), 30 * 40 * 20 - 3 * hole, 1e-7);
  // placed by a sketch on the plane, pins on the front piece
  const placed = await run([...centred(), sketch("pts", points([[5, 10]], "h"), right), cf("sp", "cf-fab-split-pins", { plane: right, points: onPoints, flip: true })]);
  allOk(placed.r);
  near(placed.vol("sp:blk.front"), 30 * 40 * 20 + pin, 1e-7);
  near(placed.vol("blk"), 30 * 40 * 20 - Math.PI * 2.15 * 2.15 * 4.15, 1e-7);
  failed((await run([...centred(), sketch("pts", points([[5, 10]], "h"), front), cf("sp", "cf-fab-split-pins", { plane: right, points: onPoints })])).r, "sp", /not on the split plane/);
  failed((await run([...centred(), cf("sp", "cf-fab-split-pins", { plane: right, diameter: 30 })])).r, "sp", /no room/);
  failed((await run([...centred(), cf("sp", "cf-fab-split-pins", { plane: front, bodies: ["blk"], count: 1 }), cf("sp2", "cf-fab-split-pins", { plane: right })])).r, "sp2", /Pick the part/);
});

test("teardrop hole: round below, a 45° roof above, pointed or flat", async () => {
  const blk = [sketch("s1", rect(0, 0, 60, 40, "p")), extrude("blk", "s1", { depth: 20 }), sketch("pts", points([[30, 10]], "h"), front)];
  const { r, vol, names } = await run([...blk, cf("t", "cf-fab-teardrop", { points: onPoints })]);
  allOk(r);
  near(vol("blk"), 60 * 40 * 20 - 9 * (0.75 * Math.PI + 1) * 40, 1e-7);
  assert.ok(names("blk").includes("t:h1:roof-l") && names("blk").includes("t:h1:wall"));
  const flat = await run([...blk, cf("t", "cf-fab-teardrop", { points: onPoints, diameter: 8, truncated: true, endType: "blind", depth: 5 })]);
  allOk(flat.r);
  near(flat.vol("blk"), 60 * 40 * 20 - 16 * (0.75 * Math.PI + 1 - (Math.SQRT2 - 1) ** 2) * 5, 1e-7);
  assert.ok(flat.names("blk").includes("t:h1:flat") && flat.names("blk").includes("t:h1:end"));
  // printed along −z the point is at the bottom: the same volume
  const down = await run([...blk, cf("t", "cf-fab-teardrop", { points: onPoints, up: "-z" })]);
  allOk(down.r);
  near(down.vol("blk"), vol("blk"), 1e-9);
  failed((await run([sketch("s1", rect(0, 0, 60, 40, "p")), extrude("blk", "s1", { depth: 20, flip: true }), sketch("pts", points([[30, 10]], "h")), cf("t", "cf-fab-teardrop", { points: onPoints })])).r, "t", /needs no teardrop/);
});

test("elephant-foot chamfer: the bed face's outline pulled in, holes widened", async () => {
  const frustum = (a, b, da, h) => (h / 6) * (a * b + (a + da) * (b + da) + 4 * (a + da / 2) * (b + da / 2));
  const { r, vol, names } = await run([sketch("s1", rect(0, 0, 60, 40, "p")), extrude("blk", "s1", { depth: 10 }), cf("e", "cf-fab-elephant-foot", { faces: [face("blk", "blk:start:pa")] })]);
  allOk(r);
  near(vol("blk"), 60 * 40 * 9.6 + frustum(59.4, 39.4, 0.6, 0.4), 1e-7);
  assert.equal(names("blk").filter((n) => n.startsWith("e:from(")).length, 4);
  assert.ok(names("blk").includes("blk:start:pa") && names("blk").includes("blk:side:pa"));
  const bed = face("flat", "flat:start:pa");
  const both = await run([...pocketed(), cf("e", "cf-fab-elephant-foot", { faces: [bed], inset: 0.2, height: 0.5 })]);
  allOk(both.r);
  near(both.vol("flat"), (100 * 60 - 400) * 3.5 + frustum(99.6, 59.6, 0.4, 0.5) - frustum(20.4, 20.4, -0.4, 0.5), 1e-7);
  const outer = await run([...pocketed(), cf("e", "cf-fab-elephant-foot", { faces: [bed], inset: 0.2, height: 0.5, holes: false })]);
  allOk(outer.r);
  near(outer.vol("flat"), (100 * 60 - 400) * 3.5 + frustum(99.6, 59.6, 0.4, 0.5) - 400 * 0.5, 1e-7);
  failed((await run([sketch("s1", rect(0, 0, 60, 40, "p")), extrude("blk", "s1", { depth: 10 }), cf("e", "cf-fab-elephant-foot")])).r, "e", /Pick the face/);
});

test("honeycomb pockets: whole hexagons inside the border, or trimmed to it, cut at once", async () => {
  const plate = [sketch("s1", rect(0, 0, 100, 60, "p")), extrude("flat", "s1", { depth: 4 })];
  const hex = (s) => (Math.sqrt(3) / 2) * s * s;
  const { r, vol, all, names, valid, ms } = await run([...plate, cf("h", "cf-fab-honeycomb", { face: flatTop })]);
  allOk(r);
  // 8 mm cells 9.5 apart, 3 mm in from the edge of a 100 × 60 face: five rows, of 9, 10, 9, 10 and 9
  const cells = (100 * 60 * 4 - vol("flat")) / (hex(8) * 2);
  near(cells, Math.round(cells), 1e-6);
  assert.equal(Math.round(cells), 47);
  assert.ok(valid("flat") && all.length === 1);
  assert.ok(names("flat").includes("h:c0.0:end") && names("flat").includes("h:c0.0:s3"));
  const trimmed = await run([...plate, cf("h", "cf-fab-honeycomb", { face: flatTop, edge: "trim", through: true, size: 12, wall: 2, border: 4, angle: 30 })]);
  allOk(trimmed.r);
  assert.equal(trimmed.all.length, 1);
  // trimmed cells fill the face inside the border but for the ribs: between the area of whole cells only and all of it
  const open = (100 * 60 * 4 - trimmed.vol("flat")) / 4, inner = 92 * 52;
  assert.ok(open > 0.6 * inner && open < 0.78 * inner, `${open} of ${inner}`);
  // nothing is cut within the border
  const frame = await run([...plate, cf("h", "cf-fab-honeycomb", { face: flatTop, edge: "trim", through: true, size: 12, wall: 2, border: 4, angle: 30 }), sketch("s2", rect(3.99, 3.99, 96.01, 56.01, "q")), extrude("core", "s2", { depth: 4, operation: "remove" })]);
  allOk(frame.r);
  near(frame.vol("flat"), (100 * 60 - 92.02 * 52.02) * 4, 1e-6);
  // a hole in the face keeps its border too
  const holed = await run([...pocketed(), cf("h", "cf-fab-honeycomb", { face: flatTop, through: true })]);
  allOk(holed.r);
  const n2 = ((100 * 60 - 400) * 4 - holed.vol("flat")) / (hex(8) * 4);
  near(n2, Math.round(n2), 1e-6);
  assert.equal(Math.round(n2), 30);   // the 20 × 20 hole and its border take 17 of the 47
  failed((await run([...plate, cf("h", "cf-fab-honeycomb", { face: flatTop, size: 1, wall: 0.2 })])).r, "h", /too many cells/);
  failed((await run([...plate, cf("h", "cf-fab-honeycomb", { face: flatTop, size: 70 })])).r, "h", /No cell fits/);
});

test("lattice infill: struts through every node, trimmed by the part or inside a skin, bounded", async () => {
  const cube = [sketch("s1", rect(-15, -15, 15, 15, "p")), extrude("blk", "s1", { depth: 30 })];
  const { r, vol, all, valid, ms } = await run([...cube, cf("l", "cf-fab-lattice")]);
  allOk(r);
  // nodes at −10, 0, 10 on each axis: 27 bars 2 × 2 × 30, less twice the 27 cubes where three cross
  near(vol("blk"), 27 * 4 * 30 - 2 * 27 * 8, 1e-7);
  assert.ok(valid("blk") && all.length === 1);
  const skinned = await run([...cube, cf("l", "cf-fab-lattice", { skin: 2 })]);
  allOk(skinned.r);
  near(skinned.vol("blk"), 27000 - (26 ** 3 - (27 * 4 * 26 - 2 * 27 * 8)), 1e-7);
  assert.ok(skinned.names("blk").includes("blk:end:pa"));
  const round = await run([...cube, cf("l", "cf-fab-lattice", { section: "round", cell: 12, strut: 3 })]);
  allOk(round.r);
  // nodes at −12, 0, 12: 27 round bars of 3; where three cross, the three pairs' overlaps less the part all three share
  const r3 = 1.5 ** 3, pair = 16 * r3 / 3, triple = 8 * (2 - Math.SQRT2) * r3;
  near(round.vol("blk"), 27 * Math.PI * 2.25 * 30 - 27 * (3 * pair - triple), 1e-5);
  const diag = await run([...cube, cf("l", "cf-fab-lattice", { kind: "diagonal", cell: 15, strut: 2 })]);
  allOk(diag.r);
  assert.ok(diag.vol("blk") > 1500 && diag.vol("blk") < 9000 && diag.all.length === 1, `diagonal lattice of ${diag.vol("blk")}`);
  failed((await run([...cube, cf("l", "cf-fab-lattice", { cell: 3, strut: 0.5 })])).r, "l", /at most 150/);
  failed((await run([...cube, cf("l", "cf-fab-lattice", { kind: "both", cell: 9, strut: 1 })])).r, "l", /diagonal struts \(at most 64\)/);
  failed((await run([...cube, cf("l", "cf-fab-lattice", { strut: 7 })])).r, "l", /too thick/);
  failed((await run([...corner(), cf("l", "cf-fab-lattice")])).r, "l", /Pick the part/);
});

test.after(() => { if (slow.length) console.log("slow features:\n  " + slow.join("\n  ")); });
