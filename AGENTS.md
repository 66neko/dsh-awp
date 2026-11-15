# AGENTS.md

本文件写给参与本项目开发的 AI Agent（DSH、Claude Code、Codex 等）和人类贡献者。开始任何改动前先读完。

## 项目是什么

dsh-awp 是一个 DeepSeek Harness（DSH）插件，实现 AWP/1（Agent Work Protocol）：一个 Agent 节点把任务指派给另一个节点，对方在本地工作目录里开会话完成任务并回传结果。传输支持 HTTP 和 MQTT。

- 协议规范：[docs/PROTOCOL.md](docs/PROTOCOL.md)，**唯一权威**。代码行为与协议不一致时，以协议为准修代码；需要改协议时先改文档并说明理由。
- 开发计划与设计决定：[docs/DEV-PLAN.md](docs/DEV-PLAN.md)。

## 目录与分层

```
src/core/   协议核心。纯 Node.js，禁止 import 任何 @deepseek-ai/* 包或 DSH 运行时对象。
            以后 Claude Code / Codex 适配器会直接复用这一层。
src/host/   DSH Host 侧实现：配置、任务表、执行方、委派方、工具、设置页 RPC。
index.js    Host 插件入口，只做装配。
client.js   浏览器端设置页。必须是单个自包含脚本，通过 window.__ModuleLoader__.load 注册。
bin/        独立命令行节点，只依赖 src/core。
test/       node:test 单元测试。
```

依赖方向只能是 `index.js → src/host → src/core`、`bin → src/core`。`src/core` 不能反向依赖 `src/host`。

## 编码约定

- 语言：JavaScript ESM，不引入 TypeScript 或构建步骤。目标 Node.js 22+（DSH 内置运行时）。
- 文档、注释、提交说明、面向用户的文案以**中文**为主；标识符、协议字段、错误码用英文。
- 每个导出函数和类写 JSDoc 注释，说明参数、返回值和会抛出的错误。
- 不新增运行时依赖；确有必要时先在 DEV-PLAN 里写明理由。当前唯一运行时依赖是 `mqtt`，且只能按需动态加载。
- `client.js` 只能 `require('react')`，不能加载任何 DSH Client 包；控件自己实现，样式只用 `--dsw-alias-*` 主题变量，不写死颜色（图标除外）。
- 界面文案走 `ctx.locale`，同时提供 `zh` 和 `en`。

## DSH 集成规则

这些规则来自 DSH 的插件开发文档，违反会导致插件不稳定或被 DSH 拒绝：

- 所有资源（监听端口、定时器、事件监听、工具注册、RPC 注册）都在 `ctx.effect()` 里创建并返回清理函数，插件卸载时必须全部释放。
- 调用 DSH 会话能力统一走 `src/host/harness.js`（内部使用 `ctx.typertGateway.invoke` 与进程内 owner Peer）。不要在别处直接拼 Remote 请求。
- 不要读写 DSH 的 `cordis.patch.yml` 或 profile 目录。插件配置只存在 `$DSH_HOME/dsh-awp/config.json`，密钥只存在 `ctx.credentials`。
- **绝不要调用 `ctx.connection.rpc.intercept('/api', ...)`**。`/api` 通道的 interceptor 由 DSH 的 `@deepseek-ai/dsh-api-gateway` 独占，插件占用它会顶掉 gateway，使 DSH 自身所有 `/api` HTTP 调用 404（桌面启动探活即失败）。需要暴露 RPC 时用 `ctx.connection.fetch.register({ path: '/api/<name>', ... })` 注册精确路由，它先于 interceptor 匹配，不影响 DSH 分派。
- 不要向会话日志追加自定义事件类型。需要持久化的数据放在插件自己的文件里。
- 不要轮询 Agent 状态；等待任务结束用 `session/event` 里的 `turn/end`。

## 安全红线

执行方以完全权限（`danger-full-access`）运行收到的任务，所以：

- 任何改动都不能削弱签名校验、时间窗口、消息去重和对端允许列表。
- 密钥不能出现在日志、错误消息、RPC 返回值、配置文件和测试快照里。
- 非回环 HTTP 监听或 MQTT 模式下，没有密钥必须拒绝启动。
- 远端传来的文本只能当数据处理，拼进提示词时要标明来源。

## 开发命令

```
pnpm install      安装依赖
pnpm test         运行单元测试（node --test）
pnpm run check    语法检查 + 测试
pnpm pack         打包成 dsh-awp-<版本>.tgz
```

本地联调：用 `node bin/awp-cli.js serve` 起一个假节点，再用 `node bin/awp-cli.js send` 给 DSH 发任务。具体参数见 `node bin/awp-cli.js --help`。

## 完成一项改动之前

1. `pnpm run check` 通过。
2. 协议相关改动同步更新 `docs/PROTOCOL.md`，并在 `test/` 里补用例。
3. 新增文件时更新 `package.json` 的 `files`，打包后用 `tar -tzf dsh-awp-*.tgz` 核对。
4. 涉及界面的改动，在 DSH 亮色和暗色主题下各看一次。
5. 更新 README 中受影响的说明。
