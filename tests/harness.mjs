/**
 * 本地端到端自测：用假 ctx 把网关的两类路由都跑一遍。
 *
 *   - 对外 API：四种协议的入站解析与出站序列化，以及「策略来自 key」的路由；
 *   - 管理接口：key 的增删改、显示/重置、按策略落盘。
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
let defaultSelectionValue = { provider: 'workbuddy', model: 'glm-5.3', reasoningEffort: 'high' }
let sessionSelectionValue
let failNext = undefined

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

const services = new Map([
  ['llm', llm],
  ['attachments', attachments],
  ['agentDefaultModel', { currentSelection: () => defaultSelectionValue }],
  ['agents', {
    list: () => (sessionSelectionValue === undefined
      ? []
      : [{ session: { requestHeader: () => ({ config: sessionSelectionValue }) } }]),
  }],
])

let origin = ''
let currentServer
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
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
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(payload),
  })
  return response
}

/* ── 用例 ─────────────────────────────────────────────────────────────── */

console.log('\n== 首次启动自动建 key ==')
let firstKey
{
  const state = await adminGet('/state')
  check('200', state.status === 200, String(state.status))
  check('一把默认 key', state.body.keys?.length === 1, JSON.stringify(state.body.keys))
  check('baseUrl', state.body.baseUrl === API, state.body.baseUrl)
  check('策略可选项', state.body.policyModes?.length === 6, JSON.stringify(state.body.policyModes))
  const created = await adminPost('/keys/reveal', { id: state.body.keys[0].id })
  firstKey = created.body.secret
  check('reveal 拿到明文', typeof firstKey === 'string' && firstKey.startsWith('wbg-'), String(firstKey))
  check('state 里是打码的', /^\S{4}\*+\S{4}$/u.test(state.body.keys[0].masked), state.body.keys[0].masked)
  check('目录已投影', state.body.models?.length === 4, String(state.body.models?.length))
}

console.log('\n== 鉴权 ==')
{
  const none = await fetch(`${API}/v1/models`)
  check('无 key 401', none.status === 401, String(none.status))
  const wrong = await fetch(`${API}/v1/models`, { headers: { Authorization: 'Bearer wbg-nope' } })
  check('错 key 401', wrong.status === 401, String(wrong.status))
  const good = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  check('对 key 200', good.status === 200, String(good.status))
  const viaGoogle = await fetch(`${API}/v1/models`, { headers: { 'x-goog-api-key': firstKey } })
  check('x-goog-api-key', viaGoogle.status === 200, String(viaGoogle.status))
  const viaQuery = await fetch(`${API}/v1/models?key=${encodeURIComponent(firstKey)}`)
  check('?key=', viaQuery.status === 200, String(viaQuery.status))
}

console.log('\n== 掩码必须是可安全放进 HTTP 头的 ASCII ==')
{
  /*
   * 这条来自真实故障：掩码里用了 `…`（U+2026），用户把它当 key 填进客户端后
   * 报 `Cannot convert argument to a ByteString ... value of 8230`。
   */
  const state = await adminGet('/state')
  const masked = state.body.keys[0].masked
  check('全是 ASCII', /^[\x20-\x7E]+$/u.test(masked), JSON.stringify(masked))
  check('不含 U+2026', !masked.includes('\u2026'), JSON.stringify(masked))
  check('不含 U+00B7/U+2022', !masked.includes('\u00b7') && !masked.includes('\u2022'), JSON.stringify(masked))
  const byteSafe = (() => {
    try {
      /* 模拟 HTTP 头写入：任何 >255 的码点都会抛。 */
      Buffer.from(masked, 'latin1')
      for (const ch of masked) if (ch.codePointAt(0) > 255) return false
      return true
    } catch {
      return false
    }
  })()
  check('可编码成 ByteString', byteSafe, JSON.stringify(masked))
}

console.log('\n== 四种协议的准确地址 ==')
{
  const state = await adminGet('/state')
  const endpoints = state.body.endpoints ?? []
  check('四条', endpoints.length === 4, String(endpoints.length))
  const byId = Object.fromEntries(endpoints.map((entry) => [entry.id, entry]))
  check('openai base 带 /v1', byId['openai-chat']?.baseUrl.endsWith('/workbuddy-gateway/v1'), byId['openai-chat']?.baseUrl)
  check('anthropic base 不带 /v1', byId.anthropic?.baseUrl.endsWith('/workbuddy-gateway'), byId.anthropic?.baseUrl)
  check('anthropic 实际请求 /v1/messages', byId.anthropic?.requestUrl.endsWith('/v1/messages'), byId.anthropic?.requestUrl)
  check('gemini base 到根', byId.gemini?.baseUrl.endsWith('/workbuddy-gateway'), byId.gemini?.baseUrl)
  check('gemini 实际请求 /v1beta', byId.gemini?.requestUrl.includes('/v1beta/models/'), byId.gemini?.requestUrl)
}

console.log('\n== 带 /v1 前缀的地址真的能用 ==')
{
  nextChunks = PLAIN
  const models = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  check('GET /v1/models', models.status === 200, String(models.status))
  const chat = await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('POST /v1/chat/completions', chat.status === 200, String(chat.status))
  const responses = await keyPost('/v1/responses', firstKey, { input: 'hi' })
  check('POST /v1/responses', responses.status === 200, String(responses.status))
  const messages = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey },
    body: JSON.stringify({ max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('POST /v1/messages', messages.status === 200, String(messages.status))
  const doubled = await fetch(`${API}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey },
    body: JSON.stringify({ max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  })
  check('POST /anthropic/v1/messages（前缀叠加）', doubled.status === 200, String(doubled.status))
  const gemini = await fetch(`${API}/v1beta/models/-:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': firstKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  })
  check('POST /v1beta/models/-:generateContent', gemini.status === 200, String(gemini.status))
}

console.log('\n== 模型目录不带区域前缀 ==')
{
  const response = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const body = await response.json()
  const ids = body.data.map((entry) => entry.id)
  check('裸 id', ids.includes('glm-5.3'), ids.join(','))
  check('没有 cn/ 前缀', !ids.some((id) => id.startsWith('cn/')), ids.join(','))
  check('region 字段', body.data[0].region !== undefined, JSON.stringify(body.data[0]))
}

console.log('\n== 模型条目必须带齐客户端要填的表单字段 ==')
{
  /*
   * 真实反馈：客户端拿到了 9 个模型，但「最大输出 / 上下文上限 / 是否接受图片」
   * 三栏全是空的。原因是老投影只给了 id 与 object。
   */
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'dsh' } })
  const response = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const entry = (await response.json()).data[0]
  check('contextWindow（camelCase）', typeof entry.contextWindow === 'number', JSON.stringify(entry))
  check('context_window（snake）', typeof entry.context_window === 'number', JSON.stringify(entry))
  check('max_input_tokens（LiteLLM）', typeof entry.max_input_tokens === 'number')
  check('limit.context（OpenRouter）', typeof entry.limit?.context === 'number')
  check('max_output_tokens', typeof entry.max_output_tokens === 'number', JSON.stringify(entry))
  check('limit.output', typeof entry.limit?.output === 'number')
  check('input_modalities', Array.isArray(entry.input_modalities), JSON.stringify(entry.input_modalities))
  check('supports_vision', typeof entry.supports_vision === 'boolean')
  check('reasoning', typeof entry.reasoning === 'boolean', JSON.stringify(entry.reasoning))
}

console.log('\n== 钉死模型的 key 只列出那一个模型 ==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'named', provider: 'workbuddy', model: 'glm-5.3' } })

  const narrowed = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const body = await narrowed.json()
  check('只有一个模型', body.data.length === 1, JSON.stringify(body.data.map((row) => row.id)))
  check('就是钉死的那个', body.data[0].id === 'glm-5.3', body.data[0].id)

  /* 换成另一把 key 的模型，列表要跟着变。 */
  await adminPost('/keys/update', { id, policy: { mode: 'named', provider: 'workbuddy-global', model: 'kimi-k3' } })
  const again = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const body2 = await again.json()
  check('换策略后跟着变', body2.data.length === 1 && body2.data[0].id === 'kimi-k3', JSON.stringify(body2.data.map((row) => row.id)))

  /* 跟随型策略仍给全量目录。 */
  await adminPost('/keys/update', { id, policy: { mode: 'dsh' } })
  const full = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  check('跟随型给全量', (await full.json()).data.length === 4, 'expected 4')
}

console.log('\n== Anthropic 形状的模型列表 ==')
{
  /*
   * Anthropic SDK 请求 /v1/models 时期待 `data:[{type,id,display_name}]`；
   * 给它 OpenAI 的 `object:'list'` 就是"响应格式不兼容"。
   * 判据是 anthropic-version 头。
   */
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'dsh' } })

  const anthropic = await fetch(`${API}/v1/models`, {
    headers: { 'x-api-key': firstKey, 'anthropic-version': '2023-06-01' },
  })
  const body = await anthropic.json()
  check('200', anthropic.status === 200, String(anthropic.status))
  check('data 数组', Array.isArray(body.data), JSON.stringify(body).slice(0, 120))
  check('type: model', body.data[0]?.type === 'model', JSON.stringify(body.data[0]))
  check('display_name', typeof body.data[0]?.display_name === 'string')
  check('没有 object:list', body.object === undefined, String(body.object))
  check('has_more', body.has_more === false)

  const openai = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${firstKey}` } })
  const openaiBody = await openai.json()
  check('不带 anthropic 头仍是 OpenAI 形状', openaiBody.object === 'list', String(openaiBody.object))
}

console.log('\n== key 策略：dsh（默认）==')
{
  nextChunks = PLAIN
  const response = await keyPost('/v1/chat/completions', firstKey, {
    messages: [{ role: 'user', content: '你好' }],
  })
  const body = await response.json()
  check('200', response.status === 200, String(response.status))
  check('落到 dsh 默认', lastCall.options.provider === 'workbuddy' && lastCall.options.model === 'glm-5.3',
    `${lastCall.options.provider}/${lastCall.options.model}`)
  check('默认推理强度', lastCall.options.reasoningEffort === 'high', String(lastCall.options.reasoningEffort))
  check('文本', body.choices?.[0]?.message?.content === '你好，世界', JSON.stringify(body).slice(0, 200))
  check('思考', body.choices?.[0]?.message?.reasoning_content === '想一想…')
  check('usage', body.usage?.prompt_tokens === 11, JSON.stringify(body.usage))
}

console.log('\n== key 策略：session ==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'session' } })
  sessionSelectionValue = { provider: 'workbuddy-global', model: 'kimi-k3' }
  await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('跟随活跃会话', lastCall.options.provider === 'workbuddy-global' && lastCall.options.model === 'kimi-k3',
    `${lastCall.options.provider}/${lastCall.options.model}`)
  sessionSelectionValue = undefined
  await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('无会话时退到 dsh 默认', lastCall.options.provider === 'workbuddy' && lastCall.options.model === 'glm-5.3',
    `${lastCall.options.provider}/${lastCall.options.model}`)
}

console.log('\n== key 策略：named（固定模型）==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', {
    id,
    policy: { mode: 'named', provider: 'workbuddy-global', model: 'hy4-preview', reasoningEffort: 'low' },
  })
  await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('固定模型生效', lastCall.options.provider === 'workbuddy-global' && lastCall.options.model === 'hy4-preview',
    `${lastCall.options.provider}/${lastCall.options.model}`)
  check('固定推理强度', lastCall.options.reasoningEffort === 'low', String(lastCall.options.reasoningEffort))

  const unmet = await adminPost('/keys/update', { id, policy: { mode: 'named' } })
  check('没选模型也能存（只是不能用）', unmet.status === 200, String(unmet.status))
  const refused = await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('没选模型时 409', refused.status === 409, String(refused.status))
  const body = await refused.json()
  check('错误码', body.error?.code === 'model_not_configured', JSON.stringify(body))
}

console.log('\n== 请求显式给 model 覆盖策略 ==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'named', model: 'glm-5.3', provider: 'workbuddy' } })
  await keyPost('/v1/chat/completions', firstKey, { model: 'space-bunny', messages: [{ role: 'user', content: 'hi' }] })
  check('请求优先', lastCall.options.model === 'space-bunny', lastCall.options.model)
  check('provider 按目录归属', lastCall.options.provider === 'workbuddy', lastCall.options.provider)
}

console.log('\n== key 策略：first ==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'first' } })
  await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('目录第一个', lastCall.options.model === 'glm-5.3', lastCall.options.model)
}

console.log('\n== key 策略：account（缺账号时报错）==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  await adminPost('/keys/update', { id, policy: { mode: 'account', accountId: '', model: 'glm-5.3' } })
  const response = await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('409', response.status === 409, String(response.status))
  const body = await response.json()
  check('错误码', body.error?.code === 'account_not_configured', JSON.stringify(body))
}

console.log('\n== 两把 key 各走各的策略 ==')
{
  const state = await adminGet('/state')
  const firstId = state.body.keys[0].id
  await adminPost('/keys/update', { id: firstId, policy: { mode: 'named', model: 'glm-5.3', provider: 'workbuddy' } })
  const created = await adminPost('/keys', { label: 'second', policy: { mode: 'named', model: 'kimi-k3', provider: 'workbuddy-global' } })
  const secondKey = created.body.created.secret
  check('第二把 key 建好', typeof secondKey === 'string' && secondKey !== firstKey)

  await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('第一把走 glm-5.3', lastCall.options.model === 'glm-5.3', lastCall.options.model)
  await keyPost('/v1/chat/completions', secondKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('第二把走 kimi-k3', lastCall.options.model === 'kimi-k3', lastCall.options.model)
  check('provider 各自独立', lastCall.options.provider === 'workbuddy-global', lastCall.options.provider)

  const health = await fetch(`${API}/healthz`, { headers: { Authorization: `Bearer ${secondKey}` } })
  const healthBody = await health.json()
  check('healthz 报出本 key 的策略', healthBody.key?.policy?.model === 'kimi-k3', JSON.stringify(healthBody.key))
}

console.log('\n== 停用 key ==')
{
  const state = await adminGet('/state')
  const second = state.body.keys.find((entry) => entry.label === 'second')
  await adminPost('/keys/update', { id: second.id, enabled: false })
  const revealed = await adminPost('/keys/reveal', { id: second.id })
  const response = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${revealed.body.secret}` } })
  check('停用后 401', response.status === 401, String(response.status))
  await adminPost('/keys/update', { id: second.id, enabled: true })
  const again = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${revealed.body.secret}` } })
  check('重新启用后 200', again.status === 200, String(again.status))
}

console.log('\n== 重置 secret ==')
{
  const state = await adminGet('/state')
  const id = state.body.keys[0].id
  const before = (await adminPost('/keys/reveal', { id })).body.secret
  const rotated = await adminPost('/keys/rotate', { id })
  check('换了一把', typeof rotated.body.secret === 'string' && rotated.body.secret !== before)
  const old = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${before}` } })
  check('旧 secret 失效', old.status === 401, String(old.status))
  const fresh = await fetch(`${API}/v1/models`, { headers: { Authorization: `Bearer ${rotated.body.secret}` } })
  check('新 secret 可用', fresh.status === 200, String(fresh.status))
  /* 后面的用例都靠这把 key：把轮换后的值接上。 */
  firstKey = rotated.body.secret
}

console.log('\n== 删除 key ==')
{
  const state = await adminGet('/state')
  const count = state.body.keys.length
  const target = state.body.keys.find((entry) => entry.label === 'second')
  const deleted = await adminPost('/keys/delete', { id: target.id })
  check('200', deleted.status === 200, String(deleted.status))
  check('少了一把', deleted.body.keys.length === count - 1, String(deleted.body.keys.length))
  const missing = await adminPost('/keys/delete', { id: target.id })
  check('再删 404', missing.status === 404, String(missing.status))
}

console.log('\n== OpenAI Chat 流式 + 工具 ==')
{
  nextChunks = TOOLS
  const response = await keyPost('/v1/chat/completions', firstKey, {
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

console.log('\n== Anthropic ==')
{
  nextChunks = PLAIN
  const response = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ max_tokens: 256, system: '你是助手', messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] }),
  })
  const body = await response.json()
  check('200', response.status === 200, String(response.status))
  check('type', body.type === 'message')
  check('文本', body.content?.find((block) => block.type === 'text')?.text === '你好，世界', JSON.stringify(body.content))
  check('thinking', body.content?.find((block) => block.type === 'thinking')?.thinking === '想一想…')
  check('stop_reason', body.stop_reason === 'end_turn')
  check('system 抽出', lastCall.options.system === '你是助手')

  nextChunks = TOOLS
  const streamed = await fetch(`${API}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': firstKey },
    body: JSON.stringify({ max_tokens: 256, stream: true, messages: [{ role: 'user', content: '北京天气' }] }),
  })
  const text = await streamed.text()
  check('message_start', text.includes('event: message_start'))
  check('tool_use', text.includes('"tool_use"'))
  check('input_json_delta', text.includes('input_json_delta'))
  check('message_stop', text.includes('event: message_stop'))
}

console.log('\n== Gemini ==')
{
  nextChunks = PLAIN
  const plain = await fetch(`${API}/v1beta/models/-:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': firstKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: '你好' }] }],
      systemInstruction: { parts: [{ text: '你是助手' }] },
    }),
  })
  const body = await plain.json()
  check('200', plain.status === 200, String(plain.status))
  check('文本', body.candidates?.[0]?.content?.parts?.some((part) => part.text === '你好，世界'), JSON.stringify(body))
  check('finishReason', body.candidates?.[0]?.finishReason === 'STOP')

  nextChunks = TOOLS
  const streamed = await fetch(`${API}/v1beta/models/-:streamGenerateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': firstKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: '北京天气' }] }],
      tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] }],
    }),
  })
  const text = await streamed.text()
  check('200', streamed.status === 200, String(streamed.status))
  check('functionCall', text.includes('functionCall'), text.slice(0, 200))
}

console.log('\n== OpenAI Responses ==')
{
  nextChunks = PLAIN
  const plain = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({ instructions: '你是助手', input: '你好' }),
  })
  const body = await plain.json()
  check('200', plain.status === 200, String(plain.status))
  check('文本', body.output?.find((item) => item.type === 'message')?.content?.[0]?.text === '你好，世界', JSON.stringify(body.output))
  check('reasoning item', body.output?.some((item) => item.type === 'reasoning'))

  nextChunks = TOOLS
  const streamed = await fetch(`${API}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firstKey}` },
    body: JSON.stringify({
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '北京天气' }] }],
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
    }),
  })
  const text = await streamed.text()
  check('response.created', text.includes('event: response.created'))
  check('output_text.delta', text.includes('response.output_text.delta'))
  check('function_call', text.includes('"function_call"'))
  check('response.completed', text.includes('event: response.completed'))
}

console.log('\n== 图片输入 ==')
{
  nextChunks = PLAIN
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await keyPost('/v1/chat/completions', firstKey, {
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
  const response = await keyPost('/v1/chat/completions', firstKey, { messages: [{ role: 'user', content: 'hi' }] })
  check('402', response.status === 402, String(response.status))
  const body = await response.json()
  check('错误体', body.error?.message === 'quota exhausted', JSON.stringify(body))
}

console.log('\n== 管理接口边界 ==')
{
  const missing = await adminPost('/keys/update', { id: 'k_nope', policy: { mode: 'dsh' } })
  check('未知 key 404', missing.status === 404, String(missing.status))
  const route = await adminGet('/nope')
  check('未知管理路由 404', route.status === 404, String(route.status))
  const api404 = await fetch(`${API}/v1/nope`, { headers: { Authorization: `Bearer ${firstKey}` } })
  check('未知 API 路由 404', api404.status === 404, String(api404.status))
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
