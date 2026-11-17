// types.ts — instance sources: where an instance's geometry comes from.
//
// An instance stores `source: { kind, docId, … }` (document/format.ts) and copies no geometry.  A source KIND is
// one file in this folder that default-exports a SourceProvider; the manager (manager.ts) opens one handle per
// source document and keeps it live, so an assembly follows its parts as they are edited.
//
// To add a kind (a board, a STEP file): write `sources/<kind>.ts`, add it to the list in manager.ts, and give
// every piece a mesh in the mechanical domain's BodyMesh form with stable names for its faces, edges and
// vertices.  Those names are what mates store, so they must survive a rebuild of the source.
import type { BodyMesh, KernelClient } from "../../mechanical/api";
import type { InstanceSource, Transform } from "../document/format";

/** One rigid piece of geometry a source offers: a body of a part studio, a part inside a sub-assembly. */
export interface SourcePiece {
  /** stable within the source document; a mate's GeomRef.body names it */
  id: string;
  name: string;
  /** shared by every instance that shows this piece: never mutate it.  A new object means new geometry. */
  mesh: BodyMesh;
  /** where the piece sits in the source's own space; null is "where the mesh already is" */
  transform: Transform | null;
}

export interface SourceSnapshot {
  status: "loading" | "ready" | "error";
  /** why it failed, or what it is waiting for */
  message?: string;
  pieces: SourcePiece[];
  /** goes up whenever `pieces` or `status` change */
  version: number;
}

/** One open source document. */
export interface SourceHandle {
  snapshot(): SourceSnapshot;
  /** the worker that holds this document's B-rep, when the kind has one and it is running (analysis tools) */
  kernel?(): KernelClient | null;
  /** the document as worker input, for a tool that wants to rebuild it in a worker of its own */
  features?(): { features: unknown[]; rollback: number } | null;
  close(): void;
}

export interface SourceEnv {
  signedIn: boolean;
  /** call when the snapshot changed */
  changed(): void;
  /** the source documents this one is being opened inside, outermost first: a sub-assembly must not contain itself */
  ancestry: readonly string[];
  /** open another source from inside this one (a sub-assembly opens its parts) */
  open(kind: InstanceSource["kind"], docId: string, changed: () => void): SourceHandle;
}

export interface SourceOffer { source: InstanceSource; name: string }

export interface SourceProvider {
  kind: InstanceSource["kind"];
  /** the server document types (DocumentHostContext.docs[].docType) this kind reads */
  docTypes: string[];
  /** what Insert calls a document of this kind: "Part studio" */
  title: string;
  /** Why this kind cannot be inserted yet, or null when it can. */
  unavailable(): string | null;
  open(docId: string, env: SourceEnv): SourceHandle;
  /** the pieces of the source document that an instance with this `source` shows */
  select(source: InstanceSource, snapshot: SourceSnapshot): SourcePiece[];
  /** what Insert offers from a loaded document: each is one instance to add */
  offers(docId: string, docName: string, snapshot: SourceSnapshot): SourceOffer[];
  /** true when Insert may also add everything the document offers at once ("the whole studio") */
  offersAll: boolean;
}
