// keymap.ts — which key starts which tool, and how a person changes that.  Pure: no DOM, no storage.
//
// A command is a tool (tools/*.ts, by its id) or a feature ("f:<type>").  Each has a default chord (the tool's
// `key`, a feature's Shift + letter) and a person may give it another, or none: the overrides are a map
// `{ <command id>: "<chord>" | null }`, kept per person (keymap-store.ts).
//
// A chord is written as it is shown: "M", "Shift+E", "Ctrl+Alt+M", "F8".  Ctrl stands for Ctrl or Cmd.
//
// Where a chord holds:
//   "sketch"   while a sketch is open (the sketch tools); it wins there over the same chord outside
//   "model"    everywhere, unless a sketch tool has the chord while a sketch is open
//   "any"      everywhere (the features: Shift+E extrudes the open sketch)
// So "M" may be Measure outside a sketch and Mirror inside one, and that is not a conflict.  Two commands that
// can both hear a chord at the same moment are.

export type KeyContext = "model" | "sketch" | "any";
export interface KeyCommand { id: string; title: string; context: KeyContext; /** the chord it has when nobody changed it */ chord: string | null }
export interface Binding extends KeyCommand { /** the chord a person gave it (null: they took it away); absent: the default holds */ custom?: boolean; default: string | null }
export type Overrides = { readonly [id: string]: string | null };

const MOD_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS"]);
const NAMES: { [key: string]: string } = { " ": "Space", Delete: "Del", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc" };

/** The chord of a key event ("Shift+E"); null for a modifier alone. */
export function chordOf(ev: { key: string; code?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): string | null {
  if (!ev.key || MOD_KEYS.has(ev.key)) return null;
  const code = ev.code || "";
  // the letter or digit of the key itself, whatever Shift or Alt made of it ("!" is Shift+1, "å" is Alt+A)
  let key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^Numpad\d$/.test(code) ? code.slice(6) : ev.key.length === 1 ? ev.key.toUpperCase() : NAMES[ev.key] || ev.key;
  if (key in NAMES) key = NAMES[key];
  // a shifted symbol is its own key: "?" is "?", not "Shift+/"
  const symbol = key.length === 1 && !/[A-Z0-9]/.test(key);
  return `${ev.ctrlKey || ev.metaKey ? "Ctrl+" : ""}${ev.altKey ? "Alt+" : ""}${ev.shiftKey && !symbol ? "Shift+" : ""}${key}`;
}

/** A chord as typed or stored, in the one spelling chords are compared in; null when it is not one. */
export function normalChord(text: string | null | undefined): string | null {
  if (!text) return null;
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  if (text.trim().endsWith("+") && text.trim() !== "+") parts.push("+");
  if (text.trim() === "+") return "+";
  if (!parts.length) return null;
  let key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  for (const m of mods) if (!["ctrl", "cmd", "meta", "alt", "shift"].includes(m)) return null;
  if (key.length === 1) key = key.toUpperCase(); else if (key in NAMES) key = NAMES[key]; else if (key === "Delete") key = "Del";
  const symbol = key.length === 1 && !/[A-Z0-9]/.test(key);
  return `${mods.has("ctrl") || mods.has("cmd") || mods.has("meta") ? "Ctrl+" : ""}${mods.has("alt") ? "Alt+" : ""}${mods.has("shift") && !symbol ? "Shift+" : ""}${key}`;
}

/** The chords the part studio keeps for itself, with what each does and where ("model": not while a sketch is open). */
export const RESERVED: readonly { chord: string; what: string; context: KeyContext }[] = [
  { chord: "S", what: "Search tools", context: "any" }, { chord: "N", what: "View normal to", context: "any" },
  { chord: "F", what: "Zoom to fit", context: "model" }, { chord: "Z", what: "Zoom to selection", context: "model" },
  { chord: "?", what: "Keyboard shortcuts", context: "any" }, { chord: "Esc", what: "Step back", context: "any" },
  { chord: "Enter", what: "Accept", context: "any" }, { chord: "Tab", what: "The next field", context: "any" },
  { chord: "Del", what: "Delete", context: "sketch" }, { chord: "Backspace", what: "Delete", context: "sketch" }, { chord: "F2", what: "Rename", context: "any" },
  { chord: "Ctrl+Z", what: "Undo", context: "any" }, { chord: "Ctrl+Y", what: "Redo", context: "any" }, { chord: "Ctrl+Shift+Z", what: "Redo", context: "any" },
  { chord: "Ctrl+K", what: "Search tools", context: "any" },
  ...["←", "→", "↑", "↓"].flatMap((a) => [{ chord: a, what: "Turn the view", context: "any" as const }, { chord: "Shift+" + a, what: "Turn the view", context: "any" as const }]),
  ...["←", "→"].flatMap((a) => [{ chord: "Ctrl+" + a, what: "Roll the view", context: "any" as const }, { chord: "Ctrl+Shift+" + a, what: "Roll the view", context: "any" as const }]),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ chord: `Shift+${n}`, what: "A standard view", context: "any" as const })),
];

/** Two contexts in which one chord would be heard by both commands at the same moment. */
export const overlaps = (a: KeyContext, b: KeyContext): boolean => a === b || a === "any" || b === "any";

/** Every command with the chord it has now. */
export function bindingsOf(commands: readonly KeyCommand[], overrides: Overrides = {}): Binding[] {
  return commands.map((c) => {
    const d = normalChord(c.chord);
    if (!(c.id in overrides)) return { ...c, chord: d, default: d };
    const o = normalChord(overrides[c.id]);
    return { ...c, chord: o, default: d, custom: o !== d };
  });
}

/** What the part studio itself uses a chord for where this command is heard, or null. */
export function reservedFor(chord: string, context: KeyContext): string | null {
  const r = RESERVED.find((x) => x.chord === chord && overlaps(x.context, context));
  return r ? r.what : null;
}

/** A chord a person may not give: typing must stay typing, and the part studio's own keys stay its own. */
export function chordProblem(chord: string | null, context: KeyContext): string | null {
  if (!chord) return "Press a key, alone or with Ctrl, Alt or Shift.";
  const r = reservedFor(chord, context);
  if (r) return `${chord} is the part studio's own key: ${r}.`;
  if (/^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta|Dead|Unidentified|Process)$/.test(chord)) return "That key cannot be used.";
  if (/^Ctrl\+(Shift\+)?[CVXAWTNRLFPS]$/.test(chord) || /^(Ctrl\+)?F5$/.test(chord)) return `${chord} belongs to the browser.`;
  return null;
}

/** The commands that have this chord where `context` is heard, other than `but`. */
export function takenBy(bindings: readonly Binding[], chord: string, context: KeyContext, but?: string): Binding[] {
  return bindings.filter((b) => b.id !== but && b.chord === chord && overlaps(b.context, context));
}

/** Every command whose chord another command can also hear: id → the others' ids. */
export function conflictsOf(bindings: readonly Binding[]): { [id: string]: string[] } {
  const out: { [id: string]: string[] } = {};
  for (const b of bindings) {
    if (!b.chord) continue;
    const others = takenBy(bindings, b.chord, b.context, b.id);
    if (others.length) out[b.id] = others.map((o) => o.id);
  }
  return out;
}

/**
 * Give a command a chord (null: none).  When other commands have it, they lose it (`taken`): a chord means one
 * thing.  Returns the overrides as they are afterwards, holding nothing that only repeats a default.
 */
export function rebind(commands: readonly KeyCommand[], overrides: Overrides, id: string, chord: string | null): { overrides: Overrides; taken: string[] } {
  const cmd = commands.find((c) => c.id === id);
  if (!cmd) return { overrides, taken: [] };
  const want = normalChord(chord);
  const next: { [id: string]: string | null } = { ...overrides };
  const taken = want ? takenBy(bindingsOf(commands, overrides), want, cmd.context, id).map((b) => b.id) : [];
  for (const t of taken) next[t] = null;
  next[id] = want;
  for (const c of commands) if (c.id in next && normalChord(next[c.id]) === normalChord(c.chord)) delete next[c.id];
  for (const k of Object.keys(next)) if (!commands.some((c) => c.id === k)) delete next[k];
  return { overrides: next, taken };
}

/** Back to the default chord.  Whatever a person gave that chord to meanwhile keeps it, and the conflict is shown. */
export function resetBinding(overrides: Overrides, id: string): Overrides {
  const next: { [id: string]: string | null } = { ...overrides };
  delete next[id];
  return next;
}

/**
 * The command a chord starts.  While a sketch is open its tools are asked first; `only` narrows the answer to
 * one kind (the sketcher asks for its own tools, the part studio for the rest).
 */
export function commandFor(bindings: readonly Binding[], chord: string | null, inSketch: boolean, only?: (b: Binding) => boolean): Binding | null {
  if (!chord) return null;
  const order: KeyContext[] = inSketch ? ["sketch", "any", "model"] : ["any", "model"];
  for (const ctx of order) { const b = bindings.find((x) => x.context === ctx && x.chord === chord && (!only || only(x))); if (b) return b; }
  return null;
}

/** What is stored is a person's file: keep what is a chord, drop the rest. */
export function cleanOverrides(v: unknown): Overrides {
  const out: { [id: string]: string | null } = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [id, c] of Object.entries(v as { [k: string]: unknown })) {
    if (c === null) out[id] = null; else if (typeof c === "string" && c.length <= 40) { const n = normalChord(c); if (n) out[id] = n; }
  }
  return out;
}
