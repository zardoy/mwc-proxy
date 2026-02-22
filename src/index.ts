/**
 * minecraft-web-proxy — library entry point
 *
 * Import from here when using this package as a library (npm) or when building
 * a custom server (like src-mwc). Zero side-effects: nothing starts, nothing
 * listens. See src/app.ts for the standalone CLI/Docker entry.
 */

export { createProxyMiddleware, currentState, parseSocksProxy } from './api'
export type { ProxyMiddlewareOptions } from './api'
export { SignalClient } from './signal-client'
export type { SignalClientOptions } from './signal-client'
