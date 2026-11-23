// dialogs/configure-paths.ts — DIALOG_CONFIGURE_PATHS (Preferences > Configure Paths... in every editor, and the
// 3D Models tab's Configure Paths... button): the "Environment Variables" grid (Name / Path) and Help, which shows
// what each predefined variable is.  The server's variables are the ones KiCad greys as defined outside the program
// (read-only here, they cannot be overridden); the user adds, edits and removes their own, which are kept in the
// user's settings (Pgm().GetLocalEnvVariables / kicad_common.json).
import { box, grid, gridButtons, h, messageBox, openDialog, type CellValue } from "../editor/pcbdialogs/ui";
import { serverEnvValues, userEnvVars } from "./lib-tables";
import { clonePrefs, savePrefs } from "./prefs";

/** ENV_VAR::LookUpEnvVarHelp (common/env_vars.cpp initialiseEnvVarHelp). */
export const ENV_VAR_HELP: Record<string, string> = {
  KICAD10_FOOTPRINT_DIR: "The base path of locally installed system footprint libraries (.pretty folders).",
  KICAD10_3DMODEL_DIR: "The base path of system footprint 3D shapes (.3Dshapes folders).",
  KICAD10_SYMBOL_DIR: "The base path of the locally installed symbol libraries.",
  KICAD10_TEMPLATE_DIR: "A directory containing project templates installed with KiCad.",
  KICAD_USER_TEMPLATE_DIR: "Optional. Can be defined if you want to create your own project templates folder.",
  KICAD_LTSPICE_LIB: "Optional. The LTspice library folder, which holds the sub and sym folders, used when importing LTspice schematics.",
  KICAD10_3RD_PARTY: "A directory containing 3rd party plugins, libraries and other downloadable content.",
  KIPRJMOD: "Internally defined by KiCad (cannot be edited) and is set to the absolute path of the currently loaded project file.  This environment variable can be used to define files and paths relative to the currently loaded project.  For instance, ${KIPRJMOD}/libs/footprints.pretty can be defined as a folder containing a project specific footprint library named footprints.pretty.",
};
/** ENV_VAR::GetPredefinedEnvVars, in KiCad's order. */
export const PREDEFINED_ENV_VARS = ["KIPRJMOD", "KICAD10_SYMBOL_DIR", "KICAD10_3DMODEL_DIR", "KICAD10_FOOTPRINT_DIR", "KICAD10_TEMPLATE_DIR", "KICAD_USER_TEMPLATE_DIR", "KICAD_PTEMPLATES", "KICAD_LTSPICE_LIB", "KICAD10_3RD_PARTY"];

/** The rows of the Environment Variables grid: the variables KiCad sets itself (Pgm().GetLocalEnvVariables), sorted. */
export function envVarRows(): { name: string; path: string }[] {
  const vals = serverEnvValues({});
  // KICAD_COLLAB_3DMODELS: the server's variable for vendor parts' 3D models, defined outside the program like the rest
  const names = ["KICAD10_3DMODEL_DIR", "KICAD10_3RD_PARTY", "KICAD10_FOOTPRINT_DIR", "KICAD10_SYMBOL_DIR", "KICAD10_TEMPLATE_DIR", "KICAD_COLLAB_3DMODELS", "KICAD_USER_TEMPLATE_DIR"];
  const other: Record<string, string> = { KICAD10_3RD_PARTY: "(Plugin and Content Manager packages of this server)", KICAD10_TEMPLATE_DIR: "(the project templates of this server)", KICAD_COLLAB_3DMODELS: "(3D models of vendor parts, fetched on use)", KICAD_USER_TEMPLATE_DIR: "" };
  return names.map((name) => ({ name, path: vals[name] !== undefined ? vals[name] : other[name] || "" }));
}

/** ENV_VAR_NAME_VALIDATOR: upper case letters, digits (not first) and underscores; lower case is raised. */
export function envVarNameText(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9_]/g, "").replace(/^[0-9]+/, "");
}
/** OnGridCellChanging's check of a committed cell: the error it reports, or null (the text is trimmed first). */
export function envVarCellError(col: "name" | "path", text: string): string | null {
  const t = text.trim();
  if (!t) return col === "name" ? "Environment variable name cannot be empty." : "Environment variable path cannot be empty.";
  if (col === "name" && t === "KIPRJMOD") return "The name KIPRJMOD is reserved, and cannot be used.";
  return null;
}
/**
 * TransferDataFromWindow over the user's rows: empty rows are skipped, a row missing its name or path is an error
 * (with its row and column); the rest become the variables, a later row of the same name replacing an earlier one.
 */
export function envVarsFromRows(rows: { name: string; path: string; external?: boolean }[]): { vars: { name: string; path: string }[] } | { error: string; row: number; col: "name" | "path" } {
  const map = new Map<string, string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]; if (r.external) continue;
    const name = r.name.trim(), path = r.path.trim();
    if (!name && !path) continue;
    if (!name) return { error: "Environment variable name cannot be empty.", row: i, col: "name" };
    if (!path) return { error: "Environment variable path cannot be empty.", row: i, col: "path" };
    map.set(name, path);
  }
  return { vars: Array.from(map, ([name, path]) => ({ name, path })) };
}

export function configurePaths(onOk?: () => void): void {
  const server = envVarRows();
  const taken = new Set(server.map((r) => r.name));
  // ENV_VAR_MAP is a std::map: every variable in name order
  const rows: Record<string, CellValue>[] = [...server.map((r) => ({ name: r.name, path: r.path, external: true })),
    ...userEnvVars().filter((v) => !taken.has(v.name)).map((v) => ({ name: v.name, path: v.path, external: false }))]
    .sort((x, y) => (String(x.name) < String(y.name) ? -1 : String(x.name) > String(y.name) ? 1 : 0));
  const ro = (row: Record<string, CellValue>): boolean => !!row.external;
  const shadow = new WeakMap<Record<string, CellValue>, { name: string; path: string }>();
  const snap = (): void => { for (const r of rows) shadow.set(r, { name: String(r.name), path: String(r.path) }); };
  const focusCell = (i: number, col: string): void => {
    g.select(i);
    const inp = g.el.querySelectorAll("tbody tr")[i]?.querySelector(`input[data-col="${col}"]`) as HTMLInputElement | null;
    if (inp) { inp.focus(); inp.select(); }
  };
  /** OnGridCellChanging: a committed cell is trimmed; an empty one or the reserved name is refused (the old text stays). */
  const cellChanged = (): void => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], was = shadow.get(r); if (!was) continue;
      for (const col of ["name", "path"] as const) {
        const now = String(r[col] ?? "");
        if (now === was[col]) continue;
        const err = envVarCellError(col, now);
        if (err) {
          r[col] = was[col]; g.refresh();
          if (err.startsWith("The name")) messageBox("Message", err);
          else messageBox("Error", err, [{ label: "OK", fn: () => focusCell(i, col) }]);
          return;
        }
        r[col] = col === "name" ? envVarNameText(now.trim()) : now.trim();
        if (r[col] !== now) g.refresh();
      }
    }
    snap();
  };
  const g = grid([{ label: "Name", key: "name", width: "220px", readOnly: ro }, { label: "Path", key: "path", readOnly: ro }], rows,
    { height: "220px", key: "envVars", multi: true, onChange: cellChanged });
  snap();
  // ENV_VAR_NAME_VALIDATOR on the Name editor, as the user types
  g.el.addEventListener("input", (ev) => {
    const inp = ev.target as HTMLInputElement;
    if (!(inp instanceof HTMLInputElement) || inp.dataset.col !== "name") return;
    const at = inp.selectionStart ?? inp.value.length, t = envVarNameText(inp.value);
    if (t !== inp.value) { const cut = inp.value.length - t.length; inp.value = t; inp.setSelectionRange(Math.max(0, at - cut), Math.max(0, at - cut)); }
  });
  // OnRemoveEnvVar: the predefined variables (IsEnvVarImmutable), and here the server's, cannot be removed
  const bar = gridButtons(g, () => ({ name: "", path: "", external: false }), { addTip: "Add Environment Variable", delTip: "Remove Environment Variable",
    canDelete: (r) => !r.external && !PREDEFINED_ENV_VARS.includes(String(r.name)), onChange: snap });
  // OnHelp: the text below the grid, shown and hidden by the Help button
  const help = h("div", { class: "pd-help", "data-k": "pathsHelp", style: "display:none;max-height:260px;overflow:auto;margin-top:8px;padding:8px;border:1px solid var(--line);background:var(--panel);font-size:var(--fs-sm)" },
    h("p", null, "Enter the name and value for each environment variable.  Grey entries are names that have been defined externally at the system or user level.  Environment variables defined at the system or user level take precedence over the ones defined in this table.  This means the values in this table are ignored."),
    h("p", null, h("b", null, "To ensure environment variable names are valid on all platforms, the name field will only accept upper case letters, digits, and the underscore characters.")),
    ...PREDEFINED_ENV_VARS.map((v) => h("p", null, h("b", null, v), ENV_VAR_HELP[v] ? ": " + ENV_VAR_HELP[v] : "")));
  openDialog({ title: "Configure Paths", width: 640, child: true,
    extra: [{ label: "Help", fn: () => { help.style.display = help.style.display === "none" ? "" : "none"; } }],
    build(body) { body.append(box("Environment Variables", g.el, bar), help); },
    ok() {
      const a = document.activeElement; if (a instanceof HTMLInputElement && g.el.contains(a)) a.blur();   // CommitPendingChanges
      const got = envVarsFromRows(rows.map((r) => ({ name: String(r.name ?? ""), path: String(r.path ?? ""), external: !!r.external })));
      if ("error" in got) { messageBox("Error", got.error, [{ label: "OK", fn: () => focusCell(got.row, got.col) }]); return false; }
      const p = clonePrefs(); p.envVars = got.vars; savePrefs(p);
      if (onOk) onOk(); return true;
    } });
}
