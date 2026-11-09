FROM node:24-bookworm-slim

RUN node --version && npm --version

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCLAW_VERSION=latest
ARG HERMES_REF=main

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep openssh-client tini procps less unzip \
      python3 python3-venv python3-pip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# CLI berbasis Node (paket npm resmi)
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      openclaw@${OPENCLAW_VERSION} \
    && npm cache clean --force

# OpenCode dari installer resmi (paket npm opencode-ai tertinggal di 1.x)
RUN curl -fsSL https://opencode.ai/install | bash \
    && O="$(command -v opencode || find / -xdev -type f -name opencode -perm -u+x 2>/dev/null | head -n1)" \
    && [ -n "$O" ] \
    && { [ "$O" = /usr/local/bin/opencode ] || install -m 0755 "$O" /usr/local/bin/opencode; }

# Hermes: clone repo resmi lalu editable install (wheel biasa ditolak Hermes)
RUN git clone --depth 1 --branch "${HERMES_REF}" --recurse-submodules --shallow-submodules \
         https://github.com/NousResearch/hermes-agent.git /opt/hermes/src \
    && python3 -m venv /opt/hermes/venv \
    && /opt/hermes/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/hermes/venv/bin/pip install --no-cache-dir -e "/opt/hermes/src[all]" \
    && ln -s /opt/hermes/venv/bin/hermes /usr/local/bin/hermes \
    && git -C /opt/hermes/src rev-parse HEAD > /opt/hermes/COMMIT

# Multica CLI + daemon
RUN curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh | bash \
    && M="$(command -v multica || find / -xdev -type f -name multica -perm -u+x 2>/dev/null | head -n1)" \
    && [ -n "$M" ] \
    && { [ "$M" = /usr/local/bin/multica ] || install -m 0755 "$M" /usr/local/bin/multica; }

# Build gagal jika ada CLI yang tidak terpasang
RUN for c in multica opencode claude codex openclaw hermes; do \
      command -v "$c" >/dev/null || { echo "CLI hilang: $c"; exit 1; }; \
      printf '%s: ' "$c"; "$c" --version 2>&1 | head -n1 || true; \
    done \
    && echo "hermes commit: $(cat /opt/hermes/COMMIT)" \
    && { hermes acp --help >/dev/null 2>&1 && echo "hermes acp: tersedia" || echo "PERINGATAN: hermes acp tidak tersedia"; }

RUN useradd -m -u 1001 -s /bin/bash agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

RUN bash -n /usr/local/bin/entrypoint.sh

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
