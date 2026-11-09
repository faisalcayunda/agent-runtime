FROM node:24-bookworm-slim

RUN node --version && npm --version

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCLAW_VERSION=latest
ARG PI_VERSION=latest
# dsh dikunci ke rentang yang didukung bridge Multica (>=0.2.1-rc.2 <0.3.0)
ARG DSH_VERSION=0.2.1-rc.2
ARG DSH_BRIDGE_REF=main
ARG HERMES_REF=466591fe65d0257c96083df16fcd39636032304c

# --- Paket sistem + alat feedback loop ---
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep openssh-client tini procps less unzip xz-utils \
      python3 python3-venv python3-pip \
      gh shellcheck make \
    && rm -rf /var/lib/apt/lists/*

# --- CLI berbasis Node (paket npm resmi) + pnpm untuk build bridge dsh ---
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      openclaw@${OPENCLAW_VERSION} \
      @mariozechner/pi-coding-agent@${PI_VERSION} \
      @deepseek-ai/dsh@${DSH_VERSION} \
      pnpm \
    && npm cache clean --force

# --- OpenCode dari installer resmi ---
RUN curl -fsSL https://opencode.ai/install | bash \
    && O="$(command -v opencode || find / -xdev -type f -name opencode -perm -u+x 2>/dev/null | head -n1)" \
    && [ -n "$O" ] \
    && { [ "$O" = /usr/local/bin/opencode ] || install -m 0755 "$O" /usr/local/bin/opencode; }

# --- Hermes: commit yang dikunci + editable install ---
RUN mkdir -p /opt/hermes/src && cd /opt/hermes/src \
    && git init -q \
    && git remote add origin https://github.com/NousResearch/hermes-agent.git \
    && git fetch -q --depth 1 origin "${HERMES_REF}" \
    && git checkout -q FETCH_HEAD \
    && git submodule update --init --recursive --depth 1 \
    && python3 -m venv /opt/hermes/venv \
    && /opt/hermes/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hermes/venv/bin/pip install --no-cache-dir -e "/opt/hermes/src[all]" \
    && ln -sf /opt/hermes/venv/bin/hermes /usr/local/bin/hermes \
    && ln -sf /opt/hermes/venv/bin/hermes-acp /usr/local/bin/hermes-acp \
    && git rev-parse HEAD > /opt/hermes/COMMIT \
    && hermes --version

# --- Bridge resmi Multica <-> DeepSeek Harness (build dari source) ---
RUN git clone --depth 1 --branch "${DSH_BRIDGE_REF}" \
         https://github.com/multica-ai/dsh-multica-runtime.git /opt/dsh-multica-runtime \
    && cd /opt/dsh-multica-runtime \
    && pnpm install \
    && pnpm build \
    && git rev-parse HEAD > /opt/dsh-multica-runtime/COMMIT \
    && rm -rf .git \
    && chmod -R a+rX /opt/dsh-multica-runtime

# --- Multica CLI + daemon ---
RUN curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh | bash \
    && M="$(command -v multica || find / -xdev -type f -name multica -perm -u+x 2>/dev/null | head -n1)" \
    && [ -n "$M" ] \
    && { [ "$M" = /usr/local/bin/multica ] || install -m 0755 "$M" /usr/local/bin/multica; }

# --- uv (tool Python cepat: ruff, pytest, dll.) ---
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh

# --- RTK (binary rilis resmi) ---
RUN curl -fsSL -o /tmp/rtk.tgz \
      https://github.com/rtk-ai/rtk/releases/latest/download/rtk-x86_64-unknown-linux-musl.tar.gz \
    && tar -xzf /tmp/rtk.tgz -C /tmp \
    && install -m 0755 "$(find /tmp -type f -name rtk | head -n1)" /usr/local/bin/rtk \
    && rm -rf /tmp/rtk*

# --- Aset kualitas agent: pedoman Karpathy + skill Matt Pocock ---
RUN mkdir -p /opt/agent-assets \
    && curl -fsSL -o /opt/agent-assets/AGENTS.md \
         https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/CLAUDE.md \
    && git clone --depth 1 https://github.com/mattpocock/skills.git /opt/agent-assets/mattpocock-skills \
    && git -C /opt/agent-assets/mattpocock-skills rev-parse HEAD > /opt/agent-assets/mattpocock-skills.COMMIT \
    && rm -rf /opt/agent-assets/mattpocock-skills/.git \
    && chmod -R a+rX /opt/agent-assets

# --- Build gagal jika ada CLI yang tidak terpasang ---
RUN for c in multica opencode claude codex openclaw hermes pi dsh rtk uv gh shellcheck; do \
      command -v "$c" >/dev/null || { echo "CLI hilang: $c"; exit 1; }; \
      printf '%s: ' "$c"; "$c" --version 2>&1 | head -n1 || true; \
    done \
    && echo "hermes commit: $(cat /opt/hermes/COMMIT)" \
    && echo "dsh bridge commit: $(cat /opt/dsh-multica-runtime/COMMIT)" \
    && echo "skill Matt Pocock: $(find /opt/agent-assets/mattpocock-skills -name SKILL.md | wc -l) skill" \
    && { hermes acp --help >/dev/null 2>&1 && echo "hermes acp: tersedia" || echo "PERINGATAN: hermes acp tidak tersedia"; }

RUN useradd -m -u 1001 -s /bin/bash agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh
RUN bash -n /usr/local/bin/entrypoint.sh

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
