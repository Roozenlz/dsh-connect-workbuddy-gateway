/**
 * HTTP 路由与鉴权。
 *
 * 两类路由，前缀分开，互不打扰：
 *
 *   `/workbuddy-gateway/*`        对外 API（四种协议），靠 API key 鉴权
 *   `/plugins/dsh-workbuddy-gateway/*`  设置页用的管理接口，靠 DSH 自己的 loopback 闸门
 *
 * 对外 API 用 `kind:'prefix'` 的 node 原生 handler（`(req,res)`）而不是 `resource`
 * 形式：SSE 必须边收边写，`resource` 要求先把完整 `Response` 攒出来，等于把流式
 * 变成一次性缓冲。
 *
 * 鉴权收四个位置（各 SDK 各用一种）：`Authorization: Bearer`、`x-api-key`、
 * `x-goog-api-key`、`?key=`。比对的是设置页里那些 key 的 secret。
 */

import { sendJson, failureOf } from './util.js'
import { handleChat } from './openai-chat.js'
import { handleResponses } from './openai-responses.js'
import { handleMessages } from './anthropic.js'
import { handleGenerate, parseGeminiPath, geminiCatalog } from './gemini.js'
import { collectModels, directModelsByRegion, openAiCatalog, anthropicCatalog, catalogForSettings } from './models.js'
import { readConfig, writeConfig, makeKey, normalizeSelections, normalizeConfig, newSecret, maskSecret } from './config.js'
import { buildCatalog, safeSuffixOf } from './catalog.js'
import { allAccounts } from './accounts.js'
import { regionOfProvider, providerOfRegion } from './resolve.js'
import { describeEndpoints, stripApiPrefix } from './endpoints.js'

const PREFIX = '/workbuddy-gateway'
const ADMIN_PREFIX = '/plugins/dsh-workbuddy-gateway'

/**
 * 注册全部路由。
 * @param ctx 已注入 `webServer` 的上下文
 * @param env `{config, logger, providers}`；`providers` 每次请求现读
 * @returns 释放函数
 */
export function registerRoutes(ctx, env) {
  const disposers = []
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => {
      void dispatchApi(req, res, ctx, env)
    },
  }))
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: ADMIN_PREFIX,
    handler: (req, res) => {
      void dispatchAdmin(req, res, ctx, env)
    },
  }))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/* ── 对外 API ─────────────────────────────────────────────────────────── */

async function dispatchApi(req, res, ctx, env) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = normalizePath(url.pathname, PREFIX)
  const method = req.method ?? 'GET'

  const keyEntry = authenticate(req.headers, url)
  if (keyEntry === undefined) {
    sendJson(res, 401, {
      error: {
        message: 'invalid gateway api key: copy the key’s secret with the Copy button in Settings → WorkBuddy 模型网关 (masked values ending in … are not usable)',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    })
    return
  }

  const scoped = { ...env, key: keyEntry }
  /*
   * `/v1`、`/anthropic`、`/openai` 三个前缀只是方便客户端填写，语义与根路径
   * 相同；归一到路由表那一层，下面只写一套。
   */
  const route = stripApiPrefix(path)
  /*
   * 模型列表有两个语义相同的入口，但**响应体形状必须按客户端来**：
   * Anthropic SDK 请求 `/v1/models` 时期待 `{data:[{type,id,display_name,…}]}`，
   * 给它 OpenAI 的 `{object:'list',data:[…]}` 会被判成"响应格式不兼容"。
   *
   * 判据是「请求里带没带 anthropic-version」——那是 Anthropic SDK 的固定行为，
   * 也是三家鉴权头里唯一能区分调用方的信号。没带就当 OpenAI 处理。
   */
  const wantsAnthropicShape = typeof req.headers['anthropic-version'] === 'string'
  try {
    if (route === '/healthz' || route === '/') {
      const info = describeEndpoints(originOf(ctx))
      sendJson(res, 200, {
        ok: true,
        root: info.root,
        endpoints: info.endpoints.map((entry) => ({ id: entry.id, name: entry.name, baseUrl: entry.baseUrl })),
        key: { id: keyEntry.id, label: keyEntry.label, models: keyCatalog(keyEntry, env).map((entry) => entry.name) },
        protocols: info.endpoints.map((entry) => entry.id),
      })
      return
    }
    if (method === 'GET' && route === '/models') {
      /*
       * 只返回这把 key 勾选的模型 —— 用户的勾选就是唯一的事实来源。
       * 重名项的名字已经带上账号后缀（见 src/catalog.js）。
       *
       * 先补一次选：客户端常常比设置页更早被打开，那时默认 key 还没勾过任何
       * 模型，列表会是空的 —— 对用户来说就是「网关没起来」。
       */
      await env.ensureSeeded?.()
      const fresh = authenticate(req.headers, url) ?? keyEntry
      const catalog = keyCatalog(fresh, env)
      sendJson(res, 200, wantsAnthropicShape ? anthropicCatalog(catalog) : openAiCatalog(catalog))
      return
    }
    if (method === 'GET' && route === '/accounts') {
      sendJson(res, 200, { accounts: publicAccounts(env) })
      return
    }
    if (method === 'GET' && (route === '/v1beta/models' || route === '/models/gemini')) {
      const catalog = keyCatalog(keyEntry, env)
      sendJson(res, 200, geminiCatalog(catalog.map((entry) => ({
        id: entry.name,
        name: entry.displayName === '' ? entry.name : entry.displayName,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxTokens,
        reasoningEfforts: entry.reasoningEfforts,
      }))))
      return
    }
    if (method === 'POST' && route === '/chat/completions') {
      await handleChat(req, res, scoped)
      return
    }
    if (method === 'POST' && route === '/responses') {
      await handleResponses(req, res, scoped)
      return
    }
    if (method === 'POST' && route === '/messages') {
      await handleMessages(req, res, scoped)
      return
    }
    if (method === 'POST' && route === '/messages/count_tokens') {
      sendJson(res, 200, { input_tokens: 0 })
      return
    }
    const gemini = parseGeminiPath(path)
    if (method === 'POST' && gemini !== undefined) {
      await handleGenerate(req, res, scoped, gemini)
      return
    }
    sendJson(res, 404, {
      error: { message: `no such route: ${method} ${path}`, type: 'invalid_request_error', code: 'not_found' },
    })
  } catch (error) {
    const failure = failureOf(error)
    if (!res.headersSent) {
      sendJson(res, failure.status, { error: { message: failure.message, type: failure.code, code: failure.code } })
      return
    }
    res.end()
  }
}

/* ── 管理接口（设置页用） ─────────────────────────────────────────────── */

async function dispatchAdmin(req, res, ctx, env) {
  if (!loopbackOnly(req)) {
    sendJson(res, 403, { error: 'the gateway admin routes only accept loopback requests' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = normalizePath(url.pathname, ADMIN_PREFIX)
  const method = req.method ?? 'GET'
  try {
    if (method === 'GET' && path === '/state') {
      /* 设置页打开是最可靠的「provider 肯定就绪」时机：顺手补选。 */
      await env.ensureSeeded?.()
      sendJson(res, 200, await adminState(ctx, env))
      return
    }
    if (method === 'POST' && path === '/state/reseed') {
      /*
       * 用户主动要求「把某把 key 填满」时用。清掉 seeded 标记再跑一次，
       * 于是 ensureSeeded 会认它。
       */
      const body = await readJsonBody(req)
      const config = readConfig()
      const target = config.keys.find((entry) => entry.id === body?.id)
      if (target === undefined) {
        sendJson(res, 404, { error: `no such key: ${String(body?.id)}` })
        return
      }
      delete target.seeded
      target.selections = []
      writeConfig(config)
      await env.ensureSeeded?.()
      sendJson(res, 200, { keys: publicKeys(readConfig(), env) })
      return
    }
    if (method === 'POST' && path === '/keys') {
      const body = await readJsonBody(req)
      const config = readConfig()
      const entry = makeKey({
        label: typeof body?.label === 'string' ? body.label : '',
        selections: body?.selections,
      })
      config.keys.push(entry)
      writeConfig(config)
      sendJson(res, 200, { keys: publicKeys(config, env), created: { id: entry.id, secret: entry.secret } })
      return
    }
    if (method === 'POST' && path === '/keys/update') {
      const body = await readJsonBody(req)
      const config = readConfig()
      const target = config.keys.find((entry) => entry.id === body?.id)
      if (target === undefined) {
        sendJson(res, 404, { error: `no such key: ${String(body?.id)}` })
        return
      }
      if (typeof body.label === 'string') target.label = body.label.slice(0, 80)
      if (typeof body.enabled === 'boolean') target.enabled = body.enabled
      if (body.selections !== undefined) target.selections = normalizeSelections(body.selections)
      writeConfig(config)
      sendJson(res, 200, { keys: publicKeys(config, env) })
      return
    }
    if (method === 'POST' && path === '/keys/delete') {
      const body = await readJsonBody(req)
      const config = readConfig()
      const before = config.keys.length
      config.keys = config.keys.filter((entry) => entry.id !== body?.id)
      if (config.keys.length === before) {
        sendJson(res, 404, { error: `no such key: ${String(body?.id)}` })
        return
      }
      writeConfig(config)
      sendJson(res, 200, { keys: publicKeys(config, env) })
      return
    }
    if (method === 'POST' && path === '/keys/reveal') {
      const body = await readJsonBody(req)
      const config = readConfig()
      const target = config.keys.find((entry) => entry.id === body?.id)
      if (target === undefined) {
        sendJson(res, 404, { error: `no such key: ${String(body?.id)}` })
        return
      }
      sendJson(res, 200, { id: target.id, secret: target.secret })
      return
    }
    if (method === 'POST' && path === '/keys/rotate') {
      const body = await readJsonBody(req)
      const config = readConfig()
      const target = config.keys.find((entry) => entry.id === body?.id)
      if (target === undefined) {
        sendJson(res, 404, { error: `no such key: ${String(body?.id)}` })
        return
      }
      target.secret = newSecret()
      writeConfig(config)
      sendJson(res, 200, { keys: publicKeys(config, env), secret: target.secret })
      return
    }
    if (method === 'POST' && path === '/config/reset') {
      const config = readConfig()
      if (config.keys.length === 0) {
        const entry = makeKey({ label: 'default' })
        /* 首次建 key 时把所有可见模型都勾上，用户拿到的 key 立刻能用。 */
        entry.selections = normalizeSelections(await catalogForSettings(env))
        config.keys.push(entry)
        writeConfig(config)
      }
      sendJson(res, 200, { keys: publicKeys(config, env) })
      return
    }
    sendJson(res, 404, { error: `no such admin route: ${method} ${path}` })
  } catch (error) {
    const failure = failureOf(error)
    sendJson(res, failure.status, { error: failure.message, code: failure.code })
  }
}

/** 设置页需要的一次性快照：可选模型全表、账号、key 表、四种协议的准确地址。 */
async function adminState(ctx, env) {
  const config = readConfig()
  const origin = originOf(ctx)
  const accounts = publicAccounts(env)
  /* 勾选界面的候选：全量目录 × 每个账号，用户从中挑。 */
  const available = await catalogForSettings(env, accounts)
  return {
    origin,
    baseUrl: `${origin}${PREFIX}`,
    endpoints: describeEndpoints(origin).endpoints,
    configPath: configPathOf(),
    providers: env.providers().map((provider) => ({
      id: provider,
      region: regionOfProvider(provider) ?? null,
      label: regionOfProvider(provider) === 'global' ? 'WorkBuddy 国际版' : 'WorkBuddy 国内版',
    })),
    accounts: accounts.map((account) => ({
      region: account.region,
      id: account.id,
      name: account.name === '' ? account.id.slice(0, 8) : account.name,
      enterprise: account.enterprise,
      safeSuffix: account.safeSuffix,
    })),
    available,
    keys: publicKeys(config, env),
    defaults: {
      dsh: describeSelection(defaultSelectionOf(ctx)),
      session: describeSelection(sessionSelectionOf(ctx)),
    },
  }
}

/**
 * key 表对外投影：secret 默认打码，只有 reveal / rotate 才回明文。
 *
 * 同时给出 `catalog`：这把 key 实际会暴露给客户端的模型名（含重名后缀）。
 * 设置页据此显示「用户会看到哪些名字」，用户不必自己推算后缀规则。
 */
function publicKeys(config, env) {
  const accounts = env === undefined ? [] : publicAccounts(env)
  return config.keys.map((entry) => ({
    id: entry.id,
    label: entry.label,
    masked: maskSecret(entry.secret),
    enabled: entry.enabled,
    createdAt: entry.createdAt,
    selections: entry.selections,
    catalog: buildCatalog(entry.selections ?? [], accounts).map((model) => ({
      name: model.name,
      modelId: model.modelId,
      displayName: model.displayName,
      region: model.region ?? null,
      accountId: model.accountId,
      reasoningEfforts: model.reasoningEfforts,
    })),
  }))
}

/** 对外路径去前缀。 */
function normalizePath(pathname, prefix) {
  let path = pathname
  if (path.startsWith(prefix)) path = path.slice(prefix.length)
  if (path === '') path = '/'
  if (!path.startsWith('/')) path = `/${path}`
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/* ── 鉴权 ─────────────────────────────────────────────────────────────── */

/**
 * 按请求头找对应的 key。
 *
 * 关闭鉴权的写法是「表里放一把 `enabled:false` 的全通 key」——不，这里不提供
 * 关鉴权：网关监听的是 DSH 的 loopback 端口，而 DSH 自己可以 `--trusted-host`
 * 暴露到局域网。少一个开关，少一个「忘了开」的洞。
 *
 * @returns key 条目，或 undefined（未授权 / 已停用）
 */
export function authenticate(headers, url) {
  const config = readConfig()
  if (config.keys.length === 0) return undefined
  const presented = [
    bearerOf(headers.authorization),
    headerValue(headers['x-api-key']),
    headerValue(headers['api-key']),
    headerValue(headers['x-goog-api-key']),
    url.searchParams.get('key'),
    url.searchParams.get('api_key'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  if (presented.length === 0) return undefined
  for (const candidate of presented) {
    const hit = config.keys.find((entry) => entry.enabled && entry.secret === candidate)
    if (hit !== undefined) return hit
  }
  return undefined
}

function bearerOf(header) {
  if (typeof header !== 'string') return undefined
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
}

function headerValue(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

/** 管理接口只接受 loopback（与 dsh-connect-workbuddy 的卡片路由同一条边界）。 */
function loopbackOnly(req) {
  const remote = req.socket?.remoteAddress ?? ''
  if (remote !== '' && !isLoopbackAddress(remote)) return false
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  if (host === '') return true
  const bare = host.replace(/:\d+$/u, '').replace(/^\[|\]$/gu, '')
  return bare === 'localhost' || isLoopbackAddress(bare)
}

function isLoopbackAddress(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1' || value.startsWith('127.')
}

/* ── 杂项 ─────────────────────────────────────────────────────────────── */

/** 某个 key 的模型清单（勾选 → 客户端看到的模型）。 */
function keyCatalog(keyEntry, env) {
  return buildCatalog(keyEntry.selections ?? [], publicAccounts(env))
}

/** 本机账号表（不含 token），供清单解析与设置页共用。 */
function publicAccounts(env) {
  const regions = env.config.enableGlobal === false ? ['cn'] : ['cn', 'global']
  return allAccounts(regions).map((account) => ({
    region: account.region,
    id: account.id,
    name: account.name,
    enterprise: account.enterprise,
    safeSuffix: safeSuffixOf(account.name) ?? null,
    ...(account.expiresAtMs === undefined ? {} : { expiresAtMs: account.expiresAtMs }),
  }))
}

async function catalogEntries(env) {
  const host = await collectModels(env)
  const entries = host.length > 0 ? host : await directModelsByRegion(env)
  if (env.config.enableGlobal !== false) return entries
  return entries.filter((entry) => entry.region !== 'global')
}

/** 本机 origin（不含网关前缀），设置页据此拼出四种协议的地址。 */
export function originOf(ctx) {
  try {
    return ctx.webServer.getOrigin()
  } catch {
    return 'http://127.0.0.1:0'
  }
}

/** 不带协议后缀的基址，保留给需要「一条根地址」的场景。 */
export function baseUrlOf(ctx) {
  return `${originOf(ctx)}${PREFIX}`
}

function configPathOf() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : null
  return base === null ? 'keys.json under the DSH home' : `${base}\\workbuddy-gateway\\keys.json`
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

/* ── 供 adminState 用的两个「当前默认」快照 ───────────────────────────── */

function defaultSelectionOf(ctx) {
  return ctx.get('agentDefaultModel')?.currentSelection?.()
}

function sessionSelectionOf(ctx) {
  const agents = ctx.get('agents')
  const live = agents?.list?.() ?? []
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const header = live[index]?.session?.requestHeader?.()
    if (header?.config?.provider !== undefined) return header.config
  }
  return undefined
}

function describeSelection(selection) {
  if (selection === undefined || selection === null) return null
  return { provider: selection.provider, model: selection.model }
}

export { PREFIX, ADMIN_PREFIX, normalizeConfig }
