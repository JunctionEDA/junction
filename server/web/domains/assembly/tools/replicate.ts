// Replicate: a part mated in a hole is put in every hole like it, each copy with a copy of the mate.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "replicate", title: "Replicate", hint: "Put a copy of the selected instance, with its mate, in every hole like the one it is mated in.", section: "pattern", menu: "Pattern", order: 30, keep: 52,
  keywords: "copy bolts screws fasteners every hole same match fill",
  icon: '<circle class="t" cx="6" cy="17.5" r="3"/><circle class="t" cx="18" cy="17.5" r="3"/><circle class="t" cx="18" cy="6.5" r="3"/><circle class="f" cx="6" cy="6.5" r="3"/><circle cx="6" cy="6.5" r="3"/><path class="s" d="M4.2 4.7h3.6v3.6H4.2z"/><path class="t d" d="M9.5 6.5H15M6 10v4.5"/>',
  disabled: (a) => (!a.getState().canEdit ? "View-only access" : a.selectedInstances().length === 1 ? null : "Select one instance that is mated in a hole"),
  run: (a) => {
    const n = a.replicate(a.selectedInstances()[0].id);
    a.host.toast(n ? `${n} cop${n === 1 ? "y" : "ies"} placed, each with its mate.` : "Nothing to replicate: the instance needs a mate on a round edge or a hole of another part that has more holes of that size.", n ? 2500 : 6000);
  },
});
