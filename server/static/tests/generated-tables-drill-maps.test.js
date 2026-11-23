// Node test for KiCad parity round 3 (generated-tables-drill-maps): the drill model (EnumerateDrillSpans /
// DRILL_CHART_MODEL / AssignDrillSymbols), PCB_DRILL_CHART and PCB_STACKUP_TABLE (RebuildCells, IsStale,
// RefreshGeneratedTables, SetColumns, Flip), PCB_DRILL_MAP (parse, write, geometry, move / rotate / flip), the
// placeGenerated tools and Board Characteristics, DIALOG_GENERATED_TABLE_PROPERTIES / DRILL_CHART_TEMPLATE /
// DIALOG_DRILL_GROUPS' logic, the message panel and the drill marks a map suppresses on a plot.
// Run: node server/static/tests/generated-tables-drill-maps.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");
const { webPath } = require("./web-path");

require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb, D = K.drillModel;
const IU = 1e6;
/** A module of web/domains/pcb bundled for node (a dialog's logic half). */
function load(...file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(...file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const GM = load("editor", "pcbdialogs", "generated-tables-model.ts");

const BOARD = `(kicad_pcb (version 20260901) (generator "pcbnew")
 (general (thickness 1.6))
 (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (13 "F.Paste" user) (5 "F.SilkS" user) (7 "B.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user)
   (17 "Dwgs.User" user "User.Drawings") (19 "Cmts.User" user) (25 "Edge.Cuts" user) (35 "F.Fab" user) (33 "B.Fab" user))
 (setup (pad_to_mask_clearance 0))
 (gr_rect (start 0 0) (end 40 30) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "edge"))
 (via (at 5 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0) (uuid "v1"))
 (via (at 10 5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 0) (uuid "v2"))
 (via blind (at 15 5) (size 0.6) (drill 0.2) (layers "F.Cu" "In1.Cu") (net 0) (uuid "v3"))
 (footprint "R" (layer "F.Cu") (uuid "fp1") (at 20 20 90)
   (pad "1" thru_hole circle (at -2 0 90) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (uuid "p1"))
   (pad "2" thru_hole oval (at 2 0 90) (size 1.6 2.4) (drill oval 0.8 1.6) (layers "*.Cu" "*.Mask") (uuid "p2"))
   (pad "" np_thru_hole circle (at 0 3 90) (size 3 3) (drill 3) (layers "*.Cu" "*.Mask") (uuid "p3")))
)`;
const board = () => K.parseDoc(BOARD, "kicad_pcb");
/** The editor's applyChanges: a BOARD_SETUP change goes to the board's sections. */
const apply = (doc, c) => (c.typeName === "BOARD_SETUP" ? K.boardSetup.applyBoardSetup(doc, c) : K.applyChange(doc, c, IU));
function fakeCtx(doc) {
  const log = { commits: [], toasts: [], selection: [] };
  const ctx = {
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 4, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true,
    selection: new Set(), cursor: null, activeLayer: "Dwgs.User",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(list) { log.selection = Array.from(list); ctx.selection = new Set(list); },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) apply(doc, c); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool() {}, showLayer() {}, localOrigin() { return null; }, setLocalOrigin() {},
  };
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const ev = (extra) => Object.assign({ button: 0, shiftKey: false, clientX: 0, clientY: 0 }, extra || {});
const cellTexts = (n) => K.tableModel.tableInfo(n).cells.map((c) => String(c[1]));
const tableOf = (doc, kind) => [...doc.items.values()].find((it) => it.kind === "table" && it.node[0] === kind);
const chartOf = (doc) => { const refresh = { profile: D.cloneProfile(D.boardProfile(doc)) }; const n = D.rebuildGenerated(doc, D.newGeneratedNode("drill_chart", "Dwgs.User", "chart-1"), refresh); return { n, refresh }; };
const addItem = (doc, node) => K.applyChange(doc, { id: K.str(K.kid(node, "uuid")[1]), kind: "ADDED", typeName: "", sexpr: K.serialize(node) }, IU);

test("EnumerateDrillSpans: the through span and the blind one; DRILL_CHART_MODEL groups plated first, by diameter", () => {
  const doc = board();
  const spans = D.enumerateDrillSpans(doc);
  assert.deepEqual(spans.map((s) => [D.spanTop(s), D.spanBottom(s)]), [["F.Cu", "B.Cu"], ["F.Cu", "In1.Cu"]]);
  const m = D.buildChartModel(doc, D.cloneProfile(D.boardProfile(doc)), spans);
  assert.equal(m.totals.groups, m.groups.length);
  assert.equal(m.totals.operations, 6);   // two vias, a blind via, two plated pads, the NPTH hole
  // plated before non-plated, then by diameter
  const plated = m.groups.filter((g) => !g.notPlated), np = m.groups.filter((g) => g.notPlated);
  assert.deepEqual(m.groups, [...plated, ...np]);
  for (let i = 1; i < plated.length; i++) assert.ok(plated[i - 1].diameter <= plated[i].diameter);
  assert.equal(np.length, 1); assert.equal(np[0].diameter, 3e6);
  // the two through vias share a group, the oval pad is a slot
  const vias = m.groups.find((g) => g.diameter === 0.3e6); assert.equal(vias.ops, 2);
  assert.ok(m.groups.some((g) => g.isSlot));
});

test("AssignDrillSymbols: curated shapes in order, the frozen ones kept; the profile stores the assignments by key", () => {
  const doc = board(); const p = D.cloneProfile(D.boardProfile(doc));
  const { groups } = D.buildChartModel(doc, p, D.enumerateDrillSpans(doc));
  D.assignDrillSymbols(groups, p);
  assert.deepEqual(groups.map((g) => g.symbol.mode), groups.map(() => "shape"));
  assert.deepEqual(groups.map((g) => g.symbol.shape).sort((a, b) => a - b), groups.map((_, i) => i));
  const keys = p.assignments.map((a) => a.key); assert.deepEqual(keys, keys.slice().sort());
  // a frozen letter survives a new assignment run, and its shape is not taken by another group
  p.assignments[0] = { ...p.assignments[0], mode: "letter", letter: "Q" };
  const again = D.buildChartModel(doc, p, D.enumerateDrillSpans(doc)).groups; D.assignDrillSymbols(again, p);
  assert.equal(again.find((g) => g.key === keys[0]).symbol.letter, "Q");
  // the letters policy
  const q = D.cloneProfile(D.boardProfile(doc)); q.markPolicy = "letters";
  const lg = D.buildChartModel(doc, q, D.enumerateDrillSpans(doc)).groups; D.assignDrillSymbols(lg, q);
  assert.deepEqual(lg.map((g) => g.symbol.letter).sort(), ["A", "B", "C", "D", "E"].slice(0, lg.length));
});

test("PCB_DRILL_CHART: RebuildCells makes a heading, a row per group with its key, and the totals; not stale after; row shapes written", () => {
  const doc = board(); const { n, refresh } = chartOf(doc); apply(doc, D.profileChange(doc, refresh.profile));
  const T = K.tableModel.tableInfo(n), h = D.readGenerated(n);
  assert.equal(T.cols, D.defaultColumns("drill_chart").length);
  const groups = D.buildChartModel(doc, refresh.profile, D.enumerateDrillSpans(doc)).groups;
  assert.equal(T.rows, 1 + groups.length + 1);   // heading, groups, totals
  assert.deepEqual(cellTexts(n).slice(0, T.cols), D.defaultColumns("drill_chart").map((c) => c.heading));
  assert.equal(h.rowKeys.size, groups.length);
  assert.equal(h.symbolColumn, 0); assert.equal(h.rowShapes.size, groups.length);
  assert.equal(D.generatedStale(doc, n), false);
  // the profile handed back carries an assignment per group
  assert.equal(refresh.profile.assignments.length, groups.length);
  // written: the generated header sits after (layer), the row keys and shapes as (key r "k") / (shape r s)
  const text = K.serialize(n);
  assert.match(text, /^\(drill_chart \(uuid "chart-1"\) \(layer "Dwgs\.User"\) \(column \(id symbol\)\)/);
  assert.match(text, /\(row_keys \(key 1 "/); assert.match(text, /\(row_shapes \(column 0\) \(shape 1 \d+\)/);
  assert.doesNotMatch(text, /\(filter /); assert.doesNotMatch(text, /\(totals no\)/);
  // a new via of a new size makes the chart stale; a rebuild carries the rows by key
  K.applyChange(doc, { id: "v9", kind: "ADDED", typeName: "PCB_VIA", sexpr: '(via (at 30 5) (size 1) (drill 0.5) (layers "F.Cu" "B.Cu") (net 0) (uuid "v9"))' }, IU);
  assert.equal(D.generatedStale(doc, n), true);
  const r2 = { profile: D.cloneProfile(refresh.profile) }; const n2 = D.rebuildGenerated(doc, n, r2); apply(doc, D.profileChange(doc, r2.profile));
  assert.equal(K.tableModel.tableInfo(n2).rows, T.rows + 1); assert.equal(D.generatedStale(doc, n2), false);
});

test("Drill chart filter and totals: (filter …) only when not all on, (totals no) when off; the totals row goes", () => {
  const doc = board(); const { n } = chartOf(doc); const h = D.readGenerated(n);
  h.filter.npth = false; h.totals = false; D.writeGenerated(n, h);
  const text = K.serialize(n);
  assert.match(text, /\(filter \(plated yes\) \(npth no\) \(vias yes\) \(slots yes\) \(backdrill yes\) \(castellated yes\)\)/); assert.match(text, /\(totals no\)/);
  const r = D.rebuildGenerated(doc, n, null, true);
  const groups = D.buildChartModel(doc, D.boardProfile(doc), D.enumerateDrillSpans(doc), { ...D.FILTER_ALL, npth: false }).groups;
  assert.equal(K.tableModel.tableInfo(r).rows, 1 + groups.length);
  assert.equal(D.readGenerated(K.parse(K.serialize(r))).filter.npth, false);
});

test("PCB_STACKUP_TABLE: a row per stackup layer, the board's units; text variables ${DRILL_OPERATIONS} ${DRILL_GROUPS}", () => {
  const doc = board();
  const st = D.rebuildGenerated(doc, D.newGeneratedNode("stackup_table", "Cmts.User", "st-1"), null);
  const T = K.tableModel.tableInfo(st); const texts = cellTexts(st);
  assert.equal(T.cols, 7);
  assert.deepEqual(texts.slice(0, 7), ["Layer Name", "Type", "Material", "Thickness", "Color", "Epsilon R", "Loss Tangent"]);
  assert.equal(T.rows, 1 + D.boardStackup(doc).length);
  assert.ok(texts.includes("F.Cu") || texts.some((t) => /F\.Cu/.test(t)));
  assert.equal(D.generatedStale(doc, st), false);
  assert.equal(D.drillTextVar(doc, "DRILL_OPERATIONS"), "6");
  assert.equal(D.drillTextVar(doc, "DRILL_GROUPS"), String(D.buildChartModel(doc, D.boardProfile(doc), D.enumerateDrillSpans(doc)).groups.length));
  assert.equal(D.drillTextVar(doc, "OTHER"), null);
  // inch units: the thickness column follows
  const st2 = D.rebuildGenerated(doc, D.newGeneratedNode("stackup_table", "Cmts.User", "st-2", "inch"), null);
  assert.ok(cellTexts(st2).some((t) => /″$/.test(t)));
});

test("SetColumns: cells follow their column by id, a hidden column keeps its place; Flip mirrors the columns", () => {
  const doc = board(); const { n } = chartOf(doc);
  const h = D.readGenerated(n); const cols = h.columns.slice().reverse();
  cols[0] = { ...cols[0], visible: false };
  const m = D.setGeneratedColumns(n, cols);
  const before = K.tableModel.tableInfo(n), after = K.tableModel.tableInfo(m);
  assert.equal(after.cols, before.cols - 1);
  // the first shown column now is the old second-last one
  assert.equal(String(after.cells[0][1]), String(before.cells[before.cols - 2][1]));
  assert.match(K.serialize(m), /\(hide yes\)/);
  const f = K.cloneNode(n); D.flipGeneratedHeader(f);
  assert.deepEqual(D.readGenerated(f).columns.map((c) => c.id), h.columns.map((c) => c.id).reverse());
  assert.equal(D.readGenerated(f).symbolColumn, h.columns.length - 1);
});

test("RefreshGeneratedTables: only stale tables, the profile when the assignments changed", () => {
  const doc = board(); const { n, refresh } = chartOf(doc);
  addItem(doc, n);
  apply(doc, D.profileChange(doc, refresh.profile));
  assert.deepEqual(D.refreshGeneratedTables(doc).tables, []);
  K.applyChange(doc, { id: "v1", kind: "REMOVED", typeName: "PCB_VIA", properties: [] }, IU);
  const r = D.refreshGeneratedTables(doc);
  assert.deepEqual(r.tables.map((t) => t.id), ["chart-1"]);
  // the editor's changes: a MODIFIED table
  const ch = GM.generatedRefreshChanges(doc);
  assert.equal(ch[0].kind, "MODIFIED"); assert.equal(ch[0].id, "chart-1");
});

test("drill symbol profile: name and assignments round-trip through the board setup", () => {
  const doc = board(); const p = D.cloneProfile(D.boardProfile(doc));
  p.name = "Fab A"; p.assignments = [{ key: "k2", mode: "letter", shape: 0, letter: "B", descr: "big" }, { key: "k1", mode: "shape", shape: 3, letter: "", descr: "" }, { key: "k3", mode: "size_text", shape: 0, letter: "", descr: "" }];
  apply(doc, D.profileChange(doc, p));
  const q = D.boardProfile(doc);
  assert.equal(q.name, "Fab A");
  assert.deepEqual(q.assignments.map((a) => [a.key, a.mode, a.shape, a.letter, a.descr]), [["k1", "shape", 3, "", ""], ["k2", "letter", 0, "B", "big"], ["k3", "size_text", 0, "", ""]]);
});

test("PCB_DRILL_MAP: parse / write, marks at the holes plus the offset, the outline; move shifts the offset, rotate does nothing, flip changes only the layer", () => {
  const doc = board();
  const node = D.drillMapNode({ layer: "Dwgs.User", offset: [50, 0], size: 1.2, allSpans: true, span: { start: "F.Cu", end: "B.Cu", backdrill: false, npth: false }, outlineSlots: true, guideCross: true, locked: false }, "map-1");
  assert.equal(K.serialize(node), '(drill_map (uuid "map-1") (layer "Dwgs.User") (offset 50 0) (size 1.2) (span all) (outline_slots yes) (guide_cross yes))');
  addItem(doc, node); K.computeBBox(doc);
  const it = doc.items.get("map-1"); assert.equal(it.kind, "drill_map");
  const m = D.readDrillMap(it.node, doc); assert.equal(m.size, 1.2); assert.equal(m.allSpans, true);
  // geometry: marks around (55, 5) (the first via shifted by the offset), the board outline shifted too
  const near = (x, y) => it.geom.some((g) => (g.t === "line" && Math.hypot((g.x1 + g.x2) / 2 - x, (g.y1 + g.y2) / 2 - y) < 1.3) || (g.t === "circle" && Math.hypot(g.x - x, g.y - y) < 1e-6));
  assert.ok(near(55, 5)); assert.ok(!near(5, 5));
  assert.ok(it.geom.every((g) => g.layer === "Dwgs.User"));
  // a single span: only the blind via's
  const sp = D.drillMapSpanChoices(doc); assert.equal(sp[0].label, "All spans"); assert.equal(sp.length, 3);
  assert.equal(sp[2].label, "F.Cu - In1.Cu");
  // transforms
  const { ctx, log } = fakeCtx(doc);
  ctx.setSelection(["map-1"]);
  pcb.runAction("rotateCcw", ctx);
  assert.equal(log.commits.at(-1).label, "Rotate");
  assert.deepEqual(D.readDrillMap(doc.items.get("map-1").node).offset, [50, 0]);
  // a move shifts the offset (the marks stay tied to their holes)
  const mv = doc.items.get("map-1"); apply(doc, K.moveItem(doc, mv, mv.x + 2, mv.y - 3, IU));
  assert.deepEqual(D.readDrillMap(doc.items.get("map-1").node).offset, [52, -3]);
  pcb.runAction("flip", ctx);
  const fm = D.readDrillMap(doc.items.get("map-1").node);
  assert.equal(fm.layer, "Dwgs.User");   // a documentation layer has no back twin: flipped to itself
  assert.deepEqual(fm.offset, [52, -3]);
  // msg panel / description
  assert.equal(P.itemDescription(doc, "map-1", "mm"), "Drill Map on User.Drawings");
  assert.deepEqual(D.drillMapMsg(doc, it.node).rows, [["Drill Map", ""], ["Layer", "User.Drawings"], ["Spans", "All"]]);
});

test("placeDrillChart / placeStackup / placeDrillMap / placeCharacteristics: documentation layer, cascade, one map per layer", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  K.pcbSizes.state.activeLayer = "F.Cu";
  pcb.runAction("placeDrillChart", ctx);
  let c = log.commits.at(-1); assert.equal(c.label, "Place Drill Chart");
  const chart = c.changes.find((x) => x.kind === "ADDED");
  assert.match(chart.sexpr, /\(drill_chart /);
  // F.Cu is not a documentation layer: the first enabled one (Dwgs.User) is taken
  assert.match(chart.sexpr, /\(layer "Dwgs\.User"\)/);
  assert.ok(c.changes.some((x) => x.kind === "MODIFIED"), "the assignments handed out go into the setup");
  P.state.move = null;   // the paste-like placement is left where it hangs
  pcb.runAction("placeStackup", ctx);
  c = log.commits.at(-1); assert.equal(c.label, "Place Board Stackup Table"); assert.match(c.changes[0].sexpr, /\(stackup_table /); P.state.move = null;
  // a drill map: one per documentation layer
  K.pcbSizes.state.activeLayer = "Cmts.User";
  pcb.runAction("placeDrillMap", ctx);
  c = log.commits.at(-1); assert.equal(c.label, "Place Drill Map"); assert.match(c.changes[0].sexpr, /\(layer "Cmts\.User"\)/);
  assert.deepEqual(log.selection, [c.changes[0].id]);
  pcb.runAction("placeDrillMap", ctx);
  c = log.commits.at(-1); assert.match(c.changes[0].sexpr, /\(layer "Dwgs\.User"\)/);
  // Board Characteristics: a four-column table on the active layer
  K.pcbSizes.state.activeLayer = "Dwgs.User";
  pcb.runAction("placeCharacteristics", ctx);
  c = log.commits.at(-1); assert.equal(c.label, "Place Board Characteristics");
  const t0 = K.parse(c.changes[0].sexpr); const t = t0[0] === "table" ? t0 : K.kid(t0, "table"); const texts = cellTexts(t);
  assert.equal(K.num(K.kid(t, "column_count")[1]), 4);
  assert.equal(texts[0], "BOARD CHARACTERISTICS");
  assert.deepEqual(texts.slice(4, 6), ["Copper layer count: ", "4"]);
  assert.ok(texts.includes("Board overall dimensions: ")); assert.match(texts[texts.indexOf("Board overall dimensions: ") + 1], /^40(\.0+)? mm x 30(\.0+)? mm$/);
});

test("Duplicate skips a generated table", () => {
  const doc = board(); const { n } = chartOf(doc); addItem(doc, n);
  const { ctx, log } = fakeCtx(doc);
  ctx.setSelection(["chart-1"]); const before = log.commits.length;
  pcb.runAction("duplicate", ctx);
  assert.equal(log.commits.length, before);
});

test("Generated Table Properties: column rows, placed columns, the refusals, apply with the grouping", () => {
  const doc = board(); const { n, refresh } = chartOf(doc); addItem(doc, n); apply(doc, D.profileChange(doc, refresh.profile));
  const v = GM.generatedValues(doc, n);
  // the table's columns, then the schema's others unticked and not placed
  assert.deepEqual(v.rows.map((r) => r.col.id), [...D.defaultColumns("drill_chart").map((c) => c.id), ...D.DRILL_CHART_COLUMNS.filter((c) => !c.shown).map((c) => c.id)]);
  assert.ok(v.rows.slice(D.defaultColumns("drill_chart").length).every((r) => !r.shown && !r.placed));
  assert.equal(v.filter.plated, true); assert.equal(v.totals, true); assert.deepEqual(v.groupBy, D.boardProfile(doc).groupBy);
  // no column shown
  const none = { ...v, rows: v.rows.map((r) => ({ ...r, shown: false })) };
  assert.equal(GM.generatedError("drill_chart", none), "A table needs at least one column.");
  const wide = { ...v, rows: v.rows.map((r) => ({ ...r, shown: true, col: { ...r.col, width: 1000 } })) };
  assert.equal(GM.generatedError("drill_chart", wide), "The columns are too wide in total.");
  assert.equal(GM.generatedError("drill_chart", v), null);
  // tick "Site count", inch units, 2 places, drop the totals, group also by hole function
  const w = { ...v, units: "inch", precision: 2, totals: false, groupBy: [...v.groupBy, "hole_function"], rows: v.rows.map((r) => (r.col.id === "site_count" ? { ...r, shown: true } : r)) };
  const r = GM.applyGenerated(doc, n, w);
  const h = D.readGenerated(r.node);
  assert.equal(h.units, "inch"); assert.equal(h.precision, 2); assert.equal(h.totals, false);
  assert.ok(h.columns.some((c) => c.id === "site_count" && c.visible));
  assert.ok(!h.columns.some((c) => c.id === "description"));   // never placed, never ticked: left out
  assert.ok(r.profile && r.profile.groupBy.includes("hole_function"));
  assert.ok(cellTexts(r.node).some((t) => /″$/.test(t)));
  // the border off: no stroke written
  const b = GM.applyGenerated(doc, n, { ...v, external: false, header: false });
  assert.doesNotMatch(K.serialize(K.kid(b.node, "border")), /stroke/);
  assert.equal(b.profile, null);
});

test("DRILL_CHART_TEMPLATE: save / load; bad files refused", () => {
  const cols = D.defaultColumns("drill_chart"); cols[1] = { ...cols[1], width: 12.5 };
  const text = GM.templateJson({ name: "fab", version: 1, units: "mils", precision: 1, showTotals: false, columns: cols });
  const js = JSON.parse(text);
  assert.deepEqual(Object.keys(js), ["name", "version", "units", "precision", "show_totals", "columns"]);
  assert.equal(js.columns[1].width, 12500000); assert.equal(js.columns[0].align, "center");
  const t = GM.parseTemplate(text);
  assert.equal(t.units, "mils"); assert.equal(t.precision, 1); assert.equal(t.showTotals, false); assert.equal(t.columns[1].width, 12.5);
  assert.deepEqual(GM.parseTemplate("[1]"), { error: "Template is not a JSON object." });
  assert.deepEqual(GM.parseTemplate('{"columns":[{"id":"nope"}]}'), { error: "Template has no usable columns." });
  assert.equal(GM.parseTemplate('{"precision": 9, "columns":[{"id":"symbol"}]}').precision, 6);
  assert.equal(GM.parseTemplate('{"columns":[{"id":"symbol"}]}').columns[0].align, "left");
});

test("Drill Groups: rows as the dialog shows them; an edit of a group's mark stores an assignment, the same one does not", () => {
  const doc = board(); const groups = GM.drillGroups(doc);
  const rows = groups.map(GM.groupRow);
  assert.equal(rows[0].symbol, "Shape 1");
  const slot = groups.findIndex((g) => g.isSlot); assert.equal(rows[slot].size, "0.800 x 1.600");
  assert.equal(rows[groups.findIndex((g) => g.diameter === 0.3e6)].size, "0.300");
  assert.equal(rows[groups.findIndex((g) => g.notPlated)].plated, "No");
  assert.equal(rows[0].span, "F.Cu / In1.Cu"); assert.equal(rows[1].span, "F.Cu / B.Cu");
  assert.equal(GM.markText({ mode: "letter", letter: "X", shape: 0, descr: "" }, 1e6), "X");
  assert.equal(GM.markText({ mode: "size_text", letter: "", shape: 0, descr: "" }, 1234567), "1.23");
  const p = GM.assignmentEdit(doc, groups[0].key, { mode: "letter", shape: 0, letter: "Z", descr: "edge" });
  assert.ok(p); apply(doc, D.profileChange(doc, p));
  assert.equal(GM.drillGroups(doc)[0].symbol.letter, "Z");
  assert.equal(GM.assignmentEdit(doc, groups[0].key, { mode: "letter", shape: 0, letter: "Z", descr: "edge" }), null);
});

test("Selection: a drill map on the active layer is preferred over the via under it, one on another layer falls through", () => {
  const doc = board();
  addItem(doc, D.drillMapNode({ layer: "Dwgs.User", offset: [0, 0], size: 1.5, allSpans: true, span: { start: "F.Cu", end: "B.Cu", backdrill: false, npth: false }, outlineSlots: true, guideCross: false, locked: false }, "map-1"));
  K.computeBBox(doc);
  const ids = ["v1", "map-1"];
  assert.deepEqual(P.guessCandidates(doc, ids, [5, 5], { activeLayer: "Dwgs.User", px: 0.05 }), ["map-1"]);
  assert.deepEqual(P.guessCandidates(doc, ids, [5, 5], { activeLayer: "F.Cu", px: 0.05 }), ["v1"]);
});
