const RemoteDevice = require('./RemoteDevice.js')
const RemoteGATTManager = require('./RemoteGATTManager.js')

/**
 * Manages remote BLE gateways that forward raw BLE advertisement data
 * over HTTP and GATT commands over WebSocket.
 *
 * Remote devices appear in the plugin UI just like local BLE devices.
 * Encryption keys, path mappings, and activation are configured through
 * the existing plugin interface — the gateway only relays raw bytes.
 *
 * @param {Object} opts
 * @param {Object} opts.plugin         - Plugin instance (for logging)
 * @param {Map}    opts.sensorMap      - MAC → sensor map
 * @param {Function} opts.instantiateSensor - (device, config) → sensor
 * @param {Function} opts.addSensorToList  - (sensor) → void
 * @param {Function} opts.getDeviceConfig  - (mac) → config | undefined
 */
class RemoteGatewayManager {
  constructor(opts) {
    this.plugin = opts.plugin
    this.sensorMap = opts.sensorMap
    this.instantiateSensor = opts.instantiateSensor
    this.addSensorToList = opts.addSensorToList
    this.getDeviceConfig = opts.getDeviceConfig

    // MAC → RemoteDevice
    this.emitBLEAdvertisement = opts.emitBLEAdvertisement
    this.remoteDevices = new Map()

    // gateway_id → RemoteGATTManager (one per WebSocket-connected gateway)
    this.gattManagers = new Map()

    // gateway_id → { gatewayId, disconnectedAt } (recently disconnected, kept for 60s)
    this.disconnectedGateways = new Map()

    // "gateway_id:MAC" → rssi (for GATT provider selection)
    this.gatewayDeviceRssi = new Map()
  }

  /**
   * Register a WebSocket connection from an ESP32 gateway.
   * Called when the gateway sends a 'hello' message.
   *
   * @param {string} gatewayId
   * @param {WebSocket} ws
   * @param {string} [ipAddress] - Remote IP from WebSocket upgrade request
   * @returns {RemoteGATTManager}
   */
  registerWebSocket(gatewayId, ws, ipAddress) {
    // Close existing manager for this gateway if any
    const existing = this.gattManagers.get(gatewayId)
    if (existing) {
      existing.handleDisconnect()
      this.gattManagers.delete(gatewayId)
    }

    // If a different gateway was connected from the same IP, it's the
    // same board reflashed with a new name — close the stale connection.
    if (ipAddress) {
      for (const [oldId, oldGm] of this.gattManagers) {
        if (oldGm.ipAddress === ipAddress && oldId !== gatewayId) {
          this.plugin.debug(
            `RemoteGateway: closing stale ${oldId} (same IP as ${gatewayId})`
          )
          oldGm.handleDisconnect()
          this.gattManagers.delete(oldId)
          this.disconnectedGateways.delete(oldId)
          // Terminate the old WebSocket so its close handler fires cleanly
          try {
            oldGm.ws.terminate()
          } catch (e) {
            /* ignore */
          }
        }
      }
    }

    // Clear from disconnected list if reconnecting
    this.disconnectedGateways.delete(gatewayId)

    const gattManager = new RemoteGATTManager(gatewayId, ws, this.plugin)
    if (ipAddress) gattManager.ipAddress = ipAddress
    this.gattManagers.set(gatewayId, gattManager)

    // Ping every 30s to detect dead connections
    const pingInterval = setInterval(() => {
      if (ws.readyState === ws.OPEN) {
        ws.ping()
      }
    }, 30000)

    ws.on('close', () => {
      clearInterval(pingInterval)
      this.plugin.debug(`RemoteGateway: WebSocket closed for ${gatewayId}`)
      // Keep a snapshot so the UI shows it as offline briefly
      this.disconnectedGateways.set(gatewayId, {
        gatewayId,
        ipAddress: gattManager.ipAddress,
        firmware: gattManager.firmware,
        lastUptime: gattManager.uptime,
        lastFreeHeap: gattManager.freeHeap,
        maxSlots: gattManager.maxSlots,
        connectedAt: gattManager.connectedAt,
        disconnectedAt: Date.now()
      })
      setTimeout(() => this.disconnectedGateways.delete(gatewayId), 60000)

      gattManager.handleDisconnect()
      this.gattManagers.delete(gatewayId)
    })

    this.plugin.debug(
      `RemoteGateway: WebSocket registered for ${gatewayId}${ipAddress ? ` (${ipAddress})` : ''}`
    )
    return gattManager
  }

  /**
   * Whether any connected gateway supports GATT.
   */
  supportsGATT() {
    for (const gm of this.gattManagers.values()) {
      if (gm.maxSlots > 0) return true
    }
    return false
  }

  /**
   * Total available GATT slots across all gateways.
   */
  availableGATTSlots() {
    let total = 0
    for (const gm of this.gattManagers.values()) {
      total += gm.availableGATTSlots()
    }
    return total
  }

  /**
   * Return status info for all known gateways (online + recently disconnected).
   */
  getGatewayInfo() {
    const gateways = []

    // Online gateways
    for (const [gwId, gm] of this.gattManagers) {
      // Count devices seen by this gateway
      let deviceCount = 0
      for (const key of this.gatewayDeviceRssi.keys()) {
        if (key.startsWith(`${gwId}:`)) deviceCount++
      }
      gateways.push({
        gatewayId: gwId,
        ipAddress: gm.ipAddress,
        firmware: gm.firmware,
        online: true,
        connectedAt: gm.connectedAt,
        uptime: gm.uptime,
        freeHeap: gm.freeHeap,
        gattSlots: { total: gm.maxSlots, available: gm.availableGATTSlots() },
        deviceCount
      })
    }

    // Recently disconnected gateways
    for (const [gwId, info] of this.disconnectedGateways) {
      if (this.gattManagers.has(gwId)) continue // already online again
      gateways.push({
        gatewayId: gwId,
        ipAddress: info.ipAddress,
        firmware: info.firmware,
        online: false,
        connectedAt: info.connectedAt,
        disconnectedAt: info.disconnectedAt,
        uptime: info.lastUptime,
        freeHeap: info.lastFreeHeap,
        gattSlots: { total: info.maxSlots, available: 0 },
        deviceCount: 0
      })
    }

    return gateways
  }

  /**
   * Remove a device from the remote devices map so it will be
   * re-discovered and re-instantiated on the next advertisement.
   *
   * @param {string} mac - MAC address (any case)
   */
  removeDevice(mac) {
    this.remoteDevices.delete(mac.toUpperCase())
  }

  /**
   * Get the RemoteDevice for a MAC, if known.
   *
   * @param {string} mac - MAC address (any case)
   * @returns {RemoteDevice|undefined}
   */
  getRemoteDevice(mac) {
    return this.remoteDevices.get(mac.toUpperCase())
  }

  /**
   * Re-instantiate a sensor for a MAC that is already known via remote
   * gateway, using fresh config. Used when the user saves config changes.
   *
   * @param {string} mac - MAC address
   * @param {Object} config - Device config
   * @returns {Object|null} The new sensor, or null
   */
  async reinitDevice(mac, config) {
    const device = this.remoteDevices.get(mac.toUpperCase())
    if (!device) return null

    const sensor = await this.instantiateSensor(device, config)
    if (sensor) {
      this.addSensorToList(sensor)
      if (config.active) {
        try {
          await sensor.activate(config, this.plugin)
        } catch (e) {
          this.plugin.debug(
            `RemoteGateway: failed to activate ${mac}: ${e.message}`
          )
        }
      }
      this.plugin.debug(
        `RemoteGateway: reinit ${sensor.getName()} (${sensor.constructor.name}) at ${mac}`
      )
    }
    return sensor
  }

  /**
   * Subscribe to GATT on the best gateway for a given device.
   *
   * @param {Object} descriptor - GATTSubscriptionDescriptor
   * @param {Function} callback - (charUuid, data) => void
   * @returns {Object} GATTSubscriptionHandle
   */
  async subscribeGATT(descriptor, callback) {
    const mac = descriptor.mac.toUpperCase()

    // Find the best gateway: has slots and strongest RSSI to this device
    let bestGateway = null
    let bestRssi = -Infinity

    for (const [gwId, gm] of this.gattManagers) {
      if (gm.availableGATTSlots() <= 0) continue
      const rssi = this.gatewayDeviceRssi.get(`${gwId}:${mac}`) || -999
      if (rssi > bestRssi || !bestGateway) {
        bestRssi = rssi
        bestGateway = gm
      }
    }

    if (!bestGateway) {
      throw new Error('No gateway with available GATT slots')
    }

    return bestGateway.subscribeGATT(descriptor, callback)
  }

  /**
   * Process a batch of advertisements from a gateway.
   *
   * @param {Object} body - Request body
   * @param {string} body.gateway_id - Gateway hostname/identifier
   * @param {Array}  body.devices - Array of advertisement objects
   * @param {string} body.devices[].mac - BLE device MAC (AA:BB:CC:DD:EE:FF)
   * @param {number} body.devices[].rssi - Signal strength
   * @param {string} [body.devices[].name] - Advertised device name
   * @param {Object} body.devices[].manufacturer_data - { mfrId: hexString }
   */
  async handleAdvertisements(body) {
    if (!body.devices || !Array.isArray(body.devices)) {
      throw new Error('Missing or invalid "devices" array')
    }

    for (const adv of body.devices) {
      try {
        await this._handleOneAdvertisement(adv, body.gateway_id)
      } catch (e) {
        this.plugin.debug(
          `RemoteGateway: error handling ${adv.mac}: ${e.message}`
        )
      }
    }
  }

  async _handleOneAdvertisement(adv, gatewayId) {
    if (!adv.mac) return

    const mac = adv.mac.toUpperCase()

    // Convert hex strings to Buffers
    const mfrData = {}
    if (adv.manufacturer_data) {
      for (const [idStr, hexStr] of Object.entries(adv.manufacturer_data)) {
        mfrData[parseInt(idStr)] = Buffer.from(hexStr.replace(/\s/g, ''), 'hex')
      }
    }

    const parsedAdv = {
      rssi: adv.rssi,
      name: adv.name,
      manufacturer_data: mfrData
    }

    // Get or create RemoteDevice
    let device = this.remoteDevices.get(mac)
    if (!device) {
      device = new RemoteDevice(mac, adv.name)
      this.remoteDevices.set(mac, device)

      // Set manufacturer data on the device before identification
      device.updateAdvertisement(parsedAdv)

      // Try to instantiate a sensor for this device
      const config = this.getDeviceConfig(mac) || {
        mac_address: mac,
        active: false,
        unconfigured: true,
        source: `remote:${gatewayId || 'unknown'}`
      }

      const sensor = await this.instantiateSensor(device, config)
      if (sensor) {
        this.addSensorToList(sensor)
        if (config.active) {
          try {
            await sensor.activate(config, this.plugin)
            this.plugin.debug(
              `RemoteGateway: activated ${sensor.getName()} at ${mac} via ${gatewayId}`
            )
          } catch (e) {
            this.plugin.debug(
              `RemoteGateway: failed to activate ${mac}: ${e.message}`
            )
          }
        }
        this.plugin.debug(
          `RemoteGateway: new device ${sensor.getName()} (${sensor.constructor.name}) at ${mac} via ${gatewayId}`
        )
      } else {
        this.plugin.debug(
          `RemoteGateway: could not instantiate sensor for ${mac} (mfr keys: ${Object.keys(mfrData).join(',')})`
        )
      }
    } else {
      // Existing device — feed new advertisement data
      device.updateAdvertisement(parsedAdv)
    }

    // Track per-gateway RSSI for GATT provider selection
    if (gatewayId) {
      this.gatewayDeviceRssi.set(`${gatewayId}:${mac}`, adv.rssi)
    }

    // Forward to BLE Provider API (after sensor identification so we can include parsed name)
    if (this.emitBLEAdvertisement) {
      const sensor = this.sensorMap.get(mac)
      const name =
        sensor && typeof sensor.getName === 'function'
          ? sensor.getName()
          : adv.name
      const mfrHex = {}
      for (const [id, buf] of Object.entries(mfrData)) {
        mfrHex[parseInt(id)] = buf.toString('hex')
      }
      this.emitBLEAdvertisement(
        mac,
        name,
        adv.rssi,
        mfrHex,
        `remote:${gatewayId || 'unknown'}`
      )
    }
  }
}

module.exports = RemoteGatewayManager
