// calculator/index.ts — Tools > Calculator Tools (PCB_CALCULATOR_FRAME): KiCad's tree of calculators in a modeless
// window.  The pages here are the ones that work from typed numbers alone: Power, current and isolation (Via Size,
// Track Width, Fusing Current), High Speed (Wavelength) and Memo (E-Series, Color Code, Board Classes).  The formulas
// are calculator/model.ts; every value is shown as KiCad's "%g".
import { KD, h, select, textInput } from "../dialogs/dom";
import {
  BOARD_CLASSES, BOARD_CLASS_ROWS, COLOR_CODE, COPPER_RESISTIVITY, FREQ_UNITS, LEN_UNITS, THICKNESS_UNITS, eSeries, fmtG, fusingCurrent, resistorBands,
  trackCurrentFromWidth, trackElectrical, trackWidthFromCurrent, viaSize, wavelength, type ESeries, type FuseSolve,
} from "./model";

/** DoubleFromString: a typed number ("," taken as the decimal point), NaN when it is none */
const num = (s: string): number => { const t = s.trim().replace(",", "."); return t === "" ? NaN : Number(t); };
const lbl = (t: string, title?: string): HTMLElement => h("label", { style: "color:var(--ink-2);white-space:nowrap", title }, t);
const out = (id: string): HTMLElement => h("span", { id, class: "calc-out", style: "font-variant-numeric:tabular-nums;min-width:90px;display:inline-block" });
const unitText = (t: string): HTMLElement => h("span", { class: "ro", style: "white-space:nowrap" }, t);
const rows = (...r: Node[][]): HTMLElement => h("div", { style: "display:grid;grid-template-columns:max-content minmax(90px,140px) max-content;gap:6px 10px;align-items:center" }, ...r.flat());
/** A text field with a unit choice (UNIT_SELECTOR): value() is in SI units. */
function unitField(id: string, init: string, units: [string, number][], unitIdx: number, onChange: () => void): { input: HTMLInputElement; unit: HTMLSelectElement; value(): number; set(si: number): void; scale(): number; reset(v: string, u: number): void } {
  const input = textInput(init, () => onChange(), { id, style: "width:100%" });
  input.addEventListener("input", () => onChange());
  const unit = select(units.map(([l], i) => [String(i), l] as [string, string]), String(unitIdx), () => onChange(), { id: id + "-unit", style: "width:90px" });
  const scale = (): number => units[+unit.value]?.[1] ?? 1;
  return { input, unit, scale, value: () => num(input.value) * scale(), set(si) { input.value = isFinite(si) ? fmtG(si / scale()) : ""; }, reset(v, u) { input.value = v; unit.value = String(u); } };
}
function resetButton(fn: () => void): HTMLElement { const b = h("button", { type: "button", class: "btn", style: "margin-top:10px" }, "Reset to Defaults"); b.addEventListener("click", fn); return b; }

// PANEL_TRACK_WIDTH: the field typed in drives the others (current -> both widths, a width -> current -> the other width)
function trackWidthPage(pg: HTMLElement): void {
  let driver: "current" | "ext" | "int" = "current";
  const calc = (): void => {
    const dT = Math.abs(num(dTin.value)), len = Math.abs(lenF.value()), rho = Math.abs(num(rhoIn.value));
    const eth = Math.abs(extTh.value()), ith = Math.abs(intTh.value());
    let I = Math.abs(num(cur.value)), ew: number, iw: number;
    if (driver === "ext") { ew = Math.abs(extW.value()); I = trackCurrentFromWidth(ew, eth, dT, false); iw = trackWidthFromCurrent(I, ith, dT, true); cur.value = fmtG(I); intW.set(iw); }
    else if (driver === "int") { iw = Math.abs(intW.value()); I = trackCurrentFromWidth(iw, ith, dT, true); ew = trackWidthFromCurrent(I, eth, dT, false); cur.value = fmtG(I); extW.set(ew); }
    else { ew = trackWidthFromCurrent(I, eth, dT, false); iw = trackWidthFromCurrent(I, ith, dT, true); extW.set(ew); intW.set(iw); }
    for (const [pre, w, th, f] of [["ext", ew, eth, extW], ["int", iw, ith, intW]] as const) {
      const r = trackElectrical(I, w, th, len, rho), s = f.scale();
      outs[pre].area.textContent = fmtG(r.area / (s * s)); outs[pre].areaU.textContent = (LEN_UNITS[+f.unit.value]?.[0] || "mm") + "²";
      outs[pre].res.textContent = fmtG(r.resistance); outs[pre].v.textContent = fmtG(r.vdrop); outs[pre].p.textContent = fmtG(r.loss);
    }
    for (const [k, el] of [["current", cur], ["ext", extW.input], ["int", intW.input]] as const) el.style.fontWeight = driver === k ? "600" : "";
  };
  const cur = textInput("1", () => { driver = "current"; calc(); }, { id: "calc-tw-current", style: "width:100%" });
  cur.addEventListener("input", () => { driver = "current"; calc(); });
  const dTin = textInput("10", calc, { id: "calc-tw-dt", style: "width:100%" }); dTin.addEventListener("input", calc);
  const lenF = unitField("calc-tw-len", "20", LEN_UNITS, 0, calc);
  const rhoIn = textInput(String(COPPER_RESISTIVITY), calc, { id: "calc-tw-rho", style: "width:100%" }); rhoIn.addEventListener("input", calc);
  const extW = unitField("calc-tw-extw", "0.2", LEN_UNITS, 0, () => { driver = "ext"; calc(); }), extTh = unitField("calc-tw-extth", "35", THICKNESS_UNITS, 1, calc);
  const intW = unitField("calc-tw-intw", "0.2", LEN_UNITS, 0, () => { driver = "int"; calc(); }), intTh = unitField("calc-tw-intth", "35", THICKNESS_UNITS, 1, calc);
  const mk = (pre: string) => ({ area: out(`calc-tw-${pre}-area`), areaU: unitText("mm²"), res: out(`calc-tw-${pre}-res`), v: out(`calc-tw-${pre}-v`), p: out(`calc-tw-${pre}-p`) });
  const outs = { ext: mk("ext"), int: mk("int") };
  const P = KD().staticBox(pg, "Parameters");
  P.append(rows([lbl("Current (I):"), cur, unitText("A")], [lbl("Temperature rise (ΔT):"), dTin, unitText("°C")], [lbl("Conductor length:"), lenF.input, lenF.unit], [lbl("Copper resistivity:"), rhoIn, unitText("Ω⋅m")]));
  const side = (title: string, pre: "ext" | "int", w: typeof extW, th: typeof extTh): void => {
    const o = outs[pre], B = KD().staticBox(pg, title);
    B.append(rows([lbl("Track width (W):"), w.input, w.unit], [lbl("Track thickness (H):"), th.input, th.unit], [lbl("Cross-section area:"), o.area, o.areaU],
      [lbl("Resistance:"), o.res, unitText("Ω")], [lbl("Voltage drop:"), o.v, unitText("V")], [lbl("Power loss:"), o.p, unitText("W")]));
  };
  side("External Layer Tracks", "ext", extW, extTh); side("Internal Layer Tracks", "int", intW, intTh);
  pg.append(h("p", { class: "kd-note", style: "margin:8px 0 0" }, "Widths follow the IPC-2152 based Brooks & Adam fit.  Type a current to size both tracks, or a width to find the current it carries."),
    resetButton(() => { driver = "current"; cur.value = "1"; dTin.value = "10"; lenF.reset("20", 0); rhoIn.value = String(COPPER_RESISTIVITY); extW.reset("0.2", 0); extTh.reset("35", 1); intW.reset("0.2", 0); intTh.reset("35", 1); calc(); }));
  calc();
}

// PANEL_VIA_SIZE
function viaSizePage(pg: HTMLElement): void {
  const f = {
    hole: unitField("calc-via-hole", "0.4", LEN_UNITS, 0, () => calc()), plating: unitField("calc-via-plating", "0.035", THICKNESS_UNITS, 0, () => calc()),
    length: unitField("calc-via-length", "1.6", LEN_UNITS, 0, () => calc()), pad: unitField("calc-via-pad", "0.6", LEN_UNITS, 0, () => calc()),
    clearance: unitField("calc-via-clearance", "1", LEN_UNITS, 0, () => calc()),
  };
  const t = (id: string, v: string): HTMLInputElement => { const i = textInput(v, () => calc(), { id, style: "width:100%" }); i.addEventListener("input", () => calc()); return i; };
  const z0 = t("calc-via-z0", "50"), I = t("calc-via-current", "1"), rho = t("calc-via-rho", "1.72e-08"), er = t("calc-via-er", "4.5"), dT = t("calc-via-dt", "10"), rise = t("calc-via-rise", "1");
  const o = { res: out("calc-via-res"), v: out("calc-via-v"), p: out("calc-via-p"), th: out("calc-via-th"), amp: out("calc-via-amp"), cap: out("calc-via-cap"), deg: out("calc-via-deg"), ind: out("calc-via-ind"), x: out("calc-via-x") };
  const warn = h("p", { id: "calc-via-warn", style: "color:var(--err);white-space:pre-line;margin:6px 0", hidden: true }, "Warning:\nVia pad diameter >= Clearance hole diameter.\nSome parameters cannot be calculated for a via inside a copper zone.");
  function calc(): void {
    const r = viaSize({ hole: Math.abs(f.hole.value()), plating: Math.abs(f.plating.value()), length: Math.abs(f.length.value()), pad: Math.abs(f.pad.value()), clearance: Math.abs(f.clearance.value()),
      z0: Math.abs(num(z0.value)), current: Math.abs(num(I.value)), rho: Math.abs(num(rho.value)), er: Math.abs(num(er.value)), deltaT: Math.abs(num(dT.value)), riseTime: Math.abs(num(rise.value)) });
    warn.hidden = !r.padTooBig;
    o.res.textContent = fmtG(r.resistance); o.v.textContent = fmtG(r.vdrop); o.p.textContent = fmtG(r.loss); o.th.textContent = fmtG(r.thermalResistance); o.amp.textContent = fmtG(r.ampacity);
    o.cap.textContent = r.padTooBig ? "" : fmtG(r.capacitance); o.deg.textContent = r.padTooBig ? "" : fmtG(r.riseTimeDegradation); o.ind.textContent = fmtG(r.inductance); o.x.textContent = fmtG(r.reactance);
  }
  const cols = h("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px" }), L = h("div"), R = h("div"); cols.append(L, R); pg.append(cols);
  KD().staticBox(L, "Parameters").append(rows(
    [lbl("Finished hole diameter (D):"), f.hole.input, f.hole.unit], [lbl("Plating thickness (T):"), f.plating.input, f.plating.unit],
    [lbl("Via length:", "Via length is the board thickness for through hole vias"), f.length.input, f.length.unit],
    [lbl("Via pad diameter:", "Diameter of pad surrounding via (annular ring)"), f.pad.input, f.pad.unit],
    [lbl("Clearance hole diameter:", "Diameter of clearance hole in ground plane(s)"), f.clearance.input, f.clearance.unit],
    [lbl("Z0:", "Characteristic impedance of conductor"), z0, unitText("Ω")], [lbl("Applied current:"), I, unitText("A")],
    [lbl("Plating resistivity:", "Specific resistance in ohms * meters"), rho, unitText("Ω⋅m")], [lbl("Substrate relative permittivity:", "Relative dielectric constant (epsilon r)"), er, h("span")],
    [lbl("Temperature rise:", "Maximum acceptable rise in temperature"), dT, unitText("°C")], [lbl("Pulse rise time:", "Pulse rise time to calculate reactance"), rise, unitText("ns")]), warn);
  KD().staticBox(R, "Results").append(rows(
    [lbl("Resistance:"), o.res, unitText("Ω")], [lbl("Voltage drop:"), o.v, unitText("V")], [lbl("Power loss:"), o.p, unitText("W")],
    [lbl("Thermal resistance:", "Using thermal conductivity value 401 Watts/(meter-Kelvin)"), o.th, unitText("°C/W")], [lbl("Estimated ampacity:", "Based on temperature rise"), o.amp, unitText("A")],
    [lbl("Capacitance:"), o.cap, unitText("pF")], [lbl("Rise time degradation:"), o.deg, unitText("ps")], [lbl("Inductance:"), o.ind, unitText("nH")], [lbl("Reactance:"), o.x, unitText("Ω")]));
  R.append(resetButton(() => { f.hole.reset("0.4", 0); f.plating.reset("0.035", 0); f.length.reset("1.6", 0); f.pad.reset("0.6", 0); f.clearance.reset("1", 0);
    z0.value = "50"; I.value = "1"; rho.value = "1.72e-08"; er.value = "4.5"; dT.value = "10"; rise.value = "1"; calc(); }));
  calc();
}

// PANEL_FUSING_CURRENT: a radio picks the value to compute, Calculate computes it ("Error" when the inputs are not valid)
function fusingPage(pg: HTMLElement): void {
  let solve: FuseSolve = "current";
  const t = (id: string, v: string): HTMLInputElement => textInput(v, undefined, { id, style: "width:100%" });
  const amb = t("calc-fuse-ambient", "25"), melt = t("calc-fuse-melting", "1084");
  const W = unitField("calc-fuse-width", "0.100000", LEN_UNITS, 0, () => {}), T = unitField("calc-fuse-thickness", "0.035000", LEN_UNITS, 0, () => {});
  const I = t("calc-fuse-current", "10.000000"), time = t("calc-fuse-time", "0.010000");
  const note = h("p", { id: "calc-fuse-note", class: "kd-note", style: "margin:6px 0" });
  const radio = (k: FuseSolve): HTMLInputElement => { const r = h("input", { type: "radio", name: "calc-fuse-solve", id: `calc-fuse-solve-${k}`, title: "Calculate this value" }) as HTMLInputElement; r.checked = k === solve; r.addEventListener("change", () => { if (r.checked) solve = k; }); return r; };
  const grid = h("div", { style: "display:grid;grid-template-columns:max-content minmax(90px,140px) max-content max-content;gap:6px 10px;align-items:center" },
    lbl("Ambient temperature:"), amb, unitText("°C"), h("span"), lbl("Melting point:"), melt, unitText("°C"), h("span"),
    lbl("Track width:"), W.input, W.unit, radio("width"), lbl("Track thickness:"), T.input, T.unit, radio("thickness"),
    lbl("Current:"), I, unitText("A"), radio("current"), lbl("Time to fuse:"), time, unitText("s"), radio("time"));
  const go = h("button", { type: "button", class: "btn primary", id: "calc-fuse-calc", style: "margin-top:10px" }, "Calculate");
  go.addEventListener("click", () => {
    const r = fusingCurrent({ ambient: num(amb.value), melting: num(melt.value), width: W.value(), thickness: T.value(), current: num(I.value), time: num(time.value) }, solve);
    const txt = isFinite(r.value) ? r.value.toFixed(6) : "Error";
    if (solve === "width") W.input.value = isFinite(r.value) ? (r.value / W.scale()).toFixed(6) : "Error";
    else if (solve === "thickness") T.input.value = isFinite(r.value) ? (r.value / T.scale()).toFixed(6) : "Error";
    else if (solve === "current") I.value = txt; else time.value = txt;
    note.textContent = r.longTime ? "Current calculation is underestimated due to long fusing time." : "";
  });
  pg.append(grid, go, note);
  KD().staticBox(pg, "Help").append(h("p", { class: "kd-note", style: "margin:0;white-space:pre-line" },
    "Estimates the current that melts a copper track in a given time, assuming all the heat stays in the track (an adiabatic process).  It is only valid for short fusing times, a few seconds at most; longer times are flagged.\nThe melting point of copper is 1084 °C."));
}

// PANEL_WAVELENGTH: any one of frequency, period or the wavelengths sets the others
function wavelengthPage(pg: HTMLElement): void {
  let f = 1e9;
  const F = unitField("calc-wl-freq", "1", FREQ_UNITS, 0, () => { const v = F.value(); if (v > 0) { f = v; show("freq"); } });
  const per = textInput("", () => { const v = num(per.value) * 1e-9; if (v > 0) { f = 1 / v; show("period"); } }, { id: "calc-wl-period", style: "width:100%" });
  const vac = unitField("calc-wl-vacuum", "", LEN_UNITS, 0, () => { const v = vac.value(); if (v > 0) { f = 299792458 / v; show("vacuum"); } });
  const med = unitField("calc-wl-medium", "", LEN_UNITS, 0, () => { const v = med.value(); if (v > 0) { f = 299792458 / v / Math.sqrt(num(er.value) * num(mur.value)); show("medium"); } });
  const speed = out("calc-wl-speed");
  const er = textInput("1", () => show(""), { id: "calc-wl-er", style: "width:100%" }), mur = textInput("1", () => show(""), { id: "calc-wl-mur", style: "width:100%" });
  function show(from: string): void {
    const r = wavelength(f, num(er.value) || 1, num(mur.value) || 1);
    if (from !== "freq") F.set(f); if (from !== "period") per.value = fmtG(r.period * 1e9);
    if (from !== "vacuum") vac.set(r.vacuum); if (from !== "medium") med.set(r.medium);
    speed.textContent = fmtG(r.speed);
  }
  pg.append(rows([lbl("Frequency:"), F.input, F.unit], [lbl("Period:"), per, unitText("ns")], [lbl("Wavelength in vacuum:"), vac.input, vac.unit], [lbl("Wavelength in medium:"), med.input, med.unit],
    [lbl("Speed in medium:"), speed, unitText("m/s")], [lbl("er:", "relative permittivity (dielectric constant)"), er, h("span")], [lbl("mur:", "relative permeability"), mur, h("span")]));
  show("");
}

// PANEL_ESERIES_DISPLAY: the decade of each series, side by side
function eSeriesPage(pg: HTMLElement): void {
  const table = (series: ESeries[], id: string): HTMLElement => {
    const vals = series.map((s) => eSeries(s)), n = Math.max(...vals.map((v) => v.length));
    const t = h("table", { id, class: "calc-eseries", style: "border-collapse:collapse;font-variant-numeric:tabular-nums" });
    t.append(h("tr", null, ...series.map((s) => h("th", { style: "padding:2px 10px;border-bottom:1px solid var(--line)" }, `E${s}`))));
    for (let i = 0; i < n; i++) {
      t.append(h("tr", null, ...vals.map((v) => { const step = n / v.length; return h("td", { style: "padding:1px 10px;text-align:right" }, i % step === 0 ? (v[i / step] / 100).toFixed(2) : ""); })));
    }
    return t;
  };
  const cols = h("div", { style: "display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap" }); pg.append(cols);
  KD().staticBox(cols, "E1,E3,E6,E12").append(table([1, 3, 6, 12], "calc-e12"));
  KD().staticBox(cols, "E24,E48,E96").append(table([24, 48, 96], "calc-e96"));
}

// PANEL_COLOR_CODE: the chart, and the bands of a value
function colorCodePage(pg: HTMLElement): void {
  let three = false;
  const t = h("table", { id: "calc-colorcode", style: "border-collapse:collapse" });
  const head = h("tr"); t.append(head);
  const draw = (): void => {
    head.replaceChildren(...["Color", "1st Band", "2nd Band", ...(three ? ["3rd Band"] : []), "Multiplier", "Tolerance"].map((c) => h("th", { style: "padding:2px 10px;border-bottom:1px solid var(--line);text-align:left" }, c)));
    while (t.rows.length > 1) t.deleteRow(1);
    for (const c of COLOR_CODE) {
      const cell = (v: string | number | null): HTMLElement => h("td", { style: "padding:1px 10px;text-align:center" }, v === null ? "" : String(v));
      t.append(h("tr", null, h("td", { style: "padding:1px 10px" }, h("span", { style: `display:inline-block;width:28px;height:12px;border:1px solid var(--ink-3);vertical-align:middle;margin-right:6px;background:${c.css}` }), c.name),
        cell(c.digit === 0 ? null : c.digit), cell(c.digit), ...(three ? [cell(c.digit)] : []), cell(c.multiplier), cell(c.tolerance)));
    }
    bands();
  };
  const val = textInput("4.7k", () => bands(), { id: "calc-cc-value", style: "width:120px" }); val.addEventListener("input", () => bands());
  const shown = h("div", { id: "calc-cc-bands", style: "display:flex;gap:6px;align-items:center;margin-top:6px;min-height:24px" });
  function bands(): void {
    const m = /^\s*([\d.]+)\s*([RrKkMm]?)\s*$/.exec(val.value), mult = m ? ({ "": 1, r: 1, k: 1e3, m: 1e6 } as Record<string, number>)[m[2].toLowerCase()] : 0;
    const b = m ? resistorBands(+m[1] * mult, three ? 3 : 2) : null;
    shown.replaceChildren(...(b ? [...b, three ? "Brown" : "Gold"].map((n, i, a) => { const c = COLOR_CODE.find((x) => x.name === n)!; return h("span", { title: i === a.length - 1 ? `${n} (tolerance)` : n, style: `width:16px;height:36px;border:1px solid var(--ink-3);background:${c.css};${i === a.length - 1 ? "margin-left:10px" : ""}` }); }) : [h("span", { class: "ro" }, "Not a resistance that can be coded")]));
  }
  const tol = h("div", { style: "display:flex;flex-direction:column;gap:4px" }, ...[["10% / 5%", false], ["<= 2%", true]].map(([l, v]) => { const r = h("input", { type: "radio", name: "calc-cc-tol", id: `calc-cc-tol-${v ? "2" : "5"}` }) as HTMLInputElement; r.checked = three === v; r.addEventListener("change", () => { if (r.checked) { three = v as boolean; draw(); } }); return h("label", { class: "kd-row", style: "gap:6px" }, r, l as string); }));
  const cols = h("div", { style: "display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap" });
  const left = h("div"); KD().staticBox(left, "Tolerance").append(tol);
  KD().staticBox(left, "Value").append(h("div", { class: "kd-row", style: "gap:6px" }, val, unitText("Ω")), shown);
  cols.append(left, t); pg.append(cols); draw();
}

// PANEL_BOARD_CLASS: the minimum sizes of the six classes
function boardClassPage(pg: HTMLElement): void {
  const unit = select(LEN_UNITS.map(([l], i) => [String(i), l] as [string, string]), "0", () => fill(), { id: "calc-bc-unit", style: "width:90px" });
  const t = h("table", { id: "calc-boardclass", style: "border-collapse:collapse;font-variant-numeric:tabular-nums" });
  function fill(): void {
    const s = LEN_UNITS[+unit.value][1];
    t.replaceChildren(h("tr", null, h("th"), ...BOARD_CLASSES.map((_, i) => h("th", { style: "padding:2px 10px;border-bottom:1px solid var(--line)" }, `Class ${i + 1}`))),
      ...BOARD_CLASS_ROWS.map((name, r) => h("tr", null, h("th", { style: "padding:2px 10px;text-align:left;font-weight:500" }, name), ...BOARD_CLASSES.map((c) => h("td", { style: "padding:2px 10px;text-align:right" }, c[r] === null ? "--" : fmtG(c[r]! / s))))));
  }
  pg.append(h("div", { class: "kd-row", style: "gap:8px;margin-bottom:8px" }, lbl("Units:"), unit), t, h("p", { class: "kd-note", style: "margin:8px 0 0" }, "Note: Values are minimal values"));
  fill();
}

/** PCB_CALCULATOR_FRAME: one window, reopened on the page it was left on. */
let lastPage = "Track Width";
export function openCalculator(page?: string): void {
  let tb: { current(): string | null } | null = null;
  KD().open({ title: "Calculator Tools", width: 960, cls: "kd-wide kd-flush", modeless: true, persist: false, geomKey: "calculator",
    buttons: [{ label: "Close", close: true, primary: true, isDefault: true }],
    cancel() { if (tb) lastPage = tb.current() || lastPage; },
    build(body) {
      tb = KD().treebook(body, [
        { label: "Power, current and isolation", pages: [{ label: "Via Size", build: viaSizePage }, { label: "Track Width", build: trackWidthPage }, { label: "Fusing Current", build: fusingPage }] },
        { label: "High Speed", pages: [{ label: "Wavelength", build: wavelengthPage }] },
        { label: "Memo", pages: [{ label: "E-Series", build: eSeriesPage }, { label: "Color Code", build: colorCodePage }, { label: "Board Classes", build: boardClassPage }] },
      ], { selected: page || lastPage });
    } });
}
