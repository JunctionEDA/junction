// Node test for the parts list of a part studio: the names and properties people give its entries
// (web/domains/mechanical/document/part-items.ts) and what the list shows and offers
// (web/domains/mechanical/ui/parts-model.ts): the sections and their counts, which rows a click selects, which
// features made a part, and the menu for a set of rows.
// Run: node server/static/tests/cad-partslist.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/mechanical/document/format.ts");
const P = load("domains/mechanical/document/part-items.ts");
const L = load("domains/mechanical/ui/parts-model.ts");

const newDoc = () => D.parseItemDoc(F.newPartStudioText(), F.PART_STUDIO_KIND);
const item = (doc) => doc.items.get(P.PARTS_ITEM_ID);

// ---------------------------------------------------------------- the document
test("a new part studio has no names and no properties", () => {
  assert.deepEqual(P.partNamesOf(newDoc()), {});
  assert.deepEqual(P.partPropsOf(newDoc()), {});
  assert.deepEqual(P.partNamesOf(null), {});
  assert.equal(newDoc().items.has(P.PARTS_ITEM_ID), false);
});

test("the first rename adds the item; the next is one path of it, kept in the file", () => {
  const doc = newDoc();
  const first = P.renamePart(doc, "f1", "  Bracket   left ");
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "ADDED");
  D.applyChanges(doc, first);
  assert.deepEqual(P.partNamesOf(doc), { f1: "Bracket left" }, "spaces are tidied");
  const second = P.renamePart(doc, "f2", "Lid");
  assert.equal(second[0].kind, "MODIFIED");
  assert.deepEqual(second[0].props, [{ path: ["names", "f2"], value: "Lid" }]);
  D.applyChanges(doc, second);
  const again = D.parseItemDoc(D.serializeItemDoc(doc), F.PART_STUDIO_KIND);
  assert.deepEqual(P.partNamesOf(again), { f1: "Bracket left", f2: "Lid" });
  assert.deepEqual(P.renamePart(again, "f2", "Lid"), [], "the same name again is no change");
});

test("an empty name, or the entry's own, takes the person's name away", () => {
  const doc = newDoc();
  D.applyChanges(doc, P.renamePart(doc, "f1", "Bracket"));
  D.applyChanges(doc, P.renamePart(doc, "f1", "   "));
  assert.deepEqual(P.partNamesOf(doc), {});
  D.applyChanges(doc, P.renamePart(doc, "curve:h1", "Spring path", "Helix 1"));
  assert.deepEqual(P.partNamesOf(doc), { "curve:h1": "Spring path" });
  D.applyChanges(doc, P.renamePart(doc, "curve:h1", "Helix 1", "Helix 1"));
  assert.deepEqual(P.partNamesOf(doc), {}, "a curve named as its feature has no name of its own");
  assert.deepEqual(P.renamePart(newDoc(), "f1", ""), [], "nothing to take away: no change, no item");
});

test("a rename is undone by its inverse", () => {
  const doc = newDoc();
  D.applyChanges(doc, P.renamePart(doc, "f1", "Bracket"));
  const changes = P.renamePart(doc, "f1", "Clamp");
  const inverse = changes.map((c) => D.invertChange(doc, c));
  D.applyChanges(doc, changes);
  assert.equal(P.partNamesOf(doc).f1, "Clamp");
  D.applyChanges(doc, inverse);
  assert.equal(P.partNamesOf(doc).f1, "Bracket");
});

test("two people naming two parts at once both win", () => {
  const base = newDoc();
  D.applyChanges(base, P.renamePart(base, "f0", "Base"));
  const a = P.renamePart(base, "f1", "Bracket"), b = P.renamePart(base, "f2", "Lid");
  for (const order of [[a, b], [b, a]]) {
    const doc = D.parseItemDoc(D.serializeItemDoc(base), F.PART_STUDIO_KIND);
    for (const c of order) D.applyChanges(doc, c);
    assert.deepEqual(P.partNamesOf(doc), { f0: "Base", f1: "Bracket", f2: "Lid" });
  }
});

test("properties: a description and fields, each its own path", () => {
  const doc = newDoc();
  D.applyChanges(doc, P.setPartProps(doc, "f1", { description: "Holds the motor", fields: { Vendor: "Acme", Finish: "Anodised" } }));
  assert.deepEqual(P.partPropsOf(doc), { f1: { description: "Holds the motor", fields: { Vendor: "Acme", Finish: "Anodised" } } });
  const c = P.setPartProps(doc, "f1", { fields: { Vendor: "Bolt & Co", Finish: null } });
  assert.deepEqual(c[0].props.map((p) => p.path.join("/")).sort(), ["props/f1/fields/Finish", "props/f1/fields/Vendor"]);
  D.applyChanges(doc, c);
  assert.deepEqual(P.partPropsOf(doc).f1.fields, { Vendor: "Bolt & Co" });
  D.applyChanges(doc, P.setPartProps(doc, "f1", { description: "", fields: { Vendor: null } }));
  assert.deepEqual(P.partPropsOf(doc), {}, "an entry with nothing said about it has no line");
  assert.deepEqual(item(doc).props, {});
});

test("a name and properties change in one step, also when the item is not there yet", () => {
  const doc = newDoc();
  const changes = P.updatePart(doc, "f1", { name: "Bracket", description: "Left side", fields: { Vendor: "Acme" } });
  assert.equal(changes.length, 1, "one change: an undo takes it all back");
  D.applyChanges(doc, changes);
  assert.equal(P.partNamesOf(doc).f1, "Bracket");
  assert.deepEqual(P.partPropsOf(doc).f1, { description: "Left side", fields: { Vendor: "Acme" } });
});

test("nonsense in the file is not taken, and what is too long is cut", () => {
  const doc = newDoc();
  doc.items.set(P.PARTS_ITEM_ID, { id: P.PARTS_ITEM_ID, type: "parts", names: { a: 5, b: "", c: "Ok", d: "x".repeat(500) }, props: { a: "no", c: { description: 7, fields: { V: 1, W: "w" } } } });
  const names = P.partNamesOf(doc);
  assert.deepEqual(Object.keys(names).sort(), ["c", "d"]);
  assert.equal(names.d.length, P.MAX_PART_NAME);
  assert.deepEqual(P.partPropsOf(doc), { c: { fields: { W: "w" } } });
  doc.items.set(P.PARTS_ITEM_ID, { id: P.PARTS_ITEM_ID, type: "parts", names: "x", props: null });
  assert.deepEqual(P.partNamesOf(doc), {});
  D.applyChanges(doc, P.renamePart(doc, "f1", "Bracket"));
  assert.deepEqual(P.partNamesOf(doc), { f1: "Bracket" }, "a broken item is mended by the next edit");
});

test("the bodies carry the names people gave; unnamed bodies keep their objects", () => {
  const doc = newDoc();
  const bodies = [{ id: "f1", name: "Part 1" }, { id: "f2", name: "Part 2" }];
  assert.equal(P.namedBodies(doc, bodies), bodies, "no names: the same array");
  D.applyChanges(doc, P.renamePart(doc, "f2", "Lid"));
  const named = P.namedBodies(doc, bodies);
  assert.deepEqual(named.map((b) => b.name), ["Part 1", "Lid"]);
  assert.equal(named[0], bodies[0]);
  assert.equal(bodies[1].name, "Part 2", "the worker's result is not changed");
});

// ---------------------------------------------------------------- the list
const features = [
  { id: "sk1", name: "Sketch 1", featureType: "sketch", params: {} },
  { id: "ex1", name: "Extrude 1", featureType: "extrude", params: { profile: { sketch: "sk1" } } },
  { id: "fi1", name: "Fillet 1", featureType: "fillet", params: { edges: [{ kind: "edge", body: "ex1", name: "ex1:side|ex1:top" }] } },
  { id: "sk2", name: "Sketch 2", featureType: "sketch", params: {} },
  { id: "ex2", name: "Extrude 2", featureType: "extrude", params: { profile: { sketch: "sk2" } } },
  { id: "su1", name: "Fill 1", featureType: "fill", params: {} },
  { id: "hx1", name: "Helix 1", featureType: "helix", params: {} },
  { id: "pl1", name: "Plane 1", featureType: "plane", params: {} },
  { id: "bd1", name: "Board", featureType: "board-reference", params: {} },
  { id: "cp1", name: "Bearing", featureType: "composite-part", params: { bodies: ["ex2", "ex3"] } },
];
const bodies = [
  { id: "ex1", name: "Part 1", createdBy: "ex1" },
  { id: "ex2", name: "Part 2", createdBy: "ex2" },
  { id: "su1", name: "Surface 1", createdBy: "su1", sheet: true },
  { id: "bd1", name: "Board", createdBy: "bd1", reference: true },
  { id: "cp1", name: "Bearing", createdBy: "cp1" },
];
const datums = [{ featureId: "pl1", kind: "plane" }, { featureId: "hx1", kind: "curve" }];

test("the sections: parts, surfaces, curves and composite parts, each with its count", () => {
  const s = L.sectionsOf(bodies, datums, features, { ex2: "Lid", "curve:hx1": "Spring path" });
  assert.deepEqual(s.map((x) => [x.kind, x.title, x.count]), [["part", "Parts", 2], ["surface", "Surfaces", 1], ["curve", "Curves", 1], ["composite", "Composite parts", 1]]);
  assert.deepEqual(s[0].entries.map((e) => [e.id, e.name, e.reference]), [["ex1", "Part 1", false], ["ex2", "Lid", false], ["bd1", "Board", true]], "a reference body is listed but not counted");
  assert.deepEqual(s[2].entries[0], { id: "curve:hx1", kind: "curve", name: "Spring path", body: null, featureId: "hx1", reference: false });
  assert.equal(s[3].entries[0].kind, "composite");
  assert.equal(L.sectionsOf(bodies, datums, features)[2].entries[0].name, "Helix 1", "a curve is called after its feature");
  assert.deepEqual(L.sectionsOf([], [{ featureId: "pl1", kind: "plane" }], features), [], "a plane is no entry, and an empty section is left out");
  assert.deepEqual(L.entriesOf(s).map((e) => e.id), ["ex1", "ex2", "bd1", "su1", "curve:hx1", "cp1"]);
});

test("the model's selection marks the rows: a body by any of its geometry, a curve by itself", () => {
  const entries = L.entriesOf(L.sectionsOf(bodies, datums, features));
  const sel = [{ kind: "edge", body: "ex2", name: "e" }, { kind: "plane", plane: "top" }, { kind: "datum", featureId: "hx1" }, { kind: "datum", featureId: "pl1" }, { kind: "sketch", featureId: "sk1" }];
  assert.deepEqual(L.selectedEntryIds(entries, sel), ["ex2", "curve:hx1"]);
  assert.deepEqual(L.selectedEntryIds(entries, []), []);
});

test("a click selects one row, Ctrl adds and removes, Shift takes the range from the anchor", () => {
  const order = ["a", "b", "c", "d", "e"];
  let s = L.clickSelection(order, [], null, "b");
  assert.deepEqual(s, { selected: ["b"], anchor: "b" });
  s = L.clickSelection(order, s.selected, s.anchor, "d", { range: true });
  assert.deepEqual(s, { selected: ["b", "c", "d"], anchor: "b" });
  s = L.clickSelection(order, s.selected, s.anchor, "a", { range: true });
  assert.deepEqual(s.selected, ["a", "b"], "the range turns about the anchor");
  s = L.clickSelection(order, s.selected, s.anchor, "e", { toggle: true });
  assert.deepEqual(s, { selected: ["a", "b", "e"], anchor: "e" });
  s = L.clickSelection(order, s.selected, s.anchor, "a", { toggle: true });
  assert.deepEqual(s.selected, ["b", "e"]);
  s = L.clickSelection(order, s.selected, s.anchor, "c", { toggle: true, range: true });
  assert.deepEqual(s.selected.slice().sort(), ["a", "b", "c", "e"], "Ctrl + Shift adds the range from the anchor to what was selected");
  s = L.clickSelection(order, ["c"], "c", "c");
  assert.deepEqual(s.selected, [], "a click on the one selected row takes the selection away");
  s = L.clickSelection(order, ["b", "c"], "b", "c");
  assert.deepEqual(s.selected, ["c"], "a click on one of several selects it alone");
  s = L.clickSelection(order, ["b"], "gone", "d", { range: true });
  assert.deepEqual(s.selected, ["d"], "Shift without an anchor in the list is a plain click");
  assert.deepEqual(L.menuTargets(["a", "b"], "b"), ["a", "b"]);
  assert.deepEqual(L.menuTargets(["a", "b"], "c"), ["c"]);
  assert.deepEqual(L.menuTargets(["a"], "a"), ["a"]);
});

test("the features that made or changed a part, with what they were given", () => {
  const entries = L.entriesOf(L.sectionsOf(bodies, datums, features));
  const part = entries.find((e) => e.id === "ex1");
  const faces = ["ex1:top", "ex1:side:1", "fi1:ex1:side|ex1:top"];
  assert.deepEqual(L.featuresOfEntry(part, faces, features), ["sk1", "ex1", "fi1"]);
  assert.deepEqual(L.featuresOfEntry(part, [], features), ["sk1", "ex1"], "without its faces: who made it, and from what");
  const curve = entries.find((e) => e.id === "curve:hx1");
  assert.deepEqual(L.featuresOfEntry(curve, [], features), ["hx1"]);
  const split = { id: "ex2:2", kind: "part", name: "Part 3", body: "ex2:2", featureId: "sp1", reference: false };
  assert.ok(L.featuresOfEntry(split, [], features).includes("ex2"), "a body's id names the feature it came from");
});

// ---------------------------------------------------------------- the menu
const ctx = (targets, o = {}) => ({
  targets, total: 6, canEdit: true, busy: false, commentWhy: null, visible: () => true, anyHidden: false, isolated: null,
  transparent: () => false, hasMaterial: () => true, centreShown: false, ...o,
});
const ids = (menu) => menu.filter(Boolean).map((x) => x.id);
const entry = (id) => L.entriesOf(L.sectionsOf(bodies, datums, features)).find((e) => e.id === id);

test("the menu of a part has everything the list offers, in groups", () => {
  const m = L.partMenu(ctx([entry("ex1")]));
  assert.deepEqual(ids(m), ["rename", "properties", "material", "appearance", "transform", "export", "hide", "hide-others", "hide-all", "isolate", "transparent", "centre-show", "comment", "zoom", "delete"]);
  assert.equal(m.filter((x) => x === null).length, 4);
  assert.ok(m[0] && m[m.length - 1], "no rule at either end");
  assert.ok(m.every((x, i) => x || m[i - 1]), "no two rules together");
  assert.equal(m.find((x) => x && x.id === "delete").label, "Delete part…");
  assert.equal(m.find((x) => x && x.id === "delete").danger, true);
  assert.ok(m.filter(Boolean).every((x) => !x.why));
});

test("what does not apply to a kind is not offered", () => {
  assert.deepEqual(ids(L.partMenu(ctx([entry("su1")]))), ["rename", "properties", "appearance", "transform", "export", "hide", "hide-others", "hide-all", "isolate", "transparent", "comment", "zoom", "delete"], "a surface has no material and no mass");
  assert.deepEqual(ids(L.partMenu(ctx([entry("curve:hx1")]))), ["rename", "properties", "hide", "hide-others", "hide-all", "comment", "zoom"], "a curve is renamed, hidden and looked at");
  assert.deepEqual(ids(L.partMenu(ctx([entry("bd1")]))), ["properties", "appearance", "export", "hide", "hide-others", "hide-all", "isolate", "transparent", "comment", "zoom"], "reference geometry is neither renamed, moved nor deleted");
  assert.equal(L.partMenu(ctx([entry("cp1")])).find((x) => x && x.id === "delete").label, "Delete composite part…");
  assert.deepEqual(L.partMenu(ctx([])), []);
});

test("several rows: what can be done to all of them at once", () => {
  const m = L.partMenu(ctx([entry("ex1"), entry("ex2")]));
  assert.deepEqual(ids(m), ["material", "appearance", "transform", "export", "hide", "hide-others", "hide-all", "isolate", "transparent", "centre-show", "zoom", "delete"]);
  assert.equal(m.find((x) => x && x.id === "delete").label, "Delete 2 items…");
  const mixed = L.partMenu(ctx([entry("ex1"), entry("curve:hx1")]));
  assert.deepEqual(ids(mixed), ["hide", "hide-others", "hide-all", "zoom"], "a part and a curve share hiding and zooming");
  assert.ok(!ids(L.partMenu(ctx([entry("ex1")], { total: 1 }))).includes("hide-others"), "nothing else to hide");
});

test("the menu follows what is hidden, isolated, see-through and marked", () => {
  let m = L.partMenu(ctx([entry("ex1")], { visible: () => false, anyHidden: true }));
  assert.ok(ids(m).includes("show") && !ids(m).includes("hide") && ids(m).includes("show-all"));
  m = L.partMenu(ctx([entry("ex1"), entry("ex2")], { visible: (id) => id === "ex1", anyHidden: true }));
  assert.ok(ids(m).includes("show") && ids(m).includes("hide"), "some shown, some hidden: both are offered");
  m = L.partMenu(ctx([entry("ex1")], { isolated: ["ex1"], anyHidden: true }));
  assert.ok(ids(m).includes("unisolate") && !ids(m).includes("isolate"));
  m = L.partMenu(ctx([entry("ex1")], { isolated: ["ex2"], anyHidden: true }));
  assert.ok(ids(m).includes("isolate"), "another part is isolated: this one can be instead");
  m = L.partMenu(ctx([entry("ex1")], { transparent: () => true, centreShown: true }));
  assert.ok(ids(m).includes("opaque") && ids(m).includes("centre-hide"));
  m = L.partMenu(ctx([entry("ex1")], { hasMaterial: () => false }));
  assert.equal(m.find((x) => x && x.id === "centre-show").why, "Give the part a material first");
});

test("without edit rights, and with a dialog open, what cannot run says why", () => {
  let m = L.partMenu(ctx([entry("ex1")], { canEdit: false, commentWhy: "Sign in to comment" }));
  const why = Object.fromEntries(m.filter(Boolean).map((x) => [x.id, x.why || null]));
  for (const id of ["rename", "material", "appearance", "transform", "delete"]) assert.equal(why[id], "You have view-only access", id);
  assert.equal(why.comment, "Sign in to comment");
  for (const id of ["properties", "export", "hide", "hide-all", "isolate", "transparent", "zoom"]) assert.equal(why[id], null, id);
  m = L.partMenu(ctx([entry("ex1")], { busy: true }));
  const busy = Object.fromEntries(m.filter(Boolean).map((x) => [x.id, x.why || null]));
  for (const id of ["transform", "export", "delete"]) assert.equal(busy[id], "Finish the open dialog or sketch first", id);
  assert.equal(busy.rename, null);
});
