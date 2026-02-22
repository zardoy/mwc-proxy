<div align="center">
  <img src="logo.png" width="200" alt="mwc-proxy" />
</div>

# Minecraft Web Client Proxies

This repository contains the **WebSocket proxy** for making Minecraft servers accessible to web clients.

## MWC proxy

- **WebSocket-based Minecraft proxy** — browser clients connect via WebSocket; the proxy forwards to Java Minecraft servers (TCP).
- **Microsoft/Mojang authentication** — makes it possible to connect to official Minecraft servers!
- **Connection management & rate limiting** — per-IP limits, configurable caps.
- **SOCKS proxy support** — optional SOCKS5 upstream for outbound connections.
- **Signal Server integration** — reports to a central server (e.g. signal.mcraft.fun): description, domain, players, CPU, RAM; heartbeat every 10 seconds.
- **Prometheus metrics** — built-in metrics and optional `express-prom-bundle` middleware.
- **Callback interface for extensions** — e.g. custom connection routing, connection limits, banned origins.

[Deploy with a single line of command RIGHT NOW](https://github.com/zardoy/minecraft-everywhere)

## Docker Compose Deploy

The recommended way to run an instance is with **Docker Compose**, using the example that includes automatic updates via Watchtower and an optional **env.js** mount for config overrides:

**[docker-compose.example.yml](docker-compose.example.yml)**

Copy it to `docker-compose.yml`, create `env.js` if you want external config (see [config overrides](#config-overrides)), then:

```sh
docker compose up -d
```

Images are published to GitHub Container Registry (`ghcr.io/zardoy/mwc-proxy`). The compose file uses a Watchtower service to keep the image updated. The access log is rotated at 100MB and mounted at `./logs` so it is preserved on the host. You can override the entrypoint (e.g. to apply `tc` egress rate limiting) by mounting your own script and setting `entrypoint: ["/bin/sh", "/entrypoint.sh"]`; your script should end with `exec node dist/app.js`.

## Using this package as NPM library

Install:

```sh
pnpm add mwc-proxy
```

Build the project (if you use the source), then:

```js
const { createProxyMiddleware } = require('mwc-proxy')
// or
import { createProxyMiddleware } from 'mwc-proxy'
```

Use `createProxyMiddleware(options)` with Express. See `src/api.ts` for `ProxyMiddlewareOptions` (e.g. `urlRoot`, `allowOrigin`, `maxConnectionsPerIp`, `signal`, `to` for host/port allowlist).

CLI entry (standalone server):

```sh
npx minecraft-web-proxy
# or
npx mwp
```

Environment variables: `PORT`, `URL_ROOT`, `ALLOW_ORIGIN`, `MAX_CONNECTIONS_PER_IP`, `ACCESS_CODE`, `SIGNAL_SERVER_URL`, `SIGNAL_DESCRIPTION`, `SIGNAL_DOMAIN`.

---

## Config overrides

You can override the proxy API options (deep-merge) in two ways:

1. **env.js** — Mount or place `env.js` so the CLI loads it, then set `global.MWC_PROXY_CONFIG_OVERRIDES = { ... }` with any [ProxyMiddlewareOptions](src/api.ts) overrides.
2. **CONFIG_OVERRIDES_JSON** — Set the env var to a JSON string, e.g. `CONFIG_OVERRIDES_JSON='{"metricsEndpoint":false}'`.

Useful for toggling metrics endpoint, auth limits, single-server defaults, etc., without changing code.

---

For more information and the web client itself, visit the [main repo](https://github.com/zardoy/prismarine-web-client/).

---

## Bun WebSocket Proxy (standalone script)

For a minimal setup that only bridges WebSocket ↔ TCP (no auth, no Signal Server), you can use the Bun script so your Minecraft server accepts WebSocket connections.

Connect in the client with something like:

```sh
wss://ws.your-domain.com
```

1. **Install [Bun](https://bun.sh/docs/installation)**
2. **Copy [`ws-proxy.ts`](https://github.com/zardoy/mwc-proxy/blob/main/bun/ws-proxy.ts) to your server** (if present in this repo) and edit:
   - `YOUR_SERVER_HOST` and `YOUR_SERVER_PORT` — your Minecraft server.
   - `THIS_PUBLIC_IP` — public address used for redirects.
3. **Run with PM2** (or systemctl / another process manager):
   ```sh
   pm2 start "bun run ws-proxy.ts" --name bun-proxy
   ```

### Limitations

- Not usable on hosters that block SSH or extra ports (e.g. Aternos).
- Intended to run on the **same server** as the Minecraft server to avoid extra latency; otherwise consider using MWC proxy servers.
