// store.ts — the project's custom features as the part studio's page has them: read live from the project's own
// document (window.JunctionShell, platform/doctabs/shell.ts), offered to the toolbar and the tool search as
// feature types (core/dynamic.ts), and written back through the same document.
//
// A feature type `script:<id>.<hash>` is one version of one script.  Its definition (the dialog) is found, in
// this order, in the library (the version that is current there), among the versions the editor is working on,
// and in the features of the open part studios, which each carry their own copy.  Whatever the source of a
// manifest, it goes through `cleanScriptRef` before anything is drawn from it.
import type { Item, ItemChange, JsonObject } from "../../../shared/itemdoc/itemdoc";
import { dynamicFeatures } from "../core/dynamic";
import type { FeatureDefinition } from "../core/feature";
import { toolsChanged } from "../core/tool";
import { featuresOf } from "../document/format";
import { studioExtensions, type PartStudio } from "../ui/studio";
import { scriptsOf, type LibraryScript } from "./library";
import { SCRIPT_KEY, cleanScriptRef, definitionOf, parseScriptType, scriptType, type ScriptRef } from "./manifest";

interface ShellLike { getState(): { items: Item[]; live: boolean; version: number }; subscribe(fn: () => void): () => void; commit(changes: ItemChange[]): void }
const shell = (): ShellLike | null => (typeof window !== "undefined" && (window as unknown as { JunctionShell?: ShellLike }).JunctionShell) || null;

const NONE: LibraryScript[] = [];
let lib: LibraryScript[] = NONE, libOf: Item[] | null = null;
let version = 0;
const listeners = new Set<() => void>();
const studios = new Set<PartStudio>();
const working = new Map<string, ScriptRef>();
let defs = new Map<string, FeatureDefinition>();
let listed: FeatureDefinition[] | null = null;

function changed(): void {
  version++;
  defs = new Map(); listed = null;
  toolsChanged();
  for (const fn of Array.from(listeners)) fn();
}

/** The project's document as it is (empty when the project has none yet, or outside the project shell). */
export function libraryItems(): Item[] { const s = shell(); return s ? s.getState().items : []; }
/** The project's custom features. */
export function library(): LibraryScript[] {
  hear();
  const items = libraryItems();
  if (items !== libOf) { libOf = items; lib = items.length ? scriptsOf(items) : NONE; }
  return lib;
}
/** Whether the library can be reached at all (false on a page without the project shell). */
export const libraryAvailable = (): boolean => !!shell();
/** Write to the library.  Returns false when it cannot be reached. */
export function commitLibrary(changes: ItemChange[]): boolean {
  const s = shell();
  if (!s) return false;
  if (changes.length) s.commit(changes);
  return true;
}
export const subscribeLibrary = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const libraryVersion = (): number => version;

/** Let a version the editor is working on be found by its type (it is not in the library yet, or not saved). */
export function registerWorking(ref: ScriptRef): string {
  const type = scriptType(ref.id, ref.hash);
  if (!working.has(type)) { working.set(type, ref); if (working.size > 60) working.delete(working.keys().next().value as string); defs.delete(type); }
  return type;
}

function find(type: string): FeatureDefinition | undefined {
  const t = parseScriptType(type);
  if (!t) return undefined;
  const have = defs.get(type);
  if (have) return have;
  let def: FeatureDefinition | undefined;
  const inLib = library().find((s) => s.id === t.id && s.hash === t.hash);
  if (inLib) def = definitionOf(inLib);
  else if (working.has(type)) def = definitionOf(working.get(type)!, { toolbar: false });
  else {
    for (const studio of studios) {
      const doc = studio.doc; if (!doc) continue;
      const f = featuresOf(doc).find((x) => x.featureType === type);
      const raw = f && (f.params as JsonObject)[SCRIPT_KEY];
      const ref = raw ? cleanScriptRef({ ...(raw as object), id: t.id }) : null;
      if (ref) { def = { ...definitionOf(ref, { toolbar: false }), type }; break; }
    }
  }
  if (def) defs.set(type, def);
  return def;
}

dynamicFeatures.push({
  get: find,
  list: () => listed || (listed = library().map((s) => { const d = definitionOf(s); defs.set(d.type, d); return d; })),
});

// The project's document is listened to for as long as a studio is open: a script somebody saves appears in
// everybody's Custom features drop-down at once.  (The shell is made by the tab bar; should it come later than
// the studio, or be replaced, the next look at the library finds the new one.)
let heard: ShellLike | null = null, stopHearing: (() => void) | null = null;
function hear(): void {
  const s = studios.size ? shell() : null;
  if (s === heard) return;
  if (stopHearing) stopHearing();
  heard = s; stopHearing = s ? s.subscribe(changed) : null;
}
studioExtensions.push((studio) => {
  studios.add(studio);
  hear();
  changed();
  return () => { studios.delete(studio); hear(); defs = new Map(); };
});
