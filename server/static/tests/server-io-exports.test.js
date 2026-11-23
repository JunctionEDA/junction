// server-io-exports.test.js — the web side of the server-run KiCad pieces (round 2, server / file I/O / exporters /
// library-backed actions): kicad-cli's reports in the editor's units (DRC / ERC positions taken back to mm), ERC's
// "Show all errors" and its phase stream with Cancel, the exporters run by kicad-cli on the server
// (For Older KiCad Version..., Specctra DSN, GenCAD, IDFv3), the symbol chooser's Datasheet column, KiCad's
// private clipboard format and File > Export > Symbols....  Run: node server/static/tests/server-io-exports.test.js
"use strict";
const path = require("path"), assert = require("assert"), fs = require("fs");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
globalThis.window = globalThis; globalThis.addEventListener = globalThis.addEventListener || (() => {}); globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
function load(...p) {
  const out = esbuild.buildSync({ entryPoints: [webPath(...p)], bundle: true, format: "cjs", target: "es2020", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const src = (...p) => fs.readFileSync(webPath(...p), "utf8");
const repo = path.join(__dirname, "..", "..", "..");
const KC = load("editor", "kicad-check.ts");
const KJ = load("editor", "kicad-jobs-logic.ts");
const XS = load("editor", "export-symbols-logic.ts");
// chooser.ts pulls in the editor (it needs a document); its column helpers are pure, so they run on their own.
const CH = (() => {
  const text = src("library", "chooser.ts");
  const from = text.indexOf("export function availableColumns"), to = text.indexOf("let openDialog");
  const js = esbuild.transformSync(text.slice(from, to), { loader: "ts", format: "cjs" }).code;
  const m = { exports: {} }; new Function("module", "exports", js)(m, m.exports); return m.exports;
})();

let passed = 0, failed = 0;
const queue = [];   // tests run one after another: the async ones share fetch and lastFallback
function test(name, fn) { queue.push([name, fn]); }
console.log("server-run KiCad: reports, exporters, library columns, clipboard");

// ---------------------------------------------------------------- pcb-drc#A12 / units of the kicad-cli reports
test("pcb-drc#A12: kicad-cli runs in the editor's units; the report's positions come back to mm", () => {
  assert.strictEqual(KC.cliUnits("in"), "in");
  assert.strictEqual(KC.cliUnits("mil"), "mil");
  assert.strictEqual(KC.cliUnits(undefined), "mm");
  assert.strictEqual(KC.reportScale({ coordinate_units: "in" }), 25.4);
  assert.strictEqual(KC.reportScale({ coordinate_units: "mils" }), 0.0254);
  assert.strictEqual(KC.reportScale({ coordinate_units: "mm" }), 1);
  assert.strictEqual(KC.reportScale(null), 1);
  const v = { type: "clearance", severity: "error", description: "Clearance violation (board setting clearance 7.8740 mils; actual 3.9370 mils)",
    items: [{ description: "Track", uuid: "a", pos: { x: 1000, y: 2000 } }], pos: { x: 500, y: 250 } };
  const m = KC.toMarker(v, new Map([["a", "a"]]), KC.reportScale({ coordinate_units: "mils" }));
  assert.ok(Math.abs(m.x - 12.7) < 1e-9 && Math.abs(m.y - 6.35) < 1e-9, `marker at ${m.x},${m.y}`);
  assert.ok(Math.abs(m.items[0].x - 25.4) < 1e-9 && Math.abs(m.items[0].y - 50.8) < 1e-9);
  assert.ok(m.text.includes("mils"), "the message keeps KiCad's units");
  const plain = KC.toMarker(v, new Map());
  assert.strictEqual(plain.x, 500, "no scale: positions as given");
  // both dialogs pass their units
  assert.ok(/serverDrc\(docId, \{[^}]*units: currentUnits\(\)/.test(src("editor", "pcbdialogs", "inspect.ts")));
  assert.ok(/serverErc\(here, \{[^}]*units: E\.units/.test(src("dialogs", "erc-hier.ts")));
});

// ---------------------------------------------------------------- sch-erc#15, #1, #10
function streamResponse(lines, status = 200, type = "application/x-ndjson") {
  const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return { ok: status < 300, status, statusText: "", headers: { get: (k) => (k.toLowerCase() === "content-type" ? type : null) },
    body: { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: bytes }; } }) },
    text: async () => text, json: async () => JSON.parse(text) };
}
test("sch-erc#15 / #10: ERC asks the server with Show all errors and the units, and reads kicad-cli's phases as they come", async () => {
  let asked = null;
  globalThis.fetch = async (url, init) => { asked = { url, body: JSON.parse(init.body), signal: init.signal }; return streamResponse([{ phase: "Checking sheet names..." }, { phase: "Checking conflicts..." }, { report: { sheets: [], coordinate_units: "mm" }, cli: "kicad-cli" }]); };
  const phases = [];
  const rep = await KC.serverErc("doc1", { showAllErrors: true, units: "mil", onPhase: (p) => phases.push(p) });
  assert.deepStrictEqual(asked.body, { showAllErrors: true, units: "mil", progress: true });
  assert.ok(asked.url.endsWith("/api/docs/doc1/erc"));
  assert.deepStrictEqual(phases, ["Checking sheet names...", "Checking conflicts..."]);
  assert.deepStrictEqual(rep, { sheets: [], coordinate_units: "mm" });
  assert.strictEqual(KC.lastFallback, "");
});
test("sch-erc#15: a server whose kicad-cli cannot show all errors sends the dialog to the browser's checks, with its reason", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 501, statusText: "", headers: { get: () => "application/json" }, text: async () => JSON.stringify({ error: "no_kicad_cli_option", message: "This server's kicad-cli cannot show all errors; the checks run in the browser." }) });
  assert.strictEqual(await KC.serverErc("d", { showAllErrors: true }), null);
  assert.ok(/no kicad-cli|cannot show all errors/.test(KC.lastFallback), KC.lastFallback);
  globalThis.fetch = async () => streamResponse([{ phase: "Checking pins..." }, { error: "check_failed", message: "Failed to load schematic", status: 422 }]);
  assert.strictEqual(await KC.serverErc("d", {}), null);
  assert.ok(KC.lastFallback.includes("Failed to load schematic"), KC.lastFallback);
});
test("sch-erc#10: Cancel aborts the request (the server stops kicad-cli) and no browser check runs after it", async () => {
  const ac = new AbortController();
  globalThis.fetch = async (url, init) => { assert.strictEqual(init.signal, ac.signal); ac.abort(); const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  assert.strictEqual(await KC.serverErc("d", { signal: ac.signal }), null);
  const hier = src("dialogs", "erc-hier.ts"), dlg = src("dialogs", "erc.ts");
  assert.ok(/if \(opts\.signal && opts\.signal\.aborted\) return null;/.test(hier), "an aborted run returns before the browser engine");
  assert.ok(/cancel\(\) \{ if \(running\) \{ cancelled = true; if \(abort\) abort\.abort\(\);/.test(dlg), "Cancel aborts the server run");
  assert.ok(/onPhase: \(msg\) => \{ if \(!cancelled\) \{ phases\+\+; report\(msg\); \} \}/.test(dlg), "kicad-cli's phases go to the message list");
  assert.ok(/showAllErrors: opts\.showAllErrors, onPhase/.test(dlg), "Show all errors reaches the server run");
});
test("sch-erc#1: the ERC report's marker position and every item of a violation (C++ report writer)", () => {
  const erc = fs.readFileSync(path.join(repo, "eeschema", "erc", "erc_report.cpp"), "utf8");
  assert.ok(/dynamic_cast<const SCH_MARKER\*>\( item->GetParent\(\) \)/.test(erc) && /violation\.pos = pos;/.test(erc));
  const rc = fs.readFileSync(path.join(repo, "common", "rc_item.cpp"), "utf8");
  assert.ok(/for\( const KIID& id : \{ GetAuxItem2ID\(\), GetAuxItem3ID\(\) \} \)/.test(rc));
  const cli = fs.readFileSync(path.join(repo, "kicad", "cli", "command_sch_erc.cpp"), "utf8");
  assert.ok(cli.includes('"--show-all-errors"') && cli.includes('"--progress"') && /ercJob->m_showAllErrors = /.test(cli));
  const jh = fs.readFileSync(path.join(repo, "eeschema", "eeschema_jobs_handler.cpp"), "utf8");
  assert.ok(/ERC_TESTER ercTester\( sch, ercJob->m_showAllErrors \);/.test(jh));
  // a violation with four items keeps them all as exclusion keys
  const m = KC.toMarker({ type: "pin_to_pin", severity: "error", description: "x", items: ["a", "b", "c", "d"].map((u) => ({ uuid: u, description: u, pos: { x: 1, y: 1 } })) }, new Map());
  assert.deepStrictEqual(m.kiids, ["a", "b", "c", "d"]);
});

// ---------------------------------------------------------------- For Older KiCad Version (sch-frame-chrome#17 / pcb-frame-chrome#22)
test("For Older KiCad Version: the targets are GetDowngradeTargets', newest first", () => {
  const h = fs.readFileSync(path.join(repo, "include", "downgrade_target.h"), "utf8");
  const rows = [...h.matchAll(/\{ wxT\( "([^"]+)" \), wxT\( "([^"]+)" \), (\d+), (\d+), (\d+) \}/g)].map((m) => ({ name: m[1], id: m[2], schVersion: Number(m[4]) }));
  assert.ok(rows.length >= 2);
  assert.deepStrictEqual(KJ.DOWNGRADE_TARGETS, rows);
  assert.ok(/SCH_VER_VARIANTS\s*=\s*20250922/.test(fs.readFileSync(path.join(repo, "include", "downgrade_scan.h"), "utf8")) || KJ.SCH_VER_VARIANTS === 20250922);
  // DIALOG_EXPORT_OLDER_VERSION::updateVariantChoice
  assert.strictEqual(KJ.variantChoiceEnabled("KiCad 9.0", ["Lite"]), true);
  assert.strictEqual(KJ.variantChoiceEnabled("KiCad 10.0", ["Lite"]), false, "10.0 stores variants");
  assert.strictEqual(KJ.variantChoiceEnabled("KiCad 9.0", []), false);
});
test("For Older KiCad Version: the report dialog lists approximate, drop and blocking rows in KiCad's order", () => {
  const rep = { target: "KiCad 9.0", lossy: true, blocked: false, text: "", entries: [
    { bucket: "keep", feature: "Wires", detail: "", count: 12 }, { bucket: "drop", feature: "Net chains", detail: "", count: 1 },
    { bucket: "lower", feature: "Rounded rectangles", detail: "Written as polygons", count: 2 }] };
  assert.deepStrictEqual(KJ.reportRows(rep), [{ action: "Approximate", feature: "Rounded rectangles (2)", detail: "Written as polygons" }, { action: "Drop", feature: "Net chains", detail: "" }]);
});
test("For Older KiCad Version: the dry run, the report and the export go to the server's downgrade job", async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies[bodies.length - 1].dryRun) return { ok: true, status: 200, headers: { get: (k) => (k === "content-type" ? "application/json" : null) }, json: async () => ({ report: { target: "KiCad 9.0", entries: [], lossy: false, blocked: false, text: "t" } }) };
    return { ok: true, status: 200, headers: { get: (k) => (k === "content-type" ? "application/octet-stream" : 'attachment; filename="b.kicad_pcb"') }, blob: async () => new Blob(["(kicad_pcb)"]) };
  };
  const dry = await KJ.kicadJob("b", { job: "downgrade", target: "KiCad 9.0", dryRun: true });
  assert.strictEqual(dry.report.target, "KiCad 9.0");
  const real = await KJ.kicadJob("b", { job: "downgrade", target: "KiCad 9.0", dryRun: false });
  assert.strictEqual(real.name, "b.kicad_pcb");
  globalThis.fetch = async () => ({ ok: false, status: 422, statusText: "", headers: { get: () => "application/json" }, text: async () => JSON.stringify({ error: "job_failed", message: "Unknown target version 'KiCad 3'." }) });
  assert.strictEqual((await KJ.kicadJob("b", { job: "downgrade" })).error, "Unknown target version 'KiCad 3'.");
  const ma = src("editor", "menu-actions.ts");
  for (const id of ["exportForOlderVersion", "exportSpecctraDSN", "exportGenCAD", "exportIDF"]) assert.ok(new RegExp(`\\b${id}: \\(\\) =>`).test(ma), id + " has a handler");
});

// ---------------------------------------------------------------- GenCAD, IDF (pcb-frame-chrome#21)
test("GenCAD: DIALOG_GENCAD_EXPORT_OPTIONS's options and labels, in GENCAD_EXPORT_OPT order", () => {
  const cpp = fs.readFileSync(path.join(repo, "pcbnew", "dialogs", "dialog_gencad_export_options.cpp"), "utf8");
  const labels = [...cpp.matchAll(/\{ (\w+),\s+_\( "([^"]+)" \) \}/g)].map((m) => m[2]);
  assert.deepStrictEqual(KJ.GENCAD_OPTIONS.map((o) => o[1]), labels);
});
test("IDFv3: the project's board.idf_export settings and the CLI options they make (origin in the output units)", () => {
  const s = KJ.idfSettings({});
  assert.deepStrictEqual(s, { units: 0, originMode: 2, userOriginX: 0, userOriginY: 0, includeUnspecified: true, includeDNP: true, calculateHeightFromModels: true, partNumberField: "Value" });
  const s2 = KJ.idfSettings({ board: { idf_export: { units: 1, origin_mode: 3, user_origin_x: 25.4, user_origin_y: -2.54, include_dnp: false, part_number_field: "MPN" } } });
  const b = KJ.idfJobBody(s2);
  assert.strictEqual(b.units, "mils");
  assert.strictEqual(b.origin, "user");
  assert.ok(Math.abs(b.userOriginX - 1000) < 1e-6 && Math.abs(b.userOriginY + 100) < 1e-6);
  assert.strictEqual(b.noDnp, true);
  assert.strictEqual(b.noUnspecified, false);
  assert.strictEqual(b.partNumberField, "MPN");
  assert.strictEqual(KJ.idfJobBody(KJ.idfSettings({ board: { idf_export: { origin_mode: 0 } } })).origin, "drill");
  const doc = { items: new Map([["f", { kind: "footprint", node: globalThis.KiCadCanvas.parse('(footprint "R" (property "Reference" "R1") (property "Value" "1k") (property "MPN" "X"))') }]]) };
  assert.deepStrictEqual(KJ.idfFieldNames(doc), ["MPN", "Value"]);
});

// ---------------------------------------------------------------- sch-frame-chrome#15: Export > Symbols...
const SCH = (body) => globalThis.KiCadCanvas.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (uuid "root") (paper "A4")
 (lib_symbols (symbol "Device:R" (property "Reference" "R" (at 0 0 0)) (symbol "R_0_1" (rectangle (start -1 -2) (end 1 2))))
  (symbol "power:GND" (power) (property "Reference" "#PWR" (at 0 0 0)))
  (symbol "Device:C" (property "Reference" "C" (at 0 0 0)))
  (symbol "C_1" (property "Reference" "C" (at 0 0 0)) (property "Value" "C_1" (at 0 0 0))))
 ${body})`, "kicad_sch");
test("Export Symbols: SCH_SHEET_LIST::GetSymbols' symbols, one library symbol per LIB_ID in LIB_ID order, power only on request", () => {
  const a = SCH(`(symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "r1") (property "Reference" "R1" (at 0 0 0)))
   (symbol (lib_id "power:GND") (at 20 10 0) (unit 1) (uuid "p1") (property "Reference" "#PWR01" (at 0 0 0)))
   (symbol (lib_id "Device:C") (lib_name "C_1") (at 30 10 0) (unit 1) (uuid "c1") (property "Reference" "C1" (at 0 0 0)))
   (symbol (lib_id "Missing:X") (at 40 10 0) (unit 1) (uuid "x1") (property "Reference" "X1" (at 0 0 0)))`);
  const b = SCH(`(symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "r2") (property "Reference" "R2" (at 0 0 0)))
   (symbol (lib_id "Device:R") (at 10 20 0) (unit 1) (uuid "r3") (property "Reference" "#R3" (at 0 0 0)))`);
  // the same sheet file used twice: its symbols are listed once
  const sheets = [{ docId: "A", doc: a, instPath: "/root" }, { docId: "B", doc: b, instPath: "/root/s1" }, { docId: "B", doc: b, instPath: "/root/s2" }];
  const list = XS.collectExportSymbols(sheets, false);
  assert.deepStrictEqual(list.map((e) => e.libId), ["C_1", "Device:R"], "orphans, power and '#' symbols are left out; LIB_ID order (no nickname first)");
  assert.deepStrictEqual(list[1].uses, [{ docId: "A", id: "r1" }, { docId: "B", id: "r2" }]);
  assert.deepStrictEqual(list[0].name, "C_1");
  const all = XS.collectExportSymbols(sheets, true);
  assert.deepStrictEqual(all.map((e) => e.libId), ["C_1", "Device:R", "power:GND"]);
  assert.deepStrictEqual(all[1].uses.map((u) => u.id), ["r1", "r2", "r3"]);
  // saved under LIB_SYMBOL::GetName (the id's item name), flattened (the cache holds root symbols)
  const text = XS.exportedSymbolText(list[1]);
  assert.ok(/^\(symbol "R" /.test(text) && text.includes('(symbol "R_0_1"'), text);
  assert.ok(globalThis.KiCadCanvas.resolveLib(a, "Device:R")[1] === "Device:R", "the schematic's copy is not changed");
  assert.deepStrictEqual(XS.splitLibId("a:b:c"), { nick: "a", item: "b:c" });
  assert.ok(XS.compareLibIds("Z:a", "a:a") < 0, "wxString::Cmp is case-sensitive");
});
test("Export Symbols: \"Update schematic symbols\" relinks each symbol to the target library (SetLibId), its library symbol under the new id", () => {
  const K = globalThis.KiCadCanvas;
  const a = SCH(`(symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "r1") (property "Reference" "R1" (at 0 0 0)))
   (symbol (lib_id "Device:C") (lib_name "C_1") (at 30 10 0) (unit 1) (uuid "c1") (property "Reference" "C1" (at 0 0 0)))`);
  const list = XS.collectExportSymbols([{ docId: "A", doc: a, instPath: "/root" }], false);
  for (const e of list) for (const u of e.uses) K.applyChange(a, XS.relinkChange(a.items.get(u.id), e, "Mine"), 1e4);
  assert.strictEqual(K.str(K.kid(a.items.get("r1").node, "lib_id")[1]), "Mine:R");
  assert.ok(K.resolveLib(a, "Mine:R"), "the library symbol is cached under the new id");
  assert.strictEqual(K.str(K.kid(a.items.get("c1").node, "lib_id")[1]), "Mine:C_1");
  assert.strictEqual(K.str(K.kid(a.items.get("c1").node, "lib_name")[1]), "C_1", "a lib_name keeps keying the cache");
  assert.ok(K.resolveLib(a, "C_1"));
});
test("Export Symbols: SelectLibrary's list (pinned first, StrNumCmp), its checkboxes and New Library..., and the File > Export entry", () => {
  const rows = XS.libraryRows([{ name: "b10", description: "" }, { name: "b9", description: "x" }, { name: "Mine", description: "" }], new Set(["Mine"]), (x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: "base" }));
  assert.deepStrictEqual(rows, [["☆ Mine", ""], ["b9", "x"], ["b10", ""]]);
  assert.strictEqual(XS.selectedLibrary(rows[0]), "Mine");
  const ui = src("editor", "export-symbols.ts"), dlg = src("editor", "pcbdialogs", "ui.ts");
  assert.ok(ui.includes('"Include power symbols in export"') && ui.includes('"Update schematic symbols to link to exported symbols"') && ui.includes('"Export symbols to library:"'));
  assert.ok(ui.includes('label: "New Library..."') && ui.includes('"Update Library Identifiers"'));
  assert.ok(/Error saving symbol \$\{name\} to library '\$\{targetLib\}'\./.test(ui));
  assert.ok(/checks\?: \{ label: string; value: boolean \}\[\]/.test(dlg) && /for \(const \{ c, f \} of checks\) c\.value = f\.get\(\);/.test(dlg), "EDA_LIST_DIALOG::AddExtraCheckbox / GetExtraCheckboxValues");
  assert.ok(/exportSymbolsToLibrary: \(\) => \{ void exportSymbolsToLibrary\(\); \}/.test(src("editor", "menu-actions.ts")), "the menu entry has its handler");
  assert.ok(/exportSymbolsToLibrary: "sch"/.test(src("tables.ts")));
});

// ---------------------------------------------------------------- library-choosers#26
test("library-choosers#26: the symbol chooser offers a Datasheet column, filled from the server index's \"ds\"", () => {
  assert.ok(CH.availableColumns("symbol").includes("Datasheet"));
  assert.strictEqual(CH.columnText({ id: "Device:R", name: "R", datasheet: "https://x/r.pdf" }, "Datasheet", ""), "https://x/r.pdf");
  assert.deepStrictEqual(CH.shownColumns("symbol", ["Datasheet"]), ["Item", "Datasheet"]);
  const s = src("library", "sources.ts");
  assert.ok(/ds\?: string/.test(s) && /datasheet: s\.ds \|\| ""/.test(s), "the index row's ds becomes the item's datasheet");
});

// ---------------------------------------------------------------- sch-edit-clipboard#22
test("sch-edit-clipboard#22: Copy writes application/kicad as the browser's custom format; Paste prefers it", async () => {
  const t = src("editor", "tools.ts");
  assert.ok(/KICAD_CLIP_TYPE = "web application\/kicad"/.test(t));
  assert.ok(/CI\.supports && CI\.supports\(KICAD_CLIP_TYPE\)/.test(t), "written only where the browser takes custom formats");
  assert.ok(/const types: Record<string, Blob> = \{ \.\.\.custom, "text\/plain"/.test(t));
  assert.ok(/const k = await readKicadClipboard\(\); if \(k\) return k;/.test(t), "read: KiCad's format before the text");
  // the reader itself
  const fn = /export async function readKicadClipboard\(\): Promise<string> \{([\s\S]*?)\n\}/.exec(t)[1];
  const read = new Function("navigator", "KICAD_CLIP_TYPE", `return (async () => {${fn}})();`);
  const item = (types, text) => ({ types, getType: async () => ({ text: async () => text }) });
  assert.strictEqual(await read({ clipboard: { read: async () => [item(["text/plain"], "plain"), item(["text/plain", "web application/kicad"], "(kicad_sch)")] } }, "web application/kicad"), "(kicad_sch)");
  assert.strictEqual(await read({ clipboard: { read: async () => [item(["text/plain"], "plain")] } }, "web application/kicad"), "");
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
