/**
 * 执行方：接收任务、创建会话、等待完成、回传结果。
 *
 * 职责：
 * - 收到 `task` 消息：校验、排队或拒绝、创建会话、发送提示、等待完成。
 * - 监听 `session/event`，在 `turn/end` 时提取最终助手回答。
 * - 推送 `status`（queued / running）和 `result`（done / failed / cancelled / timeout）。
 * - 处理 `cancel` 和 `query` 请求。
 * @module dsh-awp/host/worker
 */

import { makeEnvelope } from '../core/frame.js'
import { restrictWorkerSession } from './tools.js'

/**
 * 判定「会话无事可做」前的宽限期（毫秒）：提示刚提交时可能瞬时 idle。
 */
const IDLE_GRACE_MS = 4_000

/**
 * 从会话历史记录里取最后一条助手文本。
 * @param {ReadonlyArray<object>} records - `session/wait` 返回的记录。
 * @returns {string} 助手文本，没有则为空串。
 */
function extractAssistantText(records) {
  let text = ''
  for (const item of records) {
    const event = item?.event ?? item
    if (event?.type !== 'assistant/message') continue
    const content = event.data?.message?.content ?? []
    const joined = content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
    if (joined) text = joined
  }
  return text
}

/**
 * 执行方。
 */
export class Worker {
  /**
   * @param {object} options - 执行方选项。
   * @param {object} options.node - AWP 节点。
   * @param {object} options.harness - Harness 实例。
   * @param {object} options.store - TaskStore 实例。
   * @param {object} options.ctx - Cordis 上下文。
   * @param {object} options.config - 执行方配置。
   * @param {(level: string, message: string, meta?: object) => void} [options.log] - 日志函数。
   */
  constructor({ node, harness, store, ctx, config, log = () => {} }) {
    this.node = node
    this.harness = harness
    this.store = store
    this.ctx = ctx
    this.config = config
    this.log = log
    /** @type {string[]} 排队中的任务 id。 */
    this.queue = []
    /** @type {Map<string, object>} 运行中的任务 id → runner。 */
    this.running = new Map()
    /** @type {Set<string>} 执行方会话 id 集合，用于工具限制。 */
    this.workerSessions = new Set()
  }

  /**
   * 启动执行方。
   */
  start() {
    this.ctx.on('session/event', (session, event) => this.#onSessionEvent(session, event), { global: true })
  }

  /**
   * 处理收到的消息。
   * @param {object} envelope - 信封。
   * @returns {Promise<object | null>} 立即回复的信封，或 null。
   */
  async handle(envelope) {
    if (envelope.type === 'task') return await this.#onTask(envelope)
    if (envelope.type === 'cancel') return await this.#onCancel(envelope)
    if (envelope.type === 'query') return await this.#onQuery(envelope)
    return null
  }

  async #onTask(envelope) {
    const { task, from, body } = envelope
    const existing = this.store.getInbound(task)
    if (existing) {
      // 幂等：已知任务，返回当前状态。
      if (existing.state === 'queued' || existing.state === 'running') {
        return makeEnvelope({ type: 'status', from: this.node.nodeId, to: from, task, re: envelope.id, body: { state: existing.state } })
      }
      return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id, body: existing.result })
    }
    if (!this.config.enabled) {
      return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id,
        body: { state: 'rejected', error: { code: 'not_worker', message: '执行方未启用' } },
      })
    }
    const record = {
      task,
      from,
      title: body.title ?? '无标题任务',
      prompt: body.prompt,
      follow: body.follow,
      state: 'queued',
      createdAt: Date.now(),
      timeoutSec: Math.min(body.timeout ?? this.config.defaultTimeoutSec, this.config.maxTimeoutSec),
    }
    this.store.setInbound(task, record)
    if (this.running.size < this.config.maxConcurrent) {
      this.#startTask(task)
      return makeEnvelope({ type: 'status', from: this.node.nodeId, to: from, task, re: envelope.id, body: { state: 'running' } })
    }
    if (this.queue.length >= this.config.maxQueue) {
      record.state = 'rejected'
      record.result = { state: 'rejected', error: { code: 'busy', message: '队列已满' } }
      this.store.setInbound(task, record)
      return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id, body: record.result })
    }
    this.queue.push(task)
    return makeEnvelope({ type: 'status', from: this.node.nodeId, to: from, task, re: envelope.id, body: { state: 'queued' } })
  }

  async #onCancel(envelope) {
    const { task, from } = envelope
    const record = this.store.getInbound(task)
    if (!record) {
      return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id,
        body: { state: 'failed', error: { code: 'unknown_task', message: '任务不存在' } },
      })
    }
    if (record.state === 'queued') {
      this.queue = this.queue.filter((id) => id !== task)
      record.state = 'cancelled'
      record.result = { state: 'cancelled' }
      this.store.setInbound(task, record)
      return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id, body: record.result })
    }
    if (record.state === 'running') {
      const runner = this.running.get(task)
      if (runner?.sessionId) {
        this.harness.cancel(runner.sessionId).catch(() => {})
      }
      return makeEnvelope({ type: 'status', from: this.node.nodeId, to: from, task, re: envelope.id, body: { state: 'running', note: '正在取消' } })
    }
    return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id, body: record.result })
  }

  async #onQuery(envelope) {
    const { task, from } = envelope
    const record = this.store.getInbound(task)
    if (!record) {
      return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id,
        body: { state: 'failed', error: { code: 'unknown_task', message: '任务不存在' } },
      })
    }
    if (record.state === 'queued' || record.state === 'running') {
      return makeEnvelope({ type: 'status', from: this.node.nodeId, to: from, task, re: envelope.id, body: { state: record.state } })
    }
    return makeEnvelope({ type: 'result', from: this.node.nodeId, to: from, task, re: envelope.id, body: record.result })
  }

  #startTask(taskId) {
    const record = this.store.getInbound(taskId)
    if (!record) return
    record.state = 'running'
    record.startedAt = Date.now()
    this.store.setInbound(taskId, record)
    const runner = {
      task: taskId,
      sessionId: null,
      baseSeq: 0,
      text: '',
      startTime: Date.now(),
      settled: null,
    }
    this.running.set(taskId, runner)
    this.#runTask(runner, record).catch((error) => {
      this.log('error', `任务执行失败：${error?.message ?? error}`, { task: taskId })
      this.#finishTask(taskId, { state: 'failed', error: { code: 'internal', message: error?.message ?? 'unknown' } })
    })
  }

  async #runTask(runner, record) {
    const { task, from, prompt, title, timeoutSec, follow } = record
    let sessionId = null
    // 如果是 follow 任务，尝试复用之前的会话。
    if (follow) {
      const prev = this.store.getInbound(follow)
      if (prev?.sessionId && prev.from === from && !this.running.has(follow)) {
        sessionId = prev.sessionId
      }
    }
    if (!sessionId) {
      // 绑定工作区：任务会话直接建在该 DSH 工作区里，出现在该工作区的会话列表中。
      if (!this.config.workspaceId) throw new Error('执行方尚未绑定 DSH 工作区，请在设置里选择')
      sessionId = await this.harness.createSession({
        workspaceId: this.config.workspaceId,
        ...(this.config.agentPreset ? { agentPreset: this.config.agentPreset } : {}),
      })
      runner.sessionId = sessionId
      this.workerSessions.add(sessionId)
      record.sessionId = sessionId
      this.store.setInbound(task, record)
      await this.harness.setFullAccess(sessionId)
      // 执行方会话不允许再转派任务，也不允许向用户提问。
      restrictWorkerSession(this.ctx, sessionId, this.config.allowRelay === true)
      if (this.config.model?.provider && this.config.model?.model) {
        await this.harness.selectModel({ sessionId, ...this.config.model, reasoningEffort: this.config.reasoningEffort || undefined })
      }
      await this.harness.rename(sessionId, `[AWP] ${from} · ${title}`)
    } else {
      runner.sessionId = sessionId
      record.sessionId = sessionId
      this.store.setInbound(task, record)
    }
    const agents = this.ctx.get('agents')
    const agent = agents?.get(sessionId)
    if (agent) {
      runner.baseSeq = agent.session.seq
    }
    const taskPrompt = `[来自节点 ${from} 的委派任务]\n标题：${title}\n\n${prompt}\n\n注意：这是无人值守的任务。如果遇到不确定的地方，请根据你的判断自行决定，不要使用 ask_user_question 工具。完成后，你最后一条回复的内容会作为结果发回给委派方。`
    await this.harness.prompt({ sessionId, text: taskPrompt })
    this.node.push(from, makeEnvelope({ type: 'status', from: this.node.nodeId, to: from, task, body: { state: 'running' } }))
    const result = await this.#awaitCompletion(runner, timeoutSec)
    this.#finishTask(task, result)
  }

  /**
   * 等待任务结束。
   *
   * 以 `session/wait` 轮询为主、事件监听为辅：只要事件监听没接上，
   * 单纯等 `turn/end` 会让任务永久挂起（曾发生过）。轮询还能在会话
   * 始终没有产生输出时给出明确原因，而不是一直 running。
   * @param {object} runner - 运行记录。
   * @param {number} timeoutSec - 任务超时秒数。
   * @returns {Promise<object>} 结果体（state/text/error/elapsed）。
   */
  async #awaitCompletion(runner, timeoutSec) {
    const deadline = Date.now() + Math.max(1, timeoutSec) * 1000
    let lastText = ''
    let sawActivity = false
    let idleSeenAt = 0
    while (Date.now() < deadline) {
      if (runner.settled) return runner.settled
      let waited
      try {
        waited = await this.harness.wait(runner.sessionId, {
          timeoutMs: Math.min(2000, Math.max(500, deadline - Date.now())),
          afterSeq: runner.baseSeq,
        })
      } catch (error) {
        return { state: 'failed', error: { code: 'internal', message: `轮询会话失败：${error?.message ?? error}` }, elapsed: Date.now() - runner.startTime }
      }
      const records = waited?.output?.records ?? []
      if (records.length > 0) sawActivity = true
      const text = extractAssistantText(records)
      if (text) lastText = text
      if (runner.text) lastText = runner.text
      if (waited?.reason !== 'idle') {
        // input-required：执行方本机可能有人接手，继续等直到超时。
        idleSeenAt = 0
        continue
      }
      if (sawActivity || lastText) {
        return { state: 'done', text: lastText || '(无输出)', elapsed: Date.now() - runner.startTime }
      }
      // 刚提交提示时可能瞬时是 idle（Agent 还没进入 turn）。给一段宽限期，
      // 并确认会话确实没有在跑，再判定「没有输出」，避免把正常任务误判为失败。
      if (idleSeenAt === 0) idleSeenAt = Date.now()
      if (Date.now() - idleSeenAt < IDLE_GRACE_MS) continue
      let busy = false
      try {
        const state = await this.harness.state(runner.sessionId)
        busy = state?.running === true || state?.active === true
          || (Array.isArray(state?.queue) && state.queue.length > 0)
      } catch {}
      if (busy) {
        idleSeenAt = 0
        continue
      }
      return {
        state: 'failed',
        error: { code: 'no_output', message: '会话没有产生任何输出：提示可能未被接受，或该会话没有可用模型' },
        elapsed: Date.now() - runner.startTime,
      }
    }
    try {
      await this.harness.cancel(runner.sessionId)
    } catch {}
    return {
      state: 'timeout',
      ...(lastText ? { text: lastText } : {}),
      error: { code: 'timeout', message: `超过 ${timeoutSec} 秒仍未完成` },
      elapsed: Date.now() - runner.startTime,
    }
  }

  #onSessionEvent(session, event) {
    const runner = Array.from(this.running.values()).find((r) => r.sessionId === session.id)
    if (!runner || event.seq <= runner.baseSeq) return
    const type = event.type ?? event.kind
    if (type === 'assistant/message') {
      const content = event.message?.content ?? event.data?.message?.content ?? []
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim()
      if (text) runner.text = text
    }
    if (type === 'turn/end') {
      const reason = event.reason ?? event.data?.reason ?? {}
      const elapsed = Date.now() - runner.startTime
      if (reason.kind === 'completed') {
        runner.settled = { state: 'done', text: runner.text || '(无输出)', elapsed }
      } else if (reason.kind === 'aborted') {
        runner.settled = { state: 'cancelled', elapsed }
      } else if (reason.kind === 'error') {
        runner.settled = { state: 'failed', error: { code: 'llm_error', message: reason.error?.message ?? 'unknown' }, elapsed }
      } else {
        runner.settled = { state: 'failed', error: { code: 'interrupted', message: String(reason.kind ?? 'unknown') }, elapsed }
      }
      if (runner.resolve) runner.resolve()
    }
  }

  #finishTask(taskId, result) {
    const record = this.store.getInbound(taskId)
    if (!record) return
    record.state = result.state
    record.result = result
    this.store.setInbound(taskId, record)
    this.running.delete(taskId)
    this.node.push(record.from, makeEnvelope({ type: 'result', from: this.node.nodeId, to: record.from, task: taskId, body: result }))
    this.#dequeue()
  }

  #dequeue() {
    while (this.queue.length > 0 && this.running.size < this.config.maxConcurrent) {
      const taskId = this.queue.shift()
      this.#startTask(taskId)
    }
  }

  /**
   * 停止执行方。
   */
  async stop() {
    for (const runner of this.running.values()) {
      if (runner.sessionId) {
        this.harness.cancel(runner.sessionId).catch(() => {})
      }
      if (runner.reject) runner.reject(new Error('worker stopped'))
    }
    this.running.clear()
    this.queue = []
  }

  /**
   * 判断某个会话是否是执行方会话。
   * @param {string} sessionId - 会话 ID。
   * @returns {boolean}
   */
  isWorkerSession(sessionId) {
    return this.workerSessions.has(sessionId)
  }
}
