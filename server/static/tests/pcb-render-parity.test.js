// node server/static/tests/pcb-render-parity.test.js — board drawing as pcbnew's PCB_PAINTER / ViewGetLOD draw it:
// vias, pads, mask / paste apertures, hatching, unused layers, visibility rules, draw order and the live ratsnest.
"use strict";
const assert = require("assert");
const path = require("path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok  ", name); } catch (e) { failed++; console.error("FAIL", name + ":", e.stack || e.message); } }
const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= (eps || 1e-9), (msg || "") + " " + a + " vs " + b);

function rec(w, h) {
  const ops = []; let stroke = "", fill = "", alpha = 1, dash = [], lw = 1, tf = null, cap = "";
  const ctx = { canvas: { width: w, height: h }, ops, font: "", textBaseline: "", lineJoin: "", textAlign: "" };
  let pathLen = 0;   // segments in the current path (an empty path strokes nothing)
  ctx.beginPath = () => { pathLen = 0; }; ctx.moveTo = () => { pathLen++; }; ctx.lineTo = () => { pathLen++; };
  for (const n of ["closePath", "arc", "rect", "save", "restore", "translate", "rotate", "scale", "strokeText", "clearRect", "clip", "bezierCurveTo", "quadraticCurveTo", "ellipse"]) ctx[n] = () => {};
  for (const n of ["stroke", "fill", "strokeRect", "fillRect", "fillText", "drawImage"]) ctx[n] = (...args) => ops.push({ op: n, stroke, fill, alpha, dash: dash.slice(), lw, tf, cap, args, pathLen });
  ctx.setTransform = (...a) => { tf = a; };
  Object.defineProperty(ctx, "strokeStyle", { set: (v) => { stroke = v; }, get: () => stroke });
  Object.defineProperty(ctx, "fillStyle", { set: (v) => { fill = v; }, get: () => fill });
  Object.defineProperty(ctx, "globalAlpha", { set: (v) => { alpha = +(+v).toFixed(3); }, get: () => alpha });
  Object.defineProperty(ctx, "lineWidth", { set: (v) => { lw = v; }, get: () => lw });
  Object.defineProperty(ctx, "lineCap", { set: (v) => { cap = v; }, get: () => cap });
  ctx.setLineDash = (d) => { dash = d; }; ctx.measureText = (t) => ({ width: t.length * 0.7 });
  return ctx;
}
const HEAD = '(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal) (32 "B.Adhes" user) (33 "F.Adhes" user) (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user) (37 "F.SilkS" user) (38 "B.Mask" user) (39 "F.Mask" user) (40 "Dwgs.User" user) (41 "Cmts.User" user) (42 "Eco1.User" user) (43 "Eco2.User" user) (44 "Edge.Cuts" user)) (net 0 "") (net 1 "GND") (net 2 "VCC") ';
const V40 = { ppm: 40, zoom: 1, panX: 0, panY: 0, x0: -5, y0: -5, dpr: 1 };
const draw = (doc, opts, view) => { const c = rec(1000, 800); K.render(doc, c, view || V40, Object.assign({ frame: false }, opts)); return c.ops; };
const texts = (ops, t) => ops.filter((o) => o.op === "fillText" && (t === undefined || o.args[0] === t));
const geomOf = (doc, id) => doc.items.get(id).geom;
const ANCHOR = "#FF26E2";   // LAYER_ANCHOR

test("1: a buried via spans its pair only and shows the pair in its hole", () => {
  const d = K.parseDoc(HEAD + '(via buried (at 0 0) (size 0.8) (drill 0.4) (layers "In1.Cu" "In2.Cu") (net 1) (uuid "v")))');
  const g = geomOf(d, "v");
  assert.deepStrictEqual(g.filter((q) => q.via && !q.hole && !q.viaMask).map((q) => q.layer), ["In1.Cu", "In2.Cu"]);
  assert.strictEqual(g.filter((q) => q.hole && q.pie).length, 2, "a split hole (viaHoleShowsLayerPair)");
  assert.strictEqual(d.items.get("v").viaType, "buried");
});

test("2: the drill offset moves the pad shape, not the hole", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 10 10) (uuid "fp") (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1 (offset 0.5 0)) (layers "*.Cu") (net 1 "GND") (uuid "p")))');
  const g = geomOf(d, "fp");
  const cu = g.find((q) => q.t === "pad" && q.layer === "F.Cu"), hole = g.find((q) => q.hole && q.layer === "holes");
  near(cu.x, 10.5, 1e-9, "shape at pos + offset"); near(hole.x, 10, 1e-9, "hole at pos");
});

test("3: pad numbers and net names each follow their option; the x of a no-connect pad is independent; one / two line layout", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (pad "1" smd rect (at 0 0) (size 3 3) (layers "F.Cu") (net 1 "GND") (uuid "p1")) (pad "2" smd rect (at 5 0) (size 3 3) (layers "F.Cu") (pintype "passive+no_connect") (uuid "p2")))');
  const lab = (o) => texts(draw(d, o)).map((t) => t.args[0]).sort();
  assert.deepStrictEqual(lab({}), ["1", "2", "GND", "x"]);
  assert.deepStrictEqual(lab({ netNames: false }), ["1", "2", "x"], "net names off keeps the x");
  assert.deepStrictEqual(lab({ padNumbers: false }), ["GND", "x"]);
  const g = geomOf(d, "fp").filter((q) => q.padText && q.labelPad === 0);
  const two = g.filter((q) => K.padLabelShown(q, true, true)), one = g.filter((q) => K.padLabelShown(q, false, true));
  assert.strictEqual(two.length, 2); assert.strictEqual(one.length, 1, "net name alone, on one line");
  assert(Math.abs(one[0].y - 0) < Math.abs(two.find((q) => q.padNet).y - 0) + 1e-9, "one-line layout centred on the pad");
});

test("4: a via's net name shows while the via flashes on any visible layer", () => {
  const d = K.parseDoc(HEAD + '(via blind (at 5 5) (size 3) (drill 1) (layers "F.Cu" "In1.Cu") (net 1) (uuid "v")))');
  const names = (o) => texts(draw(d, o)).map((t) => t.args[0]);
  assert(names({}).includes("GND"));
  assert(names({ hidden: new Set(["F.Cu"]) }).includes("GND"), "In1.Cu is shown");
  assert(!names({ hidden: new Set(["F.Cu", "In1.Cu"]) }).includes("GND"));
  assert(names({ netNamesMode: 0 }).includes("1-2") && !names({ netNamesMode: 0 }).includes("GND"), "net names off: the layer pair alone");
});

test("6: the live ratsnest lines carry the layers of their two ends (for the Visible Layers mode)", () => {
  const d = K.parseDoc(HEAD + '(footprint "a" (layer "F.Cu") (at 0 0) (uuid "fa") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "p1"))) (footprint "b" (layer "B.Cu") (at 10 0) (uuid "fb") (pad "1" smd rect (at 0 0) (size 1 1) (layers "B.Cu") (net 1 "GND") (uuid "p2"))))');
  const lines = P.ratsnest(d);
  assert.strictEqual(lines.length, 1); assert.deepStrictEqual(lines[0].layersA.concat(lines[0].layersB).sort(), ["B.Cu", "F.Cu"]);
});

test("36: a ratsnest line from a lone pad ends on the nearest corner of the fill its partner sits on", () => {
  const d = K.parseDoc(HEAD + '(footprint "a" (layer "F.Cu") (at 0 0) (uuid "fa") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "p1")))'
    + ' (footprint "b" (layer "F.Cu") (at 30 0) (uuid "fb") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND") (uuid "p2")))'
    + ' (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z") (hatch edge 0.5) (polygon (pts (xy 10 -5) (xy 35 -5) (xy 35 5) (xy 10 5))) (filled_polygon (layer "F.Cu") (pts (xy 10 -5) (xy 35 -5) (xy 35 5) (xy 10 5)))))');
  const lines = P.ratsnest(d);
  assert.strictEqual(lines.length, 1);
  const ends = [lines[0].a, lines[0].b].sort((p, q) => p[0] - q[0]);
  assert.deepStrictEqual(ends[0], [0, 0]); assert.strictEqual(ends[1][0], 10, "the fill corner nearest the lone pad, not pad b at x = 30");
});

test("9: Footprints Front hidden: a front-only pad goes, a through-hole pad and back-side graphics stay", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (fp_line (start 0 5) (end 5 5) (stroke (width 0.2) (type solid)) (layer "B.SilkS") (uuid "l")) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "p1")) (pad "2" thru_hole circle (at 3 0) (size 1.5 1.5) (drill 0.8) (layers "*.Cu") (uuid "p2"))))');
  const ops = draw(d, { objects: { hide: new Set(["fpFront"]) }, netNames: false, padNumbers: false });
  assert(ops.some((o) => o.op === "stroke" && o.stroke === K.pcbColor("B.SilkS")), "back silk stays");
  assert(ops.some((o) => o.op === "fill" && o.fill === K.pcbColor("B.Cu")), "the through-hole pad stays");
  const both = draw(d, { objects: { hide: new Set(["fpFront", "fpBack"]) }, netNames: false, padNumbers: false });
  assert(!both.some((o) => o.op === "fill" && o.fill === K.pcbColor("B.Cu")), "both sides hidden: gone");
});

test("10, 34: selected footprint fields show with the text toggles off; ${VALUE} texts follow the Values toggle", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 5 5) (uuid "fp") (property "Reference" "R1" (at 0 -2 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))) (property "Value" "10k" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15)))) (fp_text user "${VALUE}" (at 0 4 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15)))))');
  const g = geomOf(d, "fp"); assert(g.some((q) => q.varRole === "Value"));
  const silk = (ops) => ops.filter((o) => o.op === "fillText" && o.fill === K.pcbColor("F.SilkS")).length;
  const hid = draw(d, { objects: { hide: new Set(["references", "values"]) } }), all = draw(d, {});
  assert(silk(hid) < silk(all));
  const valOnly = draw(d, { objects: { hide: new Set(["values"]) } });
  assert(silk(valOnly) < silk(all), "the ${VALUE} text hides with Values");
  const selHid = draw(d, { objects: { hide: new Set(["references", "values"]) }, selected: new Set(["fp"]) });
  const selCol = K.selectedColor(K.pcbColor("F.SilkS"));
  assert(selHid.some((o) => o.op === "fillText" && o.fill === selCol && o.args[0] === "R1"), "the selected footprint's Reference shows");
  const off = draw(d, { objects: { hide: new Set(["references", "values"]) }, selected: new Set(["fp"]), forceShowFields: false });
  assert.strictEqual(off.filter((o) => o.op === "fillText" && o.args[0] === "R1").length, 0);
});

test("11: via colour for through-hole pads", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (pad "1" thru_hole circle (at 0 0) (size 2 2) (drill 1) (layers "*.Cu") (uuid "p"))))');
  const gold = (ops) => ops.filter((o) => o.op === "fill" && o.fill === "#E3B72E").length;
  assert(gold(draw(d, { viaColorForTHPads: true, padNumbers: false })) > gold(draw(d, { padNumbers: false })));
});

test("12: high contrast with a technical layer active dims the holes", () => {
  const d = K.parseDoc(HEAD + '(via (at 0 0) (size 1) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "v")))');
  const gold = (ops) => ops.some((o) => o.op === "fill" && o.fill === "#E3B72E");
  assert(gold(draw(d, { highContrast: true, activeLayer: "F.Cu" })), "copper active: holes active");
  assert(!gold(draw(d, { highContrast: true, activeLayer: "F.SilkS" })), "silk active: the hole is mixed with the background");
  assert(!gold(draw(d, { highContrast: true, activeLayer: "F.SilkS", inactiveHide: true })));
});

test("13: remove_unused_layers: an unconnected inner ring is not drawn, a connected one is; the clearance outline falls back to the drill", () => {
  const d = K.parseDoc(HEAD + '(via (at 0 0) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu") (remove_unused_layers yes) (keep_end_layers yes) (net 1) (uuid "v"))'
    + ' (segment (start 0 0) (end 5 0) (width 0.2) (layer "In2.Cu") (net 1) (uuid "s")))');
  const un = K.unflashedGeoms(d); const rings = geomOf(d, "v").filter((g) => g.via && !g.hole && !g.viaMask);
  const st = (l) => un && un.has(rings.find((g) => g.layer === l));
  assert(!st("F.Cu") && !st("B.Cu"), "end layers kept"); assert(st("In1.Cu"), "In1 unconnected"); assert(!st("In2.Cu"), "In2 has a track");
  const ops = draw(d, { netNames: false });
  assert(!ops.some((o) => o.op === "fill" && o.fill === K.pcbColor("In1.Cu")), "no ring on In1.Cu");
  assert(K.viaFlashesOn(d, d.items.get("v"), "In2.Cu") && !K.viaFlashesOn(d, d.items.get("v"), "In1.Cu"));
  const s = { clearance: 0.2, netclasses: [] };
  const list = P.clearanceOutlines(d, s, "In1.Cu", { tracks: true, pads: false, netName: () => "" });
  const c = list.find((o) => o.id === "v"); near(c.shape.r, 0.2 + 0.02 + 0.2, 1e-9, "drill / 2 + plating + clearance");
});

test("14: mask and paste apertures: pad expansion and paste margin, via mask openings, copper shape mask copies", () => {
  const d = K.parseDoc(HEAD + '(setup (pad_to_mask_clearance 0.1) (pad_to_paste_clearance -0.05) (tenting none))'
    + ' (footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu" "F.Mask" "F.Paste") (uuid "p")))'
    + ' (via (at 5 0) (size 1) (drill 0.5) (layers "F.Cu" "B.Cu") (net 0) (uuid "v"))'
    + ' (gr_line (start 0 5) (end 5 5) (stroke (width 0.5) (type solid)) (layer "F.Cu") (solder_mask_margin 0.05) (layers "F.Cu" "F.Mask") (uuid "l")))');
  const g = geomOf(d, "fp"); const mask = g.find((q) => q.t === "pad" && q.layer === "F.Mask"), paste = g.find((q) => q.t === "pad" && q.layer === "F.Paste");
  near(mask.w, 2.2, 1e-9); near(mask.h, 1.2, 1e-9); near(paste.w, 1.9, 1e-9); near(paste.h, 0.9, 1e-9);
  const vm = geomOf(d, "v").filter((q) => q.viaMask); assert.deepStrictEqual(vm.map((q) => q.layer).sort(), ["B.Mask", "F.Mask"]); near(vm[0].r, 0.6, 1e-9);
  const t = K.parseDoc(HEAD + '(setup (pad_to_mask_clearance 0.1)) (segment (start 0 0) (end 5 0) (width 0.4) (layers "F.Cu" "F.Mask") (net 0) (uuid "s")))');
  const tm = geomOf(t, "s").find((q) => q.trackMask); assert(tm && tm.layer === "F.Mask" && !tm.track); near(tm.w, 0.6, 1e-9, "track mask opening: width + 2 x the board expansion");
  const mc = geomOf(d, "l").find((q) => q.maskCopy); assert(mc && mc.layer === "F.Mask"); near(mc.w, 0.6, 1e-9);
});

test("15, 35: pads on silk / user layers are drawn; footprint private layers are not", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (private_layers "Dwgs.User") (fp_line (start 0 0) (end 3 0) (stroke (width 0.2) (type solid)) (layer "Dwgs.User") (uuid "l")) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.SilkS" "Eco1.User") (uuid "p"))))');
  const g = geomOf(d, "fp");
  assert(g.some((q) => q.t === "pad" && q.layer === "F.SilkS") && g.some((q) => q.t === "pad" && q.layer === "Eco1.User"));
  assert(!g.some((q) => q.layer === "Dwgs.User"), "the private-layer line is not drawn on the board");
});

test("16, 17: hatched board shapes and rounded rectangles", () => {
  const d = K.parseDoc(HEAD + '(gr_rect (start 0 0) (end 10 10) (stroke (width 0.1) (type solid)) (fill hatch) (layer "F.SilkS") (uuid "r"))'
    + ' (gr_rect (start 20 0) (end 30 10) (radius 2) (stroke (width 0.1) (type solid)) (fill no) (layer "F.SilkS") (uuid "rr")))');
  const h = geomOf(d, "r").filter((q) => q.hatchLine); assert(h.length > 5, "hatch lines");
  const rr = geomOf(d, "rr"); const pts = rr.find((q) => q.t === "poly").pts;
  assert(pts.length > 8 && !pts.some((p) => Math.abs(p[0] - 20) < 1e-9 && Math.abs(p[1]) < 1e-9), "the corner is rounded off");
});

test("18: backdrill and post-machining indicators are dashed circles", () => {
  const d = K.parseDoc(HEAD + '(via (at 0 0) (size 1) (drill 0.4) (layers "F.Cu" "B.Cu") (backdrill (size 0.8) (layers "B.Cu" "In2.Cu")) (net 0) (uuid "v")))');
  const ind = geomOf(d, "v").filter((q) => q.indicator); assert(ind.length >= 1, "an indicator"); assert(ind.every((q) => q.layer === "holes"));
});

test("19, 20, 21: Zones hides rule areas and hatch; outline mode keeps teardrops; the outline stays opaque", () => {
  const d = K.parseDoc(HEAD + '(zone (net 0) (net_name "") (layer "F.Cu") (uuid "k") (hatch full 0.5) (keepout (tracks not_allowed)) (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5) (xy 0 5))))'
    + ' (zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "t") (attr (teardrop (type padvia))) (hatch edge 0.5) (polygon (pts (xy 10 0) (xy 12 0) (xy 12 2) (xy 10 2))) (filled_polygon (layer "F.Cu") (pts (xy 10 0) (xy 12 0) (xy 12 2) (xy 10 2)))))');
  const hid = draw(d, { objects: { hide: new Set(["zones"]) } }); assert(!hid.some((o) => o.op === "stroke"), "nothing of the zones stroked");
  const ol = draw(d, { zoneOutline: true }); assert(ol.some((o) => o.op === "fill"), "the teardrop fill stays in outline mode");
  const op = draw(d, { objects: { opacity: { zones: 0.2 } } });
  assert(op.filter((o) => o.op === "stroke").every((o) => o.alpha === 1), "outline and hatch opaque");
});

test("22, 23: selection wins over the net highlight; pad labels keep their colour; holes take the selected colour", () => {
  const d = K.parseDoc(HEAD + '(segment (start 0 0) (end 5 0) (width 0.5) (layer "F.Cu") (net 1) (uuid "s")) (via (at 8 0) (size 1) (drill 0.6) (layers "F.Cu" "B.Cu") (net 1) (uuid "v")))');
  const ops = draw(d, { selected: new Set(["s", "v"]), highlight: new Set(["s", "v"]), netNames: false });
  const sel = K.selectedColor(K.pcbColor("F.Cu"));
  assert(ops.some((o) => o.op === "stroke" && o.stroke === sel), "selected colour, not brightened again");
  assert(ops.some((o) => o.op === "fill" && o.fill === K.selectedColor("#E3B72E")), "the via hole takes the selected colour");
  const nc = draw(d, { selected: new Set(["s"]), netColors: new Map([[1, "#FF0000"]]), netNames: false });
  assert(nc.some((o) => o.op === "stroke" && o.stroke === K.brightened("#FF0000", 0.5)), "a net colour is Brightened( 0.5 )");
});

test("24: via sketch mode leaves the hole filled; pad sketch mode outlines NPTH holes", () => {
  const d = K.parseDoc(HEAD + '(via (at 0 0) (size 1) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "v")) (footprint "x" (layer "F.Cu") (at 5 0) (uuid "fp") (pad "" np_thru_hole circle (at 0 0) (size 1 1) (drill 1) (layers "*.Cu") (uuid "p"))))');
  const v = draw(d, { outlineVias: true }); assert(v.some((o) => o.op === "fill" && o.fill === "#E3B72E"));
  const p = draw(d, { outlinePads: true }); assert(!p.some((o) => o.op === "fill" && o.fill === "#1AC4D2") && p.some((o) => o.op === "stroke" && o.stroke === "#1AC4D2"));
});

test("25: blind via label: the layer pair at −0.65 text size, the count ignores markup", () => {
  const d = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)) (net 0 "") (net 1 "A") (via blind (at 0 0) (size 4) (drill 1) (layers "F.Cu" "In1.Cu") (net 1) (uuid "v")))');
  const c = rec(1000, 800); K.render(d, c, V40, { frame: false });
  const ids = texts(c.ops, "1-2")[0], name = texts(c.ops, "A")[0];
  assert(ids && name); near(name.tf[5] - (5 * 40), -(ids.tf[5] - 5 * 40), 1e-6, "symmetric about the centre");
  const d4 = K.parseDoc('(kicad_pcb (version 20240108) (generator "t") (layers (0 "F.Cu" signal) (1 "In1.Cu" signal) (2 "In2.Cu" signal) (31 "B.Cu" signal)) (net 0 "") (net 1 "A") (via buried (at 0 0) (size 4) (drill 1) (layers "In2.Cu" "B.Cu") (net 1) (uuid "v")))');
  const c4 = rec(1000, 800); K.render(d4, c4, V40, { frame: false }); assert(texts(c4.ops, "3-4")[0], "In2.Cu is layer 3, B.Cu the copper count");
});

test("26, 27: pad and via names over the user layers; copper text at the layer's base; multi-layer SMD label layer", () => {
  const d = K.parseDoc(HEAD + '(gr_text "T" (at 0 0) (layer "F.Cu") (uuid "t") (effects (font (size 1 1) (thickness 0.15)))) (footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "B.Cu") (uuid "p"))))');
  const t = geomOf(d, "t").find((q) => q.t === "text"); assert.strictEqual(t.z, K.pcbZ("F.Cu"));
  const l = geomOf(d, "fp").find((q) => q.padNum); assert.strictEqual(l.z, K.pcbZ("Dwgs.User") + 21); assert(l.z > K.pcbZ("Edge.Cuts"));
});

test("28: holes need a visible physical layer; small via holes are not drawn far out", () => {
  const d = K.parseDoc(HEAD + '(via (at 0 0) (size 1) (drill 0.6) (layers "F.Cu" "B.Cu") (net 0) (uuid "v")))');
  const gold = (ops) => ops.some((o) => o.op === "fill" && o.fill === "#E3B72E");
  const allPhys = new Set(["F.Cu", "In1.Cu", "In2.Cu", "B.Cu", "F.Adhes", "B.Adhes", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "F.Mask", "B.Mask"]);
  assert(gold(draw(d, {}))); assert(!gold(draw(d, { hidden: allPhys })));
  assert(!gold(draw(d, {}, { ppm: 1, zoom: 1, panX: 500, panY: 400, x0: 0, y0: 0, dpr: 1 })), "0.6 mm at 1 px/mm is under 0.25 mm at zoom 1");
});

test("29: anchors from a view scale of 1.5 only, and not with the footprint's layer hidden", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (uuid "p"))))');
  const anc = (ops) => ops.filter((o) => o.op === "stroke" && o.stroke === ANCHOR && o.pathLen > 0).length;
  const o = { objects: { show: new Set(["anchors"]) } };
  assert(anc(draw(d, o)) > 0);
  assert.strictEqual(anc(draw(d, o, { ppm: 3, zoom: 1, panX: 500, panY: 400, x0: 0, y0: 0, dpr: 1 })), 0, "zoomed out");
  assert.strictEqual(anc(draw(d, Object.assign({ hidden: new Set(["F.Cu"]) }, o))), 0);
});

test("30, 31: copper graphics take the track opacity; a copper segment with a net is named", () => {
  const d = K.parseDoc(HEAD + '(gr_line (start 0 0) (end 12 0) (stroke (width 1) (type solid)) (layer "F.Cu") (net 1) (uuid "l")))');
  const ops = draw(d, { objects: { opacity: { tracks: 0.4 } } });
  assert(ops.some((o) => o.op === "stroke" && o.stroke === K.pcbColor("F.Cu") && o.alpha === 0.4));
  assert(texts(draw(d, {}), "GND").length === 1, "the net name on the segment");
});

test("32: a custom pad's number box", () => {
  const d = K.parseDoc(HEAD + '(footprint "x" (layer "F.Cu") (at 0 0) (uuid "fp") (pad "1" smd custom (at 0 0) (size 1 1) (layers "F.Cu") (options (clearance outline) (anchor circle)) (primitives (gr_poly (pts (xy -3 -1) (xy 3 -1) (xy 3 1) (xy -3 1)) (width 0) (fill yes)) (gr_bbox (start 1 -0.5) (end 3 0.5))) (uuid "p"))))');
  const l = geomOf(d, "fp").find((q) => q.padNum && K.padLabelShown(q, true, true)); near(l.x, 2, 1e-9, "centred in the number box");
});

test("33: a selected reference image is framed in the anchor colour", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const d = K.parseDoc(HEAD + '(image (at 0 0) (layer "F.SilkS") (uuid "i") (data "' + png + '")))');
  const ops = draw(d, { selected: new Set(["i"]) });
  assert(ops.some((o) => o.op === "strokeRect" && o.stroke === ANCHOR));
  assert(!draw(d, {}).some((o) => o.op === "strokeRect" && o.stroke === ANCHOR));
});

console.log(`\npcb-render-parity: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
