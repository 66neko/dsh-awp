/**
 * mqtt-transport.js 单元测试。
 *
 * 覆盖两件事：
 * 1. 依赖从随包的 vendor 目录加载（离线安装的关键）；
 * 2. 自定义 CA / 证书主机名 / 跳过校验这些 TLS 选项能正确传给 mqtt.connect。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { MqttTransport } from '../src/core/mqtt-transport.js'
import { AwpNode } from '../src/core/node.js'
import { makeEnvelope } from '../src/core/frame.js'
import { EventEmitter } from 'node:events'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 构造一个记录 connect 调用的假 mqtt。 */
function makeFakeMqtt() {
  const calls = []
  const client = {
    handlers: {},
    on(event, handler) { this.handlers[event] = handler },
    once(event, handler) {
      this.handlers[event] = handler
      if (event === 'connect') setImmediate(() => handler())
    },
    off() {},
    async subscribeAsync(topic) { this.subscribed = topic },
    async publishAsync(topic, frame, options) { calls.push({ type: 'publish', topic, frame, options }) },
    async endAsync() {},
  }
  return {
    calls,
    client,
    module: {
      connect: (url, options) => {
        calls.push({ type: 'connect', url, options })
        return client
      },
    },
  }
}

/**
 * 构造一个内存 broker：publish 会投递到所有订阅了该主题的客户端。
 * 用于验证 MQTT 传输层真的会把回复发布出去（而不只是收消息）。
 */
function makeBroker() {
  const clients = new Set()
  return {
    connect() {
      const handlers = new Map()
      const subscriptions = new Set()
      const client = {
        once(event, handler) {
          const wrapped = (...args) => {
            client.off(event, wrapped)
            handler(...args)
          }
          client.on(event, wrapped)
          return client
        },
        on(event, handler) {
          if (!handlers.has(event)) handlers.set(event, new Set())
          handlers.get(event).add(handler)
          return client
        },
        off(event, handler) {
          handlers.get(event)?.delete(handler)
          return client
        },
        emit(event, ...args) {
          for (const handler of [...(handlers.get(event) ?? [])]) handler(...args)
        },
        async subscribeAsync(topic) {
          subscriptions.add(topic)
        },
        async publishAsync(topic, payload) {
          for (const target of clients) {
            if (!target.subscriptions.has(topic)) continue
            const text = String(payload)
            // 异步投递，模拟真实 broker 的网络往返。
            setImmediate(() => target.emit('message', topic, Buffer.from(text)))
          }
        },
        async endAsync() {
          clients.delete(client)
          client.emit('close')
        },
      }
      client.subscriptions = subscriptions
      clients.add(client)
      setImmediate(() => client.emit('connect'))
      return client
    },
  }
}

describe('mqtt-transport', () => {
  describe('connectOptions', () => {
    it('默认不注入 TLS 字段', () => {
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team',
      })
      const options = transport.connectOptions()
      assert.equal(options.clientId, 'awp-node-a')
      assert.equal(options.clean, false)
      assert.equal('ca' in options, false)
      assert.equal('rejectUnauthorized' in options, false)
    })

    it('带上自定义 CA 与证书主机名', () => {
      const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----'
      const transport = new MqttTransport({
        nodeId: 'node-a',
        url: 'mqtts://broker:8883',
        topic: 'awp/team',
        ca: pem,
        servername: 'broker.example.com',
      })
      const options = transport.connectOptions()
      assert.equal(options.ca, pem)
      assert.equal(options.servername, 'broker.example.com')
      assert.equal('rejectUnauthorized' in options, false)
    })

    it('允许显式关闭证书校验', () => {
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtts://broker:8883', topic: 'awp/team',
        rejectUnauthorized: false,
      })
      assert.equal(transport.connectOptions().rejectUnauthorized, false)
    })

    it('带上用户名密码', () => {
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team',
        username: 'u', password: 'p',
      })
      const options = transport.connectOptions()
      assert.equal(options.username, 'u')
      assert.equal(options.password, 'p')
    })
  })

  describe('start', () => {
    for (const phase of ['connect', 'subscribe']) {
      it(`${phase} 一直不完成时，启动会超时并关闭客户端`, { timeout: 2000 }, async () => {
        const client = new EventEmitter()
        let ends = 0
        client.subscribeAsync = () => new Promise(() => {})
        client.endAsync = async () => { ends += 1 }
        const transport = new MqttTransport({
          nodeId: 'a', url: 'mqtt://broker:1883', topic: 'awp/test', startTimeoutMs: 20,
          loadMqtt: async () => ({ connect() {
            if (phase === 'subscribe') setImmediate(() => client.emit('connect'))
            return client
          } }),
        })
        await assert.rejects(transport.start(async () => {}), (error) => error.code === 'timeout')
        assert.equal(transport.client, null)
        assert.equal(ends, 1)
        assert.deepEqual(client.eventNames(), [], '失败清理必须释放全部传输层监听器')
      })
    }

    it('依赖加载尚未结束时 stop 会取消启动，迟到的加载结果不能创建连接', { timeout: 2000 }, async () => {
      let finishLoad
      let loadEntered
      const entered = new Promise((resolve) => { loadEntered = resolve })
      let connects = 0
      const transport = new MqttTransport({
        nodeId: 'a', url: 'mqtt://broker:1883', topic: 'awp/test',
        loadMqtt: () => { loadEntered(); return new Promise((resolve) => { finishLoad = resolve }) },
      })
      const rejected = assert.rejects(transport.start(async () => {}), (error) => error.code === 'cancelled')
      await entered
      await transport.stop()
      finishLoad({ connect() { connects += 1 } })
      await rejected
      assert.equal(connects, 0)
      assert.equal(transport.client, null)
    })

    it('等待 SUBACK 时 stop 不依赖 close 事件，也不重复关闭客户端', { timeout: 2000 }, async () => {
      const client = new EventEmitter()
      let subscribed
      const subscription = new Promise((resolve) => { subscribed = resolve })
      client.subscribeAsync = () => { subscribed(); return new Promise(() => {}) }
      let ends = 0
      client.endAsync = async () => { ends += 1 }
      const transport = new MqttTransport({
        nodeId: 'a', url: 'mqtt://broker:1883', topic: 'awp/test',
        loadMqtt: async () => ({ connect() { setImmediate(() => client.emit('connect')); return client } }),
      })
      const rejected = assert.rejects(transport.start(async () => {}), (error) => error.code === 'cancelled')
      await subscription
      await transport.stop()
      await rejected
      assert.equal(ends, 1)
      assert.equal(transport.client, null)
      assert.deepEqual(client.eventNames(), [])
    })

    it('订阅 前缀/节点ID 收件箱', async () => {
      const fake = makeFakeMqtt()
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team/',
        loadMqtt: async () => fake.module,
      })
      const started = await transport.start(async () => {})
      assert.equal(started.inbox, 'awp/team/node-a')
      assert.equal(fake.client.subscribed, 'awp/team/node-a')
      await transport.stop()
    })

    it('把 CA 传给 connect', async () => {
      const fake = makeFakeMqtt()
      const pem = 'PEM-CONTENT'
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtts://broker:8883', topic: 'awp/team',
        ca: pem,
        loadMqtt: async () => fake.module,
      })
      await transport.start(async () => {})
      const connectCall = fake.calls.find((call) => call.type === 'connect')
      assert.equal(connectCall.options.ca, pem)
      await transport.stop()
    })

    it('依赖加载失败时报 config 错误', async () => {
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team',
        loadMqtt: async () => { throw new Error('boom') },
      })
      await assert.rejects(() => transport.start(async () => {}), /MQTT 依赖加载失败/)
    })
  })

  describe('回复发布', () => {
    const SECRET = 'mqtt-test-secret-0123456789abcdef'

    it('收到 ping 后把 pong 发布回对端收件箱（回归：MQTT 只能单向发送）', async () => {
      const broker = makeBroker()
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team',
        loadMqtt: async () => broker,
      })
      const node = new AwpNode({
        nodeId: 'node-a',
        secret: SECRET,
        transport,
        peers: new Map([['node-a', {}]]),
        log: () => {},
      })
      await node.start(async (envelope) => envelope.type === 'ping'
        ? makeEnvelope({
          type: 'pong', from: 'node-a', to: envelope.from, re: envelope.id,
          body: { agent: 'dsh', worker: true },
        })
        : null)
      try {
        // 自发自收：同一个节点的收件箱既发送 ping，也接收 pong。
        const pong = await node.ping('node-a')
        assert.equal(pong.agent, 'dsh')
        assert.equal(pong.worker, true)
      } finally {
        await node.stop()
      }
    })

    it('onFrame 返回协议错误时不发布任何回复', async () => {
      const fake = makeFakeMqtt()
      const published = []
      fake.client.publishAsync = async (topic, frame) => { published.push({ topic, frame }) }
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team',
        loadMqtt: async () => fake.module,
      })
      await transport.start(async () => ({ error: 'bad_frame' }))
      fake.client.handlers.message('awp/team/node-a', Buffer.from('bad'))
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(published, [], '协议级错误按文档直接丢弃，避免放大流量')
      await transport.stop()
    })

    it('endAsync 永不返回时 stop() 也会在超时后结束', async () => {
      const fake = makeFakeMqtt()
      fake.client.endAsync = () => new Promise(() => {})
      const transport = new MqttTransport({
        nodeId: 'node-a', url: 'mqtt://broker:1883', topic: 'awp/team',
        loadMqtt: async () => fake.module,
        endTimeoutMs: 20,
      })
      await transport.start(async () => {})
      const startedAt = Date.now()
      await transport.stop()
      assert.ok(Date.now() - startedAt < 1000, 'stop 不能被挂起的 endAsync 永久卡住')
    })
  })

  describe('离线打包', () => {
    it('vendor/mqtt.js 存在且能从它加载 mqtt', async () => {
      const entry = join(root, 'vendor', 'mqtt.js')
      assert.ok(existsSync(entry), '缺少 vendor/mqtt.js，请运行 pnpm run vendor')
      const module = await import(pathToFileURL(entry).href)
      assert.equal(typeof module.connect, 'function')
    })

    it('vendor 里包含 mqtt 与 ws 等关键依赖', () => {
      for (const name of ['mqtt', 'ws', 'mqtt-packet', 'readable-stream']) {
        assert.ok(existsSync(join(root, 'vendor', 'node_modules', name, 'package.json')), `vendor 缺少 ${name}`)
      }
    })

    it('package.json 不再声明运行时 dependencies（安装无需联网）', () => {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
      assert.equal(manifest.dependencies, undefined, 'dependencies 会让安装时访问 registry')
      assert.ok(manifest.devDependencies?.mqtt, 'mqtt 应留在 devDependencies 供 vendor 使用')
    })
  })
})
