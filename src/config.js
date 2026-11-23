/**
 * 网关的持久化配置：一组 API key，每把 key 带一份「勾选了哪些模型」的清单。
 *
 * 数据形状（落盘为 JSON，不含任何 WorkBuddy 凭据）：
 *
 * ```json
 * {
 *   "version": 2,
 *   "keys": [
 *     {
 *       "id": "k_xxx",
 *       "label": "我的 Codex",
 *       "secret": "wbg-...",
 *       "enabled": true,
 *       "createdAt": 1790000000000,
 *       "selections": [
 *         { "accountId": "",  "region": "cn",     "modelId": "deepseek-v4.1-flash" },
 *         { "accountId": "8cb3…", "region": "global", "modelId": "kimi-k3" }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * **没有「策略模式」了。** 早期版本用 `policy.mode`（跟随 DSH / 固定模型 / 固定
 * 账号…），那是把选择权留给了插件。现在的模型是：**用户直接勾选要暴露哪些
 * （账号, 模型）组合**，`/v1/models` 就把这份勾选原样返回，请求过来时按名字查表
 * 得到「用哪个账号跑哪个模型」。选哪个模型是调用方的事，插件只负责照单发货。
 *
 * `accountId: ''` 表示「用插件当前的默认账号」（走宿主通道，账号池/换号都生效）；
 * 非空表示点名那个账号（走直连通道）。
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CONFIG_VERSION = 2

/** 数据文件路径。 */
export function configPath() {
  const home = process.env.DSH_HOME
  const base = typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh')
  return join(base, 'workbuddy-gateway', 'keys.json')
}

/** 空配置。 */
export function emptyConfig() {
  return { version: CONFIG_VERSION, keys: [] }
}

/**
 * 读配置。
 *
 * 文件不存在返回空配置（首次启动的正常状态）；文件损坏时**保留原文件**并抛错，
 * 让用户能去修，而不是静默用一份空配置覆盖掉他的 key。
 */
export function readConfig() {
  const path = configPath()
  if (!existsSync(path)) return emptyConfig()
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return emptyConfig()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the gateway config at ${path} is not valid JSON; fix or delete it`)
  }
  return normalizeConfig(parsed)
}

/** 规整一份读到的配置（补齐缺失字段、丢弃坏条目）。 */
export function normalizeConfig(value) {
  const keys = []
  for (const entry of Array.isArray(value?.keys) ? value.keys : []) {
    const normalized = normalizeKey(entry)
    if (normalized !== undefined) keys.push(normalized)
  }
  return { version: CONFIG_VERSION, keys }
}

/** 规整一把 key。`secret` 缺失的条目直接丢弃（不能用的 key 不该留在表里）。 */
function normalizeKey(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const secret = typeof entry.secret === 'string' ? entry.secret.trim() : ''
  if (secret === '') return undefined
  return {
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : newKeyId(),
    label: typeof entry.label === 'string' ? entry.label.slice(0, 80) : '',
    secret,
    enabled: entry.enabled !== false,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    ...(typeof entry.lastUsedAt === 'number' ? { lastUsedAt: entry.lastUsedAt } : {}),
    /* `seeded` 记录「已经自动补过模型勾选」，见 index.js 的 ensureSeeded。 */
    ...(entry.seeded === true ? { seeded: true } : {}),
    selections: normalizeSelections(entry.selections),
  }
}

/**
 * 规整勾选清单。
 *
 * 去重是必须的：同一个 (账号, 区域, 模型) 勾两次会让模型列表出现两行同名项，
 * 客户端选哪一个最后都是同一次调用——那是骗人的，所以在落盘时就消掉。
 *
 * **去重键必须带 region。** 默认账号的 `accountId` 是 `''`，两个区都是这个值；
 * 只按 `(accountId, modelId)` 去重会把「国内版默认账号的 deepseek」和「国际版
 * 默认账号的 deepseek」当成同一项，勾一个另一个跟着变，模型列表里也只剩一行 ——
 * 用户就无法知道实际调的是哪个区。region 是这条身份的一部分，不能省。
 */
export function normalizeSelections(value) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(value) ? value : []) {
    if (raw === null || typeof raw !== 'object') continue
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : ''
    if (modelId === '') continue
    const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : ''
    const region = raw.region === 'global' ? 'global' : raw.region === 'cn' ? 'cn' : undefined
    const key = selectionKey(accountId, modelId, region)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      accountId,
      ...(region === undefined ? {} : { region }),
      modelId,
      ...(typeof raw.displayName === 'string' && raw.displayName !== '' ? { displayName: raw.displayName.slice(0, 120) } : {}),
      ...(typeof raw.contextWindow === 'number' && raw.contextWindow > 0 ? { contextWindow: Math.floor(raw.contextWindow) } : {}),
      ...(typeof raw.maxTokens === 'number' && raw.maxTokens > 0 ? { maxTokens: Math.floor(raw.maxTokens) } : {}),
      ...(Array.isArray(raw.reasoningEfforts)
        ? { reasoningEfforts: raw.reasoningEfforts.filter((effort) => typeof effort === 'string' && effort !== '').slice(0, 12) }
        : {}),
      ...(Array.isArray(raw.inputModalities)
        ? { inputModalities: raw.inputModalities.filter((mode) => mode === 'text' || mode === 'image') }
        : {}),
    })
  }
  return out
}

/**
 * 一条勾选的稳定身份。
 *
 * **region 是身份的一部分。** 默认账号在两个区的 `accountId` 都是 `''`，少了
 * region 就没法区分「国内版默认账号」与「国际版默认账号」。
 *
 * @param accountId 账号 id（默认账号为 `''`）
 * @param modelId 上游模型 id
 * @param region `cn` | `global` | undefined
 */
export function selectionKey(accountId, modelId, region) {
  return `${accountId}\u0000${modelId}\u0000${region ?? ''}`
}

/** 原子写配置。 */
export function writeConfig(config) {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* Windows 上 chmod 语义有限 */
  }
}

/** 新的 key id。 */
export function newKeyId() {
  return `k_${randomBytes(6).toString('hex')}`
}

/** 新的一把 key 的秘密值。 */
export function newSecret() {
  return `wbg-${randomBytes(24).toString('base64url')}`
}

/**
 * 建一个新条目。
 * @param overrides 覆盖默认字段
 */
export function makeKey(overrides = {}) {
  return normalizeKey({
    id: newKeyId(),
    label: '',
    secret: newSecret(),
    enabled: true,
    createdAt: Date.now(),
    selections: [],
    ...overrides,
  })
}

/**
 * 展示用掩码。
 *
 * 只显示长度与前 4 / 后 4 位，中间一律用 `*`。这有几个刻意的决定：
 *
 *   - **不用 `…`（U+2026）**。它是多字节字符，客户端把它当 HTTP 头发出去会直接
 *     抛 `Cannot convert argument to a ByteString because the character at index N
 *     has a value of 8232/8230`。用户从这个界面复制到的任何东西都必须是可安全
 *     放进 header 的纯 ASCII。
 *   - **不用 `·` / `•`** 同理。
 *   - 前后各留 4 位，够用户在人眼层面认出「这是哪一把」，但不足以还原。
 *
 * 真正的复制入口永远是 `reveal` 拿到的明文，界面上的掩码**不提供复制**。
 */
export function maskSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return '****'
  if (secret.length <= 12) return '*'.repeat(secret.length)
  return `${secret.slice(0, 4)}${'*'.repeat(Math.min(16, secret.length - 8))}${secret.slice(-4)}`
}
