// editor/kicad-jobs.ts — KiCad's exporters that run in-process on the desktop and that a browser cannot run:
// File > Export > For Older KiCad Version... (both editors), and the board's Specctra DSN..., GenCAD... and IDFv3...
// exports.  The server writes the project out as it is now and runs Junction desktop's own kicad-cli on it
// (server/src/kicad_jobs.rs: `sch|pcb downgrade`, `pcb export specctra|gencad|idf`); the dialogs are KiCad's
// (DIALOG_EXPORT_OLDER_VERSION and DIALOG_DOWNGRADE_REPORT, DIALOG_GENCAD_EXPORT_OPTIONS, DIALOG_EXPORT_IDF3), and the
// files the desktop writes into the chosen folder come as a browser download.
import { E } from "./state";
import { box, checkField, form, grid, h, lenField, messageBox, note, openDialog, radioBox, selectField, textField } from "./pcbdialogs/ui";
import { currentDoc, download, fileStem } from "./download";
import { setStatusBar } from "./appstore";
import { isSch } from "./view";
import { variantNamesForUI } from "./variant";
import { zip } from "../fab/zip";
import { loadProject, saveProject, sub, type JsonObj } from "../dialogs/project";
import { DOWNGRADE_TARGETS, GENCAD_OPTIONS, SCH_VER_VARIANTS, idfFieldNames, idfJobBody, idfSettings, kicadJob, reportRows, variantChoiceEnabled, type CompatReport, type IdfSettings } from "./kicad-jobs-logic";
import { STEP_DEFAULTS, STEP_FORMATS, scaledModels, stepFormatOfName, stepJobBody, withStepExtension, type StepOptions } from "./kicad-jobs-logic";
import { loadPrefs, savePrefs } from "./pcbdialogs/plot-out";
export { DOWNGRADE_TARGETS, GENCAD_OPTIONS, SCH_VER_VARIANTS, idfFieldNames, idfJobBody, idfSettings, kicadJob, reportRows, variantChoiceEnabled };

const TITLE = "Export for Older KiCad Version";

/** SCH_EDITOR_CONTROL / BOARD_EDITOR_CONTROL::ExportForOlderVersion: RunExportForOlderVersion. */
export async function exportForOlderVersion(): Promise<void> {
  const d = currentDoc(); if (!d) return;
  const sch = isSch(), { stem } = fileStem();
  const pass = (p: { target: string; variant?: string; drop?: boolean; dryRun: boolean }) =>
    kicadJob(d.docId, { job: "downgrade", target: p.target, variant: p.variant || "", dropApproximations: !!p.drop, dryRun: p.dryRun });
  // the probe against the oldest target, which drops the most (its variants cover every choice)
  const probe = await pass({ target: DOWNGRADE_TARGETS[DOWNGRADE_TARGETS.length - 1].name, dryRun: true });
  if (probe.error) { messageBox(TITLE, probe.error); return; }
  // EESCHEMA_JOBS_HANDLER::JobDowngrade fills m_foundVariants from the schematic; the board's runner leaves it empty
  const variants = sch ? variantNamesForUI() : [];
  const target = selectField(DOWNGRADE_TARGETS[0].name, DOWNGRADE_TARGETS.map((t) => [t.name, t.name] as [string, string]), { key: "target" });
  const variant = selectField("", [["", "Base design"], ...variants.map((v) => [v, v] as [string, string])], { key: "variant" });
  const dest = textField(`${stem}-kicad${DOWNGRADE_TARGETS[0].id}`, { key: "dest" });
  const drop = checkField(false, "Drop features instead of approximating them", { key: "drop", tip: "Omit features that would otherwise be approximated. This may remove drawing or electrical data from the exported copy." });
  const variantLabel = h("span", null, "Variant:");
  const update = (): void => {
    const on = variantChoiceEnabled(target.get(), variants), t = DOWNGRADE_TARGETS.find((x) => x.name === target.get());
    (variant.input as HTMLInputElement).disabled = !on; variantLabel.classList.toggle("disabled", !on);
    variant.el.title = t && t.schVersion >= SCH_VER_VARIANTS ? "The target supports variants. All variants are exported." : "Choose the variant to flatten into the exported design.";
  };
  target.input.addEventListener("change", update);
  openDialog({ title: TITLE, width: 480, okLabel: "Continue", persist: "exportOlderVersion",
    build(body) {
      body.append(form([["Target version:", target.el], [variantLabel, variant.el], ["Destination folder:", dest.el]]), h("div", { style: "margin-top:8px" }, drop.el),
        note("The exported files are downloaded as a .zip named after the destination folder."));
      update();
    },
    ok() {
      if (!dest.get().trim()) { messageBox("Error", "Choose a destination folder."); return false; }
      const opts = { target: target.get(), variant: variantChoiceEnabled(target.get(), variants) ? variant.get() : "", drop: drop.get() };
      const folder = dest.get().trim().replace(/[\\/]+$/, "").split(/[\\/]/).pop() || stem;
      void (async () => {
        const dry = await pass({ ...opts, dryRun: true });
        if (dry.error || !dry.report) { messageBox(TITLE, dry.error || "kicad-cli gave no report"); return; }
        const go = async (): Promise<void> => {
          const res = await pass({ ...opts, dryRun: false });
          if (res.error || !res.blob) { messageBox(TITLE, res.error || "Nothing was exported."); return; }
          // the destination folder's contents: the schematic folder (<stem>/…, zipped by the server) or the board file
          const out = sch ? res.blob : new Blob([(await zip([{ name: res.name || `${stem}.kicad_pcb`, data: new Uint8Array(await res.blob.arrayBuffer()) }])) as BlobPart], { type: "application/zip" });
          download(out, `${folder}.zip`);
          messageBox(TITLE, `Exported to '${folder}'.`);
        };
        if (dry.report.blocked || dry.report.lossy) openDowngradeReport(opts.target, dry.report, () => { void go(); });
        else await go();
      })();
      return true;
    } });
}

/** DIALOG_DOWNGRADE_REPORT: what the export changes; Export goes on, a blocked export only closes. */
export function openDowngradeReport(targetName: string, rep: CompatReport, onExport: () => void): void {
  const rows = reportRows(rep).map((r) => ({ action: r.action, feature: r.feature, detail: r.detail }));
  openDialog({ title: TITLE, width: 620, okLabel: "Export", noOk: rep.blocked, cancelLabel: rep.blocked ? "Close" : undefined,
    extra: [{ label: "Save Report...", fn: () => download(rep.text, "compatibility-report.txt") }],
    build(body) {
      body.append(h("p", null, rep.blocked ? `This project uses features ${targetName} cannot represent.` : `Exporting to ${targetName} will change some features:`),
        grid([{ key: "action", label: "Action", type: "ro" }, { key: "feature", label: "Feature", type: "ro" }, { key: "detail", label: "Detail", type: "ro" }], rows, { ro: true, height: "220px" }).el,
        note("Your current project is not modified."));
    },
    ok() { if (!rep.blocked) onExport(); return true; } });
}

/** BOARD_EDITOR_CONTROL::ExportSpecctraDSN → PCB_EDIT_FRAME::ExportSpecctraFile. */
export async function exportSpecctraDsn(): Promise<void> {
  const d = currentDoc(); if (!d) return;
  const res = await kicadJob(d.docId, { job: "specctra" });
  if (res.error || !res.blob) { messageBox("Error", `Unable to export, please fix and try again\n\n${res.error || ""}`.trim()); return; }
  download(res.blob, res.name || `${fileStem().stem}.dsn`);
  setStatusBar({ message: "BOARD exported OK." });
}

export function exportGenCad(): void {
  const d = currentDoc(); if (!d) return;
  const file = textField(`${fileStem().stem}.cad`, { key: "file" });
  file.el.title = "Enter a filename if you do not want to use default file names";
  const checks = GENCAD_OPTIONS.map(([k, label]) => [k, checkField(false, label, { key: k })] as const);
  openDialog({ title: "Export to GenCAD", width: 480, persist: "gencadExport",
    build(body) { body.append(form([["Output File:", file.el]]), h("div", { style: "display:grid;gap:3px;margin-top:6px" }, ...checks.map(([, c]) => c.el))); },
    ok() {
      const body: Record<string, unknown> = { job: "gencad" }; for (const [k, c] of checks) body[k] = c.get();
      const name = file.get().trim().split(/[\\/]/).pop() || `${fileStem().stem}.cad`;
      void kicadJob(d.docId, body).then((res) => {
        if (res.error || !res.blob) { messageBox("Error", `Failed to create file '${name}'.${res.error ? "\n\n" + res.error : ""}`); return; }
        download(res.blob, name);
      });
      return true;
    } });
}

export async function exportIdf(): Promise<void> {
  const d = currentDoc(); if (!d) return;
  let pro: JsonObj = {}; try { pro = await loadProject(); } catch { pro = {}; }
  const s = idfSettings(pro), fields = idfFieldNames(E.kdoc as KDoc | null);
  const file = textField(`${fileStem().stem}.emn`, { key: "file" });
  const units = selectField(s.units, [[0, "Millimeters"], [1, "Mils"]], { key: "units" });
  // the radio order of the dialog: board center, drill/place file, grid, user defined
  const ORDER = [2, 0, 1, 3];
  const origin = radioBox("Coordinate Origin", ["Board center origin", "Drill/place file origin", "Grid origin", "User defined origin"], Math.max(0, ORDER.indexOf(s.originMode)), { key: "origin" });
  const x = lenField(s.userOriginX, { key: "x" }), y = lenField(s.userOriginY, { key: "y" });
  const dnp = checkField(!s.includeDNP, "Ignore 'Do not populate' components", { key: "dnp" });
  const unspec = checkField(!s.includeUnspecified, "Ignore 'Unspecified' components", { key: "unspec" });
  const height = checkField(s.calculateHeightFromModels, "Calculate component height from 3D models", { key: "height", tip: "When enabled, any footprint with an explicit height not specified will be exported with the height from its tallest visible 3D model.  When disabled, footprints without an explicit height will not be included in the IDF file." });
  const pn = selectField(fields.includes(s.partNumberField) ? s.partNumberField : "Value", (fields.length ? fields : ["Value"]).map((f) => [f, f] as [string, string]), { key: "pn" });
  pn.el.title = "Which footprint field to export as the part number in the IDF library file";
  const log = h("textarea", { readonly: true, style: "width:100%;height:80px;font-family:monospace" }) as HTMLTextAreaElement;
  const sync = (): void => { const user = origin.get() === 3; for (const f of [x, y]) (f.input as HTMLInputElement).disabled = !user; };
  origin.input.closest("fieldset")?.addEventListener("change", sync);
  openDialog({ title: "Export IDFv3", width: 520, okLabel: "Export", cancelLabel: "Close",
    build(body) {
      body.append(form([["File name:", file.el]]),
        box("Board options", form([["Output units:", units.el]]), origin.el, form([["X position:", x.el, E.units === "in" ? "in" : E.units === "mil" ? "mils" : "mm"], ["Y position:", y.el, E.units === "in" ? "in" : E.units === "mil" ? "mils" : "mm"]])),
        box("Component options", dnp.el, unspec.el, height.el, form([["Part number field:", pn.el, undefined, "Which footprint field to export as the part number in the IDF library file"]])),
        box("Log", log));
      sync();
    },
    ok() {
      // DIALOG_EXPORT_IDF3::OnOKButton → doExport: the dialog stays open with its log
      const now: IdfSettings = { units: units.get(), originMode: ORDER[origin.get()], userOriginX: x.get(), userOriginY: y.get(), includeUnspecified: !unspec.get(), includeDNP: !dnp.get(),
        calculateHeightFromModels: height.get(), partNumberField: pn.get() };
      const name = (file.get().trim().split(/[\\/]/).pop() || `${fileStem().stem}.emn`).replace(/\.emn$/i, "");
      log.value = "";
      void kicadJob(d.docId, idfJobBody(now)).then(async (res) => {
        if (res.error || !res.blob) { log.value = res.error || ""; messageBox("Error", `Failed to create file '${name}.emn'.`); return; }
        download(res.blob, `${name}.zip`);
        log.value = `${name}.emn\n${name}.emp`;
        // the project keeps the settings (m_IdfExportSettings)
        if (!E.viewOnly) await saveProject((p) => { const o = sub(p, "board", "idf_export"); o.units = now.units; o.origin_mode = now.originMode; o.user_origin_x = now.userOriginX; o.user_origin_y = now.userOriginY;
          o.include_unspecified = now.includeUnspecified; o.include_dnp = now.includeDNP; o.calculate_height_from_models = now.calculateHeightFromModels; o.part_number_field = now.partNumberField; }, "IDF export settings").catch(() => undefined);
      });
      return false;
    } });
}

/** BOARD::ComputeBoundingBox( true, true )'s center: the board's and the footprints' Edge.Cuts shapes. */
function boardEdgesCenter(doc: KDoc): [number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const merge = (b: number[] | null | undefined): void => { if (!b) return; x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); };
  const geomBox = KiCadCanvas.geomBox as (g: KGeom) => number[] | null;
  for (const it of doc.items.values()) {
    if (it.kind === "footprint") { for (const g of it.geom || []) if (g.layer === "Edge.Cuts" && g.t !== "text") merge(geomBox(g)); continue; }
    if (/^gr_(line|arc|circle|rect|poly|curve)$/.test(String(it.node[0])) && String((KiCadCanvas.kid(it.node, "layer") || [])[1]) === "Edge.Cuts") merge(it.bbox);
  }
  return isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2] : [0, 0];
}

/**
 * BOARD_EDITOR_CONTROL::ExportSTEP: DIALOG_EXPORT_STEP ("Export 3D Model") with its Export / Close buttons; the
 * command line onExportButton gives kicad-cli runs on the server (kicad_jobs.rs `3d`) and the model comes as a download.
 */
export function exportStep(selectedRefs: string[]): void {
  const d = currentDoc(); if (!d || isSch() || !E.kdoc) return;
  const doc = E.kdoc as KDoc;
  const o: StepOptions = Object.assign({}, STEP_DEFAULTS, loadPrefs("kicad.export-step", STEP_DEFAULTS));
  const variants = variantNamesForUI();
  // TransferDataToWindow: the last path, else the board's name with .step; the format its extension names
  let lastPath = String(loadPrefs("kicad.export-step-path", { path: "" }).path || "") || `${fileStem().stem}.step`;
  const f0 = stepFormatOfName(lastPath); if (f0 >= 0) o.format = f0;
  const fmt = selectField(o.format, STEP_FORMATS.map((f, i) => [i, f.label] as [number, string]), { key: "format" });
  const variant = selectField(variants.indexOf(o.variant) > 0 ? variants.indexOf(o.variant) : 0, variants.map((v, i) => [i, v] as [number, string]), { key: "variant" });
  const file = textField(withStepExtension(lastPath, o.format), { key: "file" });
  file.input.title = "Enter a filename if you do not want to use default file names\nCan be used only when printing the current sheet";
  fmt.input.addEventListener("change", () => { file.set(withStepExtension(file.get(), fmt.get())); });
  const cb = (v: boolean, label: string, key: string, tip?: string) => checkField(v, label, { key, tip });
  const body = cb(o.exportBody, "Export board body", "body");
  const cutVias = cb(o.cutViasInBody, "Cut vias in board body", "cut-vias", "Cut via holes in board body even if conductor layers are not exported.");
  const silk = cb(o.silkscreen, "Export silkscreen", "silk", "Export silkscreen graphics as a set of flat faces.");
  const mask = cb(o.soldermask, "Export solder mask", "mask", "Export solder mask layers as a set of flat faces.");
  const comps = cb(o.components, "Export components", "components");
  const MODES: StepOptions["componentMode"][] = ["all", "selected", "filter"];
  const mode = radioBox("", ["All components", "Only selected", "Components matching filter:"], Math.max(0, MODES.indexOf(o.componentMode)), { key: "component-mode" });
  const compFilter = textField(o.componentFilter, { key: "component-filter" });
  compFilter.input.title = "A list of comma-selected reference designators to export (wildcards are supported)";
  const tracks = cb(o.tracks, "Export tracks and vias", "tracks", "Export tracks and vias on external conductor layers.");
  const pads = cb(o.pads, "Export pads", "pads");
  const zones = cb(o.zones, "Export zones", "zones", "Export zones on external conductor layers.");
  const inner = cb(o.innerCopper, "Export inner conductor layers", "inner");
  const fuse = cb(o.fuseShapes, "Fuse shapes (time consuming)", "fuse", "Combine intersecting geometry into one shape.");
  const fill = cb(o.fillAllVias, "Fill all vias", "fill-vias", "Don't cut via holes in conductor layers.");
  const nets = textField(o.netFilter, { key: "net-filter" });
  nets.input.title = "Only copper items belonging to nets matching this filter will be exported.";
  const ORIGINS: StepOptions["origin"][] = ["drill", "grid", "user", "center"];
  const origin = radioBox("Coordinates", ["Drill/place file origin", "Grid origin", "User defined origin", "Board center origin"], Math.max(0, ORIGINS.indexOf(o.origin)), { key: "origin" });
  const ox = lenField(o.userX, { key: "x" }), oy = lenField(o.userY, { key: "y" });
  const dnp = cb(o.removeDnp, "Ignore 'Do not populate' components", "dnp", "Do not show components marked 'Do not populate'");
  const unspec = cb(o.removeUnspecified, "Ignore 'Unspecified' components", "unspec", "Do not show components with Footprint Type 'Unspecified'");
  const subst = cb(o.substModels, "Substitute similarly named models", "subst", "Replace VRML models with STEP models of the same name");
  const pcurves = cb(o.optimizeStep, "Don't write P-curves to STEP file", "pcurves", "Disables writing parametric curves. Optimizes file size and write/read times, but may reduce compatibility with other software.");
  const tol = selectField(o.tolerance, [[0, "Tight (0.001 mm)"], [1, "Standard (0.01 mm)"], [2, "Loose (0.1 mm)"]], { key: "tolerance" });
  const unitLabel = E.units === "in" ? "in" : E.units === "mil" ? "mils" : "mm";
  // onCbExportComponents / OnComponentModeChange / onUpdateXPos
  const sync = (): void => {
    const on = comps.get();
    mode.enable(on);
    (compFilter.input as HTMLInputElement).disabled = !(on && mode.get() === 2);
    for (const f of [ox, oy]) (f.input as HTMLInputElement).disabled = origin.get() !== 2;
  };
  comps.input.addEventListener("change", sync);
  mode.input.closest("fieldset")?.addEventListener("change", sync);
  origin.input.closest("fieldset")?.addEventListener("change", sync);
  openDialog({ title: "Export 3D Model", width: 760, okLabel: "Export", cancelLabel: "Close",
    build(b) {
      b.append(form([["Format:", fmt.el], ["Variant:", variant.el], ["File:", file.el]]),
        h("div", { style: "display:flex;gap:10px;align-items:flex-start" },
          h("div", { style: "flex:1" }, box("Board Options", body.el, cutVias.el, silk.el, mask.el, comps.el, mode.el, compFilter.el)),
          h("div", { style: "flex:1" }, box("Conductor Options", tracks.el, pads.el, zones.el, inner.el, fuse.el, fill.el, h("div", { class: "pd-lbl" }, "Net filter (supports wildcards):"), nets.el))),
        h("div", { style: "display:flex;gap:10px;align-items:flex-start" },
          h("div", { style: "flex:1" }, origin.el, box("User Defined Origin", form([["X position:", ox.el, unitLabel], ["Y position:", oy.el, unitLabel]]))),
          h("div", { style: "flex:1" }, box("Other Options", dnp.el, unspec.el, subst.el, pcurves.el, form([["Board outline chaining tolerance:", tol.el]])))));
      sync();
      // the "Scaled models detected" warning (KIDIALOG, Model Scale Warning)
      const scaled = scaledModels(doc);
      if (scaled.length && !loadPrefs("kicad.scaled-3d-models-warning", { off: false }).off)
        messageBox("Model Scale Warning", "Scaled models detected.  Model scaling is not reliable for mechanical export.\n\nNon-unity scaled models:\n" + scaled.join("\n"),
          [{ label: "Do not show again", fn: () => savePrefs("kicad.scaled-3d-models-warning", { off: true }) }, { label: "OK" }]);
    },
    ok() {
      const now: StepOptions = { format: fmt.get(), variant: variant.get() > 0 ? variants[variant.get()] : "", exportBody: body.get(), cutViasInBody: cutVias.get(), silkscreen: silk.get(),
        soldermask: mask.get(), components: comps.get(), componentMode: MODES[mode.get()], componentFilter: compFilter.get(), tracks: tracks.get(), pads: pads.get(), zones: zones.get(),
        innerCopper: inner.get(), fuseShapes: fuse.get(), fillAllVias: fill.get(), netFilter: nets.get(), origin: ORIGINS[origin.get()], userX: ox.get(), userY: oy.get(),
        removeDnp: dnp.get(), removeUnspecified: unspec.get(), substModels: subst.get(), optimizeStep: pcurves.get(), tolerance: tol.get() };
      const path = file.get().trim();
      if (!path) { messageBox("Error", "No filename for output file"); return false; }
      savePrefs("kicad.export-step", now);
      savePrefs("kicad.export-step-path", { path });
      lastPath = path;
      const name = path.split(/[\\/]/).pop() || withStepExtension(fileStem().stem, now.format);
      setStatusBar({ message: "Exporting 3D model..." });
      void kicadJob(d.docId, stepJobBody(now, boardEdgesCenter(doc), selectedRefs)).then((res) => {
        setStatusBar({ message: "" });
        if (res.error || !res.blob) { messageBox("3D Export", res.error || "kicad-cli failed"); return; }
        download(res.blob, name);
      });
      return false;
    } });
}
