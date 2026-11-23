# dsh-workbuddy-gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6df6)](https://github.com/deepseek-ai/deepseek-harness)
[![Requires dsh-connect-workbuddy](https://img.shields.io/badge/requires-dsh--connect--workbuddy-25c6a4)](https://github.com/dingminhua/dsh-connect-workbuddy)

把 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 提供的
WorkBuddy 模型（国内版 + 国际版）开放成一个本机可调用的 HTTP API，四种最常用的协议
共用一个 `base_url`。

**每把 key 勾选自己要对外提供的模型。** 用户直接勾哪些 `(账号, 模型)` 组合，
`/v1/models` 就返回哪些；重名的模型名会自动挂账号后缀，推理档位由客户端自己选。
全部在 **设置 → WorkBuddy 模型网关** 里管理。

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
| 按 API key 的模型勾选与多 key 管理 | **本插件** |
| 设置界面、key 生成与轮换 | **本插件** |

没有 `dsh-connect-workbuddy` 时本插件装得上但**发不出请求**：它会明确报
`no workbuddy provider is registered`。

### 你需要的两个插件

```bash
# 1. 先装模型来源（必需）—— 本插件全部上游能力都来自它
dsh plugin install dsh-connect-workbuddy

# 2. 再装网关门面（本插件）
dsh plugin install dsh-workbuddy-gateway
```

或者从本仓库安装本地目录：把仓库 `git clone` 到任意位置，然后在 DSH 的
**Plugins → Add plugin** 里选那个目录。

两者在 DSH 设置里各占一栏：`dsh-connect-workbuddy` 管账号与模型目录，
**WorkBuddy 模型网关**管对外的 key 与勾选。

### 友链

- **dsh-connect-workbuddy** — <https://github.com/dingminhua/dsh-connect-workbuddy>
  WorkBuddy 接入 DeepSeek Harness 的完整方案。本插件全部上游能力都来自它。
- **cc-switch** — <https://github.com/farion1231/cc-switch>
  本插件的模型列表字段（菜单显示名 / 实际请求模型 / 上下文窗口 / 思考等级）与它
  的「模型映射」表对齐，因此可以直接在 cc-switch 里用它的「获取模型列表」。
- **DeepSeek Harness** — <https://github.com/deepseek-ai/deepseek-harness>
  本插件运行其上的宿主。
- 上游协议的官方文档：[OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat) ·
  [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses) ·
  [Anthropic Messages](https://docs.anthropic.com/en/api/messages) ·
  [Gemini generateContent](https://ai.google.dev/api/generate-content)

---

## 安装后的三步

1. 打开 **设置 → WorkBuddy 模型网关**。
2. 复制你要用的那个协议的 **Base URL**（页面顶部按协议分行给出成品地址）。
3. 在 **API keys** 里选一把 key（首次启动自动建一把 `default`，并已勾上全部模型），
   点 **显示明文** 拿到 secret，填进客户端。

请求体里的 `model` 要写 `/v1/models` 返回的 `id`（清单只有一项时可以省略）。

### Base URL 就是 DSH 自己的地址

```
OpenAI Chat / Responses   http://127.0.0.1:9055/v1
Anthropic                 http://127.0.0.1:9055
Gemini                    http://127.0.0.1:9055
```

**没有 `/workbuddy-gateway` 这种自定义前缀。** 协议端点直接挂在根路径的
`/v1/...` 上，那是所有客户端默认期待的形状；有些客户端根本不接受带路径的
base URL。旧前缀仍可用（作为别名保留），已经填过它的客户端不会失效。

根路径是逐条精确注册的，不会碰到 DSH 自己的 `/api`、`/plugins` 与前端资源。

---

## 四种协议

| 协议 | 路径 | 流式 |
|---|---|---|
| OpenAI Chat Completions | `POST {base}/v1/chat/completions` | SSE，`data: [DONE]` 结尾 |
| OpenAI Responses | `POST {base}/v1/responses` | 命名事件（`response.*`） |
| Anthropic Messages | `POST {base}/v1/messages` | SSE（`message_start` … `message_stop`） |
| Gemini | `POST {base}/v1beta/models/{model}:generateContent` / `:streamGenerateContent` | SSE，每事件一整条响应 |

Gemini 的模型名写 `-`（如 `models/-:generateContent`）表示「用清单里唯一那一项」。

配套只读路由：

- `GET {base}/v1/models` —— 这把 key 勾选的模型（OpenAI 形状）
- `GET {base}/v1beta/models` —— 同上（Gemini 形状）
- `GET {base}/v1/accounts` —— 本机各区域的 WorkBuddy 账号（只有 id 与名称）
- `GET {base}/healthz` —— 存活信息与**这把 key 当前对外提供的模型名**

把 `anthropic-version` 请求头带上时，`/v1/models` 会改回 Anthropic 的形状
（`{data:[{type,id,display_name}]}`），因为 Anthropic SDK 读的是那一种。

---

## API key 与模型勾选

**没有「策略模式」。** 每把 key 做的就是一份勾选清单：哪些 `(账号, 模型)` 组合要对
外提供。`/v1/models` 原样返回这份清单，请求里的 `model` 按名字查表得到「用哪个账号
跑哪个模型」。

选哪个模型是**调用方**的事，插件只负责照单发货。

### 勾选哪些

在 **设置 → WorkBuddy 模型网关** 里点开某把 key 的「对外提供的模型」，按账号分组勾选。

分组规则：

- **默认账号**按区域拆成两组（国内版 / 国际版），跟随插件自己的账号选择与账号池
- **具体账号**各自一组，适合「这个模型只用那个号的额度」这类需求

### 账号不可用时会自动消失

**勾选列表与上游同步。** 上游插件把「这个账号现在能不能用」记在
`$DSH_HOME/.workbuddy-pool.<region>.json` 里（`outcome` 与 `retryAtMs`）。每次打开
设置页都会重读这份状态：

- 被判为不可用（限流中、账号被限制）的账号**从可勾选列表移除**
- 冷却已过的失败**不算不可用** —— 那只是历史，账号现在可以再试
- 不可用的账号仍列在账号表里（带原因与恢复时间），不会凭空消失

### 重名怎么办

两个账号下都有 `deepseek-v4.1-flash` 时，两行同名客户端无法区分。所以重名的项会在
名字末尾挂账号后缀：

```
deepseek-v4.1-flash            ← 默认账号那条（总是保留裸名）
deepseek-v4.1-flash@pony       ← 账号昵称是纯 ASCII，直接用
deepseek-v4.1-flash@#9         ← 昵称含中文/emoji，退化成序号
```

**后缀必须是 ASCII。** 本机就有一个昵称是 `ฅ՞•ﻌ•՞ฅ` 的账号：把这种字符放进模型名，
它会被塞进请求体、配置文件、甚至 shell 命令行，总有一环会炸。所以纯
`[A-Za-z0-9._-]` 且不超过 24 字符的昵称才用，其余一律用序号。

名字是稳定的：同样的勾选永远得到同样的名字，客户端缓存不会因刷新而失效。

### 推理强度由客户端决定

插件**不替客户端选档位**。`/v1/models` 只声明「这个模型支持哪几档」：

```json
{ "id": "deepseek-v4.1-flash", "reasoning": true,
  "reasoning_efforts": ["low", "high", "max"] }
```

客户端发来的 `reasoning_effort` 原样透传给上游。上游没声明档位时给空数组，
客户端就不会显示一个假的选择器。

### 请求里的 model

必填（清单多于一项时）。它必须是 `/v1/models` 返回的 `id` 之一 —— 也就是可能带
`@pony` 这类后缀的那个名字。插件也会宽松地接受裸模型 id，但仅当清单里恰好只有一项
用这个 id（否则无法判断用户指的是哪个账号）。

写了清单外的名字会返回 404，并在错误信息里列出这把 key 能选什么。

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

- 看四种协议各自的 **Base URL** 与配置文件路径（都能一键复制）
- **新建 key** —— 生成后弹一次明文，之后列表里只显示掩码
- **显示明文 / 重置** —— 显示明文；重置换新 secret 并让旧的立即失效
- **删除** —— 二次确认
- 每把 key：名称、启停，以及**按账号分组的模型勾选**（带搜索、全选、清空）
- 每把 key 上直接列出「客户端会看到的名字」，重名后缀一目了然，不用自己推算
- 页面底部给一条 `curl` 示例

配置文件在：

```
$DSH_HOME/workbuddy-gateway/keys.json      # 权限 600
```

它只存本插件自己的 key 与勾选清单，**不含任何 WorkBuddy 凭据**。

---

## 工作原理

### 两条通道

**宿主通道（勾选里账号为空的那条）**：请求翻译成 DSH 的 `GenerateOptions`，交给
`dsh-connect-workbuddy` 注册的 adapter。换号、渠道指纹救助、context rescue、积分统计
全部免费继承，WorkBuddy 凭据不出进程。

**直连通道（勾选了具体账号的那条）**：复用插件导出的 `WorkBuddyCredentialStore` /
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
  已被移除；现在名字里唯一可能出现的附加信息是**重名后缀**（`@pony`），它纯粹是给
  客户端区分用的显示名，解析时会被剥掉。
- 图片只接受 data URL / base64。网关在 loopback 上，代抓远端 URL 等于开一个无鉴权的
  SSRF 出口。
- Responses 的 `previous_response_id` / `store` 未实现：网关无状态，历史由调用方每次
  带全。
- Gemini 流式的思考增量与正文合并输出：Gemini 的流式思考协议不是一个事件一个
  `thought` 标记。
- 「默认账号」那条（勾选里账号为空）的模型走宿主通道，账号由插件的选择/账号池决定；
  想在网关这一侧固定账号，就要勾选具体账号那一条。

---

## 开发

```bash
# 离线自测：假 ctx（假 webServer / llm / attachments），不花钱、不需要真实凭据
node tests/harness.mjs
```

覆盖：首次建 key 与惰性补选、四位置鉴权、模型勾选与清单投影、重名后缀（英文昵称 /
非 ASCII 序号）、按名字路由、推理档透传、Responses 的 usage 形状、两把 key 各自
清单、启停、轮换、删除、四种协议的流式与非流式、工具调用三方言、图片输入、上游
失败传播。

## License

MIT
