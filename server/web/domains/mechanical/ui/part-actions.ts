// part-actions.ts — what the parts list does to the studio: an entry as picks, hiding and showing, the outline
// of a hidden entry, which features a selection came through, and every command of the list's menu
// (ui/parts-model.ts says which apply; this runs them).  The dialogs are in ui/PartDialogs.tsx.
import * as THREE from "three";
import { studioCollab } from "../collab/studio-collab";
import { partNamesOf, renamePart } from "../document/part-items";
import { materialOf } from "../document/mass-materials";
import { TOOLS } from "../generated/page";
import { displayOf } from "../inspect/appearance-display";
import { massOf } from "../inspect/mass-session";
import { perStudio } from "../inspect/store";
import type { Pick } from "../viewport/modelview";
import { showPanel } from "./panels";
import { entriesOf, featuresOfEntry, sectionsOf, type PartCommand, type PartEntry, type PartMenuContext, type PartSection } from "./parts-model";
import type { PartStudio } from "./studio";

/** The sections of the list for the model on screen. */
export function studioSections(studio: PartStudio): PartSection[] {
  const s = studio.getState();
  return sectionsOf(s.bodies, s.datums, s.features, partNamesOf(studio.doc));
}

const faceNames = (studio: PartStudio, body: string): string[] => studio.view.bodyObjects(body)?.result.mesh?.faces.names || [];

/** An entry as what a click on it in the model would pick: every face of a body, or the curve. */
export function entryPicks(studio: PartStudio, e: PartEntry): Pick[] {
  if (!e.body) return [{ kind: "datum", featureId: e.featureId, datum: "curve", point: [0, 0, 0] }];
  return faceNames(studio, e.body).map((name) => ({ kind: "face", body: e.body!, name, point: [0, 0, 0] } as Pick));
}

export function entryVisible(studio: PartStudio, e: PartEntry): boolean {
  return e.body ? displayOf(studio).isVisible(e.body) : studio.isVisible(e.featureId);
}

/** Hide or show entries: this person's view. */
export function setEntriesVisible(studio: PartStudio, entries: readonly PartEntry[], on: boolean): void {
  const bodies = entries.filter((e) => e.body).map((e) => e.body!), curves = entries.filter((e) => !e.body).map((e) => e.featureId);
  const d = displayOf(studio);
  if (bodies.length) { if (on) d.show(bodies); else d.hide(bodies); }
  if (curves.length) studio.setVisible(curves, on);
}

/** True when anything of the list is hidden, or parts are shown alone. */
export function anyHidden(studio: PartStudio, entries: readonly PartEntry[]): boolean {
  const ds = displayOf(studio).getState();
  return !!ds.hidden.length || !!ds.isolated || entries.some((e) => !e.body && !studio.isVisible(e.featureId));
}

/** Show everything of the list again. */
export function showAllEntries(studio: PartStudio, entries: readonly PartEntry[]): void {
  displayOf(studio).showAll();
  const curves = entries.filter((e) => !e.body && !studio.isVisible(e.featureId)).map((e) => e.featureId);
  if (curves.length) studio.setVisible(curves, true);
}

/** The edges of a body, or a curve, as line segments: what is drawn of a hidden entry while the pointer is on its row. */
export function entryOutline(studio: PartStudio, e: PartEntry): number[] {
  if (e.body) { const m = studio.view.bodyObjects(e.body)?.result.mesh; return m ? Array.from(m.edges.positions) : []; }
  const pts = studio.getState().datums.find((d) => d.featureId === e.featureId)?.points || [];
  const out: number[] = [];
  for (let i = 0; i + 5 < pts.length; i += 3) out.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
  return out;
}

/** The box around entries, for zooming to them. */
export function entriesBox(studio: PartStudio, entries: readonly PartEntry[]): THREE.Box3 | null {
  return studio.view.boxOf(entries.flatMap((e) => entryPicks(studio, e)));
}

// ---------------------------------------------------------------- which features the selection came through
interface Cross { selection: unknown; bodies: unknown; features: unknown; ids: ReadonlySet<string> }
const NONE: ReadonlySet<string> = new Set();

/**
 * The features that made or changed what is selected in the model: a whole part (as a click on its row selects
 * it), a face, an edge, a curve.  The feature list marks their rows (panels/parts.tsx adds the mark).  Worked
 * out once per selection.
 */
export function crossFeatures(studio: PartStudio): ReadonlySet<string> {
  const s = studio.getState();
  if (!s.selection.length || s.editing || s.sketch) return NONE;
  const memo = perStudio<{ last: Cross | null }>(studio, "part-cross", () => ({ last: null }));
  const last = memo.last;
  if (last && last.selection === s.selection && last.bodies === s.bodies && last.features === s.features) return last.ids;
  const ids = new Set<string>();
  const byBody = new Map<string, string[]>();
  for (const p of s.selection) {
    if (p.kind === "datum") ids.add(p.featureId);
    else if (p.kind === "face" || p.kind === "edge" || p.kind === "vertex") { const l = byBody.get(p.body) || []; l.push(p.name); byBody.set(p.body, l); }
  }
  const entries = entriesOf(studioSections(studio));
  for (const [body, names] of byBody) {
    const e = entries.find((x) => x.body === body); if (!e) continue;
    // every face selected is the part itself (a click on its row): the feature that made the body counts too
    const whole = names.length >= faceNames(studio, body).length;
    for (const id of featuresOfEntry(whole ? e : { ...e, featureId: "", body: null }, [], s.features)) ids.add(id);
    for (const f of s.features) if (names.some((n) => n.includes(f.id))) ids.add(f.id);
  }
  // what those features were given (the sketch an extrude used): one step back
  const texts = s.features.filter((f) => ids.has(f.id)).map((f) => JSON.stringify(f.params));
  for (const f of s.features) if (!ids.has(f.id) && texts.some((t) => t.includes(f.id))) ids.add(f.id);
  memo.last = { selection: s.selection, bodies: s.bodies, features: s.features, ids };
  return ids;
}

// ---------------------------------------------------------------- the menu
/** Why a comment cannot be started now, or null. */
export function commentWhy(studio: PartStudio): string | null {
  const s = studio.getState();
  if (!studio.host.signedIn) return "Sign in to comment";
  if (s.status.role !== "editor" && s.status.role !== "commenter") return "You have view-only access";
  if (s.sketch || s.editing) return "Finish the open dialog or sketch first";
  if (!studioCollab(studio)) return "Comments are not ready yet";
  return null;
}

/** What parts-model.ts partMenu needs to know about the studio, for these rows. */
export function menuContext(studio: PartStudio, targets: readonly PartEntry[], all: readonly PartEntry[]): PartMenuContext {
  const s = studio.getState(), d = displayOf(studio);
  const byId = new Map(all.map((e) => [e.id, e]));
  return {
    targets, total: all.length, canEdit: s.canEdit, busy: !!s.editing || !!s.sketch, commentWhy: commentWhy(studio),
    visible: (id) => { const e = byId.get(id); return !!e && entryVisible(studio, e); },
    anyHidden: anyHidden(studio, all), isolated: d.getState().isolated,
    transparent: (id) => d.isTransparent(id),
    hasMaterial: (id) => !!materialOf(studio.doc, id),
    centreShown: massOf(studio).getState().showCentre,
  };
}

export interface PartUi {
  /** start renaming this row in place */
  rename(entryId: string): void;
  properties(entry: PartEntry): void;
  material(entries: readonly PartEntry[]): void;
  appearance(entries: readonly PartEntry[]): void;
}

/** Select these entries in the model (what most commands act on, and what Export and the mass properties read). */
export function selectEntries(studio: PartStudio, entries: readonly PartEntry[]): void {
  studio.select(entries.flatMap((e) => entryPicks(studio, e)));
}

/** Give an entry a name (empty: its own name again).  One undoable step, seen by everyone. */
export function renameEntry(studio: PartStudio, e: PartEntry, name: string): void {
  if (!studio.doc) return;
  const s = studio.getState();
  // what it is called without a name of its own: a curve's feature, or what the kernel named the body
  const fallback = e.body ? "" : s.features.find((f) => f.id === e.featureId)?.name || "";
  const changes = renamePart(studio.doc, e.id, name, fallback);
  if (changes.length) studio.commit(changes);
}

/** Run a command of the menu on these rows.  `all`: every entry of the list. */
export function runPartCommand(studio: PartStudio, cmd: PartCommand, targets: readonly PartEntry[], all: readonly PartEntry[], ui: PartUi): void {
  const d = displayOf(studio);
  const bodies = targets.filter((e) => e.body).map((e) => e.body!);
  switch (cmd) {
    case "rename": ui.rename(targets[0].id); return;
    case "properties": ui.properties(targets[0]); return;
    case "material": ui.material(targets); return;
    case "appearance": ui.appearance(targets); return;
    case "transform": studio.startFeature("transform"); studio.setDraft({ params: { bodies } }); return;
    case "delete": studio.startFeature("delete-body"); studio.setDraft({ params: { bodies } }); return;
    case "export": { selectEntries(studio, targets); TOOLS.find((t) => t.id === "export")?.run(studio); return; }
    case "hide": setEntriesVisible(studio, targets, false); return;
    case "show": setEntriesVisible(studio, targets, true); return;
    case "hide-others": setEntriesVisible(studio, targets, true); setEntriesVisible(studio, all.filter((e) => !targets.includes(e)), false); return;
    case "hide-all": setEntriesVisible(studio, all, false); return;
    case "show-all": showAllEntries(studio, all); return;
    case "isolate": d.isolate(bodies); return;
    case "unisolate": d.isolate(null); return;
    case "transparent": d.setTransparent(bodies, true); return;
    case "opaque": d.setTransparent(bodies, false); return;
    case "centre-show": selectEntries(studio, targets); massOf(studio).setShowCentre(true); return;
    case "centre-hide": massOf(studio).setShowCentre(false); return;
    case "zoom": {
      const box = entriesBox(studio, targets);
      if (box) studio.viewport.fit(box.expandByScalar(Math.max(1, box.getSize(new THREE.Vector3()).length() * 0.15)));
      return;
    }
    case "comment": {
      const c = studioCollab(studio), e = targets[0];
      if (!c || commentWhy(studio)) return;
      showPanel("comments");
      if (!e.body) { c.comments.compose({ target: { kind: "feature", featureId: e.featureId }, point: null, label: e.name, createdBy: null }); return; }
      // pinned to the part's first face, at the middle of the part: the pin follows the part through rebuilds
      const face = faceNames(studio, e.body)[0];
      if (!face) return;
      const box = entriesBox(studio, [e]), at = box ? box.getCenter(new THREE.Vector3()) : null;
      c.comments.compose({ target: { kind: "face", body: e.body, name: face }, point: at ? [at.x, at.y, at.z] : null, label: e.name, createdBy: e.featureId });
      return;
    }
  }
}
