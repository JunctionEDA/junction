// sch-connectivity.test.js — the KiCad connectivity rules of the web schematic (eeschema/connection_graph.cpp,
// sch_connection.cpp, sch_label.cpp, net_navigator.cpp, the netlist exporters): what connects, how nets are named,
// what the Net Navigator lists and how labels, junctions and bus entries follow.
// Run: node server/static/tests/sch-connectivity.test.js
"use strict";
const path = require("path"), assert = require("assert");
require(path.join(__dirname, "..", "kicad-canvas.js")); require(path.join(__dirname, "..", "sch-tools.js"));
const K = globalThis.KiCadCanvas, N = K.pcbNetlist, SN = K.schNets, sch = globalThis.CollabTools.sch;
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || e).toString().split("\n").slice(0, 5).join("\n       ")); } }
console.log("schematic connectivity (KiCad parity) under node");

const FX = `(effects (font (size 1.27 1.27)))`;
const pinDef = (type, x, y, rot, name, number, hide) => `(pin ${type} line (at ${x} ${y} ${rot}) (length 1.27) ${hide ? "(hide yes) " : ""}(name "${name}" ${FX}) (number "${number}" ${FX}))`;
const libSym = (id, ref, extra, pins) => `(symbol "${id}" ${extra} (property "Reference" "${ref}" (at 0 0 0) ${FX}) (property "Value" "${id.split(":")[1]}" (at 0 0 0) ${FX}) (symbol "${id.split(":")[1]}_1_1" ${pins.join(" ")}))`;
const LIB = `(lib_symbols
  ${libSym("Device:R", "R", "", [pinDef("passive", 0, 3.81, 270, "~", "1"), pinDef("passive", 0, -3.81, 90, "~", "2")])}
  ${libSym("power:GND", "#PWR", "(power)", [pinDef("power_in", 0, 0, 270, "GND", "1")])}
  ${libSym("power:+3V3", "#PWR", "(power)", [pinDef("power_in", 0, 0, 90, "+3V3", "1")])}
  ${libSym("power:PWR_FLAG", "#FLG", "(power)", [pinDef("power_out", 0, 0, 90, "pwr", "1")])}
  ${libSym("X:IC", "U", "", [pinDef("power_in", 0, 5.08, 270, "VCC", "8", true), pinDef("passive", -5.08, 0, 0, "A", "1"), pinDef("passive", 5.08, 0, 180, "B", "2")])}
  ${libSym("X:JG", "JP", `(jumper_pin_groups ("1" "3"))`, [pinDef("passive", -5.08, 0, 0, "A", "1"), pinDef("passive", 0, 5.08, 270, "B", "2"), pinDef("passive", 5.08, 0, 180, "C", "3")])}
  ${libSym("X:JS", "JP", `(jumper_pin_groups ("A1" "2"))`, [pinDef("passive", -5.08, 0, 0, "A", "[A1,A12]"), pinDef("passive", 5.08, 0, 180, "C", "2")])}
  ${libSym("X:DUP", "SW", `(duplicate_pin_numbers_are_jumpers yes)`, [pinDef("passive", -5.08, 0, 0, "A", "1"), pinDef("passive", 5.08, 0, 180, "A", "1"), pinDef("passive", 0, 5.08, 270, "B", "2")])}
  ${libSym("X:NOJ", "SW", "", [pinDef("passive", -5.08, 0, 0, "A", "1"), pinDef("passive", 5.08, 0, 180, "A", "1")])}
  ${libSym("X:NCP", "U", "", [pinDef("no_connect", -5.08, 0, 0, "NC", "1"), pinDef("passive", 5.08, 0, 180, "B", "2")])}
)`;
const U_ROOT = "11111111-1111-1111-1111-111111111111";
let uid = 0; const nid = (p) => p + "-" + (++uid);
const symbol = (lib, ref, x, y, o = {}) => `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit ${o.unit || 1}) ${o.onBoard === false ? "(on_board no) " : ""}(uuid "${o.id || ref}") (property "Reference" "${ref}" (at ${x} ${y} 0) ${FX}) (property "Value" "${o.value || lib.split(":")[1]}" (at ${x} ${y} 0) ${FX}) (property "Footprint" "${o.fp === undefined ? "FP:X" : o.fp}" (at ${x} ${y} 0) ${FX}) ${o.props || ""} (instances (project "demo" (path "${o.path || "/" + U_ROOT}" (reference "${ref}") (unit ${o.unit || 1})))))`;
const wire = (a, b, id) => `(wire (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id || nid("w")}"))`;
const bus = (a, b, id) => `(bus (pts (xy ${a[0]} ${a[1]}) (xy ${b[0]} ${b[1]})) (stroke (width 0) (type default)) (uuid "${id || nid("b")}"))`;
const junction = (p, id) => `(junction (at ${p[0]} ${p[1]}) (diameter 0) (color 0 0 0 0) (uuid "${id || nid("j")}"))`;
const label = (t, p, id, extra) => `(label "${t}" (at ${p[0]} ${p[1]} 0) ${FX} (uuid "${id || nid("l")}")${extra || ""})`;
const glabel = (t, p, id, shape) => `(global_label "${t}" (shape ${shape || "input"}) (at ${p[0]} ${p[1]} 0) ${FX} (uuid "${id || nid("g")}"))`;
const hlabel = (t, p, id, shape) => `(hierarchical_label "${t}" (shape ${shape || "input"}) (at ${p[0]} ${p[1]} 0) ${FX} (uuid "${id || nid("h")}"))`;
const noconnect = (p, id) => `(no_connect (at ${p[0]} ${p[1]}) (uuid "${id || nid("nc")}"))`;
const busEntry = (p, size, id) => `(bus_entry (at ${p[0]} ${p[1]}) (size ${size[0]} ${size[1]}) (stroke (width 0) (type default)) (uuid "${id || nid("be")}"))`;
const sheetSym = (name, file, x, y, pins, id) => `(sheet (at ${x} ${y}) (size 20 20) (stroke (width 0) (type solid)) (fill (color 0 0 0 0)) (uuid "${id}") (property "Sheetname" "${name}" (at ${x} ${y} 0) ${FX}) (property "Sheetfile" "${file}" (at ${x} ${y} 0) ${FX}) ${pins.map((p) => `(pin "${p.name}" ${p.shape || "input"} (at ${p.at[0]} ${p.at[1]} 0) ${FX} (uuid "${p.id || nid("sp")}"))`).join(" ")} (instances (project "demo" (path "/${U_ROOT}" (page "${id.slice(0, 1)}")))))`;
const schText = (body, uuid) => `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${uuid || U_ROOT}") (paper "A4") ${LIB} ${body} (sheet_instances (path "/" (page "1"))))`;
const parse = (body, uuid) => K.parseDoc(schText(body, uuid), "kicad_sch");
const helpers = { symbolPins: sch._.symbolPins, isPower: (d, it) => sch._.isPowerSymbol(d, String((K.kid(it.node, "lib_id") || [])[1])) };
/** the sheet position of each pin of a symbol placed at (x, y), by number (the first of a repeated number) */
function pinsOf(lib, x, y) {
  const d = parse(symbol(lib, "P?", x, y, { id: "probe" })), o = {}, all = [];
  for (const p of helpers.symbolPins(d, d.items.get("probe"))) { if (!(p.number in o)) o[p.number] = [p.x, p.y]; all.push([p.x, p.y]); }
  o.all = all; return o;
}
function netlist(body, subs, opts) {
  const files = { "demo.kicad_sch": { doc: parse(body), uuid: U_ROOT, file: "demo.kicad_sch" } };
  for (const [f, b] of Object.entries(subs || {})) files[f] = { doc: parse(b, "22222222-2222-2222-2222-" + f.padStart(12, "0").slice(0, 12)), uuid: "22222222", file: f };
  const nl = N.buildNetlist(files["demo.kicad_sch"], (f) => files[f] || null, helpers, "demo", opts);
  nl.files = files; return nl;
}
/** "R1.1" -> the net name of that pad */
const netOf = (nl, refPin) => { const [ref, pin] = refPin.split("."); const c = nl.components.find((x) => x.ref === ref); const p = c && c.pins.get(pin); return p ? p.net : null; };
/** the net-map entry that holds an item id (and pin) */
const entryOf = (nl, id, pin) => { for (const e of nl.netMap.values()) if (e.members.some((m) => m.id === id && (pin === undefined || m.pin === pin))) return e; return null; };

// ---------------------------------------------------------------- 1: line middles
const r1 = pinsOf("Device:R", 100, 50), r2 = pinsOf("Device:R", 120, 50);
test("1: a wire end on the middle of a wire is not connected without a junction (SCH_LINE::GetConnectionPoints)", () => {
  // horizontal wire R1.1 -> x=140; a vertical wire from R2.1 up to the horizontal wire's middle
  const body = symbol("Device:R", "R1", 100, 50) + symbol("Device:R", "R2", 120, 50) + wire(r1[1], [140, r1[1][1]], "wh") + wire(r2[1], [120, r1[1][1]], "wv")
    + label("A", r1[1]) ;
  // R2.1 is ON the horizontal wire here (same y): move the stub so only its end touches the middle
  const off = symbol("Device:R", "R1", 100, 50) + symbol("Device:R", "R2", 120, 60) + wire(r1[1], [140, r1[1][1]], "wh") + wire([120, 60 - 3.81], [120, r1[1][1]], "wv") + label("A", r1[1]);
  void body;
  let nl = netlist(off);
  assert.strictEqual(netOf(nl, "R1.1"), "/A");
  assert.notStrictEqual(netOf(nl, "R2.1"), "/A", "the T without a junction is open");
  nl = netlist(off + junction([120, r1[1][1]]));
  assert.strictEqual(netOf(nl, "R2.1"), "/A", "the junction joins the wire passing through it");
});
test("1: a pin on the middle of a wire is not connected; a label on the middle is; a junction there connects the pin", () => {
  const body = symbol("Device:R", "R1", 100, 50) + symbol("Device:R", "R2", 120, 50) + wire(r1[1], [140, r1[1][1]], "wh") + label("A", r1[1]);
  let nl = netlist(body);                                   // R2.1 sits on the wire's middle
  assert.strictEqual(netOf(nl, "R1.1"), "/A");
  assert.notStrictEqual(netOf(nl, "R2.1"), "/A");
  nl = netlist(body + junction(r2[1]));
  assert.strictEqual(netOf(nl, "R2.1"), "/A");
  nl = netlist(symbol("Device:R", "R1", 100, 50) + wire(r1[1], [140, r1[1][1]], "wh") + label("MID", [130, r1[1][1]]));
  assert.strictEqual(netOf(nl, "R1.1"), "/MID", "a label on a wire's middle names it");
  nl = netlist(body + noconnect(r2[1], "ncmid"));
  assert.ok(!entryOf(nl, "wh").members.some((m) => m.id === "ncmid"), "a no-connect on a wire's middle is not on its net");
});

// ---------------------------------------------------------------- 2: hidden power pins
const ic = pinsOf("X:IC", 100, 100);
test("2: an invisible power-input pin joins the global net of its name only when nothing is attached to it", () => {
  let nl = netlist(symbol("X:IC", "U1", 100, 100) + symbol("power:+3V3", "#PWR01", 150, 100, { value: "VCC" }) + symbol("Device:R", "R1", 150, 100 + 3.81));
  assert.strictEqual(netOf(nl, "U1.8"), "VCC");
  assert.strictEqual(netOf(nl, "R1.1"), "VCC", "the unwired hidden pin is on the global VCC net");
  // wired to +3V3: the pin is NOT also tied to VCC (KiCad: "user has wired up an invisible pin")
  const p3 = [ic[8][0], ic[8][1] - 5];
  nl = netlist(symbol("X:IC", "U1", 100, 100) + wire(ic[8], p3) + symbol("power:+3V3", "#PWR02", p3[0], p3[1]) + symbol("power:+3V3", "#PWR01", 150, 100, { value: "VCC" }) + symbol("Device:R", "R1", 150, 100 + 3.81));
  assert.strictEqual(netOf(nl, "U1.8"), "+3V3");
  assert.strictEqual(netOf(nl, "R1.1"), "VCC", "+3V3 and VCC stay apart");
});

// ---------------------------------------------------------------- 3: jumpers
test("3: jumper pin groups and 'duplicate pin numbers are jumpers' connect the pins (updateSymbolConnectivity)", () => {
  const jg = pinsOf("X:JG", 100, 100);
  let nl = netlist(symbol("X:JG", "JP1", 100, 100) + label("IN", jg[1]));
  assert.strictEqual(netOf(nl, "JP1.1"), "/IN"); assert.strictEqual(netOf(nl, "JP1.3"), "/IN", "1 and 3 are one jumper group");
  assert.notStrictEqual(netOf(nl, "JP1.2"), "/IN");
  const js = pinsOf("X:JS", 100, 100);
  nl = netlist(symbol("X:JS", "JP2", 100, 100) + label("S", js[2]));
  assert.strictEqual(netOf(nl, "JP2.A1"), "/S", "a group member names one contact of a stacked pin");
  const du = pinsOf("X:DUP", 100, 100);
  nl = netlist(symbol("X:DUP", "SW1", 100, 100) + label("K", du.all[0]) + symbol("Device:R", "R1", du.all[1][0], du.all[1][1] + 3.81));
  assert.strictEqual(netOf(nl, "R1.1"), "/K", "the two pins numbered 1 are linked");
  nl = netlist(symbol("X:NOJ", "SW1", 100, 100) + label("K", du.all[0]) + symbol("Device:R", "R1", du.all[1][0], du.all[1][1] + 3.81));
  assert.notStrictEqual(netOf(nl, "R1.1"), "/K", "without the flag they are not");
});

// ---------------------------------------------------------------- 4: weak name conflicts
test("4: a weakly driven net whose name another net has is renamed _1 (processSubGraphs create_new_name)", () => {
  // sheet pin X on an unlabeled wire (the child has no hierarchical label X) next to a local label X
  const body = sheetSym("sub", "sub.kicad_sch", 20, 20, [{ name: "X", at: [40, 30], id: "spx" }], "3heet") + wire([40, 30], [60, 30], "wsp") + symbol("Device:R", "R1", 60, 30 + 3.81)
    + symbol("Device:R", "R2", 100, 50) + label("X", r1[1]);
  const nl = netlist(body, { "sub.kicad_sch": symbol("Device:R", "R9", 100, 50, { path: `/${U_ROOT}/3heet` }) });
  assert.strictEqual(netOf(nl, "R2.1"), "/X", "the label keeps the name");
  assert.strictEqual(netOf(nl, "R1.1"), "/X_1", "the sheet pin's net is renamed");
  assert.ok(nl.netMap.has("/X_1") && nl.netMap.has("/X"));
  assert.ok(!nl.netMap.get("/X").members.some((m) => m.id === "wsp"));
});
test("4: of two weak nets with one name the first (sheet path, driver) takes _1 and the last keeps the name", () => {
  // two symbols with the same reference: their unnamed nets get the same Net-(…) name
  const a = pinsOf("Device:R", 100, 50), b = pinsOf("Device:R", 140, 50);
  const body = symbol("Device:R", "R1", 100, 50, { id: "aaa" }) + symbol("Device:R", "R1", 140, 50, { id: "bbb" })
    + symbol("Device:R", "R2", a[1][0], a[1][1] - 3.81) + symbol("Device:R", "R3", b[1][0], b[1][1] - 3.81);
  const nl = netlist(body);
  const na = entryOf(nl, "aaa", "1").name, nb = entryOf(nl, "bbb", "1").name;
  assert.notStrictEqual(na, nb, "two nets, not one");
  assert.strictEqual(na, "Net-(R1-Pad1)_1"); assert.strictEqual(nb, "Net-(R1-Pad1)");
});

// ---------------------------------------------------------------- 5 / 6: buses
test("5: a reversed bus vector counts up from the lower number (ParseBusVector swaps begin and end)", () => {
  assert.deepStrictEqual(N.busVector("D[3..0]"), ["D0", "D1", "D2", "D3"]);
  assert.strictEqual(N.busVector("D[2..2]"), null, "a range of one is no bus");
  assert.deepStrictEqual(K.busConnection("A[08..10]").members.map((m) => m.full), ["A08", "A09", "A10"], "zero padding is kept");
  // one bus carrying the labels D[3..0] and Q[0..3]: members pair by index from the lowest number, so D3 is Q3
  const nl = netlist(bus([40, 30], [80, 30]) + label("D[3..0]", [40, 30]) + label("Q[0..3]", [80, 30]) + symbol("Device:R", "R1", 100, 50) + label("D3", r1[1]) + symbol("Device:R", "R2", 120, 50) + label("Q3", r2[1]));
  assert.strictEqual(netOf(nl, "R1.1"), "/D3"); assert.strictEqual(netOf(nl, "R2.1"), "/D3", "D3 is Q3, not Q0");
});
test("6: a bus group names its members with the group prefix and joins them; an alias gives its members", () => {
  const c = K.busConnection("MEM{A B[0..1] ~{CS}}");
  assert.deepStrictEqual(c.members.map((m) => m.full), ["MEM.A", "MEM.B0", "MEM.B1", "MEM.~{CS}"]);
  assert.deepStrictEqual(K.busConnection("{A B}").members.map((m) => m.full), ["A", "B"], "an unnamed group gives no prefix");
  const al = K.busConnection("USB{DATA PWR}", { DATA: ["DP", "DM"] });
  assert.deepStrictEqual(al.members.map((m) => m.full), ["USB.DP", "USB.DM", "USB.PWR"]);
  assert.deepStrictEqual(al.aliases, [{ name: "DATA", members: ["DP", "DM"] }]);
  // a group bus through a sheet pin: MEM.A in the parent is MEM.A in the child
  const body = sheetSym("sub", "sub.kicad_sch", 20, 20, [{ name: "MEM{A B}", at: [40, 30] }], "3heet") + bus([40, 30], [80, 30], "busroot") + symbol("Device:R", "R1", 100, 50) + label("MEM.A", r1[1]);
  const sub = hlabel("MEM{A B}", [50, 50]) + bus([50, 50], [80, 50]) + symbol("Device:R", "R2", 100, 50, { path: `/${U_ROOT}/3heet` }) + label("MEM.A", r1[1]);
  let nl = netlist(body, { "sub.kicad_sch": sub });
  assert.strictEqual(netOf(nl, "R1.1"), netOf(nl, "R2.1"));
  assert.ok(netOf(nl, "R1.1").endsWith("MEM.A"), netOf(nl, "R1.1"));
  const e = entryOf(nl, "busroot"); assert.ok(e.bus && e.busMembers.length === 2, JSON.stringify(e.busMembers));
  // aliases from the project file
  nl = netlist(bus([40, 30], [80, 30], "b1") + label("{DATA}", [40, 30]) + symbol("Device:R", "R1", 100, 50) + label("DP", r1[1]), null, N.netlistOptions({ schematic: { bus_aliases: { DATA: ["DP", "DM"] } } }));
  const be = entryOf(nl, "b1");
  assert.deepStrictEqual(be.busMembers, ["/DP", "/DM"]); assert.deepStrictEqual(be.aliases, [{ name: "DATA", members: ["DP", "DM"] }]);
});

// ---------------------------------------------------------------- 7: text variables in net names
test("7: text variables in label text and power values are resolved for the net name (GetShownText FOR_NETNAME)", () => {
  const body = sheetSym("chA", "sub.kicad_sch", 20, 20, [], "3heet") + sheetSym("chB", "sub.kicad_sch", 20, 60, [], "4heet")
    + symbol("Device:R", "R1", 100, 50) + label("${PRJ}_CLK", r1[1]) + symbol("power:GND", "#PWR01", r1[2][0], r1[2][1], { value: "${RAIL}" });
  const sub = symbol("Device:R", "R2", 100, 50, { path: `/${U_ROOT}/3heet` }) + label("${SHEETNAME}_CLK", r1[1]) + label("X${NET_NAME}", r1[2]);
  const nl = netlist(body, { "sub.kicad_sch": sub }, { textVars: { PRJ: "P1", RAIL: "VSS" } });
  assert.strictEqual(netOf(nl, "R1.1"), "/P1_CLK"); assert.strictEqual(netOf(nl, "R1.2"), "VSS");
  assert.ok(nl.netMap.has("/chA/chA_CLK") && nl.netMap.has("/chB/chB_CLK"), Array.from(nl.netMap.keys()).join(", "));
  assert.ok(nl.netMap.has("/chA/X"), "${NET_NAME} is empty while the net is being named");
});

// ---------------------------------------------------------------- 15: pin driver priority
test("15: a pin next to a PWR_FLAG is Net-(…), not unconnected-; on-board pins name the net before excluded ones", () => {
  let nl = netlist(symbol("X:IC", "U1", 100, 100) + symbol("power:PWR_FLAG", "#FLG01", ic[1][0], ic[1][1]));
  assert.strictEqual(netOf(nl, "U1.1"), "Net-(U1-A)");
  nl = netlist(symbol("X:IC", "U1", 100, 100));
  assert.strictEqual(netOf(nl, "U1.1"), "unconnected-(U1-A-Pad1)", "one pin alone");
  // R5 (on board) and A1 (excluded from board) on one net: R5 names it although "A1" sorts first
  nl = netlist(symbol("Device:R", "R5", 100, 50) + symbol("Device:R", "A1", 100, 50 - 7.62, { onBoard: false, id: "a1" }));
  assert.strictEqual(netOf(nl, "R5.1"), "Net-(R5-Pad1)");
  // only excluded pins: they still name the net
  nl = netlist(symbol("Device:R", "A1", 100, 50, { onBoard: false, id: "a1" }) + symbol("Device:R", "A2", 100, 50 - 7.62, { onBoard: false, id: "a2" }));
  assert.strictEqual(entryOf(nl, "a1", "1").name, "Net-(A1-Pad1)");
});

// ---------------------------------------------------------------- 16: sheet names with a slash
test("16: a sheet name with '/' is escaped in the net prefix (PathHumanReadable aEscapeSheetNames)", () => {
  const body = sheetSym("A/B", "sub.kicad_sch", 20, 20, [], "3heet");
  const nl = netlist(body, { "sub.kicad_sch": symbol("Device:R", "R2", 100, 50, { path: `/${U_ROOT}/3heet` }) + label("NET", r1[1]) });
  assert.strictEqual(netOf(nl, "R2.1"), "/A{slash}B/NET");
  assert.strictEqual(nl.instances[1].human, "/A/B/", "the path shown to people is not escaped");
});

// ---------------------------------------------------------------- 17: driver tie-breaks
test("17: of two sheet pins the output-shaped one names the net; of two bus labels the superset", () => {
  const body = sheetSym("a", "sub.kicad_sch", 20, 20, [{ name: "AAA", at: [40, 30], shape: "input" }], "3heet") + sheetSym("b", "sub.kicad_sch", 60, 20, [{ name: "ZZZ", at: [60, 30], shape: "output" }], "4heet")
    + wire([40, 30], [60, 30], "wpp");
  const nl = netlist(body, { "sub.kicad_sch": symbol("Device:R", "R9", 100, 50, { path: `/${U_ROOT}/3heet` }) });
  assert.strictEqual(entryOf(nl, "wpp").name, "/ZZZ");
  const b = netlist(bus([40, 30], [80, 30], "bb") + label("A[0..3]", [40, 30]) + label("A[0..7]", [80, 30]));
  assert.strictEqual(entryOf(b, "bb").name, "/A[0..7]", "the wider bus wins although A[0..3] sorts first");
});

// ---------------------------------------------------------------- 18: bus entries
test("18: a bus entry between two wires joins them; the end on a bus joins only the bus", () => {
  let nl = netlist(symbol("Device:R", "R1", 100, 50) + symbol("Device:R", "R2", 120, 60) + wire(r1[1], [110, r1[1][1]], "wa") + busEntry([110, r1[1][1]], [2.54, 2.54], "be")
    + wire([112.54, r1[1][1] + 2.54], [120, r1[1][1] + 2.54], "wb") + wire([120, r1[1][1] + 2.54], [120, 60 - 3.81], "wc") + label("E", r1[1]));
  assert.strictEqual(netOf(nl, "R2.1"), "/E", "wire - entry - wire is one net");
  // one end on a bus: the wire at that end is not shorted to the entry's wire
  nl = netlist(bus([110, 20], [110, 80], "bus1") + label("D[0..3]", [110, 20]) + busEntry([110, 40], [2.54, 2.54], "be2") + wire([112.54, 42.54], [130, 42.54], "wd") + label("D1", [130, 42.54])
    + wire([100, 40], [110, 40], "wstray") + label("STRAY", [100, 40]));
  assert.strictEqual(entryOf(nl, "be2").name, "/D1");
  assert.strictEqual(entryOf(nl, "wstray").name, "/STRAY");
});

// ---------------------------------------------------------------- 30 / 31
test("30: of two units sharing a pad number the pin on a named net is kept (eraseDuplicatePins)", () => {
  // two symbols of one reference (units of one part) both carrying pad 1: the first is unnamed, the second labelled
  const a = pinsOf("Device:R", 100, 50), b = pinsOf("Device:R", 140, 50);
  const nl = netlist(symbol("Device:R", "R1", 100, 50, { id: "u1" }) + symbol("Device:R", "R7", a[1][0], a[1][1] - 3.81) + symbol("Device:R", "R1", 140, 50, { id: "u2" }) + label("NAMED", b[1]));
  assert.strictEqual(netOf(nl, "R1.1"), "/NAMED");
});
test("31: '+no_connect' only for a real no-connect marker, not for a pin of electrical type no_connect", () => {
  const p = pinsOf("X:NCP", 100, 100);
  let nl = netlist(symbol("X:NCP", "U1", 100, 100));
  const c = nl.components.find((x) => x.ref === "U1");
  assert.strictEqual(c.pins.get("1").type, "no_connect"); assert.ok(c.pins.get("1").net.startsWith("unconnected-("));
  nl = netlist(symbol("X:NCP", "U1", 100, 100) + noconnect(p[2]));
  assert.strictEqual(nl.components.find((x) => x.ref === "U1").pins.get("2").type, "passive+no_connect");
});

test("6: a (bus_alias …) of the sheet is read; Unfold from Bus lists an alias's members, not the alias", () => {
  const body = `(bus_alias "CTRL" (members "RD" "WR"))` + bus([40, 30], [80, 30], "b1") + label("{CTRL A[0..1]}", [40, 30]);
  const nl = netlist(body + symbol("Device:R", "R1", 100, 50) + label("WR", r1[1]));
  assert.deepStrictEqual(entryOf(nl, "b1").busMembers, ["/RD", "/WR", "/A0", "/A1"]);
  assert.strictEqual(netOf(nl, "R1.1"), "/WR");
  const d = parse(body);
  assert.deepStrictEqual(sch._.unfoldMembers(d, d.items.get("b1")), ["RD", "WR", "A0", "A1"]);
  assert.deepStrictEqual(sch._.unfoldEntries(d, d.items.get("b1")).map((e) => e.name), ["RD", "WR", "A[0..1]"]);
});

// ---------------------------------------------------------------- 20-26: the Net Navigator's model
const fmtMm = (v) => String(+v.toFixed(2));
test("21/22: the Nets list holds the buses; a net's node lists the items of the buses that carry it", () => {
  const nl = netlist(bus([40, 30], [80, 30], "b1") + label("D[0..3]", [40, 30], "busl") + symbol("Device:R", "R1", 100, 50) + label("D1", r1[1], "netl"));
  const names = SN.netNames(nl.netMap);
  assert.ok(names.includes("/D[0..3]") && names.includes("/D1"), names.join(", "));
  assert.ok(!SN.netNames(nl.netMap, false).includes("/D[0..3]"), "the netclass candidates stay nets only");
  const sheets = SN.navSheets(nl.netMap, "/D1", nl.instances, "demo", () => nl.files["demo.kicad_sch"].doc, fmtMm);
  const labels = sheets[0].items.map((i) => i.label);
  assert.ok(labels.some((l) => l.startsWith("Label 'D[0..3]'")), labels.join(" | "));
  assert.ok(labels.some((l) => l.startsWith("Label 'D1'")) && labels.some((l) => l.startsWith("Symbol 'R1' pin '1'")));
});
test("23: the regex filter ignores case (std::regex icase)", () => {
  assert.ok(SN.netFilter("^vcc$", false)("VCC")); assert.ok(!SN.netFilter("^vcc$", false)("VCC1"));
});
test("24: a navigator item focuses on the pin / sheet pin itself, not on its symbol's or sheet's origin", () => {
  const body = symbol("X:IC", "U1", 100, 100) + label("A", ic[1]) + sheetSym("sub", "sub.kicad_sch", 20, 20, [{ name: "P", at: [40, 30] }], "3heet") + wire([40, 30], [50, 30]) + label("Q", [50, 30]);
  const nl = netlist(body, { "sub.kicad_sch": hlabel("P", [50, 50]) });
  const doc = nl.files["demo.kicad_sch"].doc;
  const pin = nl.netMap.get("/A").members.find((m) => m.kind === "pin");
  const d = SN.describeMember(pin, doc, fmtMm);
  assert.ok(Math.hypot(d.at[0] - 100, d.at[1] - 100) > 2, "not the symbol origin: " + d.at);
  assert.ok(Math.abs(d.at[1] - ic[1][1]) < 1.5 && d.at[0] < 100, "on the pin: " + d.at + " pin at " + ic[1]);
  const sp = entryOf(nl, "3heet", "P").members.find((m) => m.kind === "sheet_pin");
  const ds = SN.describeMember(sp, doc, fmtMm);
  assert.ok(Math.abs(ds.at[1] - 30) < 1.5 && Math.abs(ds.at[0] - 40) < 6, "on the sheet pin: " + ds.at);
});
test("25: with several top-level sheets the sheet node starts at the top-level sheet's name, not the root file", () => {
  const multi = [{ index: 0, human: "/Top1/", file: "a.kicad_sch", uuidPath: ["u1"], sheetName: "Top1" }, { index: 1, human: "/Top2/", file: "b.kicad_sch", uuidPath: ["u2"], sheetName: "Top2" },
    { index: 2, human: "/Top1/Sub/", file: "s.kicad_sch", uuidPath: ["u1", "s1"], sheetName: "Sub" }];
  assert.strictEqual(SN.sheetNodeText(multi[2], "rootfile", multi), "Top1/Sub");
  assert.strictEqual(SN.sheetNodeText(multi[1], "rootfile", multi), "Top2");
  const single = [{ index: 0, human: "/", file: "demo.kicad_sch", uuidPath: ["u1"], sheetName: "" }, { index: 1, human: "/Sub/", file: "s.kicad_sch", uuidPath: ["u1", "s1"], sheetName: "Sub" }];
  assert.strictEqual(SN.sheetNodeText(single[1], "demo", single), "demo/Sub"); assert.strictEqual(SN.sheetNodeText(single[0], "demo", single), "demo");
});
test("26: Next / Previous Net Item steps through the Net Navigator when the editor provides it, only from a highlighted item", () => {
  const d = parse(wire([10, 10], [20, 10], "w1") + wire([20, 10], [30, 10], "w2") + label("N", [10, 10], "l1"));
  const calls = [];
  const ctx = { K, doc: d, IU: 10000, isSch: true, selection: new Set(["l1"]), viewOnly: false, requestRender() {}, setSelection(ids) { this.selection = new Set(ids); } };
  sch.setNetHighlighter({ highlightPick() {}, clear() {}, active: () => true, docChanged() {}, stepNetItem: (c, dir) => { calls.push(dir); return true; } });
  try {
    sch.state.highlight = null;
    assert.strictEqual(sch._.stepNetItem(ctx, 1), false, "the selected item is not net-highlighted: nothing happens");
    sch.state.highlight = new Set(["l1", "w1", "w2"]);
    assert.strictEqual(sch._.stepNetItem(ctx, 1), true); assert.strictEqual(sch._.stepNetItem(ctx, -1), true);
    assert.deepStrictEqual(calls, [1, -1]);
  } finally { sch.setNetHighlighter(null); sch.state.highlight = null; }
});

// ---------------------------------------------------------------- 8 / 9: label text variables, global label field offset
const textsOf = (it) => it.geom.filter((g) => g.t === "text");
const prop = (name, value, at, extra) => ` (property "${name}" "${value}" (at ${at[0]} ${at[1]} ${at[2] || 0}) (effects (font (size 1.27 1.27))${extra || ""}))`;
test("8: labels and their fields show resolved text variables; an unknown one is shown as written", () => {
  K.setLabelTextVar(null);
  const d = parse(`(hierarchical_label "H_\${CONNECTION_TYPE}" (shape output) (at 100 100 0) ${FX} (uuid "h1")${prop("T", "\${CONNECTION_TYPE}", [110, 100])}${prop("C", "\${NET_CLASS}", [110, 104])}${prop("F", "\${T}!", [110, 108])})`
    + `(netclass_flag "" (length 2.54) (shape round) (at 50 50 0) ${FX} (uuid "d1")${prop("Netclass", "\${DNP}", [52, 48])}${prop("B", "\${EXCLUDE_FROM_BOM}", [52, 46])})`
    + `(rule_area (dnp yes) (polyline (pts (xy 40 50) (xy 60 50) (xy 60 70) (xy 40 70)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra1")))`);
  const h = textsOf(d.items.get("h1"));
  assert.strictEqual(h[0].text, "H_Output", "the label's own text");
  assert.strictEqual(h.find((g) => g.field === "T").text, "Output");
  assert.strictEqual(h.find((g) => g.field === "F").text, "Output!", "a field through another field");
  assert.strictEqual(h.find((g) => g.field === "C").text, "${NET_CLASS}", "a field that is only a variable is drawn (as written while nothing resolves it)");
  // the host (the editor's net map) answers the connection tokens
  K.setLabelTextVar((item, token) => (token === "NET_CLASS" ? "HV" : null));
  try { assert.strictEqual(K.refreshLabelTextVars(d), true); assert.strictEqual(textsOf(d.items.get("h1")).find((g) => g.field === "C").text, "HV"); } finally { K.setLabelTextVar(null); }
  K.buildGeom(d, d.items.get("d1"));   // the rule area is in the document now
  const dl = textsOf(d.items.get("d1"));
  assert.strictEqual(dl.find((g) => g.field === "Netclass").text, "DNP", "a directive label on a rule area that is DNP");
  assert.ok(!dl.some((g) => g.field === "B"), "EXCLUDE_FROM_BOM is empty there: nothing drawn");
});
test("9: the fields of a global label are drawn moved by the label's text offset (GetSchematicTextOffset)", () => {
  const d = parse(`(global_label "G" (shape input) (at 100 100 0) ${FX} (uuid "g1")${prop("F", "x", [110, 100])})` + `(global_label "G" (shape output) (at 100 120 90) ${FX} (uuid "g2")${prop("F", "x", [110, 120])})`
    + `(hierarchical_label "H" (shape input) (at 100 140 0) ${FX} (uuid "h1")${prop("F", "x", [110, 140])})`);
  const f = (id) => textsOf(d.items.get(id)).find((g) => g.field === "F");
  const horizIn = 0.375 * 1.27 + 0.75 * 1.27, vert = 1.27 * 0.0715;
  assert.ok(Math.abs(f("g1").x - (110 + horizIn)) < 1e-6 && Math.abs(f("g1").y - (100 + vert)) < 1e-6, [f("g1").x, f("g1").y].join());
  assert.ok(Math.abs(f("g2").x - (110 + vert)) < 1e-6 && Math.abs(f("g2").y - (120 - 0.375 * 1.27)) < 1e-6, "spin up, output shape: (vert, -horiz)");
  assert.deepStrictEqual([f("h1").x, f("h1").y], [110, 140], "other labels' fields stay where they are stored");
});

// ---------------------------------------------------------------- 10-13: labels turning and mirroring with their fields
const _ = sch._, kid = K.kid, kids = K.kids, atOf = K.atOf;
const nodeOf = (text) => K.parse(text);
const just = (p) => { const j = kid(kid(p, "effects"), "justify"); return j ? j.slice(1) : []; };
test("10: rotating a label turns its fields about it; autoplaced fields are placed again (SCH_LABEL_BASE::Rotate90)", () => {
  // not autoplaced: SCH_FIELD::Rotate( label position, ccw )
  const n = nodeOf(`(label "L" (at 100 100 0) ${FX} (uuid "l1")${prop("F", "v", [105, 102], ' (justify left)')})`);
  assert.ok(_.rotateNode("label", n, false));                       // counter-clockwise
  assert.deepStrictEqual(atOf(n), [100, 100, 90]);
  const f = kids(n, "property")[0];
  assert.deepStrictEqual(atOf(f), [102, 95, 90], "(5, 2) turned a quarter counter-clockwise on screen is (2, -5); the field is now vertical");
  assert.deepStrictEqual(just(f), ["left"], "a horizontal field keeps its side when turning counter-clockwise");
  _.rotateNode("label", n, true);
  assert.deepStrictEqual(atOf(f), [105, 102, 0]); assert.deepStrictEqual(just(f), ["left"]);
  _.rotateNode("label", n, true);                                   // clockwise from horizontal: left becomes right
  assert.deepStrictEqual(atOf(f), [98, 105, 90]); assert.deepStrictEqual(just(f), ["right"]);
  // autoplaced: SCH_LABEL_BASE::AutoplaceFields for the new spin
  const a = nodeOf(`(hierarchical_label "H" (shape input) (at 100 100 0) (fields_autoplaced yes) ${FX} (uuid "h1")${prop("F", "v", [100, 101.905])})`);
  _.rotateNode("hierarchical_label", a, false);
  const af = kids(a, "property")[0];
  assert.deepStrictEqual(atOf(af), [101.27, 100, 90], "spin up: across the label at half a text height plus half the field's");
  assert.deepStrictEqual(just(af), ["left"]);
});
test("10: mirroring a label mirrors its fields about it (MirrorSpinStyle alone, MirrorHorizontally in a group)", () => {
  const n = nodeOf(`(label "L" (at 100 100 0) ${FX} (uuid "l1")${prop("F", "v", [105, 102], ' (justify left)')}${prop("V", "v", [103, 98, 90], ' (justify left)')})`);
  assert.ok(_.mirrorNode("label", n, "y"));                          // Mirror Horizontally
  assert.strictEqual(atOf(n)[2], 180);
  const [f, v] = kids(n, "property");
  assert.deepStrictEqual(atOf(f).slice(0, 2), [95, 102]); assert.deepStrictEqual(just(f), ["right"], "a horizontal field flips its side");
  assert.deepStrictEqual(atOf(v).slice(0, 2), [97, 98]); assert.deepStrictEqual(just(v), ["left"], "a vertical one does not");
  assert.ok(_.mirrorNode("label", n, "x"), "Mirror Vertically moves the fields although the label's own direction stays");
  assert.strictEqual(atOf(n)[2], 180); assert.deepStrictEqual(atOf(f).slice(0, 2), [95, 98]); assert.deepStrictEqual(just(v), ["right"]);
});
test("11: Mirror Horizontally swaps a directive label's 90 / 270, Mirror Vertically its 0 / 180", () => {
  const mk = (rot) => _.classLabelNode("Power", [150, 150], rot);
  const after = (rot, op) => { const n = mk(rot); _.transformNode("netclass_flag", n, op, [150, 150], true); return atOf(n)[2]; };
  assert.deepStrictEqual([after(90, "y"), after(270, "y"), after(0, "y"), after(180, "y")], [270, 90, 0, 180]);
  assert.deepStrictEqual([after(0, "x"), after(180, "x"), after(90, "x"), after(270, "x")], [180, 0, 90, 270]);
});
test("12: a directive label's fields are placed from its pin length, shape, italic and one below the other", () => {
  const n = nodeOf(`(netclass_flag "" (length 5.08) (shape diamond) (at 100 100 0) (fields_autoplaced yes) ${FX} (uuid "d1")${prop("Netclass", "A", [0, 0])}${prop("Empty", "", [7, 7])}${prop("Component Class", "B", [0, 0])})`);
  _.placeFlagFields(n);
  const [f1, e, f2] = kids(n, "property"), margin = 0.15 * 1.27, w = 2 * 0.508;
  const near = (a, b) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-3);
  assert.ok(near(atOf(f1), [100 + w + margin, 100 - 5.08, 0]), atOf(f1).join());
  assert.ok(near(atOf(f2), [100 + w + margin, 100 - (5.08 - (1.27 + margin)), 0]), "the second field one text height + margin nearer: " + atOf(f2).join());
  assert.deepStrictEqual(atOf(e).slice(0, 2), [7, 7], "an empty field is skipped");
  // rotating an autoplaced flag places them again for the new spin
  _.transformNode("netclass_flag", n, "ccw", [100, 100], true);
  assert.ok(near(atOf(f1), [100 - 5.08, 100 - (w + margin), 90]), atOf(f1).join());
  assert.ok(near(atOf(f2), [100 - (5.08 - (1.27 + margin)), 100 - (w + margin), 90]), atOf(f2).join());
});
test("13: a directive label on the border of a rule area is not dangling", () => {
  const flag = (id, x, y) => `(netclass_flag "" (length 2.54) (shape round) (at ${x} ${y} 0) ${FX} (uuid "${id}")${prop("Netclass", "A", [x + 1, y - 2])})`;
  const d = parse(flag("on", 50, 50) + flag("off", 80, 20) + `(rule_area (polyline (pts (xy 40 50) (xy 60 50) (xy 60 70) (xy 40 70)) (stroke (width 0) (type dash)) (fill (type none)) (uuid "ra1")))`);
  const dang = _.danglingEnds(d).filter((x) => x.what === "label").map((x) => x.item.id);
  assert.deepStrictEqual(dang, ["off"]);
});

// ---------------------------------------------------------------- 29: CadStar / PADS net sections
const esbuild = require("esbuild"), { webPath } = require("./web-path");
function load(rel) {
  const out = esbuild.buildSync({ entryPoints: [webPath(...rel.split("/"))], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const mod = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}
test("29: CadStar and PADS nets list board-excluded symbols and keep a stacked pin as written; the jumpered pin 2 is on the net too", () => {
  const NF = load("sim/netlist-formats.ts");
  const r1 = pinsOf("Device:R", 50, 50), r2 = pinsOf("Device:R", 70, 50), j = pinsOf("X:JS", 90, 46.19);
  const nl = netlist(symbol("Device:R", "R1", 50, 50) + symbol("Device:R", "R2", 70, 50, { onBoard: false }) + symbol("X:JS", "JP1", 90, 46.19)
    + wire(r1["1"], r2["1"]) + wire(r2["1"], j["[A1,A12]"]) + label("SIG", r1["1"]));
  const pads = NF.pads(nl), cad = NF.cadstar(nl, new Date(0), "x");
  assert.ok(pads.includes("*SIGNAL* /SIG\nJP1.2 JP1.[A1,A12] R1.1 R2.1 \n"), pads);
  assert.ok(!/^R2 /m.test(pads.split("*NET*")[0]), "an excluded symbol is not a part");
  assert.ok(cad.includes('\n.ADD_TER   JP1   2     "/SIG"\n.TER       JP1   [A1,A12]\n            R1   1\n            R2   1\n'), cad);
});

// ---------------------------------------------------------------- 32: ReadyToNetlist
test("32: the annotation check and the duplicate sheet name check of ReadyToNetlist (CheckAnnotation, TestDuplicateSheetNames)", () => {
  const NK = load("sim/netlist-kicad.ts");
  const sheetsOf = (body, subs) => { const nl = netlist(body, subs); return NK.nlSheets(nl.instances, (f) => (nl.files[f] ? nl.files[f].doc : null)); };
  // ReadyToNetlist's CheckAnnotate is the schematic module's (sch.checkAnnotate over the sheet instances)
  const count = (body, subs) => sch.checkAnnotate(sheetsOf(body, subs).map((sh, i) => ({ doc: sh.doc, path: "/" + sh.uuidPath.join("/"), page: i + 1 })));
  assert.strictEqual(count(symbol("Device:R", "R1", 50, 50) + symbol("Device:R", "R2", 70, 50) + symbol("power:GND", "#PWR?", 90, 50)), 0, "annotated; power symbols are not checked");
  assert.strictEqual(count(symbol("Device:R", "R?", 50, 50) + symbol("Device:R", "R2", 70, 50)), 1, "R? is not annotated");
  assert.strictEqual(count(symbol("Device:R", "R", 50, 50)), 1, "a reference without a number is not annotated");
  assert.strictEqual(count(symbol("Device:R", "R1", 50, 50, { id: "a" }) + symbol("Device:R", "R1", 70, 50, { id: "b" })), 1, "duplicate R1");
  assert.strictEqual(count(symbol("Device:R", "R1", 50, 50, { unit: 2 })), 1, "unit 2 of a one-unit symbol");
  assert.strictEqual(NK.duplicateSheetNames(sheetsOf(sheetSym("Amp", "a.kicad_sch", 100, 20, [], "s1") + sheetSym("amp", "b.kicad_sch", 100, 60, [], "s2"), { "a.kicad_sch": "", "b.kicad_sch": "" })), 1);
  assert.strictEqual(NK.duplicateSheetNames(sheetsOf(sheetSym("Amp", "a.kicad_sch", 100, 20, [], "s1") + sheetSym("Out", "b.kicad_sch", 100, 60, [], "s2"), { "a.kicad_sch": "", "b.kicad_sch": "" })), 0);
  const fs = require("fs"), src = fs.readFileSync(webPath("editor", "export-netlist.ts"), "utf8");
  assert.ok(src.includes('"Exporting netlist requires a fully annotated schematic."') && src.includes('"Error: duplicate sheet names. Continue?"'));
});

// ---------------------------------------------------------------- 14: SetLabelShape
test("14: a hierarchical label's new shape goes to its twins and the sheet pins; a sheet pin's to its twins and the labels", () => {
  const shapeOf = (c) => (K.kid(K.parse(c.sexpr), "shape") || [])[1];
  const d = parse(hlabel("DATA", [50, 50], "h1", "input") + hlabel("DATA", [80, 50], "h2", "input") + hlabel("CLK", [50, 70], "h3", "input"));
  const edit = (doc, id, fn) => { const it = doc.items.get(id), n = K.cloneNode(it.node); fn(n); return { id, kind: "MODIFIED", typeName: K.typeNameOf(it), sexpr: K.serializeItem(doc, { kind: it.kind, node: n }) }; };
  const f = sch.labelShapeFollowers(d, [edit(d, "h1", (n) => { K.kid(n, "shape")[1] = "output"; })]);
  assert.deepStrictEqual(f.changes.map((c) => [c.id, shapeOf(c)]), [["h1", "output"], ["h2", "output"]]);
  assert.deepStrictEqual(f.pins, [{ text: "DATA", shape: "output" }]);
  const moved = [edit(d, "h1", (n) => { K.kid(n, "at")[1] = 51; })];
  assert.strictEqual(sch.labelShapeFollowers(d, moved).changes, moved, "an edit that leaves the shape alone takes nothing with it");
  // the parent: two sheet symbols of the file, one of another file
  const pin = (name, y, id) => ({ name, at: [100, y], id, shape: "input" });
  const p = parse(sheetSym("A", "sub.kicad_sch", 100, 20, [pin("DATA", 25, "p1"), pin("DATA", 30, "p2"), pin("CLK", 35, "p3")], "s1") + sheetSym("B", "other.kicad_sch", 100, 60, [pin("DATA", 65, "p4")], "s2"));
  const pc = sch.sheetPinShapeChanges(p, (file) => file === "sub.kicad_sch", "DATA", "output");
  assert.deepStrictEqual(pc.map((c) => c.id), ["s1"]);
  assert.deepStrictEqual(K.kids(K.parse(pc[0].sexpr), "pin").map((x) => x[2]), ["output", "output", "input"]);
  // a sheet pin edited on the parent: its twin on that sheet in the same change, the labels of the file to follow
  const g = sch.labelShapeFollowers(p, [edit(p, "s1", (n) => { K.kids(n, "pin")[0][2] = "bidirectional"; })]);
  assert.deepStrictEqual(K.kids(K.parse(g.changes[0].sexpr), "pin").map((x) => x[2]), ["bidirectional", "bidirectional", "input"]);
  assert.deepStrictEqual(g.labels, [{ file: "sub.kicad_sch", text: "DATA", shape: "bidirectional" }]);
  assert.deepStrictEqual(sch.hierLabelShapeChanges(d, "DATA", "bidirectional").map((c) => [c.id, shapeOf(c)]), [["h1", "bidirectional"], ["h2", "bidirectional"]]);
});

// ---------------------------------------------------------------- 19 (message panel), 27
test("19: a junction's Size is at least 170 % of its netclass's wire width, unless its diameter is 1 IU (getEffectiveShape)", () => {
  const d = parse(`(junction (at 50 50) (diameter 0) (color 0 0 0 0) (uuid "j1")) (junction (at 60 50) (diameter 2) (color 0 0 0 0) (uuid "j2")) (junction (at 70 50) (diameter 0.0001) (color 0 0 0 0) (uuid "j3"))`);
  const size = (id, wireWidth) => sch.msgPanelInfo(d, { id }, { units: "mm", connection: () => ({ name: "/N", bus: false, netclass: "Power", wireWidth }) }).find((r) => r.title === "Size").value;
  const plain = size("j1", 0.1524);
  assert.notStrictEqual(size("j1", 1), plain, "a 1 mm wire widens the default junction");
  assert.strictEqual(size("j1", 1), "1.70 mm");
  assert.strictEqual(size("j2", 1), "2.00 mm", "an own diameter above 170 % stays");
  assert.strictEqual(size("j3", 1), size("j3", 0.1524), "a diameter of 1 IU is left alone");
});
test("27: a bus group's message panel lists each alias with its members (CONNECTION_PRESENTATION)", () => {
  const d = parse(bus([40, 40], [80, 40], "b1"));
  const rows = sch.msgPanelInfo(d, { id: "b1" }, { units: "mm", connection: () => ({ name: "/{USB}", bus: true, netclass: "Default", aliases: [{ name: "USB", members: ["DP", "DM"] }] }) });
  const r = rows.find((x) => /^Bus Alias USB Members$/.test(x.title));
  assert.ok(r && /DP/.test(r.value) && /DM/.test(r.value), JSON.stringify(rows));
});

test("28: the Properties panel has a junction's Color and a directive label's Shape and Pin length (SCH_JUNCTION_DESC, SCH_DIRECTIVE_LABEL_DESC)", () => {
  const src = require("fs").readFileSync(webPath("editor", "panels", "propgrid.ts"), "utf8");
  assert.ok(/FLAG_SHAPES: \[string, string\]\[\] = \[\["dot", "Dot"\], \["round", "Circle"\], \["diamond", "Diamond"\], \["rectangle", "Rectangle"\]\]/.test(src));
  assert.ok(/if \(directive\) out\.push\(\{ group: BASIC, name: "Shape", type: "enum", choices: FLAG_SHAPES/.test(src) && /name: "Pin length", type: "length"/.test(src));
  // the junction's Color is a COLOR4D property built by colorProp (one implementation with the stroke / sheet colours)
  assert.ok(/case "junction"[\s\S]{0,600}colorProp\(BASIC, "Color", \(n\) => h\.kid\(n, "color"\)/.test(src) && /function colorProp\([\s\S]{0,200}type: "color"/.test(src));
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
