/**
 * AWP 节点：协议核心的入口，连接传输层、去重缓存和消息处理。
 *
 * 职责：
 * - 管理传输层（HTTP / MQTT）的启停。
 * - 收到帧时：解码、校验密钥和时间窗口、检查对端允许列表、去重、调用上层处理器。
 * - 发送帧时：编码、签名、通过传输层投递、必要时重试。
 * - 请求-回复关联：`request()` 发出并等待匹配的回复（通过 `re` 字段或 HTTP 同步响应）。
 *
 * 不包含 DSH 相关逻辑，可以被 CLI 和未来的 Claude Code / Codex 适配器复用。
 * @module dsh-awp/core/node
 */

import { decodeFrame, encodeFrame, makeEnvelope, newId, validateEnvelope, AwpError } from './frame.js'
import { DedupeCache } from './dedupe.js'
import { setTimeout as wait } from 'node:timers/promises'

/** AWP 节点。 */
export class AwpNode {
  /** 当前运行周期的取消信号，用于终止请求的重试等待。 */
  #requests = new AbortController()

  /**
   * @param {object} options - 节点选项。
   * @param {string} options.nodeId - 本节点 ID。
   * @param {string} [options.secret] - 共享密钥。
   * @param {object} options.transport - 传输层实例（HttpTransport / MqttTransport）。
   * @param {Map<string, { url?: string }>} options.peers - 对端映射（id → { url }）。
   * @param {(level: string, message: string, meta?: object) => void} [options.log] - 日志函数。
   * @param {number} [options.windowMs] - 时间窗口。
   */
  constructor({ nodeId, secret, transport, peers, log = () => {}, windowMs }) {
    this.nodeId = nodeId
    this.secret = secret
    this.transport = transport
    this.peers = peers
    this.log = log
    this.windowMs = windowMs
    this.dedupe = new DedupeCache()
    /** @type {Map<string, { frame: string, at: number }>} 去重键 → 已发出的回复帧（供重试重放）。 */
    this.replies = new Map()
    /** @type {Map<string, { promise: Promise<object>, resolve: (reply: object) => void, reject: (error: Error) => void, cancel: () => void }>} 请求 id → 等待中的回复。 */
    this.pending = new Map()
    /** @type {((envelope: object) => Promise<void>) | null} 上层消息处理器。 */
    this.onMessage = null
    this.started = false
  }

  /**
   * 启动节点。
   *
   * 传输层只有在**成功启动后**才会安装到节点上；启动失败会回滚 `started`
   * 并清理传输层。这样不会留下「node 已启动、但 node.transport 是从未启动的
   * 实例」的半启动状态——那种状态下所有发送都会报 `MQTT 未连接`，而 UI 仍显示运行中。
   * @param {(envelope: object) => Promise<object | null>} onMessage - 收到非回复消息时调用。
   * @param {object} [transport] - 本次使用的传输层；省略时沿用构造时的实例。
   * @returns {Promise<object>} 传输层返回的地址信息。
   * @throws {Error} 节点已启动或传输层启动失败。
   */
  async start(onMessage, transport = this.transport) {
    if (this.started) throw new Error('Node already started')
    if (!transport || typeof transport.start !== 'function') {
      throw new AwpError('config', 'transport is not available')
    }
    const previousOnMessage = this.onMessage
    this.onMessage = onMessage
    let address
    try {
      address = await transport.start((frame) => this.#onFrame(frame))
    } catch (error) {
      // start 失败必须回滚，否则后续 restart 会撞上 "Node already started"。
      this.onMessage = previousOnMessage
      if (typeof transport.stop === 'function') {
        await transport.stop().catch(() => {})
      }
      throw error
    }
    this.transport = transport
    this.#requests = new AbortController()
    this.started = true
    return address
  }

  /**
   * 停止节点。
   */
  async stop() {
    this.started = false
    this.#requests.abort(new AwpError('cancelled', 'node stopped'))
    this.onMessage = null
    for (const waiter of this.pending.values()) {
      waiter.reject(new AwpError('cancelled', 'node stopped'))
    }
    this.pending.clear()
    await this.transport.stop()
  }

  /**
   * 处理收到的帧。
   * @param {string} frame - 帧文本。
   * @returns {Promise<{ reply?: string, replyTo?: string, error?: string }>}
   *   协议错误码，或回复帧及其收件人（MQTT 等无同步回复的传输层据此发布）。
   */
  async #onFrame(frame) {
    let envelope
    try {
      envelope = decodeFrame(frame, { secret: this.secret, windowMs: this.windowMs })
    } catch (error) {
      if (error instanceof AwpError) {
        this.log('warn', `收到不合法的帧：${error.code}`, { code: error.code })
        return { error: error.code }
      }
      throw error
    }
    if (envelope.to !== this.nodeId) {
      this.log('warn', `收到发给其他节点的消息：to=${envelope.to}`)
      return { error: 'bad_frame' }
    }
    if (!this.peers.has(envelope.from)) {
      this.log('warn', `收到来自未知对端的消息：from=${envelope.from}`)
      return { error: 'unknown_peer' }
    }
    const dedupeKey = `${envelope.from}:${envelope.id}`
    if (this.dedupe.seen(dedupeKey)) {
      // 重复请求：重放上次的回复帧。直接回 204 会让对端转入「等待异步回复」
      // 并最终超时——对端重试时正是这条路径。
      const cached = this.replies.get(dedupeKey)
      this.log('debug', `重复消息：${envelope.id}${cached ? '（重放回复）' : ''}`)
      return cached ? { reply: cached.frame, replyTo: envelope.from } : {}
    }
    // 回复消息：匹配等待中的请求。
    if (envelope.re && this.pending.has(envelope.re)) {
      const waiter = this.pending.get(envelope.re)
      this.pending.delete(envelope.re)
      waiter.resolve(envelope)
    }
    // 所有非请求的消息（status、result、pong）都交给上层。
    // 上层返回信封表示「需要立即回复」：HTTP 走同步响应体，MQTT 由调用方另行发布。
    const isReply = ['pong', 'status', 'result'].includes(envelope.type)
    let reply = null
    if (isReply || !envelope.re) {
      if (this.onMessage) {
        reply = await this.onMessage(envelope).catch((error) => {
          this.log('error', `处理消息失败：${error?.message ?? error}`, { type: envelope.type, from: envelope.from })
          return null
        }) ?? null
      }
    }
    if (reply && typeof reply === 'object') {
      // 防御：回复信封缺 id/ts 时补齐。否则对端会判为 bad_frame，重试又会撞上
      // 我方去重缓存拿到 204，最终在对端表现为「无回复超时」——极难排查。
      const finalized = {
        id: typeof reply.id === 'string' && reply.id !== '' ? reply.id : newId(),
        ts: Number.isSafeInteger(reply.ts) ? reply.ts : Date.now(),
        ...reply,
      }
      try {
        validateEnvelope(finalized)
      } catch (error) {
        this.log('error', `回复信封不合法，已丢弃：${error?.message ?? error}`, { type: finalized.type })
        return {}
      }
      const frame = encodeFrame(finalized, this.secret)
      this.#rememberReply(dedupeKey, frame)
      return { reply: frame, replyTo: envelope.from }
    }
    return {}
  }

  /**
   * 记住一条回复帧，供对端重试时重放。
   * @param {string} key - 去重键。
   * @param {string} frame - 已编码的回复帧。
   */
  #rememberReply(key, frame) {
    this.replies.set(key, { frame, at: Date.now() })
    if (this.replies.size <= 5000) return
    const cutoff = Date.now() - 3_600_000
    for (const [entryKey, entry] of this.replies) {
      if (entry.at >= cutoff && this.replies.size <= 4000) break
      this.replies.delete(entryKey)
    }
  }

  /**
   * 发送请求并等待回复。
   * @param {string} to - 对端节点 ID。
   * @param {object} envelope - 信封（已含 from/to/type 等）。
   * @param {object} [options] - 发送选项。
   * @param {number} [options.timeoutMs] - 等待回复的超时，默认 15 秒。
   * @param {number} [options.retries] - 重试次数，默认 3。
   * @returns {Promise<object>} 对端回复的信封。
   * @throws {AwpError} 超时、网络失败、协议错误。
   */
  async request(to, envelope, { timeoutMs = 15_000, retries = 3 } = {}) {
    if (!this.started) throw new AwpError('not_started', 'node not started')
    const peer = this.peers.get(to)
    if (!peer) throw new AwpError('unknown_peer', `peer ${to} not configured`)
    const frame = encodeFrame(envelope, this.secret)
    const signal = this.#requests.signal
    const transport = this.transport
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      signal.throwIfAborted()
      // MQTT 这类异步传输必须在 publish 之前登记等待者：对端的回复可能先于
      // send() 返回，先发布后登记会漏掉回复并误报超时。
      let waiter = transport.syncReply === false
        ? this.#createWaiter(envelope.id, to, timeoutMs)
        : null
      try {
        // 发送可能一直等不到 PUBACK；立即监听两个 Promise，超时、取消或
        // 对端回复都不能被未完成的发送挡住。失败较晚的发送也由 race 接住。
        const sending = Promise.resolve().then(() => {
          signal.throwIfAborted()
          return transport.send(peer.url ?? to, frame, { timeoutMs })
        })
        const completed = waiter
          ? await Promise.race([
            sending.then((outcome) => ({ outcome })),
            waiter.promise.then((reply) => ({ reply })),
          ])
          : { outcome: await sending }
        signal.throwIfAborted()
        if (completed.reply) return completed.reply
        const { outcome } = completed
        // HTTP 同步回复。
        if (outcome.reply) {
          waiter?.cancel()
          waiter = null
          const reply = decodeFrame(outcome.reply, { secret: this.secret, windowMs: this.windowMs })
          if (reply.from !== to || reply.to !== this.nodeId) {
            throw new AwpError('bad_frame', 'reply from/to mismatch')
          }
          return reply
        }
        // MQTT / HTTP 204：等待异步回复。
        waiter ??= this.#createWaiter(envelope.id, to, timeoutMs)
        return await waiter.promise
      } catch (error) {
        waiter?.cancel()
        lastError = error
        // 这些错误重试也不会成功；cancelled 表示节点正在停止，重试只会拖住关闭流程。
        if (error instanceof AwpError && ['bad_sig', 'expired', 'unknown_peer', 'cancelled'].includes(error.code)) {
          throw error
        }
        if (attempt < retries) {
          const delay = Math.min(2000 * 2 ** attempt, 30_000)
          this.log('debug', `请求失败，${delay}ms 后重试：${error?.message ?? error}`)
          try {
            await wait(delay, undefined, { signal })
          } catch (error) {
            throw signal.aborted ? signal.reason : error
          }
        }
      } finally {
        waiter?.cancel()
      }
    }
    throw lastError
  }

  /**
   * 登记一个等待回复的请求。
   * @param {string} id - 消息 id。
   * @param {string} to - 对端节点 ID，仅用于超时说明。
   * @param {number} timeoutMs - 超时毫秒数。
   * @returns {{ promise: Promise<object>, resolve: (reply: object) => void, reject: (error: Error) => void, cancel: () => void }}
   *   等待句柄；`cancel()` 用于已经拿到同步回复或发送失败时清理。
   */
  #createWaiter(id, to, timeoutMs) {
    let timer
    const waiter = {
      promise: null,
      resolve: () => {},
      reject: () => {},
      cancel: () => {},
    }
    const cleanup = () => {
      if (this.pending.get(id) === waiter) this.pending.delete(id)
      if (timer !== undefined) clearTimeout(timer)
    }
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = (reply) => {
        cleanup()
        resolve(reply)
      }
      waiter.reject = (error) => {
        cleanup()
        reject(error)
      }
    })
    waiter.cancel = cleanup
    this.pending.set(id, waiter)
    timer = setTimeout(() => {
      waiter.reject(new AwpError('timeout', `no reply from ${to} within ${timeoutMs}ms`))
    }, timeoutMs)
    return waiter
  }

  /**
   * 单向发送（fire-and-forget），失败时只记日志。
   * @param {string} to - 对端节点 ID。
   * @param {object} envelope - 信封。
   */
  push(to, envelope) {
    if (!this.started) return
    const peer = this.peers.get(to)
    if (!peer) {
      this.log('warn', `无法推送给未知对端：${to}`)
      return
    }
    const frame = encodeFrame(envelope, this.secret)
    this.transport.send(peer.url ?? to, frame).catch((error) => {
      this.log('warn', `推送失败：to=${to}, ${error?.message ?? error}`)
    })
  }

  /**
   * 构造并发送 ping。
   * @param {string} to - 对端节点 ID。
   * @returns {Promise<object>} pong.body。
   */
  async ping(to) {
    const envelope = makeEnvelope({ type: 'ping', from: this.nodeId, to })
    const reply = await this.request(to, envelope)
    if (reply.type !== 'pong') throw new AwpError('bad_frame', `expected pong, got ${reply.type}`)
    return reply.body
  }
}
