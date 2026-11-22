import type { SchCtx, Pt, ErcMarker } from "./types";
import { type SymPin, symbolIsPower, symbolLibId, symbolPins } from "./autoplace";
import { danglingEnds } from "./dangling";
import { ellipsizeMenuText, itemDescription } from "./msgpanel";
import { editable, selectedItems } from "./commands";
import { lineEndsAt, lineMidsAt, pinsAt } from "./connect";
import { LABEL_KINDS, busEntriesAt, isNetLine, labelsAt, noConnectsAt, sheetPinsAt } from "./drag";
import { conducts, joins, terminalsOf } from "./highlight";
import { sheetPinNode } from "./nodes";
import { baseName } from "./sheets";
import { K, S, atOf, kid, kids, num, ptsOf, str } from "./state";
import { deep, modChange, onSegMid, r4, same, segs } from "./util";
import { hierarchyTests, sheetTests } from "./erc-tests";

// ---------------------------------------------------------------- ERC (eeschema/erc/erc.cpp subset)
export const PIN_TYPES = ["input", "output", "bidirectional", "tri_state", "passive", "free", "unspecified", "power_in", "power_out", "open_collector", "open_emitter", "no_connect"];
export const PIN_TYPE_TEXT: Record<string, string> = { input: "Input", output: "Output", bidirectional: "Bidirectional", tri_state: "Tri-state", passive: "Passive", free: "Free", unspecified: "Unspecified", power_in: "Power input", power_out: "Power output", open_collector: "Open collector", open_emitter: "Open emitter", no_connect: "Unconnected" };
// ERC_SETTINGS::m_defaultPinMap: 0 ok, 1 warning, 2 error
export const PIN_MATRIX = [
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 2, 2, 2], [0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 2], [0, 1, 0, 0, 0, 0, 1, 1, 2, 1, 1, 2],
  [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], [1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 2], [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 2],
  [0, 2, 1, 2, 0, 0, 1, 0, 2, 2, 2, 2], [0, 2, 0, 1, 0, 0, 1, 0, 2, 0, 0, 2], [0, 2, 1, 1, 0, 0, 1, 0, 2, 0, 0, 2], [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]];
export const DRIVING = new Set(["output", "power_out", "passive", "tri_state", "bidirectional"]), DRIVEN = new Set(["input", "power_in"]);
export const pinTypeIndex = (t: string) => { const i = PIN_TYPES.indexOf(t); return i < 0 ? 6 : i; };
/** ERC_SETTINGS m_PinTypeWeights (SM_HEURISTICS, the default sorting metric of pin conflicts). */
export const PIN_TYPE_WEIGHT: Record<string, number> = { free: 11, unspecified: 10, passive: 9, open_collector: 8, open_emitter: 7, input: 6, tri_state: 5, bidirectional: 4, output: 3, power_in: 2, power_out: 1, no_connect: 0 };
/** PIN_ERROR of a pin map entry (OK 0, WARNING 1, PP_ERROR 2, UNCONNECTED 3); anything else reads as OK, as ERC_SETTINGS' loader skips it. */
export function pinErrorAt(map: number[][], a: string, b: string): number {
  const row = Array.isArray(map) ? map[pinTypeIndex(a)] : null, v = Array.isArray(row) ? row[pinTypeIndex(b)] : 0;
  return Number.isInteger(v) && v >= 0 && v <= 3 ? v : PIN_MATRIX[pinTypeIndex(a)][pinTypeIndex(b)];
}
/** ercErrorCode: only PIN_ERROR::WARNING is a warning, every other non-OK value is ERCE_PIN_TO_PIN_ERROR. */
export const pinErrorSeverity = (e: number): "error" | "warning" => (e === 1 ? "warning" : "error");
/** SCH_PIN::IsStacked: pins of one symbol at one position with one name, of the same type or one of them passive / free. */
export function stackedPins(a: { item: KItem; p: Pt; pin: SymPin }, b: { item: KItem; p: Pt; pin: SymPin }): boolean {
  const loose = (t: string) => t === "passive" || t === "free";
  return a.item === b.item && ptKey(a.p) === ptKey(b.p) && a.pin.name === b.pin.name && (a.pin.type === b.pin.type || loose(a.pin.type) || loose(b.pin.type));
}
/** StrNumCmp (case sensitive): runs of digits compare as numbers. */
export function strNumCmp(a: string, b: string): number {
  let i = 0, j = 0; const digit = (c: string): boolean => c >= "0" && c <= "9";
  while (i < a.length && j < b.length) {
    let c1 = a[i], c2 = b[j];
    if (digit(c1) && digit(c2)) {
      let n1 = 0, n2 = 0;
      do { n1 = n1 * 10 + (a.charCodeAt(i) - 48); i++; } while (i < a.length && digit(a[i]));
      do { n2 = n2 * 10 + (b.charCodeAt(j) - 48); j++; } while (j < b.length && digit(b[j]));
      if (n1 !== n2) return n1 < n2 ? -1 : 1;
      c1 = i < a.length ? a[i] : "\0"; c2 = j < b.length ? b[j] : "\0";
    }
    if (c1 !== c2) return c1 < c2 ? -1 : 1;
    if (i < a.length) i++;
    if (j < b.length) j++;
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0;
}
export const ptKey = (p: Pt) => r4(p[0]) + "," + r4(p[1]);
/** A terminal of an ERC net: a symbol pin, a sheet pin or an item's connection point; attached once it touches another. */
export interface ErcTerm { item: KItem; p: Pt; net: string; key?: string; pin?: SymPin; power?: boolean; sheetPin?: string; attached?: boolean; sg?: ErcSubgraph }
/** The terminals that touch each other on one sheet (CONNECTION_SUBGRAPH), its no-connect flag (m_no_connect) and the net its names put it on. */
export interface ErcSubgraph { terms: ErcTerm[]; nc: KItem | null; net: ErcNet | null }
/** An ERC net: its terminals, the ids of the items they belong to and its subgraphs (joined by label and power names). */
export interface ErcNet { terms: ErcTerm[]; ids: Set<string>; sgs?: ErcSubgraph[] }
/** ercCheck's options: the project's Pin Conflicts Map, the sub-sheet docs, the parent sheet's pin names, and the ERC dialog's 'Show all errors' (ERC_TESTER's m_showAllErrors). */
export interface ErcOpts {
  pinMap?: number[][]; sheetDocs?: SheetDocs | null; parentPins?: Iterable<string> | null; showAllErrors?: boolean;
  /** SCHEMATIC_SETTINGS m_ConnectionGridSize in mm (default 50 mil) */ connectionGrid?: number;
  /** the project's netclass names (net_settings.classes); undefined_netclass runs only when given */ netclasses?: Iterable<string> | null; defaultNetclass?: string;
  /** false: the caller runs the hierarchy-wide tests itself (hierarchyTests and netTests over every sheet) */ crossSheet?: boolean;
  /** the sheet is a top-level sheet (SCH_SHEET::IsTopLevelSheet): its hierarchical labels have no parent to reach */ root?: boolean;
  /** runERC shows no summary (the ERC dialog reports the run itself) */ silent?: boolean;
  /** the net name KiCad gives a pin of a sheet instance (the hierarchy's net map), for the tests that compare and print names */
  netName?(inst: number, symbolId: string, pin: string): string | undefined;
}
/** ctx.sheetDocs: Sheetfile (or docId / path) -> parsed doc or its text. */
export type SheetDocs = NonNullable<SchCtx["sheetDocs"]>;
// Every terminal on the sheet joined into subgraphs (what touches) and nets (subgraphs sharing a label or power name),
// the rules of netItems evaluated once with union-find.
export function ercNets(doc: KDoc) {
  const terms: ErcTerm[] = [];
  for (const it of doc.items.values()) {
    if (it.kind === "symbol") {
      const power = symbolIsPower(doc, it), value = kids(it.node, "property").find((p) => str(p[1]) === "Value");
      for (const pin of symbolPins(doc, it)) {
        let key: string | undefined; if (power && value && pin.type === "power_in") key = "global:" + str(value[2]); else if (pin.hidden && pin.type === "power_in") key = "global:" + pin.name;
        terms.push({ item: it, p: [pin.x, pin.y], net: "wire", key, pin, power });
      }
    } else if (it.kind === "sheet") { for (const pin of kids(it.node, "pin")) terms.push({ item: it, p: atOf(pin).slice(0, 2).map(r4), net: "any", sheetPin: str(pin[1]) }); }
    else for (const t of terminalsOf(doc, it)) terms.push(Object.assign({ item: it }, t));
  }
  const parent = terms.map((_, i) => i);
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const byItem = new Map<KItem, number[]>(), byPoint = new Map<string, number[]>(), byKey = new Map<string, number[]>(), touch = terms.map(() => false);
  terms.forEach((t, i) => {
    if (!byItem.has(t.item)) byItem.set(t.item, []); byItem.get(t.item)!.push(i);
    const pk = ptKey(t.p); if (!byPoint.has(pk)) byPoint.set(pk, []); byPoint.get(pk)!.push(i);
    if (t.key) { if (!byKey.has(t.key)) byKey.set(t.key, []); byKey.get(t.key)!.push(i); }
  });
  for (const [it, idx] of byItem) if (conducts(it)) for (let k = 1; k < idx.length; k++) union(idx[0], idx[k]);
  for (const idx of byPoint.values()) for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) if (terms[idx[a]].item !== terms[idx[b]].item && joins(terms[idx[a]], terms[idx[b]])) { union(idx[a], idx[b]); touch[idx[a]] = touch[idx[b]] = true; }
  for (const [it, idx] of byItem) {
    if (!isNetLine(it.kind)) continue;
    const sg = segs(it), lineT = { net: it.kind };
    terms.forEach((u, i) => { if (u.item === it || !joins(lineT, u)) return; if (sg.some(([a, b]) => onSegMid(u.p, a, b))) { union(idx[0], i); touch[i] = true; } });
  }
  // what touches is a subgraph; the names then join subgraphs into nets
  const phys = terms.map((_, i) => find(i)), sgMap = new Map<number, ErcSubgraph>();
  terms.forEach((t, i) => { let g = sgMap.get(phys[i]); if (!g) sgMap.set(phys[i], g = { terms: [], nc: null, net: null }); g.terms.push(t); t.sg = g; });
  for (const idx of byKey.values()) for (let k = 1; k < idx.length; k++) union(idx[0], idx[k]);
  const nets = new Map<number, ErcNet>();
  terms.forEach((t, i) => {
    const r = find(i); if (!nets.has(r)) nets.set(r, { terms: [], ids: new Set(), sgs: [] }); const n = nets.get(r)!; n.terms.push(t); n.ids.add(t.item.id); t.attached = touch[i];
    if (t.sg && !t.sg.net) { t.sg.net = n; n.sgs!.push(t.sg); }
  });
  // a no-connect flag belongs to the subgraph with a connection point under it (CONNECTION_SUBGRAPH::m_no_connect)
  const looseNc: KItem[] = [];
  for (const it of doc.items.values()) {
    if (it.kind !== "no_connect") continue;
    const idx = byPoint.get(ptKey(atOf(it.node).slice(0, 2).map(r4))) || [], at = idx.find((i) => terms[i].net !== "bus");
    const g = at === undefined ? null : terms[at].sg || null;
    if (g) { if (!g.nc) g.nc = it; } else looseNc.push(it);
  }
  return { terms, nets: Array.from(nets.values()), subgraphs: Array.from(sgMap.values()), looseNc };
}
// A no-connect flag at p, a sheet pin at p, any net line end / middle at p.
export function noConnectAt(doc: KDoc, p: Pt) { return noConnectsAt(doc, p).length > 0; }
/** The item lines of an ERC report (RC_ITEM::ShowReport): an item's own position and its GetItemDescription;
 *  `len` (mm) is a length the report prints in its units where the text has "%L"; `id` (and `pin`, a symbol pin's
 *  number, or `sheetPin`, a sheet pin's name) name the item on its sheet for the dialog's cross-probe; `uuid` is the
 *  item's own KIID when it is not the id (a pin's). */
export interface ErcItemRef { x: number; y: number; desc: string; len?: number; id?: string; pin?: string; sheetPin?: string; uuid?: string }
const PIN_SHAPE_TEXT: Record<string, string> = { line: "Line", inverted: "Inverted", clock: "Clock", inverted_clock: "Inverted clock", input_low: "Input low", clock_low: "Clock low", output_low: "Output low", edge_clock_high: "Falling edge clock", non_logic: "NonLogic" };
const unesc = (t: string): string => { const u = (K as unknown as { unescapeText?(s: string): string }).unescapeText; return u ? u(t) : t; };
/** SCH_PIN::GetItemDescription of a placed symbol's pin: "Symbol U1 Pin 3 [IN+, Input, Line]". */
export function pinItemRef(t: ErcTerm & { pin: SymPin }): ErcItemRef {
  const name = t.pin.name && t.pin.name !== "~" ? unesc(t.pin.name) : "", type = PIN_TYPE_TEXT[t.pin.type] || "Unspecified", shape = PIN_SHAPE_TEXT[t.pin.shape || "line"] || "Line";
  const what = `${t.pin.hidden ? "Hidden pin" : "Pin"} ${t.pin.number} [${name ? name + ", " : ""}${type}, ${shape}]`;
  const u = kids(t.item.node, "pin").find((p) => str(p[1]) === t.pin.number), uu = u ? kid(u, "uuid") : null;
  return { x: r4(t.p[0]), y: r4(t.p[1]), desc: `Symbol ${t.item.ref || "?"} ${what}`, id: t.item.id, pin: t.pin.number, ...(uu ? { uuid: str(uu[1]) } : {}) };
}
/** An item's GetPosition and GetItemDescription (msgpanel.ts's itemDescription); a wire's or line's length is left as "%L" for the report's units. */
export function itemRef(doc: KDoc, it: KItem): ErcItemRef {
  const n = it.node, at = atOf(n), pts = it.kind === "wire" || it.kind === "bus" || it.kind === "polyline" ? ptsOf(n) : [];
  if (pts.length === 2) {
    const [a, b] = pts, what = it.kind === "wire" ? "Wire" : it.kind === "bus" ? "Bus" : "Graphic Line";
    const dir = a[0] === b[0] ? "Vertical " : a[1] === b[1] ? "Horizontal " : "";
    return { x: a[0], y: a[1], desc: `${dir}${what}, length %L`, len: Math.hypot(b[0] - a[0], b[1] - a[1]), id: it.id };
  }
  const p = pts[0] || at;
  return { x: p[0], y: p[1], desc: itemDescription(doc, it.id, "mm") || it.kind, id: it.id };
}
export function pinLabel(t: ErcTerm & { pin: SymPin }) { return `${t.item.ref || "?"} pin ${t.pin.number}${t.pin.name && t.pin.name !== "~" ? " (" + t.pin.name + ")" : ""}`; }
type PinTerm = ErcTerm & { pin: SymPin };
const NET_LABELS = new Set(["label", "global_label", "hierarchical_label"]);
const isLabelTerm = (t: ErcTerm): boolean => NET_LABELS.has(t.item.kind);
const isPinTerm = (t: ErcTerm): t is PinTerm => !!t.pin;
/** A sheet pin's own item line (SCH_SHEET_PIN::GetItemDescription). */
const sheetPinRef = (it: KItem, name: string, p: Pt): ErcItemRef => {
  const pin = kids(it.node, "pin").find((q) => str(q[1]) === name), uu = pin ? kid(pin, "uuid") : null;
  return { x: r4(p[0]), y: r4(p[1]), desc: `Hierarchical Sheet Pin '${ellipsizeMenuText(name)}'`, id: it.id, sheetPin: name, ...(uu ? { uuid: str(uu[1]) } : {}) };
};
/**
 * CONNECTION_SUBGRAPH::GetDriverPriority: global label 7, global power pin 6, local label 4, hierarchical label 3,
 * sheet pin 2, an ordinary symbol's pin 1; nothing else names a net (a pin of a "#" symbol that is no power input,
 * PWR_FLAG's, is no driver).
 */
function driverPriority(t: ErcTerm): number {
  if (t.pin) return t.key ? 6 : t.power ? 0 : 1;
  if (t.sheetPin !== undefined) return 2;
  const k = t.item.kind;
  return k === "global_label" ? 7 : k === "label" ? 4 : k === "hierarchical_label" ? 3 : 0;
}
/** CONNECTION_SUBGRAPH::GetNameForDriver of a label, power pin or sheet pin. */
const driverName = (t: ErcTerm): string => (t.pin ? (t.key || "").replace(/^global:/, "") : t.sheetPin !== undefined ? t.sheetPin : str(t.item.node[1]));
/** The uuid of a placed symbol's pin ((pin "3" (uuid …))), for the orders KiCad takes by KIID. */
function pinUuid(t: PinTerm): string {
  for (const p of kids(t.item.node, "pin")) if (str(p[1]) === t.pin.number) { const u = kid(p, "uuid"); if (u) return str(u[1]); }
  return t.item.id + "#" + t.pin.number;
}
export function ercCheck(doc: KDoc, opts?: ErcOpts | null) {
  opts = opts || {};
  // refs: the main and aux items of ShowReport (default: the first two of ids, as items of this sheet)
  const markers: ErcMarker[] = [], mark = (code: string, severity: string, p: Pt, text: string, ids: Iterable<string>, refs?: ErcItemRef[], extra?: Record<string, unknown>) => {
    const idl = Array.from(new Set(ids || []));
    const items = refs || idl.slice(0, 2).map((id) => doc.items.get(id)).filter((x): x is KItem => !!x).map((x) => itemRef(doc, x));
    markers.push(Object.assign({ code, severity, x: r4(p[0]), y: r4(p[1]), text, ids: idl, items }, extra || {}));
  };
  const info = ercNets(doc), { terms, nets, subgraphs } = info;
  const dangling = danglingEnds(doc), iu = (v: number): number => Math.round(v * 1e4);
  // TestEmptyLabelNames: local, global and hierarchical labels (a directive label carries no text)
  for (const it of doc.items.values()) if (NET_LABELS.has(it.kind) && !str(it.node[1]).trim()) mark("empty_label_name", "error", atOf(it.node), "Label has an empty name", [it.id]);
  // TestLabelMultipleWires: a local label on a point two or more wires or buses pass through (a line ending there has a junction)
  const lines = Array.from(doc.items.values()).filter((it) => isNetLine(it.kind) && ptsOf(it.node).length >= 2);
  const labelAt = new Map<string, { p: Pt; label: KItem }>();
  for (const it of doc.items.values()) if (it.kind === "label") { const p = atOf(it.node).slice(0, 2).map(r4), k = ptKey(p); if (!labelAt.has(k)) labelAt.set(k, { p, label: it }); }
  for (const { p, label } of labelAt.values()) {
    const through = lines.filter((ln) => segs(ln).some(([a, b]) => onSegMid(p, a, b)) && !same(ptsOf(ln.node)[0], p) && !same(ptsOf(ln.node)[ptsOf(ln.node).length - 1], p));
    if (through.length > 1) mark("label_multiple_wires", "warning", p, `Label connects more than one wire at ${iu(p[0])}, ${iu(p[1])}`, [label.id, ...through.slice(0, 3).map((x) => x.id)]);
  }
  // TestFourWayJunction: one pin of each symbol (a pin stack counts once, its visible pin shown) and every wire or bus end at a point
  const conn = new Map<string, { p: Pt; items: { id: string; ref: ErcItemRef; sym?: KItem; hidden?: boolean }[] }>();
  const connAt = (p: Pt) => { const k = ptKey(p); let e = conn.get(k); if (!e) conn.set(k, e = { p, items: [] }); return e; };
  for (const t of terms) {
    if (!isPinTerm(t)) continue;
    const e = connAt(t.p), had = e.items.find((x) => x.sym === t.item);
    if (had) { if (!t.pin.hidden && had.hidden) { had.ref = pinItemRef(t); had.hidden = false; } continue; }
    e.items.push({ id: t.item.id, ref: pinItemRef(t), sym: t.item, hidden: t.pin.hidden });
  }
  for (const ln of lines) { const pts = ptsOf(ln.node); for (const p of [pts[0], pts[pts.length - 1]]) connAt(p.map(r4)).items.push({ id: ln.id, ref: itemRef(doc, ln) }); }
  for (const e of conn.values()) if (e.items.length >= 4) mark("four_way_junction", "warning", e.p, `Four items connected at ${iu(e.p[0])}, ${iu(e.p[1])}`, e.items.slice(0, 4).map((x) => x.id), e.items.slice(0, 2).map((x) => x.ref));
  // TestNoConnectPins: a pin of the "no connection" type with another connectable item's connection point on it
  const ncPins = new Map<string, { p: Pt; items: { t: ErcTerm; nc: boolean }[] }>();
  for (const t of terms) if (isPinTerm(t) && t.pin.type === "no_connect") { const k = ptKey(t.p); let e = ncPins.get(k); if (!e) ncPins.set(k, e = { p: t.p, items: [] }); e.items.push({ t, nc: true }); }
  if (ncPins.size) for (const t of terms) { if (isPinTerm(t) && t.pin.type === "no_connect") continue; const e = ncPins.get(ptKey(t.p)); if (e) e.items.push({ t, nc: false }); }
  for (const e of ncPins.values()) {
    if (e.items.length < 2 || e.items.every((x) => x.nc)) continue;
    const refOf = (t: ErcTerm): ErcItemRef => (isPinTerm(t) ? pinItemRef(t) : t.sheetPin !== undefined ? sheetPinRef(t.item, t.sheetPin, t.p) : itemRef(doc, t.item));
    mark("no_connect_connected", "warning", e.p, "Pin with 'no connection' type is connected", e.items.slice(0, 4).map((x) => x.t.item.id), e.items.slice(0, 2).map((x) => refOf(x.t)));
  }
  // ercCheckDanglingWireEndpoints: every dangling end of a wire, and of a wire-to-bus entry
  for (const d of dangling) {
    if (d.what === "wire") mark("unconnected_wire_endpoint", "warning", d.p, "Unconnected wire endpoint", [d.item.id]);
    else if (d.what === "busEntry") mark("unconnected_wire_endpoint", "warning", d.p, "Unconnected wire to bus entry", [d.item.id]);
    // ercCheckDirectiveLabels: a directive label on nothing
    else if (d.what === "label" && (d.item.kind === "netclass_flag" || d.item.kind === "directive_label")) mark("label_dangling", "error", d.p, "Label not connected", [d.item.id]);
    // ercCheckHierSheets: a sheet pin on nothing
    else if (d.what === "label" && d.item.kind === "sheet") {
      const pin = kids(d.item.node, "pin").find((q) => same(atOf(q), d.p));
      mark("pin_not_connected", "error", d.p, "Pin not connected", [d.item.id], [sheetPinRef(d.item, pin ? str(pin[1]) : "", d.p)]);
    }
  }
  const danglingPin = (t: ErcTerm): boolean => dangling.some((d) => d.what === "pin" && d.item === t.item && same(d.p, t.p));
  for (const g of subgraphs) {
    // a hidden power input joins its net by name (CONNECTION_GRAPH's invisible power pins): it is not one of the pins that touch here
    const pins = g.terms.filter((t): t is PinTerm => isPinTerm(t) && !(t.pin.hidden && !!t.key));
    const hasDriver = g.terms.some((t) => driverPriority(t) > 0);
    // ercCheckFloatingWires: no driver at all, and wires (or wire-to-bus entries) to put the error on
    if (!hasDriver) {
      const wires: KItem[] = []; for (const t of g.terms) if ((t.item.kind === "wire" || t.item.kind === "bus_entry") && !wires.includes(t.item)) wires.push(t.item);
      if (wires.length) { const w = wires[0], at = w.kind === "wire" ? ptsOf(w.node)[0] : atOf(w.node); mark("wire_dangling", "error", at, "Wires not connected to anything", wires.slice(0, 4).map((x) => x.id)); }
    }
    // ercCheckMultipleDrivers: two strong drivers (labels, power pins) of different names on the same items
    const strong = g.terms.filter((t) => driverPriority(t) >= 3).sort((a, b) => driverPriority(b) - driverPriority(a) || (driverName(a) < driverName(b) ? -1 : driverName(a) > driverName(b) ? 1 : 0));
    if (strong.length > 1) {
      const first = strong[0], other = strong.find((t) => t !== first && driverName(t) !== driverName(first));
      if (other) {
        const refOf = (t: ErcTerm): ErcItemRef => (isPinTerm(t) ? pinItemRef(t) : itemRef(doc, t.item));
        mark("multiple_net_names", "warning", other.p, `Both ${driverName(first)} and ${driverName(other)} are attached to the same items; ${driverName(first)} will be used in the netlist`, [first.item.id, other.item.id], [refOf(first), refOf(other)]);
      }
    }
    // ercCheckNoConnects without a flag: a pin needs another pin that is not stacked on it, or a label or sheet pin
    if (g.nc) continue;
    let other = g.terms.some((t) => !t.pin && (isLabelTerm(t) || t.sheetPin !== undefined));
    for (let i = 0; i < pins.length && !other; i++) for (let j = i + 1; j < pins.length; j++) if (!stackedPins(pins[i], pins[j]) && (!pins[i].power || !pins[j].power)) { other = true; break; }
    let pin: PinTerm | null = pins[0] || null;
    // a power input of a real part rather than a stray power symbol's
    for (const t of pins) if (t.pin.type === "power_in" && !t.key) { pin = t; break; }
    if (pin && !other && pin.pin.type !== "no_connect" && pin.pin.type !== "free") mark("pin_not_connected", "error", pin.p, "Pin not connected", [pin.item.id], [pinItemRef(pin)]);
    // several pins joined by name only: a power symbol's pin that touches nothing is still a mistake
    if (pins.length > 1) for (const t of pins) if (t.power && danglingPin(t) && !(t === pin && !other)) mark("pin_not_connected", "error", t.p, "Pin not connected", [t.item.id], [pinItemRef(t)]);
  }
  // the ERC_TESTER tests of one sheet, and (alone on this sheet unless the caller checks the hierarchy) the ones across sheets
  sheetTests(doc, nets, mark, itemRef, pinItemRef, opts);
  if (opts.crossSheet !== false) {
    markers.push(...hierarchyTests([{ doc, key: "", nets }], itemRef, pinItemRef)[0]);
    markers.push(...netTests([{ doc, key: "", info, root: opts.root }], opts)[0]);
  }
  // ercCheckHierSheets: hierarchical labels of a top-level sheet, sheet pins against the sub-sheet's hierarchical labels
  if (opts.root) for (const it of doc.items.values()) if (it.kind === "hierarchical_label")
    mark("pin_not_connected", "error", atOf(it.node), `Hierarchical label '${str(it.node[1])}' in root sheet cannot be connected to non-existent parent sheet`, [it.id]);
  const sheetDocs = opts.sheetDocs || null;
  for (const it of doc.items.values()) {
    if (it.kind !== "sheet") continue;
    const sub = sheetDocs ? subsheetDoc(sheetDocs, it) : null; if (!sub) continue;
    // one sheet pin and one label per name (std::map), in name order
    const pinNames = new Map<string, SNode>(); for (const pin of kids(it.node, "pin")) pinNames.set(str(pin[1]), pin);
    const labels = new Map<string, KItem>(), matched = new Set<string>();
    for (const o of sub.items.values()) if (o.kind === "hierarchical_label") { const name = str(o.node[1]); if (pinNames.has(name)) matched.add(name); else labels.set(name, o); }
    for (const name of Array.from(pinNames.keys()).sort()) {
      if (matched.has(name)) continue;
      const pp = atOf(pinNames.get(name)!);
      mark("hier_label_mismatch", "error", pp, `Sheet pin ${unesc(name)} has no matching hierarchical label inside the sheet`, [it.id], [sheetPinRef(it, name, pp)]);
    }
    // the label's marker belongs to the sub-sheet (its own check puts it there with the parent's pins); a sheet checked
    // alone lists it here, its main item the label on the sub-sheet (mainFile)
    if (opts.crossSheet !== false) {
      const [x, y] = atOf(it.node);
      for (const name of Array.from(labels.keys()).sort()) mark("hier_label_mismatch", "error", [x, y], `Hierarchical label ${unesc(name)} has no matching sheet pin in the parent sheet`, [it.id], [itemRef(sub, labels.get(name)!)], { mainFile: it.file, mainSheet: it.id });
    }
  }
  if (opts.parentPins) {
    const pp = new Set(opts.parentPins), labels = new Map<string, KItem>();
    for (const it of doc.items.values()) if (it.kind === "hierarchical_label" && !pp.has(str(it.node[1]))) labels.set(str(it.node[1]), it);
    for (const name of Array.from(labels.keys()).sort()) { const it = labels.get(name)!; mark("hier_label_mismatch", "error", atOf(it.node), `Hierarchical label ${unesc(name)} has no matching sheet pin in the parent sheet`, [it.id]); }
  }
  return withKiids(sortSheetMarkers(markers));
}
/** ERC_ITEM::GetIDs of each marker as `kiids`: the uuids of its own items (a pin's, not its symbol's), four at most. */
export function withKiids<T extends { ids: string[]; items?: ErcItemRef[] }>(markers: T[]): T[] {
  for (const m of markers) {
    const items = m.items || [], own = items.map((r) => r.uuid || r.id || "").filter((u) => u);
    (m as T & { kiids?: string[] }).kiids = own.concat(m.ids.filter((id) => !items.some((r) => r.id === id))).slice(0, 4);
  }
  return markers;
}
/** SHEETLIST_ERC_ITEMS_PROVIDER::visitMarkers' order on one sheet: by x, then y, then the message. */
export function sortSheetMarkers<T extends { x: number; y: number; text: string }>(markers: T[]): T[] {
  return markers.map((m, i) => [m, i] as const).sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y || (a[0].text < b[0].text ? -1 : a[0].text > b[0].text ? 1 : 0) || a[1] - b[1]).map(([m]) => m);
}

/** A sheet instance for netTests: its nets, the instance its sheet symbol is on (`parent`, an index) and that symbol's id. */
export interface ErcNetInstance { doc: KDoc; key: string; info: ReturnType<typeof ercNets>; parent?: number | null; sheetId?: string | null; root?: boolean;
}
/**
 * The tests on whole nets, every sheet instance at once (ERC_TESTER::TestPinToPin, TestMultUnitPinConflicts,
 * TestDuplicatePinNets, CONNECTION_GRAPH::ercCheckNoConnects with a flag and ercCheckLabels): a net is its subgraphs
 * on every sheet joined by global labels and power names and through sheet pins to the hierarchical labels inside.
 * Returns the markers of each instance (by index).
 */
export function netTests(insts: ErcNetInstance[], opts?: ErcOpts | null): ErcMarker[][] {
  opts = opts || {};
  const out: ErcMarker[][] = insts.map(() => []);
  const mark = (i: number, code: string, severity: string, p: Pt, text: string, ids: string[], items: ErcItemRef[]): void => { out[i].push({ code, severity, x: r4(p[0]), y: r4(p[1]), text, ids: Array.from(new Set(ids)), items } as ErcMarker); };
  // ---- the nets of the hierarchy
  interface Part { i: number; net: ErcNet }
  const parts: Part[] = []; insts.forEach((s, i) => { for (const net of s.info.nets) parts.push({ i, net }); });
  const parent = parts.map((_, k) => k), indexOf = new Map<ErcNet, number>(); parts.forEach((p, k) => indexOf.set(p.net, k));
  const find = (k: number): number => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const union = (a: number, b: number): void => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const byGlobal = new Map<string, number>(), byName = new Map<string, number>();
  const nameOfPin = (i: number, t: PinTerm): string | undefined => (opts!.netName ? opts!.netName(i, t.item.id, t.pin.number) : undefined);
  parts.forEach((p, k) => {
    for (const t of p.net.terms) {
      if (t.key && t.key.startsWith("global:")) { const had = byGlobal.get(t.key); if (had === undefined) byGlobal.set(t.key, k); else union(had, k); }
      if (isPinTerm(t)) { const name = nameOfPin(p.i, t); if (name) { const had = byName.get(name); if (had === undefined) byName.set(name, k); else union(had, k); } }
    }
  });
  // a sheet pin and the hierarchical label of its name inside the sheet are one net
  const childOf = new Map<string, number>();
  insts.forEach((s, i) => { if (s.parent !== undefined && s.parent !== null && s.sheetId) childOf.set(s.parent + "|" + s.sheetId, i); });
  const hierNet = new Map<string, number>();
  parts.forEach((p, k) => { for (const t of p.net.terms) if (t.item.kind === "hierarchical_label") hierNet.set(p.i + "|" + str(t.item.node[1]), k); });
  parts.forEach((p, k) => { for (const t of p.net.terms) if (t.sheetPin !== undefined) { const c = childOf.get(p.i + "|" + t.item.id), h = c === undefined ? undefined : hierNet.get(c + "|" + t.sheetPin); if (h !== undefined) union(k, h); } });
  interface Net { parts: Part[]; pins: { t: PinTerm; i: number }[]; nc: boolean; open: boolean; name: string; labels: number }
  const merged = new Map<number, Net>(), netOf = new Map<ErcNet, Net>();
  parts.forEach((p, k) => {
    const r = find(k); let m = merged.get(r); if (!m) merged.set(r, m = { parts: [], pins: [], nc: false, open: false, name: "", labels: 0 });
    m.parts.push(p); netOf.set(p.net, m);
    for (const t of p.net.terms) {
      if (isPinTerm(t)) m.pins.push({ t, i: p.i });
      else if (isLabelTerm(t)) m.labels++;
      // a way out of the sheets at hand: the rest of the net is not known
      if (t.sheetPin !== undefined && !childOf.has(p.i + "|" + t.item.id)) m.open = true;
      if (t.item.kind === "hierarchical_label" && !insts[p.i].root && (insts[p.i].parent === undefined || insts[p.i].parent === null)) m.open = true;
    }
    if ((p.net.sgs || []).some((g) => g.nc)) m.nc = true;
  });
  // the net's name: KiCad's own when the hierarchy's net map is at hand, else its strongest driver's (or its first pin's default)
  for (const m of merged.values()) {
    for (const { t, i } of m.pins) { const n = nameOfPin(i, t); if (n) { m.name = n; break; } }
    if (m.name) continue;
    let best: ErcTerm | null = null;
    for (const p of m.parts) for (const t of p.net.terms) if (driverPriority(t) >= 3 && (!best || driverPriority(t) > driverPriority(best))) best = t;
    if (best) m.name = (driverPriority(best) >= 6 ? "" : "/") + driverName(best);
    else if (m.pins.length) { const t = m.pins[0].t; m.name = `${m.pins.length === 1 ? "unconnected" : "Net"}-(${t.item.ref || "?"}-Pad${t.pin.number})`; }
  }
  const pinMap = opts.pinMap || PIN_MATRIX;
  for (const m of merged.values()) {
    // ---- TestPinToPin: every pin of the net, sorted by reference then pin number (StrNumCmp)
    const all = m.pins.slice().sort((a, b) => strNumCmp(a.t.item.ref || "", b.t.item.ref || "") || strNumCmp(a.t.pin.number, b.t.pin.number));
    const isPower = all.some((x) => x.t.pin.type === "power_in");
    let hasDriver = false, needs: (typeof all)[number] | null = null;
    const needAll: typeof all = [], mismatches: [number, number, number][] = [], weight = new Map<number, number>();
    for (let i = 0; i < all.length; i++) {
      const a = all[i].t;
      if (DRIVEN.has(a.pin.type)) {
        // needsDriver is the pin the report shows: upgraded to a visible one, and to a power input on a power net
        needAll.push(all[i]);
        if (!needs || (needs.t.pin.hidden && !a.pin.hidden) || (isPower !== (needs.t.pin.type === "power_in") && isPower === (a.pin.type === "power_in"))) needs = all[i];
      }
      if (isPower ? a.pin.type === "power_out" : DRIVING.has(a.pin.type)) hasDriver = true;
      for (let j = i + 1; j < all.length; j++) {
        const b = all[j].t;
        if (all[i].i === all[j].i && stackedPins(a, b)) continue;   // SCH_PIN::IsStacked on the same sheet
        const e = pinErrorAt(pinMap, a.pin.type, b.pin.type);
        if (!e) continue;
        mismatches.push([i, j, e]);
        // ERC_PIN_SORTING_METRIC::SM_HEURISTICS: the count is the pin type's weight
        weight.set(i, PIN_TYPE_WEIGHT[a.pin.type] ?? 10); weight.set(j, PIN_TYPE_WEIGHT[b.pin.type] ?? 10);
      }
    }
    // pins_dsc: heaviest first (ties keep the sorted order); each pin takes its nearest conflicting pin on its own
    // sheet (a pin of another sheet only while none of its own was found) and the pairs it was part of are used up
    const order = Array.from(weight.entries()).sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    let left = mismatches;
    for (const [pi] of order) {
      if (!left.length) break;
      const a = all[pi]; let near = -1, best = Infinity, err = 0; const rest: typeof left = [];
      for (const mm of left) {
        const [i, j, e] = mm, other = i === pi ? j : j === pi ? i : -1; if (other < 0) { rest.push(mm); continue; }
        if (all[other].i !== a.i) { if (best === Infinity) { near = other; err = e; } }
        else { const d = Math.hypot(all[other].t.p[0] - a.t.p[0], all[other].t.p[1] - a.t.p[1]); if (best === Infinity || d < best) { best = d; near = other; err = e; } }
      }
      left = rest;
      if (near < 0) continue;
      const b = all[near];
      mark(a.i, "pin_to_pin", pinErrorSeverity(err), a.t.p, `Pins of type ${PIN_TYPE_TEXT[a.t.pin.type]} and ${PIN_TYPE_TEXT[b.t.pin.type]} are connected`, [a.t.item.id, b.t.item.id], [pinItemRef(a.t), pinItemRef(b.t)]);
    }
    if (needs && !hasDriver && !m.nc && !m.open) {
      // one marker on the chosen pin, or with Show all errors one on every pin that needs a driver (the power inputs on
      // a power net, else the pins not on power symbols, else all of them)
      const powerIns = needAll.filter((x) => x.t.pin.type === "power_in"), nonPower = needAll.filter((x) => !x.t.key);
      const flagged = !opts.showAllErrors ? [isPower && powerIns.length ? powerIns[0] : needs] : isPower && powerIns.length ? powerIns : nonPower.length ? nonPower : needAll;
      for (const x of flagged) mark(x.i, isPower ? "power_pin_not_driven" : "pin_not_driven", "error", x.t.p, isPower ? "Input Power pin not driven by any Output Power pins" : "Input pin not driven by any Output pins", [x.t.item.id], [pinItemRef(x.t)]);
    }
  }
  // ---- ercCheckNoConnects with a flag, ercCheckLabels: each subgraph against the whole net of its name
  insts.forEach((s, i) => {
    const dangling = danglingEnds(s.doc);
    for (const nc of s.info.looseNc) mark(i, "no_connect_dangling", "warning", atOf(nc.node), 'Unconnected "no connection" flag', [nc.id], [itemRef(s.doc, nc)]);
    for (const g of s.info.subgraphs) {
      const m = g.net ? netOf.get(g.net) : undefined; if (!m) continue;
      const sgPins = g.terms.filter(isPinTerm), sgLabels = g.terms.filter(isLabelTerm);
      const hierPins = g.terms.filter((t) => t.sheetPin !== undefined), hierPorts = g.terms.filter((t) => t.item.kind === "hierarchical_label");
      if (g.nc) {
        const ncAt = atOf(g.nc.node).slice(0, 2).map(r4);
        // the flag marks a hierarchical link as unconnected: on the sheet pin or label itself, or on a stub with nothing else
        const clean = (hierPins.length || hierPorts.length) && !g.terms.some((t) => t.pin || t.item.kind === "label" || t.item.kind === "global_label" || t.item.kind === "netclass_flag" || t.item.kind === "directive_label");
        const onLink = hierPins.concat(hierPorts).some((t) => same(t.p, ncAt));
        const onNcPin = sgPins.some((t) => same(t.p, ncAt) && t.pin.type === "no_connect");
        if (!clean && !onLink && !onNcPin) {
          // the pins of the whole net, a pin stack once
          const unique: { t: PinTerm; i: number }[] = [];
          for (const x of m.pins) if (!unique.some((u) => u.i === x.i && stackedPins(u.t, x.t))) unique.push(x);
          if (unique.length > 1 && !m.open) {
            // the flag's own pin: the lowest uuid of this subgraph's (not a power flag's output)
            let pin: PinTerm | null = null;
            for (const t of sgPins) { if (t.power && t.pin.type === "power_out") continue; if (!pin || pinUuid(t) < pinUuid(pin)) pin = t; }
            if (pin) mark(i, "no_connect_connected", "warning", pin.p, 'A pin with a "no connection" flag is connected', [pin.item.id, g.nc.id], [pinItemRef(pin), itemRef(s.doc, g.nc)]);
            else mark(i, "no_connect_connected", "warning", ncAt, 'A pin with a "no connection" flag is connected', [g.nc.id], [itemRef(s.doc, g.nc)]);
          }
          if (!unique.length && !m.labels && !m.open) mark(i, "no_connect_dangling", "warning", ncAt, 'Unconnected "no connection" flag', [g.nc.id], [itemRef(s.doc, g.nc)]);
        }
      }
      // ercCheckLabels (a bus is left out: one use of a bus is fine as long as its nets pass)
      if (!sgLabels.length || g.terms.some((t) => t.item.kind === "bus")) continue;
      const loose = sgLabels.find((t) => dangling.some((d) => d.what === "label" && d.item === t.item));
      if (loose) { mark(i, "label_dangling", "error", loose.p, "Label not connected", [loose.item.id], [itemRef(s.doc, loose.item)]); continue; }
      if (sgPins.length > 1 || m.open) continue;
      const allPins = m.pins.length, localPins = m.pins.filter((x) => x.i === i).length;
      // a label joining several hierarchical links (here or on another subgraph of the net on this sheet) routes nets
      const ports = new Set(hierPorts.map((t) => str(t.item.node[1])));
      const localHier = hierPins.length + ports.size > 1 || m.parts.some((p) => p.i === i && (p.net.sgs || []).some((o) => o !== g && o.terms.some((t) => t.sheetPin !== undefined || t.item.kind === "hierarchical_label")));
      const seen = new Set<KItem>();
      for (const t of sgLabels) {
        if (seen.has(t.item)) continue; seen.add(t.item);
        if (allPins === 1 && !m.nc) mark(i, "isolated_pin_label", "warning", t.p, "Label connected to only one pin", [t.item.id], [itemRef(s.doc, t.item)]);
        if (allPins === 0 || (t.item.kind === "label" && localPins === 0 && allPins > 1 && !m.nc && !localHier)) mark(i, "label_dangling", "error", t.p, "Label not connected", [t.item.id], [itemRef(s.doc, t.item)]);
      }
    }
  });
  // ---- TestMultUnitPinConflicts: one pin number of a multi-unit symbol on different nets in different units
  const unitsOf = (doc: KDoc, it: KItem): number => { const lib = K.resolveLib(doc, symbolLibId(it.node)); let n = 1; if (lib) for (const u of kids(lib, "symbol")) { const mm = str(u[1]).match(/_(\d+)_(\d+)$/); if (mm) n = Math.max(n, +mm[1]); } return n; };
  const shared = new Map<string, { net: Net; t: PinTerm; i: number }[]>();
  insts.forEach((s, i) => {
    const multi = new Map<KItem, boolean>();
    for (const net of s.info.nets) for (const t of net.terms) {
      if (!isPinTerm(t)) continue;
      let mu = multi.get(t.item); if (mu === undefined) multi.set(t.item, mu = unitsOf(s.doc, t.item) > 1);
      if (!mu) continue;
      const name = (t.item.ref || "") + ":" + t.pin.number, m = netOf.get(net)!;
      const l = shared.get(name); if (l) l.push({ net: m, t, i }); else shared.set(name, [{ net: m, t, i }]);
    }
  });
  for (const name of Array.from(shared.keys()).sort()) {
    const l = shared.get(name)!; if (!l.some((x) => x.net !== l[0].net)) continue;
    const pins = l.slice().sort((a, b) => (a.net.name !== b.net.name ? (a.net.name < b.net.name ? -1 : 1) : pinUuid(a.t) < pinUuid(b.t) ? -1 : pinUuid(a.t) > pinUuid(b.t) ? 1 : 0));
    const first = pins[0], other = pins.find((x) => x.net !== first.net); if (!other) continue;
    mark(other.i, "different_unit_net", "error", other.t.p, `Pin ${other.t.pin.number} is connected to both ${other.net.name} and ${first.net.name}`, [other.t.item.id, first.t.item.id], [pinItemRef(other.t), pinItemRef(first.t)]);
  }
  // ---- TestDuplicatePinNets: pins of one symbol with the same number on different nets (unless the symbol's duplicate numbers are jumpers)
  insts.forEach((s, i) => {
    const bySym = new Map<KItem, PinTerm[]>();
    for (const net of s.info.nets) for (const t of net.terms) if (isPinTerm(t)) { const l = bySym.get(t.item); if (l) l.push(t); else bySym.set(t.item, [t]); }
    for (const [it, pins] of bySym) {
      const lib = K.resolveLib(s.doc, symbolLibId(it.node)); if (!lib) continue;
      const jumpers = kid(lib, "duplicate_pin_numbers_are_jumpers"); if (jumpers && str(jumpers[1]) === "yes") continue;
      const byNumber = new Map<string, PinTerm[]>();
      for (const t of pins) { const l = byNumber.get(t.pin.number); if (l) l.push(t); else byNumber.set(t.pin.number, [t]); }
      for (const number of Array.from(byNumber.keys()).sort()) {
        const l = byNumber.get(number)!; if (l.length < 2) continue;
        const net = (t: PinTerm): Net | undefined => (t.sg && t.sg.net ? netOf.get(t.sg.net) : undefined), firstNet = net(l[0]);
        const conflict = l.slice(1).find((t) => net(t) !== firstNet); if (!conflict) continue;
        const nm = (n: Net | undefined): string => (n && n.name) || "<no net>";
        mark(i, "duplicate_pins", "error", l[0].p, `Pin ${number} on symbol '${it.ref || ""}' is connected to different nets: ${nm(firstNet)} and ${nm(net(l[1]))}`, [it.id], [pinItemRef(l[0]), pinItemRef(conflict)]);
      }
    }
  });
  return out;
}
// ctx.sheetDocs: a Map or object of Sheetfile (or docId / path) -> parsed doc or its text.
export function subsheetDoc(sheetDocs: SheetDocs, sheet: KItem): KDoc | null {
  // a Map, or a plain object that may itself have a "get" / "set" key: the original tests for the methods
  const asMap = sheetDocs as Partial<Map<string, KDoc | string>>, asObj = sheetDocs as Record<string, KDoc | string>;
  const get = (k: string) => (typeof asMap.get === "function" ? asMap.get(k) : asObj[k]);
  const file = sheet.file || str((kids(sheet.node, "property").find((p) => str(p[1]) === "Sheetfile") || [])[2]);
  let d = get(file) || get(baseName(file)) || get(sheet.id); if (!d) return null;
  if (typeof d === "string") { try { d = K.parseDoc(d); } catch (e) { return null; } if (typeof asMap.set === "function") asMap.set(file, d); }
  return d && d.items ? d : null;
}
export function runERC(ctx: SchCtx, opts?: ErcOpts | null) {
  const markers = ercCheck(ctx.doc, Object.assign({ sheetDocs: ctx.sheetDocs, parentPins: ctx.parentSheetPins }, opts || {}));
  S.markers = markers; S.markersDoc = ctx.doc;
  if (typeof ctx.setMarkers === "function") ctx.setMarkers(markers);
  const errors = markers.filter((m) => m.severity === "error").length;
  if (!(opts && opts.silent)) ctx.toast(markers.length ? `ERC: ${errors} error${errors === 1 ? "" : "s"}, ${markers.length - errors} warning${markers.length - errors === 1 ? "" : "s"}` : "ERC: no problems found");
  ctx.requestRender(); return true;
}
// Sheet pins the sub-sheet's hierarchical labels ask for (syncSheetPins); cleanupSheetPins removes the orphans.
export function syncSheetPins(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes: KChange[] = []; let added = 0;
  for (const it of selectedItems(ctx)) {
    if (it.kind !== "sheet") continue;
    const sub = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, it) : null; if (!sub) { ctx.toast("The sheet's file is not loaded"); continue; }
    const have = new Set<string>(kids(it.node, "pin").map((p) => str(p[1]))); const node = deep(it.node);
    const [x, y] = atOf(node), s = kid(node, "size"), h = num(s && s[2]); let row = 0;
    for (const o of sub.items.values()) {
      if (o.kind !== "hierarchical_label" || have.has(str(o.node[1]))) continue;
      const py = Math.min(y + h, r4(y + 1.27 * (++row)));
      const pin = sheetPinNode(str(o.node[1]), [x, py], "left"); const at = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (at >= 0) node.splice(at, 0, pin); else node.push(pin);
      have.add(str(o.node[1])); added++;
    }
    if (added) changes.push(modChange(doc, it, node));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "sync sheet pins"); return true;
}
/**
 * GetUnplacedSheetPinLabels + AutoPlaceSheetPins (sch_tool_utils.cpp), for Autoplace All Sheet Pins: the sub-sheet's
 * hierarchical labels with no pin yet, outputs down the right edge and the rest down the left, each column sorted by
 * name and stacked below the pins already on that edge at a grid-snapped pitch; the sheet grows when they would run
 * past its bottom.  Returns the new sheet node, or null when no label is unplaced.
 */
export function autoPlaceSheetPinsNode(sheetNode: SNode, sub: KDoc, textSize = 1.27): SNode | null {
  const names = new Set<string>(kids(sheetNode, "pin").map((p) => str(p[1])));
  const labels: { name: string; shape: string }[] = [];
  for (const o of sub.items.values()) if (o.kind === "hierarchical_label") { const n = str(o.node[1]); if (!names.has(n)) { names.add(n); const sh = kid(o.node, "shape"); labels.push({ name: n, shape: sh ? str(sh[1]) : "input" }); } }
  if (!labels.length) return null;
  const IU = 1e4, iu = (mm: number) => Math.round(mm * IU), mm = (v: number) => r4(v / IU);
  const grid = iu(1.27), ts = iu(textSize);
  let pitch = Math.max(Math.round(ts * 2), iu(2.54)); pitch = Math.round(pitch / grid) * grid;
  const margin = pitch, node = deep(sheetNode), [x, y] = atOf(node), size = kid(node, "size")!;
  const leftX = iu(x), rightX = iu(x) + iu(num(size[1])), topY = iu(y), h0 = iu(num(size[2]));
  let leftY = topY + margin - pitch, rightY = leftY;
  for (const p of kids(node, "pin")) { const a = kid(p, "at"); if (!a) continue; const r = ((Math.round(num(a[3]) || 0) % 360) + 360) % 360, py = iu(num(a[2])); if (r === 0) rightY = Math.max(rightY, py); else if (r === 180) leftY = Math.max(leftY, py); }
  const byText = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const right = labels.filter((l) => l.shape === "output").sort(byText), left = labels.filter((l) => l.shape !== "output").sort(byText);
  const needBot = Math.max(leftY + left.length * pitch, rightY + right.length * pitch) + margin;
  if (needBot > topY + h0) {
    // SCH_SHEET::Resize re-runs AutoplaceFields only when the fields are autoplaced: those below the sheet then follow
    // its bottom edge; fields placed by hand stay where they are
    const dh = needBot - topY - h0; size[2] = mm(needBot - topY);
    const ap = kid(node, "fields_autoplaced"), auto = !!ap && str(ap[1]) !== "no";
    if (auto) for (const f of kids(node, "property")) { const fa = kid(f, "at"); if (fa && iu(num(fa[2])) >= topY + h0) fa[2] = mm(iu(num(fa[2])) + dh); }
    for (const p of kids(node, "pin")) { const a = kid(p, "at"); if (a && iu(num(a[2])) === topY + h0 && (Math.round(num(a[3]) || 0) % 360 + 360) % 360 === 270) a[2] = mm(needBot); }
  }
  const column = (col: { name: string; shape: string }[], px: number, start: number, side: string) => {
    let py = Math.round(start / grid) * grid;
    // pin->SetTextSize( m_DefaultTextSize )
    for (const l of col) { py += pitch; const pin = sheetPinNode(l.name, [mm(px), mm(py)], side, textSize); pin[2] = l.shape; const i = node.findIndex((c) => Array.isArray(c) && c[0] === "instances"); if (i >= 0) node.splice(i, 0, pin); else node.push(pin); }
  };
  column(left, leftX, leftY, "left"); column(right, rightX, rightY, "right");
  return node;
}
export function cleanupSheetPins(ctx: SchCtx) {
  if (!editable(ctx)) return false;
  const doc = ctx.doc, changes: KChange[] = [];
  for (const it of selectedItems(ctx)) {
    if (it.kind !== "sheet") continue;
    const sub = ctx.sheetDocs ? subsheetDoc(ctx.sheetDocs, it) : null; if (!sub) { ctx.toast("The sheet's file is not loaded"); continue; }
    // SCH_SHEET::CleanupSheet: a pin stays when a hierarchical label has its name, compared without case (CmpNoCase)
    const hier = new Set<string>(); for (const o of sub.items.values()) if (o.kind === "hierarchical_label") hier.add(str(o.node[1]).toLowerCase());
    const node = deep(it.node); const before = kids(node, "pin").length;
    for (let i = node.length - 1; i > 0; i--) { const c = node[i]; if (Array.isArray(c) && c[0] === "pin" && !hier.has(str(c[1]).toLowerCase())) node.splice(i, 1); }
    if (kids(node, "pin").length !== before) changes.push(modChange(doc, it, node));
  }
  if (!changes.length) return false;
  ctx.commit(changes, "cleanup sheet pins"); return true;
}
