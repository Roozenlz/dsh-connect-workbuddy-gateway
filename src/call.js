/**
 * 一次调用的统一入口。
 *
 * 两个后端（宿主 adapter / 直连账号）在对外语义上完全一样：输入统一内部请求，
 * 输出规范化事件流。选路规则只有一条——调用方点名了账号就必须直连，否则走宿主。
 *
 * ## 失败一律走事件，不 throw
 *
 * 早期的实现让失败**抛出**。这在流式场景下是错的：调用方一旦因为其它原因
 * `break`（或自己的收尾逻辑先跑），生成器的 `return()` 就会与挂起的 `throw`
 * 竞争，某些运行时直接把异常吞掉 —— 表现为「流正常结束，错误消失」，客户端拿到
 * 一个既没有内容也没有 terminal 的残流。
 *
 * 所以这一层的约定是：**要么 yield `finish`，要么 yield `failure`**，绝不 throw。
 * 各个协议处理器据此决定怎么报告（Responses 发 `response.failed`，Chat 发 error
 * 帧，非流式抛错给上层变 HTTP 状态码）。
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
 * @returns 规范化事件的异步迭代器，最后一个事件必是 `finish` 或 `failure`
 */
export async function* callModel(ctx, env, target, request, signal) {
  if (target.accountId !== undefined) {
    if (!await directAvailable()) {
      yield {
        type: 'failure',
        error: withStatus(
          new Error('account-pinned routing needs the dsh-connect-workbuddy plugin, which is not installed in this profile'),
          400,
          'unsupported_account',
        ),
      }
      return
    }
    let response
    try {
      const body = toOpenAiChatBody(request, target.model, { stream: true, reasoningEffort: target.reasoningEffort })
      response = await directFetch(target.region, target.accountId, body, signal, env.logger)
    } catch (error) {
      yield { type: 'failure', error: asError(error, signal) }
      return
    }
    if (!response.ok) {
      yield { type: 'failure', error: await failFromResponse(response) }
      return
    }
    yield* fromOpenAiSse(response.body, signal)
    return
  }

  if (target.provider === undefined) {
    yield {
      type: 'failure',
      error: withStatus(
        new Error('no provider route resolved for this request; is dsh-connect-workbuddy mounted and enabled?'),
        503,
        'no_provider',
      ),
    }
    return
  }

  yield* hostStream(ctx, target, request, signal)
}

/** 任意异常 → 带状态码的 Error。 */
function asError(error, signal) {
  const normalized = error instanceof Error ? error : new Error(String(error))
  if (typeof normalized.status !== 'number') {
    normalized.status = signal?.aborted === true ? 499 : 502
  }
  /* 客户端取消不算上游故障，给一个明确的码。 */
  if (signal?.aborted === true && normalized.code === undefined) normalized.code = 'ABORTED'
  return normalized
}
