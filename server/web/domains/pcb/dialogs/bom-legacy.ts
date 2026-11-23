// dialogs/bom-legacy.ts — Tools > Generate Legacy Bill of Materials... (DIALOG_BOM, eeschema/dialogs/dialog_bom.cpp):
// "BOM generator scripts:" with the generator's nickname and its @package help on the right, + / edit / delete under
// the list, "Command line running the generator:", Reset to Defaults, Help, Generate / Close.  Generate is
// DIALOG_BOM::OnRunGenerator: ReadyToNetlist, the intermediate XML netlist (sim/netlist-kicad.ts xmlNetlist, GNL_ALL |
// GNL_OPT_BOM, "<schematic>.xml"), then the command line with %P %B %I %O filled in, run here: KiCad's own generator
// scripts (eeschema/python_scripts, /static/pyodide/kicad-bom.json) in CPython compiled to WebAssembly (Pyodide), in a
// worker of its own.  What the script writes beside the netlist comes down as a file; the reporter's text (the command,
// "Done." or "Command error. Return code n.", the script's output and errors) fills the message box.  A command line
// that runs anything but a Python script (xsltproc, a program of the computer) cannot run in a browser and says so.
// The generator list, the selected one and the user's own scripts (+ reads one from this computer) are kept per
// browser, as KiCad keeps them in eeschema.json.
import { box, h, messageBox, openDialog, textEntryBox, textField, iconButton, grid, type GridApi } from "../editor/pcbdialogs/ui";
import { markdownToHtml } from "../editor/markdown";
import { xmlNetlist } from "../sim/netlist-kicad";
// the editor modules the generator run needs are loaded when it runs: imported here, they would start the editor's
// module cycle from this dialog (dialogs/index.ts is reached early in the editor bundle) and break its load order
const editorMods = async () => {
  const [{ download }, { projectNlInput, readyToNetlist }, { currentVariant }] = await Promise.all([import("../editor/download"), import("../editor/export-netlist"), import("../editor/variant")]);
  return { download, projectNlInput, readyToNetlist, currentVariant };
};
import * as B from "./bom-legacy-logic";

const PREFS = "kicad.bom-legacy";
interface Prefs { plugins: B.BomPluginSetting[]; selected: string; user: Record<string, string> }
function loadPrefs(): Prefs {
  const def: Prefs = { plugins: B.DEFAULT_BOM_PLUGINS.map((p) => ({ ...p })), selected: "", user: {} };
  try { const v = JSON.parse(localStorage.getItem(PREFS) || "null") as Partial<Prefs> | null; if (v && Array.isArray(v.plugins)) return { plugins: v.plugins, selected: String(v.selected || ""), user: v.user || {} }; } catch { /* the defaults */ }
  return def;
}
function savePrefs(p: Prefs): void { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* this session only */ } }

const RUNTIME = "/static/pyodide/";
let stock: Promise<Map<string, string>> | null = null;
/** The stock plugins folder: KiCad's generator scripts by their full path. */
function stockScripts(): Promise<Map<string, string>> {
  if (!stock) stock = fetch(RUNTIME + "kicad-bom.json").then((r) => (r.ok ? r.json() : { files: {} })).then((j: { files?: Record<string, string> }) => new Map(Object.entries(j.files || {}).map(([n, t]) => [`${B.STOCK_PLUGINS}/${n}`, t] as [string, string])))
    .catch(() => { stock = null; return new Map<string, string>(); });
  return stock;
}

// ---------------------------------------------------------------- the interpreter, in a worker
const WORKER = `
let py = null, ready = null;
self.onmessage = async (e) => {
  const { id, base, stockDir, runner, user, cwd, xmlPath, xml, script, args } = e.data;
  try {
    if (!ready) ready = (async () => {
      importScripts(base + "pyodide.js");
      py = await loadPyodide({ indexURL: base });
      const pack = await (await fetch(base + "kicad-bom.json")).json();
      py.FS.mkdirTree(stockDir);
      for (const [n, t] of Object.entries(pack.files || {})) py.FS.writeFile(stockDir + "/" + n, t);
      py.runPython(runner);
    })();
    await ready;
    for (const [p, t] of Object.entries(user || {})) { py.FS.mkdirTree(p.slice(0, p.lastIndexOf("/"))); py.FS.writeFile(p, t); }
    const wipe = (d) => { for (const n of py.FS.readdir(d)) { if (n === "." || n === "..") continue; const f = d + "/" + n; if (py.FS.isDir(py.FS.stat(f).mode)) { wipe(f); py.FS.rmdir(f); } else py.FS.unlink(f); } };
    py.FS.mkdirTree(cwd); wipe(cwd);
    py.FS.writeFile(xmlPath, xml);
    const run = py.globals.get("_kc_bom_run");
    const r = run(script, py.toPy(args), cwd); const res = r.toJs(); r.destroy(); run.destroy();
    const files = [];
    const walk = (d) => { for (const n of py.FS.readdir(d)) { if (n === "." || n === "..") continue; const f = d + "/" + n; if (py.FS.isDir(py.FS.stat(f).mode)) walk(f); else if (f !== xmlPath) files.push({ name: f, data: py.FS.readFile(f) }); } };
    walk(cwd);
    self.postMessage({ id, code: res[0], stdout: res[1], stderr: res[2], files });
  } catch (err) { ready = ready && py ? ready : null; self.postMessage({ id, error: String(err && err.message || err) }); }
};`;
let worker: Worker | null = null, seq = 0;
const waiting = new Map<number, (r: { code?: number; stdout?: string; stderr?: string; files?: { name: string; data: Uint8Array }[]; error?: string }) => void>();
function runPython(msg: { user: Record<string, string>; cwd: string; xmlPath: string; xml: string; script: string; args: string[] }): Promise<{ code?: number; stdout?: string; stderr?: string; files?: { name: string; data: Uint8Array }[]; error?: string }> {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
    worker.onmessage = (e: MessageEvent) => { const d = e.data as { id: number }; const f = waiting.get(d.id); if (f) { waiting.delete(d.id); f(e.data); } };
    worker.onerror = (e) => { for (const f of waiting.values()) f({ error: e.message || "the Python runtime stopped" }); waiting.clear(); worker = null; };
  }
  const id = ++seq;
  return new Promise((done) => { waiting.set(id, done); worker!.postMessage({ id, base: new URL(RUNTIME, location.href).href, stockDir: B.STOCK_PLUGINS, runner: B.RUNNER_PY, ...msg }); });
}

function pickScript(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", style: "display:none" }) as HTMLInputElement;
    let settled = false;
    const done = (v: { name: string; text: string } | null): void => { if (settled) return; settled = true; input.remove(); resolve(v); };
    input.addEventListener("change", () => { const f = input.files && input.files[0]; if (!f) { done(null); return; } f.text().then((text) => done({ name: f.name, text }), () => done(null)); });
    input.addEventListener("cancel", () => done(null));
    document.body.append(input); input.click();
  });
}

export async function openBomLegacy(): Promise<void> {
  const prefs = loadPrefs();
  const stockFiles = await stockScripts();
  const files = (): Map<string, string> => { const m = new Map(stockFiles); for (const [p, t] of Object.entries(prefs.user)) m.set(p, t); return m; };
  let gens: { gen: B.BomGenerator; label: string }[] = [];
  const name = textField("", { key: "generator-name" });
  const command = textField("", { key: "command" });
  const messages = h("textarea", { class: "pd-text", readOnly: true, "data-k": "messages", style: "width:100%;flex:1;min-height:180px;font-family:var(--mono, monospace);font-size:12px;resize:none" }) as HTMLTextAreaElement;
  let list: GridApi | null = null;
  let generate: HTMLButtonElement | null = null;
  const selected = (): B.BomGenerator | null => { const i = list ? list.selected() : -1; return i >= 0 && i < gens.length ? gens[i].gen : null; };
  const store = (): void => {
    // ~DIALOG_BOM: the rows, each with its name, stored path and command, and the selection
    prefs.plugins = gens.map(({ gen }) => ({ name: gen.name || gen.storedPath.replace(/^.*\//, "").replace(/\.[^.]*$/, ""), path: gen.storedPath, command: gen.cmd }));
    const i = list ? list.selected() : -1; prefs.selected = i >= 0 && gens[i] ? gens[i].label : "";
    savePrefs(prefs);
  };
  /** DIALOG_BOM::pluginInit */
  const pluginInit = (): void => {
    const g = selected();
    if (!g) { name.set(""); command.set(""); messages.value = ""; return; }
    if (!files().has(g.file)) {
      name.set(""); command.set("");
      let msg = `The selected BOM generator script ${g.file} could not be found.`;
      if (!g.file.startsWith("/")) msg += `\n\nSearched:\n\t${B.USER_PLUGINS}\n\t${B.STOCK_PLUGINS}`;
      messages.value = msg; return;
    }
    name.set(g.name); command.set(g.cmd); messages.value = g.info;
    if (generate) generate.disabled = !g.ok;
  };
  /** DIALOG_BOM::installGeneratorsList */
  const install = (): void => {
    gens = B.installGenerators(prefs.plugins, files());
    if (list) { list.setRows(gens.map((g) => ({ name: g.label }))); const i = gens.findIndex((g) => g.label === prefs.selected && files().has(g.gen.file)); if (i >= 0) list.select(i); }
    pluginInit();
  };

  /** DIALOG_BOM::OnRunGenerator */
  const runGenerator = async (): Promise<void> => {
    const g = selected(); if (!g) return;
    const cmdFormat = command.get();
    const { download, projectNlInput, readyToNetlist, currentVariant } = await editorMods();
    if (!(await readyToNetlist("Generating BOM requires a fully annotated schematic."))) { messageBox("Error", "Failed to create file."); return; }
    const inp = await projectNlInput();
    if ("error" in inp) { messages.value = inp.error + "\n"; messageBox("Error", "Failed to create file."); return; }
    inp.currentVariant = currentVariant() || "";
    // fn = the schematic's file name without its extension, in the project folder; the netlist is fn + ".xml"
    const stemName = (inp.source.replace(/\\/g, "/").split("/").pop() || "schematic").replace(/\.kicad_sch$/i, "");
    const out = `${B.PROJECT_DIR}/${stemName}`, xmlPath = `${out}.xml`;
    let xml: string;
    try { xml = xmlNetlist(inp); } catch (e) { console.warn(e); messageBox("Error", "Failed to create file."); return; }
    if (!cmdFormat.trim()) { messages.value = ""; return; }   // no command: the netlist alone (WriteNetListFile)
    const commandLine = B.makeCommandLine(cmdFormat, xmlPath, out, B.PROJECT_DIR);
    const how = B.resolveCommand(B.splitCommandLine(commandLine), files());
    if ("error" in how) {
      messages.value = B.reportText([...B.runReport(commandLine, -1, "", how.error)]);
      messageBox("Error", "Failed to create file."); return;
    }
    messages.value = `${commandLine}\nStarting Python…\n`;
    if (generate) generate.disabled = true;
    const user: Record<string, string> = {}; for (const [p, t] of Object.entries(prefs.user)) user[p] = t;
    const res = await runPython({ user, cwd: B.PROJECT_DIR, xmlPath, xml, script: how.script, args: how.args });
    if (generate) generate.disabled = false;
    if (res.error) { messages.value = B.reportText(B.runReport(commandLine, -1, "", `The Python runtime could not run the generator: ${res.error}`)); messageBox("Error", "Failed to create file."); return; }
    const code = res.code || 0;
    messages.value = B.reportText(B.runReport(commandLine, code, res.stdout || "", res.stderr || ""));
    for (const f of res.files || []) download(new Blob([f.data as BlobPart]), f.name.split("/").pop() || "bom");
    if (code !== 0) messageBox("Error", "Failed to create file.");
  };

  openDialog({ title: "Bill of Materials", width: 760, okLabel: "Generate", cancelLabel: "Close", noEnter: true,
    extra: [{ label: "Reset to Defaults", fn: () => { prefs.selected = ""; prefs.plugins = B.DEFAULT_BOM_PLUGINS.map((p) => ({ ...p })); install(); store(); } },
      { label: "Help", fn: () => {
        openDialog({ title: "Bill of Materials Generation Help", width: 720, noOk: true, cancelLabel: "Close", child: true, modeless: true,
          build(body) { const d = h("div", { class: "kd-help", "data-k": "bom-help", style: "max-height:70vh;overflow:auto;font-size:12px;line-height:1.35" }); d.innerHTML = markdownToHtml(BOM_HELP); body.append(d); } });
      } }],
    build(body, api) {
      generate = api.okButton;
      list = grid([{ label: "BOM generator scripts:", key: "name", type: "ro" }], [], { height: "260px", key: "generators", onSelect: () => { pluginInit(); store(); } });
      name.input.addEventListener("input", () => {
        // OnNameEdited
        const v = name.get(); const i = list ? list.selected() : -1; if (!v || i < 0) return;
        gens[i].gen.name = v; gens[i].label = v; if (list) { const rows = list.rows(); rows[i].name = v; list.refresh(); } store();
      });
      // OnCommandLineEdited
      command.input.addEventListener("input", () => { const g = selected(); if (g) { g.cmd = command.get(); store(); } });
      name.el.style.flex = "1"; command.el.style.width = "100%";
      const add = iconButton("plus", "Add a new BOM generator and its command line to the list", () => { void (async () => {
        // OnAddGenerator: chooseGenerator, then "Generator nickname:"
        const f = await pickScript(); if (!f) return;
        textEntryBox("Add Generator", "Generator nickname:", f.name.replace(/\.[^.]*$/, ""), false, (nick) => {
          if (!nick) return;
          if (gens.some((g) => g.gen.name === nick)) { messageBox("Message", `Nickname '${nick}' already in use.`); return; }
          const path = `${B.USER_PLUGINS}/${f.name}`;
          prefs.user[path] = f.text;
          const gen = B.generatorHandler(path, files());
          if (!gen.ok) return;
          gen.name = nick; gens.push({ gen, label: nick });
          if (list) { list.setRows(gens.map((g) => ({ name: g.label }))); list.select(gens.length - 1); }
          command.set(gen.cmd); pluginInit(); store();
        });
      })(); });
      const edit = iconButton("edit", "Edit the script file in the text editor", () => {
        // OnEditGenerator: the script in a text editor; KiCad's own scripts are shown, the user's can be changed
        const g = selected(); if (!g) return;
        if (g.file.length <= 2) { messageBox("Message", "Generator file name not found."); return; }
        const text = files().get(g.file);
        if (text === undefined) { messageBox("Message", "Generator file name not found."); return; }
        const own = Object.prototype.hasOwnProperty.call(prefs.user, g.file);
        textEntryBox(g.file, own ? "" : "KiCad's own generator script (read only here).", text, true, (t) => {
          if (!own) return;
          prefs.user[g.file] = t;
          const i = list ? list.selected() : -1; const re = B.generatorHandler(g.storedPath, files()); re.name = g.name; re.cmd = g.cmd;
          if (i >= 0) gens[i].gen = re; pluginInit(); store();
        });
      });
      const del = iconButton("trash", "Remove the current generator script from list", () => {
        // OnRemoveGenerator
        const i = list ? list.selected() : -1; if (i < 0 || !list) return;
        const gone = gens.splice(i, 1)[0];
        if (Object.prototype.hasOwnProperty.call(prefs.user, gone.gen.file) && !gens.some((g) => g.gen.file === gone.gen.file)) delete prefs.user[gone.gen.file];
        list.setRows(gens.map((g) => ({ name: g.label })));
        if (gens.length) list.select(Math.min(i, gens.length - 1));
        pluginInit(); store();
      });
      body.append(
        h("div", { style: "display:flex;gap:12px;min-height:300px" },
          h("div", { style: "flex:1;display:flex;flex-direction:column;min-width:0" }, list.el),
          h("div", { style: "flex:2;display:flex;flex-direction:column;gap:6px;min-width:0" },
            h("div", { style: "display:flex;gap:6px;align-items:center" }, h("span", null, "Generator nickname:"), name.el), messages)),
        h("div", { style: "display:flex;gap:4px;margin:6px 0 10px" }, add, edit, h("span", { style: "width:20px" }), del),
        box("Command line running the generator:", command.el));
      install();
    },
    ok() { void runGenerator(); return false; },
    cancel() { store(); } });
}

/** eeschema/dialogs/dialog_bom_help.md */
const BOM_HELP = `# 1. Summary

The Bill of Materials tool creates a BOM which lists all of the components in the design.

The tool uses an external script to generate a BOM in the desired output format. Choosing a different script changes how the BOM is formatted.

Generating a BOM is described in more detail in the Schematic Editor manual.

# 2. Usage

Select a generator script in the **BOM generator scripts** list. Details for the selected generator are shown on the right of the dialog.

Clicking the **Generate** button creates a BOM file with the selected generator.

The default settings present several generator script options, although some additional scripts are installed with KiCad and can be added to the list with the **+** button.

**Note:** On Windows, there is an additional option **Show console window**. When this option is unchecked, BOM generators run in a hidden console window and any output is redirected and printed in the dialog. When this option is checked, BOM generators run in a visible console window.

# 3. Custom generators and command lines

Internally, KiCad creates an intermediate netlist file in XML format that contains information about all of the components in the design. A BOM generator script converts the intermediate netlist file to the desired output format. KiCad runs the BOM generator scripts according to the command line entered at the bottom of the BOM dialog.

The command line format accepts parameters for filenames. Each formatting parameter is replaced with a project-specific path or filename. The supported formatting parameters are:

 * \`%I\`: absolute path and filename of the intermediate netlist file, which is the input to the BOM generator
 * \`%O\`: absolute path and filename of the output BOM file (without file extension)
 * \`%B\`: base filename of the output BOM file (without file extension)
 * \`%P\`: absolute path of the project directory, without trailing slash

**Note:** the \`%O\` output file parameter does not include a file extension. KiCad will attempt to add an appropriate extension to the command line automatically, but an extension may need to be added by hand.

Python is the recommended tool for BOM generator scripts, but other tools can also be used.

## Example command lines for Python scripts

The command line format for a Python script is of the form:

\`\`\`
python <script file name> <input filename> <output filename>
\`\`\`

On Windows, if the desired generator script for a CSV BOM is \`C:\\Users\\username\\kicad\\my_python_script.py\`, the command line would be:

\`\`\`
python.exe C:\\Users\\username\\kicad\\my_python_script.py "%I" "%O.csv"
\`\`\`

On Linux, if the desired generator script for a CSV BOM is \`/home/username/kicad/my_python_script.py\`, the command line would be:

\`\`\`
python /home/username/kicad/my_python_script.py "%I" "%O.csv"
\`\`\`

Double quotes (\`"\`) around the arguments are recommended in case filenames contain spaces or special characters.
`;
