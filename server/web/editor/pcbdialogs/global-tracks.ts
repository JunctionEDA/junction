// pcbdialogs/global-tracks — Edit > Edit Track & Via Properties... (GLOBAL_EDIT_TOOL::EditTracksAndVias,
// DIALOG_GLOBAL_EDIT_TRACKS_AND_VIAS, dialog_global_edit_tracks_and_vias_base.fbp): Scope (Tracks, Vias and the four
// via types), Filter Items (net, net class, layer, track width, via diameter, selected items only) and Action ("Set to
// specified values" with every choice starting at "-- leave unchanged --", or "Set to net class / custom rule values").
// Apply and Close stores one "Edit Track and Via Properties" step over every track, arc and via that passes.
import { E } from "../state";
import { pcbState } from "../gestures";
import { boardSelection } from "./exchange";
import { checkField, errorMessage, h, openDialog, parseLen, selectField, unitName, currentUnits, type Field } from "./ui";
import * as M from "./track-via-model";

interface Rules { track_width?: number; via_diameter?: number; via_drill?: number; uvia_diameter?: number; uvia_drill?: number }
interface Settings { netclasses: Record<string, unknown> }
interface PcbToolsApi {
  designSettings(src: unknown): Settings; netclassName(s: Settings, net: string): string; netclassOf(s: Settings, net: string): Rules;
  boardLayerName(doc: KDoc, name: string): string; expandGroups?(doc: KDoc, ids: string[]): Iterable<string>;
}
interface PropsHelpers { netNameOf(doc: KDoc, node: SNode): string; boardNetNames(doc: KDoc): string[] }
const PT = (): PcbToolsApi => (window as unknown as { PcbTools: PcbToolsApi }).PcbTools;
const PH = (): PropsHelpers => (CollabTools as unknown as { props: { helpers: PropsHelpers } }).props.helpers;
const K = (): KiCadCanvasApi => KiCadCanvas;
const parse: M.Parse = (t) => K().parse(t) as SNode;
const LEAVE = "-- leave unchanged --";
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
const viaTypeOf = (n: SNode): string => (typeof n[1] === "string" && ["blind", "buried", "micro"].includes(String(n[1])) ? String(n[1]) : "through");
const numOf = (n: SNode, key: string): number => { const c = M.kid(n, key); return c ? +c[1] : 0; };
// g_netclassFilter / g_netFilter: the dialog's statics
const memory = { net: "", netclass: "" };

export interface GlobalTrackJob {
  tracks: boolean; through: boolean; micro: boolean; blind: boolean; buried: boolean;
  net: string | null; netclass: string | null; layer: string | null; trackWidth: number | null; viaSize: number | null; selected: Set<string> | null;
  specified: boolean;
  /** the specified values; null leaves the property alone */
  width: number | null; via: { diameter: number; drill: number } | null; annular: number | null; protection: number | null; toLayer: string | null;
}

/** TransferDataFromWindow → visitItem → processItem over the board's tracks, arcs and vias: [id, new node] per changed item. */
export function globalTrackEdits(doc: KDoc, job: GlobalTrackJob, settings: Settings): [string, SNode][] {
  const out: [string, SNode][] = [];
  for (const it of doc.items.values()) {
    const isVia = it.kind === "via", isTrack = it.kind === "segment" || it.kind === "arc";
    if (!isVia && !isTrack) continue;
    const n = it.node as SNode;
    if (isTrack) { if (!job.tracks) continue; }
    else { const t = viaTypeOf(n); if (!(t === "through" ? job.through : t === "micro" ? job.micro : t === "blind" ? job.blind : job.buried)) continue; }
    // visitItem
    if (job.selected && !job.selected.has(it.id)) continue;
    const net = PH().netNameOf(doc, n);
    if (job.net !== null && net !== job.net) continue;
    if (job.netclass !== null && PT().netclassName(settings, net) !== job.netclass) continue;
    if (job.layer !== null) { const l = isVia ? String((M.kid(n, "layers") || [0, ""])[1]) : M.trackLayer(n); if (l !== job.layer) continue; }
    if (isVia) { if (job.viaSize !== null && !near(numOf(n, "size"), job.viaSize)) continue; }
    else if (job.trackWidth !== null && !near(numOf(n, "width"), job.trackWidth)) continue;
    // processItem
    const next = JSON.parse(JSON.stringify(n)) as SNode;
    const setSize = (diameter: number, drill: number): void => {
      if (diameter > 0 && !near(diameter, numOf(next, "size"))) M.setChild(next, "size", `(size ${M.f6(diameter)})`, M.VIA_ORDER, parse);
      if (drill > 0 && !near(drill, numOf(next, "drill"))) M.setChild(next, "drill", `(drill ${M.f6(drill)})`, M.VIA_ORDER, parse);
    };
    if (job.specified) {
      if (isTrack && job.width !== null && job.width > 0 && !near(job.width, numOf(next, "width"))) M.setChild(next, "width", `(width ${M.f6(job.width)})`, M.TRACK_ORDER, parse);
      if (isVia && job.via) {
        // SetTrackSegmentWidth: a microvia takes its net class's microvia size, any other via the chosen pre-defined size
        if (viaTypeOf(n) === "micro") { const nc = PT().netclassOf(settings, net); setSize(nc.uvia_diameter || 0, nc.uvia_drill || 0); }
        else setSize(job.via.diameter, job.via.drill);
      }
      if (isVia && job.annular !== null) M.setAnnularMode(next, job.annular, parse);
      if (isVia && job.protection !== null) M.setProtectionPreset(next, job.protection, parse);
      if (isTrack && job.toLayer && M.trackLayer(next) !== job.toLayer) { const l = M.kid(next, "layer"); if (l) l[1] = job.toLayer; }
    } else {
      const nc = PT().netclassOf(settings, net);
      if (isTrack) { const w = nc.track_width || 0; if (w > 0 && !near(w, numOf(next, "width"))) M.setChild(next, "width", `(width ${M.f6(w)})`, M.TRACK_ORDER, parse); }
      else if (viaTypeOf(n) === "micro") setSize(nc.uvia_diameter || 0, nc.uvia_drill || 0);
      else setSize(nc.via_diameter || 0, nc.via_drill || 0);
    }
    if (JSON.stringify(next) !== JSON.stringify(n)) out.push([it.id, next]);
  }
  return out;
}

export function openGlobalTracksAndVias(ctx: ToolCtx): void {
  const doc = E.kdoc as KDoc | null;
  if (!doc || doc.type !== "pcb") { ctx.toast("This needs a board"); return; }
  const ro = !!E.viewOnly;
  const settings = PT().designSettings(E.proSettings || null);
  const st = pcbState() as { highlightNet?: unknown } | null;
  const sizes = K().pcbSizes && K().pcbSizes.state ? K().pcbSizes.state.sizes : { trackWidths: [0], vias: [{ diameter: 0, drill: 0 }] };
  const units = currentUnits() as "mm" | "in" | "mil", lastImperial = E.lastImperial === "in" ? "in" : "mil";
  const trackLabels = K().pcbSizes ? K().pcbSizes.trackWidthLabels(sizes as never, units, lastImperial).slice(1) : [];
  const viaLabels = K().pcbSizes ? K().pcbSizes.viaSizeLabels(sizes as never, units, lastImperial).slice(1) : [];
  const copper = (doc.copper && doc.copper.length ? doc.copper : ["F.Cu", "B.Cu"]) as string[];
  const layerName = (l: string): string => PT().boardLayerName(doc, l);

  // Scope: m_vias is a 3-state box over the four via types
  const tracks = checkField(true, "Tracks", { key: "tracks" });
  const viaTypes: Field<boolean>[] = [];
  const viasInput = h("input", { type: "checkbox", "data-k": "vias", "data-nopersist": "" }) as HTMLInputElement;
  const updateVias = (): void => { const c = viaTypes.filter((f) => f.get()).length; viasInput.indeterminate = c > 0 && c < 4; viasInput.checked = c === 4; };
  for (const [k, label] of [["throughVias", "Through vias"], ["microVias", "Microvias"], ["blindVias", "Blind vias"], ["buriedVias", "Buried vias"]]) viaTypes.push(checkField(true, label, { key: k, onChange: updateVias }));
  viasInput.addEventListener("click", () => { const on = viasInput.checked; for (const f of viaTypes) f.set(on); updateVias(); });   // onVias
  const [through, micro, blind, buried] = viaTypes;

  // Filter Items
  const nets = PH().boardNetNames(doc).filter((n) => n);
  const hl = st && typeof st.highlightNet === "string" ? st.highlightNet : "";
  const netOpt = checkField(false, "Filter items by net:", { key: "netFilterOpt" });
  const net = selectField<string>(memory.net && nets.includes(memory.net) ? memory.net : hl && nets.includes(hl) ? hl : nets[0] || "", nets.map((n): [string, string] => [n, n]), { key: "netFilter", onChange: (v) => { memory.net = v; netOpt.set(true); } });
  const classes = ["Default", ...Object.keys(settings.netclasses).filter((n) => n !== "Default")];
  const ncOpt = checkField(false, "Filter items by net class:", { key: "netclassFilterOpt" });
  const nc = selectField<string>(memory.netclass && classes.includes(memory.netclass) ? memory.netclass : "Default", classes.map((n): [string, string] => [n, n]), { key: "netclassFilter", onChange: (v) => { memory.netclass = v; ncOpt.set(true); } });
  const layerOpt = checkField(false, "Filter items by layer:", { key: "layerFilterOpt" });
  const layer = selectField<string>(copper.includes(ctx.activeLayer || "") ? ctx.activeLayer! : copper[0], copper.map((l): [string, string] => [l, layerName(l)]), { key: "layerFilter", onChange: () => layerOpt.set(true) });
  for (const s of [net, nc, layer]) s.input.setAttribute("data-nopersist", "");
  const widthOpt = checkField(false, "Filter tracks by width:", { key: "filterByTrackWidth" });
  const widthText = h("input", { type: "text", "data-k": "trackWidthFilter", style: "width:110px" }) as HTMLInputElement;
  widthText.addEventListener("input", () => widthOpt.set(true));
  const viaOpt = checkField(false, "Filter vias by diameter:", { key: "filterByViaSize" });
  const viaText = h("input", { type: "text", "data-k": "viaSizeFilter", style: "width:110px" }) as HTMLInputElement;
  viaText.addEventListener("input", () => viaOpt.set(true));
  const selOnly = checkField(false, "Selected items only", { key: "selectedItemsFilter" });

  // Action
  const radio = (label: string, key: string): Field<boolean> => {
    const input = h("input", { type: "radio", name: "gtv-action", "data-k": key }) as HTMLInputElement;
    return { el: h("label", { class: "pd-check" }, input, label), input, get: () => input.checked, set: (v) => { input.checked = v; } };
  };
  const specified = radio("Set to specified values:", "setToSpecifiedValues"), rules = radio("Set to net class / custom rule values", "setToDesignRuleValues");
  specified.set(true);
  const choice = (key: string, labels: string[]): Field<string> => {
    const f = selectField<string>("", [...labels.map((l, i): [string, string] => [String(i), l]), ["", LEAVE]], { key });
    f.input.setAttribute("data-nopersist", ""); return f;
  };
  const toLayer = selectField<string>("", [["", LEAVE], ...copper.map((l): [string, string] => [l, layerName(l)])], { key: "layerCtrl" });
  toLayer.input.setAttribute("data-nopersist", "");
  const trackCtrl = choice("trackWidthCtrl", trackLabels), viaCtrl = choice("viaSizesCtrl", viaLabels);
  const ringCtrl = choice("annularRingsCtrl", ["All copper layers", "Start, end, and connected layers", "Connected layers only", "Start and end layers only"]);
  const protCtrl = choice("protectionFeatures", M.IPC4761.map(([name]) => name));
  (protCtrl.input as HTMLElement).title = "Select which protection feature according to IPC-4761 the via should have.";
  const lbl = (t: string): HTMLElement => h("span", { class: "pd-lbl" }, t);
  const actionRows: [HTMLElement, Field<string>][] = [[lbl("Layer:"), toLayer], [lbl("Track width:"), trackCtrl], [lbl("Via size:"), viaCtrl], [lbl("Via annular rings:"), ringCtrl]];
  const onAction = (): void => {   // onActionButtonChange: the protection choice stays enabled, as in KiCad
    const on = specified.get();
    for (const [l, f] of actionRows) { l.classList.toggle("disabled", !on); (f.input as HTMLElement).toggleAttribute("disabled", !on || ro); }
  };
  specified.input.addEventListener("change", onAction); rules.input.addEventListener("change", onAction);

  openDialog({ title: "Set Track and Via Properties", width: 760, okLabel: "Apply and Close", cancelLabel: "Close", readOnly: ro, persist: true,
    build(body) {
      const unit = (): HTMLElement => h("span", { class: "unit" }, unitName());
      const scope = h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Scope"), tracks.el, h("label", { class: "pd-check" }, viasInput, "Vias"),
        h("div", { style: "margin-left:22px" }, ...viaTypes.map((f) => f.el)));
      const filters = h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Filter Items"),
        h("div", { style: "display:grid;grid-template-columns:auto 1fr auto;gap:4px 8px;align-items:center" },
          netOpt.el, net.el, h("span"), ncOpt.el, nc.el, h("span"), layerOpt.el, layer.el, h("span"),
          widthOpt.el, widthText, unit(), viaOpt.el, viaText, unit(), selOnly.el, h("span"), h("span")));
      const grid = h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:center;margin:4px 0 8px 22px" },
        ...actionRows.flatMap(([l, f]) => [l, f.el]), lbl("Via protection features:"), protCtrl.el);
      body.append(h("div", { style: "display:grid;grid-template-columns:auto 1fr;gap:0 16px" }, scope, filters),
        h("div", { class: "pd-box" }, h("div", { class: "hd" }, "Action"), specified.el, grid, rules.el));
      updateVias(); onAction();
    },
    restored() { updateVias(); onAction(); },
    ok() {
      if (ro) return true;
      const len = (on: boolean, inp: HTMLInputElement, label: string): number | null | string => {
        if (!on) return null; const v = parseLen(inp.value.trim());
        if (!inp.value.trim() || !isFinite(v)) { inp.focus(); return `${label} must be a number.`; } return v;
      };
      const tw = len(widthOpt.get(), widthText, "Track width"), vs = len(viaOpt.get(), viaText, "Via diameter");
      for (const v of [tw, vs]) if (typeof v === "string") { errorMessage(v); return false; }
      const pick = (f: Field<string>): number | null => (f.get() === "" ? null : +f.get());
      const ti = pick(trackCtrl), vi = pick(viaCtrl);
      const sel = boardSelection(ctx);
      const job: GlobalTrackJob = {
        tracks: tracks.get(), through: through.get(), micro: micro.get(), blind: blind.get(), buried: buried.get(),
        net: netOpt.get() && net.get() ? net.get() : null, netclass: ncOpt.get() && nc.get() ? nc.get() : null, layer: layerOpt.get() ? layer.get() : null,
        trackWidth: tw as number | null, viaSize: vs as number | null,
        selected: selOnly.get() ? new Set(PT().expandGroups ? PT().expandGroups!(doc, Array.from(sel)) : sel) : null,
        specified: specified.get(),
        width: ti !== null ? sizes.trackWidths[ti + 1] ?? null : null, via: vi !== null ? sizes.vias[vi + 1] ?? null : null,
        annular: pick(ringCtrl), protection: pick(protCtrl), toLayer: toLayer.get() || null,
      };
      const changes: KChange[] = [];
      for (const [id, node] of globalTrackEdits(doc, job, settings)) { const it = doc.items.get(id); if (it) changes.push(K().replaceChange(doc, { ...it, node })); }
      if (changes.length) ctx.commit(changes, "Edit Track and Via Properties");
      ctx.requestRender();
      return true;
    } });
}
