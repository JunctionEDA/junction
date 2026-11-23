// board-colour-themes.test.js — the board colour themes (COLOR_SETTINGS' "board" namespace): KiCad Default and KiCad
// Classic, the live palette the board canvas paints in (PCB_RENDER_SETTINGS::LoadColors), the PCB / Footprint Editor
// Colors pages' swatch lists, New Theme..., the theme store, the preview board, and a highlighted net chain painted in
// its colour after Update PCB (BOARD::SetNetChainColor, PCB_PAINTER).
// Run: cd server/static && node tests/board-colour-themes.test.js   (needs npm run build:canvas)
"use strict";
const path = require("path"), fs = require("fs"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");
/** One exported function of a module that needs a browser to load, compiled on its own with `deps` in scope. */
function fn(rel, name, deps = {}) {
  const t = src(...rel), at = t.indexOf("export function " + name + "(");
  assert.ok(at >= 0, name + " in " + rel.join("/"));
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
function test(name, f) { try { f(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 6).join("\n       ")); } }

/** A css colour as [r, g, b, a] (0-255, alpha 0-1). */
function rgbaOf(c) {
  c = String(c).trim();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) / 255 : 1]; }
  m = /^rgba?\(([^)]*)\)$/i.exec(c); if (!m) return null;
  const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}
const sameRgb = (a, b) => { const x = rgbaOf(a), y = rgbaOf(b); return !!x && !!y && x[0] === y[0] && x[1] === y[1] && x[2] === y[2]; };
function rec(w, h) {
  const ops = []; let stroke = "", fill = "", alpha = 1, lw = 1;
  const ctx = { canvas: { width: w, height: h }, ops, font: "", textBaseline: "", lineJoin: "", textAlign: "", lineCap: "" };
  for (const n of ["beginPath", "moveTo", "lineTo", "closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "clearRect", "clip", "bezierCurveTo", "quadraticCurveTo", "ellipse", "setTransform", "setLineDash"]) ctx[n] = () => {};
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = (...args) => ops.push({ op: n, stroke, fill, alpha, lw, args });
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +v; }, get: () => alpha });
  Object.defineProperty(ctx, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  ctx.measureText = (t) => ({ width: t.length * 0.7 });
  return ctx;
}
const HEAD = '(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)) (net 0 "") (net 1 "A") (net 2 "B") ';
const V = { ppm: 40, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
const draw = (doc, opts) => { const c = rec(1000, 800); K.render(doc, c, V, Object.assign({ frame: false }, opts)); return c.ops; };

const CT = load(["dialogs", "color-themes.ts"]);

// ---------------------------------------------------------------- the built-in themes
test("KiCad Default's board namespace: the GAL colours of builtin_color_themes.h and every layer", () => {
  const D = K.boardThemeColors("default");
  assert.strictEqual(D.background, "#001023"); assert.strictEqual(D.cursor, "#FFFFFF"); assert.strictEqual(D.worksheet, "#C872AB");
  assert.strictEqual(D.via_hole, "#E3B72E"); assert.strictEqual(D.plated_hole, "#1AC4D2"); assert.strictEqual(D.grid_axes, "#C2C2C2");
  assert.ok(sameRgb(D["F.Cu"], K.defaultPcbColor("F.Cu")));
  for (const l of ["F.Cu", "In1.Cu", "In30.Cu", "B.Cu", "F.SilkS", "Edge.Cuts", "User.45"]) assert.ok(D[l], l);
  assert.strictEqual(K.BOARD_THEME_LAYERS[0], "F.Cu"); assert.strictEqual(K.BOARD_THEME_LAYERS[31], "B.Cu");
});
test("KiCad Classic: s_classicTheme's palette (black background, dark red drawing sheet, red F.Cu)", () => {
  const C = K.boardThemeColors("classic");
  assert.strictEqual(C.background, "#000000"); assert.strictEqual(C.worksheet, "#480000"); assert.strictEqual(C["F.Cu"], "#840000");
  assert.strictEqual(C.grid_axes, "#000084"); assert.strictEqual(C.anchor, "#000084");
  // a theme the canvas has no built-in palette for answers KiCad Default's (COLOR_SETTINGS::GetDefaultColor)
  assert.deepStrictEqual(K.boardThemeColors("dark"), K.boardThemeColors("default"));
});

// ---------------------------------------------------------------- the live palette
test("setBoardColors: the canvas paints the live theme (background, layers), and reports no change for the same palette", () => {
  const D = K.boardThemeColors("default");
  try {
    assert.strictEqual(K.setBoardColors(Object.assign({}, D, { background: "#112233", "F.Cu": "#00FF00" })), true);
    assert.strictEqual(K.setBoardColors(Object.assign({}, D, { background: "#112233", "F.Cu": "#00FF00" })), false, "the same palette again");
    assert.strictEqual(K.PCB_BG, "#112233"); assert.strictEqual(K.boardColor("background"), "#112233");
    assert.ok(sameRgb(K.pcbColor("F.Cu"), "#00FF00")); assert.ok(sameRgb(K.defaultPcbColor("F.Cu"), D["F.Cu"]), "the default stays KiCad Default's");
    const doc = K.parseDoc(HEAD + '(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1")))');
    const ops = draw(doc, {});
    assert.ok(ops.some((o) => o.op === "fillRect" && sameRgb(o.fill, "#112233")), "the background in the theme's colour");
    assert.ok(ops.some((o) => o.op === "stroke" && sameRgb(o.stroke, "#00FF00")), "the track in the theme's F.Cu colour");
    assert.ok(!ops.some((o) => o.op === "stroke" && sameRgb(o.stroke, D["F.Cu"])), "nothing in KiCad Default's F.Cu");
  } finally { K.setBoardColors(null); }
  assert.strictEqual(K.PCB_BG, "#001023");
});
test("PCB_RENDER_SETTINGS::LoadColors: a board layer's alpha is at least 0.2", () => {
  try { K.setBoardColors(Object.assign({}, K.boardThemeColors("default"), { "F.Cu": "rgba(10,20,30,0.05)" })); assert.ok(Math.abs(rgbaOf(K.pcbColor("F.Cu"))[3] - 0.2) < 1e-6); }
  finally { K.setBoardColors(null); }
});
test("via holes and non-plated holes follow the theme's via_hole / plated_hole", () => {
  const doc = K.parseDoc(HEAD + '(via (at 0 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v")) (footprint "M" (layer "F.Cu") (uuid "fp") (at 3 0) (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask") (uuid "np"))))');
  try {
    K.setBoardColors(Object.assign({}, K.boardThemeColors("default"), { via_hole: "#123456", plated_hole: "#654321" }));
    const ops = draw(doc, {});
    assert.ok(ops.some((o) => (o.op === "fill" && sameRgb(o.fill, "#123456"))), "the via hole");
    assert.ok(ops.some((o) => (o.op === "fill" && sameRgb(o.fill, "#654321")) || (o.op === "stroke" && sameRgb(o.stroke, "#654321"))), "the NPTH");
  } finally { K.setBoardColors(null); }
});
test("exports stay in KiCad Default: withBoardColors draws in a palette and puts the live one back", () => {
  try {
    K.setBoardColors(Object.assign({}, K.boardThemeColors("default"), { background: "#223344" }));
    const inside = K.withBoardColors(K.boardThemeColors("classic"), () => K.boardColor("background"));
    assert.strictEqual(inside, "#000000"); assert.strictEqual(K.boardColor("background"), "#223344");
    assert.strictEqual(K.withBoardColors(null, () => K.boardColor("background")), "#001023", "null is KiCad Default (renderPng's)");
  } finally { K.setBoardColors(null); }
});

// ---------------------------------------------------------------- the Colors pages
test("PANEL_PCBNEW_COLOR_SETTINGS::createSwatches: copper F.Cu..B.Cu, TechAndUserUIOrder, then the GAL layers by name", () => {
  const items = CT.pcbColorItems((l) => (l === "In1.Cu" ? "GND plane" : null));
  const keys = items.map(([k]) => k);
  assert.deepStrictEqual(keys.slice(0, 3), ["F.Cu", "In1.Cu", "In2.Cu"]); assert.strictEqual(keys[31], "B.Cu");
  assert.deepStrictEqual(keys.slice(32, 36), ["F.Adhes", "B.Adhes", "F.Paste", "B.Paste"]);
  assert.strictEqual(items[1][1], "GND plane", "BOARD::GetLayerName"); assert.strictEqual(items.find(([k]) => k === "F.SilkS")[1], "F.Silkscreen");
  const gal = items.slice(32 + 18 + 45).map(([, l]) => l);
  assert.strictEqual(gal[0], "Anchors"); assert.deepStrictEqual(gal.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), gal, "sorted by LayerName()");
  assert.ok(gal.includes("Background") && gal.includes("Drawing sheet") && gal.includes("Track net names"));
});
test("PANEL_FP_EDITOR_COLOR_SETTINGS: F.Cu, Internal Layers, B.Cu, then the GAL layers the theme gives a colour", () => {
  const items = CT.fpColorItems(K.boardThemeColors("default"));
  assert.deepStrictEqual(items.slice(0, 3), [["F.Cu", "F.Cu"], ["In1.Cu", "Internal Layers"], ["B.Cu", "B.Cu"]]);
  assert.ok(!items.some(([k]) => k === "select_overlay"), "UNSPECIFIED in KiCad Default: no swatch");
  assert.ok(!items.some(([k]) => k === "via_hole" || k === "pad_plated_hole"), "the via and pad hole layers are left out");
  assert.ok(items.some(([k]) => k === "points") && items.some(([k]) => k === "via_stitching"));
  assert.ok(items.some(([k]) => k === "select_overlay") === false && CT.fpColorItems(K.boardThemeColors("classic")).some(([k]) => k === "select_overlay"), "Classic has one");
});
test("New Theme...: the page's swatches copied from the theme on show, a fresh id, no select_overlay stored", () => {
  const C = K.boardThemeColors("classic");
  const u = CT.newUserBoardTheme("  Mine ", ["F.Cu", "background", "select_overlay"], C, ["default", "classic", "dark"]);
  assert.strictEqual(u.name, "Mine"); assert.ok(u.id && !["default", "classic", "dark"].includes(u.id));
  assert.deepStrictEqual(u.board, { "F.Cu": "#840000", background: "#000000" }); assert.deepStrictEqual(u.colors, {});
  assert.strictEqual(CT.themeNameError("KiCad Default", ["KiCad Default"]) !== "", true, "Theme already exists!");
});

// ---------------------------------------------------------------- the theme store (dialogs/prefs.ts)
test("the frame's theme: PCBNEW_SETTINGS / FOOTPRINT_EDITOR_SETTINGS color_theme, KiCad Default when it is gone", () => {
  const schThemeList = (p) => [["default", "KiCad Default"], ["classic", "KiCad Classic"], ["dark", "Dark"], ...p.schColors.user.map((u) => [u.id, u.name])];
  const boardThemeId = fn(["dialogs", "prefs.ts"], "boardThemeId", { schThemeList });
  const isReadOnlyTheme = fn(["dialogs", "prefs.ts"], "isReadOnlyTheme");
  const p = { schColors: { user: [{ id: "user:mine", name: "Mine", colors: {}, board: { background: "#101010" } }] }, pcbColors: { theme: "user:mine" }, fpColors: { theme: "user:gone" } };
  assert.strictEqual(boardThemeId(p, false), "user:mine"); assert.strictEqual(boardThemeId(p, true), "default");
  assert.strictEqual(isReadOnlyTheme(p, "classic"), true); assert.strictEqual(isReadOnlyTheme(p, "user:mine"), false);
  const boardDefaults = () => K.boardThemeColors("default");
  const savedBoardColors = fn(["dialogs", "prefs.ts"], "savedBoardColors", { boardDefaults, KiCadCanvas: K });
  const s = savedBoardColors(p, "user:mine");
  assert.strictEqual(s.background, "#101010"); assert.strictEqual(s.worksheet, "#C872AB", "KiCad Default's for a key it leaves out");
  assert.strictEqual(rgbaOf(s.select_overlay)[3], 0, "no board.select_overlay is ever stored");
  assert.strictEqual(savedBoardColors(p, "classic").background, "#000000");
});
test("the board namespace a user theme keeps: no select_overlay (COLOR_SETTINGS stores none)", () => {
  assert.deepStrictEqual(CT.storableBoardColors({ a: "#1", select_overlay: "#2" }), { a: "#1" });
  assert.strictEqual(CT.isUnspecified("rgba(0,0,0,0)"), true); assert.strictEqual(CT.isUnspecified("#000000"), false);
});

// ---------------------------------------------------------------- the preview board
test("createPreviewItems: g_previewBoard on a 6000 x 5000 mil page titled Color Preview; zoomFitPreview at scale / 1.1", () => {
  const { PREVIEW_BOARD } = load(["dialogs", "color-preview-board.ts"]);
  const colorPreviewDoc = fn(["dialogs", "preferences.ts"], "colorPreviewDoc", { KiCadCanvas: K, PREVIEW_BOARD, MIL: 0.0254 });
  const colorPreviewFit = fn(["dialogs", "preferences.ts"], "colorPreviewFit");
  const d = colorPreviewDoc();
  assert.ok(d.items.size > 20, "the preview board's items"); assert.ok(Math.abs(d.page[0] - 152.4) < 1e-9 && Math.abs(d.page[1] - 127) < 1e-9);
  assert.strictEqual(d.titleBlock.title, "Color Preview"); assert.ok(d.titleBlock.date);
  const b = d.bbox, [ppm, cx, cy] = colorPreviewFit(d, 400, 300);
  assert.ok(Math.abs(ppm - Math.min(400 / (b[2] - b[0]), 300 / (b[3] - b[1])) / 1.1) < 1e-9);
  assert.ok(Math.abs(cx - (b[0] + b[2]) / 2) < 1e-9 && Math.abs(cy - (b[1] + b[3]) / 2) < 1e-9, "centred on the board");
  // drawn under the theme on show: its background
  const ops = []; const c = rec(400, 300);
  K.withBoardColors(K.boardThemeColors("classic"), () => K.render(d, c, { ppm, zoom: 1, panX: 200, panY: 150, x0: cx, y0: cy, dpr: 1 }, { frame: true }));
  assert.ok(c.ops.some((o) => o.op === "fillRect" && sameRgb(o.fill, "#000000")), "KiCad Classic's background");
  assert.ok(c.ops.some((o) => sameRgb(o.stroke, "#480000") || sameRgb(o.fill, "#480000")), "KiCad Classic's drawing sheet");
  void ops;
});
test("the Colors pages sit after Editing Options in both board editors", () => {
  const t = src("dialogs", "preferences.ts");
  const fp = t.indexOf('{ label: "Footprint Editor", pages: ['), pcb = t.indexOf('{ label: "PCB Editor", pages: [');
  const fpCol = t.indexOf("boardColorsPage(pg, true)"), pcbCol = t.indexOf("boardColorsPage(pg, false)");
  assert.ok(fp < fpCol && fpCol < pcb, "Footprint Editor > Colors"); assert.ok(pcb < pcbCol, "PCB Editor > Colors");
  assert.ok(t.lastIndexOf('label: "Editing Options"', fpCol) > fp && t.lastIndexOf('label: "Editing Options"', pcbCol) > pcb);
  assert.ok(t.indexOf('label: "Action Plugins"', pcbCol) > pcbCol);
});

// ---------------------------------------------------------------- net chains
test("Update PCB: SetNetChainColor from the netlist's #RRGGBBAA (COLOR4D::SetFromHexString)", () => {
  const hexColorCss = fn(["editor", "netchains.ts"], "hexColorCss");
  assert.deepStrictEqual(rgbaOf(hexColorCss("#FF000080")), [255, 0, 0, +(128 / 255).toFixed(4)]);
  assert.deepStrictEqual(rgbaOf(hexColorCss("#00FF00")), [0, 255, 0, 1]);
  assert.strictEqual(hexColorCss(""), null); assert.strictEqual(hexColorCss("red"), null);
  const setBoardChainColors = fn(["editor", "netchains.ts"], "setBoardChainColors", { hexColorCss });
  const doc = {}; setBoardChainColors(doc, [{ name: "C1", color: "#0000FFFF" }, { name: "C2", color: "" }]);
  assert.deepStrictEqual([...doc.netChainColors.keys()], ["C1"], "a chain without a colour has none (ClearNetChainColors first)");
});
const CHAIN_DOC = HEAD + '(segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "t1")) (segment (start 0 2) (end 5 2) (width 0.25) (layer "F.Cu") (net 2) (uuid "t2")) ' +
  '(via (at 8 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v1")) ' +
  '(footprint "R" (layer "F.Cu") (uuid "fp") (at 0 5) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A") (uuid "p1")) (pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu") (net 2 "B") (uuid "p2"))))';
test("PCB_PAINTER: the highlighted chain's tracks and via (copper and hole) in chainColor.WithAlpha( color.a )", () => {
  const doc = K.parseDoc(CHAIN_DOC);
  const ops = draw(doc, { highlight: new Set(["t1", "v1", "fp#0"]), pcbNetChain: { nets: new Set([1]), color: "rgba(0,0,255,1)", terminals: new Map() } });
  const track = ops.filter((o) => o.op === "stroke" && sameRgb(o.stroke, "rgb(0,0,255)"));
  assert.ok(track.length >= 1, "the chain's track");
  assert.ok(ops.filter((o) => o.op === "fill" && sameRgb(o.fill, "rgb(0,0,255)")).length >= 2, "the via's copper and its hole");
  const plain = draw(doc, { highlight: new Set(["t1", "v1", "fp#0"]) });
  assert.ok(!plain.some((o) => sameRgb(o.stroke, "rgb(0,0,255)") || sameRgb(o.fill, "rgb(0,0,255)")), "no chain colour without a chain");
  const none = draw(doc, { highlight: new Set(["t1"]), pcbNetChain: { nets: new Set([1]), color: null, terminals: new Map() } });
  assert.ok(!none.some((o) => sameRgb(o.stroke, "rgb(0,0,255)")), "a chain without a colour override keeps the highlight colour");
});
test("PCB_PAINTER: a terminal pad of a highlighted net is framed; on the highlighted chain in its colour with an inner frame", () => {
  const doc = K.parseDoc(CHAIN_DOC);
  const onChain = draw(doc, { highlight: new Set(["t1", "fp#0"]), pcbNetChain: { nets: new Set([1]), color: "rgba(0,0,255,1)", terminals: new Map([["p1", true]]) } }).filter((o) => o.op === "strokeRect");
  assert.strictEqual(onChain.length, 2, "the frame and the inset frame"); assert.ok(onChain.every((o) => sameRgb(o.stroke, "rgb(0,0,255)")));
  const [x, y, w, h] = onChain[0].args; assert.ok(Math.abs(x + 0.5) < 1e-6 && Math.abs(y - 4.5) < 1e-6 && Math.abs(w - 1) < 1e-6 && Math.abs(h - 1) < 1e-6, "the pad's bounding box");
  const plain = draw(doc, { highlight: new Set(["t1", "fp#0"]), pcbNetChain: { nets: new Set(), color: null, terminals: new Map([["p1", false]]) } }).filter((o) => o.op === "strokeRect");
  assert.strictEqual(plain.length, 1, "a net highlight: one frame"); assert.ok(!sameRgb(plain[0].stroke, "rgb(0,0,255)"));
  const fcu = rgbaOf(K.pcbColor("F.Cu")), got = rgbaOf(plain[0].stroke);
  assert.ok(got[0] >= fcu[0] && got[1] >= fcu[1] && got[2] >= fcu[2], "Brightened( 0.2 ) of the highlighted pad colour");
  assert.strictEqual(draw(doc, { pcbNetChain: { nets: new Set(), color: null, terminals: new Map([["p1", false]]) } }).filter((o) => o.op === "strokeRect").length, 0, "nothing highlighted: no frame");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
