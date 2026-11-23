// multichannel.test.js — MULTICHANNEL_TOOL (pcbnew/tools/multichannel_tool.cpp) on the board: TMATCH pairing
// (topo_match.cpp), Generate Placement Rule Areas, Repeat Layout from a rule area and from plain selected parts, the
// layout link (Update Linked Layouts, Unlink Layout), Expand Selection by One Step / to Largest Matching Topology,
// and PCB_CONTROL::ApplyDesignBlockLayout.
// Run: node server/static/tests/multichannel.test.js
"use strict";
const path = require("node:path"), assert = require("node:assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, MC = P.multichannel;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HEAD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user))`;
const PAD = (n, x, net) => `(pad "${n}" smd rect (at ${x} 0) (size 1 1) (layers "F.Cu") (net "${net}"))`;
/** a footprint of a channel: lib id, reference, position, symbol path, sheet, pads */
const FP = (id, lib, ref, x, y, sym, sheet, pads, extra = "") => `(footprint "${lib}" (layer "F.Cu") ${extra} (uuid "${id}") (at ${x} ${y}) (path "${sym}") (sheetname "${sheet}") (sheetfile "ch.kicad_sch")
    (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "${id}-ref") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 2 0) (layer "F.SilkS") (uuid "${id}-val") (effects (font (size 1 1) (thickness 0.15))))
    ${pads})`;
/** channel i: R(i) IN_i–MID_i and C(i) MID_i–GND under the sheet instance /s<i>/ */
const channel = (i, ox, oy) => FP(`r${i}`, "T:R", `R${i}`, ox, oy, `/s${i}/rsym`, `/ch${i}/`, PAD(1, -1, `IN${i}`) + PAD(2, 1, `MID${i}`))
  + FP(`c${i}`, "T:C", `C${i}`, ox + 5, oy, `/s${i}/csym`, `/ch${i}/`, PAD(1, -1, `MID${i}`) + PAD(2, 1, "GND"));
const ZONE = (id, name, sheet, pts) => `(zone (net 0) (net_name "") (layers "*.Cu") (uuid "${id}") (name "${name}") (hatch none 0.5) (connect_pads (clearance 0)) (min_thickness 0.25)
    (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (placement (enabled yes) (sheetname "${sheet}"))
    (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts ${pts.map(([x, y]) => `(xy ${x} ${y})`).join(" ")})))`;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const board = (extra = "") => K.parseDoc(HEAD + channel(1, 10, 10) + channel(2, 50, 10) + extra + ")", "kicad_pcb");
const apply = (doc, changes) => { for (const c of changes) K.applyChange(doc, c, 1e6); return doc; };
const at = (doc, id) => K.atOf(doc.items.get(id).node);
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test("TMATCH pairs the parts of two channels by topology", () => {
  const area = (mc, doc, ids) => Object.assign(Object.create(null), { sourceType: "sheetname", components: ids.map((id) => doc.items.get(id)), side: mc.side, designBlockItems: [] });
  const doc = board(), mc = new MC.Multichannel(doc);
  const m = { matching: new Map(), mismatchReasons: [] };
  assert.equal(mc.resolveConnectionTopology(area(mc, doc, ["r1", "c1"]), area(mc, doc, ["c2", "r2"]), m), true);
  assert.equal(m.matching.get(doc.items.get("r1")).id, "r2");
  assert.equal(m.matching.get(doc.items.get("c1")).id, "c2");
  // a different part kind does not match: the reasons say why
  const odd = K.parseDoc(HEAD + channel(1, 10, 10) + FP("r2", "T:R", "R2", 50, 10, "/s2/rsym", "/ch2/", PAD(1, -1, "IN2") + PAD(2, 1, "MID2"))
    + FP("c2", "T:L", "L2", 55, 10, "/s2/csym", "/ch2/", PAD(1, -1, "MID2") + PAD(2, 1, "GND")) + ")", "kicad_pcb");
  const mo = new MC.Multichannel(odd), m2 = { matching: new Map(), mismatchReasons: [] };
  assert.equal(mo.resolveConnectionTopology(area(mo, odd, ["r1", "c1"]), area(mo, odd, ["r2", "c2"]), m2), false);
  assert.ok(m2.mismatchReasons.length > 0);
  // an area cannot be copied onto itself
  const m3 = { matching: new Map(), mismatchReasons: [] };
  assert.equal(mc.resolveConnectionTopology(area(mc, doc, ["r1", "c1"]), area(mc, doc, ["r1", "c2"]), m3), false);
  assert.equal(m3.errorMsg, "Target Rule Area shares components with the reference area");
});

test("the rule area outline: the grown boxes' hull, rectified, simplified", () => {
  const o = MC.buildRAOutline([[0, 0, 2, 1], [4, 3, 6, 5]], 0.1);
  assert.ok(o.length >= 4);
  for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length]; assert.ok(a[0] === b[0] || a[1] === b[1], "90 degree segments"); }
  assert.deepEqual(MC.parentSheetPaths("/A/B/C/"), ["/A/", "/A/B/"]);
  assert.equal(MC.makeUniqueZoneName("R1 channel", (s) => s === "R1 channel"), "R1 channel_1");
  assert.equal(MC.makeUniqueZoneName("x_1", (s) => s === "x_1"), "x_2");
});

test("Generate Placement Rule Areas: sheets, parent sheets, then the areas around the footprints", () => {
  const doc = board(), mc = new MC.Multichannel(doc);
  mc.generatePotentialRuleAreas();
  const sheets = mc.areas.filter((a) => a.sourceType === "sheetname").map((a) => a.sheetPath);
  assert.deepEqual(sheets, ["/ch1/", "/ch2/"]);
  mc.areas.forEach((a) => { a.generateEnabled = true; });
  const changes = mc.autogenerateRuleAreas();
  apply(doc, changes);
  const zones = [...doc.items.values()].filter((it) => it.kind === "zone");
  assert.deepEqual(zones.map((z) => K.str(K.kid(z.node, "name")[1])).sort(), ["auto-placement-area-/ch1/", "auto-placement-area-/ch2/"]);
  const pl = MC.placementOf(zones[0].node); assert.equal(pl.enabled, true); assert.equal(pl.type, "sheetname");
  // a second run without "Replace existing" leaves them
  const again = new MC.Multichannel(doc); again.generatePotentialRuleAreas(); again.areas.forEach((a) => { a.generateEnabled = true; });
  assert.equal(again.autogenerateRuleAreas().length, 0);
  again.replaceExisting = true;
  assert.ok(again.autogenerateRuleAreas().some((c) => c.kind === "REMOVED"));
});

test("Repeat Layout from a rule area copies placement and routing, and links the areas", async () => {
  const extra = `(segment (start 11 11) (end 14 11) (width 0.25) (layer "F.Cu") (net "MID1") (uuid "t1"))`
    + ZONE("z1", "A", "/ch1/", rect(7, 7, 18, 14)) + ZONE("z2", "B", "/ch2/", rect(47, 7, 58, 14));
  const doc = board(extra);
  // move C1 so the reference has a layout of its own
  const c1 = doc.items.get("c1"); K.setAt(c1.node, 14, 12, 90); doc.items.set("c1", K.addItem({ ...doc, items: new Map() }, c1.node));
  const mc = new MC.Multichannel(doc);
  assert.equal(await mc.startFromRuleArea("z1"), "ok");
  const tgt = [...mc.compat.keys()][0]; const cd = mc.compat.get(tgt);
  assert.equal(cd.isOk, true); assert.equal(cd.doCopy, true);
  mc.linkAreas = true;
  const { changes, copied } = mc.repeatToRuleAreas();
  assert.equal(copied, 1);
  apply(doc, changes);
  const [x, y, a] = at(doc, "c2"); near(x, 54); near(y, 12); near(a, 90);
  const copy = [...doc.items.values()].find((t) => t.kind === "segment" && t.id !== "t1"); assert.ok(copy, "the track was copied");
  assert.equal(K.str(K.kid(copy.node, "net")[1]), "MID2");
  near(K.num(K.kid(copy.node, "start")[1]), 51);
  const l1 = MC.linkOf(doc.items.get("z1").node), l2 = MC.linkOf(doc.items.get("z2").node);
  assert.ok(l1.set && l1.set === l2.set);
  // Update Linked Layouts after moving R1 in the reference
  const r1 = doc.items.get("r1"); K.setAt(r1.node, 9, 13, 0); doc.items.set("r1", K.addItem({ ...doc, items: new Map() }, r1.node));
  const up = await new MC.Multichannel(doc).updateLinkedLayouts("z1");
  assert.equal(up.copied, 1); assert.equal(up.warning, null);
  apply(doc, up.changes);
  const [rx, ry] = at(doc, "r2"); near(rx, 49); near(ry, 13);
  assert.deepEqual(new MC.Multichannel(doc).linkedAreasIn(["r2"]), []);
  // Unlink Layout: the pair is no set any more
  apply(doc, new MC.Multichannel(doc).unlinkAreas(["z2"]));
  assert.equal(MC.linkOf(doc.items.get("z1").node).set, ""); assert.equal(MC.linkOf(doc.items.get("z2").node).set, "");
});

test("the anchor turns the copy: the target anchor's orientation and position", async () => {
  const doc = board(ZONE("z1", "A", "/ch1/", rect(7, 7, 18, 14)) + ZONE("z2", "B", "/ch2/", rect(45, 0, 56, 14)));
  const r2 = doc.items.get("r2"); K.setAt(r2.node, 50, 10, 90); doc.items.set("r2", K.addItem({ ...doc, items: new Map() }, r2.node));
  const mc = new MC.Multichannel(doc);
  assert.equal(await mc.startFromRuleArea("z1"), "ok");
  mc.options.anchor = "r1";
  apply(doc, mc.repeatToRuleAreas().changes);
  const [x, y, a] = at(doc, "c2"); near(x, 50); near(y, 5); near(a, 90);
  // the preview stages the same copy without touching the board, and hides what it replaces
  const doc2 = board(ZONE("z1", "A", "/ch1/", rect(7, 7, 18, 14)) + ZONE("z2", "B", "/ch2/", rect(47, 7, 58, 14)));
  const mp = new MC.Multichannel(doc2); await mp.startFromRuleArea("z1");
  const before = K.serialize(doc2.items.get("c2").node);
  const p = mp.previewRepeat();
  assert.ok(p.hidden.has("c2") && p.boxes.has("c2") && p.nodes.some((n) => n[0] === "footprint"));
  assert.equal(K.serialize(doc2.items.get("c2").node), before);
});

test("the layout link: (placement … (link …)) written and read as the file has it, and the message panel", () => {
  const z = K.parse('(zone (layers "*.Cu") (uuid "z") (keepout (tracks allowed)) (placement (enabled yes) (sheetname "/a/")) (polygon (pts (xy 0 0) (xy 1 0) (xy 1 1))))');
  MC.setLink(z, "set-1", { ...MC.DEFAULT_REPEAT_OPTIONS, anchor: "fp-1" });
  assert.equal(K.serialize(K.kid(z, "placement")).replace(/\s+/g, " "),
    '(placement (enabled yes) (sheetname "/a/") (link "set-1" (placement yes) (routing yes) (connected_routing no) (other_items yes) (group_items no) (locked_items yes) (anchor "fp-1")))');
  const l = MC.linkOf(z); assert.equal(l.set, "set-1"); assert.equal(l.opts.anchor, "fp-1"); assert.equal(l.opts.connectedRoutingOnly, false);
  const doc = K.parseDoc(HEAD + K.serialize(z) + ")", "kicad_pcb");
  const info = P.msgPanelInfo(doc, ["z"]);
  assert.ok(JSON.stringify(info).includes("Layout link") && JSON.stringify(info).includes("Linked"), JSON.stringify(info));
  MC.setLink(z, "", MC.DEFAULT_REPEAT_OPTIONS); assert.equal(K.kid(K.kid(z, "placement"), "link"), null);
});

test("Repeat Layout from selected parts finds the other channel and groups both", async () => {
  const doc = board(), mc = new MC.Multichannel(doc);
  assert.equal(await mc.startRepeatFromSelection(["r1", "c1"]), true);
  assert.equal(mc.compat.size, 1);
  const c = [...mc.compat.values()][0]; assert.equal(c.isOk, true);
  mc.linkAreas = true;
  const res = mc.applySelectionRepeat(); assert.ok(res); assert.equal(res.created, 2);
  apply(doc, res.changes);
  const gs = [...doc.items.values()].filter((it) => it.kind === "group").map((g) => K.str(g.node[1])).sort();
  assert.ok(gs.includes("R1 channel") && gs.includes("R2 channel"), gs.join());
  const zs = [...doc.items.values()].filter((it) => it.kind === "zone");
  assert.equal(zs.length, 2);
  assert.ok(MC.linkOf(zs[0].node).set && MC.linkOf(zs[0].node).set === MC.linkOf(zs[1].node).set);
  // the whole sheet instance: the area takes the sheet as its source
  assert.equal(MC.placementOf(zs[0].node).type, "sheetname");
  const mc2 = new MC.Multichannel(doc);
  assert.equal(mc2.linkedAreasIn(["r2"]).length, 1);
});

test("Allow loose matching: a channel that lacks a leaf part of the selection is offered, the part pruned", async () => {
  const doc = board(FP("d1", "T:D", "D1", 20, 10, "/s1/dsym", "/ch1/", PAD(1, -1, "MID1") + PAD(2, 1, "LED1")));
  const mc = new MC.Multichannel(doc);
  assert.equal(await mc.startRepeatFromSelection(["r1", "c1", "d1"]), true);
  assert.equal(mc.compat.size, 0, "no channel repeats all three");
  const ml = new MC.Multichannel(doc);
  ml.selectedItems = ["r1", "c1", "d1"].map((id) => doc.items.get(id)); ml.selectedFootprints = ml.selectedItems.slice();
  await ml.discoverRepeatCandidates(true);
  assert.equal(ml.compat.size, 1);
  const c = [...ml.compat.values()][0];
  assert.equal(c.isOk, true); assert.equal(c.errorMsg, "Loose: prunes D1");
  assert.deepEqual(ml.refRA.components.map((f) => f.id).sort(), ["c1", "r1"]);
});

test("Apply Design Block Layout keeps the block's auto-named nets apart from the board's (IsolateDesignBlockAutoNets)", () => {
  // the block's R1-C1 net is named like the board's net of another part: the match must still follow the block's own wiring
  const block = HEAD + FP("br", "T:R", "R1", 0, 0, "/x/rsym", "/", PAD(1, -1, "IN") + PAD(2, 1, "Net-(R1-Pad2)"))
    + FP("bc", "T:C", "C1", 3, 4, "/x/csym", "/", PAD(1, -1, "Net-(R1-Pad2)") + PAD(2, 1, "GND")) + ")";
  const doc = K.parseDoc(HEAD + channel(1, 10, 10) + FP("x9", "T:C", "C9", 80, 80, "/z/csym", "/", PAD(1, -1, "Net-(R1-Pad2)") + PAD(2, 1, "GND"))
    + `(group "Amp" (uuid "g1") (lib_id "Blocks:Amp") (members "r1" "c1")))`, "kicad_pcb");
  const st = new MC.Stage(doc), r = new MC.Multichannel(doc).applyDesignBlockToGroup(st, doc.items.get("g1"), block);
  assert.equal(r.ok, true, r.error);
  apply(doc, st.changes());
  near(at(doc, "c1")[0] - at(doc, "r1")[0], 3);
  assert.deepEqual(at(doc, "x9").slice(0, 2), [80, 80], "the board's other part stays");
});

test("Expand Selection by One Step / to Largest Matching Topology", () => {
  const doc = board(), mc = new MC.Multichannel(doc);
  const one = mc.expandToMatchingTopology([doc.items.get("r1")], false).map((f) => f.id).sort();
  assert.deepEqual(one, ["c1", "r1"]);
  const all = mc.expandToMatchingTopology([doc.items.get("r1")], true).map((f) => f.id).sort();
  assert.deepEqual(all, ["c1", "r1"]);
});

test("Apply Design Block Layout repeats the block's board onto its group", () => {
  const block = HEAD + FP("br", "T:R", "R1", 0, 0, "/x/rsym", "/", PAD(1, -1, "IN") + PAD(2, 1, "Net-(R1-Pad2)"))
    + FP("bc", "T:C", "C1", 3, 4, "/x/csym", "/", PAD(1, -1, "Net-(R1-Pad2)") + PAD(2, 1, "GND"))
    + `(segment (start 1 0) (end 2 4) (width 0.25) (layer "F.Cu") (net "Net-(R1-Pad2)") (uuid "bt"))` + ")";
  const doc = K.parseDoc(HEAD + channel(1, 10, 10) + `(group "Amp" (uuid "g1") (lib_id "Blocks:Amp") (members "r1" "c1")))`, "kicad_pcb");
  const st = new MC.Stage(doc), mc = new MC.Multichannel(doc);
  const res = mc.applyDesignBlockToGroup(st, doc.items.get("g1"), block);
  assert.equal(res.ok, true, res.error);
  apply(doc, st.changes());
  const [rx, ry] = at(doc, "r1"), [cx, cy] = at(doc, "c1");
  near(cx - rx, 3); near(cy - ry, 4);
  const tr = [...doc.items.values()].find((it) => it.kind === "segment");
  assert.ok(tr); assert.equal(K.str(K.kid(tr.node, "net")[1]), "MID1");
  assert.ok(K.kid(doc.items.get("g1").node, "members").slice(1).map(K.str).includes(tr.id));
  const empty = new MC.Multichannel(doc).applyDesignBlockToGroup(new MC.Stage(doc), doc.items.get("g1"), HEAD + ")");
  assert.equal(empty.ok, false); assert.equal(empty.error, "the design block's board layout is empty");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("ok   " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
})();
