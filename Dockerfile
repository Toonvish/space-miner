# Space Miner — game server + built web client on one port.
#   docker build -t space-miner .
#   docker run -p 8080:8080 -v space-miner-data:/data space-miner
# The world save lives in /data (mount a volume to keep it across deploys).

FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server/index.ts"]
