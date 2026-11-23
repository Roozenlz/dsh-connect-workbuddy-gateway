/**
 * 模型目录的对外投影。
 *
 * **这一层只做一件事**：把 key 勾选的模型清单投影成客户端能读的形状。
 *
 * 字段对照 cc-switch 的「模型映射」表（菜单显示名 / 实际请求模型 / 上下文窗口 /
 * 思考等级），见 docs/user-manual/zh/2-providers/2.1-add.md。它的「获取模型列表」
 * 调的就是 OpenAI 兼容的 `/v1/models`，所以这里既给标准字段，也给 cc-switch
 * 认识的那几个别名——多给几个字段的成本很低，少一个就要用户手填。
 *
 * **推理等级只在这里列出，不在请求里强制。** 用户要求「不提供推理等级选项，让
 * 客户端自己选」，所以网关不读 key 上的默认档，只把「这个模型支持哪几档」告诉
 * 客户端；客户端发来的 `reasoning_effort` 原样透传给上游。
 */

import { hostCatalog } from './host-backend.js'
import { directCatalog } from './direct.js'
import { regionOfProvider } from './resolve.js'
import { buildCatalog } from './catalog.js'

/** 一个 provider 的模型全表（含元信息）。 */
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
 * 模型全表，供设置页的勾选界面用。
 *
 * 每一项都带上「要写进勾选清单」的全部字段，于是界面勾一下就能存下完整信息
 * （上下文、输出上限、推理档、模态），日后展示不需要再查一遍上游。
 */
export async function catalogForSettings(env, accounts) {
  const entries = await collectModels(env)
  const pool = entries.length > 0 ? entries : await directModelsByRegion(env)
  return pool.map((entry) => ({
    accountId: '',
    region: entry.region,
    modelId: entry.id,
    displayName: entry.name ?? entry.id,
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
    reasoningEfforts: effortsOf(entry.reasoning),
    inputModalities: modalitiesOf(entry.inputModalities),
    /* 供界面显示：模型属于哪个区域。 */
    provider: entry.provider,
  }))
}

/** 推理档列表：adapter 报了就用它的，否则给一组保守的常用档位。 */
export function effortsOf(reasoning) {
  const declared = Array.isArray(reasoning?.efforts)
    ? reasoning.efforts.map((effort) => (typeof effort === 'string' ? effort : effort?.id)).filter((id) => typeof id === 'string' && id !== '')
    : []
  if (declared.length > 0) return declared
  /* 上游没声明时不猜具体档位，给空数组 —— 客户端就不会显示一个假的档位选择器。 */
  return []
}

function modalitiesOf(inputModalities) {
  if (!Array.isArray(inputModalities)) return ['text']
  const kept = inputModalities.filter((mode) => mode === 'text' || mode === 'image')
  return kept.length === 0 ? ['text'] : kept
}

/**
 * 把一个条目投影成客户端认识的模型描述。
 *
 * 字段名并列出多种叫法，因为读取方各认一套：
 *   OpenAI 官方        `context_window` / `max_output_tokens`
 *   pi-ai / OpenRouter `contextWindow` / `maxTokens` / `limit.{context,output}`
 *   LiteLLM            `max_input_tokens` / `max_output_tokens`
 *   cc-switch          `display_name`（菜单显示名） + `id`（实际请求模型）
 */
function describeModel(entry) {
  const declaredContext = positive(entry.contextWindow)
  const declaredOutput = positive(entry.maxTokens)
  /* 上游没报就用默认值——缺席比给一个保守值更糟，见下面常量的注释。 */
  const contextWindow = declaredContext ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = declaredOutput ?? DEFAULT_MAX_OUTPUT
  const contextWindowDefaulted = declaredContext === undefined
  const maxTokensDefaulted = declaredOutput === undefined
  const modalities = Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text']
  const images = modalities.includes('image')
  const efforts = Array.isArray(entry.reasoningEfforts) ? entry.reasoningEfforts : []

  return {
    /* `id` 就是客户端要填进请求 model 字段的那个名字（重名时带账号后缀）。 */
    id: entry.name,
    object: 'model',
    created: 0,
    owned_by: entry.accountId === '' ? 'workbuddy' : 'workbuddy-account',
    /* cc-switch 的「菜单显示名」用它；没有就退到 id。 */
    display_name: entry.displayName === '' ? entry.name : entry.displayName,
    name: entry.displayName === '' ? entry.name : entry.displayName,
    /* 上游真实模型 id —— 重名时它与 id 不同。 */
    model: entry.modelId,
    ...(entry.region === undefined ? {} : { region: entry.region }),

    /*
     * 上下文与输出上限：**永远给出数值**，上游没报就用默认值。
     *
     * 为什么必须给：cc-switch 与同类客户端把这两个值直接填进它自己的表单，字段
     * 缺席的后果是那一栏空白、要用户手填——而用户并不知道该填多少。给一个保守的
     * 默认值，至少表单是完整的、请求能发出去。
     *
     * 默认值的选择：上下文 128000（当今模型的常见下限），输出 8192（多数模型的
     * 默认上限）。上游报了就用上游的，`*_defaulted` 标记说明这是估的。
     */
    context_window: contextWindow,
    contextWindow,
    context_length: contextWindow,
    context_tokens: contextWindow,
    max_context_tokens: contextWindow,
    max_input_tokens: contextWindow,
    limit: { context: contextWindow, output: maxTokens },
    ...(contextWindowDefaulted ? { context_window_defaulted: true } : {}),

    max_output_tokens: maxTokens,
    maxTokens,
    max_completion_tokens: maxTokens,
    ...(maxTokensDefaulted ? { max_output_tokens_defaulted: true } : {}),

    input_modalities: modalities,
    supports_vision: images,
    supports_images: images,
    /* 有的客户端把「能不能关掉思考」单独列一栏。 */
    supports_reasoning: efforts.length > 0,
    supports_thinking: efforts.length > 0,

    /* 推理能力：只声明「有哪些档」，不替客户端选。 */
    reasoning: efforts.length > 0,
    reasoning_efforts: efforts,
    reasoningEffort: efforts,
  }
}

/*
 * 默认值：客户端要这两个数字来填表单，缺席比给一个保守值更糟。
 * 保守是为了不误导——报大了会让客户端把超长上下文发上去被上游拒绝。
 */
const DEFAULT_CONTEXT_WINDOW = 128000
const DEFAULT_MAX_OUTPUT = 8192

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * OpenAI `/v1/models` 形状。
 * @param catalog {@link buildCatalog} 的结果
 */
export function openAiCatalog(catalog) {
  return { object: 'list', data: catalog.map(describeModel) }
}

/** Anthropic `/v1/models` 形状（SDK 读 `data:[{type,id,display_name}]`）。 */
export function anthropicCatalog(catalog) {
  return {
    data: catalog.map((entry) => {
      const one = describeModel(entry)
      /* 这里同样不给「缺席」留口子：Anthropic SDK 的 model 对象也有这两个字段。 */
      return {
        type: 'model',
        id: one.id,
        display_name: one.display_name,
        created_at: new Date(0).toISOString(),
        context_window: one.context_window,
        max_input_tokens: one.max_input_tokens,
        max_output_tokens: one.max_output_tokens,
      }
    }),
    has_more: false,
    first_id: catalog.length === 0 ? null : catalog[0].name,
    last_id: catalog.length === 0 ? null : catalog[catalog.length - 1].name,
  }
}

export { regionOfProvider, buildCatalog }
