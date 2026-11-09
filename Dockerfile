FROM node:24-bookworm-slim

RUN node --version && npm --version

ARG OPENCODE_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCLAW_VERSION=latest
ARG HERMES_VERSION=

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq ripgrep openssh-client tini procps less \
      python3 python3-venv python3-pip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# CLI berbasis Node
RUN npm install -g \
      opencode-ai@${OPENCODE_VERSION} \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      openclaw@${OPENCLAW_VERSION} \
    && npm cache clean --force

# Hermes (Python) di /opt, di luar home directory yang nanti dipasang PVC
RUN python3 -m venv /opt/hermes \
    && /opt/hermes/bin/pip install --no-cache-dir "hermes-agent${HERMES_VERSION:+==$HERMES_VERSION}" \
    && ln -s /opt/hermes/bin/hermes /usr/local/bin/hermes

# Multica CLI + daemon
RUN curl -fsSL https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh | bash \
    && M="$(command -v multica || find / -xdev -type f -name multica -perm -u+x 2>/dev/null | head -n1)" \
    && [ -n "$M" ] \
    && { [ "$M" = /usr/local/bin/multica ] || install -m 0755 "$M" /usr/local/bin/multica; }

# Build gagal jika ada CLI yang tidak terpasang
RUN for c in multica opencode claude codex openclaw hermes; do \
      command -v "$c" >/dev/null || { echo "CLI hilang: $c"; exit 1; }; \
      printf '%s: ' "$c"; "$c" --version 2>&1 | head -n1 || true; \
    done

RUN useradd -m -u 1001 -s /bin/bash agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
