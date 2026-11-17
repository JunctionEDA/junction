// DocTabs.tsx — the document tabs of an open project: its schematic, its boards, its part studios and its
// assemblies, side by side at the bottom of the window, with "+" to add one.
//
// Which documents get a tab, what "+" offers and which editor a tab opens all come from the domain registry
// (web/domains/registry.ts); nothing here names a domain.  A click asks the shell to open the document
// (dispatch openDoc); the menu bar, these tabs and the status bar stay as they are, so moving between a board
// and a part studio is a tab switch and nothing else.
//
//   click opens · double-click or the menu renames · the menu deletes (documents the tabs created; a project's
//   schematic and board stay put) · "+" adds a part studio or an assembly
//
// The tabs also start the project room (room.ts): a dot on a tab for each person who is on it, and the list is
// fetched again the moment somebody else adds, renames or deletes a document.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DOCUMENT_KINDS, type DocumentKind } from "../../domains/registry";
import { askConfirm } from "../../shared/components/msgbox";
import { dispatch, useApp, type DocEntry } from "../../shared/store";
import { cx } from "../../shared/util";
import { createDocument, deleteDocument, fetchDocs, renameDocument, renamedPath, stemOf, tabsOf, type Tab } from "./api";
import { ProjectRoom } from "./room";
import { noteText, tabOf, type RoomMember, type RoomState } from "./roomapi";

const NO_ROOM: RoomState = { live: false, me: null, members: [] };
const noRoom = () => () => {};

/** The people on a tab: a dot each (three at most, then a count), named in the tooltip. */
function TabPeople({ people }: { people: RoomMember[] }) {
  if (!people.length) return null;
  return (
    <span className="flex flex-none items-center -space-x-0.5" data-tab-people={people.map((m) => m.login).join(" ")} title={people.map((m) => m.name).join(", ") + (people.length === 1 ? " is here" : " are here")}>
      {people.slice(0, 3).map((m) => <i key={m.key} className="block w-2 h-2 rounded-full ring-1 ring-bench" style={{ background: m.color }} />)}
      {people.length > 3 ? <span className="pl-1 text-2xs text-ink-3 font-mono">+{people.length - 3}</span> : null}
    </span>
  );
}

function Glyph({ svg }: { svg: string }) {
  return <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" className="flex-none fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round]" strokeWidth={1.7} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function DocTabs() {
  const view = useApp((s) => s.view);
  const project = useApp((s) => s.project);
  const docId = useApp((s) => s.document.docId);
  const openType = useApp((s) => s.document.doc?.docType || null);
  const rootDocId = useApp((s) => s.document.rootDocId);
  const canEdit = useApp((s) => !!s.me && !s.viewOnly);
  const [menu, setMenu] = useState<{ x: number; y: number; tab: Tab | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [room, setRoom] = useState<ProjectRoom | null>(null);
  const signedIn = useApp((s) => !!s.me);
  const plus = useRef<HTMLButtonElement>(null);
  const projectId = project ? project.projectId : null;
  const docsRef = useRef<DocEntry[]>([]); docsRef.current = project ? project.docs : [];

  const refresh = useCallback(async (open?: string) => {
    if (!projectId) return;
    const docs = await fetchDocs(projectId);
    const same = !open && docs.length === docsRef.current.length && docs.every((d, i) => d.docId === docsRef.current[i].docId && d.path === docsRef.current[i].path);
    if (!same) dispatch({ type: "projectDocs", docs, open });
  }, [projectId]);

  // somebody else may have added or renamed a document: look again when the window comes back
  useEffect(() => {
    if (!projectId || view === "home") return;
    const again = () => { void refresh().catch(() => {}); };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [projectId, view, refresh]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [menu]);
  useEffect(() => { if (!error) return; const t = window.setTimeout(() => setError(null), 5000); return () => window.clearTimeout(t); }, [error]);
  useEffect(() => { if (!notice) return; const t = window.setTimeout(() => setNotice(null), 5000); return () => window.clearTimeout(t); }, [notice]);

  // the project room: one for as long as this project is open
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    if (!projectId || view === "home") return;
    const r = new ProjectRoom({
      signedIn,
      onDocsChanged: (by, note) => { if (by && note) setNotice(noteText(by.name, note)); void refreshRef.current().catch(() => {}); },
    });
    window.JunctionRoom = r; setRoom(r);
    return () => { r.close(); if (window.JunctionRoom === r) delete window.JunctionRoom; setRoom(null); };
  }, [projectId, view === "home", signedIn]);
  const docs = project ? project.docs : null;
  useEffect(() => { if (room && docs) room.setDocs(docs); }, [room, docs]);
  useEffect(() => { if (room) room.setTab(docId || null); }, [room, docId]);
  const people = useSyncExternalStore(room ? room.subscribe : noRoom, () => (room ? room.getState() : NO_ROOM));

  if (!project || view === "home") return <div id="doctabs" hidden />;
  const tabs = tabsOf(project.docs, rootDocId);
  const tabIds = tabs.map((t) => t.doc.docId);
  const active = (t: Tab) => t.doc.docId === docId || (t.doc.docType === "kicad_sch" && openType === "kicad_sch");
  const creatable = DOCUMENT_KINDS.filter((k) => k.newName && k.newText !== undefined);
  const run = async (what: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await what(); } catch (e) { setError((e as Error).message || "That did not work."); }
    setBusy(false);
  };
  const create = (kind: DocumentKind) => run(async () => {
    const id = await createDocument(project.projectId, kind, project.docs);
    const made = (await fetchDocs(project.projectId)).find((d) => d.docId === id);
    await refresh(id);
    room?.announce({ what: "added", name: made ? stemOf(made.path) : kind.title });
  });
  const rename = (tab: Tab, name: string) => {
    setRenaming(null);
    const to = renamedPath(tab.doc, name, project.docs);
    if ("error" in to) { setError(to.error); return; }
    if (to.path === tab.doc.path) return;
    void run(async () => { await renameDocument(tab.doc, to.path); await refresh(); room?.announce({ what: "renamed", name: `${tab.label} to ${stemOf(to.path)}` }); });
  };
  const remove = (tab: Tab) => run(async () => {
    if (!(await askConfirm(`Delete ${tab.label}?`, `“${tab.label}” and its history are deleted for everyone in this project. This cannot be undone.`, { ok: "Delete", danger: true }))) return;
    await deleteDocument(tab.doc);
    await refresh();
    room?.announce({ what: "deleted", name: tab.label });
  });
  const item = (label: string, onRun: () => void, o: { danger?: boolean; icon?: string } = {}) => (
    <button type="button" key={label} role="menuitem" className={cx("flex items-center gap-2 w-full text-left px-3 h-7 hover:bg-sel-soft", o.danger && "text-err")}
      onPointerDown={(ev) => ev.stopPropagation()} onClick={() => { setMenu(null); onRun(); }}>{o.icon ? <Glyph svg={o.icon} /> : null}{label}</button>
  );

  return (
    <div id="doctabs" className="flex items-stretch h-7 min-w-0 bg-bench border-t border-line text-sm select-none" role="tablist" aria-label="Documents" aria-busy={busy || undefined}>
      <div className="flex items-stretch min-w-0 overflow-x-auto">
        {tabs.map((t) => (
          <div key={t.doc.docId} role="tab" aria-selected={active(t)} tabIndex={0} data-doc-tab={t.doc.docId} data-doc-type={t.doc.docType} title={t.doc.path}
            className={cx("flex flex-none items-center gap-1.5 px-3 border-r border-line cursor-default max-w-56", active(t) ? "bg-paper text-ink shadow-[inset_0_2px_0_var(--color-blue)]" : "text-ink-2 hover:bg-paper")}
            onClick={() => { if (!active(t) || t.doc.docId !== docId) dispatch({ type: "openDoc", docId: t.doc.docId }); }}
            onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); dispatch({ type: "openDoc", docId: t.doc.docId }); } if (ev.key === "F2" && canEdit && t.kind.newName) setRenaming(t.doc.docId); }}
            onDoubleClick={() => { if (canEdit && t.kind.newName) setRenaming(t.doc.docId); }}
            onContextMenu={(ev) => { ev.preventDefault(); if (canEdit && t.kind.newName) setMenu({ x: ev.clientX, y: ev.clientY, tab: t }); }}>
            <Glyph svg={t.kind.icon} />
            {renaming === t.doc.docId
              ? <input autoFocus className="input h-5 w-36" defaultValue={t.label} aria-label="Document name" onClick={(ev) => ev.stopPropagation()}
                  onBlur={(ev) => rename(t, ev.target.value)}
                  onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") setRenaming(null); }} />
              : <span className="truncate">{t.label}</span>}
            <TabPeople people={people.members.filter((m) => tabOf(m, project.docs, tabIds, rootDocId) === t.doc.docId)} />
          </div>
        ))}
      </div>
      {canEdit && creatable.length ? (
        <button ref={plus} type="button" className="flex-none w-8 grid place-items-center text-ink-2 hover:bg-paper hover:text-ink border-r border-line" title="Add a document to this project" aria-label="Add a document" aria-haspopup="menu" data-doc-add
          onPointerDown={(ev) => ev.stopPropagation()}
          onClick={() => { const r = plus.current!.getBoundingClientRect(); setMenu(menu && !menu.tab ? null : { x: r.left, y: r.top, tab: null }); }}>
          <Glyph svg='<path d="M12 5v14"/><path d="M5 12h14"/>' />
        </button>
      ) : null}
      {error ? <span className="flex items-center px-3 text-err truncate" role="alert">{error}</span> : null}
      {notice && !error ? <span className="flex items-center px-3 text-ink-2 truncate" role="status" data-docs-notice>{notice}</span> : null}
      {menu ? (
        <div className="fixed z-[60] min-w-48 py-1 rounded-md border border-line bg-panel shadow-panel text-base text-ink" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 220), bottom: window.innerHeight - menu.y + 2 }}>
          {menu.tab
            ? [item("Rename", () => setRenaming(menu.tab!.doc.docId)), item("Delete…", () => void remove(menu.tab!), { danger: true })]
            : creatable.map((k) => item(`New ${k.title.toLowerCase()}`, () => void create(k), { icon: k.icon }))}
        </div>
      ) : null}
    </div>
  );
}
