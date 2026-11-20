// Node test for the standard parts the server draws (server/src/models3d/standard.rs): every part studio it
// writes is built by the real kernel, and what comes out is one solid of the size the standard gives, with the
// round and flat faces an assembly mates on.  The part studios are the fixtures the Rust test
// `fixtures_are_current` keeps in step with the generator (tests/fixtures/models3d).
// Run: node server/static/tests/models3d.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { load, server } = require("./cad-load");
const K = load("domains/mechanical/kernel/index.ts");
const I = load("shared/itemdoc/itemdoc.ts");
const IN = load("domains/mechanical/document/inputs.ts");
const C = load("domains/assembly/connectors/infer.ts");
const S = load("domains/assembly/suppliers/model.ts");

const DIR = path.join(__dirname, "fixtures", "models3d");
const index = JSON.parse(fs.readFileSync(path.join(DIR, "index.json"), "utf8"));

let kernel;
async function boot() {
  if (kernel) return kernel;
  const init = (await import("replicad-opencascadejs")).default;
  const oc = await init({ wasmBinary: fs.readFileSync(path.join(server, "node_modules", "replicad-opencascadejs", "dist", "replicad_single.wasm")) });
  kernel = new K.Kernel(oc);
  return kernel;
}
async function build(file) {
  const doc = I.parseItemDoc(fs.readFileSync(path.join(DIR, file), "utf8"), "part-studio");
  const { features, rollback } = IN.studioInputs(doc, {});
  const engine = new K.RegenEngine(await boot(), K.FEATURES);
  const r = await engine.regenerate(features, rollback);
  const out = { reports: r.features, bodies: r.bodies.map((b) => ({ id: b.id, name: b.name, mesh: b.mesh })), doc };
  engine.dispose();
  return out;
}
/** The volume a closed triangle mesh encloses. */
function volume(mesh) {
  const p = mesh.positions, ix = mesh.indices;
  let v = 0;
  for (let i = 0; i < ix.length; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(v) / 6;
}
const extent = (m) => [m.bbox[3] - m.bbox[0], m.bbox[4] - m.bbox[1], m.bbox[5] - m.bbox[2]];
const connectors = (mesh) => Object.keys(mesh.faces || {}).length ? Object.keys(mesh.faces) : (mesh.faceNames || []);

for (const c of index) {
  test(`${c.name}: one solid of the standard's size`, async () => {
    const r = await build(c.file);
    for (const f of r.reports) assert.equal(f.status, "ok", `${f.id}: ${f.message || ""}`);
    assert.equal(r.bodies.length, 1, "one body");
    const got = extent(r.bodies[0].mesh);
    // across (x and y, whichever way the hexagon lies) and along the axis
    const want = c.extent;
    assert.ok(Math.abs(got[2] - want[2]) < 0.02, `height ${got[2]} is not ${want[2]}`);
    const across = [got[0], got[1]].sort((a, b) => a - b), wantAcross = [want[0], want[1]].sort((a, b) => a - b);
    assert.ok(Math.abs(across[0] - wantAcross[0]) < 0.05 && Math.abs(across[1] - wantAcross[1]) < 0.05, `across ${across} is not ${wantAcross}`);
    assert.ok(volume(r.bodies[0].mesh) > 0.5, "it encloses a volume");
    // what the document says of itself: the part it stands for
    const said = r.doc.items.get("standard-part");
    assert.equal(said.spec, c.id);
    assert.equal(said.title, c.name);
  });
}

test("an M5 × 20 socket head screw: the volume, the shank to mate on, the face under the head", async () => {
  const r = await build("shcs_M5_20.jpart");
  const mesh = r.bodies[0].mesh;
  // shank 392.7 + head 283.7 − socket 34.6 mm³, less the chamfers
  const v = volume(mesh);
  assert.ok(v > 625 && v < 645, `volume ${v}`);
  const faces = mesh.faces.names.map((name) => C.connectorOf(mesh, { kind: "face", name })).filter(Boolean);
  const shank = faces.find((f) => f.surface === "cylinder" && Math.abs(f.radius - 2.5) < 1e-3);
  assert.ok(shank, "the shank is a true cylinder of the nominal diameter");
  assert.ok(Math.abs(Math.abs(shank.z[2]) - 1) < 1e-6, "along Z");
  const head = faces.find((f) => f.surface === "cylinder" && Math.abs(f.radius - 4.25) < 1e-3);
  assert.ok(head, "the head is a cylinder ⌀8.5");
  const seat = faces.find((f) => f.surface === "plane" && Math.abs(f.o[2]) < 1e-6 && Math.abs(f.z[2] + 1) < 1e-6);
  assert.ok(seat, "the face under the head is flat, at the origin, facing down");
  // the shank hangs below the origin, the head sits above it
  assert.ok(Math.abs(mesh.bbox[2] + 20) < 1e-3 && Math.abs(mesh.bbox[5] - 5) < 1e-3, `z ${mesh.bbox[2]} … ${mesh.bbox[5]}`);
});

test("a nut and a bearing have a bore to mate on; an extrusion keeps its slots", async () => {
  const nut = (await build("nut_M6.jpart")).bodies[0].mesh;
  const bores = (mesh) => mesh.faces.names.map((name) => C.connectorOf(mesh, { kind: "face", name })).filter((f) => f && f.surface === "cylinder").map((f) => +f.radius.toFixed(3)).sort((a, b) => a - b);
  assert.deepEqual(bores(nut), [2.5], "the tap drill of M6 (6 − 1), since the thread is not cut");
  const bearing = (await build("bearing_608.jpart")).bodies[0].mesh;
  const round = bores(bearing);
  assert.equal(round[0], 4, "the bore: ⌀8");
  assert.equal(round[round.length - 1], 11, "the outside: ⌀22");
  const slot = (await build("tslot_20_100.jpart")).bodies[0].mesh;
  // a 20 × 20 bar would be 40000 mm³: the four slots and the bore take more than a third of it away
  const v = volume(slot);
  assert.ok(v > 18000 && v < 26000, `volume ${v}`);
});

test("names: what a supplier's model is called in the project and in a bill of materials", () => {
  assert.equal(S.fileStem({ title: "McMaster-Carr 91251A431" }), "McMaster-Carr 91251A431");
  assert.equal(S.fileStem({ title: "ASME B18.3 SHCS 1/4-20 x 1-3/4" }), "ASME B18.3 SHCS 1_4-20 x 1-3_4");
  assert.equal(S.fileStem({ title: "  ..weird:name?*  " }), "weird_name_");
  assert.equal(S.fileStem({ title: "" }), "Model");
  // a McMaster-Carr number on a server without McMaster's API: the row that takes McMaster's own file from the person
  const hit = { provider: "mcmaster", supplier: "McMaster-Carr", id: "91251A431", part_number: "91251A431", title: "McMaster-Carr 91251A431", description: "McMaster-Carr part", format: "", url: "https://www.mcmaster.com/91251A431/", generated: false, upload: true };
  // what the instance keeps: McMaster's part, not a drawn one
  assert.deepEqual(S.supplierOf(hit), { provider: "mcmaster", id: "91251A431", name: "McMaster-Carr", partNumber: "91251A431", title: "McMaster-Carr 91251A431", description: "McMaster-Carr part", url: "https://www.mcmaster.com/91251A431/" });
  assert.deepEqual(S.supplierOf({ ...hit, provider: "standard", generated: true }).generated, true);
  // only a web address is kept as a link
  assert.equal(S.supplierOf({ ...hit, url: "javascript:alert(1)" }).url, undefined);
  assert.equal(S.supplierInfo({ supplier: S.supplierOf(hit) }).title, "McMaster-Carr 91251A431");
  assert.equal(S.supplierInfo({ supplier: "nonsense" }), null);
  assert.equal(S.supplierInfo({}), null);
  // the project's document made for a supplier's part is found again, so a second insert reuses it
  const docs = [{ docId: "a", path: "McMaster-Carr 91251A431.jpart", docType: "part_studio" }, { docId: "b", path: "models/McMaster-Carr 91251A431.step", docType: "model3d" }, { docId: "c", path: "Other.jpart", docType: "part_studio" }];
  assert.equal(S.existingStudio(docs, hit).docId, "a");
  assert.equal(S.existingStudio(docs, { ...hit, title: "McMaster-Carr 92196A537" }), undefined);
  // and the supplier's own file it imports: with it the project has the supplier's model, not just a studio of that name
  assert.equal(S.existingStep(docs, hit).docId, "b");
  assert.equal(S.existingStep([docs[0], docs[2]], hit), undefined, "a part studio of that name alone is not the supplier's model");
  assert.equal(S.existingStep([{ path: "models/mcmaster-carr 91251a431 2.STP" }], hit).path, "models/mcmaster-carr 91251a431 2.STP", "a second file of the name, and .stp");
  for (const no of ["McMaster-Carr 91251A431.step", "models/McMaster-Carr 91251A4310.step", "models/McMaster-Carr 91251A431 old.step", "models/McMaster-Carr 91251A431.jpart", "models/x/McMaster-Carr 91251A431.step"]) {
    assert.equal(S.existingStep([{ path: no }], hit), undefined, no);
  }
});

test("a file a person hands over as a supplier's model is a STEP file, or they are told why not", () => {
  const bytes = (text) => new TextEncoder().encode(text);
  const hit = { supplier: "McMaster-Carr" };
  assert.ok(S.looksLikeStep(bytes("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('STEP AP214'),'1');")));
  assert.ok(S.looksLikeStep(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("\r\n ISO-10303-21;")])), "a byte-order mark and blank lines first");
  for (const no of ["", "ISO-10303", "<!DOCTYPE html><html>", "PK\u0003\u0004", "solid ascii stl", "%PDF-1.7", "iso-10303-21;"]) assert.equal(S.looksLikeStep(bytes(no)), false, no);
  assert.equal(S.stepFileProblem({ name: "91251A431.STEP", size: 5000 }, bytes("ISO-10303-21;\nHEADER;"), hit), "");
  // the page saved instead of the model, a drawing, the wrong CAD format: said plainly, with what to download
  const wrong = S.stepFileProblem({ name: "91251A431.html", size: 5000 }, bytes("<!DOCTYPE html>"), hit);
  assert.match(wrong, /“91251A431\.html” is not a STEP file/);
  assert.match(wrong, /McMaster-Carr's page/);
  assert.match(wrong, /3-D STEP/);
  // a file named .step that is not one is still refused: the header decides, not the name
  assert.match(S.stepFileProblem({ name: "91251A431.step", size: 12 }, bytes("SLDPRT bytes"), hit), /is not a STEP file/);
  assert.match(S.stepFileProblem({ name: "empty.step", size: 0 }, bytes(""), hit), /is empty/);
  assert.match(S.stepFileProblem({ name: "huge.step", size: S.MAX_STEP_BYTES + 1 }, bytes("ISO-10303-21;"), hit), /too large to place \(40 MB; the limit is 40 MB\)/);
  assert.match(S.stepFileProblem({ name: "x.bin", size: 9 }, bytes("nope"), { supplier: "" }), /the supplier's page/);
});
