#!/usr/bin/env python3
"""List what an upstream KiCad update means for the web editor.

The web editor (server/web) follows the desktop's behaviour by hand, so every upstream change to
something it mirrors is work to do there.  Given the upstream range that was just merged, this
writes a Markdown to-do list:

  - what was carried over by itself (the files server/scripts/gen_*.py regenerate),
  - exact gaps found by comparing KiCad's tables with the web's (file format tokens and
    versions, DRC and ERC checks, actions, changed dialogs),
  - the web files that name a changed KiCad source file in their comments,
  - the upstream commits per area, for everything a table cannot show (commit ids are left
    bare: GitHub links them, since the merge brings those commits into this repository).

    python3 tools/upstream-sync/parity_report.py --old <sha> --new <sha> [--out parity.md]

Run from the repository root with the merge in the working tree (and the generators already
run, so their output can be compared with HEAD).
"""
import argparse, fnmatch, json, os, re, subprocess, sys
from collections import OrderedDict, defaultdict

WEB = "server/web"

# Areas of KiCad the web editor mirrors, first match wins.  (title, [patterns])
AREAS = [
    ("File format", ["pcbnew/pcb_io/kicad_sexpr/*", "eeschema/sch_io/kicad_sexpr/*", "common/io/kicad/*", "*.keywords",
                     "eeschema/sch_file_versions.h", "common/project/*", "common/drawing_sheet/*", "common/embedded_files*"]),
    ("Design rules (DRC)", ["pcbnew/drc/*", "pcbnew/dialogs/panel_setup_rules*", "pcbnew/board_design_settings*",
                            "common/drc_rules*", "pcbnew/pcbexpr*", "common/libeval*"]),
    ("Electrical rules (ERC) and connectivity", ["eeschema/erc/*", "eeschema/connection_graph*", "eeschema/sch_connection*",
                                                 "eeschema/erc*", "pcbnew/connectivity/*"]),
    ("Dialogs and panels", ["*/dialogs/*", "*/widgets/*", "common/dialog_shim*", "common/eda_base_frame*"]),
    ("Menus, toolbars and hotkeys", ["*/toolbars_*", "*/menubar*", "*_actions.cpp", "*_actions.h", "common/tool/actions.cpp",
                                     "common/hotkey*", "resources/bitmaps_png/*"]),
    ("Board editing tools and router", ["pcbnew/tools/*", "pcbnew/router/*", "pcbnew/microwave/*", "pcbnew/zone*", "pcbnew/teardrop/*",
                                        "pcbnew/length_delay_calculation/*", "pcbnew/generators/*"]),
    ("Schematic editing tools", ["eeschema/tools/*", "eeschema/sch_*.cpp", "eeschema/sch_*.h", "eeschema/symbol_editor/*",
                                 "eeschema/lib_symbol*", "eeschema/annotate*", "eeschema/fields_*"]),
    ("Shared tool framework and selection", ["common/tool/*", "common/view/*", "include/tool/*", "common/eda_item*", "common/eda_text*",
                                             "common/eda_shape*", "common/properties/*", "include/properties/*", "common/grid*"]),
    ("Drawing", ["*painter*", "common/gal/*", "common/font/*", "common/stroke_params*", "common/render_settings*", "common/preview_items/*"]),
    ("Board items", ["pcbnew/pad*", "pcbnew/footprint*", "pcbnew/pcb_*.cpp", "pcbnew/pcb_*.h", "pcbnew/board*", "pcbnew/netinfo*",
                     "pcbnew/padstack*", "pcbnew/netlist_reader/*", "pcbnew/footprint_editor*", "pcbnew/footprint_wizard*"]),
    ("Libraries", ["common/libraries/*", "*lib_table*", "common/lib_id*", "*symbol_library*", "common/footprint_info*", "common/design_block*",
                   "cvpcb/*", "common/lib_tree*", "*lib_tree_model*"]),
    ("Plotting and fabrication outputs", ["common/plotters/*", "pcbnew/exporters/*", "pcbnew/plot*", "pcbnew/pcbplot*", "eeschema/plotters/*",
                                          "common/gbr_*", "eeschema/netlist_exporters/*", "pcbnew/pcb_plotter*"]),
    ("3D viewer", ["3d-viewer/*"]),
    ("Simulator", ["eeschema/sim/*"]),
    ("Project manager and settings", ["kicad/*", "common/settings/*", "common/project*", "pcbnew/pcbnew_settings*", "eeschema/eeschema_settings*"]),
]
# Never the web editor's business.
IGNORE = ["qa/*", "translation/*", "doxygen/*", "docs/*", "thirdparty/*", "api/*", "*/api/*", "scripting/*", "*/python/*", "tools/*",
          "cmake/*", "*CMakeLists.txt", "*.cmake", "packaging/*", "demos/*", "gerbview/*", "pagelayout_editor/*", "pcb_calculator/*",
          "bitmap2component/*", "libs/kiplatform/*", "libs/kinng/*", "*/pcb_io/*", "*/sch_io/*", "common/io/*", "kicad/cli/*",
          "common/jobs/*", "*/jobs/*", "*_jobs_handler*", ".git*", "*.md", "*.txt", "*.json", "resources/*", "vcpkg*", "common/api/*",
          "pcbnew/specctra_import_export/*", "pcbnew/import_gfx/*", "common/import_gfx/*", "common/git/*", "*/git/*", "utils/*"]
KEYWORDS = ["common/pcb.keywords", "eeschema/schematic.keywords", "common/drc_rules.keywords", "common/lib_table.keywords",
            "common/pcb_plot_params.keywords", "common/stroke_params.keywords", "common/embedded_files.keywords",
            "common/template_fieldnames.keywords", "common/netlist.keywords"]
VERSIONS = [("pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h", "board"), ("eeschema/sch_file_versions.h", "schematic and symbol library")]
GENERATED = ["server/web/generated/kicad-ui-spec.json", "server/web/generated/kicad-menu-spec.json",
             "server/web/generated/kicad-menu-icons.json", "server/web/generated/kicad-context-spec.json",
             "server/web/generated/rules-help.ts", "server/web/viewer3d/icons.json"]


def git(*args, check=True):
    r = subprocess.run(["git", *args], capture_output=True, text=True, errors="replace")
    if check and r.returncode != 0:
        raise SystemExit(f"git {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout if r.returncode == 0 else ""


def show(rev, path):
    return git("show", f"{rev}:{path}", check=False)


def matches(path, patterns):
    return any(fnmatch.fnmatch(path, p) for p in patterns)


def area_of(path):
    for title, patterns in AREAS:           # a mirrored area wins over the ignore list
        if matches(path, patterns):
            if title == "File format" or not matches(path, ["qa/*", "*/pcb_io/*", "*/sch_io/*"]):
                return title
    return None


_web_cache = None


def web_files():
    """{path: text} of the hand-written web sources."""
    global _web_cache
    if _web_cache is None:
        _web_cache = {}
        for root, _dirs, files in os.walk(WEB):
            if "/generated" in root or "node_modules" in root:
                continue
            for f in files:
                if f.endswith((".ts", ".tsx")) and not f.endswith(".d.ts"):
                    p = os.path.join(root, f)
                    with open(p, encoding="utf-8", errors="replace") as fh:
                        _web_cache[p] = fh.read()
    return _web_cache


def web_mentions(pattern, limit=4):
    rx = re.compile(pattern)
    hits = [p for p, t in web_files().items() if rx.search(t)]
    return sorted(hits)[:limit], len(hits)


def fmt_hits(hits, total):
    s = ", ".join(f"`{h[len('server/'):]}`" for h in hits)
    return s + (f" and {total - len(hits)} more" if total > len(hits) else "")


def keyword_changes(old, new):
    out = []
    for path in KEYWORDS:
        a = {l.strip() for l in show(old, path).splitlines() if l.strip() and not l.startswith("#")}
        b = {l.strip() for l in show(new, path).splitlines() if l.strip() and not l.startswith("#")}
        for tok in sorted(b - a):
            hits, total = web_mentions(rf"""["'`(]{re.escape(tok)}\b""")
            out.append((path, tok, "added", hits, total))
        for tok in sorted(a - b):
            hits, total = web_mentions(rf"""["'`(]{re.escape(tok)}\b""")
            if total:
                out.append((path, tok, "removed", hits, total))
    return out


def version_changes(old, new):
    out = []
    rx = re.compile(r"^#define\s+(SEXPR_\w+_FILE_VERSION)\s+(\d+)\s*(?://\s*(.*))?$", re.M)
    for path, what in VERSIONS:
        a = {m.group(1): m.group(2) for m in rx.finditer(show(old, path))}
        for m in rx.finditer(show(new, path)):
            if a.get(m.group(1)) != m.group(2):
                out.append((what, m.group(1), a.get(m.group(1), "?"), m.group(2), (m.group(3) or "").strip()))
    return out


ITEM = re.compile(r"_ITEM\s+\w+_ITEM::(\w+)\(\s*(\w+)\s*,\s*_HKI\(\s*\"((?:[^\"\\]|\\.)*)\"\s*\)\s*,\s*(?:wxT\(\s*)?\"([^\"]*)\"", re.S)


def check_items(old, new, path, kind):
    """DRC / ERC checks added, removed or retitled upstream, and whether the web knows the new ones."""
    a = {m.group(4): m.group(3) for m in ITEM.finditer(show(old, path)) if m.group(4)}
    b = {m.group(4): m.group(3) for m in ITEM.finditer(show(new, path)) if m.group(4)}
    out = []
    for key in b:
        if key not in a:
            hits, total = web_mentions(rf"""["'`]{re.escape(key)}["'`]""")
            out.append(f"New {kind} check **{b[key]}** (`{key}`): " + (f"its key is already in {fmt_hits(hits, total)}; check the test itself exists."
                                                                      if total else "not in the web editor. Add it to the severities list and write the test."))
        elif a[key] != b[key]:
            out.append(f"{kind} check `{key}` is now titled **{b[key]}** (was \"{a[key]}\"): update the web's title.")
    for key in a:
        if key not in b:
            hits, total = web_mentions(rf"""["'`]{re.escape(key)}["'`]""")
            if total:
                out.append(f"{kind} check `{key}` (\"{a[key]}\") was removed upstream but is still in {fmt_hits(hits, total)}.")
    return out


def action_changes():
    """Compare the regenerated action table with the one in HEAD."""
    path = "server/web/generated/kicad-menu-spec.json"
    try:
        before = json.loads(show("HEAD", path) or "{}").get("actions", {})
        with open(path, encoding="utf-8") as fh:
            after = json.load(fh).get("actions", {})
    except (OSError, ValueError):
        return [], []
    todo, auto = [], []
    for name, a in after.items():
        if name not in before:
            hits, total = web_mentions(re.escape(name) + r"\b")
            label = a.get("label") or a.get("id")
            if total:
                auto.append(f"New action `{name}` (\"{label}\"), already used by {fmt_hits(hits, total)}.")
            else:
                todo.append(f"New action `{name}` (\"{label}\"{', ' + a['key'] if a.get('key') else ''}): its label, icon and hotkey are in the "
                            f"generated table, but no menu, toolbar or tool in the web editor uses it yet.")
        else:
            b = before[name]
            diff = [f"{k}: \"{b.get(k)}\" to \"{a.get(k)}\"" for k in ("label", "key", "icon") if b.get(k) != a.get(k)]
            if diff:
                auto.append(f"`{name}` changed ({'; '.join(diff)}).")
    for name, b in before.items():
        if name not in after:
            hits, total = web_mentions(re.escape(name) + r"\b")
            if total:
                todo.append(f"Action `{name}` (\"{b.get('label')}\") no longer exists upstream but {fmt_hits(hits, total)} still uses it.")
    return todo, auto


def dialog_changes(files):
    """Changed dialog layouts (.fbp) and the web file that mirrors each, found by the class name."""
    out = []
    for f in sorted(files):
        if not f.endswith(".fbp"):
            continue
        cls = os.path.basename(f)[:-4].replace("_base", "").upper()
        hits, total = web_mentions(r"\b" + re.escape(cls) + r"\b")
        if total:
            out.append(f"Layout of `{cls}` changed (`{f}`); mirrored in {fmt_hits(hits, total)}.")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", required=True, help="upstream commit master already had")
    ap.add_argument("--new", required=True, help="upstream commit that was merged")
    ap.add_argument("--out", default="parity.md")
    ap.add_argument("--web-kept", default="", help="set when the regenerated web files failed their checks and were not committed")
    args = ap.parse_args()
    old, new = git("rev-parse", args.old).strip(), git("rev-parse", args.new).strip()

    commits = []        # (sha, subject, [files])
    log = git("log", "--no-merges", "--reverse", "--format=%x01%H%x02%s", "--name-only", f"{old}..{new}")
    for chunk in log.split("\x01")[1:]:
        head, _, rest = chunk.partition("\n")
        sha, subject = head.split("\x02", 1)
        commits.append((sha, subject, [l for l in rest.splitlines() if l.strip()]))
    changed = sorted({f for _s, _t, fs in commits for f in fs})
    order = [c[0] for c in commits]

    by_area = OrderedDict((t, []) for t, _p in AREAS)
    cites = defaultdict(lambda: defaultdict(set))       # web file -> upstream file -> commit shas
    for sha, subject, files in commits:
        areas = OrderedDict()
        for f in files:
            a = area_of(f)
            if a:
                areas.setdefault(a, []).append(f)
        for a, fs in areas.items():
            by_area[a].append((sha, subject, fs))
    for f in changed:
        if not area_of(f) or not f.endswith((".cpp", ".h")):
            continue
        base = os.path.basename(f)
        if len(base) < 12:
            continue
        rx = re.compile(r"(?<![\w.])" + re.escape(base) + r"\b")
        for p, t in web_files().items():
            if rx.search(t):
                cites[p][f].update(s for s, _t, fs in commits if f in fs)

    gen_changed = [g for g in GENERATED if git("status", "--porcelain", "--", g).strip() or g in git("diff", "--name-only", "HEAD~1", "HEAD", "--", g, check=False)]
    act_todo, act_auto = action_changes()
    kw = keyword_changes(old, new)
    ver = version_changes(old, new)
    drc = check_items(old, new, "pcbnew/drc/drc_item.cpp", "DRC")
    erc = check_items(old, new, "eeschema/erc/erc_item.cpp", "ERC")
    dlg = dialog_changes(changed)
    mirrored = sum(1 for _s, _t, fs in commits if any(area_of(f) for f in fs))

    L = []
    L.append(f"Upstream KiCad `{old[:10]}` to `{new[:10]}`: {len(commits)} commits, {mirrored} of them touch something the web editor mirrors.\n")

    L.append("## Carried over automatically\n")
    if args.web_kept:
        L.append(f"**Not this time.** The regenerated tables did not pass the web checks ({args.web_kept}), so the web editor was left as "
                 "it was. Run the generators in `server/scripts/gen_*.py` by hand, fix what breaks, and commit.\n")
    elif gen_changed or act_auto:
        L.append("Regenerated from KiCad's sources and committed with the merge: " + ", ".join(f"`{g}`" for g in gen_changed) + ".\n")
        for line in act_auto[:60]:
            L.append(f"- {line}")
        if len(act_auto) > 60:
            L.append(f"- and {len(act_auto) - 60} more label, icon or hotkey changes.")
        L.append("")
    else:
        L.append("Nothing changed in the generated tables (action labels, hotkeys, toolbars, icons, rules help).\n")

    L.append("## Exact gaps\n")
    gaps = []
    for what, macro, a, b, note in ver:
        gaps.append(f"The {what} file format went from {a} to {b} ({note}). The web keeps writing the version a file was read with; "
                    f"read the new constructs, keep them through an edit, and draw or edit them where the desktop does.")
    for path, tok, kind, hits, total in kw:
        if kind == "added":
            gaps.append(f"New token `{tok}` in `{path}`: " + (f"the word already appears in {fmt_hits(hits, total)}; check it means this token."
                                                              if total else "nothing in the web editor reads or writes it."))
        else:
            gaps.append(f"Token `{tok}` was removed from `{path}` but {fmt_hits(hits, total)} still uses the word.")
    gaps += drc + erc + act_todo + dlg
    if gaps:
        L += [f"- [ ] {g}" for g in gaps]
    else:
        L.append("None found: no new file format tokens or versions, DRC or ERC checks, actions, or changed layouts of mirrored dialogs.")
    L.append("")

    if cites:
        L.append("## Web files that follow a changed KiCad source\n")
        L.append("Each of these names the KiCad file it was written from, and that file changed. Read the commits and bring the web file in line.\n")
        for p in sorted(cites):
            parts = []
            for f, shas in sorted(cites[p].items()):
                links = " ".join(s[:10] for s in sorted(shas, key=order.index)[:6])
                parts.append(f"`{f}` ({links})")
            L.append(f"- [ ] `{p[len('server/'):]}` follows " + "; ".join(parts))
        L.append("")

    L.append("## Upstream commits by area\n")
    L.append("Everything else that may change behaviour the web editor copies. Tick a commit once it is ported or needs nothing.\n")
    for title, items in by_area.items():
        if not items:
            continue
        L.append(f"### {title}\n")
        for sha, subject, fs in items:
            names = ", ".join(f"`{f}`" for f in fs[:3]) + (f" and {len(fs) - 3} more" if len(fs) > 3 else "")
            L.append(f"- [ ] {sha[:10]} {subject} ({names})")
        L.append("")

    text = "\n".join(L)
    if len(text) > 60000:      # GitHub issue bodies stop at 65536 characters
        text = text[:60000].rsplit("\n", 1)[0] + "\n\n(The list is cut here; the full report is in the workflow run's artifacts.)\n"
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"{len(commits)} commits, {mirrored} mirrored, {len(gaps)} exact gaps, {len(cites)} web files citing changed sources -> {args.out}")


if __name__ == "__main__":
    main()
