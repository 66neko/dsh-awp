/**
 * service.js 中纯函数部分的单元测试。
 *
 * 重点是 `networkSignature`：它决定保存配置时**要不要重建网络节点**。
 * 如果它对执行方参数也敏感，每改一个字段都会重启监听端口，导致端口占用与报错闪烁。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AwpService, networkSignature } from '../src/host/service.js'
import { defaultConfig, validateConfig } from '../src/host/config-store.js'

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
        service.node = { peers: new Map() }
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
      service.node = { peers: new Map() }
      service.restart = async () => { assert.fail('默认 TLS 字段不应触发重启') }
      await service.applyConfig({
        ...before,
        mqtt: { ...defaultConfig().mqtt, ...before.mqtt },
      })
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
