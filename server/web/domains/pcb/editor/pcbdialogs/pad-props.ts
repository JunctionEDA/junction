// pcbdialogs/pad-props — Pad Properties (pcbnew/dialogs/dialog_pad_properties): the General, Connections and
// Clearance Overrides pages with the pad preview beside them, editing one pad of a footprint on the board.
//
// The dialog works on a copy of the footprint node and stores it as one MODIFIED change on OK, like every board
// item dialog.  Only what the user changed is written, and each child goes where PCB_IO_KICAD_SEXPR::format(PAD)
// puts it (PAD_ORDER below), in the writer's number format, so the desktop reads back exactly what it would have
// written itself.  The padstack mode (Normal, Front/Inner/Back, Custom) and its edit layer choose which copper
// layer's shape, size, offset, corners and primitives the shape controls edit (OnPadstackModeChanged /
// OnEditLayerChanged); the Backdrill page holds the hole post-machining and the backdrills.  Custom primitives are
// kept as stored.
import { box, checkField, form, h, coordField, lenField, messageBox, notebook, openDialog, selectField, staticBitmap, textField, unitLabel, unitName, fmtLen, parseLen, type Field } from "./ui";
import type { DlgShape, DlgType, PadLayerShape, PadModel, PadstackMode, PostMachining, padModel as PadModelApi } from "../../canvas/pad-model";
import { popupMenu } from "../../dialogs/dom";
import { openCalculator } from "../../calculator";
import { bitmapButton } from "../../../../shared/components/kicon-dom";
import { fitMenu } from "../../../../shared/menufit";
import { comboArrow } from "../../../../shared/components/kicon-dom";

const PM = (): typeof PadModelApi => (KiCadCanvas as unknown as { padModel: typeof PadModelApi }).padModel;
const K = (): KiCadCanvasApi => KiCadCanvas;
const kid = (n: SNode | null, key: string): SNode | null => (n ? (K().kid(n, key) as SNode | null) : null);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const norm180 = (a: number): number => { let r = a % 360; if (r > 180) r -= 360; if (r <= -180) r += 360; return Math.round(r * 1e6) / 1e6; };
const f6 = (v: number): string => PM().f6(v);

// ---------------------------------------------------------------- the preview (m_padPreviewGAL)
function drawPreview(cv: HTMLCanvasElement, m: PadModel, sketch: boolean, copper: string[]): void {
  const g = cv.getContext("2d"); if (!g) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 280, H = cv.clientHeight || 280;
  if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const KC = KiCadCanvas as unknown as { PCB_BG?: string; pcbColor?(l: string): string; boardColor?(k: string): string };
  const npth = KC.boardColor ? KC.boardColor("plated_hole") : "#1AC4D2", holeEdge = KC.boardColor ? KC.boardColor("via_hole") : "#E3B72E";
  const color = (l: string): string => (KC.pcbColor ? KC.pcbColor(l) : "#C83434");
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = KC.PCB_BG || "#001023"; g.fillRect(0, 0, W, H);
  const layers = PM().modelLayers(m, copper);
  const cuLayer = layers.has("F.Cu") ? "F.Cu" : layers.has("B.Cu") ? "B.Cu" : Array.from(layers).find((l) => /\.Cu$/.test(l)) || (m.tech["F.Paste"] ? "F.Paste" : m.tech["B.Paste"] ? "B.Paste" : "F.Cu");
  const hh = m.shape === "circle" ? m.w : m.h;
  const ext = Math.max(m.w, hh, m.hx + 2 * Math.abs(m.ox), (m.holeOblong ? m.hy : m.hx) + 2 * Math.abs(m.oy)) + 2 * Math.max(0, isNaN(m.clearance) ? 0 : m.clearance);
  const s = ext > 0 ? Math.min(W, H) * 0.7 / ext : 10;
  g.save(); g.translate(W / 2, H / 2);
  // axes through the pad's position, as KiCad's preview shows its origin
  g.strokeStyle = "rgba(255,255,255,0.35)"; g.lineWidth = 1; g.beginPath(); g.moveTo(-W / 2, 0); g.lineTo(W / 2, 0); g.moveTo(0, -H / 2); g.lineTo(0, H / 2); g.stroke();
  g.rotate(-m.angle * Math.PI / 180);
  const ox = m.offset ? m.ox * s : 0, oy = m.offset ? m.oy * s : 0;
  const path = (grow: number): void => {
    const w = m.w * s + 2 * grow, h2 = hh * s + 2 * grow; g.beginPath();
    if (m.shape === "circle" || m.shape === "custom_circle") { g.arc(ox, oy, w / 2, 0, Math.PI * 2); return; }
    if (m.shape === "oval") { const r = Math.min(w, h2) / 2; g.roundRect(ox - w / 2, oy - h2 / 2, w, h2, r); return; }
    if (m.shape === "trapezoid") { const d = m.delta * s / 2; const dx = m.deltaAxis === 1 ? d : 0, dy = m.deltaAxis === 0 ? d : 0;
      g.moveTo(ox - w / 2 - dx, oy + h2 / 2 + dy); g.lineTo(ox - w / 2 + dx, oy - h2 / 2 - dy); g.lineTo(ox + w / 2 - dx, oy - h2 / 2 + dy); g.lineTo(ox + w / 2 + dx, oy + h2 / 2 - dy); g.closePath(); return; }
    if (m.shape === "chamfer" || m.shape === "mixed") {
      const c = Math.min(w, h2) * m.cratio, r = m.shape === "mixed" ? Math.min(w, h2) * m.rratio : 0; const x0 = ox - w / 2, y0 = oy - h2 / 2, x1 = ox + w / 2, y1 = oy + h2 / 2;
      const [tl, tr, bl, br] = m.corners;
      g.moveTo(x0 + (tl ? c : r), y0); g.lineTo(x1 - (tr ? c : r), y0); if (tr) g.lineTo(x1, y0 + c); else g.arcTo(x1, y0, x1, y0 + r, r);
      g.lineTo(x1, y1 - (br ? c : r)); if (br) g.lineTo(x1 - c, y1); else g.arcTo(x1, y1, x1 - r, y1, r);
      g.lineTo(x0 + (bl ? c : r), y1); if (bl) g.lineTo(x0, y1 - c); else g.arcTo(x0, y1, x0, y1 - r, r);
      g.lineTo(x0, y0 + (tl ? c : r)); if (tl) g.lineTo(x0 + c, y0); else g.arcTo(x0, y0, x0 + r, y0, r); g.closePath(); return;
    }
    const r = m.shape === "roundrect" ? Math.min(w, h2) * m.rratio + (grow > 0 ? 0 : 0) : 0;
    g.roundRect(ox - w / 2, oy - h2 / 2, w, h2, Math.max(0, r));
  };
  if (!isNaN(m.clearance) && m.clearance > 0) { g.setLineDash([4, 3]); g.strokeStyle = "rgba(255,255,255,0.6)"; path(m.clearance * s); g.stroke(); g.setLineDash([]); }
  const hasCopper = Array.from(layers).some((l) => /\.Cu$/.test(l));
  if (hasCopper || m.type === "aperture") {
    g.fillStyle = color(cuLayer); g.strokeStyle = color(cuLayer); g.lineWidth = 1.5; path(0); if (sketch) g.stroke(); else g.fill();
  }
  if ((m.type === "pth" || m.type === "npth") && m.hx > 0) {
    const hw = m.hx * s, hh2 = (m.holeOblong ? m.hy : m.hx) * s; g.beginPath(); g.roundRect(-hw / 2, -hh2 / 2, hw, hh2, Math.min(hw, hh2) / 2);
    g.fillStyle = m.type === "npth" ? npth : KC.PCB_BG || "#001023"; g.strokeStyle = m.type === "npth" ? npth : holeEdge; g.lineWidth = 1.5;
    if (sketch) g.stroke(); else { g.fill(); if (m.type === "pth") g.stroke(); }
  }
  g.restore();
}

// ---------------------------------------------------------------- the dialog
interface NetHelpers { netNameOf(doc: KDoc, node: SNode): string; boardNetNames(doc: KDoc): string[]; netCodeOf(doc: KDoc, name: string): number }
const PH = (): NetHelpers => (CollabTools as unknown as { props: { helpers: NetHelpers } }).props.helpers;

/** DIALOG_PAD_PROPERTIES for pad `index` of a board footprint. */
// session storage (DIALOG_PAD_PROPERTIES::m_page / m_sketchPreview)
let lastPage = 0, sketchPreview = false;

/** PAD_TOOL's last pad number (SetLastPadNumber), the memory the pad placer and Duplicate and Increment count from. */
const padMemory = (): { lastNumber: string } | null => { const P = (window as unknown as { PcbTools?: { pad?: { padMemory?: { lastNumber: string } } } }).PcbTools; return (P && P.pad && P.pad.padMemory) || null; };

export function padPropertiesDialog(ctx: ToolCtx, fpItem: KItem, index: number): boolean {
  const doc = ctx.doc; if (!doc) return false;
  const item = doc.items.get(fpItem.id) || fpItem;
  const staged = (K().cloneNode as (n: SNode) => SNode)(item.node);
  const pads = K().kids(staged, "pad") as SNode[]; const pad = pads[index]; if (!pad) return false;
  const was = PM().readPad(doc, staged, pad, PH().netNameOf(doc, pad));
  const m: PadModel = structuredClone(was);   // NaN ("not set") must survive the copy
  const ro = !!ctx.viewOnly; const copper = doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"];
  const flipped = str((kid(staged, "layer") || [])[1]) === "B.Cu";
  let redraw = (): void => undefined, readAll = (): void => undefined, readDrills = (): void => undefined;
  const fieldOf = (name: string): string => str((K().kids(staged, "property") as SNode[]).find((p) => str(p[1]) === name)?.[2] || "");
  // the padstack's layers as the dialog edits them (F.Cu included), and the layer the shape controls show
  const stack: Record<string, PadLayerShape> = { "F.Cu": PM().layerShapeOf(m), ...m.psLayers };
  let editLayer = "F.Cu";
  openDialog({
    title: "Pad Properties", width: 1060, readOnly: ro,
    build(body) {
      // ---- General
      const general = h("div", { class: "pp-general" });
      const type = selectField<DlgType>(m.type, [["pth", "Through-hole"], ["smd", "SMD"], ["conn", "Edge Connector"], ["npth", "NPTH, Mechanical"], ["aperture", "SMD Aperture"], ["copper", "Copper Only"]], { ro, key: "padType", onChange: (v) => { m.type = v; onType(); } });
      const number = textField(m.number, { ro, key: "padNumber" });
      const netNames = PH().boardNetNames(doc).filter(Boolean); if (m.net && !netNames.includes(m.net)) netNames.unshift(m.net);
      const net = selectField<string>(m.net, [["", "<no net>"], ...netNames.map((n): [string, string] => [n, n])], { ro, key: "padNet", onChange: (v) => { m.net = v; } });
      const px = coordField(m.x, "x", { ro, key: "posX" }), py = coordField(m.y, "y", { ro, key: "posY" });
      const psModeSel = selectField<PadstackMode>(m.psMode, [["normal", "Normal"], ["fib", "Front/Inner/Back"], ["custom", "Custom"]], { ro, key: "padstackMode", onChange: (v) => onPadstackMode(v) });
      const editLayerSel = h("k-select", { disabled: ro, "data-k": "editLayer" }) as HTMLSelectElement;
      const shape = selectField<DlgShape>(m.shape, [["circle", "Circular"], ["oval", "Oval"], ["rect", "Rectangular"], ["trapezoid", "Trapezoidal"], ["roundrect", "Rounded rectangle"], ["chamfer", "Chamfered rectangle"],
        ["mixed", "Chamfered with other corners rounded"], ["custom_circle", "Custom (circular base)"], ["custom_rect", "Custom (rectangular base)"]], { ro, key: "padShape", onChange: (v) => {
        // onPadShapeSelection( true ): a circle's default spoke angle is 45°, the others' 90°
        const wasCircle = m.shape === "circle"; m.shape = v; readAll();
        if (v === "circle" && !wasCircle && m.spokeAngle === 90) { m.spokeAngle = 45; spokeAngle.value = "45"; }
        else if (v !== "circle" && wasCircle && m.spokeAngle === 45) { m.spokeAngle = 90; spokeAngle.value = "90"; }
        onShape(); } });
      // the shape's own properties (m_shapePropsBook)
      const delta = lenField(m.delta, { ro, key: "trapDelta" }), axis = selectField<number>(m.deltaAxis, [[0, "Horizontal"], [1, "Vertical"]], { ro, key: "trapAxis" });
      const pct = (v: number): string => f6(v * 100);
      const ratio = h("input", { type: "text", value: pct(m.rratio), disabled: ro, "data-k": "cornerRatio", title: "Corner radius in percent  of the pad width.\nThe width is the smaller value between size X and size Y.\nThe max value is 50 percent." });
      const radius = lenField(m.rratio * Math.min(m.w, m.h), { ro, key: "cornerRadius" });
      const cratio = h("input", { type: "text", value: pct(m.cratio), disabled: ro, "data-k": "chamferRatio", title: "Chamfer size in percent of the pad width.\nThe width is the smaller value between size X and size Y.\nThe max value is 50 percent." });
      const corner = ["Top left", "Top right", "Bottom left", "Bottom right"].map((l, i) => checkField(m.corners[i], l, { ro, key: "chamfer" + i, onChange: (v) => { m.corners[i] = v; redraw(); } }));
      const shapeProps = h("div", { class: "pp-shapeprops" });
      const trapRows = form([["Trapezoid delta:", delta.el, unitLabel()], ["Trapezoid axis:", axis.el]]);
      const roundRows = form([["Corner size:", ratio, unitLabel("%")], ["Corner radius:", radius.el, unitLabel()]]);
      const chamferRows = form([["Chamfer size:", cratio, unitLabel("%")], ["Chamfer corners:", h("div", { class: "pp-corners" }, ...corner.map((c) => c.el))]]);
      shapeProps.append(trapRows, chamferRows, roundRows);
      const sx = lenField(m.w, { ro, key: "sizeX" }), sy = lenField(m.h, { ro, key: "sizeY" });
      // m_cb_padrotation: an editable combo box with the 0 / 90 / -90 / 180 presets
      const angle = h("input", { type: "text", value: f6(m.angle), disabled: ro, "data-k": "angle", style: "width:100px" });
      const angles = h("button", { type: "button", class: "btn pp-combo", disabled: ro, "data-k": "anglePresets", title: "Preset angles" }, comboArrow());
      angles.addEventListener("click", () => {
        const r = angle.getBoundingClientRect();
        const menu = popupMenu(r.left, r.bottom, ["0", "90", "-90", "180"].map((a) => ({ label: a, run: () => { angle.value = a; angle.dispatchEvent(new Event("change", { bubbles: true })); } })));
        menu.style.minWidth = Math.round(r.width + angles.getBoundingClientRect().width) + "px";
        fitMenu(menu, { below: r, gap: 0 });
      });
      // m_offsetShapeOpt: the offset controls are shown only while it is ticked (OnPadShapeSelection)
      const offOn = checkField(m.offset, "Offset shape from hole", { ro, key: "offset", onChange: (v) => { m.offset = v; offRow.style.display = v ? "" : "none"; redraw(); } });
      const offX = lenField(m.ox, { ro, key: "offsetX" }), offY = lenField(m.oy, { ro, key: "offsetY" });
      const holeShape = selectField<number>(m.holeOblong ? 1 : 0, [[0, "Round"], [1, "Oblong"]], { ro, key: "holeShape", onChange: (v) => onDrillShape(v) });
      const holeX = lenField(m.hx, { ro, key: "holeX" }), holeY = lenField(m.holeOblong ? m.hy : m.hx, { ro: ro || !m.holeOblong, key: "holeY" });
      // OnUpdateUI: m_padToDie / m_padToDieDelay shown only while their box is ticked
      const dieOn = checkField(m.dieOn, "Specify pad to die length", { ro, key: "dieOn", onChange: (v) => { m.dieOn = v; syncDie(); } });
      const die = lenField(m.die, { ro, key: "dieLength" });
      const delayOn = checkField(m.dieDelayOn, "Specify pad to die delay", { ro, key: "dieDelayOn", onChange: (v) => { m.dieDelayOn = v; syncDie(); } });
      const delay = h("input", { type: "text", value: f6(m.dieDelay), disabled: ro, "data-k": "dieDelay", style: "width:110px" });
      const dieUnit = unitLabel(), delayUnit = unitLabel("ps");
      const syncDie = (): void => { for (const e of [die.el, dieUnit]) e.style.visibility = m.dieOn ? "" : "hidden"; for (const e of [delay, delayUnit]) e.style.visibility = m.dieDelayOn ? "" : "hidden"; };
      const xy = (a: Field<number>, b: Field<number>): HTMLElement => h("span", { class: "pd-xy" }, a.el, h("span", { class: "unit" }, unitName()), h("label", null, "Y:"), b.el);
      // m_padstackControls: for through-hole pads only (PadTypeSelected)
      const padstackRows = h("div", null, form([["Padstack mode:", psModeSel.el], ["Edit layer:", editLayerSel]], true), h("hr", { class: "pp-hr" }));
      const offRow = form([["X:", xy(offX, offY), unitLabel()]], true);
      // m_gbSizerHole / m_staticline71: shown for a pad type with a hole
      // updateHoleControls / updatePadSizeControls: a round hole or a circular pad has one "Diameter:", Y hidden
      const holeXLabel = h("label", null, "Hole size X:"), sizeXLabel = h("label", null, "Pad size X:");
      const xyFor = (a: Field<number>, b: Field<number>): { el: HTMLElement; y: HTMLElement } => { const y = h("span", { class: "pd-xy" }, h("label", null, "Y:"), b.el, h("span", { class: "unit" }, unitName())); return { el: h("span", { class: "pd-xy" }, a.el, h("span", { class: "unit" }, unitName()), y), y }; };
      const holeXY = xyFor(holeX, holeY), sizeXY = xyFor(sx, sy);
      // m_launchCalculatorBtn: OnHoleSizeCalculator shows the calculator's "pth_size" page
      const calcBtn = bitmapButton("calculator", "Show hole size calculator", () => openCalculator("pth_size"), { key: "holeSizeCalculator" });
      const holeRows = h("div", null, form([["Hole shape:", holeShape.el], [holeXLabel, h("span", { class: "pd-xy" }, holeXY.el, calcBtn), h("span")]], true), h("hr", { class: "pp-hr" }));
      const left = h("div", { class: "pp-col" },
        form([["Pad type:", type.el], ["Pad number:", number.el], ["Net name:", net.el], ["Position X:", xy(px, py), unitLabel()]], true),
        h("hr", { class: "pp-hr" }),
        padstackRows,
        form([["Pad shape:", shape.el]], true), shapeProps,
        form([[sizeXLabel, sizeXY.el, h("span")], ["Angle:", h("span", { class: "pp-anglebox" }, angle, angles), unitLabel("deg")]], true),
        h("div", { class: "pp-row" }, offOn.el), offRow,
        h("hr", { class: "pp-hr" }),
        holeRows,
        h("div", { class: "pp-row" }, dieOn.el, die.el, dieUnit),
        h("div", { class: "pp-row" }, delayOn.el, delay, delayUnit));
      offRow.style.display = m.offset ? "" : "none"; syncDie();
      // layers (the middle column)
      const copperSel = h("k-select", { disabled: ro, "data-k": "copperLayers" }) as HTMLSelectElement;
      const layerName = (l: string): string => { const L = doc.layers.get(l) as { userName?: string } | undefined; return L && L.userName ? L.userName : l; };
      const fillCopper = (): void => { copperSel.replaceChildren(...PM().copperChoices(m.type, copper, layerName).map((l, i) => h("option", { value: String(i) }, l))); if (m.copper >= copperSel.options.length) m.copper = 0; copperSel.selectedIndex = m.copper; copperSel.disabled = ro || m.type === "aperture"; };
      copperSel.addEventListener("change", () => { m.copper = copperSel.selectedIndex; redraw(); });
      const techChecks = PM().TECH.map(([label, l]) => checkField(!!m.tech[l], label, { ro, key: "layer-" + l, onChange: (v) => { m.tech[l] = v; redraw(); } }));
      const prop = selectField<string>(m.property, PM().PROPS, { ro, key: "fabProperty", onChange: (v) => { m.property = v; } });
      prop.input.title = "Optional property to specify a special purpose or constraint in fabrication files:\nBGA attribute is for pads in BGA footprints\nFiducial local is a fiducial for the parent footprint\nFiducial global is a fiducial for the whole board\nTest Point specifies an electrical test point\nHeatsink specifies a thermal pad\nCastellated specifies a through hole pad on a board edge\nMechanical specifies a through-hole pad that is used for mechanical support";
      const sim = selectField<string>(m.simType === "source" || m.simType === "sink" ? m.simType : "", [["", "None"], ["source", "Source"], ["sink", "Sink"]], { ro, key: "simType", onChange: (v) => { m.simType = v; } });
      const middle = h("div", { class: "pp-col" },
        h("div", { class: "pd-box" },
          flipped ? h("div", { class: "pd-info" }, "Parent footprint on board is flipped.\nLayers will be reversed.") : null,
          form([["Copper layers:", copperSel]], true),
          h("div", { class: "pp-techhd" }, "Technical Layers"), h("div", { class: "pp-tech" }, ...techChecks.map((c) => c.el))),
        form([["Fabrication property:", prop.el], ["Simulation electrical type:", sim.el]], true));
      // preview
      const cv = h("canvas", { class: "pp-preview" });
      const sketch = checkField(sketchPreview, "Preview pad in sketch mode", { key: "sketch", onChange: (v) => { sketchPreview = v; redraw(); } });   // onChangePadDrawMode
      // m_stackupImagesBook: the cross-section of the pad type's copper layers (OnUpdateUI)
      const stackupImage = h("div", { class: "pp-stackup", "data-k": "stackupImage" });
      const right = h("div", { class: "pp-col pp-right" }, stackupImage, cv);
      general.append(left, middle);
      // ---- Connections
      const zc = selectField<number>(m.zoneConnect, [[-1, "From parent footprint"], [2, "Solid"], [1, "Thermal relief"], [0, "None"]], { ro, key: "zoneConnect", onChange: (v) => { m.zoneConnect = v; } });
      const knock = selectField<string>(m.knockout, [["outline", "Pad shape"], ["convexhull", "Pad convex hull"]], { ro: ro || !m.shape.startsWith("custom"), key: "zoneKnockout", onChange: (v) => { m.knockout = v as PadModel["knockout"]; } });
      const optLen = (v: number, key: string): Field<number> => lenField(v, { ro, key, allowEmpty: true });
      const gap = optLen(m.gap, "reliefGap"), spoke = optLen(m.spoke, "spokeWidth");
      const spokeAngle = h("input", { type: "text", value: f6(m.spokeAngle), disabled: ro, "data-k": "spokeAngle", style: "width:100px" });
      // the Teardrops box (TEARDROP_PARAMETERS); a board with legacy teardrops greys it and says so
      const td = m.td;
      const legacy = !!(doc as unknown as { legacyTeardrops?: boolean }).legacyTeardrops;
      const tdRo = ro || legacy;
      const tdOn = checkField(td.enabled, "Add teardrops on pad's track connections", { ro: tdRo, key: "tdEnabled", onChange: (v) => { td.enabled = v; } });
      const tdZone = checkField(td.preferZone, "Prefer zone connection", { ro: tdRo, key: "tdPreferZone", tip: "Do not create teardrops on tracks connected to pads that are also connected to a copper zone.", onChange: (v) => { td.preferZone = v; } });
      const tdTwo = checkField(td.twoSegments, "Allow teardrops to span 2 track segments", { ro: tdRo, key: "tdTwoSegments", tip: "Allows a teardrop to spread over 2 tracks if the first track segment is too short", onChange: (v) => { td.twoSegments = v; } });
      // wxSpinCtrlDouble ranges (dialog_pad_properties_base.cpp): track width limit 0-100, best length 20-200, best width 60-100
      const PCT: Record<string, [number, number]> = { tdFilterRatio: [0, 100], tdLenRatio: [20, 200], tdWidthRatio: [60, 100] };
      const clampPct = (key: string, v: number): number => Math.max(PCT[key][0], Math.min(PCT[key][1], v));
      const pctIn = (v: number, key: string): HTMLInputElement => h("input", { type: "text", value: f6(clampPct(key, v * 100)), disabled: tdRo, "data-k": key, style: "width:70px" });
      const tdHD = pctIn(td.filterRatio, "tdFilterRatio"), tdLen = pctIn(td.lenRatio, "tdLenRatio"), tdWid = pctIn(td.widthRatio, "tdWidthRatio");
      const pct0 = new Map([tdHD, tdLen, tdWid].map((i) => [i, i.value] as [HTMLInputElement, string]));
      tdHD.title = "Tracks which are similar in size to the pad do not need teardrops.";
      const tdMaxLen = lenField(td.maxLen, { ro: tdRo, key: "tdMaxLen" }), tdMaxWid = lenField(td.maxWidth, { ro: tdRo, key: "tdMaxWidth" });
      const tdCurved = checkField(td.curved, "Curved edges", { ro: tdRo, key: "tdCurved", onChange: (v) => { td.curved = v; } });
      // m_minTrackWidthHint / m_stLenPercentHint / m_stWidthPercentHint: "d" for a circular pad, "w" otherwise
      const hints: HTMLElement[] = [];
      const pctRow = (input: HTMLInputElement): HTMLElement => { const hint = h("i", { "data-k": "tdHint" }, "d"); hints.push(hint); return h("span", { class: "pp-row" }, input, h("span", { class: "unit" }, "%(", hint, ")")); };
      const tdBitmap = h("div", { class: "pp-tdbitmap", "data-k": "teardropBitmap" });
      const teardrops = box("Teardrops",
        legacy ? h("div", { class: "pd-info" }, "Board contains legacy teardrops.\nUse Edit > Edit Teardrops to apply automatic teardrops.") : null,
        h("div", { class: "pp-tdtop" }, h("div", { class: "pp-col" }, tdOn.el, tdZone.el, tdTwo.el), tdBitmap),
        form([["Track width limit:", pctRow(tdHD), h("span"), "Max pad/via size to track width ratio to create a teardrop.\n100 always creates a teardrop."]]),
        h("div", { class: "pp-techhd" }, "Teardrop Shape"),
        form([["Best length (L):", pctRow(tdLen)], ["Maximum length (L):", tdMaxLen.el, unitLabel()], ["Best width (W):", pctRow(tdWid)], ["Maximum width (W):", tdMaxWid.el, unitLabel()]]),
        tdCurved.el);
      const connections = h("div", { class: "pp-page" },
        box("Connection to Copper Zones", form([["Pad connection:", zc.el], ["Zone knockout:", knock.el]], true)),
        box("Thermal Relief Overrides", form([["Relief gap:", gap.el, unitLabel()], ["Spoke width:", spoke.el, unitLabel()], ["Spoke angle:", spokeAngle, unitLabel("deg")]])),
        teardrops);
      // ---- Clearance Overrides
      const clr = optLen(m.clearance, "padClearance"), mask = optLen(m.mask, "maskMargin");
      const pasteText = (): string => { const parts: string[] = []; if (!isNaN(m.paste)) parts.push(fmtLen(m.paste) + " " + unitName()); if (!isNaN(m.pasteRatio)) parts.push((parts.length && m.pasteRatio >= 0 ? "+ " : "") + f6(m.pasteRatio * 100) + "%"); return parts.join(" "); };
      const paste = h("input", { type: "text", value: pasteText(), disabled: ro, "data-k": "pasteMargin", title: "Local solder paste clearance for this pad.\nEnter an absolute value (e.g., -0.1mm), a percentage (e.g., -5%), or both (e.g., -0.1mm - 5%).\nIf blank, the footprint or global value is used." });
      const clearance = h("div", { class: "pp-page" },
        h("p", { class: "pd-note" }, "Leave values blank to use parent footprint or netclass values."),
        h("p", { class: "pd-note" }, "Positive clearance means area bigger than the pad (usual for mask clearance)."),
        h("p", { class: "pd-note" }, "Negative clearance means area smaller than the pad (usual for paste clearance)."),
        form([["Pad clearance:", clr.el, unitLabel(), "This is the local net clearance for this pad.\nIf 0, the footprint local value or the Netclass value is used."],
          ["Solder mask expansion:", mask.el, unitLabel(), "This is the local clearance between this pad and the solder mask.\nIf 0, the footprint local value or the global value is used."],
          ["Solder paste clearance:", paste, h("span")]]),
        h("p", { class: "pd-note" }, "Note: solder mask and paste values are used only for pads on copper layers."));
      // ---- Backdrill (m_backDrillPanel): Hole Post Machining and Backdrilling
      const layerOpts = (): [string, string][] => PM().cuStack(copper).map((l): [string, string] => [l, layerName(l)]);
      const pmCtl = (front: boolean, pm: PostMachining) => {
        const mode = selectField<string>(pm.mode, [["none", "None"], ["countersink", "Countersink"], ["counterbore", "Counterbore"]], { ro, key: front ? "topPostMachining" : "bottomPostMachining", onChange: () => syncPm(true) });
        const size = lenField(pm.size, { ro, key: front ? "topPostMachineSize1" : "bottomPostMachineSize1" });
        const second = h("input", { type: "text", value: pm.mode === "counterbore" ? fmtLen(pm.depth) : f6(pm.angle), disabled: ro, "data-k": front ? "topPostMachineSize2" : "bottomPostMachineSize2", style: "width:92px" });
        const sizeLabel = h("label", null, "Size:"), secondLabel = h("label", null, "Angle:"), secondUnit = h("span", { class: "unit" }, "deg"), sizeUnit = unitLabel();
        let isAngle = pm.mode !== "counterbore";
        /** onTopPostMachining / onBottomPostMachining: Angle in degrees (82 to start) for a countersink, Depth for a counterbore. */
        const syncPm = (user: boolean): void => {
          const v = mode.get(), on = v !== "none" && holeRound();
          for (const e of [size.input, second] as (HTMLInputElement | HTMLSelectElement)[]) e.disabled = ro || !on;
          for (const e of [sizeLabel, secondLabel]) e.classList.toggle("disabled", !on);
          if (v === "countersink") { if (!isAngle) { second.value = ""; } isAngle = true; secondLabel.textContent = "Angle:"; secondUnit.textContent = "deg"; const a = Number(second.value.replace(",", ".")); if (!second.value.trim() || !a) second.value = "82"; }
          else if (v === "counterbore") { if (isAngle && user) second.value = fmtLen(0); isAngle = false; secondLabel.textContent = "Depth:"; secondUnit.textContent = unitName(); }
          void user;
        };
        const get = (): PostMachining => {
          const v = mode.get() as PostMachining["mode"]; const t = second.value.trim().replace(",", ".");
          return { mode: v, size: size.get(), depth: v === "counterbore" ? (t ? parseLen(t) : 0) : 0, angle: v === "countersink" ? Math.round((Number(t) || 0) * 10) / 10 : 0 };
        };
        const row = form([[front ? "Front:" : "Back:", mode.el], [sizeLabel, size.el, sizeUnit], [secondLabel, second, secondUnit]], true);
        return { mode, row, syncPm, get };
      };
      const pmF = pmCtl(true, m.pmFront), pmB = pmCtl(false, m.pmBack);
      const bdChoice = selectField<number>(m.bdChoice, [[0, "None"], [1, "Top"], [2, "Bottom"], [3, "Top & bottom"]], { ro, key: "backDrillChoice", onChange: () => syncBackdrill(true) });
      const bdTopLayer = selectField<string>(m.bdTopEnd || "", [["", ""], ...layerOpts()], { ro, key: "backDrillTopLayer" }), bdBotLayer = selectField<string>(m.bdBotEnd || "", [["", ""], ...layerOpts()], { ro, key: "backDrillBottomLayer" });
      const bdTopSize = lenField(m.bdTopSize, { ro, key: "backDrillTopSize" }), bdBotSize = lenField(m.bdBotSize, { ro, key: "backDrillBottomSize" });
      const mustCut = "The backdrill must pass through this layer";
      const bdTopLabel = h("label", { title: mustCut }, "Must-cut layer:"), bdBotLabel = h("label", { title: mustCut }, "Must-cut layer:");
      bdTopLayer.input.title = mustCut; bdBotLayer.input.title = mustCut;
      /** syncBackdrillControls: a side switched on starts on its outer layer, 1.1 × the larger hole size. */
      function syncBackdrill(user: boolean): void {
        const sel = bdChoice.get(), round = holeRound(), top = round && (sel === 1 || sel === 3), bot = round && (sel === 2 || sel === 3);
        bdChoice.input.disabled = ro || !round;
        bdTopSize.input.disabled = ro || !top; bdTopLayer.input.disabled = ro || !top; bdTopLabel.classList.toggle("disabled", !top);
        bdBotSize.input.disabled = ro || !bot; bdBotLayer.input.disabled = ro || !bot; bdBotLabel.classList.toggle("disabled", !bot);
        if (!user) return;
        const drill = Math.max(holeX.get(), m.holeOblong ? holeY.get() : holeX.get());
        if (top) { if (!bdTopLayer.get()) bdTopLayer.set("F.Cu"); if (!bdTopSize.get()) bdTopSize.set(Math.round(drill * 1.1 * 1e6) / 1e6); }
        if (bot) { if (!bdBotLayer.get()) bdBotLayer.set("B.Cu"); if (!bdBotSize.get()) bdBotSize.set(Math.round(drill * 1.1 * 1e6) / 1e6); }
      }
      const backdrill = h("div", { class: "pp-page" },
        box("Hole Post Machining", pmF.row, pmB.row),
        box("Backdrilling", bdChoice.el,
          form([[bdTopLabel, bdTopLayer.el], ["Top backdrill size:", bdTopSize.el, unitLabel()], [bdBotLabel, bdBotLayer.el], ["Bottom backdrill size:", bdBotSize.el, unitLabel()]], true)));
      const holeRound = (): boolean => holeShape.get() === 0;
      /** OnDrillShapeSelected: an oblong hole drops the backdrills and post-machining, after asking. */
      function onDrillShape(v: number): void {
        const apply = (): void => { m.holeOblong = holeShape.get() === 1; updateHoleControls(); redraw(); };
        if (v === 1 && (bdChoice.get() !== 0 || pmF.mode.get() !== "none" || pmB.mode.get() !== "none")) {
          messageBox("Warning", "Switching to non-circular hole will disable backdrills and post-machining. Continue?", [{ label: "OK", fn: apply }, { label: "Cancel", fn: () => { holeShape.set(0); } }], 1);
          return;
        }
        apply();
      }
      /** updateHoleControls: "Diameter:" for a round hole (Y hidden); the drilling controls only for a round hole. */
      function updateHoleControls(): void {
        const round = holeRound();
        holeXLabel.textContent = round ? "Diameter:" : "Hole size X:"; holeXY.y.style.display = round ? "none" : "";
        holeY.input.disabled = ro || !holed() || round;
        for (const p of [pmF, pmB]) p.mode.input.disabled = ro || !round;
        syncBackdrill(false); pmF.syncPm(false); pmB.syncPm(false);
      }
      const PAGES = ["General", "Connections", "Clearance Overrides", "Backdrill"];
      const nb = notebook([{ label: "General", build: (el) => el.append(general) }, { label: "Connections", build: (el) => el.append(connections) }, { label: "Clearance Overrides", build: (el) => el.append(clearance) },
        { label: "Backdrill", build: (el) => el.append(backdrill) }], { start: lastPage < PAGES.length ? lastPage : 0, onShow: (i) => { lastPage = i; redraw(); } });
      // the parent line: "Footprint %s (%s), %s, rotated %g deg"
      const frot = Number((kid(staged, "at") || [])[3]) || 0;
      const parentInfo = h("span", { class: "pp-parent", "data-k": "parentInfo" }, `Footprint ${fieldOf("Reference")} (${fieldOf("Value")}), ${flipped ? "back side (mirrored)" : "front side"}, rotated ${String(Math.round(frot * 1e4) / 1e4)} deg`);
      body.append(h("style", null, PP_CSS), h("div", { class: "pp-wrap" }, h("div", { class: "pp-book" }, nb.el), right), h("div", { class: "pp-bottom" }, parentInfo, sketch.el));
      // ---- behaviour (DIALOG_PAD_PROPERTIES::OnPadShapeSelection / PadTypeSelected / UpdateLayersDropdown)
      const holed = (): boolean => m.type === "pth" || m.type === "npth";
      /** afterPadstackModeChanged: the edit layer choices of the mode, the edit layer selected among them. */
      function fillEditLayers(): void {
        const opts = PM().padstackEditLayers(m.psMode, copper, layerName);
        editLayerSel.replaceChildren(...opts.map(([k, l]) => h("option", { value: k }, l)));
        editLayerSel.selectedIndex = Math.max(0, opts.findIndex(([k]) => k === editLayer));
        editLayerSel.disabled = ro || m.psMode === "normal";
      }
      /** OnPadstackModeChanged: the controls go to the edit layer, the mode's new layers start as F.Cu; not reloaded. */
      function onPadstackMode(v: PadstackMode): void {
        readAll(); editLayer = PM().changePadstackMode(stack, editLayer, m, v); m.psMode = v; fillEditLayers(); redraw();
      }
      /** initPadstackLayerValues: the edit layer's shape into the shape controls. */
      const loadShape = (): void => {
        shape.set(m.shape); sx.set(m.w); sy.set(m.h); delta.set(m.delta); axis.set(m.deltaAxis);
        ratio.value = pct(m.rratio); radius.set(m.rratio * Math.min(m.w, m.h)); cratio.value = pct(m.cratio);
        corner.forEach((c, i) => c.set(m.corners[i])); offOn.set(m.offset); offX.set(m.ox); offY.set(m.oy);
      };
      // OnEditLayerChanged: save the previous layer's controls, show the chosen one's
      editLayerSel.addEventListener("change", () => {
        readAll(); PM().storeLayer(stack, editLayer, m);
        const opts = PM().padstackEditLayers(m.psMode, copper, layerName); editLayer = (opts[editLayerSel.selectedIndex] || opts[0])[0];
        PM().applyLayerShape(m, PM().padstackLayer(m.psMode, stack, stack["F.Cu"], editLayer)); loadShape(); onShape();
      });
      /** OnUpdateUI's m_stackupImagesBook page for the pad type and its copper layers. */
      function updateStackupImage(): void {
        const cu = Array.from(PM().modelLayers(m, copper)).filter((l) => /\.Cu$/.test(l));
        let bmp = "";
        if (m.type === "pth") bmp = !cu.length ? "" : m.copper === 0 ? "pads_reset_unused" : m.copper === 1 ? "pads_remove_unused_keep_bottom" : "pads_remove_unused";
        else if (m.type === "npth") bmp = cu.includes("F.Cu") && cu.includes("B.Cu") ? "pads_npth_top_bottom" : cu.includes("F.Cu") ? "pads_npth_top" : cu.includes("B.Cu") ? "pads_npth_bottom" : "pads_npth";
        if (stackupImage.dataset.bitmap === bmp) return;
        stackupImage.dataset.bitmap = bmp; stackupImage.replaceChildren(...(bmp ? [staticBitmap(bmp, 156)] : []));
      }
      /** updatePadSizeControls: one "Diameter:" for a circular pad, and the teardrop picture and hints to match. */
      function updatePadSizeControls(): void {
        const circ = m.shape === "circle" || m.shape === "custom_circle";
        sizeXLabel.textContent = circ ? "Diameter:" : "Pad size X:"; sizeXY.y.style.display = circ ? "none" : "";
        const bmp = circ ? "teardrop_sizes" : "teardrop_rect_sizes";
        if (tdBitmap.dataset.bitmap !== bmp) { tdBitmap.dataset.bitmap = bmp; tdBitmap.replaceChildren(staticBitmap(bmp, 180, 110)); }
        for (const e of hints) e.textContent = circ ? "d" : "w";
      }
      function onShape(): void {
        trapRows.style.display = m.shape === "trapezoid" ? "" : "none";
        roundRows.style.display = m.shape === "roundrect" || m.shape === "mixed" ? "" : "none";
        chamferRows.style.display = m.shape === "chamfer" || m.shape === "mixed" ? "" : "none";
        sy.input.disabled = ro || m.shape === "circle" || m.shape === "custom_circle";
        if (m.shape === "circle") sy.set(sx.get());
        // m_offsetShapeOpt->Enable( shape != circle ), unticked when disabled; the offsets shown only while ticked
        offOn.input.disabled = ro || m.shape === "circle";
        if (m.shape === "circle" && m.offset) { m.offset = false; offOn.set(false); }
        offRow.style.display = m.offset ? "" : "none";
        knock.input.disabled = ro || !m.shape.startsWith("custom");
        // KiCad's defaults on a shape change: the IPC corner radius, a 20% chamfer on the top-left corner
        const ipc = (): number => { const mn = Math.min(m.w, m.h); return mn > 0 ? Math.min(0.25, mn * 0.25) / mn : 0.25; };
        if ((m.shape === "roundrect" || m.shape === "mixed") && !(m.rratio > 0)) { m.rratio = ipc(); ratio.value = pct(m.rratio); radius.set(m.rratio * Math.min(m.w, m.h)); }
        if ((m.shape === "chamfer" || m.shape === "mixed") && !(m.cratio > 0)) { m.cratio = 0.2; cratio.value = pct(m.cratio); }
        if ((m.shape === "chamfer" || m.shape === "mixed") && !m.corners.some(Boolean)) { m.corners = [true, false, false, false]; corner.forEach((c, i) => c.set(i === 0)); }
        updatePadSizeControls(); redraw();
      }
      /** OnUpdateUI's enable states for the type. */
      function typeEnables(): void {
        const conn = m.type !== "npth" && m.type !== "aperture";
        number.input.disabled = ro || !conn; net.input.disabled = ro || !conn;
        dieOn.input.disabled = ro || !conn; (delayOn.input as HTMLInputElement).disabled = ro || !conn;
        holeShape.input.disabled = ro || !holed(); holeX.input.disabled = ro || !holed(); holeY.input.disabled = ro || !holed() || !m.holeOblong;
        holeRows.style.display = holed() ? "" : "none";
        updateHoleControls();
        padstackRows.style.display = m.type === "pth" ? "" : "none";
      }
      /** PadTypeSelected: the new type's default layers, its hole and its connection. */
      function onType(): void {
        // updatePadLayersList( std::nullopt ): PAD::PTHMask, SMDMask, ConnSMDMask, UnplatedHoleMask, ApertureMask, { F_Cu }
        const set = m.type === "pth" || m.type === "npth" ? ["F.Mask", "B.Mask"] : m.type === "conn" ? ["F.Mask"] : m.type === "aperture" ? ["F.Paste"] : m.type === "copper" ? [] : ["F.Paste", "F.Mask"];
        for (const [, l] of PM().TECH) m.tech[l] = set.includes(l); techChecks.forEach((c, i) => c.set(!!m.tech[PM().TECH[i][1]]));
        // a through-hole pad keeps the edited pad's unused-layer removal (GetRemoveUnconnected / GetKeepTopBottom)
        m.copper = m.type === "pth" && was.type === "pth" && was.copper !== 3 ? was.copper : 0;
        if (!holed()) { m.hx = m.hy = 0; holeX.set(0); holeY.set(0); }
        else if (!(m.hx > 0)) { m.hx = was.hx; m.hy = was.hy; holeX.set(m.hx); holeY.set(m.holeOblong ? m.hy : m.hx); }   // m_currentPad->GetDrillSize()
        const conn = m.type !== "npth" && m.type !== "aperture";
        if (!conn) {
          m.number = ""; number.set(""); m.net = ""; net.set("");
          m.dieOn = false; dieOn.set(false); m.dieDelayOn = false; delayOn.set(false); syncDie();
        } else if (!number.get()) { m.number = was.number; number.set(was.number); m.net = was.net; net.set(was.net); }
        typeEnables(); fillCopper(); redraw();
      }
      readAll = (): void => {
        m.number = number.get(); m.x = px.get(); m.y = py.get(); m.w = sx.get(); m.h = m.shape === "circle" ? m.w : sy.get();
        const a = Number(String(angle.value).replace(",", ".")); if (!isNaN(a)) m.angle = norm180(a);
        m.delta = delta.get(); m.deltaAxis = axis.get() === 1 ? 1 : 0;
        const r = Number(ratio.value.replace(",", ".")); if (!isNaN(r)) m.rratio = Math.max(0, Math.min(50, r)) / 100;
        const c = Number(cratio.value.replace(",", ".")); if (!isNaN(c)) m.cratio = Math.max(0, Math.min(50, c)) / 100;
        m.ox = offX.get(); m.oy = offY.get(); m.hx = holeX.get(); m.hy = m.holeOblong ? holeY.get() : m.hx; m.die = die.get();
        const dd = Number(String(delay.value).replace(",", ".")); if (!isNaN(dd)) m.dieDelay = dd;
        // an untouched box keeps the stored ratio; an edited one is clamped to the spin range
        const pctOf = (i: HTMLInputElement, cur: number): number => { if (i.value === pct0.get(i)) return cur; const v = Number(i.value.replace(",", ".")); return isNaN(v) ? cur : clampPct(i.dataset.k || "", v) / 100; };
        td.filterRatio = pctOf(tdHD, td.filterRatio); td.lenRatio = pctOf(tdLen, td.lenRatio); td.widthRatio = pctOf(tdWid, td.widthRatio);
        td.maxLen = tdMaxLen.get(); td.maxWidth = tdMaxWid.get();
        m.gap = gap.get(); m.spoke = spoke.get(); const sa = Number(spokeAngle.value.replace(",", ".")); if (!isNaN(sa)) m.spokeAngle = sa;
        m.clearance = clr.get(); m.mask = mask.get();
        const pt = paste.value.trim(); if (!pt) { m.paste = NaN; m.pasteRatio = NaN; }
        else { const pm = /^\s*([-+]?\s*[\d.,]+\s*(?:mm|mils?|in|")?)?\s*(?:([-+])?\s*([\d.,]+)\s*%)?\s*$/i.exec(pt);
          if (pm) { m.paste = pm[1] && !/%/.test(pm[1]) ? parseLen(pm[1].replace(/\s+/g, "")) : NaN; m.pasteRatio = pm[3] ? (pm[2] === "-" || (!pm[1] && /^-/.test(pt)) ? -1 : 1) * Number(pm[3].replace(",", ".")) / 100 : NaN; } }
      };
      // corner size and radius follow each other
      ratio.addEventListener("change", () => { readAll(); radius.set(m.rratio * Math.min(m.w, m.h)); ratio.value = pct(m.rratio); redraw(); });
      radius.input.addEventListener("change", () => { const mn = Math.min(sx.get(), sy.get()); if (mn > 0) { m.rratio = Math.max(0, Math.min(0.5, radius.get() / mn)); ratio.value = pct(m.rratio); } redraw(); });
      body.addEventListener("input", () => { readAll(); redraw(); });
      body.addEventListener("change", () => { readAll(); redraw(); });
      readDrills = (): void => {
        m.bdChoice = bdChoice.get() as PadModel["bdChoice"]; m.bdTopSize = bdTopSize.get(); m.bdTopEnd = bdTopLayer.get(); m.bdBotSize = bdBotSize.get(); m.bdBotEnd = bdBotLayer.get();
        m.pmFront = pmF.get(); m.pmBack = pmB.get();
      };
      redraw = (): void => { updateStackupImage(); drawPreview(cv, m, sketch.get(), copper); };
      fillEditLayers(); onShape(); fillCopper(); typeEnables();
      // the initial focus of the remembered page: the pad number, the thermal gap, the clearance
      requestAnimationFrame(() => { const f = [number.input, gap.input, clr.input][lastPage]; if (f && !ro) { f.focus(); if (f === number.input) (f as HTMLInputElement).select(); } });
      requestAnimationFrame(() => redraw());
    },
    ok() {
      if (ro) return true;
      readAll(); readDrills();
      // transferDataToPad: the edit layer's controls into its layer; the pad's own shape is the F.Cu layer's
      PM().storeLayer(stack, editLayer, m); editLayer = "F.Cu";
      PM().applyLayerShape(m, stack["F.Cu"]);
      const layersOut = { ...stack }; delete layersOut["F.Cu"]; m.psLayers = layersOut;
      const { errors, warnings } = PM().checkPad(m);
      if (errors.length) { messageList("Pad Properties Errors", errors.concat(warnings)); return false; }
      const commit = (): void => {
        PM().writePad(doc, staged, pad, m, was, (name) => PH().netCodeOf(doc, name));
        const before = K().serialize(item.node); if (K().serialize(staged) === before) return;
        ctx.commit([K().replaceChange(doc, { ...item, node: staged, geom: [], bbox: null })], "Edit Pad Properties");
        ctx.requestRender();
      };
      // PAD_TOOL::SetLastPadNumber( m_previewPad->GetNumber() ), even when nothing else changed
      const mem = padMemory(); if (mem) mem.lastNumber = m.number;
      if (warnings.length) { messageList("Pad Properties Warnings", warnings); }
      commit();
      return true;
    },
  });
  return true;
}

function messageList(title: string, lines: string[]): void {
  openDialog({ title, width: 480, noOk: true, cancelLabel: "OK", build(body) { body.append(h("ul", { class: "pp-msgs" }, ...lines.map((l) => h("li", null, l)))); } });
}

const PP_CSS = `
.pp-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 12px; min-height: 610px; }
.pp-general { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 0 18px; }
.pp-col { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pp-right { align-items: stretch; padding-top: 34px; }
.pp-preview { width: 100%; height: 300px; border: 1px solid var(--line); border-radius: 3px; display: block; }
.pp-hr { border: none; border-top: 1px solid var(--line); margin: 4px 0; width: 100%; }
.pp-row { display: flex; gap: 8px; align-items: center; }
.pp-row input[type=text] { width: 110px; }
.pp-corners { display: grid; grid-template-columns: max-content max-content; gap: 2px 12px; }
.pp-tech { display: grid; grid-template-columns: 1fr; gap: 0; }
.pp-techhd { font-weight: 600; margin: 8px 0 2px; }
.pp-shapeprops .pd-form { margin: 2px 0; }
.pp-page { padding: 4px 2px; }
.pp-msgs { margin: 4px 0; padding-left: 18px; }
.pp-msgs li { margin: 3px 0; }
.pp-wrap .pd-xy { display: inline-flex; gap: 6px; align-items: center; }
.pp-wrap .pd-xy input { width: 92px; }
.pd-info { white-space: pre-line; }
.pp-anglebox { display: inline-flex; align-items: stretch; }
.pp-anglebox input { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.pp-combo { padding: 0 6px; border-top-left-radius: 0; border-bottom-left-radius: 0; margin-left: -1px; }
.pp-stackup { display: flex; justify-content: center; min-height: 156px; }
.pp-tdtop { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.pp-bottom { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 8px; }
.pp-parent { color: var(--muted, inherit); }
label.disabled { opacity: 0.5; }
`;
