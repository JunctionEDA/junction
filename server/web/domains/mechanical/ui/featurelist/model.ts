// model.ts — what the feature list works out from an open part studio: the search box's answer, which rows the
// selection in the model belongs to, how long each feature took to build, which sketches are not fully defined,
// and the sketch that was copied.
//
//   listFilter(studio)        what the search box shows: { active, features, bodies, folders }.  The parts list
//                             asks the same question, so one box filters both (`useListFilter` in React)
//   setListFilter(studio, s)  type into the box from elsewhere
//   featuresOfBody(...)       the features that made or changed a part
//   crossFeatures(studio)     the features behind what is selected in the model
import { useSyncExternalStore } from "react";
import type { ItemDoc } from "../../../../shared/itemdoc/itemdoc";
import { clone, type JsonObject } from "../../../../shared/itemdoc/itemdoc";
import { addFeature } from "../../document/edits";
import { foldersOf, featureTree, suppressionOf, type Suppression } from "../../document/folders";
import { nextName, type FeatureItem } from "../../document/format";
import { exprsOf, lookupOf, namesIn, variableValues, variablesOf } from "../../document/variables";
import { displayOf } from "../../inspect/appearance-display";
import type { BodyResult } from "../../kernel/protocol";
import type { SketchData } from "../../sketch/format";
import { loadSolver } from "../../sketch/solver/load";
import { featureDef, studioExtensions, type PartStudio } from "../studio";
import { parseFilter, runFilter, type FilterBody, type FilterFeature, type FilterResult } from "./filter";

/** feature types whose result is reference geometry or a sketch: things that are looked at, so can be hidden */
export const HIDEABLE = new Set(["sketch", "plane", "axis", "point", "helix"]);

const FILTER_KEY = "featureFilter";
export const filterText = (studio: PartStudio): string => { const v = studio.getState().ui?.[FILTER_KEY]; return typeof v === "string" ? v : ""; };
export function setListFilter(studio: PartStudio, text: string): void { if (text !== filterText(studio)) studio.setUi({ [FILTER_KEY]: text }); }

/** The face names of a body as the page holds them (the state drops a mesh the worker did not send again). */
const faceNames = (studio: PartStudio, b: BodyResult): string[] => b.mesh?.faces.names || studio.view.bodyObjects(b.id)?.result.mesh?.faces.names || [];

/** The features that made or changed a body: the one that created it and every one a face of it is named after. */
export function featuresOfBody(createdBy: string, names: readonly string[], featureIds: readonly string[]): string[] {
  const out = new Set<string>();
  const made = featureIds.find((id) => createdBy === id || createdBy.startsWith(id + ":"));
  if (made) out.add(made);
  for (const id of featureIds) { if (out.has(id)) continue; const pre = id + ":"; if (names.some((n) => n.includes(pre))) out.add(id); }
  return Array.from(out);
}

const bodyKind = (b: BodyResult): string => { const k = (b as unknown as { kind?: unknown }).kind; return typeof k === "string" ? k : b.reference ? "reference" : b.sheet ? "surface" : "part"; };

/** Why each row is or is not built, with the document's variables. */
export function suppressionFor(doc: ItemDoc, features: readonly FeatureItem[]): Map<string, Suppression> {
  return suppressionOf(doc, features, lookupOf(variableValues(variablesOf(doc))));
}

const cache = new WeakMap<PartStudio, { key: unknown[]; result: FilterResult }>();
const NONE: FilterResult = { active: false, features: new Set(), bodies: new Set(), folders: new Set() };

/** What the search box of the feature list shows just now. */
export function listFilter(studio: PartStudio): FilterResult {
  const s = studio.getState(), text = filterText(studio), doc = studio.doc;
  const q = parseFilter(text);
  if (!doc || q.partial !== null || (!q.command && !q.text)) return NONE;
  const display = displayOf(studio), hiddenBodies = display.getState().hidden;
  const key = [text, s.features, s.reports, s.bodies, s.visibility, hiddenBodies, display.getState().isolated];
  const had = cache.get(studio);
  if (had && had.key.every((k, i) => k === key[i])) return had.result;
  const folders = foldersOf(doc), tree = featureTree(s.features, folders), why = suppressionFor(doc, s.features);
  const ids = s.features.map((f) => f.id);
  const features: FilterFeature[] = s.features.map((f, i) => {
    const rep = s.reports[f.id], off = !!why.get(f.id)?.suppressed;
    return {
      id: f.id, name: f.name, type: f.featureType, typeTitle: featureDef(f.featureType)?.title || f.featureType,
      status: off ? "suppressed" : i >= s.rollback ? "rolled-back" : rep ? rep.status : "ok", suppressed: off,
      hidden: HIDEABLE.has(f.featureType) ? !studio.isVisible(f.id) : null,
      variables: Array.from(new Set(Object.values(exprsOf(f.params)).flatMap((t) => namesIn(t)))),
      folders: tree.paths.get(f.id) || [],
    };
  });
  const bodies: FilterBody[] = s.bodies.map((b) => ({ id: b.id, name: b.name, kind: bodyKind(b), hidden: !display.isVisible(b.id), features: featuresOfBody(b.createdBy, faceNames(studio, b), ids) }));
  const result = runFilter(q, { features, bodies, folders: Array.from(folders.values(), (d) => ({ id: d.id, name: d.name, parent: typeof d.parent === "string" ? d.parent : null })) });
  cache.set(studio, { key, result });
  return result;
}

/** React: the search box's answer; redraws when it changes. */
export function useListFilter(studio: PartStudio): FilterResult {
  const display = displayOf(studio);
  useSyncExternalStore(display.subscribe, display.getState);
  return useSyncExternalStore(studio.subscribe, () => listFilter(studio));
}

/** The features behind what is selected in the model: who made each selected face, edge, vertex, sketch or plane. */
export function crossFeatures(studio: PartStudio): Set<string> {
  const s = studio.getState(), out = new Set<string>();
  if (!s.selection.length) return out;
  const ids = s.features.map((f) => f.id);
  for (const p of s.selection) {
    if (p.kind === "plane") continue;
    if (p.kind === "sketch" || p.kind === "datum") { out.add(p.featureId); continue; }
    for (const id of ids) if (p.name.includes(id + ":") || p.body === id || p.body.startsWith(id + ":")) out.add(id);
  }
  return out;
}

// ---------------------------------------------------------------- how long each feature took
const TIMES_KEY = "regenTimes";
/** feature id → the milliseconds its last build took (a feature whose result was reused keeps its last time). */
const NO_TIMES: { readonly [id: string]: number } = {};
export const regenTimes = (studio: PartStudio): { readonly [id: string]: number } => (studio.getState().ui?.[TIMES_KEY] as { [id: string]: number } | undefined) || NO_TIMES;

studioExtensions.push((studio) => {
  const seen = (result: { features: { id: string; ms?: number }[] }) => {
    const now = regenTimes(studio);
    let next: { [id: string]: number } | null = null;
    for (const r of result.features) if (typeof r.ms === "number" && now[r.id] !== r.ms) (next = next || { ...now })[r.id] = r.ms;
    if (next) studio.setUi({ [TIMES_KEY]: next });
  };
  studio.onRegen.push(seen);
  return () => { const i = studio.onRegen.indexOf(seen); if (i >= 0) studio.onRegen.splice(i, 1); };
});

// ---------------------------------------------------------------- sketches that are not fully defined
// The constraint solver counts a sketch's freedoms (sketch/solver).  It is asked once per sketch as it is, in
// idle moments, and only once a sketch exists.
const freedoms = new Map<string, { json: string; dof: number | null }>();
const waiting = new Set<() => void>();
let freedomsVersion = 0;
let measuredFor: readonly FeatureItem[] | null = null;
const subscribeFreedoms = (fn: () => void) => { waiting.add(fn); return () => { waiting.delete(fn); }; };

function measureSketch(f: FeatureItem): void {
  const data = f.params.sketch as unknown as SketchData | undefined;
  if (!data || !data.entities) return;
  const json = JSON.stringify(data);
  const had = freedoms.get(f.id);
  if (had && had.json === json) return;
  freedoms.set(f.id, { json, dof: had ? had.dof : null });
  void loadSolver().then((solver) => {
    const idle = (window as unknown as { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback || ((fn: () => void) => window.setTimeout(fn, 30));
    idle(() => {
      const now = freedoms.get(f.id);
      if (!now || now.json !== json) return;
      let dof: number | null = null;
      try { const r = solver.solve(JSON.parse(json) as SketchData); dof = r.ok ? r.dof : null; } catch (e) { dof = null; }
      freedoms.set(f.id, { json, dof });
      freedomsVersion++;
      for (const fn of Array.from(waiting)) fn();
    });
  }, () => { /* no solver: no mark */ });
}

/** React: sketch feature id → the degrees of freedom it has left (absent: not known yet, or it does not solve). */
export function useSketchFreedoms(features: readonly FeatureItem[], openSketch: string | null | undefined): (id: string) => number | null {
  useSyncExternalStore(subscribeFreedoms, () => freedomsVersion);
  // the items of a document change in place: the list is new whenever the document changed, and only then is it read again
  if (features !== measuredFor) { measuredFor = features; for (const f of features) if (f.featureType === "sketch" && f.id !== openSketch) measureSketch(f); }
  return (id) => (id === openSketch ? null : freedoms.get(id)?.dof ?? null);
}

// ---------------------------------------------------------------- copy a sketch, paste it as a new one
const CLIP_KEY = "junction.cad.sketchClipboard";
interface SketchClip { doc: string; name: string; params: JsonObject }
let clip: SketchClip | null = null;

function readClip(): SketchClip | null {
  if (clip) return clip;
  try { const v = JSON.parse(localStorage.getItem(CLIP_KEY) || "null"); return v && typeof v === "object" && v.params && typeof v.params === "object" ? (v as SketchClip) : null; } catch (e) { return null; }
}
export const copiedSketch = (): { name: string } | null => { const c = readClip(); return c ? { name: c.name } : null; };

/** Keep a sketch to paste: here, in another part studio, in another tab. */
export function copySketch(studio: PartStudio, featureId: string): boolean {
  const f = studio.getState().features.find((x) => x.id === featureId);
  if (!f || f.featureType !== "sketch") return false;
  clip = { doc: String(studio.host.doc.docId), name: f.name, params: clone(f.params) };
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) { /* private mode: it lasts as long as the page */ }
  studio.host.toast(`Copied ${f.name}. Right-click a feature and choose Paste sketch.`, 2500);
  return true;
}

/**
 * Paste the copied sketch as a new sketch at the rollback bar.  In the document it came from it lies on the same
 * plane; in another document a sketch that lay on a face or a reference plane goes on the Top plane (what it
 * lay on is not there).
 */
export function pasteSketch(studio: PartStudio): string | null {
  const c = readClip(), doc = studio.doc, def = featureDef("sketch");
  if (!c || !doc || !def || !studio.getState().canEdit) return null;
  const params = clone(c.params);
  const plane = params.plane as { kind?: string } | undefined;
  if (c.doc !== String(studio.host.doc.docId) && (!plane || plane.kind !== "plane")) params.plane = { kind: "plane", plane: "top" };
  const { changes, feature } = addFeature(doc, def, params, nextName(studio.getState().features, "Sketch"));
  if (!studio.commit(changes)) return null;
  studio.selectFeature(feature.id);
  return feature.id;
}
