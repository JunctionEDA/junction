// model.ts — a supplier's model, as the server's search offers it (server/src/models3d) and as an instance
// remembers where it came from.  Pure: the requests are in api.ts, placing one in place.ts.
//
// A placed model is an ordinary part: a part studio of the project (one that imports the supplier's STEP file,
// or one Junction drew from a standard's dimensions) and an instance of its body.  What makes it a supplier's
// part is the instance's optional `supplier` key, which a reader that does not know it keeps and ignores:
//
//   supplier: { provider, id, name, partNumber, title, description?, url?, generated?, equivalent? }
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
  equivalent: boolean;
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
  /** stands in for the supplier's own model */
  equivalent?: boolean;
}

const webLink = (u: unknown): string | undefined => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : undefined);

/** What an instance keeps of the model it shows. */
export function supplierOf(hit: ModelHit): SupplierInfo {
  const out: SupplierInfo = { provider: hit.provider, id: hit.id, name: hit.supplier, partNumber: hit.part_number, title: hit.title };
  if (hit.description) out.description = hit.description;
  const url = webLink(hit.url);
  if (url) out.url = url;
  if (hit.generated) out.generated = true;
  if (hit.equivalent) out.equivalent = true;
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

/** "8.5 × 8.5 × 25 mm" */
export function sizeText(size: readonly number[] | undefined): string {
  if (!size || size.length !== 3 || !size.every((v) => Number.isFinite(v) && v > 0)) return "";
  const n = (v: number) => String(Math.round(v * 100) / 100);
  return `${n(size[0])} × ${n(size[1])} × ${n(size[2])} mm`;
}
