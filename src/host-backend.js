/**
 * Host 后端：走宿主 `llm` 服务（＝ dsh-connect-workbuddy 注册的 adapter）。
 *
 * 这条通道的账号由插件自己的选择或账号池决定，网关不干预；好处是换号、渠道
 * 指纹救助、context rescue 全都免费继承。
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
 * 发一次请求，返回规范化事件流。
 *
 * @param ctx 宿主上下文
 * @param target `{provider, model}`，由 resolve.js 解析而来
 * @param request 统一内部请求
 * @param signal 取消信号
 */
export async function* hostStream(ctx, target, request, signal) {
  const { options } = await buildGenerateOptions(ctx, {}, request, target)
  const chunks = streamHost(ctx, options, signal)
  let sawFinish = false
  for await (const event of fromHostChunks(chunks)) {
    if (event.type === 'finish') {
      sawFinish = true
      if (event.reason.kind === 'error' || event.reason.kind === 'aborted') {
        const failure = event.reason.failure ?? {}
        const error = new Error(failure.message ?? 'the upstream call failed')
        error.code = failure.code ?? 'upstream_error'
        error.status = statusOfFailure(failure)
        throw error
      }
    }
    yield event
  }
  if (!sawFinish) yield { type: 'finish', reason: { kind: 'stop' } }
}

/** 把上游失败码翻成 HTTP 状态。 */
export function statusOfFailure(failure) {
  if (typeof failure.status === 'number' && failure.status >= 400) return failure.status
  switch (failure.code) {
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

/** 模型目录（带上下文窗口）。 */
export async function hostCatalog(ctx, provider) {
  const models = await listModels(ctx, provider)
  const detailed = await Promise.all(models.map(async (entry) => {
    const info = await resolveModelInfo(ctx, provider, entry.id)
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      contextWindow: info?.contextWindow,
      maxTokens: info?.defaultMaxTokens,
      inputModalities: info?.inputModalities,
      reasoning: info?.reasoning,
    }
  }))
  return detailed
}

export { withStatus }
