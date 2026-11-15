// sim/op-overlay — the operating point on the schematic (SCHEMATIC::SetOperatingPoint, SCH_EDIT_FRAME::
// RefreshOperatingPointDisplay, UpdateOperatingPointVoltages and SCH_PAINTER's LAYER_OP_VOLTAGES / LAYER_OP_CURRENTS):
// after an .op run each net's voltage is written on its longest wire, a two-pin symbol's current on its first pin and a
// multi-pin symbol's model-pin currents on their pins, as knocked-out text (the text cut out of a box of the layer's colour).
import { E } from "../editor/state";
import { requestRender } from "../editor/view";
import { overlayHooks } from "../editor/overlays";
import { netsOfItems } from "../editor/schnets";
import { schExtraColors } from "../dialogs/color-themes";
import { convertToSpiceMarkup } from "./spice-netlist";
import { formatValue, type RawPlot } from "./sim-logic";

/** SCHEMATIC::m_operatingPoints: lower-case net names ("/out"), branch names ("r1") and model pins ("q1:c"). */
const points = new Map<string, number>();
let installed = false;

/** SIMULATOR_FRAME_UI::OnSimRefresh (ST_OP): every real vector of the .op plot, under the name SetOperatingPoint uses. */
export function setOperatingPoints(plot: RawPlot | null): void {
  points.clear();
  if (plot) for (const v of plot.vectors) {
    if (!v.re.length) continue;
    let n = v.name.toLowerCase();
    const vi = /^[vi]\((.*)\)$/.exec(n); if (vi) n = vi[1];
    n = n.replace(/#branch$/, "");
    points.set(n, v.re[0]);
  }
  install();
  requestRender();
}
export function clearOperatingPoints(): void { if (!points.size) return; points.clear(); requestRender(); }
export function operatingPoints(): ReadonlyMap<string, number> { return points; }

interface OpFormat { vPrec: number; vRange: string; iPrec: number; iRange: string }
/** Schematic Setup > Formatting > Operating-point overlay (SCHEMATIC_SETTINGS m_OPO_*). */
function opFormat(): OpFormat {
  let d: Record<string, unknown> = {};
  try { const j = E.proSettings ? JSON.parse(E.proSettings as string) : null; d = (j && j.schematic && j.schematic.drawing) || {}; } catch { d = {}; }
  const n = (k: string, def: number): number => { const v = Number(d[k]); return Number.isFinite(v) ? v : def; };
  const s = (k: string, def: string): string => (typeof d[k] === "string" && d[k] ? String(d[k]) : def);
  return { vPrec: n("operating_point_overlay_v_precision", 3), vRange: s("operating_point_overlay_v_range", "~V"), iPrec: n("operating_point_overlay_i_precision", 3), iRange: s("operating_point_overlay_i_range", "~A") };
}
/** SCHEMATIC::GetOperatingPoint: "" for ground, null when the name has no value. */
function opText(name: string, prec: number, range: string): string | null {
  const key = convertToSpiceMarkup(name).toLowerCase();
  if (key === "gnd" || key === "0") return "";
  const v = points.get(key); return v === undefined ? null : formatValue(v, { precision: prec, range });
}

type Pt = [number, number];
interface Label { text: string; at: Pt; vertical: boolean; h: "left" | "center"; v: "center" | "bottom"; current: boolean }
interface PinInfo { x: number; y: number; root: Pt; number: string; len: number }
interface Helpers { symbolPins(doc: KDoc, item: KItem): PinInfo[] }
const helpers = (): Helpers | null => { const m = CollabTools.sch as (SchToolModule & { _?: Helpers }) | undefined; return m && m._ ? m._ : null; };
const K = (): typeof KiCadCanvas & { drawStrokeText(ctx: CanvasRenderingContext2D, base: number[], t: Record<string, unknown>, color: string, minPen: number): void; strokeLineWidth(t: string): number; schTheme?: () => string; SCH?: Record<string, string> } =>
  KiCadCanvas as never;
const prop = (it: KItem, name: string): string => { const p = KiCadCanvas.kids(it.node, "property").find((x: SNode) => KiCadCanvas.str(x[1]) === name); return p ? KiCadCanvas.str(p[2]) : ""; };
const yes = (it: KItem, key: string): boolean => { const n = KiCadCanvas.kid(it.node, key); return !!n && KiCadCanvas.str(n[1]) === "yes"; };

function labels(doc: KDoc, f: OpFormat): Label[] {
  const out: Label[] = [];
  const wires: KItem[] = [];
  for (const it of doc.items.values()) if (it.kind === "wire") wires.push(it);
  // UpdateOperatingPointVoltages: the longest wire of each net on the sheet carries the net's voltage
  const nets = netsOfItems(wires.map((w) => w.id)), longest = new Map<string, { w: KItem; len: number; a: Pt; b: Pt }>();
  wires.forEach((w, i) => {
    const e = nets[i]; if (!e || e.bus || !e.name) return;
    const pts = KiCadCanvas.kid(w.node, "pts"); const xy = pts ? KiCadCanvas.kids(pts, "xy") : [];
    if (xy.length < 2) return;
    const a: Pt = [KiCadCanvas.num(xy[0][1]), KiCadCanvas.num(xy[0][2])], b: Pt = [KiCadCanvas.num(xy[1][1]), KiCadCanvas.num(xy[1][2])];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const cur = longest.get(e.name);
    if (len > 0 && (!cur || len > cur.len)) longest.set(e.name, { w, len, a, b });
  });
  for (const [name, { a, b }] of longest) {
    const t = opText(name, f.vPrec, f.vRange); if (!t) continue;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    out.push(a[1] === b[1] ? { text: t, at: mid, vertical: false, h: "center", v: "bottom", current: false } : { text: t, at: mid, vertical: false, h: "left", v: "center", current: false });
  }
  // RefreshOperatingPointDisplay: a two-pin symbol's current on its first pin, a model pin's on its symbol pin
  const hp = helpers(); if (!hp) return out;
  for (const it of doc.items.values()) {
    if (it.kind !== "symbol") continue;
    const ref = String(it.ref || prop(it, "Reference")); if (!ref || ref.startsWith("#") || yes(it, "exclude_from_sim") || yes(it, "dnp")) continue;
    const pins = hp.symbolPins(doc, it); const r = ref.toLowerCase();
    const put = (pin: PinInfo, v: string | null): void => { if (pin && v) out.push({ text: v, at: [(pin.x + pin.root[0]) / 2, (pin.y + pin.root[1]) / 2], vertical: pin.x !== pin.root[0], h: "left", v: "center", current: true, len: pin.len } as Label & { len: number }); };
    if (pins.length === 2) { put(pins[0], opText(r, f.iPrec, f.iRange)); continue; }
    // SPICE_GENERATOR::ItemName: the reference, or the device letter and the reference (X for a subcircuit)
    const simPins = prop(it, "Sim.Pins"); if (!simPins) continue;
    for (const pair of simPins.trim().split(/\s+/)) {
      const m = /^([^=]+)=(.+)$/.exec(pair); if (!m) continue;
      const pin = pins.find((p) => p.number === m[1]); if (!pin) continue;
      const model = m[2].toLowerCase();
      let v: string | null = null;
      for (const name of [r, "x" + r, ...[..."qmjdz"].map((c) => c + r)]) { v = opText(`${name}:${model}`, f.iPrec, f.iRange); if (v) break; }
      put(pin, v);
    }
  }
  return out;
}

/** SCH_PAINTER: the OP text, (docTextSize + 2 · 7 screen pixels) / 3, knocked out of a box of the layer's colour. */
function draw(ctx: CanvasRenderingContext2D): void {
  if (!points.size || !E.kdoc || (E.kdoc as KDoc).type !== "sch") return;
  const showV = E.renderOpts.showOpVoltages !== false, showI = E.renderOpts.showOpCurrents !== false;
  if (!showV && !showI) return;
  const k = K(), m = ctx.getTransform(), base = [m.a, m.b, m.c, m.d, m.e, m.f];
  const devPerMm = Math.hypot(m.a, m.b) || 1, dpr = window.devicePixelRatio || 1;
  const size = (1.27 + 2 * (7 * dpr / devPerMm)) / 3, pen = size / 6, off = size * 0.22, minPen = 1 / devPerMm;
  const theme = k.schTheme ? k.schTheme() : "default";
  const cols = schExtraColors(theme === "classic" ? "classic" : "default"), bg = (k.SCH && k.SCH.bg) || "#F5F4EF";
  for (const l of labels(E.kdoc as KDoc, opFormat())) {
    if (l.current ? !showI : !showV) continue;
    if (l.current && (l as Label & { len?: number }).len !== undefined && ((l as Label & { len: number }).len <= size)) continue;
    let [x, y] = l.at;
    if (l.current) { if (l.vertical) y -= off * 1.2; else x += off * 1.2; }
    else if (l.v === "bottom") y -= off; else x += off * 1.2;
    const w = k.strokeLineWidth(l.text) * size, grow = pen * 2;
    // the box in text space (x along the reading direction), then rotated for a vertical pin
    const x0 = l.h === "center" ? -w / 2 : 0, y0 = l.v === "bottom" ? -size : -size / 2;
    ctx.save();
    ctx.translate(x, y); if (l.vertical) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = l.current ? cols.opCurrent : cols.opVoltage;
    ctx.fillRect(x0 - grow, y0 - grow, w + 2 * grow, size + 2 * grow);
    ctx.restore();
    ctx.save();
    k.drawStrokeText(ctx, base, { x, y, text: l.text, size, rot: l.vertical ? 90 : 0, mirror: false, h: l.h, v: l.v, pen, italic: false, dy: 0 }, bg, minPen);
    ctx.restore();
  }
}
function install(): void { if (installed) return; installed = true; overlayHooks.push(draw); }
