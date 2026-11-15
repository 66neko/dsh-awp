/**
 * 消息 id 去重缓存（docs/PROTOCOL.md 第 6 节：至少保留最近 1 小时）。
 * @module dsh-awp/core/dedupe
 */

/** 按插入时间淘汰的去重表。 */
export class DedupeCache {
  /**
   * @param {object} [options] - 缓存选项。
   * @param {number} [options.ttlMs] - 记录保留时长，默认 1 小时。
   * @param {number} [options.max] - 最多保留条数，超出时淘汰最旧的。
   */
  constructor({ ttlMs = 3_600_000, max = 50_000 } = {}) {
    this.ttlMs = ttlMs
    this.max = max
    /** @type {Map<string, number>} */
    this.entries = new Map()
  }

  /**
   * 记录一个 id，并返回它之前是否出现过。
   * @param {string} key - 去重键，通常为 `from + ':' + id`。
   * @param {number} [now] - 当前时间（毫秒）。
   * @returns {boolean} 之前已出现过时为 true。
   */
  seen(key, now = Date.now()) {
    this.prune(now)
    if (this.entries.has(key)) return true
    this.entries.set(key, now)
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
    return false
  }

  /**
   * 删除过期记录。Map 按插入顺序迭代，遇到未过期的即可停止。
   * @param {number} now - 当前时间（毫秒）。
   */
  prune(now) {
    for (const [key, at] of this.entries) {
      if (now - at <= this.ttlMs) break
      this.entries.delete(key)
    }
  }
}
