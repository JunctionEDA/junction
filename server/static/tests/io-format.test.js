// io-format.test.js — the s-expression reader / writer against KiCad's DSNLEXER and SCH / PCB parsers: escapes, comment
// lines, number-shaped text, quoting past 30 slots, and what the parsers change while reading a file of an older format
// version (canvas/legacy.ts), plus the readers that depend on the file version.
// Run: node server/static/tests/io-format.test.js
"use strict";
const assert = require("assert");
const path = require("path");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); } }
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps || 1e-6), (msg || "") + ` expected ${b}, got ${a}`);
const kid = K.kid, kids = K.kids;

console.log("io-format: reader, writer and older file versions");

// ---------------------------------------------------------------- DSNLEXER
test("escapes: \\a \\b \\f \\n \\r \\t \\v, \\x hex, octal, goofed escapes (dsnlexer.cpp); the writer escapes CR", () => {
  const n = K.parse('(t "a\\rb" "\\a\\b\\f\\v" "\\x41\\x4" "\\101\\7" "\\xZ" "\\q" "\\"\\\\" "\\xc3\\xa9")');
  assert.deepStrictEqual(n.slice(1), ["a\rb", "\x07\x08\x0c\x0b", "A\x04", "A\x07", "xZ", "\\q", '"\\', "é"]);
  assert.strictEqual(K.serialize(["text", "a\r\nb"]), '(text "a\\r\\nb")');
  assert.strictEqual(K.serialize(K.parse('(text "a\\rb")')), '(text "a\\rb")', "a CR survives a round trip");
});

test("a line whose first non-blank character is # is a comment (parse, parseAll, the fold's cutter)", () => {
  const n = K.parse("# header comment\n(kicad_pcb (version 20240108)\n  # inside a list\n  (net 0 \"\")\n)");
  assert.ok(n && n[0] === "kicad_pcb", "a leading comment line");
  assert.deepStrictEqual(n.slice(1).map((c) => c[0]), ["version", "net"], "a comment line inside a list is no atom");
  assert.deepStrictEqual(K.parse('(a "x # y" b#c)').slice(1), ["x # y", "b#c"], "a # after a token is not a comment");
  assert.strictEqual(K.parseAll("# c\n(a)\n# d\n(b)").length, 2);
});

test("a bare number-shaped atom keeps its text unless it is the number's own spelling (0603, 1.0, tstamps)", () => {
  const n = K.parse("(fp_text value 0603 (at 1.0 -0 90) (tstamp 5E123456) (x 00112233 1e3 1.27 -2.5 4.70))");
  assert.strictEqual(n[2], "0603"); assert.deepStrictEqual(kid(n, "at").slice(1), ["1.0", 0, 90]);
  assert.strictEqual(K.uuidOf(n), "5E123456", "the tstamp is its text, not Infinity");
  assert.deepStrictEqual(kid(n, "x").slice(1), ["00112233", "1e3", 1.27, -2.5, "4.70"]);
  assert.strictEqual(K.num(kid(n, "at")[1]), 1, "num() still reads the text as a number");
  assert.strictEqual(K.serialize(n), "(fp_text value 0603 (at 1.0 0 90) (tstamp 5E123456) (x 00112233 1e3 1.27 -2.5 4.70))", "written back bare");
});

test("quoting is remembered past the 30th slot: every base64 row of (data …) stays quoted", () => {
  const rows = []; for (let i = 0; i < 40; i++) rows.push(i === 35 ? "abcDEF" : "iVBORw0KGgo" + i + "+/=");
  const n = K.parse("(data " + rows.map((r) => '"' + r + '"').join(" ") + ")");
  assert.ok(K.serialize(n).includes('"abcDEF"'), "row 36 keeps its quotes");
  assert.ok(K.serialize(K.cloneNode(n)).includes('"abcDEF"'), "and so does a copy");
  assert.ok(K.serialize(["data", "abcDEF", "xyz"]).includes('"abcDEF" "xyz"'), "a hand-built (data …) writes every row quoted (FormatStreamData)");
});

// ---------------------------------------------------------------- older schematics
const SCH = (v, body) => `(kicad_sch (version ${v}) (generator "eeschema") (uuid "root") (paper "A4") ${body})`;

test("schematic before 20250318: a field or instance value of ~ is empty; pin names / numbers ~ too", () => {
  const lib = '(lib_symbols (symbol "D:R" (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27))))'
    + ' (symbol "R_1_1" (pin passive line (at 0 0 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "~" (effects (font (size 1.27 1.27))))))))';
  const sym = '(symbol (lib_id "D:R") (at 10 10 0) (unit 1) (uuid "s1") (property "Reference" "R1" (at 0 0 0) (effects (font (size 1.27 1.27)))) (property "Datasheet" "~" (at 0 0 0) (effects (font (size 1.27 1.27))))'
    + ' (instances (project "p" (path "/root" (reference "R1") (unit 1) (value "~") (footprint "~")))))';
  const old = K.parseDoc(SCH(20250114, lib + sym));
  const s = old.items.get("s1").node;
  assert.strictEqual(kids(s, "property")[1][2], "", "the symbol's Datasheet");
  assert.strictEqual(kids(old.lib.get("D:R"), "property")[1][2], "", "the library copy's");
  const pin = kid(kid(old.lib.get("D:R"), "symbol"), "pin"); assert.deepStrictEqual([kid(pin, "name")[1], kid(pin, "number")[1]], ["", ""]);
  const path0 = kid(kid(kid(s, "instances"), "project"), "path"); assert.deepStrictEqual([kid(path0, "value")[1], kid(path0, "footprint")[1]], ["", ""]);
  const now = K.parseDoc(SCH(20250318, lib + sym));
  assert.strictEqual(kids(now.items.get("s1").node, "property")[1][2], "~", "from 20250318 on ~ is the text ~");
});

test("schematic before 20210606: old overbar notation converted (texts, labels, value fields, pins, sheet pins, bus aliases < 20210621)", () => {
  assert.strictEqual(K.parseDoc(SCH(20210406, '(label "~RESET~ x" (at 0 0 0) (effects (font (size 1.27 1.27))) (uuid "l1"))')).items.get("l1").node[1], "~{RESET} x");
  const d = K.parseDoc(SCH(20200827, '(bus_alias "~A~" (members "~B" "C")) (global_label "~CS" (shape input) (at 0 0 0) (effects (font (size 1.27 1.27))) (uuid "g1"))'
    + ' (lib_symbols (symbol "X:U" (property "Value" "~EN~" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "U_1_1" (pin input line (at 0 0 0) (length 2.54) (name "~WR~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))'));
  assert.strictEqual(d.items.get("g1").node[1], "~{CS}");
  assert.deepStrictEqual(d.busAliases["~{A}"], ["~{B}", "C"]);
  const u = d.lib.get("X:U"); assert.strictEqual(kids(u, "property")[0][2], "~{EN}"); assert.strictEqual(kid(kid(kid(u, "symbol"), "pin"), "name")[1], "~{WR}");
  assert.strictEqual(K.parseDoc(SCH(20210606, '(label "~RESET~" (at 0 0 0) (effects (font (size 1.27 1.27))) (uuid "l1"))')).items.get("l1").node[1], "~RESET~", "not from 20210606 on");
});

test("ConvertToNewOverbarNotation: closing tilde, space, brace, paren; doubled tildes; already-new text left alone", () => {
  const T = load("canvas/text.ts").convertToNewOverbarNotation;
  assert.strictEqual(T("~RESET~"), "~{RESET}"); assert.strictEqual(T("~A B"), "~{A} B"); assert.strictEqual(T("x~y)z"), "x~{y})z");
  assert.strictEqual(T("A~~B"), "A~B"); assert.strictEqual(T("~{X}"), "~{X}"); assert.strictEqual(T("~"), "~"); assert.strictEqual(T("~OPEN"), "~{OPEN}");
});

test("KiCad 6 schematic: a graphic polyline with the default style is dashed (<= 20211123)", () => {
  const pl = (u) => `(polyline (pts (xy 0 0) (xy 10 0) (xy 10 10)) (stroke (width 0) (type default) (color 0 0 0 0)) (uuid "${u}"))`;
  const d = K.parseDoc(SCH(20211123, pl("p1") + '(polyline (pts (xy 0 0) (xy 5 0)) (stroke (width 0)) (uuid "p2"))'));
  assert.strictEqual(kid(kid(d.items.get("p1").node, "stroke"), "type")[1], "dash");
  assert.strictEqual(kid(kid(d.items.get("p2").node, "stroke"), "type")[1], "dash", "a two-point one keeps the stroke parseSchPolyLine set");
  assert.ok(d.items.get("p1").geom.some((g) => g.dash), "drawn dashed");
  const d2 = K.parseDoc(SCH(20220104, pl("p1")));
  assert.strictEqual(kid(kid(d2.items.get("p1").node, "stroke"), "type")[1], "default");
});

test("KiCad 5 files: (page A3) is the paper (board <= 20200119, schematic <= 20200506)", () => {
  assert.strictEqual(K.parseDoc("(kicad_pcb (version 20171130) (host pcbnew 5.1) (page A3))").paper, "A3");
  assert.strictEqual(K.parseDoc("(kicad_sch (version 20200310) (host eeschema 5.99) (page A3))").paper, "A3");
});

test("bold stroke text with a thickness in a schematic before 20260826: the drawn pen is the stored width", () => {
  const txt = (v) => K.parseDoc(SCH(v, '(text "B" (at 0 0 0) (effects (font (size 2 2) (thickness 0.2) bold)) (uuid "t1"))')).items.get("t1");
  const pen = (it) => it.geom.find((g) => g.t === "text").w;
  near(pen(txt(20250114)), 0.2, 1e-4, "legacy: stored = drawn");
  near(pen(txt(20260826)), 0.2 * 1.6, 1e-9, "current: × BOLD_STROKE_MULTIPLIER");
});

test("symbol arcs: the (radius (at) (angles)) form becomes start / mid / end; a pre-7.0 arc over 180° becomes its complement", () => {
  const L = load("canvas/legacy.ts");
  // KiCad 6 dev form: centre (0 0), radius 2.54, file start (2.54 0) end (0 2.54): ends swapped, the short way round
  const a = K.parse("(arc (start 2.54 0) (end 0 2.54) (radius (at 0 0) (length 2.54) (angles 0 90)) (stroke (width 0)) (fill (type none)))");
  L.migrateSymbolArc(a, 20211014);
  assert.ok(!kid(a, "radius") && kid(a, "mid"), "(radius) replaced by (mid)");
  assert.deepStrictEqual(kid(a, "start").slice(1), [0, 2.54]); assert.deepStrictEqual(kid(a, "end").slice(1), [2.54, 0]);
  near(Math.hypot(kid(a, "mid")[1], kid(a, "mid")[2]), 2.54, 1e-3); assert.ok(kid(a, "mid")[1] > 0 && kid(a, "mid")[2] > 0, "mid on the quarter between the ends");
  // three points sweeping 270° (start (1 0), mid (-1 0) through the far side, end (0 -1)): its 90° complement
  const b = K.parse("(arc (start 1 0) (mid -0.7071 0.7071) (end 0 -1) (stroke (width 0)) (fill (type none)))");
  const before = JSON.stringify(b); L.migrateSymbolArc(b, 20230121);
  assert.notStrictEqual(JSON.stringify(b), before, "rewritten");
  const m = kid(b, "mid"); assert.ok(m[1] > 0 && m[2] < 0, "the mid point moved to the short side: " + JSON.stringify(m));
  const c = K.parse("(arc (start 1 0) (mid -0.7071 0.7071) (end 0 -1))"); L.migrateSymbolArc(c, 20230220);
  assert.deepStrictEqual(kid(c, "mid").slice(1), [-0.7071, 0.7071], "left alone from 7.0 on");
  // drawn: a schematic's library copy is migrated on load
  const d = K.parseDoc(SCH(20211014, '(lib_symbols (symbol "X:A" (symbol "A_1_1" (arc (start 2.54 0) (end 0 2.54) (radius (at 0 0) (length 2.54) (angles 0 90)) (stroke (width 0)) (fill (type none))))))'));
  assert.ok(kid(kid(d.lib.get("X:A"), "symbol"), "arc").some((x) => Array.isArray(x) && x[0] === "mid"));
});

// ---------------------------------------------------------------- older boards
const PCB = (v, body) => `(kicad_pcb (version ${v}) (generator "pcbnew") (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) ${body})`;

test("board up to 20240201: a local clearance / mask / paste margin of 0 means inherit (dropped on load)", () => {
  const fp = '(footprint "L:F" (layer "F.Cu") (uuid "f1") (at 10 10) (solder_mask_margin 0) (clearance 0.1) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (clearance 0) (solder_paste_margin 0) (solder_paste_margin_ratio 0) (solder_mask_margin 0.05)))';
  const n = K.parseDoc(PCB(20240108, fp)).items.get("f1").node;
  assert.strictEqual(kid(n, "solder_mask_margin"), null); assert.deepStrictEqual(kid(n, "clearance"), ["clearance", 0.1]);
  const pad = kid(n, "pad"); assert.strictEqual(kid(pad, "clearance"), null); assert.strictEqual(kid(pad, "solder_paste_margin"), null); assert.strictEqual(kid(pad, "solder_paste_margin_ratio"), null);
  assert.deepStrictEqual(kid(pad, "solder_mask_margin"), ["solder_mask_margin", 0.05]);
  assert.deepStrictEqual(kid(kid(K.parseDoc(PCB(20240225, fp)).items.get("f1").node, "pad"), "clearance"), ["clearance", 0], "a 9.0 board keeps the 0 override");
});

test("thermal spoke angle default: circle / custom on a circle anchor 45°, else 90°; a 6.0 board's custom-circle pad stays 90°", () => {
  const P = load("canvas/pad-model.ts");
  assert.strictEqual(P.defaultSpokeAngle("circle", ""), 45); assert.strictEqual(P.defaultSpokeAngle("custom", "circle"), 45); assert.strictEqual(P.defaultSpokeAngle("custom", ""), 45);
  assert.strictEqual(P.defaultSpokeAngle("custom", "rect"), 90); assert.strictEqual(P.defaultSpokeAngle("trapezoid", ""), 90); assert.strictEqual(P.defaultSpokeAngle("rect", ""), 90);
  const pad = '(pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu") (options (clearance outline) (anchor circle)) (primitives))';
  const old = kid(K.parseDoc(PCB(20211014, `(footprint "L:F" (layer "F.Cu") (uuid "f1") (at 0 0) ${pad})`)).items.get("f1").node, "pad");
  assert.deepStrictEqual(kid(old, "thermal_bridge_angle"), ["thermal_bridge_angle", 90]);
  const cur = kid(K.parseDoc(PCB(20220131, `(footprint "L:F" (layer "F.Cu") (uuid "f1") (at 0 0) ${pad})`)).items.get("f1").node, "pad");
  assert.strictEqual(kid(cur, "thermal_bridge_angle"), null);
});

test("board before 20210606: net names and texts converted from the old overbar notation", () => {
  const d = K.parseDoc(PCB(20171130, '(net 0 "") (net 1 "~RESET") (gr_text "~CS~" (at 0 0) (layer "F.SilkS") (uuid "t1") (effects (font (size 1 1))))'
    + ' (footprint "L:F" (layer "F.Cu") (uuid "f1") (at 0 0) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "~RESET")))'));
  assert.strictEqual(d.nets.get(1), "~{RESET}"); assert.strictEqual(d.items.get("t1").node[1], "~{CS}");
  assert.deepStrictEqual(kid(kid(d.items.get("f1").node, "pad"), "net"), ["net", 1, "~{RESET}"]);
});

test("a footprint's zone in a board before 20260616 is in the board frame: drawn as stored, carried by a move", () => {
  const fp = (v) => K.parseDoc(PCB(v, '(footprint "L:F" (layer "F.Cu") (uuid "f1") (at 50 50 90) (zone (net 0) (net_name "") (layer "F.Cu") (uuid "z1") (hatch edge 0.5) (keepout (tracks not_allowed)) (polygon (pts (xy 49 49) (xy 51 49) (xy 51 51) (xy 49 51)))))'));
  const doc = fp(20240108), it = doc.items.get("f1");
  const zp = it.geom.find((g) => g.pts && g.pts.length >= 4);
  assert.ok(zp, "zone geometry"); assert.ok(zp.pts.every(([x, y]) => x >= 48.9 && x <= 51.1 && y >= 48.9 && y <= 51.1), "drawn where it is stored: " + JSON.stringify(zp.pts));
  const ch = K.moveItem(doc, it, 60, 50, 1e6);
  assert.ok(ch); const xs = K.ptsOf(kid(kid(it.node, "zone"), "polygon")).map((p) => p[0]); assert.deepStrictEqual(xs, [59, 61, 61, 59], "the outline moved with the footprint");
  const now = fp(20260616).items.get("f1"); const zn = now.geom.find((g) => g.pts && g.pts.length >= 4);
  assert.ok(zn.pts.some(([x]) => x > 90), "from 20260616 on the outline is local: through the footprint transform");
});

test("reference image scale in older files: 300 PPI before 20230121 (schematic), legacy PPI before 20260623", () => {
  const T = load("canvas/tables-images.ts");
  near(T.legacyImageScaleFactor(true, 20230121, { ppi: 96, legacyPpi: 94 }), 96 / 300);
  near(T.legacyImageScaleFactor(true, 20250114, { ppi: 96, legacyPpi: 94 }), 96 / 94);
  near(T.legacyImageScaleFactor(false, 20230121, { ppi: 96, legacyPpi: 94 }), 96 / 94, 1e-12, "a board has no 300 PPI era");
  assert.strictEqual(T.legacyImageScaleFactor(false, 20260623, { ppi: 96, legacyPpi: 94 }), 1);
  assert.strictEqual(T.legacyImageScaleFactor(true, 20250114, { ppi: 300, legacyPpi: 300 }), 1);
});

test("via protection in a board before 20250228 reads as off, and an all-off preset writes nothing there", () => {
  const M = load("editor/pcbdialogs/track-via-model.ts");
  const via = K.parse('(via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0) (uuid "v1"))');
  const none = M.IPC4761.findIndex(([, p]) => p.tent === "none" && p.cover === "none" && p.plug === "none" && p.fill === "no" && p.cap === "no");
  assert.ok(none >= 0);
  assert.notStrictEqual(M.protectionPreset(via), none, "a current board: from the board setup");
  assert.strictEqual(M.protectionPreset(K.parse('(via (at 0 0) (tenting (front no) (back no)) (uuid "v"))'), 20240108), none, "a 9.0 board: off");
  const v2 = K.parse('(via (at 0 0) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0) (uuid "v1"))');
  M.setProtectionPreset(v2, none, K.parse, 20240108);
  for (const key of ["covering", "plugging", "capping", "filling"]) assert.strictEqual(kid(v2, key), null, key + " left out");
});

test("the fold accepts a KiCad 5 (page …) as the paper slot and writes the edit as (paper …)", () => {
  const C = load("mcp/compact.ts");
  const file = "(kicad_pcb (version 20171130) (host pcbnew 5.1)\n\t(page A4)\n\t(gr_line (start 0 0) (end 1 1) (layer Edge.Cuts) (width 0.1) (tstamp 5E000001))\n)\n";
  const r = C.foldOps(K, "kicad_pcb", file, [{ changes: [{ docProps: { paper: '(paper "A3")' } }] }]);
  assert.ok(r.ok, r.reason); assert.ok(/\(paper "A3"\)/.test(r.text) && !/\(page /.test(r.text), r.text);
  const c = C.foldOps(K, "kicad_pcb", "# a comment\n" + file, [{ changes: [{ docProps: { paper: '(paper "A3")' } }] }]);
  assert.ok(c.ok, c.reason);
});

// ---------------------------------------------------------------- writing: versions, legacy forms, header
const FV = load("canvas/format-version.ts");
const GV = FV.GENERATOR_VERSION;
test("format versions: this tree's constants, GetMajorMinorVersion, and MinimumFileFormatVersion's scan", () => {
  assert.strictEqual(FV.SEXPR_SCHEMATIC_FILE_VERSION, 20261106); assert.strictEqual(FV.SEXPR_BOARD_FILE_VERSION, 20261031);
  assert.strictEqual(FV.SEXPR_FOOTPRINT_LIB_FILE_VERSION, 20261031); assert.strictEqual(FV.SEXPR_FOOTPRINT_LIB_HEADER_VERSION, 20261028);
  const base = /KICAD_BASE_VERSION = "(\d+)\.(\d+)/.exec(require("fs").readFileSync(webPath("canvas/version.ts"), "utf8"));
  assert.strictEqual(GV, base[1] + "." + base[2]);
  assert.strictEqual(FV.minimumFileFormatVersion('(barcode (at 0 0) (text "(barcode)"))', "pcb").version, 20250914);
  assert.strictEqual(FV.minimumFileFormatVersion('(gr_text "barcode (barcode)" (at 0 0))', "pcb").version < 20250914, true, "quoted text is skipped");
  const r = FV.minimumFileFormatVersion("(symbol (body_style 1))", "sch"); assert.strictEqual(r.version, 20250827);
  assert.ok(FV.writingOlderThan(20250114, 20250827) && !FV.writingOlderThan(0, 20250827) && !FV.writingOlderThan(20250827, 20250827));
  assert.ok(FV.usesEscapedStackedPinNotation("[1\\,2]") && !FV.usesEscapedStackedPinNotation("[1,2]"));
});

test("a symbol written into an older schematic takes that version's form (WritingOlderThan branches)", () => {
  const inst = K.parse('(symbol (lib_id "D:R") (at 0 0 0) (unit 1) (body_style 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (dnp no) (uuid "u"))');
  const old = K.downgradeSchNode(inst, 20250114);
  assert.ok(old !== inst && !kid(old, "body_style") && !kid(old, "convert") && !kid(old, "in_pos_files"), K.serialize(old));
  assert.ok(kid(inst, "body_style"), "the document's node is not changed");
  const de = K.downgradeSchNode(K.parse('(symbol (lib_id "D:R") (unit 1) (body_style 2) (in_pos_files no) (uuid "u"))'), 20250114);
  assert.deepStrictEqual(kid(de, "convert"), ["convert", 2]); assert.deepStrictEqual(kid(de, "in_pos_files"), ["in_pos_files", "no"], "an excluded symbol keeps it");
  const lib = K.parse('(symbol "D:G" (power global) (body_styles demorgan) (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (duplicate_pin_numbers_are_jumpers no) (property "Reference" "#PWR" (at 0 0 0)))');
  const l9 = K.downgradeSchNode(lib, 20250114);
  assert.deepStrictEqual(kid(l9, "power"), ["power"]); assert.ok(!kid(l9, "body_styles") && !kid(l9, "in_pos_files") && !kid(l9, "duplicate_pin_numbers_are_jumpers"), K.serialize(l9));
  assert.ok(/\(symbol "D:G"/.test(K.serialize(l9)), "the name stays quoted");
  const l95 = K.downgradeSchNode(lib, 20250300);
  assert.deepStrictEqual(kid(l95, "power"), ["power", "global"]); assert.ok(kid(l95, "duplicate_pin_numbers_are_jumpers") && !kid(l95, "body_styles"));
  assert.strictEqual(K.downgradeSchNode(lib, 20251028), lib); assert.strictEqual(K.downgradeSchNode(lib, 0), lib, "a new file is written current");
});

const C = load("mcp/compact.ts");
const SCH9 = '(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(generator_version "9.0")\n\t(uuid "root")\n\t(paper "A4")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n)\n';
const LIBR = '(symbol "D:R" (power global) (body_styles demorgan) (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (duplicate_pin_numbers_are_jumpers no) (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27)))) (symbol "R_1_1" (rectangle (start -1 -1) (end 1 1) (stroke (width 0) (type default)) (fill (type none)))))';
const INSTR = '(symbol (lib_id "D:R") (at 25.4 25.4 0) (unit 1) (body_style 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (in_pos_files yes) (dnp no) (uuid "11111111-1111-4111-8111-000000000001") (property "Reference" "R1" (at 25.4 25.4 0) (effects (font (size 1.27 1.27)))))';
test("the fold writes new items into an older schematic in its form, keeps the version and restamps the generator", () => {
  const r = C.foldOps(K, "kicad_sch", SCH9, [{ changes: [{ id: "11111111-1111-4111-8111-000000000001", kind: "ADDED", sexpr: "(lib_symbols " + LIBR + ") " + INSTR }] }]);
  assert.ok(r.ok, r.reason); const t = r.text;
  assert.ok(/\(version 20250114\)/.test(t) && r.version === undefined && !r.notice, "nothing needed a newer version");
  assert.ok(t.includes(`(generator "eeschema")\n\t(generator_version "${GV}")`), t.slice(0, 120));
  assert.ok(!/body_style|in_pos_files|demorgan|duplicate_pin_numbers_are_jumpers|power global/.test(t) && /\(power\)/.test(t), t);
  const again = C.foldOps(K, "kicad_sch", t, []); assert.ok(again.ok && again.text === t);
});

const LAYERS = '(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))';
const board = (v, extra) => `(kicad_pcb\n\t(version ${v})\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n\t${LAYERS}\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n\t(net 0 "")\n\t(net 1 "GND")\n${extra || ""}\t(gr_line\n\t\t(start 0 0)\n\t\t(end 10 0)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "e1e1e1e1-0000-4000-8000-000000000001")\n\t)\n)\n`;
const FP = (net) => `(footprint "X:Y" (layer "F.Cu") (uuid "f0f0f0f0-0000-4000-8000-000000000001") (at 5 5) (height 4) (property "Reference" "U1" (at 0 0 0) (layer "F.SilkS") (uuid "f0f0f0f0-0000-4000-8000-000000000002") (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")${net ? " " + net : ""} (uuid "f0f0f0f0-0000-4000-8000-000000000003")))`;
const addFp = (net) => [{ changes: [{ id: "f0f0f0f0-0000-4000-8000-000000000001", kind: "ADDED", sexpr: `(kicad_pcb (version 20250302) (generator "pcbnew") ${FP(net)})` }] }];
test("the fold raises the stamp when what it writes needs it (chooseFileFormatVersion), with KiCad's message", () => {
  const r = C.foldOps(K, "kicad_pcb", board(20250302), addFp('(net 1 "GND")'));
  assert.ok(r.ok, r.reason);
  assert.strictEqual(r.version, 20261017); assert.ok(/\(version 20261017\)/.test(r.text));
  assert.ok(/uses a footprint with an overall height, which file format version 20250302 cannot store\.  Saved using file format version 20261017 instead/.test(r.notice), r.notice);
  assert.ok(r.text.includes(`(generator_version "${GV}")`));
});
test("…but not past a version below which the stored items read differently (here: via protection)", () => {
  const via = '\t(via\n\t\t(at 1 1)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers "F.Cu" "B.Cu")\n\t\t(net 1)\n\t\t(uuid "a1a1a1a1-0000-4000-8000-000000000001")\n\t)\n';
  const r = C.foldOps(K, "kicad_pcb", board(20241229, via), addFp());
  assert.ok(!r.ok && /via protection/.test(r.reason), JSON.stringify(r));
});
test("a board kept before 20251028: new items use net codes, and a new code is declared in the (net N \"name\") list", () => {
  const r = C.foldOps(K, "kicad_pcb", board(20250302).replace("(height 4)", ""), [{ changes: [{ id: "f0f0f0f0-0000-4000-8000-000000000001", kind: "ADDED", sexpr: `(kicad_pcb (version 20250302) (generator "pcbnew") ${FP('(net 2 "VCC")').replace(" (height 4)", "")})` }] }]);
  assert.ok(r.ok, r.reason);
  assert.ok(r.text.includes('\t(net 1 "GND")\n\t(net 2 "VCC")\n'), r.text);
  assert.ok(/\(version 20250302\)/.test(r.text) && !r.notice);
  require(path.join(__dirname, "..", "pcb-tools.js"));
  const P = globalThis.PcbTools;
  const d9 = K.parseDoc(board(20250302), "kicad_pcb"), d10 = K.parseDoc(board(20251028), "kicad_pcb");
  assert.strictEqual(P.netStyle(d9), "code"); assert.strictEqual(P.netStyle(d10), "name");
  assert.deepStrictEqual(P.netNode(d9, { code: 1, name: "GND" }), ["net", 1]); assert.deepStrictEqual(P.netNode(d10, { code: 1, name: "GND" }), ["net", "GND"]);
  const z = P.zoneNode(d9, [[0, 0], [1, 0], [1, 1]], "F.Cu", { code: 1, name: "GND" });
  assert.deepStrictEqual(kid(z, "net"), ["net", 1]); assert.deepStrictEqual(kid(z, "net_name"), ["net_name", "GND"], "formatNetRef CODE_THEN_NET_NAME");
});

test("(kicad_footprint_lib …) footprint files open, and are written with the header (FormatFootprintLibFile)", () => {
  const F = K.footprintDoc;
  const lib = '(kicad_footprint_lib (version 20261031) (generator "kicad_footprint_editor") (generator_version "10.99")\n\t(footprint "R" (layer "F.Cu") (property "Reference" "REF**" (at 0 0 0) (layer "F.SilkS") (uuid "c1c1c1c1-0000-4000-8000-000000000001") (effects (font (size 1 1) (thickness 0.15)))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "c1c1c1c1-0000-4000-8000-000000000002"))))\n';
  const d = K.parseDoc(lib, "footprint");
  assert.strictEqual(d.version, 20261031); assert.strictEqual(F.footprintName(d), "R"); assert.ok([...d.items.values()].some((i) => i.kind === "pad"));
  assert.strictEqual(F.serializeFootprintDoc(d), lib, "unchanged: the stored bytes");
  const pad = [...d.items.values()].find((i) => i.kind === "pad"); const s = K.serializeItem(d, pad);
  K.applyChange(d, { id: pad.id, kind: "MODIFIED", typeName: "PAD", sexpr: s.replace("(at 0 0)", "(at 1 0)") }, 1e6);
  const out = F.serializeFootprintDoc(d);
  assert.ok(/^\(kicad_footprint_lib\s+\(version 20261031\)\s+\(generator "kicad_footprint_editor"\)\s+\(generator_version "[\d.]+"\)\s+\(footprint "R"/.test(out), out.slice(0, 200));
  assert.ok(!/\(footprint "R"[\s\S]*\(version /.test(out), "no stamp inside the footprint");
  F.markFootprintSaved(d, out); assert.ok(!F.footprintModified(d));
  const bare = F.unwrapFootprintLib(K.parse(lib)); assert.strictEqual(bare[0], "footprint"); assert.deepStrictEqual(kid(bare, "version"), ["version", 20261031]);
  // a bare file read at an older version stays bare at that version, with the stamp written afresh
  const old = '(footprint "R" (version 20241229) (generator "kicad-footprint-generator") (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "c1c1c1c1-0000-4000-8000-000000000002")))';
  const d2 = K.parseDoc(old, "footprint"); const p2 = [...d2.items.values()].find((i) => i.kind === "pad");
  K.applyChange(d2, { id: p2.id, kind: "MODIFIED", typeName: "PAD", sexpr: K.serializeItem(d2, p2).replace("(at 0 0)", "(at 1 0)") }, 1e6);
  const o2 = F.serializeFootprintDoc(d2);
  assert.ok(/^\(footprint "R"\s+\(version 20241229\)\s+\(generator "pcbnew"\)\s+\(generator_version "[\d.]+"\)/.test(o2), o2.slice(0, 160));
});

test("a symbol library is written at its version in its legacy forms, raised only when the body needs it", () => {
  const M = load("symedit/model.ts");
  const src = '(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor") (generator_version "9.0") (symbol "P" (power) (exclude_from_sim no) (in_bom yes) (on_board yes) (property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27))))))';
  const lib = M.parseLibrary(src); const out = M.serializeLibrary(lib);
  assert.ok(/\(version 20241209\)/.test(out) && out.includes(`(generator_version "${GV}")`) && /\(power\)/.test(out) && !/in_pos_files/.test(out), out);
  const sym = lib.symbols.get("P"); sym.push(["body_styles", "A", "B"]);
  assert.ok(/\(version 20250324\)/.test(M.serializeLibrary(lib)), "named body styles have no older form: raised to SYMBOL_LIB_TOKEN_VERSIONS body_styles");
});

test("bold stroke text in a board before 20260826: the dialog shows the width attribute and writes it × 1.6", () => {
  // EDA_TEXT::MigrateLegacyBoldStrokeWidth / legacyBoldStrokeWidth: max(2, round(stored / 1.6)) and back
  const IP = require("fs").readFileSync(webPath("editor/pcbdialogs/item-props.ts"), "utf8");
  assert.ok(/const boldAttr = \(stored: number\): number => Math\.max\(2, Math\.round\(stored \* 1e6 \/ 1\.6\)\) \/ 1e6;/.test(IP));
  assert.ok(/legacyBoldStrokeWidth\(\)[\s\S]*boldStored\(tv, legacy0 \? fx\.thick : 0\)/.test(IP));
});

test("new schematic fields carry (show_name) and (do_not_autoplace) before the effects (saveField)", () => {
  require(path.join(__dirname, "..", "sch-tools.js"));
  const sch = globalThis.CollabTools.sch._;
  const g = sch.labelNode("global_label", "A", [0, 0], 0); const f = kids(g, "property")[0];
  assert.deepStrictEqual(f.slice(0, 7).map((c) => Array.isArray(c) ? c[0] : c), ["property", "Intersheetrefs", "${INTERSHEET_REFS}", "at", "hide", "show_name", "do_not_autoplace"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
