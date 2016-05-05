'use strict'

const http = require('http')
const logger = require('winston')
const socketIO = require('socket.io')
const _ = require('lodash')

const blueprint = require('../blueprint')
const salesforce = require('../salesforce')
/**
 * Configure socket.io connection.
 * @param  {express.Server} app   Express Server
 * @return {http.Server}          HTTP Server with socket.io
 */
module.exports = function configureSocket (app, devices, rules) {
  const server = http.createServer(app)
  const io = socketIO(server)

  let simulationRunning = false
  function stopSimulation () {
    logger.debug('socket.io#startSimulation')
    simulationRunning = false
    devices.getAll().forEach((device) => device.stopSimulation())
  }

  // handle `connection` event
  io.on('connection', (socket) => {
    logger.debug('socket.io#connection', socket.client.conn.remoteAddress)
    const deviceIds = new Set()

    // fetch devices from blueprint
    const updateDevices = devices.update()

    // update rules
    // TODO blueprint request?
    updateDevices.then(() => {
      rules.update()
    })

    // update salesforce
    Promise.all([
      blueprint.getDevices(),
      blueprint.getEndUsers()
    ]).then((result) => {
      const devices = result[0]
      const endUsers = result[1]

      salesforce.addContacts(endUsers)
      salesforce.addAssets(devices)
    })

    socket.on('error', (err) => {
      logger.error('socket.io#error', err)
    })

    socket.on('connectDevice', (data, cb) => {
      logger.debug('socket.io#connectDevice')

      updateDevices.then(() => {
        const deviceId = data.deviceId
        deviceIds.add(deviceId)
        const device = devices.getOne(deviceId)
        if (device) {
          device.connect(socket.id)
          _.isFunction(cb) && cb(null, { ok: device.ok, simulate: simulationRunning })
        }
      })
    })

    socket.on('startSimulation', (data) => {
      logger.debug('socket.io#startSimulation', data)

      updateDevices.then(() => {
        const devices = devices.getAll()
        const thermometerFaliure = _.sample(devices.keys())
        simulationRunning = true

        devices.forEach((device, deviceId) => {
          if (deviceId !== data.deviceId) {
            device.startSimulation(() => {
              socket.emit('stopSimulation')
              stopSimulation()
            })
          }
          if (deviceId === thermometerFaliure) {
            device.triggerThermometerFaliure()
          }
        })
      })
    })

    socket.on('stopSimulation', stopSimulation)

    socket.on('malfunction', (data) => {
      const device = devices.getOne(data.deviceId)
      if (device) {
        device.triggerMalfunction()
      }
    })

    socket.on('disconnectDevice', (data) => {
      logger.debug('socket.io#disconnectDevice')

      const deviceId = data.deviceId
      const device = devices.getOne(data.deviceId)
      if (device) {
        device.disconnect(socket.id)
      }
      deviceIds.delete(deviceId)
    })

    socket.on('disconnect', () => {
      logger.debug('socket.io#disconnected')

      deviceIds.forEach((deviceId) => {
        const device = devices.getOne(deviceId)
        if (device) {
          device.disconnect(socket.id)
        }
      })
      deviceIds.clear()
    })
  })

  return server
}