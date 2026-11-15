/**
 * AWP/1 的 MQTT 传输（docs/PROTOCOL.md 第 7.2 节）。
 *
 * - 订阅自己的收件箱 `{topic}/{nodeId}`，发往 `{topic}/{to}`。
 * - QoS 1、不保留；客户端 id 固定为 `awp-{nodeId}`，使用持久会话。
 * - 没有同步回复，所有回复都作为新消息发布。
 *
 * `mqtt` 包按需动态加载，HTTP 模式下不需要它。
 * @module dsh-awp/core/mqtt-transport
 */

import { AwpError } from './frame.js'

/** MQTT 传输。 */
export class MqttTransport {
  /**
   * @param {object} options - 传输选项。
   * @param {string} options.nodeId - 本节点 ID。
   * @param {string} options.url - broker 地址，如 `mqtts://broker:8883`。
   * @param {string} options.topic - 主题前缀，如 `awp/team1`。
   * @param {string} [options.username] - broker 用户名。
   * @param {string} [options.password] - broker 密码。
   * @param {(level: string, message: string) => void} [options.log] - 日志函数。
   */
  constructor({ nodeId, url, topic, username, password, log = () => {} }) {
    this.nodeId = nodeId
    this.url = url
    this.topic = topic.replace(/\/+$/, '')
    this.username = username
    this.password = password
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
   * 连接 broker 并订阅收件箱。
   * @param {(frame: string) => Promise<unknown>} onFrame - 收到帧时调用。
   * @returns {Promise<{ inbox: string }>} 订阅的主题。
   * @throws {Error} 缺少 mqtt 依赖或首次连接失败。
   */
  async start(onFrame) {
    let mqtt
    try {
      mqtt = await import('mqtt')
    } catch {
      throw new AwpError('config', 'MQTT 依赖未安装，请重新安装插件或执行 pnpm install')
    }
    const connect = mqtt.connect ?? mqtt.default?.connect
    const client = connect(this.url, {
      clientId: `awp-${this.nodeId}`,
      clean: false,
      reconnectPeriod: 5_000,
      connectTimeout: 15_000,
      ...(this.username ? { username: this.username } : {}),
      ...(this.password ? { password: this.password } : {}),
    })
    this.client = client
    client.on('message', (topic, payload) => {
      if (topic !== this.inbox) return
      onFrame(payload.toString('utf8')).catch((error) => {
        this.log('warn', `处理 MQTT 消息失败：${error?.message ?? error}`)
      })
    })
    client.on('error', (error) => this.log('warn', `MQTT 错误：${error?.message ?? error}`))
    client.on('reconnect', () => this.log('info', 'MQTT 正在重连'))
    await new Promise((resolve, reject) => {
      const onConnect = () => {
        client.off('error', onError)
        resolve()
      }
      const onError = (error) => {
        client.off('connect', onConnect)
        reject(error)
      }
      client.once('connect', onConnect)
      client.once('error', onError)
    })
    await client.subscribeAsync(this.inbox, { qos: 1 })
    return { inbox: this.inbox }
  }

  /**
   * 发布一个帧到对端收件箱。
   * @param {string} to - 对端节点 ID。
   * @param {string} frame - 帧文本。
   * @returns {Promise<{}>} MQTT 没有同步回复。
   * @throws {AwpError} 未连接或发布失败（`unreachable`）。
   */
  async send(to, frame) {
    if (!this.client) throw new AwpError('unreachable', 'MQTT 未连接')
    try {
      await this.client.publishAsync(`${this.topic}/${to}`, frame, { qos: 1, retain: false })
    } catch (error) {
      throw new AwpError('unreachable', `MQTT 发布失败：${error?.message ?? error}`)
    }
    return {}
  }

  /**
   * 断开连接。
   * @returns {Promise<void>}
   */
  async stop() {
    const client = this.client
    this.client = null
    if (client) await client.endAsync(true).catch(() => {})
  }
}
