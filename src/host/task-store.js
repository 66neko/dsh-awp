/**
 * 任务记录持久化存储。
 *
 * 格式：`$DSH_HOME/dsh-awp/tasks.json`，包含 inbound（执行方收到）和 outbound（委派方发出）两个映射。
 * 保留 7 天，最多 500 条。
 * @module dsh-awp/host/task-store
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const RETENTION_MS = 7 * 24 * 3600_000
const MAX_TASKS = 500

/**
 * 任务存储。
 */
export class TaskStore {
  /**
   * @param {string} path - 存储文件路径。
   * @param {(level: string, message: string) => void} [log] - 日志函数。
   */
  constructor(path, log = () => {}) {
    this.path = path
    this.log = log
    /** @type {Map<string, object>} 入站任务：task id → 记录。 */
    this.inbound = new Map()
    /** @type {Map<string, object>} 出站任务：task id → 记录。 */
    this.outbound = new Map()
    this.dirty = false
    this.saveTimer = null
  }

  /**
   * 从文件加载。
   */
  async load() {
    try {
      const text = await readFile(this.path, 'utf8')
      const data = JSON.parse(text)
      if (data.version === 1) {
        for (const [id, record] of Object.entries(data.inbound ?? {})) {
          this.inbound.set(id, record)
        }
        for (const [id, record] of Object.entries(data.outbound ?? {})) {
          this.outbound.set(id, record)
        }
      }
      this.prune()
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.log('warn', `加载任务表失败：${error?.message ?? error}`)
      }
    }
  }

  /**
   * 删除过期记录。
   */
  prune() {
    const now = Date.now()
    const cutoff = now - RETENTION_MS
    for (const [id, record] of this.inbound) {
      if ((record.updatedAt ?? record.createdAt ?? 0) < cutoff) this.inbound.delete(id)
    }
    for (const [id, record] of this.outbound) {
      if ((record.updatedAt ?? record.createdAt ?? 0) < cutoff) this.outbound.delete(id)
    }
    if (this.inbound.size + this.outbound.size > MAX_TASKS) {
      const all = [
        ...Array.from(this.inbound.entries()).map(([id, r]) => ({ map: this.inbound, id, at: r.updatedAt ?? r.createdAt ?? 0 })),
        ...Array.from(this.outbound.entries()).map(([id, r]) => ({ map: this.outbound, id, at: r.updatedAt ?? r.createdAt ?? 0 })),
      ]
      all.sort((a, b) => a.at - b.at)
      const drop = all.length - MAX_TASKS
      for (let i = 0; i < drop; i++) {
        all[i].map.delete(all[i].id)
      }
    }
  }

  /**
   * 获取入站任务。
   * @param {string} id - 任务 ID。
   * @returns {object | undefined} 记录。
   */
  getInbound(id) {
    return this.inbound.get(id)
  }

  /**
   * 设置入站任务。
   * @param {string} id - 任务 ID。
   * @param {object} record - 记录。
   */
  setInbound(id, record) {
    this.inbound.set(id, { ...record, updatedAt: Date.now() })
    this.scheduleSave()
  }

  /**
   * 获取出站任务。
   * @param {string} id - 任务 ID。
   * @returns {object | undefined} 记录。
   */
  getOutbound(id) {
    return this.outbound.get(id)
  }

  /**
   * 设置出站任务。
   * @param {string} id - 任务 ID。
   * @param {object} record - 记录。
   */
  setOutbound(id, record) {
    this.outbound.set(id, { ...record, updatedAt: Date.now() })
    this.scheduleSave()
  }

  /**
   * 列出最近的任务（最新的在前）。
   * @param {'inbound' | 'outbound'} direction - 方向。
   * @param {number} limit - 数量限制。
   * @returns {Array<object>} 记录列表。
   */
  list(direction, limit = 50) {
    const map = direction === 'inbound' ? this.inbound : this.outbound
    const records = Array.from(map.values())
    records.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))
    return records.slice(0, limit)
  }

  /**
   * 标记需要保存（去抖）。
   */
  scheduleSave() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.save().catch((error) => this.log('error', `保存任务表失败：${error?.message ?? error}`))
    }, 2000)
  }

  /**
   * 立即保存到文件。
   */
  async save() {
    if (!this.dirty) return
    this.dirty = false
    this.prune()
    const data = {
      version: 1,
      inbound: Object.fromEntries(this.inbound),
      outbound: Object.fromEntries(this.outbound),
    }
    const text = JSON.stringify(data, null, 2)
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, text, 'utf8')
    await writeFile(this.path, text, 'utf8')
  }

  /**
   * 停止并保存。
   */
  async dispose() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }
}
