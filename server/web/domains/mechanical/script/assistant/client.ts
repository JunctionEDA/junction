// client.ts — the assistant's model: the Messages API, called from the browser with the person's own API key.
//
// Junction's server holds no model key (server/src/ai.rs says why), so the editor's assistant works the way an
// outside agent does, with whichever account the person has: they paste an API key once and choose a model from
// the list their key can use.  Both are kept in this browser only (localStorage) and are sent nowhere but to the
// API.  That is the limit to state plainly: a key kept in the browser can be read by any script that runs on
// this site, so the settings say to use a key made for this purpose, with a spending limit.
//
// Which model is the person's choice from `models.list()`: no model is named in this code.
import Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest } from "./loop";

export interface AssistantSettings { apiKey: string; model: string; modelName: string; maxOutput: number }
export interface ModelChoice { id: string; name: string; maxOutput: number }

const KEY = "junction.cad.assistant";
export function readSettings(): AssistantSettings | null {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<AssistantSettings> | null;
    return s && typeof s.apiKey === "string" && s.apiKey && typeof s.model === "string" && s.model ? { apiKey: s.apiKey, model: s.model, modelName: s.modelName || s.model, maxOutput: Number(s.maxOutput) || 16000 } : null;
  } catch (e) { return null; }
}
export function writeSettings(s: AssistantSettings | null): void {
  try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch (e) { /* private mode: the key lasts for this page only */ }
}

const sdk = (apiKey: string) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });

/** An error whose message is for the person; `retryable` asks the loop to send the turn again. */
class ModelError extends Error { constructor(message: string, readonly retryable = false) { super(message); this.name = "ModelError"; } }

function explain(err: unknown): ModelError {
  if (err instanceof Anthropic.AuthenticationError) return new ModelError("The API key was not accepted. Check it in the assistant's settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return new ModelError("This API key may not use that model. Choose another model in the assistant's settings.");
  if (err instanceof Anthropic.NotFoundError) return new ModelError("That model is no longer offered. Choose another in the assistant's settings.");
  if (err instanceof Anthropic.RateLimitError) return new ModelError("The API is rate-limiting this key. Wait a little and ask again.");
  if (err instanceof Anthropic.BadRequestError) return new ModelError(`The API did not accept the request: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new ModelError("The connection to the API was lost.", true);
  if (err instanceof Anthropic.APIError) return new ModelError(`The API answered with an error (${err.status ?? "no status"}). Ask again in a moment.`);
  // not the API's: a tool input that could not be parsed, or the stream ending early
  return new ModelError(err instanceof Error ? err.message : String(err), true);
}

/** The models this key can use, newest first as the API lists them. */
export async function listModels(apiKey: string): Promise<ModelChoice[]> {
  const out: ModelChoice[] = [];
  try {
    for await (const m of sdk(apiKey).models.list()) {
      out.push({ id: m.id, name: m.display_name || m.id, maxOutput: Number((m as { max_tokens?: number }).max_tokens) || 16000 });
      if (out.length >= 100) break;
    }
  } catch (err) { throw explain(err); }
  return out;
}

export function modelClient(settings: AssistantSettings): ModelClient {
  const client = sdk(settings.apiKey);
  // adaptive thinking where the model has it; a model that refuses the field is asked again without it, once
  let thinking = true;
  const send = async (req: ModelRequest): Promise<Anthropic.Message> => {
    const stream = client.messages.stream({
      model: settings.model,
      max_tokens: Math.max(4096, Math.min(32000, settings.maxOutput)),
      system: req.system, tools: req.tools, messages: req.messages,
      cache_control: { type: "ephemeral" },
      ...(thinking ? { thinking: { type: "adaptive" as const } } : {}),
    }, { signal: req.signal });
    if (req.onText) stream.on("text", req.onText);
    try { return await stream.finalMessage(); }
    catch (err) {
      if (err instanceof Anthropic.BadRequestError && thinking) { thinking = false; return send(req); }
      throw explain(err);
    }
  };
  return { send };
}
