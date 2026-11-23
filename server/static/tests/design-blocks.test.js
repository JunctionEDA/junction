// design-blocks.test.js — KiCad's design blocks in both editors: the library format (DESIGN_BLOCK_IO: <nick>.kicad_blocks
// folders of <name>.kicad_block folders, the .json metadata as nlohmann's dump( 0 ) writes it), the library adapter
// (load, save, delete, delete library, read-only), DIALOG_DESIGN_BLOCK_PROPERTIES' checks, the pane's context menu
// and history, the design block library table (libtable.ts "designBlock"), the schematic placement
// (SCH_DRAWING_TOOLS::ImportSheet: designBlockAnchor, the group linked to the block, "Add Design Block") and the board
// placement (PCB_CONTROL::AppendBoard: GetTopLeftItem, the linked group, locked, "Place Design Block").
// Run: node server/static/tests/design-blocks.test.js
"use strict";
const path = require("node:path"), assert = require("node:assert/strict");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (...p) => { const built = esbuild.buildSync({ entryPoints: [webPath(...p)], bundle: true, format: "cjs", target: "es2020", write: false }); const mod = { exports: {} }; new Function("exports", "module", "require", built.outputFiles[0].text)(mod.exports, mod, require); return mod.exports; };
const D = load("domains", "pcb", "library", "design-blocks.ts");
const T = load("domains", "pcb", "library", "libtable.ts");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "sch-tools.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, sch = globalThis.CollabTools.sch, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- a project in memory
function memStore(files, readOnly) {
  let n = 0; const docs = Object.entries(files).map(([p, t]) => ({ docId: "d" + (++n), path: p, text: t }));
  return {
    docs: () => docs.map(({ docId, path }) => ({ docId, path })),
    read: async (id) => { const d = docs.find((x) => x.docId === id); if (!d) throw new Error("gone"); return d.text; },
    create: async (p, t) => { const d = { docId: "d" + (++n), path: p, text: t }; docs.push(d); return d.docId; },
    write: async (id, t) => { const d = docs.find((x) => x.docId === id); if (!d) return false; d.text = t; return true; },
    remove: async (id) => { const i = docs.findIndex((x) => x.docId === id); if (i < 0) return false; docs.splice(i, 1); return true; },
    readOnly: () => !!readOnly, _docs: docs,
  };
}
const ROWS = [{ nickname: "Blocks", uri: "${KIPRJMOD}/lib/Blocks.kicad_blocks", type: "KiCad", options: "", descr: "mine", enabled: true, visible: true },
  { nickname: "Far", uri: "/usr/share/Far.kicad_blocks", type: "KiCad", options: "", descr: "", enabled: true, visible: true }];

test("the metadata file is nlohmann's dump( 0 ): a newline after every { and comma, {} when empty", () => {
  assert.equal(D.metadataText("An amp", "audio amp", [["Sheetfile", "amp.kicad_sch"], ["Note", "a \"b\""]]),
    '{\n"description": "An amp",\n"keywords": "audio amp",\n"fields": {\n"Sheetfile": "amp.kicad_sch",\n"Note": "a \\"b\\""\n}\n}');
  assert.equal(D.metadataText("", "", []), '{\n"description": "",\n"keywords": "",\n"fields": {}\n}');
  const back = D.parseMetadata(D.metadataText("d", "k", [["A", "1"], ["B", "2"]]));
  assert.deepEqual(back, { description: "d", keywords: "k", fields: [["A", "1"], ["B", "2"]] });
  assert.throws(() => D.parseMetadata('{"description": 3}'));
});

test("LIB_ID and the block folders", () => {
  assert.deepEqual(D.parseDbLibId("Lib:Amp:x"), { lib: "Lib", name: "Amp:x" });
  assert.equal(D.formatDbLibId({ lib: "L", name: "N" }), "L:N");
  assert.equal(D.blockFile("lib/B.kicad_blocks", "Amp", "json"), "lib/B.kicad_blocks/Amp.kicad_block/Amp.json");
  assert.deepEqual(D.blockFileOf("lib/B.kicad_blocks/Amp.kicad_block/Amp.kicad_pcb"), { lib: "lib/B.kicad_blocks", name: "Amp", kind: "pcb" });
  assert.equal(D.blockFileOf("lib/B.kicad_blocks/readme.txt"), null);
  assert.equal(D.projectFolder("${KIPRJMOD}/lib/B.kicad_blocks/"), "lib/B.kicad_blocks");
  assert.equal(D.projectFolder("/abs/B.kicad_blocks"), null);
});

test("DESIGN_BLOCK_IO: enumerate, load, save, rename-by-save, delete, delete library", async () => {
  const st = memStore({ "lib/Blocks.kicad_blocks/Amp.kicad_block/Amp.kicad_sch": "(kicad_sch)", "lib/Blocks.kicad_blocks/Amp.kicad_block/Amp.json": D.metadataText("amp", "audio", [["F", "v"]]),
    "lib/Blocks.kicad_blocks/Psu.kicad_block/Psu.kicad_pcb": "(kicad_pcb)" });
  const L = new D.DesignBlockLibs(st, () => D.librariesOf(ROWS));
  assert.deepEqual(L.names("Blocks").sort(), ["Amp", "Psu"]);
  assert.equal(L.isWritable("Blocks"), true); assert.equal(L.isWritable("Far"), false, "a library outside the project is read only");
  const amp = await L.load({ lib: "Blocks", name: "Amp" });
  assert.equal(amp.description, "amp"); assert.deepEqual(amp.fields, [["F", "v"]]); assert.ok(amp.schDoc); assert.equal(amp.pcbDoc, null);
  await assert.rejects(L.load({ lib: "Blocks", name: "Nope" }), /Design block 'Nope' does not exist in library 'lib\/Blocks.kicad_blocks'\./);
  // a new block needs a schematic or a board
  await assert.rejects(L.save({ id: { lib: "Blocks", name: "Empty" }, description: "", keywords: "", fields: [] }, {}), /does not have a schematic or board file/);
  await assert.rejects(L.save({ id: { lib: "Blocks", name: "a/b" }, description: "", keywords: "", fields: [] }, { sch: "x" }), /valid library ID/);
  await L.save({ id: { lib: "Blocks", name: "New" }, description: "n", keywords: "", fields: [] }, { pcb: "(kicad_pcb new)" });
  assert.ok(st._docs.some((d) => d.path === "lib/Blocks.kicad_blocks/New.kicad_block/New.kicad_pcb" && d.text === "(kicad_pcb new)"));
  assert.ok(st._docs.some((d) => d.path === "lib/Blocks.kicad_blocks/New.kicad_block/New.json"));
  // saving the metadata only keeps the files
  await L.save({ id: { lib: "Blocks", name: "Amp" }, description: "AMP", keywords: "", fields: [] }, {});
  assert.equal((await L.load({ lib: "Blocks", name: "Amp" })).description, "AMP"); assert.ok((await L.load({ lib: "Blocks", name: "Amp" })).schDoc);
  await L.remove({ lib: "Blocks", name: "Psu" }); assert.equal(L.exists("Blocks", "Psu"), false);
  assert.equal((await L.blocks("Blocks")).length, 2);
  // DeleteLibrary refuses a stray file, then takes every block
  st._docs.push({ docId: "x", path: "lib/Blocks.kicad_blocks/stray.txt", text: "" });
  await assert.rejects(L.removeLibrary("Blocks"), /unexpected files/);
  st._docs.splice(st._docs.findIndex((d) => d.docId === "x"), 1);
  assert.equal(await L.removeLibrary("Blocks"), true); assert.equal(st._docs.length, 0);
  const ro = new D.DesignBlockLibs(memStore({}, true), () => D.librariesOf(ROWS));
  assert.equal(ro.isWritable("Blocks"), false, "a view-only project cannot be written");
});

test("DIALOG_DESIGN_BLOCK_PROPERTIES: illegal name characters and duplicate fields", () => {
  assert.equal(D.validateProperties("a:b", []).error, "Illegal character ':' in name 'a:b'.");
  assert.equal(D.validateProperties("a/b", []).error, "Illegal character '/' in name 'a/b'.");
  assert.equal(D.validateProperties("a\\b", []).error, "Illegal character '\\' in name 'a\\b'.");
  assert.equal(D.validateProperties("ok name", [["  A  ", "1"], ["A", "2"]]).error, "Duplicate fields are not allowed.");
  assert.deepEqual(D.validateProperties("ok", [["  A   B ", "1"], ["C\n", "2"]]).fields, [["A B", "1"], ["C", "2"]]);
});

test("GenerateInfo: name, description (linked), keywords and the field table", () => {
  const html = D.blockInfoHtml({ id: { lib: "L", name: "Amp<1>" }, description: "see https://x.org/a", keywords: "k", fields: [["F", "v"]] });
  assert.ok(html.startsWith("<b>Amp&lt;1&gt;</b><br>see <a href=\"https://x.org/a\""));
  assert.ok(html.includes("<br>Keywords: k<hr><table border=0><tr>   <td><b>F</b></td>   <td>v</td></tr></table>"));
});

test("the pane's context menu (DESIGN_BLOCK_CONTROL + SCH / PCB_DESIGN_BLOCK_CONTROL::Init)", () => {
  assert.deepEqual(D.designBlockTreeMenu("sch", { isLibrary: false, isDesignBlock: true, pinned: false, hasSelection: true }),
    ["newLibrary", "-", "placeDesignBlock", "-", "editDesignBlockProperties", "saveSheetAsDesignBlock", "saveSelectionAsDesignBlock", "updateDesignBlockFromSheet", "updateDesignBlockFromSelection", "deleteDesignBlock", "-", "hideLibraryTree"]);
  assert.deepEqual(D.designBlockTreeMenu("pcb", { isLibrary: true, isDesignBlock: false, pinned: false, hasSelection: false }),
    ["pinLibrary", "newLibrary", "-", "saveBoardAsDesignBlock", "-", "hideLibraryTree"]);
  assert.deepEqual(D.designBlockTreeMenu("pcb", { isLibrary: true, isDesignBlock: false, pinned: true, hasSelection: true }),
    ["unpinLibrary", "newLibrary", "-", "saveBoardAsDesignBlock", "saveSelectionAsDesignBlock", "-", "hideLibraryTree"]);
  assert.deepEqual(D.designBlockTreeMenu("sch", { isLibrary: false, isDesignBlock: false, pinned: false, hasSelection: true }), ["newLibrary", "-", "hideLibraryTree"]);
});

test("Recently Used keeps the newest first, no duplicates, fewer than 8", () => {
  let h = [];
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "b"]) h = D.addToHistory(h, id);
  assert.deepEqual(h, ["b", "h", "g", "f", "e", "d", "c"]);
  assert.deepEqual(D.DB_PLACE_DEFAULTS, { repeated: false, group: true, sheet: false, keep: false });
  assert.equal(D.groupDesignBlockId(["group", "G", ["uuid", "u"], ["lib_id", "L:N"], ["members"]]), "L:N");
  assert.equal(D.groupDesignBlockId(["group", "G", ["uuid", "u"], ["members"]]), null);
});

test("the design block library table: design-block-lib-table, folders of .kicad_blocks, KICAD10_DESIGN_BLOCK_DIR", () => {
  assert.equal(T.tableFileName("designBlock"), "design-block-lib-table");
  assert.equal(T.tableRoot("designBlock"), "design_block_lib_table");
  assert.ok(T.tablePreamble("designBlock").startsWith("(design_block_lib_table"));
  assert.deepEqual(T.plugins("designBlock").map((p) => p.type), ["KiCad"]);
  assert.equal(T.guessFormat("designBlock", "lib/x.kicad_blocks"), "KiCad");
  assert.equal(T.nicknameFor("designBlock", "lib/My Blocks.kicad_blocks", "KiCad"), "My Blocks");
});

// ---------------------------------------------------------------- the schematic placement
const SHEAD = '(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4") (lib_symbols) ';
const wire = (a, b, u) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${u}"))`;
test("ImportSheet( placeDesignBlock ): designBlockAnchor (topmost, then leftmost connection point) and the linked group", () => {
  const doc = K.parseDoc(SHEAD + ")", "kicad_sch");
  // connection points (10,20) (30,20) and (5,25) (5,40): the anchor is (10,20), not the leftmost item
  const block = SHEAD + wire([10, 20], [30, 20], "w1") + wire([5, 25], [5, 40], "w2") + `(text "note" (at 1 1 0) (effects (font (size 1.27 1.27))) (uuid "t1"))` + ")";
  const parsed = sch.parseClipboard(block);
  const r = sch._.pasteChanges(doc, parsed, [100, 100], { anchor: "designBlock", group: "Amp", groupLibId: "Blocks:Amp", pasteMode: "keep", noJunctions: true });
  const nodes = r.changes.map((c) => K.parseAll(c.sexpr)[0]);
  const w = nodes.filter((n) => n[0] === "wire").map((n) => K.kid(n, "pts").slice(1).map((p) => [p[1], p[2]]));
  assert.deepEqual(w[0], [[100, 100], [120, 100]]);
  assert.deepEqual(w[1], [[95, 105], [95, 120]]);
  const g = nodes.find((n) => n[0] === "group");
  assert.equal(g[1], "Amp"); assert.equal(K.str(K.kid(g, "lib_id")[1]), "Blocks:Amp");
  assert.equal(K.kid(g, "members").length - 1, 3, "the block's items are the group's members");
  // without connection points the positions decide
  const r2 = sch._.pasteChanges(doc, sch.parseClipboard(SHEAD + `(text "a" (at 4 9 0) (effects (font (size 1.27 1.27))) (uuid "t2"))(text "b" (at 8 3 0) (effects (font (size 1.27 1.27))) (uuid "t3"))` + ")"), [50, 50], { anchor: "designBlock", pasteMode: "keep" });
  const ats = r2.changes.map((c) => K.atOf(K.parseAll(c.sexpr)[0]).slice(0, 2));
  assert.deepEqual(ats, [[46, 56], [50, 50]]);
});

// ---------------------------------------------------------------- the board placement
const PHEAD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user))`;
const FP = (id, ref, x, y, extra = "") => `(footprint "T:R" (layer "F.Cu") ${extra} (uuid "${id}") (at ${x} ${y}) (path "/aaaa-${id}")
    (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "${id}-ref") (effects (font (size 1 1) (thickness 0.15))))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net "VCC") (uuid "${id}-p1")))`;
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], selection: null };
  const ctx = {
    K, doc, IU: 1e6, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, selection: new Set(), cursor: [40, 40], activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(l) { log.selection = Array.from(l); ctx.selection = new Set(log.selection); }, setHighlight() {},
    clipboard: { get: () => "", set() {} },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, 1e6); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
test("AppendBoard for a design block: GetTopLeftItem lands on the cursor, a linked (locked) group, Place Design Block", () => {
  const { ctx, log } = fakeCtx(K.parseDoc(PHEAD + ")", "kicad_pcb"));
  const text = PHEAD + FP("a", "R1", 20, 10) + FP("b", "R2", 12, 30) + `(segment (start 12 5) (end 18 5) (width 0.25) (layer "F.Cu") (net "VCC") (uuid "s"))` + ")";
  let after = null;
  assert.equal(P.placeBoardText(ctx, text, { label: "Place Design Block", group: { name: "Amp", libId: "Blocks:Amp" }, after: (placed) => { after = placed; } }), true);
  const c = log.commits.at(-1); assert.equal(c.label, "Place Design Block"); assert.deepEqual(c.opts, { tentative: true });
  const items = c.changes.map((ch) => ctx.doc.items.get(ch.id));
  const fps = items.filter((it) => it.kind === "footprint");
  // the leftmost, then topmost item is R2's footprint at (12, 30) and the segment starting at (12, 5): the segment wins on y
  assert.deepEqual(fps.map((f) => K.atOf(f.node).slice(0, 2)).sort((a, b) => a[0] - b[0]), [[40, 65], [48, 45]]);
  assert.ok(fps.every((f) => !K.kid(f.node, "path")), "a placed footprint has no schematic path");
  assert.deepEqual(fps.map((f) => K.str(K.kids(f.node, "property")[0][2])).sort(), ["R1", "R2"], "references are kept");
  const g = items.find((it) => it.kind === "group");
  assert.equal(g.node[1], "Amp"); assert.equal(K.str(K.kid(g.node, "lib_id")[1]), "Blocks:Amp"); assert.equal(K.kid(g.node, "locked"), null);
  assert.equal(K.kid(g.node, "members").length - 1, 3);
  assert.deepEqual(log.selection, [g.id]);
  assert.ok(P.state.move && P.state.move.placing, "the block hangs on the cursor");
  P.state.move.after(true, true); assert.equal(after, true);
  P.state.move = null;
  // a locked item locks the group (PCB_GROUP::SetLocked( true ))
  const lk = fakeCtx(K.parseDoc(PHEAD + ")", "kicad_pcb"));
  P.placeBoardText(lk.ctx, PHEAD + FP("d", "R4", 0, 0, "(locked yes)") + FP("e", "R5", 5, 0) + ")", { label: "Place Design Block", group: { name: "Lk", libId: "Blocks:Lk" } });
  const lg = lk.log.commits.at(-1).changes.map((ch) => lk.ctx.doc.items.get(ch.id)).find((it) => it.kind === "group");
  assert.equal(K.str(K.kid(lg.node, "locked")[1]), "yes");
  P.state.move = null;
  // one item: no group (groupableCount < 2)
  const two = fakeCtx(K.parseDoc(PHEAD + ")", "kicad_pcb"));
  P.placeBoardText(two.ctx, PHEAD + FP("c", "R3", 0, 0) + ")", { label: "Place Design Block", group: { name: "One", libId: "Blocks:One" } });
  assert.ok(!two.log.commits.at(-1).changes.some((ch) => two.ctx.doc.items.get(ch.id).kind === "group"));
  P.state.move = null;
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 10).join("\n       ")); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
})();
