/**
 * 网关的持久化配置：一组 API key，每把 key 带自己的路由策略。
 *
 * 数据形状（落盘为 JSON，不含任何 WorkBuddy 凭据）：
 *
 * ```json
 * {
 *   "version": 1,
 *   "keys": [
 *     {
 *       "id": "k_xxx",
 *       "label": "我的 Codex",
 *       "secret": "wbg-...",
 *       "enabled": true,
 *       "createdAt": 1790000000000,
 *       "policy": { "mode": "dsh" }
 *     }
 *   ]
 * }
 * ```
 *
 * `policy.mode` 的取值与含义：
 *
 *   `dsh`        跟随 DSH 新会话的默认模型
 *   `session`    跟随最近活跃会话正在用的模型
 *   `current`    先会话、再默认选择（「此刻在用的那个」）
 *   `named`      固定 provider + model（这把 key 专属）
 *   `account`    固定账号（可再固定模型；走直连通道）
 *   `first`      目录第一个
 *
 * **策略不再写进模型名。** 请求体里的 `model` 若为空，就用这把 key 的策略；
 * 调用方仍可显式写模型名覆盖（这是客户端 SDK 的硬要求，无法禁止），但写 `cn/`
 * 之类前缀不再是「配置方式」。
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const CONFIG_VERSION = 1
export const POLICY_MODES = ['dsh', 'session', 'current', 'named', 'account', 'first']

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

/** 规整一把 key。`secret` 缺失或过短的条目直接丢弃（不能用的 key 不该留在表里）。 */
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
    policy: normalizePolicy(entry.policy),
  }
}

/** 规整一份策略。 */
export function normalizePolicy(policy) {
  const mode = POLICY_MODES.includes(policy?.mode) ? policy.mode : 'dsh'
  const out = { mode }
  if (mode === 'named' || mode === 'account') {
    if (typeof policy?.provider === 'string' && policy.provider !== '') out.provider = policy.provider
    if (typeof policy?.model === 'string' && policy.model !== '') out.model = policy.model
  }
  if (mode === 'account') {
    out.accountId = typeof policy.accountId === 'string' ? policy.accountId : ''
    if (typeof policy.region === 'string' && policy.region !== '') out.region = policy.region
  }
  if (typeof policy?.reasoningEffort === 'string' && policy.reasoningEffort !== '') {
    out.reasoningEffort = policy.reasoningEffort
  }
  return out
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
    policy: { mode: 'dsh' },
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
 *     has a value of 8230`。用户从这个界面复制到的任何东西都必须是可安全放进
 *     header 的纯 ASCII。
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
