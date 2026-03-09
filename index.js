const packageInfo = require('./package.json')

let bluetooth, destroy
try {
  const { createBluetooth } = require('@naugehyde/node-ble')
  const bt = createBluetooth()
  bluetooth = bt.bluetooth
  destroy = bt.destroy
} catch (e) {
  // BLE not available — remote gateway mode only
}
let Variant
try {
  Variant = require('@jellybrick/dbus-next').Variant
} catch (e) {
  // dbus not available
}

const BTSensor = require('./BTSensor.js')
const BLACKLISTED = require('./sensor_classes/BlackListedDevice.js')
const OutOfRangeDevice = require('./OutOfRangeDevice.js')
const { createChannel, createSession } = require('better-sse')
const { clearTimeout } = require('timers')
const loadClassMap = require('./classLoader.js')
const RemoteGatewayManager = require('./RemoteGatewayManager.js')
const { debug } = require('node:console')
class MissingSensor {
  constructor(config) {
    this.config = config
    this.addPath = BTSensor.prototype.addPath.bind(this)
    this.addParameter = BTSensor.prototype.addParameter.bind(this)
    this.addDefaultPath = BTSensor.prototype.addDefaultPath.bind(this)
    this.addDefaultParam = BTSensor.prototype.addDefaultParam.bind(this)
    this.getPath = BTSensor.prototype.getPath.bind(this)
    this.getImageSrc = BTSensor.prototype.getImageSrc.bind(this)

    this.getJSONSchema = BTSensor.prototype.getJSONSchema.bind(this)
    this.initSchema = BTSensor.prototype.initSchema.bind(this)

    this.initSchema()
    var keys = Object.keys(config?.paths ?? {})

    keys.forEach((key) => {
      this.addPath(key, {
        type: config.paths[key]?.type ?? 'string',
        title: config.paths[key].title
      })
    })
    keys = Object.keys(config?.params ?? {})
    keys.forEach((key) => {
      this.addParameter(key, {
        type: config.params[key]?.type ?? 'string',
        title: config.params[key].title
      })
      this[key] = config.params[key]
    })
    this.mac_address = config.mac_address
  }
  hasGATT() {
    return this.config.gattParams
  }
  initGATTConnection() {}

  getGATTDescription() {
    return ''
  }
  getMetadata() {
    return this.metadata
  }
  getMacAddress() {
    return this.mac_address
  }
  getDomain() {
    return BTSensor.SensorDomains.unknown
  }
  getDescription() {
    return ''
  }
  getName() {
    return `${this?.name ?? 'Unknown device'} (OUT OF RANGE)`
  }
  getDisplayName() {
    return `(${this.getName()} ${this.getMacAddress()})`
  }
  getRSSI() {
    return NaN
  }
  getBatteryStrength() {
    return NaN
  }
  getState() {
    return 'OUT_OF_RANGE'
  }
  stopListening() {}
  listen() {}
  isActive() {
    return false
  }
  isConnected() {
    return false
  }

  elapsedTimeSinceLastContact() {
    return NaN
  }
  getSignalStrength() {
    return NaN
  }
  prepareConfig() {}
  getErrorLog() {
    return []
  }
  getDebugLog() {
    return []
  }

  removeAllListeners() {}
  on() {}
  stopNotifications() {}
  isError() {
    return true
  }
}
module.exports = function (app) {
  var deviceConfigs = []
  var starts = 0

  var plugin = {
    debug(message) {
      app.debug(message)
      const logEntry = {
        timestamp: Date.now(),
        message: message
      }
      this.log.push(logEntry)
      if (channel) channel.broadcast(logEntry, 'pluginDebug')
    },
    setError(error) {
      app.setPluginError(error)
      app.debug(error)
      const logEntry = {
        timestamp: Date.now(),
        message: error
      }
      this.errorLog.push(logEntry)
      if (channel) channel.broadcast(logEntry, 'pluginError')
    },
    setStatusText(status) {
      app.setPluginStatus(status)
      const logEntry = { timestamp: Date.now(), message: status }
      this.log.push(logEntry)
      if (channel) channel.broadcast(logEntry, 'pluginStatusText')
    },
    setFatalError(error) {
      this.setError(`FATAL ERROR: ${error}`)
      this.stop()
    }
  }
  plugin.id = 'bt-sensors-plugin-sk'
  plugin.name = 'BT Sensors plugin'
  plugin.description =
    'Plugin to communicate with and update paths to BLE Sensors in Signalk'
  plugin.log = []
  plugin.errorLog = []

  plugin.schema = {
    type: 'object',
    htmlDescription: `<h2><a href="https://github.com/naugehyde/bt-sensors-plugin-sk/tree/1.2.0-beta#configuration" target="_blank">Plugin Documenation</a><p/><a href="https://github.com/naugehyde/bt-sensors-plugin-sk/issues/new/choose" target="_blank">Report an issue</a><p/><a href="https://discord.com/channels/1170433917761892493/1295425963466952725" target="_blank">Discord thread</a></h2>
 `,
    required: ['adapter', 'discoveryTimeout', 'discoveryInterval'],
    properties: {
      adapter: { title: 'Bluetooth adapter', type: 'string', default: 'hci0' },
      transport: {
        title: 'Transport ',
        type: 'string',
        enum: ['auto', 'le', 'bredr'],
        default: 'le',
        enumNames: [
          'Auto',
          'LE-Bluetooth Low Energy',
          'BR/EDR Bluetooth basic rate/enhanced data rate'
        ]
      },
      duplicateData: {
        title: 'Set scanner to report duplicate data',
        type: 'boolean',
        default: false
      },
      discoveryTimeout: {
        title: 'Default device discovery timeout (in seconds)',
        type: 'integer',
        default: 30,
        minimum: 10,
        maximum: 3600
      },
      inactivityTimeout: {
        title:
          'Inactivity timeout in seconds -- set to 0 to disable. (If no contact with any sensors for this period, the plugin will attempt to power cycle the Bluetooth adapter.)',
        type: 'integer',
        default: 0,
        minimum: 0,
        maximum: 3600
      },
      discoveryInterval: {
        title:
          'Scan for new devices interval (in seconds-- 0 for no new device scanning)',
        type: 'integer',
        default: 10,
        minimum: 0
      }
    }
  }

  plugin.started = false

  var discoveryIntervalID, progressID, progressTimeoutID, deviceHealthID
  var adapter
  let bleApiMode = false // true when server manages local BT via BLE API
  let bleApiUnsubscribe = null // unsubscribe from BLE API advertisements
  const channel = createChannel()

  plugin.debug(`Loading plugin ${packageInfo.version}`)

  const sensorMap = new Map()

  // Gateway manager — created inside start() once dependencies are available.
  // The route is registered at module level so it exists before start() runs.
  let gatewayManager = null
  let pluginRouter = null

  // BLE Provider API integration — when the server supports the v2 BLE API,
  // we register as a provider and forward advertisements through it.
  let bleAdvCallbacks = null

  function emitBLEAdvertisement(mac, name, rssi, manufacturerData, providerId) {
    if (!bleAdvCallbacks || bleAdvCallbacks.size === 0) return
    const adv = {
      mac: mac.toUpperCase(),
      name: name || undefined,
      rssi: rssi,
      manufacturerData: manufacturerData,
      providerId: providerId,
      timestamp: Date.now(),
      connectable: false
    }
    for (const cb of bleAdvCallbacks) {
      try {
        cb(adv)
      } catch (e) {
        plugin.debug(`BLE Provider callback error: ${e.message}`)
      }
    }
  }

  // Deferred route registration: Signal K calls start() before
  // registerWithRouter(), so routes that depend on start()-time state
  // are registered via registerStartRoutes() which runs once both the
  // router AND the start-time functions are available.
  let startRouteInstaller = null // set by start()

  function registerStartRoutes() {
    if (pluginRouter && startRouteInstaller) {
      startRouteInstaller(pluginRouter)
      startRouteInstaller = null // only install once per start()
    }
  }

  plugin.registerWithRouter = function (router) {
    pluginRouter = router
    router.post('/gateway/advertisements', async (req, res) => {
      if (!gatewayManager) {
        return res.status(503).json({ error: 'Plugin not started yet' })
      }
      try {
        await gatewayManager.handleAdvertisements(req.body)
        res.status(200).json({
          status: 'ok',
          count: req.body.devices?.length || 0
        })
      } catch (e) {
        plugin.debug(`RemoteGateway: ${e.message}`)
        res.status(400).json({ error: e.message })
      }
    })

    router.get('/gateways', (req, res) => {
      if (!gatewayManager) {
        return res.json([])
      }
      res.json(gatewayManager.getGatewayInfo())
    })

    // WebSocket endpoint for ESP32 gateway GATT commands
    let WebSocketServer
    try {
      WebSocketServer = require('ws').WebSocketServer
    } catch (e) {
      plugin.debug(
        'Gateway WS: ws module not available, GATT over WebSocket disabled'
      )
    }
    const wsPath = `/plugins/${plugin.id}/gateway/ws`
    const gatewayWss = WebSocketServer
      ? new WebSocketServer({ noServer: true })
      : null

    if (gatewayWss) {
      gatewayWss.on('connection', (ws, request) => {
        let gwGattManager = null
        const gatewayIp = request.socket.remoteAddress

        ws.on('message', (raw) => {
          let msg
          try {
            msg = JSON.parse(raw.toString())
          } catch (e) {
            plugin.debug(`Gateway WS: invalid JSON`)
            return
          }

          if (msg.type === 'hello' && !gwGattManager && gatewayManager) {
            gwGattManager = gatewayManager.registerWebSocket(
              msg.gateway_id,
              ws,
              gatewayIp
            )
            gwGattManager.handleHello(msg)
            // Send acknowledgement
            ws.send(
              JSON.stringify({
                type: 'hello_ack',
                server_time: Date.now()
              })
            )
            plugin.debug(`Gateway WS: ${msg.gateway_id} connected`)
          } else if (gwGattManager) {
            gwGattManager.handleMessage(msg)
          }
        })

        ws.on('error', (err) => {
          plugin.debug(`Gateway WS error: ${err.message}`)
        })
      })

      // Attach to the HTTP server for WebSocket upgrade
      const tryAttachWs = () => {
        const server = app.server
        if (!server) {
          setTimeout(tryAttachWs, 1000)
          return
        }
        server.on('upgrade', (request, socket, head) => {
          const url = new URL(request.url, `http://${request.headers.host}`)
          if (url.pathname === wsPath) {
            gatewayWss.handleUpgrade(request, socket, head, (ws) => {
              gatewayWss.emit('connection', ws, request)
            })
          }
        })
        plugin.debug(`Gateway WebSocket endpoint ready at ${wsPath}`)
      }
      tryAttachWs()
    }

    registerStartRoutes()
  }

  plugin.start = async function (options, restartPlugin) {
    const classMap = loadClassMap(app)

    plugin.started = true
    var adapterID = options.adapter
    var foundConfiguredDevices = 0

    if (Object.keys(options).length == 0) {
      //empty config means initial startup. save defaults and enabled=true.
      let json = {
        configuration: {
          adapter: 'hci0',
          transport: 'le',
          discoveryTimeout: 30,
          discoveryInterval: 10
        },
        enabled: true,
        enableDebug: false
      }
      let appDataDirPath = app.getDataDirPath()
      let jsonFile = appDataDirPath + '.json'
      const fs = require('node:fs')
      try {
        fs.writeFileSync(jsonFile, JSON.stringify(json, null, 2))
        options = json
      } catch (err) {
        console.log(`Error writing initial config: ${err.message} `)
        console.log(err)
      }
    }

    // Initialize the remote BLE gateway manager early, before BT adapter init
    // which may fail. The gateway works without a local BT adapter.
    gatewayManager = new RemoteGatewayManager({
      plugin,
      sensorMap,
      instantiateSensor,
      addSensorToList,
      getDeviceConfig,
      emitBLEAdvertisement
    })

    // Determine if server manages local Bluetooth via BLE API
    bleApiMode =
      app.bleApi && app.bleApi.localBluetoothManaged === true
    plugin.debug(`bleApiMode=${bleApiMode} localBluetoothManaged=${app.bleApi?.localBluetoothManaged}`)

    // Register as BLE provider for remote gateways (ESP32s are bt-sensors-specific)
    if (typeof app.registerBLEProvider === 'function') {
      bleAdvCallbacks = new Set()
      app.registerBLEProvider({
        name: 'bt-sensors BLE (remote gateways)',
        methods: {
          startDiscovery: async () => {},
          stopDiscovery: async () => {},
          getDevices: async () => {
            // Only report devices seen by remote gateways, not local
            const remoteDevices = []
            for (const [mac, sensor] of sensorMap) {
              if (sensor.device && sensor.device.constructor.name === 'RemoteDevice') {
                remoteDevices.push(mac)
              }
            }
            return remoteDevices
          },
          onAdvertisement: (cb) => {
            bleAdvCallbacks.add(cb)
            plugin.debug(
              `BLE Provider: onAdvertisement callback registered (${bleAdvCallbacks.size} total)`
            )
            return () => bleAdvCallbacks.delete(cb)
          },
          supportsGATT: () => gatewayManager.supportsGATT(),
          availableGATTSlots: () => gatewayManager.availableGATTSlots(),
          subscribeGATT: async (descriptor, callback) => {
            return gatewayManager.subscribeGATT(descriptor, callback)
          }
        }
      })
      plugin.debug(
        `Registered as BLE provider (bleAdvCallbacks size: ${bleAdvCallbacks.size})`
      )
    } else {
      plugin.debug(
        'BLE Provider API not available (app.registerBLEProvider not found)'
      )
    }

    // In BLE API mode, subscribe to server-managed advertisement stream
    // for device discovery (local adapter managed by server, not by us)
    if (bleApiMode) {
      plugin.debug('BLE API mode: local Bluetooth managed by server')
      const BLEApiDevice = require('./BLEApiDevice.js')

      bleApiUnsubscribe = app.bleApi.onAdvertisement((adv) => {
        // Process advertisements from local BLE provider or any remote gateway

        const mac = adv.mac.toUpperCase()
        plugin.debug(`adv mac=${mac} provider=${adv.providerId}`)
        let sensor = sensorMap.get(mac)

        if (sensor) {
          // Update existing sensor's device with new advertisement data
          if (sensor.device && typeof sensor.device.updateAdvertisement === 'function') {
            const mfrData = {}
            if (adv.manufacturerData) {
              for (const [id, hex] of Object.entries(adv.manufacturerData)) {
                mfrData[id] = Buffer.from(hex, 'hex')
              }
            }
            sensor.device.updateAdvertisement({
              rssi: adv.rssi,
              name: adv.name,
              manufacturer_data: mfrData
            })
          }
        } else {
          // New device — create BLEApiDevice and initialize sensor
          const mfrData = {}
          if (adv.manufacturerData) {
            for (const [id, hex] of Object.entries(adv.manufacturerData)) {
              mfrData[id] = Buffer.from(hex, 'hex')
            }
          }
          const device = new BLEApiDevice(mac, adv.name, {
            rssi: adv.rssi,
            manufacturer_data: mfrData
          })
          const config = getDeviceConfig(mac) || {
            mac_address: mac,
            discoveryTimeout: options?.discoveryTimeout ?? 30,
            active: false,
            unconfigured: true
          }
          initConfiguredDeviceWithDevice(device, config)
        }
      })
    }

    // Store a route installer so registerWithRouter() can register
    // start()-dependent routes once the Express router is available.
    // Signal K calls start() before registerWithRouter(), so we
    // cannot register routes directly here.
    startRouteInstaller = function (router) {
      router.get('/getSensorInfo', async (req, res) => {
        const _sensor = sensorMap.get(req.query?.mac_address)
        const _class = classMap.get(req.query?.class)
        let _tempSensor = null
        if (_sensor && _class && _sensor instanceof classMap.get('UNKNOWN')) {
          try {
            _tempSensor = new _class(_sensor.device)
            _tempSensor.currentProperties = _sensor.currentProperties
            _tempSensor._app = app
            _tempSensor._adapter = adapter
            await _tempSensor.init()
            const _json = sensorToJSON(_tempSensor)
            res.status(200).json(_json)
          } catch (e) {
            res.status(400).send(`Invalid request: ${e.message}`)
          } finally {
            if (_tempSensor) _tempSensor.stopListening()
          }
        } else {
          res.status(404).json({ message: `Invalid request` })
        }
      })

      router.post('/updateSensorData', async (req, res) => {
        const sensor = sensorMap.get(req.body.mac_address)
        sensor.prepareConfig(req.body)
        const i = deviceConfigs.findIndex(
          (p) => p.mac_address == req.body.mac_address
        )
        if (i < 0) {
          if (!options.peripherals) {
            if (!options.hasOwnProperty('peripherals')) options.peripherals = []

            options.peripherals = []
          }
          options.peripherals.push(req.body)
        } else {
          options.peripherals[i] = req.body
        }
        deviceConfigs = options.peripherals
        app.savePluginOptions(options, async () => {
          res.status(200).json({ message: 'Sensor updated' })
          if (sensor) {
            if (sensor.isActive()) await sensor.stopListening()
            removeSensorFromList(sensor)
          }
          // If the device is known via remote gateway, re-instantiate
          // from the remote device — avoids local adapter timeout
          // that would create a MissingSensor.
          if (gatewayManager) {
            const reinited = await gatewayManager.reinitDevice(
              req.body.mac_address,
              req.body
            )
            if (reinited) return
          }
          if (adapter) initConfiguredDevice(req.body)
        })
      })
      router.post('/removeSensorData', async (req, res) => {
        const sensor = sensorMap.get(req.body.mac_address)
        if (!sensor) {
          res.status(404).json({ message: 'Sensor not found' })
          return
        }
        const i = deviceConfigs.findIndex(
          (p) => p.mac_address == req.body.mac_address
        )
        if (i >= 0) {
          deviceConfigs.splice(i, 1)
        }

        if (sensor.isActive()) await sensor.stopListening()

        if (sensorMap.has(req.body.mac_address))
          sensorMap.delete(req.body.mac_address)
        if (gatewayManager) gatewayManager.removeDevice(req.body.mac_address)
        app.savePluginOptions(options, () => {
          res.status(200).json({ message: 'Sensor updated' })
          channel.broadcast({}, 'resetSensors')
        })
      })

      router.post('/updateBaseData', async (req, res) => {
        Object.assign(options, req.body)
        app.savePluginOptions(options, () => {
          res.status(200).json({ message: 'Plugin updated' })
          channel.broadcast({}, 'pluginRestarted')
          restartPlugin(options)
        })
      })

      router.get('/getBaseData', (req, res) => {
        res.status(200).json({
          schema: plugin.schema,
          data: {
            adapter: options.adapter,
            transport: options.transport,
            duplicateData: options.duplicateData,
            discoveryTimeout: options.discoveryTimeout,
            discoveryInterval: options.discoveryInterval,
            inactivityTimeout: options.inactivityTimeout
          }
        })
      })

      router.get('/getSensors', (req, res) => {
        const t = sensorsToJSON()
        res.status(200).json(t)
      })

      router.get('/getProgress', (req, res) => {
        let deviceCount = deviceConfigs.filter((dc) => dc.active).length
        const json = {
          progress: foundConfiguredDevices / deviceCount,
          maxTimeout: 1,
          deviceCount: foundConfiguredDevices,
          totalDevices: deviceCount
        }
        res.status(200).json(json)
      })

      router.get('/getPluginState', async (req, res) => {
        res.status(200).json({
          connectionId: Date.now(),
          state: plugin.started ? 'started' : 'stopped'
        })
      })
      router.get('/sse', async (req, res) => {
        const session = await createSession(req, res)
        channel.register(session)
        req.on('close', () => {
          channel.deregister(session)
        })
      })
    }
    registerStartRoutes()

    function sensorsToJSON() {
      return Array.from(
        Array.from(sensorMap.values())
          .filter((s) => !(s instanceof BLACKLISTED))
          .map(sensorToJSON)
      )
    }

    function getSensorInfo(sensor) {
      const s = sensor.getState()
      return {
        mac: sensor.getMacAddress(),
        name: sensor.getName(),
        class: sensor.constructor.name,
        domain: sensor.getDomain().name,
        state: sensor.getState(),
        error: sensor.isError(),
        errorLog: sensor.getErrorLog(),
        debugLog: sensor.getDebugLog(),
        RSSI: sensor.getRSSI(),
        signalStrength: sensor.getSignalStrength(),
        batteryStrength: sensor.getBatteryStrength(),
        connected: sensor.isConnected(),
        lastContactDelta: sensor.elapsedTimeSinceLastContact()
      }
    }

    function sensorToJSON(sensor) {
      const config = getDeviceConfig(sensor.getMacAddress())
      const schema = sensor.getJSONSchema()
      schema.htmlDescription = sensor.getDescription()

      return {
        info: getSensorInfo(sensor),
        schema: schema,
        config: config ? config : {},
        configCopy: JSON.parse(JSON.stringify(config ? config : {}))
      }
    }

    async function startScanner(options) {
      const transport = options?.transport ?? 'le'
      const duplicateData = options?.duplicateData ?? false
      plugin.debug('Starting scan...')
      //Use adapter.helper directly to get around Adapter::startDiscovery()
      //filter options which can cause issues with Device::Connect()
      //turning off Discovery
      //try {await adapter.startDiscovery()}
      try {
        if (transport) {
          plugin.debug(
            `Setting Bluetooth transport option to ${transport}. DuplicateData to ${duplicateData}`
          )
          await adapter.helper.callMethod('SetDiscoveryFilter', {
            Transport: new Variant('s', transport),
            DuplicateData: new Variant('b', duplicateData)
          })
        }
        await adapter.helper.callMethod('StartDiscovery')
      } catch (error) {
        plugin.debug(error)
      }
    }
    function updateSensor(sensor) {
      channel.broadcast(getSensorInfo(sensor), 'sensorchanged')
    }

    function removeSensorFromList(sensor) {
      sensor.removeAllListeners('state')
      sensor.removeAllListeners('connected')
      sensor.removeAllListeners('error')
      sensor.removeAllListeners('debug')
      sensor.removeAllListeners('RSSI')

      sensorMap.delete(sensor.getMacAddress())
      channel.broadcast({ mac: sensor.getMacAddress() }, 'removesensor')
    }

    function addSensorToList(sensor) {
      sensorMap.set(sensor.getMacAddress(), sensor)
      sensor.on('state', (state) => {
        updateSensor(sensor)
      })
      sensor.on('connected', (state) => {
        updateSensor(sensor)
      })
      sensor.on('errorDetected', (error) => {
        updateSensor(sensor)
      })
      sensor.on('debug', () => {
        updateSensor(sensor)
      })
      sensor.on(sensor.constructor.batteryStrengthTag, () => {
        updateSensor(sensor)
      })
      sensor._lastRSSI = -1 * Infinity
      sensor.on('RSSI', () => {
        if (Date.now() - sensor._lastRSSI > 10000) {
          //only update RSSI on client every 10 seconds

          sensor._lastRSSI = Date.now()

          updateSensor(sensor)
        }
      })
      channel.broadcast(sensorToJSON(sensor), 'newsensor')
    }
    function deviceNameAndAddress(config) {
      return `${config?.name ?? ''}${config.name ? ' at ' : ''}${config.mac_address}`
    }

    function createSensor(adapter, config) {
      return new Promise((resolve, reject) => {
        var s
        const startNumber = starts
        adapter
          .waitDevice(
            config.mac_address,
            (config?.discoveryTimeout ?? 30) * 1000
          )
          .then(async (device) => {
            if (startNumber != starts) {
              return
            }
            s = await instantiateSensor(device, config)
            if (!s) reject('Unable to create sensor')
            else if (s instanceof BLACKLISTED)
              reject(`Device is blacklisted (${s.reasonForBlacklisting()}).`)
            else {
              addSensorToList(s)
              resolve(s)
            }
          })
          .catch(async (e) => {
            if (s) s.stopListening()
            else {
              // If the remote gateway already created a proper sensor for
              // this MAC, don't overwrite it with an OutOfRangeDevice sensor.
              const remoteSensor = sensorMap.get(config.mac_address)
              if (remoteSensor && !(remoteSensor instanceof MissingSensor)) {
                resolve(remoteSensor)
                return
              }
              const device = new OutOfRangeDevice(adapter, config)
              s = await instantiateSensor(device, config)
              device.once('deviceFound', async (device) => {
                s.device = device
                s.listen()
                if (config.active) {
                  s.clearUnableToCommunicate()
                  await s.activate(config, plugin)
                } else {
                  s.unsetError()
                  s.setState('DORMANT')
                }
                removeSensorFromList(s)
                addSensorToList(s)
              })
              addSensorToList(s)
              resolve(s)
            }
            if (startNumber == starts) {
              const errorTxt = `Unable to communicate with device ${deviceNameAndAddress(config)} Reason: ${e?.message ?? e}`

              if (config.active) {
                if (s) {
                  s.setError(errorTxt)
                  s.notifyUnableToCommunicate()
                } else plugin.setError(errorTxt)
              }
              plugin.debug(errorTxt)
              plugin.debug(e)

              reject(e?.message ?? e)
            }
          })
      })
    }
    function getDeviceConfig(mac) {
      return deviceConfigs.find((p) => p.mac_address == mac)
    }
    async function getClassFor(device, config) {
      if (config.params?.sensorClass) {
        const c = classMap.get(config.params.sensorClass)
        if (c == null)
          throw new Error('Cannot find class ' + config.params.sensorClass)
        return c
      }
      for (var [clsName, cls] of classMap) {
        if (clsName.startsWith('_')) continue
        const c = await cls.identify(device)
        if (c) {
          if (Object.hasOwn(config, 'params')) {
            config.params.sensorClass = clsName
          }
          return c
        }
      }
      return classMap.get('UNKNOWN')
    }

    async function instantiateSensor(device, config) {
      try {
        const c = await getClassFor(device, config)
        c.debug = app.debug

        const sensor = new c(device, config?.params, config?.gattParams)
        sensor._paths = config.paths //this might be a good candidate for refactoring
        sensor._app = app
        sensor._adapter = adapter //HACK!
        await sensor.init()
        return sensor
      } catch (error) {
        if (!config.unconfigured) {
          const msg = `Unable to instantiate ${await BTSensor.getDeviceProp(device, 'Address')}: ${error.message} `
          plugin.debug(msg)
          plugin.debug(error)
          if (config.active) plugin.setError(msg)
        }
        return null
      }
    }
    function activeDevices() {
      return Array.from(sensorMap.values()).filter((s) => s.isActive()).length
    }
    // Initialize a sensor from a device object directly (BLE API mode)
    async function initConfiguredDeviceWithDevice(device, deviceConfig) {
      const startNumber = starts
      if (!deviceConfig.discoveryTimeout)
        deviceConfig.discoveryTimeout = options?.discoveryTimeout ?? 30
      try {
        const sensor = await instantiateSensor(device, deviceConfig)
        if (!sensor || startNumber !== starts) return
        addSensorToList(sensor)
        sensor.listen()
        if (deviceConfig.active) {
          try {
            await sensor.activate(deviceConfig, plugin)
            plugin.setStatusText(`Listening to ${activeDevices()} sensors.`)
          } catch (e) {
            sensor.setError(`Unable to activate sensor. Reason: ${e.message}`)
          }
        }
      } catch (e) {
        plugin.debug(`BLE API device init error: ${e.message}`)
      }
    }

    function initConfiguredDevice(deviceConfig) {
      const startNumber = starts
      plugin.setStatusText(`Initializing ${deviceNameAndAddress(deviceConfig)}`)
      if (!deviceConfig.discoveryTimeout)
        deviceConfig.discoveryTimeout = options.discoveryTimeout
      createSensor(adapter, deviceConfig)
        .then(async (sensor) => {
          if (startNumber != starts) {
            return
          }
          if (
            deviceConfig.active &&
            !(sensor.device instanceof OutOfRangeDevice)
          ) {
            try {
              await sensor.activate(deviceConfig, plugin)
              plugin.setStatusText(`Listening to ${activeDevices()} sensors.`)
            } catch (e) {
              sensor.setError(`Unable to activate sensor. Reason: ${e.message}`)
            }
          }
        })
        .catch((error) => {
          if (deviceConfig?.unconfigured ?? false) return
          if (startNumber != starts) {
            return
          }
          // If the remote gateway already discovered this device and
          // created a proper sensor, don't overwrite it with MissingSensor.
          const existing = sensorMap.get(deviceConfig.mac_address)
          if (existing && !(existing instanceof MissingSensor)) {
            plugin.debug(
              `Sensor at ${deviceConfig.mac_address} already discovered via remote gateway`
            )
            ++foundConfiguredDevices
            return
          }
          const msg = `Sensor at ${deviceConfig.mac_address} unavailable. Reason: ${error}`
          plugin.debug(msg)

          if (deviceConfig.active) plugin.setError(msg)
          const sensor = new MissingSensor(deviceConfig)
          ++foundConfiguredDevices

          addSensorToList(sensor) //add sensor to list with known options
        })
    }
    function findDevices(discoveryTimeout) {
      const startNumber = starts
      plugin.setStatusText('Scanning for new Bluetooth devices...')

      adapter.devices().then((macs) => {
        if (startNumber != starts) {
          return
        }
        for (const mac of macs) {
          var deviceConfig = getDeviceConfig(mac)
          const sensor = sensorMap.get(mac)

          if (sensor) {
            if (sensor instanceof MissingSensor) {
              removeSensorFromList(sensor)
              initConfiguredDevice(deviceConfig)
            }
          } else {
            if (!deviceConfig) {
              deviceConfig = {
                mac_address: mac,
                discoveryTimeout: discoveryTimeout,
                active: false,
                unconfigured: true
              }
              initConfiguredDevice(deviceConfig)
            }
          }
        }
      })
    }

    function findDeviceLoop(
      discoveryTimeout,
      discoveryInterval,
      immediate = true
    ) {
      if (immediate) findDevices(discoveryTimeout)
      discoveryIntervalID = setInterval(
        findDevices,
        discoveryInterval * 1000,
        discoveryTimeout
      )
    }

    channel.broadcast({ state: 'started' }, 'pluginstate')

    // In BLE API mode, skip local adapter init — server manages it
    if (bleApiMode) {
      plugin.debug('Skipping local adapter init (BLE API mode)')
      adapter = null
    }

    if (!bleApiMode) {
      if (!adapterID || adapterID == '') adapterID = 'hci0'

      //Check if Adapter has changed since last start()
      if (adapter) {
        if (adapter.adapter != adapterID) {
          adapter.helper._propsProxy.removeAllListeners()
          adapter = null
        }
      }
      //Connect to adapter

      if (!adapter) {
        plugin.debug(`Connecting to bluetooth adapter ${adapterID}`)

        try {
          adapter = await bluetooth.getAdapter(adapterID)
        } catch (e) {
          // BlueZ/D-Bus not available — remote gateway mode only
          plugin.debug(
            `No local Bluetooth: ${e.message} — remote gateway mode only`
          )
          plugin.setStatusText('Remote gateway mode (no local BLE)')
          sensorMap.clear()
          deviceConfigs = options?.peripherals ?? []
          starts++
          return
        }

      //Set up DBUS listener to monitor Powered status of current adapter

      await adapter.helper._prepare()
      adapter.helper._propsProxy.on(
        'PropertiesChanged',
        async (iface, changedProps, invalidated) => {
          if (Object.hasOwn(changedProps, 'Powered')) {
            if (changedProps.Powered.value == false) {
              if (plugin.started) {
                //only call stop() if plugin is started
                plugin.setStatusText(
                  `Bluetooth Adapter ${adapterID} turned off. Plugin disabled.`
                )
                await plugin.stop()
              }
            } else {
              await restartPlugin(options)
            }
          }
        }
      )
      if (!(await adapter.isPowered())) {
        plugin.debug(`Bluetooth Adapter ${adapterID} not powered on.`)
        plugin.setError(`Bluetooth Adapter ${adapterID} not powered on.`)
        await plugin.stop()
        return
      }
    }
    } // end if (!bleApiMode)

    sensorMap.clear()
    if (channel) {
      channel.broadcast({ state: 'started' }, 'pluginstate')
    }
    deviceConfigs = options?.peripherals ?? []

    if (plugin.stopped) {
      plugin.stopped = false
    }

    if (!bleApiMode) {
      try {
        const activeAdapters = await bluetooth.activeAdapters()
        if (activeAdapters.length == 0) {
          plugin.setError('No active Bluetooth adapters found.')
        }
        plugin.schema.properties.adapter.enum = []
        plugin.schema.properties.adapter.enumNames = []
        for (a of activeAdapters) {
          plugin.schema.properties.adapter.enum.push(a.adapter)
          plugin.schema.properties.adapter.enumNames.push(
            `${a.adapter} @ ${await a.getAddress()} (${await a.getName()})`
          )
        }
      } catch (e) {
        plugin.setError(`Unable to get adapters: ${e.message}`)
      }

      await startScanner(options)
    }
    if (starts > 0) {
      plugin.debug(`Plugin ${packageInfo.version} restarting...`)
    } else {
      plugin.debug(`Plugin ${packageInfo.version} started`)
    }
    starts++
    if (!bleApiMode && !(await adapter.isDiscovering()))
      try {
        await startScanner(options)
      } catch (e) {
        plugin.setError(`Error starting scan: ${e.message}`)
      }
    if (!(deviceConfigs === undefined)) {
      const maxTimeout = Math.max(
        ...deviceConfigs.map(
          (dc) => dc?.discoveryTimeout ?? options.discoveryTimeout
        )
      )
      const totalDevices = deviceConfigs.filter((dc) => dc.active).length

      var progress = 0
      if (progressID == null)
        progressID = setInterval(() => {
          channel.broadcast(
            {
              progress: ++progress,
              maxTimeout: maxTimeout,
              deviceCount: foundConfiguredDevices,
              totalDevices: totalDevices
            },
            'progress'
          )
          if (foundConfiguredDevices == totalDevices) {
            ;(progressID, (progressTimeoutID = null))
            clearTimeout(progressTimeoutID)
            clearInterval(progressID)
            progressID = null
          }
        }, 1000)
      if (progressTimeoutID == null)
        progressTimeoutID = setTimeout(
          () => {
            if (progressID) {
              clearInterval(progressID)
              progressID = null
              channel.broadcast(
                {
                  progress: maxTimeout,
                  maxTimeout: maxTimeout,
                  deviceCount: foundConfiguredDevices,
                  totalDevices: totalDevices
                },
                'progress'
              )
            }
          },
          (maxTimeout + 1) * 1000
        )

      for (const config of deviceConfigs) {
        initConfiguredDevice(config)
      }
    }
    const minTimeout = Math.min(
      ...deviceConfigs.map(
        (dc) => dc?.discoveryTimeout ?? options.discoveryTimeout
      )
    )
    const intervalTimeout =
      (minTimeout == Infinity
        ? (options?.discoveryTimeout ??
          plugin.schema.properties.discoveryTimeout.default)
        : minTimeout) * 1000

    deviceHealthID = setInterval(async () => {
      let lastContactDelta = Infinity
      sensorMap.forEach((sensor) => {
        const config = getDeviceConfig(sensor.getMacAddress())
        const dt = config?.discoveryTimeout ?? options.discoveryTimeout
        const lc = sensor.elapsedTimeSinceLastContact()
        if (lc < lastContactDelta)
          //get min last contact delta
          lastContactDelta = lc
        if (lc > dt) {
          updateSensor(sensor)
        }
        if (sensor.noContactThreshold && lc > sensor.noContactThreshold) {
          if (sensor.isActive()) sensor.notifyNoContact()
        } else {
          if (sensor.isActive()) sensor.clearNoContact()
        }
      })
      if (
        !bleApiMode &&
        sensorMap.size &&
        options.inactivityTimeout &&
        lastContactDelta > options.inactivityTimeout
      ) {
        plugin.debug(
          `No contact with any sensors for ${lastContactDelta} seconds. Recycling Bluetooth adapter.`
        )
        await adapter.setPowered(false)
        await adapter.setPowered(true)
      }
    }, intervalTimeout)

    if (!bleApiMode) {
      if (!options.hasOwnProperty('discoveryInterval'))
        //no config -- first run
        options.discoveryInterval =
          plugin.schema.properties.discoveryInterval.default

      if (options.discoveryInterval && !discoveryIntervalID)
        findDeviceLoop(
          options?.discoveryTimeout ??
            plugin.schema.properties.discoveryTimeout.default,
          options.discoveryInterval
        )
    }
  }
  plugin.stop = async function () {
    plugin.debug('Stopping plugin')
    plugin.stopped = true
    plugin.started = false
    bleAdvCallbacks = null
    bleApiMode = false
    if (bleApiUnsubscribe) {
      bleApiUnsubscribe()
      bleApiUnsubscribe = null
    }
    channel.broadcast({ state: 'stopped' }, 'pluginstate')
    if (discoveryIntervalID) {
      clearInterval(discoveryIntervalID)
      discoveryIntervalID = null
    }
    if (progressID) {
      clearInterval(progressID)
      progressID = null
    }
    if (progressTimeoutID) {
      clearTimeout(progressTimeoutID)
      progressTimeoutID = null
    }

    if (deviceHealthID) {
      clearTimeout(deviceHealthID)
      deviceHealthID = null
    }

    if (sensorMap) {
      for await (const sensorEntry of sensorMap.entries()) {
        try {
          await sensorEntry[1].stopListening()
          plugin.debug(`No longer listening to ${sensorEntry[0]}`)
        } catch (e) {
          plugin.setError(
            `Error stopping listening to ${sensorEntry[0]}: ${e.message}`
          )
        }
      }
    }
    sensorMap.clear()

    if (adapter) {
      adapter.helper._propsProxy.removeAllListeners()
      if (await adapter.isDiscovering())
        try {
          await adapter.stopDiscovery()
          plugin.debug('Scan stopped')
        } catch (e) {
          plugin.setError(`Error stopping scan: ${e.message}`)
        }
    }
    plugin.debug('BT Sensors plugin stopped')
  }

  return plugin
}
