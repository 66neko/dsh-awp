#!/usr/bin/env node
/**
 * AWP 命令行工具：独立节点，用于测试或对接其他系统。
 *
 * 用法：
 *   awp-cli ping --node cli --peer server-b --url http://127.0.0.1:7820 --secret <密钥>
 *   awp-cli send --node cli --peer server-b --url http://127.0.0.1:7820 --secret <密钥> --prompt "任务"
 *   awp-cli serve --node cli --host 127.0.0.1 --port 7821 --secret <密钥>
 * @module dsh-awp/bin/awp-cli
 */

import { AwpNode } from '../src/core/node.js'
import { HttpTransport } from '../src/core/http-transport.js'
import { makeEnvelope } from '../src/core/frame.js'

const args = parseArgs(process.argv.slice(2))

if (!args.command || args.command === 'help' || args.help) {
  console.log(`
AWP 命令行工具

用法：
  awp-cli ping --node <id> --peer <id> --url <url> [--secret <密钥>]
  awp-cli send --node <id> --peer <id> --url <url> --prompt <文本> [--title <标题>] [--secret <密钥>]
  awp-cli query --node <id> --peer <id> --url <url> --task <任务id> [--secret <密钥>]
  awp-cli serve --node <id> --host <地址> --port <端口> [--secret <密钥>]

选项：
  --node <id>       本节点 ID
  --peer <id>       对端节点 ID
  --url <url>       对端 URL
  --prompt <text>   任务说明
  --title <text>    任务标题
  --task <id>       任务 ID
  --host <addr>     监听地址（默认 127.0.0.1）
  --port <num>      监听端口（默认 7820）
  --secret <key>    共享密钥
  --help            显示帮助
`)
  process.exit(0)
}

const { command, node, peer, url, prompt, title, task, host = '127.0.0.1', port = 7820, secret } = args

if (command === 'ping') {
  if (!node || !peer || !url) {
    console.error('错误：ping 需要 --node、--peer 和 --url')
    process.exit(1)
  }
  await runPing({ node, peer, url, secret })
} else if (command === 'send') {
  if (!node || !peer || !url || !prompt) {
    console.error('错误：send 需要 --node、--peer、--url 和 --prompt')
    process.exit(1)
  }
  await runSend({ node, peer, url, prompt, title, secret })
} else if (command === 'query') {
  if (!node || !peer || !url || !task) {
    console.error('错误：query 需要 --node、--peer、--url 和 --task')
    process.exit(1)
  }
  await runQuery({ node, peer, url, task, secret })
} else if (command === 'serve') {
  if (!node) {
    console.error('错误：serve 需要 --node')
    process.exit(1)
  }
  await runServe({ node, host, port: Number(port), secret })
} else {
  console.error(`未知命令：${command}`)
  process.exit(1)
}

async function runPing({ node, peer, url, secret }) {
  console.log(`[${node}] 正在 ping ${peer} (${url})...`)
  const awpNode = createNode({ node, secret, peers: [{ id: peer, url }] })
  try {
    const pong = await awpNode.ping(peer)
    console.log(`✓ ${peer} 在线`)
    console.log(`  agent: ${pong.agent ?? 'unknown'}`)
    console.log(`  worker: ${pong.worker ? 'yes' : 'no'}`)
    console.log(`  running: ${pong.running ?? 0} / ${pong.capacity ?? 1}`)
    process.exit(0)
  } catch (error) {
    console.error(`✗ ping 失败：${error.message}`)
    process.exit(1)
  }
}

async function runSend({ node, peer, url, prompt, title, secret }) {
  console.log(`[${node}] 正在发送任务给 ${peer}...`)
  const awpNode = createNode({ node, secret, peers: [{ id: peer, url }] })
  const taskId = `t-${Date.now()}`
  const envelope = makeEnvelope({ type: 'task', from: node, to: peer, task: taskId, body: { prompt, title } })
  try {
    const reply = await awpNode.request(peer, envelope, { timeoutMs: 30_000 })
    console.log(`✓ 任务已发送，task id: ${taskId}`)
    console.log(`  状态: ${reply.type === 'status' ? reply.body.state : reply.body.state}`)
    if (reply.type === 'result') {
      console.log(`  结果: ${reply.body.text ?? reply.body.error?.message ?? '无'}`)
    }
    process.exit(0)
  } catch (error) {
    console.error(`✗ 发送失败：${error.message}`)
    process.exit(1)
  }
}

async function runQuery({ node, peer, url, task, secret }) {
  console.log(`[${node}] 正在查询任务 ${task}...`)
  const awpNode = createNode({ node, secret, peers: [{ id: peer, url }] })
  const envelope = makeEnvelope({ type: 'query', from: node, to: peer, task })
  try {
    const reply = await awpNode.request(peer, envelope, { timeoutMs: 15_000 })
    console.log(`✓ 查询成功`)
    console.log(`  状态: ${reply.body.state}`)
    if (reply.type === 'result') {
      console.log(`  结果: ${reply.body.text ?? reply.body.error?.message ?? '无'}`)
    }
    process.exit(0)
  } catch (error) {
    console.error(`✗ 查询失败：${error.message}`)
    process.exit(1)
  }
}

async function runServe({ node, host, port, secret }) {
  console.log(`[${node}] 启动服务：${host}:${port}`)
  const transport = new HttpTransport({ nodeId: node, host, port })
  const awpNode = new AwpNode({
    nodeId: node,
    secret,
    transport,
    peers: new Map(),
    log: (level, message) => console.log(`[${level}] ${message}`),
  })
  await awpNode.start(async (envelope) => {
    console.log(`← 收到消息：${envelope.type} from ${envelope.from}`)
    if (envelope.type === 'ping') {
      return makeEnvelope({ type: 'pong', from: node, to: envelope.from, re: envelope.id, body: { agent: 'cli', worker: false } })
    }
    console.log(`  (无处理器，已忽略)`)
  })
  console.log(`✓ 服务已启动`)
  process.on('SIGINT', async () => {
    console.log('\n正在停止...')
    await awpNode.stop()
    process.exit(0)
  })
}

function createNode({ node, secret, peers }) {
  const transport = new HttpTransport({ nodeId: node, host: '127.0.0.1', port: 0 })
  return new AwpNode({
    nodeId: node,
    secret,
    transport,
    peers: new Map(peers.map((p) => [p.id, { url: p.url }])),
    log: () => {},
  })
}

function parseArgs(argv) {
  const args = { command: argv[0] }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true
      args[key] = value
      if (value !== true) i++
    }
  }
  return args
}
