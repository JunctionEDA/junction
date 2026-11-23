// Hide or show the selected instances; show everything that is hidden.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "hide", title: "Hide", hint: "Hide the selected instances; with nothing selected, show everything that is hidden.", section: "more", order: 20, key: "h",
  keywords: "invisible show unhide visibility eye",
  icon: '<path d="M4 4l16 16"/><path d="M9.5 6.4A9.6 9.6 0 0 1 12 6c6.4 0 10 6 10 6a16 16 0 0 1-3.2 3.7"/><path d="M6.3 8.2A15.7 15.7 0 0 0 2 12s3.6 6 10 6c1.2 0 2.3-.2 3.3-.6"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.selectedInstances().length || a.getState().instances.some((i) => i.hidden) ? null : "Select an instance first"),
  run: (a) => { const s = a.selectedInstances(); if (s.length) a.setHidden(s.map((i) => i.id), !s.every((i) => !!i.hidden)); else a.setHidden(a.getState().instances.filter((i) => i.hidden).map((i) => i.id), false); },
});
