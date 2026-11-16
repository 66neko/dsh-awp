# dsh-awp 0.3.3 修复报告

状态：已合入 main，目标版本 0.3.3。本报告依据 v0.3.1 基线与修复验证记录更新；不包含任何 broker 地址、凭据或节点私密配置。

## 修复内容

### 1. vendored Node 内置模块解析

- **现象**：DSH 加载内置 MQTT 依赖时，readable-stream 中的 require('process/')、require('string_decoder/') 被解析为普通包名，解析器返回空路径后触发异常。
- **修复**：scripts/vendor-deps.mjs 在复制依赖后递归扫描 .js/.cjs/.mjs 文件，仅把精确匹配的 Node 内置模块 require('<builtin>/') 改写为 require('node:<builtin>')；非内置包保持原样，重复运行不会继续改写。
- **已更新**：vendor/node_modules/readable-stream/lib/internal/shims/process.js、vendor/node_modules/readable-stream/lib/internal/streams/readable.js、vendor/README.md、docs/DEV-PLAN.md。

### 2. MQTT 异步投递地址

- **现象**：当对端配置 url: "" 时，原逻辑 peer.url ?? to 会保留空字符串，MQTT 发布到主题前缀而不是 <主题前缀>/<节点 ID>。
- **修复**：src/core/node.js 增加按传输层语义选择地址的 deliveryAddress()。异步传输（syncReply === false）始终使用节点 ID；HTTP 等同步传输继续使用 peer.url ?? to。request() 与 push() 均使用该函数。
- **回归测试**：新增空 URL 的异步传输测试，分别覆盖请求和单向推送，断言两次发送都使用 node-b。

## 版本与验证

- package.json、Host pong 版本已从 0.3.1 更新为 0.3.3，README 安装示例同步更新。
- GitHub Release 工作流会在发布 v0.3.3 时执行冻结安装、vendor 一致性检查、语法检查、完整测试与 pnpm pack，并将 dsh-awp-0.3.3.tgz 上传为附件。
- 外部报告中的 113/113 测试与真实 broker 往返属于另一环境的验证；本仓库新增的回归用例已提交，真实 broker 验证不在本次 GitHub API 环境中重复声称。最终 CI 运行结果以对应 Release 的 Actions 记录为准。
