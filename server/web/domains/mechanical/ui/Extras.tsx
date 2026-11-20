// Extras.tsx — what opens over the whole part studio and is not the tool search, the menu or the sheet of keys
// (Overlays.tsx): each is a window of its own, shown while its key of `getState().ui` is set.
import type { PartStudio } from "./studio";
import { KeymapDialog } from "./KeymapDialog";

export function Extras({ studio }: { studio: PartStudio }) {
  return (
    <>
      <KeymapDialog studio={studio} />
    </>
  );
}
