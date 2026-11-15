/**
 * dsh-awp 设置页客户端。
 *
 * 在 DSH「设置」里注册一项「dsh-awp」。要点：
 * - Electron 不支持 `window.prompt`/`alert`，所有输入与提示都在页面内完成。
 * - 只 `require('react')`，控件自己实现，样式只用 `--dsw-alias-*` 主题变量。
 * - 目录类输入提供「选择…」按钮（走 DSH 的 uiWorkspace 目录选择器）。
 * - 输入就地校验：范围、格式、必填都在失焦/输入时提示，非法值不会提交。
 * @module dsh-awp/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-awp',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 保存去抖间隔（毫秒）。 */
    const SAVE_DEBOUNCE_MS = 600
    /** 节点 ID 规则，与协议层一致。 */
    const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/

    /**
     * 安全地读一个 Client 服务：缺失或不可用时返回 undefined，
     * 绝不让异常冒到渲染期（那会把整个设置槽位打空成白屏）。
     * @param {object} ctx - Client 上下文。
     * @param {string} name - 服务名。
     * @returns {object | undefined} 服务实例。
     */
    function service(ctx, name) {
      try {
        if (typeof ctx.get === 'function') return ctx.get(name) ?? undefined
      } catch {}
      try {
        return ctx[name] ?? undefined
      } catch {}
      return undefined
    }

    /**
     * 渲染错误边界：任何渲染异常都显示成文字，而不是整页空白。
     */
    class SettingsBoundary extends React.Component {
      /** @param {object} props - 组件属性。 */
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      /** @param {Error} error - 捕获到的错误。 */
      static getDerivedStateFromError(error) {
        return { error }
      }

      /** @returns {object} 渲染结果。 */
      render() {
        if (this.state.error) {
          return h('div', { style: { padding: '20px' } },
            h('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' } },
              `设置页渲染失败：${this.state.error.message}`),
            h('pre', {
              style: {
                fontSize: '12px',
                whiteSpace: 'pre-wrap',
                color: 'var(--dsw-alias-label-secondary)',
              },
            }, String(this.state.error.stack ?? '').split('\n').slice(0, 6).join('\n')),
          )
        }
        return this.props.children
      }
    }

    /** 复用的输入样式。 */
    const styles = {
      input: {
        padding: '5px 8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '5px',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        width: '260px',
      },
      inputNarrow: { width: '96px' },
      button: {
        padding: '5px 12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '5px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      buttonSmall: { padding: '3px 9px', fontSize: '12px' },
      hint: { marginLeft: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      error: { marginLeft: '8px', fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      section: { marginBottom: '28px' },
      sectionTitle: { margin: '0 0 4px', fontSize: '14px' },
      sectionDesc: { margin: '0 0 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' },
      label: { width: '120px', fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      banner: {
        padding: '8px 10px',
        marginBottom: '14px',
        borderRadius: '5px',
        fontSize: '13px',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      warn: { background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-state-warn-primary)' },
      errorBanner: { border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l2)', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      td: { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dictionaries = {
          zh: { title: 'dsh-awp', desc: '配置 AWP 节点，让多个 DSH 互相指派任务' },
          en: { title: 'dsh-awp', desc: 'Configure AWP nodes for multi-agent task delegation' },
        }
        ctx.effect(() => ctx.locale.register('awp-settings', dictionaries), 'awp-settings: locale')
        const t = (key) => ctx.locale.bind('awp-settings')(key)

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'awp',
          order: 30,
          label: () => t('title'),
          locale: 'awp-settings',
        }, withBoundary(AwpSettings))), 'awp-settings: section')

        /**
         * 用错误边界包一层。
         * @param {object} Component - 实际组件。
         * @returns {object} 包装后的组件。
         */
        function withBoundary(Component) {
          /**
           * @param {object} props - 宿主属性。
           * @returns {object} 元素。
           */
          function Wrapped(props) {
            return h(SettingsBoundary, null, h(Component, props))
          }
          return Wrapped
        }

        /**
         * 设置页主体。
         * @param {object} props - 宿主属性。
         * @param {() => void} props.close - 关闭设置面板。
         */
        function AwpSettings(props) {
          const [state, setState] = React.useState(null)
          const [draft, setDraft] = React.useState(null)
          const [loading, setLoading] = React.useState(true)
          const [saving, setSaving] = React.useState(false)
          const [error, setError] = React.useState('')
          const [hostErrors, setHostErrors] = React.useState([])
          const [feedback, setFeedback] = React.useState('')
          const [secretForm, setSecretForm] = React.useState(null)
          const [peerForm, setPeerForm] = React.useState(null)
          const [pemForm, setPemForm] = React.useState(null)
          const [catalog, setCatalog] = React.useState(null)
          const [presets, setPresets] = React.useState(null)

          const connection = React.useMemo(() => service(ctx, 'connection'), [])
          const uiWorkspace = React.useMemo(
            () => service(ctx, 'uiWorkspace') ?? service(ctx, 'workspaces'),
            [],
          )
          const [workspaces, setWorkspaces] = React.useState(null)

          const callHost = React.useCallback(
            (method, payload, signal) => connection.rpc.call('/api', 'dsh-awp', { method, payload }, signal),
            [connection],
          )

          const loadState = React.useCallback(async () => {
            setLoading(true)
            if (!connection?.rpc?.call) {
              setError('无法获取 DSH 连接服务，请刷新页面后重试')
              setLoading(false)
              return
            }
            try {
              const result = await callHost('state', {})
              if (result.ok) {
                setState(result.value)
                setDraft(result.value.config)
                setError('')
              } else {
                setError(result.error?.message ?? '加载失败')
              }
            } catch (err) {
              setError(`加载失败：${err?.message ?? err}`)
            } finally {
              setLoading(false)
            }
            // 工作区列表用于执行方绑定；失败只影响该下拉。
            try {
              const spaces = await callHost('workspaces', {})
              setWorkspaces(spaces.ok ? (spaces.value?.workspaces ?? []) : [])
            } catch {
              setWorkspaces([])
            }
          }, [callHost, connection])

          // 模型目录与 Agent 预设：失败不影响主要配置。
          React.useEffect(() => {
            let cancelled = false
            const remote = service(ctx, 'remote')
            try {
              const catalogCall = remote?.session?.modelCatalog
              if (typeof catalogCall === 'function') {
                Promise.resolve(remote.session.modelCatalog()).then((result) => {
                  if (!cancelled && result?.ok) setCatalog(result.value)
                }).catch(() => {})
              }
              const presetsCall = remote?.agentPresets?.list
              if (typeof presetsCall === 'function') {
                Promise.resolve(remote.agentPresets.list()).then((result) => {
                  if (!cancelled && result?.ok) setPresets(result.value?.presets ?? [])
                }).catch(() => {})
              }
            } catch {}
            return () => { cancelled = true }
          }, [])

          React.useEffect(() => { loadState() }, [loadState])

          // 保存去抖：连续输入只在停顿后提交一次。
          const saveTimer = React.useRef(null)
          const pending = React.useRef(null)

          const flushSave = React.useCallback(async () => {
            const next = pending.current
            pending.current = null
            if (!next) return
            setSaving(true)
            try {
              const result = await callHost('save', { config: next })
              if (result.ok) {
                setState(result.value)
                setHostErrors([])
                setError('')
              } else {
                const list = result.error?.details?.errors
                setHostErrors(Array.isArray(list) ? list : [result.error?.message ?? '保存失败'])
              }
            } catch (err) {
              setHostErrors([`保存失败：${err?.message ?? err}`])
            } finally {
              setSaving(false)
            }
          }, [callHost])

          /** 更新草稿并安排保存。 */
          const updateConfig = React.useCallback((next) => {
            setDraft(next)
            pending.current = next
            if (saveTimer.current) clearTimeout(saveTimer.current)
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null
              flushSave()
            }, SAVE_DEBOUNCE_MS)
          }, [flushSave])

          React.useEffect(() => () => {
            if (saveTimer.current) clearTimeout(saveTimer.current)
          }, [])

          const setSecret = async (which, value) => {
            try {
              const result = await callHost('secret', { action: 'set', which, value })
              if (!result.ok) setError(result.error?.message ?? '设置密钥失败')
              else setFeedback('已保存密钥')
              await loadState()
            } catch (err) {
              setError(`设置密钥失败：${err?.message ?? err}`)
            }
          }

          const unsetSecret = async (which) => {
            try {
              await callHost('secret', { action: 'unset', which })
              setFeedback('已清除密钥')
              await loadState()
            } catch (err) {
              setError(`清除密钥失败：${err?.message ?? err}`)
            }
          }

          const pingPeer = async (peer) => {
            setFeedback(`正在测试 ${peer.id}…`)
            try {
              const result = await callHost('ping', { peer })
              if (!result.ok) {
                setFeedback(`测试 ${peer.id} 失败：${result.error?.message ?? '未知错误'}`)
                return
              }
              const value = result.value
              setFeedback(value.online
                ? `✓ ${peer.id} 在线 · 运行时 ${value.agent ?? '未知'} · 接受任务 ${value.worker ? '是' : '否'} · 负载 ${value.running ?? 0}/${value.capacity ?? 0} · ${value.latencyMs ?? 0}ms`
                : `✗ ${peer.id} 离线：${value.error ?? '未知原因'}`)
            } catch (err) {
              setFeedback(`测试 ${peer.id} 失败：${err?.message ?? err}`)
            }
          }

          /**
           * 刷新工作区列表。
           * @param {string} [note] - 完成后显示的提示。
           */
          const reloadWorkspaces = async (note) => {
            try {
              const result = await callHost('workspaces', {})
              setWorkspaces(result.ok ? (result.value?.workspaces ?? []) : [])
              if (note) setFeedback(note)
            } catch (err) {
              setFeedback(`读取工作区失败：${err?.message ?? err}`)
            }
          }

          if (loading) return h('div', { style: { padding: '20px', fontSize: '13px' } }, '加载中…')
          if (!state || !draft) {
            return h('div', { style: { padding: '20px' } },
              h('p', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '13px' } }, error || '无法加载配置'),
              h('button', { onClick: loadState, style: styles.button }, '重试'),
            )
          }

          // ---------- 就地校验 ----------
          const fieldErrors = {}
          if (!NODE_ID_PATTERN.test(draft.nodeId ?? '')) {
            fieldErrors.nodeId = '只能包含字母、数字、点、下划线、连字符，需以字母或数字开头，最长 63 字符'
          }
          if (draft.transport === 'http') {
            if (!draft.http?.host) fieldErrors.httpHost = '监听地址不能为空'
            if (!Number.isInteger(draft.http?.port) || draft.http.port < 1 || draft.http.port > 65535) {
              fieldErrors.httpPort = '端口范围 1–65535'
            }
          } else {
            if (!/^mqtts?:\/\/.+/.test(draft.mqtt?.url ?? '')) fieldErrors.mqttUrl = '需以 mqtt:// 或 mqtts:// 开头'
            if (!draft.mqtt?.topic || /[+#]/.test(draft.mqtt.topic)) fieldErrors.mqttTopic = '主题前缀不能为空，且不能含 + 或 #'
            const caFile = (draft.mqtt?.caFile ?? '').trim()
            const caPem = (draft.mqtt?.caPem ?? '').trim()
            if (caFile && caPem) fieldErrors.mqttCa = '文件与粘贴内容只能选一种'
            else if (caFile && !/^[A-Za-z]:[\\/]|^\//.test(caFile)) fieldErrors.mqttCa = 'CA 证书文件需要绝对路径'
            else if (caPem && !caPem.includes('BEGIN CERTIFICATE')) fieldErrors.mqttCa = '粘贴的内容不是 PEM 证书'
          }
          for (const peer of draft.peers ?? []) {
            if (!NODE_ID_PATTERN.test(peer.id)) fieldErrors[`peer-${peer.id}`] = '对端 ID 格式不合法'
            if (peer.url && !/^https?:\/\/.+/.test(peer.url)) fieldErrors[`peerUrl-${peer.id}`] = 'URL 需以 http:// 或 https:// 开头'
          }
          if (draft.worker?.enabled) {
            if (!draft.worker.workspaceId) fieldErrors.workspaceId = '必须绑定一个 DSH 工作区'
            if (!Number.isInteger(draft.worker.maxConcurrent) || draft.worker.maxConcurrent < 1 || draft.worker.maxConcurrent > 16) {
              fieldErrors.maxConcurrent = '范围 1–16'
            }
            if (!Number.isInteger(draft.worker.maxQueue) || draft.worker.maxQueue < 0 || draft.worker.maxQueue > 100) {
              fieldErrors.maxQueue = '范围 0–100'
            }
            if (draft.worker.defaultTimeoutSec < 60 || draft.worker.defaultTimeoutSec > 86400) {
              fieldErrors.defaultTimeout = '范围 60–86400 秒'
            }
            if (draft.worker.maxTimeoutSec < 60 || draft.worker.maxTimeoutSec > 86400) {
              fieldErrors.maxTimeout = '范围 60–86400 秒'
            } else if (draft.worker.maxTimeoutSec < draft.worker.defaultTimeoutSec) {
              fieldErrors.maxTimeout = '不能小于默认超时'
            }
          }

          // ---------- 小部件 ----------
          const Row = ({ label, hint, error: rowError, children }) => h('div', { style: styles.row },
            h('span', { style: styles.label }, label),
            children,
            rowError ? h('span', { style: styles.error }, rowError) : (hint ? h('span', { style: styles.hint }, hint) : null),
          )

          const text = (value, onChange, extra = {}) => h('input', {
            type: 'text',
            value: value ?? '',
            onChange: (e) => onChange(e.target.value),
            style: { ...styles.input, ...(extra.style ?? {}) },
            ...(extra.placeholder ? { placeholder: extra.placeholder } : {}),
            ...(extra.spellCheck === false ? { spellCheck: false } : {}),
          })

          const number = (value, onChange, { min, max, step = 1, width } = {}) => h('input', {
            type: 'number',
            value: Number.isFinite(value) ? value : '',
            min,
            max,
            step,
            onChange: (e) => {
              const raw = e.target.value
              const parsed = Number(raw)
              onChange(Number.isFinite(parsed) ? parsed : 0)
            },
            style: { ...styles.input, ...styles.inputNarrow, ...(width ? { width } : {}) },
          })

          const checkbox = (checked, onChange) => h('input', {
            type: 'checkbox',
            checked: checked === true,
            onChange: (e) => onChange(e.target.checked),
          })

          const select = (value, options, onChange, { width } = {}) => h('select', {
            value: value ?? '',
            onChange: (e) => onChange(e.target.value),
            style: { ...styles.input, ...(width ? { width } : {}) },
          }, ...options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))

          // 模型下拉：来自 DSH 模型目录。
          const modelOptions = (() => {
            const items = [{ value: '', label: '跟随 DSH 默认模型' }]
            for (const group of catalog?.groups ?? []) {
              for (const model of group.models ?? []) {
                items.push({ value: `${group.id}/${model.id}`, label: `${group.name} · ${model.name}` })
              }
            }
            return items
          })()
          const currentModelValue = draft.worker?.model?.provider && draft.worker?.model?.model
            ? `${draft.worker.model.provider}/${draft.worker.model.model}`
            : ''
          const currentModel = (catalog?.groups ?? [])
            .flatMap((group) => (group.models ?? []).map((model) => ({ group, model })))
            .find(({ group, model }) => `${group.id}/${model.id}` === currentModelValue)
          const effortOptions = [
            { value: '', label: '跟随模型默认' },
            ...((currentModel?.model?.reasoning?.efforts ?? []).map((effort) => ({ value: effort.id, label: effort.name }))),
          ]

          const presetOptions = [
            { value: '', label: '跟随 Host 默认预设' },
            ...(presets ?? []).map((preset) => ({ value: preset.id, label: preset.name ?? preset.id })),
          ]

          const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(draft.http?.host ?? '')

          return h('div', { style: { padding: '20px', maxWidth: '820px' } },

            h('h2', { style: { margin: '0 0 4px', fontSize: '16px' } }, t('title')),
            h('p', { style: { margin: '0 0 10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
              saving ? '保存中…' : '修改后自动保存；配置保存在 $DSH_HOME/dsh-awp/config.json'),
            h('p', { style: { margin: '0 0 14px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } },
              state.running
                ? h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '● 节点运行中')
                : h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, `● 节点已停止${state.error ? `（${state.error}）` : ''}`),
              state.secretSet ? ' · 共享密钥已设置' : ' · 共享密钥未设置',
            ),

            error && h('div', { style: { ...styles.banner, ...styles.errorBanner } }, error),
            hostErrors.length > 0 && h('div', { style: { ...styles.banner, ...styles.errorBanner } },
              h('div', null, '保存被拒绝：'),
              hostErrors.map((message, index) => h('div', { key: index }, `· ${message}`)),
            ),
            feedback && h('div', { style: styles.banner }, feedback),

            // ---------- 节点 ----------
            h('section', { style: styles.section },
              h('h3', { style: styles.sectionTitle }, '节点'),
              h('p', { style: styles.sectionDesc }, '节点 ID 用于标识本机，对端用它给你发消息；两台机器不能重名。'),
              h(Row, { label: '节点 ID', hint: '字母/数字开头，最长 63 字符', error: fieldErrors.nodeId },
                text(draft.nodeId, (value) => updateConfig({ ...draft, nodeId: value.trim() }), { placeholder: 'my-laptop', spellCheck: false }),
              ),
              h(Row, { label: '共享密钥', hint: state.secretSet ? '已设置（不回显）' : '未设置；监听非回环地址时必须设置' },
                h('button', {
                  onClick: () => setSecretForm(secretForm?.which === 'shared' ? null : { which: 'shared', value: '' }),
                  style: styles.button,
                }, secretForm?.which === 'shared' ? '取消' : '设置'),
                state.secretSet && h('button', {
                  onClick: () => unsetSecret('shared'),
                  style: { ...styles.button, marginLeft: '8px' },
                }, '清除'),
              ),
              secretForm?.which === 'shared' && h('div', { style: { ...styles.row, marginTop: '-2px' } },
                h('span', { style: styles.label }, ''),
                h('input', {
                  type: 'password',
                  value: secretForm.value,
                  autoFocus: true,
                  placeholder: '建议 32 位以上随机字符串；两台机器必须相同',
                  onChange: (e) => setSecretForm({ which: 'shared', value: e.target.value }),
                  style: styles.input,
                }),
                h('button', {
                  style: { ...styles.button, marginLeft: '8px' },
                  onClick: async () => {
                    const value = secretForm.value.trim()
                    if (value === '') { setFeedback('密钥不能为空'); return }
                    if (value.length < 16) { setFeedback('密钥太短，建议至少 32 个字符'); return }
                    await setSecret('shared', value)
                    setSecretForm(null)
                  },
                }, '确定'),
              ),
            ),

            // ---------- 通信方式 ----------
            h('section', { style: styles.section },
              h('h3', { style: styles.sectionTitle }, '通信方式'),
              h('p', { style: styles.sectionDesc }, 'HTTP 适合内网直连；MQTT 适合节点多、有 broker 或需要穿透 NAT 的场景。'),
              h(Row, { label: '传输协议' },
                select(draft.transport, [{ value: 'http', label: 'HTTP' }, { value: 'mqtt', label: 'MQTT' }], (value) => updateConfig({ ...draft, transport: value })),
              ),
              draft.transport === 'http' && h(Row, { label: '监听地址', hint: '127.0.0.1 仅本机；0.0.0.0 对外监听（必须配密钥）', error: fieldErrors.httpHost },
                text(draft.http.host, (value) => updateConfig({ ...draft, http: { ...draft.http, host: value.trim() } }), { spellCheck: false }),
              ),
              draft.transport === 'http' && h(Row, { label: '', hint: '' },
                h('button', { style: { ...styles.button, ...styles.buttonSmall, marginLeft: '120px' }, onClick: () => updateConfig({ ...draft, http: { ...draft.http, host: '127.0.0.1' } }) }, '仅本机'),
                h('button', { style: { ...styles.button, ...styles.buttonSmall, marginLeft: '6px' }, onClick: () => updateConfig({ ...draft, http: { ...draft.http, host: '0.0.0.0' } }) }, '所有网卡'),
              ),
              draft.transport === 'http' && h(Row, { label: '端口', hint: '1–65535；被占用时节点无法启动', error: fieldErrors.httpPort },
                number(draft.http.port, (value) => updateConfig({ ...draft, http: { ...draft.http, port: value } }), { min: 1, max: 65535, width: '110px' }),
              ),
              draft.transport === 'http' && !loopbackOnly && !state.secretSet && h('div', { style: { ...styles.banner, ...styles.warn, marginLeft: '120px' } },
                '当前监听地址会对外暴露，但没有设置共享密钥——节点将拒绝启动。请先设置密钥，或把地址改回 127.0.0.1。',
              ),
              draft.transport === 'mqtt' && h(Row, { label: 'Broker 地址', hint: 'mqtt:// 明文，mqtts:// 加密', error: fieldErrors.mqttUrl },
                text(draft.mqtt.url, (value) => updateConfig({ ...draft, mqtt: { ...draft.mqtt, url: value.trim() } }), { placeholder: 'mqtts://broker.example.com:8883', spellCheck: false }),
              ),
              draft.transport === 'mqtt' && h(Row, { label: '主题前缀', hint: '各节点订阅 前缀/节点ID', error: fieldErrors.mqttTopic },
                text(draft.mqtt.topic, (value) => updateConfig({ ...draft, mqtt: { ...draft.mqtt, topic: value.trim() } }), { placeholder: 'awp/team1', spellCheck: false }),
              ),
              draft.transport === 'mqtt' && h(Row, { label: '用户名', hint: 'broker 不需要时留空' },
                text(draft.mqtt.username, (value) => updateConfig({ ...draft, mqtt: { ...draft.mqtt, username: value.trim() } }), { spellCheck: false }),
              ),
              draft.transport === 'mqtt' && h(Row, { label: 'MQTT 密码', hint: state.mqttPasswordSet ? '已设置（不回显）' : '未设置' },
                h('button', {
                  onClick: () => setSecretForm(secretForm?.which === 'mqtt' ? null : { which: 'mqtt', value: '' }),
                  style: styles.button,
                }, secretForm?.which === 'mqtt' ? '取消' : '设置'),
                state.mqttPasswordSet && h('button', {
                  onClick: () => unsetSecret('mqtt'),
                  style: { ...styles.button, marginLeft: '8px' },
                }, '清除'),
              ),
              draft.transport === 'mqtt' && secretForm?.which === 'mqtt' && h('div', { style: styles.row },
                h('span', { style: styles.label }, ''),
                h('input', {
                  type: 'password',
                  value: secretForm.value,
                  autoFocus: true,
                  onChange: (e) => setSecretForm({ which: 'mqtt', value: e.target.value }),
                  style: styles.input,
                }),
                h('button', {
                  style: { ...styles.button, marginLeft: '8px' },
                  onClick: async () => {
                    if (secretForm.value === '') { setFeedback('密码不能为空'); return }
                    await setSecret('mqtt', secretForm.value)
                    setSecretForm(null)
                  },
                }, '确定'),
              ),
              // ---- TLS：自定义 CA ----
              draft.transport === 'mqtt' && h(Row, {
                label: 'CA 证书文件',
                hint: '自建 broker 的 server.pem 绝对路径；留空用系统信任链',
                error: fieldErrors.mqttCa,
              },
                text(draft.mqtt.caFile ?? '', (value) => updateConfig({
                  ...draft,
                  mqtt: { ...draft.mqtt, caFile: value.trim(), caPem: '' },
                }), { placeholder: 'D:\\certs\\server.pem', spellCheck: false }),
                h('button', {
                  style: { ...styles.button, marginLeft: '8px' },
                  onClick: () => setPemForm(pemForm === 'open' ? null : 'open'),
                }, pemForm === 'open' ? '收起粘贴' : '或粘贴证书'),
              ),
              draft.transport === 'mqtt' && pemForm === 'open' && h('div', { style: styles.row },
                h('span', { style: styles.label }, ''),
                h('textarea', {
                  value: draft.mqtt.caPem ?? '',
                  rows: 6,
                  placeholder: '-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----',
                  onChange: (e) => updateConfig({
                    ...draft,
                    mqtt: { ...draft.mqtt, caPem: e.target.value, caFile: '' },
                  }),
                  style: { ...styles.input, width: '380px', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '11px' },
                }),
              ),
              draft.transport === 'mqtt' && h(Row, {
                label: '证书主机名',
                hint: '证书 CN/SAN 与连接地址不一致时填写；一般留空',
              },
                text(draft.mqtt.servername ?? '', (value) => updateConfig({ ...draft, mqtt: { ...draft.mqtt, servername: value.trim() } }), { placeholder: 'broker.example.com', spellCheck: false }),
              ),
              draft.transport === 'mqtt' && h(Row, {
                label: '跳过证书校验',
                hint: '仅供自签测试；生产请配置 CA 证书',
              },
                checkbox(draft.mqtt.allowInvalidCert === true, (checked) => updateConfig({ ...draft, mqtt: { ...draft.mqtt, allowInvalidCert: checked } })),
              ),
              draft.transport === 'mqtt' && draft.mqtt.allowInvalidCert === true && h('div', { style: { ...styles.banner, ...styles.warn, marginLeft: '120px' } },
                '已关闭 TLS 证书校验：连接可能被中间人劫持。仅用于本地自签 broker 调试。'),
            ),

            // ---------- 对端 ----------
            h('section', { style: styles.section },
              h('h3', { style: styles.sectionTitle }, '对端节点'),
              h('p', { style: styles.sectionDesc },
                draft.transport === 'http'
                  ? 'HTTP 模式需要填对端 URL；本机自测可把对端设成自己的节点 ID。'
                  : 'MQTT 模式只需填对端节点 ID，URL 留空。'),
              (draft.peers ?? []).length === 0
                ? h('div', { style: styles.banner }, '还没有对端。点击下方「+ 添加对端」。')
                : h('table', { style: styles.table },
                  h('thead', null, h('tr', null,
                    h('th', { style: styles.th }, '节点 ID'),
                    h('th', { style: styles.th }, 'URL'),
                    h('th', { style: styles.th }, '操作'),
                  )),
                  h('tbody', null, ...(draft.peers ?? []).map((peer, index) => h('tr', { key: `${peer.id}-${index}` },
                    h('td', { style: { ...styles.td, ...styles.mono } },
                      peer.id,
                      fieldErrors[`peer-${peer.id}`] && h('div', { style: { ...styles.error, marginLeft: 0 } }, fieldErrors[`peer-${peer.id}`]),
                      peer.id === draft.nodeId && h('span', { style: styles.hint }, '（本机）'),
                    ),
                    h('td', { style: styles.td },
                      peer.url
                        ? h('span', { style: styles.mono }, peer.url)
                        : h('span', { style: styles.hint }, '（空：只能由我方主动查询）'),
                      fieldErrors[`peerUrl-${peer.id}`] && h('div', { style: { ...styles.error, marginLeft: 0 } }, fieldErrors[`peerUrl-${peer.id}`]),
                    ),
                    h('td', { style: styles.td },
                      h('button', { onClick: () => pingPeer(peer), style: { ...styles.button, ...styles.buttonSmall } }, '测试'),
                      h('button', {
                        onClick: () => updateConfig({ ...draft, peers: draft.peers.filter((_, j) => j !== index) }),
                        style: { ...styles.button, ...styles.buttonSmall, marginLeft: '6px' },
                      }, '删除'),
                    ),
                  ))),
                ),
              peerForm
                ? h('div', { style: { marginTop: '12px', padding: '12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px' } },
                  h(Row, { label: '对端 ID', error: peerForm.id && !NODE_ID_PATTERN.test(peerForm.id) ? 'ID 格式不合法' : '' },
                    h('input', {
                      type: 'text',
                      value: peerForm.id,
                      autoFocus: true,
                      placeholder: 'server-b，或本机自测填自己的节点 ID',
                      onChange: (e) => setPeerForm({ ...peerForm, id: e.target.value.trim() }),
                      style: styles.input,
                      spellCheck: false,
                    }),
                  ),
                  h(Row, { label: 'URL', hint: draft.transport === 'mqtt' ? 'MQTT 模式可留空' : '' },
                    h('input', {
                      type: 'text',
                      value: peerForm.url,
                      placeholder: draft.transport === 'http' ? 'http://127.0.0.1:7820' : '',
                      onChange: (e) => setPeerForm({ ...peerForm, url: e.target.value.trim() }),
                      style: styles.input,
                      spellCheck: false,
                    }),
                  ),
                  h('div', { style: { marginLeft: '120px' } },
                    h('button', {
                      style: styles.button,
                      onClick: () => {
                        if (!peerForm.id) { setFeedback('对端节点 ID 不能为空'); return }
                        if (!NODE_ID_PATTERN.test(peerForm.id)) { setFeedback('对端 ID 格式不合法'); return }
                        if (peerForm.url && !/^https?:\/\/.+/.test(peerForm.url)) { setFeedback('URL 需以 http:// 或 https:// 开头'); return }
                        if ((draft.peers ?? []).some((peer) => peer.id === peerForm.id)) { setFeedback(`对端 ${peerForm.id} 已存在`); return }
                        updateConfig({ ...draft, peers: [...(draft.peers ?? []), { id: peerForm.id, url: peerForm.url, description: '' }] })
                        setFeedback(`已添加对端 ${peerForm.id}`)
                        setPeerForm(null)
                      },
                    }, '添加'),
                    h('button', {
                      style: { ...styles.button, marginLeft: '8px' },
                      onClick: () => { setPeerForm(null); setFeedback('') },
                    }, '取消'),
                  ),
                )
                : h('button', {
                  onClick: () => setPeerForm({ id: '', url: draft.transport === 'http' ? `http://127.0.0.1:${draft.http?.port ?? 7820}` : '' }),
                  style: { ...styles.button, marginTop: '12px' },
                }, '+ 添加对端'),
            ),

            // ---------- 执行方 ----------
            h('section', { style: styles.section },
              h('h3', { style: styles.sectionTitle }, '执行方'),
              h('p', { style: styles.sectionDesc }, '启用后，本机会接受其他节点派来的任务，并在绑定的 DSH 工作区里新开会话执行。'),
              h(Row, { label: '启用执行方' },
                checkbox(draft.worker.enabled, (checked) => updateConfig({ ...draft, worker: { ...draft.worker, enabled: checked } })),
              ),
              draft.worker.enabled && h(Row, {
                label: '绑定工作区',
                hint: workspaces === null ? '读取中…' : (workspaces.length === 0 ? '还没有工作区' : ''),
                error: fieldErrors.workspaceId,
              },
                select(
                  draft.worker.workspaceId ?? '',
                  [
                    { value: '', label: '（未绑定）' },
                    ...(workspaces ?? []).map((workspace) => ({
                      value: workspace.id,
                      label: workspace.title && workspace.title !== workspace.path
                        ? `${workspace.title} — ${workspace.path}`
                        : (workspace.path || workspace.id),
                    })),
                  ],
                  (value) => updateConfig({ ...draft, worker: { ...draft.worker, workspaceId: value } }),
                  { width: '300px' },
                ),
                h('button', {
                  style: { ...styles.button, marginLeft: '8px' },
                  onClick: () => reloadWorkspaces('工作区列表已刷新'),
                }, '刷新'),
              ),
              draft.worker.enabled && workspaces !== null && workspaces.length === 0 && h('div', { style: { ...styles.banner, ...styles.warn, marginLeft: '120px' } },
                '当前没有可绑定的 DSH 工作区。请先在侧边栏创建一个工作区（或打开一个目录），再回到这里选择。'),
              draft.worker.enabled && (() => {
                const bound = (workspaces ?? []).find((workspace) => workspace.id === draft.worker.workspaceId)
                if (!bound) return null
                return h('div', { style: { ...styles.banner, marginLeft: '120px', fontSize: '12px' } },
                  h('span', { style: styles.mono }, bound.path || bound.id),
                  h('span', { style: styles.hint }, '任务会话会出现在这个工作区里'),
                )
              })(),
              draft.worker.enabled && h(Row, { label: '模型', hint: catalog ? '' : '模型目录加载中…' },
                select(currentModelValue, modelOptions, (value) => {
                  const [provider = '', model = ''] = value.split('/')
                  updateConfig({
                    ...draft,
                    worker: {
                      ...draft.worker,
                      model: { provider, model },
                      reasoningEffort: value === currentModelValue ? draft.worker.reasoningEffort : '',
                    },
                  })
                }, { width: '300px' }),
              ),
              draft.worker.enabled && h(Row, { label: '思考强度', hint: effortOptions.length > 1 ? '' : '当前模型没有可选档位' },
                select(draft.worker.reasoningEffort ?? '', effortOptions, (value) => updateConfig({ ...draft, worker: { ...draft.worker, reasoningEffort: value } }), { width: '200px' }),
              ),
              draft.worker.enabled && h(Row, { label: 'Agent 预设', hint: presets === null ? '加载中…' : '' },
                select(draft.worker.agentPreset ?? '', presetOptions, (value) => updateConfig({ ...draft, worker: { ...draft.worker, agentPreset: value } }), { width: '240px' }),
              ),
              draft.worker.enabled && h(Row, { label: '并发上限', hint: '同时执行几个任务，超出的进队列', error: fieldErrors.maxConcurrent },
                number(draft.worker.maxConcurrent, (value) => updateConfig({ ...draft, worker: { ...draft.worker, maxConcurrent: value } }), { min: 1, max: 16, width: '90px' }),
              ),
              draft.worker.enabled && h(Row, { label: '队列长度', hint: '队列满后新任务直接回 busy', error: fieldErrors.maxQueue },
                number(draft.worker.maxQueue, (value) => updateConfig({ ...draft, worker: { ...draft.worker, maxQueue: value } }), { min: 0, max: 100, width: '90px' }),
              ),
              draft.worker.enabled && h(Row, { label: '默认超时', hint: '秒；任务未指定时使用', error: fieldErrors.defaultTimeout },
                number(draft.worker.defaultTimeoutSec, (value) => updateConfig({ ...draft, worker: { ...draft.worker, defaultTimeoutSec: value } }), { min: 60, max: 86400, step: 60, width: '110px' }),
              ),
              draft.worker.enabled && h(Row, { label: '最大超时', hint: '秒；对端指定的超时会截断到此值', error: fieldErrors.maxTimeout },
                number(draft.worker.maxTimeoutSec, (value) => updateConfig({ ...draft, worker: { ...draft.worker, maxTimeoutSec: value } }), { min: 60, max: 86400, step: 60, width: '110px' }),
              ),
              draft.worker.enabled && h(Row, { label: '允许转派', hint: '开启后执行方会话也能再派任务（默认关闭）' },
                checkbox(draft.worker.allowRelay, (checked) => updateConfig({ ...draft, worker: { ...draft.worker, allowRelay: checked } })),
              ),
              draft.worker.enabled && h('div', { style: { ...styles.banner, ...styles.warn, marginLeft: '120px' } },
                h('strong', null, '安全提示：'),
                '收到的任务以完全权限（danger-full-access）执行——不限制文件访问、不弹审批。只把共享密钥交给你信任的机器，并尽量放在内网或 VPN 里。'),
            ),

            // ---------- 委派方 ----------
            h('section', { style: styles.section },
              h('h3', { style: styles.sectionTitle }, '委派方'),
              h('p', { style: styles.sectionDesc }, '关闭后 Agent 看不到 awp_send 等工具，但本机仍可作为执行方接收任务。'),
              h(Row, { label: '启用委派方' },
                checkbox(draft.delegator?.enabled, (checked) => updateConfig({ ...draft, delegator: { ...draft.delegator, enabled: checked } })),
              ),
            ),

            h('div', { style: { marginTop: '20px', display: 'flex', gap: '8px' } },
              h('button', { onClick: () => props.close(), style: styles.button }, '关闭'),
              h('button', {
                onClick: async () => {
                  pending.current = null
                  if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
                  setSaving(true)
                  try {
                    const result = await callHost('save', { config: draft })
                    if (result.ok) { setState(result.value); setHostErrors([]); setFeedback('已保存') }
                    else setHostErrors(result.error?.details?.errors ?? [result.error?.message ?? '保存失败'])
                  } catch (err) {
                    setHostErrors([`保存失败：${err?.message ?? err}`])
                  } finally {
                    setSaving(false)
                  }
                },
                style: styles.button,
              }, '立即保存'),
            ),
          )
        }
      },
    }
  },
})
