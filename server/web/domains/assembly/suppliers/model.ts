// model.ts — a supplier's model, as the server's search offers it (server/src/models3d) and as an instance
// remembers where it came from.  Pure: the requests are in api.ts, placing one in place.ts.
//
// A placed model is an ordinary part: a part studio of the project (one that imports the supplier's STEP file,
// or one Junction drew from a standard's dimensions) and an instance of its body.  What makes it a supplier's
// part is the instance's optional `supplier` key, which a reader that does not know it keeps and ignores:
//
//   supplier: { provider, id, name, partNumber, title, description?, url?, generated? }
//
// `title` is the part's name in a bill of materials (the supplier and its part number), `url` the supplier's page.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";

/** One row of GET /api/models3d/search. */
export interface ModelHit {
  provider: string;
  supplier: string;
  id: string;
  part_number: string;
  title: string;
  description: string;
  /** "step", "jpart" (a part studio the server writes), or "" when there is nothing to place */
  format: string;
  url: string;
  image?: string;
  /** the part's outline: an SVG path and the box it is drawn in */
  thumb?: { d: string; box: [number, number, number, number] };
  /** millimetres */
  size?: [number, number, number];
  generated: boolean;
  /**
   * Nothing can be fetched: the supplier's own file is taken from the person, who downloads it from `url` and
   * drops it on the row (a McMaster-Carr number on a server without McMaster's API).  Nothing is drawn instead.
   */
  upload?: boolean;
  note?: string;
  license?: string;
  /** a search to try instead */
  hint?: string;
}

export interface ModelProvider { id: string; name: string; note: string; configured: boolean; needs: string[]; signup: string }
export interface ModelSearch { query: string; results: ModelHit[]; errors: { provider: string; name: string; code: string; message: string }[]; providers: ModelProvider[] }

export interface SupplierInfo extends JsonObject {
  provider: string;
  id: string;
  /** the supplier as a person names it: "McMaster-Carr" */
  name: string;
  partNumber: string;
  /** the name in a bill of materials: "McMaster-Carr 91251A431" */
  title: string;
  description?: string;
  url?: string;
  /** drawn by Junction from a standard's dimensions */
  generated?: boolean;
}

const webLink = (u: unknown): string | undefined => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : undefined);

/** What an instance keeps of the model it shows. */
export function supplierOf(hit: ModelHit): SupplierInfo {
  const out: SupplierInfo = { provider: hit.provider, id: hit.id, name: hit.supplier, partNumber: hit.part_number, title: hit.title };
  if (hit.description) out.description = hit.description;
  const url = webLink(hit.url);
  if (url) out.url = url;
  if (hit.generated) out.generated = true;
  return out;
}

/** The supplier an instance names, or null: anything malformed reads as "no supplier". */
export function supplierInfo(instance: object | null | undefined): SupplierInfo | null {
  const s = instance && ((instance as { supplier?: unknown }).supplier as SupplierInfo | undefined);
  if (!s || typeof s !== "object" || typeof s.title !== "string" || !s.title || typeof s.partNumber !== "string") return null;
  const out = { ...s, provider: String(s.provider || ""), id: String(s.id || ""), name: String(s.name || "") } as SupplierInfo;
  const url = webLink(s.url);
  if (url) out.url = url; else delete out.url;
  return out;
}

/** "McMaster-Carr 91251A431": the name of the project's files for this model, without what a path cannot hold. */
export function fileStem(hit: { title: string }): string {
  const s = hit.title.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
  return (s || "Model").slice(0, 100);
}

/** The part studio the project already has for this model (placed before, by anybody), so it is not made twice. */
export function existingStudio<D extends { docId: string; path: string; docType: string }>(docs: readonly D[], hit: { title: string }): D | undefined {
  const want = (fileStem(hit) + ".jpart").toLowerCase();
  return docs.find((d) => d.docType === "part_studio" && (d.path.split("/").pop() || "").toLowerCase() === want);
}

/**
 * The supplier's own STEP file of this model, kept in the project's models/ folder when it was placed.  With
 * existingStudio it says the project has the supplier's model itself: a part studio of that name alone could be
 * anything a person drew and named so.
 */
export function existingStep<D extends { path: string }>(docs: readonly D[], hit: { title: string }): D | undefined {
  const stem = fileStem(hit).toLowerCase();
  return docs.find((d) => {
    const at = d.path.toLowerCase();
    if (!at.startsWith("models/") || !/\.ste?p$/.test(at)) return false;
    const name = at.slice("models/".length).replace(/\.ste?p$/, "");
    // "name", or "name 2" when the folder already had a file of that name (freeFilePath)
    return name === stem || (name.startsWith(stem + " ") && /^\d+$/.test(name.slice(stem.length + 1)));
  });
}

/** The largest STEP file taken from a person: what the server keeps of a supplier's (MAX_MODEL_BYTES). */
export const MAX_STEP_BYTES = 40 * 1024 * 1024;

/** Whether a file's first bytes are a STEP file's: the ISO 10303-21 header, after a byte-order mark or blank lines. */
export function looksLikeStep(head: Uint8Array): boolean {
  let i = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  const want = "ISO-10303-21";
  if (head.length - i < want.length) return false;
  for (let k = 0; k < want.length; k++) if (head[i + k] !== want.charCodeAt(k)) return false;
  return true;
}

/** Why a file a person hands over for `hit` cannot be its model, in words for them; "" when it can. */
export function stepFileProblem(file: { name: string; size: number }, head: Uint8Array, hit: { supplier: string }): string {
  const from = hit.supplier ? `${hit.supplier}'s page` : "the supplier's page";
  if (!file.size) return `“${file.name}” is empty.`;
  if (!looksLikeStep(head)) return `“${file.name}” is not a STEP file. On ${from}, choose “3-D STEP” as the CAD download and drop that file.`;
  if (file.size > MAX_STEP_BYTES) return `“${file.name}” is too large to place (${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_STEP_BYTES / 1024 / 1024} MB).`;
  return "";
}

/** "8.5 × 8.5 × 25 mm" */
export function sizeText(size: readonly number[] | undefined): string {
  if (!size || size.length !== 3 || !size.every((v) => Number.isFinite(v) && v > 0)) return "";
  const n = (v: number) => String(Math.round(v * 100) / 100);
  return `${n(size[0])} × ${n(size[1])} × ${n(size[2])} mm`;
}
