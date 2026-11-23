# dsh-workbuddy-gateway

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-2f6df6)](https://github.com/deepseek-ai/deepseek-harness)
[![Requires dsh-connect-workbuddy](https://img.shields.io/badge/requires-dsh--connect--workbuddy-25c6a4)](https://github.com/dingminhua/dsh-connect-workbuddy)

把 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) 提供的
WorkBuddy 模型（国内版 + 国际版）开放成一个**本机可调用的 HTTP API**，四种最常用的
协议共用一个 base URL。

**每把 API key 勾选自己要对外提供的模型**，重名自动加账号后缀；推理档位由客户端自己
选。全部在 DSH 的 **设置 → WorkBuddy 模型网关** 里点选管理。

```
你的应用（Codex / Claude Code / Cline / 任意 SDK）
        │  OpenAI Chat · OpenAI Responses · Anthropic Messages · Gemini
        ▼
  dsh-workbuddy-gateway        ← 本插件：协议转换 + 按 key 的模型清单
        │
        ▼
  dsh-connect-workbuddy        ← 负责登录、凭据、换号、渠道指纹、积分
        │
        ▼
  WorkBuddy 上游网关
```

---

## 快速开始

### 1. 先装模型来源

本插件**不登录 WorkBuddy**，全部上游能力来自
[`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)：

```bash
dsh plugin install dsh-connect-workbuddy
```

装好后在 **设置 → dsh-connect-workbuddy** 里确认已登录至少一个账号。

### 2. 装本插件

在 DSH 的 **Plugins → Add plugin** 输入框里填以下任一形式即可安装
（插件管理器的 `inspect` 支持注册表包名、Git 地址、tarball 与本地目录）：

**A. 从 Git 仓库（当前可用，推荐）**

```
https://github.com/Roozenlz/dsh-workbuddy-gateway
```

**B. 从本地目录**

```bash
git clone https://github.com/Roozenlz/dsh-workbuddy-gateway
# 然后在 Add plugin 里填这个目录的绝对路径
```

**C. 从 npm**

```
dsh-workbuddy-gateway
```

> ⚠️ **当前尚未在 npm 上可用。** 本包曾以 `2.1.0` 发布，为把首次公开版本对齐到
> `1.0.0` 而整包删除；npm 对整包删除有 24 小时重发冷却，之后会以 `1.0.0` 发布。
> 在此之前请用 A 或 B。

**D. 从插件市场**

DSH 的 **Plugins → Discover** 只显示已配置索引源里的条目。本插件尚未出现在任何
公共索引中；要让它出现在「Discover」里，需要有人维护索引并把本插件列进去。

### 3. 拿到地址与 key

1. 打开 **设置 → WorkBuddy 模型网关**
2. 页面顶部按协议分行给出 **Base URL**，点复制
3. 在 **API keys** 里选一把（首次启动已自动建好 `default` 并勾上全部模型），
   点 **显示明文** 拿到 secret

```bash
curl http://127.0.0.1:9055/v1/chat/completions \
  -H "Authorization: Bearer wbg-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"<从 /v1/models 里选>","messages":[{"role":"user","content":"你好"}]}'
```

---

## Base URL

**就是 DSH 自己的地址，没有自定义路径前缀。**

| 协议 | Base URL | 客户端示例 |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:9055/v1` | Codex、Cline、任意 OpenAI SDK |
| OpenAI Responses | `http://127.0.0.1:9055/v1` | Codex（`wire_api = "responses"`） |
| Anthropic Messages | `http://127.0.0.1:9055` | Claude Code（`ANTHROPIC_BASE_URL`） |
| Gemini | `http://127.0.0.1:9055` | Google GenAI SDK |

为什么 Anthropic 和 Gemini 给根而不给 `/v1`：它们的 SDK 会自己拼
`/v1/messages`、`/v1beta/models/...`，给了 `/v1` 就拼成 `/v1/v1/messages`。

> 旧版本用的 `/workbuddy-gateway` 前缀**仍然可用**（作为别名保留），已经填过的客户端
> 不会失效。

根路径是逐条精确注册的，不会碰 DSH 自己的 `/api`、`/plugins` 与前端资源。

---

## 四种协议

| 协议 | 路径 | 流式 |
|---|---|---|
| OpenAI Chat Completions | `POST /v1/chat/completions` | SSE，`data: [DONE]` 结尾 |
| OpenAI Responses | `POST /v1/responses` | 命名事件（`response.*`，带 `sequence_number`） |
| Anthropic Messages | `POST /v1/messages` | SSE（`message_start` … `message_stop`） |
| Gemini | `POST /v1beta/models/{model}:generateContent`<br>`:streamGenerateContent` | SSE，每事件一整条响应 |

配套只读路由：

| 路由 | 说明 |
|---|---|
| `GET /v1/models` | **这把 key 勾选的**模型（OpenAI 形状） |
| `GET /v1beta/models` | 同上（Gemini 形状） |
| `GET /v1/accounts` | 本机 WorkBuddy 账号（只有 id 与名称，无 token） |
| `GET /healthz` | 存活信息与这把 key 当前提供的模型名 |

`/v1/models` 带上 `anthropic-version` 请求头时返回 Anthropic 形状
（`{data:[{type,id,display_name}]}`），因为 Anthropic SDK 读那一种。

---

## 鉴权

四个位置都接受（各 SDK 各用一种）：

```
Authorization: Bearer wbg-...
x-api-key: wbg-...
x-goog-api-key: wbg-...
?key=wbg-...
```

**没有「关闭鉴权」开关。** 网关监听 DSH 的 loopback 端口，而 DSH 可以
`--trusted-host` 暴露到局域网；少一个开关就少一个「忘了开」的洞。不想要某把 key
了就停用或删除它。

---

## API key 与模型清单

**没有「路由策略模式」。** 每把 key 做的就是一份勾选清单：哪些 `(账号, 模型)` 组合
要对外提供。`/v1/models` 原样返回这份清单，请求里的 `model` 按名字查表得到「用哪个
账号跑哪个模型」。

选哪个模型是**调用方**的事，插件只负责照单发货。

### 勾选界面

在 **设置 → WorkBuddy 模型网关** 里点开某把 key 的「对外提供的模型」，按账号分组勾选：

- **默认账号**按区域分成两组（国内版 / 国际版），跟随插件自己的账号选择与账号池
- **具体账号**各自一组，适合「这个模型只用那个号的额度」这类需求

### 重名怎么办

两个账号下都有 `deepseek-v4.1-flash` 时，两行同名客户端无法区分。重名的项会在名字
末尾挂后缀：

```
hy4flash-free@cn        ← 默认账号（国内版）
hy4flash-free@intl     ← 默认账号（国际版）
hy4flash-free@pony     ← 具体账号，昵称是纯 ASCII 就用昵称
hy4flash-free@#9       ← 昵称含中文/emoji，退化成序号
```

- **默认账号**没有昵称，用区域区分（`cn` / `intl`）
- **具名账号**优先用昵称，但要求纯 `[A-Za-z0-9._-]` 且不超过 24 字符
- 单条不重名时保持裸名，不加多余尾巴

**后缀必须是 ASCII**：模型名会被塞进请求体、配置文件、甚至 shell 命令行，把
`ฅ՞•ﻌ•՞ฅ` 这种字符放进去，总有一环会炸。

名字是稳定的：同样的勾选永远得到同样的名字，客户端缓存不会因刷新而失效。

### 账号不可用会同步

**勾选列表与上游同步。** 上游插件把「这个账号现在能不能用」记在
`$DSH_HOME/.workbuddy-pool.<region>.json` 里。每次打开设置页（以及之后每 30 秒）都会
重读这份状态：

| 情况 | 处理 |
|---|---|
| 限流中、账号被限制 | **从可勾选列表移除** |
| 冷却已过（`retryAtMs` 已过期） | 视为可用，**自动回到列表** |
| 上游又写回失败 | 立刻再变不可用 |

不可用的账号仍列在账号表里（带原因与恢复时间），不会凭空消失。已经勾了它的 key
会得到一条提示「请求会失败，账号恢复后自动生效」——不替你删勾选，因为那可能只是
暂时不可用。

### 推理档由客户端决定

插件**不替客户端选档位**。`/v1/models` 只声明「这个模型支持哪几档」：

```json
{ "id": "deepseek-v4.1-flash", "reasoning": true,
  "reasoning_efforts": ["low", "high", "max"] }
```

客户端发来的 `reasoning_effort` 原样透传给上游。上游没声明档位时给空数组，
客户端就不会显示一个假的选择器。

### 请求里的 model

必填（清单多于一项时）。它必须是 `/v1/models` 返回的 `id` 之一 —— 也就是可能带
`@pony` 这类后缀的那个名字。插件也宽松接受裸模型 id，但仅当清单里恰好只有一项用
这个 id（否则无法判断用户指的是哪个账号）。

写了清单外的名字会返回 404，并在错误信息里列出这把 key 能选什么。

---

## 模型条目的字段

客户端「获取模型列表」不只是拿 id：它要上下文窗口、输出上限、模态来填自己的表单。
所以每条都**永远给出数值**（上游没报就用保守默认值并标记）：

| 字段 | 说明 |
|---|---|
| `id` | 客户端填进请求 `model` 的那个名字（含重名后缀） |
| `display_name` / `name` | 菜单显示名 |
| `model` | 上游真实模型 id（重名时与 `id` 不同） |
| `context_window` 等 | 上下文上限，同时给出 `contextWindow` / `context_length` / `context_tokens` / `max_context_tokens` / `max_input_tokens` / `limit.context` |
| `max_output_tokens` 等 | 输出上限，同时给出 `maxTokens` / `max_completion_tokens` / `limit.output` |
| `input_modalities` | `["text"]` 或 `["text","image"]` |
| `supports_vision` | 是否接受图片 |
| `reasoning_efforts` | 可用推理档列表 |

缺失时用 `128000`（上下文）/ `8192`（输出），并带 `*_defaulted: true` 说明是估的。
与 [cc-switch](https://github.com/farion1231/cc-switch) 的「模型映射」表字段对齐，
所以它的「获取模型列表」能直接读到这些值。

---

## 设置页能做什么

**设置 → WorkBuddy 模型网关**：

- 四种协议各自的 **Base URL**（一键复制）
- **新建 / 显示明文 / 重置 / 删除** key
- 每把 key：名称、启停，以及**按账号分组的模型勾选**（带搜索、全选、清空）
- 直接列出「客户端会看到的名字」，重名后缀一目了然
- 账号不可用时给出警告条与恢复时间
- 底部一条 `curl` 示例

配置文件：

```
$DSH_HOME/workbuddy-gateway/keys.json      # 权限 600
```

只存本插件自己的 key 与勾选清单，**不含任何 WorkBuddy 凭据**。

---

## 与 dsh-connect-workbuddy 的关系

> **本插件不登录 WorkBuddy，也不持有任何 WorkBuddy 凭据。**

它是 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)
（作者 [@dingminhua](https://github.com/dingminhua)，MIT）的**协议转换层**：

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

### 两条通道

**宿主通道（勾选里账号为空的那条）**：请求翻译成 DSH 的 `GenerateOptions`，交给
`dsh-connect-workbuddy` 注册的 adapter。换号、渠道指纹救助、context rescue、积分统计
全部免费继承。

**直连通道（勾选了具体账号的那条）**：复用插件导出的 `WorkBuddyCredentialStore` /
`WorkBuddyUpstreamClient` / `createWorkBuddyShim` 组装一套只属于网关的 loopback shim，
再点名账号。上游协议一行没重写，只由网关决定「谁付这次请求」。

---

## 友链

- **[dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy)** —
  WorkBuddy 接入 DeepSeek Harness 的完整方案。本插件全部上游能力都来自它。
- **[cc-switch](https://github.com/farion1231/cc-switch)** — 跨平台 AI CLI 配置管理器。
  本插件的模型列表字段与它的「模型映射」表对齐。
- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — 本插件运行其上的宿主。
- 上游协议文档：[OpenAI Chat](https://platform.openai.com/docs/api-reference/chat) ·
  [OpenAI Responses](https://platform.openai.com/docs/api-reference/responses) ·
  [Anthropic Messages](https://docs.anthropic.com/en/api/messages) ·
  [Gemini generateContent](https://ai.google.dev/api/generate-content)

---

## 已知边界

- `count_tokens` 返回 `0`：WorkBuddy 上游没有该端点，本地估算没有意义。
- **模型名不承载配置。** 名字里唯一可能出现的附加信息是重名后缀（`@pony`），它纯粹
  是给客户端区分用的显示名，解析时会被剥掉。
- 图片只接受 data URL / base64。网关在 loopback 上，代抓远端 URL 等于开一个无鉴权的
  SSRF 出口。
- Responses 的 `previous_response_id` / `store` 未实现：网关无状态，历史由调用方每次带全。
- Gemini 流式的思考增量与正文合并输出：Gemini 的流式思考协议不是一个事件一个 `thought` 标记。
- 账号可用性来自上游的池状态文件。「冷却已过」只说明冷却期结束，不代表上游一定接受
  这个账号；真实可用性由下一次请求决定。

---

## 开发

```bash
# 离线自测：假 ctx（假 webServer / llm / attachments），不花钱、不需要真实凭据
node tests/harness.mjs
```

覆盖 165 项：首次建 key 与惰性补选、鉴权、模型勾选与清单投影、重名后缀（区域 / 昵称 /
非 ASCII 序号）、跨区同名、按名字路由、推理档透传、并行工具调用按 index 分组、
Responses 流的规范校验（`sequence_number`、part 一致性、terminal 的 output 顺序）、
上游失败与断流的诚实报告、账号可用性与恢复、四种协议的流式与非流式、工具调用三方言、
图片输入。

`tests/responses-spec.mjs` 是独立写的 OpenAI Responses 流校验器，对着故意做坏的流
验证过它确实会报错。

---

## 发布

本包**零依赖、零构建**：源码就是发布物，不需要打包步骤。发布分两种方式。

### 方式一：GitHub Actions 自动发布（推荐，无 token）

推一个与 `package.json` 版本号一致的 tag：

```bash
# package.json 里是 1.0.0 就推 v1.0.0
git tag v1.0.0
git push origin v1.0.0
```

`.github/workflows/publish.yml` 会校验 tag 与版本一致、跑一遍自测，然后发布。

**凭据走 OIDC，仓库里不存任何 npm token。** 这需要先在 npm 上配对一次：

> `https://www.npmjs.com/package/<包名>/access` → Trusted Publisher → GitHub Actions
>
> | 字段 | 值 |
> |---|---|
> | Organization | `Roozenlz` |
> | Repository | `dsh-workbuddy-gateway` |
> | Workflow name | `publish.yml` |
> | Environment | 留空 |
>
> 勾选 `npm publish` 权限。配好后状态是 **Pending validation**，需要发布一次才算生效。

为什么不用 token：npm 已宣布「绕过 2FA 的 token」将在 2027 年 1 月起不能用于发布，
而且长期 token 一旦泄漏就等于交出发布权。

### 方式二：本地手动发布

```bash
npm publish --registry=https://registry.npmjs.org/ --access public
```

需要先 `npm login`，或在本机准备好带 publish 权限的凭据。`package.json` 里的
`publishConfig.registry` 已指向官方源——本机默认源常被设成镜像（如 npmmirror），
镜像只读、不接受 publish。

### 发布前检查

```bash
node tests/harness.mjs      # 全绿再发
npm pack --dry-run          # 看清会打包哪些文件
```

### npm 的两条硬限制

这两条都实际踩过，发布流程设计时绕不开：

1. **新包首次发布要过审核。** npm 会先放一个 `0.0.0-stage` 占位版本，真实版本
   「awaiting a staged release」。审核通过前 `npm i <包名>` 装到的是占位符。
2. **整包删除后有 24 小时冷却。** 删掉整个包之后，同名包 24 小时内不能重新发布：

   ```
   403 dsh-workbuddy-gateway cannot be republished until 24 hours have passed
   ```

   只删单个版本时，该版本号也会在 24 小时内不可重用。

另外，**绕过 2FA 的 granular token 只能发布**，不能 unpublish、改包权限或配置
trusted publisher——这类「账号变更」操作必须在 npm 网页上完成并验证安全密钥。


## License

[MIT](LICENSE)
