# TODO: Port remaining GATT sensors to BLE Provider API

## Background

As part of the BLE Provider API integration (branch `remote-ble-gateway`), GATT connections
can be routed through the server's BLE API instead of directly using the local node-ble adapter.
This enables:
- GATT slot tracking in the BLE Manager UI
- Best-provider selection by RSSI (local adapter vs ESP32 gateway)
- Centralised connection management and reconnect logic

Sensors declare a `getGATTDescriptor()` and `handleGATTData()` (simple notify/poll) or
`needsRawGATT()` + `initRawGATTConnection()` (complex request-response protocols).
Legacy fallback remains in place — sensors without these methods continue to work via
direct node-ble when `useBLEManager` is off.

## Already ported

| Sensor | Mode |
|--------|------|
| VictronBatteryMonitor | descriptor (notify + init write) |
| GobiusCTankMeter | descriptor (notify) |
| RemoranWave3 | descriptor (notify, 3 chars) |
| SensorPush | descriptor (poll with writeBeforeRead) |
| JBDBMS | rawGATT |
| JikongBMS | rawGATT |

## Still needs porting (follow-up PR)

| Sensor | Likely mode | Notes |
|--------|-------------|-------|
| BankManager | descriptor or rawGATT | Check protocol |
| BMBatteryMonitor | rawGATT | Request-response BMS protocol |
| EcoWorthyBW02 | descriptor or rawGATT | |
| EctiveBMS | rawGATT | |
| HumsienkBMS | rawGATT | |
| Junctek | rawGATT | |
| KilovaultHLXPlus | rawGATT | |
| MercurySmartcraft | descriptor or rawGATT | |
| RenogyBattery | rawGATT | Modbus-over-BLE protocol |
| RenogyInverter | rawGATT | Modbus-over-BLE protocol |
| RenogyRoverClient | rawGATT | Modbus-over-BLE protocol |
| ShenzhenLiOnBMS | rawGATT | |
| UltrasonicWindMeter | descriptor or rawGATT | |
| WT901BLE | descriptor | IMU sensor, likely notify-based |
| XiaomiMiBeacon | descriptor | May actually be adv-only |

## How to port a sensor

### Descriptor mode (notify/poll)
```js
getGATTDescriptor() {
  return {
    mac: this._device?.address,
    service: '0000ffe0-0000-1000-8000-00805f9b34fb',
    notify: [{ uuid: '0000ffe1-0000-1000-8000-00805f9b34fb' }],
    // optional:
    poll: [{ uuid: '...', intervalMs: 5000, writeBeforeRead: '0100' }],
    init: [{ uuid: '...', value: '0100' }],
  }
}

handleGATTData(charUuid, data) {
  // dispatch by charUuid, call existing parse methods
}
```

### Raw GATT mode (complex protocols)
```js
needsRawGATT() { return true }

async initRawGATTConnection(conn) {
  // conn is a BLEGattConnection with read/write/startNotifications/discoverServices
  await conn.startNotifications('rx-char-uuid', (data) => this.handleData(data))
}
```
