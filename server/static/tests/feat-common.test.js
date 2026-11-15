// feat-common.test.js — the common frames and dialogs against KiCad: Page Settings' custom size limits (UNIT_BINDER::Validate with MIN_PAGE_SIZE_MILS / MAX_PAGE_SIZE_*_MILS) and the drawing
// sheet file kept in the project file (schematic / pcbnew page_layout_descr_file).
// Run: node server/static/tests/feat-common.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const WEB = path.join(__dirname, "..", "..", "web");
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(WEB, ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

const L = load(["dialogs", "logic.ts"]), W = load(["editor", "drawingsheet-model.ts"]);

test("Page Settings: the custom size is 1000 mils at least, under 120000 mils (eeschema) / 48000 mils (pcbnew)", () => {
  assert.strictEqual(L.pageSizeError("Width", 25.4, true, "mm"), null);
  assert.match(L.pageSizeError("Width", 20, true, "mil"), /^Width must be at least 1000 mils\.$/);
  assert.match(L.pageSizeError("Height", 1300, false, "mm"), /^Height must be less than 1219\.2 mm\.$/);
  assert.strictEqual(L.pageSizeError("Height", 1300, true, "mm"), null, "the schematic allows up to 3048 mm");
  assert.match(L.pageSizeError("Height", 3100, true, "in"), /less than 120 in/);
});
test("drawing sheet file: read from the editor's key of the project file, resolved to a project document", () => {
  const pro = JSON.stringify({ schematic: { page_layout_descr_file: "sheets/my.kicad_wks" }, pcbnew: { page_layout_descr_file: "${KIPRJMOD}/board.kicad_wks" } });
  assert.strictEqual(W.drawingSheetName(pro, true), "sheets/my.kicad_wks");
  assert.strictEqual(W.drawingSheetName(pro, false), "${KIPRJMOD}/board.kicad_wks");
  assert.strictEqual(W.drawingSheetName("{}", true), ""); assert.strictEqual(W.drawingSheetName("not json", true), "");
  const docs = [{ docId: "p", docType: "kicad_pro", path: "proj/demo.kicad_pro" }, { docId: "a", docType: "worksheet", path: "proj/sheets/my.kicad_wks" }, { docId: "b", docType: "worksheet", path: "proj/board.kicad_wks" }, { docId: "s", docType: "kicad_sch", path: "proj/demo.kicad_sch" }];
  const ws = W.projectWorksheets(docs);
  assert.deepStrictEqual(ws.map((x) => x.rel), ["sheets/my.kicad_wks", "board.kicad_wks"]);
  assert.strictEqual(W.resolveWorksheet("sheets/my.kicad_wks", ws).docId, "a");
  assert.strictEqual(W.resolveWorksheet("${KIPRJMOD}/board.kicad_wks", ws).docId, "b");
  assert.strictEqual(W.resolveWorksheet("/home/me/proj/board.kicad_wks", ws).docId, "b", "an absolute path ending in a project file");
  assert.strictEqual(W.resolveWorksheet("", ws), null); assert.strictEqual(W.resolveWorksheet("other.kicad_wks", ws), null);
  assert.deepStrictEqual(W.wksKey(true), ["schematic", "page_layout_descr_file"]); assert.deepStrictEqual(W.wksKey(false), ["pcbnew", "page_layout_descr_file"]);
});

console.log(`feat-common: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
