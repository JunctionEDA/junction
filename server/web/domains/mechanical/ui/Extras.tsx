// Extras.tsx — what opens over the whole part studio and is not the tool search, the menu or the sheet of keys
// (Overlays.tsx): each is a window of its own, shown while its key of `getState().ui` is set.
import type { PartStudio } from "./studio";
import { KeymapDialog } from "./KeymapDialog";
import { MarkingMenu } from "./MarkingMenu";
import { ParametersTable } from "./ParametersTable";
import { ExportAll } from "../tools/export-all";

export function Extras({ studio }: { studio: PartStudio }) {
  return (
    <>
      <KeymapDialog studio={studio} />
      <MarkingMenu studio={studio} />
      <ParametersTable studio={studio} />
      <ExportAll studio={studio} />
    </>
  );
}
