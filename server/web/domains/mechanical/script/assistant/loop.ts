// loop.ts — the assistant that writes custom features: the conversation with the model and the tools it has.
//
// The loop is the ordinary one: send the conversation, run the tools the model asks for, send the results
// back, until it hands over a script (`propose_script`), stops with something to say, or runs out of turns.
// It owns no model and no kernel: the model is a `ModelClient` (assistant/client.ts talks to the Messages API
// with the person's own key; a test hands in a scripted one) and the tools reach the part through a
// `ScriptWorkbench` (the editor's is ui/workbench.ts, over the modelling worker).
//
// What the model is given is all in files: its instructions (assets/prompts/assistant.md), the guide
// (assets/prompts/guide.md), the API's types (assets/feature-api.d.ts), the examples (assets/exemplars) and each
// tool's description (assets/prompts/tool-*.md).  Improve those files, not this one.
import type Anthropic from "@anthropic-ai/sdk";
import { API_DTS, EXEMPLARS, PROMPTS } from "../../generated/script-assets";
import { sourceHash } from "../manifest";
import { reportText, type PartSummary, type RunReport } from "../report-text";

export interface ModelRequest { system: Anthropic.TextBlockParam[]; tools: Anthropic.Tool[]; messages: Anthropic.MessageParam[]; signal?: AbortSignal; onText?(delta: string): void }
/** One round with the model.  Rejects with an Error whose message is for the person (a missing key, a refused request). */
export interface ModelClient { send(req: ModelRequest): Promise<Anthropic.Message> }

/** What the tools reach: the part the feature is being written for. */
export interface ScriptWorkbench {
  /** Build a script on the current part, changing nothing, and report (script/report.ts). */
  run(source: string, params: { [key: string]: unknown }, view: string): Promise<RunReport>;
  /** The part just before the feature. */
  part(): Promise<PartSummary>;
  /** What the script declares, or what is wrong with its declaration. */
  describe(source: string): Promise<{ ok: boolean; problems: { message: string; line?: number }[]; params?: { key: string; type: string }[] }>;
}

export type AssistantEvent =
  | { type: "text"; text: string }
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; ok: boolean; summary: string; png?: string }
  | { type: "proposal"; source: string; summary: string }
  | { type: "stopped"; reason: "done" | "turns" | "aborted" | "refused" | "error"; message?: string };

const VIEWS = ["iso", "top", "bottom", "front", "back", "left", "right"];

/** The model's instructions with everything it reads: stable text, so it is cached from the second request on. */
export function systemPrompt(): string {
  const examples = EXEMPLARS.map((e) => `### ${e.id}.js\n\n\`\`\`js\n${e.source.trim()}\n\`\`\``).join("\n\n");
  return [
    PROMPTS.assistant.trim(),
    "# The guide\n\n" + PROMPTS.guide.trim(),
    "# The API: feature-api.d.ts\n\n```ts\n" + API_DTS.trim() + "\n```",
    "# The examples that ship\n\n" + examples,
  ].join("\n\n---\n\n");
}

export function toolDefinitions(): Anthropic.Tool[] {
  const tool = (name: string, input_schema: Anthropic.Tool.InputSchema): Anthropic.Tool => ({ name, description: (PROMPTS[`tool-${name}`] || "").trim(), input_schema, eager_input_streaming: true });
  return [
    tool("run_script", { type: "object", properties: { source: { type: "string", description: "The whole script." }, params: { type: "object", description: "Parameter values by key for this run.", additionalProperties: true }, view: { type: "string", enum: VIEWS } }, required: ["source"] }),
    tool("get_part", { type: "object", properties: {} }),
    tool("propose_script", { type: "object", properties: { source: { type: "string", description: "The whole script, exactly as it last ran." }, summary: { type: "string", description: "Two or three sentences for the person." } }, required: ["source", "summary"] }),
  ];
}

/** The first message of a request: the part, the open script, and what the person asked. */
export function requestMessage(o: { request: string; source: string | null; part: PartSummary | null; scriptIsStarter?: boolean }): string {
  const parts: string[] = [];
  parts.push(o.part && o.part.bodies.length
    ? "The current part, just before the feature (mm):\n```json\n" + JSON.stringify(o.part) + "\n```"
    : "The part studio has no body yet: only a feature that makes its own part from nothing can be shown working here.");
  if (o.source && o.source.trim()) parts.push((o.scriptIsStarter ? "The editor holds only the starter template; replace it:" : "The script that is open in the editor:") + "\n```js\n" + o.source.trim() + "\n```");
  else parts.push("The editor is empty: write a new script.");
  parts.push("The request:\n" + o.request.trim());
  return parts.join("\n\n");
}

export interface AssistantRun {
  model: ModelClient;
  workbench: ScriptWorkbench;
  /** the conversation so far; this call appends to it (hand the same array back for a follow-up request) */
  messages: Anthropic.MessageParam[];
  onEvent(e: AssistantEvent): void;
  signal?: AbortSignal;
  maxTurns?: number;
  /** the sources that have built a sound result in this conversation, by hash; hand the same set back for a follow-up */
  proven?: Set<string>;
}

const isObject = (v: unknown): v is { [k: string]: unknown } => !!v && typeof v === "object" && !Array.isArray(v);
const errorResult = (id: string, text: string): Anthropic.ToolResultBlockParam => ({ type: "tool_result", tool_use_id: id, is_error: true, content: text });

/** Work on the last user message of `messages` until there is a proposal or nothing more to do. */
export async function runAssistant(o: AssistantRun): Promise<{ proposal: { source: string; summary: string } | null }> {
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }];
  const tools = toolDefinitions();
  /** sources that built a sound result in this conversation, by hash: what may be proposed */
  const good = o.proven || new Set<string>();
  let retries = 0;

  for (let turn = 0; turn < (o.maxTurns ?? 16); turn++) {
    if (o.signal?.aborted) { o.onEvent({ type: "stopped", reason: "aborted" }); return { proposal: null }; }
    let message: Anthropic.Message;
    try {
      message = await o.model.send({ system, tools, messages: o.messages, signal: o.signal, onText: (delta) => o.onEvent({ type: "delta", text: delta }) });
      retries = 0;
    } catch (e) {
      if (o.signal?.aborted) { o.onEvent({ type: "stopped", reason: "aborted" }); return { proposal: null }; }
      // a tool input that could not be parsed, or a dropped connection, is worth one more go; the client marks those
      if ((e as { retryable?: boolean }).retryable && retries++ < 2) { turn--; continue; }
      o.onEvent({ type: "stopped", reason: "error", message: e instanceof Error ? e.message : String(e) });
      return { proposal: null };
    }

    const text = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    if (text) o.onEvent({ type: "text", text });
    // a refusal can cut a tool call off mid-input: nothing of that turn is run
    if (message.stop_reason === "refusal") { o.onEvent({ type: "stopped", reason: "refused", message: "The model declined this request." }); return { proposal: null }; }
    const calls = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (message.stop_reason === "max_tokens" && calls.length) { o.onEvent({ type: "stopped", reason: "error", message: "The model's answer was cut off before it finished a script. Ask again, perhaps for something smaller." }); return { proposal: null }; }
    o.messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "pause_turn") continue;
    if (!calls.length) { o.onEvent({ type: "stopped", reason: "done" }); return { proposal: null }; }

    const results: Anthropic.ToolResultBlockParam[] = [];
    let proposal: { source: string; summary: string } | null = null;
    for (const call of calls) {
      const input = call.input;
      // inputs stream unvalidated (eager_input_streaming): check each against what the tool takes before running it
      if (!isObject(input)) { results.push(errorResult(call.id, JSON.stringify({ INVALID_JSON: JSON.stringify(input) }))); continue; }
      try {
        if (call.name === "run_script") {
          if (typeof input.source !== "string" || !input.source.trim() || (input.params !== undefined && !isObject(input.params)) || (input.view !== undefined && !VIEWS.includes(input.view as string))) { results.push(errorResult(call.id, JSON.stringify({ INVALID_JSON: JSON.stringify(input).slice(0, 2000) }))); continue; }
          const d = await o.workbench.describe(input.source);
          if (!d.ok) {
            const why = d.problems.map((p) => p.message + (p.line && !/line \d+/.test(p.message) ? ` (line ${p.line})` : "")).join("\n");
            o.onEvent({ type: "tool", name: "run_script", ok: false, summary: d.problems[0]?.message || "The script does not read." });
            results.push(errorResult(call.id, `The script could not be read, so nothing was built:\n${why}`));
            continue;
          }
          const report = await o.workbench.run(input.source, (input.params as { [k: string]: unknown }) || {}, (input.view as string) || "iso");
          const ok = report.status !== "error" && report.sound;
          if (ok) good.add(sourceHash(input.source));
          const png = report.png;
          const words = reportText(report);
          o.onEvent({ type: "tool", name: "run_script", ok, summary: words.split("\n").slice(0, 2).join(" "), png });
          const content: Anthropic.ToolResultBlockParam["content"] = [{ type: "text", text: words }];
          if (png) content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: png } });
          results.push({ type: "tool_result", tool_use_id: call.id, content, ...(report.status === "error" ? { is_error: true } : {}) });
        } else if (call.name === "get_part") {
          const part = await o.workbench.part();
          o.onEvent({ type: "tool", name: "get_part", ok: true, summary: `${part.bodies.length} ${part.bodies.length === 1 ? "body" : "bodies"}` });
          results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(part) });
        } else if (call.name === "propose_script") {
          if (typeof input.source !== "string" || typeof input.summary !== "string" || !input.source.trim()) { results.push(errorResult(call.id, JSON.stringify({ INVALID_JSON: JSON.stringify(input).slice(0, 2000) }))); continue; }
          if (!good.has(sourceHash(input.source))) {
            o.onEvent({ type: "tool", name: "propose_script", ok: false, summary: "Not run yet: sent back to be run first." });
            results.push(errorResult(call.id, "This exact source has not built a sound result with run_script in this conversation. Run it, look at the report and the picture, and propose it when it is right."));
            continue;
          }
          proposal = { source: input.source, summary: input.summary.trim() };
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Shown to the person as a change to accept or discard." });
        } else results.push(errorResult(call.id, `There is no tool called ${call.name}.`));
      } catch (e) {
        results.push(errorResult(call.id, `The tool failed: ${e instanceof Error ? e.message : String(e)}`));
        o.onEvent({ type: "tool", name: call.name, ok: false, summary: e instanceof Error ? e.message : String(e) });
      }
    }
    // every result of a turn goes back in one message
    o.messages.push({ role: "user", content: results });
    if (proposal) { o.onEvent({ type: "proposal", ...proposal }); o.onEvent({ type: "stopped", reason: "done" }); return { proposal }; }
  }
  o.onEvent({ type: "stopped", reason: "turns", message: "The assistant used all its turns without a script it was satisfied with. Ask again, or say more about what is wrong." });
  return { proposal: null };
}
