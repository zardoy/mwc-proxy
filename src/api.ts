
import net, { isIPv4 } from 'net'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import dns from 'dns'
import express from 'express'
import expressWs from 'express-ws'
import { SocksClient } from 'socks'
import registerAuthEndpoint from './authEndpoint'
import { metricsMiddleware, updateMetrics } from './metrics'
import { SignalClient } from './signal-client'

// Import version from package.json
const packageJson = require('../package.json')
const VERSION = packageJson.version

function generateToken() {
    return crypto.randomBytes(32).toString('hex')
}

function checkTo(allowed, requested) {
    if (!Array.isArray(allowed)) {
        allowed = [allowed]
    }

    // For each rule
    for (const to of allowed) {
        if ((to.host === requested.host || !to.host) && (to.port === requested.port || !to.port)) {
            return !to.blacklist
        }
    }

    // No rule found, access denied
    return false
}

export type MwcCallbacks = {
    log?: (line: string) => void
    getConnectData?: () => Record<string, any>
    onConnectionChange?: (count: number) => void
    getTooManyConnectionsMessage?: (currentCount: number, limit: number) => string
    getBannedOriginMessage?: (origin: string) => string
    handleConnectionRequest?: (req: any, res: any, handler: (proxies?: string[], timeLimit?: number) => Promise<void>) => Promise<boolean>
}

export type ProxyMiddlewareOptions = {
    onPing?: (req: any) => void
    log?: boolean | ((str) => any)
    urlRoot?: string
    server?: http.Server
    allowOrigin?: boolean | string
    allowOriginApp?: boolean
    maxConnectionsPerIp?: number
    mwcCallbacks?: MwcCallbacks
    https?: {
        key: string
        cert: string
    }
    to?:
        | {
              host?: string
              port?: number
              blacklist?: boolean
          }
        | Array<{
              host?: string
              port?: number
              blacklist?: boolean
          }>
    /**
     * Optional signal server integration. When provided a SignalClient is created internally
     * and reports connection counts automatically. Pass `getExtraSystemInfo` to include
     * host-level metrics (cpu/ram) from the calling environment.
     */
    signal?: {
        serverUrl?: string
        description?: string
        domain?: string
        /** When set, signal client runs a self-check (public IP + loop request to self) before reporting */
        listenPort?: number
        getExtraSystemInfo?: () => { cpuLoad?: number; ramLoad?: number }
    }
    /**
     * @default true
     */
    debugUrlEndpoint?: boolean
    /**
     * Allow connections from IPv6 addresses. When false, IPv6 clients get 403.
     * @default true
     */
    allowIPv6?: boolean
    /**
     * Expose Prometheus /metrics scrape endpoint. Metrics are always collected; set to false to hide the endpoint.
     * @default true
     */
    metricsEndpoint?: boolean
    /**
     * Enable p-auth toggle-debug endpoint (GET /toggle-debug) for prismarine-auth debug scope. String for your own endpoint.
     * @default false
     */
    authToggleDebugEndpoint?: boolean | string
    /**
     * Max concurrent auth requests from the same IP.
     * @default 2
     */
    authMaxConcurrentPerIp?: number
    /**
     * Max total concurrent auth requests (all IPs).
     * @default 5
     */
    authMaxConcurrentTotal?: number
}

export const currentState = {
    activeConnections: {} as {
        [token: string]: {
            startTime: number
            ip: string
            host: string
        }
    },
    pendingConnections: {} as {
        [requestId: string]: {
            ip: string
            startTime: number
        }
    },
    everConnected: 0,
}

function ipToNumber(ip: string): bigint {
    if (isIPv4(ip)) {
        const parts = ip.split('.')
        let result = 0
        for (const part of parts) {
            result = result * 256 + Number.parseInt(part, 10)
        }

        return BigInt(result)
    }

    // IPv6
    const parts = ip.split(':').filter(part => part !== '')
    let result = BigInt(0)
    for (const part of parts) {
        // eslint-disable-next-line no-bitwise
        result = (result << BigInt(16)) + BigInt(`0x${part}`)
    }

    return result
}

const getProxy = (proxies: string[], requestIp: string) => {
    const index = Number(ipToNumber(requestIp) % BigInt(proxies.length))
    return proxies[index]!
}

export function createProxyMiddleware(options: ProxyMiddlewareOptions = {}, connectionListener = ws => {}) {
    const startTimeFormmated = new Intl.DateTimeFormat('en', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
    }).format(new Date())
    let myLog = typeof options.log === 'function' ? options.log : () => {}
    if (options.log === true) myLog = console.log

    const app = express()
    app.use(express.urlencoded({ extended: true }))
    app.use(express.json())
    if (options.metricsEndpoint !== false) {
        app.use(metricsMiddleware as any)
    }
    const urlRoot = options.urlRoot ?? '/api/vm/net'

    let server = options.server!
    if (!server) {
        if (options.https) {
            const key = fs.readFileSync(path.join(__dirname, './key.pem'))
            const cert = fs.readFileSync(path.join(__dirname, './cert.pem'))
            server = https.createServer({
                key,
                cert,
            })
        } else {
            server = http.createServer()
        }
    }

    const sockets = {}

    if (options.allowOrigin) {
        let { allowOrigin } = options
        if (typeof options.allowOrigin !== 'string') {
            allowOrigin = options.allowOrigin ? '*' : ''
        }

        if (allowOrigin) {
            // Set Access-Control headers (CORS)
            app.use((req, res, next) => {
                if (!req.path.startsWith(urlRoot) && !options.allowOriginApp) {
                    next()
                    return
                }

                res.header('Access-Control-Allow-Origin', allowOrigin as string)

                if (req.method.toUpperCase() === 'OPTIONS') {
                    // Preflighted requests
                    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization')

                    res.header('Access-Control-Max-Age', '1_728_000') // Access-Control headers cached for 20 days
                }

                next()
            })
        }
    }

    const processConnectionRequest = async (req, res, proxies?: string[], connectionTimeLimit?: number) => {
        // Generate unique request ID for tracking pending connections
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(7)}`

        const cleanupPendingConnection = () => {
            delete currentState.pendingConnections[requestId]
        }

        try {
            const { host, port } = req.body as { host: string; port: number | string }

            if (!host || !port) {
                res.status(400).send({
                    code: 400,
                    error: 'No host and port specified',
                })
                return
            }

            if (options.to && !checkTo(options.to, { host, port })) {
                res.status(403).send({
                    code: 403,
                    error: 'Destination not allowed',
                })
                return
            }

            const { activeConnections, pendingConnections } = currentState

            const ip =
                // (req.headers['cf-connecting-ip'] as string | undefined) ||
                (req.headers['x-forwarded-for'] as string | undefined)?.split?.(',')?.[0] || req.connection?.remoteAddress || req.socket.remoteAddress || req.ip
            const isIpv6 = ip.includes(':')

            // Count both active and pending connections to prevent race condition exploitation
            const activeCount = Object.values(activeConnections).filter(c => c.ip === ip).length
            const pendingCount = Object.values(pendingConnections).filter(c => c.ip === ip).length
            const totalCount = activeCount + pendingCount

            const maxConnections = options.maxConnectionsPerIp ?? 5
            if (totalCount >= maxConnections) {
                const errorMessage = options.mwcCallbacks?.getTooManyConnectionsMessage
                    ? options.mwcCallbacks.getTooManyConnectionsMessage(totalCount, maxConnections)
                    : `Too many connections from the same IP (${totalCount}/${maxConnections}). Please wait for existing connections to close.`

                res.status(429).send({
                    code: 429,
                    error: errorMessage,
                })
                return
            }

            // Register this as a pending connection
            currentState.pendingConnections[requestId] = {
                ip,
                startTime: Date.now(),
            }

            // Clean up pending connection on response close/error
            res.on('close', cleanupPendingConnection)
            res.on('finish', cleanupPendingConnection)

            // Safety timeout: clean up pending connection after 30 seconds if still pending
            const pendingTimeout = setTimeout(() => {
                cleanupPendingConnection()
            }, 30_000)
            res.on('close', () => clearTimeout(pendingTimeout))
            res.on('finish', () => clearTimeout(pendingTimeout))

            if (isIpv6 && options.allowIPv6 === false) {
                res.status(403).send({
                    code: 403,
                    error: 'IPv6 not allowed',
                })
                return
            }

            const lang = req.headers['accept-language']?.split(',')[0]
            const logC = (addStr = '') => {
                myLog(`[C]${addStr} ${host}:${port} from ${ip} (${lang})`)
            }

            let socket: net.Socket
            const connectTimeout = 1000 * 8
            if (proxies) {
                const proxy = getProxy(proxies, ip)
                logC(` ${proxies.indexOf(proxy)}`)
                ;({ socket } = await SocksClient.createConnection({
                    proxy: parseSocksProxy(proxy),
                    command: 'connect',
                    destination: {
                        host,
                        port: Number(port),
                    },
                    timeout: connectTimeout,
                }))
            } else {
                logC()
                socket = net.connect({
                    host,
                    port: Number(port),
                    timeout: connectTimeout,
                })
            }

            socket.setTimeout(1000 * 6)
            socket.on('timeout', () => {
                cleanupPendingConnection()
                if (!res.finished) {
                    res.status(504).send({
                        code: 504,
                        error: `Connection timed out. Ensure the server ${host} is reachable and the port ${port} is open.`
                    });
                }

                socket.end()
            })
            socket.on('error', err => {
                cleanupPendingConnection()
                if (res.headersSent) return
                res.status(500).send({
                    code: 500,
                    error: err,
                })
            })
            socket.on('connect', () => {
                cleanupPendingConnection()
                if (res.headersSent) {
                    socket.end()
                    return
                }

                // Generate a token for this connection
                const token = generateToken()
                sockets[token] = socket
                currentState.everConnected++
                activeConnections[token] = {
                    startTime: Date.now(),
                    ip,
                    host,
                }
                updateMetrics.addConnection()

                // Notify MWC of connection change if available
                if (options.mwcCallbacks?.onConnectionChange) {
                    options.mwcCallbacks.onConnectionChange(Object.keys(activeConnections).length)
                }

                // Remove the socket from the list when closed
                socket.on('close', hadError => {
                    myLog(
                        `[D${hadError ? '-E' : ''}] ${host}:${port} (${
                            activeConnections[token] && (Date.now() - activeConnections[token]!.startTime) / 1000
                        }, ${token})`,
                    )
                    if (sockets[token]) {
                        const duration = (Date.now() - activeConnections[token]!.startTime) / 1000
                        const connectionInfo = activeConnections[token]!
                        updateMetrics.updateConnectionDuration(token, duration, host, connectionInfo.ip)
                        updateMetrics.removeConnection()
                        delete sockets[token]
                        delete activeConnections[token]

                        // Notify MWC of connection change if available
                        if (options.mwcCallbacks?.onConnectionChange) {
                            options.mwcCallbacks.onConnectionChange(Object.keys(activeConnections).length)
                        }
                    }
                })

                const { origin } = req.headers
                // todo also print username
                myLog(`[U] ${req.body.host}:${req.body.port} ${origin} (${token})`)

                const remote = socket.address()
                res.send({
                    token,
                    remote,
                })
            })

            const timeout = connectionTimeLimit
                ? setTimeout(() => {
                      // todo warn first!
                      setTimeout(() => {
                          socket.end()
                      }, 1000 * 200)
                  }, connectionTimeLimit)
                : undefined
            socket.on('close', () => {
                if (timeout) clearTimeout(timeout)
            })

            if (proxies) {
                // socksclient already gives us a connected socket
                socket.emit('connect')
            }

            socket.on('error', (err: any) => {
                cleanupPendingConnection()
                if (res.writableEnded) {
                    myLog(`Socket error after response closed: ${err}`)
                    return
                }

                res.status(502).send({
                    code: 502,
                    error: `Socket error: ${err.code}`,
                    details: err,
                })
            })
            if (connectionListener) {
                connectionListener(socket)
            }
        } catch (err) {
            // mainly for socks awaiting
            cleanupPendingConnection()
            try {
                res.status(500).send({
                    code: 500,
                    error: err.message,
                })
            } catch {}
        }
    }

    app.post(`${urlRoot}/connect`, async (req, res) => {
        // Allow MWC to handle request with custom routing logic
        if (options.mwcCallbacks?.handleConnectionRequest) {
            const handled = await options.mwcCallbacks.handleConnectionRequest(
                req,
                res,
                async (proxies, timeLimit) => {
                    await processConnectionRequest(req, res, proxies, timeLimit)
                }
            )
            if (handled) return
        }

        // Default: normal connection with no proxies
        const timeLimit = 1000 * 60 * 60 * 12 // 12 hours
        await processConnectionRequest(req, res, undefined, timeLimit)
    })

    if (options.debugUrlEndpoint !== false) {
        app.get(`${urlRoot}/debug`, (req, res) => {
            const headers = Object.entries(req.headers)
            // print full request url including host + query params
            res.send(
                `<pre>${req.protocol}://${req.get('host')}${req.originalUrl}\n\n${headers.map(([key, value]) => `${key}: ${value as string}`).join('\n')}</pre>`,
            )
        })
    }

    const authEndpoint = `${urlRoot}/auth`
    const sessionEndpoint = `${urlRoot}/session`
    app.get(`${urlRoot}/connect`, (req, res) => {
        const json: any = {
            version: VERSION,
            capabilities: {
                authEndpoint,
                sessionEndpoint,
                // ping: true
            },
        }

        // Add custom data from MWC callbacks if available
        if (options.mwcCallbacks?.getConnectData) {
            const customData = options.mwcCallbacks.getConnectData()
            Object.assign(json, customData)
        }

        res.send(json)
    })

    app.get(`${urlRoot}/connections`, (req, res) => {
        const accessCodeQs = req.query.code as string | undefined
        const basicInfo = [
            `Ever connected since ${startTimeFormmated}: ${currentState.everConnected}`,
            `Live: ${Object.keys(currentState.activeConnections).length}`,
        ]
        if (!process.env.ACCESS_CODE || accessCodeQs !== process.env.ACCESS_CODE) {
            try {
                res.status(403).send({
                    code: 403,
                    error: 'Access code required',
                    basicInfo,
                })
            } catch {}

            return
        }

        const stateFormatted = [
            ...Object.entries(currentState.activeConnections).map(
                ([token, { startTime, ip, host }], i) => `${i + 1}. (${(Date.now() - startTime) / 1000}s): ${ip} -> ${host}`,
            ),
            ...basicInfo,
        ].join('\n')
        res.send(stateFormatted)
    })

    registerAuthEndpoint(app, authEndpoint, sessionEndpoint, str => myLog(str), urlRoot, options)

    const wss = expressWs(app, server)

    const appUntyhped = app as any

    appUntyhped.ws(`${urlRoot}/ping`, (ws, req) => {
		try {
			if (options.onPing) {
				options.onPing(req)
			}

			ws.on('message', (data) => {
				if (typeof data === 'string' && data.startsWith('ping:')) {
					const startTime = process.hrtime()
					const pingId = data.slice('ping:'.length)
					ws.send(`pong:${pingId}:${process.hrtime(startTime)[1] / 1_000_000}`, () => { })
				}
			})
		} catch {
			// console.error('Error handling ping WebSocket connection:', err)
		}
	});

    appUntyhped.ws(`${urlRoot}/socket`, (ws, req) => {
        const { token } = req.query

        if (!sockets[token]) {
            console.warn(`WARN: Unknown TCP connection with token "${token}"`)
            ws.close()
            return
        }

        const socket = sockets[token]
        //delete sockets[token];

        // myLog(`Forwarding socket with token ${token}`)

        ws.on('message', data => {
            if (typeof data === 'string' && data.startsWith('ping:')) {
                ws.send(`pong:${data.slice('ping:'.length)}`)
                return
            }

            socket.write(data, 'binary', () => {
                //myLog('Sent: ', data.toString());
            })
        })
        socket.on('data', chunk => {
            //myLog('Received: ', chunk.toString());
            // Providing a callback is important, otherwise errors can be thrown
            ws.send(chunk, { binary: true }, err => {})
        })
        socket.on('end', () => {
            // myLog(`TCP connection closed by remote (${token})`)
            ws.close()
        })
        socket.on('error', err => {
            const message = err.code === 'EADDRNOTAVAIL' ? 'Minecraft server is not reachable anymore.' : `Issue with the connection to the Minecraft server: ${err.message}`;
            ws.send(`proxy-shutdown:${message}`, () => {});
        })
        ws.on('close', () => {
            socket.end()
            // myLog(`Websocket connection closed (${token})`)
        })
    })

    app.on('mount', parentApp => {
        // @see https://github.com/strongloop/express/blob/master/lib/application.js#L615
        parentApp.listen = function () {
            server.addListener('request', this)
            // eslint-disable-next-line prefer-spread, prefer-rest-params
            return server.listen.apply(server, arguments)
        }
    })

    if (options.signal) {
        const signalOpts = options.signal
        const signalClient = new SignalClient({
            signalServerUrl: signalOpts.serverUrl,
            description: signalOpts.description,
            domain: signalOpts.domain,
            listenPort: signalOpts.listenPort,
            urlRoot: options.urlRoot ?? '/api/vm/net',
            getSystemInfo: () => ({
                connectedPlayers: Object.keys(currentState.activeConnections).length,
                ...signalOpts.getExtraSystemInfo?.(),
            }),
        })
        const stopSignal = () => signalClient.stop()
        process.once('SIGTERM', stopSignal)
        process.once('SIGINT', stopSignal)
    }

    return app
}

export default createProxyMiddleware


export const parseSocksProxy = (proxy: string) => {
    const proxyParts = proxy.split('@')
    if (proxyParts.length === 1) {
        const portStr = proxyParts[0]!.split(':')[1]
        if (!portStr) throw new Error('Missing port in socks5 proxy')
        return {
            ipaddress: proxyParts[0]!,
            port: Number.parseInt(portStr, 10),
            type: 5 as any,
        }
    }

    if (proxyParts.length === 2) {
        const [ipaddress, portStr] = proxyParts[1]!.split(':')
        const [userId, password] = proxyParts[0]!.split(':')
        if (!portStr) throw new Error('Missing port in socks5 proxy')
        return {
            ipaddress,
            port: Number.parseInt(portStr, 10),
            userId: userId!,
            password: password || undefined,
            type: 5 as any,
        }
    }

    throw new Error('Invalid socks5 proxy format')
}
