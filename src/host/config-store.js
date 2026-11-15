/**
 * 插件配置文件读写与校验。
 *
 * 配置文件：`$DSH_HOME/dsh-awp/config.json`。
 * 密钥不存在这个文件里，存在 DSH 凭据库或环境变量。
 * @module dsh-awp/host/config-store
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { isNodeId } from '../core/frame.js'

/**
 * 默认配置。
 */
export function defaultConfig() {
  return {
    version: 1,
    nodeId: '',
    transport: 'http',
    http: { host: '127.0.0.1', port: 7820, maxBodyBytes: 1_048_576 },
    mqtt: {
      url: '',
      topic: '',
      username: '',
      // 自定义 CA：给自建 broker 用。caFile 是 server.pem 的绝对路径，
      // caPem 是直接粘贴的证书内容，两者只能选一个。
      caFile: '',
      caPem: '',
      // TLS 证书校验使用的主机名（证书 CN/SAN 与连接地址不一致时填）。
      servername: '',
      // 关闭证书校验：只用于自签测试，生产不要开。
      allowInvalidCert: false,
    },
    peers: [],
    worker: {
      enabled: false,
      // 绑定一个 DSH 工作区（不是裸路径）：任务的会话就建在这个工作区里。
      workspaceId: '',
      model: { provider: '', model: '' },
      reasoningEffort: '',
      agentPreset: '',
      maxConcurrent: 1,
      maxQueue: 10,
      defaultTimeoutSec: 3600,
      maxTimeoutSec: 14400,
      allowRelay: false,
    },
    delegator: { enabled: true },
  }
}

/**
 * 规范化并校验配置。
 *
 * 保持同步：异步函数会让调用点漏掉 `await`，把 Promise 当对象解构，
 * 表现为 `Cannot read properties of undefined (reading 'length')`。
 * @param {unknown} raw - 待校验的配置。
 * @returns {{ config: object, errors: string[] }} 规范化后的配置与错误列表。
 */
export function validateConfig(raw) {
  const errors = []
  const config = { ...defaultConfig(), ...(typeof raw === 'object' && raw ? raw : {}) }
  if (!config.nodeId) {
    try {
      config.nodeId = hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63)
    } catch {
      config.nodeId = `node-${Date.now().toString(36)}`
    }
  }
  if (!isNodeId(config.nodeId)) errors.push('节点 ID 不合法')
  if (!['http', 'mqtt'].includes(config.transport)) errors.push('通信方式必须是 http 或 mqtt')
  if (config.transport === 'http') {
    if (typeof config.http?.host !== 'string' || !config.http.host) errors.push('HTTP 监听地址不能为空')
    if (!Number.isInteger(config.http?.port) || config.http.port < 1 || config.http.port > 65535) {
      errors.push('HTTP 端口必须是 1-65535')
    }
  }
  if (config.transport === 'mqtt') {
    if (!config.mqtt?.url || !/^mqtts?:\/\/.+/.test(config.mqtt.url)) errors.push('MQTT 地址不合法')
    if (!config.mqtt?.topic || /[+#]/.test(config.mqtt.topic)) errors.push('MQTT 主题前缀不合法')
    const caFile = typeof config.mqtt?.caFile === 'string' ? config.mqtt.caFile.trim() : ''
    const caPem = typeof config.mqtt?.caPem === 'string' ? config.mqtt.caPem.trim() : ''
    if (caFile && caPem) errors.push('CA 证书只能选一种来源：文件路径或粘贴内容')
    if (caFile && !isAbsolute(caFile)) errors.push('CA 证书文件需要绝对路径')
    if (caPem && !caPem.includes('BEGIN CERTIFICATE')) errors.push('粘贴的 CA 证书不是 PEM 格式')
    if (config.mqtt?.allowInvalidCert === true && /^mqtt:\/\//.test(config.mqtt.url ?? '')) {
      // 明文连接本来就没有证书，开关无意义但不阻塞启动
      config.mqtt.allowInvalidCert = false
    }
  }
  if (!Array.isArray(config.peers)) config.peers = []
  const seen = new Set()
  for (const peer of config.peers) {
    if (!isNodeId(peer.id)) errors.push(`对端 ${peer.id} 的 ID 不合法`)
    // 允许对端就是自己：这是本机自测（自发自收）的标准做法。
    if (seen.has(peer.id)) errors.push(`对端 ${peer.id} 重复`)
    seen.add(peer.id)
    if (peer.url && !/^https?:\/\/.+/.test(peer.url)) errors.push(`对端 ${peer.id} 的 URL 不合法`)
  }
  if (config.worker?.enabled) {
    if (!config.worker.workspaceId) {
      errors.push('执行方需要绑定一个 DSH 工作区')
    }
    if (config.worker.workspaceId && typeof config.worker.workspaceId !== 'string') {
      errors.push('工作区 ID 不合法')
    }
    if (!Number.isInteger(config.worker.maxConcurrent) || config.worker.maxConcurrent < 1) {
      config.worker.maxConcurrent = 1
    }
    if (!Number.isInteger(config.worker.maxQueue) || config.worker.maxQueue < 0) {
      config.worker.maxQueue = 10
    }
  }
  return { config, errors }
}

/**
 * 判断一份配置是否必须配置共享密钥。
 *
 * 只有**真正的回环地址**可以无密钥运行；`0.0.0.0` / `::` 表示监听所有网卡，
 * 属于对外暴露，必须验签。
 * @param {object} config - 已校验的配置。
 * @returns {boolean} 是否必须配置密钥。
 */
export function requiresSecret(config) {
  if (!config) return true
  if (config.transport === 'mqtt') return true
  return !isLoopbackHost(config.http?.host)
}

/**
 * 判断监听地址是否为本机回环。
 * @param {string} [host] - 监听地址。
 * @returns {boolean} 是否为回环地址。
 */
export function isLoopbackHost(host) {
  if (typeof host !== 'string') return false
  const value = host.trim().toLowerCase()
  if (value === 'localhost') return true
  if (value === '::1' || value === '[::1]') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

/**
 * 配置存储。
 */
export class ConfigStore {
  /**
   * @param {string} path - 配置文件路径。
   * @param {(level: string, message: string) => void} [log] - 日志函数。
   */
  constructor(path, log = () => {}) {
    this.path = path
    this.log = log
  }

  /**
   * 从文件加载配置。
   * @returns {Promise<{ config: object, errors: string[] }>} 配置与错误。
   */
  async load() {
    try {
      const text = await readFile(this.path, 'utf8')
      const raw = JSON.parse(text)
      return validateConfig(raw)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return validateConfig(defaultConfig())
      }
      this.log('warn', `加载配置失败：${error?.message ?? error}`)
      return { config: defaultConfig(), errors: ['配置文件损坏'] }
    }
  }

  /**
   * 保存配置到文件。
   * @param {object} config - 已校验的配置。
   */
  async save(config) {
    const text = JSON.stringify(config, null, 2)
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, text, 'utf8')
    await writeFile(this.path, text, 'utf8')
  }
}

/**
 * 解析 DSH_HOME。
 * @returns {string} DSH_HOME 的绝对路径。
 */
export function resolveDshHome() {
  const env = process.env.DSH_HOME
  if (env) return env
  return join(homedir(), '.dsh')
}
