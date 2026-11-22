// sim/op-overlay.ts — the operating point on the schematic, as eeschema shows it after an OP analysis:
//   * SIMULATOR_FRAME_UI::OnSimRefresh (ST_OP): every vector becomes SCHEMATIC::SetOperatingPoint( signal, value ),
//     the signal without its V( … ) / I( … ) wrapper (a net's SPICE name, an item's name, "item:pin");
//   * SCH_EDIT_FRAME::RefreshOperatingPointDisplay: a two-pin symbol's current on its first pin, a multi-pin symbol's
//     on each model pin ("ref:pinname"), formatted with Schematic Setup's OP current precision / range;
//   * UpdateOperatingPointVoltages (sim/operating_point.cpp): each net's voltage on its longest wire of the sheet;
//   * SCH_PAINTER: the text on LAYER_OP_VOLTAGES / LAYER_OP_CURRENTS (View > Show OP Voltages / Currents), the stroke
//     font at getOperatingPointTextSize(), above a horizontal wire or right of a vertical one, along the pin.
import { E, isSch, requestRender } from "../dialogs/editor";
import { overlayHooks, backgroundDark } from "../editor/overlays";
import { netsOfItems } from "../editor/schnets";
import { schExtraColors } from "../dialogs/color-themes";
import { convertToSpiceMarkup } from "./spice-netlist";
import { formatValue } from "./sim-logic";
import type { SimItemInfo } from "./spice-netlist";

type SNode = unknown[];
interface KItem { id: string; kind: string; node: SNode }
interface KApi {
  kids(n: unknown, k: string): SNode[]; kid(n: unknown, k: string): SNode | null; str(v: unknown): string; ptsOf(n: unknown): number[][];
  drawStrokeText(ctx: CanvasRenderingContext2D, base: number[], spec: { x: number; y: number; text: string; size: number; rot?: number; h: string; v: string; pen: number }, color: string, minPen: number): void;
  SCH: Record<string, string>; schTheme?: () => string; textWidth?(text: string, size: number, pen: number): number;
}
interface PinGeom { x: number; y: number; root: number[]; number: string; len: number }
interface SchApi { _: { symbolPins(doc: unknown, it: KItem): PinGeom[] } }

/** SCHEMATIC::m_operatingPoints: lower-case signal → value (empty: no operating point). */
const points = new Map<string, number>();
let installed = false;
/** The netlist's items (SIM_LIB_MGR::CreateModel's model of each symbol: its item name and model pins), by reference. */
const simItems = new Map<string, SimItemInfo>();
export function setSimItems(list: SimItemInfo[]): void { simItems.clear(); for (const x of list) simItems.set(x.ref, x); }

/** The vectors of an OP run (ngspice's names: v(net), i(item), i(item:pin), item#branch, @item[i]) as the schematic's
 *  operating points; an empty list clears them (SCHEMATIC::ClearOperatingPoints). */
export function setOperatingPoints(vectors: { name: string; value: number }[]): void {
  points.clear();
  for (const v of vectors) {
    const n = v.name.toLowerCase(); let key = n;
    let m: RegExpExecArray | null;
    if ((m = /^[vi]\((.*)\)$/.exec(n))) key = m[1];
    else if ((m = /^(.*)#branch$/.exec(n))) key = m[1];
    else if ((m = /^@([\w.]+)\[i\w*\]$/.exec(n))) key = m[1];
    else if (/^@/.test(n)) continue;
    if (!points.has(key)) points.set(key, v.value);
  }
  install(); refreshTextVars(); requestRender();
}
export function clearOperatingPoints(): void { const had = points.size > 0; points.clear(); if (had) refreshTextVars(); requestRender(); }
export function operatingPointCount(): number { return points.size; }

/** SCHEMATIC::GetOperatingPoint: "" for ground, "--" before any OP, "?" for a name the run did not produce. */
export function operatingPoint(name: string, precision: number, range: string): string {
  const spice = convertToSpiceMarkup(name).toLowerCase();
  if (spice === "gnd" || spice === "0") return "";
  if (!points.size) return "--";
  const v = points.get(spice);
  if (v === undefined) return "?";
  return formatValue(v, { precision, range });
}

/** Schematic Setup > Formatting's operating-point formats (SCHEMATIC_SETTINGS m_OPO_*; 3 digits, "~V" / "~A"). */
function opFormats(): { vPrec: number; vRange: string; iPrec: number; iRange: string } {
  const d = { vPrec: 3, vRange: "~V", iPrec: 3, iRange: "~A" };
  try {
    type Opo = { operating_point_overlay_v_precision?: number; operating_point_overlay_v_range?: string; operating_point_overlay_i_precision?: number; operating_point_overlay_i_range?: string };
    const j = JSON.parse(String(E.proSettings || "{}")) as { schematic?: { drawing?: Opo } };
    const s = (j.schematic && j.schematic.drawing) || {};
    if (typeof s.operating_point_overlay_v_precision === "number") d.vPrec = s.operating_point_overlay_v_precision;
    if (typeof s.operating_point_overlay_v_range === "string") d.vRange = s.operating_point_overlay_v_range.replace(/A$/, "V");   // "Patch for bug early in V7.99 dev"
    if (typeof s.operating_point_overlay_i_precision === "number") d.iPrec = s.operating_point_overlay_i_precision;
    if (typeof s.operating_point_overlay_i_range === "string") d.iRange = s.operating_point_overlay_i_range;
  } catch { /* the defaults */ }
  return d;
}

/** `span`: a voltage's wire length in mm, `vertical` whether that is its height (SCH_LINE::ViewGetLOD's measure). */
interface OpText { x: number; y: number; text: string; rot: number; h: string; v: string; kind: "V" | "I"; span?: number; vertical?: boolean }
/** The overlay texts of the sheet on screen. */
export function operatingPointTexts(textSize: number): OpText[] {
  const out: OpText[] = [];
  const doc = E.kdoc as unknown as { items: Map<string, KItem> } | null;
  const K = (window as unknown as { KiCadCanvas?: KApi }).KiCadCanvas, sch = (window as unknown as { CollabTools?: { sch?: SchApi } }).CollabTools?.sch;
  if (!points.size || !doc || !K || !isSch()) return out;
  const f = opFormats(), off = textSize * 0.22;
  const showV = E.renderOpts.showOpVoltages !== false, showI = E.renderOpts.showOpCurrents !== false;
  const prop = (n: SNode, name: string): string => { const p = K.kids(n, "property").find((q) => K.str(q[1]) === name); return p ? K.str(p[2]) : ""; };
  if (showV) {
    // UpdateOperatingPointVoltages: per net of this sheet, its longest wire
    const wires = Array.from(doc.items.values()).filter((it) => it.kind === "wire");
    const nets = netsOfItems(wires.map((w) => w.id));
    const best = new Map<string, { w: KItem; len: number }>();
    wires.forEach((w, i) => {
      const e = nets[i]; if (!e || e.bus) return;
      const p = K.ptsOf(w.node); if (p.length < 2) return;
      const len = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      const b = best.get(e.name); if (!b || len > b.len) best.set(e.name, { w, len });
    });
    for (const [name, { w }] of best) {
      const op = operatingPoint(name, f.vPrec, f.vRange); if (!op || op === "--" || op === "?") continue;
      const p = K.ptsOf(w.node), mx = (p[0][0] + p[1][0]) / 2, my = (p[0][1] + p[1][1]) / 2;
      const hgt = Math.abs(p[0][1] - p[1][1]), wid = Math.abs(p[0][0] - p[1][0]), lod = hgt > 1e-9 ? { span: hgt, vertical: true } : { span: wid, vertical: false };
      if (hgt < 1e-9) out.push({ x: mx, y: my - off, text: op, rot: 0, h: "center", v: "bottom", kind: "V", ...lod });
      else out.push({ x: mx + off * 1.2, y: my, text: op, rot: 0, h: "left", v: "center", kind: "V", ...lod });
    }
  }
  if (showI && sch && sch._) {
    for (const it of doc.items.values()) {
      if (it.kind !== "symbol") continue;
      const ref = prop(it.node, "Reference");
      const ex = K.kid(it.node, "exclude_from_sim");
      if (!ref || ref.startsWith("#") || (ex && K.str(ex[1]) === "yes")) continue;
      let pins: PinGeom[] = [];
      try { pins = sch._.symbolPins(E.kdoc, it); } catch { continue; }
      const put = (pin: PinGeom, op: string): void => {
        if (!op || op === "--" || op === "?" || !(pin.len > textSize)) return;
        const dx = Math.sign(pin.x - pin.root[0]), dy = Math.sign(pin.y - pin.root[1]);
        const mx = (pin.root[0] + pin.x) / 2, my = (pin.root[1] + pin.y) / 2;
        if (dx === 0) out.push({ x: mx + off * 1.2, y: my, text: op, rot: 0, h: "left", v: "center", kind: "I" });
        else out.push({ x: mx, y: my - off * 1.2, text: op, rot: 90, h: "left", v: "center", kind: "I" });
      };
      if (pins.length === 2) { put(pins[0], operatingPoint(ref, f.iPrec, f.iRange)); continue; }
      // the model's pins (SIM_MODEL::GetPins, mapped by Sim.Pins or by default), the item as ItemName names it
      const item = simItems.get(ref); if (!item) continue;
      for (const mp of item.pins) {
        const pin = pins.find((p) => p.number === mp.symbolPin); if (!pin) continue;
        put(pin, operatingPoint(`${item.name}:${mp.modelPin}`, f.iPrec, f.iRange));
      }
    }
  }
  return out;
}

function draw(ctx: CanvasRenderingContext2D): void {
  if (!points.size || !isSch()) return;
  const K = (window as unknown as { KiCadCanvas?: KApi }).KiCadCanvas; if (!K || !K.drawStrokeText) return;
  const m = ctx.getTransform(), s = Math.abs(m.a) || 1;
  // getOperatingPointTextSize: (50 mils + 2 × 7 screen pixels) / 3
  const size = (1.27 + 2 * (7 * (window.devicePixelRatio || 1)) / s) / 3;
  const texts = operatingPointTexts(size); if (!texts.length) return;
  const dark = backgroundDark(K.SCH.bg || "#FFFFFF");
  const ex = schExtraColors(K.schTheme ? K.schTheme() : "default");
  const colV = dark ? "#E46FA0" : ex.opVoltage, colI = dark ? "#FF6060" : ex.opCurrent;
  const pen = size / 6;   // GetPenSizeForDemiBold (common/gr_text.cpp: size / 6)
  const base = [m.a, 0, 0, m.d, m.e, m.f];
  // SCH_LINE::ViewGetLOD( LAYER_OP_VOLTAGES ): a voltage shows once its wire is 5 mm high (a horizontal one 15 mm
  // wide) on screen, at the canvas' 91 px per inch
  const pxPerMm = s / (window.devicePixelRatio || 1), MM = 91 / 25.4;
  ctx.save();
  for (const t of texts) {
    if (t.kind === "V" && t.span !== undefined && t.span * pxPerMm < (t.vertical ? 5 : 15) * MM) continue;
    const color = t.kind === "V" ? colV : colI;
    // knockoutText: the glyphs' box inflated by 2 x the stroke width filled in the layer colour, the glyphs cut out
    const w = K.textWidth ? K.textWidth(t.text, size, pen) : t.text.length * size * 0.8, mg = pen / 2 + 2 * pen;
    const x0 = t.h === "left" ? 0 : t.h === "right" ? -w : -w / 2, y0 = t.v === "top" ? 0 : t.v === "bottom" ? -size : -size / 2;
    ctx.save(); ctx.translate(t.x, t.y); if (t.rot) ctx.rotate(-t.rot * Math.PI / 180);
    ctx.fillStyle = color; ctx.fillRect(x0 - mg, y0 - mg, w + 2 * mg, size + 2 * mg); ctx.restore();
    ctx.save(); K.drawStrokeText(ctx, base, { x: t.x, y: t.y, text: t.text, size, rot: t.rot, h: t.h, v: t.v, pen }, K.SCH.bg || "#FFFFFF", 1 / s); ctx.restore();
  }
  ctx.restore();
}

function install(): void { if (installed) return; installed = true; overlayHooks.push(draw); }

// ---------------------------------------------------------------- ${OP} text variables
/** SCH_SYMBOL::ResolveTextVar's "OP(:pin)?(.([0-9])?([a-zA-Z]*))?" and SCH_LABEL_BASE's "OP(.([0-9])?([a-zA-Z]*))?". */
const OP_SYMBOL = /^OP(:[^.]*)?(.([0-9])?([a-zA-Z]*))?$/, OP_LABEL = /^OP(.([0-9])?([a-zA-Z]*))?$/;
interface PinRow { number: string; name: string }
/** ${OP}, ${OP:<pin>}, ${OP:power} (with an optional ".<precision><range>") on a symbol's fields, and ${OP} on a
 *  label (its net's voltage), from SCHEMATIC::GetOperatingPoint; null for any other token. */
export function opTextVar(kind: "symbol" | "label", item: KItem, token: string): string | null {
  const K = (window as unknown as { KiCadCanvas?: KApi }).KiCadCanvas; if (!K) return null;
  if (kind === "label") {
    const m = OP_LABEL.exec(token); if (!m) return null;
    const precision = m[2] ? Number(m[2]) : 3, range = m[3] || "~V";
    if (!points.size) return "--";
    const e = netsOfItems([item.id])[0];
    return e && e.name ? operatingPoint(e.name, precision, range) : "?";
  }
  const m = OP_SYMBOL.exec(token); if (!m) return null;
  const pin = (m[1] || "").toLowerCase(), precision = m[3] ? Number(m[3]) : 3;
  let range = m[4] || "~A";
  const p = K.kids(item.node, "property").find((q) => K.str(q[1]) === "Reference"), ref = p ? K.str(p[2]) : "";
  const sim = simItems.get(ref), spiceRef = (sim ? sim.name : ref).toLowerCase();
  if (!pin) return operatingPoint(spiceRef, precision, range);
  if (pin === ":power") { if (!m[4]) range = "~W"; return operatingPoint(spiceRef + ":power", precision, range); }
  if (!points.size) return "--";
  if (!sim) return null;
  const want = pin.slice(1);
  const sch = (window as unknown as { CollabTools?: { sch?: { _: { symbolPins(doc: unknown, it: KItem): PinRow[] } } } }).CollabTools?.sch;
  let rows: PinRow[] = [];
  try { rows = sch && sch._ ? sch._.symbolPins(E.kdoc, item) : []; } catch { rows = []; }
  for (const mp of sim.pins) {
    const sp = rows.find((r) => r.number === mp.symbolPin); if (!sp) continue;
    if (want === String(sp.name || "").toLowerCase() || want === sp.number.toLowerCase())
      return sim.pins.length === 2 ? operatingPoint(spiceRef, precision, range) : operatingPoint(`${spiceRef}:${mp.modelPin}`, precision, range);
  }
  return null;
}
/** RefreshOperatingPointDisplay's first pass: the items whose text holds a variable are laid out again. */
function refreshTextVars(): void {
  const K = (window as unknown as { KiCadCanvas?: { refreshOpTextVars?(doc: unknown): void } }).KiCadCanvas;
  if (K && K.refreshOpTextVars && E.kdoc && isSch()) { try { K.refreshOpTextVars(E.kdoc); (E as unknown as { renderFull?: boolean }).renderFull = true; } catch { /* the overlay still draws */ } }
}
/** The canvas asks this module for ${OP} tokens from the start: before any OP run they read "--". */
(function hookTextVars(): void {
  if (typeof window === "undefined") return;
  const K = (window as unknown as { KiCadCanvas?: { setOpTextVar?(fn: typeof opTextVar | null): void } }).KiCadCanvas;
  if (K && K.setOpTextVar) K.setOpTextVar(opTextVar);
})();
