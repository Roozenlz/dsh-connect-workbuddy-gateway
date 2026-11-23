/**
 * OpenAI Responses 协议。
 *
 * `POST /v1/responses`。这是 OpenAI 新一代 API：输入是 `input`（字符串或 item
 * 数组），输出是 `output`（message / function_call 混排的 item 列表），流式时
 * 走命名事件（`response.created` / `response.output_text.delta` /
 * `response.completed` …）。
 *
 * ## 流式必须守的几条 OpenAI 规范
 *
 * 这些不是某个客户端的私有要求，而是 Responses 流的标准形状。少任何一条，
 * 强类型客户端（Codex、Cortico / Coopanion、vLLM 系网关）都会判「格式不兼容」：
 *
 * 1. **每个事件都带 `sequence_number`**，从 0 开始严格递增。缺了它，第一个事件
 *    就被拒（这是最常见的「服务已应答但格式不兼容」）。
 * 2. **`content_part.added` 里的 `part` 必须与后来 `content_part.done` 的完全一致**
 *    —— 所以 added 时就要给出最终会被 accumulating 客户端采用的初始值，而不是等
 *    done 时才填文本。
 * 3. **`output_item.done` 的 item 必须与之前 delta 累积出的结果逐字节一致**
 *    （`content` / `summary` / `arguments` 都比对）。
 * 4. **terminal 事件的 `response.output` 必须包含全部已宣告的 item，且顺序与
 *    `output_index` 一致**。
 * 5. `response.created` 与 `response.in_progress` 各只发一次，terminal 之后不能再
 *    有事件。
 */

import { readJson, sendJson, openSse, nowSec, randomId, failureOf } from './util.js'
import { internalRequest, normalizeStop } from './internal.js'
import { fromOpenAiTool } from './tools.js'
import { collect } from './stream.js'
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
      const type = item?.type ?? 'message'
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
        const call = {
          id: item.call_id ?? item.id ?? `call_${messages.length}`,
          name: item.name ?? '',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        }
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
    sendJson(res, 200, responsesObject({ id, created, modelName, result }))
    return
  }

  const sse = openSse(res)

  /* 每个事件都要带 `sequence_number`，从 0 起严格递增。 */
  let sequence = 0
  const emit = (payload) => {
    sse.event(payload.type, { ...payload, sequence_number: sequence })
    sequence += 1
  }

  const shell = (status) => ({
    id,
    object: 'response',
    created_at: created,
    model: modelName,
    status,
    output: [],
  })

  /*
   * item 的登记表：`output_index` → item。terminal 事件的 `response.output` 必须
   * 与它逐项、同序一致，所以这里就是唯一事实来源。
   */
  const items = new Map()

  /**
   * 把已宣告的 item 折成 terminal 事件要的 `output` 数组。
   *
   * 顺序按 `output_index` 升序 —— 规范要求 terminal 的 output 与宣告顺序一致，
   * 而 `Map` 的插入顺序在「中间穿插新增」时不一定等于 index 顺序。
   */
  const snapshotOutput = () => [...items.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => {
      if (item.type === 'reasoning') {
        return { id: item.id, type: 'reasoning', summary: [], content: item.content.map((part) => ({ ...part })) }
      }
      if (item.type === 'function_call') {
        return {
          id: item.id,
          type: 'function_call',
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
          status: item.status,
        }
      }
      return {
        id: item.id,
        type: 'message',
        role: 'assistant',
        status: item.status,
        content: item.content.map((part) => ({ ...part })),
      }
    })

  /**
   * 收尾：按 index 升序给每个 item 发 done 事件。
   *
   * `completed` 与 `failed` 都要走这一步 —— 规范要求 terminal 的 output 与已宣告
   * 的 item 一致，所以失败时也必须把已经开出来的 item 补齐 done，否则客户端拿到
   * 的是一个「有半截 item 但 terminal 说 0 个」的矛盾响应。
   */
  const closeItems = () => {
    for (const [index, item] of [...items.entries()].sort((a, b) => a[0] - b[0])) {
      if (item.type === 'function_call') {
        emit({
          type: 'response.function_call_arguments.done',
          output_index: index,
          item_id: item.id,
          arguments: item.arguments,
        })
        if (item.status === 'in_progress') item.status = 'incomplete'
      } else {
        emit({
          type: 'response.content_part.done',
          output_index: index,
          item_id: item.id,
          content_index: 0,
          part: { ...item.content[0] },
        })
        if (item.type !== 'reasoning' && item.status === 'in_progress') item.status = 'incomplete'
      }
      emit({ type: 'response.output_item.done', output_index: index, item: withoutInternals(item) })
    }
  }

  try {
    emit({ type: 'response.created', response: shell('in_progress') })
    emit({ type: 'response.in_progress', response: shell('in_progress') })

    const openItem = (kind) => {
      const index = items.size
      const item = kind === 'reasoning'
        ? { id: `rs_${randomId()}`, type: 'reasoning', summary: [], content: [] }
        : { id: `msg_${randomId()}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] }
      /* 先登记再宣告：宣告之后就能接收 delta。 */
      items.set(index, item)
      emit({ type: 'response.output_item.added', output_index: index, item: withoutInternals(item) })
      return { index, item }
    }

    let reasoningSlot
    let messageSlot
    let usage
    let sawToolCalls = false
    let closed = false
    for await (const event of callModel(env.ctx, env, target, request, signal)) {
      if (closed) break

      /*
       * 上游失败：走 unified 的 `failure` 事件，在这里转成 `response.failed`。
       * 不用 try/catch —— 生成器内部的 throw 会被调用方的 `return()` 竞争掉，
       * 实测会变成「静默断流」。
       */
      if (event.type === 'failure') {
        closed = true
        closeItems()
        const failure = failureOf(event.error)
        emit({
          type: 'response.failed',
          response: {
            ...shell('failed'),
            output: snapshotOutput(),
            usage: responsesUsage(usage),
            error: { code: failure.code, message: failure.message },
          },
        })
        break
      }

      if (event.type === 'reasoning') {
        if (reasoningSlot === undefined) {
          reasoningSlot = openItem('reasoning')
        }
        const { index, item } = reasoningSlot
        /*
         * reasoning 的正文走 `response.reasoning.delta`，写进 content[0]。added 时
         * 就把 part 放好（`summary` 与 `content` 两条通道都要有一致的初始形状），
         * 否则 done 时与 delta 累积结果不符。
         */
        if (item.content.length === 0) {
          const part = { type: 'reasoning_text', text: '' }
          item.content.push(part)
          emit({
            type: 'response.content_part.added',
            output_index: index,
            item_id: item.id,
            content_index: 0,
            part: { ...part },
          })
        }
        item.content[0].text += event.text
        emit({
          type: 'response.reasoning.delta',
          output_index: index,
          item_id: item.id,
          content_index: 0,
          delta: event.text,
        })
        continue
      }

      if (event.type === 'text') {
        if (messageSlot === undefined) {
          messageSlot = openItem('message')
        }
        const { index, item } = messageSlot
        /* added 时 part 的初始值与 delta 累积后必须能对上：这里从空串开始。 */
        if (item.content.length === 0) {
          const part = { type: 'output_text', text: '', annotations: [] }
          item.content.push(part)
          emit({
            type: 'response.content_part.added',
            output_index: index,
            item_id: item.id,
            content_index: 0,
            part: { ...part },
          })
        }
        item.content[0].text += event.text
        emit({
          type: 'response.output_text.delta',
          output_index: index,
          item_id: item.id,
          content_index: 0,
          delta: event.text,
          logprobs: [],
        })
        continue
      }

      if (event.type === 'tool-call') {
        sawToolCalls = true
        /*
         * 工具调用：按**上游 index** 归组。
         *
         * 只按 call_id 找是不可靠的：OpenAI 的 delta 只在首片带 id，之后的分片
         * id 缺席；多个并行调用在首片之后都表现为「无 id 的分片」，按 id 找不到
         * 就会新建 item 或拼错位置。index 是上游给出的稳定分组键。
         */
        let slot
        if (Number.isInteger(event.index)) {
          slot = [...items.entries()].find(([, item]) => item.type === 'function_call' && item.__upstreamIndex === event.index)
        } else if (event.id !== undefined) {
          slot = [...items.entries()].find(([, item]) => item.type === 'function_call' && item.call_id === event.id)
        }
        if (slot === undefined) {
          const index = items.size
          const item = {
            id: `fc_${randomId()}`,
            type: 'function_call',
            call_id: event.id ?? `call_${index}`,
            name: event.name ?? '',
            arguments: '',
            status: 'in_progress',
            ...(Number.isInteger(event.index) ? { __upstreamIndex: event.index } : {}),
          }
          items.set(index, item)
          emit({ type: 'response.output_item.added', output_index: index, item: withoutInternals(item) })
          slot = [index, item]
        }
        const [index, item] = slot
        if (typeof event.name === 'string' && event.name !== '' && item.name === '') item.name = event.name
        if (event.argumentsDelta !== '') {
          item.arguments += event.argumentsDelta
          emit({
            type: 'response.function_call_arguments.delta',
            output_index: index,
            item_id: item.id,
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
        closed = true
        /* 正常收尾：item 标 completed，再发 terminal。 */
        for (const item of items.values()) {
          if (item.status === 'in_progress') item.status = 'completed'
        }
        closeItems()
        emit({
          type: 'response.completed',
          response: {
            ...shell('completed'),
            output: snapshotOutput(),
            usage: responsesUsage(usage),
            ...(sawToolCalls ? {} : {}),
          },
        })
      }
    }
    /*
     * 流自己结束了（没有 finish 事件）：上游断流或被拒。不能当成功 —— 否则客户端
     * 拿到的是一个「response.created 之后什么都没有」的残流。
     */
    /*
     * 流自己结束了但没有 terminal：上游被切断。补一个 `response.failed`，
     * 因为「response.created 之后什么都没有」不是合法响应。
     */
    if (!closed) {
      closed = true
      closeItems()
      emit({
        type: 'response.failed',
        response: {
          ...shell('failed'),
          output: snapshotOutput(),
          usage: responsesUsage(usage),
          error: { code: 'upstream_incomplete', message: 'the upstream ended the stream without completing the response' },
        },
      })
    }
  } catch (error) {
    const failure = failureOf(error)
    /* terminal 之后不能再发事件，所以只在还没收尾时发 failed。 */
    if (!closed) {
      closed = true
      /*
       * 失败也要把已宣告的 item 补 done，并在 output 里如实列出 —— 规范要求
       * terminal 的 output 与宣告的 item 一致。
       */
      try {
        closeItems()
      } catch {
        /* 关闭事件本身失败时不再级联 */
      }
      emit({
        type: 'response.failed',
        response: {
          ...shell('failed'),
          output: snapshotOutput(),
          usage: responsesUsage(usage),
          error: { code: failure.code, message: failure.message },
        },
      })
    }
  } finally {
    sse.end()
  }
}

/**
 * 去掉只给插件内部用的字段（`__` 前缀）。
 *
 * item 在插件里要记 `__upstreamIndex` 才能把交错的 delta 归到正确的调用上，但
 * 那个字段**不能出现在任何事件里** —— 客户端按 schema 严格校验，多一个未知字段
 * 同样会被判为格式不兼容。
 */
function withoutInternals(item) {
  const out = {}
  for (const [key, value] of Object.entries(item)) {
    if (key.startsWith('__')) continue
    out[key] = value
  }
  return out
}

/**
 * 内部 usage → Responses API 的 usage。
 *
 * **这个形状与 Chat Completions 不同，不能复用 `openAiUsage`。** Responses 用
 * `input_tokens` / `output_tokens`，Chat 用 `prompt_tokens` / `completion_tokens`。
 * 强类型客户端把 `input_tokens` 当必填字段；给出 `prompt_tokens` 或干脆不写
 * usage，都会被判为缺字段。
 *
 * 上游没报 usage 时**也要给零值**，不能省略整个字段。
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

function responsesObject({ id, created, modelName, result }) {
  const output = []
  if (result.reasoning !== '') {
    output.push({
      id: `rs_${randomId()}`,
      type: 'reasoning',
      summary: [],
      content: [{ type: 'reasoning_text', text: result.reasoning }],
    })
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
    status: 'completed',
    output,
    usage: responsesUsage(result.usage),
  }
}
