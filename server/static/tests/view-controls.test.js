// view-controls.test.js — the canvas view controls against KiCad: zoom limits (include/zoom_defines.h, VIEW::SetScale),
// refreshMouse after view moves and auto-panning (common/view/wx_view_controls.cpp), the accelerating zoom controller
// (zoom_controller.cpp), cursor keys and keyboard clicks (common/tool/common_tools.cpp), the crosshair's dim state
// (GAL::getCursorColor), stock / custom cursors (common/gal/cursors.cpp), FocusOnLocation (eda_draw_frame.cpp), grids
// with X != Y (GRID, GAL::gridLattice / GetGridPoint), grid identity by index, the footprint editor's own axes
// (pcb_origin_transforms.cpp) and the canvas scrollbars (UpdateScrollbars / onScroll).
// Run: node server/static/tests/view-controls.test.js
"use strict";
const path = require("path"), assert = require("assert"), fs = require("fs");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
globalThis.window = globalThis;
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;

const load = (rel) => { const b = esbuild.buildSync({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node" }); const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports; };
/** Bundle a module with some of its imports replaced by globalThis.__vcStub(path) (esbuild's plugins need the async API). */
async function loadStubbed(rel, stubRe, stubs) {
  const plugin = { name: "stub", setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => { if (!a.path.startsWith(".")) return undefined; const full = path.resolve(a.resolveDir, a.path); return stubRe.test(full) ? { path: full, namespace: "stub" } : undefined; });
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: `module.exports = globalThis.__vcStub(${JSON.stringify(a.path)});`, loader: "js" }));
  } };
  globalThis.__vcStub = (p) => { const key = Object.keys(stubs).find((k) => p.includes(k)); const base = key ? stubs[key] : {}; return new Proxy(base, { get: (t, k) => (k === "__esModule" ? false : k in t ? t[k] : () => null) }); };
  const b = await esbuild.build({ entryPoints: [webPath(...rel)], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node", plugins: [plugin] });
  const m = { exports: {} }; new Function("module", "exports", "require", b.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const src = (...rel) => fs.readFileSync(webPath(...rel), "utf8");
/** The body of a function in a source file, from its declaration to the next top-level declaration. */
function fnBody(text, name) {
  const at = text.search(new RegExp(`(export )?(async )?function ${name}\\b[^;\\n]*\\{`)); assert.ok(at >= 0, name + " not found");
  const rest = text.slice(at + 10), end = rest.search(/\n(export |function |const |let |\/\*\*|\/\/ -{10})/);
  return text.slice(at, at + 10 + (end < 0 ? rest.length : end));
}

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

const W = load(["editor", "wheel-model.ts"]), U = load(["units.ts"]);
const VIEW = src("editor", "view.ts"), GEST = src("editor", "gestures.ts"), CROSS = src("editor", "crosshair.ts"), MENU = src("editor", "menu-actions.ts");
const INDEX = src("editor", "index.ts"), DOC = src("editor", "doc.ts");

// ---------------------------------------------------------------- 1. zoom limits
test("1. zoom limits are VIEW::SetScaleLimits' (0.01-100 schematic, 0.1-50000 board), not the zoom list's ends, for every zoom and the fit", () => {
  const zl = fnBody(VIEW, "zoomLimits");
  assert.ok(/isSch\(\) \? \[0\.01, 100\] : \[0\.1, 50000\]/.test(zl), "ZOOM_MIN/MAX_LIMIT_EESCHEMA / _PCBNEW");
  const fit = fnBody(VIEW, "fitBox");
  assert.ok(/Math\.min\(zhi, Math\.max\(zlo,/.test(fit) && !/1e-4/.test(fit), "the fit clamps to both limits");
  const zb = fnBody(VIEW, "zoomBy");
  assert.ok(/Math\.min\(hi, Math\.max\(lo, E\.zoom \* factor\)\)/.test(zb), "SetScale clamps every zoom to [min, max]");
});

// ---------------------------------------------------------------- 2. refreshMouse
test("2. refreshMouse: a wheel / key pan, a wheel zoom, an auto-pan tick and a pinch dispatch a pointer move at the pointer with the keys and buttons held", () => {
  const rm = fnBody(GEST, "refreshMouse");
  assert.ok(/new PointerEvent\("pointermove"/.test(rm) && /button: -1/.test(rm) && /buttons: lastButtons/.test(rm) && /heldModifiers\(\)/.test(rm), "a motion with the held state, no button change");
  assert.ok(/refreshMouse\(\)/.test(fnBody(GEST, "panBy")), "wheel pans");
  assert.ok(/refreshMouse\(\)/.test(fnBody(CROSS, "panStep")), "Shift+arrow pans");
  assert.ok(/zoomBy\(factor, ev\.clientX - r\.left, ev\.clientY - r\.top\); requestZoomEnd\(\); refreshMouse\(\)/.test(fnBody(GEST, "zoomAtPointer")), "wheel zoom about the pointer");
  assert.ok(/refreshMouse\(true\)/.test(fnBody(GEST, "autoPanTick")), "auto-pan ticks");
  assert.ok(/ev\.isTrusted\) \{ pointerOver = true; lastButtons = ev\.buttons; \}/.test(GEST), "the held buttons come from real pointer events only");
});

// ---------------------------------------------------------------- 3. auto-pan
test("3. auto-pan: every motion runs handleAutoPanning when the option is on and a tool asked for it; tablecells uses the shared loop", () => {
  const h = fnBody(GEST, "handleAutoPanning");
  assert.ok(/KiCadKeyboardCursor/.test(h), "a keyboard cursor step leaves the state alone");
  assert.ok(/!E\.autoPan \|\| E\.pan \|\| !wanted\(\)/.test(h), "off, DRAG_PANNING / DRAG_ZOOMING or no SetAutoPan: no auto-pan");
  assert.ok(/autoPanDirection/.test(h) && /stopAutoPanning\(\); return false;/.test(h), "outside the border it stops");
  const tick = fnBody(GEST, "autoPanTick");
  assert.ok(/document\.hasFocus\(\)/.test(tick) && /autoPanStep\(/.test(tick) && /AUTOPAN_TICK_MS/.test(tick), "onTimer: focus, the step per elapsed tick");
  assert.ok(/handleAutoPanning\(ev\)/.test(fnBody(GEST, "onMoveCapture")), "the stage's motions");
  const want = fnBody(GEST, "autoPanWanted");
  assert.ok(/interactionBusy\(\)/.test(want) && /s\.wire \|\| s\.draw \|\| s\.carry/.test(want) && /p\.route \|\| p\.draw/.test(want), "move / drag / box / drawing / routing");
  const tc = src("editor", "tablecells.ts");
  assert.ok(/handleAutoPanning\(ev, autoPanWanted\)/.test(tc) && !/requestAnimationFrame\(tick\)/.test(tc), "the table-cell drag uses the shared loop");
  // the step arithmetic itself (wx_view_controls.cpp onTimer)
  const [dx] = K.autoPanStep(1000, 400, 1000, 800, 5); near(dx, 16 * 1.5);
  near(K.autoPanStep(999, 400, 1000, 800, 5)[0], 16);
  assert.deepStrictEqual(K.autoPanDirection(500, 400, 1000, 800), [0, 0]);
});

// ---------------------------------------------------------------- 4. any button up ends a drag pan
test("4. letting go of the left button during a middle / right drag pan or drag zoom ends it (DRAG_PANNING: any button up -> IDLE)", () => {
  const cb = fnBody(GEST, "chordedButton");
  const part = cb.slice(cb.indexOf("ev.button === 0 && !down(1)"));
  assert.ok(/E\.pan = null; E\.rdown = null; stage\.classList\.remove\("panning"\)/.test(part), "the pan ends");
  assert.ok(!/E\.pan = pan/.test(part) && !/finally/.test(part), "and is not restored");
  assert.ok(/if \(interactionBusy\(\)\)/.test(part), "the tools still get the release");
});

// ---------------------------------------------------------------- 5. accelerating zoom
test("5. ACCELERATING_ZOOM_CONTROLLER: timeDiff / m_accTimeout is an integer quotient, so every quick notch is 2.05 × scale / 5; the time is stamped at construction", () => {
  const a = new W.AcceleratingZoom(5, 500, 1000);
  near(a.scaleFor(120, 120, 3000), 1.05);                    // first notch, long after construction
  near(a.scaleFor(120, 120, 3010), 2.05);                    // 10 ms later
  near(a.scaleFor(120, 120, 3499), 2.05);                    // 489 ms later: still 2.05, not 2.05 - 0.98
  near(a.scaleFor(120, 120, 3999), 1.05);                    // 500 ms: outside the timeout
  near(a.scaleFor(-120, 120, 4100), 1 / 1.05);               // direction changed
  near(a.scaleFor(-120, 120, 4400), 1 / 2.05);
  // the constructor's timestamp: a zoom out (prevPositive false) right after creation is already "quick"
  const b = new W.AcceleratingZoom(5, 500, 0); near(b.scaleFor(-120, 120, 100), 1 / 2.05);
  const c = W.makeZoomController(Object.assign({}, W.DEFAULT_WHEEL, { zoomAcceleration: true }), "win", 0); near(c(-120, 120, 100), 1 / 2.05);
  assert.ok(/zoomControllerSince/.test(src("dialogs", "prefs.ts")) && /zoomControllerSince/.test(GEST), "LoadSettings stamps the controller when the settings load");
});

// ---------------------------------------------------------------- 6 / 15 / 16. cursor keys
test("6. cursor keys: a cursor leaving the canvas centres the view on it (WarpMouseCursor), no edge margin; Left / Right are mirrored in a flipped view", () => {
  const cs = fnBody(CROSS, "cursorStep");
  assert.ok(/x < sr\.left \|\| x > sr\.right \|\| y < sr\.top \|\| y > sr\.bottom/.test(cs), "the stage rectangle, no margin");
  assert.ok(/E\.panX \+= sr\.left \+ sr\.width \/ 2 - x; E\.panY \+= sr\.top \+ sr\.height \/ 2 - y/.test(cs), "SetCenter( cursor )");
  assert.ok(/viewFlipped\(\) \? -1 : 1/.test(cs), "mirroredX ? -gridSize.x : gridSize.x");
});
test("15. Shift+arrow pans by ten steps of the displayed grid, never a tool's override", () => {
  const ps = fnBody(CROSS, "panStep");
  assert.ok(/E\.gridPitch/.test(ps) && !/gridStep\(\)|gridFor/.test(ps));
});
test("16. the first cursor key during a move steps from the selection's reference point; a mouse motion elsewhere ends the keyboard position", () => {
  const cs = fnBody(CROSS, "cursorStep");
  assert.ok(/rp = keyboardCursor \? null : selectionReferencePoint\(\)/.test(cs) && /cursorStepOrigin\(keyboardCursor \? here : null/.test(cs) && /keyboardCursor = to\.slice\(\)/.test(cs));
  const rp = fnBody(CROSS, "selectionReferencePoint");
  assert.ok(/st\.move\.start\[0\] \+ st\.move\.last\[0\]/.test(rp) && /st\.drag\.anchor0\[0\] \+ st\.drag\.last\[0\]/.test(rp) && /referencePoint/.test(rp));
  const nm = fnBody(CROSS, "noteMotion");
  assert.ok(/keyboardCursor = null/.test(nm) && /Math\.round\(k\[0\]\) !== Math\.round\(ev\.clientX\)/.test(nm));
  assert.ok(/noteMotion\(ev\)/.test(INDEX), "every canvas pointer move is noted");
});

// ---------------------------------------------------------------- 7. keyboard click modifiers
test("7. Enter / the Double-click action click with the modifiers held (wxGetKeyState): Shift adds, Ctrl toggles", () => {
  const cc = fnBody(CROSS, "cursorClick");
  assert.ok(/heldMods\(heldModifiers\(\), IS_MAC\)/.test(cc));   // kicad-input heldMods (tool-framework.test.js checks the mapping: Ctrl is Meta on macOS)
});

// ---------------------------------------------------------------- 8. dimmed crosshair
test("8. the crosshair is drawn at half alpha when it only shows because of Always Show Crosshairs (getCursorColor)", () => {
  assert.ok(/export function cursorEnabled\(\): boolean \{ return \(E\.tool !== "select" && E\.tool !== "selection"\) \|\| interactionBusy\(\); \}/.test(CROSS));
  assert.ok(/E\.alwaysShowCursor !== false \|\| cursorEnabled\(\)/.test(fnBody(CROSS, "cursorShown")));
  assert.ok(/ctx\.globalAlpha = cursorEnabled\(\) \? 1 : 0\.5/.test(fnBody(CROSS, "drawCrosshair")));
});

// ---------------------------------------------------------------- 9. hotkey zoom and pinch
test("9. Zoom In / Out at cursor anchors on the crosshair and centres with Center and warp cursor on zoom; a pinch never centres", () => {
  const z = fnBody(MENU, "zoomAtCursor");
  assert.ok(/cursorPosition\(\)/.test(z) && /E\.wheel && E\.wheel\.centerOnZoom\) centerOnCursor\(at\)/.test(z));
  assert.ok(/store\.get\(\)\.viewport\.cursor/.test(fnBody(MENU, "cursorPosition")), "GetCursorPosition: the snapped / forced crosshair");
  const onWheel = fnBody(GEST, "onWheel");
  assert.ok(/ev\.ctrlKey && !ctrlHeld\) \{ zoomBy\(Math\.pow\(1\.01, -dy\), ev\.clientX - r\.left, ev\.clientY - r\.top\)/.test(onWheel), "onMagnify: about the pointer");
});

// ---------------------------------------------------------------- 10. motion pan
test("10. Pan on mouse movement with key: pans whatever buttons are held, before the cursor is read, and the tools still get the motion", () => {
  const mp = fnBody(INDEX, "motionPan");
  assert.ok(!/buttons/.test(mp), "no button test");
  assert.ok(/motionPan\(ev\);\n  const mm = worldMm\(ev\);/.test(INDEX), "the cursor is read after the pan");
  assert.ok(!/E\.metaPan = \[ev\.clientX, ev\.clientY\]; return;/.test(fnBody(INDEX, "stagePointerMove")), "no early return before the tools");
});

// ---------------------------------------------------------------- 12. FocusOnLocation
test("12. FocusOnLocation: the board and schematic Find and ERC keep the zoom, move only when needed and put the crosshair on the item", () => {
  const f = fnBody(VIEW, "focusOnLocation");
  assert.ok(/focusScreenPoint\(/.test(f) && /openDialogRects\(\)/.test(f) && /setCrossHairCursorPosition\(x, y\)/.test(f) && !/E\.zoom =/.test(f));
  assert.ok(/export \{ focusOnLocation \}/.test(src("editor", "pcbdialogs", "find.ts")), "the board Find uses it");
  const sf = src("dialogs", "find.ts");
  assert.ok(/focusOnLocation\(c\[0\], c\[1\], true, openDialogRects\(\)\)/.test(sf) && !/centerOn\(hit\.x, hit\.y\)/.test(sf), "the schematic Find goes through FocusOnLocation");
  assert.ok(/fieldBoxes\(it, null\)/.test(fnBody(sf, "hitCentre")), "GetBoundingBox().GetCenter() of the matched field");
  assert.ok(/setCrossHairCursorPosition\(xMm, yMm\)/.test(src("editor", "comments.ts")), "ERC's focus moves the crosshair too");
  assert.ok(!/E\.zoom = 3/.test(src("dialogs", "erc.ts")) && !/E\.zoom = 3/.test(sf));
});

// ---------------------------------------------------------------- 13. grids with X != Y
test("13. GRID::MessageText and the grid menu: one size for a square grid, \"X x Y\" otherwise", () => {
  assert.strictEqual(U.gridChoiceText({ mm: 1.27 }, "mm", "mil", "pcb"), "1.2700 mm (50.00 mils)");
  assert.strictEqual(U.gridChoiceText({ mm: 1, my: 2, name: "Tall" }, "mm", "mil", "pcb"), "Tall: 1.0000 mm x 2.0000 mm (39.37 mils x 78.74 mils)");
  assert.strictEqual(U.gridMessageText(1, 2, "mm", "pcb"), "1.0000 x 2.0000");
  assert.ok(/gridMessageText\(vp\.gridPitch, vp\.gridPitchY && vp\.gridPitchY > 0 \? vp\.gridPitchY : vp\.gridPitch/.test(src("components", "StatusBar.tsx")), "the status bar's grid field");
});
test("13. GAL::GetGridPoint snaps each axis on its own pitch from the grid origin; the cursor keys step by X and Y", () => {
  const st = K.pcbSizes.state, o = st.gridOrigin.slice();
  try {
    st.gridOrigin = [0, 0];
    assert.deepStrictEqual(st.snapToGrid([1.3, 1.3], 1, 2), [1, 2]);
    assert.deepStrictEqual(st.snapToGrid([1.3, 1.3], 0.5), [1.5, 1.5]);
    st.gridOrigin = [0.25, 0.5];
    assert.deepStrictEqual(st.snapToGrid([1.3, 3.1], 1, 2), [1.25, 2.5]);
  } finally { st.gridOrigin = o; }
  const sm = fnBody(DOC, "snapMm");
  assert.ok(/gridSizeNow\(\)/.test(sm) && /snapToGrid\(mm as \[number, number\], p, py\)/.test(sm) && /KiCadCanvas\.snap\(mm\[1\], py\)/.test(sm));
  assert.ok(/E\.gridPitchY = my > 0 \? my : E\.gridPitch/.test(fnBody(DOC, "updateGridStatus")));
  const cs = fnBody(CROSS, "cursorStep"); assert.ok(/ddx = gs\[0\] \* steps, ddy = gs\[1\] \* steps/.test(cs));
});
test("13. GAL::gridLattice: both axes thin out by the factor the smaller pitch needs (the cells keep their shape)", () => {
  const doc = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user)) (net 0 ""))', "kicad_pcb");
  const rects = [];
  const ctx = new Proxy({ canvas: { width: 400, height: 400 }, measureText: (t) => ({ width: t.length }), rect: (x, y, w, h) => rects.push([x, y, w, h]) },
    { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  // 40 css px per mm: X 0.1 mm (4 px) needs thinning by 10, which Y (1 mm) takes too -> 1 mm × 10 mm
  K.render(doc, ctx, { ppm: 40, zoom: 1, panX: 0, panY: 0, x0: 0, y0: 0, dpr: 1 }, { grid: 0.1, gridY: 1, gridStyle: "dots", frame: false });
  assert.ok(rects.length > 0, "the grid is drawn");
  const xs = [...new Set(rects.map((r) => +(r[0] + r[2] / 2).toFixed(6)))].sort((a, b) => a - b), ys = [...new Set(rects.map((r) => +(r[1] + r[3] / 2).toFixed(6)))].sort((a, b) => a - b);
  near(xs[1] - xs[0], 1, 1e-6); near(ys[1] - ys[0], 10, 1e-6);
});
test("13. Preferences > Grids: a Y size per grid, the Grid Settings dialog's Linked / Y (OnLinkedChecked copies X), duplicates are X, Y and name", () => {
  const P = src("dialogs", "preferences.ts"), pr = src("dialogs", "prefs.ts");
  assert.ok(/linked\.addEventListener\("change", \(\) => \{ if \(!linked\.checked\) y\.value = x\.value; y\.disabled = linked\.checked; \}\)/.test(P));
  assert.ok(/Grid size Y out of range\./.test(P) && /const my = linked\.checked \? mm : parseUserLen\(y\.value\)/.test(P));
  assert.ok(/Math\.abs\(g\.ys\[i\] - r\.my\) < 1e-6 && \(g\.names!\[i\] \|\| ""\) === r\.name/.test(P), "GRID::operator==");
  assert.ok(/g\.ys\.splice\(row, 0, r\.my\)/.test(P) && /\[g\.ys\[i\], g\.ys\[j\]\] = \[g\.ys\[j\], g\.ys\[i\]\]/.test(P) && /g\.ys\.splice\(i, 1\)/.test(P), "add, move and remove keep Y beside X");
  assert.ok(/if \(g && typeof g === "object" && Array\.isArray\(g\.sizes\) && !Array\.isArray\(g\.ys\)\) g\.ys = \(g\.sizes as unknown\[\]\)\.slice\(\)/.test(pr), "old settings are square");
  assert.ok(/if \(my && Math\.abs\(my - mm\) > 1e-9\) d\.my = my/.test(pr), "gridDefs carries Y only when it differs");
});

// ---------------------------------------------------------------- 14. grid identity
test("14. the current grid is a list index (grid.last_size_idx): two grids of one size can both be reached, checked and remembered", () => {
  const gi = fnBody(DOC, "gridIndex");
  assert.ok(/const l = gridList\(\), i = E\.gridIdx;/.test(gi) && /Math\.abs\(l\[i\]\.mm - E\.gridPitch\) < 1e-9\) return i;/.test(gi));
  assert.ok(/setGridPitch\(l\[k\]\.mm, k\)/.test(fnBody(DOC, "setGridIndex")));
  assert.ok(/E\.gridIdx = idx !== undefined && l\[idx\]/.test(fnBody(DOC, "setGridPitch")));
  const cm = src("editor", "contextmenu.ts"); assert.ok(/checked: i === cur, run: runRow\(\(\) => setGridIndex\(i\)\)/.test(cm), "GRID_MENU checks idx == current");
  const tb = src("components", "Toolbar.tsx"); assert.ok(/typeof gridIdx === "number" && grids\[gridIdx\]/.test(tb) && /index: Number\(v\)/.test(tb), "the toolbar's grid box");
  const pr = src("dialogs", "prefs.ts"); assert.ok(/E\.gridIdx = idx; rememberGrid\(mm, editorId\(\), idx\)/.test(pr) && /cur === g\.fast1 \? 2 : 1/.test(pr), "fast grids by index");
});

// ---------------------------------------------------------------- 17 / 18. cursors
test("17 / 18. stock cursors per platform (MOVING is wxCURSOR_SIZING on macOS only) and Disable custom cursors", async () => {
  if (typeof window.addEventListener !== "function") window.addEventListener = () => {};
  const C = await loadStubbed(["editor", "cursors.ts"], /\/editor\/(state|selection|view|selmodes|tools)(\.ts)?$/, { "/editor/state": { E: {} } });
  assert.strictEqual(C.kicursorCss("MOVING", true, true), "move");
  assert.ok(/^url\("data:/.test(C.kicursorCss("MOVING", true, false)), "GTK / MSW: the bitmap (IsStockCursorOk refuses wxCURSOR_SIZING)");
  assert.strictEqual(C.kicursorCss("ARROW", true, false), "default");
  assert.strictEqual(C.kicursorCss("HAND", false, false), "pointer");
  assert.strictEqual(C.kicursorCss("LINE_WIRE", false, false), "default", "custom cursors off: the arrow");
  assert.strictEqual(C.kicursorCss("MOVING", false, false), "default");
  assert.strictEqual(C.kicursorCss("MOVING", false, true), "move");
  assert.ok(/^url\("data:/.test(C.kicursorCss("LINE_WIRE", true, false)));
  assert.strictEqual(C.kicursorCss("NOT_A_CURSOR", true, false), "");
  const P = src("dialogs", "preferences.ts");
  assert.ok(/checkbox\("Disable custom cursors", p\.common\.useCustomCursors === false/.test(P) && /setUseCustomCursors\(p\.common\.useCustomCursors !== false\)/.test(src("dialogs", "prefs.ts")));
});

// ---------------------------------------------------------------- 19 / 20 / 21
test("19. the status bar keeps KiCad's double spaces (whitespace-pre)", () => {
  const sb = src("components", "StatusBar.tsx"); assert.ok(/const cell = "[^"]*whitespace-pre"/.test(sb) && !/const cell = "[^"]*whitespace-nowrap/.test(sb));
});
test("20. the grid axes are one minor grid line wide (gridMinorLineWidth: Grid thickness widens them)", () => {
  const r = src("canvas", "render.ts"); const at = r.indexOf("if (opts.gridAxes) {");
  assert.ok(at > 0 && /const px1 = gridMinorPx\(opts, dpr\) \/ s;/.test(r.slice(at, at + 200)));
});
test("21. a diagonal scroll pans X from its horizontal part and handles the vertical part as its own wheel event", () => {
  const w = fnBody(GEST, "onWheel");
  assert.ok(/if \(dx !== 0 && dy !== 0 && !ev\.shiftKey\) \{/.test(w) && /deltaX: dx, deltaY: 0/.test(w) && /vdx = 0;/.test(w) && /deltaX: vdx, deltaY: dy/.test(w));
  // the routing of each half
  const s = W.DEFAULT_WHEEL, h = W.wheelAction({ deltaX: 50, deltaY: 0, shiftKey: false, ctrlKey: false, altKey: false }, s, 1000, 800);
  assert.strictEqual(h.kind, "pan"); near(h.dx, -60); near(h.dy, 0);
  assert.deepStrictEqual(W.wheelAction({ deltaX: 0, deltaY: -50, shiftKey: false, ctrlKey: false, altKey: false }, s, 1000, 800), { kind: "zoom", rotation: 60 });
});

// ---------------------------------------------------------------- 11. footprint editor axes
test("11. the footprint editor's axes are its own (Footprint Editor > Origins & Axes); the origin choice stays the PCB Editor's", async () => {
  const store = { v: {}, get() { return { viewport: this.v }; }, slice(k, p) { Object.assign(this.v, p); } };
  const E = { pcbOrigin: { origin: "aux", invertX: true, invertY: false }, fpOrigin: { invertX: false, invertY: true }, pcbOrigins: { aux: [10, 20], grid: [1, 2] }, kdoc: { fpEditor: true }, DOC_TYPE: "footprint" };
  const O = await loadStubbed(["editor", "userorigin.ts"], /\/editor\/(appstore|state)(\.ts)?$/, { "/editor/appstore": { store }, "/editor/state": { E } });
  assert.deepStrictEqual(O.originPrefFor(E.pcbOrigin, E.fpOrigin, true), { origin: "aux", invertX: false, invertY: true });
  assert.deepStrictEqual(O.originPrefFor(E.pcbOrigin, E.fpOrigin, false), E.pcbOrigin);
  O.publishUserOrigin();
  assert.deepStrictEqual([store.v.userOrigin, store.v.invertX, store.v.invertY], [[10, 20], false, true]);
  E.kdoc = {}; E.DOC_TYPE = "kicad_pcb"; O.publishUserOrigin();
  assert.deepStrictEqual([store.v.userOrigin, store.v.invertX, store.v.invertY], [[10, 20], true, false]);
  const P = src("dialogs", "preferences.ts");
  assert.ok(/case "Footprint Editor\/Origins & Axes": st\.p\.fpOrigin = d\.fpOrigin; break;/.test(P) && /group\("X Axis", "fp-xaxis"/.test(P) && /group\("Y Axis", "fp-yaxis"/.test(P));
  assert.ok(/fpOrigin: \{ invertX: false, invertY: false \}/.test(src("dialogs", "prefs.ts")));
});

// ---------------------------------------------------------------- 22. scrollbars
test("22. Show scrollbars in editors: UpdateScrollbars' position / range and onScroll's thumb, line and page steps", async () => {
  const S = await loadStubbed(["editor", "scrollbars.ts"], /\/editor\/(state|view)(\.ts)?$/, { "/editor/state": { E: {} } });
  const b = S.viewBoundaryMm(1e6);   // the board's int range in nm
  near(b.left, -1073.741824, 1e-9); near(b.width, 2147.483647, 1e-9);
  near(S.viewBoundaryMm(1e4).left, -107374.1824, 1e-6);   // the schematic's (100 nm units)
  // a 100 mm wide viewport centred at x = 0 on an 800 px canvas: scale 20 units / mm
  const a = S.scrollAxis(0, 100, b.left, b.width, 800);
  near(a.scale, 20); assert.strictEqual(a.pos, Math.trunc(1073.741824 * 20)); assert.strictEqual(a.range, Math.trunc(20 * 2147.483647 + 800)); assert.strictEqual(a.page, 800);
  const m = S.scrollAxis(0, 100, b.left, b.width, 800, true); assert.strictEqual(m.pos, Math.trunc((b.left + b.width) * 20));   // mirrored: from the right edge
  near(S.centreForThumb(a.pos + 200, a.scale, b.left, b.width), 10, 0.1);
  near(S.centreForThumb(m.pos + 200, m.scale, b.left, b.width, true), -10, 0.1);
  near(S.scrollStep(100, true, true), -50); near(S.scrollStep(100, false, false), 5);
  const P = src("dialogs", "preferences.ts");
  assert.ok(/checkbox\("Show scrollbars in editors", !!p\.common\.showScrollbars/.test(P) && /This change takes effect when relaunching the editor\./.test(P));
  assert.ok(/updateScrollbars\(\)/.test(fnBody(VIEW, "applyView")) && /initScrollbars\(!!p\.common\.showScrollbars\)/.test(src("dialogs", "prefs.ts")));
});

// ---------------------------------------------------------------- flipped board view: peers in document coordinates
test("flipped view: peer pointers, ghosts and followed viewports are document coordinates, mirrored into the view", () => {
  // visibleRectDocNm: VIEW::GetViewport's world box, its x span mirrored back while the view is flipped
  const body = fnBody(VIEW, "visibleRectDocNm"), code = esbuild.transformSync(body.replace(/^export /, ""), { loader: "ts" }).code;
  const mk = (flipped) => new Function("visibleRectNm", "viewFlipped", "flipMmX", "E", code + "\nreturn visibleRectDocNm;")(() => [10e6, 5e6, 20e6, 8e6], () => flipped, (x) => (flipped ? 100 - x : x), { IU: 1e6 });
  assert.deepStrictEqual(mk(false)(), [10e6, 5e6, 20e6, 8e6]);
  assert.deepStrictEqual(mk(true)(), [70e6, 5e6, 20e6, 8e6], "the view's 10..30 is the board's 70..90");
  const PEERS = src("editor", "peers.ts");
  assert.ok(/st\.viewport = vp/.test(PEERS) && /const vp = visibleRectDocNm\(\)/.test(PEERS), "the viewport sent is the document's");
  assert.ok(/flipMmX\(cursor\[0\] \/ E\.IU\)/.test(fnBody(PEERS, "applyFollowWeb")), "following a pointer centres where this view draws it");
  assert.ok(/Math\.min\(flipMmX\(vp\[0\] \/ E\.IU\), flipMmX\(vp\[0\] \/ E\.IU \+ wMm\)\)/.test(fnBody(PEERS, "applyFollowWeb")), "a followed viewport is mirrored");
  assert.ok(/at: \[flipMmX\(st\.cursor\[0\] \/ E\.IU\)/.test(VIEW), "a peer's pointer is drawn mirrored");
  assert.ok(/"x1", flipMmX\(mm\(g\[0\]\)\)/.test(VIEW), "a peer's drawing ghost too");
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n       ")); }
  }
  console.log(`\nview-controls: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
