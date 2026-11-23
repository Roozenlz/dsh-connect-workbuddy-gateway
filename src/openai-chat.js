/**
 * OpenAI Chat Completions 协议。
 *
 * 入站：`POST /v1/chat/completions`（也接受 `/chat/completions`）。
 * 出站：流式（默认）与非流式两种响应形状都实现了，客户端不需要改任何 SDK。
 */

import { readJson, sendJson, openSse, nowSec, randomId, failureOf } from './util.js'
import { internalRequest, normalizeStop } from './internal.js'
import { fromOpenAiTool } from './tools.js'
import { collect, openAiFinishReason } from './stream.js'
import { resolve } from './targets.js'
import { callModel } from './call.js'
import { withStatus } from './backend.js'

/** 解析 OpenAI Chat 请求体。 */
export function parseChatRequest(body) {
  if (body === null || typeof body !== 'object') {
    throw withStatus(new Error('request body must be a JSON object'), 400, 'invalid_request_error')
  }
  const messages = []
  let system
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message?.role
    if (role === 'system' || role === 'developer') {
      const text = flattenOpenAiContent(message.content)
      if (text !== '') system = system === undefined ? text : `${system}\n\n${text}`
      continue
    }
    if (role === 'assistant') {
      const text = flattenOpenAiContent(message.content)
      const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
      }))
      messages.push({ role: 'assistant', text, toolCalls })
      continue
    }
    if (role === 'tool' || role === 'function') {
      messages.push({
        role: 'tool',
        toolCallId: message.tool_call_id ?? message.name ?? 'unknown',
        text: flattenOpenAiContent(message.content),
        isError: false,
      })
      continue
    }
    messages.push({ role: 'user', content: openAiContentParts(message.content) })
  }
  if (messages.length === 0) {
    throw withStatus(new Error('messages must contain at least one entry'), 400, 'invalid_request_error')
  }
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => fromOpenAiTool(tool))
    .filter((tool) => tool !== undefined)
  return internalRequest({
    model: typeof body.model === 'string' ? body.model : '',
    system,
    messages,
    tools: tools.length === 0 ? undefined : tools,
    temperature: numberOrUndefined(body.temperature),
    topP: numberOrUndefined(body.top_p),
    maxTokens: numberOrUndefined(body.max_completion_tokens) ?? numberOrUndefined(body.max_tokens),
    stop: normalizeStop(body.stop),
    reasoningEffort: effortFromOpenAi(body.reasoning_effort),
    stream: body.stream === true,
  })
}

function effortFromOpenAi(value) {
  if (typeof value !== 'string') return undefined
  const known = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  return known.has(value) ? value : value === 'none' ? 'off' : undefined
}

/** OpenAI 的 content 可能是字符串，也可能是分块数组。 */
export function flattenOpenAiContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text' || part?.type === 'input_text') return part.text ?? ''
      if (part?.type === 'output_text') return part.text ?? ''
      return ''
    })
    .join('')
}

/** OpenAI 的 content → 内部内容块。 */
export function openAiContentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part })
      continue
    }
    if (part?.type === 'text' || part?.type === 'input_text') {
      if (typeof part.text === 'string' && part.text !== '') parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      const parsed = splitImageUrl(url)
      if (parsed !== undefined) parts.push(parsed)
      continue
    }
    if (part?.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url ?? part.data
      const parsed = splitImageUrl(url)
      if (parsed !== undefined) parts.push(parsed)
    }
  }
  return parts.length === 0 ? [{ type: 'text', text: '' }] : parts
}

/** data URL → 内部图片块；非 data URL 直接拒绝（网关不代客户抓远端图）。 */
export function splitImageUrl(url) {
  if (typeof url !== 'string' || url === '') return undefined
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url)
  if (match !== null) return { type: 'image', mediaType: match[1], data: match[2] }
  return undefined
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 处理一次 chat completion。 */
export async function handleChat(req, res, env) {
  const body = await readJson(req)
  const request = parseChatRequest(body)
  const target = resolve(env.providers(), env.key, request.model, env.config)
  const modelName = request.model === '' ? target.model : request.model
  const signal = abortSignalOf(res, req)

  if (!request.stream) {
    const result = await collect(callModel(env.ctx, env, target, request, signal))
    sendJson(res, 200, {
      id: `chatcmpl-${randomId()}`,
      object: 'chat.completion',
      created: nowSec(),
      model: modelName,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: result.text === '' ? null : result.text,
          ...(result.reasoning === '' ? {} : { reasoning_content: result.reasoning }),
          ...(result.toolCalls.length === 0 ? {} : {
            tool_calls: result.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }),
        },
        finish_reason: openAiFinishReason(result.finish, result.toolCalls.length > 0),
      }],
      usage: openAiUsage(result.usage),
      ...(target.region === undefined ? {} : { system_fingerprint: `workbuddy-${target.region}` }),
    })
    return
  }

  const sse = openSse(res)
  const id = `chatcmpl-${randomId()}`
  const created = nowSec()
  const envelope = (delta, finishReason, extra) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelName,
    ...(target.region === undefined ? {} : { system_fingerprint: `workbuddy-${target.region}` }),
    choices: [{ index: 0, delta, finish_reason: finishReason, ...(extra ?? {}) }],
  })
  try {
    sse.data(envelope({ role: 'assistant', content: '' }, null))
    let sawToolCalls = false
    for await (const event of callModel(env.ctx, env, target, request, signal)) {
      if (event.type === 'text') {
        sse.data(envelope({ content: event.text }, null))
        continue
      }
      if (event.type === 'reasoning') {
        sse.data(envelope({ reasoning_content: event.text }, null))
        continue
      }
      if (event.type === 'tool-call') {
        sawToolCalls = true
        /*
         * `index` 必须是**上游的**那个。硬编码 0 会让并行的多个工具调用挤进同一
         * 个槽位，客户端把它们拼成一个参数串，JSON 必然坏掉。
         */
        sse.data(envelope({
          tool_calls: [{
            index: Number.isInteger(event.index) ? event.index : 0,
            ...(event.id === undefined ? {} : { id: event.id }),
            type: 'function',
            ...(event.name === undefined || event.name === '' ? {} : { function: { name: event.name, arguments: event.argumentsDelta } }),
            ...(event.name === undefined || event.name === '' ? { function: { arguments: event.argumentsDelta } } : {}),
          }],
        }, null))
        continue
      }
      if (event.type === 'usage') {
        sse.data({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [], usage: openAiUsage(event.usage) })
        continue
      }
      if (event.type === 'failure') {
        /* 上游失败：发一个 error 帧并结束，不发 [DONE] —— 那会被当成正常完成。 */
        const failure = failureOf(event.error)
        sse.data({ error: { message: failure.message, type: failure.code, code: failure.code } })
        sse.end()
        return
      }
      if (event.type === 'finish') {
        sse.data(envelope({}, openAiFinishReason(event.reason, sawToolCalls)))
      }
    }
    sse.data('[DONE]')
  } catch (error) {
    const failure = failureOf(error)
    sse.data({ error: { message: failure.message, type: failure.code, code: failure.code } })
  } finally {
    sse.end()
  }
}

/** 内部 usage → OpenAI usage。 */
export function openAiUsage(usage) {
  if (usage === undefined) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  const input = usage.inputTokens ?? 0
  const output = usage.outputTokens ?? 0
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: usage.totalTokens ?? input + output,
    ...(usage.cacheReadTokens === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cacheReadTokens } }),
    ...(usage.reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: usage.reasoningTokens } }),
  }
}

/** 把响应关闭 / 请求取消都转成一个 AbortSignal。 */
export function abortSignalOf(res, req) {
  const controller = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new Error('client disconnected'))
  })
  req.on('aborted', () => controller.abort(new Error('client aborted')))
  return controller.signal
}
