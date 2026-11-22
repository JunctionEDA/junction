// sch-edit-clipboard.test.js — KiCad parity of the schematic's edit and clipboard commands: rotate / mirror (fields
// re-autoplaced, text justification, sheets, images), swap, delete (junction merge), cut / copy / paste (plain text,
// locked items, groups, clipboard library symbols, sheets, annotation, reference point), duplicate and Repeat Last Item.
// Run: node server/static/tests/sch-edit-clipboard.test.js
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const { kid, kids, atOf, ptsOf } = K;
const IU = 1e4;

let passed = 0, failed = 0; const tests = [];
function test(name, fn) { tests.push([name, fn]); }                    // run in order at the end: some wait for the clipboard / a dialog
const LIB = (val) => `(symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
  (property "Value" "${val || "R"}" (at 0 0 90) (effects (font (size 1.27 1.27))))
  (property "Footprint" "" (at -1.778 0 90) (hide yes) (effects (font (size 1.27 1.27))))
  (property "Datasheet" "~" (at 0 0 0) (hide yes) (effects (font (size 1.27 1.27))))
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1"
    (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
const HEAD = (lib) => `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "root-uuid") (paper "A4") (lib_symbols ${lib === undefined ? LIB() : lib}) `;
const sym = (id, ref, x, y, extra) => `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) ${extra || ""} (uuid "${id}")
  (property "Reference" "${ref}" (at ${x + 2.032} ${y - 1.27} 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Value" "10k" (at ${x + 2.032} ${y + 1.27} 0) (effects (font (size 1.27 1.27)) (justify left)))
  (property "Footprint" "" (at ${x - 1.778} ${y} 90) (hide yes) (effects (font (size 1.27 1.27))))
  (property "Datasheet" "~" (at ${x} ${y} 0) (hide yes) (effects (font (size 1.27 1.27))))
  (pin "1" (uuid "${id}-p1")) (pin "2" (uuid "${id}-p2"))
  (instances (project "t" (path "/root-uuid" (reference "${ref}") (unit 1)))))`;
const wire = (a, b, u) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${u}"))`;
const text = (t, x, y, rot, just, u) => `(text "${t}" (exclude_from_sim no) (at ${x} ${y} ${rot}) (effects (font (size 1.27 1.27))${just ? ` (justify ${just})` : ""}) (uuid "${u}"))`;
const label = (t, x, y, u) => `(label "${t}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${u}"))`;
const sheet = (id, name, file, x, y, extra) => `(sheet (at ${x} ${y}) (size 20.32 10.16) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid "${id}")
  (property "Sheetname" "${name}" (at ${x} ${y - 0.7116} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
  (property "Sheetfile" "${file}" (at ${x} ${y + 10.16 + 0.5846} 0) (effects (font (size 1.27 1.27)) (justify left top)))
  ${extra || ""}
  (instances (project "t" (path "/root-uuid" (page "2")))))`;

function makeCtx(doc, more) {
  const ctx = Object.assign({
    K, doc, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [],
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    selection: new Set(), cursor: null, clip: "", clipIds: null, clipboard: { get: () => ctx.clip, set: (t, ids) => { ctx.clip = t; ctx.clipIds = ids || null; } },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); ctx.lastSelection = Array.from(ids); const prim = ctx.lastSelection.map((id) => doc.items.get(id)).find((it) => it && (it.kind === "symbol" || it.kind === "sheet")); ctx.selected = prim ? { id: prim.id } : null; },
    commit(changes, label) { ctx.log.push({ changes, label }); for (const c of changes) assert.ok(K.applyChange(doc, c, IU), "applyChange accepted " + c.kind + " " + c.id); sch.onDocChanged(ctx); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  }, more || {});
  return ctx;
}
function open(body, lib, more) {
  const d = K.parseDoc(HEAD(lib) + body + ")", "kicad_sch"), c = makeCtx(d, more);
  sch.onActivate("select", c); sch.onDocChanged(c); sch.select(null); sch.state.annotateAuto = true; _.setFollow(false);
  return { d, c };
}
const last = (c) => c.log[c.log.length - 1];
const pick = (c, ids) => { sch.select(null); c.selection = new Set(ids); const p = ids.map((id) => c.doc.items.get(id)).find((it) => it && (it.kind === "symbol" || it.kind === "sheet")); c.selected = p ? { id: p.id } : null; if (ids.length === 1 && !p) { c.selection = new Set(); sch.select(ids[0]); } };
const nodeOf = (change) => K.parseAll(change.sexpr).filter((t) => t[0] !== "lib_symbols")[0];
const prop = (n, name) => kids(n, "property").find((p) => p[1] === name);
const justify = (n) => { const j = kid(kid(n, "effects"), "justify"); return j ? j.slice(1).join(" ") : ""; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test("rotating a lone symbol re-autoplaces its fields (AutoplaceFields after Rotate); a mirror drops fields_autoplaced; steps are named Rotate / Mirror", () => {
  const { d, c } = open(sym("s1", "R1", 50.8, 50.8, "(fields_autoplaced yes)"));
  pick(c, ["s1"]);
  assert.ok(sch.runAction("rotateSelection", c)); assert.strictEqual(last(c).label, "Rotate");
  const n = d.items.get("s1").node, at = atOf(n), ref = atOf(prop(n, "Reference"));
  assert.ok(kid(n, "fields_autoplaced"), "still autoplaced");
  // a rigid quarter turn of (52.832, 49.53) about the anchor would leave it beside the body; the autoplacer puts the
  // fields of a horizontal resistor above / below it, centred on the anchor
  assert.strictEqual(ref[0], at[0], "Reference centred over the horizontal body");
  assert.notStrictEqual(ref[1], at[1]);
  pick(c, ["s1"]);
  assert.ok(sch.runAction("mirrorSelectionY", c)); assert.strictEqual(last(c).label, "Mirror");
  assert.strictEqual(kid(d.items.get("s1").node, "fields_autoplaced"), null, "ClearFieldsAutoplaced");
});

test("rotating a lone symbol cleans up the wires at its pins (junction where a pin lands on a wire's middle)", () => {
  // pin 2 at (50.8, 54.61); after a CCW turn about the anchor the pins lie on y = 50.8 at x = 46.99 and 54.61
  const { d, c } = open(sym("s1", "R1", 50.8, 50.8) + wire([54.61, 40.64], [54.61, 60.96], "w1") + wire([54.61, 50.8], [63.5, 50.8], "w2"));
  pick(c, ["s1"]);
  assert.ok(sch.runAction("rotateSelection", c));
  assert.ok([...d.items.values()].some((it) => it.kind === "junction" && atOf(it.node)[0] === 54.61 && atOf(it.node)[1] === 50.8), "the pin landing on the T gets its junction in the same step");
  assert.strictEqual(c.log.length, 1);
});

test("free text turns like SCH_TEXT::Rotate90 and mirrors by flipping its justification, not as a label", () => {
  const { d, c } = open(text("note", 50.8, 50.8, 0, "left", "t1"));
  const T = () => d.items.get("t1").node;
  pick(c, ["t1"]); assert.ok(sch.runAction("rotateSelection", c));
  assert.strictEqual(atOf(T())[2], 90); assert.strictEqual(justify(T()), "left", "horizontal -> vertical, counter-clockwise: the justification stays");
  pick(c, ["t1"]); assert.ok(sch.runAction("rotateSelection", c));
  assert.strictEqual(atOf(T())[2] || 0, 0); assert.strictEqual(justify(T()), "right", "vertical -> horizontal, counter-clockwise: FlipHJustify");
  pick(c, ["t1"]); assert.ok(sch.runAction("rotateSelectionCW", c));
  assert.strictEqual(atOf(T())[2], 90); assert.strictEqual(justify(T()), "left", "horizontal, clockwise: FlipHJustify");
  pick(c, ["t1"]); assert.ok(sch.runAction("mirrorSelectionX", c));
  assert.strictEqual(justify(T()), "left", "Mirror Horizontally leaves vertical text as it is (MirrorSpinStyle( true ))");
  pick(c, ["t1"]); assert.ok(sch.runAction("mirrorSelectionY", c));
  assert.strictEqual(atOf(T())[2], 90); assert.strictEqual(justify(T()), "right", "Mirror Vertically of vertical text flips the horizontal justification");
  assert.deepStrictEqual(atOf(T()).slice(0, 2), [50.8, 50.8], "a lone text mirrors about its own position");
});

test("the rotation centre of a multi-selection: texts and labels only -> the mean of their positions, else the box of the other items", () => {
  const { d } = open(text("a", 10.16, 10.16, 0, "left", "t1") + label("N", 20.32, 30.48, "l1") + wire([50.8, 50.8], [60.96, 50.8], "w1") + wire([60.96, 50.8], [60.96, 71.12], "w2"));
  const it = (id) => d.items.get(id);
  assert.deepStrictEqual(_.selectionCentre([it("t1"), it("l1")]), [15.24, 20.32]);
  assert.deepStrictEqual(_.selectionCentre([it("t1"), it("w1"), it("w2")]), [55.88, 60.96], "the text does not widen the box");
});

test("a lone sheet turns about its body centre; its fields go vertical; no-connects on its pins follow; a mirror drops fields_autoplaced", () => {
  const pin = `(pin "IN" input (at 50.8 55.88 180) (uuid "sp1") (effects (font (size 1.27 1.27)) (justify left)))`;
  const { d, c } = open(sheet("sh1", "Power", "power.kicad_sch", 50.8, 50.8, pin) + `(no_connect (at 50.8 55.88) (uuid "nc1"))`);
  pick(c, ["sh1"]);
  assert.ok(sch.runAction("rotateSelection", c));
  const n = d.items.get("sh1").node, size = kid(n, "size").slice(1), at = atOf(n);
  assert.deepStrictEqual(size, [10.16, 20.32], "the body is turned");
  const pinAt = atOf(kids(n, "pin")[0]).slice(0, 2);
  assert.deepStrictEqual(atOf(d.items.get("nc1").node).slice(0, 2), pinAt, "the no-connect rides with the sheet pin");
  const name = prop(n, "Sheetname"), file = prop(n, "Sheetfile");
  assert.strictEqual(atOf(name)[2], 90); assert.strictEqual(atOf(file)[2], 90);
  assert.deepStrictEqual([atOf(name)[0], atOf(name)[1]], [Math.round((at[0] - 0.7116) * 1e4) / 1e4, Math.round((at[1] + size[1]) * 1e4) / 1e4], "name left of a vertical sheet, from its bottom");
  assert.deepStrictEqual([atOf(file)[0], atOf(file)[1]], [Math.round((at[0] + size[0] + 0.5846) * 1e4) / 1e4, Math.round((at[1] + size[1]) * 1e4) / 1e4]);
  assert.ok(kid(n, "fields_autoplaced"));
  pick(c, ["sh1"]); assert.ok(sch.runAction("mirrorSelectionY", c));
  assert.strictEqual(kid(d.items.get("sh1").node, "fields_autoplaced"), null);
  assert.deepStrictEqual(atOf(d.items.get("nc1").node).slice(0, 2), atOf(kids(d.items.get("sh1").node, "pin")[0]).slice(0, 2), "and with the mirrored pin");
});

test("mirroring an image flips the picture itself (BITMAP_BASE::Mirror), left-right for Mirror Horizontally and top-bottom for Mirror Vertically, swapped a quarter turn away", async () => {
  const img = (rot) => `(image (at 50.8 50.8)${rot ? ` (rotate ${rot})` : ""} (uuid "i1") (data "QUJD"))`;
  const calls = [];
  _.setImageFlipImpl((b64, leftRight) => { calls.push([b64, leftRight]); return Promise.resolve(b64.split("").reverse().join("")); });
  try {
    const { d, c } = open(img(0));
    pick(c, ["i1"]); assert.ok(sch.runAction("mirrorSelectionX", c)); await tick(); await tick();   // X: Mirror Horizontally
    assert.deepStrictEqual(calls, [["QUJD", true]]);
    assert.strictEqual(last(c).label, "Mirror");
    assert.strictEqual(kid(d.items.get("i1").node, "data").slice(1).join(""), "DJUQ", "the flipped data is what is committed");
    pick(c, ["i1"]); assert.ok(sch.runAction("mirrorSelectionY", c)); await tick(); await tick();
    assert.deepStrictEqual(calls[1], ["DJUQ", false]);
    const q = open(img(90)); pick(q.c, ["i1"]); assert.ok(sch.runAction("mirrorSelectionX", q.c)); await tick(); await tick();
    assert.deepStrictEqual(calls[2], ["QUJD", false], "stored a quarter turn away: the other axis of the stored picture");
    assert.strictEqual(q.c.log.length, 1);
  } finally { _.setImageFlipImpl(null); }
});

test("swap: texts trade places and justification, symbols of one library symbol trade orientation; no junction clean-up, the step is Swap", () => {
  const { d, c } = open(text("a", 10.16, 10.16, 0, "left", "t1") + text("b", 30.48, 20.32, 90, "right", "t2"));
  pick(c, ["t1", "t2"]);
  assert.ok(sch.runAction("swap", c)); assert.strictEqual(last(c).label, "Swap");
  const a = d.items.get("t1").node, b = d.items.get("t2").node;
  assert.deepStrictEqual(atOf(a).slice(0, 2), [30.48, 20.32]); assert.deepStrictEqual(atOf(b).slice(0, 2), [10.16, 10.16]);
  assert.strictEqual(justify(a), "right"); assert.strictEqual(justify(b), "left");
  assert.strictEqual(atOf(a)[2] || 0, 0, "the text angle is not swapped"); assert.strictEqual(atOf(b)[2], 90);
  assert.deepStrictEqual(last(c).changes.map((x) => x.kind), ["MODIFIED", "MODIFIED"]);
  c.toasts.length = 0; pick(c, ["t1"]); sch.runAction("swap", c); assert.deepStrictEqual(c.toasts, [], "fewer than two items: nothing, and nothing said");
});

test("deleting the stem of a T merges the through-wire again (DeleteJunction); the step is Delete", () => {
  const { d, c } = open(wire([10.16, 20.32], [20.32, 20.32], "a") + wire([20.32, 20.32], [30.48, 20.32], "b") + wire([20.32, 20.32], [20.32, 30.48], "s") + `(junction (at 20.32 20.32) (diameter 0) (color 0 0 0 0) (uuid "j"))`);
  const ch = sch.deleteChanges(d, [d.items.get("s")]);
  for (const x of ch) assert.ok(K.applyChange(d, x, IU));
  const wires = [...d.items.values()].filter((i) => i.kind === "wire").map((i) => ptsOf(i.node));
  assert.deepStrictEqual(wires, [[[10.16, 20.32], [30.48, 20.32]]], "one wire again");
  assert.ok(![...d.items.values()].some((i) => i.kind === "junction"));
  assert.strictEqual(d.items.size, 1);
  const o = open(wire([10.16, 20.32], [20.32, 20.32], "a")); pick(o.c, ["a"]); sch.select("a");
  assert.ok(sch.onKey("Delete", {}, o.c)); assert.strictEqual(last(o.c).label, "Delete");
});

test("cut copies everything and deletes only what is not locked; the step is the delete's", () => {
  const { d, c } = open(wire([10.16, 20.32], [20.32, 20.32], "a") + text("keep", 30.48, 30.48, 0, "left", "t1").replace("(exclude_from_sim no)", "(exclude_from_sim no) (locked yes)"));
  pick(c, ["a", "t1"]);
  assert.ok(sch.runAction("cut", c));
  assert.ok(/\(wire/.test(c.clip) && /"keep"/.test(c.clip), "both are on the clipboard");
  assert.deepStrictEqual(c.clipIds.slice().sort(), ["a", "t1"], "the copied ids go along for the picture formats");
  assert.strictEqual(last(c).label, "Delete");
  assert.ok(!d.items.has("a") && d.items.has("t1"), "the locked text stays");
});

test("paste: plain text becomes a text item, long text asks first; a locked item comes back unlocked", async () => {
  const { d, c } = open("");
  c.clip = "hello world"; c.cursor = [50.8, 50.8];
  assert.ok(sch.runAction("paste", c));
  const t = nodeOf(last(c).changes[0]); assert.strictEqual(t[0], "text"); assert.strictEqual(t[1], "hello world");
  assert.deepStrictEqual(atOf(t).slice(0, 2), [50.8, 50.8]); assert.strictEqual(justify(t), "", "centred, as EDA_TEXT starts out");
  const asked = []; let answer = false;
  globalThis.KDialogs = { confirm(title, msg, okLabel) { asked.push([title, msg, okLabel]); return Promise.resolve(answer); } };
  try {
    const n0 = c.log.length; c.clip = "x".repeat(101);
    assert.ok(sch.runAction("paste", c)); await tick();
    assert.strictEqual(asked.length, 1); assert.strictEqual(asked[0][0], "Confirmation"); assert.strictEqual(asked[0][2], "Yes");
    assert.strictEqual(c.log.length, n0, "No: nothing pasted");
    answer = true; assert.ok(sch.runAction("paste", c)); await tick();
    assert.strictEqual(c.log.length, n0 + 1);
    c.clip = "y".repeat(100); assert.ok(sch.runAction("paste", c)); assert.strictEqual(asked.length, 2, "100 characters paste without a question");
  } finally { delete globalThis.KDialogs; }
  c.clip = text("L", 10.16, 10.16, 0, "left", "tl").replace("(exclude_from_sim no)", "(exclude_from_sim no) (locked yes)");
  assert.ok(sch.runAction("paste", c));
  const p = nodeOf(last(c).changes[0]); assert.strictEqual(p[1], "L"); assert.strictEqual(kid(p, "locked"), null, "SetLocked( false )");
  assert.strictEqual(d.items.size, 4);
});

test("paste keeps the clipboard's library symbol: a different one under the same name comes in as <name>_<n>", () => {
  const src = open(sym("s1", "R1", 50.8, 50.8), LIB("OTHER"));
  pick(src.c, ["s1"]); assert.ok(sch.runAction("copy", src.c));
  const { d, c } = open(sym("s0", "R7", 25.4, 25.4));
  c.clip = src.c.clip; c.cursor = [76.2, 76.2];
  assert.ok(sch.runAction("paste", c));
  const n = nodeOf(last(c).changes.find((x) => x.typeName === "SCH_SYMBOL"));
  const ln = kid(n, "lib_name"); assert.ok(ln && /^R_\d+$/.test(ln[1]), "lib_name names the variant: " + (ln && ln[1]));
  assert.ok(d.lib.has(ln[1]) || d.lib.has("Device:" + ln[1]) || [...d.lib.keys()].some((k) => k.endsWith(ln[1])), "the variant is in the sheet's library cache");
  assert.strictEqual(kid(n, "lib_id")[1], "Device:R", "lib_id is untouched");
  // the same library symbol: no variant
  const same = open(sym("s0", "R7", 25.4, 25.4)); const s2 = open(sym("s1", "R1", 50.8, 50.8)); pick(s2.c, ["s1"]); sch.runAction("copy", s2.c);
  same.c.clip = s2.c.clip; same.c.cursor = [76.2, 76.2]; assert.ok(sch.runAction("paste", same.c));
  assert.strictEqual(kid(nodeOf(last(same.c).changes.find((x) => x.typeName === "SCH_SYMBOL")), "lib_name"), null);
});

test("a copied group pastes as a group of the new members", () => {
  const { d, c } = open(wire([10.16, 20.32], [20.32, 20.32], "a") + text("m", 30.48, 30.48, 0, "left", "t1") + `(group "G" (uuid "g1") (members "a" "t1"))`);
  const text0 = sch.clipboardText(d, [d.items.get("g1")]);
  assert.ok(/\(wire/.test(text0) && /"m"/.test(text0) && /\(group "G"/.test(text0), "the members travel with their group");
  c.clip = text0; c.cursor = [76.2, 76.2];
  assert.ok(sch.runAction("paste", c));
  const added = last(c).changes.filter((x) => x.kind === "ADDED"), g = added.find((x) => x.typeName === "SCH_GROUP" || /^\(group/.test(x.sexpr));
  assert.ok(g, "a group is added"); const gn = nodeOf(g), members = kid(gn, "members").slice(1);
  assert.strictEqual(members.length, 2); assert.ok(!members.includes("a") && !members.includes("t1"), "fresh member ids");
  for (const m of members) assert.ok(d.items.has(m), "member " + m + " is on the sheet");
  assert.notStrictEqual(g.id, "g1");
});

test("annotation of pasted symbols follows the project's settings (start number, sheet number x 100) in X-then-Y order", () => {
  const { d } = open(sym("s0", "R1", 25.4, 25.4));
  const mk = (id, x, y) => K.parseAll(sym(id, "R?", x, y))[0];
  const a = mk("a", 76.2, 25.4), b = mk("b", 50.8, 50.8);
  _.annotatePastedUnique(d, [a, b], { reannotate: true, startNum: 0, method: 0, sortY: false });
  assert.deepStrictEqual([prop(b, "Reference")[2], prop(a, "Reference")[2]], ["R2", "R3"], "left to right");
  const a2 = mk("a", 76.2, 25.4), b2 = mk("b", 50.8, 50.8);
  _.annotatePastedUnique(d, [a2, b2], { reannotate: true, startNum: 0, method: 0, sortY: true });
  assert.deepStrictEqual([prop(a2, "Reference")[2], prop(b2, "Reference")[2]], ["R2", "R3"], "top to bottom");
  const a3 = mk("a", 76.2, 25.4);
  _.annotatePastedUnique(d, [a3], { reannotate: true, startNum: 0, method: 1, sheetNumber: 3 });
  assert.strictEqual(prop(a3, "Reference")[2], "R301");
  const a4 = mk("a", 76.2, 25.4);
  _.annotatePastedUnique(d, [a4], { reannotate: true, startNum: 10, method: 0 });
  assert.strictEqual(prop(a4, "Reference")[2], "R11");
  const cfg = _.annotationSettings({ designSettings: JSON.stringify({ schematic: { annotate_start_num: 20, annotation: { method: 2, sort_order: 1 } } }), pageNumber: 4 }, d);
  assert.deepStrictEqual(cfg, { method: 2, sortY: true, startNum: 20, sheetNumber: 4 });
});

test("paste reference point: the top-left connectable item lands on the cursor, not the first symbol", () => {
  const src = open(sym("s1", "R1", 76.2, 76.2) + wire([25.4, 50.8], [38.1, 50.8], "w1") + text("far left", 5.08, 5.08, 0, "left", "t1"));
  pick(src.c, ["s1", "w1", "t1"]); sch.runAction("copy", src.c);
  const { c } = open(""); c.clip = src.c.clip; c.cursor = [101.6, 101.6];
  assert.ok(sch.runAction("paste", c));
  const w = nodeOf(last(c).changes.find((x) => x.typeName === "SCH_LINE"));
  assert.deepStrictEqual(ptsOf(w)[0], [101.6, 101.6], "the wire (left-most connectable item) is the reference, the text further left is not");
});

test("cut and paste keeping the annotations gives the symbol back with its uuid; a copy next to the original gets a new one", () => {
  const { d, c } = open(sym("s1", "R1", 50.8, 50.8));
  pick(c, ["s1"]); assert.ok(sch.runAction("cut", c)); assert.ok(!d.items.has("s1"));
  c.cursor = [76.2, 76.2];
  assert.ok(sch.runAction("pasteSpecial", c, { pasteMode: "keep" }) || true);
  const back = last(c).changes.find((x) => x.typeName === "SCH_SYMBOL");
  assert.strictEqual(back.id, "s1", "the cut symbol keeps its uuid");
  assert.ok(sch.runAction("pasteSpecial", c, { pasteMode: "keep" }) || true);
  const again = last(c).changes.find((x) => x.typeName === "SCH_SYMBOL");
  assert.notStrictEqual(again.id, "s1", "a second paste cannot reuse it");
});

test("Paste Special reads the clipboard first: nothing on it, no dialog", () => {
  const { c } = open(""); let opened = 0;
  globalThis.KDialogs = { open() { opened++; } };
  try { c.clip = ""; sch.runAction("pasteSpecial", c); assert.strictEqual(opened, 0); c.clip = wire([0, 0], [2.54, 0], "w"); c.cursor = [10.16, 10.16]; sch.runAction("pasteSpecial", c); assert.strictEqual(opened, 1, "with content the dialog opens"); }
  finally { delete globalThis.KDialogs; }
});

test("pasted sheets: a unique name, the next free page number, and a sheet that would recurse is dropped", () => {
  const { d, c } = open(sheet("sh1", "Power", "power.kicad_sch", 50.8, 50.8), undefined, {
    docs: [{ docId: "d-root", path: "root.kicad_sch", docType: "kicad_sch" }, { docId: "d-pow", path: "power.kicad_sch", docType: "kicad_sch" }], docId: "d-pow",
    sheetHierarchy: () => ({ paths: [["root.kicad_sch"], ["root.kicad_sch", "power.kicad_sch"]], docs: new Map() }),
  });
  assert.strictEqual(_.pastedSheetRecursion(c, "root.kicad_sch"), true, "the destination's parent");
  assert.strictEqual(_.pastedSheetRecursion(c, "power.kicad_sch"), true, "the destination itself");
  assert.strictEqual(_.pastedSheetRecursion(c, "other.kicad_sch"), false);
  c.clip = sheet("x1", "Power", "other.kicad_sch", 10.16, 10.16) + sheet("x2", "Loop", "root.kicad_sch", 40.64, 10.16); c.cursor = [101.6, 101.6];
  assert.ok(sch.runAction("paste", c));
  const added = last(c).changes.filter((x) => x.kind === "ADDED"); assert.strictEqual(added.length, 1, "the recursive sheet is dropped");
  const n = nodeOf(added[0]);
  assert.notStrictEqual(prop(n, "Sheetname")[2], "Power", "the name is made unique"); assert.ok(/^Power/.test(prop(n, "Sheetname")[2]));
  const page = kid(kids(kid(kid(n, "instances"), "project"), "path")[0], "page")[1];
  assert.strictEqual(page, "3", "page 2 is taken by the sheet already here");
  assert.ok(c.toasts.some((m) => /was dropped because the destination already has the sheet or one of its subsheets as a parent/.test(m)));
  assert.strictEqual(d.items.size, 2);
});

test("duplicate of a hover selection is not left selected; Duplicate does not touch the clipboard", () => {
  const { c } = open(sym("s1", "R1", 50.8, 50.8));
  pick(c, ["s1"]); c.cursor = [76.2, 76.2]; c.clip = "untouched";
  sch.state.dupHover = true;
  assert.ok(sch.runAction("duplicate", c)); assert.strictEqual(last(c).label, "Paste");
  assert.deepStrictEqual(c.lastSelection, [], "SetIsHover( m_duplicateIsHoverSelection )");
  assert.strictEqual(sch.state.dupHover, false, "the flag is for the one action");
  assert.strictEqual(c.clip, "untouched");
  pick(c, ["s1"]); assert.ok(sch.runAction("duplicate", c)); assert.strictEqual(c.lastSelection.length, 1, "an explicit selection: the copy stays selected");
});

test("Repeat Last Item of a symbol is one Repeat Item step at the click, numbered from the project's start number; Esc leaves nothing behind", () => {
  const { d, c } = open(sym("s1", "R1", 50.8, 50.8), undefined, { designSettings: { schematic: { annotate_start_num: 100, annotation: { method: 0, sort_order: 0 } } } });
  _.rememberPlaced("symbol", d.items.get("s1").node);
  _.setFollow(true);
  try {
    c.cursor = [76.2, 76.2]; const n0 = c.log.length, size = d.items.size;
    assert.ok(sch.runAction("repeatLast", c));
    assert.strictEqual(c.log.length, n0, "nothing is committed while the symbol follows the cursor");
    assert.ok(sch.state.drag && sch.state.drag.local && sch.state.drag.local.size === 1);
    sch.cancelDrag(c);
    assert.strictEqual(d.items.size, size, "Esc: the copy is gone"); assert.strictEqual(c.log.length, n0);
    assert.ok(sch.runAction("repeatLast", c));
    sch.moveDrag(c, [101.6, 76.2]); sch.endDrag(c, true);
    assert.strictEqual(c.log.length, n0 + 1, "one undo step"); assert.strictEqual(last(c).label, "Repeat Item");
    const n = nodeOf(last(c).changes.find((x) => x.typeName === "SCH_SYMBOL"));
    assert.deepStrictEqual(atOf(n).slice(0, 2), [101.6, 76.2]);
    assert.strictEqual(prop(n, "Reference")[2], "R101", "annotate_start_num 100");
  } finally { _.setFollow(false); }
});

test("Copy as Text: shown text of texts and labels only, trimmed, empty ones skipped", () => {
  const { d, c } = open(sym("s1", "R1", 50.8, 50.8) + text("  spaced  ", 10.16, 10.16, 0, "left", "t1") + label("NET1", 20.32, 20.32, "l1") + wire([0, 0], [2.54, 0], "w1"));
  assert.strictEqual(_.schItemAsText(d, d.items.get("s1")), "", "a symbol gives nothing");
  assert.strictEqual(_.schItemAsText(d, d.items.get("w1")), "");
  pick(c, ["s1", "t1", "l1", "w1"]);
  assert.ok(sch.runAction("copyAsText", c));
  assert.deepStrictEqual(c.clip.split("\n").sort(), ["NET1", "spaced"]);
  c.clip = "before"; pick(c, ["s1", "w1"]); sch.runAction("copyAsText", c); assert.strictEqual(c.clip, "", "SaveClipboard of the empty text");
});

(async () => {
  for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
  console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})();
