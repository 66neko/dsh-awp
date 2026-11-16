# dsh-awp 开发计划

状态：第二版（已按审批意见修订）
协议：[PROTOCOL.md](PROTOCOL.md)（AWP/1）
目标运行时：DeepSeek Harness 0.2.2-rc.3（Desktop 与 `dsh web`）

## 1. 目标

做一个 DSH 插件，让一个 DSH 把任务指派给另一台服务器上的 DSH 执行，执行完成后把结果送回。

- 执行方像一个机器人：绑定一个 **DSH 工作区**，配置好模型、思考强度和 Agent 预设。收到任务就在那个工作区里新开一个会话，以**完全权限**执行，结束后回传最终回答。做法参考 dsh-im：远端 DSH 相当于一个 IM 用户在给你发消息。
- 委派方的 Agent 通过工具发任务、查状态、取消任务。结果到达后自动作为一条新消息送进发起任务的会话，并唤醒该会话的 Agent。
- 传输支持 HTTP 和 MQTT，两者使用同一种文本帧。
- 所有配置都在 DSH 的「设置」里用图形界面完成，保存在插件自己的配置文件里，不改动 DSH 的配置文件。
- 插件能打包成一个 `.tgz` 文件，在 DSH 的插件页面用绝对路径安装。
- 协议核心不依赖 DSH，以后给 Claude Code、Codex 复用。

## 2. 第一版不做的事

- 文件和图片附件传输（结果只有文本；需要交换文件时由任务自己约定，例如提交到 git）
- 把执行方的审批请求和提问转发回委派方（执行方使用完全权限，不会产生审批）
- 流式转发执行过程（只发 `queued`、`running` 和最终 `result`）
- Claude Code、Codex 适配器（只在第 9 节规划）

## 3. 关键设计决定

| 问题 | 决定 |
|---|---|
| 会话策略 | 未传 `follow` 时新开会话；工具描述引导 Agent 对同一节点、同一话题的后续工作默认续接最近已结束任务，由 Agent 判断任务关系并填写 `follow` |
| 执行权限 | 固定为 `danger-full-access`（完全文件访问、无审批），不提供更低的选项 |
| 配置位置 | `$DSH_HOME/dsh-awp/config.json`，由插件读写；`cordis.patch.yml` 只登记插件行，不带配置 |
| 密钥存放 | 共享密钥和 MQTT 密码存入 DSH 凭据库（`ctx.credentials`），引用名为 `DSH_AWP_SECRET`、`DSH_AWP_MQTT_PASSWORD`；未存储时自动回落到同名环境变量 |
| HTTP 拓扑 | 双方都监听端口，执行方主动推送结果；推不通时委派方轮询 `query` |
| 包名 | `dsh-awp`（npm 无作用域名），插件行 id 为 `awp` |
| 语言 | 纯 JavaScript（ESM），不需要构建步骤；文档和注释以中文为主 |

## 4. 项目结构

```
dsh-awp/
  AGENTS.md               给参与开发的 AI Agent 的约定
  README.md               项目说明（GitHub 首页）
  LICENSE                 MIT
  package.json            包清单，含 dsh.bundle 与 dsh.client
  cordis.patch.yml        插入插件行 awp
  index.js                Host 插件入口
  client.js               浏览器端设置页（React.createElement，无 JSX）
  icon.svg                插件图标
  locale/zh.json, en.json 插件标题与说明
  src/
    core/                 协议核心，纯 Node，不引用任何 DSH 包
      frame.js            帧编解码、签名、校验
      dedupe.js           消息 id 去重缓存
      http-transport.js   node:http 服务端 + fetch 客户端
      mqtt-transport.js   基于 npm 包 mqtt（按需加载）
      node.js             AwpNode：收发、请求-回复关联、重试
    host/                 DSH 相关实现
      config-store.js     独立配置文件读写与校验
      task-store.js       任务表持久化
      harness.js          调用 DSH Session Remote 的封装
      worker.js           执行方：任务 → 会话 → 结果
      delegator.js        委派方：发任务、收结果、恢复
      tools.js            Agent 工具 awp_peers / awp_send / awp_task
      rpc.js              设置页使用的 Host RPC
      service.js          把以上组件装配起来，配置变更时整体重建
  bin/awp-cli.js          独立命令行节点（ping / send / query / serve），用于测试与对接
  test/                   node:test 单元测试
  docs/
    PROTOCOL.md
    DEV-PLAN.md
```

依赖：运行时依赖 `mqtt` **打包进 `vendor/`**（由 `pnpm run vendor` 从安装结果复制成扁平的 `vendor/node_modules/`），因此 `package.json` 没有 `dependencies`，安装 `.tgz` 时不需要访问 npm 源。HTTP 用 Node 内置模块。

## 5. 配置

### 5.1 配置文件

路径：`$DSH_HOME/dsh-awp/config.json`（`DSH_HOME` 未设置时为 `~/.dsh`）。文件不含任何密钥。示例：

```json
{
  "version": 1,
  "nodeId": "server-b",
  "transport": "http",
  "http": { "host": "0.0.0.0", "port": 7820, "maxBodyBytes": 1048576 },
  "mqtt": { "url": "mqtts://broker.example.com:8883", "topic": "awp/team1", "username": "" },
  "peers": [
    { "id": "server-a", "url": "http://10.0.0.4:7820", "description": "开发机" }
  ],
  "worker": {
    "enabled": true,
    "workspaceId": "",
    "model": { "provider": "", "model": "" },
    "reasoningEffort": "",
    "agentPreset": "",
    "maxConcurrent": 1,
    "maxQueue": 10,
    "defaultTimeoutSec": 3600,
    "maxTimeoutSec": 14400,
    "allowRelay": false
  },
  "delegator": { "enabled": true }
}
```

空字符串表示跟随 DSH 默认值。写入采用「临时文件 + 重命名」，避免写坏。

### 5.2 设置页

在 DSH「设置」左侧导航新增一项「Agent 协作」（`settings.section`，id `awp`）。页面分 5 组：

1. **节点**：节点 ID、运行状态（运行中 / 已停止 / 错误原因）、共享密钥（只显示是否已设置，可替换或清除，不回显明文）。
2. **通信方式**：HTTP / MQTT 切换。HTTP：监听地址、端口。MQTT：服务器地址、主题前缀、用户名、密码。
3. **对端**：增删改对端（ID、URL、备注），每行有「测试连接」按钮（发 `ping`，显示延迟与对端能力）。
4. **执行方**：启用开关、**绑定工作区**（下拉框，数据来自 DSH 工作区列表，可刷新）、模型与思考强度（下拉框，数据来自 DSH 模型目录）、Agent 预设（下拉框）、并发数、队列长度、默认与最大超时、是否允许转派。页面明确提示「收到的任务以完全权限执行」。
5. **最近任务**：收发两个方向最近 50 条任务的状态、对端、耗时，可打开对应会话、取消运行中的任务。

保存时整体校验，失败的字段在原位显示原因；保存成功后插件按新配置重建网络节点，不需要重启 DSH。

### 5.3 Host RPC

设置页通过 `ctx.connection.rpc.call('/api', 'dsh-awp', { method, payload })` 调用 Host，Host 在 `ctx.effect()` 中用 `ctx.connection.fetch.register({ path: '/api/dsh-awp', ... })` 注册精确路由并返回清理函数。端点按 `payload.method` 分派请求，沿用 DSH 对 `/api` 的浏览器认证和来源校验。

`/api` 通道的 interceptor 由 DSH 的 api-gateway 独占，插件不得调用 `ctx.connection.rpc.intercept('/api', ...)`，否则会影响 DSH 自身的 API 分派。

| 方法 | 作用 |
|---|---|
| `state` | 返回配置、密钥是否已设置、运行状态、模型目录、预设列表 |
| `save` | 校验并保存配置，重建节点 |
| `secret` | 设置或清除共享密钥 / MQTT 密码 |
| `ping` | 测试某个对端 |
| `workspaces` | 列出可绑定的 DSH 工作区 |
| `tasks` | 最近任务列表 |
| `cancel` | 取消任务 |

`awp_task` 工具的取消动作与设置页的 `cancel` 调用同一个 Host 方法。

### 5.4 启动校验

- HTTP 监听非回环地址、或使用 MQTT 时，没有共享密钥就不启动网络节点，设置页显示原因。
- 执行方绑定的工作区不存在时，执行方不接任务（`not_worker`），设置页显示原因。
- 配置文件不存在时使用默认配置（只监听 `127.0.0.1`，执行方关闭），不自动写文件。

MQTT 依赖加载、连接与订阅共享 15 秒启动上限；卸载先取消在途启动，再等待配置队列收尾。异步请求同时等待发送和回复，超时与取消不依赖 broker 的 PUBACK，停止节点也会中断重试退避。

## 6. 执行方流程

全部使用 dsh-im 已验证过的路径：通过 `ctx.typertGateway.invoke()` 调用 `session` Remote 命名空间，调用身份是 `ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })` 创建的进程内 Peer。

1. 收到 `task`：校验签名、时间窗口、`from` 是否在对端列表里、是否已知任务（幂等）。
2. 并发未满就立即开始，否则排队并回复 `status: queued`；队列满回复 `result: rejected / busy`。
3. 创建会话：`session.create({ cwd: workspace, agentPreset })`。带 `follow` 且能找到对应会话时复用那个会话。
4. 配置了模型时调 `session.selectModel({ sessionId, provider, model, reasoningEffort })`。
5. 设置完全权限：`ctx.permissionPresets.set(agent.session, 'danger-full-access')`。
6. `session.rename`，标题形如 `[AWP] server-a · 修复单测`，方便在侧边栏辨认。
7. `allowRelay` 为 false 时，`awp_*` 工具对执行方会话不可见（工具注册的 `when` 条件 + `ctx.tools.guard()` 双重保护），避免任务链式转发。
8. 记录当前会话日志位置，调 `session.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] })`。`text` 由任务 `prompt` 加一段简短说明组成：来源节点、无人值守、不要向用户提问、最后一条回复就是交付给委派方的结果。
9. 回复 `status: running`。
10. 监听 `session/event`，等到该会话在记录位置之后出现 `turn/end`。超时则 `session.cancel` 并回 `result: timeout`。
11. 取这一轮最后一条助手消息的文本作为 `result.text`。本轮以错误结束时回 `failed`，附错误信息；被取消时回 `cancelled`。
12. 保存结果到任务表（保留 7 天），推送 `result`。

收到 `cancel`：排队中的直接移除；运行中的调 `session.cancel`，然后回 `result: cancelled`。

## 7. 委派方流程

### 7.1 Agent 工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `awp_peers` | 无 | 列出配置的对端，并发 `ping` 返回在线状态、是否接任务、负载 |
| `awp_send` | `peer`、`prompt`、`title?`、`timeoutSec?`、`follow?`、`waitSec?` | 发出任务，返回任务 id 和初始状态。`waitSec > 0` 时最多阻塞等待这么久，期间完成就直接返回结果 |
| `awp_task` | `taskId`、`action: status \| cancel` | 查询（本地状态，必要时向对端 `query`）或取消 |

工具描述写清楚：结果会自动作为新消息送回本会话，不需要轮询。

`awp_send` 的描述同时引导 Agent 判断话题连续性：继续、补充、修正或验收同一话题时，默认用 `follow` 引用同一对端、该话题最近一个已结束任务的 ID；独立任务、明确要求重新开始或无关联任务时省略，并提供必要背景。ID 从工具返回值或结果回送消息中取得，不能猜测或使用会话 ID。等待当前话题最新任务结束后再续接，避免同一话题并发投递。此处只指导 Agent 选择参数，不由插件自动绑定上一任务。

### 7.2 结果回送

任务表记录「任务 id → 发起会话 id」。收到 `result` 后，用 `session.prompt({ sessionId, mode: 'queue', content })` 把结果作为一条消息送进发起会话：

```
[AWP 结果] server-b 完成任务 t-2c9e（修复单测），状态 done，用时 7 分钟：
<result.text>
```

这样会唤醒 Agent 继续工作，消息也进入会话日志，恢复和分叉时保留。消息里会标明结果来自远端节点。用 `waitSec` 同步拿到结果的任务不再重复回送。

### 7.3 恢复

- 插件启动时，对任务表里所有未终结的任务发 `query`。
- 发出的任务超过 `timeout + 5 分钟` 仍无结果时主动 `query`。
- 对端没有配置 URL（执行方推不过来）时，按 30 秒间隔 `query`。

## 8. 打包与安装

```
pnpm install          # 开发依赖与 mqtt
pnpm test             # 单元测试
pnpm pack             # 生成 dsh-awp-<版本>.tgz
```

安装：DSH「设置 → 插件 → 添加插件」，输入 `.tgz` 的**绝对路径**。插件包自带 `vendor/` 中的 MQTT 运行依赖，安装时无需访问 npm 源。开发依赖变更后需重新生成并提交 vendor；CI 会重新生成并核对仓库内容。

`package.json` 的 `files` 列出全部运行时文件，打包后用 `tar -tzf` 核对清单。

GitHub 发布流程由 `.github/workflows/release.yml` 管理：发布 Release（含预发布版）时检出对应标签，校验标签与包版本一致，在 Node.js 24 上安装锁定依赖、检查语法、运行测试并打包，将 `.tgz` 上传为 Release 附件。支持手动运行以验证打包，或为已有 Release 补传附件；工作流配置不进入插件安装包。

### 8.1 vendor 内置模块兼容性

部分 vendored 依赖会写成 require('process/') 或 require('string_decoder/')。这些写法在 Node 运行时可用，但会被 DSH 的模块解析器当作普通包名，导致 resolve.paths 返回空值并在加载插件时崩溃。每次执行 scripts/vendor-deps.mjs 时，脚本递归扫描生成的 JavaScript 文件，仅将精确匹配的 Node 内置模块改写为 require('node:<内置模块>')；普通第三方包不会被改动，重复执行结果稳定。CI 会重新生成 vendor 并检查仓库内容一致。

## 9. 以后接入 Claude Code 和 Codex

`src/core/` 不引用 DSH，可以直接复用：

- **委派方**：做一个 MCP 服务器 `awp-mcp`，提供同样的 `awp_peers`、`awp_send`、`awp_task` 工具。Claude Code 和 Codex 都支持 MCP。MCP 不能主动唤醒 Agent，所以这一侧用 `waitSec` 阻塞等待或让 Agent 调 `awp_task` 查询。
- **执行方**：做一个常驻进程（在 `bin/awp-cli.js serve` 基础上扩展），收到任务后在工作目录里以完全权限启动 `claude -p --dangerously-skip-permissions` 或 `codex exec --dangerously-bypass-approvals-and-sandbox`，取最终输出作为结果。
- 两者都通过 `pong.agent` 字段标明运行时，DSH 侧不需要任何改动。

## 10. 安全措施

- 执行方以完全权限运行，安全完全依赖下面几条，设置页和 README 都会明确提示。
- 共享密钥存入 DSH 凭据库，不写入配置文件、日志和 RPC 返回值。
- HMAC 签名、300 秒时间窗口、消息 id 去重、对端允许列表。
- 非回环监听或 MQTT 必须有密钥，否则不启动。
- HTTP 请求体大小上限；只开放 `/awp` 一个路径；不复用 DSH Web 服务器的端口和鉴权。
- 设置页 RPC 走 DSH 自带的 `/api` 认证。
- 远端结果以外部数据的身份进入委派方会话。

## 11. 开发阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| 1. 协议核心 | `src/core/`、`bin/awp-cli.js`、单元测试 | 两个 CLI 进程在本机互相 `ping`、收发任务；篡改签名、过期时间、未知对端都被拒绝 |
| 2. 执行方 | 配置文件、HTTP 监听、`worker.js`、任务表 | 安装到本机 DSH，用 `awp-cli` 发任务：侧边栏出现新会话，按配置的工作目录、模型、完全权限运行，CLI 收到 `running` 和 `done` 结果；`cancel`、超时、排队、`query` 按协议返回 |
| 3. 委派方 | 三个工具、结果回送、恢复 | 本机 DSH 把自己配成对端（回环自测），在会话里让 Agent 调 `awp_send`，结果自动回到该会话并唤醒 Agent；重启 DSH 后未完成任务能通过 `query` 取回 |
| 4. 设置页 | `client.js` 与 Host RPC | 在「设置 → Agent 协作」完成全部配置，保存后无需重启即生效；测试连接、最近任务可用；亮色与暗色主题显示正常 |
| 5. MQTT | `mqtt-transport.js` | 用本地或公共 broker 重复阶段 2、3 的用例；执行方离线期间发出的任务在其上线后被执行 |
| 6. 打包发布 | 图标、本地化说明、README | `pnpm pack` 生成的 `.tgz` 能通过「添加插件」安装；插件页显示正确的标题、说明和图标；两台机器之间完成一次真实任务往返 |
