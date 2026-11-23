// editor-state.ts — the custom feature editor's state for one part studio: the script being written, what it
// declares, how its last run went, and the feature through which it is previewed on the part.
//
// The preview is not a thing of the editor's own: it is an ordinary feature draft of the studio
// (studio.startFeature / setDraft), whose type is the version of the script in the buffer.  So the generated
// dialog is the real dialog, the preview is the real regeneration with its soundness check, and "Add to part" is
// the dialog's own ✓.  Each pause in typing asks the worker what the script declares (script-describe); a
// script that reads moves the draft to the new version, one that does not leaves the last good preview up and
// shows the problem on its line.  Nothing reaches the project until Save.
import type { JsonObject } from "../../../../shared/itemdoc/itemdoc";
import { featuresOf } from "../../document/format";
import type { PartStudio } from "../../ui/studio";
import { freeName, saveScript } from "../library";
import { SCRIPT_KEY, defaultsOf, isScriptType, parseScriptType, sourceHash, type ScriptManifest, type ScriptRef } from "../manifest";
import type { LastRun } from "../run";
import { commitLibrary, library, libraryAvailable, libraryItems, registerWorking, subscribeLibrary } from "../store";

export interface Problem { message: string; line?: number }
export interface Proposal { source: string; summary: string }

export interface EditorState {
  open: boolean;
  /** the script's id: the library's, or one made for a script not saved yet */
  id: string;
  name: string;
  source: string;
  /** the library's text of this script as the editor last took it (null: never saved) */
  saved: string | null;
  manifest: ScriptManifest | null;
  /** what is wrong with the declaration (the script cannot be read, a parameter is malformed) */
  problems: Problem[];
  /** how the previewed feature's script last ran: console, reports, error and its line */
  run: LastRun | null;
  /** the feature the preview is: a new draft, or one already in the part */
  previewId: string | null;
  /** somebody else saved this script while the buffer has changes of its own */
  theirs: string | null;
  /** what the assistant offers instead of the buffer, shown as a difference until accepted or discarded */
  proposal: Proposal | null;
  busy: boolean;
}

const CLOSED: EditorState = { open: false, id: "", name: "", source: "", saved: null, manifest: null, problems: [], run: null, previewId: null, theirs: null, proposal: null, busy: false };

export const STARTER = `// A custom feature.  Everything it can do is on ctx, and the 2D work is in Geo2:
// press Ctrl+Space for the list, hover a name for what it does.
feature({
  title: "My feature",
  description: "What it does, in a line.",
  icon: "pockets",
  params: {
    face: { type: "face", label: "Face", hint: "A flat face. Left empty: the largest flat face." },
    diameter: { type: "length", label: "Diameter", default: 8, min: 0.5 },
    depth: { type: "length", label: "Depth", default: 3, min: 0.1 },
  },

  evaluate(ctx, p) {
    const face = p.face || ctx.body().face({ kind: "plane" });
    if (!face || !face.plane) throw ctx.fail("Pick a flat face.");
    const middle = Geo2.bounds(face.outline().outer).centre;
    face.cut(Geo2.circle(middle, p.diameter / 2), { depth: p.depth });
  },
});
`;

export class ScriptEditor {
  private state: EditorState = CLOSED;
  private listeners = new Set<() => void>();
  private timer = 0;
  private seq = 0;
  private stops: (() => void)[] = [];
  private lastReport: unknown = null;
  /** the name is still the one the script's title gave it: it follows the title until the person types one */
  private nameFollows = false;

  constructor(readonly studio: PartStudio) {}
  getState = (): EditorState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<EditorState>): void { this.state = { ...this.state, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }

  /** The text the preview runs: the assistant's proposal while one is on the table, else the buffer. */
  private shown(): string { return this.state.proposal ? this.state.proposal.source : this.state.source; }

  // ---------------------------------------------------------------- opening and closing

  openNew(source = STARTER, name = ""): void { this.openWith({ id: crypto.randomUUID(), name, source, saved: null }); }
  openScript(id: string): boolean {
    const s = library().find((x) => x.id === id);
    if (!s) return false;
    this.openWith({ id: s.id, name: s.name, source: s.source, saved: s.source });
    return true;
  }
  /** Open the script a feature of the part was made from, previewed on that feature. */
  openFeature(featureId: string): boolean {
    const doc = this.studio.doc, f = doc ? featuresOf(doc).find((x) => x.id === featureId) : undefined;
    const t = f ? parseScriptType(f.featureType) : null, raw = f ? (f.params as JsonObject)[SCRIPT_KEY] as { source?: unknown; name?: unknown } | undefined : undefined;
    if (!f || !t || !raw || typeof raw.source !== "string") return false;
    const inLib = library().find((x) => x.id === t.id);
    this.openWith({ id: t.id, name: inLib ? inLib.name : String(raw.name || f.name), source: inLib ? inLib.source : raw.source, saved: inLib ? inLib.source : null }, featureId);
    return true;
  }
  private openWith(s: { id: string; name: string; source: string; saved: string | null }, previewId: string | null = null): void {
    if (this.state.open) this.close();
    this.state = { ...CLOSED, open: true, ...s, previewId };
    this.nameFollows = false;
    // for the console and the browser tests, as the studio is (window.JunctionPartStudio)
    (window as unknown as { JunctionScriptEditor?: ScriptEditor }).JunctionScriptEditor = this;
    this.stops = [
      this.studio.subscribe(() => this.studioChanged()),
      subscribeLibrary(() => this.libraryChanged()),
    ];
    this.set({});
    void this.describe(true);
  }
  close(): void {
    if (!this.state.open) return;
    clearTimeout(this.timer);
    for (const stop of this.stops.splice(0)) stop();
    const e = this.studio.getState().editing;
    // a preview that was never added goes; a feature of the part being edited is put down unchanged
    if (e && e.draft.id === this.state.previewId) this.studio.cancelFeature();
    void this.studio.kernel.call("script-run", { dispose: true }).catch(() => {});
    this.set({ ...CLOSED });
    const w = window as unknown as { JunctionScriptEditor?: ScriptEditor };
    if (w.JunctionScriptEditor === this) delete w.JunctionScriptEditor;
  }
  get dirty(): boolean { return this.state.open && this.state.source !== this.state.saved; }

  // ---------------------------------------------------------------- the buffer

  setSource(source: string): void {
    if (source === this.state.source) return;
    this.set({ source });
    if (!this.state.proposal) this.describeSoon();
  }
  setName(name: string): void { this.nameFollows = false; this.set({ name: name.slice(0, 80) }); }
  private describeSoon(): void { clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.describe(false), 450); }

  /** Ask the worker what the shown text declares, and move the preview to it when it reads. */
  async describe(first: boolean): Promise<void> {
    const seq = ++this.seq, source = this.shown();
    let d: { manifest: ScriptManifest | null; problems: Problem[]; hash: string };
    try { d = await this.studio.kernel.call("script-describe", { source }) as unknown as typeof d; }
    catch (e) { if (seq === this.seq) this.set({ problems: [{ message: `The script could not be checked: ${e instanceof Error ? e.message : String(e)}` }] }); return; }
    if (seq !== this.seq || !this.state.open || source !== this.shown()) return;
    if (!d.manifest) { this.set({ problems: d.problems, manifest: this.state.proposal ? this.state.manifest : null }); return; }
    if (first && !this.state.name) this.nameFollows = true;
    this.set({ problems: [], manifest: d.manifest, ...(this.nameFollows && this.state.saved === null ? { name: freeName(libraryItems(), d.manifest.title) } : {}) });
    this.preview({ id: this.state.id, name: this.state.name || d.manifest.title, hash: sourceHash(source), source, manifest: d.manifest });
  }

  /** Put a version of the script on the part: a new draft, the draft moved to this version, or a feature of the part reopened with it. */
  private preview(ref: ScriptRef): void {
    const studio = this.studio, st = studio.getState();
    if (!st.canEdit || st.sketch) return;
    const type = registerWorking(ref);
    const refJson = { id: ref.id, name: ref.name, hash: ref.hash, source: ref.source, manifest: ref.manifest as unknown as JsonObject };
    const fill = (params: JsonObject): JsonObject => {
      // values the person set stay; a parameter this version adds gets its default
      const out: JsonObject = { [SCRIPT_KEY]: refJson }, defaults = defaultsOf(ref.manifest);
      for (const k of Object.keys(defaults)) if (params[k] === undefined) out[k] = defaults[k];
      return out;
    };
    let e = st.editing;
    if (e && e.draft.id === this.state.previewId) {
      // a preview not yet in the part is named after the script as it is now ("Lighten plate 1")
      const rename = e.isNew && e.draft.name.replace(/ \d+$/, "") !== ref.manifest.title && /^(.*) (\d+)$/.test(e.draft.name) ? `${ref.manifest.title} ${/(\d+)$/.exec(e.draft.name)![1]}` : undefined;
      if (e.draft.featureType !== type) studio.setDraft({ featureType: type, params: fill(e.draft.params), ...(rename ? { name: rename } : {}) });
      return;
    }
    if (e) return;   // another dialog is open: the person is doing something else; the preview waits
    const inPart = this.state.previewId && st.features.find((f) => f.id === this.state.previewId);
    if (inPart) {
      if (inPart.featureType === type) return;   // the part already has this version: nothing to show
      studio.editFeature(inPart.id);
      e = studio.getState().editing;
      if (e && e.draft.id === inPart.id) studio.setDraft({ featureType: type, params: fill(e.draft.params) });
      return;
    }
    studio.startFeature(type);
    e = studio.getState().editing;
    if (e && isScriptType(e.draft.featureType)) this.set({ previewId: e.draft.id });
  }

  /** Bring the preview back after the person closed its dialog (✗), or open it for the first time. */
  showPreview(): void { void this.describe(false); }

  // ---------------------------------------------------------------- what the studio and the library say

  private studioChanged(): void {
    const s = this.state; if (!s.open || !s.previewId) return;
    const rep = this.studio.getState().reports[s.previewId];
    if (rep === this.lastReport) return;
    this.lastReport = rep;
    if (!rep) return;
    const id = s.previewId;
    void this.studio.kernel.call("script-last-run", { feature: id }).then((run) => {
      if (this.state.open && this.state.previewId === id) this.set({ run: (run as unknown as LastRun | null) || null });
    }).catch(() => {});
  }
  private libraryChanged(): void {
    const s = this.state; if (!s.open) return;
    const theirs = library().find((x) => x.id === s.id);
    if (!theirs || theirs.source === s.saved) return;
    // nothing of the person's own to lose: follow the project
    if (s.source === s.saved) { this.set({ source: theirs.source, saved: theirs.source, name: theirs.name, theirs: null }); this.describeSoon(); }
    else if (theirs.source !== s.source) this.set({ theirs: theirs.source });
    else this.set({ saved: theirs.source, theirs: null });
  }
  takeTheirs(): void { const t = this.state.theirs; if (t === null) return; this.set({ source: t, saved: t, theirs: null }); this.describeSoon(); }
  keepMine(): void { const t = this.state.theirs; if (t !== null) this.set({ saved: t, theirs: null }); }

  // ---------------------------------------------------------------- the assistant's proposal

  propose(p: Proposal): void { this.set({ proposal: p }); void this.describe(false); }
  acceptProposal(): void { const p = this.state.proposal; if (!p) return; this.set({ source: p.source, proposal: null }); void this.describe(false); }
  discardProposal(): void { if (!this.state.proposal) return; this.set({ proposal: null }); void this.describe(false); }

  // ---------------------------------------------------------------- saving

  /** Save the buffer to the project's library.  Returns what stopped it, or null. */
  save(): string | null {
    const s = this.state;
    if (!s.open) return "Nothing is open.";
    if (s.proposal) return "Accept or discard the assistant's change first.";
    if (!this.studio.getState().canEdit) return "You have view-only access to this project.";
    if (!libraryAvailable()) return "The project's library cannot be reached from this page.";
    if (!s.manifest || s.problems.length) return "Fix the script first: it does not read yet.";
    const items = libraryItems(), existing = library().find((x) => x.id === s.id);
    const name = (s.name.trim() || s.manifest.title).slice(0, 80);
    // a new script takes a name nobody has; one already in the library keeps the name it is given
    const finalName = existing ? name : freeName(items, name);
    commitLibrary(saveScript(items, { id: s.id, name: finalName, source: s.source, manifest: s.manifest }).changes);
    this.set({ saved: s.source, theirs: null, name: finalName });
    return null;
  }
}

const editors = new WeakMap<PartStudio, ScriptEditor>();
export function editorOf(studio: PartStudio): ScriptEditor {
  let e = editors.get(studio);
  if (!e) { e = new ScriptEditor(studio); editors.set(studio, e); }
  return e;
}
