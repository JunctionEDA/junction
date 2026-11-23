// Node test: the custom features that ship (web/domains/mechanical/script/assets/exemplars), each run in the
// sandbox on real geometry with the real kernel, with the volume the geometry says it should have:
//   • Lighten plate: truss, isogrid and hex, through and to a depth, on plates with several holes and outlines
//     that are not rectangles; the margins hold, the plate stays in one piece, the solid is sound
//   • Hole-to-hole slot, Angle bracket, Vent pattern, Engrave text, and the guide's own first example
//   • every exemplar type-checks against the Feature API's type file
// Run: node server/static/tests/cad-script-exemplars.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("./cad-script-kit");

const K = T.kit(), G = K.Geo2;
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const ok = (r) => { assert.notEqual(r.status, "error", r.error && r.error.message); assert.equal(r.sound, true); return r; };
const report = (r, label) => { const x = r.reports.find((y) => y.label === label); return x ? x.value : null; };
const VA = 86596.524, VB = 101252.809;

/** Build a plate and a feature on it and hand back the engine, to look at the result. */
async function built(plate, source, values) {
  const k = await T.boot(), engine = new K.RegenEngine(k, K.FEATURES);
  const r = await engine.regenerate([...plate, T.scriptFeature("cf", source, values)], plate.length + 1);
  return { k, engine, rep: r.features[plate.length], body: engine.state.bodies[0] };
}
const flatFaces = (k, body, z) => body.topo.faces.filter((f) => { const fr = k.faceFrame(f.shape); return fr && Math.abs(fr.normal[2]) > 0.99 && Math.abs(fr.origin[2] - z) < 1e-6; });
const areaOf = (k, face) => { const g = new k.oc.GProp_GProps(); k.oc.BRepGProp.SurfaceProperties(face.shape, g, false, false); const a = g.Mass(); g.delete(); return a; };

test("Lighten plate, truss: pockets between the holes of a plate that is not a rectangle", async () => {
  const src = T.exemplar("lighten-plate");
  const { k, engine, rep, body } = await built(T.PLATE_A(), src, {});
  assert.equal(rep.status, "ok", rep.message);
  assert.match(rep.info, /^Pockets: 7 · Mass saved: 4\d\.\d %$/);
  assert.equal(k.solids(body.shape).length, 1, "one piece");
  const v = k.volume(body.shape);
  assert.ok(v > VA * 0.45 && v < VA * 0.6, String(v));
  // a through cut leaves a prism: the volume is the top face's area times the thickness
  const top = flatFaces(k, body, 6);
  assert.equal(top.length, 1);
  near(areaOf(k, top[0]) * 6, v, 1e-6);
  // the holes are all still there, each with its wall whole
  const s = K.partSummary(k, engine.state).bodies[0];
  assert.deepEqual(s.holes.filter((h) => [6.6, 8, 22].includes(h.diameter_mm)), [{ diameter_mm: 6.6, count: 4 }, { diameter_mm: 8, count: 1 }, { diameter_mm: 22, count: 1 }]);
  assert.deepEqual(s.bbox_mm.size, [160, 100, 6]);
  // the pocket walls are cylinders where they are round (corner radii, the rings round the holes), not facets
  assert.ok(s.faces.by_kind.cylinder > 20 && s.faces.count < 140, JSON.stringify(s.faces.by_kind));
  engine.dispose();
});

test("Lighten plate: the margins hold (nothing is cut within them)", async () => {
  const src = T.exemplar("lighten-plate");
  for (const pattern of ["truss", "isogrid", "hex"]) {
    const { k, engine, rep, body } = await built(T.PLATE_A(), src, { pattern, margin: 6, boss: 5, rib: 3 });
    assert.equal(rep.status, "ok", `${pattern}: ${rep.message}`);
    // read the lightened face back and measure it in 2D
    const top = flatFaces(k, body, 6)[0];
    const r = await T.run([...T.PLATE_A(), T.scriptFeature("lp", src, { pattern, margin: 6, boss: 5, rib: 3 })], `feature({ title: "m", params: {}, evaluate(ctx) {
      const o = ctx.body().face({ kind: "plane", normal: [0, 0, 1] }).outline();
      const round = o.holes.filter((h) => h.length === 2), pockets = o.holes.filter((h) => h.length !== 2);
      const frame = Geo2.difference(o.outer, Geo2.offset(o.outer, -5.99)), bosses = Geo2.offset(round, 4.99);
      console.log(JSON.stringify([round.length, pockets.length, Geo2.area(Geo2.intersection(pockets, frame)), Geo2.area(Geo2.intersection(pockets, bosses)), Geo2.difference(o.outer, pockets).length]));
    } });`);
    const [holes, pockets, inFrame, inBoss, pieces] = JSON.parse(r.console[0]);
    assert.equal(holes, 6, pattern); assert.ok(pockets >= 5, `${pattern}: ${pockets} pockets`);
    assert.ok(inFrame < 0.05, `${pattern}: ${inFrame} mm² of pocket inside the edge margin`);
    assert.ok(inBoss < 0.05, `${pattern}: ${inBoss} mm² of pocket inside a hole's margin`);
    assert.equal(pieces, 1, `${pattern}: the plate is in one piece`);
    assert.ok(top);
    engine.dispose();
  }
});

test("Lighten plate: isogrid and hex, through and to a depth, on a plate with an arc in its outline", async () => {
  const src = T.exemplar("lighten-plate");
  const iso = ok(await T.run(T.PLATE_A(), src, { pattern: "isogrid" }));
  assert.ok(Number(report(iso, "Pockets")) >= 30); assert.ok(iso.volume_after_mm3 < VA * 0.8 && iso.volume_after_mm3 > VA * 0.6);
  const hex = ok(await T.run(T.PLATE_B(), src, { pattern: "hex", pitch: 18, rib: 3 }));
  assert.ok(Number(report(hex, "Pockets")) >= 25); assert.ok(hex.volume_after_mm3 < VB * 0.6);
  const trussB = ok(await T.run(T.PLATE_B(), src, {}));
  assert.ok(trussB.volume_after_mm3 < VB * 0.65 && trussB.volume_after_mm3 > VB * 0.4);
  // pockets to a depth: the floor stays, and what is removed is the pockets' area times the depth
  const { k, engine, rep, body } = await built(T.PLATE_B(), src, { through: false, depth: 5, anchors: 30 });
  assert.equal(rep.status, "ok", rep.message);
  const topArea = flatFaces(k, body, 8).reduce((n, f) => n + areaOf(k, f), 0), floorArea = flatFaces(k, body, 3).reduce((n, f) => n + areaOf(k, f), 0), bottom = flatFaces(k, body, 0).reduce((n, f) => n + areaOf(k, f), 0);
  near(topArea + floorArea, bottom, 1e-5);
  near(VB - k.volume(body.shape), floorArea * 5, 1e-5);
  assert.ok(floorArea > bottom * 0.3);
  engine.dispose();
  // a rotated, finer pattern, and a plate with no holes at all
  ok(await T.run(T.PLATE_A(), src, { pattern: "isogrid", pitch: 14, angle: 20, rib: 2.5, fillet: 1, narrowest: 4 }));
  const plain = ok(await T.run(T.PLATE_C(), src, {}));
  assert.equal(report(plain, "Pockets"), "2");
  ok(await T.run(T.PLATE_C(), src, { pattern: "hex", pitch: 16 }));
});

test("Lighten plate fails with sentences, and never cuts a plate in pieces", async () => {
  const src = T.exemplar("lighten-plate");
  let r = await T.run(T.PLATE_C(), src, { margin: 60 });
  assert.match(r.error.message, /edge margin is wider than the plate/);
  r = await T.run(T.PLATE_A(), src, { pattern: "hex", pitch: 5, rib: 6 });
  assert.match(r.error.message, /No pocket fits/);
  r = await T.run(T.PLATE_C(), src, { rib: 0.1 });
  assert.match(r.error.message, /Rib width must be at least 0\.5 mm/);
  // a boss in the middle of a big cell gets spokes rather than being cut loose
  const island = T.plate(T.polygon([[0, 0], [120, 0], [120, 100], [0, 100]]), [[60, 52, 8]], 5);
  const spoked = ok(await T.run(island, src, { pattern: "hex", pitch: 90, rib: 4, margin: 6, narrowest: 4 }));
  const { k, engine, body } = await built(island, src, { pattern: "hex", pitch: 90, rib: 4, margin: 6, narrowest: 4 });
  assert.equal(k.solids(body.shape).length, 1);
  assert.ok(spoked.volume_after_mm3 < 60000 * 0.8);
  engine.dispose();
  // on a face that is not flat
  r = await T.run([], `feature({ title: "c", params: {}, evaluate(ctx) { ctx.extrude(Geo2.circle([0, 0], 20), ctx.plane("top"), { height: 30 }); } });`, {});
  assert.equal(r.status, "ok");
});

test("Hole-to-hole slot: a slot through the plate, or a bridge that leaves both holes open", async () => {
  const src = T.exemplar("hole-slot");
  // the two holes nearest each other on plate A: Ø8 at (130, 45) and Ø6.6 at (148, 12)
  const a = [130, 45], b = [148, 12], L = Math.hypot(18, 33);
  const slot = ok(await T.run(T.PLATE_A(), src, {}));
  near(Number(report(slot, "Slot length").replace(" mm", "")), L, 1e-3);
  near(VA - slot.volume_after_mm3, G.area(G.difference(G.slot(a, b, 6.6), [G.circle(a, 4), G.circle(b, 3.3)])) * 6, 2e-3);
  const wide = ok(await T.run(T.PLATE_A(), src, { width: 10 }));
  assert.equal(wide.status, "warning"); assert.match(wide.warnings[0], /wider than both holes/);
  const bridge = ok(await T.run(T.PLATE_A(), src, { kind: "bridge", rim: 3, height: 4 }));
  near(bridge.volume_after_mm3 - VA, G.area(G.difference(G.slot(a, b, 14), [G.circle(a, 4), G.circle(b, 3.3)])) * 4, 2e-3);
  const none = await T.run(T.PLATE_C(), src, {});
  assert.match(none.error.message, /needs two round holes/);
});

test("Angle bracket: a part from nothing, with the volume its sizes give", async () => {
  const src = T.exemplar("bracket");
  const plain = ok(await T.run([], src, { base: 60, upright: 45, width: 40, thickness: 5, corner: 0, holes: 0, gusset: false }));
  near(plain.volume_after_mm3, (60 * 5 + 40 * 5) * 40, 1e-6);
  assert.equal(plain.bodies.length, 1); assert.deepEqual(plain.bodies[0].bbox_mm, [0, -40, 0, 60, 0, 45]);
  near(Number(report(plain, "Mass in steel").replace(" g", "")), 20000 * 7.85 / 1000, 1e-3);
  const drilled = ok(await T.run([], src, { corner: 0, gusset: false, holes: 2, hole: 6 }));
  near(plain.volume_after_mm3 - drilled.volume_after_mm3, 4 * Math.PI * 9 * 5, 1e-4);
  const rounded = ok(await T.run([], src, { holes: 0, gusset: false, corner: 4 }));
  near(rounded.volume_after_mm3 - plain.volume_after_mm3, (16 - Math.PI * 4) * 40, 1e-3);
  const full = ok(await T.run([], src, {}));
  assert.ok(full.volume_after_mm3 > drilled.volume_after_mm3);
  const bad = await T.run([], src, { thickness: 50 });
  assert.match(bad.error.message, /thickness must be less than both legs/);
});

test("Vent pattern: openings on a grid, clear of edges and holes, inside a sketched region", async () => {
  const src = T.exemplar("vent-pattern");
  const round = ok(await T.run(T.PLATE_A(), src, {}));
  const n = Number(report(round, "Openings"));
  assert.ok(n > 150);
  near(VA - round.volume_after_mm3, n * Math.PI * 4 * 6, 1e-3);
  const hex = ok(await T.run(T.PLATE_B(), src, { shape: "hex", size: 6, through: false, depth: 2 }));
  near(VB - hex.volume_after_mm3, Number(report(hex, "Openings")) * (36 * Math.sqrt(3) / 2) * 2, 1e-3);
  const slots = ok(await T.run(T.PLATE_A(), src, { shape: "slot", size: 3, length: 14, angle: 30 }));
  near(VA - slots.volume_after_mm3, Number(report(slots, "Openings")) * (3 * 11 + Math.PI * 2.25) * 6, 2e-3);
  // inside a region drawn as a sketch on the top face
  const withRegion = [...T.PLATE_C(), T.sketch("r", T.polygon([[10, 10], [50, 10], [50, 40], [10, 40]], "q"), { kind: "plane", plane: "top" })];
  const inRegion = ok(await T.run(withRegion, src, { region: { sketch: "r", regions: null }, margin: 2 }));
  const m = Number(report(inRegion, "Openings"));
  assert.ok(m >= 12 && m <= 40, String(m));
  near(48000 - inRegion.volume_after_mm3, m * Math.PI * 4 * 5, 1e-3);
  const none = await T.run(T.PLATE_C(), src, { margin: 45 });
  assert.match(none.error.message, /no room for openings/);
});

test("Engrave text: cut in or raised, and refused when it does not fit", async () => {
  const src = T.exemplar("engrave-text");
  const cut = ok(await T.run(T.PLATE_C(), src, { size: 9, depth: 1 }));
  const raised = ok(await T.run(T.PLATE_C(), src, { size: 9, depth: 1, raised: true }));
  near(48000 - cut.volume_after_mm3, raised.volume_after_mm3 - 48000, 1e-3);
  assert.ok(48000 - cut.volume_after_mm3 > 50 && 48000 - cut.volume_after_mm3 < 400);
  const w = Number(report(cut, "Text width").replace(" mm", ""));
  assert.ok(w > 40 && w < 70, String(w));
  ok(await T.run(T.PLATE_A(), src, { text: "Rev B 2026", size: 5, depth: 0.5, y: -30, angle: 10 }));
  for (const text of ["ABCDEFGHIJKLM", "NOPQRSTUVWXYZ", "abcdefghijklm", "nopqrstuvwxyz", "0123456789", "#&@%/+-=.,:"]) ok(await T.run(T.PLATE_C(), src, { text, size: 6, depth: 0.4 }));
  const off = await T.run(T.PLATE_C(), src, { size: 30 });
  assert.match(off.error.message, /does not fit on the face/);
  const empty = await T.run(T.PLATE_C(), src, { text: "  " });
  assert.match(empty.error.message, /Type the text/);
});

test("the guide's first example builds, and every example it names ships", async () => {
  const guide = K.PROMPTS.guide;
  const first = /```js\n([\s\S]*?)```/.exec(guide)[1];
  const r = ok(await T.run(T.PLATE_C(), first, {}));
  near(48000 - r.volume_after_mm3, Math.PI * 16 * 5, 1e-4);
  const titles = K.EXEMPLARS.map((e) => /title: "([^"]+)"/.exec(e.source)[1]);
  assert.deepEqual(titles.sort(), ["Angle bracket", "Engrave text", "Hole-to-hole slot", "Lighten plate", "Vent pattern"]);
  for (const t of titles) assert.ok(guide.includes(`**${t}**`), t);
  // the page in docs/ is the same text
  const page = path.join(T.server, "..", "docs", "WRITING_CUSTOM_FEATURES.md");
  if (fs.existsSync(page)) assert.ok(fs.readFileSync(page, "utf8").endsWith(guide), "docs/WRITING_CUSTOM_FEATURES.md is written from the guide: run npm run gen:cad");
  // every Geo2 and ctx member the guide and the assistant's instructions mention exists
  const sb = await K.loadSandbox();
  for (const e of K.EXEMPLARS) assert.deepEqual(sb.describe(e.source).problems, [], e.id);
});

test("every exemplar type-checks against the Feature API's type file", () => {
  const ts = require(path.join(T.server, "node_modules", "typescript"));
  const files = new Map([["/api.d.ts", K.API_DTS], ...K.EXEMPLARS.map((e) => [`/${e.id}.js`, e.source])]);
  const options = { allowJs: true, checkJs: true, noEmit: true, target: ts.ScriptTarget.ES2020, lib: ["lib.es2020.d.ts"], strict: false, noImplicitAny: false, types: [] };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host), source = host.getSourceFile.bind(host);
  host.readFile = (f) => (files.has(f) ? files.get(f) : read(f));
  host.fileExists = (f) => files.has(f) || exists(f);
  host.getSourceFile = (f, lang) => (files.has(f) ? ts.createSourceFile(f, files.get(f), lang, true) : source(f, lang));
  const program = ts.createProgram(Array.from(files.keys()), options, host);
  const problems = ts.getPreEmitDiagnostics(program).map((d) => `${d.file ? d.file.fileName + ":" + (d.file.getLineAndCharacterOfPosition(d.start).line + 1) : ""} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
  assert.deepEqual(problems, []);
});
