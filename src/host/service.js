/**
 * AWP 服务：组装所有组件、管理启停、处理配置变更。
 * @module dsh-awp/host/service
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { AwpNode } from '../core/node.js'
import { makeEnvelope } from '../core/frame.js'
import { HttpTransport } from '../core/http-transport.js'
import { MqttTransport } from '../core/mqtt-transport.js'
import { Harness } from './harness.js'
import { TaskStore } from './task-store.js'
import {
  ConfigStore, resolveDshHome, validateConfig, defaultConfig, requiresSecret,
} from './config-store.js'
import { Worker } from './worker.js'
import { Delegator } from './delegator.js'
import { registerTools } from './tools.js'
import { registerRpc } from './rpc.js'

/** 插件版本，出现在 pong 响应里。 */
const PLUGIN_VERSION = '0.3.0'

/**
 * 网络层签名：只有这些字段变化才需要重建监听与连接。
 * @param {object | null} config - 配置。
 * @returns {string} 签名。
 */
export function networkSignature(config) {
  if (!config) return ''
  return JSON.stringify({
    nodeId: config.nodeId,
    transport: config.transport,
    http: config.transport === 'http' ? config.http : null,
    mqtt: config.transport === 'mqtt'
      ? {
        url: config.mqtt?.url,
        topic: config.mqtt?.topic,
        username: config.mqtt?.username,
        caFile: config.mqtt?.caFile ?? '',
        caPem: config.mqtt?.caPem ?? '',
        servername: config.mqtt?.servername ?? '',
        allowInvalidCert: config.mqtt?.allowInvalidCert === true,
      }
      : null,
    peers: (config.peers ?? []).map((peer) => [peer.id, peer.url ?? '']),
  })
}

/** AWP 服务。 */
export class AwpService {
  /**
   * @param {object} ctx - Cordis 上下文。
   */
  constructor(ctx) {
    this.ctx = ctx
    this.dshHome = resolveDshHome()
    this.configStore = new ConfigStore(join(this.dshHome, 'dsh-awp', 'config.json'), this.#log.bind(this))
    this.taskStore = new TaskStore(join(this.dshHome, 'dsh-awp', 'tasks.json'), this.#log.bind(this))
    this.harness = new Harness(ctx)
    this.node = null
    this.worker = null
    this.delegator = null
    this.config = null
    this.secret = null
    this.mqttPassword = null
    this.startError = null
    this.workerStarted = false
    this.delegatorStarted = false
  }

  /** 启动服务。先注册设置页路由，保证配置写错时页面仍能打开修正。 */
  async start() {
    this.#registerRpc()
    await this.taskStore.load()
    const loaded = await this.configStore.load()
    const config = loaded.config
    let errors = loaded.errors
    this.config = config
    // 旧配置用的是裸目录路径：能按路径匹配到已有工作区就自动迁移，避免用户手动重配。
    if (config.worker?.enabled && !config.worker.workspaceId && typeof config.worker.workspace === 'string' && config.worker.workspace) {
      const migrated = await this.#workspaceIdForPath(config.worker.workspace)
      if (migrated) {
        config.worker.workspaceId = migrated
        delete config.worker.workspace
        errors = validateConfig(config).errors
        await this.configStore.save(config).catch(() => {})
        this.#log('info', `已把执行方目录迁移为工作区：${migrated}`)
      }
    }
    if (errors.length > 0) {
      this.startError = errors.join('; ')
      this.#log('warn', `配置错误：${this.startError}`)
      return
    }
    await this.#loadSecrets()
    await this.#startNode()
    this.#registerTools()
  }

  /**
   * 按路径查找工作区 ID。
   * @param {string} path - 目录绝对路径。
   * @returns {Promise<string | null>} 工作区 ID，找不到时为 null。
   */
  async #workspaceIdForPath(path) {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) return null
    try {
      const workspace = typeof registry.resolveByPath === 'function'
        ? await registry.resolveByPath(path)
        : registry.list().find((item) => item.path === path)
      return workspace?.id ? String(workspace.id) : null
    } catch {
      return null
    }
  }

  /** 从凭据库（或环境变量）读取共享密钥与 MQTT 密码。 */
  async #loadSecrets() {
    const creds = this.ctx.get('credentials')
    if (creds) {
      try {
        this.secret = (await creds.resolve('DSH_AWP_SECRET'))?.value ?? null
      } catch {}
      try {
        this.mqttPassword = (await creds.resolve('DSH_AWP_MQTT_PASSWORD'))?.value ?? null
      } catch {}
    }
    if (!this.secret) this.secret = process.env.DSH_AWP_SECRET ?? null
    if (!this.mqttPassword) this.mqttPassword = process.env.DSH_AWP_MQTT_PASSWORD ?? null
  }

  /** 启动（或按新配置重启）网络节点。 */
  async #startNode() {
    const { config, secret } = this
    if (requiresSecret(config) && !secret) {
      this.startError = '监听所有网卡或使用 MQTT 时必须配置共享密钥'
      this.#log('warn', this.startError)
      return
    }
    // 传输层构造可能因为 CA 证书读不到而失败：转成启动错误，不能让异常冒泡。
    let transport
    try {
      transport = this.#createTransport(config)
    } catch (error) {
      this.startError = error?.message ?? String(error)
      this.#log('error', `传输层初始化失败：${this.startError}`)
      return
    }
    // 保持 node/worker/delegator 对象标识不变：工具与委派方持有它们的引用，
    // 重建对象会让工具指向已停止的旧节点。
    if (!this.node) {
      this.node = new AwpNode({
        nodeId: config.nodeId,
        secret,
        transport,
        peers: this.#peerMap(config),
        log: this.#log.bind(this),
      })
      this.worker = new Worker({
        node: this.node,
        harness: this.harness,
        store: this.taskStore,
        ctx: this.ctx,
        config: config.worker,
        log: this.#log.bind(this),
      })
      this.delegator = new Delegator({
        node: this.node,
        harness: this.harness,
        store: this.taskStore,
        log: this.#log.bind(this),
      })
    } else {
      this.node.nodeId = config.nodeId
      this.node.secret = secret
      this.node.peers = this.#peerMap(config)
      this.node.transport = transport
      this.worker.config = config.worker
    }
    try {
      await this.node.start((envelope) => this.#handleIncoming(envelope))
      if (!this.workerStarted) {
        this.worker.start()
        this.workerStarted = true
      }
      if (!this.delegatorStarted) {
        this.delegator.start()
        this.delegatorStarted = true
      }
      this.startError = null
      this.#log('info', `AWP 节点已启动：${config.nodeId}`)
    } catch (error) {
      this.startError = error.message
      this.#log('error', `启动失败：${error.message}`)
    }
  }

  /**
   * 处理一条入站消息：先回答 ping，再交给执行方，最后由委派方消化回执。
   * @param {object} envelope - 已校验的信封。
   * @returns {Promise<object | null>} 需要立即回复的信封。
   */
  async #handleIncoming(envelope) {
    const config = this.config
    if (envelope.type === 'ping') {
      const isWorker = config?.worker?.enabled === true && !!this.worker
      // 必须用 makeEnvelope：裸对象缺少 id/ts，对端校验会判为 bad_frame，
      // 重试又撞上去重缓存拿到 204，最终表现为「探测超时」。
      return makeEnvelope({
        type: 'pong',
        from: config.nodeId,
        to: envelope.from,
        re: envelope.id,
        body: {
          agent: 'dsh',
          version: PLUGIN_VERSION,
          worker: isWorker,
          ...(isWorker ? { running: this.worker.running.size, capacity: config.worker.maxConcurrent } : {}),
        },
      })
    }
    const workerReply = await this.worker.handle(envelope)
    if (workerReply) return workerReply
    await this.delegator.handle(envelope)
    return null
  }

  /**
   * 按配置创建传输层。
   * @param {object} config - 已校验的配置。
   * @returns {object} HttpTransport 或 MqttTransport。
   * @throws {Error} MQTT 且 CA 证书文件不可读时抛出，由调用方转成启动错误。
   */
  #createTransport(config) {
    if (config.transport === 'http') {
      return new HttpTransport({
        nodeId: config.nodeId,
        host: config.http.host,
        port: config.http.port,
        maxBodyBytes: config.http.maxBodyBytes,
      })
    }
    const mqtt = config.mqtt ?? {}
    return new MqttTransport({
      nodeId: config.nodeId,
      url: mqtt.url,
      topic: mqtt.topic,
      username: mqtt.username,
      password: this.mqttPassword,
      ca: this.#readCaCertificate(mqtt),
      servername: mqtt.servername || undefined,
      rejectUnauthorized: mqtt.allowInvalidCert !== true,
      log: this.#log.bind(this),
    })
  }

  /**
   * 读取自定义 CA 证书内容。
   * @param {object} mqtt - MQTT 配置。
   * @returns {string | undefined} PEM 内容；未配置时返回 undefined。
   * @throws {Error} 指定了文件但读不到时抛出。
   */
  #readCaCertificate(mqtt) {
    const pem = typeof mqtt.caPem === 'string' ? mqtt.caPem.trim() : ''
    if (pem) return pem
    const file = typeof mqtt.caFile === 'string' ? mqtt.caFile.trim() : ''
    if (!file) return undefined
    try {
      const content = readFileSync(file, 'utf8')
      if (!content.includes('BEGIN CERTIFICATE')) {
        throw new Error('文件里没有 PEM 证书内容')
      }
      return content
    } catch (error) {
      throw new Error(`无法读取 CA 证书文件 ${file}：${error?.message ?? error}`)
    }
  }

  /**
   * 构造对端映射。
   * @param {object} config - 已校验的配置。
   * @returns {Map<string, { url?: string }>} 对端表。
   */
  #peerMap(config) {
    return new Map((config.peers ?? []).map((peer) => [peer.id, { url: peer.url }]))
  }

  /** 注册 Agent 工具（幂等：只在首次启动时注册）。 */
  #registerTools() {
    if (!this.node || this.toolsRegistered) return
    this.toolsRegistered = true
    // 通过 resolve 按需读取当前实例，避免热替换后旧工具闭包指向已失效的节点。
    registerTools(this.ctx, {
      resolve: () => (this.node && this.delegator && this.worker
        ? {
          node: this.node,
          delegator: this.delegator,
          worker: this.worker,
          allowRelay: this.config?.worker?.allowRelay === true,
        }
        : null),
    })
  }

  /** 注册设置页 RPC。 */
  #registerRpc() {
    const self = this
    registerRpc(this.ctx, {
      getState: () => self.#getState(),
      saveConfig: (config) => self.#saveConfig(config),
      setSecret: (which, value) => self.#setSecret(which, value),
      unsetSecret: (which) => self.#unsetSecret(which),
      ping: (peer) => self.#ping(peer),
      listWorkspaces: () => self.#listWorkspaces(),
      getTasks: () => self.#getTasks(),
      cancelTask: (taskId, direction) => self.#cancelTask(taskId, direction),
    }, (level, message) => self.#log(level, message))
  }

  /** @returns {object} 设置页需要的状态快照。 */
  #getState() {
    return {
      config: this.config ?? defaultConfig(),
      secretSet: !!this.secret,
      mqttPasswordSet: !!this.mqttPassword,
      running: !!this.node && !this.startError,
      error: this.startError,
    }
  }

  /**
   * 校验并保存配置，随后应用到运行中的服务。
   * @param {object} newConfig - 前端提交的配置。
   * @returns {Promise<{ ok: boolean, errors?: string[] }>} 结果。
   */
  async #saveConfig(newConfig) {
    const { config, errors } = validateConfig(newConfig)
    if (errors.length > 0) return { ok: false, errors }
    await this.configStore.save(config)
    await this.applyConfig(config)
    return { ok: true }
  }

  /**
   * 应用一份已校验的配置。
   *
   * 只有网络相关字段变化才重建节点（监听端口、对端、传输方式）；
   * 执行方参数直接更新到运行中的对象，避免每改一个字段就抢一次端口。
   * @param {object} config - 已校验的配置。
   */
  async applyConfig(config) {
    const previous = this.config
    this.config = config
    if (!this.node || networkSignature(previous) !== networkSignature(config)) {
      await this.restart(config)
      return
    }
    if (this.worker) this.worker.config = config.worker
    this.node.peers = this.#peerMap(config)
    this.startError = null
  }

  /**
   * 保存共享密钥或 MQTT 密码。
   * @param {string} which - `mqtt` 或其他值（共享密钥）。
   * @param {string} value - 密钥内容。
   */
  async #setSecret(which, value) {
    const creds = this.ctx.get('credentials')
    if (!creds) throw new Error('凭据服务不可用，无法保存密钥')
    const ref = which === 'mqtt' ? 'DSH_AWP_MQTT_PASSWORD' : 'DSH_AWP_SECRET'
    await creds.set(ref, value)
    if (which === 'mqtt') this.mqttPassword = value
    else this.secret = value
  }

  /**
   * 清除共享密钥或 MQTT 密码。
   * @param {string} which - `mqtt` 或其他值（共享密钥）。
   */
  async #unsetSecret(which) {
    const creds = this.ctx.get('credentials')
    if (!creds) throw new Error('凭据服务不可用，无法清除密钥')
    const ref = which === 'mqtt' ? 'DSH_AWP_MQTT_PASSWORD' : 'DSH_AWP_SECRET'
    await creds.unset(ref)
    if (which === 'mqtt') this.mqttPassword = null
    else this.secret = null
  }

  /**
   * 测试一个对端（允许尚未保存的临时对端）。
   *
   * 与委派方发任务走完全相同的调用形状（自建信封 + `node.request`），
   * 避免探活和真实任务走两条不同路径。
   * @param {{ id: string, url?: string }} peer - 对端。
   * @returns {Promise<object>} `{ online, ... }`。
   */
  async #ping(peer) {
    if (!this.node) throw new Error('节点尚未启动')
    const saved = this.config?.peers ?? []
    const temporary = !saved.some((item) => item.id === peer.id)
    if (temporary) {
      const peers = new Map(this.node.peers)
      peers.set(peer.id, { url: peer.url })
      this.node.peers = peers
    }
    try {
      const envelope = makeEnvelope({
        type: 'ping',
        from: this.node.nodeId,
        to: peer.id,
      })
      const reply = await this.node.request(peer.id, envelope, { timeoutMs: 8000, retries: 1 })
      if (reply.type !== 'pong') {
        return { online: false, error: `对端返回了非 pong 回复：${reply.type}` }
      }
      return { online: true, ...reply.body }
    } catch (error) {
      return {
        online: false,
        error: `${error?.code ?? 'error'}: ${error?.message ?? String(error)}`,
      }
    } finally {
      if (temporary) this.node.peers = this.#peerMap(this.config)
    }
  }

  /**
   * 列出可绑定的 DSH 工作区。
   * @returns {Promise<{ workspaces: Array<{ id: string, title: string, path: string }> }>} 工作区列表。
   */
  async #listWorkspaces() {
    const registry = this.ctx.get('workspaceRegistry')
    if (!registry) return { workspaces: [] }
    try {
      const list = registry.list()
      return {
        workspaces: list.map((workspace) => ({
          id: String(workspace.id),
          title: workspace.title ?? workspace.path ?? String(workspace.id),
          path: workspace.path ?? '',
        })),
      }
    } catch (error) {
      this.#log('warn', `读取工作区失败：${error?.message ?? error}`)
      return { workspaces: [] }
    }
  }

  /** @returns {object} 最近的任务记录。 */
  #getTasks() {
    return {
      outbound: this.taskStore.list('outbound', 50),
      inbound: this.taskStore.list('inbound', 50),
    }
  }

  /**
   * 取消一个任务。
   * @param {string} taskId - 任务 id。
   * @param {string} direction - `outbound` 或 `inbound`。
   */
  async #cancelTask(taskId, direction) {
    if (direction === 'outbound') {
      await this.delegator.cancel(taskId)
      return
    }
    const record = this.taskStore.getInbound(taskId)
    if (record && (record.state === 'queued' || record.state === 'running')) {
      await this.worker.handle({
        type: 'cancel',
        from: record.from,
        to: this.config.nodeId,
        task: taskId,
        id: `cancel-${Date.now()}`,
      })
    }
  }

  /**
   * 按新配置重建网络节点，保持 node/worker/delegator 对象标识。
   * @param {object} [newConfig] - 新配置；省略时沿用当前配置。
   */
  async restart(newConfig) {
    await this.#stopNetwork()
    if (newConfig) this.config = newConfig
    this.startError = null
    await this.#loadSecrets()
    await this.#startNode()
  }

  /** 只停网络层，保留 worker/delegator 对象与其工具注册。 */
  async #stopNetwork() {
    if (!this.node) return
    try {
      await this.node.stop()
    } catch (error) {
      this.#log('warn', `停止节点失败：${error?.message ?? error}`)
    }
  }

  /** 停止全部组件并释放引用，用于插件卸载。 */
  async stop() {
    if (this.delegator) {
      this.delegator.stop()
      this.delegator = null
    }
    this.delegatorStarted = false
    if (this.worker) {
      await this.worker.stop()
      this.worker = null
    }
    this.workerStarted = false
    await this.#stopNetwork()
    this.node = null
  }

  /** 插件卸载。 */
  async dispose() {
    await this.stop()
    await this.taskStore.dispose()
    this.harness.dispose()
  }

  /**
   * 写日志。
   * @param {string} level - 日志级别。
   * @param {string} message - 内容。
   * @param {object} [meta] - 附加上下文。
   */
  #log(level, message, meta) {
    const logger = this.ctx.logger ?? this.ctx.get('logger')
    if (typeof logger?.[level] === 'function') {
      logger[level](`[awp] ${message}`, meta)
    } else if (typeof logger === 'function') {
      logger(level, `[awp] ${message}`, meta)
    }
  }
}
