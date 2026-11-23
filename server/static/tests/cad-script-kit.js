// cad-script-kit.js — what the custom-feature tests share: the script kit bundled once (the sandbox, the
// regeneration engine and the features in one module, so they share state as they do in the worker), the real
// OpenCascade build, and a few plates to run scripts on.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");

let K = null, kernel = null;
function kit() { if (!K) K = load("domains/mechanical/script/kit.ts"); return K; }
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new (kit().Kernel)(oc);
  return kernel;
}

// ---- documents as worker inputs
const top = { kind: "plane", plane: "top" };
const sketch = (id, entities, plane = top) => ({ id, type: "sketch", name: id, suppressed: false, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, sk, o = {}) => ({ id, type: "extrude", name: id, suppressed: false, params: { profile: { sketch: sk, regions: null }, operation: "new", endType: "blind", depth: 10, flip: false, targets: [], ...o } });
const circle = (x, y, r, p) => ({ [`${p}c`]: { type: "point", x, y }, [`${p}`]: { type: "circle", center: `${p}c`, r } });
/** a closed polygon of lines through the points */
function polygon(points, p = "p") {
  const out = {};
  points.forEach(([x, y], i) => { out[`${p}${i}`] = { type: "point", x, y }; });
  points.forEach((_, i) => { out[`${p}l${i}`] = { type: "line", a: `${p}${i}`, b: `${p}${(i + 1) % points.length}` }; });
  return out;
}

/** A plate from an outline and round holes: [x, y, diameter]. */
function plate(outline, holes, thickness = 6) {
  let entities = { ...outline };
  holes.forEach(([x, y, d], i) => { entities = { ...entities, ...circle(x, y, d / 2, `h${i}`) }; });
  return [sketch("s", entities), extrude("plate", "s", { depth: thickness })];
}
/** 160 × 100 with one corner cut off, four M6 holes, a Ø22 bore and a Ø8 hole: not a rectangle, several holes. */
const PLATE_A = () => plate(polygon([[0, 0], [160, 0], [160, 60], [110, 100], [0, 100]]), [[12, 12, 6.6], [148, 12, 6.6], [12, 88, 6.6], [104, 88, 6.6], [70, 50, 22], [130, 45, 8]]);
/** A 200 × 80 plate with a half-round end and an L notch: arcs in the outline, five holes. */
const PLATE_B = () => {
  const e = {
    a: { type: "point", x: 0, y: 0 }, b: { type: "point", x: 160, y: 0 }, c: { type: "point", x: 160, y: 80 }, d: { type: "point", x: 60, y: 80 }, e: { type: "point", x: 60, y: 50 }, f: { type: "point", x: 0, y: 50 }, m: { type: "point", x: 160, y: 40 },
    l1: { type: "line", a: "a", b: "b" }, arc: { type: "arc", center: "m", start: "b", end: "c" }, l2: { type: "line", a: "c", b: "d" }, l3: { type: "line", a: "d", b: "e" }, l4: { type: "line", a: "e", b: "f" }, l5: { type: "line", a: "f", b: "a" },
  };
  return plate(e, [[12, 12, 5.5], [12, 38, 5.5], [72, 68, 5.5], [160, 40, 30], [110, 20, 10]], 8);
};
/** A plain 120 × 80 × 5 plate with no holes at all. */
const PLATE_C = () => plate(polygon([[0, 0], [120, 0], [120, 80], [0, 80]]), [], 5);

const scriptFeature = (id, source, values = {}) => ({ id, type: `script:test.${kit().sourceHash(source)}`, name: id, suppressed: false, params: { $script: { id: "test", name: id, hash: kit().sourceHash(source), source }, ...values } });
const exemplar = (id) => { const e = kit().EXEMPLARS.find((x) => x.id === id); if (!e) throw new Error(`no exemplar ${id}`); return e.source; };

/** Run a script as the last feature of a list and report (script/report.ts). */
async function run(features, source, values = {}, o = {}) {
  const k = await boot(), Kit = kit();
  const engine = new Kit.RegenEngine(k, Kit.FEATURES);
  try { return await Kit.runReport(k, engine, [...features, scriptFeature("cf", source, values)], "cf", { image: false, ...o }); }
  finally { engine.dispose(); }
}

module.exports = { kit, boot, server, sketch, extrude, circle, polygon, plate, PLATE_A, PLATE_B, PLATE_C, scriptFeature, exemplar, run };
