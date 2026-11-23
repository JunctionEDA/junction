// library.ts — a project's custom features: where they are kept and every edit of them.  Pure.
//
// They live in the project's own document (project.jproj, platform/doctabs/shell.ts), one item each, beside
// the tab order: shared live with everybody in the project, versioned and restored with it, in its archive and
// its GitHub sync, and so reusable from every part studio of the project.
//
//   { id: "cfs:<script id>", type: "feature-script", name, source, manifest, order }
//
// `source` is the script's text and `manifest` what it declares (script/manifest.ts), worked out in the sandbox
// when it was saved.  The source is one value: two people saving the same script at once, the later save wins
// (the editor says when the script changed under it).  A feature made from a script carries its own copy
// (`params.$script`), so a part studio builds the same whatever happens to the library; `versionOf` says how a
// feature's copy stands against it.
import { addedChange, byOrder, modifiedChange, newId, orderBetween, removedChange, type Item, type ItemChange, type JsonObject } from "../../../shared/itemdoc/itemdoc";
import { SCRIPT_KEY, cleanScriptRef, defaultsOf, parseScriptType, scriptType, type ScriptManifest, type ScriptRef } from "./manifest";

export const SCRIPT_ITEM = "feature-script";
const itemId = (id: string) => `cfs:${id}`;

export interface LibraryScript extends ScriptRef { order: string }

/** The project's custom features, in their order.  Items that are not a readable script are left out. */
export function scriptsOf(items: Iterable<Item>): LibraryScript[] {
  const mine: (Item & { order?: string })[] = [];
  for (const it of items) if (it.type === SCRIPT_ITEM && it.id.startsWith("cfs:")) mine.push(it as Item & { order?: string });
  const out: LibraryScript[] = [];
  for (const it of byOrder(mine)) {
    const ref = cleanScriptRef({ id: it.id.slice(4), name: it.name, source: it.source, manifest: it.manifest });
    if (ref) out.push({ ...ref, order: typeof it.order === "string" ? it.order : "" });
  }
  return out;
}
const find = (items: Iterable<Item>, id: string): Item | undefined => { for (const it of items) if (it.id === itemId(id) && it.type === SCRIPT_ITEM) return it; return undefined; };

/** A name nobody has yet: "Lighten plate", "Lighten plate 2", … */
export function freeName(items: Iterable<Item>, stem: string): string {
  const taken = new Set(scriptsOf(items).map((s) => s.name.toLowerCase()));
  const base = stem.trim().slice(0, 70) || "Custom feature";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Changes that put a script into the library (a new one), or bring the one with that id up to date. */
export function saveScript(items: Iterable<Item>, s: { id?: string; name: string; source: string; manifest: ScriptManifest }): { changes: ItemChange[]; id: string } {
  const all = Array.from(items);
  const id = s.id || newId();
  const had = find(all, id);
  if (had) {
    const next = { ...had, name: s.name, source: s.source, manifest: s.manifest as unknown as JsonObject };
    const ch = modifiedChange(had, next);
    return { changes: ch ? [ch] : [], id };
  }
  const last = byOrder(all.filter((it) => it.type === SCRIPT_ITEM) as (Item & { order?: string })[]).pop();
  const item: Item = { id: itemId(id), type: SCRIPT_ITEM, name: s.name, source: s.source, manifest: s.manifest as unknown as JsonObject, order: orderBetween(last && typeof last.order === "string" ? last.order : null, null) };
  return { changes: [addedChange(item)], id };
}
export function renameScript(items: Iterable<Item>, id: string, name: string): ItemChange[] {
  const had = find(items, id), clean = name.trim().slice(0, 80);
  if (!had || !clean) return [];
  const ch = modifiedChange(had, { ...had, name: clean });
  return ch ? [ch] : [];
}
export function deleteScript(items: Iterable<Item>, id: string): ItemChange[] {
  const had = find(items, id);
  return had ? [removedChange(had)] : [];
}
export function duplicateScript(items: Iterable<Item>, id: string): { changes: ItemChange[]; id: string } | null {
  const all = Array.from(items), src = scriptsOf(all).find((s) => s.id === id);
  if (!src) return null;
  return saveScript(all, { name: freeName(all, `${src.name} copy`), source: src.source, manifest: src.manifest });
}

/** The file a script is exported as, and read back from: its source, as it is. */
export const exportName = (name: string): string => `${name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "custom feature"}.feature.js`;
export const importName = (file: string): string => file.replace(/\.feature\.js$|\.js$|\.txt$/i, "").trim().slice(0, 80);

// ---------------------------------------------------------------- features made from scripts

export type VersionState = "current" | "changed" | "missing";
/** How a feature's own copy of its script stands against the library. */
export function versionOf(library: readonly LibraryScript[], featureType: string): VersionState | null {
  const t = parseScriptType(featureType);
  if (!t) return null;
  const s = library.find((x) => x.id === t.id);
  return !s ? "missing" : s.hash === t.hash ? "current" : "changed";
}

/**
 * A feature brought up to the library's version of its script: its type, its copy of the script, and a value for
 * every parameter the new version adds (values of parameters that are gone are dropped).
 */
export function updatedFeature(feature: Item & { featureType: string; params: JsonObject }, s: ScriptRef): Item & { featureType: string; params: JsonObject } {
  const defaults = defaultsOf(s.manifest);
  const params: JsonObject = { [SCRIPT_KEY]: { id: s.id, name: s.name, hash: s.hash, source: s.source, manifest: s.manifest as unknown as JsonObject } };
  for (const p of s.manifest.params) params[p.key] = feature.params[p.key] !== undefined && sameShape(feature.params[p.key], defaults[p.key]) ? feature.params[p.key] : defaults[p.key];
  // what is not a parameter's value stays (expressions and their units, kept by the dialog under keys of their own)
  for (const k of Object.keys(feature.params)) if (k.startsWith("$") && k !== SCRIPT_KEY) params[k] = feature.params[k];
  return { ...feature, featureType: scriptType(s.id, s.hash), params };
}
const shape = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const sameShape = (a: unknown, b: unknown): boolean => shape(a) === shape(b) || a === null || b === null;
