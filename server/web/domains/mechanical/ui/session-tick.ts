// session-tick.ts — redraw when the document's session did something the studio's state does not show: an edit
// sent or acknowledged, a step put on or taken off the undo history.  The session shows every message and every
// edit of its own to its taps (shared/itemdoc/sync.ts) before it handles them, so the redraw waits a moment.
import { useEffect, useState } from "react";
import type { PartStudio } from "./studio";

export function useSessionTick(studio: PartStudio): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true, queued = false;
    const tap = (msg: Record<string, unknown>) => {
      if (queued || (msg.type !== "local_op" && msg.type !== "ack" && msg.type !== "snapshot" && msg.type !== "ops" && msg.type !== "op" && msg.type !== "error" && msg.type !== "doc_info")) return;
      queued = true;
      setTimeout(() => { queued = false; if (alive) setN((x) => x + 1); }, 0);
    };
    studio.session.taps.add(tap);
    return () => { alive = false; studio.session.taps.delete(tap); };
  }, [studio]);
  return n;
}
