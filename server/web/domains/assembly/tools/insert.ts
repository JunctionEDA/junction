// Insert parts of the project's part studios, its other assemblies, its boards and parts from suppliers, as instances.
import { defineAssemblyTool } from "../core/tool";

export default defineAssemblyTool({
  id: "insert", title: "Insert", hint: "Place parts, sub-assemblies and boards of this project, or a part from a supplier.", section: "insert", order: 10, keep: 100, label: true, key: "i",
  keywords: "add place part sub-assembly component instance import supplier standard bolt screw nut bearing mcmaster",
  icon: '<path class="f" d="M10.5 3l7 3.5v7l-7 3.5-7-3.5v-7z"/><path d="M10.5 3l7 3.5v7l-7 3.5-7-3.5v-7z"/><path class="t" d="M3.5 6.5l7 3.5 7-3.5M10.5 10v7"/><path d="M19 16v6M16 19h6"/>',
  disabled: (a) => (a.getState().canEdit ? null : "View-only access"),
  active: (a) => !!a.getState().inserting && !a.getState().inserting!.replace,
  run: (a) => { if (a.getState().inserting) a.closeInsert(); else a.openInsert(); },
});
