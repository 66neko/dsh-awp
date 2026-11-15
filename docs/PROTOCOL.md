# AWP/1 — Agent Work Protocol

版本：1（草案，待审批）

AWP 用于在两个 Agent 节点之间指派任务并取回结果。一个节点把任务交给另一个节点，对方在本地工作目录里开一个 Agent 会话完成任务，再把最终结果发回来。

协议只定义文本帧和消息语义，与运行时无关。DSH 是第一个实现，Claude Code、Codex 以后按同一协议接入。HTTP 和 MQTT 传输完全相同的帧，区别只在怎么送达。

## 1. 角色与术语

| 术语 | 含义 |
|---|---|
| 节点（node） | 运行 AWP 的一个 Agent 实例，用唯一的 `nodeId` 标识 |
| 委派方（delegator） | 发出任务的节点 |
| 执行方（worker） | 接收并执行任务的节点 |
| 任务（task） | 一次委派，由委派方生成全局唯一的 `task` id |

同一个节点可以同时是委派方和执行方。

`nodeId` 规则：`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`。不能含 `/`、`+`、`#`，保证能直接用作 MQTT 主题段。

## 2. 帧格式

一条消息就是一个 UTF-8 文本帧，由两行组成：

```
AWP/1 <sig>
<json>
```

- 第一行：协议标识 `AWP/1`，一个空格，然后是签名 `<sig>`。行尾为 `\n`。
- 第二行：消息信封，单行 JSON（JSON 内部不得出现未转义换行）。
- `<sig>` = `HMAC-SHA256(secret, <json 的原始 UTF-8 字节>)` 的小写十六进制。签名覆盖第二行的原始字节，接收方不需要重新序列化 JSON。
- 未配置密钥时 `<sig>` 写 `-`。只允许在双方都监听回环地址（测试）时使用；配置了密钥的接收方必须拒绝 `-`。

## 3. 信封

```json
{"id":"8f1c…","type":"task","from":"node-a","to":"node-b","ts":1763196000000,"task":"t-2c9e…","body":{}}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 消息 id，建议 UUID。用于去重 |
| `type` | string | 是 | 消息类型，见第 4 节 |
| `from` | string | 是 | 发送方 `nodeId` |
| `to` | string | 是 | 接收方 `nodeId` |
| `ts` | integer | 是 | 发送时间，Unix 毫秒 |
| `task` | string | 任务类消息必填 | 任务 id，由委派方生成，整个任务生命周期不变 |
| `re` | string | 否 | 所回复消息的 `id` |
| `body` | object | 否 | 类型相关内容，缺省为 `{}` |

接收方忽略不认识的字段，便于以后扩展。

## 4. 消息类型

共 7 种。`status` 表示非终态，`result` 表示终态，一个任务只有一个终态结果。

| type | 方向 | 用途 | 接收方的回复 |
|---|---|---|---|
| `ping` | 任意 | 探活、查询能力 | `pong` |
| `pong` | 任意 | 回复 `ping` | 无 |
| `task` | 委派方 → 执行方 | 指派任务 | `status`（已排队/运行中）或 `result`（拒绝） |
| `status` | 执行方 → 委派方 | 任务进度（非终态） | 无 |
| `result` | 执行方 → 委派方 | 任务结束（终态） | 无 |
| `cancel` | 委派方 → 执行方 | 取消任务 | 当前 `status`，取消完成后再发 `result` |
| `query` | 委派方 → 执行方 | 查询任务当前状态 | 最新的 `status` 或 `result` |

### 4.1 ping / pong

`ping.body`：`{}`

`pong.body`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `agent` | string | 运行时：`dsh`、`claude-code`、`codex` 等 |
| `version` | string | 实现版本 |
| `worker` | boolean | 是否接受任务 |
| `running` | integer | 正在执行的任务数 |
| `capacity` | integer | 最大并发任务数 |
| `name` | string | 可选，展示名 |

### 4.2 task

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | 是 | 任务说明，作为执行方 Agent 收到的用户消息 |
| `title` | string | 否 | 短标题，执行方用作会话标题 |
| `timeout` | integer | 否 | 执行超时，秒。执行方可用自身上限截断 |
| `follow` | string | 否 | 先前某个任务的 `task` id。执行方在同一会话里继续，保留上下文；找不到时按新任务处理 |

### 4.3 status

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | string | `queued`（排队）或 `running`（执行中） |
| `note` | string | 可选，简短进度说明 |

### 4.4 result

| 字段 | 类型 | 说明 |
|---|---|---|
| `state` | string | `done`、`failed`、`cancelled`、`timeout`、`rejected` |
| `text` | string | 最终结果文本（执行方 Agent 的最终回答）。`done` 时必有 |
| `error` | object | 非 `done` 时提供：`{"code": string, "message": string}` |
| `elapsed` | integer | 可选，执行耗时毫秒 |

### 4.5 cancel / query

`body` 为 `{}`。

`query` 找不到任务时回复 `result`，`state` 为 `failed`，`error.code` 为 `unknown_task`。

## 5. 错误码

| code | 含义 |
|---|---|
| `bad_frame` | 帧或 JSON 不合法、缺少必填字段 |
| `bad_sig` | 签名错误或缺失 |
| `expired` | `ts` 超出时间窗口 |
| `unknown_peer` | `from` 不在接收方允许列表中 |
| `not_worker` | 接收方不接受任务 |
| `busy` | 并发已满且不排队 |
| `unknown_task` | 任务不存在 |
| `timeout` | 执行超时 |
| `cancelled` | 已取消 |
| `internal` | 执行方内部错误 |

协议级错误（`bad_frame`、`bad_sig`、`expired`、`unknown_peer`）不产生回复消息，只在 HTTP 响应码里体现（见 7.1），MQTT 下直接丢弃并记日志，防止被利用来探测或放大流量。

## 6. 可靠性规则

1. **至少一次投递**：发送方可以重发，接收方按 `id` 去重（至少保留最近 1 小时的 id）。
2. **任务幂等**：执行方收到已知 `task` id 的 `task` 时不重复执行，只回复当前状态。
3. **时间窗口**：`|接收时间 - ts| > 300 秒` 的消息拒绝（`expired`）。节点需要同步系统时钟。
4. **结果保留**：执行方至少保留终态结果 7 天，供 `query` 取回。
5. **丢结果的恢复**：委派方没有收到 `result` 时（离线、推送失败、超时），用 `query` 主动拉取。所以协议不需要 ack 消息。
6. **重试**：`task`、`cancel`、`query` 在没有得到任何回复时按退避重试（如 2s、4s、8s…，上限 60s）。

## 7. 传输映射

两种传输承载的帧完全相同。

### 7.1 HTTP

每个节点监听一个可配置的 `host:port`。对端用基础 URL 标识，例如 `http://10.0.0.5:7820`。

**发送**：`POST {baseUrl}/awp`

- 请求头：`Content-Type: text/plain; charset=utf-8`
- 请求体：一个帧，默认最大 1 MiB

**响应**：

| 状态码 | 含义 |
|---|---|
| `200` | 响应体是一个回复帧（`ping`→`pong`，`task`/`cancel`/`query`→`status` 或 `result`） |
| `204` | 已接收，没有即时回复（`status`、`result`、`pong` 等） |
| `400` | `bad_frame` |
| `401` | `bad_sig`、`expired` 或 `unknown_peer` |
| `413` | 帧过大 |

**异步推送**：执行方把后续的 `status`、`result` 用 `POST` 推给委派方的基础 URL（委派方必须在执行方的对端配置里有 URL）。

**单向可达**：如果执行方连不到委派方（例如委派方在 NAT 后面），委派方定期发 `query`，结果从 HTTP 200 响应体返回。

**探活**：`GET {baseUrl}/awp` 返回 `200`，响应体为 `AWP/1 <nodeId>`。

### 7.2 MQTT

配置项只有 broker 地址和主题前缀 `{topic}`，以及可选的 broker 用户名、密码。

- 每个节点订阅自己的收件箱：`{topic}/{nodeId}`
- 发往某节点：发布到 `{topic}/{to}`
- QoS 1，`retain = false`，payload 为帧的 UTF-8 字节
- 客户端 id 固定为 `awp-{nodeId}`，使用持久会话（clean session = false），节点离线期间 broker 会暂存消息
- 所有回复都作为新消息发布到对方收件箱（`{topic}/{from}`），没有同步回复；请求方用回复的 `re` 字段关联等待中的请求
- 建议使用 `mqtts://`（TLS）。自建 broker 使用自签证书时，实现方应支持配置自定义 CA 证书（DSH 实现里是 `mqtt.caFile` / `mqtt.caPem`），不要为此关闭证书校验

## 8. 安全要求

- **执行权限**：执行方没有人值守，AWP/1 规定执行方以完全权限运行任务：不限制文件访问，不弹审批（DSH 为 `danger-full-access`，Claude Code、Codex 使用各自的等价模式）。这意味着能通过校验的 `task` 就能在执行方机器上做任何事，下面几条是唯一的防线。
- 监听非回环地址的 HTTP 节点，以及所有 MQTT 节点，必须配置共享密钥并验证签名。MQTT broker 上的其他客户端能看到主题，签名是防止伪造任务的唯一手段。
- 执行方只接受允许列表里的 `from`。
- 签名只防伪造和篡改，不加密。传输敏感内容时使用 HTTPS 或 `mqtts://`，并尽量把节点放在受信任的内网或 VPN 里。
- 共享密钥要足够长（建议至少 32 个随机字符），不同信任域使用不同密钥。

## 9. 示例

委派方 `node-a` 把任务交给 `node-b`（为便于阅读，示例中签名已省略，JSON 已折行）：

```
→ AWP/1 3b9f…
  {"id":"m1","type":"task","from":"node-a","to":"node-b","ts":1763196000000,
   "task":"t1","body":{"title":"修复单测","prompt":"运行 npm test 并修复失败的用例","timeout":1800}}

← AWP/1 a07c…
  {"id":"m2","type":"status","from":"node-b","to":"node-a","ts":1763196000120,
   "task":"t1","re":"m1","body":{"state":"running"}}

  （若干分钟后）

← AWP/1 51de…
  {"id":"m3","type":"result","from":"node-b","to":"node-a","ts":1763196420000,
   "task":"t1","body":{"state":"done","text":"已修复 2 个用例，npm test 全部通过。改动：src/date.ts …","elapsed":419880}}
```

委派方没收到 `m3` 时：

```
→ {"id":"m4","type":"query","from":"node-a","to":"node-b","ts":…,"task":"t1"}
← {"id":"m5","type":"result","from":"node-b","to":"node-a","ts":…,"task":"t1","re":"m4","body":{"state":"done","text":"…"}}
```

## 10. 签名参考实现（Node.js）

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

export function encode(envelope, secret) {
  const json = JSON.stringify(envelope)
  const sig = secret ? createHmac('sha256', secret).update(json, 'utf8').digest('hex') : '-'
  return `AWP/1 ${sig}\n${json}`
}

export function decode(frame, secret) {
  const nl = frame.indexOf('\n')
  const [magic, sig] = frame.slice(0, nl).split(' ')
  const json = frame.slice(nl + 1)
  if (magic !== 'AWP/1' || !sig) throw Object.assign(new Error('bad frame'), { code: 'bad_frame' })
  if (secret) {
    const want = createHmac('sha256', secret).update(json, 'utf8').digest()
    const got = Buffer.from(sig, 'hex')
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      throw Object.assign(new Error('bad signature'), { code: 'bad_sig' })
    }
  }
  return JSON.parse(json)
}
```
