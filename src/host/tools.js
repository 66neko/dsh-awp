/**
 * Agent 工具注册：awp_peers、awp_send、awp_task。
 *
 * 两个要点：
 * 1. 可见性用 `ctx.tools.register(definition, { when })`（DSH 官方按 Agent 激活条件），
 *    不改写共享的 `ctx.tools.guard`，避免影响其它插件的工具守卫。
 * 2. 依赖通过 `resolve()` **按需解析当前服务实例**，而不是注册时捕获。
 *    插件热替换后旧注册会留在工具表里，若捕获了旧对象，工具就会对已失效的
 *    节点发请求（表现为永远收不到回复），而真实监听其实已经换了新实例。
 * @module dsh-awp/host/tools
 */

/** 执行方会话里始终屏蔽的工具。 */
export const WORKER_ALWAYS_DENIED_TOOLS = Object.freeze(['ask_user_question'])

/** 关闭「允许转派」时，执行方会话额外屏蔽的工具。 */
export const WORKER_RELAY_DENIED_TOOLS = Object.freeze(['awp_peers', 'awp_send', 'awp_task'])

/** 默认（不允许转派时）需要屏蔽的工具。 */
export const WORKER_DENIED_TOOLS = Object.freeze([
  ...WORKER_ALWAYS_DENIED_TOOLS, ...WORKER_RELAY_DENIED_TOOLS,
])

/**
 * 注册 AWP 工具。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} options - 注册选项。
 * @param {() => ({ node: object, delegator: object, worker: object } | null)} options.resolve
 *   返回当前可用的服务组件；未就绪时返回 null。
 */
export function registerTools(ctx, { resolve }) {
  /**
   * 取当前可用的组件。
   * @returns {{ node: object, delegator: object, worker: object }} 组件。
   * @throws {Error} 服务尚未就绪。
   */
  const requireReady = () => {
    const deps = resolve()
    if (!deps?.node || !deps.delegator || !deps.worker) {
      throw new Error('AWP 服务尚未就绪（节点未启动），请检查插件配置与共享密钥')
    }
    return deps
  }

  const isWorkerAgent = (agent) => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string') return false
    const deps = resolve()
    return deps?.worker?.isWorkerSession(sessionId) === true
  }

  /** 当前配置是否允许执行方会话再转派任务。 */
  const relayAllowed = () => resolve()?.allowRelay === true

  /**
   * 执行方会话默认看不到 AWP 工具，避免任务被层层转派；
   * 配置里打开「允许转派」后才放行。
   */
  const when = (context) => !isWorkerAgent(context?.agent) || relayAllowed()

  /**
   * 工具内部再校验一次，避免 `when` 与实际执行时机不一致时越权。
   * @param {object} agent - 调用方 Agent。
   */
  const assertMayCall = (agent) => {
    if (isWorkerAgent(agent) && !relayAllowed()) {
      throw new Error('执行方会话不能调用 AWP 工具（可在设置里打开「允许转派」）')
    }
  }

  const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'awp_peers',
    description: '列出已配置的对端节点，并测试它们的在线状态、是否接受任务、当前负载。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(_args, exec) {
      assertMayCall(exec.agent)
      const { node } = requireReady()
      const ids = Array.from(node.peers.keys())
      return {
        peers: await Promise.all(ids.map(async (id) => {
          const started = Date.now()
          try {
            const pong = await node.ping(id)
            return {
              id,
              online: true,
              agent: pong.agent ?? 'unknown',
              worker: pong.worker === true,
              running: pong.running ?? 0,
              capacity: pong.capacity ?? 0,
              latencyMs: Date.now() - started,
            }
          } catch (error) {
            return { id, online: false, error: `${error?.code ?? 'error'}: ${error?.message ?? error}` }
          }
        })),
      }
    },
  }, { when })

  ctx.tools.register({
    name: 'awp_send',
    description: [
      '把任务派给某个对端节点执行。默认异步：立即返回任务号，任务完成后结果会作为一条新消息自动送回本会话（会唤醒你继续处理），不需要轮询。',
      '话题连续性：向同一 peer 继续、补充、修正或验收当前话题时，默认用 follow 续接该话题最近一个已结束任务的 task ID，保留执行方上下文；由你根据用户意图选择关联任务，不要混用该节点的其他话题。',
      '全新独立任务、用户明确要求重新开始或没有可用关联任务时省略 follow，并在 prompt 中提供必要背景；省略 follow 会新建会话，不会自动继承历史。',
      'follow 使用 awp_send 返回值或 [AWP 结果] 消息中的真实 task ID，不要猜测或填写会话 ID。续接前先等该话题最新任务结束，避免同一话题并发投递。',
      'waitSec 大于 0 时才同步等待：最多等这么多秒，等到就返回结果，超时则返回 running 并继续异步回送。',
      'timeoutSec 是「执行方允许任务跑多久」，默认跟随执行方配置（通常 1 小时）；不适合用 waitSec 长时间阻塞，长任务请保持异步或者稍后用 awp_task 查询。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        peer: { type: 'string', description: '对端节点 ID' },
        prompt: { type: 'string', description: '任务说明；续接时说明本次新增要求，独立任务需提供必要背景' },
        title: { type: 'string', description: '短标题（可选）' },
        timeoutSec: { type: 'number', description: '执行方允许的运行时长（秒），留空用执行方默认值' },
        follow: { type: 'string', description: '同一 peer、当前话题最近一个已结束任务的 task ID；继续、补充、修正或验收时默认填写，独立新任务时省略。找到旧任务会话时保留上下文，找不到则新建会话' },
        waitSec: { type: 'number', description: '同步等待结果的秒数；0 表示异步（默认）' },
      },
      required: ['peer', 'prompt'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id
      if (typeof sessionId !== 'string') throw new Error('awp_send 需要会话上下文')
      assertMayCall(exec.agent)
      const { delegator } = requireReady()
      return await delegator.send({
        peer: args.peer,
        prompt: args.prompt,
        originSessionId: sessionId,
        title: args.title,
        timeoutSec: args.timeoutSec,
        follow: args.follow,
        waitSec: args.waitSec ?? 0,
      })
    },
  }, { when })

  ctx.tools.register({
    name: 'awp_task',
    description: '查询某个由 awp_send 发出的任务的状态，或取消它。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID' },
        action: { type: 'string', enum: ['status', 'cancel'], description: 'status 查询，cancel 取消' },
      },
      required: ['taskId', 'action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: renderJson },
    async execute(args, exec) {
      assertMayCall(exec.agent)
      const { delegator } = requireReady()
      if (args.action === 'status') return await delegator.status(args.taskId)
      if (args.action === 'cancel') {
        await delegator.cancel(args.taskId)
        return { task: args.taskId, cancelled: true }
      }
      throw new Error(`unknown action: ${args.action}`)
    },
  }, { when })
}

/**
 * 在一个执行方会话上屏蔽不需要的工具。
 *
 * 用 DSH 官方的 Agent 作用域 `tools.restrict()`，只在指定会话生效。
 * `ask_user_question` 始终屏蔽（无人值守无法向用户提问）；AWP 工具只在
 * 未开启「允许转派」时屏蔽。
 * @param {object} ctx - Cordis 上下文。
 * @param {string} sessionId - 执行方会话 ID。
 * @param {boolean} [allowRelay] - 是否允许该会话继续转派任务。
 * @returns {boolean} 是否成功施加限制。
 */
export function restrictWorkerSession(ctx, sessionId, allowRelay = false) {
  try {
    const agents = ctx.get?.('agents')
    const agent = agents?.get?.(sessionId)
    const restrict = agent?.ctx?.tools?.restrict
    if (typeof restrict !== 'function') return false
    const deny = allowRelay ? WORKER_ALWAYS_DENIED_TOOLS : WORKER_DENIED_TOOLS
    restrict.call(agent.ctx.tools, { deny: [...deny] })
    return true
  } catch {
    return false
  }
}
