// feat-common.test.js — the common frames and dialogs against KiCad: Page Settings' custom size limits (UNIT_BINDER::Validate with MIN_PAGE_SIZE_MILS / MAX_PAGE_SIZE_*_MILS) and the drawing
// sheet file kept in the project file (schematic / pcbnew page_layout_descr_file).
// Run: node server/static/tests/feat-common.test.js
"use strict";
const path = require("path"), assert = require("assert");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const WEB = path.join(__dirname, "..", "..", "web");
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [path.join(WEB, ...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 4).join("\n       ")); } }

const L = load(["dialogs", "logic.ts"]), W = load(["editor", "drawingsheet-model.ts"]);
const G = load(["dialogs", "gal-options.ts"]), M = load(["dialogs", "maintenance.ts"]), T = load(["dialogs", "color-themes.ts"]);

test("Page Settings: the custom size is 1000 mils at least, under 120000 mils (eeschema) / 48000 mils (pcbnew)", () => {
  assert.strictEqual(L.pageSizeError("Width", 25.4, true, "mm"), null);
  assert.match(L.pageSizeError("Width", 20, true, "mil"), /^Width must be at least 1000 mils\.$/);
  assert.match(L.pageSizeError("Height", 1300, false, "mm"), /^Height must be less than 1219\.2 mm\.$/);
  assert.strictEqual(L.pageSizeError("Height", 1300, true, "mm"), null, "the schematic allows up to 3048 mm");
  assert.match(L.pageSizeError("Height", 3100, true, "in"), /less than 120 in/);
});
test("drawing sheet file: read from the editor's key of the project file, resolved to a project document", () => {
  const pro = JSON.stringify({ schematic: { page_layout_descr_file: "sheets/my.kicad_wks" }, pcbnew: { page_layout_descr_file: "${KIPRJMOD}/board.kicad_wks" } });
  assert.strictEqual(W.drawingSheetName(pro, true), "sheets/my.kicad_wks");
  assert.strictEqual(W.drawingSheetName(pro, false), "${KIPRJMOD}/board.kicad_wks");
  assert.strictEqual(W.drawingSheetName("{}", true), ""); assert.strictEqual(W.drawingSheetName("not json", true), "");
  const docs = [{ docId: "p", docType: "kicad_pro", path: "proj/demo.kicad_pro" }, { docId: "a", docType: "worksheet", path: "proj/sheets/my.kicad_wks" }, { docId: "b", docType: "worksheet", path: "proj/board.kicad_wks" }, { docId: "s", docType: "kicad_sch", path: "proj/demo.kicad_sch" }];
  const ws = W.projectWorksheets(docs);
  assert.deepStrictEqual(ws.map((x) => x.rel), ["sheets/my.kicad_wks", "board.kicad_wks"]);
  assert.strictEqual(W.resolveWorksheet("sheets/my.kicad_wks", ws).docId, "a");
  assert.strictEqual(W.resolveWorksheet("${KIPRJMOD}/board.kicad_wks", ws).docId, "b");
  assert.strictEqual(W.resolveWorksheet("/home/me/proj/board.kicad_wks", ws).docId, "b", "an absolute path ending in a project file");
  assert.strictEqual(W.resolveWorksheet("", ws), null); assert.strictEqual(W.resolveWorksheet("other.kicad_wks", ws), null);
  assert.deepStrictEqual(W.wksKey(true), ["schematic", "page_layout_descr_file"]); assert.deepStrictEqual(W.wksKey(false), ["pcbnew", "page_layout_descr_file"]);
});

test("Display Options: PANEL_GAL_OPTIONS' defaults and ranges (app_settings.cpp, panel_gal_options.cpp)", () => {
  assert.deepStrictEqual(G.galDefaults(), { style: "dots", lineWidth: 1, minSpacing: 10, showMajor: true, crosshair: "small", alwaysShow: true });
  assert.strictEqual(G.GRID_THICKNESS_CHOICES.length, 20); assert.strictEqual(G.GRID_THICKNESS_CHOICES[0], 0.5); assert.strictEqual(G.GRID_THICKNESS_CHOICES[19], 10);
  const c = G.clampGal({ style: "bogus", lineWidth: 2.3, minSpacing: 900, showMajor: false, crosshair: "45", alwaysShow: false });
  assert.deepStrictEqual(c, { style: "dots", lineWidth: 2.5, minSpacing: 200, showMajor: false, crosshair: "45", alwaysShow: false });
  assert.strictEqual(G.clampGal({ style: "lines", lineWidth: NaN, minSpacing: 1 }).lineWidth, 1);
  assert.strictEqual(G.clampGal({ style: "lines", lineWidth: NaN, minSpacing: 1 }).minSpacing, 5);
});
test("Maintenance: dialog state and program settings are told apart; designs and hints are kept", () => {
  const keys = ["kd.geom.plot", "kd.state.find", "pd.state.track", "kui.prefs", "kui.v3d", "kc.drc.options", "kicad.fab.preset", "kicad-collab:lib-recent:sym", "kui.boardDocs", "kc.onboard.mini", "admin.range", "other"];
  assert.deepStrictEqual(M.dialogStateKeys(keys), ["kd.geom.plot", "kd.state.find", "pd.state.track"]);
  assert.deepStrictEqual(M.programSettingKeys(keys), ["kd.geom.plot", "kd.state.find", "pd.state.track", "kui.prefs", "kui.v3d", "kc.drc.options", "kicad.fab.preset", "kicad-collab:lib-recent:sym"]);
});

test("Colors: New Theme names (FOOTPRINT_NAME_VALIDATOR, Theme already exists!) and ids", () => {
  assert.strictEqual(T.themeNameError("Mine", ["KiCad Default"]), null);
  assert.strictEqual(T.themeNameError("kicad default", ["KiCad Default"]), "Theme already exists!");
  assert.match(T.themeNameError("a/b", []), /illegal character '\/'/);
  assert.match(T.themeNameError("  ", []), /required/);
  assert.strictEqual(T.userThemeId("My Theme", []), "user:my-theme");
  assert.strictEqual(T.userThemeId("My Theme", ["user:my-theme"]), "user:my-theme-2");
  const u = T.newUserTheme(" Night ", { bg: "#000000", wire: "#00FF00" }, []);
  assert.deepStrictEqual(u, { id: "user:night", name: "Night", colors: { bg: "#000000", wire: "#00FF00" } });
});
test("Colors: validateSave finds items drawn in the background colour (not the body fill)", () => {
  assert.deepStrictEqual(T.hiddenByBackground({ bg: "#F5F4EF", wire: "#f5f4ef", body: "#F5F4EF", bus: "#000084" }), ["wire"]);
  assert.deepStrictEqual(T.hiddenByBackground({ bg: "#F5F4EF", wire: "rgba(245,244,239,0.5)" }), []);
  assert.ok(T.sameColor("#0000ff", "rgb(0, 0, 255)"));
  assert.ok(T.isDarkBackground("#1C1D20")); assert.ok(!T.isDarkBackground("#F5F4EF"));
  assert.strictEqual(T.SCH_COLOR_ITEMS.length, 35); assert.ok(T.SCH_COLOR_ITEMS.some(([k, n]) => k === "bg" && n === "Background"));
});

console.log(`feat-common: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
