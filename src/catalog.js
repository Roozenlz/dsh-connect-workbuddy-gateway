/**
 * 模型清单：把 key 的勾选投影成客户端看到的模型名，再把名字反查回一次调用。
 *
 * 一个 key 勾选若干 `(账号, 模型)` 组合，但客户端只认一个字符串。所以这里要解决
 * 两件事：
 *
 *  1. **重名**。两个账号下都有 `deepseek-v4.1-flash` 时，两行同名客户端无法区分，
 *     选哪一行都一样。于是在名字后面挂账号后缀。
 *
 *  2. **后缀必须是 ASCII**。账号昵称里常有中文、空格、emoji（本机就有一个
 *     `ฅ՞•ﻌ•՞ฅ`）。模型名会被放进入请求体、配置文件的 model 字段，甚至 shell
 *     命令行，塞非 ASCII 会在某一环炸掉。所以：纯 `[A-Za-z0-9._-]` 且短的昵称
 *     用它，否则退化成序号（`#2`、`#3`）。
 *
 * 名字格式：`<modelId>` 或 `<modelId>@<suffix>`。`@` 选得好在模型 id 里几乎不出现，
 * 而且不在 HTTP 头/URL 的保留字符里。
 */

const SUFFIX_SEPARATOR = '@'
/** 昵称能直接当后缀的条件：纯 ASCII 标识符字符、长度合适。 */
const SAFE_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/u

/**
 * 一个候选后缀是否可读且安全。
 * @param name 账号昵称
 */
export function safeSuffixOf(name) {
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  if (trimmed === '') return undefined
  return SAFE_SUFFIX.test(trimmed) ? trimmed : undefined
}

/**
 * 把一把 key 的勾选投影成模型清单。
 *
 * @param selections key 的 `selections`
 * @param accounts 本机账号表（`{id, name, region}` 数组），用于取昵称与区域
 * @returns `[{name, modelId, accountId?, region?, displayName, contextWindow?,
 *            maxTokens?, reasoningEfforts, inputModalities}]`
 */
export function buildCatalog(selections, accounts) {
  const list = Array.isArray(selections) ? selections : []
  const accountById = new Map((Array.isArray(accounts) ? accounts : []).map((account) => [account.id, account]))

  /*
   * 先算出每个 `modelId` 出现了几次：只有重名的那几项才需要后缀。全都加后缀会
   * 让单选一个模型的 key 也顶着一个没必要的尾巴。
   *
   * 这里按 modelId 统计（**不按 region**）：客户端看到的模型名是全局唯一的字符串，
   * 两行同名就无法区分，哪怕它们属于不同区域。
   */
  const modelCounts = new Map()
  for (const selection of list) {
    modelCounts.set(selection.modelId, (modelCounts.get(selection.modelId) ?? 0) + 1)
  }

  /*
   * 后缀分配。规则按优先级：
   *
   *   1. **默认账号**（`accountId: ''`）在同名项之间用区域区分。默认账号在两个区
   *      都存在时两个 `accountId` 都是 `''`，所以区域是唯一能分辨它们的信息。
   *   2. 其余项先试账号昵称，撞了或昵称不可用就换序号。
   *   3. 序号兜底保证唯一，且永远 ASCII。
   *
   * **不给任何一条「裸名特权」。** 早期版本让第一个默认账号保留裸名，结果是
   * `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash@intl` 并列 —— 用户看不出哪行
   * 属于哪个区。现在只要同名就一律带后缀，两边对称。
   *
   * 名字必须稳定：同样的勾选永远得到同样的名字，否则客户端缓存的列表会在
   * 每次刷新后失效。
   */
  const usedNames = new Set()
  const out = []
  let ordinal = 0

  /* 先处理默认账号：它们先占名字。 */
  const ordered = [
    ...list.filter((selection) => selection.accountId === ''),
    ...list.filter((selection) => selection.accountId !== ''),
  ]

  /** 区域的可读后缀。 */
  const regionLabel = (region) => (region === 'global' ? 'intl' : 'cn')

  for (const selection of ordered) {
    ordinal += 1
    const duplicate = (modelCounts.get(selection.modelId) ?? 0) > 1
    const isDefault = selection.accountId === ''
    const region = selection.region
    let name = selection.modelId

    /*
     * 需要一个后缀的情况：
     *   - 同名出现了多次（duplicate），或者
     *   - 裸名已经被别人占了（兜底）。
     */
    const needsSuffix = duplicate || usedNames.has(selection.modelId)

    if (needsSuffix) {
      const candidates = []
      if (isDefault) {
        /* 默认账号没有昵称，用区域名区分 —— 这是用户唯一能分辨的信息。 */
        if (region !== undefined) candidates.push(`${selection.modelId}${SUFFIX_SEPARATOR}${regionLabel(region)}`)
      } else {
        const account = accountById.get(selection.accountId)
        const readable = safeSuffixOf(account?.name)
        if (readable !== undefined) candidates.push(`${selection.modelId}${SUFFIX_SEPARATOR}${readable}`)
      }
      /* 再加区域后缀，避免「同名 + 同昵称」（跨区同名账号）撞车。 */
      if (region !== undefined) candidates.push(`${selection.modelId}${SUFFIX_SEPARATOR}${regionLabel(region)}-${ordinal}`)
      candidates.push(`${selection.modelId}${SUFFIX_SEPARATOR}#${ordinal}`)

      for (let index = 2; ; index += 1) {
        const attempt = candidates.find((candidate) => !usedNames.has(candidate) && candidate !== selection.modelId)
        if (attempt !== undefined) {
          name = attempt
          break
        }
        candidates.push(`${selection.modelId}${SUFFIX_SEPARATOR}#${ordinal}-${index}`)
        if (index > 100) break
      }
    }

    usedNames.add(name)
    const account = selection.accountId === '' ? undefined : accountById.get(selection.accountId)
    out.push({
      name,
      modelId: selection.modelId,
      accountId: selection.accountId,
      region: selection.region ?? account?.region,
      displayName: selection.displayName ?? account?.name ?? '',
      contextWindow: selection.contextWindow,
      maxTokens: selection.maxTokens,
      reasoningEfforts: Array.isArray(selection.reasoningEfforts) ? selection.reasoningEfforts : [],
      inputModalities: Array.isArray(selection.inputModalities) ? selection.inputModalities : ['text'],
    })
  }
  return out
}

/**
 * 按客户端发来的模型名找到对应的一次调用。
 *
 * 三种情况：
 *   1. 命中清单里的 `name`（最常见）；
 *   2. 客户端发的是**裸 modelId**（比如它缓存了旧列表，或用户手填），而清单里
 *      恰好只有一项用这个 id —— 那就用那一项（宽容，不制造莫须有的 404）；
 *   3. 都没有 → undefined，由调用方决定是报错还是回落。
 *
 * @param catalog {@link buildCatalog} 的结果
 * @param requested 客户端发来的模型名
 */
export function lookupModel(catalog, requested) {
  const name = typeof requested === 'string' ? requested.trim() : ''
  if (name === '') return undefined
  const exact = catalog.find((entry) => entry.name === name)
  if (exact !== undefined) return exact
  const byId = catalog.filter((entry) => entry.modelId === name)
  /* 只有一项时才认裸 id：多项时无法判断用户指的是哪个账号。 */
  return byId.length === 1 ? byId[0] : undefined
}
