/**
 * 模型目录的三种投影。
 *
 * 目录来源有两个，合起来去重：
 *   1. 宿主 adapter 的目录（`llm.listModels`）—— 已按插件设置过滤过启用项；
 *   2. 直连通道读的上游目录 —— 只在宿主目录为空（provider 未注册）时兜底。
 */

import { hostCatalog } from './host-backend.js'
import { directCatalog } from './direct.js'
import { regionOfProvider } from './resolve.js'

/** 汇总所有 provider 的模型，并标注区域。 */
export async function collectModels(env) {
  const entries = []
  const seen = new Set()
  for (const provider of env.providers()) {
    const region = regionOfProvider(provider)
    for (const model of await hostCatalog(env.ctx, provider)) {
      const key = `${region ?? provider}:${model.id}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ provider, region, ...model })
    }
  }
  return entries
}

/** 直连通道的上游目录（宿主目录为空时的兜底）。 */
export async function directModelsByRegion(env) {
  const regions = env.config.enableGlobal === false ? ['cn'] : ['cn', 'global']
  const out = []
  for (const region of regions) {
    for (const model of await directCatalog(region, env.logger)) out.push({ region, provider: region === 'global' ? 'workbuddy-global' : 'workbuddy', ...model })
  }
  return out
}

/**
 * OpenAI `/v1/models` 形状。
 *
 * id 就是裸模型 id —— 策略不再写在模型名里，所以这里不再加 `cn/` 前缀。两个区域
 * 的同名模型用 `owned_by` 区分；客户端按 id 选模型即可。
 */
export function openAiCatalog(entries, config) {
  return {
    object: 'list',
    data: entries.map((entry) => ({
      id: entry.id,
      object: 'model',
      created: 0,
      owned_by: entry.provider ?? 'workbuddy',
      ...(entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow }),
      ...(entry.maxTokens === undefined ? {} : { max_output_tokens: entry.maxTokens }),
      ...(entry.region === undefined ? {} : { region: entry.region }),
    })),
  }
}

export { regionOfProvider }
