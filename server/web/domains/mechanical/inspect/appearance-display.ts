// appearance-display.ts — how the part studio's bodies are drawn: their colours and opacity (per part and per
// face, from the document's appearance and material items), the view mode (shaded with edges, shaded,
// wireframe, hidden line), which parts are hidden or isolated, and the clipping planes of a section view.
//
// It dresses the meshes ModelView makes (`view.bodyObjects`) with its own materials, again after every
// regeneration (`view.onBodies`), so ModelView stays the one place bodies are built.  Hidden parts are moved to
// another layer as well as made invisible: the picking ray skips them.
import * as THREE from "three";
import { edgeColor, edgeLineMaterial, partColor, studioSurface } from "../../../shared/viewport3d/look";
import { getViewPrefs, setViewPrefs } from "../../../shared/viewport3d/viewprefs";
import { tokenColor } from "../../../shared/viewport3d/viewport3d";
import { looksOf, type BodyLook } from "../document/appearance-items";
import { materialsOf, type Material } from "../document/mass-materials";
import type { PartStudio } from "../ui/studio";
import { Store, perStudio } from "./store";

export type ViewMode = "shaded-edges" | "shaded" | "wireframe" | "hidden-line" | "translucent";
/** The modes W goes round, in order. */
export const VIEW_MODES: { id: ViewMode; title: string }[] = [
  { id: "shaded-edges", title: "Shaded with edges" }, { id: "shaded", title: "Shaded" },
  { id: "wireframe", title: "Wireframe" }, { id: "hidden-line", title: "Hidden edges removed" },
];
/** Every mode the view menu and the Appearance panel offer: Translucent is chosen there, and W leaves it for the round. */
export const ALL_VIEW_MODES: { id: ViewMode; title: string }[] = [...VIEW_MODES, { id: "translucent", title: "Translucent" }];
/** how much of a part is seen in the Translucent mode */
export const TRANSLUCENT = 0.38;

export interface DisplayState {
  mode: ViewMode;
  /** parts hidden by hand */
  hidden: string[];
  /** when set, only these parts are shown */
  isolated: string[] | null;
  perspective: boolean;
  /** parts this person looks through (the parts list's "Make transparent"): a way of looking, not the document's opacity */
  transparent: string[];
}

/** how much of a part made transparent in the view is still seen */
export const SEE_THROUGH = 0.28;

const HIDDEN_LAYER = 7;

interface Dressed { mats: THREE.Material[]; edge: THREE.LineBasicMaterial }

export class BodyDisplay extends Store<DisplayState> {
  private dressed = new Map<string, Dressed>();
  private clip: THREE.Plane[] = [];
  private lastFeatures: unknown = null;
  private looks: { [bodyId: string]: BodyLook } = {};
  private materials: { library: { [id: string]: Material }; assign: { [bodyId: string]: string } } = { library: {}, assign: {} };
  private theme = { edge: new THREE.Color(), ink: new THREE.Color(), paper: new THREE.Color(), dark: false };
  /** the place of each part among those nobody coloured: which colour of the palette it is told apart by */
  private palette = new Map<string, number>();
  /** Called after the bodies were re-dressed (the section view rebuilds its caps). */
  readonly onApplied: (() => void)[] = [];

  constructor(readonly studio: PartStudio) {
    // the display mode is this person's, in every part studio (shared/viewport3d/viewprefs.ts)
    super({ mode: getViewPrefs().mode, hidden: [], isolated: null, perspective: studio.viewport.projection === "perspective", transparent: [] });
    studio.viewport.renderer.localClippingEnabled = true;
    this.readTheme();
    studio.viewport.onTheme.push(() => { this.readTheme(); this.apply(); });
    studio.view.onBodies.push(() => this.apply());
    studio.subscribe(() => {
      const s = studio.getState();
      if (s.features === this.lastFeatures) return;
      this.lastFeatures = s.features;
      if (this.readDocument()) this.apply();
    });
    this.readDocument();
    this.apply();
  }

  private readTheme(): void {
    const ink = tokenColor("--ink"), paper = tokenColor("--paper");
    this.theme.dark = paper.getHSL({ h: 0, s: 0, l: 0 }).l < 0.5;
    this.theme.edge.copy(edgeColor(this.theme.dark));
    this.theme.ink.copy(ink);
    this.theme.paper.copy(paper);
  }

  /** Re-read the appearance and material items; true when what is drawn must change. */
  private readDocument(): boolean {
    const doc = this.studio.doc;
    const looks = looksOf(doc), m = materialsOf(doc);
    const materials = { library: m.library, assign: m.assign };
    const same = JSON.stringify(looks) === JSON.stringify(this.looks) && JSON.stringify(materials) === JSON.stringify(this.materials);
    this.looks = looks; this.materials = materials;
    return !same;
  }

  // ---------------------------------------------------------------- what a part looks like
  /** The colour a part is drawn in: its own, else its material's, else one of the palette's (the first part's is the neutral). */
  colorOf(bodyId: string): THREE.Color {
    const own = this.looks[bodyId]?.color;
    if (own) return new THREE.Color(own);
    const mat = this.materials.assign[bodyId] && this.materials.library[this.materials.assign[bodyId]];
    if (mat) return new THREE.Color(mat.color);
    return partColor(this.palette.get(bodyId) ?? 0, this.theme.dark);
  }
  /** The colour as "#rrggbb" for an input. */
  hexOf(bodyId: string): string { return "#" + this.colorOf(bodyId).getHexString(); }
  opacityOf(bodyId: string): number { return this.looks[bodyId]?.opacity ?? 1; }
  /** The opacity a part is drawn with: the document's, or less while this person looks through it. */
  drawnOpacity(bodyId: string): number { const o = this.opacityOf(bodyId); return this.state.transparent.includes(bodyId) ? Math.min(o, SEE_THROUGH) : o; }
  isTransparent(bodyId: string): boolean { return this.state.transparent.includes(bodyId); }
  lookOf(bodyId: string): BodyLook { return this.looks[bodyId] || {}; }
  isVisible(bodyId: string): boolean {
    const s = this.state;
    return !s.hidden.includes(bodyId) && (!s.isolated || s.isolated.includes(bodyId));
  }

  // ---------------------------------------------------------------- what the person asks for
  setMode(mode: ViewMode): void { this.set({ mode }); setViewPrefs({ mode }); this.apply(); }
  cycleMode(): void { const i = VIEW_MODES.findIndex((m) => m.id === this.state.mode); this.setMode(VIEW_MODES[(i + 1) % VIEW_MODES.length].id); }
  /** The opacity a part is drawn with in the mode in force. */
  private modeOpacity(bodyId: string): number { const o = this.drawnOpacity(bodyId); return this.state.mode === "translucent" ? Math.min(o, TRANSLUCENT) : o; }
  setPerspective(on: boolean): void { this.studio.viewport.setProjection(on ? "perspective" : "orthographic"); this.set({ perspective: on }); }
  /** Keep the toggle in step after a named view changed the projection. */
  syncProjection(): void { this.set({ perspective: this.studio.viewport.projection === "perspective" }); }
  hide(ids: readonly string[]): void { this.set({ hidden: Array.from(new Set([...this.state.hidden, ...ids])) }); this.apply(); }
  show(ids: readonly string[]): void {
    const s = this.state;
    const isolated = s.isolated ? Array.from(new Set([...s.isolated, ...ids])) : null;
    this.set({ hidden: s.hidden.filter((h) => !ids.includes(h)), isolated }); this.apply();
  }
  toggle(id: string): void { if (this.isVisible(id)) this.hide([id]); else this.show([id]); }
  isolate(ids: readonly string[] | null): void { this.set({ isolated: ids && ids.length ? ids.slice() : null, hidden: ids ? this.state.hidden.filter((h) => !ids.includes(h)) : this.state.hidden }); this.apply(); }
  showAll(): void { this.set({ hidden: [], isolated: null }); this.apply(); }
  /** Look through these parts, or stop: this person's view only (the document's opacity is the Appearance panel's). */
  setTransparent(ids: readonly string[], on: boolean): void {
    const now = this.state.transparent;
    this.set({ transparent: on ? Array.from(new Set([...now, ...ids])) : now.filter((t) => !ids.includes(t)) }); this.apply();
  }
  /** The clipping planes every body is cut by (the section view). */
  setClip(planes: THREE.Plane[]): void { this.clip = planes; for (const d of this.dressed.values()) { for (const m of d.mats) m.clippingPlanes = planes; d.edge.clippingPlanes = planes; } this.studio.viewport.invalidate(); }

  // ---------------------------------------------------------------- dressing the meshes
  apply(): void {
    const s = this.state, view = this.studio.view;
    const live = new Set<string>();
    // parts nobody coloured take the palette's colours in the order of the parts list; a board is not a part
    this.palette.clear();
    for (const b of this.studio.getState().bodies) if (!b.reference) this.palette.set(b.id, this.palette.size);
    const lines = s.mode === "wireframe" || s.mode === "hidden-line";
    // line work is not shaded where surfaces meet
    this.studio.viewport.look.contact = s.mode === "hidden-line" ? 0 : 1;
    for (const b of this.studio.getState().bodies) {
      const o = view.bodyObjects(b.id); if (!o || !b.mesh) continue;
      live.add(b.id);
      const old = this.dressed.get(b.id);
      if (old) { for (const m of old.mats) m.dispose(); old.edge.dispose(); }
      const color = this.colorOf(b.id), opacity = this.modeOpacity(b.id), look = this.looks[b.id] || {};
      const see = opacity < 1;
      // a metal shows what is around it: in a scene with nothing around to show (no environment map) it would be drawn black, so it is drawn less of a metal
      const metal = this.studio.viewport.scene.environment ? 1 : 0.45;
      const surface = (c: THREE.Color): THREE.Material => {
        const common = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, transparent: see, opacity, depthWrite: !see, clippingPlanes: this.clip };
        return s.mode === "hidden-line" ? new THREE.MeshBasicMaterial({ ...common, color: this.theme.paper, transparent: false, opacity: 1, depthWrite: true })
          : (() => {
            const m = studioSurface(new THREE.MeshStandardMaterial({ ...common, color: c }));
            // an appearance from the library says both (document/materials-library.ts)
            if (look.roughness !== undefined) m.roughness = look.roughness;
            if (look.metalness !== undefined) m.metalness = look.metalness * metal;
            return m;
          })();
      };
      // per-face colours: one material per colour, the faces' triangle ranges as geometry groups
      const g = o.mesh.geometry;
      g.clearGroups();
      const mats: THREE.Material[] = [surface(color)];
      const faceColors = s.mode === "hidden-line" ? {} : look.faces || {};
      if (Object.keys(faceColors).length) {
        const slot = new Map<string, number>();
        const names = b.mesh.faces.names;
        for (let i = 0; i < names.length; i++) {
          const c = faceColors[names[i]];
          let at = 0;
          if (c) { if (!slot.has(c)) { slot.set(c, mats.length); mats.push(surface(new THREE.Color(c))); } at = slot.get(c)!; }
          g.addGroup(b.mesh.faces.start[i], b.mesh.faces.count[i], at);
        }
      }
      o.mesh.material = mats.length > 1 ? mats : mats[0];
      // shaded parts carry dark hairlines whatever the theme; line work is drawn in the theme's ink
      const edge = edgeLineMaterial({ color: lines ? this.theme.ink : this.theme.edge, clippingPlanes: this.clip, opacity: see ? Math.max(0.35, opacity) : 1 });
      o.edges.material = edge;
      this.dressed.set(b.id, { mats, edge });
      // the view mode
      // (a body something else draws in its own way, as the Board feature's solids under the board's picture,
      // stays hidden: viewport/modelview.ts bodyStyle)
      const style = this.studio.view.bodyStyle ? this.studio.view.bodyStyle(o.result) : null;
      o.mesh.visible = s.mode !== "wireframe" && !(style && style.faces === false);
      o.edges.visible = s.mode !== "shaded" && !(style && style.edges === false);
      // hidden parts: not drawn, and not on the layer the picking ray sees
      const visible = this.isVisible(b.id);
      o.group.visible = visible;
      for (const x of [o.mesh, o.edges, o.points]) x.layers.set(visible ? 0 : HIDDEN_LAYER);
    }
    for (const [id, d] of Array.from(this.dressed)) if (!live.has(id)) { for (const m of d.mats) m.dispose(); d.edge.dispose(); this.dressed.delete(id); }
    this.studio.viewport.look.contentChanged();
    this.studio.viewport.invalidate();
    for (const fn of this.onApplied) fn();
  }
}

export const displayOf = (studio: PartStudio): BodyDisplay => perStudio(studio, "appearance-display", (s) => new BodyDisplay(s));

/** The bodies a selection is on (faces, edges and vertices of them). */
export function selectedBodies(studio: PartStudio): string[] {
  const out: string[] = [];
  for (const p of studio.getState().selection) if ((p.kind === "face" || p.kind === "edge" || p.kind === "vertex") && !out.includes(p.body)) out.push(p.body);
  return out;
}
