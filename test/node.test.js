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
import { makeEnvelope, encodeFrame } from '../src/core/frame.js'

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
