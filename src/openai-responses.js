/**
 * OpenAI Responses 协议。
 *
 * `POST /v1/responses`。这是 OpenAI 新一代 API：输入是 `input`（字符串或 item
 * 数组），输出是 `output`（message / function_call 混排的 item 列表），流式时
 * 走命名事件（`response.created` / `response.output_text.delta` /
 * `response.function_call_arguments.delta` / `response.completed`）。
 */

import { readJson, sendJson, openSse, nowSec, randomId, failureOf } from './util.js'
import { internalRequest, normalizeStop } from './internal.js'
import { fromOpenAiTool } from './tools.js'
import { collect, openAiFinishReason } from './stream.js'
import { resolve } from './targets.js'
import { callModel } from './call.js'
import { withStatus } from './backend.js'
import { abortSignalOf, flattenOpenAiContent, splitImageUrl } from './openai-chat.js'

/** 解析 Responses 请求体。 */
export function parseResponsesRequest(body) {
  if (body === null || typeof body !== 'object') {
    throw withStatus(new Error('request body must be a JSON object'), 400, 'invalid_request_error')
  }
  let system = typeof body.instructions === 'string' && body.instructions !== '' ? body.instructions : undefined
  const messages = []

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: [{ type: 'text', text: body.input }] })
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: [{ type: 'text', text: item }] })
        continue
      }
      const type = item?.type ?? (item?.role === 'assistant' ? 'message' : 'message')
      if (type === 'message' || item?.role !== undefined) {
        const role = item?.role === 'assistant' ? 'assistant' : item?.role === 'system' || item?.role === 'developer' ? 'system' : 'user'
        const text = flattenOpenAiContent(item?.content)
        if (role === 'system') {
          system = system === undefined ? text : `${system}\n\n${text}`
        } else if (role === 'assistant') {
          messages.push({ role: 'assistant', text, toolCalls: [] })
        } else {
          messages.push({ role: 'user', content: responsesContentParts(item?.content) })
        }
        continue
      }
      if (type === 'function_call') {
        const last = messages.length > 0 ? messages[messages.length - 1] : undefined
        const call = { id: item.call_id ?? item.id ?? `call_${messages.length}`, name: item.name ?? '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) }
        if (last !== undefined && last.role === 'assistant') last.toolCalls.push(call)
        else messages.push({ role: 'assistant', text: '', toolCalls: [call] })
        continue
      }
      if (type === 'function_call_output') {
        messages.push({
          role: 'tool',
          toolCallId: item.call_id ?? 'unknown',
          text: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          isError: false,
        })
      }
    }
  }
  if (messages.length === 0) {
    throw withStatus(new Error('input must contain at least one message'), 400, 'invalid_request_error')
  }
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .filter((tool) => tool?.type === 'function' || tool?.name !== undefined)
    .map((tool) => fromOpenAiTool(tool))
    .filter((tool) => tool !== undefined)
  return internalRequest({
    model: typeof body.model === 'string' ? body.model : '',
    system,
    messages,
    tools: tools.length === 0 ? undefined : tools,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : undefined,
    stop: undefined,
    reasoningEffort: typeof body.reasoning?.effort === 'string' ? body.reasoning.effort : undefined,
    stream: body.stream === true,
  })
}

function responsesContentParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }]
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part })
      continue
    }
    if (part?.type === 'input_text' || part?.type === 'text' || part?.type === 'output_text') {
      if (typeof part.text === 'string' && part.text !== '') parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'input_image') {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url
      const parsed = splitImageUrl(url)
      if (parsed !== undefined) parts.push(parsed)
    }
  }
  return parts.length === 0 ? [{ type: 'text', text: '' }] : parts
}

/** 处理一次 responses 请求。 */
export async function handleResponses(req, res, env) {
  const body = await readJson(req)
  const request = parseResponsesRequest(body)
  const target = resolve(env.providers(), env.key, request.model, env.config)
  const modelName = request.model === '' ? target.model : request.model
  const signal = abortSignalOf(res, req)
  const id = `resp_${randomId()}`
  const created = nowSec()

  if (!request.stream) {
    const result = await collect(callModel(env.ctx, env, target, request, signal))
    sendJson(res, 200, responsesObject({ id, created, modelName, result, status: 'completed' }))
    return
  }

  const sse = openSse(res)
  const base = { id, object: 'response', created_at: created, model: modelName, status: 'in_progress', output: [] }
  try {
    sse.event('response.created', { type: 'response.created', response: base })
    sse.event('response.in_progress', { type: 'response.in_progress', response: base })

    let text = ''
    let reasoning = ''
    const outputItems = []
    let messageItemId
    let messageOutputIndex = -1
    let reasoningItemId
    let reasoningOutputIndex = -1
    let sawToolCalls = false
    let usage
    let outputIndex = 0

    for await (const event of callModel(env.ctx, env, target, request, signal)) {
      if (event.type === 'reasoning') {
        if (reasoningOutputIndex === -1) {
          reasoningItemId = `rs_${randomId()}`
          reasoningOutputIndex = outputIndex
          outputIndex += 1
          sse.event('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: reasoningOutputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [] },
          })
        }
        reasoning += event.text
        continue
      }
      if (event.type === 'text') {
        if (messageOutputIndex === -1) {
          messageItemId = `msg_${randomId()}`
          messageOutputIndex = outputIndex
          outputIndex += 1
          sse.event('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: messageOutputIndex,
            item: { id: messageItemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
          })
          sse.event('response.content_part.added', {
            type: 'response.content_part.added',
            item_id: messageItemId,
            output_index: messageOutputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          })
        }
        text += event.text
        sse.event('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: messageItemId,
          output_index: messageOutputIndex,
          content_index: 0,
          delta: event.text,
        })
        continue
      }
      if (event.type === 'tool-call') {
        sawToolCalls = true
        if (event.id !== undefined && event.name !== undefined && event.name !== '') {
          outputItems.push({
            type: 'function_call',
            id: `fc_${randomId()}`,
            call_id: event.id,
            name: event.name,
            arguments: event.argumentsDelta,
            status: 'in_progress',
          })
          const itemIndex = outputIndex
          outputIndex += 1
          sse.event('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: itemIndex,
            item: outputItems[outputItems.length - 1],
          })
          outputItems[outputItems.length - 1].__index = itemIndex
        } else if (outputItems.length > 0 && event.argumentsDelta !== '') {
          const current = outputItems[outputItems.length - 1]
          current.arguments += event.argumentsDelta
          sse.event('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: current.id,
            output_index: current.__index,
            delta: event.argumentsDelta,
          })
        }
        continue
      }
      if (event.type === 'usage') {
        usage = event.usage
        continue
      }
      if (event.type === 'finish') {
        if (messageItemId !== undefined) {
          sse.event('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: messageItemId,
            output_index: messageOutputIndex,
            content_index: 0,
            text,
          })
          sse.event('response.content_part.done', {
            type: 'response.content_part.done',
            item_id: messageItemId,
            output_index: messageOutputIndex,
            content_index: 0,
            part: { type: 'output_text', text, annotations: [] },
          })
          sse.event('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: messageOutputIndex,
            item: { id: messageItemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
          })
        }
        if (reasoningItemId !== undefined) {
          sse.event('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: reasoningOutputIndex,
            item: { id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] },
          })
        }
        for (const item of outputItems) {
          sse.event('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            item_id: item.id,
            output_index: item.__index,
            arguments: item.arguments,
          })
          sse.event('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: item.__index,
            item: { type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments, status: 'completed' },
          })
        }
        const output = [
          ...(reasoningItemId === undefined ? [] : [{ id: reasoningItemId, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] }]),
          ...(messageItemId === undefined ? [] : [{ id: messageItemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }]),
          ...outputItems.map((item) => ({ type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments, status: 'completed' })),
        ]
        sse.event('response.completed', {
          type: 'response.completed',
          response: {
            id,
            object: 'response',
            created_at: created,
            model: modelName,
            status: 'completed',
            output,
            usage: responsesUsage(usage),
            ...(sawToolCalls ? {} : {}),
          },
        })
      }
    }
  } catch (error) {
    const failure = failureOf(error)
    sse.event('response.failed', {
      type: 'response.failed',
      response: {
        id,
        object: 'response',
        created_at: created,
        model: modelName,
        status: 'failed',
        output: [],
        error: { code: failure.code, message: failure.message },
      },
    })
  } finally {
    sse.end()
  }
}

/**
 * 内部 usage → Responses API 的 usage。
 *
 * **这个形状与 Chat Completions 不同，不能复用 `openAiUsage`。** Responses 用
 * `input_tokens` / `output_tokens`，Chat 用 `prompt_tokens` / `completion_tokens`。
 * Codex 的 `ResponseCompleted` 是强类型结构体，`input_tokens` 是必填字段；给出
 * `prompt_tokens` 会让它报 `missing field 'input_tokens'` 并触发无限重连。
 *
 * 上游没报 usage 时**也要给零值**，不能省略整个字段——省略同样等于缺字段。
 */
function responsesUsage(usage) {
  const input = usage?.inputTokens ?? 0
  const output = usage?.outputTokens ?? 0
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage?.cacheReadTokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage?.reasoningTokens ?? 0 },
    total_tokens: usage?.totalTokens ?? input + output,
  }
}

function responsesObject({ id, created, modelName, result, status }) {
  const output = []
  if (result.reasoning !== '') {
    output.push({ id: `rs_${randomId()}`, type: 'reasoning', summary: [{ type: 'summary_text', text: result.reasoning }] })
  }
  if (result.text !== '') {
    output.push({
      id: `msg_${randomId()}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: result.text, annotations: [] }],
    })
  }
  for (const call of result.toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${randomId()}`,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    })
  }
  return {
    id,
    object: 'response',
    created_at: created,
    model: modelName,
    status,
    output,
    usage: responsesUsage(result.usage),
    ...(result.toolCalls.length === 0 ? {} : { finish_reason: openAiFinishReason(result.finish, true) }),
  }
}
