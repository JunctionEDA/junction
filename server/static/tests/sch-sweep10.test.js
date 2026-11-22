// sch-sweep10.test.js — schematic parity fixes of sweep 10: a keyboard Move (M) no longer leaves mouse drags as moves,
// a junction added by an edit splits the line it lands on (AddJunction's BreakSegments), and fields re-autoplace with
// the symbol's own algorithm (AUTO unless Autoplace Fields ran) on edits, rotation, and not on a mirror.
// Run: node server/static/tests/sch-sweep10.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const IU = 1e4;

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
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
const wire = (a, b, u) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${u}"))`;
const lines = (doc) => [...doc.items.values()].filter((i) => i.kind === "wire").map((i) => JSON.stringify(K.ptsOf(i.node))).sort();

test("a mouse drag after a keyboard Move drags (wires follow) again", () => {
  const doc = K.parseDoc(HEAD + wire([0, 0], [10.16, 0], "w1") + ")", "kicad_sch"), ctx = makeCtx(doc);
  sch.setMouseDragMode(ctx, "drag");
  sch.setDragMode(ctx, "move", true);                            // M: this one drag is a move ...
  const w = doc.items.get("w1");
  const d = sch.beginDrag(ctx, w, [5.08, 0], true);              // ... the next pointer drag is the preference's
  assert.ok(d);
  assert.strictEqual(sch.state.dragMode, "drag");
  sch.cancelDrag(ctx);
  sch.setMouseDragMode(ctx, "move");
  assert.strictEqual(sch.state.dragMode, "move");
  sch.setMouseDragMode(ctx, "drag");
});

test("junctions added by a drag split the lines running through them", () => {
  const doc = K.parseDoc(HEAD + wire([0, 0], [20.32, 0], "w1") + wire([5.08, -10.16], [5.08, -5.08], "w2") + wire([15.24, -10.16], [15.24, -5.08], "w3") + ")", "kicad_sch");
  const mk = (id, x) => { const n = JSON.parse(JSON.stringify(doc.items.get(id).node)); K.setPts(n, [[x, -10.16], [x, 0]]); return { id, kind: "MODIFIED", typeName: "SCH_LINE", sexpr: K.serialize(n) }; };
  const ch = [mk("w2", 5.08), mk("w3", 15.24)];
  const out = _.cleanupAt(doc, ch, [[5.08, 0], [15.24, 0]], new Set(), IU);
  assert.strictEqual(lines(doc).length, 3, "the dry run leaves the document as it was");
  for (const c of ch.concat(out)) assert.ok(K.applyChange(doc, c, IU));
  assert.deepStrictEqual(lines(doc), [
    "[[0,0],[5.08,0]]", "[[15.24,-10.16],[15.24,0]]", "[[15.24,0],[20.32,0]]", "[[5.08,-10.16],[5.08,0]]", "[[5.08,0],[15.24,0]]",
  ].sort());
  assert.strictEqual([...doc.items.values()].filter((i) => i.kind === "junction").length, 2);
});

test("autoplace without an algorithm uses AUTO for a symbol Autoplace Fields never touched", () => {
  const s = require("fs").readFileSync(path.join(__dirname, "..", "..", "..", "demos", "simulation", "amplifier-ac", "amplifier-ac.kicad_sch"), "utf8");
  const doc = K.parseDoc(s, "kicad_sch");
  const it = [...doc.items.values()].find((i) => i.kind === "symbol" && K.kid(i.node, "fields_autoplaced"));
  assert.ok(it);
  assert.strictEqual(K.serialize(_.autoplaceNode(doc, it)), K.serialize(_.autoplaceNode(doc, it, { manual: false })));
});

test("mirroring a symbol clears fields_autoplaced; rotating keeps it", () => {
  const s = require("fs").readFileSync(path.join(__dirname, "..", "..", "..", "demos", "simulation", "amplifier-ac", "amplifier-ac.kicad_sch"), "utf8");
  const doc = K.parseDoc(s, "kicad_sch"), ctx = makeCtx(doc);
  const it = [...doc.items.values()].find((i) => i.kind === "symbol" && K.kid(i.node, "fields_autoplaced"));
  const C = K.atOf(it.node).slice(0, 2);
  const flag = (changes) => { const c = changes.find((q) => q.id === it.id); return /fields_autoplaced/.test(c.sexpr); };
  assert.strictEqual(flag(_.transformChanges(ctx, [it], "y", C)), false);
  assert.strictEqual(flag(_.transformChanges(ctx, [it], "ccw", C)), true);
});

console.log(`sch-sweep10: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
