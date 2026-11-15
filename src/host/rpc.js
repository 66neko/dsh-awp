/**
 * 设置页 RPC：处理来自浏览器的配置读写、ping、任务查询等请求。
 *
 * ## 为什么用 `connection.fetch.register` 而不是 `connection.rpc.intercept`
 *
 * `@deepseek-ai/dsh-client-connection` 的 `createSharedFetchHandler()` 里，`/api` 通道：
 *
 *   1. 先查精确路由 `fetchRoutes`；
 *   2. 否则取**唯一一个** interceptor，`matches()` 不命中就直接返回 404，
 *      **不会再退回 api-gateway**。
 *
 * 也就是说 `/api` 的 interceptor 是 DSH 自己的 api-gateway 占用的位置。插件去
 * `intercept` 会把 gateway 顶掉（或注册时冲突），结果 DSH 自己的 Remote 调用全部 404——
 * 桌面启动时请求的 `/api/settings/describe` 就是这么挂的。
 *
 * 精确路由在 interceptor 之前被检查，未命中时正常落到 gateway，因此这是插件唯一安全的
 * 接法。参考 dsh-im 的做法。
 *
 * ## 信封格式
 *
 * 浏览器 `connection.rpc.call('/api', 'dsh-awp', payload)` 会 POST 到 `api/dsh-awp`：
 *
 *   { type: 'client-request', rpcId, method: 'dsh-awp', payload }
 *
 * 本路由校验信封后按 `payload.method` 分派，并回：
 *
 *   { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error: { code, message, details } } }
 * @module dsh-awp/host/rpc
 */

/** 精确路由的路径。 */
export const RPC_PATH = '/api/dsh-awp'

/** 客户端 `rpc.call` 使用的端点名，必须与 {@link RPC_PATH} 的最后一段一致。 */
export const RPC_ENDPOINT = 'dsh-awp'

/** 允许请求体的大小上限（字节）。 */
const MAX_BODY_BYTES = 256 * 1024

/**
 * 生成 Connection RPC 结果信封。
 * @param {string} rpcId - 客户端发来的关联 id。
 * @param {object} result - `{ ok: true, value }` 或 `{ ok: false, error }`。
 * @returns {object} 服务端响应信封。
 */
export function serverResponse(rpcId, result) {
  return { type: 'server-response', rpcId, result }
}

/**
 * 生成端点分派器：`{ method, payload }` → RPC 结果。
 * @param {object} handlers - 业务回调。
 * @param {() => object} handlers.getState - 读取当前状态。
 * @param {(config: object) => Promise<{ ok: boolean, errors?: string[] }>} handlers.saveConfig - 保存配置。
 * @param {(which: string, value: string) => Promise<void>} handlers.setSecret - 设置密钥。
 * @param {(which: string) => Promise<void>} handlers.unsetSecret - 清除密钥。
 * @param {(peer: { id: string, url?: string }) => Promise<object>} handlers.ping - 测试对端。
 * @param {() => Promise<object>} handlers.listWorkspaces - 列出 DSH 工作区。
 * @param {() => object} handlers.getTasks - 读取最近任务。
 * @param {(taskId: string, direction: string) => Promise<void>} handlers.cancelTask - 取消任务。
 * @returns {(method: string, payload: unknown) => Promise<object>} 分派器。
 */
export function createDispatcher(handlers) {
  const fail = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })

  return async function dispatch(method, payload) {
    const args = payload !== null && typeof payload === 'object' ? payload : {}
    try {
      switch (method) {
        case 'state':
          return { ok: true, value: handlers.getState() }

        case 'save': {
          const outcome = await handlers.saveConfig(args.config)
          if (outcome?.ok) return { ok: true, value: handlers.getState() }
          const errors = Array.isArray(outcome?.errors) ? outcome.errors : ['配置校验失败']
          return fail('validation', errors.join('; '), { errors })
        }

        case 'secret': {
          const which = String(args.which ?? 'shared')
          if (args.action === 'set') {
            if (typeof args.value !== 'string' || args.value === '') return fail('bad_request', '密钥不能为空')
            await handlers.setSecret(which, args.value)
            return { ok: true, value: handlers.getState() }
          }
          if (args.action === 'unset') {
            await handlers.unsetSecret(which)
            return { ok: true, value: handlers.getState() }
          }
          return fail('bad_request', 'unknown action')
        }

        case 'ping': {
          const peer = args.peer
          if (!peer || typeof peer.id !== 'string' || peer.id === '') return fail('bad_request', '缺少对端 id')
          return { ok: true, value: await handlers.ping(peer) }
        }

        case 'workspaces':
          return { ok: true, value: await handlers.listWorkspaces() }

        case 'tasks':
          return { ok: true, value: handlers.getTasks() }

        case 'cancel': {
          if (typeof args.taskId !== 'string' || args.taskId === '') return fail('bad_request', '缺少任务 id')
          await handlers.cancelTask(args.taskId, String(args.direction ?? 'outbound'))
          return { ok: true, value: { cancelled: true } }
        }

        default:
          return fail('not_found', `unknown method: ${method}`)
      }
    } catch (error) {
      return fail('internal', error?.message ?? String(error))
    }
  }
}

/**
 * 生成精确 Fetch 路由。
 * @param {object} handlers - 业务回调，见 {@link createDispatcher}。
 * @returns {object} `ConnectionFetchRoute`。
 */
export function createRpcRoute(handlers) {
  const dispatch = createDispatcher(handlers)
  return {
    path: RPC_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      const text = await request.text()
      if (text.length > MAX_BODY_BYTES) return new Response('body too large', { status: 413 })
      let message
      try {
        message = JSON.parse(text)
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== RPC_ENDPOINT) {
        return Response.json(serverResponse(rpcId, {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'invalid dsh-awp request envelope', details: {} },
        }))
      }
      const call = message.payload
      if (call === null || typeof call !== 'object' || typeof call.method !== 'string') {
        return Response.json(serverResponse(rpcId, {
          ok: false,
          error: { code: 'gateway/bad-request', message: 'missing request method', details: {} },
        }))
      }
      const result = await dispatch(call.method, call.payload)
      return Response.json(serverResponse(rpcId, result))
    },
  }
}

/**
 * 在 Host 上注册设置页 RPC。
 *
 * 注册失败只记日志，绝不让异常冒泡到 Host。
 * @param {object} ctx - Cordis 上下文。
 * @param {object} handlers - 业务回调，见 {@link createDispatcher}。
 * @param {(level: string, message: string) => void} [log] - 日志函数。
 */
export function registerRpc(ctx, handlers, log = () => {}) {
  const connection = ctx.get ? ctx.get('connection') : ctx.connection
  if (!connection?.fetch || typeof connection.fetch.register !== 'function') {
    log('warn', 'connection.fetch 不可用，设置页将无法读写配置')
    return
  }

  ctx.effect(() => {
    let dispose
    try {
      dispose = connection.fetch.register(createRpcRoute(handlers))
    } catch (error) {
      log('error', `注册设置页 RPC 路由失败：${error?.message ?? error}`)
      return () => {}
    }
    return () => {
      try {
        const pending = dispose?.()
        if (pending && typeof pending.catch === 'function') pending.catch(() => {})
      } catch {}
    }
  }, 'awp: settings rpc route')
}
