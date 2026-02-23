#!/usr/bin/env node
/**
 * Standalone CLI / Docker entry point.
 *
 * Reads configuration from environment variables, optional env.js (can set global.MWC_PROXY_CONFIG_OVERRIDES),
 * and CONFIG_OVERRIDES_JSON env var, then starts the proxy server. Options are deep-merged.
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
 *   CONFIG_OVERRIDES_JSON  — optional JSON string; deep-merged over createProxyMiddleware options
 *   LOG_MAX_BYTES         — max access log file size in bytes; when exceeded, log is truncated (default 100MB)
 *
 * In env.js you can set global.MWC_PROXY_CONFIG_OVERRIDES (object) for the same deep-merge behavior.
 */

import path from 'path'
import https from 'https'
import type http from 'http'
import fs from 'fs'
import express from 'express'
import compression from 'compression'
import { createProxyMiddleware, ProxyMiddlewareOptions } from './index'

function deepMerge<T extends object>(target: T, source: Partial<T>): T {
    const out = { ...target }
    for (const key of Object.keys(source) as (keyof T)[]) {
        const s = source[key]
        if (s === undefined) continue
        const t = (target as Record<string, unknown>)[key as string]
        if (
            s !== null &&
            typeof s === 'object' &&
            !Array.isArray(s) &&
            t !== null &&
            typeof t === 'object' &&
            !Array.isArray(t)
        ) {
            ;(out as Record<string, unknown>)[key as string] = deepMerge(
                t as object,
                s as object,
            )
        } else {
            ;(out as Record<string, unknown>)[key as string] = s
        }
    }
    return out
}

function getConfigOverrides(): Record<string, unknown> {
    const fromGlobal = (global as { MWC_PROXY_CONFIG_OVERRIDES?: Record<string, unknown> })
        .MWC_PROXY_CONFIG_OVERRIDES
    if (fromGlobal && typeof fromGlobal === 'object') return fromGlobal
    const fromEnv = process.env.CONFIG_OVERRIDES_JSON
    if (fromEnv) {
        try {
            return JSON.parse(fromEnv) as Record<string, unknown>
        } catch {
            return {}
        }
    }
    return {}
}

const envJsPath = path.join(__dirname, './env.js')
if (fs.existsSync(envJsPath)) {
    require(envJsPath)
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

const accessLogPath = path.join(logsDir, 'access.log')
const LOG_MAX_BYTES = process.env.LOG_MAX_BYTES ? Number(process.env.LOG_MAX_BYTES) : 100 * 1024 * 1024 // 100MB default
const accessLog = { stream: fs.createWriteStream(accessLogPath, { flags: 'a' }) }

function maybeRotateAccessLog() {
    if (LOG_MAX_BYTES <= 0) return
    try {
        const stat = fs.statSync(accessLogPath)
        if (stat.size > LOG_MAX_BYTES) {
            accessLog.stream.end()
            fs.truncateSync(accessLogPath, 0)
            accessLog.stream = fs.createWriteStream(accessLogPath, { flags: 'a' })
        }
    } catch (error) {
        console.error('Error rotating access log:', error)
    }
}

const urlRoot = process.env.URL_ROOT ?? '/api/vm/net'

const portArg = process.argv.indexOf('--port')
const port = process.argv[2] && !process.argv[2].startsWith('-')
    ? process.argv[2]
    : portArg === -1
      ? process.env.PORT ?? 2344
      : process.argv[portArg + 1]

const baseOptions: ProxyMiddlewareOptions = {
    allowOrigin: process.env.ALLOW_ORIGIN ?? '*',
    server: httpsServer,
    urlRoot,
    log(line: string) {
        maybeRotateAccessLog()
        const ts = new Date().toISOString().replace('T', ' ').split('.')[0]
        accessLog.stream.write(`[${ts}] ${line}\n`)
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
}
const overrides = getConfigOverrides()
const options = Object.keys(overrides).length > 0 ? deepMerge(baseOptions, overrides as Partial<typeof baseOptions>) : baseOptions
app.use(createProxyMiddleware(options))

app.use(express.static(path.join(__dirname, './dist')))

;(httpsServer ?? app).listen(port, () => {
    console.log(`Proxy server listening on port ${port}`)
    setInterval(() => {})
})
