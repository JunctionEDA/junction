// lib-choosers.test.js — the symbol / footprint choosers' KiCad behaviour under node: EDA_COMBINED_MATCHER's search
// (wildcard, regex, relational terms, ScoreTerms weights, the exact-match tier, "::" and the 100-term cap), StrNumCmp
// order, GenerateAliasInfo / GenerateFootprintInfo, the footprint selector's entries (FOOTPRINT_SELECT_WIDGET), the
// separate session histories, "-- Already Placed --", the pin functions on the preview's pads, the Place Footprint
// tool's context menu, and source checks for what lives in the DOM (titles, status texts, tooltips, the debounce, the
// persistent Place Footprint tool, SelectUnit).  Run: node server/static/tests/lib-choosers.test.js
"use strict";
const path = require("path"), assert = require("assert"), fs = require("fs");
const { webPath } = require("./web-path");
require(path.join(__dirname, "..", "kicad-canvas.js"));
const K = globalThis.KiCadCanvas;
globalThis.window = globalThis; globalThis.addEventListener = globalThis.addEventListener || (() => {}); globalThis.removeEventListener = globalThis.removeEventListener || (() => {});
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
function load(...p) {
  const out = esbuild.buildSync({ entryPoints: [webPath(...p)], bundle: true, format: "cjs", target: "es2020", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const C = load("domains", "pcb", "library", "core.ts");
const F = load("domains", "pcb", "library", "fpchoice.ts");
const S = load("domains", "pcb", "library", "sources.ts");
const P = load("domains", "pcb", "library", "preview.ts");
const T = load("domains", "pcb", "library", "libtree.ts");
const M = load("domains", "pcb", "editor", "ctxmenus.ts");
const src = (...p) => fs.readFileSync(webPath(...p), "utf8");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 6).join("\n       ")); } }
console.log("library choosers under node");

const row = (o) => Object.assign({ name: "R", description: "Resistor", keywords: "R res resistor", library: "Device", kind: "symbol", units: 1, footprint: "" }, o);

test("finding 1: ScoreTerms weights (name 8 x8 when equal and IsName -> exact; Lib:Name 16; keyword 4; description 1)", () => {
  const m = C.searchMatch(row({}), "r");
  // "r": name equal (8*8=64, exact), "device:r" contains r at 7 (16), keywords "r" equal (4*8=32), "res" at 0 (4*2=8),
  // "resistor" at 0 (8), the keyword string at 0 (1*2=2), the description at 0 (2), nickname "device" has no r -> 0
  assert.strictEqual(m.exact, true);
  assert.ok(m.score > 100, "the score adds every term's weight: " + m.score);
  const none = C.searchMatch(row({}), "capacitor");
  assert.strictEqual(none.score, 0, "every search term must match");
  assert.strictEqual(C.searchMatch(row({}), "").score, 1, "an empty search leaves every item at 1");
});
test("finding 1: an exact name match outranks a higher score; prefix beats elsewhere", () => {
  const exact = C.searchMatch(row({ name: "LM358", description: "", keywords: "" }), "lm358");
  const longer = C.searchMatch(row({ name: "LM358B", description: "LM358 LM358 dual op amp lm358", keywords: "lm358 lm358 lm358 lm358" }), "lm358");
  assert.strictEqual(exact.exact, true); assert.strictEqual(longer.exact, false);
  assert.ok(longer.score > exact.score, "the other one scores more, yet sorts below (Compare's exact tier)");
  const atStart = C.searchMatch(row({ name: "OPA1", description: "", keywords: "" }), "opa"), inside = C.searchMatch(row({ name: "XOPA1", description: "", keywords: "" }), "opa");
  assert.ok(atStart.score > inside.score);
});
test("finding 1: wildcard, regex and relational terms (units=4, r>=10k with units), '::' stripped, 100 terms at most", () => {
  assert.ok(C.searchMatch(row({ name: "R_0603" }), "r_*3").score > 0, "a wildcard is unanchored");
  assert.ok(C.searchMatch(row({ name: "R_0603" }), "r_0?03").score > 0);
  assert.ok(C.searchMatch(row({ name: "R_0603" }), "/^r_0[0-9]+$").score > 0, "a /regex");
  assert.ok(C.searchMatch(row({ units: 4 }), "units=4").score > 0, "units=N is a search term of a symbol");
  assert.strictEqual(C.searchMatch(row({ units: 2 }), "units>=4").score, 0);
  assert.ok(C.searchMatch(row({ units: 4 }), "units>=2").score > 0);
  assert.ok(C.searchMatch(row({ description: "resistor r=12k 1%" }), "r>=10k").score > 0, "relational with a unit (k)");
  assert.strictEqual(C.searchMatch(row({ description: "resistor r=4k7" }), "r>=10k").score, 0);
  assert.strictEqual(C.searchMatch(row({ kind: "footprint" }), "units=1").score, 0, "a footprint has no units term");
  assert.ok(C.searchMatch(row({ footprint: "Resistor_SMD:R_0603" }), "resistor_smd").score > 0, "the default footprint is searched");
  assert.deepStrictEqual(C.compileLibSearch("::R").map((m) => m.pattern), ["r"]);
  assert.strictEqual(C.compileLibSearch(Array.from({ length: 150 }, (_, i) => "t" + i).join(" ")).length, 100);
  assert.strictEqual(C.searchMatch(row({}), "constructor=1").score, 0, "no prototype key is a unit");
});
test("finding 26: a shown column's field value is searched at weight 4", () => {
  const r = row({ name: "Q1", description: "", keywords: "", fields: { Value: "BC547" } });
  assert.strictEqual(C.searchMatch(Object.assign({}, r, { columns: ["Item", "Description"] }), "bc547").score, 0);
  assert.ok(C.searchMatch(Object.assign({}, r, { columns: ["Item", "Description", "Value"] }), "bc547").score > 0);
});
test("finding 1: the editor trees (libtree.ts) score with the same matcher", () => {
  assert.ok(T.treeScore({ name: "R_0603", lib: "Resistor_SMD", desc: "", keywords: "" }, "r_*").score > 0);
  assert.strictEqual(T.treeScore({ name: "LM358", lib: "Amplifier", desc: "", keywords: "" }, "lm358").exact, true);
});
test("finding 18: StrNumCmp, case ignored, digit runs as numbers", () => {
  const names = ["R10", "r2", "R1", "C1", "c10", "C2"];
  assert.deepStrictEqual(names.slice().sort(C.strNumCmpNoCase), ["C1", "C2", "c10", "R1", "r2", "R10"]);
});
test("finding 9: GenerateAliasInfo: name, derived-from line, keywords, a row per field (Reference with ? and unit, Value skipped, empty rows kept, Datasheet a link cut at 72)", () => {
  const ds = "https://example.com/" + "x".repeat(80) + ".pdf";
  const html = C.symbolDetailsHtml({ name: "LM358", parent: { name: "LM2904", description: "Dual op amp" }, description: "Dual op amp\nsee https://ti.com", keywords: "opamp",
    fields: [{ name: "Reference", value: "U" }, { name: "Value", value: "LM358" }, { name: "Footprint", value: "" }, { name: "Datasheet", value: ds }, { name: "Description", value: "" }, { name: "Sim", value: "file://x" }], unit: 2, units: 2 });
  assert.ok(html.startsWith("<b>LM358</b>"));
  assert.ok(html.includes("<i>Derived from LM2904 (Dual op amp)</i>"));
  assert.ok(html.includes("Dual op amp<br>see <a href=\"https://ti.com\">https://ti.com</a>"), "line breaks kept, links made");
  assert.ok(html.includes("<br>Keywords: opamp"));
  assert.ok(html.includes("<td><b>Reference</b></td><td>U?B</td>"), "GetFullText( unit )");
  assert.ok(!html.includes("<b>Value</b>"), "Value is skipped");
  assert.ok(html.includes("<td><b>Footprint</b></td><td></td>") && html.includes("<td><b>Description</b></td><td></td>"), "empty fields keep their rows");
  assert.ok(html.includes(">" + ds.slice(0, 72) + "...</a>"), "a long datasheet text is cut");
  assert.ok(html.includes('<a href="file://x">'), "a field holding a URL is a link");
  assert.ok(!/Units|Library/.test(html), "no units or library rows");
  const one = C.symbolDetailsHtml({ name: "R", description: "", keywords: "", fields: [{ name: "Reference", value: "R" }], unit: 1, units: 1 });
  assert.ok(one.includes("<td>R?</td>"), "a single-unit symbol has no unit letter");
});
test("finding 9: GenerateFootprintInfo: Keywords and Documentation (the Datasheet field, else the description's first link)", () => {
  assert.strictEqual(C.footprintDocumentationUrl("", "SOIC-8, see https://www.jedec.org/ms-012."), "https://www.jedec.org/ms-012");
  assert.strictEqual(C.footprintDocumentationUrl("https://d.pdf", "x https://other"), "https://d.pdf");
  assert.strictEqual(C.footprintDocumentationUrl("", "no link"), null);
  const html = C.footprintDetailsHtml({ name: "SOIC-8", description: "SOIC (https://a.b/c)", keywords: "SOIC SO" });
  assert.ok(html.startsWith("<b>SOIC-8</b><br>"));
  assert.ok(html.includes("<td><b>Keywords</b></td><td>SOIC SO</td>"));
  assert.ok(html.includes('<td><b>Documentation</b></td><td><a href="https://a.b/c">https://a.b/c</a></td>'));
  assert.strictEqual(C.footprintInfo('(footprint "X" (property "Datasheet" "https://d" (at 0 0 0) (layer "F.Fab")))').datasheet, "https://d");
});
test("finding 24: unit rows show the symbol's unit names", () => {
  assert.strictEqual(C.unitDisplayName(2, [undefined, "Power"]), "Power");
  assert.strictEqual(C.unitDisplayName(1, [undefined, "Power"]), "Unit A");
  assert.strictEqual(C.unitDisplayName(27, null, false), "AA");
  const sym = K.parse('(symbol "U" (symbol "U_1_1" (unit_name "Logic")) (symbol "U_2_1"))');
  assert.deepStrictEqual(S.symbolUnitNames(sym), ["Logic"]);
});
test("finding 3: FOOTPRINT_SELECT_WIDGET entries: [Default], associated footprints, pcbnew's filterFootprints (pin count, anchored filters, 400 at most)", () => {
  const all = [{ library: "Package_SO", name: "SOIC-8_3.9x4.9mm_P1.27mm", pads: 8 }, { library: "Package_DIP", name: "DIP-8_W7.62mm", pads: 8 },
    { library: "Package_SO", name: "SOIC-14_3.9x8.7mm_P1.27mm", pads: 14 }, { library: "Package_SO", name: "SO-8_5.3x6.2mm_P1.27mm", pads: 8 }];
  const e = F.footprintSelectEntries("Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", ["My:Assoc"], 8, ["SOIC*3.9x4.9mm*P1.27mm*", "DIP*W7.62mm*"], all);
  assert.deepStrictEqual(e.map((x) => x.label), ["[Default] Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "My:Assoc", "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm", "Package_DIP:DIP-8_W7.62mm"]);
  assert.strictEqual(e[0].value, "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm");
  assert.deepStrictEqual(F.footprintSelectEntries("", [], 0, [], all).map((x) => [x.label, x.value]), [["No default footprint", ""]], "m_zero_filter: no filters, no pins");
  assert.strictEqual(F.footprintSelectEntries("", [], 8, [], all).length, 4, "the pin count alone lists every 8-pad footprint");
  assert.strictEqual(F.footprintSelectEntries("", [], 8, [], all, 2).length, 3, "aMaxItems");
  assert.deepStrictEqual(F.footprintSelectEntries("", [], 0, ["package_dip:*"], all).map((x) => x.value), ["", "Package_DIP:DIP-8_W7.62mm"], "a ':' pattern matches lib:name");
});
test("finding 16: the preview's pads take the symbol's pin names (SetPinFunctions; none is '')", () => {
  const fp = K.parse('(footprint "X" (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu") (pinfunction "old")) (pad "3" smd rect (at 4 0) (size 1 1) (layers "F.Cu")))');
  P.withPinFunctions(fp, { 1: "IN-", 2: "A/B" });
  const pads = K.kids(fp, "pad");
  assert.strictEqual(K.str(K.kid(pads[0], "pinfunction")[1]), "IN-");
  assert.strictEqual(K.str(K.kid(pads[0], "net")[1]), "IN-", "the pad label shows it");
  assert.strictEqual(K.str(K.kid(pads[1], "net")[1]), "A{slash}B", "a slash survives the net-name label");
  assert.strictEqual(K.kid(pads[2], "pinfunction"), null, "no pin name: no pin function");
});
test("finding 19: separate session histories with unit and fields; footprints keep 7, the picker 8", () => {
  const it = (i) => ({ id: "Device:R" + i, name: "R" + i, library: "Device", source: "official" });
  S.rememberRecent("symbol", it(1), { unit: 2, fields: { Footprint: "Resistor_SMD:R_0603" } });
  S.rememberRecent("symbol", it(2), { power: true });
  assert.deepStrictEqual(S.recentItems("symbol").map((r) => r.id), ["Device:R1"]);
  assert.deepStrictEqual(S.recentItems("symbol", { power: true }).map((r) => r.id), ["Device:R2"]);
  const r1 = S.recentItems("symbol")[0];
  assert.strictEqual(r1.unit, 2); assert.strictEqual(r1.fields.Footprint, "Resistor_SMD:R_0603"); assert.strictEqual(r1.footprint, "Resistor_SMD:R_0603");
  for (let i = 0; i < 10; i++) S.rememberRecent("footprint", { id: "L:F" + i, name: "F" + i, library: "L", source: "official" });
  assert.strictEqual(S.recentItems("footprint").length, 7); assert.strictEqual(S.recentItems("footprint")[0].id, "L:F9");
  for (let i = 0; i < 10; i++) S.rememberRecent("symbol", it(i), { picker: true, unit: 3 });
  assert.strictEqual(S.recentItems("symbol", { picker: true }).length, 8);
  assert.strictEqual(S.recentItems("symbol", { picker: true })[0].unit, undefined, "the picker keeps lib ids only");
  for (let i = 0; i < 30; i++) S.rememberRecent("symbol", it(100 + i));
  assert.strictEqual(S.recentItems("symbol").length, 31, "the symbol history is not capped");
  S.rememberRecent("symbol", { id: "x", name: "x", source: "placed" });
  assert.ok(!S.recentItems("symbol").some((r) => r.id === "x"), "only what can be fetched again");
});
test("finding 11: '-- Already Placed --': every sheet's library symbols, sorted by name, none for footprints", () => {
  const lib = (n) => K.parse(`(symbol "${n}" (property "Reference" "U" (at 0 0 0)) (property "Value" "${n.split(":").pop()}" (at 0 0 0)) (symbol "${n}_1_1"))`);
  const doc = K.parseDoc(`(kicad_sch (version 20250114) (generator "eeschema") (lib_symbols ${K.serialize(Object.assign(lib("Z:Zeta"), { 1: "Z:Zeta" }))}))`);
  const other = new Map([["A:Alpha", lib("A:Alpha")], ["Z:Zeta", lib("Z:Zeta")]]);
  const placed = S.placedItems("symbol", doc, other);
  assert.deepStrictEqual(placed.map((r) => r.id), ["A:Alpha", "Z:Zeta"]);
  assert.strictEqual(placed[0].value, "Alpha");
  assert.deepStrictEqual(S.placedItems("footprint", doc, other), []);
});
test("finding 32: the Place Footprint tool's context menu: Cancel, Get and Place Footprint with nothing selected, Zoom, Grid", () => {
  const ctx = (o) => Object.assign({ editor: "pcb", kinds: [], tool: "placeFootprint", busy: false, drawingLine: false, routing: false, canClose: false, canUndoPoint: false, highlight: false, belowRoot: false, hasLocked: false, hasUnlocked: false, hasItems: true, checks: {} }, o);
  const flat = (list) => list.map((e) => e.sep ? "-" : e.menu ? ">" + e.menu.title : e.act.split("::").pop());
  const m = flat(M.evaluate(M.menuFor(ctx({}), false), ctx({})));
  assert.strictEqual(m[0], "cancelInteractive"); assert.ok(m.includes("getAndPlace")); assert.ok(m.includes(">Zoom") && m.includes(">Grid"));
  const busy = flat(M.evaluate(M.menuFor(ctx({ kinds: ["footprint"] }), false), ctx({ kinds: ["footprint"] })));
  assert.ok(!busy.includes("getAndPlace"));
});

// ---- what lives in the DOM: checked in the source
const chooser = src("domains", "pcb", "library", "chooser.ts"), library = src("domains", "pcb", "editor", "library.ts");
test("findings 4-8, 20-23, 27-30: the chooser's tree behaviour", () => {
  assert.ok(/lastSearch\[searchKey\] = input\.value/.test(chooser), "4: the symbol / power search is kept");
  assert.ok(/recent0 \? recent0\.id/.test(chooser) && /preselectUnit/.test(chooser), "5: the history's first entry (and its unit) is preselected");
  assert.ok(/if \(next\) expanded\.clear\(\);/.test(chooser), "6: a new search collapses everything first");
  assert.ok(/const open = searching \? !expanded\.has\("-" \+ g\.key\) : expanded\.has\(g\.key\)/.test(chooser), "7: filtering alone opens nothing");
  assert.ok(/x\.score > 1 && \(!best \|\| \(x\.exact && !best\.exact\)/.test(chooser), "8: showResults' best match");
  assert.ok(/else if \(searching && !scored\.length\) continue;/.test(chooser), "20: the -- groups stay, empty, without a search");
  assert.ok(/\(inText \|\| fpChooser\) && input\.value/.test(chooser), "21: Escape clears the footprint search from anywhere");
  assert.ok(/case "ArrowRight": if \(inText\) \{ handled = false; break; \} if \(row && row\.expandable && !row\.expanded\) toggle\(row\); break;/.test(chooser), "22: Right only opens");
  assert.ok(/NumpadAdd/.test(chooser), "22: keypad + / -");
  assert.ok(/else selectedBodyStyle = 1;/.test(chooser), "23: one body style resets the choice");
  assert.ok(chooser.includes('"Footprint Chooser"') && chooser.includes('"Symbol Chooser"') && /\$\{itemCount\(\)\} items loaded/.test(chooser), "27: titles and the item count");
  assert.ok(chooser.includes('title="Keep the symbol selected for subsequent clicks."') && chooser.includes('title="Sequentially place all units of the symbol."'), "28: tooltips");
  assert.ok(!/unitsBox\.disabled/.test(chooser), "28: Place all units is never greyed");
  assert.ok(/noteSearch\(\); userPicked = true;/.test(chooser), "29: a mouse pick records the search");
  assert.ok(/setTimeout\(run, 200\)/.test(chooser), "30: the 200 ms debounce");
});
test("findings 3, 9-17, 24-26, 31, 33: the chooser's panes and options", () => {
  assert.ok(/fieldEdits\.Footprint = fpOverride/.test(chooser) && /fieldEdits: edits/.test(chooser), "3: the footprint override is a field edit");
  assert.ok(/openDatasheet\(href/.test(chooser), "9: links go through GetAssociatedDocument");
  assert.ok(/picker\?: boolean/.test(chooser), "10: the lib id picker");
  assert.ok(/items: picker \? \[\] : placedItems\(kind, ctx\.doc, ctx\.otherLibs\)/.test(chooser) && /const placedGroup: Group \| null = isSym \?/.test(chooser), "11");
  assert.ok(/const showFp = isSym && !power && !picker && opts\.showFootprints !== false/.test(chooser), "12");
  assert.ok(/kui\.libtree\.open\./.test(chooser), "14: open libraries come back");
  for (const t of ["Show/hide description panel", "Show/hide 3D view panel", "Show/hide footprint view panel", "Show 3D viewer in own window"]) assert.ok(chooser.includes(t), "15: " + t);
  assert.ok(/addEventListener\("wheel"/.test(chooser) && /drawRuler/.test(chooser) && /pinNames: fpf && fpf\.pinNames/.test(chooser), "16: zoom, pan, ruler, pin names");
  for (const t of ["No symbol selected", "No footprint selected", "No footprint specified", "Invalid footprint specified", "Footprint not found."]) assert.ok(chooser.includes(t), "17: " + t);
  assert.ok(/unitDisplayName\(u, it\.unitNames\)/.test(chooser), "24");
  assert.ok(/\.klib-row\.derived \.klib-item \{ font-style: italic; \}/.test(chooser), "25");
  assert.ok(chooser.includes("Select Columns...") && chooser.includes("Select Columns<"), "26");
  assert.ok(/autoplace: opts\.autoplace/.test(chooser) && /schPreviewAutoplace/.test(library), "31");
  assert.ok(/kui\.chooser\.size\./.test(chooser) && /klib-hsplit/.test(chooser), "33");
});
test("findings 2, 32: Place Footprint is a tool (front side, orientation 0, 'Place Footprint', PENCIL, Ctrl off grid, Undo drops, rotation step, flip direction)", () => {
  assert.ok(library.includes('ctx.commit([P.addedChange(ctx.doc, node)], "Place Footprint")'));
  assert.ok(!/setSelected\(\{ id: change\.id \}\)/.test(library) && /clearSelection\(\)/.test(library), "nothing is selected after a placement");
  assert.ok(/if \(!c\) \{ void chooseAndPlace\("footprint"\)/.test(library), "a click with no footprint opens the chooser");
  assert.ok(/if \(c\) endFootprintCarry\(\); else endFootprintTool\(true\)/.test(library), "Escape: the carry, then the tool");
  assert.ok(!/activeLayer/.test(library) && /flipCarried\(P, node\)/.test(library) && /P\.rotateFootprintNode\(node, -a0\)/.test(library), "front side, orientation 0");
  assert.ok(library.includes('setCursorOverride("PENCIL")') && /ev\.ctrlKey \? w : snapMm/.test(library), "PENCIL, Ctrl turns snapping off");
  assert.ok(/mod && !ev\.shiftKey && \(ev\.key === "z"/.test(library) && /rotationStep\(\)/.test(library) && /flipDirection !== "lr"/.test(library));
});
test("finding 13: SelectUnit asks about a unit placed elsewhere, swaps or duplicates, autoplaces, and names its commits", () => {
  const su = src("domains", "pcb", "dialogs", "sync-units.ts"), ann = src("domains", "pcb", "tools", "sch-tools", "annotate.ts");
  assert.ok(su.includes("Symbol unit '${target}' is already placed (on sheet '${sheetNameForMessage(holder.human)}')"));
  assert.ok(su.includes('"Unit Already Placed"') && su.includes("`Swap '${target}' and '${currName}'`") && su.includes("`Duplicate '${target}'`") && su.includes("Do not show again"));
  assert.ok(su.includes('swap ? "Swap Units" : "Change Unit"') && /autoplaceNode\(doc/.test(su));
  assert.ok(/root\.CollabEditor\.selectUnit/.test(ann) && ann.includes('"Change Body Style"'));
});

console.log(`\nlib-choosers: ${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
