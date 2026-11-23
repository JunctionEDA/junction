// feel-audit.test.js — the KiCad-feel audit (2026-11-22): interactions checked line by line against the C++ tool loops.
//  · the arrow keys lock a move to their axis (SCH_MOVE_TOOL::Main / EDIT_TOOL::doMoveSelection AXIS_LOCK);
//  · Enter is ACTIONS::cursorClick (a click at the cursor) and End ACTIONS::finishInteractive in the wire tool, the
//    shape tools and the board's drawing tools; K is no key of KiCad's schematic editor.
// Run: node server/static/tests/feel-audit.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch;
const AX = load(["tools", "axis-lock.ts"]);
const IU = 1e4;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }

test("axis lock: a key locks its axis, the opposite key of that axis unlocks, the other axis moves the lock", () => {
  let s = AX.newAxisLock();
  s = AX.axisLockKey(s, "left"); assert.strictEqual(s.lock, "h");
  s = AX.axisLockKey(s, "left"); assert.strictEqual(s.lock, "h", "the same direction keeps it");
  s = AX.axisLockKey(s, "right"); assert.strictEqual(s.lock, "", "the opposite key unlocks");
  s = AX.axisLockKey(s, "right"); assert.strictEqual(s.lock, "h");
  s = AX.axisLockKey(s, "up"); assert.strictEqual(s.lock, "v", "the other axis takes the lock");
  s = AX.axisLockKey(s, "down"); assert.strictEqual(s.lock, "");
  assert.deepStrictEqual(AX.applyAxisLock("h", [5, 7], [1, 2]), [5, 2]);
  assert.deepStrictEqual(AX.applyAxisLock("v", [5, 7], [1, 2]), [1, 7]);
  assert.deepStrictEqual(AX.applyAxisLock("", [5, 7], [1, 2]), [5, 7]);
});

const HEAD = '(kicad_sch (version 20250114) (generator "t") (paper "A4") ';
function makeCtx(doc) {
  const ctx = {
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(),
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU)); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  };
  return ctx;
}
const ev = () => ({ button: 0, clientX: 0, clientY: 0, timeStamp: 0 });

test("wire tool: Enter is a click at the cursor (not handled by the tool), End finishes, K does nothing", () => {
  const doc = K.parseDoc(HEAD + ")", IU), ctx = makeCtx(doc);
  sch.onActivate("wire", ctx);
  sch.onPointerDown(ev(), [25.4, 25.4], ctx); sch.onPointerMove(ev(), [38.1, 25.4], ctx);
  assert.ok(sch.state.wire);
  assert.strictEqual(sch.onKey("Enter", {}, ctx), false, "Enter goes on to the editor's cursorClick");
  assert.ok(sch.state.wire, "the wire is still being drawn");
  assert.strictEqual(sch.onKey("k", {}, ctx), false); assert.ok(sch.state.wire);
  assert.strictEqual(sch.onKey("End", {}, ctx), true); assert.strictEqual(sch.state.wire, null);
  assert.strictEqual(ctx.log.length, 1);
});

require(path.join(__dirname, "..", "pcb-tools.js"));
const P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
function boardCtx(text) {
  const doc = K.parseDoc(text, "kicad_pcb"); const log = { commits: [], toasts: [] };
  const ctx = {
    K, doc, IU: 1e6, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, 1e6); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool() {}, selection: new Set(), cursor: null, activeLayer: "F.Cu",
    setSelection(list) { ctx.selection = new Set(list); }, setHighlight() {},
  };
  pcb.onDocChanged(ctx); return { ctx, log, doc };
}
const BOARD = (segs) => `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal)) ${segs})`;
const seg = (a, b, u, net = "A") => `(segment (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (width 0.25) (layer "F.Cu") (net "${net}") (uuid "${u}"))`;
const tracks = (doc) => [...doc.items.values()].filter((i) => i.kind === "segment").length;

test("Optimize Selected (Shift+T): a zig-zag track collapses to the cheapest 45° line; one step", () => {
  // 0,0 -> 5,0 -> 5,5 -> 10,5 -> 10,10: four segments, three right angles
  const { ctx, log, doc } = boardCtx(BOARD(seg([0, 0], [5, 0], "a") + seg([5, 0], [5, 5], "b") + seg([5, 5], [10, 5], "c") + seg([10, 5], [10, 10], "d")));
  ctx.setSelection(["b"]);
  assert.strictEqual(pcb.actions.routerOptimizeSelected.run(ctx), true);
  assert.strictEqual(log.commits.length, 1); assert.strictEqual(log.commits[0].label, "Routing");
  assert.ok(tracks(doc) < 4, "fewer segments than the zig-zag");
  assert.strictEqual(ctx.selection.size, 0, "the selection is cleared first");
});

test("Optimize Selected: a differential pair member is skipped with KiCad's message; nothing to do commits nothing", () => {
  const { ctx, log } = boardCtx(BOARD(seg([0, 0], [5, 0], "p", "D_P") + seg([5, 0], [5, 5], "q", "D_P") + seg([0, 1], [5, 1], "n", "D_N") + seg([20, 0], [30, 0], "s")));
  ctx.setSelection(["p"]); pcb.actions.routerOptimizeSelected.run(ctx);
  assert.deepStrictEqual(log.toasts, ["Differential pair members cannot be optimized."]); assert.strictEqual(log.commits.length, 0);
  ctx.setSelection(["s"]); pcb.actions.routerOptimizeSelected.run(ctx);
  assert.strictEqual(log.commits.length, 0, "a straight line is already optimal");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
