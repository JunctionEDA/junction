// manifest.ts — what a custom feature's script declares, as data: its title, icon and parameters.  Pure; the
// page and the worker both use it.
//
// The manifest is worked out by running the script's top level in the sandbox (script/sandbox.ts `describe`)
// and is stored beside the source, in the project's library and in every feature made from it, so the page can
// draw the dialog without running anything.  A stored manifest is somebody else's data (a collaborator's page
// wrote it): `cleanManifest` is the only way one is read, and it keeps nothing it does not recognise.  The icon
// in particular is never markup from the document: it is a name from ICONS or path data checked character by
// character, turned into markup here.
import type { JsonObject } from "../../../shared/itemdoc/itemdoc";
import type { FeatureDefinition, ParamField } from "../core/feature";

export const API_VERSION = 1;
/** the key in a script feature's `params` that holds its script; everything else there is a parameter value */
export const SCRIPT_KEY = "$script";
/** `featureType` of a feature made from a script: `script:<script id>.<hash of the source>` */
export const SCRIPT_TYPE = "script";

export type ParamType = "length" | "angle" | "number" | "integer" | "boolean" | "enum" | "text" | "face" | "faces" | "edge" | "edges" | "body" | "bodies" | "sketch";
const PARAM_TYPES: readonly ParamType[] = ["length", "angle", "number", "integer", "boolean", "enum", "text", "face", "faces", "edge", "edges", "body", "bodies", "sketch"];
export const isPick = (t: ParamType): boolean => t === "face" || t === "faces" || t === "edge" || t === "edges" || t === "body" || t === "bodies" || t === "sketch";

export interface ManifestParam {
  key: string; type: ParamType; label: string; hint?: string;
  default?: number | boolean | string;
  min?: number; max?: number; step?: number;
  options?: { value: string; label: string }[];
  show?: { [key: string]: (string | boolean)[] };
}
export type IconSpec = { name: string } | { path: string };
export interface ScriptManifest { api: number; title: string; description: string; icon: IconSpec; params: ManifestParam[] }

/** The script as a feature carries it (`params.$script`), and as the library keeps it. */
export interface ScriptRef { id: string; name: string; hash: string; source: string; manifest: ScriptManifest }

export const MAX_SOURCE = 200_000;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.\-+eE]{1,4000}$/;

/** The named icons (thin lines in a 24 × 24 box, drawn by ui/Glyph.tsx). */
export const ICONS: { readonly [name: string]: string } = {
  pockets: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><rect x="6" y="7" width="5" height="4" rx="1"/><rect x="13" y="7" width="5" height="4" rx="1"/><rect x="6" y="13" width="12" height="4" rx="1"/>',
  truss: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 19 9 5l6 14 6-14"/>',
  isogrid: '<path d="M12 3 21 19H3z"/><path d="M7.5 11h9M12 19 7.5 11M12 19l4.5-8"/>',
  hex: '<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z"/><path d="M12 8l3.5 2v4L12 16l-3.5-2v-4z"/>',
  slot: '<rect x="3" y="8" width="18" height="8" rx="4"/><circle cx="7" cy="12" r="1.2"/><circle cx="17" cy="12" r="1.2"/>',
  bracket: '<path d="M4 4h5v11h11v5H4z"/><circle cx="6.5" cy="7.5" r="1"/><circle cx="16.5" cy="17.5" r="1"/>',
  vent: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 8v8M10.3 8v8M13.7 8v8M17 8v8"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  plate: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="7" cy="9" r="1.2"/><circle cx="17" cy="9" r="1.2"/><circle cx="7" cy="15" r="1.2"/><circle cx="17" cy="15" r="1.2"/>',
  hole: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2"/>',
  rib: '<path d="M3 19h18M5 19V9l7-4 7 4v10M12 5v14"/>',
  frame: '<rect x="3" y="3" width="18" height="18" rx="1.5"/><rect x="7" y="7" width="10" height="10" rx="1"/>',
  wave: '<path d="M3 12c2.2-5 4.5-5 6.8 0s4.5 5 6.7 0S19.800 7 21 9"/>',
  star: '<path d="M12 3l2.6 5.6 6 .7-4.4 4.2 1.1 6L12 16.600l-5.300 2.900 1.100-6L3.400 9.300l6-.7z"/>',
  cube: '<path d="M12 3l8 4.500v9L12 21l-8-4.500v-9z"/><path d="M4 7.500l8 4.500 8-4.500M12 12v9"/>',
};
const DEFAULT_ICON = "cube";

export function iconMarkup(icon: IconSpec | undefined | null): string {
  if (icon && "path" in icon && typeof icon.path === "string" && PATH.test(icon.path)) return `<path d="${icon.path}"/>`;
  if (icon && "name" in icon && typeof icon.name === "string" && Object.prototype.hasOwnProperty.call(ICONS, icon.name)) return ICONS[icon.name];
  return ICONS[DEFAULT_ICON];
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * A manifest from what a script declared (or from a document).  Returns the manifest and what is wrong with
 * the declaration, as sentences for whoever is writing the script; `problems` empty means it is usable.
 */
export function readManifest(raw: unknown): { manifest: ScriptManifest; problems: string[] } {
  const problems: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as { [k: string]: unknown };
  const title = str(o.title, 60);
  if (!title) problems.push("feature({ title }) is missing: give the feature a name of up to 60 characters.");
  let icon: IconSpec = { name: DEFAULT_ICON };
  const ic = o.icon as unknown;
  if (typeof ic === "string") { if (Object.prototype.hasOwnProperty.call(ICONS, ic)) icon = { name: ic }; else problems.push(`icon "${str(ic, 40)}" is not one of ${Object.keys(ICONS).join(", ")}; or give { path: "M…" }.`); }
  else if (ic && typeof ic === "object") {
    const spec = ic as { name?: unknown; path?: unknown };
    if (typeof spec.path === "string") { if (PATH.test(spec.path)) icon = { path: spec.path }; else problems.push("icon.path may hold only SVG path commands and numbers (up to 4000 characters)."); }
    else if (typeof spec.name === "string" && Object.prototype.hasOwnProperty.call(ICONS, spec.name)) icon = { name: spec.name };
  }
  const params: ManifestParam[] = [];
  const list = Array.isArray(o.params) ? o.params : [];
  if (list.length > 40) problems.push("A feature takes at most 40 parameters.");
  const seen = new Set<string>();
  for (const rawP of list.slice(0, 40)) {
    const p = (rawP && typeof rawP === "object" ? rawP : {}) as { [k: string]: unknown };
    const key = typeof p.key === "string" ? p.key : "";
    if (!KEY.test(key) || seen.has(key)) { problems.push(`The parameter name "${str(key, 40)}" must start with a letter and hold only letters, digits and _ (up to 32).`); continue; }
    const type = p.type as ParamType;
    if (!PARAM_TYPES.includes(type)) { problems.push(`${key}: type "${str(p.type, 30)}" is not one of ${PARAM_TYPES.join(", ")}.`); continue; }
    seen.add(key);
    const out: ManifestParam = { key, type, label: str(p.label, 80) || key };
    const hint = str(p.hint, 200); if (hint) out.hint = hint;
    if (type === "length" || type === "angle" || type === "number" || type === "integer") {
      const d = num(p.default);
      if (d === undefined) problems.push(`${key}: a ${type} needs a default number.`);
      out.default = type === "integer" ? Math.round(d ?? 0) : d ?? 0;
      for (const k of ["min", "max", "step"] as const) { const v = num(p[k]); if (v !== undefined) out[k] = v; }
      if (out.min !== undefined && out.max !== undefined && out.min > out.max) problems.push(`${key}: min is above max.`);
      if ((out.min !== undefined && (out.default as number) < out.min) || (out.max !== undefined && (out.default as number) > out.max)) problems.push(`${key}: the default is outside min…max.`);
    } else if (type === "boolean") out.default = p.default === true;
    else if (type === "text") out.default = str(p.default, 400);
    else if (type === "enum") {
      const src = p.options, options: { value: string; label: string }[] = [];
      if (src && typeof src === "object" && !Array.isArray(src)) for (const [value, label] of Object.entries(src as object)) { if (options.length < 24 && value.length <= 40) options.push({ value, label: str(label, 60) || value }); }
      else if (Array.isArray(src)) for (const x of src) { const value = str(x && typeof x === "object" ? (x as { value?: unknown }).value : x, 40); if (value && options.length < 24) options.push({ value, label: str(x && typeof x === "object" ? (x as { label?: unknown }).label : x, 60) || value }); }
      if (options.length < 2) { problems.push(`${key}: an enum needs options: { key: "Label", … } with at least two.`); continue; }
      out.options = options;
      out.default = options.some((x) => x.value === p.default) ? (p.default as string) : options[0].value;
      if (p.default !== undefined && out.default !== p.default) problems.push(`${key}: the default is not one of the options.`);
    }
    if (p.show && typeof p.show === "object" && !Array.isArray(p.show)) {
      const show: { [k: string]: (string | boolean)[] } = {};
      for (const [k, v] of Object.entries(p.show as object)) {
        if (!KEY.test(k)) continue;
        const vals = (Array.isArray(v) ? v : [v]).filter((x): x is string | boolean => typeof x === "string" || typeof x === "boolean").slice(0, 24);
        if (vals.length) show[k] = vals;
      }
      if (Object.keys(show).length) out.show = show;
    }
    params.push(out);
  }
  for (const p of params) for (const k of Object.keys(p.show || {})) if (!params.some((q) => q.key === k)) problems.push(`${p.key}: show refers to "${k}", which is not a parameter.`);
  return { manifest: { api: API_VERSION, title: title || "Custom feature", description: str(o.description, 200), icon, params }, problems };
}

/** A manifest read out of a document: only what is recognised, or null when it is not one. */
export function cleanManifest(raw: unknown): ScriptManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = readManifest(raw);
  return r.manifest.title ? r.manifest : null;
}

/** A script as a document carries it, checked. */
export function cleanScriptRef(raw: unknown): ScriptRef | null {
  const o = raw as Partial<ScriptRef> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.source !== "string" || o.source.length > MAX_SOURCE) return null;
  const manifest = cleanManifest(o.manifest);
  if (!manifest || !/^[A-Za-z0-9-]{1,64}$/.test(o.id)) return null;
  return { id: o.id, name: str(o.name, 80) || manifest.title, hash: sourceHash(o.source), source: o.source, manifest };
}

/** A short fingerprint of a source text: for telling versions apart, not for trust. */
export function sourceHash(source: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < source.length; i++) { const c = source.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
}

export const scriptType = (id: string, hash: string): string => `${SCRIPT_TYPE}:${id}.${hash}`;
export const isScriptType = (type: string): boolean => type.startsWith(SCRIPT_TYPE + ":");
export function parseScriptType(type: string): { id: string; hash: string } | null {
  const m = /^script:([A-Za-z0-9-]{1,64})\.([0-9a-f]{1,16})$/.exec(type);
  return m ? { id: m[1], hash: m[2] } : null;
}

/** The dialog's fields for a manifest. */
export function schemaOf(m: ScriptManifest): ParamField[] {
  return m.params.map((p): ParamField => {
    const show = p.show;
    const base = { key: p.key, label: p.label, ...(p.hint ? { hint: p.hint } : {}), ...(show ? { visible: (params: JsonObject) => Object.entries(show).every(([k, vals]) => vals.includes(params[k] as string | boolean)) } : {}) };
    switch (p.type) {
      case "length": return { ...base, kind: "number", unit: "mm", min: p.min, max: p.max, step: p.step };
      case "angle": return { ...base, kind: "number", unit: "deg", min: p.min, max: p.max, step: p.step };
      case "number": return { ...base, kind: "number", unit: "none", min: p.min, max: p.max, step: p.step };
      case "integer": return { ...base, kind: "number", unit: "none", min: p.min, max: p.max, step: 1 };
      case "boolean": return { ...base, kind: "boolean" };
      case "text": return { ...base, kind: "text" };
      case "enum": return { ...base, kind: "enum", options: p.options || [] };
      case "face": return { ...base, kind: "refs", of: ["face"], single: true };
      case "faces": return { ...base, kind: "refs", of: ["face"] };
      case "edge": return { ...base, kind: "refs", of: ["edge"], single: true };
      case "edges": return { ...base, kind: "refs", of: ["edge"] };
      case "body": case "bodies": return { ...base, kind: "bodies" };
      case "sketch": return { ...base, kind: "profile" };
    }
  });
}

/** The values of a new feature. */
export function defaultsOf(m: ScriptManifest): JsonObject {
  const out: JsonObject = {};
  for (const p of m.params) {
    if (p.type === "face" || p.type === "edge") out[p.key] = null;
    else if (p.type === "faces" || p.type === "edges" || p.type === "body" || p.type === "bodies") out[p.key] = [];
    else if (p.type === "sketch") out[p.key] = { sketch: null, regions: null };
    else out[p.key] = p.default ?? null;
  }
  return out;
}

/**
 * The feature definition a script stands for on the page: its dialog and its defaults.  `evaluate` is never
 * called here: in the worker every `script:…` feature is built by features/script.ts from the source it carries.
 */
export function definitionOf(ref: ScriptRef, o: { toolbar?: boolean } = {}): FeatureDefinition {
  const m = ref.manifest;
  return {
    type: scriptType(ref.id, ref.hash),
    title: ref.name || m.title,
    icon: iconMarkup(m.icon),
    hint: m.description || "A custom feature of this project.",
    keywords: "custom script feature project " + m.title,
    defaults: () => ({ [SCRIPT_KEY]: { id: ref.id, name: ref.name, hash: ref.hash, source: ref.source, manifest: m as unknown as JsonObject }, ...defaultsOf(m) }),
    schema: schemaOf(m),
    evaluate: () => { throw new Error("A custom feature is built in the modelling worker."); },
    toolbar: o.toolbar !== false,
    toolbarSection: "library", toolbarMenu: "This project", toolbarOrder: 99990, toolbarKeep: 0,
  };
}
