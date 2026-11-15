/**
 * AWP/1 的 HTTP 传输（docs/PROTOCOL.md 第 7.1 节）。
 *
 * 服务端只开放一个路径 `/awp`：
 * - `POST /awp`：请求体是一个帧；200 响应体是回复帧，204 表示无即时回复。
 * - `GET /awp`：探活，返回 `AWP/1 <nodeId>`。
 * @module dsh-awp/core/http-transport
 */

import { createServer } from 'node:http'
import { AwpError, MAGIC } from './frame.js'

/** 协议错误码到 HTTP 状态码的映射。 */
const STATUS_OF = Object.freeze({
  bad_frame: 400,
  bad_sig: 401,
  expired: 401,
  unknown_peer: 401,
  too_large: 413,
})

/** HTTP 传输：一个监听端口 + 基于 fetch 的发送。 */
export class HttpTransport {
  /**
   * @param {object} options - 传输选项。
   * @param {string} options.nodeId - 本节点 ID，用于探活响应。
   * @param {string} options.host - 监听地址。
   * @param {number} options.port - 监听端口。
   * @param {number} [options.maxBodyBytes] - 请求体上限，默认 1 MiB。
   * @param {number} [options.timeoutMs] - 发送超时，默认 15 秒。
   */
  constructor({ nodeId, host, port, maxBodyBytes = 1_048_576, timeoutMs = 15_000 }) {
    this.nodeId = nodeId
    this.host = host
    this.port = port
    this.maxBodyBytes = maxBodyBytes
    this.timeoutMs = timeoutMs
    /** HTTP 支持在响应体里同步回复。 */
    this.syncReply = true
    this.server = null
  }

  /**
   * 开始监听。
   * @param {(frame: string) => Promise<{ reply?: string, error?: string }>} onFrame
   *   收到帧时调用；返回回复帧，或协议错误码。
   * @returns {Promise<{ host: string, port: number }>} 实际监听的地址与端口。
   * @throws {Error} 端口被占用等监听失败。
   */
  start(onFrame) {
    const server = createServer((request, response) => {
      this.#handle(request, response, onFrame).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('internal')
      })
    })
    // 每个请求都应很快结束；防止慢速连接长期占用。
    server.requestTimeout = 30_000
    server.headersTimeout = 15_000
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, () => {
        server.off('error', reject)
        const address = server.address()
        resolve({ host: this.host, port: typeof address === 'object' && address ? address.port : this.port })
      })
    })
  }

  async #handle(request, response, onFrame) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/awp') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(request.method === 'HEAD' ? undefined : `${MAGIC} ${this.nodeId}`)
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, HEAD, POST' })
      response.end('method not allowed')
      return
    }
    const body = await readBody(request, this.maxBodyBytes)
    if (body === null) {
      response.writeHead(413, { 'content-type': 'text/plain', connection: 'close' })
      response.end('too_large')
      request.resume()
      return
    }
    const outcome = await onFrame(body)
    if (outcome.error) {
      response.writeHead(STATUS_OF[outcome.error] ?? 400, { 'content-type': 'text/plain' })
      response.end(outcome.error)
      return
    }
    if (outcome.reply) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(outcome.reply)
      return
    }
    response.writeHead(204)
    response.end()
  }

  /**
   * 发送一个帧到对端。
   * @param {string} baseUrl - 对端基础 URL，如 `http://10.0.0.5:7820`。
   * @param {string} frame - 帧文本。
   * @param {object} [options] - 发送选项。
   * @param {number} [options.timeoutMs] - 本次超时。
   * @returns {Promise<{ reply?: string }>} 对端在响应体中的回复帧。
   * @throws {AwpError} 对端拒绝（携带协议错误码）或网络失败（`unreachable`）。
   */
  async send(baseUrl, frame, { timeoutMs = this.timeoutMs } = {}) {
    if (!baseUrl) throw new AwpError('no_route', 'peer has no URL')
    const target = `${baseUrl.replace(/\/+$/, '')}/awp`
    let response
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: frame,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new AwpError('unreachable', `cannot reach ${target}: ${error?.cause?.code ?? error?.name ?? 'error'}`)
    }
    const text = await response.text().catch(() => '')
    if (response.status === 200) return { reply: text }
    if (response.status === 204) return {}
    const code = /^[a-z_]{3,32}$/.test(text.trim()) ? text.trim() : 'unreachable'
    throw new AwpError(code, `peer answered HTTP ${response.status}`)
  }

  /**
   * 停止监听并断开现有连接。
   * @returns {Promise<void>}
   */
  async stop() {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }
}

/**
 * 读取请求体，超过上限返回 null。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @param {number} limit - 字节上限。
 * @returns {Promise<string | null>} UTF-8 文本，或超限时 null。
 */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      resolve(null)
      return
    }
    const chunks = []
    let size = 0
    let done = false
    request.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        done = true
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}
