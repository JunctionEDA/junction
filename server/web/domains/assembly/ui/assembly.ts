// assembly.ts — an open assembly: its document's session, its viewport and the interface state, in the one
// object every assembly tool is handed.  Today it shows the instance and mate lists and an empty viewport;
// drawing instances (reading part studios and boards) and solving mates build on it.
import type { ItemChange, ItemDoc } from "../../../shared/itemdoc/itemdoc";
import { ItemDocSession, type SessionStatus } from "../../../shared/itemdoc/sync";
import type { DocumentHostContext } from "../../../platform/documents/host";
import { Viewport3D } from "../../../shared/viewport3d/viewport3d";
import { ASSEMBLY_KIND, instancesOf, matesOf, type InstanceItem, type MateItem } from "../document/format";
import { MATES, TOOLS } from "../generated/page";

export interface AssemblyState {
  loaded: boolean;
  status: SessionStatus;
  canEdit: boolean;
  instances: InstanceItem[];
  mates: MateItem[];
  selected: string | null;
}

export class AssemblyEditor {
  readonly session: ItemDocSession;
  readonly viewport: Viewport3D;
  private state: AssemblyState = { loaded: false, status: { state: "connecting", text: "connecting…", role: null, canEdit: false }, canEdit: false, instances: [], mates: [], selected: null };
  private listeners = new Set<() => void>();
  private closed = false;

  constructor(readonly host: DocumentHostContext, canvasHost: HTMLElement) {
    this.viewport = new Viewport3D(canvasHost);
    this.viewport.fit();
    this.session = new ItemDocSession({
      docId: host.doc.docId, signedIn: host.signedIn, expectKind: ASSEMBLY_KIND,
      onChange: () => { const doc = this.session.doc; if (doc) this.set({ loaded: true, instances: instancesOf(doc), mates: matesOf(doc) }); },
      onStatus: (status) => { host.setConnection(status.state === "live" ? "live" : status.state === "error" ? "error" : "offline", status.text); this.set({ status, canEdit: status.canEdit }); },
      onNotice: (text) => host.toast(text, 4000),
    });
    this.session.start();
  }

  getState = (): AssemblyState => this.state;
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private set(patch: Partial<AssemblyState>): void { if (this.closed) return; this.state = { ...this.state, ...patch }; for (const fn of Array.from(this.listeners)) fn(); }

  get doc(): ItemDoc | null { return this.session.doc; }
  mateTypes() { return MATES; }
  tools() { return TOOLS; }
  /** The one way the assembly changes: item changes through the session (applied here, sent, undoable). */
  commit(changes: ItemChange[]): boolean { return this.session.commit(changes); }
  select(id: string | null): void { this.set({ selected: id }); }

  close(): void { this.closed = true; this.session.close(); this.viewport.dispose(); this.listeners.clear(); }
}
