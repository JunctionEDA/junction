// offline.ts — what to tell a person about the connection, and when.  The part studio keeps working without the
// server: the model is built in the browser, an edit is applied at once and waits in the session's journal
// (shared/itemdoc/journal.ts, which outlives a closed tab) until the connection is back.  What was missing was
// saying so: a banner while offline with how many edits wait, and a word when they have been sent.  Pure.

export interface OfflineFacts {
  /** the session's state (shared/itemdoc/sync.ts) */
  state: "connecting" | "live" | "offline" | "error";
  /** the document has arrived at least once: there is something to work on */
  loaded: boolean;
  /** edits made here the server has not acknowledged */
  unsaved: number;
  /** the connection was lost since the page opened, and how many edits were waiting when it came back (null: it was never lost, or the word has been said) */
  cameBack: number | null;
  /** edits taken over from an earlier visit's journal that have now been sent (0: none, or the word has been said) */
  restored: number;
  canEdit: boolean;
}
export interface OfflineNotice { kind: "offline" | "sent" | "restored"; text: string; detail: string }

const edits = (n: number): string => `${n} edit${n === 1 ? "" : "s"}`;

export function offlineNotice(f: OfflineFacts): OfflineNotice | null {
  if (!f.loaded || f.state === "error") return null;
  if (f.state !== "live") {
    if (!f.canEdit) return { kind: "offline", text: "Offline", detail: "You can keep looking at the model. It will catch up when the connection is back." };
    return {
      kind: "offline", text: f.unsaved ? `Offline: ${edits(f.unsaved)} waiting` : "Offline",
      detail: f.unsaved ? `Keep working. ${f.unsaved === 1 ? "It is" : "They are"} kept in this browser, even if you close the tab, and sent when the connection is back.` : "Keep working. Your edits are kept in this browser and sent when the connection is back.",
    };
  }
  if (f.unsaved) return null;   // live and still sending: say it once it is done
  if (f.cameBack !== null && f.cameBack > 0) return { kind: "sent", text: "Back online", detail: `${edits(f.cameBack)} made offline ${f.cameBack === 1 ? "was" : "were"} sent.` };
  if (f.restored > 0) return { kind: "restored", text: "Unsent edits recovered", detail: `${edits(f.restored)} from your last visit ${f.restored === 1 ? "was" : "were"} still waiting and ${f.restored === 1 ? "has" : "have"} now been sent.` };
  return null;
}
