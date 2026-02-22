# Open Source Minecraft Web Proxy
# Build stage: compile TypeScript
FROM oven/bun:1 AS builder
WORKDIR /usr/src/app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# Release stage: run the proxy
FROM node:22-slim AS release
WORKDIR /usr/src/app

COPY package.json ./
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/node_modules ./node_modules

EXPOSE 2344/tcp

ENV PORT=2344
CMD ["node", "dist/app.js"]
