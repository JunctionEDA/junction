// attention.ts — the red marks that say something waits on the person:
//  · "updatePcbFromSchematic": the schematic holds changes the board has not taken yet (Update PCB from Schematic
//    would change something: a footprint to add, a net, a value, a footprint to swap).  KiCad itself has no such
//    mark; the person asked for one, so it is worked out the way the Update PCB dialog's dry run works it out.
//  · "githubPull": GitHub has changes the editor could not pull on its own (changed on both sides, or a file with
//    live edits), waiting on the GitHub sync page.
// The marks live in the app store (state.attention, action id -> why) and show as a pulsing red dot on the toolbar
// button of that action and as a pill in the menu bar (MenuBar.tsx AttentionPills).
import { state, store } from "./appstore";
import { E } from "./state";
import { liveDocument, projectDocs } from "./projectfile";
import { NL } from "./pcbdialogs/canvas";
import { projectNetlist } from "./pcbdialogs/update-pcb";

export const PCB_STALE = "updatePcbFromSchematic";
export const GITHUB_PULL = "githubPull";

export function setAttention(id: string, why: string | null): void {
  const cur = store.get().attention || {};
  if ((cur[id] || null) === why) return;
  const next = Object.assign({}, cur); if (why) next[id] = why; else delete next[id];
  store.set({ attention: next });
}

/** How many things Update PCB from Schematic would change on `board`, or null when it cannot tell. */
export async function pendingBoardUpdates(board?: KDoc | null): Promise<number | null> {
  const docs = projectDocs();
  if (!docs.some((d) => d.docType === "kicad_sch")) return null;
  const target = NL().projectBoardPath(docs); if (!target.doc) return null;
  let doc = board || null;
  if (!doc) {
    const live = await liveDocument(target.doc.docId);
    doc = KiCadCanvas.parseDoc(live.file, "kicad_pcb") as KDoc;
    for (const op of live.ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(doc, c, E.IU); } catch (e) { /* an op this reader cannot take */ } }
  }
  const res = await projectNetlist(); if ("error" in res) return null;
  // the dialog's defaults; a footprint the board lacks counts even though the library is not fetched here
  const plan = NL().planUpdate(doc, res.netlist, { replaceFootprints: true, updateFields: true, footprintFor: () => null });
  const blocked = plan.report.filter((l) => /^Cannot (add|update) /.test(l.text) && !/no footprint assigned/.test(l.text)).length;
  return plan.modified.size + plan.added.length + plan.removed.length + blocked;
}

let timer = 0, quiet = 0, lastKey = "", lastRun = 0, running = false;
async function check(): Promise<void> {
  if (running || document.hidden || state.view !== "editor" || !state.project) return;
  running = true; lastRun = Date.now();
  try {
    const onBoard = !!E.kdoc && (E.kdoc as KDoc).type === "pcb" && E.DOC_TYPE !== "footprint";
    const n = await pendingBoardUpdates(onBoard ? E.kdoc as KDoc : null);
    setAttention(PCB_STALE, n ? `The schematic has ${n} change${n === 1 ? "" : "s"} the board does not have yet. Run Update PCB from Schematic (F8).` : null);
  } catch (e) { /* offline or a document that cannot be read: leave the mark as it was */ }
  finally { running = false; }
}

/** Watch the open project: re-check a few seconds after edits stop, on a tab change, and once a minute for the others' edits. */
export function watchAttention(): void {
  if (timer) return;
  timer = window.setInterval(() => {
    if (state.view !== "editor" || !state.project) { if (lastKey) { lastKey = ""; setAttention(PCB_STALE, null); } return; }
    const key = `${state.project.projectId}|${state.docId}|${E.editsSeen}`;
    if (key !== lastKey) { lastKey = key; quiet = Date.now(); return; }
    if ((quiet && Date.now() - quiet > 4000) || Date.now() - lastRun > 60000) { quiet = 0; void check(); }
  }, 2000);
}
