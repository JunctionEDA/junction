// embedded-file.test.js — adding a file on the Embedded Files page (web/library/embedded-file.ts): the type AddFile
// picks, the MMH3 checksum KiCad writes, the zstd frame KiCad's reader takes (content size known), the (file …) form,
// and the board serializer writing its (data |…|) lines bare, as EMBEDDED_FILES::WriteEmbeddedFiles does.
// Run: node server/static/tests/embedded-file.test.js
"use strict";
const path = require("path"), assert = require("assert/strict"), zlib = require("zlib");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const F = load("library/embedded-file.ts"), Z = load("dialogs/zstd.ts"), S = load("canvas/sexpr.ts"), X = load("canvas/export.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("embedded-file: Embedded Files > Add");

test("AddFile's types by extension", () => {
  assert.equal(F.embeddedFileType("a.STEP"), "model"); assert.equal(F.embeddedFileType("a.stp"), "model"); assert.equal(F.embeddedFileType("b.wrz"), "model");
  assert.equal(F.embeddedFileType("f.woff2"), "font"); assert.equal(F.embeddedFileType("f.ttf"), "font");
  assert.equal(F.embeddedFileType("d.pdf"), "datasheet"); assert.equal(F.embeddedFileType("p.kicad_wks"), "worksheet");
  assert.equal(F.embeddedFileType("notes.txt"), "other"); assert.equal(F.embeddedFileType("README"), "other");
});
test("MurmurHash3_x64_128 as MMH3_HASH / HASH_128::ToString", () => {
  // the reference vector of MurmurHash3_x64_128 (seed 0)
  assert.equal(F.mmh3Hash(Buffer.from("The quick brown fox jumps over the lazy dog"), 0), "E34BBC7BBC071B6C7A433CA9C49A9347");
  assert.equal(F.mmh3Hash(new Uint8Array(0), 0), "00000000000000000000000000000000");
  // KiCad's V1 hash (MMH3_HASH::addDataV1) is this hash over the data zero-padded to four bytes whenever the padded
  // length still leaves a tail: qa/data/pcbnew/issue22102's SchematicTemplate.kicad_wks (1977 bytes) carries one
  const qa = path.join(__dirname, "..", "..", "..", "qa", "data", "pcbnew", "issue22102.kicad_pcb");
  if (require("fs").existsSync(qa)) {
    const m = /\(name "SchematicTemplate\.kicad_wks"\)[\s\S]*?\(data\s+([\s\S]*?)\)\s*\(checksum "([0-9A-F]+)"/.exec(require("fs").readFileSync(qa, "utf8"));
    const ws = Buffer.from(Z.zstdDecompress(new Uint8Array(Buffer.from(m[1].replace(/[|\s]/g, ""), "base64"))));
    assert.equal(ws.length, 1977);
    assert.equal(F.mmh3Hash(Buffer.concat([ws, Buffer.alloc(3)])), m[2]);
  }
});
test("the stored frame reads back through zstd.ts and node's zstd, with its content size", () => {
  const inputs = [new Uint8Array(0), Buffer.from("x"), Buffer.alloc(131072, 5), Buffer.alloc(300001).map((_, i) => (i * 7) & 255)];
  for (const inp of inputs) {
    const fr = F.zstdStore(inp);
    assert.deepEqual(Array.from(fr.subarray(0, 5)), [0x28, 0xb5, 0x2f, 0xfd, 0xe0]);
    assert.equal(Number(Buffer.from(fr.subarray(5, 13)).readBigUInt64LE()), inp.length, "Frame_Content_Size");
    assert.ok(Buffer.from(Z.zstdDecompress(fr)).equals(Buffer.from(inp)), "zstd.ts, length " + inp.length);
    if (typeof zlib.zstdDecompressSync === "function") assert.ok(zlib.zstdDecompressSync(Buffer.from(fr)).equals(Buffer.from(inp)), "node zstd, length " + inp.length);
  }
});
test("the (file …) form: name, type, bar-delimited base64 lines of 76, checksum", () => {
  const data = Buffer.alloc(500).map((_, i) => (i * 13) & 255);
  const t = F.embeddedFileSexpr('my "part".step', data);
  const node = S.parse(t);
  assert.equal(node[0], "file"); assert.equal(S.kid(node, "name")[1], 'my "part".step'); assert.equal(S.kid(node, "type")[1], "model");
  assert.equal(S.kid(node, "checksum")[1], F.mmh3Hash(data));
  const d = S.kid(node, "data"); assert.ok(String(d[1]).startsWith("|") && String(d[d.length - 1]).endsWith("|"));
  assert.ok(d.slice(1).every((x, i, a) => String(x).replace(/\|/g, "").length === (i < a.length - 1 ? 76 : String(x).replace(/\|/g, "").length)));
  assert.ok(Buffer.from(Z.zstdDecompress(new Uint8Array(Buffer.from(d.slice(1).join("").replace(/\|/g, ""), "base64")))).equals(data));
});
test("the serializer keeps (data |…|) bare, as KiCad's NeedBAR reader requires; image data and quoted slots are unchanged", () => {
  const t = F.embeddedFileSexpr("a.step", Buffer.alloc(400).map((_, i) => (i * 101) & 255));
  const out = X.serialize(S.parse(`(footprint "L:F" (embedded_files ${t}))`));
  const data = /\(data ([^)]*)\)/.exec(out)[1];
  assert.ok(!data.includes('"'), "no quotes: " + data.slice(0, 80));
  assert.ok(data.startsWith("|KLUv/") && data.endsWith("|"));
  assert.equal(X.serialize(S.parse(out)), out, "stable round trip");
  // 40 lines: past the reader's 30-slot quote mask, still bare
  const big = F.embeddedFileSexpr("b.bin", Buffer.alloc(2400).map((_, i) => (i * 37 + (i >> 3)) & 255));
  assert.ok(!/\(data [^)]*"/.test(X.serialize(S.parse(big))));
  // a reference image's data is not an embedded file: its quoted lines stay quoted
  assert.match(X.serialize(S.parse('(image (data "iVBO/+w=" "AA+A"))')), /^\(image \(data "iVBO\/\+w=" "AA\+A"\)\)$/);
});
console.log(`${passed} passed, ${failed} failed`); if (failed) process.exit(1);
