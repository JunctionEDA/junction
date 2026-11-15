#!/usr/bin/env python3
"""Resolve the conflicts of an upstream KiCad merge that is in progress.

Run from the repository root while `git merge` has stopped on conflicts.  Two passes:

1. CMakeLists.txt files: both sides usually added source files to the same list, so the two
   sides are kept one after the other (git merge-file --union).
2. Every other conflicted text file: each conflict is sent, with the lines around it, to a
   chat model, which answers with the merged lines.  Any service that speaks the OpenAI
   chat-completions protocol works, and so does the Anthropic Messages API:

     SYNC_AI_BASE_URL   e.g. https://api.openai.com/v1, https://openrouter.ai/api/v1,
                        http://localhost:11434/v1, https://api.anthropic.com/v1
     SYNC_AI_API_KEY    the key for it
     SYNC_AI_MODEL      the model's name there

   Without those three, pass 2 is skipped and the conflicts are left for a person.

Nothing here decides whether the result is right: the sync builds it on three systems and runs
the tests before master moves.  A JSON report of what was done is written to --report.

Exit status: 0 when no conflict is left, 1 when some are.
"""
import argparse, json, os, re, subprocess, sys, urllib.request

CONTEXT_LINES = 40
MAX_CONFLICT_LINES = 400
SYSTEM = """You merge source code. The repository is Junction, a fork of KiCad that adds live \
collaboration. A merge of upstream KiCad into the fork stopped on a conflict.

"ours" is the fork, "theirs" is upstream KiCad, "base" is what both started from.
Rules:
- Keep what the fork added (anything about collab, Junction, online projects, comments) AND \
take upstream's change. Most conflicts are two independent additions at the same place: keep both.
- When both sides changed the same lines in different ways, apply upstream's change to the \
fork's version so the fork's behaviour is kept.
- Do not invent code that is on neither side. Keep the indentation and style.
- If you cannot tell what the right merge is, answer with the single word CANNOT_RESOLVE.

Answer with only the lines that replace the conflict (everything between the <<<<<<< and \
>>>>>>> markers, markers excluded), inside one ```resolved fenced block. No explanation."""


def git(*args, check=True):
    return subprocess.run(["git", *args], check=check, capture_output=True, text=True).stdout


def conflicted():
    return [f for f in git("diff", "--name-only", "--diff-filter=U").splitlines() if f]


def is_text(path):
    try:
        with open(path, "rb") as fh:
            return b"\0" not in fh.read(1 << 20)
    except OSError:
        return False


def union(path):
    """Keep both sides of every conflict of a file, ours first."""
    stages = {}
    for n, name in ((1, "base"), (2, "ours"), (3, "theirs")):
        r = subprocess.run(["git", "show", f":{n}:{path}"], capture_output=True)
        if r.returncode != 0:
            return False
        stages[name] = f"{path}.sync-{name}"
        with open(stages[name], "wb") as fh:
            fh.write(r.stdout)
    try:
        r = subprocess.run(["git", "merge-file", "--union", "-p", stages["ours"], stages["base"], stages["theirs"]],
                           capture_output=True)
        if r.returncode < 0 or r.returncode > 127:
            return False
        with open(path, "wb") as fh:
            fh.write(r.stdout)
        return True
    finally:
        for f in stages.values():
            os.remove(f)


CONFLICT = re.compile(r"^<<<<<<< [^\n]*\n(.*?)^(?:\|\|\|\|\|\|\| [^\n]*\n(.*?))?^=======\n(.*?)^>>>>>>> [^\n]*\n",
                      re.S | re.M)


def ask(prompt):
    base = os.environ["SYNC_AI_BASE_URL"].rstrip("/")
    key, model = os.environ["SYNC_AI_API_KEY"], os.environ["SYNC_AI_MODEL"]
    if "anthropic.com" in base:
        url = base + "/messages"
        body = {"model": model, "max_tokens": 8000, "system": SYSTEM, "messages": [{"role": "user", "content": prompt}]}
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    else:
        url = base + "/chat/completions"
        body = {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]}
        headers = {"authorization": "Bearer " + key}
    headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)
    if "choices" in data:
        return data["choices"][0]["message"]["content"] or ""
    return "".join(p.get("text", "") for p in data.get("content", []))


def resolve_file(path, report):
    # diff3 markers give the model the common ancestor too.
    git("checkout", "--conflict=diff3", "--", path)
    with open(path, encoding="utf-8", errors="surrogateescape") as fh:
        text = fh.read()
    out, pos, ok = [], 0, True
    for m in CONFLICT.finditer(text):
        ours, base, theirs = m.group(1), m.group(2) or "", m.group(3)
        entry = {"file": path, "line": text.count("\n", 0, m.start()) + 1, "ours": ours, "theirs": theirs}
        report.append(entry)
        out.append(text[pos:m.start()])
        pos = m.end()
        merged = None
        if ours.count("\n") + theirs.count("\n") > MAX_CONFLICT_LINES:
            entry["result"] = "left: too large for an automatic merge"
        else:
            before = "".join(text[:m.start()].splitlines(True)[-CONTEXT_LINES:])
            after = "".join(text[m.end():].splitlines(True)[:CONTEXT_LINES])
            prompt = (f"File: {path}\n\nLines before the conflict:\n```\n{before}```\n\n"
                      f"base:\n```\n{base}```\n\nours (the fork):\n```\n{ours}```\n\n"
                      f"theirs (upstream KiCad):\n```\n{theirs}```\n\nLines after the conflict:\n```\n{after}```\n")
            try:
                answer = ask(prompt)
            except Exception as e:  # network, quota, bad key: leave the conflict
                answer = ""
                entry["result"] = f"left: the model could not be reached ({e})"
            block = re.search(r"```resolved[^\n]*\n(.*?)```", answer, re.S)
            if "CANNOT_RESOLVE" in answer and not block:
                entry["result"] = "left: the model could not decide"
            elif block and not re.search(r"^(<<<<<<<|=======|>>>>>>>|\|\|\|\|\|\|\|)", block.group(1), re.M):
                merged = block.group(1)
                if merged and not merged.endswith("\n"):
                    merged += "\n"
                entry["result"], entry["merged"] = "merged by the model", merged
            elif "result" not in entry:
                entry["result"] = "left: the model's answer was not usable"
        if merged is None:
            ok = False
            out.append(m.group(0))
        else:
            out.append(merged)
    out.append(text[pos:])
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as fh:
        fh.write("".join(out))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default="conflicts.json")
    args = ap.parse_args()
    have_ai = all(os.environ.get(k) for k in ("SYNC_AI_BASE_URL", "SYNC_AI_API_KEY", "SYNC_AI_MODEL"))
    report, left = [], []
    for path in conflicted():
        if not os.path.isfile(path) or not is_text(path):
            report.append({"file": path, "result": "left: deleted on one side, or not a text file"})
            left.append(path)
        elif os.path.basename(path) == "CMakeLists.txt" and union(path):
            report.append({"file": path, "result": "both sides kept (source list)"})
            git("add", "--", path)
        elif not have_ai:
            for m in CONFLICT.finditer(open(path, encoding="utf-8", errors="replace").read()):
                report.append({"file": path, "ours": m.group(1), "theirs": m.group(3),
                               "result": "left: no model is configured (SYNC_AI_BASE_URL, SYNC_AI_API_KEY, SYNC_AI_MODEL)"})
            left.append(path)
        elif resolve_file(path, report):
            git("add", "--", path)
        else:
            left.append(path)
    with open(args.report, "w") as fh:
        json.dump({"left": left, "conflicts": report}, fh, indent=1)
    for e in report:
        print(f"{e['file']}:{e.get('line', '')} {e['result']}")
    return 1 if left else 0


if __name__ == "__main__":
    sys.exit(main())
