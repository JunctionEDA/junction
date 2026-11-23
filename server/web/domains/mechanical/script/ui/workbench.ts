// workbench.ts — what the assistant's tools reach in the editor: the part studio that is open, through its
// modelling worker.  A candidate script is tried as a feature at the place the editor's preview stands (or at
// the rollback bar), on an engine of the worker's own (services/script-run.ts), so trying changes nothing the
// person sees until they accept a proposal.
import type { Json, JsonObject } from "../../../../shared/itemdoc/itemdoc";
import type { FeatureItem } from "../../document/format";
import { studioInputs } from "../../document/inputs";
import type { PartStudio } from "../../ui/studio";
import type { ScriptWorkbench } from "../assistant/loop";
import { SCRIPT_KEY, defaultsOf, isPick, scriptType, type ScriptManifest } from "../manifest";
import type { PartSummary, RunReport } from "../report-text";
import type { ScriptEditor } from "./editor-state";

interface Described { manifest: ScriptManifest | null; problems: { message: string; line?: number }[]; hash: string }

export function workbenchOf(studio: PartStudio, editor: ScriptEditor): ScriptWorkbench {
  const describe = (source: string) => studio.kernel.call("script-describe", { source }) as unknown as Promise<Described>;
  /** the features before the one being written, and the draft the person has open for it (their picks are worth trying with) */
  const place = () => {
    const st = studio.getState(), previewId = editor.getState().previewId;
    const at = previewId ? st.features.findIndex((f) => f.id === previewId) : -1;
    const before = st.features.slice(0, at >= 0 ? at : st.rollback);
    const draft = st.editing && st.editing.draft.id === previewId ? st.editing.draft : at >= 0 ? st.features[at] : null;
    return { before, draft };
  };
  return {
    async describe(source) {
      const d = await describe(source);
      return { ok: !!d.manifest, problems: d.problems, params: d.manifest ? d.manifest.params.map((p) => ({ key: p.key, type: p.type })) : undefined };
    },
    async run(source, params, view): Promise<RunReport> {
      const doc = studio.doc;
      if (!doc) throw new Error("The part studio is not loaded yet.");
      const d = await describe(source);
      if (!d.manifest) throw new Error(d.problems[0]?.message || "The script does not read.");
      const { before, draft } = place();
      const values: JsonObject = defaultsOf(d.manifest);
      for (const p of d.manifest.params) {
        // what the person picked in the dialog stands; the model sets the numbers, switches and choices
        if (isPick(p.type)) { if (draft && draft.params[p.key] !== undefined) values[p.key] = draft.params[p.key]; }
        else if (params[p.key] !== undefined) values[p.key] = params[p.key] as Json;
      }
      const id = `cf-try-${editor.getState().id}`;
      const candidate: FeatureItem = { id, type: "feature", featureType: scriptType(editor.getState().id, d.hash), name: d.manifest.title, order: "", params: { [SCRIPT_KEY]: { id: editor.getState().id, name: d.manifest.title, hash: d.hash, source }, ...values } };
      const features = [...before, candidate];
      const inputs = studioInputs(doc, { features, rollback: features.length, filters: studio.inputFilters }).features;
      return studio.kernel.call("script-run", { features: inputs as unknown as Json, feature: id, image: { view, width: 800 } }) as unknown as Promise<RunReport>;
    },
    async part(): Promise<PartSummary> {
      const previewId = editor.getState().previewId;
      return studio.kernel.call("script-part-summary", previewId ? { before: previewId } : {}) as unknown as Promise<PartSummary>;
    },
  };
}
