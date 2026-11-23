// Assistant.tsx — the editor's "describe the feature" box: a request goes to the assistant (assistant/loop.ts),
// which writes or revises the script and tries it on the part until it is right; what it does is listed as it
// happens, with the pictures it looked at, and it ends with a proposal the person accepts or discards.
//
// The model is the person's own (assistant/client.ts): with no key set, the box asks for one and says where
// else the same work can be done (an agent connected through the MCP endpoint).  A page that wants another
// model (a test's scripted one) sets `window.JunctionScriptAssistant.model`.
import type Anthropic from "@anthropic-ai/sdk";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Select } from "../../../../shared/components/Select";
import { cx } from "../../../../shared/util";
import type { PartStudio } from "../../ui/studio";
import { listModels, modelClient, readSettings, writeSettings, type AssistantSettings, type ModelChoice } from "../assistant/client";
import { requestMessage, runAssistant, type AssistantEvent, type ModelClient } from "../assistant/loop";
import type { PartSummary } from "../report-text";
import { STARTER, type ScriptEditor } from "./editor-state";
import { workbenchOf } from "./workbench";

declare global { interface Window { JunctionScriptAssistant?: { model?: ModelClient | null } } }

type Entry =
  | { kind: "you"; text: string }
  | { kind: "say"; text: string }
  | { kind: "tool"; name: string; ok: boolean; summary: string; png?: string }
  | { kind: "note"; text: string; bad?: boolean };

interface SessionState { entries: Entry[]; running: boolean; streaming: string }

/** One conversation with the assistant, for as long as the editor is open. */
export class AssistantSession {
  private state: SessionState = { entries: [], running: false, streaming: "" };
  private listeners = new Set<() => void>();
  private messages: Anthropic.MessageParam[] = [];
  private abort: AbortController | null = null;
  /** the script as the assistant last knew it: a follow-up says so when the person changed it since */
  private known: string | null = null;
  private proven = new Set<string>();
  constructor(readonly studio: PartStudio, readonly editor: ScriptEditor) {}
  getState = (): SessionState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<SessionState>): void { this.state = { ...this.state, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }
  private add(e: Entry): void { this.set({ entries: [...this.state.entries, e] }); }

  stop(): void { if (this.abort) this.abort.abort(); }
  reset(): void { this.stop(); this.messages = []; this.known = null; this.proven = new Set(); this.set({ entries: [], running: false, streaming: "" }); }

  async ask(request: string, model: ModelClient): Promise<void> {
    if (this.state.running || !request.trim()) return;
    const ed = this.editor.getState();
    const source = ed.proposal ? ed.proposal.source : ed.source;
    const workbench = workbenchOf(this.studio, this.editor);
    this.add({ kind: "you", text: request.trim() });
    this.set({ running: true, streaming: "" });
    let part: PartSummary | null = null;
    try { part = await workbench.part(); } catch (e) { /* the request goes without it; get_part can still be asked */ }
    const first = !this.messages.length;
    const text = first || this.known !== source
      ? requestMessage({ request, source, part, scriptIsStarter: source === STARTER })
      : request.trim();
    this.messages.push({ role: "user", content: text });
    this.abort = new AbortController();
    const onEvent = (e: AssistantEvent) => {
      if (e.type === "delta") this.set({ streaming: this.state.streaming + e.text });
      else if (e.type === "text") { this.set({ streaming: "" }); this.add({ kind: "say", text: e.text }); }
      else if (e.type === "tool") { this.set({ streaming: "" }); this.add({ kind: "tool", name: e.name, ok: e.ok, summary: e.summary, png: e.png }); }
      else if (e.type === "proposal") { this.known = e.source; this.editor.propose({ source: e.source, summary: e.summary }); }
      else if (e.type === "stopped") { if (e.reason !== "done" && e.reason !== "aborted") this.add({ kind: "note", text: e.message || "The assistant stopped.", bad: true }); else if (e.reason === "aborted") this.add({ kind: "note", text: "Stopped." }); }
    };
    try { await runAssistant({ model, workbench, messages: this.messages, onEvent, signal: this.abort.signal, proven: this.proven }); }
    catch (e) { this.add({ kind: "note", text: e instanceof Error ? e.message : String(e), bad: true }); }
    this.abort = null;
    this.set({ running: false, streaming: "" });
  }
}

const sessions = new WeakMap<ScriptEditor, AssistantSession>();
export function sessionOf(studio: PartStudio, editor: ScriptEditor): AssistantSession {
  let s = sessions.get(editor);
  if (!s) { s = new AssistantSession(studio, editor); sessions.set(editor, s); }
  return s;
}

function Settings({ onDone, current }: { onDone(s: AssistantSettings | null): void; current: AssistantSettings | null }) {
  const [key, setKey] = useState(current ? current.apiKey : "");
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [model, setModel] = useState(current ? current.model : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    setBusy(true); setError("");
    try { const list = await listModels(key.trim()); setModels(list); if (!list.some((m) => m.id === model)) setModel(list[0] ? list[0].id : ""); if (!list.length) setError("This key can use no model."); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setModels(null); }
    setBusy(false);
  };
  const chosen = models ? models.find((m) => m.id === model) : null;
  return (
    <div className="flex flex-col gap-2 p-2 text-sm" data-assistant-settings>
      <p className="note m-0">The assistant writes and tests scripts with a model of your own account. Junction's server keeps no model key: paste an Anthropic API key here. It is kept in this browser only and sent only to the API. Use a key made for this, with a spending limit.</p>
      <label className="flex items-center gap-2"><span className="w-16 flex-none text-ink-2">API key</span>
        <input className="input mono flex-1 min-w-0" type="password" autoComplete="off" value={key} aria-label="API key" data-assistant-key onChange={(ev) => { setKey(ev.target.value); setModels(null); }} />
        <button type="button" className="btn sm" disabled={!key.trim() || busy} onClick={() => void load()}>{busy ? "Checking…" : "Check"}</button>
      </label>
      {models && models.length ? (
        <label className="flex items-center gap-2"><span className="w-16 flex-none text-ink-2">Model</span>
          <Select className="input flex-1 min-w-0" value={model} label="Model" onChange={(v) => setModel(v)} options={models.map((m) => ({ value: m.id, label: m.name }))} />
        </label>
      ) : null}
      {error ? <p className="callout err m-0" role="alert">{error}</p> : null}
      <div className="flex items-center gap-2">
        <button type="button" className="btn sm primary" disabled={!chosen} onClick={() => { const s = { apiKey: key.trim(), model: chosen!.id, modelName: chosen!.name, maxOutput: chosen!.maxOutput }; writeSettings(s); onDone(s); }}>Use this model</button>
        {current ? <button type="button" className="btn sm ghost" onClick={() => { writeSettings(null); onDone(null); }}>Forget the key</button> : null}
        {current ? <button type="button" className="btn sm ghost" onClick={() => onDone(current)}>Cancel</button> : null}
      </div>
      <p className="note m-0">Without a key, an agent connected to this project through the MCP endpoint can write features the same way (the cad_script tools).</p>
    </div>
  );
}

export function Assistant({ studio, editor }: { studio: PartStudio; editor: ScriptEditor }) {
  const session = sessionOf(studio, editor);
  const s = useSyncExternalStore(session.subscribe, session.getState);
  const proposal = useSyncExternalStore(editor.subscribe, () => editor.getState().proposal);
  const [settings, setSettings] = useState<AssistantSettings | null>(() => readSettings());
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [s.entries.length, s.streaming, proposal]);

  const injected = typeof window !== "undefined" && window.JunctionScriptAssistant && window.JunctionScriptAssistant.model;
  if ((!settings && !injected) || editing) return <Settings current={settings} onDone={(x) => { setSettings(x); setEditing(false); }} />;
  const send = () => {
    const model = injected || (settings ? modelClient(settings) : null);
    if (!model || !text.trim() || s.running) return;
    const t = text; setText("");
    void session.ask(t, model);
  };
  return (
    <div className="flex flex-col h-full min-h-0 text-sm" data-assistant={s.running ? "running" : "idle"}>
      <div ref={list} className="flex-1 min-h-0 overflow-y-auto px-2 py-1.5 flex flex-col gap-1.5" data-assistant-log>
        {!s.entries.length ? <p className="note m-0">Describe the feature you want, or what to change in the script. The assistant writes it, tries it on this part and shows you the result before anything is changed.</p> : null}
        {s.entries.map((e, i) => e.kind === "you" ? <p key={i} className="m-0 font-medium" data-entry="you">{e.text}</p>
          : e.kind === "say" ? <p key={i} className="m-0 whitespace-pre-wrap text-ink-2" data-entry="say">{e.text}</p>
          : e.kind === "note" ? <p key={i} className={cx("callout m-0", e.bad && "err")} data-entry="note">{e.text}</p>
          : (
            <div key={i} className="flex items-start gap-2" data-entry="tool" data-tool={e.name} data-ok={e.ok ? "yes" : "no"}>
              <span className={cx("pill flex-none", e.ok ? "ok" : "err")}>{e.name === "run_script" ? (e.ok ? "ran" : "failed") : e.name === "get_part" ? "part" : "proposal"}</span>
              <span className="flex-1 min-w-0 text-xs text-ink-2">{e.summary}</span>
              {e.png ? <img className="flex-none w-24 h-[72px] rounded-sm border border-line object-cover" alt="The result of this run" src={`data:image/png;base64,${e.png}`} /> : null}
            </div>
          ))}
        {s.streaming ? <p className="m-0 whitespace-pre-wrap text-ink-3">{s.streaming}</p> : s.running ? <p className="m-0 text-ink-3" role="status">Working…</p> : null}
        {proposal ? (
          <div className="rounded-sm border border-line p-2 flex flex-col gap-1.5" data-proposal>
            <p className="m-0 whitespace-pre-wrap">{proposal.summary}</p>
            <p className="note m-0">The change is shown above and previewed on the part. Nothing is changed until you accept.</p>
            <div className="flex gap-2">
              <button type="button" className="btn sm primary" data-proposal-accept onClick={() => editor.acceptProposal()}>Accept</button>
              <button type="button" className="btn sm" data-proposal-discard onClick={() => editor.discardProposal()}>Discard</button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="flex items-end gap-1.5 border-t border-line p-1.5">
        <textarea className="input flex-1 min-w-0 h-14 resize-none py-1 leading-snug" value={text} placeholder="Describe the feature, or what to change" aria-label="Describe the feature" data-assistant-prompt
          onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); send(); } }} />
        <div className="flex flex-col gap-1">
          {s.running ? <button type="button" className="btn sm" onClick={() => session.stop()}>Stop</button>
            : <button type="button" className="btn sm primary" data-assistant-send disabled={!text.trim() || !!proposal} title={proposal ? "Accept or discard the change first" : undefined} onClick={send}>Send</button>}
          {settings && !injected ? <button type="button" className="btn sm ghost text-xs" title={`Model: ${settings.modelName}. Change the model or the key.`} onClick={() => setEditing(true)}>Model</button> : null}
        </div>
      </div>
    </div>
  );
}
