/**
 * config-store.js 单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, defaultConfig, requiresSecret, isLoopbackHost } from '../src/host/config-store.js'

describe('config-store', () => {
  describe('validateConfig', () => {
    it('规范化默认配置', async () => {
      const { config, errors } = await validateConfig({})
      assert.equal(errors.length, 0)
      assert.ok(config.nodeId)
      assert.equal(config.transport, 'http')
    })

    it('检测不合法的节点 ID', async () => {
      const { errors } = await validateConfig({ nodeId: 'invalid/id' })
      assert.ok(errors.some((e) => e.includes('节点 ID')))
    })

    it('检测不合法的 HTTP 配置', async () => {
      const { errors } = await validateConfig({ transport: 'http', http: { host: '', port: 99999 } })
      assert.ok(errors.length > 0)
    })

    it('检测不合法的 MQTT 配置', async () => {
      const { errors } = await validateConfig({ transport: 'mqtt', mqtt: { url: 'invalid', topic: '' } })
      assert.ok(errors.length > 0)
    })

    it('检测重复对端', async () => {
      const { errors } = await validateConfig({ peers: [{ id: 'a', url: '' }, { id: 'a', url: '' }] })
      assert.ok(errors.some((e) => e.includes('重复')))
    })

    it('允许对端是自己（本机自测）', async () => {
      const { errors } = await validateConfig({ nodeId: 'a', peers: [{ id: 'a', url: 'http://127.0.0.1:7820' }] })
      assert.deepEqual(errors, [])
    })

    it('启用执行方但没绑定工作区时报错', async () => {
      const { errors } = await validateConfig({
        nodeId: 'node-a',
        worker: { ...defaultConfig().worker, enabled: true },
      })
      assert.ok(errors.some((e) => e.includes('工作区')))
    })

    it('绑定工作区后启用执行方可以通过', async () => {
      const { config, errors } = await validateConfig({
        nodeId: 'node-a',
        worker: { ...defaultConfig().worker, enabled: true, workspaceId: 'ws-1' },
      })
      assert.deepEqual(errors, [])
      assert.equal(config.worker.workspaceId, 'ws-1')
    })

    it('允许自测时对端 URL 指向本机端口', async () => {
      const { config, errors } = await validateConfig({
        nodeId: 'node-a',
        transport: 'http',
        http: { host: '127.0.0.1', port: 7820, maxBodyBytes: 1024 },
        peers: [{ id: 'node-a', url: 'http://127.0.0.1:7820' }],
      })
      assert.deepEqual(errors, [])
      assert.equal(config.peers[0].id, config.nodeId)
    })
  })

  describe('requiresSecret', () => {
    it('回环监听不需要密钥', () => {
      const config = defaultConfig()
      config.transport = 'http'
      config.http = { ...config.http, host: '127.0.0.1' }
      assert.equal(requiresSecret(config), false)
      config.http = { ...config.http, host: 'localhost' }
      assert.equal(requiresSecret(config), false)
      config.http = { ...config.http, host: '::1' }
      assert.equal(requiresSecret(config), false)
    })

    it('监听所有网卡必须配置密钥', () => {
      const config = defaultConfig()
      config.transport = 'http'
      config.http = { ...config.http, host: '0.0.0.0' }
      assert.equal(requiresSecret(config), true)
      config.http = { ...config.http, host: '192.168.1.10' }
      assert.equal(requiresSecret(config), true)
    })

    it('MQTT 必须配置密钥', () => {
      const config = defaultConfig()
      config.transport = 'mqtt'
      config.http = { ...config.http, host: '127.0.0.1' }
      assert.equal(requiresSecret(config), true)
    })

    it('空配置按需要密钥处理', () => {
      assert.equal(requiresSecret(null), true)
    })
  })

  describe('isLoopbackHost', () => {
    it('识别回环地址', () => {
      for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
        assert.equal(isLoopbackHost(host), true, host)
      }
    })

    it('不把 0.0.0.0 当成回环', () => {
      for (const host of ['0.0.0.0', '192.168.1.10', '::', 'example.com', '', undefined]) {
        assert.equal(isLoopbackHost(host), false, String(host))
      }
    })
  })
})
