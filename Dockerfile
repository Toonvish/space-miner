# syntax=docker/dockerfile:1.7
# =============================================================================
# Space Miner — game server + built web client in one image, one port (8080).
#
#   docker build -t space-miner .
#   docker run -p 8080:8080 -v space-miner-data:/data space-miner
#
# The world save lives in /data (keep it on a volume across deploys).
#
# Multi-arch (linux/amd64 + linux/arm64, see .github/workflows/release.yml). The
# client bundle is built on the BUILD platform: its output is portable JS/assets,
# so the arm64 image does not pay for a Vite build under QEMU. The runtime stage
# only installs the (pure JS) production dependencies for the target.
# =============================================================================

ARG BUN_VERSION=1.4.4

# client-build: typecheck client + server and build dist/ (always native on the runner)
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-debian AS client-build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# runtime: production dependencies, the server, the shared code and the built client
FROM oven/bun:${BUN_VERSION}-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=client-build /app/dist ./dist
COPY server ./server
COPY shared ./shared
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
