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
export ANTHROPIC_DEFAULT_OPUS_MODEL="${ANTHROPIC_DEFAULT_OPUS_MODEL:-tier1-judge}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$DEFAULT_MODEL"
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

# Langkah konfigurasi opsional: gagal -> log lalu lanjut (set -e tidak boleh mematikan boot)
optional() {
  local label="$1"; shift
  timeout 120 "$@" </dev/null >/dev/null \
    && echo "[agent-runtime] $label: ok" \
    || echo "[agent-runtime] $label: GAGAL (diabaikan)"
}

# --- pi (tanpa key di file; "!printenv" jalan di semua versi pi, sedangkan nama env polos vs ${NAME} beda antar versi) ---
jq -n \
  --arg url "$ROUTER_URL/v1" \
  --arg models "$ROUTER_MODELS" '
  {
    providers: {
      "9router": {
        baseUrl: $url,
        api: "openai-completions",
        apiKey: "!printenv NINEROUTER_API_KEY",
        models: ($models | split(" ") | map(select(length > 0)) | map({id: .}))
      }
    }
  }' > "$HOME/.pi/agent/models.json"
chmod 600 "$HOME/.pi/agent/models.json"

# pi tanpa --model memilih provider sendiri (openai) -> kunci default ke 9router; settings lain dipertahankan
PI_SETTINGS="$HOME/.pi/agent/settings.json"
{ [ -s "$PI_SETTINGS" ] || echo '{}' > "$PI_SETTINGS"; } \
  && jq --arg m "$DEFAULT_MODEL" '. + {defaultProvider: "9router", defaultModel: $m}' "$PI_SETTINGS" > "$PI_SETTINGS.tmp" \
  && mv "$PI_SETTINGS.tmp" "$PI_SETTINGS" \
  && echo "[agent-runtime] pi default model: ok" \
  || echo "[agent-runtime] pi default model: GAGAL (diabaikan)"

# --- Hermes: config.yaml sumber kebenaran endpoint; key dari OPENAI_API_KEY (base_url harus sama persis dgn OPENAI_BASE_URL) ---
# urutan wajib provider -> base_url -> default: mengganti provider menghapus base_url lama
optional "hermes provider" hermes config set model.provider custom
optional "hermes base_url" hermes config set model.base_url "$ROUTER_URL/v1"
optional "hermes model" hermes config set model.default "$DEFAULT_MODEL"

# --- OpenClaw: provider custom "9router"; key dirujuk lewat ${NINEROUTER_API_KEY} ---
OPENCLAW_PROVIDER="$(jq -nc \
  --arg url "$ROUTER_URL/v1" \
  --arg models "$ROUTER_MODELS" '
  {
    baseUrl: $url,
    api: "openai-completions",
    apiKey: "${NINEROUTER_API_KEY}",
    models: ($models | split(" ") | map(select(length > 0)) | map({id: ., name: .}))
  }')"
optional "openclaw provider" openclaw config set models.providers.9router "$OPENCLAW_PROVIDER" --strict-json
optional "openclaw model" openclaw config set agents.defaults.model.primary "9router/$DEFAULT_MODEL"
# embedding memory search default ke api.openai.com (membawa OPENAI_API_KEY = key 9router) -> hanya keyword
optional "openclaw memory search" openclaw config set memory.search.provider none

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
  # node bisa mati kapan saja (ADR 0001 homelab-infra): kerja yang belum di-push dianggap hilang
  cat >> "$f" <<'MD'

## Push your work

This machine can lose power or be paused at any time, and its disk is treated as a cache.
After each meaningful step, commit and push to a WIP branch (for example `wip/<task>`).
Never leave work only on the local disk.
MD
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

# --- RTK: tiap boot, setelah AGENTS.md/CLAUDE.md disalin ulang (init idempoten; edit RTK di file itu ikut tertimpa) ---
# ulimit -c 0: kalau rtk mati (SIGILL di CPU lama), jangan menumpuk core dump di $HOME
for args in "-g --auto-patch" "-g --opencode" "-g --codex" "--agent hermes" "-g --agent pi"; do
  (ulimit -c 0; timeout 60 rtk init $args </dev/null >/dev/null 2>&1) \
    && echo "[agent-runtime] rtk init $args: ok" \
    || echo "[agent-runtime] rtk init $args: GAGAL (diabaikan)"
done

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
# Katalog model + model default dsh -> alias 9router (lapisan user: cordis.patch.yml; JSON = YAML valid)
DSH_PATCH="$HOME/.dsh/profiles/multica/cordis.patch.yml"
{ echo "# dikelola entrypoint.sh, ditimpa tiap boot; patch sendiri lewat --patch"
  jq -n \
  --arg models "$ROUTER_MODELS" \
  --arg defmodel "$DEFAULT_MODEL" '
  [
    { id: "llm-deepseek",
      config: { models: ($models | split(" ") | map(select(length > 0)) | map({id: ., name: .})) } },
    { id: "agent-default-model",
      config: { provider: "deepseek-official", model: $defmodel } }
  ]'; } > "$DSH_PATCH.tmp" \
  && mv "$DSH_PATCH.tmp" "$DSH_PATCH" \
  && echo "[agent-runtime] dsh model patch: ok" \
  || echo "[agent-runtime] dsh model patch: GAGAL (diabaikan)"
timeout 60 dsh --profile multica --probe </dev/null >/dev/null 2>&1 \
  && echo "[agent-runtime] dsh probe: ok" \
  || echo "[agent-runtime] dsh probe: GAGAL"

# ===================== Daemon Multica =====================

echo "[agent-runtime] runtime=$RUNTIME_ID router=$ROUTER_URL default_model=$DEFAULT_MODEL"

multica login --token "$MULTICA_TOKEN" >/dev/null
unset MULTICA_TOKEN # daemon memakai token tersimpan; jangan diwariskan ke proses agent

exec multica daemon start --foreground \
  --no-auto-update --no-auto-reload \
  --daemon-id "$RUNTIME_ID" \
  --device-name "$RUNTIME_ID"
