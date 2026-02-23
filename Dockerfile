# Open Source Minecraft Web Proxy
# Build stage: compile TypeScript
FROM oven/bun:1 AS builder
WORKDIR /usr/src/app

COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

# Release stage: run the proxy
FROM node:22-slim AS release
WORKDIR /usr/src/app

COPY package.json ./
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Default entrypoint script; override by mounting your own (e.g. for tc rate limiting)
RUN echo '#!/bin/sh\nexec node dist/app.js' > /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 2344/tcp

ENV PORT=2344
ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
