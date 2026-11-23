// The sheet of every key the assembly answers to, and from it the dialog that changes them.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "keyboard-shortcuts", title: "Keyboard shortcuts", hint: "Every key the assembly answers to; change any of them.", section: "more", order: 90,
  keywords: "hotkeys keybindings rebind customise customize shortcuts keymap keys",
  icon: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M10 10h1M14 10h1M18 10h0M6 14h1M10 14h5M18 14h0"/>',
  run: (a) => a.setUi({ help: true }),
});
