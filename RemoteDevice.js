const EventEmitter = require('node:events');

/**
 * Lightweight Variant-compatible wrapper.
 *
 * BTSensor.valueIfVariant() checks `obj.constructor.name === 'Variant'`
 * and returns obj.value.  We use this class so that valueIfVariant
 * correctly unwraps our remote data, matching the behavior of the real
 * D-Bus Variant from @jellybrick/dbus-next.
 */
class Variant {
    constructor(value) {
        this.value = value
    }
}

/**
 * Virtual BLE device representing a remote device reported by a BLE gateway.
 *
 * Satisfies the device interface expected by BTSensor / VictronSensor without
 * requiring a real BlueZ/D-Bus connection.  Modeled after OutOfRangeDevice.js.
 *
 * Data arrives via updateAdvertisement() which is called by
 * RemoteGatewayManager when an HTTP POST comes in from the gateway.
 */
class RemoteDevice extends EventEmitter {

    constructor(mac, name) {
        super()
        this.mac = mac

        // Plain properties storage
        this._storedProps = {
            Address: mac,
            Name: name || '',
            RSSI: NaN,
            ManufacturerData: {},  // { mfrId: Buffer }
        }

        // --- helper (mimics node-ble BusHelper) ---
        this.helper = new EventEmitter()
        this.helper.iface = 'org.bluez.Device1'
        this.helper._prepare = () => {}
        this.helper.callMethod = () => {}
        this.helper.removeListeners = (() => {
            this.helper.removeAllListeners()
        }).bind(this.helper)

        // --- _propsProxy (mimics D-Bus Properties interface) ---
        //
        // _getPropsProxy(device) checks device._propsProxy first, so by
        // setting it here we bypass D-Bus entirely.
        //
        // D-Bus returns nested Variants:
        //   GetAll → { key: Variant(value), ... }
        //   ManufacturerData value is a dict: { mfrId: Variant(Buffer) }
        //
        // We use our Variant class so that valueIfVariant() unwraps correctly.

        this._propsProxy = {}

        this._propsProxy.GetAll = () => {
            const result = {}
            for (const [k, v] of Object.entries(this._storedProps)) {
                if (k === 'ManufacturerData') {
                    const wrapped = {}
                    for (const [mfrId, buf] of Object.entries(v)) {
                        wrapped[mfrId] = new Variant(buf)
                    }
                    result[k] = new Variant(wrapped)
                } else {
                    result[k] = new Variant(v)
                }
            }
            return result
        }

        this._propsProxy.Get = (_iface, prop) => {
            if (!Object.hasOwn(this._storedProps, prop)) return null

            const v = this._storedProps[prop]
            if (prop === 'ManufacturerData') {
                const wrapped = {}
                for (const [mfrId, buf] of Object.entries(v)) {
                    wrapped[mfrId] = new Variant(buf)
                }
                return new Variant(wrapped)
            }
            return new Variant(v)
        }
    }

    /**
     * Update with new advertisement data from the gateway.
     *
     * Stores plain Buffers in _storedProps (used by _propsProxy for identify)
     * and fires "PropertiesChanged" with Variant-wrapped values so that
     * _propertiesChanged → valueIfVariant → propertiesChanged → decrypt
     * works correctly.
     *
     * @param {Object} adv - { rssi, name, manufacturer_data: { mfrId: Buffer } }
     */
    updateAdvertisement(adv) {
        const props = {}

        if (adv.rssi !== undefined) {
            this._storedProps.RSSI = adv.rssi
            props.RSSI = new Variant(adv.rssi)
        }

        if (adv.name) {
            this._storedProps.Name = adv.name
        }

        if (adv.manufacturer_data) {
            const md = {}
            for (const [id, buf] of Object.entries(adv.manufacturer_data)) {
                this._storedProps.ManufacturerData[id] = buf
                md[id] = new Variant(buf)
            }
            props.ManufacturerData = new Variant(md)
        }

        // Fire the event that BTSensor.initPropertiesChanged listens on
        this.helper.emit("PropertiesChanged", props)
    }

    connect() {}
    disconnect() {}

    stopListening() {
        this.removeAllListeners()
        this.helper.removeAllListeners()
    }
}

module.exports = RemoteDevice
