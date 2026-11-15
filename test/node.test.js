/**
 * 双节点端到端测试：真实 HTTP 监听 + 真实请求。
 *
 * 这里覆盖的是曾经导致「测试对端一直卡住」的缺陷：接收方的回复帧必须
 * 真的写回 HTTP 响应体，否则请求方只能等到超时。
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { AwpNode } from '../src/core/node.js'
import { HttpTransport } from '../src/core/http-transport.js'
import { makeEnvelope, encodeFrame, decodeFrame } from '../src/core/frame.js'

const SECRET = 'test-secret-0123456789abcdef'
const nodes = []

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {})
})

/**
 * 起一个节点。
 * @param {object} options - 节点选项。
 * @param {string} options.nodeId - 节点 ID。
 * @param {Map<string, { url?: string }>} options.peers - 对端。
 * @param {string} [options.secret] - 共享密钥。
 * @param {(envelope: object) => Promise<object | null>} options.handle - 消息处理器。
 * @returns {Promise<{ node: AwpNode, port: number }>} 节点与监听端口。
 */
async function startNode({ nodeId, peers, secret = SECRET, handle }) {
  const transport = new HttpTransport({ nodeId, host: '127.0.0.1', port: 0 })
  const node = new AwpNode({ nodeId, secret, transport, peers, log: () => {} })
  const { port } = await node.start(handle)
  nodes.push(node)
  return { node, port }
}

describe('node (http e2e)', () => {
  it('ping 能收到同步回复（回归：回复帧必须写回响应体）', async () => {
    const a = await startNode({
      nodeId: 'node-a',
      peers: new Map([['node-b', {}]]),
      handle: async (envelope) => envelope.type === 'ping'
        ? makeEnvelope({
          type: 'pong', from: 'node-a', to: envelope.from, re: envelope.id,
          body: { agent: 'dsh', worker: false },
        })
        : null,
    })
    const b = await startNode({
      nodeId: 'node-b',
      peers: new Map([['node-a', { url: `http://127.0.0.1:${a.port}` }]]),
      handle: async () => null,
    })
    const pong = await b.node.ping('node-a')
    assert.equal(pong.agent, 'dsh')
    assert.equal(pong.worker, false)
  })

  it('task 请求能同步拿到 status 回复', async () => {
    const a = await startNode({
      nodeId: 'node-a',
      peers: new Map([['node-b', {}]]),
      handle: async (envelope) => envelope.type === 'task'
        ? makeEnvelope({
          type: 'status', from: 'node-a', to: envelope.from, task: envelope.task, re: envelope.id,
          body: { state: 'running' },
        })
        : null,
    })
    const b = await startNode({
      nodeId: 'node-b',
      peers: new Map([['node-a', { url: `http://127.0.0.1:${a.port}` }]]),
      handle: async () => null,
    })
    const envelope = makeEnvelope({
      type: 'task', from: 'node-b', to: 'node-a', task: 't-1', body: { prompt: 'hi' },
    })
    const reply = await b.node.request('node-a', envelope, { retries: 0 })
    assert.equal(reply.type, 'status')
    assert.equal(reply.body.state, 'running')
    assert.equal(reply.re, envelope.id)
  })

  it('单节点自连（对端就是自己）也能 ping 通', async () => {
    let self
    const started = await startNode({
      nodeId: 'local-test',
      peers: new Map([['local-test', {}]]),
      handle: async (envelope) => envelope.type === 'ping'
        ? makeEnvelope({
          type: 'pong', from: 'local-test', to: envelope.from, re: envelope.id,
          body: { agent: 'dsh', worker: true },
        })
        : null,
    })
    self = started
    self.node.peers = new Map([['local-test', { url: `http://127.0.0.1:${started.port}` }]])
    const pong = await self.node.ping('local-test')
    assert.equal(pong.worker, true)
  })

  it('密钥不一致时拒绝', async () => {
    const a = await startNode({
      nodeId: 'node-a',
      peers: new Map([['node-b', {}]]),
      handle: async (envelope) => makeEnvelope({
        type: 'pong', from: 'node-a', to: envelope.from, re: envelope.id, body: {},
      }),
    })
    const b = await startNode({
      nodeId: 'node-b',
      secret: 'another-secret-0123456789abcdef',
      peers: new Map([['node-a', { url: `http://127.0.0.1:${a.port}` }]]),
      handle: async () => null,
    })
    await assert.rejects(
      () => b.node.ping('node-a'),
      (error) => error.code === 'bad_sig',
    )
  })

  it('未知对端发来的消息被拒绝', async () => {
    const a = await startNode({
      nodeId: 'node-a',
      peers: new Map(),
      handle: async (envelope) => makeEnvelope({
        type: 'pong', from: 'node-a', to: envelope.from, re: envelope.id, body: {},
      }),
    })
    const b = await startNode({
      nodeId: 'node-b',
      peers: new Map([['node-a', { url: `http://127.0.0.1:${a.port}` }]]),
      handle: async () => null,
    })
    await assert.rejects(
      () => b.node.ping('node-a'),
      (error) => error.code === 'unknown_peer',
    )
  })

  it('处理器返回缺 id/ts 的裸信封时，回复帧仍被补齐（回归：探测超时）', async () => {
    const a = await startNode({
      nodeId: 'node-a',
      peers: new Map([['node-b', {}]]),
      // 故意不经过 makeEnvelope，模拟曾经导致 ping 超时的写法
      handle: async (envelope) => ({
        type: 'pong', from: 'node-a', to: envelope.from, re: envelope.id, body: { agent: 'dsh' },
      }),
    })
    const b = await startNode({
      nodeId: 'node-b',
      peers: new Map([['node-a', { url: `http://127.0.0.1:${a.port}` }]]),
      handle: async () => null,
    })
    const pong = await b.node.ping('node-a')
    assert.equal(pong.agent, 'dsh')
  })

  it('对端重试同一个消息 id 时重放上次回复，而不是回 204', async () => {
    let received = 0
    const a = await startNode({
      nodeId: 'node-a',
      peers: new Map([['node-b', {}]]),
      handle: async (envelope) => {
        received += 1
        return makeEnvelope({
          type: 'pong', from: 'node-a', to: envelope.from, re: envelope.id, body: { agent: 'dsh' },
        })
      },
    })
    const url = `http://127.0.0.1:${a.port}/awp`
    const envelope = makeEnvelope({ type: 'ping', from: 'node-b', to: 'node-a' })
    const frame = encodeFrame(envelope, SECRET)
    const post = async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: frame,
      })
      return { status: response.status, text: await response.text() }
    }
    const first = await post()
    const second = await post()
    assert.equal(first.status, 200)
    assert.equal(second.status, 200, '重试必须拿到重放的回复，而不是 204')
    assert.equal(first.text, second.text)
    assert.equal(received, 1, '重试不会再执行一次业务逻辑')
  })
})

describe('node lifecycle', () => {
  it('发送迟迟不完成时请求仍会超时，稍后的发送失败不会产生未处理拒绝', { timeout: 2000 }, async () => {
    let rejectSend
    const transport = {
      syncReply: false,
      async start() {},
      send() { return new Promise((_, reject) => { rejectSend = reject }) },
      async stop() {},
    }
    const node = new AwpNode({ nodeId: 'a', transport, peers: new Map([['b', {}]]) })
    await node.start(async () => null)
    try {
      await assert.rejects(
        node.request('b', makeEnvelope({ type: 'ping', from: 'a', to: 'b' }), { timeoutMs: 20, retries: 0 }),
        (error) => error.code === 'timeout',
      )
      assert.equal(node.pending.size, 0)
      rejectSend(new Error('迟到的发布失败'))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      await node.stop()
    }
  })

  it('停止节点会取消正在发送的请求，不必等 publish 完成', { timeout: 2000 }, async () => {
    let confirmSending
    const sending = new Promise((resolve) => { confirmSending = resolve })
    const transport = {
      syncReply: false,
      async start() {},
      send() { confirmSending(); return new Promise(() => {}) },
      async stop() {},
    }
    const node = new AwpNode({ nodeId: 'a', transport, peers: new Map([['b', {}]]) })
    await node.start(async () => null)
    const rejected = assert.rejects(
      node.request('b', makeEnvelope({ type: 'ping', from: 'a', to: 'b' }), { timeoutMs: 10_000 }),
      (error) => error.code === 'cancelled',
    )
    await sending
    await node.stop()
    await rejected
    assert.equal(node.pending.size, 0)
  })

  it('停止节点会中断重试退避，避免关闭后继续发送', { timeout: 2000 }, async () => {
    let confirmRetry
    const retrying = new Promise((resolve) => { confirmRetry = resolve })
    let sends = 0
    const transport = {
      syncReply: false,
      async start() {},
      async send() { sends += 1; throw new Error('连接中断') },
      async stop() {},
    }
    const node = new AwpNode({
      nodeId: 'a', transport, peers: new Map([['b', {}]]),
      log: (_level, message) => { if (message.includes('后重试')) confirmRetry() },
    })
    await node.start(async () => null)
    const rejected = assert.rejects(
      node.request('b', makeEnvelope({ type: 'ping', from: 'a', to: 'b' })),
      (error) => error.code === 'cancelled',
    )
    await retrying
    await node.stop()
    await rejected
    assert.equal(sends, 1)
  })

  /** 一个只记录调用次数的假传输层。 */
  function fakeTransport({ fail = null } = {}) {
    return {
      starts: 0,
      stops: 0,
      async start() {
        this.starts += 1
        if (fail) throw fail
        return { ok: true }
      },
      async stop() {
        this.stops += 1
      },
    }
  }

  it('start 失败时回滚 started、清理传输层，且不安装新 transport', async () => {
    const previous = fakeTransport()
    const node = new AwpNode({
      nodeId: 'node-a', secret: SECRET, transport: previous, peers: new Map(), log: () => {},
    })
    const failing = fakeTransport({ fail: new Error('boom') })
    await assert.rejects(() => node.start(async () => null, failing), /boom/)
    assert.equal(node.started, false, '启动失败后必须回滚，否则后续重启永远报 Node already started')
    assert.equal(node.transport, previous, '启动成功的传输层才能安装到节点上')
    assert.equal(failing.stops, 1, '启动失败的传输层必须被清理，避免留下重连定时器')
  })

  it('启动失败后可以再次 start（回归：Node already started 僵死）', async () => {
    const good = fakeTransport()
    const node = new AwpNode({
      nodeId: 'node-a', secret: SECRET, transport: good, peers: new Map(), log: () => {},
    })
    await assert.rejects(() => node.start(async () => null, fakeTransport({ fail: new Error('boom') })))
    const address = await node.start(async () => null, good)
    assert.deepEqual(address, { ok: true })
    assert.equal(node.started, true)
    await node.stop()
  })

  it('stop 会立即取消等待中的请求，而不是按重试间隔拖住关闭', async () => {
    const transport = {
      syncReply: false,
      async start() {},
      async send() {
        return {}
      },
      async stop() {},
    }
    const node = new AwpNode({
      nodeId: 'node-b', secret: SECRET, transport, peers: new Map([['node-a', {}]]), log: () => {},
    })
    await node.start(async () => null)
    const envelope = makeEnvelope({ type: 'ping', from: 'node-b', to: 'node-a' })
    const pending = node.request('node-a', envelope, { timeoutMs: 10_000, retries: 3 })
    await new Promise((resolve) => setImmediate(resolve))
    const startedAt = Date.now()
    await node.stop()
    await assert.rejects(pending, (error) => error.code === 'cancelled')
    assert.ok(Date.now() - startedAt < 1000, '取消不能等待 2s/4s/8s 的重试间隔')
  })

  it('异步传输在 send 之前登记等待者，发布尚未确认也能返回提前到达的回复', { timeout: 2000 }, async () => {
    let onFrame = null
    const transport = {
      syncReply: false,
      async start(handler) {
        onFrame = handler
        return {}
      },
      async send(to, frame) {
        const ping = decodeFrame(frame, { secret: SECRET })
        const pong = makeEnvelope({
          type: 'pong', from: 'node-a', to: 'node-b', re: ping.id, body: { agent: 'dsh' },
        })
        // 模拟对端已经回复，但 broker 始终没有确认此次发布。
        await onFrame(encodeFrame(pong, SECRET))
        return new Promise(() => {})
      },
      async stop() {},
    }
    const node = new AwpNode({
      nodeId: 'node-b', secret: SECRET, transport, peers: new Map([['node-a', {}]]), log: () => {},
    })
    await node.start(async () => null)
    const envelope = makeEnvelope({ type: 'ping', from: 'node-b', to: 'node-a' })
    const reply = await node.request('node-a', envelope, { timeoutMs: 200, retries: 0 })
    assert.equal(reply.type, 'pong')
    assert.equal(reply.body.agent, 'dsh')
    await node.stop()
  })
})
