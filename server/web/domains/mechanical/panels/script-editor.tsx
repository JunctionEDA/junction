// Custom features on the page: the editor (script/ui/EditorPanel.tsx) and the project's library
// (script/ui/LibraryDialog.tsx), drawn over the stage when they are open, and the mark on a feature's row that
// says how its copy of its script stands against the project's: a newer version there (click to take it), or the
// script gone from the project.  The tools that open these are tools/script-new.ts and tools/script-library.ts.
import { modifiedChange } from "../../../shared/itemdoc/itemdoc";
import { definePanel } from "../core/tool";
import { featuresOf } from "../document/format";
import { updatedFeature, versionOf } from "../script/library";
import { parseScriptType } from "../script/manifest";
import { library, libraryVersion, subscribeLibrary } from "../script/store";
import { EditorPanel } from "../script/ui/EditorPanel";
import { LibraryDialog } from "../script/ui/LibraryDialog";
import { editorOf } from "../script/ui/editor-state";
import { tipHandlers } from "../ui/Tip";
import { useStudio } from "../ui/hooks";
import { addFeatureRowSlot } from "../ui/slots";
import { studioExtensions, type PartStudio } from "../ui/studio";
import { useSyncExternalStore } from "react";

/** Bring a feature up to the project's version of its script: one undoable change. */
export function updateFeatureScript(studio: PartStudio, featureId: string): boolean {
  const doc = studio.doc, f = doc ? featuresOf(doc).find((x) => x.id === featureId) : undefined;
  const t = f ? parseScriptType(f.featureType) : null, s = t ? library().find((x) => x.id === t.id) : undefined;
  if (!f || !s) return false;
  const change = modifiedChange(f, updatedFeature(f, s));
  return change ? studio.commit([change]) : false;
}

addFeatureRowSlot(function ScriptVersion({ studio, featureId }) {
  const type = useStudio(studio, (s) => s.features.find((f) => f.id === featureId)?.featureType || "");
  const canEdit = useStudio(studio, (s) => s.canEdit);
  useSyncExternalStore(subscribeLibrary, libraryVersion);
  const state = versionOf(library(), type);
  if (!state || state === "current") return null;
  if (state === "missing") return <span className="pill" data-script-version="missing" {...tipHandlers({ title: "Its script is not in the project", hint: "The custom feature this was made from has been deleted from the project (or came from another one). The feature keeps its own copy and builds as before." })}>own copy</span>;
  return (
    <button type="button" className="pill info cursor-pointer" data-script-version="changed" disabled={!canEdit} aria-label="The script has changed: update this feature"
      {...tipHandlers({ title: "The script has changed", hint: "The project has a newer version of this custom feature. This feature still builds with the version it was made with. Click to update it (undo takes it back)." })}
      onClick={(ev) => { ev.stopPropagation(); if (updateFeatureScript(studio, featureId)) studio.host.toast("Updated to the project's version of the script.", 2500); }}>
      update
    </button>
  );
});

// the editor belongs to its studio: it goes when the studio does
studioExtensions.push((studio) => () => editorOf(studio).close());

export default definePanel({
  id: "script-editor",
  title: "Custom feature editor",
  side: "overlay",
  render: (studio) => <><EditorPanel studio={studio} /><LibraryDialog studio={studio} /></>,
});
