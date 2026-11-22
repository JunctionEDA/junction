// attention.ts — the red marks that say something waits on the person:
//  · "updatePcbFromSchematic": the schematic holds changes the board has not taken yet (Update PCB from Schematic
//    would change something: a footprint to add, a net, a value, a footprint to swap).  KiCad itself has no such
//    mark; the person asked for one, so it is worked out the way the Update PCB dialog's dry run works it out.
//  · "githubPull": GitHub has changes the editor could not pull on its own (changed on both sides, or a file with
//    live edits), waiting on the GitHub sync page.
// The marks live in the app store (state.attention, action id -> why).  The board's mark is a pulsing red notification
// dot on the Update PCB from Schematic toolbar button only (the person: not in the menu bar); the GitHub one, which has
// no toolbar button, is a pill in the menu bar (MenuBar.tsx AttentionPills).
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

/** The project's board as it is now: the open one, else read from the server with its live edits. */
export async function projectBoard(): Promise<KDoc | null> {
  if (E.kdoc && (E.kdoc as KDoc).type === "pcb" && E.DOC_TYPE !== "footprint") return E.kdoc as KDoc;
  const target = NL().projectBoardPath(projectDocs()); if (!target.doc) return null;
  const live = await liveDocument(target.doc.docId);
  const doc = KiCadCanvas.parseDoc(live.file, "kicad_pcb") as KDoc;
  for (const op of live.ops) for (const c of op.changes || []) { try { KiCadCanvas.applyChange(doc, c, E.IU); } catch (e) { /* an op this reader cannot take */ } }
  return doc;
}

/** How many things Update PCB from Schematic would change on `board`, or null when it cannot tell. */
export async function pendingBoardUpdates(board?: KDoc | null): Promise<number | null> {
  const docs = projectDocs();
  if (!docs.some((d) => d.docType === "kicad_sch")) return null;
  const doc = board || await projectBoard(); if (!doc) return null;
  const res = await projectNetlist(); if ("error" in res) return null;
  // parts, footprints, nets, references and values; not the optional field sync (Update footprint fields from symbols),
  // which differs on most boards (a Datasheet or Description never copied) and would keep the mark lit for nothing.
  // A footprint the board lacks counts even though the library is not fetched here
  const plan = NL().planUpdate(doc, res.netlist, { replaceFootprints: true, updateFields: false, footprintFor: () => null });
  // what the dialog's report lists as things it would do (KiCad's dry run): the plan also touches footprints silently
  // (a symbol path, a sheet name) where nothing the person would see changes, and those do not count
  return plan.report.filter((l) => !/^Total warnings/.test(l.text) && !/no footprint assigned/.test(l.text)).length;
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
