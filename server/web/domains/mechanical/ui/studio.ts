// studio.ts — an open part studio: the one object that ties the document's session, the modelling worker and
// the viewport together, and that every tool, panel and dialog is handed.
//
//   studio.getState()            what is on screen, as an immutable snapshot (React reads it with ui/hooks.ts)
//   studio.commit(changes)       the one way the document changes (see document/edits.ts for the changes)
//   studio.kernel.call(...)      ask a worker service about the model
//   studio.view                  the viewport (picking, overlays, camera)
//
// It holds the interface state that is not in the document: the selection, the feature being edited (a draft
// that is committed when its dialog is accepted), the sketch that is open and the tool in hand.
import type { ItemChange, ItemDoc, JsonObject } from "../../../shared/itemdoc/itemdoc";
import { clone } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession, type SessionPeer, type SessionStatus } from "../../../shared/itemdoc/sync";
import type { DocumentHostContext } from "../../../platform/documents/host";
import { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import * as THREE from "three";
import type { FeatureDefinition, ParamField } from "../core/feature";
import type { PlaneRef } from "../core/geometry";
import { DEFAULT_PLANES } from "../core/geometry";
import * as edits from "../document/edits";
import { PART_STUDIO_KIND, featureInputs, featuresOf, nextName, orderAt, rollbackIndex, type FeatureItem } from "../document/format";
import { FEATURES, TOOLS } from "../generated/page";
import { KernelClient, type KernelState } from "../kernel/client";
import type { BodyResult, DatumView, FeatureReport, SketchView } from "../kernel/protocol";
import { resolveInputs, variableValues, variablesOf } from "../document/variables";
import { pickKindsOf, sameTarget, targetOf, targetsIn, type RefTarget } from "../features/_refs";
import { ModelView, pickKey, type Pick, type PickKind } from "../viewport/modelview";

export interface EditingFeature {
  /** the feature as the dialog shows it; the document is not changed until the dialog is accepted */
  draft: FeatureItem;
  isNew: boolean;
  /** the dialog field that viewport clicks fill, when one is active */
  field: string | null;
}

export interface StudioState {
  /** the document has arrived and can be shown */
  loaded: boolean;
  status: SessionStatus;
  canEdit: boolean;
  features: FeatureItem[];
  /** how many features the document builds: the rollback bar's place */
  rollback: number;
  reports: { [featureId: string]: FeatureReport };
  bodies: BodyResult[];
  sketches: SketchView[];
  /** reference planes, axes, points and curves */
  datums: DatumView[];
  kernel: { state: KernelState; message: string; working: boolean };
  selection: Pick[];
  hover: Pick | null;
  /** the feature row that is selected in the list */
  selectedFeature: string | null;
  editing: EditingFeature | null;
  /** the sketch that is open for editing, and the sketch tool in hand ("select" when none) */
  sketch: { featureId: string; tool: string } | null;
  peers: SessionPeer[];
  canUndo: boolean; canRedo: boolean;
  planesVisible: boolean;
  /** set while an earlier version of the document is on screen (showPast): nothing can be edited meanwhile */
  past?: { label: string } | null;
  /** interface state that tools and panels keep for themselves (setUi), by a key of their own */
  ui?: { readonly [key: string]: unknown };
}

export const featureDef = (type: string): FeatureDefinition | undefined => FEATURES.find((f) => f.type === type);

export class PartStudio {
  readonly session: ItemDocSession;
  readonly kernel: KernelClient;
  readonly viewport: Viewport3D;
  readonly view: ModelView;
  private state: StudioState;
  private listeners = new Set<() => void>();
  private regenTimer = 0;
  private regenWhenShown: (() => void) | null = null;
  private fitted = false;
  private closed = false;
  /** the document on screen in place of the live one, while an earlier version is looked at */
  private pastDoc: ItemDoc | null = null;
  /** A sketch tool that is drawing gets the keys first; it returns true for the ones it used. */
  keyHandler: ((ev: KeyboardEvent) => boolean) | null = null;

  constructor(readonly host: DocumentHostContext, canvasHost: HTMLElement) {
    this.state = {
      loaded: false, status: { state: "connecting", text: "connecting…", role: null, canEdit: false }, canEdit: false,
      features: [], rollback: 0, reports: {}, bodies: [], sketches: [], datums: [], kernel: { state: "idle", message: "", working: false },
      selection: [], hover: null, selectedFeature: null, editing: null, sketch: null, peers: [], canUndo: false, canRedo: false, planesVisible: true,
    };
    this.viewport = new Viewport3D(canvasHost);
    this.view = new ModelView(this.viewport);
    this.view.onHover = (p) => this.set({ hover: p });
    this.view.onPick = (p, ev) => this.onPick(p, ev);
    this.viewport.canvas.addEventListener("keydown", this.onKey);
    this.viewport.fit(new THREE.Box3(new THREE.Vector3(-40, -40, -40), new THREE.Vector3(40, 40, 40)));
    this.kernel = new KernelClient({
      onState: (s, message) => { if (!this.closed) this.set({ kernel: { state: s, message: message || "", working: s === "working" || s === "loading" } }); },
    });
    this.session = new ItemDocSession({
      docId: host.doc.docId, signedIn: host.signedIn, expectKind: PART_STUDIO_KIND,
      onChange: () => this.documentChanged(),
      onStatus: (status) => { host.setConnection(status.state === "live" ? "live" : status.state === "error" ? "error" : "offline", status.text); this.set({ status, canEdit: status.canEdit && !this.pastDoc }); },
      onPeers: (peers) => this.set({ peers }),
      onNotice: (text) => host.toast(text, 4000),
    });
    this.session.start();
  }

  // ---------------------------------------------------------------- state
  getState = (): StudioState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<StudioState>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    for (const fn of Array.from(this.listeners)) fn();
  }
  get doc(): ItemDoc | null { return this.pastDoc || this.session.doc; }
  /** Keep a piece of interface state of a tool or a panel; the toolbar and the panels redraw. */
  setUi(patch: { [key: string]: unknown }): void { this.set({ ui: { ...(this.state.ui || {}), ...patch } }); }

  /**
   * Show an earlier version of the document in place of the live one (null: the live one again).  The model
   * is rebuilt from it and nothing can be edited until the live document is back; edits other people make
   * meanwhile are kept by the session and shown then.
   */
  showPast(doc: ItemDoc | null, label = ""): void {
    if (!doc && !this.pastDoc) return;
    if (this.state.sketch) this.finishSketch();
    if (this.state.editing) this.cancelFeature();
    this.pastDoc = doc;
    this.select([]);
    this.set({ past: doc ? { label } : null, canEdit: this.session.status.canEdit && !doc, selectedFeature: null });
    this.documentChanged();
  }
  definitions(): readonly FeatureDefinition[] { return FEATURES; }
  tools() { return TOOLS; }

  close(): void {
    this.closed = true;
    clearTimeout(this.regenTimer);
    if (this.regenWhenShown) document.removeEventListener("visibilitychange", this.regenWhenShown);
    this.viewport.canvas.removeEventListener("keydown", this.onKey);
    this.session.close(); this.kernel.dispose(); this.view.dispose(); this.viewport.dispose();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- the document
  /** Make an edit.  The changes come from document/edits.ts (or are built the same way). */
  commit(changes: ItemChange[], o: { undoable?: boolean } = {}): boolean {
    if (this.pastDoc) { this.host.toast("This is an earlier version. Go back to the current one to edit.", 3000); return false; }
    return this.session.commit(changes, o);
  }
  undo(): void { if (!this.pastDoc && this.session.undo()) this.host.toast("Undone", 1200); }
  redo(): void { if (!this.pastDoc && this.session.redo()) this.host.toast("Redone", 1200); }

  private documentChanged(): void {
    const doc = this.doc; if (!doc) return;
    const features = featuresOf(doc);
    const patch: Partial<StudioState> = { loaded: true, features, rollback: rollbackIndex(doc, features), canUndo: !this.pastDoc && this.session.canUndo, canRedo: !this.pastDoc && this.session.canRedo };
    // somebody deleted what is open here
    const s = this.state;
    if (s.sketch && !features.some((f) => f.id === s.sketch!.featureId)) { patch.sketch = null; this.view.pointerTool = null; this.view.setOverlay(null); }
    if (s.editing && !s.editing.isNew && !features.some((f) => f.id === s.editing!.draft.id)) patch.editing = null;
    if (s.selectedFeature && !features.some((f) => f.id === s.selectedFeature)) patch.selectedFeature = null;
    this.set(patch);
    this.scheduleRegen();
  }

  /** The features the worker is given: the document's, with the draft of the dialog laid over them. */
  private effective(): { features: FeatureItem[]; rollback: number } {
    const s = this.state;
    let features = s.features, rollback = s.rollback;
    if (s.editing) {
      const d = s.editing.draft;
      if (s.editing.isNew) { features = features.slice(); features.splice(rollback, 0, d); rollback += 1; }
      else { const i = features.findIndex((f) => f.id === d.id); if (i >= 0) { features = features.slice(); features[i] = d; rollback = i + 1; } }
    } else if (s.sketch) {
      // while a sketch is open the model is shown as it was when the sketch was made
      const i = features.findIndex((f) => f.id === s.sketch!.featureId);
      if (i >= 0) rollback = i + 1;
    }
    return { features, rollback };
  }

  scheduleRegen(): void {
    clearTimeout(this.regenTimer);
    // A window nobody is looking at does not rebuild for every edit somebody else makes: it rebuilds once,
    // from the document as it is by then, when it is looked at again.
    if (document.visibilityState === "hidden") {
      if (!this.regenWhenShown) {
        this.regenWhenShown = () => { if (document.visibilityState === "hidden") return; document.removeEventListener("visibilitychange", this.regenWhenShown!); this.regenWhenShown = null; this.scheduleRegen(); };
        document.addEventListener("visibilitychange", this.regenWhenShown);
      }
      return;
    }
    this.regenTimer = window.setTimeout(() => void this.regen(), 20);
  }
  private async regen(): Promise<void> {
    if (this.closed || !this.state.loaded) return;
    const { features, rollback } = this.effective();
    // numbers typed as expressions follow the variables (document/variables.ts)
    const inputs = this.doc ? resolveInputs(featureInputs(features), variableValues(variablesOf(this.doc)).values) : featureInputs(features);
    const result = await this.kernel.regenerate(inputs, rollback);
    if (!result || this.closed) return;
    const reports: StudioState["reports"] = {};
    for (const r of result.features) reports[r.id] = r;
    this.set({ reports, bodies: result.bodies, sketches: result.sketches, datums: result.datums || [] });
    this.view.setBodies(result.bodies);
    this.view.setDatums(result.datums || []);
    this.refreshSketches();
    // frame the model when there first is one (a sketch being drawn is left where the person put it)
    if (!this.fitted && result.bodies.length && !this.state.sketch) { this.fitted = true; this.viewport.fit(); }
  }

  /** A sketch is shown while it is open, selected, being used by the dialog, or not yet used by a later feature. */
  private refreshSketches(): void {
    const s = this.state, { features, rollback } = this.effective();
    // a dialog field that takes sketch curves or a profile shows every sketch while it listens
    const armed = s.editing && s.editing.field ? featureDef(s.editing.draft.featureType)?.schema.find((x) => x.key === s.editing!.field) : undefined;
    const pickingCurves = !!armed && ((armed.kind === "refs" && !!armed.sketch) || armed.kind === "profile");
    const visible = new Set<string>();
    features.slice(0, rollback).forEach((f, i) => {
      if (f.featureType !== "sketch") return;
      const used = features.slice(i + 1, rollback).some((later) => JSON.stringify(later.params).includes(f.id));
      const inDialog = !!s.editing && JSON.stringify(s.editing.draft.params).includes(f.id);
      if (!used || inDialog || pickingCurves || s.selectedFeature === f.id) visible.add(f.id);
    });
    this.view.setSketches(s.sketches, visible, s.sketch ? s.sketch.featureId : null);
  }

  // ---------------------------------------------------------------- selection
  select(picks: Pick[]): void { this.set({ selection: picks }); this.view.setSelection(picks); }
  selectFeature(id: string | null): void { this.set({ selectedFeature: id }); this.refreshSketches(); }

  private onPick(p: Pick | null, ev: PointerEvent): void {
    const s = this.state;
    if (s.editing && s.editing.field) { if (p) this.fillField(s.editing.field, p); return; }
    const many = ev.shiftKey || ev.ctrlKey || ev.metaKey;
    if (!p) { if (!many) this.select([]); return; }
    const has = s.selection.some((x) => pickKey(x) === pickKey(p));
    this.select(many ? (has ? s.selection.filter((x) => pickKey(x) !== pickKey(p)) : [...s.selection, p]) : has && s.selection.length === 1 ? [] : [p]);
  }

  // ---------------------------------------------------------------- features
  /** Open the dialog for a new feature of this type.  The selection fills what it can (a plane, a sketch). */
  startFeature(type: string): void {
    const def = featureDef(type); if (!def || !this.requireEdit()) return;
    if (this.state.sketch) this.finishSketch();
    const s = this.state;
    const params = def.defaults() as JsonObject;
    for (const field of def.schema) {
      const v = this.fromSelection(field, s.selection);
      if (v !== undefined) params[field.key] = v;
      else if (field.kind === "profile") {
        // the newest sketch that nothing uses yet is what an extrude is usually for
        const free = s.features.slice(0, s.rollback).filter((f, i) => f.featureType === "sketch" && !s.features.slice(i + 1).some((l) => JSON.stringify(l.params).includes(f.id))).pop();
        if (free) params[field.key] = { sketch: free.id, regions: null };
      }
    }
    const draft: FeatureItem = { id: crypto.randomUUID(), type: "feature", featureType: def.type, name: nextName(s.features, def.title), order: orderAt(s.features, s.rollback), params };
    this.select([]);
    this.set({ editing: { draft, isNew: true, field: this.firstEmptyField(def, params) } });
    this.applyFieldFilter();
    this.scheduleRegen();
  }

  /** Open a feature for editing: its dialog, or the sketch itself for a sketch. */
  editFeature(id: string): void {
    const f = this.state.features.find((x) => x.id === id); if (!f) return;
    if (this.state.sketch) this.finishSketch();
    if (f.featureType === "sketch") { this.openSketch(id); return; }
    if (!this.requireEdit()) return;
    this.select([]);
    this.set({ editing: { draft: clone(f), isNew: false, field: null }, selectedFeature: id });
    this.scheduleRegen();
  }

  /** Change the draft in the dialog; the model follows as a preview. */
  setDraft(patch: { params?: JsonObject; name?: string }): void {
    const e = this.state.editing; if (!e) return;
    const draft = { ...e.draft, ...(patch.name !== undefined ? { name: patch.name } : {}), params: patch.params ? { ...e.draft.params, ...patch.params } : e.draft.params };
    this.set({ editing: { ...e, draft } });
    this.refreshSketches();
    this.scheduleRegen();
  }
  /** Make a dialog field the one that viewport clicks fill (null: none). */
  setField(key: string | null): void {
    const e = this.state.editing; if (!e) return;
    this.set({ editing: { ...e, field: key } });
    this.applyFieldFilter();
    this.refreshSketches();
  }
  private applyFieldFilter(): void {
    const e = this.state.editing;
    const def = e ? featureDef(e.draft.featureType) : undefined;
    const field = e && e.field && def ? def.schema.find((f) => f.key === e.field) : undefined;
    const kinds: PickKind[] | null = !field ? null
      : field.kind === "refs" ? (pickKindsOf(field) as PickKind[]) : field.kind === "plane" ? ["plane", "face", "datum"] : field.kind === "profile" ? ["sketch"] : field.kind === "bodies" ? ["face"] : null;
    this.view.setFilter(kinds);
  }
  private firstEmptyField(def: FeatureDefinition, params: JsonObject): string | null {
    for (const f of def.schema) {
      if (f.kind === "profile" && !params[f.key]) return f.key;
      if (f.kind === "refs" && (!params[f.key] || (Array.isArray(params[f.key]) && !(params[f.key] as unknown[]).length))) return f.key;
    }
    return null;
  }

  /** What a pick means for a field of the dialog, or undefined when it means nothing. */
  private fromSelection(field: ParamField, picks: readonly Pick[]): JsonObject[string] | undefined {
    if (field.kind === "plane") {
      const p = picks.find((x) => x.kind === "plane" || x.kind === "face" || (x.kind === "datum" && x.datum === "plane"));
      if (!p) return undefined;
      const ref: PlaneRef = p.kind === "plane" ? { kind: "plane", plane: p.plane } : p.kind === "datum" ? { kind: "datum", feature: p.featureId } : { kind: "face", ref: { kind: "face", body: (p as { body: string }).body, name: (p as { name: string }).name } };
      return ref as unknown as JsonObject;
    }
    if (field.kind === "profile") { const p = picks.find((x) => x.kind === "sketch"); return p && p.kind === "sketch" ? { sketch: p.featureId, regions: null } : undefined; }
    if (field.kind === "refs") {
      const refs = picks.map((x) => targetOf(field, x)).filter((x): x is RefTarget => !!x);
      return refs.length ? (field.single ? refs[0] : refs) : undefined;
    }
    return undefined;
  }
  private fillField(key: string, p: Pick): void {
    const e = this.state.editing; if (!e) return;
    const def = featureDef(e.draft.featureType), field = def && def.schema.find((f) => f.key === key); if (!field) return;
    if (field.kind === "refs" && !field.single) {
      const t = targetOf(field, p); if (!t) return;
      const now = targetsIn(e.draft.params[key]);
      this.setDraft({ params: { [key]: now.some((r) => sameTarget(r, t)) ? now.filter((r) => !sameTarget(r, t)) : [...now, t] } });
      return;
    }
    if (field.kind === "bodies") {
      if (p.kind !== "face") return;
      const now = (e.draft.params[key] as string[] | undefined) || [];
      this.setDraft({ params: { [key]: now.includes(p.body) ? now.filter((b) => b !== p.body) : [...now, p.body] } });
      return;
    }
    const v = this.fromSelection(field, [p]);
    if (v !== undefined) this.setDraft({ params: { [key]: v } });
  }

  /** Accept the dialog: the draft becomes (or replaces) the feature in the document, as one undoable step. */
  acceptFeature(): void {
    const e = this.state.editing; if (!e || !this.doc) return;
    const d = e.draft;
    const changes: ItemChange[] = e.isNew
      ? [{ id: d.id, kind: "ADDED", typeName: "feature", item: { ...d, order: orderAt(featuresOf(this.doc), rollbackIndex(this.doc)) } }]
      : [...edits.setParams(this.doc, d.id, d.params), ...edits.renameFeature(this.doc, d.id, d.name)];
    this.set({ editing: null, selectedFeature: d.id });
    this.view.setFilter(null);
    if (changes.length) this.commit(changes); else this.scheduleRegen();
    if (e.isNew && d.featureType === "sketch") this.openSketch(d.id);
  }
  cancelFeature(): void {
    if (!this.state.editing) return;
    this.set({ editing: null });
    this.view.setFilter(null);
    this.refreshSketches();
    this.scheduleRegen();
  }

  private requireEdit(): boolean {
    if (this.state.canEdit) return true;
    if (this.pastDoc) { this.host.toast("This is an earlier version. Go back to the current one to edit.", 3000); return false; }
    this.host.toast(this.state.status.role === "commenter" ? "You can comment here, but not edit." : this.host.signedIn ? "You have view-only access to this project." : "Sign in to edit.", 3000);
    return false;
  }

  // ---------------------------------------------------------------- sketches
  /** Open a sketch for drawing: the camera turns to face its plane and the sketch tools appear. */
  openSketch(featureId: string): void {
    if (!this.requireEdit()) return;
    this.select([]);
    this.set({ sketch: { featureId, tool: "select" }, editing: null, selectedFeature: featureId });
    this.view.setFilter(["sketch"]);
    this.refreshSketches();
    this.scheduleRegen();
    const face = () => {
      const f = this.state.features.find((x) => x.id === featureId);
      const plane = f && (f.params.plane as unknown as PlaneRef | undefined);
      const datum = plane && plane.kind === "datum" ? this.state.datums.find((d) => d.featureId === plane.feature) : undefined;
      const frame = this.view.sketchFrame(featureId) || (plane && plane.kind === "plane" ? DEFAULT_PLANES[plane.plane]?.frame : datum?.frame || null);
      if (frame) this.viewport.lookAlong(new THREE.Vector3(...frame.normal).negate(), new THREE.Vector3(...frame.y));
    };
    face(); window.setTimeout(face, 400);   // again once the worker has said where a sketch on a face lies
  }
  finishSketch(): void {
    if (!this.state.sketch) return;
    this.view.pointerTool = null; this.keyHandler = null;
    this.view.setOverlay(null); this.view.setFilter(null);
    this.set({ sketch: null });
    this.select([]);
    this.refreshSketches();
    this.scheduleRegen();
    this.viewport.setView("iso");
  }
  /** Take a sketch tool in hand ("select" puts it down).  The tool's own file installs its pointer handling. */
  setSketchTool(tool: string): void {
    const s = this.state.sketch; if (!s) return;
    this.view.pointerTool = null; this.keyHandler = null; this.view.setOverlay(null);
    this.set({ sketch: { ...s, tool } });
  }

  setPlanesVisible(on: boolean): void { this.view.setPlanesVisible(on); this.set({ planesVisible: on }); }

  // ---------------------------------------------------------------- keys
  private onKey = (ev: KeyboardEvent): void => {
    if (this.keyHandler && this.keyHandler(ev)) { ev.preventDefault(); ev.stopPropagation(); return; }
    const s = this.state, mod = ev.ctrlKey || ev.metaKey;
    const used = () => { ev.preventDefault(); ev.stopPropagation(); };
    if (mod && !ev.shiftKey && ev.key.toLowerCase() === "z") { this.undo(); used(); return; }
    if (mod && (ev.key.toLowerCase() === "y" || (ev.shiftKey && ev.key.toLowerCase() === "z"))) { this.redo(); used(); return; }
    if (mod || ev.altKey) return;
    if (ev.key === "Escape") {
      if (s.editing) this.cancelFeature();
      else if (s.sketch && s.sketch.tool !== "select") this.setSketchTool("select");
      else if (s.selection.length) this.select([]);
      else if (s.sketch) this.finishSketch();
      used(); return;
    }
    if (ev.key === "Enter" && s.editing) { this.acceptFeature(); used(); return; }
    for (const t of TOOLS) {
      if (!t.key || t.key.toLowerCase() !== ev.key.toLowerCase()) continue;
      if (t.group === "sketch" && !s.sketch) continue;
      if (t.disabled && t.disabled(this)) continue;
      t.run(this); used(); return;
    }
  };
}
