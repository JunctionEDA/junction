// KeymapDialog.tsx — a person's own keys: every tool and feature with the key it has, a click to give it
// another (press the key; Backspace takes it away), the default back with one button.  A key another command
// has is shown before it is taken; the part studio's own keys (S, N, Esc, the view keys) cannot be given away.
// The rules are ui/keymap.ts; what is kept, ui/keymap-store.ts.
import { useEffect, useMemo, useState } from "react";
import { cx } from "../../../shared/util";
import { useStudio } from "./hooks";
import { chordOf, conflictsOf, takenBy, type Binding } from "./keymap";
import { partStudioKeys, type KeymapStore } from "./keymap-store";
import { Sheet } from "./Sheet";
import type { PartStudio } from "./studio";

const WHERE = { model: "Part studio", sketch: "In a sketch", any: "Everywhere" } as const;

export function KeymapDialog({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => !!s.ui?.keymap);
  return <KeymapSheet open={open} store={partStudioKeys} close={() => { studio.setUi({ keymap: false }); studio.viewport.canvas.focus(); }} toast={(text, ms) => studio.host.toast(text, ms)} />;
}

/**
 * The sheet itself, for any editor's keys: the part studio's (above) and the assembly's.  `where` names the
 * contexts in the second column; `note` is the line at the foot; `file` the name keys are saved under.
 */
export function KeymapSheet({ open, store, close: shut, toast, where = WHERE, note = "A key may mean one thing in a sketch and another outside it. Your keys are kept in this browser; Save… and Load… carry them to another.", file = "junction-cad-keys" }: {
  open: boolean; store: KeymapStore; close(): void; toast(text: string, ms?: number): void; where?: { readonly [context: string]: string }; note?: string; file?: string;
}) {
  const { setKey, resetKey, resetAll: resetAllKeys, load: loadKeys, overrides: keyOverrides, problem: chordProblem } = store;
  const bindings = store.use();
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "changed" | "conflicts">("all");
  /** the command whose key is being pressed, and what was pressed when it cannot simply be taken */
  const [capture, setCapture] = useState<{ id: string; chord?: string; problem?: string; taken?: Binding[] } | null>(null);
  const conflicts = useMemo(() => conflictsOf(bindings), [bindings]);
  const close = () => { setCapture(null); shut(); };
  useEffect(() => { if (!open) { setQ(""); setOnly("all"); setCapture(null); } }, [open]);
  useEffect(() => {
    if (!capture || capture.chord) return;
    const key = (ev: KeyboardEvent) => {
      ev.preventDefault(); ev.stopPropagation();
      const b = bindings.find((x) => x.id === capture.id); if (!b) return;
      if (ev.key === "Escape") { setCapture(null); return; }
      if (ev.key === "Backspace" || ev.key === "Delete") { setKey(b.id, null); setCapture(null); return; }
      const chord = chordOf(ev); if (!chord) return;
      const problem = chordProblem(chord, b.context);
      if (problem) { setCapture({ id: b.id, chord, problem }); return; }
      const taken = takenBy(bindings, chord, b.context, b.id);
      if (taken.length) { setCapture({ id: b.id, chord, taken }); return; }
      setKey(b.id, chord); setCapture(null);
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [capture, bindings]);
  if (!open) return null;
  const words = q.trim().toLowerCase();
  const rows = bindings.filter((b) => (!words || b.title.toLowerCase().includes(words) || (b.chord || "").toLowerCase() === words) && (only === "all" || (only === "changed" ? b.custom : !!conflicts[b.id])))
    .slice().sort((a, b) => a.context.localeCompare(b.context) || a.title.localeCompare(b.title));
  const changed = bindings.filter((b) => b.custom).length, clashing = Object.keys(conflicts).length;
  const title = (id: string) => bindings.find((b) => b.id === id)?.title || id;
  const save = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ junction: "cad-keys", keys: keyOverrides() }, null, 2)], { type: "application/json" }));
    a.download = `${file}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const load = (file: File | undefined) => { if (file) void file.text().then((t) => { try { const v = JSON.parse(t); loadKeys(v && v.keys ? v.keys : v); toast("Keys loaded", 1500); } catch { toast("That file is not a set of keys.", 3000); } }); };
  return (
    <Sheet title="Keyboard shortcuts" name="keymap" onClose={close} attrs={{ "data-changed": String(changed), "data-conflicts": String(clashing) }}
      actions={<>
        <button type="button" className="btn sm ghost" data-keymap-save title="Save your keys as a file, to load in another browser" onClick={save}>Save…</button>
        <label className="btn sm ghost cursor-pointer" title="Load keys from a file saved here">Load…<input type="file" accept="application/json,.json" className="hidden" data-keymap-load onChange={(ev) => { load(ev.target.files?.[0]); ev.target.value = ""; }} /></label>
        <button type="button" className="btn sm ghost" data-keymap-reset-all disabled={!changed} onClick={() => resetAllKeys()}>Reset all</button>
      </>}>
      <div className="flex flex-none items-center gap-2 px-3 py-2 border-b border-line">
        <input type="text" className="flex-1 min-w-0" placeholder="Find a tool, or type a key…" aria-label="Find a tool" value={q} data-keymap-search onChange={(ev) => setQ(ev.target.value)} />
        <span className="seg">
          <button type="button" className={cx(only === "all" && "on")} data-keymap-only="all" onClick={() => setOnly("all")}>All</button>
          <button type="button" className={cx(only === "changed" && "on")} data-keymap-only="changed" onClick={() => setOnly("changed")}>Changed{changed ? ` (${changed})` : ""}</button>
          <button type="button" className={cx(only === "conflicts" && "on")} data-keymap-only="conflicts" onClick={() => setOnly("conflicts")}>Conflicts{clashing ? ` (${clashing})` : ""}</button>
        </span>
      </div>
      <div className="overflow-y-auto min-h-40" role="table" aria-label="Keys">
        {rows.length ? rows.map((b) => {
          const cap = capture && capture.id === b.id ? capture : null, clash = conflicts[b.id];
          return (
            <div key={b.id} role="row" className={cx("flex items-center gap-2 px-3 min-h-8 border-b border-line last:border-b-0", cap && "bg-sel-soft")} data-key-row={b.id} data-key-title={b.title} data-key-chord={b.chord || ""} data-key-custom={b.custom || undefined} data-key-conflict={clash ? clash.join(" ") : undefined}>
              <span className="flex-1 min-w-0 truncate" role="cell">{b.title}</span>
              <span className="flex-none w-24 text-ink-3 text-xs" role="cell">{where[b.context] || b.context}</span>
              <span className="flex flex-none items-center justify-end gap-1.5 w-[21rem]" role="cell">
                {cap && cap.problem ? <span className="text-err text-xs truncate" data-key-problem>{cap.problem}</span> : null}
                {cap && cap.taken ? <>
                  <span className="text-xs truncate" data-key-taken={cap.taken.map((t) => t.id).join(" ")}><span className="kbd">{cap.chord}</span> is {cap.taken.map((t) => t.title).join(", ")}</span>
                  <button type="button" className="btn sm primary" data-key-take onClick={() => { setKey(b.id, cap.chord!); setCapture(null); }}>Take it</button>
                </> : null}
                {cap && cap.chord ? <button type="button" className="btn sm" data-key-again onClick={() => setCapture({ id: b.id })}>Another</button> : null}
                {clash && !cap ? <span className="text-err text-xs truncate" title={`Also ${clash.map(title).join(", ")}: only one of them runs`} data-key-clash>also {clash.map(title).join(", ")}</span> : null}
                {cap && !cap.chord ? <span className="text-ink-2 text-xs" data-key-waiting>Press a key · Backspace: none · Esc</span> : null}
                <button type="button" className={cx("btn sm min-w-20 justify-center mono", cap && !cap.chord && "on", !b.chord && "text-ink-3")} aria-label={`Key for ${b.title}: ${b.chord || "none"}. Change`} data-key-set onClick={() => setCapture(cap && !cap.chord ? null : { id: b.id })}>{b.chord || "none"}</button>
                <button type="button" className={cx("btn sm ghost", !b.custom && "invisible")} title={`Back to ${b.default || "no key"}`} data-key-reset onClick={() => { resetKey(b.id); setCapture(null); }}>Reset</button>
              </span>
            </div>
          );
        }) : <p className="note px-3 py-2 m-0">Nothing here.</p>}
      </div>
      <p className="note flex-none m-0 px-3 py-1.5 border-t border-line text-xs">{note}</p>
    </Sheet>
  );
}
