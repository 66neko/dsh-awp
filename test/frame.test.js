/**
 * frame.js 单元测试。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeFrame, decodeFrame, makeEnvelope, validateEnvelope, AwpError, isNodeId } from '../src/core/frame.js'

describe('frame', () => {
  describe('isNodeId', () => {
    it('接受合法的节点 ID', () => {
      assert.ok(isNodeId('server-a'))
      assert.ok(isNodeId('node_123'))
      assert.ok(isNodeId('a.b.c'))
      assert.ok(isNodeId('A1'))
    })

    it('拒绝不合法的节点 ID', () => {
      assert.ok(!isNodeId(''))
      assert.ok(!isNodeId('-abc'))
      assert.ok(!isNodeId('a/b'))
      assert.ok(!isNodeId('a+b'))
      assert.ok(!isNodeId('a'.repeat(64)))
    })
  })

  describe('makeEnvelope', () => {
    it('构造最小信封', () => {
      const env = makeEnvelope({ type: 'ping', from: 'node-a', to: 'node-b' })
      assert.equal(env.type, 'ping')
      assert.equal(env.from, 'node-a')
      assert.equal(env.to, 'node-b')
      assert.ok(env.id)
      assert.ok(env.ts > 0)
    })

    it('构造带任务的信封', () => {
      const env = makeEnvelope({ type: 'task', from: 'a', to: 'b', task: 't1', body: { prompt: 'hello' } })
      assert.equal(env.task, 't1')
      assert.equal(env.body.prompt, 'hello')
    })

    it('拒绝不合法字段', () => {
      assert.throws(() => makeEnvelope({ type: 'unknown', from: 'a', to: 'b' }), AwpError)
      assert.throws(() => makeEnvelope({ type: 'ping', from: '', to: 'b' }), AwpError)
      assert.throws(() => makeEnvelope({ type: 'task', from: 'a', to: 'b' }), AwpError)
    })
  })

  describe('encodeFrame / decodeFrame', () => {
    it('编解码无密钥帧', () => {
      const env = makeEnvelope({ type: 'ping', from: 'a', to: 'b' })
      const frame = encodeFrame(env)
      assert.ok(frame.startsWith('AWP/1 -\n'))
      const decoded = decodeFrame(frame)
      assert.deepEqual(decoded, env)
    })

    it('编解码有密钥帧', () => {
      const env = makeEnvelope({ type: 'ping', from: 'a', to: 'b' })
      const frame = encodeFrame(env, 'secret123')
      assert.ok(frame.startsWith('AWP/1 '))
      assert.ok(!frame.startsWith('AWP/1 -'))
      const decoded = decodeFrame(frame, { secret: 'secret123' })
      assert.deepEqual(decoded, env)
    })

    it('拒绝错误签名', () => {
      const env = makeEnvelope({ type: 'ping', from: 'a', to: 'b' })
      const frame = encodeFrame(env, 'secret123')
      assert.throws(() => decodeFrame(frame, { secret: 'wrong' }), (err) => err instanceof AwpError && err.code === 'bad_sig')
    })

    it('拒绝过期帧', () => {
      const env = makeEnvelope({ type: 'ping', from: 'a', to: 'b', ts: Date.now() - 400_000 })
      const frame = encodeFrame(env)
      assert.throws(() => decodeFrame(frame), (err) => err instanceof AwpError && err.code === 'expired')
    })

    it('拒绝不合法帧', () => {
      assert.throws(() => decodeFrame('invalid'), (err) => err instanceof AwpError && err.code === 'bad_frame')
      assert.throws(() => decodeFrame('AWP/1 abc\n{}'), (err) => err instanceof AwpError && err.code === 'bad_frame')
    })
  })
})
