// The offline banner, over the top of the viewport: while the connection is down it says so, how many edits
// wait, and that work can go on; when it is back, that they were sent (ui/offline.ts has the words).  "Try now"
// does not wait for the session's next attempt; "Save a copy" writes the part studio as it is here to a file
// (tools/save-copy.ts), for anyone who would rather have it in hand.
import { useEffect, useRef, useState } from "react";
import { definePanel } from "../core/tool";
import { cx } from "../../../shared/util";
import { saveCopy } from "../tools/save-copy";
import { useStudio } from "../ui/hooks";
import { offlineNotice } from "../ui/offline";
import { useSessionTick } from "../ui/session-tick";
import type { PartStudio } from "../ui/studio";

function Offline({ studio }: { studio: PartStudio }) {
  const status = useStudio(studio, (s) => s.status);
  const loaded = useStudio(studio, (s) => s.loaded);
  const canEdit = useStudio(studio, (s) => s.status.canEdit);
  useSessionTick(studio);
  const unsaved = studio.session.unsaved;
  /** how many edits were waiting when the connection was last down (null: it has not been) */
  const waiting = useRef<number | null>(null);
  const [cameBack, setCameBack] = useState<number | null>(null);
  const [restored, setRestored] = useState(0);
  const down = loaded && status.state !== "live" && status.state !== "error";
  if (down) waiting.current = Math.max(waiting.current ?? 0, unsaved);
  // the connection is back and everything has been sent: say so for a few seconds
  useEffect(() => {
    if (status.state !== "live" || unsaved) return;
    if (waiting.current !== null) { const n = waiting.current; waiting.current = null; if (n > 0) setCameBack(n); }
    else if (studio.session.restored > 0) { setRestored(studio.session.restored); studio.session.restored = 0; }
  }, [status.state, unsaved, studio]);
  useEffect(() => { if (cameBack === null && !restored) return; const t = setTimeout(() => { setCameBack(null); setRestored(0); }, 7000); return () => clearTimeout(t); }, [cameBack, restored]);
  // the browser knows the network is back before the session's next try
  useEffect(() => { const on = () => studio.session.reconnectNow(); window.addEventListener("online", on); return () => window.removeEventListener("online", on); }, [studio]);
  const notice = offlineNotice({ state: status.state, loaded, unsaved, cameBack, restored, canEdit });
  if (!notice) return null;
  const offline = notice.kind === "offline";
  return (
    <div className={cx("cad-offline absolute left-1/2 top-2 -translate-x-1/2 z-[30] flex items-center gap-2.5 max-w-[min(46rem,calc(100%-24rem))] pl-3 pr-1.5 py-1.5 rounded-md border shadow-panel text-sm", offline ? "border-[var(--warn,#b7791f)] bg-panel text-ink" : "border-line bg-panel text-ink")} role="status" data-offline={notice.kind} data-unsaved={unsaved}>
      <span className={cx("flex-none w-2 h-2 rounded-full", offline ? "bg-[var(--warn,#b7791f)]" : "bg-teal")} aria-hidden="true" />
      <span className="min-w-0"><span className="font-semibold whitespace-nowrap">{notice.text}.</span> <span className="text-ink-2">{notice.detail}</span></span>
      {offline ? <button type="button" className="btn sm flex-none" data-offline-retry title={status.text} onClick={() => studio.session.reconnectNow()}>Try now</button> : null}
      {offline ? <button type="button" className="btn sm flex-none" data-offline-save title="Write this part studio as it is here, unsent edits and all, to a file on this computer" onClick={() => saveCopy(studio)}>Save a copy</button> : null}
      {!offline ? <button type="button" className="btn sm ghost flex-none" aria-label="Close" onClick={() => { setCameBack(null); setRestored(0); }}>×</button> : null}
    </div>
  );
}

export default definePanel({ id: "offline", title: "Connection", side: "overlay", order: 5, render: (studio) => <Offline studio={studio} /> });
