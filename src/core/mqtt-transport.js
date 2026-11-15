/**
 * AWP/1 的 MQTT 传输（docs/PROTOCOL.md 第 7.2 节）。
 *
 * - 订阅自己的收件箱 `{topic}/{nodeId}`，发往 `{topic}/{to}`。
 * - QoS 1、不保留；客户端 id 固定为 `awp-{nodeId}`，使用持久会话。
 * - 没有同步回复，所有回复都作为新消息发布。
 *
 * 依赖从 `vendor/` 加载（安装包自带），不需要安装时联网；也允许注入
 * 自定义加载器，便于单元测试。
 *
 * TLS：支持自定义 CA（`ca`）、自定义 SNI 名（`servername`），以及显式
 * 关闭证书校验（`rejectUnauthorized: false`，仅供自签测试）。
 * @module dsh-awp/core/mqtt-transport
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { AwpError, isNodeId } from './frame.js'

/**
 * 默认的 mqtt 加载器。
 *
 * 优先用 `createRequire` + **绝对路径**加载 mqtt 的 CJS 入口：这样不经过
 * ESM 的裸标识符解析，也不依赖 vendor/mqtt.js 里的 `import 'mqtt'`。
 * 某些宿主（例如 Electron 主进程里被改写的模块系统）在 ESM 解析裸标识符时
 * 会抛出 `createRequire(...).resolve.paths is not a function` 这类内部错误，
 * 走 require 绝对路径可以绕开它。
 *
 * 三条路径依次尝试，全部失败时把每一层的原因都报出来。
 * @returns {Promise<object>} 含 `connect` 的 mqtt 模块。
 * @throws {Error} 三种加载方式都失败。
 */
export async function loadVendoredMqtt() {
  const failures = []
  let requireFromHere
  try {
    requireFromHere = createRequire(import.meta.url)
  } catch (error) {
    failures.push(`createRequire: ${error?.message ?? error}`)
  }

  if (requireFromHere) {
    const cjsEntry = (() => {
      try {
        return fileURLToPath(new URL('../../vendor/node_modules/mqtt/build/index.js', import.meta.url))
      } catch {
        return null
      }
    })()
    if (cjsEntry) {
      try {
        const module = requireFromHere(cjsEntry)
        if (typeof module?.connect === 'function') return module
        failures.push('require(绝对路径): 模块缺少 connect')
      } catch (error) {
        failures.push(`require: ${error?.code ?? error?.name} ${error?.message ?? error}`)
      }
    }
    try {
      const module = requireFromHere('../../vendor/node_modules/mqtt')
      if (typeof module?.connect === 'function') return module
      failures.push('require(包目录): 模块缺少 connect')
    } catch (error) {
      failures.push(`require(包目录): ${error?.code ?? error?.name} ${error?.message ?? error}`)
    }
  }

  try {
    const module = await import('../../vendor/mqtt.js')
    const resolved = module.default ?? module
    if (typeof resolved?.connect === 'function') return resolved
    failures.push('import(vendor/mqtt.js): 模块缺少 connect')
  } catch (error) {
    failures.push(`import: ${error?.code ?? error?.name} ${error?.message ?? error}`)
  }

  throw new Error(failures.join(' / '))
}

/** MQTT 传输。 */
export class MqttTransport {
  /** 启动阶段的取消句柄，覆盖依赖加载、连接及订阅。 */
  #starting = null

  /** 客户端 → 唯一的关闭 Promise，避免失败清理与 stop 重复关闭。 */
  #ending = new WeakMap()

  /** 客户端 → 本传输层注册的监听器清理函数。 */
  #listeners = new WeakMap()

  /**
   * @param {object} options - 传输选项。
   * @param {string} options.nodeId - 本节点 ID。
   * @param {string} options.url - broker 地址，如 `mqtts://broker:8883`。
   * @param {string} options.topic - 主题前缀，如 `awp/team1`。
   * @param {string} [options.username] - broker 用户名。
   * @param {string} [options.password] - broker 密码。
   * @param {string | Buffer} [options.ca] - 自定义 CA 证书内容（PEM）。
   * @param {string} [options.servername] - TLS SNI / 证书校验使用的主机名。
   * @param {boolean} [options.rejectUnauthorized] - 是否校验服务端证书，默认 true。
   * @param {number} [options.startTimeoutMs] - 完成依赖加载、连接和订阅的总上限，默认 15000 毫秒。
   * @param {number} [options.endTimeoutMs] - 断开时等待 `endAsync` 的上限，默认 2000 毫秒。
   * @param {() => Promise<object>} [options.loadMqtt] - 自定义 mqtt 加载器（测试用）。
   * @param {(level: string, message: string) => void} [options.log] - 日志函数。
   */
  constructor({
    nodeId, url, topic, username, password,
    ca, servername, rejectUnauthorized = true, startTimeoutMs = 15_000, endTimeoutMs = 2_000,
    loadMqtt = loadVendoredMqtt, log = () => {},
  }) {
    this.nodeId = nodeId
    this.url = url
    this.topic = topic.replace(/\/+$/, '')
    this.username = username
    this.password = password
    this.ca = ca
    this.servername = servername
    this.rejectUnauthorized = rejectUnauthorized
    this.startTimeoutMs = startTimeoutMs
    this.endTimeoutMs = endTimeoutMs
    this.loadMqtt = loadMqtt
    this.log = log
    /** MQTT 不支持同步回复。 */
    this.syncReply = false
    this.client = null
  }

  /** @returns {string} 本节点的收件箱主题。 */
  get inbox() {
    return `${this.topic}/${this.nodeId}`
  }

  /**
   * 构造给 mqtt.connect 的选项（单独暴露便于测试）。
   * @returns {object} connect 选项。
   */
  connectOptions() {
    const options = {
      clientId: `awp-${this.nodeId}`,
      clean: false,
      reconnectPeriod: 5_000,
      connectTimeout: 15_000,
    }
    if (this.username) options.username = this.username
    if (this.password) options.password = this.password
    if (this.ca !== undefined && this.ca !== '') options.ca = this.ca
    if (this.servername) options.servername = this.servername
    if (this.rejectUnauthorized === false) options.rejectUnauthorized = false
    return options
  }

  /**
   * 连接 broker 并订阅收件箱。
   *
   * 连接失败（包括握手期间被 `stop()` 关闭）会清理客户端后抛出，不会把
   * 一个仍在重连的客户端留在传输层里。
   * @param {(frame: string) => Promise<{ reply?: string, replyTo?: string, error?: string } | void>} onFrame
   *   收到帧时调用；返回 `{ reply, replyTo }` 时自动发布回复。
   * @returns {Promise<{ inbox: string }>} 订阅的主题。
   * @throws {AwpError} 依赖缺失、首次连接失败或建立连接前被关闭。
   */
  async start(onFrame) {
    if (this.client || this.#starting) throw new AwpError('config', 'MQTT 传输层已启动')
    let cancel
    const interrupted = new Promise((_, reject) => { cancel = reject })
    const startup = {
      error: null,
      cancel(error) { this.error ??= error; cancel(error) },
    }
    this.#starting = startup
    const timer = setTimeout(() => {
      startup.cancel(new AwpError('timeout', `MQTT 启动在 ${this.startTimeoutMs}ms 内未完成`))
    }, this.startTimeoutMs)
    let client
    let cleanupConnection = () => {}
    try {
      const loaded = Promise.resolve().then(() => this.loadMqtt()).catch((error) => {
        throw new AwpError('config', `MQTT 依赖加载失败：${error?.message ?? error}`)
      })
      const mqtt = await Promise.race([loaded, interrupted])
      if (startup.error) throw startup.error
      const connect = mqtt.connect ?? mqtt.default?.connect
      if (typeof connect !== 'function') throw new AwpError('config', 'MQTT 依赖缺少 connect 导出')
      client = connect(this.url, this.connectOptions())
      this.client = client
      const onMessage = (topic, payload) => {
        if (topic !== this.inbox || this.client !== client) return
        this.#receive(payload.toString('utf8'), onFrame).catch((error) => {
          this.log('warn', `处理 MQTT 消息失败：${error?.message ?? error}`)
        })
      }
      const onErrorLog = (error) => this.log('warn', `MQTT 错误：${error?.message ?? error}`)
      const onReconnect = () => this.log('info', 'MQTT 正在重连')
      client.on('message', onMessage)
      client.on('error', onErrorLog)
      client.on('reconnect', onReconnect)
      this.#listeners.set(client, () => {
        client.off?.('message', onMessage)
        client.off?.('error', onErrorLog)
        client.off?.('reconnect', onReconnect)
      })
      const connected = new Promise((resolve, reject) => {
        cleanupConnection = () => {
          client.off?.('connect', onConnect)
          client.off?.('error', onError)
          client.off?.('close', onClose)
        }
        const onConnect = () => resolve()
        // 连接完成后保留 error/close 监听，订阅阶段断线也必须结束启动。
        const onError = (error) => { reject(error); startup.cancel(error) }
        const onClose = () => onError(new AwpError('unreachable', 'MQTT 连接在启动完成前关闭'))
        client.once('connect', onConnect)
        client.once('error', onError)
        client.once('close', onClose)
      })
      await Promise.race([connected, interrupted])
      if (startup.error) throw startup.error
      await Promise.race([client.subscribeAsync(this.inbox, { qos: 1 }), interrupted])
      if (startup.error) throw startup.error
      return { inbox: this.inbox }
    } catch (error) {
      cleanupConnection()
      if (this.client === client) this.client = null
      if (client) await this.#endClient(client)
      if (error instanceof AwpError) throw error
      throw new AwpError('unreachable', `MQTT 连接失败：${error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
      cleanupConnection()
      if (this.#starting === startup) this.#starting = null
    }
  }

  /**
   * 处理一条入站帧，并把 `onFrame` 返回的回复发布到对端收件箱。
   *
   * MQTT 没有同步回复通道；不发布回复就等于丢失，对端只能等到超时。
   * @param {string} frame - 帧文本。
   * @param {(frame: string) => Promise<object | void>} onFrame - 帧处理器。
   * @returns {Promise<void>}
   */
  async #receive(frame, onFrame) {
    const outcome = await onFrame(frame)
    if (!outcome || typeof outcome !== 'object') return
    // 协议级错误按 PROTOCOL 第 5 节直接丢弃，不产生回复。
    if (outcome.error || !outcome.reply) return
    const to = this.#replyRecipient(outcome)
    if (!to) {
      this.log('warn', 'MQTT 回复缺少合法收件人，已丢弃')
      return
    }
    try {
      await this.#publish(to, outcome.reply)
      this.log('debug', `已发布 MQTT 回复：${this.topic}/${to}`)
    } catch (error) {
      this.log('warn', `发布 MQTT 回复失败：${error?.message ?? error}`)
    }
  }

  /**
   * 取回复的目标节点。
   * @param {{ reply: string, replyTo?: string }} outcome - `onFrame` 的返回值。
   * @returns {string | null} 合法节点 ID，取不到时为 null。
   */
  #replyRecipient(outcome) {
    if (typeof outcome.replyTo === 'string' && isNodeId(outcome.replyTo)) return outcome.replyTo
    // 兼容只返回 { reply } 的处理器：回复帧自己的 to 字段就是收件人。
    if (typeof outcome.reply !== 'string') return null
    const newline = outcome.reply.indexOf('\n')
    if (newline < 0) return null
    try {
      const envelope = JSON.parse(outcome.reply.slice(newline + 1).replace(/\r?\n$/, ''))
      return isNodeId(envelope?.to) ? envelope.to : null
    } catch {
      return null
    }
  }

  /**
   * 发布一个帧到对端收件箱。
   * @param {string} to - 对端节点 ID。
   * @param {string} frame - 帧文本。
   * @returns {Promise<void>}
   * @throws {AwpError} 未连接或发布失败（`unreachable`）。
   */
  async #publish(to, frame) {
    const client = this.client
    if (!client) throw new AwpError('unreachable', 'MQTT 未连接')
    try {
      await client.publishAsync(`${this.topic}/${to}`, frame, { qos: 1, retain: false })
    } catch (error) {
      throw new AwpError('unreachable', `MQTT 发布失败：${error?.message ?? error}`)
    }
  }

  /**
   * 发布一个帧到对端收件箱。
   * @param {string} to - 对端节点 ID。
   * @param {string} frame - 帧文本。
   * @returns {Promise<{}>} MQTT 没有同步回复。
   * @throws {AwpError} 未连接或发布失败（`unreachable`）。
   */
  async send(to, frame) {
    await this.#publish(to, frame)
    return {}
  }

  /**
   * 断开连接。
   *
   * `endAsync()` 在握手期间可能永远不 resolve，所以最多等待 `endTimeoutMs`，
   * 超时后强制结束客户端，避免设置页保存 RPC 永久挂起。
   * @returns {Promise<void>}
   */
  async stop() {
    this.#starting?.cancel(new AwpError('cancelled', 'MQTT 启动已取消'))
    const client = this.client
    this.client = null
    if (client) await this.#endClient(client)
  }

  /**
   * 结束一个 MQTT 客户端，带超时兜底。
   * @param {object} client - mqtt 客户端。
   * @returns {Promise<void>}
   */
  #endClient(client) {
    if (!this.#ending.has(client)) {
      this.#ending.set(client, this.#closeClient(client).finally(() => {
        this.#listeners.get(client)?.()
        this.#listeners.delete(client)
      }))
    }
    return this.#ending.get(client)
  }

  /**
   * 实际关闭客户端，超过上限后销毁底层连接。
   * @param {object} client - mqtt 客户端。
   * @returns {Promise<void>}
   */
  async #closeClient(client) {
    let timer
    let settled = false
    const ended = (async () => {
      try {
        if (typeof client.endAsync === 'function') await client.endAsync(true)
        else if (typeof client.end === 'function') client.end(true)
      } catch {
        // 断开过程中的错误不影响停止流程。
      }
    })().finally(() => {
      settled = true
    })
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.endTimeoutMs)
    })
    try {
      const result = await Promise.race([ended.then(() => 'ended'), timeout])
      if (result === 'timeout' || !settled) {
        // 第二次 end 会把 endAsync 的回调补完；仍不行就销毁底层流。
        try { client.end?.(true) } catch {}
        try { client.stream?.destroy?.() } catch {}
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
