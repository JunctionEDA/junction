// Node test for the size of the default planes kept in a part studio (web/domains/mechanical/document/plane-sizes.ts):
// a new studio sets none, a resize is one path of the studio item, it survives the file, it is undone like
// any edit, two people resizing two planes at once both win, and nonsense in the file is not taken.
// Run: node server/static/tests/cad-plane-sizes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/mechanical/document/format.ts");
const P = load("domains/mechanical/document/plane-sizes.ts");

const newDoc = () => D.parseItemDoc(F.newPartStudioText(), F.PART_STUDIO_KIND);

test("a new part studio sets no plane size: the planes grow with the model", () => {
  assert.deepEqual(P.planeSizesOf(newDoc()), {});
  assert.deepEqual(P.planeSizesOf(null), {});
});

test("a resize is one path of the studio item, kept in the file", () => {
  const doc = newDoc();
  const changes = P.setPlaneSize(doc, "top", 123.456);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].id, F.STUDIO_ITEM_ID);
  assert.deepEqual(changes[0].props, [{ path: ["planeSizes", "top"], value: 123.46 }]);
  D.applyChanges(doc, changes);
  assert.deepEqual(P.planeSizesOf(doc), { top: 123.46 });
  const again = D.parseItemDoc(D.serializeItemDoc(doc), F.PART_STUDIO_KIND);
  assert.deepEqual(P.planeSizesOf(again), { top: 123.46 });
  assert.deepEqual(P.setPlaneSize(again, "top", 123.46), [], "the same size again is no change");
  D.applyChanges(again, P.setPlaneSize(again, "top", null));
  assert.deepEqual(P.planeSizesOf(again), {});
});

test("a resize is undone by its inverse", () => {
  const doc = newDoc();
  D.applyChanges(doc, P.setPlaneSize(doc, "front", 80));
  const before = D.clone(doc.items.get(F.STUDIO_ITEM_ID));
  const changes = P.setPlaneSize(doc, "front", 200);
  const inverse = changes.map((c) => D.invertChange(doc, c));
  D.applyChanges(doc, changes);
  assert.equal(P.planeSizesOf(doc).front, 200);
  D.applyChanges(doc, inverse);
  assert.deepEqual(doc.items.get(F.STUDIO_ITEM_ID), before);
});

test("two people resizing two planes at once both win", () => {
  const a = newDoc(), b = newDoc();
  const ca = P.setPlaneSize(a, "top", 50), cb = P.setPlaneSize(b, "right", 70);
  D.applyChanges(a, ca); D.applyChanges(a, cb);
  D.applyChanges(b, cb); D.applyChanges(b, ca);
  assert.deepEqual(P.planeSizesOf(a), { top: 50, right: 70 });
  assert.deepEqual(P.planeSizesOf(b), { top: 50, right: 70 });
});

test("sizes out of range, of the wrong type or for no plane are not taken", () => {
  const doc = newDoc();
  const s = doc.items.get(F.STUDIO_ITEM_ID);
  s.planeSizes = { top: -5, front: "big", right: 1e9, side: 40 };
  assert.deepEqual(P.planeSizesOf(doc), {});
  assert.deepEqual(P.setPlaneSize(doc, "side", 40), []);
  assert.equal(P.cleanPlaneSize(0.1), P.MIN_PLANE_SIZE);
});
