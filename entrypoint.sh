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
ASSETS=/opt/agent-assets
DSH_BRIDGE=/opt/dsh-multica-runtime

export MULTICA_WORKSPACES_ROOT="${MULTICA_WORKSPACES_ROOT:-$HOME/workspaces}"
mkdir -p "$MULTICA_WORKSPACES_ROOT" "$HOME/.agent-runtime" \
         "$HOME/.claude" "$HOME/.codex" "$HOME/.config/opencode" "$HOME/.pi/agent"

# ===================== Koneksi semua CLI ke 9router =====================

# --- Claude Code ---
export ANTHROPIC_BASE_URL="${CLAUDE_BASE_URL:-$ROUTER_URL}"
export ANTHROPIC_AUTH_TOKEN="$NINEROUTER_API_KEY"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-$DEFAULT_MODEL}"
export ANTHROPIC_SMALL_FAST_MODEL="$SMALL_MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$SMALL_MODEL"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# --- Klien OpenAI-compatible (OpenClaw, Hermes) ---
export OPENAI_BASE_URL="$ROUTER_URL/v1"
export OPENAI_API_KEY="$NINEROUTER_API_KEY"

# --- DeepSeek Harness ---
export DEEPSEEK_BASE_URL="$ROUTER_URL/v1"
export DEEPSEEK_API_KEY="$NINEROUTER_API_KEY"

# --- OpenCode: provider "9router" (sama dengan nama yang dipakai agent) ---
jq -n \
  --arg url "$ROUTER_URL/v1" \
  --arg defmodel "9router/$DEFAULT_MODEL" \
  --arg models "$ROUTER_MODELS" '
  {
    "$schema": "https://opencode.ai/config.json",
    model: $defmodel,
    provider: {
      "9router": {
        npm: "@ai-sdk/openai-compatible",
        name: "9router",
        options: { baseURL: $url, apiKey: "{env:NINEROUTER_API_KEY}" },
        models: ($models | split(" ") | map(select(length > 0)) | map({(.): {name: .}}) | add)
      }
    }
  }' > "$HOME/.config/opencode/opencode.json"

# --- Codex ---
cat > "$HOME/.codex/config.toml" <<TOML
model = "$DEFAULT_MODEL"
model_provider = "ninerouter"

[model_providers.ninerouter]
name = "9router"
base_url = "$ROUTER_URL/v1"
env_key = "NINEROUTER_API_KEY"
wire_api = "$CODEX_WIRE_API"
TOML

# --- pi (butuh API key di file; izin 600, ditulis ulang tiap start) ---
jq -n \
  --arg url "$ROUTER_URL/v1" \
  --arg key "$NINEROUTER_API_KEY" \
  --arg models "$ROUTER_MODELS" '
  {
    providers: {
      "9router": {
        baseUrl: $url,
        api: "openai-completions",
        apiKey: $key,
        models: ($models | split(" ") | map(select(length > 0)) | map({id: .}))
      }
    }
  }' > "$HOME/.pi/agent/models.json"
chmod 600 "$HOME/.pi/agent/models.json"

# ===================== Kualitas output agent =====================

# --- Identitas git untuk commit dari agent ---
git config --global user.name  "${GIT_USER_NAME:-Agent ($RUNTIME_ID)}"
git config --global user.email "${GIT_USER_EMAIL:-agent+$RUNTIME_ID@users.noreply.github.com}"

# --- Pedoman Karpathy sebagai instruksi global ---
for f in "$HOME/.claude/CLAUDE.md" \
         "$HOME/.codex/AGENTS.md" \
         "$HOME/.config/opencode/AGENTS.md" \
         "$HOME/.pi/agent/AGENTS.md"; do
  cp "$ASSETS/AGENTS.md" "$f"
done

# --- Skill Matt Pocock (hanya skill miliknya yang ditimpa) ---
sync_skills() {
  local dest="$1"
  mkdir -p "$dest"
  find "$ASSETS/mattpocock-skills" -name SKILL.md -not -path '*/deprecated/*' | while read -r s; do
    d="$(dirname "$s")"; n="$(basename "$d")"
    rm -rf "${dest:?}/$n" && cp -r "$d" "$dest/$n"
  done
}
sync_skills "$HOME/.claude/skills"
sync_skills "$HOME/.config/opencode/skills"
sync_skills "$HOME/.agents/skills"
sync_skills "$HOME/.codex/skills"
sync_skills "$HOME/.pi/agent/skills"

# --- RTK: inisialisasi sekali per versi ---
RTK_VER="$(rtk --version 2>/dev/null | awk '{print $NF}' || true)"
RTK_MARK="$HOME/.agent-runtime/rtk-${RTK_VER:-unknown}"
if [ ! -f "$RTK_MARK" ]; then
  for args in "-g --auto-patch" "-g --opencode" "-g --codex" "--agent hermes" "-g --agent pi"; do
    timeout 60 rtk init $args </dev/null >/dev/null 2>&1 \
      && echo "[agent-runtime] rtk init $args: ok" \
      || echo "[agent-runtime] rtk init $args: GAGAL (diabaikan)"
  done
  touch "$RTK_MARK"
fi

# ===================== DeepSeek Harness: bridge Multica =====================

DSH_MARK="$HOME/.agent-runtime/dsh-bridge-$(cat "$DSH_BRIDGE/COMMIT")"
if [ ! -f "$DSH_MARK" ]; then
  if timeout 180 dsh plugin --profile multica add "$DSH_BRIDGE" </dev/null; then
    touch "$DSH_MARK"
    echo "[agent-runtime] dsh bridge terpasang"
  else
    echo "[agent-runtime] dsh plugin add GAGAL (diabaikan)"
  fi
fi
timeout 60 dsh --profile multica --probe </dev/null >/dev/null 2>&1 \
  && echo "[agent-runtime] dsh probe: ok" \
  || echo "[agent-runtime] dsh probe: GAGAL"

# ===================== Daemon Multica =====================

echo "[agent-runtime] runtime=$RUNTIME_ID router=$ROUTER_URL default_model=$DEFAULT_MODEL"

multica login --token "$MULTICA_TOKEN" >/dev/null

exec multica daemon start --foreground \
  --no-auto-update --no-auto-reload \
  --daemon-id "$RUNTIME_ID" \
  --device-name "$RUNTIME_ID"
