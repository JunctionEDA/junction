// pcb-control-clipboard.test.js — KiCad parity of the board's clipboard and control commands (pcb-tools.js):
// PCB_CONTROL::Paste (plain text, lone footprint without nets, pruneItemLayers, unique references, schematic path,
// unique zone names, entered group, the selection after a paste, the footprint editor's conversions),
// CLIPBOARD_IO::SaveSelection (fields as text, pads in their own footprint), BOARD_EDITOR_CONTROL's locks, zone
// priorities, Merge Zones, Duplicate Zone, via sizes and auto track width, GROUP_TOOL, the net highlight toggles,
// PAD_TOOL's number memory and default NPTH pad, Hide / Show Net in Ratsnest.
// Run: node server/static/tests/pcb-control-clipboard.test.js
"use strict";
const path = require("path"), assert = require("assert/strict");
require(path.join(__dirname, "..", "kicad-canvas.js"));
require(path.join(__dirname, "..", "pcb-tools.js"));
const K = globalThis.KiCadCanvas, P = globalThis.PcbTools, pcb = globalThis.CollabTools.pcb;
const IU = 1e6, S = P.state;

let passed = 0, failed = 0;
function test(name, fn) {
  S.move = null; try { pcb.cancel && P.finishSelectMove(ctx, false); } catch (e) { /* idle */ }
  S.move = null; S.enteredGroup = null; S.padSel = null; S.padAlso = null; S.sel.clear(); S.highlightNet = null; S.hlShown = []; S.hlCurrent = []; S.hlLast = []; S.hiddenNets.clear();
  pcb.setForm(() => true); pcb.setNewItemDialogs({ zone: undefined });
  try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 14).join("\n       ")); }
}

const HEAD = `(kicad_pcb (version 20260728) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user))`;
const FP = (id, ref, x, y, extra = "") => `(footprint "T:R" (layer "F.Cu") (uuid "${id}") (at ${x} ${y}) (path "/aaaa-${id}")
    (property "Reference" "${ref}" (at 0 -2 0) (layer "F.SilkS") (uuid "${id}-ref") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "10k" (at 0 2 0) (layer "F.SilkS") (uuid "${id}-val") (effects (font (size 1 1) (thickness 0.15))))
    ${extra}
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net "VCC") (uuid "${id}-p1"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net "SIG") (uuid "${id}-p2")))`;
const ZONE = (id, net, pts, extra = "") => `(zone (net "${net}") (layer "F.Cu") (uuid "${id}") ${extra} (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts ${pts.map((p) => `(xy ${p[0]} ${p[1]})`).join(" ")})))`;
const BOARD = `${HEAD}
  (segment (start 10 10) (end 30 10) (width 0.25) (layer "F.Cu") (net "VCC") (uuid "s1"))
  (segment (start 10 12) (end 30 12) (width 0.25) (layer "F.Cu") (net "SIG") (uuid "s2"))
  (segment (start 10 14) (end 30 14) (width 0.25) (layer "B.Cu") (net "SIG") (uuid "s3"))
  (via (at 20 20) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "VCC") (uuid "v1"))
  (gr_line (start 0 0) (end 5 0) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "g1"))
  ${FP("fp5", "R5", 50, 50)}
  ${FP("fp6", "R6", 60, 50)}
)`;
const board = (text) => K.parseDoc(text || BOARD, "kicad_pcb");
function fakeCtx(doc, extra) {
  const log = { commits: [], toasts: [], clip: "", selection: null, forms: [], hidden: [] };
  const ctx = Object.assign({
    K, doc, IU, isSch: false, zoom: 1, pxPerMm: 10, gridPitch: 0.25, snapOn: true, selected: null, items: [], viewOnly: false, live: true, selection: new Set(), cursor: [0, 0], activeLayer: "F.Cu",
    snap: (mm) => mm.map((v) => Math.round(v / 0.25) * 0.25), worldMm: () => [0, 0], requestRender() {}, applyLocal() {}, setSelected() {},
    setSelection(l) { log.selection = Array.from(l); ctx.selection = new Set(log.selection); }, setHighlight(ids, nets) { log.highlight = ids ? { ids: new Set(ids), nets: nets ? Array.from(nets) : [] } : null; },
    setNetsVisible(names, on) { log.hidden.push([names.slice().sort(), on]); },
    clipboard: { get: () => log.clip, set: (t) => { log.clip = t; } },
    commit(changes, label, opts) { log.commits.push({ changes, label, opts }); for (const c of changes) K.applyChange(doc, c, IU); pcb.onDocChanged(ctx); },
    toast(m) { log.toasts.push(m); }, setTool(t) { pcb.onActivate(t, ctx); },
  }, extra || {});
  pcb.onDocChanged(ctx);
  return { ctx, log };
}
const kinds = (doc, ids) => ids.map((id) => doc.items.get(id).kind);
const padNets = (n) => K.kids(n, "pad").map((p) => K.kid(p, "net") || null);
const prio = (doc, id) => { const p = K.kid(doc.items.get(id).node, "priority"); return p ? p[1] : 0; };

// ---------------------------------------------------------------- 1: plain text on the clipboard
test("Paste: text that is no board item becomes a text on the active layer (Paste Text), not the last internal copy", () => {
  const { ctx, log } = fakeCtx(board()); ctx.selection = new Set(["s1"]); pcb.runAction("copy", ctx); ctx.selection = new Set();
  log.clip = "hello world"; ctx.cursor = [40, 40]; ctx.activeLayer = "F.SilkS";
  assert.equal(pcb.runAction("paste", ctx), true);
  const c = log.commits.at(-1); assert.equal(c.label, "Paste Text"); assert.deepEqual(c.opts, { tentative: true }); assert.equal(c.changes.length, 1);
  const it = ctx.doc.items.get(c.changes[0].id); assert.equal(it.kind, "gr_text"); assert.equal(it.node[1], "hello world"); assert.equal(K.str(K.kid(it.node, "layer")[1]), "F.SilkS");
  assert.deepEqual(K.atOf(it.node).slice(0, 2), [40, 40]); assert.deepEqual(log.selection, [it.id]); assert.deepEqual(S.move && S.move.placing, [it.id]);
  S.move = null;
  // ctx.clipboard.read (the system clipboard) wins over the buffer
  const two = fakeCtx(board(), { clipboard: { get: () => "(kicad_pcb (segment (start 0 0) (end 1 0) (width 0.2) (layer \"F.Cu\") (uuid \"zz\")))", set() {}, read: () => ({ then(ok) { ok("from another app"); } }) } });
  pcb.runAction("paste", two.ctx); assert.equal(two.log.commits.at(-1).label, "Paste Text"); assert.equal(two.ctx.doc.items.get(two.log.commits.at(-1).changes[0].id).node[1], "from another app");
});
test("Paste: text longer than m_MaxPastedTextLength asks first", () => {
  const { ctx, log } = fakeCtx(board()); let asked = null;
  pcb.setForm((spec) => { asked = spec; return true; });
  log.clip = "x".repeat(101); pcb.runAction("paste", ctx);
  assert.ok(asked, "the question is shown"); assert.equal(asked.fields[0].value, "Pasting a long text text string may be very slow.  Do you want to continue?"); assert.equal(log.commits.length, 0);
  asked.apply({}); assert.equal(log.commits.at(-1).label, "Paste Text"); S.move = null;
  asked = null; log.clip = "y".repeat(100); pcb.runAction("paste", ctx); assert.equal(asked, null, "100 characters paste without a question");
});

// ---------------------------------------------------------------- 2, 39: the clipboard document
test("Copy: a lone footprint is copied without its pad nets; the header is pcbnew's and carries no net table", () => {
  const doc = board(); const lone = P.clipboardText(doc, ["fp5"], [50, 50]); const tree = K.parse(lone);
  assert.equal(K.kid(tree, "generator")[1], "pcbnew"); assert.deepEqual(K.kids(tree, "net"), []);
  assert.deepEqual(padNets(K.kid(tree, "footprint")), [null, null], "pad nets cleared");
  const two = K.parse(P.clipboardText(doc, ["fp5", "fp6"], [50, 50])); assert.deepEqual(padNets(K.kid(two, "footprint")), [["net", "VCC"], ["net", "SIG"]], "more than one item: nets kept");
  const withTrack = K.parse(P.clipboardText(doc, ["fp5", "s1"], [50, 50])); assert.deepEqual(padNets(K.kid(withTrack, "footprint")), [["net", "VCC"], ["net", "SIG"]]);
  // a numbered-net board still gets the table its (net N) items need
  const coded = K.parseDoc(`${HEAD.replace("20260728", "20241229")}\n (net 0 "") (net 1 "VCC")\n (footprint "X" (layer "F.Cu") (uuid "cf") (at 9 9) (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC") (uuid "cp")))\n (segment (start 0 0) (end 1 0) (width 0.25) (layer "F.Cu") (net 1) (uuid "c1")))`, "kicad_pcb");
  assert.deepEqual(K.kids(K.parse(P.clipboardText(coded, ["c1"], [0, 0])), "net"), [["net", 0, ""], ["net", 1, "VCC"]]);
});

// ---------------------------------------------------------------- 3: pruneItemLayers
test("Paste: items on layers the board lacks are dropped with KiCad's warning; multi-layer items keep the enabled layers", () => {
  const four = `(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal) (9 "F.Fab" user))
    (segment (start 0 0) (end 5 0) (width 0.25) (layer "In1.Cu") (net "A") (uuid "i1"))
    (segment (start 0 1) (end 5 1) (width 0.25) (layer "F.Cu") (net "A") (uuid "f1"))
    (gr_line (start 0 2) (end 5 2) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "fab"))
    (via blind (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "In2.Cu") (net "A") (uuid "bv"))
    (via blind (at 2 1) (size 0.8) (drill 0.4) (layers "In3.Cu" "In4.Cu") (net "A") (uuid "deep"))
    (via (at 3 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "A") (uuid "thru"))
    (zone (net "A") (layers "F.Cu" "In1.Cu") (uuid "z") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
      (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5)))
      (filled_polygon (layer "F.Cu") (pts (xy 0 0) (xy 5 0) (xy 5 5))) (filled_polygon (layer "In1.Cu") (pts (xy 0 0) (xy 5 0) (xy 5 5))))
    (zone (net "A") (layer "In2.Cu") (uuid "zi") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5)) (polygon (pts (xy 0 0) (xy 5 0) (xy 5 5))))
    (group "g" (uuid "grp") (members "i1" "f1"))
  )`;
  const doc = board(); const r = P.pasteChanges(doc, four, [100, 100]);
  assert.equal(r.pruned, true);
  const got = r.ids.map((id) => doc.items.get(id));
  assert.deepEqual(got.map((it) => it.kind + ":" + (K.kid(it.node, "layer") ? K.kid(it.node, "layer")[1] : "")).sort(), ["group:", "segment:F.Cu", "via:", "zone:"], "In1 track, F.Fab line, the vias ending on In2 / In4 (PCB_VIA::HasValidLayerPair) and the In2 zone are gone");
  const z = got.find((it) => it.kind === "zone"); assert.deepEqual(K.kid(z.node, "layers").slice(1), ["F.Cu"]); assert.equal(K.kids(z.node, "filled_polygon").length, 1);
  const g = got.find((it) => it.kind === "group"), seg = got.find((it) => it.kind === "segment"); assert.deepEqual(P.groupMembers(g.node), [seg.id], "the dropped member left its group");
  // the action tells the user
  const { ctx, log } = fakeCtx(board()); log.clip = four; pcb.runAction("paste", ctx);
  assert.deepEqual(log.toasts, ["Warning: some pasted items were on layers which are not present in the current board.\nThese items could not be pasted.\n"]); S.move = null;
  // nothing is pruned when every layer exists
  assert.equal(P.pasteChanges(board(), P.clipboardText(board(), ["s1", "s3"], [0, 0]), [0, 0]).pruned, undefined);
});

// ---------------------------------------------------------------- 4: unique reference designators
test("Paste Special, unique references: a duplicate counts up from its own number; no number starts at 1; sorted as KiCad sorts", () => {
  const src = board(`${HEAD}\n ${FP("a", "R5", 0, 0)}\n ${FP("b", "R6", 5, 0)}\n ${FP("c", "R1", 9, 0)}\n ${FP("d", "TP", 12, 0)}\n ${FP("e", "R5", 0, 9)})`);
  const text = P.clipboardText(src, ["a", "b", "c", "d", "e"], [0, 0]);
  const doc = board(`${HEAD}\n ${FP("fp5", "R5", 50, 50)}\n ${FP("fp6", "R6", 60, 50)}\n ${FP("tp", "TP", 70, 50)})`);
  const r = P.pasteChanges(doc, text, [100, 100], { annotations: "unique" });
  const refs = r.ids.map((id) => doc.items.get(id).ref);
  // clipboard order a, b, c, d, e.  Sorted: R1(c), R5(e: larger Y first), R5(a), R6(b), TP(d).
  // R1 is free; e: R5 -> R6 (board) -> R7; a: R5 -> R6 -> R7 (taken by e) -> R8; b: R6 -> R7 -> R8 -> R9; TP -> TP1
  assert.deepEqual(refs, ["R8", "R9", "R1", "TP1", "R7"]);
  // KiCad never takes the lowest free number: R5 on a board with only R5 becomes R6, not R1
  const one = board(`${HEAD}\n ${FP("fp5", "R5", 50, 50)})`); const r1 = P.pasteChanges(one, P.clipboardText(one, ["fp5"], [0, 0]), [0, 0], { annotations: "unique" });
  assert.equal(one.items.get(r1.ids[0]).ref, "R6");
});

// ---------------------------------------------------------------- 5, 6: schematic path, zone names
test("Paste: a pasted footprint has no schematic path; a pasted zone takes a unique name", () => {
  const doc = board(`${HEAD}\n ${FP("fp5", "R5", 50, 50)}\n ${ZONE("z1", "VCC", [[0, 0], [10, 0], [10, 10], [0, 10]], '(name "pour")')}\n ${ZONE("z2", "VCC", [[20, 0], [30, 0], [30, 10]], '(name "pour_1")')})`);
  assert.ok(K.kid(doc.items.get("fp5").node, "path"), "the original is linked to its symbol");
  const r = P.pasteChanges(doc, P.clipboardText(doc, ["fp5", "z1"], [0, 0]), [0, 0]);
  const fp = doc.items.get(r.ids[0]), z = doc.items.get(r.ids[1]);
  assert.equal(K.kid(fp.node, "path"), null); assert.equal(K.str(K.kid(z.node, "name")[1]), "pour_2", "pour and pour_1 are taken");
});
test("Duplicate Zone: exactly one zone, the zone dialog, unfilled copy with a unique name, moved 1 mm when the layers are the same", () => {
  const doc = board(`${HEAD}\n ${ZONE("z1", "VCC", [[0, 0], [10, 0], [10, 10], [0, 10]], '(name "pour")').replace("(fill (", "(fill yes (").replace(/\)\)$/, ") (filled_polygon (layer \"F.Cu\") (pts (xy 0 0) (xy 10 0) (xy 10 10))))")}\n ${ZONE("z2", "SIG", [[20, 0], [30, 0], [30, 10]])})`);
  const { ctx, log } = fakeCtx(doc); let opened = 0, answer = (n) => n;
  pcb.setNewItemDialogs({ zone: (c, node, done) => { opened++; done(answer(node)); return true; } });
  ctx.selection = new Set(["z1", "z2"]); pcb.runAction("zoneDuplicate", ctx); assert.equal(opened, 0, "two zones: nothing"); assert.equal(log.commits.length, 0);
  ctx.selection = new Set(["z1"]); pcb.runAction("zoneDuplicate", ctx); assert.equal(opened, 1);
  let c = log.commits.at(-1); assert.equal(c.label, "Duplicate Zone"); let n = doc.items.get(c.changes[0].id).node;
  assert.equal(K.str(K.kid(n, "name")[1]), "pour_1"); assert.equal(K.kids(n, "filled_polygon").length, 0); assert.notEqual(K.kid(n, "fill")[1], "yes");
  assert.deepEqual(K.kid(K.kid(n, "polygon"), "pts")[1], ["xy", 1, 1], "same layer: offset by (1, 1) mm");
  answer = (node) => { K.kid(node, "layer")[1] = "B.Cu"; return node; };
  ctx.selection = new Set(["z1"]); pcb.runAction("zoneDuplicate", ctx); c = log.commits.at(-1); n = doc.items.get(c.changes[0].id).node;
  assert.equal(K.str(K.kid(n, "layer")[1]), "B.Cu"); assert.deepEqual(K.kid(K.kid(n, "polygon"), "pts")[1], ["xy", 0, 0], "another layer: where the original is");
  answer = () => null; const before = log.commits.length; pcb.runAction("zoneDuplicate", ctx); assert.equal(log.commits.length, before, "Cancel adds nothing");
});

// ---------------------------------------------------------------- 7, 8: groups and paste
test("Paste: only items outside a pasted group are selected; with a group entered the pasted items join it (and leave on Escape)", () => {
  const doc = board(BOARD.replace(/\n\)$/, '\n  (group "pair" (uuid "grp") (members "s1" "s2"))\n  (group "host" (uuid "host") (members "s3" "v1"))\n)'));
  const { ctx, log } = fakeCtx(doc); log.clip = P.clipboardText(doc, ["grp", "g1"], [0, 0]); ctx.cursor = [100, 100];
  pcb.runAction("paste", ctx);
  let c = log.commits.at(-1); assert.equal(c.label, "Paste"); const added = c.changes.filter((x) => x.kind === "ADDED").map((x) => x.id);
  assert.deepEqual(kinds(doc, added).sort(), ["gr_line", "group", "segment", "segment"]);
  assert.deepEqual(kinds(doc, log.selection).sort(), ["gr_line", "group"], "the members are not selected beside their group");
  assert.equal(S.move.placing.length, 4, "everything rides the cursor"); P.finishSelectMove(ctx, false);
  // entered group
  S.enteredGroup = "host"; pcb.runAction("paste", ctx); c = log.commits.at(-1);
  const top = log.selection.slice(); assert.equal(top.length, 2);
  assert.ok(top.every((id) => P.groupMembers(doc.items.get("host").node).includes(id)), "the group and the line joined the entered group");
  assert.ok(c.changes.some((x) => x.kind === "MODIFIED" && x.id === "host"));
  P.finishSelectMove(ctx, false); assert.deepEqual(P.groupMembers(doc.items.get("host").node).sort(), ["s3", "v1"], "a cancelled paste puts the group back");
});

// ---------------------------------------------------------------- 9: the footprint editor
const FPFILE = `(footprint "R_0603" (version 20241229) (generator "pcbnew") (layer "F.Cu")
	(property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (uuid "11111111-1111-4111-8111-111111111111") (effects (font (size 1 1) (thickness 0.15))))
	(property "Value" "R_0603" (at 0 1.43 0) (layer "F.Fab") (uuid "22222222-2222-4222-8222-222222222222") (effects (font (size 1 1) (thickness 0.15))))
	(property "MPN" "X" (at 0 3 0) (layer "F.Fab") (uuid "23232323-2222-4222-8222-222222222222") (effects (font (size 1 1) (thickness 0.15))))
	(fp_line (start -0.8 -0.4) (end 0.8 -0.4) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "33333333-3333-4333-8333-333333333333"))
	(pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net "GND") (uuid "44444444-4444-4444-8444-444444444444"))
	(pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "55555555-5555-4555-8555-555555555555"))
)`;
test("Footprint Editor: copy writes a (footprint \"clipboard:…\") without mandatory fields and pad nets; paste takes a footprint apart and drops tracks", () => {
  const fdoc = K.parseDoc(FPFILE, "footprint"); assert.equal(fdoc.fpEditor, true);
  const ids = [...fdoc.items.keys()]; const text = P.clipboardText(fdoc, ids, [0, 0]); const tree = K.parse(text);
  assert.equal(tree[0], "footprint"); assert.ok(/^clipboard:/.test(tree[1]));
  assert.deepEqual(K.kids(tree, "property").map((p) => p[1]), ["MPN"], "Reference and Value stay behind"); assert.equal(K.kids(tree, "fp_line").length, 1);
  assert.ok(K.kids(tree, "pad").every((p) => !K.kid(p, "net")), "pad nets cleared");
  // into a board the clipboard footprint pastes as a footprint
  const b = board(); const rb = P.pasteChanges(b, text, [10, 10]); assert.deepEqual(kinds(b, rb.ids), ["footprint"]);
  // a board footprint (rotated 90, at 5,5 on the clipboard) plus a track and a line, pasted into the footprint editor
  const clip = `(kicad_pcb (version 20260728) (generator "pcbnew") (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
    (footprint "T:R" (layer "F.Cu") (uuid "bf") (at 5 5 90)
      (property "Reference" "R1" (at 0 -2 90) (layer "F.SilkS") (uuid "bf-r") (effects (font (size 1 1) (thickness 0.15))))
      (property "Value" "10k" (at 0 2 90) (layer "F.Fab") (uuid "bf-v") (effects (font (size 1 1) (thickness 0.15))))
      (property "Note" "n" (at 1 3 90) (layer "F.Fab") (uuid "bf-n") (effects (font (size 1 1) (thickness 0.15))))
      (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "bf-l"))
      (fp_text user "T" (at 0 0 90) (layer "F.Fab") (uuid "bf-t") (effects (font (size 1 1) (thickness 0.15))))
      (pad "7" smd rect (at -1 0 90) (size 1 1) (layers "F.Cu") (net "VCC") (uuid "bf-p")))
    (segment (start 0 0) (end 5 0) (width 0.25) (layer "F.Cu") (net "VCC") (uuid "trk"))
    (via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "VCC") (uuid "via"))
    (gr_line (start 0 2) (end 5 2) (stroke (width 0.1) (type solid)) (layer "F.SilkS") (uuid "gl")))`;
  const r = P.pasteChanges(fdoc, clip, [0, 0]); const got = r.ids.map((id) => fdoc.items.get(id));
  assert.deepEqual(got.map((it) => it.kind).sort(), ["gr_line", "gr_line", "gr_text", "pad", "property"], "no footprint, no track, no via; Reference / Value dropped");
  const pad = got.find((it) => it.kind === "pad"); assert.equal(K.kid(pad.node, "net"), null, "nets are cleared in the footprint editor");
  // the pad keeps its place on the clipboard: the footprint's position plus its local position turned by the footprint's 90 degrees
  const pa = K.atOf(pad.node); assert.ok(Math.abs(pa[0] - 5) < 1e-6 && Math.abs(Math.abs(pa[1] - 5) - 1) < 1e-6, JSON.stringify(pa));
  const note = got.find((it) => it.kind === "property"); assert.deepEqual(K.atOf(note.node), [1, 3, 0], "a field keeps its footprint-relative position, its angle turned back");
  const txt = got.find((it) => it.kind === "gr_text"); assert.equal(K.atOf(txt.node)[2] || 0, 0);
  const fl = got.filter((it) => it.kind === "gr_line").map((it) => K.kid(it.node, "start").slice(1)); assert.deepEqual(fl.sort(), [[-1, -1], [0, 2]]);
});
test("Footprint Editor: a placed paste records the pasted pad as the pad tool's master; a cancelled one does not", () => {
  const fdoc = K.parseDoc(FPFILE, "footprint"); const { ctx, log } = fakeCtx(fdoc, { fpEditor: true });
  const M = P.pad.padMemory; M.lastType = "auto"; M.lastByType = {};
  log.clip = P.clipboardText(fdoc, ["44444444-4444-4444-8444-444444444444"], [0, 0]); ctx.cursor = [3, 3];
  pcb.runAction("paste", ctx); const id = log.commits.at(-1).changes[0].id; assert.equal(fdoc.items.get(id).kind, "pad");
  P.finishSelectMove(ctx, false); assert.equal(M.lastType, "auto"); assert.equal(fdoc.items.has(id), false);
  pcb.runAction("paste", ctx); const id2 = log.commits.at(-1).changes[0].id;
  P.finishSelectMove(ctx, true, true); assert.equal(M.lastType, "smd"); assert.equal(M.lastByType.smd, id2);
});

// ---------------------------------------------------------------- 10: fields and pads
test("Copy: a selected field is copied as a board text with ${REFERENCE} / ${VALUE} resolved; a pad picked on its own in its own footprint", () => {
  const doc = board(`${HEAD}\n ${FP("fp5", "R5", 50, 50).replace('"10k" (at 0 2 0)', '"${REFERENCE}" (at 0 2 0)')})`);
  let field = { id: "fp5", name: "Value" };
  const { ctx, log } = fakeCtx(doc, { selectedField: () => field }); ctx.cursor = [50, 52];
  pcb.runAction("copy", ctx); let tree = K.parse(log.clip); const t = K.kid(tree, "gr_text");
  assert.ok(t, log.clip); assert.equal(t[1], "R5", "${REFERENCE} resolved"); assert.equal(K.str(K.kid(t, "layer")[1]), "F.SilkS"); assert.deepEqual(K.atOf(t).slice(0, 2), [0, 0], "the field's board position is the reference point");
  assert.equal(K.kid(tree, "footprint"), null);
  const r = P.pasteChanges(doc, log.clip, [10, 10]); assert.deepEqual(kinds(doc, r.ids), ["gr_text"]);
  // a pad
  field = null; S.padSel = "fp5#1"; ctx.cursor = [51, 50];
  pcb.runAction("copy", ctx); tree = K.parse(log.clip); const fp = K.kid(tree, "footprint");
  assert.ok(fp && K.kids(tree, "footprint").length === 1); assert.equal(K.kids(fp, "pad").length, 1); assert.equal(K.kids(fp, "property").length, 0);
  assert.equal(K.kid(fp, "pad")[1], "2"); assert.deepEqual(K.atOf(K.kid(fp, "pad")).slice(0, 2), [0, 0]); assert.deepEqual(K.kid(K.kid(fp, "pad"), "net"), ["net", "SIG"], "a pad keeps its net (only a lone footprint loses them)");
  assert.deepEqual(K.atOf(fp).slice(0, 2), [0, 0], "the pad's position is the reference point");
  S.padSel = null;
});

// ---------------------------------------------------------------- 12, 13: locks
test("Lock: Toggle unlocks when anything is locked; Lock / Unlock take the item under the cursor; unlocking a footprint unlocks its children", () => {
  const doc = board(BOARD.replace('(layer "F.Cu") (net "SIG") (uuid "s2")', '(locked yes) (layer "F.Cu") (net "SIG") (uuid "s2")').replace('(pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net "VCC") (uuid "fp5-p1")', '(pad "1" smd rect (at -1 0) (size 1 1) (locked yes) (layers "F.Cu") (net "VCC") (uuid "fp5-p1")').replace('(footprint "T:R" (layer "F.Cu") (uuid "fp5")', '(footprint "T:R" (locked yes) (layer "F.Cu") (uuid "fp5")'));
  const { ctx, log } = fakeCtx(doc);
  assert.ok(P.isLocked(doc.items.get("s2").node) && P.isLocked(doc.items.get("fp5").node));
  ctx.selection = new Set(["s1", "s2"]); pcb.runAction("toggleLock", ctx);
  assert.equal(log.commits.at(-1).label, "Unlock", "a mixed selection is unlocked"); assert.ok(!P.isLocked(doc.items.get("s1").node) && !P.isLocked(doc.items.get("s2").node));
  pcb.runAction("toggleLock", ctx); assert.equal(log.commits.at(-1).label, "Lock"); assert.ok(P.isLocked(doc.items.get("s1").node) && P.isLocked(doc.items.get("s2").node));
  // unlocking a footprint clears the lock on its children too
  ctx.selection = new Set(["fp5"]); pcb.runAction("unlock", ctx); assert.equal(log.commits.at(-1).label, "Unlock");
  const fp = doc.items.get("fp5").node; assert.ok(!P.isLocked(fp)); assert.ok(K.kids(fp, "pad").every((p) => !P.isLocked(p)), "the pads are unlocked with it");
  // Lock with nothing selected: the item under the cursor, and the hover selection is cleared afterwards
  ctx.selection = new Set(); ctx.cursor = [20, 14]; ctx.candidatesAt = () => ["s3"]; const n = log.commits.length; log.toasts.length = 0;
  pcb.runAction("lock", ctx); assert.equal(log.commits.length, n + 1); assert.equal(log.commits.at(-1).label, "Lock"); assert.ok(P.isLocked(doc.items.get("s3").node)); assert.deepEqual(log.toasts, []);
  assert.deepEqual([...ctx.selection], []);
  // a pad (footprint editor item) is never locked
  const fdoc = K.parseDoc(FPFILE, "footprint"); assert.equal(P.lockChanges(fdoc, ["44444444-4444-4444-8444-444444444444"], true).length, 0);
});

// ---------------------------------------------------------------- 14, 15, 16: groups
test("Group Items: at least two items, groups nest, a member leaves its old group, the group is locked with a locked member and selected", () => {
  const doc = board(BOARD.replace('(layer "B.Cu") (net "SIG") (uuid "s3")', '(locked yes) (layer "B.Cu") (net "SIG") (uuid "s3")')); const { ctx, log } = fakeCtx(doc);
  ctx.selection = new Set(["s1"]); pcb.runAction("group", ctx); assert.equal(log.commits.length, 0, "one item cannot be grouped"); assert.deepEqual(log.toasts, []);
  ctx.selection = new Set(["s1", "s2"]); pcb.runAction("group", ctx);
  let c = log.commits.at(-1); assert.equal(c.label, "Group Items"); const g1 = c.changes[0].id; assert.deepEqual(log.toasts, [], "no toast");
  assert.deepEqual([...ctx.selection].sort(), [g1, "s1", "s2"].sort()); assert.ok(!P.isLocked(doc.items.get(g1).node));
  // the group and two more items: a group of a group, locked because s3 is
  ctx.selection = new Set([g1, "s1", "s2", "s3", "v1"]); pcb.runAction("group", ctx); c = log.commits.at(-1); const g2 = c.changes[0].id;
  assert.deepEqual(P.groupMembers(doc.items.get(g2).node).sort(), [g1, "s3", "v1"].sort(), "the inner group is a member, its tracks are not"); assert.ok(P.isLocked(doc.items.get(g2).node));
  assert.deepEqual(P.groupMembers(doc.items.get(g1).node).sort(), ["s1", "s2"]);
  // inside the entered outer group: two of its members form a new group, which takes their place in it
  S.enteredGroup = g2; ctx.selection = new Set(["s3", "v1"]); pcb.runAction("group", ctx); c = log.commits.at(-1); const g3 = c.changes[0].id;
  assert.deepEqual(P.groupMembers(doc.items.get(g2).node).sort(), [g1, g3].sort(), "s3 and v1 left the outer group for the new one");
  S.enteredGroup = null;
  // a footprint's pad cannot be grouped apart from its footprint
  ctx.selection = new Set(["g1"]); S.padSel = "fp5#0"; const n = log.commits.length; pcb.runAction("group", ctx);
  assert.equal(log.commits.length, n); assert.deepEqual(log.toasts, ["Footprint items cannot be grouped separately from their parent footprint."]); S.padSel = null;
});
test("Ungroup / Add to Group / Remove from Group act as GROUP_TOOL does and leave KiCad's selection", () => {
  const doc = board(BOARD.replace(/\n\)$/, '\n  (group "a" (uuid "ga") (members "s1" "s2"))\n  (group "b" (uuid "gb") (members "s3" "v1"))\n)')); const { ctx, log } = fakeCtx(doc);
  // Add to Group: two groups selected -> nothing
  ctx.selection = new Set(["ga", "s1", "s2", "gb", "s3", "v1"]); pcb.runAction("addToGroup", ctx); assert.equal(log.commits.length, 0);
  // one group and a free item
  ctx.selection = new Set(["ga", "s1", "s2", "g1"]); pcb.runAction("addToGroup", ctx);
  assert.equal(log.commits.at(-1).label, "Add Items to Group"); assert.deepEqual(P.groupMembers(doc.items.get("ga").node).sort(), ["g1", "s1", "s2"]);
  assert.deepEqual([...ctx.selection].sort(), ["g1", "ga", "s1", "s2"], "the group is the selection");
  // an item moves out of the group it was in: with gb entered, its member s3 goes to ga
  S.enteredGroup = "gb"; ctx.selection = new Set(["ga", "s1", "s2", "g1", "s3"]); pcb.runAction("addToGroup", ctx); S.enteredGroup = null;
  assert.deepEqual(P.groupMembers(doc.items.get("gb").node), ["v1"]); assert.ok(P.groupMembers(doc.items.get("ga").node).includes("s3"));
  // Remove from Group: an entered group's member leaves it and the selection is cleared; the last member takes the group with it
  S.enteredGroup = "ga"; ctx.selection = new Set(["s3"]); pcb.runAction("removeFromGroup", ctx);
  assert.equal(log.commits.at(-1).label, "Remove Group Items"); assert.ok(!P.groupMembers(doc.items.get("ga").node).includes("s3")); assert.deepEqual([...ctx.selection], []);
  S.enteredGroup = "gb"; ctx.selection = new Set(["v1"]); pcb.runAction("removeFromGroup", ctx); assert.equal(doc.items.has("gb"), false, "an emptied group is removed"); S.enteredGroup = null;
  // Ungroup: a member alone dissolves nothing; the selected group is dissolved and its members selected
  S.enteredGroup = "ga"; ctx.selection = new Set(["s1"]); const n = log.commits.length; pcb.runAction("ungroup", ctx); assert.equal(log.commits.length, n, "the entered group survives its member's Ungroup"); S.enteredGroup = null;
  ctx.selection = new Set(["ga", "s1", "s2", "g1"]); pcb.runAction("ungroup", ctx);
  assert.equal(log.commits.at(-1).label, "Ungroup Items"); assert.equal(doc.items.has("ga"), false); assert.deepEqual([...ctx.selection].sort(), ["g1", "s1", "s2"]);
});
test("Grouping / Zone Priority menus: what update() greys", () => {
  const doc = board(BOARD.replace(/\n\)$/, `\n  (group "a" (uuid "ga") (members "s1" "s2"))\n ${ZONE("za", "VCC", [[0, 0], [10, 0], [10, 10], [0, 10]])}\n ${ZONE("zb", "SIG", [[5, 5], [15, 5], [15, 15], [5, 15]], "(priority 2)")}\n)`)); const { ctx } = fakeCtx(doc);
  const st = () => pcb.menuState(ctx);
  ctx.selection = new Set(["s3"]); assert.deepEqual(st().grouping, { count: 1, hasGroup: false, onlyOneGroup: false, hasNonGroup: true, hasMember: false });
  ctx.selection = new Set(["ga", "s1", "s2"]); assert.deepEqual(st().grouping, { count: 1, hasGroup: true, onlyOneGroup: true, hasNonGroup: false, hasMember: false });
  ctx.selection = new Set(["ga", "s1", "s2", "s3"]); assert.deepEqual(st().grouping, { count: 2, hasGroup: true, onlyOneGroup: true, hasNonGroup: true, hasMember: false });
  S.enteredGroup = "ga"; ctx.selection = new Set(["s1"]); assert.equal(st().grouping.hasMember, true); S.enteredGroup = null;
  ctx.selection = new Set(["za"]); assert.deepEqual([st().zoneCanRaise, st().zoneCanLower], [true, false]);
  ctx.selection = new Set(["zb"]); assert.deepEqual([st().zoneCanRaise, st().zoneCanLower], [false, true]);
  ctx.selection = new Set(["za", "zb"]); assert.deepEqual([st().zoneCanRaise, st().zoneCanLower], [false, false]);
});

// ---------------------------------------------------------------- 18, 20: zones
test("Zone priority: only overlapping zones matter; Raise / Lower step past the neighbour, Top / Bottom cascade the chain", () => {
  const sq = (x, y) => [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]];
  const doc = board(`${HEAD}
   ${ZONE("a", "VCC", sq(0, 0))} ${ZONE("b", "SIG", sq(5, 5), "(priority 3)")} ${ZONE("c", "GND", sq(8, 8), "(priority 4)")}
   ${ZONE("far", "X", sq(100, 100), "(priority 9)")} ${ZONE("ka", "", sq(2, 2), "(priority 7)").replace("(hatch", "(keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (hatch")})`);
  const plan = (id, how) => { const m = P.zonePriorityPlan(doc, [id], how); return m ? Object.fromEntries(m) : null; };
  assert.deepEqual(plan("a", "raise"), { a: 4 }, "just above b (3), nothing else changes; the far zone and the rule area do not count");
  assert.deepEqual(plan("c", "lower"), { c: 2 }, "just below b");
  assert.equal(plan("c", "raise"), null); assert.equal(plan("a", "lower"), null); assert.equal(plan("far", "raise"), null); assert.equal(plan("ka", "raise"), null);
  assert.deepEqual(plan("b", "lower"), { b: 0, a: 3 }, "the target is at 0: swap");
  // top: take c's 4 and push the chain at 4.. down (c -> 3, b -> 2) or take 5 (free): the fewer displaced wins -> 5
  assert.deepEqual(plan("a", "top"), { a: 5 });
  assert.deepEqual(plan("c", "bottom"), { c: 0, a: 1 }, "0 is the lowest overlapping priority: a moves up, 1 is free");
  assert.equal(P.zonePriorityPlan(doc, ["a", "b"], "raise"), null, "one zone only");
  const { ctx, log } = fakeCtx(doc); ctx.selection = new Set(["a"]);
  pcb.runAction("zonePriorityRaise", ctx); assert.equal(log.commits.at(-1).label, "Raise Zone Priority"); assert.equal(prio(doc, "a"), 4);
  const n = log.commits.length; pcb.runAction("zonePriorityRaise", ctx); pcb.runAction("zonePriorityMoveToTop", ctx); assert.equal(log.commits.length, n, "nothing overlapping is above: nothing happens"); assert.deepEqual(log.toasts, []);
  ctx.selection = new Set(["b"]); pcb.runAction("zonePriorityMoveToTop", ctx); assert.equal(log.commits.at(-1).label, "Move Zone to Top Priority"); assert.equal(prio(doc, "b"), 5, "4 is taken by a and c, 5 is free");
  pcb.runAction("zonePriorityMoveToBottom", ctx); assert.equal(log.commits.at(-1).label, "Move Zone to Bottom Priority"); assert.ok(prio(doc, "b") < Math.min(prio(doc, "a"), prio(doc, "c")));
  pcb.runAction("zonePriorityLower", ctx); assert.equal(log.commits.length, n + 2, "already at the bottom");
  ctx.selection = new Set(["c"]); pcb.runAction("zonePriorityLower", ctx); assert.equal(log.commits.at(-1).label, "Lower Zone Priority");
  assert.deepEqual(["zonePriorityMoveToTop", "zonePriorityRaise", "zonePriorityLower", "zonePriorityMoveToBottom"].map((id) => pcb.actions[id].label), ["Move to Top", "Raise", "Lower", "Move to Bottom"]);
});
test("Merge Zones: overlapping zones of one net and layer set become the first zone with the highest priority; KiCad's error otherwise", () => {
  const sq = (x, y) => [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]];
  const mk = () => board(`${HEAD} ${ZONE("a", "VCC", sq(0, 0), "(priority 1)")} ${ZONE("b", "VCC", sq(5, 5), "(priority 3)")} ${ZONE("c", "SIG", sq(8, 8))} ${ZONE("d", "VCC", sq(40, 40))})`);
  let doc = mk(); let { ctx, log } = fakeCtx(doc);
  ctx.selection = new Set(["a"]); pcb.runAction("zoneMerge", ctx); assert.equal(log.commits.length, 0, "fewer than two: nothing");
  ctx.selection = new Set(["a", "b", "c"]); pcb.runAction("zoneMerge", ctx);
  const c = log.commits.at(-1); assert.equal(c.label, "Merge Zones"); assert.deepEqual(c.changes.map((x) => [x.kind, x.id]), [["MODIFIED", "a"], ["REMOVED", "b"]], "the other net's zone is left alone");
  assert.equal(prio(doc, "a"), 3); assert.equal(K.kids(doc.items.get("a").node, "polygon").length, 1);
  assert.equal(K.kid(K.kid(doc.items.get("a").node, "polygon"), "pts").length - 1, 8, "the union of two offset squares has eight corners");
  assert.deepEqual([...ctx.selection], ["a"], "the merged zone is selected");
  // zones that do not intersect are not merged; the first zone alone is left as it is
  doc = mk(); ({ ctx, log } = fakeCtx(doc)); ctx.selection = new Set(["a", "d"]); pcb.runAction("zoneMerge", ctx);
  assert.ok(!log.commits.some((x) => x.changes.some((y) => y.kind === "REMOVED"))); assert.ok(doc.items.has("d"));
  // overlapping only through a third zone's hole is no single outline: KiCad's error, nothing changes
  const ring = `(zone (net "VCC") (layer "F.Cu") (uuid "ring") (hatch edge 0.5) (connect_pads (clearance 0.5)) (min_thickness 0.25) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
    (polygon (pts (xy 0 0) (xy 30 0) (xy 30 30) (xy 0 30))) (polygon (pts (xy 5 5) (xy 25 5) (xy 25 25) (xy 5 25))))`;
  doc = board(`${HEAD} ${ring} ${ZONE("isle", "VCC", sq(10, 10))})`); ({ ctx, log } = fakeCtx(doc));
  const r = P.zoneMergeChanges(doc, ["ring", "isle"]); assert.equal(r.error, "Zones have insufficient overlap for merging."); assert.equal(r.changes.length, 0);
  ctx.selection = new Set(["ring", "isle"]); pcb.runAction("zoneMerge", ctx); assert.deepEqual(log.toasts, ["Zones have insufficient overlap for merging."]); assert.equal(log.commits.length, 0);
});

// ---------------------------------------------------------------- 24: net highlight toggles
test("Toggle Net Highlight (Alt+`) switches the current highlight off and on; Toggle Last Net Highlight swaps with the previous nets", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc);
  assert.equal(pcb.actions.toggleNetHighlight.label, "Toggle Net Highlight"); assert.equal(pcb.actions.toggleNetHighlight.key, "Alt+`");
  assert.equal(pcb.actions.toggleLastNetHighlight.label, "Toggle Last Net Highlight"); assert.equal(pcb.actions.toggleLastNetHighlight.key, "");
  ctx.cursor = [20, 10]; pcb.runAction("highlightNet", ctx); assert.equal(S.highlightNet, "VCC"); assert.deepEqual(log.highlight.nets, ["VCC"]);
  ctx.cursor = [80, 80]; pcb.runAction("toggleNetHighlight", ctx); assert.equal(S.highlightNet, null, "off, wherever the mouse is"); assert.equal(log.highlight, null);
  pcb.runAction("toggleNetHighlight", ctx); assert.equal(S.highlightNet, "VCC", "and back on"); assert.deepEqual(log.highlight.nets, ["VCC"]);
  ctx.cursor = [20, 12]; pcb.runAction("highlightNet", ctx); assert.equal(S.highlightNet, "SIG");
  pcb.runAction("toggleLastNetHighlight", ctx); assert.equal(S.highlightNet, "VCC"); pcb.runAction("toggleLastNetHighlight", ctx); assert.equal(S.highlightNet, "SIG");
  pcb.runAction("clearHighlight", ctx); assert.equal(S.highlightNet, null);
  pcb.runAction("toggleNetHighlight", ctx); assert.equal(S.highlightNet, null, "Clear forgets the current nets");
  pcb.runAction("toggleLastNetHighlight", ctx); assert.equal(S.highlightNet, null, "and the last ones");
});

// ---------------------------------------------------------------- 29, 30: pad tool
test("Pad tool: the default NPTH pad sits on F&B.Cu and *.Mask; Renumber Pads moves the last pad number; a new document starts at 1", () => {
  assert.deepEqual(K.kid(P.pad.defaultPad("npth"), "layers"), ["layers", "F&B.Cu", "*.Mask"]);
  const fdoc = K.parseDoc(FPFILE, "footprint"); const { ctx } = fakeCtx(fdoc, { fpEditor: true }); const M = P.pad.padMemory, FPP = P.fpPads;
  const pads = [...fdoc.items.values()].filter((it) => it.kind === "pad");
  const st = FPP.enumBegin("A", 5, 1);
  FPP.enumPick(st, fdoc, [pads[0]], true); assert.equal(M.lastNumber, "A5", "SetLastPadNumber( newNumber )");
  FPP.enumPick(st, fdoc, [pads[1]], true); assert.equal(M.lastNumber, "A6");
  FPP.enumPick(st, fdoc, [pads[1]], true); assert.equal(M.lastNumber, "2", "a pad clicked again gets its old number back, and so does the memory");
  M.lastNumber = "17"; const other = K.parseDoc(FPFILE, "footprint"); ctx.doc = other; pcb.onDocChanged(ctx); assert.equal(M.lastNumber, "1", "PAD_TOOL::Reset( MODEL_RELOAD )");
});

// ---------------------------------------------------------------- 31, 32: sizes
test("Via size on a selection: complex padstacks are skipped with KiCad's message; the via always takes the preset's drill", () => {
  const R = K.pcbSizes.state;
  const doc = board(`${HEAD}
    (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "A") (uuid "plain"))
    (via (at 2 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (padstack (mode front_inner_back) (layer "Inner" (size 0.5))) (net "A") (uuid "cx")))`);
  const { ctx, log } = fakeCtx(doc); pcb.onDocChanged(ctx);
  const next = R.steppedVia(0.6, true);
  ctx.selection = new Set(["cx"]); pcb.runAction("viaSizeInc", ctx);
  assert.equal(log.commits.length, 0); assert.deepEqual(log.toasts, ["Increase Via Size not supported on complex padstacks."]);
  log.toasts.length = 0; pcb.runAction("viaSizeDec", ctx); assert.deepEqual(log.toasts, R.steppedVia(0.6, false) || true ? ["Decrease Via Size not supported on complex padstacks."] : []);
  if (next) {
    log.toasts.length = 0; ctx.selection = new Set(["plain", "cx"]); pcb.runAction("viaSizeInc", ctx);
    assert.equal(log.commits.at(-1).label, "Increase Via Size"); assert.equal(log.commits.at(-1).changes.length, 1); assert.deepEqual(log.toasts, [], "something changed: no message");
    const n = doc.items.get("plain").node; assert.equal(K.kid(n, "size")[1], next.diameter); assert.equal(K.kid(n, "drill")[1], next.drill, "via->SetDrill( dims.m_Drill )");
  }
});
test("Automatically select track width: custom sizes are switched off and the connected width turned on; silent", () => {
  const R = K.pcbSizes.state; const { ctx, log } = fakeCtx(board());
  R.setUseConnectedWidth(true); R.setCustomTrackVia(0.3, 0.7, 0.3); assert.equal(R.useCustomTrackVia, true);
  pcb.runAction("autoTrackWidth", ctx); assert.equal(R.useCustomTrackVia, false); assert.equal(R.useConnectedWidth, true, "not toggled off: custom sizes were in use");
  pcb.runAction("autoTrackWidth", ctx); assert.equal(R.useConnectedWidth, false); pcb.runAction("autoTrackWidth", ctx); assert.equal(R.useConnectedWidth, true);
  assert.deepEqual(log.toasts, []);
});

// ---------------------------------------------------------------- 36: ratsnest
test("Show Ratsnest and Hide / Show Net in Ratsnest are silent; Show with nothing selected changes nothing; the appearance panel is told", () => {
  const { ctx, log } = fakeCtx(board());
  const was = S.showRatsnest; pcb.runAction("showRatsnest", ctx); assert.equal(S.showRatsnest, !was); pcb.runAction("showRatsnest", ctx);
  ctx.selection = new Set(["s1"]); pcb.runAction("hideNetInRatsnest", ctx); assert.deepEqual([...S.hiddenNets], ["VCC"]); assert.deepEqual(log.hidden.at(-1), [["VCC"], false]);
  ctx.selection = new Set(); pcb.runAction("showNetInRatsnest", ctx); assert.deepEqual([...S.hiddenNets], ["VCC"], "nothing selected: no net is un-hidden");
  pcb.runAction("hideNetInRatsnest", ctx); assert.equal(log.hidden.length, 1);
  ctx.selection = new Set(["s1"]); pcb.runAction("showNetInRatsnest", ctx); assert.deepEqual([...S.hiddenNets], []); assert.deepEqual(log.hidden.at(-1), [["VCC"], true]);
  assert.deepEqual(log.toasts, []);
});

// ---------------------------------------------------------------- 38: undo step names
test("Undo step names are KiCad's commit messages", () => {
  const doc = board(); const { ctx, log } = fakeCtx(doc); ctx.cursor = [20, 10];
  ctx.selection = new Set(["g1"]); pcb.runAction("cut", ctx); assert.equal(log.commits.at(-1).label, "Cut");
  pcb.runAction("paste", ctx); assert.equal(log.commits.at(-1).label, "Paste"); P.finishSelectMove(ctx, false);
  ctx.selection = new Set(["s1"]); pcb.runAction("duplicate", ctx); assert.equal(log.commits.at(-1).label, "Duplicate"); P.finishSelectMove(ctx, false);
});

// ---------------------------------------------------------------- 28 / 35: editor-side display actions
const editorSrc = (...p) => require("fs").readFileSync(path.join(__dirname, "..", "..", "web", "domains", "pcb", ...p), "utf8");
test("Pad Edit Mode dims the other layers and puts the contrast mode back on exit", () => {
  const src = editorSrc("editor", "fpedit.ts");
  assert.match(src, /padEditContrast = getInactiveMode\(\); if \(padEditContrast === "normal"\) setInactiveMode\("dim"\)/);
  assert.match(src, /function leavePadEditContrast\(\): void \{[^\n]*if \(prev && prev !== getInactiveMode\(\)\) setInactiveMode\(prev\)/);
  assert.equal(src.split("leavePadEditContrast();").length - 1, 2, "left by Ctrl+E / Esc and when the pad is deleted");
});
test("Zone display: unfilled-zones warning, Toggle Zone Display, ratsnest and net colour 3-state cycles", () => {
  const src = editorSrc("editor", "actions.ts"), ap = editorSrc("editor", "panels", "appearance.ts");
  assert.match(src, /zoneDisplayFilled: \(\) => \{ unfilledZoneCheck\(\);/);
  assert.ok(src.includes("Not all zones are filled. Use Edit > Fill All Zones (${keyName(") && src.includes(") if you wish to see all fills.`, 5000,") && src.includes(`text: "Don't show again"`));
  assert.match(src, /zoneDisplayToggle: \(\) => \{ const outline = !E\.renderOpts\.zoneOutline;/);
  assert.match(src, /ratsnestModeCycle: \(\) => cycleRatsnestMode\(\), netColorModeCycle: \(\) => cycleNetColorMode\(\)/);
  assert.ok(ap.includes('user.netColorMode === "all" ? "ratsnest" : user.netColorMode === "ratsnest" ? "off" : "all"'));
  // RatsnestModeCycle: hidden → all → visible → hidden, the hidden state being the global ratsnest switch (appearance-model.ts)
  assert.ok(ap.includes('ratsnestCycle(objectVisible("ratsnest"), user.ratsnestMode)'));
  assert.ok(editorSrc("dialogs", "maintenance.ts").includes('"kc.dontshow."'), "Reset \"Don't Show Again\" clears the answer");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
