import os from 'os'
import promBundle from 'express-prom-bundle'
import { Registry, collectDefaultMetrics, Counter, Gauge } from 'prom-client'

// Create a new registry
const register = new Registry()

// Enable collection of default metrics with custom prefix and error handling
try {
    collectDefaultMetrics({
        register,
        prefix: 'minecraft_proxy_',
        gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
    })
} catch (error) {
    console.error('Error collecting default metrics:', error)
}

// Safely create and manage metrics
const createMetric = (MetricClass, config) => {
    try {
        return new MetricClass(config)
    } catch (error) {
        console.error(`Error creating metric ${config.name}:`, error)
        // Return a dummy metric that won't crash on operations
        return {
            inc() {},
            dec() {},
            set() {},
            labels: () => ({
                inc() {},
                dec() {},
                set() {},
            }),
        }
    }
}

// System metrics with error handling
export const systemMetrics = {
    cpuUsage: createMetric(Gauge, {
        name: 'minecraft_proxy_cpu_usage_percentage',
        help: 'CPU usage percentage',
        registers: [register],
        collect() {
            try {
                const cpus = os.cpus()
                const totalCpuTime = cpus.reduce((acc, cpu) => acc + Object.values(cpu.times).reduce((sum, time) => sum + time, 0), 0)
                const idleTime = cpus.reduce((acc, cpu) => acc + cpu.times.idle, 0)
                const usagePercentage = ((totalCpuTime - idleTime) / totalCpuTime) * 100
                this.set(usagePercentage)
            } catch (error) {
                console.error('Error collecting CPU metrics:', error)
            }
        }
    }),

    memoryUsage: createMetric(Gauge, {
        name: 'minecraft_proxy_memory_usage_bytes',
        help: 'Memory usage in bytes',
        registers: [register],
        labelNames: ['type'],
        collect() {
            try {
                const used = os.totalmem() - os.freemem()
                this.set({ type: 'total' }, os.totalmem())
                this.set({ type: 'free' }, os.freemem())
                this.set({ type: 'used' }, used)
            } catch (error) {
                console.error('Error collecting memory metrics:', error)
            }
        }
    }),

    processMemory: createMetric(Gauge, {
        name: 'minecraft_proxy_process_memory_bytes',
        help: 'Process memory usage in bytes',
        registers: [register],
        labelNames: ['type'],
        collect() {
            try {
                const usage = process.memoryUsage()
                this.set({ type: 'rss' }, usage.rss)
                this.set({ type: 'heapTotal' }, usage.heapTotal)
                this.set({ type: 'heapUsed' }, usage.heapUsed)
                this.set({ type: 'external' }, usage.external)
            } catch (error) {
                console.error('Error collecting process memory metrics:', error)
            }
        }
    })
}

// Custom metrics with proper label definitions
export const activeConnectionsGauge = createMetric(Gauge, {
    name: 'minecraft_proxy_active_connections',
    help: 'Number of active connections',
    registers: [register],
})

export const totalConnectionsCounter = createMetric(Counter, {
    name: 'minecraft_proxy_total_connections',
    help: 'Total number of connections ever made',
    registers: [register],
})

export const authRequestsCounter = createMetric(Counter, {
    name: 'minecraft_proxy_auth_requests_total',
    help: 'Total number of authentication requests',
    labelNames: ['status'],
    registers: [register],
})

export const connectionDurationGauge = createMetric(Gauge, {
    name: 'minecraft_proxy_connection_duration_seconds',
    help: 'Duration of connections in seconds',
    labelNames: ['token', 'host', 'ip'],
    registers: [register],
})

// Express middleware with error handling
export const metricsMiddleware = promBundle({
    includeMethod: true,
    includePath: true,
    promRegistry: register,
    normalizePath: [
        ['^/api/vm/net/.*', '/api/vm/net/#endpoint']
    ],
    buckets: [0.1, 0.5, 1, 2, 5],
})

// Safe metric update functions
export const updateMetrics = {
    addConnection() {
        try {
            activeConnectionsGauge.inc()
            totalConnectionsCounter.inc()
        } catch (error) {
            console.error('Error updating connection metrics:', error)
        }
    },
    removeConnection() {
        try {
            activeConnectionsGauge.dec()
        } catch (error) {
            console.error('Error updating connection metrics:', error)
        }
    },
    recordAuthRequest(success: boolean) {
        try {
            authRequestsCounter.inc({ status: success ? 'success' : 'failure' })
        } catch (error) {
            console.error('Error updating auth metrics:', error)
        }
    },
    updateConnectionDuration(token: string, duration: number, host: string, ip: string) {
        try {
            connectionDurationGauge.set({ token, host, ip }, duration)
        } catch (error) {
            console.error('Error updating duration metrics:', error)
        }
    }
}

// Initialize frequent CPU metrics collection
// setInterval(() => {
//     try {
//         systemMetrics.cpuUsage.collect()
//     } catch (error) {
//         console.error('Error collecting CPU metrics:', error)
//     }
// }, 2000) // Update every 2 seconds
