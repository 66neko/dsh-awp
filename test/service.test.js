/**
 * service.js 的配置签名、配置队列及网络生命周期测试。
 *
 * 重点是 `networkSignature`：它决定保存配置时**要不要重建网络节点**。
 * 如果它对执行方参数也敏感，每改一个字段都会重启监听端口，导致端口占用与报错闪烁。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AwpService, networkSignature } from '../src/host/service.js'
import { defaultConfig, validateConfig } from '../src/host/config-store.js'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { MqttTransport, loadVendoredMqtt } from '../src/core/mqtt-transport.js'

const mqttPacket = createRequire(import.meta.url)('../vendor/node_modules/mqtt-packet')

/**
 * 创建连接成功但不确认订阅的本地 broker，以及不读写本机配置的服务。
 * @param {import('node:test').TestContext} t - 测试上下文，用于清理套接字。
 * @returns {Promise<{ service: AwpService, config: object, subscribed: Promise<void> }>} 测试服务。
 */
async function stalledSubscription(t) {
  const sockets = new Set()
  let acknowledgeSubscribe
  const subscribed = new Promise((resolve) => { acknowledgeSubscribe = resolve })
  const broker = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    const parser = mqttPacket.parser()
    socket.on('data', (data) => parser.parse(data))
    parser.on('packet', (packet) => {
      if (packet.cmd === 'connect') socket.write(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }))
      if (packet.cmd === 'subscribe') acknowledgeSubscribe()
      if (packet.cmd === 'pingreq') socket.write(mqttPacket.generate({ cmd: 'pingresp' }))
    })
  })
  broker.listen(0, '127.0.0.1')
  await once(broker, 'listening')
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => broker.close(resolve))
  })
  const service = new AwpService({
    get(name) {
      if (name === 'credentials') return { async resolve(ref) {
        return ref === 'DSH_AWP_SECRET' ? { value: 'service-test-only-secret' } : null
      } }
      return null
    },
    on() {},
    tools: { register() {} },
  })
  const config = baseConfig()
  config.transport = 'mqtt'
  config.mqtt = { ...config.mqtt, url: `mqtt://127.0.0.1:${broker.address().port}`, topic: 'awp/test' }
  service.taskStore.load = async () => {}
  service.configStore.load = async () => ({ config, errors: [] })
  return { service, config, subscribed }
}

/** 一份可用的基准配置。 */
function baseConfig() {
  const config = defaultConfig()
  config.nodeId = 'node-a'
  config.transport = 'http'
  config.http = { host: '127.0.0.1', port: 7820, maxBodyBytes: 1_048_576 }
  config.peers = [{ id: 'node-b', url: 'http://10.0.0.5:7820' }]
  return config
}

describe('service', () => {
  describe('networkSignature', () => {
    it('相同配置签名一致', () => {
      assert.equal(networkSignature(baseConfig()), networkSignature(baseConfig()))
    })

    it('执行方参数变化不影响签名（不需要重建节点）', () => {
      const before = baseConfig()
      const after = baseConfig()
      after.worker = {
        ...before.worker,
        enabled: true,
        workspace: 'D:/work',
        model: { provider: 'deepseek', model: 'deepseek-chat' },
        maxConcurrent: 4,
      }
      after.delegator = { enabled: false }
      assert.equal(networkSignature(before), networkSignature(after))
    })

    it('端口变化改变签名', () => {
      const after = baseConfig()
      after.http = { ...after.http, port: 7821 }
      assert.notEqual(networkSignature(baseConfig()), networkSignature(after))
    })

    it('节点 ID、传输方式、对端变化都改变签名', () => {
      const byNode = baseConfig(); byNode.nodeId = 'node-c'
      const byTransport = baseConfig(); byTransport.transport = 'mqtt'
      const byPeer = baseConfig(); byPeer.peers = [{ id: 'node-z', url: 'http://10.0.0.6:7820' }]
      const base = networkSignature(baseConfig())
      assert.notEqual(base, networkSignature(byNode))
      assert.notEqual(base, networkSignature(byTransport))
      assert.notEqual(base, networkSignature(byPeer))
    })

    it('MQTT 密码不进入签名（只影响连接参数，由重启流程读取）', () => {
      const mqtt = baseConfig()
      mqtt.transport = 'mqtt'
      mqtt.mqtt = { url: 'mqtts://broker:8883', topic: 'awp/t', username: '' }
      const withPassword = { ...mqtt, mqttPassword: 'secret' }
      assert.equal(networkSignature(mqtt), networkSignature(withPassword))
    })

    it('空配置返回空签名', () => {
      assert.equal(networkSignature(null), '')
    })
  })

  describe('applyConfig MQTT TLS 配置', () => {
    for (const [field, value] of Object.entries({
      caFile: '/certs/broker.pem',
      caPem: '-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----',
      servername: 'broker.example.com',
      allowInvalidCert: true,
    })) {
      it(`修改或清除 ${field} 都会重建连接`, async () => {
        const service = new AwpService({ get: () => null })
        const before = baseConfig()
        before.transport = 'mqtt'
        before.mqtt = { ...before.mqtt, url: 'mqtts://broker:8883', topic: 'awp/t' }
        service.config = before
        service.node = { peers: new Map(), started: true }
        const restarted = []
        service.restart = async (config) => { restarted.push(config) }

        const after = { ...before, mqtt: { ...before.mqtt, [field]: value } }
        await service.applyConfig(after)
        assert.equal(restarted.length, 1, '更新 TLS 设置必须重建连接')
        assert.equal(restarted[0], after)

        await service.applyConfig(before)
        assert.equal(restarted.length, 2, '恢复证书校验或清除证书设置也必须重建连接')
        assert.equal(restarted[1], before)
      })
    }

    it('旧配置补齐默认 TLS 字段不会重启连接', async () => {
      const service = new AwpService({ get: () => null })
      const before = baseConfig()
      before.transport = 'mqtt'
      before.mqtt = { url: 'mqtts://broker:8883', topic: 'awp/t', username: '' }
      service.config = before
      service.node = { peers: new Map(), started: true }
      service.restart = async () => { assert.fail('默认 TLS 字段不应触发重启') }
      await service.applyConfig({
        ...before,
        mqtt: { ...defaultConfig().mqtt, ...before.mqtt },
      })
    })
  })

  describe('配置应用串行化', () => {
    it('等待真实 broker 的 SUBACK 时可以卸载，队列中的保存不会再启动连接', { timeout: 4000 }, async (t) => {
      const { service, config, subscribed } = await stalledSubscription(t)
      const starting = service.start()
      await subscribed
      const transport = service.node.transport
      const rejectedSave = assert.rejects(service.applyConfig({ ...config, nodeId: 'next-node' }), /服务已停止/)
      await Promise.all([service.stop(), starting, rejectedSave])
      assert.equal(transport.client, null)
      assert.equal(service.node, null)
      assert.equal(service.workerStarted, false)
      await assert.rejects(service.applyConfig(config), /服务已停止/)
    })

    it('订阅超时后队列仍可应用新配置并启动 HTTP', { timeout: 4000 }, async (t) => {
      await loadVendoredMqtt()
      const start = MqttTransport.prototype.start
      t.mock.method(MqttTransport.prototype, 'start', function (...args) {
        this.startTimeoutMs = 100
        return start.apply(this, args)
      })
      const { service, config, subscribed } = await stalledSubscription(t)
      await service.start()
      await subscribed
      assert.match(service.startError, /启动在 .*ms 内未完成/)
      const mqtt = service.node.transport
      assert.equal(mqtt.client, null)
      const httpConfig = { ...config, transport: 'http', http: { ...config.http, port: 0 } }
      try {
        await service.applyConfig(httpConfig)
        assert.equal(service.node.started, true)
        assert.equal(service.startError, null)
      } finally {
        await service.stop()
      }
    })

    it('并发保存不会交错执行两次重启', async () => {
      const service = new AwpService({ get: () => null })
      const base = baseConfig()
      service.config = base
      service.node = { peers: new Map(), started: true }
      let active = 0
      let maxActive = 0
      const order = []
      service.restart = async (config) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push(config.nodeId)
        active -= 1
      }

      const second = { ...base, nodeId: 'node-b' }
      const third = { ...base, nodeId: 'node-c' }
      await Promise.all([service.applyConfig(second), service.applyConfig(third)])

      assert.equal(maxActive, 1, '两次 restart 必须串行，不能出现 Node already started')
      assert.deepEqual(order, ['node-b', 'node-c'], '按保存顺序应用，最后一次配置生效')
      assert.equal(service.config, third)
    })

    it('节点未真正启动时，只改执行方参数也会重试启动', async () => {
      const service = new AwpService({ get: () => null })
      const base = baseConfig()
      service.config = base
      service.node = { peers: new Map(), started: false }
      let restarts = 0
      service.restart = async () => { restarts += 1 }

      await service.applyConfig({ ...base, worker: { ...base.worker, maxConcurrent: 2 } })
      assert.equal(restarts, 1, '启动失败后的保存不能只清 startError 而不重启')
    })

    it('一次应用失败不会卡住后续保存', async () => {
      const service = new AwpService({ get: () => null })
      const base = baseConfig()
      service.config = base
      service.node = { peers: new Map(), started: true }
      let calls = 0
      service.restart = async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
      }

      await assert.rejects(
        () => service.applyConfig({ ...base, nodeId: 'node-b' }),
        /boom/,
      )
      await service.applyConfig({ ...base, nodeId: 'node-c' })
      assert.equal(calls, 2)
    })
  })

  describe('validateConfig 同步契约', () => {
    it('返回普通对象而不是 Promise', () => {
      const result = validateConfig({ nodeId: 'node-a' })
      assert.equal(typeof result, 'object')
      assert.equal(result instanceof Promise, false)
      assert.equal(typeof result.then, 'undefined')
      assert.ok(Array.isArray(result.errors))
    })

    it('默认配置可以通过校验', () => {
      const { config, errors } = validateConfig({ nodeId: 'node-a' })
      assert.deepEqual(errors, [])
      assert.equal(config.nodeId, 'node-a')
    })
  })
})
