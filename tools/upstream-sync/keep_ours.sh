#!/bin/sh
# Give every path in tools/upstream-sync/ours.txt Junction's version again after a merge:
# what Junction has is restored, what Junction deleted (or never had) is removed, and the
# result is staged.  Settles modify/delete conflicts on those paths too.
#   keep_ours.sh [commit]     commit defaults to HEAD (the pre-merge master)
set -eu
ref=${1:-HEAD}
list=$(dirname "$0")/ours.txt
grep -v -e '^#' -e '^[[:space:]]*$' "$list" | while read -r p; do
    # Drop whatever the merge put there, then bring back Junction's copy if it has one.
    git rm -rqf --cached --ignore-unmatch -- "$p" > /dev/null
    rm -rf -- "$p"
    if git cat-file -e "$ref:$p" 2> /dev/null; then
        git checkout -q "$ref" -- "$p"
    fi
done
