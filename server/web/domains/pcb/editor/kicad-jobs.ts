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
