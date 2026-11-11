#!/usr/bin/env bash
# Worker container entrypoint (PLAN 2.8): the whole wa env contract. entrypoint.sh stays untouched.
# Order: validate every variable and the model, then (network) multica login, then the wiki clone.
# Env: WA_AGENT_DIR (default /opt/wa-agent), WA_ASSETS_DIR (default /opt/agent-assets), HOME.
# WA_SELFTEST=1 skips the Multica login, the wiki clone and the poller; extra arguments are then exec'd instead
# of the runner (phase 3 selftest runs its checks inside the finished env).
set -euo pipefail

AGENT_DIR="${WA_AGENT_DIR:-/opt/wa-agent}"
ASSETS_DIR="${WA_ASSETS_DIR:-/opt/agent-assets}"
SELFTEST="${WA_SELFTEST:-0}"

die() { echo "[worker-boot] $*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 is required"; }
no_fable() { case "$2" in *[Ff][Aa][Bb][Ll][Ee]*) die "$1 must not name fable (owner rule: never Fable)";; esac; }

# ---- 1. validation, before any network call ----
need WA_MAIN_MODEL
no_fable WA_MAIN_MODEL "$WA_MAIN_MODEL"
[ "$SELFTEST" = 1 ] || need MULTICA_TOKEN
need GH_TOKEN
need GIT_USER_NAME
need GIT_USER_EMAIL

ROUTE="${WA_D1_ROUTE:-9router}"
case "$ROUTE" in
  9router)
    need WA_ROUTER_KEY
    export ANTHROPIC_BASE_URL="${ROUTER_URL:-http://ninerouter.ai.svc.cluster.local}"
    export ANTHROPIC_AUTH_TOKEN="$WA_ROUTER_KEY"
    unset ANTHROPIC_API_KEY
    OPUS_DEFAULT=role-architect
    ;;
  direct)
    need ANTHROPIC_API_KEY
    export ANTHROPIC_API_KEY
    unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
    OPUS_DEFAULT="$WA_MAIN_MODEL"
    ;;
  *) die "WA_D1_ROUTE must be 9router or direct, got: $ROUTE" ;;
esac

export WA_MAIN_MODEL
export ANTHROPIC_MODEL="$WA_MAIN_MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${WA_SONNET_MODEL:-$WA_MAIN_MODEL}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="${WA_OPUS_MODEL:-$OPUS_DEFAULT}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${WA_HAIKU_MODEL:-$WA_MAIN_MODEL}"
no_fable ANTHROPIC_DEFAULT_SONNET_MODEL "$ANTHROPIC_DEFAULT_SONNET_MODEL"
no_fable ANTHROPIC_DEFAULT_OPUS_MODEL "$ANTHROPIC_DEFAULT_OPUS_MODEL"
no_fable ANTHROPIC_DEFAULT_HAIKU_MODEL "$ANTHROPIC_DEFAULT_HAIKU_MODEL"
# No OpenAI or DeepSeek exports. ANTHROPIC_DEFAULT_FABLE_MODEL stays unset on purpose (PLAN 2.7).

# ---- 2. local files: git identity, CLAUDE.md, the four skill assets, carried agents ----
git config --global user.name "$GIT_USER_NAME"
git config --global user.email "$GIT_USER_EMAIL"
mkdir -p "$HOME/.claude" "$HOME/assistant" "$HOME/.claude/agent-memory"
# Same code the runner runs before every turn: mirror skills/agents, empty commands/rules, CLAUDE.md, settings.json = {}.
node "$AGENT_DIR/src/reset.mjs" "$HOME" "$ASSETS_DIR/skills" "$ASSETS_DIR/agents" "$AGENT_DIR/config/CLAUDE.md" >&2
# antislop (skill): without a saved mode it asks "When do you want to use antislop?" and a headless turn hangs on it. Same file and
# value as entrypoint.sh writes for the Multica pods (`during`: the rules apply while writing). The skill reads
# ~/.config/antislop/settings.json and only its `mode` field (checked in the pinned SKILL.md). Outside ~/.claude, so the pre-turn
# reset does not touch it.
mkdir -p "$HOME/.config/antislop"
printf '{"mode":"during"}\n' > "$HOME/.config/antislop/settings.json.tmp"
mv "$HOME/.config/antislop/settings.json.tmp" "$HOME/.config/antislop/settings.json"
# No `rtk init`: it installs a user-settings hook, which allowManagedHooksOnly blocks and the {} rewrite removes.

# ---- 3. network: Multica login, wiki clone ----
if [ "$SELFTEST" != 1 ]; then
  multica login --token "$MULTICA_TOKEN" >/dev/null
  unset MULTICA_TOKEN # the login file under ~/.multica is enough; never inherited by the poller, runner or claude
  WIKI="$HOME/.claude/wiki"
  REPO="${WA_WIKI_REPO:-https://github.com/faisalcayunda/claude-wiki.git}"
  cred='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
  if [ -d "$WIKI/.git" ]; then
    git -C "$WIKI" -c "credential.helper=$cred" pull --rebase origin main >/dev/null 2>&1 \
      || { git -C "$WIKI" rebase --abort >/dev/null 2>&1 || true; echo "[worker-boot] wiki refresh failed, keeping the current tree" >&2; }
  else
    git -c "credential.helper=$cred" clone --depth 1 "$REPO" "$WIKI" >/dev/null 2>&1 \
      || echo "[worker-boot] wiki clone failed, continuing without it" >&2
  fi
fi

# ---- 4. start ----
if [ "$SELFTEST" = 1 ]; then
  [ "$#" -gt 0 ] && exec "$@"
  exit 0
fi
( while true; do node "$AGENT_DIR/src/poller.mjs" || true; sleep 5; done ) &
exec node "$AGENT_DIR/src/runner.mjs"
