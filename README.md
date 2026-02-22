<div align="left">
  <img src="logo.png" width="200" alt="mwc-proxy" />
</div>

# Minecraft Web Client Proxies

This repository contains the **WebSocket proxy** for making Minecraft servers accessible to web clients.

---

## MWC proxy (this repo)

- **WebSocket-based Minecraft proxy** — browser clients connect via WebSocket; the proxy forwards to Java Minecraft servers (TCP).
- **Microsoft/Mojang authentication** — makes it possible to connect to official Minecraft servers!
- **Connection management & rate limiting** — per-IP limits, configurable caps.
- **SOCKS proxy support** — optional SOCKS5 upstream for outbound connections.
- **Signal Server integration** — reports to a central server (e.g. signal.mcraft.fun): description, domain, players, CPU, RAM; heartbeat every 10 seconds.
- **Prometheus metrics** — built-in metrics and optional `express-prom-bundle` middleware.
- **Callback interface for extensions** — e.g. custom connection routing, connection limits, banned origins.


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

## Docker (auto-updated images)

Images are published to GitHub Container Registry and updated on releases.

```sh
docker pull ghcr.io/zardoy/mwc-proxy:latest
# or a specific version
docker pull ghcr.io/zardoy/mwc-proxy:0.1.0
```

Run:

```sh
docker run -p 2344:2344 -e PORT=2344 ghcr.io/zardoy/mwc-proxy
```

The container exposes port **2344** by default. Override with `PORT` or pass `--port` to the app.

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
