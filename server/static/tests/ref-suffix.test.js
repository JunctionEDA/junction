// ref-suffix.test.js — reused-sheet Reference Suffixes (annotation.reused_sheet_suffixes): the suffix a sheet path
// composes (SCH_SHEET_PATH::ComposeRefSuffix, SCH_SHEET::ResolveRefSuffix), NextRefSuffix, StripRefSuffixes and the
// package suffix of units spanning sheets (SCHEMATIC::GetPackageRefSuffix), FormatRefSuffixes, suffix-mode annotation
// (AnnotateReferences: shared bases, FindRefSuffixCollision, the report lines), ERC's duplicate_sheet_suffix and
// ref_suffix_mismatch, recomposing references when the suffixes change, the board's Geographical Reannotate with
// suffixes (ref_suffix_split.cpp, "(unknown suffix; not updated)") and the netlist's package references.
// Run: node server/static/tests/ref-suffix.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, P = globalThis.PcbTools, RS = K.refSuffix;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
console.log("reused-sheet reference suffixes");

const F = (n, v) => `(property "${n}" "${v}" (at 0 0 0) (effects (font (size 1.27 1.27))))`;
const sheetItem = (id, name, file, props = "") => `(sheet (at 100 100) (size 20 10) (uuid "${id}") ${F("Sheetname", name)} ${F("Sheetfile", file)} ${props})`;
const LIBS = `(lib_symbols
  (symbol "Device:R" ${F("Reference", "R")} (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
  (symbol "X:U2" ${F("Reference", "U")} (symbol "U2_1_1" (pin passive line (at 0 0 0) (length 1.27) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))) (symbol "U2_2_1" (pin passive line (at 0 0 0) (length 1.27) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
const inst = (paths) => `(instances (project "p" ${paths.map(([p, r, u]) => `(path "${p}" (reference "${r}") (unit ${u || 1}))`).join(" ")}))`;
const sym = (id, x, paths, lib = "Device:R", value = "10k") => `(symbol (lib_id "${lib}") (at ${x} 10 0) (unit ${paths[0][2] || 1}) (uuid "${id}") ${F("Reference", paths[0][1])} ${F("Value", value)} ${F("Footprint", "")} ${inst(paths)})`;
const doc = (uuid, body) => K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "${uuid}") (paper "A4") ${LIBS} ${body})`);
const refOn = (d, id, p) => sch._.refOn(d.items.get(id).node, p);
/** A root with two sheets (S1, S2) of one file amp.kicad_sch, suffixes _L and _R; `ampBody(paths)` gives the amp file's body. */
function reused(sfx1, sfx2, ampBody, extraRoot = "") {
  const root = doc("root", `${sheetItem("s1", "Left", "amp.kicad_sch", sfx1 === null ? "" : F("Reference Suffix", sfx1))} ${sheetItem("s2", "Right", "amp.kicad_sch", sfx2 === null ? "" : F("Reference Suffix", sfx2))} ${extraRoot}`);
  const amp = doc("amp", ampBody);
  const s1 = root.items.get("s1").node, s2 = root.items.get("s2").node;
  const sheets = [
    { doc: root, path: "/root", page: 1, file: "root.kicad_sch", human: "/", sheets: [] },
    { doc: amp, path: "/root/s1", page: 2, file: "amp.kicad_sch", human: "/Left/", sheets: [s1] },
    { doc: amp, path: "/root/s2", page: 3, file: "amp.kicad_sch", human: "/Right/", sheets: [s2] },
  ];
  return { root, amp, sheets };
}

test("ComposeRefSuffix: each sheet's suffix from the top down, text variables of the sheet and its parents resolved", () => {
  const top = K.parse(`(sheet (uuid "t") ${F("Sheetname", "Top")} ${F("Sheetfile", "t.kicad_sch")} ${F("Reference Suffix", "_${BANK}")} ${F("BANK", "A")} ${F("CH", "9")})`);
  const sub = K.parse(`(sheet (uuid "s") ${F("Sheetname", "Sub")} ${F("Sheetfile", "s.kicad_sch")} ${F("Reference Suffix", "${CH}${Sheetname}${NOPE}")})`);
  assert.strictEqual(RS.sheetRefSuffix(top, []), "_A");
  assert.strictEqual(RS.composeRefSuffix([top, sub]), "_A9${Sheetname}${NOPE}", "a parent's field resolves; mandatory fields and unknown names stay as written");
  assert.strictEqual(RS.composeRefSuffix([null, sub]), "${CH}${Sheetname}${NOPE}");
  assert.strictEqual(RS.stripRefSuffix("R1_A", "_A"), "R1");
  assert.strictEqual(RS.stripRefSuffix("_A", "_A"), null, "nothing would be left");
  assert.strictEqual(RS.stripRefSuffix("R?", "?"), null, "an unannotated reference is never stripped");
});

test("NextRefSuffix: a free suffix is kept, numbers and short letter runs continue their series, words are kept", () => {
  assert.strictEqual(RS.nextRefSuffix("_M1", ["_M2"]), "_M1");
  assert.strictEqual(RS.nextRefSuffix("_M1", ["_M1", "_M3"]), "_M4");
  assert.strictEqual(RS.nextRefSuffix("_M09", ["_M09"]), "_M10", "the width is kept");
  assert.strictEqual(RS.nextRefSuffix("_Z", ["_Z"]), "_AA");
  assert.strictEqual(RS.nextRefSuffix("_b", ["_a", "_b"]), "_c");
  assert.strictEqual(RS.nextRefSuffix("_LEFT", ["_LEFT"]), "_LEFT", "a run longer than two letters is a word");
  assert.strictEqual(RS.nextRefSuffix("_A", ["_A"], (c) => c === "_B"), "_C", "aIsTaken also bars a candidate");
});

test("StripRefSuffixes, package suffixes and FormatRefSuffixes (MAIL_SCH_GET_REF_SUFFIXES)", () => {
  const { sheets } = reused("_L", "_R",
    `${sym("r1", 10, [["/root/s1", "R1_L"], ["/root/s2", "R7"]])} ${sym("u1", 20, [["/root/s1", "U5_L", 1], ["/root/s2", "U5_R", 2]], "X:U2", "LM358")}`);
  const units = (d, n) => (K.str(K.kid(n, "lib_id")[1]) === "X:U2" ? 2 : 1);
  const rs = RS.refSuffixes(sheets.map((s) => ({ doc: s.doc, path: s.path, sheets: s.sheets })), true, units);
  assert.ok(rs.has && rs.mode);
  assert.strictEqual(rs.suffix("/root/s1"), "_L"); assert.strictEqual(rs.suffix("/root"), "");
  assert.strictEqual(rs.base("r1", "/root/s1"), "R1");
  assert.strictEqual(rs.base("r1", "/root/s2"), "R7"); assert.ok(rs.lacks("r1", "/root/s2"), "R7 was saved without _R");
  assert.strictEqual(rs.base("u1", "/root/s2"), "U5");
  assert.strictEqual(rs.packageSuffix("u1", "/root/s2"), "_L", "a package spanning sheets composes with its lowest suffix");
  assert.strictEqual(rs.packageSuffix("u1", "/root/s1"), "_L");
  assert.strictEqual(rs.unitSuffix("u1", "/root/s1", 2), "_R", "unit B shows its own sheet's suffix");
  assert.strictEqual(RS.composedRef(rs, "u1", "/root/s2", "U5", 2, "B", { includeUnit: true }), "U5B_R");
  assert.strictEqual(RS.composedRef(rs, "u1", "/root/s2", "U5", 2, "B"), "U5_L");
  assert.strictEqual(RS.formatRefSuffixes(rs), "ref_suffixes\n/\t\n/s1/\t_L\n/s2/\t_R\n/s2/u1\t_L\n");
  const off = RS.refSuffixes(sheets.map((s) => ({ doc: s.doc, path: s.path, sheets: s.sheets })), false, units);
  assert.ok(!off.has && off.suffix("/root/s1") === "" && off.packageSuffix("u1", "/root/s2") === "", "without suffix numbering GetRefSuffix is empty");
});

test("annotate in suffix mode: the first instance numbers each symbol and every instance shares the base", () => {
  const { amp, sheets } = reused("_L", "_R", `${sym("ra", 10, [["/root/s1", "R?"], ["/root/s2", "R?"]])} ${sym("rb", 30, [["/root/s1", "R?"], ["/root/s2", "R?"]])}`);
  const r = sch.annotateHierarchy(sheets, { all: true, sheets: sheets.map((sheet) => ({ sheet })) }, { order: "x", keep: true, suffixMode: true });
  assert.ok(!r.fatal);
  const ch = r.changes.get(amp); assert.ok(ch && ch.length === 2);
  for (const c of ch) K.applyChange(amp, c, 1e4);
  assert.deepStrictEqual(["ra", "rb"].map((id) => [refOn(amp, id, "/root/s1"), refOn(amp, id, "/root/s2")]), [["R1_L", "R1_R"], ["R2_L", "R2_R"]]);
  assert.deepStrictEqual(r.messages, ["Annotated 10k as R1_L.", "Annotated 10k as R2_L.", "References in amp.kicad_sch apply to every sheet that uses it."]);
  assert.deepStrictEqual(r.errors, [], "R1_L and R1_R are different references");
  // without suffix numbering each instance takes its own number
  const sep = reused("_L", "_R", `${sym("ra", 10, [["/root/s1", "R?"], ["/root/s2", "R?"]])}`);
  const r2 = sch.annotateHierarchy(sep.sheets, { all: true, sheets: sep.sheets.map((sheet) => ({ sheet })) }, { order: "x", keep: true, suffixMode: false });
  for (const c of r2.changes.get(sep.amp)) K.applyChange(sep.amp, c, 1e4);
  assert.deepStrictEqual([refOn(sep.amp, "ra", "/root/s1"), refOn(sep.amp, "ra", "/root/s2")], ["R1", "R2"]);
});

test("annotate in suffix mode: a kept base whose composed reference is taken elsewhere is renumbered (RenumberBasesUsedBy)", () => {
  // a root R1 holds the base amp's R1 keeps, and the root sheet is outside the scope
  const { amp, sheets } = reused("_L", "_R", `${sym("ra", 10, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])}`, sym("rr", 50, [["/root", "R1"]], "Device:R", "1k"));
  const r = sch.annotateHierarchy(sheets, { all: false, sheets: [{ sheet: sheets[1] }] }, { order: "x", keep: true, suffixMode: true });
  for (const c of r.changes.get(amp) || []) K.applyChange(amp, c, 1e4);
  assert.deepStrictEqual([refOn(amp, "ra", "/root/s1"), refOn(amp, "ra", "/root/s2")], ["R2_L", "R2_R"]);
  assert.deepStrictEqual(r.messages.slice(0, 1), ["Updated 10k from R1_L to R2_L."]);
});

test("annotate in suffix mode: instances composing the same suffix stop the annotation (FindRefSuffixCollision)", () => {
  const { sheets } = reused("_L", "_L", `${sym("ra", 10, [["/root/s1", "R?"], ["/root/s2", "R?"]])}`);
  const r = sch.annotateHierarchy(sheets, { all: true, sheets: sheets.map((sheet) => ({ sheet })) }, { order: "x", keep: true, suffixMode: true });
  assert.strictEqual(r.fatal, "Sheets /Left and /Right use amp.kicad_sch with the same reference suffix. Give each sheet a distinct suffix before annotating.");
  assert.strictEqual(r.changes.size, 0);
});

test("CheckAnnotate composes the suffixes: R1_L and R1_R are no duplicates, two bare R1 are", () => {
  const { sheets } = reused("_L", "_R", `${sym("ra", 10, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])}`);
  const insts = sheets.map((s) => ({ doc: s.doc, path: s.path, page: s.page, sheets: s.sheets, suffixMode: true }));
  assert.strictEqual(sch.checkAnnotate(insts), 0);
  const bare = reused(null, null, `${sym("ra", 10, [["/root/s1", "R1"], ["/root/s2", "R1"]])}`);
  assert.strictEqual(sch.checkAnnotate(bare.sheets.map((s) => ({ doc: s.doc, path: s.path, page: s.page, sheets: s.sheets, suffixMode: true }))), 1);
});

test("ERC: duplicate_sheet_suffix on the sheet symbol, ref_suffix_mismatch for a reference saved without its suffix or off its shared base", () => {
  const run = (sfx1, sfx2, body, mode = true) => {
    const { root, amp } = reused(sfx1, sfx2, body);
    const docs = [{ doc: root, key: "", path: "/root", page: 1, parent: null, sheetId: null, root: true },
      { doc: amp, key: "s1", path: "/root/s1", page: 2, parent: 0, sheetId: "s1" }, { doc: amp, key: "s2", path: "/root/s2", page: 3, parent: 0, sheetId: "s2" }];
    return sch.ercHierarchy(docs, { suffixMode: mode });
  };
  const codes = (out, code) => out.map((l) => l.filter((m) => m.code === code).map((m) => [m.text, m.ids.join(",")]));
  const dup = run("_L", "_L", `${sym("ra", 10, [["/root/s1", "R1_L"], ["/root/s2", "R1_L"]])}`);
  assert.deepStrictEqual(codes(dup, "duplicate_sheet_suffix"), [[["Reused sheets have the same reference suffix", "s2,s1"]], [], []]);
  assert.strictEqual(dup[0].find((m) => m.code === "duplicate_sheet_suffix").severity, "error");
  const bare = run(null, null, `${sym("ra", 10, [["/root/s1", "R1"], ["/root/s2", "R2"]])}`);
  assert.strictEqual(codes(bare, "duplicate_sheet_suffix")[0].length, 1, "in suffix mode two bare instances collide too");
  assert.strictEqual(codes(run(null, null, `${sym("ra", 10, [["/root/s1", "R1"], ["/root/s2", "R2"]])}`, false), "duplicate_sheet_suffix")[0].length, 0, "not without suffix numbering");
  const mis = run("_L", "_R", `${sym("ra", 10, [["/root/s1", "R1_L"], ["/root/s2", "R2_R"]])} ${sym("rb", 30, [["/root/s1", "R5_L"], ["/root/s2", "R5"]])}`);
  assert.deepStrictEqual(codes(mis, "ref_suffix_mismatch"), [[], [], [["Reference R2_R does not share the base of R1_L", "ra"], ["Reference R5 was saved without the suffix _R", "rb"]]]);
  assert.strictEqual(mis[2].find((m) => m.code === "ref_suffix_mismatch").severity, "warning");
});

test("a suffix edited or suffix numbering turned on or off recomposes the files' references (RefreshRefSuffixes)", () => {
  const { amp, sheets } = reused("_L", "_R", `${sym("ra", 10, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])}`);
  const newS1 = K.parse(K.serialize(sheets[1].sheets[0]).replace('"_L"', '"_X"'));
  const edited = sch.recomposeChanges(sheets.map((s, i) => Object.assign({}, s, { after: i === 1 ? [newS1] : s.sheets })), true, true);
  for (const c of edited.get(amp)) K.applyChange(amp, c, 1e4);
  assert.deepStrictEqual([refOn(amp, "ra", "/root/s1"), refOn(amp, "ra", "/root/s2")], ["R1_X", "R1_R"]);
  const offAmp = reused("_L", "_R", `${sym("ra", 10, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])}`);
  const off = sch.recomposeChanges(offAmp.sheets, true, false);
  for (const c of off.get(offAmp.amp)) K.applyChange(offAmp.amp, c, 1e4);
  assert.deepStrictEqual([refOn(offAmp.amp, "ra", "/root/s1"), refOn(offAmp.amp, "ra", "/root/s2")], ["R1", "R1"], "turned off, the files hold the bases");
  const on = sch.recomposeChanges(offAmp.sheets, false, true);
  for (const c of on.get(offAmp.amp)) K.applyChange(offAmp.amp, c, 1e4);
  assert.deepStrictEqual([refOn(offAmp.amp, "ra", "/root/s1"), refOn(offAmp.amp, "ra", "/root/s2")], ["R1_L", "R1_R"]);
});

test("Geographical Reannotate: copies on reused sheets share a renumbered base, unknown suffixes are kept (DIALOG_BOARD_REANNOTATE)", () => {
  const fp = (id, ref, x, p, extra = "") => `(footprint "T:R" (layer "F.Cu") (uuid "${id}") (at ${x} 10) (path "${p}") ${extra}
    (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "p-${id}") (effects (font (size 1 1) (thickness 0.15)))))`;
  const board = K.parseDoc(`(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    ${fp("a", "R7_L", 30, "/s1/ra")} ${fp("b", "R7_R", 10, "/s2/ra")} ${fp("c", "R3", 20, "/rr")} ${fp("d", "R9X_L", 40, "/s1/rx")})`, "kicad_pcb");
  const suffixes = "ref_suffixes\n/\t\n/s1/\t_L\n/s2/\t_R\n";
  const base = { sortCode: 4, useFootprintLocation: true, grid: 1.27, scope: "all", excludeLocked: true, exclude: "", frontStart: "1", backStart: "", frontPrefix: "", backPrefix: "", removeFrontPrefix: false, removeBackPrefix: false };
  const r = P.geographicalReannotate(board, Object.assign({}, base, { suffixes, suffixMode: true }));
  assert.ok(r.ok);
  const ren = Object.fromEntries(r.renames.map((x) => [x.from, x.to]));
  assert.deepStrictEqual(ren, { R3: "R1", R7_L: "R2_L", R7_R: "R2_R" }, "the copy on the earlier sheet numbers the base both copies keep with their suffixes");
  assert.ok(r.report.some((l) => l.text === "R9X_L  (unknown suffix; not updated)"));
  assert.ok(r.report.some((l) => l.severity === "warning" && /^1 footprints keep their references because their sheet suffixes could not be determined\./.test(l.text)));
  // a standalone board (no schematic) in suffix mode cannot tell a suffix from the number
  const alone = P.geographicalReannotate(board, Object.assign({}, base, { suffixes: null, suffixMode: true }));
  assert.deepStrictEqual(Object.fromEntries(alone.renames.map((x) => [x.from, x.to])), { R3: "R1" });
  assert.deepStrictEqual(P.parseRefSuffixes ? P.parseRefSuffixes("nope") : null, null);
});

test("netlist: a multi-unit package spanning sheets is one component under its package reference (GetPackageRefSuffix)", () => {
  const { root, amp } = reused("_L", "_R", `${sym("u1", 20, [["/root/s1", "U5_L", 1], ["/root/s2", "U5_R", 2]], "X:U2", "LM358")}`);
  const files = { "root.kicad_sch": { doc: root, uuid: "root", file: "root.kicad_sch" }, "amp.kicad_sch": { doc: amp, uuid: "amp", file: "amp.kicad_sch" } };
  const helpers = { symbolPins: (d, it) => sch._.symbolPins(d, it), isPower: () => false };
  const nl = K.pcbNetlist.buildNetlist(files["root.kicad_sch"], (f) => files[f] || null, helpers, "p", { refSuffixMode: true });
  assert.deepStrictEqual(nl.components.map((c) => [c.ref, c.paths]), [["U5_L", ["/s1/u1", "/s2/u1"]]]);
  const plain = K.pcbNetlist.buildNetlist(files["root.kicad_sch"], (f) => files[f] || null, helpers, "p", {});
  assert.deepStrictEqual(plain.components.map((c) => c.ref).sort(), ["U5_L", "U5_R"], "without suffix numbering the stored references stand");
  assert.strictEqual(K.pcbNetlist.netlistOptions({ schematic: { annotation: { reused_sheet_suffixes: true } } }).refSuffixMode, true);
});

// ---- Part 2: editing, placing, pasting, the Fields Table and back-annotation with suffixes
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
/** suffixSheets() of the reused() fixture, the Left copy on screen. */
const rawOf = (sheets, mode = true, increment = true) => ({ sheets: sheets.map((x, i) => Object.assign({}, x, { shown: i === 1, project: "p" })), mode, increment });

test("Reference editing: GetBaseRef, BaseRefFromUser (echo, base, sibling suffix), SetUserRef sharing the base, Composed reference", () => {
  const { amp, sheets } = reused("_L", "_R", `${sym("r1", 20, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])}`);
  const sc = sch.suffixCtx(rawOf(sheets)), sheet = sch.suffixSheetOf(sc, amp), n = amp.items.get("r1").node;
  assert.strictEqual(sheet.path, "/root/s1");
  assert.strictEqual(sch.baseRefOn(sc, sheet, n), "R1", "the field shows the base");
  assert.deepStrictEqual(sch.baseRefFromUser(sc, sheet, n, "R1"), { base: "R1", error: "" });
  assert.strictEqual(sch.baseRefFromUser(sc, sheet, n, "R1_L").base, "R1", "an echoed composed reference keeps its base");
  assert.strictEqual(sch.baseRefFromUser(sc, sheet, n, "R5").base, "R5");
  const bad = sch.baseRefFromUser(sc, sheet, n, "R5_R");
  assert.ok(/^R5_R ends with the reference suffix of sheet /.test(bad.error), bad.error);
  assert.strictEqual(sch.composedRefLabel(sc, sheet, n, "R7"), "R7_L");
  sch.setUserRef(sc, sheet, n, "R7");
  assert.strictEqual(refOn(amp, "r1", "/root/s1"), "R7_L");
  assert.strictEqual(refOn(amp, "r1", "/root/s2"), "R7_R", "the other path shares the base");
  // suffix numbering off: the typed reference is stored as it is, on this path only
  const off = reused("_L", "_R", `${sym("r1", 20, [["/root/s1", "R1"], ["/root/s2", "R2"]])}`);
  const so = sch.suffixCtx(rawOf(off.sheets, false)), sh = sch.suffixSheetOf(so, off.amp);
  assert.strictEqual(sch.composedRefLabel(so, sh, off.amp.items.get("r1").node, "R9"), null);
  sch.setUserRef(so, sh, off.amp.items.get("r1").node, "R9");
  assert.deepStrictEqual([refOn(off.amp, "r1", "/root/s1"), refOn(off.amp, "r1", "/root/s2")], ["R9", "R2"]);
});

test("AnnotateNewSymbol: a placed symbol shares one base across the paths, skipping bases whose composed reference is taken", () => {
  const { root, amp, sheets } = reused("_L", "_R", `${sym("r1", 20, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])} ${sym("r2", 40, [["/root/s1", "R5_L"], ["/root/s2", "R5_R"]])}`,
    `${sym("x9", 60, [["/root", "R2_L"]])}`);
  const sc = sch.suffixCtx(rawOf(sheets)), a = sch.newSymbolSuffixes(sc, amp, "r2");
  assert.ok(a.share);
  assert.deepStrictEqual(a.paths.map((p) => p.path), ["/root/s1", "/root/s2"]);
  const next = (used) => { const taken = new Set(used.map((h) => h.ref)); let k = 1; while (taken.has("R" + k)) k++; return "R" + k; };
  assert.strictEqual(sch.shareNewSymbolBase(a, { lib: "Device:R", value: "10k", unit: 1 }, next), "R3", "R2 composes to R2_L, which the root holds");
  assert.strictEqual(sch.shareNewSymbolBase(a, { lib: "Device:R", value: "10k", unit: 1, power: true }, next), "R2", "power symbols are not shared");
  sch.writeSharedRefs(sc, a, amp.items.get("r2").node, "R3");
  assert.deepStrictEqual([refOn(amp, "r2", "/root/s1"), refOn(amp, "r2", "/root/s2")], ["R3_L", "R3_R"]);
  assert.ok(root);
});

test("Increment Annotations in suffix mode: each path's base is numbered on and keeps its suffix", () => {
  const { amp, sheets } = reused("_L", "_R", `${sym("r1", 20, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])} ${sym("r2", 40, [["/root/s1", "R2_L"], ["/root/s2", "R2_R"]])}`);
  const changes = sch.incrementAnnotationChanges(amp, "R1", 10, { raw: rawOf(sheets) });
  for (const c of changes) K.applyChange(amp, c, 1e4);
  assert.deepStrictEqual(["r1", "r2"].map((id) => [refOn(amp, id, "/root/s1"), refOn(amp, id, "/root/s2")]), [["R11_L", "R11_R"], ["R12_L", "R12_R"]]);
});

test("Copy writes bases; pasting a sheet with a Reference Suffix takes the next free suffix (increment_pasted_suffix)", () => {
  const { root, amp, sheets } = reused("_L", "_R", `${sym("r1", 20, [["/root/s1", "R1_L"], ["/root/s2", "R1_R"]])}`);
  const raw = rawOf(sheets), sc = sch.suffixCtx(raw);
  const clip = sch.clipboardText(amp, [amp.items.get("r1")], { suffixes: sc });
  assert.ok(/\(reference "R1"\)/.test(clip) && !/R1_L/.test(clip), "the clipboard holds the base");
  const sheetClip = sch.clipboardText(root, [root.items.get("s1")]);
  const ctx = { K, doc: root, IU: 1e4, isSch: true, suffixSheets: () => raw, sheetFile: "root.kicad_sch" };
  const r = sch._.pasteChanges(root, sch.parseClipboard(sheetClip), [0, 0], { ctx, pasteMode: "unique" });
  const pasted = r.changes.filter((c) => c.kind === "ADDED").map((c) => K.parseAll(c.sexpr)[0]).find((t) => t[0] === "sheet");
  assert.strictEqual(RS.refSuffixText(pasted), "_S", "the letter run continues past _L and _R");
  raw.increment = false;
  const r2 = sch._.pasteChanges(root, sch.parseClipboard(sheetClip), [0, 0], { ctx, pasteMode: "unique" });
  assert.strictEqual(RS.refSuffixText(r2.changes.filter((c) => c.kind === "ADDED").map((c) => K.parseAll(c.sexpr)[0]).find((t) => t[0] === "sheet")), "_L", "kept without increment_pasted_suffix");
});

test("Fields Table / BOM: references grouped by suffix as ranges (FormatRefDesRanges), units of one package once", () => {
  const D = load(["dialogs", "logic.ts"]);
  assert.strictEqual(D.formatRefDesRanges([["R1", "_L"], ["R1", "_R"], ["R2", "_L"], ["R3", "_L"]], ", ", "-"), "R1_L-R3_L, R1_R");
  assert.strictEqual(D.formatRefDesRanges([["R1", "_L"], ["R2", "_L"]], ", ", "-"), "R1_L, R2_L", "a run of two is two references");
  const row = (b, s) => ({ ref: b + s, refBase: b, refSuffix: s });
  assert.strictEqual(D.refRangesWithSuffixes([row("U1", "_L"), row("U1", "_L"), row("U2", "_R"), row("U1", "_R")], ", ", "-"), "U1_L, U1_R, U2_R");
});

test("Update Schematic from PCB: a board reference must keep the sheet suffix, and copies sharing a base must agree (ResolveBackannotatedRefs)", () => {
  const BA = load(["dialogs", "update-from-pcb-logic.ts"]);
  const s = (key, ref, refSuffix, uuid) => ({ key, ref, refSuffix, uuid });
  const ok = BA.resolveBackannotatedRefs([{ s: s("/s1/r1", "R1_L", "_L", "r1"), boardRef: "R5_L" }, { s: s("/s2/r1", "R1_R", "_R", "r1"), boardRef: "R5_R" }], true);
  assert.deepStrictEqual(ok, [{ base: "R5", error: "" }, { base: "R5", error: "" }]);
  const lacks = BA.resolveBackannotatedRefs([{ s: s("/s1/r1", "R1_L", "_L", "r1"), boardRef: "R5" }], true);
  assert.ok(/lacks the sheet suffix '_L'/.test(lacks[0].error), lacks[0].error);
  const split = BA.resolveBackannotatedRefs([{ s: s("/s1/r1", "R1_L", "_L", "r1"), boardRef: "R5_L" }, { s: s("/s2/r1", "R1_R", "_R", "r1"), boardRef: "R6_R" }], true);
  assert.ok(split.every((x) => /cannot reach all of its units and sheets/.test(x.error) && x.base === ""));
  assert.deepStrictEqual(BA.resolveBackannotatedRefs([{ s: s("/s1/r1", "R1_L", "_L", "r1"), boardRef: "R5_L" }, { s: s("/s2/r1", "R1_R", "_R", "r1"), boardRef: "R6_R" }], false).map((x) => x.base), ["R5", "R6"], "without shared bases each copy goes its own way");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
