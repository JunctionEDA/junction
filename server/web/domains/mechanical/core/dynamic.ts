// dynamic.ts — feature types that are not files of features/: the page learns them while it runs.
//
// The features folder is the registry of what ships.  A project's custom features (script/) are feature types
// too, one per script and version (`script:<id>.<hash>`), each with a title, an icon and a schema, but they
// come from the project's documents.  Whoever knows such types pushes a provider here at module load;
// `featureDef` and `studio.definitions()` (ui/studio.ts) ask the providers after the registry.  A provider is
// asked often (every toolbar draw): it should answer from what it has, not work anything out.
import type { FeatureDefinition } from "./feature";

export interface DynamicFeatures {
  /** the definition of a type this provider knows, or undefined */
  get(type: string): FeatureDefinition | undefined;
  /** what to offer in the toolbar and the tool search now */
  list(): readonly FeatureDefinition[];
}

export const dynamicFeatures: DynamicFeatures[] = [];

export function dynamicDef(type: string): FeatureDefinition | undefined {
  for (const p of dynamicFeatures) { const d = p.get(type); if (d) return d; }
  return undefined;
}
export function dynamicDefs(): FeatureDefinition[] {
  const out: FeatureDefinition[] = [];
  for (const p of dynamicFeatures) out.push(...p.list());
  return out;
}
