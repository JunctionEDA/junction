// editor/kicad-jobs-logic.ts — what the KiCad exporters run on the server need besides their dialogs
// (kicad-jobs.ts): the request to server/src/kicad_jobs.rs, KiCad's downgrade targets and report rows, the GenCAD
// options and the IDF settings, kept apart from the editor so they load on their own.
type JsonObj = { [k: string]: unknown };
const obj = (v: unknown): JsonObj => (v && typeof v === "object" && !Array.isArray(v) ? v as JsonObj : {});

/** GetDowngradeTargets (include/downgrade_target.h): the releases a project can be exported back to, newest first,
 *  with that release's SEXPR_SCHEMATIC_FILE_VERSION. */
export const DOWNGRADE_TARGETS: { name: string; id: string; schVersion: number }[] = [
  { name: "KiCad 10.0", id: "10.0", schVersion: 20260306 },
  { name: "KiCad 9.0", id: "9.0", schVersion: 20250114 },
];
/** SCH_VER_VARIANTS: the schematic format that stores variants; an older target flattens one into the export. */
export const SCH_VER_VARIANTS = 20250922;

export interface CompatEntry { bucket: "keep" | "lower" | "drop" | "block"; feature: string; detail: string; count: number }
export interface CompatReport { target: string; entries: CompatEntry[]; lossy: boolean; blocked: boolean; text: string }

/** One kicad-cli job on the server: the dry run's report, or the file it wrote (with its download name). */
export async function kicadJob(docId: string, body: Record<string, unknown>): Promise<{ report?: CompatReport; blob?: Blob; name?: string; error?: string }> {
  let r: Response;
  try {
    r = await fetch(`/api/docs/${encodeURIComponent(docId)}/kicad-job`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { return { error: String((e as Error).message || e) }; }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    let msg = t || r.statusText; try { const j = JSON.parse(t) as { message?: string }; if (j && j.message) msg = j.message; } catch { /* plain text */ }
    return { error: msg };
  }
  if ((r.headers.get("content-type") || "").includes("json")) { const j = await r.json() as { report?: CompatReport }; return { report: j.report }; }
  const cd = r.headers.get("content-disposition") || "", m = /filename="([^"]*)"/.exec(cd);
  return { blob: await r.blob(), name: m ? m[1] : "" };
}

/** DIALOG_DOWNGRADE_REPORT's rows: the approximated, dropped and blocking features ("feature (n)" past one). */
export function reportRows(rep: CompatReport): { action: string; feature: string; detail: string }[] {
  const out: { action: string; feature: string; detail: string }[] = [];
  for (const [bucket, label] of [["lower", "Approximate"], ["drop", "Drop"], ["block", "Cannot export"]] as const)
    for (const e of rep.entries) if (e.bucket === bucket) out.push({ action: label, feature: e.count > 1 ? `${e.feature} (${e.count})` : e.feature, detail: e.detail });
  return out;
}

/** DIALOG_EXPORT_OLDER_VERSION::updateVariantChoice: a variant can be picked only for a target that cannot store variants. */
export function variantChoiceEnabled(targetName: string, variants: string[]): boolean {
  const t = DOWNGRADE_TARGETS.find((x) => x.name === targetName);
  return !!t && t.schVersion < SCH_VER_VARIANTS && variants.length > 0;
}

/** GENCAD_EXPORTER through DIALOG_GENCAD_EXPORT_OPTIONS ("Export to GenCAD"): the options in GENCAD_EXPORT_OPT order. */
export const GENCAD_OPTIONS: [string, string][] = [
  ["flipBottomPads", "Flip bottom footprint padstacks"],
  ["uniquePins", "Generate unique pin names"],
  ["individualShapes", "Generate a new shape for each footprint instance (do not reuse shapes)"],
  ["useDrillOrigin", "Use drill/place file origin as origin"],
  ["storeOriginCoords", "Save the origin coordinates in the file"],
];
/** IDF_EXPORT_SETTINGS as the project file keeps it (board.idf_export, PROJECT_FILE): units MM 0 / MILS 1, origin
 *  DRILL 0 / GRID 1 / CENTER 2 / USER 3 (IDF_SETTINGS), the user origin in mm. */
export interface IdfSettings { units: number; originMode: number; userOriginX: number; userOriginY: number; includeUnspecified: boolean; includeDNP: boolean; calculateHeightFromModels: boolean; partNumberField: string }
export function idfSettings(pro: JsonObj): IdfSettings {
  const s = obj(obj(pro.board).idf_export), num = (v: unknown, d: number) => (typeof v === "number" && isFinite(v) ? v : d), bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const units = num(s.units, 0), origin = num(s.origin_mode, 2);
  return { units: units === 1 ? 1 : 0, originMode: origin >= 0 && origin <= 3 ? origin : 2, userOriginX: num(s.user_origin_x, 0), userOriginY: num(s.user_origin_y, 0),
    includeUnspecified: bool(s.include_unspecified, true), includeDNP: bool(s.include_dnp, true), calculateHeightFromModels: bool(s.calculate_height_from_models, true),
    partNumberField: typeof s.part_number_field === "string" ? s.part_number_field : "Value" };
}
/** The CLI's options for those settings: the user origin in the output units (the job keeps it in m_units). */
export function idfJobBody(s: IdfSettings): Record<string, unknown> {
  const per = s.units === 1 ? 1 / 0.0254 : 1;
  return { job: "idf", units: s.units === 1 ? "mils" : "mm", origin: ["drill", "grid", "center", "user"][s.originMode], userOriginX: s.userOriginX * per, userOriginY: s.userOriginY * per,
    noUnspecified: !s.includeUnspecified, noDnp: !s.includeDNP, explicitHeight: !s.calculateHeightFromModels, partNumberField: s.partNumberField };
}
/** DIALOG_EXPORT_IDF3::TransferDataToWindow: every footprint field name but the reference, sorted (a std::set). */
export function idfFieldNames(doc: KDoc | null): string[] {
  const names = new Set<string>();
  if (doc) for (const it of doc.items.values()) if (it.kind === "footprint") for (const p of KiCadCanvas.kids(it.node, "property")) { const n = KiCadCanvas.str(p[1] as SNode); if (n && n !== "Reference") names.add(n); }
  return [...names].sort();
}

/** DIALOG_EXPORT_STEP's formats in its choice order: the label, the kicad-cli command (c_formatCommand) and the extension. */
export const STEP_FORMATS: { label: string; cmd: string; ext: string }[] = [
  { label: "STEP", cmd: "step", ext: "step" }, { label: "GLB (Binary glTF)", cmd: "glb", ext: "glb" }, { label: "XAO", cmd: "xao", ext: "xao" },
  { label: "BREP (OCCT)", cmd: "brep", ext: "brep" }, { label: "PLY (ASCII)", cmd: "ply", ext: "ply" }, { label: "STL", cmd: "stl", ext: "stl" },
  { label: "STPZ", cmd: "stpz", ext: "stpz" }, { label: "U3D", cmd: "u3d", ext: "u3d" }, { label: "PDF", cmd: "3dpdf", ext: "pdf" },
];
/** c_formatExtToChoice: the format a file name's extension picks, -1 for none. */
export function stepFormatOfName(name: string): number {
  const m = /\.([^./\\]+)$/.exec(name); if (!m) return -1;
  const ext = m[1].toLowerCase();
  if (ext === "stp") return 0;
  return STEP_FORMATS.findIndex((f) => f.ext === ext);
}
/** OnFmtChoiceOptionChanged: the file name with the format's extension (added, or put in place of the last one). */
export function withStepExtension(path: string, format: number): string {
  const ext = STEP_FORMATS[format] ? STEP_FORMATS[format].ext : "step";
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")), dot = path.lastIndexOf(".");
  return dot === -1 || dot < sep ? `${path}.${ext}` : `${path.slice(0, dot)}.${ext}`;
}
/** The dialog's choices (DIALOG_EXPORT_STEP's controls, kept per dialog as DIALOG_SHIM keeps them). */
export interface StepOptions {
  format: number; variant: string; exportBody: boolean; cutViasInBody: boolean; silkscreen: boolean; soldermask: boolean;
  components: boolean; componentMode: "all" | "selected" | "filter"; componentFilter: string;
  tracks: boolean; pads: boolean; zones: boolean; innerCopper: boolean; fuseShapes: boolean; fillAllVias: boolean; netFilter: string;
  origin: "drill" | "grid" | "user" | "center"; userX: number; userY: number;
  removeDnp: boolean; removeUnspecified: boolean; substModels: boolean; optimizeStep: boolean; tolerance: number;
}
/** DIALOG_EXPORT_STEP_BASE's initial values. */
export const STEP_DEFAULTS: StepOptions = { format: 0, variant: "", exportBody: true, cutViasInBody: false, silkscreen: false, soldermask: false,
  components: true, componentMode: "all", componentFilter: "", tracks: false, pads: false, zones: false, innerCopper: false, fuseShapes: false, fillAllVias: false, netFilter: "",
  origin: "drill", userX: 0, userY: 0, removeDnp: false, removeUnspecified: false, substModels: true, optimizeStep: true, tolerance: 0 };
/** The chaining tolerance choices (m_choiceTolerance) in mm. */
export const STEP_TOLERANCES = [0.001, 0.01, 0.1];
/**
 * onExportButton's kicad-cli command line as the job's options (server/src/kicad_jobs.rs `3d`): the board center is
 * passed as a user origin, as the dialog does; `selected` is the references of the selected footprints (getComponentFilter).
 */
export function stepJobBody(o: StepOptions, boardCenter: [number, number], selected: string[]): Record<string, unknown> {
  const filter = !o.components ? "" : o.componentMode === "selected" ? selected.join(",") : o.componentMode === "filter" ? o.componentFilter : "";
  const user = o.origin === "user" ? [o.userX, o.userY] : o.origin === "center" ? boardCenter : null;
  return { job: "3d", format: (STEP_FORMATS[o.format] || STEP_FORMATS[0]).cmd, noUnspecified: o.removeUnspecified, noDnp: o.removeDnp, substModels: o.substModels,
    noOptimizeStep: !o.optimizeStep, noBoardBody: !o.exportBody, noComponents: !o.components, includeTracks: o.tracks, includePads: o.pads, includeZones: o.zones,
    includeInnerCopper: o.innerCopper, includeSilkscreen: o.silkscreen, includeSoldermask: o.soldermask, fuseShapes: o.fuseShapes, cutViasInBody: o.cutViasInBody,
    fillAllVias: o.fillAllVias, variant: o.variant, netFilter: o.netFilter, componentFilter: o.components && o.componentMode !== "all" ? filter : "",
    origin: user ? "user" : o.origin, userOriginX: user ? user[0] : 0, userOriginY: user ? user[1] : 0, minDistance: STEP_TOLERANCES[o.tolerance] ?? 0.01 };
}
/** The first five models with a non-unity scale (the dialog's "Scaled models detected" warning lists them). */
export function scaledModels(doc: KDoc | null): string[] {
  const out: string[] = []; if (!doc) return out;
  const K = (globalThis as unknown as { KiCadCanvas: KiCadCanvasApi }).KiCadCanvas;
  for (const it of doc.items.values()) {
    if (it.kind !== "footprint") continue;
    for (const m of K.kids(it.node, "model")) {
      const sc = K.kid(m, "scale"), xyz = sc ? K.kid(sc, "xyz") : null;
      if (xyz && (Number(xyz[1]) !== 1 || Number(xyz[2]) !== 1 || Number(xyz[3]) !== 1)) out.push(String(m[1]));
    }
    if (out.length >= 5) break;
  }
  return out;
}
