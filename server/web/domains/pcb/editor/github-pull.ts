import { state } from "./appstore";
import { E } from "./state";
import { api, toast } from "./util";
import { GITHUB_PULL, setAttention } from "./attention";

export interface GithubPullResult {
  linked?: boolean;
  updated: { path: string; action: string }[];
  skipped: { path: string; reason: string }[];
}

export function pullGithubChanges(projectId: string): Promise<GithubPullResult> {
  return api(`/api/projects/${projectId}/github/pull`, { method: "POST", body: JSON.stringify({ automatic: true }) });
}

export function githubPullNotice(projectId: string, message: string): void {
  toast(message, 8000, { text: "GitHub sync", run: () => { location.href = `/p/${projectId}/github`; } });
}

/** Poll only the active editor, leaving unfinished gestures and unacknowledged edits alone. */
export function watchGithubChanges(projectId: string, update: (result: GithubPullResult) => Promise<void>): () => void {
  let stopped = false, busy = false, linked = true, lastNotice = "";
  const check = async (focused = false) => {
    if (stopped || busy || document.hidden || (!linked && !focused) || state.view !== "editor"
      || state.project?.projectId !== projectId || !state.me || E.viewOnly
      || E.pendingOps.size || E.drag || E.tool !== "select" || E.history
      || document.querySelector(".kd-overlay, [role='dialog']")) return;
    busy = true;
    try {
      const result = await pullGithubChanges(projectId);
      if (stopped || state.project?.projectId !== projectId) return;
      linked = result.linked !== false;
      if (result.updated.length) await update(result);
      // what could not come in on its own waits on the sync page: a red mark until it is dealt with
      setAttention(GITHUB_PULL, linked && result.skipped.length ? `GitHub has ${result.skipped.length} change${result.skipped.length === 1 ? "" : "s"} to pull that need${result.skipped.length === 1 ? "s" : ""} your review on the GitHub sync page.` : null);
      const notice = result.skipped.map((s) => `${s.path}: ${s.reason}`).join("\n");
      if (notice && notice !== lastNotice) githubPullNotice(projectId, "Some GitHub changes need review before they can be pulled.");
      lastNotice = notice;
    } catch {
      if (!stopped && lastNotice !== "error") githubPullNotice(projectId, "Couldn't check GitHub for changes. You can retry on the sync page.");
      lastNotice = "error";
    } finally { busy = false; }
  };
  const focus = () => { void check(true); };
  const timer = setInterval(() => { void check(); }, 60000);
  window.addEventListener("focus", focus);
  document.addEventListener("visibilitychange", focus);
  return () => {
    stopped = true; clearInterval(timer); setAttention(GITHUB_PULL, null);
    window.removeEventListener("focus", focus);
    document.removeEventListener("visibilitychange", focus);
  };
}
