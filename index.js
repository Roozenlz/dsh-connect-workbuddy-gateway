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
 * **路由策略挂在 API key 上，不写在模型名里。** 每把 key 自带一个 policy
 * （跟随 DSH 默认 / 跟随活跃会话 / 固定模型 / 固定账号 / 目录第一个），在
 * 设置 → WorkBuddy Gateway 里管理。请求体不写 `model` 时就用这把 key 的策略。
 */

import { registerRoutes, baseUrlOf } from './src/routes.js'
import { workbuddyProviders } from './src/backend.js'
import { closeDirect } from './src/direct.js'
import { readConfig, writeConfig, makeKey, configPath } from './src/config.js'

export const name = 'workbuddy-gateway'

/** 必须先有 webServer 才能挂路由；llm 由 workbuddy 插件提供，按需读取。 */
export const inject = ['webServer']

const DEFAULTS = {
  /** 关闭国际版区域（只服务国内区）。 */
  enableGlobal: true,
}

/**
 * 插件入口。
 * @param ctx Cordis 上下文
 * @param config 行配置
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }

  /*
   * 首次启动建一把默认 key：设置页要有东西可看，用户也要有一把能立刻用的。
   * 只在 key 表为空时做，所以手动删光所有 key 之后重启会重新给一把——
   * 那正是「我一不小心删没了」的恢复路径。
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

export { baseUrlOf }
