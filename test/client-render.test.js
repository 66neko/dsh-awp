/**
 * client.js 渲染测试。
 *
 * 设置页白屏过一次，原因是没有验证真实渲染。这里用真实的 React 服务端渲染
 * 把 client.js 里的组件跑一遍：任何渲染期异常都会让测试失败并打印堆栈。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')

/**
 * 把 react / react-dom 复制成扁平的 node_modules，供测试渲染使用。
 *
 * 不直接用仓库的 node_modules：pnpm 的软链在受限 ACL 环境里可能不可 stat
 * （ERR_INVALID_PACKAGE_CONFIG / EACCES），复制真实目录可以绕开这个限制。
 * @returns {string | null} 依赖根目录；失败时返回 null。
 */
function materializeRenderDeps() {
  try {
    const store = join(root, 'node_modules', '.pnpm')
    const target = join(tmpdir(), 'awp-render-deps', 'node_modules')
    const specs = { react: 'react', 'react-dom': 'react-dom' }
    for (const [name, prefix] of Object.entries(specs)) {
      const entry = readdirSync(store).find((dir) => dir.startsWith(`${prefix}@`))
      if (!entry) return null
      const source = join(store, entry, 'node_modules', name)
      if (!existsSync(join(source, 'package.json'))) return null
      const destination = join(target, name)
      if (!existsSync(join(destination, 'package.json'))) {
        mkdirSync(target, { recursive: true })
        cpSync(source, destination, { recursive: true, force: true })
      }
    }
    return target
  } catch {
    return null
  }
}

const depsRoot = materializeRenderDeps()
const skipReason = depsRoot ? false : '无法从 pnpm store 准备 react 渲染依赖'
const loadDep = depsRoot
  ? createRequire(join(depsRoot, 'anchor.cjs'))
  : null
const React = depsRoot ? loadDep('react') : null
const renderToStaticMarkup = depsRoot ? loadDep('react-dom/server').renderToStaticMarkup : null

/**
 * 取出 client.js 注册的插件对象。
 * @param {object} deps - 依赖注入。
 * @param {(key: string) => string} deps.locale - 假 locale 翻译函数。
 * @param {(name: string) => object | undefined} deps.get - 假 ctx.get。
 * @param {unknown[]} [deps.useState] - 依次返回给每次 useState 的初值（用于模拟已加载状态）。
 * @returns {{ inject: string[], apply: (ctx: object) => void, registered: object[] }} 插件与槽注册记录。
 */
function loadClientPlugin(deps) {
  const registered = []
  const effects = []
  const ctx = {
    get: deps.get,
    locale: {
      register: () => () => {},
      bind: () => deps.locale,
    },
    effect: (fn) => { effects.push(fn); fn() },
    slots: {
      inject: (_name, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  // 允许按顺序预置 useState 初值，模拟「配置已加载」的那一帧。
  let useStateIndex = 0
  const ReactShim = deps.useState
    ? {
      ...React,
      useState: (initial) => {
        const preset = deps.useState
        if (useStateIndex < preset.length) return [preset[useStateIndex++], () => {}]
        return React.useState(initial)
      },
    }
    : React

  let plugin
  const window = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        plugin = factory((name) => {
          if (name !== 'react') throw new Error(`unexpected require: ${name}`)
          return ReactShim
        })
      },
    },
  }
  const run = new Function('window', 'console', clientSource)
  run(window, console)
  assert.ok(plugin, 'client.js 没有调用 __ModuleLoader__.load')
  return { ...plugin, applyCtx: ctx, registered }
}

/** 构造一份合法的 Host 状态。 */
function makeState() {
  return {
    config: {
      version: 1,
      nodeId: 'local-test',
      transport: 'http',
      http: { host: '127.0.0.1', port: 7820, maxBodyBytes: 1048576 },
      mqtt: { url: '', topic: '', username: '', caFile: '', caPem: '', servername: '', allowInvalidCert: false },
      peers: [{ id: 'local-test', url: 'http://127.0.0.1:7820', description: '' }],
      worker: {
        enabled: true,
        workspaceId: 'ws-1',
        model: { provider: '', model: '' },
        reasoningEffort: '',
        agentPreset: '',
        maxConcurrent: 1,
        maxQueue: 10,
        defaultTimeoutSec: 3600,
        maxTimeoutSec: 14400,
        allowRelay: false,
      },
      delegator: { enabled: true },
    },
    secretSet: false,
    mqttPasswordSet: false,
    running: true,
    error: '',
  }
}

/**
 * 渲染设置分组。
 * @param {object} options - 渲染选项。
 * @param {object} [options.state] - Host 状态。
 * @param {boolean} [options.loaded] - 是否直接渲染「已加载」那一帧。
 * @param {(method: string, payload: object) => Promise<object>} [options.call] - RPC 桩。
 * @returns {Promise<string>} 渲染出的 HTML。
 */
async function renderSettings({ state = makeState(), loaded = false, call } = {}) {
  const callHost = call ?? (async (method) => {
    if (method === 'state') return { ok: true, value: state }
    if (method === 'workspaces') return { ok: true, value: { workspaces: [{ id: 'ws-1', title: '测试工作区', path: 'E:\\workspace\\dsh-test' }] } }
    if (method === 'save') return { ok: true, value: state }
    return { ok: true, value: {} }
  })
  const plugin = loadClientPlugin({
    locale: (key) => key,
    // 组件里 useState 的出现顺序：state, draft, loading, saving, error,
    // hostErrors, feedback, secretForm, peerForm, catalog, presets
    useState: loaded
      ? [state, state.config, false, false, '', [], '', null, null, null, { groups: [] }, [],
        [{ id: 'ws-1', title: '测试工作区', path: 'E:\\workspace\\dsh-test' }]]
      : undefined,
    get: (name) => {
      if (name === 'connection') return { rpc: { call: (_channel, _endpoint, payload) => callHost(payload.method, payload.payload) } }
      if (name === 'remote') {
        return {
          session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
          agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }) },
        }
      }
      if (name === 'uiWorkspace') return { pickDirectory: async () => 'E:\\picked' }
      return undefined
    },
  })
  plugin.apply(plugin.applyCtx)
  assert.equal(plugin.registered.length, 1, '应当注册一个 settings.section')
  const Section = plugin.registered[0].component
  const element = React.createElement(Section, { close: () => {}, useWorkspaces: undefined })
  return renderToStaticMarkup(element)
}

describe('client 渲染', { skip: skipReason }, () => {
  it('首帧（未加载）不抛异常', async () => {
    const html = await renderSettings()
    assert.equal(typeof html, 'string')
    assert.ok(html.includes('加载中'), html.slice(0, 200))
  })

  it('已加载帧能渲染出全部分组', async () => {
    const html = await renderSettings({ loaded: true })
    for (const title of ['节点', '通信方式', '对端节点', '执行方', '委派方']) {
      assert.ok(html.includes(title), `缺少分组：${title}`)
    }
  })

  it('执行方展示绑定的工作区而不是目录输入框', async () => {
    const html = await renderSettings({ loaded: true })
    assert.ok(html.includes('绑定工作区'), '缺少「绑定工作区」行')
    assert.ok(html.includes('测试工作区 — E:\\workspace\\dsh-test'), '工作区下拉缺少已绑定项')
    assert.ok(!html.includes('选择…'), '不应再出现目录选择按钮')
  })

  it('MQTT 展示证书设置，关闭校验时显示风险提示', async () => {
    const state = makeState()
    state.config.transport = 'mqtt'
    state.config.mqtt.url = 'mqtts://broker.example.com:8883'
    state.config.mqtt.topic = 'awp/test'
    const verified = await renderSettings({ loaded: true, state })
    for (const title of ['CA 证书文件', '或粘贴证书', '证书主机名', '跳过证书校验']) {
      assert.ok(verified.includes(title), `缺少 MQTT TLS 设置：${title}`)
    }
    assert.ok(!verified.includes('已关闭 TLS 证书校验'))

    state.config.mqtt.allowInvalidCert = true
    const unverified = await renderSettings({ loaded: true, state })
    assert.ok(unverified.includes('已关闭 TLS 证书校验'))
  })
})
