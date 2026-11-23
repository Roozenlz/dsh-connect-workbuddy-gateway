/**
 * 一次调用的统一入口。
 *
 * 两个后端（宿主 adapter / 直连账号）在对外语义上完全一样：输入统一内部请求，
 * 输出规范化事件流。选路规则只有一条——调用方点名了账号就必须直连，否则走宿主。
 */

import { hostStream } from './host-backend.js'
import { directAvailable, directFetch } from './direct.js'
import { toOpenAiChatBody } from './openai-body.js'
import { fromOpenAiSse } from './stream.js'
import { withStatus } from './backend.js'

/** 直连响应非 2xx 时转成带状态的错误。 */
async function failFromResponse(response) {
  let message = `upstream replied ${response.status}`
  try {
    const text = await response.text()
    if (text !== '') {
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      const said = parsed?.error?.message ?? parsed?.message ?? parsed?.error
      if (typeof said === 'string' && said !== '') message = said
      else if (text.length < 800) message = text
    }
  } catch {
    /* 保留状态行 */
  }
  return withStatus(new Error(message), response.status >= 400 ? response.status : 502, 'upstream_error')
}

/**
 * 发一次调用。
 *
 * @param ctx 宿主上下文
 * @param env `{logger, config}`
 * @param target resolve.js 解析出来的目标
 * @param request 统一内部请求
 * @param signal 取消信号
 * @returns 规范化事件的异步迭代器
 */
export async function* callModel(ctx, env, target, request, signal) {
  if (target.accountId !== undefined) {
    if (!await directAvailable()) {
      throw withStatus(new Error('account-pinned routing needs the dsh-connect-workbuddy plugin, which is not installed in this profile'), 400, 'unsupported_account')
    }
    const body = toOpenAiChatBody(request, target.model, { stream: true, reasoningEffort: target.reasoningEffort })
    const response = await directFetch(target.region, target.accountId, body, signal, env.logger)
    if (!response.ok) throw await failFromResponse(response)
    yield* fromOpenAiSse(response.body, signal)
    return
  }
  if (target.provider === undefined) {
    throw withStatus(new Error('no provider route resolved for this request; is dsh-connect-workbuddy mounted and enabled?'), 503, 'no_provider')
  }
  yield* hostStream(ctx, target, request, signal)
}
