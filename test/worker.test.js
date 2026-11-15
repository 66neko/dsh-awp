/**
 * worker.js 单元测试。
 *
 * 覆盖两件容易出错的事：
 * 1. 任务完成是**异步**的：`handle()` 立即回 status，最终 result 通过 `node.push` 发出。
 * 2. 提示刚提交时会话可能瞬时 idle，不能据此判定「没有输出」。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from '../src/host/worker.js'

/**
 * 构造一个执行方。
 * @param {object} options - 选项。
 * @param {(sessionId: string, options?: object) => object} options.wait - `session/wait` 桩。
 * @param {() => object} [options.state] - `session/state` 桩。
 * @param {number} [options.timeoutSec] - worker 配置里的默认超时。
 * @returns {{ worker: Worker, pushed: object[], store: object }} 执行方与发件记录。
 */
function makeWorker({ wait, state = () => ({ running: false }), timeoutSec = 30 }) {
  const pushed = []
  const records = new Map()
  const node = {
    nodeId: 'node-a',
    peers: new Map([['node-a', {}]]),
    push: (_to, envelope) => pushed.push(envelope),
  }
  const store = {
    getInbound: (id) => records.get(id),
    setInbound: (id, record) => records.set(id, record),
  }
  const harness = {
    createSession: async () => 'session-1',
    setFullAccess: async () => {},
    rename: async () => {},
    selectModel: async () => {},
    prompt: async () => 'req-1',
    cancel: async () => {},
    wait,
    state: async () => state(),
  }
  const ctx = {
    get: (name) => (name === 'agents'
      ? { get: () => ({ session: { seq: 0 } }) }
      : undefined),
    on: () => {},
  }
  const worker = new Worker({
    node,
    harness,
    store,
    ctx,
    config: {
      enabled: true,
      workspaceId: 'ws-1',
      maxConcurrent: 1,
      maxQueue: 5,
      defaultTimeoutSec: timeoutSec,
      maxTimeoutSec: timeoutSec,
      allowRelay: false,
    },
    log: () => {},
  })
  return { worker, pushed, store }
}

/**
 * 等一个 result 信封出现。
 * @param {object[]} pushed - 发件记录。
 * @param {number} [limitMs] - 超时。
 * @returns {Promise<object>} result 信封。
 */
async function waitForResult(pushed, limitMs = 4000) {
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline) {
    const found = pushed.find((envelope) => envelope.type === 'result')
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`没有等到 result；已发出：${JSON.stringify(pushed).slice(0, 300)}`)
}

/** 构造一条 task 信封。 */
function taskEnvelope(task = 't-1') {
  return {
    id: `m-${task}`,
    type: 'task',
    from: 'node-a',
    to: 'node-a',
    ts: Date.now(),
    task,
    body: { prompt: '做点事', title: '测试' },
  }
}

describe('worker', () => {
  it('handle() 立即回 status，结果异步推送', async () => {
    const assistantRecord = {
      event: {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'OK' }] } },
      },
    }
    const { worker, pushed } = makeWorker({
      wait: async () => ({ reason: 'idle', output: { records: [assistantRecord] } }),
    })
    const reply = await worker.handle(taskEnvelope())
    assert.equal(reply.type, 'status')
    assert.equal(reply.body.state, 'running')

    const result = await waitForResult(pushed)
    assert.equal(result.body.state, 'done')
    assert.equal(result.body.text, 'OK')
  })

  it('会话瞬时 idle 但仍在运行时不误判失败', async () => {
    const { worker, pushed } = makeWorker({
      wait: async () => ({ reason: 'idle', output: { records: [] } }),
      state: () => ({ running: true, active: true }),
      timeoutSec: 2,
    })
    await worker.handle(taskEnvelope('t-2'))
    const result = await waitForResult(pushed, 6000)
    // 仍在运行 → 不应判定 no_output；到点后是 timeout
    assert.equal(result.body.state, 'timeout')
    assert.ok(!String(result.body.error?.code).includes('no_output'))
  })
})
