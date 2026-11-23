// node server/static/tests/measure-plot-misc.test.js — KiCad parity of the measure tool, the drawing assistants, the
// board and schematic plot paths and the reference image sizing: the plot sequence order (PlotBoardLayers), the Protel
// extensions (CopperLayerToOrdinal), BuildPlotFileName, the Gerber X2 header (TF.SameCoordinates, GbrMakeProjectGUIDfromString,
// replaceReservedCharsField, ExpandTextVars of the revision), PCB_PLOT_PARAMS::IsSameAs, the Plot dialog's Color theme,
// the ruler in a flipped view and on a HiDPI canvas, the arc assistant's special-angle guides and stroke-font cursor text,
// BITMAP_BASE::updatePPI, and the source-level wiring of the dialogs and the editor.
// `npm run build:canvas` and `npm run build:fab` must have produced static/kicad-canvas.js and static/dist/fab.js first.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "dist", "fab.js"));
const K = globalThis.KiCadCanvas, F = globalThis.KiCadFab, P = K.plot.params;
const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");

let passed = 0, failed = 0; const pending = [];
function test(name, fn) { pending.push(Promise.resolve().then(fn).then(() => { passed++; console.log("  ok  ", name); }, (e) => { failed++; console.error("FAIL", name + ":", e.stack); })); }

const BOARD = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0") (general (thickness 1.6))
 (paper "A4") (title_block (title "Parity") (rev "\${REV}"))
 (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (25 "Edge.Cuts" user) (35 "F.Fab" user) (39 "User.1" user " Top/Assy:1 "))
 (setup (pad_to_mask_clearance 0) (aux_axis_origin 100 80))
 (net 0 "") (net 1 "GND")
 (gr_rect (start 100 50) (end 140 80) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
 (segment (start 100 60) (end 140 60) (width 0.25) (layer "F.Cu") (net 1) (uuid "s1"))
)`;
const doc = K.parseDoc(BOARD, "kicad_pcb");
doc.projectVars = { REV: "C,1" };
const ctx = { doc, setup: BOARD, projectName: "t", date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)) };
const COLORS = { "F.Cu": "#C83434", "Edge.Cuts": "#D0D2CD" };
const plot = (over, layers, common) => F.plotBoard(ctx, { params: Object.assign(P.defaultPlotParams(), over), layers, common: common || [], colors: COLORS, sheetColor: "#C872AB", outputDir: "" });

// ---------------------------------------------------------------- the plot paths
test("#3 PlotBoardLayers: the file's own layer is plotted first, each Plot on All Layers layer painted over it", async () => {
  const svg = String((await plot({ format: 5, blackAndWhite: false, drillMarks: 0 }, ["F.Cu"], ["Edge.Cuts"])).files[0].data);
  const cu = svg.indexOf("#C83434"), edge = svg.indexOf("#D0D2CD");
  assert.ok(cu > 0 && edge > 0, "both layers are in the file");
  assert.ok(cu < edge, "F.Cu comes before (under) Edge.Cuts");
});

test("#4 GetGerberProtelExtension: g + CopperLayerToOrdinal (In1.Cu is g1, In2.Cu g2)", () => {
  const cu = ["F.Cu", "In1.Cu", "In2.Cu", "B.Cu"];
  assert.strictEqual(F.protelExtension("In1.Cu", cu), "g1");
  assert.strictEqual(F.protelExtension("In2.Cu", cu), "g2");
  assert.strictEqual(F.protelExtension("F.Cu", cu), "gtl");
  assert.strictEqual(F.protelExtension("B.Cu", cu), "gbl");
  assert.strictEqual(F.protelExtension("F.Fab", cu), "gbr");
});

test("#12 BuildPlotFileName: the suffix trimmed, DOS-forbidden characters, % and . as _, no '-' for an empty suffix", () => {
  assert.strictEqual(F.plotFileName("t", "F.Cu", "gbr"), "t-F_Cu.gbr");
  assert.strictEqual(F.plotFileName("t", " Top/Assy:1 ", "pdf"), "t-Top_Assy_1.pdf");
  assert.strictEqual(F.plotFileName("t", 'a*b?c"d<e>f|g\\h%i', "svg"), "t-a_b_c_d_e_f_g_h_i.svg");
  assert.strictEqual(F.plotFileName("t", "   ", "gbr"), "t.gbr");
});

test("#10 TF.SameCoordinates: PX<x>PY<y> (aux origin in nm, hex) with Use drill/place file origin, else Original", async () => {
  const aux = String((await plot({ format: 1, useAuxOrigin: true, createJobFile: false }, ["F.Cu"])).files[0].data);
  assert.ok(aux.includes("%TF.SameCoordinates,PX5f5e100PY4c4b400*%"), aux.slice(0, 400));
  const abs = String((await plot({ format: 1, useAuxOrigin: false, createJobFile: false }, ["F.Cu"])).files[0].data);
  assert.ok(abs.includes("%TF.SameCoordinates,Original*%"));
});

test("#11 TF.ProjectId: GbrMakeProjectGUIDfromString of the board file name, reserved characters, revision text variables", async () => {
  const g = String((await plot({ format: 1, createJobFile: false }, ["F.Cu"])).files[0].data);
  // "t.kicad_pcb" padded with X to 16 characters: 74 2e 6b 69 - 63 61 - 4 645 - 9 f70 - 63 62 58 58 58 58
  // the revision ${REV} expands to "C,1" and the comma becomes _
  assert.ok(g.includes("%TF.ProjectId,t,742e6b69-6361-4645-9f70-636258585858,C_1*%"), g.split("\n").slice(0, 4).join("\n"));
  const job = JSON.parse(String((await plot({ format: 1, createJobFile: true }, ["F.Cu"])).files.find((f) => /gbrjob$/.test(f.name)).data));
  assert.strictEqual(job.GeneralSpecs.ProjectId.GUID, "742e6b69-6361-4645-9f70-636258585858");
  assert.strictEqual(job.GeneralSpecs.ProjectId.Revision, "C,1", "the job file keeps the expanded revision as it is");
});

test("#16 PCB_PLOT_PARAMS::IsSameAs: format-dependent fields, Plot on All Layers as an ordered sequence", () => {
  const a = P.defaultPlotParams();
  a.format = 4;   // PDF: the Gerber options do not count
  assert.ok(P.samePlotParams(a, Object.assign({}, a, { useGerberX2: false, gerberPrecision: 5 })));
  assert.ok(!P.samePlotParams(a, Object.assign({}, a, { pdfMetadata: false })));
  assert.ok(P.samePlotParams(a, Object.assign({}, a, { a4Output: true })), "A4 only for PostScript");
  const ps = Object.assign({}, a, { format: 2 });
  assert.ok(P.samePlotParams(ps, Object.assign({}, ps, { useAuxOrigin: true })), "the origin is not compared for PostScript");
  assert.ok(!P.samePlotParams(ps, Object.assign({}, ps, { a4Output: true })));
  const g = Object.assign({}, a, { format: 1 });
  assert.ok(!P.samePlotParams(g, Object.assign({}, g, { useGerberX2: false })));
  assert.ok(P.samePlotParams(g, Object.assign({}, g, { drillMarks: 2, scaleSelection: 3 })), "drill marks and scale are not compared for Gerber");
  const s1 = Object.assign({}, a, { plotOnAllLayers: ["Edge.Cuts", "F.Fab"] }), s2 = Object.assign({}, a, { plotOnAllLayers: ["F.Fab", "Edge.Cuts"] });
  assert.ok(!P.samePlotParams(s1, s2), "the sequence order counts");
  assert.ok(P.samePlotParams(Object.assign({}, a, { layerSelection: ["F.Cu", "B.Cu"] }), Object.assign({}, a, { layerSelection: ["B.Cu", "F.Cu"] })), "the layer selection is a set");
  assert.ok(P.samePlotParams(a, Object.assign({}, a, { fineScaleX: 1, plotReference: true })), "unset fields are their defaults");
});

test("#7 Color theme: KiCad Classic's board colours and LAYER_DRAWINGSHEET, enabled for SVG / PDF in colour and PNG", () => {
  assert.strictEqual(P.classicLayerColor("F.Cu"), "#840000");
  assert.strictEqual(P.classicLayerColor("B.Cu"), "#008400");
  assert.strictEqual(P.classicLayerColor("In1.Cu"), "#C2C200");
  assert.strictEqual(P.classicLayerColor("In17.Cu"), "#C2C200");
  assert.strictEqual(P.classicLayerColor("In30.Cu"), "#000084");
  assert.strictEqual(P.classicLayerColor("Edge.Cuts"), "#C2C200");
  assert.strictEqual(P.classicLayerColor("B.Paste"), "#00C2C2");
  assert.strictEqual(P.classicLayerColor("User.7"), "#000084");
  assert.strictEqual(P.CLASSIC_DRAWINGSHEET, "#480000");
  assert.ok(P.colorThemeEnabled(5, false) && !P.colorThemeEnabled(5, true));
  assert.ok(P.colorThemeEnabled(4, false) && !P.colorThemeEnabled(4, true));
  assert.ok(P.colorThemeEnabled(6, true));
  for (const f of [1, 2, 3]) assert.ok(!P.colorThemeEnabled(f, false));
  const s = src("editor", "pcbdialogs", "plot.ts");
  assert.ok(/"Color theme:"/.test(s) && /Select the color theme to use for plotting/.test(s));
  assert.ok(/P\.classicLayerColor\(l\)/.test(s) && /sheetColor = P\.CLASSIC_DRAWINGSHEET/.test(s), "the chosen theme colours the plot");
  assert.ok(/svgMode = selectField[^\n]*onChange: \(\) => syncEnables\(\)/.test(s), "the SVG output mode updates the control");
});

test("#15 applyPlotSettings: a default tempOptions, each format's options copied only for that format", () => {
  const s = src("editor", "pcbdialogs", "plot.ts");
  assert.ok(/Object\.assign\(P\.defaultPlotParams\(\), \{ dashRatio: p\.dashRatio, gapRatio: p\.gapRatio \}\)/.test(s));
  assert.ok(/if \(fmt === 1\) \{\s*t\.disableApertMacros/.test(s) && /\} else if \(fmt === 5\) \{\s*t\.svgPrecision/.test(s) && /\} else if \(fmt === 6\) \{\s*t\.pngDpi/.test(s));
  assert.ok(/fineScaleX: undefined, fineScaleY: undefined, widthAdjust: undefined/.test(s), "the PostScript adjustments stay the user's");
});

test("#13 CreateDrillFile: the Plot dialog takes the output directory and the origin back from the board", () => {
  const s = src("editor", "pcbdialogs", "plot.ts");
  assert.ok(/if \(opts\.afterDrill\) \{ p\.outputDirectory = stored\.outputDirectory; p\.useAuxOrigin = stored\.useAuxOrigin; \}/.test(s));
  assert.ok(/Object\.assign\(keep\(\), \{ outputDir: undefined, afterDrill: true \}\)/.test(s));
});

test("#8 #9 #20 schematic plot: the sheet at the paper's top left, DXF at sheet size, the messages accumulate", () => {
  const s = src("dialogs", "plot-schematic.ts");
  assert.ok(/const x0 = 0, y0 = 0;/.test(s) && !/-\(paper\[0\] \/ k - W\) \/ 2/.test(s));
  assert.ok(/o\.format === 3 \? Object\.assign\(\{\}, o, \{ pageSize: 0 \}\) : o/.test(s));
  assert.ok(!/report\.set\(\[\]\)/.test(s) && /const report = reportPanel\("130px"\); const lines: ReportLine\[\] = \[\];/.test(s));
  assert.ok(/dxfInch: true/.test(s) && /selectField<string>\(variants\[0\]/.test(s), "#17 Inches and the default variant (already so)");
});

test("#20 #24 placement files: the messages accumulate; the directory starts empty", () => {
  const s = src("editor", "pcbdialogs", "posfile.ts");
  assert.ok(/textField\(pref\.outputDir !== null \? pref\.outputDir : "", \{ key: "outputDir" \}\)/.test(s));
  assert.ok(/const report = reportPanel\("140px"\); const lines: ReportLine\[\] = \[\];/.test(s));
  assert.ok(!/const lines: ReportLine\[\] = \[\]; const say/.test(s));
});

// ---------------------------------------------------------------- the measure tool
test("#1 #2 MeasureTool: PCB_GRID_HELPER::ResolveSnap with Shift (no object snap) and Ctrl (no grid), the snap indicator", () => {
  const s = src("editor", "index.ts");
  assert.ok(/measureDown\(measurePoint\(worldMm\(ev\), ev\), ev\)/.test(s));
  assert.ok(/const at = measurePoint\(mm, ev\); if \(E\.measure && E\.measure\.set\) measureMove\(at, ev\.shiftKey\)/.test(s));
  assert.ok(/pm\.snapCursor\(toolCtx\(\), \[mm\[0\]!, mm\[1\]!\], null, \{ shiftKey: ev\.shiftKey, ctrlKey: ev\.ctrlKey, metaKey: ev\.metaKey \}\)/.test(s));
  assert.ok(/if \(E\.tool === "measure" && E\.measureCursor\) return E\.measureCursor/.test(s), "ForceCursorPosition");
  const o = src("editor", "overlays.ts");
  assert.ok(/pm\.drawSnapIndicator\(ctx, sn\.p, sn\.t, 1 \/ \(view\.ppm \* view\.zoom\)\)/.test(o));
});

test("#5 the measure tool's menu: Cancel, Copy (greyed without a selection), Zoom, Grid; Copy copies the readout", () => {
  const out = esbuild.buildSync({ entryPoints: [webPath("domains", "pcb", "editor", "ctxmenus.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", out.outputFiles[0].text)(mod, mod.exports);
  const { menuFor, evaluate } = mod.exports;
  const c = (o) => Object.assign({ editor: "pcb", kinds: [], tool: "measure", busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: false, hasItems: true, checks: {} }, o);
  const flat = (list) => list.map((e) => e.sep ? "-" : e.menu ? ">" + e.menu.title : e.act.split("::").pop() + (e.disabled ? "(off)" : ""));
  assert.deepStrictEqual(flat(evaluate(menuFor(c({}), false), c({}))), ["cancelInteractive", "-", "copy(off)", "-", ">Zoom", ">Grid"]);
  const sel = c({ kinds: ["footprint"] });
  assert.deepStrictEqual(flat(evaluate(menuFor(sel, false), sel)), ["cancelInteractive", "-", "copy", "-", ">Zoom", ">Grid"]);
  assert.ok(/act === "ACTIONS::copy" && c\.tool === "measure" && ed !== "sch"\) return \{ run: \(\) => \{ measureCopy\(\); \} \}/.test(src("editor", "contextmenu.ts")));
});

test("#6 the ruler readout follows Invert X / Y axis (RULER_ITEM m_flipX / m_flipY)", () => {
  const o = src("editor", "overlays.ts"), p = src("editor", "pointer.ts");
  assert.ok(/rulerOps\(origin, end, units, rv, sch \? \[false, false\] : \[!!vp\.invertX, !!vp\.invertY\]\)/.test(o));
  assert.ok(/!sch && !!vp\.invertX, !sch && !!vp\.invertY\)\.join/.test(p));
});

test("#25 ACTIONS::measureTool is not a schematic tool", () => {
  const T = load(["tables.ts"]);
  assert.ok(!("measureTool" in T.TOOL_MAP.sch) && T.TOOL_MAP.pcb.measureTool === "measure");
  assert.ok(/if \(t === "measure" && isSch\(\)\) return;/.test(src("editor", "tools.ts")));
});

const R = load(["editor", "ruler.ts"]);
const MM = 1e6;
const view = (o) => Object.assign({ scale: 10 / MM, toScreen: (p) => [p[0] * 10 / MM + 500, p[1] * 10 / MM + 500], screen: [1000, 1000], viewport: [-1e12, -1e12, 1e12, 1e12], textWidth: (t, size, pen) => t.length * size + pen }, o);

test("#21 GetConstantGlyphHeight: the HiDPI table (11 px, 0.15 / 0.10 / 1.7) on a canvas whose scale factor is > 1", () => {
  const n = R.glyphDims(1, 0, false), h = R.glyphDims(1, 0, true);
  assert.deepStrictEqual(n, { size: 14, stroke: 14 * 0.2, shadow: 14 * 0.15, pitch: 14 * 1.9 });
  assert.deepStrictEqual(h, { size: 11, stroke: 11 * 0.15, shadow: 11 * 0.1, pitch: 11 * 1.7 });
  assert.strictEqual(R.glyphDims(1, -1, true).size, 9);
  const text = R.rulerOps([0, 0], [10 * MM, 0], "mm", view({ hidpi: true })).find((o) => o.kind === "text" && !o.shadow && /^x:/.test(o.text));
  assert.ok(Math.abs(text.size - 11 / (10 / MM)) < 1e-6, "the readout uses the HiDPI size");
});

test("#22 the ruler in a flipped view: ticks and labels on the other side, text alignment swapped", () => {
  const plain = R.rulerOps([0, 0], [10 * MM, 0], "mm", view({})), flip = R.rulerOps([0, 0], [10 * MM, 0], "mm", view({ mirrored: true }));
  // the first tick at the origin (not the main line, nor the back of the origin crosshair)
  const tick = (ops) => ops.filter((o) => o.kind === "line" && !o.shadow && o.a[0] === 0 && o.a[1] === 0 && o.b[0] === 0)[0];
  assert.ok(tick(plain).b[1] * tick(flip).b[1] < 0, "drawTicksAlongLine: length * isign");
  const label = (ops) => ops.find((o) => o.kind === "text" && !o.shadow && o.text === "0.000");
  assert.ok(label(plain).at[1] * label(flip).at[1] < 0, "labelOffset negated");
  const readout = (ops) => ops.find((o) => o.kind === "text" && !o.shadow && /^x:/.test(o.text));
  assert.notStrictEqual(readout(plain).h, readout(flip).h, "DrawTextNextToCursor swaps left / right");
  const o = src("editor", "overlays.ts");
  assert.ok(/mirrored: m\.a < 0/.test(o) && /hidpi: dpr > 1/.test(o));
});

// ---------------------------------------------------------------- the drawing assistants
// a canvas context that records the strokes and the stroke-font text runs
function recorder() {
  const log = { lines: [], texts: [] }; let alpha = 1, stroke = "", dash = [];
  const c = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, closePath() {}, fill() {}, fillRect() {}, strokeRect() {}, fillText() {}, strokeText() {}, measureText: () => ({ width: 10 }),
    stroke() { log.lines.push({ alpha, color: stroke, dash: dash.slice() }); },
    setLineDash(d) { dash = d.slice(); }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    set globalAlpha(v) { alpha = v; }, get globalAlpha() { return alpha; }, set strokeStyle(v) { stroke = v; }, get strokeStyle() { return stroke; },
    lineWidth: 1, fillStyle: "", lineCap: "", lineJoin: "", font: "", textAlign: "", textBaseline: "",
  };
  return { c, log };
}
const realStroke = K.drawStrokeText;
const strokeLog = [];
K.drawStrokeText = (ctx, base, t, color, minPen) => { strokeLog.push({ t, color }); };
// through the tools' own entry, so the modules initialise in the bundle's order
const tb = esbuild.buildSync({ stdin: { contents: 'import "./index"; export { textNextToCursor, previewTextDims } from "./assistants"; export { angleIsSpecial, specialAngleColour } from "./arcs";', resolveDir: webPath("tools", "pcb-tools"), loader: "ts" }, bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" });
const tm = { exports: {} }; new Function("module", "exports", "require", tb.outputFiles[0].text)(tm, tm.exports, require);
const A = tm.exports, ARC = tm.exports;

test("#19 DrawTextNextToCursor: KiCad's stroke font, a shadow pass then the text in LAYER_AUX_ITEMS", () => {
  strokeLog.length = 0;
  const { c } = recorder();
  A.textNextToCursor(c, [0, 0], [-1, -1], ["l: 1.000 mm", "θ: 0.0°"], 0.1, "#C83434");
  assert.strictEqual(strokeLog.length, 4, "two passes of two lines");
  assert.deepStrictEqual(strokeLog.map((s) => s.color), ["#000000", "#000000", "#FFFFFF", "#FFFFFF"]);
  const dims = A.previewTextDims(), size = dims.height * 0.1;
  const [sh, , tx] = strokeLog.map((s) => s.t);
  assert.ok(Math.abs(tx.size - size) < 1e-9 && Math.abs(tx.pen - size * dims.stroke) < 1e-9);
  assert.ok(Math.abs(sh.pen - (size * dims.stroke + 2 * size * dims.shadow)) < 1e-9, "the shadow is widened by 2 x the shadow width");
  assert.strictEqual(tx.h, "left"); assert.ok(Math.abs(tx.x - 1.5) < 1e-9, "15 px right of the cursor");
  assert.ok(sh.x < tx.x, "the left-aligned shadow is shifted left");
  assert.ok(Math.abs(tx.y - size * dims.pitch) < 1e-9, "the first line one pitch below");
});

test("#18 ARC_ASSISTANT guides: LAYER_AUX_ITEMS, the special angle colour at 45 degree multiples, 6 px dashes", () => {
  assert.ok(ARC.angleIsSpecial([10, 0]) && ARC.angleIsSpecial([5, 5]) && ARC.angleIsSpecial([0, -3]) && ARC.angleIsSpecial([-7, 7]));
  assert.ok(!ARC.angleIsSpecial([10, 1]) && !ARC.angleIsSpecial([3, 4]));
  assert.strictEqual(ARC.specialAngleColour(), "#80FF80", "the board's background is dark");
  const s = src("tools", "pcb-tools", "arcs.ts");
  assert.ok(/c\.setLineDash\(\[6 \* px, 6 \* px\]\)/.test(s) && !/12 \* px, 6 \* px/.test(s));
  assert.ok(/c\.globalAlpha = dim \? 0\.5 : 1/.test(s) && !/0\.45/.test(s));
  assert.ok(/plain\(marked, sol\.start, true\); plain\(marked, sol\.end, true\)/.test(s), "DrawLine, not DrawLineWithAngleHighlight");
});

// ---------------------------------------------------------------- reference images
test("#23 BITMAP_BASE::updatePPI: the file's resolution only when it is > 1", () => {
  const I = load(["tools", "pcb-tools", "images.ts"]);
  const be = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = (ppm, unit) => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...be(13), 0x49, 0x48, 0x44, 0x52, ...be(100), ...be(50), 8, 2, 0, 0, 0, 0, 0, 0, 0,
    ...be(9), 0x70, 0x48, 0x59, 0x73, ...be(ppm), ...be(ppm), unit, 0, 0, 0, 0, ...be(0), 0x49, 0x45, 0x4E, 0x44, 0, 0, 0, 0]);
  assert.strictEqual(I.imageInfo(png(0, 1)).ppi, 300, "no resolution: the 300 PPI default");
  assert.strictEqual(I.imageInfo(png(50, 1)).ppi, 300, "0.5 px/cm is not > 1");
  assert.strictEqual(I.imageInfo(png(3780, 1)).ppi, 96, "37.8 px/cm x 2.54");
  assert.strictEqual(I.imageInfo(png(72, 0)).ppi, 72, "no unit: taken as ppi");
  const jpeg = (unit, dx) => new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, unit, dx >> 8, dx & 255, dx >> 8, dx & 255, 0, 0,
    0xFF, 0xC0, 0, 11, 8, 0, 40, 0, 80, 1, 1, 0x11, 0]);
  assert.strictEqual(I.imageInfo(jpeg(1, 1)).ppi, 300, "a density of 1 is ignored");
  assert.strictEqual(I.imageInfo(jpeg(1, 150)).ppi, 150);
  assert.strictEqual(I.imageInfo(jpeg(2, 100)).ppi, 254);
  const T = K.imageInfo || null;
  if (T) for (const b of [png(0, 1), png(3780, 1), jpeg(1, 1), jpeg(2, 100)]) assert.strictEqual(I.imageInfo(b).ppi, T(b).ppi, "the canvas reads the same resolution");
});

Promise.all(pending).then(() => {
  K.drawStrokeText = realStroke;
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
