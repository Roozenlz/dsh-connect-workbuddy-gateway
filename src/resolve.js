/**
 * 把一条请求翻译成一次真实调用。
 *
 * 策略来源只有一处：**请求所用 API key 的 `policy`**。模型名不再承载配置——
 * 调用方在请求体里写的 `model` 只被当作「这次想用哪个模型」，不是配置方式。
 *
 * 解析顺序（从强到弱）：
 *
 *   1. 请求体显式给了模型 → 就用它（客户端 SDK 的硬要求，无法禁止）；
 *      所在 provider 由这把 key 的策略或目录归属决定。
 *   2. 策略是 `named` / `account` → 用策略里钉的 provider / model / 账号。
 *   3. 其它策略（`dsh` / `session` / `current` / `first`）→ 现读对应来源。
 *
 * 无论走哪条，最终都落成 `{provider?, region?, accountId?, model, reasoningEffort?}`：
 * 有 `accountId` 就必须走直连通道，否则走宿主 adapter。
 */

import { defaultSelection, sessionSelection } from './selections.js'
import { regionOfAccount } from './accounts.js'

const KNOWN_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** provider 路由 → 区域。 */
export function regionOfProvider(provider) {
  if (typeof provider !== 'string') return undefined
  if (provider === 'workbuddy-global' || provider.startsWith('workbuddy-global')) return 'global'
  if (provider === 'workbuddy' || provider.startsWith('workbuddy')) return 'cn'
  return undefined
}

/** 区域 → 已注册的 provider 路由。 */
export function providerOfRegion(region, providers) {
  const wanted = region === 'global' ? 'workbuddy-global' : 'workbuddy'
  if (providers.includes(wanted)) return wanted
  return providers.find((provider) => regionOfProvider(provider) === region)
}

/**
 * 解析一次调用。
 *
 * @param ctx 宿主上下文
 * @param providers workbuddy 系 provider 路由
 * @param keyEntry 这条请求所用 API key 的配置（含 policy）
 * @param requestedModel 请求体里的 model（可能为空）
 * @param config 插件级配置（`enableGlobal` 等）
 * @param listModels 目录读取函数 `(ctx, provider) => Promise<LlmModelInfo[]>`
 * @returns `{provider?, region?, accountId?, model, reasoningEffort?, displayModel}`
 */
export async function resolveTarget(ctx, providers, keyEntry, requestedModel, config, listModels) {
  const policy = keyEntry?.policy ?? { mode: 'dsh' }
  const requested = typeof requestedModel === 'string' ? requestedModel.trim() : ''

  /*
   * 账号策略优先于一切：它决定了「谁付钱」，而模型可以另说。
   * 没给区域时按本机账号名册反查——绝不猜，也绝不两个区都试（那会拿别人的额度）。
   */
  if (policy.mode === 'account') {
    const accountId = typeof policy.accountId === 'string' ? policy.accountId.trim() : ''
    if (accountId === '') {
      throw badRequest('this API key is set to pin an account, but no account is chosen yet; pick one in Settings → WorkBuddy Gateway', 'account_not_configured')
    }
    const regions = config?.enableGlobal === false ? ['cn'] : ['cn', 'global']
    const region = policy.region ?? regionOfAccount(accountId, regions)
    if (region === undefined) {
      throw badRequest(`the account "${accountId}" pinned by this API key is not signed in on this machine`, 'account_not_found')
    }
    const model = requested !== '' ? requested : policy.model
    if (model === undefined || model === '') {
      throw badRequest('this API key pins an account but names no model; set one in Settings → WorkBuddy Gateway or send model in the request', 'model_not_configured')
    }
    return {
      region,
      accountId,
      provider: providerOfRegion(region, providers),
      model,
      reasoningEffort: effortOf(policy),
      displayModel: model,
    }
  }

  /* 请求显式给了模型：尊重它，只在目录里确认归属。 */
  if (requested !== '') {
    const provider = await providerOwning(ctx, providers, requested, policy, listModels)
    return {
      region: regionOfProvider(provider),
      provider,
      model: requested,
      reasoningEffort: effortOf(policy),
      displayModel: requested,
    }
  }

  /* 请求没给模型：完全由策略决定。 */
  if (policy.mode === 'named') {
    const model = typeof policy.model === 'string' ? policy.model.trim() : ''
    if (model === '') {
      throw badRequest('this API key is set to a fixed model, but none is chosen yet; pick one in Settings → WorkBuddy Gateway', 'model_not_configured')
    }
    const provider = await providerOwning(ctx, providers, model, policy, listModels)
    return {
      region: regionOfProvider(provider),
      provider,
      model,
      reasoningEffort: effortOf(policy),
      displayModel: model,
    }
  }

  const resolved = await resolveByMode(ctx, providers, policy, config, listModels)
  if (resolved === undefined) {
    throw badRequest(
      `this API key follows "${policy.mode}" but that source has no usable model right now; set a fixed model on this key, or pass model in the request`,
      'model_not_configured',
    )
  }
  return {
    region: regionOfProvider(resolved.provider),
    provider: resolved.provider,
    model: resolved.model,
    reasoningEffort: effortOf(policy) ?? resolved.reasoningEffort,
    displayModel: resolved.model,
  }
}

/** 按模式现读一个 `{provider, model}`。 */
async function resolveByMode(ctx, providers, policy, config, listModels) {
  const usable = (selection) => selection !== undefined && providers.includes(selection.provider)

  if (policy.mode === 'session') {
    const selection = sessionSelection(ctx)
    if (usable(selection)) return selection
  }
  if (policy.mode === 'current') {
    const live = sessionSelection(ctx)
    if (usable(live)) return live
    const preferred = defaultSelection(ctx)
    if (usable(preferred)) return preferred
  }
  if (policy.mode === 'dsh') {
    const selection = defaultSelection(ctx)
    if (usable(selection)) return selection
  }
  if (policy.mode === 'first') {
    for (const provider of providers) {
      const models = await listModels(ctx, provider)
      if (models.length > 0) return { provider, model: models[0].id }
    }
    return undefined
  }
  /*
   * 指定的来源读不到（例如没有活跃会话）时，退到 DSH 默认选择。
   * 这是 `dsh` 之外的三种模式共同的兜底：宁可给一个用户设过的默认，
   * 也不要因为「此刻没有会话」就报错。
   */
  if (policy.mode !== 'dsh') {
    const selection = defaultSelection(ctx)
    if (usable(selection)) return selection
    for (const provider of providers) {
      const models = await listModels(ctx, provider)
      if (models.length > 0) return { provider, model: models[0].id }
    }
  }
  return undefined
}

/**
 * 一个模型 id 该由哪个 provider 提供。
 *
 * 顺序：策略里钉的 provider（若模型属于它）→ 目录里第一个含这个 id 的 provider
 * → 策略的 provider → 第一个 provider。最后两项保证「用户写了个目录里没有的
 * 模型」时请求仍会发出去，由上游给出准确答复（UNKNOWN_MODEL），而不是在这里
 * 编一个 404。
 */
async function providerOwning(ctx, providers, model, policy, listModels) {
  const pinned = typeof policy?.provider === 'string' && providers.includes(policy.provider) ? policy.provider : undefined
  if (pinned !== undefined) {
    const models = await listModels(ctx, pinned)
    if (models.some((entry) => entry.id === model)) return pinned
  }
  for (const provider of providers) {
    const models = await listModels(ctx, provider)
    if (models.some((entry) => entry.id === model)) return provider
  }
  if (pinned !== undefined) return pinned
  if (providers.length > 0) return providers[0]
  throw badRequest('no workbuddy provider is registered; is dsh-connect-workbuddy installed and enabled?', 'no_provider')
}

function effortOf(policy) {
  const effort = policy?.reasoningEffort
  return typeof effort === 'string' && KNOWN_EFFORTS.has(effort) ? effort : undefined
}

function badRequest(message, code) {
  const error = new Error(message)
  error.status = code === 'model_not_configured' || code === 'account_not_configured' ? 409 : 404
  error.code = code
  return error
}

export { KNOWN_EFFORTS }
