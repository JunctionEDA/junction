// Node test for what the part studio's feature list is built on:
//   document/folders.ts      folders (nesting, moving several rows, unpacking, deleting), and when a feature is
//                            suppressed (its own switch, a suppressed folder, dynamic suppression)
//   document/conditions.ts   the conditions of dynamic suppression
//   document/inputs.ts       that every builder of a part studio sees the same suppression
//   ui/featurelist/filter.ts the search box and its commands (:part :type :name :errors :warnings :folder
//                            :variable :suppressed :hidden :shown)
// Run: node server/static/tests/cad-featurelist.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./cad-load");
const D = load("shared/itemdoc/itemdoc.ts");
const F = load("domains/mechanical/document/format.ts");
const E = load("domains/mechanical/document/edits.ts");
const O = load("domains/mechanical/document/folders.ts");
const C = load("domains/mechanical/document/conditions.ts");
const I = load("domains/mechanical/document/inputs.ts");
const V = load("domains/mechanical/document/variables.ts");
const S = load("domains/mechanical/ui/featurelist/filter.ts");

/** A part studio with features named a, b, c … in that order (ids the same as the names). */
function studio(names) {
  const doc = D.parseItemDoc(F.newPartStudioText(), F.PART_STUDIO_KIND);
  let order = null;
  for (const n of names) { order = D.orderBetween(order, null); D.applyChanges(doc, [D.addedChange({ id: n, type: "feature", featureType: n === "s" ? "sketch" : "extrude", name: n.toUpperCase(), order, params: {} })]); }
  return doc;
}
const apply = (doc, changes) => { D.applyChanges(doc, changes); return doc; };
const names = (doc) => F.featuresOf(doc).map((f) => f.id).join("");
/** The tree as text: a(b c) is folder a holding b and c. */
const shape = (doc) => { const show = (nodes) => nodes.map((n) => (n.kind === "feature" ? n.feature.id : `${n.folder.name}(${show(n.children)})`)).join(" "); return show(O.treeOf(doc).roots); };
const folder = (doc, ids, name) => { const r = O.addToFolder(doc, ids, name); apply(doc, r.changes); return r.folder.id; };

// ---------------------------------------------------------------- folders

test("without folders the tree is the list", () => {
  const doc = studio(["a", "b", "c"]);
  assert.equal(shape(doc), "a b c");
  assert.equal(O.foldersOf(doc).size, 0);
});

test("a folder gathers what was selected where the first of it is, in list order", () => {
  const doc = studio(["a", "b", "c", "d", "e"]);
  const r = O.addToFolder(doc, ["d", "b"], "Holes");
  assert.equal(r.folder.name, "Holes");
  apply(doc, r.changes);
  assert.equal(names(doc), "abdce", "b and d sit together where b was");
  assert.equal(shape(doc), "a Holes(b d) c e");
  assert.equal(doc.items.get("b").folder, r.folder.id);
  assert.equal(doc.items.get(r.folder.id).type, "folder");
});

test("a folder made inside a folder is nested in it; a folder can be put in a new folder", () => {
  const doc = studio(["a", "b", "c", "d"]);
  const outer = folder(doc, ["a", "b", "c"], "Outer");
  const inner = folder(doc, ["b", "c"], "Inner");
  assert.equal(shape(doc), "Outer(a Inner(b c)) d");
  assert.equal(doc.items.get(inner).parent, outer);
  const top = folder(doc, [outer, "d"], "Top");
  assert.equal(shape(doc), "Top(Outer(a Inner(b c)) d)");
  assert.equal(doc.items.get(outer).parent, top);
  assert.equal(doc.items.get("d").folder, top);
  assert.equal(names(doc), "abcd");
});

test("making a folder is one step that its inverse undoes", () => {
  const doc = studio(["a", "b", "c"]);
  const before = D.serializeItemDoc(doc);
  const { changes } = O.addToFolder(doc, ["a", "c"], "F");
  const inverse = changes.map((c) => D.invertChange(doc, c)).reverse();
  apply(doc, changes);
  assert.equal(shape(doc), "F(a c) b");
  apply(doc, inverse);
  assert.equal(D.serializeItemDoc(doc), before);
});

test("several rows move together, between rows or into a folder; what empties is removed", () => {
  const doc = studio(["a", "b", "c", "d", "e"]);
  const f = folder(doc, ["a", "b"], "F");
  apply(doc, O.moveItems(doc, ["e", "c"], 1, f));               // into F, between a and b
  assert.equal(shape(doc), "F(a c e b) d");
  apply(doc, O.moveItems(doc, ["a", "b"], 5, null));            // out, to the end
  assert.equal(shape(doc), "F(c e) d a b");
  assert.equal(doc.items.get("a").folder, undefined);
  apply(doc, O.moveItems(doc, [f], 5, null));                   // the folder itself, with what it holds
  assert.equal(shape(doc), "d a b F(c e)");
  apply(doc, O.moveToFolder(doc, ["c", "e"], null));            // the last things leave: the folder goes
  assert.equal(shape(doc), "d a b c e");
  assert.equal(O.foldersOf(doc).size, 0);
  assert.deepEqual(O.moveItems(doc, ["a", "b"], 1, null), [], "already there: no change");
});

test("a folder cannot be moved into itself or into what it holds", () => {
  const doc = studio(["a", "b", "c"]);
  const outer = folder(doc, ["a", "b"], "Outer"), inner = folder(doc, ["b"], "Inner");
  assert.deepEqual(O.moveToFolder(doc, [outer], inner), []);
  assert.deepEqual(O.moveToFolder(doc, [outer], outer), []);
  assert.equal(shape(doc), "Outer(a Inner(b)) c");
});

test("unpacking leaves the features where they are, in the folder around", () => {
  const doc = studio(["a", "b", "c"]);
  const outer = folder(doc, ["a", "b", "c"], "Outer"), inner = folder(doc, ["b", "c"], "Inner");
  apply(doc, O.unpackFolder(doc, inner));
  assert.equal(shape(doc), "Outer(a b c)");
  assert.equal(doc.items.get("b").folder, outer);
  apply(doc, O.unpackFolder(doc, outer));
  assert.equal(shape(doc), "a b c");
  assert.equal(doc.items.get("b").folder, undefined);
});

test("deleting a folder deletes what is in it, and the rollback bar moves to what stays", () => {
  const doc = studio(["a", "b", "c", "d"]);
  const f = folder(doc, ["b", "c"], "F");
  apply(doc, E.setRollback(doc, "c"));
  apply(doc, O.deleteItems(doc, [f]));
  assert.equal(names(doc), "ad");
  assert.equal(O.foldersOf(doc).size, 0);
  assert.equal(F.studioOf(doc).rollback, "d");
});

test("features that drift apart are shown where they are built: the folder is its first run", () => {
  const doc = studio(["a", "b", "c", "d"]);
  const f = folder(doc, ["a", "b"], "F");
  // someone who knows no folders moves d between a and b, and puts c in the folder without moving it
  apply(doc, [{ id: "d", kind: "MODIFIED", props: [{ path: ["order"], value: D.orderBetween(doc.items.get("a").order, doc.items.get("b").order) }] }]);
  assert.equal(names(doc), "adbc");
  assert.equal(shape(doc), "F(a) d b c", "the build order is kept; b is drawn outside");
  apply(doc, [{ id: "ghost", kind: "ADDED", item: { id: "ghost", type: "feature", featureType: "extrude", name: "G", order: "zz", folder: "no-such-folder", params: {} } }]);
  assert.equal(shape(doc), "F(a) d b c ghost");
  assert.equal(O.suppressionOf(doc).get("b").byFolder, null);
  void f;
});

test("a feature added or moved between two features of a folder joins it (edits.ts)", () => {
  const doc = studio(["a", "b", "c"]);
  const f = folder(doc, ["a", "b"], "F");
  apply(doc, E.setRollback(doc, "b"));
  const { changes, feature } = E.addFeature(doc, { type: "extrude", title: "Extrude", defaults: () => ({}) });
  apply(doc, changes);
  assert.equal(feature.folder, f);
  assert.equal(shape(doc), `F(a ${feature.id} b) c`);
  apply(doc, E.moveFeature(doc, "c", 1));
  assert.equal(doc.items.get("c").folder, f);
  apply(doc, E.moveFeature(doc, "c", 3));
  assert.equal(doc.items.get("c").folder, undefined);
  assert.equal(shape(doc), `F(a ${feature.id} b) c`);
});

test("two people at once: one renames a folder, the other moves a feature into it", () => {
  const a = studio(["a", "b", "c"]);
  const f = folder(a, ["a"], "F");
  const b = D.parseItemDoc(D.serializeItemDoc(a), F.PART_STUDIO_KIND);
  const ca = O.renameItem(a, f, "Renamed"), cb = O.moveToFolder(b, ["c"], f);
  apply(a, ca); apply(a, cb); apply(b, cb); apply(b, ca);
  assert.equal(shape(a), "Renamed(a c) b");
  assert.equal(D.serializeItemDoc(a), D.serializeItemDoc(b));
});

// ---------------------------------------------------------------- suppression

test("a suppressed folder suppresses what it holds, and each feature keeps its own switch", () => {
  const doc = studio(["a", "b", "c"]);
  const f = folder(doc, ["a", "b"], "F");
  apply(doc, O.suppressItems(doc, ["a"], true));
  apply(doc, O.suppressItems(doc, [f], true));
  let s = O.suppressionOf(doc);
  assert.deepEqual([s.get("a").suppressed, s.get("b").suppressed, s.get("c").suppressed], [true, true, false]);
  assert.equal(s.get("b").byFolder, f);
  assert.equal(s.get("b").own, false);
  assert.equal(doc.items.get("b").suppressed, undefined, "the folder is suppressed as one thing");
  apply(doc, O.suppressItems(doc, [f], false));
  s = O.suppressionOf(doc);
  assert.deepEqual([s.get("a").suppressed, s.get("b").suppressed], [true, false], "what was suppressed singly stays suppressed");
});

test("a folder suppresses the folders inside it", () => {
  const doc = studio(["a", "b"]);
  const outer = folder(doc, ["a", "b"], "Outer"); folder(doc, ["b"], "Inner");
  apply(doc, O.suppressItems(doc, [outer], true));
  assert.equal(O.suppressionOf(doc).get("b").byFolder, outer);
});

test("conditions compare expressions and join with && || !", () => {
  const lookup = V.lookupOf({ values: new Map([["depth", 12], ["n", 3]]), dims: new Map([["depth", 1], ["n", 0]]) });
  const yes = (t) => assert.equal(C.evaluateCondition(t, lookup), true, t), no = (t) => assert.equal(C.evaluateCondition(t, lookup), false, t);
  yes("#depth < 0.5 in"); no("#depth >= .5 in"); yes("depth == 12 mm"); yes("depth = 12"); no("depth != 12");
  yes("n >= 3 && depth > 10"); no("n > 3 && depth > 10"); yes("n > 3 || depth > 10"); yes("!(n > 3)"); yes("(n + 1) * 2 == 8");
  yes("(n > 5 || depth < 20) && n == 3"); yes("true"); no("false"); yes("n"); no("n - 3");
  assert.match(C.conditionProblem("width > 2", lookup), /no variable/);
  assert.match(C.conditionProblem("depth >", lookup), /both sides/);
  assert.match(C.conditionProblem("1 < 2 < 3", lookup), /&&/);
  assert.equal(C.conditionProblem("depth > 2", lookup), null);
});

test("dynamic suppression follows the variables; a condition that cannot be read suppresses nothing", () => {
  const doc = studio(["a", "b"]);
  const v = V.addVariable(doc, "depth", "8 mm"); apply(doc, v.changes);
  apply(doc, O.setSuppressIf(doc, "b", "#depth < 10 mm"));
  assert.equal(doc.items.get("b").suppressIf, "#depth < 10 mm");
  const built = () => I.studioInputs(doc).features.map((f) => (f.suppressed ? "-" : f.id)).join("");
  assert.equal(built(), "a-");
  apply(doc, V.setVariable(doc, v.variable.id, { expr: "15 mm" }));
  assert.equal(built(), "ab");
  apply(doc, O.setSuppressIf(doc, "a", "nonsense >"));
  assert.equal(built(), "ab");
  assert.ok(O.suppressionOf(doc, F.featuresOf(doc), V.lookupOf(V.variableValues(V.variablesOf(doc)))).get("a").conditionError);
  apply(doc, O.setSuppressIf(doc, "a", null));
  assert.equal(doc.items.get("a").suppressIf, undefined);
});

test("every builder sees a folder's suppression (document/inputs.ts)", () => {
  const doc = studio(["a", "b", "c"]);
  const f = folder(doc, ["b", "c"], "F");
  assert.deepEqual(I.studioInputs(doc).features.map((x) => x.suppressed), [false, false, false]);
  apply(doc, O.suppressItems(doc, [f], true));
  assert.deepEqual(I.studioInputs(doc).features.map((x) => x.suppressed), [false, true, true]);
  // the file round-trips, folders and all
  const again = D.parseItemDoc(D.serializeItemDoc(doc), F.PART_STUDIO_KIND);
  assert.equal(shape(again), "a F(b c)");
  assert.deepEqual(I.studioInputs(again).features.map((x) => x.suppressed), [false, true, true]);
});

// ---------------------------------------------------------------- the search box

const LIST = {
  features: [
    { id: "s1", name: "Sketch 1", type: "sketch", typeTitle: "Sketch", status: "ok", suppressed: false, hidden: true, variables: [], folders: [] },
    { id: "e1", name: "Base", type: "extrude", typeTitle: "Extrude", status: "ok", suppressed: false, hidden: null, variables: ["depth"], folders: ["f1"] },
    { id: "h1", name: "Mounting hole", type: "hole", typeTitle: "Hole", status: "error", suppressed: false, hidden: null, variables: ["Dia"], folders: ["f1", "f2"] },
    { id: "f9", name: "Fillet 1", type: "fillet", typeTitle: "Fillet", status: "warning", suppressed: false, hidden: null, variables: [], folders: [] },
    { id: "p1", name: "Plane 1", type: "plane", typeTitle: "Plane", status: "suppressed", suppressed: true, hidden: false, variables: [], folders: [] },
  ],
  bodies: [
    { id: "b1", name: "Part 1", kind: "part", hidden: false, features: ["e1", "h1", "f9"] },
    { id: "b2", name: "Part 10", kind: "part", hidden: true, features: ["e1"] },
    { id: "b3", name: "Surface 1", kind: "surface", hidden: false, features: ["s1"] },
  ],
  folders: [{ id: "f1", name: "Body", parent: null }, { id: "f2", name: "Holes", parent: "f1" }],
};
const run = (text) => { const r = S.runFilter(S.parseFilter(text), LIST); return { active: r.active, features: [...r.features].join(), bodies: [...r.bodies].join(), folders: [...r.folders].join() }; };

test("plain text finds by a piece of the name or of the type", () => {
  assert.equal(run("").active, false);
  assert.deepEqual(run("hole"), { active: true, features: "h1", bodies: "", folders: "f2" });
  assert.equal(run("EXTR").features, "e1", "a renamed extrude is found by its type");
  assert.equal(run("part").bodies, "b1,b2");
  assert.equal(run("zzz").features, "");
});

test("the commands", () => {
  assert.deepEqual(S.parseFilter(":part part 1"), { command: "part", text: "part 1", partial: null });
  assert.deepEqual(run(":part part 1"), { active: true, features: "e1,h1,f9", bodies: "b1,b2", folders: "" });
  assert.equal(run(":part part 10").features, "e1");
  assert.equal(run(":type sketch").features, "s1");
  assert.equal(run(":type surface").bodies, "b3");
  assert.equal(run(":name base").features, "e1");
  assert.equal(run(":name extrude").features, "", ":name does not look at the type");
  assert.equal(run(":errors").features, "h1");
  assert.equal(run(":errors fillet").features, "");
  assert.equal(run(":warnings").features, "f9");
  assert.deepEqual(run(":folder holes"), { active: true, features: "h1", bodies: "", folders: "f2" });
  assert.equal(run(":folder body").features, "e1,h1");
  assert.equal(run(":variable").features, "e1,h1");
  assert.equal(run(":variable Dia").features, "h1");
  assert.equal(run(":variable dia").features, "", ":variable minds capitals");
  assert.equal(run(":suppressed").features, "p1");
  assert.deepEqual([run(":hidden").features, run(":hidden").bodies], ["s1", "b2"]);
  assert.deepEqual([run(":shown").features, run(":shown").bodies], ["e1,h1,f9,p1", "b1,b3"]);
  assert.equal(run(":SHOWN plane").features, "p1");
});

test("a command being typed filters nothing yet, and offers what it could become", () => {
  assert.deepEqual(S.parseFilter(":pa"), { command: null, text: "", partial: "pa" });
  assert.equal(run(":pa").active, false);
  assert.deepEqual(S.completions("s").map((c) => c.id), ["suppressed", "shown"]);
  assert.equal(S.completions(null).length, 0);
  assert.equal(run(":nosuch thing").features, "", "an unknown command is text nothing is called");
  assert.equal(S.withCommand("hole", "errors"), ":errors hole");
  assert.equal(S.withCommand(":errors hole", "name"), ":name hole");
  assert.equal(S.withCommand(":errors hole", null), "hole");
  assert.equal(S.withCommand(":er", "errors"), ":errors ");
  assert.equal(S.FILTER_COMMANDS.length, 10);
});
