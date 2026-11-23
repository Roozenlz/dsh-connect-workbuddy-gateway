/** 两个「默认模型」来源的只读查询，单独成文件以避免 backend ↔ resolve 循环依赖。 */

/** DSH 新会话的默认模型选择，或 undefined。 */
export function defaultSelection(ctx) {
  const service = ctx.get('agentDefaultModel')
  if (service === undefined) return undefined
  try {
    return service.currentSelection()
  } catch {
    return undefined
  }
}

/**
 * 最近一个活跃会话正在用的模型。
 *
 * 会话的 `requestHeader()` 记录了该会话当前请求头里的 provider/model，这是
 * 「用户此刻在 DSH 里用的那个」唯一可靠来源。
 */
export function sessionSelection(ctx) {
  const agents = ctx.get('agents')
  if (agents === undefined) return undefined
  let live
  try {
    live = agents.list()
  } catch {
    return undefined
  }
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const agent = live[index]
    let header
    try {
      header = agent?.session?.requestHeader?.()
    } catch {
      continue
    }
    const config = header?.config
    if (config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    }
  }
  return undefined
}
