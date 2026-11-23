// dialogs/bom-legacy-logic.ts — Tools > Generate Legacy Bill of Materials (DIALOG_BOM, eeschema/dialogs/dialog_bom.cpp)
// without the DOM: the generator list KiCad keeps in its settings (EESCHEMA_SETTINGS::DefaultBomPlugins, the
// BOM_PLUGIN_SETTINGS rows), BOM_GENERATOR_HANDLER (eeschema/bom_plugins.cpp: the script's @package header, the command
// line it gets, the output extension that header names), NETLIST_EXPORTER_BASE::MakeCommandLine's %P %B %I %O, the
// command line split the way wxExecute splits it, and the Python that runs one generator script in the interpreter
// (Pyodide) the way `python script.py args…` runs it: sys.argv, the working folder, stdout / stderr, the exit status.
// The scripts are KiCad's own (eeschema/python_scripts, packed into /static/pyodide/kicad-bom.json by
// scripts/build-python.mjs) and sit at STOCK_PLUGINS, the folder KiCad installs them in.

/** PATHS::GetStockPluginsPath() on Linux, where the runtime puts the scripts */
export const STOCK_PLUGINS = "/usr/share/kicad/plugins";
/** PATHS::GetUserPluginsPath(): where a generator added from this computer is kept */
export const USER_PLUGINS = "/home/kicad/.local/share/kicad/10.0/plugins";
/** The folder the intermediate netlist and the BOM are written in: the project's (%P) */
export const PROJECT_DIR = "/home/kicad/project";

/** EESCHEMA_SETTINGS::BOM_PLUGIN_SETTINGS */
export interface BomPluginSetting { name: string; path: string; command?: string }
/** eeschema_settings.cpp defaultBomPlugins */
export const DEFAULT_BOM_PLUGINS: BomPluginSetting[] = [
  { name: "bom_csv_grouped_extra", path: "bom_csv_grouped_extra.py" },
  { name: "bom_csv_grouped_by_value", path: "bom_csv_grouped_by_value.py" },
  { name: "bom_csv_grouped_by_value_with_fp", path: "bom_csv_grouped_by_value_with_fp.py" },
];

const baseName = (p: string): string => p.replace(/\\/g, "/").split("/").pop() || "";
const stem = (p: string): string => baseName(p).replace(/\.[^.]*$/, "");
const ext = (p: string): string => { const b = baseName(p), i = b.lastIndexOf("."); return i > 0 ? b.slice(i + 1) : ""; };

/** BOM_GENERATOR_HANDLER::readHeader: the text from after "@package" (leading control characters skipped) to aEndSection. */
export function readHeader(data: string, endSection: string): string {
  if (!endSection) return "";
  let start = data.indexOf("@package"); if (start < 0) return "";
  start += "@package".length;
  const end = data.indexOf(endSection, start); if (end < 0) return "";
  while (start < data.length && data.charCodeAt(start) < 32) start++;
  return data.slice(start, end);
}
/** BOM_GENERATOR_HANDLER::getOutputExtension: what follows "%O in the header's command line, up to the closing quote. */
export function outputExtension(header: string): string {
  let start = header.indexOf('"%O'); if (start < 0) return "";
  start += 3;
  const end = header.indexOf('"', start); if (end < 0) return "";
  return header.slice(start, end);
}

/** BOM_GENERATOR_HANDLER: a generator file found (FindFilePath) or not, its name, info and command line. */
export interface BomGenerator { name: string; storedPath: string; file: string; ok: boolean; info: string; cmd: string }
/**
 * BOM_GENERATOR_HANDLER( aFile ): `files` maps a full path to the script text there (the stock folder's and the user's
 * own).  A relative path is looked for in the user plugins folder, then the stock one (FindFilePath).
 */
export function generatorHandler(storedPath: string, files: Map<string, string>, python = "python"): BomGenerator {
  const find = (): string => {
    if (storedPath.startsWith("/") && files.has(storedPath)) return storedPath;
    for (const dir of [USER_PLUGINS, STOCK_PLUGINS]) { const f = `${dir}/${stem(storedPath)}${ext(storedPath) ? "." + ext(storedPath) : ""}`; if (files.has(f)) return f; }
    return storedPath;
  };
  const file = files.has(storedPath) ? storedPath : find();
  const g: BomGenerator = { name: "", storedPath, file, ok: false, info: "", cmd: "" };
  const data = files.get(file);
  if (data === undefined) { g.info = `Script file:\n${storedPath}\nnot found. Script not available.`; return g; }
  g.ok = true; g.name = stem(file);
  const e = ext(file).toLowerCase();
  if (e === "xsl") { g.info = readHeader(data, "-->"); g.cmd = `xsltproc -o "%O${outputExtension(g.info)}" "${file}" "%I"`; }
  else if (e === "py") { g.info = readHeader(data, '"""'); g.cmd = `${python || "python"} "${file}" "%I" "%O${outputExtension(g.info)}"`; }
  else g.cmd = file;
  return g;
}
/** BOM_GENERATOR_HANDLER::IsValidGenerator */
export const isValidGenerator = (file: string): boolean => ["xsl", "py", "pyw"].includes(ext(file).toLowerCase());

/** DIALOG_BOM::installGeneratorsList: the settings' rows as handlers, each with its stored name and command. */
export function installGenerators(settings: BomPluginSetting[], files: Map<string, string>): { gen: BomGenerator; label: string }[] {
  return settings.map((s) => {
    const gen = generatorHandler(s.path, files);
    gen.name = s.name;
    if (s.command) gen.cmd = s.command;
    // a missing file keeps its row, marked
    return { gen, label: files.has(gen.file) ? s.name : `${s.name} (file missing)` };
  });
}

/** NETLIST_EXPORTER_BASE::MakeCommandLine: %P the project folder, %B the output's base name, %I the intermediate netlist, %O the output (no extension). */
export function makeCommandLine(format: string, netlistFile: string, finalFile: string, projectPath: string): string {
  return format.split("%P").join(projectPath).split("%B").join(stem(finalFile)).split("%I").join(netlistFile).split("%O").join(finalFile);
}

/** wxCmdLineParser::ConvertStringToArgs( wxCMD_LINE_SPLIT_UNIX ), as wxExecute splits a command line. */
export function splitCommandLine(cmd: string): string[] {
  const out: string[] = []; let cur = "", has = false, q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < cmd.length && /["\\]/.test(cmd[i + 1])) cur += cmd[++i]; else cur += c; continue; }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** The program a command line names, when it is a Python interpreter (`python`, `python3`, a path to one). */
export const isPython = (prog: string): boolean => /^python(3(\.\d+)?)?w?(\.exe)?$/i.test(baseName(prog));
/** What runs a command line here: a Python script and its arguments, or why it cannot run in the browser. */
export function resolveCommand(argv: string[], files: Map<string, string>): { script: string; args: string[] } | { error: string } {
  if (!argv.length) return { error: "The command line is empty." };
  if (!isPython(argv[0])) return { error: `'${argv[0]}' cannot run in the browser: only Python generator scripts run here.` };
  const script = argv[1];
  if (!script) return { error: "No script given to the Python interpreter." };
  if (!files.has(script)) return { error: `python: can't open file '${script}': [Errno 2] No such file or directory` };
  return { script, args: argv.slice(2) };
}

/**
 * `python script args…` inside the interpreter: the script runs as __main__ with sys.argv set, its folder first on
 * sys.path, the project folder as the working folder; its output and errors are captured, SystemExit gives the exit
 * status and an uncaught exception prints its traceback and exits with 1.  The modules it imported from its folder are
 * forgotten afterwards, so the next run reads them afresh (a new process each time, as wxExecute starts one).
 */
export const RUNNER_PY = `
import sys, os, io, runpy, traceback
def _kc_bom_run(script, argv, cwd):
    out, err = io.StringIO(), io.StringIO()
    saved = (sys.argv, sys.stdout, sys.stderr, list(sys.path), os.getcwd(), set(sys.modules))
    sys.argv = [script] + list(argv)
    sys.stdout, sys.stderr = out, err
    sys.path.insert(0, os.path.dirname(script))
    code = 0
    try:
        os.chdir(cwd)
        runpy.run_path(script, run_name="__main__")
    except SystemExit as e:
        c = e.code
        if c is None:
            code = 0
        elif isinstance(c, int):
            code = c
        else:
            print(c, file=err)
            code = 1
    except BaseException:
        traceback.print_exc(file=err)
        code = 1
    finally:
        try:
            sys.stdout.flush()
        except Exception:
            pass
        sys.argv, sys.stdout, sys.stderr = saved[0], saved[1], saved[2]
        sys.path[:] = saved[3]
        os.chdir(saved[4])
        for name in list(sys.modules):
            if name not in saved[5]:
                mod = sys.modules.get(name)
                f = getattr(mod, "__file__", None) or ""
                if f.startswith(os.path.dirname(script) + "/"):
                    del sys.modules[name]
    return [code, out.getvalue(), err.getvalue()]
`;

/** WX_STRING_REPORTER's text of a run (SCH_EDIT_FRAME::WriteNetListFile): the command line, the result, the output then the errors. */
export function runReport(commandLine: string, code: number, stdout: string, stderr: string): { severity: "action" | "info" | "error"; text: string }[] {
  const lines: { severity: "action" | "info" | "error"; text: string }[] = [{ severity: "action", text: commandLine }];
  lines.push(code !== 0 ? { severity: "error", text: `Command error. Return code ${code}.` } : { severity: "info", text: "Done." });
  const split = (s: string): string[] => { const l = s.replace(/\r\n/g, "\n").split("\n"); if (l.length && l[l.length - 1] === "") l.pop(); return l; };
  for (const l of split(stdout)) lines.push({ severity: "info", text: l });
  for (const l of split(stderr)) lines.push({ severity: "error", text: l });
  return lines;
}
/** WX_STRING_REPORTER::GetMessages: each line on its own line (ReportHead / ReportTail / Report keep their order). */
export const reportText = (lines: { text: string }[]): string => lines.map((l) => l.text + "\n").join("");
