// schdlg.test.js — schematic dialogs parity: Sheet Pin Properties (DIALOG_SHEET_PIN_PROPERTIES) and the logic behind
// the simulator, library-link, update-from-PCB, setup and preference pages added with it.
// Run: node server/static/tests/schdlg.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(__dirname, "..", "..", "web", ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const K = globalThis.KiCadCanvas;
const L = load(["dialogs", "sch-items-logic.ts"]);

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

const SHEET = `(sheet (at 100 50) (size 40 30) (uuid "s")
  (property "Sheetname" "sub" (at 100 49 0) (effects (font (size 1.27 1.27))))
  (pin "VPP" input (at 100 60 180) (uuid "p1") (effects (font (size 1.524 1.524)) (justify left)))
  (pin "CLK/IN" output (at 140 70 0) (uuid "p2") (effects (font (face "Arial") (size 1.27 1.27) (italic yes)) (justify right))))`;

test("readSheetPin: name, shape token, text width as size, face, bold / italic", () => {
  const n = K.parse(SHEET), pins = L.kids(n, "pin");
  assert.deepEqual(L.readSheetPin(pins[0]), { text: "VPP", shape: "input", font: L.KICAD_FONT, size: 1.524, bold: false, italic: false, color: null });
  const b = L.readSheetPin(pins[1]); assert.equal(b.shape, "output"); assert.equal(b.font, "Arial"); assert.equal(b.italic, true);
});
test("writeSheetPin: escapes '/', writes the shape in place (no (shape …)), size w = h, bold", () => {
  const n = K.parse(SHEET), pin = L.kids(n, "pin")[0];
  L.writeSheetPin(pin, { text: "A/B", shape: "tri_state", font: L.KICAD_FONT, size: 2, bold: true, italic: false, color: null });
  const out = K.serialize(pin);
  assert.ok(/^\(pin "A\{slash\}B" tri_state/.test(out), out);
  assert.ok(!/\(shape/.test(out));
  assert.ok(/\(size 2 2\)/.test(out), out); assert.ok(/\(bold yes\)/.test(out), out);
});
test("sheetPinNameError: an empty or blank name is refused", () => {
  assert.equal(L.sheetPinNameError("  "), "Sheet pin name can not be empty.");
  assert.equal(L.sheetPinNameError("X"), null);
});
test("sheetPinAt: a left-edge pin reads rightwards into the sheet, a right-edge one leftwards", () => {
  const n = K.parse(SHEET);
  assert.equal(L.sheetPinAt(n, [100.5, 60]), 0);
  assert.equal(L.sheetPinAt(n, [103, 60.3]), 0);
  assert.equal(L.sheetPinAt(n, [98, 60]), -1);
  assert.equal(L.sheetPinAt(n, [138, 70]), 1);
  assert.equal(L.sheetPinAt(n, [141.5, 70]), -1);
  assert.equal(L.sheetPinAt(n, [120, 55]), -1);
});

module.exports = { test, load, K };
process.on("exit", () => { console.log(`schdlg: ${passed} passed, ${failed} failed`); if (failed) process.exitCode = 1; });
