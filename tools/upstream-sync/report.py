#!/usr/bin/env python3
"""Tell the owner how an upstream sync run ended, as a GitHub issue.

Run by the last job of .github/workflows/upstream-sync.yml:

  - the merge reached master: the web parity to-do list (report/parity.md) becomes an issue
    labelled "upstream-parity", and an open "upstream-sync-failed" issue gets a comment
    saying the sync went through;
  - the run started itself again because master moved: nothing to say yet;
  - anything else: one issue labelled "upstream-sync-failed" is opened, or gets a comment when
    it is open already, with what failed, the conflicts that were left, and how to finish.

Where issues are switched off the text goes to the run's summary, and a failed sync fails this
job too, so it still shows on the Actions page.
"""
import datetime, json, os, subprocess, sys

results = {k: v.get("result", "") for k, v in json.loads(os.environ.get("RESULTS", "{}")).items()}
promoted = os.environ.get("PROMOTED", "")
old, new = os.environ.get("OLD", "")[:10], os.environ.get("NEW", "")[:10]
count, run_url = os.environ.get("COUNT", ""), os.environ.get("RUN_URL", "")
today = datetime.date.today().isoformat()
NAMES = {"merge": "Merging upstream", "linux": "Linux build", "windows": "Windows build", "macos": "macOS build",
         "launch-linux": "Launching the Linux build", "launch-windows": "Launching the Windows build",
         "launch-macos": "Launching the macOS build", "loads": "Opening the server's files in the new desktop",
         "qa": "Collaboration and file format tests", "promote": "Moving master"}


def gh(*args, input=None):
    r = subprocess.run(["gh", *args], input=input, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"gh {' '.join(args[:3])}: {r.stderr.strip()}")
    return r.returncode == 0, r.stdout.strip()


def read(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return ""


def publish(title, body, label, color, description):
    """Open an issue; True when it exists afterwards."""
    gh("label", "create", label, "--color", color, "--description", description)
    ok, out = gh("issue", "create", "--title", title, "--label", label, "--body-file", "-", input=body)
    if ok:
        print(out)
    return ok


def summary(text):
    with open(os.environ.get("GITHUB_STEP_SUMMARY", os.devnull), "a", encoding="utf-8") as fh:
        fh.write(text + "\n")


def open_failures():
    ok, out = gh("issue", "list", "--label", "upstream-sync-failed", "--state", "open", "--json", "number")
    return [str(i["number"]) for i in json.loads(out)] if ok and out else []


if promoted == "restarted":
    print("the sync started itself again; nothing to report yet")
    sys.exit(0)

if promoted == "pushed":
    body = (f"master now has upstream KiCad through {new} ({count} commits, built and launched on Linux, Windows and macOS, "
            f"[run]({run_url})). This is what the update means for the web editor.\n\n"
            + (read("report/parity.md") or "The parity list was not produced; see the run."))
    conflicts = json.loads(read("report/conflicts.json") or "{}").get("conflicts", [])
    if conflicts:
        body += "\n## Conflicts that were settled automatically\n\nThe builds and tests passed with these, but they are worth a look.\n\n"
        for c in conflicts:
            body += f"- `{c['file']}`" + (f" line {c['line']}" if c.get("line") else "") + f": {c['result']}\n"
    for n in open_failures():
        gh("issue", "comment", n, "--body", f"A later sync went through: master has upstream KiCad through {new} ([run]({run_url})). This can be closed.")
    if not publish(f"Web parity: upstream KiCad {old} to {new} ({today})", body[:65000], "upstream-parity", "1d76db",
                   "What an upstream KiCad update means for the web editor"):
        summary(body)
    sys.exit(0)

# The sync did not finish.
failed = [NAMES.get(k, k) for k, v in results.items() if v == "failure"] or ["The run was cancelled or timed out"]
body = f"The upstream KiCad sync of {today} did not reach master, which is unchanged. [Run]({run_url})\n\n"
body += "**What failed:** " + ", ".join(failed) + ".\n\n"
report = json.loads(read("report/conflicts.json") or "{}")
left = [c for c in report.get("conflicts", []) if str(c.get("result", "")).startswith("left")]
if left:
    body += "## Conflicts left\n\n"
    for c in left[:20]:
        body += f"`{c['file']}`" + (f" line {c['line']}" if c.get("line") else "") + f": {c['result']}\n"
        if c.get("ours") is not None:
            body += f"\nJunction has:\n```\n{c['ours'][:1500]}```\nupstream KiCad has:\n```\n{c.get('theirs', '')[:1500]}```\n"
        body += "\n"
    body += ("## To finish it by hand\n\n```\ngit fetch origin master\n"
             "git fetch https://gitlab.com/kicad/code/kicad.git master\n"
             "git checkout -B upstream-sync origin/master\ngit merge FETCH_HEAD     # fix the conflicts, then commit\n"
             "git push -f origin upstream-sync\n```\n"
             "Then run the **upstream-sync** workflow from the Actions tab with **resume** ticked. It builds and tests that "
             "branch and moves master when everything passes.\n")
elif results.get("merge") == "success":
    body += ("The merge itself is on the `upstream-sync` branch. Push a fix onto that branch and run the **upstream-sync** "
             "workflow from the Actions tab with **resume** ticked; it builds and tests the branch again and moves master "
             "when everything passes. The failing job's log is in the run linked above.\n")
else:
    body += "The failing step's log is in the run linked above.\n"

# The compiler's or the tests' own words, so the issue can be acted on without opening the logs.
ok, log = gh("run", "view", os.environ.get("GITHUB_RUN_ID", ""), "--log-failed")
if ok and log:
    lines, seen = [], set()
    for line in log.splitlines():
        parts = line.split("\t", 2)
        text = parts[-1].split("Z ", 1)[-1].strip()
        if (" error: " in text or " error C" in text or text.startswith("FAILED: ") or "fatal error" in text
                or "undefined reference" in text or "Undefined symbols" in text) and text not in seen:
            seen.add(text)
            lines.append(f"{parts[0]}: {text[:400]}" if len(parts) == 3 else text[:400])
    if lines:
        body += "\n## Errors\n\n```\n" + "\n".join(lines[:40]) + "\n```\n"
        if len(lines) > 40:
            body += f"and {len(lines) - 40} more in the run's logs.\n"

existing = open_failures()
if existing:
    ok, _ = gh("issue", "comment", existing[0], "--body-file", "-", input=body)
else:
    ok = publish(f"Upstream KiCad sync failed ({today})", body[:65000], "upstream-sync-failed", "d73a4a",
                 "An automatic upstream KiCad sync could not finish")
summary(body)
sys.exit(1)
