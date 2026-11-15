/**
 * rpc.js 单元测试。
 *
 * 锁住两条契约：
 * 1. 必须通过 `connection.fetch.register` 注册**精确路由**；
 * 2. 绝不能调用 `connection.rpc.intercept('/api', ...)`——`/api` 的 interceptor 由 DSH
 *    自己的 api-gateway 占用，插件占用它会让所有其它 `/api` 调用 404（桌面启动即失败）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDispatcher, createRpcRoute, registerRpc, serverResponse, RPC_PATH, RPC_ENDPOINT,
} from '../src/host/rpc.js'

/** 构造一组最小可用的处理器。 */
function makeHandlers(overrides = {}) {
  let config = { nodeId: 'test-node', transport: 'http' }
  return {
    getState: () => ({ config, running: false }),
    saveConfig: async (next) => {
      if (next && next.nodeId === 'bad/id') return { ok: false, errors: ['节点 ID 不合法'] }
      config = next
      return { ok: true }
    },
    setSecret: async () => {},
    unsetSecret: async () => {},
    ping: async (peer) => ({ online: true, peer: peer.id }),
    listWorkspaces: async () => ({ workspaces: [{ id: 'ws-1', title: '测试工作区', path: 'E:\\ws' }] }),
    getTasks: () => ({ outbound: [], inbound: [] }),
    cancelTask: async () => {},
    ...overrides,
  }
}

/** 构造一个模拟浏览器请求的 Request。 */
function makeRequest(method, payload, { rpcId = 'rpc-1', endpoint = RPC_ENDPOINT } = {}) {
  return new Request(`http://localhost${RPC_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { method, payload } }),
  })
}

describe('rpc', () => {
  describe('createDispatcher', () => {
    it('state 返回当前状态', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('state', {})
      assert.equal(result.ok, true)
      assert.equal(result.value.config.nodeId, 'test-node')
    })

    it('save 校验失败时带回 errors 与 details', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('save', { config: { nodeId: 'bad/id' } })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'validation')
      assert.deepEqual(result.error.details.errors, ['节点 ID 不合法'])
    })

    it('save 成功时回写状态', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('save', { config: { nodeId: 'next-node' } })
      assert.equal(result.ok, true)
      assert.equal(result.value.config.nodeId, 'next-node')
    })

    it('tasks 透传任务表', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('tasks', {})
      assert.equal(result.ok, true)
      assert.deepEqual(result.value, { outbound: [], inbound: [] })
    })

    it('workspaces 返回可绑定的工作区', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('workspaces', {})
      assert.equal(result.ok, true)
      assert.deepEqual(result.value.workspaces, [{ id: 'ws-1', title: '测试工作区', path: 'E:\\ws' }])
    })

    it('未知方法返回带 details 的失败', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('nope', {})
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'not_found')
      assert.equal(typeof result.error.details, 'object')
    })

    it('处理异常被转成 internal 失败', async () => {
      const dispatch = createDispatcher(makeHandlers({
        getState: () => { throw new Error('boom') },
      }))
      const result = await dispatch('state', {})
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'internal')
      assert.match(result.error.message, /boom/)
    })

    it('secret 空值被拒绝', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('secret', { action: 'set', value: '' })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bad_request')
    })

    it('ping 缺 id 被拒绝', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('ping', { peer: {} })
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bad_request')
    })

    it('cancel 缺 taskId 被拒绝', async () => {
      const dispatch = createDispatcher(makeHandlers())
      const result = await dispatch('cancel', {})
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'bad_request')
    })
  })

  describe('createRpcRoute', () => {
    it('路径与端点名匹配 Connection 的精确路由约束', () => {
      const route = createRpcRoute(makeHandlers())
      assert.equal(route.path, '/api/dsh-awp')
      assert.deepEqual(route.methods, ['POST'])
      assert.equal(route.requestBody, 'buffered')
      assert.equal(typeof route.fetch, 'function')
      // 路径末段必须与客户端 rpc.call 的端点名一致
      assert.equal(route.path.split('/').pop(), RPC_ENDPOINT)
      // 精确路由的端点必须满足 ENDPOINT_SEGMENT_PATTERN
      assert.match(RPC_ENDPOINT, /^[A-Za-z0-9_$.-]+$/)
    })

    it('正常请求返回 server-response 信封并回显 rpcId', async () => {
      const route = createRpcRoute(makeHandlers())
      const response = await route.fetch(makeRequest('state', {}, { rpcId: 'abc' }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.type, 'server-response')
      assert.equal(body.rpcId, 'abc')
      assert.equal(body.result.ok, true)
      assert.equal(body.result.value.config.nodeId, 'test-node')
    })

    it('非 JSON 请求体被拒绝（415）', async () => {
      const route = createRpcRoute(makeHandlers())
      const request = new Request(`http://localhost${RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'hi',
      })
      const response = await route.fetch(request)
      assert.equal(response.status, 415)
    })

    it('端点名不匹配时返回 bad-request 结果', async () => {
      const route = createRpcRoute(makeHandlers())
      const response = await route.fetch(makeRequest('state', {}, { endpoint: 'other' }))
      const body = await response.json()
      assert.equal(body.result.ok, false)
      assert.equal(body.result.error.code, 'gateway/bad-request')
    })

    it('缺少 payload.method 时返回 bad-request 结果', async () => {
      const route = createRpcRoute(makeHandlers())
      const request = new Request(`http://localhost${RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: RPC_ENDPOINT, payload: {} }),
      })
      const body = await (await route.fetch(request)).json()
      assert.equal(body.result.ok, false)
      assert.equal(body.result.error.code, 'gateway/bad-request')
    })
  })

  describe('serverResponse', () => {
    it('生成标准信封', () => {
      assert.deepEqual(serverResponse('id', { ok: true, value: 1 }), {
        type: 'server-response', rpcId: 'id', result: { ok: true, value: 1 },
      })
    })
  })

  describe('registerRpc', () => {
    it('走 fetch.register，且绝不调用 rpc.intercept', () => {
      const calls = { fetchRegister: 0, intercept: 0 }
      let route
      const ctx = {
        get: (name) => name === 'connection' ? {
          fetch: {
            register: (r) => {
              calls.fetchRegister++
              route = r
              return () => Promise.resolve()
            },
          },
          rpc: {
            intercept: () => {
              calls.intercept++
              return () => Promise.resolve()
            },
          },
        } : undefined,
        effect: (fn) => { fn() },
      }
      registerRpc(ctx, makeHandlers())
      assert.equal(calls.fetchRegister, 1, '必须注册精确路由')
      assert.equal(calls.intercept, 0, '绝不能占用 /api 的 interceptor')
      assert.equal(route.path, RPC_PATH)
    })

    it('连接服务缺失时只记日志，不抛错', () => {
      const messages = []
      const ctx = { get: () => undefined, effect: () => {} }
      assert.doesNotThrow(() => registerRpc(ctx, makeHandlers(), (level, message) => messages.push(message)))
      assert.equal(messages.length, 1)
    })

    it('注册抛错时不冒泡到 Host', () => {
      const logs = []
      const ctx = {
        get: () => ({
          fetch: { register: () => { throw new Error('route already registered') } },
        }),
        effect: (fn) => { fn() },
      }
      assert.doesNotThrow(() => registerRpc(ctx, makeHandlers(), (level, message) => logs.push(`${level}:${message}`)))
      assert.ok(logs.some((line) => line.includes('route already registered')))
    })

    it('释放函数被正确串接', () => {
      let released = false
      const ctx = {
        get: () => ({ fetch: { register: () => () => { released = true; return Promise.resolve() } } }),
        effect: (fn) => { fn()() },
      }
      registerRpc(ctx, makeHandlers())
      assert.equal(released, true)
    })
  })
})
