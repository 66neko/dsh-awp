# dsh-awp

让多个 AI Agent 互相指派任务的 DeepSeek Harness（DSH）插件。

一台机器上的 DSH 可以把任务交给另一台机器上的 DSH：对方在自己绑定的 DSH 工作区里创建或续接一个会话，用配置好的模型完成任务，再把最终回答送回来。结果会作为一条新消息出现在发起任务的会话里，Agent 读到后继续工作。

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

### 从 npm 安装

在 DSH「设置 → 插件 → 添加插件」中输入 `dsh-awp`，或使用命令行：

```sh
dsh plugin --profile desktop add dsh-awp
```

Web 用户将 `desktop` 改为 `web`。需要固定版本时使用 `dsh-awp@0.3.6`。从 npm 安装后，可通过 DSH 插件管理器查询和更新版本；已有本地 `.tgz` 安装需改用 npm 来源，才能使用注册表版本更新。

### 从打包文件安装

1. 从 [GitHub Releases](https://github.com/66neko/dsh-awp/releases) 的 Assets 下载 `dsh-awp-<版本>.tgz`，或自行打包（见下方「开发」）。
2. 打开 DSH「设置 → 插件 → 添加插件」，输入 `.tgz` 文件的**绝对路径**，例如 `D:\downloads\dsh-awp-0.3.6.tgz`。
3. **安装不需要联网**：运行所需的 `mqtt` 及其传递依赖已随包放在 `vendor/` 里。

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

MQTT 启动会等待连接和收件箱订阅确认，默认总超时为 15 秒；失败后会释放连接，保存新配置可重试。请求超时包含等待 broker 发布确认的时间，停止节点会取消在途请求和重试。插件卸载会先取消未完成的启动，再清理配置队列，避免保存或卸载一直等待。
MQTT 属于异步传输，发布地址始终使用对端节点 ID；即使对端配置里的 URL 是空字符串，也不会把消息发到主题前缀本身。

#### 自建 broker 与自定义证书

如果你的 broker 用自签证书（例如自己生成的 `server.pem`），在「通信方式 → MQTT」里填：

| 字段 | 说明 |
|---|---|
| **CA 证书文件** | `server.pem` 的**绝对路径**，例如 `D:\certs\server.pem`。插件会在启动时读取，读不到会拒绝启动并给出原因 |
| **或粘贴证书** | 直接把 PEM 文本粘进文本框（与文件路径二选一） |
| **证书主机名** | 证书的 CN/SAN 与连接地址不一致时填（如连 `10.0.0.5` 但证书是 `broker.example.com`） |
| **跳过证书校验** | 仅供自签调试，会显示风险提示；生产环境请配 CA |

示例 `server.pem` 生成与自签流程（openssl）：

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout server.key -out server.pem -subj "/CN=broker.example.com"
```

把 `server.pem` 填进上面的「CA 证书文件」，broker 端使用同一份 `server.key` / `server.pem` 即可。

修改 CA 来源、证书主机名或证书校验开关后，保存会自动重建 MQTT 连接并应用新设置。

## Agent 工具

| 工具 | 作用 |
|---|---|
| `awp_peers` | 列出已配置的对端及在线状态、负载 |
| `awp_send` | 把任务派给某个对端；同一话题通过 `follow` 续接上下文；`waitSec` 大于 0 时同步等待结果，否则结果稍后自动回到本会话 |
| `awp_task` | 查询任务状态或取消任务 |

执行方会话里默认看不到这些工具，避免任务被层层转派（可在设置里开启「允许转派」）。

### 话题连续性

`awp_send` 的工具描述会引导 Agent 自行判断任务关系：向同一节点继续、补充、修正或验收当前话题时，默认填写 `follow`，指向该话题最近一个已结束任务的 `task` ID；全新独立任务、明确要求重新开始或没有可用关联任务时省略 `follow`，并在任务说明里提供必要背景。同一节点有多个话题时，应选择当前话题对应的任务。

例如第一次发送任务返回 `task: "t-123"`，收到结果后可以这样继续：

```json
{
  "peer": "server-b",
  "prompt": "按刚才的方案继续实现，并运行测试",
  "follow": "t-123"
}
```

任务 ID 可从 `awp_send` 返回值或自动回送的 `[AWP 结果]` 消息中取得。每次续接仍会产生新的任务 ID，后续应引用当前话题最新已结束任务的 ID。等待该话题最新任务结束后再续接，避免同一话题并发投递。

这是给 Agent 的选择指引，实际是否续接取决于调用参数：省略 `follow` 会新建会话，不会自动关联上一次任务；执行方找不到对应任务会话时也会新建。续接保留的是执行方的上下文，不会自动同步发起方的完整聊天历史。

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
pnpm run vendor    更新离线运行依赖（修改依赖后需重新生成并提交 vendor/）
pnpm test          运行单元测试
pnpm run check     语法检查 + 单元测试
pnpm pack          打包成 dsh-awp-<版本>.tgz
```

参与开发前请阅读 [AGENTS.md](AGENTS.md)。

### 发布插件

每次交付项目改动时默认发布一版 Release，完整交付要求见 [AGENTS.md](AGENTS.md#发布-release)。

1. 更新 `package.json` 的 `version`，提交并推送到 GitHub。
2. 在 [GitHub Releases](https://github.com/66neko/dsh-awp/releases/new) 创建 Release，标签使用对应版本（例如版本 `0.2.3` 使用标签 `v0.2.3`），并选择包含上述修改的提交。
3. 点击发布后，GitHub Actions 会检出该标签，使用 Node.js 24 安装锁定的依赖，检查语法、运行测试，再执行 `pnpm pack`。成功后，`dsh-awp-<版本>.tgz` 会自动出现在该 Release 的 Assets 中，可直接下载并安装到 DSH。

正式版和预发布版都会触发；保存为草稿时不会触发。标签支持 `v<版本>` 或 `<版本>`，必须与 `package.json` 一致；检查或打包失败时不会上传插件包，可在 Actions 页面查看原因并重新运行。

也可以在 Actions →「打包并上传插件」→ Run workflow 手动运行：标签留空时仅检查和打包，产物保留 14 天；填写已有 Release 的标签时，会为该 Release 上传或替换同名安装包。自动流程使用 GitHub 提供的 `GITHUB_TOKEN`，无需配置额外密钥。

#### 同步发布到 npm

工作流已包含可选的 npm 发布任务。先完成一次性配置，再把仓库变量 `NPM_PUBLISH_ENABLED` 设为 `true`，之后每次发布 GitHub Release 都会将同一个已检查的 `.tgz` 发布到 npm。尚未配置时，GitHub Release 打包照常执行，npm 任务显示为跳过。

1. 注册 npm 账号、验证邮箱并启用双重验证（2FA）。首次发布在本机完成，以便创建包并取得维护权限。下载要发布版本的 Release 附件，在该文件所在目录执行（版本以实际文件为准）：

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm publish ./dsh-awp-0.3.6.tgz --access public --registry=https://registry.npmjs.org/
   ```

2. 打开 npm 网站的 **dsh-awp → Settings → Trusted publishing → Add trusted publisher**，选择 **GitHub Actions**，填写：

   | 设置项 | 值 |
   |---|---|
   | Organization or user | `66neko` |
   | Repository | `dsh-awp` |
   | Workflow filename | `release.yml`（不带目录） |
   | Environment name | 留空 |
   | Allow npm publish | 启用直接发布 |

3. 打开 GitHub 仓库的 **Settings → Secrets and variables → Actions → Variables → New repository variable**，名称填 `NPM_PUBLISH_ENABLED`，值填 `true`。这是普通变量；Trusted Publishing 使用 GitHub 的 OIDC 身份，不需要 `NPM_TOKEN` Secret。不要把 npm 密码或验证码放进仓库。
4. 递增版本并发布新的 GitHub Release。在 Actions 中确认「检查并打包」和「发布到 npm」两个任务成功，再运行 `npm view dsh-awp version --registry=https://registry.npmjs.org/` 核对正式版本。

按 npm 当前规则，新建的 Trusted Publisher 配置需在两天内完成第一次成功发布；超时需删除后重建。因此应在准备发布下一个版本时完成第 2、3 步。工作流使用 GitHub 托管 runner、Node.js 24、支持 OIDC 的 npm CLI，并仅给 npm 任务 `id-token: write` 权限。配置细节见 [npm Trusted Publishing 文档](https://docs.npmjs.com/trusted-publishers/)。

正式版发布到 npm 的 `latest`，GitHub 预发布版或带预发布后缀的包版本发布到 `next`。npm 同一版本不能覆盖；重跑时，已存在版本只有在安装包完整性哈希一致时才跳过重复上传，内容不同会报错。已发布版本的 dist-tag 不会在重跑时自动调整；将预发布版转为正式版时应发布新的正式版本。

npm 发布失败不影响已经上传的 Release 附件，但同步发布尚未完成。修正 npm 配置后可在 Actions 重跑失败的 npm 任务；也可手动运行工作流并填写对应标签，重建安装包后再发布。仓库变量启用时，带标签的手动运行也会发布到 npm；标签留空则始终只检查和打包。

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
