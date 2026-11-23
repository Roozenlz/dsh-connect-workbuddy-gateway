/**
 * Anthropic Messages 协议。
 *
 * `POST /v1/messages`，可选 SSE（`stream:true` → `message_start` / `content_block_*`
 * / `message_delta` / `message_stop`）。工具调用走 `tool_use` / `tool_result` 块。
 */

import { readJson, sendJson, openSse, randomId, failureOf } from './util.js'
import { internalRequest, normalizeStop } from './internal.js'
import { fromAnthropicTool } from './tools.js'
import { collect, anthropicStopReason } from './stream.js'
import { resolve } from './targets.js'
import { callModel } from './call.js'
import { withStatus } from './backend.js'
import { abortSignalOf, splitImageUrl } from './openai-chat.js'

/** 解析 Messages 请求体。 */
export function parseMessagesRequest(body) {
  if (body === null || typeof body !== 'object') {
    throw withStatus(new Error('request body must be a JSON object'), 400, 'invalid_request_error')
  }
  let system
  if (typeof body.system === 'string') system = body.system
  else if (Array.isArray(body.system)) {
    system = body.system
      .map((part) => (part?.type === 'text' ? part.text : ''))
      .filter((text) => text !== '')
      .join('\n\n')
  }
  const messages = []
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message?.role
    if (role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]
      let text = ''
      const toolCalls = []
      for (const block of blocks) {
        if (block?.type === 'text') text += block.text ?? ''
        else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? `call_${toolCalls.length}`,
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
      messages.push({ role: 'assistant', text, toolCalls })
      continue
    }
    /* user 角色里可能同时带 tool_result 与正文。 */
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }]
    const content = []
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        messages.push({
          role: 'tool',
          toolCallId: block.tool_use_id ?? 'unknown',
          text: flattenToolResult(block.content),
          isError: block.is_error === true,
        })
        continue
      }
      if (block?.type === 'text') {
        if (typeof block.text === 'string' && block.text !== '') content.push({ type: 'text', text: block.text })
        continue
      }
      if (block?.type === 'image') {
        const source = block.source
        if (source?.type === 'base64' && typeof source.data === 'string') {
          content.push({ type: 'image', mediaType: source.media_type ?? 'image/png', data: source.data })
        } else if (source?.type === 'url') {
          const parsed = splitImageUrl(source.url)
          if (parsed !== undefined) content.push(parsed)
        }
      }
    }
    if (content.length > 0) messages.push({ role: 'user', content })
  }
  if (messages.length === 0) {
    throw withStatus(new Error('messages must contain at least one entry'), 400, 'invalid_request_error')
  }
  const tools = (Array.isArray(body.tools) ? body.tools : [])
    .map((tool) => fromAnthropicTool(tool))
    .filter((tool) => tool !== undefined)
  const thinking = body.thinking
  return internalRequest({
    model: typeof body.model === 'string' ? body.model : '',
    system,
    messages,
    tools: tools.length === 0 ? undefined : tools,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    topP: typeof body.top_p === 'number' ? body.top_p : undefined,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    stop: normalizeStop(body.stop_sequences),
    reasoningEffort: effortFromAnthropic(thinking),
    stream: body.stream === true,
  })
}

function effortFromAnthropic(thinking) {
  if (thinking === null || typeof thinking !== 'object') return undefined
  if (thinking.type === 'disabled') return 'off'
  const budget = thinking.budget_tokens
  if (typeof budget !== 'number') return undefined
  if (budget <= 2048) return 'low'
  if (budget <= 8192) return 'medium'
  if (budget <= 24576) return 'high'
  return 'max'
}

function flattenToolResult(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part?.type === 'text') return part.text ?? ''
      return ''
    })
    .join('')
}

/** 处理一次 messages 请求。 */
export async function handleMessages(req, res, env) {
  const body = await readJson(req)
  const request = parseMessagesRequest(body)
  const target = resolve(env.providers(), env.key, request.model, env.config)
  const modelName = request.model === '' ? target.model : request.model
  const signal = abortSignalOf(res, req)
  const id = `msg_${randomId()}`

  if (!request.stream) {
    const result = await collect(callModel(env.ctx, env, target, request, signal))
    const content = []
    if (result.reasoning !== '') content.push({ type: 'thinking', thinking: result.reasoning, signature: '' })
    if (result.text !== '') content.push({ type: 'text', text: result.text })
    for (const call of result.toolCalls) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments) })
    }
    if (content.length === 0) content.push({ type: 'text', text: '' })
    sendJson(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: modelName,
      content,
      stop_reason: anthropicStopReason(result.finish, result.toolCalls.length > 0),
      stop_sequence: null,
      usage: anthropicUsage(result.usage),
    })
    return
  }

  const sse = openSse(res)
  const usage = { input_tokens: 0, output_tokens: 0 }
  try {
    sse.event('message_start', {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model: modelName, content: [], stop_reason: null, stop_sequence: null, usage },
    })
    sse.event('ping', { type: 'ping' })

    /*
     * Anthropic 的流要严格按「每个 block 先 start、再 delta、再 stop」走，且块
     * 索引单调递增、不能回退。
     *
     * **工具参数必须按上游的 index 分组。** 一个响应里可以有多个并行的工具调用，
     * 上游用 `index` 区分它们；把它们拼进同一个 block，客户端拼出的就是
     * `{"a":1}y:2}` 这种坏 JSON（实测报错：
     * `ToolSearch was called with input that could not be parsed as JSON`,
     * `You sent (first 1 of 1 bytes): }`）。
     *
     * OpenAI 允许各 index 的 delta 交错到达，而 Anthropic 的 block 不能交错，所以
     * 这里**把工具参数缓冲起来，在 finish 时按 index 顺序整块输出**。这牺牲了
     * 工具参数的逐字流式（几乎没人依赖），换来 100% 的正确性。
     */
    let index = -1
    let openKind
    const closeBlock = () => {
      if (openKind === undefined) return
      sse.event('content_block_stop', { type: 'content_block_stop', index })
      openKind = undefined
    }
    const openBlock = (block) => {
      index += 1
      openKind = block.type
      sse.event('content_block_start', { type: 'content_block_start', index, content_block: block })
      return index
    }

    /** 上游 tool index → `{ id, name, arguments }`，按首次出现顺序。 */
    const toolCalls = new Map()

    let sawToolCalls = false
    for await (const event of callModel(env.ctx, env, target, request, signal)) {
      if (event.type === 'text') {
        if (openKind !== 'text') {
          closeBlock()
          openBlock({ type: 'text', text: '' })
        }
        sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.text } })
        continue
      }
      if (event.type === 'reasoning') {
        if (openKind !== 'thinking') {
          closeBlock()
          openBlock({ type: 'thinking', thinking: '', signature: '' })
        }
        sse.event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: event.text } })
        continue
      }
      if (event.type === 'tool-call') {
        sawToolCalls = true
        /* 按上游 index 分组；没有 index 时按 id 归档，再不行退到 0。 */
        const key = Number.isInteger(event.index) ? event.index : (event.id ?? 0)
        const existing = toolCalls.get(key)
        if (existing === undefined) {
          toolCalls.set(key, {
            id: event.id ?? `call_${key}`,
            name: event.name ?? '',
            arguments: event.argumentsDelta ?? '',
          })
        } else {
          if (typeof event.name === 'string' && event.name !== '' && existing.name === '') existing.name = event.name
          existing.arguments += event.argumentsDelta ?? ''
        }
        continue
      }
      if (event.type === 'usage') {
        usage.input_tokens = event.usage.inputTokens ?? usage.input_tokens
        usage.output_tokens = event.usage.outputTokens ?? usage.output_tokens
        continue
      }
      if (event.type === 'failure') {
        /* 上游失败：按 Anthropic 的 error 事件报，然后结束。 */
        const failure = failureOf(event.error)
        closeBlock()
        sse.event('error', { type: 'error', error: { type: anthropicErrorType(failure.status), message: failure.message } })
        sse.end()
        return
      }
      if (event.type === 'finish') {
        closeBlock()
        /* 收尾时把缓冲的工具调用整块发出去，顺序与上游一致。 */
        for (const [key, call] of [...toolCalls.entries()].sort((a, b) => (a[0] > b[0] ? 1 : a[0] < b[0] ? -1 : 0))) {
          openBlock({ type: 'tool_use', id: call.id, name: call.name || `tool_${key}`, input: {} })
          if (call.arguments !== '') {
            sse.event('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: call.arguments },
            })
          }
          closeBlock()
        }
        sse.event('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: anthropicStopReason(event.reason, sawToolCalls), stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        })
      }
    }
    closeBlock()
    sse.event('message_stop', { type: 'message_stop' })
  } catch (error) {
    const failure = failureOf(error)
    sse.event('error', { type: 'error', error: { type: anthropicErrorType(failure.status), message: failure.message } })
  } finally {
    sse.end()
  }
}

function anthropicErrorType(status) {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status >= 400 && status < 500) return 'invalid_request_error'
  return 'api_error'
}

function anthropicUsage(usage) {
  if (usage === undefined) return { input_tokens: 0, output_tokens: 0 }
  return {
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    ...(usage.cacheReadTokens === undefined ? {} : { cache_read_input_tokens: usage.cacheReadTokens }),
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text === '' ? '{}' : text)
  } catch {
    return {}
  }
}
