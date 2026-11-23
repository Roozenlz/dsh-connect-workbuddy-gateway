/**
 * 本地端到端自测：用假 ctx 把网关的两类路由都跑一遍。
 *
 *   - 对外 API：四种协议的入站解析与出站序列化，以及「模型清单来自 key 的勾选」；
 *   - 管理接口：key 的增删改、勾选清单、显示/重置、重名后缀。
 *
 * 不需要真实凭据，不花钱：`node tests/harness.mjs`
 */

import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 必须在 import 插件之前设好，配置路径在模块加载时读取 $DSH_HOME。 */
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'wbg-test-'))

const { apply } = await import('../index.js')

/* ── 假宿主 ───────────────────────────────────────────────────────────── */

const PLAIN = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: '想一想…' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '想一想…' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '你好' },
  { type: 'text-delta', index: 1, text: '，世界' },
  { type: 'block-end', index: 1, block: { type: 'text', text: '你好，世界' } },
  { type: 'usage', usage: { inputTokens: 11, outputTokens: 7 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

const TOOLS = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '查一下' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '查一下' } },
  { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: '{"city"' },
  { type: 'tool-call-delta', index: 1, id: 'call_abc', name: 'get_weather', argumentsDelta: ':"北京"}' },
  { type: 'usage', usage: { inputTokens: 20, outputTokens: 9 } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

const lastCall = { options: undefined }
let nextChunks = PLAIN
let failNext

const CATALOG = {
  workbuddy: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'space-bunny', name: 'Space Bunny' }],
  'workbuddy-global': [{ id: 'hy4-preview', name: 'HY4 Preview' }, { id: 'kimi-k3', name: 'Kimi K3' }],
}

const llm = {
  listProviders: () => [{ id: 'workbuddy', name: 'WorkBuddy' }, { id: 'workbuddy-global', name: 'WorkBuddy International' }],
  async listModels(provider) {
    return CATALOG[provider] ?? []
  },
  async resolveModelInfo(provider, model) {
    const found = (CATALOG[provider] ?? []).find((entry) => entry.id === model)
    if (found === undefined) throw new Error(`unknown model ${model}`)
    return {
      provider,
      id: model,
      name: found.name,
      context: { contextWindow: 200000 },
      defaultMaxTokens: 8192,
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    }
  },
  stream(options) {
    lastCall.options = options
    const failure = failNext
    if (failure !== undefined) {
      failNext = undefined
      return (async function* () {
        yield { type: 'finish', reason: { kind: 'error', failure } }
      })()
    }
    const chunks = nextChunks
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  },
}

const attachments = {
  async saveImage({ data, mediaType }) {
    return { attachmentId: `att-${data.length}-${mediaType}`, mediaType, bytes: data.length, width: 4, height: 4 }
  },
}

/* 假账号表：一个纯英文名（可直接当后缀），一个中文+emoji 名（只能用序号）。 */
const FAKE_VAULT = {
  cn: [
    { id: 'acct_pony', name: 'pony', region: 'cn' },
    { id: 'acct_cat', name: 'ฅ՞•ﻌ•՞ฅ', region: 'cn' },
  ],
  global: [
    { id: 'acct_roozen', name: 'roozen', region: 'global' },
  ],
}

const services = new Map([
  ['llm', llm],
  ['attachments', attachments],
  ['agentDefaultModel', { currentSelection: () => ({ provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'high' }) }],
  ['agents', { list: () => [] }],
])

let origin = ''
let currentServer
const disposers = []
const ctx = {
  /* 启动期日志打到 stdout，方便定位「种子为什么没落盘」。 */
  logger: {
    info: (message) => { if (process.env.WBG_VERBOSE === '1') console.log(`    [info] ${message}`) },
    warn: (message) => console.log(`    [warn] ${message}`),
    error: () => {},
  },
  effect(factory) {
    const dispose = factory()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get(name) { return services.get(name) },
  webServer: {
    getOrigin: () => origin,
    register(route) {
      currentServer.on('request', (req, res) => {
        if (!req.url.startsWith(route.path)) return
        route.handler(req, res)
      })
      return () => {}
    },
  },
}

currentServer = createServer(() => {})
await new Promise((resolve) => currentServer.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${currentServer.address().port}`

/* 账号表来自真实 vault 目录；测试里伪造两份，避免依赖本机登录状态。 */
const { stubAccounts } = await import('./stub-accounts.mjs')
stubAccounts(FAKE_VAULT)

apply(ctx, {})

/* ── 断言工具 ─────────────────────────────────────────────────────────── */

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/* `ORIGIN` 是根（协议的默认形状）；`API` 是旧前缀别名，用于验证兼容性。 */
const ORIGIN = origin
const API = `${origin}/workbuddy-gateway`
const ADMIN = `${origin}/plugins/dsh-connect-workbuddy-gateway`

async function adminGet(path) {
  const response = await fetch(`${ADMIN}${path}`)
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function adminPost(path, payload) {
  const response = await fetch(`${ADMIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

async function keyPost(path, secret, payload) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  })
}

/* ── 用例 ─────────────────────────────────────────────────────────────── */

console.log('\n== 首次启动建 key（异步勾齐全量模型）==')
let firstKey
let firstId
{
  /*
   * `apply` 是同步的，而 provider 注册是异步的，所以首次勾选是异步补上的。
   * 等它落盘再断言 —— 这里最多等 ~4 秒。
   */
  let state
  for (let attempt = 0; attempt < 24; attempt += 1) {
    state = await adminGet('/state')
    if ((state.body.keys?.[0]?.selections ?? []).length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  check('200', state.status === 200, String(state.status))
  check('一把默认 key', state.body.keys?.length === 1, JSON.stringify(state.body.keys?.length))
  check('异步勾上了模型', state.body.keys[0].selections.length > 0, String(state.body.keys[0].selections.length))
  check('可用模型表非空', state.body.available.length > 0, String(state.body.available?.length))
  check('账号表带 safeSuffix', state.body.accounts.every((account) => 'safeSuffix' in account), JSON.stringify(state.body.accounts))
  const created = await adminPost('/keys/reveal', { id: state.body.keys[0].id })
  firstKey = created.body.secret
  firstId = state.body.keys[0].id
  check('reveal 拿到明文', typeof firstKey === 'string' && firstKey.startsWith('wbg-'), String(firstKey))
  check('state 里是打码的', /^\S{4}\*+\S{4}$/u.test(state.body.keys[0].masked), state.body.keys[0].masked)
}

console.log('\n== 鉴权 ==')
{
  check('无 key 401', (await fetch(`${API}/v1/models`)).status === 401)
  check('错 key 401', (await fetch(`${API}/v1/models`, { headers: { Authorization: 'Bearer wbg-nope' } })).status === 401)
  check('对 key 200', (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })).status === 200)
  check('x-goog-api-key', (await fetch(`${API}/v1/models`, { headers: { 'x-goog-api-key': firstKey } })).status === 200)
  check('?key=', (await fetch(`${API}/v1/models?key=${encodeURIComponent(firstKey)}`)).status === 200)
}

console.log('\n== 掩码必须是可安全放进 HTTP 头的 ASCII ==')
{
  const state = await adminGet('/state')
  const masked = state.body.keys[0].masked
  check('全是 ASCII', /^[\x20-\x7E]+$/u.test(masked), JSON.stringify(masked))
  check('不含 U+2026', !masked.includes('\u2026'), JSON.stringify(masked))
}

console.log('\n== 四种协议的准确地址（无自定义前缀）==')
{
  const state = await adminGet('/state')
  const byId = Object.fromEntries(state.body.endpoints.map((entry) => [entry.id, entry]))
  check('四条', state.body.endpoints.length === 4)
  /*
   * base URL 直接挂在 DSH 根地址上：不带 `/workbuddy-gateway`。
   * 用户明确要求「后缀太长，去掉」。
   */
  check('openai base 到 /v1', /^http:\/\/[^/]+\/v1$/u.test(byId['openai-chat']?.baseUrl ?? ''), byId['openai-chat']?.baseUrl)
  check('没有自定义前缀', !byId['openai-chat']?.baseUrl.includes('workbuddy-gateway'), byId['openai-chat']?.baseUrl)
  check('anthropic base 是根', /^http:\/\/[^/]+$/u.test(byId.anthropic?.baseUrl ?? ''), byId.anthropic?.baseUrl)
  check('anthropic 实际请求 /v1/messages', byId.anthropic?.requestUrl.endsWith('/v1/messages'), byId.anthropic?.requestUrl)
  check('gemini base 是根', /^http:\/\/[^/]+$/u.test(byId.gemini?.baseUrl ?? ''), byId.gemini?.baseUrl)
}

console.log('\n== 根路径与旧前缀都能用 ==')
{
  nextChunks = PLAIN
  /* 根路径：客户端默认形状。 */
  const rootModels = await fetch(`${ORIGIN}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  check('根 /v1/models', rootModels.status === 200, String(rootModels.status))
  const rootChat = await fetch(`${ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('根 /v1/chat/completions', rootChat.status === 200, String(rootChat.status))

  /* 旧前缀：已经填过它的客户端不该失效。 */
  const legacyModels = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  check('旧前缀仍可用', legacyModels.status === 200, String(legacyModels.status))
}

console.log('\n== 模型列表只返回勾选的模型 ==')
{
  /* 只勾一个默认账号的模型。上下文等元信息来自设置页的 available 表。 */
  const state = await adminGet('/state')
  const glm = state.body.available.find((model) => model.modelId === 'glm-5.3')
  check('available 带上下文', typeof glm?.contextWindow === 'number', JSON.stringify(glm))
  check('available 带推理档', Array.isArray(glm?.reasoningEfforts) && glm.reasoningEfforts.length === 2, JSON.stringify(glm?.reasoningEfforts))

  await adminPost('/keys/update', { id: firstId, selections: [{ ...glm, accountId: '' }] })
  const response = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const body = await response.json()
  check('只有一个模型', body.data.length === 1, JSON.stringify(body.data.map((row) => row.id)))
  check('名字是裸 id', body.data[0].id === 'glm-5.3', body.data[0].id)
  check('显示名', body.data[0].display_name === 'GLM-5.3', body.data[0].display_name)
  check('推理档列表', JSON.stringify(body.data[0].reasoning_efforts) === '["low","high"]', JSON.stringify(body.data[0].reasoning_efforts))
  check('上下文', body.data[0].context_window === 200000, String(body.data[0].context_window))
  check('输出上限', body.data[0].max_output_tokens === 8192, String(body.data[0].max_output_tokens))
}

console.log('\n== 重名模型：默认账号用区域、具名账号用昵称 ==')
{
  await adminPost('/keys/update', {
    id: firstId,
    selections: [
      { accountId: '', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
      { accountId: 'acct_pony', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
    ],
  })
  const body = await (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })).json()
  const ids = body.data.map((row) => row.id).sort()
  check('两条', ids.length === 2, JSON.stringify(ids))
  /*
   * 重名时**没有任何一条享受「裸名特权」**：默认账号那条也带后缀。
   * 否则 `glm-5.3` 与 `glm-5.3@pony` 并列，用户不知道前者是哪个账号的。
   */
  check('默认账号带区域后缀', ids.includes('glm-5.3@cn'), JSON.stringify(ids))
  check('英文昵称当后缀', ids.includes('glm-5.3@pony'), JSON.stringify(ids))
  check('后缀全 ASCII', ids.every((id) => /^[\x20-\x7E]+$/u.test(id)), JSON.stringify(ids))
}

console.log('\n== 默认账号跨区同名必须分开（用户报的场景）==')
{
  /*
   * 用户反馈：默认账号的同名模型，勾一个另一个跟着被选中，列表里只显示一个。
   * 根因是去重键与命名都漏了 region —— 默认账号在两个区的 accountId 都是 ''。
   */
  await adminPost('/keys/update', {
    id: firstId,
    selections: [
      { accountId: '', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
      { accountId: '', region: 'global', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
    ],
  })
  const state = await adminGet('/state')
  check('两条都存下来了', state.body.keys[0].selections.length === 2, String(state.body.keys[0].selections.length))

  const body = await (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })).json()
  const ids = body.data.map((row) => row.id).sort()
  check('列表里两行', ids.length === 2, JSON.stringify(ids))
  check('国内版默认账号', ids.includes('glm-5.3@cn'), JSON.stringify(ids))
  check('国际版默认账号', ids.includes('glm-5.3@intl'), JSON.stringify(ids))
  check('名字唯一', new Set(ids).size === ids.length, JSON.stringify(ids))
  /* 两行的 region 必须不同，客户端据此知道调的是哪个区。 */
  const regions = body.data.map((row) => row.region).sort()
  check('region 各自正确', regions[0] !== regions[1], JSON.stringify(regions))
}

console.log('\n== 重名模型：非 ASCII 账号名退化成序号 ==')
{
  await adminPost('/keys/update', {
    id: firstId,
    selections: [
      { accountId: 'acct_pony', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
      { accountId: 'acct_cat', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
    ],
  })
  const body = await (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })).json()
  const ids = body.data.map((row) => row.id)
  check('两条', ids.length === 2, JSON.stringify(ids))
  check('英文昵称那个用昵称', ids.includes('glm-5.3@pony'), JSON.stringify(ids))
  /* 非 ASCII 昵称退化时**先试区域后缀**（cn），再退到序号。 */
  check('非 ASCII 那个可区分', ids.some((id) => /^glm-5\.3@(cn(-\d+)?|#\d+)$/u.test(id) && id !== 'glm-5.3@pony'), JSON.stringify(ids))
  check('没有非 ASCII 字符', ids.every((id) => /^[\x20-\x7E]+$/u.test(id)), JSON.stringify(ids))
  check('名字唯一', new Set(ids).size === ids.length, JSON.stringify(ids))
}

console.log('\n== 请求按名字查表路由 ==')
{
  /*
   * 用两个区域各自的默认账号条目验证「按勾选的区域选 provider」。
   * 不用 acct_* 那条：那是直连通道，会真的去打上游。
   */
  await adminPost('/keys/update', {
    id: firstId,
    selections: [
      { accountId: '', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' },
      { accountId: '', region: 'global', modelId: 'kimi-k3', displayName: 'Kimi K3' },
    ],
  })
  nextChunks = PLAIN
  const response = await keyPost('/v1/chat/completions', firstKey, {
    model: 'kimi-k3',
    messages: [{ role: 'user', content: 'hi' }],
  })
  check('200', response.status === 200, String(response.status))
  check('provider 跟着勾选的区域', lastCall.options.provider === 'workbuddy-global', lastCall.options.provider)
  check('上游拿到真实模型 id', lastCall.options.model === 'kimi-k3', lastCall.options.model)
}

console.log('\n== 未勾选的模型报 404 并列出可选项 ==')
{
  const response = await keyPost('/v1/chat/completions', firstKey, {
    model: 'space-bunny',
    messages: [{ role: 'user', content: 'hi' }],
  })
  check('404', response.status === 404, String(response.status))
  const body = await response.json()
  check('错误码', body.error?.code === 'model_not_found', JSON.stringify(body))
  check('列出了可选项', body.error.message.includes('glm-5.3'), body.error.message)
}

console.log('\n== 推理档不写进默认值，只声明可选项 ==')
{
  await adminPost('/keys/update', {
    id: firstId,
    selections: [{ accountId: '', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3', reasoningEfforts: ['low', 'high', 'max'] }],
  })
  nextChunks = PLAIN
  await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
  })
  check('不替客户端选档', lastCall.options.reasoningEffort === undefined, String(lastCall.options.reasoningEffort))

  await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    reasoning_effort: 'max',
    messages: [{ role: 'user', content: 'hi' }],
  })
  check('客户端指定就透传', lastCall.options.reasoningEffort === 'max', String(lastCall.options.reasoningEffort))
}

console.log('\n== Responses 的 usage 必须是 input_tokens ==')
{
  /*
   * Codex 报 'missing field `input_tokens`' 并无限重连：Responses 用
   * input_tokens/output_tokens，不是 prompt_tokens/completion_tokens。
   */
  nextChunks = PLAIN
  const response = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', input: 'hi' }),
  })
  const body = await response.json()
  check('200', response.status === 200, String(response.status))
  check('input_tokens 存在', typeof body.usage?.input_tokens === 'number', JSON.stringify(body.usage))
  check('output_tokens 存在', typeof body.usage?.output_tokens === 'number', JSON.stringify(body.usage))
  check('没有 prompt_tokens', body.usage?.prompt_tokens === undefined, JSON.stringify(body.usage))

  /* 上游不报 usage 时也要给零值，不能省略字段。 */
  nextChunks = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'hi' }, { type: 'finish', reason: { kind: 'stop' } }]
  const noUsage = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', input: 'hi' }),
  })
  const noUsageBody = await noUsage.json()
  check('无 usage 时补零', noUsageBody.usage?.input_tokens === 0, JSON.stringify(noUsageBody.usage))
}

console.log('\n== Responses 流式也带 input_tokens ==')
{
  nextChunks = PLAIN
  const response = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, input: 'hi' }),
  })
  const text = await response.text()
  check('completed 事件', text.includes('event: response.completed'))
  check('带 input_tokens', text.includes('"input_tokens"'), text.slice(-400))
}

console.log('\n== Anthropic 形状的模型列表 ==')
{
  const anthropic = await fetch(`${API}/v1/models`, {
    headers: { 'x-api-key': firstKey, 'anthropic-version': '2023-06-01' },
  })
  const body = await anthropic.json()
  check('200', anthropic.status === 200, String(anthropic.status))
  check('data 数组', Array.isArray(body.data), JSON.stringify(body).slice(0, 120))
  check('type: model', body.data[0]?.type === 'model')
  check('display_name', typeof body.data[0]?.display_name === 'string')
  check('没有 object:list', body.object === undefined)

  const openai = await (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })).json()
  check('不带 anthropic 头仍是 OpenAI 形状', openai.object === 'list', String(openai.object))
}

console.log('\n== 两个 key 各管各的清单 ==')
{
  await adminPost('/keys/update', {
    id: firstId,
    selections: [{ accountId: '', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' }],
  })
  const created = await adminPost('/keys', {
    label: 'second',
    selections: [{ accountId: '', region: 'global', modelId: 'kimi-k3', displayName: 'Kimi K3' }],
  })
  const secondKey = created.body.created.secret
  const a = await (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })).json()
  const b = await (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${secondKey}` } })).json()
  check('第一把只见 glm-5.3', a.data.length === 1 && a.data[0].id === 'glm-5.3', JSON.stringify(a.data.map((row) => row.id)))
  check('第二把只见 kimi-k3', b.data.length === 1 && b.data[0].id === 'kimi-k3', JSON.stringify(b.data.map((row) => row.id)))

  const health = await (await fetch(`${API}/healthz`, { headers: { Authorization: `Bearer ${secondKey}` } })).json()
  check('healthz 报出本 key 的模型', JSON.stringify(health.key?.models) === '["kimi-k3"]', JSON.stringify(health.key))
}

console.log('\n== 停用与轮换 ==')
{
  const state = await adminGet('/state')
  const second = state.body.keys.find((entry) => entry.label === 'second')
  await adminPost('/keys/update', { id: second.id, enabled: false })
  const revealed = await adminPost('/keys/reveal', { id: second.id })
  check('停用后 401', (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${revealed.body.secret}` } })).status === 401)
  await adminPost('/keys/update', { id: second.id, enabled: true })
  check('重新启用后 200', (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${revealed.body.secret}` } })).status === 200)

  const before = revealed.body.secret
  const rotated = await adminPost('/keys/rotate', { id: second.id })
  check('换了一把', rotated.body.secret !== before)
  check('旧 secret 失效', (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${before}` } })).status === 401)
  check('新 secret 可用', (await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${rotated.body.secret}` } })).status === 200)
}

console.log('\n== 删除 key ==')
{
  const state = await adminGet('/state')
  const count = state.body.keys.length
  const target = state.body.keys.find((entry) => entry.label === 'second')
  const deleted = await adminPost('/keys/delete', { id: target.id })
  check('200', deleted.status === 200, String(deleted.status))
  check('少了一把', deleted.body.keys.length === count - 1)
  check('再删 404', (await adminPost('/keys/delete', { id: target.id })).status === 404)
}

console.log('\n== 空清单的 key 明确报错 ==')
{
  await adminPost('/keys/update', { id: firstId, selections: [] })
  const response = await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('409', response.status === 409, String(response.status))
  const body = await response.json()
  check('错误码', body.error?.code === 'model_not_configured', JSON.stringify(body))
  /* 恢复清单：后面的用例都要用。 */
  const state = await adminGet('/state')
  const glm = state.body.available.find((model) => model.modelId === 'glm-5.3')
  await adminPost('/keys/update', { id: firstId, selections: [{ ...glm, accountId: '' }] })
}

console.log('\n== Responses 流式必须符合 OpenAI 规范 ==')
{
  /*
   * 这条来自真实故障：Coopanion（以及任何强类型客户端）报「服务已应答，但响应
   * 格式不兼容」。根因是流里缺 `sequence_number` —— 那是标准字段，不是某个
   * 客户端的私有要求。用 tests/responses-spec.mjs 按官方事件契约逐条验。
   */
  const { validateResponsesStream, parseSseEvents } = await import('./responses-spec.mjs')

  const cases = [
    ['纯文本', PLAIN],
    ['带工具调用', TOOLS],
    ['只有文本没有思考', [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'hi' }, { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } }, { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' } }]],
    ['上游不报 usage', [{ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } }]],
  ]

  for (const [label, chunks] of cases) {
    nextChunks = chunks
    const response = await fetch(`${API}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
      body: JSON.stringify({ model: 'glm-5.3', stream: true, input: 'hi' }),
    })
    const text = await response.text()
    const events = parseSseEvents(text)
    check(`${label}：能解析出事件`, events.length > 0, String(events.length))
    const problems = validateResponsesStream(events)
    check(`${label}：符合规范`, problems.length === 0, problems.slice(0, 4).join(' | '))
  }
}

console.log('\n== 模型条目必须给出上下文与输出上限（缺失则用默认值）==')
{
  /*
   * cc-switch 的「获取模型列表」会把这两个值填进它自己的表单；字段缺席就是空白
   * 一栏。所以宁可给保守默认值也不能省略。
   */
  const response = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const body = await response.json()
  const entry = body.data[0]
  for (const field of ['context_window', 'context_length', 'context_tokens', 'max_context_tokens', 'max_input_tokens']) {
    check(`${field} 是数字`, typeof entry[field] === 'number', JSON.stringify(entry[field]))
  }
  for (const field of ['max_output_tokens', 'max_completion_tokens']) {
    check(`${field} 是数字`, typeof entry[field] === 'number', JSON.stringify(entry[field]))
  }
  check('limit.context', typeof entry.limit?.context === 'number')
  check('limit.output', typeof entry.limit?.output === 'number')
  check('input_modalities', Array.isArray(entry.input_modalities))
  check('supports_vision 是布尔', typeof entry.supports_vision === 'boolean')
  check('reasoning_efforts 是数组', Array.isArray(entry.reasoning_efforts))
}

console.log('\n== Anthropic 目录也带完整元信息 ==')
{
  const response = await fetch(`${API}/v1/models`, {
    headers: { 'x-api-key': firstKey, 'anthropic-version': '2023-06-01' },
  })
  const body = await response.json()
  const entry = body.data[0]
  check('context_window', typeof entry.context_window === 'number', JSON.stringify(entry))
  check('max_input_tokens', typeof entry.max_input_tokens === 'number')
  check('max_output_tokens', typeof entry.max_output_tokens === 'number')
}

console.log('\n== Gemini 目录也带 token 上限 ==')
{
  const response = await fetch(`${API}/v1beta/models`, { headers: { 'x-goog-api-key': firstKey } })
  const body = await response.json()
  const entry = body.models[0]
  check('inputTokenLimit', typeof entry.inputTokenLimit === 'number', JSON.stringify(entry))
  check('outputTokenLimit', typeof entry.outputTokenLimit === 'number')
}

console.log('\n== 上游异常中断必须发 response.failed，不能伪装成功 ==')
{
  /*
   * 真实故障：上游 429 时流被切断，旧版本在 `hostStream` 里补了一个伪造的
   * `{kind:'stop'}`，于是客户端收到「response.created + response.in_progress 之后
   * 什么都没有」的残流 —— 既不是成功也不是失败，强类型客户端判格式不兼容。
   */
  const { validateResponsesStream, parseSseEvents } = await import('./responses-spec.mjs')

  /* 情况 A：上游报了错误 chunk。 */
  nextChunks = [
    { type: 'text-delta', index: 0, text: '半截' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT', status: 429 } } },
  ]
  const failed = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, input: 'hi' }),
  })
  const failedText = await failed.text()
  const failedEvents = parseSseEvents(failedText)
  check('有 terminal 事件', failedEvents.some((event) => event.type === 'response.failed'), JSON.stringify(failedEvents.map((e) => e.type)))
  check('带错误信息', failedEvents.some((event) => event.type === 'response.failed' && typeof event.response?.error?.message === 'string'))
  check('符合规范', validateResponsesStream(failedEvents).length === 0, validateResponsesStream(failedEvents).slice(0, 3).join(' | '))

  /* 情况 B：流自己结束，没有 finish chunk（模拟上游直接断流）。 */
  nextChunks = [{ type: 'text-delta', index: 0, text: '半截' }]
  const truncated = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', stream: true, input: 'hi' }),
  })
  const truncatedEvents = parseSseEvents(await truncated.text())
  check('断流也是 failed', truncatedEvents.some((event) => event.type === 'response.failed'), JSON.stringify(truncatedEvents.map((e) => e.type)))
  check('断流也符合规范', validateResponsesStream(truncatedEvents).length === 0, validateResponsesStream(truncatedEvents).slice(0, 3).join(' | '))

  /* 情况 C：同一场景下 Chat 协议必须是错误，不能是空成功。 */
  nextChunks = [{ type: 'text-delta', index: 0, text: '半截' }]
  const chatTruncated = await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  })
  const chatText = await chatTruncated.text()
  check('Chat 断流带 error 帧', chatText.includes('"error"'), chatText.slice(-200))
}

console.log('\n== 并行工具调用必须按 index 分组（否则参数串坏 JSON）==')
{
  /*
   * 真实故障：Claude 报
   *   ToolSearch was called with input that could not be parsed as JSON.
   *   You sent (first 1 of 1 bytes): }
   * 根因是 `fromHostChunks` 丢掉了上游 chunk 的 `index`，两个并行调用的参数被
   * 拼成同一个 block。这里用两个交错到达的调用验证每个协议都分得开。
   */
  const parallel = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '查一下' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '查一下' } },
    /* 两个调用交错到达：这正是 OpenAI 允许、而 naive 实现会拼错的情形。 */
    { type: 'tool-call-delta', index: 1, id: 'call_a', name: 'get_weather', argumentsDelta: '{"city":' },
    { type: 'tool-call-delta', index: 2, id: 'call_b', name: 'get_time', argumentsDelta: '{"zone":' },
    { type: 'tool-call-delta', index: 1, id: 'call_a', name: 'get_weather', argumentsDelta: '"北京"}' },
    { type: 'tool-call-delta', index: 2, id: 'call_b', name: 'get_time', argumentsDelta: '"UTC"}' },
    { type: 'usage', usage: { inputTokens: 20, outputTokens: 9 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]

  /* Chat 非流式：两个独立的 tool_calls，参数各自完整。 */
  nextChunks = parallel
  const chat = await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    messages: [{ role: 'user', content: '北京天气和时间' }],
  })
  const chatBody = await chat.json()
  const calls = chatBody.choices?.[0]?.message?.tool_calls ?? []
  check('Chat 有两个调用', calls.length === 2, JSON.stringify(calls.map((c) => c.id)))
  check('第一个参数完整', calls[0]?.function?.arguments === '{"city":"北京"}', calls[0]?.function?.arguments)
  check('第二个参数完整', calls[1]?.function?.arguments === '{"zone":"UTC"}', calls[1]?.function?.arguments)

  /* Chat 流式：index 必须来自上游（1 和 2），且两个调用的分片能归到各自 index。 */
  nextChunks = parallel
  const chatStream = await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    stream: true,
    messages: [{ role: 'user', content: '北京天气和时间' }],
  })
  const streamText = await chatStream.text()
  const indexes = [...streamText.matchAll(/"tool_calls":\[\{"index":(\d+)/gu)].map((match) => Number(match[1]))
  /* 交错到达是合法的：同一个 index 可以出现多次，但值只能来自 {1,2}。 */
  check('流式 index 来自上游', indexes.length > 0 && indexes.every((value) => value === 1 || value === 2), JSON.stringify(indexes))
  check('两个 index 都用到', new Set(indexes).size === 2, JSON.stringify([...new Set(indexes)]))

  /* Anthropic：两个 tool_use block，各自 input_json_delta 完整。 */
  nextChunks = parallel
  const anthropic = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey },
    body: JSON.stringify({ model: 'glm-5.3', max_tokens: 256, stream: true, messages: [{ role: 'user', content: '北京天气和时间' }] }),
  })
  const anthropicText = await anthropic.text()
  const starts = [...anthropicText.matchAll(/"type":"tool_use","id":"(call_[ab])"/gu)].map((m) => m[1])
  check('Anthropic 两个 tool_use', starts.length === 2, JSON.stringify(starts))
  /*
   * 把 SSE 里所有 input_json_delta 的 partial_json 收集起来，按 content block
   * 的 index 分组。用真正的 JSON 解析而不是正则截断 —— 参数里有大量转义引号，
   * 正则会在第一个 `\"` 处切错。
   */
  const anthropicEvents = (await import('./responses-spec.mjs')).parseSseEvents(anthropicText)
  const argsByBlock = new Map()
  for (const event of anthropicEvents) {
    if (event.type !== 'content_block_delta') continue
    const delta = event.delta ?? {}
    if (delta.type !== 'input_json_delta') continue
    const key = event.index
    argsByBlock.set(key, (argsByBlock.get(key) ?? '') + String(delta.partial_json ?? ''))
  }
  check('参数分两个 block', argsByBlock.size === 2, JSON.stringify([...argsByBlock.keys()]))
  const parsed = [...argsByBlock.values()]
  check('两段各自可解析', parsed.every((piece) => { try { JSON.parse(piece); return true } catch { return false } }), JSON.stringify(parsed))
  check('参数内容正确', parsed.sort().join('|') === '{"city":"北京"}|{"zone":"UTC"}', JSON.stringify(parsed))

  /* Responses：两个 function_call item，参数各自完整。 */
  nextChunks = parallel
  const responses = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ model: 'glm-5.3', input: '北京天气和时间' }),
  })
  const responsesBody = await responses.json()
  const functionCalls = (responsesBody.output ?? []).filter((item) => item.type === 'function_call')
  check('Responses 两个 function_call', functionCalls.length === 2, JSON.stringify(functionCalls.map((c) => c.call_id)))
  check('参数各自完整', functionCalls.map((c) => c.arguments).join('|') === '{"city":"北京"}|{"zone":"UTC"}', JSON.stringify(functionCalls.map((c) => c.arguments)))
  check('没有内部字段泄漏', functionCalls.every((c) => !Object.keys(c).some((key) => key.startsWith('__'))), JSON.stringify(functionCalls[0]))
}

console.log('\n== 不可用账号必须从可勾选列表移除 ==')
{
  /*
   * 用户要求：上游判定账号不可用时，把它从可勾选模型列表里去掉，并与上游保持同步。
   * 这里伪造一份池状态（`acct_pony` 限流未过期、`acct_cat` 限流但已过期），
   * 验证只有真正不可用的那个被移出候选。
   */
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const poolDir = process.env.DSH_HOME
  mkdirSync(poolDir, { recursive: true })
  const now = Date.now()
  writeFileSync(join(poolDir, '.workbuddy-pool.cn.json'), JSON.stringify({
    version: 1,
    probes: {
      /* 限流中，冷却还有一小时 → 不可用。 */
      acct_pony: {
        outcome: 'rate-limited',
        atMs: now - 60000,
        retryAtMs: now + 3600000,
        message: '{"code":6004,"msg":"您的使用量已超出频率限制"}',
        accountName: 'pony',
      },
      /* 限流但冷却已过 → 只是历史，账号现在可用。 */
      acct_cat: {
        outcome: 'rate-limited',
        atMs: now - 7200000,
        retryAtMs: now - 3600000,
        message: 'old',
        accountName: 'ฅ՞•ﻌ•՞ฅ',
      },
    },
  }), 'utf8')

  const state = await adminGet('/state')
  const unavailableIds = (state.body.unavailableAccounts ?? []).map((account) => account.id)
  check('限流未过期的被移除', unavailableIds.includes('acct_pony'), JSON.stringify(unavailableIds))
  check('冷却已过的不算', !unavailableIds.includes('acct_cat'), JSON.stringify(unavailableIds))

  /* 可勾选候选里不该出现不可用账号。 */
  const candidateAccounts = new Set((state.body.available ?? []).map((row) => row.accountId))
  check('候选里没有不可用账号', !candidateAccounts.has('acct_pony'), JSON.stringify([...candidateAccounts]))
  check('候选里有可用账号', candidateAccounts.has('acct_cat'), JSON.stringify([...candidateAccounts]))
  /* 默认账号那条永远在（它跟着插件走，不是某个具体账号）。 */
  check('默认账号始终可选', candidateAccounts.has(''), JSON.stringify([...candidateAccounts]))

  /* 账号表里仍然列出它，只是标成不可用 —— 用户要能看见「它去哪了」。 */
  const listed = state.body.accounts.find((account) => account.id === 'acct_pony')
  check('账号表仍列出', listed !== undefined)
  check('标为不可用', listed?.available === false, JSON.stringify(listed))
  check('带原因', typeof listed?.reason === 'string' && listed.reason.length > 0, listed?.reason)

  /* 状态文件时间戳要报出来，用户能判断这份状态多新。 */
  check('报出状态时间', typeof state.body.health?.stateFileMtime === 'number' && state.body.health.stateFileMtime > 0, JSON.stringify(state.body.health))
}

console.log('\n== 账号恢复后必须自动回到可勾选列表 ==')
{
  /*
   * 用户问：「账号恢复了是否能同步过来」。
   *
   * 恢复由两件事共同保证：
   *   1. `poolHealth` 把「冷却已过」判为可用（时间到了就放回）
   *   2. `/state` 每次被读都重算，设置页每 30 秒读一次
   *
   * 这里验证第 1 条在**同一个账号**上从不可用翻回可用 —— 关键是不能缓存住。
   */
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const poolFile = join(process.env.DSH_HOME, '.workbuddy-pool.cn.json')
  const now = Date.now()

  /* 先写成「冷却中」。 */
  writeFileSync(poolFile, JSON.stringify({
    version: 1,
    probes: { acct_pony: { outcome: 'rate-limited', atMs: now - 60000, retryAtMs: now + 3600000, message: '限流' } },
  }), 'utf8')
  const cooling = await adminGet('/state')
  check('冷却中不可用', cooling.body.accounts.find((a) => a.id === 'acct_pony')?.available === false, JSON.stringify(cooling.body.accounts.find((a) => a.id === 'acct_pony')))

  /* 改成「冷却已过」—— 同一个文件、同一个账号，只有时间变了。 */
  writeFileSync(poolFile, JSON.stringify({
    version: 1,
    probes: { acct_pony: { outcome: 'rate-limited', atMs: now - 7200000, retryAtMs: now - 1000, message: '旧限流' } },
  }), 'utf8')
  const recovered = await adminGet('/state')
  const account = recovered.body.accounts.find((a) => a.id === 'acct_pony')
  check('冷却到期后恢复可用', account?.available === true, JSON.stringify(account))
  check('恢复后回到候选', (recovered.body.available ?? []).some((row) => row.accountId === 'acct_pony'), 'not in candidates')
  check('不再出现在不可用列表', !(recovered.body.unavailableAccounts ?? []).some((a) => a.id === 'acct_pony'), JSON.stringify(recovered.body.unavailableAccounts))

  /*
   * 上游再次写回失败 → 立刻又变不可用。这是「跟上游保持同步」的另一半：
   * 恢复不是一次性的，随时可能因为新一轮限流再变回去。
   */
  writeFileSync(poolFile, JSON.stringify({
    version: 1,
    probes: { acct_pony: { outcome: 'rate-limited', atMs: now, retryAtMs: now + 1800000, message: '又限流了' } },
  }), 'utf8')
  const again = await adminGet('/state')
  check('再限流又变不可用', again.body.accounts.find((a) => a.id === 'acct_pony')?.available === false, JSON.stringify(again.body.accounts.find((a) => a.id === 'acct_pony')))
  check('又从候选移除', !(again.body.available ?? []).some((row) => row.accountId === 'acct_pony'), 'still in candidates')
}

console.log('\n== 配置目录的解析规则 ==')
{
  /*
   * 目录来自插件配置 `dataDir`，不是写死的。三种写法都要对：
   *   空 → 默认目录（名与包名一致）
   *   相对 → 相对 DSH 主目录（不是进程 cwd —— cwd 会因启动方式变化）
   *   绝对 → 原样使用
   */
  const { resolveDataDir, DEFAULT_DATA_DIR_NAME, dshHome } = await import('../src/config.js')
  const home = dshHome()

  const empty = resolveDataDir('')
  check('空值用默认名', empty === `${home}\\${DEFAULT_DATA_DIR_NAME}` || empty === `${home}/${DEFAULT_DATA_DIR_NAME}`, empty)
  check('默认名等于包名', DEFAULT_DATA_DIR_NAME === 'dsh-connect-workbuddy-gateway', DEFAULT_DATA_DIR_NAME)

  const rel = resolveDataDir('my-keys')
  check('相对路径基于 DSH 主目录', rel.startsWith(home), rel)

  const abs = resolveDataDir('D:\\gateway-keys')
  check('绝对路径原样使用', abs === 'D:\\gateway-keys' || abs === 'D:/gateway-keys', abs)

  /* 首尾空白要被吃掉，否则会建出一个带空格的目录名。 */
  const padded = resolveDataDir('  my-keys  ')
  check('忽略首尾空白', padded === rel, padded)
}

console.log('\n== 配置目录可通过设置接口读取 ==')
{
  const state = await adminGet('/state')
  check('state 带 paths', state.body.paths !== undefined, JSON.stringify(state.body.paths))
  check('给出实际目录', typeof state.body.paths?.dataDir === 'string' && state.body.paths.dataDir.length > 0, state.body.paths?.dataDir)
  check('给出配置文件', typeof state.body.paths?.configPath === 'string' && state.body.paths.configPath.endsWith('keys.json'), state.body.paths?.configPath)
  check('标注是否默认', typeof state.body.paths?.dataDirIsDefault === 'boolean', String(state.body.paths?.dataDirIsDefault))
  /* 测试环境用的是默认目录（DSH_HOME 是临时目录）。 */
  check('测试环境用默认目录', state.body.paths?.dataDirIsDefault === true, String(state.body.paths?.dataDirIsDefault))
  check('默认目录名与包名一致', state.body.paths?.defaultDataDirName === 'dsh-connect-workbuddy-gateway', state.body.paths?.defaultDataDirName)
}

console.log('\n== OpenAI Chat 流式 + 工具 ==')
{
  await adminPost('/keys/update', {
    id: firstId,
    selections: [{ accountId: '', region: 'cn', modelId: 'glm-5.3', displayName: 'GLM-5.3' }],
  })
  nextChunks = TOOLS
  const response = await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    stream: true,
    messages: [{ role: 'user', content: '北京天气' }],
    tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
  })
  const text = await response.text()
  check('200', response.status === 200, String(response.status))
  check('SSE 头', response.headers.get('content-type')?.includes('text/event-stream') === true)
  check('DONE', text.includes('data: [DONE]'))
  check('tool_calls', text.includes('"tool_calls"'))
  check('finish tool_calls', text.includes('"finish_reason":"tool_calls"'))
  check('工具已下发', lastCall.options.tools?.length === 1, JSON.stringify(lastCall.options.tools))
}

console.log('\n== 消息历史投影 ==')
{
  nextChunks = PLAIN
  await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '北京天气' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '晴' },
    ],
  })
  const messages = lastCall.options.messages
  check('system 抽出', lastCall.options.system === '你是助手', lastCall.options.system)
  check('三条消息', messages.length === 3, String(messages.length))
  check('assistant source', messages[1].source?.kind === 'model', JSON.stringify(messages[1].source))
  check('toolCallId', messages[2].toolCallId === 'call_1', messages[2].toolCallId)
}

console.log('\n== Anthropic Messages ==')
{
  nextChunks = PLAIN
  const response = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'glm-5.3', max_tokens: 256, system: '你是助手', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }),
  })
  const body = await response.json()
  check('200', response.status === 200, String(response.status))
  check('type', body.type === 'message')
  check('文本', body.content?.find((block) => block.type === 'text')?.text === '你好，世界', JSON.stringify(body.content))
  check('thinking', body.content?.find((block) => block.type === 'thinking')?.thinking === '想一想…')
  check('stop_reason', body.stop_reason === 'end_turn')

  nextChunks = TOOLS
  const streamed = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey },
    body: JSON.stringify({ model: 'glm-5.3', max_tokens: 256, stream: true, messages: [{ role: 'user', content: '北京天气' }] }),
  })
  const text = await streamed.text()
  check('message_start', text.includes('event: message_start'))
  check('tool_use', text.includes('"tool_use"'))
  check('message_stop', text.includes('event: message_stop'))
}

console.log('\n== Gemini ==')
{
  nextChunks = PLAIN
  const plain = await fetch(`${API}/v1beta/models/glm-5.3:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': firstKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: '你好' }] }] }),
  })
  const body = await plain.json()
  check('200', plain.status === 200, String(plain.status))
  check('文本', body.candidates?.[0]?.content?.parts?.some((part) => part.text === '你好，世界'), JSON.stringify(body))
}

console.log('\n== 图片输入 ==')
{
  nextChunks = PLAIN
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await keyPost('/v1/chat/completions', firstKey, {
    model: 'glm-5.3',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      ],
    }],
  })
  const imageBlock = lastCall.options.messages[0].content.find((block) => block.type === 'image')
  check('图片块', imageBlock !== undefined, JSON.stringify(lastCall.options.messages[0].content))
  check('附件引用', typeof imageBlock?.attachment?.attachmentId === 'string')
}

console.log('\n== 上游失败传播 ==')
{
  failNext = { message: 'quota exhausted', code: 'QUOTA_EXCEEDED', status: 402 }
  const response = await keyPost('/v1/chat/completions', firstKey, { model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
  check('402', response.status === 402, String(response.status))
  const body = await response.json()
  check('错误体', body.error?.message === 'quota exhausted', JSON.stringify(body))
}

console.log('\n== 管理接口边界 ==')
{
  check('未知 key 404', (await adminPost('/keys/update', { id: 'k_nope', selections: [] })).status === 404)
  check('未知管理路由 404', (await adminGet('/nope')).status === 404)
  check('未知 API 路由 404', (await fetch(`${API}/v1/nope`, { headers: { Authorization: `Bearer ${firstKey}` } })).status === 404)
}

/* ── 收尾 ─────────────────────────────────────────────────────────────── */

for (const dispose of disposers) {
  try {
    await dispose()
  } catch {}
}
currentServer.close()

console.log(failures === 0 ? '\n全部通过\n' : `\n${failures} 个用例失败\n`)
process.exit(failures === 0 ? 0 : 1)
