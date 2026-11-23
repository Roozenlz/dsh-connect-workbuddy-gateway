/**
 * WorkBuddy Gateway —— 把 dsh-connect-workbuddy 提供的模型开放成本机可调用的
 * HTTP API。
 *
 * 四种协议共用一个 base_url：
 *
 *   OpenAI Chat Completions   POST {base}/v1/chat/completions
 *   OpenAI Responses          POST {base}/v1/responses
 *   Anthropic Messages        POST {base}/v1/messages
 *   Gemini generateContent    POST {base}/v1beta/models/{model}:generateContent
 *
 * **每把 key 勾选自己要对外提供的模型。** 用户直接勾哪些 (账号, 模型) 组合，
 * `/v1/models` 就返回哪些；客户端选哪个模型由它自己决定，插件只负责照单发货。
 * 见 src/catalog.js 与 src/resolve.js。
 * （跟随 DSH 默认 / 跟随活跃会话 / 固定模型 / 固定账号 / 目录第一个），在
 * 设置 → WorkBuddy Gateway 里管理。请求体不写 `model` 时就用这把 key 的策略。
 */

import { registerRoutes, baseUrlOf } from './src/routes.js'
import { workbuddyProviders } from './src/backend.js'
import { closeDirect } from './src/direct.js'
import { readConfig, writeConfig, makeKey, normalizeSelections, configPath } from './src/config.js'
import { catalogForSettings } from './src/models.js'

export const name = 'workbuddy-gateway'

/** 必须先有 webServer 才能挂路由；llm 由 workbuddy 插件提供，按需读取。 */
export const inject = ['webServer']

const DEFAULTS = {
  /** 关闭国际版区域（只服务国内区）。 */
  enableGlobal: true,
  /**
   * 模型目录里是否把「接受图片」标为支持。
   *
   * 客户端会把这个标记填进它自己的表单。WorkBuddy 上游的图片能力按模型区分，
   * 但目录接口不逐个声明，所以这里给一个总开关：默认 `true`（多数模型确实能
   * 看图），遇到纯文本模型时用户可以在客户端里自己取消勾选。
   */
  images: true,
}

/**
 * 插件入口。
 * @param ctx Cordis 上下文
 * @param config 行配置
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }

  /*
   * 首次启动建一把默认 key，并**把所有可见模型都勾上** —— 用户拿到的 key 立刻
   * 能用，不必先去勾选。只在 key 表为空时做，所以手动删光 key 之后重启会重新给
   * 一把，那正是「我不小心删没了」的恢复路径。
   *
   * 勾选清单要等 provider 注册完才能读，所以放到异步里，失败只记一条日志。
   */
  try {
    const stored = readConfig()
    if (stored.keys.length === 0) {
      writeConfig({ ...stored, keys: [makeKey({ label: 'default' })] })
      ctx.logger.info(`workbuddy-gateway: created the first API key in ${configPath()}`)
    }
  } catch (error) {
    ctx.logger.warn(`workbuddy-gateway: could not prepare the key file: ${error instanceof Error ? error.message : String(error)}`)
  }

  const env = {
    ctx,
    config: settings,
    logger: ctx.logger,
    /*
     * provider 路由每次请求现读：用户可能在设置里关掉一个区域，或让
     * dsh-connect-workbuddy 重新注册（HMR）。采样一次会把「刚启用」的区域
     * 一直当不存在。
     */
    providers: () => workbuddyProviders(ctx, []),
    /* 路由层在读到空清单时调它，见 {@link ensureSeeded}。 */
    ensureSeeded: () => ensureSeeded(env),
  }

  /*
   * 首次启动建一把默认 key。**勾选清单不在这里补** —— 建 key 时 provider 往往
   * 还没注册完，此处去读目录只能拿到空表。真正补选的时机是「第一次有人读它」：
   * `/state` 与 `/v1/models` 都会在拿到清单为空时调 {@link ensureSeeded}，那时
   * provider 一定已经就绪。
   */
  try {
    const stored = readConfig()
    if (stored.keys.length === 0) {
      writeConfig({ ...stored, keys: [makeKey({ label: 'default' })] })
      ctx.logger.info(`workbuddy-gateway: created the first API key in ${configPath()}`)
    }
  } catch (error) {
    ctx.logger.warn(`workbuddy-gateway: could not prepare the key file: ${error instanceof Error ? error.message : String(error)}`)
  }

  ctx.effect(() => {
    const dispose = registerRoutes(ctx, env)
    ctx.logger.info(`workbuddy-gateway: serving ${baseUrlOf(ctx)}`)
    return () => {
      dispose()
      void closeDirect()
    }
  })
}

/**
 * 惰性补选：某把 key 的清单为空、而本机确实有可用模型时，把它填满。
 *
 * 只在「从未补过 且 清单为空」时动手，所以用户主动清空的意图不会被覆盖（他清空
 * 之后要么立刻再勾，要么就是想让这把 key 停用）。为了区分「刚建好还没勾」与
 * 「用户故意清空」，落盘时给补过的 key 打 `seeded` 标记。
 *
 * @returns 是否写入了配置
 */
export async function ensureSeeded(env) {
  const config = readConfig()
  const target = config.keys.find((entry) => entry.seeded !== true && (entry.selections ?? []).length === 0)
  if (target === undefined) return false
  if (env.providers().length === 0) return false
  let available
  try {
    available = await catalogForSettings(env)
  } catch {
    return false
  }
  if (available.length === 0) return false
  target.selections = normalizeSelections(available)
  target.seeded = true
  writeConfig(config)
  env.logger.info(`workbuddy-gateway: pre-selected ${String(target.selections.length)} models on key "${target.label || target.id}"`)
  return true
}

export { baseUrlOf }
