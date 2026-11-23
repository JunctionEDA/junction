// LibraryDialog.tsx — the project's custom features in one list: use one on this part, open it in the editor,
// rename, duplicate, export as a file, delete; make a new one, import a file, or add one of the examples that
// ship.  Everything written here goes to the project's own document (script/library.ts), so everybody in the
// project sees it at once.
import { useRef, useState, useSyncExternalStore } from "react";
import { featuresOf } from "../../document/format";
import { EXEMPLARS } from "../../generated/script-assets";
import { Glyph } from "../../ui/Glyph";
import { useStudio } from "../../ui/hooks";
import type { PartStudio } from "../../ui/studio";
import { deleteScript, duplicateScript, exportName, freeName, importName, renameScript, saveScript, type LibraryScript } from "../library";
import { MAX_SOURCE, iconMarkup, parseScriptType, scriptType, type ScriptManifest } from "../manifest";
import { commitLibrary, library, libraryAvailable, libraryItems, libraryVersion, subscribeLibrary } from "../store";
import { editorOf } from "./editor-state";

export const LIBRARY_UI = "scriptLibrary";
const X = '<path d="M6 6l12 12M18 6 6 18"/>';

interface Described { manifest: ScriptManifest | null; problems: { message: string; line?: number }[] }
const exemplarTitle = (source: string): string => /title:\s*"([^"]+)"/.exec(source)?.[1] || "Example";

export function LibraryDialog({ studio }: { studio: PartStudio }) {
  const open = useStudio(studio, (s) => !!s.ui?.[LIBRARY_UI]);
  const canEdit = useStudio(studio, (s) => s.canEdit);
  useSyncExternalStore(subscribeLibrary, libraryVersion);
  const features = useStudio(studio, (s) => s.features);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [examples, setExamples] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  if (!open) return null;
  const scripts = library(), close = () => studio.setUi({ [LIBRARY_UI]: false });
  const toast = (t: string) => studio.host.toast(t, 3500);
  const uses = (s: LibraryScript) => features.filter((f) => parseScriptType(f.featureType)?.id === s.id).length;
  const usesHere = (id: string) => { const doc = studio.doc; return doc ? featuresOf(doc).filter((f) => parseScriptType(f.featureType)?.id === id).length : 0; };

  /** Check a source in the sandbox and put it in the library under a free name. */
  const add = async (source: string, name: string): Promise<string | null> => {
    if (source.length > MAX_SOURCE) { toast("That file is too large to be a custom feature."); return null; }
    let d: Described;
    try { d = await studio.kernel.call("script-describe", { source }) as unknown as Described; } catch (e) { toast(`The script could not be checked: ${e instanceof Error ? e.message : String(e)}`); return null; }
    if (!d.manifest) { toast(`Not added: ${d.problems[0]?.message || "the script does not declare a feature."}`); return null; }
    const items = libraryItems();
    const r = saveScript(items, { name: freeName(items, name || d.manifest.title), source, manifest: d.manifest });
    if (!commitLibrary(r.changes)) { toast("The project's library cannot be reached from this page."); return null; }
    return r.id;
  };
  const importFiles = async (list: FileList | null) => {
    for (const f of Array.from(list || [])) { const id = await add(await f.text(), importName(f.name)); if (id) toast(`Imported “${importName(f.name)}”.`); }
    if (file.current) file.current.value = "";
  };
  const exportOne = (s: LibraryScript) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([s.source], { type: "text/javascript" })); a.download = exportName(s.name); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };
  const insert = (s: LibraryScript) => { close(); studio.startFeature(scriptType(s.id, s.hash)); studio.viewport.canvas.focus(); };
  const edit = (s: LibraryScript) => { close(); editorOf(studio).openScript(s.id); };

  return (
    <div className="absolute inset-0 z-[6] grid place-items-center bg-black/20" data-script-library onPointerDown={(ev) => { ev.stopPropagation(); if (ev.target === ev.currentTarget) close(); }} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === "Escape") close(); }}>
      <section role="dialog" aria-label="Custom features of this project" className="w-[min(680px,94%)] max-h-[86%] flex flex-col rounded-sm border border-line bg-panel text-sm text-ink shadow-panel">
        <header className="flex items-center gap-2 h-9 px-3 border-b border-line flex-none">
          <span className="flex-1 font-semibold">Custom features of this project</span>
          <button type="button" className="btn sm ghost px-1" aria-label="Close" data-library-close onClick={close}><Glyph svg={X} size={16} /></button>
        </header>
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-line flex-none">
          <button type="button" className="btn sm primary" data-library-new disabled={!canEdit} onClick={() => { close(); editorOf(studio).openNew(); }}>New custom feature</button>
          <button type="button" className="btn sm" data-library-examples disabled={!canEdit} aria-expanded={examples} onClick={() => setExamples(!examples)}>Add an example</button>
          <button type="button" className="btn sm" data-library-import disabled={!canEdit} onClick={() => file.current?.click()}>Import…</button>
          <input ref={file} type="file" accept=".js,.txt,text/javascript" multiple hidden data-library-file onChange={(ev) => void importFiles(ev.target.files)} />
          {!libraryAvailable() ? <span className="text-xs text-err">The project's library cannot be reached from this page.</span> : null}
        </div>
        {examples ? (
          <ul className="m-0 p-0 list-none border-b border-line flex-none" data-library-example-list>
            {EXEMPLARS.map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-3 h-8 hover:bg-sel-soft">
                <span className="flex-1 truncate">{exemplarTitle(e.source)}</span>
                <span className="flex-[2] truncate text-xs text-ink-3">{/description:\s*"([^"]+)"/.exec(e.source)?.[1] || ""}</span>
                <button type="button" className="btn sm" data-example={e.id} onClick={() => void add(e.source, exemplarTitle(e.source)).then((id) => { if (id) { toast(`Added “${exemplarTitle(e.source)}” to this project.`); setExamples(false); } })}>Add</button>
              </li>
            ))}
          </ul>
        ) : null}
        <ul className="m-0 p-0 list-none overflow-y-auto min-h-[120px]" data-library-list>
          {!scripts.length ? <li className="px-3 py-6 text-center text-ink-3">No custom features yet. Write one, add an example, or import a file.</li> : null}
          {scripts.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-3 min-h-9 border-b border-line-soft hover:bg-sel-soft" data-script-row={s.id} data-script-name={s.name}>
              <Glyph svg={iconMarkup(s.manifest.icon)} size={18} />
              {renaming && renaming.id === s.id ? (
                <input className="input h-6 flex-1 min-w-0" autoFocus value={renaming.name} aria-label="Name" data-library-rename-input
                  onChange={(ev) => setRenaming({ id: s.id, name: ev.target.value })}
                  onBlur={() => { commitLibrary(renameScript(libraryItems(), s.id, renaming.name)); setRenaming(null); }}
                  onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") { ev.stopPropagation(); setRenaming(null); } }} />
              ) : (
                <span className="flex-1 min-w-0">
                  <span className="block truncate font-medium">{s.name}</span>
                  <span className="block truncate text-xs text-ink-3">{s.manifest.description || `${s.manifest.params.length} parameters`}{uses(s) ? ` · used ${uses(s)} ${uses(s) === 1 ? "time" : "times"} in this part studio` : ""}</span>
                </span>
              )}
              {confirming === s.id ? (
                <>
                  <span className="text-xs text-ink-2">{usesHere(s.id) ? "Features made from it keep their own copy. " : ""}Delete it from the project?</span>
                  <button type="button" className="btn sm danger" data-library-delete-yes onClick={() => { commitLibrary(deleteScript(libraryItems(), s.id)); setConfirming(null); }}>Delete</button>
                  <button type="button" className="btn sm" onClick={() => setConfirming(null)}>Keep</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn sm" data-library-use disabled={!canEdit} title="Add this feature to the part" onClick={() => insert(s)}>Use</button>
                  <button type="button" className="btn sm ghost" data-library-edit title="Open the script in the editor" onClick={() => edit(s)}>Edit</button>
                  <button type="button" className="btn sm ghost" data-library-rename disabled={!canEdit} onClick={() => setRenaming({ id: s.id, name: s.name })}>Rename</button>
                  <button type="button" className="btn sm ghost" data-library-duplicate disabled={!canEdit} onClick={() => { const r = duplicateScript(libraryItems(), s.id); if (r) commitLibrary(r.changes); }}>Duplicate</button>
                  <button type="button" className="btn sm ghost" data-library-export onClick={() => exportOne(s)}>Export</button>
                  <button type="button" className="btn sm ghost" data-library-delete disabled={!canEdit} onClick={() => setConfirming(s.id)}>Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
