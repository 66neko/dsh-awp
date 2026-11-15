# dsh-awp

让多个 AI Agent 互相指派任务的 DeepSeek Harness（DSH）插件。

一台机器上的 DSH 可以把任务交给另一台机器上的 DSH：对方在自己绑定的 DSH 工作区里新开一个会话，用配置好的模型完成任务，再把最终回答送回来。结果会作为一条新消息出现在发起任务的会话里，Agent 读到后继续工作。

两台机器之间可以用 **HTTP** 直连，也可以通过 **MQTT** 服务器中转。两种方式传输的是同一种文本协议 [AWP/1](docs/PROTOCOL.md)，以后 Claude Code 和 Codex 也会按这个协议接入。

> [!WARNING]
> 执行方以**完全权限**运行收到的任务：不限制文件访问，不弹审批。只把节点 ID 和共享密钥交给你信任的机器，并尽量在内网、VPN 或 TLS 下使用。

## 功能

- 在 DSH「设置 → Agent 协作」里完成全部配置，保存后立即生效，不需要重启 DSH。
- 配置保存在插件自己的文件 `$DSH_HOME/dsh-awp/config.json`，不修改 DSH 的配置；共享密钥保存在 DSH 凭据库。
- 执行方：绑定一个 DSH 工作区（不是裸目录），任务会话直接出现在该工作区里；可配模型、思考强度、Agent 预设；支持并发上限、排队、超时和取消。
- 委派方：Agent 获得 `awp_peers`、`awp_send`、`awp_task` 三个工具，可以列出对端、派发任务、查询或取消任务。
- 可靠性：消息签名（HMAC-SHA256）、防重放、去重、任务幂等，断线或重启后通过查询取回结果。

## 安装

需要 DeepSeek Harness 0.2.2 或更新版本（Desktop 或 `dsh web`）。

### 从打包文件安装

1. 从 [GitHub Releases](https://github.com/66neko/dsh-awp/releases) 的 Assets 下载 `dsh-awp-<版本>.tgz`，或自行打包（见下方「开发」）。
2. 打开 DSH「设置 → 插件 → 添加插件」，输入 `.tgz` 文件的**绝对路径**，例如 `D:\downloads\dsh-awp-0.1.0.tgz`。
3. 安装时 DSH 会从 npm 源下载依赖 `mqtt`，需要能访问 npm 源。

### 从源码目录安装

先获取源码并安装依赖：

```sh
git clone https://github.com/66neko/dsh-awp.git
cd dsh-awp
pnpm install
```

然后在「添加插件」里输入项目目录的绝对路径即可。

## 快速上手

以两台机器 A（委派方）和 B（执行方）为例，使用 HTTP。

**在 B 上：**

1. 打开「设置 → Agent 协作」。
2. 节点 ID 填 `server-b`，设置一个共享密钥（两台机器必须相同）。
3. 通信方式选 HTTP，监听地址 `0.0.0.0`，端口 `7820`。
4. 在「对端」里添加 `server-a`，URL 填 `http://<A 的地址>:7820`。
5. 打开「执行方」，绑定一个工作区，按需选择模型和思考强度，保存。

**在 A 上：**

1. 节点 ID 填 `server-a`，设置同样的共享密钥，HTTP 监听 `0.0.0.0:7820`。
2. 在「对端」里添加 `server-b`，URL 填 `http://<B 的地址>:7820`，点「测试连接」。
3. 保存后，在任意会话里对 Agent 说：

   ```
   用 awp_send 让 server-b 运行 npm test 并修复失败的用例
   ```

B 的侧边栏会出现一个 `[AWP] server-a · …` 会话。完成后，结果自动回到 A 的这个会话里。

如果 B 无法访问 A（例如 A 在 NAT 后面），A 的对端里照常配置 B 的 URL，B 的对端里 `server-a` 的 URL 留空即可，A 会定期查询结果。

### 本机自测（一个节点连自己）

不用两台机器就能验证整条链路：让本节点把自己的节点 ID 当成对端。

1. 「节点」里把节点 ID 设为 `local-test`。
2. 「通信方式」选 HTTP，监听地址 `127.0.0.1`（回环地址不需要密钥），端口 `7820`。
3. 「对端节点」点「+ 添加对端」，ID 填 **`local-test`**（和自己一样），URL 填 `http://127.0.0.1:7820`。
4. 「执行方」勾选「启用执行方」，在「绑定工作区」里选一个已有的 DSH 工作区（任务的会话会出现在这个工作区里）。
5. 点对端行的「测试」，应显示 `✓ local-test 在线 · 接受任务 是`。
6. 在任意会话里让 Agent 调 `awp_send`，`peer` 填 `local-test`：

   ```
   用 awp_send 让 local-test 在它的工作区里创建一个 hello.txt，内容是 hello
   ```

本机会自己收到任务、新开一个 `[AWP] local-test · …` 会话并执行，完成后把结果作为新消息送回你的会话。

> 自测时对端 URL 必须是本机可访问的回环地址；把监听地址改成 `0.0.0.0` 就属于对外暴露，必须配置共享密钥。

### 使用 MQTT

两台机器都选择 MQTT，填写同一个服务器地址（如 `mqtts://broker.example.com:8883`）和同一个主题前缀（如 `awp/team1`）。每个节点订阅 `<主题前缀>/<节点 ID>`，对端只需要填 ID，不需要 URL。使用 MQTT 时必须设置共享密钥。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `awp_peers` | 列出已配置的对端及在线状态、负载 |
| `awp_send` | 把任务派给某个对端；`waitSec` 大于 0 时同步等待结果，否则结果稍后自动回到本会话 |
| `awp_task` | 查询任务状态或取消任务 |

执行方会话里默认看不到这些工具，避免任务被层层转派（可在设置里开启「允许转派」）。

## 配置文件

设置页写入 `$DSH_HOME/dsh-awp/config.json`（Windows 默认 `C:\Users\<用户>\.dsh\dsh-awp\config.json`）。一般不需要手动编辑，字段说明见 [docs/DEV-PLAN.md](docs/DEV-PLAN.md#5-配置)。

密钥不写进这个文件。插件从 DSH 凭据库读取 `DSH_AWP_SECRET`（共享密钥）和 `DSH_AWP_MQTT_PASSWORD`（MQTT 密码）；凭据库里没有时，回落到同名环境变量。

## 命令行工具

`bin/awp-cli.js` 是一个不依赖 DSH 的 AWP 节点，用于测试或对接其他系统：

```
node bin/awp-cli.js --help
node bin/awp-cli.js ping  --node cli --peer server-b --url http://127.0.0.1:7820 --secret <密钥>
node bin/awp-cli.js send  --node cli --peer server-b --url http://127.0.0.1:7820 --secret <密钥> --prompt "列出工作目录下的文件"
```

## 开发

```
pnpm install       安装依赖
pnpm test          运行单元测试
pnpm run check     语法检查 + 单元测试
pnpm pack          打包成 dsh-awp-<版本>.tgz
```

参与开发前请阅读 [AGENTS.md](AGENTS.md)。

### 发布插件

1. 更新 `package.json` 的 `version`，提交并推送到 GitHub。
2. 在 [GitHub Releases](https://github.com/66neko/dsh-awp/releases/new) 创建 Release，标签使用对应版本（例如版本 `0.2.3` 使用标签 `v0.2.3`），并选择包含上述修改的提交。
3. 点击发布后，GitHub Actions 会检出该标签，使用 Node.js 24 安装锁定的依赖，检查语法、运行测试，再执行 `pnpm pack`。成功后，`dsh-awp-<版本>.tgz` 会自动出现在该 Release 的 Assets 中，可直接下载并安装到 DSH。

正式版和预发布版都会触发；保存为草稿时不会触发。标签支持 `v<版本>` 或 `<版本>`，必须与 `package.json` 一致；检查或打包失败时不会上传插件包，可在 Actions 页面查看原因并重新运行。

也可以在 Actions →「打包并上传插件」→ Run workflow 手动运行：标签留空时仅检查和打包，产物保留 14 天；填写已有 Release 的标签时，会为该 Release 上传或替换同名安装包。自动流程使用 GitHub 提供的 `GITHUB_TOKEN`，无需配置额外密钥。

## 文档

- [AWP/1 协议](docs/PROTOCOL.md)
- [开发计划与设计决定](docs/DEV-PLAN.md)

## 路线图

- [x] AWP/1 协议、HTTP 与 MQTT 传输
- [x] DSH 执行方与委派方、设置页
- [ ] 附件传输
- [ ] Claude Code / Codex 适配器（MCP 委派方 + 常驻执行方）

## 致谢

执行方「绑定 DSH 工作区和模型、像 IM 机器人一样接收任务」的思路参考了 [dsh-im](https://github.com/xmanrui/dsh-im)。

## 许可证

[MIT](LICENSE)
