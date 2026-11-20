// The Features panel: the history tree (ui/FeatureList.tsx).  A panel is one file here; see core/tool.ts.
import { definePanel } from "../core/tool";
import { FeatureList } from "../ui/FeatureList";
import { getPrefs } from "../ui/prefs";

export default definePanel({ id: "features", title: "Features", side: "left", order: 10,
  // the timeline along the bottom may stand in for the list (ui/Timeline.tsx: List, Both, Timeline)
  visible: () => getPrefs().featureList || !getPrefs().timeline, count: (studio) => studio.getState().features.length || null, render: (studio) => <FeatureList studio={studio} /> });
