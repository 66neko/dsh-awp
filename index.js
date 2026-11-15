/**
 * dsh-awp 插件入口。
 *
 * 职责：创建 AwpService 实例，在 ctx.effect 里启动与停止。
 * @module dsh-awp
 */

import { AwpService } from './src/host/service.js'

export const name = 'awp'
export const inject = ['tools', 'connection', 'typertGateway']

/**
 * 插件 apply 函数。
 * @param {object} ctx - Cordis 上下文。
 */
export function apply(ctx) {
  const service = new AwpService(ctx)
  ctx.effect(() => {
    service.start().catch((error) => {
      const logger = ctx.logger ?? ctx.get('logger')
      if (typeof logger?.error === 'function') {
        logger.error(`[awp] 启动失败：${error?.message ?? error}`)
      }
    })
    return () => service.dispose()
  }, 'awp: service lifecycle')
}
