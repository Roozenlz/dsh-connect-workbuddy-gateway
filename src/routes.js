/**
 * HTTP 路由与鉴权。
 *
 * 两类路由，前缀分开，互不打扰：
 *
 *   `/workbuddy-gateway/*`        对外 API（四种协议），靠 API key 鉴权
 *   `/plugins/dsh-connect-workbuddy-gateway/*`  设置页用的管理接口，靠 DSH 自己的 loopback 闸门
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
import {
  readConfig,
  writeConfig,
  makeKey,
  normalizeSelections,
  normalizeConfig,
  newSecret,
  maskSecret,
  configPath,
  activeDataDirPath,
  isDefaultDataDir,
  DEFAULT_DATA_DIR_NAME,
} from './config.js'
import { buildCatalog, safeSuffixOf } from './catalog.js'
import { allAccounts } from './accounts.js'
import { regionOfProvider, providerOfRegion } from './resolve.js'
import { describeEndpoints, stripApiPrefix } from './endpoints.js'
import { allPoolHealth, poolStateMtime } from './health.js'

const PREFIX = '/workbuddy-gateway'
const ADMIN_PREFIX = '/plugins/dsh-connect-workbuddy-gateway'

/**
 * 注册全部路由。
 * @param ctx 已注入 `webServer` 的上下文
 * @param env `{config, logger, providers}`；`providers` 每次请求现读
 * @returns 释放函数
 */
/**
 * 注册路由。
 *
 * **对外 API 直接挂在根路径上**（`/v1/chat/completions` 这种），因为那是所有
 * OpenAI / Anthropic / Gemini 客户端默认期待的形状 —— 让用户填一个带
 * `/workbuddy-gateway` 的 base 是没必要的负担，而且有些客户端根本不接受带路径
 * 前缀的 base URL。
 *
 * 但根路径不能整段接管：DSH 自己占着 `/api`、`/plugins` 以及前端静态资源。所以
 * 这里只精确匹配**协议自己的那几个路径**，不注册宽 prefix，避免和宿主抢请求。
 * 旧前缀 `/workbuddy-gateway` 保留为别名，已经填了它的客户端不会失效。
 *
 * @param ctx 已注入 `webServer` 的上下文
 * @param env `{config, logger, providers}`
 * @returns 释放函数
 */
export function registerRoutes(ctx, env) {
  const disposers = []
  /*
   * 两个入口：根路径（协议默认形状）与旧前缀（兼容）。
   *
   * 根路径用 `exact` 逐条注册而不是一个大 prefix —— 这样完全不会碰到 DSH 的
   * `/api`、`/plugins`、前端资源。`/v1beta/models/*:generateContent` 这种带冒号
   * 的动态路径没法用 exact 表达，所以给 `/v1beta` 与 `/v1/models/` 各注册一个
   * prefix，范围足够窄。
   */
  const API_ROOTS = [
    /* 协议端点：逐条精确。 */
    '/v1/chat/completions',
    '/v1/responses',
    '/v1/messages',
    '/v1/messages/count_tokens',
    '/v1/models',
    '/v1/accounts',
    '/v1/models/list',
    /* Gemini 的模型动作带冒号，只能用前缀。 */
    { prefix: '/v1beta' },
    /* 兼容：老 base URL 带 /workbuddy-gateway。 */
    { prefix: PREFIX },
  ]

  for (const entry of API_ROOTS) {
    const route = typeof entry === 'string'
      ? { kind: 'exact', path: entry }
      : { kind: 'prefix', path: entry.prefix }
    disposers.push(ctx.webServer.register({
      ...route,
      handler: (req, res) => {
        void dispatchApi(req, res, ctx, env)
      },
    }))
  }

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
  const path = normalizeApiPath(url.pathname)
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
    if (method === 'POST' && path === '/config/data-dir') {
      /*
       * 改配置目录。
       *
       * **不能只写进 keys.json** —— 那个文件就在被指向的目录里，改它等于让一个新
       * 文件去描述「以后该读哪个文件」，自相矛盾。所以这项写进插件配置
       * （`cordis.patch.yml` 的那一行），由 settings 服务落盘，插件下次激活时
       * `apply` 读到的就是新值。
       *
       * 这里只做校验与说明，真正的写入交给宿主。
       */
      const body = await readJsonBody(req)
      const requested = typeof body?.dataDir === 'string' ? body.dataDir.trim() : ''

      /* 相对路径要能被解析成绝对路径，否则运行时会拼出一个诡异位置。 */
      if (requested !== '' && !isResolvablePath(requested)) {
        sendJson(res, 400, { error: `"${requested}" is not a usable directory path` })
        return
      }

      const settings = ctx.get('settings')
      if (settings === undefined) {
        sendJson(res, 503, { error: 'this profile cannot save plugin configuration' })
        return
      }
      /*
       * 找到能落盘这条配置的地方。
       *
       * 两条路都试，顺序有讲究：
       *
       *   1. `configEditor.edit(entry, ...)` —— 本插件最该用的那条。它认得这一行，
       *      保留 patch 里其它内容与注释，并且会重启插件让改动生效。
       *   2. `settings.update(ns, ...)` —— 只在插件注册了设置页时可用。本插件
       *      **没有**注册（`describe()` 里找不到它），所以这条基本走不通，保留是为了
       *      将来加了设置页时自动能用上。
       *
       * 都不行就如实报错，让用户去改 patch —— 绝不自己去重写 cordis.patch.yml，
       * 那个文件属于用户，里面有别人的行和注释。
       */
      const ownEntry = ctx.fiber?.entry
      const editor = ctx.get('configEditor')
      if (ownEntry !== undefined && editor?.edit !== undefined) {
        try {
          await editor.edit(ownEntry, (current) => ({ ...current, dataDir: requested }))
          sendJson(res, 200, { ok: true, requested, via: 'configEditor' })
          return
        } catch (error) {
          sendJson(res, 500, {
            error: `could not save dataDir: ${error instanceof Error ? error.message : String(error)}`,
            via: 'configEditor',
          })
          return
        }
      }

      const configService = ctx.get('settings')
      if (configService === undefined) {
        sendJson(res, 503, { error: 'this profile cannot save plugin configuration; set dataDir in the profile patch instead' })
        return
      }
      const ns = resolveSettingsNs(configService, env, PACKAGE_NAME)
      if (ns === undefined) {
        sendJson(res, 503, {
          error: 'this plugin is not registered as a configurable entry in this profile; set dataDir in the profile patch by hand',
          entryId: env.entryId ?? null,
        })
        return
      }
      try {
        await configService.update(ns, { dataDir: requested })
      } catch (error) {
        sendJson(res, 500, { error: `could not save: ${error instanceof Error ? error.message : String(error)}` })
        return
      }

      /*
       * 如实告诉用户发生了什么：新目录**不会**自动继承旧 key。与其让他下次打开
       * 设置页发现 key 全空，不如现在就说。
       */
      const nextDir = requested === '' ? null : requested
      sendJson(res, 200, {
        ok: true,
        requested,
        note: 'the plugin reloads to apply this; keys in the previous directory are not copied over',
        ...(nextDir === null ? {} : { pendingDataDir: nextDir }),
      })
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

/**
 * 设置页需要的一次性快照：可选模型全表、账号（含可用性）、key 表、协议地址。
 *
 * **可用性是活的**：每次读 `/state` 都重新读上游插件的池状态，所以账号被限流后
 * 刷新设置页就能看到它变灰、并且不再出现在可勾选列表里。用户要的是「跟上游保持
 * 同步」，而不是一份启动时拍下来的快照。
 */
async function adminState(ctx, env) {
  const config = readConfig()
  const origin = originOf(ctx)
  const accounts = publicAccounts(env)
  const regions = env.config.enableGlobal === false ? ['cn'] : ['cn', 'global']
  const health = allPoolHealth(regions)

  /* 只把「上游判定现在可用」的账号算进候选；不可用的单独列出供说明。 */
  const usable = accounts.filter((account) => health.get(account.id)?.available !== false)
  const unavailable = accounts
    .filter((account) => health.get(account.id)?.available === false)
    .map((account) => {
      const state = health.get(account.id)
      return {
        id: account.id,
        name: account.name,
        region: account.region,
        outcome: state?.outcome ?? 'unknown',
        reason: state?.reason ?? '',
        ...(state?.retryAtMs === undefined ? {} : { retryAtMs: state.retryAtMs }),
      }
    })

  /* 勾选界面的候选：全量目录 × 每个**可用**账号。 */
  const available = await catalogForSettings(env, accounts, usable)

  return {
    origin,
    /* 根地址就是 DSH 自己的地址，不带自定义前缀。 */
    baseUrl: origin,
    endpoints: describeEndpoints(origin).endpoints,
    paths: configPathOf(env),
    providers: env.providers().map((provider) => ({
      id: provider,
      region: regionOfProvider(provider) ?? null,
      label: regionOfProvider(provider) === 'global' ? 'WorkBuddy 国际版' : 'WorkBuddy 国内版',
    })),
    accounts: accounts.map((account) => {
      const state = health.get(account.id)
      return {
        region: account.region,
        id: account.id,
        name: account.name === '' ? account.id.slice(0, 8) : account.name,
        enterprise: account.enterprise,
        safeSuffix: account.safeSuffix,
        available: state?.available !== false,
        ...(state?.outcome === undefined ? {} : { outcome: state.outcome }),
        ...(state?.reason === undefined ? {} : { reason: state.reason }),
        ...(state?.retryAtMs === undefined ? {} : { retryAtMs: state.retryAtMs }),
      }
    }),
    unavailableAccounts: unavailable,
    available,
    keys: publicKeys(config, env),
    health: {
      stateFileMtime: poolStateMtime(regions),
      usableAccounts: usable.length,
      unavailableAccounts: unavailable.length,
    },
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

/**
 * 把请求路径归一到「协议路由」那一层。
 *
 * 两个入口的路径不同（根 `/v1/chat/completions` 与旧前缀
 * `/workbuddy-gateway/v1/chat/completions`），归一到同一套路由表之后，下面的
 * 分发逻辑只写一份。
 *
 * @param pathname 原始 pathname
 */
function normalizeApiPath(pathname) {
  let path = pathname
  /* 旧前缀先剥掉。 */
  if (path === PREFIX) path = '/'
  else if (path.startsWith(`${PREFIX}/`)) path = path.slice(PREFIX.length)
  if (path === '') path = '/'
  if (!path.startsWith('/')) path = `/${path}`
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** 对外路径去前缀（管理接口用）。 */
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

/**
 * 设置页展示用的路径信息。
 *
 * 同时给出三样东西，因为用户问的是不同的问题：
 *   - `configPath`：实际读写的那个文件（最长的那串）
 *   - `dataDir`：它所在的目录（可自定义的那一项）
 *   - `dataDirIsDefault`：这个目录是不是「跟随默认」——是的话界面显示默认名，
 *     而不是把一长串绝对路径当成用户输入回填到输入框里
 */
function configPathOf(env) {
  return {
    configPath: configPath(),
    dataDir: activeDataDirPath(),
    dataDirIsDefault: isDefaultDataDir(env?.config?.dataDir),
    defaultDataDirName: DEFAULT_DATA_DIR_NAME,
  }
}

/**
 * 定位本插件在 settings 服务里的命名空间。
 *
 * 候选顺序：env 里读到的条目 id → 该 id 加 `include:` 前缀 → 按包名在
 * describe() 里反查。**每个候选都要在 describe() 的输出里真实存在才采用** ——
 * `settings.update` 对不存在的 ns 会抛错，而写错条目比报错更糟。
 *
 * @returns 可用的 ns，或 undefined
 */
function resolveSettingsNs(settings, env, packageName) {
  let descriptors
  try {
    descriptors = settings.describe?.() ?? []
  } catch {
    return undefined
  }
  const known = new Set(
    (Array.isArray(descriptors) ? descriptors : [])
      .map((descriptor) => descriptor?.ns)
      .filter((ns) => typeof ns === 'string'),
  )
  if (known.size === 0) return undefined

  const candidates = []
  if (typeof env?.entryId === 'string' && env.entryId !== '') {
    candidates.push(env.entryId)
    candidates.push(`include:${env.entryId}`)
  }
  /* 按包名/条目名反查：`include:dsh-connect-workbuddy-gateway` 这类。 */
  for (const ns of known) {
    if (ns === packageName || ns.includes(packageName)) candidates.push(ns)
  }
  /* 最后按本插件条目 id 的常见拼法兜底。 */
  for (const ns of known) {
    if (/workbuddy-gateway/u.test(ns)) candidates.push(ns)
  }

  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate
  }
  return undefined
}

/** 本插件的包名，用于在 settings 目录里认出自己那一行。 */
const PACKAGE_NAME = 'dsh-connect-workbuddy-gateway'

/** 跨平台的「这是个可用路径」判断（不含盘符以外的怪字符）。 */
function isResolvablePath(value) {
  if (value === '') return false
  /* Windows 不允许这些字符出现在路径里；POSIX 只禁 NUL。 */
  if (/[\u0000<>"|?*]/u.test(value)) return false
  return true
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
