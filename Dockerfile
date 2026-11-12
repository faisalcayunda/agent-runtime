FROM node:24-bookworm-slim

RUN node --version && npm --version

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCLAW_VERSION=latest
# pi: paket lama @mariozechner/pi-coding-agent deprecated (berhenti di 0.73.1); penggantinya @earendil-works, dikunci ke versi pasti
ARG PI_VERSION=1.5.1
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

# --- uv + lokasi Python terkelola yang bisa dibaca semua user ---
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL=/usr/local/bin sh \
    && uv --version

# --- Hermes: commit dikunci (di atas CLI_REFRESH supaya tidak ikut rebuild tiap hari), Python 3.14 + dependensi persis dari uv.lock ---
RUN mkdir -p /opt/hermes/src && cd /opt/hermes/src \
    && git init -q \
    && git remote add origin https://github.com/NousResearch/hermes-agent.git \
    && git fetch -q --depth 1 origin "${HERMES_REF}" \
    && git checkout -q FETCH_HEAD \
    && git submodule update --init --recursive --depth 1 \
    && git rev-parse HEAD > /opt/hermes/COMMIT \
    && uv python install 3.14 \
    && UV_PROJECT_ENVIRONMENT=/opt/hermes/venv \
         uv sync --frozen --python 3.14 --extra all --no-dev \
    && ln -sf /opt/hermes/venv/bin/hermes /usr/local/bin/hermes \
    && ln -sf /opt/hermes/venv/bin/hermes-acp /usr/local/bin/hermes-acp \
    && chmod -R a+rX /opt/uv-python /opt/hermes \
    && hermes --version \
    && hermes config --help >/dev/null \
    && echo "hermes: dependensi lengkap"

# --- RTK: dikunci ke v1.1.0 (binary rilis resmi, sha256 dicek) ---
# v1.2.0+ (musl x86_64) mati SIGILL di CPU tanpa AVX (home-server i3-2100): rtk-ai/rtk#5043.
# Naikkan RTK_VERSION + RTK_SHA256 hanya setelah isu itu beres dan `rtk --version` terbukti jalan di home-server.
ARG RTK_VERSION=v1.1.0
ARG RTK_SHA256=9454ad1b9489daa57ab0a9f4ebe2faaf4dc82b8a0f26c9e5135151abd7c9378d
RUN mkdir /tmp/rtk && cd /tmp/rtk \
    && curl -fsSL -o rtk.tgz \
         "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/rtk-x86_64-unknown-linux-musl.tar.gz" \
    && echo "${RTK_SHA256}  rtk.tgz" | sha256sum -c - \
    && tar -xzf rtk.tgz \
    && install -m 0755 "$(find . -type f -name rtk | head -n1)" /usr/local/bin/rtk \
    && cd / && rm -rf /tmp/rtk

# --- ffmpeg untuk Gremio: runner mengambil frame dari video WhatsApp (Claude tidak bisa membaca video). Layer sendiri, di bawah Hermes/RTK dan di atas
# cache-bust harian, jadi layer yang mahal tidak ikut rebuild. ---
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && ffmpeg -version | head -n1

# --- Cache-bust harian untuk semua CLI yang mengambil "latest" ---
# Workflow mengisi CLI_REFRESH dengan tanggal UTC. ARG yang berubah membatalkan cache semua layer
# sesudahnya, jadi layer sistem/uv/Hermes (yang dikunci) harus ada DI ATAS baris ini.
ARG CLI_REFRESH=manual
RUN echo "CLI refresh: ${CLI_REFRESH}"

# --- CLI berbasis Node (paket npm resmi) + pnpm untuk build bridge dsh ---
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      openclaw@${OPENCLAW_VERSION} \
      @earendil-works/pi-coding-agent@${PI_VERSION} \
      @deepseek-ai/dsh@${DSH_VERSION} \
      pnpm \
    && npm cache clean --force

# --- OpenCode dari installer resmi ---
RUN curl -fsSL https://opencode.ai/install | bash \
    && O="$(command -v opencode || find / -xdev -type f -name opencode -perm -u+x 2>/dev/null | head -n1)" \
    && [ -n "$O" ] \
    && { [ "$O" = /usr/local/bin/opencode ] || install -m 0755 "$O" /usr/local/bin/opencode; }

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

# --- Aset kualitas agent: pedoman Karpathy + skill Matt Pocock ---
RUN mkdir -p /opt/agent-assets \
    && curl -fsSL -o /opt/agent-assets/AGENTS.md \
         https://raw.githubusercontent.com/multica-ai/andrej-karpathy-skills/main/CLAUDE.md \
    && git clone --depth 1 https://github.com/mattpocock/skills.git /opt/agent-assets/mattpocock-skills \
    && git -C /opt/agent-assets/mattpocock-skills rev-parse HEAD > /opt/agent-assets/mattpocock-skills.COMMIT \
    && rm -rf /opt/agent-assets/mattpocock-skills/.git \
    && chmod -R a+rX /opt/agent-assets

# --- Build gagal jika ada CLI yang tidak terpasang atau rusak ---
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN for c in multica opencode claude codex openclaw hermes hermes-acp pi dsh rtk uv gh shellcheck; do \
      command -v "$c" >/dev/null || { echo "CLI hilang: $c"; exit 1; }; \
      v="$("$c" --version 2>&1)" || { echo "CLI rusak: $c: $v"; exit 1; }; \
      printf '%s: %s\n' "$c" "${v%%$'\n'*}"; \
    done \
    && echo "hermes commit: $(cat /opt/hermes/COMMIT)" \
    && echo "dsh bridge commit: $(cat /opt/dsh-multica-runtime/COMMIT)" \
    && echo "skill Matt Pocock: $(find /opt/agent-assets/mattpocock-skills -name SKILL.md | wc -l) skill"

# =====================================================================================================
# Gremio (wa-agent, PLAN phase 3): semua sebagai root, sebelum USER agent, jadi uid 1001 tidak bisa mengubahnya.
# Pod Multica tidak membaca /opt/wa-agent, /opt/agent-assets/skills, /opt/agent-assets/agents (entrypoint.sh hanya
# membaca AGENTS.md dan mattpocock-skills). Semua sumber dikunci ke SHA/versi pasti; naik versi = ganti ARG.
# =====================================================================================================
# antislop (github.com/miqdadbadjuber/anti-slop, main per 2026-11-11), claude-config (main per 2026-11-09),
# REA: paket npm dan skill-nya dari tag git rea-agents-6.8.0 yang sama (bukan `npx skills add`: tidak menulis ke home).
ARG ANTISLOP_SHA=4520786d3dff09eb295a2c563c7fab50063f00fb
ARG CLAUDE_CONFIG_SHA=9f7c25e15cdac924efbf7135aea879602dfe53a6
ARG REA_VERSION=6.8.0
ARG REA_SKILL_SHA=160d821ac9a0310afcb8d1fc427862dd6508add5
# TypeSafe skill (typesafe-ai/skills, main per 2026-11-12; owner added it 2026-11-12, plain skill dir, no plugin)
ARG TYPESAFE_SHA=302eea662c54bca6730873fe245bec1d69ebc23d

# --- wa-agent: dependensi dulu (cache), lalu kode. Hanya yang dibutuhkan runtime (bukan test/, spike/, node_modules lokal). ---
COPY wa-agent/package.json wa-agent/package-lock.json wa-agent/.npmrc /opt/wa-agent/
RUN cd /opt/wa-agent && npm ci --omit=dev && npm cache clean --force
COPY wa-agent/bin /opt/wa-agent/bin
COPY wa-agent/build /opt/wa-agent/build
COPY wa-agent/config /opt/wa-agent/config
COPY wa-agent/hooks /opt/wa-agent/hooks
COPY wa-agent/mcp /opt/wa-agent/mcp
COPY wa-agent/src /opt/wa-agent/src

# --- REA (morluto/rea): npm -g tidak memaksa engines, jadi Node >= 24.22.1 dicek sendiri ---
RUN node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if(!(a>24||(a===24&&(b>22||(b===22&&c>=1))))){console.error("REA butuh Node >= 24.22.1, ada "+process.versions.node);process.exit(1)}' \
    && npm install -g "rea-agents@${REA_VERSION}" \
    && npm cache clean --force \
    && rea --version

# --- Skill: tepat lima aset (mattpocock dari manifest plugin, antislop enam dir, REA, TypeSafe) ke /opt/agent-assets/skills ---
RUN T="$(mktemp -d)" \
    && /opt/wa-agent/build/fetch-sha.sh https://github.com/miqdadbadjuber/anti-slop "${ANTISLOP_SHA}" "$T/as" skills \
    && /opt/wa-agent/build/fetch-sha.sh https://github.com/morluto/rea "${REA_SKILL_SHA}" "$T/rea" .agents/skills/reverse-engineer-anything \
    && /opt/wa-agent/build/fetch-sha.sh https://github.com/typesafe-ai/skills "${TYPESAFE_SHA}" "$T/ts" skills/typesafe-ai \
    && /opt/wa-agent/build/assemble-skills.sh /opt/agent-assets/mattpocock-skills "$T/as" \
         "$T/rea/.agents/skills/reverse-engineer-anything" "$T/ts/skills/typesafe-ai" /opt/agent-assets/skills \
    && { echo "antislop ${ANTISLOP_SHA}"; echo "rea-skill ${REA_SKILL_SHA} (rea-agents ${REA_VERSION})"; echo "typesafe ${TYPESAFE_SHA}"; \
         echo "mattpocock $(cat /opt/agent-assets/mattpocock-skills.COMMIT)"; } > /opt/agent-assets/skills.COMMITS \
    && rm -rf "$T"

# --- Subagent dari claude-config: buang 7, edit 2, strip penunjuk ke skill/rules yang tidak ada, lalu cek (gagal = build gagal) ---
RUN T="$(mktemp -d)" \
    && /opt/wa-agent/build/fetch-sha.sh https://github.com/faisalcayunda/claude-config "${CLAUDE_CONFIG_SHA}" "$T/cc" agents scripts/secret_scan.py \
    && mkdir -p /opt/agent-assets/agents \
    && cp "$T"/cc/agents/*.md /opt/agent-assets/agents/ \
    && node /opt/wa-agent/build/agents.mjs strip /opt/agent-assets/agents /opt/agent-assets/skills \
    && install -m 0644 "$T/cc/scripts/secret_scan.py" /opt/wa-agent/hooks/secret_scan.py \
    && python3 -I /opt/wa-agent/hooks/secret_scan.py --selftest \
    && echo "claude-config ${CLAUDE_CONFIG_SHA}" > /opt/agent-assets/agents.COMMIT \
    && rm -rf "$T"

# --- CLAUDE.md worker: pedoman Karpathy + aturan wa (tanpa blok "Push your work" milik Multica) ---
RUN { cat /opt/agent-assets/AGENTS.md; printf '\n'; cat /opt/wa-agent/config/claude-wa.md; } > /opt/wa-agent/config/CLAUDE.md \
    && chmod 0755 /opt/wa-agent/bin/*.sh /opt/wa-agent/build/*.sh \
    && chmod -R a+rX,go-w /opt/wa-agent /opt/agent-assets \
    && bash -n /opt/wa-agent/bin/worker-boot.sh \
    && echo "wa-agent: $(ls /opt/agent-assets/skills | wc -l) skill, $(ls /opt/agent-assets/agents | wc -l) agent"

RUN useradd -m -u 1001 -s /bin/bash agent
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh
RUN bash -n /usr/local/bin/entrypoint.sh

USER agent
ENV HOME=/home/agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
