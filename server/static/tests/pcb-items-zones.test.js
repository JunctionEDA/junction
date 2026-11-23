// pcb-items-zones.test.js — the board items' message panel rows, item descriptions, the composite netclass and the
// Properties panel rows as pcbnew registers them (GetMsgPanelInfo / GetItemDescription of pcb_text.cpp,
// pcb_textbox.cpp, pcb_dimension.cpp, pcb_group.cpp, zone.cpp, pad.cpp, footprint.cpp, pcb_track.cpp; the *_DESC
// property registrations; PAD::SetAttribute / SetFrontShape; NET_SETTINGS::GetEffectiveNetClass).
// Run: node server/static/tests/pcb-items-zones.test.js
"use strict";
const path = require("path"), assert = require("assert");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
require(path.join(__dirname, "..", "props.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, H = globalThis.CollabTools.props.helpers;

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function runTest(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + String(e && e.stack || e).split("\n").slice(0, 5).join("\n       ")); } }
const val = (list, title) => { const c = list.find((x) => x.title === title); return c ? c.value : undefined; };

// ---------------------------------------------------------------- the Properties panel, bundled with its editor-state modules stubbed
const STUB = /(\/editor\/state|\/panels\/core|\/panels\/appearance|\/editor\/util|browse-cells|library\/fpchoice|editor\/schnets|sync-units|pcbdialogs\/item-props|editor\/userorigin|editor\/appstore|panes\/prop-text|kcombo|kicon-dom|dialogs\/dom|pcbdialogs\/xref|dialogs\/sch-symbol-sheet|editor\/selection|editor\/variant|cvpcb\/widgets)(\.ts)?$/;
const STUBS = {};
const stubPlugin = { name: "stub", setup(b) {
  b.onResolve({ filter: /.*/ }, (a) => { if (!a.path.startsWith(".")) return undefined; const full = path.resolve(a.resolveDir, a.path); return STUB.test(full) ? { path: full, namespace: "stub" } : undefined; });
  b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: `module.exports = globalThis.__pgStub(${JSON.stringify(a.path)});`, loader: "js" }));
} };
globalThis.window = globalThis;
globalThis.__pgStub = (p) => { const key = Object.keys(STUBS).find((k) => p.includes(k)); const base = key ? STUBS[key] : {}; return new Proxy(base, { get: (t, k) => (k === "__esModule" ? false : k in t ? t[k] : () => null) }); };
const E = { selection: new Set(), selPins: [], units: "mm", viewOnly: false, selected: null, selField: null };
const commits = [];
const PG = { doc: null };
STUBS["/editor/state"] = { E };
const asked = [];
STUBS["cvpcb/widgets"] = { askBox: (title) => { asked.push(title); return new Promise(() => {}); } };   // the Yes / No box, left unanswered
STUBS["/editor/variant"] = { currentVariant: () => "" };   // the default variant (variant.ts pulls in the whole editor)
STUBS["/editor/userorigin"] = { fromDisplayAbsAxis: (v) => v, toDisplayAbsAxis: (v) => v };
STUBS["/panels/core"] = { KC: () => K, isSchDoc: () => false, kdoc: () => PG.doc, pcbTools: () => P, tctx: () => ({ doc: PG.doc, commit: (ch, what) => commits.push({ ch, what }) }), panelStore: { get: () => ({ selVersion: 0 }), set: () => {} } };
STUBS["/panels/appearance"] = { layerDisplayName: (d, l) => l, netClassOf: () => "Default" };
STUBS["pcbdialogs/item-props"] = { setNet: (doc, n, net) => { const k = n.find((c) => Array.isArray(c) && c[0] === "net"); if (k) k[1] = net; else n.push(["net", net]); } };
let G = null;   // propgrid.ts's exports, once bundled (plugins need esbuild's async API)
/** the grid of the items with these ids: { title, rows: { "Group/Name": row } } */
function grid(doc, ids) {
  PG.doc = doc; E.selection = new Set(ids); P.state.sel = new Set(); commits.length = 0;
  const g = G.propGrid(); const rows = {}; const order = [];
  for (const grp of g.groups) for (const r of grp.rows) { rows[grp.name + "/" + r.name] = r; order.push(grp.name + "/" + r.name); }
  return { title: g.title, rows, order, groups: g.groups.map((x) => x.name) };
}
/** set a property of the selection; the committed node of the first item, else the error text */
function setProp(doc, ids, id, text) {
  grid(doc, ids); const err = G.setProp(id, text); if (err) return err;
  return commits.length ? commits[0].ch[0] : null;
}
/** the item a replace change carries: its (kicad_pcb …) wrapper's last child */
const nodeOf = (ch) => { if (!ch || !ch.sexpr) return null; const root = K.parse(ch.sexpr); return root[root.length - 1]; };
const changeText = (ch) => (ch && ch.sexpr ? K.serialize(nodeOf(ch)) : JSON.stringify(ch));

const BOARD = (body, version = 20260728) => K.parseDoc(`(kicad_pcb (version ${version}) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (2 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (49 "F.Fab" user) (35 "F.Paste" user) (25 "Dwgs.User" user))
  (net 0 "") (net 1 "GND") (net 2 "/SIG")
  ${body})`, "kicad_pcb");


// ================================================================ message panel and descriptions
test("message panel: PCB_TEXT, PCB_TEXTBOX, PCB_GROUP rows instead of the board summary", () => {
  const doc = BOARD(`(gr_text "Hello" (at 10 10 30) (layer "F.SilkS") (uuid "t-1") (effects (font (size 1.5 1.2) (thickness 0.2)) (justify mirror)))
  (gr_text "Auto" (at 20 10) (layer "F.SilkS") (uuid "t-2") (effects (font (face "Arial") (size 1 1))))
  (gr_text_box "Box" (start 0 0) (end 4 2) (margins 0.1 0.1 0.1 0.1) (layer "F.SilkS") (uuid "tb-1") (effects (font (size 1 1) (thickness 0.15))) (border yes) (stroke (width 0.12) (type dash)))
  (group "Pair" (uuid "g-1") (members "t-1" "t-2"))
  (group "" (uuid "g-2") (locked yes) (members "tb-1"))`);
  const t = P.msgPanelInfo(doc, ["t-1"], { settings: P.designSettings(null) });
  assert.deepStrictEqual(t.map((c) => c.title), ["PCB Text", "Layer", "Mirror", "Angle", "Font", "Text Thickness", "Width", "Height"]);
  assert.strictEqual(val(t, "PCB Text"), "Hello"); assert.strictEqual(val(t, "Mirror"), "Yes"); assert.strictEqual(val(t, "Angle"), "30");
  assert.strictEqual(val(t, "Font"), "Default"); assert.strictEqual(val(t, "Width"), "1.2000 mm"); assert.strictEqual(val(t, "Height"), "1.5000 mm");
  const t2 = P.msgPanelInfo(doc, ["t-2"], {});
  assert.strictEqual(val(t2, "Font"), "Arial"); assert.strictEqual(val(t2, "Text Thickness"), "Auto"); assert.strictEqual(val(t2, "Mirror"), "No");
  const tb = P.msgPanelInfo(doc, ["tb-1"], {});
  assert.deepStrictEqual(tb.map((c) => c.title), ["Text Box", "Layer", "Mirror", "Angle", "Font", "Text Thickness", "Text Width", "Text Height", "Box Width", "Box Height", "Line Style", "Line Width"]);
  assert.strictEqual(val(tb, "Box Width"), "4.0000 mm"); assert.strictEqual(val(tb, "Line Style"), "Dashed"); assert.strictEqual(val(tb, "Line Width"), "0.1200 mm");
  assert.deepStrictEqual(P.msgPanelInfo(doc, ["g-1"], {}), [{ title: "Group", value: "Pair" }, { title: "Members", value: "2" }]);
  assert.deepStrictEqual(P.msgPanelInfo(doc, ["g-2"], {}), [{ title: "Group", value: "<unnamed>" }, { title: "Members", value: "1" }, { title: "Status", value: "Locked" }]);
  // the text goes through the panel's EllipsizeStatusText
  assert.strictEqual(val(P.msgPanelInfo(doc, ["t-1"], { ellipsize: (s) => s.slice(0, 2) + "..." }), "PCB Text"), "He...");
});

test("item descriptions: text, text box, group, teardrop zone, footprint editor pad; EllipsizeMenuText 36 / 34", () => {
  const long = "A".repeat(40);
  const doc = BOARD(`(gr_text "${long}" (at 0 0) (layer "F.SilkS") (uuid "t-1") (effects (font (size 1 1))))
  (gr_text "two{slash}lines\\nhere" (at 0 0) (layer "F.SilkS") (uuid "t-2") (effects (font (size 1 1))))
  (gr_text_box "Box" (start 0 0) (end 4 2) (layer "F.SilkS") (uuid "tb-1") (effects (font (size 1 1))))
  (group "Pair" (uuid "g-1") (members "t-1" "t-2"))
  (group (uuid "g-2") (members "tb-1"))
  (zone (net "GND") (layer "F.Cu") (uuid "z-1") (attr (teardrop (type padvia))) (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1)))))`);
  assert.strictEqual(P.itemDescription(doc, "t-1", "mm"), `PCB text '${"A".repeat(34)}...' on F.SilkS`);
  assert.strictEqual(P.itemDescription(doc, "t-2", "mm"), "PCB text 'two/lines here' on F.SilkS");
  assert.strictEqual(P.itemDescription(doc, "tb-1", "mm"), "PCB text box 'Box' on F.SilkS");
  assert.strictEqual(P.itemDescription(doc, "g-1", "mm"), "Group 'Pair', 2 members");
  assert.strictEqual(P.itemDescription(doc, "g-2", "mm"), "Unnamed Group, 1 members");
  assert.strictEqual(P.itemDescription(doc, "z-1", "mm"), "Teardrop [GND] on F.Cu");
});

test("zone message panel: GetFriendlyName types, rule area Outline Area, Corner Count last", () => {
  const doc = BOARD(`(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z-1") (priority 2) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10))) (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 10 0) (xy 10 10) (xy 0 10) (xy 0 5))))
  (zone (net 0) (net_name "") (layer "F.SilkS") (uuid "z-2") (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "z-3") (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed))
    (placement (enabled yes) (sheetname "/power/")) (polygon (pts (xy 0 0) (xy 4 0) (xy 4 2) (xy 0 2))))`);
  const s = P.designSettings(null);
  const z1 = P.msgPanelInfo(doc, ["z-1"], { settings: s });
  assert.strictEqual(val(z1, "Type"), "Copper Zone"); assert.strictEqual(z1[z1.length - 1].title, "Corner Count"); assert.strictEqual(val(z1, "Corner Count"), "5");
  assert.strictEqual(val(P.msgPanelInfo(doc, ["z-2"], { settings: s }), "Type"), "Non-copper Zone");
  const z3 = P.msgPanelInfo(doc, ["z-3"], { settings: s });
  assert.strictEqual(val(z3, "Type"), "Rule Area"); assert.strictEqual(val(z3, "Restrictions"), "No tracks"); assert.strictEqual(val(z3, "Placement source"), "/power/");
  assert.strictEqual(val(z3, "Outline Area"), "8.000 mm²"); assert.strictEqual(val(z3, "Corner Count"), "4");
});

test("pad message panel: footprint editor rows (no Footprint / Net, SMD Area), %g rotation, Length in Package", () => {
  const doc = BOARD(`(footprint "L:R" (layer "F.Cu") (at 10 10 90) (uuid "fp-1")
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "p1") (effects (font (size 1 1))))
    (pad "1" smd rect (at 0 0 213.45) (size 1 2) (layers "F.Cu" "F.Mask") (net 1 "GND") (die_length 1.5) (uuid "pad-1")))`);
  const s = P.designSettings(null);
  const pd = P.msgPanelInfo(doc, ["fp-1#0"], { settings: s });
  assert.strictEqual(val(pd, "Footprint"), "R1"); assert.strictEqual(val(pd, "Net"), "GND");
  assert.strictEqual(val(pd, "Rotation"), "123.45(+ 90)", "%g(+ %g): six significant digits");
  assert.strictEqual(val(pd, "Length in Package"), "1.5000 mm");
  doc.fpEditor = true;
  const fe = P.msgPanelInfo(doc, ["fp-1#0"], { settings: s });
  assert.strictEqual(val(fe, "Footprint"), undefined); assert.strictEqual(val(fe, "Net"), undefined); assert.strictEqual(val(fe, "Resolved Netclass"), undefined);
  assert.strictEqual(val(fe, "Area"), "2.000 mm²");
});

test("footprint message panel: exclude from simulation before DNP, Component Class", () => {
  const doc = BOARD(`(footprint "L:R" (layer "F.Cu") (at 10 10) (uuid "fp-1") (component_classes (class "Analog") (class "Power"))
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "p1") (effects (font (size 1 1))))
    (property "Value" "1k" (at 0 0) (layer "F.Fab") (uuid "p2") (effects (font (size 1 1))))
    (attr smd exclude_from_bom exclude_from_sim dnp))`);
  const fp = P.msgPanelInfo(doc, ["fp-1"], { settings: P.designSettings(null) });
  const st = fp.find((c) => /^Status: /.test(c.title)); assert.strictEqual(st.value, "Attributes: exclude from BOM, exclude from simulation, DNP");
  assert.strictEqual(val(fp, "Component Class"), "Analog and Power");
});

test("shape message panel: Line Style and Line Width before Layer (STROKE_PARAMS::GetMsgPanelInfo)", () => {
  const doc = BOARD(`(gr_line (start 0 0) (end 3 4) (stroke (width 0.15) (type dot)) (layer "Dwgs.User") (uuid "l-1"))
  (gr_rect (start 0 0) (end 3 4) (stroke (width 0.1) (type default)) (fill no) (layer "Dwgs.User") (uuid "r-1"))`);
  const l = P.msgPanelInfo(doc, ["l-1"], {}); const ti = l.map((c) => c.title);
  assert.ok(ti.indexOf("Line Style") >= 0 && ti.indexOf("Line Width") === ti.indexOf("Line Style") + 1 && ti.indexOf("Layer") === ti.indexOf("Line Width") + 1, ti.join(","));
  assert.strictEqual(val(l, "Line Style"), "Dotted"); assert.strictEqual(val(l, "Line Width"), "0.1500 mm");
  assert.strictEqual(val(P.msgPanelInfo(doc, ["r-1"], {}), "Line Style"), "Default");
});

test("track and via panel: pad-to-die and full length, the ARC_LOW_DEF copper area, via annular width from a custom rule", () => {
  const doc = BOARD(`(footprint "L:R" (layer "F.Cu") (at 0 0) (uuid "fp-1")
    (property "Reference" "R1" (at 0 0) (layer "F.SilkS") (uuid "p1") (effects (font (size 1 1))))
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (die_length 2) (uuid "pad-1")))
  (segment (start 0 0) (end 10 0) (width 0.2) (layer "F.Cu") (net 1) (uuid "s-1"))
  (via (at 10 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v-1"))`);
  const s = P.designSettings(null);
  const tr = P.msgPanelInfo(doc, ["s-1"], { settings: s });
  assert.strictEqual(val(tr, "Routed Length"), "10.0000 mm"); assert.strictEqual(val(tr, "Pad To Die Length"), "2.0000 mm"); assert.strictEqual(val(tr, "Full Length"), "12.0000 mm");
  // TransformOvalToPolygon( ARC_LOW_DEF = 0.02 mm, ERROR_INSIDE ): the polygon, a little under the exact stadium
  const exact = 10 * 0.2 + Math.PI * 0.01; const area = parseFloat(val(tr, "Copper Area"));
  assert.ok(area < exact && area > exact - 0.01, String(area));
  P.state.dru = P.parseDru(`(version 1)\n(rule "vias wide" (condition "A.Type == 'Via'") (constraint annular_width (min 0.15mm)))`);
  try {
    const v = P.msgPanelInfo(doc, ["v-1"], { settings: s });
    const a = v.find((c) => /^Min Annular Width/.test(c.title)); assert.strictEqual(a.title, "Min Annular Width: 0.1500 mm"); assert.strictEqual(a.value, "(from rule 'vias wide')");
  } finally { P.state.dru = null; }
  const v2 = P.msgPanelInfo(doc, ["v-1"], { settings: s }); assert.strictEqual(v2.find((c) => /^Min Annular Width/.test(c.title)).value, "(from board setup constraints)");
});

test("NET_SETTINGS::GetEffectiveNetClass: a net in two classes gets their composite and 'A and B'", () => {
  const s = P.designSettings({ net_settings: {
    classes: [{ name: "Default", clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, priority: 2147483647 },
      { name: "HV", clearance: 1.0, priority: 0 }, { name: "Wide", track_width: 1.0, priority: 1 }, { name: "Fast", clearance: 0.3, track_width: 0.3, via_diameter: 0.5, via_drill: 0.25, priority: 5 }],
    netclass_assignments: { "/MAINS": ["Wide", "HV"], "/CLK": "Fast" }, netclass_patterns: [{ pattern: "/CLK*", netclass: "HV" }] } });
  assert.strictEqual(P.netclassName(s, "/MAINS"), "HV, Wide and Default", "sorted by priority; Default fills the parameters neither sets");
  const nc = P.netclassOf(s, "/MAINS"); assert.strictEqual(nc.clearance, 1.0); assert.strictEqual(nc.track_width, 1.0); assert.strictEqual(nc.via_diameter, 0.6, "the rest from Default");
  assert.strictEqual(P.netClearance(s, "/MAINS"), 1.0);
  assert.strictEqual(P.netclassName(s, "/CLK"), "HV, Fast and Default", "the assignment and the matching pattern");
  assert.strictEqual(P.netClearance(s, "/CLK"), 1.0, "the higher-priority class wins");
  assert.strictEqual(P.netclassName(s, "/OTHER"), "Default");
});

// ================================================================ pad edits (props.js setPad)
test("PAD::SetAttribute: SMD keeps one copper layer and loses its drills, NPTH loses number and net, PTH spans all copper", () => {
  const fp = K.parse(`(footprint "L:X" (layer "F.Cu") (at 0 0) (uuid "f") (pad "1" thru_hole circle (at 0 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "p")))`);
  assert.ok(H.setPad(fp, 0, { type: "smd" }));
  assert.strictEqual(K.serialize(H.padNode(fp, 0)).replace(/\s+/g, " "), '(pad "1" smd circle (at 0 0) (size 1.6 1.6) (layers "B.Cu" "*.Mask") (net 1 "GND") (uuid "p"))');
  assert.ok(H.setPad(fp, 0, { type: "thru_hole" }));
  assert.match(K.serialize(H.padNode(fp, 0)), /\(layers "\*\.Cu" "\*\.Mask"\)/);
  assert.ok(H.setPad(fp, 0, { type: "np_thru_hole" }));
  const np = H.padNode(fp, 0); assert.strictEqual(np[1], ""); assert.ok(!np.some((c) => Array.isArray(c) && c[0] === "net"));
  const fp2 = K.parse(`(footprint "L:X" (layer "F.Cu") (at 0 0) (uuid "f") (pad "2" thru_hole rect (at 0 0) (size 1 1) (drill 0.5) (layers "F.Cu" "In1.Cu" "F.Mask") (uuid "p")))`);
  H.setPad(fp2, 0, { type: "connect" }); assert.match(K.serialize(H.padNode(fp2, 0)), /\(layers "F\.Cu" "F\.Mask"\)/);
  assert.ok(!K.serialize(H.padNode(fp2, 0)).includes("drill"));
  assert.ok(H.PAD_TYPES.includes("non_component") && H.PAD_SHAPES.includes("chamfered_rect"));
});

test("PAD::SetFrontShape: a pad that becomes roundable takes GetDefaultIpcRoundingRatio; an oblong hole stays oblong at X = Y", () => {
  const fp = K.parse(`(footprint "L:X" (layer "F.Cu") (at 0 0) (uuid "f") (pad "1" smd rect (at 0 0) (size 2 3) (layers "F.Cu") (uuid "p")) (pad "2" smd rect (at 0 0) (size 0.6 3) (layers "F.Cu") (uuid "q"))
    (pad "3" thru_hole oval (at 0 0) (size 2 3) (drill oval 1 1.5) (layers "*.Cu") (uuid "r")))`);
  H.setPad(fp, 0, { shape: "chamfered_rect" }); assert.match(K.serialize(H.padNode(fp, 0)), /\(roundrect_rratio 0\.125\)/, "min(0.25 mm, 0.25 x 2) / 2");
  H.setPad(fp, 1, { shape: "roundrect" }); assert.match(K.serialize(H.padNode(fp, 1)), /\(roundrect_rratio 0\.25\)/, "0.15 / 0.6");
  H.setPad(fp, 2, { drill: [1, 1], drillShape: "oval" }); assert.match(K.serialize(H.padNode(fp, 2)), /\(drill oval 1 1\)/);
});

// ================================================================ the Properties panel
const FP_BOARD = () => BOARD(`(footprint "L:R" (layer "F.Cu") (at 10 10 30) (uuid "fp-1")
    (property "Reference" "R1" (at 0 -1 30) (layer "F.SilkS") (uuid "p1") (effects (font (size 1 1))))
    (property "Value" "1k" (at 0 1 30) (layer "F.Fab") (uuid "p2") (effects (font (size 1 1))))
    (attr smd)
    (pad "1" smd rect (at -1 0 30) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste") (net 1 "GND") (uuid "pad-1")))
  (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "s-1"))
  (via (at 5 0) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1) (uuid "v-1"))
  (zone (net 0) (net_name "") (layer "F.Cu") (uuid "z-1") (name "keep") (keepout (tracks not_allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy 0 0) (xy 4 0) (xy 4 2))))
  (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z-2") (priority 1) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 4 0) (xy 4 2))))
  (zone (net 0) (net_name "") (layer "F.SilkS") (uuid "z-3") (polygon (pts (xy 0 0) (xy 4 0) (xy 4 2))))
  (gr_poly (pts (xy 1 1) (xy 3 1) (xy 3 3)) (stroke (width 0.1) (type solid)) (fill no) (layer "Dwgs.User") (uuid "poly-1"))
  (gr_line (start 0 0) (end 2 0) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "l-1"))
  (gr_arc (start 1 0) (mid 0.7071 0.7071) (end 0 1) (stroke (width 0.1) (type solid)) (layer "Dwgs.User") (uuid "a-1"))
  (group "G1" (uuid "g-1") (members "l-1"))`);

test("properties: Net in Basic Properties with no Net Class row; arc track caption; zone captions", () => {
  const doc = FP_BOARD();
  const t = grid(doc, ["s-1"]);
  assert.ok(t.rows["Basic Properties/Net"] && t.rows["Basic Properties/Net"].netSelector);
  assert.ok(!Object.keys(t.rows).some((k) => /Net Class/.test(k)));
  assert.deepStrictEqual(t.order.slice(0, 8), ["Basic Properties/Locked", "Basic Properties/Layer", "Basic Properties/Net", "Basic Properties/Width", "Basic Properties/Start X", "Basic Properties/Start Y", "Basic Properties/End X", "Basic Properties/End Y"]);
  assert.ok(t.rows["Technical Layers/Soldermask"] && t.rows["Technical Layers/Soldermask Margin Override"]);
  assert.strictEqual(grid(doc, ["z-1"]).title, "Rule Area"); assert.strictEqual(grid(doc, ["z-2"]).title, "Copper Zone"); assert.strictEqual(grid(doc, ["z-3"]).title, "Non-copper Zone");
  assert.strictEqual(grid(doc, ["l-1"]).title, "Segment");
});

test("properties: negative solder paste margin is accepted; footprint Layer flips left-right (180 - orientation)", () => {
  const doc = FP_BOARD();
  const ch = setProp(doc, ["fp-1"], "Overrides/Solderpaste Margin Override", "-0.05");
  assert.ok(typeof ch !== "string", ch); assert.match(changeText(ch), /\(solder_paste_margin -0\.05\)/);
  const fl = setProp(doc, ["fp-1"], "Basic Properties/Layer", "B.Cu"); assert.ok(typeof fl !== "string", fl);
  const n = nodeOf(fl); assert.strictEqual(K.atOf(n)[2], 150);
  const g = grid(doc, ["fp-1"]); assert.ok(g.rows["Basic Properties/Scale X"] && g.rows["Attributes/Exclude From Simulation"] && g.rows["Overrides/Zone Connection Style"]);
  // PCB_PROPERTIES_PANEL::valueChanging: scaling a footprint with pads asks "Scale footprint with pads?" first
  commits.length = 0; assert.strictEqual(setProp(doc, ["fp-1"], "Basic Properties/Scale X", "2"), null); assert.deepStrictEqual(asked, ["Scale footprint with pads?"]);
  const bare = BOARD(`(footprint "L:R" (layer "F.Cu") (at 10 10 30) (uuid "fp-1") (attr smd))`);
  commits.length = 0; const sc = setProp(bare, ["fp-1"], "Basic Properties/Scale X", "2"); assert.match(changeText(sc), /\(transform \(translate 10 10\) \(rotate 30\) \(scale 2 1\)\)/);
  assert.strictEqual(setProp(doc, ["fp-1"], "Basic Properties/Scale X", "0"), "Scale must be a positive number.", "valueChanging vetoes zero (ShowInfoBarError)");
});

test("properties: via sanitising and ValidateViaParameters messages", () => {
  const doc = FP_BOARD();
  assert.strictEqual(setProp(doc, ["v-1"], "Via Properties/Diameter", "0.3"), "Via hole size must be smaller than via diameter");
  assert.strictEqual(setProp(doc, ["v-1"], "Via Properties/Layer Top", "B.Cu"), "Via start layer and end layer cannot be the same");
  assert.strictEqual(setProp(doc, ["v-1"], "Via Properties/Layer Bottom", "In1.Cu"), null, "a through via keeps F.Cu / B.Cu");
  const bl = setProp(doc, ["v-1"], "Via Properties/Via Type", "blind"); assert.match(changeText(bl), /\(via blind/);
  const g = grid(doc, ["v-1"]);
  for (const r of ["Basic Properties/Automatically Update Net", "Via Properties/Front Tenting", "Backdrill/Backdrill Mode", "Post-machining/Front Post-machining", "Teardrops/Enable Teardrops"]) assert.ok(g.rows[r], r);
  const td = setProp(doc, ["v-1"], "Teardrops/Enable Teardrops", "1"); assert.match(changeText(td), /\(teardrops/);
});

test("properties: zones (no Layer row, Priority only on copper zones, Keepout and Placement on rule areas, hatch rows)", () => {
  const doc = FP_BOARD();
  const ra = grid(doc, ["z-1"]);
  assert.ok(!ra.rows["Basic Properties/Priority"] && !ra.rows["Basic Properties/Layer"]);
  assert.strictEqual(ra.rows["Keepout/Keep Out Tracks"].value, "1"); assert.ok(ra.rows["Placement/Enable"]);
  const cz = grid(doc, ["z-2"]);
  assert.ok(cz.rows["Basic Properties/Priority"] && cz.rows["Fill Style/Hatch Width"] && cz.rows["Fill Style/Remove Islands"]);
  assert.ok(cz.rows["Fill Style/Hatch Width"].readOnly, "writable only when hatched");
  assert.ok(!grid(doc, ["z-3"]).rows["Basic Properties/Priority"]);
  assert.strictEqual(setProp(doc, ["z-2"], "Electrical/Minimum Width", "0.01"), "Value must be greater than or equal to 0.025 mm");
});

test("properties: shapes (Shape, Fill enum, polygon position, line endings, arc Angle), group Name", () => {
  const doc = FP_BOARD();
  const pg = grid(doc, ["poly-1"]);
  assert.strictEqual(pg.title, "Polygon"); assert.ok(pg.rows["Basic Properties/Position X"] && pg.rows["Shape Properties/Fill"] && pg.rows["Shape Properties/Line Style"]);
  const mv = setProp(doc, ["poly-1"], "Basic Properties/Position X", "2"); assert.match(changeText(mv), /\(pts \(xy 2 1\) \(xy 4 1\) \(xy 4 3\)\)/);
  const fill = setProp(doc, ["poly-1"], "Shape Properties/Fill", "hatch"); assert.match(changeText(fill), /\(fill hatch\)/);
  const ln = grid(doc, ["l-1"]); assert.ok(ln.rows["Shape Properties/Start Shape"] && ln.rows["Shape Properties/End Stroke Width"]);
  const es = setProp(doc, ["l-1"], "Shape Properties/End Shape", "arrow"); assert.match(changeText(es), /\(stroke \(width 0\.1\) \(type solid\)\) \(end_shape arrow\)/);
  assert.ok(!grid(doc, ["poly-1"]).rows["Shape Properties/Start Shape"], "a polygon is closed");
  assert.strictEqual(setProp(doc, ["a-1"], "Shape Properties/Angle", "0"), "Arc angle must not be zero.");
  const g = grid(doc, ["g-1"]); assert.ok(g.rows["Group Properties/Name"]);
  const rn = setProp(doc, ["g-1"], "Group Properties/Name", "Renamed"); assert.match(changeText(rn), /\(group "Renamed"/);
});

test("properties: pad rows (chamfered rectangle, Non-component, Teardrops) and pad validators", () => {
  const doc = FP_BOARD();
  const g = grid(doc, ["fp-1"]);
  const type = g.rows["Pad Properties/Pad Type"], shape = g.rows["Pad Properties/Pad Shape"];
  assert.ok(type.choices.some((c) => c[0] === "non_component") && shape.choices.some((c) => c[0] === "chamfered_rect"));
  assert.ok(g.rows["Teardrops/Enable Teardrops"]);
  assert.strictEqual(setProp(doc, ["fp-1"], "Pad Overrides/Thermal Relief Gap", "-0.1"), "Value must be greater than or equal to 0 mm");
  assert.strictEqual(setProp(doc, ["fp-1"], "Pad Overrides/Thermal Relief Spoke Width", "0.01"), "Value must be greater than or equal to 0.025 mm");
  const ch = setProp(doc, ["fp-1"], "Pad Properties/Pad Type", "np_thru_hole"); assert.match(changeText(ch), /\(pad "" np_thru_hole/);
});

esbuild.build({ entryPoints: [webPath("editor", "panels", "propgrid.ts")], bundle: true, format: "cjs", write: false, logLevel: "silent", platform: "node", plugins: [stubPlugin] }).then((pgBuild) => {
  const pgMod = { exports: {} }; new Function("module", "exports", "require", pgBuild.outputFiles[0].text)(pgMod, pgMod.exports, require);
  G = pgMod.exports;
  for (const [name, fn] of queue) runTest(name, fn);
  console.log(`\npcb-items-zones: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
