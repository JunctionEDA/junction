// dochost.ts — the shell's side of documents the electronics editor does not draw: part studios, assemblies and
// whatever later domains add.  The contract is web/platform/documents/host.ts; which bundle holds a kind's editor
// is in web/domains/registry.ts.
//
// Opening such a document leaves the KiCad document (its socket, canvas and panes), shows the "cad" view in
// place of the editor view and hands its element to the domain's editor.  The menu bar, the document tabs and
// the status bar stay where they are, so going from a board to a part studio and back is a tab switch.
import type { DocumentEditor, DocumentHostContext } from "../../../platform/documents/host";
import { documentEditorFor } from "../../../platform/documents/host";
import type { DocEntry } from "../../../shared/store";
import { documentKind, type DocumentKind } from "../../registry";
import { CAD_OFF_NOTE, cadEnabled, setCadEnabled } from "../../../shared/cad";
import { state, store } from "./appstore";
import { toast } from "./util";

interface Hosted { docId: string; editor: DocumentEditor | null }
let open: Hosted | null = null;
const loading = new Map<string, Promise<void>>();

/** True for a document that has a tab and an editor of its own (not the schematic or board editor). */
export function isHostedDoc(doc: { docType: string } | null | undefined): boolean {
  if (doc && isShellView(doc.docType)) return true;
  const kind = doc ? documentKind(doc.docType) : undefined;
  return !!kind && !!kind.bundle;
}

/**
 * A view of the shell's own that is opened like a document: the project's Home tab ("@home", drawn by
 * web/platform/projecthome) and a PCB's bill of materials ("@bom", web/domains/pcb/parts/bomview.ts).  Their
 * editors are registered by scripts the page already has, so there is no bundle to load.
 */
export function isShellView(docType: string): boolean { return docType.startsWith("@"); }

function loadBundle(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    const v = (window as unknown as { __kcAssetV?: string }).__kcAssetV;
    p = new Promise<void>((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = src + (v ? "?v=" + v : "");
      tag.onload = () => resolve();
      // the next open tries again
      tag.onerror = () => { tag.parentNode?.removeChild(tag); loading.delete(src); reject(new Error(`could not load ${src}`)); };
      document.head.appendChild(tag);
    });
    loading.set(src, p);
  }
  return p;
}

/** What a CAD document shows somebody who has Mechanical CAD turned off (web/shared/cad.ts). */
function cadOffNote(doc: DocEntry, kind: DocumentKind): HTMLElement {
  const box = document.createElement("div");
  box.dataset.cadOff = doc.docId;
  box.style.cssText = "max-width:460px;margin:72px auto;padding:0 16px;display:flex;flex-direction:column;align-items:center;gap:12px;text-align:center;color:var(--ink)";
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("width", "32"); icon.setAttribute("height", "32"); icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none"); icon.setAttribute("stroke", "currentColor"); icon.setAttribute("stroke-width", "1.5");
  icon.setAttribute("stroke-linecap", "round"); icon.setAttribute("stroke-linejoin", "round");
  icon.style.color = kind.tint ? `var(--${kind.tint})` : "var(--ink-2)";
  icon.innerHTML = kind.icon;
  const title = document.createElement("h2");
  title.style.cssText = "margin:0;font-size:var(--fs-lg);font-weight:600";
  title.textContent = `${(doc.path.split("/").pop() || doc.path).replace(/\.[^.]+$/, "")} is ${/^[aeiou]/i.test(kind.title) ? "an" : "a"} ${kind.title.toLowerCase()}`;
  const text = document.createElement("p");
  text.style.cssText = "margin:0;color:var(--ink-2)";
  text.textContent = `${CAD_OFF_NOTE} it. Part studios and assemblies are part of Mechanical CAD, which is off for you; the project keeps them as they are.`;
  const button = document.createElement("button");
  button.type = "button"; button.className = "btn primary"; button.dataset.cadTurnOn = "";
  button.textContent = "Turn on Mechanical CAD and open";
  button.addEventListener("click", () => { button.disabled = true; setCadEnabled(true); });
  const note = document.createElement("p");
  note.style.cssText = "margin:0;color:var(--ink-3);font-size:var(--fs-sm)";
  note.textContent = "It can be turned off again in the account menu or the Junction menu.";
  box.append(icon, title, text, button, note);
  return box;
}

/** Close the hosted editor, if one is open. */
export function closeHostedDoc(): void {
  const was = open; open = null;
  if (was && was.editor) { try { was.editor.close(); } catch (e) { console.warn(e); } }
  const el = document.getElementById("cadHost");
  if (el) el.replaceChildren();
}

/**
 * Open a hosted document in the "cad" view.  The caller (doc.ts openDoc) has already left the KiCad document
 * and set state.doc / state.docId; `showCad` switches the view.
 */
export async function openHostedDoc(doc: DocEntry, showCad: () => void, openDocId: (id: string) => void): Promise<void> {
  closeHostedDoc();
  const kind = documentKind(doc.docType);
  const what = kind ? kind.title.toLowerCase() : doc.docType === "@bom" ? "bill of materials" : "page";
  const mine: Hosted = { docId: doc.docId, editor: null };
  open = mine;
  showCad();
  store.slice("connection", { status: "connecting", text: "opening…", edits: 0 });
  const el = document.getElementById("cadHost");
  if (!el) return;
  el.replaceChildren();
  // A part studio or an assembly for somebody who has Mechanical CAD off: a note with the way to turn it on, and
  // nothing of CAD is loaded (no bundle, no worker, no kernel).  Turning it on opens the document (cad-setting.ts).
  if (kind && kind.cad && !cadEnabled(store.get())) {
    store.slice("connection", { status: "idle", text: "Mechanical CAD is off" });
    el.replaceChildren(cadOffNote(doc, kind));
    return;
  }
  try {
    if (kind && kind.bundle) await loadBundle(kind.bundle);
    // a view of the shell's own is drawn by a script of the page itself, which may still be starting when a
    // link opens straight on it (the Home tab is the chrome's, and this runs in the editor's script)
    for (let i = 0; i < 400 && isShellView(doc.docType) && !documentEditorFor(doc.docType) && open === mine; i++) await new Promise((r) => setTimeout(r, 25));
    if (open !== mine) return;   // another tab was opened meanwhile
    const factory = documentEditorFor(doc.docType);
    if (!factory) throw new Error(`${kind ? kind.bundle : "the page"} did not register an editor for ${doc.docType}`);
    const ctx: DocumentHostContext = {
      el, project: { projectId: state.project!.projectId, name: state.project!.name }, doc: { docId: doc.docId, path: doc.path, docType: doc.docType },
      docs: (state.project!.allDocs || state.project!.docs).map((d) => ({ docId: d.docId, path: d.path, docType: d.docType })),
      signedIn: !!state.me, userId: state.me ? state.me.id : null,
      setConnection: (s, text) => { if (open === mine) store.slice("connection", { status: s, text }); },
      toast: (text, ms) => toast(text, ms),
      openDoc: (id) => openDocId(id),
    };
    const editor = await factory.open(ctx);
    if (open !== mine) { editor.close(); return; }
    mine.editor = editor;
  } catch (e) {
    console.warn(e);
    if (open !== mine) return;
    store.slice("connection", { status: "error", text: "could not open" });
    const p = document.createElement("p");
    p.className = "empty"; p.style.margin = "48px auto";
    p.textContent = `This ${what} could not be opened. Reload the page to try again.`;
    el.replaceChildren(p);
  }
}
