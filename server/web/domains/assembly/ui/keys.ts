// keys.ts — a person's own keys for the assembly, and the few ways they like its chrome to behave.  The rules of
// rebinding are the part studio's (mechanical ui/keymap.ts, pure); what is kept is the assembly's own, in this
// browser, apart from the part studio's keys: "F" may fix an instance here and fit the view there.
import { useSyncExternalStore } from "react";
import { bindingsOf, chordOf, chordProblem, cleanOverrides, commandFor, rebind, resetBinding, type Binding, type KeyCommand, type KeyContext, type KeymapStore, type Overrides } from "../../mechanical/api-ui";

const KEY = "junction.asm.keymap", PREFS = "junction.asm.prefs";

/** The chords the assembly keeps for itself: they cannot be given to a tool. */
export const RESERVED: readonly { chord: string; what: string; context: KeyContext }[] = [
  { chord: "S", what: "Search tools", context: "any" }, { chord: "Ctrl+K", what: "Search tools", context: "any" }, { chord: "Alt+C", what: "Search tools", context: "any" },
  { chord: "?", what: "Keyboard shortcuts", context: "any" }, { chord: "Esc", what: "Step back", context: "any" }, { chord: "Enter", what: "Accept", context: "any" },
  { chord: "Del", what: "Delete", context: "any" }, { chord: "Backspace", what: "Delete", context: "any" }, { chord: "F2", what: "Rename", context: "any" },
  { chord: "Ctrl+Shift+Z", what: "Redo", context: "any" },
  ...["←", "→", "↑", "↓"].flatMap((a) => [{ chord: a, what: "Turn the view", context: "any" as const }, { chord: "Shift+" + a, what: "Turn the view", context: "any" as const }]),
  ...["←", "→"].flatMap((a) => [{ chord: "Ctrl+" + a, what: "Roll the view", context: "any" as const }, { chord: "Ctrl+Shift+" + a, what: "Roll the view", context: "any" as const }]),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ chord: `Shift+${n}`, what: "A standard view", context: "any" as const })),
];

function read<T>(key: string, clean: (v: unknown) => T): T { try { return clean(JSON.parse(localStorage.getItem(key) || "{}")); } catch { return clean({}); } }
function write(key: string, v: object): void { try { if (Object.keys(v).length) localStorage.setItem(key, JSON.stringify(v)); else localStorage.removeItem(key); } catch { /* private mode: it lasts as long as the page */ } }

let source: (() => KeyCommand[]) | null = null;
let commands: KeyCommand[] = [];
let overrides: Overrides = read(KEY, cleanOverrides);
let bindings: Binding[] = [];
const listeners = new Set<() => void>();
const tell = (): void => { for (const fn of Array.from(listeners)) fn(); };
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function ready(): void { if (!commands.length && source) { commands = source(); bindings = bindingsOf(commands, overrides); } }
function store(next: Overrides): void { overrides = next; write(KEY, next); bindings = bindingsOf(commands, overrides); tell(); }

/** Where the commands that can have a key come from (ui/commands.ts says so once). */
export function setKeyCommands(from: () => KeyCommand[]): void { source = from; commands = []; }
export const keyBindings = (): readonly Binding[] => { ready(); return bindings; };
/** The key a command has now, as it is shown ("F", "Shift+G"), or undefined. */
export const shortcutOf = (id: string): string | undefined => keyBindings().find((b) => b.id === id)?.chord || undefined;
/** The command a key event starts, if any. */
export const commandForEvent = (ev: KeyboardEvent): Binding | null => commandFor(keyBindings(), chordOf(ev), false);

export const assemblyKeys: KeymapStore = {
  use: () => useSyncExternalStore(subscribe, keyBindings),
  overrides: () => overrides,
  setKey: (id, chord) => { ready(); const r = rebind(commands, overrides, id, chord); store(r.overrides); return r.taken; },
  resetKey: (id) => store(resetBinding(overrides, id)),
  resetAll: () => store({}),
  load: (v) => { ready(); const clean = cleanOverrides(v); store(Object.fromEntries(Object.entries(clean).filter(([id]) => commands.some((c) => c.id === id)))); },
  problem: (chord, context) => chordProblem(chord, context, RESERVED, "the assembly"),
};

// ---------------------------------------------------------------- preferences
export interface AssemblyPrefs {
  /** the variant each drop-down of the toolbar used last (Pattern ▾ → Circular pattern) */
  toolVariant: { [menu: string]: string };
  /** a right click opens the ring of eight tools round the pointer, above the menu */
  markingMenu: boolean;
  /** which sections of the left dock are folded */
  folded: { [section: string]: boolean };
}
const DEFAULTS: AssemblyPrefs = { toolVariant: {}, markingMenu: true, folded: {} };
let prefs: AssemblyPrefs = read(PREFS, (v) => (v && typeof v === "object" ? { ...DEFAULTS, ...(v as Partial<AssemblyPrefs>), toolVariant: { ...((v as AssemblyPrefs).toolVariant || {}) }, folded: { ...((v as AssemblyPrefs).folded || {}) } } : DEFAULTS));
const prefListeners = new Set<() => void>();
export const getPrefs = (): AssemblyPrefs => prefs;
export function setPrefs(patch: Partial<AssemblyPrefs>): void { prefs = { ...prefs, ...patch }; write(PREFS, prefs); for (const fn of Array.from(prefListeners)) fn(); }
export function usePref<K extends keyof AssemblyPrefs>(key: K): AssemblyPrefs[K] { return useSyncExternalStore((fn) => { prefListeners.add(fn); return () => { prefListeners.delete(fn); }; }, () => prefs[key]); }
