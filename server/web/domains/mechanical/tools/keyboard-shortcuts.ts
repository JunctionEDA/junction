// Change which key starts which tool (ui/KeymapDialog.tsx).
import { defineTool } from "../core/tool";

export default defineTool({
  id: "keyboard-shortcuts", title: "Change keys", hint: "Give any tool or feature a key of your own, or take one away.", group: "view", order: 90, keep: 0,
  icon: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M10 10h1M14 10h1M18 10h0M6 14h1M10 14h5M18 14h0"/>',
  run: (studio) => studio.setUi({ keymap: true }),
});
