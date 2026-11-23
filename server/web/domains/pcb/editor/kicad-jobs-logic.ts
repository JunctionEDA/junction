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
