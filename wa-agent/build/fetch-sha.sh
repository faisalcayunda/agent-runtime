#!/usr/bin/env bash
# Fetch one commit of a public git repo into <dest> and prove it is exactly <sha>. Optional sparse paths limit the checkout.
# usage: fetch-sha.sh <url> <sha> <dest> [path...]
set -euo pipefail
url=$1 sha=$2 dest=$3; shift 3
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "fetch-sha: not a full 40-hex sha: $sha" >&2; exit 1; }
git init -q "$dest"
git -C "$dest" remote add origin "$url"
if [ "$#" -gt 0 ]; then
  git -C "$dest" sparse-checkout set "$@"
  git -C "$dest" fetch -q --depth 1 --filter=blob:none origin "$sha"
else
  git -C "$dest" fetch -q --depth 1 origin "$sha"
fi
git -C "$dest" checkout -q FETCH_HEAD
[ "$(git -C "$dest" rev-parse HEAD)" = "$sha" ] || { echo "fetch-sha: HEAD is not $sha" >&2; exit 1; }
rm -rf "$dest/.git"
