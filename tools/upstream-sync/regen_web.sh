#!/bin/sh
# Bring the web editor's generated tables in line with the KiCad sources in this tree, then
# check and rebuild the web code.  Run from the repository root after an upstream merge.
#
# The tables (action labels, tooltips, hotkeys, toolbar order, icons, the custom rules help,
# the 3D viewer's icons) are read straight out of the C++ tree by server/scripts/gen_*.py, so
# this is the part of an upstream update the web editor gets with no hand work.
#
# Exit status 0: the tree is ready to commit (the tables and the bundles built from them are
# updated, or nothing changed).  Exit status 3: the new tables do not pass the type check, the
# build or the tests; everything under server/ was put back as it was, so the merge can go on
# without them, and the reason is in web-regen.log.
set -u
log=${1:-web-regen.log}
case "$log" in /*) ;; *) log="$PWD/$log" ;; esac
: > "$log"

for gen in gen_kicad_ui gen_kicad_menus gen_kicad_context gen_rules_help gen_viewer3d_icons; do
    python3 server/scripts/$gen.py >> "$log" 2>&1 || { echo "$gen.py failed" | tee -a "$log"; git checkout -q -- server; exit 3; }
done

if git diff --quiet -- server; then
    echo "generated tables: unchanged"
    exit 0
fi
git diff --stat -- server | tail -1

cd server || exit 1
{ npm ci && npm run check && npm run build && npm test; } >> "$log" 2>&1
status=$?
cd ..
if [ $status -ne 0 ]; then
    tail -30 "$log"
    echo "the regenerated tables do not pass the web checks; leaving the web editor as it was"
    git checkout -q -- server
    git clean -qfd -- server/static server/web
    exit 3
fi
echo "generated tables: updated, web checks pass"
