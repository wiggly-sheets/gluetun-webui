# ---- Build stage ----
FROM node:26-alpine@sha256:b9b5737eabd423ba73b21fe2e82332c0656d571daf1ebf19b0f89d0dd0d3ca93 AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-fund

# ---- Final stage ----
FROM node:26-alpine@sha256:b9b5737eabd423ba73b21fe2e82332c0656d571daf1ebf19b0f89d0dd0d3ca93
WORKDIR /app
ENV NODE_ENV=production

# gcompat: glibc compat for speedtest binary (Alpine uses musl)
# speedtest: Ookla CLI for optional speed test feature
ARG SPEEDTEST_VERSION=1.2.0
ARG SPEEDTEST_SHA256_X86_64=5690596c54ff9bed63fa3732f818a05dbc2db19ad36ed68f21ca5f64d5cfeeb7
ARG SPEEDTEST_SHA256_AARCH64=3953d231da3783e2bf8904b6dd72767c5c6e533e163d3742fd0437affa431bd3
RUN apk add --no-cache gcompat curl && \
    ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) SHA256="$SPEEDTEST_SHA256_X86_64" ;; \
      aarch64) SHA256="$SPEEDTEST_SHA256_AARCH64" ;; \
      *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL -o /tmp/speedtest.tgz "https://install.speedtest.net/app/cli/ookla-speedtest-${SPEEDTEST_VERSION}-linux-${ARCH}.tgz" && \
    echo "$SHA256  /tmp/speedtest.tgz" | sha256sum -c - && \
    tar -xzf /tmp/speedtest.tgz -C /usr/local/bin speedtest && \
    chmod +x /usr/local/bin/speedtest && \
    rm /tmp/speedtest.tgz && \
    apk del curl

# Add non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# /data: writable mount point for persistent data (e.g. speedtest history)
RUN mkdir -p /data && chown -R appuser:appgroup /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package-lock.json ./
COPY package.json ./
COPY src/ ./src/

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "src/server.js"]
