/**
 * 委派方：发送任务、等待结果、注入回会话。
 *
 * 职责：
 * - `send()`：生成任务 id、发送 task 消息、可选同步等待结果。
 * - 收到 `status`：更新本地记录。
 * - 收到 `result`：更新记录、注入到发起会话（除非同步等待已消费）。
 * - 定期恢复：对未终结的任务发 `query`。
 * @module dsh-awp/host/delegator
 */

import { newId, makeEnvelope } from '../core/frame.js'

/**
 * 委派方。
 */
export class Delegator {
  /**
   * @param {object} options - 委派方选项。
   * @param {object} options.node - AWP 节点。
   * @param {object} options.harness - Harness 实例。
   * @param {object} options.store - TaskStore 实例。
   * @param {(level: string, message: string, meta?: object) => void} [options.log] - 日志函数。
   */
  constructor({ node, harness, store, log = () => {} }) {
    this.node = node
    this.harness = harness
    this.store = store
    this.log = log
    /** @type {Map<string, (result: object) => void>} 等待中的任务 id → resolve。 */
    this.waiters = new Map()
    this.recoveryTimer = null
  }

  /**
   * 启动委派方。
   */
  start() {
    this.#scheduleRecovery()
  }

  /**
   * 发送任务。
   * @param {object} options - 任务选项。
   * @param {string} options.peer - 对端节点 ID。
   * @param {string} options.prompt - 任务说明。
   * @param {string} options.originSessionId - 发起会话 ID。
   * @param {string} [options.title] - 短标题。
   * @param {number} [options.timeoutSec] - 执行超时。
   * @param {string} [options.follow] - 先前任务 id。
   * @param {number} [options.waitSec] - 同步等待时长。
   * @returns {Promise<{ task: string, state: string, result?: object }>} 任务 id 与初始状态（或结果）。
   */
  async send({ peer, prompt, originSessionId, title, timeoutSec, follow, waitSec = 0 }) {
    const taskId = newId('t-')
    const envelope = makeEnvelope({
      type: 'task',
      from: this.node.nodeId,
      to: peer,
      task: taskId,
      body: { prompt, title, timeout: timeoutSec, follow },
    })
    const record = {
      task: taskId,
      peer,
      title: title ?? '无标题',
      prompt,
      originSessionId,
      state: 'pending',
      createdAt: Date.now(),
      timeoutSec,
      delivered: false,
    }
    this.store.setOutbound(taskId, record)
    try {
      const reply = await this.node.request(peer, envelope, { timeoutMs: 15_000 })
      if (reply.type === 'status') {
        record.state = reply.body.state
        this.store.setOutbound(taskId, record)
        if (waitSec > 0) {
          const result = await this.#wait(taskId, waitSec * 1000)
          if (result) {
            record.delivered = true
            this.store.setOutbound(taskId, record)
            return { task: taskId, state: result.state, result }
          }
        }
        return { task: taskId, state: record.state }
      }
      if (reply.type === 'result') {
        record.state = reply.body.state
        record.result = reply.body
        this.store.setOutbound(taskId, record)
        if (waitSec > 0) {
          record.delivered = true
          this.store.setOutbound(taskId, record)
          return { task: taskId, state: record.state, result: reply.body }
        }
        this.#deliverResult(taskId, reply.body)
        return { task: taskId, state: record.state, result: reply.body }
      }
      throw new Error(`unexpected reply type: ${reply.type}`)
    } catch (error) {
      record.state = 'failed'
      record.result = { state: 'failed', error: { code: error.code ?? 'unreachable', message: error.message } }
      this.store.setOutbound(taskId, record)
      throw error
    }
  }

  /**
   * 等待任务结果。
   * @param {string} taskId - 任务 ID。
   * @param {number} timeoutMs - 等待超时。
   * @returns {Promise<object | null>} 结果，或超时时 null。
   */
  #wait(taskId, timeoutMs) {
    return new Promise((resolve) => {
      this.waiters.set(taskId, resolve)
      setTimeout(() => {
        if (this.waiters.delete(taskId)) resolve(null)
      }, timeoutMs)
    })
  }

  /**
   * 处理收到的消息。
   * @param {object} envelope - 信封。
   */
  async handle(envelope) {
    const { task, type, body } = envelope
    const record = this.store.getOutbound(task)
    if (!record) return
    if (type === 'status') {
      record.state = body.state
      this.store.setOutbound(task, record)
    }
    if (type === 'result') {
      record.state = body.state
      record.result = body
      this.store.setOutbound(task, record)
      const waiter = this.waiters.get(task)
      if (waiter) {
        this.waiters.delete(task)
        waiter(body)
        record.delivered = true
        this.store.setOutbound(task, record)
      } else {
        this.#deliverResult(task, body)
      }
    }
  }

  #deliverResult(taskId, result) {
    const record = this.store.getOutbound(taskId)
    if (!record || record.delivered) return
    const text = result.state === 'done'
      ? `[AWP 结果] ${record.peer} 完成任务 ${taskId}（${record.title}），用时 ${Math.round((result.elapsed ?? 0) / 1000)} 秒：\n\n${result.text}`
      : `[AWP 结果] ${record.peer} 任务 ${taskId} 失败（${record.title}），状态 ${result.state}：${result.error?.message ?? '未知原因'}`
    this.harness.prompt({ sessionId: record.originSessionId, text }).then(() => {
      record.delivered = true
      this.store.setOutbound(taskId, record)
    }).catch((error) => {
      this.log('warn', `注入结果失败：${error?.message ?? error}`, { task: taskId })
    })
  }

  /**
   * 查询任务状态。
   * @param {string} taskId - 任务 ID。
   * @returns {Promise<{ state: string, result?: object }>} 本地状态。
   */
  async status(taskId) {
    const record = this.store.getOutbound(taskId)
    if (!record) throw new Error('任务不存在')
    if (record.state !== 'queued' && record.state !== 'running') {
      return { state: record.state, result: record.result }
    }
    try {
      const envelope = makeEnvelope({ type: 'query', from: this.node.nodeId, to: record.peer, task: taskId })
      const reply = await this.node.request(record.peer, envelope, { timeoutMs: 10_000, retries: 1 })
      if (reply.type === 'status') {
        record.state = reply.body.state
        this.store.setOutbound(taskId, record)
        return { state: record.state }
      }
      if (reply.type === 'result') {
        record.state = reply.body.state
        record.result = reply.body
        this.store.setOutbound(taskId, record)
        if (!record.delivered) this.#deliverResult(taskId, reply.body)
        return { state: record.state, result: reply.body }
      }
    } catch (error) {
      this.log('warn', `查询任务失败：${error?.message ?? error}`, { task: taskId })
    }
    return { state: record.state, result: record.result }
  }

  /**
   * 取消任务。
   * @param {string} taskId - 任务 ID。
   */
  async cancel(taskId) {
    const record = this.store.getOutbound(taskId)
    if (!record) throw new Error('任务不存在')
    if (record.state !== 'queued' && record.state !== 'running') return
    const envelope = makeEnvelope({ type: 'cancel', from: this.node.nodeId, to: record.peer, task: taskId })
    await this.node.request(record.peer, envelope, { timeoutMs: 10_000, retries: 1 })
  }

  #scheduleRecovery() {
    this.recoveryTimer = setInterval(() => {
      this.#recover().catch((error) => this.log('warn', `恢复任务失败：${error?.message ?? error}`))
    }, 30_000)
    this.#recover().catch(() => {})
  }

  async #recover() {
    const now = Date.now()
    for (const record of this.store.list('outbound', 200)) {
      if (record.state !== 'queued' && record.state !== 'running') {
        if (!record.delivered && record.result) {
          this.#deliverResult(record.task, record.result)
        }
        continue
      }
      const peer = this.node.peers.get(record.peer)
      const elapsed = now - record.createdAt
      const overdue = elapsed > (record.timeoutSec ?? 3600) * 1000 + 300_000
      if (!peer?.url || overdue || !record.lastQuery) {
        record.lastQuery = now
        this.store.setOutbound(record.task, record)
        this.status(record.task).catch(() => {})
      }
    }
  }

  /**
   * 停止委派方。
   */
  stop() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer)
      this.recoveryTimer = null
    }
    for (const resolve of this.waiters.values()) {
      resolve(null)
    }
    this.waiters.clear()
  }
}
