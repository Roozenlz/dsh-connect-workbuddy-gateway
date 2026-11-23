/**
 * 账号名册：只读、只取元数据。
 *
 * 这里刻意不走 `dsh-connect-workbuddy` 的模块导出：那个包在宿主里是按 peer
 * 依赖装配的（`@earendil-works/pi-ai`、`@deepseek-ai/dsh-llm` 等由 DSH 提供），
 * 从本插件的 ESM 图里 `import()` 它可能整包加载失败 —— 而「列出本机有哪些账号」
 * 完全不需要那套运行时。
 *
 * 所以直接读凭据库：`$DSH_HOME/workbuddy-vault/<region>/*.json`。每个文件由插件
 * 自己原子写入，含 `accountId`、`account.{uid,uin,nickname}`、`auth.{domain,
 * expiresAt}`。这里只投影这四个字段，token 一律不读出函数作用域。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VAULT_DIRNAME = 'workbuddy-vault'
const REGIONS = ['cn', 'global']

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** 凭据库目录。 */
export function vaultDir(region) {
  return join(dshHome(), VAULT_DIRNAME, region)
}

/**
 * 列出本机账号。
 *
 * @param region `cn` | `global`
 * @returns `[{id, name, enterprise, region, expiresAtMs?, source}]`，按 id 去重
 */
export function accountsIn(region) {
  const dir = vaultDir(region)
  let files
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const byId = new Map()
  for (const name of files) {
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'))
    } catch {
      continue
    }
    const id = typeof parsed?.accountId === 'string' && parsed.accountId !== '' ? parsed.accountId : name.replace(/\.json$/u, '')
    if (byId.has(id)) continue
    const account = parsed?.account ?? {}
    const auth = parsed?.auth ?? {}
    const name0 = typeof account.nickname === 'string' && account.nickname !== ''
      ? account.nickname
      : typeof account.uid === 'string' ? account.uid.slice(0, 8) : ''
    byId.set(id, {
      id,
      region,
      name: name0,
      enterprise: typeof account.enterpriseId === 'string' && account.enterpriseId !== '',
      ...(typeof auth.expiresAt === 'number' ? { expiresAtMs: auth.expiresAt * 1000 } : {}),
      ...(typeof auth.domain === 'string' && auth.domain !== '' ? { domain: auth.domain } : {}),
    })
  }
  return [...byId.values()]
}

/** 全部区域的账号。 */
export function allAccounts(regions = REGIONS) {
  const out = []
  for (const region of regions) {
    for (const account of accountsIn(region)) out.push(account)
  }
  return out
}

/**
 * 判断一个账号 id 是否属于某区域。
 *
 * 网关要在「点名账号」时确定区域：账号只在一个区域里存在，所以这是唯一可靠的
 * 推导方式（用户少写一个前缀时尤其重要）。
 */
export function regionOfAccount(accountId, regions = REGIONS) {
  for (const region of regions) {
    if (accountsIn(region).some((account) => account.id === accountId)) return region
  }
  return undefined
}
