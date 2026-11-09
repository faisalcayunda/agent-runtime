#!/usr/bin/env bash
set -euo pipefail

: "${MULTICA_TOKEN:?MULTICA_TOKEN belum diisi}"
: "${NINEROUTER_API_KEY:?NINEROUTER_API_KEY belum diisi}"
: "${RUNTIME_ID:?RUNTIME_ID belum diisi}"

ROUTER_URL="${ROUTER_URL:-http://ninerouter.ai.svc.cluster.local}"
DEFAULT_MODEL="${DEFAULT_MODEL:-tier2-specialist-exec}"
SMALL_MODEL="${SMALL_MODEL:-tier4-free}"
ROUTER_MODELS="${ROUTER_MODELS:-tier1-judge tier2-specialist-exec tier2-adversarial-critic tier3-fast-research tier4-free gemini-3.8-flash}"
CODEX_WIRE_API="${CODEX_WIRE_API:-responses}"

export MULTICA_WORKSPACES_ROOT="${MULTICA_WORKSPACES_ROOT:-$HOME/workspaces}"
mkdir -p "$MULTICA_WORKSPACES_ROOT" "$HOME/.config/opencode" "$HOME/.codex"

# --- Claude Code -> 9router ---
export ANTHROPIC_BASE_URL="${CLAUDE_BASE_URL:-$ROUTER_URL}"
export ANTHROPIC_AUTH_TOKEN="$NINEROUTER_API_KEY"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$DEFAULT_MODEL}"
export ANTHROPIC_SMALL_FAST_MODEL="$SMALL_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$SMALL_MODEL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# --- Klien OpenAI-compatible (OpenClaw, Hermes) -> 9router ---
export OPENAI_BASE_URL="$ROUTER_URL/v1"
export OPENAI_API_KEY="$NINEROUTER_API_KEY"

# --- OpenCode: provider "9router", sama dengan nama yang dipakai agent ---
jq -n \
  --arg url "$ROUTER_URL/v1" \
  --arg def "9router/$DEFAULT_MODEL" \
  --arg models "$ROUTER_MODELS" '
  {
    "$schema": "https://opencode.ai/config.json",
    model: $def,
    provider: {
      "9router": {
        npm: "@ai-sdk/openai-compatible",
        name: "9router",
        options: { baseURL: $url, apiKey: "{env:NINEROUTER_API_KEY}" },
        models: ($models | split(" ") | map(select(length > 0)) | map({(.): {name: .}}) | add)
      }
    }
  }' > "$HOME/.config/opencode/opencode.json"

# --- Codex -> 9router ---
cat > "$HOME/.codex/config.toml" <<TOML
model = "$DEFAULT_MODEL"
model_provider = "ninerouter"

[model_providers.ninerouter]
name = "9router"
base_url = "$ROUTER_URL/v1"
env_key = "NINEROUTER_API_KEY"
wire_api = "$CODEX_WIRE_API"
TOML

echo "[agent-runtime] runtime=$RUNTIME_ID router=$ROUTER_URL default_model=$DEFAULT_MODEL"

# --- Login Multica dengan token, lalu daemon di foreground ---
multica login --token "$MULTICA_TOKEN" >/dev/null

exec multica daemon start --foreground \
  --daemon-id "$RUNTIME_ID" \
  --device-name "$RUNTIME_ID"
