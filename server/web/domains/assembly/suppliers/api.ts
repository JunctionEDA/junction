// api.ts — the server's supplier search (server/src/models3d): what matches a query, and one model's file.
import { rawFetch } from "../../../platform/documents/rawfetch";
import type { ModelHit, ModelSearch } from "./model";

async function fail(r: Response): Promise<never> {
  let message = "";
  try { const body = await r.clone().json() as { error?: string; message?: string }; message = body.message || body.error || ""; } catch (e) { message = await r.text().catch(() => ""); }
  throw new Error(message || `${r.status} ${r.statusText}`);
}

/** Every provider's models for a query.  `signal` drops a search the person has typed past. */
export async function searchModels(q: string, signal?: AbortSignal): Promise<ModelSearch> {
  const r = await rawFetch()(`/api/models3d/search?q=${encodeURIComponent(q)}`, { credentials: "same-origin", signal });
  if (!r.ok) await fail(r);
  return (await r.json()) as ModelSearch;
}

/** A model's file: a STEP file's bytes, or the text of a part studio. */
export async function fetchModel(hit: Pick<ModelHit, "provider" | "id">): Promise<{ format: "step" | "jpart"; data: Blob }> {
  const r = await rawFetch()(`/api/models3d/model?provider=${encodeURIComponent(hit.provider)}&id=${encodeURIComponent(hit.id)}`, { credentials: "same-origin" });
  if (!r.ok) await fail(r);
  return { format: r.headers.get("x-model-format") === "jpart" ? "jpart" : "step", data: await r.blob() };
}
