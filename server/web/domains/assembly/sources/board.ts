// board.ts — the "board" source: a circuit board of the project as an instance (`{ kind: "board", docId }`).
//
// NOT BUILT.  The format, the instance list and the solver already carry board instances; what is missing is the
// geometry.  This file is where it goes, and what it must provide is small:
//
//   open(docId, env)   a SourceHandle whose snapshot has ONE piece (id "board") or one per rigid part of the
//                      board model, each with a BodyMesh (mechanical/api.ts) in millimetres, Z up, the board's
//                      own origin
//   mesh.faces.names   stable names for what a mate may pick: the board's top and bottom ("board:top",
//                      "board:bottom"), its outline edges, and one cylindrical face per mounting hole
//                      ("hole:<pad or footprint reference>") so that a screw can be mated to it.  Names must
//                      not change when the board is edited elsewhere.
//   env.changed()      called whenever the board's outline, thickness or holes change, with a new snapshot
//
// The mechanical domain's board reference (mechanical/board/) builds exactly such a body from a board
// document; when it exports a function that returns it as a BodyMesh with names, `open` below becomes a call to
// it and `unavailable` returns null.  Until then Insert lists a project's boards and says why they cannot be
// added, and a board instance that is already in a document draws nothing and says so in the instance list.
import type { SourceProvider, SourceSnapshot } from "./types";

const WHY = "Boards cannot be placed in an assembly yet: the board's 3D model is not connected to assemblies.";

export function boardSource(): SourceProvider {
  const snapshot: SourceSnapshot = { status: "error", message: WHY, pieces: [], version: 1 };
  return {
    kind: "board",
    docTypes: ["kicad_pcb"],
    title: "Board",
    unavailable: () => WHY,
    open: () => ({ snapshot: () => snapshot, close() {} }),
    select: (_source, snap) => snap.pieces,
    offers: (docId, docName) => [{ source: { kind: "board", docId }, name: docName }],
    offersAll: false,
  };
}
