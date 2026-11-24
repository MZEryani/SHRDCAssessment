# syntax=docker/dockerfile:1.7

# Stage 1: Build pinned upstream Open Industry Project (OIP) static app + keep CLI validators
FROM node:24-bookworm-slim AS oip-builder

ARG OIP_REPO=https://github.com/Open-Industry-Project/Open-Industry-Project.git
ARG OIP_COMMIT=0afba0117eaa19589b4ae9c66412ae29c0e664a8

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /oip
RUN git init \
  && git remote add origin "${OIP_REPO}" \
  && git fetch --depth 1 origin "${OIP_COMMIT}" \
  && git checkout FETCH_HEAD \
  && npm ci \
  && npm run build \
  && rm -rf .git

# Stage 2: Build Demo Portal web frontend (Vite + React + Tailwind CSS + Lucide)
FROM node:24-bookworm-slim AS portal-web-builder

WORKDIR /portal-web
COPY portal/web/package.json portal/web/package-lock.json ./
RUN npm ci
COPY portal/web/ ./
RUN npm run build

# Stage 3: Demo Portal runtime (Node 24 + STruC++ v0.8.0 + OpenCode v2.4.0 + git worktrees + OIP)
FROM node:24-bookworm-slim AS runtime

ARG TARGETARCH
ARG STRUCPP_VERSION=0.8.0
ARG STRUCPP_SHA256_AMD64=cf2b919620ca389186d9cc5be293f7d655511c183d1b49a77220ec60e0584e71
ARG STRUCPP_SHA256_ARM64=0d87c13ad2911fec9300a63acf290c0e3164290fdc235c39ea1dfe0399ed9e91
ARG OPENCODE_VERSION=2.4.0
ARG OPENCODE_SHA256_AMD64=66cf6adeb02fbfe9ccbb1f6497fcf46cecf2d299a1dc3a7a32e01ea30ff20201
ARG OPENCODE_SHA256_ARM64=fed468566215fd38b26abab99018240c0d30772d3f45aee25621664ceff7e360

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    g++ \
    git \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pinned, SHA-256-verified STruC++ v0.8.0
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) STRUCPP_ARCH="x64"; STRUCPP_SHA="${STRUCPP_SHA256_AMD64}" ;; \
    arm64) STRUCPP_ARCH="arm64"; STRUCPP_SHA="${STRUCPP_SHA256_ARM64}" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  URL="https://github.com/Autonomy-Logic/STruCpp/releases/download/v${STRUCPP_VERSION}/strucpp-linux-${STRUCPP_ARCH}.tar.gz"; \
  curl -fsSL "${URL}" -o /tmp/strucpp.tar.gz; \
  echo "${STRUCPP_SHA}  /tmp/strucpp.tar.gz" | sha256sum -c -; \
  mkdir -p /app/.tools/strucpp; \
  tar -xzf /tmp/strucpp.tar.gz -C /app/.tools/strucpp; \
  rm -f /tmp/strucpp.tar.gz; \
  if [ ! -x /app/.tools/strucpp/strucpp/strucpp ]; then \
    if [ -x /app/.tools/strucpp/strucpp ]; then \
      mkdir -p /tmp/strucpp-move; \
      mv /app/.tools/strucpp/* /tmp/strucpp-move/; \
      mv /tmp/strucpp-move /app/.tools/strucpp/strucpp; \
    fi; \
  fi; \
  test -x /app/.tools/strucpp/strucpp/strucpp; \
  test -d /app/.tools/strucpp/strucpp/runtime/include

# Install pinned, SHA-256-verified OpenCode v2.4.0
RUN set -eux; \
  case "${TARGETARCH}" in \
    amd64) OC_ASSET="opencode-linux-x64-baseline.tar.gz"; OC_SHA="${OPENCODE_SHA256_AMD64}" ;; \
    arm64) OC_ASSET="opencode-linux-arm64.tar.gz"; OC_SHA="${OPENCODE_SHA256_ARM64}" ;; \
    *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  URL="https://opencode.ai/files/bin/${OPENCODE_VERSION}/${OC_ASSET}"; \
  curl -fsSL "${URL}" -o /tmp/opencode.tar.gz; \
  echo "${OC_SHA}  /tmp/opencode.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin; \
  rm -f /tmp/opencode.tar.gz; \
  chmod +x /usr/local/bin/opencode; \
  opencode --version

# Copy repository source (clean via .dockerignore), built OIP bundle, and built Demo Portal SPA
COPY . /app
COPY --from=oip-builder /oip /app/Open-Industry-Project
COPY --from=portal-web-builder /portal-web/dist /app/portal/web/dist

# Initialize git repository for Task 2 parallel git worktrees + create persistent Cells volume mountpoint
RUN mkdir -p /data/cells \
  && git init -b main \
  && git config user.name "SHRDC Demo Portal" \
  && git config user.email "demo-portal@local" \
  && git add -A \
  && git commit -m "chore: container baseline for parallel worktrees" \
  && chown -R node:node /app /data/cells

USER node

ENV HOST=0.0.0.0 \
    PORT=3000 \
    MODBUS_LISTEN_HOST=0.0.0.0 \
    MODBUS_LISTEN_PORT=5020 \
    PORTAL_CELLS_DIR=/data/cells \
    OIP_DIST_DIR=/app/Open-Industry-Project/dist

EXPOSE 3000 5020

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.status === 401 || r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "portal/server.mjs"]
