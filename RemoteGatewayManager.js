const RemoteDevice = require('./RemoteDevice.js')

/**
 * Manages remote BLE gateways that forward raw BLE advertisement data
 * over HTTP.
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
        this.remoteDevices = new Map()
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
                mfrData[parseInt(idStr)] = Buffer.from(
                    hexStr.replace(/\s/g, ''),
                    'hex'
                )
            }
        }

        const parsedAdv = {
            rssi: adv.rssi,
            name: adv.name,
            manufacturer_data: mfrData,
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
                source: `remote:${gatewayId || 'unknown'}`,
            }

            const sensor = await this.instantiateSensor(device, config)
            if (sensor) {
                this.addSensorToList(sensor)
                this.plugin.debug(
                    `RemoteGateway: new device ${sensor.getName()} at ${mac} via ${gatewayId}`
                )
            }
            return
        }

        // Existing device — feed new advertisement data
        device.updateAdvertisement(parsedAdv)
    }
}

module.exports = RemoteGatewayManager
