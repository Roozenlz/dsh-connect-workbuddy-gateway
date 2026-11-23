/**
 * 模型目录的三种投影。
 *
 * 目录来源有两个，合起来去重：
 *   1. 宿主 adapter 的目录（`llm.listModels`）—— 已按插件设置过滤过启用项；
 *   2. 直连通道读的上游目录 —— 只在宿主目录为空（provider 未注册）时兜底。
 *
 * **投影必须带足元信息。** 客户端「获取模型列表」不只是拿 id 列表：它要用
 * context window、max output、是否支持图片来填自己的表单。字段名各家不同，
 * 所以一条目上同时给出常见的那几种写法（OpenAI 的 `context_window` / camelCase
 * 的 `contextWindow` / LiteLLM 的 `max_input_tokens` / OpenRouter 的 `limit`），
 * 一个条目体积很小，而少一个字段就要用户手填。
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
    for (const model of await directCatalog(region, env.logger)) {
      out.push({
        region,
        provider: region === 'global' ? 'workbuddy-global' : 'workbuddy',
        ...model,
        inputModalities: ['text', 'image'],
      })
    }
  }
  return out
}

/**
 * 把一把 key 的策略收窄成「它实际会用的那些模型」。
 *
 * 这是用户要的行为：一把钉死模型的 key，列表里就只该出现那个模型 —— 否则
 * 客户端会让用户从 9 个里挑一个，而挑哪个最后都走同一个模型，是骗人的。
 *
 * 返回 `undefined` 表示「不按策略收窄」（跟随型策略下模型空间是整个目录）。
 *
 * @param keyEntry 本次请求的 key
 * @param entries 全量目录
 * @returns 收窄后的条目，或 undefined
 */
export function narrowToPolicy(keyEntry, entries) {
  const policy = keyEntry?.policy
  if (policy === undefined) return undefined
  if (policy.mode !== 'named' && policy.mode !== 'account') return undefined

  const wanted = typeof policy.model === 'string' ? policy.model.trim() : ''
  if (wanted === '') return undefined

  const matches = entries.filter((entry) => entry.id === wanted)
  if (matches.length === 0) return undefined

  /*
   * 策略里钉了 provider 就优先那一条；否则全留（同名模型在两个区都存在时，
   * 用户该看到两行，因为 `owned_by` 不同）。
   */
  if (typeof policy.provider === 'string' && policy.provider !== '') {
    const scoped = matches.filter((entry) => entry.provider === policy.provider)
    if (scoped.length > 0) return scoped
  }
  return matches
}

/**
 * 一个条目 → 客户端能读懂的模型描述。
 *
 * 字段名按「同一个意思，多种叫法」并列给出，因为读取方各认一套：
 *
 *   OpenAI 官方      `context_window` / `max_output_tokens`
 *   pi-ai / OpenRouter `contextWindow` / `maxTokens` / `limit.{context,output}`
 *   LiteLLM           `max_input_tokens` / `max_output_tokens`
 *
 * `input_modalities` / `supports_vision` 是给「是否接受图片」那一栏用的。
 */
function describeModel(entry, preferences) {
  const contextWindow = positive(entry.contextWindow)
  const maxTokens = positive(entry.maxTokens)
  const images = entry.inputModalities === undefined
    ? preferences.images !== false
    : entry.inputModalities.includes('image')

  return {
    id: entry.id,
    object: 'model',
    created: 0,
    owned_by: entry.provider ?? 'workbuddy',
    name: entry.name ?? entry.id,
    /* 区域：不在标准里，但客户端据此区分两个区的同名模型。 */
    region: entry.region,

    /* 上下文上限：四种写法。 */
    ...(contextWindow === undefined ? {} : {
      context_window: contextWindow,
      contextWindow,
      context_length: contextWindow,
      max_input_tokens: contextWindow,
      limit: {
        context: contextWindow,
        ...(maxTokens === undefined ? {} : { output: maxTokens }),
      },
    }),

    /* 输出上限。`max_output_tokens_estimated` 说明这个值不是上游明说的。 */
    ...(maxTokens === undefined ? {} : {
      max_output_tokens: maxTokens,
      maxTokens,
      max_completion_tokens: maxTokens,
      ...(entry.maxTokensEstimated === true ? { max_output_tokens_estimated: true } : {}),
    }),

    /* 模态。 */
    input_modalities: images ? ['text', 'image'] : ['text'],
    supports_vision: images,
    supports_images: images,

    /* 有的客户端把「能不能调工具」也列出来。 */
    ...(entry.reasoning === undefined ? {} : {
      reasoning: true,
      ...(Array.isArray(entry.reasoning.efforts) && entry.reasoning.efforts.length > 0
        ? { reasoning_efforts: entry.reasoning.efforts.map((effort) => effort.id) }
        : {}),
    }),
  }
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * OpenAI `/v1/models` 形状。
 *
 * @param entries 已按策略收窄过的条目
 * @param preferences 插件级偏好（`images`）
 */
export function openAiCatalog(entries, preferences = {}) {
  return {
    object: 'list',
    data: entries.map((entry) => describeModel(entry, preferences)),
  }
}

export { regionOfProvider }
