#!/usr/bin/env bash
# Wiki sync (PLAN 2.10, D14, D15): commit the pages the model wrote under ~/.claude/wiki, rebase onto origin/main and
# push to main. Run by the runner outside the model, under `flock` (src/runner.mjs wikiSync); never by the model.
#
# Last stdout line: `WIKI_SYNC status=<nothing|pushed|conflict> [commit=<sha>] [branch=<name>]`.
#   nothing   no page to commit and nothing unpushed (the tree is also freshly rebased, so this doubles as a pull)
#   pushed    local commits are on origin/main
#   conflict  the rebase conflicted: aborted, the commits went to branch gremio-wiki-<ts>, local main reset to origin/main
# Exit 0 ok, 3 the pre-commit scan rejected the pages (nothing committed, findings on stderr), 1 anything else
# (network down after 3 attempts, no clone, ...). Pages left in the tree are retried on the next run.
# `wiki-sync.sh refresh` (read path, PLAN 2.10): fetch origin/main and fast-forward only. Never commits, pushes or resets: the
# model's uncommitted pages and unpushed commits are left alone. Always exit 0; `WIKI_SYNC status=refreshed|skipped`.
# Env: HOME, GH_TOKEN (credential helper only, never in argv), WA_WIKI_DIR, WA_WIKI_REPO, WA_WIKI_RETRY_SLEEP (seconds).
set -euo pipefail

MODE="${1:-sync}"

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI="${WA_WIKI_DIR:-$HOME/.claude/wiki}"
REPO="${WA_WIKI_REPO:-https://github.com/faisalcayunda/claude-wiki.git}"
PAUSE="${WA_WIKI_RETRY_SLEEP:-3}"
export GIT_TERMINAL_PROMPT=0
CRED='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
# core.hooksPath on the command line outranks .git/config and .git/hooks, which the model can write: the scan cannot be swapped out.
G=(-c "credential.helper=$CRED" -c "core.hooksPath=$AGENT_DIR/hooks/wiki-git" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30)
g() { git -C "$WIKI" "${G[@]}" "$@"; }
say() { echo "WIKI_SYNC $*"; }

if [ "$MODE" = refresh ]; then
  if [ ! -d "$WIKI/.git" ]; then
    if git "${G[@]}" clone --depth 1 "$REPO" "$WIKI" >/dev/null 2>&1; then say "status=refreshed"; else say "status=skipped"; fi
    exit 0
  fi
  g checkout -q main >/dev/null 2>&1 || true
  # --ff-only: a diverged branch or a local change in the way is a skip, never a reset (that would discard model pages).
  if g fetch -q origin main >/dev/null 2>&1 && g merge -q --ff-only origin/main >/dev/null 2>&1; then say "status=refreshed"; else say "status=skipped"; fi
  exit 0
fi

if [ ! -d "$WIKI/.git" ]; then
  git "${G[@]}" clone --depth 1 "$REPO" "$WIKI" >&2 || { echo "wiki-sync: clone failed" >&2; exit 1; }
fi
g checkout -q main

# git silently skips a hook without the exec bit and commits anyway: refuse to commit if the image lost the mode.
if [ ! -x "$AGENT_DIR/hooks/wiki-git/pre-commit" ]; then echo "wiki-sync: hooks/wiki-git/pre-commit is not executable; refusing to commit" >&2; exit 3; fi
committed=0
# Additions and modifications only. The model can delete or `git rm` an owner page, and `git add -A` would push that to main:
# start from a clean index, stage what exists, and put deleted pages back so the clone cannot diverge from main.
g reset -q
while IFS= read -r -d '' f; do
  if [ -e "$WIKI/$f" ] || [ -L "$WIKI/$f" ]; then g add -- "$f"; fi
done < <(g ls-files -z --modified --others --exclude-standard)
if ! g diff --cached --quiet; then
  if ! out="$(g commit -q -m "docs: auto-commit wiki changes ($(date '+%Y-%m-%d %H:%M'))" 2>&1)"; then
    g reset -q # pages stay in the tree, the index stays clean (same as the Mac hook)
    printf '%s\n' "$out" >&2
    exit 3
  fi
  committed=1
fi
while IFS= read -r -d '' f; do g checkout -q -- "$f"; done < <(g ls-files -z --deleted)

# The pre-commit can be skipped from inside the clone (`git commit --no-verify`), so everything that is about to leave is
# scanned again: every added or modified page of every commit in origin/main..HEAD, with the same scanner and the same
# allow-file refusal. Fails closed. On a hit nothing is pushed (not even a conflict branch): the commits are undone back
# into the working tree, where the model can fix the page, and the run ends with exit 3 and findings on stderr.
SCAN="$AGENT_DIR/hooks/secret_scan.py"
rescan() {
  local c f content bad=0
  if [ ! -f "$SCAN" ]; then echo "wiki-sync: $SCAN is missing; refusing to push" >&2; return 1; fi
  for c in $(g rev-list origin/main..HEAD); do
    while IFS= read -r -d '' f; do
      content="$(g show "$c:$f")" || { bad=1; continue; }
      if grep -qi 'allow-file' <<<"$content"; then echo "$f: carries the secret-scan allow-file marker (commit ${c:0:7})" >&2; bad=1; continue; fi
      python3 -I "$SCAN" --stdin --name "$f" <<<"$content" >&2 || bad=1
    done < <(g diff-tree -r -z --no-commit-id --name-only --diff-filter=AM "$c")
  done
  return $bad
}

# One attempt = fetch, rebase, push. A failed fetch or push (network, a push that raced another one) is retried.
conflict() {
  g rebase --abort >/dev/null 2>&1 || true
  local branch="gremio-wiki-$(date -u +%Y%m%dT%H%M%SZ)" n
  for n in 1 2 3; do
    if g push -q origin "HEAD:refs/heads/$branch"; then
      g reset -q --hard origin/main # the pages live on the branch; main must not stay diverged or every later sync conflicts again
      say "status=conflict branch=$branch"
      exit 0
    fi
    sleep "$PAUSE"
  done
  echo "wiki-sync: could not push branch $branch" >&2
  exit 1
}
for attempt in 1 2 3; do
  if g fetch -q origin main; then
    if ! rescan; then
      g reset -q origin/main
      echo "wiki-sync: commits failed the rescan; nothing pushed. The pages are back in the working tree: remove the secret from them." >&2
      exit 3
    fi
    g rebase -q origin/main >/dev/null 2>&1 || conflict
    if [ "$(g rev-list --count origin/main..HEAD)" = 0 ]; then say "status=nothing"; exit 0; fi
    if g push -q origin HEAD:refs/heads/main; then say "status=pushed commit=$(g rev-parse --short HEAD)"; exit 0; fi
  fi
  [ "$attempt" = 3 ] || sleep "$PAUSE"
done
echo "wiki-sync: gave up after 3 attempts (committed=$committed)" >&2
exit 1
