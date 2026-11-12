#!/usr/bin/env bash
# Build the flat skill asset dir the worker mirrors into ~/.claude/skills (PLAN 2.9: exactly five assets).
# usage: assemble-skills.sh <mattpocock-clone> <antislop-clone> <rea-skill-dir> <typesafe-skill-dir> <out>
# Fails on a missing SKILL.md, a name collision, grill-with-docs absent, or any of the six antislop dirs absent.
set -euo pipefail
mp=$1 as=$2 rea=$3 ts=$4 out=$5
mkdir -p "$out"
add() {
  [ -f "$1/SKILL.md" ] || { echo "assemble-skills: no SKILL.md in $1" >&2; exit 1; }
  d="$out/$(basename "$1")"
  [ ! -e "$d" ] || { echo "assemble-skills: name collision: $(basename "$1")" >&2; exit 1; }
  cp -R "$1" "$d"
}
# mattpocock: the plugin manifest list, flattened (the clone is unpinned; the assertions below are the guard)
while IFS= read -r p; do add "$mp/$p"; done < <(jq -r '.skills[]' "$mp/.claude-plugin/plugin.json")
[ -f "$out/grill-with-docs/SKILL.md" ] || { echo "assemble-skills: grill-with-docs missing from the mattpocock manifest" >&2; exit 1; }
for n in antislop antislop-code antislop-copywriting antislop-human antislop-layoutmobile antislop-ui; do add "$as/skills/$n"; done
add "$rea"
add "$ts"
# local skills shipped with wa-agent (wa-agent/skills/*), found relative to this script: /opt/wa-agent/build/../skills in the image
local_skills="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/skills"
if [ -d "$local_skills" ]; then for d in "$local_skills"/*/; do add "${d%/}"; done; fi
echo "assemble-skills: $(ls "$out" | wc -l | tr -d ' ') skills"
