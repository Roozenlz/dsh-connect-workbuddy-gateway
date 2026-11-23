# dsh-workbuddy-gateway

把 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 提供的
WorkBuddy 模型（国内版 + 国际版）开放成一个本机可调用的 HTTP API，四种最常用的协议
共用一个 `base_url`。

**路由策略挂在 API key 上，不写在模型名里。** 每把 key 自带一套策略（跟随 DSH 默认
模型 / 跟随活跃会话 / 固定模型 / 固定账号 / 目录第一个），全部在
**设置 → WorkBuddy 模型网关**里点选管理。

---

## 与 dsh-connect-workbuddy 的关系

> **这个插件本身不登录 WorkBuddy，也不持有任何 WorkBuddy 凭据。**

它是 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)
（作者 [@dingminhua](https://github.com/dingminhua)，MIT）的**协议转换层**：

```
你的应用（Codex / Cline / 任意 SDK）
        │  OpenAI Chat / OpenAI Responses / Anthropic / Gemini
        ▼
  dsh-workbuddy-gateway        ← 本插件：协议转换 + 按 key 路由
        │  宿主 llm 服务 / 复用插件的请求栈
        ▼
  dsh-connect-workbuddy        ← 负责登录、凭据、换号、渠道指纹、积分
        │
        ▼
  WorkBuddy 上游网关（copilot.tencent.com / workbuddy.ai / codebuddy.ai）
```

分工说明：

| 能力 | 由谁负责 |
|---|---|
| WorkBuddy 登录、OAuth、加密凭据解密 | `dsh-connect-workbuddy` |
| 账号池、自动换号、冷却与可用性探测 | `dsh-connect-workbuddy` |
| 上游渠道指纹、`11128` 救助、错误分类 | `dsh-connect-workbuddy` |
| 模型目录与积分倍率、每日签到 | `dsh-connect-workbuddy` |
| 四种对外协议的请求/响应转换 | **本插件** |
| 按 API key 的路由策略与多 key 管理 | **本插件** |
| 设置界面、key 生成与轮换 | **本插件** |

没有 `dsh-connect-workbuddy` 时本插件装得上但**发不出请求**：它会明确报
`no workbuddy provider is registered`。

### 你需要的两个插件

```bash
# 1. 先装模型来源（必需）
dsh plugin install dsh-connect-workbuddy

# 2. 再装网关门面（本插件）
dsh plugin install dsh-workbuddy-gateway
```

两者在 DSH 设置里各占一栏：`dsh-connect-workbuddy` 管账号与模型目录，
**WorkBuddy 模型网关**管对外的 key 与策略。

### 友链

- **dsh-connect-workbuddy** — <https://github.com/dingminhua/dsh-connect-workbuddy>
  WorkBuddy 接入 DeepSeek Harness 的完整方案。本插件全部上游能力都来自它。
- **DeepSeek Harness** — <https://github.com/deepseek-ai/deepseek-harness>
  本插件运行其上的宿主。
- 上游协议的官方文档：[OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat) ·
  [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses) ·
  [Anthropic Messages](https://docs.anthropic.com/en/api/messages) ·
  [Gemini generateContent](https://ai.google.dev/api/generate-content)

---

## 安装后的三步

1. 打开 **设置 → WorkBuddy 模型网关**。
2. 页面顶部就是 **Base URL**，例如 `http://127.0.0.1:9055/workbuddy-gateway`。
3. 在 **API keys** 里选一把 key（首次启动自动建了一把 `default`），点 **显示** 拿到
   它的 secret，填进你的客户端。

请求体里的 `model` 可以完全不写 —— 用这把 key 的策略。

---

## 四种协议

| 协议 | 路径 | 流式 |
|---|---|---|
| OpenAI Chat Completions | `POST {base}/v1/chat/completions` | SSE，`data: [DONE]` 结尾 |
| OpenAI Responses | `POST {base}/v1/responses` | 命名事件（`response.*`） |
| Anthropic Messages | `POST {base}/v1/messages` | SSE（`message_start` … `message_stop`） |
| Gemini | `POST {base}/v1beta/models/{model}:generateContent` / `:streamGenerateContent` | SSE，每事件一整条响应 |

Gemini 的模型名可以写 `-`（如 `models/-:generateContent`）表示「用 key 的策略」。

配套只读路由：

- `GET {base}/v1/models` —— OpenAI 形状的模型目录
- `GET {base}/v1beta/models` —— Gemini 形状的模型目录
- `GET {base}/v1/accounts` —— 本机各区域的 WorkBuddy 账号（只有 id 与名称）
- `GET {base}/healthz` —— 存活信息与**当前这把 key 的策略**

---

## API key 与路由策略

每把 key 是独立的：独立的 secret、独立的策略、独立的启停。因此「给 Codex 一把固定
用 `glm-5.3` 的 key，给另一个脚本一把固定用国际版账号的 key」是可以的，两者互不影响，
也不需要在模型名里写任何前缀。

### 六种策略

| 策略 | 含义 |
|---|---|
| `dsh` | 跟随 **DSH 新会话的默认模型**（`agentDefaultModel`） |
| `session` | 跟随 **最近活跃会话**正在用的模型 |
| `current` | 先看活跃会话，再看 DSH 默认 —— 「此刻在用的那个」 |
| `named` | **固定某个 provider + 模型**，这把 key 专属 |
| `account` | **固定某个账号**（可再固定模型），走直连通道 |
| `first` | 目录里第一个模型 |

四种「跟随」型策略在读不到来源时（例如没有活跃会话）会退到 DSH 默认选择，再退到
目录第一个 —— 不会因为「此刻没有会话」就报错。

`named` / `account` 没选模型时**能保存但不可用**，请求会返回 `409 model_not_configured`
并说明去哪儿配。这是刻意的：让它存得下去，用户才不必一次填完。

### 请求显式写 model 时

请求体里的 `model` **优先于** key 的策略。这是客户端 SDK 的硬要求（它们总会带一个
model 字段），无法禁止，所以设计上承认它：写 `model` ＝ 「这次就用这个」，不写 ＝
「用这把 key 的策略」。策略负责的是**默认值**，不是禁止覆盖。

### 推理强度

每把 key 可以单独钉一个 `reasoningEffort`（`off` / `minimal` / `low` / `medium` /
`high` / `xhigh` / `max`），留空表示用模型自己的默认档。

### 鉴权

四个位置都接受（各 SDK 各用一种）：

```
Authorization: Bearer wbg-...
x-api-key: wbg-...
x-goog-api-key: wbg-...
?key=wbg-...
```

**没有「关闭鉴权」开关。** 网关监听的是 DSH 的 loopback 端口，而 DSH 可以
`--trusted-host` 暴露到局域网；少一个开关就少一个「忘了开」的洞。不想要某把 key 了
就停用或删除它。

---

## 设置页能做什么

**设置 → WorkBuddy 模型网关**：

- 看 Base URL 与配置文件路径（都能一键复制）
- **新建 key** —— 生成后弹一次明文，之后列表里只显示掩码
- **显示 / 重置** —— 显示明文；重置换新 secret 并让旧的立即失效
- **删除** —— 二次确认
- 每把 key：名称、启停、策略、区域、模型、账号、推理强度
- 页面底部给一条 `curl` 示例

配置文件在：

```
$DSH_HOME/workbuddy-gateway/keys.json      # 权限 600
```

它只存本插件自己的 key 与策略，**不含任何 WorkBuddy 凭据**。

---

## 工作原理

### 两条通道

**宿主通道（默认）**：请求翻译成 DSH 的 `GenerateOptions`，交给
`dsh-connect-workbuddy` 注册的 adapter。换号、渠道指纹救助、context rescue、积分统计
全部免费继承，WorkBuddy 凭据不出进程。

**直连通道（`account` 策略）**：复用插件导出的 `WorkBuddyCredentialStore` /
`WorkBuddyUpstreamClient` / `createWorkBuddyShim` 组装一套只属于网关的 loopback shim，
再点名账号。上游协议一行没重写，所以行为与插件本体一致；只有「谁付这次请求」由网关
决定。

直连通道按「裸名 → `$DSH_PROFILE_DIR/node_modules/...` → `$DSH_HOME/profiles/*`」找
插件入口 —— 因为本插件可能是工作区目录链接安装的，只试裸名会「看起来装了、实际调不了」。

### 账号名册为什么不走插件模块

`/v1/accounts` 与设置页的账号下拉直接读
`$DSH_HOME/workbuddy-vault/<region>/*.json`，只投影 `accountId`、昵称、区域与过期
时间。这条路径不依赖任何插件的运行时，所以即使 workbuddy 插件在本实例里加载不到，
名册照样答得出来 —— 这正是实测踩到的坑：那个包按 peer 依赖装配，从别的 ESM 图里
`import()` 它可能整包失败。

---

## 已知边界

- `count_tokens` 返回 `0`：WorkBuddy 上游没有该端点，本地估算没有意义。
- 模型名**不承载配置**。曾有一版把区域与账号编码进模型名（`cn/account=…/model`），
  已被本版移除：那是「用字符串当配置文件」，无法在界面上管理，也无法按 key 区分。
- 图片只接受 data URL / base64。网关在 loopback 上，代抓远端 URL 等于开一个无鉴权的
  SSRF 出口。
- Responses 的 `previous_response_id` / `store` 未实现：网关无状态，历史由调用方每次
  带全。
- Gemini 流式的思考增量与正文合并输出：Gemini 的流式思考协议不是一个事件一个
  `thought` 标记。

---

## 开发

```bash
# 离线自测：假 ctx（假 webServer / llm / attachments），不花钱、不需要真实凭据
node tests/harness.mjs
```

覆盖：首次建 key、四位置鉴权、六种策略、两把 key 各自路由、启停、轮换、删除、
四种协议的流式与非流式、工具调用三方言、图片输入、上游失败传播。

## License

MIT
