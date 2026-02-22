#!/usr/bin/env node
/**
 * Standalone CLI / Docker entry point.
 *
 * Reads configuration from environment variables and command-line arguments,
 * then starts the proxy server. No MWC-specific code lives here.
 *
 * Supported env vars:
 *   PORT                   — listen port (default 2344, overridden by argv[2])
 *   URL_ROOT               — API path prefix (default /api/vm/net)
 *   ALLOW_ORIGIN           — CORS origin header value (default *)
 *   MAX_CONNECTIONS_PER_IP — per-IP connection cap (default 5)
 *   ACCESS_CODE            — secret for /connections endpoint
 *   SIGNAL_SERVER_URL      — signal server URL (default https://signal.mcraft.fun)
 *   SIGNAL_DESCRIPTION     — description forwarded to signal server
 *   SIGNAL_DOMAIN          — domain forwarded to signal server
 *   DISABLE_SIGNAL         — set to 1 or true to disable signal server reporting
 */

import path from 'path'
import https from 'https'
import type http from 'http'
import fs from 'fs'
import express from 'express'
import compression from 'compression'
import { createProxyMiddleware } from './index'

if (fs.existsSync(path.join(__dirname, './env.js'))) {

    require('./env.js')
}

const app = express()

const keyFile = path.join(__dirname, './key.pem')
let httpsServer: https.Server | http.Server | undefined
if (fs.existsSync(keyFile)) {
    const key = fs.readFileSync(keyFile)
    const cert = fs.readFileSync(path.join(__dirname, './cert.pem'))
    httpsServer = https.createServer({ key, cert }, app)
}

app.use(compression())

const logsDir = path.join(__dirname, 'logs')
fs.mkdirSync(logsDir, { recursive: true })
const accessFile = fs.createWriteStream(path.join(logsDir, 'access.log'), { flags: 'a' })

const urlRoot = process.env.URL_ROOT ?? '/api/vm/net'

const portArg = process.argv.indexOf('--port')
const port = process.argv[2] && !process.argv[2].startsWith('-')
    ? process.argv[2]
    : portArg === -1
      ? process.env.PORT ?? 2344
      : process.argv[portArg + 1]

app.use(
    createProxyMiddleware({
        allowOrigin: process.env.ALLOW_ORIGIN ?? '*',
        server: httpsServer,
        urlRoot,
        log(line) {
            const ts = new Date().toISOString().replace('T', ' ').split('.')[0]
            accessFile.write(`[${ts}] ${line}\n`)
        },
        allowOriginApp: true,
        maxConnectionsPerIp: process.env.MAX_CONNECTIONS_PER_IP ? Number(process.env.MAX_CONNECTIONS_PER_IP) : 5,
        signal:
            process.env.DISABLE_SIGNAL === '1' || process.env.DISABLE_SIGNAL?.toLowerCase() === 'true'
                ? undefined
                : {
                      serverUrl: process.env.SIGNAL_SERVER_URL ?? 'https://signal.mcraft.fun',
                      description: process.env.SIGNAL_DESCRIPTION,
                      domain: process.env.SIGNAL_DOMAIN,
                      listenPort: Number(port),
                  },
    }),
)

app.use(express.static(path.join(__dirname, './dist')))

;(httpsServer ?? app).listen(port, () => {
    console.log(`Proxy server listening on port ${port}`)
    setInterval(() => {})
})
