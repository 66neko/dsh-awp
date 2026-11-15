/**
 * dedupe.js 单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DedupeCache } from '../src/core/dedupe.js'

describe('DedupeCache', () => {
  it('识别重复', () => {
    const cache = new DedupeCache({ ttlMs: 1000 })
    assert.equal(cache.seen('a:1'), false)
    assert.equal(cache.seen('a:1'), true)
    assert.equal(cache.seen('a:2'), false)
  })

  it('过期后允许重复', async () => {
    const cache = new DedupeCache({ ttlMs: 100 })
    const now = Date.now()
    assert.equal(cache.seen('a:1', now), false)
    assert.equal(cache.seen('a:1', now + 50), true)
    assert.equal(cache.seen('a:1', now + 150), false)
  })

  it('淘汰最旧记录', () => {
    const cache = new DedupeCache({ max: 3 })
    cache.seen('a:1')
    cache.seen('a:2')
    cache.seen('a:3')
    cache.seen('a:4')
    assert.equal(cache.entries.size, 3)
    assert.equal(cache.entries.has('a:1'), false)
  })
})
