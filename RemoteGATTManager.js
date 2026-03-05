/**
 * Manages GATT sessions for a single ESP32 gateway WebSocket connection.
 *
 * Implements the server side of the GATT command protocol:
 * - Receives subscribeGATT() calls from the BLE API
 * - Sends gatt_subscribe/gatt_write/gatt_close commands to the ESP32
 * - Receives gatt_data/gatt_connected/gatt_disconnected from the ESP32
 * - Returns GATTSubscriptionHandle objects to the caller
 *
 * One instance per connected ESP32 gateway.
 */
class RemoteGATTManager {
    constructor(gatewayId, ws, plugin) {
        this.gatewayId = gatewayId
        this.ws = ws
        this.plugin = plugin
        this.sessions = new Map() // session_id -> session state
        this.maxSlots = 0
        this.activeSlots = 0
        this.nextSessionId = 1
        this.connectedAt = Date.now()
        this.ipAddress = null
        this.firmware = null
        this.uptime = 0
        this.freeHeap = 0
    }

    /**
     * Handle the 'hello' message from the ESP32 gateway.
     */
    handleHello(msg) {
        this.maxSlots = msg.max_gatt_connections || 0
        this.activeSlots = msg.active_gatt_connections || 0
        this.firmware = msg.firmware || null
        this.plugin.debug(
            `RemoteGATT [${this.gatewayId}]: hello, ${this.maxSlots} max GATT slots, ${this.activeSlots} active, fw=${this.firmware}`
        )
    }

    /**
     * Handle an incoming WebSocket message from the ESP32.
     */
    handleMessage(msg) {
        switch (msg.type) {
            case 'gatt_connected': {
                const session = this.sessions.get(msg.session_id)
                if (!session) return
                session.connected = true
                for (const cb of session.connectCallbacks) {
                    try { cb() } catch (e) { /* ignore */ }
                }
                this.plugin.debug(
                    `RemoteGATT [${this.gatewayId}]: session ${msg.session_id} connected to ${msg.mac}`
                )
                break
            }
            case 'gatt_data': {
                const session = this.sessions.get(msg.session_id)
                if (!session || !session.callback) return
                try {
                    session.callback(msg.uuid, Buffer.from(msg.data, 'hex'))
                } catch (e) {
                    this.plugin.debug(
                        `RemoteGATT [${this.gatewayId}]: callback error: ${e.message}`
                    )
                }
                break
            }
            case 'gatt_disconnected': {
                const session = this.sessions.get(msg.session_id)
                if (!session) return
                session.connected = false
                for (const cb of session.disconnectCallbacks) {
                    try { cb() } catch (e) { /* ignore */ }
                }
                this.plugin.debug(
                    `RemoteGATT [${this.gatewayId}]: session ${msg.session_id} disconnected: ${msg.reason}`
                )
                break
            }
            case 'gatt_error': {
                const session = this.sessions.get(msg.session_id)
                if (!session) return
                session.connected = false
                this.plugin.debug(
                    `RemoteGATT [${this.gatewayId}]: session ${msg.session_id} error: ${msg.error}`
                )
                // Fire disconnect callbacks on error too
                for (const cb of session.disconnectCallbacks) {
                    try { cb() } catch (e) { /* ignore */ }
                }
                // Clean up the session
                this.sessions.delete(msg.session_id)
                this.activeSlots = Math.max(0, this.activeSlots - 1)
                break
            }
            case 'status': {
                this.activeSlots = msg.active_gatt_connections || 0
                this.maxSlots = msg.max_gatt_connections || this.maxSlots
                this.uptime = msg.uptime || 0
                this.freeHeap = msg.free_heap || 0
                break
            }
        }
    }

    /**
     * Subscribe to GATT characteristics on a remote device via this gateway.
     *
     * @param {Object} descriptor - GATTSubscriptionDescriptor
     * @param {Function} callback - (charUuid: string, data: Buffer) => void
     * @returns {Object} GATTSubscriptionHandle
     */
    async subscribeGATT(descriptor, callback) {
        const sessionId = `s${this.nextSessionId++}`

        // Build the gatt_subscribe command
        const cmd = {
            type: 'gatt_subscribe',
            session_id: sessionId,
            mac: descriptor.mac,
            service: descriptor.service,
        }

        if (descriptor.notify) {
            cmd.notify = descriptor.notify
        }
        if (descriptor.poll) {
            cmd.poll = descriptor.poll.map(p => ({
                uuid: p.uuid,
                interval_ms: p.intervalMs
            }))
        }
        if (descriptor.init) {
            cmd.init = descriptor.init
        }
        if (descriptor.periodicWrite) {
            cmd.periodic_write = descriptor.periodicWrite.map(pw => ({
                uuid: pw.uuid,
                data: pw.data,
                interval_ms: pw.intervalMs
            }))
        }

        // Send to ESP32
        this.ws.send(JSON.stringify(cmd))

        // Create session state
        const session = {
            descriptor,
            callback,
            connected: false,
            disconnectCallbacks: [],
            connectCallbacks: [],
        }

        // Create the handle returned to the caller
        const self = this
        const handle = {
            write: async (charUuid, data) => {
                self.ws.send(JSON.stringify({
                    type: 'gatt_write',
                    session_id: sessionId,
                    uuid: charUuid,
                    data: Buffer.isBuffer(data) ? data.toString('hex') : data,
                }))
            },
            close: async () => {
                self.ws.send(JSON.stringify({
                    type: 'gatt_close',
                    session_id: sessionId,
                }))
                self.sessions.delete(sessionId)
                self.activeSlots = Math.max(0, self.activeSlots - 1)
            },
            get connected() { return session.connected },
            onDisconnect: (cb) => { session.disconnectCallbacks.push(cb) },
            onConnect: (cb) => { session.connectCallbacks.push(cb) },
        }

        session.handle = handle
        this.sessions.set(sessionId, session)
        this.activeSlots++

        this.plugin.debug(
            `RemoteGATT [${this.gatewayId}]: subscribeGATT session=${sessionId} mac=${descriptor.mac} service=${descriptor.service}`
        )

        return handle
    }

    /**
     * Number of available GATT connection slots on this gateway.
     */
    availableGATTSlots() {
        return Math.max(0, this.maxSlots - this.activeSlots)
    }

    /**
     * Called when the WebSocket to this gateway drops.
     * Fires onDisconnect for all active sessions.
     */
    handleDisconnect() {
        this.plugin.debug(
            `RemoteGATT [${this.gatewayId}]: WebSocket disconnected, ${this.sessions.size} active sessions`
        )
        for (const [id, session] of this.sessions) {
            session.connected = false
            for (const cb of session.disconnectCallbacks) {
                try { cb() } catch (e) { /* ignore */ }
            }
        }
        this.sessions.clear()
        this.activeSlots = 0
    }
}

module.exports = RemoteGATTManager
