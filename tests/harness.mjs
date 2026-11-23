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

const API = `${origin}/workbuddy-gateway`
const ADMIN = `${origin}/plugins/dsh-workbuddy-gateway`

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

console.log('\n== 四种协议的准确地址 ==')
{
  const state = await adminGet('/state')
  const byId = Object.fromEntries(state.body.endpoints.map((entry) => [entry.id, entry]))
  check('四条', state.body.endpoints.length === 4)
  check('openai base 带 /v1', byId['openai-chat']?.baseUrl.endsWith('/workbuddy-gateway/v1'))
  check('anthropic base 不带 /v1', byId.anthropic?.baseUrl.endsWith('/workbuddy-gateway'))
  check('gemini base 到根', byId.gemini?.baseUrl.endsWith('/workbuddy-gateway'))
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

console.log('\n== 重名模型：英文账号名当后缀 ==')
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
  check('默认账号保留裸名', ids.includes('glm-5.3'), JSON.stringify(ids))
  check('英文昵称当后缀', ids.includes('glm-5.3@pony'), JSON.stringify(ids))
  check('后缀全 ASCII', ids.every((id) => /^[\x20-\x7E]+$/u.test(id)), JSON.stringify(ids))
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
  check('非 ASCII 那个用序号', ids.some((id) => /^glm-5\.3@#\d+$/u.test(id)), JSON.stringify(ids))
  check('没有非 ASCII 字符', ids.every((id) => /^[\x20-\x7E]+$/u.test(id)), JSON.stringify(ids))
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
