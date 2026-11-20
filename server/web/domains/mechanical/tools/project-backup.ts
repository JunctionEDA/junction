// Back up the project: every document of it (boards, schematics, part studios, assemblies, models) as one .zip
// on this computer, from the server's archive of the project.  A backup can be uploaded again as a new project.
import { defineTool } from "../core/tool";

export default defineTool({
  id: "project-backup", title: "Back up the project", hint: "Download every document of this project as one .zip file. It can be uploaded again as a new project.", group: "file", order: 41,
  icon: '<path d="M4 7h16v12H4z"/><path d="M4 7l2-3h12l2 3M12 10v6M9 13.5l3 3 3-3"/>',
  disabled: (studio) => (studio.getState().status.state === "live" ? (studio.session.unsaved ? "Wait until your last edits are sent" : null) : "Needs the connection. “Save a copy” works without it."),
  run(studio) {
    const a = document.createElement("a");
    a.href = `/api/projects/${encodeURIComponent(studio.host.project.projectId)}/archive`;
    a.download = ""; document.body.appendChild(a); a.click(); a.remove();
    studio.host.toast("Downloading the project…", 2500);
  },
});
