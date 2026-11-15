/**
 * AWP/1 帧编解码与信封校验。
 *
 * 帧格式（见 docs/PROTOCOL.md 第 2 节）：
 *
 *   AWP/1 <sig>\n<json>
 *
 * 本模块是纯函数集合，不做任何 I/O，不依赖 DSH。
 * @module dsh-awp/core/frame
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

/** 协议标识。 */
export const MAGIC = 'AWP/1'

/** 节点 ID 规则：可直接用作 MQTT 主题段。 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

/** 允许的消息类型。 */
export const MESSAGE_TYPES = Object.freeze(['ping', 'pong', 'task', 'status', 'result', 'cancel', 'query'])

/** 需要 `task` 字段的消息类型。 */
export const TASK_TYPES = Object.freeze(['task', 'status', 'result', 'cancel', 'query'])

/** `status.state` 的取值（非终态）。 */
export const STATUS_STATES = Object.freeze(['queued', 'running'])

/** `result.state` 的取值（终态）。 */
export const RESULT_STATES = Object.freeze(['done', 'failed', 'cancelled', 'timeout', 'rejected'])

/** 默认时间窗口：5 分钟。 */
export const DEFAULT_WINDOW_MS = 300_000

/**
 * 协议错误。`code` 取自 docs/PROTOCOL.md 第 5 节的错误码。
 */
export class AwpError extends Error {
  /**
   * @param {string} code - 协议错误码，如 `bad_frame`、`bad_sig`。
   * @param {string} message - 便于排查的说明，不得包含密钥。
   */
  constructor(code, message) {
    super(message)
    this.name = 'AwpError'
    this.code = code
  }
}

/**
 * 生成一个消息 id 或任务 id。
 * @param {string} [prefix] - 可选前缀，例如任务 id 用 `t-`。
 * @returns {string} 全局唯一的字符串。
 */
export function newId(prefix = '') {
  return `${prefix}${randomUUID()}`
}

/**
 * 计算 JSON 文本的签名。
 * @param {string} json - 信封 JSON 的原始文本。
 * @param {string} secret - 共享密钥。
 * @returns {string} 小写十六进制 HMAC-SHA256。
 */
export function sign(json, secret) {
  return createHmac('sha256', secret).update(json, 'utf8').digest('hex')
}

/**
 * 把信封编码成帧。
 * @param {object} envelope - 已校验的信封。
 * @param {string} [secret] - 共享密钥；为空时签名写 `-`。
 * @returns {string} 完整帧文本。
 */
export function encodeFrame(envelope, secret) {
  const json = JSON.stringify(envelope)
  const sig = secret ? sign(json, secret) : '-'
  return `${MAGIC} ${sig}\n${json}`
}

/**
 * 解析并校验一个帧。
 * @param {string} frame - 收到的帧文本。
 * @param {object} options - 校验选项。
 * @param {string} [options.secret] - 共享密钥。设置时必须验签，且拒绝 `-`。
 * @param {number} [options.now] - 当前时间（毫秒），测试时可注入。
 * @param {number} [options.windowMs] - 允许的时间偏差。
 * @returns {object} 校验通过的信封。
 * @throws {AwpError} `bad_frame`、`bad_sig` 或 `expired`。
 */
export function decodeFrame(frame, { secret, now = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (typeof frame !== 'string') throw new AwpError('bad_frame', 'frame is not text')
  const newline = frame.indexOf('\n')
  if (newline < 0) throw new AwpError('bad_frame', 'missing header line')
  const header = frame.slice(0, newline).replace(/\r$/, '')
  const json = frame.slice(newline + 1).replace(/\r?\n$/, '')
  const parts = header.split(' ')
  if (parts.length !== 2 || parts[0] !== MAGIC || parts[1] === '') {
    throw new AwpError('bad_frame', 'bad header line')
  }
  const sig = parts[1]
  if (secret) {
    if (!/^[0-9a-f]{64}$/.test(sig)) throw new AwpError('bad_sig', 'signature missing or malformed')
    const want = Buffer.from(sign(json, secret), 'hex')
    const got = Buffer.from(sig, 'hex')
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw new AwpError('bad_sig', 'signature mismatch')
    }
  }
  let envelope
  try {
    envelope = JSON.parse(json)
  } catch {
    throw new AwpError('bad_frame', 'body is not JSON')
  }
  validateEnvelope(envelope)
  if (Math.abs(now - envelope.ts) > windowMs) {
    throw new AwpError('expired', 'timestamp outside the accepted window')
  }
  return envelope
}

/**
 * 校验信封字段（不含签名和时间窗口）。
 * @param {unknown} envelope - 待校验对象。
 * @throws {AwpError} `bad_frame`，说明第一个不合法的字段。
 */
export function validateEnvelope(envelope) {
  const fail = (message) => { throw new AwpError('bad_frame', message) }
  if (!isRecord(envelope)) fail('envelope must be an object')
  if (typeof envelope.id !== 'string' || envelope.id === '' || envelope.id.length > 128) fail('bad id')
  if (!MESSAGE_TYPES.includes(envelope.type)) fail('unknown type')
  if (!isNodeId(envelope.from)) fail('bad from')
  if (!isNodeId(envelope.to)) fail('bad to')
  if (!Number.isSafeInteger(envelope.ts)) fail('bad ts')
  if (TASK_TYPES.includes(envelope.type)) {
    if (typeof envelope.task !== 'string' || envelope.task === '' || envelope.task.length > 128) fail('bad task')
  }
  if (envelope.re !== undefined && typeof envelope.re !== 'string') fail('bad re')
  if (envelope.body !== undefined && !isRecord(envelope.body)) fail('body must be an object')
  const body = envelope.body ?? {}
  if (envelope.type === 'task' && (typeof body.prompt !== 'string' || body.prompt.trim() === '')) fail('task.prompt required')
  if (envelope.type === 'status' && !STATUS_STATES.includes(body.state)) fail('bad status.state')
  if (envelope.type === 'result' && !RESULT_STATES.includes(body.state)) fail('bad result.state')
}

/**
 * 构造信封。
 * @param {object} fields - 信封字段。
 * @param {string} fields.type - 消息类型。
 * @param {string} fields.from - 发送方节点 ID。
 * @param {string} fields.to - 接收方节点 ID。
 * @param {string} [fields.task] - 任务 id。
 * @param {string} [fields.re] - 所回复消息的 id。
 * @param {object} [fields.body] - 消息内容。
 * @param {string} [fields.id] - 指定消息 id（重发时复用）。
 * @param {number} [fields.ts] - 指定时间戳。
 * @returns {object} 校验通过的信封。
 * @throws {AwpError} 字段不合法时抛出 `bad_frame`。
 */
export function makeEnvelope({ type, from, to, task, re, body, id, ts }) {
  const envelope = {
    id: id ?? newId(),
    type,
    from,
    to,
    ts: ts ?? Date.now(),
    ...(task === undefined ? {} : { task }),
    ...(re === undefined ? {} : { re }),
    body: body ?? {},
  }
  validateEnvelope(envelope)
  return envelope
}

/**
 * 判断是否是合法节点 ID。
 * @param {unknown} value - 待检查的值。
 * @returns {boolean} 是否合法。
 */
export function isNodeId(value) {
  return typeof value === 'string' && NODE_ID_PATTERN.test(value)
}

/**
 * 判断是否是普通对象。
 * @param {unknown} value - 待检查的值。
 * @returns {boolean} 是否为非数组对象。
 */
export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
