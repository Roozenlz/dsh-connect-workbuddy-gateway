/**
 * 把一条请求翻译成一次真实调用。
 *
 * **这里没有「策略」了。** 唯一的信息来源是：这个 key 勾选了哪些 `(账号, 模型)`
 * 组合，以及客户端这次请求了清单里的哪个名字。
 *
 * 解析顺序：
 *   1. 请求里的 `model` 命中清单 → 用那一条（含它的账号与区域）；
 *   2. 没命中但清单里只有一项 → 用那一项（客户端没填 model 时很常见）；
 *   3. 都没有 → 报错，并明确告诉调用方这把 key 能选什么。
 *
 * 账号为 `''` 的条目走宿主通道（插件自己的账号选择与账号池生效）；
 * 非空则走直连通道，点名那个账号。
 */

import { buildCatalog, lookupModel } from './catalog.js'

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
 * @param providers workbuddy 系 provider 路由
 * @param keyEntry 这条请求所用 API key 的配置（含 `selections`）
 * @param accounts 本机账号表（取昵称与区域）
 * @param requestedModel 请求体里的 model（可能为空）
 * @returns `{provider?, region?, accountId?, model, displayName}`
 */
export function resolveTarget(providers, keyEntry, accounts, requestedModel) {
  const catalog = buildCatalog(keyEntry?.selections ?? [], accounts)
  if (catalog.length === 0) {
    throw fail(
      409,
      'model_not_configured',
      'this API key has no models selected yet; open Settings → WorkBuddy 模型网关 and tick the models this key should serve',
    )
  }

  const requested = typeof requestedModel === 'string' ? requestedModel.trim() : ''
  const hit = requested === '' ? (catalog.length === 1 ? catalog[0] : undefined) : lookupModel(catalog, requested)
  if (hit === undefined) {
    const available = catalog.map((entry) => entry.name)
    throw fail(
      404,
      'model_not_found',
      requested === ''
        ? `this API key serves ${String(available.length)} models, so the request must name one: ${available.join(', ')}`
        : `this API key does not serve "${requested}"; it serves: ${available.join(', ')}`,
    )
  }

  const region = hit.region ?? 'cn'
  const provider = hit.accountId === '' ? providerOfRegion(region, providers) : providerOfRegion(region, providers)
  return {
    /* 点名账号时必须知道自己属于哪个区；区域已经在勾选时记下了。 */
    region,
    accountId: hit.accountId === '' ? undefined : hit.accountId,
    provider,
    /* 发给上游的真实模型 id（不带我们加的后缀）。 */
    model: hit.modelId,
    /* 回给客户端时用它请求的那个名字，保持对话一致性。 */
    displayModel: requested === '' ? hit.name : requested,
  }
}

function fail(status, code, message) {
  const error = new Error(message)
  error.status = status
  error.code = code
  return error
}
