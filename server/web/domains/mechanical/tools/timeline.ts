// Timeline: the features as a strip along the bottom (ui/Timeline.tsx), on and off.
import { defineTool } from "../core/tool";
import { getPrefs } from "../ui/prefs";
import { setHistoryView } from "../ui/Timeline";

export default defineTool({
  id: "timeline", title: "Timeline", hint: "The features as a strip along the bottom, with a marker to drag for the rollback; beside the feature list or in its place.", group: "view", order: 40, keep: 0,
  icon: '<path d="M2 17h20"/><rect class="f" x="3.5" y="9" width="4" height="5" rx="0.8"/><rect x="3.5" y="9" width="4" height="5" rx="0.8"/><rect x="9" y="9" width="4" height="5" rx="0.8"/><rect class="d" x="17" y="9" width="4" height="5" rx="0.8"/><path d="M15 5v15"/>',
  active: () => getPrefs().timeline,
  run: (studio) => setHistoryView(studio, getPrefs().timeline ? "list" : "both"),
});
