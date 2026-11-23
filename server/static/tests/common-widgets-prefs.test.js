// common-widgets-prefs.test.js — KiCad parity of the common widgets and Preferences: StringFromValue's precision,
// hotkey names (hotkeyNameList, KeyNameFromKeyCode / KeyCodeFromKeyName, the number pad), HOTKEY_STORE's conflict
// rule for contextual actions, ReadHotKeyConfig, the hotkey list's sorting, NUMERIC_EVALUATOR's variables and
// statements, and the Preferences pages (grids, colours, common settings, page settings, print defaults).
// Run: node server/static/tests/common-widgets-prefs.test.js
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");
/** One exported function of a module that needs a browser to load: its source, brace-matched, compiled on its own. */
function fn(rel, name, deps = {}) {
  const t = src(...rel), at = t.indexOf("export function " + name + "(");
  assert.ok(at >= 0, name + " in " + rel.join("/"));
  // past the parameter list, then past any braces of the return type (a "{" after ":", "|" or "&") to the body's "{"
  let i = t.indexOf("(", at), depth = 0;
  for (; i < t.length; i++) { if (t[i] === "(") depth++; else if (t[i] === ")" && --depth === 0) break; }
  for (i++; i < t.length; i++) {
    if (t[i] !== "{") continue;
    const prev = t.slice(0, i).trimEnd().slice(-1);
    if (!":|&".includes(prev)) break;
    for (let d = 0; i < t.length; i++) { if (t[i] === "{") d++; else if (t[i] === "}" && --d === 0) break; }
  }
  let j = i; for (; j < t.length; j++) { if (t[j] === "{") depth++; else if (t[j] === "}" && --depth === 0) break; }
  const code = esbuild.transformSync(t.slice(at, j + 1).replace(/^export /, ""), { loader: "ts" }).code;
  return new Function(...Object.keys(deps), code + "\nreturn " + name + ";")(...Object.values(deps));
}

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n       ")); } }

const N = load(["tools", "props", "numeric.ts"]);
const KEYS = load(["keys.ts"]);
const HK = load(["dialogs", "hotkeys-panel.ts"]);
const MS = load(["menuspec.ts"]);

// ---------------------------------------------------------------- 1. StringFromValue precision
test("lengths print with StringFromValue's precision: board mm to the nanometre, mils %.5f, inches %.8f", () => {
  assert.strictEqual(N.formatLength(0.00254, "mm"), "0.00254 mm");
  assert.strictEqual(N.formatLength(0.123456, "mm"), "0.123456 mm");
  assert.strictEqual(N.formatLength(0.0001, "mil"), "0.00394 mils");
  assert.strictEqual(N.formatLength(0.001, "in"), "0.00003937 in");
  assert.strictEqual(N.formatLength(1.27, "mil"), "50 mils");
  assert.strictEqual(N.formatLength(-0.0000001, "mm"), "0 mm", "below one nanometre is zero");
});
test("schematic lengths: mm to 100 nm, mils %.3f, inches %.6f", () => {
  assert.strictEqual(N.formatLength(0.00254, "mm", "sch"), "0.0025 mm");
  assert.strictEqual(N.formatLength(0.00254, "mil", "sch"), "0.098 mils", "rounded to the schematic's 100 nm first");
  assert.strictEqual(N.formatLength(1.2345678, "in", "sch"), "0.048606 in");
  assert.strictEqual(N.formatLength(0.0001, "mil", "sch"), "0.004 mils");   // one StringFromValue (shared/units.ts) for every length
});

// ---------------------------------------------------------------- 19. NUMERIC_EVALUATOR variables and statements
test("NUMERIC_EVALUATOR: variables, assignment and ';' statements", () => {
  assert.strictEqual(N.evalExpr("x = 2; x * 3", "mm"), 6);
  assert.strictEqual(N.evalExpr("a=1.5; b=2; a+b", "mm"), 3.5);
  assert.ok(isNaN(N.evalExpr("x = 2", "mm")), "an assignment has no value");
  assert.ok(isNaN(N.evalExpr("1;", "mm")), "a statement ended by ';' gives no result");
  assert.ok(isNaN(N.evalExpr("y + 1", "mm")), "an unknown variable is an error");
  assert.strictEqual(N.evalExpr("x = 10; x", "mil"), 0.254);
  assert.strictEqual(N.evalExpr("x = 1; x in", "mil"), 25.4, "a unit after a variable converts it");
  const vars = new Map(); N.evalExpr("w = 0.5; w", "mm", vars);
  assert.strictEqual(N.evalExpr("w * 2", "mm", vars), 1, "the field's evaluator keeps its variables");
  assert.strictEqual(N.evalExpr("2 + 3", "mm"), 5);
  assert.strictEqual(N.evalExpr("1in", "mm"), 25.4);
});

// ---------------------------------------------------------------- 2, 17, 23. hotkey names
test("Enter / Backspace hotkeys are KiCad's Return / Back: lookup aliases them and the list shows KiCad's names", () => {
  assert.strictEqual(MS.normKey("Return"), MS.normKey("Enter"));
  assert.strictEqual(MS.normKey("Ctrl+Back"), MS.normKey("Ctrl+Backspace"));
  assert.strictEqual(MS.normKey("Delete"), MS.normKey("Del"));
  assert.strictEqual(KEYS.keyName("Enter"), "Return");
  assert.strictEqual(KEYS.keyName("Shift+Backspace"), "Shift+Back");
  assert.strictEqual(HK.hotkeyText("Enter"), "Return");
});
test("KeyNameFromKeyCode's modifier order: Ctrl, Alt, Shift", () => {
  assert.strictEqual(KEYS.keyName("Shift+Alt+V"), "Alt+Shift+V");
  assert.strictEqual(KEYS.keyName("Ctrl+Shift+Alt+X"), "Ctrl+Alt+Shift+X");
  assert.strictEqual(HK.keyOfEvent({ key: "x", code: "KeyX", ctrlKey: true, metaKey: false, shiftKey: true, altKey: true }), "Ctrl+Alt+Shift+X");
  assert.strictEqual(HK.hotkeyText("Ctrl+"), "Ctrl+", "a modifier on its own");
  assert.strictEqual(KEYS.keyName("Num Pad +"), "Num Pad +");
  assert.strictEqual(KEYS.keyName("Ctrl++"), "Ctrl++");
});
test("hotkey capture: the number pad has its own names, lock keys are skipped, unnamed keys are not assigned", () => {
  const ev = (key, code, mods = {}) => ({ key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });
  assert.strictEqual(HK.keyOfEvent(ev("5", "Numpad5")), "Num Pad 5");
  assert.strictEqual(HK.keyOfEvent(ev("Enter", "NumpadEnter")), "Num Pad Enter");
  assert.strictEqual(HK.keyOfEvent(ev("+", "NumpadAdd")), "Num Pad +");
  assert.strictEqual(HK.keyOfEvent(ev("Enter", "Enter")), "Return");
  assert.strictEqual(HK.keyOfEvent(ev("Backspace", "Backspace")), "Back");
  assert.strictEqual(HK.keyOfEvent(ev("CapsLock", "CapsLock")), null);
  assert.strictEqual(HK.keyOfEvent(ev("NumLock", "NumLock")), null);
  assert.ok(!KEYS.keyNameExists(HK.keyOfEvent(ev("AudioVolumeUp", "AudioVolumeUp"))), "a media key has no name");
  assert.ok(KEYS.keyNameExists("Ctrl+Num Pad 5") && KEYS.keyNameExists("F24") && KEYS.keyNameExists("Shift+Return") && KEYS.keyNameExists("~"));
  assert.strictEqual(KEYS.numpadKey({ key: "ArrowUp", code: "Numpad8" }), null, "Num Lock off: the pad's arrows are the plain keys");
});
test("the editor matches a number pad key by its own name first (comboOf numpad)", () => {
  const t = src("domains", "pcb", "editor", "hotkeys.ts");
  assert.ok(t.includes("const pad = numpadKey(ev) ? comboOf(ev, true) : \"\";"));
  assert.ok(/if \(pad\) for \(const id of hotkeyOwners\(editorKind\(\), pad\)\)/.test(t));
});

// ---------------------------------------------------------------- 10. KeyCodeFromKeyName / ReadHotKeyConfig
test("KeyCodeFromKeyName: Cmd+ is Ctrl, named keys in any case, unknown names give no key, canonical order", () => {
  assert.strictEqual(KEYS.parseKeyName("Cmd+S"), "Ctrl+S");
  assert.strictEqual(KEYS.parseKeyName("Shift+Ctrl+pgup"), "Ctrl+Shift+PgUp");
  assert.strictEqual(KEYS.parseKeyName("num pad enter"), "Num Pad Enter");
  assert.strictEqual(KEYS.parseKeyName("Win+A"), "Win+A");
  assert.strictEqual(KEYS.parseKeyName(""), "");
  assert.strictEqual(KEYS.parseKeyName("Bogus"), null);
  assert.strictEqual(KEYS.parseKeyName("cmd+x"), null, "the modifier prefixes are matched as written");
  const m = HK.parseHotkeyFile("pcbnew.A.x\tCmd+X\tbogus\r\npcbnew.A.y\t\tF5\n");
  assert.deepStrictEqual(m.get("pcbnew.A.x"), ["Ctrl+X", ""]);
  assert.deepStrictEqual(m.get("pcbnew.A.y"), ["F5", ""], "wxTOKEN_STRTOK drops the empty token");
  const t = src("domains", "pcb", "dialogs", "hotkeys-panel.ts");
  assert.ok(t.includes("messageBox(\"Error\", `The imported file assigned reserved hotkeys (${"));
  assert.ok(t.includes("These assignments were ignored."));
});

// ---------------------------------------------------------------- 9. CheckKeyConflicts' context exception
test("CheckKeyConflicts: two contextual actions of different tools share a key, the platform commands count", () => {
  const e = (name, toolName, key, ctx, section = "PCB Editor") => ({ name, section, label: name, tip: "", key, alt: "", origKey: key, origAlt: "", defKey: key, defAlt: "", toolName, ctx });
  const a = e("A", "pcbnew.InteractiveRouter.a", "X", true), b = e("B", "pcbnew.InteractiveDrawing.b", "", true);
  const c = e("C", "pcbnew.InteractiveRouter.c", "", true), d = e("D", "pcbnew.Control.d", "", false);
  const secs = [{ name: "Common", rows: HK.PLATFORM_COMMANDS() }, { name: "PCB Editor", rows: [a, b, c, d] }];
  assert.strictEqual(HK.keyConflict(secs, b, "X"), null, "different tools, both contextual");
  assert.strictEqual(HK.keyConflict(secs, c, "X"), a, "the same tool");
  assert.strictEqual(HK.keyConflict(secs, d, "X"), a, "one is global");
  assert.strictEqual(HK.keyConflict(secs, d, "Ctrl+Q").label, "Quit", "a platform command");
  assert.strictEqual(HK.toolNameOf("pcbnew.InteractiveRouter.a"), "pcbnew.InteractiveRouter");
  const spec = require(webPath("domains", "pcb", "generated", "kicad-menu-spec.json"));
  assert.ok(Object.values(spec.actions).some((x) => x.ctx === 1), "the action table carries AS_CONTEXT");
});

// ---------------------------------------------------------------- 18, 24. hotkey list
test("the hotkey list sorts each section by a column, both ways; the filter is not trimmed", () => {
  const e = (label, key, tip = "") => ({ name: label, section: "S", label, tip, key, alt: "", origKey: key, origAlt: "", defKey: key, defAlt: "", toolName: label });
  const rows = [e("b", "Z"), e("a", "Y"), e("c", "X")];
  assert.deepStrictEqual(HK.sortRows(rows, 0, true).map((r) => r.label), ["a", "b", "c"]);
  assert.deepStrictEqual(HK.sortRows(rows, 0, false).map((r) => r.label), ["c", "b", "a"]);
  assert.deepStrictEqual(HK.sortRows(rows, 1, true).map((r) => r.label), ["c", "a", "b"]);
  assert.deepStrictEqual(HK.sortRows(rows, -1, true).map((r) => r.label), ["b", "a", "c"]);
  assert.ok(!HK.filterMatches(e("Route", ""), " route"), "HOTKEY_FILTER does not trim");
  const t = src("domains", "pcb", "dialogs", "hotkeys-panel.ts");
  assert.ok(!t.includes("if (!e.name) return;   // a gesture"), "pseudo rows get the context menu");
  assert.ok(t.includes("promptForKey(commandText(e), "), "the prompt shows the row text verbatim");
  assert.ok(t.includes("collapsed.clear(); draw();"), "a new filter expands every section");
});

// ---------------------------------------------------------------- 5. info bar severity and timing
test("the info bar keeps a message until closed (ShowMessage), times one out (ShowMessageFor) and shows its icon", () => {
  const ov = src("components", "Overlays.tsx");
  assert.ok(/export function InfoBarIcon/.test(ov));
  assert.ok(/ms > 0/.test(ov), "no timer for a persistent message");
  const u = src("editor", "util.ts");
  assert.ok(/severity: "info" \| "warning" \| "error" = "info"|severity = "info"/.test(u));
  assert.ok(/No datasheet defined\.", 8000, undefined, "error"/.test(src("editor", "fpedit.ts")), "ShowInfoBarError: 8 s, error icon");
});

// ---------------------------------------------------------------- 6, 20, 21, 22. Page Settings
test("Page Settings: a standard size keeps the custom size; a User page takes its orientation from its size", () => {
  const PAPER_FORMATS = [{ type: "A5", w: 210, h: 148 }, { type: "A4", w: 297, h: 210 }, { type: "A3", w: 420, h: 297 }];
  const layoutSize = fn(["dialogs", "page-settings.ts"], "layoutSize", { PAPER_FORMATS });
  assert.deepStrictEqual(layoutSize("A4", false, [431.8, 279.4]), { w: 297, h: 210, portrait: false });
  assert.deepStrictEqual(layoutSize("A4", true, [431.8, 279.4]), { w: 210, h: 297, portrait: true });
  assert.deepStrictEqual(layoutSize("User", false, [100, 200]), { w: 100, h: 200, portrait: true }, "a tall custom page is portrait");
  assert.deepStrictEqual(layoutSize("User", true, [300, 200]), { w: 300, h: 200, portrait: false });
  const t = src("dialogs", "page-settings.ts");
  assert.ok(t.includes("const CUSTOM_SIZE: [number, number] = [431.8, 279.4];"), "PAGE_INFO's 17000 x 11000 mils");
  assert.ok(t.includes("Error loading drawing sheet '"), "the drawing sheet error");
  assert.ok(!t.includes("Page settings updated"), "no extra toast");
});

// ---------------------------------------------------------------- 7, 35. printing
test("print defaults are APP_SETTINGS' (monochrome, no frame, no background, 1:1) and the custom scale warns", () => {
  const t = src("editor", "print.ts");
  assert.ok(t.includes("const PCB_DEFAULTS: PcbPrint = { color: false, frame: false, background: false,"));
  assert.ok(t.includes("const SCH_DEFAULTS: SchPrint = { frame: false, color: false, background: false,"));
  const customScale = fn(["editor", "print.ts"], "customScale");
  assert.deepStrictEqual(customScale("2.5"), { scale: 2.5, message: "" });
  assert.deepStrictEqual(customScale("abc"), { scale: 1, message: "Warning: custom scale is not a number." });
  assert.deepStrictEqual(customScale("500"), { scale: 100, message: "Warning: custom scale is too large.\nIt will be clamped to 100.000000." });
  assert.deepStrictEqual(customScale("0.001"), { scale: 0.01, message: "Warning: custom scale is too small.\nIt will be clamped to 0.010000." });
});

// ---------------------------------------------------------------- 8, 11, 12, 25, 26, 27, 28, 34, 37. Preferences pages
test("Preferences: grid range message, dimming percent, grid list details, colours saved at once, no toast", () => {
  const gridRangeMessage = fn(["dialogs", "preferences.ts"], "gridRangeMessage", { scaleOf: (ed) => (ed === "sch" ? "sch" : "pcb"), formatLength: N.formatLength });
  assert.strictEqual(gridRangeMessage("X", 0, "mm", "pcb"), "X must be at least 0.001 mm.");
  assert.strictEqual(gridRangeMessage("X", 2000, "mm", "pcb"), "X must be less than 1000 mm.");
  assert.strictEqual(gridRangeMessage("X", 1, "mm", "pcb"), "");
  const dimmingText = fn(["dialogs", "preferences.ts"], "dimmingText"), dimmingFactor = fn(["dialogs", "preferences.ts"], "dimmingFactor");
  assert.strictEqual(dimmingText(0.8), "80");
  assert.strictEqual(dimmingFactor("65"), 0.65);
  const t = src("dialogs", "preferences.ts");
  assert.ok(!t.includes("Preferences saved"), "37: no toast");
  assert.ok(t.includes("resetUserThemeColors(u)"), "8: Reset resets the current theme's colours");
  assert.ok(t.includes("saveUserSchTheme(u)"), "34: a colour change saves the theme");
  assert.ok(/"---"/.test(t), "34: the separator before New Theme...");
  assert.ok(/menuMeta\("gridFast1"\)|gridFast1/.test(t), "11: the fast grid hotkeys come from the action table");
});
test("29: the properties grid prints angles with %g", () => {
  const fmtG = fn(["editor", "panels", "propgrid.ts"], "fmtG");
  assert.strictEqual(fmtG(90), "90");
  assert.strictEqual(fmtG(45.5), "45.5");
  assert.strictEqual(fmtG(12.3456789), "12.3457");
  assert.strictEqual(fmtG(0.00001), "1e-05");
});

// ---------------------------------------------------------------- 30, 31. properties grid editing
test("30, 31: the mixed-value editor opens on INDETERMINATE_STATE; Enter / Down skip disabled rows, not read-only ones", () => {
  const NAV = load(["components", "panes", "prop-nav.ts"]);
  const cells = [{ readOnly: false }, { readOnly: true }, { readOnly: true, disabled: true }, { readOnly: false }];
  assert.strictEqual(NAV.navTarget(cells, 0, "next"), 1, "a read-only row is selected");
  assert.strictEqual(NAV.navTarget(cells, 1, "next"), 3, "a disabled one is passed over");
  assert.strictEqual(NAV.navTarget(cells, 3, "prev"), 1);
  assert.strictEqual(NAV.navTarget(cells, 3, "next"), 3, "the last row stays");
  const p = src("components", "panes", "Properties.tsx");
  assert.ok(p.includes('const INDETERMINATE = "-- mixed values --";'));
  assert.ok(p.includes("(row.mixed && text === INDETERMINATE)"), "the untouched text commits nothing");
});

// ---------------------------------------------------------------- 32, 33. colour swatch and picker
test("32: the swatch checkerboard follows its background; 33: the picker's tab is kept", () => {
  const SW = load(["components", "colorswatch.ts"]);
  assert.ok(SW.checkerboard({ r: 1, g: 1, b: 1, a: 1 }).includes("rgb(217,217,217) 0 25%, rgb(255,255,255)"), "light: background and Darkened( 0.15 )");
  assert.ok(SW.checkerboard({ r: 0, g: 0, b: 0, a: 1 }).includes("rgb(0,0,0) 0 25%, rgb(38,38,38)"), "dark: black and Brightened( 0.15 )");
  assert.ok(SW.swatchBackground(null, undefined, { r: 0.1, g: 0.1, b: 0.1, a: 1 }).includes("rgb(38,38,38)"), "UNSPECIFIED on a dark window");
  assert.ok(SW.swatchBackground({ r: 1, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1, a: 1 }).includes("rgb(217,217,217)"));
  assert.strictEqual(SW.swatchBackground({ r: 1, g: 0, b: 0, a: 1 }), "rgba(255,0,0,1)");
  const t = src("components", "colorswatch.ts");
  assert.ok(/\} else el\.addEventListener\("click"[^\n]*\n[^\n]*wxEVT_MIDDLE_DOWN[^\n]*\n[^\n]*\n\s*el\.addEventListener\("auxclick"/.test(t), "middle click in every mode");
  assert.ok(src("editor", "pcbdialogs", "color-picker.ts").includes("localStorage.setItem(TAB_KEY"));
});

// ---------------------------------------------------------------- 36. WX_GRID row buttons
test("36: Delete removes every selected row and goes to the row above the first", () => {
  const UI = load(["editor", "pcbdialogs", "ui.ts"]);
  assert.deepStrictEqual(UI.deleteRowsPlan([2, 3], 3, 5), { rows: [2, 3], next: 1 });
  assert.deepStrictEqual(UI.deleteRowsPlan([], 0, 3), { rows: [0], next: 0 });
  assert.deepStrictEqual(UI.deleteRowsPlan([], 1, 3), { rows: [1], next: 0 });
  assert.deepStrictEqual(UI.deleteRowsPlan([0], 0, 1), { rows: [0], next: -1 });
  assert.deepStrictEqual(UI.deleteRowsPlan([], -1, 3), { rows: [], next: -1 });
  assert.ok(/commitPendingEdit\(g\); const rows = g\.rows\(\); rows\.push/.test(src("editor", "pcbdialogs", "ui.ts")), "Add commits the open editor first");
});

// ---------------------------------------------------------------- 16. Configure Paths
test("16: Configure Paths edits the user's variables with DIALOG_CONFIGURE_PATHS' checks", () => {
  const envVarNameText = fn(["dialogs", "configure-paths.ts"], "envVarNameText");
  const envVarCellError = fn(["dialogs", "configure-paths.ts"], "envVarCellError");
  const envVarsFromRows = fn(["dialogs", "configure-paths.ts"], "envVarsFromRows");
  assert.strictEqual(envVarNameText("my-lib_2"), "MYLIB_2");
  assert.strictEqual(envVarNameText("3D_DIR"), "D_DIR", "no digit first");
  assert.strictEqual(envVarCellError("name", "  "), "Environment variable name cannot be empty.");
  assert.strictEqual(envVarCellError("path", ""), "Environment variable path cannot be empty.");
  assert.strictEqual(envVarCellError("name", "KIPRJMOD"), "The name KIPRJMOD is reserved, and cannot be used.");
  assert.strictEqual(envVarCellError("path", "/x"), null);
  assert.deepStrictEqual(envVarsFromRows([{ name: "A", path: "/a" }, { name: "", path: "" }, { name: "S", path: "srv", external: true }, { name: "A", path: "/b" }]), { vars: [{ name: "A", path: "/b" }] });
  assert.deepStrictEqual(envVarsFromRows([{ name: "", path: "/a" }]), { error: "Environment variable name cannot be empty.", row: 0, col: "name" });
  assert.deepStrictEqual(envVarsFromRows([{ name: "B", path: " " }]), { error: "Environment variable path cannot be empty.", row: 0, col: "path" });
  assert.ok(src("dialogs", "lib-tables.ts").includes("for (const v of userEnvVars())"), "the user's variables are substituted");
});

// ---------------------------------------------------------------- 14. Preferences > Common
test("14: the Common page's browser options are stored and applied", () => {
  const t = src("dialogs", "prefs.ts");
  assert.ok(t.includes("useCustomCursors: true, showScrollbars: false, hotkeyFeedback: true, gridStriping: false, menuIcons: !IS_MAC"));
  assert.ok(t.includes("setHotkeyFeedback(p.common.hotkeyFeedback !== false)") && t.includes("setUseCustomCursors(p.common.useCustomCursors !== false)"));
  assert.ok(src("editor", "hotkey-popup.ts").includes('if (typeof document === "undefined" || !feedback) return;'));
  // CURSOR_STORE::GetCursor without custom cursors: GetStockCursor (MOVING is wxCURSOR_SIZING only where IsStockCursorOk), else the arrow
  assert.ok(src("editor", "cursors.ts").includes('return custom ? `url("${img[0]}") ${img[1]} ${img[2]}, default` : "default";'));
  assert.ok(src("components", "MenuBar.tsx").includes('const MENU_ICON = "flex [.k-no-menu-icons_&]:hidden";'));
  const pg = src("dialogs", "preferences.ts");
  for (const l of ["Show icons in menus", "Show popup indicator when toggling settings with hotkeys", "Use alternating row colors in tables", "Disable custom cursors"]) assert.ok(pg.includes(`"${l}"`), l);
});

// ---------------------------------------------------------------- 4. search pane keys
test("4: the search list keeps only its own navigation keys", () => {
  const t = src("components", "panes", "Search.tsx");
  assert.ok(/Home|End|PageUp|PageDown/.test(t));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
