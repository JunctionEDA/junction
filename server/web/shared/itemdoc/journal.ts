// journal.ts — the edits a session has made that the server has not acknowledged, kept where a closed tab does
// not lose them.  A session (sync.ts) journals an edit before it sends it and replays what is unacknowledged
// after a reconnect; that journal lives in memory, so edits made while the connection was down were lost when
// the tab was closed or reloaded before it came back.  With a journal of this kind handed to the session
// (`SessionOptions.journal`) they are written to the browser's storage as they are made and read back by the
// next session on the same document, which sends them: the server drops an edit it has already stored (it
// knows the edit's id), so one whose acknowledgement was lost is not applied twice.
//
// Kept per document under `junction.itemdoc.pending.<docId>`.  What is read back is checked: a journal is a
// person's unsaved work, but it is also whatever was in storage.
import type { ItemChange } from "./itemdoc";

export interface PendingOp { clientOpId: string; changes: ItemChange[] }
export interface SessionJournal {
  /** the edits a session before this one left unsent, oldest first */
  load(): PendingOp[];
  /** the unacknowledged edits as they are now (an empty list forgets the journal) */
  save(pending: readonly PendingOp[]): void;
}
/** the part of the Storage interface this needs (so a test hands in a plain object) */
export interface JournalStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export const journalKey = (docId: string): string => `junction.itemdoc.pending.${docId}`;
/** more than this is not kept (a browser gives a site about 5 MB): the session says so once through `full` */
export const JOURNAL_LIMIT = 2_000_000;

const isChange = (c: unknown): c is ItemChange => {
  if (!c || typeof c !== "object") return false;
  const x = c as { id?: unknown; kind?: unknown; item?: unknown; props?: unknown };
  if (typeof x.id !== "string") return false;
  if (x.kind === "ADDED") return !!x.item && typeof x.item === "object" && (x.item as { id?: unknown }).id === x.id;
  if (x.kind === "MODIFIED") return Array.isArray(x.props) && x.props.every((p) => p && typeof p === "object" && Array.isArray((p as { path?: unknown }).path));
  return x.kind === "REMOVED";
};

/** What a stored journal holds, with everything that is not an edit left out. */
export function parseJournal(text: string | null): PendingOp[] {
  if (!text) return [];
  let v: unknown;
  try { v = JSON.parse(text); } catch { return []; }
  const ops = v && typeof v === "object" && Array.isArray((v as { ops?: unknown }).ops) ? (v as { ops: unknown[] }).ops : [];
  const out: PendingOp[] = [], seen = new Set<string>();
  for (const o of ops) {
    const op = o as { clientOpId?: unknown; changes?: unknown };
    if (!op || typeof op.clientOpId !== "string" || !Array.isArray(op.changes) || !op.changes.length || !op.changes.every(isChange) || seen.has(op.clientOpId)) continue;
    seen.add(op.clientOpId);
    out.push({ clientOpId: op.clientOpId, changes: op.changes as ItemChange[] });
  }
  return out;
}

/**
 * The journal of one document in the browser's storage.  `full` is called when the unsent edits no longer fit
 * (they stay in memory and are still sent; only the copy that survives a closed tab is behind).
 */
export function storedJournal(docId: string, storage: JournalStorage | null = defaultStorage(), full?: () => void): SessionJournal {
  const key = journalKey(docId);
  let warned = false;
  return {
    load() { try { return storage ? parseJournal(storage.getItem(key)) : []; } catch { return []; } },
    save(pending) {
      if (!storage) return;
      try {
        if (!pending.length) { storage.removeItem(key); warned = false; return; }
        const text = JSON.stringify({ v: 1, at: Date.now(), ops: pending });
        if (text.length > JOURNAL_LIMIT) throw new Error("too large");
        storage.setItem(key, text);
      } catch { if (!warned) { warned = true; full?.(); } }
    },
  };
}

function defaultStorage(): JournalStorage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/** How many edits wait in a document's journal (the projects page can say a document has unsent work). */
export function journalled(docId: string, storage: JournalStorage | null = defaultStorage()): number {
  try { return storage ? parseJournal(storage.getItem(journalKey(docId))).length : 0; } catch { return 0; }
}
