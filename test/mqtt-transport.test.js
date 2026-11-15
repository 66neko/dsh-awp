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
