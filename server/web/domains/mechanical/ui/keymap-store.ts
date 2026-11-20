// keymap-store.ts — a person's own keys for the part studio (ui/keymap.ts has the rules): which commands there
// are, the overrides this person made, and the questions the key handlers and the toolbar ask.
//
// The overrides are kept in this browser (`junction.cad.keymap`), like the other ways a person likes the part
// studio (ui/prefs.ts).  studio.ts hands over the commands when it loads (the tools, the features and their
// default keys), so this file imports neither.
import { useSyncExternalStore } from "react";
import { bindingsOf, chordOf, cleanOverrides, commandFor, rebind, resetBinding, type Binding, type KeyCommand, type Overrides } from "./keymap";

const KEY = "junction.cad.keymap";
let commands: KeyCommand[] = [];
let overrides: Overrides = read();
let bindings: Binding[] = [];
const listeners = new Set<() => void>();

function read(): Overrides {
  try { return cleanOverrides(JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { return {}; }
}
function changed(): void {
  bindings = bindingsOf(commands, overrides);
  for (const fn of Array.from(listeners)) fn();
}
function store(next: Overrides): void {
  overrides = next;
  try { if (Object.keys(next).length) localStorage.setItem(KEY, JSON.stringify(next)); else localStorage.removeItem(KEY); } catch { /* private mode: it lasts as long as the page */ }
  changed();
}

/** The commands that can have a key (studio.ts calls this once, with every tool and feature). */
export function setKeyCommands(list: KeyCommand[]): void { commands = list; changed(); }
export const keyCommands = (): readonly KeyCommand[] => commands;
export const keyBindings = (): readonly Binding[] => bindings;
export const keyOverrides = (): Overrides => overrides;
export const subscribeKeymap = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
/** React: the bindings; re-renders when a key is changed. */
export const useKeyBindings = (): readonly Binding[] => useSyncExternalStore(subscribeKeymap, keyBindings);

/** Give a command a chord (null: none); the commands that had it lose it and are returned. */
export function setKey(id: string, chord: string | null): string[] { const r = rebind(commands, overrides, id, chord); store(r.overrides); return r.taken; }
export function resetKey(id: string): void { store(resetBinding(overrides, id)); }
export function resetAllKeys(): void { store({}); }
/** Replace every override at once (a file a person saved earlier). */
export function loadKeys(v: unknown): void { const clean = cleanOverrides(v); store(Object.fromEntries(Object.entries(clean).filter(([id]) => commands.some((c) => c.id === id)))); }

/** The key a command has now, as it is shown ("M", "Shift+E"), or undefined. */
export const shortcutOf = (id: string): string | undefined => bindings.find((b) => b.id === id)?.chord || undefined;
/** The command a key event starts, if any. */
export function commandForEvent(ev: KeyboardEvent, inSketch: boolean, only?: (b: Binding) => boolean): Binding | null {
  return commandFor(bindings, chordOf(ev), inSketch, only);
}
export const isFeatureCommand = (b: Binding): boolean => b.id.startsWith("f:");
