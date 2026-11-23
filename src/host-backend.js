/**
 * Host 后端：走宿主 `llm` 服务（＝ dsh-connect-workbuddy 注册的 adapter）。
 *
 * 这条通道的账号由插件自己的选择或账号池决定，网关不干预；好处是换号、渠道
 * 指纹救助、context rescue 全都免费继承。
 *
 * ## 失败是怎么传出去的
 *
 * **不用在 async generator 内部 `throw`。** 调用方一旦 `break`（例如它自己已经
 * 收尾），生成器的 `return()` 会与挂起的 `throw` 竞争，而某些运行时把异常吞掉——
 * 表现为「流正常结束、错误消失」。实测就是这样：上游 429 时客户端只收到前几个
 * 事件，既没有 terminal 也没有错误。
 *
 * 所以失败也走**事件通道**：yield 一个 `{type:'failure'}` 事件，由调用方决定怎么
 * 报告（Responses 发 `response.failed`，Chat 发 error 帧，非流式抛错）。
 */

import {
  buildGenerateOptions,
  listModels,
  resolveModelInfo,
  streamHost,
  withStatus,
} from './backend.js'
import { fromHostChunks } from './stream.js'

/**
 * 宿主 adapter 的 chunk 流 → 规范化事件流。
 *
 * 除了 `text` / `reasoning` / `tool-call` / `usage` / `finish`，还会 yield
 * `{type:'failure', error}`：上游失败或断流时用它代替 `finish`。
 */
export async function* hostStream(ctx, target, request, signal) {
  const { options } = await buildGenerateOptions(ctx, {}, request, target)
  const chunks = streamHost(ctx, options, signal)
  let sawFinish = false

  try {
    for await (const event of fromHostChunks(chunks)) {
      if (event.type === 'finish') {
        sawFinish = true
        if (event.reason.kind === 'error' || event.reason.kind === 'aborted') {
          yield { type: 'failure', error: failureFromChunk(event.reason.failure) }
          return
        }
      }
      yield event
    }
  } catch (error) {
    /* 迭代器自身抛错（网络中断、adapter 内部异常）也走事件通道。 */
    yield { type: 'failure', error: normalizeStreamError(error, signal) }
    return
  }

  if (!sawFinish) {
    yield { type: 'failure', error: normalizeStreamError(undefined, signal) }
  }
}

/** 一个 finish chunk 的 failure → Error。 */
function failureFromChunk(failure) {
  const partial = failure ?? {}
  const error = new Error(partial.message ?? 'the upstream call failed')
  error.code = partial.code ?? 'upstream_error'
  error.status = statusOfFailure(partial)
  return error
}

/** 迭代器抛出的任意错误（或「没 finish 就结束」）→ 带状态码的 Error。 */
function normalizeStreamError(error, signal) {
  if (error !== undefined && error !== null) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    if (typeof normalized.status !== 'number') normalized.status = statusOfFailure({ code: normalized.code })
    return normalized
  }
  if (signal?.aborted === true) {
    const aborted = new Error('the client cancelled the request')
    aborted.code = 'ABORTED'
    aborted.status = 499
    return aborted
  }
  const truncated = new Error(
    'the upstream stream ended without a finish chunk; it may have been rate limited, refused, or cut off',
  )
  truncated.code = 'upstream_truncated'
  truncated.status = 502
  return truncated
}

/** 把上游失败码翻成 HTTP 状态。 */
export function statusOfFailure(failure) {
  if (typeof failure?.status === 'number' && failure.status >= 400) return failure.status
  switch (failure?.code) {
    case 'AUTH':
    case 'INVALID_CREDENTIAL':
      return 401
    case 'RATE_LIMIT':
      return 429
    case 'QUOTA_EXCEEDED':
    case 'ACCOUNT_QUOTA_EXCEEDED':
      return 402
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_CONTENT':
      return 400
    case 'MODEL_DOES_NOT_SUPPORT_IMAGES':
      return 400
    case 'NO_ADAPTER':
    case 'MODEL_NOT_FOUND':
      return 404
    case 'ABORTED':
      return 499
    default:
      return 502
  }
}

/**
 * 模型目录（带上下文窗口、输出上限、模态与推理档）。
 *
 * `maxTokens` 的兜底顺序是刻意的：WorkBuddy 的 adapter 把上游的 `maxTokens`
 * 报成 `defaultMaxTokens`，但那是「这次请求默认输出多少」，不是「模型最多能
 * 输出多少」——上游没给后者时它是空的。客户端拿不到输出上限就只能让用户手填，
 * 所以这里在缺值时退到上下文窗口的一个保守比例，并在字段名上说明这是估算。
 */
export async function hostCatalog(ctx, provider) {
  const models = await listModels(ctx, provider)
  const detailed = await Promise.all(models.map(async (entry) => {
    const info = await resolveModelInfo(ctx, provider, entry.id)
    const contextWindow = positiveInt(info?.contextWindow)
    const declared = positiveInt(info?.defaultMaxTokens)
    /* 上游没报输出上限时，按上下文窗口的 1/8 估一个（常见的输出占比）。 */
    const estimated = contextWindow === undefined ? undefined : Math.max(1024, Math.floor(contextWindow / 8))
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      contextWindow,
      maxTokens: declared ?? estimated,
      maxTokensEstimated: declared === undefined && estimated !== undefined,
      inputModalities: info?.inputModalities,
      reasoning: info?.reasoning,
    }
  }))
  return detailed
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

export { withStatus }
