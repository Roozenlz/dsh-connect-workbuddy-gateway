/**
 * 直连后端：复用 dsh-connect-workbuddy 自己的请求栈，但由网关点名账号。
 *
 * 为什么不直接打上游：插件已经把「怎么发」做对了（渠道指纹、错误分类、换号
 * 与冷却、凭据刷新与加密凭据兜底）。这里只组装它导出的那几件，然后通过它自己的
 * loopback shim 发请求——于是上游协议只有一份实现，账号选择权则留在网关手里。
 *
 * 插件包不在这个 profile 里时，整个直连后端降级，宿主后端照常工作。
 */

import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const packed = new Map()
let moduleCache
let moduleFailure

/**
 * 入口候选：裸名优先，再试 profile 目录里的绝对路径。
 *
 * 本插件是「工作区目录链接安装」的，它自己的 ESM 图里没有 profile 的
 * `node_modules`，所以裸名解析不到已安装的 workbuddy 插件。但入口一旦用绝对
 * 路径拿到，它内部那些 `@deepseek-ai/*` / pi-ai 依赖仍由宿主的运行时拦截层解析
 * ——那一条与插件本体在宿主里被加载时完全相同。
 */
function entryCandidates() {
  const out = ['dsh-connect-workbuddy']
  for (const profileDir of profileDirs()) {
    out.push(pathToFileURL(join(profileDir, 'node_modules', 'dsh-connect-workbuddy', 'lib', 'index.js')).href)
  }
  return [...new Set(out)]
}

/** 可能的 profile 目录：`$DSH_PROFILE_DIR` 优先，其次扫 `$DSH_HOME/profiles/*`。 */
function profileDirs() {
  const out = []
  const configured = process.env.DSH_PROFILE_DIR
  if (typeof configured === 'string' && configured !== '') out.push(configured)
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
  try {
    for (const name of readdirSync(join(base, 'profiles'))) {
      out.push(join(base, 'profiles', name))
    }
  } catch {
    /* 没有 profiles 目录就只靠上面那个 */
  }
  return [...new Set(out)]
}

/** 取插件导出；不可用时返回 undefined。 */
export async function loadPlugin() {
  if (moduleCache !== undefined) return moduleCache
  if (moduleFailure !== undefined) return undefined
  const failures = []
  for (const specifier of entryCandidates()) {
    try {
      moduleCache = await import(specifier)
      return moduleCache
    } catch (error) {
      failures.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  moduleFailure = new Error(failures.join(' | '))
  return undefined
}

/** 直连后端是否可用。 */
export async function directAvailable() {
  const module = await loadPlugin()
  return module !== undefined
    && typeof module.createWorkBuddyShim === 'function'
    && typeof module.WorkBuddyCredentialStore === 'function'
    && typeof module.WorkBuddyUpstreamClient === 'function'
    && typeof module.WorkBuddyCatalog === 'function'
}

/**
 * 取某区域的直连栈，首次调用时创建并起 shim。
 * @param region `cn` | `global`
 * @param logger 宿主 logger
 */
async function stackFor(region, logger) {
  const existing = packed.get(region)
  if (existing !== undefined) return existing
  const module = await loadPlugin()
  if (module === undefined) {
    const error = new Error('dsh-connect-workbuddy is not installed in this profile, so account-pinned routing is unavailable')
    error.status = 400
    error.code = 'unsupported_account'
    throw error
  }
  const client = new module.WorkBuddyUpstreamClient((message) => logger?.warn(`workbuddy-gateway: ${message}`))
  const store = new module.WorkBuddyCredentialStore({
    region,
    refresh: (credential) => client.refreshToken(credential),
  })
  const catalog = new module.WorkBuddyCatalog(region)
  const shim = module.createWorkBuddyShim({ store, client, catalog, logger })
  const stack = { module, client, store, catalog, shim }
  packed.set(region, stack)
  await shim.ready
  return stack
}

/** 某区域本地可用的账号列表（不含 token）。 */
export async function directAccounts(region, logger) {
  const probe = await directDiagnostic(region, logger)
  if (!probe.ok) return []
  try {
    const stack = await stackFor(region, logger)
    return await stack.store.accounts()
  } catch {
    return []
  }
}

/**
 * 直连通道的自检。
 *
 * 「账号列表为空」有两种完全不同的原因：本机真没登录，或这个包在宿主里加载
 * 失败（缺 peer 依赖）。静默返回空数组会让用户以为「没账号」，所以这里把原因
 * 带出来，`/v1/accounts` 直接给用户看。
 *
 * @returns `{ok, reason?}`，reason 是可读的失败说明
 */
export async function directDiagnostic(region, logger) {
  const module = await loadPlugin()
  if (module === undefined) {
    return { ok: false, reason: `dsh-connect-workbuddy could not be loaded: ${describeModuleFailure()}` }
  }
  try {
    const stack = await stackFor(region, logger)
    const accounts = await stack.store.accounts()
    if (accounts.length === 0) {
      return { ok: false, reason: `no signed-in WorkBuddy account is visible to region "${region}"` }
    }
    return { ok: true, accounts: accounts.length }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function describeModuleFailure() {
  if (moduleFailure === undefined) return 'unknown reason'
  return moduleFailure instanceof Error ? moduleFailure.message : String(moduleFailure)
}

/** 关闭全部 shim。插件卸载时调用。 */
export async function closeDirect() {
  const all = [...packed.values()]
  packed.clear()
  await Promise.all(all.map((stack) => stack.shim.close().catch(() => {})))
}

/**
 * 发一次 OpenAI Chat 形状的请求。
 *
 * @param region 区域
 * @param accountId 账号 id；undefined 表示跟随 App 当前登录
 * @param body 上游请求体（OpenAI Chat 形状）
 * @param signal 取消信号
 * @param logger 宿主 logger
 * @returns 上游 `Response`（成功时是 SSE 流）
 */
export async function directFetch(region, accountId, body, signal, logger) {
  const stack = await stackFor(region, logger)
  stack.store.selectAccount(accountId)
  return fetch(`${stack.shim.baseUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${stack.shim.token()}`,
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
}

/** 直连通道读一次上游模型目录（失败返回空数组）。 */
export async function directCatalog(region, logger) {
  if (!await directAvailable()) return []
  try {
    const stack = await stackFor(region, logger)
    const credential = await stack.store.resolve()
    const read = await stack.client.fetchModels(credential)
    return read.models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      creditMultiplier: model.creditMultiplier,
      reasoning: model.reasoning,
    }))
  } catch {
    return []
  }
}
