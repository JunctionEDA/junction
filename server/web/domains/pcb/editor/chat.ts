// chat.ts — the project chat: one running conversation per project, for the people working on it together.
//
// Review threads (comments.ts) stay pinned to a part or a net; the chat is the room beside them (people were
// typing to each other in text items on the sheet before it existed).  A message can carry a link to the
// selection or the place you are looking at, on any document of the project: a click on it opens that
// document and brings the place into view.  Messages live on the server (server/src/chat.rs) and reach every
// open document of the project over its socket as {"type": "chat"}.  The Chat pane (components/panes/Chat.tsx)
// and the menu bar's Chat button (with its unread count) render from store.chat.
//
// Cursor chat, as in Figma: Alt+M opens a bubble at your pointer; what you type there shows beside your cursor on
// everyone's canvas as you type it (presence `say`), and Enter posts it to the chat with a link to that spot.
import type { ChatLink, ChatMessage, ChatState } from "../../../shared/store";
import { state, store } from "./appstore";
import { describe, netIds, netOfItem } from "./comments";
import { centerOn } from "./comments";
import { clearAllSelection, selectionChanged, selectionHooks, selectionIds, selectItemId } from "./gestures";
import { sendPresence } from "./peers";
import { E } from "./state";
import { api, toast } from "./util";
import { requestRender, stage, visibleRectNm, worldMm } from "./view";

const request = api as (path: string, opts?: RequestInit) => Promise<unknown>;
const EMPTY: ChatState = { projectId: null, messages: [], loading: false, more: false, error: null, lastReadId: 0, unread: 0, canWrite: false, link: null };
interface Me { id: number; login: string; name?: string | null; avatarUrl?: string | null }
const me = (): Me | null => (state as unknown as { me: Me | null }).me;
const projectId = (): string | null => (state.project ? state.project.projectId : null);
const chat = (): ChatState => store.get().chat || EMPTY;
const setChat = (patch: Partial<ChatState>): void => store.set({ chat: Object.assign({}, chat(), patch) });

/** Whether the composer attaches the selection (or the view) to the next message. */
let attach = false;
let pendingId = 0;

// ---------------------------------------------------------------- loading
let loadN = 0;
/** The chat of the open project: loaded once per project (switching documents keeps it). */
export async function loadChat(force = false): Promise<void> {
  hookOnce();
  const pid = projectId();
  if (!pid) { store.set({ chat: EMPTY }); return; }
  if (!force && chat().projectId === pid) { refreshLink(); return; }
  const n = ++loadN;
  store.set({ chat: Object.assign({}, EMPTY, { projectId: pid, loading: true }) });
  try {
    const j = (await request(`/api/projects/${pid}/chat?limit=100`)) as { messages: ChatMessage[]; more: boolean; lastReadId: number; unread: number; canWrite: boolean };
    if (n !== loadN || projectId() !== pid) return;
    setChat({ messages: j.messages || [], more: !!j.more, lastReadId: j.lastReadId || 0, unread: j.unread || 0, canWrite: !!j.canWrite, loading: false });
  } catch (e) {
    if (n !== loadN) return;
    setChat({ loading: false, error: "The chat could not be loaded." });
    console.warn("chat load failed", e);
  }
  refreshLink();
  maybeMarkRead();
}

async function loadOlder(): Promise<void> {
  const c = chat(), pid = c.projectId; if (!pid || !c.more || c.loading || !c.messages.length) return;
  setChat({ loading: true });
  try {
    const j = (await request(`/api/projects/${pid}/chat?limit=100&before=${c.messages[0].id}`)) as { messages: ChatMessage[]; more: boolean };
    if (chat().projectId !== pid) return;
    const have = new Set(chat().messages.map((m) => m.id));
    setChat({ messages: [...(j.messages || []).filter((m) => !have.has(m.id)), ...chat().messages], more: !!j.more, loading: false });
  } catch { setChat({ loading: false }); }
}

// ---------------------------------------------------------------- live updates
const chatOpen = (): boolean => !!store.get().panes.chat;
const watching = (): boolean => chatOpen() && typeof document !== "undefined" && document.visibilityState === "visible";

/** A message somebody posted, edited or deleted (the server's {"type": "chat"} notice). */
export function noteChatMsg(msg: { projectId?: string; action?: string; message?: ChatMessage & { id: number } }): void {
  const c = chat(), m = msg.message;
  if (!m || !c.projectId || msg.projectId !== c.projectId) return;
  let list = c.messages;
  if (msg.action === "deleted") list = list.filter((x) => x.id !== m.id);
  else if (msg.action === "updated") list = list.map((x) => (x.id === m.id ? m : x));
  else if (msg.action === "added") {
    if (list.some((x) => x.id === m.id)) return;   // our own, already in place (or the same notice twice)
    list = [...list, m];
    const mine = me() && m.authorId === me()!.id;
    if (!mine) {
      setChat({ messages: list, unread: c.unread + 1 });
      if (!watching()) toast(`${m.authorName || m.authorLogin}: ${m.body.length > 90 ? m.body.slice(0, 89) + "…" : m.body}`, 5000, { text: "Open Chat", run: () => openChat() });
      maybeMarkRead();
      return;
    }
  }
  setChat({ messages: list });
}

// ---------------------------------------------------------------- read marks
let readTimer: ReturnType<typeof setTimeout> | 0 = 0;
/** The chat is on screen: whatever is in it has been read (sent a moment later, once). */
export function maybeMarkRead(): void {
  const c = chat(); if (!c.projectId || !me() || !watching()) return;
  const last = c.messages.filter((m) => m.id > 0).reduce((a, m) => Math.max(a, m.id), 0);
  if (!c.unread && last <= c.lastReadId) return;
  setChat({ unread: 0 });
  if (readTimer) return;
  readTimer = setTimeout(async () => {
    readTimer = 0;
    const cc = chat(), pid = cc.projectId; if (!pid) return;
    const upTo = cc.messages.filter((m) => m.id > 0).reduce((a, m) => Math.max(a, m.id), 0);
    if (upTo <= cc.lastReadId) return;
    try {
      const j = (await request(`/api/projects/${pid}/chat/read`, { method: "POST", body: JSON.stringify({ id: upTo }) })) as { lastReadId: number; unread: number };
      if (chat().projectId === pid) setChat({ lastReadId: j.lastReadId, unread: watching() ? 0 : j.unread });
    } catch { /* tried again with the next message */ }
  }, 400);
}
let wasOpen = false, hooked = false;
/** Hooks into the editor, made on the first load (not at import: chat.ts is imported while the editor's modules
 *  are still being set up, and the selection hooks do not exist yet). */
function hookOnce(): void {
  if (hooked) return; hooked = true;
  document.addEventListener("visibilitychange", () => maybeMarkRead());
  store.subscribe((s) => { const open = !!s.panes.chat; if (open && !wasOpen) setTimeout(maybeMarkRead, 0); wasOpen = open; });
  selectionHooks.push(() => { if (attach) refreshLink(); });
}

export function openChat(): void {
  const show = (E.hooks as Record<string, ((n: string, s?: unknown) => void) | undefined>).showPane;
  if (show) show("chat", true);
  setTimeout(() => { const ta = document.getElementById("chatText") as HTMLTextAreaElement | null; if (ta) ta.focus(); maybeMarkRead(); }, 30);
}

// ---------------------------------------------------------------- links
const IU = (): number => E.IU as number;
const docPath = (id: string): string => ((state.docs || []).find((d) => d.docId === id) || { path: "" }).path;

/** What the composer would link right now: the selected part (or its net), else the middle of the view. */
export function currentLink(): ChatLink | null {
  const did = state.docId; if (!did || did.startsWith("board:") || did.startsWith("lib:") || !E.kdoc) return null;
  const d = E.kdoc as KDoc;
  const ids = selectionIds();
  if (ids.length) {
    const it = d.items.get(ids[0]);
    if (it) {
      const b = it.bbox, x = b ? (b[0] + b[2]) / 2 : 0, y = b ? (b[1] + b[3]) / 2 : 0;
      // a wire, a track, a label: its net says more than "Wire"
      if (!it.ref && ids.length === 1) {
        const net = netOfItem(it, [x, y]);
        if (net && net.name && net.name !== "unnamed net") return { docId: did, path: docPath(did), kind: "net", id: net.name, label: net.name, x: Math.round(x * IU()), y: Math.round(y * IU()) };
      }
      const label = describe(it) + (ids.length > 1 ? ` +${ids.length - 1}` : "");
      return { docId: did, path: docPath(did), kind: "item", id: it.id, label, x: Math.round(x * IU()), y: Math.round(y * IU()) };
    }
  }
  const v = visibleRectNm(); if (!v) return null;
  return { docId: did, path: docPath(did), kind: "spot", id: "", label: "", x: Math.round(v[0] + v[2] / 2), y: Math.round(v[1] + v[3] / 2) };
}
function refreshLink(): void { const next = attach ? currentLink() : null; if (JSON.stringify(next) !== JSON.stringify(chat().link)) setChat({ link: next }); }

export function linkText(l: ChatLink): string {
  const where = l.kind === "net" ? `Net ${l.label || l.id}` : l.kind === "item" ? l.label || "Item" : "A spot";
  const file = (l.path || docPath(l.docId) || "").split("/").pop() || "";
  return file ? `${where} · ${file}` : where;
}

/** Bring a link into view: open its document if it is another, then select the part, light up the net, or centre the spot. */
export function gotoLink(l: ChatLink): void {
  if (l.docId !== state.docId) {
    if (!(state.docs || []).some((d) => d.docId === l.docId)) { toast("That document is no longer in the project"); return; }
    const app = window.CollabApp; if (app) app.dispatch({ type: "openDoc", docId: l.docId });
    // the document arrives over the network: wait for it (at most 20 s)
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (Date.now() - t0 > 20000) { clearInterval(wait); return; }
      if (state.docId === l.docId && E.kdoc && (E.kdoc as KDoc).items.size) { clearInterval(wait); setTimeout(() => gotoHere(l), 60); }
    }, 120);
    return;
  }
  gotoHere(l);
}
function gotoHere(l: ChatLink): void {
  const d = E.kdoc as KDoc | null; if (!d) return;
  let x = l.x / IU(), y = l.y / IU();
  if (l.kind === "item") {
    const it = d.items.get(l.id);
    if (!it) toast(`${l.label || "That item"} is no longer here; showing where it was`);
    else {
      if (it.bbox) { x = (it.bbox[0] + it.bbox[2]) / 2; y = (it.bbox[1] + it.bbox[3]) / 2; }
      clearAllSelection(false); selectItemId(it.id); selectionChanged();
    }
  } else if (l.kind === "net") {
    const ids = netIds({ kind: "net", id: l.id, label: l.label, item: null });
    if (ids.length) { E.highlightIds = new Set(ids); requestRender(); }
    else toast(`Net ${l.label || l.id} is not on this document`);
  }
  centerOn(x, y);
}

// ---------------------------------------------------------------- sending
async function send(body: string, link: ChatLink | null): Promise<boolean> {
  const c = chat(), pid = c.projectId, u = me(); if (!pid) return false;
  const text = body.trim(); if (!text) return false;
  if (!E.canComment || !u) { toast(u ? "You can view this project but not write in its chat" : "Sign in to chat"); return false; }
  // shown at once, greyed, until the server has it
  const temp: ChatMessage = { id: -(++pendingId), projectId: pid, authorId: u.id, authorLogin: u.login, authorName: u.name, authorAvatar: u.avatarUrl, body: text, link, createdAt: new Date().toISOString(), pending: true };
  setChat({ messages: [...c.messages, temp] });
  try {
    const made = (await request(`/api/projects/${pid}/chat`, { method: "POST", body: JSON.stringify({ body: text, link: link || undefined }) })) as ChatMessage;
    if (chat().projectId !== pid) return true;
    const list = chat().messages.filter((m) => m.id !== temp.id && m.id !== made.id);
    setChat({ messages: [...list, made].sort((a, b) => (a.id < 0 ? Infinity : a.id) - (b.id < 0 ? Infinity : b.id)), lastReadId: Math.max(chat().lastReadId, made.id) });
    return true;
  } catch (e) {
    setChat({ messages: chat().messages.filter((m) => m.id !== temp.id) });
    toast("The message was not sent: " + String((e as Error).message || e).replace(/^\d+ /, "").slice(0, 120));
    return false;
  }
}

export function chatAction(a: { cmd: string; body?: string; id?: number; link?: ChatLink; on?: boolean }): void {
  switch (a.cmd) {
    case "send": { const link = attach ? currentLink() : null; void send(a.body || "", link).then((ok) => { if (ok && attach) { attach = false; setChat({ link: null }); } }); return; }
    case "edit": void editMessage(a.id!, a.body || ""); return;
    case "delete": void deleteMessage(a.id!); return;
    case "goto": if (a.link) gotoLink(a.link); return;
    case "read": maybeMarkRead(); return;
    case "older": void loadOlder(); return;
    case "attach": attach = !!a.on; refreshLink(); if (attach && !chat().link) toast("Open a document to link a place in it"); return;
  }
}

async function editMessage(id: number, body: string): Promise<void> {
  const text = body.trim(); if (!text) return;
  try {
    const m = (await request(`/api/chat/${id}`, { method: "PATCH", body: JSON.stringify({ body: text }) })) as ChatMessage;
    setChat({ messages: chat().messages.map((x) => (x.id === id ? m : x)) });
  } catch { toast("The message could not be changed"); }
}
async function deleteMessage(id: number): Promise<void> {
  try {
    await request(`/api/chat/${id}`, { method: "DELETE" });
    setChat({ messages: chat().messages.filter((x) => x.id !== id) });
  } catch { toast("The message could not be deleted"); }
}

// ---------------------------------------------------------------- cursor chat
let bubble: HTMLDivElement | null = null;
let sayClear: ReturnType<typeof setTimeout> | 0 = 0;

function setSay(text: string | null): void {
  E.chatSay = text ? text.slice(0, 200) : null;
  E.lastPresence = 0;   // goes out now, not after the pointer's next move
  sendPresence(null);
}

/** Open the cursor-chat bubble at the pointer (Alt+M). */
export function startCursorChat(): boolean {
  if (state.view !== "editor" || !state.docId || !E.kdoc) return false;
  if (!E.canComment || !me()) { toast(me() ? "You can view this project but not write in its chat" : "Sign in to chat"); return true; }
  closeCursorChat(false);
  if (sayClear) { clearTimeout(sayClear); sayClear = 0; }
  const mm = (E.lastCursorMm || [0, 0]) as [number, number];
  const at = screenOf(mm);
  const box = document.createElement("div"); box.className = "cursor-chat"; box.id = "cursorChat";
  const input = document.createElement("input"); input.type = "text"; input.maxLength = 200; input.placeholder = "Say something"; input.setAttribute("aria-label", "Say something at your cursor");
  const hint = document.createElement("span"); hint.className = "hint"; hint.textContent = "Enter sends to Chat · Esc";
  box.appendChild(input); box.appendChild(hint);
  box.style.left = Math.round(at[0] + 14) + "px"; box.style.top = Math.round(at[1] + 16) + "px";
  stage.appendChild(box); bubble = box;
  input.addEventListener("input", () => setSay(input.value.trim() || null));
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") { ev.preventDefault(); closeCursorChat(true); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      const text = input.value.trim(); if (!text) { closeCursorChat(true); return; }
      const did = state.docId!;
      void send(text, { docId: did, path: docPath(did), kind: "spot", id: "", label: "", x: Math.round(mm[0] * IU()), y: Math.round(mm[1] * IU()) });
      closeCursorChat(false);
      // what was said stays beside the pointer for a few seconds, as in Figma
      sayClear = setTimeout(() => { sayClear = 0; setSay(null); }, 5000);
    }
  });
  input.addEventListener("blur", () => setTimeout(() => { if (bubble === box) closeCursorChat(true); }, 0));
  setTimeout(() => input.focus(), 0);
  return true;
}
function closeCursorChat(clearSay: boolean): void {
  if (bubble) { const b = bubble; bubble = null; b.remove(); }
  if (clearSay && E.chatSay) setSay(null);
}
function screenOf(mm: [number, number]): [number, number] {
  // invert worldMm: the stage pixel under a world point
  const sr = stage.getBoundingClientRect();
  const probe = (px: number, py: number) => worldMm({ clientX: sr.left + px, clientY: sr.top + py });
  const o = probe(0, 0), u = probe(100, 100);
  const sx = (u[0] - o[0]) / 100 || 1, sy = (u[1] - o[1]) / 100 || 1;
  const x = (mm[0] - o[0]) / sx, y = (mm[1] - o[1]) / sy;
  return [Math.max(4, Math.min(sr.width - 240, x)), Math.max(4, Math.min(sr.height - 40, y))];
}
/** Leaving the document ends whatever was being said. */
export function leaveCursorChat(): void { closeCursorChat(false); if (sayClear) { clearTimeout(sayClear); sayClear = 0; } E.chatSay = null; }
