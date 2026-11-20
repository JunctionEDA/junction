// Save a copy: the part studio as it is in this browser — every edit, sent or not — written to a .jpart file on
// this computer.  It needs no connection, so it is also what the offline banner offers.  The file is the stored
// format itself (document/format.ts): dropped onto a project's Home it becomes a part studio again.
import { defineTool } from "../core/tool";
import { serializeItemDoc } from "../../../shared/itemdoc/itemdoc";
import type { PartStudio } from "../ui/studio";

/** The file name: the document's own, with the day when it holds edits the server does not have. */
export function copyName(path: string, unsaved: number, now = new Date()): string {
  const base = (path.split("/").pop() || "part studio").replace(/\.jpart$/i, "");
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `${base}${unsaved ? ` (unsent ${day})` : ` (copy ${day})`}.jpart`;
}

export function saveCopy(studio: PartStudio): boolean {
  const doc = studio.session.doc;
  if (!doc) { studio.host.toast("The part studio has not arrived yet.", 2500); return false; }
  const name = copyName(studio.host.doc.path, studio.session.unsaved);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([serializeItemDoc(doc)], { type: "application/json" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  studio.host.toast(`Saved ${name}`, 2500);
  return true;
}

export default defineTool({
  id: "save-copy", title: "Save a copy", hint: "Write this part studio, as it is here, to a file on this computer. Works without a connection.", group: "file", order: 40,
  icon: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  run: (studio) => { saveCopy(studio); },
});
