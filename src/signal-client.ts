import https from 'https'
import http from 'http'
import { publicIpv4 } from 'public-ip'

const SELF_CHECK_TIMEOUT_MS = 8000
const BACKOFF_AFTER_502_MS = 5 * 60 * 1000 // 5 minutes

export type SignalClientOptions = {
    enabled: boolean
    signalServerUrl: string
    description?: string
    domain?: string
    acknowledgeInterval?: number
    /** Port this proxy listens on; when set, self-check (public IP + loop request) runs before reporting */
    listenPort?: number
    /** URL path prefix for self-check request (e.g. /api/vm/net) */
    urlRoot?: string
    getSystemInfo?: () => {
        cpuLoad?: number
        ramLoad?: number
        connectedPlayers?: number
    }
}

export class SignalClient {
    private readonly options: SignalClientOptions
    private intervalId?: NodeJS.Timeout
    private backoffUntil = 0
    private selfCheckPassed = false
    private selfCheckDone = false

    constructor(options: Partial<SignalClientOptions>) {
        this.options = {
            enabled: options.enabled ?? true,
            signalServerUrl: options.signalServerUrl ?? 'https://signal.mcraft.fun',
            description: options.description,
            domain: options.domain,
            acknowledgeInterval: options.acknowledgeInterval ?? 10_000,
            listenPort: options.listenPort,
            urlRoot: options.urlRoot ?? '/api/vm/net',
            getSystemInfo: options.getSystemInfo,
        }

        if (this.options.enabled) {
            if (this.options.listenPort != null) {
                this.runSelfCheckAndStart()
            } else {
                this.selfCheckPassed = true
                this.selfCheckDone = true
                this.start()
            }
        }
    }

    private async runSelfCheckAndStart(): Promise<void> {
        const port = this.options.listenPort!
        const urlRoot = (this.options.urlRoot ?? '').replace(/\/$/, '')

        try {
            const publicIp = await this.getPublicIp()
            if (!publicIp) {
                console.warn('Signal: could not get public IP, skipping signal server integration')
                this.selfCheckDone = true
                return
            }

            const ok = await this.selfCheckLoop(publicIp, port, urlRoot)
            this.selfCheckDone = true
            if (!ok) {
                console.warn(
                    `Signal: self-check failed (not reachable at ${publicIp}:${port}), skipping signal server integration`,
                )
                return
            }

            this.selfCheckPassed = true
            this.start()
        } catch (err) {
            this.selfCheckDone = true
            console.warn('Signal: self-check failed:', (err as Error).message)
        }
    }

    private async getPublicIp(): Promise<string | null> {
        try {
            return await publicIpv4()
        } catch {
            return null
        }
    }

    private selfCheckLoop(publicIp: string, port: number, urlRoot: string): Promise<boolean> {
        return new Promise((resolve) => {
            const path = `${urlRoot}/connect`
            const url = `http://${publicIp}:${port}${path}`
            const req = http.get(url, (res) => {
                if (res.statusCode === 502) {
                    resolve(false)
                    return
                }
                resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 500)
            })
            req.on('error', () => resolve(false))
            req.setTimeout(SELF_CHECK_TIMEOUT_MS, () => {
                req.destroy()
                resolve(false)
            })
        })
    }

    private start() {
        console.log(`Signal Server integration enabled, reporting to ${this.options.signalServerUrl}`)
        this.sendAcknowledgment()
        this.intervalId = setInterval(() => {
            this.sendAcknowledgment()
        }, this.options.acknowledgeInterval)
    }

    private sendAcknowledgment() {
        if (!this.options.enabled || !this.selfCheckPassed) return
        if (Date.now() < this.backoffUntil) return

        const params = new URLSearchParams()
        if (this.options.description) {
            params.append('description', this.options.description)
        }
        if (this.options.domain) {
            params.append('domain', this.options.domain)
        }
        const info = this.options.getSystemInfo?.()
        if (info?.connectedPlayers !== undefined) {
            params.append('players', info.connectedPlayers.toString())
        }
        if (info?.cpuLoad !== undefined) {
            params.append('cpuLoad', info.cpuLoad.toString())
        }
        if (info?.ramLoad !== undefined) {
            params.append('ramLoad', info.ramLoad.toString())
        }

        const url = `${this.options.signalServerUrl}/api/acknowledge?${params.toString()}`
        const protocol = this.options.signalServerUrl.startsWith('https') ? https : http

        const req = protocol.get(url, (res) => {
            let data = ''
            res.on('data', (chunk) => {
                data += chunk
            })
            res.on('end', () => {
                if (res.statusCode === 502) {
                    this.backoffUntil = Date.now() + BACKOFF_AFTER_502_MS
                    console.warn(
                        `Signal server returned 502, stopping reports for ${BACKOFF_AFTER_502_MS / 60000} minutes`,
                    )
                    return
                }
                if (res.statusCode === 200) {
                    try {
                        const response = JSON.parse(data)
                        if (response.ok && response.approved) {
                            // Successfully acknowledged
                        }
                    } catch (err) {
                        console.error('Failed to parse signal server response:', err)
                    }
                } else {
                    console.error(`Signal server returned status ${res.statusCode}: ${data}`)
                }
            })
        })

        req.on('error', (err) => {
            console.error('Failed to send acknowledgment to signal server:', err.message)
        })

        req.setTimeout(5000, () => {
            req.destroy()
            console.error('Signal server acknowledgment timed out')
        })
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = undefined
        }
    }

    isEnabled(): boolean {
        return this.options.enabled
    }
}
