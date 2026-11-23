/**
 * 账号可用性：读上游插件的账号池状态，判断哪些账号现在不该被勾选。
 *
 * ## 为什么不问插件要
 *
 * 上游插件把「这个账号现在能不能用」记在自己的池状态文件里：
 *
 *   `$DSH_HOME/.workbuddy-pool.<region>.json`
 *
 * 结构（实测）：
 *
 * ```json
 * {
 *   "version": 1,
 *   "probes": {
 *     "<accountId>": {
 *       "outcome": "ok" | "rate-limited" | "restricted" | "unreachable" | …,
 *       "atMs": 1795446344416,
 *       "retryAtMs": 1795501674000,
 *       "message": "…",
 *       "accountName": "…"
 *     }
 *   }
 * }
 * ```
 *
 * 直接读它比 import 插件可靠：那个包在宿主里按 peer 依赖装配，从别的 ESM 图里
 * `import()` 可能整包失败（这个坑本项目已经踩过一次）。文件是插件自己原子写
 * 的，读它不会干扰它。
 *
 * ## 判据
 *
 * 一个账号**现在不可用**，当且仅当：
 *
 *   - `outcome` 表示失败（不是 `ok`），且
 *   - 有 `retryAtMs` 时它还在未来（冷却未过）。
 *
 * 没有 `retryAtMs` 的失败（账号被上游限制这类）按「一直不可用」处理。
 *
 * **不过期的不算。** 冷却过期的记录只是历史，账号已经可以再试；把它当成不可用
 * 会让用户永远勾不到一个其实好了的账号。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 池状态文件名的前缀与后缀。 */
const POOL_PREFIX = '.workbuddy-pool.'
const POOL_SUFFIX = '.json'

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * 一个账号在池状态里的结论。
 *
 * @typedef {{ available: boolean, outcome?: string, reason?: string,
 *             retryAtMs?: number }} AccountHealth
 */

/**
 * 读某个区域的池状态。
 *
 * @param region `cn` | `global`
 * @returns `Map<accountId, AccountHealth>`
 */
export function poolHealth(region) {
  const path = join(dshHome(), `${POOL_PREFIX}${region}${POOL_SUFFIX}`)
  if (!existsSync(path)) return new Map()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return new Map()
  }
  const probes = parsed?.probes
  if (probes === null || typeof probes !== 'object') return new Map()

  const now = Date.now()
  const out = new Map()
  for (const [accountId, raw] of Object.entries(probes)) {
    if (raw === null || typeof raw !== 'object') continue
    const healthy = classify(raw, now)
    out.set(accountId, healthy)
  }
  return out
}

/**
 * 一条 probe 记录 → 可用性结论。
 * @param raw 池状态里的一条
 * @param now 当前时间（毫秒）
 */
function classify(raw, now) {
  const outcome = typeof raw.outcome === 'string' ? raw.outcome : undefined
  /* `ok` 是唯一明确「现在能用」的值。 */
  if (outcome === 'ok') return { available: true, outcome }

  /* 没有 outcome 的记录说明不了任何事，按可用处理（不能凭空禁用账号）。 */
  if (outcome === undefined) return { available: true }

  const retryAtMs = typeof raw.retryAtMs === 'number' && Number.isFinite(raw.retryAtMs) ? raw.retryAtMs : undefined
  /* 冷却已过：这条只是历史，账号现在可以再试。 */
  if (retryAtMs !== undefined && retryAtMs <= now) {
    return { available: true, outcome }
  }

  const reason = typeof raw.message === 'string' && raw.message !== ''
    ? summarizeMessage(raw.message)
    : describeOutcome(outcome)

  return {
    available: false,
    outcome,
    reason,
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  }
}

/** 上游的 message 常是一整段 JSON 错误体，取一句人话。 */
function summarizeMessage(message) {
  let text = message
  try {
    const parsed = JSON.parse(message)
    const said = parsed?.msg ?? parsed?.message ?? parsed?.displayMsg
    if (typeof said === 'string' && said !== '') text = said
  } catch {
    /* 不是 JSON 就原样用 */
  }
  return text.length > 140 ? `${text.slice(0, 137)}…` : text
}

/** `outcome` 的可读说明（message 缺席时用）。 */
function describeOutcome(outcome) {
  switch (outcome) {
    case 'rate-limited':
      return '被限流，冷却中'
    case 'restricted':
    case 'account-restricted':
      return '账号被上游限制'
    case 'unreachable':
      return '连不上上游'
    case 'quota':
      return '额度用尽'
    case 'auth':
      return '凭据失效'
    default:
      return `上游状态：${outcome}`
  }
}

/** 所有区域都读一遍。 */
export function allPoolHealth(regions = ['cn', 'global']) {
  const out = new Map()
  for (const region of regions) {
    for (const [accountId, health] of poolHealth(region)) {
      /* 同一账号不会跨区出现，但保险起见保留第一条。 */
      if (!out.has(accountId)) out.set(accountId, { ...health, region })
    }
  }
  return out
}

/** 池状态文件的修改时间，用于让设置页知道「这份状态有多新」。 */
export function poolStateMtime(regions = ['cn', 'global']) {
  let newest = 0
  for (const region of regions) {
    const path = join(dshHome(), `${POOL_PREFIX}${region}${POOL_SUFFIX}`)
    try {
      const mtime = statSync(path).mtimeMs
      if (mtime > newest) newest = mtime
    } catch {
      /* 没有就没有 */
    }
  }
  return newest
}

/** 列出所有池状态文件（诊断用）。 */
export function poolFiles(regions = ['cn', 'global']) {
  return regions
    .map((region) => join(dshHome(), `${POOL_PREFIX}${region}${POOL_SUFFIX}`))
    .filter((path) => existsSync(path))
}
