/**
 * DSH 会话能力的封装，供执行方和委派方使用。
 *
 * 两个必须遵守的契约（都曾经导致过故障）：
 *
 * 1. `typertGateway.invoke()` 的请求字段是 `namespace` / `method` / `args` / `peer` / `signal`，
 *    不是 `endpoint` / `payload`。
 * 2. 它**成功时直接返回业务值**，失败时**抛异常**——没有 `{ ok, value }` 信封。
 *    各 Remote 方法（`session/create` 等）的参数还需要包在 `{ request: {...} }` 里。
 * @module dsh-awp/host/harness
 */

import { randomUUID } from 'node:crypto'

/** DSH 会话操作封装。 */
export class Harness {
  /**
   * @param {object} ctx - Cordis 上下文，需要 typertGateway 和 connection。
   */
  constructor(ctx) {
    this.ctx = ctx
    this.gateway = ctx.typertGateway
    this.connection = ctx.connection
    this._peer = null
  }

  /** @returns {object} 懒创建的 owner Peer（进程内调用身份）。 */
  get peer() {
    if (this._peer) return this._peer
    this._peer = this.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    return this._peer
  }

  /** 释放 Peer。 */
  dispose() {
    if (this._peer) {
      this._peer.dispose().catch(() => {})
      this._peer = null
    }
  }

  /**
   * 调用一个 Host Remote 方法。
   * @param {string} namespace - 命名空间，如 `session`。
   * @param {string} method - 方法名，如 `create`。
   * @param {object} [args] - 参数对象（`request` 包装由调用方决定）。
   * @param {AbortSignal} [signal] - 可选取消信号。
   * @returns {Promise<unknown>} 业务返回值。
   * @throws {Error} 携带 `命名空间.方法` 前缀的失败原因。
   */
  async invoke(namespace, method, args = {}, signal) {
    try {
      return await this.gateway.invoke({
        namespace,
        method,
        args,
        peer: this.peer,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      const reason = error?.message ?? String(error)
      throw new Error(`${namespace}/${method} 失败：${reason}`)
    }
  }

  /**
   * 创建会话。
   * @param {object} options - 创建选项。
   * @param {string} [options.workspaceId] - 绑定到哪个 DSH 工作区。
   * @param {string} [options.cwd] - 直接指定工作目录（未绑定工作区时使用）。
   * @param {string} [options.agentPreset] - Agent 预设。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<string>} 会话 ID。
   * @throws {Error} 创建失败或返回值不含会话 ID。
   */
  async createSession({ workspaceId, cwd, agentPreset }, signal) {
    // session.create 接受 workspaceId 或 cwd，不能同时给。
    const request = workspaceId
      ? { workspaceId, ...(agentPreset ? { agentPreset } : {}) }
      : { cwd, ...(agentPreset ? { agentPreset } : {}) }
    const value = await this.invoke('session', 'create', { request }, signal)
    const sessionId = value?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error(`session/create 返回值缺少 sessionId：${JSON.stringify(value)?.slice(0, 200)}`)
    }
    return sessionId
  }

  /**
   * 选择模型。
   * @param {object} options - 选择选项。
   * @param {string} options.sessionId - 会话 ID。
   * @param {string} options.provider - 模型提供商。
   * @param {string} options.model - 模型名称。
   * @param {string} [options.reasoningEffort] - 思考强度。
   * @param {AbortSignal} [signal] - 取消信号。
   */
  async selectModel({ sessionId, provider, model, reasoningEffort }, signal) {
    await this.invoke('session', 'selectModel', {
      request: {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    }, signal)
  }

  /**
   * 重命名会话。
   * @param {string} sessionId - 会话 ID。
   * @param {string} title - 新标题。
   * @param {AbortSignal} [signal] - 取消信号。
   */
  async rename(sessionId, title, signal) {
    await this.invoke('session', 'rename', { request: { sessionId, title } }, signal)
  }

  /**
   * 发送提示。
   * @param {object} options - 提示选项。
   * @param {string} options.sessionId - 会话 ID。
   * @param {string} options.text - 提示文本。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<string>} 请求 ID。
   */
  async prompt({ sessionId, text }, signal) {
    const requestId = randomUUID()
    await this.invoke('session', 'prompt', {
      request: {
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
    }, signal)
    return requestId
  }

  /**
   * 取消会话。
   * @param {string} sessionId - 会话 ID。
   * @param {AbortSignal} [signal] - 取消信号。
   */
  async cancel(sessionId, signal) {
    await this.invoke('session', 'cancel', { request: { sessionId } }, signal)
  }

  /**
   * 获取模型目录。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 模型目录。
   */
  async modelCatalog(signal) {
    return await this.invoke('session', 'modelCatalog', {}, signal)
  }

  /**
   * 等待会话状态变化。
   *
   * 返回 `{ reason, state, output }`：`reason` 为 `idle` / `input-required` / `timeout`。
   * 用它轮询比只依赖事件监听可靠：事件监听一旦没接上，任务会永久挂起。
   * @param {string} sessionId - 会话 ID。
   * @param {object} [options] - 等待选项。
   * @param {number} [options.timeoutMs] - 单次等待上限，默认 2000。
   * @param {number} [options.afterSeq] - 只返回该事件序号之后的输出。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 等待结果。
   */
  async wait(sessionId, { timeoutMs = 2000, afterSeq } = {}, signal) {
    return await this.invoke('session', 'wait', {
      request: {
        sessionId,
        timeoutMs,
        ...(afterSeq === undefined ? {} : { afterSeq }),
      },
    }, signal)
  }

  /**
   * 读取会话的被动状态（是否在运行、是否有待处理输入）。
   * @param {string} sessionId - 会话 ID。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<object>} 状态。
   */
  async state(sessionId, signal) {
    return await this.invoke('session', 'state', { request: { sessionId } }, signal)
  }

  /**
   * 设置完全权限（`danger-full-access`）。
   * @param {string} sessionId - 会话 ID。
   * @throws {Error} 会话不存在或权限服务不可用。
   */
  async setFullAccess(sessionId) {
    const presets = this.ctx.get('permissionPresets')
    if (!presets) throw new Error('permissionPresets 服务不可用，无法设置完全权限')
    const agents = this.ctx.get('agents')
    let session = agents?.get(sessionId)?.session
    if (!session) {
      const controller = this.ctx.get('sessionController')
      if (!controller) throw new Error('无法解析会话')
      const resolved = await controller.resolveAgent(sessionId)
      if (!resolved?.agent) throw new Error(`会话 ${sessionId} 不存在或未激活`)
      session = resolved.agent.session
    }
    presets.set(session, 'danger-full-access')
  }

  /**
   * 列出 Agent 预设。
   * @returns {Promise<Array<{ id: string, name?: string, isDefault?: boolean }>>} 预设列表。
   */
  async listPresets() {
    const service = this.ctx.get('agentPresets')
    if (!service) return []
    try {
      const roster = await service.remoteExportList()
      return roster?.presets ?? []
    } catch {
      return []
    }
  }
}
