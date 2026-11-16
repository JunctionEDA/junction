# Upstream KiCad sync

`.github/workflows/upstream-sync.yml` keeps Junction current with upstream KiCad. It runs every
Monday at 06:00 UTC and can be started from the Actions tab.

## What a run does

1. **Merge.** Fetches KiCad's master (GitLab, with the GitHub mirror as a fallback) and merges
   it into master on the branch `upstream-sync`. Nothing new upstream ends the run there, after
   about a minute.
2. **Junction's own files.** Paths in `ours.txt` (workflows, README, contributing docs, KiCad's GitLab CI) keep Junction's version or stay deleted, whatever upstream did to them.
3. **Conflicts.** `resolve_conflicts.py` keeps both sides of source lists in `CMakeLists.txt`
   files, and sends every other conflict to a chat model if one is configured (below). What it
   cannot settle stops the run and opens an issue showing both sides.
4. **File format guard.** `check_format_versions.py` stops the run when upstream raised a file
   format version that the version keeper (`common/io/kicad/kicad_io_utils.cpp`) has no entry
   for, because Junction would then write new tokens under an old version stamp.
5. **Web editor.** `regen_web.sh` runs the generators in `server/scripts/gen_*.py`, which read
   action labels, tooltips, hotkeys, toolbar order, icons and the custom rules help out of the
   C++ tree, then type-checks, builds and tests the web code and commits the result. If the new
   tables break the web checks they are left out and the report says so.
   `parity_report.py` writes the to-do list for everything that cannot be generated.
6. **Build and test.** Linux, Windows and macOS builds of the merge; each is installed on a
   clean machine and the project manager and both editors are started; the collaboration and
   file format round trip tests must pass (KiCad's whole test programs run too and are
   reported); every kind of file the server writes is opened by the new desktop.
7. **Promote.** Only when every job passed, master is moved to the merge and the
   `upstream-sync` branch is deleted. If master moved meanwhile: changes outside the desktop
   code are merged in; anything else starts the run again on top of the new master (five tries).
8. **Report.** A successful sync opens an issue labelled `upstream-parity` with the web to-do
   list. A sync that could not finish opens (or comments on) one issue labelled
   `upstream-sync-failed`; master is untouched.

## Finishing a sync by hand

Put the fixed merge on the `upstream-sync` branch and run the workflow with **resume** ticked.
It skips the merge, builds and tests the branch, and moves master when everything passes.

    git fetch origin master
    git fetch https://gitlab.com/kicad/code/kicad.git master
    git checkout -B upstream-sync origin/master
    git merge FETCH_HEAD        # fix, commit
    git push -f origin upstream-sync

## Settings (all optional)

Repository Settings, Secrets and variables, Actions:

| Name | Kind | What for |
| --- | --- | --- |
| `SYNC_AI_BASE_URL` | variable | Chat service for conflicts: any OpenAI-compatible endpoint (`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, a local Ollama) or `https://api.anthropic.com/v1` |
| `SYNC_AI_MODEL` | variable | The model's name at that service |
| `SYNC_AI_API_KEY` | secret | The key for it |
| `SYNC_PUSH_TOKEN` | secret | A token allowed to change workflow files. Only needed if an upstream commit touches `.github/workflows`, which the built-in token may not push |

Without the three `SYNC_AI_` settings, conflicts outside `CMakeLists.txt` wait for a person.

## Cost

A run that finds nothing new takes about a minute. A run with a merge builds the desktop four
times (Linux, Linux with tests, Windows, macOS): roughly 100, 120, 210 and 75 minutes from a
cold cache, less with the compiler cache warm. Public repositories pay nothing for this. On a
private repository GitHub counts Windows minutes twice and macOS minutes ten times, about
1,400 billed minutes for a cold run. Change the `cron` line in the workflow to run it more or
less often.
