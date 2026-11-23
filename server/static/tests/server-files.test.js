// server-files.test.js — round 3 "server-files": what the web writes into a project's files beyond the open sheet.
//  - one commit over several documents (the server's op_multi): a move that drops items into a sub-sheet, and a paste
//    of sheets, write the other files' symbol instance data in the same commit (SCH_EDITOR_CONTROL::updatePastedSheet,
//    SCH_MOVE_TOOL::moveSelectionToSheet + the writer's orphan pruning + CheckForMissingSymbolInstances).
// Run: node server/static/tests/server-files.test.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, _ = sch._;
const IU = 1e4;
const WEB = path.join(__dirname, "..", "..", "web", "domains", "pcb");
const src = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

const LIB = `(lib_symbols (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27)))) (property "Value" "R" (at 0 0 90) (effects (font (size 1.27 1.27))))
  (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
  (symbol "R_1_1" (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
    (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))))`;
const HEAD = (uuid) => `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "${uuid}") (paper "A4") ${LIB} `;
const R = (id, ref, x, y, paths) => `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${id}")
  (property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1.27 1.27)))) (property "Value" "10k" (at ${x + 2} ${y + 2} 0) (effects (font (size 1.27 1.27))))
  (pin "1" (uuid "${id}p1")) (pin "2" (uuid "${id}p2"))
  (instances (project "t" ${(paths || [["/root", ref]]).map(([p, r]) => `(path "${p}" (reference "${r}") (unit 1))`).join(" ")})))`;
const SHEET = (id, name, file, x, y, parent) => `(sheet (at ${x} ${y}) (size 20.32 10.16) (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0)) (uuid "${id}")
  (property "Sheetname" "${name}" (at ${x} ${y - 0.7} 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
  (property "Sheetfile" "${file}" (at ${x} ${y + 10.8} 0) (effects (font (size 1.27 1.27)) (justify left top)))
  (instances (project "t" (path "${parent || "/root"}" (page "2")))))`;
const doc = (uuid, body) => K.parseDoc(HEAD(uuid) + body + ")", "kicad_sch");
const paths = (node) => _.instanceEntries(node).map((e) => [e.pa[1], K.kid(e.pa, "reference") ? K.kid(e.pa, "reference")[1] : (K.kid(e.pa, "page") || [])[1]]);
const nodeOf = (change) => K.parseAll(change.sexpr).filter((t) => t[0] !== "lib_symbols")[0];

/** A project: files by path, read fresh each time as the editor's readSheetFile does. */
function project(files) {
  const docIds = new Map(Object.keys(files).map((p, i) => [p, "doc-" + i]));
  const read = async (file, from) => {
    const dir = from.split("/").slice(0, -1).join("/"), p = dir ? dir + "/" + file : file;
    if (!files[p]) return null;
    return { docId: docIds.get(p), path: p, doc: doc("u-" + p, files[p]) };
  };
  return { read, docIds };
}
function makeCtx(d, more) {
  const ctx = Object.assign({
    K, doc: d, IU, isSch: true, zoom: 1, pxPerMm: 4, gridPitch: 1.27, snapOn: true, selected: null, items: [], viewOnly: false, live: true, stage: null,
    snap: (mm) => [K.snap(mm[0], 1.27), K.snap(mm[1], 1.27)], log: [], toasts: [], selection: new Set(), cursor: null,
    clip: "", clipboard: { get: () => ctx.clip, set: (t) => { ctx.clip = t; } },
    setSelected(s) { ctx.selected = s ? { id: s.id } : null; },
    setSelection(ids) { ctx.selection.clear(); for (const id of ids) ctx.selection.add(id); },
    commit(changes, label, opts) { ctx.log.push({ changes, label, others: opts && opts.others }); for (const c of changes) assert.ok(K.applyChange(d, c, IU), "applies: " + c.kind + " " + c.id); sch.onDocChanged(ctx); },
    requestRender() {}, toast(m) { ctx.toasts.push(m); }, setTool(t) { sch.onActivate(t, ctx); },
  }, more || {});
  return ctx;
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const last = (c) => c.log[c.log.length - 1];

// ---------------------------------------------------------------- instance entries
test("instance helpers: AddHierarchicalReference replaces the entry of its path and keeps the paths in order; CheckForMissingSymbolInstances copies the project's first entry", async () => {
  const n = K.parse(R("a", "R1", 0, 0, [["/root/z", "R9"], ["/root", "R1"]]));
  _.putInstance(n, "t", ["path", "/root/b", ["reference", "R2"], ["unit", 1]]);
  _.putInstance(n, "t", ["path", "/root", ["reference", "R3"], ["unit", 1]]);
  assert.deepStrictEqual(paths(n), [["/root", "R3"], ["/root/b", "R2"], ["/root/z", "R9"]]);
  assert.strictEqual(_.addMissingInstance(n, "/root/b", "t"), false, "a path that has one keeps it");
  assert.strictEqual(_.addMissingInstance(n, "/root/q", "t"), true);
  assert.strictEqual(paths(n).find((p) => p[0] === "/root/q")[1], "R3", "the project's first entry is the copy");
  assert.ok(_.dropInstances(n, (p) => p.startsWith("/root/")));
  assert.deepStrictEqual(paths(n), [["/root", "R3"]]);
  const bare = K.parse(`(symbol (lib_id "Device:R") (at 0 0 0) (unit 2) (uuid "b") (property "Reference" "U4" (at 0 0 0)))`);
  assert.ok(_.addMissingInstance(bare, "/root/s", "t"));
  assert.deepStrictEqual(paths(bare), [["/root/s", "U4"]], "no entries at all: the Reference field and unit");
  assert.strictEqual(K.kid(_.instanceEntries(bare)[0].pa, "unit")[1], 2);
});

// ---------------------------------------------------------------- move into a sheet
test("a move dropped into a sub-sheet is one commit over both files; the moved symbol gets the sub-sheet's paths; Undo data covers both", async () => {
  const p = project({ "root.kicad_sch": "", "s.kicad_sch": `(wire (pts (xy 0 0) (xy 2.54 0)) (stroke (width 0) (type default)) (uuid "sw"))` });
  const d = doc("root", R("R1", "R1", 25.4, 100.33) + SHEET("sh", "S", "s.kicad_sch", 50.8, 50.8));
  let built = null;
  const c = makeCtx(d, {
    docs: [{ docId: "doc-0", path: "root.kicad_sch", docType: "kicad_sch" }, { docId: "doc-1", path: "s.kicad_sch", docType: "kicad_sch" }], docId: "doc-0",
    readSheetFile: p.read,
    sheetHierarchy: () => ({ paths: [], docs: new Map(), instances: [{ file: "root.kicad_sch", path: "/root" }, { file: "s.kicad_sch", path: "/root/sh" }, { file: "s.kicad_sch", path: "/root/other" }] }),
    commitWithSheets(label, build) { built = build(p.read).then((r) => { if (r) c.commit(r.here, label, { others: r.others }); return r; }); },
    dropIntoSheet() { throw new Error("the one-commit path is taken"); },
  });
  sch.onActivate("select", c); sch.onDocChanged(c); sch.setDragMode(c, "move");
  assert.ok(_.beginDrag(c, d.items.get("R1"), [25.4, 100.33], true)); _.moveDrag(c, [58.42, 55.88], {});
  assert.strictEqual(sch.state.drag.hoverSheet && sch.state.drag.hoverSheet.id, "sh");
  _.endDrag(c, true); const r = await built;
  assert.ok(r, "built"); const cm = last(c);
  assert.strictEqual(cm.label, "Move"); assert.deepStrictEqual(cm.changes.map((x) => [x.id, x.kind]), [["R1", "REMOVED"]]);
  assert.ok(!d.items.get("R1"), "gone from this sheet");
  assert.strictEqual(cm.others.length, 1); const o = cm.others[0];
  assert.strictEqual(o.docId, "doc-1"); assert.deepStrictEqual(o.changes.map((x) => [x.id, x.kind]), [["R1", "ADDED"]]);
  assert.deepStrictEqual(o.inverse.map((x) => [x.id, x.kind]), [["R1", "REMOVED"]], "its undo takes it out of the sub-sheet again");
  assert.deepStrictEqual(paths(nodeOf(o.changes[0])), [["/root", "R1"], ["/root/other", "R1"], ["/root/sh", "R1"]], "every path the sub-sheet is shown on, the old entry kept as KiCad keeps it");
});

test("a sheet moved into another sheet takes its file's instance data along: the old paths go, the new ones come", async () => {
  const p = project({
    "root.kicad_sch": "",
    "t.kicad_sch": "",
    "m.kicad_sch": R("in", "R7", 10, 10, [["/root/ms", "R7"], ["/root/x/ms", "R70"]]) + SHEET("deep", "D", "d.kicad_sch", 40, 40, "/root/ms"),
    "d.kicad_sch": R("dd", "R8", 10, 10, [["/root/ms/deep", "R8"]]),
  });
  const res = await _.moveInstanceChanges(p.read, { hereFile: "root.kicad_sch", herePaths: ["/root"], targetPaths: ["/root/tt"], project: "t", nodes: [K.parse(SHEET("ms", "M", "m.kicad_sch", 0, 0))] });
  const byPath = new Map(res.map((o) => [o.path, o]));
  const m = byPath.get("m.kicad_sch"), dd = byPath.get("d.kicad_sch");
  assert.ok(m && dd, "both files below the moved sheet are written");
  const inNode = nodeOf(m.changes.find((x) => x.id === "in"));
  assert.deepStrictEqual(paths(inNode), [["/root/tt/ms", "R70"], ["/root/x/ms", "R70"]], "the orphaned path goes; the new one copies the project's first remaining entry");
  assert.deepStrictEqual(paths(nodeOf(m.changes.find((x) => x.id === "deep"))), [["/root/tt/ms", "2"]], "the sub-sheet's own sheet instance follows");
  assert.deepStrictEqual(paths(nodeOf(dd.changes[0])), [["/root/tt/ms/deep", "R8"]], "two levels down: no entry left, so the Reference field");
  assert.ok(/\(path "\/root\/ms"/.test(m.inverse.find((x) => x.id === "in").sexpr), "the inverse is the file as it was");
});

// ---------------------------------------------------------------- paste of sheets
test("pasted sheet: its file's symbols get the new sheet path, copied from the path they were copied from and annotated uniquely, in the paste's commit", async () => {
  const p = project({ "root.kicad_sch": "", "power.kicad_sch": R("pr", "R5", 10, 10, [["/root/x1", "R5"]]) + R("pn", "R?", 20, 10, [["/root/x1", "R?"]]) });
  const d = doc("root", R("R1", "R1", 25.4, 25.4));
  const c = makeCtx(d, {
    docs: [{ docId: "doc-0", path: "root.kicad_sch", docType: "kicad_sch" }, { docId: "doc-1", path: "power.kicad_sch", docType: "kicad_sch" }], docId: "doc-0",
    readSheetFile: p.read,
    sheetHierarchy: () => ({ paths: [["root.kicad_sch"]], docs: new Map(), instances: [{ file: "root.kicad_sch", path: "/root" }, { file: "power.kicad_sch", path: "/root/x1" }] }),
  });
  sch.onActivate("select", c); sch.onDocChanged(c); sch.select(null); sch.state.annotateAuto = true; _.setFollow(false);
  sch.state.otherRefs = ["R5"];   // the project's other sheets: R5 on /root/x1
  try {
    c.clip = SHEET("x1", "Power", "power.kicad_sch", 10.16, 10.16); c.cursor = [101.6, 101.6];
    assert.ok(sch.runAction("paste", c));
    assert.strictEqual(c.log.length, 0, "the commit waits for the sheet's file");
    for (let i = 0; i < 5 && !c.log.length; i++) await settle();
    const cm = last(c); assert.ok(cm, "committed");
    const sheetCh = cm.changes.find((x) => x.kind === "ADDED" && x.typeName === "SCH_SHEET"), newId = sheetCh.id;
    assert.notStrictEqual(newId, "x1");
    assert.strictEqual(cm.others.length, 1); const o = cm.others[0]; assert.strictEqual(o.docId, "doc-1");
    const pr = nodeOf(o.changes.find((x) => x.id === "pr")), pn = nodeOf(o.changes.find((x) => x.id === "pn"));
    assert.deepStrictEqual(paths(pr), [["/root/" + newId, "R6"], ["/root/x1", "R5"]].sort((a, b) => (a[0] < b[0] ? -1 : 1)), "kept from /root/x1, then made unique (R5 is in use)");
    assert.strictEqual(paths(pn).find((x) => x[0] === "/root/" + newId)[1], "R7", "an unannotated one takes the next free number");
    assert.strictEqual(K.kid(pr, "property")[2], "R5", "the Reference field of a symbol off the sheet on screen stays (SetRef only sets the current sheet's)");
    assert.ok(o.inverse.every((x) => x.kind === "MODIFIED"));
  } finally { sch.state.otherRefs = []; }
});

test("pasted sheet with annotations removed: the new path's references are cleared to R? (ClearAnnotation), power symbols excepted", async () => {
  const p = project({ "root.kicad_sch": "", "power.kicad_sch": R("pr", "R5", 10, 10, [["/root/x1", "R5"]]) });
  const r = await _.pastedSheetInstanceChanges(p.read, { hereFile: "root.kicad_sch", herePaths: ["/root", "/top2"], project: "t", sheets: [{ id: "nw", clipId: "x1", file: "power.kicad_sch" }], keep: false, annotate() {} });
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual(paths(nodeOf(r[0].changes[0])), [["/root/nw", "R?"], ["/root/x1", "R5"], ["/top2/nw", "R?"]], "every path of the sheet pasted into");
});

// ---------------------------------------------------------------- the editor's side of op_multi
test("the editor sends a commit over several documents as one op_multi, replays it whole, and undoes / redoes it the same way", async () => {
  const net = src("editor/net.ts"), tools = src("editor/tools.ts"), subs = src("dialogs/subsheets.ts");
  assert.ok(/type: "op_multi", docId: state\.docId, clientOpId, changes, also: parts/.test(net), "sendOp: one op_multi");
  assert.ok(/`multi:web:\$\{\+\+E\.opN\}`/.test(net), "its id is marked as a multi-document one (the server acks those from the table)");
  assert.ok(/op\.also && op\.also\.length\) ws\.send\(JSON\.stringify\(\{ type: "op_multi"/.test(net), "a replay sends all of it again");
  assert.ok(/sendOp\(e\.inverse, false, otherInv\)/.test(tools) && /sendOp\(e\.changes, false, e\.others/.test(tools), "undo / redo");
  assert.ok(/h\.commitWithSheets = commitWithSheets/.test(subs) && /h\.readSheetFile = readSheetFile/.test(subs));
  const rs = fs.readFileSync(path.join(__dirname, "..", "..", "src", "ws.rs"), "utf8");
  assert.ok(/ClientMsg::op_multi/.test(rs) && /insert_ops_atomic/.test(rs), "the server journals it in one transaction");
});

// ---------------------------------------------------------------- embedded files (PANEL_EMBEDDED_FILES, CollectAndEmbed3DModels)
const esbuild = require("esbuild");
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [path.join(WEB, file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const EF = load("library/embedded-file.ts"), EM = load("editor/pcbdialogs/embed-models.ts"), C = load("mcp/compact.ts");
/** a font file with only an OS/2 table whose fsType is `fs` */
function fontWithFsType(fs) {
  const b = new Uint8Array(12 + 16 + 10), dv = new DataView(b.buffer);
  dv.setUint32(0, 0x00010000); dv.setUint16(4, 1);
  dv.setUint32(12, 0x4f532f32); dv.setUint32(12 + 8, 28); dv.setUint32(12 + 12, 10);
  dv.setUint16(28 + 8, fs); return b;
}

test("OUTLINE_FONT::GetEmbeddingPermission reads the OS/2 fsType: installable, editable, preview only, restricted", () => {
  assert.strictEqual(EF.fontEmbeddingPermission(fontWithFsType(0)), "installable");
  assert.strictEqual(EF.fontEmbeddingPermission(fontWithFsType(0x0008)), "editable");
  assert.strictEqual(EF.fontEmbeddingPermission(fontWithFsType(0x0108)), "editable", "bits 8-9 are modifiers, masked off");
  assert.strictEqual(EF.fontEmbeddingPermission(fontWithFsType(0x0004)), "printPreviewOnly");
  assert.strictEqual(EF.fontEmbeddingPermission(fontWithFsType(0x0002)), "restricted");
  assert.strictEqual(EF.fontEmbeddingPermission(fontWithFsType(0x0200)), "restricted", "bitmap embedding only");
  assert.strictEqual(EF.fontEmbeddingPermission(new Uint8Array(12)), "restricted", "no OS/2 table");
  assert.ok(EF.embeddableFont(fontWithFsType(0)) && EF.embeddableFont(fontWithFsType(8)) && !EF.embeddableFont(fontWithFsType(4)));
});

test("Collect And Embed 3D Models: resolved models go to the board's files and name their kicad-embed:// link; one count per model", async () => {
  const fp = (id, models, extra = "") => K.parse(`(footprint "Resistor_SMD:R_0603" (layer "F.Cu") (uuid "${id}") ${extra} ${models.map((m) => `(model "${m}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`).join(" ")})`);
  const items = [
    { id: "a", kind: "footprint", node: fp("a", ["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.step", "kicad-embed://old.step"]) },
    { id: "b", kind: "footprint", node: fp("b", ["${KICAD9_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603_1608Metric.wrl"]) },
    { id: "v", kind: "footprint", node: fp("v", ["${KICAD_COLLAB_3DMODELS}/LCSC.3dshapes/Q1.wrl"], '(property "LCSC" "C1")') },
    { id: "c", kind: "footprint", node: fp("c", ["${KIPRJMOD}/models/part.step", "${KIPRJMOD}/models/missing.step"]) },
    { id: "d", kind: "footprint", node: fp("d", ["${KICAD9_3DMODEL_DIR}/Capacitor_SMD.3dshapes/C_0402.step"]) },
    { id: "t", kind: "gr_text", node: K.parse(`(gr_text "x" (at 0 0) (layer "F.SilkS") (uuid "t"))`) },
  ];
  const board = K.parse(`(embedded_files (file (name "C_0402.step") (type model) (data |x|) (checksum "0")))`);
  const fetched = [];
  const bytes = new TextEncoder().encode("ISO-10303-21;");
  const r = await EM.collectAndEmbed3DModels(items, board, async (url) => { fetched.push(url); return /p2|ext=stp(&|$)/.test(url) ? null : bytes; },
    (stem, ext) => (ext !== "step" ? null : stem === "models/part" ? "/api/docs/p1/content" : stem === "models/missing" ? "/api/docs/p2/content" : null));
  assert.strictEqual(r.count, 4, "a, b (the VRML file), c's part, d (already on the board)");
  const link = (id, i) => String(K.kids(r.footprints.find((f) => f.id === id).node, "model")[i][1]);
  assert.strictEqual(link("a", 0), "kicad-embed://R_0603_1608Metric.step");
  assert.strictEqual(link("a", 1), "kicad-embed://old.step", "an embedded model stays");
  assert.strictEqual(link("b", 0), "kicad-embed://R_0603_1608Metric.wrl", "a VRML model is embedded itself");
  assert.ok(fetched.includes("/api/kicad-lib/model?lib=Resistor_SMD&name=R_0603_1608Metric&ext=wrl"), fetched.join(" "));
  const alts = fetched.filter((u) => /R_0603_1608Metric(&ext=(stp|STP))?$/.test(u));
  assert.deepStrictEqual(alts, ["/api/kicad-lib/model?lib=Resistor_SMD&name=R_0603_1608Metric", "/api/kicad-lib/model?lib=Resistor_SMD&name=R_0603_1608Metric&ext=stp"].sort((x, y) => fetched.indexOf(x) - fetched.indexOf(y)), "the STEP siblings in KiCad's order: stp, then step");
  assert.ok(!r.footprints.some((f) => f.id === "v"), "a vendor folder holds no VRML file: left as it is");
  assert.strictEqual(link("c", 0), "kicad-embed://part.step");
  assert.strictEqual(link("c", 1), "${KIPRJMOD}/models/missing.step", "a file that does not exist is left alone");
  assert.strictEqual(link("d", 0), "kicad-embed://C_0402.step", "AddFile( …, false ) takes the board's file of that name");
  const names = r.files.map((t) => String(K.kid(K.parse(t), "name")[1]));
  assert.deepStrictEqual(names, ["R_0603_1608Metric.step", "R_0603_1608Metric.wrl", "part.step"], "each new file once (the STEP beside the VRML file already is); the board's own is not added again");
  const r2 = await EM.collectAndEmbed3DModels([items[1]], null, async (url) => (/ext=stp(&|$)/.test(url) ? null : bytes), null);
  assert.deepStrictEqual(r2.files.map((t) => String(K.kid(K.parse(t), "name")[1])), ["R_0603_1608Metric.wrl", "R_0603_1608Metric.step"], "the VRML file, then its STEP for the STEP exporter");
  assert.strictEqual(r2.count, 1, "the STEP sibling is not counted");
  assert.strictEqual(EM.resolveModel("${KIPRJMOD}/m/a.wrl", items[1].node, (stem, ext) => (stem === "m/a" && ext === "wrl" ? "/api/docs/w/content" : null)).url, "/api/docs/w/content", "a project keeps its VRML file too");
  assert.ok(!fetched.some((u) => /fallback/.test(u)), "the library file itself, never a replacement");
  assert.ok(String(K.kids(items[0].node, "model")[0][1]).startsWith("${KICAD9"), "the board's own nodes are not touched");
  assert.strictEqual(EM.embeddedCountMessage(4), "4 3D model(s) successfully embedded.");
  const menu = src("editor/pcbdialogs/index.ts");
  assert.ok(/action\("collect3DModels", "Collect And Embed 3D Models"/.test(menu) && /"Embed 3D Models"/.test(menu), "Tools > Collect And Embed 3D Models, one undo step");
});

const PCB_EF = (files, fonts) => `(kicad_pcb\n\t(version 20250302)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t)\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n\t(net 0 "")\n\t(gr_line\n\t\t(start 0 0)\n\t\t(end 10 0)\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type default)\n\t\t)\n\t\t(layer "F.SilkS")\n\t\t(uuid "aaaaaaaa-0000-4000-8000-000000000001")\n\t)\n${fonts === undefined ? "" : `\t(embedded_fonts ${fonts})\n`}${files ? `\t(embedded_files\n${files.map((f) => "\t\t" + f + "\n").join("")}\t)\n` : ""})\n`;
test("Board Setup > Embedded Files: removed files leave the board's section, Embed fonts is written, an emptied section goes", () => {
  const BSm = K.boardSetup;
  const fa = EF.embeddedFileSexpr("a.step", new Uint8Array([1, 2, 3])), fb = EF.embeddedFileSexpr("b.pdf", new Uint8Array([4, 5]));
  const file = PCB_EF([fa, fb], "no");
  const r = C.foldOps(K, "kicad_pcb", file, [{ changes: [BSm.embeddedFilesChange([], { remove: ["a.step"], fonts: true })] }]);
  assert.ok(r.ok, r.reason);
  assert.ok(/\(embedded_fonts yes\)/.test(r.text) && !/a\.step/.test(r.text) && /b\.pdf/.test(r.text), r.text);
  const r2 = C.foldOps(K, "kicad_pcb", r.text, [{ changes: [BSm.embeddedFilesChange([], { remove: ["b.pdf"] })] }]);
  assert.ok(r2.ok, r2.reason); assert.ok(!/embedded_files/.test(r2.text) && /\(embedded_fonts yes\)\n\)/.test(r2.text), r2.text);
  const r3 = C.foldOps(K, "kicad_pcb", PCB_EF(null), [{ changes: [BSm.embeddedFilesChange([fa], { fonts: false })] }]);
  assert.ok(r3.ok, r3.reason); assert.ok(/\(embedded_fonts no\)\n\t\(embedded_files/.test(r3.text), "the flag goes before the files, as PCB_IO_KICAD_SEXPR writes them");
  // the open board follows the same change
  const doc = K.parseDoc(file, "kicad_pcb");
  assert.strictEqual(doc.embeddedFonts, false);
  BSm.applyBoardSetup(doc, BSm.embeddedFilesChange([], { remove: ["a.step"], fonts: true }));
  assert.strictEqual(doc.embeddedFonts, true); assert.deepStrictEqual(EF.embeddedFileNames(doc.embeddedFiles), ["b.pdf"]);
  BSm.applyBoardSetup(doc, BSm.embeddedFilesChange([], { remove: ["b.pdf"] }));
  assert.strictEqual(doc.embeddedFiles, null);
});

test("Schematic Setup > Embedded Files: the root sheet's files and Embed fonts travel as document settings and fold into the file", () => {
  const fa = EF.embeddedFileSexpr("sheet.kicad_wks", new TextEncoder().encode("(kicad_wks)"));
  const SCH = `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(generator_version "9.0")\n\t(uuid "0f0f0f0f-0000-4000-8000-000000000000")\n\t(paper "A4")\n\t(lib_symbols)\n\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n`;
  const change = { id: "00000000-0000-0000-0000-0000000d0c00", kind: "MODIFIED", typeName: "PAGE_SETTINGS", docProps: { embeddedFiles: { put: [fa], remove: [], fonts: true } } };
  const r = C.foldOps(K, "kicad_sch", SCH, [{ changes: [change] }]);
  assert.ok(r.ok, r.reason);
  assert.ok(/\(embedded_fonts yes\)\n\t\(embedded_files\n\t\t\(file/.test(r.text) && /sheet\.kicad_wks/.test(r.text), r.text);
  const doc = K.parseDoc(SCH, "kicad_sch");
  K.applyDocProps(doc, change.docProps);
  assert.strictEqual(doc.embeddedFonts, true); assert.deepStrictEqual(EF.embeddedFileNames(doc.embeddedFiles), ["sheet.kicad_wks"]);
  const back = { ...change, docProps: { embeddedFiles: { put: [], remove: ["sheet.kicad_wks"] } } };
  const r2 = C.foldOps(K, "kicad_sch", r.text, [{ changes: [back] }]);
  assert.ok(r2.ok, r2.reason); assert.ok(!/embedded_files/.test(r2.text) && /\(embedded_fonts yes\)/.test(r2.text));
  K.applyDocProps(doc, back.docProps); assert.strictEqual(doc.embeddedFiles, null);
  // the pages are the shared PANEL_EMBEDDED_FILES, with no desktop-only note left
  const sp = src("dialogs/schematic-setup-pages.ts"), bp = src("editor/pcbdialogs/board-setup-pages.ts"), panel = src("editor/pcbdialogs/fp-3d-panel.ts");
  assert.ok(!/adding and removing them is done in the desktop/.test(sp + bp));
  assert.ok(/embeddedFilesPanel\(/.test(sp) && /embeddedFilesPanel\(/.test(bp));
  assert.ok(/Copy Embedded Reference/.test(panel) && /onFontEmbedClick/.test(panel));
  assert.ok(/Delete from symbols as well\?/.test(src("dialogs/schematic-setup.ts")) && /Delete from footprints as well\?/.test(src("editor/pcbdialogs/board-setup.ts")));
});

// ---------------------------------------------------------------- new items at KiCad's save position
test("the fold puts a new schematic item where SCH_IO_KICAD_SEXPR's multiset (Type(), then uuid) puts it", () => {
  const SCH = `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(generator_version "9.0")\n\t(uuid "0f0f0f0f-0000-4000-8000-000000000000")\n\t(paper "A4")\n\t(lib_symbols)\n` +
    `\t(junction\n\t\t(at 10 10)\n\t\t(diameter 0)\n\t\t(color 0 0 0 0)\n\t\t(uuid "10000000-0000-4000-8000-000000000001")\n\t)\n` +
    `\t(wire\n\t\t(pts\n\t\t\t(xy 0 0) (xy 10 0)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid "30000000-0000-4000-8000-000000000001")\n\t)\n` +
    `\t(wire\n\t\t(pts\n\t\t\t(xy 0 10) (xy 10 10)\n\t\t)\n\t\t(stroke\n\t\t\t(width 0)\n\t\t\t(type default)\n\t\t)\n\t\t(uuid "50000000-0000-4000-8000-000000000001")\n\t)\n` +
    `\t(label "A"\n\t\t(at 0 0 0)\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1.27 1.27)\n\t\t\t)\n\t\t)\n\t\t(uuid "00000000-0000-4000-8000-000000000009")\n\t)\n` +
    `\t(sheet_instances\n\t\t(path "/"\n\t\t\t(page "1")\n\t\t)\n\t)\n\t(embedded_fonts no)\n)\n`;
  const wire = (u) => `(wire (pts (xy 20 0) (xy 30 0)) (stroke (width 0) (type default)) (uuid "${u}"))`;
  const r = C.foldOps(K, "kicad_sch", SCH, [{ changes: [
    { id: "40000000-0000-4000-8000-000000000001", kind: "ADDED", sexpr: wire("40000000-0000-4000-8000-000000000001") },
    { id: "60000000-0000-4000-8000-000000000001", kind: "ADDED", sexpr: wire("60000000-0000-4000-8000-000000000001") },
    { id: "70000000-0000-4000-8000-000000000001", kind: "ADDED", sexpr: `(no_connect (at 5 5) (uuid "70000000-0000-4000-8000-000000000001"))` },
    { id: "20000000-0000-4000-8000-000000000001", kind: "ADDED", sexpr: `(text "t" (exclude_from_sim no) (at 1 1 0) (effects (font (size 1.27 1.27))) (uuid "20000000-0000-4000-8000-000000000001"))` },
  ] }]);
  assert.ok(r.ok, r.reason);
  const order = [...r.text.matchAll(/\(uuid "([0-9a-f])0000000-0000-4000-8000-00000000000(\d)"\)/g)].map((m) => m[1] + m[2]);
  assert.deepStrictEqual(order, ["21", "11", "71", "31", "41", "51", "61", "09"], "text, junction, no_connect, the wires by uuid, then the label");
});

test("the fold puts a new board item at the end of its set, ordered by the set's comparator (footprints, drawings, tracks, zones)", () => {
  const head = `(kicad_pcb\n\t(version 20250302)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t\t(5 "F.SilkS" user)\n\t\t(25 "Edge.Cuts" user)\n\t)\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n\t(net 0 "")\n\t(net 1 "GND")\n\t(net 2 "VCC")\n`;
  const fp = (u, layer) => `\t(footprint "R"\n\t\t(layer "${layer}")\n\t\t(uuid "${u}")\n\t\t(at 0 0)\n\t)\n`;
  const line = (u, x, layer) => `\t(gr_line\n\t\t(start ${x} 0)\n\t\t(end ${x + 5} 0)\n\t\t(stroke\n\t\t\t(width 0.1)\n\t\t\t(type default)\n\t\t)\n\t\t(layer "${layer}")\n\t\t(uuid "${u}")\n\t)\n`;
  const seg = (u, net) => `\t(segment\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(width 0.2)\n\t\t(layer "F.Cu")\n\t\t(net ${net})\n\t\t(uuid "${u}")\n\t)\n`;
  const zone = (u) => `\t(zone\n\t\t(net 1)\n\t\t(net_name "GND")\n\t\t(layer "B.Cu")\n\t\t(uuid "${u}")\n\t\t(hatch edge 0.5)\n\t\t(connect_pads\n\t\t\t(clearance 0.5)\n\t\t)\n\t\t(min_thickness 0.25)\n\t\t(fill\n\t\t\t(thermal_gap 0.5)\n\t\t\t(thermal_bridge_width 0.5)\n\t\t)\n\t\t(polygon\n\t\t\t(pts\n\t\t\t\t(xy 0 0) (xy 1 0) (xy 1 1)\n\t\t\t)\n\t\t)\n\t)\n`;
  const file = head + fp("a1000000-0000-4000-8000-000000000000", "F.Cu") + fp("a3000000-0000-4000-8000-000000000000", "B.Cu") + line("b1000000-0000-4000-8000-000000000000", 0, "F.SilkS") + line("b3000000-0000-4000-8000-000000000000", 20, "F.SilkS") + line("b4000000-0000-4000-8000-000000000000", 0, "Edge.Cuts") + seg("c1000000-0000-4000-8000-000000000000", 1) + seg("c3000000-0000-4000-8000-000000000000", 2) + zone("d1000000-0000-4000-8000-000000000000") + ")\n";
  const one = (t) => t.replace(/\n\t*/g, " ").trim();
  const r = C.foldOps(K, "kicad_pcb", file, [{ changes: [
    { id: "a2000000-0000-4000-8000-000000000000", kind: "ADDED", sexpr: one(fp("a2000000-0000-4000-8000-000000000000", "F.Cu")) },
    { id: "b2000000-0000-4000-8000-000000000000", kind: "ADDED", sexpr: one(line("b2000000-0000-4000-8000-000000000000", 10, "F.SilkS")) },
    { id: "c2000000-0000-4000-8000-000000000000", kind: "ADDED", sexpr: one(seg("c2000000-0000-4000-8000-000000000000", 1)) },
    { id: "d2000000-0000-4000-8000-000000000000", kind: "ADDED", sexpr: one(zone("d2000000-0000-4000-8000-000000000000")) },
  ] }]);
  assert.ok(r.ok, r.reason);
  const order = [...r.text.matchAll(/\(uuid "([a-d]\d)000000-0000-4000-8000-000000000000"\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(order, ["a1", "a2", "a3", "b1", "b2", "b3", "b4", "c1", "c2", "c3", "d1", "d2"], "each new item inside its set, at its comparator's place");
});


// ---------------------------------------------------------------- io-format#2: a raised version re-saves what reads differently
const CR = (v, body) => `(kicad_pcb\n\t(version ${v})\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t\t(5 "F.SilkS" user)\n\t\t(25 "Edge.Cuts" user)\n\t)\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n\t(net 0 "")\n\t(net 1 "~RST~")\n${body}\t(gr_line\n\t\t(start 0 0)\n\t\t(end 10 0)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "e1e1e1e1-0000-4000-8000-000000000001")\n\t)\n)\n`;
const HFP = `(footprint "X:Y" (layer "F.Cu") (uuid "f0f0f0f0-0000-4000-8000-000000000001") (at 5 5) (height 4) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "f0f0f0f0-0000-4000-8000-000000000003")))`;
const addHFP = [{ changes: [{ id: "f0f0f0f0-0000-4000-8000-000000000001", kind: "ADDED", sexpr: HFP }] }];
const VIA = '\t(via\n\t\t(at 1 1)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers "F.Cu" "B.Cu")\n\t\t(net 1)\n\t\t(uuid "a1a1a1a1-0000-4000-8000-000000000001")\n\t)\n';
const BOLD = '\t(gr_text "~RST~"\n\t\t(at 3 3 0)\n\t\t(layer "F.SilkS")\n\t\t(uuid "b1b1b1b1-0000-4000-8000-000000000001")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.24)\n\t\t\t\tbold\n\t\t\t)\n\t\t)\n\t)\n';
const FPZ = '\t(footprint "A:B"\n\t\t(layer "F.Cu")\n\t\t(uuid "c1c1c1c1-0000-4000-8000-000000000001")\n\t\t(at 10 20 90)\n\t\t(zone\n\t\t\t(net 0)\n\t\t\t(net_name "")\n\t\t\t(layer "F.Cu")\n\t\t\t(uuid "c1c1c1c1-0000-4000-8000-000000000002")\n\t\t\t(hatch edge 0.5)\n\t\t\t(connect_pads\n\t\t\t\t(clearance 0)\n\t\t\t)\n\t\t\t(min_thickness 0.25)\n\t\t\t(fill\n\t\t\t\t(thermal_gap 0.5)\n\t\t\t\t(thermal_bridge_width 0.5)\n\t\t\t)\n\t\t\t(polygon\n\t\t\t\t(pts\n\t\t\t\t\t(xy 11 21) (xy 12 21) (xy 12 22)\n\t\t\t\t)\n\t\t\t)\n\t\t\t(filled_polygon\n\t\t\t\t(layer "F.Cu")\n\t\t\t\t(pts\n\t\t\t\t\t(xy 11 21) (xy 12 21) (xy 12 22)\n\t\t\t\t)\n\t\t\t)\n\t\t)\n\t\t(point\n\t\t\t(at 13 20)\n\t\t\t(size 1)\n\t\t\t(layer "F.SilkS")\n\t\t)\n\t)\n';
test("io-format#2: a board raised past via protection, bold width, footprint frames and overbars writes those items in the new form", () => {
  const file = CR(20200101, VIA + BOLD + FPZ);
  const r = C.foldOps(K, "kicad_pcb", file, addHFP);
  assert.ok(r.ok, r.reason); assert.strictEqual(r.version, 20261017); assert.ok(/overall height/.test(r.notice));
  const t = r.text, d = K.parseDoc(t, "kicad_pcb");
  const via = d.items.get("a1a1a1a1-0000-4000-8000-000000000001").node;
  assert.deepStrictEqual([K.kid(via, "capping"), K.kid(via, "filling")], [["capping", "no"], ["filling", "no"]], "protection off is said explicitly");
  assert.deepStrictEqual(K.kid(via, "covering"), ["covering", ["front", "no"], ["back", "no"]]); assert.deepStrictEqual(K.kid(via, "plugging"), ["plugging", ["front", "no"], ["back", "no"]]);
  assert.ok(/\(tenting|\(layers "F.Cu" "B.Cu"\)\s*\(capping no\)\s*\(covering/.test(t), "written where PCB_IO_KICAD_SEXPR puts them");
  const txt = d.items.get("b1b1b1b1-0000-4000-8000-000000000001").node;
  assert.strictEqual(txt[1], "~{RST}", "ConvertToNewOverbarNotation"); assert.strictEqual(K.kid(K.kid(K.kid(txt, "effects"), "font"), "thickness")[1], 0.15, "MigrateLegacyBoldStrokeWidth: 0.24 / 1.6");
  assert.ok(/\t\(net 1 "~\{RST\}"\)\n/.test(t), "the net list in the new notation too");
  const fp = d.items.get("c1c1c1c1-0000-4000-8000-000000000001").node, z = K.kid(fp, "zone");
  assert.deepStrictEqual(K.kids(K.kid(K.kid(z, "polygon"), "pts"), "xy").map((q) => q.slice(1)), [[-1, 1], [-1, 2], [-2, 2]], "the outline in the footprint's frame (InverseApply)");
  assert.deepStrictEqual(K.kids(K.kid(K.kid(z, "filled_polygon"), "pts"), "xy").map((q) => q.slice(1)), [[11, 21], [12, 21], [12, 22]], "the fill stays in the board frame");
  assert.deepStrictEqual(K.kid(K.kid(fp, "point"), "at").slice(1), [0, 3], "a point too");
  assert.ok(t.includes('\t(gr_line\n\t\t(start 0 0)\n\t\t(end 10 0)\n\t\t(layer "Edge.Cuts")\n\t\t(uuid "e1e1e1e1-0000-4000-8000-000000000001")\n\t)'), "what reads the same keeps its bytes");
  const again = C.foldOps(K, "kicad_pcb", t, []); assert.ok(again.ok && again.text === t);
});
test("io-format#2: a reference image crossing 20260623 is rescaled by the corrected PPI; a version below every boundary is not rewritten", () => {
  // a PNG whose pHYs says 3937.5 px/m: the legacy PPI truncated it to 39 px/cm (99 PPI), the corrected one is 100
  const png = Buffer.alloc(70); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(10, 16); png.writeUInt32BE(10, 20);
  png.writeUInt32BE(9, 33); png.write("pHYs", 37); png.writeUInt32BE(3937, 41); png.writeUInt32BE(3937, 45); png[49] = 1;
  const info = K.imageInfo(png), f = K.legacyImageScaleFactor(false, 20250101, info);
  const img = `\t(image\n\t\t(at 50 50)\n\t\t(layer "F.SilkS")\n\t\t(scale 2)\n\t\t(uuid "b2b2b2b2-0000-4000-8000-000000000001")\n\t\t(data "${png.toString("base64")}")\n\t)\n`;
  const r = C.foldOps(K, "kicad_pcb", CR(20250302, img), addHFP);
  assert.ok(r.ok, r.reason);
  const n = K.parseDoc(r.text, "kicad_pcb").items.get("b2b2b2b2-0000-4000-8000-000000000001").node;
  if (f !== 1) assert.strictEqual(K.kid(n, "scale")[1], Number((2 * f).toPrecision(6)), "scale × PPI / legacy PPI, written {:g}");
  else assert.strictEqual(K.kid(n, "scale")[1], 2);
  const up = K.upgradeLegacyNode(K.parse(img), true, 20250302, 20260200); assert.strictEqual(K.kid(up, "scale")[1], 2, "20260200 does not cross 20260623");
});
test("io-format#2: a schematic raised past KiCad 6 polylines, symbol arcs and \"~\" values rewrites them, its symbol instances and its bus aliases", () => {
  const SCHX = `(kicad_sch (version 20200310) (generator eeschema)
  (uuid "root")
  (page A3)
  (lib_symbols
    (symbol "D:A" (in_bom yes) (on_board yes)
      (property "Reference" "U" (id 0) (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "A_0_1" (arc (start 0 1) (mid 1 0) (end 0 -1) (stroke (width 0) (type default) (color 0 0 0 0)) (fill (type none))))
    )
  )
  (bus_alias "B~X~" (members "A~Y~" "C"))
  (polyline (pts (xy 0 0) (xy 10 0) (xy 10 10)) (stroke (width 0) (type default) (color 0 0 0 0)) (uuid "11111111-0000-4000-8000-000000000001"))
  (text "~RST~ here" (at 5 5 0) (effects (font (size 1.27 1.27))) (uuid "11111111-0000-4000-8000-000000000002"))
  (symbol (lib_id "D:A") (at 20 20 0) (unit 1) (in_bom yes) (on_board yes) (uuid "11111111-0000-4000-8000-000000000003")
    (property "Reference" "U1" (id 0) (at 20 18 0) (effects (font (size 1.27 1.27))))
    (property "Value" "~" (id 1) (at 20 22 0) (effects (font (size 1.27 1.27)))))
  (symbol_instances (path "/11111111-0000-4000-8000-000000000003" (reference "U1") (unit 1) (value "~") (footprint "~")))
)
`;
  const ell = '(ellipse (center 50 50) (major_radius 5) (minor_radius 3) (rotation_angle 0) (stroke (width 0) (type default)) (fill (type none)) (uuid "22222222-0000-4000-8000-000000000001"))';
  const r = C.foldOps(K, "kicad_sch", SCHX, [{ changes: [{ id: "22222222-0000-4000-8000-000000000001", kind: "ADDED", sexpr: ell }] }]);
  assert.ok(r.ok, r.reason); assert.strictEqual(r.version, 20260508);
  const t = r.text, d = K.parseDoc(t, "kicad_sch");
  assert.ok(/\(paper "A3"\)/.test(t) && !/\(page A3\)/.test(t), "a KiCad 5 (page …) is written (paper …)");
  assert.ok(/\(bus_alias "B~\{X\}"[\s\S]*"A~\{Y\}" "C"/.test(t), "bus aliases in the new overbar notation");
  assert.strictEqual(d.items.get("11111111-0000-4000-8000-000000000002").node[1], "~{RST} here");
  assert.strictEqual(K.kid(K.kid(d.items.get("11111111-0000-4000-8000-000000000001").node, "stroke"), "type")[1], "dash", "a KiCad 6 polyline's default style is dashed");
  const val = K.kids(d.items.get("11111111-0000-4000-8000-000000000003").node, "property").find((p) => p[1] === "Value");
  assert.strictEqual(val[2], "", "\"~\" is an empty value");
  assert.ok(/\(value ""\)\s*\(footprint ""\)/.test(t), "in the symbol instances too");
  const arc = K.kid(K.kid(d.lib.get("D:A"), "symbol"), "arc");
  assert.deepStrictEqual(K.kid(arc, "mid").slice(1), [0.9956, 0], "a 180° arc nudged to 179.5° (pre-7.0 repair)");
  const again = C.foldOps(K, "kicad_sch", t, []); assert.ok(again.ok && again.text === t);
});

test("io-format#2: a footprint file and a symbol library raised past 20260826 write their bold texts' width in the new form", () => {
  const F = K.footprintDoc;
  const old = '(footprint "R" (version 20241229) (generator "pcbnew") (layer "F.Cu") (fp_text user "X" (at 0 0) (layer "F.SilkS") (uuid "c1c1c1c1-0000-4000-8000-000000000009") (effects (font (size 1 1) (thickness 0.24) bold))) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "c1c1c1c1-0000-4000-8000-000000000002")))';
  const d = K.parseDoc(old, "footprint"), pad = [...d.items.values()].find((i) => i.kind === "pad");
  K.applyChange(d, { id: pad.id, kind: "MODIFIED", typeName: "PAD", sexpr: K.serializeItem(d, pad).replace("(at 0 0)", "(at 1 0)") }, 1e6);
  const kept = F.serializeFootprintDoc(d);
  assert.ok(/\(version 20241229\)/.test(kept) && /\(thickness 0\.24\)/.test(kept), "not raised: the stored form");
  K.applyChange(d, { id: pad.id, kind: "MODIFIED", typeName: "PAD", sexpr: K.serializeItem(d, pad).replace('(uuid "c1c1c1c1-0000-4000-8000-000000000002")', '(uuid "c1c1c1c1-0000-4000-8000-000000000002") (custom_property "k" "v")') }, 1e6);
  const out = F.serializeFootprintDoc(d);
  assert.ok(/^\(footprint "R"\s+\(version 20260831\)/.test(out), out.slice(0, 80));
  assert.ok(/\(thickness 0\.15\)/.test(out) && !/0\.24/.test(out), out);
  const M = load("symedit/model.ts");
  const libText = '(kicad_symbol_lib (version 20241209) (generator "kicad_symbol_editor") (symbol "A" (in_bom yes) (on_board yes) (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27) (thickness 0.4) (bold yes)))) (custom_property "k" "v") (symbol "A_1_1" (rectangle (start 0 0) (end 1 1) (stroke (width 0) (type default)) (fill (type none))))))';
  const lib = M.parseLibrary(libText);
  const w = M.serializeLibrary(lib);
  assert.ok(/\(version 20261106\)/.test(w), w.slice(0, 80));
  assert.ok(/\(thickness 0\.25\)/.test(w), "0.4 / 1.6: " + w);
});

// ---------------------------------------------------------------- io-format#19: the drawings' comparators, groups, net order
const IO = load("mcp/item-order.ts");
const OCTX = { layerId: (n) => IO.canonicalLayerId(n) ?? -1, netCode: () => 0 };
test("io-format#19: board texts, text boxes, tables and barcodes compare as EDA_TEXT / PCB_TABLE / PCB_BARCODE::Compare", () => {
  const T = (s) => K.parse(s);
  const tx = (text, at, extra = "") => T(`(gr_text "${text}" (at ${at}) (layer "F.SilkS") (uuid "u") (effects (font (size 1 1) (thickness 0.15) ${extra})))`);
  assert.ok(IO.textCompare(tx("b", "0 0"), tx("a", "1 0"), OCTX) < 0, "the position before the text");
  assert.ok(IO.textCompare(tx("a", "0 0"), tx("b", "0 0"), OCTX) < 0, "then the text");
  assert.ok(IO.textCompare(tx("a", "5 5", '(face "Arial")'), tx("a", "0 0"), OCTX) > 0, "the font name first");
  assert.ok(IO.textCompare(tx("a", "5 5"), tx("a", "0 0", "bold"), OCTX) < 0, "bold after the rest of the attributes, before the position");
  assert.ok(IO.textCompare(tx("a", "0 0 90"), tx("a", "0 0"), OCTX) > 0, "the angle");
  const legacy = { ...OCTX, version: 20250101 };
  assert.strictEqual(IO.textCompare(T(`(gr_text "a" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.24) bold)))`), T(`(gr_text "a" (at 0 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15) bold)))`), legacy), 1, "a pre-20260826 bold width read as /1.6");
  const box = (x, text) => T(`(gr_text_box "${text}" (start ${x} 0) (end ${x + 5} 5) (layer "F.SilkS") (uuid "u") (effects (font (size 1 1))))`);
  assert.ok(IO.textCompare(box(0, "b"), box(0, "a"), OCTX) > 0);
  const tbl = (w, cell) => T(`(table (column_count 2) (layer "F.SilkS") (column_widths ${w} 5) (row_heights 3) (cells (table_cell "${cell}" (start 0 0) (end ${w} 3) (layer "F.SilkS") (effects (font (size 1 1)))) (table_cell "" (start ${w} 0) (end ${w + 5} 3) (layer "F.SilkS") (effects (font (size 1 1))))))`);
  assert.ok(IO.tableCompare(tbl(4, "x"), tbl(5, "x"), OCTX) < 0, "column widths"); assert.ok(IO.tableCompare(tbl(5, "b"), tbl(5, "a"), OCTX) > 0, "then each cell's text");
  assert.strictEqual(IO.tableCompare(tbl(5, "a"), tbl(5, "a"), OCTX), 0);
  const bc = (x, text, ty) => T(`(barcode (at ${x} 0 0) (layer "F.SilkS") (size 5 5) (text "${text}") (text_height 1) (type ${ty}))`);
  assert.ok(IO.barcodeCompare(bc(0, "z", "qr"), bc(1, "a", "qr")) < 0); assert.ok(IO.barcodeCompare(bc(0, "a", "qr"), bc(0, "a", "code39")) > 0, "the kind");
  const e1 = T(`(gr_ellipse (center 0 0) (major_radius 5) (minor_radius 3) (rotation_angle 0) (layer "F.SilkS"))`), e2 = T(`(gr_ellipse (center 0 0) (major_radius 4) (minor_radius 3) (rotation_angle 0) (layer "F.SilkS"))`);
  assert.ok(IO.shapeCompare(e1, e2) > 0, "an ellipse's end is its major axis' end");
  assert.strictEqual(IO.canonicalLayerId("B.Cu"), 2); assert.strictEqual(IO.canonicalLayerId("In3.Cu"), 8); assert.strictEqual(IO.canonicalLayerId("User.1"), 39); assert.strictEqual(IO.canonicalLayerId("F.Mask"), 1);
});
test("io-format#19: groups and generators order by their members' combined layer set; a new text goes by EDA_TEXT::Compare; nets of a table-less board in parse order", () => {
  const head = (v, nets) => `(kicad_pcb\n\t(version ${v})\n\t(generator "pcbnew")\n\t(generator_version "10.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(4 "In1.Cu" signal)\n\t\t(2 "B.Cu" signal)\n\t\t(5 "F.SilkS" user)\n\t\t(7 "B.SilkS" user)\n\t)\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n${nets}`;
  const text = (u, x, s) => `\t(gr_text "${s}"\n\t\t(at ${x} 0 0)\n\t\t(layer "F.SilkS")\n\t\t(uuid "${u}")\n\t\t(effects\n\t\t\t(font\n\t\t\t\t(size 1 1)\n\t\t\t\t(thickness 0.15)\n\t\t\t)\n\t\t)\n\t)\n`;
  const seg = (u, layer, net) => `\t(segment\n\t\t(start 0 0)\n\t\t(end 1 0)\n\t\t(width 0.2)\n\t\t(layer "${layer}")\n\t\t(net "${net}")\n\t\t(uuid "${u}")\n\t)\n`;
  const via = (u, kind, a, b) => `\t(via${kind ? " " + kind : ""}\n\t\t(at 0 0)\n\t\t(size 0.6)\n\t\t(drill 0.3)\n\t\t(layers "${a}" "${b}")\n\t\t(net "B")\n\t\t(uuid "${u}")\n\t)\n`;
  const grp = (u, members) => `\t(group ""\n\t\t(uuid "${u}")\n\t\t(members ${members.map((m) => `"${m}"`).join(" ")})\n\t)\n`;
  const U = (c) => c + "0000000-0000-4000-8000-000000000000";
  const file = head(20251101, "") + text(U("1"), 0, "a") + text(U("3"), 2, "c") + seg(U("4"), "B.Cu", "Z") + seg(U("5"), "F.Cu", "B") + via(U("6"), "blind", "In1.Cu", "B.Cu") + seg(U("7"), "F.Cu", "A")
    + grp(U("c"), [U("4")]) + grp(U("a"), [U("6")]) + ")\n";
  const one = (t) => t.replace(/\n\t*/g, " ").trim();
  const r = C.foldOps(K, "kicad_pcb", file, [{ changes: [
    { id: U("2"), kind: "ADDED", sexpr: one(text(U("2"), 1, "b")) },
    { id: U("8"), kind: "ADDED", sexpr: one(seg(U("8"), "F.Cu", "A")) },
    { id: U("b"), kind: "ADDED", sexpr: one(grp(U("b"), [U("1")])) },
  ] }]);
  assert.ok(r.ok, r.reason);
  const order = [...r.text.matchAll(/\(uuid "([0-9a-f])0000000-0000-4000-8000-000000000000"\)/g)].map((m) => m[1]);
  // texts by x; tracks by net code in parse order (Z=1, B=2, A=3), so the new A segment goes last; groups: b's set {F.SilkS=5}, a's {In1=4, B.Cu=2}, c's {B.Cu=2}: Seq() c [2] < a [2,4] < b [5]
  assert.deepStrictEqual(order, ["1", "2", "3", "4", "5", "6", "7", "8", "c", "a", "b"], r.text);
});
test("Embed 3D Models: the 3D view shows an embedded VRML model from the STEP file embedded beside it", () => {
  const M = load("viewer3d/models.ts");
  const step = EF.embeddedFileSexpr("R.step", new TextEncoder().encode("ISO-10303-21;"));
  const files = K.parse(`(embedded_files ${step})`);
  const fp = K.parse(`(footprint "R" (layer "F.Cu") (model "kicad-embed://R.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))`);
  const refs = M.footprintModels(fp, false, files);
  assert.strictEqual(refs.length, 1); assert.strictEqual(refs[0].source, "embedded"); assert.ok(/^blob:/.test(refs[0].url), refs[0].url);
});

(async () => {
  for (const [name, fn] of queue) { try { await fn(); passed++; } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
  console.log(`server-files: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
