// pcbdialogs/convert — CONVERT_TOOL's settings: the Conversion Settings dialog (CONVERT_SETTINGS_DIALOG, asked by
// Create Polygon / Create Lines from Selection) and the conversion box the zone dialogs put on top when they create a
// zone or rule area from the selection (PANEL_ZONE_CONVERSION / DIALOG_RULE_AREA_PROPERTIES' bConvertSizer).
// Both edit pcb-tools' CONVERT_SETTINGS in place on OK.
import { box, checkField, h, lenField, openDialog, unitLabel } from "./ui";

/** pcb-tools' CONVERT_SETTINGS (m_Strategy, m_Gap, m_LineWidth, m_DeleteOriginals); lengths in mm. */
export interface ConvertSettings { strategy: "copy" | "centerline" | "hull"; gap: number; lineWidth: number; deleteOriginals: boolean }
export interface ConvertShow { copy: boolean; centerline: boolean; hull: boolean }

let radioSeq = 0;
const radio = (name: string, label: string, key: string): { el: HTMLElement; input: HTMLInputElement } => {
  const input = h("input", { type: "radio", name, "data-k": key }) as HTMLInputElement;
  return { el: h("label", { class: "pd-check", style: "display:block" }, input, label), input };
};

/** CONVERT_SETTINGS_DIALOG: the strategy radios the caller shows, Gap / Line width for the bounding hull, Delete source objects. */
export function convertSettingsDialog(show: ConvertShow, settings: ConvertSettings, done: (ok: boolean) => void): void {
  const name = "pd-convert-" + (++radioSeq);
  const copy = radio(name, "Copy line width of first object", "convertCopy");
  const center = radio(name, "Use centerlines", "convertCenterline");
  const hull = radio(name, "Create bounding hull", "convertHull");
  const gap = lenField(settings.gap, { key: "convertGap" }), width = lenField(settings.lineWidth, { key: "convertWidth" });
  const del = checkField(settings.deleteOriginals, "Delete source objects after conversion", { key: "convertDelete" });
  // TransferDataToWindow
  (settings.strategy === "copy" ? copy : settings.strategy === "centerline" ? center : hull).input.checked = true;
  // onRadioButton: the hull's parameters are live only for the bounding hull
  const sync = (): void => { gap.input.disabled = width.input.disabled = !hull.input.checked; };
  for (const r of [copy, center, hull]) r.input.addEventListener("change", sync);
  sync();
  let answered = false;
  const answer = (ok: boolean): void => { if (!answered) { answered = true; done(ok); } };
  const api = openDialog({ title: "Conversion Settings", width: 420,
    build(body) {
      const rows: HTMLElement[] = [];
      if (show.copy) rows.push(copy.el);
      if (show.centerline) rows.push(h("div", { style: "margin-top:6px" }, center.el));
      if (show.hull) rows.push(h("div", { style: "margin-top:6px" }, hull.el),
        h("div", { class: "pd-row", style: "margin:2px 0 15px 26px;gap:3px;align-items:center" },
          h("label", null, "Gap:"), gap.el, unitLabel(), h("span", { style: "width:18px" }), h("label", null, "Line width:"), width.el, unitLabel()));
      rows.push(h("div", { style: "margin:5px 0" }, del.el));
      body.append(h("div", { "data-k": "convertSettings" }, ...rows));
    },
    cancel() { answer(false); },
    ok() {
      // TransferDataFromWindow
      settings.strategy = hull.input.checked ? "hull" : center.input.checked ? "centerline" : "copy";
      settings.gap = gap.get(); settings.lineWidth = width.get();
      settings.deleteOriginals = del.get();
      answer(true);
      return true;
    } });
  if (!api) answer(false);
}

/**
 * The "Conversion Settings" box the zone dialogs insert at the top when they convert the selection: Use centerlines /
 * Create bounding hull, the hull's Gap, Delete source objects.  apply() is TransferDataFromWindow (after the zone's own
 * values were accepted): the gap is written only for the bounding hull, as DIALOG_RULE_AREA_PROPERTIES does.
 */
export function conversionBox(settings: ConvertSettings, ro: boolean): { el: HTMLElement; apply(): void } {
  const name = "pd-convert-" + (++radioSeq);
  const center = radio(name, "Use centerlines", "convertCenterline"), hull = radio(name, "Create bounding hull", "convertHull");
  (settings.strategy === "hull" ? hull : center).input.checked = true;
  const gap = lenField(settings.gap, { ro, key: "convertGap" });
  const del = checkField(settings.deleteOriginals, "Delete source objects after conversion", { ro, key: "convertDelete" });
  center.input.disabled = hull.input.disabled = ro;
  // OnUpdateUI: m_gap.Enable( m_rbEnvelope->GetValue() )
  const sync = (): void => { gap.input.disabled = ro || !hull.input.checked; };
  center.input.addEventListener("change", sync); hull.input.addEventListener("change", sync); sync();
  const el = h("div", { "data-k": "conversionBox", style: "margin-bottom:10px" }, box("Conversion Settings", center.el, h("div", { style: "margin-top:2px" }, hull.el),
    h("div", { class: "pd-row", style: "margin:2px 0 6px 26px;gap:5px;align-items:center" }, h("label", null, "Gap:"), gap.el, unitLabel()), del.el));
  return { el, apply() {
    if (hull.input.checked) { settings.strategy = "hull"; settings.gap = gap.get(); } else settings.strategy = "centerline";
    settings.deleteOriginals = del.get();
  } };
}
