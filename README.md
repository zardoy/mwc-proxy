# Minecraft Web Client Proxies

This repository contains only the **WebSocket proxy** for making Minecraft servers accessible to web clients. If you are looking for the Node.js script for hosting a normal proxy server so you can connect to any normal servers with it, please refer to the main repository: [prismarine-web-client](https://github.com/zardoy/prismarine-web-client/). The main repo provides a ready-to-use `server.js` in the zip attachment of the latest release (see the [releases page](https://github.com/zardoy/prismarine-web-client/releases)).

---

## Bun WebSocket Proxy

This script allows your Minecraft server to accept WebSocket connections, making it browser-friendly for web-based Minecraft clients. It acts as a bridge between a web client and your Minecraft server by forwarding WebSocket messages to a TCP connection and vice versa without any modifications.

### Installation & Usage

1. **Install Bun**
   - Follow the official Bun installation guide: [https://bun.sh/docs/installation](https://bun.sh/docs/installation)

2. **Copy [`ws-proxy.ts`](https://github.com/zardoy/mwc-proxy/blob/main/bun/ws-proxy.ts) to your server**

3. **Edit `ws-proxy.ts`**
   - Set `YOUR_SERVER_HOST` and `YOUR_SERVER_PORT` to your Minecraft server's IP and port.
   - Set `THIS_PUBLIC_IP` to your public server address (used for redirects).

4. **Make it keep running with PM2**
   - See the Bun guide for using PM2: [https://bun.sh/guides/ecosystem/pm2](https://bun.sh/guides/ecosystem/pm2)
   - Example:
     ```sh
     pm2 start "bun run ws-proxy.ts" --name bun-proxy
     ```
    (note that you can also use systemctl or any another process manager)

### ⚠️ Important Notes & Limitations

> **Warning**
> - This script cannot be used on Minecraft hosters that do not allow SSH access or opening extra ports (e.g., Aternos), even if you use a Spigot plugin that does the same thing. These hosters restrict custom server-side processes and port usage.
> - This proxy only makes sense to use if it runs on the **same server** as your Minecraft server. Running it on a different server will introduce additional ping/latency, and it's generally easier to use the MWC proxy servers instead.

---

For more information and the web client itself, visit the [main repo](https://github.com/zardoy/prismarine-web-client/).
