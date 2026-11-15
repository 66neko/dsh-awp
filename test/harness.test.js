/**
 * harness.js 单元测试。
 *
 * 锁住三条曾经踩过的契约：
 * 1. gateway 请求字段是 `namespace`/`method`/`args`（不是 `endpoint`/`payload`）；
 * 2. Remote 参数包在 `{ request: {...} }` 里；
 * 3. gateway **成功返回业务值、失败抛异常**，没有 `{ ok, value }` 信封。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Harness } from '../src/host/harness.js'

/**
 * 构造假 ctx，记录 gateway 请求。
 * @param {(request: object) => unknown} respond - 返回业务值或抛异常。
 * @returns {{ ctx: object, calls: object[] }} 上下文与调用记录。
 */
function makeCtx(respond = () => ({})) {
  const calls = []
  const peer = { id: 'peer-1', dispose: async () => {} }
  const ctx = {
    typertGateway: {
      async invoke(request) {
        calls.push(request)
        return respond(request)
      },
    },
    connection: { createPeer: () => peer },
    get: () => undefined,
  }
  return { ctx, calls }
}

describe('harness', () => {
  describe('invoke', () => {
    it('按 namespace/method/args 调用 gateway', async () => {
      const { ctx, calls } = makeCtx()
      const harness = new Harness(ctx)
      await harness.invoke('session', 'create', { request: { cwd: 'D:/x' } })
      const request = calls[0]
      assert.equal(request.namespace, 'session')
      assert.equal(request.method, 'create')
      assert.deepEqual(request.args, { request: { cwd: 'D:/x' } })
      assert.ok(request.peer)
      assert.equal('endpoint' in request, false)
      assert.equal('payload' in request, false)
    })

    it('复用同一个 owner Peer', async () => {
      const { ctx, calls } = makeCtx()
      const harness = new Harness(ctx)
      await harness.invoke('session', 'modelCatalog')
      await harness.invoke('session', 'modelCatalog')
      assert.equal(calls[0].peer, calls[1].peer)
    })

    it('gateway 抛出的异常被包装成带方法名的错误', async () => {
      const { ctx } = makeCtx(() => { throw new Error('boom') })
      const harness = new Harness(ctx)
      await assert.rejects(
        () => harness.invoke('session', 'create'),
        /session\/create 失败：boom/,
      )
    })
  })

  describe('createSession', () => {
    it('直接使用返回的业务值里的 sessionId', async () => {
      const { ctx, calls } = makeCtx(() => ({ sessionId: 'session-1' }))
      const harness = new Harness(ctx)
      const id = await harness.createSession({ cwd: 'D:/work', agentPreset: 'standard' })
      assert.equal(id, 'session-1')
      assert.deepEqual(Object.keys(calls[0].args), ['request'])
      assert.equal(calls[0].args.request.cwd, 'D:/work')
      assert.equal(calls[0].args.request.agentPreset, 'standard')
    })

    it('返回值没有 sessionId 时报错', async () => {
      const { ctx } = makeCtx(() => ({}))
      const harness = new Harness(ctx)
      await assert.rejects(
        () => harness.createSession({ cwd: 'D:/work' }),
        /缺少 sessionId/,
      )
    })

    it('gateway 异常时带上失败原因', async () => {
      const { ctx } = makeCtx(() => { throw new Error('磁盘不可写') })
      const harness = new Harness(ctx)
      await assert.rejects(
        () => harness.createSession({ cwd: 'D:/nope' }),
        /磁盘不可写/,
      )
    })
  })

  describe('prompt', () => {
    it('生成 requestId 并以 queue 模式提交文本', async () => {
      const { ctx, calls } = makeCtx(() => ({ accepted: true }))
      const harness = new Harness(ctx)
      const requestId = await harness.prompt({ sessionId: 'session-1', text: 'hello' })
      assert.ok(typeof requestId === 'string' && requestId.length > 0)
      const request = calls[0].args.request
      assert.equal(calls[0].method, 'prompt')
      assert.equal(request.sessionId, 'session-1')
      assert.equal(request.mode, 'queue')
      assert.deepEqual(request.content, [{ type: 'text', text: 'hello' }])
    })
  })

  describe('其它会话方法', () => {
    it('selectModel / rename / cancel 都包 request', async () => {
      const { ctx, calls } = makeCtx(() => ({}))
      const harness = new Harness(ctx)
      await harness.selectModel({ sessionId: 's1', provider: 'deepseek', model: 'chat', reasoningEffort: 'high' })
      await harness.rename('s1', '标题')
      await harness.cancel('s1')
      for (const call of calls) {
        assert.deepEqual(Object.keys(call.args), ['request'], call.method)
      }
      assert.equal(calls[0].args.request.reasoningEffort, 'high')
      assert.equal(calls[1].args.request.title, '标题')
      assert.equal(calls[2].args.request.sessionId, 's1')
    })

    it('modelCatalog 不接受参数', async () => {
      const { ctx, calls } = makeCtx(() => ({ groups: [] }))
      const harness = new Harness(ctx)
      const catalog = await harness.modelCatalog()
      assert.deepEqual(calls[0].args, {})
      assert.deepEqual(catalog, { groups: [] })
    })
  })

  describe('setFullAccess', () => {
    it('对已激活的会话设置 danger-full-access', async () => {
      const { ctx } = makeCtx()
      const applied = []
      const session = { id: 'session-1' }
      ctx.get = (name) => {
        if (name === 'permissionPresets') return { set: (target, preset) => applied.push([target, preset]) }
        if (name === 'agents') return { get: () => ({ session }) }
        return undefined
      }
      const harness = new Harness(ctx)
      await harness.setFullAccess('session-1')
      assert.deepEqual(applied, [[session, 'danger-full-access']])
    })

    it('权限服务缺失时报错', async () => {
      const { ctx } = makeCtx()
      const harness = new Harness(ctx)
      await assert.rejects(() => harness.setFullAccess('session-1'), /permissionPresets/)
    })
  })

  describe('listPresets', () => {
    it('服务缺失时返回空数组', async () => {
      const { ctx } = makeCtx()
      const harness = new Harness(ctx)
      assert.deepEqual(await harness.listPresets(), [])
    })

    it('读取 remoteExportList 的结果', async () => {
      const { ctx } = makeCtx()
      ctx.get = (name) => (name === 'agentPresets'
        ? { remoteExportList: async () => ({ presets: [{ id: 'standard' }] }) }
        : undefined)
      const harness = new Harness(ctx)
      assert.deepEqual(await harness.listPresets(), [{ id: 'standard' }])
    })
  })
})
